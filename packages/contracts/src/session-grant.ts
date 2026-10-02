import { z } from "zod";
import { AuthStrengthSchema, ChannelSchema, MemorySpaceSchema } from "./identity.ts";

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): TILLITSGRENSEN mellom
 * SAMTALEKONTINUITET og AUTORISASJONSBEVIS, uttrykt som en kontrakt.
 *
 * Reviewen fant at `/chat`/`/brief` brukte en rå `sessions.session_id` som
 * device-authentication. Det er strukturelt feil, ikke bare uheldig: en
 * sesjonsrad er BEVISST delt på tvers av kanaler for samme person
 * (`SessionService.resumeOrCreate()`, fase 2 akseptansekriterium 3), og
 * `last_device_id` overskrives ved hvert kanalbytte. En samtale-ID kan derfor
 * aldri bære:
 *
 *   - HVILKEN enhet som står bak DETTE kallet (en eldre klient ble
 *     re-attribuert til den sist aktive enhetens identitet etter et kanalbytte),
 *   - om enhetens nøkkel er tilbakekalt siden ID-en ble utstedt,
 *   - når autoriteten utløper,
 *   - hvilket scope (memory space) autoriteten faktisk ble gitt for,
 *   - hvilken styrke beviset hadde (en `TelegramOwnerAuthority`-sesjon er
 *     `active`, men SAMME sesjons-ID ble oppgradert til `signed`).
 *
 * `SessionGrant` bærer alt dette. Den er UTSTEDT AV SERVEREN, lagret
 * server-side (`session_grants`, migrasjon 053), avgrenset, tidsbegrenset og
 * revokerbar. `session_id` finnes fortsatt - som SAMTALEKONTINUITET, aldri som
 * autentisering: mange enheters grants kan peke på SAMME samtale uten å dele
 * autoritet.
 *
 * ALDRI et andre identitetssystem (samme disiplin som D-123 sin
 * `VoiceSessionGrant`): hvert felt kommer fra den OPPLØSTE `IdentityContext`
 * og den server-eide sesjonen, aldri fra forespørselen.
 */

/**
 * Hvor lenge et utstedt grant er gyldig. Bevisst kort og bevisst en konstant,
 * ikke en konfigverdi - samme begrunnelse som `VOICE_GRANT_TTL_MS`: en
 * «konfigurerbar tillitslevetid» er en knapp noen før eller siden skrur til
 * uendelig. Ny autorisasjon koster én signatur.
 */
export const SESSION_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Serverens vedtak, slik det leveres til klienten.
 *
 * `grant_token` er den ENESTE hemmeligheten her, og den lagres ALDRI i klartekst
 * server-side: databasen holder kun SHA-256 av den (`session_grants.grant_id`).
 * Alle øvrige felt er beskrivende - de forteller klienten hva den faktisk fikk,
 * og de gir INGEN tilgang uten tokenet.
 */
export const SessionGrantSchema = z
  .object({
    /** Bærer-bevis. Presenteres av klienten; verifiseres server-side ved HVERT kall. */
    grant_token: z.string().min(1),
    /** Absolutt utløp (epoch ms). Håndheves server-side, ikke av klienten. */
    expires_at_ms: z.number().int().positive(),
    /** SAMTALEKONTINUITET - server-eid, delt på tvers av kanaler. ALDRI et autorisasjonsbevis. */
    session_id: z.string().min(1),
    person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    /** Den BEVISTE enheten. Fast for grantets levetid - i motsetning til `sessions.last_device_id`. */
    device_id: z.string().min(1),
    /** Det AUTORISERTE scopet. En annen space krever et NYTT grant. */
    memory_space: MemorySpaceSchema,
    /** Kanalen beviset ble gitt på. */
    channel: ChannelSchema,
    auth_strength: AuthStrengthSchema
  })
  .strict();
export type SessionGrant = z.infer<typeof SessionGrantSchema>;

/**
 * Hvorfor et FRAMLAGT grant ikke ga autoritet. Verdiene speiler presist de
 * tilstandene `session_grants` + `devices` faktisk kan være i - ingen oppfunne
 * feilklasser, og ingen samle-kategori som skjuler hvilken grense som slo inn.
 */
export const SessionGrantDenialReasonSchema = z.enum([
  /** Kroppen inneholdt ikke et syntaktisk gyldig `grant_token` (eller hadde ukjente felt). */
  "grant_malformed",
  /** Ingen rad for dette tokenet. Dekker også gjettede/oppdiktede tokens. */
  "grant_not_found",
  /** `expires_at` har passert. */
  "grant_expired",
  /** `revoked_at` er satt (eier-handling eller nøkkelrotasjon). */
  "grant_revoked",
  /**
   * Enhetens nøkkel er TILBAKEKALT (`devices.public_key_pem IS NULL`) eller
   * ROTERT (annen nøkkel enn den som ble bevist da grantet ble utstedt).
   * Dette er den STRUKTURELLE garantien reviewen etterlyste: et utstedt bevis
   * slutter å virke i det øyeblikket nøkkelen bak det ikke lenger gjelder,
   * uten at noen må huske å rydde opp i grant-tabellen.
   */
  "device_authority_revoked"
]);
export type SessionGrantDenialReason = z.infer<typeof SessionGrantDenialReasonSchema>;

/**
 * Hvorfor en INNRULLERING ble avvist (D-131 funn 2). Innrullering og
 * nøkkelrotasjon er den ene handlingen som kan skape nytt nøkkelmateriale, og
 * derfor den ene som ALDRI kan autorisere seg selv med opplysninger som bare er
 * ikke-hemmelige ID-er.
 */
export const DeviceEnrollmentDenialReasonSchema = z.enum([
  /** Forespørselen validerte ikke mot `DeviceEnrollmentRequestSchema`. */
  "malformed_request",
  /** Verken et gyldig enhetsbevis eller en gyldig billett ble lagt fram. */
  "enrollment_authority_required",
  /** Det framlagte enhetsbeviset validerte ikke (ukjent/utløpt nonce, feil signatur, feil eier). */
  "authorizing_device_proof_invalid",
  /** Billetten finnes ikke, er utløpt, allerede brukt, eller gjelder en annen person/tenant/enhet. */
  "enrollment_ticket_invalid",
  /** Personen er ikke medlem av tenanten. */
  "unknown_membership",
  /** `device_id` finnes allerede, men tilhører en ANNEN person/tenant - aldri overtakelse. */
  "device_owned_by_other_principal",
  /** `public_key_pem` var ikke en gyldig offentlig nøkkel. */
  "invalid_public_key",
  /** Nøkkelen er ikke Ed25519 (eneste algoritme verifikatoren støtter) - avvises ved innrullering, ikke først ved bruk. */
  "unsupported_key_type",
  /** Enheten er TILBAKEKALT og kan aldri rulles inn igjen (JARVIS-050). */
  "device_revoked",
  /** Nøkkelen er tidligere tilbakekalt (under en annen device_id) og kan aldri gjenbrukes. */
  "key_revoked"
]);
export type DeviceEnrollmentDenialReason = z.infer<typeof DeviceEnrollmentDenialReasonSchema>;

/**
 * Enhetsbeviset som kan AUTORISERE en innrullering: en fersk challenge/respons
 * fra en enhet som ALLEREDE er innrullert på samme person i samme tenant.
 * Dekker både «legg til ny enhet fra en jeg allerede har» og «roter nøkkelen
 * på denne enheten» (en enhet kan autorisere sin egen re-nøkling).
 */
export const EnrollmentDeviceProofSchema = z
  .object({
    kind: z.literal("device_proof"),
    /** Den ALLEREDE innrullerte enheten som står inne for innrulleringen. */
    authorizing_device_id: z.string().min(1),
    challenge: z.string().min(1),
    signature: z.string().min(1)
  })
  .strict();

/**
 * Engangs-billetten fra en eksplisitt lokal eier-handling
 * (`apps/api/src/enroll-ticket-main.ts`). Den ENESTE veien inn for aller
 * FØRSTE enhet, der det per definisjon ikke finnes noen tidligere nøkkel å
 * bevise med. Ingen hardkodet bypass, ingen ny ekstern credential.
 */
export const EnrollmentTicketProofSchema = z
  .object({
    kind: z.literal("enrollment_ticket"),
    ticket: z.string().min(1)
  })
  .strict();

export const EnrollmentAuthorizationSchema = z.discriminatedUnion("kind", [
  EnrollmentDeviceProofSchema,
  EnrollmentTicketProofSchema
]);
export type EnrollmentAuthorization = z.infer<typeof EnrollmentAuthorizationSchema>;

/**
 * `.strict()` av samme grunn som `VoiceAuthorizationEvidenceSchema`: et forsøk
 * på å smugle inn f.eks. `auth_strength`, `identity` eller et ferdig grant skal
 * gi en parse-feil, ikke stille aksept.
 */
export const DeviceEnrollmentRequestSchema = z
  .object({
    tenant_id: z.string().min(1),
    person_id: z.string().min(1),
    device: z
      .object({
        device_id: z.string().min(1),
        kind: z.string().min(1),
        public_key_pem: z.string().min(1)
      })
      .strict(),
    enrollment: EnrollmentAuthorizationSchema
  })
  .strict();
export type DeviceEnrollmentRequest = z.infer<typeof DeviceEnrollmentRequestSchema>;
