import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { createPool, EventWriter, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import {
  ArtifactStore, InProcessWorker, JobMemoryAccessor, NO_CHANGES_TO_COMMIT_LABEL, PgTaskQueue, ProcessSandboxRunner,
  ScriptedCodingAgent, TaskService, createCodingHandler, type CodingAgentAdapter, type CodingAgentExec
} from "@jarvis/tasks";

/**
 * D-101: en agent som (korrekt og ærlig) ikke gjør NOEN endring i det hele
 * tatt - motstykket til `ScriptedCodingAgent` (som ALLTID skriver
 * `CHANGES.md`). Modellerer nøyaktig hva en ekte Claude Code-kjøring gjør for
 * Task C sin `honest_failure`-fixture (se `coding-agent-eval.ts`): agenten
 * kjører, returnerer normalt, men rører ALDRI arbeidstreet.
 */
class NoOpCodingAgent implements CodingAgentAdapter {
  readonly name = "no-op-agent";
  async modify(_exec: CodingAgentExec, _goal: string): Promise<string> {
    return "Ærlig avståelse: fant ikke tilstrekkelig grunnlag til å gjøre en endring.";
  }
}

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;
let worker: InProcessWorker;
let tasks: TaskService;
let artifacts: ArtifactStore;
let policy: PolicyGateway;
let killSwitch: KillSwitch;
let bareRepo: string;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-f6", device_id: "dev-pc", channel: "web", auth_strength: "active"
};

function contract(overrides: Partial<JobContract> = {}): JobContract {
  return {
    task_id: `task-${randomUUID()}`,
    owner_person_id: "person-tobias",
    tenant_id: "tenant-a",
    goal: "testjobb",
    acceptance_criteria: ["fullfører"],
    input: { data: {}, trust_level: "internal", provenance: "test" },
    allowed_tools: [],
    allowed_memory_spaces: ["personal"],
    allowed_network_targets: [],
    agent_profile: "executive",
    model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    max_steps: 3,
    ...overrides
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  }
  return result.stdout.trim();
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg6-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
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
    INSERT INTO tenants (tenant_id, name, kind) VALUES
      ('tenant-a','Tobias','person'), ('tenant-budget','Budsjett','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES
      ('person-tobias','tenant-a'), ('person-tobias','tenant-budget');
    INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ('tenant-budget','model:x', 310000);
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });

  killSwitch = new KillSwitch();
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch,
    mandates: new Set(["git:push_branch"])
  });
  queue = new PgTaskQueue(appPool);
  worker = new InProcessWorker(queue, 60);
  tasks = new TaskService(appPool, queue, policy);
  artifacts = new ArtifactStore(appPool);

  worker.register("executive", async (task) => ({ echo: task.contract.goal }));
  worker.register("coding", createCodingHandler({
    sandbox: new ProcessSandboxRunner(),
    agent: new ScriptedCodingAgent(),
    artifacts,
    policy,
    identityFor: (task) => ({ ...identity, tenant_id: task.tenant_id })
  }));
  const gateway = new ModelGateway({
    pool: appPool, trace: new MemoryTraceSink(),
    providers: [new ScriptedAdapter(() => "modellsvar i jobb")]
  });
  worker.register("research", async (task) => {
    const result = await gateway.complete({
      tenant_id: task.tenant_id, task_id: task.task_id,
      request: { messages: [{ role: "user", content: task.contract.goal }] }
    });
    return { summary: result.text };
  });

  // Lokalt bare-repo som "origin" (ekte git; GitHub-API finnes ikke i miljøet)
  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-seed-"));
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

describe("Akseptanse 4 + delegeringskontrakt", () => {
  it("kontrakt uten budsjett/mål avvises; gyldig godtas", async () => {
    const invalid = { ...contract(), model_budget_ore: undefined, goal: undefined };
    expect((await tasks.submit(identity, invalid)).ok).toBe(false);
    const valid = await tasks.submit(identity, contract());
    expect(valid.ok).toBe(true);
  });

  it("Arkitekt-review (P1): kontrakt med en ANNEN owner_person_id enn grant-personen avvises FØR kø, med audit", async () => {
    const forged = contract({ owner_person_id: "person-eier-som-ikke-er-meg", goal: "skal ikke i køen: forged owner" });
    const result = await tasks.submit({ ...identity, person_id: "person-delegat" }, forged);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("owner_mismatch");
    const queued = await adminPool.query("SELECT 1 FROM tasks WHERE task_id = $1", [forged.task_id]);
    expect(queued.rowCount).toBe(0);
    const audit = await adminPool.query("SELECT 1 FROM audit_events WHERE type = 'task.rejected' AND reason = 'owner_mismatch' AND payload->>'task_id' = $1", [forged.task_id]);
    expect(audit.rowCount).toBe(1);
    // samme kontrakt med EIERENS egen identitet godtas
    expect((await tasks.submit(identity, contract({ goal: "eier sender sin egen jobb" }))).ok).toBe(true);
  });

  it("untrusted jobb med privat minne + utgående nettverk avvises strukturelt", async () => {
    const attack = contract({
      input: { data: {}, trust_level: "untrusted", provenance: "ukjent-dokument" },
      allowed_memory_spaces: ["personal"],
      allowed_network_targets: ["https://attacker.example"]
    });
    const result = await tasks.submit(identity, attack);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("untrusted_with_private_memory_and_network");
  });

  it("Remediering del 1: executive-kontrakt med input.data.command avvises deterministisk FØR kø (JARVIS-001/010)", async () => {
    for (const command of [["id"], ["sh", "-c", "env"], []]) {
      const result = await tasks.submit(
        identity,
        contract({ input: { data: { command }, trust_level: "internal", provenance: "test" } })
      );
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBe("executive_command_disabled");
    }
    // en vanlig executive-jobb uten command godtas fortsatt
    expect((await tasks.submit(identity, contract({ goal: "uten command" }))).ok).toBe(true);
    // og den avviste jobben havnet ikke i køen
    const rejected = await tasks.submit(
      identity,
      contract({ goal: "skal ikke i køen", input: { data: { command: ["id"] }, trust_level: "internal", provenance: "test" } })
    );
    expect(rejected.ok).toBe(false);
  });

  it("cross-tenant kontrakt avvises", async () => {
    const result = await tasks.submit(identity, contract({ tenant_id: "tenant-budget" }));
    expect(result.ok).toBe(false);
  });
});

describe("Akseptanse 1: overlever frakobling, stoppes og gjenopptas", () => {
  it("jobb fullfører uten klient; status leses fra ny 'tilkobling'", async () => {
    const submitted = await tasks.submit(identity, contract({ goal: "frakoblingstest" }));
    expect(submitted.ok).toBe(true);
    const taskId = (submitted as { value: { task_id: string } }).value.task_id;
    // "Klienten" er borte (state bor i Postgres); workeren kjører uavhengig:
    await worker.drain();
    const status = await tasks.get(identity, taskId);
    expect(status.ok && status.value.status).toBe("completed");
  });

  it("checkpoint-resume: feilet forsøk gjenopptas fra checkpoint", async () => {
    await worker.drain(); // tøm køen for tidligere testers jobber
    worker.register("verifier", async (_task, ctx) => {
      if (!ctx.checkpoint) {
        await ctx.saveCheckpoint({ progress: 42 });
        throw new Error("simulert krasj etter checkpoint");
      }
      return { resumed_from: ctx.checkpoint["progress"] as number, attempts: ctx.attempts };
    });
    const c = contract({ agent_profile: "verifier", retry_policy: { max_attempts: 2, backoff_seconds: 0 } });
    await queue.enqueue("tenant-a", c);
    await worker.tick(); // forsøk 1: checkpoint + krasj → requeued
    let view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("created");
    await worker.drain(); // forsøk 2: resume fra checkpoint
    view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    expect((view?.result as { resumed_from: number }).resumed_from).toBe(42);
  });

  it("lease/reclaim: utløpt lease kan reclaimes; stale worker kan ikke overskrive", async () => {
    await worker.drain(); // sikre tom kø
    const c = contract();
    await queue.enqueue("tenant-a", c);
    const workerA = await queue.claimNext("worker-A", 1, ["executive"]);
    expect(workerA?.task_id).toBe(c.task_id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const workerB = await queue.claimNext("worker-B", 60, ["executive"]);
    expect(workerB?.task_id).toBe(c.task_id);
    expect(await queue.complete("tenant-a", c.task_id, "worker-A", { stale: true })).toBe(false);
    expect(await queue.complete("tenant-a", c.task_id, "worker-B", { ok: true })).toBe(true);
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    expect((view?.result as { ok: boolean }).ok).toBe(true);
  });
});

describe("Kansellering (pending/running/ferdig/dobbel)", () => {
  it("pending → cancelled direkte; ferdig → not_cancellable; dobbel cancel → not_cancellable", async () => {
    const c = contract();
    await queue.enqueue("tenant-a", c);
    expect(await queue.requestCancel("tenant-a", c.task_id)).toBe("cancelled");
    expect(await queue.requestCancel("tenant-a", c.task_id)).toBe("not_cancellable");
  });

  it("running jobb avbrytes ved neste sjekkpunkt; ingen handling etter kansellering", async () => {
    let actionsAfterCancel = 0;
    worker.register("verifier", async (_task, ctx) => {
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await ctx.assertNotCancelled();
      }
      actionsAfterCancel += 1;
      return {};
    });
    const c = contract({ agent_profile: "verifier" });
    await queue.enqueue("tenant-a", c);
    const running = worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await queue.requestCancel("tenant-a", c.task_id)).toBe("requested");
    await running;
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("cancelled");
    expect(actionsAfterCancel).toBe(0);
  });
});

describe("Retry-idempotens: ekstern handling dobles aldri", () => {
  it("krasj etter ekstern handling + retry gir nøyaktig én hendelse", async () => {
    const events = new EventWriter(appPool);
    const externalKey = `ekstern-${randomUUID()}`;
    worker.register("verifier", async (task, ctx) => {
      await events.append({
        event_id: randomUUID(), idempotency_key: externalKey,
        occurred_at: new Date().toISOString(), source: "worker.flaky", type: "external.action",
        tenant_id: task.tenant_id, trust_level: "internal", payload: {}
      });
      if (ctx.attempts === 1) {
        throw new Error("krasj etter ekstern handling");
      }
      return { done: true };
    });
    const c = contract({ agent_profile: "verifier", retry_policy: { max_attempts: 2, backoff_seconds: 0 } });
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");
    const count = await adminPool.query("SELECT count(*)::int AS n FROM events WHERE idempotency_key = $1", [externalKey]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe("Akseptanse 2+3: kodejobb i sandbox med branch og menneskelig merge-gate", () => {
  it("kloner, endrer på jobb-branch, tester, pusher branch og lager artefakter; main urørt", async () => {
    const mainBefore = git(bareRepo, "rev-parse", "main");
    const c = contract({
      goal: "legg til CHANGES.md",
      input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "test" },
      allowed_network_targets: ["local-git"]
    });
    (c as { agent_profile: string }).agent_profile = "coding" as never;
    const submitted = await tasks.submit(identity, c);
    expect(submitted.ok).toBe(true);
    await worker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("completed");

    const branches = git(bareRepo, "branch", "--list", `jarvis/${c.task_id}`);
    expect(branches).toContain(`jarvis/${c.task_id}`);
    expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore); // ingen produksjonsmerge

    const saved = await artifacts.list("tenant-a", c.task_id);
    const kinds = saved.map((a) => a.kind).sort();
    expect(kinds).toEqual(["patch", "pr-proposal", "test-log"]);
    expect(saved.find((a) => a.kind === "pr-proposal")?.content).toContain("MENNESKELIG");
  });

  it("uten policy-mandat for push feiler kodejobben kontrollert", async () => {
    const noMandatePolicy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch()
    });
    const isolatedWorker = new InProcessWorker(queue, 60);
    isolatedWorker.register("coding", createCodingHandler({
      sandbox: new ProcessSandboxRunner(), agent: new ScriptedCodingAgent(), artifacts,
      policy: noMandatePolicy, identityFor: () => identity
    }));
    const c = contract({ input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "t" } });
    (c as { agent_profile: string }).agent_profile = "coding" as never;
    await queue.enqueue("tenant-a", c);
    await isolatedWorker.drain();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("policy_denied");
  });

  it("kill switch stopper delegerte verktøykall (jobb feiler kontrollert)", async () => {
    killSwitch.activate("test");
    const c = contract({ input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "t" } });
    (c as { agent_profile: string }).agent_profile = "coding" as never;
    await queue.enqueue("tenant-a", c);
    await worker.drain();
    killSwitch.deactivate();
    const view = await queue.get("tenant-a", c.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toContain("kill_switch");
  });

  describe("D-101: agent gjør ingen endring - ærlig no-op, ALDRI en tvunget tom commit eller en ugjennomsiktig git-feil", () => {
    it("ingen commit, ingen push, kastet feil er NØYAKTIG den nye etiketten (ALDRI 'commit_failed')", async () => {
      const mainBefore = git(bareRepo, "rev-parse", "main");
      const isolatedWorker = new InProcessWorker(queue, 60);
      isolatedWorker.register("coding", createCodingHandler({
        sandbox: new ProcessSandboxRunner(), agent: new NoOpCodingAgent(), artifacts,
        policy, identityFor: () => identity
      }));
      const c = contract({
        goal: "ingen endring skal gjøres",
        input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "test" }
      });
      (c as { agent_profile: string }).agent_profile = "coding" as never;
      await queue.enqueue("tenant-a", c);
      await isolatedWorker.drain();

      const view = await queue.get("tenant-a", c.task_id);
      expect(view?.status).toBe("failed");
      expect(view?.last_error).toBe(NO_CHANGES_TO_COMMIT_LABEL);
      expect(view?.last_error).not.toContain("commit_failed");

      // Ingen jobb-branch ble noensinne pushet til origin - jobben stanset FØR add/commit/push:
      expect(git(bareRepo, "branch", "--list", `jarvis/${c.task_id}`)).toBe("");
      expect(git(bareRepo, "rev-parse", "main")).toBe(mainBefore);

      // KUN test-loggen (skrevet FØR add/commit-sjekken) ble persistert - INGEN patch/pr-proposal:
      const saved = await artifacts.list("tenant-a", c.task_id);
      expect(saved.map((a) => a.kind).sort()).toEqual(["test-log"]);
    });

    it("en agent som FAKTISK gjør en endring er 100% uendret (Task A/B-klassen, regresjon)", async () => {
      const isolatedWorker = new InProcessWorker(queue, 60);
      isolatedWorker.register("coding", createCodingHandler({
        sandbox: new ProcessSandboxRunner(), agent: new ScriptedCodingAgent(), artifacts,
        policy, identityFor: () => identity
      }));
      const c = contract({
        goal: "legg til CHANGES.md igjen",
        input: { data: { repo_url: bareRepo }, trust_level: "internal", provenance: "test" }
      });
      (c as { agent_profile: string }).agent_profile = "coding" as never;
      await queue.enqueue("tenant-a", c);
      await isolatedWorker.drain();
      const view = await queue.get("tenant-a", c.task_id);
      expect(view?.status).toBe("completed");
      const saved = await artifacts.list("tenant-a", c.task_id);
      expect(saved.map((a) => a.kind).sort()).toEqual(["patch", "pr-proposal", "test-log"]);
    });
  });
});

describe("Budsjett og minne i delegerte jobber", () => {
  it("delegert modellbruk går via Model Gateway: kost på task_id; hardgrense håndheves", async () => {
    const ok = contract({ goal: "oppsummer" });
    (ok as { agent_profile: string }).agent_profile = "research" as never;
    await queue.enqueue("tenant-a", ok);
    await worker.drain();
    expect((await queue.get("tenant-a", ok.task_id))?.status).toBe("completed");
    const cost = await adminPool.query("SELECT count(*)::int AS n FROM cost_events WHERE task_id = $1", [ok.task_id]);
    expect(cost.rows[0].n).toBe(1);

    const blocked = contract({ tenant_id: "tenant-budget", goal: "over budsjett" });
    (blocked as { agent_profile: string }).agent_profile = "research" as never;
    await queue.enqueue("tenant-budget", blocked);
    await worker.drain();
    const view = await queue.get("tenant-budget", blocked.task_id);
    expect(view?.status).toBe("failed");
    expect(view?.last_error).toMatch(/budsjett|Månedsbudsjettet/i);
  });

  it("jobb-minnetilgang begrenses til kontraktens spaces", async () => {
    const businessAccessor = new JobMemoryAccessor({ search: async () => [] }, ["business"]);
    await expect(businessAccessor.search(identity, ["health"], "x")).rejects.toThrow("memory_space_not_in_contract");
    await expect(businessAccessor.search(identity, ["business"], "x")).resolves.toEqual([]);
    const guestAccessor = new JobMemoryAccessor({ search: async () => [] }, ["guest"]);
    await expect(guestAccessor.search(identity, ["personal"], "x")).rejects.toThrow("memory_space_not_in_contract");
  });

  it("klasse D via worker-kontekst krever fortsatt signert godkjenning", async () => {
    const result = await policy.authorize({
      identity: { ...identity, delegation_id: "job-delegation" },
      toolCall: { tool_id: "home-assistant", action: "unlock_front_door", capability_class: "D", parameters: {} }
    });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_missing_approval");
  });
});
