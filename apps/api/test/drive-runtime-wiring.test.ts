import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16): `GoogleDriveTransport` var
 * implementert og host-akseptanse-bevist (D-42, run_id `2703299e`), men
 * ALDRI wiret inn i den normale `apps/api/src/main.ts`/`worker-main.ts`
 * sine `firstWaveTools({...})`-kall - Drive-verktøyene var derfor reelt
 * uoppnåelige fra en løpende api/worker-prosess (kun `ua2-p1a-live.ts`
 * kunne nå dem). `main.ts`/`worker-main.ts` er top-level side-effekt-
 * skript (kobler til DB og starter en server/lytter idet de importeres) -
 * samme "kan IKKE trygt importeres direkte i en testfil"-presedens som
 * `db-role-wiring.test.ts` - denne suiten verifiserer wiringen som en
 * tekst-/regresjonsvakt i stedet.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: apps/api/src/main.ts sprer driveTransportsIfConfigured() inn i firstWaveTools()", () => {
  it("importerer driveTransportsIfConfigured fra @jarvis/tool-gateway", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*driveTransportsIfConfigured[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });
  it("kaller ...driveTransportsIfConfigured() INNI firstWaveTools({...})-kallet - ikke et separat, parallelt registreringssted", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("...driveTransportsIfConfigured()");
    // De fire eksisterende transportene forblir UBETINGET konstruert - uendret fra før denne fiksen:
    expect(callBlock).toContain("email: new GmailTransport()");
    expect(callBlock).toContain("calendar: new GoogleCalendarTransport()");
    // D-97: GithubTransport tar naa en wired GithubRateLimitController - ikke lenger tom konstruktør.
    expect(callBlock).toContain("github: new GithubTransport(githubRateLimitController)");
    // D-247: telegram sin chatId sendes nå som en resolver mot readSecretProvider -
    // ikke lenger en bokstavelig tom konstruktør her.
    expect(callBlock).toMatch(/telegram: new TelegramTransport\(\(\) => readSecretProvider\.get\("JARVIS_TELEGRAM_CHAT_ID"\)\)/);
    // D-248: VercelTransport fantes aldri. D-388: tar nå en teamId-resolver (prefiks-match under);
    // samme mønster som email/calendar/docker.
    expect(callBlock).toContain("vercel: new VercelTransport(");
    // UA-3 P0 (D-49): femte ubetingede transport - Business OS har ingen ekstern credential
    // aa vaere "konfigurert" av, saa den registreres alltid, samme mønster som de fire over.
    // UA-3 next slice (D-53): BusinessTransport tar naa ogsaa OpenLoopService + pool.
    // UA-3 business-event-linkage (D-57): BusinessTransport tar naa ogsaa toolGateway
    // (sync_business_events maa kunne kalle email/calendar via SAMME gateway-instans).
    // UA-3 profiling/scoring-slice (D-61): BusinessTransport tar naa ogsaa ScoringService
    // (score-handlingene, sjette konstruktørparameter).
    expect(callBlock).toMatch(/business: new BusinessTransport\(\s*businessService, openLoopService, pool, toolGateway, scoringService,\s*\[marketingMemoryBriefSource\(growthService\)\]\s*\)/);
  });
});

describe("B: apps/api/src/worker-main.ts speiler NØYAKTIG samme wiring som main.ts", () => {
  it("importerer driveTransportsIfConfigured fra @jarvis/tool-gateway", () => {
    expect(workerSource).toMatch(/import\s*\{[^}]*driveTransportsIfConfigured[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });
  it("kaller ...driveTransportsIfConfigured() INNI firstWaveTools({...})-kallet", () => {
    const callIdx = workerSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = workerSource.slice(callIdx, workerSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("...driveTransportsIfConfigured()");
    expect(callBlock).toContain("email: new GmailTransport()");
    expect(callBlock).toContain("calendar: new GoogleCalendarTransport()");
    // D-97: GithubTransport tar naa en wired GithubRateLimitController - ikke lenger tom konstruktør.
    expect(callBlock).toContain("github: new GithubTransport(githubRateLimitController)");
    // D-181 (BLOCKER B1, D184): worker-main.ts (KUN worker, ikke main.ts) hoister
    // TelegramTransport til en navngitt konstant `telegramTransport` FØR dette kallet,
    // slik at NØYAKTIG SAMME instans deles med WatchdogEmergencyAlertSink (se
    // w1-production-wiring.test.ts for den dedikerte hoisting-/delings-verifiseringen).
    // Ikke lenger en bokstavelig `new TelegramTransport()` HER - bevisst divergens fra
    // main.ts (som forblir uendret, D-180).
    // D-247: chatId sendes nå som en resolver mot toolSecretProvider (samme
    // bug-klasse/fiks som D-246) - ikke lenger en tom konstruktør her heller.
    expect(workerSource).toMatch(/const telegramTransport = new TelegramTransport\(\(\) => toolSecretProvider\.get\("JARVIS_TELEGRAM_CHAT_ID"\)\);/);
    expect(callBlock).toContain("telegram: telegramTransport");
    expect(callBlock).not.toContain("telegram: new TelegramTransport()");
    // D-248: identisk VercelTransport-wiring som main.ts.
    expect(callBlock).toContain("vercel: new VercelTransport(");
    // UA-3 business-event-linkage (D-57): BusinessTransport tar naa ogsaa toolGateway
    // (sync_business_events maa kunne kalle email/calendar via SAMME gateway-instans).
    // UA-3 profiling/scoring-slice (D-61): BusinessTransport tar naa ogsaa ScoringService.
    expect(callBlock).toMatch(/business: new BusinessTransport\(\s*businessService, openLoopService, pool, toolGateway, scoringService,\s*\[marketingMemoryBriefSource\(growthService\)\]\s*\)/);
  });
});

describe("K: api og worker sine firstWaveTools()-kall bruker BOKSTAVELIG TALT samme spredningsuttrykk - kan strukturelt ikke divergere", () => {
  it("begge kaller EKSAKT '...driveTransportsIfConfigured()' - samme delte funksjon, ingen duplisert credential-sjekk", () => {
    const mainCallIdx = mainSource.indexOf("firstWaveTools({");
    const mainBlock = mainSource.slice(mainCallIdx, mainSource.indexOf("})) toolGateway.register(tool);", mainCallIdx));
    const workerCallIdx = workerSource.indexOf("firstWaveTools({");
    const workerBlock = workerSource.slice(workerCallIdx, workerSource.indexOf("})) toolGateway.register(tool);", workerCallIdx));
    expect(mainBlock).toContain("...driveTransportsIfConfigured()");
    expect(workerBlock).toContain("...driveTransportsIfConfigured()");
  });
  it("ingen av filene definerer sin EGEN credential-tilstedeværelse-sjekk (f.eks. en lokal 'JARVIS_GOOGLE_CLIENT_ID &&'-betingelse) - all logikk bor i den delte funksjonen", () => {
    expect(mainSource).not.toMatch(/JARVIS_GOOGLE_CLIENT_ID/);
    expect(workerSource).not.toMatch(/JARVIS_GOOGLE_CLIENT_ID/);
  });
});

describe("I: eksisterende Google Calendar/Gmail (+ GitHub/Telegram/Docker) wiring er UENDRET av denne fiksen", () => {
  // D-97: GithubTransport tar naa en wired GithubRateLimitController-argument -
  // teller derfor IKKE lenger som en "tom konstruktør" (matches separat under).
  // D-105: docker: new DockerTransport() lagt til - EN NY, fjerde tom-konstruktør-
  // transport (bevisst tellet med her, ikke et regresjonsfunn).
  // D-337: gce: new GceTransport() lagt til - SAMME tom-konstruktør-form som
  // DockerTransport (valgfri, env-lest konstruktørparameter, KALT UTEN
  // argumenter ved wiring-stedet) - teller derfor MED, 24→25.
  // D-338: mcp_zapier: new McpZapierTransport() lagt til - SAMME tom-
  // konstruktør-form (selve URL-en kommer via credential_ref, ikke
  // konstruktøren) - teller derfor MED, 25→26.
  // D-339: browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"]) lagt til - SAMME tom-
  // konstruktør-form (base-URL-en kommer via credential_ref) - teller
  // derfor MED, 26→27.
  // Remediering del 2 (JARVIS-008): browser ttar nå tjeneste-token-hemmeligheten som konstruktørargument
  // (`new BrowserGatewayTransport(secret)`) - ikke lenger en tom konstruktør, teller derfor IKKE med: 27→26.
  it("main.ts sin firstWaveTools()-blokk inneholder fortsatt de samme ubetingede tomme-konstruktør-transportene som før (+docker D-105, +vercel D-242/D-248, +slack D-292, +discord D-294, +brave_search D-296, +google_maps D-298, +google_sheets D-299, +tavily D-301, +exa D-302, +google_places D-303, +google_routes D-304, +dropbox D-307, +notion D-308, +onedrive D-309, +microsoft_outlook D-310, +spotify D-313, +openai_images D-316, +runway D-322, +google_veo D-324, +todoist D-329, +linear D-332, +hubspot D-333, +gce D-337, +mcp_zapier D-338, +browser D-339) - telegram er BEVISST gått fra 4 til 3 her av D-247 (chatId er nå en resolver-parameter, ikke lenger en tom konstruktør); twilio D-295/sentry D-297/grafana D-305/prometheus D-306/n8n D-311/whatsapp D-314/make D-315/telnyx D-321/kling D-323/higgsfield D-327/trello D-330/jira D-331/pipedrive D-334 teller HELLER IKKE med (samme resolver-argument-form som telegram, ikke en tom konstruktør)", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    const unconditionalConstructions = [...callBlock.matchAll(/:\s*new \w+Transport\(\)/g)];
    // D-388: dropbox/onedrive/microsoft_outlook/spotify/vercel tar nå refresh-/auth-/teamId-argumenter
    // (resolver-form, samme som telegram) - teller ikke lenger som tomme konstruktører: 26→21.
    expect(unconditionalConstructions).toHaveLength(21);
    expect(callBlock).toContain("github: new GithubTransport(githubRateLimitController)");
    expect(callBlock).toContain("docker: new DockerTransport()");
    expect(callBlock).toContain("gce: new GceTransport()");
    expect(callBlock).toContain("mcp_zapier: new McpZapierTransport()");
    expect(callBlock).toContain('browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? "")');
    expect(callBlock).toContain("vercel: new VercelTransport(");
    expect(callBlock).toContain("slack: new SlackTransport()");
    expect(callBlock).toContain("discord: new DiscordTransport()");
    expect(callBlock).toContain("brave_search: new BraveSearchTransport()");
    expect(callBlock).toContain("google_maps: new GoogleMapsTransport()");
    expect(callBlock).toContain("google_sheets: new GoogleSheetsTransport()");
    expect(callBlock).toContain("tavily: new TavilyTransport()");
    expect(callBlock).toContain("exa: new ExaTransport()");
    expect(callBlock).toContain("google_places: new GooglePlacesTransport()");
    expect(callBlock).toContain("google_routes: new GoogleRoutesTransport()");
    expect(callBlock).toContain("dropbox: new DropboxTransport({");
    expect(callBlock).toContain("notion: new NotionTransport()");
    expect(callBlock).toContain("onedrive: new OneDriveTransport(microsoftGraphAuth)");
    expect(callBlock).toContain("microsoft_outlook: new MicrosoftOutlookTransport(microsoftGraphAuth)");
    expect(callBlock).toContain("spotify: new SpotifyTransport({");
    expect(callBlock).toMatch(/telegram: new TelegramTransport\(\(\) => readSecretProvider\.get\("JARVIS_TELEGRAM_CHAT_ID"\)\)/);
    expect(callBlock).toMatch(/twilio: new TwilioTransport\(\s*\(\) => readSecretProvider\.get\("JARVIS_TWILIO_ACCOUNT_SID"\),\s*\(\) => readSecretProvider\.get\("JARVIS_TWILIO_FROM_NUMBER"\)\s*\)/);
    expect(callBlock).toMatch(/sentry: new SentryTransport\(\(\) => readSecretProvider\.get\("JARVIS_SENTRY_ORG_SLUG"\)\)/);
    expect(callBlock).toMatch(/grafana: new GrafanaTransport\(\(\) => readSecretProvider\.get\("JARVIS_GRAFANA_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/prometheus: new PrometheusTransport\(\(\) => readSecretProvider\.get\("JARVIS_PROMETHEUS_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/n8n: new N8nTransport\(\(\) => readSecretProvider\.get\("JARVIS_N8N_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/whatsapp: new WhatsAppTransport\(\(\) => readSecretProvider\.get\("JARVIS_WHATSAPP_PHONE_NUMBER_ID"\)\)/);
    expect(callBlock).toMatch(/make: new MakeTransport\(\(\) => readSecretProvider\.get\("JARVIS_MAKE_API_BASE_URL"\)\)/);
    expect(callBlock).toContain("openai_images: new OpenAIImagesTransport()");
    expect(callBlock).toMatch(/telnyx: new TelnyxTransport\(\(\) => readSecretProvider\.get\("JARVIS_TELNYX_FROM_NUMBER"\)\)/);
    expect(callBlock).toContain("runway: new RunwayTransport()");
    expect(callBlock).toMatch(/kling: new KlingTransport\(\(\) => readSecretProvider\.get\("JARVIS_KLING_ACCESS_KEY"\)\)/);
    expect(callBlock).toContain("google_veo: new GoogleVeoTransport()");
    expect(callBlock).toMatch(/higgsfield: new HiggsfieldTransport\(\(\) => readSecretProvider\.get\("JARVIS_HIGGSFIELD_KEY_ID"\)\)/);
    expect(callBlock).toContain("todoist: new TodoistTransport()");
    expect(callBlock).toMatch(/trello: new TrelloTransport\(\(\) => readSecretProvider\.get\("JARVIS_TRELLO_API_KEY"\)\)/);
    expect(callBlock).toMatch(/jira: new JiraTransport\(\s*\(\) => readSecretProvider\.get\("JARVIS_JIRA_BASE_URL"\),\s*\(\) => readSecretProvider\.get\("JARVIS_JIRA_EMAIL"\)\s*\)/);
    expect(callBlock).toContain("linear: new LinearTransport()");
    expect(callBlock).toContain("hubspot: new HubSpotTransport()");
    expect(callBlock).toMatch(/pipedrive: new PipedriveTransport\(\(\) => readSecretProvider\.get\("JARVIS_PIPEDRIVE_BASE_URL"\)\)/);
  });
  it("worker-main.ts sin firstWaveTools()-blokk inneholder fortsatt de samme ubetingede transportene som før (+docker D-105, +vercel D-242/D-248, +slack D-292, +discord D-294, +brave_search D-296, +google_maps D-298, +google_sheets D-299, +tavily D-301, +exa D-302, +google_places D-303, +google_routes D-304, +dropbox D-307, +notion D-308, +onedrive D-309, +microsoft_outlook D-310, +spotify D-313, +openai_images D-316, +runway D-322, +google_veo D-324, +todoist D-329, +linear D-332, +hubspot D-333, +gce D-337, +mcp_zapier D-338, +browser D-339) - telegram er BEVISST hoistet til en delt konstant av D-181/D184, ikke lenger en bokstavelig tom-konstruktør her; twilio D-295/sentry D-297/grafana D-305/prometheus D-306/n8n D-311/whatsapp D-314/make D-315/telnyx D-321/kling D-323/higgsfield D-327/trello D-330/jira D-331/pipedrive D-334 teller heller ikke med, samme begrunnelse som main.ts", () => {
    const callIdx = workerSource.indexOf("firstWaveTools({");
    const callBlock = workerSource.slice(callIdx, workerSource.indexOf("})) toolGateway.register(tool);", callIdx));
    const unconditionalConstructions = [...callBlock.matchAll(/:\s*new \w+Transport\(\)/g)];
    // D-181/D184: telegram gikk fra en bokstavelig tom-konstruktør (`new TelegramTransport()`
    // inni dette kallet) til en referanse til en hoistet, delt konstant - main.ts (describe "I"
    // sin FØRSTE test, over) teller telegram heller ikke med (D-247: begge har nå en
    // resolver-/referanseform, ikke en tom konstruktør) - derfor SAMME tall (27, D-292: +slack,
    // D-294: +discord, D-296: +brave_search, D-298: +google_maps, D-299: +google_sheets, D-301:
    // +tavily, D-302: +exa, D-303: +google_places, D-304: +google_routes, D-307: +dropbox, D-308:
    // +notion, D-309: +onedrive, D-310: +microsoft_outlook, D-313: +spotify, D-316: +openai_images,
    // D-322: +runway, D-324: +google_veo, D-329: +todoist, D-332: +linear, D-333: +hubspot, D-337:
    // +gce, D-338: +mcp_zapier, D-339: +browser) i begge filer, selv om de to filene fortsatt
    // divergerer paa HVORDAN telegram konstrueres (hoistet konstant vs. inline), se describe "B".
    // D-295/D-297/D-305/D-311/D-314/D-315/D-321/D-323/D-330/D-331/D-334:
    // twilio/sentry/grafana/prometheus/n8n/whatsapp/make/telnyx/kling/trello/jira/pipedrive har
    // SAMME resolver-argument-form som telegram - teller heller ikke med her.
    // D-388: dropbox/onedrive/microsoft_outlook/spotify/vercel har nå også resolver-/auth-argumenter: 26→21.
    expect(unconditionalConstructions).toHaveLength(21);
    expect(callBlock).toContain("email: new GmailTransport()");
    expect(callBlock).toContain("calendar: new GoogleCalendarTransport()");
    expect(callBlock).toContain("github: new GithubTransport(githubRateLimitController)");
    expect(callBlock).toContain("docker: new DockerTransport()");
    expect(callBlock).toContain("gce: new GceTransport()");
    expect(callBlock).toContain("mcp_zapier: new McpZapierTransport()");
    expect(callBlock).toContain('browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? "")');
    expect(callBlock).toContain("vercel: new VercelTransport(");
    expect(callBlock).toContain("slack: new SlackTransport()");
    expect(callBlock).toContain("brave_search: new BraveSearchTransport()");
    expect(callBlock).toContain("google_maps: new GoogleMapsTransport()");
    expect(callBlock).toContain("google_sheets: new GoogleSheetsTransport()");
    expect(callBlock).toContain("tavily: new TavilyTransport()");
    expect(callBlock).toContain("exa: new ExaTransport()");
    expect(callBlock).toContain("google_places: new GooglePlacesTransport()");
    expect(callBlock).toContain("google_routes: new GoogleRoutesTransport()");
    expect(callBlock).toContain("dropbox: new DropboxTransport({");
    expect(callBlock).toContain("notion: new NotionTransport()");
    expect(callBlock).toContain("onedrive: new OneDriveTransport(microsoftGraphAuth)");
    expect(callBlock).toContain("microsoft_outlook: new MicrosoftOutlookTransport(microsoftGraphAuth)");
    expect(callBlock).toContain("spotify: new SpotifyTransport({");
    expect(callBlock).toMatch(/n8n: new N8nTransport\(\(\) => toolSecretProvider\.get\("JARVIS_N8N_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/twilio: new TwilioTransport\(\s*\(\) => toolSecretProvider\.get\("JARVIS_TWILIO_ACCOUNT_SID"\),\s*\(\) => toolSecretProvider\.get\("JARVIS_TWILIO_FROM_NUMBER"\)\s*\)/);
    expect(callBlock).toMatch(/sentry: new SentryTransport\(\(\) => toolSecretProvider\.get\("JARVIS_SENTRY_ORG_SLUG"\)\)/);
    expect(callBlock).toMatch(/grafana: new GrafanaTransport\(\(\) => toolSecretProvider\.get\("JARVIS_GRAFANA_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/prometheus: new PrometheusTransport\(\(\) => toolSecretProvider\.get\("JARVIS_PROMETHEUS_API_BASE_URL"\)\)/);
    expect(callBlock).toMatch(/whatsapp: new WhatsAppTransport\(\(\) => toolSecretProvider\.get\("JARVIS_WHATSAPP_PHONE_NUMBER_ID"\)\)/);
    expect(callBlock).toMatch(/make: new MakeTransport\(\(\) => toolSecretProvider\.get\("JARVIS_MAKE_API_BASE_URL"\)\)/);
    expect(callBlock).toContain("openai_images: new OpenAIImagesTransport()");
    expect(callBlock).toMatch(/telnyx: new TelnyxTransport\(\(\) => toolSecretProvider\.get\("JARVIS_TELNYX_FROM_NUMBER"\)\)/);
    expect(callBlock).toContain("runway: new RunwayTransport()");
    expect(callBlock).toMatch(/kling: new KlingTransport\(\(\) => toolSecretProvider\.get\("JARVIS_KLING_ACCESS_KEY"\)\)/);
    expect(callBlock).toContain("google_veo: new GoogleVeoTransport()");
    expect(callBlock).toMatch(/higgsfield: new HiggsfieldTransport\(\(\) => toolSecretProvider\.get\("JARVIS_HIGGSFIELD_KEY_ID"\)\)/);
    expect(callBlock).toContain("todoist: new TodoistTransport()");
    expect(callBlock).toMatch(/trello: new TrelloTransport\(\(\) => toolSecretProvider\.get\("JARVIS_TRELLO_API_KEY"\)\)/);
    expect(callBlock).toMatch(/jira: new JiraTransport\(\s*\(\) => toolSecretProvider\.get\("JARVIS_JIRA_BASE_URL"\),\s*\(\) => toolSecretProvider\.get\("JARVIS_JIRA_EMAIL"\)\s*\)/);
    expect(callBlock).toContain("linear: new LinearTransport()");
    expect(callBlock).toContain("hubspot: new HubSpotTransport()");
    expect(callBlock).toMatch(/pipedrive: new PipedriveTransport\(\(\) => toolSecretProvider\.get\("JARVIS_PIPEDRIVE_BASE_URL"\)\)/);
    expect(callBlock).toContain("discord: new DiscordTransport()");
    expect(callBlock).toContain("telegram: telegramTransport");
  });
});

describe("J: ingen duplisert Drive-registrering - firstWaveTools() returnerer nøyaktig ÉN ToolDefinition-liste, INGEN separat manuell toolGateway.register('drive', ...) et annet sted", () => {
  it("main.ts har KUN ett toolGateway.register(tool)-løkke-sted, ikke et ekstra Drive-spesifikt register-kall", () => {
    expect([...mainSource.matchAll(/toolGateway\.register\(/g)]).toHaveLength(1);
  });
  it("worker-main.ts har KUN ett toolGateway.register(tool)-løkke-sted, ikke et ekstra Drive-spesifikt register-kall", () => {
    expect([...workerSource.matchAll(/toolGateway\.register\(/g)]).toHaveLength(1);
  });
});

describe("L: Q-21 runtime-DB-oppførsel er urørt av denne closeout-fiksen (uendret fra db-role-wiring.test.ts sine invarianter)", () => {
  it("main.ts/worker-main.ts bruker fortsatt configFromEnv (runtime), ALDRI adminConfigFromEnv, og kaller fortsatt assertRuntimeCredentialsConfigured/assertRuntimeRoleSafe", () => {
    for (const source of [mainSource, workerSource]) {
      expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
      expect(source).not.toMatch(/adminConfigFromEnv/);
      expect(source).toMatch(/assertRuntimeCredentialsConfigured\(\)/);
      expect(source).toMatch(/assertRuntimeRoleSafe\(pool\)/);
    }
  });
});

describe("M: BO-05 daglig morgenlevering bruker DailyBrief.deliverViaTelegram() (idempotency-nøklet per chunk), ALDRI den generiske sendTelegram-closuren (D-194)", () => {
  // D-194: den generiske `sendTelegram`-closuren (delt med TelegramCommandPoller
  // sine svar) har verken idempotency-nøkkel eller sjekker gateway-resultatet -
  // en re-kjørt DailyScheduler-jobb (f.eks. etter en prosessrestart midt i en
  // flerdelt levering) kunne derfor duplisere allerede sendte deler, og en stille
  // tapt Telegram-levering ble aldri logget/oppdaget. `DailyBrief.deliverViaTelegram()`
  // nøkler hver chunk på `brief.generated_at`+indeks og returnerer `false` ved
  // første mislykkede chunk.
  it("main.ts sitt DailyScheduler(pool).start(...)-kall for morgenleveringen kaller DailyBrief.deliverViaTelegram(toolGateway, ownerIdentity, brief) - IKKE sendTelegram(DailyBrief.render(...))", () => {
    const schedulerIdx = mainSource.indexOf("BO-05: reboot-durabel morgenlevering");
    expect(schedulerIdx).toBeGreaterThan(-1);
    const block = mainSource.slice(schedulerIdx, mainSource.indexOf("\n  }", schedulerIdx));
    expect(block).toMatch(/DailyBrief\.deliverViaTelegram\(\s*toolGateway,\s*ownerIdentity as never,\s*brief\s*\)/);
    expect(block).not.toMatch(/sendTelegram\(DailyBrief\.render/);
  });

  it("logger en feil (console.error med daily_brief_delivery_failed) hvis leveringen returnerer false - stille tap er ikke tillatt", () => {
    const schedulerIdx = mainSource.indexOf("BO-05: reboot-durabel morgenlevering");
    const block = mainSource.slice(schedulerIdx, mainSource.indexOf("\n  }", schedulerIdx));
    expect(block).toMatch(/if\s*\(!delivered\)\s*\{/);
    expect(block).toContain("daily_brief_delivery_failed");
  });

  it("sendTelegram-closuren finnes fortsatt (uendret) for TelegramCommandPoller sine generiske svar - denne fiksen fjerner den IKKE, kun morgenleverings-bruken av den", () => {
    expect(mainSource).toMatch(/const sendTelegram = async \(text: string\) => \{/);
    expect(mainSource).toMatch(/\}, sendTelegram, \{[\s\S]*?\}\)\.start\(\);/);
  });
});

describe("D: alle 14 implementerte Drive-handlinger forblir registrert i firstWaveTools() (uendret siden D-41/D-42) - denne fiksen la KUN til registreringsveien inn i runtime, ikke definisjonene selv", () => {
  it("firstWaveTools({ drive: <transport> }) inneholder alle A/C/D-klasse Drive-handlingene", () => {
    const definitions = firstWaveTools({});
    const driveActions = definitions.filter((d) => d.tool_id === "drive").map((d) => d.action);
    const expectedA = ["list_files", "read_document", "get_metadata", "read_permissions"];
    const expectedC = ["create_file", "create_folder", "update_content", "rename", "move", "trash"];
    const expectedD = ["delete_permanent", "create_permission", "update_permission", "delete_permission"];
    for (const action of [...expectedA, ...expectedC, ...expectedD]) {
      expect(driveActions).toContain(action);
    }
    expect(driveActions).toHaveLength(14);
  });

  it("E: risikoklassene er uendret - A for lesing, C for reversible skriveoperasjoner, D for destruktive/tilgangsstyring", () => {
    const definitions = firstWaveTools({});
    const byAction = new Map(definitions.filter((d) => d.tool_id === "drive").map((d) => [d.action, d.capability_class]));
    expect(byAction.get("list_files")).toBe("A");
    expect(byAction.get("read_document")).toBe("A");
    expect(byAction.get("get_metadata")).toBe("A");
    expect(byAction.get("read_permissions")).toBe("A");
    expect(byAction.get("create_file")).toBe("C");
    expect(byAction.get("create_folder")).toBe("C");
    expect(byAction.get("update_content")).toBe("C");
    expect(byAction.get("rename")).toBe("C");
    expect(byAction.get("move")).toBe("C");
    expect(byAction.get("trash")).toBe("C");
    expect(byAction.get("delete_permanent")).toBe("D");
    expect(byAction.get("create_permission")).toBe("D");
    expect(byAction.get("update_permission")).toBe("D");
    expect(byAction.get("delete_permission")).toBe("D");
  });
});

describe("N: main.ts sin worker.drain()-løkke logger feil (D-196) - SAMME mekanisme som worker-main.ts, som allerede gjorde det", () => {
  // D-196 (Value Track V3-revisjon): main.ts sin drain-løkke svelget ALLTID
  // en tick()-feil stille (`.catch(() => undefined)`) mens worker-main.ts sin
  // BYTE-FOR-BYTE identiske mekanisme (samme InProcessWorker.drain()-kall,
  // samme 2000ms-intervall) allerede logget den strukturert. En feil i selve
  // tick() (DB-blipp under claim/complete/fail, IKKE en per-oppgave-handler-
  // feil - de er allerede isolert inne i tick() selv) ville stanset main.ts
  // sin "executive"-oppgavekø stille, uten varsel.
  it("main.ts sin setInterval(...worker.drain()...) logger feilen via console.error, ikke .catch(() => undefined)", () => {
    const callIdx = mainSource.indexOf("worker.drain()");
    expect(callIdx).toBeGreaterThan(-1);
    const block = mainSource.slice(mainSource.lastIndexOf("setInterval(", callIdx), mainSource.indexOf(").unref();", callIdx) + ").unref();".length);
    expect(block).not.toMatch(/\.catch\(\(\)\s*=>\s*undefined\)/);
    expect(block).toMatch(/\.catch\(\(err\)\s*=>\s*console\.error\(/);
    expect(block).toContain("drain_error");
    expect(block).toContain(".unref();");
  });

  it("worker-main.ts sin tilsvarende løkke er UENDRET (samme logging-mønster, ALDRI unref - egen dedikert prosess)", () => {
    const callIdx = workerSource.indexOf("worker\n      .drain()");
    expect(callIdx).toBeGreaterThan(-1);
    const block = workerSource.slice(workerSource.lastIndexOf("setInterval(", callIdx), workerSource.indexOf(");", callIdx) + 2);
    expect(block).toMatch(/\.catch\(\(err\)\s*=>\s*console\.error\(/);
    expect(block).toContain("drain_error");
    expect(block).not.toContain(".unref()");
  });
});

describe("O (D-222): deviceRegistry.refresh() sine to kallesteder (start + interval) logger feil, ikke .catch(() => undefined)", () => {
  it("apps/api/src/main.ts: den innledende await-refreshen OG intervall-refreshen logger strukturert", () => {
    const startIdx = mainSource.indexOf("await deviceRegistry.refresh()");
    expect(startIdx).toBeGreaterThan(-1);
    const startBlock = mainSource.slice(startIdx, mainSource.indexOf("});", startIdx) + 3);
    expect(startBlock).not.toMatch(/\.catch\(\(\)\s*=>\s*undefined\)/);
    expect(startBlock).toMatch(/\.catch\(\(err\)\s*=>\s*\{/);
    expect(startBlock).toContain("device_registry_initial_refresh_failed");

    const intervalIdx = mainSource.indexOf("setInterval(() => void deviceRegistry.refresh()");
    expect(intervalIdx).toBeGreaterThan(-1);
    const intervalBlock = mainSource.slice(intervalIdx, mainSource.indexOf(".unref();", intervalIdx) + ".unref();".length);
    expect(intervalBlock).not.toMatch(/\.catch\(\(\)\s*=>\s*undefined\)/);
    expect(intervalBlock).toContain("device_registry_refresh_tick_failed");
    expect(intervalBlock).toContain(".unref();");
  });

  it("apps/api/src/worker-main.ts: samme innledende refresh logger strukturert (ingen interval her - uendret fra før)", () => {
    const startIdx = workerSource.indexOf("await deviceRegistry.refresh()");
    expect(startIdx).toBeGreaterThan(-1);
    const startBlock = workerSource.slice(startIdx, workerSource.indexOf("});", startIdx) + 3);
    expect(startBlock).not.toMatch(/\.catch\(\(\)\s*=>\s*undefined\)/);
    expect(startBlock).toMatch(/\.catch\(\(err\)\s*=>\s*\{/);
    expect(startBlock).toContain("device_registry_initial_refresh_failed");
  });
});
