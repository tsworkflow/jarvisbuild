import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER,
  CHAT_READ_TIER,
  MemorySearchTransport,
  MeshToolExecutor,
  ModelSurfaceViolationError,
  SURFACE_TOOL_GRANTS,
  assertChatActTier,
  assertManifestInvariants,
  buildToolManifest,
  createTurnContext,
  describeSurfaceCatalog,
  firstWaveTools,
  homeAssistantTools,
  memoryToolDefinitions,
  resolveModelToolSurface,
  selectSurfaceTools,
  type ConfirmationGate,
  type ToolDefinition,
  type ToolGateway
} from "@jarvis/tool-gateway";

/** D-382: handlingsnivået - Charlie kan be om handlinger, men ingenting utføres før Tobias har godkjent en bundet bekreftelse. */
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
const manifest = buildToolManifest(defs);
const surface = resolveModelToolSurface(gw, { includeChatReadTier: true, includeChatActTier: true });
const identity = { tenant_id: "tenant-1", person_id: "person-1", memory_space_id: "personal", device_id: "dev-1", session_id: "s-1" };

describe("handlingsnivået er låst til B/C write/send/delete - aldri betaling, kontroll, D eller eier-navnerom", () => {
  it("hvert par er registrert og gyldig; nivået dekker de vanlige tjenestene", () => {
    expect(() => assertChatActTier(gw)).not.toThrow();
    expect(CHAT_ACT_TIER.length).toBeGreaterThan(100);
    const keys = CHAT_ACT_TIER.map((g) => `${g.tool_id}.${g.action}`);
    expect(keys).toEqual(expect.arrayContaining(["calendar.create_event", "todoist.create_task", "notion.create_page", "slack.notify", "github.create_issue", "finance_neonomics.sync_balances"]));
    for (const forbidden of ["email.send", "finance.submit_payment_intent", "github.merge_pr", "drive.delete_permanent", "owner_controls.activate_kill_switch", "docker.stop_container", "mcp_zapier.call_tool", "memory.approve_proposal", "twilio.notify"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
  });

  it("en handling som endres til klasse D stopper oppstarten lukket; lese- og handlingsnivået overlapper aldri", () => {
    const target = CHAT_ACT_TIER[0]!;
    const mutated = defs.map((d) => (d.tool_id === target.tool_id && d.action === target.action ? { ...d, capability_class: "D" as const } : d));
    expect(() => assertChatActTier({ list: () => mutated } as unknown as ToolGateway)).toThrow(ModelSurfaceViolationError);
    const reads = new Set(CHAT_READ_TIER.map((g) => `${g.tool_id}.${g.action}`));
    for (const g of CHAT_ACT_TIER) expect(reads.has(`${g.tool_id}.${g.action}`), `${g.tool_id}.${g.action}`).toBe(false);
  });

  it("kun web_chat har handlingsnivået; tale/Telegram/bakgrunn har aldri en handling", () => {
    for (const s of ["voice", "telegram", "background", "coding"] as const) {
      for (const g of SURFACE_TOOL_GRANTS[s]) {
        const e = manifest.get(`${g.tool_id}.${g.action}`);
        expect(e?.effect, `${s}: ${g.tool_id}.${g.action}`).toBe("read");
      }
    }
  });
});

describe("utvalg: handlinger velges kun når meldingen ber om en handling", () => {
  it("«vis todoist-oppgavene mine» gir bare lesing; «legg til en todoist-oppgave» gir også create_task", () => {
    const read = selectSurfaceTools("web_chat", "vis todoist-oppgavene mine", surface);
    expect(read.selected.map((m) => `${m.tool_id}.${m.action}`)).toContain("todoist.list_tasks");
    expect(read.selected.some((m) => m.kind === "act")).toBe(false);
    const act = selectSurfaceTools("web_chat", "legg til en todoist-oppgave: kjøp melk", surface);
    expect(act.selected.map((m) => `${m.tool_id}.${m.action}`)).toContain("todoist.create_task");
    expect(act.selected.length).toBeLessThanOrEqual(10);
  });

  it("«synk bankkontoene mine» velger Neonomics-synk og løfter turen til SECRET_RESTRICTED", () => {
    const sel = selectSurfaceTools("web_chat", "synk bankkontoene mine", surface);
    expect(sel.selected.map((m) => `${m.tool_id}.${m.action}`)).toContain("finance_neonomics.sync_accounts");
    expect(sel.min_sensitivity).toBe("SECRET_RESTRICTED");
  });

  it("tale velger aldri en handling, selv med handlingsord", () => {
    const sel = selectSurfaceTools("voice", "opprett en todoist-oppgave", surface);
    expect(sel.selected.some((m) => m.kind === "act")).toBe(false);
  });
});

describe("executor: en handling utføres ALDRI direkte - alltid bundet bekreftelse, også i en ren (untainted) tur", () => {
  const actMapping = surface.find((m) => m.tool_id === "todoist" && m.action === "create_task")!;
  function fakeGateway() {
    const executed: string[] = [];
    const gateway = { execute: async (req: { tool_id: string; action: string }) => { executed.push(`${req.tool_id}.${req.action}`); return { ok: true, data: { id: "t1" }, output_trust: "internal" }; } } as unknown as ToolGateway;
    return { gateway, executed };
  }
  const call = { tool_call_id: "c1", tool_name: actMapping.def.name, arguments: { content: "kjøp melk" }, provider: "gemma_local", model: "m" };

  it("untainted tur: bekreftelse opprettes med årsak owner_action_tier, ingenting kjøres, bekreftelses-id returneres", async () => {
    const { gateway, executed } = fakeGateway();
    const seen: Array<{ tool: string; reasons: string[] }> = [];
    const gate: ConfirmationGate = {
      checkAndConsume: async (c, _who, reasons) => { seen.push({ tool: `${c.tool_id}.${c.action}`, reasons }); return { ok: false, reason: "confirmation_required", confirmation_id: "conf-1" }; }
    };
    const turn = createTurnContext("web_chat", "legg til en todoist-oppgave: kjøp melk");
    expect(turn.taint.tainted).toBe(false);
    const ex = new MeshToolExecutor(gateway, identity, 20_000, surface, turn, { manifest, confirmations: gate });
    const res = await ex.execute(call, { tenant_id: "tenant-1", idempotency_key: "k" });
    expect(res.success).toBe(false);
    expect(res.error_category).toBe("CONFIRMATION_REQUIRED");
    expect((res.output as { confirmation_id: string }).confirmation_id).toBe("conf-1");
    expect(seen).toEqual([{ tool: "todoist.create_task", reasons: ["owner_action_tier"] }]);
    expect(executed).toEqual([]);
  });

  it("uten bekreftelsesport (guards uten confirmations) feiler handlingen lukket - aldri en stille utførelse", async () => {
    const { gateway, executed } = fakeGateway();
    const ex = new MeshToolExecutor(gateway, identity, 20_000, surface, createTurnContext("web_chat", "x"), { manifest });
    const res = await ex.execute(call, { tenant_id: "tenant-1", idempotency_key: "k" });
    expect(res.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("en avvist bekreftelse gir en tydelig melding til modellen om å ikke prøve igjen", async () => {
    const { gateway } = fakeGateway();
    const gate: ConfirmationGate = { checkAndConsume: async () => ({ ok: false, reason: "confirmation_rejected", confirmation_id: "conf-2" }) };
    const ex = new MeshToolExecutor(gateway, identity, 20_000, surface, createTurnContext("web_chat", "x"), { manifest, confirmations: gate });
    const res = await ex.execute(call, { tenant_id: "tenant-1", idempotency_key: "k" });
    expect(res.error_category).toBe("CONFIRMATION_REJECTED");
    expect((res.output as { message: string }).message).toMatch(/avviste/);
  });
});

describe("D-383: katalogen Charlie alltid ser", () => {
  it("web_chat: tjenester med lese/handle; tale: uten finans og uten handlinger; Telegram: minimum", () => {
    const chat = describeSurfaceCatalog(surface, "web_chat");
    expect(chat.services.find((s) => s.tool_id === "todoist")).toMatchObject({ reads: 2, acts: 4 });
    expect(chat.text).toContain("Todoist (lese + handle)");
    expect(chat.text).toContain("bank (Neonomics");
    const voice = describeSurfaceCatalog(surface, "voice");
    expect(voice.services.some((s) => /^finance/.test(s.tool_id))).toBe(false);
    expect(voice.services.every((s) => s.acts === 0)).toBe(true);
    expect(describeSurfaceCatalog(surface, "telegram").services.length).toBeLessThanOrEqual(5);
  });
});
