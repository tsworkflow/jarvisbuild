import type pg from "pg";
import type { IdentityContext, JobContract, MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { TaskService } from "@jarvis/tasks";
import type { IncidentService } from "./service.ts";
import type { Incident } from "./types.ts";

export interface ProposeRepairTaskInput {
  repo_url: string;
  goal: string;
  test_command?: string[];
  /** Krever `allowed_tools: ["github"]` for at D-95 PR-publisering skal skje - uten den fullføres jobben likevel (skipped_not_allowed, D-95-presedens uendret). */
  publishPr?: boolean;
  model_budget_ore?: number;
}

export type ProposeRepairTaskResult =
  | { ok: true; task_id: string }
  | { ok: false; reason: string };

/**
 * D-104 Part C: hendelse -> DEN EKSISTERENDE, allerede live-verifiserte
 * D-102/D-103 testet-fiks-pipelinen (`TaskService.submit()` ->
 * `createCodingHandler` -> ekte `ClaudeCodeAgent` -> uavhengig testport ->
 * commit -> autentisert push -> valgfri PR). Denne funksjonen GJØR ALDRI
 * selve kodeendringen/testkjøringen/pushen - den bygger KUN en
 * standard-`JobContract` (agent_profile: "coding", UENDRET kontrakt-skjema)
 * og sender den inn via DEN SAMME `TaskService`-instansen produksjons-APIet
 * allerede bruker (`POST /tasks/submit`, D-102). `input.data.incident_id`
 * er den ENESTE nye kontrakt-dataen - lar `createCodingHandler` (helt
 * uendret) sitt eksisterende `input.data`-felt bære lenken tilbake til
 * hendelsen, verifisert av `incident_repair_tasks`-lenkeraden under.
 *
 * INGEN auto-merge (uendret D-95/D-102-regel - PR-en publiseres, aldri
 * merget). Hendelsen flyttes til `repair_proposed` KUN ved en vellykket
 * innsending - en avvist jobb (policy/kontrakt-feil) endrer ALDRI
 * hendelsens status.
 */
export async function proposeRepairTask(
  deps: { taskService: TaskService; pool: pg.Pool; incidents: IncidentService },
  identity: IdentityContext,
  memorySpace: MemorySpace,
  incident: Incident,
  input: ProposeRepairTaskInput
): Promise<ProposeRepairTaskResult> {
  const task_id = `inc-repair-${incident.incident_id}-${Date.now().toString(36)}`;
  const contract: JobContract = {
    task_id,
    // Arkitekt-review (P1): jobbens eier er ALLTID den verifiserte innsenderen (TaskService.submit krever det), aldri en verdi fra incident-raden.
    owner_person_id: identity.person_id,
    tenant_id: incident.tenant_id,
    goal: input.goal,
    acceptance_criteria: ["tester bestaar", "endring committet og pushet"],
    input: {
      data: { repo_url: input.repo_url, test_command: input.test_command ?? [], incident_id: incident.incident_id },
      trust_level: "internal",
      provenance: "incident-repair-orchestration"
    },
    allowed_tools: input.publishPr ? ["github"] : [],
    allowed_memory_spaces: [memorySpace],
    allowed_network_targets: [],
    agent_profile: "coding",
    model_budget_ore: input.model_budget_ore ?? 20_000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    max_steps: 5
  };

  const result = await deps.taskService.submit(identity, contract);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  await withTenantTransaction(deps.pool, incident.tenant_id, (client) =>
    client.query(
      `INSERT INTO incident_repair_tasks (incident_id, task_id, tenant_id) VALUES ($1, $2, $3)`,
      [incident.incident_id, task_id, incident.tenant_id]
    )
  );
  if (incident.status === "open" || incident.status === "diagnosing") {
    await deps.incidents.setStatus(incident.tenant_id, memorySpace, incident.incident_id, "repair_proposed");
  }

  return { ok: true, task_id };
}
