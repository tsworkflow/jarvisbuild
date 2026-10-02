import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApproval, type ApprovalPayload, type IdentityContext, type JsonValue, type SignedApproval } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ScriptedAdapter, type ToolCallRequest } from "@jarvis/provider-adapters";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  FakeTransport,
  MeshToolExecutor,
  ToolGateway,
  meshToolDefinitions,
  type MeshToolMapping,
  type SecretProvider
} from "@jarvis/tool-gateway";
import { z } from "zod";

/**
 * BO-11.1 §11 + sovereign-semantikk: provider-uavhengig tool calling kan ALDRI
 * omgå Execution Authority - og D er en RISIKOKLASSE, ikke en generell
 * permission-gate. Begge semantikker bevises mot ekte embedded Postgres:
 *
 *  OWNER SOVEREIGN (person-tobias, owner-tenant, ingen delegation):
 *    D-kall uten approval → authority PASS → full D-pipeline
 *    (preflight → execute → readback → before/after-evidens → audit).
 *  DELEGERT/SCOPED (delegation_id satt - arver ALDRI owner authority):
 *    D-kall uten approval → DENY (null transport-kall);
 *    med gyldig signert approval → ALLOW; nonce-replay → DENY.
 *
 * Kjeden er hele den ekte: ModelGateway.completeWithTools → normalized call →
 * MeshToolExecutor → ToolGateway → Policy Gateway → audit. Ufarlig fake-D-handling.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
const watchKeys = generateKeyPairSync("ed25519");
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;
let dTransport: FakeTransport;

/** Eieren i owner-tenant uten delegation → SOVEREIGN authority (v4.0). */
const ownerIdentity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-a",
  memory_space_id: "personal",
  session_id: "sess-dmesh",
  device_id: "dev-pc",
  channel: "api",
  auth_strength: "active"
};

/** Delegert actor: delegation_id satt → arver ALDRI owner authority → SCOPED. */
const delegateIdentity: IdentityContext = {
  ...ownerIdentity,
  session_id: "sess-dmesh-delegat",
  delegation_id: "dg-test-1"
};

const testSecrets: SecretProvider = {
  name: "test",
  async get() {
    return "secret-that-never-leaks";
  }
};

/** Ufarlig fake D-verktøy MED preflight - beviser hele pipeline uten side-effekter. */
const D_MESH_TOOL: MeshToolMapping = {
  def: {
    name: "critical_demo_action",
    description: "Fake kritisk handling (klasse D) - kun for authority-regresjon.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false
    }
  },
  tool_id: "demo",
  action: "critical_send"
};

function approval(overrides: Partial<Omit<ApprovalPayload, "parameters_hash">> & { parameters?: Record<string, JsonValue> } = {}): SignedApproval {
  return signApproval(watchKeys.privateKey, {
    tool_id: "demo", action: "critical_send", tenant_id: "tenant-a", person_id: "person-tobias",
    approver_person_id: "person-tobias", parameters: { note: "test" },
    nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-1", ...overrides
  });
}

const dCall = (id: string, note = "test"): ToolCallRequest => ({
  tool_call_id: id,
  tool_name: "critical_demo_action",
  arguments: { note },
  provider: "scripted",
  model: "scripted-1"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgdm-"));
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
  // Samme sovereign-owner-konfig som produksjonswiringen (main/worker):
  const policy = new PolicyGateway({
    devices,
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
  dTransport = new FakeTransport((action) =>
    action === "read_state" ? { data: { armed: false } } : { external_id: `crit-${randomUUID().slice(0, 6)}` }
  );
  toolGateway = new ToolGateway(appPool, policy, testSecrets);
  toolGateway.register({
    tool_id: "demo",
    action: "critical_send",
    description: "Fake kritisk handling (klasse D) med preflight/readback",
    input_schema: z.object({ note: z.string() }).strict() as never,
    capability_class: "D",
    scopes: ["demo:critical"],
    reversible: false,
    rollback_procedure: "ikke reverserbar - derfor klasse D",
    idempotent_external: false,
    timeout_ms: 5_000,
    rate_limit_per_minute: 10,
    credential_ref: "JARVIS_DEMO_TOKEN",
    output_trust: "internal",
    transport: dTransport,
    preflight_action: "read_state"
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function fakeModelPool(): pg.Pool {
  const client = {
    query: async (sql: string) =>
      typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

describe("D-class er risikoklasse: klassifisering og trusted pipeline", () => {
  it("klassifisering bevart: D-verktøyet er registrert som klasse D i trusted lag", () => {
    expect(toolGateway.get("demo", "critical_send")?.capability_class).toBe("D");
  });
});

describe("OWNER SOVEREIGN (v4.0): D-kall via mesh UTEN approval → full D-pipeline og utførelse", () => {
  it("owner-authority PASS → preflight → execute → readback → before/after-evidens → audit", async () => {
    const executor = new MeshToolExecutor(toolGateway, ownerIdentity, 4000, [D_MESH_TOOL]);
    const adapter = new ScriptedAdapter(
      () => "kritisk handling utført",
      (req) => (req.tool_exchanges ? [] : [dCall("d-sov", "sovereign-run")])
    );
    const gateway = new ModelGateway({ pool: fakeModelPool(), trace: new MemoryTraceSink(), providers: [adapter] });
    const before = dTransport.calls.length;
    const result = await gateway.completeWithTools(
      {
        tenant_id: "tenant-a",
        session_id: "sess-dmesh",
        request: { messages: [{ role: "user", content: "utfør kritisk handling" }] }
      },
      { tools: meshToolDefinitions([D_MESH_TOOL]), executor }
    );
    // Modellen fikk suksessresultatet og syntetiserte svar:
    expect(result.text).toBe("kritisk handling utført");
    const exchange = adapter.calls.find((r) => r.tool_exchanges)?.tool_exchanges?.[0];
    expect(exchange?.results[0]?.success).toBe(true);
    // Full D-pipeline kjørte: preflight FØR + handlingen + readback ETTER:
    const sequence = dTransport.calls.slice(before).map((c) => c.action);
    expect(sequence).toEqual(["read_state", "critical_send", "read_state"]);
    // Audit m/before/after-evidens og recovery-grunnlag - ingen approval var involvert:
    const audit = await adminPool.query(
      `SELECT payload FROM audit_events WHERE tool_id = 'demo' AND type = 'tool.executed' ORDER BY at DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
    const payload = audit.rows[0]?.payload as { before_state?: unknown; after_state?: unknown };
    expect(payload.before_state).toEqual({ armed: false });
    expect(payload.after_state).toEqual({ armed: false });
  });
});

describe("DELEGERT/SCOPED: approval-gaten består - delegat arver aldri owner authority", () => {
  it("delegat ber om D-handling via mesh UTEN godkjenning → deterministisk DENY, null transport-kall, audit-spor", async () => {
    const executor = new MeshToolExecutor(toolGateway, delegateIdentity, 4000, [D_MESH_TOOL]);
    const adapter = new ScriptedAdapter(
      () => "kunne ikke utføre kritisk handling",
      (req) => (req.tool_exchanges ? [] : [dCall("d-del", "delegate-run")])
    );
    const gateway = new ModelGateway({ pool: fakeModelPool(), trace: new MemoryTraceSink(), providers: [adapter] });
    const before = dTransport.calls.length;
    const result = await gateway.completeWithTools(
      {
        tenant_id: "tenant-a",
        session_id: "sess-dmesh-delegat",
        request: { messages: [{ role: "user", content: "utfør kritisk handling" }] }
      },
      { tools: meshToolDefinitions([D_MESH_TOOL]), executor }
    );
    expect(result.text).toBe("kunne ikke utføre kritisk handling");
    const exchange = adapter.calls.find((r) => r.tool_exchanges)?.tool_exchanges?.[0];
    expect(exchange?.results[0]?.success).toBe(false);
    // INGEN transport-kall - verken preflight eller selve handlingen (§11):
    expect(dTransport.calls.length).toBe(before);
    const audit = await adminPool.query(
      `SELECT type, decision FROM audit_events WHERE tool_id = 'demo' AND type = 'tool.denied' ORDER BY at DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
  });

  it("delegat MED gyldig signert godkjenning → ALLOW m/preflight + readback + audit (samme trusted gateway som mesh bruker)", async () => {
    const before = dTransport.calls.length;
    const result = await toolGateway.execute({
      identity: delegateIdentity,
      tool_id: "demo",
      action: "critical_send",
      parameters: { note: "test" },
      idempotency_key: `idem-${randomUUID().slice(0, 8)}`,
      approval: approval()
    });
    expect(result.ok).toBe(true);
    const newCalls = dTransport.calls.slice(before).map((c) => c.action);
    expect(newCalls).toEqual(["read_state", "critical_send", "read_state"]);
    const audit = await adminPool.query(
      `SELECT payload FROM audit_events WHERE tool_id = 'demo' AND type = 'tool.executed' ORDER BY at DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
  });

  it("replay av samme godkjenning → fortsatt DENY (nonce brent)", async () => {
    const used = approval();
    const first = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "demo", action: "critical_send", parameters: { note: "test" },
      idempotency_key: `idem-${randomUUID().slice(0, 8)}`, approval: used
    });
    expect(first.ok).toBe(true);
    const replay = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "demo", action: "critical_send", parameters: { note: "test" },
      idempotency_key: `idem-${randomUUID().slice(0, 8)}`, approval: used
    });
    expect(replay.ok).toBe(false);
  });
});
