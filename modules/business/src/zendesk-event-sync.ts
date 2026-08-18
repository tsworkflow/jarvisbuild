import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { BusinessService } from "./service.ts";
import type { OpenLoopService } from "./open-loop-service.ts";
import type { ZendeskTicketService } from "./zendesk-ticket-service.ts";
import type { ZendeskTicketPriority, ZendeskTicketStatus } from "./zendesk-types.ts";

/**
 * UA-3 Support/Tickets (Zendesk, D-64): normaliserer Zendesk-tickets inn i
 * Business OS - SAMME arkitekturmønster som Gmail/Calendar (D-57):
 * provider -> EKSISTERENDE `ZendeskTransport` (via ToolGateway, samme trusted
 * vei) -> deterministisk entitetsgjenkjenning (kun requester-e-post, aldri
 * gjettet) -> `business_activities` (idempotent, `external_id =
 * "<ticket_id>:<updated_at>"` - ny rad per faktisk tilstandsendring) +
 * `zendesk_tickets` (current state for OpenLoopService) -> open-loop-
 * reevaluering (gjenbruker `OpenLoopService.runSweep()` uendret).
 *
 * Kritisk arkitekturprinsipp (§9/§21 i byggeordren): et ticket der requester-
 * e-posten IKKE gir eksakt ETT deterministisk kontakt-treff blir ALDRI
 * persistert (verken i `business_activities` eller `zendesk_tickets`) - dette
 * unngår at det SAMME fysiske ticketet dupliseres på tvers av flere
 * bedrifts-tenants som deler samme Zendesk-konto (samme delt-konto-mønster
 * som Gmail/Calendar, se Q-25 item 10).
 *
 * Webhook-sikkerhet (§23/§29): denne tjenesten er den ENESTE veien
 * webhook-hendelser normaliseres gjennom - `syncSingleTicketById()` henter
 * ALLTID ticketen på nytt via ToolGateway (aldri webhook-kroppens felter
 * direkte), se `zendesk-webhook.ts`.
 */

export interface ZendeskSyncStats {
  scanned: number;
  recorded: number;
  unmatched: number;
  ambiguous: number;
  /** Samme presedens som `GmailSyncStats.error` (business-event-sync.ts) - en sanitert, kort feilklasse, ALDRI et rått credential/token. */
  error?: string;
}

export interface ZendeskSyncResult {
  tickets: ZendeskSyncStats;
  open_loops_reevaluated: boolean;
}

export type ZendeskTicketSyncOutcome = "recorded" | "unmatched" | "ambiguous" | "not_found";

interface ZendeskTicketPayload {
  id?: string;
  subject?: string;
  status?: string;
  priority?: string;
  assignee_id?: string;
  requester_id?: string;
  requester_email?: string;
  organization_id?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
}

function sanitizeSyncError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 120);
}

export class ZendeskEventSyncService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly business: BusinessService,
    private readonly tickets: ZendeskTicketService,
    private readonly openLoops: OpenLoopService,
    private readonly subdomain: string = process.env["JARVIS_ZENDESK_SUBDOMAIN"] ?? ""
  ) {}

  /** Ett ticket -> Business OS. ALDRI persistert uten et eksakt, deterministisk kontakt-treff (§9). */
  async syncTicketData(tenantId: string, memorySpace: MemorySpace, ticket: ZendeskTicketPayload): Promise<ZendeskTicketSyncOutcome> {
    if (!ticket.id) return "unmatched";
    const matched = await this.resolveUniqueContact(tenantId, memorySpace, ticket.requester_email ? [ticket.requester_email] : []);
    if (matched === "ambiguous") return "ambiguous";
    if (!matched) return "unmatched";
    const url = ticket.url || `https://${this.subdomain}.zendesk.com/agent/tickets/${ticket.id}`;
    await this.tickets.upsertTicket(tenantId, memorySpace, {
      provider_instance_id: this.subdomain,
      external_ticket_id: ticket.id,
      subject: ticket.subject || "(uten emne)",
      status: (ticket.status || "new") as ZendeskTicketStatus,
      priority: ticket.priority ? (ticket.priority as ZendeskTicketPriority) : null,
      company_id: matched.company_id,
      contact_id: matched.contact_id,
      assignee_external_id: ticket.assignee_id || null,
      requester_external_id: ticket.requester_id || null,
      canonical_uri: url,
      created_at_provider: ticket.created_at || null,
      updated_at_provider: ticket.updated_at || null
    });
    await this.business.recordActivity(tenantId, memorySpace, {
      activity_type: "external_event",
      summary: `Zendesk-ticket: ${ticket.subject || "(uten emne)"}`,
      ...(matched.company_id !== null ? { company_id: matched.company_id } : {}),
      contact_id: matched.contact_id,
      source_type: "zendesk",
      source_instance_id: this.subdomain,
      external_id: `${ticket.id}:${ticket.updated_at || "unknown"}`,
      canonical_uri: url,
      ...(ticket.updated_at ? { occurred_at: ticket.updated_at } : {})
    });
    return "recorded";
  }

  /** Periodisk sveip: nylig oppdaterte tickets siden forrige kjøring (§25 - webhook er fast path, dette er sikkerhetsnettet). */
  async syncTickets(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    opts: { max?: number; updatedSince?: string } = {}
  ): Promise<ZendeskSyncStats> {
    const stats: ZendeskSyncStats = { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 };
    const result = await this.gateway.execute({
      identity, tool_id: "zendesk", action: "list_tickets",
      parameters: { max: opts.max ?? 25, ...(opts.updatedSince ? { updated_since: opts.updatedSince } : {}) }
    });
    if (!result.ok) throw new Error(result.reason);
    const tickets = ((result.data as { tickets?: JsonValue[] } | undefined)?.tickets ?? []) as ZendeskTicketPayload[];
    for (const ticket of tickets) {
      stats.scanned++;
      const outcome = await this.syncTicketData(tenantId, memorySpace, ticket);
      if (outcome === "recorded") stats.recorded++;
      else if (outcome === "unmatched") stats.unmatched++;
      else if (outcome === "ambiguous") stats.ambiguous++;
    }
    return stats;
  }

  /** Enkelt-ticket-resynk (webhook-drevet, §22/§24): henter ALLTID på nytt via ToolGateway - stoler aldri på webhook-kroppens felter. */
  async syncSingleTicketById(
    tenantId: string, memorySpace: MemorySpace, identity: IdentityContext, ticketId: string
  ): Promise<ZendeskTicketSyncOutcome> {
    const result = await this.gateway.execute({ identity, tool_id: "zendesk", action: "get_ticket", parameters: { ticket_id: ticketId } });
    if (!result.ok) {
      if (result.reason.includes("zendesk_not_found")) return "not_found";
      throw new Error(result.reason);
    }
    const data = result.data as {
      id?: string; subject?: string; status?: string; priority?: string; assignee_id?: string;
      requester_id?: string; requester_email?: string; organization_id?: string; created_at?: string; updated_at?: string; url?: string;
    };
    return this.syncTicketData(tenantId, memorySpace, data);
  }

  /** Eksplisitt, offentlig reevalueringspunkt (brukt av `syncZendeskTicketAcrossTenants()` for webhook-drevet enkelt-ticket-synk, som ikke går via `syncTenant()`). */
  async reevaluateOpenLoops(tenantId: string, memorySpace: MemorySpace): Promise<void> {
    await this.openLoops.runSweep(tenantId, memorySpace);
  }

  /** Full periodisk synk for ÉN tenant + open-loop-reevaluering (§20/§25 - gjenbruker OpenLoopService uendret). */
  async syncTenant(
    tenantId: string, memorySpace: MemorySpace, identity: IdentityContext, opts: { max?: number; updatedSince?: string } = {}
  ): Promise<ZendeskSyncResult> {
    let ticketStats: ZendeskSyncStats;
    try {
      ticketStats = await this.syncTickets(tenantId, memorySpace, identity, opts);
    } catch (err) {
      ticketStats = { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0, error: sanitizeSyncError(err) };
    }
    await this.openLoops.runSweep(tenantId, memorySpace);
    return { tickets: ticketStats, open_loops_reevaluated: true };
  }

  /** §9: eksakt ETT deterministisk kontakt-treff -> matched; 0 -> unmatched; >1 distinkt selskap -> ambiguous. Identisk mønster som BusinessEventSyncService. */
  private async resolveUniqueContact(
    tenantId: string, memorySpace: MemorySpace, candidateEmails: string[]
  ): Promise<{ contact_id: string; company_id: string | null } | "ambiguous" | null> {
    let firstMatch: { contact_id: string; company_id: string | null } | null = null;
    const distinctCompanyIds = new Set<string | null>();
    for (const email of candidateEmails) {
      const contacts = await this.business.findContactsByEmail(tenantId, memorySpace, email);
      if (contacts.length > 1) return "ambiguous";
      if (contacts.length === 1) {
        const contact = contacts[0]!;
        firstMatch ??= { contact_id: contact.contact_id, company_id: contact.company_id };
        distinctCompanyIds.add(contact.company_id);
      }
    }
    if (!firstMatch) return null;
    if (distinctCompanyIds.size > 1) return "ambiguous";
    return firstMatch;
  }
}

/**
 * §19/§20: periodisk kall-punkt for DailyScheduler - SAME overordnede mønster
 * som `runBusinessEventSyncForAllTenants` (per-tenant sync + isolert feil-
 * håndtering), MEN med en BEVISST forskjell i selve tenant-oppdagelsen: se
 * `023_zendesk_support.sql` sin D-64-kommentar - en raa `pool.query("SELECT
 * tenant_id FROM tenants WHERE kind=...")` er STRUKTURELT RLS-blind
 * (`tenants` har FORCE RLS, se 005_rls.sql), SAMME bug-klasse som D-54/D-59/
 * D-62 men i en produksjonsfunksjon, ikke et akseptanseskript. Bruker derfor
 * `jarvis_list_tenant_ids_by_kind()` (SECURITY DEFINER, snevert avgrenset
 * til KUN tenant_id/kind) i stedet - IKKE fordi det er "penere", men fordi
 * den raa spørringen bevislig returnerer 0 rader i produksjon.
 */
export async function runZendeskEventSyncForAllTenants(
  pool: pg.Pool, syncService: ZendeskEventSyncService
): Promise<Record<string, ZendeskSyncResult>> {
  const { rows } = await pool.query(`SELECT tenant_id FROM jarvis_list_tenant_ids_by_kind('business', 200)`);
  const results: Record<string, ZendeskSyncResult> = {};
  for (const row of rows as Array<{ tenant_id: string }>) {
    const identity: IdentityContext = {
      person_id: "system", tenant_id: row.tenant_id, memory_space_id: "business",
      session_id: `zendesk-tickets-sync-${row.tenant_id}`, device_id: "jarvis-core",
      channel: "api", auth_strength: "active"
    };
    try {
      results[row.tenant_id] = await syncService.syncTenant(row.tenant_id, "business", identity);
    } catch {
      results[row.tenant_id] = { tickets: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 }, open_loops_reevaluated: false };
    }
  }
  return results;
}

/**
 * §30 i byggeordren (multi-tenant): webhook-hendelser bærer INGEN Jarvis-
 * tenant_id (Zendesk kjenner kun sin egen konto) - samme kjente, dokumenterte
 * begrensning som Gmail/Calendar sin delte konto (Q-25 item 10). Denne
 * funksjonen forsøker deterministisk resolusjon for ETT ticket PÅ TVERS av
 * alle business-tenants (samme kandidatliste som den periodiske sveipen) -
 * ticketet blir KUN persistert i tenanten(e) der requester-e-posten faktisk
 * matcher en eksisterende kontakt (aldri gjettet, aldri duplisert på tvers av
 * tenants uten et reelt treff).
 */
export async function syncZendeskTicketAcrossTenants(
  pool: pg.Pool, syncService: ZendeskEventSyncService, ticketId: string
): Promise<Record<string, ZendeskTicketSyncOutcome>> {
  const { rows } = await pool.query(`SELECT tenant_id FROM jarvis_list_tenant_ids_by_kind('business', 200)`);
  const results: Record<string, ZendeskTicketSyncOutcome> = {};
  for (const row of rows as Array<{ tenant_id: string }>) {
    const identity: IdentityContext = {
      person_id: "system", tenant_id: row.tenant_id, memory_space_id: "business",
      session_id: `zendesk-webhook-${row.tenant_id}`, device_id: "jarvis-core",
      channel: "api", auth_strength: "active"
    };
    try {
      const outcome = await syncService.syncSingleTicketById(row.tenant_id, "business", identity, ticketId);
      results[row.tenant_id] = outcome;
      if (outcome === "recorded") await syncService.reevaluateOpenLoops(row.tenant_id, "business");
    } catch {
      results[row.tenant_id] = "unmatched";
    }
  }
  return results;
}
