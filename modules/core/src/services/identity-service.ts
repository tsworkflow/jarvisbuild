import type pg from "pg";
import {
  IdentityContextSchema,
  type AuthStrength,
  type Channel,
  type IdentityContext,
  type MemorySpace
} from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

export interface ResolveIdentityInput {
  person_id: string;
  tenant_id: string;
  memory_space: MemorySpace;
  session_id: string;
  device_id: string;
  channel: Channel;
  auth_strength: AuthStrength;
  delegation_id?: string;
}

export type IdentityDenialReason = "unknown_membership" | "unknown_device" | "unknown_memory_space";

export type ResolveResult = { ok: true; identity: IdentityContext } | { ok: false; reason: IdentityDenialReason };

/**
 * D-131 (arkitektkontroll av PR #79, funn 3): akkurat de opplysningene
 * autorisasjonen faktisk avhenger av - UTEN `session_id`.
 *
 * Reviewen fant at `ChannelSessionAuthority` opprettet/oppdaterte en sesjonsrad
 * FØR medlemskap/space ble kontrollert, fordi `resolveIdentity()` krever et
 * `session_id` og et `session_id` bare finnes ETTER `resumeOrCreate()`. Den
 * avhengigheten var kunstig: ingen av de tre DB-sjekkene under bruker
 * `session_id` til noe - det brukes kun i audit-raden og i den ferdige
 * `IdentityContext`-en. Ved å skille sjekkene ut kan hele autorisasjonen
 * gjøres FØR noen sesjons-sideeffekt i det hele tatt.
 */
export interface AuthorizationCheckInput {
  person_id: string;
  tenant_id: string;
  memory_space: MemorySpace;
  device_id: string;
}

export type AuthorizationCheckResult = { ok: true } | { ok: false; reason: IdentityDenialReason };

/**
 * Identity Service (fase 2): slår opp og VALIDERER identitetskontekst mot
 * databasen under RLS - medlemskap, enhet og memory space må finnes i riktig
 * tenant. Returnerer en kontraktvalidert IdentityContext.
 */
export class IdentityService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * DEN kanoniske person↔tenant↔enhet↔space-konjunksjonen, kjørt på en
   * EKSISTERENDE transaksjonsklient og UTEN å skrive noe som helst (heller
   * ingen audit-rad - kalleren eier audit, fordi kalleren vet om avslaget skal
   * rulles tilbake sammen med resten av transaksjonen eller ikke).
   *
   * `resolveIdentity()` under bruker NØYAKTIG denne metoden, så det finnes
   * fortsatt kun ÉN implementasjon av selve autorisasjonsregelen.
   */
  async checkAuthorizationOn(client: pg.PoolClient, input: AuthorizationCheckInput): Promise<AuthorizationCheckResult> {
    const membership = await client.query("SELECT 1 FROM person_tenants WHERE person_id = $1 AND tenant_id = $2", [
      input.person_id,
      input.tenant_id
    ]);
    if (!membership.rowCount) {
      return { ok: false, reason: "unknown_membership" };
    }

    const device = await client.query(
      "SELECT 1 FROM devices WHERE device_id = $1 AND tenant_id = $2 AND person_id = $3 AND revoked_at IS NULL",
      [input.device_id, input.tenant_id, input.person_id]
    );
    if (!device.rowCount) {
      return { ok: false, reason: "unknown_device" };
    }

    const space = await client.query("SELECT memory_space_id FROM memory_spaces WHERE tenant_id = $1 AND space = $2", [
      input.tenant_id,
      input.memory_space
    ]);
    if (!space.rows[0]) {
      return { ok: false, reason: "unknown_memory_space" };
    }

    return { ok: true };
  }

  /**
   * Bygger den kontraktvaliderte `IdentityContext`-en. Ren funksjon, ingen
   * DB-tilgang: den forutsetter at `checkAuthorizationOn()` allerede har sagt
   * ja, og finnes for at kallere som eier sin egen transaksjon skal slippe å
   * duplisere `IdentityContextSchema.parse(...)`-formen.
   */
  buildContext(input: ResolveIdentityInput): IdentityContext {
    return IdentityContextSchema.parse({
      person_id: input.person_id,
      tenant_id: input.tenant_id,
      memory_space_id: input.memory_space,
      session_id: input.session_id,
      device_id: input.device_id,
      channel: input.channel,
      auth_strength: input.auth_strength,
      ...(input.delegation_id !== undefined ? { delegation_id: input.delegation_id } : {})
    });
  }

  /**
   * D-131: skriver KUN avslags-audit-raden, i sin EGEN transaksjon.
   *
   * Brukes av kallere som kjører autorisasjonen inne i en transaksjon de
   * ruller tilbake ved avslag (så ingen sesjons-/grant-mutasjon overlever et
   * DENY) - avslaget skal likevel være revidert. Reviewen sa dette eksplisitt:
   * «Ingen grant/session-mutasjon ved avslag; sikkerhetsaudit av avslag og
   * konsum av nonce kan naturligvis beholdes.»
   */
  async recordDenial(
    subject: { tenant_id: string; person_id: string; device_id: string; session_id?: string },
    reason: string,
    type = "identity.denied"
  ): Promise<void> {
    await withTenantTransaction(this.pool, subject.tenant_id, async (client) => {
      await writeAudit(client, subject, { type, decision: "DENY", reason });
    });
  }

  async resolveIdentity(input: ResolveIdentityInput): Promise<ResolveResult> {
    return withTenantTransaction(this.pool, input.tenant_id, async (client) => {
      const auditIdentity = {
        tenant_id: input.tenant_id,
        person_id: input.person_id,
        session_id: input.session_id,
        device_id: input.device_id
      };

      const check = await this.checkAuthorizationOn(client, input);
      if (!check.ok) {
        await writeAudit(client, auditIdentity, {
          type: "identity.denied",
          decision: "DENY",
          reason: check.reason
        });
        return { ok: false, reason: check.reason } as const;
      }

      const identity = this.buildContext(input);
      await writeAudit(client, auditIdentity, { type: "identity.resolved", decision: "ALLOW" });
      return { ok: true, identity } as const;
    });
  }
}
