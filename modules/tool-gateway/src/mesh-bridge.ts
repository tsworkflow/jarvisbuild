import type { ToolCallRequest, ToolDefinition as MeshToolDefinition, ToolResultMessage } from "@jarvis/provider-adapters";
import { zodToJsonSchema } from "zod-to-json-schema";
import { jobContractAllows, type ToolGateway } from "./gateway.ts";
import { ownerStatesMemory } from "./owner-stated-memory.ts";
import type { JobContract, JsonValue } from "@jarvis/contracts";
import { SURFACE_TOOL_GRANTS, requiresConfirmationWhenTainted, scopeFieldsOf, type ToolManifest } from "./tool-manifest.ts";
import type { TurnContext } from "./turn-context.ts";
import { CHAT_ACT_TIER_KEYS } from "./chat-act-tier.ts";
import { explainToolFailure, type ToolFailureContext } from "./tool-failure.ts";

/**
 * UA-1 P1A (§13, §16-§17): trusted bro mellom AI Mesh og Tool Gateway.
 * Definisjonene kommer HERFRA (trusted lag) - modellen definerer aldri egne
 * verktøy/permissions. Utførelse går alltid gjennom ToolGateway.execute →
 * Policy/Execution Authority/idempotens/audit, uansett provider.
 * P1A eksponerer kun ufarlige A/B-klasse READ-verktøy (§14).
 */
/** Kobling mesh-verktøynavn → registrert Tool Gateway-handling. */
export interface MeshToolMapping {
  def: MeshToolDefinition;
  tool_id: string;
  action: string;
  /**
   * D-30 live-funn: gateway-verktøyenes skjema krever felter (from/to, max, repo)
   * som mesh-definisjonene bevisst IKKE eksponerer for modellen. Parametrene
   * bygges derfor HER i trusted lag (samme presedens som daily-brief) - modellen
   * bestemmer aldri gateway-parametre. Uten dette ga tomme model-args
   * `invalid_parameters`-DENY i ToolGateway for alle tre read-verktøyene.
   */
  parameters?: (modelArgs: Record<string, unknown>) => Record<string, unknown>;
  /**
   * D-381: identitets-/scope-felt (tenant_id, memory_space, person-felt) som TRUSTED lag fyller fra den autentiserte identiteten
   * ved utførelse - de er fjernet fra skjemaet modellen ser, og en verdi modellen likevel sender overstyres alltid.
   */
  scope_bindings?: ReadonlyArray<string>;
  /** D-382: `act` = endrer noe; utføres kun etter eierens bundne bekreftelse. Udefinert/`read` = lesing. */
  kind?: "read" | "act";
}

const MESH_TOOLS: MeshToolMapping[] = [
  {
    def: {
      name: "read_recent_email",
      description: "Les de nyeste e-postene i eierens innboks (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "email",
    action: "read_inbox",
    parameters: () => ({ max: 10 })
  },
  {
    def: {
      name: "read_calendar_today",
      description: "Les dagens kalenderhendelser (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "calendar",
    action: "read_events",
    parameters: () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
    }
  },
  {
    def: {
      name: "read_github_issues",
      description: "Les åpne GitHub-issues i prosjektrepoet (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "github",
    action: "read_issues",
    parameters: () => ({ repo: process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild" })
  },
  /**
   * D-209 ("Charlie"-selv-bevissthet): eneste sanne kilde for "hva har jeg
   * faktisk tilgang til akkurat nå" - se `@jarvis/executive` sitt
   * `getCapabilityStatus()`. BEVISST inkludert i DENNE listen (ikke bare
   * registrert i gateway) - uten en mesh-mapping ville verktøyet vært
   * registrert i ToolGateway, men ALDRI reelt kallbart fra selve samtalen,
   * nøyaktig det samme gapet som gjorde at Charlie konfabulerte om egne
   * evner i utgangspunktet.
   */
  {
    def: {
      name: "check_my_capabilities",
      description:
        "Sjekk hvilke verktøy du FAKTISK har tilgang til i denne samtalen akkurat nå, hvilken modell/" +
        "leverandør som FAKTISK genererer dette svaret, og siste kjente helsetilstand for tilkoblede " +
        "systemer. Bruk DETTE FØR du sier noe om egne evner, tilkoblinger eller hvilken modell du er " +
        "- gjett ALDRI.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "executive",
    action: "get_capability_status"
  },
  /**
   * Task #118 ("Charlie"-minne-verifisering): `MemoryRetriever` (se
   * `memory-transport.ts`) var allerede den kanoniske, kildebelagte
   * søkemotoren `contextFor()` bruker for stille bakgrunnskontekst - men
   * Charlie hadde INGEN måte å EKSPLISITT spørre "hva vet du om X" og få et
   * fullt svar tilbake, kun det den stille konteksten tilfeldigvis traff.
   * `query` kommer FRA MODELLEN (ikke en trusted-lag-konstant som de andre
   * mappingene over) - trygt fordi ToolGateway sitt `strict()`-Zod-skjema
   * (`memory-transport.ts`) validerer typen FØR noe når databasen, og selve
   * søket er parameterisert (ingen SQL bygges av fritekst).
   */
  {
    def: {
      name: "search_my_memory",
      description:
        "Søk i det du faktisk har lagret om Tobias/familien for DENNE samtalens memory space (hybrid " +
        "fulltekst+vektor, med kildeangivelse per treff). Bruk dette for å svare kildebelagt på " +
        "'hva vet du om...'/'husker du...'-spørsmål i stedet for å gjette.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Hva du leter etter, på naturlig norsk." } },
        required: ["query"],
        additionalProperties: false
      }
    },
    tool_id: "memory",
    action: "search",
    parameters: (modelArgs) => ({ query: String(modelArgs["query"] ?? "") })
  },
  {
    // D-367: modellens ENESTE skrivehandling - ALLTID karantene (se `memory-transport.ts`/`model-tool-surface.ts`).
    def: {
      name: "suggest_memory",
      description:
        "Foreslå at noe lagres i langtidsminnet - KUN når Tobias eksplisitt ber deg huske noe. Ber han uttrykkelig om det i " +
        "meldingen sin (f.eks. 'husk at …'), lagres det med en gang; ellers (hvis du selv foreslår det) havner det i KARANTENE " +
        "til Tobias godkjenner det i dashbordet - svar ærlig ut fra statusen i resultatet. Bruk et kort, kanonisk emne " +
        "(f.eks. 'tobias.familie') og én presis, selvstendig setning med Tobias sine egne ord som innhold.",
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Kort kanonisk emne, f.eks. 'tobias.familie.barn'." },
          content: { type: "string", description: "Det som skal huskes, som én presis setning." },
          type: { type: "string", enum: ["semantic", "preference", "relation", "project", "decision", "commitment", "procedure"], description: "Minnetype (standard: semantic)." }
        },
        required: ["subject", "content"],
        additionalProperties: false
      }
    },
    tool_id: "memory",
    action: "propose",
    parameters: (modelArgs) => ({
      subject: String(modelArgs["subject"] ?? ""),
      content: String(modelArgs["content"] ?? ""),
      ...(typeof modelArgs["type"] === "string" ? { type: modelArgs["type"] } : {})
    })
  }
];

/**
 * Remediering del 1: de EKSPLISITTE, kuraterte lese-mappingene som utgjør
 * modellens aktive verktøyflate (se `model-tool-surface.ts`). Returnerer en
 * kopi - kallere kan ikke mutere den interne listen.
 */
export function curatedReadOnlyMeshTools(): MeshToolMapping[] {
  return [...MESH_TOOLS];
}

/**
 * D-237 (Charlie-selv-bevissthet, funn i faktisk bruk): `meshToolDefinitions()`
 * alene eksponerer KUN navn/beskrivelse - ingen vei til å slå opp det
 * underliggende `tool_id`/`action`-paret og dermed `credential_ref`.
 * `ExecutiveService.getCapabilityStatus()` (D-209, "check_my_capabilities")
 * trengte nettopp DET for å kunne svare "har jeg faktisk credential for
 * dette, akkurat nå" - uten denne eksporten kunne `chat_accessible_tools`
 * kun liste STRUKTURELT eksisterende mesh-verktøy, ALDRI om de faktisk var
 * brukbare (samme konfabulasjonsgap D-209 selv ble bygget for å lukke, bare
 * for credential-dimensjonen i stedet for tool-eksistens-dimensjonen).
 * `parameters`-closuren (trusted-lag-internt, ALDRI modell-styrt) er
 * BEVISST IKKE med her.
 */
export interface MeshToolBinding {
  name: string;
  description: string;
  tool_id: string;
  action: string;
}
export function meshToolBindings(tools: MeshToolMapping[] = MESH_TOOLS): MeshToolBinding[] {
  return tools.map((t) => ({ name: t.def.name, description: t.def.description, tool_id: t.tool_id, action: t.action }));
}

export function meshToolDefinitions(tools: MeshToolMapping[] = MESH_TOOLS): MeshToolDefinition[] {
  return tools.map((t) => t.def);
}

/**
 * D-289 (Tobias direkte i chat, 2026-09-26: "vil ha alt at han har full
 * kontroll" - eksplisitt retningsvalg på D-288 sitt funn om at
 * samtaleflaten strukturelt KUN kunne kalle de 5 kuraterte `MESH_TOOLS`,
 * mens `ToolGateway` hadde ~28 fullt registrerte `tool_id`-er).
 *
 * Genererer ÉN mesh-mapping PER FAKTISK REGISTRERT `tool_id:action`-par
 * (`gateway.list()`) i stedet for en håndskrevet, kuratert liste - samtalen
 * (chat OG tale, BEGGE via `/chat`) kan derfor be Charlie om AKKURAT det
 * dashbordet allerede kan gjøre, ingen mer og ingen mindre. `input_schema`
 * konverteres fra den REGISTRERTE Zod-typen (`zod-to-json-schema`) - modellen
 * ser ALLTID nøyaktig det samme skjemaet `ToolGateway.execute()` selv
 * validerer mot (`input_schema.safeParse()`, `gateway.ts`), ALDRI en egen,
 * potensielt avvikende kopi (samme "aldri en egen avvikende liste"-disiplin
 * som `getCapabilityStatus()` allerede fulgte for de 5 - se D-209/D-237).
 *
 * INGEN ny godkjenningssperre lagt til for klasse C/D her - undersøkt FØR
 * bygging (D-41-disiplin): `ua1-p1a-dclass-mesh.test.ts` beviser allerede at
 * et klasse D-mesh-kall for SOVEREIGN-eieren kjører hele D-pipelinen
 * (preflight → execute → readback → before/after-evidens → audit) UTEN et
 * eksplisitt godkjenningsobjekt, PRESIST slik D-41 (CLAUDE.md regel 12)
 * krever ("ingen kunstig godkjenningssperre for eier" for klasse D) - en NY
 * to-turns bekreftelsesmekanisme for samtaleflaten alene ville vært
 * nettopp den kunstige sperren regelen forbyr, OG en inkonsistens mellom
 * dashbord (utfører umiddelbart) og samtale (venter på bekreftelse) for
 * IDENTISK handling. Autorisasjon/D-pipeline/audit håndheves UENDRET,
 * UANSETT kallende flate - `MeshToolExecutor` går gjennom SAMME
 * `toolGateway.execute()` som dashbordets egne transportlag (§17).
 *
 * Verktøynavn er `${tool_id}__${action}` (dobbel understreking - `tool_id`
 * kan selv inneholde enkel understreking, f.eks. `finance_stripe`) - unikt
 * per konstruksjon (samme `Map`-nøkkel-invariant som `ToolGateway.register()`
 * selv bruker, `${tool_id}:${action}`). INGEN `parameters`-bygger-closure her
 * (i motsetning til `MESH_TOOLS`) - modellens rå argumenter går RETT til
 * `gateway.execute()`, validert DETERMINISTISK av `input_schema.safeParse()`
 * der (§17, CLAUDE.md regel 2 - aldri kun promptregler).
 */
/**
 * REMEDIERING DEL 1 (JARVIS-002): denne generatoren er IKKE lenger koblet til
 * noen aktiv modellflate (chat/tale/Telegram/executive). Den eksponerer hele
 * registeret og må ikke brukes som modellens verktøyliste før en deterministisk
 * autoritetsmodell (taint-gate, per-flate verktøysett, bekreftelse) finnes -
 * bruk `resolveModelToolSurface()` (`model-tool-surface.ts`).
 */
export function allMeshTools(gateway: ToolGateway): MeshToolMapping[] {
  return gateway.list().map((definition) => ({
    def: {
      name: `${definition.tool_id}__${definition.action}`,
      description: `[klasse ${definition.capability_class}] ${definition.description}`,
      input_schema: normalizeJsonSchemaBounds(
        zodToJsonSchema(definition.input_schema, { target: "openApi3" }) as Record<string, unknown>
      )
    },
    tool_id: definition.tool_id,
    action: definition.action
  }));
}

/**
 * D-344 (host-bevist, 2026-09-29: Anthropic sin `invalid_request_error`
 * PERSISTERTE UENDRET gjennom D-340/D-341/D-343, mens gemma_hosted sin
 * feilklasse skiftet fra `INVALID_ARGUMENT`-400 til `RESOURCE_EXHAUSTED`-429
 * (bevis på at D-343 sin fiks FAKTISK traff - samme skjema-inngang ellers
 * uendret): `zodToJsonSchema(...,{target:"openApi3"})` sin utdata er
 * OpenAPI-3.0-DIALEKT, IKKE gyldig JSON-Schema-draft-07+ - `.positive()`/
 * `.gt()`/`.negative()`/`.lt()` produserer `exclusiveMinimum: true` (BOOLSK
 * flagg) PLUSS en separat `minimum`-verdi, mens standard JSON Schema (som
 * Anthropic sin `input_schema` FAKTISK forventer, trent kunnskap - egress
 * til `docs.anthropic.com` BLOKKERT denne økten, SAMME D-297-forbehold,
 * IKKE denne-økten-verifisert) krever `exclusiveMinimum` som et TALL direkte
 * (`exclusiveMinimum: 0`, INGEN separat `minimum`-nøkkel). `gemini.ts`/
 * `gemma.ts` sin `sanitizeGeminiSchema()` (D-343) STRIPPER disse nøklene
 * fullstendig (riktig for Google, som ikke støtter grensen i NOEN form) -
 * MEN `anthropic.ts` (og `openai.ts`/`kimi.ts`/`local-llm.ts`/`ollama.ts`)
 * bruker `allMeshTools()` sin utdata RÅTT, UTEN sanering - de samme 9
 * finans-verktøyene (D-343) sender derfor et boolsk `exclusiveMinimum` til
 * en leverandør som forventer et TALL, en type-mismatch KVALITATIVT ULIK
 * D-343 sin Google-spesifikke "feltet finnes ikke i det hele tatt"-defekt.
 * Konverteres HER, FØR skjemaet forlater `allMeshTools()` (ÉN kilde til
 * sannhet for ALLE providere, ikke duplisert per adapter) - IKKE en
 * strip (som ville mistet den faktiske grensen for providere som STØTTER
 * standard JSON Schema), en KORREKT matematisk oversettelse:
 * `{minimum: X, exclusiveMinimum: true}` (OpenAPI 3.0, "verdi > X") blir
 * `{exclusiveMinimum: X}` (JSON Schema draft-07+, SAMME betydning).
 * `zodToJsonSchema` sin openApi3-modus bekreftet (offline `npx tsx`,
 * IKKE gjettet) å ALDRI sette det boolske flagget til `false` eksplisitt -
 * nøkkelen er enten fraværende (inklusiv `.min()`/`.max()`, UENDRET her) eller
 * `true` (eksklusiv) - ingen tredje gren å håndtere.
 */
export function normalizeJsonSchemaBounds(schema: unknown): Record<string, unknown> {
  if (Array.isArray(schema)) {
    return schema.map(normalizeJsonSchemaBounds) as unknown as Record<string, unknown>;
  }
  if (!schema || typeof schema !== "object") {
    return schema as Record<string, unknown>;
  }
  const obj = schema as Record<string, unknown>;
  const rest: Record<string, unknown> = { ...obj };
  if (rest["exclusiveMinimum"] === true && typeof rest["minimum"] === "number") {
    rest["exclusiveMinimum"] = rest["minimum"];
    delete rest["minimum"];
  }
  if (rest["exclusiveMaximum"] === true && typeof rest["maximum"] === "number") {
    rest["exclusiveMaximum"] = rest["maximum"];
    delete rest["maximum"];
  }
  for (const key of Object.keys(rest)) {
    rest[key] = normalizeJsonSchemaBounds(rest[key]);
  }
  return rest;
}

/**
 * Strukturelt kompatibel med ModelGateway.ToolExecutor. Resultatet trimmes før
 * det går tilbake til modellen - aldri credentials/intern metadata (§22).
 */
/** Identiteten trusted lag binder scope-felt fra (kun disse feltene leses). */
export interface BindableIdentity {
  tenant_id: string;
  person_id: string;
  memory_space_id?: string;
}

/** D-381: identitet vinner ALLTID over det modellen eventuelt har sendt i et scope-felt. */
export function bindScopeFields(
  parameters: Record<string, unknown>,
  fields: ReadonlyArray<string>,
  identity: BindableIdentity
): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...parameters };
  for (const f of fields) {
    if (f === "tenant_id") bound[f] = identity.tenant_id;
    else if (f === "memory_space" || f === "space") {
      if (identity.memory_space_id !== undefined) bound[f] = identity.memory_space_id;
    } else bound[f] = identity.person_id;
  }
  return bound;
}

/**
 * D-381: mesh-mappinger for chattens lese-nivå (`CHAT_READ_TIER`). Én mapping per allowlistet OG registrert par. Skjemaet modellen ser
 * har ALDRI identitets-/scope-felt (de fjernes og bindes i trusted lag, se `scope_bindings`). Kun lesing - se `assertChatReadTier()`.
 */
export function chatReadTierMeshTools(
  definitions: ReadonlyArray<ReturnType<ToolGateway["list"]>[number]>,
  allowlist: ReadonlyArray<{ readonly tool_id: string; readonly action: string }>,
  kind: "read" | "act" = "read"
): MeshToolMapping[] {
  const byKey = new Map(definitions.map((d) => [`${d.tool_id}.${d.action}`, d]));
  const out: MeshToolMapping[] = [];
  for (const a of allowlist) {
    const def = byKey.get(`${a.tool_id}.${a.action}`);
    if (!def) continue;
    const scope = scopeFieldsOf(def);
    const schema = normalizeJsonSchemaBounds(zodToJsonSchema(def.input_schema, { target: "openApi3" }) as Record<string, unknown>);
    if (scope.length > 0) {
      const props = { ...((schema["properties"] as Record<string, unknown> | undefined) ?? {}) };
      for (const f of scope) delete props[f];
      schema["properties"] = props;
      if (Array.isArray(schema["required"])) schema["required"] = (schema["required"] as string[]).filter((r) => !scope.includes(r));
    }
    out.push({
      def: {
        name: `${def.tool_id}__${def.action}`,
        description: kind === "act"
          ? `[HANDLING - utføres først når Tobias godkjenner bekreftelsen] ${def.description}`
          : `[lesing] ${def.description}`,
        input_schema: schema
      },
      tool_id: def.tool_id,
      action: def.action,
      kind,
      ...(scope.length > 0 ? { scope_bindings: scope } : {})
    });
  }
  return out;
}

/**
 * Del 3 (JARVIS-002/014): bekreftelsesport (strukturell grensesnitt - implementert av `ConfirmationStore` i @jarvis/core). Executoren bruker den
 * KUN i en tainted tur for handlinger som krever ny bekreftelse. Modellen når aldri denne porten.
 */
export interface ConfirmationGate {
  checkAndConsume(
    call: { tool_id: string; action: string; parameters: Record<string, JsonValue> },
    who: { tenant_id: string; person_id: string; device_id?: string | null; session_id?: string | null },
    taintReasons: string[]
  ): Promise<{ ok: true; confirmation_id: string } | { ok: false; reason: string; confirmation_id?: string }>;
}

export interface MeshToolGuards {
  /** Sentralt manifest. Et mappet verktøy uten manifest-oppføring feiler LUKKET. */
  manifest: ToolManifest;
  confirmations?: ConfirmationGate;
/** Del 3: delegert jobb - gatewayen håndhever kontraktens `allowed_tools` og eier-/tenant-identitet i tillegg til skjemafilteret. */
  jobContract?: JobContract;
}

export class MeshToolExecutor {
  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: unknown,
    // D-351 (Tobias direkte i chat, live: "ER MANGE FLERE EN DE" - Charlie
    // rapporterte kun ~16 connectorer fra `executive.get_connector_status`,
    // mens `CONNECTOR_REGISTRY` faktisk har 56+). Host-målt (denne økten,
    // `listConnectorStatus()` kjørt direkte mot den ekte registeret): FULL,
    // uforkortet serialisert status er 12 472 tegn - godt over den
    // FORRIGE flate 4000-tegns-grensen, som derfor kappet JSON-arrayet midt
    // i, uten at brukeren fikk noe tydelig varsel (kun et strukturelt
    // `truncated: true`-felt sammen med en RÅ, midt-i-arrayet avkappet
    // JSON-streng - ikke noe et menneske ville lest som "her mangler data").
    // 20 000 gir >60 % headroom over dagens fulle størrelse ETTERSOM
    // registeret vokser videre (nye connectorer legges jevnlig til) - gjelder
    // ALLE meshverktøy uniformt (samme grense brukes for ethvert kall), ikke
    // bare denne ene handlingen, siden andre datatunge lesinger (f.eks.
    // `list_messages` med mange e-poster) kan ramme SAMME bug-klasse.
    private readonly maxOutputChars = 20_000,
    /**
     * Default: kun A/B-read-verktøyene over. Tester/senere faser kan eksponere
     * flere mappinger - autorisasjon (inkl. D-pipeline) håndheves UANSETT i
     * Tool Gateway/Policy per kall, aldri av denne listen (§17).
     */
    private readonly tools: MeshToolMapping[] = MESH_TOOLS,
    /**
     * D-369: eierens RÅ melding i denne samtaleturen (trusted: kommer fra grant-autentisert chat, aldri fra modell/verktøy).
     * Brukes kun til den deterministiske `ownerStatesMemory()`-sjekken for `memory.propose`. Udefinert = aldri auto-godkjenning.
     */
    private readonly turn?: Pick<TurnContext, "user_message"> & Partial<Omit<TurnContext, "user_message">>,
    /** Del 3: manifest + bekreftelsesport. Uten `guards` oppfører executoren seg som før (kun for testhjelpere/legacy kallere). */
    private readonly guards?: MeshToolGuards
  ) {}

  /**
   * D-389: ethvert avslag/feil bærer en deterministisk forklaring (`output.message`) til modellen - hva som skjedde og hva Tobias kan
   * gjøre - så Charlie kan si det på vanlig norsk i stedet for å gjette eller prøve blindt på nytt. Kategorien er uendret.
   */
  private failure(
    call: ToolCallRequest,
    category: string,
    at: string,
    context: ToolFailureContext,
    execution_id = "none"
  ): ToolResultMessage {
    const explained = explainToolFailure(category, context);
    return {
      tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id,
      success: false, output: { ...explained }, error_category: category, at, trust: "internal",
      ...(context.tool_id && context.action ? { source: `${context.tool_id}.${context.action}` } : {})
    };
  }

  /** Tjenestene som faktisk finnes på turens flate (til «verktøyet finnes ikke»-forklaringen). */
  private availableServices(): string[] {
    const surface = this.turn?.surface;
    const granted = surface ? new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`)) : null;
    const ids = new Set<string>();
    for (const t of this.tools) if (!granted || granted.has(`${t.tool_id}.${t.action}`)) ids.add(t.tool_id);
    return [...ids].sort();
  }

  async execute(
    call: ToolCallRequest,
    ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
  ): Promise<ToolResultMessage> {
    const at = new Date().toISOString();
    const mapped = this.tools.find((t) => t.def.name === call.tool_name);
    if (!mapped) {
      return this.failure(call, "TOOL_NOT_FOUND", at, { ...(this.turn?.surface ? { surface: this.turn.surface } : {}), available_services: this.availableServices() });
    }
    let parameters = (mapped.parameters ? mapped.parameters(call.arguments) : call.arguments) as Record<string, unknown>;
    if (mapped.tool_id === "memory" && mapped.action === "propose") {
      // D-369: `owner_stated` settes HER i trusted lag (mappingen over kopierer aldri et slikt felt fra modell-args), og kun når
      // eierens egen melding uttrykkelig ba om det og dekker innholdet. Ellers (og alltid for modellens egne forslag): karantene.
      const { owner_stated: _ignored, ...rest } = parameters;
      void _ignored;
      parameters = ownerStatesMemory(this.turn?.user_message, String(rest["subject"] ?? ""), String(rest["content"] ?? ""))
        ? { ...rest, owner_stated: true }
        : rest;
    }
    if (mapped.scope_bindings && mapped.scope_bindings.length > 0) {
      parameters = bindScopeFields(parameters, mapped.scope_bindings, this.identity as BindableIdentity);
    }
    const key = `${mapped.tool_id}.${mapped.action}`;
    const turn = this.turn;
    const failCtx: ToolFailureContext = { tool_id: mapped.tool_id, action: mapped.action, ...(turn?.surface ? { surface: turn.surface } : {}) };
    // 1. Hard flate-allowlist (forsvar i dybden - utvalget skal allerede ha filtrert): et verktøy utenfor flaten utføres ALDRI.
    if (turn?.surface && !SURFACE_TOOL_GRANTS[turn.surface].some((g) => `${g.tool_id}.${g.action}` === key)) {
      return this.failure(call, "TOOL_NOT_ON_SURFACE", at, failCtx);
    }
    // 2. Kallgrenser per tur (JARVIS-028): aldri ubegrenset verktøy-fan-out.
    if (turn?.limits && turn.calls) {
      if (turn.calls.total >= turn.limits.max_total_calls) {
        return this.failure(call, "TOOL_CALL_LIMIT", at, failCtx);
      }
      turn.calls.total += 1;
    }
    // 3. Manifest + taint-port: i en tainted tur krever C/D og utgående/betalt/ekstern skriving en NY, bundet eier-bekreftelse.
    if (this.guards) {
      const entry = this.guards.manifest.get(key);
      if (!entry) {
        return this.failure(call, "TOOL_NOT_IN_MANIFEST", at, failCtx);
      }
      // D-382: handlingsnivået krever ALLTID eierens bundne bekreftelse (ikke bare i en tainted tur) - godkjenningen utfører kallet
      // i trusted lag (/confirmations), så modellen skal aldri kalle verktøyet på nytt.
      const isAct = CHAT_ACT_TIER_KEYS.has(key);
      const taintedNeeds = turn?.taint?.tainted === true && requiresConfirmationWhenTainted(entry);
      if (isAct || taintedNeeds) {
        const gate = this.guards.confirmations;
        const identity = this.identity as { tenant_id: string; person_id: string; device_id?: string; session_id?: string };
        const reasons = [...(turn?.taint?.reasons ?? []), ...(isAct ? ["owner_action_tier"] : [])];
        const check = gate
          ? await gate.checkAndConsume({ tool_id: mapped.tool_id, action: mapped.action, parameters: parameters as Record<string, JsonValue> }, identity, reasons)
          : ({ ok: false, reason: "confirmation_unavailable" } as { ok: false; reason: string; confirmation_id?: string });
        if (!check.ok) {
          return {
            tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
            success: false,
            output: {
              confirmation_required: true,
              confirmation_id: check.confirmation_id ?? null,
              status: check.reason,
              message: check.reason === "confirmation_rejected"
                ? "Tobias avviste denne handlingen. Ikke prøv igjen - spør hva han vil i stedet."
                : "Handlingen er lagt til bekreftelse. Forklar Tobias kort hva som vil skje og be ham godkjenne (knapp i chatten/dashbordet). Når han godkjenner, utføres handlingen automatisk - kall IKKE verktøyet på nytt."
            },
            error_category: check.reason.toUpperCase(), at, trust: "internal", source: key
          };
        }
      }
    }
    const result = await this.toolGateway.execute({
      identity: this.identity as never,
      tool_id: mapped.tool_id,
      action: mapped.action,
      parameters: parameters as never,
      idempotency_key: ctx.idempotency_key,
      ...(this.guards?.jobContract ? { jobContract: this.guards.jobContract } : {}),
      // D-317: `call.provider`/`.model` er stemplet av selve adapteren som genererte
      // DENNE turen (se ToolCallRequest sitt filhode i provider-adapters) - ALDRI fra
      // modell-oppgitte argumenter, SAMME trusted-lag-kanal som identity/approval.
      servingModel: { provider: call.provider, model: call.model }
    });
    if (!result.ok) {
      return this.failure(call, result.reason, at, failCtx, ctx.idempotency_key);
    }
    let output: unknown = result.data ?? null;
    const serialized = JSON.stringify(output);
    let truncated = false;
    if (serialized && serialized.length > this.maxOutputChars) {
      output = { truncated: true, preview: serialized.slice(0, this.maxOutputChars) };
      truncated = true;
    }
    // Del 3: tillit bevares fra verktøydefinisjonen (aldri fra modellen), og ubetrodd output TAINTER turen deterministisk.
    if (result.output_trust === "untrusted") turn?.taint?.mark(`untrusted_output:${key}`);
    return {
      tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: ctx.idempotency_key,
      success: true, output, at,
      trust: result.output_trust, source: key, bounds: { truncated, max_chars: this.maxOutputChars }
    };
  }
}

/**
 * Del 3 (JARVIS-005/012): skjemaene en delegert jobb får se = kun mappinger kontrakten eksplisitt tillater (`tool_id` eller
 * `tool_id.action`) OG som bakgrunnsflaten har tildelt. Samme regel håndheves igjen ved utførelse (gateway + executor).
 */
export function filterMeshToolsForJob(mappings: ReadonlyArray<MeshToolMapping>, contract: Pick<JobContract, "allowed_tools">): MeshToolMapping[] {
  const granted = new Set(SURFACE_TOOL_GRANTS.background.map((g) => `${g.tool_id}.${g.action}`));
  return mappings.filter((m) => granted.has(`${m.tool_id}.${m.action}`) && jobContractAllows(contract.allowed_tools, m.tool_id, m.action));
}
