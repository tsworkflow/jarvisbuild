import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ExecResult, Sandbox, SandboxRunner, TaskService, TaskView } from "@jarvis/tasks";
import type { PrPublishingGateway, ToolExecutionResult } from "@jarvis/tasks";
import type { CiStatus, SelfModificationGithubClient } from "../src/github-client.ts";
import { SelfModificationService } from "../src/service.ts";

/**
 * Task #121 (D-214): ende-til-ende-bevis for `SelfModificationService` mot
 * EKTE Postgres (`self_modification_requests`, migrasjon 060) - SAMME
 * embedded-postgres-mønster som `modules/owner-controls/test/
 * owner-control-authority.test.ts`. Sandbox/GitHub/PR-avhengighetene er
 * BEVISST faket (ingen ekte nettverk/git-binær nødvendig) - selve
 * git-KOMMANDOSEKVENSEN verifiseres strukturelt via `FakeSandbox.calls`.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const OWNER = "person-selfmod-owner";
const OTHER = "person-selfmod-other";

const ownerIdentity: IdentityContext = {
  person_id: OWNER, tenant_id: "tenant-personal", memory_space_id: "personal",
  session_id: "sess-selfmod", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const otherIdentity: IdentityContext = { ...ownerIdentity, person_id: OTHER };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-selfmod-"));
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
  await adminPool.query("CREATE ROLE jarvis_selfmod_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_selfmod_test");
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner'), ('${OTHER}', 'Other')`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_selfmod_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(async () => {
  await appPool.query("DELETE FROM self_modification_requests");
});

/** Bevisst FAKET - INGEN ekte git-binær/nettverk. Scripter svar per (command, argv[0]) og logger hvert kall for strukturell verifisering. */
/**
 * `netArgs()` (service.ts) prefikser `clone`/`push` med `-c <flag>`-par
 * (kredensial-isolasjon, se git-auth.ts) FØR selve subkommandoen - `args[0]`
 * er derfor "-c", ALDRI subkommandoen, for AKKURAT disse to kallene. Denne
 * hjelperen hopper over hvert `-c <verdi>`-par og returnerer den FAKTISKE
 * subkommandoen, uansett om kallet er nettverksautentisert eller ikke.
 */
function gitSubcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

class FakeSandbox implements Sandbox {
  readonly workdir = "/fake/selfmod";
  calls: Array<{ command: string; args: string[]; extraEnv?: Record<string, string> }> = [];
  disposed = false;
  stagedPathsOverride: string | undefined;
  failOn: string | undefined;

  exec(command: string, args: string[], _timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult {
    this.calls.push({ command, args, ...(extraEnv ? { extraEnv } : {}) });
    const key = `${command} ${command === "git" ? gitSubcommand(args) : (args[0] ?? "")}`;
    if (this.failOn && key.startsWith(this.failOn)) {
      return { code: 1, stdout: "", stderr: `simulated_failure:${key}` };
    }
    if (command === "git" && gitSubcommand(args) === "diff") {
      return { code: 0, stdout: this.stagedPathsOverride ?? "config/charlie-personality.json\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeSandboxRunner implements SandboxRunner {
  readonly name = "fake-selfmod-sandbox";
  lastSandbox: FakeSandbox | undefined;
  createCalls = 0;
  configure: (sandbox: FakeSandbox) => void = () => undefined;

  async create(): Promise<Sandbox> {
    this.createCalls++;
    const sandbox = new FakeSandbox();
    this.configure(sandbox);
    this.lastSandbox = sandbox;
    return sandbox;
  }
}

class FakePrGateway implements PrPublishingGateway {
  calls: Array<{ tool_id: string; action: string; parameters: Record<string, JsonValue> }> = [];
  prNumber = "42";
  ok = true;

  async execute(request: { tool_id: string; action: string; parameters: Record<string, JsonValue> }): Promise<ToolExecutionResult> {
    this.calls.push(request);
    if (!this.ok) return { ok: false, reason: "simulated_pr_publish_failure" };
    return {
      ok: true,
      external_id: this.prNumber,
      data: {
        number: this.prNumber,
        html_url: `https://github.com/tsworkflow/jarvisbuild/pull/${this.prNumber}`,
        created: true
      },
      output_trust: "internal" as TrustLevel,
      deduplicated: false
    };
  }
}

class FakeGithubClient implements SelfModificationGithubClient {
  ciStatus: CiStatus = "success";
  changedFiles: string[] = ["config/charlie-personality.json"];
  headSha = "deadbeef";
  mergeResult: { merged: boolean; message?: string } = { merged: true };
  throwOnCi = false;
  calls: string[] = [];

  async getCombinedCiStatus(_repo: string, _ref: string): Promise<CiStatus> {
    this.calls.push("ci_status");
    if (this.throwOnCi) throw new Error("simulated_ci_status_error");
    return this.ciStatus;
  }
  async getPullRequestChangedFiles(_repo: string, _prNumber: string): Promise<string[]> {
    this.calls.push("changed_files");
    return this.changedFiles;
  }
  async getPullRequestHeadSha(_repo: string, _prNumber: string): Promise<string> {
    this.calls.push("head_sha");
    return this.headSha;
  }
  async mergePullRequest(
    _repo: string,
    _prNumber: string,
    _opts: { sha: string; commitTitle: string }
  ): Promise<{ merged: boolean; message?: string }> {
    this.calls.push("merge");
    return this.mergeResult;
  }
}

/**
 * Task #123: faket `TaskService` - `proposeCodeChange()`/`sweepPendingJobs()`
 * går KUN via `submit()`/`get()` (samme smale flate `/tasks/*`-rutene selv
 * bruker), ALDRI en direkte kø-tilkobling. `jobs` lar en test sette opp
 * NØYAKTIG den `TaskView` `sweepPendingJobs()` skal se for en gitt
 * `coding_task_id`, uten å måtte kjøre den ekte, asynkrone kodeagent-
 * pipelinen (D-96/D-100/D-101) i det hele tatt.
 */
class FakeTaskService {
  submitted: JobContract[] = [];
  submitOk = true;
  submitReason = "policy_denied";
  jobs = new Map<string, TaskView>();

  async submit(_identity: IdentityContext, contractInput: unknown): Promise<{ ok: true; value: { task_id: string } } | { ok: false; reason: string }> {
    const contract = contractInput as JobContract;
    this.submitted.push(contract);
    if (!this.submitOk) return { ok: false, reason: this.submitReason };
    return { ok: true, value: { task_id: contract.task_id } };
  }

  async get(_identity: IdentityContext, taskId: string): Promise<{ ok: true; value: TaskView } | { ok: false; reason: string }> {
    const job = this.jobs.get(taskId);
    if (!job) return { ok: false, reason: "task_not_found" };
    return { ok: true, value: job };
  }
}

function buildService(opts: {
  sandbox?: FakeSandboxRunner;
  githubClient?: FakeGithubClient;
  prGateway?: FakePrGateway;
  gitToken?: string | null;
  taskService?: FakeTaskService;
}): {
  service: SelfModificationService;
  sandbox: FakeSandboxRunner;
  githubClient: FakeGithubClient;
  prGateway: FakePrGateway;
  taskService: FakeTaskService;
  notified: string[];
} {
  const sandbox = opts.sandbox ?? new FakeSandboxRunner();
  const githubClient = opts.githubClient ?? new FakeGithubClient();
  const prGateway = opts.prGateway ?? new FakePrGateway();
  const gitToken = opts.gitToken === undefined ? "fake-git-token" : opts.gitToken;
  const taskService = opts.taskService ?? new FakeTaskService();
  const notified: string[] = [];
  const service = new SelfModificationService({
    pool: appPool,
    sandbox,
    resolveGitToken: async () => gitToken,
    githubClient,
    prGateway,
    ownerPersonId: OWNER,
    repoSlug: "tsworkflow/jarvisbuild",
    baseBranch: "main",
    taskService: taskService as unknown as TaskService,
    notify: async (text: string) => {
      notified.push(text);
    }
  });
  return { service, sandbox, githubClient, prGateway, taskService, notified };
}

async function insertRequest(overrides: Partial<{
  request_id: string; risk: string; status: string; target_paths: string[]; branch: string; pr_number: string; pr_url: string;
}> = {}): Promise<string> {
  const requestId = overrides.request_id ?? `selfmod-${Math.random().toString(36).slice(2)}`;
  await appPool.query(
    `INSERT INTO self_modification_requests
       (request_id, kind, risk, target_paths, branch, pr_number, pr_url, status, requested_by_person_id, summary)
     VALUES ($1, 'personality_config', $2, $3, $4, $5, $6, $7, $8, 'test-seeded')`,
    [
      requestId,
      overrides.risk ?? "zero_review",
      overrides.target_paths ?? ["config/charlie-personality.json"],
      overrides.branch ?? "jarvis/self-mod/personality-test",
      overrides.pr_number ?? "42",
      overrides.pr_url ?? "https://github.com/tsworkflow/jarvisbuild/pull/42",
      overrides.status ?? "pending_ci",
      OWNER
    ]
  );
  return requestId;
}

describe("A: proposePersonalityChange - eier-kun, FØR noe git-arbeid", () => {
  it("A1: en ikke-eier-identitet kastes tilbake UTEN at sandbox i det hele tatt konstrueres", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(otherIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_owner_only");
    expect(sandbox.createCalls).toBe(0);
  });

  it("A2: manglende git-token kastes FØR sandbox konstrueres (fail-closed, ingen stille uautentisert git)", async () => {
    const { service, sandbox } = buildService({ gitToken: null });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_git_auth_unavailable");
    expect(sandbox.createCalls).toBe(0);
  });

  it("A3: ugyldig input (tomme style_notes) kastes av skjemaet FØR sandbox konstrueres", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "" })
    ).rejects.toThrow();
    expect(sandbox.createCalls).toBe(0);
  });

  it("A4: for mange tone_descriptors (>6) avvises av skjemaet", async () => {
    const { service, sandbox } = buildService({});
    await expect(
      service.proposePersonalityChange(ownerIdentity, {
        tone_descriptors: ["a", "b", "c", "d", "e", "f", "g"],
        style_notes: "test"
      })
    ).rejects.toThrow();
    expect(sandbox.createCalls).toBe(0);
  });
});

describe("B: proposePersonalityChange - lykkes-banen", () => {
  it("B1: riktig git-kommandosekvens, PR opprettet, DB-rad satt inn med status pending_ci", async () => {
    const { service, sandbox, prGateway } = buildService({});
    const result = await service.proposePersonalityChange(ownerIdentity, {
      tone_descriptors: ["varm", "leken"],
      style_notes: "Litt mer avslappet."
    });

    expect(result.risk).toBe("zero_review");
    expect(result.pr_number).toBe("42");
    expect(result.branch).toMatch(/^jarvis\/self-mod\/personality-\d+$/);

    const calls = sandbox.lastSandbox!.calls;
    const commands = calls.map((c) => `${c.command} ${c.command === "git" ? gitSubcommand(c.args) : (c.args[0] ?? "")}`);
    expect(commands).toEqual(["git clone", "git checkout", "node -e", "git add", "git diff", "git commit", "git push"]);
    expect(sandbox.lastSandbox!.disposed).toBe(true);

    expect(prGateway.calls).toHaveLength(1);
    expect(prGateway.calls[0]?.tool_id).toBe("github");
    expect(prGateway.calls[0]?.action).toBe("create_pr");
    expect(prGateway.calls[0]?.parameters["repo"]).toBe("tsworkflow/jarvisbuild");

    const row = await appPool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [result.request_id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe("pending_ci");
    expect(row.rows[0].risk).toBe("zero_review");
    expect(row.rows[0].target_paths).toEqual(["config/charlie-personality.json"]);
    expect(row.rows[0].requested_by_person_id).toBe(OWNER);
  });

  it("B2: commit-meldingen inneholder identitetens person_id (proveniens)", async () => {
    const { service, sandbox } = buildService({});
    await service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" });
    const commitCall = sandbox.lastSandbox!.calls.find((c) => c.command === "git" && c.args.includes("commit"));
    expect(commitCall?.args.join(" ")).toContain(OWNER);
  });

  it("B3: push-target matcher den genererte branchen (branch:branch)", async () => {
    const { service, sandbox } = buildService({});
    const result = await service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" });
    const pushCall = sandbox.lastSandbox!.calls.find((c) => c.command === "git" && gitSubcommand(c.args) === "push");
    expect(pushCall?.args).toContain(`${result.branch}:${result.branch}`);
  });
});

describe("C: proposePersonalityChange - feilbaner underveis i git-arbeidet", () => {
  it("C1: uventet staged path (feil fil committet) kastes, INGEN DB-rad, sandbox disposes uansett", async () => {
    const sandbox = new FakeSandboxRunner();
    sandbox.configure = (s) => { s.stagedPathsOverride = "some/other/file.ts\n"; };
    const { service } = buildService({ sandbox });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_unexpected_staged_paths");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });

  it("C2: git clone feiler -> kastes med clone_failed, sandbox disposes uansett, INGEN DB-rad", async () => {
    const sandbox = new FakeSandboxRunner();
    sandbox.configure = (s) => { s.failOn = "git clone"; };
    const { service } = buildService({ sandbox });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_clone_failed");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });

  it("C3: PR-publisering feiler -> kastes, sandbox likevel disposet, INGEN DB-rad", async () => {
    const prGateway = new FakePrGateway();
    prGateway.ok = false;
    const { service, sandbox } = buildService({ prGateway });
    await expect(
      service.proposePersonalityChange(ownerIdentity, { tone_descriptors: ["varm"], style_notes: "test" })
    ).rejects.toThrow("self_modification_pr_publish_failed");
    expect(sandbox.lastSandbox!.disposed).toBe(true);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });
});

describe("D: sweepPendingRequests - CI-portvakten", () => {
  it("D1: CI pending -> raden forblir pending_ci, rapportert i still_pending", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.ciStatus = "pending";
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.still_pending).toEqual([requestId]);
    expect(outcome.merged).toEqual([]);
    expect(githubClient.calls).toEqual(["ci_status"]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("pending_ci");
  });

  it("D2: CI failure -> markert ci_failed, rapportert i failed", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.ciStatus = "failure";
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.failed).toEqual([requestId]);
    const row = await appPool.query("SELECT status, resolved_at FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("ci_failed");
    expect(row.rows[0].resolved_at).not.toBeNull();
  });

  it("D3: CI success + diff matcher eksakt + zero_review -> merges, status merged", async () => {
    const requestId = await insertRequest();
    const { service, githubClient } = buildService({});
    const outcome = await service.sweepPendingRequests();
    expect(outcome.merged).toEqual([requestId]);
    expect(githubClient.calls).toEqual(["ci_status", "changed_files", "head_sha", "merge"]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("merged");
  });

  it("D4: CI success men PR-diffen har VOKST (mer enn target_paths) -> ci_failed, ALDRI merge", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["config/charlie-personality.json", "modules/policy/src/gateway.ts"];
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.failed).toEqual([requestId]);
    expect(githubClient.calls).not.toContain("merge");
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("ci_failed");
  });

  it("D5: mergePullRequest returnerer merged:false (f.eks. stale sha) -> forblir pending_ci, prøves igjen senere", async () => {
    const requestId = await insertRequest();
    const githubClient = new FakeGithubClient();
    githubClient.mergeResult = { merged: false, message: "405" };
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    expect(outcome.still_pending).toEqual([requestId]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("pending_ci");
  });

  it("D6: en allerede merged rad røres ikke igjen (sweepen spør kun status=pending_ci)", async () => {
    const requestId = await insertRequest({ status: "merged" });
    const { service, githubClient } = buildService({});
    const outcome = await service.sweepPendingRequests();
    expect(outcome.merged).not.toContain(requestId);
    expect(outcome.failed).not.toContain(requestId);
    expect(outcome.still_pending).not.toContain(requestId);
    expect(githubClient.calls).toEqual([]);
  });

  it("D7: én rads uventede feil (GitHub-klienten kaster) stjeler ikke resten av sveipen - isolert per rad", async () => {
    const brokenId = await insertRequest();
    const okId = await insertRequest();
    const githubClient = new FakeGithubClient();
    const original = githubClient.getCombinedCiStatus.bind(githubClient);
    let call = 0;
    githubClient.getCombinedCiStatus = async (repo: string, ref: string) => {
      call++;
      if (call === 1) throw new Error("simulated_transient_error");
      return original(repo, ref);
    };
    const { service } = buildService({ githubClient });
    const outcome = await service.sweepPendingRequests();
    // Rekkefølgen er `ORDER BY created_at` - begge radene ble satt inn i
    // rekkefølge, så den FØRSTE (brokenId) feiler og forblir pending
    // (try/catch-isolasjon), den ANDRE (okId) merges uendret.
    expect(outcome.still_pending).toContain(brokenId);
    expect(outcome.merged).toContain(okId);
  });
});

describe("E: resolveApproval - Telegram-godkjennings-tilstandsmaskinen", () => {
  it("E1: godkjenning av en awaiting_approval-rad -> approved, resolved_by satt", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    const updated = await service.resolveApproval(requestId, "approved", OWNER);
    expect(updated.status).toBe("approved");
    expect(updated.resolved_by_person_id).toBe(OWNER);
    expect(updated.resolved_at).not.toBeNull();
  });

  it("E2: avvisning av en awaiting_approval-rad -> rejected", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    const updated = await service.resolveApproval(requestId, "rejected", OWNER);
    expect(updated.status).toBe("rejected");
  });

  it("E3: ukjent request_id kastes", async () => {
    const { service } = buildService({});
    await expect(service.resolveApproval("selfmod-does-not-exist", "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_found"
    );
  });

  it("E4: en rad som IKKE er awaiting_approval (f.eks. pending_ci) kan ikke godkjennes", async () => {
    const requestId = await insertRequest({ status: "pending_ci" });
    const { service } = buildService({});
    await expect(service.resolveApproval(requestId, "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_awaiting_approval:pending_ci"
    );
  });

  it("E5: en allerede approved rad kan ikke godkjennes på nytt (ingen dobbel-overgang)", async () => {
    const requestId = await insertRequest({ risk: "requires_approval", status: "awaiting_approval" });
    const { service } = buildService({});
    await service.resolveApproval(requestId, "approved", OWNER);
    await expect(service.resolveApproval(requestId, "approved", OWNER)).rejects.toThrow(
      "self_modification_request_not_awaiting_approval:approved"
    );
  });
});

describe("F: getRequest", () => {
  it("F1: ukjent id -> null", async () => {
    const { service } = buildService({});
    expect(await service.getRequest("selfmod-does-not-exist")).toBeNull();
  });

  it("F2: kjent id -> full, mappet rad", async () => {
    const requestId = await insertRequest();
    const { service } = buildService({});
    const found = await service.getRequest(requestId);
    expect(found?.request_id).toBe(requestId);
    expect(found?.status).toBe("pending_ci");
    expect(found?.target_paths).toEqual(["config/charlie-personality.json"]);
  });
});

describe("G: proposeCodeChange - requires_approval-sporets EKTE produsent", () => {
  it("G1: en ikke-eier-identitet kastes tilbake, INGEN jobb sendt, INGEN rad", async () => {
    const { service, taskService } = buildService({});
    await expect(service.proposeCodeChange(otherIdentity, { goal: "gjør noe" })).rejects.toThrow(
      "self_modification_owner_only"
    );
    expect(taskService.submitted).toHaveLength(0);
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });

  it("G2: tomt mål kastes FØR noen jobb sendes", async () => {
    const { service, taskService } = buildService({});
    await expect(service.proposeCodeChange(ownerIdentity, { goal: "   " })).rejects.toThrow(
      "self_modification_missing_goal"
    );
    expect(taskService.submitted).toHaveLength(0);
  });

  it("G3: lykkes-banen - riktig JobContract sendt, rad satt inn med status pending_job", async () => {
    const { service, taskService } = buildService({});
    const result = await service.proposeCodeChange(ownerIdentity, { goal: "legg til en ny endpoint" });

    expect(result.branch).toBe(`jarvis/${result.coding_task_id}`);
    expect(taskService.submitted).toHaveLength(1);
    const contract = taskService.submitted[0]!;
    expect(contract.task_id).toBe(result.coding_task_id);
    expect(contract.owner_person_id).toBe(OWNER);
    expect(contract.tenant_id).toBe(ownerIdentity.tenant_id);
    expect(contract.agent_profile).toBe("coding");
    expect(contract.allowed_tools).toEqual(["github"]);
    expect(contract.goal).toBe("legg til en ny endpoint");

    const row = await appPool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [result.request_id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].kind).toBe("code_change");
    expect(row.rows[0].status).toBe("pending_job");
    expect(row.rows[0].risk).toBe("requires_approval");
    expect(row.rows[0].coding_task_id).toBe(result.coding_task_id);
    expect(row.rows[0].coding_tenant_id).toBe(ownerIdentity.tenant_id);
    expect(row.rows[0].target_paths).toEqual([]);
  });

  it("G4: jobb-innsending avvist av TaskService -> kastes, INGEN rad", async () => {
    const taskService = new FakeTaskService();
    taskService.submitOk = false;
    taskService.submitReason = "untrusted_with_private_memory_and_network";
    const { service } = buildService({ taskService });
    await expect(service.proposeCodeChange(ownerIdentity, { goal: "test" })).rejects.toThrow(
      "self_modification_job_submit_failed:untrusted_with_private_memory_and_network"
    );
    const rows = await appPool.query("SELECT * FROM self_modification_requests");
    expect(rows.rows).toHaveLength(0);
  });
});

describe("H: sweepPendingJobs - følger opp den asynkrone kodejobben", () => {
  it("H1: jobben kjører fortsatt -> raden forblir pending_job, rapportert i still_pending", async () => {
    const { service, taskService } = buildService({});
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "running",
      result: null, cancel_requested: false, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.still_pending).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("pending_job");
  });

  it("H2: jobben feilet -> rejected, eieren varsles", async () => {
    const { service, taskService, notified } = buildService({});
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "failed",
      result: null, cancel_requested: false, attempts: 3, last_error: "agent_crashed"
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.failed).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("rejected");
    expect(notified.some((t) => t.includes(proposed.request_id) && t.includes("agent_crashed"))).toBe(true);
  });

  it("H3: jobben ble kansellert -> rejected, eieren varsles", async () => {
    const { service, taskService, notified } = buildService({});
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "cancelled",
      result: null, cancel_requested: true, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.failed).toEqual([proposed.request_id]);
    expect(notified.some((t) => t.includes(proposed.request_id))).toBe(true);
  });

  it("H4: jobben fullførte UTEN å opprette en PR -> rejected", async () => {
    const { service, taskService, notified } = buildService({});
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "completed",
      result: { branch: proposed.branch, pr: { status: "skipped_not_allowed" } },
      cancel_requested: false, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.failed).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("rejected");
    expect(notified.some((t) => t.includes(proposed.request_id))).toBe(true);
  });

  it("H5: PR opprettet, men FAKTISK endrede filer klassifiserer forbidden -> rejected UMIDDELBART, eieren varsles", async () => {
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["modules/policy/src/gateway.ts"];
    const { service, taskService, notified } = buildService({ githubClient });
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "completed",
      result: { branch: proposed.branch, pr: { status: "created", pr_number: "77", pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/77" } },
      cancel_requested: false, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.failed).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status, risk, target_paths FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("rejected");
    expect(row.rows[0].risk).toBe("forbidden");
    expect(row.rows[0].target_paths).toEqual(["modules/policy/src/gateway.ts"]);
    expect(notified.some((t) => t.includes(proposed.request_id))).toBe(true);
  });

  it("H6: PR opprettet, FAKTISK endrede filer klassifiserer zero_review -> pending_ci, INGEN varsel", async () => {
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["config/charlie-personality.json"];
    const { service, taskService, notified } = buildService({ githubClient });
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "completed",
      result: { branch: proposed.branch, pr: { status: "found_existing", pr_number: "78", pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/78" } },
      cancel_requested: false, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.advanced).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status, risk FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("pending_ci");
    expect(row.rows[0].risk).toBe("zero_review");
    expect(notified).toEqual([]);
  });

  it("H7: PR opprettet, FAKTISK endrede filer klassifiserer requires_approval -> awaiting_approval, eieren varsles med instruksjoner", async () => {
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["apps/api/src/some-feature.ts"];
    const { service, taskService, notified } = buildService({ githubClient });
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    taskService.jobs.set(proposed.coding_task_id, {
      task_id: proposed.coding_task_id, goal: "test", status: "completed",
      result: { branch: proposed.branch, pr: { status: "created", pr_number: "79", pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/79" } },
      cancel_requested: false, attempts: 1, last_error: null
    });
    const outcome = await service.sweepPendingJobs();
    expect(outcome.advanced).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status, risk FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("awaiting_approval");
    expect(row.rows[0].risk).toBe("requires_approval");
    const notice = notified.find((t) => t.includes(proposed.request_id));
    expect(notice).toBeDefined();
    expect(notice).toContain(`/godkjenn ${proposed.request_id}`);
    expect(notice).toContain(`/avvis ${proposed.request_id}`);
  });

  it("H8: TaskService.get() svarer not-ok (f.eks. et forbigående policy-avslag) -> forblir pending_job, isolert", async () => {
    const { service } = buildService({});
    const proposed = await service.proposeCodeChange(ownerIdentity, { goal: "test" });
    // Ingen jobb satt inn i `taskService.jobs` -> get() returnerer ok:false.
    const outcome = await service.sweepPendingJobs();
    expect(outcome.still_pending).toEqual([proposed.request_id]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [proposed.request_id]);
    expect(row.rows[0].status).toBe("pending_job");
  });
});

describe("I: sweepApprovedRequests - merge-koblingen for owner-godkjente kodeendringer", () => {
  it("I1: en approved code_change-rad merges via DEN SAMME attemptMerge() som zero-review-sporet", async () => {
    const requestId = await insertRequest({
      risk: "requires_approval",
      status: "approved",
      target_paths: ["apps/api/src/some-feature.ts"],
      branch: "jarvis/self-mod-code-abc",
      pr_number: "80",
      pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/80"
    });
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["apps/api/src/some-feature.ts"];
    const { service, notified } = buildService({ githubClient });
    const outcome = await service.sweepApprovedRequests();
    expect(outcome.merged).toEqual([requestId]);
    expect(githubClient.calls).toEqual(["ci_status", "changed_files", "head_sha", "merge"]);
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("merged");
    expect(notified.some((t) => t.includes(requestId))).toBe(true);
  });

  it("I2: diffen har endret seg siden godkjenning (klassifiserer nå forbidden) -> ci_failed, ALDRI merge, eieren varsles", async () => {
    const requestId = await insertRequest({
      risk: "requires_approval",
      status: "approved",
      target_paths: ["apps/api/src/some-feature.ts"],
      branch: "jarvis/self-mod-code-abc",
      pr_number: "81",
      pr_url: "https://github.com/tsworkflow/jarvisbuild/pull/81"
    });
    const githubClient = new FakeGithubClient();
    githubClient.changedFiles = ["modules/policy/src/gateway.ts"];
    const { service, notified } = buildService({ githubClient });
    const outcome = await service.sweepApprovedRequests();
    expect(outcome.failed).toEqual([requestId]);
    expect(githubClient.calls).not.toContain("merge");
    const row = await appPool.query("SELECT status FROM self_modification_requests WHERE request_id=$1", [requestId]);
    expect(row.rows[0].status).toBe("ci_failed");
    expect(notified.some((t) => t.includes(requestId))).toBe(true);
  });

  it("I3: en zero_review-rad i status pending_ci (ikke approved) røres ikke av sweepApprovedRequests", async () => {
    const requestId = await insertRequest({ status: "pending_ci" });
    const { service, githubClient } = buildService({});
    const outcome = await service.sweepApprovedRequests();
    expect(outcome.merged).not.toContain(requestId);
    expect(outcome.failed).not.toContain(requestId);
    expect(outcome.still_pending).not.toContain(requestId);
    expect(githubClient.calls).toEqual([]);
  });
});
