import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority,
  ContextBuilder,
  DeviceEnrollmentService,
  DeviceService,
  IdentityService,
  MessageStore,
  SessionGrantService,
  SessionService,
  createPool,
  runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";

/**
 * D-130 arkitekt-review MERGE BLOCKER 1 (REVIEW_ID=5149129191): ekte
 * API-KOMPOSISJON-bevis (EKTE `createApiServer()` + EKTE `fetch()` mot en
 * kjørende HTTP-server), IKKE bare et isolert enhetstestbevis for
 * `ChannelSessionAuthority` - reviewen krevde eksplisitt "test ekte
 * API-komposisjon, ikke bare ChannelSessionAuthority isolert". Beviser:
 * kanalbytte-kontinuitet (mobile→web, mobile→watch, SAMME server-eide
 * session_id), og at ugyldig/replayed/kryss-person/kryss-tenant bevismateriale
 * gir NULL sesjonsmutasjon (aldri en delvis/stille sesjonsside-effekt).
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const TENANT_A = "tenant-sa-a";
const TENANT_B = "tenant-sa-b";
const PERSON_OWNER = "person-sa-owner";
const PERSON_IMPOSTER = "person-sa-imposter";

const mobileKeys = generateKeyPairSync("ed25519");
const webKeys = generateKeyPairSync("ed25519");
const watchKeys = generateKeyPairSync("ed25519");
const imposterKeys = generateKeyPairSync("ed25519");
const tenantBKeys = generateKeyPairSync("ed25519");

const pem = (keys: { publicKey: import("node:crypto").KeyObject }): string =>
  keys.publicKey.export({ type: "spki", format: "pem" }).toString();

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-sa-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false }),
    // D-141 B: proben maa bruke instansens EGNE credentials.
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sa_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_sa_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Session Authority A', 'person'), ('${TENANT_B}', 'Session Authority B', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON_OWNER}', 'Owner'), ('${PERSON_IMPOSTER}', 'Imposter');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_OWNER}', '${TENANT_A}'), ('${PERSON_IMPOSTER}', '${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-sa-a', '${TENANT_A}', 'personal'), ('sp-sa-b', '${TENANT_B}', 'personal');
  `);
  // Enhetene registreres med ekte public_key_pem via PARAMETRISERT spørring
  // (aldri tekstlig interpolert - se samme lærdom i fase3-e2e.test.ts).
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    ["dev-sa-mobile", TENANT_A, PERSON_OWNER, "mobile", pem(mobileKeys)]
  );
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    ["dev-sa-web", TENANT_A, PERSON_OWNER, "web", pem(webKeys)]
  );
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    ["dev-sa-watch", TENANT_A, PERSON_OWNER, "watch", pem(watchKeys)]
  );
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    ["dev-sa-imposter-owned", TENANT_A, PERSON_IMPOSTER, "mobile", pem(imposterKeys)]
  );
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
    ["dev-sa-tenant-b", TENANT_B, PERSON_OWNER, "mobile", pem(tenantBKeys)]
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sa_test", password: "test-app-pw" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: { consume: async () => true }, killSwitch: new KillSwitch()
  });
  const trace = new MemoryTraceSink();
  const gateway = new ModelGateway({ pool: appPool, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const queue = new PgTaskQueue(appPool);
  const worker = new InProcessWorker(queue);
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  server = createApiServer({
    identity: identityService,
    sessions: sessionService,
    devices: deviceService,
    grants: grantService,
    enrollment: new DeviceEnrollmentService({ pool: appPool, devices: deviceService, grants: grantService }),
    channelAuthority: new ChannelSessionAuthority({
      pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService
    }),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool), context: new ContextBuilder(appPool), gateway,
      tasks: new TaskService(appPool, queue, policy), worker, trace
    })
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

async function challengeFor(deviceId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/devices/challenge`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: deviceId })
  });
  const { challenge } = (await res.json()) as { challenge: string };
  return challenge;
}

async function authorizeRaw(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/session/authorize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function sessionRowCount(tenantId: string): Promise<number> {
  const { rows } = await adminPool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE tenant_id = $1", [tenantId]);
  return (rows[0] as { n: number }).n;
}

describe("A/B: kanalbytte-kontinuitet - mobile→web og mobile→watch gjenbruker SAMME server-eide session_id", () => {
  it("mobile→web→watch: alle tre autorisasjoner deler session_id, men får HVER SITT grant", async () => {
    const mobileChallenge = await challengeFor("dev-sa-mobile");
    const mobileSig = sign(null, Buffer.from(mobileChallenge, "utf8"), mobileKeys.privateKey).toString("base64");
    const onMobile = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-mobile",
      memory_space: "personal", device_proof: { challenge: mobileChallenge, signature: mobileSig }
    });
    expect(onMobile.status).toBe(200);
    expect(onMobile.body["ok"]).toBe(true);
    const sessionIdMobile = onMobile.body["session_id"];
    const grantMobile = onMobile.body["grant"] as Record<string, unknown>;
    expect(grantMobile["device_id"]).toBe("dev-sa-mobile");
    expect(grantMobile["channel"]).toBe("mobile");

    const webChallenge = await challengeFor("dev-sa-web");
    const webSig = sign(null, Buffer.from(webChallenge, "utf8"), webKeys.privateKey).toString("base64");
    const onWeb = await authorizeRaw({
      channel: "web", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-web",
      memory_space: "personal", device_proof: { challenge: webChallenge, signature: webSig }
    });
    expect(onWeb.status).toBe(200);
    expect(onWeb.body["session_id"]).toBe(sessionIdMobile);

    const watchChallenge = await challengeFor("dev-sa-watch");
    const watchSig = sign(null, Buffer.from(watchChallenge, "utf8"), watchKeys.privateKey).toString("base64");
    const onWatch = await authorizeRaw({
      channel: "watch", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-watch",
      memory_space: "personal", device_proof: { challenge: watchChallenge, signature: watchSig }
    });
    expect(onWatch.status).toBe(200);
    expect(onWatch.body["session_id"]).toBe(sessionIdMobile);
    const grantWatch = onWatch.body["grant"] as Record<string, unknown>;

    // D-131 funn 1: SAMTALEN deles (samme session_id), men AUTORITETEN gjør
    // det ikke - hver enhet har sitt eget, distinkte grant.
    expect(grantWatch["grant_token"]).not.toBe(grantMobile["grant_token"]);
    expect(grantWatch["device_id"]).toBe("dev-sa-watch");

    // Ekte API-komposisjon: grantet fungerer FAKTISK mot /chat, og svarets
    // session_id er den delte samtalen.
    const chatRes = await fetch(`${baseUrl}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: grantWatch["grant_token"], message: "status" })
    });
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as Record<string, unknown>;
    expect(chatBody["session_id"]).toBe(sessionIdMobile);
  });
});

describe("C: ugyldig bevis - INGEN sesjonsmutasjon", () => {
  it("feil signatur → 403 device_proof_invalid, ingen ny/endret sesjonsrad", async () => {
    const before = await sessionRowCount(TENANT_A);
    const challenge = await challengeFor("dev-sa-mobile");
    const result = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-mobile",
      memory_space: "personal", device_proof: { challenge, signature: "aW52YWxpZC1zaWduYXR1cmU=" }
    });
    expect(result.status).toBe(403);
    expect(result.body["ok"]).toBe(false);
    expect(result.body["reason"]).toBe("device_proof_invalid");
    expect(await sessionRowCount(TENANT_A)).toBe(before);
  });
});

describe("D: kryss-person-bevis - enhetens EGEN gyldige nøkkel, men en ANNEN persons person_id - INGEN sideeffekt", () => {
  it("dev-sa-imposter-owned sin ekte nøkkel, PÅSTÅTT person_id=OWNER (feil person) → avvist, ingen sesjonsrad for OWNER endret", async () => {
    const beforeA = await sessionRowCount(TENANT_A);
    const challenge = await challengeFor("dev-sa-imposter-owned");
    // Enheten er registrert til PERSON_IMPOSTER - signaturen er ekte, men
    // PÅSTANDEN under er PERSON_OWNER. `DeviceService.verifyChallenge()`
    // binder beviset til BÅDE enhet OG påstått person (D-123) - må avvises.
    const signature = sign(null, Buffer.from(challenge, "utf8"), imposterKeys.privateKey).toString("base64");
    const result = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-imposter-owned",
      memory_space: "personal", device_proof: { challenge, signature }
    });
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("device_proof_invalid");
    // Sesjonstellingen for HELE tenanten er uendret - verifiserer at
    // OWNER sin eksisterende sesjon (fra testene over) IKKE ble rørt, og at
    // det heller ikke ble opprettet noen ny rad for IMPOSTER.
    expect(await sessionRowCount(TENANT_A)).toBe(beforeA);
  });
});

describe("E: kryss-tenant-bevis - ekte enhet/nøkkel, men PÅSTÅTT feil tenant - INGEN sideeffekt", () => {
  it("dev-sa-mobile sin ekte nøkkel, PÅSTÅTT tenant_id=TENANT_B (enheten tilhører TENANT_A) → avvist", async () => {
    const beforeB = await sessionRowCount(TENANT_B);
    const challenge = await challengeFor("dev-sa-mobile");
    const signature = sign(null, Buffer.from(challenge, "utf8"), mobileKeys.privateKey).toString("base64");
    const result = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_B, device_id: "dev-sa-mobile",
      memory_space: "personal", device_proof: { challenge, signature }
    });
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("device_proof_invalid");
    expect(await sessionRowCount(TENANT_B)).toBe(beforeB);
  });
});

describe("F: replayed challenge - engangsbruk håndheves, andre forsøk avvist uten sideeffekt", () => {
  it("samme challenge+signatur brukt to ganger: første OK, andre avvist", async () => {
    const challenge = await challengeFor("dev-sa-watch");
    const signature = sign(null, Buffer.from(challenge, "utf8"), watchKeys.privateKey).toString("base64");
    const first = await authorizeRaw({
      channel: "watch", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-watch",
      memory_space: "personal", device_proof: { challenge, signature }
    });
    expect(first.status).toBe(200);
    const afterFirst = await sessionRowCount(TENANT_A);

    const replay = await authorizeRaw({
      channel: "watch", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-watch",
      memory_space: "personal", device_proof: { challenge, signature }
    });
    expect(replay.status).toBe(403);
    expect(replay.body["reason"]).toBe("device_proof_invalid");
    expect(await sessionRowCount(TENANT_A)).toBe(afterFirst);
  });
});

describe("G: forsøk på å smugle auth_strength/session_id inn i bevismaterialet - fail-closed avvist", () => {
  it("et 'auth_strength'-felt i evidence-objektet gir malformed_evidence (streng nøkkel-hviteliste)", async () => {
    const challenge = await challengeFor("dev-sa-mobile");
    const signature = sign(null, Buffer.from(challenge, "utf8"), mobileKeys.privateKey).toString("base64");
    const result = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-mobile",
      memory_space: "personal", device_proof: { challenge, signature },
      auth_strength: "signed" // smuglingsforsøk - IKKE en gyldig evidence-nøkkel
    });
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("malformed_evidence");
  });

  it("et 'session_id'-felt i evidence-objektet gir malformed_evidence", async () => {
    const challenge = await challengeFor("dev-sa-mobile");
    const signature = sign(null, Buffer.from(challenge, "utf8"), mobileKeys.privateKey).toString("base64");
    const result = await authorizeRaw({
      channel: "mobile", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-mobile",
      memory_space: "personal", device_proof: { challenge, signature },
      session_id: "sess-fabricated-by-client"
    });
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("malformed_evidence");
  });

  it("/chat med et oppdiktet/ukjent grant_token → 403 grant_not_found, aldri identitetsoppløsning", async () => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: "grt_does-not-exist", message: "hei" })
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["reason"]).toBe("grant_not_found");
  });

  it("/chat med en RÅ sesjons-ID (ikke et grant) → 400 identity_field_forbidden, aldri en oppgradering til signed", async () => {
    // D-131 funn 1 i sin reneste form: en gyldig, aktiv sesjons-ID er
    // SAMTALEKONTINUITET. Den skal ikke engang være en gyldig kropp lenger.
    const challenge = await challengeFor("dev-sa-web");
    const signature = sign(null, Buffer.from(challenge, "utf8"), webKeys.privateKey).toString("base64");
    const authorized = await authorizeRaw({
      channel: "web", person_id: PERSON_OWNER, tenant_id: TENANT_A, device_id: "dev-sa-web",
      memory_space: "personal", device_proof: { challenge, signature }
    });
    expect(authorized.status).toBe(200);
    const realSessionId = authorized.body["session_id"] as string;

    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: realSessionId, tenant_id: TENANT_A, memory_space: "personal", channel: "web", message: "hei" })
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("identity_field_forbidden");
  });
});
