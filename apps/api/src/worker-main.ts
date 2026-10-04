// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import "./normalize-env.ts";
import { systemIdentity } from "@jarvis/contracts";
import { ownerConfigOrExit } from "./owner.ts";
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, ConfirmationStore, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { assertProvidersHaveExplicitPricing, DEFAULT_PRICING, ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  DockerTransport, EnvSecretProvider, FallbackSecretProvider, GceTransport, McpZapierTransport, BrowserGatewayTransport, GithubRateLimitController, GithubTransport, GmailTransport,
  GoogleCalendarTransport, InfisicalSecretProvider, TelegramTransport, SlackTransport, DiscordTransport, TwilioTransport, BraveSearchTransport, SentryTransport, GoogleMapsTransport, GoogleSheetsTransport, TavilyTransport, ExaTransport, GooglePlacesTransport, GoogleRoutesTransport, GrafanaTransport, PrometheusTransport, DropboxTransport, NotionTransport, OneDriveTransport, MicrosoftOutlookTransport, N8nTransport, SpotifyTransport, WhatsAppTransport, MakeTransport, OpenAIImagesTransport, TelnyxTransport, RunwayTransport, KlingTransport, GoogleVeoTransport, HiggsfieldTransport, TodoistTransport, TrelloTransport, JiraTransport, LinearTransport, HubSpotTransport, PipedriveTransport, VercelTransport, HomeAssistantTransport, MicrosoftGraphAuth, homeAssistantTools, MeshToolExecutor, resolveModelToolSurface, PgGithubRateLimitStore,
  ToolGateway, assertManifestInvariants, buildToolManifest, createTurnContext, driveTransportsIfConfigured, firstWaveTools, jobIdentityFor, telegramClassDNotifier, parseDockerMutationTargets, parseGceMutationTargets
} from "@jarvis/tool-gateway";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "@jarvis/business";
import { SupportService, SupportTransport } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { ProductService, ProductTransport } from "@jarvis/product";
import { OperationsService, OperationsTransport } from "@jarvis/operations";
import {
  FinanceService, FinanceTransport, SpendService, SpendTransport, StripeFinanceTransport, VippsFinanceTransport,
  BankingService, NeonomicsFinanceTransport,
  CardService, WallesterFinanceTransport, createRsaJwtSigner,
  type WallesterCredentials, type WallesterCredentialsProvider,
  type NeonomicsCredentials, type NeonomicsCredentialsProvider,
  type FikenCredentials, type FikenCredentialsProvider, type StripeCredentials, type StripeCredentialsProvider,
  type VippsCredentials, type VippsCredentialsProvider
} from "@jarvis/finance";
import { ConsentEnforcementService, ConsentService, ConsentTransport } from "@jarvis/consent";
import { GoogleAdsTransport, GrowthService, GrowthTransport, MetaAdsTransport, marketingMemoryBriefSource } from "@jarvis/growth";
import { executiveHandler } from "./executive.ts";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  HermesAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import {
  ArtifactStore,
  ClaudeCodeAgent,
  InProcessWorker,
  PgTaskQueue,
  allowedReposFromEnv,
  createCodingHandler,
  resolveJobSandboxRunner,
  withSecretRedaction
} from "@jarvis/tasks";
import { KnowledgeSourceRegistry, emailIngestHandler } from "@jarvis/knowledge";
import { LocalHashEmbedding } from "@jarvis/memory";
import {
  WatchdogEmergencyAlertSink, Watchdog, costExplosionCheck, databaseCheck, stuckTasksCheck,
  parseWatchdogIntervalMs, parseCostHardLimitOre
} from "@jarvis/watchdog";

// Q-21 (2026-08-15): fail-closed - en manglende/feilkonfigurert JARVIS_DB_USER, eller
// en superuser/BYPASSRLS-tilkobling, skal ALDRI la workeren starte videre stille.
function failStartup(err: unknown): never {
  console.error(JSON.stringify({ msg: "jarvis-worker startup_failed", error: (err as Error).message }));
  process.exit(1);
}
try {
  assertRuntimeCredentialsConfigured();
} catch (err) {
  failStartup(err);
}
// Remediering del 2 (JARVIS-065): ÉN validert eier-identitet (fail closed uten) - ingen env-defaults for eier/tenant.
const owner = ownerConfigOrExit();
const pool = createPool(configFromEnv());
try {
  await assertRuntimeRoleSafe(pool);
} catch (err) {
  failStartup(err);
}
const queue = new PgTaskQueue(pool);
const worker = new InProcessWorker(queue);

// BO-09 (§22): worker bruker AI Mesh gjennom ModelGateway med purpose -
// aldri provider-API direkte, aldri låst til én provider.
const gateway = new ModelGateway({
  pool,
  trace: traceSinkFromEnv("var/worker-traces.jsonl"),
  providers: [
    new OpenAiAdapter(),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    new GemmaHostedAdapter(),
    new LocalOpenAiCompatibleAdapter(),
    // D-106: samme lokal-Gemma-registrering som apps/api/src/main.ts - se der for full begrunnelse.
    new LocalOpenAiCompatibleAdapter(
      process.env["JARVIS_GEMMA_LOCAL_URL"],
      // D-340: samme tom-streng-.env-bug som apps/api/src/main.ts - se der for full begrunnelse.
      process.env["JARVIS_GEMMA_LOCAL_MODEL"] || "gemma-local",
      undefined,
      "gemma_local"
    ),
    new KimiAdapter(),
    new HermesAdapter(),
    new OllamaAdapter()
  ]
});
// JARVIS-006: hver konstruert adapter MÅ ha eksplisitt pris - ingen stille `default_rate`.
try {
  assertProvidersHaveExplicitPricing(DEFAULT_PRICING, gateway.listProviderNames());
} catch (err) {
  failStartup(err);
}

// BO-11 (§29): worker-tool-mesh gjennom SAMME trusted Tool Gateway/Policy som api -
// ingen provider/tool-bypass. Kun ufarlige read-verktøy eksponeres (mesh-bridge).
// K1 (Sovereign graduation, D-164): SAMME durable, delt `pool`+`authority`-
// wiring som apps/api/src/main.ts - `killSwitch`/`ownerControls` sin LIVE
// `*Durable()`-sjekk spør nå SAMME `owner_control_state`-tabell som
// api-prosessen, ikke en egen in-memory-kopi (se `KillSwitch` sitt filhode
// for hele begrunnelsen). `owner_controls.*`-VERKTØYET registreres BEVISST
// IKKE her (samme presedens som `situations`/`executive`, D-163/D-164
// fresh-audit: ingen eier-vendt kaller i worker-prosessen for det
// namespace-et) - kun selve autorisasjons-KONTROLLEN er delt her.
const ownerControlAuthority = { owner_person_id: owner.owner_person_id };
const killSwitch = new KillSwitch(pool, ownerControlAuthority);
await killSwitch.restore();
const ownerControls = new OwnerControls(killSwitch, pool, ownerControlAuthority);
await ownerControls.restore();
// D-104 (UA-5 Production Operations Control Plane v1): SAMME infra-gate-
// wiring-mønster som apps/api/src/main.ts. ÆRLIG begrensning (uendret fra
// den allerede eksisterende, BEVISST UTENFOR K1 sitt omfang - se D-164):
// dette er en EGEN, prosess-lokal `InfraExecutionGate`-instans - en pause
// utløst via api-prosessens `/infra/pause`-HTTP-rute endrer IKKE denne
// workerprosessens egen gate-tilstand (ingen cross-process-synkronisering
// bygget denne sliceen - se D-104 i DECISIONS_AND_ASSUMPTIONS.md).
const infraGate = new InfraExecutionGate();
// D-105: "docker" lagt til (samme rasjonale som apps/api/src/main.ts).
const infraToolIds = new Set(["github", "docker"]);
const deviceRegistry = new PgDeviceRegistry(pool, owner.tenant_id);
// D-222: samme fiks som apps/api/src/main.ts - se den for full begrunnelse.
await deviceRegistry.refresh().catch((err) => {
  console.error(JSON.stringify({
    msg: "device_registry_initial_refresh_failed",
    error: err instanceof Error ? err.message : String(err)
  }));
});
// v4.0 sovereign-owner (BO-11.1 §2-funn): samme authority-wiring som api -
// uten denne kjørte workeren i legacy SCOPED-modus for owners D-kall.
const policy = new PolicyGateway({
  devices: deviceRegistry,
  nonces: new PgApprovalStore(pool),
  killSwitch,
  // K1 (D-164): samme "tidligere dødt felt, nå håndhevet"-fiks som apps/api/src/main.ts.
  controls: ownerControls,
  infraGate,
  infraToolIds,
  authority: {
    owner_person_id: owner.owner_person_id,
    owner_tenants: [owner.tenant_id]
  }
});
// D-181 (BLOCKER B1, D184): hoistet til en NAVNGITT konstant (var tidligere
// inline i ToolGateway-konstruksjonen) slik at NØYAKTIG SAMME
// `SecretProvider`-instans også kan injiseres i `WatchdogEmergencyAlertSink`
// under - ingen ny/parallell credential-mekanisme, samme oppløsning som
// enhver ordinær `telegram.notify`-kaller.
// Task #119 (D-211): SAMME Infisical-primær/env-fallback-kjede som
// `apps/api/src/main.ts` - API/worker-parity (K1-presedens), ikke en egen,
// avvikende secret-vei for workeren.
// Task #122 (D-213): hoistet til en NAVNGITT konstant (samme presedens som
// `toolSecretProvider` over) slik at NØYAKTIG SAMME InfisicalSecretProvider-
// instans også gis inn som `ToolGateway` sitt separate `writableSecrets`-
// argument (5. posisjon) - ALDRI en ny, parallell Infisical-tilkobling.
const infisicalSecretProvider = new InfisicalSecretProvider();
const toolSecretProvider = new FallbackSecretProvider(
  infisicalSecretProvider,
  new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())
);
// Del 3 (JARVIS-013/043): samme HÅRDE klasse D-pipeline som API-prosessen (API/worker-parity); varsleren bindes rett under.
const toolGateway = new ToolGateway(pool, policy, toolSecretProvider, ownerControls, infisicalSecretProvider, {
  classDPipeline: { enforce: true },
  credentialBinding: { owner_person_id: owner.owner_person_id, owner_tenants: [owner.tenant_id], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
});
const businessService = new BusinessService(pool);
// UA-3 next slice (D-53): samme OpenLoopService-wiring som api - workeren sin
// mesh-tool-executor maa kunne kalle de nye business-handlingene identisk.
const openLoopService = new OpenLoopService(pool);
// UA-3 profiling/scoring-slice (D-61): samme ScoringService-wiring som api -
// workeren sin mesh-tool-executor maa kunne kalle score-handlingene identisk.
const scoringService = new ScoringService(pool);
// UA-3 Native Jarvis Support Core (D-66): samme SupportService-wiring som api -
// workeren sin mesh-tool-executor maa kunne kalle support.*-handlingene identisk.
const supportService = new SupportService(pool);
// UA-3 Native Jarvis Contracts Core (D-71): samme AgreementsService-wiring
// som apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne
// kalle contract.*-handlingene identisk.
const agreementsService = new AgreementsService(pool);
// UA-3 Native Jarvis Product Core (D-128): samme ProductService-wiring som
// apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne kalle
// product.*-handlingene identisk.
const productService = new ProductService(pool);
// UA-3 Native Jarvis Operations Core (D-129): samme OperationsService-
// wiring som apps/api/src/main.ts - workeren sin mesh-tool-executor maa
// kunne kalle operations.*-handlingene identisk.
const operationsService = new OperationsService(pool);
// D-91 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts.
const consentService = new ConsentService(pool);
// D-92 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts -
// konstrueres FØR growthService slik at den kan injiseres valgfritt.
const consentEnforcementService = new ConsentEnforcementService(pool, consentService);
// UA-4 Native Jarvis Growth Core (D-74): samme GrowthService-wiring som
// apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne kalle
// growth.*-handlingene identisk. D-92: consentEnforcementService injisert
// identisk med apps/api/src/main.ts.
const growthService = new GrowthService(pool, consentEnforcementService);
// UA-6 Finance & Spend Integrity Gateway (D-107): identisk wiring-mønster
// som apps/api/src/main.ts - workeren sin mesh-tool-executor maa kunne
// kalle finance.*-handlingene identisk.
// D-109 (UA-6 Slice 3): identisk wiring-mønster som apps/api/src/main.ts -
// ETT globalt eier-tilkoblet Stripe-credential-par, ingen tenant-
// parametrisert Stripe-Connect-oppslag denne sliceen.
// D-246: samme fiks som apps/api/src/main.ts - alle fire leser nå via
// toolSecretProvider (Infisical-primær, SAMME kjede hasSecret() allerede
// bruker) i stedet for rå process.env. Se main.ts sin D-246-kommentar for
// full root-cause-begrunnelse.
const stripeCredentialsProvider: StripeCredentialsProvider = {
  async getCredentials(): Promise<StripeCredentials | null> {
    const secretKey = await toolSecretProvider.get("JARVIS_STRIPE_SECRET_KEY");
    if (!secretKey) return null;
    return { secretKey };
  }
};
const stripeWebhookSecretProvider = () => process.env["JARVIS_STRIPE_WEBHOOK_SECRET"] ?? null;
const stripeTenantResolver = () => process.env["JARVIS_STRIPE_TENANT_ID"] ?? null;
// D-110 (UA-6 Slice 4): identisk wiring-mønster som apps/api/src/main.ts.
const vippsCredentialsProvider: VippsCredentialsProvider = {
  async getCredentials(): Promise<VippsCredentials | null> {
    const clientId = await toolSecretProvider.get("JARVIS_VIPPS_CLIENT_ID");
    const clientSecret = await toolSecretProvider.get("JARVIS_VIPPS_CLIENT_SECRET");
    const subscriptionKey = await toolSecretProvider.get("JARVIS_VIPPS_SUBSCRIPTION_KEY");
    const merchantSerialNumber = await toolSecretProvider.get("JARVIS_VIPPS_MSN");
    if (!clientId || !clientSecret || !subscriptionKey || !merchantSerialNumber) return null;
    return { clientId, clientSecret, subscriptionKey, merchantSerialNumber, environment: process.env["JARVIS_VIPPS_ENVIRONMENT"] === "production" ? "production" : "test" };
  }
};
const vippsWebhookSecretProvider = () => process.env["JARVIS_VIPPS_WEBHOOK_SECRET"] ?? null;
const vippsTenantResolver = () => process.env["JARVIS_VIPPS_TENANT_ID"] ?? null;
const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
  async getCredentials(): Promise<NeonomicsCredentials | null> {
    const clientId = await toolSecretProvider.get("JARVIS_NEONOMICS_CLIENT_ID");
    const clientSecret = await toolSecretProvider.get("JARVIS_NEONOMICS_CLIENT_SECRET");
    const deviceId = await toolSecretProvider.get("JARVIS_NEONOMICS_DEVICE_ID");
    if (!clientId || !clientSecret || !deviceId) return null;
    return {
      clientId, clientSecret, deviceId,
      environment: process.env["JARVIS_NEONOMICS_ENVIRONMENT"] === "production" ? "production" : "sandbox",
      ...(process.env["JARVIS_NEONOMICS_REALM"] ? { realm: process.env["JARVIS_NEONOMICS_REALM"] } : {})
    };
  }
};
const neonomicsWebhookApiKeyProvider = () => process.env["JARVIS_NEONOMICS_WEBHOOK_API_KEY"] ?? null;
const neonomicsTenantResolver = () => process.env["JARVIS_NEONOMICS_TENANT_ID"] ?? null;
// D-112 (UA-6 Slice 6), korrigert owner-provided primary-source-audit
// (PR #62 runde 4): SAMME enkelt-globale credential-mønster som main.ts -
// se main.ts sin wallesterCredentialsProvider for full begrunnelse.
const wallesterCredentialsProvider: WallesterCredentialsProvider = {
  async getCredentials(): Promise<WallesterCredentials | null> {
    const baseUrl = await toolSecretProvider.get("JARVIS_WALLESTER_API_BASE_URL");
    const apiKey = await toolSecretProvider.get("JARVIS_WALLESTER_API_KEY");
    const accountId = await toolSecretProvider.get("JARVIS_WALLESTER_ACCOUNT_ID");
    const privateKeyPem = await toolSecretProvider.get("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    if (!baseUrl || !apiKey || !accountId || !privateKeyPem) return null;
    return {
      baseUrl, apiKey, accountId,
      sign: createRsaJwtSigner(privateKeyPem),
      environment: process.env["JARVIS_WALLESTER_ENVIRONMENT"] === "production" ? "production" : "sandbox"
    };
  }
};
const wallesterWebhookBasicAuthProvider = () => {
  const username = process.env["JARVIS_WALLESTER_WEBHOOK_BASIC_USER"];
  const password = process.env["JARVIS_WALLESTER_WEBHOOK_BASIC_PASSWORD"];
  return username && password ? { username, password } : null;
};
const wallesterTenantResolver = () => process.env["JARVIS_WALLESTER_TENANT_ID"] ?? null;
const financeService = new FinanceService(
  pool, undefined, stripeCredentialsProvider, undefined, stripeWebhookSecretProvider, stripeTenantResolver,
  vippsCredentialsProvider, undefined, vippsWebhookSecretProvider, vippsTenantResolver,
  neonomicsCredentialsProvider, undefined, neonomicsWebhookApiKeyProvider, neonomicsTenantResolver
);
const bankingService = new BankingService(pool, neonomicsCredentialsProvider);
const cardService = new CardService(pool, wallesterCredentialsProvider, undefined, wallesterWebhookBasicAuthProvider, wallesterTenantResolver);
// UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): identisk
// wiring-mønster som apps/api/src/main.ts - workeren sin mesh-tool-executor
// maa kunne kalle finance_spend.*-handlingene identisk.
const spendService = new SpendService(pool);
// D-246: samme fiks som apps/api/src/main.ts.
const fikenCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    const refreshToken = await toolSecretProvider.get("JARVIS_FIKEN_REFRESH_TOKEN");
    const companySlug = await toolSecretProvider.get("JARVIS_FIKEN_COMPANY_SLUG");
    if (!refreshToken || !companySlug) return null;
    return { refreshToken, companySlug };
  }
};
// D-97: identisk wiring-mønster som apps/api/src/main.ts - SAMME pool, altsaa
// SAMME delte github_rate_limit_state-rad paa tvers av api/worker-prosessene.
const githubRateLimitController = new GithubRateLimitController(
  new PgGithubRateLimitStore(pool), "JARVIS_GITHUB_TOKEN",
  (event) => console.warn(`[github-rate-limit] ${event.transition} -> ${event.state}${event.retryAt ? ` retry_at=${event.retryAt.toISOString()} source=${event.source}` : ""}`)
);
// D-181 (BLOCKER B1, D184): hoistet (var tidligere inline i firstWaveTools()
// under) slik at NØYAKTIG SAMME `TelegramTransport`-instans også kan
// injiseres i `WatchdogEmergencyAlertSink` - samme mottaker-konfigurasjon
// (`chatId`), ingen parallell Telegram-klient.
// D-247: `chatId` sendes nå som en resolver mot `toolSecretProvider`
// (Infisical-primær, SAMME instans/kjede som `JARVIS_TELEGRAM_TOKEN` selv
// allerede leses via) - slås opp PÅ NYTT ved hvert `notify`-kall, i stedet
// for å fryses fra `process.env` ved oppstart (samme bug-klasse/fiks som
// D-246 sine fem finans-connectorer).
const telegramTransport = new TelegramTransport(() => toolSecretProvider.get("JARVIS_TELEGRAM_CHAT_ID"));
// D-388: én delt Microsoft Graph-auth for OneDrive + Outlook (identisk med apps/api/src/main.ts).
const microsoftGraphAuth = new MicrosoftGraphAuth({
  refreshToken: () => toolSecretProvider.get("JARVIS_MICROSOFT_REFRESH_TOKEN"),
  clientId: () => toolSecretProvider.get("JARVIS_MICROSOFT_CLIENT_ID"),
  clientSecret: () => toolSecretProvider.get("JARVIS_MICROSOFT_CLIENT_SECRET"),
  tenant: () => toolSecretProvider.get("JARVIS_MICROSOFT_TENANT_ID"),
  persist: (value) => toolGateway.setSecret("JARVIS_MICROSOFT_REFRESH_TOKEN", value)
});
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(githubRateLimitController), telegram: telegramTransport,
  // D-292: samme "ren token per kall, ingen resolver-closure"-mønster som
  // main.ts sin egen SlackTransport-wiring.
  slack: new SlackTransport(),
  // D-294: identisk wiring-mønster som apps/api/src/main.ts sin DiscordTransport.
  discord: new DiscordTransport(),
  // D-295: identisk wiring-mønster som apps/api/src/main.ts sin TwilioTransport.
  twilio: new TwilioTransport(
    () => toolSecretProvider.get("JARVIS_TWILIO_ACCOUNT_SID"),
    () => toolSecretProvider.get("JARVIS_TWILIO_FROM_NUMBER")
  ),
  // D-296: identisk wiring-mønster som apps/api/src/main.ts sin BraveSearchTransport.
  brave_search: new BraveSearchTransport(),
  // D-297: identisk wiring-mønster som apps/api/src/main.ts sin SentryTransport.
  sentry: new SentryTransport(() => toolSecretProvider.get("JARVIS_SENTRY_ORG_SLUG")),
  // D-298: identisk wiring-mønster som apps/api/src/main.ts sin GoogleMapsTransport.
  google_maps: new GoogleMapsTransport(),
  // D-299: identisk wiring-mønster som apps/api/src/main.ts sin GoogleSheetsTransport.
  google_sheets: new GoogleSheetsTransport(),
  // D-301: identisk wiring-mønster som apps/api/src/main.ts sin TavilyTransport.
  tavily: new TavilyTransport(),
  // D-302: identisk wiring-mønster som apps/api/src/main.ts sin ExaTransport.
  exa: new ExaTransport(),
  // D-303: identisk wiring-mønster som apps/api/src/main.ts sin GooglePlacesTransport.
  google_places: new GooglePlacesTransport(),
  // D-304: identisk wiring-mønster som apps/api/src/main.ts sin GoogleRoutesTransport.
  google_routes: new GoogleRoutesTransport(),
  // D-305: identisk wiring-mønster som apps/api/src/main.ts sin GrafanaTransport.
  grafana: new GrafanaTransport(() => toolSecretProvider.get("JARVIS_GRAFANA_API_BASE_URL")),
  // D-306: identisk wiring-mønster som apps/api/src/main.ts sin PrometheusTransport.
  prometheus: new PrometheusTransport(() => toolSecretProvider.get("JARVIS_PROMETHEUS_API_BASE_URL")),
  // D-307: identisk wiring-mønster som apps/api/src/main.ts sin DropboxTransport.
  // D-388: identisk wiring-mønster som apps/api/src/main.ts (refresh-token + app-nøkkel via secret-kjeden).
  dropbox: new DropboxTransport({
    refreshToken: () => toolSecretProvider.get("JARVIS_DROPBOX_REFRESH_TOKEN"),
    appKey: () => toolSecretProvider.get("JARVIS_DROPBOX_APP_KEY"),
    appSecret: () => toolSecretProvider.get("JARVIS_DROPBOX_APP_SECRET")
  }),
  // D-308: identisk wiring-mønster som apps/api/src/main.ts sin NotionTransport.
  notion: new NotionTransport(),
  // D-388: identisk wiring-mønster som apps/api/src/main.ts - delt Microsoft Graph-auth for OneDrive + Outlook.
  onedrive: new OneDriveTransport(microsoftGraphAuth),
  microsoft_outlook: new MicrosoftOutlookTransport(microsoftGraphAuth),
  // D-311: identisk wiring-mønster som apps/api/src/main.ts sin N8nTransport.
  n8n: new N8nTransport(() => toolSecretProvider.get("JARVIS_N8N_API_BASE_URL")),
  // D-313: identisk wiring-mønster som apps/api/src/main.ts sin SpotifyTransport.
  spotify: new SpotifyTransport({
    clientId: () => toolSecretProvider.get("JARVIS_SPOTIFY_CLIENT_ID"),
    clientSecret: () => toolSecretProvider.get("JARVIS_SPOTIFY_CLIENT_SECRET"),
    persist: (value) => toolGateway.setSecret("JARVIS_SPOTIFY_REFRESH_TOKEN", value)
  }),
  // D-314: identisk wiring-mønster som apps/api/src/main.ts sin WhatsAppTransport.
  whatsapp: new WhatsAppTransport(() => toolSecretProvider.get("JARVIS_WHATSAPP_PHONE_NUMBER_ID")),
  // D-315: identisk wiring-mønster som apps/api/src/main.ts sin MakeTransport.
  make: new MakeTransport(() => toolSecretProvider.get("JARVIS_MAKE_API_BASE_URL")),
  // D-316: identisk wiring-mønster som apps/api/src/main.ts sin OpenAIImagesTransport.
  openai_images: new OpenAIImagesTransport(),
  // D-321: identisk wiring-mønster som apps/api/src/main.ts sin TelnyxTransport.
  telnyx: new TelnyxTransport(() => toolSecretProvider.get("JARVIS_TELNYX_FROM_NUMBER")),
  // D-322: identisk wiring-mønster som apps/api/src/main.ts sin RunwayTransport.
  runway: new RunwayTransport(),
  // D-323: identisk wiring-mønster som apps/api/src/main.ts sin KlingTransport.
  kling: new KlingTransport(() => toolSecretProvider.get("JARVIS_KLING_ACCESS_KEY")),
  // D-324: identisk wiring-mønster som apps/api/src/main.ts sin GoogleVeoTransport.
  google_veo: new GoogleVeoTransport(),
  // D-327: identisk wiring-mønster som apps/api/src/main.ts sin HiggsfieldTransport.
  higgsfield: new HiggsfieldTransport(() => toolSecretProvider.get("JARVIS_HIGGSFIELD_KEY_ID")),
  // D-329: identisk wiring-mønster som apps/api/src/main.ts sin TodoistTransport.
  todoist: new TodoistTransport(),
  // D-330: identisk wiring-mønster som apps/api/src/main.ts sin TrelloTransport.
  trello: new TrelloTransport(() => toolSecretProvider.get("JARVIS_TRELLO_API_KEY")),
  // D-331: identisk wiring-mønster som apps/api/src/main.ts sin JiraTransport.
  jira: new JiraTransport(
    () => toolSecretProvider.get("JARVIS_JIRA_BASE_URL"),
    () => toolSecretProvider.get("JARVIS_JIRA_EMAIL")
  ),
  // D-332: identisk wiring-mønster som apps/api/src/main.ts sin LinearTransport.
  linear: new LinearTransport(),
  // D-333: identisk wiring-mønster som apps/api/src/main.ts sin HubSpotTransport.
  hubspot: new HubSpotTransport(),
  // D-334: identisk wiring-mønster som apps/api/src/main.ts sin PipedriveTransport.
  pipedrive: new PipedriveTransport(() => toolSecretProvider.get("JARVIS_PIPEDRIVE_BASE_URL")),
  // D-242/D-248: identisk wiring-mønster som apps/api/src/main.ts - `vercel`
  // manglet en ekte transport her også - `VercelTransport` fantes aldri,
  // `transport("vercel")` falt derfor alltid tilbake til
  // `UnconfiguredHttpTransport("vercel")` (ubetinget `vercel_not_configured`).
  vercel: new VercelTransport(() => toolSecretProvider.get("JARVIS_VERCEL_TEAM_ID")),
  // D-388 (JARVIS-061): identisk wiring-mønster som apps/api/src/main.ts sin HomeAssistantTransport.
  "home-assistant": new HomeAssistantTransport(() => toolSecretProvider.get("JARVIS_HA_BASE_URL"), () => toolSecretProvider.get("JARVIS_HA_ROOMS")),
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans gis til
  // BusinessTransport slik at sync_business_events kan kalle Gmail/Calendar
  // - identisk wiring-mønster som apps/api/src/main.ts.
  // D-90 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts -
  // marketingMemoryBriefSource(growthService) injisert her (app-laget), ikke i
  // @jarvis/business (ville vært sirkulært, se business-os-integration.ts).
  business: new BusinessTransport(
    businessService, openLoopService, pool, toolGateway, scoringService,
    [marketingMemoryBriefSource(growthService)]
  ),
  // Identisk wiring-mønster som apps/api/src/main.ts - lazy SupportEmailService.
  support: new SupportTransport(supportService, businessService, toolGateway),
  contract: new AgreementsTransport(agreementsService),
  // UA-3 Native Jarvis Product Core (D-128): identisk wiring-mønster som apps/api/src/main.ts.
  product: new ProductTransport(productService),
  // UA-3 Native Jarvis Operations Core (D-129): identisk wiring-mønster som apps/api/src/main.ts.
  operations: new OperationsTransport(operationsService),
  growth: new GrowthTransport(growthService),
  // UA-4 Google Ads-slice (D-83): identisk wiring-mønster som apps/api/src/main.ts.
  googleads: new GoogleAdsTransport(growthService),
  // D-335 (UA-4 Meta Ads-slice): identisk wiring-mønster som apps/api/src/main.ts.
  metaads: new MetaAdsTransport(growthService),
  // UA-6 Finance & Spend Integrity Gateway (D-107): identisk wiring-mønster som apps/api/src/main.ts.
  finance: new FinanceTransport(financeService, fikenCredentialsProvider),
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): identisk wiring-mønster som apps/api/src/main.ts.
  finance_spend: new SpendTransport(spendService),
  // D-109 (UA-6 Slice 3): identisk wiring-mønster som apps/api/src/main.ts.
  finance_stripe: new StripeFinanceTransport(financeService),
  // D-110 (UA-6 Slice 4): identisk wiring-mønster som apps/api/src/main.ts.
  finance_vipps: new VippsFinanceTransport(financeService),
  finance_neonomics: new NeonomicsFinanceTransport(bankingService, financeService),
  // D-112 (UA-6 Slice 6): eget `finance_wallester.*`-namespace - SAMME mønster.
  finance_wallester: new WallesterFinanceTransport(cardService),
  // D-91 (UA-4 NESTE SLICE): identisk wiring-mønster som apps/api/src/main.ts.
  consent: new ConsentTransport(consentService, consentEnforcementService),
  // D-105: samme wiring-mønster som apps/api/src/main.ts.
  docker: new DockerTransport(),
  // D-337: samme wiring-mønster som apps/api/src/main.ts.
  gce: new GceTransport(),
  // D-338: samme wiring-mønster som apps/api/src/main.ts.
  mcp_zapier: new McpZapierTransport(),
  // D-339: samme wiring-mønster som apps/api/src/main.ts.
  browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? ""),
  ...driveTransportsIfConfigured()
}, {
  // D-105 host-fix: samme wiring-mønster som apps/api/src/main.ts.
  dockerMutationTargets: parseDockerMutationTargets(process.env["JARVIS_DOCKER_MUTATION_TARGETS"]),
  // D-337: samme wiring-mønster som apps/api/src/main.ts.
  gceMutationTargets: parseGceMutationTargets(process.env["JARVIS_GCE_MUTATION_TARGETS"]),
  // D-388 (JARVIS-061): Home Assistant-verktøyene registreres med ekte transport - samme som apps/api/src/main.ts.
  additionalTools: homeAssistantTools(new HomeAssistantTransport(() => toolSecretProvider.get("JARVIS_HA_BASE_URL"), () => toolSecretProvider.get("JARVIS_HA_ROOMS")))
})) toolGateway.register(tool);
// REMEDIERING DEL 1 (JARVIS-002): SAMME eksplisitte lese-minimumssett som
// apps/api/src/main.ts (`MODEL_SURFACE_ALLOWLIST`), begrenset til det som er
// registrert på DENNE prosessens `toolGateway` (worker har en delmengde).
// Hele registeret (`allMeshTools()`) eksponeres ALDRI for modellen.
const modelToolSurface = resolveModelToolSurface(toolGateway, { onlyRegistered: true });
const toolManifest = buildToolManifest(toolGateway.list());
// Workeren registrerer ikke chat-flatenes verktøy (memory/executive) - de er bare tildelt flater, og `modelToolSurface` er onlyRegistered. Uten dette krasjer workeren ved oppstart.
assertManifestInvariants(toolManifest, { ignoreUnregisteredGrants: true });
// Systemidentitet med unik sesjons-id per oppstart (ingen falsk fast `sess-worker`).
const workerIdentity = systemIdentity(owner, "worker", { channel: "api" });
toolGateway.setClassDNotifier(telegramClassDNotifier({
  execute: (req) => toolGateway.execute({ ...req, identity: req.identity as never }),
  secrets: toolSecretProvider,
  identity: workerIdentity as never
}));

// D-180 (W1, D183 - retter D182 sitt REAL_INTERNAL_GAP-funn): @jarvis/watchdog
// var FØR denne posten null-koblet til noen produksjonsprosess. Plassert HER,
// ETTER `assertRuntimeRoleSafe(pool)` (linje ~63) og `killSwitch.restore()`/
// `ownerControls.restore()` (linje ~105/107) er fullført, FØR selve
// intervall-drenerings-loopen nederst - watchdogen starter ALDRI før
// runtime-DB-sikkerhetssjekkene er kjørt og den delte, pool-baserte
// `KillSwitch`-en er gjenopprettet (D183 §A). KUN i worker-prosessen (D183
// sin foretrukne mål - eier allerede pool/KillSwitch/TelegramTransport/
// ToolGateway) - IKKE duplisert i apps/api/src/main.ts (D183 §A "avoid
// duplicate watchdog instances").
//
// `costExplosionCheck` sin nødstopp går NÅ via `killSwitch.activateDurable()`
// (se watchdog.ts sin egen begrunnelse) - `ownerPersonId` er BEVISST SAMME
// `ownerControlAuthority.owner_person_id` som resten av denne filens wiring
// (linje ~103/122/131), ALDRI en oppdiktet "system"-identitet: `assert
// OwnerControlAuthorized()` krever UBETINGET at aktøren matcher den
// konfigurerte eier-autoriteten, og `owner_control_state.actor_person_id`
// har en reell FK mot `people` - denne automatiserte nødmekanismen handler
// derfor UNDER eierens egen, forhåndsautoriserte sovereign-autoritet
// (D-41), ikke som en separat, uautorisert aktør.
//
// D-181 (BLOCKER B1, arkitekt-order D184 mot PR #96 - retter D-180 sitt
// gjenoppdagede funn): `GatewayAlertSink` (D-180) sendte varsler via DEN
// ORDINÆRE `toolGateway.execute({tool_id:"telegram", action:"notify"})`-
// stien - NØYAKTIG stien `PolicyGateway.authorize()` nekter med
// `kill_switch_active` når den GLOBALE kill switchen er aktiv (watchdog sin
// EGEN, nylig durable-gjorte aktivering). Watchdog-en klarte altså å stenge
// Jarvis ned, men kunne ALDRI varsle om det. `WatchdogEmergencyAlertSink`
// hopper BEVISST over `ToolGateway.execute()`/`PolicyGateway.authorize()`
// for KUN dette ene, smale formålet (se watchdog.ts sin egen, fulle
// begrunnelse) - injiserer DEN SAMME `telegramTransport`/
// `toolSecretProvider`-instansen som den ordinære `telegram.notify`-
// verktøydefinisjonen selv bruker (linje ~264/136-139 over) - SAMME
// credential_ref, SAMME mottaker, INGEN ny credential-mekanisme, INGEN
// kaller-kontrollert mål. `isSelfRecoveryAction()` er UENDRET - ordinær
// `telegram.notify` forblir korrekt nektet under en aktiv kill switch for
// ALLE andre kallere.
const watchdogAlertSink = new WatchdogEmergencyAlertSink(telegramTransport, toolSecretProvider);
const watchdog = new Watchdog(watchdogAlertSink, killSwitch);
watchdog.register(databaseCheck(pool));
watchdog.register(stuckTasksCheck(pool));
// D-187 (BLOCKER B2, arkitekt-order D187 mot PR #96): begge miljøvariablene
// valideres FØR bruk - `parseCostHardLimitOre`/`parseWatchdogIntervalMs`
// kaster ved enhver eksplisitt oppgitt, ugyldig verdi (fail-closed oppstart)
// i stedet for å la `Number(...)` stille gi `NaN`/`Infinity`/negativ/null
// videre til `costExplosionCheck()`/`setInterval()` - se watchdog.ts sin
// egen, fulle begrunnelse for hvorfor en `NaN`-hardgrense var en reell
// utilsiktet-nødstopp-risiko.
// D-191 (BLOCKER B4, arkitekt-order D191 mot PR #96): `costExplosionCheck`
// krever nå en eksplisitt `tenantId` (RLS-skopet SELECT via
// `withTenantTransaction` - se watchdog.ts sin egen begrunnelse). Samme
// `owner.tenant_id`-mønster (validert eier-konfig) som resten
// av denne filens wiring (linje ~122/136/319/464) - ALDRI utledet fra
// urelatert data. `owner_person_id` forblir uendret, separat eksplisitt.
watchdog.register(
  costExplosionCheck(pool, killSwitch, ownerControlAuthority.owner_person_id,
    owner.tenant_id,
    parseCostHardLimitOre(process.env["JARVIS_COST_HARD_LIMIT_ORE"])
  )
);
const WATCHDOG_INTERVAL_MS = parseWatchdogIntervalMs(process.env["JARVIS_WATCHDOG_INTERVAL_MS"]);
setInterval(
  () =>
    void watchdog
      .tick()
      .catch((err) => console.error(JSON.stringify({ msg: "watchdog_tick_error", error: (err as Error).message }))),
  WATCHDOG_INTERVAL_MS
);

// REMEDIERING DEL 2 (JARVIS-010): kodejobber kjører KUN i en per-jobb-container med eksplisitt policy
// (ikke-root, read-only rootfs, ressursgrenser, egress via allowlistet proxy, ingen arvede secrets) -
// se modules/tasks/src/job-container.ts. Finnes ingen gyldig runner (`JARVIS_JOB_RUNNER=container` +
// digest-pinnet `JARVIS_JOB_IMAGE`/`JARVIS_JOB_NETWORK`/`JARVIS_JOB_EGRESS_PROXY`), feiler HVER kodejobb
// lukket (`job_container_runner_not_configured`). `ProcessSandboxRunner`/`DockerSandboxRunner` er IKKE
// lenger koblet til produksjon; det gamle `JARVIS_SANDBOX`-valget finnes ikke.
const runner = resolveJobSandboxRunner(process.env);

// BO-11.1 §9: delt executive-handler (samme fil som api-workeren) - identisk
// kontrakt for samme kø: prompt → mesh, tools=true → tool-løkke (command-kontrakter avvises).
worker.register(
  "executive",
  executiveHandler({
    gateway,
    // D-351: 4000 → 20_000 (se mesh-bridge.ts sitt filhode for host-målt begrunnelse) - SAMME
    // grense som api-workeren (main.ts) bruker, uendret "identisk oppførsel"-presedens.
    // Del 3 (JARVIS-005/012): per-jobb identitet fra kontrakten, bakgrunnsflate, manifest + kontrakt håndhevet i gatewayen (API/worker-parity).
    tools: {
      all: modelToolSurface,
      executorFor: (task, allowed) => new MeshToolExecutor(
        toolGateway, jobIdentityFor(workerIdentity, task.contract), 20_000, [...allowed],
        createTurnContext("background", String((task.contract.input.data as { prompt?: unknown })["prompt"] ?? "")),
        { manifest: toolManifest, confirmations: new ConfirmationStore(pool), jobContract: task.contract }
      )
    }
  })
);

// D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
// EKTE `ClaudeCodeAgent` (D-96/D-100/D-101, live-kvalitetsverifisert) - ALDRI
// `ScriptedCodingAgent` (kun test-fixture) i produksjon, ALDRI en ny/parallell
// CLI-adapter eller kodejobb-pipeline. Uten `JARVIS_CLAUDE_BIN` kaster
// `ClaudeCodeAgent.modify()` allerede en typet `claude_code_not_configured`-
// feil FØR noe forsøkes (D-96, uendret her) - kodejobb-kapabiliteten blir da
// strukturelt utilgjengelig PER JOBB, ALDRI en stille fabrikkert fiks (Q-26).
// `EnvSecretProvider` (SAMME sekret-arkitektur som resten av appen - ingen ny
// hemmelighet-lagringsmekanisme) injiserer `ANTHROPIC_API_KEY` KUN i
// sandboxens egen, rene prosess-env (`jobEnv`) - ALDRI arvet fra denne
// worker-prosessen, ALDRI i en prompt/logg/artefakt/audit-post.
// `github: {gateway: toolGateway}` gjenbruker DEN SAMME, allerede D-97-
// throttling-bevisste ToolGateway-instansen (INGEN direkte GitHub-HTTP-vei) -
// PR-publisering skjer derfor KUN naar jobbkontraktens EGEN `allowed_tools`
// eksplisitt lister "github" (D-95, uendret). `identityFor` bruker jobbens
// EGEN `owner_person_id`/`tenant_id` (ALDRI en fast worker-identitet) - dette
// er PÅKREVD for at PolicyGateway sin SOVEREIGN-eiermodus (BO-11.1) skal
// evaluere korrekt for klasse C (push_branch/create_pr): en identitet som
// ikke matcher `authority.owner_person_id` ville falt tilbake til et
// mandat-krav som produksjonen aldri konfigurerer. `withSecretRedaction`
// (D-102, forsvar-i-dybden) fjerner ethvert kjent hemmelig-formet argument
// fra en kastet feilmelding FØR den noensinne når `tasks.last_error` - dekker
// det usannsynlige, men ikke strukturelt umulige tilfellet at Claude Code-
// CLI-en (en ekstern subprosess, utenfor Jarvis sin kontroll) selv ekko'er
// sin egen miljøvariabel i stdout/stderr.
worker.register(
  "coding",
  withSecretRedaction(
    createCodingHandler({
      sandbox: runner,
      agent: new ClaudeCodeAgent(),
      artifacts: new ArtifactStore(pool),
      policy,
      identityFor: (task) => ({
        ...workerIdentity,
        person_id: task.contract.owner_person_id,
        tenant_id: task.tenant_id,
        session_id: `${workerIdentity.session_id}-coding`
      }),
      claudeCodeCredential: { secretProvider: new EnvSecretProvider() },
      // D-103 (Blokker B): SAMME EnvSecretProvider-arkitektur, HELT ATSKILT
      // secret-referanse (default "JARVIS_GITHUB_TOKEN") fra claudeCodeCredential
      // over ("ANTHROPIC_API_KEY") - git clone/push får nå eksplisitt,
      // ephemer transport-autentisering i stedet for å avhenge av ambient
      // vertsmaskin-tilstand (Git Credential Manager e.l.). Mangler tokenet:
      // jobben feiler FØR clone forsøkes (`git_auth_unavailable`), ALDRI et
      // stille fall til uautentisert git.
      gitAuth: { secretProvider: new EnvSecretProvider() },
      // Remediering del 2 (JARVIS-064): credentialen gjelder KUN github.com + disse eksakte repoene
      // (JARVIS_GIT_ALLOWED_REPOS, ellers JARVIS_GITHUB_REPO). Tom allowlist = hver kodejobb feiler lukket.
      allowedRepos: allowedReposFromEnv(process.env),
      github: { gateway: toolGateway }
    }),
    [process.env["ANTHROPIC_API_KEY"], process.env["JARVIS_GITHUB_TOKEN"]]
  )
);

// UA-2 P1B-A (D-43 §5): e-post-vedlegg-ingestion som en durable jobb - SAMME
// worker/kø-infrastruktur som "executive" over, ingen parallell mekanisme.
// Statisk, env-drevet ÉN-instans-registry (samme "eksplisitt, ingen implisitt
// default"-prinsipp som ua2-p1a-live.ts sin egen registry-bruk) - owner sin
// egen postkasse, personal memory space. gateway (ModelGateway) tilfredsstiller
// VisionCompleter strukturelt (complete()-metoden), ingen ny AI Mesh-vei.
const knowledgeRegistry = new KnowledgeSourceRegistry([
  {
    source_type: "email_attachment",
    tenant_id: owner.tenant_id,
    memory_space_id: "personal",
    source_instance_id: "email:inbox",
    // D-340: samme tom-streng-.env-bug - JARVIS_GOOGLE_ACCOUNT="" i .env skal falle til defaulten.
    account: process.env["JARVIS_GOOGLE_ACCOUNT"] || "post@tsworkflow.com"
  }
]);
worker.register(
  "knowledge-ingest-email",
  emailIngestHandler({
    pool, toolGateway, embeddings: new LocalHashEmbedding(), visionGateway: gateway, registry: knowledgeRegistry
  })
);

console.log(JSON.stringify({ msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name }));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
