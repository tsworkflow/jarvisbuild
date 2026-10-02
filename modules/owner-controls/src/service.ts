import type pg from "pg";
import { writeAudit, withTenantTransaction, type DeviceService, type SessionGrantService } from "@jarvis/core";
import { assertOwnerControlAuthorized, type KillSwitch, type OwnerControlAuthority, type OwnerControls } from "@jarvis/policy";
import { DeviceNotFoundError, type DeviceRevocationResult, type FrozenConnectorEntry, type OwnerControlState, type RevokedCredentialEntry } from "./types.ts";

/**
 * D-174 (B2): device-tilbakekallings-avhengighetene er BEVISST valgfrie
 * (samme mønster som `OwnerControls`/`KillSwitch` sitt eget valgfrie
 * `pool`/`authority`-par) - `k1-owner-control-authority-live.ts`-skriptet
 * og eksisterende enhetstester konstruerer `OwnerControlsService` UTEN
 * device-avhengigheter og skal fortsette å virke uendret; `revoke_device`
 * feiler LUKKET (`owner_controls_device_revocation_not_configured`), ALDRI
 * et stille no-op, når de ikke er koblet til (kun `apps/api/src/main.ts`
 * kobler dem til i dag - se der).
 */
export interface OwnerControlsDeviceRevocationDeps {
  pool: pg.Pool;
  grants: SessionGrantService;
  /**
   * JARVIS-050: tilbakekalling er PERMANENT - enheten markeres `revoked_at`, nøkkelen fjernes og
   * fingerprinten lagres, i tillegg til at grants fjernes. Uten dette ble nøkkelen stående
   * innrullert og kunne hente et nytt grant umiddelbart.
   */
  devices: DeviceService;
  authority?: OwnerControlAuthority;
}

/**
 * K1 (Sovereign graduation, D-164): kanonisk owner-kontroll-tjeneste.
 * Konstruktøren tar de EKSISTERENDE `KillSwitch`/`OwnerControls`-
 * instansene direkte (SAMME instanser `apps/api/src/main.ts`/
 * `worker-main.ts` allerede konstruerer for `PolicyGateway`/`ToolGateway`)
 * - IKKE en egen, parallell kopi av tilstanden. Alle mutasjoner går via
 * `*Durable()` (aldri de rene synkrone metodene) - autoritets-sjekken
 * (`assertOwnerControlAuthorized`) skjer INNI disse metodene selv, mot
 * `actorPersonId` denne tjenesten ALLTID videresender uendret fra den
 * betrodde `ToolInvocationContext.identity.person_id` (D-68-disiplinen,
 * se transport.ts).
 */
export class OwnerControlsService {
  constructor(
    private readonly killSwitch: KillSwitch,
    private readonly ownerControls: OwnerControls,
    private readonly deviceRevocation?: OwnerControlsDeviceRevocationDeps
  ) {}

  async getControlState(): Promise<OwnerControlState> {
    const [killSwitchRow, frozen, revoked] = await Promise.all([
      this.killSwitch.currentStateDurable(),
      this.ownerControls.listFrozenConnectorsDurable(),
      this.ownerControls.listRevokedCredentialsDurable()
    ]);
    return {
      kill_switch: {
        active: killSwitchRow !== null,
        reason: killSwitchRow?.reason ?? null,
        actor_person_id: killSwitchRow?.actor_person_id ?? null,
        changed_at: killSwitchRow?.changed_at ?? null
      },
      frozen_connectors: frozen as FrozenConnectorEntry[],
      revoked_credentials: revoked as RevokedCredentialEntry[]
    };
  }

  async activateKillSwitch(reason: string, actorPersonId: string): Promise<void> {
    await this.killSwitch.activateDurable(reason, actorPersonId);
  }

  async deactivateKillSwitch(actorPersonId: string): Promise<void> {
    await this.killSwitch.deactivateDurable(actorPersonId);
  }

  async freezeConnector(connectorId: string, reason: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.freezeConnectorDurable(connectorId, reason, actorPersonId);
  }

  async unfreezeConnector(connectorId: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.unfreezeConnectorDurable(connectorId, actorPersonId);
  }

  async revokeCredential(credentialRef: string, reason: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.revokeCredentialDurable(credentialRef, reason, actorPersonId);
  }

  async restoreCredential(credentialRef: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.restoreCredentialDurable(credentialRef, actorPersonId);
  }

  /**
   * D-174 (B2, task F): eier-vendt tilbakekalling av ALLE utestående
   * `session_grants` for ÉN enhet - SAMME kanoniske primitiv
   * (`SessionGrantService.revokeForDeviceOn()`) og kalle-mønster (transaksjon
   * + audit i SAMME transaksjon) som `DeviceEnrollmentService` allerede
   * bruker ved nøkkelrotasjon (device-enrollment-service.ts). INGEN
   * duplikat session-grant-tilstand her - denne metoden er en tynn,
   * autoritets-sjekket ToolGateway-vendt innpakning rundt DEN samme
   * `session_grants`-tabellen.
   *
   * Fail-CLOSED for: (a) manglende device-avhengigheter (ikke koblet til -
   * se `OwnerControlsDeviceRevocationDeps`), (b) `actorPersonId` som ikke
   * matcher konfigurert `authority.owner_person_id`
   * (`assertOwnerControlAuthorized` - SAMME eier-autoritetsmodell som
   * `KillSwitch`/`OwnerControls` sine egne `*Durable()`-metoder, IKKE en ny
   * eller svakere sjekk), (c) `deviceId` som IKKE finnes i `tenantId`
   * (`DeviceNotFoundError` - se D-175).
   *
   * D-175 (arkitekt-review 5250409538, BLOKKER B4 - RETTER D-174): `tenantId`
   * MÅ være den BETRODDE `identity.tenant_id` (transporten sin jobb, se
   * transport.ts), ALDRI et fritt kaller-oppgitt parameter - D-174 sin
   * opprinnelige begrunnelse ("eieren må kunne tilbakekalle en ANNEN persons
   * enhet, derfor er BÅDE tenant OG device frie mål-parametre") forvekslet
   * "annen PERSON, samme tenant" med "annen TENANT" - kun den FØRSTE er en
   * reell, tiltenkt bruksstøtte (en delegat sin enhet I EIEREN SIN EGEN
   * tenant); den ANDRE ville gjort selve TENANTEN til et fritt mål-parameter
   * for en `session_grants`-tabell som ER RLS-avgrenset per tenant - en reell
   * isolasjonsgrense `credential_ref`/`connector_id` (GLOBALE, tenant-frie
   * ressurser, se `owner_control_state`) aldri hadde. Autoritetsmodellen er
   * derfor NÅ: KALLER må være konfigurert eier; MÅL-TENANT er ALLTID
   * `identity.tenant_id`; MÅL-ENHET kan tilhøre en ANNEN person, men MÅ
   * eksistere i DENNE tenanten (ellers `DeviceNotFoundError`, aldri et stille
   * `revoked_grants: 0`-"success" for en enhet i en annen tenant).
   */
  async revokeDevice(tenantId: string, deviceId: string, reason: string, actorPersonId: string): Promise<DeviceRevocationResult> {
    if (!this.deviceRevocation) throw new Error("owner_controls_device_revocation_not_configured");
    const { pool, grants, devices, authority } = this.deviceRevocation;
    assertOwnerControlAuthorized(pool, authority, actorPersonId);
    return withTenantTransaction(pool, tenantId, async (client) => {
      // RLS (migrasjon 005) begrenser `devices` til `jarvis.tenant_id` (satt
      // av `withTenantTransaction` over) - en enhet som hører til EN ANNEN
      // tenant er derfor STRUKTURELT usynlig her, ikke bare filtrert av
      // `WHERE`-leddet under (som likevel beholdes, defense-in-depth).
      const { rows } = await client.query(`SELECT 1 FROM devices WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId]);
      if (rows.length === 0) throw new DeviceNotFoundError(deviceId);
      // JARVIS-050: permanent - nøkkelen kan ikke autorisere på nytt og kan ikke rulles inn igjen.
      await devices.revokeDeviceKeyOn(client, { tenant_id: tenantId, device_id: deviceId }, reason);
      const revokedGrants = await grants.revokeForDeviceOn(client, tenantId, deviceId);
      await writeAudit(
        client,
        { tenant_id: tenantId, person_id: actorPersonId, device_id: deviceId },
        {
          type: "owner_controls.device_revoked",
          decision: "ALLOW",
          reason,
          payload: { revoked_grants: revokedGrants }
        }
      );
      return { tenant_id: tenantId, device_id: deviceId, revoked_grants: revokedGrants };
    });
  }
}
