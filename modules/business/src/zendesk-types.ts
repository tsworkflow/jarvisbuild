/**
 * UA-3 Support/Tickets (Zendesk, D-64). `zendesk_tickets` er CURRENT STATE
 * (ikke append-only) - samme rolle `business_leads`/`business_opportunities`
 * spiller for sine egne open-loop-regler. Faktiske hendelser (ticket
 * opprettet/oppdatert) gaar som vanlig inn i EKSISTERENDE
 * `business_activities` (source_type='zendesk') - se zendesk-event-sync.ts.
 */

export type ZendeskTicketStatus = "new" | "open" | "pending" | "hold" | "solved" | "closed";
export type ZendeskTicketPriority = "low" | "normal" | "high" | "urgent";

export interface ZendeskTicketRecord {
  ticket_id: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  provider_instance_id: string;
  external_ticket_id: string;
  subject: string;
  status: ZendeskTicketStatus;
  priority: ZendeskTicketPriority | null;
  assignee_external_id: string | null;
  requester_external_id: string | null;
  canonical_uri: string;
  created_at_provider: string | null;
  updated_at_provider: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertZendeskTicketInput {
  provider_instance_id: string;
  external_ticket_id: string;
  subject: string;
  status: ZendeskTicketStatus;
  priority?: ZendeskTicketPriority | null;
  company_id?: string | null;
  contact_id?: string | null;
  assignee_external_id?: string | null;
  requester_external_id?: string | null;
  canonical_uri: string;
  created_at_provider?: string | null;
  updated_at_provider?: string | null;
}
