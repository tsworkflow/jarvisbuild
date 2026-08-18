import { describe, expect, it } from "vitest";
import { computeZendeskWebhookSignature, parseZendeskWebhookEvent, verifyZendeskWebhookSignature } from "@jarvis/tool-gateway";

/**
 * UA-3 Support/Tickets (Zendesk, D-64): testmatrise U/V/W/X (§39 i
 * byggeordren) - webhook-signaturverifisering. Rene funksjoner, ingen
 * nettverk/DB - samme presedens som google-auth-error-classification.test.ts.
 */
const SECRET = "test-webhook-signing-secret";

describe("verifyZendeskWebhookSignature", () => {
  it("U: gyldig signatur + fersk tidsstempel -> valid=true", () => {
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ ticket_id: "42" });
    const signature = computeZendeskWebhookSignature(SECRET, timestamp, rawBody);
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody });
    expect(result).toEqual({ valid: true });
  });

  it("V: ugyldig signatur (feil hemmelighet) -> webhook_invalid_signature", () => {
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ ticket_id: "42" });
    const signature = computeZendeskWebhookSignature("feil-hemmelighet", timestamp, rawBody);
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody });
    expect(result).toEqual({ valid: false, reason: "webhook_invalid_signature" });
  });

  it("V: manipulert kropp (signatur beregnet over ANNEN kropp) -> webhook_invalid_signature", () => {
    const timestamp = new Date().toISOString();
    const originalBody = JSON.stringify({ ticket_id: "42" });
    const tamperedBody = JSON.stringify({ ticket_id: "999" });
    const signature = computeZendeskWebhookSignature(SECRET, timestamp, originalBody);
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody: tamperedBody });
    expect(result).toEqual({ valid: false, reason: "webhook_invalid_signature" });
  });

  it("W: tidsstempel eldre enn 5 minutter -> webhook_replay, SELV med korrekt signatur", () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    const rawBody = JSON.stringify({ ticket_id: "42" });
    const signature = computeZendeskWebhookSignature(SECRET, oldTimestamp, rawBody);
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: oldTimestamp, rawBody, now: Date.now() });
    expect(result).toEqual({ valid: false, reason: "webhook_replay" });
  });

  it("W: tidsstempel i FREMTIDEN utover toleransen -> webhook_replay (klokkeskjevhet begge veier avvist)", () => {
    const futureTimestamp = new Date(Date.now() + 10 * 60_000).toISOString();
    const rawBody = JSON.stringify({ ticket_id: "42" });
    const signature = computeZendeskWebhookSignature(SECRET, futureTimestamp, rawBody);
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: futureTimestamp, rawBody });
    expect(result).toEqual({ valid: false, reason: "webhook_replay" });
  });

  it("fail-closed uten konfigurert hemmelighet - ALDRI godta en usignert webhook fordi secret mangler", () => {
    const timestamp = new Date().toISOString();
    const result = verifyZendeskWebhookSignature({ secret: undefined, signatureHeader: "whatever", timestampHeader: timestamp, rawBody: "{}" });
    expect(result).toEqual({ valid: false, reason: "webhook_secret_not_configured" });
  });

  it("manglende signatur- eller tidsstempel-header -> webhook_missing_headers", () => {
    expect(verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: undefined, timestampHeader: "x", rawBody: "{}" }))
      .toEqual({ valid: false, reason: "webhook_missing_headers" });
    expect(verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: "x", timestampHeader: undefined, rawBody: "{}" }))
      .toEqual({ valid: false, reason: "webhook_missing_headers" });
  });

  it("ugyldig (ikke-parsbart) tidsstempel -> webhook_invalid_timestamp, aldri en krasj", () => {
    const result = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: "x", timestampHeader: "ikke-en-dato", rawBody: "{}" });
    expect(result).toEqual({ valid: false, reason: "webhook_invalid_timestamp" });
  });
});

describe("X: webhook retry/idempotens - samme hendelse mottatt flere ganger gir SAMME parsede ticket-ID (Jarvis-siden idempotens håndteres av ZendeskEventSyncService/business_activities sin egen ON CONFLICT, ikke her)", () => {
  it("identisk gyldig webhook-kropp verifiseres/parses identisk ved gjentatt levering (Zendesk-retry)", () => {
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ ticket_id: "42", type: "conditional_ticket_events" });
    const signature = computeZendeskWebhookSignature(SECRET, timestamp, rawBody);
    for (let i = 0; i < 3; i++) {
      const verification = verifyZendeskWebhookSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody });
      expect(verification.valid).toBe(true);
      const event = parseZendeskWebhookEvent(rawBody);
      expect(event).toEqual({ ticketId: "42", eventType: "conditional_ticket_events" });
    }
  });
});

describe("parseZendeskWebhookEvent - §23: trekker UTELUKKENDE ut ticket-ID + hendelsestype, ALDRI andre felt", () => {
  it("parser den dokumenterte, anbefalte oppsett-formen ({ticket_id: string})", () => {
    expect(parseZendeskWebhookEvent(JSON.stringify({ ticket_id: "42" }))).toEqual({ ticketId: "42", eventType: "webhook" });
  });
  it("parser ticket_id som tall like trygt som streng", () => {
    expect(parseZendeskWebhookEvent(JSON.stringify({ ticket_id: 42 }))).toEqual({ ticketId: "42", eventType: "webhook" });
  });
  it("faller tilbake til Zendesk sitt native zen:event-type-format (detail.id)", () => {
    expect(parseZendeskWebhookEvent(JSON.stringify({ type: "zen:event-type:ticket.created", detail: { id: "77" } })))
      .toEqual({ ticketId: "77", eventType: "zen:event-type:ticket.created" });
  });
  it("ignorerer/eksponerer ALDRI andre felt fra kroppen - kun ticketId/eventType finnes i resultatet", () => {
    const event = parseZendeskWebhookEvent(JSON.stringify({
      ticket_id: "42", subject: "Sensitiv tittel", comment: { body: "Hemmelig kundekommunikasjon" }, requester_email: "kunde@acme.no"
    }));
    expect(Object.keys(event!)).toEqual(["ticketId", "eventType"]);
  });
  it("returnerer null for ugyldig JSON - kaster ALDRI", () => {
    expect(parseZendeskWebhookEvent("ikke json{{{")).toBeNull();
  });
  it("returnerer null når verken ticket_id eller detail.id finnes", () => {
    expect(parseZendeskWebhookEvent(JSON.stringify({ foo: "bar" }))).toBeNull();
  });
  it("returnerer null for et JSON-array (ikke et objekt)", () => {
    expect(parseZendeskWebhookEvent(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});
