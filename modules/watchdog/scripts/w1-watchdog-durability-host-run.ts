// W1 (D-180) WATCHDOG PRODUCTION WIRING + DURABLE EMERGENCY SHUTDOWN - HOST RUN
//
// ÉN host-kommando som bootstrapper workspacet, sikrer et FERSKT
// migrate/api/worker-image fra gjeldende kildekode, kjører migrasjonene via
// admin-rollen, restarter api/worker på det ferske imaget, og kjører til
// slutt selve akseptansen (`w1-watchdog-durability-live.ts`). Speiler NØYAKTIG
// samme struktur som `d174-executive-control-surface-host-run.ts` - ingen ny
// mekanisme.
//
// `--force-recreate api worker` er her IKKE bare hygiene: den ferske
// worker-containeren er det FØRSTE stedet W1 sin produksjons-wiring
// (`apps/api/src/worker-main.ts`) faktisk kjører. Etter restarten skal
// worker-loggen inneholde `"msg":"jarvis-worker started"` med de NYE feltene
// `watchdog_interval_ms` og `watchdog_tenants` - det er den enkleste
// bekreftelsen på at watchdogen er koblet inn i den ekte prosessen:
//
//   docker compose --env-file .env -f infra/local/docker-compose.yml logs --tail=20 worker
//
// Selve akseptansen under restarter ALDRI containere midt i seg selv; den
// beviser prosess-omstart-durabilitet ved å starte SEG SELV som en helt ny
// OS-prosess (`--durable-readback`, se live-scriptets seksjon 6), og
// container-restart-durabiliteten for NØYAKTIG denne `owner_control_state`-
// raden er allerede bevist av K1/B1 (D-164/D-166).
//
// Kjøres PÅ HOSTEN (Windows + Docker Desktop), fra repo-roten:
//
//   node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-host-run.ts
//
// VIKTIG: akseptansen aktiverer KORTVARIG (noen få sekunder, to ganger) den
// EKTE, GLOBALE kill switchen. Kjør derfor IKKE dette samtidig med annen aktiv
// bruk av Jarvis. Scriptet deaktiverer/gjenoppretter ALLTID tilstanden i
// `finally` (også ved feil) og verifiserer til slutt at `owner_control_state`
// er byte-identisk med før kjøringen.
//
// INGEN destruktivt produksjonsforbruk: kostnadsterskelen utløses av
// SYNTETISKE, kjøre-unike `cost_events`-rader, og hardgrensen beregnes
// relativt til faktisk forbruk ved kjøringens start. Alle syntetiske rader
// slettes i CLEANUP. INGEN ekte modellkall, INGEN ekte pengebruk.
//
// Er `JARVIS_TELEGRAM_TOKEN`+`JARVIS_TELEGRAM_CHAT_ID` konfigurert, sender
// akseptansen ETT tydelig merket testvarsel til den ALLEREDE konfigurerte
// eier-mottakeren. Ingen ny credential kreves eller opprettes.
//
// Trygt å kjøre flere ganger (idempotent): `pnpm install --frozen-lockfile`
// er alltid trygt å re-kjøre, migrasjoner spores i `schema_migrations`
// (kjører aldri om igjen), Docker-images bygges alltid ferske. Sletter ALDRI
// Docker-volumer, databasedata, `.env` eller ekte business-/kundedata.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`[w1-watchdog-durability-host-run] ${msg}`);
}

// DEP0190-trygt: `execFileSync` kjøres ALLTID med et rent argv-array, ALDRI
// `shell: true` - Windows `.cmd`-shims håndteres av `buildSpawnInvocation()`.
function run(command: string, args: string[], cwd: string = repoRoot): void {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd });
}

function assertRepoRoot(): void {
  const workspaceFile = join(repoRoot, "pnpm-workspace.yaml");
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  if (!existsSync(workspaceFile) || !existsSync(composeFile)) {
    throw new Error(
      `Ikke kjørt fra repo-roten (fant ikke ${workspaceFile} og/eller ${composeFile}). ` +
        "Kjør kommandoen fra roten av jarvisbuild-repoet."
    );
  }
  log(`repo_root=PASS (${repoRoot})`);
}

function ensureWorkspaceInstalled(): void {
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const pinned = readPinnedPackageManager(packageJson);
  if (!pinned || pinned.name !== "pnpm") {
    throw new Error(`package.json sitt "packageManager"-felt mangler eller er ikke pnpm-basert: ${JSON.stringify(pinned)}`);
  }
  const resolved = resolvePackageManager(
    {
      platform: process.platform,
      pathEnv: process.env["PATH"] ?? process.env["Path"] ?? "",
      pathExt: process.env["PATHEXT"] ?? process.env["Pathext"] ?? "",
      exists: existsSync
    },
    pinned
  );
  log(`package_manager_resolution=PASS package_manager_driver=${resolved.driver} package_manager_version=${pinned.version}`);
  const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"]);
  run(invocation.command, invocation.args);
  log("install_frozen_lockfile=PASS workspace_install=PASS");
}

function ensurePostgresAndFreshImages(composeArgs: string[]): void {
  run("docker", [...composeArgs, "up", "-d", "postgres"]);
  log("bygger migrate/api/worker fra gjeldende kildekode (garanterer ferskt image, inkl. W1 sin worker-main-wiring)...");
  run("docker", [...composeArgs, "build", "migrate", "api", "worker"]);
}

function applyMigrationsAndRestart(composeArgs: string[]): void {
  // W1 legger IKKE til noen ny migrasjon (INGEN nytt schema - kun ny wiring/
  // kode). `migrate` kjøres likevel (idempotent, ufarlig) for å garantere at
  // DENNE kjøringen ser et fullt oppgradert schema, SAMME disiplin som alle
  // andre host-run-script i repoet.
  run("docker", [...composeArgs, "run", "--rm", "migrate"]);
  run("docker", [...composeArgs, "up", "-d", "--force-recreate", "api", "worker"]);
}

/** Den ENKLESTE bekreftelsen på at produksjons-wiringen faktisk kjører i den ekte worker-containeren. */
function showWorkerStartupLine(composeArgs: string[]): void {
  log("worker-oppstartslinje (se etter watchdog_interval_ms/watchdog_tenants - beviser at @jarvis/watchdog er koblet inn i den EKTE prosessen):");
  try {
    run("docker", [...composeArgs, "logs", "--tail=20", "worker"]);
  } catch {
    // Loggvisning er diagnostikk, ALDRI en akseptanse-blokker: selve beviset
    // er live-scriptets markører. En feilende `logs`-kommando skal ikke stoppe
    // kjøringen (og skjules derfor ikke - den logges her).
    log("ADVARSEL: klarte ikke å hente worker-logg (kun diagnostikk - akseptansen fortsetter).");
  }
}

function runWatchdogDurabilityAcceptance(): void {
  run("node", [
    "--env-file=.env", "--experimental-transform-types",
    "modules/watchdog/scripts/w1-watchdog-durability-live.ts"
  ]);
}

function main(): void {
  assertRepoRoot();
  ensureWorkspaceInstalled();

  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kopier .env.example til .env hvis den mangler helt.`);
  }
  const composeFile = join(repoRoot, "infra/local/docker-compose.yml");
  const composeArgs = ["compose", "--env-file", envPath, "-f", composeFile];

  ensurePostgresAndFreshImages(composeArgs);
  applyMigrationsAndRestart(composeArgs);
  showWorkerStartupLine(composeArgs);

  log("bootstrap fullført - kjører W1 Watchdog-durabilitets-akseptanse (w1-watchdog-durability-live.ts)...");
  runWatchdogDurabilityAcceptance();
}

try {
  main();
} catch (err) {
  console.error(`[w1-watchdog-durability-host-run] FEILET: ${(err as Error).message}`);
  process.exit(1);
}
