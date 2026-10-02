import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Q-21 (UA-2 P0 host-blocker, 2026-08-15): host-bevist at den faktiske
 * app-runtime-tilkoblingen kjørte som Postgres-superbruker (`postgres`,
 * samme rolle som `JARVIS_DB_ADMIN_USER`) - RLS-policyene fantes og var
 * FORCE-et, men ble aldri håndhevet fordi en superbruker/BYPASSRLS-rolle
 * ALLTID omgår RLS uansett policy-korrekthet.
 *
 * Root cause: `jarvis_app` (005_rls.sql) er en NOLOGIN gruppe-rolle - INGEN
 * sted i den faktiske driftsveien opprettet en ekte LOGIN-rolle bundet til
 * den (kun suitens test-oppsett gjorde det). Denne filen gjør nøyaktig DET
 * samme mønsteret idempotent og gjenbrukbart for ekte drift.
 */

const VALID_ROLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdent(value: string): string {
  if (!VALID_ROLE_NAME.test(value)) {
    throw new Error(`invalid_role_identifier:${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Remediering del 2 (JARVIS-076): Postgres kan ta et ferdig SCRAM-SHA-256-verifier i `PASSWORD '...'`. Da havner
 * ALDRI klartekstpassordet i DDL-setningen (server-logg med `log_statement`, `pg_stat_statements`, feilmeldinger).
 * Format: `SCRAM-SHA-256$<iter>:<salt b64>$<StoredKey b64>:<ServerKey b64>` (RFC 5802/7677). Kun ASCII-passord
 * (SASLprep-normalisering av ikke-ASCII er bevisst ikke reimplementert) - andre faller tilbake til literal.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function passwordLiteral(password: string): string {
  return /^[\u0020-\u007e]+$/.test(password) ? quoteLiteral(scramSha256Verifier(password)) : quoteLiteral(password);
}

export interface RuntimeRoleConfig {
  user: string;
  password: string;
}

export interface RuntimeRoleResult {
  role: string;
  created: boolean;
}

/**
 * Idempotent bootstrap KUN kjørbart via en admin-tilkobling (CREATE ROLE/GRANT
 * krever CREATEROLE eller superuser). Sikrer at `runtime.user` finnes som en
 * ekte LOGIN-rolle, EKSPLISITT NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE,
 * medlem av `jarvis_app` - aldri superuser, aldri en ny parallell
 * permission-modell (samme grants som `jarvis_app` allerede har, 005_rls.sql).
 *
 * Trygg å kjøre om igjen: oppdaterer passord/attributter i stedet for å feile
 * hvis rollen alt finnes. Skriver ALDRI passordet til logger/output.
 */
export async function ensureRuntimeRole(adminPool: pg.Pool, runtime: RuntimeRoleConfig): Promise<RuntimeRoleResult> {
  if (!runtime.user || !runtime.user.trim()) {
    throw new Error("runtime_role_user_required");
  }
  if (!runtime.password || !runtime.password.trim()) {
    throw new Error("runtime_role_password_required");
  }
  if (runtime.user === "jarvis_app") {
    // jarvis_app er den NOLOGIN gruppe-rollen selv (005_rls.sql) - kan aldri
    // bootstrappes som en innloggbar runtime-rolle uten å ødelegge RLS-modellen.
    throw new Error("runtime_user_cannot_be_jarvis_app_group_role");
  }

  const ident = quoteIdent(runtime.user);
  const lit = passwordLiteral(runtime.password);

  const exists = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtime.user]);
  if (exists.rowCount === 0) {
    await adminPool.query(
      `CREATE ROLE ${ident} LOGIN PASSWORD ${lit} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
    );
  } else {
    await adminPool.query(
      `ALTER ROLE ${ident} WITH LOGIN PASSWORD ${lit} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
    );
  }
  // Idempotent - GRANT en rolle til en rolle som allerede har den er en no-op.
  await adminPool.query(`GRANT jarvis_app TO ${ident}`);

  return { role: runtime.user, created: exists.rowCount === 0 };
}

export interface RuntimeRoleStatus {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  canLogin: boolean;
}

/** Ren lesing - avgjør om DENNE tilkoblingens rolle er trygg. Endrer aldri noe. */
export async function checkRuntimeRoleStatus(pool: pg.Pool): Promise<RuntimeRoleStatus> {
  const { rows } = await pool.query(
    "SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls, rolcanlogin AS can_login FROM pg_roles WHERE rolname = current_user"
  );
  const row = rows[0] as { role: string; superuser: boolean; bypassrls: boolean; can_login: boolean } | undefined;
  if (!row) {
    throw new Error("runtime_role_status_unavailable");
  }
  return { role: row.role, superuser: row.superuser, bypassrls: row.bypassrls, canLogin: row.can_login };
}

/**
 * Fail-closed startup-vakt for api/worker (§7/§9 i Q-21-fiksen): kaster hvis
 * DENNE tilkoblingens rolle er superuser og/eller BYPASSRLS. RLS er
 * strukturelt umulig å håndheve for en slik rolle uansett hvor korrekt
 * policyene er - appen skal ALDRI starte normalt i den tilstanden.
 */
export async function assertRuntimeRoleSafe(pool: pg.Pool): Promise<RuntimeRoleStatus> {
  const status = await checkRuntimeRoleStatus(pool);
  if (status.superuser || status.bypassrls) {
    throw new Error(
      `runtime_db_role_unsafe:${status.role} (superuser=${status.superuser} bypassrls=${status.bypassrls}) - ` +
        "JARVIS_DB_USER må peke på en NOSUPERUSER NOBYPASSRLS-rolle, medlem av jarvis_app. Se Q-21 i docs/OPEN_QUESTIONS.md."
    );
  }
  return status;
}

/**
 * Fail-closed FØR tilkobling i det hele tatt forsøkes (§3): et tomt/manglende
 * `JARVIS_DB_USER`/`JARVIS_DB_PASSWORD`, eller en runtime-bruker som er
 * IDENTISK med admin-brukeren, skal aldri stille falle tilbake til at
 * appen kjører videre - det er nøyaktig den konfigurasjonsfeilen Q-21 fant.
 */
export function assertRuntimeCredentialsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const user = env["JARVIS_DB_USER"];
  const password = env["JARVIS_DB_PASSWORD"];
  const adminUser = env["JARVIS_DB_ADMIN_USER"] ?? "postgres";
  if (!user || !user.trim()) {
    throw new Error("jarvis_db_user_missing: sett JARVIS_DB_USER til en ekte runtime-LOGIN-rolle (se .env.example)");
  }
  if (!password || !password.trim()) {
    throw new Error("jarvis_db_password_missing: sett JARVIS_DB_PASSWORD for runtime-rollen (se .env.example)");
  }
  if (user === adminUser) {
    throw new Error(
      "jarvis_db_user_equals_admin: JARVIS_DB_USER er identisk med JARVIS_DB_ADMIN_USER - runtime og admin må være FORSKJELLIGE roller (Q-21, se docs/OPEN_QUESTIONS.md)"
    );
  }
  if (user === "jarvis_app") {
    throw new Error("jarvis_db_user_is_group_role: jarvis_app er en NOLOGIN gruppe-rolle - JARVIS_DB_USER må være en LOGIN-rolle som er MEDLEM av jarvis_app (f.eks. jarvis_runtime)");
  }
}
