import type { KeyObject } from "node:crypto";

/**
 * Hva registeret vet om en godkjenningsenhet - ALT verifikatoren trenger for å
 * binde en signatur til riktig tenant, person og rolle (JARVIS-051).
 */
export interface ApproverDevice {
  key: KeyObject;
  tenant_id: string;
  /** Personen som eier enheten. */
  person_id: string;
  /** Kun eier-rolle-enheter kan godkjenne klasse D for andre (scopede identiteter/delegater). */
  is_owner: boolean;
}

/**
 * Register over godkjenningsenheter og deres offentlige nøkler.
 *
 * REMEDIERING DEL 2 (JARVIS-050/051): oppslaget er ASYNKRONT og tenant-bundet.
 * Et register som cacher nøkler kunne fortsette å godta en revokert enhets
 * signatur til neste refresh (og en annen prosess - worker - kunne aldri se
 * revokasjonen). Implementasjonen mot databasen slår derfor opp enheten ved
 * HVER verifisering og returnerer `undefined` for en revokert enhet.
 */
export interface DeviceRegistry {
  approverFor(deviceId: string, tenantId: string): Promise<ApproverDevice | undefined>;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  private readonly devices = new Map<string, ApproverDevice>();

  /** Registrerer en godkjenningsenhet. Uten `binding` finnes ingen tenant/person - da kan den aldri verifisere en godkjenning. */
  register(
    deviceId: string,
    publicKey: KeyObject,
    binding?: { tenant_id: string; person_id: string; is_owner?: boolean }
  ): void {
    if (!binding) {
      return;
    }
    this.devices.set(deviceId, {
      key: publicKey, tenant_id: binding.tenant_id, person_id: binding.person_id, is_owner: binding.is_owner ?? true
    });
  }

  /** Test-/drifts-hjelper: revoker en enhet i minnet (samme semantikk som `devices.revoked_at`). */
  revoke(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  async approverFor(deviceId: string, tenantId: string): Promise<ApproverDevice | undefined> {
    const device = this.devices.get(deviceId);
    return device && device.tenant_id === tenantId ? device : undefined;
  }
}
