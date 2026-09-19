import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, DeviceEnrollmentService, DeviceService, IdentityService,
  SessionGrantService, SessionService, createPool, runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { createApiServer } from "../src/server.ts";

/**
 * D-199 (UA-11 Executive dashboard-UI, lese-delen): ekte HTTP mot en ekte
 * `createApiServer()`, ekte Postgres, ekte grant-autoritet (SAMME
 * `/session/authorize`-vei som `/chat`/`/brief` - se `d131-authority-
 * hardening-e2e.test.ts`/`session-authority-e2e.test.ts` for den fulle
 * enhetsautentiseringsbevis-suiten, IKKE duplisert her).
 *
 * Denne suiten beviser SELVE `/executive/query`-rutens egne, nye ansvar:
 *   1. Et gyldig grant kan faktisk hente data for begge lese-handlingene,
 *      og `ToolGateway.execute()` mottar den LØSTE identiteten (aldri en
 *      selvutnevnt en fra kroppen).
 *   2. Et ugyldig/manglende grant avvises 403 FØR gateway.execute() kalles.
 *   3. En handling UTENFOR `EXECUTIVE_QUERY_ACTIONS` (f.eks. en
 *      mutasjonshandling som `activate_kill_switch`) avvises 400 - OG
 *      `gateway.execute()` kalles ALDRI. Dette er selve beviset for at
 *      mutasjoner IKKE kan nås via denne ruten (D-199 sitt kjernekrav).
 *
 * `executive.gateway` stubbes bevisst (samme presedens som d131 sin
 * `brief`-stub) - `ExecutiveTransport`/`ToolGateway.execute()`-pipelinen
 * selv er allerede utførlig dekket av `modules/executive`s egne tester.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const TENANT_A = "tenant-d199-a";
const OWNER = "person-d199-owner";
const DEVICE = "dev-d199-web";
const keys = generateKeyPairSync("ed25519");
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

interface ExecuteCall {
  identity: { tenant_id: string; person_id: string; memory_space_id: string };
  tool_id: string;
  action: string;
  parameters: Record<string, unknown>;
}
let executeCalls: ExecuteCall[] = [];
let nextResult: unknown = { ok: true, data: [], output_trust: "trusted", deduplicated: false };

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-d199-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false }),
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d199 LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d199");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'D199 A', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-d199-a', '${TENANT_A}', 'personal');
  `);
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    [DEVICE, TENANT_A, OWNER, "web", pem]
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_d199", password: "test-app-pw" });

  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);

  const stubGateway = {
    execute: async (request: ExecuteCall) => {
      executeCalls.push(request);
      return nextResult;
    }
  } as unknown as ToolGateway;

  server = createApiServer({
    identity: identityService,
    sessions: sessionService,
    devices: deviceService,
    grants: grantService,
    enrollment: new DeviceEnrollmentService({ pool: appPool, devices: deviceService, grants: grantService }),
    channelAuthority: new ChannelSessionAuthority({
      pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService
    }),
    policy: {} as never,
    worker: {} as never,
    conversation: {} as never,
    executive: { gateway: stubGateway }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(() => {
  executeCalls = [];
  nextResult = { ok: true, data: [], output_trust: "trusted", deduplicated: false };
});
afterEach(() => {
  executeCalls = [];
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function validGrant(): Promise<string> {
  const challengeRes = await post("/devices/challenge", { device_id: DEVICE });
  const challenge = challengeRes.body["challenge"] as string;
  const signature = sign(null, Buffer.from(challenge, "utf8"), keys.privateKey).toString("base64");
  const authRes = await post("/session/authorize", {
    channel: "web", person_id: OWNER, tenant_id: TENANT_A, device_id: DEVICE, memory_space: "personal",
    device_proof: { challenge, signature }
  });
  expect(authRes.status, JSON.stringify(authRes.body)).toBe(200);
  return (authRes.body["grant"] as Record<string, unknown>)["grant_token"] as string;
}

describe("A: /executive/query med gyldig grant henter EKTE data for begge lese-handlingene", () => {
  it("get_attention_queue: 200, data videreformidlet, gateway.execute() fikk den LØSTE identiteten (ikke kroppens)", async () => {
    nextResult = { ok: true, data: [{ situation_id: "sit-1", priority: "high" }], output_trust: "trusted", deduplicated: false };
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "get_attention_queue" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["data"]).toEqual([{ situation_id: "sit-1", priority: "high" }]);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.tool_id).toBe("executive");
    expect(executeCalls[0]?.action).toBe("get_attention_queue");
    expect(executeCalls[0]?.identity.tenant_id).toBe(TENANT_A);
    expect(executeCalls[0]?.identity.person_id).toBe(OWNER);
  });

  it("get_control_surface_status: 200, data videreformidlet uendret", async () => {
    const status = { owner_control: { kill_switch: { active: false, reason: null, actor_person_id: null, changed_at: null }, frozen_connectors: [], revoked_credentials: [] }, situation_domain_pauses: { paused: [] }, finance_kill_switch: null };
    nextResult = { ok: true, data: status, output_trust: "trusted", deduplicated: false };
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "get_control_surface_status" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["data"]).toEqual(status);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.action).toBe("get_control_surface_status");
  });

  it("gateway.execute() avslag (ok:false) videreformidles som 403 tool_denied, ikke svelget", async () => {
    nextResult = { ok: false, reason: "policy_denied" };
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "get_attention_queue" });
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("tool_denied");
    expect(res.body["reason"]).toBe("policy_denied");
  });
});

describe("B: /executive/query avviser et ugyldig/manglende grant FØR gateway.execute() kalles", () => {
  it("uten grant_token: 400 malformed_request/grant_malformed (parseGrantBody() sitt fail-closed-krav om grant_token), gateway.execute() ALDRI kalt", async () => {
    const res = await post("/executive/query", { action: "get_attention_queue" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("malformed_request");
    expect(res.body["reason"]).toBe("grant_malformed");
    expect(executeCalls).toHaveLength(0);
  });

  it("oppdiktet/utløpt grant_token (syntaktisk gyldig, men ikke reelt): 403 identity_denied, gateway.execute() ALDRI kalt", async () => {
    const res = await post("/executive/query", { grant_token: "grant-som-ikke-finnes", action: "get_attention_queue" });
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("identity_denied");
    expect(executeCalls).toHaveLength(0);
  });
});

describe("C: /executive/query begrenser SEG SELV til det hardkodede lese-allowlistet - mutasjoner er UNÅDBARE her", () => {
  it("action='activate_kill_switch' (en klasse D-mutasjon): 400 malformed_request/action_not_allowed, gateway.execute() ALDRI kalt", async () => {
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "activate_kill_switch" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("malformed_request");
    expect(res.body["reason"]).toBe("action_not_allowed");
    expect(executeCalls).toHaveLength(0);
  });

  it("action='pause_domain': 400 action_not_allowed, gateway.execute() ALDRI kalt", async () => {
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "pause_domain" });
    expect(res.status).toBe(400);
    expect(res.body["reason"]).toBe("action_not_allowed");
    expect(executeCalls).toHaveLength(0);
  });

  it("ukjent handling ('does_not_exist'): 400 action_not_allowed", async () => {
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "does_not_exist" });
    expect(res.status).toBe(400);
    expect(res.body["reason"]).toBe("action_not_allowed");
    expect(executeCalls).toHaveLength(0);
  });

  it("manglende 'action': 400 malformed_request/grant_malformed", async () => {
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant });
    expect(res.status).toBe(400);
    expect(res.body["reason"]).toBe("grant_malformed");
    expect(executeCalls).toHaveLength(0);
  });

  it("ukjent kroppsfelt (f.eks. 'tenant_id') avvises fail-closed: 400 malformed_request/grant_malformed", async () => {
    const grant = await validGrant();
    const res = await post("/executive/query", { grant_token: grant, action: "get_attention_queue", tenant_id: TENANT_A });
    expect(res.status).toBe(400);
    expect(res.body["reason"]).toBe("grant_malformed");
    expect(executeCalls).toHaveLength(0);
  });
});
