import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-180 (W1, arkitekt-order D183, §E punkt 8 "production wiring structural
 * test"): beviser STRUKTURELT (ingen Docker/DB nødvendig - det er selve
 * `w1-watchdog-durability-live.ts` sin jobb, se den egne host-run-wiring-
 * suiten for DEN) at (a) `@jarvis/watchdog` faktisk konsumeres av
 * `apps/api/src/worker-main.ts`, (b) alle tre kanoniske sjekkene
 * registreres, (c) INGEN legacy `killSwitch.activate(` (den ikke-durable
 * no-op-en D182 fant) gjenstår noe sted i produksjonskilden. Samme mønster
 * som `d174-executive-control-surface-host-run-wiring.test.ts` sin
 * kildetekst-lesing.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const workerMainSource = readSource("../../../apps/api/src/worker-main.ts");
const mainSource = readSource("../../../apps/api/src/main.ts");
const watchdogSource = readSource("../src/watchdog.ts");
const apiPackageJson = readSource("../../../apps/api/package.json");
const ownerControlStoreSource = readSource("../../policy/src/owner-control-store.ts");

describe("W1: @jarvis/watchdog er faktisk konsumert av worker-main.ts (WATCHDOG_PRODUCTION_WIRED)", () => {
  it("apps/api/package.json lister @jarvis/watchdog som dependency", () => {
    expect(apiPackageJson).toMatch(/"@jarvis\/watchdog":\s*"workspace:\*"/);
  });

  it("worker-main.ts importerer Watchdog/databaseCheck/stuckTasksCheck/costExplosionCheck/WatchdogEmergencyAlertSink fra @jarvis/watchdog", () => {
    expect(workerMainSource).toMatch(
      /import\s*\{[^}]*WatchdogEmergencyAlertSink[^}]*Watchdog[^}]*costExplosionCheck[^}]*databaseCheck[^}]*stuckTasksCheck[^}]*\}\s*from\s*"@jarvis\/watchdog"/s
    );
  });

  it("worker-main.ts konstruerer ÉN Watchdog-instans og registrerer alle tre kanoniske sjekker", () => {
    expect(workerMainSource).toContain("new Watchdog(watchdogAlertSink, killSwitch)");
    expect(workerMainSource).toContain("watchdog.register(databaseCheck(pool))");
    expect(workerMainSource).toContain("watchdog.register(stuckTasksCheck(pool))");
    expect(workerMainSource).toMatch(/watchdog\.register\(\s*costExplosionCheck\(/);
    // Nøyaktig ÉN konstruksjon - ingen duplikat watchdog-instans i samme fil.
    expect(workerMainSource.match(/new Watchdog\(/g)?.length).toBe(1);
  });

  it("watchdogen startes ETTER assertRuntimeRoleSafe/killSwitch.restore()/ownerControls.restore(), FØR intervall-drenerings-loopen", () => {
    const roleSafeIdx = workerMainSource.indexOf("assertRuntimeRoleSafe(pool)");
    const killSwitchRestoreIdx = workerMainSource.indexOf("await killSwitch.restore()");
    const ownerControlsRestoreIdx = workerMainSource.indexOf("await ownerControls.restore()");
    const watchdogConstructIdx = workerMainSource.indexOf("new Watchdog(watchdogAlertSink, killSwitch)");
    // D-184: linjeskift-agnostisk. Et hardkodet "\n      " her gjorde testen
    // avhengig av at arbeidskopien er sjekket ut med LF - på en CRLF-utsjekk
    // (Windows-vert, core.autocrlf) ble indexOf(-1) og testen feilet på noe
    // som ikke er en reell regresjon i worker-main.ts.
    const drainLoopIdx = workerMainSource.search(/void worker\s*\.drain\(\)/);
    expect(roleSafeIdx).toBeGreaterThan(-1);
    expect(killSwitchRestoreIdx).toBeGreaterThan(-1);
    expect(ownerControlsRestoreIdx).toBeGreaterThan(-1);
    expect(watchdogConstructIdx).toBeGreaterThan(-1);
    expect(drainLoopIdx).toBeGreaterThan(-1);
    expect(watchdogConstructIdx).toBeGreaterThan(roleSafeIdx);
    expect(watchdogConstructIdx).toBeGreaterThan(killSwitchRestoreIdx);
    expect(watchdogConstructIdx).toBeGreaterThan(ownerControlsRestoreIdx);
    expect(watchdogConstructIdx).toBeLessThan(drainLoopIdx);
  });

  it("watchdog.tick() kjøres på et intervall og feil logges (aldri en ufanget promise-rejection)", () => {
    expect(workerMainSource).toMatch(/setInterval\(\s*\(\)\s*=>\s*\n?\s*void watchdog\s*\n?\s*\.tick\(\)/);
    expect(workerMainSource).toContain("watchdog_tick_error");
  });

  it("costExplosionCheck kalles med ownerControlAuthority.owner_person_id - ALDRI en oppdiktet/udefinert aktør", () => {
    expect(workerMainSource).toMatch(/costExplosionCheck\(pool,\s*killSwitch,\s*ownerControlAuthority\.owner_person_id,/);
  });

  it("D-191 (BLOCKER B4): costExplosionCheck kalles ALSO med et eksplisitt tenantId - process.env[\"JARVIS_TENANT_ID\"] ?? \"tenant-personal\", SAMME mønster som resten av filens wiring (aldri utledet fra urelatert data)", () => {
    const callIdx = workerMainSource.indexOf("costExplosionCheck(pool,");
    expect(callIdx).toBeGreaterThan(-1);
    const call = workerMainSource.slice(callIdx, workerMainSource.indexOf(")\n);", callIdx) + 1);
    // Remediering del 2 (JARVIS-065): tenant kommer fra den validerte eier-konfigen, ikke en env-default.
    expect(call).toMatch(/owner\.tenant_id/);
    // ownerPersonId og tenantId er to DISTINKTE argumenter - tenantId erstatter IKKE ownerPersonId.
    expect(call).toContain("ownerControlAuthority.owner_person_id");
  });

  it("apps/api/src/main.ts registrerer IKKE en egen watchdog-instans (unngå duplikat, D183 §A)", () => {
    expect(mainSource).not.toContain("new Watchdog(");
    expect(mainSource).not.toMatch(/from\s*"@jarvis\/watchdog"/);
  });
});

describe("W1: ingen legacy ikke-durabel killSwitch.activate()-kall gjenstår i watchdog.ts (WATCHDOG_KILL_SWITCH_DURABLE)", () => {
  it("costExplosionCheck bruker activateDurable(), ALDRI den bare .activate()-formen", () => {
    expect(watchdogSource).toContain("await killSwitch.activateDurable(");
    expect(watchdogSource).not.toMatch(/killSwitch\.activate\(`kostnadseksplosjon/);
  });

  it("costExplosionCheck guard-sjekker mot isActiveDurable() (aldri kun den synkrone isActive()) FØR den (evt.) aktiverer på nytt", () => {
    const fnStart = watchdogSource.indexOf("export function costExplosionCheck(");
    const fnBody = watchdogSource.slice(fnStart, fnStart + 2500);
    expect(fnBody).toContain("await killSwitch.isActiveDurable()");
  });

  it("costExplosionCheck krever et eksplisitt ownerPersonId-parameter (ingen default/undefined-fallback)", () => {
    expect(watchdogSource).toMatch(/export function costExplosionCheck\(\s*pool: pg\.Pool,\s*killSwitch: KillSwitch,\s*ownerPersonId: string,/);
  });

  it("D-191 (BLOCKER B4, E.1): costExplosionCheck krever OGSÅ et eksplisitt tenantId-parameter (ingen default) - RETT ETTER ownerPersonId, FØR den defaultable hardLimitOre", () => {
    expect(watchdogSource).toMatch(/ownerPersonId: string,\s*tenantId: string,\s*hardLimitOre = 300_000/);
  });

  it("D-191 (BLOCKER B4, E.2): den månedlige SUM-spørringen kjører INNI withTenantTransaction(pool, tenantId, ...) - ikke lenger direkte via pool.query()", () => {
    const fnStart = watchdogSource.indexOf("export function costExplosionCheck(");
    const fnBody = watchdogSource.slice(fnStart, fnStart + 2500);
    expect(fnBody).toMatch(/await withTenantTransaction\(pool,\s*tenantId,\s*async\s*\(client\)\s*=>/);
    expect(fnBody).toContain("client.query(");
    expect(fnBody).not.toMatch(/[^.]pool\.query\(\s*\n?\s*`SELECT/);
  });

  it("D-191 (BLOCKER B4, E.3): withTenantTransaction importeres fra @jarvis/core (den kanoniske helperen som setter jarvis.tenant_id via set_config) - ingen egen, parallell RLS-mekanisme", () => {
    expect(watchdogSource).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
  });

  it("D-191 (BLOCKER B4, E.9): ingen FAKTISK adminPool-BRUK (kun nevnt i begrunnende prosa/kommentarer for HVORFOR det bevisst IKKE brukes), ingen RLS-svekkende setning noe sted i watchdog.ts sin PRODUKSJONSKILDE (src/, ikke scripts/test)", () => {
    // Kildekode-BRUK ville sett ut som `adminPool.query(`/`adminPool)`/en
    // parameter-/importdeklarasjon - ALDRI bare ordet i en forklarende
    // kommentarlinje (som selve D-191-begrunnelsen over costExplosionCheck).
    expect(watchdogSource).not.toMatch(/adminPool\.query\(/);
    expect(watchdogSource).not.toMatch(/[,(]\s*adminPool\s*[,)]/);
    expect(watchdogSource).not.toMatch(/\bBYPASSRLS\b/);
    expect(watchdogSource).not.toMatch(/\b(GRANT|ALTER ROLE|ALTER TABLE)\b/);
  });
});

describe("W1: WatchdogEmergencyAlertSink erstatter den kastende TelegramAlertSink-stubben (WATCHDOG_ALERT_DELIVERY_STATUS)", () => {
  it("den gamle, ubetinget-kastende TelegramAlertSink-klassen finnes ikke lenger", () => {
    expect(watchdogSource).not.toContain('throw new Error("telegram_alert_unverified');
  });

  it("Watchdog.tick() logger (aldri svelger stille) en varslingsfeil, og fortsetter uansett", () => {
    expect(watchdogSource).toContain("watchdog_alert_delivery_failed");
  });
});

describe("D-181 (BLOCKER B1, arkitekt-review av PR #96): nødvarselet hopper BEVISST over ToolGateway/PolicyGateway, i stedet for en generell isSelfRecoveryAction()-utvidelse", () => {
  it("D-180 sin GatewayAlertSink (som rutet varselet gjennom ToolGateway.execute, og dermed ble nektet av sin egen kill-switch-aktivering) finnes ikke lenger", () => {
    expect(watchdogSource).not.toContain("export class GatewayAlertSink");
    expect(watchdogSource).not.toMatch(/gateway\.execute\(\{\s*\n?\s*identity:\s*this\.identity,\s*\n?\s*tool_id:\s*"telegram"/);
  });

  it("WatchdogEmergencyAlertSink kaller transport.invoke() DIREKTE - INGEN ToolGateway/PolicyGateway i kallkjeden", () => {
    const classIdx = watchdogSource.indexOf("export class WatchdogEmergencyAlertSink");
    expect(classIdx).toBeGreaterThan(-1);
    const classBody = watchdogSource.slice(classIdx, classIdx + 1200);
    expect(classBody).toContain("this.transport.invoke(");
    expect(classBody).not.toContain("ToolGateway");
    expect(classBody).not.toContain(".execute(");
  });

  it("watchdog.ts har INGEN import fra @jarvis/tool-gateway eller @jarvis/contracts (mindre avhengighetsgraf enn D-180, ikke større)", () => {
    expect(watchdogSource).not.toMatch(/from\s*"@jarvis\/tool-gateway"/);
    expect(watchdogSource).not.toMatch(/from\s*"@jarvis\/contracts"/);
  });

  it("nødvarsel-sinkens send()-metode tar KUN et Alert-objekt - ingen kaller-kontrollert mål/chat-parameter i grensesnittet", () => {
    const classIdx = watchdogSource.indexOf("export class WatchdogEmergencyAlertSink");
    const classBody = watchdogSource.slice(classIdx, classIdx + 1200);
    expect(classBody).toMatch(/async send\(alert: Alert\): Promise<void>/);
    expect(classBody).not.toMatch(/send\([^)]*chat/i);
    expect(classBody).not.toMatch(/send\([^)]*target/i);
  });

  it("D-184: sinken vasker transportens feilmelding for den rå credentialen FØR den kan nå Watchdog.tick() sin logg", () => {
    const classIdx = watchdogSource.indexOf("export class WatchdogEmergencyAlertSink");
    const classBody = watchdogSource.slice(classIdx, classIdx + 1600);
    expect(classBody).toContain("redactCredential(");
    // Transportkallet ER omsluttet av en catch - ingen rå transport-feil slipper ut urørt.
    expect(classBody).toMatch(/try\s*\{[\s\S]*this\.transport\.invoke\([\s\S]*\}\s*catch/);
    expect(watchdogSource).toMatch(/function redactCredential\(text: string, credential: string\): string/);
  });

  it("isSelfRecoveryAction() i modules/policy er IKKE utvidet med telegram - den globale kill-switch-semantikken for ORDINÆR telegram.notify er uendret", () => {
    expect(ownerControlStoreSource).not.toMatch(/toolId === "telegram"/);
    expect(ownerControlStoreSource).not.toMatch(/TELEGRAM_SELF_RECOVERY_ACTIONS/);
  });

  it("worker-main.ts injiserer DEN SAMME telegramTransport/toolSecretProvider-instansen i BÅDE den ordinære telegram-registreringen OG WatchdogEmergencyAlertSink (ingen parallell credential-mekanisme)", () => {
    // D-247: chatId sendes nå som en resolver mot toolSecretProvider (Infisical-primær,
    // samme bug-klasse/fiks som D-246) - ikke lenger en bokstavelig tom konstruktør.
    expect(workerMainSource).toContain('const telegramTransport = new TelegramTransport(() => toolSecretProvider.get("JARVIS_TELEGRAM_CHAT_ID"));');
    expect(workerMainSource).toMatch(/telegram:\s*telegramTransport/);
    expect(workerMainSource).toContain("new WatchdogEmergencyAlertSink(telegramTransport, toolSecretProvider)");
    // Ingen ANDRE `new TelegramTransport(` - nøyaktig én instans i hele filen.
    expect(workerMainSource.match(/new TelegramTransport\(/g)?.length).toBe(1);
  });
});

describe("W1: overlappende tick()-kjøringer forhindres (D183 §D)", () => {
  it("Watchdog har en ticking-vakt som dropper (og logger) en overlappende tick() i stedet for å kjøre samtidig", () => {
    expect(watchdogSource).toContain("private ticking = false;");
    expect(watchdogSource).toContain("watchdog_tick_skipped_overlap");
  });
});
