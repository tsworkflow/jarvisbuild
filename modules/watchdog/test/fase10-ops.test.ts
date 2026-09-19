import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  BackupService, MemoryAlertSink, Watchdog, costExplosionCheck, costReport, databaseCheck, stuckTasksCheck
} from "@jarvis/watchdog";

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg10-"));
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
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id)
      VALUES ('sess-1','tenant-a','person-tobias','web','dev-pc');
    INSERT INTO messages (message_id, tenant_id, session_id, role, content)
      VALUES ('msg-1','tenant-a','sess-1','user','backup meg gamma42');
    INSERT INTO cost_events (tenant_id, task_id, kind, amount_ore) VALUES
      ('tenant-a','task-x','model:scripted', 1200), ('tenant-a', NULL, 'model:openai', 800);
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Akseptanse 1: watchdog oppdager simulert feil og varsler med runbook", () => {
  it("fastlåst jobb (utløpt lease) gir warning-varsel med runbook; reversibelt tiltak maks N ganger", async () => {
    await adminPool.query(`
      INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, contract, status, worker_id, lease_expires_at)
      VALUES ('task-stuck','tenant-a','person-tobias','g','{}'::jsonb,'running','w1', now() - interval '1 minute')
    `);
    const sink = new MemoryAlertSink();
    const killSwitch = new KillSwitch();
    const watchdog = new Watchdog(sink, killSwitch);
    watchdog.register(databaseCheck(appPool));
    // W1 (D-180): `appPool` (RLS-underlagt rolle) + eksplisitt tenant - var
    // `adminPool` (superuser), som maskerte at `tasks` er FORCE RLS-beskyttet.
    watchdog.register(stuckTasksCheck(appPool, ["tenant-a"]));
    let restarts = 0;
    watchdog.registerAction("stuck_tasks", async () => { restarts += 1; }, 2);

    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick(); // tredje: maks forsøk nådd
    const alerts = sink.alerts.filter((a) => a.check === "stuck_tasks");
    expect(alerts.length).toBe(3);
    expect(alerts[0]?.severity).toBe("warning");
    expect(alerts[0]?.runbook).toContain("TIER1_RUNBOOKS");
    expect(restarts).toBe(2); // aldri flere enn maks - ingen løpsk selvreparasjon
    await adminPool.query("DELETE FROM tasks WHERE task_id = 'task-stuck'");
  });

  it("krasjende sjekk gir critical-varsel (fail-closed rapportering)", async () => {
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, new KillSwitch());
    watchdog.register({ name: "boom", runbook: "docs/runbooks/TIER1_RUNBOOKS.md", run: async () => { throw new Error("db down"); } });
    await watchdog.tick();
    expect(sink.alerts[0]?.severity).toBe("critical");
  });
});

describe("Kill switch-kriterium: kostnadseksplosjon", () => {
  // W1 (D-180): DENNE testen var selve MASKERINGEN D182 fant. Den brukte en
  // pool-LØS `new KillSwitch()` (ren in-memory) OG en superuser-`adminPool`
  // (RLS omgått), og kunne derfor ikke se NOEN av de to
  // produksjonsdefektene: at nødstoppen aldri ble skrevet durabelt, og at
  // `cost_events`-summen alltid ville vært 0 under den ekte runtime-rollen.
  // Den er nå bundet til den POOL-BASERTE, durable stien via den
  // RLS-underlagte `appPool`. Full durabilitets-/kryss-instans-/omstarts-/
  // varslingsfeil-dekning ligger i `w1-watchdog-durability.test.ts`.
  it("over hardgrense → durabel kill switch aktiveres → Policy Gateway nekter alt", async () => {
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ('tenant-a','model:x', 400000)");
    const sink = new MemoryAlertSink();
    const authority = { owner_person_id: "person-tobias" };
    const killSwitch = new KillSwitch(appPool, authority);
    const watchdog = new Watchdog(sink, killSwitch);
    watchdog.register(
      costExplosionCheck(appPool, killSwitch, {
        hardLimitOre: 300_000, tenantIds: ["tenant-a"], actorPersonId: "person-tobias"
      })
    );
    await watchdog.tick();
    expect(await killSwitch.isActiveDurable()).toBe(true);
    expect(sink.alerts[0]?.severity).toBe("critical");

    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch
    });
    const denied = await policy.authorize({
      identity: { person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
                  session_id: "s", device_id: "d", channel: "web", auth_strength: "active" },
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(denied.reason).toBe("kill_switch_active");
    // Reversibelt: manuell deaktivering gjenoppretter - ingen automatisk gjenåpning.
    await killSwitch.deactivateDurable("person-tobias");
    await adminPool.query("DELETE FROM cost_events WHERE amount_ore = 400000");
  });
});

describe("Akseptanse 2: backup + restore med målt tid (Tier 1)", () => {
  it("full backup → restore i fersk database → data verifisert; tid godt innen RTO", async () => {
    const backupDir = await mkdtemp(join(tmpdir(), "jarvis-backup-"));
    const service = new BackupService(adminPool);
    const backup = await service.backup(backupDir);
    expect(backup.rows).toBeGreaterThan(5);

    await epg.createDatabase("jarvis_restore");
    const restorePool = new pg.Pool({
      host: "127.0.0.1", port: PORT, database: "jarvis_restore", user: "postgres", password: "pw"
    });
    await runMigrations(restorePool);
    const restore = await service.restore(backupDir, restorePool);
    expect(restore.rows).toBe(backup.rows);

    const message = await restorePool.query("SELECT content FROM messages WHERE message_id = 'msg-1'");
    expect(message.rows[0]?.content).toContain("gamma42");
    const audit = await restorePool.query("SELECT count(*)::int AS n FROM audit_events");
    const original = await adminPool.query("SELECT count(*)::int AS n FROM audit_events");
    expect(audit.rows[0].n).toBe(original.rows[0].n); // audit-integritet bevart

    console.log(JSON.stringify({ backup_ms: Math.round(backup.duration_ms), restore_ms: Math.round(restore.duration_ms) }));
    expect(restore.duration_ms).toBeLessThan(4 * 3600 * 1000); // RTO Tier 1: 4 timer
    await restorePool.end();
  }, 120_000);
});

describe("Akseptanse 3: kostnad synlig per modell/tenant/oppgave", () => {
  it("rapporten grupperer korrekt", async () => {
    const report = await costReport(adminPool);
    expect(report.by_kind.find((r) => r.kind === "model:scripted")?.ore).toBe(1200);
    expect(report.by_tenant[0]?.tenant_id).toBe("tenant-a");
    expect(report.by_task.find((r) => r.task_id === "task-x")?.ore).toBe(1200);
  });
});
