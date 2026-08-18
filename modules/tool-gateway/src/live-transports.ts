import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * UA-2 P1B-A HOST FIX #1 (2026-08-16, host-funn run_id `3af67dab`): den
 * TIDLIGERE `googleAccessToken()` samlet ALLE token-endepunkt-feil til
 * `google_auth_failed_<status>` - selve Google-feilkroppen (`error`/
 * `error_description`, RFC 6749 §5.2 sitt FLATE skjema - IKKE den nøstede
 * `{error:{code,message,status,...}}`-formen `classifyDriveProbeError()`
 * under klassifiserer, som er en ANNEN Google-API-feilform) ble ALDRI lest.
 * Host-kjøringen fikk derfor kun `tool_failed:google_auth_failed_401` - IKKE
 * nok til å avgjøre om `JARVIS_EMAIL_TOKEN` var utstedt til en ANNEN
 * OAuth-klient (§3 i host-fix-ordren), tilbakekalt, eller noe helt annet.
 * `classifyGoogleTokenEndpointError()` er BEVISST tekst-basert-beste-innsats
 * på `error_description` (samme presedens som `classifyDriveProbeError()`
 * sin `WORKSPACE_ADMIN_POLICY`-gren) - Google gir INGEN mer presist
 * maskinlesbart signal for "token utstedt til en annen klient" enn en
 * `invalid_grant`-feilbeskrivelse som nevner det eksplisitt.
 *
 * UA-2 P1B-A HOST FIX #2 (2026-08-16, host-funn run_id `ab43fb1f`): et ekte
 * host-funn viste `invalid_client`/`unauthorized_client` (HTTP 401) mot den
 * ALLEREDE host-bevist FUNGERENDE Desktop-OAuth-klienten (samme klient som
 * bevist av Drive/D-42) - den forrige, blindt-ikke-gjenopprettbare
 * `GOOGLE_INVALID_CLIENT`-klassifiseringen stoppet derfor auto-reauth-forsøket
 * feilaktig. Vi kan IKKE kryptografisk bevise fra selve refresh-tokenet HVILKEN
 * gammel klient som opprinnelig utstedte det (§2 i ordren - IKKE påstå at
 * Google eksponerer det) - men NÅR den GJELDENDE Desktop-klienten allerede er
 * host-bevist (`JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`, persistert KUN etter
 * en tidligere `google-drive-reauth.ts`-suksess) og BEGGE client_id/_secret
 * faktisk er satt (ellers kastes `google_oauth_client_not_configured` FØR
 * dette punktet i det hele tatt), er en `invalid_client`/`unauthorized_client`
 * på DENNE ene credential-en (`JARVIS_EMAIL_TOKEN`) mest sannsynlig en
 * gjenstående gammel Gmail-tildeling fra FØR Desktop-klient-migreringen - IKKE
 * et bevis på at selve klienten er ødelagt/uprøvd. `EMAIL_REAUTH_REQUIRED`
 * skiller EKSPLISITT dette "kontekst-bevist trygt å reautorisere"-tilfellet
 * fra det generelle `GOOGLE_INVALID_CLIENT` (manglende secret, ikke-Desktop/
 * uprøvd klient, feilkonfigurert klient) - som FORTSATT fail-closed stopper
 * uten automatisk reauth-forsøk (§3 i ordren: "Do not globally make every
 * invalid_client error recoverable").
 */
export type GoogleAuthErrorClass =
  | "EMAIL_TOKEN_CLIENT_MISMATCH"
  | "EMAIL_REFRESH_TOKEN_REVOKED"
  | "EMAIL_INSUFFICIENT_SCOPE"
  | "GOOGLE_INVALID_GRANT"
  | "GOOGLE_INVALID_CLIENT"
  | "EMAIL_REAUTH_REQUIRED"
  | "UNKNOWN_GOOGLE_AUTH";

/** HOST FIX #2: KUN satt (til `"LEGACY_TOKEN_OR_CLIENT_BINDING"`) når `errorClass === "EMAIL_REAUTH_REQUIRED"` - en trygg, menneskelesbar/grep-bar begrunnelse, ALDRI en påstand om at Google faktisk eksponerte den gamle klient-IDen. */
export type GoogleAuthRecoveryReason = "LEGACY_TOKEN_OR_CLIENT_BINDING";

export interface GoogleAuthErrorDetails {
  httpStatus: number;
  /** Google sin RFC 6749 §5.2 `error`-kode, f.eks. "invalid_grant" - `undefined` hvis kroppen ikke var gyldig JSON eller manglet feltet. */
  googleError: string | undefined;
  /** Google sin `error_description` - ALDRI en secret (Google ekko-er aldri tilbake selve tokenet/client_secret i en feilrespons), men avkortet (300 tegn) som et ekstra sikkerhetsnett. */
  googleErrorDescription: string | undefined;
  errorClass: GoogleAuthErrorClass;
  /** HOST FIX #2: kun til stede for `EMAIL_REAUTH_REQUIRED` - se `GoogleAuthRecoveryReason`. */
  recoveryReason: GoogleAuthRecoveryReason | undefined;
}

interface TokenEndpointErrorBody {
  error?: string;
  error_description?: string;
}

/** HOST FIX #2: konteksten `classifyGoogleTokenEndpointError()` trenger for å skille et kontekst-bevist gjenopprettbart `invalid_client` (gjenbrukt, allerede host-bevist Desktop-klient) fra et FORTSATT fail-closed `invalid_client` (uprøvd/ikke-Desktop/feilkonfigurert klient). */
export interface GoogleAuthClientContext {
  /** `true` KUN når `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE === "desktop"` - persistert AV `google-drive-reauth.ts` KUN etter en fullstendig host-bevist Desktop-OAuth-suksess (se D-42). ALDRI antatt sann uten denne eksplisitte markøren. */
  provenDesktopClient: boolean;
}

/**
 * KUN for selve TOKEN-ENDEPUNKTET (`https://oauth2.googleapis.com/token`) -
 * IKKE for et Google API-kall som allerede har et access-token (se
 * `classifyDriveProbeError()` for DEN, nøstede feilformen). ALDRI kaster -
 * en ikke-JSON eller uventet kropp gir fortsatt en trygg (UNKNOWN_GOOGLE_AUTH)
 * klassifisering fremfor å knekke selve feilrapporteringen.
 */
export function classifyGoogleTokenEndpointError(httpStatus: number, rawBody: string, context: GoogleAuthClientContext): GoogleAuthErrorDetails {
  let parsed: TokenEndpointErrorBody = {};
  try {
    parsed = JSON.parse(rawBody) as TokenEndpointErrorBody;
  } catch {
    // Ikke-JSON-kropp (sjeldent for Google sitt token-endepunkt) - fortsett med tomt objekt.
  }
  const googleError = parsed.error;
  const googleErrorDescription = parsed.error_description?.slice(0, 300);
  const desc = googleErrorDescription ?? "";

  let errorClass: GoogleAuthErrorClass;
  let recoveryReason: GoogleAuthRecoveryReason | undefined;
  if (googleError === "invalid_grant") {
    if (/not match|different client|another client|client.?id/i.test(desc)) {
      errorClass = "EMAIL_TOKEN_CLIENT_MISMATCH";
    } else if (/expired|revoked/i.test(desc)) {
      errorClass = "EMAIL_REFRESH_TOKEN_REVOKED";
    } else {
      errorClass = "GOOGLE_INVALID_GRANT";
    }
  } else if (googleError === "invalid_client" || googleError === "unauthorized_client") {
    // HOST FIX #2 §3: KUN gjenopprettbar når den GJELDENDE klienten selv
    // allerede er host-bevist (Desktop-type) - ALDRI globalt for enhver
    // invalid_client (manglende secret/uprøvd/feilkonfigurert klient forblir
    // GOOGLE_INVALID_CLIENT, fail-closed, under).
    if (context.provenDesktopClient) {
      errorClass = "EMAIL_REAUTH_REQUIRED";
      recoveryReason = "LEGACY_TOKEN_OR_CLIENT_BINDING";
    } else {
      errorClass = "GOOGLE_INVALID_CLIENT";
    }
  } else if (googleError === "insufficient_scope" || /insufficient/i.test(desc)) {
    errorClass = "EMAIL_INSUFFICIENT_SCOPE";
  } else {
    errorClass = "UNKNOWN_GOOGLE_AUTH";
  }
  return { httpStatus, googleError, googleErrorDescription, errorClass, recoveryReason };
}

/** Trygg, grep-bar én-linjes diagnosetekst - ALDRI token/secret, kun de klassifiserte, ikke-sensitive feltene (samme presedens som `formatDriveProbeReport()`). */
export function formatGoogleAuthErrorReport(details: GoogleAuthErrorDetails): string {
  const reason = details.recoveryReason ? ` recovery_reason=${details.recoveryReason}` : "";
  return `google_auth_error_class=${details.errorClass} http_status=${details.httpStatus} google_error=${details.googleError ?? "unknown"}${reason}`;
}

/** Klassene som er trygge å AUTOMATISK forsøke reautorisert via `google-email-reauth.ts` - de resterende (GOOGLE_INVALID_CLIENT/UNKNOWN_GOOGLE_AUTH) krever manuell undersøkelse, ALDRI en gjentatt automatisk reauth-løkke mot en sannsynligvis feil grunnleggende årsak. HOST FIX #2: `EMAIL_REAUTH_REQUIRED` er BEVIST kontekst-trygg av `classifyGoogleTokenEndpointError()` selv (kun satt når `provenDesktopClient` var sann) - INGEN ekstra kontekst trengs her, unngår en duplisert/divergerende sjekk. */
export function isRecoverableGoogleAuthErrorClass(errorClass: GoogleAuthErrorClass): boolean {
  return errorClass === "EMAIL_TOKEN_CLIENT_MISMATCH" || errorClass === "EMAIL_REFRESH_TOKEN_REVOKED" ||
    errorClass === "GOOGLE_INVALID_GRANT" || errorClass === "EMAIL_INSUFFICIENT_SCOPE" || errorClass === "EMAIL_REAUTH_REQUIRED";
}

const GOOGLE_AUTH_FAILED_MESSAGE_PATTERN = /google_auth_failed_(\d+):(\w+)(?::(.+))?$/;

/**
 * Parser den klassifiserte meldingen `googleAccessToken()` kaster tilbake ut
 * av en `ToolResult` sin `reason`-streng (`tool_failed:google_auth_failed_
 * <status>:<class>[:<google_error>]` - se `ToolGateway.execute()` sin
 * "tool_failed:<message>"-innpakning). `undefined` for ALT annet (en
 * uklassifisert/annen type feil) - kalleren skal ALDRI anta Google-auth uten
 * dette mønsteret faktisk til stede.
 */
export function parseGoogleAuthFailureReason(reason: string): GoogleAuthErrorClass | undefined {
  const match = GOOGLE_AUTH_FAILED_MESSAGE_PATTERN.exec(reason);
  const errorClass = match?.[2];
  if (!errorClass) return undefined;
  const known: readonly GoogleAuthErrorClass[] = [
    "EMAIL_TOKEN_CLIENT_MISMATCH", "EMAIL_REFRESH_TOKEN_REVOKED", "EMAIL_INSUFFICIENT_SCOPE",
    "GOOGLE_INVALID_GRANT", "GOOGLE_INVALID_CLIENT", "EMAIL_REAUTH_REQUIRED", "UNKNOWN_GOOGLE_AUTH"
  ];
  return (known as readonly string[]).includes(errorClass) ? (errorClass as GoogleAuthErrorClass) : undefined;
}

/**
 * PRODUKSJONSTRANSPORTER (BO-03). Live-verifisering krever credentials i .env
 * (BLOCKED_EXTERNAL til de finnes) - koden er komplett og typesjekket.
 * Credential-argumentet kommer fra SecretProvider via Tool Gateway; for Google
 * er det en OAuth REFRESH TOKEN (kortlivet access-token hentes her og logges
 * aldri). Konto-/tenant-oppløsning: hver transport-instans er bundet til én
 * eksplisitt konto (accountEmail) - ingen implisitt cross-account fallback.
 */
async function googleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("google_oauth_client_not_configured");
  // HOST FIX #2: KUN LEST (aldri skrevet/eksponert) for å avgjøre om DENNE
  // klienten allerede er host-bevist Desktop-type - samme markør
  // `google-drive-reauth.ts` persisterer, brukt her UTELUKKENDE til
  // `classifyGoogleTokenEndpointError()` sin kontekst-bevisste
  // EMAIL_REAUTH_REQUIRED-gren (se dens toppkommentar).
  const provenDesktopClient = process.env["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"] === "desktop";
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken })
  });
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const details = classifyGoogleTokenEndpointError(response.status, rawBody, { provenDesktopClient });
    throw new Error(`google_auth_failed_${response.status}:${details.errorClass}${details.googleError ? `:${details.googleError}` : ""}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Gmail sin `attachmentId`/vedleggs-metadata, funnet ved å gå gjennom MIME-treet (`payload.parts`, kan være nøstet). */
interface GmailAttachmentPart {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

interface GmailMimePart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: unknown[];
}

/** Rekursivt - Gmail sitt MIME-tre kan nøste `parts` (f.eks. multipart/mixed → multipart/alternative → vedlegg). */
function collectAttachmentParts(part: GmailMimePart | undefined): GmailAttachmentPart[] {
  if (!part) return [];
  const found: GmailAttachmentPart[] = [];
  if (part.filename && part.body?.attachmentId) {
    found.push({
      attachment_id: part.body.attachmentId, filename: part.filename,
      mime_type: part.mimeType ?? "application/octet-stream", size_bytes: part.body.size ?? 0
    });
  }
  for (const child of part.parts ?? []) {
    found.push(...collectAttachmentParts(child as GmailMimePart));
  }
  return found;
}

/**
 * Rekursivt - finner FØRSTE `text/plain`-del uten `attachmentId` (skiller
 * body-tekst fra en `.txt`-VEDLEGG, som skal gå gjennom `attachments`, ikke
 * `body_text`). Samme MIME-tre-nøsting som `collectAttachmentParts()`.
 */
function findBodyTextPart(part: GmailMimePart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data && !part.body.attachmentId) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findBodyTextPart(child as GmailMimePart);
    if (found) return found;
  }
  return undefined;
}

/** Gmail returnerer vedleggsdata som URL-safe base64 (RFC 4648 §5) - konverter til standard base64 FØR det når resten av Jarvis (data-URIer, Model Gateway vision-innhold forventer standard base64). */
function base64UrlToStandard(data: string): string {
  const standard = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = standard.length % 4 === 0 ? "" : "=".repeat(4 - (standard.length % 4));
  return standard + padding;
}

export class GmailTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };
    switch (action) {
      case "read_inbox":
        return this.readInbox(parameters, auth);
      case "list_messages":
        return this.listMessages(parameters, auth);
      case "read_attachment":
        return this.readAttachment(parameters, auth);
      default:
        throw new Error(`gmail_unsupported_action_${action}`);
    }
  }

  private async readInbox(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const max = Number(parameters["max"] ?? 15);
    const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=newer_than:2d`, { headers: auth });
    if (!list.ok) throw new Error(`gmail_error_${list.status}`);
    const ids = (((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? []).slice(0, max);
    const messages: JsonValue[] = [];
    for (const { id } of ids) {
      const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
      if (!m.ok) continue;
      const msg = (await m.json()) as { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const h = (name: string) => msg.payload?.headers?.find((x) => x.name === name)?.value ?? "";
      messages.push({
        id: msg.id, thread: msg.threadId, from: h("From"), subject: h("Subject"),
        at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : h("Date"),
        unanswered: String(msg.labelIds?.includes("UNREAD") ?? false),
        important: String(msg.labelIds?.includes("IMPORTANT") ?? false),
        account: this.accountEmail
      });
    }
    return { data: { messages } };
  }

  /**
   * UA-2 P1B-A §2: FULL meldingslisting (i motsetning til `read_inbox` sin
   * `format=metadata` - kun headere) - henter `format=full` PER melding for å
   * finne MIME-vedleggsdelene (`attachmentId`/filnavn/mime/størrelse), i
   * tillegg til body-tekst (`text/plain`-delen, når tilstede). Paginering
   * skjer INNENFOR denne ene handlingen (samme mønster som Drive sin
   * `list_files` → `KnowledgeSource.list()`-aggregering) - kalleren (
   * `EmailAttachmentKnowledgeSource`) MÅ selv styre `max`/tidsvindu, ingen
   * ubegrenset full-postkasse-skann her.
   */
  private async listMessages(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const max = Number(parameters["max"] ?? 15);
    const query = parameters["query"] ? String(parameters["query"]) : "newer_than:14d";
    const list = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
      { headers: auth }
    );
    if (!list.ok) throw new Error(`gmail_error_${list.status}`);
    const ids = (((await list.json()) as { messages?: Array<{ id: string }> }).messages ?? []).slice(0, max);
    const messages: JsonValue[] = [];
    for (const { id } of ids) {
      const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth });
      if (!m.ok) continue;
      const msg = (await m.json()) as {
        id: string; threadId: string; internalDate?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          mimeType?: string; body?: { data?: string };
          parts?: Array<{ mimeType?: string; body?: { data?: string; attachmentId?: string; size?: number }; filename?: string; parts?: unknown[] }>;
        };
      };
      const h = (name: string) => msg.payload?.headers?.find((x) => x.name === name)?.value ?? "";
      const bodyData = findBodyTextPart(msg.payload as GmailMimePart | undefined);
      const bodyText = bodyData ? Buffer.from(base64UrlToStandard(bodyData), "base64").toString("utf8") : "";
      const attachments = collectAttachmentParts(msg.payload as GmailMimePart | undefined);
      messages.push({
        id: msg.id, thread: msg.threadId, from: h("From"), to: h("To"), cc: h("Cc"), subject: h("Subject"),
        at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : h("Date"),
        body_text: bodyText,
        attachments: attachments as unknown as JsonValue,
        account: this.accountEmail
      });
    }
    return { data: { messages } };
  }

  /** UA-2 P1B-A §2: last ned RÅ vedleggsbytes (standard base64) for ETT vedlegg - aldri hele meldingen på nytt. */
  private async readAttachment(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const messageId = String(parameters["message_id"]);
    const attachmentId = String(parameters["attachment_id"]);
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: auth }
    );
    if (response.status === 404) throw new Error(`gmail_attachment_not_found_${attachmentId}`);
    if (!response.ok) throw new Error(`gmail_error_${response.status}`);
    const body = (await response.json()) as { size?: number; data?: string };
    return {
      data: {
        content_base64: body.data ? base64UrlToStandard(body.data) : "",
        size_bytes: body.size ?? 0
      }
    };
  }
}

export class GoogleCalendarTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    switch (action) {
      case "read_events":
        return this.readEvents(parameters, credential);
      case "list_events":
        return this.listEvents(parameters, credential);
      default:
        throw new Error(`calendar_unsupported_action_${action}`);
    }
  }

  private async readEvents(parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(String(parameters["from"]))}&timeMax=${encodeURIComponent(String(parameters["to"]))}&maxResults=25`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`calendar_error_${response.status}`);
    const body = (await response.json()) as { items?: Array<{ id: string; summary?: string; description?: string; location?: string; hangoutLink?: string; attendees?: unknown[]; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string } }> };
    const events: JsonValue[] = (body.items ?? []).map((e) => ({
      id: e.id, title: e.summary ?? "(uten tittel)",
      start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? "",
      location: e.location ?? e.hangoutLink ?? "",
      attendees: String((e.attendees ?? []).length),
      needs_prep: String(Boolean(e.description && e.description.length > 40)),
      account: this.accountEmail
    }));
    return { data: { events } };
  }

  /**
   * UA-3 business-event-linkage: struktur-fokusert listing (i motsetning til
   * `read_events` sin persondagsbrief-egnede form - kun antall deltakere) -
   * eksponerer FAKTISKE deltaker-e-poster + en stabil `html_link` (Google sin
   * egen kalenderlenke) slik at Business OS kan gjøre deterministisk kontakt-
   * gjenkjenning (§9 i byggeordren) og peke tidslinjen til KILDEN, aldri en
   * kopi. Bevisst INGEN `description` her (§15/DPIA: aldri kopier fullt
   * møteinnhold inn i en egen tabell) - kun strukturelle felt samme klasse
   * som `read_events` allerede eksponerer (tittel/tid/sted), pluss identitet.
   */
  private async listEvents(parameters: Record<string, JsonValue>, credential: string) {
    const token = await googleAccessToken(credential);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(String(parameters["from"]))}&timeMax=${encodeURIComponent(String(parameters["to"]))}&maxResults=${Number(parameters["max"] ?? 25)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`calendar_error_${response.status}`);
    const body = (await response.json()) as {
      items?: Array<{
        id: string; summary?: string; location?: string; htmlLink?: string;
        organizer?: { email?: string }; attendees?: Array<{ email?: string; resource?: boolean }>;
        start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
      }>;
    };
    const events: JsonValue[] = (body.items ?? []).map((e) => ({
      id: e.id, title: e.summary ?? "(uten tittel)",
      start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location ?? "",
      html_link: e.htmlLink ?? "",
      organizer: e.organizer?.email ?? "",
      attendees: (e.attendees ?? []).filter((a) => !a.resource && a.email).map((a) => String(a.email)) as unknown as JsonValue,
      account: this.accountEmail
    }));
    return { data: { events } };
  }
}

/**
 * UA-2 P1A §18/§24 (utvidet - Drive full read/write, se OWNER CONNECTOR
 * CAPABILITY INVARIANT i CLAUDE.md): Google Drive med FULL funksjonell
 * tilgang - les, skriv, omdøp, flytt, papirkurv, permanent slett, dele/
 * tilgangsstyring. OAuth-scope for produksjon MÅ være
 * `https://www.googleapis.com/auth/drive` (bekreftet mot Google sitt
 * offisielle discovery-dokument for Drive API v3 - `drive.file` dekker KUN
 * filer appen selv har opprettet, ikke "alle filer", og er derfor
 * UTILSTREKKELIG for faktisk full tilgang). Samme kontomønster som Gmail/
 * Calendar (én eksplisitt konto, ingen implisitt cross-account fallback),
 * samme `googleAccessToken()` OAuth-vei (ingen ny credential-type).
 *
 * Innhold er fortsatt begrenset til TEKST (samme P1A-scope-grense som
 * ingestion-siden - §14 "Bygges IKKE": ingen binær/OCR-oppretting/-oppdatering).
 * `create_file`/`update_content` skriver derfor kun tekstlig innhold.
 *
 * Handlinger (les):
 * - `list_files`: én SIDE av en listing (§`folder_id` styrer scope, ALDRI en
 *   default). `trashed=false` alltid med - en slettet fil forsvinner naturlig
 *   fra neste vellykkede listing (tombstone-mekanismen i `KnowledgeSyncService`).
 * - `read_document`: Google Docs → text/plain-eksport; tekstlige MIME-typer
 *   leses rått; alt annet kaster `drive_unsupported_content_<mime>`.
 * - `get_metadata`: id/name/parents/trashed/headRevisionId/modifiedTime -
 *   brukes som preflight/konflikt-sjekk FØR mutasjon (se under).
 * - `read_permissions`: lister delinger på en fil.
 *
 * Handlinger (skriv, kapabilitetsklasse C - reversible): `create_file`,
 * `create_folder`, `update_content`, `rename`, `move`, `trash`.
 * `update_content`/`rename`/`move`/`trash` godtar en VALGFRI
 * `expected_head_revision_id` - hvis oppgitt, leses filens FAKTISKE
 * `headRevisionId` FØRST og sammenlignes; ved mismatch kastes en typet
 * `drive_conflict_stale_version`-feil FØR noen mutasjon forsøkes (§7 i
 * scope-endringen: rapporter konflikt som typet feil, ALDRI som stille
 * suksess som overskriver en nyere endring).
 *
 * Handlinger (destruktive/sikkerhetskritiske, kapabilitetsklasse D):
 * `delete_permanent` (Drive sin `files.delete` er PERMANENT - flytter IKKE
 * til papirkurv, bekreftet mot API-dokumentasjonen), `create_permission`/
 * `update_permission`/`delete_permission` (deling/tilgangsstyring).
 */
const GOOGLE_DOC_EXPORT_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const DRIVE_SUPPORTED_RAW_MIME = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv",
  "application/json", "text/html", "text/css", "application/x-yaml", "text/yaml"
]);

function isDriveSupportedRawMime(mimeType: string): boolean {
  return DRIVE_SUPPORTED_RAW_MIME.has(mimeType) || mimeType.startsWith("text/");
}

interface DriveMetadata {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  parents: string[];
  headRevisionId: string | null;
  modifiedTime: string | null;
}

export class GoogleDriveTransport implements ToolTransport {
  constructor(readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com") {}

  /** Felles status→typet-feil-mapping - IDENTISK klassifisering på tvers av alle Drive-endepunkt. */
  private async assertOk(response: Response, notFoundId?: string): Promise<void> {
    if (response.status === 404) throw new Error(`drive_not_found_${notFoundId ?? "unknown"}`);
    if (response.status === 401 || response.status === 403) throw new Error(`drive_auth_error_${response.status}`);
    if (response.status === 429) throw new Error("drive_rate_limited");
    if (!response.ok) throw new Error(`drive_error_${response.status}`);
  }

  private async getMetadata(fileId: string, auth: Record<string, string>): Promise<DriveMetadata> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("fields", "id,name,mimeType,trashed,parents,headRevisionId,modifiedTime");
    const response = await fetch(url, { headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as Partial<DriveMetadata>;
    return {
      id: body.id ?? fileId, name: body.name ?? "", mimeType: body.mimeType ?? "",
      trashed: body.trashed ?? false, parents: body.parents ?? [],
      headRevisionId: body.headRevisionId ?? null, modifiedTime: body.modifiedTime ?? null
    };
  }

  /** §7 (scope-endring): FØR en mutasjon som godtar `expected_head_revision_id` - fail-closed konfliktsjekk, ALDRI en stille overskriving. */
  private async assertNotStale(fileId: string, parameters: Record<string, JsonValue>, auth: Record<string, string>): Promise<void> {
    const expected = parameters["expected_head_revision_id"];
    if (expected === undefined) return; // ingen precondition oppgitt - kalleren har bevisst ikke bedt om en
    const current = await this.getMetadata(fileId, auth);
    if (current.headRevisionId !== String(expected)) {
      throw new Error(`drive_conflict_stale_version_${fileId}`);
    }
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const token = await googleAccessToken(credential);
    const auth = { authorization: `Bearer ${token}` };

    switch (action) {
      case "list_files":
        return this.listFiles(parameters, auth);
      case "read_document":
        return this.readDocument(parameters, auth);
      case "get_metadata": {
        const meta = await this.getMetadata(String(parameters["file_id"]), auth);
        return { data: { ...meta, parents: meta.parents } as unknown as Record<string, JsonValue> };
      }
      case "read_permissions":
        return this.readPermissions(parameters, auth);
      case "create_file":
        return this.createFile(parameters, auth, false);
      case "create_folder":
        return this.createFile(parameters, auth, true);
      case "update_content":
        return this.updateContent(parameters, auth);
      case "rename":
        return this.rename(parameters, auth);
      case "move":
        return this.move(parameters, auth);
      case "trash":
        return this.setTrashed(parameters, auth, true);
      case "delete_permanent":
        return this.deletePermanent(parameters, auth);
      case "create_permission":
        return this.createPermission(parameters, auth);
      case "update_permission":
        return this.updatePermission(parameters, auth);
      case "delete_permission":
        return this.deletePermission(parameters, auth);
      default:
        throw new Error(`drive_unsupported_action_${action}`);
    }
  }

  private async listFiles(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const folderId = parameters["folder_id"] ? String(parameters["folder_id"]) : undefined;
    const pageToken = parameters["page_token"] ? String(parameters["page_token"]) : undefined;
    const q = folderId ? `'${folderId}' in parents and trashed=false` : "trashed=false";
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("spaces", "drive");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; size?: string }>;
    };
    return {
      data: {
        files: (body.files ?? []).map((f) => ({
          id: f.id, name: f.name, mime_type: f.mimeType,
          modified_at: f.modifiedTime ?? null, size_bytes: f.size ?? null
        })),
        next_page_token: body.nextPageToken ?? null
      }
    };
  }

  private async readDocument(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const documentId = String(parameters["document_id"]);
    const mimeType = String(parameters["mime_type"] ?? "");
    if (mimeType === GOOGLE_DOC_EXPORT_MIME) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${documentId}/export?mimeType=text%2Fplain`,
        { headers: auth }
      );
      await this.assertOk(response, documentId);
      return { data: { content: await response.text(), content_type: "text/plain" } };
    }
    if (mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX) || !isDriveSupportedRawMime(mimeType)) {
      // Sheets/Slides/Forms/binærformater/bilder/PDF - eksplisitt utenfor P1A-scope (§14).
      throw new Error(`drive_unsupported_content_${mimeType || "unknown"}`);
    }
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}?alt=media`, { headers: auth });
    await this.assertOk(response, documentId);
    return { data: { content: await response.text(), content_type: mimeType } };
  }

  private async readPermissions(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`);
    url.searchParams.set("fields", "permissions(id,type,role,emailAddress,domain)");
    const response = await fetch(url, { headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { permissions?: Array<{ id: string; type: string; role: string; emailAddress?: string; domain?: string }> };
    return { data: { permissions: (body.permissions ?? []) as unknown as JsonValue } };
  }

  /**
   * Enkel multipart-opplasting (metadata + tekstlig innhold i én request) -
   * SAMME mønster Google sin egen "simple/multipart upload"-dokumentasjon
   * beskriver for tekstbasert innhold. Ingen binær-/resumable-opplasting
   * (utenfor P1A-scope).
   */
  private async createFile(parameters: Record<string, JsonValue>, auth: Record<string, string>, isFolder: boolean) {
    const name = String(parameters["name"]);
    const parentFolderId = parameters["parent_folder_id"] ? String(parameters["parent_folder_id"]) : undefined;
    const content = isFolder ? undefined : (parameters["content"] !== undefined ? String(parameters["content"]) : "");
    const mimeType = isFolder ? GOOGLE_FOLDER_MIME : String(parameters["mime_type"] ?? "text/plain");
    const metadata: Record<string, JsonValue> = { name, mimeType, ...(parentFolderId ? { parents: [parentFolderId] } : {}) };

    if (isFolder) {
      const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(metadata)
      });
      await this.assertOk(response);
      const body = (await response.json()) as { id: string; name: string };
      return { external_id: body.id, data: { id: body.id, name: body.name } };
    }

    const boundary = `jarvis-drive-boundary-${Date.now()}`;
    const multipartBody =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,headRevisionId", {
      method: "POST",
      headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
      body: multipartBody
    });
    await this.assertOk(response);
    const body = (await response.json()) as { id: string; name: string; headRevisionId?: string };
    return { external_id: body.id, data: { id: body.id, name: body.name, head_revision_id: body.headRevisionId ?? null } };
  }

  private async updateContent(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const content = String(parameters["content"] ?? "");
    const mimeType = String(parameters["mime_type"] ?? "text/plain");
    const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,headRevisionId`, {
      method: "PATCH",
      headers: { ...auth, "content-type": mimeType },
      body: content
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; headRevisionId?: string };
    return { external_id: body.id, data: { id: body.id, name: body.name, head_revision_id: body.headRevisionId ?? null } };
  }

  private async rename(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const newName = String(parameters["new_name"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string };
    return { external_id: body.id, data: { id: body.id, name: body.name } };
  }

  private async move(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const newParentId = String(parameters["new_parent_folder_id"]);
    const meta = await this.getMetadata(fileId, auth);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("addParents", newParentId);
    if (meta.parents.length > 0) url.searchParams.set("removeParents", meta.parents.join(","));
    url.searchParams.set("fields", "id,name,parents");
    const response = await fetch(url, { method: "PATCH", headers: auth });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; parents?: string[] };
    return { external_id: body.id, data: { id: body.id, name: body.name, parents: (body.parents ?? []) as unknown as JsonValue } };
  }

  private async setTrashed(parameters: Record<string, JsonValue>, auth: Record<string, string>, trashed: boolean) {
    const fileId = String(parameters["file_id"]);
    await this.assertNotStale(fileId, parameters, auth);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,trashed`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ trashed })
    });
    await this.assertOk(response, fileId);
    const body = (await response.json()) as { id: string; name: string; trashed: boolean };
    return { external_id: body.id, data: { id: body.id, name: body.name, trashed: String(body.trashed) } };
  }

  /** `files.delete` er PERMANENT (bekreftet mot Drive API v3-dokumentasjonen) - flytter IKKE til papirkurv. */
  private async deletePermanent(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE", headers: auth });
    if (response.status === 404) {
      // Allerede borte - idempotent utfall for en retry, ikke en feil.
      return { external_id: fileId, data: { id: fileId, already_deleted: "true" } };
    }
    await this.assertOk(response, fileId);
    return { external_id: fileId, data: { id: fileId, already_deleted: "false" } };
  }

  private async createPermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const role = String(parameters["role"]);
    const type = String(parameters["type"]);
    const body: Record<string, JsonValue> = { role, type };
    if (parameters["email_address"] !== undefined) body["emailAddress"] = String(parameters["email_address"]);
    if (parameters["domain"] !== undefined) body["domain"] = String(parameters["domain"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=id,type,role`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    await this.assertOk(response, fileId);
    const created = (await response.json()) as { id: string; type: string; role: string };
    return { external_id: created.id, data: { id: created.id, type: created.type, role: created.role } };
  }

  private async updatePermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const permissionId = String(parameters["permission_id"]);
    const role = String(parameters["role"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}?fields=id,role`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ role })
    });
    await this.assertOk(response, `${fileId}:${permissionId}`);
    const body = (await response.json()) as { id: string; role: string };
    return { external_id: body.id, data: { id: body.id, role: body.role } };
  }

  private async deletePermission(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const fileId = String(parameters["file_id"]);
    const permissionId = String(parameters["permission_id"]);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}`, {
      method: "DELETE", headers: auth
    });
    if (response.status === 404) {
      return { external_id: permissionId, data: { id: permissionId, already_deleted: "true" } };
    }
    await this.assertOk(response, `${fileId}:${permissionId}`);
    return { external_id: permissionId, data: { id: permissionId, already_deleted: "false" } };
  }
}

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16): de tre env-variablene
 * `googleAccessToken()` faktisk KREVER for et ekte Drive-kall
 * (`JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` lest direkte der, `JARVIS_GOOGLE_
 * TOKEN` sendt inn av ToolGateway som `credential` via `SecretProvider`).
 * `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er BEVISST IKKE sjekket her - den er en
 * ren bokføringsmarkør for `google-drive-reauth.ts` sin egen
 * gjenopptakelseslogikk, aldri lest av selve runtime-transporten. Leser
 * KUN tilstedeværelse (`Boolean`) - ALDRI selve verdiene; ingen credential
 * logges/returneres/eksponeres her.
 */
export function googleDriveCredentialsConfigured(): boolean {
  return Boolean(
    process.env["JARVIS_GOOGLE_CLIENT_ID"] && process.env["JARVIS_GOOGLE_CLIENT_SECRET"] && process.env["JARVIS_GOOGLE_TOKEN"]
  );
}

/**
 * Delt fabrikk-fragment - api/main.ts og worker-main.ts kaller BEGGE denne
 * SAMME funksjonen (spredd inn i `firstWaveTools({...})`) i stedet for å
 * duplisere credential-sjekken to steder - garanterer at api og worker
 * ALDRI kan divergere i om Drive-verktøyene er registrert. I motsetning
 * til de andre første-bølge-transportene (email/calendar/github/telegram,
 * som ALLTID konstrueres uansett credential-tilstand og lar selve
 * HTTP-kallet feile ved manglende credential) holdes Drive sin FULLE
 * D-klasse-kapabilitet (permanent sletting, deling/tilgangsstyring)
 * eksplisitt tilbake fra registrering til den koherente credential-
 * tripletten faktisk finnes - en bevisst strengere, men IKKE en parallell,
 * registreringsvei (samme `firstWaveTools()`/`ToolGateway.register()` som
 * alt annet). Mangler credentials: returnerer et tomt objekt - `drive`-
 * nøkkelen er da fraværende og `firstWaveTools()` sin egen
 * `UnconfiguredHttpTransport("drive")`-fallback brukes i stedet (samme
 * eksisterende, allerede idempotente skall-oppførsel som FØR denne
 * closeout-rundes - INGEN oppstartskrasj, INGEN ny feilbane).
 */
export function driveTransportsIfConfigured(): Partial<Record<string, ToolTransport>> {
  return googleDriveCredentialsConfigured() ? { drive: new GoogleDriveTransport() } : {};
}

export class TelegramTransport implements ToolTransport {
  constructor(private readonly chatId: string | undefined = process.env["JARVIS_TELEGRAM_CHAT_ID"]) {}
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    if (!this.chatId) throw new Error("telegram_chat_id_not_configured");
    const response = await fetch(`https://api.telegram.org/bot${credential}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: String(parameters["message"]) })
    });
    if (!response.ok) throw new Error(`telegram_error_${response.status}`);
    const body = (await response.json()) as { result?: { message_id?: number } };
    return { external_id: String(body.result?.message_id ?? "sent") };
  }
}

export class GithubTransport implements ToolTransport {
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const auth = { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json", "user-agent": "jarvis" };
    if (action === "read_issues") {
      const response = await fetch(`https://api.github.com/repos/${String(parameters["repo"])}/issues?state=open&per_page=20`, { headers: auth });
      if (!response.ok) throw new Error(`github_error_${response.status}`);
      const items = (await response.json()) as Array<{ number: number; title: string; updated_at: string; pull_request?: unknown }>;
      return { data: { issues: items.map((i) => ({ id: String(i.number), title: i.title, at: i.updated_at, is_pr: String(Boolean(i.pull_request)), ci_failing: "false" })) } };
    }
    // UA-2 P0 §3: repo-metadata for kunnskaps-ingestion - samme PAT/scope som
    // read_issues (ingen ny credential-type), ett ekstra read-only GET-kall.
    if (action === "read_repo_meta") {
      const response = await fetch(`https://api.github.com/repos/${String(parameters["repo"])}`, { headers: auth });
      if (!response.ok) throw new Error(`github_error_${response.status}`);
      const repo = (await response.json()) as { full_name: string; description: string | null; updated_at: string; default_branch: string };
      return {
        data: {
          full_name: repo.full_name,
          description: repo.description ?? "",
          updated_at: repo.updated_at,
          default_branch: repo.default_branch
        }
      };
    }
    throw new Error(`github_unsupported_action_${action}`);
  }
}

/**
 * UA-3 Support/Tickets (D-64): Zendesk-connector - full les/skriv/slett/admin-
 * kapabilitet der Zendesk faktisk tilbyr det (Owner Connector Capability
 * Invariant, D-41) - IKKE read-only fordi det er enklere. OAuth 2.0 (autorisasjons-
 * kode-flyt) er PRIMÆR autentiseringsmekanisme fra dag én (§5 i byggeordren) -
 * `credential` (fra SecretProvider via `JARVIS_ZENDESK_REFRESH_TOKEN`) er en
 * OAuth refresh-token, SAMME rolle som Google sin `credential`-parameter
 * (`googleAccessToken()` over).
 *
 * TOKEN-ROTASJON (§7 i byggeordren - genuin arkitekturbegrensning, IKKE en
 * uteglemt detalj): `docker-compose.yml` sin `env_file: [".env"]` seeder KUN
 * `process.env` ved container-OPPSTART - api/worker-containere har INGEN
 * skrivbar tilgang til vertens `.env`-fil (ingen bind-mount), og selv om de
 * hadde det ville en fil-omskriving IKKE hot-reloadet en allerede kjørende
 * prosess sin `process.env`. Denne transporten holder derfor rotert
 * access/refresh-token-tilstand KUN i minnet, på selve instansen (satt fra
 * `credential`-parameteren FØRSTE gang, deretter selvstyrt) - korrekt og trygt
 * for prosessens levetid (ALDRI et ugyldig gjenbrukt refresh-token, §7), men
 * en rotasjon overlever IKKE en prosess-restart. Dette er en eksplisitt
 * DEFERRED arkitekturbegrensning (D-41: dokumentert, aldri stille utelatt) -
 * gjenoppretting skjer identisk til Google sin `EMAIL_REAUTH_REQUIRED`-UX: en
 * `zendesk_oauth_refresh_required`-feil ber Tobias kjøre
 * `zendesk-reauth.ts` på nytt, som skriver et FERSKT par til `.env` på verten.
 *
 * Sikkerhetsdesign for webhook-mottak (§23/§29): selve webhook-KROPPEN
 * brukes ALDRI direkte til å skrive Business OS-data - kun som en
 * "våkne opp og hent på nytt"-utløser (ticket-ID). Normalisering skjer
 * UTELUKKENDE via denne transportens EGNE `get_ticket()`-kall gjennom
 * ToolGateway (samme mønster som periodisk synk) - selv om signatur-
 * verifiseringen skulle svikte, når aldri utro/utenforstående webhook-
 * feltinnhold frem til `business_activities`/`zendesk_tickets`.
 */
export interface ZendeskAuthErrorDetails {
  httpStatus: number;
  zendeskError: string | undefined;
  zendeskErrorDescription: string | undefined;
  errorClass: "ZENDESK_OAUTH_REFRESH_REQUIRED" | "ZENDESK_OAUTH_CLIENT_INVALID" | "ZENDESK_OAUTH_UNKNOWN";
}

interface ZendeskTokenErrorBody {
  error?: string;
  error_description?: string;
}

/** Samme presedens som `classifyGoogleTokenEndpointError()` - KUN for selve token-endepunktet, aldri kaster. */
export function classifyZendeskTokenEndpointError(httpStatus: number, rawBody: string): ZendeskAuthErrorDetails {
  let parsed: ZendeskTokenErrorBody = {};
  try {
    parsed = JSON.parse(rawBody) as ZendeskTokenErrorBody;
  } catch {
    // Ikke-JSON-kropp - fortsett med tomt objekt, fortsatt en trygg klassifisering under.
  }
  const zendeskError = parsed.error;
  const zendeskErrorDescription = parsed.error_description?.slice(0, 300);
  let errorClass: ZendeskAuthErrorDetails["errorClass"];
  if (zendeskError === "invalid_grant") errorClass = "ZENDESK_OAUTH_REFRESH_REQUIRED";
  else if (zendeskError === "invalid_client" || zendeskError === "unauthorized_client") errorClass = "ZENDESK_OAUTH_CLIENT_INVALID";
  else errorClass = "ZENDESK_OAUTH_UNKNOWN";
  return { httpStatus, zendeskError, zendeskErrorDescription, errorClass };
}

interface ZendeskTokenState {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
}

const ZENDESK_D_CLASS_ACTIONS = new Set(["delete_ticket", "redact_ticket_content", "create_webhook", "update_webhook", "delete_webhook"]);

export class ZendeskTransport implements ToolTransport {
  /** §7: rotert token-tilstand - KUN i minnet, se toppkommentaren for hvorfor. */
  private tokenState: ZendeskTokenState | undefined;

  constructor(
    private readonly subdomain: string = process.env["JARVIS_ZENDESK_SUBDOMAIN"] ?? "",
    private readonly agentEmail: string = process.env["JARVIS_ZENDESK_AGENT_EMAIL"] ?? ""
  ) {}

  private baseUrl(): string {
    return `https://${this.subdomain}.zendesk.com/api/v2`;
  }

  /** §26: Zendesk sin `Retry-After`-header respekteres med ETT bounded retry-forsøk - aldri en ukontrollert løkke. */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = Math.min(Number(retryAfterHeader ?? "1") * 1000 || 1000, 10_000);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return fetch(url, init);
  }

  /** §7: bytter refresh-token mot et ferskt access-token. Oppdaterer `this.tokenState` atomisk (i minnet) hvis Zendesk roterer refresh-tokenet i samme svar. */
  private async accessToken(seedRefreshToken: string): Promise<string> {
    this.tokenState ??= { accessToken: "", accessTokenExpiresAt: 0, refreshToken: seedRefreshToken };
    if (this.tokenState.accessToken && Date.now() < this.tokenState.accessTokenExpiresAt) {
      return this.tokenState.accessToken;
    }
    const clientId = process.env["JARVIS_ZENDESK_CLIENT_ID"];
    const clientSecret = process.env["JARVIS_ZENDESK_CLIENT_SECRET"];
    if (!clientId || !clientSecret || !this.subdomain) throw new Error("zendesk_oauth_client_not_configured");
    const response = await fetch(`https://${this.subdomain}.zendesk.com/oauth/tokens`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: this.tokenState.refreshToken,
        client_id: clientId, client_secret: clientSecret
      })
    });
    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const details = classifyZendeskTokenEndpointError(response.status, rawBody);
      // §7/§27 i byggeordren: `oauth_refresh_required` er et distinkt, gjenkjennbart
      // marker-navn (Tobias skal kjøre `zendesk-reauth.ts` på nytt) - de øvrige
      // klassene forblir detaljerte (status+klasse) for feilsøking, samme presedens
      // som `google_auth_failed_<status>:<class>`.
      throw new Error(
        details.errorClass === "ZENDESK_OAUTH_REFRESH_REQUIRED"
          ? "zendesk_oauth_refresh_required"
          : `zendesk_oauth_failed_${response.status}:${details.errorClass}`
      );
    }
    const body = (await response.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    // §7: atomisk oppdatering - hvis Zendesk sendte et NYTT refresh-token (rotasjon), bruk
    // det for ALLE fremtidige kall i denne prosessens levetid; ellers behold det gjeldende.
    this.tokenState = {
      accessToken: body.access_token,
      accessTokenExpiresAt: Date.now() + Math.max((body.expires_in ?? 1_800) - 60, 60) * 1000,
      refreshToken: body.refresh_token ?? this.tokenState.refreshToken
    };
    return this.tokenState.accessToken;
  }

  /** Felles status->typet-feil-mapping - samme presedens som Drive sin `assertOk()`. */
  private async assertOk(response: Response, notFoundId?: string): Promise<void> {
    if (response.status === 404) throw new Error(`zendesk_not_found_${notFoundId ?? "unknown"}`);
    if (response.status === 401) throw new Error("zendesk_unauthorized");
    if (response.status === 403) throw new Error("zendesk_forbidden");
    if (response.status === 429) throw new Error("zendesk_rate_limited");
    if (!response.ok) throw new Error(`zendesk_error_${response.status}`);
  }

  ticketUrl(ticketId: string): string {
    return `https://${this.subdomain}.zendesk.com/agent/tickets/${ticketId}`;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!this.subdomain) throw new Error("zendesk_subdomain_not_configured");
    const token = await this.accessToken(credential);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    switch (action) {
      case "list_tickets": return this.listTickets(parameters, auth);
      case "get_ticket": return this.getTicket(parameters, auth);
      case "search_tickets": return this.search(parameters, auth, "ticket");
      case "get_ticket_audits": return this.getTicketAudits(parameters, auth);
      case "get_user": return this.getUser(parameters, auth);
      case "search_users": return this.search(parameters, auth, "user");
      case "get_organization": return this.getOrganization(parameters, auth);
      case "search_organizations": return this.search(parameters, auth, "organization");
      case "list_groups": return this.listSimple("/groups.json", "groups", auth);
      case "list_agents": return this.listAgents(auth);
      case "list_webhooks": return this.listWebhooks(auth);
      case "create_ticket": return this.createTicket(parameters, auth);
      case "update_ticket": return this.updateTicket(parameters, auth);
      case "add_internal_note": return this.addComment(parameters, auth, false);
      case "reply_ticket": return this.addComment(parameters, auth, true);
      case "delete_ticket": return this.deleteTicket(parameters, auth);
      case "redact_ticket_content": return this.redactContent(parameters, auth);
      case "create_webhook": return this.createWebhook(parameters, auth);
      case "update_webhook": return this.updateWebhook(parameters, auth);
      case "delete_webhook": return this.deleteWebhook(parameters, auth);
      default:
        throw new Error(`zendesk_unsupported_action_${action}`);
    }
  }

  /**
   * Forenklet v1-synk (dokumentert avgrensning, IKKE stille utelatt - se D-64
   * kapabilitetsaudit): standard listing + side-lastede requester-e-poster
   * (`include=users,organizations`) i stedet for Zendesk sitt eget
   * cursor-baserte Incremental Export-endepunkt (som krever persistert
   * per-tenant cursor-state - en fremtidig optimalisering hvis volum krever
   * det, se Q-25). `updated_since` er en enkel klient-side ISO-tidsfiltrering
   * via `sort_by=updated_at`.
   */
  private async listTickets(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const max = Math.min(Number(parameters["max"] ?? 25), 100);
    const url = new URL(`${this.baseUrl()}/tickets.json`);
    url.searchParams.set("sort_by", "updated_at");
    url.searchParams.set("sort_order", "desc");
    url.searchParams.set("include", "users,organizations");
    url.searchParams.set("per_page", String(max));
    const response = await this.fetchWithRetry(url.toString(), { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as {
      tickets?: Array<{ id: number; subject: string; status: string; priority: string | null; assignee_id: number | null; requester_id: number; organization_id: number | null; created_at: string; updated_at: string }>;
      users?: Array<{ id: number; email: string | null }>;
      organizations?: Array<{ id: number; name: string }>;
    };
    const updatedSince = parameters["updated_since"] ? new Date(String(parameters["updated_since"])) : undefined;
    const userEmailById = new Map((body.users ?? []).map((u) => [u.id, u.email ?? null] as const));
    const tickets = (body.tickets ?? [])
      .filter((t) => !updatedSince || new Date(t.updated_at) > updatedSince)
      .map((t) => ({
        id: String(t.id), subject: t.subject, status: t.status, priority: t.priority ?? "",
        assignee_id: t.assignee_id !== null ? String(t.assignee_id) : "",
        requester_id: String(t.requester_id),
        requester_email: userEmailById.get(t.requester_id) ?? "",
        organization_id: t.organization_id !== null ? String(t.organization_id) : "",
        created_at: t.created_at, updated_at: t.updated_at,
        url: this.ticketUrl(String(t.id))
      }));
    return { data: { tickets: tickets as unknown as JsonValue } };
  }

  private async getTicket(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const ticketId = String(parameters["ticket_id"]);
    const url = new URL(`${this.baseUrl()}/tickets/${ticketId}.json`);
    url.searchParams.set("include", "users,organizations");
    const response = await this.fetchWithRetry(url.toString(), { headers: auth });
    await this.assertOk(response, ticketId);
    const body = (await response.json()) as {
      ticket: { id: number; subject: string; status: string; priority: string | null; assignee_id: number | null; requester_id: number; organization_id: number | null; created_at: string; updated_at: string; tags: string[] };
      users?: Array<{ id: number; email: string | null; name: string }>;
      organizations?: Array<{ id: number; name: string }>;
    };
    const t = body.ticket;
    const requester = (body.users ?? []).find((u) => u.id === t.requester_id);
    const organization = t.organization_id !== null ? (body.organizations ?? []).find((o) => o.id === t.organization_id) : undefined;
    return {
      external_id: String(t.id),
      data: {
        id: String(t.id), subject: t.subject, status: t.status, priority: t.priority ?? "",
        assignee_id: t.assignee_id !== null ? String(t.assignee_id) : "",
        requester_id: String(t.requester_id), requester_email: requester?.email ?? "",
        organization_id: t.organization_id !== null ? String(t.organization_id) : "", organization_name: organization?.name ?? "",
        tags: t.tags as unknown as JsonValue, created_at: t.created_at, updated_at: t.updated_at,
        url: this.ticketUrl(String(t.id))
      }
    };
  }

  private async getTicketAudits(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const ticketId = String(parameters["ticket_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets/${ticketId}/audits.json`, { headers: auth });
    await this.assertOk(response, ticketId);
    const body = (await response.json()) as { audits?: Array<{ id: number; created_at: string; author_id: number; events: Array<{ type: string; field_name?: string; value?: unknown }> }> };
    const audits = (body.audits ?? []).map((a) => ({
      id: String(a.id), created_at: a.created_at, author_id: String(a.author_id),
      event_types: a.events.map((e) => e.field_name ? `${e.type}:${e.field_name}` : e.type) as unknown as JsonValue
    }));
    return { data: { audits: audits as unknown as JsonValue } };
  }

  private async getUser(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const userId = String(parameters["user_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/users/${userId}.json`, { headers: auth });
    await this.assertOk(response, userId);
    const body = (await response.json()) as { user: { id: number; name: string; email: string | null; role: string; organization_id: number | null } };
    return {
      external_id: String(body.user.id),
      data: {
        id: String(body.user.id), name: body.user.name, email: body.user.email ?? "",
        role: body.user.role, organization_id: body.user.organization_id !== null ? String(body.user.organization_id) : ""
      }
    };
  }

  private async getOrganization(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const orgId = String(parameters["organization_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/organizations/${orgId}.json`, { headers: auth });
    await this.assertOk(response, orgId);
    const body = (await response.json()) as { organization: { id: number; name: string; domain_names?: string[] } };
    return {
      external_id: String(body.organization.id),
      data: { id: String(body.organization.id), name: body.organization.name, domain_names: (body.organization.domain_names ?? []) as unknown as JsonValue }
    };
  }

  private async search(parameters: Record<string, JsonValue>, auth: Record<string, string>, type: "ticket" | "user" | "organization") {
    const query = String(parameters["query"] ?? "");
    const url = new URL(`${this.baseUrl()}/search.json`);
    url.searchParams.set("query", `type:${type} ${query}`.trim());
    const response = await this.fetchWithRetry(url.toString(), { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as { results?: Array<Record<string, JsonValue>> };
    return { data: { results: (body.results ?? []) as unknown as JsonValue } };
  }

  private async listSimple(path: string, key: string, auth: Record<string, string>) {
    const response = await this.fetchWithRetry(`${this.baseUrl()}${path}`, { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as Record<string, unknown>;
    return { data: { [key]: (body[key] ?? []) as unknown as JsonValue } };
  }

  /** Zendesk har ingen dedikert "agents"-liste - agenter er `users` med `role IN (agent, admin)`. */
  private async listAgents(auth: Record<string, string>) {
    const url = new URL(`${this.baseUrl()}/users.json`);
    url.searchParams.set("role[]", "agent");
    const response = await this.fetchWithRetry(url.toString(), { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as { users?: Array<{ id: number; name: string; email: string | null }> };
    return { data: { agents: (body.users ?? []).map((u) => ({ id: String(u.id), name: u.name, email: u.email ?? "" })) as unknown as JsonValue } };
  }

  private async listWebhooks(auth: Record<string, string>) {
    const response = await this.fetchWithRetry(`${this.baseUrl()}/webhooks`, { headers: auth });
    await this.assertOk(response);
    const body = (await response.json()) as { webhooks?: Array<{ id: string; name: string; endpoint: string; status: string }> };
    return { data: { webhooks: (body.webhooks ?? []) as unknown as JsonValue } };
  }

  /**
   * §12/§21: aldri kopier fullt kundekommunikasjonsinnhold inn i Business OS -
   * `description` sendes videre til Zendesk (nødvendig for selve ticket-
   * opprettelsen), men returverdien til kalleren inneholder KUN metadata
   * (§9 i byggeordren: Business OS lagrer aldri fritekst fra denne verdien).
   */
  private async createTicket(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const payload: Record<string, JsonValue> = {
      ticket: {
        subject: String(parameters["subject"]),
        comment: { body: String(parameters["description"] ?? parameters["subject"]) },
        ...(parameters["requester_email"] !== undefined ? { requester: { email: String(parameters["requester_email"]) } } : {}),
        ...(parameters["priority"] !== undefined ? { priority: String(parameters["priority"]) } : {}),
        ...(parameters["tags"] !== undefined ? { tags: parameters["tags"] } : {})
      }
    };
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets.json`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
    await this.assertOk(response);
    const body = (await response.json()) as { ticket: { id: number; subject: string; status: string } };
    return { external_id: String(body.ticket.id), data: { id: String(body.ticket.id), subject: body.ticket.subject, status: body.ticket.status, url: this.ticketUrl(String(body.ticket.id)) } };
  }

  /** Konsolidert typet oppdatering (status/priority/assignee/tags/custom_fields) - IKKE separate mikro-handlinger (§15 i byggeordren). */
  private async updateTicket(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const ticketId = String(parameters["ticket_id"]);
    const ticket: Record<string, JsonValue> = {};
    if (parameters["status"] !== undefined) ticket["status"] = parameters["status"];
    if (parameters["priority"] !== undefined) ticket["priority"] = parameters["priority"];
    if (parameters["assignee_id"] !== undefined) ticket["assignee_id"] = Number(parameters["assignee_id"]);
    if (parameters["tags"] !== undefined) ticket["tags"] = parameters["tags"];
    if (parameters["custom_fields"] !== undefined) ticket["custom_fields"] = parameters["custom_fields"];
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets/${ticketId}.json`, {
      method: "PUT", headers: auth, body: JSON.stringify({ ticket })
    });
    await this.assertOk(response, ticketId);
    const body = (await response.json()) as { ticket: { id: number; status: string; priority: string | null; updated_at: string } };
    return { external_id: String(body.ticket.id), data: { id: String(body.ticket.id), status: body.ticket.status, priority: body.ticket.priority ?? "", updated_at: body.ticket.updated_at } };
  }

  /** `public: true` = kundesynlig svar (klasse C); `public: false` = intern note (klasse B) - se `ZENDESK_D_CLASS_ACTIONS`/integrations.ts for risikoklassifisering. */
  private async addComment(parameters: Record<string, JsonValue>, auth: Record<string, string>, isPublic: boolean) {
    const ticketId = String(parameters["ticket_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets/${ticketId}.json`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ ticket: { comment: { body: String(parameters["body"]), public: isPublic } } })
    });
    await this.assertOk(response, ticketId);
    const body = (await response.json()) as { ticket: { id: number; updated_at: string } };
    return { external_id: String(body.ticket.id), data: { id: String(body.ticket.id), updated_at: body.ticket.updated_at, public: String(isPublic) } };
  }

  /** Myk sletting (30-dagers gjenopprettingsvindu hos Zendesk selv) - likevel klasse D (§13 i byggeordren: kundedata-sensitiv). */
  private async deleteTicket(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const ticketId = String(parameters["ticket_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets/${ticketId}.json`, { method: "DELETE", headers: auth });
    if (response.status === 404) return { external_id: ticketId, data: { id: ticketId, already_deleted: "true" } };
    await this.assertOk(response, ticketId);
    return { external_id: ticketId, data: { id: ticketId, already_deleted: "false" } };
  }

  /** Permanent, ugjenkallelig overskriving av kommentarinnhold - bekreftet mot Zendesk sin dokumentasjon (§13). */
  private async redactContent(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const ticketId = String(parameters["ticket_id"]);
    const commentId = String(parameters["comment_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/tickets/${ticketId}/comments/${commentId}/redact.json`, {
      method: "PUT", headers: auth, body: JSON.stringify({ text: String(parameters["text"] ?? "") })
    });
    await this.assertOk(response, `${ticketId}:${commentId}`);
    return { external_id: `${ticketId}:${commentId}`, data: { ticket_id: ticketId, comment_id: commentId, redacted: "true" } };
  }

  /** Config-as-code (§14 i byggeordren): Jarvis sin EGEN webhook-registrering hos Zendesk - den ene admin-kapabiliteten med et konkret bruksbehov denne sliceen. */
  private async createWebhook(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const payload = {
      webhook: {
        name: String(parameters["name"]), endpoint: String(parameters["endpoint"]),
        http_method: "POST", request_format: "json", status: "active",
        subscriptions: (parameters["subscriptions"] as string[] | undefined) ?? ["conditional_ticket_events"]
      }
    };
    const response = await this.fetchWithRetry(`${this.baseUrl()}/webhooks`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
    await this.assertOk(response);
    const body = (await response.json()) as { webhook: { id: string; name: string; endpoint: string } };
    return { external_id: body.webhook.id, data: { id: body.webhook.id, name: body.webhook.name, endpoint: body.webhook.endpoint } };
  }

  private async updateWebhook(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const webhookId = String(parameters["webhook_id"]);
    const webhook: Record<string, JsonValue> = {};
    if (parameters["status"] !== undefined) webhook["status"] = parameters["status"];
    if (parameters["endpoint"] !== undefined) webhook["endpoint"] = parameters["endpoint"];
    const response = await this.fetchWithRetry(`${this.baseUrl()}/webhooks/${webhookId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ webhook }) });
    await this.assertOk(response, webhookId);
    const body = (await response.json()) as { webhook: { id: string; status: string } };
    return { external_id: body.webhook.id, data: { id: body.webhook.id, status: body.webhook.status } };
  }

  private async deleteWebhook(parameters: Record<string, JsonValue>, auth: Record<string, string>) {
    const webhookId = String(parameters["webhook_id"]);
    const response = await this.fetchWithRetry(`${this.baseUrl()}/webhooks/${webhookId}`, { method: "DELETE", headers: auth });
    if (response.status === 404) return { external_id: webhookId, data: { id: webhookId, already_deleted: "true" } };
    await this.assertOk(response, webhookId);
    return { external_id: webhookId, data: { id: webhookId, already_deleted: "false" } };
  }
}

/** §40 i byggeordren: hvorvidt Zendesk-connectoren har det den trenger for et ekte kall (subdomain + OAuth-klient + refresh-token) - ALDRI selve verdiene. */
export function zendeskCredentialsConfigured(): boolean {
  return Boolean(
    process.env["JARVIS_ZENDESK_SUBDOMAIN"] && process.env["JARVIS_ZENDESK_CLIENT_ID"] &&
    process.env["JARVIS_ZENDESK_CLIENT_SECRET"] && process.env["JARVIS_ZENDESK_REFRESH_TOKEN"]
  );
}

export { ZENDESK_D_CLASS_ACTIONS };

/**
 * Telegram-kommandopolling: /brief og /status via getUpdates (long-poll).
 * Svar leveres via Tool Gateway (policy/audit) - aldri direkte fetch tilbake.
 */
export class TelegramCommandPoller {
  private offset = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly token: string,
    private readonly ownerChatId: string,
    private readonly handlers: { brief(): Promise<string>; status(): Promise<string>; ai?(): Promise<string> },
    private readonly send: (text: string) => Promise<void>
  ) {}

  start(intervalMs = 4000): void {
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=0`);
    if (!response.ok) return;
    const body = (await response.json()) as { result?: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
    for (const update of body.result ?? []) {
      this.offset = update.update_id + 1;
      const chat = String(update.message?.chat.id ?? "");
      if (chat !== this.ownerChatId) continue; // kun owner - ingen fremmede kommandoer
      const text = update.message?.text ?? "";
      if (text.startsWith("/brief")) await this.send(await this.handlers.brief());
      else if (text.startsWith("/status")) await this.send(await this.handlers.status());
      else if (text.startsWith("/ai") && this.handlers.ai) await this.send(await this.handlers.ai());
    }
  }
}
