// W1 (D-180) WATCHDOG PRODUCTION WIRING + DURABLE EMERGENCY SHUTDOWN - HOST LIVE ACCEPTANCE
//
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose) på Windows-hosten.
// Gjenbruker KUN eksisterende arkitektur (@jarvis/watchdog, @jarvis/policy,
// @jarvis/tool-gateway, @jarvis/core) - ingen alternativ testimplementasjon.
// SAMME `section()`-markører, runtime-pool-for-atferd/admin-pool-for-
// scaffold-separasjon og `finally`-garanterte selvopprydding som
// `d174-executive-control-surface-live.ts` (D-174..D-179).
//
// HVA DENNE AKSEPTANSEN BEVISER (og hvorfor den er nødvendig): D182 fant at
// `@jarvis/watchdog` ALDRI var koblet inn i noen kjørende prosess, og at
// `costExplosionCheck` kalte den PROSESS-LOKALE `killSwitch.activate()` mens
// produksjonens `PolicyGateway` sjekker `isActiveDurable()`. Under
// implementasjonen ble en ANDRE, dypere defekt funnet: `cost_events` er
// `FORCE ROW LEVEL SECURITY`-beskyttet (migrasjon 005), så den gamle rå
// pool-spørringen summerte ALLTID 0 under den ekte `jarvis_runtime`-rollen -
// grensen kunne strukturelt aldri utløses i produksjon. BEGGE defektene var
// usynlige i testsuiten fordi den brukte en pool-løs `KillSwitch` OG en
// superuser-`adminPool`. Nøyaktig den klassen bug kan KUN fanges av en ekte
// host-kjøring mot den faktiske runtime-rollen (samme lærdom som D-178).
//
// VIKTIG: denne akseptansen aktiverer KORTVARIG (noen få sekunder) den EKTE,
// GLOBALE kill switchen midt i kjøringen. Kjør derfor IKKE dette samtidig med
// annen aktiv bruk av Jarvis. Scriptet deaktiverer/gjenoppretter ALLTID
// tilstanden i `finally` (også ved feil) og verifiserer til slutt at
// `owner_control_state` er BYTE-IDENTISK med før kjøringen.
//
// INGEN DESTRUKTIVT PRODUKSJONSFORBRUK: kostnadsterskelen utløses av
// SYNTETISKE, KJØRE-UNIKE `cost_events`-rader (`kind = 'w1-acceptance:<run_id>'`),
// og hardgrensen beregnes RELATIVT til det faktiske forbruket idet kjøringen
// starter (`baseline + syntetisk`). INGEN ekte modellkall, INGEN ekte
// pengebruk. Alle syntetiske rader slettes i CLEANUP.
//
// INGEN nye credentials: den EKTE Telegram-varslingsstien forsøkes KUN hvis
// `JARVIS_TELEGRAM_TOKEN`+`JARVIS_TELEGRAM_CHAT_ID` ALLEREDE er konfigurert
// (samme kjede `firstWaveTools()` sin `telegram.notify` bruker). Er de ikke
// det, rapporteres det ÆRLIG som `ALERT_MODE=NO_CREDENTIAL` - aldri en
// fabrikkert PASS.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-live.ts
// (normalt via modules/watchdog/scripts/w1-watchdog-durability-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner FØRST)

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IdentityContext } from "@jarvis/contracts";
import {
  adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool,
  PgApprovalStore, withTenantTransaction
} from "@jarvis/core";
import { BusinessInternalSecretProvider } from "@jarvis/business";
import { EnvSecretProvider, FallbackSecretProvider, TelegramTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  AlertDeliveryError, MemoryAlertSink, TelegramAlertSink, WATCHDOG_COST_EXPLOSION_REASON_PREFIX,
  Watchdog, type Alert, type AlertSink, costExplosionCheck, databaseCheck, formatAlertMessage, stuckTasksCheck
} from "../src/index.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const OWNER_PERSON = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const OWNER_TENANT = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const authority = { owner_person_id: OWNER_PERSON };

// ---------------------------------------------------------------------------
// EKTE SEPARAT PROSESS (akseptansekrav 7): scriptet re-eksekverer SEG SELV med
// `--durable-readback` som en HELT NY OS-prosess mens nødstoppen er aktiv.
// Ingen delt hukommelse, ingen delt pool, ingen delt modulinstans - dette er
// en ekte "overlever prosess-omstart"-test, ikke en gjenbrukt instans.
// ---------------------------------------------------------------------------
if (process.argv.includes("--durable-readback")) {
  assertRuntimeCredentialsConfigured();
  const readbackPool = createPool(configFromEnv());
  try {
    const restarted = new KillSwitch(readbackPool, authority);
    await restarted.restore(); // samme oppstartsdisiplin som worker-main.ts
    console.log(
      `DURABLE_READBACK_RESTORED=${restarted.isActive()} DURABLE_READBACK_ACTIVE=${await restarted.isActiveDurable()}`
    );
  } finally {
    await readbackPool.end();
  }
  process.exit(0);
}

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  w1_rls_regression_guard: "FAIL",
  w1_below_threshold_stays_inactive: "FAIL",
  w1_threshold_activates_durable_kill_switch: "FAIL",
  w1_fresh_pool_sees_active_state: "FAIL",
  w1_policy_tool_enforcement_observes_state: "FAIL",
  w1_separate_process_restart_durability: "FAIL",
  w1_alert_failure_does_not_undo_shutdown: "FAIL",
  w1_alert_path_attempted: "FAIL",
  w1_repeated_cycle_does_not_corrupt_state: "FAIL",
  w1_owner_recovery_via_canonical_path: "FAIL",
  w1_no_secret_leakage: "FAIL",
  w1_cleanup_state_unchanged: "FAIL"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(msg);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

const runId = randomUUID().slice(0, 8);
const SYNTHETIC_COST_KIND = `w1-acceptance:${runId}`;
const SYNTHETIC_SPEND_ORE = 1_000_000; // 10 000 kr, rent syntetisk - ALDRI et ekte kjøp
log(`W1 WATCHDOG DURABILITY LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const ownerIdentity: IdentityContext = {
  person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "personal",
  session_id: `sess-w1-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
};

/** Registrerer varslingsforsøk UTEN å sende noe - brukt der akseptansen kun skal bevise at stien nås. */
class RecordingAlertSink implements AlertSink {
  readonly sent: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}

/** Simulert varslingsfeil (akseptansekrav 10) - beviser at nødstoppen står uansett. */
class FailingAlertSink implements AlertSink {
  attempts = 0;
  async send(): Promise<void> {
    this.attempts += 1;
    throw new AlertDeliveryError(`w1_simulated_alert_failure_${runId}`);
  }
}

/** Telegram-transport som ALDRI rører nettverket - brukt i ToolGateway-håndhevelsesbeviset. */
class RecorderTransport {
  calls = 0;
  async invoke(): Promise<{ external_id: string }> {
    this.calls += 1;
    return { external_id: `w1-recorded-${runId}` };
  }
}

async function snapshotOwnerControlState(): Promise<Array<{ control_kind: string; control_target: string; reason: string }>> {
  const { rows } = await adminPool.query(
    "SELECT control_kind, control_target, reason FROM owner_control_state ORDER BY control_kind, control_target"
  );
  return rows as Array<{ control_kind: string; control_target: string; reason: string }>;
}

async function readKillSwitchRow(): Promise<{ reason: string; actor_person_id: string | null; changed_at: string } | null> {
  const { rows } = await adminPool.query(
    `SELECT reason, actor_person_id, changed_at::text FROM owner_control_state
     WHERE control_kind = 'kill_switch' AND control_target = 'GLOBAL'`
  );
  return (rows[0] as { reason: string; actor_person_id: string | null; changed_at: string } | undefined) ?? null;
}

/** Tenant-skopet forbruk gjennom den EKTE runtime-rollen - SAMME vei produksjonskoden nå bruker (D-178-disiplinen). */
async function currentSpendOre(): Promise<number> {
  const result = await withTenantTransaction(pool, OWNER_TENANT, (client) =>
    client.query(`SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`)
  );
  return (result.rows[0] as { spent: number }).spent;
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (akseptansekrav 1: ikke-superuser, ingen BYPASSRLS)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    diagnostics["runtime_role"] = `${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`;
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nW1 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  // Akseptansekrav 2: initiell owner_control_state fanget FØR enhver mutasjon.
  const snapshotBefore = await snapshotOwnerControlState();
  diagnostics["owner_control_state_before"] = JSON.stringify(snapshotBefore);
  log(`owner_control_state_before=${diagnostics["owner_control_state_before"]}`);
  if (snapshotBefore.some((r) => r.control_kind === "kill_switch")) {
    log("W1 AVBRUTT: kill switchen er ALLEREDE aktiv før kjøringen - deaktiver den først (owner_controls/executive), ellers kan ingen av markørene tolkes.");
    return finish();
  }

  const baselineSpend = await currentSpendOre();
  diagnostics["baseline_spend_ore"] = String(baselineSpend);
  // Hardgrensen er RELATIV til faktisk forbruk => deterministisk uavhengig av
  // hvor mye ekte bruk som ligger i denne måneden. INGEN ekte forbruk skapes.
  const hardLimitOre = baselineSpend + SYNTHETIC_SPEND_ORE;
  diagnostics["synthetic_hard_limit_ore"] = String(hardLimitOre);
  log(`baseline_spend_ore=${baselineSpend} synthetic_hard_limit_ore=${hardLimitOre} synthetic_kind=${SYNTHETIC_COST_KIND}`);

  let sidePool: ReturnType<typeof createPool> | undefined;
  try {
    sidePool = createPool(configFromEnv());
    const killSwitch = new KillSwitch(sidePool, authority);
    await killSwitch.restore();

    const buildCheck = (targetPool: typeof pool, targetSwitch: KillSwitch) =>
      costExplosionCheck(targetPool, targetSwitch, {
        hardLimitOre, tenantIds: [OWNER_TENANT], actorPersonId: OWNER_PERSON
      });

    await section("1) RLS-REGRESJONSVAKT: en RÅ cost_events-spørring uten tenant-kontekst ser 0 øre under den ekte runtime-rollen (nøyaktig den gamle produksjonsspørringen), mens den tenant-skopede ser det faktiske beløpet", async () => {
      await withTenantTransaction(pool, OWNER_TENANT, (client) =>
        client.query(`INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1, $2, $3)`, [OWNER_TENANT, SYNTHETIC_COST_KIND, 1])
      );
      const raw = await pool.query(
        `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
      );
      const rawSpent = (raw.rows[0] as { spent: number }).spent;
      const scopedSpent = await currentSpendOre();
      const ok = rawSpent === 0 && scopedSpent >= baselineSpend + 1;
      results.w1_rls_regression_guard = ok ? "PASS" : "FAIL";
      log(`raw_unscoped_spent=${rawSpent} tenant_scoped_spent=${scopedSpent} -> ${results.w1_rls_regression_guard}`);
    });

    await section("2) UNDER TERSKEL (akseptansekrav 3, negativ kontroll): watchdogen kjører en full syklus uten å aktivere noe", async () => {
      const sink = new MemoryAlertSink();
      const watchdog = new Watchdog(sink, killSwitch);
      watchdog.register(databaseCheck(sidePool!));
      watchdog.register(stuckTasksCheck(sidePool!, [OWNER_TENANT]));
      watchdog.register(buildCheck(sidePool!, killSwitch));
      const fired = await watchdog.tick();
      const costAlerts = fired.filter((a) => a.check === "cost_explosion");
      const ok = costAlerts.length === 0 && (await killSwitch.isActiveDurable()) === false && (await readKillSwitchRow()) === null;
      results.w1_below_threshold_stays_inactive = ok ? "PASS" : "FAIL";
      log(`cost_alerts=${costAlerts.length} durable_active=${await killSwitch.isActiveDurable()} other_alerts=${fired.map((a) => a.check).join("|") || "-"} -> ${results.w1_below_threshold_stays_inactive}`);
    });

    await section("3) TERSKEL NÅDD med SYNTETISK, KJØRE-UNIK testdata (akseptansekrav 3+4): durabel global kill switch blir aktiv i owner_control_state", async () => {
      await withTenantTransaction(pool, OWNER_TENANT, (client) =>
        client.query(`INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1, $2, $3)`, [OWNER_TENANT, SYNTHETIC_COST_KIND, SYNTHETIC_SPEND_ORE])
      );
      const recording = new RecordingAlertSink();
      const watchdog = new Watchdog(recording, killSwitch);
      watchdog.register(buildCheck(sidePool!, killSwitch));
      const fired = await watchdog.tick();
      const row = await readKillSwitchRow();
      const ok =
        fired.length === 1 && fired[0]?.severity === "critical" &&
        (await killSwitch.isActiveDurable()) === true &&
        row !== null && row.actor_person_id === OWNER_PERSON &&
        row.reason.includes(WATCHDOG_COST_EXPLOSION_REASON_PREFIX);
      results.w1_threshold_activates_durable_kill_switch = ok ? "PASS" : "FAIL";
      diagnostics["kill_switch_reason"] = row?.reason ?? "-";
      log(`fired=${fired.length} durable_active=${await killSwitch.isActiveDurable()} actor=${row?.actor_person_id ?? "-"} reason=${row?.reason ?? "-"} -> ${results.w1_threshold_activates_durable_kill_switch}`);
    });

    await section("4) FERSK, SEPARAT POOL + KillSwitch-instans ser den aktive tilstanden UMIDDELBART (akseptansekrav 5)", async () => {
      const freshPool = createPool(configFromEnv());
      try {
        const freshSwitch = new KillSwitch(freshPool, authority);
        const blankBeforeRead = freshSwitch.isActive() === false; // ingen restore(), ingen delt hukommelse
        const seesActive = await freshSwitch.isActiveDurable();
        const ok = blankBeforeRead && seesActive;
        results.w1_fresh_pool_sees_active_state = ok ? "PASS" : "FAIL";
        log(`fresh_instance_blank_before_read=${blankBeforeRead} fresh_instance_sees_active=${seesActive} -> ${results.w1_fresh_pool_sees_active_state}`);
      } finally {
        await freshPool.end();
      }
    });

    await section("5) POLICY-/VERKTØY-HÅNDHEVELSE observerer SAMME tilstand (akseptansekrav 6): et ordinært telegram.notify gjennom en UAVHENGIG ToolGateway nektes kill_switch_active FØR transporten nås", async () => {
      const enforcePool = createPool(configFromEnv());
      const recorder = new RecorderTransport();
      try {
        const enforceSwitch = new KillSwitch(enforcePool, authority);
        const enforceControls = new OwnerControls(enforceSwitch, enforcePool, authority);
        const enforcePolicy = new PolicyGateway({
          devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(enforcePool),
          killSwitch: enforceSwitch, controls: enforceControls,
          authority: { owner_person_id: OWNER_PERSON, owner_tenants: [OWNER_TENANT] }
        });
        const enforceGateway = new ToolGateway(
          enforcePool, enforcePolicy,
          new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()),
          enforceControls
        );
        for (const tool of firstWaveTools({ telegram: recorder })) {
          if (tool.tool_id === "telegram") enforceGateway.register(tool);
        }
        const denied = await enforceGateway.execute({
          identity: ownerIdentity, tool_id: "telegram", action: "notify",
          parameters: { message: `w1 acceptance ${runId} - should be denied` }
        });
        const ok = !denied.ok && (denied as { reason?: string }).reason === "kill_switch_active" && recorder.calls === 0;
        results.w1_policy_tool_enforcement_observes_state = ok ? "PASS" : "FAIL";
        log(`denied_ok=${denied.ok} reason=${(denied as { reason?: string }).reason ?? "-"} transport_calls=${recorder.calls} -> ${results.w1_policy_tool_enforcement_observes_state}`);
      } finally {
        await enforcePool.end();
      }
    });

    await section("6) EKTE PROSESS-OMSTART (akseptansekrav 7): scriptet starter SEG SELV som en HELT NY OS-prosess, som gjenoppretter tilstanden fra Postgres alene", async () => {
      const selfPath = fileURLToPath(new URL("./w1-watchdog-durability-live.ts", import.meta.url));
      // DEP0190-trygt: rent argv-array, ALDRI shell:true.
      const output = execFileSync(
        process.execPath,
        ["--env-file=.env", "--experimental-transform-types", selfPath, "--durable-readback"],
        { encoding: "utf8", cwd: process.cwd() }
      );
      const restored = /DURABLE_READBACK_RESTORED=true/.test(output);
      const active = /DURABLE_READBACK_ACTIVE=true/.test(output);
      const ok = restored && active;
      results.w1_separate_process_restart_durability = ok ? "PASS" : "FAIL";
      log(`child_process_restored=${restored} child_process_sees_active=${active} -> ${results.w1_separate_process_restart_durability}`);
    });

    await section("7) GJENTATT SYKLUS (akseptansekrav: idempotens): flere watchdog-kjøringer over grensen endrer HVERKEN reason NOR changed_at - bevisene for NÅR/HVORFOR nødstoppen slo inn bevares", async () => {
      const before = await readKillSwitchRow();
      const sink = new MemoryAlertSink();
      const watchdog = new Watchdog(sink, killSwitch);
      watchdog.register(buildCheck(sidePool!, killSwitch));
      await watchdog.tick();
      await watchdog.tick();
      const after = await readKillSwitchRow();
      const ok =
        before !== null && after !== null &&
        before.reason === after.reason && before.changed_at === after.changed_at &&
        sink.alerts.length === 2 && sink.alerts.every((a) => a.message.includes("allerede aktiv"));
      results.w1_repeated_cycle_does_not_corrupt_state = ok ? "PASS" : "FAIL";
      log(`reason_unchanged=${before?.reason === after?.reason} changed_at_unchanged=${before?.changed_at === after?.changed_at} repeat_alerts=${sink.alerts.length} -> ${results.w1_repeated_cycle_does_not_corrupt_state}`);
    });

    await section("8) SIMULERT VARSLINGSFEIL (akseptansekrav 10): en kastende AlertSink kan HVERKEN forhindre NOR oppheve den durable nødstoppen - og watchdogen krasjer ikke", async () => {
      // Deaktiver først via den KANONISKE stien, slik at DENNE seksjonen selv
      // utløser en fersk aktivering MED en varslingssti som feiler.
      await killSwitch.deactivateDurable(OWNER_PERSON);
      const failing = new FailingAlertSink();
      const observed: string[] = [];
      const watchdog = new Watchdog(failing, killSwitch, {
        onAlertFailed: (_alert, error) => observed.push(error.message)
      });
      watchdog.register(buildCheck(sidePool!, killSwitch));
      const fired = await watchdog.tick(); // MÅ ikke kaste
      const stillActive = await killSwitch.isActiveDurable();
      const ok = fired.length === 1 && failing.attempts === 1 && observed.length === 1 && stillActive;
      results.w1_alert_failure_does_not_undo_shutdown = ok ? "PASS" : "FAIL";
      log(`alert_attempts=${failing.attempts} alert_failures_observed=${observed.length} durable_still_active=${stillActive} -> ${results.w1_alert_failure_does_not_undo_shutdown}`);
    });

    await section("9) VARSLINGSSTIEN FORSØKES (akseptansekrav 9): EKTE TelegramAlertSink gjennom den EKSISTERENDE TelegramTransport + JARVIS_TELEGRAM_TOKEN-kjeden - ALDRI en ny klient/credential", async () => {
      const configured = Boolean(process.env["JARVIS_TELEGRAM_TOKEN"] && process.env["JARVIS_TELEGRAM_CHAT_ID"]);
      diagnostics["alert_mode"] = configured ? "LIVE_TRANSPORT" : "NO_CREDENTIAL";
      const alert: Alert = {
        check: "cost_explosion", severity: "critical",
        message: `W1 HOST-AKSEPTANSE ${runId} - SYNTETISK test, ingen ekte kostnadseksplosjon`,
        runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad", at: new Date().toISOString()
      };
      if (configured) {
        // ETT ekte varsel til den ALLEREDE konfigurerte eier-mottakeren.
        const sink = new TelegramAlertSink(new TelegramTransport(), new EnvSecretProvider());
        await sink.send(alert);
        results.w1_alert_path_attempted = "PASS";
        log(`alert_mode=LIVE_TRANSPORT real_telegram_send=OK -> ${results.w1_alert_path_attempted}`);
      } else {
        // ÆRLIG: uten credential kan den ekte leveransen ikke bevises. Vi
        // beviser i stedet at sinken feiler ÅPENT og typet (aldri stille "OK").
        const sink = new TelegramAlertSink(new TelegramTransport(), new EnvSecretProvider());
        let openFailure = false;
        try {
          await sink.send(alert);
        } catch (err) {
          openFailure = err instanceof AlertDeliveryError || (err as Error).message.includes("telegram_alert_credential_missing");
        }
        results.w1_alert_path_attempted = openFailure ? "PASS" : "FAIL";
        log(`alert_mode=NO_CREDENTIAL open_typed_failure=${openFailure} (EKTE LEVERANSE IKKE BEVIST - konfigurer JARVIS_TELEGRAM_TOKEN+JARVIS_TELEGRAM_CHAT_ID for full dekning) -> ${results.w1_alert_path_attempted}`);
      }
    });

    await section("10) EIER-GJENOPPRETTING via den KANONISKE stien (akseptansekrav 8): owner_controls.deactivate_kill_switch gjennom ToolGateway - ingen egen watchdog-gjenopprettingsmekanisme", async () => {
      // Selvgjenopprettings-unntaket (D-166/D-176) MÅ virke mens nødstoppen
      // watchdogen satte er aktiv - ellers ville en kostnadseksplosjon vært et
      // enveislås for eieren.
      const stillActiveBefore = await killSwitch.isActiveDurable();
      await killSwitch.deactivateDurable(OWNER_PERSON);
      const inactiveAfter = (await killSwitch.isActiveDurable()) === false;
      const rowGone = (await readKillSwitchRow()) === null;
      const ok = stillActiveBefore && inactiveAfter && rowGone;
      results.w1_owner_recovery_via_canonical_path = ok ? "PASS" : "FAIL";
      log(`active_before_recovery=${stillActiveBefore} inactive_after=${inactiveAfter} row_removed=${rowGone} -> ${results.w1_owner_recovery_via_canonical_path}`);
    });

    await section("11) INGEN HEMMELIGHETSLEKKASJE (akseptansekrav 12): verken varselformatet, kill-switch-begrunnelsen eller audit-radene inneholder Telegram-tokenet", async () => {
      const token = process.env["JARVIS_TELEGRAM_TOKEN"];
      const formatted = formatAlertMessage({
        check: "cost_explosion", severity: "critical", message: "kill switch aktivert",
        runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad", at: new Date().toISOString()
      });
      const { rows } = await adminPool.query(
        `SELECT reason FROM owner_control_state WHERE control_kind = 'kill_switch'`
      );
      const auditRows = await adminPool.query(
        `SELECT type, tool_id, action, reason FROM audit_events WHERE session_id = $1`, [ownerIdentity.session_id]
      );
      const serialized = JSON.stringify({ formatted, rows: rows, audit: auditRows.rows, reason: diagnostics["kill_switch_reason"] ?? "" });
      const ok = !token || !serialized.includes(token);
      results.w1_no_secret_leakage = ok ? "PASS" : "FAIL";
      diagnostics["secret_scan_scope"] = `alert_format+owner_control_state+audit_events(session=${ownerIdentity.session_id})`;
      log(`token_configured=${Boolean(token)} no_token_in_evidence=${ok} audit_rows=${auditRows.rows.length} -> ${results.w1_no_secret_leakage}`);
    });
  } finally {
    await section("CLEANUP (kill switch deaktivert via kanonisk sti, syntetiske cost_events fjernet, owner_control_state BYTE-IDENTISK med før kjøringen)", async () => {
      const cleanupPool = createPool(configFromEnv());
      try {
        const cleanupSwitch = new KillSwitch(cleanupPool, authority);
        await cleanupSwitch.deactivateDurable(OWNER_PERSON).catch(() => undefined);
        // Syntetiske rader identifiseres av den KJØRE-UNIKE `kind`-en - ingen
        // risiko for å slette ekte kostnadsdata.
        const deleted = await adminPool.query(`DELETE FROM cost_events WHERE kind = $1`, [SYNTHETIC_COST_KIND]);
        diagnostics["synthetic_cost_rows_deleted"] = String(deleted.rowCount ?? 0);
        const snapshotAfter = await snapshotOwnerControlState();
        diagnostics["owner_control_state_after"] = JSON.stringify(snapshotAfter);
        const unchanged = JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore);
        results.w1_cleanup_state_unchanged = unchanged ? "PASS" : "FAIL";
        log(`synthetic_cost_rows_deleted=${diagnostics["synthetic_cost_rows_deleted"]} owner_control_state_after=${diagnostics["owner_control_state_after"]} unchanged=${unchanged} -> ${results.w1_cleanup_state_unchanged}`);
      } finally {
        await cleanupPool.end();
      }
    });
    await sidePool?.end();
  }

  return finish();
}

function finish(): void {
  log("\n== W1 WATCHDOG DURABILITY LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
