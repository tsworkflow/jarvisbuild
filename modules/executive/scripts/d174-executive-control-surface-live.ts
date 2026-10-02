// D-174 (B2+B3) UNIFIED OWNER CONTROL-SURFACE MUTATION COMPLETION - HOST LIVE ACCEPTANCE
//
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose) på Windows-hosten.
// Gjenbruker KUN eksisterende arkitektur (@jarvis/executive, @jarvis/owner-controls,
// @jarvis/finance, @jarvis/policy, @jarvis/tool-gateway, @jarvis/core) - ingen
// alternativ testimplementasjon. SAMME `section()`-markører, admin-pool-for-
// scaffold/runtime-pool-for-operasjoner-separasjon og selvopprydding som
// `k1-owner-control-authority-live.ts` (K1/B1, D-164/D-166) - denne akseptansen
// BYGGER PÅ K1/B1 (som allerede beviste api/worker-prosessparitet OG durabilitet
// over en EKTE container-restart), og beviser DERFOR IKKE de samme tingene på
// nytt. Den beviser KUN det B2+B3 la til: den SAMLEDE `executive.*`-
// mutasjonsflaten (owner_controls.*-gjennomslag, inkl. K1/B1-selvgjenoppretting
// FRA executive sin egen tool_id), finans-nødbryteren via executive, Wallester
// `activate_card` sin nødbryter-gating (B3-fiksen), og eier-vendt
// enhetstilbakekalling via `executive.revoke_device` (D-175, arkitekt-review
// 5250409538, BLOKKER B4: MÅL-TENANTEN er ALLTID den AUTENTISERTE
// `ownerIdentity.tenant_id`, ALDRI et kaller-oppgitt `tenant_id`-parameter -
// `owner_controls.revoke_device` sitt skjema har bevisst INGEN slikt felt).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/executive/scripts/d174-executive-control-surface-live.ts
// (normalt via modules/executive/scripts/d174-executive-control-surface-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner FØRST)
//
// INGEN ekte Wallester-/finans-provider-kall: `CardService` sin `gatewayFactory`
// er en INJISERT FAKE (se `buildFakeWallesterGatewayFactory()` under) - EKSAKT
// samme "fake KUN ved nettverksgrensen"-disiplin som
// `modules/finance/test/wallester-service.test.ts`. INGEN reelt pengetrekk,
// INGEN ekte kunde-/kortdata. `finance_kill_switch`/`provider_cards`/
// `card_events`/`card_spend_policies` rader denne kjøringen skaper er ALLE
// kjøre-unike (run_id-suffiks) og fjernes i CLEANUP.
//
// INGEN ekte connector/credential_ref utenom DEN ALLEREDE DELTE, interne
// `BUSINESS_INTERNAL_CREDENTIAL_REF`-en K1/B1 selv bruker - samme sentinel,
// samme kortvarige revoke/restore-vindu, samme `finally`-garanterte opprydding.
//
// INGEN ekte enhet: enhets-/sesjons-/grant-radene for tilbakekallingsbeviset er
// kjøre-unike (`device_id`/`session_id` med `runId`-suffiks) og fjernes i
// CLEANUP. `SYNTHETIC_CONNECTOR`/`SYNTHETIC_CREDENTIAL`/`SYNTHETIC_DEVICE`
// gjenbruker K1/B1 sitt "kun MÅLET er syntetisk, ALDRI eier-identiteten"-prinsipp.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import {
  adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, DeviceService, PgApprovalStore, SessionGrantService,
  withTenantTransaction
} from "@jarvis/core";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessInternalSecretProvider } from "@jarvis/business";
import { EnvSecretProvider, FallbackSecretProvider, firstWaveTools, ToolGateway } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { captureAuditWatermark, queryRunScopedOwnerControlsAudit } from "../../owner-controls/src/audit-evidence.ts";
import { OwnerControlsService } from "../../owner-controls/src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../../owner-controls/src/transport.ts";
import {
  CardService, FinanceService, FinanceTransport, WallesterFinanceTransport,
  type WallesterCardObject, type WallesterGateway
} from "@jarvis/finance";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import { requireProductionMutationConsent } from "../../core/scripts/lib/production-mutation-guard.ts";

// Remediering del 1 (JARVIS-086): mutates the live stack - refuses without explicit consent.
requireProductionMutationConsent("d174-executive-control-surface-live.ts");

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  d174_executive_activates_real_kill_switch: "FAIL",
  d174_executive_deactivate_self_recovery: "FAIL",
  d174_executive_restore_credential_self_recovery: "FAIL",
  d174_executive_combined_deadlock_recovery: "FAIL",
  d176_status_surface_survives_lockdown: "FAIL",
  d174_executive_negative_control_non_recovery_blocked: "FAIL",
  d174_finance_kill_switch_via_executive: "FAIL",
  d174_wallester_activate_card_blocked_before_provider_call: "FAIL",
  d174_wallester_spend_reducing_actions_still_allowed: "FAIL",
  d174_owner_facing_device_revocation: "FAIL",
  d174_device_revocation_durable_from_fresh_instance: "FAIL",
  d174_audit_evidence: "FAIL",
  d174_cleanup_state_unchanged: "FAIL"
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
log(`D-174 EXECUTIVE CONTROL-SURFACE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const OWNER_PERSON = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const OWNER_TENANT = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const ownerIdentity: IdentityContext = {
  person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "business",
  session_id: `sess-d174-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const SYNTHETIC_CONNECTOR = `d174_acceptance_connector_${runId}`;
const SYNTHETIC_DEVICE = `d174_acceptance_device_${runId}`;
const SYNTHETIC_SESSION = `d174_acceptance_session_${runId}`;
const authority = { owner_person_id: OWNER_PERSON, owner_tenants: [OWNER_TENANT] };

/** Skriptbar fake ved Wallester-transportens nettverksgrense - INGEN ekte provider-kall (se filhode). */
class ScriptedWallesterGateway implements Partial<WallesterGateway> {
  activateCalls = 0;
  blockCalls = 0;
  closeCalls = 0;
  onCreateCard = async (): Promise<WallesterCardObject> => ({
    id: `d174-wcard-${runId}`, status: "awaitingactivation", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null
  });
  async createCard(): Promise<WallesterCardObject> {
    return this.onCreateCard();
  }
  async activateCard(id: string): Promise<WallesterCardObject> {
    this.activateCalls++;
    return { id, status: "active", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async blockCard(id: string): Promise<WallesterCardObject> {
    this.blockCalls++;
    return { id, status: "blocked", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
  async closeCard(id: string): Promise<WallesterCardObject> {
    this.closeCalls++;
    return { id, status: "closed", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null };
  }
}
const wallesterFake = new ScriptedWallesterGateway();

async function buildStack(sidePool: pg.Pool): Promise<{
  killSwitch: KillSwitch;
  ownerControls: OwnerControls;
  gateway: ToolGateway;
  cardService: CardService;
  financeService: FinanceService;
}> {
  const killSwitch = new KillSwitch(sidePool, authority);
  const ownerControls = new OwnerControls(killSwitch, sidePool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(sidePool),
    killSwitch,
    controls: ownerControls,
    authority
  });
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const gateway = new ToolGateway(sidePool, policy, secrets, ownerControls);

  const grants = new SessionGrantService(sidePool);
  const ownerControlsService = new OwnerControlsService(killSwitch, ownerControls, { pool: sidePool, grants, devices: new DeviceService(sidePool), authority });
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(ownerControlsService))) gateway.register(tool);

  // D-176 (arkitekt-review 5251073737, BLOKKER B5): `executive.get_control_surface_status`
  // komponerer OGSÅ `situations.get_pause_state` - MÅ være registrert her for
  // at seksjon 4b under (lesing under lås) skal kunne bevise noe i det hele
  // tatt, ikke bare typecheck/registrere. Domenepause-tilstanden selv er
  // IKKE del av B5-funnet - kun at LESINGEN av den må overleve lås.
  const domainPauses = new DomainPauseRegistry(sidePool, authority);
  await domainPauses.restore();
  const situationEngine = new SituationEngine(sidePool, domainPauses, authority);
  for (const tool of situationsToolDefinitions(new SituationsTransport(situationEngine, domainPauses))) gateway.register(tool);

  const executiveService = new ExecutiveService(gateway);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(executiveService))) gateway.register(tool);

  const financeService = new FinanceService(sidePool);
  const cardService = new CardService(
    sidePool,
    { getCredentials: async () => ({ baseUrl: "https://wallester.invalid", apiKey: "fake", sign: () => "fake", accountId: "wacc-live-1", environment: "sandbox" }) },
    () => wallesterFake as unknown as WallesterGateway
  );
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(financeService, { getCredentials: async () => null }),
    finance_wallester: new WallesterFinanceTransport(cardService)
  })) {
    gateway.register(tool);
  }
  return { killSwitch, ownerControls, gateway, cardService, financeService };
}

async function snapshotOwnerControlState(): Promise<Array<{ control_kind: string; control_target: string; reason: string }>> {
  const { rows } = await adminPool.query("SELECT control_kind, control_target, reason FROM owner_control_state ORDER BY control_kind, control_target");
  return rows as Array<{ control_kind: string; control_target: string; reason: string }>;
}

// BLOKKER B7 (arkitekt-review 5252418219): `devices`/`sessions`/`session_grants`
// har `FORCE ROW LEVEL SECURITY` (migrasjon 053) - både USING og WITH CHECK
// krever `current_setting('jarvis.tenant_id', true)`. Under den EKTE host-
// runtime-rollen (`jarvis_runtime`, `bypassrls=false`, Q-21) MÅ derfor ALLE
// tre innsettinger skje inni SAMME `withTenantTransaction(sidePool, ...)` -
// en rå `sidePool.query(...)` uten tenant-kontekst feiler med "new row
// violates row-level security policy". `adminPool` brukes BEVISST IKKE her -
// poenget er å bevise korrekt oppførsel under den ekte runtime-rollen/RLS,
// ikke å omgå den for selve fiksturen.
async function seedDeviceGrant(sidePool: pg.Pool): Promise<void> {
  await withTenantTransaction(sidePool, OWNER_TENANT, async (client) => {
    await client.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ($1,$2,$3,'phone') ON CONFLICT (device_id) DO NOTHING`, [SYNTHETIC_DEVICE, OWNER_TENANT, OWNER_PERSON]);
    await client.query(
      `INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ($1,$2,$3,'api',$4) ON CONFLICT (session_id) DO NOTHING`,
      [SYNTHETIC_SESSION, OWNER_TENANT, OWNER_PERSON, SYNTHETIC_DEVICE]
    );
    await client.query(
      `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,$5,'business','api','active','d174-fake-fingerprint', now() + interval '1 hour')`,
      [`grt-d174-${runId}`, OWNER_TENANT, OWNER_PERSON, SYNTHETIC_DEVICE, SYNTHETIC_SESSION]
    );
  });
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nD-174 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  const snapshotBefore = await snapshotOwnerControlState();
  diagnostics["owner_control_state_before"] = JSON.stringify(snapshotBefore);
  const auditWatermark = await captureAuditWatermark(adminPool);
  diagnostics["audit_watermark_before_run"] = auditWatermark;
  log(`owner_control_state_before=${diagnostics["owner_control_state_before"]} audit_watermark_before_run=${auditWatermark}`);

  let sidePool: pg.Pool | undefined;
  let cardId: string | undefined;
  try {
    sidePool = createPool(configFromEnv());
    const stack = await buildStack(sidePool);

    await section("1) executive.activate_kill_switch aktiverer DEN EKTE, delte killSwitch - owner_controls.freeze_connector blokkeres reelt", async () => {
      const activated = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: `D-174 host-akseptanse ${runId}` } });
      const blocked = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "should-be-blocked" } });
      const ok = activated.ok && !blocked.ok && (blocked as { reason?: string }).reason === "kill_switch_active";
      results.d174_executive_activates_real_kill_switch = ok ? "PASS" : "FAIL";
      log(`activate_ok=${activated.ok} blocked_ok=${blocked.ok} blocked_reason=${(blocked as { reason?: string }).reason ?? "-"} -> ${results.d174_executive_activates_real_kill_switch}`);
    });

    await section("2) executive.deactivate_kill_switch GJENOPPRETTER selv mens kill switchen er aktiv (D-174-unntaket)", async () => {
      const deactivated = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      const nowAllowed = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "recovered" } });
      const unfrozen = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } });
      const ok = deactivated.ok && nowAllowed.ok && unfrozen.ok;
      results.d174_executive_deactivate_self_recovery = ok ? "PASS" : "FAIL";
      log(`deactivate_ok=${deactivated.ok} recovered_ok=${nowAllowed.ok} unfreeze_ok=${unfrozen.ok} -> ${results.d174_executive_deactivate_self_recovery}`);
    });

    await section("3) executive.restore_credential GJENOPPRETTER selv mens den delte BUSINESS_INTERNAL_CREDENTIAL_REF er tilbakekalt (ToolGateway sitt unntak)", async () => {
      const revoked = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: `D-174 host ${runId}` } });
      const blocked = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "should-be-blocked" } });
      const restored = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      const nowAllowed = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "recovered" } });
      const unfrozen = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } });
      const ok = revoked.ok && !blocked.ok && (blocked as { reason?: string }).reason === "credential_revoked" && restored.ok && nowAllowed.ok && unfrozen.ok;
      results.d174_executive_restore_credential_self_recovery = ok ? "PASS" : "FAIL";
      log(`revoke_ok=${revoked.ok} blocked_ok=${blocked.ok} restore_ok=${restored.ok} recovered_ok=${nowAllowed.ok} -> ${results.d174_executive_restore_credential_self_recovery}`);
    });

    await section("4) SAMTIDIG deadlock (kill switch aktiv OG delt credential tilbakekalt), BEGGE gjenopprettet via executive.* i strengeste rekkefølge (restore_credential FØRST)", async () => {
      await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: `D-174 deadlock ${runId}` } });
      await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, reason: `D-174 deadlock ${runId}` } });
      const restoreFirst = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
      const deactivateSecond = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      const nowAllowed = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "recovered" } });
      const unfrozen = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } });
      const ok = restoreFirst.ok && deactivateSecond.ok && nowAllowed.ok && unfrozen.ok;
      results.d174_executive_combined_deadlock_recovery = ok ? "PASS" : "FAIL";
      log(`restore_first_ok=${restoreFirst.ok} deactivate_second_ok=${deactivateSecond.ok} recovered_ok=${nowAllowed.ok} -> ${results.d174_executive_combined_deadlock_recovery}`);
    });

    await section(
      "4b) D-176 (arkitekt-review 5251073737, BLOKKER B5; RETTET BLOKKER B6, arkitekt-review 5252077633): executive.get_control_surface_status LYKKES og rapporterer SANNFERDIG under BEGGE lås-tilstandene samtidig (kill switch aktiv OG delt credential tilbakekalt) - FØR gjenoppretting; ORDINÆR handling forblir NEKTET gjennom hele lås-vinduet; gjenoppretter deretter via executive.*",
      async () => {
        type StatusData = { owner_control: { kill_switch: { active: boolean; reason: string | null }; revoked_credentials: Array<{ credential_ref: string }> } };
        const readStatus = () => stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "get_control_surface_status", parameters: {} });

        // BLOKKER B6 (arkitekt-review 5252077633): BEGGE lås-tilstandene MÅ settes DIREKTE via det
        // kanoniske durable laget - EKSAKT samme funn/fiks som D-176 sin "I"-testsuite allerede måtte
        // gjøre (se service-transport.test.ts test C/D sine kommentarer for full begrunnelse). INGEN
        // rekkefølge av `executive.*`-kall kan oppnå dette: `activate_kill_switch` deler SELV
        // `BUSINESS_INTERNAL_CREDENTIAL_REF` (nektes av `credential_revoked` om refen allerede er
        // tilbakekalt), OG `revoke_credential` er selv IKKE unntatt kill-switch-sjekken (nektes av
        // `kill_switch_active` om kill switchen allerede er aktiv). Enkelt-lås-bevis via EKTE
        // `executive.*`-mutasjoner finnes ALLEREDE andre steder i dette scriptet (seksjon 1 for kill
        // switch alene, seksjon 3 for tilbakekalt credential alene) - DENNE seksjonen beviser KUN det
        // som er unikt for D-176: at LESINGEN OG gjenopprettingen fungerer korrekt NÅR begge allerede
        // er aktive samtidig.
        await stack.killSwitch.activateDurable(`D-176 host 4b-both ${runId}`, OWNER_PERSON);
        await stack.ownerControls.revokeCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, `D-176 host 4b-both ${runId}`, OWNER_PERSON);

        const statusUnderBoth = await readStatus();
        const bothStepOk =
          statusUnderBoth.ok &&
          (statusUnderBoth.data as unknown as StatusData).owner_control.kill_switch.active === true &&
          (statusUnderBoth.data as unknown as StatusData).owner_control.revoked_credentials.some((c) => c.credential_ref === BUSINESS_INTERNAL_CREDENTIAL_REF);

        const blockedDuringLock = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "should-stay-blocked-during-4b" } });
        const blockedOk = !blockedDuringLock.ok && (blockedDuringLock as { reason?: string }).reason === "kill_switch_active";

        const restored = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "restore_credential", parameters: { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF } });
        const deactivated = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
        const statusAfterRecovery = await readStatus();
        const clearedOk =
          statusAfterRecovery.ok &&
          (statusAfterRecovery.data as unknown as StatusData).owner_control.kill_switch.active === false &&
          !(statusAfterRecovery.data as unknown as StatusData).owner_control.revoked_credentials.some((c) => c.credential_ref === BUSINESS_INTERNAL_CREDENTIAL_REF);

        const ok = bothStepOk && blockedOk && restored.ok && deactivated.ok && clearedOk;
        results.d176_status_surface_survives_lockdown = ok ? "PASS" : "FAIL";
        log(
          `status_under_both_ok=${bothStepOk} ordinary_action_blocked=${blockedOk} restore_ok=${restored.ok} deactivate_ok=${deactivated.ok} status_cleared_ok=${clearedOk} -> ${results.d176_status_surface_survives_lockdown}`
        );
      }
    );

    await section("5) NEGATIV KONTROLL: executive.freeze_connector/revoke_credential (IKKE de tre navngitte gjenopprettingshandlingene) forblir BLOKKERT mens kill switchen er aktiv", async () => {
      await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "activate_kill_switch", parameters: { reason: `D-174 negative-control ${runId}` } });
      const freeze = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "should-stay-blocked" } });
      const revoke = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "revoke_credential", parameters: { credential_ref: "some-other-ref", reason: "should-stay-blocked" } });
      const deactivated = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "deactivate_kill_switch", parameters: {} });
      const ok =
        !freeze.ok && (freeze as { reason?: string }).reason === "kill_switch_active" &&
        !revoke.ok && (revoke as { reason?: string }).reason === "kill_switch_active" &&
        deactivated.ok;
      results.d174_executive_negative_control_non_recovery_blocked = ok ? "PASS" : "FAIL";
      log(`freeze_blocked=${!freeze.ok} revoke_blocked=${!revoke.ok} deactivate_cleanup_ok=${deactivated.ok} -> ${results.d174_executive_negative_control_non_recovery_blocked}`);
    });

    await section("6) executive.enable_finance_kill_switch/disable_finance_kill_switch/get_finance_kill_switch videresender identity.tenant_id/person_id UENDRET (D-68)", async () => {
      const enabled = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "enable_finance_kill_switch", parameters: { reason: `D-174 finance ${runId}` } });
      const state = await stack.financeService.getKillSwitch(OWNER_TENANT);
      const disabled = await stack.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "disable_finance_kill_switch", parameters: {} });
      const afterDisable = await stack.financeService.getKillSwitch(OWNER_TENANT);
      const ok = enabled.ok && state?.enabled === true && state?.enabled_by_person_id === OWNER_PERSON && disabled.ok && afterDisable?.enabled === false;
      results.d174_finance_kill_switch_via_executive = ok ? "PASS" : "FAIL";
      log(`enable_ok=${enabled.ok} enabled_by=${state?.enabled_by_person_id ?? "-"} disable_ok=${disabled.ok} -> ${results.d174_finance_kill_switch_via_executive}`);
    });

    await section("7) B3-FIKS: Wallester activate_card BLOKKERES av finans-nødbryteren FØR provider-kallet - opprett+send inn et FYSISK kort (pending_provider), aktiver nødbryteren, forsøk activate_card", async () => {
      const draft = await stack.cardService.createCard(OWNER_TENANT, "business", {
        idempotency_key: `d174-card-${runId}`, name: "D174 Host Acceptance", purpose: "host-acceptance", card_type: "physical", currency: "EUR"
      });
      cardId = draft.card_id;
      const originalOnCreateCard = wallesterFake.onCreateCard;
      wallesterFake.onCreateCard = async () => ({ id: `d174-wcard-${runId}`, status: "awaitingactivation", maskedCardNumber: "…4321", accountId: "wacc-live-1", tokenizationStatus: null });
      const submitted = await stack.cardService.submitCard(OWNER_TENANT, "business", draft.card_id);
      wallesterFake.onCreateCard = originalOnCreateCard;
      const submittedIsPending = submitted.state === "pending_provider";

      await stack.financeService.enableKillSwitch(OWNER_TENANT, OWNER_PERSON, `D-174 B3 host-akseptanse ${runId}`);
      const activateCallsBefore = wallesterFake.activateCalls;
      let blockedClosed = false;
      try {
        await stack.cardService.activateCard(OWNER_TENANT, "business", draft.card_id, OWNER_PERSON);
      } catch (err) {
        blockedClosed = (err as Error).name === "FinanceKillSwitchActiveError" || (err as Error).message.includes("finance_kill_switch");
      }
      const providerCallNeverMade = wallesterFake.activateCalls === activateCallsBefore;
      const ok = submittedIsPending && blockedClosed && providerCallNeverMade;
      results.d174_wallester_activate_card_blocked_before_provider_call = ok ? "PASS" : "FAIL";
      log(`submitted_pending=${submittedIsPending} activate_blocked_closed=${blockedClosed} provider_call_never_made=${providerCallNeverMade} -> ${results.d174_wallester_activate_card_blocked_before_provider_call}`);
    });

    await section("8) B3-REGRESJON: freeze_card/close_card (spend-REDUSERENDE) forblir TILLATT mens finans-nødbryteren fortsatt er aktiv", async () => {
      if (!cardId) throw new Error("d174_card_missing_from_section_7");
      const frozen = await stack.cardService.freezeCard(OWNER_TENANT, "business", cardId, OWNER_PERSON);
      const closed = await stack.cardService.closeCard(OWNER_TENANT, "business", cardId, OWNER_PERSON);
      await stack.financeService.disableKillSwitch(OWNER_TENANT, OWNER_PERSON);
      const ok = frozen.state === "frozen" && closed.state === "closed";
      results.d174_wallester_spend_reducing_actions_still_allowed = ok ? "PASS" : "FAIL";
      log(`freeze_state=${frozen.state} close_state=${closed.state} -> ${results.d174_wallester_spend_reducing_actions_still_allowed}`);
    });

    await section(
      "9) EIER-VENDT ENHETSTILBAKEKALLING (task F, D-175/BLOKKER B4-rettet) VIA executive.revoke_device (ETT-PANEL-BEVIS, ikke direkte owner_controls) - MÅL-TENANTEN kommer FRA ownerIdentity.tenant_id, INGEN tenant_id-parameter i det hele tatt (skjemaet mangler feltet)",
      async () => {
        await seedDeviceGrant(sidePool!);
        const before = await withTenantTransaction(sidePool!, OWNER_TENANT, (client) =>
          client.query(`SELECT count(*)::int AS n FROM session_grants WHERE tenant_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [OWNER_TENANT, SYNTHETIC_DEVICE])
        );
        const result = await stack.gateway.execute({
          identity: ownerIdentity, tool_id: "executive", action: "revoke_device",
          parameters: { device_id: SYNTHETIC_DEVICE, reason: `D-174 host-akseptanse ${runId}` }
        });
        const ok = (before.rows[0] as { n: number }).n === 1 && result.ok && (result as { data?: { tenant_id?: string; revoked_grants?: number } }).data?.tenant_id === OWNER_TENANT &&
          (result as { data?: { revoked_grants?: number } }).data?.revoked_grants === 1;
        results.d174_owner_facing_device_revocation = ok ? "PASS" : "FAIL";
        log(`grants_before=${(before.rows[0] as { n: number }).n} revoke_ok=${result.ok} revoked_tenant=${(result as { data?: { tenant_id?: string } }).data?.tenant_id ?? "-"} revoked_grants=${(result as { data?: { revoked_grants?: number } }).data?.revoked_grants ?? "-"} -> ${results.d174_owner_facing_device_revocation}`);
      }
    );

    await section("10) DURABEL FRA FERSK INSTANS: en HELT NY pg.Pool + SessionGrantService (ingen delt hukommelse) ser samme revokerte enhet", async () => {
      const freshPool = createPool(configFromEnv());
      try {
        // BLOKKER B7 (arkitekt-review 5252418219): SAMME FORCE RLS-krav som
        // `seedDeviceGrant()` over - en fersk runtime-rolle-pool krever OGSÅ
        // `jarvis.tenant_id` satt FØR den kan lese `session_grants`.
        const { rows } = await withTenantTransaction(freshPool, OWNER_TENANT, (client) =>
          client.query(`SELECT revoked_at FROM session_grants WHERE tenant_id = $1 AND device_id = $2`, [OWNER_TENANT, SYNTHETIC_DEVICE])
        );
        const ok = rows.length === 1 && (rows[0] as { revoked_at: string | null }).revoked_at !== null;
        results.d174_device_revocation_durable_from_fresh_instance = ok ? "PASS" : "FAIL";
        log(`fresh_instance_sees_revoked=${ok} -> ${results.d174_device_revocation_durable_from_fresh_instance}`);
      } finally {
        await freshPool.end();
      }
    });

    await section(
      "AUDIT-BEVIS (avgrenset til session_id+vannmerke, D-167-disiplin - executive.*-mutasjoner OG owner_controls.revoke_device har audit_events-rader med korrekt actor, INGEN credential-verdi/token/fingerprint)",
      async () => {
        const events = await queryRunScopedOwnerControlsAudit(adminPool, {
          personId: OWNER_PERSON, sessionId: ownerIdentity.session_id!, watermark: auditWatermark,
          actions: ["activate_kill_switch", "deactivate_kill_switch", "revoke_credential", "restore_credential", "freeze_connector", "unfreeze_connector", "revoke_device"]
        });
        const hasActivate = events.some((e) => e.action === "activate_kill_switch" && e.type === "tool.executed");
        const hasDeactivate = events.some((e) => e.action === "deactivate_kill_switch" && e.type === "tool.executed");
        const hasRevokeDevice = events.some((e) => e.action === "revoke_device" && e.type === "tool.executed");
        const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
        const resolvedCredential = await secrets.get(BUSINESS_INTERNAL_CREDENTIAL_REF);
        const serialized = JSON.stringify(events);
        const noSecretLeak = (!resolvedCredential || !serialized.includes(resolvedCredential)) && !serialized.includes("d174-fake-fingerprint") && !serialized.includes(`grt-d174-${runId}`);
        const ok = hasActivate && hasDeactivate && hasRevokeDevice && noSecretLeak;
        results.d174_audit_evidence = ok ? "PASS" : "FAIL";
        log(`audit_rows=${events.length} has_activate=${hasActivate} has_deactivate=${hasDeactivate} has_revoke_device=${hasRevokeDevice} no_secret_leak=${noSecretLeak} -> ${results.d174_audit_evidence}`);
      }
    );
  } finally {
    await section("CLEANUP (kill switch deaktivert, delt credential gjenopprettet, synthetic connector/kort/enhet fjernet, owner_control_state IDENTISK med før kjøringen)", async () => {
      const cleanupPool = createPool(configFromEnv());
      try {
        const cleanupStack = await buildStack(cleanupPool);
        await cleanupStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} }).catch(() => undefined);
        await cleanupStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } }).catch(() => undefined);
        await cleanupStack.ownerControls.restoreCredentialDurable(BUSINESS_INTERNAL_CREDENTIAL_REF, OWNER_PERSON).catch(() => undefined);
        await cleanupStack.financeService.disableKillSwitch(OWNER_TENANT, OWNER_PERSON).catch(() => undefined);
        if (cardId) {
          await adminPool.query(`DELETE FROM card_events WHERE tenant_id = $1 AND card_id = $2`, [OWNER_TENANT, cardId]).catch(() => undefined);
          await adminPool.query(`DELETE FROM card_spend_policies WHERE tenant_id = $1 AND card_id = $2`, [OWNER_TENANT, cardId]).catch(() => undefined);
          await adminPool.query(`DELETE FROM provider_cards WHERE tenant_id = $1 AND card_id = $2`, [OWNER_TENANT, cardId]).catch(() => undefined);
        }
        await adminPool.query(`DELETE FROM session_grants WHERE tenant_id = $1 AND device_id = $2`, [OWNER_TENANT, SYNTHETIC_DEVICE]).catch(() => undefined);
        await adminPool.query(`DELETE FROM sessions WHERE session_id = $1`, [SYNTHETIC_SESSION]).catch(() => undefined);
        await adminPool.query(`DELETE FROM devices WHERE device_id = $1`, [SYNTHETIC_DEVICE]).catch(() => undefined);
        await adminPool.query(`DELETE FROM finance_kill_switch WHERE tenant_id = $1`, [OWNER_TENANT]).catch(() => undefined);
        const snapshotAfter = await snapshotOwnerControlState();
        diagnostics["owner_control_state_after"] = JSON.stringify(snapshotAfter);
        const unchanged = JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore);
        results.d174_cleanup_state_unchanged = unchanged ? "PASS" : "FAIL";
        log(`owner_control_state_after=${diagnostics["owner_control_state_after"]} unchanged=${unchanged} -> ${results.d174_cleanup_state_unchanged}`);
      } finally {
        await cleanupPool.end();
      }
    });
    await sidePool?.end();
  }

  return finish();
}

function finish(): void {
  log("\n== D-174 EXECUTIVE CONTROL-SURFACE LIVE ACCEPTANCE SUMMARY ==");
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
