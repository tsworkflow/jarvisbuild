import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  MIN_RISK_BY_EFFECT,
  OWNER_ONLY_NAMESPACES,
  SURFACES,
  CHAT_ACT_TIER,
  CHAT_READ_TIER,
  SURFACE_TOOL_GRANTS,
  MemorySearchTransport,
  curatedReadOnlyMeshTools,
  ToolManifestViolationError,
  assertManifestInvariants,
  buildToolManifest,
  firstWaveTools,
  homeAssistantTools,
  inferEffect,
  memoryToolDefinitions,
  requiresConfirmationWhenTainted,
  type ToolDefinition,
  type ToolGateway
} from "@jarvis/tool-gateway";

/** Del 3 (JARVIS-002/015): ett sentralt manifest avledet fra de ekte produksjonsdefinisjonene, med deterministiske invarianter. */
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

const TIER_KEYS = new Set([...CHAT_READ_TIER, ...CHAT_ACT_TIER].map((g) => `${g.tool_id}.${g.action}`));
const defs = productionDefinitions();
const manifest = buildToolManifest(defs);
const entries = [...manifest.values()];

describe("manifest dekker ALLE registrerte handlinger", () => {
  it("én oppføring per definisjon, ingen duplikater, alle felt satt", () => {
    expect(entries.length).toBe(defs.length);
    expect(entries.length).toBeGreaterThan(400);
    for (const e of entries) {
      expect(["A", "B", "C", "D"]).toContain(e.risk);
      expect(["read", "write", "send", "pay", "delete", "control"]).toContain(e.effect);
      expect(["internal", "vendor_cloud", "financial"]).toContain(e.data_zone);
      expect(["public", "private", "business", "restricted"]).toContain(e.sensitivity);
      expect(["free", "metered", "paid"]).toContain(e.cost);
      expect(["none", "vendor", "owner_configured_url"]).toContain(e.network);
    }
  });

  it("invariantene holder for produksjonsregisteret (effekt→minimumsklasse, ingen farlige handlinger på modellflater)", () => {
    expect(() => assertManifestInvariants(manifest)).not.toThrow();
  });

  it("klasse D krever idempotens; send/pay/delete/control er aldri klasse A/B (unntatt begrunnede unntak)", () => {
    for (const e of entries) {
      if (e.risk === "D") expect(e.idempotency).toBe("required");
    }
    const exceptions = new Set(["telegram.notify", "memory.propose", "finance_wallester.freeze_card"]);
    for (const e of entries) {
      if (["send", "pay", "delete", "control"].includes(e.effect) && !exceptions.has(e.key)) {
        expect(["C", "D"], `${e.key} (${e.effect})`).toContain(e.risk);
      }
    }
    expect(MIN_RISK_BY_EFFECT.send).toBe("C");
  });
});

describe("reklassifisering (JARVIS-015): utgående og betalte handlinger er ikke lenger uskyldig klasse B", () => {
  const mustBeC = [
    "slack.notify", "discord.notify", "twilio.notify", "whatsapp.notify", "telnyx.notify",
    "make.run_scenario", "n8n.activate_workflow",
    "openai_images.generate_image", "runway.generate_video", "kling.generate_video", "google_veo.generate_video", "higgsfield.generate_video",
    "github.comment_on_issue", "github.rerun_workflow_run", "github.cancel_workflow_run"
  ];
  for (const key of mustBeC) {
    it(`${key} er minst klasse C`, () => {
      expect(["C", "D"]).toContain(manifest.get(key)?.risk);
    });
  }
  it("betalt kostnadstype er merket på SMS og mediegenerering", () => {
    for (const key of ["twilio.notify", "openai_images.generate_image", "runway.generate_video"]) expect(manifest.get(key)?.cost).toBe("paid");
  });
});

describe("flater (surfaces)", () => {
  it("default er INGEN flate: kun eksplisitt tildelte handlinger har surfaces", () => {
    const granted = new Set(SURFACES.flatMap((s) => SURFACE_TOOL_GRANTS[s].map((g) => `${g.tool_id}.${g.action}`)));
    for (const e of entries) {
      if (granted.has(e.key)) expect(e.surfaces.length).toBeGreaterThan(0);
      else expect(e.surfaces, e.key).toEqual([]);
    }
  });

  it("Telegram, tale og bakgrunn er read-only; coding har ingen gateway-verktøy", () => {
    for (const surface of ["telegram", "voice", "background"] as const) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) expect(manifest.get(`${g.tool_id}.${g.action}`)?.effect, `${surface}:${g.action}`).toBe("read");
    }
    expect(SURFACE_TOOL_GRANTS.coding).toEqual([]);
    expect(manifest.get("memory.propose")?.surfaces).toEqual(["web_chat"]);
  });

  it("structural invariant: eier-eksklusive navnerom (kontroll, penger, infra, selvmod, samtykke) finnes ikke på NOEN flate", () => {
    for (const e of entries) {
      if (!OWNER_ONLY_NAMESPACES.has(e.tool_id)) continue;
      // D-381/D-382: eneste unntak = chattens lese-/handlingsnivå, og kun på web_chat (aldri tale/Telegram/bakgrunn); aldri pay/control/D.
      if (TIER_KEYS.has(e.key)) {
        expect(e.surfaces, e.key).toEqual(["web_chat"]);
        expect(["read", "write", "send", "delete"], e.key).toContain(e.effect);
        expect(e.risk, e.key).not.toBe("D");
      } else expect(e.surfaces, e.key).toEqual([]);
    }
    for (const key of [
      "owner_controls.set_connector_credential", "owner_controls.revoke_device", "owner_controls.activate_kill_switch",
      "executive.revoke_device", "executive.activate_kill_switch", "finance.submit_payment_intent", "consent.record_decision", "email.send"
    ]) {
      const e = manifest.get(key);
      if (e) expect(e.surfaces, key).toEqual([]);
    }
  });

  it("ingen flate-handling har identitetsfelt (tenant/person/space) i modellskjemaet", () => {
    // D-381: lese-nivå-handlinger har identitetsfelt i det REGISTRERTE skjemaet, men trusted lag binder dem og fjerner dem fra modellens skjema
    // (låst i part3-chat-read-tier.test.ts). Alt annet på en flate må fortsatt være uten identitetsfelt.
    for (const e of entries) if (e.surfaces.length > 0 && !TIER_KEYS.has(e.key)) expect(e.scope_fields, e.key).toEqual([]);
  });

  it("en utvidelse som bryter reglene feiler lukket (mutasjonstest)", () => {
    const bad = new Map(manifest);
    const base = manifest.get("email.send")!;
    bad.set("email.send", { ...base, surfaces: ["web_chat"] });
    expect(() => assertManifestInvariants(bad)).toThrow(ToolManifestViolationError);
    const bad2 = new Map(manifest);
    const sms = manifest.get("twilio.notify")!;
    bad2.set("twilio.notify", { ...sms, risk: "B" });
    expect(() => assertManifestInvariants(bad2)).toThrow(/krever minst klasse C/);
  });
});

describe("taint-regelen: hva krever ny bekreftelse når turen er tainted", () => {
  it("C/D og utgående/betalt/ekstern skriving ja; lesing og interne karantene-skrivinger nei", () => {
    const need = (key: string) => requiresConfirmationWhenTainted(manifest.get(key)!);
    expect(need("email.send")).toBe(true);
    expect(need("twilio.notify")).toBe(true);
    expect(need("google_sheets.append_row")).toBe(true); // ekstern skriving, klasse B
    expect(need("hubspot.create_object")).toBe(true);
    expect(need("telegram.notify")).toBe(true); // utgående B
    expect(need("email.read_inbox")).toBe(false);
    expect(need("memory.search")).toBe(false);
    expect(need("memory.propose")).toBe(false);
  });
});

describe("effektinferens", () => {
  it("klassiske verb", () => {
    expect(inferEffect("x", "get_thing")).toBe("read");
    expect(inferEffect("x", "list_items")).toBe("read");
    expect(inferEffect("x", "send_mail")).toBe("send");
    expect(inferEffect("x", "delete_file")).toBe("delete");
    expect(inferEffect("x", "submit_refund")).toBe("pay");
    expect(inferEffect("x", "create_issue")).toBe("write");
  });
});

describe("JARVIS-024 (strukturell invariant): ingen kontroll-/hemmelighets-/identitetshandling står på NOEN modellflate", () => {
  const FORBIDDEN = /(credential|secret|revoke|kill_switch|destination|personality|system_prompt|prompt_change|freeze|device|enroll|grant|kill)/i;
  it("hver flate (tale, Telegram, bakgrunn, chat, coding) har bare tildelte handlinger uten forbudte navn", () => {
    for (const surface of SURFACES) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) {
        expect(`${g.tool_id}.${g.action}`, `${surface}: ${g.tool_id}.${g.action}`).not.toMatch(FORBIDDEN);
        if (surface === "web_chat" && TIER_KEYS.has(`${g.tool_id}.${g.action}`)) continue; // D-381/D-382: lese-/handlingsnivå (se over)
        expect(OWNER_ONLY_NAMESPACES.has(g.tool_id), `${surface}: ${g.tool_id}`).toBe(false);
      }
    }
  });
  it("de faktiske modell-skjemaene (kuraterte mesh-verktøy) har ingen forbudte navn og ingen identitetsfelt", () => {
    for (const m of curatedReadOnlyMeshTools()) {
      expect(m.def.name).not.toMatch(FORBIDDEN);
      const props = Object.keys(((m.def.input_schema as { properties?: Record<string, unknown> }).properties) ?? {});
      for (const forbiddenField of ["tenant_id", "person_id", "owner_person_id", "actor_person_id", "memory_space", "memory_space_id"]) {
        expect(props, `${m.def.name}.${forbiddenField}`).not.toContain(forbiddenField);
      }
    }
  });
  it("tale, Telegram og bakgrunn har aldri skrivehandlinger mot privat minne eller eksterne systemer", () => {
    for (const surface of ["voice", "telegram", "background"] as const) {
      for (const g of SURFACE_TOOL_GRANTS[surface]) {
        const entry = manifest.get(`${g.tool_id}.${g.action}`);
        expect(entry?.effect, `${surface}: ${g.tool_id}.${g.action}`).toBe("read");
      }
    }
  });
});

describe("worker-oppstart: delvis register (uten memory/executive) skal ikke krasje manifest-vakten", () => {
  const partial = buildToolManifest(defs.filter((d) => d.tool_id !== "memory" && d.tool_id !== "executive"));
  it("uten flagg feiler vakten på tildelte men uregistrerte flate-handlinger (API må ha dem)", () => {
    expect(() => assertManifestInvariants(partial)).toThrow(ToolManifestViolationError);
  });
  it("med ignoreUnregisteredGrants (workeren) består den - øvrige invarianter gjelder fortsatt", () => {
    expect(() => assertManifestInvariants(partial, { ignoreUnregisteredGrants: true })).not.toThrow();
  });
  it("worker-main.ts bruker flagget", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/worker-main.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/assertManifestInvariants\(toolManifest, \{ ignoreUnregisteredGrants: true \}\)/);
  });
});
