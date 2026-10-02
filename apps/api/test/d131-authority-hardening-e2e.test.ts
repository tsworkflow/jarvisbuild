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
  DeviceEnrollmentService,
  DeviceService,
  IdentityService,
  SessionGrantService,
  SessionService,
  createEnrollmentTicket,
  createPool,
  runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { IdentityContext } from "@jarvis/contracts";
import { createApiServer } from "../src/server.ts";

/**
 * D-131 - REGRESJONSBEVIS FOR DEN UAVHENGIGE ARKITEKTKONTROLLEN AV PR #79.
 *
 * Ekte HTTP mot en ekte `createApiServer()`, mot en ekte Postgres, under en
 * ekte NOSUPERUSER/NOBYPASSRLS-rolle - ikke enhetstester av klassene isolert.
 *
 * Funnene som dekkes:
 *
 *   1. Samtalekontinuitet var brukt som device-authentication. Dekkes av
 *      gruppe A (per-enhet-autoritet ved kanalbytte - en eldre klient blir
 *      IKKE re-attribuert til den sist aktive enheten), gruppe B
 *      (tilbakekalt/rotert nøkkel og utløpt/tilbakekalt grant nektes) og
 *      gruppe C (en rå sesjons-ID, også en fra en annen transport, kan ikke
 *      bli `signed`).
 *   2. Registreringsveien undergravde nøkkelbeviset. Dekkes av gruppe D
 *      (anonym innrullering/rotasjon nektes UTEN nøkkelendring; billett er
 *      engangs; en `device_id` som eies av en annen prinsipal kan ikke overtas).
 *   3. Avslått autorisasjon kunne mutere sesjonen. Dekkes av gruppe E, med
 *      FULL før/etter-snapshot av `sessions` OG `session_grants` - ikke
 *      `COUNT(*)`, som reviewen eksplisitt avviste.
 *
 * Både `/chat` og `/brief` testes.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const TENANT_A = "tenant-d131-a";
const TENANT_B = "tenant-d131-b";
const OWNER = "person-d131-owner";
const OTHER = "person-d131-other";
const FRESH = "person-d131-fresh";
const ENROLLER = "person-d131-enroller";

const keys = {
  mobile: generateKeyPairSync("ed25519"),
  web: generateKeyPairSync("ed25519"),
  revoke: generateKeyPairSync("ed25519"),
  rotate: generateKeyPairSync("ed25519"),
  rotateNew: generateKeyPairSync("ed25519"),
  expire: generateKeyPairSync("ed25519"),
  other: generateKeyPairSync("ed25519"),
  fresh: generateKeyPairSync("ed25519"),
  enroll: generateKeyPairSync("ed25519"),
  attacker: generateKeyPairSync("ed25519")
};
type KeyPair = ReturnType<typeof generateKeyPairSync>;

const pem = (pair: KeyPair): string => pair.publicKey.export({ type: "spki", format: "pem" }).toString();

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-d131-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false })
,
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
  // EKTE ikke-BYPASSRLS-rolle - alt under kjører med samme begrensninger som produksjon.
  await adminPool.query("CREATE ROLE jarvis_d131 LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d131");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'D131 A', 'person'), ('${TENANT_B}', 'D131 B', 'person');
    INSERT INTO people (person_id, display_name) VALUES
      ('${OWNER}', 'Owner'), ('${OTHER}', 'Other'), ('${FRESH}', 'Fresh'), ('${ENROLLER}', 'Enroller');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES
      ('${OWNER}', '${TENANT_A}'), ('${OTHER}', '${TENANT_A}'), ('${FRESH}', '${TENANT_A}'), ('${ENROLLER}', '${TENANT_A}');
    -- MERK: 'guest' seedes BEVISST IKKE. Den er en gyldig MemorySpace-enum-verdi,
    -- men finnes ikke i denne tenanten - nøyaktig inputen funn 3 handlet om.
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('sp-d131-a', '${TENANT_A}', 'personal'), ('sp-d131-b', '${TENANT_B}', 'personal');
  `);
  const device = async (id: string, person: string, tenant: string, kind: string, pair: KeyPair | null) =>
    adminPool.query(
      "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)",
      [id, tenant, person, kind, pair ? pem(pair) : null]
    );
  await device("d131-mobile", OWNER, TENANT_A, "mobile", keys.mobile);
  await device("d131-web", OWNER, TENANT_A, "web", keys.web);
  await device("d131-revoke", OWNER, TENANT_A, "mobile", keys.revoke);
  await device("d131-rotate", OWNER, TENANT_A, "mobile", keys.rotate);
  await device("d131-expire", OWNER, TENANT_A, "mobile", keys.expire);
  await device("d131-other-owned", OTHER, TENANT_A, "mobile", keys.other);
  await device("d131-fresh", FRESH, TENANT_A, "mobile", keys.fresh);
  // Tjeneste-enhet UTEN nøkkel - representerer den stien
  // `TelegramOwnerAuthority` bruker (bot-token på transporten, ALDRI et
  // proof-of-possession). Kan per konstruksjon aldri bevise noe.
  await device("d131-service", OWNER, TENANT_A, "service", null);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_d131", password: "test-app-pw" });

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
    policy: {} as never,
    worker: {} as never,
    // Ekko-stubber: returnerer den OPPLØSTE identiteten, slik at testene kan
    // hevde HVEM et kall faktisk ble attribuert til - selve kjernen i funn 1.
    conversation: { handle: async (identity: IdentityContext) => ({ reply: "ok", routed: "fast", echo: identity }) } as never,
    brief: {
      generate: async (identity: unknown) => ({ echo: identity }),
      render: () => "brief"
    }
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

// ---------------------------------------------------------------- hjelpere

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function proofFor(deviceId: string, pair: KeyPair): Promise<{ challenge: string; signature: string }> {
  const { body } = await post("/devices/challenge", { device_id: deviceId });
  const challenge = body["challenge"] as string;
  return { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), pair.privateKey).toString("base64") };
}

interface Grant { grant_token: string; session_id: string; device_id: string; channel: string; memory_space: string }

async function authorize(opts: {
  channel: string; person?: string; tenant?: string; device: string; pair: KeyPair; space?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return post("/session/authorize", {
    channel: opts.channel,
    person_id: opts.person ?? OWNER,
    tenant_id: opts.tenant ?? TENANT_A,
    device_id: opts.device,
    memory_space: opts.space ?? "personal",
    device_proof: await proofFor(opts.device, opts.pair)
  });
}

async function authorizeOk(opts: Parameters<typeof authorize>[0]): Promise<Grant> {
  const result = await authorize(opts);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body["grant"] as unknown as Grant;
}

/**
 * FULL rad-snapshot, ikke `COUNT(*)`. Reviewen avviste eksplisitt en ren
 * telling: det som må bevises er at INGEN rad ble opprettet OG at ingen
 * eksisterende rad ble ENDRET (inkludert `last_device_id`, `last_channel` og
 * `last_active_at`, som er nettopp de feltene `resumeOrCreate()` muterer).
 */
async function sessionSnapshot(tenantId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query(
    `SELECT session_id, person_id, status, last_channel, last_device_id,
            created_at::text, last_active_at::text
       FROM sessions WHERE tenant_id = $1 ORDER BY session_id`,
    [tenantId]
  );
  return rows;
}

async function grantSnapshot(tenantId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query(
    `SELECT grant_id, person_id, device_id, session_id, memory_space, channel, auth_strength,
            device_key_fingerprint, expires_at::text, revoked_at::text
       FROM session_grants WHERE tenant_id = $1 ORDER BY grant_id`,
    [tenantId]
  );
  return rows;
}

async function deviceSnapshot(): Promise<unknown[]> {
  const { rows } = await adminPool.query(
    "SELECT device_id, tenant_id, person_id, kind, public_key_pem FROM devices ORDER BY device_id"
  );
  return rows;
}

// =========================================================== A: per-enhet-autoritet

describe("A (funn 1): samtalen deles på tvers av kanaler, autoriteten gjør det ALDRI", () => {
  it("mobile→web: samme session_id, men to distinkte grants bundet til hver sin enhet", async () => {
    const onMobile = await authorizeOk({ channel: "mobile", device: "d131-mobile", pair: keys.mobile });
    const onWeb = await authorizeOk({ channel: "web", device: "d131-web", pair: keys.web });

    expect(onWeb.session_id).toBe(onMobile.session_id); // kontinuitet bevart
    expect(onWeb.grant_token).not.toBe(onMobile.grant_token); // autoritet IKKE delt
    expect(onMobile.device_id).toBe("d131-mobile");
    expect(onWeb.device_id).toBe("d131-web");
    expect(onMobile.channel).toBe("mobile");
    expect(onWeb.channel).toBe("web");
  });

  it("REGRESJON funn 1: en ELDRE klients kall blir IKKE re-attribuert til den sist aktive enheten", async () => {
    const onMobile = await authorizeOk({ channel: "mobile", device: "d131-mobile", pair: keys.mobile });
    // Kanalbytte: web autoriserer ETTERPÅ og overskriver sesjonsradens
    // `last_device_id`. Det er nøyaktig tilstanden den gamle `getActive()`
    // leste `device_id` fra.
    const onWeb = await authorizeOk({ channel: "web", device: "d131-web", pair: keys.web });
    expect(onWeb.session_id).toBe(onMobile.session_id);

    const { rows } = await adminPool.query(
      "SELECT last_device_id, last_channel FROM sessions WHERE session_id = $1",
      [onMobile.session_id]
    );
    // Grunnsannhet: sesjonsraden PEKER på web-enheten nå.
    expect(rows[0]).toMatchObject({ last_device_id: "d131-web", last_channel: "web" });

    // Den eldre mobil-klienten kaller likevel /chat med SITT grant.
    const chat = await post("/chat", { grant_token: onMobile.grant_token, message: "hei" });
    expect(chat.status).toBe(200);
    const chatIdentity = (chat.body["echo"] as Record<string, unknown>);
    // FØR fiksen ville dette vært "d131-web" - en annen enhets identitet.
    expect(chatIdentity["device_id"]).toBe("d131-mobile");
    expect(chatIdentity["channel"]).toBe("mobile");
    expect(chatIdentity["auth_strength"]).toBe("signed");
    expect(chatIdentity["session_id"]).toBe(onMobile.session_id);

    // Identisk for /brief - den var den ANDRE ruten med samme feil.
    const brief = await post("/brief", { grant_token: onMobile.grant_token });
    expect(brief.status).toBe(200);
    const briefIdentity = (brief.body["brief"] as Record<string, unknown>)["echo"] as Record<string, unknown>;
    expect(briefIdentity["device_id"]).toBe("d131-mobile");
    expect(briefIdentity["session_id"]).toBe(onMobile.session_id);
  });

  it("grantet er bundet til det AUTORISERTE scopet - klienten kan ikke be om en annen space i /chat", async () => {
    const grant = await authorizeOk({ channel: "web", device: "d131-web", pair: keys.web, space: "personal" });
    expect(grant.memory_space).toBe("personal");
    // Et forsøk på å oppgi memory_space i kroppen er ikke «ignorert» - det er avvist.
    const res = await post("/chat", { grant_token: grant.grant_token, message: "hei", memory_space: "health" });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("identity_field_forbidden");
  });
});

// =========================================================== B: tilbakekalling og utløp

describe("B (funn 1): et utstedt bevis slutter å virke når nøkkelen eller grantet ikke lenger gjelder", () => {
  it("REGRESJON: tilbakekalt enhetsnøkkel (public_key_pem = NULL) nekter et ellers gyldig grant", async () => {
    const grant = await authorizeOk({ channel: "mobile", device: "d131-revoke", pair: keys.revoke });
    // Beviset virker FØR tilbakekallingen.
    expect((await post("/chat", { grant_token: grant.grant_token, message: "a" })).status).toBe(200);

    await adminPool.query("UPDATE devices SET public_key_pem = NULL WHERE device_id = 'd131-revoke'");

    const after = await post("/chat", { grant_token: grant.grant_token, message: "b" });
    expect(after.status).toBe(403);
    expect(after.body["reason"]).toBe("device_authority_revoked");
    const brief = await post("/brief", { grant_token: grant.grant_token });
    expect(brief.status).toBe(403);
    expect(brief.body["reason"]).toBe("device_authority_revoked");
  });

  it("REGRESJON: nøkkelROTASJON dreper utestående grants (fingerprint-mismatch), også uten eksplisitt opprydning", async () => {
    const grant = await authorizeOk({ channel: "mobile", device: "d131-rotate", pair: keys.rotate });
    expect((await post("/chat", { grant_token: grant.grant_token, message: "a" })).status).toBe(200);

    // Rotasjon utenom innrulleringsstien (ren DB-endring) - beviser at
    // sikkerheten er STRUKTURELL og ikke avhenger av at noen husket å revoke.
    await adminPool.query("UPDATE devices SET public_key_pem = $1 WHERE device_id = 'd131-rotate'", [pem(keys.rotateNew)]);

    const after = await post("/chat", { grant_token: grant.grant_token, message: "b" });
    expect(after.status).toBe(403);
    expect(after.body["reason"]).toBe("device_authority_revoked");
  });

  it("utløpt grant nektes med grant_expired", async () => {
    const grant = await authorizeOk({ channel: "mobile", device: "d131-expire", pair: keys.expire });
    await adminPool.query(
      "UPDATE session_grants SET expires_at = now() - interval '1 minute' WHERE session_id = $1 AND device_id = 'd131-expire'",
      [grant.session_id]
    );
    const after = await post("/chat", { grant_token: grant.grant_token, message: "b" });
    expect(after.status).toBe(403);
    expect(after.body["reason"]).toBe("grant_expired");
  });

  it("eksplisitt tilbakekalt grant nektes med grant_revoked", async () => {
    const grant = await authorizeOk({ channel: "web", device: "d131-web", pair: keys.web });
    await adminPool.query(
      "UPDATE session_grants SET revoked_at = now() WHERE device_id = 'd131-web' AND revoked_at IS NULL"
    );
    const after = await post("/chat", { grant_token: grant.grant_token, message: "b" });
    expect(after.status).toBe(403);
    expect(after.body["reason"]).toBe("grant_revoked");
  });

  it("databasen lagrer ALDRI et brukbart token - kun SHA-256 av det", async () => {
    const grant = await authorizeOk({ channel: "mobile", device: "d131-mobile", pair: keys.mobile });
    const { rows } = await adminPool.query("SELECT grant_id FROM session_grants WHERE grant_id = $1", [grant.grant_token]);
    expect(rows).toHaveLength(0); // tokenet selv finnes ingen steder
    const stored = await adminPool.query("SELECT count(*)::int AS n FROM session_grants");
    expect((stored.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});

// =========================================================== C: rå sesjons-ID

describe("C (funn 1): en rå sesjons-ID - også fra en annen transport - kan ALDRI bli signed", () => {
  it("/chat og /brief avviser en EKTE, aktiv sesjons-ID som kropp", async () => {
    const grant = await authorizeOk({ channel: "mobile", device: "d131-mobile", pair: keys.mobile });
    const chat = await post("/chat", {
      session_id: grant.session_id, tenant_id: TENANT_A, memory_space: "personal", channel: "web", message: "hei"
    });
    expect(chat.status).toBe(400);
    expect(chat.body["error"]).toBe("identity_field_forbidden");

    const brief = await post("/brief", { session_id: grant.session_id, tenant_id: TENANT_A, memory_space: "personal", channel: "api" });
    expect(brief.status).toBe(400);
    expect(brief.body["error"]).toBe("identity_field_forbidden");
  });

  it("REGRESJON: en transport UTEN enhetsbevis (bot-token-stien) kan ikke skaffe seg et grant", async () => {
    // `TelegramOwnerAuthority` autoriserer på en konfigurert chat-ID og
    // opererer som tjeneste-enheten `d131-service`, som per konstruksjon ikke
    // har noen registrert nøkkel. Den kan derfor aldri passere
    // `/session/authorize`, og dermed aldri få et `signed` grant.
    const attempt = await authorize({ channel: "telegram", device: "d131-service", pair: keys.attacker });
    expect(attempt.status).toBe(403);
    expect(attempt.body["reason"]).toBe("device_proof_invalid");

    // Og en sesjon som en slik transport HAR opprettet server-side gir
    // ingenting: sesjons-ID-en er ikke en gyldig /chat-kropp i det hele tatt.
    const sessionForService = await new SessionService(appPool).resumeOrCreate(
      { tenant_id: TENANT_A, person_id: OWNER, device_id: "d131-service" }, "telegram"
    );
    const chat = await post("/chat", { grant_token: sessionForService.session_id, message: "hei" });
    expect(chat.status).toBe(403);
    expect(chat.body["reason"]).toBe("grant_not_found");
  });
});

// =========================================================== D: innrullering

describe("D (funn 2): innrullering og nøkkelrotasjon krever eksplisitt eier-/bootstrap-autoritet", () => {
  it("REGRESJON: anonym innrullering (ingen enrollment-autoritet) avvises UTEN nøkkelendring", async () => {
    const before = await deviceSnapshot();
    // Nøyaktig den gamle, sårbare kroppen: kun offentlige ID-er + en
    // selvoppgitt `identity` med `auth_strength: "active"`.
    const attempt = await post("/devices/register", {
      identity: { person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile", memory_space: "personal",
                  session_id: "sess-device-setup", channel: "web", auth_strength: "active" },
      device: { device_id: "d131-mobile", kind: "mobile", public_key_pem: pem(keys.attacker) }
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body["reason"]).toBe("malformed_request");
    expect(await deviceSnapshot()).toEqual(before);
  });

  it("REGRESJON: en caller med KUN gyldige offentlige ID-er kan verken bytte nøkkel eller skaffe grant", async () => {
    const before = await deviceSnapshot();
    // Riktig kroppform denne gangen, men ingen gyldig autoritet.
    const withBogusTicket = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: OWNER,
      device: { device_id: "d131-mobile", kind: "mobile", public_key_pem: pem(keys.attacker) },
      enrollment: { kind: "enrollment_ticket", ticket: "enr_oppdiktet-billett" }
    });
    expect(withBogusTicket.status).toBe(403);
    expect(withBogusTicket.body["reason"]).toBe("enrollment_ticket_invalid");

    const withBogusProof = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: OWNER,
      device: { device_id: "d131-mobile", kind: "mobile", public_key_pem: pem(keys.attacker) },
      enrollment: { kind: "device_proof", authorizing_device_id: "d131-mobile",
                    challenge: "chal-oppdiktet", signature: "aW52YWxpZA==" }
    });
    expect(withBogusProof.status).toBe(403);
    expect(withBogusProof.body["reason"]).toBe("authorizing_device_proof_invalid");

    // INGEN nøkkel endret …
    expect(await deviceSnapshot()).toEqual(before);
    // … og angriperens egen nøkkel gir derfor fortsatt ingen autoritet.
    const attempt = await authorize({ channel: "mobile", device: "d131-mobile", pair: keys.attacker });
    expect(attempt.status).toBe(403);
    expect(attempt.body["reason"]).toBe("device_proof_invalid");
  });

  it("gyldig eier-billett innrullerer FØRSTE enhet, og billetten er engangs", async () => {
    const created = await createEnrollmentTicket(adminPool, {
      tenant_id: TENANT_A, person_id: ENROLLER, device_id: "d131-enroll"
    });
    const ok = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: ENROLLER,
      device: { device_id: "d131-enroll", kind: "web", public_key_pem: pem(keys.enroll) },
      enrollment: { kind: "enrollment_ticket", ticket: created.ticket }
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body["rotated"]).toBe(false);

    // Enheten kan nå faktisk autorisere.
    const grant = await authorizeOk({ channel: "web", device: "d131-enroll", pair: keys.enroll, person: ENROLLER });
    expect(grant.device_id).toBe("d131-enroll");

    // Engangsbruk: samme billett igjen avvises.
    const replay = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: ENROLLER,
      device: { device_id: "d131-enroll", kind: "web", public_key_pem: pem(keys.attacker) },
      enrollment: { kind: "enrollment_ticket", ticket: created.ticket }
    });
    expect(replay.status).toBe(403);
    expect(replay.body["reason"]).toBe("enrollment_ticket_invalid");
  });

  it("nøkkelrotasjon autorisert av enheten SELV lykkes og tilbakekaller utestående grants", async () => {
    const before = await authorizeOk({ channel: "web", device: "d131-enroll", pair: keys.enroll, person: ENROLLER });
    expect((await post("/chat", { grant_token: before.grant_token, message: "a" })).status).toBe(200);

    const rotation = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: ENROLLER,
      device: { device_id: "d131-enroll", kind: "web", public_key_pem: pem(keys.rotateNew) },
      enrollment: {
        kind: "device_proof", authorizing_device_id: "d131-enroll",
        ...(await proofFor("d131-enroll", keys.enroll))
      }
    });
    expect(rotation.status, JSON.stringify(rotation.body)).toBe(200);
    expect(rotation.body["rotated"]).toBe(true);
    expect(rotation.body["revoked_grants"] as number).toBeGreaterThan(0);

    // Grantet fra FØR rotasjonen er dødt.
    const after = await post("/chat", { grant_token: before.grant_token, message: "b" });
    expect(after.status).toBe(403);
    expect(["grant_revoked", "device_authority_revoked"]).toContain(after.body["reason"]);
    // Den GAMLE private nøkkelen gir ikke lenger autoritet.
    const oldKey = await authorize({ channel: "web", device: "d131-enroll", pair: keys.enroll, person: ENROLLER });
    expect(oldKey.status).toBe(403);
  });

  it("en device_id som eies av en ANNEN prinsipal kan ikke overtas - og billetten forblir ubrukt", async () => {
    const before = await deviceSnapshot();
    const created = await createEnrollmentTicket(adminPool, { tenant_id: TENANT_A, person_id: ENROLLER });
    const attempt = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: ENROLLER,
      // `d131-mobile` tilhører OWNER, ikke ENROLLER.
      device: { device_id: "d131-mobile", kind: "mobile", public_key_pem: pem(keys.attacker) },
      enrollment: { kind: "enrollment_ticket", ticket: created.ticket }
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body["reason"]).toBe("device_owned_by_other_principal");
    expect(await deviceSnapshot()).toEqual(before);

    // Transaksjonen rullet tilbake, så billetten er IKKE konsumert av et avslag.
    const { rows } = await adminPool.query(
      "SELECT consumed_at FROM device_enrollment_tickets WHERE tenant_id = $1 AND person_id = $2 AND device_id IS NULL",
      [TENANT_A, ENROLLER]
    );
    expect(rows[0]).toMatchObject({ consumed_at: null });
  });

  it("kryss-tenant/kryss-person: billett for én prinsipal virker ikke for en annen", async () => {
    const before = await deviceSnapshot();
    const created = await createEnrollmentTicket(adminPool, { tenant_id: TENANT_A, person_id: ENROLLER });
    const attempt = await post("/devices/register", {
      tenant_id: TENANT_A, person_id: OTHER,
      device: { device_id: "d131-other-owned", kind: "mobile", public_key_pem: pem(keys.attacker) },
      enrollment: { kind: "enrollment_ticket", ticket: created.ticket }
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body["reason"]).toBe("enrollment_ticket_invalid");
    expect(await deviceSnapshot()).toEqual(before);
  });
});

// =========================================================== E: ingen mutasjon ved avslag

describe("E (funn 3): et AVSLAG muterer ALDRI sessions eller session_grants", () => {
  /** Kjører et avslags-forsøk og krever byte-identiske snapshots før/etter. */
  async function expectNoMutation(
    label: string,
    attempt: () => Promise<{ status: number; body: Record<string, unknown> }>,
    expectedReason: string
  ): Promise<void> {
    const sessionsA = await sessionSnapshot(TENANT_A);
    const sessionsB = await sessionSnapshot(TENANT_B);
    const grantsA = await grantSnapshot(TENANT_A);
    const grantsB = await grantSnapshot(TENANT_B);

    const result = await attempt();
    expect(result.status, `${label}: ${JSON.stringify(result.body)}`).toBe(403);
    expect(result.body["reason"], label).toBe(expectedReason);

    expect(await sessionSnapshot(TENANT_A), `${label}: sessions(A) endret`).toEqual(sessionsA);
    expect(await sessionSnapshot(TENANT_B), `${label}: sessions(B) endret`).toEqual(sessionsB);
    expect(await grantSnapshot(TENANT_A), `${label}: grants(A) endret`).toEqual(grantsA);
    expect(await grantSnapshot(TENANT_B), `${label}: grants(B) endret`).toEqual(grantsB);
  }

  it("REGRESJON: gyldig enhetsbevis + UKJENT memory space, uten eksisterende sesjon → ingen sesjon opprettes", async () => {
    // `d131-fresh`/FRESH har ingen sesjon i det hele tatt. 'guest' er en gyldig
    // enum-verdi, men finnes ikke i denne tenanten - PRESIS inputen funn 3
    // beskrev. FØR fiksen opprettet dette en sesjonsrad før DENY.
    const fresh = await adminPool.query("SELECT count(*)::int AS n FROM sessions WHERE person_id = $1", [FRESH]);
    expect((fresh.rows[0] as { n: number }).n).toBe(0);

    await expectNoMutation(
      "ukjent space / ny sesjon",
      () => authorize({ channel: "mobile", device: "d131-fresh", pair: keys.fresh, person: FRESH, space: "guest" }),
      "unknown_memory_space"
    );

    const after = await adminPool.query("SELECT count(*)::int AS n FROM sessions WHERE person_id = $1", [FRESH]);
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });

  it("REGRESJON: gyldig enhetsbevis + UKJENT memory space, MED eksisterende sesjon → raden er byte-identisk etterpå", async () => {
    // Gi OTHER en ekte, aktiv sesjon først …
    const existing = await authorizeOk({ channel: "mobile", device: "d131-other-owned", pair: keys.other, person: OTHER });
    const rowBefore = await adminPool.query(
      "SELECT last_channel, last_device_id, last_active_at::text FROM sessions WHERE session_id = $1",
      [existing.session_id]
    );

    // … og prøv så en space som ikke finnes. `resumeOrCreate()` ville ha
    // oppdatert `last_channel`/`last_device_id`/`last_active_at` FØR avslaget.
    await expectNoMutation(
      "ukjent space / eksisterende sesjon",
      () => authorize({ channel: "watch", device: "d131-other-owned", pair: keys.other, person: OTHER, space: "guest" }),
      "unknown_memory_space"
    );

    const rowAfter = await adminPool.query(
      "SELECT last_channel, last_device_id, last_active_at::text FROM sessions WHERE session_id = $1",
      [existing.session_id]
    );
    expect(rowAfter.rows[0]).toEqual(rowBefore.rows[0]);
  });

  it("REGRESJON: ugyldig `channel` valideres mot kontraktens enum, ikke bare typeof string", async () => {
    await expectNoMutation(
      "ukjent kanal",
      () => authorize({ channel: "definitely-not-a-channel", device: "d131-mobile", pair: keys.mobile }),
      "unknown_channel"
    );
    // Og en ikke-streng kanal er like avvist.
    await expectNoMutation(
      "kanal er ikke en streng",
      () => post("/session/authorize", {
        channel: 42, person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile",
        memory_space: "personal", device_proof: { challenge: "x", signature: "y" }
      }),
      "unknown_channel"
    );
  });

  it("kryss-person: enhetens EGEN gyldige nøkkel, men en annen persons person_id", async () => {
    await expectNoMutation(
      "kryss-person",
      () => authorize({ channel: "mobile", device: "d131-other-owned", pair: keys.other, person: OWNER }),
      "device_proof_invalid"
    );
  });

  it("kryss-tenant: ekte enhet/nøkkel, men påstått feil tenant", async () => {
    await expectNoMutation(
      "kryss-tenant",
      () => authorize({ channel: "mobile", device: "d131-mobile", pair: keys.mobile, tenant: TENANT_B }),
      "device_proof_invalid"
    );
  });

  it("replay av en allerede brukt challenge", async () => {
    const proof = await proofFor("d131-mobile", keys.mobile);
    const first = await post("/session/authorize", {
      channel: "mobile", person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile",
      memory_space: "personal", device_proof: proof
    });
    expect(first.status).toBe(200);

    await expectNoMutation(
      "replay",
      () => post("/session/authorize", {
        channel: "mobile", person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile",
        memory_space: "personal", device_proof: proof
      }),
      "device_proof_invalid"
    );
  });

  it("ugyldig signatur", async () => {
    await expectNoMutation(
      "ugyldig signatur",
      async () => {
        const { challenge } = await proofFor("d131-mobile", keys.mobile);
        return post("/session/authorize", {
          channel: "mobile", person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile",
          memory_space: "personal", device_proof: { challenge, signature: "aW52YWxpZC1zaWduYXR1cmU=" }
        });
      },
      "device_proof_invalid"
    );
  });

  it("smuglet felt i bevismaterialet (auth_strength / session_id / grant_token)", async () => {
    for (const smuggled of [{ auth_strength: "signed" }, { session_id: "sess-fabrikkert" }, { grant_token: "grt_fabrikkert" }]) {
      await expectNoMutation(
        `smuglet ${Object.keys(smuggled)[0]}`,
        async () => post("/session/authorize", {
          channel: "mobile", person_id: OWNER, tenant_id: TENANT_A, device_id: "d131-mobile",
          memory_space: "personal", device_proof: await proofFor("d131-mobile", keys.mobile), ...smuggled
        }),
        "malformed_evidence"
      );
    }
  });
});
