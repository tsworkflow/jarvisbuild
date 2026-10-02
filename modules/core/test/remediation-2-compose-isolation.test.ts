import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeBlankEnv } from "@jarvis/contracts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { checkCompose, parseComposeServices } from "../../../ops/security/check-containment.mjs";
// @ts-expect-error - .mjs uten typer
import { renderEnvironment } from "../../../ops/security/generate-compose-env.mjs";
// @ts-expect-error - .mjs uten typer
import { CONNECTOR_ENV, MODEL_ENV, NEVER_IN_RUNTIME, SERVICE_ENV, WEBHOOK_ENV } from "../../../infra/local/service-env.mjs";

/**
 * Remediering del 2 (JARVIS-009/010/011) - isolasjonsbevis uten Docker-daemon:
 *  A. compose-environment per tjeneste = manifestet (ingen drift, ingen env_file),
 *  B. worker/api/voice/browser får ALDRI vault-hovednøkkel, DB-admin eller tjenestehemmeligheter de ikke trenger,
 *  C. ikke-root + herding (Dockerfile USER, cap_drop, read_only, nettverk, seccomp-fil),
 *  D. bootstrap-databases.sql mot ekte Postgres: egne roller, eierskapsoverdragelse, idempotens, isolasjon,
 *  E. `normalizeBlankEnv` (tomme videresendte variabler regnes som ikke satt).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const compose = read("infra/local/docker-compose.yml");
const services = parseComposeServices(compose) as Record<string, string[]>;
const envKeys = (block: string[]): string[] => {
  const keys: string[] = [];
  let inEnv = false;
  for (const line of block) {
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^ {4}\S/.test(line)) inEnv = false;
    const m = inEnv ? /^ {6}([A-Z0-9_]+):/.exec(line) : null;
    if (m) keys.push(m[1] as string);
  }
  return keys;
};
const COMPOSE_SERVICE: Record<string, string> = { api: "api", worker: "worker", migrate: "migrate", voice: "voice-gateway", browser: "browser-gateway" };

describe("A: compose-environment er generert fra manifestet (JARVIS-010)", () => {
  it("ingen tjeneste bruker env_file", () => {
    expect(compose).not.toMatch(/^\s+env_file:/m);
  });
  for (const [key, name] of Object.entries(COMPOSE_SERVICE)) {
    it(`${name}: environment-blokken er identisk med renderEnvironment('${key}')`, () => {
      const block = (services[name] ?? []).join("\n");
      // check-containment sin parser fjerner kommentarlinjer - sammenlign uten dem.
      const rendered = (renderEnvironment(key) as string).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(block).toContain(rendered);
    });
    it(`${name}: setter kun variabler fra manifestet`, () => {
      const allowed = new Set<string>([...SERVICE_ENV[key], "JARVIS_DB_HOST", "JARVIS_DB_PORT", "JARVIS_DB_NAME", "INFISICAL_URL", "JARVIS_CORE_URL"]);
      const extra = envKeys(services[name] ?? []).filter((k) => !allowed.has(k));
      expect(extra).toEqual([]);
    });
  }
  it("check-containment aksepterer den faktiske compose-filen", () => {
    expect(checkCompose(compose, "docker-compose.yml")).toEqual([]);
  });
});

describe("B: hemmelighetsisolasjon per tjeneste (JARVIS-010)", () => {
  const runtime = ["api", "worker", "voice", "browser"] as const;
  for (const key of runtime) {
    it(`${key}: ingen NEVER_IN_RUNTIME-variabel (vault-hovednøkkel, DB-admin, Langfuse-init, SALT, ...)`, () => {
      const leaked = (SERVICE_ENV[key] as string[]).filter((n) => NEVER_IN_RUNTIME.includes(n));
      expect(leaked).toEqual([]);
      const composeLeak = envKeys(services[COMPOSE_SERVICE[key] as string] ?? []).filter((n) => NEVER_IN_RUNTIME.includes(n));
      expect(composeLeak).toEqual([]);
    });
  }
  it("worker får ikke webhook-hemmeligheter, mediekeys eller meldingsleverandør-nøkler (kun api)", () => {
    const worker = new Set<string>(SERVICE_ENV.worker);
    for (const n of WEBHOOK_ENV) expect(worker.has(n), n).toBe(false);
    expect(worker.has("JARVIS_TWILIO_AUTH_TOKEN")).toBe(false);
    expect(worker.has("JARVIS_ELEVENLABS_API_KEY")).toBe(false);
    expect(worker.has("JARVIS_DB_ADMIN_PASSWORD")).toBe(false);
    expect(worker.has("INFISICAL_ENCRYPTION_KEY")).toBe(false);
  });
  it("browser-gateway får KUN port + tjeneste-token - ingen modell-/connector-nøkler", () => {
    expect([...SERVICE_ENV.browser].sort()).toEqual(["JARVIS_BROWSER_GATEWAY_PORT", "JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"]);
  });
  it("voice-gateway får kun taleleverandørnøkler (ingen connector-/DB-hemmeligheter)", () => {
    const voice = new Set<string>(SERVICE_ENV.voice);
    for (const n of CONNECTOR_ENV) expect(voice.has(n), n).toBe(false);
    for (const n of MODEL_ENV) if (n !== "OPENAI_API_KEY") expect(voice.has(n), n).toBe(false);
    expect([...voice].some((n) => n.startsWith("JARVIS_DB_"))).toBe(false);
  });
  it("migrate (engangsjobb) får admin-passordet, men ingen connector-/modellnøkler", () => {
    const migrate = new Set<string>(SERVICE_ENV.migrate);
    expect(migrate.has("JARVIS_DB_ADMIN_PASSWORD")).toBe(true);
    for (const n of [...CONNECTOR_ENV, ...MODEL_ENV]) expect(migrate.has(n), n).toBe(false);
  });
  it("api/worker kobler til som runtime-rolle (jarvis_runtime), aldri som admin", () => {
    for (const key of ["api", "worker"]) {
      const names = new Set<string>(SERVICE_ENV[key]);
      expect(names.has("JARVIS_DB_USER")).toBe(true);
      expect(names.has("JARVIS_DB_ADMIN_USER")).toBe(false);
    }
  });
  it("infisical/langfuse kobler til egne roller, ikke superbruker", () => {
    expect(compose).toMatch(/postgresql:\/\/langfuse_app:\$\{LANGFUSE_DB_PASSWORD:\?/);
    expect(compose).toMatch(/infisical_app:\$\{INFISICAL_DB_PASSWORD:\?/);
    expect(compose).not.toMatch(/postgresql:\/\/\$\{JARVIS_DB_ADMIN_USER/);
    expect(compose).not.toMatch(/(DB_CONNECTION_URI|DATABASE_URL):[^\n]*postgresql:\/\/postgres:/);
  });
});

describe("C: ikke-root og herding (JARVIS-009/010)", () => {
  const dockerfileUser = (file: string): string[] =>
    read(`infra/local/${file}`).split("\n").filter((l) => /^USER\s/.test(l)).map((l) => l.trim().split(/\s+/)[1] as string);
  it("api/voice/browser-Dockerfilene ender på en ikke-root USER", () => {
    expect(dockerfileUser("api.Dockerfile").at(-1)).toBe("node");
    expect(dockerfileUser("voice-gateway.Dockerfile").at(-1)).toBe("node");
    expect(dockerfileUser("browser-gateway.Dockerfile").at(-1)).toBe("pwuser");
  });
  it("api-imaget inneholder ikke git/docker-klient (kodejobber kjører aldri i worker-containeren)", () => {
    const apt = read("infra/local/api.Dockerfile").split("\n").filter((l) => /apt-get|apk add|git\b/.test(l) && !l.trim().startsWith("#")).join("\n");
    expect(apt).not.toMatch(/\bgit\b/);
    expect(apt).not.toMatch(/docker/i);
  });
  for (const name of ["api", "worker", "migrate", "voice-gateway", "browser-gateway"]) {
    it(`${name}: cap_drop ALL + no-new-privileges + read_only`, () => {
      const body = (services[name] ?? []).join("\n");
      expect(/<<:\s*\*hardening/.test(body) || (/cap_drop:\s*\["ALL"\]/.test(body) && /no-new-privileges:true/.test(body) && /read_only:\s*true/.test(body))).toBe(true);
    });
  }
  it("x-hardening-ankeret dropper alle capabilities og krever read-only rootfs", () => {
    const anchor = /x-hardening:\s*&hardening\n((?: {2}.*\n)+)/.exec(compose)?.[1] ?? "";
    expect(anchor).toMatch(/cap_drop:\s*\["ALL"\]/);
    expect(anchor).toMatch(/no-new-privileges:true/);
    expect(anchor).toMatch(/read_only:\s*true/);
  });
  it("browser-gateway: kun `browser`-nettverket, ingen host-port, seccomp-profil (ikke SYS_ADMIN/privileged) som finnes", () => {
    const body = (services["browser-gateway"] ?? []).join("\n");
    expect(body).toMatch(/networks:\s*\[browser\]/);
    expect(body).not.toMatch(/SYS_ADMIN|privileged/);
    // D-365: `cap_drop: ALL` + NØYAKTIG én tilbakelagt capability (SYS_CHROOT, målt på NAS) - ellers starter ikke Chromium-sandboxen.
    expect(body).toMatch(/cap_drop:\s*\["ALL"\]/);
    expect(body).toMatch(/cap_add:\s*\["SYS_CHROOT"\]/);
    expect(body.match(/cap_add:/g)).toHaveLength(1);
    expect(body).toMatch(/seccomp=\.\/browser-gateway\.seccomp\.json/); // relativt til compose-filens mappe (infra/local)
    expect(existsSync(join(ROOT, "infra/local/browser-gateway.seccomp.json"))).toBe(true);
    const profile = JSON.parse(read("infra/local/browser-gateway.seccomp.json")) as { defaultAction: string };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });
  it("api og worker er de eneste som deler `browser`-nettverket med gatewayen; postgres/infisical/langfuse/redis/voice er ikke på det", () => {
    for (const name of ["postgres", "infisical", "infisical-redis", "langfuse", "db-bootstrap", "migrate", "voice-gateway"]) {
      expect((services[name] ?? []).join("\n"), name).not.toMatch(/networks:[^\n]*browser/);
    }
    for (const name of ["api", "worker"]) expect((services[name] ?? []).join("\n"), name).toMatch(/networks:[^\n]*browser/);
  });
  it("ingen Docker-socket og ingen JARVIS_JOB_RUNNER-literal i compose (kodejobber feiler lukket)", () => {
    expect(compose).not.toMatch(/docker\.sock/);
    expect(compose).not.toMatch(/JARVIS_JOB_RUNNER:\s*"?container/);
  });
});

describe("E: normalizeBlankEnv", () => {
  it("fjerner tomme variabler (kun navn returneres), beholder verdier", () => {
    const env: NodeJS.ProcessEnv = { A: "", C: "x", D: "0" };
    expect(normalizeBlankEnv(env)).toEqual(["A"]);
    expect(env["A"]).toBeUndefined();
    expect(env["C"]).toBe("x");
    expect(env["D"]).toBe("0");
  });
});

// --- D: bootstrap-SQL mot ekte Postgres ----------------------------------------------------------------------
const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const PW_INFISICAL = "InfisicalPassw0rdAAAAAAAAAAAA";
const PW_LANGFUSE = "LangfusePassw0rdBBBBBBBBBBBB";

describe.skipIf(!hasPsql)("D: bootstrap-databases.sql (ekte Postgres 16)", () => {
  let port = 0;
  let stop: (() => Promise<void>) | undefined;
  let admin: pg.Pool;

  const runBootstrap = (env: Record<string, string>) =>
    spawnSync(
      "psql",
      ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "jarvis_test", "-v", "ON_ERROR_STOP=1", "-f", join(ROOT, "infra/local/bootstrap-databases.sql")],
      { env: { PATH: process.env["PATH"] ?? "", PGPASSWORD: "pw", ...env }, encoding: "utf8" }
    );
  const connectAs = (user: string, password: string, database: string) => {
    const pool = new pg.Pool({ host: "127.0.0.1", port, database, user, password });
    pool.on("error", () => undefined);
    return pool;
  };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-r2boot-"));
    const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
    port = leased.port;
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    // Eksisterende volum (før del 2): `infisical` finnes allerede, eid av superbrukeren, med en tabell.
    await leased.postgres.createDatabase("infisical");
    const legacy = connectAs("postgres", "pw", "infisical");
    await legacy.query("CREATE TABLE legacy_secret_metadata (id int primary key)");
    await legacy.query("INSERT INTO legacy_secret_metadata VALUES (1)");
    // Infisical (pg-boss) har et EGET skjema utenfor `public`, med tabeller/typer/funksjoner/views eid av superbrukeren.
    await legacy.query(`CREATE SCHEMA pgboss;
      CREATE TYPE pgboss.job_state AS ENUM ('created','active');
      CREATE TABLE pgboss.job (id int primary key, state pgboss.job_state);
      CREATE SEQUENCE pgboss.standalone_seq;
      CREATE VIEW pgboss.job_view AS SELECT id FROM pgboss.job;
      CREATE FUNCTION pgboss.job_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM pgboss.job';`);
    await legacy.end();
    admin = connectAs("postgres", "pw", "jarvis_test");
  }, 240_000);

  afterAll(async () => {
    await admin?.end();
    await stop?.();
  }, 120_000);

  it("feiler lukket uten passord / med for kort passord (ingen rolle uten passord)", async () => {
    const missing = runBootstrap({});
    expect(missing.status).not.toBe(0);
    const short = runBootstrap({ INFISICAL_DB_PASSWORD: "short", LANGFUSE_DB_PASSWORD: PW_LANGFUSE });
    expect(short.status).not.toBe(0);
    const roles = await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN ('infisical_app','langfuse_app')");
    expect(roles.rowCount).toBe(0);
  });

  it("oppretter egne roller + eierskap (også overdragelse av eksisterende superbruker-eid database), idempotent", async () => {
    const env = { INFISICAL_DB_PASSWORD: PW_INFISICAL, LANGFUSE_DB_PASSWORD: PW_LANGFUSE };
    const first = runBootstrap(env);
    expect(first.status, first.stderr).toBe(0);
    const second = runBootstrap(env); // samme volum, andre oppstart
    expect(second.status, second.stderr).toBe(0);

    const owners = await admin.query(
      `SELECT d.datname, r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname IN ('infisical','langfuse') ORDER BY 1`
    );
    expect(owners.rows).toEqual([
      { datname: "infisical", owner: "infisical_app" },
      { datname: "langfuse", owner: "langfuse_app" }
    ]);
    const attrs = await admin.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname IN ('infisical_app','langfuse_app') ORDER BY 1`
    );
    for (const r of attrs.rows) {
      expect(r).toMatchObject({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true });
    }

    // Eksisterende tabell overdratt, innholdet urørt.
    const infisical = connectAs("infisical_app", PW_INFISICAL, "infisical");
    const legacy = await infisical.query("SELECT id FROM legacy_secret_metadata");
    expect(legacy.rows).toEqual([{ id: 1 }]);
    await infisical.query("CREATE TABLE migrated_by_app (id int)"); // eier public-skjemaet
    const tableOwner = await infisical.query("SELECT tableowner FROM pg_tables WHERE tablename = 'legacy_secret_metadata'");
    expect(tableOwner.rows[0]).toEqual({ tableowner: "infisical_app" });
    // Skjema utenfor `public` (JARVIS-009-regresjon: `permission denied for schema pgboss` på eksisterende volum).
    await infisical.query("INSERT INTO pgboss.job VALUES (1, 'created')");
    await infisical.query("CREATE TABLE pgboss.created_by_app (id int)");
    await infisical.query("SELECT pgboss.job_count()");
    await infisical.query("ALTER SEQUENCE pgboss.standalone_seq RESTART");
    const inspector = connectAs("postgres", "pw", "infisical");
    const pgbossOwners = await inspector.query(
      `SELECT DISTINCT o FROM (
         SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'pgboss'
         UNION ALL SELECT pg_get_userbyid(relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss'
         UNION ALL SELECT pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pgboss'
         UNION ALL SELECT pg_get_userbyid(typowner) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'pgboss' AND t.typtype = 'e'
       ) x`
    );
    await inspector.end();
    expect(pgbossOwners.rows).toEqual([{ o: "infisical_app" }]);
    await infisical.end();
  });

  it("isolasjon: infisical_app kan ikke koble til langfuse/jarvis-data; ingen rolle kan opprette roller/databaser", async () => {
    const infisicalToLangfuse = connectAs("infisical_app", PW_INFISICAL, "langfuse");
    await expect(infisicalToLangfuse.query("SELECT 1")).rejects.toThrow(/permission denied|not permitted/i);
    await infisicalToLangfuse.end();
    const langfuseToInfisical = connectAs("langfuse_app", PW_LANGFUSE, "infisical");
    await expect(langfuseToInfisical.query("SELECT 1")).rejects.toThrow(/permission denied|not permitted/i);
    await langfuseToInfisical.end();

    const asApp = connectAs("langfuse_app", PW_LANGFUSE, "langfuse");
    await expect(asApp.query("CREATE ROLE sneaky LOGIN")).rejects.toThrow(/permission denied/i);
    await expect(asApp.query("CREATE DATABASE sneaky")).rejects.toThrow(/permission denied/i);
    await expect(asApp.query("ALTER ROLE langfuse_app SUPERUSER")).rejects.toThrow(/permission denied|must be superuser/i);
    // Extensions er installert av admin (app-rollen trenger ingen utvidede rettigheter).
    const ext = await asApp.query("SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','uuid-ossp','pg_trgm') ORDER BY 1");
    expect(ext.rows.map((r: { extname: string }) => r.extname)).toEqual(["pg_trgm", "pgcrypto", "uuid-ossp"]);
    await asApp.end();
  });

  it("passord-rotasjon: ny verdi i .env gjelder ved neste kjøring, gammelt passord slutter å virke", async () => {
    const rotated = "RotatedPassw0rdCCCCCCCCCCCCC";
    const res = runBootstrap({ INFISICAL_DB_PASSWORD: rotated, LANGFUSE_DB_PASSWORD: PW_LANGFUSE });
    expect(res.status, res.stderr).toBe(0);
    const old = connectAs("infisical_app", PW_INFISICAL, "infisical");
    await expect(old.query("SELECT 1")).rejects.toThrow(/password authentication failed/i);
    await old.end();
    const fresh = connectAs("infisical_app", rotated, "infisical");
    await expect(fresh.query("SELECT 1")).resolves.toBeTruthy();
    await fresh.end();
  });

  it("Arkitekt-review (P3): setning-logging slås av FØR ALTER ROLE ... PASSWORD (ingen klartekst-passord i serverlogg)", () => {
    const sql = read("infra/local/bootstrap-databases.sql");
    const firstAlter = sql.indexOf("ALTER ROLE infisical_app WITH LOGIN");
    for (const setting of ["SET log_statement = 'none'", "SET log_min_error_statement = 'panic'", "SET log_min_duration_statement = -1"]) {
      const at = sql.indexOf(setting);
      expect(at, setting).toBeGreaterThan(-1);
      expect(at, setting).toBeLessThan(firstAlter);
    }
  });

  it("filen inneholder ingen passord-literaler", () => {
    const sql = read("infra/local/bootstrap-databases.sql");
    expect(sql).toMatch(/\\getenv infisical_pw INFISICAL_DB_PASSWORD/);
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });
});
