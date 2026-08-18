// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  ContextBuilder,
  DeviceService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  PgDeviceRegistry,
  SessionService,
  assertRuntimeCredentialsConfigured,
  assertRuntimeRoleSafe,
  configFromEnv,
  createPool,
  runMigrations
} from "@jarvis/core";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import { AnthropicAdapter, GeminiAdapter, KimiAdapter, OllamaAdapter, OpenAiAdapter, ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { LocalHashEmbedding, MemoryRetriever } from "@jarvis/memory";
import {
  DailyBrief, EnvSecretProvider, FallbackSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport,
  MeshToolExecutor, meshToolDefinitions, TelegramCommandPoller, TelegramTransport, ToolGateway, ZendeskTransport,
  buildStatusSource, calendarSource, driveTransportsIfConfigured, emailSource, firstWaveTools,
  tasksSource, DailyScheduler
} from "@jarvis/tool-gateway";
import {
  BusinessEventSyncService, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService,
  ScoringService, ZendeskEventSyncService, ZendeskTicketService,
  runBusinessEventSyncForAllTenants, runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants,
  runZendeskEventSyncForAllTenants, syncZendeskTicketAcrossTenants
} from "@jarvis/business";
import { OwnerControls } from "@jarvis/policy";
import { ConversationEngine } from "./conversation.ts";
import { executiveHandler } from "./executive.ts";
import { createApiServer, type ApiDeps } from "./server.ts";

const port = Number(process.env["JARVIS_API_PORT"] ?? 3010);

async function buildDeps(): Promise<ApiDeps | undefined> {
  if (!process.env["JARVIS_DB_PASSWORD"] && !process.env["JARVIS_DB_HOST"]) {
    console.log(JSON.stringify({ msg: "ingen databasekonfig - starter i helse-modus" }));
    return undefined;
  }
  // Q-21 (2026-08-15): fail-closed FØR tilkobling forsøkes - en manglende/feilkonfigurert
  // JARVIS_DB_USER skal ALDRI stille falle tilbake til admin-tilkoblingen (root cause for
  // host-blockeren var nettopp dette - api kjørte som Postgres-superbruker).
  assertRuntimeCredentialsConfigured();
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
  const killSwitch = new KillSwitch();
  // Enhetsregister fra databasen (fase 8): godkjenninger verifiseres mot registrerte enhetsnøkler.
  const deviceRegistry = new PgDeviceRegistry(pool, process.env["JARVIS_TENANT_ID"] ?? "tenant-personal");
  await deviceRegistry.refresh().catch(() => undefined);
  setInterval(() => void deviceRegistry.refresh().catch(() => undefined), 30_000).unref();
  const policy = new PolicyGateway({
    devices: deviceRegistry,
    nonces: new PgApprovalStore(pool),
    killSwitch,
    // v4.0 sovereign-owner (BO-11.1 §2-funn): uten denne kjørte runtime i legacy
    // SCOPED-modus og krevde approval for owners D-kall. A-D er risikoklasser -
    // for owner gir SOVEREIGN autonom utførelse; sikkerheten ligger i D-pipelinen
    // (preflight/readback/evidens/recovery) + owner-kontrollene, ikke approval.
    authority: {
      owner_person_id: process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias",
      owner_tenants: [process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"]
    }
  });
  const queue = new PgTaskQueue(pool);
  const worker = new InProcessWorker(queue);
  const gateway = new ModelGateway({
    pool,
    trace,
    providers: [
      new OpenAiAdapter(),
      new AnthropicAdapter(),
      new GeminiAdapter(),
      new KimiAdapter(),
      new OllamaAdapter(),
      new ScriptedAdapter()
    ],
    budget: {
      warn_ore: 100_000,
      approval_ore: 200_000,
      hard_limit_ore: 300_000,
      spend_approved: process.env["JARVIS_BUDGET_APPROVED"] === "true"
    }
  });
  // BO-03: Tool Gateway m/live transporter (aktiveres av credentials i .env),
  // Daily Brief-kilder, morgenlevering og Telegram-kommandoer.
  const toolGateway = new ToolGateway(
    pool, policy,
    new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
    new OwnerControls(killSwitch)
  );
  const businessService = new BusinessService(pool);
  // UA-3 next slice (D-53): open-loop-deteksjon - egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§4/§19/§20 i byggeordren).
  const openLoopService = new OpenLoopService(pool);
  // UA-3 profiling/scoring-slice (D-61): egen tjeneste over samme runtime-pool,
  // ingen ny kø/motor (§14/§23 i byggeordren) - gjenbruker Business Graph uendret.
  const scoringService = new ScoringService(pool);
  // UA-3 Support/Tickets (Zendesk, D-64): egen tjeneste over samme runtime-pool,
  // eier KUN zendesk_tickets (current state for OpenLoopService).
  const zendeskTicketService = new ZendeskTicketService(pool);
  for (const tool of firstWaveTools({
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(), telegram: new TelegramTransport(),
    zendesk: new ZendeskTransport(),
    business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService),
    ...driveTransportsIfConfigured()
  })) toolGateway.register(tool);
  // UA-3 business-event-linkage (D-57): SAMME toolGateway-instans (allerede
  // registrert med Gmail/Calendar over) - ingen ny transport-vei.
  const businessEventSyncService = new BusinessEventSyncService(toolGateway, businessService, openLoopService);
  // UA-3 Support/Tickets (Zendesk, D-64): SAMME toolGateway-instans (allerede
  // registrert med Zendesk over) - ingen ny transport-vei.
  const zendeskEventSyncService = new ZendeskEventSyncService(toolGateway, businessService, zendeskTicketService, openLoopService);
  const ownerIdentity = {
    person_id: "person-tobias", tenant_id: process.env["JARVIS_TENANT_ID"] ?? "tenant-personal",
    memory_space_id: "personal", session_id: "sess-brief", device_id: "jarvis-core",
    channel: "api", auth_strength: "active"
  } as const;
  // BO-11.1 §9: SAMME executive-handler som worker-containeren (delt fil) - api-workeren
  // som vinner queue-racet skal håndtere tools=true-jobber identisk (uten sandbox).
  worker.register(
    "executive",
    executiveHandler({
      gateway,
      tools: { definitions: meshToolDefinitions(), executor: new MeshToolExecutor(toolGateway, ownerIdentity) }
    })
  );

  const deps: ApiDeps = {
    identity: new IdentityService(pool),
    devices: new DeviceService(pool),
    brief: {
      generate: (identity) => dailyBrief.generate(identity as never),
      render: (artifact) => DailyBrief.render(artifact as never)
    },
    // UA-3 Support/Tickets (Zendesk, D-64) §22/§25: webhook er fast path,
    // periodisk synk (under) er sikkerhetsnettet - `onTicketEvent()` går
    // ALLTID via `syncZendeskTicketAcrossTenants()` (ny ToolGateway-henting
    // per tenant, ALDRI webhook-kroppens felter direkte).
    zendeskWebhook: {
      secret: process.env["JARVIS_ZENDESK_WEBHOOK_SIGNING_SECRET"],
      onTicketEvent: (ticketId) => syncZendeskTicketAcrossTenants(pool, zendeskEventSyncService, ticketId).then(() => undefined)
    },
    sessions: new SessionService(pool),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(pool),
      context: new ContextBuilder(pool),
      gateway,
      tasks: new TaskService(pool, queue, policy),
      worker,
      trace,
      memory: new MemoryRetriever(pool, new LocalHashEmbedding()),
      // D-30 live-funn: samtalebanen (tekst + voice via /chat) får mesh-verktøyene.
      // Executor bindes til samtalens RESOLVED identity - aldri ownerIdentity -
      // slik at tenant/delegation/authority følger den som faktisk snakker.
      tools: {
        definitions: meshToolDefinitions(),
        executorFor: (identity) => new MeshToolExecutor(toolGateway, identity)
      }
    })
  };
  setInterval(() => void worker.drain().catch(() => undefined), 2_000).unref();

  const dailyBrief = new DailyBrief([
    tasksSource(pool), buildStatusSource(toolGateway),
    emailSource(toolGateway), calendarSource(toolGateway)
  ], pool);
  const sendTelegram = async (text: string) => {
    for (let i = 0; i < text.length; i += 3900) {
      await toolGateway.execute({ identity: ownerIdentity as never, tool_id: "telegram", action: "notify",
        parameters: { message: text.slice(i, i + 3900) } });
    }
  };
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
    new TelegramCommandPoller(process.env["JARVIS_TELEGRAM_TOKEN"], process.env["JARVIS_TELEGRAM_CHAT_ID"], {
      brief: async () => DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)),
      status: statusText,
      ai: aiMeshText
    }, sendTelegram).start();
    // BO-05: reboot-durabel morgenlevering (DB-laas, Europe/Oslo, catch-up, aldri duplikat).
    new DailyScheduler(pool).start(async () => {
      await sendTelegram(DailyBrief.render(await dailyBrief.generate(ownerIdentity as never)));
    });
  }
  // UA-3 next slice (D-53) §19/§20: periodisk open-loop-sveip - gjenbruker SAMME
  // reboot-durable DailyScheduler-mekanisme (eget job_name, egen klokkeslett-env),
  // uavhengig av om Telegram er konfigurert (deteksjon != levering).
  new DailyScheduler(
    pool, "business-open-loop-sweep", Number(process.env["JARVIS_BUSINESS_SWEEP_HOUR"] ?? 6)
  ).start(() => runOpenLoopSweepForAllTenants(pool, openLoopService).then(() => undefined));
  // UA-3 business-event-linkage (D-57) §19/§20/§21: periodisk Gmail/Calendar->
  // Business-OS-synkronisering - SAMME reboot-durable DailyScheduler-mekanisme
  // (eget job_name, egen klokkeslett-env), uavhengig av Telegram-konfig.
  // Kjøres FØR open-loop-sveipet i klokkeslett (default 05) slik at nylig
  // synkroniserte aktiviteter er tilgjengelige naar sveipet (default 06) og
  // morgenbriefen kjører.
  new DailyScheduler(
    pool, "business-events-sync", Number(process.env["JARVIS_BUSINESS_EVENTS_SYNC_HOUR"] ?? 5)
  ).start(() => runBusinessEventSyncForAllTenants(pool, businessEventSyncService).then(() => undefined));
  // UA-3 profiling/scoring-slice (D-61) §23: periodisk, idempotent
  // score-rekalkulering - SAMME reboot-durable DailyScheduler-mekanisme (eget
  // job_name, egen klokkeslett-env). Kjøres ETTER events-sync (05) og
  // open-loop-sveipet (06) slik at rekalkuleringen ser den ferskeste
  // aktivitets-/open-loop-tilstanden (default kl. 07).
  new DailyScheduler(
    pool, "business-scoring-recalc", Number(process.env["JARVIS_BUSINESS_SCORING_HOUR"] ?? 7)
  ).start(() => runScoringSweepForAllTenants(pool, scoringService).then(() => undefined));
  // UA-3 Support/Tickets (Zendesk, D-64) §25: periodisk sikkerhetsnett (SAMME
  // reboot-durable DailyScheduler-mekanisme) - webhook er fast path, dette
  // fanger opp forbikoblet/tapt/aldri-konfigurert webhook-levering.
  // Uavhengig klokkeslett fra business-events-sync (default samme time, 05) -
  // ingen rekkefølge-avhengighet mellom Gmail/Calendar og Zendesk.
  new DailyScheduler(
    pool, "zendesk-tickets-sync", Number(process.env["JARVIS_ZENDESK_SYNC_HOUR"] ?? 5)
  ).start(() => runZendeskEventSyncForAllTenants(pool, zendeskEventSyncService).then(() => undefined));
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
