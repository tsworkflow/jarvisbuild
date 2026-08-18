import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";

/** Minimal fake `pg.Pool` - støtter `withTenantTransaction()` sin `connect()/query()/release()`-bruk uten en ekte DB. */
function fakePool() {
  return {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined })
  } as never;
}

/**
 * UA-3 Support/Tickets (Zendesk, D-64): testmatrise AK/AL/AM/AN/AU (§39 i
 * byggeordren) - D-41-kapabilitetsmatrise, risikoklasse-mapping, D-klasse-
 * gating, OwnerControls-frys. Rene enhetstester over `firstWaveTools()` sin
 * definisjonsliste - ingen DB/nettverk noedvendig.
 */
describe("D-41 kapabilitetsmatrise: alle zendesk.*-handlinger har korrekt risikoklasse/scope/credential_ref", () => {
  const defs = firstWaveTools({});
  const zendesk = new Map(defs.filter((d) => d.tool_id === "zendesk").map((d) => [d.action, d]));

  it("20 zendesk.*-handlinger registrert (les/skriv/slett/admin - full D-41-kapabilitet, ikke read-only)", () => {
    expect(zendesk.size).toBe(20);
  });

  it("READ (klasse A, output_trust=untrusted): list_tickets/get_ticket/search_tickets/get_ticket_audits/get_user/search_users/get_organization/search_organizations/list_groups/list_agents/list_webhooks", () => {
    const reads = [
      "list_tickets", "get_ticket", "search_tickets", "get_ticket_audits", "get_user",
      "search_users", "get_organization", "search_organizations", "list_groups", "list_agents", "list_webhooks"
    ];
    for (const action of reads) {
      const def = zendesk.get(action);
      expect(def, `${action} skal finnes`).toBeDefined();
      expect(def!.capability_class).toBe("A");
      expect(def!.output_trust).toBe("untrusted");
      expect(def!.credential_ref).toBe("JARVIS_ZENDESK_REFRESH_TOKEN");
    }
  });

  it("WRITE (klasse B, internt/reversibelt): update_ticket, add_internal_note", () => {
    expect(zendesk.get("update_ticket")!.capability_class).toBe("B");
    expect(zendesk.get("add_internal_note")!.capability_class).toBe("B");
  });

  it("WRITE (klasse C, kundesynlig): create_ticket, reply_ticket", () => {
    expect(zendesk.get("create_ticket")!.capability_class).toBe("C");
    expect(zendesk.get("reply_ticket")!.capability_class).toBe("C");
  });

  it("DELETE/ADMIN (klasse D, irreversibel/sikkerhetskritisk): delete_ticket, redact_ticket_content, create_webhook, update_webhook, delete_webhook - alle med preflight_action", () => {
    const dClass = ["delete_ticket", "redact_ticket_content", "create_webhook", "update_webhook", "delete_webhook"];
    for (const action of dClass) {
      const def = zendesk.get(action);
      expect(def!.capability_class, `${action} skal være klasse D`).toBe("D");
      expect(def!.preflight_action, `${action} skal ha preflight_action`).toBeDefined();
    }
  });

  it("ingen zendesk.*-handling mangler et rollback_procedure- eller idempotent_external-felt", () => {
    for (const [action, def] of zendesk) {
      expect(def.rollback_procedure, action).toBeTruthy();
      expect(typeof def.idempotent_external, action).toBe("boolean");
    }
  });
});

describe("AK: ToolGateway-registrering - zendesk-transporten er alltid registrert (samme mønster som email/calendar/github/telegram)", () => {
  it("firstWaveTools({}) inneholder zendesk-handlinger selv uten en injisert transport (UnconfiguredHttpTransport-fallback)", () => {
    const defs = firstWaveTools({});
    expect(defs.some((d) => d.tool_id === "zendesk")).toBe(true);
  });
});

describe("AM: D-klasse-handlinger krever signert godkjenning for delegerte identiteter (ikke owner)", () => {
  it("en delegert (ikke-owner) identitet nektes delete_ticket UTEN godkjenning", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-x"] }
    });
    const gateway = new ToolGateway(fakePool(), policy, { name: "static", get: async () => "dummy" });
    for (const tool of firstWaveTools({ zendesk: new FakeTransport() })) gateway.register(tool);
    const delegatedIdentity: IdentityContext = {
      person_id: "person-other", tenant_id: "tenant-x", memory_space_id: "business",
      session_id: "sess-delegated", device_id: "dev-1", channel: "api", auth_strength: "active"
    };
    const result = await gateway.execute({
      identity: delegatedIdentity, tool_id: "zendesk", action: "delete_ticket", parameters: { ticket_id: "1" }
    });
    expect(result.ok).toBe(false);
  });
});

describe("AN: OwnerControls-frys blokkerer ALLE zendesk-handlinger, uansett identitet", () => {
  it("freezeConnector('zendesk') gir connector_frozen for et påfølgende kall, selv for owner", async () => {
    const killSwitch = new KillSwitch();
    const controls = new OwnerControls(killSwitch);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
      authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-x"] }
    });
    const gateway = new ToolGateway(fakePool(), policy, { name: "static", get: async () => "dummy" }, controls);
    for (const tool of firstWaveTools({ zendesk: new FakeTransport(() => ({ data: { tickets: [] } })) })) gateway.register(tool);
    const ownerIdentity: IdentityContext = {
      person_id: "person-tobias", tenant_id: "tenant-x", memory_space_id: "business",
      session_id: "sess-owner", device_id: "dev-1", channel: "api", auth_strength: "active"
    };
    controls.freezeConnector("zendesk");
    const result = await gateway.execute({ identity: ownerIdentity, tool_id: "zendesk", action: "list_tickets", parameters: {} });
    expect(result).toEqual({ ok: false, reason: "connector_frozen" });
    controls.unfreezeConnector("zendesk");
    const afterUnfreeze = await gateway.execute({ identity: ownerIdentity, tool_id: "zendesk", action: "list_tickets", parameters: {} });
    expect(afterUnfreeze.ok).toBe(true);
  });

  it("revokeCredential('JARVIS_ZENDESK_REFRESH_TOKEN') gir credential_revoked", async () => {
    const killSwitch = new KillSwitch();
    const controls = new OwnerControls(killSwitch);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch,
      authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-x"] }
    });
    const gateway = new ToolGateway(fakePool(), policy, { name: "static", get: async () => "dummy" }, controls);
    for (const tool of firstWaveTools({ zendesk: new FakeTransport(() => ({ data: { tickets: [] } })) })) gateway.register(tool);
    const ownerIdentity: IdentityContext = {
      person_id: "person-tobias", tenant_id: "tenant-x", memory_space_id: "business",
      session_id: "sess-owner", device_id: "dev-1", channel: "api", auth_strength: "active"
    };
    controls.revokeCredential("JARVIS_ZENDESK_REFRESH_TOKEN");
    const result = await gateway.execute({ identity: ownerIdentity, tool_id: "zendesk", action: "list_tickets", parameters: {} });
    expect(result).toEqual({ ok: false, reason: "credential_revoked" });
  });
});
