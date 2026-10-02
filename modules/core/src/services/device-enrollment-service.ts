import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  DeviceEnrollmentRequestSchema,
  type DeviceEnrollmentDenialReason,
  type DeviceEnrollmentRequest
} from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";
import {
  RevokedDeviceKeyError, UnsupportedDeviceKeyError, assertEd25519PublicKeyPem, type DeviceService
} from "./device-service.ts";
import type { SessionGrantService } from "./session-grant-service.ts";

/**
 * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
 * SAMME sårbarhetsklasse som i `device-authority.ts` fantes her også.
 * `verifyChallenge()` (for `device_proof`-innrulleringsveien) kjørte i sin
 * EGEN transaksjon, atskilt i tid fra selve innrulleringstransaksjonen under.
 * Roterte den AUTORISERENDE enhetens nøkkel i vinduet mellom de to, kunne et
 * bevis signert med den GAMLE nøkkelen fortsatt autorisere at en NY enhet ble
 * lagt til (eller at NØKKELEN PÅ SEG SELV ble rotert igjen) - reviewen kalte
 * dette "proof from a just-replaced key can race a new device/key mutation".
 * Lukket identisk med `device-authority.ts`: `enroll()` låser (`FOR UPDATE`)
 * og leser den autoriserende enhetens rad PÅ NYTT som sitt FØRSTE steg inne i
 * innrulleringstransaksjonen, og krever et EKSAKT fingerprint-treff mot det
 * `verifyChallenge()` faktisk beviste FØR billett-konsumering, enhetsskriving
 * eller grant-tilbakekalling.
 */

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 2): den betrodde
 * server-side INNRULLERINGS-autoriteten - den ENESTE nettverksnære veien til å
 * skrive nytt nøkkelmateriale for en enhet.
 *
 * PROBLEMET SOM LUKKES: `/devices/register` autoriserte seg selv med
 * `resolveIdentity(body.identity)`. Den funksjonen VERIFISERER EKSISTENS
 * (finnes personen i tenanten? finnes enheten? finnes space-en?), den
 * AUTENTISERER ingenting. Kombinert med `ON CONFLICT (device_id) DO UPDATE SET
 * public_key_pem = ...` betydde det at en nettverksklient som bare kjente
 * gyldige, ikke-hemmelige ID-er kunne skrive sin EGEN offentlige nøkkel inn på
 * en fremmed enhet - og deretter bestå hele challenge-/session-flyten med sin
 * egen private nøkkel. Nøkkelbeviset var sirkulært: enheten «beviste» en
 * nøkkel angriperen nettopp hadde satt. Hele PR-ens proof-of-possession-
 * sikkerhet hvilte derfor på et hull.
 *
 * REGELEN NÅ: innrullering og nøkkelrotasjon krever ETT av to eksplisitte
 * bevis - aldri ingen:
 *
 *   (a) `device_proof` - ferskt proof-of-possession fra en ALLEREDE innrullert
 *       enhet som tilhører SAMME person i SAMME tenant. Dekker både «legg til
 *       en ny enhet fra en jeg allerede har» og «roter nøkkelen på denne
 *       enheten» (en enhet kan autorisere sin egen re-nøkling). Gjenbruker
 *       PRESIS `DeviceService.verifyChallenge()` - ingen ny kryptomekanisme.
 *
 *   (b) `enrollment_ticket` - en engangs, kortlevd billett fra en EKSPLISITT
 *       lokal eier-handling (`apps/api/src/enroll-ticket-main.ts`). Dette er
 *       den ENESTE veien inn for aller FØRSTE enhet, der det per definisjon
 *       ikke finnes noen tidligere nøkkel å bevise med.
 *
 * HVORFOR BILLETT OG IKKE EN BYPASS: en «tillat første enhet fra localhost»-
 * regel ville vært en hardkodet bypass i produksjonskoden, og den ville stått
 * der lenge etter at bootstrappen var ferdig. Billetten er i stedet en DB-rad:
 * engangs (atomisk test-and-set), utløpende, bundet til tenant/person (og
 * valgfritt én `device_id`), og fullt reviderbar. Den innfører INGEN ny ekstern
 * credential - CLI-en bruker de SAMME admin-DB-credentialene migrasjonene
 * allerede kjører med (`adminConfigFromEnv`, allerede i `.env.example`).
 *
 * EIERSKAP: `DeviceService.registerDeviceOn()` har i tillegg fått en
 * eierskapsgard, slik at en `device_id` som tilhører en annen person/tenant
 * ALDRI kan overtas - heller ikke med gyldig innrullerings-autoritet for en
 * annen prinsipal.
 */
export interface DeviceEnrollmentDeps {
  pool: pg.Pool;
  devices: DeviceService;
  grants: SessionGrantService;
}

export type DeviceEnrollmentResult =
  | { ok: true; device_id: string; rotated: boolean; revoked_grants: number }
  | { ok: false; reason: DeviceEnrollmentDenialReason };

/** Kastes for avslag som først kan avgjøres inne i transaksjonen - tvinger ROLLBACK. */
class EnrollmentDenial extends Error {
  constructor(readonly reason: DeviceEnrollmentDenialReason) {
    super(`enrollment_denied: ${reason}`);
    this.name = "EnrollmentDenial";
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Databasen holder KUN hashen (`device_enrollment_tickets.ticket_id`), aldri billetten. */
export function enrollmentTicketId(ticket: string): string {
  return sha256Hex(ticket);
}

export class DeviceEnrollmentService {
  constructor(private readonly deps: DeviceEnrollmentDeps) {}

  /**
   * `raw` er UBETRODD input fra en HTTP-kropp og typet `unknown` med vilje.
   * `DeviceEnrollmentRequestSchema` er `.strict()`, så et forsøk på å smugle
   * inn `identity`, `auth_strength` eller et ferdig grant gir en parse-feil,
   * ikke stille aksept.
   *
   * Et avslag er et normalt, revidert utfall - metoden kaster aldri på avslag.
   */
  async enroll(raw: unknown, nowMs: number = Date.now()): Promise<DeviceEnrollmentResult> {
    const parsed = DeviceEnrollmentRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: "malformed_request" };
    }
    const request = parsed.data;

    // Valider nøkkelmaterialet FØR noe annet: en ugyldig PEM skal aldri komme
    // så langt som til å konsumere en billett eller en nonce.
    try {
      assertEd25519PublicKeyPem(request.device.public_key_pem);
    } catch (err) {
      // JARVIS-051: kun Ed25519 kan verifisere noe som helst - en RSA-enhet skal avvises HER,
      // ikke først som en forvirrende «ugyldig signatur» ved bruk.
      return { ok: false, reason: err instanceof UnsupportedDeviceKeyError ? "unsupported_key_type" : "invalid_public_key" };
    }

    // (a) Enhetsbeviset kjøres FØR transaksjonen, av samme grunn som i
    //     `ChannelSessionAuthority`: nonce-konsumering er tilsiktet og skal
    //     IKKE rulles tilbake ved avslag (en engangs-nonce som «kommer
    //     tilbake» ville vært et replay-hull). `verifyChallenge(..., personId)`
    //     binder beviset til den påståtte personen OG tenanten, og returnerer
    //     `null` for en autoriserende enhet uten registrert nøkkel (tilbakekalt).
    //     D-131b: fingerprinten den FAKTISK beviste besittelse over bæres
    //     videre inn i transaksjonen under, for TOCTOU-lukkingen der.
    let provenAuthorizingFingerprint: string | null = null;
    if (request.enrollment.kind === "device_proof") {
      const proven = await this.deps.devices.verifyChallenge(
        request.tenant_id,
        request.enrollment.authorizing_device_id,
        request.enrollment.challenge,
        request.enrollment.signature,
        request.person_id
      );
      if (!proven) {
        await this.auditDenial(request, "authorizing_device_proof_invalid");
        return { ok: false, reason: "authorizing_device_proof_invalid" };
      }
      provenAuthorizingFingerprint = proven;
    }

    try {
      return await withTenantTransaction(this.deps.pool, request.tenant_id, async (client) => {
        const membership = await client.query(
          "SELECT 1 FROM person_tenants WHERE person_id = $1 AND tenant_id = $2",
          [request.person_id, request.tenant_id]
        );
        if (!membership.rowCount) {
          throw new EnrollmentDenial("unknown_membership");
        }

        // D-131b TOCTOU-lukking: lås OG les den AUTORISERENDE enhetens nøkkel
        // PÅ NYTT, inne i DENNE transaksjonen, og krev et EKSAKT treff mot
        // fingerprinten `verifyChallenge()` faktisk beviste - FØR billett-
        // konsumering, enhetsskriving eller grant-tilbakekalling. En rotasjon
        // i vinduet siden beviset gir her samme avslag som om beviset aldri
        // hadde holdt.
        if (request.enrollment.kind === "device_proof") {
          const lockedKey = await this.deps.devices.lockDeviceKeyOn(client, {
            tenant_id: request.tenant_id,
            person_id: request.person_id,
            device_id: request.enrollment.authorizing_device_id
          });
          if (!lockedKey || lockedKey.fingerprint !== provenAuthorizingFingerprint) {
            throw new EnrollmentDenial("authorizing_device_proof_invalid");
          }
        }

        // (b) Billetten konsumeres ATOMISK (test-and-set i én UPDATE), aldri
        //     med en les-så-skriv-sekvens to samtidige forespørsler kunne
        //     passere samtidig.
        if (request.enrollment.kind === "enrollment_ticket") {
          const consumed = await client.query(
            `UPDATE device_enrollment_tickets
                SET consumed_at = to_timestamp($5 / 1000.0), consumed_device_id = $4
              WHERE ticket_id = $1
                AND tenant_id = $2
                AND person_id = $3
                AND consumed_at IS NULL
                AND expires_at > to_timestamp($5 / 1000.0)
                AND (device_id IS NULL OR device_id = $4)
              RETURNING ticket_id`,
            [
              enrollmentTicketId(request.enrollment.ticket),
              request.tenant_id,
              request.person_id,
              request.device.device_id,
              nowMs
            ]
          );
          if (!consumed.rowCount) {
            throw new EnrollmentDenial("enrollment_ticket_invalid");
          }
        }

        // JARVIS-050: en tilbakekalt enhet kan ALDRI rulles inn igjen - heller ikke med samme nøkkel
        // under en ny device_id. Sjekkes FØR billett-konsumering skriver noe varig (hele
        // transaksjonen rulles likevel tilbake ved avslag).
        if (await this.deps.devices.isDeviceRevokedOn(client, request.tenant_id, request.device.device_id)) {
          throw new EnrollmentDenial("device_revoked");
        }
        if (await this.deps.devices.isKeyRevokedOn(client, request.tenant_id, request.device.public_key_pem)) {
          throw new EnrollmentDenial("key_revoked");
        }

        // Rotasjon vs. førstegangs-innrullering skilles KUN for revisjon og for
        // svaret - begge krever nøyaktig samme autoritet.
        const existing = await client.query(
          "SELECT public_key_pem FROM devices WHERE device_id = $1 AND tenant_id = $2 AND person_id = $3",
          [request.device.device_id, request.tenant_id, request.person_id]
        );
        const rotated = Boolean((existing.rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem);

        let written: boolean;
        try {
          written = await this.deps.devices.registerDeviceOn(client, request, request.device);
        } catch (err) {
          if (err instanceof RevokedDeviceKeyError) throw new EnrollmentDenial("key_revoked");
          throw err;
        }
        if (!written) {
          throw new EnrollmentDenial("device_owned_by_other_principal");
        }

        // Nøkkelrotasjon dreper utestående grants for enheten. `verify()` ville
        // uansett avvist dem (fingerprint-sammenligning mot nøkkelen slik den
        // står NÅ) - dette gjør tilbakekallingen SYNLIG og reviderbar, i SAMME
        // transaksjon som rotasjonen.
        const revoked = await this.deps.grants.revokeForDeviceOn(
          client,
          request.tenant_id,
          request.device.device_id,
          nowMs
        );

        await writeAudit(
          client,
          { tenant_id: request.tenant_id, person_id: request.person_id, device_id: request.device.device_id },
          {
            type: "device.enrolled",
            decision: "ALLOW",
            payload: {
              // Hvilken autoritet som ble brukt er selve poenget å kunne revidere.
              // ALDRI billetten/hashen selv, og aldri nøkkelmaterialet.
              enrollment_method: request.enrollment.kind,
              rotated,
              revoked_grants: revoked
            }
          }
        );
        return { ok: true, device_id: request.device.device_id, rotated, revoked_grants: revoked } as const;
      });
    } catch (err) {
      if (err instanceof EnrollmentDenial) {
        // Transaksjonen er rullet tilbake: ingen billett konsumert, ingen
        // nøkkel skrevet, ingen grant rørt. Avslaget revideres i sin EGEN
        // transaksjon nettopp fordi ingenting annet overlevde.
        await this.auditDenial(request, err.reason);
        return { ok: false, reason: err.reason };
      }
      throw err;
    }
  }

  /**
   * Avslags-audit. Skrives «best effort»: tenanten kan være ukjent/ugyldig i
   * et avvist forsøk, og en feilende audit-skriving skal ikke gjøre et avslag
   * om til en 500 (som ville lekket at tenanten ikke finnes).
   */
  private async auditDenial(request: DeviceEnrollmentRequest, reason: DeviceEnrollmentDenialReason): Promise<void> {
    try {
      await withTenantTransaction(this.deps.pool, request.tenant_id, async (client) => {
        await writeAudit(
          client,
          { tenant_id: request.tenant_id, person_id: request.person_id, device_id: request.device.device_id },
          { type: "device.enrollment_denied", decision: "DENY", reason }
        );
      });
    } catch {
      // Bevisst stille: se doc-kommentaren over.
    }
  }
}

export interface CreatedEnrollmentTicket {
  /** Vises ÉN gang, på eierens egen terminal. Lagres aldri - databasen har kun SHA-256. */
  ticket: string;
  expires_at: Date;
}

/**
 * Oppretter en engangs innrullerings-billett. Kalles KUN av den lokale
 * eier-CLI-en (`apps/api/src/enroll-ticket-main.ts`) med ADMIN-poolen - altså
 * bak en eksplisitt eier-handling på Tobias sin egen maskin, ikke fra noen
 * nettverksrute. Det er nettopp derfor den er en trygg bootstrap uten
 * hardkodet bypass: autoriteten er «du har admin-tilgang til databasen og
 * kjørte kommandoen», ikke «du klarte å nå en HTTP-port».
 */
export async function createEnrollmentTicket(
  adminPool: pg.Pool,
  input: { tenant_id: string; person_id: string; device_id?: string; ttl_minutes?: number },
  nowMs: number = Date.now()
): Promise<CreatedEnrollmentTicket> {
  const ticket = `enr_${randomBytes(32).toString("base64url")}`;
  const ttlMinutes = input.ttl_minutes ?? 15;
  const expiresAtMs = nowMs + ttlMinutes * 60 * 1000;
  await adminPool.query(
    `INSERT INTO device_enrollment_tickets (ticket_id, tenant_id, person_id, device_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))`,
    [enrollmentTicketId(ticket), input.tenant_id, input.person_id, input.device_id ?? null, nowMs, expiresAtMs]
  );
  return { ticket, expires_at: new Date(expiresAtMs) };
}
