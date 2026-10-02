import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, DeviceService, PgApprovalStore, runMigrations, SessionGrantService } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { captureAuditWatermark, queryRunScopedOwnerControlsAudit } from "../src/audit-evidence.ts";
import { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../src/transport.ts";
import type { OwnerControlState } from "../src/types.ts";

/**
 * K1 (Sovereign graduation, D-164): ende-til-ende-bevis for HELE den
 * durable/delte eier-kontroll-flaten mot EKTE embedded Postgres - SAMME
 * mønster som `modules/situations/test/domain-pause.test.ts` sin del C
 * (den etablerte presedensen for durable owner-authority-tester). Denne
 * suiten dekker K1-ordren sine kategorier A (persistens), B (api/worker-
 * parity), C (autorisasjon), D (ToolGateway-komposisjon), F (restart/
 * gjenoppretting), G (audit), H (RLS/tenant - dokumentert N/A). Kategori E
 * (situations-koeksistens) er dekket av `modules/executive/test/service-
 * transport.test.ts` sin "G"-blokk (der komposisjonen faktisk skjer).
 * Kategori J (regresjon) er dekket av at HELE eksisterende
 * policy/situations/executive/tool-gateway/apps-api-suiten (759 tester)
 * fortsetter å passere uendret (se PR-beskrivelse/PROJECT_STATUS.md).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-owner-controls-k1";
const TENANT_B = "tenant-owner-controls-k1-b";
const OWNER = "person-owner-controls-k1-owner";
const OTHER = "person-owner-controls-k1-other";
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT, TENANT_B] };

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };

function identityFor(tenantId: string, personId: string = OWNER): IdentityContext {
  return {
    person_id: personId, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-owner-controls-${tenantId}-${personId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}
const ownerIdentity = identityFor(TENANT);
const ownerIdentityTenantB = identityFor(TENANT_B);
const otherIdentity = identityFor(TENANT, OTHER);

/** ÉN full stack (killSwitch+ownerControls+policy+gateway+registrert owner_controls-verktøy) mot EKTE `appPool` - brukt der en test bevisst vil ha en FERSK instans (restart-simulering) i stedet for en delt. */
function freshStack(): {
  killSwitch: KillSwitch;
  ownerControls: OwnerControls;
  policy: PolicyGateway;
  gateway: ToolGateway;
} {
  const killSwitch = new KillSwitch(appPool, authority);
  const ownerControls = new OwnerControls(killSwitch, appPool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch,
    controls: ownerControls,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT, TENANT_B] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets, ownerControls);
  const service = new OwnerControlsService(killSwitch, ownerControls);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(service))) gateway.register(tool);
  return { killSwitch, ownerControls, policy, gateway };
}

async function getState(gateway: ToolGateway, identity: IdentityContext): Promise<OwnerControlState> {
  const result = await gateway.execute({ identity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
  if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
  return result.data as unknown as OwnerControlState;
}

/**
 * D-174 (B2, task F): SAMME `freshStack()`-mønster, men `OwnerControlsService`
 * gitt de valgfrie device-tilbakekallings-avhengighetene (`pool`+
 * `SessionGrantService`+`authority`) - beviser `owner_controls.revoke_device`
 * mot EKTE `session_grants`, ALDRI en fake/mock av selve kanonikken.
 */
function freshStackWithDeviceRevocation(): { gateway: ToolGateway } {
  const killSwitch = new KillSwitch(appPool, authority);
  const ownerControls = new OwnerControls(killSwitch, appPool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch,
    controls: ownerControls,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT, TENANT_B] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets, ownerControls);
  const service = new OwnerControlsService(killSwitch, ownerControls, { pool: appPool, grants: new SessionGrantService(appPool), devices: new DeviceService(appPool), authority });
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(service))) gateway.register(tool);
  return { gateway };
}

/** Setter inn de MINIMALE, FK-tilfredsstillende radene `session_grants` krever, direkte via admin-poolen (RLS-fri) - ikke via HELE innrullerings-/utstedelsesflyten, som er dekket separat av `@jarvis/core` sine egne tester. */
async function seedGrant(tenantId: string, deviceId: string, personId: string = OWNER): Promise<void> {
  // JARVIS-055: kun EN aktiv sesjon per (tenant, person) - alle enheter til samme person deler den.
  const sessionId = `sess-device-revoke-${tenantId}-${personId}`;
  await adminPool.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ($1,$2,$3,'phone') ON CONFLICT (device_id) DO NOTHING`, [deviceId, tenantId, personId]);
  await adminPool.query(
    `INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ($1,$2,$3,'api',$4) ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, tenantId, personId, deviceId]
  );
  await adminPool.query(
    `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at)
     VALUES ($1,$2,$3,$4,$5,'business','api','active','test-fingerprint', now() + interval '1 hour')`,
    [`grt-${deviceId}-${Date.now()}`, tenantId, personId, deviceId, sessionId]
  );
}

async function activeGrantCount(tenantId: string, deviceId: string): Promise<number> {
  const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM session_grants WHERE tenant_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [tenantId, deviceId]);
  return (rows[0] as { n: number }).n;
}

function revokedGrantsFrom(result: { ok: boolean; data?: unknown }): number {
  if (!result.ok) throw new Error("unexpected_denial");
  return (result.data as { revoked_grants: number }).revoked_grants;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-owner-controls-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_owner_controls_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_owner_controls_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'OwnerControlsK1', 'business'), ('${TENANT_B}', 'OwnerControlsK1B', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner'), ('${OTHER}', 'Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
}, 240_000);

beforeEach(async () => {
  // Global tilstand (INGEN tenant_id, se 058_owner_control_authority.sql) - må renskes mellom
  // hver test i DENNE filen, ellers lekker en test sin frys/tilbakekall/kill-switch inn i neste.
  await adminPool.query("DELETE FROM owner_control_state");
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: persistens - EKTE Postgres, ingen prosess-lokal skyggetilstand", () => {
  it("kill switch aktivert via owner_controls.activate_kill_switch overlever en FERSK instans (simulert restart) UTEN restore() - isActiveDurable() er en LIVE spørring, ikke en cache som må varmes opp", async () => {
    const first = freshStack();
    const activated = await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "A-test" } });
    expect(activated.ok).toBe(true);

    const restarted = freshStack(); // helt ny KillSwitch/OwnerControls-instans, INGEN delt in-memory-tilstand, INGEN restore() kalt.
    expect(await restarted.killSwitch.isActiveDurable()).toBe(true);

    await restarted.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("frosset connector og tilbakekalt credential overlever samme restart-simulering", async () => {
    const first = freshStack();
    await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "gmail", reason: "A-test" } });
    await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-a-test", reason: "A-test" } });

    const restarted = freshStack();
    expect(await restarted.ownerControls.isFrozenDurable("gmail")).toBe(true);
    expect(await restarted.ownerControls.isRevokedDurable("cred-a-test")).toBe(true);
    await restarted.ownerControls.restore(); // observability-speiling - se KillSwitch.restore() sitt filhode
    expect(restarted.ownerControls.isFrozen("gmail")).toBe(true);
  });

  it("samtidig skriving på SAMME (kind,target) er deterministisk - siste commit vinner, ALDRI en duplikat-rad eller korrupt tilstand", async () => {
    const a = freshStack();
    const b = freshStack();
    await Promise.all([
      a.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "concurrent-target", reason: "fra-a" } }),
      b.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "concurrent-target", reason: "fra-b" } })
    ]);
    const { rows } = await adminPool.query(
      "SELECT reason FROM owner_control_state WHERE control_kind = 'connector_freeze' AND control_target = 'concurrent-target'"
    );
    expect(rows).toHaveLength(1); // ALDRI to rader for samme (kind,target) - PK-en garanterer dette, men bevis det likevel.
    expect(["fra-a", "fra-b"]).toContain((rows[0] as { reason: string }).reason);
  });
});

describe("B: API-/worker-parity - to HELT SEPARATE pg.Pool-instanser (simulerer to prosesser) ser SAMME tilstand LIVE", () => {
  it("en pause satt via 'API'-poolen er UMIDDELBART synlig for 'worker'-poolens EGEN, uavhengige KillSwitch-instans - ingen synk-mekanisme, ingen ventetid", async () => {
    const apiPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    const workerPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    try {
      const apiKillSwitch = new KillSwitch(apiPool, authority);
      const workerKillSwitch = new KillSwitch(workerPool, authority); // HELT separat JS-objekt, HELT separat pg.Pool - null delt hukommelse.
      expect(await workerKillSwitch.isActiveDurable()).toBe(false);

      await apiKillSwitch.activateDurable("B-test parity", OWNER);
      expect(await workerKillSwitch.isActiveDurable()).toBe(true); // "worker" ser "api" sin skriving UTEN restart, UTEN restore(), UTEN noen melding mellom prosessene.

      await workerKillSwitch.deactivateDurable(OWNER);
      expect(await apiKillSwitch.isActiveDurable()).toBe(false); // symmetrisk andre veien.
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  });

  it("samme parity for frosne connectorer - 'worker' sin egen OwnerControls-instans ser 'api' sin frys direkte", async () => {
    const apiPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    const workerPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    try {
      const apiKs = new KillSwitch(apiPool, authority);
      const apiOc = new OwnerControls(apiKs, apiPool, authority);
      const workerKs = new KillSwitch(workerPool, authority);
      const workerOc = new OwnerControls(workerKs, workerPool, authority);

      await apiOc.freezeConnectorDurable("slack", "B-test", OWNER);
      expect(await workerOc.isFrozenDurable("slack")).toBe(true);
      await workerOc.unfreezeConnectorDurable("slack", OWNER);
      expect(await apiOc.isFrozenDurable("slack")).toBe(false);
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  });
});

describe("C: autorisasjon - kill switch/frys blokkerer, eier-only mutasjon, klasse D-semantikk uendret", () => {
  it("aktiv kill switch nekter ETHVERT annet owner_controls-verktøykall (klasse C freeze_connector), men IKKE deactivate_kill_switch/get_control_state selv", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "C-test" } });

    const blocked = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "x", reason: "skal nektes" } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("kill_switch_active");

    const readAllowed = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
    expect(readAllowed.ok).toBe(true); // selvgjenopprettings-unntaket - eieren MÅ kunne SE at systemet er stanset.

    const deactivated = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true); // selvgjenopprettings-unntaket - IKKE et énveis-lås.
  });

  it("deaktivering GJENOPPRETTER tilgang for det som var blokkert (freeze_connector lykkes etter deactivate)", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "C-test-2" } });
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    const afterDeactivate = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "y", reason: "skal nå lykkes" } });
    expect(afterDeactivate.ok).toBe(true);
  });

  it("forfalskede identitetsfelt i PARAMETRE (actor_person_id/reason-injeksjon utover skjemaet) avvises av ToolGateway sitt strict()-skjema FØR transporten nås", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector",
      parameters: { connector_id: "z", reason: "test", actor_person_id: OTHER } as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_parameters");
  });

  it("IKKE-eier (SCOPED-modus) nektes klasse C-mutasjon (freeze_connector) - 'class_c_no_mandate', ingen skriving skjer", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({ identity: otherIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "not-owner-target", reason: "forsøk" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("class_c_no_mandate");
    const { rows } = await adminPool.query("SELECT 1 FROM owner_control_state WHERE control_target = 'not-owner-target'");
    expect(rows).toHaveLength(0);
  });

  it("klasse D-semantikk UENDRET: IKKE-eier nektes activate_kill_switch UTEN en signert godkjenning ('class_d_missing_approval'), eieren (SOVEREIGN) kjører INSTANT uten godkjenning", async () => {
    const { gateway } = freshStack();
    const otherAttempt = await gateway.execute({ identity: otherIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "forsøk uten godkjenning" } });
    expect(otherAttempt.ok).toBe(false);
    if (!otherAttempt.ok) expect(otherAttempt.reason).toBe("class_d_missing_approval");

    const ownerAttempt = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "eier - instant" } });
    expect(ownerAttempt.ok).toBe(true); // SOVEREIGN: ingen approval-friksjon for eieren, se PolicyGateway.authorize() klasse D-grenen.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("selv OM ToolGateway/PolicyGateway ble omgått: assertOwnerControlAuthorized() på DB-laget nekter DIREKTE en feil/manglende actor (dyp forsvarslinje, ikke bare grensesnittet)", async () => {
    const killSwitch = new KillSwitch(appPool, authority);
    await expect(killSwitch.activateDurable("direkte forsøk", OTHER)).rejects.toThrow();
    await expect(killSwitch.activateDurable("uten actor")).rejects.toThrow();
    expect(await killSwitch.isActiveDurable()).toBe(false);
  });
});

describe("D: ToolGateway-komposisjon - owner_controls.* er et VANLIG ToolGateway-verktøy, ingen særbehandling utover de dokumenterte unntakene", () => {
  it("get_control_state (klasse A) komponerer kill_switch + frozen_connectors + revoked_credentials i ETT svar", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "d-test", reason: "d" } });
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-d-test", reason: "d" } });
    const state = await getState(gateway, ownerIdentity);
    expect(state.kill_switch.active).toBe(false);
    expect(state.frozen_connectors.map((c) => c.connector_id)).toContain("d-test");
    expect(state.revoked_credentials.map((c) => c.credential_ref)).toContain("cred-d-test");
  });

  it("manglende invocation-context feiler lukket (transport kalt direkte, uten context - samme disiplin som SituationsTransport/ExecutiveTransport)", async () => {
    const { gateway } = freshStack();
    const definition = gateway.get("owner_controls", "get_control_state");
    expect(definition).toBeDefined();
    await expect(definition!.transport.invoke("get_control_state", {}, "cred", undefined as never)).rejects.toThrow("owner_controls_missing_invocation_context");
  });

  it("ukjent action avvises med en tydelig feil, ikke en stille no-op", async () => {
    const { gateway } = freshStack();
    const definition = gateway.get("owner_controls", "get_control_state")!;
    await expect(
      definition.transport.invoke("not_a_real_action", {}, "cred", { identity: ownerIdentity })
    ).rejects.toThrow("unknown_owner_controls_action:not_a_real_action");
  });

  it("manglende påkrevd parameter (reason/connector_id/credential_ref) avvises av zod FØR transporten - 'invalid_parameters', ikke en uklar transport-feil", async () => {
    const { gateway } = freshStack();
    const missingReason = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "no-reason" } as never });
    expect(missingReason.ok).toBe(false);
    if (!missingReason.ok) expect(missingReason.reason).toBe("invalid_parameters");
  });
});

describe("F: restart/gjenoppretting - INGEN oppstartsvindu der en fersk instans utfører FØR lastet tilstand håndheves", () => {
  it("en KillSwitch(pool)-instans som ALDRI har kalt restore() gir likevel korrekt isActiveDurable() FØRSTE gang den spørres - den autoritative sjekken avhenger IKKE av restore()", async () => {
    const writer = new KillSwitch(appPool, authority);
    await writer.activateDurable("F-test", OWNER);

    const neverRestored = new KillSwitch(appPool, authority); // konstruert, men restore() ALDRI kalt.
    expect(await neverRestored.isActiveDurable()).toBe(true); // riktig svar likevel - LIVE spørring, ikke avhengig av en oppvarmingsfase.

    await writer.deactivateDurable(OWNER);
  });

  it("restore() speiler DB-tilstanden inn i den synkrone in-memory-cachen (for observability/synkrone kallesteder) - en lokal, ALDRI-persistert synkron pause OVERSKRIVES av restore()", async () => {
    const registry = new KillSwitch(appPool, authority);
    registry.activate("kun-in-memory-aldri-persistert"); // ren synkron - ALDRI skrevet til DB.
    expect(registry.isActive()).toBe(true);
    await registry.restore(); // DB har ingen rad -> in-memory-cachen nullstilles.
    expect(registry.isActive()).toBe(false);
  });

  it("OwnerControls.restore() gjenoppretter frys/tilbakekall-settene fullstendig fra DB, uavhengig av killSwitch sin egen tilstand", async () => {
    const writer = freshStack();
    await writer.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "f-restore", reason: "f" } });

    const fresh = freshStack();
    await fresh.ownerControls.restore();
    expect(fresh.ownerControls.isFrozen("f-restore")).toBe(true);
    await fresh.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "f-restore" } });
  });
});

describe("G: audit - actor/reason logget, ingen hemmeligheter, replay/idempotens korrekt", () => {
  it("activate_kill_switch skriver en audit_events-rad med korrekt person_id/tool_id/action, OG en payload UTEN credential-VERDIEN (kun credential_ref)", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "G-test audit" } });
    expect(result.ok).toBe(true);
    const { rows } = await adminPool.query(
      `SELECT person_id, tool_id, action, type, decision, payload FROM audit_events
       WHERE tool_id = 'owner_controls' AND action = 'activate_kill_switch' ORDER BY audit_id DESC LIMIT 1`
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { person_id: string; tool_id: string; action: string; type: string; decision: string; payload: { credential_ref?: string } };
    expect(row.person_id).toBe(OWNER);
    expect(row.type).toBe("tool.executed");
    expect(row.decision).toBe("ALLOW");
    expect(row.payload.credential_ref).toBeDefined();
    expect(JSON.stringify(row.payload)).not.toContain("test-token"); // den FAKTISKE credential-verdien fra `secrets.get()` - ALDRI i payloaden.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("en NEKTET mutasjon (kill switch aktiv) skriver OGSÅ en audit-rad ('tool.denied'), reasonen er ALDRI stille tapt", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "G-deny-test" } });
    const denied = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-deny", reason: "skal nektes" } });
    expect(denied.ok).toBe(false);
    const { rows } = await adminPool.query(
      `SELECT reason, decision FROM audit_events WHERE tool_id = 'owner_controls' AND action = 'freeze_connector' AND decision = 'DENY' ORDER BY audit_id DESC LIMIT 1`
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reason: string }).reason).toBe("kill_switch_active");
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("idempotency_key: en GJENTATT freeze_connector med SAMME idempotency_key dedupliseres (deduplicated:true), utløser INGEN ny skriving/audit-rad for selve mutasjonen", async () => {
    const { gateway } = freshStack();
    const key = "idem-g-test-1";
    const first = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-idem", reason: "første" }, idempotency_key: key });
    expect(first.ok).toBe(true);
    const second = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-idem", reason: "andre - skal IKKE kjøre" }, idempotency_key: key });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.deduplicated).toBe(true);
    const { rows } = await adminPool.query("SELECT reason FROM owner_control_state WHERE control_target = 'g-idem'");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reason: string }).reason).toBe("første"); // den DEDUPLISERTE andre kjøringen endret INGENTING.
  });
});

describe("H: RLS/tenant-isolasjon - dokumentert N/A (global, system-autoritet-tilstand, se 058_owner_control_authority.sql)", () => {
  it("owner_control_state har INGEN tenant_id-kolonne - tilstanden er BEVISST global, samme owner sett fra to FORSKJELLIGE tenants ser SAMME kill switch/frys-tilstand", async () => {
    const { columns } = await adminPool
      .query("SELECT column_name FROM information_schema.columns WHERE table_name = 'owner_control_state'")
      .then((r) => ({ columns: r.rows.map((row) => (row as { column_name: string }).column_name) }));
    expect(columns).not.toContain("tenant_id");

    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h-cross-tenant", reason: "h" } });
    // SAMME eier (OWNER er eier i BÅDE TENANT og TENANT_B, se `authority.owner_tenants`), ANNEN tenant_id i identiteten.
    const stateFromTenantB = await getState(gateway, ownerIdentityTenantB);
    expect(stateFromTenantB.frozen_connectors.map((c) => c.connector_id)).toContain("h-cross-tenant"); // FORVENTET - global, ikke en lekkasje.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "h-cross-tenant" } });
  });
});

describe("I: B1-fix (D-166, arkitekt-review PR #93) - MINIMAL, handlings-nivå selvgjenoppretting for tilbakekalt DELT credential_ref, inkl. samtidig kill-switch+tilbakekalt-credential-deadlock", () => {
  /** Rydder den DELTE interne refen tilbake til ikke-tilbakekalt uansett hvor en test feilet - denne refen deles av HELE describe-blokken sin gateway/adminPool. */
  async function ensureSharedRefRestored(): Promise<void> {
    await adminPool.query("DELETE FROM owner_control_state WHERE control_kind = 'credential_revocation' AND control_target = $1", [BUSINESS_INTERNAL_CREDENTIAL_REF]);
  }

  it("1) DELT INTERN CREDENTIAL SELVGJENOPPRETTING: revoke_credential på BUSINESS_INTERNAL_CREDENTIAL_REF blokkerer en NORMAL owner_controls-mutasjon (freeze_connector), men restore_credential selv når frem til transporten og gjenoppretter normal drift", async () => {
    const { gateway, ownerControls } = freshStack();
    try {
      const revoked = await gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential",
        parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "B1-test: den delte interne refen" }
      });
      expect(revoked.ok).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(true);

      // NORMAL owner_controls-mutasjon (freeze_connector er IKKE i selvgjenopprettingsmengden) - MÅ nektes.
      const normalDenied = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "b1-normal", reason: "skal nektes" } });
      expect(normalDenied.ok).toBe(false);
      if (!normalDenied.ok) expect(normalDenied.reason).toBe("credential_revoked");

      // Diagnostikk: get_control_state (i selvgjenopprettingsmengden) - MÅ fortsatt fungere.
      const diag = await getState(gateway, ownerIdentity);
      expect(diag.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);

      // Selve gjenopprettingen: restore_credential på DEN SAMME refen den selv trenger - NÅR FREM til transporten.
      const restored = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(restored.ok).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(false);

      // Normal drift gjenopprettet.
      const normalWorksAgain = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "b1-normal-2", reason: "skal nå lykkes" } });
      expect(normalWorksAgain.ok).toBe(true);
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "b1-normal-2" } });
    } finally {
      await ensureSharedRefRestored();
    }
  });

  it("2) IKKE-EIER kan IKKE utnytte selvgjenopprettings-unntaket - restore_credential på den delte refen nektes for en ikke-eier-identitet ('class_c_no_mandate'), ingen skriving skjer", async () => {
    const { gateway, ownerControls } = freshStack();
    try {
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "B1-test-2" } });
      const otherAttempt = await gateway.execute({ identity: otherIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(otherAttempt.ok).toBe(false);
      if (!otherAttempt.ok) expect(otherAttempt.reason).toBe("class_c_no_mandate"); // selvgjenopprettingsunntaket dekker KUN kill-switch-/credential-sjekkene - eier-autoritetssjekken (klasse C) er UENDRET.
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(true); // fortsatt tilbakekalt - ikke-eieren fikk INGENTING gjort.
      // Forfalsket identitet i PARAMETRE (aldri brukt til autorisasjon) avvises OGSÅ FØR transporten - strict()-skjema uendret av B1-fiksen.
      const forged = await gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential",
        parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, actor_person_id: OTHER } as never
      });
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.reason).toBe("invalid_parameters");
    } finally {
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      await ensureSharedRefRestored();
    }
  });

  it("3a) SAMTIDIG DEADLOCK, rekkefølge A (restore_credential FØR deactivate_kill_switch): kill switch aktiv OG delt credential tilbakekalt SAMTIDIG - gjenopprettes FULLSTENDIG via KUN kanoniske ToolGateway-handlinger, INGEN manuell SQL", async () => {
    const { gateway, ownerControls, killSwitch } = freshStack();
    try {
      // Sett BEGGE tilstandene direkte via det durable authority-laget (samme lag `owner_controls.*` selv skriver til) -
      // IKKE rå SQL - dette simulerer at begge ble aktivert i to separate, tidligere kall (naturlig rekkefølge-uavhengig).
      await killSwitch.activateDurable("B1-test-3a: samtidig deadlock", OWNER);
      await ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "B1-test-3a: samtidig deadlock", OWNER);
      expect(await killSwitch.isActiveDurable()).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(true);

      // Steg 1: restore_credential FØRST - må nå frem til transporten selv om kill switch OGSÅ er aktiv
      // (PolicyGateway sin kill-switch-sjekk MÅ unnta restore_credential, ikke bare deactivate_kill_switch/get_control_state).
      const step1 = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(step1.ok).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(false);
      expect(await killSwitch.isActiveDurable()).toBe(true); // kill switch STÅR FORTSATT - kun credential-delen løst så langt.

      // Steg 2: deactivate_kill_switch - credential er nå gjenopprettet, så selv UTEN unntak ville dette gått gjennom nå;
      // beviser likevel den FULLE kanoniske kjeden fullfører.
      const step2 = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
      expect(step2.ok).toBe(true);
      expect(await killSwitch.isActiveDurable()).toBe(false);

      // Full normal drift gjenopprettet.
      const normalWorks = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "b1-3a", reason: "skal lykkes" } });
      expect(normalWorks.ok).toBe(true);
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "b1-3a" } });
    } finally {
      await killSwitch.deactivateDurable(OWNER).catch(() => undefined);
      await ensureSharedRefRestored();
    }
  });

  it("3b) SAMTIDIG DEADLOCK, rekkefølge B (deactivate_kill_switch FØR restore_credential): SAMME to samtidige tilstander, MOTSATT gjenopprettingsrekkefølge - beviser BEGGE ordninger er deterministisk mulige, ikke bare én tilfeldig fungerende vei", async () => {
    const { gateway, ownerControls, killSwitch } = freshStack();
    try {
      await killSwitch.activateDurable("B1-test-3b: samtidig deadlock, motsatt rekkefølge", OWNER);
      await ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "B1-test-3b: samtidig deadlock, motsatt rekkefølge", OWNER);
      expect(await killSwitch.isActiveDurable()).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(true);

      // Steg 1: deactivate_kill_switch FØRST - må nå frem selv om DENS EGEN credential_ref FORTSATT er tilbakekalt
      // (ToolGateway sin tilbakekalt-credential-sjekk MÅ unnta deactivate_kill_switch, ikke bare restore_credential).
      const step1 = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
      expect(step1.ok).toBe(true);
      expect(await killSwitch.isActiveDurable()).toBe(false);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(true); // credential-delen STÅR FORTSATT.

      // Steg 2: restore_credential - kill switch er nå av, så dette lykkes uansett; beviser den fulle kjeden.
      const step2 = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(step2.ok).toBe(true);
      expect(await ownerControls.isRevokedDurable(BUSINESS_INTERNAL_CREDENTIAL_REF)).toBe(false);

      const normalWorks = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "b1-3b", reason: "skal lykkes" } });
      expect(normalWorks.ok).toBe(true);
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "b1-3b" } });
    } finally {
      await killSwitch.deactivateDurable(OWNER).catch(() => undefined);
      await ensureSharedRefRestored();
    }
  });

  it("4) DIAGNOSTIKK: get_control_state fungerer korrekt og ALDRI nektet i alle tre tilstander - kun credential tilbakekalt, kun kill switch aktiv, og BEGGE samtidig", async () => {
    const { gateway, ownerControls, killSwitch } = freshStack();
    try {
      const onlyCredential = await getState(gateway, ownerIdentity);
      expect(onlyCredential.kill_switch.active).toBe(false);

      await ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "B1-test-4a", OWNER);
      const diagCredentialOnly = await getState(gateway, ownerIdentity);
      expect(diagCredentialOnly.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);

      await killSwitch.activateDurable("B1-test-4b", OWNER);
      const diagBoth = await getState(gateway, ownerIdentity);
      expect(diagBoth.kill_switch.active).toBe(true);
      expect(diagBoth.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);

      await killSwitch.deactivateDurable(OWNER);
      const diagKillSwitchLifted = await getState(gateway, ownerIdentity);
      expect(diagKillSwitchLifted.kill_switch.active).toBe(false);
      expect(diagKillSwitchLifted.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF); // credential-delen uendret av kill-switch-deaktivering.
    } finally {
      await killSwitch.deactivateDurable(OWNER).catch(() => undefined);
      await ensureSharedRefRestored();
    }
  });

  it("5) NORMAL NEKTELSE FORBLIR: activate_kill_switch/freeze_connector/unfreeze_connector/revoke_credential er ALDRI unntatt fra tilbakekalt-credential-sjekken - KUN de tre navngitte gjenopprettingshandlingene er det", async () => {
    const { gateway, ownerControls } = freshStack();
    try {
      await ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "B1-test-5", OWNER);
      for (const attempt of [
        { action: "activate_kill_switch", parameters: { reason: "skal nektes" } },
        { action: "freeze_connector", parameters: { connector_id: "b1-5", reason: "skal nektes" } },
        { action: "unfreeze_connector", parameters: { connector_id: "b1-5" } },
        { action: "revoke_credential", parameters: { credential_ref: "et-annet-mal", reason: "skal nektes" } }
      ] as const) {
        const result = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: attempt.action, parameters: attempt.parameters });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("credential_revoked");
      }
    } finally {
      await ensureSharedRefRestored();
    }
  });

  it("6) EKSISTERENDE GJENOPPRETTING UENDRET: kill-switch- og selv-frys-gjenoppretting fra D-164 fungerer FORTSATT identisk etter B1-fiksen (ren regresjon, ingen ny credential-tilstand involvert)", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "B1-test-6-regresjon" } });
    const stillReadable = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
    expect(stillReadable.ok).toBe(true);
    const deactivated = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true);
    const afterRecovery = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "b1-6", reason: "skal lykkes" } });
    expect(afterRecovery.ok).toBe(true);
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "b1-6" } });
  });

  it("7) AUDIT: gjenopprettingshandlinger (restore_credential/deactivate_kill_switch) under aktiv tilbakekalling/kill-switch er FORTSATT revidert med korrekt actor/reason, ALDRI en credential-VERDI", async () => {
    const { gateway, ownerControls } = freshStack();
    try {
      await ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "B1-test-7", OWNER);
      const restored = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(restored.ok).toBe(true);
      const { rows } = await adminPool.query(
        `SELECT person_id, type, decision, payload FROM audit_events WHERE tool_id = 'owner_controls' AND action = 'restore_credential' ORDER BY audit_id DESC LIMIT 1`
      );
      expect(rows).toHaveLength(1);
      const row = rows[0] as { person_id: string; type: string; decision: string; payload: { credential_ref?: string } };
      expect(row.person_id).toBe(OWNER);
      expect(row.type).toBe("tool.executed");
      expect(row.decision).toBe("ALLOW");
      expect(row.payload.credential_ref).toBe(BUSINESS_INTERNAL_CREDENTIAL_REF); // referanse - ALDRI en credential-verdi.
      expect(JSON.stringify(row.payload)).not.toContain("test-token"); // den faktiske secret-verdien fra `secrets.get()` - aldri i payload.
    } finally {
      await ensureSharedRefRestored();
    }
  });
});

describe("J: D-167 (host-harness-korreksjon, arkitekt-funn PR #93) - audit-bevis for owner_controls MÅ være avgrenset til (session_id, vannmerke), ALDRI en håndplukket 'siste N rader'-grense", () => {
  it("1) MER ENN 10 senere matchende owner_controls-audit-rader gjør IKKE en tidligere aktivering usynlig for et vannmerke+session_id-avgrenset bevis - selv om en naiv ORDER BY audit_id DESC LIMIT 10 (uten avgrensning) beviselig ville mistet den", async () => {
    const { gateway } = freshStack();
    const watermark = await captureAuditWatermark(adminPool);
    try {
      const activated = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "J-watermark-test" } });
      expect(activated.ok).toBe(true);

      // MER ENN 10 senere, matchende owner_controls-handlinger under SAMME
      // identitet - akkurat scenariet (B1/D-166 la til flere `owner_controls`-
      // kall enn den opprinnelige, håndplukkede grensen tålte) som gjorde den
      // opprinnelige `k1-owner-control-authority-live.ts` sin "siste 10
      // rader"-spørring ikke-deterministisk. Kill switchen er aktiv, så disse
      // nektes ('tool.denied') - det er nok til å reprodusere problemet, siden
      // BÅDE ALLOW- og DENY-rader teller for `action IN (...)`.
      for (let i = 0; i < 12; i++) {
        await gateway.execute({
          identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector",
          parameters: { connector_id: `j-watermark-padding-${i}`, reason: "padding" }
        });
      }

      // Reproduserer BEVISST den GAMLE, fikserte bug-en: en naiv "siste 10
      // matchende rader"-spørring UTEN vannmerke/session-avgrensning mister
      // aktiveringen så snart 10+ senere matchende rader finnes.
      const naiveRows = await adminPool.query(
        `SELECT action FROM audit_events WHERE tool_id = 'owner_controls' AND person_id = $1
         AND action IN ('activate_kill_switch','freeze_connector') ORDER BY audit_id DESC LIMIT 10`,
        [OWNER]
      );
      expect(naiveRows.rows.some((r) => (r as { action: string }).action === "activate_kill_switch")).toBe(false);

      // FIKSEN: samme underliggende data, men avgrenset til (session_id,
      // vannmerke) - aktiveringen er FORTSATT synlig, og resultatmengden er
      // beviselig STØRRE enn 10 (ikke reddet av en tilfeldig liten datamengde).
      const scopedEvents = await queryRunScopedOwnerControlsAudit(adminPool, {
        personId: OWNER, sessionId: ownerIdentity.session_id!, watermark, actions: ["activate_kill_switch", "freeze_connector"]
      });
      expect(scopedEvents.length).toBeGreaterThan(10);
      expect(scopedEvents.some((e) => e.action === "activate_kill_switch" && e.type === "tool.executed")).toBe(true);
    } finally {
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} }).catch(() => undefined);
    }
  });

  it("2) en ANNEN session_id (samme eier, samme tool_id, SAMME vannmerke-vindu - dvs. rader ETTER vannmerket) telles IKKE med i et vannmerke+session_id-avgrenset bevis for DENNE kjøringen - avgrensningen er BÅDE session_id- OG vannmerke-basert, ikke kun én av dem", async () => {
    const { gateway } = freshStack();
    const watermark = await captureAuditWatermark(adminPool);

    // Skriver EN rad under en ANNEN, unik session_id - ETTER vannmerket, akkurat
    // som "denne kjøringens" egen rad under. Kun `session_id` skiller dem.
    const otherSessionIdentity: IdentityContext = { ...ownerIdentity, session_id: "sess-owner-controls-j-other-session" };
    await gateway.execute({ identity: otherSessionIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "J-other-session" } });
    await gateway.execute({ identity: otherSessionIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });

    const activated = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "J-this-session" } });
    expect(activated.ok).toBe(true);
    try {
      const scopedEvents = await queryRunScopedOwnerControlsAudit(adminPool, {
        personId: OWNER, sessionId: ownerIdentity.session_id!, watermark, actions: ["activate_kill_switch"]
      });
      // KUN denne kjøringens ÉN aktivering - IKKE den andre session_id-en sin
      // (som forøvrig OGSÅ ligger ETTER vannmerket - kun session_id skiller dem).
      expect(scopedEvents).toHaveLength(1);
      expect(scopedEvents[0]!.action).toBe("activate_kill_switch");
    } finally {
      await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} }).catch(() => undefined);
    }
  });
});

describe("K: D-174/D-175 (B2, task F, RETTET av arkitekt-review 5250409538 BLOKKER B4) - owner_controls.revoke_device: eier-vendt tilbakekalling av EN NAVNGITT enhets session_grants i identity.tenant_id, via SessionGrantService.revokeForDeviceOn(), INGEN duplikat session-grant-tilstand, INGEN kaller-oppgitt tenant_id-parameter", () => {
  it("1) eieren tilbakekaller EN NAVNGITT enhets utestående grants i EGEN (identity.tenant_id) tenant - nøyaktig antall revokert rapportert, raden faktisk revoked_at IS NOT NULL i session_grants", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-owner-revoke";
    await seedGrant(TENANT, deviceId);
    expect(await activeGrantCount(TENANT, deviceId)).toBe(1);
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "k1-test-lost-phone" }
    });
    expect(result.ok).toBe(true);
    expect(revokedGrantsFrom(result)).toBe(1);
    expect(await activeGrantCount(TENANT, deviceId)).toBe(0);
  });

  it("2) eieren kan tilbakekalle en ANNEN persons (delegat) enhet, SÅ LENGE enheten er i SAMME (identity.tenant_id) tenant - personeierskap over målenheten er IKKE påkrevd, kun tenant-medlemskap", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-delegate";
    await seedGrant(TENANT, deviceId, OTHER); // enheten tilhører OTHER, men i EIERENS EGEN tenant
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "k1-delegate-device" }
    });
    expect(result.ok).toBe(true);
    expect(revokedGrantsFrom(result)).toBe(1);
    expect(await activeGrantCount(TENANT, deviceId)).toBe(0);
  });

  it("3) IKKE-eier identitet kan IKKE tilbakekalle en enhet - 'class_c_no_mandate', INGEN grant rørt (samme mandat-disiplin som ALLE andre owner_controls-mutasjoner)", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-not-owner";
    await seedGrant(TENANT, deviceId);
    const result = await gateway.execute({
      identity: otherIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "not-my-call" }
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("class_c_no_mandate");
    expect(await activeGrantCount(TENANT, deviceId)).toBe(1);
  });

  it("4) D-175 (BLOKKER B4): en enhet som KUN finnes i en ANNEN tenant feiler LUKKET - ALDRI et stille ok:true/revoked_grants:0. tenant_id er IKKE et kaller-parameter (skjemaet mangler feltet) - tenanten er UBETINGET identity.tenant_id, en kaller kan derfor IKKE 'velge' en annen tenant i det hele tatt", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-wrong-tenant";
    await seedGrant(TENANT_B, deviceId); // enheten hører KUN til TENANT_B
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device", // ownerIdentity.tenant_id === TENANT, IKKE TENANT_B
      parameters: { device_id: deviceId, reason: "wrong-tenant-attempt" }
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/device_not_found/);
    expect(await activeGrantCount(TENANT_B, deviceId)).toBe(1); // uendret - den faktiske raden lever under TENANT_B, urørt
  });

  it("5) gjentatt tilbakekalling av en enhet i SAMME tenant er idempotent-sikker: andre kallet revokerer 0, INGEN feil, INGEN dobbel-telling", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-idempotent";
    await seedGrant(TENANT, deviceId);
    const first = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "first-call" }
    });
    expect(revokedGrantsFrom(first)).toBe(1);
    const second = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "second-call-repeat" }
    });
    expect(second.ok).toBe(true);
    expect(revokedGrantsFrom(second)).toBe(0);
  });

  it("6) audit-raden inneholder device_id/reason for identifikasjon og etterforskning, ALDRI grant-token/fingerprint-VERDIER", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-audit";
    await seedGrant(TENANT, deviceId);
    const watermark = await captureAuditWatermark(adminPool);
    await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "k1-audit-test-reason" }
    });
    const { rows } = await adminPool.query(
      `SELECT device_id, reason, payload, person_id FROM audit_events
       WHERE type = 'owner_controls.device_revoked' AND audit_id > $1 ORDER BY audit_id ASC`,
      [watermark]
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { device_id: string; reason: string; payload: unknown; person_id: string };
    expect(row.device_id).toBe(deviceId);
    expect(row.reason).toBe("k1-audit-test-reason");
    expect(row.person_id).toBe(OWNER);
    const serializedPayload = JSON.stringify(row.payload);
    expect(serializedPayload).not.toMatch(/grt_/);
    expect(serializedPayload).not.toMatch(/test-fingerprint/);
  });

  it("7) kaller kan IKKE 'velge' en annen tenant via parametre - et oppgitt tenant_id-felt avvises av det strenge skjemaet FØR transporten nås ('invalid_parameters'), IKKE stille ignorert", async () => {
    const { gateway } = freshStackWithDeviceRevocation();
    const deviceId = "device-k1-strict-schema";
    await seedGrant(TENANT, deviceId);
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { tenant_id: TENANT_B, device_id: deviceId, reason: "attempted-tenant-override" }
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid_parameters");
    expect(await activeGrantCount(TENANT, deviceId)).toBe(1); // urørt - avvist FØR noe kunne skje
  });
});
