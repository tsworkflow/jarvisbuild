import { afterEach, describe, expect, it, vi } from "vitest";
import { N8nTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-311. `X-N8N-API-KEY`-header (IKKE `Authorization: Bearer`) mot n8n
 * sitt REST-API v1. n8n er TYPISK selv-hostet (SAMME "typisk selv-hostet"-
 * mønster som Grafana D-305/Prometheus D-306) - base-URL-en må
 * konfigureres via en resolver-closure. D-41: `activate_workflow` er en
 * ekte klasse B-skrivehandling.
 */
describe("A: N8nTransport.invoke('list_workflows', ...) - GET /api/v1/workflows, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med X-N8N-API-KEY-header mot den konfigurerte base-URL-en", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    });
    const transport = new N8nTransport(async () => "https://n8n.example.com");
    const result = await transport.invoke("list_workflows", {}, "test-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://n8n.example.com/api/v1/workflows");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ "X-N8N-API-KEY": "test-key" });
    expect(result.data).toEqual({ data: [] });
  });

  it("strippes trailing slash fra base-URL-en", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new N8nTransport(async () => "https://n8n.example.com/");
    await transport.invoke("list_workflows", {}, "key");
    expect(calls[0]).toBe("https://n8n.example.com/api/v1/workflows");
  });

  it("manglende base-URL kaster 'n8n_base_url_not_configured' - IKKE et fetch-kall gjøres", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new N8nTransport(async () => null);
    await expect(transport.invoke("list_workflows", {}, "key")).rejects.toThrow("n8n_base_url_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("en HTTP-feil kaster 'n8n_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new N8nTransport(async () => "https://n8n.example.com");
    await expect(transport.invoke("list_workflows", {}, "bad-key")).rejects.toThrow("n8n_error_401");
  });
});

describe("B: N8nTransport.invoke('activate_workflow', ...) - POST /api/v1/workflows/{id}/activate, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller mot riktig id-spesifikk activate-adresse", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "wf-1", active: true }) } as unknown as Response;
    });
    const transport = new N8nTransport(async () => "https://n8n.example.com");
    const result = await transport.invoke("activate_workflow", { id: "wf-1" }, "test-key");
    expect(calls[0]!.url).toBe("https://n8n.example.com/api/v1/workflows/wf-1/activate");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(result.data).toEqual({ id: "wf-1", active: true });
  });
});

describe("C: en ukjent handling kaster 'n8n_unsupported_action_<action>'", () => {
  it("invoke('delete_workflow', ...) kaster (ikke registrert)", async () => {
    const transport = new N8nTransport(async () => "https://n8n.example.com");
    await expect(transport.invoke("delete_workflow", {}, "key")).rejects.toThrow("n8n_unsupported_action_delete_workflow");
  });
});

describe("D: firstWaveTools() registrerer n8n.list_workflows som klasse A og n8n.activate_workflow som klasse B", () => {
  it("list_workflows er klasse A (ren lesing), activate_workflow er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "n8n");
    expect(tools.map((t) => t.action).sort()).toEqual(["activate_workflow", "deactivate_workflow", "list_workflows"]);
    const listWorkflows = tools.find((t) => t.action === "list_workflows")!;
    expect(listWorkflows.capability_class).toBe("A");
    expect(listWorkflows.credential_ref).toBe("JARVIS_N8N_API_KEY");
    expect(listWorkflows.output_trust).toBe("untrusted");
    expect(listWorkflows.idempotent_external).toBe(true);
    const activateWorkflow = tools.find((t) => t.action === "activate_workflow")!;
    expect(activateWorkflow.capability_class).toBe("C");
    expect(activateWorkflow.credential_ref).toBe("JARVIS_N8N_API_KEY");
    expect(activateWorkflow.reversible).toBe(true);
  });
});
