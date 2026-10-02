import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, ContextBuilder, DeviceService, IdentityService, MessageStore, SessionGrantService, SessionService,
  createPool, runMigrations, withTenantTransaction
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DeploymentService, IncidentService } from "@jarvis/incidents";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { FORBIDDEN_IDENTITY_BODY_KEYS } from "../src/http-guard.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";

/**
 * Remediering del 2 (JARVIS-001/008/063/064/050/055) - HTTP-ATFERDSTESTER for kontrollflaten mot ekte Postgres:
 *  uautentisert -> 401, bogus/ukjent grant -> 403, identitetsfelt i body -> 400, revokert enhet -> 403 på ALLE
 *  rutefamilier, fremmed tenant -> ingen tilgang, samtidig autorisasjon -> én aktiv sesjon, kroppsgrense/malformed
 *  JSON/generiske feil, rate limits, ingen legacy challenge/verify og ingen dev-ruter.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let devices: DeviceService;
const TENANT_A = "tenant-cp-a";
const TENANT_B = "tenant-cp-b";

const keys: Record<string, TestDeviceKey> = { "cp-dev-a": generateDeviceKey(), "cp-dev-a2": generateDeviceKey(), "cp-dev-b": generateDeviceKey(), "cp-dev-race": generateDeviceKey() };
const SUBJECT_A = { device_id: "cp-dev-a", person_id: "person-cp-a", tenant_id: TENANT_A, memory_space: "business" } as const;
const SUBJECT_A2 = { device_id: "cp-dev-a2", person_id: "person-cp-a", tenant_id: TENANT_A, memory_space: "business" } as const;
const SUBJECT_B = { device_id: "cp-dev-b", person_id: "person-cp-b", tenant_id: TENANT_B, memory_space: "business" } as const;

/** Alle grant-beskyttede kontrollruter (tasks/incidents/infra/observability/deployments) + chat. Minimal gyldig body (uten identitet). */
const CONTROL_ROUTES: Array<{ path: string; body: Record<string, unknown> }> = [
  { path: "/tasks/submit", body: { contract: {} } },
  { path: "/chat", body: { message: "hei" } },
  { path: "/incidents/create", body: { title: "x" } },
  { path: "/incidents/get", body: { incident_id: "x" } },
  { path: "/incidents/list", body: {} },
  { path: "/incidents/evidence/add", body: { incident_id: "x", source_type: "note", summary: "s" } },
  { path: "/incidents/correlate", body: { incident_id: "x", repo: "a/b" } },
  { path: "/incidents/correlate/db", body: { window_start: "2026-01-01T00:00:00Z", window_end: "2026-01-02T00:00:00Z" } },
  { path: "/incidents/evidence/acquire_logs", body: { incident_id: "x" } },
  { path: "/incidents/repair", body: { incident_id: "x", repo_url: "https://github.com/a/b", goal: "g" } },
  { path: "/deployments/ingest/github", body: { repo: "a/b", workflow_run_id: "1" } },
  { path: "/infra/execution/mutate", body: { target: "c", action: "stop_container", idempotency_key: "k" } },
  { path: "/infra/execution/get", body: { execution_id: "x" } },
  { path: "/infra/recovery/attempt", body: { tool_id: "docker", action: "restart_container", idempotency_key: "k" } },
  { path: "/infra/pause", body: {} },
  { path: "/infra/resume", body: {} },
  { path: "/infra/degrade", body: {} },
  { path: "/infra/status", body: {} },
  { path: "/observability/docker/status", body: {} }
];

async function post(path: string, body: unknown, init: { raw?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.raw ?? JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { __raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-r2cp-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_cp LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_cp");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','CpA','business'), ('${TENANT_B}','CpB','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-cp-a','A'), ('person-cp-b','B');
    INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('person-cp-a','${TENANT_A}','owner'), ('person-cp-b','${TENANT_B}','owner');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-cp-a','${TENANT_A}','business'), ('sp-cp-b','${TENANT_B}','business');`);
  for (const [id, tenant, person] of [["cp-dev-a", TENANT_A, "person-cp-a"], ["cp-dev-a2", TENANT_A, "person-cp-a"], ["cp-dev-b", TENANT_B, "person-cp-b"], ["cp-dev-race", TENANT_A, "person-cp-a"]] as const) {
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [id, tenant, person, keys[id]!.publicKeyPem]);
  }
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_cp", password: "pw2" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraGate: new InfraExecutionGate(),
    infraToolIds: new Set(["docker"]), authority: { owner_person_id: "person-cp-a", owner_tenants: [TENANT_A] }
  });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
  const gateway = new ToolGateway(appPool, policy, secrets);
  const incidentService = new IncidentService(appPool);
  const queue = new PgTaskQueue(appPool);
  const taskService = new TaskService(appPool, queue, policy);
  const worker = new InProcessWorker(queue, 60);
  const modelGateway = new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "ok")] });
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  devices = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  server = createApiServer({
    identity: identityService, sessions: sessionService, devices, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: appPool, devices, sessions: sessionService, identity: identityService, grants: grantService }),
    policy, worker, tasks: taskService,
    conversation: new ConversationEngine({ messages: new MessageStore(appPool), context: new ContextBuilder(appPool), gateway: modelGateway, tasks: taskService, worker, trace: new MemoryTraceSink() }),
    incidents: { service: incidentService, deployments: new DeploymentService(appPool), gateway, infraGate: new InfraExecutionGate(), pool: appPool },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => { server?.closeAllConnections(); server?.close(() => resolve()); });
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: uautentisert og bogus grant på ALLE kontrollflater", () => {
  it.each(CONTROL_ROUTES.map((r) => [r.path, r]))("%s: uten grant_token -> 401 grant_required (ingen domeneoperasjon)", async (_p, route) => {
    for (const body of [route.body, { ...route.body, grant_token: "" }, { ...route.body, grant_token: 42 }]) {
      const r = await post(route.path, body);
      expect(r.status, JSON.stringify(body)).toBe(401);
      expect(r.body["error"]).toBe("grant_required");
      expect(typeof r.body["request_id"]).toBe("string");
    }
  });
  it.each(CONTROL_ROUTES.map((r) => [r.path, r]))("%s: bogus/ikke-utstedt grant -> 403 identity_denied", async (_p, route) => {
    for (const token of ["grt_bogus", "x".repeat(300), "' OR 1=1 --", "grt_" + "0".repeat(64)]) {
      const r = await post(route.path, { ...route.body, grant_token: token });
      expect(r.status, token).toBe(403);
      expect(r.body["error"]).toBe("identity_denied");
    }
  });
  it("GET /chat-API-nær: ingen kontrollrute svarer på GET (kun POST)", async () => {
    for (const route of CONTROL_ROUTES.filter((r) => r.path !== "/chat")) {
      const res = await fetch(`${baseUrl}${route.path}`);
      expect([404, 405], route.path).toContain(res.status);
    }
  });
});

describe("B: identitetsfelt i body avvises (ingen tillitsskapende klientfelt)", () => {
  it("hvert forbudt felt gir 400 identity_field_forbidden på hver rutefamilie - selv med et gyldig grant", async () => {
    const grant = await mintGrant(baseUrl, SUBJECT_A, keys["cp-dev-a"]!);
    for (const route of CONTROL_ROUTES) {
      for (const field of FORBIDDEN_IDENTITY_BODY_KEYS) {
        const r = await post(route.path, { ...route.body, grant_token: grant, [field]: "person-cp-b" });
        expect(r.status, `${route.path} ${field}`).toBe(400);
        expect(r.body["error"], `${route.path} ${field}`).toBe("identity_field_forbidden");
        expect(r.body["field"]).toBe(field);
      }
    }
  });
  it("også uten grant: et identitetsfelt gir 400 (aldri en stille ignorering eller 200)", async () => {
    const r = await post("/incidents/list", { tenant_id: TENANT_B });
    expect(r.status).toBe(400);
  });
  it("ukjente felt avvises (hviteliste per rute)", async () => {
    const grant = await mintGrant(baseUrl, SUBJECT_A, keys["cp-dev-a"]!);
    const r = await post("/incidents/list", { grant_token: grant, sneaky: true });
    expect(r.status).toBe(400);
    expect(r.body["reason"]).toBe("unknown_field");
  });
  it("identiteten utledes fra grantet: en hendelse opprettet med A-grant tilhører A og er usynlig for B", async () => {
    const grantA = await mintGrant(baseUrl, SUBJECT_A, keys["cp-dev-a"]!);
    const grantB = await mintGrant(baseUrl, SUBJECT_B, keys["cp-dev-b"]!);
    const created = await post("/incidents/create", { grant_token: grantA, title: "tenant-A-hendelse" });
    expect(created.status).toBe(200);
    const incidentId = ((created.body["incident"] ?? created.body) as Record<string, unknown>)["incident_id"] as string;
    expect(incidentId).toBeTruthy();
    const asB = await post("/incidents/get", { grant_token: grantB, incident_id: incidentId });
    expect(asB.status).toBe(404);
    const listB = await post("/incidents/list", { grant_token: grantB });
    expect(JSON.stringify(listB.body)).not.toContain(incidentId);
    const asA = await post("/incidents/get", { grant_token: grantA, incident_id: incidentId });
    expect(asA.status).toBe(200);
    const row = await adminPool.query("SELECT tenant_id FROM incidents WHERE incident_id = $1", [incidentId]);
    expect(row.rows[0].tenant_id).toBe(TENANT_A);
  });
});

describe("C: revokert/ukjent enhet og feil bevis (JARVIS-050)", () => {
  it("en revokert enhet mister ALLE grants umiddelbart: 403 på hver rutefamilie, og kan ikke re-autorisere", async () => {
    const grant = await mintGrant(baseUrl, SUBJECT_A2, keys["cp-dev-a2"]!);
    // grantet virker før revokering
    expect((await post("/incidents/list", { grant_token: grant })).status).toBe(200);
    await withTenantTransaction(appPool, TENANT_A, (client) =>
      devices.revokeDeviceKeyOn(client, { tenant_id: TENANT_A, device_id: "cp-dev-a2" }, "stolen")
    );
    for (const route of CONTROL_ROUTES) {
      const r = await post(route.path, { ...route.body, grant_token: grant });
      expect(r.status, route.path).toBe(403);
      expect(r.body["error"]).toBe("identity_denied");
    }
    // ny autorisasjon med den samme (nå revokerte) nøkkelen nektes
    await expect(mintGrant(baseUrl, SUBJECT_A2, keys["cp-dev-a2"]!)).rejects.toThrow(/mintGrant_(failed|challenge_failed):(401|403)/);
  });

  it("ukjent enhet, feil nøkkel og gjenbrukt/forfalsket challenge gir ingen grant", async () => {
    // ukjent enhet
    const unknown = await post("/devices/challenge", { device_id: "cp-dev-ukjent" });
    const challenge = unknown.body["challenge"] as string | undefined;
    if (typeof challenge === "string") {
      const other = generateKeyPairSync("ed25519");
      const signature = sign(null, Buffer.from(challenge, "utf8"), other.privateKey).toString("base64");
      const r = await post("/session/authorize", { channel: "api", person_id: "person-cp-a", tenant_id: TENANT_A, device_id: "cp-dev-ukjent", memory_space: "business", device_proof: { challenge, signature } });
      expect(r.status).toBe(403);
      expect(r.body["grant"]).toBeUndefined();
    } else {
      expect([400, 403, 404]).toContain(unknown.status);
    }
    // kjent enhet, FEIL privatnøkkel
    const issued = await post("/devices/challenge", { device_id: "cp-dev-a" });
    const ch = issued.body["challenge"] as string;
    const wrong = generateKeyPairSync("ed25519");
    const badSig = sign(null, Buffer.from(ch, "utf8"), wrong.privateKey).toString("base64");
    const bad = await post("/session/authorize", { channel: "api", person_id: "person-cp-a", tenant_id: TENANT_A, device_id: "cp-dev-a", memory_space: "business", device_proof: { challenge: ch, signature: badSig } });
    expect(bad.status).toBe(403);
    expect(bad.body["grant"]).toBeUndefined();
    // gjenbruk av en allerede brukt challenge (engangs)
    const good = sign(null, Buffer.from(ch, "utf8"), keys["cp-dev-a"]!.privateKey).toString("base64");
    const replay = await post("/session/authorize", { channel: "api", person_id: "person-cp-a", tenant_id: TENANT_A, device_id: "cp-dev-a", memory_space: "business", device_proof: { challenge: ch, signature: good } });
    // (den feilende forsøket kan ha forbrukt challengen - uansett utfall: ikke en SECOND grant for samme challenge)
    const replay2 = await post("/session/authorize", { channel: "api", person_id: "person-cp-a", tenant_id: TENANT_A, device_id: "cp-dev-a", memory_space: "business", device_proof: { challenge: ch, signature: good } });
    expect(replay2.status).toBe(403);
    expect([200, 403]).toContain(replay.status);
  });

  it("feil person/tenant for enheten (spoofing av medlemskap) gir 403", async () => {
    const issued = await post("/devices/challenge", { device_id: "cp-dev-a" });
    const ch = issued.body["challenge"] as string;
    const signature = sign(null, Buffer.from(ch, "utf8"), keys["cp-dev-a"]!.privateKey).toString("base64");
    const r = await post("/session/authorize", { channel: "api", person_id: "person-cp-b", tenant_id: TENANT_B, device_id: "cp-dev-a", memory_space: "business", device_proof: { challenge: ch, signature } });
    expect(r.status).toBe(403);
    expect(r.body["grant"]).toBeUndefined();
  });
});

describe("D: samtidig autorisasjon (JARVIS-055) - én aktiv sesjon per (tenant, person)", () => {
  it("20 parallelle /session/authorize for samme person gir nøyaktig én aktiv sesjon og samme session_id", async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, async () => {
      const issued = await post("/devices/challenge", { device_id: "cp-dev-race" });
      const ch = issued.body["challenge"] as string;
      const signature = sign(null, Buffer.from(ch, "utf8"), keys["cp-dev-race"]!.privateKey).toString("base64");
      return post("/session/authorize", { channel: "api", person_id: "person-cp-a", tenant_id: TENANT_A, device_id: "cp-dev-race", memory_space: "business", device_proof: { challenge: ch, signature } });
    }));
    const ok = attempts.filter((a) => a.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    const sessionIds = new Set(ok.map((a) => a.body["session_id"] as string));
    expect(sessionIds.size).toBe(1);
    const rows = await adminPool.query("SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT_A, "person-cp-a"]);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("E: kropp, feil og legacy-flater (JARVIS-063/064)", () => {
  it("for stor kropp -> 413, malformert JSON -> 400, begge med request_id og uten intern tekst", async () => {
    const big = await post("/incidents/list", {}, { raw: JSON.stringify({ grant_token: "x", pad: "a".repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
    expect(typeof big.body["request_id"]).toBe("string");
    for (const path of ["/incidents/list", "/tasks/submit", "/chat", "/devices/challenge"]) {
      const bad = await post(path, {}, { raw: "{not json" });
      expect(bad.status, path).toBe(400);
      expect(bad.body["error"], path).toBe("malformed_json");
      expect(JSON.stringify(bad.body)).not.toMatch(/SyntaxError|Unexpected token|at \w+ \(|node_modules|pg_|relation "/);
    }
    // Autentiseringsrutene har et dokumentert, deterministisk 403 på malformert JSON (skiller aldri «parser» fra «bevis»).
    for (const path of ["/session/authorize"]) {
      const bad = await post(path, {}, { raw: "{not json" });
      expect(bad.status, path).toBe(403);
      expect(JSON.stringify(bad.body)).not.toMatch(/SyntaxError|Unexpected token|node_modules|pg_|relation "/);
    }
  });
  it("hver respons har x-request-id; feil gir generisk kode + request_id, aldri pg-/stack-tekst", async () => {
    const grant = await mintGrant(baseUrl, SUBJECT_A, keys["cp-dev-a"]!);
    const r = await post("/incidents/get", { grant_token: grant, incident_id: "finnes-ikke" });
    expect(r.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/relation|violates|constraint|pg|stack|node_modules/i);
  });
  it("legacy /devices/challenge/verify finnes ikke (404) - ingen alternativ identitetsvei", async () => {
    for (const method of ["POST", "GET"]) {
      const res = await fetch(`${baseUrl}/devices/challenge/verify`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(404);
    }
  });
  it("dev-/demo-rutene er av: /worker/tick og /tools/critical-demo gir 404 (uautentisert kødrenering/klasse D-stub finnes ikke)", async () => {
    for (const path of ["/worker/tick", "/tools/critical-demo"]) {
      const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status, path).toBe(404);
    }
  });
  it("/devices/challenge validerer device_id (ugyldig/ikke-streng/for lang -> 400), og ukjent rute gir generisk 404", async () => {
    for (const body of [{}, { device_id: 5 }, { device_id: "x".repeat(500) }, { device_id: "../etc" }]) {
      const r = await post("/devices/challenge", body);
      expect([400], JSON.stringify(body)).toContain(r.status);
    }
    const nf = await fetch(`${baseUrl}/finnes/ikke`);
    expect(nf.status).toBe(404);
  });
});

describe("F: rate limits (per-IP, auth-ruter og per-enhet)", () => {
  async function limitedServer(rateLimits: Record<string, number>) {
    const s = createApiServer({ rateLimits } as never);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }) };
  }
  it("per-IP: overskridelse gir 429 med retry-after og request_id", async () => {
    const s = await limitedServer({ perIpPerMinute: 5, authPerIpPerMinute: 100, perDevicePerMinute: 100 });
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 12; i++) { last = await fetch(`${s.url}/health`); statuses.push(last.status); }
      expect(statuses.filter((x) => x === 429).length).toBeGreaterThan(0);
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(last?.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(((await last!.json()) as Record<string, unknown>)["error"]).toBe("rate_limited");
    } finally { await s.close(); }
  });
  it("auth-ruter har egen, strengere grense per IP+rute", async () => {
    const s = await limitedServer({ perIpPerMinute: 1000, authPerIpPerMinute: 3, perDevicePerMinute: 100 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await fetch(`${s.url}/devices/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(4);
      // andre ruter påvirkes ikke av auth-budsjettet
      expect((await fetch(`${s.url}/health`)).status).toBe(200);
    } finally { await s.close(); }
  });
});

describe("G: ulagrede/uautoriserte tilstander etter angrepet", () => {
  it("ingen tasks/incidents ble opprettet av uautentiserte kall", async () => {
    const t = await adminPool.query("SELECT count(*)::int AS n FROM tasks");
    expect(t.rows[0].n).toBe(0);
    const i = await adminPool.query("SELECT count(*)::int AS n FROM incidents WHERE title <> 'tenant-A-hendelse'");
    expect(i.rows[0].n).toBe(0);
  });
});
