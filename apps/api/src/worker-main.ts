// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  DockerTransport, EnvSecretProvider, FallbackSecretProvider, GithubRateLimitController, GithubTransport, GmailTransport,
  GoogleCalendarTransport, TelegramTransport, MeshToolExecutor, meshToolDefinitions, PgGithubRateLimitStore,
  ToolGateway, driveTransportsIfConfigured, firstWaveTools, parseDockerMutationTargets
} from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "@jarvis/business";
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
import { GoogleAdsTransport, GrowthService, GrowthTransport, marketingMemoryBriefSource } from "@jarvis/growth";
import { executiveHandler } from "./executive.ts";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import {
  ArtifactStore,
  ClaudeCodeAgent,
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner,
  createCodingHandler,
  withSecretRedaction
} from "@jarvis/tasks";
import { KnowledgeSourceRegistry, emailIngestHandler } from "@jarvis/knowledge";
import { LocalHashEmbedding } from "@jarvis/memory";
import {
  TelegramAlertSink, Watchdog, consoleWatchdogObserver, costExplosionCheck, databaseCheck,
  resolveCostHardLimitOre, resolveWatchdogIntervalMs, resolveWatchdogTenantIds, startWatchdog,
  stuckTasksCheck
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
      process.env["JARVIS_GEMMA_LOCAL_MODEL"] ?? "gemma-local",
      undefined,
      "gemma_local"
    ),
    new KimiAdapter(),
    new OllamaAdapter()
  ]
});

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
const ownerControlAuthority = { owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias" };
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
const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
await deviceRegistry.refresh().catch(() => undefined);
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
    owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
    owner_tenants: [process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"]
  }
});
const toolGateway = new ToolGateway(
  pool, policy,
  new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
  ownerControls
);
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
const stripeCredentialsProvider: StripeCredentialsProvider = {
  async getCredentials(): Promise<StripeCredentials | null> {
    const secretKey = process.env["JARVIS_STRIPE_SECRET_KEY"];
    if (!secretKey) return null;
    return { secretKey };
  }
};
const stripeWebhookSecretProvider = () => process.env["JARVIS_STRIPE_WEBHOOK_SECRET"] ?? null;
const stripeTenantResolver = () => process.env["JARVIS_STRIPE_TENANT_ID"] ?? null;
// D-110 (UA-6 Slice 4): identisk wiring-mønster som apps/api/src/main.ts.
const vippsCredentialsProvider: VippsCredentialsProvider = {
  async getCredentials(): Promise<VippsCredentials | null> {
    const clientId = process.env["JARVIS_VIPPS_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_VIPPS_CLIENT_SECRET"];
    const subscriptionKey = process.env["JARVIS_VIPPS_SUBSCRIPTION_KEY"];
    const merchantSerialNumber = process.env["JARVIS_VIPPS_MSN"];
    if (!clientId || !clientSecret || !subscriptionKey || !merchantSerialNumber) return null;
    return { clientId, clientSecret, subscriptionKey, merchantSerialNumber, environment: process.env["JARVIS_VIPPS_ENVIRONMENT"] === "production" ? "production" : "test" };
  }
};
const vippsWebhookSecretProvider = () => process.env["JARVIS_VIPPS_WEBHOOK_SECRET"] ?? null;
const vippsTenantResolver = () => process.env["JARVIS_VIPPS_TENANT_ID"] ?? null;
const neonomicsCredentialsProvider: NeonomicsCredentialsProvider = {
  async getCredentials(): Promise<NeonomicsCredentials | null> {
    const clientId = process.env["JARVIS_NEONOMICS_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_NEONOMICS_CLIENT_SECRET"];
    const deviceId = process.env["JARVIS_NEONOMICS_DEVICE_ID"];
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
    const baseUrl = process.env["JARVIS_WALLESTER_API_BASE_URL"];
    const apiKey = process.env["JARVIS_WALLESTER_API_KEY"];
    const accountId = process.env["JARVIS_WALLESTER_ACCOUNT_ID"];
    const privateKeyPem = process.env["JARVIS_WALLESTER_PRIVATE_KEY_PEM"];
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
const fikenCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    const refreshToken = process.env["JARVIS_FIKEN_REFRESH_TOKEN"];
    const companySlug = process.env["JARVIS_FIKEN_COMPANY_SLUG"];
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
// W1 (D-180): ÉN delt `TelegramTransport`-instans - den SAMME som
// `firstWaveTools()` sin kanoniske `telegram.notify` bruker, gjenbrukt av
// watchdogens `TelegramAlertSink` nederst i filen. Hoistet hit KUN for at de
// to skal dele instans; INGEN ny Telegram-klient, INGEN ny credential-vei.
const telegramTransport = new TelegramTransport();
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(githubRateLimitController), telegram: telegramTransport,
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
  ...driveTransportsIfConfigured()
}, {
  // D-105 host-fix: samme wiring-mønster som apps/api/src/main.ts.
  dockerMutationTargets: parseDockerMutationTargets(process.env["JARVIS_DOCKER_MUTATION_TARGETS"])
})) toolGateway.register(tool);
const workerIdentity = {
  person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
  tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
  memory_space_id: "personal", session_id: "sess-worker", device_id: "jarvis-core",
  channel: "api", auth_strength: "active"
} as const;

// Sandbox-jobber: DockerSandboxRunner på host-runtime (D-32-verifisert). I container
// er prosess-sandbox default (containeren selv er isolasjonsgrensen; ingen Docker-socket
// monteres inn). Velges eksplisitt via JARVIS_SANDBOX=docker|process.
const runner =
  process.env["JARVIS_SANDBOX"] === "docker" ? new DockerSandboxRunner() : new ProcessSandboxRunner();

// BO-11.1 §9: delt executive-handler (samme fil som api-workeren) - identisk
// kontrakt for samme kø: prompt → mesh, tools=true → tool-løkke, command → sandbox.
worker.register(
  "executive",
  executiveHandler({
    gateway,
    tools: { definitions: meshToolDefinitions(), executor: new MeshToolExecutor(toolGateway, workerIdentity) },
    sandbox: runner
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
        session_id: "sess-coding"
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
    tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
    memory_space_id: "personal",
    source_instance_id: "email:inbox",
    account: process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com"
  }
]);
worker.register(
  "knowledge-ingest-email",
  emailIngestHandler({
    pool, toolGateway, embeddings: new LocalHashEmbedding(), visionGateway: gateway, registry: knowledgeRegistry
  })
);

// W1 (D-180, ordrepunkt A): PRODUKSJONS-WIRING AV @jarvis/watchdog.
//
// D182 sitt REAL_INTERNAL_GAP var at watchdog-modulen ALDRI var koblet inn i
// noen kjørende prosess - den fantes kun i sine egne tester. Denne
// worker-prosessen er det riktige stedet fordi den allerede eier NØYAKTIG de
// avhengighetene watchdogen trenger: runtime-`pool`-en, den pool-baserte
// durable `killSwitch`-en, `TelegramTransport`, og et etablert langtkjørende
// `setInterval`-mønster (drain-løkka rett under).
//
// PLASSERING ER SIKKERHETSKRITISK - watchdogen startes her, HELT NEDERST,
// altså garantert ETTER at (1) `assertRuntimeCredentialsConfigured()` og
// `assertRuntimeRoleSafe(pool)` har kjørt (Q-21 fail-closed, ellers har
// prosessen allerede avsluttet), og (2) `killSwitch.restore()`/
// `ownerControls.restore()` har gjenopprettet durable tilstand. En watchdog
// startet FØR `restore()` kunne sett en tom in-memory-cache og trukket feil
// konklusjon om allerede-aktiv nødstopp.
//
// ÉN instans, ÉN intervall-løkke (`startWatchdog`), ingen duplikat andre
// steder: `apps/api/src/main.ts` (api-prosessen) registrerer BEVISST INGEN
// watchdog - to prosesser som begge kjører `costExplosionCheck` mot SAMME
// `owner_control_state` ville vært to konkurrerende nødstopp-skrivere uten at
// det gir noen ekstra dekning. Dette speiler den eksisterende `owner_controls.*`-
// presedensen i denne filen (kontrollen deles, verktøyet registreres ett sted).
const watchdogTenantIds = resolveWatchdogTenantIds(
  process.env["JARVIS_WATCHDOG_TENANT_IDS"],
  process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"
);
const watchdogObserver = consoleWatchdogObserver();
const watchdog = new Watchdog(
  // Ordrepunkt C: EKTE varsling gjennom den DELTE `telegramTransport`-instansen
  // og den EKSISTERENDE `EnvSecretProvider`/`JARVIS_TELEGRAM_TOKEN`-kjeden.
  // Mangler tokenet, kaster sinken en typet `AlertDeliveryError` som
  // observatøren logger - den durable nødstoppen er da ALLEREDE skrevet og
  // påvirkes ikke (se `Watchdog.tick()` sin rekkefølge-kommentar).
  new TelegramAlertSink(telegramTransport, new EnvSecretProvider()),
  killSwitch,
  watchdogObserver
);
watchdog.register(databaseCheck(pool));
watchdog.register(stuckTasksCheck(pool, watchdogTenantIds));
watchdog.register(
  costExplosionCheck(pool, killSwitch, {
    // Fail-safe parsing: en skrivefeil i `.env` ville med en rå `Number(...)`
    // gitt `NaN`, og `spent >= NaN` er ALLTID false - altså en stille avslått
    // kostnadsnødstopp. Se `resolveCostHardLimitOre()`.
    hardLimitOre: resolveCostHardLimitOre(process.env["JARVIS_COST_HARD_LIMIT_ORE"]),
    tenantIds: watchdogTenantIds,
    // Ordrepunkt B: EKSPLISITT, deterministisk aktør - SAMME
    // `ownerControlAuthority.owner_person_id` som `killSwitch` selv er
    // konstruert med. Enhver annen verdi ville blitt fail-closed avvist av
    // `assertOwnerControlAuthorized()` (D-164), altså en nødstopp som aldri
    // ble skrevet. Watchdog-proveniensen ligger i `reason`-teksten.
    actorPersonId: ownerControlAuthority.owner_person_id
  })
);
const watchdogHandle = startWatchdog(
  watchdog,
  resolveWatchdogIntervalMs(process.env["JARVIS_WATCHDOG_INTERVAL_MS"]),
  watchdogObserver
);

console.log(JSON.stringify({
  msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name,
  watchdog_interval_ms: watchdogHandle.intervalMs, watchdog_tenants: watchdogTenantIds.join(",")
}));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
