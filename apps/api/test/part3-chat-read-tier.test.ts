import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_READ_TIER,
  MemorySearchTransport,
  MeshToolExecutor,
  ModelSurfaceViolationError,
  SURFACE_LIMITS,
  SURFACE_TOOL_GRANTS,
  assertChatReadTier,
  assertManifestInvariants,
  bindScopeFields,
  buildToolManifest,
  firstWaveTools,
  homeAssistantTools,
  memoryToolDefinitions,
  resolveModelToolSurface,
  selectSurfaceTools,
  type ToolDefinition,
  type ToolGateway
} from "@jarvis/tool-gateway";

/** D-381: chattens lese-nivå - eierens chat kan nå 100+ lese-handlinger uten at modellen ser hele settet eller kan skrive/sende/betale. */
function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      // D-388: Home Assistant registreres i produksjon via additionalTools (main.ts/worker-main.ts) - speiles her.
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;
const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });

describe("lese-nivået er låst til ren lesing", () => {
  it("hvert par er registrert, klasse A og effekt read - og nivået er stort nok til å dekke connectorene", () => {
    expect(() => assertChatReadTier(gw)).not.toThrow();
    expect(CHAT_READ_TIER.length).toBeGreaterThan(150);
    expect(new Set(CHAT_READ_TIER.map((g) => `${g.tool_id}.${g.action}`)).size).toBe(CHAT_READ_TIER.length);
  });

  it("manifest-invariantene holder med lese-nivået på web_chat, og ingen annen flate fikk det", () => {
    expect(() => assertManifestInvariants(buildToolManifest(defs))).not.toThrow();
    for (const s of ["telegram", "background", "coding"] as const) {
      expect(SURFACE_TOOL_GRANTS[s].length).toBeLessThanOrEqual(5);
      expect(SURFACE_TOOL_GRANTS[s].some((g) => /^finance/.test(g.tool_id)), s).toBe(false);
    }
    // D-382: tale får lese-nivået uten finans - og aldri en handling.
    expect(SURFACE_TOOL_GRANTS.voice.some((g) => /^finance/.test(g.tool_id))).toBe(false);
    expect(SURFACE_TOOL_GRANTS.voice.length).toBeLessThan(SURFACE_TOOL_GRANTS.web_chat.length);
    // Eier-eksklusive navnerom (finans) står KUN på web_chat: lesing (klasse A) eller handlingsnivå (B/C, aldri pay/control/D).
    for (const e of buildToolManifest(defs).values()) {
      if (/^finance/.test(e.tool_id) && e.surfaces.length > 0) {
        expect(e.surfaces, e.key).toEqual(["web_chat"]);
        expect(["read", "write", "send", "delete"], e.key).toContain(e.effect);
        expect(e.risk, e.key).not.toBe("D");
        if (e.effect === "read") expect(e.risk, e.key).toBe("A");
      }
    }
  });

  it("en handling som endres til skriving (klasse B) stopper oppstarten lukket", () => {
    const target = CHAT_READ_TIER[0]!;
    const mutated = defs.map((d) => (d.tool_id === target.tool_id && d.action === target.action ? { ...d, capability_class: "B" as const } : d));
    expect(() => assertChatReadTier({ list: () => mutated } as unknown as ToolGateway)).toThrow(ModelSurfaceViolationError);
  });

  it("ingen forbudt id, ingen skriv/send/betal/slett-navn og ingen eier-eksklusive navnerom i nivået", () => {
    const forbidden = /^(owner_controls|self_modification|docker|gce|finance|mcp_zapier|browser|incidents|governance|situations|memory)$/;
    for (const g of CHAT_READ_TIER) {
      expect(forbidden.test(g.tool_id), `${g.tool_id}.${g.action}`).toBe(false);
      expect(/(^|_)(send|write|delete|create|update|pay|refund|capture|merge|set|revoke|activate|freeze|submit|notify|reply|share|upload|invoke|execute|trigger|run)(_|$)/.test(g.action), `${g.tool_id}.${g.action}`).toBe(false);
    }
  });
});

describe("utvalg per melding (modellen ser aldri hele nivået)", () => {
  it("«hei» gir fortsatt bare minnesøk - ingen utvidelse for vanlig prat", () => {
    const sel = selectSurfaceTools("web_chat", "hei", surface);
    expect(sel.selected.map((m) => `${m.tool_id}.${m.action}`)).toEqual(["memory.search"]);
    expect(sel.min_sensitivity).toBeUndefined();
  });

  it("bank-/saldo-spørsmål velger Neonomics-lesing og løfter turen til SECRET_RESTRICTED (kun lokal modell)", () => {
    for (const msg of ["sjekk saldoen min", "list bankkontoene mine", "list banksamtykkene mine", "hva er transaksjonene mine?"]) {
      const sel = selectSurfaceTools("web_chat", msg, surface);
      const keys = sel.selected.map((m) => `${m.tool_id}.${m.action}`);
      expect(keys.some((k) => k.startsWith("finance_neonomics.")), msg).toBe(true);
      expect(keys, msg).toEqual(expect.arrayContaining(["finance_neonomics.list_balances"]));
      expect(sel.min_sensitivity, msg).toBe("SECRET_RESTRICTED");
      expect(sel.schema_tokens, msg).toBeLessThanOrEqual(SURFACE_LIMITS.web_chat.max_schema_tokens);
      expect(sel.selected.length, msg).toBeLessThanOrEqual(SURFACE_LIMITS.web_chat.max_tools_per_round);
    }
  });

  it("andre connectorer nås på navn (Notion, Slack, Trello, Jira, Drive ...) uten å løfte sensitiviteten", () => {
    const cases: Array<[string, string]> = [
      ["søk i notion etter møtenotater", "notion.search"],
      ["hva står i slack-kanalene?", "slack.list_channels"],
      ["vis trello-boardene mine", "trello.list_boards"],
      ["finn jira-saker om innlogging", "jira.search_issues"],
      ["list filene i drive", "drive.list_files"]
    ];
    for (const [msg, expected] of cases) {
      const sel = selectSurfaceTools("web_chat", msg, surface);
      expect(sel.selected.map((m) => `${m.tool_id}.${m.action}`), msg).toContain(expected);
      expect(sel.min_sensitivity, msg).toBeUndefined();
    }
  });

  it("skjemaet modellen ser har aldri identitets-/scope-felt", () => {
    for (const m of surface) {
      const props = ((m.def.input_schema as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
      for (const f of ["tenant_id", "actor_person_id", "owner_person_id", "person_id"]) {
        if (m.scope_bindings !== undefined) expect(f in props, `${m.def.name}.${f}`).toBe(false);
      }
    }
  });
});

describe("scope bindes fra identiteten i trusted lag", () => {
  it("bindScopeFields overstyrer alltid en tenant/person modellen har sendt", () => {
    const bound = bindScopeFields({ tenant_id: "evil", actor_person_id: "evil", extra: 1 }, ["tenant_id", "actor_person_id"], { tenant_id: "t1", person_id: "p1" });
    expect(bound).toEqual({ tenant_id: "t1", actor_person_id: "p1", extra: 1 });
  });

  it("executoren sender identitetens tenant til ToolGateway, aldri modellens", async () => {
    let seen: Record<string, unknown> | undefined;
    const fakeGateway = {
      execute: async (req: { parameters: Record<string, unknown> }) => {
        seen = req.parameters;
        return { ok: true, data: { accounts: [] }, output_trust: "internal" };
      }
    } as unknown as ToolGateway;
    const ex = new MeshToolExecutor(fakeGateway, { tenant_id: "tenant-1", person_id: "person-1", memory_space_id: "personal" }, 20_000, surface);
    const res = await ex.execute(
      { tool_call_id: "c1", tool_name: "finance_neonomics__list_bank_accounts", arguments: { tenant_id: "ANNEN-TENANT" }, provider: "gemma_local", model: "m" },
      { tenant_id: "tenant-1", idempotency_key: "k" }
    );
    expect(res.success).toBe(true);
    expect(seen?.["tenant_id"]).toBe("tenant-1");
  });
});
