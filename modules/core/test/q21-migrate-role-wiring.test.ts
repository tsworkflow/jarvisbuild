import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adminConfigFromEnv, configFromEnv } from "../src/db/pool.ts";
import {
  buildImageBuildArgs,
  buildMigrateRunArgs,
  resolveAdminCredentials,
  resolveRuntimeCredentials
} from "../scripts/lib/q21-env-recovery.ts";

/**
 * Q-21 HOST RECOVERY #2 (2026-08-15): migrate autentiserte som `jarvis_runtime`
 * mot Postgres til tross for at `.env` hadde `JARVIS_DB_ADMIN_USER=postgres`
 * korrekt satt (bekreftet av host-scriptets egen log). Denne suiten beviser
 * §9.A-J i BO-en: migrate/api/worker sin rolle-wiring, at admin-credentials nå
 * sendes eksplisitt (ikke via tvetydig .env/env_file-oppløsning) til migrate,
 * riktig operasjonsrekkefølge, idempotens, og at ingen secrets eksponeres.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("§9.A: migrate effective role er ADMIN", () => {
  it("migrate-main.ts skriver migrate_effective_db_user FØR runMigrations, fra adminConfigFromEnv()", () => {
    const source = readSource("../../../apps/api/src/migrate-main.ts");
    const diagIdx = source.indexOf("migrate_effective_db_user");
    const runMigrationsIdx = source.indexOf("await runMigrations(adminPool)");
    expect(diagIdx).toBeGreaterThan(-1);
    expect(runMigrationsIdx).toBeGreaterThan(-1);
    expect(diagIdx).toBeLessThan(runMigrationsIdx);
    expect(source).toMatch(/const resolvedAdminConfig = adminConfigFromEnv\(\)/);
    expect(source).toMatch(/createPool\(resolvedAdminConfig\)/);
  });

  it("expected: migrate_effective_db_user=postgres når JARVIS_DB_ADMIN_USER er default/uendret", () => {
    const cfg = adminConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
  });
});

describe("§9.B/§9.C: api/worker effective role er RUNTIME", () => {
  it("main.ts bruker configFromEnv, aldri adminConfigFromEnv", () => {
    const source = readSource("../../../apps/api/src/main.ts");
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });

  it("worker-main.ts bruker configFromEnv, aldri adminConfigFromEnv", () => {
    const source = readSource("../../../apps/api/src/worker-main.ts");
    expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
    expect(source).not.toMatch(/adminConfigFromEnv/);
  });
});

describe("§9.D/§9.E: admin/runtime config kan ikke resolve hverandres variabler", () => {
  it("adminConfigFromEnv ignorerer JARVIS_DB_USER/PASSWORD helt - faller til default, aldri runtime-verdien", () => {
    const cfg = adminConfigFromEnv({ JARVIS_DB_USER: "jarvis_runtime", JARVIS_DB_PASSWORD: "pw-runtime-only" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("postgres");
    expect(cfg.password).toBeUndefined();
  });

  it("configFromEnv ignorerer JARVIS_DB_ADMIN_USER/PASSWORD helt - faller til default, aldri admin-verdien", () => {
    const cfg = configFromEnv({ JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw-admin-only" } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("jarvis_runtime");
    expect(cfg.password).toBeUndefined();
  });
});

describe("§9.F: docker-compose sin migrate-tjeneste er wired til ADMIN-vars (eksplisitt per-tjeneste env, ingen env_file), ingen runtime-override", () => {
  it("migrate-blokken videresender JARVIS_DB_ADMIN_* og setter aldri JARVIS_DB_USER/PASSWORD til en literal (ville skygget for admin-config)", () => {
    const compose = readSource("../../../infra/local/docker-compose.yml");
    const lines = compose.split("\n");
    const startIdx = lines.findIndex((l) => /^\s*migrate:\s*$/.test(l));
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = lines.findIndex((l, i) => i > startIdx && /^ {2}\S/.test(l));
    const migrateBlock = lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
    // Del 2 (JARVIS-009): ingen env_file (hele .env-settet) - kun eksplisitt listede variabler.
    expect(migrateBlock).not.toMatch(/env_file:/);
    expect(migrateBlock).toMatch(/JARVIS_DB_ADMIN_PASSWORD:\s*"\$\{JARVIS_DB_ADMIN_PASSWORD:-\}"/);
    expect(migrateBlock).toMatch(/JARVIS_DB_ADMIN_USER:\s*"\$\{JARVIS_DB_ADMIN_USER:-\}"/);
    // Runtime-variablene kan KUN være ren videresending av samme navn (migrate setter runtime-rollens passord), aldri en literal.
    expect(migrateBlock).not.toMatch(/JARVIS_DB_USER: +(?!"\$\{JARVIS_DB_USER:-\}")/);
    expect(migrateBlock).not.toMatch(/JARVIS_DB_PASSWORD: +(?!"\$\{JARVIS_DB_PASSWORD:-\}")/);
  });
});

describe("§9.G: partial host rerun (host-feilens eksakte scenario) er idempotent", () => {
  it("gir identisk admin/runtime-resultat på gjentatt kall når .env allerede er korrekt", () => {
    const current = {
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin-stable",
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime-stable"
    };
    const admin1 = resolveAdminCredentials(current, []);
    const admin2 = resolveAdminCredentials(current, []);
    expect(admin1).toEqual(admin2);
    const runtime1 = resolveRuntimeCredentials(current, admin1.adminUser, () => "SKAL-ALDRI-BRUKES");
    const runtime2 = resolveRuntimeCredentials(current, admin1.adminUser, () => "SKAL-ALDRI-BRUKES");
    expect(runtime1).toEqual(runtime2);
    expect(runtime1.changed).toBe(false);
  });
});

describe("§10.A/§10.B/§10.C: migrate/api/worker bygges fra AKTUELL checkout FØR de kjøres (stale-image-fiks)", () => {
  it("buildImageBuildArgs bygger nøyaktig migrate+api+worker, ingen andre tjenester", () => {
    const args = buildImageBuildArgs(["compose", "--env-file", "/repo/.env", "-f", "/repo/compose.yml"]);
    expect(args).toEqual(["compose", "--env-file", "/repo/.env", "-f", "/repo/compose.yml", "build", "migrate", "api", "worker"]);
  });

  it("§10.A/§10.B: buildImageBuildArgs (rebuild) kalles FØR buildMigrateRunArgs (migrate) og FØR api/worker restartes", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    const buildIdx = source.indexOf("buildImageBuildArgs(composeArgs)");
    const migrateRunIdx = source.indexOf("buildMigrateRunArgs(composeArgs)");
    const apiWorkerRestartIdx = source.indexOf('"--force-recreate", "api", "worker"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(apiWorkerRestartIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx); // §10.A: rebygget FØR migrate kjøres
    expect(buildIdx).toBeLessThan(apiWorkerRestartIdx); // §10.B: rebygget FØR api/worker restartes
  });

  it("§10.C: build-steget kjøres UBETINGET hver kjøring - ingen sjekk som kunne hoppe over det og gjenbruke et eksisterende image", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    // run(buildImageBuildArgs(...)) skal stå som et direkte, ubetinget kall - ikke inni en
    // if/condition som kunne latt et stale image slippe gjennom (nøyaktig forrige host-bug).
    expect(source).toMatch(/^\s*run\(buildImageBuildArgs\(composeArgs\)\);\s*$/m);
  });
});

describe("§10.D/§10.E: migrate-kommandoen bruker korrekt env-wiring, ingen '-e NAME'-ambiguitet", () => {
  it("buildMigrateRunArgs er nå den enkle formen - kun service+--env-file, ingen -e-overstyring", () => {
    const args = buildMigrateRunArgs(["compose", "--env-file", "/repo/.env", "-f", "/repo/compose.yml"]);
    expect(args).toEqual(["compose", "--env-file", "/repo/.env", "-f", "/repo/compose.yml", "run", "--rm", "migrate"]);
    expect(args).not.toContain("-e"); // §10.E: bar '-e NAME'-ambiguiteten er fjernet
  });

  it("fix-q21-runtime-role.ts kaller run() uten noen ekstra miljøparameter til migrate-kallet", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    expect(source).toMatch(/run\(buildMigrateRunArgs\(composeArgs\)\);/);
  });
});

describe("§10.F: migrate_effective_db_user grunnsannhets-diagnostikk (uendret fra forrige runde)", () => {
  it("skrives av migrate-main.ts FØR runMigrations, kun brukernavn - aldri passord", () => {
    const source = readSource("../../../apps/api/src/migrate-main.ts");
    expect(source).toMatch(/console\.log\(`migrate_effective_db_user=\$\{resolvedAdminConfig\.user\}`\)/);
    expect(source).not.toMatch(/migrate_effective_db_user.*password/i);
  });
});

describe("§10.G: passord logges aldri noe sted i host-scriptet", () => {
  it("run() logger KUN args - aldri en credential-verdi", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    expect(source).toMatch(/log\(`\$ docker \$\{args\.join\(" "\)\}`\)/);
    expect(source).not.toMatch(/log\([^)]*adminPassword[^)]*\)/);
    expect(source).not.toMatch(/log\([^)]*runtimePassword[^)]*\)/);
  });

  it("run() tar ikke lenger imot en ekstra miljø-/verdi-parameter i det hele tatt (fjernet sammen med -e-ambiguiteten)", () => {
    const source = readSource("../scripts/fix-q21-runtime-role.ts");
    expect(source).toMatch(/function run\(args: string\[\]\): void \{/);
  });
});

describe("§10.H/§9.H/§9.J: full operasjonsrekkefølge i fix-q21-runtime-role.ts er korrekt", () => {
  const source = readSource("../scripts/fix-q21-runtime-role.ts");

  it("admin-precheck → rebuild → migrate → api/worker restart → runtime-verifikasjon, i rekkefølge", () => {
    const adminPrecheckIdx = source.indexOf("admin_connection=PASS");
    const buildIdx = source.indexOf("buildImageBuildArgs(composeArgs)");
    const migrateRunIdx = source.indexOf("buildMigrateRunArgs(composeArgs)");
    const runtimeCheckIdx = source.indexOf("runtime_connection=");
    expect(adminPrecheckIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(runtimeCheckIdx).toBeGreaterThan(-1);
    expect(adminPrecheckIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
    expect(migrateRunIdx).toBeLessThan(runtimeCheckIdx);
  });

  it("full rekkefølge: .env-resolve → validering → postgres opp → admin-precheck → rebuild → migrate → api/worker restart → runtime-verifikasjon → ua2-p0-live.ts", () => {
    const idx = (needle: string) => source.indexOf(needle);
    const order = [
      idx("resolveAdminCredentials("),
      idx("resolveRuntimeCredentials("),
      idx("validateRequiredEnv("),
      idx('"up", "-d", "postgres"'),
      idx("log(`admin_connection=PASS"),
      idx("buildImageBuildArgs(composeArgs)"),
      idx("buildMigrateRunArgs(composeArgs)"),
      idx('"--force-recreate", "api", "worker"'),
      idx("runtime_connection="),
      idx("ua2-p0-live.ts")
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("§9.G/idempotent rerun: gjentatt kjøring med allerede-korrekt .env gir samme admin/runtime-resultat (ingen re-generering)", () => {
    const current = {
      JARVIS_DB_ADMIN_USER: "postgres",
      JARVIS_DB_ADMIN_PASSWORD: "pw-admin-stable",
      JARVIS_DB_USER: "jarvis_runtime",
      JARVIS_DB_PASSWORD: "pw-runtime-stable"
    };
    const admin1 = resolveAdminCredentials(current, []);
    const runtime1 = resolveRuntimeCredentials(current, admin1.adminUser, () => "SKAL-ALDRI-BRUKES");
    const admin2 = resolveAdminCredentials(current, []);
    const runtime2 = resolveRuntimeCredentials(current, admin2.adminUser, () => "SKAL-ALDRI-BRUKES");
    expect(admin1).toEqual(admin2);
    expect(runtime1).toEqual(runtime2);
    expect(runtime1.changed).toBe(false);
  });
});
