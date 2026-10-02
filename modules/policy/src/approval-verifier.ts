import { verify } from "node:crypto";
import {
  APPROVAL_MAX_CLOCK_SKEW_MS,
  APPROVAL_MAX_TTL_MS,
  SignedApprovalSchema,
  approvalSigningBytes,
  hashApprovalParameters,
  type JsonValue,
  type SignedApproval
} from "@jarvis/contracts";
import type { DeviceRegistry } from "./device-registry.ts";

export type ApprovalCheck =
  | { valid: true; approval: SignedApproval }
  | {
      valid: false;
      reason:
        | "malformed_approval"
        | "unknown_device"
        | "approver_not_owner"
        | "approver_mismatch"
        | "invalid_signature"
        | "tool_mismatch"
        | "action_mismatch"
        | "parameters_mismatch"
        | "tenant_mismatch"
        | "person_mismatch"
        | "ttl_exceeded"
        | "issued_in_future"
        | "expired";
    };

/**
 * Deterministisk verifisering av et signert godkjenningsobjekt mot den
 * faktiske handlingen. Nonce-forbruk skjer separat i PolicyGateway slik at
 * en godkjenning som feiler andre kontroller ikke brenner sin nonce.
 *
 * Rekkefølge: struktur → enhet (registrert, ikke revokert, riktig tenant) →
 * eier-rolle/eierskap → signatur → binding til verktøy/handling/parametere/
 * tenant/person → tid (utstedt, TTL-tak, utløp). Hver sjekk er et eget,
 * maskinlesbart avslag.
 */
export async function verifyApproval(
  approvalInput: unknown,
  expected: {
    tool_id: string;
    action: string;
    parameters: Record<string, JsonValue>;
    tenant_id: string;
    person_id: string;
  },
  devices: DeviceRegistry,
  now: Date
): Promise<ApprovalCheck> {
  const parsed = SignedApprovalSchema.safeParse(approvalInput);
  if (!parsed.success) {
    return { valid: false, reason: "malformed_approval" };
  }
  const approval: SignedApproval = parsed.data;

  // Enheten slås opp I FORESPØRSELENS tenant: en enhet i en annen tenant, en
  // ukjent enhet og en REVOKERT enhet er alle `unknown_device`.
  const device = await devices.approverFor(approval.approving_device_id, expected.tenant_id);
  if (!device) {
    return { valid: false, reason: "unknown_device" };
  }
  if (device.tenant_id !== expected.tenant_id) {
    return { valid: false, reason: "tenant_mismatch" };
  }
  if (device.person_id !== approval.approver_person_id) {
    return { valid: false, reason: "approver_mismatch" };
  }
  if (!device.is_owner) {
    return { valid: false, reason: "approver_not_owner" };
  }

  let signatureOk = false;
  try {
    signatureOk = verify(
      null, // Ed25519: algoritmen ligger i nøkkelen
      approvalSigningBytes(approval),
      device.key,
      Buffer.from(approval.signature, "base64")
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { valid: false, reason: "invalid_signature" };
  }

  // Signaturen er gyldig - kontroller at godkjenningen gjelder EKSAKT denne handlingen.
  if (approval.tenant_id !== expected.tenant_id) {
    return { valid: false, reason: "tenant_mismatch" };
  }
  if (approval.person_id !== expected.person_id) {
    return { valid: false, reason: "person_mismatch" };
  }
  if (approval.tool_id !== expected.tool_id) {
    return { valid: false, reason: "tool_mismatch" };
  }
  if (approval.action !== expected.action) {
    return { valid: false, reason: "action_mismatch" };
  }
  if (approval.parameters_hash !== hashApprovalParameters(expected.parameters)) {
    return { valid: false, reason: "parameters_mismatch" };
  }
  const issuedAt = new Date(approval.issued_at).getTime();
  const expiresAt = new Date(approval.expires_at).getTime();
  if (issuedAt > now.getTime() + APPROVAL_MAX_CLOCK_SKEW_MS) {
    return { valid: false, reason: "issued_in_future" };
  }
  if (expiresAt - issuedAt > APPROVAL_MAX_TTL_MS || expiresAt <= issuedAt) {
    return { valid: false, reason: "ttl_exceeded" };
  }
  if (expiresAt <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, approval };
}
