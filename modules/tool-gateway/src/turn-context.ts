import type { MeshToolMapping } from "./mesh-bridge.ts";
import {
  SURFACE_LIMITS,
  SURFACE_TOOL_GRANTS,
  estimateSchemaTokens,
  type Surface,
  type SurfaceLimits
} from "./tool-manifest.ts";

/**
 * Del 3 (JARVIS-002/014/028): tilstand for ÉN samtaletur, eid av trusted lag (aldri modellen).
 *   - `taint`: settes når beslutningsgrunnlaget inneholder ubetrodd materiale (ubetrodd verktøyoutput, upålitelig kanal).
 *   - tellere + grenser per flate (kall per runde / totalt).
 * Taint kan bare gå EN vei innen en tur: en gang tainted, alltid tainted. Den er ikke en del av `IdentityContext` (som er .strict()).
 */
export class TurnTaint {
  private readonly reasonSet = new Set<string>();
  get tainted(): boolean {
    return this.reasonSet.size > 0;
  }
  get reasons(): string[] {
    return [...this.reasonSet];
  }
  mark(reason: string): void {
    this.reasonSet.add(reason);
  }
}

export interface TurnContext {
  /** Eierens RÅ melding (redigert for hemmeligheter) - trusted: kommer fra grant-autentisert kanal, aldri fra modell/verktøy. */
  user_message: string;
  surface: Surface;
  taint: TurnTaint;
  limits: SurfaceLimits;
  /** Samlede verktøykall så langt i turen. */
  calls: { total: number };
}

/** Kanaler der selve inputen er upålitelig fra første stund (tale-transkripsjon: STT-feil, omgivelser, andres stemmer). */
const UNTRUSTED_INPUT_SURFACES: ReadonlySet<Surface> = new Set(["voice"]);

export function createTurnContext(surface: Surface, userMessage: string): TurnContext {
  const taint = new TurnTaint();
  if (UNTRUSTED_INPUT_SURFACES.has(surface)) taint.mark(`untrusted_input:${surface}`);
  return { user_message: userMessage, surface, taint, limits: SURFACE_LIMITS[surface], calls: { total: 0 } };
}

/** Intensjons-nøkkelord per handling. Kun handlinger som er tildelt flaten kan velges - dette er IKKE en autorisasjon, bare utvalg. */
const INTENT_KEYWORDS: Readonly<Record<string, RegExp>> = {
  "email.read_inbox": /(e-?post|\bmail\b|innboks|inbox|melding|brev)/i,
  "calendar.read_events": /(kalender|møte|avtale|timeplan|calendar|schedule|\bi dag\b|dagens|\bi morgen\b)/i,
  "github.read_issues": /(github|issue|repo\b|pull request|\bpr\b|\bbug\b|kodebase)/i,
  "executive.get_capability_status": /(status|tilkobl|connector|kapabilitet|integrasjon|hva kan du|hva er koblet)/i,
  "memory.search": /(husker|husk\b|minne|sa jeg|nevnte|forrige|tidligere|hva heter|hvem er|vet du|fortalte)/i,
  "memory.propose": /(husk\b|ikke glem|lagre|noter|ta vare|remember|foreslå)/i
};
/**
 * D-381: intensjonsord per verktøy-id for chattens lese-nivå (norsk + engelsk). Kun UTVALG (hva modellen får se denne runden) - aldri
 * autorisasjon; hele nivået er allerede låst av `SURFACE_TOOL_GRANTS`. Uten oppføring brukes selve verktøy-id-en som nøkkelord.
 * D-389: dekker ALLE tjenester på chat-nivåene (også hjemmet, n8n/Make, Jira/Linear/Trello, HubSpot/Pipedrive, Sentry/Grafana/
 * Prometheus, Telnyx, drift/produkt/samtalegraf) med norske hverdagsord - Tobias skal slippe å kjenne tjenestenavnet.
 */
const TOOL_INTENTS: Readonly<Record<string, RegExp>> = {
  finance_neonomics: /(bank|konto|saldo|neonomics|transaksjon|samtykke|kontoutskrift|innskudd|uttak)/i,
  finance_stripe: /(stripe|kortbetaling|refusjon)/i,
  finance_vipps: /(vipps)/i,
  finance_wallester: /(wallester|bankkort|\bkort\b|kortbruk)/i,
  finance_spend: /(utgift|abonnement|innkjøp|forbruk|\bspend\b|faste kostnader|budsjett|\bkostnad)/i,
  notion: /(notion|notat(er|ene)?\b|wiki)/i,
  slack: /(slack|kanal(en|er|ene)?\b)/i,
  discord: /(discord)/i,
  telegram: /(telegram)/i,
  drive: /(drive|dokument|\bfil(er|ene)?\b|google docs|mappe)/i,
  dropbox: /(dropbox)/i,
  onedrive: /(onedrive|one drive)/i,
  google_sheets: /(sheets|regneark|arket\b|spreadsheet)/i,
  microsoft_outlook: /(outlook|microsoft.?mail)/i,
  todoist: /(todoist|gjøremål|oppgaveliste|to-?do|huskeliste|handleliste)/i,
  trello: /(trello|\bkort(et|ene)?\b.*(board|tavle)|tavle(n|ne)?\b|board)/i,
  jira: /(jira|\bsak(er|ene)?\b|sprint|backlog|epic)/i,
  linear: /(linear\b|\bsak(er|ene)?\b|backlog)/i,
  hubspot: /(hubspot|\bcrm\b|kontakt(er|ene)?\b|\blead(s|en|ene)?\b|\bdeal(s|en|ene)?\b)/i,
  pipedrive: /(pipedrive|\bcrm\b|pipeline|\bdeal(s|en|ene)?\b|salgsmulighet)/i,
  contract: /(kontrakt|avtaler\b|fornyelse|oppsigelse|forpliktelse|bindingstid)/i,
  support: /(support|billett|ticket|kundehenvendelse|kundesak|henvendelse)/i,
  business: /(forretning|selskap|bedrift|åpne saker|oppfølging|metrikk|\blead(s|en|ene)?\b|mulighet(er|ene)?\b|brief)/i,
  operations: /(drift|leverandør|runbook|driftsoppgave|vedlikehold)/i,
  product: /(produkt(et|er|ene)?\b|feature|funksjon(er|ene)?\b|roadmap)/i,
  conversation_graph: /(samtalegraf|hvem er .* (på|i) (slack|discord|telegram|e-?post)|identitet|kanalkobling|på tvers av kanal)/i,
  growth: /(kampanje|markedsføring|vekst|eksperiment|attribusjon|annonse)/i,
  googleads: /(google ?ads|annonse)/i,
  metaads: /(meta ?ads|facebook|instagram|annonse)/i,
  vercel: /(vercel|utrulling|deploy|produksjon(en)?\b|nettsiden|miljøvariab)/i,
  sentry: /(sentry|feillogg|exception|krasj|feil i (appen|produksjon)|stack ?trace)/i,
  grafana: /(grafana|dashbord(et|ene)?\b|dashboard)/i,
  prometheus: /(prometheus|metrikk|\bcpu\b|minnebruk|\bpromql\b|belastning)/i,
  n8n: /(n8n|arbeidsflyt|workflow|automasjon|automatisering)/i,
  make: /(\bmake\b|scenario|automasjon|automatisering|integromat)/i,
  github: /(github|issue|repo\b|pull request|\bpr\b|\bbug\b|kodebase|commit|branch|workflow run|\bci\b|pipeline)/i,
  calendar: /(kalender|møte|avtale|timeplan|calendar|schedule|\bi dag\b|dagens|\bi morgen\b|neste uke|opptatt|ledig)/i,
  email: /(e-?post|\bmail\b|innboks|inbox|melding fra|brev|vedlegg|epost)/i,
  brave_search: /(søk (på )?nett|nettsøk|websøk|google|nyheter|brave|slå opp|finn ut|hva er siste)/i,
  tavily: /(tavily|søk (på )?nett|nettsøk|nyheter|slå opp)/i,
  exa: /(\bexa\b|lignende sider|finn lignende|nettsøk)/i,
  google_maps: /(kart|adresse|koordinat|hvor ligger)/i,
  google_places: /(\bsted(er)?\b|restaurant|butikk|åpningstid|kafé|cafe|i nærheten)/i,
  google_routes: /(rute|veibeskrivelse|kjøretid|avstand|hvor lang tid.*(kjøre|dit))/i,
  spotify: /(spotify|musikk|spilles|spill (av )?|sang|låt|spilleliste|playlist)/i,
  twilio: /(twilio|\bsms\b)/i,
  telnyx: /(telnyx|\bsms\b|telefoni)/i,
  whatsapp: /(whatsapp)/i,
  "home-assistant": /(home ?assistant|hjemme(t|ts)?\b|huset|lys(et|ene)?\b|lampe|varme(n)?\b|termostat|temperatur|grader|lås(en|e|t)?\b|døra|døren|alarm(en)?\b|stua|stuen|soverom|kjøkken|gang(en)?\b|\brom(met|mene)?\b|sensor|enhet(er|ene)?\b)/i
};
/**
 * D-389: eksplisitt tjenestenavn i meldingen → hele tjenesten prioriteres innenfor budsjettet (foran tilfeldige ordtreff), så
 * «vis jira-sakene» aldri fortrenges av at «sak» også treffer Linear. Kun navn, aldri generiske ord.
 */
const SERVICE_NAMES: Readonly<Record<string, RegExp>> = {
  finance_neonomics: /neonomics/i, finance_stripe: /stripe/i, finance_vipps: /vipps/i, finance_wallester: /wallester/i,
  notion: /notion/i, slack: /slack/i, discord: /discord/i, telegram: /telegram/i, drive: /\bdrive\b|google docs/i, dropbox: /dropbox/i,
  onedrive: /onedrive|one drive/i, google_sheets: /sheets|regneark/i, microsoft_outlook: /outlook/i, todoist: /todoist/i, trello: /trello/i,
  jira: /jira/i, linear: /\blinear\b/i, hubspot: /hubspot/i, pipedrive: /pipedrive/i, vercel: /vercel/i, sentry: /sentry/i, grafana: /grafana/i,
  prometheus: /prometheus/i, n8n: /n8n/i, make: /\bmake\b|integromat/i, github: /github/i, calendar: /kalender|calendar/i,
  email: /e-?post|gmail|innboks|inbox/i, brave_search: /brave/i, tavily: /tavily/i, exa: /\bexa\b/i, google_maps: /google maps|\bkart\b/i,
  spotify: /spotify/i, twilio: /twilio/i, telnyx: /telnyx/i, whatsapp: /whatsapp/i, "home-assistant": /home ?assistant/i
};
export function namedServices(text: string): Set<string> {
  const out = new Set<string>();
  for (const [tool_id, re] of Object.entries(SERVICE_NAMES)) if (re.test(text)) out.add(tool_id);
  return out;
}
const GENERIC_SKIP = new Set(["finance", "google", "conversation", "graph", "openai"]);
const toolIntentCache = new Map<string, RegExp | null>();
function toolIntent(tool_id: string): RegExp | null {
  const known = TOOL_INTENTS[tool_id];
  if (known) return known;
  let cached = toolIntentCache.get(tool_id);
  if (cached === undefined) {
    const words = tool_id.split("_").filter((w) => w.length >= 4 && !GENERIC_SKIP.has(w));
    cached = words.length > 0 ? new RegExp(`(${words.join("|")})`, "i") : null;
    toolIntentCache.set(tool_id, cached);
  }
  return cached;
}
/** D-382: handlingsnivået velges kun når meldingen uttrykker en handling (ikke bare nevner tjenesten). */
const ACTION_VERBS = /(send|sende|opprett|lag\b|lage|legg (til|inn)|oppdater|endre|flytt|slett|fjern|arkiver|lukk|åpne? (igjen|på nytt)|svar\b|svare|synk|synkroniser|book|bestill|sett\b|registrer|fullfør|marker|tildel|eskaler|avbryt|kanseller|pause|gjenoppta|aktiver|deaktiver|kommenter|publiser|kjør|start|stopp|create|update|add|move|delete|remove|reply|sync|close|assign|schedule|post|slå (på|av)|skru (på|av|opp|ned)|tenn|slukk|slokk|dimm|lås (opp|døra|døren)|lås\b|spill (av )?|sett på|legg (i|til) kø|rull tilbake|promoter)/i;
/** D-382: handlingsord → handlingsnavn-prefiks, så den handlingen eieren faktisk ber om rangeres først innenfor budsjettet. */
const VERB_TO_ACTION: ReadonlyArray<[RegExp, RegExp]> = [
  [/synk|synkroniser|sync|avstem/i, /^(sync|reconcile)/],
  [/opprett|lag\b|lage|legg (til|inn)|registrer|create|add|book|bestill|ny\b/i, /^(create|add|append|record|register|ingest)/],
  [/oppdater|endre|sett\b|update|set\b|marker|tildel|assign|link/i, /^(update|set|assign|link|transition|rename)/],
  [/slett|fjern|arkiver|delete|remove|trash|papirkurv/i, /^(trash|delete|remove|archive)/],
  [/send|svar|kommenter|notify|reply|post|varsle|si fra/i, /^(notify|send|reply|comment|publish|dispatch)/],
  [/lukk|fullfør|close|complete|ferdig/i, /^(close|complete)/],
  [/åpne? (igjen|på nytt)|reopen|gjenoppta|resume/i, /^(reopen|resume)/],
  [/flytt|move/i, /^move/],
  [/pause|avbryt|kanseller|cancel|stopp/i, /^(pause|cancel|defer)/],
  [/eskaler|escalate/i, /^escalate/],
  [/aktiver|activate|kjør|run|start/i, /^(activate|run|rerun|start)/],
  [/deaktiver|deactivate|skru av|slå av/i, /^(deactivate|disable)/],
  // D-389: hjemmet (lys/varme/lås/alarm), musikk og utrulling.
  [/slå (på|av)|skru (på|av|opp|ned)|tenn|slukk|slokk|dimm|lys|varme|grader|termostat/i, /^(light_set|climate_set)/],
  [/lås/i, /^lock_set/],
  [/alarm/i, /^alarm_set/],
  [/spill|sett på|legg (i|til) kø|musikk/i, /^(add_to_queue|play)/],
  [/rull tilbake|rollback|promoter|promote/i, /^(rollback|promote)/]
];
function verbMatches(action: string, text: string): boolean {
  return VERB_TO_ACTION.some(([verb, prefix]) => verb.test(text) && prefix.test(action));
}
/** Finans-verktøy (`finance_*`) gjør turen SECRET_RESTRICTED (D-378: kun lokal modell) - uavhengig av hvordan meldingen er formulert. */
const RESTRICTED_TOOL_ID = /^finance(_|$)/;

const OVERVIEW = /(oversikt|hva skjer|brief|morgenbrief|hva har jeg)/i;
const OVERVIEW_KEYS = new Set(["email.read_inbox", "calendar.read_events", "github.read_issues"]);
const ALWAYS_PRIORITY = ["memory.search", "email.read_inbox", "calendar.read_events", "github.read_issues", "executive.get_capability_status", "memory.propose"];

export interface SurfaceSelection {
  selected: MeshToolMapping[];
  /** Estimert skjema-tokens for det valgte settet. */
  schema_tokens: number;
  limits: SurfaceLimits;
  /** Handlinger som ble felt bort av utvalg/grenser (diagnostikk). */
  dropped: string[];
  /** D-381: laveste sensitivitet turen MÅ ha fordi verktøyene som ble valgt eksponerer data i den klassen. */
  min_sensitivity?: "SECRET_RESTRICTED";
}

const mappingKey = (m: MeshToolMapping) => `${m.tool_id}.${m.action}`;

/** D-389: valgfri samtalekontekst for utvalget (kun eierens egne, nylige meldinger - aldri modell-/verktøytekst). */
export interface SelectionOptions {
  /**
   * Eierens siste meldinger FØR denne (nyeste sist). Tjenesten de nevnte følger med inn i denne turen, så «og den første, hva står i
   * den?» etter «vis jira-sakene» fortsatt får Jira-verktøyene. Handlingsord telles KUN fra den gjeldende meldingen (D-382).
   */
  recent_owner_messages?: ReadonlyArray<string>;
}

/**
 * Deterministisk, per-flate verktøyutvalg (INGEN LLM): 1) HARD allowlist for flaten (alt utenfor feller utvalget lukket),
 * 2) intensjonsutvalg på brukerens tekst (kun relevante verktøy, ikke hele settet), 3) grenser (antall + skjema-tokens).
 * Uten treff velges kun det billigste generelle verktøyet (`memory.search`) hvis flaten har det.
 * D-389: tjenester som er nevnt ved navn prioriteres foran tilfeldige ordtreff; tjenester fra eierens forrige meldinger følger med
 * (lavere prioritet) når den gjeldende meldingen selv ikke peker på noe.
 */
export function selectSurfaceTools(
  surface: Surface,
  text: string,
  candidates: ReadonlyArray<MeshToolMapping>,
  options: SelectionOptions = {}
): SurfaceSelection {
  const limits = SURFACE_LIMITS[surface];
  const granted = new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`));
  const allowed = candidates.filter((m) => granted.has(mappingKey(m)));
  const overview = OVERVIEW.test(text);
  const wantsAction = ACTION_VERBS.test(text);
  const named = namedServices(text);
  const recent = (options.recent_owner_messages ?? []).slice(-3).join("\n");
  const hitFor = (m: MeshToolMapping, t: string): boolean => {
    const key = mappingKey(m);
    const intent = INTENT_KEYWORDS[key] ?? toolIntent(m.tool_id);
    return (intent?.test(t) ?? false) || (overview && OVERVIEW_KEYS.has(key));
  };
  const direct = new Set<string>();
  let wanted = allowed.filter((m) => {
    const hit = hitFor(m, text);
    if (hit) direct.add(m.tool_id);
    // D-382: handlinger kun når eieren faktisk ber om en handling - ellers kun lesing.
    return m.kind === "act" ? hit && wantsAction : hit;
  });
  // D-389: oppfølgingsspørsmål uten tjenesteord arver tjenesten(e) fra eierens forrige meldinger (kun lesing + handling ved handlingsord).
  const carried = new Set<string>();
  if (recent.length > 0) {
    for (const m of allowed) {
      if (direct.has(m.tool_id) || m.tool_id === "memory") continue;
      if (!hitFor(m, recent)) continue;
      if (m.kind === "act" && !wantsAction) continue;
      carried.add(m.tool_id);
      wanted.push(m);
    }
  }
  if (wanted.length === 0) wanted = allowed.filter((m) => mappingKey(m) === "memory.search");
  // Rangering innenfor budsjettet: faste prioriteter → navngitt tjeneste → handlingen eieren ba om (verbtreff) → lesinger → øvrige
  // handlinger → arvet kontekst.
  const rank = (m: MeshToolMapping): number => {
    const i = ALWAYS_PRIORITY.indexOf(mappingKey(m));
    if (i !== -1) return i;
    const base = m.kind === "act" ? (verbMatches(m.action, text) ? 10 : 30) : 20;
    if (named.has(m.tool_id)) return base - 5;
    if (carried.has(m.tool_id)) return base + 15;
    return base;
  };
  wanted.sort((a, b) => rank(a) - rank(b));

  const selected: MeshToolMapping[] = [];
  const dropped: string[] = allowed.filter((m) => !wanted.includes(m)).map(mappingKey);
  let tokens = 0;
  for (const m of wanted) {
    const cost = estimateSchemaTokens(m.def);
    if (selected.length >= limits.max_tools_per_round || tokens + cost > limits.max_schema_tokens) {
      dropped.push(mappingKey(m));
      continue;
    }
    selected.push(m);
    tokens += cost;
  }
  // Hard allowlist ETTER utvalget: aldri et verktøy utenfor flaten (forsvar mot en fremtidig utvalgsfeil).
  for (const m of selected) {
    if (!granted.has(mappingKey(m))) throw new Error(`surface_selection_violation:${surface}:${mappingKey(m)}`);
  }
  const restricted = selected.some((m) => RESTRICTED_TOOL_ID.test(m.tool_id));
  return { selected, schema_tokens: tokens, limits, dropped, ...(restricted ? { min_sensitivity: "SECRET_RESTRICTED" as const } : {}) };
}

const JOB_MEMORY_SPACES = ["personal", "business", "project", "health", "home", "guest", "shared"] as const;

/**
 * Del 3 (JARVIS-005/012): identiteten en delegert jobb handler med kommer fra den SIGNERTE kontrakten (som `TaskService.submit` har
 * bundet til den grant-autentiserte personen/tenanten) - aldri en fast worker-/system-identitet og aldri modellargumenter.
 * Memory space = kontraktens første tillatte rom (ellers `project`); `session_id` er unikt per jobb.
 */
export function jobIdentityFor<T extends { memory_space_id: string; session_id: string; person_id: string; tenant_id: string }>(
  base: T,
  contract: { owner_person_id: string; tenant_id: string; task_id: string; allowed_memory_spaces: readonly string[] }
): T {
  const space = contract.allowed_memory_spaces.find((s): s is (typeof JOB_MEMORY_SPACES)[number] => (JOB_MEMORY_SPACES as readonly string[]).includes(s));
  return {
    ...base,
    person_id: contract.owner_person_id,
    tenant_id: contract.tenant_id,
    memory_space_id: space ?? "project",
    session_id: `job:${contract.task_id}`
  };
}
