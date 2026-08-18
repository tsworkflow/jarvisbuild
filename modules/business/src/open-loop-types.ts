/**
 * UA-3 next slice (D-53): automatisk open-loop-deteksjon (masterplan-
 * akseptansekriterium 3, "Open loops detected automatically") + Business
 * OS-tidslinje for daglig/ukentlig brief. Additivt pa P0-domenemodellen i
 * types.ts - ingen eksisterende entitet endret.
 */

export type OpenLoopType = "overdue_followup" | "stalled_opportunity" | "support_ticket_needs_reply";
export type OpenLoopDetectionMethod = "deterministic" | "ai_assisted";
export type OpenLoopPriority = "low" | "normal" | "high";
export type OpenLoopStatus = "open" | "resolved";

export interface BusinessOpenLoop {
  open_loop_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  lead_id: string | null;
  followup_id: string | null;
  activity_id: string | null;
  loop_type: OpenLoopType;
  detection_key: string;
  detection_method: OpenLoopDetectionMethod;
  confidence: number | null;
  reason: string;
  next_action: string | null;
  canonical_uri: string | null;
  priority: OpenLoopPriority;
  status: OpenLoopStatus;
  owner_person_id: string | null;
  opened_at: string;
  due_at: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** §16 i byggeordren: sporrbar visning over persistert state, ikke en transient LLM-svar. */
export type AttentionBucket = "critical" | "overdue" | "due_soon" | "informational";

export interface AttentionQueueEntry {
  bucket: AttentionBucket;
  loop: BusinessOpenLoop;
}

export interface SweepResult {
  detected: number;
  updated: number;
  auto_resolved: number;
}

/** §15: bedriftshelse-akseptansekriteriet krever sales+product+finance+marketing+operations -
 * denne sliceen dekker KUN sales/CRM (Business Graph). Andre domener MÅ rapporteres som
 * ikke-integrert, aldri fabrikkert - se BusinessDomainCoverage i business-brief.ts. */
export type BusinessDomain = "sales" | "product" | "finance" | "marketing" | "operations";
