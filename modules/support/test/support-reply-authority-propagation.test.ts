import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalPayload, IdentityContext, SignedApproval } from "@jarvis/contracts";
import { signApproval } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";
import { SupportTransport } from "../src/transport.ts";

/**
 * UA-3 Native Support Core SECURITY FIX #2 (D-68): audit of the nested
 * `support.reply -> email.send` authority chain. HOST FIX #1 (D-67) fixed a
 * `credential_unavailable`/`class_d_missing_approval` bug by making
 * `SupportTransport`'s reply case build a `person_id: JARVIS_OWNER_PERSON_ID`
 * identity locally for the nested `email.send` (class D) call - this was a
 * REAL privilege escalation: ANY caller authorized to invoke `support.reply`
 * at all (owner OR a mandate-holding delegate) would have their nested
 * `email.send` executed with UNCONDITIONAL owner/sovereign authority,
 * bypassing the class-D signed-approval requirement entirely for a
 * non-owner caller.
 *
 * Fixed by adding `ToolInvocationContext` (`{identity, approval}` from the
 * ORIGINAL request) as a 4th parameter to `ToolTransport.invoke()` - the
 * gateway now hands transports the REAL caller context instead of transports
 * fabricating their own. `SupportTransport` forwards `context.identity`/
 * `context.approval` UNCHANGED into the nested `email.send` call - no new
 * authority model, no parallel approval mechanism, just propagation of the
 * EXISTING `IdentityContext`/`SignedApproval` primitives.
 *
 * This suite proves the invariant: effective_authority(nested email.send)
 * <= effective_authority(original support.reply caller), never elevated.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-sup-authority-a";
const TENANT_B = "tenant-sup-authority-b";
const OWNER = "person-authority-owner";
const DELEGATE = "person-authority-delegate";
const DEVICE_ID = "watch-authority-1";

const keys = generateKeyPairSync("ed25519");
const devices = new InMemoryDeviceRegistry();
// JARVIS-051: godkjenningsenheten tilhører EIEREN (eier-rolle) - delegaten ber om handlingen, eieren godkjenner.
devices.register(DEVICE_ID, keys.publicKey, { tenant_id: TENANT_A, person_id: OWNER });

function identityFor(personId: string, tenantId: string): IdentityContext {
  return {
    person_id: personId, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-authority-${personId}`, device_id: "dev-authority", channel: "api", auth_strength: "active"
  };
}

/** En godkjenning som eksakt matcher `email.send`-parametrene et gitt reply-kall faktisk sender (bundet til tool/tenant/person/approver). */
function sendApprovalFor(input: { to: string; subject: string; body: string }, overrides: Partial<Omit<ApprovalPayload, "parameters_hash">> = {}): SignedApproval {
  return signApproval(keys.privateKey, {
    tool_id: "email",
    action: "send",
    tenant_id: TENANT_A,
    person_id: DELEGATE,
    approver_person_id: OWNER,
    parameters: { to: input.to, subject: input.subject, body: input.body },
    nonce: `nonce-${randomUUID()}`,
    approving_device_id: DEVICE_ID,
    ...overrides
  });
}

function buildGateway(authorityOwnerTenants: string[], mandates: ReadonlySet<string> = new Set(["support:reply"])) {
  const policy = new PolicyGateway({
    devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates,
    authority: { owner_person_id: OWNER, owner_tenants: authorityOwnerTenants }
  });
  const secrets = new BusinessInternalSecretProviderPlusEmail();
  const gateway = new ToolGateway(appPool, policy, secrets);
  const support = new SupportService(appPool);
  const business = new BusinessService(appPool);
  const emailFake = new FakeTransport(() => ({ data: {} }));
  const supportTransport = new SupportTransport(support, business, gateway);
  for (const tool of firstWaveTools({ support: supportTransport, email: emailFake })) gateway.register(tool);
  return { gateway, support, emailFake, policy };
}

/** JARVIS_EMAIL_TOKEN/JARVIS_BUSINESS_INTERNAL_TOKEN begge løst - denne suiten tester AUTORITET, ikke credential-oppløsning (dekket separat i support-transport-credential-wiring.test.ts). */
class BusinessInternalSecretProviderPlusEmail extends BusinessInternalSecretProvider {
  override async get(ref: string): Promise<string | null> {
    if (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") return "dummy-authority-test-cred";
    return super.get(ref);
  }
}

async function replyParams(support: SupportService, tenantId: string, idemSuffix: string) {
  const ticket = await support.createTicket(tenantId, "business", { subject: `Authority ${idemSuffix}` });
  const input = { to: `kunde-${idemSuffix}@example.no`, subject: "Re: Authority", body: "Svar" };
  return {
    ticket, input,
    parameters: {
      tenant_id: tenantId, memory_space: "business", ticket_id: ticket.ticket_id,
      ...input, idempotency_key: `reply-authority-${idemSuffix}`
    }
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sup-authority-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sup_authority_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_authority_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Authority A','business'), ('${TENANT_B}','Authority B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner'), ('${DELEGATE}','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${DELEGATE}','${TENANT_A}'), ('${DELEGATE}','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-authority-a-business','${TENANT_A}','business'), ('ms-authority-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_authority_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: eier - support.reply -> nested email.send faar eier-identitet -> tillatt via sovereign, ingen approval trengs", () => {
  it("send lykkes, ingen approval vedlagt", async () => {
    const { gateway, support, emailFake } = buildGateway([TENANT_A]);
    const { parameters } = await replyParams(support, TENANT_A, "a");
    const result = await gateway.execute({ identity: identityFor(OWNER, TENANT_A), tool_id: "support", action: "reply", parameters });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { sent?: boolean } | undefined)?.sent).toBe(true);
    expect(emailFake.calls).toHaveLength(1);
  });
});

describe("B: delegat UTEN signert klasse-D-godkjenning -> nested email.send NEKTES", () => {
  it("support.reply 'lykkes' som ticket-operasjon, men email.send feiler med class_d_missing_approval - INGEN eskalering til eier", async () => {
    const { gateway, support, emailFake } = buildGateway([TENANT_A]); // delegat matcher IKKE owner_tenants/owner_person_id
    const { parameters } = await replyParams(support, TENANT_A, "b");
    const result = await gateway.execute({ identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters });
    expect(result.ok).toBe(true); // ytre support:reply er klasse C, tillatt via mandat
    if (result.ok) {
      const data = result.data as { sent?: boolean; error?: string } | undefined;
      expect(data?.sent).toBe(false);
      expect(data?.error).toContain("class_d_missing_approval");
    }
    expect(emailFake.calls).toHaveLength(0); // aldri naadd frem til selve utsendingen
  });
});

describe("C: delegat MED en gyldig, korrekt scopet godkjenning -> nested email.send TILLATES", () => {
  it("send lykkes naar en signert godkjenning for NETTOPP denne send-handlingen følger med", async () => {
    const { gateway, support, emailFake } = buildGateway([TENANT_A]);
    const { parameters, input } = await replyParams(support, TENANT_A, "c");
    const approval = sendApprovalFor(input);
    const result = await gateway.execute({
      identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters, approval
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { sent?: boolean } | undefined)?.sent).toBe(true);
    expect(emailFake.calls).toHaveLength(1);
  });
});

describe("D: godkjenning signert for FEIL handling/scope -> nested email.send NEKTES", () => {
  it("en godkjenning med action='reply' (i stedet for 'send') avvises med action_mismatch", async () => {
    const { gateway, support } = buildGateway([TENANT_A]);
    const { parameters, input } = await replyParams(support, TENANT_A, "d1");
    const wrongAction = sendApprovalFor(input, { action: "reply" });
    const result = await gateway.execute({
      identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters, approval: wrongAction
    });
    if (result.ok) expect((result.data as { error?: string } | undefined)?.error).toContain("class_d_action_mismatch");
  });

  it("en godkjenning med feil 'to'-parameter avvises med parameters_mismatch", async () => {
    const { gateway, support } = buildGateway([TENANT_A]);
    const { parameters, input } = await replyParams(support, TENANT_A, "d2");
    const wrongParams = sendApprovalFor({ ...input, to: "noen-andre@example.no" });
    const result = await gateway.execute({
      identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters, approval: wrongParams
    });
    if (result.ok) expect((result.data as { error?: string } | undefined)?.error).toContain("class_d_parameters_mismatch");
  });
});

describe("E: replay-vern - samme nonce brukt to ganger avvises andre gang", () => {
  it("første reply med en godkjenning lykkes, en andre reply som gjenbruker SAMME godkjenning feiler med nonce_already_used", async () => {
    const { gateway, support, emailFake } = buildGateway([TENANT_A]);
    const { parameters: p1, input } = await replyParams(support, TENANT_A, "e1");
    const approval = sendApprovalFor(input);
    const first = await gateway.execute({ identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters: p1, approval });
    expect(first.ok && (first.data as { sent?: boolean } | undefined)?.sent).toBe(true);

    // Nytt reply-kall (ny ticket/idempotency_key), men SAMME nonce/godkjenning gjenbrukt.
    const ticket2 = await support.createTicket(TENANT_A, "business", { subject: "Authority e2" });
    const p2 = {
      tenant_id: TENANT_A, memory_space: "business", ticket_id: ticket2.ticket_id,
      ...input, idempotency_key: "reply-authority-e2"
    };
    const second = await gateway.execute({ identity: identityFor(DELEGATE, TENANT_A), tool_id: "support", action: "reply", parameters: p2, approval });
    if (second.ok) expect((second.data as { error?: string } | undefined)?.error).toContain("class_d_nonce_already_used");
    expect(emailFake.calls).toHaveLength(1); // KUN den første sendingen gikk faktisk gjennom
  });
});

describe("F: en 'system'-merket identitet blir ALDRI stille eier - samme fail-closed oppførsel som en vanlig delegat", () => {
  it("person_id='system' uten approval feiler med class_d_missing_approval, IKKE stille sovereign", async () => {
    const { gateway, support, emailFake } = buildGateway([TENANT_A]);
    const { parameters } = await replyParams(support, TENANT_A, "f");
    const result = await gateway.execute({
      identity: identityFor("system", TENANT_A), tool_id: "support", action: "reply", parameters
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { sent?: boolean; error?: string } | undefined;
      expect(data?.sent).toBe(false);
      expect(data?.error).toContain("class_d_missing_approval");
    }
    expect(emailFake.calls).toHaveLength(0);
  });
});

describe("G/H: den nøstede email.send-audit-raden arver DEN EKTE kalleren sin FULLE identitet - aldri en fabrikkert verdi", () => {
  it("audit_events for det nøstede send-kallet har SAMME tenant_id/person_id/session_id/device_id som den opprinnelige identity - beviser (sammen med kildekode-gjennomgangen: ingen per-felt rekonstruksjon skjer noe sted) at memory_space_id (ikke lagret i audit_events, se 004_audit_cost.sql) OGSAA forblir uendret", async () => {
    const { gateway, support } = buildGateway([TENANT_A]);
    const { parameters } = await replyParams(support, TENANT_A, "gh");
    const identity = identityFor(OWNER, TENANT_A);
    const result = await gateway.execute({ identity, tool_id: "support", action: "reply", parameters });
    expect(result.ok).toBe(true);

    const { rows } = await adminPool.query(
      "SELECT tenant_id, person_id, session_id, device_id FROM audit_events WHERE tool_id = 'email' AND action = 'send' ORDER BY at DESC LIMIT 1"
    );
    const row = rows[0] as { tenant_id: string; person_id: string; session_id: string; device_id: string };
    expect(row.tenant_id).toBe(identity.tenant_id);
    expect(row.person_id).toBe(identity.person_id);
    expect(row.session_id).toBe(identity.session_id);
    expect(row.device_id).toBe(identity.device_id);
  });
});

describe("I: den nøstede identiteten er den EKTE kalleren sin - kan IKKE overstyres via parameters.tenant_id", () => {
  it("en delegat med identity.tenant_id=B kan ALDRI faa sovereign-authority for tenant A bare fordi parameters.tenant_id='A'", async () => {
    // authority er konfigurert KUN for TENANT_A - en identitet fra TENANT_B skal ALDRI bli sovereign,
    // uansett hva selve parameters (som styrer DATA-scope, ikke autoritet) sier.
    const { gateway, support, emailFake } = buildGateway([TENANT_A]);
    const { parameters } = await replyParams(support, TENANT_A, "i"); // parameters.tenant_id = TENANT_A
    const result = await gateway.execute({
      identity: identityFor(DELEGATE, TENANT_B), tool_id: "support", action: "reply", parameters
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { sent?: boolean; error?: string } | undefined;
      // Fortsatt SCOPED (identity.tenant_id=B er ikke i owner_tenants=[A]) - krever en godkjenning,
      // IKKE stille tillatt bare fordi parameters HEVDER tenant A.
      expect(data?.sent).toBe(false);
      expect(data?.error).toContain("class_d_missing_approval");
    }
    expect(emailFake.calls).toHaveLength(0);
  });
});

describe("J: idempotens - samme idempotency_key gir SAMME source_message_id, ingen duplisert ticket-event (eksisterende ON CONFLICT-mekanisme i ingestMessage(), uendret av kontekst-videreformidlingen)", () => {
  it("to reply-kall med SAMME idempotency_key registrerer KUN ETT agent_reply-event for ticketen", async () => {
    const { gateway, support } = buildGateway([TENANT_A]);
    const { parameters } = await replyParams(support, TENANT_A, "j");
    const identity = identityFor(OWNER, TENANT_A);
    const first = await gateway.execute({ identity, tool_id: "support", action: "reply", parameters });
    const second = await gateway.execute({ identity, tool_id: "support", action: "reply", parameters });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // ingestMessage() matcher paa `source_thread_id` (ikke `parameters.ticket_id`) - en
    // reply paa en ticket UTEN egen source_thread_id ruter derfor til den EGNE, faste
    // `ticket.ticket_id`-avledede tråden (pre-eksisterende ingestMessage()-oppførsel,
    // UENDRET av denne sikkerhetsfiksen) - les den FAKTISKE resulterende ticket-iden
    // fra selve svaret, ikke fra `parameters`.
    const resultTicketId = (first.ok ? (first.data as { ticket: { ticket_id: string } }).ticket.ticket_id : undefined)!;
    const events = await support.listEvents(TENANT_A, "business", resultTicketId);
    const replyEvents = events.filter((e) => e.event_type === "agent_reply");
    expect(replyEvents).toHaveLength(1);
  });
});
