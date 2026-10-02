// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { OwnerConfig } from "@jarvis/contracts";

/**
 * Owner-seed (BO-08 + D-30 live-funn): identitetsdata for fersk database,
 * idempotent (ON CONFLICT DO NOTHING). ID-ene er konfig - aldri hardkodet i
 * domenelogikk (D-34-prinsippet). Ingen secrets.
 *
 * D-30: voice-gatewayen identifiserer seg med egen device (`jarvis-voice-live`
 * som default, konfigurerbar via JARVIS_VOICE_DEVICE_ID). Uten seed ga /chat
 * 403 identity_denied/unknown_device på host-live - derfor seedes den her,
 * i samme transaksjonsfrie idempotente stil som jarvis-core.
 *
 * `dev-web` er `apps/web/index.html`s dev-chat-demo sin enhet.
 *
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 2): raden seedes fortsatt,
 * men den er ikke lenger noen forutsetning for innrullering -
 * `DeviceEnrollmentService` oppretter raden selv når en gyldig eier-billett
 * legges fram. Ingen av de seedede radene har `public_key_pem`, og det er
 * hele poenget: en seedet enhet UTEN nøkkel kan ikke bevise noe som helst, og
 * kan derfor ikke gi noen autoritet. Nøkkelen kommer først når eieren faktisk
 * innrullerer enheten med et eksplisitt bevis (`pnpm --filter @jarvis/api
 * enroll-ticket`, eller proof-of-possession fra en allerede innrullert enhet).
 * Seeden er altså identitets-/medlemskapsdata, ALDRI en tillitsgrense.
 */
export async function seedOwner(pool: pg.Pool, owner: OwnerConfig): Promise<void> {
  // Remediering del 2 (JARVIS-065): eier-identiteten kommer fra validert konfig (`loadOwnerConfig`) - ingen defaults.
  const tenant = owner.tenant_id;
  const person = owner.owner_person_id;
  const name = owner.owner_display_name;
  const voiceDevice = process.env["JARVIS_VOICE_DEVICE_ID"] ?? "jarvis-voice-live";
  await pool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ($1,$2,'person') ON CONFLICT DO NOTHING", [tenant, name]);
  await pool.query("INSERT INTO people (person_id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, name]);
  await pool.query("INSERT INTO person_tenants (person_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, tenant]);
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ('jarvis-core',$1,$2,'service') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ($1,$2,$3,'voice') ON CONFLICT DO NOTHING",
    [voiceDevice, tenant, person]
  );
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ('dev-web',$1,$2,'web') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO memory_spaces (memory_space_id,tenant_id,space) VALUES ('personal',$1,'personal') ON CONFLICT DO NOTHING",
    [tenant]
  );
}
