import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * UA-3 Support/Tickets (Zendesk, D-64) §22/§23/§24 i byggeordren: Zendesk sin
 * dokumenterte webhook-signeringsmekanisme -
 * `base64(HMAC-SHA256(timestamp + rawBody, signing_secret))`, sendt som
 * `x-zendesk-webhook-signature` (+ `x-zendesk-webhook-signature-timestamp`).
 * Rene, side-effekt-frie funksjoner - ingen nettverk/DB - samme presedens som
 * `google-drive-reauth-lib.ts`. Selve HTTP-mottaket (apps/api/src/server.ts)
 * MÅ lese RÅ bytes FØR JSON.parse - HMAC-en beregnes over de eksakte
 * bytene, en re-serialisert JSON-streng ville gitt en annen signatur.
 *
 * §23 (kritisk sikkerhetsprinsipp): webhook-KROPPEN inneholder ALDRI noe mer
 * enn en ticket-ID (`parseZendeskWebhookEvent()` trekker UTELUKKENDE ut
 * `ticket_id`/`detail.id` - aldri status/prioritet/kommentarinnhold direkte
 * fra kroppen). Selv om signaturverifiseringen skulle svikte et sted, kan
 * INGEN utro/uautentisert feltinnhold noensinne nå Business OS - normalisering
 * skjer alltid via en FERSK `zendesk.get_ticket`-henting gjennom ToolGateway
 * (se `ZendeskEventSyncService.syncSingleTicketById()`).
 */

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export type ZendeskWebhookFailureReason =
  | "webhook_secret_not_configured"
  | "webhook_missing_headers"
  | "webhook_invalid_timestamp"
  | "webhook_replay"
  | "webhook_invalid_signature";

export type ZendeskWebhookVerification = { valid: true } | { valid: false; reason: ZendeskWebhookFailureReason };

/** Zendesk sin dokumenterte signeringsformel - egen eksportert funksjon slik at tester kan konstruere gyldige fixtures uten å duplisere formelen. */
export function computeZendeskWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody, "utf8").digest("base64");
}

/**
 * Verifiserer signatur OG tidsstempel-fersk (§23: replay-beskyttelse, 5
 * minutters vindu - samme størrelsesorden som typiske webhook-toleranser).
 * `now` er injiserbar for deterministisk testing - ALDRI `Date.now()` kalt
 * direkte inni en gjenbrukt funksjon uten mulighet for testinjeksjon.
 */
export function verifyZendeskWebhookSignature(params: {
  secret: string | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: string;
  now?: number;
}): ZendeskWebhookVerification {
  if (!params.secret) return { valid: false, reason: "webhook_secret_not_configured" };
  if (!params.signatureHeader || !params.timestampHeader) return { valid: false, reason: "webhook_missing_headers" };
  const timestampMs = Date.parse(params.timestampHeader);
  if (Number.isNaN(timestampMs)) return { valid: false, reason: "webhook_invalid_timestamp" };
  const now = params.now ?? Date.now();
  if (Math.abs(now - timestampMs) > MAX_TIMESTAMP_SKEW_MS) return { valid: false, reason: "webhook_replay" };
  const expected = computeZendeskWebhookSignature(params.secret, params.timestampHeader, params.rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(params.signatureHeader, "utf8");
  // §23: constant-time sammenligning (aldri `===` på secrets-avledede verdier - timing-angrep).
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "webhook_invalid_signature" };
  }
  return { valid: true };
}

export interface ZendeskWebhookEvent {
  ticketId: string;
  eventType: string;
}

/**
 * §23: trekker UTELUKKENDE ut ticket-ID + hendelsestype - ALDRI andre felt.
 * Støtter to former: (1) den DOKUMENTERTE, anbefalte oppsett-JSON-malen for
 * Jarvis sin egen trigger-koblede webhook (`{"ticket_id": "..."}`, se
 * setup-instruksjonene i .env.example), og (2) Zendesk sitt native
 * `zen:event-type:*`-hendelsesformat (`detail.id`) som et robusthets-fallback.
 */
export function parseZendeskWebhookEvent(rawBody: string): ZendeskWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const directTicketId = body["ticket_id"];
  if (typeof directTicketId === "string" && directTicketId.length > 0) {
    return { ticketId: directTicketId, eventType: typeof body["type"] === "string" ? body["type"] : "webhook" };
  }
  if (typeof directTicketId === "number") {
    return { ticketId: String(directTicketId), eventType: typeof body["type"] === "string" ? body["type"] : "webhook" };
  }
  const detail = body["detail"];
  if (typeof detail === "object" && detail !== null) {
    const detailId = (detail as Record<string, unknown>)["id"];
    if (typeof detailId === "string" && detailId.length > 0) {
      return { ticketId: detailId, eventType: typeof body["type"] === "string" ? body["type"] : "webhook" };
    }
    if (typeof detailId === "number") {
      return { ticketId: String(detailId), eventType: typeof body["type"] === "string" ? body["type"] : "webhook" };
    }
  }
  return null;
}
