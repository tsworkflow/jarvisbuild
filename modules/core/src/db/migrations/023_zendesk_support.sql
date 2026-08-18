-- UA-3 Support/tickets (Zendesk, D-64): Zendesk-tilknyttet CURRENT STATE for
-- tickets - IKKE en kopi av Zendesk sin egen historikk (Zendesk Ticket Audits
-- forblir autoritativ, hentes on-demand via zendesk.get_ticket_audits, ALDRI
-- speilet inn her). Denne tabellen finnes KUN for aa gi OpenLoopService et
-- deterministisk grunnlag ("trenger denne ticketen svar naa?") - samme rolle
-- business_leads/business_opportunities spiller for sine egne open-loop-
-- regler. Faktiske hendelser (opprettet/oppdatert) gaar som vanlig inn i
-- EKSISTERENDE business_activities (source_type='zendesk') - INGEN ny
-- tidslinje-tabell, samme mønster som Gmail/Calendar (D-57).
--
-- Samme FORCE RLS tenant+memory_space-RESTRICTIVE-mønster som
-- business_open_loops (020)/business_scores (022) - se D-62 sin lærdom:
-- withMemoryTransaction (ALDRI withTenantTransaction alene) for enhver
-- akseptanse-/service-spørring mot denne tabellen.
--
-- Pointer-not-payload (§9/§15 i byggeordren): subject er en KORT, sikker
-- operasjonell beskrivelse (Zendesk sin egen emnelinje) - ALDRI
-- kommentar-/samtaleinnhold. canonical_uri peker TILBAKE til Zendesk sin egen
-- agent-URL, aldri en kopi.
--
-- "Trenger svar naa"-deteksjon (§20 i byggeordren) bruker UTELUKKENDE
-- `status` (Zendesk sin egen, dokumenterte statussemantikk: 'new'/'open' =
-- venter paa agent-oppfoelging, 'pending' = Zendesk selv anser ballen hos
-- KUNDEN, 'hold'/'solved'/'closed' = ikke aktiv) - IKKE en utledet
-- "siste kunde-/agent-aktivitet"-tidsstempel, som ville krevd aa hente
-- kommentarnivaa per ticket (N+1 API-kall) og dermed vaert en gjettet, ikke
-- en faktisk observert, verdi. Se OpenLoopService.detectSupportTicketsNeedingReply().

CREATE TABLE zendesk_tickets (
  ticket_id               text PRIMARY KEY,
  tenant_id               text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id         text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id              text REFERENCES business_companies (company_id),
  contact_id              text REFERENCES business_contacts (contact_id),
  -- Zendesk sitt eget instans-/kontoidentifikator (subdomain) + ticket-ID -
  -- SAMME (tenant_id, provider_instance_id, external_ticket_id)-idempotens-
  -- mønster som business_activities/business_leads sin (tenant_id,
  -- source_type, source_instance_id, external_id)-triplett.
  provider_instance_id    text NOT NULL,
  external_ticket_id      text NOT NULL,
  subject                 text NOT NULL,
  status                  text NOT NULL CHECK (status IN ('new','open','pending','hold','solved','closed')),
  priority                text CHECK (priority IN ('low','normal','high','urgent')),
  assignee_external_id    text,
  requester_external_id   text,
  canonical_uri           text NOT NULL,
  created_at_provider     timestamptz,
  updated_at_provider     timestamptz,
  synced_at               timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_instance_id, external_ticket_id)
);
CREATE INDEX zendesk_tickets_needs_reply_idx ON zendesk_tickets (tenant_id, memory_space_id, status);
CREATE INDEX zendesk_tickets_company_idx ON zendesk_tickets (tenant_id, company_id);

GRANT SELECT, INSERT, UPDATE ON zendesk_tickets TO jarvis_app;

ALTER TABLE zendesk_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE zendesk_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY zendesk_tickets_tenant ON zendesk_tickets
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY zendesk_tickets_space ON zendesk_tickets AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- business_open_loops.loop_type sin CHECK-begrensning maa utvides for den nye
-- 'support_ticket_needs_reply'-regelen (§20 i byggeordren: gjenbruk
-- OpenLoopService, ALDRI en ny open-loop-mekanisme). Postgres krever
-- DROP+ADD for aa endre en eksisterende CHECK - additiv, ingen datatap
-- (eksisterende rader har uansett kun 'overdue_followup'/'stalled_opportunity').
ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check
  CHECK (loop_type IN ('overdue_followup', 'stalled_opportunity', 'support_ticket_needs_reply'));

-- D-64 NY OPPDAGELSE (funnet under bygging av denne sliceen sitt eget
-- periodiske sikkerhetsnett, §25 i byggeordren - IKKE noe ordren selv ba om
-- aa fikse, men noedvendig for at Zendesk sin EGEN periodiske synk faktisk
-- skal fungere): `tenants` har FORCE ROW LEVEL SECURITY med policy
-- `tenant_id = current_setting('jarvis.tenant_id', true)` (005_rls.sql).
-- `runBusinessEventSyncForAllTenants()` (business-event-sync.ts, D-57),
-- `runOpenLoopSweepForAllTenants()` (open-loop-sweep.ts, D-53) og
-- `runScoringSweepForAllTenants()` (scoring-sweep.ts, D-61) spoerrer ALLE
-- `tenants` via en RAA, uskopet `pool.query(...)` - UTEN `jarvis.tenant_id`
-- satt evaluerer policyen NULL for HVER rad, og FORCE RLS blokkerer
-- STRUKTURELT samtlige rader, uansett faktisk tenant-data. Ingen eksisterende
-- test bevsier disse tre funksjonene mot en ekte RLS-Postgres (kun
-- `runOpenLoopSweepForAllTenants` har EN test, og den bruker en `fakePool()`
-- som helt omgaar RLS) - host-akseptansen kaller alltid `syncTenant()`/
-- `runSweep()` DIREKTE per tenant, aldri gjennom disse "for alle tenants"-
-- innpakningene. Dette betyr disse tre funksjonene sannsynligvis ALDRI har
-- funnet en eneste tenant naar `DailyScheduler` faktisk trigger dem i
-- produksjon - en reell, tidligere ikke oppdaget regresjon fra D-53/D-57/D-61,
-- IKKE noe denne sliceen introduserer. **Denne sliceen fikser BEVISST KUN sin
-- EGEN nye `runZendeskEventSyncForAllTenants()`/`syncZendeskTicketAcrossTenants()`
-- (under) - de tre eksisterende funksjonene er BEVISST IKKE rørt her (utenfor
-- Zendesk-byggeordrens scope, og en RLS-relatert produksjonsfiks fortjener en
-- egen, eksplisitt godkjent runde - se D-64 sluttrapport/Q-25 for sporing).**
--
-- Fiksen bruker en SNEVERT AVGRENSET SECURITY DEFINER-funksjon (eid av
-- migrasjons-admin-rollen, IKKE jarvis_app/jarvis_runtime selv) som
-- UTELUKKENDE eksponerer tenant_id/kind - allerede ikke-sensitiv
-- katalogmetadata, SAMME klassifisering som `capabilities`
-- (se 005_rls.sql linje 65-kommentaren: "globalt verktøyregister, ikke
-- tenant-data"). Dette gir jarvis_app en MINIMAL, eksplisitt begrunnet
-- kanal for tenant-oppdagelse UTEN aa gi selve runtime-rollen BYPASSRLS
-- eller superuser - Q-21 sitt kjerneinvariant (jarvis_runtime er ALLTID
-- NOSUPERUSER/NOBYPASSRLS) er UENDRET.
CREATE FUNCTION jarvis_list_tenant_ids_by_kind(p_kind text, p_limit int DEFAULT 200)
RETURNS TABLE(tenant_id text)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
  SELECT tenant_id FROM tenants WHERE kind = p_kind ORDER BY tenant_id LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION jarvis_list_tenant_ids_by_kind(text, int) TO jarvis_app;
