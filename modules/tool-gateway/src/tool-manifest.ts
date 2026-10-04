import type { CapabilityClass } from "@jarvis/contracts";
import type { ToolDefinition } from "./gateway.ts";
import { CHAT_READ_TIER, CHAT_READ_TIER_KEYS } from "./chat-read-tier.ts";
import { CHAT_ACT_TIER, CHAT_ACT_TIER_KEYS } from "./chat-act-tier.ts";

/**
 * Del 3 (JARVIS-002/015/028): ÉTT sentralt capability-/tool-manifest. Hver registrert handling får en manifest-oppføring AVLEDET fra
 * definisjonen + eksplisitte overstyringer - aldri en parallell håndvedlikeholdt liste. Manifestet er den eneste kilden til:
 *   - risiko A-D og EFFEKT (read/write/send/pay/delete/control),
 *   - datasone/sensitivitet/kostnadstype/nettverksmål,
 *   - idempotens-/preflight-/postcondition-/recovery-krav,
 *   - hvilke FLATER (web_chat/voice/telegram/background/coding) handlingen kan stå på (default: ingen).
 * `assertManifestInvariants()` er en deterministisk bootsjekk (feiler lukket) og en test-port - prompttekst teller aldri som kontroll.
 */
export const SURFACES = ["web_chat", "voice", "telegram", "background", "coding"] as const;
export type Surface = (typeof SURFACES)[number];

export type Effect = "read" | "write" | "send" | "pay" | "delete" | "control";
export type DataZone = "internal" | "vendor_cloud" | "financial";
export type Sensitivity = "public" | "private" | "business" | "restricted";
export type CostKind = "free" | "metered" | "paid";
export type NetworkTarget = "none" | "vendor" | "owner_configured_url";
export type IdempotencyRequirement = "none" | "recommended" | "required";
export type Recovery = "none" | "documented" | "executable";

export interface ToolManifestEntry {
  key: string;
  tool_id: string;
  action: string;
  owner: "jarvis_core" | "owner_connector";
  risk: CapabilityClass;
  effect: Effect;
  data_zone: DataZone;
  sensitivity: Sensitivity;
  cost: CostKind;
  network: NetworkTarget;
  idempotency: IdempotencyRequirement;
  preflight: boolean;
  postcondition: boolean;
  recovery: Recovery;
  output_trust: string;
  /** Flater handlingen kan stå på. TOM = ingen modellflate (kun eier-/system-veier). */
  surfaces: Surface[];
  /** Identitetsfelt (tenant/person/space) som står i inndata-skjemaet - skal aldri være modellstyrt (se scope-binding). */
  scope_fields: string[];
}

export type ToolManifest = ReadonlyMap<string, ToolManifestEntry>;

const k = (tool_id: string, action: string) => `${tool_id}.${action}`;

/** DB-baserte domenenavnerom (Jarvis eier tilstanden, ingen ekstern leverandør). */
const JARVIS_CORE_NAMESPACES = new Set([
  "business", "support", "contract", "agreements", "growth", "consent", "finance", "finance_spend", "product", "operations",
  "governance", "situations", "executive", "owner_controls", "memory", "tasks", "incidents", "conversation_graph", "self_modification"
]);
const FINANCIAL_NAMESPACES = /^(finance|finance_[a-z]+)$/;

/** Namerom som ALDRI kan stå på en modellflate, uansett handling (eier-kontroll, penger, infra, selvmodifikasjon, samtykke, styring). */
export const OWNER_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  "owner_controls", "self_modification", "docker", "gce", "mcp_zapier", "browser", "incidents", "governance", "situations", "consent",
  "finance", "finance_spend", "finance_stripe", "finance_vipps", "finance_neonomics", "finance_wallester", "data-erasure", "scheduler"
]);

const PAID_MEDIA = new Set(["openai_images", "runway", "kling", "google_veo", "higgsfield"]);
const SMS_LIKE = new Set(["twilio", "telnyx", "whatsapp"]);
const METERED = new Set(["brave_search", "tavily", "exa", "google_maps", "google_places", "google_routes"]);
const OWNER_CONFIGURED_URL = new Set(["jira", "pipedrive", "grafana", "prometheus", "n8n", "make", "finance_wallester", "home-assistant"]);
const PRIVATE_NAMESPACES = new Set(["email", "calendar", "drive", "gmail", "microsoft_outlook", "memory", "dropbox", "onedrive", "notion", "slack", "discord", "telegram", "whatsapp", "twilio", "telnyx", "google_sheets", "spotify", "home-assistant"]);

const READ_VERB = /^(read|get|list|search|query|find|fetch|lookup|describe|inspect|check|status|test|health|count|summar|show|view|browse|explain|rank|evaluate|resolve|upcoming|due|overdue|cancellable|campaign_performance|geocode|reverse_geocode|web_search|news_search|extract|screenshot|navigate)/;
const SEND_VERB = /(^|_)(send|notify|reply|forward|publish|broadcast|invite|call_tool|run_scenario|activate_workflow|dispatch_workflow|comment_on_issue|rerun_workflow_run|cancel_workflow_run)(_|$)/;
const PAY_VERB = /^(submit_|refund|capture|charge|transfer|pay)/;
const DELETE_VERB = /(^|_)(delete|remove|purge|trash|destroy|drop|erase)(_|$)/;
const CONTROL_VERB = /(^|_)(kill_switch|freeze|unfreeze|revoke|restore|set_connector_credential|pause|resume|stop|start|reset|redeploy|restart|lock_set|alarm_set|merge)(_|$)/;

/** Eksplisitte overstyringer der navneinferens er feil/tvetydig. Nøkkel = `tool_id.action`. */
const EFFECT_OVERRIDES: Record<string, Effect> = {
  [k("memory", "propose")]: "write",
  [k("memory", "search")]: "read",
  [k("memory", "list_proposals")]: "read",
  // D-388: nedlasting er lesing av innhold (ingen ekstern effekt).
  [k("dropbox", "download_file")]: "read",
  [k("tasks", "create_task")]: "write",
  [k("github", "create_branch")]: "write",
  [k("github", "merge_pr")]: "control",
  [k("github", "dispatch_workflow")]: "send",
  [k("telegram", "notify")]: "send",
  // Eier-intern bokføring/tilstand (ikke ekstern effekt): to-fase «request_*»-intensjoner, samtykke-policy, karantene-godkjenning.
  [k("memory", "approve_proposal")]: "write",
  [k("memory", "reject_proposal")]: "write",
  [k("consent", "record_decision")]: "write",
  [k("consent", "set_enforcement_policy")]: "write",
  [k("finance", "revoke_vendor_provider_binding")]: "write",
  [k("finance_spend", "pause_recurring_commitment")]: "write",
  [k("finance_spend", "resume_recurring_commitment")]: "write",
  [k("finance_stripe", "request_refund")]: "write",
  [k("finance_vipps", "request_capture")]: "write",
  [k("finance_vipps", "request_refund")]: "write",
  [k("finance_neonomics", "refresh_payment_state")]: "write",
  // Klasse A: leser leverandørens tilstand (ingen ekstern effekt) - se definisjonene.
  [k("finance_stripe", "refresh_payment_state")]: "read",
  [k("finance_vipps", "refresh_payment_state")]: "read",
  [k("finance_wallester", "freeze_card")]: "control",
  [k("executive", "get_capability_status")]: "read"
};

export function inferEffect(tool_id: string, action: string): Effect {
  const override = EFFECT_OVERRIDES[k(tool_id, action)];
  if (override) return override;
  if (READ_VERB.test(action)) return "read";
  if (PAID_MEDIA.has(tool_id) && /generate/.test(action)) return "pay";
  if (DELETE_VERB.test(action)) return "delete";
  if (PAY_VERB.test(action)) return "pay";
  if (SEND_VERB.test(action) || (SMS_LIKE.has(tool_id) && /notify|send/.test(action))) return "send";
  if (CONTROL_VERB.test(action)) return "control";
  return "write";
}

function inferDataZone(tool_id: string): DataZone {
  if (FINANCIAL_NAMESPACES.test(tool_id)) return "financial";
  if (JARVIS_CORE_NAMESPACES.has(tool_id)) return "internal";
  return "vendor_cloud";
}

function inferSensitivity(tool_id: string): Sensitivity {
  if (FINANCIAL_NAMESPACES.test(tool_id)) return "restricted";
  if (PRIVATE_NAMESPACES.has(tool_id)) return "private";
  if (["business", "support", "contract", "agreements", "growth", "product", "operations", "github", "jira", "linear", "trello", "todoist", "hubspot", "pipedrive"].includes(tool_id)) return "business";
  return "public";
}

function inferCost(tool_id: string, effect: Effect): CostKind {
  if (PAID_MEDIA.has(tool_id) || (SMS_LIKE.has(tool_id) && effect === "send")) return "paid";
  if (METERED.has(tool_id)) return "metered";
  return "free";
}

function inferNetwork(tool_id: string, def: ToolDefinition): NetworkTarget {
  if (JARVIS_CORE_NAMESPACES.has(tool_id) || FINANCIAL_NAMESPACES.test(tool_id)) return OWNER_CONFIGURED_URL.has(tool_id) ? "owner_configured_url" : "none";
  if (OWNER_CONFIGURED_URL.has(tool_id)) return "owner_configured_url";
  return def.credential_ref === "" ? "none" : "vendor";
}

const SCOPE_FIELD_NAMES = ["tenant_id", "memory_space", "actor_person_id", "owner_person_id", "person_id", "space"];

/** De zod-feltene i inndata-skjemaet som er identitet/scope. Leser `.shape` strukturelt (record() = strict object); ukjent form = tom liste. */
export function scopeFieldsOf(def: ToolDefinition): string[] {
  const shape = (def.input_schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== "object") return [];
  return SCOPE_FIELD_NAMES.filter((name) => name in shape);
}

/** D-381/D-382: nivå-handlinger kan ha identitetsfelt i det registrerte skjemaet fordi trusted lag binder dem (fjernet fra modellens skjema). */
const TIER_KEYS: ReadonlySet<string> = new Set([...CHAT_READ_TIER_KEYS, ...CHAT_ACT_TIER_KEYS]);
/** D-382: tale er ubetrodd inndata (STT) - lese-nivået uten finans; aldri handlingsnivået. */
const VOICE_READ_TIER = CHAT_READ_TIER.filter((g) => !/^finance/.test(g.tool_id));

/** Flatene en handling kan stå på. ALT annet er forbudt. Utvidelse er en sikkerhetsendring (ny beslutning + test). */
export const SURFACE_TOOL_GRANTS: Readonly<Record<Surface, ReadonlyArray<{ tool_id: string; action: string }>>> = {
  web_chat: [
    { tool_id: "email", action: "read_inbox" },
    { tool_id: "calendar", action: "read_events" },
    { tool_id: "github", action: "read_issues" },
    { tool_id: "executive", action: "get_capability_status" },
    { tool_id: "memory", action: "search" },
    { tool_id: "memory", action: "propose" },
    // D-381: chattens lese-nivå (kun ren lesing; modellen ser et lite utvalg per melding, ikke hele listen).
    ...CHAT_READ_TIER,
    // D-382: handlingsnivået - utføres KUN etter eierens bundne bekreftelse (executoren håndhever det, ikke modellen).
    ...CHAT_ACT_TIER
  ],
  // Tale: transkripsjonen er upålitelig (STT-feil, omgivelser) - kun lesing (D-382: lese-nivået uten finans), ingen minneforslag.
  voice: [
    { tool_id: "email", action: "read_inbox" },
    { tool_id: "calendar", action: "read_events" },
    { tool_id: "github", action: "read_issues" },
    { tool_id: "executive", action: "get_capability_status" },
    { tool_id: "memory", action: "search" },
    ...VOICE_READ_TIER
  ],
  // Telegram er READ-ONLY inntil signert godkjenning finnes (chat-id er ikke nok autoritet for skriving).
  telegram: [
    { tool_id: "email", action: "read_inbox" },
    { tool_id: "calendar", action: "read_events" },
    { tool_id: "github", action: "read_issues" },
    { tool_id: "executive", action: "get_capability_status" },
    { tool_id: "memory", action: "search" }
  ],
  // Bakgrunnsjobber har ingen bruker i løkka: kun lesing.
  background: [
    { tool_id: "email", action: "read_inbox" },
    { tool_id: "calendar", action: "read_events" },
    { tool_id: "github", action: "read_issues" },
    { tool_id: "executive", action: "get_capability_status" },
    { tool_id: "memory", action: "search" }
  ],
  // Kodeagenten har ingen gateway-verktøy (kjører i jobb-container med egen policy).
  coding: []
};

/** Boot-/test-port: modellflater kan kun inneholde dette (alt ellers er en ModelSurface-brudd). */
export const QUARANTINE_WRITE_KEYS: ReadonlySet<string> = new Set([k("memory", "propose")]);

export class ToolManifestViolationError extends Error {
  constructor(readonly violations: string[]) {
    super(`tool-manifest brutt: ${violations.join("; ")}`);
    this.name = "ToolManifestViolationError";
  }
}

export function buildToolManifest(defs: ReadonlyArray<ToolDefinition>): ToolManifest {
  const grants = new Map<string, Surface[]>();
  for (const surface of SURFACES) {
    for (const g of SURFACE_TOOL_GRANTS[surface]) {
      const key = k(g.tool_id, g.action);
      grants.set(key, [...(grants.get(key) ?? []), surface]);
    }
  }
  const manifest = new Map<string, ToolManifestEntry>();
  for (const def of defs) {
    const key = k(def.tool_id, def.action);
    if (manifest.has(key)) throw new ToolManifestViolationError([`${key}: duplisert registrering`]);
    const effect = inferEffect(def.tool_id, def.action);
    const risk = def.capability_class;
    manifest.set(key, {
      key,
      tool_id: def.tool_id,
      action: def.action,
      owner: JARVIS_CORE_NAMESPACES.has(def.tool_id) ? "jarvis_core" : "owner_connector",
      risk,
      effect,
      data_zone: inferDataZone(def.tool_id),
      sensitivity: inferSensitivity(def.tool_id),
      cost: inferCost(def.tool_id, effect),
      network: inferNetwork(def.tool_id, def),
      idempotency: risk === "D" || effect === "pay" || effect === "send" ? "required" : effect === "read" ? "none" : "recommended",
      preflight: def.preflight_action !== undefined,
      postcondition: def.postcondition_predicate !== undefined,
      recovery: def.reversible && def.rollback_procedure.trim().length > 0 ? "documented" : "none",
      output_trust: def.output_trust,
      surfaces: grants.get(key) ?? [],
      scope_fields: scopeFieldsOf(def)
    });
  }
  return manifest;
}

/** Laveste risikoklasse en effekt kan ha. send/pay/delete/control er aldri «uskyldig» klasse B/A (JARVIS-015). */
export const MIN_RISK_BY_EFFECT: Readonly<Record<Effect, CapabilityClass>> = {
  read: "A",
  write: "B",
  send: "C",
  pay: "C",
  delete: "C",
  control: "C"
};

const RISK_ORDER: Record<CapabilityClass, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Eksplisitte, BEGRUNNEDE unntak fra effekt→minimumsklasse. Hver oppføring er en bevisst avgjørelse, aldri en tilfeldighet. */
export const MIN_RISK_EXCEPTIONS: Readonly<Record<string, string>> = {
  [k("telegram", "notify")]: "eierens EGEN kanal (varsler/daglig brief til eieren selv), ikke en mottaker utenfor eieren; fortsatt «utgående» for taint-porten",
  [k("memory", "propose")]: "skriver kun til karantene i Jarvis' eget minne (D-367)",
  [k("finance_wallester", "freeze_card")]: "beskyttende handling (fryser et kort) som REDUSERER risiko; krever fortsatt eier-flate og taint-bekreftelse"
};

export function assertManifestInvariants(manifest: ToolManifest, options: { ignoreUnregisteredGrants?: boolean } = {}): void {
  const violations: string[] = [];
  for (const entry of manifest.values()) {
    if (RISK_ORDER[entry.risk] < RISK_ORDER[MIN_RISK_BY_EFFECT[entry.effect]] && MIN_RISK_EXCEPTIONS[entry.key] === undefined) {
      violations.push(`${entry.key}: effekt «${entry.effect}» krever minst klasse ${MIN_RISK_BY_EFFECT[entry.effect]} (er ${entry.risk})`);
    }
    if (entry.risk === "D" && entry.idempotency !== "required") violations.push(`${entry.key}: klasse D må kreve idempotens`);
    if (entry.surfaces.length > 0) {
      const onlyWebChat = entry.surfaces.every((s) => s === "web_chat");
      // D-381: eierens egen chat (web_chat, grant-autentisert) kan LESE finans-navnerommene via lese-nivået; tale/Telegram/bakgrunn aldri.
      const ownerReadOnWebChat = CHAT_READ_TIER_KEYS.has(entry.key) && entry.effect === "read" && onlyWebChat;
      // D-382: handlingsnivået (kun web_chat, kun B/C, kun write/send/delete, alltid bundet eier-bekreftelse FØR utførelse).
      const act = CHAT_ACT_TIER_KEYS.has(entry.key);
      if (act && !onlyWebChat) violations.push(`${entry.key}: handlingsnivået kan kun stå på web_chat`);
      if (act && entry.risk !== "B" && entry.risk !== "C") violations.push(`${entry.key}: handlingsnivået er kun klasse B/C (er ${entry.risk})`);
      if (act && entry.effect !== "write" && entry.effect !== "send" && entry.effect !== "delete") violations.push(`${entry.key}: handlingsnivået tillater kun write/send/delete (er ${entry.effect})`);
      if (OWNER_ONLY_NAMESPACES.has(entry.tool_id) && !ownerReadOnWebChat && !(act && onlyWebChat)) violations.push(`${entry.key}: eier-eksklusivt navnerom kan ikke stå på en modellflate`);
      const quarantineWrite = QUARANTINE_WRITE_KEYS.has(entry.key);
      if (entry.risk !== "A" && !quarantineWrite && !act) violations.push(`${entry.key}: kun klasse A (eller karantene-skriving/handlingsnivå) kan stå på en modellflate (er ${entry.risk})`);
      if (entry.effect !== "read" && !quarantineWrite && !act) violations.push(`${entry.key}: effekt «${entry.effect}» kan ikke stå på en modellflate`);
      if (entry.effect === "pay" || entry.effect === "control") {
        violations.push(`${entry.key}: pay/control kan aldri stå på en modellflate`);
      }
      if (entry.risk === "D") violations.push(`${entry.key}: klasse D kan aldri stå på en modellflate`);
      if (entry.cost === "paid") violations.push(`${entry.key}: betalte handlinger kan ikke stå på en modellflate`);
      if (entry.scope_fields.length > 0 && !TIER_KEYS.has(entry.key)) violations.push(`${entry.key}: skjemaet har identitetsfelt (${entry.scope_fields.join(",")}) på en modellflate`);
      if (entry.surfaces.includes("telegram") && entry.effect !== "read") violations.push(`${entry.key}: Telegram er read-only`);
      if (entry.surfaces.includes("voice") && entry.effect !== "read") violations.push(`${entry.key}: tale er read-only`);
      if (entry.surfaces.includes("background") && entry.effect !== "read") violations.push(`${entry.key}: bakgrunnsjobber er read-only`);
    }
  }
  if (!options.ignoreUnregisteredGrants) {
    for (const surface of SURFACES) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) {
        if (!manifest.has(k(g.tool_id, g.action))) violations.push(`${k(g.tool_id, g.action)}: tildelt flate «${surface}» men ikke registrert`);
      }
    }
  }
  if (violations.length > 0) throw new ToolManifestViolationError(violations);
}

/** Skal handlingen kreve en NY, eksplisitt bekreftelse når turen er tainted? (C/D, eller en utgående/betalt/ekstern skriving.) */
export function requiresConfirmationWhenTainted(entry: ToolManifestEntry): boolean {
  if (entry.risk === "C" || entry.risk === "D") return true;
  if (entry.effect === "read") return false;
  if (entry.effect === "send" || entry.effect === "pay" || entry.effect === "delete" || entry.effect === "control") return true;
  // write: kun interne (Jarvis-eide, karantene-)skrivinger slipper bekreftelse; ekstern skriving (CRM, Sheets, issues ...) krever den.
  return entry.data_zone !== "internal";
}

export function surfaceForChannel(channel: string): Surface {
  if (channel === "voice") return "voice";
  if (channel === "telegram") return "telegram";
  if (channel === "system") return "background";
  return "web_chat";
}

export interface SurfaceLimits {
  /** Maks antall verktøyskjema sendt til modellen per runde. */
  max_tools_per_round: number;
  /** Maks (estimert) skjema-tokens per runde. */
  max_schema_tokens: number;
  /** Maks antall verktøyrunder per tur. */
  max_rounds: number;
  /** Maks antall verktøykall per runde. */
  max_calls_per_round: number;
  /** Maks totalt antall verktøykall per tur. */
  max_total_calls: number;
}

export const SURFACE_LIMITS: Readonly<Record<Surface, SurfaceLimits>> = {
  // D-382: skjemaene for handlinger (opprett/oppdater) er større enn lese-skjemaene - rommet er hevet, utvalget er fortsatt per melding.
  web_chat: { max_tools_per_round: 10, max_schema_tokens: 3000, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 8 },
  voice: { max_tools_per_round: 6, max_schema_tokens: 1500, max_rounds: 3, max_calls_per_round: 3, max_total_calls: 5 },
  telegram: { max_tools_per_round: 5, max_schema_tokens: 1000, max_rounds: 3, max_calls_per_round: 3, max_total_calls: 5 },
  background: { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 6, max_calls_per_round: 4, max_total_calls: 16 },
  coding: { max_tools_per_round: 0, max_schema_tokens: 0, max_rounds: 0, max_calls_per_round: 0, max_total_calls: 0 }
};

/** Grov, stabil tokenestimator (≈4 tegn/token) for JSON-skjema - brukt til budsjett og regresjonsterskel, ikke fakturering. */
export function estimateSchemaTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
