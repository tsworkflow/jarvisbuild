-- D-240 + REMEDIERING DEL 2 (JARVIS-009/011): idempotent oppretting av de AUXILIARY-databasene
-- (`infisical`/`langfuse`) OG deres EGNE roller. Postgres-imagets `POSTGRES_DB` oppretter kun
-- primærdatabasen (`jarvis`) - en offisiell image-begrensning - så denne filen kjøres av
-- `db-bootstrap`-tjenesten (docker-compose.yml) FØR infisical/langfuse startes.
--
-- Tidligere koblet infisical og langfuse til som cluster-superbruker (`postgres`). Nå:
--   * `infisical_app` eier KUN databasen `infisical`, `langfuse_app` eier KUN `langfuse`.
--   * begge er NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS.
--   * PUBLIC mister CONNECT på alle tre databasene; hver rolle kan kun koble til sin egen.
--   * passordene leses fra miljøet (`\getenv`), aldri hardkodet og aldri i filen.
--
-- Idempotent: trygt å kjøre på HVER oppstart, også mot et eksisterende `jarvis-pgdata`-volum der
-- databasene allerede finnes og eies av superbrukeren (eierskap overdras, innholdet røres ikke).
-- `CREATE DATABASE` kan ikke kjøres i en transaksjon/DO-blokk, derfor `\gexec`-idiomet.

\getenv infisical_pw INFISICAL_DB_PASSWORD
\getenv langfuse_pw LANGFUSE_DB_PASSWORD

-- Fail closed: tomme/manglende passord ville gi en rolle uten (eller med tomt) passord.
SELECT (:'infisical_pw' = '' OR length(:'infisical_pw') < 24) AS bad_infisical_pw \gset
SELECT (:'langfuse_pw' = '' OR length(:'langfuse_pw') < 24) AS bad_langfuse_pw \gset
-- (`\quit <kode>` finnes først i PG 18 - en feil under ON_ERROR_STOP gir ikke-null exit i alle versjoner.)
\if :bad_infisical_pw
  \echo 'INFISICAL_DB_PASSWORD mangler eller er kortere enn 24 tegn'
  DO $$ BEGIN RAISE EXCEPTION 'INFISICAL_DB_PASSWORD mangler eller er for kort'; END $$;
\endif
\if :bad_langfuse_pw
  \echo 'LANGFUSE_DB_PASSWORD mangler eller er kortere enn 24 tegn'
  DO $$ BEGIN RAISE EXCEPTION 'LANGFUSE_DB_PASSWORD mangler eller er for kort'; END $$;
\endif

-- Roller: opprett hvis de mangler, sett alltid passord + minimale attributter (rotasjon via .env).
SELECT format('CREATE ROLE %I LOGIN', 'infisical_app')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'infisical_app') \gexec
SELECT format('CREATE ROLE %I LOGIN', 'langfuse_app')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langfuse_app') \gexec

-- Arkitekt-review (P3): passordene settes som server-side-hashet SCRAM (password_encryption), men selve DDL-en bærer literalen.
-- Slå derfor av setning-logging for DENNE sesjonen FØR de to ALTER ROLE (også feilsetninger, som ellers logges med teksten).
-- `pg_stat_statements` normaliserer konstanter og lagrer ikke literalen. Kun superbruker kan sette disse (db-bootstrap er admin).
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;

SELECT format('ALTER ROLE infisical_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'infisical_pw') \gexec
SELECT format('ALTER ROLE langfuse_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'langfuse_pw') \gexec

-- Databaser: opprett med riktig eier; en eksisterende database (superbruker-eid) overdras.
SELECT 'CREATE DATABASE infisical OWNER infisical_app'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'infisical') \gexec
SELECT 'CREATE DATABASE langfuse OWNER langfuse_app'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse') \gexec

ALTER DATABASE infisical OWNER TO infisical_app;
ALTER DATABASE langfuse OWNER TO langfuse_app;

-- Isolasjon mellom databasene: ingen PUBLIC-tilkobling; kun egen rolle (og eierne) kan koble til.
REVOKE CONNECT ON DATABASE infisical FROM PUBLIC;
REVOKE CONNECT ON DATABASE langfuse FROM PUBLIC;
GRANT CONNECT ON DATABASE infisical TO infisical_app;
GRANT CONNECT ON DATABASE langfuse TO langfuse_app;

-- Eierskap til eksisterende objekter + extensions. Både Infisical (knex) og Langfuse (prisma)
-- bruker pgcrypto/uuid-ossp; `CREATE EXTENSION` krever superbruker for ikke-trusted extensions,
-- derfor gjøres det her (som admin) og ikke av app-rollen. pgcrypto/uuid-ossp/pg_trgm er "trusted"
-- i PG13+, men å installere dem her holder app-rollen helt uten ekstra privilegier.
\connect infisical
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO infisical_app;
SELECT format('ALTER TABLE %I.%I OWNER TO infisical_app', schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'infisical_app' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO infisical_app', sequence_schema, sequence_name)
  FROM information_schema.sequences s
  WHERE sequence_schema = 'public'
    AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
          WHERE c.oid = format('%I.%I', s.sequence_schema, s.sequence_name)::regclass) <> 'infisical_app' \gexec


-- Alle ikke-system-skjemaer (Infisical oppretter f.eks. `pgboss` utenfor `public`), og ALLE objekttyper, overdras til app-rollen.
-- Uten dette feiler appen med `permission denied for schema pgboss` på et eksisterende, superbruker-eid volum.
-- Extension-eide objekter (pgcrypto/uuid-ossp/pg_trgm) hoppes over; de eies av extensionen.
SELECT set_config('jarvis.app_role', 'infisical_app', false);
DO $own$
DECLARE
  app text := current_setting('jarvis.app_role');
  r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, app);
  END LOOP;
  -- tabeller, partisjonerte tabeller, views, materialiserte views, fremmedtabeller (eide sekvenser følger tabellen)
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
       AND pg_get_userbyid(c.relowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND NOT (c.relkind = 'r' AND c.relispartition)
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname, app);
  END LOOP;
  -- sekvenser (kun de som ikke er eid av en kolonne; eide følger tabellen)
  FOR r IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind = 'S'
       AND pg_get_userbyid(c.relowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i','e'))
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, app);
  END LOOP;
  -- funksjoner/prosedyrer/aggregater
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND pg_get_userbyid(p.proowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, app);
  END LOOP;
  -- enum-/range-/domene-typer (array-typer følger basetypen)
  FOR r IN
    SELECT n.nspname, t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','r','m','d')
       AND pg_get_userbyid(t.typowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.nspname, r.typname, app);
  END LOOP;
END
$own$;

\connect langfuse
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO langfuse_app;
SELECT format('ALTER TABLE %I.%I OWNER TO langfuse_app', schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'langfuse_app' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO langfuse_app', sequence_schema, sequence_name)
  FROM information_schema.sequences s
  WHERE sequence_schema = 'public'
    AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
          WHERE c.oid = format('%I.%I', s.sequence_schema, s.sequence_name)::regclass) <> 'langfuse_app' \gexec

-- Alle ikke-system-skjemaer (Infisical oppretter f.eks. `pgboss` utenfor `public`), og ALLE objekttyper, overdras til app-rollen.
-- Uten dette feiler appen med `permission denied for schema pgboss` på et eksisterende, superbruker-eid volum.
-- Extension-eide objekter (pgcrypto/uuid-ossp/pg_trgm) hoppes over; de eies av extensionen.
SELECT set_config('jarvis.app_role', 'langfuse_app', false);
DO $own$
DECLARE
  app text := current_setting('jarvis.app_role');
  r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, app);
  END LOOP;
  -- tabeller, partisjonerte tabeller, views, materialiserte views, fremmedtabeller (eide sekvenser følger tabellen)
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
       AND pg_get_userbyid(c.relowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND NOT (c.relkind = 'r' AND c.relispartition)
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname, app);
  END LOOP;
  -- sekvenser (kun de som ikke er eid av en kolonne; eide følger tabellen)
  FOR r IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind = 'S'
       AND pg_get_userbyid(c.relowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i','e'))
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, app);
  END LOOP;
  -- funksjoner/prosedyrer/aggregater
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND pg_get_userbyid(p.proowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, app);
  END LOOP;
  -- enum-/range-/domene-typer (array-typer følger basetypen)
  FOR r IN
    SELECT n.nspname, t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','r','m','d')
       AND pg_get_userbyid(t.typowner) <> app
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.nspname, r.typname, app);
  END LOOP;
END
$own$;
