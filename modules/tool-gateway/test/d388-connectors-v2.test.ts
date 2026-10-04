import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropboxTransport, MicrosoftGraphAuth, MicrosoftOutlookTransport, N8nTransport, OneDriveTransport, SpotifyTransport, VercelTransport
} from "../src/live-transports.ts";
import { AccessTokenCache, bearerFor, dropboxRefreshExchange, microsoftRefreshExchange } from "../src/oauth-refresh.ts";
import { HomeAssistantTransport, normalizeHomeState } from "../src/home-assistant-transport.ts";
import { homeAssistantTools } from "../src/home-assistant.ts";
import { firstWaveTools } from "../src/integrations.ts";
import { CONNECTOR_REGISTRY } from "../src/connector-registry.ts";
import { CHAT_ACT_TIER_KEYS } from "../src/chat-act-tier.ts";
import { CHAT_READ_TIER_KEYS } from "../src/chat-read-tier.ts";
import { assertManifestInvariants, buildToolManifest } from "../src/tool-manifest.ts";

/**
 * D-388 (Tilkoblinger v2): OAuth-refresh for Dropbox/Microsoft Graph, Spotify-rotasjon, Vercel full kapabilitet,
 * ekte Home Assistant-transport, n8n deactivate, Dropbox upload/download. Alle leverandørkall er mocket via
 * `fetch`-stub - ingen nettverk.
 */
type Call = { url: string; init: RequestInit | undefined };
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; ok?: boolean; json?: unknown; text?: string; headers?: Record<string, string>; bytes?: Buffer }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    const bytes = r.bytes ?? Buffer.from(text);
    return {
      ok, status,
      headers: { get: (k: string) => (r.headers ?? {})[k] ?? (r.headers ?? {})[k.toLowerCase()] ?? null },
      json: async () => (r.json !== undefined ? r.json : JSON.parse(text)),
      text: async () => text,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } as unknown as Response;
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("A: AccessTokenCache - cachet utveksling, rotasjon persisteres, parallelle kall deler én utveksling", () => {
  it("utveksler én gang og gjenbruker til 60 s før utløp", async () => {
    let now = 1_000_000;
    let exchanges = 0;
    const cache = new AccessTokenCache({ async exchange() { exchanges++; return { access_token: "at-" + exchanges, expires_in: 3600 }; } }, { now: () => now });
    expect(await cache.get("rt")).toBe("at-1");
    expect(await cache.get("rt")).toBe("at-1");
    now += 3600_000 - 61_000;
    expect(await cache.get("rt")).toBe("at-1");
    now += 2_000;
    expect(await cache.get("rt")).toBe("at-2");
    expect(exchanges).toBe(2);
  });

  it("et rotert refresh-token persisteres og caches under den nye nøkkelen; feilet persist stopper ikke kallet", async () => {
    const persisted: string[] = [];
    const cache = new AccessTokenCache({ async exchange() { return { access_token: "at", expires_in: 100, refresh_token: "rt-new" }; } }, {
      persist: async (v) => { persisted.push(v); throw new Error("infisical_down"); }
    });
    expect(await cache.get("rt-old")).toBe("at");
    expect(persisted).toEqual(["rt-new"]);
    expect(await cache.get("rt-new")).toBe("at");
  });

  it("parallelle kall deler samme pågående utveksling", async () => {
    let exchanges = 0;
    const cache = new AccessTokenCache({ async exchange() { exchanges++; await new Promise((r) => setTimeout(r, 5)); return { access_token: "at", expires_in: 60 }; } });
    await Promise.all([cache.get("rt"), cache.get("rt"), cache.get("rt")]);
    expect(exchanges).toBe(1);
  });

  it("bearerFor faller tilbake til den statiske credentialen uten refresh-konfig", async () => {
    expect(await bearerFor("static", undefined, undefined)).toEqual({ token: "static", mode: "static" });
    expect(await bearerFor("static", async () => "", new AccessTokenCache({ async exchange() { throw new Error("never"); } }))).toEqual({ token: "static", mode: "static" });
  });
});

describe("B: Dropbox - refresh-utveksling mot /oauth2/token, statisk fallback, upload/download via content-verten", () => {
  it("dropboxRefreshExchange POSTer grant_type/refresh_token/client_id/client_secret som form", async () => {
    const calls = stubFetch(() => ({ json: { access_token: "sl.abc", expires_in: 14400, token_type: "bearer" } }));
    const token = await dropboxRefreshExchange(async () => "key", async () => "secret").exchange("rt");
    expect(token).toEqual({ access_token: "sl.abc", expires_in: 14400 });
    expect(calls[0]!.url).toBe("https://api.dropboxapi.com/oauth2/token");
    expect(String(calls[0]!.init?.body)).toBe("grant_type=refresh_token&refresh_token=rt&client_id=key&client_secret=secret");
  });

  it("med refresh-konfig brukes det utvekslede tokenet som Bearer; uten brukes credentialen", async () => {
    const calls = stubFetch((url) => url.includes("oauth2") ? { json: { access_token: "sl.fresh", expires_in: 14400 } } : { json: { entries: [] } });
    const withRefresh = new DropboxTransport({ refreshToken: async () => "rt", appKey: async () => "k", appSecret: async () => "s" });
    await withRefresh.invoke("list_folder", {}, "static-token");
    expect((calls[1]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer sl.fresh");
    calls.length = 0;
    await new DropboxTransport().invoke("list_folder", {}, "static-token");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer static-token");
  });

  it("upload_file POSTer bytes til content.dropboxapi.com med Dropbox-API-Arg (mode add + autorename som default)", async () => {
    const calls = stubFetch(() => ({ json: { id: "id:1", path_display: "/notat.txt", size: 5 } }));
    const result = await new DropboxTransport().invoke("upload_file", { path: "/notat.txt", content: "hallo" }, "tok");
    expect(calls[0]!.url).toBe("https://content.dropboxapi.com/2/files/upload");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(JSON.parse(headers["Dropbox-API-Arg"]!)).toEqual({ path: "/notat.txt", mode: "add", autorename: true, mute: false });
    expect(Buffer.from(calls[0]!.init?.body as Uint8Array).toString("utf8")).toBe("hallo");
    expect(result).toEqual({ external_id: "id:1", data: { path: "/notat.txt", size: 5 } });
  });

  it("upload_file avviser innhold over 1 MiB FØR noe sendes; overwrite:true gir mode overwrite", async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await expect(new DropboxTransport().invoke("upload_file", { path: "/x", content: "a".repeat(1_048_577) }, "tok")).rejects.toThrow("dropbox_content_too_large");
    expect(calls).toHaveLength(0);
    await new DropboxTransport().invoke("upload_file", { path: "/x", content: "aGk=", encoding: "base64", overwrite: true }, "tok");
    expect(JSON.parse((calls[0]!.init?.headers as Record<string, string>)["Dropbox-API-Arg"]!).mode).toBe("overwrite");
    expect(Buffer.from(calls[0]!.init?.body as Uint8Array).toString("utf8")).toBe("hi");
  });

  it("download_file returnerer tekst som utf8 (metadata fra Dropbox-API-Result) og binært som base64", async () => {
    stubFetch(() => ({ text: "hei verden", headers: { "Dropbox-API-Result": JSON.stringify({ name: "notat.txt", size: 10 }) } }));
    const text = await new DropboxTransport().invoke("download_file", { path: "/notat.txt" }, "tok");
    expect(text.data).toEqual({ name: "notat.txt", size: 10, encoding: "utf8", content: "hei verden" });
    vi.unstubAllGlobals();
    stubFetch(() => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), headers: {} }));
    const bin = await new DropboxTransport().invoke("download_file", { path: "/bilde.png" }, "tok");
    expect((bin.data as { encoding: string; content: string }).encoding).toBe("base64");
    expect((bin.data as { content: string }).content).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString("base64"));
  });
});

describe("C: Microsoft Graph - delt auth for OneDrive + Outlook, rotert refresh-token persisteres", () => {
  it("microsoftRefreshExchange POSTer til login.microsoftonline.com/{tenant}/oauth2/v2.0/token med client_secret og scope", async () => {
    const calls = stubFetch(() => ({ json: { access_token: "eyJ", expires_in: 3599, refresh_token: "rt-2" } }));
    const token = await microsoftRefreshExchange(async () => "cid", async () => "csecret", async () => "tenant-1", "offline_access https://graph.microsoft.com/.default").exchange("rt-1");
    expect(token).toEqual({ access_token: "eyJ", expires_in: 3599, refresh_token: "rt-2" });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_secret")).toBe("csecret");
    expect(form.get("scope")).toBe("offline_access https://graph.microsoft.com/.default");
    vi.unstubAllGlobals();
    const calls2 = stubFetch(() => ({ json: { access_token: "x", expires_in: 1 } }));
    await microsoftRefreshExchange(async () => "cid", async () => null, async () => null, "s").exchange("rt");
    expect(calls2[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(new URLSearchParams(String(calls2[0]!.init?.body)).has("client_secret")).toBe(false);
  });

  it("OneDrive og Outlook deler ett access-token og persisterer det roterte refresh-tokenet én gang", async () => {
    const persisted: string[] = [];
    let exchanges = 0;
    const calls = stubFetch((url) => {
      if (url.includes("login.microsoftonline.com")) { exchanges++; return { json: { access_token: "graph-at", expires_in: 3600, refresh_token: "rt-rotated" } }; }
      return { json: { value: [] } };
    });
    const auth = new MicrosoftGraphAuth({ refreshToken: async () => "rt-0", clientId: async () => "cid", clientSecret: async () => "cs", persist: async (v) => { persisted.push(v); } });
    await new OneDriveTransport(auth).invoke("list_folder", {}, "legacy-static");
    await new MicrosoftOutlookTransport(auth).invoke("list_messages", { max: 3 }, "legacy-static");
    expect(exchanges).toBe(1);
    expect(persisted).toEqual(["rt-rotated"]);
    const graphCalls = calls.filter((c) => c.url.includes("graph.microsoft.com"));
    expect(graphCalls).toHaveLength(2);
    for (const c of graphCalls) expect((c.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer graph-at");
  });

  it("uten refresh-konfig er transportene uendret (statisk Bearer)", async () => {
    const calls = stubFetch(() => ({ json: { value: [] } }));
    await new OneDriveTransport().invoke("list_folder", {}, "static");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer static");
  });
});

describe("D: Spotify - cachet utveksling og rotert refresh-token persisteres", () => {
  it("to kall gir én Accounts-utveksling; rotert refresh_token persisteres", async () => {
    const persisted: string[] = [];
    let exchanges = 0;
    stubFetch((url) => {
      if (url.includes("accounts.spotify.com")) { exchanges++; return { json: { access_token: "sp-at", expires_in: 3600, refresh_token: "rt-new" } }; }
      return { status: 204 };
    });
    const transport = new SpotifyTransport({ clientId: async () => "id", clientSecret: async () => "secret", persist: async (v) => { persisted.push(v); } });
    await transport.invoke("get_currently_playing", {}, "rt-old");
    await transport.invoke("get_currently_playing", {}, "rt-old");
    expect(exchanges).toBe(1);
    expect(persisted).toEqual(["rt-new"]);
  });
});

describe("E: Vercel - full D-41-kapabilitet med teamId på alle kall", () => {
  it("list_projects/read_deployment/list_env (uten verdier) går mot de verifiserte endepunktene", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/v9/projects/prj_1/env")) return { json: { envs: [{ id: "e1", key: "DATABASE_URL", type: "encrypted", target: ["production"], value: "SKAL-ALDRI-VISES" }] } };
      if (url.includes("/v9/projects")) return { json: { projects: [{ id: "prj_1", name: "jarvis", framework: "nextjs", link: { repo: "tsworkflow/jarvisbuild" } }] } };
      if (url.includes("/v13/deployments/dpl_1")) return { json: { id: "dpl_1", name: "jarvis", url: "jarvis.vercel.app", readyState: "READY", target: "production", createdAt: 1_726_000_000_000 } };
      return { json: {} };
    });
    const transport = new VercelTransport(async () => "team_x");
    const projects = await transport.invoke("list_projects", {}, "tok");
    expect(calls[0]!.url).toBe("https://api.vercel.com/v9/projects?limit=50&teamId=team_x");
    expect(projects.data).toEqual({ projects: [{ id: "prj_1", name: "jarvis", framework: "nextjs", repo: "tsworkflow/jarvisbuild", updated_at: null }] });
    const dep = await transport.invoke("read_deployment", { deployment_id: "dpl_1" }, "tok");
    expect(calls[1]!.url).toBe("https://api.vercel.com/v13/deployments/dpl_1?teamId=team_x");
    expect((dep.data as { state: string }).state).toBe("READY");
    const env = await transport.invoke("list_env", { project: "prj_1" }, "tok");
    expect(JSON.stringify(env.data)).not.toContain("SKAL-ALDRI-VISES");
    expect(env.data).toEqual({ envs: [{ id: "e1", key: "DATABASE_URL", type: "encrypted", target: ["production"], updated_at: null }] });
  });

  it("upsert_env/promote/rollback/cancel bruker riktig metode og sti", async () => {
    const calls = stubFetch(() => ({ json: { created: { id: "env_9" } } }));
    const transport = new VercelTransport();
    const up = await transport.invoke("upsert_env", { project: "prj_1", key: "API_URL", value: "https://x", target: ["production"], sensitive: false }, "tok");
    expect(calls[0]!.url).toBe("https://api.vercel.com/v10/projects/prj_1/env?upsert=true");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ key: "API_URL", value: "https://x", type: "plain", target: ["production"] });
    expect(up.external_id).toBe("env_9");
    await transport.invoke("promote_deployment", { project: "prj_1", deployment_id: "dpl_2" }, "tok");
    expect(calls[1]!.url).toBe("https://api.vercel.com/v10/projects/prj_1/promote/dpl_2");
    expect(calls[1]!.init?.method).toBe("POST");
    await transport.invoke("rollback_deployment", { project: "prj_1", deployment_id: "dpl_1" }, "tok");
    expect(calls[2]!.url).toBe("https://api.vercel.com/v1/projects/prj_1/rollback/dpl_1");
    await transport.invoke("cancel_deployment", { deployment_id: "dpl_3" }, "tok");
    expect(calls[3]!.url).toBe("https://api.vercel.com/v12/deployments/dpl_3/cancel");
    expect(calls[3]!.init?.method).toBe("PATCH");
  });

  it("read_deployments filtrerer på prosjekt og beholder den gamle formen; ukjent handling kaster", async () => {
    const calls = stubFetch(() => ({ json: { deployments: [] } }));
    await new VercelTransport().invoke("read_deployments", { project: "prj_1" }, "tok");
    expect(calls[0]!.url).toBe("https://api.vercel.com/v6/deployments?limit=20&projectId=prj_1");
    await expect(new VercelTransport().invoke("redeploy", {}, "tok")).rejects.toThrow("vercel_unsupported_action_redeploy");
  });
});

describe("F: n8n deactivate_workflow", () => {
  it("POSTer til /api/v1/workflows/{id}/deactivate", async () => {
    const calls = stubFetch(() => ({ json: { id: "7", active: false } }));
    await new N8nTransport(async () => "https://n8n.local/").invoke("deactivate_workflow", { id: "7" }, "key");
    expect(calls[0]!.url).toBe("https://n8n.local/api/v1/workflows/7/deactivate");
    expect(calls[0]!.init?.method).toBe("POST");
  });
});

describe("G: Home Assistant - ekte REST-transport bak homeAssistantTools(), romkart uten gjetting", () => {
  const rooms = { home: { stue: { light: ["light.stue_tak", "light.stue_lampe"], climate: "climate.stue", alarm: "alarm_control_panel.hjem", lock: "lock.inngang" } } };
  const transport = () => new HomeAssistantTransport(async () => "http://ha.local:8123/", async () => JSON.stringify(rooms));

  it("list_states GETer /api/states med Bearer og filtrerer på domene", async () => {
    const calls = stubFetch(() => ({ json: [{ entity_id: "light.stue_tak", state: "on", attributes: { friendly_name: "Stue tak" } }, { entity_id: "lock.inngang", state: "locked" }] }));
    const r = await transport().invoke("list_states", { domain: "light" }, "ha-token");
    expect(calls[0]!.url).toBe("http://ha.local:8123/api/states");
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer ha-token");
    expect(r.data).toEqual([{ entity_id: "light.stue_tak", state: "on", name: "Stue tak" }]);
  });

  it("read_state(entity) normaliserer lås/alarm/lys/klima; 404 gir data:null (Q-34 preflight_requires_target)", async () => {
    stubFetch((url) => url.endsWith("lock.inngang") ? { json: { entity_id: "lock.inngang", state: "locked", attributes: {} } } : { status: 404 });
    const locked = await transport().invoke("read_state", { site_id: "home", room_id: "stue", entity: "lock.inngang" }, "t");
    expect((locked.data as { locked: boolean }).locked).toBe(true);
    const missing = await transport().invoke("read_state", { site_id: "home", room_id: "stue", entity: "lock.finnes_ikke" }, "t");
    expect(missing.data).toBeNull();
    expect(normalizeHomeState({ entity_id: "alarm_control_panel.hjem", state: "armed_away" })["armed"]).toBe(true);
    expect(normalizeHomeState({ entity_id: "alarm_control_panel.hjem", state: "disarmed" })["armed"]).toBe(false);
    expect(normalizeHomeState({ entity_id: "climate.stue", state: "heat", attributes: { temperature: 21.5 } })["temperature"]).toBe(21.5);
  });

  it("read_state uten entity leser rommets kartlagte enheter og gir samlebilde", async () => {
    stubFetch((url) => {
      if (url.endsWith("light.stue_tak")) return { json: { entity_id: "light.stue_tak", state: "off" } };
      if (url.endsWith("climate.stue")) return { json: { entity_id: "climate.stue", state: "heat", attributes: { temperature: 20 } } };
      if (url.endsWith("lock.inngang")) return { json: { entity_id: "lock.inngang", state: "unlocked" } };
      return { json: { entity_id: "alarm_control_panel.hjem", state: "disarmed" } };
    });
    const r = await transport().invoke("read_state", { site_id: "home", room_id: "stue" }, "t");
    expect(r.data).toMatchObject({ on: false, temperature: 20, locked: false, armed: false });
  });

  it("light_set/climate_set/lock_set/alarm_set kaller riktig tjeneste med entity fra romkartet", async () => {
    const calls = stubFetch(() => ({ json: [] }));
    const t = transport();
    await t.invoke("light_set", { site_id: "home", room_id: "stue", on: true }, "t");
    expect(calls[0]!.url).toBe("http://ha.local:8123/api/services/light/turn_on");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ entity_id: ["light.stue_tak", "light.stue_lampe"] });
    await t.invoke("climate_set", { site_id: "home", room_id: "stue", temperature: 21 }, "t");
    expect(calls[1]!.url).toBe("http://ha.local:8123/api/services/climate/set_temperature");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ entity_id: "climate.stue", temperature: 21 });
    await t.invoke("lock_set", { site_id: "home", room_id: "stue", entity: "lock.inngang", locked: true }, "t");
    expect(calls[2]!.url).toBe("http://ha.local:8123/api/services/lock/lock");
    await t.invoke("alarm_set", { site_id: "home", room_id: "stue", armed: false }, "t");
    expect(calls[3]!.url).toBe("http://ha.local:8123/api/services/alarm_control_panel/alarm_disarm");
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ entity_id: "alarm_control_panel.hjem" });
  });

  it("feiler LUKKET: ukjent rom, ukjent domene i rommet, ugyldig entity-id, manglende base-URL/romkart - ingen gjetting", async () => {
    const calls = stubFetch(() => ({ json: [] }));
    await expect(transport().invoke("light_set", { site_id: "home", room_id: "kjeller", on: true }, "t")).rejects.toThrow("home_room_not_mapped:home/kjeller");
    const noLock = new HomeAssistantTransport(async () => "http://ha", async () => ({ home: { bad: { light: "light.bad" } } }));
    await expect(noLock.invoke("alarm_set", { site_id: "home", room_id: "bad", armed: true }, "t")).rejects.toThrow("home_room_domain_not_mapped:home/bad/alarm");
    await expect(transport().invoke("lock_set", { site_id: "home", room_id: "stue", entity: "light.stue_tak", locked: true }, "t")).rejects.toThrow("home_invalid_entity_id:entity_not_lock");
    await expect(transport().invoke("lock_set", { site_id: "home", room_id: "stue", entity: "x;rm -rf", locked: true }, "t")).rejects.toThrow("home_invalid_entity_id:entity");
    await expect(new HomeAssistantTransport(async () => null, async () => "{}").invoke("list_states", {}, "t")).rejects.toThrow("home_assistant_base_url_not_configured");
    await expect(new HomeAssistantTransport(async () => "http://ha", async () => null).invoke("light_set", { site_id: "a", room_id: "b", on: true }, "t")).rejects.toThrow("home_rooms_not_configured");
    await expect(new HomeAssistantTransport(async () => "http://ha", async () => "{not json").invoke("light_set", { site_id: "a", room_id: "b", on: true }, "t")).rejects.toThrow("home_rooms_invalid_json");
    expect(calls).toHaveLength(0);
  });

  it("homeAssistantTools() har list_states (A) i tillegg til de fem eksisterende; lås/alarm forblir klasse D med preflight", () => {
    const tools = homeAssistantTools({ invoke: async () => ({}) });
    expect(tools.map((t) => t.action).sort()).toEqual(["alarm_set", "climate_set", "light_set", "list_states", "lock_set", "read_state"]);
    expect(tools.find((t) => t.action === "list_states")!.capability_class).toBe("A");
    expect(tools.find((t) => t.action === "lock_set")!.preflight_action).toBe("read_state");
  });
});

describe("H: registrering, register, nivåer og manifest-invarianter", () => {
  it("nye handlinger er registrert med riktig klasse", () => {
    const tools = firstWaveTools();
    const cls = (id: string, action: string) => tools.find((t) => t.tool_id === id && t.action === action)?.capability_class;
    expect(cls("vercel", "list_projects")).toBe("A");
    expect(cls("vercel", "list_env")).toBe("A");
    expect(cls("vercel", "upsert_env")).toBe("C");
    expect(cls("vercel", "promote_deployment")).toBe("C");
    expect(cls("vercel", "rollback_deployment")).toBe("C");
    expect(cls("vercel", "cancel_deployment")).toBe("B");
    expect(cls("dropbox", "download_file")).toBe("A");
    expect(cls("dropbox", "upload_file")).toBe("B");
    expect(cls("n8n", "deactivate_workflow")).toBe("C");
  });

  it("registeret har home_assistant med live_test list_states, og refresh-refs for Dropbox/OneDrive/Outlook", () => {
    const ha = CONNECTOR_REGISTRY.find((c) => c.id === "home_assistant")!;
    expect(ha.live_test).toMatchObject({ tool_id: "home-assistant", action: "list_states" });
    expect(ha.credential_refs).toEqual(["JARVIS_HA_TOKEN", "JARVIS_HA_BASE_URL", "JARVIS_HA_ROOMS"]);
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "dropbox")!.credential_refs).toContain("JARVIS_DROPBOX_REFRESH_TOKEN");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "onedrive")!.credential_refs).toContain("JARVIS_MICROSOFT_REFRESH_TOKEN");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "microsoft_outlook")!.credential_refs).toContain("JARVIS_MICROSOFT_REFRESH_TOKEN");
    expect(CONNECTOR_REGISTRY.filter((c) => c.id === "home_assistant")).toHaveLength(1);
  });

  it("Charlie får lese- og handlingsnivå for de nye handlingene; lås/alarm (klasse D) står ALDRI på et nivå", () => {
    for (const key of ["vercel.list_projects", "vercel.read_deployment", "vercel.list_env", "dropbox.download_file", "home-assistant.list_states", "home-assistant.read_state"]) {
      expect(CHAT_READ_TIER_KEYS.has(key), key).toBe(true);
    }
    for (const key of ["vercel.upsert_env", "vercel.promote_deployment", "vercel.rollback_deployment", "vercel.cancel_deployment", "dropbox.upload_file", "n8n.deactivate_workflow", "home-assistant.light_set", "home-assistant.climate_set"]) {
      expect(CHAT_ACT_TIER_KEYS.has(key), key).toBe(true);
    }
    expect(CHAT_ACT_TIER_KEYS.has("home-assistant.lock_set")).toBe(false);
    expect(CHAT_ACT_TIER_KEYS.has("home-assistant.alarm_set")).toBe(false);
    const manifest = buildToolManifest([...firstWaveTools(), ...homeAssistantTools({ invoke: async () => ({}) })]);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    expect(manifest.get("home-assistant.light_set")).toMatchObject({ effect: "write", network: "owner_configured_url", sensitivity: "private" });
    expect(manifest.get("vercel.promote_deployment")).toMatchObject({ effect: "write", risk: "C" });
  });
});
