import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, listConnectorStatus } from "../src/connector-registry.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): DB-uavhengige tester - en fake
 * `{ hasSecret, health }` (nøyaktig `Pick<ToolGateway, "hasSecret"|"health">`
 * `listConnectorStatus()` selv krever) er nok til å bevise presence-/helse-
 * komposisjonen uten embedded Postgres.
 */
function fakeGateway(configured: Set<string>, health: Array<[string, { state: string; at: string; detail?: string }]> = []) {
  return {
    hasSecret: async (ref: string) => configured.has(ref),
    health: new Map(health)
  };
}

describe("A: CONNECTOR_REGISTRY - ren data, ingen duplikate id-er, live_test peker på kjente tool_id/action", () => {
  it("hver connector har en unik id", () => {
    const ids = CONNECTOR_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hver connector har minst én credential_ref", () => {
    for (const c of CONNECTOR_REGISTRY) {
      expect(c.credential_refs.length).toBeGreaterThan(0);
    }
  });

  it("live_test er satt for 45 connectorer - home_assistant (D-388, list_states - live_test.tool_id er 'home-assistant') + github/calendar/gmail (D-211) + google_drive/telegram/vercel/neonomics/wallester (D-213, task #122) + fiken/stripe/vipps (D-242) + slack (D-292) + discord (D-294) + twilio (D-295) + brave_search (D-296) + sentry (D-297) + google_maps (D-298) + google_sheets (D-299) + tavily (D-301) + exa (D-302) + google_places (D-303) + google_routes (D-304) + grafana (D-305) + prometheus (D-306) + dropbox (D-307) + notion (D-308) + onedrive (D-309) + microsoft_outlook (D-310) + n8n (D-311) + spotify (D-313) + whatsapp (D-314) + make (D-315) + openai_images (D-316) + telnyx (D-321) + runway (D-322) + google_veo (D-324) + todoist (D-329) + trello (D-330) + jira (D-331) + linear (D-332) + hubspot (D-333) + pipedrive (D-334) + zapier (D-338, MCP discovery-only - live_test.tool_id er 'mcp_zapier', IKKE 'zapier') + playwright (D-339, lokal nettleserautomasjon - live_test.tool_id er 'browser', IKKE 'playwright') - kling (D-323) BEVISST UTEN live_test, se D-323 - resten bevisst avgrenset (anthropic/openai/gemini går via ModelGateway, ikke ToolGateway)", () => {
    const withLiveTest = CONNECTOR_REGISTRY.filter((c) => c.live_test).map((c) => c.id).sort();
    expect(withLiveTest).toEqual(
      ["gmail", "google_calendar", "github", "google_drive", "telegram", "vercel", "neonomics", "wallester", "fiken", "stripe", "vipps", "slack", "discord", "twilio", "brave_search", "sentry", "google_maps", "google_sheets", "tavily", "exa", "google_places", "google_routes", "grafana", "prometheus", "dropbox", "notion", "onedrive", "microsoft_outlook", "n8n", "spotify", "whatsapp", "make", "openai_images", "telnyx", "runway", "google_veo", "todoist", "trello", "jira", "linear", "hubspot", "pipedrive", "zapier", "playwright", "home_assistant"].sort()
    );
  });

  it("live_test.parameters er en FUNKSJON (bygges friskt ved kalletidspunkt, aldri frosset ved modul-last)", () => {
    for (const c of CONNECTOR_REGISTRY) {
      if (c.live_test) expect(typeof c.live_test.parameters).toBe("function");
    }
  });

  it("kun gyldige category-verdier forekommer", () => {
    const valid = new Set(["tool_gateway", "model_provider", "finance", "infra", "backlog", "backlog_d64_gate"]);
    for (const c of CONNECTOR_REGISTRY) {
      expect(valid.has(c.category)).toBe(true);
    }
  });
});

describe("D-232: D-231 backlog-synlighet - opprinnelig 50 NY_BACKLOG-punkter registrert som ikke-tilkoblede oppføringer (D-292/D-294/D-295/D-296/D-297/D-298/D-299/D-301/D-302/D-303/D-304/D-305/D-306/D-307/D-308/D-309/D-310/D-311/D-313/D-314/D-315/D-316/D-321/D-322/D-323/D-324/D-327/D-329/D-330/D-331/D-332/D-333/D-334/D-338/D-339: 'slack'/'discord'/'twilio'/'brave_search'/'sentry'/'google_maps'/'google_sheets'/'tavily'/'exa'/'google_places'/'google_routes'/'grafana'/'prometheus'/'dropbox'/'notion'/'onedrive'/'microsoft_outlook'/'n8n'/'spotify'/'whatsapp'/'make'/'openai_images'/'telnyx'/'runway'/'kling'/'google_veo'/'higgsfield'/'todoist'/'trello'/'jira'/'linear'/'hubspot'/'pipedrive'/'zapier'/'playwright' gradvis flyttet UT av denne listen og inn i de ekte, bygde connectorene over; D-318 fjernet 'microsoft_365', D-319 fjernet 'elevenlabs', D-320 fjernet 'deepgram' og D-328 fjernet 'openai_realtime'/'livekit' HELT fra registeret - microsoft_365 var ALLEREDE_DEKKET, elevenlabs/deepgram hører EGENTLIG ikke hjemme her i det hele tatt (tale-leverandører, ikke ToolGateway-connectorer), openai_realtime/livekit er sanntids-økt-/media-infrastruktur som IKKE passer NOEN eksisterende adapter-grensesnitt - registerets TOTALE lengde er derfor NED med fem fra de opprinnelige 50)", () => {
  const BACKLOG_IDS = [
    "apple_music",
    "apple_shortcuts",
    "homekit",
    "folio",
    "apns", "ios_shortcuts", "apple_watch"
  ];

  it("eksakt 7 gjenværende backlog-id-er finnes, hver nøyaktig én gang, i registeret (50 - 'slack' D-292 - 'discord' D-294 - 'twilio' D-295 - 'brave_search' D-296 - 'sentry' D-297 - 'google_maps' D-298 - 'google_sheets' D-299 - 'tavily' D-301 - 'exa' D-302 - 'google_places' D-303 - 'google_routes' D-304 - 'grafana' D-305 - 'prometheus' D-306 - 'dropbox' D-307 - 'notion' D-308 - 'onedrive' D-309 - 'microsoft_outlook' D-310 - 'n8n' D-311 - 'spotify' D-313 - 'whatsapp' D-314 - 'make' D-315 - 'openai_images' D-316 - 'telnyx' D-321 - 'runway' D-322 - 'kling' D-323 - 'google_veo' D-324 - 'higgsfield' D-327 - 'todoist' D-329 - 'trello' D-330 - 'jira' D-331 - 'linear' D-332 - 'hubspot' D-333 - 'pipedrive' D-334 - 'zapier' D-338 (MCP discovery-only, oppdatert i place, IKKE fjernet - se rad over) - 'playwright' D-339 (lokal, kun read-only, oppdatert i place, IKKE fjernet - se rad over) - 'microsoft_365' D-318 fjernet HELT, ikke bygget - 'elevenlabs' D-319/'deepgram' D-320/'openai_realtime'+'livekit' D-328 fjernet HELT, ALDRI en ToolGateway-connector i det hele tatt - 'meta_ads' D-335 fjernet HELT, bygget som en Growth Core-ADAPTER (metaads.*) i stedet for en ToolGateway-connector - 'philips_hue' D-336 fjernet HELT, ALLEREDE_DEKKET via Home Assistant sin homeAssistantTools() - 'google_cloud' D-337 fjernet HELT, bygget som 'gce' (SAMME utsporede infra-status som 'docker', IKKE i dette registeret))", () => {
    expect(new Set(BACKLOG_IDS).size).toBe(7);
    expect(BACKLOG_IDS.length).toBe(7);
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    for (const id of BACKLOG_IDS) {
      expect(registryIds.has(id)).toBe(true);
    }
  });

  it("registeret har nøyaktig 57 oppføringer totalt (50 bygde, inkl. home_assistant D-388, inkl. slack D-292/discord D-294/twilio D-295/brave_search D-296/sentry D-297/google_maps D-298/google_sheets D-299/tavily D-301/exa D-302/google_places D-303/google_routes D-304/grafana D-305/prometheus D-306/dropbox D-307/notion D-308/onedrive D-309/microsoft_outlook D-310/n8n D-311/spotify D-313/whatsapp D-314/make D-315/openai_images D-316/telnyx D-321/runway D-322/kling D-323/google_veo D-324/higgsfield D-327/todoist D-329/trello D-330/jira D-331/linear D-332/hubspot D-333/pipedrive D-334/zapier D-338/playwright D-339 + 7 gjenværende D-232-backlog-punkter; D-318/D-319/D-320/D-328/D-335/D-336/D-337 fjernet 'microsoft_365'/'elevenlabs'/'deepgram'/'openai_realtime'/'livekit'/'meta_ads'/'philips_hue'/'google_cloud' HELT fra registeret - 'zapier' D-338/'playwright' D-339 BLE IKKE fjernet, kun oppdatert i place fra backlog til tool_gateway, derfor UENDRET total lengde)", () => {
    // D-388: +home_assistant (JARVIS-061 lukket - ekte transport bak homeAssistantTools()): 56→57.
    expect(CONNECTOR_REGISTRY.length).toBe(57);
  });

  it("INGEN av de gjenværende backlog-oppføringene har live_test", () => {
    for (const id of BACKLOG_IDS) {
      const def = CONNECTOR_REGISTRY.find((c) => c.id === id);
      expect(def?.live_test).toBeUndefined();
    }
  });

  it("hver av de gjenværende backlog-oppføringene har category 'backlog' (INGEN 'backlog_d64_gate' finnes lenger - ALLE seks D-64-port-krevende leverandørene er nå bygget, D-334 var siste), aldri en av de fire ekte, bygde kategoriene", () => {
    for (const id of BACKLOG_IDS) {
      const def = CONNECTOR_REGISTRY.find((c) => c.id === id);
      expect(def?.category).toBe("backlog");
    }
  });

  it("category 'backlog_d64_gate' forekommer IKKE lenger noe sted i registeret - D-334 (Pipedrive) var den SISTE av de seks, hele D-64-gate-gruppen er nå fullført", () => {
    const actualD64 = CONNECTOR_REGISTRY.filter((c) => c.category === "backlog_d64_gate");
    expect(actualD64).toEqual([]);
  });

  it("'todoist'/'trello'/'jira'/'linear'/'hubspot'/'pipedrive' har category 'tool_gateway' (D-329 til D-334, bygget - IKKE lenger 'backlog_d64_gate')", () => {
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "todoist")?.category).toBe("tool_gateway");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "trello")?.category).toBe("tool_gateway");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "jira")?.category).toBe("tool_gateway");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "linear")?.category).toBe("tool_gateway");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "hubspot")?.category).toBe("tool_gateway");
    expect(CONNECTOR_REGISTRY.find((c) => c.id === "pipedrive")?.category).toBe("tool_gateway");
  });

  it("'zapier' har category 'tool_gateway' (D-338, MCP discovery-only, bygget - IKKE lenger 'backlog') og credential_refs/live_test peker på selve MCP-server-URL-en, ALDRI en separat API-nøkkel", () => {
    const def = CONNECTOR_REGISTRY.find((c) => c.id === "zapier");
    expect(def?.category).toBe("tool_gateway");
    expect(def?.credential_refs).toEqual(["JARVIS_MCP_ZAPIER_SERVER_URL"]);
    expect(def?.live_test?.tool_id).toBe("mcp_zapier");
    expect(def?.live_test?.action).toBe("list_tools");
  });

  it("'playwright' har category 'tool_gateway' (D-339, lokal nettleserautomasjon, bygget - IKKE lenger 'backlog') og credential_refs/live_test peker på apps/browser-gateway sin base-URL, ALDRI en separat API-nøkkel", () => {
    const def = CONNECTOR_REGISTRY.find((c) => c.id === "playwright");
    expect(def?.category).toBe("tool_gateway");
    expect(def?.credential_refs).toEqual(["JARVIS_BROWSER_GATEWAY_BASE_URL"]);
    expect(def?.live_test?.tool_id).toBe("browser");
    expect(def?.live_test?.action).toBe("navigate");
  });

  it("Supabase/Neo4j/1Password/Windows/macOS er BEVISST IKKE registrert (Q-36/Q-37/Q-38/Q-39, se D-232 i DECISIONS_AND_ASSUMPTIONS.md)", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    for (const excluded of ["supabase", "neo4j", "1password", "windows", "macos"]) {
      expect(registryIds.has(excluded)).toBe(false);
    }
  });

  it("'microsoft_365' er BEVISST IKKE registrert (D-318) - ALLEREDE_DEKKET av microsoft_outlook (D-310) + onedrive (D-309), samme 'ingen egen connector nødvendig'-mønster som Google Docs", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("microsoft_365")).toBe(false);
  });

  it("'elevenlabs' er BEVISST IKKE registrert (D-319) - tale-leverandør (TTS), bygget som ElevenLabsTts (apps/voice-gateway/src/tts.ts) bak SpeechAdapter/PROCESSOR_REGION_MATRIX.md, IKKE en ToolGateway-connector", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("elevenlabs")).toBe(false);
  });

  it("'deepgram' er BEVISST IKKE registrert (D-320) - tale-leverandør (STT), bygget som DeepgramStt (apps/voice-gateway/src/stt.ts) bak SpeechAdapter/PROCESSOR_REGION_MATRIX.md, IKKE en ToolGateway-connector", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("deepgram")).toBe(false);
  });

  it("'openai_realtime' er BEVISST IKKE registrert (D-328) - en VEDVARENDE full-dupleks WebSocket-økt, strukturelt ulik BÅDE ToolTransport OG de eksisterende SttAdapter/TtsAdapter-grensesnittene, IKKE byggbar før en egen økt-arkitekturbeslutning er tatt (se Q-42)", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("openai_realtime")).toBe(false);
  });

  it("'livekit' er BEVISST IKKE registrert (D-328) - en WebRTC/SFU-media-infrastrukturplattform, et ALTERNATIVT sanntids-transportlag til voice-gateway sin eksisterende WebSocket-arkitektur, IKKE en connector ved siden av den (se Q-42)", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("livekit")).toBe(false);
  });

  it("'meta_ads' er BEVISST IKKE registrert her (D-335) - bygget som en Growth Core-ADAPTER (MetaAdsTransport, metaads.*-namespace i firstWaveTools()), SAMME arkitektur/sporing som 'googleads' (som heller ALDRI har vært i dette registeret), IKKE en generisk ToolGateway-connector", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("meta_ads")).toBe(false);
    expect(registryIds.has("googleads")).toBe(false);
  });

  it("'philips_hue' er BEVISST IKKE registrert (D-336) - ALLEREDE_DEKKET av Home Assistant sin homeAssistantTools() (home-assistant.ts, tool_id 'home-assistant'), SAMME 'ingen egen connector nødvendig'-mønster som Microsoft 365 (D-318). 'homekit' er en STRUKTURELT ULIK protokoll (Apple HAP, ikke HA sitt REST/WebSocket-API) og FORBLIR i backlog-en, hører til D-36 Apple-runtime-sporet", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("philips_hue")).toBe(false);
    expect(registryIds.has("homekit")).toBe(true);
  });

  it("'google_cloud' er BEVISST IKKE registrert (D-337) - bygget som 'gce' (Google Compute Engine, Tobias sin eksplisitte 'servere'-presisering av Q-41), SAMME utsporede infra-status som 'docker' (heller ALDRI i dette registeret), IKKE en generisk ToolGateway-connector med én credential_ref", () => {
    const registryIds = new Set(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(registryIds.has("google_cloud")).toBe(false);
    expect(registryIds.has("gce")).toBe(false);
    expect(registryIds.has("docker")).toBe(false);
  });

  it("hver nye backlog-oppføring rendres som 'ikke konfigurert', presence_only, helse null - EKSAKT samme mønster som en eksisterende ukonfigurert connector (Fiken/Stripe/Vipps)", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    for (const id of BACKLOG_IDS) {
      const status = statuses.find((s) => s.id === id);
      expect(status?.configured).toBe(false);
      expect(status?.test_method).toBe("presence_only");
      expect(status?.health).toBeNull();
    }
  });
});

describe("B: listConnectorStatus() - presence per credential_ref, ALDRI selve verdien", () => {
  it("configured=true KUN når ALLE påkrevde refs for connectoren er tilstede", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.configured).toBe(true);

    const wallester = statuses.find((s) => s.id === "wallester");
    // wallester krever ALLE FIRE refs (D-246: API_BASE_URL/ACCOUNT_ID lagt til) - ingen konfigurert her.
    expect(wallester?.configured).toBe(false);
    expect(wallester?.credentials).toEqual([
      { ref: "JARVIS_WALLESTER_API_KEY", configured: false },
      { ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM", configured: false },
      { ref: "JARVIS_WALLESTER_API_BASE_URL", configured: false },
      { ref: "JARVIS_WALLESTER_ACCOUNT_ID", configured: false }
    ]);
  });

  it("credentials[] inneholder KUN {ref, configured} - aldri et 'value'-felt eller lignende", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    for (const status of statuses) {
      for (const cred of status.credentials) {
        expect(Object.keys(cred).sort()).toEqual(["configured", "ref"]);
      }
    }
  });

  it("test_method er 'live' for de 33 utvidede connectorene (D-211/D-213/D-242/D-292/D-294/D-295/D-296/D-297/D-298/D-299/D-301/D-302/D-303/D-304/D-305/D-306/D-307/D-308/D-309/D-310/D-311/D-313/D-314/D-315/D-316), 'presence_only' for resten", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    const byId = new Map(statuses.map((s) => [s.id, s]));
    for (const id of ["github", "google_calendar", "gmail", "google_drive", "telegram", "vercel", "neonomics", "wallester", "fiken", "stripe", "vipps", "slack", "discord", "twilio", "brave_search", "sentry", "google_maps", "google_sheets", "tavily", "exa", "google_places", "google_routes", "grafana", "prometheus", "dropbox", "notion", "onedrive", "microsoft_outlook", "n8n", "spotify", "whatsapp", "make", "openai_images"]) {
      expect(byId.get(id)?.test_method).toBe("live");
    }
    for (const id of ["anthropic", "openai", "gemini"]) {
      expect(byId.get(id)?.test_method).toBe("presence_only");
    }
  });

  it("health speiler gateway.health for connectorer med live_test (nøkkel = live_test.tool_id), null når intet forsøkt ennå", async () => {
    const gateway = fakeGateway(new Set(), [["github", { state: "healthy", at: "2026-09-20T12:00:00.000Z" }]]);
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.health).toEqual({ state: "healthy", at: "2026-09-20T12:00:00.000Z" });
    const telegram = statuses.find((s) => s.id === "telegram");
    expect(telegram?.health).toBeNull();
  });

  it("returnerer nøyaktig ETT element per registeroppføring, i samme rekkefølge", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    expect(statuses.map((s) => s.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
  });
});
