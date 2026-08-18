import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService } from "../src/index.ts";

/**
 * UA-3 P0: bevis at Business Graph-verktøyene er korrekt registrert og
 * FAKTISK kjører gjennom den EKSISTERENDE, generiske ToolGateway/Policy
 * Gateway-pipelinen (autorisasjon/audit/idempotens) - ingen egen, parallell
 * sikkerhetsmodell for Business OS. Dekker §30 O (owner sovereign),
 * P (delegert policy trygg), N (ingen sensitivt innhold i audit-payload).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;
let emailFake: FakeTransport;
let calendarFake: FakeTransport;

const TENANT = "tenant-biz-wiring";
const ownerIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-owner", device_id: "dev-owner", channel: "api", auth_strength: "active"
};
const delegateIdentity: IdentityContext = {
  person_id: "person-delegate", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-delegate", device_id: "dev-delegate", channel: "api", auth_strength: "active",
  delegation_id: "deleg-1"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-wiring-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_business_wiring_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_wiring_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Wiring Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias'), ('person-delegate','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}'), ('person-delegate','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wiring-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_wiring_test", password: "pw2" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  toolGateway = new ToolGateway(
    appPool, policy,
    new FallbackSecretProvider(
      // UA-3 business-event-linkage (D-57): returnerer et dummy-credential KUN
      // for Gmail/Calendar-referansene (behøvd av sync_business_events sin
      // interne bruk av email/calendar-verktøyene) - business.* sin egen
      // credential_ref faller fortsatt gjennom til den EKTE
      // BusinessInternalSecretProvider under, uendret fra før.
      { name: "test-google-static", get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") ? "dummy-google-cred" : null },
      new BusinessInternalSecretProvider()
    )
  );
  const service = new BusinessService(appPool);
  const openLoops = new OpenLoopService(appPool);
  const scoring = new ScoringService(appPool);
  emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
  calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
  for (const tool of firstWaveTools({
    business: new BusinessTransport(service, openLoops, appPool, toolGateway, scoring),
    email: emailFake, calendar: calendarFake
  })) toolGateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("registrering: alle business-handlinger er registrert med riktig risikoklasse", () => {
  it("A-klasse for lesing, B for enkle reversible skrivinger, C for tilstandsoverganger - ingen D i dette sliceet", () => {
    const defs = firstWaveTools({});
    const business = new Map(defs.filter((d) => d.tool_id === "business").map((d) => [d.action, d.capability_class]));
    // UA-3 profiling/scoring-slice (D-61): 8 nye score-handlinger lagt til på SLUTTEN (22 -> 30).
    // UA-3 Support/Tickets (Zendesk, D-64): 1 ny synk-handling lagt til på SLUTTEN (30 -> 31).
    expect(business.size).toBe(31);
    expect(business.get("create_company")).toBe("B");
    expect(business.get("create_contact")).toBe("B");
    expect(business.get("create_lead")).toBe("B");
    expect(business.get("update_lead_status")).toBe("C");
    expect(business.get("create_opportunity")).toBe("B");
    expect(business.get("update_opportunity_stage")).toBe("C");
    expect(business.get("record_activity")).toBe("B");
    expect(business.get("read_company_timeline")).toBe("A");
    expect(business.get("create_followup")).toBe("B");
    expect(business.get("complete_followup")).toBe("C");
    expect(business.get("cancel_followup")).toBe("C");
    expect(business.get("list_overdue_followups")).toBe("A");
    expect(business.get("read_metrics")).toBe("A");
    // UA-3 next slice (D-53): 8 nye open-loop/brief-handlinger - A for lesing,
    // B for enkle reversible felt-oppdateringer, C for resolusjon/utsettelse.
    expect(business.get("list_open_loops")).toBe("A");
    expect(business.get("read_open_loop")).toBe("A");
    expect(business.get("get_attention_queue")).toBe("A");
    expect(business.get("get_business_brief")).toBe("A");
    expect(business.get("resolve_open_loop")).toBe("C");
    expect(business.get("defer_open_loop")).toBe("C");
    expect(business.get("assign_open_loop")).toBe("B");
    expect(business.get("set_open_loop_next_action")).toBe("B");
    // UA-3 business-event-linkage (D-57): synk avledet fra allerede-autoriserte
    // lese-handlinger - samme klasse som record_activity selv.
    expect(business.get("sync_business_events")).toBe("B");
    // UA-3 profiling/scoring-slice (D-61): A for lesing (inkl. rangering), B for
    // rekalkulering/overstyring (enkle, reversible interne tilstandsskrivinger).
    expect(business.get("get_lead_score")).toBe("A");
    expect(business.get("get_opportunity_score")).toBe("A");
    expect(business.get("explain_score")).toBe("A");
    expect(business.get("rank_leads")).toBe("A");
    expect(business.get("rank_opportunities")).toBe("A");
    expect(business.get("recalculate_score")).toBe("B");
    expect(business.get("set_manual_override")).toBe("B");
    expect(business.get("clear_manual_override")).toBe("B");
    // UA-3 Support/Tickets (Zendesk, D-64): synk avledet fra allerede-autoriserte
    // lese-handlinger - samme klasse som sync_business_events selv.
    expect(business.get("sync_zendesk_tickets")).toBe("B");
    expect([...business.values()]).not.toContain("D");
  });
});

describe("UA-3 profiling/scoring-slice (D-61): score-handlinger kjoerer gjennom SAMME ToolGateway/PolicyGateway-pipeline", () => {
  it("Q: owner sin get_lead_score/rank_leads (klasse A-lesing) kjoerer og returnerer full faktor-forklaring", async () => {
    const lead = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_lead",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Score-wiring-lead", status: "qualified" }
    });
    expect(lead.ok).toBe(true);
    const leadId = lead.ok ? lead.external_id : undefined;
    const recalc = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "lead", entity_id: leadId as string }
    });
    expect(recalc.ok).toBe(true);
    const scoreResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "get_lead_score",
      parameters: { tenant_id: TENANT, memory_space: "business", lead_id: leadId as string }
    });
    expect(scoreResult.ok).toBe(true);
    const data = scoreResult.ok ? (scoreResult.data as { factor_summary: unknown[]; rule_version: string }) : undefined;
    expect(Array.isArray(data?.factor_summary)).toBe(true);
    expect(data?.rule_version).toBe("lead_priority_v1");
    const rankResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "rank_leads",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(rankResult.ok).toBe(true);
    expect(Array.isArray(rankResult.ok ? rankResult.data : undefined)).toBe(true);
  });

  it("R: owner sin set_manual_override/clear_manual_override (klasse B) kjoerer uten approval under SOVEREIGN authority", async () => {
    const opp = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_opportunity",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Override-wiring-opp", stage: "proposal" }
    });
    expect(opp.ok).toBe(true);
    const oppId = opp.ok ? opp.external_id : undefined;
    await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: oppId as string }
    });
    const overrideResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "set_manual_override",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: oppId as string, override_score: 12, reason: "Kunde utsatt intern beslutning" }
    });
    expect(overrideResult.ok).toBe(true);
    const clearResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "clear_manual_override",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: oppId as string }
    });
    expect(clearResult.ok).toBe(true);
  });

  it("en delegat MED aktiv auth faar klasse-B set_manual_override (samme EKSISTERENDE class_b_reversible_internal-regel som sync_business_events - IKKE mandatkrav, det gjelder kun klasse C)", async () => {
    const opp = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_opportunity",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Delegat-override-opp", stage: "new" }
    });
    const oppId = opp.ok ? opp.external_id : undefined;
    await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: oppId as string }
    });
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "set_manual_override",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "opportunity", entity_id: oppId as string, override_score: 1, reason: "delegat-forsoek" }
    });
    expect(result.ok).toBe(true);
  });

  it("en delegat FAAR rank_opportunities (class A-lesing)", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "rank_opportunities",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
  });

  it("K/S/Z: audit-metadata for set_manual_override inneholder aldri overstyrings-begrunnelsen eller noe kreditt-/tokenverdi - kun credential_ref/external_id/scopes/rollback", async () => {
    const lead = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_lead",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Audit-override-lead", status: "contacted" }
    });
    const leadId = lead.ok ? lead.external_id : undefined;
    await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "recalculate_score",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "lead", entity_id: leadId as string }
    });
    const sensitiveReason = "HEMMELIG-OVERSTYRINGS-BEGRUNNELSE-99";
    const overrideResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "set_manual_override",
      parameters: { tenant_id: TENANT, memory_space: "business", entity_type: "lead", entity_id: leadId as string, override_score: 77, reason: sensitiveReason }
    });
    expect(overrideResult.ok).toBe(true);
    const { rows } = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'set_manual_override' ORDER BY at DESC LIMIT 1",
      [TENANT]
    );
    expect(rows).toHaveLength(1);
    const payload = JSON.stringify((rows[0] as { payload: unknown }).payload);
    expect(payload).toContain("credential_ref");
    expect(payload).not.toContain(sensitiveReason);
    expect(payload).not.toMatch(/access_token|refresh_token|client_secret/i);
  });
});

describe("O: owner sovereign policy - full autonom utførelse, ingen approval-friksjon", () => {
  it("owner sin capability_class C-handling (update_opportunity_stage) kjører uten approval under SOVEREIGN authority", async () => {
    const create = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_opportunity",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Sovereign-test" }
    });
    expect(create.ok).toBe(true);
    const opportunityId = create.ok ? create.external_id : undefined;
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "update_opportunity_stage",
      parameters: { tenant_id: TENANT, memory_space: "business", opportunity_id: opportunityId as string, stage: "won" }
    });
    expect(result.ok).toBe(true);
  });
});

describe("P: delegert policy forblir trygg - ingen implisitt owner-autoritet", () => {
  it("en delegat (delegation_id satt) faar IKKE class-C-handlinger autonomt uten mandat/approval - identisk EKSISTERENDE PolicyGateway-regel, ikke ny logikk", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "update_opportunity_stage",
      parameters: { tenant_id: TENANT, memory_space: "business", opportunity_id: "biz-op-nonexistent", stage: "won" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class_c_no_mandate");
    }
  });

  it("en delegat FAAR likevel class-A-lesing (read_metrics) - lesing er alltid tillatt, uavhengig av mandate", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "read_metrics",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
  });
});

describe("N: audit-metadata inneholder aldri sensitivt kundeinnhold", () => {
  it("audit_events.payload for create_contact inneholder KUN credential_ref/external_id/scopes/rollback - aldri navn/e-post/telefon", async () => {
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_contact",
      parameters: { tenant_id: TENANT, memory_space: "business", name: "Sensitiv Person", email: "sensitiv@eksempel.no", phone: "+4712345678" }
    });
    expect(result.ok).toBe(true);
    const { rows } = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'create_contact' ORDER BY at DESC LIMIT 1",
      [TENANT]
    );
    const payload = JSON.stringify((rows[0] as { payload: unknown }).payload);
    expect(payload).not.toContain("Sensitiv Person");
    expect(payload).not.toContain("sensitiv@eksempel.no");
    expect(payload).not.toContain("+4712345678");
  });
});

describe("UA-3 next slice (D-53): open-loop-handlinger kjoerer gjennom SAMME ToolGateway/PolicyGateway-pipeline", () => {
  it("owner sin capability_class C-handling (resolve_open_loop) kjoerer uten approval under SOVEREIGN authority", async () => {
    const followup = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_followup",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Sovereign open-loop-test", due_at: "2020-01-01T00:00:00Z" }
    });
    expect(followup.ok).toBe(true);
    // Kjoer deteksjonen direkte (ToolGateway eksponerer ikke selve sveipet - det er en scheduler-jobb, ikke en agent-handling).
    const openLoops = new OpenLoopService(appPool);
    await openLoops.detectOverdueFollowups(TENANT, "business");
    const listResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "list_open_loops",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(listResult.ok).toBe(true);
    const loopId = listResult.ok ? (listResult.data as Array<{ open_loop_id: string }>)[0]?.open_loop_id : undefined;
    expect(loopId).toBeTruthy();
    const resolveResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "resolve_open_loop",
      parameters: { tenant_id: TENANT, memory_space: "business", open_loop_id: loopId as string, resolution_reason: "sovereign-test" }
    });
    expect(resolveResult.ok).toBe(true);
  });

  it("en delegat faar IKKE resolve_open_loop (class C) autonomt uten mandat - samme EKSISTERENDE PolicyGateway-regel", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "resolve_open_loop",
      parameters: { tenant_id: TENANT, memory_space: "business", open_loop_id: "biz-ol-nonexistent", resolution_reason: "forsoek" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class_c_no_mandate");
    }
  });

  it("en delegat FAAR likevel get_attention_queue (class A-lesing)", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "get_attention_queue",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
  });

  it("audit-metadata for resolve_open_loop inneholder aldri fritekst-begrunnelsen (resolution_reason) - kun credential_ref/external_id/scopes/rollback", async () => {
    const followup = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_followup",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Audit-sensitiv oppfoelging", due_at: "2020-01-02T00:00:00Z" }
    });
    expect(followup.ok).toBe(true);
    const followupId = followup.ok ? followup.external_id : undefined;
    const openLoops = new OpenLoopService(appPool);
    await openLoops.detectOverdueFollowups(TENANT, "business");
    const listResult = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "list_open_loops",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    const loops = listResult.ok ? (listResult.data as Array<{ open_loop_id: string; followup_id: string | null }>) : [];
    const targetLoop = loops.find((l) => l.followup_id === followupId);
    expect(targetLoop).toBeTruthy();
    const sensitiveReason = "HEMMELIG-INTERN-BEGRUNNELSE-42";
    await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "resolve_open_loop",
      parameters: { tenant_id: TENANT, memory_space: "business", open_loop_id: targetLoop!.open_loop_id, resolution_reason: sensitiveReason }
    });
    const { rows } = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'resolve_open_loop' ORDER BY at DESC LIMIT 1",
      [TENANT]
    );
    const payload = JSON.stringify((rows[0] as { payload: unknown }).payload);
    expect(payload).not.toContain(sensitiveReason);
  });
});

describe("UA-3 business-event-linkage (D-57): sync_business_events kjoerer gjennom SAMME ToolGateway-pipeline", () => {
  it("owner sin sync_business_events (klasse B) kjoerer uten approval og gaar via de registrerte email/calendar-verktoeyene", async () => {
    emailFake.calls.length = 0;
    calendarFake.calls.length = 0;
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
    expect(emailFake.calls.some((c) => c.action === "list_messages")).toBe(true);
    expect(calendarFake.calls.some((c) => c.action === "list_events")).toBe(true);
  });

  it("en delegat MED aktiv auth faar klasse-B sync_business_events (samme EKSISTERENDE class_b_reversible_internal-regel som resten av business.*)", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
  });

  it("audit-metadata for sync_business_events inneholder aldri Gmail/Calendar-innhold", async () => {
    const { rows } = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events' ORDER BY at DESC LIMIT 1",
      [TENANT]
    );
    expect(rows).toHaveLength(1);
    const payload = JSON.stringify((rows[0] as { payload: unknown }).payload);
    expect(payload).toContain("credential_ref");
    expect(payload).not.toMatch(/subject|body_text|attendees/i);
  });
});
