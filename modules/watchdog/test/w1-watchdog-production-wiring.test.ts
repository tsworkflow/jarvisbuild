import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * W1 (D-180, ordrepunkt E.8 + F): STRUKTURELT bevis for at
 * `@jarvis/watchdog` faktisk KONSUMERES av produksjonsruntime-en, og at
 * host-akseptanse-harnesset finnes i det etablerte to-fil-mønsteret.
 *
 * D182 sitt funn var nettopp at modulen var fullt implementert OG fullt
 * testet, men ALDRI koblet inn i noen kjørende prosess. En kjøretidstest kan
 * ikke fange en manglende wiring i en modul-toppnivåfil (`worker-main.ts`
 * starter en ekte prosess ved import) - derfor leses kilden, samme mønster
 * som `d174-executive-control-surface-host-run-wiring.test.ts` og
 * `q21-migrate-role-wiring.test.ts` allerede bruker.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const workerMainSource = readSource("../../../apps/api/src/worker-main.ts");
const apiMainSource = readSource("../../../apps/api/src/main.ts");
const apiPackageJson = readSource("../../../apps/api/package.json");
const watchdogSource = readSource("../src/watchdog.ts");
const hostRunSource = readSource("../scripts/w1-watchdog-durability-host-run.ts");
const liveScriptSource = readSource("../scripts/w1-watchdog-durability-live.ts");

/**
 * Kode uten kommentarer - hindrer at en forklarende kommentar tilfredsstiller
 * en "koden gjør X"-assertion (eller, like viktig for de negative
 * assertionene under, at en kommentar som SITERER den gamle koden får det til
 * å se ut som defekten fortsatt finnes). Blokk-kommentarer erstattes med like
 * mange linjeskift slik at linjebaserte rekkefølge-assertioner fortsatt peker
 * på riktige posisjoner.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => "\n".repeat((block.match(/\n/g) ?? []).length))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("A) @jarvis/watchdog er FAKTISK konsumert av produksjons-worker-runtime-en (D182 sitt REAL_INTERNAL_GAP)", () => {
  it("apps/api deklarerer @jarvis/watchdog som en ekte workspace-avhengighet", () => {
    expect(JSON.parse(apiPackageJson).dependencies["@jarvis/watchdog"]).toBe("workspace:*");
  });

  it("worker-main.ts importerer watchdogen fra pakkenavnet (ikke en relativ sti forbi pakkegrensen)", () => {
    expect(workerMainSource).toMatch(/from\s*"@jarvis\/watchdog"/);
    expect(workerMainSource).not.toMatch(/from\s*"[^"]*modules\/watchdog/);
  });

  it("konstruerer NØYAKTIG ÉN Watchdog-instans og ÉN intervall-løkke - ingen duplikat", () => {
    expect(codeOnly(workerMainSource).match(/new Watchdog\(/g) ?? []).toHaveLength(1);
    expect(codeOnly(workerMainSource).match(/startWatchdog\(/g) ?? []).toHaveLength(1);
  });

  it("registrerer alle tre kanoniske sjekkene (databaseCheck/stuckTasksCheck/costExplosionCheck) på DEN ENE instansen", () => {
    const code = codeOnly(workerMainSource);
    expect(code).toContain("watchdog.register(databaseCheck(pool))");
    expect(code).toContain("watchdog.register(stuckTasksCheck(pool, watchdogTenantIds))");
    expect(code).toContain("costExplosionCheck(pool, killSwitch, {");
    expect(code.match(/watchdog\.register\(/g) ?? []).toHaveLength(3);
  });

  it("gir watchdogen DEN SAMME pool-baserte, durable killSwitch-instansen som PolicyGateway håndhever på - aldri en ny KillSwitch", () => {
    // Nøyaktig én KillSwitch konstrueres i worker-main, og den deles.
    expect(codeOnly(workerMainSource).match(/new KillSwitch\(/g) ?? []).toHaveLength(1);
    expect(codeOnly(workerMainSource)).toContain("const killSwitch = new KillSwitch(pool, ownerControlAuthority);");
    expect(codeOnly(workerMainSource)).toContain("costExplosionCheck(pool, killSwitch, {");
  });

  it("starter watchdogen ETTER Q-21-runtime-sjekken OG etter killSwitch.restore() - aldri før tilstanden er gjenopprettet", () => {
    const code = codeOnly(workerMainSource);
    const roleCheckIdx = code.indexOf("await assertRuntimeRoleSafe(pool)");
    const restoreIdx = code.indexOf("await killSwitch.restore()");
    const watchdogIdx = code.indexOf("new Watchdog(");
    const startIdx = code.indexOf("startWatchdog(");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(roleCheckIdx);
    expect(watchdogIdx).toBeGreaterThan(restoreIdx);
    expect(startIdx).toBeGreaterThan(watchdogIdx);
  });

  it("bruker et AVGRENSET, konfigurerbart intervall via resolveWatchdogIntervalMs - aldri en rå, ubegrenset env-verdi i setInterval", () => {
    expect(codeOnly(workerMainSource)).toContain('resolveWatchdogIntervalMs(process.env["JARVIS_WATCHDOG_INTERVAL_MS"])');
    expect(codeOnly(workerMainSource)).not.toMatch(/setInterval\([^)]*JARVIS_WATCHDOG_INTERVAL_MS/);
  });

  it("parser hardgrensen fail-safe via resolveCostHardLimitOre - ALDRI en rå Number(env), som ville gitt NaN og en stille avslått nødstopp", () => {
    const code = codeOnly(workerMainSource);
    expect(code).toContain('resolveCostHardLimitOre(process.env["JARVIS_COST_HARD_LIMIT_ORE"])');
    expect(code).not.toMatch(/Number\(\s*process\.env\["JARVIS_COST_HARD_LIMIT_ORE"\]/);
  });

  it("gjenbruker DEN SAMME TelegramTransport-instansen som firstWaveTools sin telegram.notify - ingen ny Telegram-klient i worker-main", () => {
    const code = codeOnly(workerMainSource);
    expect(code.match(/new TelegramTransport\(\)/g) ?? []).toHaveLength(1);
    expect(code).toContain("telegram: telegramTransport");
    expect(code).toContain("new TelegramAlertSink(telegramTransport, new EnvSecretProvider())");
  });

  it("api-prosessen (main.ts) starter BEVISST INGEN andre watchdog - to konkurrerende nødstopp-skrivere mot samme rad er ikke ekstra dekning", () => {
    expect(codeOnly(apiMainSource)).not.toContain("new Watchdog(");
    expect(codeOnly(apiMainSource)).not.toContain("startWatchdog(");
  });
});

describe("B) den durable nødstoppen: INGEN legacy costExplosionCheck -> killSwitch.activate() gjenstår", () => {
  it("costExplosionCheck bruker activateDurable(reason, actorPersonId), ALDRI den prosess-lokale activate()", () => {
    const code = codeOnly(watchdogSource);
    const checkIdx = code.indexOf("export function costExplosionCheck(");
    expect(checkIdx).toBeGreaterThan(-1);
    const checkBody = code.slice(checkIdx);
    expect(checkBody).toContain("await killSwitch.activateDurable(");
    expect(checkBody).not.toMatch(/killSwitch\.activate\(/);
  });

  it("'allerede aktiv'-sjekken bruker den AUTORITATIVE isActiveDurable(), ikke den synkrone isActive()", () => {
    const code = codeOnly(watchdogSource);
    const checkBody = code.slice(code.indexOf("export function costExplosionCheck("));
    expect(checkBody).toContain("await killSwitch.isActiveDurable()");
    expect(checkBody).not.toMatch(/killSwitch\.isActive\(\)/);
  });

  it("INGEN sted i watchdog-modulen kaller den prosess-lokale killSwitch.activate() lenger", () => {
    expect(codeOnly(watchdogSource)).not.toMatch(/killSwitch\.activate\(/);
  });

  it("aktøren er et PÅKREVD felt (ingen valgfri/undefined aktør som stille endrer audit-semantikken)", () => {
    expect(watchdogSource).toMatch(/actorPersonId:\s*string;/);
    expect(watchdogSource).not.toMatch(/actorPersonId\?:\s*string/);
    expect(codeOnly(watchdogSource)).toContain("cost_explosion_no_actor");
  });

  it("RLS: både costExplosionCheck og stuckTasksCheck summerer/teller inni withTenantTransaction - aldri en rå pool.query mot de FORCE RLS-beskyttede tabellene", () => {
    const code = codeOnly(watchdogSource);
    for (const fn of ["export function costExplosionCheck(", "export function stuckTasksCheck("]) {
      const start = code.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf("\n}", start));
      expect(body).toContain("withTenantTransaction(pool, tenantId,");
      expect(body).not.toMatch(/\bpool\.query\(/);
    }
  });
});

describe("C) TelegramAlertSink er ikke lenger en blindvei som ubetinget kaster", () => {
  it("send() kaster ALDRI et ubetinget 'telegram_alert_unverified' lenger", () => {
    // Mot KODEN, ikke kilden: filhodet SITERER bevisst den gamle feilstrengen
    // for å forklare hva som ble erstattet.
    expect(codeOnly(watchdogSource)).not.toContain("telegram_alert_unverified");
  });

  it("bruker en INJISERT transport + secret-provider (ingen egen fetch mot api.telegram.org, ingen ny credential-mekanisme)", () => {
    const code = codeOnly(watchdogSource);
    expect(code).toContain("this.transport.invoke(");
    expect(code).toContain("await this.secrets.get(this.credentialRef)");
    expect(code).not.toContain("api.telegram.org");
    expect(code).toContain('TELEGRAM_ALERT_CREDENTIAL_REF = "JARVIS_TELEGRAM_TOKEN"');
  });

  it("varselformatet inneholder ALDRI credential-verdien - kun sjekk/alvorlighet/melding/runbook/tidspunkt", () => {
    const code = codeOnly(watchdogSource);
    const formatIdx = code.indexOf("export function formatAlertMessage(");
    const formatBody = code.slice(formatIdx, code.indexOf("\n}", formatIdx));
    expect(formatBody).not.toMatch(/credential/i);
    expect(formatBody).not.toMatch(/token/i);
  });
});

describe("D) feilisolasjon: tick() svelger ikke lenger alt stille, og kjører aldri overlappende", () => {
  it("de tidligere .catch(() => undefined)-svelgene i tick() er borte", () => {
    const code = codeOnly(watchdogSource);
    const tickIdx = code.indexOf("async tick(): Promise<Alert[]>");
    const tickBody = code.slice(tickIdx, code.indexOf("\n  }", tickIdx));
    expect(tickBody).not.toContain("catch(() => undefined)");
    expect(tickBody).toContain("this.observer.onAlertFailed?.(");
    expect(tickBody).toContain("this.observer.onCheckFailed?.(");
    expect(tickBody).toContain("this.observer.onActionFailed?.(");
  });

  it("overlappingsvernet ligger i tick() selv (den ENE inngangen), ikke i kalleren", () => {
    const code = codeOnly(watchdogSource);
    const tickIdx = code.indexOf("async tick(): Promise<Alert[]>");
    const tickBody = code.slice(tickIdx, code.indexOf("\n  }", tickIdx));
    expect(tickBody).toContain("if (this.running)");
    expect(tickBody).toContain('this.observer.onCycleSkipped?.("overlapping_run")');
  });

  it("startWatchdog har et YTTERSTE .catch slik at en uventet feil aldri feller worker-prosessen", () => {
    const code = codeOnly(watchdogSource);
    const startIdx = code.indexOf("export function startWatchdog(");
    const startBody = code.slice(startIdx, code.indexOf("\n}", startIdx));
    expect(startBody).toContain("void watchdog.tick().catch(");
  });
});

describe("E) host-akseptanse-harnesset følger det etablerte to-fil-mønsteret", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });

  it("kjører install --frozen-lockfile FØR docker build, aldri --no-frozen-lockfile", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(installIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });

  it("bygger migrate/api/worker FØR migrate kjøres, restarter deretter api/worker, og kaller til slutt live-scriptet", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"up", "-d", "--force-recreate", "api", "worker"');
    const liveIdx = hostRunSource.indexOf('"modules/watchdog/scripts/w1-watchdog-durability-live.ts"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(buildIdx);
    expect(restartIdx).toBeGreaterThan(migrateIdx);
    expect(liveIdx).toBeGreaterThan(restartIdx);
  });

  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      expect(codeOnly(source)).not.toMatch(/shell:\s*true/);
    }
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
  });
});

describe("F) live-akseptansen bruker produksjonens egen komposisjon og beviser de navngitte kravene", () => {
  it("bruker den EKTE, konfigurerte eier-identiteten (samme env-variabler som worker-main.ts), ikke en syntetisk test-eier", () => {
    expect(liveScriptSource).toContain('process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias"');
    expect(liveScriptSource).toContain('process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"');
  });

  it("kjører atferden under test på runtime-pool-en (RLS gjelder), ALDRI på adminPool", () => {
    // adminPool finnes, men KUN til snapshot/verifiserende tilbakelesing/cleanup.
    expect(liveScriptSource).toContain("const pool = createPool(configFromEnv());");
    expect(liveScriptSource).toContain("assertRuntimeRoleSafe(pool)");
    expect(liveScriptSource).not.toMatch(/costExplosionCheck\(adminPool/);
    expect(liveScriptSource).not.toMatch(/new KillSwitch\(adminPool/);
  });

  it("all cost_events-fikstur går via withTenantTransaction på runtime-pool-en (D-178-disiplinen), aldri en rå tenant-løs innsetting", () => {
    const inserts = liveScriptSource.match(/INSERT INTO cost_events[\s\S]{0,120}/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const insert of inserts) {
      const idx = liveScriptSource.indexOf(insert);
      expect(liveScriptSource.slice(Math.max(0, idx - 220), idx)).toContain("withTenantTransaction(pool, OWNER_TENANT,");
    }
  });

  it("hardgrensen er RELATIV til faktisk forbruk og utløses av SYNTETISK, kjøre-unik testdata - aldri ekte produksjonsforbruk", () => {
    expect(liveScriptSource).toContain("const hardLimitOre = baselineSpend + SYNTHETIC_SPEND_ORE;");
    expect(liveScriptSource).toContain("SYNTHETIC_COST_KIND = `w1-acceptance:${runId}`");
  });

  it("beviser prosess-omstart-durabilitet i en EKTE separat OS-prosess (--durable-readback), ikke en gjenbrukt instans", () => {
    expect(liveScriptSource).toContain('process.argv.includes("--durable-readback")');
    expect(liveScriptSource).toContain('"--durable-readback"');
    expect(liveScriptSource).toContain("DURABLE_READBACK_ACTIVE");
  });

  it("beviser policy-/verktøy-håndhevelse gjennom en UAVHENGIG ToolGateway + PolicyGateway, og at transporten aldri nås", () => {
    expect(liveScriptSource).toContain("new ToolGateway(");
    expect(liveScriptSource).toContain('reason === "kill_switch_active"');
    expect(liveScriptSource).toContain("recorder.calls === 0");
  });

  it("beviser at en simulert varslingsfeil IKKE opphever nødstoppen", () => {
    const idx = liveScriptSource.indexOf("w1_alert_failure_does_not_undo_shutdown = ok");
    expect(idx).toBeGreaterThan(-1);
    expect(liveScriptSource).toContain("const stillActive = await killSwitch.isActiveDurable();");
  });

  it("gjenoppretter gjennom den KANONISKE eier-stien (deactivateDurable), aldri en egen watchdog-gjenopprettingsmekanisme", () => {
    expect(liveScriptSource).toContain("await killSwitch.deactivateDurable(OWNER_PERSON);");
    expect(liveScriptSource).not.toMatch(/DELETE FROM owner_control_state/);
  });

  it("CLEANUP kjøres i en finally-blokk rundt HELE hovedsekvensen og sammenligner owner_control_state byte-for-byte", () => {
    const tryIdx = liveScriptSource.indexOf("  try {");
    const finallyIdx = liveScriptSource.indexOf("  } finally {");
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    expect(cleanupIdx).toBeGreaterThan(finallyIdx);
    expect(liveScriptSource).toContain("JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore)");
  });

  it("CLEANUP sletter KUN de kjøre-unike syntetiske cost_events-radene (aldri ekte kostnadsdata)", () => {
    expect(liveScriptSource).toContain("DELETE FROM cost_events WHERE kind = $1");
    expect(liveScriptSource).not.toMatch(/DELETE FROM cost_events WHERE tenant_id/);
  });

  it("setter ALLE markører til BLOCKED_BY_RUNTIME_ROLE hvis Q-21-sjekken feiler - aldri en fabrikkert PASS", () => {
    expect(liveScriptSource).toContain('results[key] = "BLOCKED_BY_RUNTIME_ROLE"');
  });

  it("rapporterer ÆRLIG når Telegram-credential mangler (NO_CREDENTIAL), i stedet for å påstå bevist leveranse", () => {
    expect(liveScriptSource).toContain('"NO_CREDENTIAL"');
    expect(liveScriptSource).toContain("EKTE LEVERANSE IKKE BEVIST");
  });
});
