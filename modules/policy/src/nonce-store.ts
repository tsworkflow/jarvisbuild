import type { JsonValue } from "@jarvis/contracts";

/**
 * Kontekst for forbruk av en engangs-godkjenning. Full kontekst (ikke bare
 * nonce) slik at persistente lagre kan lagre og revidere hva som ble forbrukt.
 */
export interface NonceConsumeContext {
  nonce: string;
  tenant_id: string;
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  /** SHA-256 av de kanoniske parametrene - det den signerte godkjenningen faktisk bandt seg til. */
  parameters_hash: string;
  /** Personen som ba om handlingen. */
  requester_person_id: string;
  /** Personen som godkjente (eier av den signerende enheten). */
  approver_person_id: string;
  approving_device_id: string;
  issued_at: string;
  expires_at: string;
}

/**
 * Engangs-lager for replay-vern. Kan være synkront (in-memory) eller
 * asynkront (PostgreSQL, fase 2-tabellen approvals). Policy Gateway behandler
 * feil fra lageret som DENY (fail-closed) - aldri ALLOW ved usikkerhet.
 */
export interface NonceStore {
  /** true = første bruk (OK), false = allerede brukt (replay). */
  consume(context: NonceConsumeContext): boolean | Promise<boolean>;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly used = new Set<string>();

  consume(context: NonceConsumeContext): boolean {
    if (this.used.has(context.nonce)) {
      return false;
    }
    this.used.add(context.nonce);
    return true;
  }
}
