-- Remediering del 2 (JARVIS-073): SECURITY DEFINER-funksjoner med MINSTE privilegium.
--
-- FØR: `claim_next_task`, `jarvis_list_business_tenant_ids`, `jarvis_list_all_tenant_ids` og
-- `jarvis_session_grant_tenant` var eid av migrasjonsrollen. De fungerte rundt `FORCE ROW LEVEL SECURITY` KUN fordi
-- migrasjonsrollen er superbruker (superbrukere omgår RLS). Med en ikke-superbruker som migrasjonsrolle ville de
-- stille returnert 0 rader - og med superbruker som eier kjører de med MER makt enn de trenger (en kompromittert
-- funksjon = full databasetilgang).
--
-- NÅ: de eies av `jarvis_definer` - en NOLOGIN, NOSUPERUSER, NOBYPASSRLS rolle som kun har de smale rettighetene
-- hver funksjon faktisk trenger (kolonne-nivå der det går) + en EKSPLISITT, smal RLS-policy rettet mot rollen.
-- Funksjonene fungerer dermed uten at noen superbruker eller BYPASSRLS-rolle er involvert.
--
-- INVARIANT (testet i remediation-2-schema-invariants.test.ts): hver SECURITY DEFINER-funksjon i `public` er eid av
-- en rolle som IKKE er superbruker og IKKE har BYPASSRLS, har `search_path` låst (pg_catalog, public, pg_temp sist),
-- og har ikke EXECUTE for PUBLIC. En NY definer-funksjon må legges til her (eller i en senere migrasjon) bevisst.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jarvis_definer') THEN
    CREATE ROLE jarvis_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE jarvis_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  -- En ikke-superbruker-migrasjonsrolle må være medlem for å kunne overdra eierskap (superbrukere er det implisitt).
  IF NOT pg_has_role(current_user, 'jarvis_definer', 'MEMBER') THEN
    EXECUTE format('GRANT jarvis_definer TO %I', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO jarvis_definer;

-- Smale rettigheter (kolonne-nivå): akkurat det funksjonene leser/skriver.
GRANT SELECT (tenant_id, kind) ON tenants TO jarvis_definer;
GRANT SELECT (grant_id, tenant_id) ON session_grants TO jarvis_definer;
GRANT SELECT (task_id, tenant_id, contract, attempts, checkpoint, status, lease_expires_at, created_at) ON tasks TO jarvis_definer;
GRANT UPDATE (status, claimed_at, attempts, worker_id, lease_expires_at) ON tasks TO jarvis_definer;

-- FORCE RLS gjelder også eieren; roller som IKKE er eier styres av policyer. Eksplisitte, smale policyer for definer-rollen
-- (permissive policyer OR-es, så de eksisterende tenant-policyene er uendret for alle andre roller).
CREATE POLICY tenants_definer_catalog ON tenants FOR SELECT TO jarvis_definer USING (true);
CREATE POLICY session_grants_definer_lookup ON session_grants FOR SELECT TO jarvis_definer USING (true);
CREATE POLICY tasks_definer_claim_select ON tasks FOR SELECT TO jarvis_definer USING (true);
CREATE POLICY tasks_definer_claim_update ON tasks FOR UPDATE TO jarvis_definer USING (true) WITH CHECK (true);

-- Eierskap + låst search_path (pg_temp sist - hindrer temp-objekt-kapring) + fortsatt kun EXECUTE for jarvis_app.
ALTER FUNCTION claim_next_task(text, integer, text[]) OWNER TO jarvis_definer;
ALTER FUNCTION claim_next_task(text, integer, text[]) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION jarvis_list_business_tenant_ids(integer) OWNER TO jarvis_definer;
ALTER FUNCTION jarvis_list_business_tenant_ids(integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION jarvis_list_all_tenant_ids(integer) OWNER TO jarvis_definer;
ALTER FUNCTION jarvis_list_all_tenant_ids(integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION jarvis_session_grant_tenant(text) OWNER TO jarvis_definer;
ALTER FUNCTION jarvis_session_grant_tenant(text) SET search_path = pg_catalog, public, pg_temp;

REVOKE ALL ON FUNCTION claim_next_task(text, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION jarvis_list_business_tenant_ids(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jarvis_list_all_tenant_ids(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION jarvis_session_grant_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_task(text, integer, text[]) TO jarvis_app;
GRANT EXECUTE ON FUNCTION jarvis_list_business_tenant_ids(integer) TO jarvis_app;
GRANT EXECUTE ON FUNCTION jarvis_list_all_tenant_ids(integer) TO jarvis_app;
GRANT EXECUTE ON FUNCTION jarvis_session_grant_tenant(text) TO jarvis_app;

-- Remediering del 2 (JARVIS-076): scope-FK for identitetskritiske grants. `session_grants.device_id`/`session_id` pekte på
-- `devices`/`sessions` med ENKELTKOLONNE-FK uten tenant_id - en FK-kontroll omgår RLS, så et grant i tenant A kunne
-- referere en enhet/sesjon i tenant B. Nå komposittnøkler (tenant_id, id): et grant kan KUN referere rader i SAMME tenant.
-- (Resten av tenant-kryssende FK-er er registrert som baseline i remediation-2-schema-invariants.test.ts - DEFERRED, Q-44.)
ALTER TABLE devices ADD CONSTRAINT devices_tenant_device_uk UNIQUE (tenant_id, device_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_session_uk UNIQUE (tenant_id, session_id);
ALTER TABLE session_grants DROP CONSTRAINT session_grants_device_id_fkey;
ALTER TABLE session_grants DROP CONSTRAINT session_grants_session_id_fkey;
ALTER TABLE session_grants
  ADD CONSTRAINT session_grants_tenant_device_fkey FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, device_id);
ALTER TABLE session_grants
  ADD CONSTRAINT session_grants_tenant_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id);
