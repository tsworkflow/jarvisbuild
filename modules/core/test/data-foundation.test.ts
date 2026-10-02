import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EventWriter,
  IdentityService,
  PgApprovalStore,
  SessionService,
  createPool,
  runMigrations,
  withTenantTransaction
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { hashApprovalParameters, type EventEnvelope } from "@jarvis/contracts";

// Ekte PostgreSQL 16 (embedded) - ingen mocks. Datamappe utenfor repoet.
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

let identityService: IdentityService;
let sessionService: SessionService;
let eventWriter: EventWriter;
let approvalStore: PgApprovalStore;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "test-superuser-pw",
    port,
    persistent: false
  })
,
    // D-141 B: proben maa bruke instansens EGNE credentials.
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");

  adminPool = new pg.Pool({
    host: "127.0.0.1",
    port: PORT,
    database: "jarvis_test",
    user: "postgres",
    password: "test-superuser-pw"
  });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);

  await runMigrations(adminPool);

  // Innloggingsrolle for tester; arver jarvis_app (ingen RLS-bypass, ikke superuser).
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");

  // Seed (som admin, bypasser RLS bevisst): to tenants, personer, enheter, spaces.
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES
      ('tenant-a', 'Tobias personlig', 'person'),
      ('tenant-b', 'Kundeoppfoelging AS', 'business');
    INSERT INTO people (person_id, display_name) VALUES
      ('person-tobias', 'Tobias'),
      ('person-ansatt', 'Ansatt B');
    INSERT INTO person_tenants (person_id, tenant_id, role) VALUES
      ('person-tobias', 'tenant-a', 'owner'),
      ('person-tobias', 'tenant-b', 'owner'),
      ('person-ansatt', 'tenant-b', 'member');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES
      ('dev-pc', 'tenant-a', 'person-tobias', 'pc'),
      ('dev-phone', 'tenant-a', 'person-tobias', 'phone'),
      ('dev-b-pc', 'tenant-b', 'person-tobias', 'pc');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('space-a-personal', 'tenant-a', 'personal'),
      ('space-a-home', 'tenant-a', 'home'),
      ('space-b-business', 'tenant-b', 'business');
  `);

  appPool = createPool({
    host: "127.0.0.1",
    port: PORT,
    database: "jarvis_test",
    user: "jarvis_test",
    password: "test-app-pw"
  });
  identityService = new IdentityService(appPool);
  sessionService = new SessionService(appPool);
  eventWriter = new EventWriter(appPool);
  approvalStore = new PgApprovalStore(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: randomUUID(),
    idempotency_key: `key-${randomUUID()}`,
    occurred_at: new Date().toISOString(),
    source: "test",
    type: "test.event",
    tenant_id: "tenant-a",
    person_id: "person-tobias",
    trust_level: "internal",
    payload: { hello: "world" },
    ...overrides
  };
}

describe("Akseptanse 1: tenant-isolasjon på databasenivå (RLS)", () => {
  it("app-rollen ser kun egen tenants rader", async () => {
    const a = await withTenantTransaction(appPool, "tenant-a", (c) =>
      c.query("SELECT device_id FROM devices ORDER BY device_id")
    );
    expect(a.rows.map((r) => r.device_id)).toEqual(["dev-pc", "dev-phone"]);

    const b = await withTenantTransaction(appPool, "tenant-b", (c) =>
      c.query("SELECT device_id FROM devices ORDER BY device_id")
    );
    expect(b.rows.map((r) => r.device_id)).toEqual(["dev-b-pc"]);
  });

  it("uten tenant-kontekst er alt skjult (default deny)", async () => {
    const client = await appPool.connect();
    try {
      const result = await client.query("SELECT count(*)::int AS n FROM devices");
      expect(result.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("skriving til annen tenant avvises av WITH CHECK", async () => {
    await expect(
      withTenantTransaction(appPool, "tenant-a", (c) =>
        c.query(
          "INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-smuglet', 'tenant-b', 'person-tobias', 'pc')"
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("people er kun synlige via medlemskap i gjeldende tenant", async () => {
    const a = await withTenantTransaction(appPool, "tenant-a", (c) =>
      c.query("SELECT person_id FROM people ORDER BY person_id")
    );
    expect(a.rows.map((r) => r.person_id)).toEqual(["person-tobias"]);
    const b = await withTenantTransaction(appPool, "tenant-b", (c) =>
      c.query("SELECT person_id FROM people ORDER BY person_id")
    );
    expect(b.rows.map((r) => r.person_id)).toEqual(["person-ansatt", "person-tobias"]);
  });

  it("cross-tenant lesing via service: identitet i feil tenant avvises", async () => {
    const result = await identityService.resolveIdentity({
      person_id: "person-ansatt",
      tenant_id: "tenant-a", // person-ansatt er ikke medlem av tenant-a
      memory_space: "personal",
      session_id: "sess-x",
      device_id: "dev-pc",
      channel: "web",
      auth_strength: "active"
    });
    expect(result).toEqual({ ok: false, reason: "unknown_membership" });
  });
});

describe("Append-only hendelseslogg", () => {
  it("UPDATE og DELETE på events avvises i databasen", async () => {
    const event = envelope();
    await eventWriter.append(event);
    await expect(
      withTenantTransaction(appPool, "tenant-a", (c) =>
        c.query("UPDATE events SET type = 'manipulert' WHERE event_id = $1", [event.event_id])
      )
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(appPool, "tenant-a", (c) =>
        c.query("DELETE FROM events WHERE event_id = $1", [event.event_id])
      )
    ).rejects.toThrow();
  });

  it("audit_events kan ikke endres eller slettes", async () => {
    await expect(
      withTenantTransaction(appPool, "tenant-a", (c) => c.query("DELETE FROM audit_events"))
    ).rejects.toThrow();
  });
});

describe("Akseptanse 2: idempotente hendelser", () => {
  it("samme idempotency_key to ganger gir nøyaktig én rad", async () => {
    const event = envelope();
    const first = await eventWriter.append(event);
    const second = await eventWriter.append({ ...event, event_id: randomUUID() });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const count = await withTenantTransaction(appPool, "tenant-a", (c) =>
      c.query("SELECT count(*)::int AS n FROM events WHERE idempotency_key = $1", [event.idempotency_key])
    );
    expect(count.rows[0].n).toBe(1);
  });
});

describe("Akseptanse 3: sesjonsgjenopptak på tvers av kanal", () => {
  it("sesjon opprettet på web gjenopptas fra mobil med samme session_id", async () => {
    const principal = { tenant_id: "tenant-a", person_id: "person-tobias", device_id: "dev-pc" };
    const created = await sessionService.resumeOrCreate(principal, "web");
    expect(created.resumed).toBe(false);

    const resumed = await sessionService.resumeOrCreate(
      { ...principal, device_id: "dev-phone" },
      "mobile"
    );
    expect(resumed.session_id).toBe(created.session_id);
    expect(resumed.resumed).toBe(true);

    const row = await withTenantTransaction(appPool, "tenant-a", (c) =>
      c.query("SELECT last_channel, last_device_id FROM sessions WHERE session_id = $1", [created.session_id])
    );
    expect(row.rows[0]).toEqual({ last_channel: "mobile", last_device_id: "dev-phone" });
  });

  it("sesjoner krysser aldri tenant-grensen", async () => {
    const a = await sessionService.resumeOrCreate(
      { tenant_id: "tenant-a", person_id: "person-tobias", device_id: "dev-pc" },
      "web"
    );
    const b = await sessionService.resumeOrCreate(
      { tenant_id: "tenant-b", person_id: "person-tobias", device_id: "dev-b-pc" },
      "web"
    );
    expect(b.session_id).not.toBe(a.session_id);
  });
});

describe("Akseptanse 4: audit med full identitetskontekst", () => {
  it("identity/session/event-skrivinger produserer audit-rader", async () => {
    const resolved = await identityService.resolveIdentity({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      memory_space: "personal",
      session_id: "sess-audit",
      device_id: "dev-pc",
      channel: "web",
      auth_strength: "active"
    });
    expect(resolved.ok).toBe(true);

    const audit = await withTenantTransaction(appPool, "tenant-a", (c) =>
      c.query(
        `SELECT type, tenant_id, person_id FROM audit_events
         WHERE type IN ('identity.resolved','identity.denied','session.created','session.resumed',
                        'event.recorded','event.duplicate_ignored')
         ORDER BY audit_id`
      )
    );
    const types = new Set(audit.rows.map((r) => r.type));
    for (const expected of [
      "identity.resolved",
      "identity.denied",
      "session.created",
      "session.resumed",
      "event.recorded",
      "event.duplicate_ignored"
    ]) {
      expect(types.has(expected), `mangler audit-type ${expected}`).toBe(true);
    }
    for (const row of audit.rows) {
      expect(row.tenant_id).toBe("tenant-a");
      expect(row.person_id).toBeTruthy();
    }
  });
});

describe("Persistent godkjenningslager (replay-vern i database)", () => {
  function context(nonce: string) {
    return {
      nonce,
      tenant_id: "tenant-a",
      tool_id: "ha",
      action: "unlock_front_door",
      parameters: { door: "front" },
      parameters_hash: hashApprovalParameters({ door: "front" }),
      requester_person_id: "person-tobias",
      approver_person_id: "person-tobias",
      approving_device_id: "dev-phone",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };
  }

  it("nonce kan bare forbrukes én gang", async () => {
    const ctx = context(`nonce-${randomUUID()}`);
    expect(await approvalStore.consume(ctx)).toBe(true);
    expect(await approvalStore.consume(ctx)).toBe(false);
  });

  it("samtidige forsøk: nøyaktig ett vinner", async () => {
    const ctx = context(`nonce-${randomUUID()}`);
    const results = await Promise.all(Array.from({ length: 5 }, () => approvalStore.consume(ctx)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
