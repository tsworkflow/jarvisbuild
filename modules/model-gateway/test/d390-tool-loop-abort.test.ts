import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelResult, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "../src/index.ts";

/**
 * D-390 (JARVIS-079 «barge-in stops streaming not tools»): et abort-signal (tale-barge-in, klient borte) stopper også
 * verktøyløkka - etter at signalet er satt startes INGEN nye verktøykall, og løkka avsluttes som `cancelled`.
 */
function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}

const TOOL = { name: "read_tasks", description: "x", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } };
// Ulike argumenter per kall - identiske kall dedupliseres av idempotensnøkkelen (§19), det er ikke det som testes her.
const call = (id: string): ToolCallRequest => ({ tool_call_id: id, tool_name: "read_tasks", arguments: { q: id }, provider: "scripted", model: "m" });

/** Provider som ber om to verktøykall i runde 1 og svarer med tekst i runde 2. */
function toolCallingProvider(): ModelProviderAdapter {
  let round = 0;
  const result = (): ModelResult => {
    round += 1;
    return round === 1
      ? { text: "", provider: "scripted", model: "m", tool_calls: [call("c1"), call("c2")], usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 1 } as unknown as ModelResult
      : { text: "ferdig", provider: "scripted", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, latency_ms: 1 } as unknown as ModelResult;
  };
  return {
    name: "scripted", model: "m", available: () => true,
    complete: async () => result(),
    stream: async (_req, onEvent) => { const r = result(); onEvent({ type: "start", provider: "scripted", model: "m", generation_id: `g${round}` }); return r; }
  };
}

describe("D-390: abort-signal stopper verktøyløkka", () => {
  it("signal satt UNDER første verktøykall → andre kall startes aldri, løkka kaster cancelled", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [toolCallingProvider()] });
    const controller = new AbortController();
    const executed: string[] = [];
    const executor: ToolExecutor = {
      async execute(c): Promise<ToolResultMessage> {
        executed.push(c.tool_call_id);
        controller.abort(); // «barge-in» mens verktøyet kjører
        return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e", success: true, output: { ok: true }, at: new Date().toISOString() };
      }
    };
    await expect(
      gateway.completeWithTools(
        { tenant_id: "t", purpose: "CHAT", request: { messages: [{ role: "user", content: "x" }] } },
        { tools: [TOOL], executor, maxRounds: 4, onEvent: () => undefined, signal: controller.signal }
      )
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(executed).toEqual(["c1"]);
  });

  it("uten abort kjører begge kallene og runde 2 gir tekst (uendret oppførsel)", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [toolCallingProvider()] });
    const executed: string[] = [];
    const executor: ToolExecutor = {
      async execute(c): Promise<ToolResultMessage> {
        executed.push(c.tool_call_id);
        return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e", success: true, output: { ok: true }, at: new Date().toISOString() };
      }
    };
    const result = await gateway.completeWithTools(
      { tenant_id: "t", purpose: "CHAT", request: { messages: [{ role: "user", content: "x" }] } },
      { tools: [TOOL], executor, maxRounds: 4 }
    );
    expect(result.text).toBe("ferdig");
    expect(executed).toEqual(["c1", "c2"]);
    expect(ProviderError).toBeDefined();
  });
});
