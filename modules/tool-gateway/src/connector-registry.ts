import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "./gateway.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): kanonisk, eier-vendt liste over
 * hver leverandør-tilkobling `docs/INTEGRATIONS.md` (§3 "første bølge") og de
 * allerede bygde finans-connectorene (`.env.example`) nevner. RENT DATA -
 * ingen egen kallelogikk her utover selve statuskomposisjonen under.
 *
 * Task #122 (D-213) utvidet `live_test` til 8 av 14 connectorer - GitHub/
 * Calendar/Gmail (D-211, uendret) + Google Drive/Vercel/Telegram/Neonomics/
 * Wallester (nye, hver en allerede eksisterende, verifisert klasse A/
 * side-effektfri lesehandling gjennom `ToolGateway` - Telegrams
 * `get_bot_info` (`getMe`) ble lagt til AKKURAT for dette formålet, siden
 * `telegram.notify` sender en EKTE melding og derfor aldri kunne vært en
 * trygg test).
 *
 * D-242 (2026-09-22, Tobias direkte chat-instruks: "du skal bygge det for
 * absolutt alle som tester en gang om dagen så vi vet om credentials
 * fungerer eller ikke hele tiden") utvidet `live_test` videre til 11 av 14
 * - `vercel` fikk ENDELIG en ekte transport (`live-transports.ts` sin
 * `VercelTransport` - `live_test` eksisterte siden D-213, men falt HELE
 * TIDEN gjennom til `UnconfiguredHttpTransport` fordi `main.ts`/
 * `worker-main.ts` aldri koblet inn en ekte transport, se doc-kommentaren
 * der for full begrunnelse), og Fiken/Stripe/Vipps fikk hver sin NYE, trygge
 * klasse A-probe (`finance.list_companies`/`finance_stripe.get_balance`/
 * `finance_vipps.check_credentials` - alle GET/token-sjekk-baserte, INGEN
 * mutasjon, se `service.ts` sine `listFikenCompanies()`/`getStripeBalance()`/
 * `checkVippsCredentials()`-doc-kommentarer). En ny `ConnectorHealthSweep`
 * (`connector-health-sweep.ts`) kjører NÅ `test_connector`-EKVIVALENTE kall
 * mot HVER av disse 11 daglig via `DailyScheduler` (`main.ts`), slik at
 * `ToolGateway.health` (BO-03, allerede lest av `listConnectorStatus()`
 * under) er FRISK selv for en connector ingen annen reell trafikk nylig
 * brukte - IKKE et nytt persisteringslag, gjenbruker BEVISST den samme
 * BO-03-mekanismen `test_connector` allerede skriver til, samme "ett sted
 * eier helsetilstanden"-disiplin. **BEVISST FORTSATT presence_only, eksplisitt
 * avgrenset:** Anthropic/OpenAI/Gemini konsumeres via `ModelGateway`, en
 * HELT ANNEN kallevei enn `ToolGateway` (ingen tool_id/action finnes for
 * dem) - et "test denne modell-nøkkelen"-probe hører hjemme i
 * `ModelGateway` selv, ikke tvunget inn i dette connector-test-mønsteret;
 * dette er en EGEN, senere oppgave, ikke gjettet frem her.
 *
 * D-232 (2026-09-22, Tobias direkte chat-instruks: "Legg de til i dashbordet
 * selv om de ikke er klare for tilkobling så de er der"): la til de 50
 * `NY_BACKLOG`-punktene fra D-231/`docs/INTEGRATIONS.md` §4 som SYNLIGE, men
 * strukturelt "ikke bygget"-oppføringer - `category: "backlog"` (44 stk) og
 * `category: "backlog_d64_gate"` (de seks D-64-port-krevende CRM-/
 * prosjektstyrings-leverandørene: HubSpot/Pipedrive/Linear/Jira/Trello/
 * Todoist, jf. CLAUDE.md regel 12/D-64 sitt eget Zendesk-eksempel) er to NYE
 * `category`-verdier, bevisst adskilt fra de fire ekte, bygde kategoriene
 * over - `listConnectorStatus()`/dashboardet trenger INGEN kodeendring for
 * dette (kategorien rendres allerede som en ren `escapeHtml(c.category)`-
 * pill, se `apps/web/dashboard.html`), men verdien selv gjør skillet
 * "bygget vs. backlog" synlig for et menneske uten å oppfinne en ny visuell
 * tilstand. INGEN av de 50 har `live_test` (ingen ToolGateway-handling
 * finnes for dem ennå - et testforsøk ville feile forvirrende, ikke gi en
 * ærlig "ikke bygget"-melding) - de rendrer derfor automatisk identisk med
 * en eksisterende `presence_only`, ukonfigurert connector (Fiken/Stripe/
 * Vipps-mønsteret). BEVISST UTELATT (se D-231/D-232 i
 * DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse): Supabase (Q-36),
 * Neo4j (Q-37), 1Password (Q-38) - åpne, uavklarte spørsmål, en registrering
 * nå ville sett ut som en stille godkjenning; Windows/macOS (Q-39) - eksplisitt
 * `IKKE EN CONNECTOR`, ingen ekstern leverandør-API i ToolGateway-forstand.
 * Dette er en RENT SYNLIGHETS-tiltak - INGEN D-64-Core-vs-Adapter-port er
 * kjørt for noen av disse 50, INGEN kode/credential-oppsett er gjort, D-108
 * (`EXTERNAL_CREDENTIAL_SETUP_POLICY=DEFER_UNTIL_FINAL_INTEGRATION_PHASE`)
 * gjelder uendret.
 *
 * D-292 (2026-09-26, Tobias direkte i chat: "jeg vil at alt i planen skal
 * bygges og fullføres"): `slack` er FØRSTE av disse 50 backlog-punktene som
 * faktisk er bygget - oppføringen ble oppdatert I PLACE (samme id, flyttet
 * fra `category: "backlog"` til `"tool_gateway"` med en ny `live_test`),
 * ALDRI duplisert som en ny, separat oppføring - se `connector-registry.
 * test.ts` sitt unikhetskrav.
 *
 * D-294 (2026-09-27, samme brede ordre, andre slice): `discord` bygget og
 * flyttet ut av backlogen SAMME MÅTE - oppdatert i place, ikke duplisert
 * (D-293 sin lærdom fra Slack-PR-en - en tidligere PR-CI-regresjon fra
 * nettopp DENNE feilen, alltid `grep` for en eksisterende id FØRST).
 *
 * D-295 (2026-09-27, samme brede ordre, tredje slice): `twilio` bygget og
 * flyttet ut av backlogen SAMME MÅTE.
 *
 * D-296 (2026-09-27, samme brede ordre, fjerde slice): `brave_search` bygget
 * og flyttet ut av backlogen SAMME MÅTE - FØRSTE rent lesende (klasse A-kun)
 * connector i denne rekken, D-41 sitt read-only-unntak ærlig oppfylt (Brave
 * Search sitt API tilbyr genuint ingen skrivehandling).
 *
 * D-297 (2026-09-27, samme brede ordre, femte slice): `sentry` bygget og
 * flyttet ut av backlogen SAMME MÅTE. **Merk:** dette øktens miljø blokkerer
 * utgående nettverkstrafikk til eksterne dokumentasjonsdomener (bekreftet via
 * `WebFetch` under bygging - se D-297 i DECISIONS_AND_ASSUMPTIONS.md) - API-
 * formen er derfor basert på trent kunnskap om Sentry sitt offentlige, stabile
 * REST-API v0, IKKE en denne-økten-bekreftet kilde slik D-292/D-294/D-295/
 * D-296 kunne. `SENTRY_LIVE_GATE` krever derfor en ekte live-test med et ekte
 * token FØR `LIVE_VERIFIED` kan påstås, sterkere enn de forrige fire.
 *
 * D-298 (2026-09-27, samme brede ordre, sjette slice): `google_maps` bygget
 * og flyttet ut av backlogen SAMME MÅTE - BEVISST AVGRENSET til KUN
 * Geocoding, `google_places`/`google_routes` forblir separate, ubygde
 * backlog-punkter. Samme D-297-forbehold gjelder (trent kunnskap, ikke
 * denne-økten-bekreftet).
 *
 * D-299 (2026-09-27, samme brede ordre, syvende slice): `google_sheets`
 * bygget og flyttet ut av backlogen SAMME MÅTE - gjenbruker EKSISTERENDE
 * `googleAccessToken()`-OAuth-vei (Gmail/Calendar/Drive), men med sin EGEN
 * `credential_ref` (Sheets krever den dedikerte `spreadsheets`-scopen, Drive
 * sin bredere scope dekker den ikke). D-41 sitt "maksimal nyttig kapabilitet"
 * fulgt - EKTE skrivehandlinger (`update_range`/`append_row`), ikke kunstig
 * innsnevret til read-only.
 *
 * D-300 (2026-09-27, samme økt, Tobias direkte i chat etter live telefontest:
 * "husker han ingenting... vi trodde det fungerte fungerte det ikke"): INGEN
 * connector-endring - kritisk minnefiks, `RuleBasedExtractor` erstattet av
 * `LlmExtractionAdapter` i `apps/api/src/main.ts`, se `modules/memory/src/
 * extraction.ts`. Nevnt her kun for kronologisk sporbarhet i denne filens
 * D-nummer-rekke.
 *
 * D-301 (2026-09-27, samme brede ordre, åttende slice): `tavily` bygget og
 * flyttet ut av backlogen SAMME MÅTE - andre rent lesende (klasse A-kun)
 * connector (samme D-41 read-only-unntak som Brave Search: Tavily sitt API
 * tilbyr genuint ingen skrivehandling). Samme D-297-forbehold gjelder (trent
 * kunnskap om ett kjent endepunkt, `POST /search`, ikke denne-økten-
 * bekreftet). De resterende 42 backlog-punktene er fortsatt uendret; samme
 * oppdater-i-place-disiplin gjelder for hver av dem når de bygges.
 *
 * D-302 (2026-09-27, samme brede ordre, niende slice, Tobias direkte i chat:
 * "fortsett og jobbe ikke vent på ci"): `exa` bygget og flyttet ut av
 * backlogen SAMME MÅTE - tredje rent lesende (klasse A-kun) connector (samme
 * D-41 read-only-unntak som Brave Search/Tavily). Exa sitt nevrale søke-API
 * har TO separate, egne endepunkter (`POST /search` og `POST /findSimilar`),
 * ULIK Tavily (som deler ETT endepunkt via et body-felt) - `find_similar` er
 * derfor et EGET kall, ikke en variant av `web_search`. Samme D-297-forbehold
 * gjelder (trent kunnskap, ikke denne-økten-bekreftet). De resterende 41
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-303 (2026-09-27, samme brede ordre, tiende slice, bygget parallelt mens
 * D-302 sin CI kjørte): `google_places` bygget og flyttet ut av backlogen
 * SAMME MÅTE - BEVISST samme D-64-domenevurdering som Google Maps (D-298):
 * stateless tredjeparts-stedoppslag, IKKE eierens egen posisjon/geofence
 * (`modules/location`). Bruker det ELDRE, langvarig stabile Places-API-et
 * (`key`-query-parameter), SAMME autentiseringsform som `GoogleMapsTransport`
 * - bevisst IKKE det nyere v1 Places-API-et (felt-maske-/header-basert auth,
 * en helt annen kallform). Samme D-297-forbehold gjelder (trent kunnskap,
 * ikke denne-økten-bekreftet). De resterende 40 backlog-punktene er fortsatt
 * uendret; samme oppdater-i-place-disiplin gjelder for hver av dem når de
 * bygges.
 *
 * D-304 (2026-09-27, samme brede ordre, ellevte slice, bygget parallelt mens
 * D-303 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og jobbe
 * ikke vent på ci"): `google_routes` bygget og flyttet ut av backlogen SAMME
 * MÅTE - fullfører "Google-lokasjons-trioen" (Maps/Places/Routes) med SAMME
 * D-64-domenevurdering som de to foregående: stateless tredjeparts-rute-
 * oppslag, IKKE eierens egen posisjon/geofence. Bruker det ELDRE, langvarig
 * stabile Directions-API-et (`key`-query-parameter), SAMME autentiseringsform
 * som `GoogleMapsTransport`/`GooglePlacesTransport` - bevisst IKKE det nyere
 * v2 Routes-API-et (`routes.googleapis.com`, felt-maske-/header-basert auth).
 * Samme D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * De resterende 39 backlog-punktene er fortsatt uendret; samme oppdater-i-
 * place-disiplin gjelder for hver av dem når de bygges.
 *
 * D-305 (2026-09-27, samme brede ordre, tolvte slice, bygget parallelt mens
 * D-304 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og jobbe
 * ikke vent på ci"): `grafana` bygget og flyttet ut av backlogen SAMME MÅTE -
 * FØRSTE connector i denne rekken som er TYPISK selv-hostet (ingen fast
 * SaaS-domene som sentry.io/api.tavily.com) - `JARVIS_GRAFANA_API_BASE_URL`
 * lagt til `credential_refs` (samme "credential_refs må liste ALLE
 * nødvendige verdier"-disiplin som D-245/D-246). Bearer-token-auth mot
 * Grafana sitt HTTP-API (`/api/search`/`/api/dashboards/uid/{uid}`). To
 * handlinger - `search_dashboards`/`get_dashboard` - begge klasse A, INGEN
 * skrivehandling finnes for denne connectoren i det hele tatt (D-41 sitt
 * read-only-unntak ærlig oppfylt). Samme D-297-forbehold gjelder (trent
 * kunnskap, ikke denne-økten-bekreftet). De resterende 38 backlog-punktene
 * er fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-306 (2026-09-27, samme brede ordre, trettende slice, bygget parallelt
 * mens D-305 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og
 * jobbe ikke vent på ci"): `prometheus` bygget og flyttet ut av backlogen
 * SAMME MÅTE - SAMME "typisk selv-hostet"-struktur som Grafana (D-305):
 * `JARVIS_PROMETHEUS_API_BASE_URL` lagt til `credential_refs`, injisert som
 * resolver-closure. Bearer-token-auth mot Prometheus sitt HTTP-API
 * (`/api/v1/query`/`/api/v1/query_range`, PromQL). To handlinger -
 * `query`/`query_range` - begge klasse A, INGEN skrivehandling finnes for
 * denne connectoren i det hele tatt (D-41 sitt read-only-unntak ærlig
 * oppfylt - Prometheus sitt HTTP-API tilbyr uansett ingen skrive-endepunkt
 * for metrikkdata). Samme D-297-forbehold gjelder (trent kunnskap, ikke
 * denne-økten-bekreftet). De resterende 37 backlog-punktene er fortsatt
 * uendret; samme oppdater-i-place-disiplin gjelder for hver av dem når de
 * bygges.
 *
 * D-307 (2026-09-27, samme brede ordre, fjortende slice, bygget parallelt
 * mens D-306 sin CI kjørte, Tobias direkte i chat gjentatt: "fortsett og
 * jobbe ikke vent på ci"): `dropbox` bygget og flyttet ut av backlogen SAMME
 * MÅTE - `Authorization: Bearer`-header mot Dropbox API v2, ETT langvarig
 * access-token (INGEN OAuth-refresh-flyt nødvendig, ULIK Google-familien).
 * To handlinger - `list_folder` (klasse A, lesing) og `create_folder`
 * (klasse B, EKTE skrivehandling) - D-41 sitt "maksimal nyttig
 * kapabilitet"-prinsipp fulgt, ikke kunstig innsnevret til read-only.
 * BEVISST AVGRENSET fra fil-INNHOLD-opplasting/nedlasting (Dropbox sitt
 * separate `content.dropboxapi.com`-vertsnavn med binær body/spesielle
 * `Dropbox-API-Arg`-headere - en STRUKTURELT ulik kallform enn de øvrige
 * JSON-RPC-handlingene, bevisst utsatt til en egen, senere utvidelse i
 * stedet for gjettet frem her). Samme D-297-forbehold gjelder (trent
 * kunnskap, ikke denne-økten-bekreftet). De resterende 36 backlog-punktene
 * er fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-308 (2026-09-27, samme brede ordre, femtende slice, bygget parallelt
 * mens D-307 sin CI kjørte, Tobias direkte i chat gjentatt, niende gang:
 * "fortsett og jobbe ikke vent på ci"): `notion` bygget og flyttet ut av
 * backlogen SAMME MÅTE - `Authorization: Bearer`-header PLUSS en fast
 * `Notion-Version`-header mot Notion sitt REST-API v1. To handlinger -
 * `search` (klasse A, lesing) og `create_page` (klasse B, EKTE
 * skrivehandling) - D-41 sitt "maksimal nyttig kapabilitet"-prinsipp
 * fulgt, ikke kunstig innsnevret til read-only. `create_page` sin
 * `rollback_procedure` er manuell arkivering i Notion sitt UI (INGEN
 * dedikert arkiver-endepunkt bygget her ennå - samme DEFERRED-disiplin som
 * Dropbox sin fil-innhold-begrensning, D-41 eksplisitt merket). Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk dokument-/kunnskaps-domenemodell finnes
 * noe sted i Jarvis (samme reasonering som Google Drive/Sheets/Dropbox) -
 * rent leverandør-adapter, EXTERNAL_CANONICAL. De resterende 35
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-309 (2026-09-27, samme brede ordre, sekstende slice, bygget parallelt
 * mens D-308 sin CI kjørte, Tobias direkte i chat gjentatt, tiende gang:
 * "fortsett og jobbe ikke vent på ci"): `onedrive` bygget og flyttet ut av
 * backlogen SAMME MÅTE - `Authorization: Bearer`-header mot Microsoft
 * Graph v1.0. To handlinger - `list_folder` (klasse A, lesing) og
 * `create_folder` (klasse B, EKTE skrivehandling) - D-41 sitt "maksimal
 * nyttig kapabilitet"-prinsipp fulgt, ikke kunstig innsnevret til
 * read-only. SAMME "fil-lagring"-domenestatus som Dropbox (D-307) -
 * `create_folder` sin `rollback_procedure` er manuell sletting. Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk fil-lagrings-domenemodell finnes noe sted
 * i Jarvis (samme reasonering som Google Drive/Dropbox) - rent
 * leverandør-adapter, EXTERNAL_CANONICAL. De resterende 34
 * backlog-punktene er fortsatt uendret; samme oppdater-i-place-disiplin
 * gjelder for hver av dem når de bygges.
 *
 * D-310 (2026-09-27, FØRSTE slice ETTER at PR #190 - D-301 til D-309 - ble
 * merget til `main` under D-192 - ett-connector-per-PR-mønsteret
 * gjenopptas her): `microsoft_outlook` bygget og flyttet ut av backlogen -
 * `Authorization: Bearer`-header mot Microsoft Graph v1.0 (SAMME
 * vertsnavn/auth-mønster som OneDrive D-309). To handlinger -
 * `list_messages` (klasse A, lesing) og `send_mail` (klasse D - BEVISST
 * SAMME klassifisering som Gmail sin `email.send`: sending av e-post er
 * ikke reverserbar). `PolicyGateway`/`ToolGateway.execute()` sin generiske
 * klasse D-håndtering (CLAUDE.md regel 2 - deterministisk kode, aldri kun
 * promptregler) dekker denne handlingen identisk til `email.send` uten
 * egen per-connector-kode. Samme D-297-forbehold gjelder (trent kunnskap,
 * ikke denne-økten-bekreftet). **D-64-sjekk:** Jarvis har allerede
 * canonical e-post-håndtering via Gmail (`email.*`), men Outlook er en
 * genuint separat leverandør-konto (Microsoft-basert postkasse) - IKKE en
 * konkurrerende domenemodell, samme presedens som Slack+Discord+Twilio som
 * separate meldingsleverandører. De resterende 33 backlog-punktene er
 * fortsatt uendret; samme oppdater-i-place-disiplin gjelder for hver av
 * dem når de bygges.
 *
 * D-311 (2026-09-27, attende slice, Tobias direkte i chat gjentatt,
 * ellevte gang: "fortsett og jobbe ikke vent på ci"): `n8n` bygget og
 * flyttet ut av backlogen - `X-N8N-API-KEY`-header (IKKE `Authorization:
 * Bearer` - n8n sitt eget API-nøkkel-headernavn) mot n8n sitt REST-API v1.
 * n8n er TYPISK selv-hostet (SAMME "typisk selv-hostet"-mønster som
 * Grafana D-305/Prometheus D-306) - base-URL-en må konfigureres via
 * `JARVIS_N8N_API_BASE_URL`, resolver-closure. To handlinger -
 * `list_workflows` (klasse A, lesing) og `activate_workflow` (klasse B,
 * EKTE skrivehandling) - D-41 sitt "maksimal nyttig kapabilitet"-prinsipp
 * fulgt. `activate_workflow` sin `rollback_procedure` er manuell
 * deaktivering (dedikert `deactivate_workflow`-handling DEFERRED, D-41
 * eksplisitt merket, samme disiplin som Dropbox/Notion). Samme
 * D-297-forbehold gjelder (trent kunnskap, ikke denne-økten-bekreftet).
 * **D-64-sjekk:** ingen kanonisk workflow-/automasjons-domenemodell finnes
 * noe sted i Jarvis - rent leverandør-adapter, EXTERNAL_CANONICAL. De
 * resterende 32 backlog-punktene er fortsatt uendret; samme
 * oppdater-i-place-disiplin gjelder for hver av dem når de bygges.
 */
export interface ConnectorDefinition {
  id: string;
  display_name: string;
  category: "tool_gateway" | "model_provider" | "finance" | "infra" | "backlog" | "backlog_d64_gate";
  /** Secret-referanser (env/vault-nøkler) DENNE connectoren trenger - ALDRI verdiene selv. */
  credential_refs: string[];
  /**
   * `parameters` er en FUNKSJON (samme presedens som `MeshToolMapping.
   * parameters` i `mesh-bridge.ts`), IKKE en statisk verdi - for
   * tidsvinduer (f.eks. kalender sin "i dag") må parametrene bygges FRISKT
   * ved selve testkallet, ikke frosset til modul-lastetidspunktet. Task #122:
   * tar nå (valgfritt brukt) den KALLENDE identiteten - noen leverandør-
   * lesinger (Neonomics/Wallester) er tenant-scopet og trenger
   * `identity.tenant_id`, som ALDRI kan være en modul-lastetidspunkt-konstant.
   */
  live_test?: { tool_id: string; action: string; parameters: (identity: IdentityContext) => Record<string, JsonValue> };
}

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  {
    id: "github", display_name: "GitHub", category: "tool_gateway",
    credential_refs: ["JARVIS_GITHUB_TOKEN"],
    live_test: { tool_id: "github", action: "read_issues", parameters: () => ({ repo: process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild" }) }
  },
  {
    id: "google_calendar", display_name: "Google Calendar", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_TOKEN"],
    // SAMME "dagens hendelser"-vindu som `mesh-bridge.ts` sin `read_calendar_today` allerede bygger.
    live_test: {
      tool_id: "calendar", action: "read_events",
      parameters: () => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
      }
    }
  },
  {
    id: "gmail", display_name: "Gmail", category: "tool_gateway",
    credential_refs: ["JARVIS_EMAIL_TOKEN"],
    live_test: { tool_id: "email", action: "read_inbox", parameters: () => ({ max: 1 }) }
  },
  {
    id: "google_drive", display_name: "Google Drive/Docs", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_TOKEN"],
    // Uten `folder_id` lister `drive.list_files` roten av driven - samme
    // trygge, side-effektfrie klasse A-lesing `drive-source.ts` allerede bruker.
    live_test: { tool_id: "drive", action: "list_files", parameters: () => ({}) }
  },
  {
    id: "telegram", display_name: "Telegram", category: "tool_gateway",
    // D-247: `JARVIS_TELEGRAM_CHAT_ID` lagt til - `get_bot_info` (live_test
    // under) trenger den ikke, men selve `telegram.notify` (ekte utsendelse,
    // inkl. Daily Brief og watchdog-nødvarsel) gjør, og feltet var usynlig
    // for eieren i dashbordet uten denne oppføringen - samme bug-klasse som
    // D-245/D-246.
    credential_refs: ["JARVIS_TELEGRAM_TOKEN", "JARVIS_TELEGRAM_CHAT_ID"],
    // `telegram.notify` er en EKTE meldingsutsendelse (klasse B) - aldri
    // trygg som test. `get_bot_info` (Telegram Bot API sin `getMe`, lagt til
    // i live-transports.ts AKKURAT for dette formålet) krever kun boten sin
    // egen token, ingen chat_id, og har INGEN sideeffekt.
    live_test: { tool_id: "telegram", action: "get_bot_info", parameters: () => ({}) }
  },
  {
    // D-388: full D-41-kapabilitet (prosjekter, deployment, env-nøkler, upsert_env, promote/rollback/cancel).
    // `JARVIS_VERCEL_TEAM_ID` er valgfri team-kontekst (ikke en secret, men listet så dashbordet kan sette den).
    id: "vercel", display_name: "Vercel", category: "tool_gateway", credential_refs: ["JARVIS_VERCEL_TOKEN", "JARVIS_VERCEL_TEAM_ID"],
    live_test: { tool_id: "vercel", action: "read_deployments", parameters: () => ({}) }
  },
  { id: "anthropic", display_name: "Anthropic API", category: "model_provider", credential_refs: ["ANTHROPIC_API_KEY"] },
  { id: "openai", display_name: "OpenAI API", category: "model_provider", credential_refs: ["OPENAI_API_KEY"] },
  { id: "gemini", display_name: "Gemini API", category: "model_provider", credential_refs: ["GEMINI_API_KEY"] },
  {
    id: "fiken", display_name: "Fiken", category: "finance",
    credential_refs: ["JARVIS_FIKEN_CLIENT_ID", "JARVIS_FIKEN_CLIENT_SECRET", "JARVIS_FIKEN_REFRESH_TOKEN"],
    // D-242: `FikenTransport.listCompanies()` - Fiken sin egen dokumenterte
    // "hent companySlug"-inngang, INGEN mutasjon. Tidligere `presence_only`
    // (ingen sikker lesing fantes) - se filhode for historikk.
    live_test: { tool_id: "finance", action: "list_companies", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    id: "stripe", display_name: "Stripe", category: "finance",
    credential_refs: ["JARVIS_STRIPE_SECRET_KEY"],
    // D-242: `GET /v1/balance` - offisielt dokumentert, INGEN parametre,
    // INGEN mutasjon. Tidligere `presence_only` - se filhode for historikk.
    live_test: { tool_id: "finance_stripe", action: "get_balance", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    id: "vipps", display_name: "Vipps", category: "finance",
    // D-246: `JARVIS_VIPPS_MSN` (merchant serial number) lagt til - samme
    // "credential_refs ufullstendig relativt til getCredentials()"-bug-klasse
    // som D-245 fant for Neonomics sin DEVICE_ID.
    credential_refs: ["JARVIS_VIPPS_CLIENT_ID", "JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_VIPPS_SUBSCRIPTION_KEY", "JARVIS_VIPPS_MSN"],
    // D-242: `POST /accesstoken/get` (SAMME kall enhver ekte Vipps-handling
    // uansett gjør FØRST) - INGEN parameterløs "whoami"-lesing finnes i
    // ePayment-API-et, men selve token-hentingen ER INGEN mutasjon og
    // feiler umiddelbart på ugyldige credentials. Tidligere `presence_only`
    // - se filhode for historikk.
    live_test: { tool_id: "finance_vipps", action: "check_credentials", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    // D-245 (2026-09-23, funnet LIVE av Tobias): `neonomicsCredentialsProvider.
    // getCredentials()` (apps/api/src/main.ts) har ALLTID krevd
    // `JARVIS_NEONOMICS_DEVICE_ID` (en Jarvis-generert, stabil enhets-UUID -
    // `x-device-id`-headeren Neonomics knytter samtykke/sesjon til, IKKE noe
    // Tobias henter FRA Neonomics) i tillegg til CLIENT_ID/SECRET - men denne
    // listen manglet den, så dashbordets "lim inn ny verdi"-felt ble ALDRI
    // vist for den. Testknappen kunne derfor ALDRI lykkes uansett hvilken
    // CLIENT_ID/SECRET som ble limt inn (`neonomics_credentials_unavailable`
    // uavhengig av dem). Samme "kravt credential mangler i registeret"-
    // klasse som D-236 (tom streng behandlet som satt) - her manglet
    // referansen helt. Fiks: DEVICE_ID lagt til i `credential_refs`.
    id: "neonomics", display_name: "Neonomics", category: "finance",
    credential_refs: ["JARVIS_NEONOMICS_CLIENT_ID", "JARVIS_NEONOMICS_CLIENT_SECRET", "JARVIS_NEONOMICS_DEVICE_ID"],
    // Katalogoppslag (bankene Neonomics dekker) - krever INGEN eksisterende
    // banksamtykke, kun gyldige API-credentials. Ren lesing, klasse A.
    live_test: { tool_id: "finance_neonomics", action: "list_banks", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },
  {
    // D-246: `JARVIS_WALLESTER_API_BASE_URL`/`JARVIS_WALLESTER_ACCOUNT_ID`
    // lagt til - samme bug-klasse som D-245/Vipps over.
    id: "wallester", display_name: "Wallester", category: "finance",
    credential_refs: ["JARVIS_WALLESTER_API_KEY", "JARVIS_WALLESTER_PRIVATE_KEY_PEM", "JARVIS_WALLESTER_API_BASE_URL", "JARVIS_WALLESTER_ACCOUNT_ID"],
    // Leverandørkontosaldo - "read-only provider-tilstand", uavhengig av om
    // noe kort faktisk er utstedt ennå. Ren lesing, klasse A.
    live_test: { tool_id: "finance_wallester", action: "get_provider_balance", parameters: (identity) => ({ tenant_id: identity.tenant_id }) }
  },

  // --- D-232 backlog-synlighet (D-231 `NY_BACKLOG`, `docs/INTEGRATIONS.md` §4) ---------------
  // INGEN `live_test` for noen oppføring under - se filhode-kommentaren for full begrunnelse.
  // Rekkefølge følger `docs/INTEGRATIONS.md` §4 sine underseksjoner (4.3->4.15).

  // §4.3 Kunnskap / dokumenter
  {
    // D-308 (bygget, flyttet ut av backlog): Notion REST-API v1 (fast
    // `Notion-Version`-header i tillegg til `Authorization: Bearer`). D-41
    // sitt "maksimal nyttig kapabilitet"-prinsipp fulgt - EKTE
    // skrivehandling (`create_page`), ikke kunstig innsnevret til
    // read-only. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-disiplinen).
    id: "notion", display_name: "Notion", category: "tool_gateway", credential_refs: ["JARVIS_NOTION_API_KEY"],
    live_test: { tool_id: "notion", action: "search", parameters: () => ({}) }
  },
  {
    // D-309 (bygget, flyttet ut av backlog): Microsoft Graph v1.0
    // (`Authorization: Bearer`-header). D-41 sitt "maksimal nyttig
    // kapabilitet"-prinsipp fulgt - EKTE skrivehandling (`create_folder`),
    // ikke kunstig innsnevret til read-only. Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-disiplinen).
    // D-388: Graph-tokens utløper etter ~1 t - `JARVIS_MICROSOFT_REFRESH_TOKEN` + app-registrering gir automatisk
    // fornyelse (delt med Outlook); `JARVIS_ONEDRIVE_TOKEN` er fortsatt gyldig som statisk fallback.
    id: "onedrive", display_name: "OneDrive", category: "tool_gateway",
    credential_refs: ["JARVIS_ONEDRIVE_TOKEN", "JARVIS_MICROSOFT_REFRESH_TOKEN", "JARVIS_MICROSOFT_CLIENT_ID", "JARVIS_MICROSOFT_CLIENT_SECRET", "JARVIS_MICROSOFT_TENANT_ID"],
    live_test: { tool_id: "onedrive", action: "list_folder", parameters: () => ({}) }
  },
  {
    // D-307 (bygget, flyttet ut av backlog): Dropbox API v2 - `Authorization:
    // Bearer`-header, ETT langvarig access-token (INGEN OAuth-refresh-flyt
    // nødvendig, ULIK Google-familien). D-41 sitt "maksimal nyttig
    // kapabilitet"-prinsipp fulgt - EKTE skrivehandling (`create_folder`),
    // ikke kunstig innsnevret til read-only. Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-lærdommen).
    // D-388: Dropbox-tokens er kortlivede (4 t) - `JARVIS_DROPBOX_REFRESH_TOKEN` + app-nøkkel/-hemmelighet gir
    // automatisk fornyelse; `JARVIS_DROPBOX_TOKEN` er fortsatt gyldig som statisk fallback. Pluss upload/download.
    id: "dropbox", display_name: "Dropbox", category: "tool_gateway",
    credential_refs: ["JARVIS_DROPBOX_TOKEN", "JARVIS_DROPBOX_REFRESH_TOKEN", "JARVIS_DROPBOX_APP_KEY", "JARVIS_DROPBOX_APP_SECRET"],
    live_test: { tool_id: "dropbox", action: "list_folder", parameters: () => ({ path: "" }) }
  },
  {
    // D-299 (bygget, flyttet ut av backlog): SYVENDE slice. Gjenbruker den
    // EKSISTERENDE `googleAccessToken()`-OAuth-veien, MEN med sin EGEN
    // credential_ref (Sheets krever `spreadsheets`-scope, Drive sin bredere
    // `auth/drive`-scope dekker den ikke). `live_test` trenger et faktisk
    // regneark-id (INGEN universell "list mine regneark"-handling finnes i
    // Sheets-API-et selv, kun i Drive-API-et) - samme etablerte "les fra en
    // egen konfig-env-variabel"-mønster som GitHub sin `JARVIS_GITHUB_REPO`
    // over (IKKE en secret, derfor IKKE i `credential_refs`). Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "google_sheets", display_name: "Google Sheets", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_SHEETS_TOKEN"],
    live_test: {
      tool_id: "google_sheets", action: "list_sheets",
      parameters: () => ({ spreadsheet_id: process.env["JARVIS_GOOGLE_SHEETS_TEST_SPREADSHEET_ID"] ?? "" })
    }
  },

  // §4.4 Produktivitet / e-post / kalender
  {
    // D-310 (bygget, flyttet ut av backlog): Microsoft Graph v1.0 (SAMME
    // vertsnavn/auth-mønster som OneDrive D-309). `send_mail` er BEVISST
    // klasse D (samme begrunnelse som Gmail sin `email.send`) - ikke
    // reverserbar. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-disiplinen).
    // D-388: samme Microsoft-refresh-konfig som OneDrive (én app-registrering, ett refresh-token for Graph).
    id: "microsoft_outlook", display_name: "Microsoft Outlook", category: "tool_gateway",
    credential_refs: ["JARVIS_OUTLOOK_TOKEN", "JARVIS_MICROSOFT_REFRESH_TOKEN", "JARVIS_MICROSOFT_CLIENT_ID", "JARVIS_MICROSOFT_CLIENT_SECRET", "JARVIS_MICROSOFT_TENANT_ID"],
    live_test: { tool_id: "microsoft_outlook", action: "list_messages", parameters: () => ({ max: 5 }) }
  },
  // D-318: "Microsoft 365" fjernet som egen backlog-plassholder (var her som
  // "NY_BACKLOG", credential_refs JARVIS_MICROSOFT_365_TOKEN). SAMME
  // "ALLEREDE_DEKKET, ingen egen connector nødvendig"-mønster som Google Docs
  // (dekkes av Google Drive) rett over §4.4 - Microsoft sin ekvivalent til
  // Gmail+Drive er NÅ FAKTISK bygget som to separate, presise Microsoft
  // Graph v1.0-connectorer: `microsoft_outlook` (D-310, e-post) og
  // `onedrive` (D-309, fillagring). "Microsoft 365" som EGEN, bredere
  // plassholder (Teams/SharePoint/Excel Online/delt kalender) forblir
  // eksplisitt UBYGD og UBEDT - reises som en FERSK, presist scopet
  // instruks fra Tobias om ønsket, ALDRI gjettet frem her (CLAUDE.md regel
  // 12/D-64-disiplin).

  // §4.5 Kode / dev / infra
  // D-337: 'google_cloud' sin gamle, vage plassholder FJERNET HELT. Tobias
  // presiserte eksplisitt i chat (svar på Q-41): "servere" - bygget som GCE
  // (Google Compute Engine), SAMME status som Docker - en ren ToolGateway-
  // infra-transport, IKKE sporet i dette registeret (se gce-transport.ts).
  // "All markedsføring osv osv" utover Google Ads (allerede bygget, D-83)
  // er BEVISST IKKE bygget denne sliceen - hver ANNEN GCP-del-tjeneste
  // (Analytics/Search Console/Merchant Center/osv) krever sin EGEN, fersk
  // D-41-verifisering under et NYTT D-nummer, ALDRI gjettet frem sammen med
  // denne sliceen eller stille bundlet inn i én vag "google_cloud"-tag.

  // §4.6 Søk / browser
  {
    // D-296 (bygget, flyttet ut av backlog): STRUKTURELT ULIK Telegram/Slack/
    // Discord/Twilio over - INGEN "notify er ekte utsendelse"-handling finnes,
    // Brave Search tilbyr genuint bare lesing. `live_test` bruker `web_search`
    // DIREKTE (allerede sideeffekt-fritt, ingen egen tilkoblingstest-handling
    // trengs). Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI
    // en ny, separat oppføring med samme id (D-293-lærdommen).
    id: "brave_search", display_name: "Brave Search", category: "tool_gateway",
    credential_refs: ["JARVIS_BRAVE_SEARCH_API_KEY"],
    live_test: { tool_id: "brave_search", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  {
    // D-301 (bygget, flyttet ut av backlog): samme "genuint bare lesing"-
    // struktur som Brave Search (D-296) rett over - Tavily tilbyr ett kjent
    // endepunkt (POST /search) som web_search/news_search begge bruker,
    // differensiert kun via et `topic`-felt i request-body. Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "tavily", display_name: "Tavily", category: "tool_gateway",
    credential_refs: ["JARVIS_TAVILY_API_KEY"],
    live_test: { tool_id: "tavily", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  {
    // D-302 (bygget, flyttet ut av backlog): samme "genuint bare lesing"-
    // struktur som Brave Search (D-296)/Tavily (D-301) - Exa sitt nevrale
    // søke-API (`POST /search`) tilbyr genuint bare lesing. `find_similar`
    // bruker et EGET, separat dokumentert endepunkt (`POST /findSimilar`),
    // IKKE samme kall som web_search med en annen body-form. Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-lærdommen).
    id: "exa", display_name: "Exa", category: "tool_gateway",
    credential_refs: ["JARVIS_EXA_API_KEY"],
    live_test: { tool_id: "exa", action: "web_search", parameters: () => ({ query: "ping" }) }
  },
  {
    // D-339 (bygget, flyttet ut av backlog - Tobias direkte i chat: "playwrite
    // er viktig for at den skal kunne kontrollere mer", bekrefter lokal/selv-
    // hostet nettleserautomasjon, ALDRI en tredjeparts cloud-browser-
    // leverandør). KUN read-only-halvparten (`navigate`/`extract_text`/
    // `screenshot`) - `click`/`fill_form`/`submit` DEFERRED, se
    // apps/browser-gateway/src/browser-engine.ts. `credential_refs` er
    // BASE-URL-en til apps/browser-gateway sin egen prosess - INGEN ekte
    // API-nøkkel finnes (den gamle plassholderen antok feilaktig én).
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id (D-293-disiplinen).
    id: "playwright", display_name: "Playwright (lokal nettleserautomasjon, kun read-only)", category: "tool_gateway",
    credential_refs: ["JARVIS_BROWSER_GATEWAY_BASE_URL"],
    live_test: { tool_id: "browser", action: "navigate", parameters: () => ({ url: "https://example.com" }) }
  },

  // §4.7 Tale / video / media-AI
  // D-328: "openai_realtime" fjernet HELT herfra - IKKE en ToolGateway-
  // connector (samme domenegrense-feil som elevenlabs/deepgram, D-319/
  // D-320), MEN OGSÅ IKKE byggbar som en enkel SpeechAdapter-utvidelse:
  // OpenAI Realtime API er en VEDVARENDE, full-dupleks WebSocket-økt
  // (samtaletilstand/avbrudds-håndtering/verktøykall INNI selve
  // tilkoblingen) - strukturelt ulik BÅDE ToolTransport (statisk REST)
  // OG de EKSISTERENDE SttAdapter/TtsAdapter-grensesnittene (enkle
  // batch-/strømmings-forespørsler). Krever en EGEN, ny arkitekturbeslutning
  // (en økt-/tilkoblingshåndteringsmodell) FØR noe kan kodes - se D-328 i
  // DECISIONS_AND_ASSUMPTIONS.md og Q-42 i OPEN_QUESTIONS.md.
  // D-319: "elevenlabs" fjernet HELT herfra - dette er en TALE-leverandør
  // (TTS), IKKE en ToolGateway-connector. En egen ToolTransport ville vært
  // en D-64-stil domenegrense-feil (CLAUDE.md regel 3: SpeechAdapter er den
  // riktige adapter-grensen for tale-leverandører). Bygget i stedet som
  // `ElevenLabsTts` (`apps/voice-gateway/src/tts.ts`), gated bak
  // `PROCESSOR_REGION_MATRIX.md`/`evaluateSpeechRouting()` (D-122), IKKE bak
  // denne registrerings-/credential-helsesjekk-dashboardet. Samme
  // "ALLEREDE_DEKKET/ikke-her, ikke stille utelatt"-disiplin som
  // microsoft_365 (D-318) - se DECISIONS_AND_ASSUMPTIONS.md D-319.
  // D-320: "deepgram" fjernet HELT herfra - SAMME grunn/mønster som
  // "elevenlabs" (D-319) rett over, bare STT i stedet for TTS. Bygget som
  // `DeepgramStt` (`apps/voice-gateway/src/stt.ts`).
  // D-328: "livekit" fjernet HELT herfra - SAMME begrunnelse som
  // "openai_realtime" rett over: LiveKit er en WebRTC/SFU-media-
  // infrastrukturplattform (server-SDK for rom-/token-styring, ekte
  // sanntids audio/video-transport), IKKE en enkel REST-API OG IKKE en
  // enkel SpeechAdapter-utvidelse - den er strukturelt en ALTERNATIV
  // sanntids-transportlag til `apps/voice-gateway` sin EKSISTERENDE
  // WebSocket-arkitektur, ikke en connector ved siden av den. Se D-328 i
  // DECISIONS_AND_ASSUMPTIONS.md og Q-42 i OPEN_QUESTIONS.md.
  {
    // D-321 (bygget, flyttet ut av backlog): Telnyx er en meldingsleverandør
    // (SMS/telefoni), IKKE en tale-leverandør (STT/TTS) - HØRER derfor hjemme
    // her som en ordinær ToolGateway-connector, i motsetning til elevenlabs/
    // deepgram (D-319/D-320) som ble fjernet fra dette registeret. SAMME
    // "notify/get_account_info"-mønster som Twilio. `credential_refs`
    // utvidet med FROM_NUMBER, samme "list alle nødvendige verdier"-disiplin
    // som D-245/D-246/D-295. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id.
    id: "telnyx", display_name: "Telnyx", category: "tool_gateway",
    credential_refs: ["JARVIS_TELNYX_API_KEY", "JARVIS_TELNYX_FROM_NUMBER"],
    live_test: { tool_id: "telnyx", action: "get_account_info", parameters: () => ({}) }
  },
  {
    // D-295 (bygget, flyttet ut av backlog): samme "notify er ekte utsendelse,
    // get_account_info er trygg tilkoblingstest"-disiplin som Telegram/Slack/
    // Discord over. Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-lærdommen). MERK:
    // `JARVIS_TWILIO_FROM_NUMBER` lagt til her - samme "credential_refs må
    // liste ALLE nødvendige verdier, ikke bare de som gateway.execute() selv
    // slår opp" - bug-klasse som D-245/D-246 (Vipps MSN/Wallester ACCOUNT_ID).
    id: "twilio", display_name: "Twilio", category: "tool_gateway",
    credential_refs: ["JARVIS_TWILIO_ACCOUNT_SID", "JARVIS_TWILIO_AUTH_TOKEN", "JARVIS_TWILIO_FROM_NUMBER"],
    live_test: { tool_id: "twilio", action: "get_account_info", parameters: () => ({}) }
  },
  {
    // D-314 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // PHONE_NUMBER_ID (Jarvis sin egen avsenderidentitet, SAMME rolle som
    // Telegram sin chat_id). Oppdatert i place (var en D-232
    // backlog-plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-disiplinen).
    id: "whatsapp", display_name: "WhatsApp", category: "tool_gateway",
    credential_refs: ["JARVIS_WHATSAPP_TOKEN", "JARVIS_WHATSAPP_PHONE_NUMBER_ID"],
    live_test: { tool_id: "whatsapp", action: "get_phone_number_info", parameters: () => ({}) }
  },
  {
    // D-292 (bygget, flyttet ut av backlog): "notify er ekte utsendelse,
    // get_bot_info er trygg tilkoblingstest"-disiplin, samme som Telegram
    // over. Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI
    // en ny, separat oppføring med samme id (se filhode: unikhetskravet
    // i connector-registry.test.ts).
    id: "slack", display_name: "Slack", category: "tool_gateway",
    credential_refs: ["JARVIS_SLACK_BOT_TOKEN"],
    live_test: { tool_id: "slack", action: "get_bot_info", parameters: () => ({}) }
  },
  {
    // D-294 (bygget, flyttet ut av backlog): samme "notify er ekte utsendelse,
    // get_bot_info er trygg tilkoblingstest"-disiplin som Telegram/Slack over.
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id (D-293-lærdommen fra Slack-PR-en).
    id: "discord", display_name: "Discord", category: "tool_gateway",
    credential_refs: ["JARVIS_DISCORD_BOT_TOKEN"],
    live_test: { tool_id: "discord", action: "get_bot_info", parameters: () => ({}) }
  },
  {
    // D-327 (bygget, flyttet ut av backlog): SISTE video-gen-connector,
    // SAMME WebSearch-sekundærkilde-krysssjekk-disiplin D-322/D-323/D-324
    // etablerte. Higgsfield sitt API er en MULTI-MODELL-markedsplass
    // (proxyer tredjeparts-modeller som `bytedance/seedance-2.0` under
    // EGET vertsnavn) - IKKE ETT fast genererings-endepunkt som Runway/
    // Kling/Veo. `generate_video` krever derfor et EKSPLISITT
    // `model_path`-parameter fra KALLEREN (INGEN hardkodet default) - se
    // HiggsfieldTransport sin doc-kommentar i live-transports.ts for
    // full D-64-begrunnelse for hvorfor dette IKKE er et gjettet
    // leverandørvalg. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id.
    // credential_refs utvidet fra ÉN til TO nøkler (Key ID/Key Secret er
    // BEGGE reelle credentials hos Higgsfield, samme "list alle
    // nødvendige verdier"-disiplin som D-245/D-246/D-295/D-323).
    // BEVISST INGEN live_test - ingen verifisert gratis/parameterløst
    // kontoendepunkt funnet, se D-327 i DECISIONS_AND_ASSUMPTIONS.md.
    id: "higgsfield", display_name: "Higgsfield", category: "tool_gateway",
    credential_refs: ["JARVIS_HIGGSFIELD_KEY_SECRET", "JARVIS_HIGGSFIELD_KEY_ID"]
  },
  {
    // D-329 (bygget, flyttet ut av backlog_d64_gate - FØRSTE av de seks
    // D-64-port-krevende CRM-/prosjektstyrings-leverandørene, D-291 stengte
    // selve porten 2026-09-26 og avgjorde prosjektstyring/tickets som
    // `JARVIS_CANONICAL` via `@jarvis/operations` sin `OperationsTask`
    // (D-129) - ekstern leverandør er en VALGFRI synk-adapter, ALDRI
    // domeneeier). API-formen BEKREFTET via WebSearch denne økten
    // (sekundærkilde-krysssjekket, IKKE bare trent kunnskap): den gamle
    // `/rest/v2/tasks`-veien er PENSJONERT, unifisert `/api/v1/` gjelder nå
    // - se TodoistTransport sin doc-kommentar i live-transports.ts for full
    // evidens-kategorisering. Oppdatert i place (var en D-232 backlog-
    // plassholder i §4.11) - ALDRI en ny, separat oppføring med samme id.
    // Dette er UTELUKKENDE transport-laget - selve OperationsTask-synk-
    // mappingen er BEVISST IKKE bygget her (D-41 DEFERRED, se D-329).
    id: "todoist", display_name: "Todoist", category: "tool_gateway",
    credential_refs: ["JARVIS_TODOIST_API_TOKEN"],
    live_test: { tool_id: "todoist", action: "list_tasks", parameters: () => ({}) }
  },
  {
    // D-330 (bygget, flyttet ut av backlog_d64_gate - ANDRE av de seks
    // D-64-port-krevende, samme mønster som Todoist/D-329). API-formen
    // BEKREFTET via WebSearch denne økten (sekundærkilde-krysssjekket):
    // `key`/`token` som QUERY-PARAMETERE - en STRUKTURELT annen auth-form
    // enn hver annen connector her, se TrelloTransport sin doc-kommentar i
    // live-transports.ts. `credential_refs` UENDRET (allerede to nøkler fra
    // D-232-plassholderen - API-nøkkelen var ALLEREDE korrekt identifisert
    // som en egen credential, ikke lagt til her). Dette er UTELUKKENDE
    // transport-laget - se D-329 sin doc-kommentar over for hvorfor den
    // fulle OperationsTask-synk-mappingen BEVISST ikke er bygget her.
    id: "trello", display_name: "Trello", category: "tool_gateway",
    credential_refs: ["JARVIS_TRELLO_API_KEY", "JARVIS_TRELLO_TOKEN"],
    live_test: { tool_id: "trello", action: "list_boards", parameters: () => ({}) }
  },
  {
    // D-331 (bygget, flyttet ut av backlog_d64_gate - TREDJE av de seks
    // D-64-port-krevende, samme mønster som Todoist/Trello). Jira Cloud er
    // PER-TENANT (`https://<domain>.atlassian.net`) - `credential_refs`
    // utvidet fra ÉN til TRE nøkler (base-URL + e-post er BEGGE reelle,
    // separate konfigurasjonsverdier utover selve API-tokenet, samme "list
    // alle nødvendige verdier"-disiplin som D-245/D-246/D-295/D-323).
    // API-formen BEKREFTET via WebSearch denne økten: den gamle
    // `/rest/api/3/search`-veien er HELT FJERNET, `/rest/api/3/search/jql`
    // PÅKREVD i stedet - se JiraTransport sin doc-kommentar i
    // live-transports.ts for full evidens-kategorisering. Dette er
    // UTELUKKENDE transport-laget - se D-329 sin doc-kommentar over for
    // hvorfor den fulle OperationsTask-synk-mappingen BEVISST ikke er
    // bygget her.
    id: "jira", display_name: "Jira", category: "tool_gateway",
    credential_refs: ["JARVIS_JIRA_API_TOKEN", "JARVIS_JIRA_BASE_URL", "JARVIS_JIRA_EMAIL"],
    live_test: { tool_id: "jira", action: "search_issues", parameters: () => ({ jql: "order by created DESC" }) }
  },
  {
    // D-332 (bygget, flyttet ut av backlog_d64_gate - FJERDE av de seks
    // D-64-port-krevende, samme mønster som Todoist/Trello/Jira). Linear
    // har INGEN REST-API - ETT GraphQL-endepunkt for BÅDE lesing og
    // skriving, se LinearTransport sin doc-kommentar i live-transports.ts.
    // `credential_refs` UENDRET (allerede korrekt ÉN nøkkel fra D-232-
    // plassholderen - ren API-nøkkel, INGEN Bearer-prefiks, BEKREFTET via
    // WebSearch). Dette er UTELUKKENDE transport-laget - se D-329 sin
    // doc-kommentar over for hvorfor den fulle OperationsTask-synk-
    // mappingen BEVISST ikke er bygget her.
    id: "linear", display_name: "Linear", category: "tool_gateway",
    credential_refs: ["JARVIS_LINEAR_API_KEY"],
    live_test: { tool_id: "linear", action: "list_teams", parameters: () => ({}) }
  },
  {
    // D-333 (bygget, flyttet ut av backlog_d64_gate - FEMTE av de seks
    // D-64-port-krevende, samme mønster som Todoist/Trello/Jira/Linear).
    // HubSpot sitt `/crm/v3/objects/{objectType}`-mønster er EKSAKT
    // identisk for contacts/companies/deals - `object_type` er derfor et
    // PÅKREVD parameter fra kalleren (samme "kalleren styrer routing"-
    // disiplin som Higgsfield sin model_path, D-327), se HubSpotTransport
    // sin doc-kommentar i live-transports.ts. `credential_refs` UENDRET
    // (allerede korrekt ÉN nøkkel fra D-232-plassholderen - Bearer private
    // app-token). Dette er UTELUKKENDE transport-laget - se D-329 sin
    // doc-kommentar over for hvorfor den fulle OperationsTask-synk-
    // mappingen BEVISST ikke er bygget her.
    id: "hubspot", display_name: "HubSpot", category: "tool_gateway",
    credential_refs: ["JARVIS_HUBSPOT_API_KEY"],
    live_test: { tool_id: "hubspot", action: "list_objects", parameters: () => ({ object_type: "contacts", limit: 1 }) }
  },
  {
    // D-334 (bygget, flyttet ut av backlog_d64_gate - SJETTE og SISTE av de
    // seks D-64-port-krevende, fullfører hele gruppen). Pipedrive er
    // PER-TENANT (samme struktur som Jira, D-331) OG bruker
    // `/api/v2/{objectType}`-symmetri for persons/organizations/deals
    // (samme mønster som HubSpot, D-333) - `object_type` er derfor PÅKREVD
    // fra kalleren, se PipedriveTransport sin doc-kommentar i
    // live-transports.ts. `credential_refs` UTVIDET fra ÉN til TO nøkler
    // (base-URL er en ny, reell konfigurasjonsverdi utover selve API-
    // tokenet, samme "list alle nødvendige verdier"-disiplin som D-245/
    // D-246/D-295/D-323/D-327/D-331). Dette er UTELUKKENDE transport-
    // laget - se D-329 sin doc-kommentar over for hvorfor den fulle
    // OperationsTask/Business OS-synk-mappingen BEVISST ikke er bygget her.
    id: "pipedrive", display_name: "Pipedrive", category: "tool_gateway",
    credential_refs: ["JARVIS_PIPEDRIVE_API_KEY", "JARVIS_PIPEDRIVE_BASE_URL"],
    live_test: { tool_id: "pipedrive", action: "list_objects", parameters: () => ({ object_type: "persons", limit: 1 }) }
  },
  {
    // D-322 (bygget, flyttet ut av backlog): FØRSTE video-gen-connector -
    // API-formen BEKREFTET via WebSearch denne økten (kryssjekket mot flere
    // uavhengige kilder), IKKE bare trent kunnskap - se RunwayTransport sin
    // doc-kommentar i live-transports.ts for full evidens-kategorisering.
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id.
    id: "runway", display_name: "Runway", category: "tool_gateway",
    credential_refs: ["JARVIS_RUNWAY_API_KEY"],
    live_test: { tool_id: "runway", action: "get_account_info", parameters: () => ({}) }
  },
  {
    // D-323 (bygget, flyttet ut av backlog): ANDRE video-gen-connector,
    // SAMME WebSearch-sekundærkilde-krysssjekk-disiplin D-322/Runway
    // etablerte. STRUKTURELT ANNERLEDES autentisering enn ALLE andre
    // connectorer i registeret: en selv-generert, kortlevd JWT (HS256)
    // signert med et Access Key/Secret Key-par - IKKE en statisk
    // Bearer-token videresendt uendret. Se KlingTransport sin
    // doc-kommentar i live-transports.ts for full evidens-kategorisering
    // og signeringsdetaljer. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id.
    // credential_refs utvidet fra ÉN til TO nøkler (Access Key/Secret
    // Key er BEGGE reelle credentials hos Kling, samme "list alle
    // nødvendige verdier"-disiplin som D-245/D-246/D-295). BEVISST INGEN
    // live_test - se D-323 i DECISIONS_AND_ASSUMPTIONS.md for hvorfor.
    id: "kling", display_name: "Kling", category: "tool_gateway",
    credential_refs: ["JARVIS_KLING_SECRET_KEY", "JARVIS_KLING_ACCESS_KEY"]
  },
  {
    // D-324 (bygget, flyttet ut av backlog): TREDJE video-gen-connector,
    // SAMME WebSearch-sekundærkilde-krysssjekk-disiplin D-322/D-323
    // etablerte. Google Veo kjøres over den SAMME Gemini API-vertsnavn/
    // auth-formen (`generativelanguage.googleapis.com`, `x-goog-api-key`)
    // som `gemini` sin EKSISTERENDE model_provider-oppføring
    // (packages/provider-adapters/src/gemini.ts) - MEN `predictLongRunning`
    // er en STRUKTURELT ULIK kapabilitet (videogenerering, ikke
    // tekst-fullføring via `generateContent`) - egen `tool_id` her, SAMME
    // presedens som OpenAI Images (D-316) fikk for `openai`. Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id. Se GoogleVeoTransport sin doc-kommentar i
    // live-transports.ts for full evidens-kategorisering.
    id: "google_veo", display_name: "Google Veo", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_VEO_API_KEY"],
    live_test: { tool_id: "google_veo", action: "list_models", parameters: () => ({}) }
  },
  {
    // D-316 (bygget, flyttet ut av backlog): egen tool_id fra `openai` sin
    // model_provider-oppføring (ModelGateway) - bildegenerering, ikke
    // tekst-fullføring. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-disiplinen).
    id: "openai_images", display_name: "OpenAI Images", category: "tool_gateway",
    credential_refs: ["JARVIS_OPENAI_IMAGES_API_KEY"],
    live_test: { tool_id: "openai_images", action: "list_models", parameters: () => ({}) }
  },

  // §4.8 Musikk
  {
    // D-313 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // REFRESH_TOKEN (den faktiske, roterte secreten - CLIENT_ID/SECRET er
    // delt app-konfig, SAMME oppdeling som Google-familien). Oppdatert i
    // place (var en D-232 backlog-plassholder) - ALDRI en ny, separat
    // oppføring med samme id (D-293-disiplinen).
    id: "spotify", display_name: "Spotify", category: "tool_gateway",
    credential_refs: ["JARVIS_SPOTIFY_CLIENT_ID", "JARVIS_SPOTIFY_CLIENT_SECRET", "JARVIS_SPOTIFY_REFRESH_TOKEN"],
    live_test: { tool_id: "spotify", action: "get_currently_playing", parameters: () => ({}) }
  },
  { id: "apple_music", display_name: "Apple Music", category: "backlog", credential_refs: ["JARVIS_APPLE_MUSIC_TOKEN"] },

  // §4.9 Automatisering / workflow
  {
    // D-311 (bygget, flyttet ut av backlog): `X-N8N-API-KEY`-header (IKKE
    // Bearer) mot n8n sitt REST-API v1. TYPISK selv-hostet (SAMME mønster
    // som Grafana D-305/Prometheus D-306) - base-URL må konfigureres.
    // `activate_workflow` er en EKTE klasse B-skrivehandling (D-41).
    // Oppdatert i place (var en D-232 backlog-plassholder) - ALDRI en ny,
    // separat oppføring med samme id (D-293-disiplinen).
    id: "n8n", display_name: "n8n", category: "tool_gateway", credential_refs: ["JARVIS_N8N_API_KEY", "JARVIS_N8N_API_BASE_URL"],
    live_test: { tool_id: "n8n", action: "list_workflows", parameters: () => ({}) }
  },
  {
    // D-338 (bygget, flyttet ut av backlog - Tobias direkte i chat: "ja bygg
    // mcp zapier") + D-350 (2026-09-30: `call_tool` bygget, Q-40 (b) løst -
    // Tobias valgte klasse D som standard for ALLE dynamisk oppdagede
    // verktøy, eksplisitt spurt via AskUserQuestion). `credential_ref` er
    // selve MCP-server-URL-en (Zapier provisjonerer den PER BRUKER,
    // hemmelighets-ekvivalent) - IKKE en separat API-nøkkel som den gamle
    // plassholderen antok. `tool_id` er "mcp_zapier" (ikke "zapier") for å
    // gjøre den strukturelle grensen eksplisitt: dette er en GENERELL
    // MCP-klient-kapabilitet konfigurert MOT Zapier sin server, ikke en
    // Zapier-spesifikk API-integrasjon. `live_test` bruker FORTSATT KUN
    // `list_tools` (read-only discovery) - `call_tool` er klasse D og skal
    // ALDRI trigges av en "trygg tilkoblingstest". Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-disiplinen).
    id: "zapier", display_name: "Zapier (MCP)", category: "tool_gateway",
    credential_refs: ["JARVIS_MCP_ZAPIER_SERVER_URL"],
    live_test: { tool_id: "mcp_zapier", action: "list_tools", parameters: () => ({}) }
  },
  {
    // D-315 (bygget, flyttet ut av backlog): `credential_refs` utvidet med
    // API_BASE_URL (zone-spesifikk, SAMME "list alle nødvendige
    // verdier"-disiplin som n8n D-311). Oppdatert i place (var en D-232
    // backlog-plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-disiplinen).
    id: "make", display_name: "Make", category: "tool_gateway",
    credential_refs: ["JARVIS_MAKE_API_KEY", "JARVIS_MAKE_API_BASE_URL"],
    live_test: { tool_id: "make", action: "get_current_user", parameters: () => ({}) }
  },
  { id: "apple_shortcuts", display_name: "Apple Shortcuts", category: "backlog", credential_refs: ["JARVIS_APPLE_SHORTCUTS_TOKEN"] },

  // §4.10 Smart hjem
  {
    // D-388 (lukker JARVIS-061/D-336): ekte `HomeAssistantTransport` bak `homeAssistantTools()` (tool_id
    // "home-assistant"). `JARVIS_HA_BASE_URL` (f.eks. http://homeassistant.local:8123) og romkartet `JARVIS_HA_ROOMS`
    // (JSON: site_id → room_id → {light, climate, lock, alarm} entity-id-er) er konfig, ikke hemmeligheter, men listes
    // så dashbordet kan sette dem. `list_states` er en ren lesing og trygg tilkoblingstest.
    id: "home_assistant", display_name: "Home Assistant", category: "tool_gateway",
    credential_refs: ["JARVIS_HA_TOKEN", "JARVIS_HA_BASE_URL", "JARVIS_HA_ROOMS"],
    live_test: { tool_id: "home-assistant", action: "list_states", parameters: () => ({ domain: "light" }) }
  },
  { id: "homekit", display_name: "HomeKit", category: "backlog", credential_refs: ["JARVIS_HOMEKIT_TOKEN"] },
  // D-336: 'philips_hue' sin plassholder FJERNET HELT - ALLEREDE_DEKKET.
  // Enhetsstyring går via Home Assistant (INTEGRATIONS.md §5, CLAUDE.md regel
  // 5), IKKE en direkte Hue-connector - `homeAssistantTools()` (home-
  // assistant.ts) dekker allerede light_set/climate_set/lock_set/alarm_set/
  // read_state. SAMME "ALLEREDE_DEKKET, ingen egen connector"-presedens som
  // microsoft_365 (D-318). `homekit` (Apple sin egen HAP-protokoll,
  // STRUKTURELT ULIK Home Assistant sitt REST/WebSocket-API) forblir - hører
  // til D-36 Apple-runtime-sporet, IKKE denne rydden.

  // §4.11 Finans / CRM / ads / prosjektstyring
  { id: "folio", display_name: "Folio", category: "backlog", credential_refs: ["JARVIS_FOLIO_API_KEY"] },
  // D-329 til D-334: alle seks D-64-port-krevende leverandørene faktisk bygget
  // (D-291 stengte selve porten) - kun transport-laget, se
  // TodoistTransport/TrelloTransport/JiraTransport/LinearTransport/
  // HubSpotTransport/PipedriveTransport sine doc-kommentarer i
  // live-transports.ts for hva som BEVISST gjenstår.
  // D-335: Meta Ads sin plassholder er FJERNET HELT herfra (IKKE bygget som
  // en generisk ToolGateway-connector) - den er en Growth Core-ADAPTER
  // (D-64), SAMME arkitektur/sporing som googleads (heller ALDRI i dette
  // registeret) - se MetaAdsTransport i modules/growth/src/meta-ads-
  // transport.ts og firstWaveTools() sin metaads.*-namespace i
  // integrations.ts i stedet.

  // §4.12 Kart
  {
    // D-298 (bygget, flyttet ut av backlog): SJETTE slice. BEVISST AVGRENSET
    // til KUN Geocoding - `google_places`/`google_routes` er separate,
    // fortsatt ubygde id-er med egne credential_refs, IKKE konflatert inn
    // her. `geocode` brukes som `live_test` (Google sitt eget kjente
    // eksempel-adresse, trygt, sideeffekt-fritt). Oppdatert i place (var en
    // D-232 backlog-plassholder) - ALDRI en ny, separat oppføring med samme
    // id (D-293-lærdommen).
    id: "google_maps", display_name: "Google Maps", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_MAPS_API_KEY"],
    live_test: { tool_id: "google_maps", action: "geocode", parameters: () => ({ address: "1600 Amphitheatre Parkway, Mountain View, CA" }) }
  },
  {
    // D-303 (bygget, flyttet ut av backlog): samme domenesjekk allerede kjørt
    // for Google Maps (D-298) - stateless tredjeparts-stedoppslag, IKKE
    // eierens egen posisjon/geofence (`modules/location`). Bruker det
    // ELDRE, langvarig stabile Places-API-et (`maps.googleapis.com/maps/api/
    // place/...`, `key`-query-parameter), SAMME autentiseringsform som
    // `GoogleMapsTransport` - IKKE det nyere v1 Places-API-et (som krever et
    // helt annet felt-maske-/header-basert auth-mønster). Oppdatert i place
    // (var en D-232 backlog-plassholder) - ALDRI en ny, separat oppføring
    // med samme id (D-293-lærdommen).
    id: "google_places", display_name: "Google Places", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_PLACES_API_KEY"],
    live_test: { tool_id: "google_places", action: "search_places", parameters: () => ({ query: "Eiffel Tower" }) }
  },
  {
    // D-304 (bygget, flyttet ut av backlog): samme domenesjekk allerede kjørt
    // for Google Maps (D-298)/Google Places (D-303) - stateless tredjeparts-
    // rute-oppslag, IKKE eierens egen posisjon/geofence (`modules/location`).
    // Bruker det ELDRE, langvarig stabile Directions-API-et
    // (`maps.googleapis.com/maps/api/directions/...`, `key`-query-parameter),
    // SAMME autentiseringsform som `GoogleMapsTransport`/`GooglePlacesTransport`
    // - IKKE det nyere v2 Routes-API-et (`routes.googleapis.com`, felt-maske-/
    // header-basert auth). Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "google_routes", display_name: "Google Routes", category: "tool_gateway",
    credential_refs: ["JARVIS_GOOGLE_ROUTES_API_KEY"],
    live_test: { tool_id: "google_routes", action: "get_directions", parameters: () => ({ origin: "Paris, France", destination: "Versailles, France" }) }
  },

  // §4.13 Observability
  {
    // D-297 (bygget, flyttet ut av backlog): FEMTE slice. Organisasjons-slug
    // (`JARVIS_SENTRY_ORG_SLUG`) lagt til her - samme "credential_refs må
    // liste ALLE nødvendige verdier" som Twilio (D-295) sin From-nummer-
    // regel. `update_issue` er skrivehandlingen (klasse B - status-endring,
    // reversibel/idempotent, ALDRI en ekte tilkoblingstest). `list_projects`
    // brukes som `live_test` - trygt, sideeffekt-fritt, krever ingen
    // forhåndskjent issue-id. Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "sentry", display_name: "Sentry", category: "tool_gateway",
    credential_refs: ["JARVIS_SENTRY_API_TOKEN", "JARVIS_SENTRY_ORG_SLUG"],
    live_test: { tool_id: "sentry", action: "list_projects", parameters: () => ({}) }
  },
  {
    // D-305 (bygget, flyttet ut av backlog): Grafana er TYPISK selv-hostet
    // (ingen fast SaaS-domene som sentry.io) - `JARVIS_GRAFANA_API_BASE_URL`
    // lagt til `credential_refs` (samme "credential_refs må liste ALLE
    // nødvendige verdier"-disiplin som D-245/D-246 sine Vipps MSN/Wallester
    // ACCOUNT_ID). Oppdatert i place (var en D-232 backlog-plassholder) -
    // ALDRI en ny, separat oppføring med samme id (D-293-lærdommen).
    id: "grafana", display_name: "Grafana", category: "tool_gateway",
    credential_refs: ["JARVIS_GRAFANA_API_KEY", "JARVIS_GRAFANA_API_BASE_URL"],
    live_test: { tool_id: "grafana", action: "search_dashboards", parameters: () => ({}) }
  },
  {
    // D-306 (bygget, flyttet ut av backlog): SAMME "typisk selv-hostet"-
    // struktur som Grafana (D-305) - `JARVIS_PROMETHEUS_API_BASE_URL` lagt
    // til `credential_refs` (samme "credential_refs må liste ALLE nødvendige
    // verdier"-disiplin). Oppdatert i place (var en D-232 backlog-
    // plassholder) - ALDRI en ny, separat oppføring med samme id
    // (D-293-lærdommen).
    id: "prometheus", display_name: "Prometheus", category: "tool_gateway",
    credential_refs: ["JARVIS_PROMETHEUS_TOKEN", "JARVIS_PROMETHEUS_API_BASE_URL"],
    live_test: { tool_id: "prometheus", action: "query", parameters: () => ({ query: "up" }) }
  },

  // §4.15 OS / enhet (Windows/macOS er BEVISST UTELATT - IKKE EN CONNECTOR, Q-39)
  { id: "apns", display_name: "Apple Push Notification service", category: "backlog", credential_refs: ["JARVIS_APNS_AUTH_KEY"] },
  { id: "ios_shortcuts", display_name: "iOS Shortcuts", category: "backlog", credential_refs: ["JARVIS_IOS_SHORTCUTS_TOKEN"] },
  { id: "apple_watch", display_name: "Apple Watch", category: "backlog", credential_refs: ["JARVIS_APPLE_WATCH_TOKEN"] }
];

export interface ConnectorStatus {
  id: string;
  display_name: string;
  category: ConnectorDefinition["category"];
  /** true kun når ALLE påkrevde credential-referanser er konfigurert. */
  configured: boolean;
  /** Per-referanse presence, i SAMME rekkefølge som `credential_refs` - ALDRI selve verdien. */
  credentials: Array<{ ref: string; configured: boolean }>;
  test_method: "live" | "presence_only";
  health: { state: string; at: string; detail?: string } | null;
}

/**
 * `gateway` brukes UTELUKKENDE for `hasSecret()` (presence, aldri verdi) og
 * det allerede eksponerte `health`-kartet (BO-03) - INGEN nye kall gjøres her,
 * `live_test` er metadata BÅDE den eksplisitte "test connector"-handlingen
 * (`owner_controls.test_connector`, D-213) OG `ConnectorHealthSweep`
 * (`connector-health-sweep.ts`, D-242) bruker for å avgjøre hva de faktisk
 * skal kalle - selve kallet/skrivingen til `health`-kartet skjer ALLTID
 * inne i `ToolGateway.execute()` selv (SAMME sted for BEGGE kallerne), aldri
 * her.
 */
export async function listConnectorStatus(
  gateway: Pick<ToolGateway, "hasSecret" | "health">
): Promise<ConnectorStatus[]> {
  return Promise.all(
    CONNECTOR_REGISTRY.map(async (def) => {
      const credentials = await Promise.all(
        def.credential_refs.map(async (ref) => ({ ref, configured: await gateway.hasSecret(ref) }))
      );
      return {
        id: def.id, display_name: def.display_name, category: def.category,
        configured: credentials.every((c) => c.configured),
        credentials,
        test_method: def.live_test ? "live" : "presence_only",
        health: gateway.health.get(def.live_test?.tool_id ?? def.id) ?? null
      };
    })
  );
}
