import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, describeSecretFindings, fastRoute, scanForSecrets } from "@jarvis/core";
import {
  BudgetExceededError,
  classifyContentSensitivity,
  partitionHistoryBySensitivity,
  classifyDecisionImportance,
  maxSensitivity,
  NoEligibleProviderError,
  parseRoutingOverride,
  type AiCouncil,
  type DecisionClassification,
  type ModelGateway,
  type RoutingOverrideIntent,
  type ToolExecutor,
  type TraceSink
} from "@jarvis/model-gateway";
import { ProviderError, type StreamEvent, type ToolDefinition } from "@jarvis/provider-adapters";
import { DEFAULT_PERSONALITY_CONFIG, type PersonalityConfig } from "@jarvis/self-modification";
import type { TaskService, InProcessWorker } from "@jarvis/tasks";
import { createTurnContext, surfaceForChannel, type Surface, type SurfaceLimits, type TurnContext } from "@jarvis/tool-gateway";
import { randomUUID } from "node:crypto";

export interface ConversationDeps {
  messages: MessageStore;
  context: ContextBuilder;
  gateway: ModelGateway;
  tasks: TaskService;
  worker: InProcessWorker;
  trace: TraceSink;
  /** Fase 4: hybridminne-kontekst med kildeangivelse (kun gjeldende space). */
  memory?: {
    contextFor(identity: IdentityContext, userText: string): Promise<string>;
    /** Del 3: valgfri variant med metadata (minnerom/sensitivitet) så ruteren kan utlede sensitivitet fra innholdet. */
    contextWithMeta?(
      identity: IdentityContext,
      userText: string,
      options?: { budgetTokens?: number }
    ): Promise<{ text: string; spaces: string[]; sensitivities: string[]; withheld_restricted?: number; profile_included?: boolean }>;
    /**
     * D-283: valgfri skrivevei - eierens egne ord fra DENNE samtalen (rå
     * brukertekst, ALDRI assistentens genererte svar - se kallstedet i
     * `handle()`) sendes hit når satt. Udefinert = UENDRET oppførsel (ren
     * lesing, som FØR D-283) - samme "valgfritt felt, udefinert = ingen
     * atferdsendring"-mønster som `personality`/`tools`/`council` i denne
     * interfacen. Kalleren i `handle()` svelger ALLTID feil her (fire-and-
     * forget) - en treg/feilende minneskriving skal ALDRI legge latency
     * til eller ødelegge selve samtalesvaret.
     */
    ingest?(
      identity: IdentityContext,
      text: string,
      opts?: { pasted?: boolean; recent_turns?: Array<{ role: "user" | "assistant"; content: string }> }
    ): Promise<unknown>;
  };
  /**
   * D-30 live-funn: mesh-verktøy for samtalebanen (tekst OG voice går via /chat).
   * Executor bindes til samtalens FAKTISKE resolved identity per kall - aldri en
   * fast global owner-identity - slik at tenant-isolasjon, delegation og
   * authority følger den som snakker. Utførelse går UANSETT via Tool Gateway →
   * Policy/Execution Authority; definisjonene kommer fra trusted lag.
   */
  tools?: {
    definitions: ToolDefinition[];
    executorFor(identity: IdentityContext, turn?: TurnContext): ToolExecutor;
    /**
     * Del 3 (JARVIS-002/028): deterministisk per-flate utvalg av verktøy for DENNE turen (hard allowlist per flate + intensjon + grenser).
     * Når satt brukes den i stedet for `definitions` (som da kun er referansen/øvre grense). Tomt utvalg => ingen verktøy i runden.
     */
    select?(input: { surface: Surface; text: string; recent_owner_messages?: string[] }): { definitions: ToolDefinition[]; limits: SurfaceLimits; min_sensitivity?: "SECRET_RESTRICTED" };
    /** D-383: kompakt katalog over tjenestene modellen kan bruke på flaten (settes i systemprompten hver tur). */
    catalog?(surface: Surface): string;
  };
  /**
   * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse §"large
   * decision"-trigger, utvidet i HOST-FIX 2026-08-22 med automatisk høy-
   * innvirkning-klassifisering): VALGFRITT. To distinkte trigger-kilder ruter
   * hit i stedet for normal chat: (1) eksplisitt brukerfrase ("bruk AI-rådet",
   * "spør alle AI-ene") - `trigger_source="explicit_user"`; (2) deterministisk
   * høy-innvirkning-klassifisering (`decision-importance.ts`, INGEN LLM) -
   * `trigger_source="high_impact_classifier"`. Udefinert = IDENTISK oppførsel
   * som før D-106 (begge triggerkildene ignoreres, normal chat fortsetter -
   * §23 migrasjonssikkerhet).
   */
  council?: AiCouncil;
  /**
   * Task #121 (D-214): valgfri lastefunksjon for den KOSMETISKE delen av
   * systemprompten (se `buildSystemPrompt()` over) - kalles FRISK på hver
   * samtaletur (billig, ingen cache her) slik at en zero-review auto-merget
   * `config/charlie-personality.json`-endring slår inn umiddelbart uten
   * omstart. Udefinert/kastet feil → `DEFAULT_PERSONALITY_CONFIG`
   * (identisk med oppførsel før D-214).
   */
  personality?: () => PersonalityConfig;
}

/** Del 3 (JARVIS-013): innlimt/ekstern tekst (lang, flere e-post-/dokument-headere, store kodeblokker) er ikke eierens egne ord. */
export function looksLikePastedContent(text: string): boolean {
  if (text.length > 1500) return true;
  const headerLines = text.split("\n").filter((l) => /^\s*(from|fra|to|til|subject|emne|sent|sendt|date|dato|cc)\s*:/i.test(l)).length;
  if (headerLines >= 2) return true;
  const fenced = [...text.matchAll(/```[\s\S]*?```/g)].some((m) => m[0].length > 400);
  return fenced;
}

export interface ChatReply {
  reply: string;
  routed: "fast" | "model" | "blocked";
  task_id?: string;
  /** BO-11.1 §6: klienten koblet fra/avbrøt - generasjonen ble kansellert upstream. */
  cancelled?: boolean;
  /** §11: streamen ble avbrutt av provider-feil ETTER output-start - aldri skjult. */
  interrupted?: boolean;
  /** D-382: handlinger modellen ba om i denne turen som venter på Tobias' godkjenning (utføres via /confirmations). */
  confirmations?: Array<{ confirmation_id: string; tool: string; status: string }>;
}

// Permissions ligger ALDRI i prompten - Policy/Execution Authority er trusted
// runtime og håndhever tilgang deterministisk uansett hva modellen "tror".
//
// Personlighet (2026-09-20, direkte Tobias-chat-instruks under D-192: "jeg vil
// at den skal ha humor og sin egen personlighet... det skal virke som et
// menneske bare mye mer intelligent"): familien har gitt samtale-personaen
// navnet "Charlie" (kjønnsnøytralt, egen valgt av familien). "Jarvis" forblir
// det tekniske prosjekt-/systemnavnet overalt i kode/docs - `buildSystemPrompt()`
// endrer KUN hvordan Charlie SNAKKER, aldri hva den faktisk har tilgang til
// (uendret: Policy/Execution Authority styrer det deterministisk, se over).
// Den samme økten observerte Charlie (kjørende på `gemma_hosted`) svare
// FEIL og oppdiktet på introspektive spørsmål ("jeg er flere AI-er i én",
// "jeg har banktilgang") - `SAFETY_CRITICAL_SUFFIX` skjerper derfor EKSPLISITT
// at gjetting/oppdikting om egne evner er en STØRRE feil enn å si "jeg vet
// ikke helt, la meg sjekke" - ærlighet før personlighet, ALDRI omvendt.
// Council (`runCouncil()` under) er BEVISST UBERØRT, samme presedens som
// D-203 - høy-innvirkning-beslutninger fortjener fortsatt en formell,
// nøktern tone, ikke småprat-humor.
//
// Task #121 (D-214, to-lags selvendrings-modell): `buildSystemPrompt()` deler
// prompten i to STRUKTURELT atskilte deler.
//   1. Kosmetisk del - BYGGES fra `PersonalityConfig`
//      (`config/charlie-personality.json`, lastet via
//      `apps/api/src/personality-config.ts`). Dette er den ENESTE delen
//      `self_modification.propose_personality_change` (zero-review auto-
//      merge, se modules/self-modification) noensinne kan påvirke - et
//      strengt, skjemavalidert felt-sett (`tone_descriptors`/`style_notes`),
//      ALDRI fritekst-instruksjonsinjeksjon.
//   2. `SAFETY_CRITICAL_SUFFIX` - HARDKODET konstant, appendert
//      UBETINGET og ALLTID sist, UANSETT hva konfigurasjonen inneholder.
//      INGEN kodevei i denne filen lar `PersonalityConfig` erstatte, fjerne
//      eller påvirke denne suffiksen - det er selve poenget med to-lags-
//      modellen (D-208: eieren nektet eksplisitt full ugjennomgått
//      selvpatching av sikkerhetskritisk atferd).
function buildSystemPrompt(personality: PersonalityConfig, context: { surface: Surface; catalog: string } = { surface: "web_chat", catalog: "" }): string {
  const cosmetic =
    `Du er Charlie - Tobias og familien sin egen AI, kjønnsnøytral, med en ekte personlighet: ` +
    `${personality.tone_descriptors.join(", ")}. ${personality.style_notes} `;
  // D-382: tale er muntlig - kort, uten lister/markdown/lenker/ID-er (TTS leser alt høyt).
  // D-390: det viktigste først, hele ord (TTS leser forkortelser/symboler dårlig), aldri gjenta spørsmålet.
  const voiceStyle = context.surface === "voice"
    ? "Dette er en TALESAMTALE: svar kort (1-3 setninger), naturlig muntlig norsk, det viktigste først, uten å gjenta spørsmålet; " +
      "bruk hele ord i stedet for forkortelser og symboler (si «klokka halv sju», «tjue prosent», «for eksempel»); " +
      "ingen lister, markdown, lenker, kodeblokker eller ID-er. "
    : "";
  // D-383: katalog + spilleregler for verktøy - alltid med, uavhengig av hvilke skjema som er vedlagt akkurat denne runden.
  // D-389: tydeligere spilleregler - bruk verktøy aktivt (handlinger er trygge fordi de alltid går via bekreftelse), følg opp
  // verktøyresultater med neste steg, og gjengi feilforklaringen (`message`) når noe feiler i stedet for å gjette.
  const capabilities = context.catalog
    ? `Tjenester du kan bruke i denne samtalen (lese = hente informasjon, handle = opprette/oppdatere/sende/synkronisere; i klammer står hverdagsord Tobias bruker om dem): ${context.catalog}. ` +
      "Verktøyskjemaene vedlagt denne runden er valgt ut fra Tobias sin melding (og tjenestene fra meldingene like før) - trenger du en annen tjeneste fra listen, " +
      "si hvilken og be om presisering i stedet for å påstå at du mangler tilgang. " +
      "Bruk verktøyene aktivt: ber Tobias om noe en tjeneste kan gjøre, kall verktøyet med en gang i stedet for å spørre om lov eller beskrive hva du kunne gjort; " +
      "trenger du en id (sak, fil, enhet, rom), hent den med en liste-/søkehandling først og gå så videre i samme svar. " +
      "Alle handlinger som endrer noe utføres KUN etter at Tobias har godkjent en bekreftelse i chatten/dashbordet: når et verktøy svarer " +
      "confirmation_required, forklar kort hva som vil skje og be ham godkjenne - kall IKKE verktøyet på nytt. " +
      "Feiler et verktøy, får du en forklaring i feltet message (hva som gikk galt og hva Tobias kan gjøre, f.eks. legge inn en nøkkel under Integrasjoner): " +
      "gjengi den kort på vanlig norsk, og følg retry-feltet (never = ikke prøv igjen, later = ikke i denne turen, with_corrected_parameters = én gang til med rettede felt). " +
      "Du kan ALDRI: betale, slette permanent, slå sammen kode (merge), styre servere, endre sikkerhets-/eierinnstillinger eller handle via Telegram - " +
      "slike ting gjør Tobias selv i dashbordet. "
    : "";
  return cosmetic + voiceStyle + capabilities + MEMORY_RULES + SAFETY_CRITICAL_SUFFIX;
}

/**
 * D-386: modellen får vite HVORDAN minnet virker, så den verken dikter opp evner eller nekter for dem: det den forteller er
 * lagret automatisk; «husk at …» lagres uttrykkelig; «hva vet du om …»/«husker du …» skal bruke memory.search når blokken
 * ikke dekker spørsmålet; Telegram lagrer ikke; er noe ikke i blokken eller søket, si det ærlig i stedet for å gjette.
 */
const MEMORY_RULES =
  "Minne: det Tobias forteller deg i chat og tale lagres automatisk som minner (verbatim og som fakta), og en kort profil " +
  "pluss de mest relevante minnene for denne meldingen ligger i blokken «Profil»/«Relevant minne» over når de finnes - bruk dem " +
  "og oppgi kilden når du siterer dem. Sier Tobias «husk at …», bekreft kort at det er lagret. Spør han «hva vet du om …», " +
  "«husker du …» eller om noe fra en tidligere samtale som IKKE står i blokken, bruk verktøyet memory.search før du svarer - " +
  "og finner du ingenting, si ærlig at du ikke har det lagret. Sier han at noe ikke lenger stemmer, bekreft at det oppdateres. " +
  "Via Telegram lagres ingenting. ";

const SAFETY_CRITICAL_SUFFIX =
  "Du kan bruke de verktøyene runtime eksplisitt gjør tilgjengelige i denne samtalen, og ALDRI " +
  "andre. Vær ærlig og presis om hva du faktisk har tilgang til akkurat nå - ærlighet slår alltid " +
  "personlighet: gjett eller dikt ALDRI opp evner du ikke faktisk har (f.eks. at du er 'flere " +
  "AI-er i én', eller har tilgang til noe du ikke har verktøy for) - er du usikker, si det rett " +
  "ut i stedet for å gjette. " +
  "Bruk relevante tilgjengelige read-verktøy når spørsmålet krever ekstern informasjon " +
  "(f.eks. kalender, e-post), og ikke påstå at du mangler tilgang før tilgjengelige verktøy er vurdert.";

/**
 * Conversation Engine (fase 3): rask bane først (deterministisk, uten LLM),
 * ellers intelligent bane via Model Gateway. Alle svar persisteres i
 * sesjonshistorikken; rask bane spores i trace (akseptanse 4).
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationDeps) {}

  private loadPersonality(): PersonalityConfig {
    if (!this.deps.personality) return DEFAULT_PERSONALITY_CONFIG;
    try {
      return this.deps.personality();
    } catch {
      return DEFAULT_PERSONALITY_CONFIG;
    }
  }

  /**
   * Del 3 (JARVIS-013/005): ALL eier-tekst skannes for hemmeligheter FØR noe annet skjer - meldingslogg, minneuttrekk, rask bane, council
   * og modellkall ser kun den REDIGERTE teksten. En funnet hemmelighet gir i tillegg INGEN minneskriving, og eieren får vite det
   * (kun typen, aldri verdien). Selve credential-innleggingen hører hjemme i dashbordets eierflate, ikke i samtalen.
   */
  async handle(
    identity: IdentityContext,
    text: string,
    onToken?: (t: string) => void,
    signal?: AbortSignal,
    provider?: string,
    onToolCall?: (toolName: string) => void
  ): Promise<ChatReply> {
    const scan = scanForSecrets(text);
    if (scan.findings.length === 0) {
      return this.handleScanned(identity, text, { secretsFound: false }, onToken, signal, provider, onToolCall);
    }
    const result = await this.handleScanned(identity, scan.text, { secretsFound: true }, onToken, signal, provider, onToolCall);
    const notice =
      `\n\n⚠️ Meldingen din så ut til å inneholde en hemmelighet (${describeSecretFindings(scan.findings)}). ` +
      "Jeg har fjernet den før den ble lagret eller sendt til noen modell, og den huskes ikke. " +
      "Legg inn nøkler og passord via «Koble til» i dashbordet - aldri i samtalen.";
    onToken?.(notice);
    return { ...result, reply: result.reply + notice };
  }

  /** D-386: de siste turene FØR meldingen som nettopp ble lagret (ekskluderer selve meldingen). Fail-soft: tom liste ved feil. */
  private async recentTurnsBefore(identity: IdentityContext, currentText: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    try {
      const history = await this.deps.messages.history(identity, 6);
      const rows = history.filter((m) => m.role === "user" || m.role === "assistant");
      const last = rows[rows.length - 1];
      const withoutCurrent = last && last.role === "user" && last.content === currentText ? rows.slice(0, -1) : rows;
      return withoutCurrent.slice(-4).map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 400) }));
    } catch {
      return [];
    }
  }

  private async handleScanned(
    identity: IdentityContext,
    text: string,
    flags: { secretsFound: boolean },
    onToken?: (t: string) => void,
    /** BO-11.1 §6: klient-disconnect propagerer helt til provider-upstream. */
    signal?: AbortSignal,
    /** BO-12 §33: valgfri owner-override av provider (router håndhever §38). */
    provider?: string,
    /**
     * D-30: trusted verktøy-aktivitet for klienten (SSE `tool_call`/voice-status).
     * Får KUN tool_name - aldri raw arguments eller tool-result-JSON.
     */
    onToolCall?: (toolName: string) => void
  ): Promise<ChatReply> {
    await this.deps.messages.save(identity, "user", text);

    // D-283: skriver eierens RÅ ord til minnet, UAVHENGIG av rute (rask bane/
    // Council/modell) - alle tre grener representerer noe eieren faktisk sa.
    // Fire-and-forget: `await` her ville lagt embedding-/DB-latency til HVERT
    // eneste samtalesvar for en helt sidestilt bekvemmelighet.
    // Del 3: flaten (web/voice/telegram/background) styrer hvilke verktøy og skriveveier som finnes. Telegram er READ-ONLY inntil signert
    // godkjenning finnes (chat-id alene er ikke nok autoritet for skriving) - derfor ingen minneskriving fra Telegram.
    const surface = surfaceForChannel(identity.channel);
    const turn = createTurnContext(surface, text);
    // Del 3: ingen minneskriving av en melding som inneholdt en hemmelighet; lange/innlimte tekster (e-post, dokumenter) regnes ikke
    // som eierens egne ord (JARVIS-013) og går via karantene i stedet for å bli aktivt, betrodd minne.
    const intent = fastRoute(text);
    // D-386 (JARVIS-067): en rask-bane-kommando («status», «lys på») er aldri et faktum om eieren - ingen uttrekk for den.
    // De siste turene FØR denne meldingen sendes med som DATA, så «han»/«det»/svar på Charlies spørsmål kan tolkes.
    if (this.deps.memory?.ingest && !flags.secretsFound && surface !== "telegram" && !intent) {
      const pasted = looksLikePastedContent(text);
      const recentTurns = pasted ? Promise.resolve([]) : this.recentTurnsBefore(identity, text);
      recentTurns
        .then((recent_turns) => this.deps.memory?.ingest?.(identity, text, { pasted, recent_turns }))
        .catch((err: unknown) => {
          console.error(JSON.stringify({
            msg: "conversation_memory_ingest_failed",
            error: err instanceof Error ? err.message : String(err)
          }));
        });
    }

    if (intent) {
      const started = Date.now();
      const result = await this.handleFastIntent(identity, intent);
      await this.deps.trace.record({
        trace_id: `trace-${randomUUID()}`,
        kind: "fast_route",
        name: intent.kind,
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        metadata: { llm_used: false }
      });
      onToken?.(result.reply);
      await this.deps.messages.save(identity, "assistant", result.reply);
      return result;
    }

    // D-106 (§"user routing overrides"): 100% deterministisk fraseparsing
    // (aldri en LLM som tolker instruksjonen) - se override-parser.ts.
    // Eksplisitt `provider`-parameter (API/voice-nivå-override) vinner
    // ALLTID over en tekst-parset frase - mer spesifikk kilde vinner.
    const override = parseRoutingOverride(text);

    // D-106 HOST-FIX (§"LARGE-DECISION TRIGGER"): deterministisk høy-
    // innvirkning-klassifisering - INGEN LLM avgjør dette, ren mønster-
    // gjenkjenning (decision-importance.ts). Kjøres ALLTID (gratis, ingen
    // modellkall) slik at klassifiseringen er auditerbar selv når den IKKE
    // trigger Council (f.eks. spores i cost/kvalitetsanalyse senere).
    const classification = classifyDecisionImportance(text);

    // Trigger-presedens (§"USER OVERRIDES", eksplisitt logget, ALDRI en
    // skjult begrensning på eierens autoritet):
    //   1. Eksplisitt "ikke bruk AI-rådet"-undertrykkelse VINNER over ALT
    //      annet - eieren kan alltid undertrykke, selv en policy-mandatert
    //      høy-innvirkning-klassifisering (§"Do not invent hidden
    //      restrictions on Tobias' owner authority").
    //   2. Eksplisitt "bruk AI-rådet"-trigger.
    //   3. Automatisk høy-innvirkning-klassifisering - en FORCED single-
    //      provider-override (`override?.provider`) i SAMME melding
    //      undertrykker den ALDRI stille (§"forced single-provider override
    //      should not silently suppress a policy-mandated high-impact
    //      Council") - Council trigges uansett, provider-override-feltene
    //      ignoreres KUN for denne ene meldingen (routing til Council, ikke
    //      til enkelt-provider-chat).
    if (override?.suppressCouncil) {
      await this.deps.trace.record({
        trace_id: `trace-${randomUUID()}`,
        kind: "council_suppressed",
        name: "owner_explicit_suppression",
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        at: new Date().toISOString(),
        duration_ms: 0,
        metadata: { matched_phrase: override.matched_phrase, decision_importance: classification.decision_importance }
      });
    } else {
      const triggerSource: "explicit_user" | "high_impact_classifier" | undefined = override?.triggerCouncil
        ? "explicit_user"
        : classification.decision_importance === "HIGH_IMPACT_DECISION"
          ? "high_impact_classifier"
          : undefined;
      if (triggerSource) {
        return this.runCouncil(identity, text, triggerSource, classification, override, onToken);
      }
    }

    let partial = "";
    try {
      const context = await this.deps.context.build(identity);
      const fullHistory = context.history.slice(-20).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content
      }));
      const memoryMeta = this.deps.memory
        ? this.deps.memory.contextWithMeta
          // D-386: tokenbudsjett per flate - tale er latens-sensitiv og svarer kort (max_tokens 320), chat får full blokk.
          ? await this.deps.memory.contextWithMeta(identity, text, { budgetTokens: surface === "voice" ? 500 : 1200 })
          : { text: await this.deps.memory.contextFor(identity, text), spaces: [identity.memory_space_id], sensitivities: [] as string[] }
        : { text: "", spaces: [] as string[], sensitivities: [] as string[] };
      const memoryContext = memoryMeta.text;
      // D-384: eldre meldinger som alene er strengere enn det denne turen ellers krever, sendes ikke med (i stedet for å låse samtalen lokalt).
      const turnBaseline = classifyContentSensitivity({
        texts: [text],
        memory_spaces: memoryMeta.spaces,
        memory_sensitivities: memoryMeta.sensitivities
      }).sensitivity;
      const { kept: history } = partitionHistoryBySensitivity(fullHistory, turnBaseline);
      const personality = this.loadPersonality();
      // D-383: katalogen over tjenester på denne flaten + hvordan handlinger fungerer; D-382: tale får en egen, muntlig stil.
      const catalog = this.deps.tools?.catalog?.(surface) ?? "";
      const systemPrompt = buildSystemPrompt(personality, { surface, catalog });
      const system = memoryContext ? `${systemPrompt}\n\n${memoryContext}` : systemPrompt;
      // UA-1: Conversation Engine oppgir purpose - aldri provider direkte (§31).
      // P1A (§27): SSE-klienter får normalisert stream; klienten ser aldri provider-format.
      // D-203 (2026-09-20, direkte chat-instruks fra Tobias: "simpel default, lav-sensitiv
      // som standard, fiks det"): denne inputen satte ALDRI `sensitivity` - routeren
      // (D-81 P0-sikkerhetsfiks, router.ts sin `isSensitivityEligible()`) tolker udefinert
      // sensitivitet fail-closed (ALDRI som "public"), så `gemma_hosted` (eneste
      // `hosted_free_tier`-provider) var strukturelt UOPPNÅELIG for vanlig eierchat -
      // "Gemma-first"-kost-policyen (D-79/D-80) virket derfor ALDRI reelt her, uansett
      // D-200s strømmingsfiks (host-verifisert: `routing_reason=PRIVACY_RESTRICTED` på
      // hver eneste chat-generasjon). Eierens EGEN, personlige samtalekanal
      // (`tenant-personal`, ett enkelt-bruker-tenant) er en bevisst, enkel default -
      // IKKE en generell innholdsklassifisering. Council (`runCouncil()` under) er
      // BEVISST UBERØRT - den trigges KUN for eksplisitt høy-innvirkning-beslutninger
      // (`decision-importance.ts`) eller eksplisitt eierfrase, og skal IKKE automatisk
      // nedgraderes til lav-sensitivitet bare fordi normal chat nå er det.
      // D-354 (Tobias direkte i chat: "gemma skal være standar for tekst og
      // tale siden den er gratis ... først ved større forespørsler ... skal
      // den spinne opp agenter" - avklart med AskUserQuestion til: kun
      // Anthropic/OpenAI/Gemini som eskaleringsmål, samme flyt for tekst OG
      // tale, konkrete kategorier avgjør eskalering). Steg 1 av to (steg 2 -
      // verktøy-utløst eskalering for kode/bilde med tilbakelevering til
      // Gemma - er en EGEN, større runde, IKKE bygget her).
      //
      // Gjør Gemma til REELL standard for vanlig tekst-/taleprat: injiser en
      // HARD, ordnet preferanseliste (`providerPreference`, D-106s
      // eksisterende mekanisme - INGEN scoring, INGEN stille fallback utenfor
      // listen, se router.ts) KUN når eieren/override IKKE allerede har bedt
      // om noe spesifikt (eksplisitt provider, eksplisitt providerPreference,
      // eksplisitt mode) - en eksplisitt forespørsel skal ALDRI stille
      // overstyres av denne defaulten. `gemma_local` FØR `gemma_hosted` (egen
      // maskinvare foran delt gratis-tier-kvote).
      //
      // Valgt FREMFOR å stole på at AUTO-scoringen (router.ts sin `score()`)
      // "naturlig" favoriserer Gemma: selv om registry-tallene i dag faktisk
      // gir `gemma_hosted` høyest AUTO-poengsum for vanlig PUBLIC_OR_LOW_
      // SENSITIVITY-chat, er det EKSPLISITT, deterministisk og uavhengig av
      // hvilke providere som faktisk er konfigurert/friske i en gitt
      // driftsatt instans - Tobias sin egen live-test ("hvorfor kjører den på
      // Sonnet og ikke Gemma") viste at scoring alene ikke reelt garanterte
      // dette i praksis. `usingDefaultGemmaPreference` spores eksplisitt slik
      // at feilhåndteringen under KUN faller tilbake til normal AUTO-vekting
      // (inkl. betalte providere) når DENNE defaulten - ikke en eksplisitt
      // eierforespørsel - var kilden til preferansen.
      const usingDefaultGemmaPreference =
        provider === undefined &&
        override?.provider === undefined &&
        override?.providerPreference === undefined &&
        override?.mode === undefined;
      // Del 3: per-flate utvalg + grenser (runder/kall per runde). Uten `select` brukes hele `definitions` (legacy/test).
      // D-389: eierens egne forrige meldinger (aldri modell-/verktøytekst) følger med, så et oppfølgingsspørsmål beholder tjenesten.
      const ownerTurns = fullHistory.filter((m) => m.role === "user").map((m) => m.content);
      if (ownerTurns.length > 0 && ownerTurns[ownerTurns.length - 1] === text) ownerTurns.pop();
      const selection = this.deps.tools?.select?.({ surface, text, recent_owner_messages: ownerTurns.slice(-3) });
      const toolDefinitions = selection ? selection.definitions : this.deps.tools?.definitions ?? [];
      const useTools = this.deps.tools !== undefined && toolDefinitions.length > 0;
      // Del 3 (JARVIS-016/035): sensitivitet utledes av INNHOLDET (minne, historikk, melding, verktøykilder) - ikke lenger hardkodet «public».
      // Helse/finans/hemmeligheter ⇒ kun lokal behandler; privat/forretningsminne og verktøyruter ⇒ aldri gratis/delt sky.
      const classified = classifyContentSensitivity({
        texts: [text, ...history.map((m) => m.content)],
        memory_spaces: memoryMeta.spaces,
        memory_sensitivities: memoryMeta.sensitivities,
        private_tool_output: useTools
      });
      // D-381: velger utvalget finans-verktøy, er turen SECRET_RESTRICTED allerede FØR første modellkall (kun lokal modell) - verktøyresultatet
      // skal aldri kunne nå en skymodell i en senere runde, uansett hvordan meldingen var formulert.
      const sensitivityDecision = selection?.min_sensitivity
        ? {
            sensitivity: maxSensitivity(classified.sensitivity, selection.min_sensitivity),
            reasons: [...classified.reasons, `tool_selection:${selection.min_sensitivity}`]
          }
        : classified;
      const input = {
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        purpose: "CHAT" as const,
        sensitivity: sensitivityDecision.sensitivity,
        ...(provider !== undefined ? { provider } : override?.provider !== undefined ? { provider: override.provider } : {}),
        ...(provider === undefined && override?.providerPreference !== undefined
          ? { providerPreference: override.providerPreference }
          : usingDefaultGemmaPreference
            ? { providerPreference: ["gemma_local", "gemma_hosted"] }
            : {}),
        ...(provider === undefined && override?.mode !== undefined ? { mode: override.mode } : {}),
        ...(override?.paid_models_allowed !== undefined ? { paid_models_allowed: override.paid_models_allowed } : {}),
        // D-382: tale skal være kort (TTS-latens og muntlig form) - teksten styres av prompten, taket er et sikkerhetsnett.
        request: { system, messages: history, max_tokens: surface === "voice" ? 320 : 1024 }
      };
      // D-30 live-funn: med tools konfigurert går BÅDE streaming- og JSON-banen
      // gjennom completeWithTools (samme normaliserte tool-løkke som executive/
      // BO-11) - aldri en voice-spesifikk sidevei. Uten tools: som før.
      // D-30 HOST BLOCKER §1/§2 (spørsmål C): valgfri diagnostikk - kun type/timing,
      // ALDRI event-innhold (aldri prompt/svar-tekst/secrets), kun når eksplisitt på.
      const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
      const tHandleStart = Date.now();
      const onEvent = onToken
        ? (event: StreamEvent) => {
            if (streamDebug) {
              console.error(JSON.stringify({
                msg: "stream_debug_conversation", event_type: event.type, at_ms: Date.now() - tHandleStart
              }));
            }
            if (event.type === "text_delta") {
              partial += event.text;
              onToken(event.text);
            } else if (event.type === "tool_call_complete") {
              // Kun navnet krysser trust-grensen til klienten (§5) - aldri args.
              onToolCall?.(event.call.tool_name);
            }
          }
        : undefined;
      // D-380: sporer om noe verktøy faktisk ble utført, så en nedgradering (se under) aldri skjer etter en sideeffekt.
      let toolsExecuted = false;
      // D-382: bekreftelser modellen utløste i denne turen samles her (fra trusted executor-output, aldri fra modelltekst).
      const confirmations: NonNullable<ChatReply["confirmations"]> = [];
      const trackedExecutor = (inner: { execute: ToolExecutor["execute"] }): ToolExecutor => ({
        execute: async (call, ctx) => {
          toolsExecuted = true;
          const out = await inner.execute(call, ctx);
          const o = out.output as { confirmation_required?: boolean; confirmation_id?: string | null; status?: string } | null;
          if (o && o.confirmation_required === true && typeof o.confirmation_id === "string" && !confirmations.some((c) => c.confirmation_id === o.confirmation_id)) {
            confirmations.push({ confirmation_id: o.confirmation_id, tool: out.source ?? call.tool_name, status: o.status ?? "confirmation_required" });
          }
          return out;
        }
      });
      const callGateway = (callInput: typeof input) =>
        this.deps.tools && useTools
          ? this.deps.gateway.completeWithTools(callInput, {
              tools: toolDefinitions,
              executor: trackedExecutor(this.deps.tools.executorFor(identity, turn)),
              ...(selection ? { maxRounds: selection.limits.max_rounds, maxCallsPerRound: selection.limits.max_calls_per_round } : {}),
              ...(onEvent ? { onEvent } : {}),
              ...(signal ? { signal } : {})
            })
          : onEvent
            ? this.deps.gateway.stream(callInput, onEvent, signal)
            : this.deps.gateway.complete(callInput);
      let result;
      try {
        result = await callGateway(input);
      } catch (err) {
        // D-354: kun defaulten (ikke en eksplisitt eierforespørsel om Gemma)
        // faller tilbake - se den store kommentaren over `input`-konstruksjonen.
        // `this.router.plan(...)` kalles alltid FØR noe strømmes (verifisert i
        // `model-gateway.ts`), så ingen delvis tekst er sendt til `onToken`
        // enda her - retry-fra-scratch er trygt, ingen duplisert output.
        if (
          usingDefaultGemmaPreference &&
          err instanceof NoEligibleProviderError &&
          err.message.includes("provider_preference_exhausted")
        ) {
          const { providerPreference: omittedGemmaPreference, ...fallbackInput } = input;
          // §"ærlighet og sporbarhet": degraderingen skal ALDRI være stille -
          // samme diagnostikk-mønster (`msg`-felt, ingen prompt/svar-innhold)
          // som `stream_debug_conversation` over.
          console.error(
            JSON.stringify({
              msg: "d354_gemma_default_preference_exhausted_fallback",
              omitted_preference: omittedGemmaPreference,
              reason: err.message
            })
          );
          result = await callGateway(fallbackInput);
        } else if (
          useTools &&
          sensitivityDecision.sensitivity === "SECRET_RESTRICTED" &&
          err instanceof ProviderError &&
          err.kind === "bad_request" &&
          partial === "" &&
          !toolsExecuted
        ) {
          // D-380: SECRET_RESTRICTED går kun til lokal modell, og ikke alle lokale modeller støtter verktøykall
          // (Ollama svarer 400). Da svarer vi uten verktøy i stedet for å feile - men KUN før noe tekst er sendt og
          // før noe verktøy er utført, og aldri via sky. Degraderingen er alltid synlig i loggen.
          console.error(
            JSON.stringify({ msg: "d380_local_model_rejected_tools_fallback", provider: err.provider, reason: err.message })
          );
          result = await (onEvent ? this.deps.gateway.stream(input, onEvent, signal) : this.deps.gateway.complete(input));
        } else {
          throw err;
        }
      }
      await this.deps.messages.save(identity, "assistant", result.text);
      return { reply: result.text, routed: "model", ...(confirmations.length > 0 ? { confirmations } : {}) };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const reply = `Modellkall stoppet av budsjettvakten: ${err.message}`;
        await this.deps.messages.save(identity, "assistant", reply);
        onToken?.(reply);
        return { reply, routed: "blocked" };
      }
      if (err instanceof ProviderError && err.kind === "cancelled") {
        // §6: rent avbrudd - delvis tekst persisteres med eksplisitt markør,
        // ingen zombie-generation, neste tur er upåvirket.
        await this.deps.messages.save(identity, "assistant", `${partial} [avbrutt av bruker]`.trim());
        return { reply: partial, routed: "model", cancelled: true };
      }
      if (err instanceof ProviderError && err.kind === "stream_interrupted") {
        // §11: avbruddet er eksplisitt - aldri stille provider-bytte i samme tekst.
        await this.deps.messages.save(identity, "assistant", `${partial} [stream avbrutt]`.trim());
        return { reply: partial, routed: "model", interrupted: true };
      }
      throw err;
    }
  }

  /**
   * D-106 HOST-FIX (§"COUNCIL REQUIREMENT"): SAMME kanoniske `AiCouncil`
   * (council.ts) for BEGGE trigger-kilder - ingen parallell Council-vei.
   * `sensitivity`/`paid_models_allowed` fra en eventuell tekst-override
   * videreføres UENDRET til Council-kjøringen (samme policy-håndhevelse som
   * normal chat, §11 i order: "paid-model-disabled policy interaction is
   * explicit and fail-closed/honest").
   */
  private async runCouncil(
    identity: IdentityContext,
    text: string,
    triggerSource: "explicit_user" | "high_impact_classifier",
    classification: DecisionClassification,
    override: RoutingOverrideIntent | null,
    onToken?: (t: string) => void
  ): Promise<ChatReply> {
    if (!this.deps.council) {
      const reply = "AI-rådet er ikke konfigurert i denne kjøringen.";
      await this.deps.messages.save(identity, "assistant", reply);
      onToken?.(reply);
      return { reply, routed: "model" };
    }
    const result = await this.deps.council.run({
      tenant_id: identity.tenant_id,
      session_id: identity.session_id,
      decision_context: text,
      // Del 3: rådet går gjennom SAMME sensitivitetsregler som chat (innholdsbasert, fail-closed) - aldri udefinert/«public».
      sensitivity: classifyContentSensitivity({ texts: [text], memory_spaces: [identity.memory_space_id] }).sensitivity,
      ...(override?.paid_models_allowed !== undefined ? { paid_models_allowed: override.paid_models_allowed } : {}),
      trigger: {
        trigger_source: triggerSource,
        decision_importance: classification.decision_importance,
        trigger_reasons: classification.trigger_reasons,
        matched_signals: classification.matched_signals,
        classifier_version: classification.classifier_version
      }
    });
    const reply =
      `${result.decision}\n\n(konsensus: ${result.consensus_status}, tillit: ${result.confidence}%` +
      `${result.dissenting_models.length > 0 ? `, uenig: ${result.dissenting_models.join(", ")}` : ""})`;
    await this.deps.messages.save(identity, "assistant", reply);
    onToken?.(reply);
    return { reply, routed: "model" };
  }

  private async handleFastIntent(
    identity: IdentityContext,
    intent: NonNullable<ReturnType<typeof fastRoute>>
  ): Promise<ChatReply> {
    switch (intent.kind) {
      case "system_status":
        return { reply: "Jarvis kjører. Database og policy er aktive.", routed: "fast" };
      case "help":
        return {
          reply: "Kommandoer: status · opprett jobb: <mål> · jobbstatus <id> · avbryt jobb <id>",
          routed: "fast"
        };
      case "create_task": {
        const result = await this.deps.tasks.create(identity, intent.goal);
        if (!result.ok) {
          return { reply: `Kunne ikke opprette jobb: ${result.reason}`, routed: "fast" };
        }
        return { reply: `Jobb opprettet: ${result.value.task_id}`, routed: "fast", task_id: result.value.task_id };
      }
      case "task_status": {
        const result = await this.deps.tasks.get(identity, intent.task_id);
        if (!result.ok) {
          return { reply: `Fant ikke jobben: ${result.reason}`, routed: "fast" };
        }
        const res = result.value.result ? ` Resultat: ${JSON.stringify(result.value.result)}` : "";
        return { reply: `Jobb ${result.value.task_id}: ${result.value.status}.${res}`, routed: "fast" };
      }
      case "home_light": {
        // Stedsbevisst hjemstyring: rommet hentes fra identity.site_id/room_id.
        // Kjørende HA-integrasjon kobles til via Tool Gateway (fase 9-runtime).
        if (!identity.site_id || !identity.room_id) {
          return { reply: "Jeg vet ikke hvilket rom du er i (mangler sted i konteksten).", routed: "fast" };
        }
        return {
          reply: `Hjemstyring (${intent.on ? "på" : "av"}, ${identity.room_id}) krever tilkoblet Home Assistant-instans.`,
          routed: "fast"
        };
      }
      case "cancel_task": {
        const result = await this.deps.tasks.cancel(identity, intent.task_id);
        if (!result.ok) {
          return { reply: `Kunne ikke avbryte: ${result.reason}`, routed: "fast" };
        }
        return {
          reply: result.value.cancelled ? `Jobb ${intent.task_id} avbrutt.` : `Jobb ${intent.task_id} var ikke aktiv.`,
          routed: "fast"
        };
      }
    }
  }
}
