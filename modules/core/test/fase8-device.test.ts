import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApproval, type ApprovalPayload, type IdentityContext, type JsonValue, type SignedApproval } from "@jarvis/contracts";
import { DeviceService, FakePushAdapter, PgApprovalStore, PgDeviceRegistry, SessionService, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
const watchKeys = generateKeyPairSync("ed25519");
const rogueKeys = generateKeyPairSync("ed25519");
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-f8", device_id: "dev-pc", channel: "web", auth_strength: "active"
};

function approval(
  overrides: Partial<Omit<ApprovalPayload, "parameters_hash">> & { parameters?: Record<string, JsonValue> } = {},
  key = watchKeys.privateKey
): SignedApproval {
  const { parameters = { door: "front" }, ...rest } = overrides;
  return signApproval(key, {
    tool_id: "ha", action: "unlock_front_door", tenant_id: identity.tenant_id, person_id: identity.person_id,
    approver_person_id: identity.person_id, nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-tobias",
    parameters, ...rest
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg8-"));
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
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person'), ('tenant-b','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a'), ('person-tobias','tenant-b');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-pc','tenant-a','person-tobias','pc');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  devices = new DeviceService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Enhetsidentitet: registrering + DB-basert godkjenningsverifisering", () => {
  it("registrert Watch-nøkkel verifiserer klasse D via PgDeviceRegistry; uregistrert enhet DENY", async () => {
    await devices.registerDeviceTrusted(identity, {
      device_id: "watch-tobias", kind: "watch",
      public_key_pem: watchKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
    });
    const registry = new PgDeviceRegistry(appPool, "tenant-a");
    const policy = new PolicyGateway({
      devices: registry, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch()
    });
    const toolCall = { tool_id: "ha", action: "unlock_front_door", capability_class: "D", parameters: { door: "front" } } as const;

    const ok = await policy.authorize({ identity, toolCall, approval: approval() });
    expect(ok.decision).toBe("ALLOW");

    const unknown = await policy.authorize({
      identity, toolCall, approval: approval({ approving_device_id: "uregistrert" })
    });
    expect(unknown.reason).toBe("class_d_unknown_device");

    // Enhet registrert, men signert med FEIL nøkkel => DENY (klient-ID alene stoles aldri på)
    const forged = await policy.authorize({ identity, toolCall, approval: approval({}, rogueKeys.privateKey) });
    expect(forged.reason).toBe("class_d_invalid_signature");
  });

  it("enhetsnøkler er tenant-isolerte (RLS): tenant-b ser ikke tenant-a sin Watch", async () => {
    const registryB = new PgDeviceRegistry(appPool, "tenant-b");
    expect(await registryB.approverFor("watch-tobias", "tenant-b")).toBeUndefined();
    expect(await registryB.approverFor("watch-tobias", "tenant-a")).toBeDefined();
  });

  it("challenge-respons: gyldig signatur bevises; replay og feil nøkkel avvises", async () => {
    const challenge = devices.issueChallenge("watch-tobias");
    const signature = sign(null, Buffer.from(challenge, "utf8"), watchKeys.privateKey).toString("base64");
    // D-131b: `verifyChallenge()` returnerer nå fingerprinten av nøkkelen som
    // FAKTISK verifiserte (ikke lenger en bar boolean) - se device-service.ts.
    const proven = await devices.verifyChallenge("tenant-a", "watch-tobias", challenge, signature);
    expect(proven).not.toBeNull();
    expect(proven).toMatch(/^[0-9a-f]{64}$/);
    // engangs: samme challenge igjen => null
    expect(await devices.verifyChallenge("tenant-a", "watch-tobias", challenge, signature)).toBeNull();
    const challenge2 = devices.issueChallenge("watch-tobias");
    const badSig = sign(null, Buffer.from(challenge2, "utf8"), rogueKeys.privateKey).toString("base64");
    expect(await devices.verifyChallenge("tenant-a", "watch-tobias", challenge2, badSig)).toBeNull();
  });
});

describe("Kanalkontinuitet + push-adapter", () => {
  it("mobil-kanalen gjenopptar samme sesjon som web", async () => {
    const sessions = new SessionService(appPool);
    const web = await sessions.resumeOrCreate({ tenant_id: "tenant-a", person_id: "person-tobias", device_id: "dev-pc" }, "web");
    const mobile = await sessions.resumeOrCreate({ tenant_id: "tenant-a", person_id: "person-tobias", device_id: "watch-tobias" }, "mobile");
    expect(mobile.session_id).toBe(web.session_id);
    expect(mobile.resumed).toBe(true);
  });

  it("push-adapter: fake leverer; APNs-skall feiler ærlig som uverifisert", async () => {
    const push = new FakePushAdapter();
    await push.send("watch-tobias", "Jobb ferdig", "task-123 fullført");
    expect(push.sent).toHaveLength(1);
    const { ApnsPushAdapter } = await import("@jarvis/core");
    await expect(new ApnsPushAdapter().send()).rejects.toThrow("apns_unverified");
  });
});
