import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { ChannelSessionAuthority, createPool, DeviceService, IdentityService, runMigrations, SessionGrantService, SessionService } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import type { CodingAgentAdapter, CodingAgentExec } from "@jarvis/tasks";
import {
  ArtifactStore, ClaudeCodeAgent, InProcessWorker, PgTaskQueue, ProcessSandboxRunner, TaskService,
  createCodingHandler, publishPullRequestForCodingJob, withSecretRedaction
} from "@jarvis/tasks";
import type { ToolExecutionResult } from "@jarvis/tasks";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant } from "./support/grant-client.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { MessageStore, ContextBuilder } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ModelGateway, MemoryTraceSink } from "@jarvis/model-gateway";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { meshToolDefinitions, MeshToolExecutor } from "@jarvis/tool-gateway";

/**
 * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
 * ENDE-TIL-ENDE reachability-bevis mot den EKTE produksjons-koblingen
 * (`/tasks/submit` → EKTE `TaskService.submit()` → EKTE `PgTaskQueue` →
 * EKTE `InProcessWorker` med "coding" registrert via `createCodingHandler`
 * PÅ NØYAKTIG samme måte som `worker-main.ts` faktisk gjør det, mot et EKTE
 * lokalt git-bare-repo) - INGEN ekte Anthropic-/GitHub-API-kall (INGEN
 * `ANTHROPIC_API_KEY`/`JARVIS_GITHUB_TOKEN` er konfigurert i dette miljøet -
 * `ClaudeCodeAgent()` feiler derfor STRUKTURELT lukket, ALDRI fabrikkert,
 * jf. §5/§26/§27 i byggeordren). Suksessveien (test-port/commit/push/PR-
 * publisering) bevises separat med en lokal, deterministisk test-agent
 * (SAMME etablerte mønster som D-101s `NoOpCodingAgent` i
 * `fase6-worker.test.ts` - IKKE en ny/parallell produksjonsarkitektur).
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let queue: PgTaskQueue;
let bareRepo: string;

// Remediering del 2: /tasks/submit tar KUN et grant (utstedt via enhetsbevis).
const webKey = generateDeviceKey();
let cachedGrant: string | undefined;
async function ownerGrant(): Promise<string> {
  cachedGrant ??= await mintGrant(baseUrl, ownerIdentity, webKey);
  return cachedGrant;
}

const ownerIdentity = {
  person_id: "person-tobias", tenant_id: "tenant-personal", device_id: "dev-web",
  memory_space: "personal", channel: "web", session_id: "sess-test", auth_strength: "active"
} as const;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

function contract(overrides: Partial<JobContract> = {}): JobContract {
  return {
    task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-personal",
    goal: "fiks feilen", acceptance_criteria: ["testene bestaar"],
    input: { data: { repo_url: bareRepo, test_command: ["node", "test.js"] }, trust_level: "internal", provenance: "test" },
    allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [],
    agent_profile: "coding", model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3,
    ...overrides
  };
}

/** Test-only stand-in for en agent SOM FAKTISK gjør en endring - SAMME rolle som D-101s NoOpCodingAgent-presedens, ALDRI produksjonskode. */
class FakeEditingAgent implements CodingAgentAdapter {
  readonly name = "fake-editing-agent";
  async modify(exec: CodingAgentExec): Promise<string> {
    exec("node", ["-e", "require('fs').writeFileSync('fix.js', 'module.exports = 1;\\n')"]);
    return "la til fix.js";
  }
}

/** Fake ToolGateway-kompatibel PR-gateway - beviser autoritets-/idempotens-oppforsel uten et ekte GitHub-kall. */
function fakeGithubGateway(calls: { count: number }) {
  return {
    async execute(request: { idempotency_key?: string }): Promise<ToolExecutionResult> {
      calls.count += 1;
      return {
        ok: true, external_id: "42", output_trust: "internal" as const,
        deduplicated: calls.count > 1 && request.idempotency_key !== undefined,
        data: { number: "42", html_url: "https://github.test/owner/repo/pull/42", created: calls.count === 1 }
      };
    }
  };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-codingwiring-"));
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
  await adminPool.query("CREATE ROLE jarvis_codingwiring LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_codingwiring");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-personal','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-personal');
        INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-personal','tenant-personal','personal');
  `);
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ('dev-web','tenant-personal','person-tobias','web',$1)",
    [webKey.publicKeyPem]
  );
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_codingwiring", password: "pw2" });

  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-codingwiring-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-codingwiring-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  spawnSync("node", ["-e", "require('fs').writeFileSync('test.js','process.exit(0)')"], { cwd: seed });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");

  queue = new PgTaskQueue(appPool);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-personal"] }
  });
  const taskService = new TaskService(appPool, queue, policy);
  const worker = new InProcessWorker(queue, 60);
  worker.register("executive", async (task) => ({ echo: task.contract.goal }));
  // D-102: NØYAKTIG samme koblingsform som worker-main.ts (proven av worker-coding-wiring.test.ts
  // sin kildetekst-inspeksjon) - EKTE ClaudeCodeAgent (ukonfigurert her -> strukturelt lukket feil,
  // ALDRI en fabrikkert fiks), EKTE createCodingHandler, EKTE withSecretRedaction.
  worker.register(
    "coding",
    withSecretRedaction(
      createCodingHandler({
        sandbox: new ProcessSandboxRunner(),
        agent: new ClaudeCodeAgent(undefined),
        artifacts: new ArtifactStore(appPool),
        policy,
        identityFor: (task) => ({
          person_id: task.contract.owner_person_id, tenant_id: task.tenant_id, memory_space_id: "personal",
          session_id: "sess-coding", device_id: "jarvis-core", channel: "api", auth_strength: "active"
        })
      }),
      [process.env["ANTHROPIC_API_KEY"]]
    )
  );

  const trace = new MemoryTraceSink();
  const gateway = new ModelGateway({ pool: appPool, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  server = createApiServer({
    // Remediering del 1: dev-rutene (/worker/tick, /tools/critical-demo) er av i produksjon;
    // denne testen trenger dem eksplisitt.
    enableDevRoutes: true,
    identity: identityService,
    sessions: sessionService,
    // D-130/D-131: `ApiDeps.channelAuthority` og `ApiDeps.grants` er nå
    // påkrevde (ikke brukt av denne testens `/tasks/submit`-fokus, men
    // strukturelt nødvendige for å konstruere en gyldig `ApiDeps`).
    devices: deviceService,
    grants: grantService,
    channelAuthority: new ChannelSessionAuthority({
      pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService
    }),
    policy,
    worker,
    tasks: taskService,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool), context: new ContextBuilder(appPool), gateway,
      tasks: taskService, worker, trace,
      tools: { definitions: meshToolDefinitions(), executorFor: (identity) => new MeshToolExecutor({ execute: async () => ({ ok: false, reason: "n/a", output_trust: "internal" as const, deduplicated: false }) } as never, identity) }
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

async function submit(c: JobContract): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/tasks/submit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_token: await ownerGrant(), contract: c })
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("D-102: EKTE produksjons-reachability - /tasks/submit -> PgTaskQueue -> worker -> createCodingHandler -> ClaudeCodeAgent", () => {
  it("A: en jobb sendt inn via /tasks/submit naar FAKTISK det ekte kodejobb-handler-registeret (ukonfigurert agent -> strukturelt lukket feil, ALDRI 'completed', ALDRI fabrikkert)", async () => {
    const mainBefore = git(bareRepo, "rev-parse", "main");
    const c = contract();
    const submitted = await submit(c);
    expect(submitted.status).toBe(200);
    const taskId = submitted.body["task_id"] as string;
    expect(taskId).toBe(c.task_id);

    await fetch(`${baseUrl}/worker/tick`, { method: "POST" });
    const view = await queue.get("tenant-personal", taskId);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("claude_code_not_configured");
    // Ingen branch noensinne pushet - main urort:
    expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(bareRepo, "branch", "--list", `jarvis/${taskId}`)).toBe("");
  });

  it("B: en jobb med agent_profile != 'coding' (executive) fortsetter aa fungere identisk - INGEN regresjon i eksisterende jobbtyper", async () => {
    const c = contract({ agent_profile: "executive" as never, input: { data: {}, trust_level: "internal", provenance: "test" } });
    const submitted = await submit(c);
    expect(submitted.status).toBe(200);
    await fetch(`${baseUrl}/worker/tick`, { method: "POST" });
    const view = await queue.get("tenant-personal", c.task_id);
    expect(view?.status).toBe("completed");
  });

  it("C: en ugyldig kontrakt avvises av EKSISTERENDE TaskService.submit()-validering (ingen ny/svakere autorisasjon introdusert av ruten)", async () => {
    const response = await fetch(`${baseUrl}/tasks/submit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: await ownerGrant(), contract: { not: "a valid contract" } })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("task_rejected");
  });
});

describe("D-102: kodejobb-pipelinen (suksessvei via lokal test-agent - EKSAKT samme createCodingHandler-funksjon)", () => {
  // `parseGithubRepoSlug()` gjenkjenner UTELUKKENDE ekte github.com-formede URL-er
  // (D-95, uendret) - `bareRepo` er en lokal filsti, saa `input.repo_url` maa VÆRE
  // github.com-formet for at PR-publisering i det hele tatt skal forsøkes, mens selve
  // `git clone`-kommandoen omdirigeres til det EKTE lokale bare-repoet. SAMME
  // `RepoUrlRedirectingSandboxRunner`-mønster som `pr-publisher.test.ts` (D-95) sine
  // egne L-O-tester - ALDRI en ny/duplikat mekanisme.
  const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-d102-test.git";
  class RepoUrlRedirectingSandboxRunner {
    readonly name = "redirect-sandbox";
    constructor(private readonly inner: ProcessSandboxRunner) {}
    async create(jobEnv?: Record<string, string>) {
      const sandbox = await this.inner.create(jobEnv);
      return {
        workdir: sandbox.workdir,
        exec: (command: string, args: string[], timeoutMs?: number) =>
          sandbox.exec(command, args.map((a) => (a === GITHUB_SHAPED_URL ? bareRepo : a)), timeoutMs),
        dispose: () => sandbox.dispose()
      };
    }
  }

  it("D: agent gjor en EKTE endring -> test-port bestaar -> ekte commit+push -> PR publiseres KUN naar allowed_tools tillater det", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-personal"] }
    });
    const isolatedWorker = new InProcessWorker(queue, 60);
    const githubCalls = { count: 0 };
    isolatedWorker.register(
      "coding",
      withSecretRedaction(
        createCodingHandler({
          sandbox: new RepoUrlRedirectingSandboxRunner(new ProcessSandboxRunner()), agent: new FakeEditingAgent(),
          artifacts: new ArtifactStore(appPool), policy,
          identityFor: (task) => ({
            person_id: task.contract.owner_person_id, tenant_id: task.tenant_id, memory_space_id: "personal",
            session_id: "sess-coding", device_id: "jarvis-core", channel: "api", auth_strength: "active"
          }),
          github: { gateway: fakeGithubGateway(githubCalls) }
        }),
        []
      )
    );

    const mainBefore = git(bareRepo, "rev-parse", "main");
    const cAllowed = contract({
      allowed_tools: ["github"],
      input: { data: { repo_url: GITHUB_SHAPED_URL, test_command: ["node", "test.js"] }, trust_level: "internal", provenance: "test" }
    });
    await queue.enqueue("tenant-personal", cAllowed);
    await isolatedWorker.drain();
    const viewAllowed = await queue.get("tenant-personal", cAllowed.task_id);
    expect(viewAllowed?.status).toBe("completed");
    expect(git(bareRepo, "branch", "--list", `jarvis/${cAllowed.task_id}`)).toContain(`jarvis/${cAllowed.task_id}`);
    expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore); // aldri en produksjonsmerge
    expect(githubCalls.count).toBe(1);
    const pr = (viewAllowed?.result as { pr?: { status?: string } } | undefined)?.pr;
    expect(pr?.status).toBe("created");

    const cNotAllowed = contract({
      allowed_tools: [],
      input: { data: { repo_url: GITHUB_SHAPED_URL, test_command: ["node", "test.js"] }, trust_level: "internal", provenance: "test" }
    });
    await queue.enqueue("tenant-personal", cNotAllowed);
    await isolatedWorker.drain();
    const viewNotAllowed = await queue.get("tenant-personal", cNotAllowed.task_id);
    expect(viewNotAllowed?.status).toBe("completed"); // kodejobben lykkes fortsatt
    const prSkipped = (viewNotAllowed?.result as { pr?: { status?: string } } | undefined)?.pr;
    expect(prSkipped?.status).toBe("skipped_not_allowed");
    expect(githubCalls.count).toBe(1); // ingen nytt GitHub-kall for den ikke-tillatte jobben

    // Sekret aldri i noe artefakt/audit-post produsert av denne jobben:
    const saved = await new ArtifactStore(appPool).list("tenant-personal", cAllowed.task_id);
    for (const artifact of saved) {
      expect(artifact.content).not.toContain("sk-ant-");
    }
  });

  it("E: publiseringens idempotency_key er DETERMINISTISK per task_id (SAMME nøkkel på ethvert forsøk) - EKSISTERENDE D-95-idempotens-grunnlag uendret, aldri en tilfeldig/ny nøkkel per kall", async () => {
    const identity: IdentityContext = {
      person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal",
      session_id: "sess-coding", device_id: "jarvis-core", channel: "api", auth_strength: "active"
    };
    const c = contract({ allowed_tools: ["github"] });
    const seenKeys: (string | undefined)[] = [];
    const gateway = {
      async execute(request: { idempotency_key?: string }): Promise<ToolExecutionResult> {
        seenKeys.push(request.idempotency_key);
        return { ok: true, external_id: "42", output_trust: "internal" as const, deduplicated: seenKeys.length > 1 };
      }
    };
    await publishPullRequestForCodingJob({
      gateway, identity, jobContract: c, repoUrl: GITHUB_SHAPED_URL, branch: `jarvis/${c.task_id}`,
      base: "main", title: "t", body: "b"
    });
    await publishPullRequestForCodingJob({
      gateway, identity, jobContract: c, repoUrl: GITHUB_SHAPED_URL, branch: `jarvis/${c.task_id}`,
      base: "main", title: "t", body: "b"
    });
    expect(seenKeys).toEqual([`coding-job-pr:${c.task_id}`, `coding-job-pr:${c.task_id}`]);
  });
});
