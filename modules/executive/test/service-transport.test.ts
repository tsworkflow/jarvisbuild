import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, DeviceService, PgApprovalStore, runMigrations, SessionGrantService } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FinanceService, FinanceTransport } from "@jarvis/finance";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { OwnerControlsService, OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { firstWaveTools, ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ExecutiveAccessDeniedError } from "../src/service.ts";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import type { AttentionItem, ControlSurfaceStatus } from "../src/types.ts";

/**
 * UA-11 Executive Mode (P0, D-162): ende-til-ende-bevis mot EKTE embedded
 * Postgres/RLS + EKTE `ToolGateway`/`PolicyGateway`/`SituationEngine`/
 * `DomainPauseRegistry` - SAMME mønster som
 * `modules/situations/test/activation.test.ts`. `ExecutiveService` seeder
 * ALDRI situasjoner selv - enhver situasjon i disse testene kommer fra
 * `SituationEngine.evaluateCandidate()` (den kanoniske inngangen `sweep.ts`
 * selv bruker) - beviser at Executive Mode KOMPONERER, aldri duplisererer.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let killSwitch: KillSwitch;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;
let gateway: ToolGateway;
let executiveService: ExecutiveService;

const TENANT_A = "tenant-exec-a";
const TENANT_B = "tenant-exec-b";
const OWNER = "person-tobias-executive";
const OTHER = "person-other-executive";

/** SAMME permissive test-provider-konvensjon som `activation.test.ts` - denne suiten beviser komposisjon/autoritet, ikke credential-oppløsning (den er dekket separat av situations-pakkens egen regresjonsvakt). */
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };

function identityFor(tenantId: string, memorySpace: "business" | "personal", personId: string = OWNER): IdentityContext {
  return {
    person_id: personId, tenant_id: tenantId, memory_space_id: memorySpace,
    session_id: `sess-executive-${tenantId}-${memorySpace}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}
const ownerA = identityFor(TENANT_A, "business");
const ownerAPersonal = identityFor(TENANT_A, "personal");
const ownerB = identityFor(TENANT_B, "business");
const otherA: IdentityContext = { ...ownerA, person_id: OTHER, session_id: "sess-other" };

let loopSeq = 0;
async function seedSituation(
  tenantId: string,
  memorySpace: "business" | "personal",
  overrides: Partial<{ domain: string; priority: "low" | "normal" | "high"; confidence: number; reason: string }> = {}
) {
  loopSeq += 1;
  const v = { domain: "pipeline", priority: "normal" as const, confidence: undefined as number | undefined, reason: `Testgrunn ${loopSeq}`, ...overrides };
  const result = await engine.evaluateCandidate(tenantId, memorySpace, {
    domain: v.domain, detection_key: `exec-test:${loopSeq}`, priority: v.priority,
    ...(v.confidence !== undefined ? { confidence: v.confidence } : {}), reason: v.reason
  });
  return result.situation;
}

async function getQueueViaExecutive(identity: IdentityContext, domain?: string): Promise<AttentionItem[]> {
  const result = await gateway.execute({
    identity, tool_id: "executive", action: "get_attention_queue", parameters: domain ? { domain } : {}
  });
  if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
  return result.data as unknown as AttentionItem[];
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-executive-"));
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
  await adminPool.query("CREATE ROLE jarvis_executive_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_executive_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Executive A','business'), ('${TENANT_B}','Executive B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT_A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_executive_test", password: "pw2" });
  killSwitch = new KillSwitch();
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER });
}, 240_000);

beforeEach(async () => {
  gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) gateway.register(tool);
  executiveService = new ExecutiveService(gateway);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(executiveService))) gateway.register(tool);
  // K1 (D-164): egen, poolless owner_controls-instans PER TEST (isolert fra den
  // delte `killSwitch`/`policy` som G-blokken under IKKE skal forurense) -
  // beviser KUN at `executive.get_control_surface_status` komponerer korrekt,
  // ikke selve durabiliteten (dekket separat av @jarvis/policy sine egne
  // `*Durable()`-tester + K1 sin dedikerte A-J-suite).
  const controlKillSwitch = new KillSwitch();
  const controlOwnerControls = new OwnerControls(controlKillSwitch);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(new OwnerControlsService(controlKillSwitch, controlOwnerControls)))) {
    gateway.register(tool);
  }
  // D-174 (B2): `executive.get_control_surface_status`/`executive.*_finance_kill_switch`
  // nøster nå OGSÅ `finance.*` (SAMME `firstWaveTools()`-komposisjonsrot
  // produksjonen selv bruker, IKKE en egen, parallell registrering) - `finance`
  // er den ENESTE transporten som faktisk trengs her; øvrige førstebølge-
  // verktøy (`github`/`docker`/...) forblir uregistrert-i-praksis
  // (`UnconfiguredHttpTransport`) fordi INGEN test i denne filen kaller dem.
  const finance = new FinanceService(appPool);
  for (const tool of firstWaveTools({ finance: new FinanceTransport(finance, { getCredentials: async () => null }) })) {
    gateway.register(tool);
  }
  await adminPool.query(`DELETE FROM situations WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_notification_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM finance_kill_switch WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  // D-174 (B2, "H"-blokken): den POOL-BAKTE `owner_control_state` (global,
  // INGEN tenant_id, se 058_owner_control_authority.sql) må renskes mellom
  // hver test i DENNE filen - i motsetning til "G"-blokkens BEVISST
  // poolless `controlKillSwitch`/`controlOwnerControls` over (som ALDRI
  // rører denne tabellen), bruker "H"-blokkens `freshConnectedExecutiveStack()`
  // EKTE, pool-bakte KillSwitch/OwnerControls-instanser mot SAMME delte tabell.
  await adminPool.query(`DELETE FROM owner_control_state`);
  await adminPool.query(`DELETE FROM situation_domain_pauses`);
  await domainPauses.restore();
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
});

describe("A: attention-queue komponerer situations.get_queue, ALDRI en egen kilde eller kopi", () => {
  it("en situasjon seedet DIREKTE via SituationEngine.evaluateCandidate() vises umiddelbart i executive.get_attention_queue - null egen ingestion/kopi", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9, reason: "Uvanlig utgift" });
    const items = await getQueueViaExecutive(ownerA);
    const found = items.find((i) => i.situation_id === s.situation_id);
    expect(found).toBeDefined();
    expect(found!.domain).toBe("spend");
    expect(found!.reason).toBe("Uvanlig utgift");
    expect(found!.action_kind).toBe("suggest"); // high+konfidens>=0.75 -> suggest (computeTargetStage)
  });
  it("domain-filteret videresendes til situations.get_queue - ingen egen filtreringslogikk som kan divergere", async () => {
    await seedSituation(TENANT_A, "business", { domain: "spend" });
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const spendOnly = await getQueueViaExecutive(ownerA, "spend");
    expect(spendOnly.every((i) => i.domain === "spend")).toBe(true);
    expect(spendOnly.length).toBeGreaterThan(0);
  });
  it("REPLAY: to identiske kall i rad gir samme rangerte rekkefølge/score (ingen skjult, muterende tilstand i selve lesingen)", async () => {
    await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9 });
    await seedSituation(TENANT_A, "business", { domain: "pipeline", priority: "low" });
    const run1 = await getQueueViaExecutive(ownerA);
    const run2 = await getQueueViaExecutive(ownerA);
    expect(run1.map((i) => [i.situation_id, i.score, i.rank])).toEqual(run2.map((i) => [i.situation_id, i.score, i.rank]));
  });
});

describe("B: tenant- og memory-space-isolasjon (samme garantier som situations selv, ikke svakere)", () => {
  it("tenant-isolasjon: eieren i tenant A ser ALDRI tenant B sine situasjoner via executive", async () => {
    const sitA = await seedSituation(TENANT_A, "business", { domain: "spend" });
    const sitB = await seedSituation(TENANT_B, "business", { domain: "spend" });
    const itemsA = await getQueueViaExecutive(ownerA);
    const itemsB = await getQueueViaExecutive(ownerB);
    expect(itemsA.some((i) => i.situation_id === sitA.situation_id)).toBe(true);
    expect(itemsA.some((i) => i.situation_id === sitB.situation_id)).toBe(false);
    expect(itemsB.some((i) => i.situation_id === sitB.situation_id)).toBe(true);
    expect(itemsB.some((i) => i.situation_id === sitA.situation_id)).toBe(false);
  });
  it("memory-space-isolasjon: samme tenant, business vs personal - ingen kryssblanding", async () => {
    const sitBiz = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const sitPersonal = await seedSituation(TENANT_A, "personal", { domain: "home" });
    const bizItems = await getQueueViaExecutive(ownerA);
    const personalItems = await getQueueViaExecutive(ownerAPersonal);
    expect(bizItems.some((i) => i.situation_id === sitBiz.situation_id)).toBe(true);
    expect(bizItems.some((i) => i.situation_id === sitPersonal.situation_id)).toBe(false);
    expect(personalItems.some((i) => i.situation_id === sitPersonal.situation_id)).toBe(true);
    expect(personalItems.some((i) => i.situation_id === sitBiz.situation_id)).toBe(false);
  });
});

describe("C: eier-autoritet, forfalsket identitet, PolicyGateway/ToolGateway-bypass er strukturelt umulig", () => {
  it("en identitet for en tenant UTEN data får et gyldig, TOMT resultat (RLS - tenant-isolasjon, IKKE et policy-avslag) - dokumenterer den REELLE grensen: lesing er RLS-skopet, PolicyGateway gater mutasjoner", async () => {
    const noDataTenant = identityFor("tenant-without-any-data", "business");
    await expect(executiveService.getAttentionQueue(noDataTenant)).resolves.toEqual([]);
  });
  it("global KillSwitch nekter OGSÅ lesing gjennom executive - ExecutiveAccessDeniedError, aldri en stille tom kø som skjuler at gaten var aktiv", async () => {
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    killSwitch.activate("test");
    try {
      await expect(executiveService.getAttentionQueue(ownerA)).rejects.toBeInstanceOf(ExecutiveAccessDeniedError);
    } finally {
      killSwitch.deactivate();
    }
  });
  it("pause_domain via executive som en IKKE-eier nektes (motorens sovereign-autoritet, videreført transitivt)", async () => {
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const result = await gateway.execute({
      identity: otherA, tool_id: "executive", action: "pause_domain", parameters: { domain: "pipeline", reason: "forsøk" }
    });
    expect(result.ok).toBe(false);
    expect(domainPauses.isPaused("pipeline")).toBe(false);
  });
  it("forfalskede identitetsfelt i PARAMETRE avvises av ToolGateway (strict skjema) FØR transporten nås - aldri brukt til autorisasjon", async () => {
    const result = await gateway.execute({
      identity: ownerA, tool_id: "executive", action: "pause_domain",
      parameters: { domain: "pipeline", reason: "test", tenant_id: TENANT_B, actor_person_id: OTHER } as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_parameters");
  });
  it("manglende invocation-context feiler lukket (transport kalt direkte uten context)", async () => {
    const transport = new ExecutiveTransport(executiveService);
    await expect(transport.invoke("get_attention_queue", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});

describe("D: pause/resume gjennom KANONISK situations.* - ingen parallell pauseregistrering", () => {
  it("executive.pause_domain muterer DEN SAMME situation_domain_pauses-tilstanden som situations.get_pause_state ser", async () => {
    const paused = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "eier pauset" } });
    expect(paused.ok).toBe(true);
    const direct = await gateway.execute({ identity: ownerA, tool_id: "situations", action: "get_pause_state", parameters: {} });
    if (!direct.ok) throw new Error("unexpected_denial");
    expect((direct.data as { paused: string[] }).paused).toContain("spend");
    expect(domainPauses.isPaused("spend")).toBe(true);
    const resumed = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
    expect(resumed.ok).toBe(true);
    expect(domainPauses.isPaused("spend")).toBe(false);
  });
  it("gjentatt pause_domain via executive skaper INGEN duplikat-rad og utløser INGEN varsel-sideeffekt (kun ren tilstand)", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "1" } });
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "2" } });
    const { rows } = await adminPool.query("SELECT count(*)::int AS n FROM situation_domain_pauses WHERE domain = 'spend'");
    expect((rows[0] as { n: number }).n).toBe(1);
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
  });
  it("PAUSET domene gjenspeiles korrekt i attention-køen: authority_status.domain_paused=true og anbefalingen sier 'pauset'", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9 });
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "eier pauset" } });
    const items = await getQueueViaExecutive(ownerA);
    const item = items.find((i) => i.situation_id === s.situation_id)!;
    expect(item.authority_status.domain_paused).toBe(true);
    expect(item.recommended_next_action).toMatch(/pauset/);
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
  });
});

describe("E: resolve/stale-håndtering - løste situasjoner forsvinner fra attention-køen (ingen degradert, misvisende rangering)", () => {
  it("situations.resolve (direkte) fjerner situasjonen fra en ETTERFØLGENDE executive.get_attention_queue", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(true);
    const resolved = await gateway.execute({ identity: ownerA, tool_id: "situations", action: "resolve", parameters: { situation_id: s.situation_id } });
    expect(resolved.ok).toBe(true);
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(false);
  });
  it("executive.resolve_situation (gjennomslag) gir SAMME utfall som en direkte situations.resolve", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resolve_situation", parameters: { situation_id: s.situation_id } });
    expect(result.ok).toBe(true);
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(false);
  });
  it("get_attention_item for et løst/ukjent situation_id gir null-lignende avslag (attention_item_not_found), aldri en stale kopi", async () => {
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_attention_item", parameters: { situation_id: "sit-does-not-exist" } });
    expect(result.ok).toBe(false);
  });
});

describe("F: get_attention_item viser full begrunnelse + underliggende situation - uten et separat oppslag", () => {
  it("inneholder explanation, recommended_next_action OG selve kilde-situation-raden", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9, reason: "Uvanlig utgift oppdaget" });
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_attention_item", parameters: { situation_id: s.situation_id } });
    if (!result.ok) throw new Error("unexpected_denial");
    const item = result.data as unknown as { explanation: string[]; recommended_next_action: string; situation: { situation_id: string; reason: string } };
    expect(item.explanation.length).toBeGreaterThan(0);
    expect(item.recommended_next_action.length).toBeGreaterThan(0);
    expect(item.situation.situation_id).toBe(s.situation_id);
    expect(item.situation.reason).toBe("Uvanlig utgift oppdaget");
  });
});

describe("G: get_control_surface_status (K1, D-164; utvidet D-174) - komponerer owner_controls.get_control_state, situations.get_pause_state OG finance.get_kill_switch, ALDRI en egen fjerde kilde", () => {
  async function getStatusViaExecutive(identity: IdentityContext): Promise<ControlSurfaceStatus> {
    const result = await gateway.execute({ identity, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
    if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
    return result.data as unknown as ControlSurfaceStatus;
  }

  it("baseline: kill switch inaktiv, ingen frys/tilbakekall, ingen pausede domener, finans-nødbryter aldri konfigurert (null)", async () => {
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(false);
    expect(status.owner_control.frozen_connectors).toEqual([]);
    expect(status.owner_control.revoked_credentials).toEqual([]);
    expect(status.finance_kill_switch).toBeNull();
    expect(status.situation_domain_pauses.paused).toEqual([]);
  });

  it("D-174: finans-nødbryteren aktivert/deaktivert VIA executive.*_finance_kill_switch gjenspeiles i finance_kill_switch, UAVHENGIG av den globale owner_control.kill_switch", async () => {
    const enabled = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "enable_finance_kill_switch", parameters: { reason: "test-g-finance" } });
    expect(enabled.ok).toBe(true);
    const afterEnable = await getStatusViaExecutive(ownerA);
    expect(afterEnable.finance_kill_switch?.enabled).toBe(true);
    expect(afterEnable.finance_kill_switch?.reason).toBe("test-g-finance");
    expect(afterEnable.owner_control.kill_switch.active).toBe(false); // uendret, distinkt lag
    const disabled = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "disable_finance_kill_switch", parameters: {} });
    expect(disabled.ok).toBe(true);
    const afterDisable = await getStatusViaExecutive(ownerA);
    expect(afterDisable.finance_kill_switch?.enabled).toBe(false);
  });

  it("aktivert kill switch (via owner_controls.activate_kill_switch) gjenspeiles i owner_control.kill_switch, med reason/actor", async () => {
    const activated = await gateway.execute({
      identity: ownerA, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "test-k1-g" }
    });
    expect(activated.ok).toBe(true);
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(true);
    expect(status.owner_control.kill_switch.reason).toBe("test-k1-g");
    // `actor_person_id` er KUN spor-bart via det VARIGE (pool-baserte) laget - denne poolless
    // test-instansen speiler bevisst KUN in-memory tilstand (se KillSwitch.currentStateDurable()
    // sitt filhode) - null her er FORVENTET, ikke en regresjon. Selve actor-sporingen for den
    // EKTE, durable instansen er dekket av @jarvis/policy sine egne kill-switch-tester.
    expect(status.owner_control.kill_switch.actor_person_id).toBeNull();
    const deactivated = await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true);
  });

  it("frosset connector OG tilbakekalt credential vises SAMTIDIG i owner_control, uavhengig av kill switch-tilstand", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "github", reason: "g-test" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-g-test", reason: "g-test" } });
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(false);
    expect(status.owner_control.frozen_connectors.map((c) => c.connector_id)).toContain("github");
    expect(status.owner_control.revoked_credentials.map((c) => c.credential_ref)).toContain("cred-g-test");
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "github" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: "cred-g-test" } });
  });

  it("situations-domenepause (UA-10) OG global owner_control forblir DISTINKTE lag i samme, ETT samlede svar - ingen krysskorrupsjon", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "situations", action: "pause_domain", parameters: { domain: "spend", reason: "g-test-pause" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "slack", reason: "g-test" } });
    const status = await getStatusViaExecutive(ownerA);
    expect(status.situation_domain_pauses.paused).toContain("spend");
    expect(status.owner_control.frozen_connectors.map((c) => c.connector_id)).toContain("slack");
    // domenepause og connector-frys er ALDRI samme tilstand - hver kan avsluttes uavhengig av den andre.
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "slack" } });
    const afterUnfreeze = await getStatusViaExecutive(ownerA);
    expect(afterUnfreeze.situation_domain_pauses.paused).toContain("spend"); // pause overlever unrelatert unfreeze
    expect(afterUnfreeze.owner_control.frozen_connectors.map((c) => c.connector_id)).not.toContain("slack");
    await gateway.execute({ identity: ownerA, tool_id: "situations", action: "unpause_domain", parameters: { domain: "spend" } });
  });

  it("D-176 (RETTET, BLOKKER B5): global KillSwitch (samme instans policy.authorize() sjekker) nekter IKKE LENGER get_control_surface_status selv - LYKKES nå (D-176), mens en ORDINÆR handling gjennom SAMME gateway FORTSATT nektes av SAMME kill switch", async () => {
    killSwitch.activate("g-block-test");
    try {
      const status = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
      expect(status.ok).toBe(true); // D-176: FØR rettelsen ble denne AVSLÅTT - se D-175/D-176 i owner-control-store.ts.
      const blocked = await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-block-conn", reason: "skal fortsatt nektes" } });
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.reason).toBe("kill_switch_active"); // beviser at DENNE testens `killSwitch`-instans FORTSATT er den reelle gaten - ingen svekkelse utover det navngitte unntaket.
    } finally {
      killSwitch.deactivate();
    }
  });
});

/**
 * D-174 (B2): en FULLT KOBLET, LOKAL stack (EGEN `killSwitch`/`ownerControls`
 * DELT mellom BÅDE `policy` OG `owner_controls`/`executive`-transportene,
 * `ToolGateway` konstruert MED `controls` som 4. argument) - i MOTSETNING
 * til modulens delte `gateway`/`policy` (som ALDRI fikk `controls` i sin
 * konstruktør, se toppen av filen) og "G"-blokkens BEVISST ISOLERTE,
 * poolless `controlKillSwitch` (som ALDRI er den `policy.authorize()`
 * faktisk sjekker). KUN denne fullt kablede stacken kan bevise at
 * `executive.activate_kill_switch`/`revoke_credential` FAKTISK blokkerer
 * ANDRE handlinger via den ekte `PolicyGateway`/`ToolGateway`-gaten, og at
 * `executive.deactivate_kill_switch`/`restore_credential` FAKTISK gjenoppretter
 * den - se `gateway.ts`/`policy-gateway.ts` sitt "executive"-unntak (D-174).
 */
function freshConnectedExecutiveStack(): {
  gateway: ToolGateway;
  killSwitch: KillSwitch;
  ownerControls: OwnerControls;
} {
  const stackKillSwitch = new KillSwitch(appPool, { owner_person_id: OWNER });
  const stackOwnerControls = new OwnerControls(stackKillSwitch, appPool, { owner_person_id: OWNER });
  const stackPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch: stackKillSwitch,
    controls: stackOwnerControls,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  const stackGateway = new ToolGateway(appPool, stackPolicy, secrets, stackOwnerControls);
  const stackOwnerControlsService = new OwnerControlsService(stackKillSwitch, stackOwnerControls, {
    pool: appPool,
    grants: new SessionGrantService(appPool),
    devices: new DeviceService(appPool),
    authority: { owner_person_id: OWNER }
  });
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(stackOwnerControlsService))) stackGateway.register(tool);
  const stackExecutiveService = new ExecutiveService(stackGateway);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(stackExecutiveService))) stackGateway.register(tool);
  return { gateway: stackGateway, killSwitch: stackKillSwitch, ownerControls: stackOwnerControls };
}

async function seedDeviceGrant(tenantId: string, deviceId: string, personId: string): Promise<void> {
  const sessionId = `sess-exec-device-${deviceId}`;
  await adminPool.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ($1,$2,$3,'phone') ON CONFLICT (device_id) DO NOTHING`, [deviceId, tenantId, personId]);
  await adminPool.query(
    `INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ($1,$2,$3,'api',$4) ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, tenantId, personId, deviceId]
  );
  await adminPool.query(
    `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at)
     VALUES ($1,$2,$3,$4,$5,'business','api','active','test-fingerprint', now() + interval '1 hour')`,
    [`grt-exec-${deviceId}-${Date.now()}`, tenantId, personId, deviceId, sessionId]
  );
}

describe("H: D-174 (B2) - executive.* speiler owner_controls.* sin B1-selvgjenopprettingsevne (D-166), inkl. samtidig deadlock, mot den EKTE, koblede PolicyGateway/ToolGateway-gaten", () => {
  it("1) executive.activate_kill_switch aktiverer DEN SAMME killSwitch policy.authorize() faktisk sjekker - en påfølgende owner_controls.freeze_connector blokkeres reelt (ikke bare i en isolert kopi)", async () => {
    const { gateway: stack, killSwitch: stackKillSwitch } = freshConnectedExecutiveStack();
    try {
      const activated = await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h1-test" } });
      expect(activated.ok).toBe(true);
      expect(await stackKillSwitch.isActiveDurable()).toBe(true);
      const blocked = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h1-conn", reason: "should-be-blocked" } });
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.reason).toBe("kill_switch_active");
    } finally {
      await stackKillSwitch.deactivateDurable(OWNER).catch(() => undefined);
    }
  });

  it("2) executive.deactivate_kill_switch GJENOPPRETTER selv når kill switchen er aktiv - IKKE blokkert av sin EGEN 'executive'-tool_id (D-174-unntaket, uten det ville dette vært et énveis-lås)", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h2-test" } });
    const deactivated = await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true);
    const nowAllowed = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h2-conn", reason: "should-now-work" } });
    expect(nowAllowed.ok).toBe(true);
  });

  it("3) executive.restore_credential GJENOPPRETTER selv når den delte BUSINESS_INTERNAL_CREDENTIAL_REF er tilbakekalt (ToolGateway sitt eget unntak) - blokkert FØR fiksen ville vært et énveis-lås", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    const revoked = await stack.execute({ identity: ownerA, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "h3-test" } });
    expect(revoked.ok).toBe(true);
    const blocked = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h3-conn", reason: "should-be-blocked" } });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("credential_revoked");
    const restored = await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
    expect(restored.ok).toBe(true);
    const nowAllowed = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h3-conn", reason: "should-now-work" } });
    expect(nowAllowed.ok).toBe(true);
  });

  it("4a) SAMTIDIG deadlock (kill switch aktiv OG delt credential tilbakekalt), rekkefølge A: restore_credential FØR deactivate_kill_switch - BEGGE via executive.*, FULLSTENDIG gjenopprettet", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h4a-test" } });
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "h4a-test" } });
    const restoreFirst = await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
    expect(restoreFirst.ok).toBe(true);
    const deactivateSecond = await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivateSecond.ok).toBe(true);
    const nowAllowed = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h4a-conn", reason: "recovered" } });
    expect(nowAllowed.ok).toBe(true);
  });

  it("4b) SAMME samtidige deadlock, MOTSATT rekkefølge B: deactivate_kill_switch FØR restore_credential - beviser BEGGE ordninger er deterministisk mulige via executive.*", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h4b-test" } });
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "h4b-test" } });
    const deactivateFirst = await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivateFirst.ok).toBe(true);
    const restoreSecond = await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
    expect(restoreSecond.ok).toBe(true);
    const nowAllowed = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h4b-conn", reason: "recovered" } });
    expect(nowAllowed.ok).toBe(true);
  });

  it("5) NEGATIV KONTROLL: executive.freeze_connector/revoke_credential/activate_kill_switch (IKKE de tre navngitte gjenopprettingshandlingene) forblir BLOKKERT mens kill switchen er aktiv - unntaket er ALDRI bredere enn de tre navngitte handlingene, selv fra executive.*", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h5-test" } });
    try {
      const freeze = await stack.execute({ identity: ownerA, tool_id: "executive", action: "freeze_connector", parameters: { connector_id: "h5-conn", reason: "should-stay-blocked" } });
      expect(freeze.ok).toBe(false);
      expect(!freeze.ok && freeze.reason).toBe("kill_switch_active");
      const revoke = await stack.execute({ identity: ownerA, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: "some-other-ref", reason: "should-stay-blocked" } });
      expect(revoke.ok).toBe(false);
      expect(!revoke.ok && revoke.reason).toBe("kill_switch_active");
    } finally {
      await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    }
  });

  it("6) IKKE-eier identitet kan IKKE utnytte D-174-unntaket: executive.deactivate_kill_switch nektes for en ikke-eier ('class_d_missing_approval', klasse D uendret - kun kill-switch-aktiv-DENY-en er unntatt, ALDRI klasse-D-godkjenningskravet) selv om unntaket fjernet den TIDLIGE kill-switch-aktiv-DENY-en - identitet videresendes UENDRET, ALDRI eskalert", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "h6-test" } });
    try {
      const result = await stack.execute({ identity: otherA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("class_d_missing_approval");
    } finally {
      await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    }
  });

  it("7) executive.revoke_device er et TYNT gjennomslag til owner_controls.revoke_device - MÅL-TENANTEN kommer FRA identity.tenant_id (D-175, IKKE et kaller-oppgitt parameter - skjemaet har ingen tenant_id-felt), identitet bevart, EKTE session_grants-rad faktisk revokert (ikke en parallell tilstand)", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    const deviceId = "device-h7-executive-passthrough";
    await seedDeviceGrant(TENANT_A, deviceId, OWNER);
    const result = await stack.execute({
      identity: ownerA, tool_id: "executive", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "h7-lost-device" }
    });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; data?: unknown }).data).toEqual({ tenant_id: TENANT_A, device_id: deviceId, revoked_grants: 1 });
    const { rows } = await adminPool.query(`SELECT revoked_at FROM session_grants WHERE tenant_id = $1 AND device_id = $2`, [TENANT_A, deviceId]);
    expect((rows[0] as { revoked_at: string | null }).revoked_at).not.toBeNull();
  });

  it("7b) D-175 (BLOKKER B4): executive.revoke_device kan IKKE målrette en ANNEN tenant enn identity.tenant_id - en enhet som KUN finnes i TENANT_B feiler LUKKET når kalleren er ownerA (TENANT_A), OGSÅ via executive.*", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    const deviceId = "device-h7b-wrong-tenant";
    await seedDeviceGrant(TENANT_B, deviceId, OWNER);
    const result = await stack.execute({
      identity: ownerA, tool_id: "executive", action: "revoke_device",
      parameters: { device_id: deviceId, reason: "h7b-cross-tenant-attempt" }
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/device_not_found/);
    const { rows } = await adminPool.query(`SELECT revoked_at FROM session_grants WHERE tenant_id = $1 AND device_id = $2`, [TENANT_B, deviceId]);
    expect((rows[0] as { revoked_at: string | null }).revoked_at).toBeNull(); // urørt
  });

  it("8) executive.enable_finance_kill_switch/disable_finance_kill_switch/get_finance_kill_switch videresender identity.tenant_id/identity.person_id UENDRET (D-68) - ALDRI et kaller-oppgitt parameter", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    const finance = new FinanceService(appPool);
    for (const tool of firstWaveTools({ finance: new FinanceTransport(finance, { getCredentials: async () => null }) })) stack.register(tool);
    const enabled = await stack.execute({ identity: ownerA, tool_id: "executive", action: "enable_finance_kill_switch", parameters: { reason: "h8-test" } });
    expect(enabled.ok).toBe(true);
    const state = await finance.getKillSwitch(TENANT_A);
    expect(state?.enabled).toBe(true);
    expect(state?.enabled_by_person_id).toBe(OWNER); // identity.person_id, ALDRI et parameter kalleren selv kunne ha oppgitt
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "disable_finance_kill_switch", parameters: {} });
    expect((await finance.getKillSwitch(TENANT_A))?.enabled).toBe(false);
  });
});

/**
 * D-176 (arkitekt-review 5251073737, BLOKKER B5): registrerer `situations.*`/
 * `finance.*` på en GITT, allerede fullt koblet `freshConnectedExecutiveStack()`
 * (SAMME mønster som "H"-blokkens test 8 for finance, nå OGSÅ situations) -
 * NØDVENDIG for at `executive.get_control_surface_status` sine TO nøstede
 * lesekall (`situations.get_pause_state`/`finance.get_kill_switch`) faktisk
 * kan LYKKES under lås (se D-176 i owner-control-store.ts for hvorfor DISSE
 * to også måtte inn i selvgjenopprettings-unntaket, ikke bare den ytre
 * `executive`/`owner_controls`-stien).
 */
function withReadComposition(stack: ToolGateway): { finance: FinanceService } {
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) stack.register(tool);
  const finance = new FinanceService(appPool);
  for (const tool of firstWaveTools({ finance: new FinanceTransport(finance, { getCredentials: async () => null }) })) stack.register(tool);
  return { finance };
}

async function getStatusOrThrow(stack: ToolGateway, identity: IdentityContext): Promise<ControlSurfaceStatus> {
  const result = await stack.execute({ identity, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
  if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
  return result.data as unknown as ControlSurfaceStatus;
}

describe("I: D-176 (arkitekt-review 5251073737, BLOKKER B5) - executive.get_control_surface_status MÅ overleve BÅDE kill-switch-aktiv OG delt-credential-tilbakekalt gaten (inkl. de nøstede situations-/finance-lesingene den komponerer), UTEN å utvide unntaket til NOEN mutasjon eller annen lesing", () => {
  it("A) kill switch AKTIV: get_control_surface_status LYKKES og rapporterer kill_switch.active=true (EKTE, pool-baktdata - ikke en isolert kopi); en ORDINÆR handling (freeze_connector) forblir NEKTET ('kill_switch_active')", async () => {
    const { gateway: stack, killSwitch: stackKillSwitch } = freshConnectedExecutiveStack();
    withReadComposition(stack);
    try {
      const activated = await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "i-a-test" } });
      expect(activated.ok).toBe(true);
      const status = await getStatusOrThrow(stack, ownerA);
      expect(status.owner_control.kill_switch.active).toBe(true);
      expect(status.owner_control.kill_switch.reason).toBe("i-a-test");
      const blocked = await stack.execute({ identity: ownerA, tool_id: "executive", action: "freeze_connector", parameters: { connector_id: "i-a-conn", reason: "skal fortsatt nektes" } });
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.reason).toBe("kill_switch_active");
    } finally {
      await stackKillSwitch.deactivateDurable(OWNER).catch(() => undefined);
    }
  });

  it("B) delt BUSINESS_INTERNAL_CREDENTIAL_REF TILBAKEKALT: get_control_surface_status LYKKES og viser refen i revoked_credentials; en ORDINÆR handling forblir NEKTET ('credential_revoked')", async () => {
    const { gateway: stack } = freshConnectedExecutiveStack();
    withReadComposition(stack);
    const revoked = await stack.execute({ identity: ownerA, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: "i-b-test" } });
    expect(revoked.ok).toBe(true);
    const status = await getStatusOrThrow(stack, ownerA);
    expect(status.owner_control.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);
    const blocked = await stack.execute({ identity: ownerA, tool_id: "executive", action: "freeze_connector", parameters: { connector_id: "i-b-conn", reason: "skal fortsatt nektes" } });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("credential_revoked");
    await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
  });

  it("C) BEGGE samtidig (kill switch aktiv OG delt credential tilbakekalt): get_control_surface_status LYKKES og rapporterer BEGGE tilstandene sannferdig; full gjenoppretting via executive.* gjenoppretter normal drift", async () => {
    const { gateway: stack, killSwitch: stackKillSwitch, ownerControls: stackOwnerControls } = freshConnectedExecutiveStack();
    withReadComposition(stack);
    try {
      // BEGGE tilstandene må settes DIREKTE via det durable laget (SAMME mønster som
      // owner-control-authority.test.ts sine "3a"/"3b" B1-deadlock-tester) - `activate_kill_switch`
      // OG `revoke_credential` deler BEGGE `BUSINESS_INTERNAL_CREDENTIAL_REF`/kill-switch-gaten med
      // HVERANDRE (ingen av dem er i selvgjenopprettings-unntaket), så INGEN rekkefølge av
      // sekvensielle `executive.*`-kall kan faktisk OPPNÅ begge tilstandene samtidig - det er
      // nettopp DET som gjør "samtidig deadlock" til et reelt scenario å bevise gjenoppretting fra.
      await stackKillSwitch.activateDurable("i-c-test", OWNER);
      await stackOwnerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "i-c-test", OWNER);
      const lockedStatus = await getStatusOrThrow(stack, ownerA);
      expect(lockedStatus.owner_control.kill_switch.active).toBe(true);
      expect(lockedStatus.owner_control.revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);
      const restored = await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      expect(restored.ok).toBe(true);
      const deactivated = await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      expect(deactivated.ok).toBe(true);
      const nowAllowed = await stack.execute({ identity: ownerA, tool_id: "executive", action: "freeze_connector", parameters: { connector_id: "i-c-conn", reason: "recovered" } });
      expect(nowAllowed.ok).toBe(true);
      const clearStatus = await getStatusOrThrow(stack, ownerA);
      expect(clearStatus.owner_control.kill_switch.active).toBe(false);
      expect(clearStatus.owner_control.revoked_credentials.map((c) => c.credential_ref)).not.toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);
    } finally {
      await stackKillSwitch.deactivateDurable(OWNER).catch(() => undefined);
    }
  });

  it("D) direkte owner_controls.get_control_state er UENDRET av D-176 - fungerer identisk under BEGGE lås-tilstandene, som FØR denne fiksen", async () => {
    const { gateway: stack, killSwitch: stackKillSwitch, ownerControls: stackOwnerControls } = freshConnectedExecutiveStack();
    withReadComposition(stack);
    try {
      // BEGGE tilstandene direkte via det durable laget - se kommentaren i test C for hvorfor
      // INGEN sekvens av executive.*-kall kan oppnå dette (activate_kill_switch bruker SELV den
      // delte refen, og revoke_credential er selv IKKE unntatt kill-switch-sjekken).
      await stackKillSwitch.activateDurable("i-d-test", OWNER);
      await stackOwnerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, "i-d-test", OWNER);
      const direct = await stack.execute({ identity: ownerA, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
      expect(direct.ok).toBe(true);
      expect(direct.ok && (direct.data as unknown as { revoked_credentials: Array<{ credential_ref: string }> }).revoked_credentials.map((c) => c.credential_ref)).toContain(BUSINESS_INTERNAL_CREDENTIAL_REF);
      await stack.execute({ identity: ownerA, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
    } finally {
      await stack.execute({ identity: ownerA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
    }
  });

  it("E) IKKE-eier kan LESE get_control_surface_status (klasse A, uendret fra FØR D-176 - INGEN ny eier-sjekk innført), men kan FORTSATT IKKE utnytte gjenopprettings-mutasjonene (samme mandat-disiplin som H6)", async () => {
    const { gateway: stack, killSwitch: stackKillSwitch } = freshConnectedExecutiveStack();
    withReadComposition(stack);
    try {
      await stack.execute({ identity: ownerA, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: "i-e-test" } });
      const readAsOther = await stack.execute({ identity: otherA, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
      expect(readAsOther.ok).toBe(true); // klasse A - uendret, ALDRI en ny eier-sjekk for lesing
      const deactivateAsOther = await stack.execute({ identity: otherA, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      expect(deactivateAsOther.ok).toBe(false);
      expect(!deactivateAsOther.ok && deactivateAsOther.reason).toBe("class_d_missing_approval");
    } finally {
      await stackKillSwitch.deactivateDurable(OWNER).catch(() => undefined);
    }
  });
});
