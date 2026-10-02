import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  ArtifactStore, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, TaskService,
  createCodingHandler, type CodingAgentAdapter, type CodingAgentExec,
  type ExecResult, type Sandbox, type SandboxRunner
} from "@jarvis/tasks";
import { proposeRepairTask } from "../src/repair.ts";
import { IncidentService } from "../src/service.ts";

/**
 * D-104 Part C (incident -> tested-fix-pipeline): EKTE embedded-Postgres +
 * EKTE lokalt git-bare-repo (ALDRI github.com) - beviser Part I-item 3
 * (en hendelse kan skape en reparasjonsjobb gjennom DEN KANONISKE, allerede
 * D-103-live-bevist testet-fiks-pipelinen) og item 4 (INGEN "fullført" når
 * uavhengige tester feiler - `createCodingHandler` gjenbrukes 100% uendret,
 * denne testen orkestrerer ALDRI selv klone/test/commit/push).
 */

const identity: IdentityContext = {
  person_id: "person-repair", tenant_id: "tenant-repair", memory_space_id: "business",
  session_id: "sess-repair", device_id: "dev-1", channel: "api", auth_strength: "active"
};

class WritingFakeAgent implements CodingAgentAdapter {
  readonly name = "fake-agent";
  async modify(exec: CodingAgentExec, _goal: string): Promise<string> {
    exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','fix applied')"]);
    return "endret CHANGES.md";
  }
}

/** Skriver om et github.com-formet repo_url til et EKTE lokalt bare-repo - samme presedens som pr-publisher.test.ts/coding-git-auth-wiring.test.ts. */
class RepoUrlRedirectingSandboxRunner implements SandboxRunner {
  readonly name = "redirect-sandbox";
  constructor(private readonly inner: SandboxRunner, private readonly redirectFrom: string, private readonly redirectTo: string) {}
  async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
    const sandbox = await this.inner.create(jobEnv);
    return {
      workdir: sandbox.workdir,
      exec: (command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult =>
        sandbox.exec(command, args.map((a) => (a === this.redirectFrom ? this.redirectTo : a)), timeoutMs, extraEnv),
      dispose: () => sandbox.dispose()
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let bareRepo: string;
const TENANT = "tenant-repair";
const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-d104-repair-test.git";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-repair-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_repair LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_repair");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Repair','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-repair','Repair');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-repair','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_repair", password: "pw2" });

  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-repair-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-repair-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  spawnSync("node", ["-e", "const fs=require('fs');fs.writeFileSync('README.md','# repo');fs.writeFileSync('pass.js','process.exit(0)');fs.writeFileSync('fail.js','process.exit(1)')"], { cwd: seed });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function buildTaskService(): { taskService: TaskService; queue: PgTaskQueue; worker: InProcessWorker; incidents: IncidentService } {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const queue = new PgTaskQueue(appPool);
  const taskService = new TaskService(appPool, queue, policy);
  const worker = new InProcessWorker(queue, 60);
  const sandbox = new RepoUrlRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
  worker.register("coding", createCodingHandler({
    sandbox, agent: new WritingFakeAgent(), artifacts: new ArtifactStore(appPool), policy,
    identityFor: () => identity
  }));
  return { taskService, queue, worker, incidents: new IncidentService(appPool) };
}

describe("D-104 Part C: incident -> DEN KANONISKE testet-fiks-pipelinen (EKTE Postgres + EKTE lokalt git-bare-repo)", () => {
  it("A: proposeRepairTask() sender inn en jobb via DEN EKSISTERENDE TaskService.submit() - jobben fullfører gjennom HELE D-102/D-103-pipelinen uendret (klone->endre->test->commit->push)", async () => {
    const { taskService, worker, incidents } = buildTaskService();
    const incident = await incidents.createIncident(TENANT, "business", { title: "produksjonsfeil krever fiks" });

    const result = await proposeRepairTask({ taskService, pool: appPool, incidents }, identity, "business", incident, {
      repo_url: GITHUB_SHAPED_URL, goal: "fiks produksjonsfeilen", test_command: ["node", "pass.js"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await worker.drain();

    // tasks/incident_repair_tasks har FORCE RLS (005_rls.sql/036_incidents.sql) - en rå
    // diagnostisk spørring uten satt jarvis.tenant_id-kontekst MÅ gå via superbruker-
    // poolen (samme presedens som D-103 sin worker-claim-routing.test.ts).
    const taskRow = await adminPool.query("SELECT status FROM tasks WHERE task_id = $1", [result.task_id]);
    expect(taskRow.rows[0]?.status).toBe("completed");

    // Audit-linkage (item 15): incident_repair_tasks kobler hendelsen til DENNE jobben.
    const link = await adminPool.query(
      "SELECT incident_id, task_id FROM incident_repair_tasks WHERE incident_id = $1 AND task_id = $2", [incident.incident_id, result.task_id]
    );
    expect(link.rows).toHaveLength(1);

    // Hendelsen flyttet deterministisk til repair_proposed ved vellykket innsending.
    const updated = await incidents.getIncident(TENANT, "business", incident.incident_id);
    expect(updated?.status).toBe("repair_proposed");
  }, 30_000);

  it("B: INGEN 'completed' når den uavhengige testporten feiler (item 4) - jobben feiler, INGEN push skjer, incident_repair_tasks-lenken finnes likevel (jobben BLE forsøkt, sporbart)", async () => {
    const { taskService, worker, incidents } = buildTaskService();
    const incident = await incidents.createIncident(TENANT, "business", { title: "fiks som ikke bestaar tester" });

    const result = await proposeRepairTask({ taskService, pool: appPool, incidents }, identity, "business", incident, {
      repo_url: GITHUB_SHAPED_URL, goal: "fiks noe", test_command: ["node", "fail.js"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await worker.drain();

    const taskRow = await adminPool.query("SELECT status, last_error FROM tasks WHERE task_id = $1", [result.task_id]);
    expect(taskRow.rows[0]?.status).toBe("failed");
    expect(taskRow.rows[0]?.last_error).toContain("tests_failed");

    // DEN UAVHENGIGE testporten kan ALDRI omgås av en agent som selv hevder suksess -
    // ScriptedCodingAgent/WritingFakeAgent har INGEN mulighet til å påvirke test-utfallet.
    const link = await adminPool.query(
      "SELECT 1 FROM incident_repair_tasks WHERE incident_id = $1 AND task_id = $2", [incident.incident_id, result.task_id]
    );
    expect(link.rows).toHaveLength(1); // jobben ble sporbart forsøkt, selv om den feilet
  }, 30_000);

  it("C: repo_url/incident_id sendes gjennom i input.data - kontrakten er en STANDARD JobContract, INGEN ny agent_profile/skjemautvidelse", async () => {
    const { taskService, incidents } = buildTaskService();
    const incident = await incidents.createIncident(TENANT, "business", { title: "kontrakt-form" });
    const originalSubmit = taskService.submit.bind(taskService);
    let capturedContract: JobContract | undefined;
    taskService.submit = async (id, contract) => {
      capturedContract = contract as JobContract;
      return originalSubmit(id, contract);
    };
    const result = await proposeRepairTask({ taskService, pool: appPool, incidents }, identity, "business", incident, {
      repo_url: GITHUB_SHAPED_URL, goal: "test", test_command: ["node", "pass.js"]
    });
    expect(result.ok).toBe(true);
    expect(capturedContract?.agent_profile).toBe("coding");
    expect((capturedContract?.input.data as Record<string, unknown>)["incident_id"]).toBe(incident.incident_id);
    expect((capturedContract?.input.data as Record<string, unknown>)["repo_url"]).toBe(GITHUB_SHAPED_URL);
  });

  it("D: manglende gyldig incident (kalleren MÅ selv hente den) - proposeRepairTask forutsetter en allerede-lastet Incident, kaster ALDRI en useriøs jobb for en ikke-eksisterende hendelse fra server.ts (verifisert der: 404 FØR proposeRepairTask kalles)", async () => {
    const { taskService, incidents } = buildTaskService();
    // Direkte bevis på kontraktens forutsetning: en konstruert Incident med en id som
    // IKKE finnes i incidents-tabellen feiler FK-constrainten på incident_repair_tasks-innsettingen.
    const fakeIncident = {
      incident_id: "inc-does-not-exist", tenant_id: TENANT, memory_space_id: "business" as const,
      title: "x", status: "open" as const, severity: "normal" as const, owner_person_id: null,
      opened_at: new Date().toISOString(), resolved_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    await expect(
      proposeRepairTask({ taskService, pool: appPool, incidents }, identity, "business", fakeIncident, {
        repo_url: GITHUB_SHAPED_URL, goal: "test", test_command: ["node", "pass.js"]
      })
    ).rejects.toThrow();
  });
});
