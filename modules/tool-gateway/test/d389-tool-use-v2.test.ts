import { describe, expect, it } from "vitest";
import {
  CHAT_ACT_TIER,
  CHAT_READ_TIER,
  MeshToolExecutor,
  SURFACE_LIMITS,
  SURFACE_TOOL_GRANTS,
  buildToolManifest,
  chatReadTierMeshTools,
  createTurnContext,
  describeSurfaceCatalog,
  explainToolFailure,
  firstWaveTools,
  homeAssistantTools,
  namedServices,
  selectSurfaceTools,
  type ToolGateway
} from "../src/index.ts";

/**
 * D-389 (Charlies verktøybruk v2): enkel tilgang til alt - norske hverdagsord treffer riktig tjeneste, navngitt tjeneste prioriteres,
 * oppfølgingsspørsmål arver tjenesten fra forrige melding, og ethvert mislykket kall bærer en forklaring Charlie kan gjengi.
 */
const defs = firstWaveTools({}, { additionalTools: homeAssistantTools({ invoke: async () => ({}) } as never) });
const surface = [...chatReadTierMeshTools(defs, CHAT_READ_TIER, "read"), ...chatReadTierMeshTools(defs, CHAT_ACT_TIER, "act")];
const keys = (sel: ReturnType<typeof selectSurfaceTools>) => sel.selected.map((m) => `${m.tool_id}.${m.action}`);
const ids = (sel: ReturnType<typeof selectSurfaceTools>) => new Set(sel.selected.map((m) => m.tool_id));

describe("intensjon på norsk - uten tjenestenavn", () => {
  it("hjemmet: lys, varme, lås og alarm per rom velger Home Assistant", () => {
    for (const msg of ["slå på lyset i stua", "hvor varmt er det på soverommet?", "er døra låst?", "skru ned varmen på kjøkkenet", "hva er statusen på alarmen"]) {
      const sel = selectSurfaceTools("web_chat", msg, surface);
      expect(ids(sel).has("home-assistant"), msg).toBe(true);
      expect(keys(sel), msg).toContain("home-assistant.list_states");
    }
    // Handling kun ved handlingsord: «slå på» → light_set er med; et rent spørsmål → kun lesing.
    expect(keys(selectSurfaceTools("web_chat", "slå på lyset i stua", surface))).toContain("home-assistant.light_set");
    expect(selectSurfaceTools("web_chat", "er lyset på i stua?", surface).selected.some((m) => m.kind === "act")).toBe(false);
  });

  it("drift, kontrakter, support, arbeidsflyter, feil i produksjon og CRM treffer riktig tjeneste", () => {
    const cases: Array<[string, string]> = [
      ["hvilke leverandører har vi?", "operations"],
      ["hvilke kontrakter fornyes snart?", "contract"],
      ["har vi noen åpne henvendelser fra kunder?", "support"],
      ["hvilke arbeidsflyter kjører i n8n?", "n8n"],
      ["er det noen krasj i produksjon i dag?", "sentry"],
      ["vis leads i hubspot", "hubspot"],
      ["hva skjer med utrullingen på vercel?", "vercel"],
      ["hva står i huskelisten min?", "todoist"],
      ["hvor lang tid tar det å kjøre til hytta?", "google_routes"]
    ];
    for (const [msg, tool] of cases) {
      expect(ids(selectSurfaceTools("web_chat", msg, surface)).has(tool), msg).toBe(true);
    }
  });

  it("vanlig prat gir fortsatt bare minnesøk; budsjettet holdes alltid", () => {
    expect(keys(selectSurfaceTools("web_chat", "hei, hvordan går det?", [...surface]))).toEqual([]);
    for (const msg of ["slå på lyset i stua og vis kalenderen", "oversikt over alt: saker, kontrakter, lys, bank, github, e-post"]) {
      const sel = selectSurfaceTools("web_chat", msg, surface);
      expect(sel.selected.length).toBeLessThanOrEqual(SURFACE_LIMITS.web_chat.max_tools_per_round);
      expect(sel.schema_tokens).toBeLessThanOrEqual(SURFACE_LIMITS.web_chat.max_schema_tokens);
    }
  });
});

describe("navngitt tjeneste prioriteres; kontekst fra forrige melding arves", () => {
  it("«vis jira-sakene» gir Jira foran Linear selv om «saker» også treffer Linear", () => {
    const sel = selectSurfaceTools("web_chat", "vis jira-sakene mine", surface);
    expect(namedServices("vis jira-sakene mine")).toEqual(new Set(["jira"]));
    const first = sel.selected.find((m) => m.tool_id !== "memory");
    expect(first?.tool_id).toBe("jira");
    expect(keys(sel)).toContain("jira.search_issues");
  });

  it("oppfølging uten tjenesteord arver Jira fra forrige eiermelding - men aldri handlinger uten handlingsord", () => {
    const bare = selectSurfaceTools("web_chat", "og den første, hva står i den?", surface);
    expect(ids(bare).has("jira")).toBe(false);
    const carried = selectSurfaceTools("web_chat", "og den første, hva står i den?", surface, { recent_owner_messages: ["vis jira-sakene mine"] });
    expect(keys(carried)).toContain("jira.get_issue");
    expect(carried.selected.some((m) => m.kind === "act")).toBe(false);
    // Handlingsord i den gjeldende meldingen + arvet tjeneste → handling er med.
    const act = selectSurfaceTools("web_chat", "lukk den", surface, { recent_owner_messages: ["vis jira-sakene mine"] });
    expect(keys(act)).toContain("jira.transition_issue");
  });

  it("arvet kontekst rangeres etter det meldingen selv peker på, og tale/Telegram får aldri en handling via kontekst", () => {
    const sel = selectSurfaceTools("web_chat", "hva står i kalenderen i dag?", surface, { recent_owner_messages: ["vis jira-sakene mine"] });
    const order = sel.selected.map((m) => m.tool_id);
    expect(order.indexOf("calendar")).toBeLessThan(order.indexOf("jira"));
    for (const s of ["voice", "telegram"] as const) {
      const v = selectSurfaceTools(s, "lukk den", surface, { recent_owner_messages: ["vis jira-sakene mine"] });
      expect(v.selected.some((m) => m.kind === "act"), s).toBe(false);
      const granted = new Set(SURFACE_TOOL_GRANTS[s].map((g) => `${g.tool_id}.${g.action}`));
      for (const m of v.selected) expect(granted.has(`${m.tool_id}.${m.action}`), s).toBe(true);
    }
  });
});

describe("katalogen", () => {
  it("hjemmet har en norsk etikett med hverdagsord, og hint vises i teksten", () => {
    const cat = describeSurfaceCatalog(surface, "web_chat");
    const home = cat.services.find((s) => s.tool_id === "home-assistant");
    expect(home?.label).toMatch(/hjemmet/);
    expect(home?.hint).toMatch(/lys/);
    expect(cat.text).toContain("hjemmet (Home Assistant: lys, varme, låser, alarm, sensorer per rom) [lys/varme/lås/alarm per rom] (lese + handle)");
    expect(cat.text).not.toMatch(/\bgce\b|docker/);
  });
});

describe("feilforklaringer til modellen", () => {
  it("manglende nøkkel → Integrasjoner; frys → eierkontroller; grense → senere; ugyldige felt → én gang til", () => {
    expect(explainToolFailure("credential_unavailable", { tool_id: "jira" })).toMatchObject({ retry: "never", fix_location: "integrations_dashboard" });
    expect(explainToolFailure("credential_unavailable", { tool_id: "jira" }).message).toMatch(/Jira.*Integrasjoner/);
    expect(explainToolFailure("connector_frozen", { tool_id: "slack" })).toMatchObject({ retry: "never", fix_location: "owner_controls" });
    expect(explainToolFailure("rate_limited", { tool_id: "github" }).retry).toBe("later");
    expect(explainToolFailure("invalid_parameters", { tool_id: "todoist", action: "create_task" }).retry).toBe("with_corrected_parameters");
    expect(explainToolFailure("TOOL_NOT_FOUND", { available_services: ["todoist", "home-assistant"] }).message).toMatch(/Todoist.*hjemmet/);
    expect(explainToolFailure("TOOL_NOT_ON_SURFACE", { tool_id: "todoist", action: "create_task", surface: "voice" }).message).toMatch(/talesamtalen/);
    expect(explainToolFailure("class_d_missing_approval", { tool_id: "home-assistant", action: "lock_set" }).message).toMatch(/signerte godkjenning/);
    expect(explainToolFailure("postcondition_unverified:replayed", { tool_id: "vercel", action: "promote_deployment" }).message).toMatch(/ikke verifiseres/);
  });

  it("transportfeil: Home Assistant-oppsett, 401, 404, 429, nettverk og ukjent", () => {
    expect(explainToolFailure("tool_failed:home_rooms_not_configured", { tool_id: "home-assistant" })).toMatchObject({ fix_location: "integrations_dashboard" });
    expect(explainToolFailure("tool_failed:home_room_not_mapped:home/garasje", { tool_id: "home-assistant" }).message).toMatch(/home\/garasje/);
    expect(explainToolFailure("tool_failed:jira_http_401", { tool_id: "jira" })).toMatchObject({ retry: "never", fix_location: "integrations_dashboard" });
    expect(explainToolFailure("tool_failed:dropbox_http_404", { tool_id: "dropbox" }).retry).toBe("with_corrected_parameters");
    expect(explainToolFailure("tool_failed:github_http_429", { tool_id: "github" }).retry).toBe("later");
    expect(explainToolFailure("tool_failed:fetch failed", { tool_id: "notion" }).retry).toBe("later");
    expect(explainToolFailure("tool_failed:something odd", { tool_id: "notion" }).message).toMatch(/Notion feilet: something odd/);
    // Aldri hemmeligheter/interne stier: kun det gatewayen allerede har kappet til 80 tegn.
    expect(explainToolFailure("tool_failed:x", {}).message).not.toMatch(/\/home\//);
  });

  it("executoren legger forklaringen i output på alle avslagsveier (kategori uendret)", async () => {
    const manifest = buildToolManifest(defs);
    const identity = { tenant_id: "t1", person_id: "p1", memory_space_id: "personal" };
    const gateway = { execute: async () => ({ ok: false, reason: "credential_unavailable" }) } as unknown as ToolGateway;
    const turn = createTurnContext("web_chat", "vis jira-sakene mine");
    const ex = new MeshToolExecutor(gateway, identity, 20_000, surface, turn, { manifest });
    const ctx = { tenant_id: "t1", idempotency_key: "k" };
    const base = { provider: "gemma_local", model: "m" };

    const notFound = await ex.execute({ ...base, tool_call_id: "1", tool_name: "nope__x", arguments: {} }, ctx);
    expect(notFound.error_category).toBe("TOOL_NOT_FOUND");
    expect((notFound.output as { message: string }).message).toMatch(/Jira/);

    const denied = await ex.execute({ ...base, tool_call_id: "2", tool_name: "jira__search_issues", arguments: { jql: "x" } }, ctx);
    expect(denied.success).toBe(false);
    expect(denied.error_category).toBe("credential_unavailable");
    expect(denied.output).toMatchObject({ retry: "never", fix_location: "integrations_dashboard" });
    expect(denied.source).toBe("jira.search_issues");

    const voiceTurn = createTurnContext("voice", "x");
    const exVoice = new MeshToolExecutor(gateway, identity, 20_000, surface, voiceTurn, { manifest });
    const offSurface = await exVoice.execute({ ...base, tool_call_id: "3", tool_name: "jira__create_issue", arguments: {} }, ctx);
    expect(offSurface.error_category).toBe("TOOL_NOT_ON_SURFACE");
    expect((offSurface.output as { message: string }).message).toMatch(/talesamtalen/);

    turn.calls.total = turn.limits.max_total_calls;
    const limited = await ex.execute({ ...base, tool_call_id: "4", tool_name: "jira__search_issues", arguments: { jql: "x" } }, ctx);
    expect(limited.error_category).toBe("TOOL_CALL_LIMIT");
    expect((limited.output as { retry: string }).retry).toBe("never");
  });
});
