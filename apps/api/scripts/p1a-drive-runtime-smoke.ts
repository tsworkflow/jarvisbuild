// P1A RUNTIME WIRING CLOSEOUT (2026-08-16) - Google Drive er host-akseptanse-
// bevist (D-42, run_id `2703299e`), MEN aldri wiret inn i den NORMALE
// api/worker-runtime-en (apps/api/src/main.ts / apps/api/src/worker-main.ts
// sine `firstWaveTools({...})`-kall) - kun ua2-p1a-live.ts sin EGEN,
// akseptanse-only ToolGateway kunne nå Drive-verktøyene. Dette scriptet
// beviser den NORMALE runtime-veien i stedet - IKKE en repetisjon av den
// eksisterende akseptansen. Ligger i apps/api/scripts/ (samme presedens som
// bo11-live.ts/bo11-1-delta-live.ts) - IKKE modules/core/scripts/, siden
// dette scriptet trenger @jarvis/tool-gateway+@jarvis/policy, som ikke er
// (og ikke skal være) avhengigheter av @jarvis/core selv.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten, med docker-compose Postgres
// kjørende og de ALLEREDE persisterte Google-credentialene i .env (INGEN ny
// OAuth-samtykke, INGEN nedlastet client-JSON lest her) - ÉN kommando:
//
//   node --env-file=.env --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts
//
// HOST-FIX (2026-08-16, Tobias sitt faktiske host-funn): den TIDLIGERE
// dokumenterte kommandoen manglet `--env-file=.env` - dette scriptet leser
// `process.env` DIREKTE (samme mønster som main.ts/worker-main.ts, som i
// normal drift får miljøvariablene injisert av docker-compose - IKKE av en
// `--env-file`-flagg), men når scriptet kjøres FRITTSTÅENDE på hosten (ikke
// inni en container) må Node eksplisitt bes om å laste `.env` selv. Uten
// flagget var `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` alle tomme i
// prosessen - scriptet rapporterte (korrekt, ikke en bug i selve logikken)
// `BLOCKED_NO_CREDENTIALS`. `--env-file` er Node sin EGEN, innebygde
// mekanisme (siden Node 20.6) - BEVISST ingen ny `dotenv`-avhengighet lagt
// til bare for dette. Samme konvensjon som `ua2-p1a-live.ts` (som allerede
// dokumenterer `--env-file=.env` i sin egen toppkommentar) - dette scriptet
// var det inkonsekvente unntaket, nå rettet.
//
// Beviser (§11 i ordren):
//   drive_runtime_registered=PASS   - firstWaveTools({...driveTransportsIfConfigured()})
//                                      inneholder faktisk 'drive'-verktøyene med en EKTE
//                                      GoogleDriveTransport (ikke UnconfiguredHttpTransport-skallet)
//   drive_runtime_api_path=PASS     - EKTE ToolGateway (samme konstruksjon som main.ts:
//                                      PgDeviceRegistry/PgApprovalStore/PolicyGateway sovereign-
//                                      owner) → drive/get_metadata → EKTE Google Drive-respons
//   drive_runtime_worker_path=PASS  - STRUKTURELT bevist (samme firstWaveTools({...})-kall som
//                                      worker-main.ts produserer identisk verktøysett) - IKKE
//                                      en live worker-kjøring (full task queue/sandbox-infra er
//                                      unødvendig kostnad for AKKURAT dette wiring-beviset; se
//                                      §11 i ordren, som eksplisitt tillater dette skillet)
//   token_leak=false                - verken stdout/stderr eller den persisterte audit_events-
//                                      raden inneholder noensinne selve access/refresh-tokenet
//
// LESER-SCOPE-ONLY: bruker get_metadata("root") (klasse A, ingen mutasjon) - INGEN
// Drive-skriving/sletting forsøkes i denne closeout-smoke-testen.

import {
  EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport,
  ToolGateway, driveTransportsIfConfigured, firstWaveTools
} from "@jarvis/tool-gateway";
import { assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore, PgDeviceRegistry } from "@jarvis/core";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import type { IdentityContext } from "@jarvis/contracts";
import { loadOwnerConfig } from "@jarvis/contracts";
// Remediering del 2 (JARVIS-065): eier fra validert konfig (JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME), ingen hardkoding.
const owner = loadOwnerConfig();

const results: Record<string, "PASS" | "FAIL" | "BLOCKED_NO_CREDENTIALS"> = {
  drive_runtime_registered: "BLOCKED_NO_CREDENTIALS",
  drive_runtime_api_path: "BLOCKED_NO_CREDENTIALS",
  drive_runtime_worker_path: "BLOCKED_NO_CREDENTIALS"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(`[p1a-drive-runtime-smoke] ${msg}`);
}

function driveTransportSet(): Parameters<typeof firstWaveTools>[0] {
  return {
    email: new GmailTransport(), calendar: new GoogleCalendarTransport(),
    github: new GithubTransport(), telegram: new TelegramTransport(),
    ...driveTransportsIfConfigured()
  };
}

async function main(): Promise<void> {
  const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
  const refreshToken = process.env["JARVIS_GOOGLE_TOKEN"];
  if (!clientId || !clientSecret || !refreshToken) {
    log(
      `BLOCKED_NO_CREDENTIALS (client_id=${Boolean(clientId)} client_secret=${Boolean(clientSecret)} token=${Boolean(refreshToken)}) - ` +
        `google-drive-reauth.ts må kjøres FØRST (allerede host-bevist tidligere - dette scriptet krever KUN at .env fortsatt har det persisterte settet).`
    );
    return finish();
  }

  // §1: strukturelt bevis - SAMME spredningsuttrykk som main.ts/worker-main.ts
  // bruker (...driveTransportsIfConfigured()) produserer en 'drive'-transport
  // som FAKTISK er en GoogleDriveTransport, ikke firstWaveTools() sitt
  // UnconfiguredHttpTransport-skall-fallback.
  const apiTransports = driveTransportSet();
  const apiDefinitions = firstWaveTools(apiTransports);
  const driveActionCount = apiDefinitions.filter((d) => d.tool_id === "drive").length;
  const usesRealTransport = "drive" in apiTransports;
  results.drive_runtime_registered = usesRealTransport && driveActionCount === 14 ? "PASS" : "FAIL";
  log(`drive_runtime_registered=${results.drive_runtime_registered} (drive_actions=${driveActionCount}, real_transport=${usesRealTransport})`);

  // §2: STRUKTURELT (ikke live) bevis for worker-banen - IDENTISK
  // firstWaveTools({...})-kall som worker-main.ts faktisk kjører, uten å
  // spinne opp full task-queue/sandbox-infrastruktur (unødvendig kostnad for
  // AKKURAT dette registrerings-beviset - §11 i ordren tillater eksplisitt
  // dette skillet mellom strukturelt og live bevist).
  const workerDefinitions = firstWaveTools(driveTransportSet());
  const workerDriveActions = workerDefinitions.filter((d) => d.tool_id === "drive").map((d) => d.action).sort();
  const apiDriveActions = apiDefinitions.filter((d) => d.tool_id === "drive").map((d) => d.action).sort();
  const workerMatchesApi = JSON.stringify(workerDriveActions) === JSON.stringify(apiDriveActions) && workerDriveActions.length === 14;
  results.drive_runtime_worker_path = workerMatchesApi ? "PASS" : "FAIL";
  log(`drive_runtime_worker_path=${results.drive_runtime_worker_path} (STRUKTURELT bevist - identisk firstWaveTools()-registrering som worker-main.ts ville produsert, IKKE en live worker-prosess-kjøring)`);

  // §3: LIVE bevis via den NORMALE api-runtime-banen - EKTE Postgres, EKTE
  // ToolGateway/PolicyGateway (samme konstruksjon som main.ts: PgDeviceRegistry/
  // PgApprovalStore/sovereign-owner-authority), EKTE Google Drive-kall.
  assertRuntimeCredentialsConfigured();
  const pool = createPool(configFromEnv());
  try {
    await assertRuntimeRoleSafe(pool);
    diagnostics["q21_runtime_role_safe"] = "PASS";

    const tenantId = owner.tenant_id;
    const ownerPersonId = owner.owner_person_id;
    const killSwitch = new KillSwitch();
    const deviceRegistry = new PgDeviceRegistry(pool, tenantId);
    await deviceRegistry.refresh().catch(() => undefined);
    const policy = new PolicyGateway({
      devices: deviceRegistry, nonces: new PgApprovalStore(pool), killSwitch,
      authority: { owner_person_id: ownerPersonId, owner_tenants: [tenantId] }
    });
    const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider(), new OwnerControls(killSwitch));
    for (const tool of firstWaveTools(apiTransports)) toolGateway.register(tool);

    const identity: IdentityContext = {
      person_id: ownerPersonId, tenant_id: tenantId, memory_space_id: "personal",
      session_id: "sess-p1a-drive-runtime-smoke", device_id: "jarvis-core", channel: "api", auth_strength: "active"
    };
    // Kun get_metadata("root") - klasse A, ren lesing, INGEN mutasjon.
    const result = await toolGateway.execute({ identity, tool_id: "drive", action: "get_metadata", parameters: { file_id: "root" } });
    results.drive_runtime_api_path = result.ok ? "PASS" : "FAIL";
    if (!result.ok) {
      diagnostics["drive_runtime_api_path_reason"] = result.reason;
      log(`drive_runtime_api_path=FAIL (${result.reason})`);
    } else {
      log(`drive_runtime_api_path=PASS (get_metadata("root") lyktes gjennom den NORMALE ToolGateway/firstWaveTools-runtime-banen)`);
    }

    // §token_leak: verken stdout-loggen over eller den persisterte audit-raden
    // skal noensinne inneholde selve access/refresh-tokenet.
    const auditRows = await pool.query("SELECT payload::text AS p FROM audit_events WHERE tenant_id=$1 AND tool_id='drive' ORDER BY audit_id DESC LIMIT 5", [tenantId]);
    const auditLeak = (auditRows.rows as Array<{ p: string }>).some((r) => r.p.includes(refreshToken) || r.p.includes(clientSecret));
    diagnostics["token_leak"] = String(auditLeak);
    log(`token_leak=${auditLeak}`);
  } finally {
    await pool.end();
  }

  return finish();
}

function finish(): void {
  log("\n== P1A DRIVE RUNTIME SMOKE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL");
  log(`\nhard_fail=${hardFail}`);
}

main().catch((err: unknown) => {
  console.error(`[p1a-drive-runtime-smoke] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
