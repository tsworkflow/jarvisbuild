import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApproval, type IdentityContext, type JsonValue, type SignedApproval } from "@jarvis/contracts";
import { createPool, fastRoute, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, homeAssistantTools, type SecretProvider } from "@jarvis/tool-gateway";

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
const watchKeys = generateKeyPairSync("ed25519");
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let ha: FakeTransport;

// Talekanal med rom-metadata: rommet kommer fra identitetskonteksten.
const voiceIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-stue", device_id: "satellitt-stue", channel: "voice",
  auth_strength: "active", site_id: "site-hus", room_id: "rom-stue"
};

const secrets: SecretProvider = { name: "test", async get() { return "ha-token"; } };

function approval(action: string, parameters: Record<string, unknown>): SignedApproval {
  return signApproval(watchKeys.privateKey, {
    tool_id: "home-assistant", action, tenant_id: voiceIdentity.tenant_id, person_id: voiceIdentity.person_id,
    approver_person_id: voiceIdentity.person_id, parameters: parameters as Record<string, JsonValue>,
    nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-1"
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg9-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey, { tenant_id: "tenant-a", person_id: "person-tobias" });
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  // Q-34 (D-130, lukket i modules/tool-gateway - `lock_set`/`alarm_set` har nå
  // `preflight_requires_target: true`): `read_state`-preflighten MÅ svare med
  // en DEFINERT tilstand, ikke en tom ack - ellers ville denne generiske faken
  // (som IKKE modellerer entity-/rom-spesifikk tilstand) selv trigget
  // `preflight_target_not_found` for lås/alarm-testene i beskrivelsen under,
  // som IKKE handler om mål-eksistens. Se home-assistant-critical-action.test.ts
  // for den EKTE, entity-/rom-bevisste mål-eksistens-testingen.
  //
  // Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82): `lock_set`/
  // `alarm_set` har nå OGSÅ `postcondition_predicate` - readback MÅ faktisk
  // vise den kommanderte verdien, ikke bare en STATISK, alltid-lik ack. Denne
  // generiske faken (som ikke bryr seg om entity-/rom-identitet, kun om
  // "skjedde det en lås-/alarm-kommando") holder derfor ETT enkelt, delt
  // `locked`/`armed`-par den FAKTISK oppdaterer på mutasjon, slik at
  // readback-en etterpå ekte reflekterer den siste kommanderte verdien.
  let lockedState = true;
  let armedState = false;
  ha = new FakeTransport((action, parameters) => {
    if (action === "read_state") return { data: { locked: lockedState, armed: armedState } };
    if (action === "lock_set") { lockedState = parameters["locked"] as boolean; return { external_id: "ha-ok" }; }
    if (action === "alarm_set") { armedState = parameters["armed"] as boolean; return { external_id: "ha-ok" }; }
    return { external_id: "ha-ok" };
  });
  gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of homeAssistantTools(ha)) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Akseptanse 2: stedsriktige kommandoer per rom", () => {
  it("'skru på lyset her' rutes deterministisk og bærer rommet fra identiteten", async () => {
    const intent = fastRoute("skru på lyset her");
    expect(intent).toEqual({ kind: "home_light", on: true });
    expect(fastRoute("slå av lyset")).toEqual({ kind: "home_light", on: false });

    const result = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "light_set",
      parameters: { site_id: voiceIdentity.site_id!, room_id: voiceIdentity.room_id!, on: true }
    });
    expect(result.ok).toBe(true);
    expect(ha.calls.at(-1)?.parameters["room_id"]).toBe("rom-stue");
  });

  it("lesing av romtilstand er klasse A og output er untrusted", async () => {
    const result = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "read_state",
      parameters: { site_id: "site-hus", room_id: "rom-stue" }
    });
    expect(result.ok && result.output_trust).toBe("untrusted");
  });
});

describe("Akseptanse 3: lås/alarm krever signert godkjenning - også via tale", () => {
  it("lock_set via talekanal uten godkjenning → DENY; med gyldig → ALLOW; replay → DENY", async () => {
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };
    const denied = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });
    expect((denied as { reason: string }).reason).toBe("class_d_missing_approval");
    expect(ha.calls.filter((c) => c.action === "lock_set")).toHaveLength(0);

    const signed = approval("lock_set", parameters);
    const allowed = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters, approval: signed
    });
    expect(allowed.ok).toBe(true);
    const replay = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters, approval: signed
    });
    expect((replay as { reason: string }).reason).toBe("class_d_nonce_already_used");
  });

  it("alarm_set uten godkjenning → DENY ('sagt høyt' gir aldri unntak)", async () => {
    const denied = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "alarm_set",
      parameters: { site_id: "site-hus", room_id: "rom-gang", armed: false }
    });
    expect((denied as { reason: string }).reason).toBe("class_d_missing_approval");
  });

  it("HA-verktøyene har komplett capability-metadata og riktige klasser", () => {
    const tools = homeAssistantTools();
    expect(tools.find((t) => t.action === "lock_set")?.capability_class).toBe("D");
    expect(tools.find((t) => t.action === "alarm_set")?.capability_class).toBe("D");
    expect(tools.find((t) => t.action === "light_set")?.capability_class).toBe("B");
    for (const t of tools) {
      expect(t.rollback_procedure.length).toBeGreaterThan(0);
      expect(t.credential_ref).toBe("JARVIS_HA_TOKEN");
    }
  });
});
