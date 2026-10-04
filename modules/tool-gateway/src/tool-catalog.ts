import type { MeshToolMapping } from "./mesh-bridge.ts";
import { SURFACE_TOOL_GRANTS, type Surface } from "./tool-manifest.ts";

/**
 * D-383: kompakt katalog over tjenestene modellen FAKTISK kan bruke på en flate - settes inn i systemprompten på hver tur, slik at
 * Charlie alltid vet hva som finnes (og hva som ikke finnes) selv om bare et lite utvalg verktøyskjema er vedlagt denne runden.
 * Bygges fra de samme mappingene som utførelsen bruker (aldri en egen liste som kan avvike). Norske etiketter er kun kosmetikk.
 */
const LABELS: Readonly<Record<string, string>> = {
  email: "e-post (Gmail)", calendar: "kalender", github: "GitHub", memory: "minne", executive: "egen status/kapabiliteter",
  finance_neonomics: "bank (Neonomics: samtykker, kontoer, saldo, transaksjoner)", finance_stripe: "Stripe", finance_vipps: "Vipps",
  finance_wallester: "Wallester-kort", finance_spend: "utgifter/abonnementer", business: "forretningsregister (selskaper, kontakter, leads, åpne saker)",
  contract: "kontrakter", support: "support/billetter", operations: "drift (leverandører, runbooks, oppgaver)", product: "produkt",
  growth: "kampanjer/vekst", googleads: "Google Ads", metaads: "Meta Ads", notion: "Notion", slack: "Slack", discord: "Discord",
  telegram: "Telegram (varsle Tobias)", drive: "Google Drive", dropbox: "Dropbox", onedrive: "OneDrive", google_sheets: "Google Sheets",
  microsoft_outlook: "Outlook", todoist: "Todoist", trello: "Trello", jira: "Jira", linear: "Linear", hubspot: "HubSpot", pipedrive: "Pipedrive",
  brave_search: "nettsøk (Brave)", tavily: "nettsøk (Tavily)", exa: "nettsøk (Exa)", google_maps: "kart", google_places: "steder",
  google_routes: "ruter/kjøretid", spotify: "Spotify", vercel: "Vercel", sentry: "Sentry", grafana: "Grafana", prometheus: "Prometheus",
  n8n: "n8n (arbeidsflyter)", make: "Make (scenarioer)", twilio: "Twilio (SMS)", telnyx: "Telnyx (SMS/telefoni)", whatsapp: "WhatsApp",
  conversation_graph: "samtalegraf/identiteter (hvem er hvem på tvers av kanaler)", sentry_issues: "Sentry",
  // D-389
  "home-assistant": "hjemmet (Home Assistant: lys, varme, låser, alarm, sensorer per rom)", gce: "servere (Google Compute Engine)",
  docker: "Docker-containere", browser: "nettleser (lokal automatisering)", mcp_zapier: "Zapier (MCP)"
};

/**
 * D-389: hverdagsnorske stikkord per tjeneste - vises i katalogen slik at Charlie kjenner igjen hva Tobias mener («lysene i stua» → hjemmet)
 * uten at tjenestenavnet må nevnes. Kun kosmetikk for prompten; selve utvalget skjer deterministisk i `selectSurfaceTools`.
 */
const HINTS: Readonly<Record<string, string>> = {
  "home-assistant": "lys/varme/lås/alarm per rom", calendar: "møter, avtaler, i dag/i morgen", email: "innboks, vedlegg",
  todoist: "gjøremål, huskeliste", github: "issues, PR-er, workflows", vercel: "utrulling, miljøvariabler", n8n: "arbeidsflyter av/på",
  business: "selskaper, leads, åpne saker, brief", contract: "kontrakter, frister, fornyelser", support: "billetter/henvendelser",
  operations: "leverandører, runbooks, driftsoppgaver", finance_neonomics: "saldo, transaksjoner (kun lokal modell)",
  finance_spend: "utgifter, abonnementer", brave_search: "nettsøk, nyheter", google_routes: "kjøretid, rute", spotify: "musikk, kø"
};

export interface SurfaceCatalog {
  /** Sortert per tjeneste: antall lese-handlinger og handlinger som endrer noe. */
  services: Array<{ tool_id: string; label: string; reads: number; acts: number; hint?: string }>;
  text: string;
}

/** Menneskelig etikett for en tjeneste-id (brukes også i feilforklaringer til modellen, se `explainToolFailure`). */
export function serviceLabel(tool_id: string): string {
  return LABELS[tool_id] ?? tool_id.replace(/[_-]/g, " ");
}

export function describeSurfaceCatalog(mappings: ReadonlyArray<MeshToolMapping>, surface: Surface): SurfaceCatalog {
  const granted = new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`));
  const byTool = new Map<string, { reads: number; acts: number }>();
  for (const m of mappings) {
    if (!granted.has(`${m.tool_id}.${m.action}`)) continue;
    const entry = byTool.get(m.tool_id) ?? { reads: 0, acts: 0 };
    if (m.kind === "act") entry.acts += 1;
    else entry.reads += 1;
    byTool.set(m.tool_id, entry);
  }
  const services = [...byTool.entries()]
    .map(([tool_id, c]) => ({ tool_id, label: serviceLabel(tool_id), ...c, ...(HINTS[tool_id] ? { hint: HINTS[tool_id] } : {}) }))
    .sort((a, b) => a.label.localeCompare(b.label, "nb"));
  const line = (s: SurfaceCatalog["services"][number]) =>
    `${s.label}${s.hint ? ` [${s.hint}]` : ""}${s.acts > 0 ? " (lese + handle)" : " (kun lese)"}`;
  const text = services.length === 0 ? "" : services.map(line).join("; ");
  return { services, text };
}
