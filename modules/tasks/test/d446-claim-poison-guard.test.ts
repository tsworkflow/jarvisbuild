import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { PgTaskQueue, retryBackoffSeconds } from "@jarvis/tasks";

/**
 * D-446 (JARVIS-040, rest): giftpille-vern i `claim_next_task` (en jobb som dreper workeren gjenopptas ikke for alltid) og retry-backoff (`tasks.not_before`).
 * Kjører mot ekte Postgres som den vanlige runtime-rollen (`jarvis_app`-medlem, ikke superbruker), så kolonne-rettighetene til definer-rollen er en del av det som testes.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;

const TENANT = "tenant-d446";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d446-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d446 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d446");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','D446','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-d446','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-d446','${TENANT}');
  `);
  appPool = createPool({ ...base, user: "jarvis_d446", password: "pw2" });
  appPool.on("error", () => undefined);
  queue = new PgTaskQueue(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const contract = (overrides: { max_attempts?: number; backoff_seconds?: number; agent_profile?: JobContract["agent_profile"] } = {}): JobContract => ({
  task_id: `task-${randomUUID()}`, owner_person_id: "person-d446", tenant_id: TENANT, goal: "giftpille-test",
  acceptance_criteria: ["fullfører"], input: { data: {}, trust_level: "internal", provenance: "test" },
  allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: overrides.agent_profile ?? "executive",
  model_budget_ore: 1000, retry_policy: { max_attempts: overrides.max_attempts ?? 1, backoff_seconds: overrides.backoff_seconds ?? 0 }, max_steps: 3
});

const expireLease = (taskId: string) =>
  adminPool.query("UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE task_id = $1", [taskId]);
const row = async (taskId: string) =>
  (await adminPool.query<{ status: string; attempts: number; last_error: string | null; finished_at: Date | null; not_before: Date | null; worker_id: string | null }>(
    "SELECT status, attempts, last_error, finished_at, not_before, worker_id FROM tasks WHERE task_id = $1", [taskId]
  )).rows[0]!;
const secondsAhead = (d: Date | null): number => (d === null ? Number.NaN : (d.getTime() - Date.now()) / 1000);

describe("D-446: giftpille-vern i claim_next_task", () => {
  it("en jobb som mister leasen gjenopptas høyst ÉN gang (max_attempts + 1 starter); deretter settes den til failed med forklaring og startes ikke på nytt", async () => {
    const job = contract({ max_attempts: 1 });
    await queue.enqueue(TENANT, job);
    const claims: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const claimed = await queue.claimNext("worker-a", 60, ["executive"]);
      expect(claimed?.task_id).toBe(job.task_id);
      claims.push(claimed!.attempts);
      await expireLease(job.task_id); // workeren krasjet: ingen fullføring, leasen utløper
    }
    expect(claims).toEqual([1, 2]); // første kjøring + én gjenopptakelse (handlerne har ikke sjekkpunkt-gjenopptakelse i dag: det er en kjøring fra start)
    expect(await queue.claimNext("worker-b", 60, ["executive"])).toBeNull(); // tredje gang: ikke startet på nytt
    const after = await row(job.task_id);
    expect(after.status).toBe("failed");
    expect(after.last_error).toMatch(/^lease_expired_claims_exhausted: jobben er startet 2 ganger/);
    expect(after.finished_at).not.toBeNull();
    expect(after.worker_id).toBeNull();
    expect(await queue.claimNext("worker-b", 60, ["executive"])).toBeNull(); // forblir failed
    expect((await queue.get(TENANT, job.task_id))?.status).toBe("failed");
  });

  it("forklaringen beholder forrige feil, og en jobb der kansellering var bedt om ender som cancelled (ikke failed)", async () => {
    const failing = contract({ max_attempts: 1 });
    await queue.enqueue(TENANT, failing);
    await adminPool.query(
      "UPDATE tasks SET status = 'running', attempts = 2, worker_id = 'dead', last_error = 'handler feilet: nettverk', lease_expires_at = now() - interval '1 second' WHERE task_id = $1", [failing.task_id]
    );
    const cancelled = contract({ max_attempts: 1 });
    await queue.enqueue(TENANT, cancelled);
    await adminPool.query(
      "UPDATE tasks SET status = 'running', attempts = 2, worker_id = 'dead', cancel_requested = true, lease_expires_at = now() - interval '1 second' WHERE task_id = $1", [cancelled.task_id]
    );
    expect(await queue.claimNext("w", 60, ["executive"])).toBeNull();
    const a = await row(failing.task_id);
    expect(a.status).toBe("failed");
    expect(a.last_error).toContain("Forrige feil: handler feilet: nettverk");
    const b = await row(cancelled.task_id);
    expect(b.status).toBe("cancelled");
    expect(b.finished_at).not.toBeNull();
  });

  it("vernet gjelder kun jobber denne workeren faktisk kunne claimet (egen agentprofil): en worker uten 'coding'-handler rører ikke en coding-jobb", async () => {
    const job = contract({ max_attempts: 1, agent_profile: "coding" });
    await queue.enqueue(TENANT, job);
    for (let i = 0; i < 2; i += 1) {
      expect((await queue.claimNext("coder", 60, ["coding"]))?.task_id).toBe(job.task_id);
      await expireLease(job.task_id);
    }
    expect(await queue.claimNext("exec", 60, ["executive"])).toBeNull();
    expect((await row(job.task_id)).status).toBe("running"); // urørt av en worker som ikke eier profilen
    expect(await queue.claimNext("coder", 60, ["coding"])).toBeNull();
    expect((await row(job.task_id)).status).toBe("failed");
  });

  it("en jobb med levende lease røres aldri, uansett antall forsøk; og en jobb under grensen gjenopptas normalt (regresjon: gjenopptakelse etter krasj virker)", async () => {
    const live = contract({ max_attempts: 1 });
    await queue.enqueue(TENANT, live);
    await adminPool.query(
      "UPDATE tasks SET status = 'running', attempts = 9, worker_id = 'w', lease_expires_at = now() + interval '5 minutes' WHERE task_id = $1", [live.task_id]
    );
    expect(await queue.claimNext("other", 60, ["executive"])).toBeNull();
    const untouched = await row(live.task_id);
    expect(untouched).toMatchObject({ status: "running", attempts: 9, worker_id: "w" });

    const resumable = contract({ max_attempts: 3 }); // grense 3 + 1 = 4 starter
    await queue.enqueue(TENANT, resumable);
    await adminPool.query(
      "UPDATE tasks SET status = 'running', attempts = 3, worker_id = 'dead', lease_expires_at = now() - interval '1 second' WHERE task_id = $1", [resumable.task_id]
    );
    const resumed = await queue.claimNext("w2", 60, ["executive"]);
    expect(resumed).toMatchObject({ task_id: resumable.task_id, attempts: 4 });
    await expireLease(resumable.task_id);
    expect(await queue.claimNext("w2", 60, ["executive"])).toBeNull(); // 4 >= 3 + 1
    expect((await row(resumable.task_id)).status).toBe("failed");
  });

  it("en ugyldig, manglende eller vilkårlig stor max_attempts i kontrakt-JSON kan ALDRI få claim til å kaste (ville stanset hele køen) - jobben gjenopptas som om max_attempts var 1", async () => {
    const oddValues: Array<[string, string | null]> = [
      ["MAX_SAFE_INTEGER", "9007199254740991"], ["int4-maks", "2147483647"], ["10 milliarder", "10000000000"], ["1e21", "1e21"],
      ["tekst", '"abc"'], ["null", "null"], ["negativ", "-5"], ["null-verdi 0", "0"], ["desimal", "1.5"], ["boolsk", "true"], ["manglende nøkkel", null]
    ];
    for (const [label, jsonValue] of oddValues) {
      const job = contract({ max_attempts: 1 });
      await queue.enqueue(TENANT, job);
      await adminPool.query(
        jsonValue === null
          ? "UPDATE tasks SET contract = contract #- '{retry_policy,max_attempts}', status = 'running', attempts = 1, worker_id = 'dead', lease_expires_at = now() - interval '1 second' WHERE task_id = $1"
          : `UPDATE tasks SET contract = jsonb_set(contract, '{retry_policy,max_attempts}', '${jsonValue}'::jsonb), status = 'running', attempts = 1, worker_id = 'dead', lease_expires_at = now() - interval '1 second' WHERE task_id = $1`,
        [job.task_id]
      );
      let claimed: Awaited<ReturnType<typeof queue.claimNext>> | undefined;
      await expect(
        (async () => { claimed = await queue.claimNext("w", 60, ["executive"]); })(),
        `max_attempts = ${label}`
      ).resolves.toBeUndefined();
      // 1 start så langt, grense (minst) 1 + 1 = 2: gjenopptas som start nr. 2 for alle de "snille" verdiene; en stor verdi gir enda mer rom.
      expect(claimed?.task_id, label).toBe(job.task_id);
      expect(claimed?.attempts, label).toBe(2);
      await queue.complete(TENANT, job.task_id, "w", { ok: true });
    }
  });
});

describe("D-446: retry-backoff (tasks.not_before)", () => {
  it("retryBackoffSeconds: eksponentiell, begrenset til en time, og 0/ugyldig gir ingen ventetid", () => {
    expect(retryBackoffSeconds(1, 30)).toBe(30);
    expect(retryBackoffSeconds(2, 30)).toBe(60);
    expect(retryBackoffSeconds(3, 30)).toBe(120);
    expect(retryBackoffSeconds(30, 30)).toBe(3600);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(retryBackoffSeconds(2, bad), String(bad)).toBe(0);
  });

  it("fail() med forsøk igjen setter not_before; claim hopper over jobben til tidspunktet er passert; ventetiden dobles per forsøk", async () => {
    const job = contract({ max_attempts: 3, backoff_seconds: 30 });
    await queue.enqueue(TENANT, job);
    const first = await queue.claimNext("w", 60, ["executive"]);
    expect(first?.attempts).toBe(1);
    expect(await queue.fail(TENANT, job.task_id, "w", "leverandør nede")).toBe("created");
    const afterFirst = await row(job.task_id);
    expect(afterFirst.status).toBe("created");
    expect(secondsAhead(afterFirst.not_before)).toBeGreaterThan(25);
    expect(secondsAhead(afterFirst.not_before)).toBeLessThan(35);
    expect(await queue.claimNext("w", 60, ["executive"])).toBeNull(); // venter på backoff

    await adminPool.query("UPDATE tasks SET not_before = now() - interval '1 second' WHERE task_id = $1", [job.task_id]);
    const second = await queue.claimNext("w", 60, ["executive"]);
    expect(second?.attempts).toBe(2);
    expect((await row(job.task_id)).not_before).toBeNull(); // nullstilt ved claim
    expect(await queue.fail(TENANT, job.task_id, "w", "fortsatt nede")).toBe("created");
    const secondWait = secondsAhead((await row(job.task_id)).not_before);
    expect(secondWait).toBeGreaterThan(55); // 30 * 2
    expect(secondWait).toBeLessThan(65);

    await adminPool.query("UPDATE tasks SET not_before = NULL WHERE task_id = $1", [job.task_id]);
    expect((await queue.claimNext("w", 60, ["executive"]))?.attempts).toBe(3);
    expect(await queue.fail(TENANT, job.task_id, "w", "gir opp")).toBe("failed");
    expect(await row(job.task_id)).toMatchObject({ status: "failed", not_before: null });
  });

  it("ventetiden gjennom fail() er begrenset til en time selv når backoff_seconds * 2^(forsøk-1) er enormt", async () => {
    const job = contract({ max_attempts: 1000, backoff_seconds: 30 });
    await queue.enqueue(TENANT, job);
    await queue.claimNext("w", 60, ["executive"]);
    await adminPool.query("UPDATE tasks SET attempts = 40 WHERE task_id = $1", [job.task_id]);
    expect(await queue.fail(TENANT, job.task_id, "w", "feil")).toBe("created");
    const wait = secondsAhead((await row(job.task_id)).not_before);
    expect(wait).toBeGreaterThan(3500);
    expect(wait).toBeLessThan(3700);
  });

  it("backoff_seconds = 0 (alle jobber i drift i dag): umiddelbart claimbar igjen, uendret oppførsel", async () => {
    const job = contract({ max_attempts: 2, backoff_seconds: 0 });
    await queue.enqueue(TENANT, job);
    await queue.claimNext("w", 60, ["executive"]);
    expect(await queue.fail(TENANT, job.task_id, "w", "feil")).toBe("created");
    expect((await row(job.task_id)).not_before).toBeNull();
    expect((await queue.claimNext("w", 60, ["executive"]))?.attempts).toBe(2);
  });

  it("en jobb som venter på backoff kan fortsatt kanselleres direkte", async () => {
    const job = contract({ max_attempts: 2, backoff_seconds: 600 });
    await queue.enqueue(TENANT, job);
    await queue.claimNext("w", 60, ["executive"]);
    await queue.fail(TENANT, job.task_id, "w", "feil");
    expect(await queue.requestCancel(TENANT, job.task_id)).toBe("cancelled");
    expect((await row(job.task_id)).status).toBe("cancelled");
  });
});
