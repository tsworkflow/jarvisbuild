import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Channel } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

export interface SessionRef {
  session_id: string;
  resumed: boolean;
  last_channel: Channel;
}

export interface SessionPrincipal {
  tenant_id: string;
  person_id: string;
  device_id: string;
}

/**
 * Session Service (fase 2): samme samtale på tvers av kanaler.
 * resumeOrCreate gjenopptar personens aktive sesjon i tenanten uansett hvilken
 * kanal/enhet som spør (akseptansekriterium 3); ellers opprettes ny.
 *
 * ---
 *
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1) - HVA DENNE KLASSEN ER,
 * OG HVA DEN ALDRI ER:
 *
 * En sesjon er SAMTALEKONTINUITET. Den er BEVISST delt: samme `session_id`
 * gjenbrukes for personens kanaler, og `last_device_id`/`last_channel`
 * overskrives ved hvert kanalbytte. Nettopp derfor kan en sesjons-ID ALDRI
 * være et autentiseringsbevis - den vet ikke hvilken enhet som står bak et
 * gitt kall, om enhetens nøkkel er tilbakekalt, når autoriteten utløper eller
 * hvilket scope den ble gitt for.
 *
 * Den tidligere `getActive(tenantId, sessionId)` gjorde nøyaktig den feilen:
 * den slo opp `person_id` + den MUTABLE `last_device_id` fra en rå sesjons-ID
 * og lot `/chat`/`/brief` sette `auth_strength: "signed"` på grunnlag av det.
 * Konsekvensene reviewen påviste: en utstedt ID forble akseptert etter at
 * nøkkelen var tilbakekalt, en eldre klient ble re-attribuert til den sist
 * aktive enhetens identitet etter et kanalbytte, og en `TelegramOwnerAuthority`-
 * sesjon (`active`) ble oppgradert til `signed` av den generiske
 * oppslagsveien. Metoden er derfor FJERNET, ikke bare sluttet å bli brukt -
 * en primitiv som bare er trygg hvis alle kallere husker en usynlig regel er
 * en primitiv som før eller siden brukes feil igjen.
 *
 * Autorisasjonsbeviset ligger nå i `SessionGrantService` (`session_grants`,
 * migrasjon 053), bundet til én bevist enhet, ett scope, én kanal og et utløp.
 * Mange enheters grants kan peke på SAMME sesjon - det er slik kontinuiteten
 * på tvers av kanaler bevares UTEN å dele én enhets autoritet med en annen.
 */
export class SessionService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * D-131 funn 3: samme logikk som `resumeOrCreate()`, men på en EKSISTERENDE
   * transaksjonsklient, slik at en autoritet kan kjøre HELE autorisasjonen
   * (medlemskap/enhet/space-sjekk → sesjon → grant → audit) i ÉN transaksjon
   * og rulle ALT tilbake ved avslag. Reviewen fant at et gyldig enhetsbevis med
   * en ikke-eksisterende memory space kunne opprette/oppdatere en sesjonsrad
   * FØR avslaget kom - en ekte sideeffekt av en avvist forespørsel.
   *
   * `FOR UPDATE` beholdes uendret: to samtidige autorisasjoner for samme person
   * skal ikke kunne opprette hver sin «aktive» sesjon.
   */
  async resumeOrCreateOn(client: pg.PoolClient, principal: SessionPrincipal, channel: Channel): Promise<SessionRef> {
    // JARVIS-055: `FOR UPDATE` på NULL rader låser ingenting - to samtidige første
    // autorisasjoner så begge «ingen sesjon» og opprettet hver sin. Rådgivende lås per
    // (tenant, person) serialiserer dem, og den delvise unike indeksen
    // `sessions_one_active_per_person_idx` (migrasjon 063) er den strukturelle garantien.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `session:${principal.tenant_id}:${principal.person_id}`
    ]);
    const existing = await client.query(
      `SELECT session_id FROM sessions
         WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'
         ORDER BY last_active_at DESC LIMIT 1
         FOR UPDATE`,
      [principal.tenant_id, principal.person_id]
    );
    const row = existing.rows[0] as { session_id: string } | undefined;

    if (row) {
      await client.query(
        `UPDATE sessions
           SET last_channel = $2, last_device_id = $3, last_active_at = now()
         WHERE session_id = $1`,
        [row.session_id, channel, principal.device_id]
      );
      await writeAudit(client, { ...principal, session_id: row.session_id }, {
        type: "session.resumed",
        payload: { channel }
      });
      return { session_id: row.session_id, resumed: true, last_channel: channel };
    }

    const sessionId = `sess-${randomUUID()}`;
    await client.query(
      `INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, principal.tenant_id, principal.person_id, channel, principal.device_id]
    );
    await writeAudit(client, { ...principal, session_id: sessionId }, {
      type: "session.created",
      payload: { channel }
    });
    return { session_id: sessionId, resumed: false, last_channel: channel };
  }

  /** Uendret offentlig API for kallere som ikke eier en egen transaksjon. */
  async resumeOrCreate(principal: SessionPrincipal, channel: Channel): Promise<SessionRef> {
    return withTenantTransaction(this.pool, principal.tenant_id, (client) =>
      this.resumeOrCreateOn(client, principal, channel)
    );
  }
}
