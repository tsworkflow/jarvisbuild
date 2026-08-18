import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { UpsertZendeskTicketInput, ZendeskTicketRecord } from "./zendesk-types.ts";

/**
 * Eier `zendesk_tickets` (D-64) - SAMME `withMemoryTransaction`-primitiv som
 * `BusinessService` (ingen ny sikkerhetsmodell). D-62-lærdommen gjelder
 * uendret: `zendesk_tickets` har BÅDE en tenant- OG en RESTRICTIVE
 * memory-space-policy (023_zendesk_support.sql) - `withTenantTransaction`
 * ALENE er strukturelt utilstrekkelig for denne tabellen.
 */
export class ZendeskTicketService {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent: (tenant_id, provider_instance_id, external_ticket_id) er identiteten - re-synk oppdaterer SAMME rad. */
  async upsertTicket(tenantId: string, memorySpace: MemorySpace, input: UpsertZendeskTicketInput): Promise<ZendeskTicketRecord> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const ticket_id = `zd-tk-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO zendesk_tickets (
           ticket_id, tenant_id, memory_space_id, company_id, contact_id, provider_instance_id, external_ticket_id,
           subject, status, priority, assignee_external_id, requester_external_id, canonical_uri,
           created_at_provider, updated_at_provider, synced_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (tenant_id, provider_instance_id, external_ticket_id) DO UPDATE SET
           subject = EXCLUDED.subject, status = EXCLUDED.status, priority = EXCLUDED.priority,
           company_id = COALESCE(EXCLUDED.company_id, zendesk_tickets.company_id),
           contact_id = COALESCE(EXCLUDED.contact_id, zendesk_tickets.contact_id),
           assignee_external_id = EXCLUDED.assignee_external_id, requester_external_id = EXCLUDED.requester_external_id,
           canonical_uri = EXCLUDED.canonical_uri,
           updated_at_provider = EXCLUDED.updated_at_provider, synced_at = now(), updated_at = now()
         RETURNING *`,
        [
          ticket_id, tenantId, memorySpace, input.company_id ?? null, input.contact_id ?? null,
          input.provider_instance_id, input.external_ticket_id, input.subject, input.status,
          input.priority ?? null, input.assignee_external_id ?? null, input.requester_external_id ?? null,
          input.canonical_uri, input.created_at_provider ?? null, input.updated_at_provider ?? null
        ]
      );
      return rows[0] as ZendeskTicketRecord;
    });
  }

  async getTicketByExternalId(
    tenantId: string, memorySpace: MemorySpace, providerInstanceId: string, externalTicketId: string
  ): Promise<ZendeskTicketRecord | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM zendesk_tickets WHERE tenant_id = $1 AND provider_instance_id = $2 AND external_ticket_id = $3`,
        [tenantId, providerInstanceId, externalTicketId]
      );
      return (rows[0] as ZendeskTicketRecord) ?? null;
    });
  }

  async listTickets(tenantId: string, memorySpace: MemorySpace): Promise<ZendeskTicketRecord[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM zendesk_tickets WHERE tenant_id = $1 ORDER BY updated_at DESC`,
        [tenantId]
      );
      return rows as ZendeskTicketRecord[];
    });
  }
}
