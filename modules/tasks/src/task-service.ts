import { randomUUID } from "node:crypto";
import type pg from "pg";
import { JobContractSchema, type IdentityContext, type JobContract, type MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import { GitPolicyError, assertRepoAllowed, assertTestCommand } from "./git-policy.ts";
import type { TaskView, WorkflowAdapter } from "./workflow-adapter.ts";

export type TaskServiceResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Task Service (fase 3): opprette/følge/avbryte jobber. Skriveoperasjoner går
 * gjennom Policy Gateway (klasse B) før de når køen - sikkerhetsflyt:
 * IdentityContext → policy → DB-transaksjon → skriv → audit.
 */
export interface TaskServiceOptions {
  /**
   * Remediering del 2 (JARVIS-064): når satt, avvises en kodejobb (agent_profile "coding") ved innsending hvis
   * `repo_url` ikke er eksakt `https://github.com/<owner>/<repo>` i denne allowlisten (tom liste = alt avvises).
   * Uten verdien håndheves allowlisten kun av kodejobb-handleren ved kjøring (fail closed når git-credential er konfigurert).
   */
  readonly codingRepoAllowlist?: readonly string[];
}

export class TaskService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly queue: WorkflowAdapter,
    private readonly policy: PolicyGateway,
    private readonly options: TaskServiceOptions = {}
  ) {}

  async create(identity: IdentityContext, goal: string): Promise<TaskServiceResult<{ task_id: string }>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "create_task", capability_class: "B", parameters: { goal } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const contract: JobContract = {
      task_id: `task-${randomUUID()}`,
      owner_person_id: identity.person_id,
      tenant_id: identity.tenant_id,
      goal,
      acceptance_criteria: ["jobben fullfører med et resultat"],
      input: { data: {}, trust_level: "internal", provenance: `chat:${identity.session_id}` },
      allowed_tools: [],
      allowed_memory_spaces: [identity.memory_space_id],
      allowed_network_targets: [],
      agent_profile: "executive",
      model_budget_ore: 0,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 },
      max_steps: 1
    };
    await this.queue.enqueue(identity.tenant_id, contract);
    await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "task.created", payload: { task_id: contract.task_id, goal } })
    );
    return { ok: true, value: { task_id: contract.task_id } };
  }

  async get(identity: IdentityContext, taskId: string): Promise<TaskServiceResult<TaskView>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "read_task", capability_class: "A", parameters: { task_id: taskId } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const task = await this.queue.get(identity.tenant_id, taskId);
    return task ? { ok: true, value: task } : { ok: false, reason: "task_not_found" };
  }

  async cancel(identity: IdentityContext, taskId: string): Promise<TaskServiceResult<{ cancelled: boolean }>> {
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "cancel_task", capability_class: "B", parameters: { task_id: taskId } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    const outcome = await this.queue.requestCancel(identity.tenant_id, taskId);
    await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "task.cancelled", payload: { task_id: taskId, outcome } })
    );
    return { ok: true, value: { cancelled: outcome !== "not_cancellable" } };
  }

  /**
   * Delegeringskontrakt (fase 6): ekstern/full kontrakt valideres og håndheves
   * FØR kø. Strukturell sikkerhetsregel (SECURITY_MODEL §2-invarianten):
   * en untrusted jobb får ALDRI både private minneområder og utgående nettverk.
   */
  async submit(identity: IdentityContext, contractInput: unknown): Promise<TaskServiceResult<{ task_id: string }>> {
    const parsed = JobContractSchema.safeParse(contractInput);
    if (!parsed.success) {
      await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
        writeAudit(client, identity, { type: "task.rejected", reason: "invalid_contract" })
      );
      return { ok: false, reason: "invalid_contract" };
    }
    const contract = parsed.data;
    if (contract.tenant_id !== identity.tenant_id) {
      return { ok: false, reason: "tenant_mismatch" };
    }
    // Arkitekt-review av #219 (P1): kontraktens `owner_person_id` blir kodejobbens identitet i workeren (og eier ⇒ SOVEREIGN
    // i policy). Den MÅ derfor være nøyaktig den verifiserte grant-personen - aldri en verdi klienten selv har satt.
    if (contract.owner_person_id !== identity.person_id) {
      await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
        writeAudit(client, identity, { type: "task.rejected", reason: "owner_mismatch", payload: { task_id: contract.task_id } })
      );
      return { ok: false, reason: "owner_mismatch" };
    }
    // Remediering del 1 (JARVIS-001/010): executive-`command`-jobber (vilkårlig
    // kommandokjøring i worker-containeren) er deaktivert - avvises FØR kø/policy.
    const submittedData = contract.input.data as Record<string, unknown>;
    if (contract.agent_profile === "executive" && submittedData["command"] !== undefined && submittedData["command"] !== null) {
      await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
        writeAudit(client, identity, {
          type: "task.rejected",
          reason: "executive_command_disabled",
          payload: { task_id: contract.task_id }
        })
      );
      return { ok: false, reason: "executive_command_disabled" };
    }
    // Remediering del 2 (JARVIS-009/064): kodejobb-input valideres deterministisk FØR kø - repo må være allowlistet,
    // testkommando må være en kjent testløper (aldri en vilkårlig kommando fra en task contract).
    if (contract.agent_profile === "coding") {
      try {
        const testCommand = submittedData["test_command"];
        if (Array.isArray(testCommand) && testCommand.length > 0) assertTestCommand(testCommand);
        else if (testCommand !== undefined && testCommand !== null && !Array.isArray(testCommand)) throw new GitPolicyError("test_command_invalid");
        if (this.options.codingRepoAllowlist !== undefined) assertRepoAllowed(submittedData["repo_url"], this.options.codingRepoAllowlist);
      } catch (err) {
        if (!(err instanceof GitPolicyError)) throw err;
        await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
          writeAudit(client, identity, { type: "task.rejected", reason: `coding_input_rejected:${err.reason}`, payload: { task_id: contract.task_id } })
        );
        return { ok: false, reason: `coding_input_rejected:${err.reason}` };
      }
    }
    const privateSpaces = ["personal", "health", "business", "project", "home"];
    if (
      contract.input.trust_level === "untrusted" &&
      contract.allowed_network_targets.length > 0 &&
      contract.allowed_memory_spaces.some((space) => privateSpaces.includes(space))
    ) {
      await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
        writeAudit(client, identity, {
          type: "task.rejected",
          reason: "untrusted_with_private_memory_and_network",
          payload: { task_id: contract.task_id }
        })
      );
      return { ok: false, reason: "untrusted_with_private_memory_and_network" };
    }
    const decision = await this.policy.authorize({
      identity,
      toolCall: { tool_id: "tasks", action: "submit_task", capability_class: "B", parameters: { task_id: contract.task_id } }
    });
    if (decision.decision !== "ALLOW") {
      return { ok: false, reason: decision.reason };
    }
    await this.queue.enqueue(identity.tenant_id, contract);
    await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: "task.submitted", payload: { task_id: contract.task_id } })
    );
    return { ok: true, value: { task_id: contract.task_id } };
  }
}

/**
 * Minnetilgang for delegerte jobber: KUN kontraktens tillatte spaces.
 * Ingen agent får «hele Jarvis» - forespørsel utenfor mandatet avvises.
 */
export class JobMemoryAccessor {
  constructor(
    private readonly retriever: { search(identity: IdentityContext, opts: { spaces: MemorySpace[]; query: string }): Promise<unknown[]> },
    private readonly allowedSpaces: readonly string[]
  ) {}

  async search(identity: IdentityContext, spaces: MemorySpace[], query: string): Promise<unknown[]> {
    for (const space of spaces) {
      if (!this.allowedSpaces.includes(space)) {
        throw new Error(`memory_space_not_in_contract:${space}`);
      }
    }
    return this.retriever.search(identity, { spaces, query });
  }
}
