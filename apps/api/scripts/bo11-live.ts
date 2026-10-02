// BO-11: streaming + tool-calling live-akseptanse i container-runtime.
// Ekte OpenAI-/Anthropic-kall; kontrollerte feil via wrappere (aldri ekte nøkler).
// Printer aldri secrets - kun statuser, events, tokens, latency/ttft.
import { configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  AnthropicAdapter,
  OpenAiAdapter,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamEvent,
  type StreamHandler,
  type ToolCallRequest,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import {
  EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport,
  MeshToolExecutor, meshToolDefinitions, ToolGateway, firstWaveTools
} from "@jarvis/tool-gateway";
import { ModelGateway, traceSinkFromEnv, type ToolExecutor } from "@jarvis/model-gateway";
import { loadOwnerConfig } from "@jarvis/contracts";
// Remediering del 2 (JARVIS-065): eier fra validert konfig (JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME), ingen hardkoding.
const owner = loadOwnerConfig();

const pool = createPool(configFromEnv());
const OPENAI_MODEL = process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini";

// Trusted tool-lag: samme Policy/ToolGateway-pipeline som resten av Jarvis (§17).
const killSwitch = new KillSwitch();
const deviceRegistry = new PgDeviceRegistry(pool, owner.tenant_id);
await deviceRegistry.refresh().catch(() => undefined);
const policy = new PolicyGateway({
  devices: deviceRegistry,
  nonces: new PgApprovalStore(pool),
  killSwitch,
  // Samme sovereign-owner-wiring som api/worker (BO-11.1 §2).
  authority: {
    owner_person_id: owner.owner_person_id,
    owner_tenants: [owner.tenant_id]
  }
});
const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
for (const tool of firstWaveTools({
  email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
  github: new GithubTransport(), telegram: new TelegramTransport()
})) toolGateway.register(tool);
const owner = {
  person_id: owner.owner_person_id, tenant_id: owner.tenant_id, memory_space_id: "personal",
  session_id: "sess-bo11", device_id: "jarvis-core", channel: "api", auth_strength: "active"
} as const;

function countingExecutor(): { executor: ToolExecutor; count: () => number } {
  const inner = new MeshToolExecutor(toolGateway, owner);
  let n = 0;
  return {
    count: () => n,
    executor: {
      async execute(call, ctx): Promise<ToolResultMessage> {
        n += 1;
        return inner.execute(call, ctx);
      }
    }
  };
}

function newGateway(providers: ModelProviderAdapter[]): ModelGateway {
  return new ModelGateway({ pool, trace: traceSinkFromEnv(), providers });
}
const gw = newGateway([new OpenAiAdapter(undefined, OPENAI_MODEL), new AnthropicAdapter()]);
const REQ = (text: string, max = 200): ModelRequest => ({ messages: [{ role: "user", content: text }], max_tokens: max });

// ===== §7/§43-44: STREAMING LIVE begge providere =====
console.log("== STREAMING LIVE (§7) ==");
for (const provider of ["openai", "anthropic"] as const) {
  const events: StreamEvent[] = [];
  const r = await gw.stream(
    { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: `task-bo11-stream-${provider}`, provider, request: REQ("Tell fra 1 til 5, ett tall per ord.", 60) },
    (e) => events.push(e)
  );
  const deltas = events.filter((e) => e.type === "text_delta").length;
  const rebuilt = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  console.log(
    `${provider}: deltas=${deltas} rekonstruksjon=${rebuilt === r.text ? "MATCH" : "MISMATCH"} ttft=${r.ttft_ms}ms total=${r.latency_ms}ms tokens=${r.usage.input_tokens}/${r.usage.output_tokens} finish=${r.finish_reason}`
  );
}

// ===== §9/§46: CANCELLATION LIVE begge =====
console.log("== CANCELLATION LIVE (§9/§46) ==");
for (const provider of ["openai", "anthropic"] as const) {
  const controller = new AbortController();
  let deltasBeforeCancel = 0;
  const err = await gw
    .stream(
      { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: `task-bo11-cancel-${provider}`, provider, request: REQ("Skriv et langt dikt om fjell, minst 200 ord.", 800) },
      (e) => {
        if (e.type === "text_delta") {
          deltasBeforeCancel += 1;
          if (deltasBeforeCancel >= 3) controller.abort();
        }
      },
      controller.signal
    )
    .then(() => null)
    .catch((e: unknown) => e);
  const kind = err instanceof ProviderError ? err.kind : "feil-type";
  const next = await gw.complete({ tenant_id: owner.tenant_id, session_id: "sess-bo11", provider, request: REQ("Si 'ok'.", 8) });
  console.log(`${provider}: cancel etter ${deltasBeforeCancel} deltas -> ${kind}; neste request OK=${next.text.length > 0}`);
}

// ===== §10/§45: PRE-OUTPUT STREAM FALLBACK =====
console.log("== PRE-OUTPUT STREAM FALLBACK (§10) ==");
class FailFirst implements ModelProviderAdapter {
  private failures: number;
  constructor(private readonly inner: ModelProviderAdapter, failures = 2) { this.failures = failures; }
  get name(): string { return this.inner.name; }
  get model(): string | undefined { return this.inner.model; }
  available(): boolean { return this.inner.available(); }
  async complete(req: ModelRequest, onToken?: (t: string) => void): Promise<ModelResult> {
    if (this.failures > 0) { this.failures -= 1; throw new ProviderError(this.name, "timeout", "simulert_pre_output"); }
    return this.inner.complete(req, onToken);
  }
  async stream(req: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    if (this.failures > 0) { this.failures -= 1; throw new ProviderError(this.name, "timeout", "simulert_pre_output"); }
    return this.inner.stream ? this.inner.stream(req, onEvent, signal) : this.inner.complete(req);
  }
}
const gwFB = newGateway([new FailFirst(new OpenAiAdapter(undefined, OPENAI_MODEL)), new AnthropicAdapter()]);
const fbEvents: StreamEvent[] = [];
const fbResult = await gwFB.stream(
  { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: "task-bo11-streamfb", purpose: "CHAT", request: REQ("Si 'stream-fallback-ok'.", 16) },
  (e) => fbEvents.push(e)
);
const fbEvent = fbEvents.find((e) => e.type === "fallback") as { from: string; to: string; reason: string } | undefined;
console.log(`fallback-event: ${fbEvent?.from}→${fbEvent?.to} (${fbEvent?.reason}) | endte hos ${fbResult.provider} | tekst-ok=${fbResult.text.includes("stream-fallback-ok")}`);

// ===== §14-16/§43-44: TOOL CALLING LIVE begge providere =====
console.log("== TOOL CALLING LIVE (§14-16) ==");
for (const provider of ["openai", "anthropic"] as const) {
  const { executor, count } = countingExecutor();
  const r = await gw.completeWithTools(
    { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: `task-bo11-tool-${provider}`, provider, request: REQ("Hvor mange åpne GitHub-issues har prosjektet nå? Bruk verktøyet og svar kort.") },
    { tools: meshToolDefinitions(), executor }
  );
  console.log(`${provider}: tool_rounds=${r.metadata?.["tool_rounds"]} executions=${count()} svar-len=${r.text.length} (${r.provider}:${r.model})`);
}

// ===== §23: MULTIPLE TOOLS =====
console.log("== MULTIPLE TOOLS (§23) ==");
{
  const { executor, count } = countingExecutor();
  const r = await gw.completeWithTools(
    { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: "task-bo11-multitool", provider: "openai", request: REQ("Bruk verktøyene til å sjekke BÅDE dagens kalender OG åpne GitHub-issues, og oppsummer begge kort.") },
    { tools: meshToolDefinitions(), executor }
  );
  console.log(`multi: executions=${count()} tool_rounds=${r.metadata?.["tool_rounds"]} svar-len=${r.text.length}`);
}

// ===== §45/§20-21: CROSS-PROVIDER RECOVERY ETTER UTFØRT VERKTØY =====
console.log("== CROSS-PROVIDER RECOVERY ETTER TOOL (§45) ==");
class DieAfterTool implements ModelProviderAdapter {
  constructor(private readonly inner: ModelProviderAdapter) {}
  get name(): string { return this.inner.name; }
  get model(): string | undefined { return this.inner.model; }
  available(): boolean { return this.inner.available(); }
  async complete(req: ModelRequest, onToken?: (t: string) => void): Promise<ModelResult> {
    if (req.tool_exchanges?.length) { throw new ProviderError(this.name, "server", "simulert_doed_etter_tool"); }
    return this.inner.complete(req, onToken);
  }
}
{
  const { executor, count } = countingExecutor();
  const gwRec = newGateway([new DieAfterTool(new OpenAiAdapter(undefined, OPENAI_MODEL)), new AnthropicAdapter()]);
  const r = await gwRec.completeWithTools(
    { tenant_id: owner.tenant_id, session_id: "sess-bo11", task_id: "task-bo11-recovery", purpose: "CHAT", request: REQ("Hvor mange åpne GitHub-issues finnes? Bruk verktøyet, svar kort.") },
    { tools: meshToolDefinitions(), executor }
  );
  console.log(`recovery: endte hos ${r.provider} | executions=${count()} (skal være 1) | svar-len=${r.text.length}`);
}

// ===== §26: UNKNOWN TOOL via trusted executor =====
console.log("== UNKNOWN TOOL (§26) ==");
{
  const inner = new MeshToolExecutor(toolGateway, owner);
  const bad: ToolCallRequest = { tool_call_id: "x1", tool_name: "delete_all_files", arguments: {}, provider: "openai", model: OPENAI_MODEL };
  const res = await inner.execute(bad, { tenant_id: owner.tenant_id, idempotency_key: "bo11-unknown" });
  console.log(`delete_all_files -> success=${res.success} category=${res.error_category}`);
}

// ===== Mesh-verktøy er kun A/B-read (§14/§18-grensen håndheves i ToolGateway/Policy som før) =====
console.log("mesh-tools:", meshToolDefinitions().map((t) => t.name).join(", "));

// ===== TTFT/kost-korrelasjon (§8/§31-32) =====
console.log("== COST/TTFT KORRELASJON ==");
const corr = await pool.query(`
  SELECT provider, count(*) AS calls, round(avg(latency_ms)) AS avg_ms, sum(amount_ore) AS sum_ore,
         count(*) FILTER (WHERE NOT success) AS failures
  FROM cost_events WHERE session_id = 'sess-bo11' GROUP BY provider ORDER BY provider`);
for (const row of corr.rows) console.log(JSON.stringify(row));
await pool.end();
