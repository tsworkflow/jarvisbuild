import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-307. Bevisst begrenset til Dropbox sine JSON-RPC-lignende metadata-
 * endepunkter (POST api.dropboxapi.com/2/files/list_folder|create_folder_v2)
 * - IKKE ekte filinnhold-opplasting/nedlasting (annet vertsnavn
 * content.dropboxapi.com, binær kropp + Dropbox-API-Arg-header, passer ikke
 * ToolTransport sitt JsonValue-only grensesnitt). D-41: create_folder er en
 * ekte klasse B-skrivehandling, ikke bare lesing fordi det er enklere.
 */
describe("A: DropboxTransport.invoke('list_folder', ...) - POST /2/files/list_folder, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header og path i body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ entries: [], cursor: "abc", has_more: false }) } as unknown as Response;
    });
    const transport = new DropboxTransport();
    const result = await transport.invoke("list_folder", { path: "/Documents" }, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.dropboxapi.com/2/files/list_folder");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-token", "content-type": "application/json" });
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ path: "/Documents" }));
    expect(result.data).toEqual({ entries: [], cursor: "abc", has_more: false });
  });

  it("manglende path defaulter til '' (rot-mappen)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    const transport = new DropboxTransport();
    await transport.invoke("list_folder", {}, "tok");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ path: "" }));
  });

  it("en HTTP-feil kaster 'dropbox_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new DropboxTransport();
    await expect(transport.invoke("list_folder", { path: "" }, "bad-token")).rejects.toThrow("dropbox_error_401");
  });
});

describe("B: DropboxTransport.invoke('create_folder', ...) - POST /2/files/create_folder_v2, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller mot create_folder_v2 med path i body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ metadata: { name: "Ny mappe", path_lower: "/ny mappe" } }) } as unknown as Response;
    });
    const transport = new DropboxTransport();
    const result = await transport.invoke("create_folder", { path: "/Ny mappe" }, "test-token");
    expect(calls[0]!.url).toBe("https://api.dropboxapi.com/2/files/create_folder_v2");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ path: "/Ny mappe" }));
    expect(result.data).toEqual({ metadata: { name: "Ny mappe", path_lower: "/ny mappe" } });
  });
});

describe("C: en ukjent handling kaster 'dropbox_unsupported_action_<action>'", () => {
  it("invoke('move', ...) kaster (D-388: upload_file/download_file er nå bygget, se d388-connectors-v2.test.ts)", async () => {
    const transport = new DropboxTransport();
    await expect(transport.invoke("move", { path: "/f.txt" }, "tok")).rejects.toThrow("dropbox_unsupported_action_move");
  });
});

describe("D: firstWaveTools() registrerer dropbox.list_folder som klasse A og dropbox.create_folder som klasse B", () => {
  it("list_folder er klasse A (ren lesing), create_folder er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "dropbox");
    expect(tools.map((t) => t.action).sort()).toEqual(["create_folder", "download_file", "list_folder", "upload_file"]);
    const listFolder = tools.find((t) => t.action === "list_folder")!;
    expect(listFolder.capability_class).toBe("A");
    expect(listFolder.credential_ref).toBe("JARVIS_DROPBOX_TOKEN");
    expect(listFolder.output_trust).toBe("untrusted");
    expect(listFolder.idempotent_external).toBe(true);
    const createFolder = tools.find((t) => t.action === "create_folder")!;
    expect(createFolder.capability_class).toBe("B");
    expect(createFolder.credential_ref).toBe("JARVIS_DROPBOX_TOKEN");
    expect(createFolder.idempotent_external).toBe(false);
    expect(createFolder.rollback_procedure).toBe("slett den nyopprettede mappen manuelt");
  });
});
