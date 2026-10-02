import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApprovalParameters, signApproval, type IdentityContext } from "@jarvis/contracts";
import {
  DeviceEnrollmentService,
  DeviceService,
  IdentityService,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionGrantService,
  SessionService,
  authorizeProvenDevice,
  createEnrollmentTicket,
  createPool,
  withTenantTransaction,
  runMigrations,
  type DeviceAuthorityDeps
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";

/**
 * Remediering del 2 (JARVIS-050/051/055) - ATFERDSTESTER mot ekte Postgres:
 *
 *  A. Permanent enhetstilbakekalling: en revokert nøkkel kan ikke re-autorisere, ikke rulles inn
 *     igjen (hverken under samme eller en ny device_id), og slutter umiddelbart å godkjenne klasse D.
 *  B. Ed25519-validering ved innrullering (RSA/ugyldig PEM avvises, ikke først ved bruk).
 *  C. Én aktiv sesjon per (tenant, person): samtidige første autorisasjoner gir nøyaktig én rad, og
 *     den delvise unike indeksen er den strukturelle garantien (rå klienter, ingen lås).
 *  D. Godkjenninger: eier-rolle-enhet kreves, forbruket lagrer hele bindingen.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
const TENANT = "tenant-r2dev";
const PERSON = "person-r2owner";
const DELEGATE = "person-r2delegate";

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let sessions: SessionService;
let identity: IdentityService;
let grants: SessionGrantService;
let enrollment: DeviceEnrollmentService;
let authorityDeps: DeviceAuthorityDeps;

const pem = (keys: { publicKey: KeyObject }): string => keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const seed: IdentityContext = {
  person_id: PERSON, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-seed-r2",
  device_id: "seed-device-r2", channel: "system", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-r2dev-"));
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
  await adminPool.query("CREATE ROLE jarvis_r2dev LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_r2dev");
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'R2 Tenant', 'person');
     INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'Owner'), ('${DELEGATE}', 'Delegate');
     INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${PERSON}', '${TENANT}', 'owner'), ('${DELEGATE}', '${TENANT}', 'delegate');
     INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-r2', '${TENANT}', 'personal');`
  );
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_r2dev", password: "pw2" });
  devices = new DeviceService(appPool);
  sessions = new SessionService(appPool);
  identity = new IdentityService(appPool);
  grants = new SessionGrantService(appPool);
  authorityDeps = { pool: appPool, sessions, identity, grants, devices };
  enrollment = new DeviceEnrollmentService({ pool: appPool, devices, grants });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

async function proveAndAuthorize(deviceId: string, keys: { privateKey: KeyObject }, personId = PERSON) {
  const challenge = devices.issueChallenge(deviceId);
  const signature = sign(null, Buffer.from(challenge, "utf8"), keys.privateKey).toString("base64");
  const proven = await devices.verifyChallenge(TENANT, deviceId, challenge, signature, personId);
  if (!proven) return { ok: false as const, reason: "proof_invalid" };
  return authorizeProvenDevice(authorityDeps, {
    person_id: personId, tenant_id: TENANT, device_id: deviceId, memory_space: "personal",
    channel: "mobile", auth_strength: "signed", proven_key_fingerprint: proven
  });
}

async function revoke(deviceId: string, reason = "stolen"): Promise<void> {
  await withTenantTransaction(appPool, TENANT, (client) => devices.revokeDeviceKeyOn(client, { tenant_id: TENANT, device_id: deviceId }, reason));
}

async function ticketEnroll(deviceId: string, publicKeyPem: string, personId = PERSON) {
  const { ticket } = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: personId });
  return enrollment.enroll({
    tenant_id: TENANT, person_id: personId,
    device: { device_id: deviceId, kind: "phone", public_key_pem: publicKeyPem },
    enrollment: { kind: "enrollment_ticket", ticket }
  });
}

describe("A: JARVIS-050 - tilbakekalling er PERMANENT", () => {
  it("A1: en revokert enhet kan ikke hente nytt grant, og det utestående grantet dør", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-a1", kind: "mobile", public_key_pem: pem(keys) });
    const first = await proveAndAuthorize("dev-a1", keys);
    expect(first.ok).toBe(true);
    const token = first.ok ? first.grant.grant_token : "";
    expect((await grants.verify(token)).ok).toBe(true);

    await revoke("dev-a1");

    const verified = await grants.verify(token);
    expect(verified.ok).toBe(false);
    const again = await proveAndAuthorize("dev-a1", keys);
    expect(again.ok).toBe(false); // verifyChallenge finner ingen nøkkel => proof_invalid
    const row = (await adminPool.query("SELECT revoked_at, public_key_pem, revoked_key_fingerprint FROM devices WHERE device_id = 'dev-a1'")).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.public_key_pem).toBeNull();
    expect(row.revoked_key_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("A2: samme device_id kan IKKE rulles inn igjen - verken med gammel eller ny nøkkel (device_revoked)", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-a2", kind: "mobile", public_key_pem: pem(keys) });
    await revoke("dev-a2");

    const sameKey = await ticketEnroll("dev-a2", pem(keys));
    expect(sameKey).toEqual({ ok: false, reason: "device_revoked" });
    const newKey = await ticketEnroll("dev-a2", pem(generateKeyPairSync("ed25519")));
    expect(newKey).toEqual({ ok: false, reason: "device_revoked" });
    // og raden er uendret revokert (ingen overskriving, ingen ny nøkkel)
    const row = (await adminPool.query("SELECT revoked_at, public_key_pem FROM devices WHERE device_id = 'dev-a2'")).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.public_key_pem).toBeNull();
  });

  it("A3: den SAMME nøkkelen kan ikke rulles inn under en NY device_id (key_revoked)", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-a3", kind: "mobile", public_key_pem: pem(keys) });
    await revoke("dev-a3");
    const reenrolled = await ticketEnroll("dev-a3-new", pem(keys));
    expect(reenrolled).toEqual({ ok: false, reason: "key_revoked" });
    const exists = await adminPool.query("SELECT 1 FROM devices WHERE device_id = 'dev-a3-new'");
    expect(exists.rowCount).toBe(0);
  });

  it("A4: tilbakekalling er idempotent og en ukjent enhet gir false (ingen stille suksess)", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-a4", kind: "mobile", public_key_pem: pem(keys) });
    const r1 = await withTenantTransaction(appPool, TENANT, (c) => devices.revokeDeviceKeyOn(c, { tenant_id: TENANT, device_id: "dev-a4" }, "x"));
    const r2 = await withTenantTransaction(appPool, TENANT, (c) => devices.revokeDeviceKeyOn(c, { tenant_id: TENANT, device_id: "dev-a4" }, "y"));
    const unknown = await withTenantTransaction(appPool, TENANT, (c) => devices.revokeDeviceKeyOn(c, { tenant_id: TENANT, device_id: "finnes-ikke" }, "z"));
    expect([r1, r2, unknown]).toEqual([true, true, false]);
  });

  it("A5: en revokert enhet kan IKKE lenger godkjenne klasse D (Pg-register slår opp ved hvert kall, ingen cache)", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-a5", kind: "watch", public_key_pem: pem(keys) });
    const registry = new PgDeviceRegistry(appPool);
    const policy = new PolicyGateway({ devices: registry, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const id: IdentityContext = { ...seed, session_id: "sess-a5", device_id: "dev-a5" };
    const toolCall = { tool_id: "ha", action: "unlock", capability_class: "D", parameters: { door: "front" } } as const;
    const mk = () => signApproval(keys.privateKey, {
      tool_id: "ha", action: "unlock", tenant_id: TENANT, person_id: PERSON, approver_person_id: PERSON,
      approving_device_id: "dev-a5", nonce: `nonce-${Math.random().toString(36).slice(2)}-xxxxxxxx`, parameters: { door: "front" }
    });
    expect((await policy.authorize({ identity: id, toolCall, approval: mk() })).decision).toBe("ALLOW");
    await revoke("dev-a5");
    const after = await policy.authorize({ identity: id, toolCall, approval: mk() });
    expect(after.decision).toBe("DENY");
    expect(after.reason).toBe("class_d_unknown_device");
  });
});

describe("B: JARVIS-051 - Ed25519-validering ved innrullering", () => {
  it("B1: en RSA-nøkkel avvises ved innrullering (unsupported_key_type), ingen rad skrives", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const result = await ticketEnroll("dev-b1-rsa", pem(rsa));
    expect(result).toEqual({ ok: false, reason: "unsupported_key_type" });
    expect((await adminPool.query("SELECT 1 FROM devices WHERE device_id = 'dev-b1-rsa'")).rowCount).toBe(0);
  });

  it("B2: søppel-PEM avvises (invalid_public_key), og registerDeviceTrusted kaster for RSA", async () => {
    expect(await ticketEnroll("dev-b2", "-----BEGIN PUBLIC KEY-----\nIKKE-EN-NOKKEL\n-----END PUBLIC KEY-----")).toEqual({ ok: false, reason: "invalid_public_key" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      devices.registerDeviceTrusted(seed, { device_id: "dev-b2-rsa", kind: "x", public_key_pem: pem(rsa) })
    ).rejects.toThrow(/unsupported_key_type/);
  });

  it("B3: en gyldig Ed25519-nøkkel rulles inn (positiv kontroll)", async () => {
    const result = await ticketEnroll("dev-b3", pem(generateKeyPairSync("ed25519")));
    expect(result.ok).toBe(true);
  });
});

describe("C: JARVIS-055 - én aktiv sesjon per (tenant, person)", () => {
  it("C1: 12 samtidige første autorisasjoner for en NY person gir nøyaktig ÉN aktiv sesjon", async () => {
    const racer = "person-r2racer";
    await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${racer}', 'Racer');
      INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${racer}', '${TENANT}', 'owner')`);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sessions.resumeOrCreate({ tenant_id: TENANT, person_id: racer, device_id: `dev-race-${i}` }, i % 2 ? "web" : "mobile")
      )
    );
    const ids = new Set(results.map((r) => r.session_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.resumed)).toHaveLength(1);
    const active = await adminPool.query("SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, racer]);
    expect(active.rows[0].n).toBe(1);
  });

  it("C2: STRUKTURELL garanti - to rå klienter uten lås kan ikke begge sette inn en aktiv sesjon (23505)", async () => {
    const person = "person-r2raw";
    await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${person}', 'Raw');
      INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${person}', '${TENANT}', 'owner')`);
    const a = await adminPool.connect();
    const b = await adminPool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query("INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ('sess-raw-a', $1, $2, 'web', 'd')", [TENANT, person]);
      // b blokkerer på a sin ikke-committede unike nøkkel, så avgjøres den når a committer
      const bInsert = b.query("INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ('sess-raw-b', $1, $2, 'web', 'd')", [TENANT, person]);
      await a.query("COMMIT");
      await expect(bInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
    const active = await adminPool.query("SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, person]);
    expect(active.rows[0].n).toBe(1);
  });

  it("C3: en LUKKET sesjon blokkerer ikke en ny aktiv (indeksen er delvis på status='active')", async () => {
    const person = "person-r2closed";
    await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${person}', 'C');
      INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${person}', '${TENANT}', 'owner')`);
    const first = await sessions.resumeOrCreate({ tenant_id: TENANT, person_id: person, device_id: "d" }, "web");
    await adminPool.query("UPDATE sessions SET status = 'closed' WHERE session_id = $1", [first.session_id]);
    const second = await sessions.resumeOrCreate({ tenant_id: TENANT, person_id: person, device_id: "d" }, "web");
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.resumed).toBe(false);
  });
});

describe("D: godkjenninger - eier-rolle og lagret binding", () => {
  it("D1: PgDeviceRegistry skiller eier- og delegat-enheter (is_owner)", async () => {
    const ownerKeys = generateKeyPairSync("ed25519");
    const delegateKeys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-d1-owner", kind: "watch", public_key_pem: pem(ownerKeys) });
    await devices.registerDeviceTrusted({ ...seed, person_id: DELEGATE }, { device_id: "dev-d1-delegate", kind: "phone", public_key_pem: pem(delegateKeys) });
    const registry = new PgDeviceRegistry(appPool);
    expect((await registry.approverFor("dev-d1-owner", TENANT))?.is_owner).toBe(true);
    expect((await registry.approverFor("dev-d1-delegate", TENANT))?.is_owner).toBe(false);
    expect(await registry.approverFor("dev-d1-owner", "tenant-annen")).toBeUndefined();
  });

  it("D2: en delegat kan ikke selv-godkjenne klasse D via Pg-registeret", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted({ ...seed, person_id: DELEGATE }, { device_id: "dev-d2", kind: "phone", public_key_pem: pem(keys) });
    const policy = new PolicyGateway({ devices: new PgDeviceRegistry(appPool), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const result = await policy.authorize({
      identity: { ...seed, person_id: DELEGATE, session_id: "sess-d2", device_id: "dev-d2" },
      toolCall: { tool_id: "ha", action: "unlock", capability_class: "D", parameters: { door: "front" } },
      approval: signApproval(keys.privateKey, {
        tool_id: "ha", action: "unlock", tenant_id: TENANT, person_id: DELEGATE, approver_person_id: DELEGATE,
        approving_device_id: "dev-d2", nonce: "nonce-d2-selvgodkjenning-0001", parameters: { door: "front" }
      })
    });
    expect(result.reason).toBe("class_d_approver_not_owner");
  });

  it("D3: nonce-forbruket lagrer hele bindingen (verktøy, parameter-hash, forespørrende og godkjennende person)", async () => {
    const keys = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seed, { device_id: "dev-d3", kind: "watch", public_key_pem: pem(keys) });
    const policy = new PolicyGateway({ devices: new PgDeviceRegistry(appPool), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const approval = signApproval(keys.privateKey, {
      tool_id: "ha", action: "unlock", tenant_id: TENANT, person_id: DELEGATE, approver_person_id: PERSON,
      approving_device_id: "dev-d3", nonce: "nonce-d3-bundet-binding-0001", parameters: { door: "front" }
    });
    const decision = await policy.authorize({
      identity: { ...seed, person_id: DELEGATE, session_id: "sess-d3", device_id: "dev-x" },
      toolCall: { tool_id: "ha", action: "unlock", capability_class: "D", parameters: { door: "front" } },
      approval
    });
    expect(decision.decision).toBe("ALLOW");
    const row = (await adminPool.query("SELECT tool_id, parameters_hash, requester_person_id, approver_person_id, issued_at FROM approvals WHERE nonce = $1", [approval.nonce])).rows[0];
    expect(row.tool_id).toBe("ha");
    expect(row.parameters_hash).toBe(hashApprovalParameters({ door: "front" }));
    expect(row.requester_person_id).toBe(DELEGATE);
    expect(row.approver_person_id).toBe(PERSON);
    expect(row.issued_at).not.toBeNull();
  });
});
