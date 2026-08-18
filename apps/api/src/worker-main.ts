// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import {
  EnvSecretProvider, FallbackSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport,
  MeshToolExecutor, meshToolDefinitions, ToolGateway, ZendeskTransport, driveTransportsIfConfigured, firstWaveTools
} from "@jarvis/tool-gateway";
import {
  BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService, ZendeskTicketService
} from "@jarvis/business";
import { executiveHandler } from "./executive.ts";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import {
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner
} from "@jarvis/tasks";
import { KnowledgeSourceRegistry, emailIngestHandler } from "@jarvis/knowledge";
import { LocalHashEmbedding } from "@jarvis/memory";

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
  providers: [new OpenAiAdapter(), new AnthropicAdapter(), new GeminiAdapter(), new KimiAdapter(), new OllamaAdapter()]
});

// BO-11 (§29): worker-tool-mesh gjennom SAMME trusted Tool Gateway/Policy som api -
// ingen provider/tool-bypass. Kun ufarlige read-verktøy eksponeres (mesh-bridge).
const killSwitch = new KillSwitch();
const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
await deviceRegistry.refresh().catch(() => undefined);
// v4.0 sovereign-owner (BO-11.1 §2-funn): samme authority-wiring som api -
// uten denne kjørte workeren i legacy SCOPED-modus for owners D-kall.
const policy = new PolicyGateway({
  devices: deviceRegistry,
  nonces: new PgApprovalStore(pool),
  killSwitch,
  authority: {
    owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
    owner_tenants: [process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"]
  }
});
const toolGateway = new ToolGateway(
  pool, policy,
  new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
  new OwnerControls(killSwitch)
);
const businessService = new BusinessService(pool);
// UA-3 next slice (D-53): samme OpenLoopService-wiring som api - workeren sin
// mesh-tool-executor maa kunne kalle de nye business-handlingene identisk.
const openLoopService = new OpenLoopService(pool);
// UA-3 profiling/scoring-slice (D-61): samme ScoringService-wiring som api -
// workeren sin mesh-tool-executor maa kunne kalle score-handlingene identisk.
const scoringService = new ScoringService(pool);
// UA-3 Support/Tickets (Zendesk, D-64): samme ZendeskTicketService-wiring som
// api - workeren sin mesh-tool-executor maa kunne kalle sync_zendesk_tickets identisk.
const zendeskTicketService = new ZendeskTicketService(pool);
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(), telegram: new TelegramTransport(),
  zendesk: new ZendeskTransport(),
  // UA-3 business-event-linkage (D-57)/Support-Tickets (D-64): SAMME
  // toolGateway-instans gis til BusinessTransport slik at
  // sync_business_events/sync_zendesk_tickets kan kalle Gmail/Calendar/Zendesk
  // - identisk wiring-mønster som apps/api/src/main.ts.
  business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService),
  ...driveTransportsIfConfigured()
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

console.log(JSON.stringify({ msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name }));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
