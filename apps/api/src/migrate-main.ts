// One-shot migrasjonskjøring (BO-07): kjøres som egen compose-tjeneste FØR api/worker
// starter (service_completed_successfully) slik at flere instanser aldri kappløper
// om skjemaet. Avslutter med kode 0 kun når alle migrasjoner er på plass.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
//
// Q-21 (2026-08-15): kjører med ADMIN-config (CREATE ROLE/ALTER TABLE...ENABLE RLS/
// CREATE EXTENSION krever admin-privilegier) - ALDRI runtime-config. Bootstrapper i
// samme kjøring den ekte runtime-LOGIN-rollen api/worker skal koble til med, slik at
// de aldri trenger/kan falle tilbake til admin-tilkoblingen.
import "./normalize-env.ts";
import { adminConfigFromEnv, configFromEnv, createPool, ensureRuntimeRole, runMigrations } from "@jarvis/core";
import { ownerConfigOrExit } from "./owner.ts";
import { seedOwner } from "./seed.ts";

// Remediering del 2 (JARVIS-065): eier-identiteten seedes fra validert konfig (fail closed uten) - ingen defaults.
const owner = ownerConfigOrExit();

const resolvedAdminConfig = adminConfigFromEnv();
// Q-21 HOST RECOVERY #2 (2026-08-15): grunnsannhets-diagnostikk - hvilken rolle
// prosessen FAKTISK forsøker å koble til med, FØR migrasjoner kjøres. Skrives av
// migrate-PROSESSEN selv (ikke antatt av host-scriptet som starter containeren) -
// eneste pålitelige måte å avgjøre om en Docker/Compose-miljøvariabel-tvetydighet
// ga migrate en annen bruker enn den host-scriptet beregnet. Aldri passordet.
console.log(`migrate_effective_db_user=${resolvedAdminConfig.user}`);

const adminPool = createPool(resolvedAdminConfig);
try {
  await runMigrations(adminPool);
  // Owner-seed (BO-08 + D-30 voice-device): idempotent, delt funksjon (testes
  // direkte) - fjerner det manuelle one-time-SQL-steget fra BO-07.
  await seedOwner(adminPool, owner);

  const runtime = configFromEnv();
  const adminUser = process.env["JARVIS_DB_ADMIN_USER"] ?? "postgres";
  if (runtime.user && runtime.password && runtime.user !== adminUser) {
    const result = await ensureRuntimeRole(adminPool, { user: runtime.user, password: runtime.password });
    console.log(JSON.stringify({ msg: "runtime_role_ensured", role: result.role, created: result.created }));
  } else {
    // Fail-closed i api/worker (assertRuntimeCredentialsConfigured) fanger dette ved
    // oppstart - her logges det kun som synlig varsel, migrasjonen skal ikke stoppe
    // (en fersk .env uten runtime-credentials ennå skal fortsatt kunne migreres).
    console.log(
      JSON.stringify({
        msg: "runtime_role_bootstrap_skipped",
        reason: "JARVIS_DB_USER/JARVIS_DB_PASSWORD ikke satt til en distinkt runtime-rolle - se Q-21 i docs/OPEN_QUESTIONS.md"
      })
    );
  }

  console.log(JSON.stringify({ msg: "migrations_complete", owner_seed: "ensured" }));
} finally {
  await adminPool.end();
}
