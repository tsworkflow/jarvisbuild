import { createHash, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "./capability.ts";
import { canonicalStringify } from "./canonical.ts";

/**
 * Signert godkjenningsobjekt for klasse D-handlinger (SECURITY_MODEL §3).
 * LLM-en kan be om en godkjenning, men kan aldri opprette, endre eller omgå den.
 * Verifiseres deterministisk i Policy Gateway; nonce er engangs (replay-vern).
 *
 * REMEDIERING DEL 2 (JARVIS-051): godkjenningen er nå KRYPTOGRAFISK BUNDET til
 *   - verktøyet (`tool_id`) OG handlingen (`action`) - en godkjenning for
 *     `notify` på ett verktøy gjelder aldri et annet verktøy med samme handlingsnavn,
 *   - de kanoniske parametrene (`parameters_hash`, SHA-256 av kanonisk JSON),
 *   - tenanten (`tenant_id`) og den forespørrende personen (`person_id`),
 *   - den godkjennende personen (`approver_person_id`) og enheten (`approving_device_id`),
 *   - utstedelsestidspunktet (`issued_at`), utløpet (`expires_at`; maks levetid
 *     `APPROVAL_MAX_TTL_MS`) og engangs-nonce.
 * Verifikatoren sammenligner HVERT av disse mot den faktiske forespørselen og mot
 * det registrerte enhetsregisteret - en signatur alene gir aldri nok.
 */

/** Lengste tillatte levetid for en godkjenning (utløp − utstedelse). Konstant, ikke konfig. */
export const APPROVAL_MAX_TTL_MS = 5 * 60 * 1000;
/** Toleranse for klokkeforskjell mellom signerende enhet og server (utstedt «i fremtiden»). */
export const APPROVAL_MAX_CLOCK_SKEW_MS = 30 * 1000;

export const SignedApprovalSchema = z
  .object({
    /** Verktøyet godkjenningen gjelder - må matche verktøykallet eksakt. */
    tool_id: z.string().min(1),
    /** Handlingen godkjenningen gjelder - må matche verktøykallet eksakt. */
    action: z.string().min(1),
    /** SHA-256 (hex) av de kanoniske parametrene - må matche verktøykallet eksakt. */
    parameters_hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Tenanten godkjenningen gjelder - må matche forespørselens identitet. */
    tenant_id: z.string().min(1),
    /** Personen som ber om handlingen - må matche forespørselens identitet. */
    person_id: z.string().min(1),
    /** Personen som godkjenner - må eie den signerende enheten og være eier-rolle i tenanten. */
    approver_person_id: z.string().min(1),
    /** Enheten som signerte (må være registrert, ikke tilbakekalt). */
    approving_device_id: z.string().min(1),
    /** Utstedelsestidspunkt, ISO 8601. */
    issued_at: z.string().datetime(),
    /** Utløpstid, ISO 8601. Maks `APPROVAL_MAX_TTL_MS` etter `issued_at`. */
    expires_at: z.string().datetime(),
    /** Engangs-ID. Én gyldig bruk; deretter avvises den (replay-vern). */
    nonce: z.string().min(16),
    /** Ed25519-signatur (base64) over kanonisk payload. */
    signature: z.string().min(1)
  })
  .strict();
export type SignedApproval = z.infer<typeof SignedApprovalSchema>;

/** Payloaden som signeres/verifiseres: alt unntatt selve signaturen. */
export type ApprovalPayload = Omit<SignedApproval, "signature">;

/** SHA-256 (hex) av parametrenes kanoniske JSON - DEN ENE definisjonen, brukt av signerer og verifikator. */
export function hashApprovalParameters(parameters: Record<string, JsonValue>): string {
  return createHash("sha256").update(canonicalStringify(parameters), "utf8").digest("hex");
}

/** Kanoniske bytes som signeres. Stabil uavhengig av nøkkelrekkefølge. */
export function approvalSigningBytes(payload: ApprovalPayload): Buffer {
  const canonical: JsonValue = {
    action: payload.action,
    approver_person_id: payload.approver_person_id,
    approving_device_id: payload.approving_device_id,
    expires_at: payload.expires_at,
    issued_at: payload.issued_at,
    nonce: payload.nonce,
    parameters_hash: payload.parameters_hash,
    person_id: payload.person_id,
    tenant_id: payload.tenant_id,
    tool_id: payload.tool_id
  };
  return Buffer.from(canonicalStringify(canonical), "utf8");
}

/**
 * Signerer en godkjenning med en Ed25519-privatnøkkel. Brukes av tester og av
 * server-side verktøy (enheten selv signerer på samme kanoniske bytes - se
 * `apps/mobile/Sources/JarvisKit/JarvisClient.swift`). Den ER IKKE en
 * autorisasjon: verifikasjonen skjer alltid i Policy Gateway.
 */
export function signApproval(
  privateKey: KeyObject,
  payload: Omit<ApprovalPayload, "parameters_hash" | "issued_at" | "expires_at"> & {
    parameters: Record<string, JsonValue>;
    issued_at?: string;
    expires_at?: string;
    /** Brukes bare når `expires_at` ikke er oppgitt. Standard 60 s. */
    ttl_ms?: number;
  }
): SignedApproval {
  const { parameters, ttl_ms, ...rest } = payload;
  const issuedAt = payload.issued_at ?? new Date().toISOString();
  const unsigned: ApprovalPayload = {
    ...rest,
    parameters_hash: hashApprovalParameters(parameters),
    issued_at: issuedAt,
    expires_at: payload.expires_at ?? new Date(new Date(issuedAt).getTime() + (ttl_ms ?? 60_000)).toISOString()
  };
  return { ...unsigned, signature: sign(null, approvalSigningBytes(unsigned), privateKey).toString("base64") };
}
