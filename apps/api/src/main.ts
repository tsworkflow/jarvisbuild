// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import "./normalize-env.ts";
import { envHour, envInt, envPort, systemIdentity } from "@jarvis/contracts";
import { ownerConfigOrExit } from "./owner.ts";
import {
  ChannelSessionAuthority,
  ContextBuilder,
  DeviceEnrollmentService,
  DeviceService,
  SessionGrantService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionService,
  TelegramOwnerAuthority,
  VoiceSessionAuthority,
  assertRuntimeCredentialsConfigured,
  assertRuntimeRoleSafe,
  configFromEnv,
  createPool,
  runMigrations
} from "@jarvis/core";
import { InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { DeploymentService, DiagnosisService, IncidentService } from "@jarvis/incidents";
import {
  AiCouncil,
  assertProvidersHaveExplicitPricing,
  DEFAULT_PRICING,
  ModelGateway,
  traceSinkFromEnv
} from "@jarvis/model-gateway";
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
import { InProcessWorker, PgTaskQueue, TaskService, allowedReposFromEnv } from "@jarvis/tasks";
import {
  LlmExtractionAdapter,
  LocalHashEmbedding,
  MemoryRetriever,
  MemoryWriter,
  SummaryService,
  runMemoryRetentionSweepForAllTenants
} from "@jarvis/memory";
import {
  DailyBrief, DockerTransport, EnvSecretProvider, FallbackSecretProvider, GceTransport, McpZapierTransport, BrowserGatewayTransport, GithubRateLimitController, GithubTransport,
  GmailTransport, GoogleCalendarTransport, InfisicalSecretProvider, MemorySearchTransport, MeshToolExecutor, memoryToolDefinitions,
  MODEL_SURFACE_ALLOWLIST, resolveModelToolSurface, PgGithubRateLimitStore,
  TelegramCommandPoller, TelegramTransport, SlackTransport, DiscordTransport, TwilioTransport, BraveSearchTransport, SentryTransport, GoogleMapsTransport, GoogleSheetsTransport, TavilyTransport, ExaTransport, GooglePlacesTransport, GoogleRoutesTransport, GrafanaTransport, PrometheusTransport, DropboxTransport, NotionTransport, OneDriveTransport, MicrosoftOutlookTransport, N8nTransport, SpotifyTransport, WhatsAppTransport, MakeTransport, OpenAIImagesTransport, TelnyxTransport, RunwayTransport, KlingTransport, GoogleVeoTransport, HiggsfieldTransport, TodoistTransport, TrelloTransport, JiraTransport, LinearTransport, HubSpotTransport, PipedriveTransport, ToolGateway, VercelTransport, buildStatusSource, calendarSource, driveTransportsIfConfigured,
  emailSource, firstWaveTools, parseDockerMutationTargets, parseGceMutationTargets, tasksSource, DailyScheduler, runConnectorHealthSweep
} from "@jarvis/tool-gateway";
import {
  BusinessEventSyncService, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService,
  ScoringService, isWeeklyBriefDay, runBusinessEventSyncForAllTenants, runBusinessWeeklyBriefForAllTenants,
  runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants
} from "@jarvis/business";
import { SupportEmailService, SupportService, SupportTransport, runSupportInboxSyncForAllTenants } from "@jarvis/support";
import { AgreementsService, AgreementsTransport } from "@jarvis/agreements";
import { ProductService, ProductTransport } from "@jarvis/product";
import { OperationsService, OperationsTransport } from "@jarvis/operations";
import { LocationService, runLocationRetentionSweepForAllTenants } from "@jarvis/location";
import { HealthService, runHealthRetentionSweepForAllTenants } from "@jarvis/health";
import { VisionService, runVisionRetentionSweepForAllTenants } from "@jarvis/vision";
import {
  DomainPauseRegistry, SituationEngine, SituationsTransport, assertSituationSweepHealthy, runSituationSweepForAllTenants,
  situationsToolDefinitions
} from "@jarvis/situations";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceService, GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsService, OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import {
  FinanceService, FinanceTransport, SpendService, SpendTransport, StripeFinanceTransport, VippsFinanceTransport,
  BankingService, NeonomicsFinanceTransport, runNeonomicsSweepForAllTenants,
  CardService, WallesterFinanceTransport, runWallesterSweepForAllTenants, createRsaJwtSigner,
  type WallesterCredentials, type WallesterCredentialsProvider,
  type NeonomicsCredentials, type NeonomicsCredentialsProvider,
  runFinanceSpendIntegritySweepForAllTenants, runStripePaymentSyncForAllTenants, runVippsPaymentSyncForAllTenants,
  type FikenCredentials, type FikenCredentialsProvider, type StripeCredentials, type StripeCredentialsProvider,
  type VippsCredentials, type VippsCredentialsProvider
} from "@jarvis/finance";
import { ConsentEnforcementService, ConsentService, ConsentTransport } from "@jarvis/consent";
import {
  GoogleAdsTransport, GrowthService, GrowthTransport, MetaAdsTransport, marketingMemoryBriefSource, runActionRecommendationSweepForAllTenants
} from "@jarvis/growth";
import { OwnerControls } from "@jarvis/policy";
import {
  ConversationGraphService, ConversationGraphSyncService, ConversationGraphTransport,
  runConversationGraphSyncForAllTenants
} from "@jarvis/conversation-graph";
import { ConversationEngine } from "./conversation.ts";
import { loadPersonalityConfig } from "./personality-config.ts";
import { executiveHandler } from "./executive.ts";
import { createApiServer, type ApiDeps } from "./server.ts";

const port = envPort("JARVIS_API_PORT", 3010);

async function buildDeps(): Promise<ApiDeps | undefined> {
  if (!process.env["JARVIS_DB_PASSWORD"] && !process.env["JARVIS_DB_HOST"]) {
    console.log(JSON.stringify({ msg: "ingen databasekonfig - starter i helse-modus" }));
    return undefined;
  }
  // Q-21 (2026-08-15): fail-closed FØR tilkobling forsøkes - en manglende/feilkonfigurert
  // JARVIS_DB_USER skal ALDRI stille falle tilbake til admin-tilkoblingen (root cause for
  // host-blockeren var nettopp dette - api kjørte som Postgres-superbruker).
  assertRuntimeCredentialsConfigured();
  // Remediering del 2 (JARVIS-065): ÉN validert eier-identitet for hele prosessen (fail closed uten).
  const owner = ownerConfigOrExit();
  const pool = createPool(configFromEnv());
  // Migrasjoner kjøres av admin-bruker i drift; her antas app-bruker å ha skjema fra før.
  if (process.env["JARVIS_DB_RUN_MIGRATIONS"] === "true") {
    await runMigrations(pool);
  }
  // Q-21: appen skal ALDRI starte normalt med en superuser/BYPASSRLS-tilkobling - RLS
  // er strukturelt umulig å håndheve for en slik rolle, uansett hvor korrekte policyene er.
  await assertRuntimeRoleSafe(pool);
  // BO-09: Langfuse-sink når konfigurert (D-27), ellers JSONL - samme mesh-observability overalt.
  const trace = traceSinkFromEnv(process.env["JARVIS_TRACE_FILE"] ?? "var/traces.jsonl");
  // K1 (Sovereign graduation, D-164): FØR denne sliceen var `killSwitch`/
  // `ownerControls` rene in-memory-objekter, SEPARAT konstruert i api- OG
  // worker-prosessen - en pause satt i den ene var usynlig for den andre,
  // og en omstart glemte stille en aktiv pause (fail-OPEN). Nå gitt SAMME
  // `pool`+`authority` som resten av eier-autoritets-mønstrene i denne
  // filen (`situationDomainPauses` under) - `restore()` kalles rett under,
  // FØR noe kan bruke dem, og `PolicyGateway.authorize()`/
  // `ToolGateway.execute()` bruker ALLTID de LIVE `*Durable()`-sjekkene
  // (aldri de rene synkrone), se `KillSwitch`/`OwnerControls` sine filhoder.
  const ownerControlAuthority = { owner_person_id: owner.owner_person_id };
  const killSwitch = new KillSwitch(pool, ownerControlAuthority);
  await killSwitch.restore();
  const ownerControls = new OwnerControls(killSwitch, pool, ownerControlAuthority);
  await ownerControls.restore();
  // D-174 (B2): hoistet hit (tidligere konstruert lenger nede, kun for
  // `enrollmentService`) - `OwnerControlsService` sitt nye, eier-vendte
  // `revoke_device` (se under, `additionalTools`) trenger DENNE SAMME
  // instansen, SAMME `pool`/`ownerControlAuthority` som resten av eier-
  // autoritets-mønstrene over. `SessionGrantService` er en ren, tilstandsløs
  // `pool`-innpakning ved konstruksjon (ingen side-effekt å flytte tidligere) -
  // ÉN delt instans, ALDRI en duplikat parallell konstruksjon.
  const grantService = new SessionGrantService(pool);
  // D-104 (UA-5 Production Operations Control Plane v1): global infra-
  // eksekusjonsmodus - EN NY, SNEVRERE bryter enn `killSwitch` over (som
  // forblir strengest/uendret). Gjelder KUN registrerte infra-tool_id-er
  // (`infraToolIds` under). Prosess-lokal tilstand, BEVISST UTENFOR K1 sitt
  // omfang (D-164 fresh-audit: `/infra/pause` muterer `InfraExecutionGate`,
  // IKKE `killSwitch`/`ownerControls` - en annen, smalere, allerede
  // dokumentert D-104-begrensning, ikke K1 sitt mål) - se
  // D-104/D-164 i DECISIONS_AND_ASSUMPTIONS.md.
  const infraGate = new InfraExecutionGate();
  const infraToolIds = new Set(["github", "docker"]);
  // Enhetsregister fra databasen (fase 8): godkjenninger verifiseres mot registrerte enhetsnøkler.
  const deviceRegistry = new PgDeviceRegistry(pool, owner.tenant_id);
  // D-222: tidligere `.catch(() => undefined)` på begge steder - en vedvarende
  // refresh-feil (DB nede, skjemadrift) ville latt policy-autorisasjon kjøre
  // mot et stille voksende UTDATERT enhetsregister på ubestemt tid, uten NOEN
  // logglinje. Samme "siste sikkerhetsnett"-mønster som D-218/D-221/D-222 over.
  await deviceRegistry.refresh().catch((err) => {
    console.error(JSON.stringify({
      msg: "device_registry_initial_refresh_failed",
      error: err instanceof Error ? err.message : String(err)
    }));
  });
  setInterval(() => void deviceRegistry.refresh().catch((err) => {
    console.error(JSON.stringify({
      msg: "device_registry_refresh_tick_failed",
      error: err instanceof Error ? err.message : String(err)
    }));
  }), 30_000).unref();
  const policy = new PolicyGateway({
    devices: deviceRegistry,
    nonces: new PgApprovalStore(pool),
    killSwitch,
    // K1 (D-164): tidligere ALDRI satt her (dødt felt) - `ToolGateway.execute()`
    // hadde sin EGEN, separate frys-/tilbakekalls-sjekk, men enhver kaller
    // som gikk RETT til `policy.authorize()` (f.eks. `/infra/pause`) omgikk
    // den helt. Nå håndhevet på BEGGE veier, samme `ownerControls`-instans.
    controls: ownerControls,
    infraGate,
    infraToolIds,
    // v4.0 sovereign-owner (BO-11.1 §2-funn): uten denne kjørte runtime i legacy
    // SCOPED-modus og krevde approval for owners D-kall. A-D er risikoklasser -
    // for owner gir SOVEREIGN autonom utførelse; sikkerheten ligger i D-pipelinen
    // (preflight/readback/evidens/recovery) + owner-kontrollene, ikke approval.
    authority: {
      owner_person_id: owner.owner_person_id,
      owner_tenants: [owner.tenant_id]
    }
  });
  const queue = new PgTaskQueue(pool);
  const worker = new InProcessWorker(queue);
  const gateway = new ModelGateway({
    pool,
    trace,
    providers: [
      // D-79 (AI Mesh Gemma-first): gemma_hosted/local_llm registreres alltid,
      // som alle andre adaptere - `.available()` (nøkkel/URL satt) avgjør om de
      // faktisk deltar i ruting, IKKE et eget feature-flag her (§23: samme
      // konvensjon som alle øvrige providere - ingen ny mekanisme).
      new OpenAiAdapter(),
      new AnthropicAdapter(),
      new GeminiAdapter(),
      new GemmaHostedAdapter(),
      new LocalOpenAiCompatibleAdapter(),
      // D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): SAMME
      // `LocalOpenAiCompatibleAdapter`-klasse som `local_llm` over, registrert
      // EN GANG TIL under en distinkt provider-identitet (`gemma_local`) for
      // Gemma kjørt lokalt (Tobias sin RTX 4070-PC, eller en annen dedikert
      // vertsmaskin via et OpenAI-kompatibelt endepunkt) - `.available()`
      // (URL satt) avgjør deltakelse, samme konvensjon som alle andre
      // providere. Se `capability-registry.ts` sin `gemma_local`-profil.
      new LocalOpenAiCompatibleAdapter(
        process.env["JARVIS_GEMMA_LOCAL_URL"],
        // D-340: samme tom-streng-.env-bug som resten av provider-adapters -
        // denne ENE oppringingen satte modellen RÅTT (bypasset adapterens
        // egen `envOrDefault()`-fiksede default), `||` retter opp samme sted.
        process.env["JARVIS_GEMMA_LOCAL_MODEL"] || "gemma-local",
        undefined,
        "gemma_local"
      ),
      new KimiAdapter(),
      new HermesAdapter(),
      new OllamaAdapter()
      // D-106 HOST-FIX (produksjonsherding, Defekt E): `ScriptedAdapter` er ALDRI
      // registrert her lenger - live host-kjøring viste at den, som en ordinær
      // "local"-profilert provider, kunne bli et LEGITIMT AUTO-rutingvalg under
      // `paid_models_allowed=false` når INGEN ekte lokal provider var frisk/
      // konfigurert - Jarvis returnerte da et KANONISERT FAKE-svar i produksjon,
      // ALDRI en ærlig feil. `ScriptedAdapter` er en DETERMINISTISK TEST-DOBLE
      // (se `packages/provider-adapters/src/scripted.ts`) - tester konstruerer
      // den EKSPLISITT selv i egne testfiler, den skal ALDRI stille dukke opp
      // som en ordinær provider i den ekte API-/worker-
      // prosessens `ModelGateway`. Uten den her feiler `paid_models_allowed=false`
      // + ingen ekte lokal provider NÅ ærlig med `PaidModelsDisabledError`
      // (router.ts) - en strukturert, auditerbar feil, ALDRI et falskt svar.
    ],
    budget: {
      warn_ore: 100_000,
      approval_ore: 200_000,
      hard_limit_ore: 300_000,
      spend_approved: process.env["JARVIS_BUDGET_APPROVED"] === "true"
    }
  });
  // JARVIS-006: hver konstruert adapter MÅ ha eksplisitt pris - ingen stille `default_rate`.
  assertProvidersHaveExplicitPricing(DEFAULT_PRICING, gateway.listProviderNames());
  // D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): egen
  // orkestrering over SAMME `gateway`/`pool` - ingen ny modellkall-vei, ingen
  // ny sikkerhetsvei (hvert Council-medlemsanrop går via `gateway.complete()`
  // med SPECIFIC_PROVIDER-override, samme budsjett/kost/helse/trace/
  // sensitivitet/paid_models_allowed-håndhevelse som alle andre kall).
  const aiCouncil = new AiCouncil(gateway, pool);
  // BO-03: Tool Gateway m/live transporter (aktiveres av credentials i .env),
  // Daily Brief-kilder, morgenlevering og Telegram-kommandoer.
  // K1 (D-164): `ownerControls` konstruert lenger opp (delt med `policy`).
  //
  // Task #119 (D-211): Infisical er nå PRIMÆR (Q-05 lukket - Infisical valgt,
  // ikke OpenBao), `.env`/`BusinessInternal` forblir fallback-kjeden UENDRET
  // (staged migration, D-35). `InfisicalSecretProvider.get()` returnerer
  // `null` UMIDDELBART når den ikke er konfigurert (`available()` == false,
  // se gateway.ts) - lokal dev/CI UTEN kjørende Infisical faller derfor
  // rett gjennom til SAMME env-kjede som før, INGEN regresjon.
  // Task #122 (D-213): SAMME InfisicalSecretProvider-INSTANS gis inn TO
  // ganger - én gang inni les-fallback-kjeden under (uendret), én gang som
  // det separate `writableSecrets`-argumentet (5. posisjon) som
  // `ToolGateway.setSecret()` skriver via. ALDRI to uavhengige Infisical-
  // tilkoblinger.
  const infisicalSecretProvider = new InfisicalSecretProvider();
  // Task #121 (D-214): hevet ut til en navngitt konstant (tidligere anonym
  // inline i ToolGateway-konstruktøren) - `SelfModificationService` sin
  // `resolveGitToken` gjenbruker DENNE SAMME kjeden (Infisical PRIMÆR,
  // .env/BusinessInternal fallback, D-211) for å hente `JARVIS_GITHUB_TOKEN`,
  // i stedet for en egen, parallell secret-oppløsningsvei.
  const readSecretProvider = new FallbackSecretProvider(
    infisicalSecretProvider,
    new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())
  );
  const toolGateway = new ToolGateway(pool, policy, readSecretProvider, ownerControls, infisicalSecretProvider);
  // D-104: egen tjeneste over SAMME runtime-pool, ingen ny motor - gjenbruker
  // DEN SAMME `toolGateway`-instansen (registrert med github under) for
  // recovery-forsøk, ALDRI et direkte transport-kall (se recovery.ts).
  const incidentService = new IncidentService(pool);
  const deploymentService = new DeploymentService(pool);
  // D-105: samme runtime-pool, ingen ny motor - diagnose er en atskilt
  // domenetjeneste (evidens vs. konklusjon, se diagnosis.ts).
  const diagnosisService = new DiagnosisService(pool);
  const businessService = new BusinessService(pool);
  // UA-3 next slice (D-53): open-loop-deteksjon - egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§4/§19/§20 i byggeordren).
  const openLoopService = new OpenLoopService(pool);
  // UA-3 profiling/scoring-slice (D-61): egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§14/§23 i byggeordren) - gjenbruker Business Graph uendret.
  const scoringService = new ScoringService(pool);
  // UA-7 Communications Hub - foerste slice (D-119): egen tjeneste over
  // SAMME runtime-pool, ingen ny motor - gjenbruker Business Graph
  // (business_contacts/business_followups/business_activities) uendret via
  // pekere (linked_business_contact_id), aldri en kopi.
  const conversationGraphService = new ConversationGraphService(pool);
  // UA-3 Native Jarvis Support Core (D-66): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - gjenbruker Business Graph (kontakt-/
  // selskap-kobling) og OpenLoopService (§17 i byggeordren) uendret.
  const supportService = new SupportService(pool);
  // UA-3 Native Jarvis Contracts Core (D-71): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - motpart gjenbruker Business Graph
  // (company_id/contact_id) og OpenLoopService (renewal/deadline/obligation/
  // review-reglene) uendret. Ingen e-sign-avhengighet - `AgreementsTransport`
  // trenger derfor IKKE `toolGateway`/`ToolInvocationContext`, i motsetning
  // til `SupportTransport`.
  const agreementsService = new AgreementsService(pool);
  // UA-3 Native Jarvis Product Core (D-128): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - rapportør gjenbruker Business Graph
  // (company_id/contact_id) og OpenLoopService (triage/stagnasjon-reglene)
  // uendret. Ingen ekstern issue-tracker-avhengighet - SAMME lat/enkel-
  // avhengighet-mønster som `AgreementsTransport`.
  const productService = new ProductService(pool);
  // UA-3 Native Jarvis Operations Core (D-129): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - leverandørkontakt gjenbruker Business
  // Graph (company_id/contact_id) og OpenLoopService (forfalt/eskalerings-
  // reglene) uendret. Ingen ekstern driftsplattform-/ticketing-avhengighet
  // - SAMME lat/enkel-avhengighet-mønster som `ProductTransport`.
  const operationsService = new OperationsService(pool);
  // UA-8 Personal Digital Twin (D-130): provider-nøytral lokasjon/geofencing
  // og helse-ingestion - egne tjenester over SAMME runtime-pool, ingen ny
  // motor. Ingen ToolGateway-handlinger/API-flate lagt til her i denne
  // sliceen (bevisst utenfor UA-8-kjernens akseptansekriterier) - kun
  // datamodellen + retensjons-håndhevelsen (se DailyScheduler-sveipene under).
  const locationService = new LocationService(pool);
  const healthService = new HealthService(pool);
  const visionService = new VisionService(pool);
  // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
  // Core - egen tjeneste over SAMME runtime-pool, ingen ny motor. Refererer
  // `business_contacts` KUN via en DB-håndhevet FK (`contact_id: string`) -
  // `@jarvis/consent` importerer ALDRI `@jarvis/business` i src/ (kun i
  // test/ for fixtures) - INGEN ny kjøretids-pakkeavhengighet.
  const consentService = new ConsentService(pool);
  // D-92 (UA-4 NESTE SLICE): Consent Enforcement Activation/Rollout v1 -
  // konstrueres FØR growthService (som injiserer den valgfritt) - standard
  // rollout-modus er 'disabled' for ALLE tenant/space/formål inntil eieren
  // eksplisitt aktiverer 'audit'/'enforce' via consent.set_enforcement_policy
  // - IDENTISK oppførsel med FØR D-92 helt til det gjøres.
  const consentEnforcementService = new ConsentEnforcementService(pool, consentService);
  // UA-4 Native Jarvis Growth Core (D-74): egen tjeneste over SAMME
  // runtime-pool, ingen ny motor - attribusjon gjenbruker Business Graph
  // (business_leads/business_opportunities) og OpenLoopService
  // (marketing_spend_anomaly-regelen) uendret. Ingen annonseplattform-
  // avhengighet - `GrowthTransport` trenger derfor IKKE `toolGateway`/
  // `ToolInvocationContext`, i motsetning til `SupportTransport`.
  // D-92: `consentEnforcementService` injiseres her (valgfritt konstruktør-
  // parameter, se GrowthService-JSDoc) - `attributeToCampaign()`/
  // `attributeFromTracking()` konsulterer NÅ D-91/D-92-motoren, men KUN
  // blokkerende når eieren faktisk har aktivert 'enforce' for et gitt
  // tenant/space/formål (se D-92 i DECISIONS_AND_ASSUMPTIONS.md).
  const growthService = new GrowthService(pool, consentEnforcementService);
  // UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107): egen
  // tjeneste over SAMME runtime-pool, ingen ny motor - avviks-/avstemming-
  // deteksjon gjenbruker OpenLoopService (payment_intent_anomaly/
  // payment_intent_reconciliation_mismatch-reglene) uendret. Fiken er
  // masterplan-navngitt P0-connector (IKKE et Claude-valgt leverandørvalg),
  // ETT globalt eier-tilkoblet credential-par (SAMME "single-owner, ikke
  // multi-kunde-SaaS"-mønster som JARVIS_GOOGLE_ADS_REFRESH_TOKEN) - INGEN
  // tenant-parametrisert oppslag i denne sliceen (kun én Tobias-eid Fiken-
  // konto er i scope).
  // D-109 (UA-6 Slice 3): SAMME "ETT globalt eier-tilkoblet credential-par"-
  // mønster som `fikenCredentialsProvider` under - INGEN tenant-parametrisert
  // Stripe-Connect-oppslag denne sliceen (kun én Tobias-eid Stripe-konto er i
  // scope, se stripe-transport.ts/types.ts sin D-109-kommentar).
  // D-246 (2026-09-23, funnet LIVE av Tobias: "Test tilkobling" feilet på
  // Neonomics med `credentials_unavailable` selv om CLIENT_ID/SECRET/
  // DEVICE_ID ALLE viste ✓ som lagret i dashbordet). Root cause: de fire
  // finans-`getCredentials()`-lukkingene under leste FØR direkte fra
  // `process.env[...]`, HELT UTENOM `readSecretProvider` (Infisical-primær,
  // se D-211 over) - eierens "lim inn ny verdi"-dashbord-flyt (D-213)
  // skriver KUN til Infisical (`ToolGateway.setSecret()`), aldri til den
  // kjørende prosessens `process.env`. `hasSecret()`/dashbordets ✓-visning
  // SPØR `readSecretProvider` (finner den i Infisical - viser derfor
  // korrekt ✓), mens disse fire lukkingene ALDRI så den samme verdien -
  // strukturelt umulig å få "Test tilkobling" til å lykkes via dashbordet
  // alene, uansett hva som ble limt inn. Fiken var IKKE rammet (dens
  // faktiske credential, `JARVIS_FIKEN_REFRESH_TOKEN`, kommer utelukkende
  // fra `fiken-reauth.ts`, som skriver DIREKTE til `.env`-filen, aldri via
  // dashbordet/Infisical). Fiks: alle fire leser nå via `readSecretProvider`
  // (SAMME kjede `hasSecret()` allerede bruker) - `.env`-fallback UENDRET
  // for de som fortsatt foretrekker den ruten.
  const stripeCredentialsProvider: StripeCredentialsProvider = {
    async getCredentials(): Promise<StripeCredentials | null> {
      const secretKey = await readSecretProvider.get("JARVIS_STRIPE_SECRET_KEY");
      if (!secretKey) return null;
      return { secretKey };
    }
  };
  const stripeWebhookSecretProvider = () => process.env["JARVIS_STRIPE_WEBHOOK_SECRET"] ?? null;
  const stripeTenantResolver = () => process.env["JARVIS_STRIPE_TENANT_ID"] ?? null;
  // D-110 (UA-6 Slice 4): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster som Stripe over - INGEN tenant-parametrisert multi-MSN-oppslag
  // denne sliceen (kun én Tobias-eid Vipps-selgerkonto er i scope).
  const vippsCredentialsProvider: VippsCredentialsProvider = {
    async getCredentials(): Promise<VippsCredentials | null> {
      const clientId = await readSecretProvider.get("JARVIS_VIPPS_CLIENT_ID");
      const clientSecret = await readSecretProvider.get("JARVIS_VIPPS_CLIENT_SECRET");
      const subscriptionKey = await readSecretProvider.get("JARVIS_VIPPS_SUBSCRIPTION_KEY");
      const merchantSerialNumber = await readSecretProvider.get("JARVIS_VIPPS_MSN");
      if (!clientId || !clientSecret || !subscriptionKey || !merchantSerialNumber) return null;
      return { clientId, clientSecret, subscriptionKey, merchantSerialNumber, environment: process.env["JARVIS_VIPPS_ENVIRONMENT"] === "production" ? "production" : "test" };
    }
  };
  const vippsWebhookSecretProvider = () => process.env["JARVIS_VIPPS_WEBHOOK_SECRET"] ?? null;
  const vippsTenantResolver = () => process.env["JARVIS_VIPPS_TENANT_ID"] ?? null;
  // D-111 (UA-6 Slice 5): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster - ett Neonomics-kundeforhold, en Jarvis-stabil x-device-id.
  const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
    async getCredentials(): Promise<NeonomicsCredentials | null> {
      const clientId = await readSecretProvider.get("JARVIS_NEONOMICS_CLIENT_ID");
      const clientSecret = await readSecretProvider.get("JARVIS_NEONOMICS_CLIENT_SECRET");
      const deviceId = await readSecretProvider.get("JARVIS_NEONOMICS_DEVICE_ID");
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
  // (PR #62 runde 4): SAMME "ETT globalt eier-tilkoblet credential-sett"-
  // mønster - ett Wallester Business-kundeforhold. Autentisering er
  // api_key/ts JWT signert RS256 (IKKE issuer/audience/sub/rbh - den
  // modellen gjaldt Wallester Card API, en ANNEN produkt-grense, se
  // wallester-transport.ts filhode). Selve nøkkelanskaffelsen
  // (BUSINESS_AUTH_SIGNING_MATERIAL) er PRIMARY_SOURCE_PUBLIC_DOC_GAP -
  // `sign` forblir injiserbar/fail-closed fremfor gjettet.
  const wallesterCredentialsProvider: WallesterCredentialsProvider = {
    async getCredentials(): Promise<WallesterCredentials | null> {
      const baseUrl = await readSecretProvider.get("JARVIS_WALLESTER_API_BASE_URL");
      const apiKey = await readSecretProvider.get("JARVIS_WALLESTER_API_KEY");
      const accountId = await readSecretProvider.get("JARVIS_WALLESTER_ACCOUNT_ID");
      const privateKeyPem = await readSecretProvider.get("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
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
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): egen
  // tjeneste over SAMME runtime-pool - ZERO ekstern leverandør (kun
  // interne kilder Jarvis allerede eier, se spend-service.ts). Avviks-
  // surfacing gjenbruker OpenLoopService (finance_spend_unexpected/
  // finance_spend_amount_deviation/finance_recurring_charge_missing/
  // finance_recurring_charge_duplicate/finance_spend_correction_conflict-
  // reglene) uendret.
  const spendService = new SpendService(pool);
  // D-246: samme fiks som stripe/vipps/neonomics/wallester over - leser nå
  // via readSecretProvider i stedet for rå process.env.
  const fikenCredentialsProvider: FikenCredentialsProvider = {
    async getCredentials(): Promise<FikenCredentials | null> {
      const refreshToken = await readSecretProvider.get("JARVIS_FIKEN_REFRESH_TOKEN");
      const companySlug = await readSecretProvider.get("JARVIS_FIKEN_COMPANY_SLUG");
      if (!refreshToken || !companySlug) return null;
      return { refreshToken, companySlug };
    }
  };
  // D-97: sentralisert GitHub rate-limit-kontroller - Postgres-baaret delt
  // tilstand (SHARED_RUNTIME, deles med worker-main.ts sin egen instans over
  // SAMME pool/tabell). `onTransition` er en bevisst minimal operativ-
  // synlighet-krok (§24) - IKKE en full EventWriter/tenant-audit-kobling
  // (GitHub-credentialen er global, ikke tenant-scoped, se D-97).
  const githubRateLimitController = new GithubRateLimitController(
    new PgGithubRateLimitStore(pool), "JARVIS_GITHUB_TOKEN",
    (event) => console.warn(`[github-rate-limit] ${event.transition} -> ${event.state}${event.retryAt ? ` retry_at=${event.retryAt.toISOString()} source=${event.source}` : ""}`)
  );
  // Remediering del 2 (JARVIS-065): systemidentitet med unik sesjons-id per oppstart (ingen falsk fast `sess-brief`).
  const ownerIdentity = systemIdentity(owner, "brief", { channel: "api" });
  // UA-10 P1 AKTIVERING (D-160): Situation Engine kobles til komposisjons-
  // roten for FØRSTE gang (P0 lot den bevisst stå ukoblet til det fantes en
  // reell kaller - den finnes nå: `situation-sweep`-jobben lenger ned).
  // DURABLE domene-pause med fail-closed `restore()` FØR noe kan kalle
  // motoren (en omstart glemmer aldri en aktiv pause), sovereign-eier-
  // autoritet for pause/policy/gjenoppretting = SAMME eier som
  // `ownerIdentity`/`PolicyGateway`. Kontrollflaten (`situations`-verktøyet)
  // registreres gjennom `firstWaveTools(..., { additionalTools })` under -
  // SAMME ene register-løkke, aldri en parallell registreringsvei.
  const situationDomainPauses = new DomainPauseRegistry(pool, { owner_person_id: ownerIdentity.person_id });
  await situationDomainPauses.restore();
  const situationEngine = new SituationEngine(pool, situationDomainPauses, { owner_person_id: ownerIdentity.person_id });
  // Task #118 ("Charlie"-minne-verifisering): hevet ut hit (FØR register-
  // løkken) slik at DEN SAMME instansen kan registreres som
  // `memory.search`-verktøyet i `additionalTools` under OG gjenbrukes av
  // `ConversationEngine` sin egen bakgrunns-kontekst (`conversationEngine`
  // under) - IKKE to separate `MemoryRetriever`-instanser mot samme pool.
  const memoryEmbedding = new LocalHashEmbedding();
  const memoryRetriever = new MemoryRetriever(pool, memoryEmbedding);
  // D-283 (Tobias direkte i chat, "ja bygg minne-skrivingen", ETTER at D-282
  // sin live-samtale avdekket at minnet var en HELT PASSIV lesestruktur -
  // `MemoryWriter`/ekstraksjon var bygget og enhetstestet, men ALDRI kalt fra
  // noe produksjonssted, se D-283 i DECISIONS_AND_ASSUMPTIONS.md): SAMME
  // delte `memoryEmbedding`-instans som `memoryRetriever` over
  // (deterministisk/lokal - ingen grunn til to separate objekter).
  // D-300 (Tobias direkte i chat, "husker han ingenting... vi trodde det
  // fungerte fungerte det ikke" - live telefon-testing avslørte at D-287 sin
  // regelbaserte extractor i praksis var for streng til reell samtale, kun
  // fire snevre signalord-mønstre): `LlmExtractionAdapter` (`extraction.ts`)
  // er nå den WIRED-INN implementasjonen - `gateway` (konstruert over) sendes
  // rett inn, den strukturelt-minimale `MemoryExtractionCompleter` den
  // faktisk krever er allerede oppfylt av en ekte `ModelGateway`.
  // `RuleBasedExtractor` forblir en deterministisk test-/referanse-
  // implementasjon, IKKE lenger wired inn her. Brukt KUN av
  // `conversationEngine` sin `memory.ingest()` under - ALDRI av
  // `IngestionService.ingestExternal()` (den forblir den separate,
  // Ingestion Zone-karantene-veien for EKSTERNT/ubetrodd innhold - e-post/
  // web/verktøyoutput - som er en helt annen tillitsklasse enn eierens egne
  // ord i en samtale, se `ingest`-kommentaren ved `conversationEngine` under).
  const memoryWriter = new MemoryWriter(pool, memoryEmbedding, new LlmExtractionAdapter(gateway), policy);
  // D-286 (Tobias "alle" - se retention-sweep.ts sitt filhode for full
  // begrunnelse): `SummaryService` FANTES fra før, men ble ALDRI konstruert
  // eller kalt fra noe produksjonssted (D-286 sitt eget funn) - kun
  // `memory-retention-sweep`-jobben under bruker den.
  const memorySummaries = new SummaryService(pool);
  // D-102: ÉN delt `TaskService`-instans - gjenbrukes UENDRET av `ConversationEngine`
  // (eksisterende `tasks.create`-goal-only-vei), den nye `/tasks/submit`-HTTP-ruten
  // (full `JobContract`, inkl. `agent_profile: "coding"`), OG (task #123, D-214)
  // `SelfModificationService.proposeCodeChange()` under - ALDRI to parallelle
  // `TaskService`-konstruksjoner mot samme pool. Hevet hit (tidligere lenger ned)
  // FORDI selfModificationService (rett under) nå trenger den ved konstruksjon.
  const taskService = new TaskService(pool, queue, policy, { codingRepoAllowlist: allowedReposFromEnv(process.env) });
  // D-125/task #123 (D-214): `sendTelegram` hevet hit (tidligere lenger ned, kun
  // brukt av Telegram-pollerens svarbane/DailyScheduler) - `SelfModificationService`
  // sin nye owner-varsling (se `notify` under) trenger DEN SAMME, allerede
  // ToolGateway-styrte send-banen, IKKE en egen, parallell varslingsmekanisme.
  // Avhenger KUN av `toolGateway`/`ownerIdentity`, begge allerede konstruert over.
  const sendTelegram = async (text: string) => {
    for (let i = 0; i < text.length; i += 3900) {
      await toolGateway.execute({ identity: ownerIdentity as never, tool_id: "telegram", action: "notify",
        parameters: { message: text.slice(i, i + 3900) } });
    }
  };
  // REMEDIERING DEL 1 (JARVIS-042/043): selvmodifikasjon er FRYST inntil
  // remedieringsdel 9 (SHA-bundet godkjenning, kill-switch-/freeze-respekt,
  // audit). `SelfModificationService` konstrueres IKKE, de tre 60-sekunders-
  // sveipene (`sweepPendingRequests`/`sweepPendingJobs`/`sweepApprovedRequests`)
  // startes IKKE, `self_modification.*` registreres IKKE i ToolGateway og
  // Telegram-kommandoene `/godkjenn`/`/avvis` har ingen handler. Modulen
  // `@jarvis/self-modification` ligger urørt og dormant i repoet.
  for (const tool of firstWaveTools({
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(githubRateLimitController),
    // D-247: `chatId` som en resolver mot `readSecretProvider` (samme
    // Infisical-primær kjede `JARVIS_TELEGRAM_TOKEN` allerede leses via) -
    // slås opp på nytt ved hvert `notify`-kall i stedet for å fryses fra
    // `process.env` ved oppstart (samme bug-klasse/fiks som D-246).
    telegram: new TelegramTransport(() => readSecretProvider.get("JARVIS_TELEGRAM_CHAT_ID")),
    // D-292: SlackTransport tar boten sin egen token direkte per kall (via
    // ToolGateway.execute() sin vanlige credential-oppslag, SAMME mønster som
    // GmailTransport/GithubTransport over) - ingen resolver-closure nødvendig
    // her, i motsetning til Telegram sin `chat_id` (Slack sender `channel`
    // som et vanlig model-/trusted-lag-parameter, ALDRI en fast bot-config).
    slack: new SlackTransport(),
    // D-294: samme mønster som Slack over - Discord sender `channel_id` som
    // et vanlig handlingsparameter per kall, ingen resolver-closure nødvendig.
    discord: new DiscordTransport(),
    // D-295: Twilio krever TO faste konfigurasjonsverdier utover selve
    // credential-en (`AccountSid`/`From`-nummer) - SAMME resolver-mot-
    // readSecretProvider-mønster som Telegram sin `chat_id` (D-247) over,
    // slått opp PÅ NYTT ved hvert kall, ikke frosset ved oppstart.
    twilio: new TwilioTransport(
      () => readSecretProvider.get("JARVIS_TWILIO_ACCOUNT_SID"),
      () => readSecretProvider.get("JARVIS_TWILIO_FROM_NUMBER")
    ),
    // D-296: ren tom-konstruktør, samme mønster som Slack/Discord over -
    // Brave Search sender `query` som et vanlig handlingsparameter per kall,
    // ingen resolver-closure nødvendig (ingen ekstra fast kontokonfigurasjon
    // slik Twilio krevde).
    brave_search: new BraveSearchTransport(),
    // D-297: Sentry krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (organisasjons-slug, URL-sti-parameter for ALLE fire
    // handlinger) - SAMME resolver-mot-readSecretProvider-mønster som Twilio
    // sin AccountSid (D-295) over, slått opp PÅ NYTT ved hvert kall.
    sentry: new SentryTransport(() => readSecretProvider.get("JARVIS_SENTRY_ORG_SLUG")),
    // D-298: ren tom-konstruktør, samme mønster som Slack/Discord/Brave
    // Search over - Google Maps sender `address`/`latlng` som et vanlig
    // handlingsparameter per kall, ingen resolver-closure nødvendig.
    google_maps: new GoogleMapsTransport(),
    // D-299: ren tom-konstruktør - `GoogleSheetsTransport` slår selv opp
    // `googleAccessToken()` internt per kall (samme mønster som Gmail/
    // Calendar/Drive sine transporter over, som ALLE også har tomme
    // konstruktører - access-token-utvekslingen skjer per `invoke()`-kall,
    // ikke ved konstruksjon).
    google_sheets: new GoogleSheetsTransport(),
    // D-301: ren tom-konstruktør, samme mønster som Brave Search over -
    // Tavily sender `query`/`api_key` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    tavily: new TavilyTransport(),
    // D-302: ren tom-konstruktør, samme mønster som Tavily over - Exa
    // sender `query`/`url` som vanlige handlingsparametere per kall, ingen
    // resolver-closure nødvendig.
    exa: new ExaTransport(),
    // D-303: ren tom-konstruktør, samme mønster som Google Maps over - Google
    // Places sender `query`/`place_id` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    google_places: new GooglePlacesTransport(),
    // D-304: ren tom-konstruktør, samme mønster som Google Maps/Google Places
    // over - Google Routes sender `origin`/`destination`/`origins`/
    // `destinations` som vanlige handlingsparametere per kall, ingen
    // resolver-closure nødvendig.
    google_routes: new GoogleRoutesTransport(),
    // D-305: Grafana krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (base-URL, siden Grafana typisk er selv-hostet uten et
    // fast SaaS-domene) - SAMME resolver-mot-readSecretProvider-mønster som
    // Sentry sin org-slug (D-297), slått opp PÅ NYTT ved hvert kall.
    grafana: new GrafanaTransport(() => readSecretProvider.get("JARVIS_GRAFANA_API_BASE_URL")),
    // D-306: SAMME resolver-mot-readSecretProvider-mønster som Grafana over
    // - Prometheus krever også en fast base-URL utover selve credential-en,
    // siden Prometheus også er typisk selv-hostet.
    prometheus: new PrometheusTransport(() => readSecretProvider.get("JARVIS_PROMETHEUS_API_BASE_URL")),
    // D-307: ren tom-konstruktør, samme mønster som Brave Search/Tavily/Exa
    // over - Dropbox sender `path` som et vanlig handlingsparameter per
    // kall, ingen resolver-closure nødvendig (ETT fast access-token, INGEN
    // OAuth-refresh-flyt som Google-familien).
    dropbox: new DropboxTransport(),
    // D-308: ren tom-konstruktør, samme mønster som Dropbox over - Notion
    // sender `Notion-Version` som en FAST header inni transporten selv
    // (ingen resolver-closure nødvendig, ETT fast integrasjonstoken).
    notion: new NotionTransport(),
    // D-309: ren tom-konstruktør, samme mønster som Dropbox/Notion over -
    // OneDrive sender `path`/`name` som vanlige handlingsparametere per
    // kall, ingen resolver-closure nødvendig.
    onedrive: new OneDriveTransport(),
    // D-310: ren tom-konstruktør, samme mønster som OneDrive over -
    // Microsoft Outlook sender parametere per handling, ingen
    // resolver-closure nødvendig.
    microsoft_outlook: new MicrosoftOutlookTransport(),
    // D-311: SAMME resolver-mot-readSecretProvider-mønster som Grafana/
    // Prometheus - n8n er også typisk selv-hostet.
    n8n: new N8nTransport(() => readSecretProvider.get("JARVIS_N8N_API_BASE_URL")),
    // D-313: tom konstruktør - `client_id`/`client_secret` leses direkte fra
    // env inne i `spotifyAccessToken()` (delt app-konfig, ikke en resolver).
    spotify: new SpotifyTransport(),
    // D-314: `phone_number_id` er Jarvis sin egen avsenderidentitet - SAMME
    // resolver-mot-readSecretProvider-mønster som Telegram sin chat_id.
    whatsapp: new WhatsAppTransport(() => readSecretProvider.get("JARVIS_WHATSAPP_PHONE_NUMBER_ID")),
    // D-315: SAMME resolver-mot-readSecretProvider-mønster som n8n - Make
    // sin API-base-URL er zone-spesifikk (brukerens kontosone).
    make: new MakeTransport(() => readSecretProvider.get("JARVIS_MAKE_API_BASE_URL")),
    // D-316: tom konstruktør - INGEN base-URL/org-slug nødvendig (fast
    // OpenAI-vertsnavn, kun Bearer-token).
    openai_images: new OpenAIImagesTransport(),
    // D-321: `from`-nummeret er Jarvis sin egen avsenderidentitet - SAMME
    // resolver-mot-readSecretProvider-mønster som Twilio (D-295).
    telnyx: new TelnyxTransport(() => readSecretProvider.get("JARVIS_TELNYX_FROM_NUMBER")),
    // D-322: tom konstruktør - fast Runway-vertsnavn, kun Bearer-token +
    // en fast X-Runway-Version-header (satt inni transporten selv).
    runway: new RunwayTransport(),
    // D-323: Kling krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (Access Key, brukt som JWT `iss`-claim) - SAMME
    // resolver-mot-readSecretProvider-mønster som Telnyx/Twilio over.
    // Secret Key (credential_ref) brukes til JWT-signering inni
    // transporten selv, ALDRI sendt uendret som header-verdi.
    kling: new KlingTransport(() => readSecretProvider.get("JARVIS_KLING_ACCESS_KEY")),
    // D-324: tom konstruktør - fast Gemini API-vertsnavn, kun
    // x-goog-api-key-header (SAMME auth-form som `gemini` sin EKSISTERENDE
    // model_provider-oppføring, se GoogleVeoTransport sin doc-kommentar).
    google_veo: new GoogleVeoTransport(),
    // D-327: Higgsfield krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (Key ID, brukt sammen med Key Secret i ETT
    // Authorization-header-felt) - SAMME resolver-mot-readSecretProvider-
    // mønster som Telnyx/Twilio/Kling over.
    higgsfield: new HiggsfieldTransport(() => readSecretProvider.get("JARVIS_HIGGSFIELD_KEY_ID")),
    // D-329: Todoist krever KUN selve credential-en (bearer-token, ingen
    // ekstra fast konfigurasjonsverdi) - samme tomme-konstruktør-mønster
    // som Discord/Notion over.
    todoist: new TodoistTransport(),
    // D-330: Trello krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en (API-nøkkel, brukt sammen med token som query-
    // parametere) - SAMME resolver-mot-readSecretProvider-mønster som
    // Telnyx/Twilio/Kling/Higgsfield over.
    trello: new TrelloTransport(() => readSecretProvider.get("JARVIS_TRELLO_API_KEY")),
    // D-331: Jira Cloud er PER-TENANT - krever TO faste konfigurasjons-
    // verdier utover selve credential-en (base-URL + e-post), SAMME
    // resolver-mot-readSecretProvider-mønster som Twilio (D-295) sin
    // to-resolver-form.
    jira: new JiraTransport(
      () => readSecretProvider.get("JARVIS_JIRA_BASE_URL"),
      () => readSecretProvider.get("JARVIS_JIRA_EMAIL")
    ),
    // D-332: Linear krever KUN selve credential-en (rå API-nøkkel i
    // Authorization-headeren, ingen ekstra fast konfigurasjonsverdi) -
    // samme tomme-konstruktør-mønster som Discord/Notion/Todoist over.
    linear: new LinearTransport(),
    // D-333: HubSpot krever KUN selve credential-en (Bearer private
    // app-token, ingen ekstra fast konfigurasjonsverdi) - samme
    // tomme-konstruktør-mønster som Discord/Notion/Todoist/Linear over.
    hubspot: new HubSpotTransport(),
    // D-334: Pipedrive er PER-TENANT (samme mønster som Jira sin base-URL-
    // resolver, D-331) - krever ÉN fast konfigurasjonsverdi utover selve
    // credential-en.
    pipedrive: new PipedriveTransport(() => readSecretProvider.get("JARVIS_PIPEDRIVE_BASE_URL")),
    // D-242/D-248: `vercel` hadde en `live_test` siden D-213, men ALDRI en
    // ekte transport her - falt gjennom til `UnconfiguredHttpTransport`
    // (ubetinget `vercel_not_configured`), uansett credential-tilstand (se
    // `live-transports.ts` sin `VercelTransport`-doc-kommentar for full
    // begrunnelse).
    vercel: new VercelTransport(),
    // D-90 (UA-4 NESTE SLICE): Business OS × Marketing Memory-integrasjon -
    // `marketingMemoryBriefSource(growthService)` injiseres her (app-laget,
    // som allerede har BEGGE tjenestene) i stedet for at `@jarvis/business`
    // importerer `@jarvis/growth` direkte (ville vært sirkulært, se
    // `business-os-integration.ts`).
    business: new BusinessTransport(
      businessService, openLoopService, pool, toolGateway, scoringService,
      [marketingMemoryBriefSource(growthService)]
    ),
    // SAMME lazy-init-mønster som BusinessTransport sin `requireEventSync()`
    // (D-49): `SupportTransport` får `toolGateway` DIREKTE (objektreferansen
    // finnes allerede, selv om selve register()-loopen ikke er ferdig ennå) -
    // bygger `SupportEmailService` lat ved første `reply`/`ingest`-kall.
    support: new SupportTransport(supportService, businessService, toolGateway),
    contract: new AgreementsTransport(agreementsService),
    // UA-3 Native Jarvis Product Core (D-128): SAMME lat/enkel-avhengighet-
    // mønster som AgreementsTransport over (INGEN toolGateway/
    // ToolInvocationContext, ingen nøstet klasse D-handling).
    product: new ProductTransport(productService),
    // UA-3 Native Jarvis Operations Core (D-129): identisk wiring-mønster som ProductTransport over.
    operations: new OperationsTransport(operationsService),
    growth: new GrowthTransport(growthService),
    // UA-4 Google Ads-slice (D-83): SAMME lat/enkel-avhengighet-mønster som
    // GrowthTransport over - INGEN toolGateway/ToolInvocationContext (ingen
    // nøstet klasse D-handling i denne sliceen).
    googleads: new GoogleAdsTransport(growthService),
    // D-335 (UA-4 Meta Ads-slice): SAMME lat/enkel-avhengighet-mønster som
    // GoogleAdsTransport over - INGEN toolGateway/ToolInvocationContext.
    metaads: new MetaAdsTransport(growthService),
    // UA-6 Finance & Spend Integrity Gateway (D-107): SAMME lat/enkel-
    // avhengighet-mønster som GrowthTransport/GoogleAdsTransport over -
    // INGEN toolGateway/ToolInvocationContext (ingen nøstet klasse D-
    // handling i denne sliceen - `submit_payment_intent` sin klasse D er
    // selve handlingen, ikke en nøstet under-handling).
    finance: new FinanceTransport(financeService, fikenCredentialsProvider),
    // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): eget
    // `finance_spend.*`-namespace, SEPARAT fra `finance` over - SAMME
    // lat/enkel-avhengighet-mønster som GrowthTransport (INGEN
    // toolGateway/ToolInvocationContext, ingen provider-kall i dette
    // namespacet i det hele tatt).
    finance_spend: new SpendTransport(spendService),
    // D-109 (UA-6 Slice 3): eget `finance_stripe.*`-namespace, SEPARAT fra
    // `finance`/`finance_spend` over - SAMME lat/enkel-avhengighet-mønster
    // (INGEN toolGateway/ToolInvocationContext).
    finance_stripe: new StripeFinanceTransport(financeService),
    // D-110 (UA-6 Slice 4): eget `finance_vipps.*`-namespace - SAMME mønster.
    finance_vipps: new VippsFinanceTransport(financeService),
    // D-111 (UA-6 Slice 5): eget `finance_neonomics.*`-namespace - SAMME mønster.
    finance_neonomics: new NeonomicsFinanceTransport(bankingService, financeService),
    // D-112 (UA-6 Slice 6): eget `finance_wallester.*`-namespace - SAMME mønster.
    finance_wallester: new WallesterFinanceTransport(cardService),
    // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
    // Core - SAMME lat/enkel-avhengighet-mønster som GrowthTransport/
    // AgreementsTransport over (INGEN toolGateway/ToolInvocationContext,
    // ingen nøstet klasse D-handling).
    consent: new ConsentTransport(consentService, consentEnforcementService),
    // D-105 (UA-5 kriterium 1+3): egen Docker-transport - JARVIS_DOCKER_BIN
    // gater tilgjengelighet SAMME vei som ethvert annet credential_ref (se
    // docker-transport.ts) - uten den satt er "docker" strukturelt
    // credential_unavailable, ALDRI et stille fall til en ambient binærsti.
    docker: new DockerTransport(),
    // D-337 (Google Cloud "servere"-sliceen): SAMME lat/tom-konstruktør-
    // mønster som DockerTransport over - JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN
    // gater tilgjengelighet, JARVIS_GOOGLE_CLOUD_PROJECT_ID leses direkte
    // fra env (se gce-transport.ts).
    gce: new GceTransport(),
    // D-338 (MCP Zapier discovery-only sliceen): lat/tom-konstruktør - selve
    // URL-en (hemmelighets-ekvivalent) leses via credential_ref inni
    // ToolGateway sin secret-provider-kjede, ALDRI konstruktør-parameter
    // (se mcp-zapier-transport.ts).
    mcp_zapier: new McpZapierTransport(),
    // D-339 (Playwright-sliceen): lat/tom-konstruktør - selve base-URL-en
    // (ingen ekte hemmelighet, kun en konfigurert adresse til
    // apps/browser-gateway sin egen prosess) leses via credential_ref inni
    // ToolGateway sin secret-provider-kjede, ALDRI konstruktør-parameter
    // (se browser-transport.ts).
    browser: new BrowserGatewayTransport(process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? ""),
    // UA-7 Communications Hub - foerste slice (D-119): eget
    // `conversation_graph.*`-namespace. D-119 FINAL AUTHORITY HARDENING:
    // denne transporten MOTTAR og KREVER `ToolInvocationContext` (D-68) -
    // tenant/space avledes UTELUKKENDE fra den, aldri fra kallerparametre
    // (se `transport.ts` sitt filhode). Navnerommet er READ-ONLY via
    // ToolGateway (`merge_identities`/`split_merge`/`link_channel_identity`
    // alle fjernet - canonical mutasjon skjer kun via
    // `ConversationGraphSyncService`, direkte mot service-en).
    conversation_graph: new ConversationGraphTransport(conversationGraphService),
    ...driveTransportsIfConfigured()
  }, {
    // D-105 host-fix (D-41-korreksjon): eier-konfigurert produksjonsmål-
    // autorisasjon for docker-mutasjon - parset ÉN gang ved oppstart (samme
    // "les env her, tre inn i konstruktør/config"-mønster som resten av
    // denne funksjonen). Tom/ukonfigurert -> INGEN produksjonsmål autorisert
    // (fail-closed, se docker-target-policy.ts) - sentinel-mål (host-
    // akseptanse) er alltid tilgjengelig uavhengig av denne variabelen.
    dockerMutationTargets: parseDockerMutationTargets(process.env["JARVIS_DOCKER_MUTATION_TARGETS"]),
    // D-337: SAMME "les env ÉN gang ved oppstart, fail-closed hvis tom"-
    // mønster som dockerMutationTargets over - se gce-target-policy.ts.
    gceMutationTargets: parseGceMutationTargets(process.env["JARVIS_GCE_MUTATION_TARGETS"]),
    // UA-10 P1 (D-160): eierens kontrollflate for Situation Engine - se over.
    // UA-11 Executive Mode P0 (D-162): den SAMLEDE attention-ranking-/
    // kontrollflaten - komponerer `situations.*` via DENNE SAMME
    // `toolGateway`-instansen (nøstet `gateway.execute()`, ALDRI
    // `situationEngine`/`situationDomainPauses` direkte) - se
    // `@jarvis/executive` sitt filhode for hele begrunnelsen. Ren tilføyelse
    // på slutten av listen, SAMME ene register-løkke som resten av verktøyene.
    // K1 (Sovereign graduation, D-164): kanonisk owner_controls.*-flate over
    // DE SAMME `killSwitch`/`ownerControls`-instansene `policy`/`toolGateway`
    // selv bruker - IKKE en kopi. Registrert i SAMME liste/løkke som
    // `situations`/`executive`, ingen parallell registreringsvei.
    additionalTools: [
      ...situationsToolDefinitions(new SituationsTransport(situationEngine, situationDomainPauses)),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(toolGateway, { modelSurface: MODEL_SURFACE_ALLOWLIST }))),
      // D-174 (B2): tredje konstruktør-argument kobler `owner_controls.revoke_device`
      // til DEN SAMME `pool`/`grantService`/`ownerControlAuthority` som resten
      // av eier-autoritets-/session-grant-mønstrene i denne filen - IKKE en ny,
      // parallell tilstand. Se `OwnerControlsService.revokeDevice()` sitt filhode.
      // Task #122 (D-213): andre konstruktør-argument - DEN SAMME `toolGateway`-
      // instansen (allerede konstruert over) - kobler `set_connector_credential`/
      // `test_connector` til `ToolGateway.setSecret()`/nøstet `execute()`.
      ...ownerControlsToolDefinitions(new OwnerControlsTransport(new OwnerControlsService(killSwitch, ownerControls, {
        pool,
        grants: grantService,
        devices: new DeviceService(pool),
        authority: ownerControlAuthority
      }), toolGateway)),
      // UA-11 Executive Mode "K2" (D-64): decision log/scenarios/risk register/
      // goals-OKRs - RENE journalposter over DEN SAMME `pool`-instansen som
      // resten av denne filen (`withMemoryTransaction`, se `GovernanceService`
      // sitt filhode) - IKKE en parallell tilkobling. Registrert i SAMME
      // liste/løkke som `situations`/`executive`/`owner_controls`.
      ...governanceToolDefinitions(new GovernanceTransport(new GovernanceService(pool))),
      // Task #118 ("Charlie"-minne-verifisering): `memory.search` over DEN
      // SAMME `memoryRetriever`-instansen `conversationEngine` under gjenbruker
      // for bakgrunnskontekst - se `memoryRetriever` sin egen filhode-kommentar
      // lenger opp for hvorfor den ble hevet ut hit.
      ...memoryToolDefinitions(new MemorySearchTransport(memoryRetriever))
    ]
  })) toolGateway.register(tool);
  // REMEDIERING DEL 1 (JARVIS-002): `allMeshTools()` (hele registeret) er IKKE
  // lenger koblet til noen aktiv flate. Chat, tale, Telegram og executive-jobber
  // får KUN det eksplisitte lese-minimumssettet (`MODEL_SURFACE_ALLOWLIST`);
  // oppstarten feiler lukket hvis noe i flaten ikke er klasse A / ren lesing.
  const modelToolSurface = resolveModelToolSurface(toolGateway);
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans (allerede
  // registrert med Gmail/Calendar over) - ingen ny transport-vei.
  const businessEventSyncService = new BusinessEventSyncService(toolGateway, businessService, openLoopService);
  // UA-7 Communications Hub - foerste slice (D-119): SAMME toolGateway-
  // instans (allerede registrert med Gmail over) - ingen ny transport-vei,
  // gjenbruker DENNE toolGateway-instansens `email.list_messages` (den
  // SAMME motpart-e-post-utledningen som businessEventSyncService, kun i en
  // egen, tynn synk-tjeneste for å unngå en sirkulær pakkeavhengighet - se
  // `@jarvis/conversation-graph` sin `sync.ts`).
  const conversationGraphSyncService = new ConversationGraphSyncService(toolGateway, businessService, conversationGraphService);
  // UA-3 Native Jarvis Support Core (D-66) §7/§24: egen instans for den
  // periodiske innboks-sveipen (SAMME mønster som `businessEventSyncService`
  // over - en direkte, parallell instans, IKKE den lazy interne i
  // SupportTransport) - SAMME toolGateway/businessService, ingen ny transport-vei.
  const supportEmailService = new SupportEmailService(toolGateway, businessService, supportService);
  // BO-11.1 §9: SAMME executive-handler som worker-containeren (delt fil) - api-workeren
  // som vinner queue-racet skal håndtere tools=true-jobber identisk (uten sandbox).
  worker.register(
    "executive",
    executiveHandler({
      gateway,
      tools: {
        definitions: modelToolSurface.map((t) => t.def),
        // D-351: 4000 → 20_000 (se mesh-bridge.ts sitt filhode for host-målt begrunnelse).
        executor: new MeshToolExecutor(toolGateway, ownerIdentity, 20_000, modelToolSurface)
      }
    })
  );

  // D-123 (Q-32 punkt 2): ÉN delt instans av hver identitetsprimitiv.
  // `DeviceService` holder utstedte challenges in-memory, så en egen instans
  // til voice-autoriteten ville aldri gjenkjent en nonce utstedt av
  // `/devices/challenge` - to instanser er her en STILLE funksjonsfeil, ikke
  // bare uryddig. Samme delings-disiplin som D-102 sin `taskService`.
  const identityService = new IdentityService(pool);
  const deviceService = new DeviceService(pool);
  const sessionService = new SessionService(pool);
  // D-131 (uavhengig arkitektkontroll av PR #79): SAMME delings-disiplin som
  // over. `SessionGrantService` eier `session_grants` - det avgrensede,
  // revokerbare autorisasjonsbeviset som erstatter «rå session_id = autentisert
  // enhet» - og `DeviceEnrollmentService` er den ENESTE nettverksnære veien til
  // å skrive nytt enhetsnøkkelmateriale. `grantService` er nå hoistet lenger
  // opp (D-174, B2) - gjenbrukt uendret her, ALDRI en duplikat konstruksjon.
  const enrollmentService = new DeviceEnrollmentService({
    pool,
    devices: deviceService,
    grants: grantService
  });
  // Autoritetene eier sin egen transaksjon (D-131 funn 3: hele autorisasjonen
  // må kunne rulles tilbake ved avslag), og trenger derfor SAMME pool som
  // tjenestene de komponerer.
  const authorityDeps = {
    pool,
    devices: deviceService,
    sessions: sessionService,
    identity: identityService,
    grants: grantService
  };
  // D-125 (UA-7, FEMTE slice): ÉN delt `ConversationEngine`-instans. Den er
  // hevet ut av `deps`-literalen fordi den inngående Telegram-banen skal bruke
  // NØYAKTIG samme motor som `/chat` - ikke en parallell konstruksjon (samme
  // delings-disiplin som D-102 sin `taskService` og D-123 sine identitets-
  // primitiver). To instanser ville gitt to separate verktøy-/trace-oppsett
  // mot samme pool, altså en stille divergens mellom kanalene.
  const conversationEngine = new ConversationEngine({
    messages: new MessageStore(pool),
    context: new ContextBuilder(pool),
    gateway,
    tasks: taskService,
    worker,
    trace,
    memory: {
      contextFor: (identity, userText) => memoryRetriever.contextFor(identity, userText),
      // D-283: eierens EGNE ord i denne samtalen (chat OG tale - BEGGE går
      // via SAMME `/chat`, se D-30-kommentaren ved `tools` under) skrives nå
      // faktisk til minnet, IKKE lenger en ren lesestruktur. `trust:
      // "trusted"` - eieren som snakker DIREKTE til Jarvis er den høyeste
      // tillitskilden i systemet, STRUKTURELT forskjellig fra §7 sin
      // Ingestion Zone-karantene (den gjelder UBETRODD/EKSTERNT innhold -
      // e-post/web/verktøyoutput/MCP - ALDRI eierens egne ytringer til
      // Jarvis selv). `ref: identity.session_id` tagger kilden med
      // sesjonen (rule 4: "kilde og task_id/session_id"). Feil her
      // SVELGES av kalleren (`conversation.ts` sin `.catch()`) - en
      // minnefeil skal ALDRI ødelegge selve samtalesvaret.
      ingest: (identity, text) =>
        memoryWriter.ingestText(identity, { kind: "conversation", ref: identity.session_id, trust: "trusted" }, text)
    },
    council: aiCouncil,
    // D-30 live-funn: samtalebanen (tekst + voice via /chat) har verktøykall.
    // REMEDIERING DEL 1 (JARVIS-002/JARVIS-035): kun det eksplisitte lese-
    // minimumssettet. `delegate_code_task` (nøstet sky-kall med hardkodet
    // PUBLIC-sensitivitet som omgår `paid_models_allowed`/policy, D-354/D-355)
    // er FRYST av flaten inntil en senere remedieringsfase har gjort
    // delegeringen policy-/budsjettstyrt. Executor bindes til samtalens
    // RESOLVED identity (aldri ownerIdentity) - autorisasjon/D-pipeline/audit
    // håndheves uendret per kall i ToolGateway.
    tools: {
      definitions: modelToolSurface.map((t) => t.def),
      // D-351: 4000 → 20_000 (se mesh-bridge.ts sitt filhode for host-målt begrunnelse).
      executorFor: (identity) => new MeshToolExecutor(toolGateway, identity, 20_000, modelToolSurface)
    },
    // Task #121 (D-214): kosmetisk personlighetslag, se conversation.ts sin
    // `buildSystemPrompt()`/`loadPersonality()`.
    personality: loadPersonalityConfig
  });
  const deps: ApiDeps = {
    // Del 2 (JARVIS-065): den validerte eier-identiteten fyller visningsfeltene i /chat, /dashboard og /voice
    // (aldri autoritet - den kommer fra et verifisert grant). Uten denne svarer sidene 503 `owner_not_configured`.
    owner: { tenant_id: owner.tenant_id, person_id: owner.owner_person_id },
    identity: identityService,
    devices: deviceService,
    grants: grantService,
    enrollment: enrollmentService,
    voiceAuthority: new VoiceSessionAuthority(authorityDeps),
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: SAMME delte instanser som
    // `voiceAuthority` over (D-123-delingsdisiplinen - `DeviceService` holder
    // utstedte challenges in-memory, så en egen instans her ville aldri
    // gjenkjent en nonce utstedt av `/devices/challenge`/`/session/authorize`).
    channelAuthority: new ChannelSessionAuthority(authorityDeps),
    brief: {
      generate: (identity) => dailyBrief.generate(identity as never),
      render: (artifact) => DailyBrief.render(artifact as never)
    },
    sessions: sessionService,
    policy,
    worker,
    tasks: taskService,
    incidents: {
      service: incidentService, deployments: deploymentService, diagnosis: diagnosisService,
      gateway: toolGateway, controls: ownerControls, infraGate, pool
    },
    // D-109 (UA-6 Slice 3): eksponerer FinanceService for `/webhooks/stripe`-
    // ruten i server.ts - webhook-ingestion krever rå (usignert-parset) body
    // og skjer derfor UTENFOR den generiske `readBody()`-JSON-parseren, se
    // server.ts sin nye rute-gren.
    finance: { service: financeService, cards: cardService },
    conversation: conversationEngine,
    // D-199 (UA-11 Executive dashboard-UI, lese-delen): SAMME toolGateway-
    // instans som resten av deps over (incidents.gateway osv.) - `/executive/
    // query` i server.ts begrenser seg selv til et hardkodet lese-kun
    // allowlist, ingen ny autorisasjonsmekanisme her.
    executive: { gateway: toolGateway }
  };
  // D-196: samme drain-løkke som worker-main.ts (linje ~486) - MEN den
  // logget ALDRI en `tick()`-feil her (feil under selve claim/complete/fail-
  // kallene mot DB, ikke en per-oppgave-handler-feil - de er allerede
  // sikkert isolert inne i `InProcessWorker.tick()` og skrevet til
  // `queue.fail()`). En slik feil ville stille stanset denne prosessens
  // "executive"-oppgavekø (ConversationEngine sin `tasks.create()`-vei) UTEN
  // noe varsel - samme leksjon som D-180 allerede fastslo for
  // `Watchdog.tick()`, aldri anvendt på DENNE identiske mekanismen.
  setInterval(
    () => void worker.drain().catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
    2_000
  ).unref();

  const dailyBrief = new DailyBrief([
    tasksSource(pool), buildStatusSource(toolGateway),
    emailSource(toolGateway), calendarSource(toolGateway)
  ], pool);
  const aiMeshText = async () => {
    const mesh = gateway.meshStatus();
    const lines = mesh.providers
      .filter((p) => p.provider !== "scripted")
      .map((p) => `${p.provider.padEnd(10)} ${p.state}${p.avg_latency_ms ? ` ~${p.avg_latency_ms}ms` : ""}`);
    return `AI MESH
${lines.join("\n")}
Router     ${mesh.router}
Fallback   ${mesh.fallback}
Critic     ${mesh.critic}`;
  };
  // BO-12 §37: voice-helse fra gatewayens /status når den kjører (egen prosess).
  const voiceText = async (): Promise<string> => {
    const voiceUrl = process.env["JARVIS_VOICE_URL"];
    if (!voiceUrl) {
      return "Voice      ikke konfigurert (JARVIS_VOICE_URL)";
    }
    try {
      const status = (await (await fetch(`${voiceUrl}/status`, { signal: AbortSignal.timeout(2_000) })).json()) as {
        stt: { name: string; state: string };
        tts: { name: string; state: string };
        transport: string;
        barge_in: string;
      };
      return `Voice
  STT      ${status.stt.name} ${status.stt.state}
  TTS      ${status.tts.name} ${status.tts.state}
  Transport ${status.transport}
  Barge-in ${status.barge_in}`;
    } catch {
      return "Voice      UNAVAILABLE (gateway svarer ikke)";
    }
  };
  const statusText = async () => {
    const gates = [...toolGateway.health.entries()].map(([k, v]) => `${k}:${v.state}`).join(" ");
    return `JARVIS STATUS
fase: v4.0 UA-1 P1A + D-30 voice foundation
connectors: ${gates || "ingen kall enda"}
${await aiMeshText()}
${await voiceText()}
porter: se docs/RUNTIME_GATES.md`;
  };
  if (process.env["JARVIS_TELEGRAM_TOKEN"] && process.env["JARVIS_TELEGRAM_CHAT_ID"]) {
    // D-125 (UA-7, FEMTE slice): den betrodde server-side eier-autoriteten for
    // inngående Telegram. HVER verdi kommer fra prosessens egen konfigurasjon
    // og fra `seedOwner()`-radene (`apps/api/src/seed.ts`) - INGEN av dem kan
    // påvirkes av en Telegram-melding. `person_id` utledes med SAMME uttrykk
    // som seeden (`JARVIS_OWNER_PERSON_ID`), ikke hardkodet, slik at en
    // konfigurert eier-ID ikke gir `unknown_membership` mot en seedet database.
    const telegramOwnerAuthority = new TelegramOwnerAuthority(
      { sessions: sessionService, identity: identityService },
      {
        owner_chat_id: process.env["JARVIS_TELEGRAM_CHAT_ID"],
        tenant_id: owner.tenant_id,
        person_id: owner.owner_person_id,
        // Tjeneste-enheten denne prosessen allerede ER seedet som.
        device_id: "jarvis-core",
        memory_space: "personal"
      }
    );
    new TelegramCommandPoller(process.env["JARVIS_TELEGRAM_TOKEN"], process.env["JARVIS_TELEGRAM_CHAT_ID"], {
      brief: async () => DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)),
      status: statusText,
      ai: aiMeshText,
      // D-125: vanlig eier-tekst inn i den KANONISKE samtalebanen. Ingen ny
      // chat-motor, ingen ny identitetslagring, ingen ny sesjonsmodell.
      chat: async ({ chat_id, text }) => {
        // 1. Uavhengig, server-side autoritet. Meldingsteksten er ALDRI et
        //    argument her - se `authorize()`-signaturen. Avslag ⇒ `undefined`
        //    ⇒ polleren sender ingenting (fail-closed, ingen bekreftelse).
        const authorized = await telegramOwnerAuthority.authorize(chat_id);
        if (!authorized.ok) return undefined;
        // 2. Idempotent eier-identitetslenking i Conversation Graph (D-119).
        //    KUN den konfigurerte chat-ID-en deltar; `match_method` forblir
        //    `owner_configured`. En feil her skal aldri hindre selve samtalen
        //    - lenken er proveniens, ikke en autorisasjonsavhengighet.
        try {
          await conversationGraphSyncService.linkOwnerTelegramIdentity(
            authorized.identity.tenant_id,
            authorized.identity.memory_space_id,
            authorized.chat_id,
            authorized.identity.person_id
          );
        } catch (err) {
          console.error(JSON.stringify({
            msg: "telegram_owner_identity_link_failed",
            reason: err instanceof Error ? err.message.slice(0, 120) : "unknown"
          }));
        }
        // 3. SAMME motor som /chat, bundet til den OPPLØSTE identiteten.
        const result = await conversationEngine.handle(authorized.identity, text);
        return result.reply;
      }
      // REMEDIERING DEL 1: `/godkjenn`/`/avvis` (selvmodifikasjon) har ingen handler - frosset (JARVIS-042/043).
    }, sendTelegram).start();
    // BO-05: reboot-durabel morgenlevering (DB-laas, Europe/Oslo, catch-up, aldri duplikat).
    // Bruker DailyBrief.deliverViaTelegram() (ikke den generiske sendTelegram-
    // closuren over) FORDI den idempotency-nøkler hver chunk på
    // brief.generated_at+indeks - en re-kjørt/gjentatt levering (f.eks. etter
    // en prosessrestart midt i en flerdelt brief) kan derfor aldri duplisere
    // en allerede sendt del. sendTelegram selv har ingen idempotency-nøkkel og
    // sjekker heller ikke gateway-resultatet - fin for generiske
    // kommandosvar (TelegramCommandPoller over), men FEIL for den daglige
    // morgenleveringen, der en stille tapt levering ville sett ut som
    // "jobb fullført" for DailyScheduler.
    new DailyScheduler(pool).start(async () => {
      const brief = await dailyBrief.generate(ownerIdentity as never);
      const delivered = await DailyBrief.deliverViaTelegram(toolGateway, ownerIdentity as never, brief);
      if (!delivered) {
        console.error(JSON.stringify({ msg: "daily_brief_delivery_failed", generated_at: brief.generated_at }));
      }
    });
  }
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2) §12:
  // periodisk intern utgifts-synk (marketing/model_cost) + matching/
  // avstemming + deterministisk avviksdeteksjon - SAMME reboot-durable
  // DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env). Kjøres
  // FØR business-open-loop-sweep (default kl. 06) slik at de fem nye
  // finance_spend_*-open-loop-reglene ser FERSKE avviksflagg når den
  // sveipen kjører (default kl. 04) - REN passiv observasjon/regnskap,
  // ALDRI påvirket av finance_kill_switch (se spend-service.ts §13-JSDoc).
  new DailyScheduler(
    pool, "finance-spend-integrity-sweep", envHour("JARVIS_FINANCE_SPEND_SWEEP_HOUR", 4)
  ).start(() => runFinanceSpendIntegritySweepForAllTenants(pool, spendService).then(() => undefined));
  // D-109 (UA-6 Slice 3) §15: periodisk Stripe-utfallssynk (explicit GET-
  // refresh av `provider_acknowledged`-rader) + provider-avviksdeteksjon -
  // SAMME reboot-durable DailyScheduler-mekanisme (eget job_name, egen
  // klokkeslett-env). Kjøres FØR finance-spend-integrity-sweep (default
  // kl. 03, mot kl. 04) slik at ferske Stripe-utfall er tilgjengelige når
  // resten av finans-sveipet kjører samme morgen. Trygt å kjøre uten
  // JARVIS_STRIPE_SECRET_KEY konfigurert - `listBusinessTenantIds` finner
  // ingen `provider_acknowledged`-Stripe-rader å synke før noen faktisk
  // sender en Stripe-betaling.
  new DailyScheduler(
    pool, "stripe-payment-sync", envHour("JARVIS_STRIPE_SYNC_HOUR", 3)
  ).start(() => runStripePaymentSyncForAllTenants(pool, financeService).then(() => undefined));
  // D-110 (UA-6 Slice 4) §14: periodisk Vipps-utfallssynk + provider-
  // avviksdeteksjon - SAMME mekanisme/begrunnelse som stripe-payment-sync
  // over (eget job_name, egen klokkeslett-env, trygt å kjøre uten
  // JARVIS_VIPPS_*-credentials konfigurert).
  new DailyScheduler(
    pool, "vipps-payment-sync", envHour("JARVIS_VIPPS_SYNC_HOUR", 3)
  ).start(() => runVippsPaymentSyncForAllTenants(pool, financeService).then(() => undefined));
  // D-111 (UA-6 Slice 5) §17: periodisk open-banking-sveip (samtykke-
  // verifisering/konto-/transaksjonssynk/betalingsstatus/avstemming/avvik)
  // - SAMME mekanisme/tidsvindu-klasse som Stripe-/Vipps-sveipene. Trygg
  // uten JARVIS_NEONOMICS_*-credentials (provider-steg blir no-op, de
  // rent lokale avstemmings-/avviks-stegene kjører fortsatt).
  new DailyScheduler(
    pool, "neonomics-sweep", envHour("JARVIS_NEONOMICS_SYNC_HOUR", 3)
  ).start(() => runNeonomicsSweepForAllTenants(pool, bankingService, financeService).then(() => undefined));
  // D-112 (UA-6 Slice 6): daglig Wallester-kortsveip (tilstands-/
  // autorisasjons-/transaksjonssynk -> avstemming -> avviksdeteksjon) -
  // SAMME reboot-durable DailyScheduler-mekanisme.
  new DailyScheduler(
    pool, "wallester-sweep", envHour("JARVIS_WALLESTER_SYNC_HOUR", 5)
  ).start(() => runWallesterSweepForAllTenants(pool, cardService).then(() => undefined));
  // UA-3 next slice (D-53) §19/§20: periodisk open-loop-sveip - gjenbruker SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av om Telegram er konfigurert (deteksjon != levering).
  new DailyScheduler(
    pool, "business-open-loop-sweep", envHour("JARVIS_BUSINESS_SWEEP_HOUR", 6)
  ).start(() => runOpenLoopSweepForAllTenants(pool, openLoopService).then(() => undefined));
  // D-198 (V4-revisjon, masterplanens "Business Operating Loop"): UKENTLIG
  // (ALDRI daglig - se runBusinessWeeklyBriefForAllTenants() sin doc-
  // kommentar for hvorfor en daglig push her ville duplisert situations-
  // broens allerede eksisterende sanntidsvarsling) push av
  // generateWeeklyBrief()/renderWeeklyBrief() (D-53, fantes allerede men var
  // ALDRI schedulert - kun on-demand via business.get_business_brief).
  // SAMME reboot-durable DailyScheduler-mekanisme (claimer/markerer fullført
  // HVER dag - selve leveransen er en ren no-op utenom den konfigurerte
  // ukedagen, se isWeeklyBriefDay()). Default mandag (JARVIS_BUSINESS_
  // WEEKLY_BRIEF_WEEKDAY=1) kl. 07 (JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR).
  new DailyScheduler(
    pool, "business-weekly-brief", envHour("JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR", 7)
  ).start(async () => {
    if (!isWeeklyBriefDay(new Date(), "Europe/Oslo", envInt("JARVIS_BUSINESS_WEEKLY_BRIEF_WEEKDAY", 1, { min: 0, max: 7 }))) return;
    const result = await runBusinessWeeklyBriefForAllTenants(pool, toolGateway, (tenantId) => ({
      ...ownerIdentity, tenant_id: tenantId, memory_space_id: "business", session_id: `${ownerIdentity.session_id}-weekly-brief`
    }));
    if (result.errors.length > 0) {
      console.error(JSON.stringify({ msg: "business_weekly_brief_failed", errors: result.errors }));
    }
  });
  // UA-10 P1 AKTIVERING (D-160): situasjons-sveipen - ingest fra
  // `business_open_loops` -> `situations`, kildebasert løsning, evidens-først
  // INFORM/SUGGEST-leveranse via `telegram.notify`, og auto-ACT KUN under en
  // eksplisitt eier-policy (`situation_autonomy_policies`). SAMME reboot-
  // durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env).
  // Kjøres ETTER business-open-loop-sweep (default kl. 06 -> kl. 07) slik at
  // dagens ferske loops er detektert FØR de oversettes til situasjoner.
  // Identiteten per tenant er eierens identitet i sveipens space; en tenant
  // eieren ikke er autorisert for avvises av PolicyGateway inne i
  // `execute()` (fail-closed) - aldri en stille utelatelse her.
  // Arkitekt-review runde 1 på PR #86 (funn 3): resultatet KASTES ALDRI
  // bort - `assertSituationSweepHealthy()` kaster på ikke-tom `errors[]`,
  // evidensmismatch, ulevert varsel eller identitetskonflikt, så
  // `DailyScheduler` aldri bokfører en slik kjøring som fullført
  // (`completed_at` forblir NULL) og en `situation_sweep_failed`-linje
  // logges strukturert.
  new DailyScheduler(
    pool, "situation-sweep", envHour("JARVIS_SITUATION_SWEEP_HOUR", 7)
  ).start(() => runSituationSweepForAllTenants(pool, {
    openLoops: openLoopService,
    // D-195 (infra-slice): SAMME allerede-konstruerte `incidentService`
    // (UA-5/D-104) - bygger BARE på situasjoner via `infra-incident-bridge.ts`,
    // oppfinner INGEN ny deteksjonskilde. Se sweep.ts sin `IncidentReader`-
    // doc-kommentar for hvorfor dette feltet er frivillig (bakoverkompatibelt).
    incidents: incidentService,
    engine: situationEngine,
    gateway: toolGateway,
    identityFor: (tenantId, memorySpace) => ({
      ...ownerIdentity, tenant_id: tenantId, memory_space_id: memorySpace, session_id: `${ownerIdentity.session_id}-situation-sweep`
    })
  }).then(assertSituationSweepHealthy));
  // UA-3 business-event-linkage (D-57) §19/§20/§21: periodisk Gmail/Calendar->
  // Business-OS-synkronisering - SAMME reboot-durable DailyScheduler-mekanisme
  // (eget job_name, egen klokkeslett-env), uavhengig av Telegram-konfig.
  // Kjøres FØR open-loop-sveipet i klokkeslett (default 05) slik at nylig
  // synkroniserte aktiviteter er tilgjengelige naar sveipet (default 06) og
  // morgenbriefen kjører.
  new DailyScheduler(
    pool, "business-events-sync", envHour("JARVIS_BUSINESS_EVENTS_SYNC_HOUR", 5)
  ).start(() => runBusinessEventSyncForAllTenants(pool, businessEventSyncService).then(() => undefined));
  // UA-7 Communications Hub - foerste slice (D-119): periodisk Gmail->
  // Conversation Graph-identitetskobling - SAMME reboot-durable
  // DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av business-events-sync over.
  new DailyScheduler(
    pool, "conversation-graph-sync", envHour("JARVIS_CONVERSATION_GRAPH_SYNC_HOUR", 5)
  ).start(() => runConversationGraphSyncForAllTenants(pool, conversationGraphSyncService).then(() => undefined));
  // UA-3 profiling/scoring-slice (D-61) §23: periodisk, idempotent
  // score-rekalkulering - SAMME reboot-durable DailyScheduler-mekanisme (eget
  // job_name, egen klokkeslett-env). Kjøres ETTER events-sync (05) og
  // open-loop-sveipet (06) slik at rekalkuleringen ser den ferskeste
  // aktivitets-/open-loop-tilstanden (default kl. 07).
  new DailyScheduler(
    pool, "business-scoring-recalc", envHour("JARVIS_BUSINESS_SCORING_HOUR", 7)
  ).start(() => runScoringSweepForAllTenants(pool, scoringService).then(() => undefined));
  // UA-3 Native Jarvis Support Core (D-66) §7/§24: periodisk Gmail-innboks-
  // reconciliation - SAMME reboot-durable DailyScheduler-mekanisme, eget
  // job_name/klokkeslett-env. Kjøres ETTER de øvrige business-jobbene
  // (default kl. 08) - support-open-loop-reglene (§17, kjørt AV den
  // EKSISTERENDE business-open-loop-sweep kl. 06 over) ser dermed IKKE
  // nødvendigvis samme dags nye tickets før neste sveip - akseptabelt
  // forsinkelse (samme "periodisk, ikke event-drevet"-modell som resten av
  // UA-3, se Q-25 punkt 2). Trygt å kjøre uten `JARVIS_SUPPORT_INBOX_EMAILS`
  // konfigurert - routing blir da deterministisk tomt (ingen meldinger
  // klassifiseres som support, se `email-ingress.ts`).
  new DailyScheduler(
    pool, "support-inbox-sync", envHour("JARVIS_SUPPORT_INBOX_SYNC_HOUR", 8)
  ).start(() => runSupportInboxSyncForAllTenants(pool, supportEmailService).then(() => undefined));
  // D-85: periodisk anomaly->anbefaling-sveip (growth-eid BESLUTNINGS-lag,
  // ALDRI utførelse) - SAMME reboot-durable DailyScheduler-mekanisme, eget
  // job_name/klokkeslett-env. Kjøres ETTER business-open-loop-sweep (default
  // kl. 06) slik at den kan lese den ferskeste søster-open-loopen via
  // `detection_key` (default kl. 09) - rekkefølgen er BEVISST, ikke
  // strengt nødvendig (åpen-loop-koblingen er `null`-trygg uansett rekkefølge,
  // se `detectAndRecommendSpendAnomalies()`-kommentaren i modules/growth).
  new DailyScheduler(
    pool, "growth-action-recommendation-sweep", envHour("JARVIS_GROWTH_RECOMMENDATION_SWEEP_HOUR", 9)
  ).start(() => runActionRecommendationSweepForAllTenants(pool, growthService).then(() => undefined));
  // UA-8 Personal Digital Twin (D-130) §6: periodisk retensjons-håndhevelse
  // for lokasjonsobservasjoner - SAMME reboot-durable DailyScheduler-
  // mekanisme (eget job_name, egen klokkeslett-env). Trygt å kjøre uten noen
  // faktiske observasjoner ennå (ingen ekstern lokasjons-leverandør koblet
  // til i denne sliceen) - sveipet blir da et no-op.
  new DailyScheduler(
    pool, "location-retention-sweep", envHour("JARVIS_LOCATION_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runLocationRetentionSweepForAllTenants(pool, locationService).then(() => undefined));
  // UA-8 Personal Digital Twin (D-130) §6: periodisk retensjons-håndhevelse
  // for helseobservasjoner - SAMME mekanisme/begrunnelse som
  // location-retention-sweep over. Kjøres i samme tidlige klokkeslett-vindu
  // (default kl. 02) - begge er rene, uavhengige retensjons-ryddejobber uten
  // downstream-avhengigheter til andre UA-3/UA-4-sveip.
  new DailyScheduler(
    pool, "health-retention-sweep", envHour("JARVIS_HEALTH_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runHealthRetentionSweepForAllTenants(pool, healthService).then(() => undefined));
  // UA-9 Vision & Physical World (D-153): periodisk retensjons-håndhevelse
  // for hendelsesobservasjoner - SAMME reboot-durable DailyScheduler-
  // mekanisme som location-retention-sweep over (MULTI-SPACE, IKKE health-
  // stil enkelt-låst space - se modules/vision/src/sweep.ts sitt filhode).
  // Trygt å kjøre uten noen faktiske hendelser ennå (ingen ekstern kamera-
  // leverandør koblet til i denne sliceen) - sveipet blir da et no-op.
  new DailyScheduler(
    pool, "vision-retention-sweep", envHour("JARVIS_VISION_RETENTION_SWEEP_HOUR", 2)
  ).start(() => runVisionRetentionSweepForAllTenants(pool, visionService).then(() => undefined));
  // D-286 (Tobias direkte i chat, "alle" - alle tre foreslåtte tilnærminger
  // til ubegrenset minnevekst): periodisk konsolidering av gamle EPISODISKE
  // samtale-minner til dagssammendrag - SAMME reboot-durable
  // DailyScheduler-mekanisme/mønster som location/health/vision sine
  // retensjons-sveip over. Se `retention-sweep.ts` sitt filhode for full
  // begrunnelse (bevisst snever scope - rører ALDRI preference/decision/
  // relation/semantic-typer, KUN episodic samtale-minner).
  new DailyScheduler(
    pool, "memory-retention-sweep", envHour("JARVIS_MEMORY_RETENTION_SWEEP_HOUR", 2)
  ).start(() =>
    runMemoryRetentionSweepForAllTenants(
      pool, memoryWriter, memorySummaries, envInt("JARVIS_MEMORY_RETENTION_DAYS", 60, { min: 1, max: 3650 })
    ).then(() => undefined)
  );
  // D-242 (Tobias direkte chat-instruks: "du skal bygge det for absolutt
  // alle som tester en gang om dagen så vi vet om credentials fungerer
  // eller ikke hele tiden"): daglig `ConnectorHealthSweep` - SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen
  // klokkeslett-env). Kjøres via `toolGateway.execute()` MED eierens egen
  // `ownerIdentity` (SAMME identitet `business-weekly-brief`/
  // `situation-sweep` allerede bruker over) - alle 11 `live_test`-
  // connectorer er klasse A (`test_connector` sin egen D-213-begrunnelse:
  // "en 'test at dette fungerer'-handling for en allerede lesende, klasse
  // A-operasjon ER fortsatt klasse A"), ALLOW uansett autoritetsmodus,
  // INGEN mandat/godkjenning nødvendig. Trygt å kjøre uten NOEN
  // finans-/Vercel-credentials konfigurert - `runConnectorHealthSweep()`
  // hopper deterministisk over enhver ikke-konfigurert connector FØR noe
  // kall gjøres (se doc-kommentaren i `connector-health-sweep.ts`).
  new DailyScheduler(
    pool, "connector-health-sweep", envHour("JARVIS_CONNECTOR_HEALTH_SWEEP_HOUR", 10)
  ).start(async () => {
    const result = await runConnectorHealthSweep(toolGateway, ownerIdentity);
    if (result.failed.length > 0) {
      console.error(JSON.stringify({ msg: "connector_health_sweep_completed_with_failures", failed: result.failed }));
    }
  });
  return deps;
}

const deps = await buildDeps().catch((err: unknown) => {
  // Q-21: fail-closed - en usikker DB-rolle skal stoppe oppstart tydelig, aldri
  // starte videre "på lavere tillit" med en stille degradert sikkerhetsmodell.
  console.error(JSON.stringify({ msg: "jarvis-api startup_failed", error: (err as Error).message }));
  process.exit(1);
});
const server = createApiServer(deps);
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port, db: Boolean(deps) }));
});
