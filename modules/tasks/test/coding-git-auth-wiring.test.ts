import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  ArtifactStore, GIT_CREDENTIAL_ISOLATION_ARGS, GIT_CREDENTIAL_TOKEN_ENV, InProcessWorker, PgTaskQueue, ProcessSandboxRunner,
  createCodingHandler, type CodingAgentAdapter, type CodingAgentExec
} from "@jarvis/tasks";
import type { ExecResult, Sandbox, SandboxRunner } from "../src/sandbox.ts";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B:
 * EKTE embedded-Postgres + EKTE lokalt git-bare-repo (ALDRI github.com, ALDRI
 * et ekte GitHub-kall) - beviser at eksplisitt git-transport-autentisering
 * KUN når til clone/push, ALDRI til agentens eget kall, ALDRI til git config,
 * ALDRI til argv/logger, og feiler rent lukket uten token.
 */

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-gitauth", device_id: "dev-pc", channel: "web", auth_strength: "active"
};

function jobContract(overrides: Partial<JobContract> = {}): JobContract {
  return {
    task_id: `task-${randomUUID()}`,
    owner_person_id: "person-tobias",
    tenant_id: "tenant-a",
    goal: "test",
    acceptance_criteria: ["fullfører"],
    input: { data: {}, trust_level: "internal", provenance: "test" },
    allowed_tools: ["github"],
    allowed_memory_spaces: ["personal"],
    allowed_network_targets: [],
    agent_profile: "coding",
    model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    max_steps: 3,
    ...overrides
  };
}

interface CapturedCall {
  command: string;
  args: string[];
  extraEnv: Record<string, string> | undefined;
}

/** Skriver ALDRI selv - kaller alltid `exec("node", ["-e", ...])` slik at kallet er entydig identifiserbart i den fangede logg-listen (adskilt fra clone/branch/add/commit/status/show/rev-parse/push). */
class WritingFakeAgent implements CodingAgentAdapter {
  readonly name = "fake-agent";
  async modify(exec: CodingAgentExec, _goal: string): Promise<string> {
    exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','endret')"]);
    return "endret CHANGES.md";
  }
}

/**
 * Fanger `(command, args, extraEnv)` for HVERT `sandbox.exec()`-kall, OG
 * skriver om `redirectFrom` (en github.com-formet URL) til `redirectTo` (et
 * lokalt bare-repo) i argv - SAMME presedens som `pr-publisher.test.ts` sin
 * egen `RepoUrlRedirectingSandboxRunner`, kun utvidet til også å logge extraEnv.
 */
class CapturingRedirectingSandboxRunner implements SandboxRunner {
  readonly name = "capturing-redirect-sandbox";
  readonly calls: CapturedCall[] = [];
  constructor(
    private readonly inner: SandboxRunner,
    private readonly redirectFrom: string,
    private readonly redirectTo: string
  ) {}
  async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
    const sandbox = await this.inner.create(jobEnv);
    return {
      workdir: sandbox.workdir,
      exec: (command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): ExecResult => {
        let rewritten = args.map((a) => (a === this.redirectFrom ? this.redirectTo : a));
        // Del 2: produksjons-hardening (`protocol.allow=never` + kun https) blokkerer et lokalt bare-repo. Test-harnessen
        // omdirigerer github-URL-en til en filsti, så den åpner KUN `file`-protokollen rett før nettverkssubkommandoen.
        // (push går mot `origin` = den lokale stien clone satte, så push omskrives ikke - derfor åpnes `file` for begge.)
        if (command === "git") {
          const idx = rewritten.findIndex((a) => a === "clone" || a === "push");
          if (idx >= 0) rewritten = [...rewritten.slice(0, idx), "-c", "protocol.file.allow=always", ...rewritten.slice(idx)];
        }
        this.calls.push({ command, args: rewritten, extraEnv });
        return sandbox.exec(command, rewritten, timeoutMs, extraEnv);
      },
      dispose: () => sandbox.dispose()
    };
  }
}

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;
let artifacts: ArtifactStore;
let policy: PolicyGateway;
let bareRepo: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-d103-gitauth-test.git";
const ALLOWED_REPO = "tsworkflow/jarvisbuild-d103-gitauth-test";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-gitauth-"));
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
  await adminPool.query("CREATE ROLE jarvis_test_gitauth LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_gitauth");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_gitauth", password: "pw2" });

  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"])
  });
  queue = new PgTaskQueue(appPool);
  artifacts = new ArtifactStore(appPool);

  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-gitauth-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-gitauth-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const REAL_TOKEN = "ghp_D103TestTokenNeverPersisted999";

function runJob(sandbox: CapturingRedirectingSandboxRunner, gitAuthToken: string | null | undefined) {
  const worker = new InProcessWorker(queue, 60);
  worker.register("coding", createCodingHandler({
    sandbox, agent: new WritingFakeAgent(), artifacts, policy,
    identityFor: () => identity,
    allowedRepos: [ALLOWED_REPO],
    ...(gitAuthToken !== undefined ? { gitAuth: { secretProvider: { get: async () => gitAuthToken } } } : {})
  }));
  const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
  return { worker, c };
}

describe("D-103: git-auth wiring i createCodingHandler (Blokker B)", () => {
  it("A: clone-kallet får extraEnv med GIT_TERMINAL_PROMPT/token (ALDRI GIT_ASKPASS - v2 bruker credential.helper-argv i stedet) når gitAuth er konfigurert", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args.includes("clone"));
    expect(clone?.extraEnv?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(clone?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(REAL_TOKEN);
    expect("GIT_ASKPASS" in (clone?.extraEnv ?? {})).toBe(false);
  });

  it("B: push-kallet får extraEnv med GIT_TERMINAL_PROMPT/token (ALDRI GIT_ASKPASS) når gitAuth er konfigurert", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const push = sandbox.calls.find((call) => call.args.includes("push"));
    expect(push?.extraEnv?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(push?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(REAL_TOKEN);
    expect("GIT_ASKPASS" in (push?.extraEnv ?? {})).toBe(false);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed"); // ekte push mot lokalt bare-repo lyktes
  });

  it("C: ALLE andre kall (branch/agent/status/add/commit/rev-parse/show) får extraEnv===undefined - token når ALDRI utover clone/push", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const nonNetworkCalls = sandbox.calls.filter((call) => !call.args.includes("clone") && !call.args.includes("push"));
    expect(nonNetworkCalls.length).toBeGreaterThan(0); // branch/add/commit/status/rev-parse/show/agentens node-kall
    for (const call of nonNetworkCalls) {
      expect(call.extraEnv).toBeUndefined();
    }
    // Spesifikt: agentens EGET kall (identifiserbart som "node" med "-e") fikk aldri gitAuth-env.
    const agentCall = sandbox.calls.find((call) => call.command === "node" && call.args[0] === "-e");
    expect(agentCall?.extraEnv).toBeUndefined();
  });

  it("D: token finnes ALDRI i argv for noe kall (clone/push inkludert - token sendes KUN via env, ALDRI URL/argv)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    for (const call of sandbox.calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(REAL_TOKEN);
      }
    }
  });

  it("E: token finnes ALDRI i .git/config etter en fullført clone+push (remote-URL forblir uendret, ingen credential-injeksjon i config)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    // Fanger workdir FØR sandbox.dispose() kjøres (via clone-kallet, som skjer tidlig i jobben).
    let capturedWorkdir: string | undefined;
    const originalCreate = sandbox.create.bind(sandbox);
    sandbox.create = async (jobEnv) => {
      const s = await originalCreate(jobEnv);
      capturedWorkdir = s.workdir;
      return s;
    };
    await worker.drain();
    expect(capturedWorkdir).toBeDefined();
    // sandbox.dispose() har allerede slettet workdir på dette tidspunktet - derfor
    // leses git config-innholdet i stedet via en EGEN, live kloning av SAMME
    // bare-repo (identisk remote-URL-tilstand som jobben selv satte via clone).
    const verifyDir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-verify-"));
    git(verifyDir, "clone", bareRepo, ".");
    const configContent = git(verifyDir, "config", "--get", "remote.origin.url");
    expect(configContent).not.toContain(REAL_TOKEN);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("F: manglende token (secretProvider returnerer null) feiler LUKKET FØR clone forsøkes - ALDRI et stille fall til uautentisert git", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, null);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("git_auth_unavailable");
    expect(sandbox.calls.find((call) => call.args.includes("clone"))).toBeUndefined(); // clone ALDRI forsøkt
  });

  it("G: uten gitAuth-feltet i det hele tatt (default) er oppførselen 100% uendret - lokalt bare-repo-push fungerer fortsatt uten noen extraEnv noe sted", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, undefined);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    for (const call of sandbox.calls) {
      expect(call.extraEnv).toBeUndefined();
    }
  });

  it("H: token finnes ALDRI i en kastet feilmelding selv ved en ekte clone-feil (ugyldig repo_url)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, "/nonexistent/path/that/does/not/exist");
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy,
      identityFor: () => identity,
      allowedRepos: [ALLOWED_REPO],
      gitAuth: { secretProvider: { get: async () => REAL_TOKEN } }
    }));
    const c = jobContract({
      input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" }
    });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).not.toContain(REAL_TOKEN);
  });

  it("H2: ephemer credential-helper-fil fjernes OGSÅ ved en FORTVUNGEN clone-feil (ugyldig repo_url) - cleanup er IKKE kun en happy-path-garanti", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, "/nonexistent/path/that/does/not/exist");
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy,
      identityFor: () => identity,
      allowedRepos: [ALLOWED_REPO],
      gitAuth: { secretProvider: { get: async () => REAL_TOKEN } }
    }));
    const c = jobContract({
      input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" }
    });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed"); // clone feilet reelt (jobben nådde IKKE push)
    const clone = sandbox.calls.find((call) => call.args.includes("clone"));
    const scriptPath = clone?.args.find((a) => a.includes("credential-helper.cjs"))?.match(/"([^"]+credential-helper\.cjs)"/)?.[1];
    expect(scriptPath).toBeDefined(); // gitAuth ble faktisk konstruert FØR clone-forsøket
    const { stat } = await import("node:fs/promises");
    await expect(stat(scriptPath as string)).rejects.toThrow(); // og likevel ryddet - den ytre finally() dekket dette
  });

  it("I: ephemer credential-helper-fil fjernes etter jobbfullføring (cleanup skjer uavhengig av sandbox.dispose())", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args.includes("clone"));
    const scriptPath = clone?.args.find((a) => a.includes("credential-helper.cjs"))?.match(/"([^"]+credential-helper\.cjs)"/)?.[1];
    const { stat } = await import("node:fs/promises");
    await expect(stat(scriptPath as string)).rejects.toThrow();
  });

  it("K: BÅDE clone- OG push-argv har '-c credential.helper=' etterfulgt av '-c credential.helper=!\"<node>\" \"<script>\"' (D-103 HOST-FIX v1+v2) - hindrer en ambient credential.helper fra å svare før Jarvis sin egen helper", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, REAL_TOKEN);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args.includes("clone"));
    const push = sandbox.calls.find((call) => call.args.includes("push"));
    for (const call of [clone, push]) {
      expect(call?.args.slice(0, 2)).toEqual([...GIT_CREDENTIAL_ISOLATION_ARGS]);
      expect(call?.args[2]).toBe("-c");
      expect(call?.args[3]).toMatch(/^credential\.helper=!"/);
      expect(call?.args[3]).toContain(process.execPath);
      expect(call?.args[3]).toMatch(/credential-helper\.cjs"$/);
    }
    // Lokale git-operasjoner (branch/add/commit/status/rev-parse/show) og agentens
    // eget kall skal ALDRI få denne isolasjons-prefiksen - kun clone/push (nettverk).
    const localOps = sandbox.calls.filter((call) => !call.args.includes("clone") && !call.args.includes("push"));
    for (const call of localOps) {
      expect(call.args.slice(0, 2)).not.toEqual([...GIT_CREDENTIAL_ISOLATION_ARGS]);
    }
  });

  it("L: uten gitAuth (default) har clone/push INGEN isolasjons-argv-prefiks - argv 100% uendret fra før HOST-FIX", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const { worker, c } = runJob(sandbox, undefined);
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const clone = sandbox.calls.find((call) => call.args.includes("clone"));
    const push = sandbox.calls.find((call) => call.args.includes("push"));
    // Uten gitAuth: ingen credential-isolasjon/-helper i argv (kun hooks av + `ext::` nektet).
    for (const call of [clone, push]) {
      expect(call?.args.slice(0, 2)).not.toEqual([...GIT_CREDENTIAL_ISOLATION_ARGS]);
      expect(call?.args.some((a) => a.startsWith("credential.helper"))).toBe(false);
    }
    expect(clone?.args).toContain("clone");
    expect(push?.args).toContain("push");
  });

  it("M (del 2, JARVIS-064): fremmed/ikke-allowlistet repo_url avvises FØR credential hentes og FØR clone - secretProvider kalles aldri", async () => {
    for (const repoUrl of [
      "https://evil.example/tsworkflow/jarvisbuild-d103-gitauth-test.git",
      "https://github.com@evil.example/tsworkflow/jarvisbuild-d103-gitauth-test.git",
      "https://github.com/tsworkflow/another-repo.git",
      "ext::sh -c id",
      "--upload-pack=touch /tmp/pwned"
    ]) {
      const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
      let secretReads = 0;
      const worker = new InProcessWorker(queue, 60);
      worker.register("coding", createCodingHandler({
        sandbox, agent: new WritingFakeAgent(), artifacts, policy, identityFor: () => identity,
        allowedRepos: [ALLOWED_REPO],
        gitAuth: { secretProvider: { get: async () => { secretReads += 1; return REAL_TOKEN; } } }
      }));
      const c = jobContract({ input: { data: { repo_url: repoUrl }, trust_level: "internal", provenance: "test" } });
      await queue.enqueue("tenant-a", c);
      await worker.drain();
      const view = await queue.get("tenant-a", c.task_id);
      expect(view?.status, repoUrl).toBe("failed");
      expect(view?.last_error, repoUrl).toContain("coding_input_rejected");
      expect(secretReads, repoUrl).toBe(0);
      expect(sandbox.calls, repoUrl).toHaveLength(0);
    }
  });

  it("N (del 2): tom allowlist med gitAuth feiler lukket (git_repo_allowlist_empty) - ingen clone, ingen credential", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    let secretReads = 0;
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy, identityFor: () => identity,
      gitAuth: { secretProvider: { get: async () => { secretReads += 1; return REAL_TOKEN; } } }
    }));
    const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("git_repo_allowlist_empty");
    expect(secretReads).toBe(0);
    expect(sandbox.calls).toHaveLength(0);
  });

  it("O (del 2, JARVIS-009): en vilkårlig test_command fra kontrakten kjøres ALDRI - jobben avvises før sandbox opprettes", async () => {
    for (const testCommand of [["sh", "-c", "id"], ["node", "-e", "process.exit(0)"], ["curl", "http://169.254.169.254/"], ["npm", "install", "evil"]]) {
      const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
      const worker = new InProcessWorker(queue, 60);
      worker.register("coding", createCodingHandler({
        sandbox, agent: new WritingFakeAgent(), artifacts, policy, identityFor: () => identity,
        allowedRepos: [ALLOWED_REPO], gitAuth: { secretProvider: { get: async () => REAL_TOKEN } }
      }));
      const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL, test_command: testCommand }, trust_level: "internal", provenance: "test" } });
      await queue.enqueue("tenant-a", c);
      await worker.drain();
      const view = await queue.get("tenant-a", c.task_id);
      expect(view?.status, testCommand.join(" ")).toBe("failed");
      expect(view?.last_error, testCommand.join(" ")).toContain("coding_input_rejected:test_command_not_allowed");
      expect(sandbox.calls, testCommand.join(" ")).toHaveLength(0);
    }
  });

  it("P (del 2): repo-hooks kjøres ikke - en pre-commit-hook agenten (eller repoet) legger igjen får aldri kjøre under commit", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "jarvis-hook-marker-"));
    const marker = join(markerDir, "hook-ran");
    class HookPlantingAgent implements CodingAgentAdapter {
      readonly name = "hook-planting-agent";
      async modify(exec: CodingAgentExec, _goal: string): Promise<string> {
        exec("node", ["-e", `const fs=require('fs');fs.writeFileSync('CHANGES.md','x');fs.mkdirSync('.git/hooks',{recursive:true});fs.writeFileSync('.git/hooks/pre-commit','#!/bin/sh\\ntouch ${marker.replace(/\\/g, "/")}\\n',{mode:0o755})`]);
        return "plantet hook";
      }
    }
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new HookPlantingAgent(), artifacts, policy, identityFor: () => identity,
      allowedRepos: [ALLOWED_REPO], gitAuth: { secretProvider: { get: async () => REAL_TOKEN } }
    }));
    const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const { stat } = await import("node:fs/promises");
    await expect(stat(marker)).rejects.toThrow(); // hooken kjørte ALDRI
    const commit = sandbox.calls.find((call) => call.command === "git" && call.args.includes("commit"));
    expect(commit?.args.join(" ")).toContain("core.hooksPath=/dev/null");
  });

  it("J: ToolGateway/D-95 PR-publisering forblir uendret NÅR gitAuth OGSÅ er konfigurert samtidig (ingen interferens mellom Blokker A/B og D-95)", async () => {
    const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
    const calls: Array<{ action: string }> = [];
    const worker = new InProcessWorker(queue, 60);
    worker.register("coding", createCodingHandler({
      sandbox, agent: new WritingFakeAgent(), artifacts, policy,
      identityFor: () => identity,
      gitAuth: { secretProvider: { get: async () => REAL_TOKEN } },
      allowedRepos: [ALLOWED_REPO],
      github: {
        gateway: {
          execute: async (req) => {
            calls.push({ action: req.action });
            return { ok: true, data: { number: "7", html_url: "https://github.com/x/y/pull/7", created: true }, output_trust: "internal", deduplicated: false };
          }
        }
      }
    }));
    const c = jobContract({ input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" } });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    expect(calls).toEqual([{ action: "create_pr" }]);
  });
});
