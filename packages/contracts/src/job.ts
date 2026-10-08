import { z } from "zod";
import { JsonValueSchema } from "./capability.ts";

/** Tillitsnivå for inngangsdata (proveniens følger dataene hele veien). */
export const TrustLevelSchema = z.enum(["trusted", "internal", "untrusted"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const AgentProfileSchema = z.enum(["executive", "coding", "research", "verifier"]);
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * Jobbkontrakt (CANONICAL_SPEC §5). Fase 1: kun kontrakten - ingen kø,
 * ingen worker-runtime. Task Service (fase 3) og Worker (fase 6) bygger på denne.
 */
export const JobContractSchema = z
  .object({
    task_id: z.string().min(1),
    owner_person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    goal: z.string().min(1),
    /** Maskinelt sjekkbare akseptansekriterier. */
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    input: z
      .object({
        data: z.record(JsonValueSchema),
        trust_level: TrustLevelSchema,
        provenance: z.string().min(1)
      })
      .strict(),
    /** Verktøy jobben har lov til å bruke (tool_id-er). */
    allowed_tools: z.array(z.string().min(1)),
    /** Datasoner/memory spaces jobben kan lese. */
    allowed_memory_spaces: z.array(z.string().min(1)),
    /** Eksplisitte nettverksmål (allowlist) for sandboxen. */
    allowed_network_targets: z.array(z.string()),
    agent_profile: AgentProfileSchema,
    /** Budsjett i NOK-øre for modellkall knyttet til jobben. */
    model_budget_ore: z.number().int().nonnegative(),
    deadline: z.string().datetime().optional(),
    retry_policy: z
      .object({
        // D-446: øvre grenser - verdiene er brukerstyrt JSON og leses av køens SQL (`claim_next_task`) og `fail()`. En vilkårlig stor verdi har ingen reell bruk og er et driftsrisiko.
        max_attempts: z.number().int().min(1).max(1000),
        backoff_seconds: z.number().int().nonnegative().max(86_400)
      })
      .strict(),
    max_steps: z.number().int().min(1)
  })
  .strict();
export type JobContract = z.infer<typeof JobContractSchema>;
