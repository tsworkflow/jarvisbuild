import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { DataSensitivity, ModelPurpose, RouterMode } from "@jarvis/contracts";
import { createHash } from "node:crypto";
import {
  ProviderError,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExchange,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import { BudgetGuard, type BudgetConfig, DEFAULT_BUDGET } from "./budget-guard.ts";
import { classifyCompletionOutcome, computeAdaptiveRetryMaxTokens, type CompletionOutcome } from "./completion-outcome.ts";
import { CapabilityRegistry, type ModelCapability } from "./capability-registry.ts";
import { ProviderHealthTracker, type ProviderHealthState } from "./provider-health.ts";
import { AiRouter, type RoutePlan } from "./router.ts";
import { assertExplicitPricing, costOre as computeCostOre, DEFAULT_PRICING, type PricingTable } from "./pricing.ts";
import type { TraceSink } from "./trace.ts";

/**
 * D-106 Council reliability (§ARCHITECTURE DECISION, evidensbasert 2026-08-24):
 * ordinær `ModelGateway.complete()`/`.stream()`-default - UENDRET fra
 * adapternes egen historiske `JARVIS_MODEL_TIMEOUT_MS ?? 60000`-konvensjon.
 * Eksportert kun som dokumentasjon/referanse for kallere og tester - selve
 * default-oppførselen skjer FORTSATT i den enkelte adapterens konstruktør
 * (uendret), ikke her.
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/**
 * D-106 Council reliability (§DESIGN REQUIREMENTS pkt. 4-5): hard øvre grense
 * for ETHVERT eksplisitt `CompleteInput.timeoutMs`-overstyring - ingen kaller
 * kan be om ubegrenset kjøretid, uansett arbeidsmengde. Council sin egen
 * `COUNCIL_MODEL_TIMEOUT_MS=120000` (`council.ts`) ligger godt under denne.
 */
export const MAX_MODEL_TIMEOUT_MS = 180_000;

/** Ugyldig eksplisitt `CompleteInput.timeoutMs` (ikke-endelig/≤0/over `MAX_MODEL_TIMEOUT_MS`) - feiler høylytt, aldri en stille klemming/gjetning. */
export class InvalidTimeoutError extends Error {
  constructor(readonly requestedMs: number) {
    super(
      `Ugyldig timeoutMs=${requestedMs}: må være et endelig tall > 0 og <= ${MAX_MODEL_TIMEOUT_MS}ms (${MAX_MODEL_TIMEOUT_MS / 1000}s hard grense).`
    );
    this.name = "InvalidTimeoutError";
  }
}

/**
 * D-106 Council reliability: validerer en eksplisitt per-kall
 * timeout-overstyring. `undefined` (ingen overstyring bedt om) gis tilbake
 * UENDRET - ordinære kall uten eksplisitt `timeoutMs` oppfører seg
 * byte-for-byte som før dette feltet fantes (adapterens egen
 * konstruksjonstidsdefault brukes). Provider-identitet inngår ALDRI i denne
 * vurderingen (§DESIGN REQUIREMENTS: ingen `if provider === "kimi"`-logikk
 * noe sted i denne arbeidsmengde-kapabiliteten).
 */
function resolveTimeoutMs(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_MODEL_TIMEOUT_MS) {
    throw new InvalidTimeoutError(requested);
  }
  return requested;
}

/** Tydelig, maskinlesbar feil når budsjettet stopper kall (akseptanse 5). */
export class BudgetExceededError extends Error {
  constructor(
    readonly level: "needs_approval" | "hard_blocked",
    readonly spent_ore: number
  ) {
    super(
      level === "hard_blocked"
        ? `Månedsbudsjettet (hardgrense) er brukt opp (${(spent_ore / 100).toFixed(0)} kr). Nye modellkall nektes til grensen heves med signert overstyring.`
        : `Månedsforbruket (${(spent_ore / 100).toFixed(0)} kr) krever aktiv godkjenning før flere modellkall.`
    );
    this.name = "BudgetExceededError";
  }
}

export interface CompleteInput {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  request: ModelRequest;
  onToken?: (token: string) => void;
  /** UA-1: purpose-taksonomi for routing/kost/metrikk. */
  purpose?: ModelPurpose;
  /** UA-1: eksplisitt routing-mode; default AUTO. */
  mode?: RouterMode;
  /** UA-1 owner-override (§10): eksakt provider - ingen stille fallback. */
  provider?: string;
  required_capabilities?: ModelCapability[];
  /** UA-1 critic (§18): eksplisitt opt-in; aldri default. */
  critic?: boolean;
  /** D-106: se `RouteInput.sensitivity`/`isSensitivityEligible` for semantikk - videreført uendret hit. */
  sensitivity?: DataSensitivity;
  /** D-106: se `RouteInput.paid_models_allowed`. */
  paid_models_allowed?: boolean;
  /** D-106: se `RouteInput.providerPreference`. */
  providerPreference?: string[];
  /**
   * D-106 Council reliability (§ARCHITECTURE DECISION): eksplisitt, generisk
   * arbeidsmengde-spesifikk timeout-overstyring for DETTE kallet (millisekunder).
   * Validert mot `MAX_MODEL_TIMEOUT_MS` (kaster `InvalidTimeoutError` ved
   * ugyldig verdi - ALDRI en stille klemming). Udefinert (normaltilfellet) =
   * UENDRET ordinær oppførsel (adapterens egen konstruksjonstidsdefault,
   * `JARVIS_MODEL_TIMEOUT_MS`/60000). `AiCouncil` bruker dette for sin egen
   * `COUNCIL_MODEL_TIMEOUT_MS` - ALDRI provider-spesifikk, kun arbeidsmengde-
   * spesifikk (§DESIGN REQUIREMENTS: ingen `if provider === "kimi"` noe sted).
   */
  timeoutMs?: number;
}

export interface GatewayOptions {
  pool: pg.Pool;
  /** Registrerte adaptere; router velger blant de som er konfigurert. */
  providers: ModelProviderAdapter[];
  trace: TraceSink;
  budget?: BudgetConfig;
  registry?: CapabilityRegistry;
  pricing?: PricingTable;
  /** Bakoverkompatibel enkel rate-tabell (øre/1k) - overstyrer pricing hvis satt. */
  rates?: Record<string, { input_per_1k_ore: number; output_per_1k_ore: number }>;
  /** Enkel rate limit: maks kall per minutt per tenant. */
  maxCallsPerMinute?: number;
}

/**
 * UA-1 P1A: trusted executor-grensesnitt. Gateway/modell har ALDRI direkte
 * verktøytilgang - all utførelse går via denne broen til Tool Gateway,
 * som håndhever Policy/Execution Authority/D-pipeline som før (§17).
 */
export interface ToolExecutor {
  execute(
    call: ToolCallRequest,
    ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
  ): Promise<ToolResultMessage>;
}

export interface ToolLoopOptions {
  tools: ToolDefinition[];
  executor: ToolExecutor;
  /** Streaming-events for hver runde (valgfritt). */
  onEvent?: StreamHandler;
  signal?: AbortSignal;
  /** Maks modellrunder (default 4) - aldri uendelig tool-loop. */
  maxRounds?: number;
  /** Del 3 (JARVIS-028): maks verktøykall utført per runde. Overskytende kall forkastes (ikke utført) - aldri en ubegrenset fan-out. */
  maxCallsPerRound?: number;
}

/** Minimal, deterministisk JSON-Schema-validering (§25): required + ukjente felter. */
export function validateToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = (schema["required"] as string[] | undefined) ?? [];
  for (const field of required) {
    if (!(field in args)) {
      return `missing_required:${field}`;
    }
  }
  if (schema["additionalProperties"] === false) {
    const allowed = new Set(Object.keys((schema["properties"] as Record<string, unknown> | undefined) ?? {}));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        return `unknown_field:${key}`;
      }
    }
  }
  return null;
}

export interface MeshProviderStatus {
  provider: string;
  model: string;
  state: ProviderHealthState;
  success: number;
  failures: number;
  avg_latency_ms?: number;
}

export interface MeshStatus {
  providers: MeshProviderStatus[];
  router: "HEALTHY";
  /** VERIFIED = cross-provider fallback har faktisk skjedd i denne runtime (§25). */
  fallback: "VERIFIED" | "READY" | "LOGIC_ONLY";
  critic: "VERIFIED" | "READY_SELECTIVE";
}

const CRITIC_SYSTEM =
  "Du er en kritisk kvalitetssjekker. Vurder svaret mot oppgaven: pek på faktiske feil, hull eller risiko. Svar kompakt: CONFIDENCE: <0-100> etterfulgt av punktliste med funn (eller 'ingen funn').";

/**
 * Model Gateway (CANONICAL_SPEC §7 + UA-1 AI Mesh): eneste vei til modell-
 * leverandører. Budsjett håndheves FØR kallet; router velger provider
 * deterministisk (registry+health); fallback er klassifisert, aldri blind;
 * kostnad/latency/purpose skrives til cost_events; alt spores i trace-sinken.
 */
export class ModelGateway {
  private readonly guard: BudgetGuard;
  private readonly callTimestamps = new Map<string, number[]>();
  private readonly registry: CapabilityRegistry;
  private readonly pricing: PricingTable;
  readonly health = new ProviderHealthTracker();
  private readonly router: AiRouter;
  private readonly byName = new Map<string, ModelProviderAdapter>();
  /** Runtime-evidens for /status (§25): satt først når hendelsen faktisk har skjedd. */
  private crossProviderFallbackSeen = false;
  private criticRunSeen = false;

  constructor(private readonly opts: GatewayOptions) {
    this.guard = new BudgetGuard(opts.pool, opts.budget ?? DEFAULT_BUDGET);
    this.registry = opts.registry ?? new CapabilityRegistry();
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    // JARVIS-006: ingen registrert modellprofil får falle til `default_rate`.
    assertExplicitPricing(this.pricing, this.registry.list());
    this.router = new AiRouter(this.registry, this.health);
    for (const p of opts.providers) {
      this.byName.set(p.name, p);
    }
  }

  /** D-106: eksponerer registryet (read-only) for AI Council/Collaboration sin deterministiske rolletildeling (§35 - Jarvis-kode, ikke modell, velger). */
  get capabilityRegistry(): CapabilityRegistry {
    return this.registry;
  }

  /** Remediering del 1: ALLE konstruerte adapternavn (uansett `available()`), brukt av oppstartens eksplisitt-pris-sjekk. */
  listProviderNames(): string[] {
    return this.opts.providers.map((p) => p.name);
  }

  /** D-106: providernavn med `available()===true` akkurat nå - AI Council/Collaboration bruker denne til å avgjøre kandidater/`unavailable_members` FØR kall gjøres. */
  listConfiguredProviders(): string[] {
    return this.opts.providers.filter((p) => p.available()).map((p) => p.name);
  }

  private providerRuntimes(): Map<string, { configured: boolean; model: string }> {
    const map = new Map<string, { configured: boolean; model: string }>();
    for (const p of this.opts.providers) {
      map.set(p.name, { configured: p.available(), model: p.model ?? "ukjent" });
    }
    return map;
  }

  /**
   * D-106 Council reliability: SENTRALISERT, validert anvendelse av ETT
   * eksplisitt `CompleteInput.timeoutMs`-overstyring - eneste sted dette
   * feltet kan nå en adapter (`ModelRequest.timeoutMs` fylles KUN inn her,
   * aldri satt direkte av en kaller). `undefined` (normaltilfellet) gir
   * `input` tilbake UENDRET - ingen ny objektallokering, ingen atferdsendring
   * for ordinære kall.
   */
  private applyTimeoutOverride(input: CompleteInput): CompleteInput {
    const resolved = resolveTimeoutMs(input.timeoutMs);
    if (resolved === undefined) return input;
    return { ...input, request: { ...input.request, timeoutMs: resolved } };
  }

  async complete(rawInput: CompleteInput): Promise<ModelResult> {
    const input = this.applyTimeoutOverride(rawInput);
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;

    this.enforceRateLimit(input.tenant_id);

    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      await this.opts.trace.record({
        trace_id: traceId,
        kind: "budget",
        name: `budget_${budget.level}`,
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        metadata: { spent_ore: budget.spent_ore }
      });
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }

    const plan = this.router.plan(
      {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.required_capabilities !== undefined
          ? { required_capabilities: input.required_capabilities }
          : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined
          ? { paid_models_allowed: input.paid_models_allowed }
          : {}),
        ...(input.providerPreference !== undefined
          ? { providerPreference: input.providerPreference }
          : {}),
        needs_structured: Boolean(input.request.structured_schema)
      },
      this.providerRuntimes()
    );

    const result = await this.executePlan(input, plan, traceId, started, budget.level, false);

    if (input.critic || plan.mode === "CRITIC") {
      await this.runCritic(input, result, traceId);
    }
    return result;
  }

  /**
   * Deterministisk fallback (§12): klassifiserte feil, aldri blind retry-spam.
   * Streaming (§10-§11): fallback KUN før første output; etter output-start er
   * policyen konservativ - stream markeres interrupted, aldri skjult provider-bytte.
   */
  private async executePlan(
    input: CompleteInput,
    plan: RoutePlan,
    traceId: string,
    started: number,
    budgetLevel: string,
    isCritic: boolean,
    requestOverride?: ModelRequest,
    streamOpts?: { onEvent: StreamHandler; signal?: AbortSignal }
  ): Promise<ModelResult> {
    const request = requestOverride ?? input.request;
    const failedProviders: string[] = [];
    let lastError: Error | null = null;

    for (const candidate of plan.candidates) {
      const adapter = this.byName.get(candidate.provider);
      if (!adapter || !adapter.available()) {
        continue;
      }
      if (failedProviders.length > 0 && streamOpts) {
        streamOpts.onEvent({
          type: "fallback",
          from: failedProviders[failedProviders.length - 1] as string,
          to: adapter.name,
          reason: (lastError as ProviderError | null)?.kind ?? "unknown"
        });
      }
      const maxTries = 2; // 1 + maks én retry for transient/invalid_response på samme provider
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        const attemptStart = Date.now();
        let outputStarted = false;
        try {
          let result: ModelResult;
          if (streamOpts) {
            // D-30 HOST BLOCKER §1/§2: valgfri, kostnadsfri diagnostikk for å avgjøre
            // OM/NÅR provider-adapteren faktisk emitterer text_delta live (spørsmål A/B
            // i host-ordren). Kun type/provider/timing - ALDRI event-innhold (aldri
            // secrets/prompt/svar-tekst) - og kun aktiv når eksplisitt slått på.
            const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
            const guardedOnEvent: StreamHandler = (event) => {
              if (event.type === "text_delta" || event.type === "tool_call_start") {
                outputStarted = true;
              }
              if (streamDebug) {
                console.error(JSON.stringify({
                  msg: "stream_debug_gateway", provider: adapter.name, event_type: event.type,
                  at_ms: Date.now() - attemptStart
                }));
              }
              streamOpts.onEvent(event);
            };
            if (adapter.stream) {
              result = await adapter.stream(request, guardedOnEvent, streamOpts.signal);
            } else {
              // Adapter uten native streaming: normalisert enkelt-delta (capability-routing
              // skal normalt hindre dette; brukes kun når streaming ikke er påkrevd cap).
              result = await adapter.complete(request, (token) => guardedOnEvent({ type: "text_delta", text: token }));
              streamOpts.onEvent({ type: "usage", usage: result.usage });
              streamOpts.onEvent({ type: "finish", finish_reason: result.finish_reason ?? "stop" });
            }
          } else {
            result = await adapter.complete(request, isCritic ? undefined : input.onToken);
          }
          const latency = result.latency_ms ?? Date.now() - attemptStart;
          // D-106 PR #53: transport lyktes (ingen kastet feil) - health reflekterer
          // NÅBARHET, ikke innholdskvalitet (§3/§7 - dette gjelder uansett utfall under).
          this.health.recordSuccess(adapter.name, latency);
          if (failedProviders.some((p) => p !== adapter.name)) {
            this.crossProviderFallbackSeen = true;
          }
          result.metadata = {
            ...result.metadata,
            router: {
              mode: plan.mode,
              reason: plan.reason,
              ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {})
            }
          };
          const outcome = classifyCompletionOutcome(result);
          await this.recordAttemptResult(input, result, outcome, {
            traceId,
            started,
            budgetLevel,
            isCritic,
            adapterName: adapter.name,
            latency,
            ...(streamOpts !== undefined ? { streamOpts } : {}),
            failedProviders,
            plan
          });

          if (outcome === "USABLE_SUCCESS") {
            return result;
          }

          if (streamOpts) {
            // §7/§17 (regresjonsvern): streaming-kontrakten er BEVISST uendret av
            // denne fiksen - `finish`/`usage`-eventene er allerede levert til
            // stream-forbrukeren (enten av adapter.stream() selv, eller av
            // normaliserings-grenen over) FØR vi når hit, så et nytt forsøk her
            // ville produsert en forvirrende dobbel start/finish-sekvens for noe
            // konsumenten allerede oppfatter som ferdig. `.stream()` returnerer derfor
            // FORTSATT samme resultat som før - kun trace-metadata (over) er ny og
            // ærlig klassifisert; ingen ny retry, ingen ny kastet feil på denne stien.
            return result;
          }

          // D-106 PR #53 functional-success-invariant (§4): ETT begrenset,
          // evidensbasert retry-forsøk (kun ikke-streaming når vi når hit - se
          // returnen over). KUN når finish_reason indikerer budsjett-uttømming
          // (TRUNCATED) - en ordinær tom EMPTY_OUTPUT (finish_reason=stop) er IKKE
          // et retry-kandidat (§4).
          if (outcome === "TRUNCATED_NO_USABLE_OUTPUT") {
            const budgetPermits = await this.adaptiveRetryPermittedByBudget(input.tenant_id);
            if (budgetPermits) {
              const retryStart = Date.now();
              try {
                const retryRequest: ModelRequest = {
                  ...request,
                  max_tokens: computeAdaptiveRetryMaxTokens(result, request)
                };
                const retryResult = await adapter.complete(retryRequest, isCritic ? undefined : input.onToken);
                const retryLatency = retryResult.latency_ms ?? Date.now() - retryStart;
                this.health.recordSuccess(adapter.name, retryLatency);
                retryResult.metadata = {
                  ...retryResult.metadata,
                  router: {
                    mode: plan.mode,
                    reason: plan.reason,
                    ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {})
                  },
                  adaptive_retry: {
                    triggered: true,
                    first_attempt_outcome: outcome,
                    ...(result.finish_reason !== undefined ? { first_attempt_finish_reason: result.finish_reason } : {}),
                    first_attempt_output_tokens: result.usage.output_tokens,
                    retry_max_tokens: retryRequest.max_tokens
                  }
                };
                const retryOutcome = classifyCompletionOutcome(retryResult);
                await this.recordAttemptResult(input, retryResult, retryOutcome, {
                  traceId,
                  started,
                  budgetLevel,
                  isCritic,
                  adapterName: adapter.name,
                  latency: retryLatency,
                  failedProviders,
                  plan,
                  adaptiveRetryOfOutcome: outcome
                });
                if (retryOutcome === "USABLE_SUCCESS") {
                  return retryResult;
                }
                // Retry-forsøket var OGSÅ ubrukelig - ærlig feil, aldri stille suksess (§4).
                lastError = new ProviderError(adapter.name, "invalid_response", `${adapter.name}_no_usable_output_after_retry`);
                break;
              } catch (retryErr) {
                // Selve retry-kallet feilet på transportnivå (§5: begge forsøk er ekte,
                // reelle feil skal IKKE skjules) - normal feilhåndtering, ingen ny retry.
                const pe =
                  retryErr instanceof ProviderError
                    ? retryErr
                    : new ProviderError(adapter.name, "server", (retryErr as Error).message);
                if (pe.kind === "cancelled") {
                  // Bruker-cancellation (§35): la den YTRE catch-blokken håndtere dette
                  // ÉN gang uniformt (recordFailedAttempt + rethrow) - ikke dobbeltregistrer her.
                  throw pe;
                }
                lastError = pe;
                this.health.recordFailure(adapter.name, pe.kind, pe.message);
                await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
                break;
              }
            }
          }

          // Ikke brukbart, ingen (eller uttømt) retry: gå videre til neste kandidat
          // UTEN å straffe provider-helsen (§3/§7 - transporten lyktes faktisk).
          lastError = new ProviderError(adapter.name, "invalid_response", `${adapter.name}_no_usable_output`);
          break;
        } catch (err) {
          const pe =
            err instanceof ProviderError
              ? err
              : new ProviderError(adapter.name, "server", (err as Error).message);
          lastError = pe;
          // Bruker-cancellation er ikke provider-feil (§35): ingen health-straff, ingen fallback.
          if (pe.kind === "cancelled") {
            await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
            throw pe;
          }
          this.health.recordFailure(adapter.name, pe.kind, pe.message);
          await this.recordFailedAttempt(input, adapter.name, pe, isCritic);
          // D-106 HOST-FIX Defekt B-oppfølging (host-bevis 2026-09-20): et mislykket
          // forsøk skrev FØR denne linjen KUN `kind` til `cost_events`
          // (`recordFailedAttempt` over) - selve feilmeldingen/diagnostikken
          // (`pe.diagnostic`, allerede vettet trygg - se `ProviderErrorDiagnostic`
          // i types.ts, ALDRI secrets/frie leverandør-meldinger) gikk tapt for
          // godt før noen (menneske ELLER en fremtidig feilsøkingsrunde) kunne se
          // den - `gemma_hosted` falt stille tilbake til `openai` på HVERT kall i
          // produksjon uten at dette var synlig noe sted. Alltid-på (ikke bak
          // `JARVIS_STREAM_DEBUG`, som kun gjelder verbos per-event-strømming) -
          // dette er en faktisk feil, ikke rutinemessig sporing.
          console.error(JSON.stringify({
            msg: "model_attempt_failed", provider: adapter.name, kind: pe.kind,
            status: pe.status, diagnostic: pe.diagnostic
          }));
          // §11: etter output-start byttes ALDRI provider stille i samme stream.
          if (streamOpts && outputStarted) {
            streamOpts.onEvent({ type: "error", category: "stream_interrupted", message: pe.message.slice(0, 120) });
            throw new ProviderError(adapter.name, "stream_interrupted", pe.message);
          }
          // auth/bad_request/not_configured: aldri retry-spam på samme provider (§12).
          if (!(pe.retryableSameProvider && attempt < maxTries)) {
            break;
          }
        }
      }
      failedProviders.push(candidate.provider);
    }
    throw lastError ?? new ProviderError("router", "not_configured", "no_provider_available");
  }

  /**
   * UA-1 P1A: normalisert streaming (§3-§10). Fallback kun før første output;
   * cancel via signal gir ren avslutning uten zombie-generation (§9/§28).
   */
  async stream(rawInput: CompleteInput, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const input = this.applyTimeoutOverride(rawInput);
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;
    this.enforceRateLimit(input.tenant_id);
    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }
    const plan = this.router.plan(
      {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        // D-379: for SECRET_RESTRICTED er kun lokale providere kvalifisert, og de lokale OpenAI-kompatible
        // adapterne har ikke native streaming (ærlig registry, D-80). `executePlan` normaliserer allerede til én
        // text_delta for adaptere uten `.stream()`, så native streaming kreves ikke her - alternativet er at
        // helse/finans-chat feiler lukket uten noen kvalifisert provider.
        required_capabilities: [
          ...(input.required_capabilities ?? []),
          ...(input.sensitivity === "SECRET_RESTRICTED" ? [] : (["streaming"] as const))
        ],
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined
          ? { paid_models_allowed: input.paid_models_allowed }
          : {}),
        ...(input.providerPreference !== undefined
          ? { providerPreference: input.providerPreference }
          : {}),
        needs_structured: Boolean(input.request.structured_schema)
      },
      this.providerRuntimes()
    );
    return this.executePlan(input, plan, traceId, started, budget.level, false, undefined, { onEvent, ...(signal ? { signal } : {}) });
  }

  /**
   * UA-1 P1A tool-løkke (§16, §19-§26): modell ber om verktøy → trusted executor
   * (Tool Gateway/Authority) → normalisert resultat → modellen fortsetter. Runder er
   * provider-nøytrale (tool_exchanges), så fallback etter utført verktøy fortsetter
   * med persistert resultat - aldri dobbel utførelse (§21).
   */
  async completeWithTools(input: CompleteInput, opts: ToolLoopOptions): Promise<ModelResult> {
    const maxRounds = opts.maxRounds ?? 4;
    const known = new Map(opts.tools.map((t) => [t.name, t]));
    const executed = new Map<string, ToolResultMessage>(); // idempotency: samme kall → samme resultat
    const exchanges: ToolExchange[] = [];
    let repairUsed = false;
    let forceFinal = false;
    let result: ModelResult | null = null;

    for (let round = 1; round <= maxRounds; round++) {
      // Siste runde / loop-vern: uten tools MÅ modellen syntetisere tekstsvar av
      // resultatene den alt har - aldri tom respons pga. runde-taket.
      const withTools = !forceFinal && round < maxRounds;
      const request: ModelRequest = {
        ...input.request,
        ...(withTools ? { tools: opts.tools } : {}),
        ...(exchanges.length > 0 ? { tool_exchanges: exchanges } : {})
      };
      const roundInput: CompleteInput = {
        ...input,
        required_capabilities: [...(input.required_capabilities ?? []), "tool_calling"],
        request
      };
      result = opts.onEvent
        ? await this.stream(roundInput, opts.onEvent, opts.signal)
        : await this.complete(roundInput);
      const calls = (result.tool_calls ?? []).slice(0, opts.maxCallsPerRound ?? Number.POSITIVE_INFINITY);
      if (calls.length === 0) {
        break;
      }
      const sizeBefore = executed.size;
      const results: ToolResultMessage[] = [];
      for (const call of calls) {
        // D-390 (JARVIS-079 «barge-in stops streaming not tools»): et avbrudd (tale-barge-in, klient borte) stopper også
        // verktøyløkka - ingen nye verktøykall startes etter at signalet er satt. Et kall som allerede kjører fullføres
        // (side-effekter rulles aldri tilbake, §17), men neste kall/runde avbrytes rent som `cancelled`.
        if (opts.signal?.aborted) {
          throw new ProviderError(result.provider ?? "router", "cancelled", "tool_loop_cancelled");
        }
        results.push(await this.executeToolCall(call, input, known, executed, () => {
          if (repairUsed) {
            return false;
          }
          repairUsed = true;
          return true;
        }, opts.executor));
      }
      exchanges.push({ calls, results });
      // Kun cache-treff i runden = modellen looper på samme kall → tving syntese (§19).
      if (executed.size === sizeBefore && results.every((r) => r.success)) {
        forceFinal = true;
      }
    }
    if (!result) {
      throw new ProviderError("router", "not_configured", "no_provider_available");
    }
    result.metadata = { ...result.metadata, tool_rounds: exchanges.length };
    return result;
  }

  /** Ett verktøykall: ukjent tool → DENY uten utførelse (§26); schema-feil → normalisert feil (§25). */
  private async executeToolCall(
    call: ToolCallRequest,
    input: CompleteInput,
    known: Map<string, ToolDefinition>,
    executed: Map<string, ToolResultMessage>,
    allowRepair: () => boolean,
    executor: ToolExecutor
  ): Promise<ToolResultMessage> {
    const at = new Date().toISOString();
    const def = known.get(call.tool_name);
    if (!def) {
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: "TOOL_NOT_FOUND", at
      };
    }
    const validationError = validateToolArgs(def.input_schema, call.arguments);
    if (validationError) {
      // Modellen får normalisert feil og kan reparere ÉN gang (§25); aldri delvis utførelse.
      allowRepair();
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: `INVALID_ARGUMENTS:${validationError}`, at
      };
    }
    const idempotencyKey = createHash("sha256")
      .update(`${input.tenant_id}:${input.task_id ?? input.session_id ?? "adhoc"}:${call.tool_name}:${JSON.stringify(call.arguments, Object.keys(call.arguments).sort())}`)
      .digest("hex")
      .slice(0, 32);
    const cached = executed.get(idempotencyKey);
    if (cached) {
      // Retry/fallback/reconnect: samme utførelse returneres - aldri dobbel side-effekt (§19).
      return { ...cached, tool_call_id: call.tool_call_id };
    }
    const result = await executor.execute(call, {
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      idempotency_key: idempotencyKey
    });
    executed.set(idempotencyKey, result);
    return result;
  }

  /** Critic (§18-§19): separat modellkjøring, egen kostrad, aldri koblet til D-godkjenning. */
  private async runCritic(input: CompleteInput, primary: ModelResult, traceId: string): Promise<void> {
    try {
      const runtimes = this.providerRuntimes();
      // Foretrekk annen provider enn primær for uavhengig blikk; ellers samme.
      const others = new Map([...runtimes].filter(([name, rt]) => rt.configured && name !== primary.provider));
      const pool = others.size > 0 ? others : runtimes;
      // Del 3 (JARVIS-016): criticen ser det samme innholdet som primærkallet - SAMME sensitivitets-/betalt-modell-regler gjelder.
      const criticPlan = this.router.plan({
        mode: "QUALITY",
        purpose: "CRITIQUE",
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {})
      }, pool);
      const lastUserMessage = [...input.request.messages].reverse().find((m) => m.role === "user");
      const lastUser = lastUserMessage ? textOnly(lastUserMessage.content) : "";
      // §30: critic er review-rolle - får ALDRI tools, kan aldri utføre side-effekter.
      const criticRequest: ModelRequest = {
        system: CRITIC_SYSTEM,
        messages: [
          {
            role: "user",
            content: `OPPGAVE:\n${lastUser.slice(0, 4000)}\n\nSVAR SOM SKAL VURDERES:\n${primary.text.slice(0, 6000)}`
          }
        ],
        max_tokens: 512
      };
      const criticResult = await this.executePlan(
        input,
        criticPlan,
        traceId,
        Date.now(),
        "ok",
        true,
        criticRequest
      );
      this.criticRunSeen = true;
      primary.metadata = {
        ...primary.metadata,
        critic: {
          provider: criticResult.provider,
          model: criticResult.model,
          critique: criticResult.text
        }
      };
    } catch (err) {
      // Critic er kvalitetsforsterkning - feil her skal aldri velte primærsvaret.
      primary.metadata = { ...primary.metadata, critic_error: (err as Error).message.slice(0, 120) };
    }
  }

  /** Kompakt mesh-status for /status og /ai (§37-§38). Ingen secrets. */
  meshStatus(): MeshStatus {
    const runtimes = this.providerRuntimes();
    const snapshot = this.health.snapshot(new Map([...runtimes].map(([k, v]) => [k, v.configured])));
    return {
      providers: [...runtimes].map(([name, rt]) => {
        const s = snapshot[name] as NonNullable<(typeof snapshot)[string]>;
        return {
          provider: name,
          model: rt.model,
          state: s.state,
          success: s.success,
          failures: s.failures,
          ...(s.avg_latency_ms !== undefined ? { avg_latency_ms: s.avg_latency_ms } : {})
        };
      }),
      router: "HEALTHY",
      fallback: this.crossProviderFallbackSeen
        ? "VERIFIED"
        : [...runtimes].filter(([name, r]) => r.configured && name !== "scripted").length >= 2
          ? "READY"
          : "LOGIC_ONLY",
      critic: this.criticRunSeen ? "VERIFIED" : "READY_SELECTIVE"
    };
  }

  /**
   * D-106 PR #53 (functional-success-invariant, §3/§5): kost + trace for ETT
   * faktisk providerforsøk - brukes for både det ordinære forsøket OG et evt.
   * adaptivt retry-forsøk, slik at BEGGE forblir egne, ærlige, kostnadssporede
   * rader (§5: "Do NOT erase the failed first completion from history").
   * `outcome`/`finish_reason`/synlig tekstlengde persisteres alltid i
   * trace-metadata - aldri hemmelig, aldri rå resonnement-tekst.
   */
  private async recordAttemptResult(
    input: CompleteInput,
    result: ModelResult,
    outcome: CompletionOutcome,
    ctx: {
      traceId: string;
      started: number;
      budgetLevel: string;
      isCritic: boolean;
      adapterName: string;
      latency: number;
      streamOpts?: { onEvent: StreamHandler; signal?: AbortSignal };
      failedProviders: string[];
      plan: RoutePlan;
      /** Satt kun når DETTE forsøket er det adaptive retry-forsøket. */
      adaptiveRetryOfOutcome?: CompletionOutcome;
    }
  ): Promise<void> {
    const cost =
      this.legacyCostOverride(result) ?? computeCostOre(this.pricing, result.provider, result.model, result.usage);
    await this.recordCost(input, result, cost, {
      success: true,
      fallback: ctx.failedProviders.length > 0,
      critic: ctx.isCritic,
      latency_ms: ctx.latency,
      // BO-11.1 §4: streaming-/tool-metrics SQL-spørrbare (migrasjon 016).
      stream: Boolean(ctx.streamOpts),
      ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
      tool_calls: result.tool_calls?.length ?? 0
    });
    await this.opts.trace.record({
      trace_id: ctx.traceId,
      kind: "model_call",
      name: `${ctx.isCritic ? "critic:" : ""}${ctx.adapterName}:${result.model}`,
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      at: new Date().toISOString(),
      duration_ms: Date.now() - ctx.started,
      cost_ore: cost,
      metadata: {
        usage: { ...result.usage },
        budget_level: ctx.budgetLevel,
        router_mode: ctx.plan.mode,
        routing_reason: ctx.plan.reason,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(ctx.failedProviders.length > 0 ? { fallback_from: ctx.failedProviders } : {}),
        latency_ms: ctx.latency,
        ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
        ...(result.tool_calls?.length ? { tool_calls_requested: result.tool_calls.length } : {}),
        critic: ctx.isCritic,
        // D-106 PR #53 functional-success-invariant (§3): ærlig utfallsklassifisering,
        // alltid persistert. Ingen secrets, ingen rå resonnement-tekst - kun metadata.
        outcome,
        ...(result.finish_reason !== undefined ? { finish_reason: result.finish_reason } : {}),
        visible_text_length: result.text.length,
        has_tool_calls: Boolean(result.tool_calls?.length),
        has_structured_output: result.structured_output !== undefined,
        ...(ctx.adaptiveRetryOfOutcome !== undefined
          ? { adaptive_retry: true, adaptive_retry_of_outcome: ctx.adaptiveRetryOfOutcome }
          : {})
      }
    });
  }

  /**
   * D-106 PR #53 (§4): "policy/budget permits retry" - gjenbruker DEN SAMME
   * `BudgetGuard` som styrer det ordinære kallet (ingen ny budsjett-mekanisme).
   * Evalueres PÅ NYTT rett før retry-kallet, fordi retry er et EKSTRA, reelt
   * billable kall utover det som allerede ble godkjent innledningsvis - hvis
   * budsjettet i mellomtiden har blitt hardt blokkert/krever godkjenning,
   * nektes retry-forsøket (ærlig fallback/feil, §4/§7), men SELVE det
   * allerede utførte (og allerede kostnadsførte) første forsøket rulles
   * aldri tilbake.
   */
  private async adaptiveRetryPermittedByBudget(tenantId: string): Promise<boolean> {
    const budget = await this.guard.evaluate(tenantId);
    return budget.level !== "hard_blocked" && budget.level !== "needs_approval";
  }

  private async recordCost(
    input: CompleteInput,
    result: ModelResult,
    costOre: number,
    flags: {
      success: boolean;
      fallback: boolean;
      critic: boolean;
      latency_ms: number;
      /** BO-11.1 §4: kun satt for streaming-executions (migrasjon 016). */
      stream?: boolean;
      ttft_ms?: number;
      tool_calls?: number;
    }
  ): Promise<void> {
    await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
      client.query(
        `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                  input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms,
                                  ttft_ms, stream, tool_calls)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          input.tenant_id,
          input.task_id ?? null,
          input.session_id ?? null,
          `model:${result.provider}`,
          costOre,
          result.provider,
          result.model,
          result.usage.input_tokens,
          result.usage.output_tokens,
          input.purpose ?? null,
          flags.success,
          flags.fallback,
          flags.critic,
          flags.latency_ms,
          flags.ttft_ms ?? null,
          flags.stream ?? false,
          flags.tool_calls ?? 0
        ]
      )
    );
  }

  /** Bakoverkompatibilitet: eksplisitt rates-opsjon (eldre tester/konfig) vinner over pricing-tabellen. */
  private legacyCostOverride(result: ModelResult): number | undefined {
    const rate = this.opts.rates?.[result.provider];
    if (!rate) {
      return undefined;
    }
    return Math.ceil(
      (result.usage.input_tokens / 1000) * rate.input_per_1k_ore +
        (result.usage.output_tokens / 1000) * rate.output_per_1k_ore
    );
  }

  private async recordFailedAttempt(
    input: CompleteInput,
    provider: string,
    err: ProviderError,
    critic: boolean
  ): Promise<void> {
    try {
      await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
        client.query(
          `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                    input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms)
           VALUES ($1, $2, $3, $4, 0, $5, $6, 0, 0, $7, false, false, $8, NULL)`,
          [
            input.tenant_id,
            input.task_id ?? null,
            input.session_id ?? null,
            `model:failed:${err.kind}`,
            provider,
            "(failed)",
            input.purpose ?? null,
            critic
          ]
        )
      );
    } catch {
      // Kostlogging av feilforsøk skal aldri stoppe fallback-kjeden.
    }
  }

  private enforceRateLimit(tenantId: string): void {
    const limit = this.opts.maxCallsPerMinute ?? 60;
    const now = Date.now();
    const stamps = (this.callTimestamps.get(tenantId) ?? []).filter((t) => now - t < 60_000);
    if (stamps.length >= limit) {
      throw new Error("rate_limited: for mange modellkall per minutt");
    }
    stamps.push(now);
    this.callTimestamps.set(tenantId, stamps);
  }
}
