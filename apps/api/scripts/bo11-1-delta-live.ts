// BO-11.1 delta-live-akseptanse på runtime-hosten (Docker-PG + kjørende stack).
// Kjøres i jarvis-api-containeren:
//   node --env-file=.env --experimental-transform-types apps/api/scripts/bo11-1-delta-live.ts
//   (transform-types kreves på Node 24-host: strip-types feiler på TS parameter properties)
// Dekker: §5 (migrasjon 016 + streaming-metrics via SQL på Docker-PG) og
// §7 (SSE klient-disconnect → upstream abort mot kjørende jarvis-api).
// Printer aldri secrets; modellkall er ett billig streaming-kall.
import { configFromEnv, createPool } from "@jarvis/core";
import { OpenAiAdapter, AnthropicAdapter } from "@jarvis/provider-adapters";
import { ModelGateway, traceSinkFromEnv } from "@jarvis/model-gateway";
import { loadOwnerConfig } from "@jarvis/contracts";
// Remediering del 2 (JARVIS-065): eier fra validert konfig (JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME), ingen hardkoding.
const owner = loadOwnerConfig();

const pool = createPool(configFromEnv());
const OPENAI_MODEL = process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini";
const API_URL = process.env["JARVIS_API_URL"] ?? "http://localhost:3010";
const SESSION = `sess-bo11-1-${Date.now()}`;

// ===== §5: ett ekte streaming-kall → SQL-verifikasjon av migrasjon 016 =====
console.log("== §5 STREAMING-METRICS I COST_EVENTS (Docker-PG) ==");
{
  const gateway = new ModelGateway({
    pool,
    trace: traceSinkFromEnv(),
    providers: [new OpenAiAdapter(undefined, OPENAI_MODEL), new AnthropicAdapter()]
  });
  let deltas = 0;
  const result = await gateway.stream(
    {
      tenant_id: owner.tenant_id,
      session_id: SESSION,
      purpose: "CHAT",
      request: { messages: [{ role: "user", content: "Svar med ett ord: klar." }], max_tokens: 20 }
    },
    (e) => {
      if (e.type === "text_delta") deltas += 1;
    }
  );
  console.log(`streamet: provider=${result.provider} model=${result.model} deltas=${deltas} ttft=${result.ttft_ms}ms`);
  const row = await pool.query(
    `SELECT provider, model, purpose, ttft_ms, stream, tool_calls, amount_ore
       FROM cost_events WHERE session_id = $1 AND kind LIKE 'model:%' ORDER BY at DESC LIMIT 1`,
    [SESSION]
  );
  console.log("SQL-rad:", JSON.stringify(row.rows[0]));
  const r = row.rows[0] as { ttft_ms: number | null; stream: boolean; tool_calls: number } | undefined;
  if (!r || r.stream !== true || r.ttft_ms === null) {
    throw new Error("FEIL §5: streaming-metrics mangler i cost_events (kjørte migrasjon 016?)");
  }
  console.log("§5 PASS: ttft_ms/stream/tool_calls SQL-spørrbare.");
}

// ===== §7: SSE klient-disconnect mot kjørende jarvis-api =====
console.log("== §7 SSE-DISCONNECT → UPSTREAM ABORT (mot kjørende api) ==");
{
  const body = {
    person_id: owner.owner_person_id,
    tenant_id: owner.tenant_id,
    device_id: "jarvis-core",
    memory_space: "personal",
    channel: "api",
    message: "Fortell en lang historie om fjell, minst 200 ord."
  };
  const controller = new AbortController();
  let sawToken = false;
  try {
    const response = await fetch(`${API_URL}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes("event: token")) {
        sawToken = true;
        controller.abort(); // klient kobler fra midt i genereringen
        break;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  if (!sawToken) throw new Error("FEIL §7: fikk aldri token-event fra api");
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Bevis for upstream-kansellering: Conversation persisterte avbrudds-markøren.
  const cancelled = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE content LIKE '%[avbrutt av bruker]%' AND created_at > now() - interval '2 minutes'`
  );
  console.log(`avbrudds-markører siste 2 min: ${(cancelled.rows[0] as { n: number }).n}`);
  if ((cancelled.rows[0] as { n: number }).n < 1) {
    throw new Error("FEIL §7: ingen kansellert generasjon persistert - abort propagerte ikke upstream");
  }
  // Ny request rett etterpå fungerer (ingen zombie):
  const next = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, message: "Svar med ett ord: ok." })
  });
  console.log(`neste request: HTTP ${next.status}`);
  if (!next.ok) throw new Error("FEIL §7: request etter kansellering feilet");
  console.log("§7 PASS: disconnect → upstream abort, ingen zombie, neste tur OK.");
}

console.log("== BO-11.1 DELTA-LIVE FERDIG ==");
await pool.end();
