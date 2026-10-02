import type pg from "pg";
import type { NonceConsumeContext, NonceStore } from "@jarvis/policy";
import { withTenantTransaction } from "../db/pool.ts";

/**
 * Persistent engangs-lager for signerte godkjenninger (fase 2-tabellen
 * approvals), koblet til Policy Gateway i fase 3. PRIMARY KEY på nonce gjør
 * forbruket atomisk: ved samtidige forsøk vinner nøyaktig én INSERT.
 *
 * Feil (DB nede, rollback) propageres som exception - Policy Gateway
 * behandler det som DENY (fail-closed). En rullet-tilbake transaksjon har
 * ikke registrert forbruk, men har heller ikke gitt ALLOW.
 */
export class PgApprovalStore implements NonceStore {
  constructor(private readonly pool: pg.Pool) {}

  async consume(context: NonceConsumeContext): Promise<boolean> {
    return withTenantTransaction(this.pool, context.tenant_id, async (client) => {
      const result = await client.query(
        `INSERT INTO approvals
           (nonce, tenant_id, action, parameters, approving_device_id, expires_at,
            tool_id, parameters_hash, requester_person_id, approver_person_id, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (nonce) DO NOTHING`,
        [
          context.nonce,
          context.tenant_id,
          context.action,
          JSON.stringify(context.parameters),
          context.approving_device_id,
          context.expires_at,
          context.tool_id,
          context.parameters_hash,
          context.requester_person_id,
          context.approver_person_id,
          context.issued_at
        ]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
