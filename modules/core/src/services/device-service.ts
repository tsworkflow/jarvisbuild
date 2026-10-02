import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { ApproverDevice, DeviceRegistry } from "@jarvis/policy";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

/**
 * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
 * DEN ENE fingerprint-funksjonen, brukt av `DeviceService`,
 * `SessionGrantService` og `DeviceEnrollmentService`. Tidligere fantes
 * identiske `sha256Hex()`-kopier i alle tre filene - harmløst for HASHING,
 * men et upåaktet sted en fremtidig endring kunne latt dem divergere. Delt
 * her (der nøkkelen selv leses) i stedet for i en fjerde fil.
 */
export function fingerprintPem(pem: string): string {
  return createHash("sha256").update(pem, "utf8").digest("hex");
}

/**
 * JARVIS-051: eneste nøkkeltype verifikatoren faktisk kan verifisere er Ed25519. Tidligere
 * ble enhver gyldig PEM akseptert ved innrullering, og en RSA-enhet leste senere som en
 * «ugyldig signatur» - en feil som først viste seg ved bruk. Validert nå, ved innrullering.
 */
export class UnsupportedDeviceKeyError extends Error {
  constructor(readonly keyType: string | undefined) {
    super(`unsupported_key_type:${keyType ?? "unknown"}`);
    this.name = "UnsupportedDeviceKeyError";
  }
}

/** Kastes når en tidligere tilbakekalt nøkkel forsøkes rullet inn på nytt (under hvilken som helst device_id). */
export class RevokedDeviceKeyError extends Error {
  constructor() {
    super("key_revoked");
    this.name = "RevokedDeviceKeyError";
  }
}

export function assertEd25519PublicKeyPem(pem: string): KeyObject {
  const key = createPublicKey(pem); // kaster på ugyldig PEM
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new UnsupportedDeviceKeyError(key.asymmetricKeyType);
  }
  return key;
}

/**
 * Enhetsidentitet (fase 8-fundament): enheter registreres server-side med
 * offentlig nøkkel (genereres på enheten - Secure Enclave på iPhone/Watch).
 * Klient-sendt device_id alene stoles aldri på: forhøyet auth_strength og
 * klasse D-godkjenninger krever signatur fra REGISTRERT enhetsnøkkel.
 */
/** Kastes av `issueChallenge()` når antallet utestående nonces er over grensen (JARVIS-063). */
export class ChallengeLimitError extends Error {
  constructor(readonly scope: "global") {
    super(`challenge_limit_exceeded:${scope}`);
    this.name = "ChallengeLimitError";
  }
}

/** Øvre grenser for utestående (ikke-forbrukte, ikke-utløpte) nonces. Minnet er aldri ubegrenset. */
const MAX_OUTSTANDING_CHALLENGES = 5_000;
const MAX_OUTSTANDING_CHALLENGES_PER_DEVICE = 10;
const CHALLENGE_TTL_MS = 60_000;

export class DeviceService {
  private readonly challenges = new Map<string, { device_id: string; expires: number }>();

  constructor(private readonly pool: pg.Pool) {}

  /**
   * D-131 (uavhengig arkitektkontroll av PR #79, funn 2): skriver enhetsraden
   * PÅ EN EKSISTERENDE TRANSAKSJONSKLIENT, og gjør INGEN autorisasjon i det
   * hele tatt. Kalleren MÅ ha bevist innrullerings-autoritet først - se
   * `DeviceEnrollmentService`, som er den ENESTE nettverksnære veien hit.
   *
   * EIERSKAPSGARDEN (`WHERE devices.tenant_id = ... AND devices.person_id = ...`
   * på `DO UPDATE`) er ny og gjelder ALLE kallere, også betrodde: en
   * `device_id` som allerede tilhører en annen person/tenant kan ALDRI
   * overtas ved å skrive en ny `public_key_pem`. Den gamle `ON CONFLICT
   * (device_id) DO UPDATE SET public_key_pem = $5` gjorde nettopp det.
   *
   * Returnerer `false` når garden slo inn (0 rader) - kalleren avgjør om det
   * skal bli et avslag eller en feil.
   */
  async registerDeviceOn(
    client: pg.PoolClient,
    principal: { tenant_id: string; person_id: string },
    device: { device_id: string; kind: string; public_key_pem: string }
  ): Promise<boolean> {
    assertEd25519PublicKeyPem(device.public_key_pem); // valider PEM OG nøkkeltype før lagring
    if (await this.isKeyRevokedOn(client, principal.tenant_id, device.public_key_pem)) {
      throw new RevokedDeviceKeyError();
    }
    let result;
    try {
      result = await client.query(
        `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE
           SET public_key_pem = EXCLUDED.public_key_pem, kind = EXCLUDED.kind
         WHERE devices.tenant_id = EXCLUDED.tenant_id AND devices.person_id = EXCLUDED.person_id
           AND devices.revoked_at IS NULL
         RETURNING device_id`,
        [device.device_id, principal.tenant_id, principal.person_id, device.kind, device.public_key_pem]
      );
    } catch (err) {
      // En kolliderende rad i en ANNEN tenant er ikke synlig under RLS, så
      // Postgres avviser `ON CONFLICT DO UPDATE` mot den med en RLS-/unik-feil
      // i stedet for å returnere 0 rader. Begge betyr det SAMME for oss -
      // `device_id` er opptatt av en annen prinsipal - og begge må bli et
      // avslag, aldri en 500 som lekker at ID-en finnes et annet sted.
      const code = (err as { code?: string }).code;
      if (code === "42501" || code === "23505" || code === "23503") {
        return false;
      }
      throw err;
    }
    if (!result.rowCount) {
      return false;
    }
    await writeAudit(
      client,
      { tenant_id: principal.tenant_id, person_id: principal.person_id, device_id: device.device_id },
      { type: "device.registered", payload: { device_id: device.device_id, kind: device.kind } }
    );
    return true;
  }

  /**
   * BETRODD server-side seeding/provisjonering (tester, `seedOwner()`-lignende
   * oppsett). Gjør INGEN autorisasjon - navnet sier det, slik at ingen
   * fremtidig rute kobler den til nettverket ved et uhell. Nettverksveien er
   * `DeviceEnrollmentService.enroll()`, som krever eksplisitt eier-/bootstrap-
   * autoritet.
   *
   * Kaller BEVISST ikke `SessionGrantService.revokeForDeviceOn()`: den er for
   * NØKKELROTASJON på en enhet som allerede kan ha utestående grants, og den
   * hører hjemme i innrulleringsstien. Utestående grants blir uansett ugyldige
   * strukturelt, fordi `SessionGrantService.verify()` sammenligner mot
   * nøkkelens fingerprint slik den står NÅ.
   */
  async registerDeviceTrusted(
    identity: IdentityContext,
    device: { device_id: string; kind: string; public_key_pem: string }
  ): Promise<void> {
    const written = await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      this.registerDeviceOn(client, identity, device)
    );
    if (!written) {
      throw new Error(`device_owned_by_other_principal: ${device.device_id}`);
    }
  }

  /**
   * JARVIS-050: PERMANENT tilbakekalling av en enhet, på en eksisterende transaksjonsklient.
   * Raden låses (`FOR UPDATE`), nøkkelen fjernes OG fingerprinten lagres i `revoked_device_keys`
   * (samme nøkkel kan ikke rulles inn igjen under en ny device_id), og `revoked_at` settes
   * (`registerDeviceOn()` nekter å skrive en revokert rad på nytt). Returnerer `false` når enheten
   * ikke finnes i tenanten; er den allerede revokert er kallet idempotent (`true`).
   */
  async revokeDeviceKeyOn(
    client: pg.PoolClient,
    principal: { tenant_id: string; device_id: string },
    reason: string
  ): Promise<boolean> {
    const row = await client.query(
      "SELECT public_key_pem, revoked_at FROM devices WHERE device_id = $1 AND tenant_id = $2 FOR UPDATE",
      [principal.device_id, principal.tenant_id]
    );
    const device = row.rows[0] as { public_key_pem: string | null; revoked_at: Date | null } | undefined;
    if (!device) {
      return false;
    }
    if (device.revoked_at !== null) {
      return true;
    }
    const fingerprint = device.public_key_pem ? fingerprintPem(device.public_key_pem) : null;
    await client.query(
      `UPDATE devices SET revoked_at = now(), revoked_key_fingerprint = $3, revoked_reason = $4, public_key_pem = NULL
        WHERE device_id = $1 AND tenant_id = $2`,
      [principal.device_id, principal.tenant_id, fingerprint, reason]
    );
    if (fingerprint) {
      await client.query(
        `INSERT INTO revoked_device_keys (tenant_id, key_fingerprint, device_id, reason)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, key_fingerprint) DO NOTHING`,
        [principal.tenant_id, fingerprint, principal.device_id, reason]
      );
    }
    return true;
  }

  /** `true` hvis nøkkelen (fingerprint) tidligere er tilbakekalt i denne tenanten. */
  async isKeyRevokedOn(client: pg.PoolClient, tenantId: string, publicKeyPem: string): Promise<boolean> {
    const result = await client.query(
      "SELECT 1 FROM revoked_device_keys WHERE tenant_id = $1 AND key_fingerprint = $2",
      [tenantId, fingerprintPem(publicKeyPem)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** `true` hvis `device_id` finnes i tenanten og er tilbakekalt. */
  async isDeviceRevokedOn(client: pg.PoolClient, tenantId: string, deviceId: string): Promise<boolean> {
    const result = await client.query(
      "SELECT 1 FROM devices WHERE device_id = $1 AND tenant_id = $2 AND revoked_at IS NOT NULL",
      [deviceId, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Challenge-respons: klienten signerer en engangs-nonce med enhetsnøkkelen. */
  issueChallenge(deviceId: string): string {
    const now = Date.now();
    // Utløpte nonces ryddes FØR grensen sjekkes - ellers ville en rolig periode
    // etter et flom-forsøk fortsatt vært avvist.
    const mine: string[] = [];
    for (const [nonce, entry] of this.challenges) {
      if (entry.expires < now) {
        this.challenges.delete(nonce);
      } else if (entry.device_id === deviceId) {
        mine.push(nonce);
      }
    }
    // Per enhet EVIKTES den eldste i stedet for å avvise: ellers kunne en
    // uautentisert klient som kjenner en device_id låse eieren ute fra å få
    // en nonce (DoS). Map bevarer innsettingsrekkefølgen, så `mine[0]` er eldst.
    while (mine.length >= MAX_OUTSTANDING_CHALLENGES_PER_DEVICE) {
      this.challenges.delete(mine.shift() as string);
    }
    if (this.challenges.size >= MAX_OUTSTANDING_CHALLENGES) {
      throw new ChallengeLimitError("global");
    }
    const challenge = `chal-${randomUUID()}`;
    this.challenges.set(challenge, { device_id: deviceId, expires: now + CHALLENGE_TTL_MS });
    return challenge;
  }

  /**
   * Fingerprint av nøkkelen som FAKTISK verifiserte signaturen, eller `null`
   * ved avslag (auth_strength kan heves når resultatet ikke er `null`).
   *
   * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
   * denne metoden kjører i SIN EGEN transaksjon, atskilt i tid fra enhver
   * senere mutasjon (sesjon/grant/innrullering/rotasjon) som stoler på
   * resultatet. Tidligere returnerte den kun `boolean`, og kalleren utstedte
   * et bevis mot HVA ENN NØKKEL SOM STO I RADEN på et SENERE tidspunkt - roterte
   * nøkkelen i mellomtiden, kunne en forespørsel signert med den GAMLE nøkkelen
   * ende opp med et bærer-bevis fingerprintet til den NYE. Ved å returnere
   * fingerprinten av den NØYAKTIGE nøkkelen som ble brukt her, kan kalleren
   * (`authorizeProvenDevice()`/`DeviceEnrollmentService.enroll()`) låse og
   * lese raden PÅ NYTT inne i sin egen mutasjonstransaksjon og kreve et EKSAKT
   * fingerprint-treff FØR noen skriving - se de filene for resten av lukkingen.
   *
   * D-123 (Q-32 punkt 2): valgfri `personId` binder beviset til en PÅSTÅTT
   * eier. Uten den svarer metoden kun på «holder noen den private nøkkelen til
   * enhet X?», og en kaller som holder sin EGEN registrerte enhetsnøkkel kunne
   * derfor bevise enheten mens den påsto en ANNEN persons `person_id`.
   */
  async verifyChallenge(
    tenantId: string,
    deviceId: string,
    challenge: string,
    signatureB64: string,
    personId?: string
  ): Promise<string | null> {
    const pending = this.challenges.get(challenge);
    if (!pending || pending.device_id !== deviceId || pending.expires < Date.now()) {
      return null;
    }
    this.challenges.delete(challenge); // engangs - replay av challenge er umulig
    const proven = await this.publicKeyFromDb(tenantId, deviceId, personId);
    if (!proven) {
      return null;
    }
    try {
      const ok = verify(null, Buffer.from(challenge, "utf8"), proven.key, Buffer.from(signatureB64, "base64"));
      return ok ? proven.fingerprint : null;
    } catch {
      return null;
    }
  }

  /**
   * D-131b: lås OG les enhetens registrerte nøkkel PÅ NYTT, INNE I kallerens
   * egen mutasjonstransaksjon - den andre halvparten av TOCTOU-lukkingen over.
   * `FOR UPDATE` holder raden låst til transaksjonen committer eller ruller
   * tilbake, slik at en SAMTIDIG rotasjon/tilbakekalling for SAMME enhet må
   * vente til denne autorisasjonen er avgjort (og omvendt) - de kan aldri
   * interleaves. Returnerer `null` når enheten mangler nøkkel (tilbakekalt)
   * ELLER ikke tilhører den påståtte person/tenant - kalleren skiller ikke på
   * de to, av samme "aldri lekk hvorfor"-grunn som `checkAuthorizationOn()`.
   */
  async lockDeviceKeyOn(
    client: pg.PoolClient,
    principal: { tenant_id: string; person_id: string; device_id: string }
  ): Promise<{ fingerprint: string } | null> {
    const result = await client.query(
      `SELECT public_key_pem FROM devices
        WHERE device_id = $1 AND tenant_id = $2 AND person_id = $3 AND revoked_at IS NULL FOR UPDATE`,
      [principal.device_id, principal.tenant_id, principal.person_id]
    );
    const pem = (result.rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem;
    return pem ? { fingerprint: fingerprintPem(pem) } : null;
  }

  private async publicKeyFromDb(
    tenantId: string,
    deviceId: string,
    personId?: string
  ): Promise<{ key: KeyObject; fingerprint: string } | null> {
    // Tenant-RLS gjelder allerede via `withTenantTransaction`; `person_id`
    // legges på som et EKSPLISITT predikat når kalleren har oppgitt en påstått
    // eier, slik at en enhet i riktig tenant men hos feil person ikke kan
    // bevise seg. En enhet uten `public_key_pem` (tilbakekalt) gir `null`.
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      personId === undefined
        ? client.query("SELECT public_key_pem FROM devices WHERE device_id = $1 AND revoked_at IS NULL", [deviceId])
        : client.query("SELECT public_key_pem FROM devices WHERE device_id = $1 AND person_id = $2 AND revoked_at IS NULL", [
            deviceId,
            personId
          ])
    );
    const pem = (result.rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem;
    return pem ? { key: createPublicKey(pem), fingerprint: fingerprintPem(pem) } : null;
  }
}

/**
 * DB-basert enhetsregister for Policy Gateway (tenant-RLS gjelder).
 *
 * JARVIS-050/051: oppslaget gjøres MOT DATABASEN ved HVER verifisering - ingen cache. En revokert
 * enhet slutter dermed å kunne godkjenne umiddelbart, i ALLE prosesser (api og worker), uten at
 * noen må huske å kalle `refresh()`. `tenantId`-argumentet beholdes kun for bakoverkompatibilitet;
 * oppslaget er alltid bundet til tenanten i selve forespørselen (flertenant).
 */
export class PgDeviceRegistry implements DeviceRegistry {
  constructor(
    private readonly pool: pg.Pool,
    _legacyTenantId?: string
  ) {}

  /** Bakoverkompatibel no-op: det finnes ingen cache å friske opp. */
  async refresh(): Promise<void> {
    return;
  }

  async approverFor(deviceId: string, tenantId: string): Promise<ApproverDevice | undefined> {
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      client.query(
        `SELECT d.public_key_pem, d.tenant_id, d.person_id, (pt.role = 'owner') AS is_owner
           FROM devices d
           JOIN person_tenants pt ON pt.person_id = d.person_id AND pt.tenant_id = d.tenant_id
          WHERE d.device_id = $1 AND d.tenant_id = $2 AND d.revoked_at IS NULL AND d.public_key_pem IS NOT NULL`,
        [deviceId, tenantId]
      )
    );
    const row = result.rows[0] as
      | { public_key_pem: string; tenant_id: string; person_id: string; is_owner: boolean }
      | undefined;
    if (!row) {
      return undefined;
    }
    let key: KeyObject;
    try {
      key = assertEd25519PublicKeyPem(row.public_key_pem);
    } catch {
      return undefined;
    }
    return { key, tenant_id: row.tenant_id, person_id: row.person_id, is_owner: row.is_owner };
  }
}

/** Push-varsling bak adapter. APNs krever Apple-miljø - skallet er UVERIFISERT. */
export interface PushAdapter {
  readonly name: string;
  send(deviceId: string, title: string, body: string): Promise<void>;
}

export class FakePushAdapter implements PushAdapter {
  readonly name = "fake-push";
  readonly sent: Array<{ deviceId: string; title: string; body: string }> = [];
  async send(deviceId: string, title: string, body: string): Promise<void> {
    this.sent.push({ deviceId, title, body });
  }
}

export class ApnsPushAdapter implements PushAdapter {
  readonly name = "apns";
  async send(): Promise<void> {
    throw new Error("apns_unverified: krever Apple-utviklerkonto og p8-noekkel (fase 8-klientmiljoe)");
  }
}
