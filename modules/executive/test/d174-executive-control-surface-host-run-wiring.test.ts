import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-174 (B2+B3) host-akseptanse:
 * `modules/executive/scripts/d174-executive-control-surface-host-run.ts` er
 * den ENE host-kommandoen Tobias trenger for å bevise den SAMLEDE
 * `executive.*`-mutasjonsflaten (owner_controls.*-gjennomslag inkl. K1/B1-
 * selvgjenoppretting, finans-nødbryteren, Wallester `activate_card` sin
 * nødbryter-gating, eier-vendt enhetstilbakekalling) LIVE. Speiler NØYAKTIG
 * samme struktur som `k1-owner-control-authority-host-run-wiring.test.ts`
 * (se dens egen filhode) - denne suiten beviser den strukturelt, uten å
 * faktisk kjøre Docker/pnpm/embedded Postgres (det er selve host-
 * akseptansens jobb, se B2+B3-ordren sitt HOST_ACCEPTANCE_REQUIRED-krav).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/d174-executive-control-surface-host-run.ts");
const liveScriptSource = readSource("../scripts/d174-executive-control-surface-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker build, aldri --no-frozen-lockfile", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(codeOnly).not.toMatch(/shell:\s*true/);
    }
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
  });
  it("live-scriptet restarter ALDRI containere midt i seg selv (I MOTSETNING til K1) - api-/worker-prosessparitet OG restart-durabilitet er ALLEREDE bevist av K1/B1", () => {
    expect(liveScriptSource).not.toContain('execFileSync("docker"');
    expect(liveScriptSource).not.toContain("--compose-args");
  });
});

describe("migrate/api/worker bygges ferske FØR migrate kjøres, deretter kjøres migrate FØR selve akseptansen", () => {
  it("bygger migrate/api/worker FØR migrate faktisk kjøres", () => {
    const buildIdx = hostRunSource.indexOf('"build", "migrate", "api", "worker"');
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(migrateRunIdx);
  });
  it("kjører migrate FØR den initielle api/worker-restarten, og kaller deretter live-scriptet UTEN compose-argumenter", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"up", "-d", "--force-recreate", "api", "worker"');
    const liveCallIdx = hostRunSource.indexOf('"modules/executive/scripts/d174-executive-control-surface-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(migrateRunIdx);
    expect(liveCallIdx).toBeGreaterThan(restartIdx);
    expect(hostRunSource).not.toContain('"--compose-args"');
  });
});

describe("live-scriptet bruker den EKTE, konfigurerte eier-identiteten - ALDRI en syntetisk 'test-eier' for selve kill switch-/finans-nødbryter-mutasjonen", () => {
  it("OWNER_PERSON/OWNER_TENANT kommer fra JARVIS_OWNER_PERSON_ID/JARVIS_TENANT_ID (samme env-variabler som apps/api/src/main.ts), ikke en hardkodet syntetisk verdi", () => {
    expect(liveScriptSource).toContain('process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias"');
    expect(liveScriptSource).toContain('process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"');
  });
  it("KUN connector-/enhets-/kort-målene er syntetiske/kjøre-unike - aldri en ekte, i bruk værende connector/enhet/kort", () => {
    expect(liveScriptSource).toContain("SYNTHETIC_CONNECTOR = `d174_acceptance_connector_${runId}`");
    expect(liveScriptSource).toContain("SYNTHETIC_DEVICE = `d174_acceptance_device_${runId}`");
  });
});

describe("live-scriptet bruker PRODUKSJONENS komposisjon - samme secret-kjede og samme *Durable()-mønster som apps/api/src/main.ts", () => {
  it("secrets: FallbackSecretProvider(EnvSecretProvider, BusinessInternalSecretProvider) - samme kjede som main.ts/K1", () => {
    expect(liveScriptSource).toContain("new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())");
  });
  it("ToolGateway konstrueres med `ownerControls` som 4. argument (samme frys-/tilbakekalls-håndhevelse som main.ts/worker-main.ts)", () => {
    expect(liveScriptSource).toContain("new ToolGateway(sidePool, policy, secrets, ownerControls)");
  });
  it("registrerer executive.*/owner_controls.*/finance.*/finance_wallester.* på SAMME ToolGateway-instans - ingen parallell registreringsvei", () => {
    expect(liveScriptSource).toContain("executiveToolDefinitions(new ExecutiveTransport(executiveService))");
    expect(liveScriptSource).toContain("ownerControlsToolDefinitions(new OwnerControlsTransport(ownerControlsService))");
    expect(liveScriptSource).toMatch(/firstWaveTools\(\{\s*\n?\s*finance:/);
  });
  it("OwnerControlsService gis device-tilbakekallings-avhengighetene (pool+grants+authority) som 3. konstruktørargument - revoke_device er FAKTISK koblet, ikke bare deklarert", () => {
    expect(liveScriptSource).toContain("new OwnerControlsService(killSwitch, ownerControls, { pool: sidePool, grants, devices: new DeviceService(sidePool), authority })");
  });
});

describe("D-175 (arkitekt-review 5250409538, BLOKKER B4): device-tilbakekalling MÅ gå via executive.revoke_device (ETT-PANEL-bevis) med tenanten bundet til ownerIdentity.tenant_id, ALDRI et kaller-oppgitt tenant_id-parameter", () => {
  it("seksjon 9 kaller tool_id:\"executive\" (IKKE direkte tool_id:\"owner_controls\") for revoke_device", () => {
    const section9Idx = liveScriptSource.indexOf('"9) EIER-VENDT ENHETSTILBAKEKALLING');
    expect(section9Idx).toBeGreaterThan(-1);
    const section9Slice = liveScriptSource.slice(section9Idx, section9Idx + 1200);
    expect(section9Slice).toContain('tool_id: "executive", action: "revoke_device"');
    expect(section9Slice).not.toContain('tool_id: "owner_controls", action: "revoke_device"');
  });
  it("revoke_device-parametrene inneholder ALDRI et tenant_id-felt noe sted i live-scriptet - tenanten kommer UTELUKKENDE fra identity", () => {
    const revokeDeviceCalls = liveScriptSource.match(/action: "revoke_device"[^}]*\}/gs) ?? [];
    expect(revokeDeviceCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of revokeDeviceCalls) {
      expect(call).not.toMatch(/tenant_id\s*:/);
    }
  });
  it("beviser tenant-bindingen: resultatets tenant_id sammenlignes mot OWNER_TENANT (den AUTENTISERTE identitetens egen tenant), ikke en fri verdi", () => {
    expect(liveScriptSource).toContain('data?.tenant_id === OWNER_TENANT');
  });
});

describe("D-176 (arkitekt-review 5251073737, BLOKKER B5; RETTET BLOKKER B6, arkitekt-review 5252077633): executive.get_control_surface_status MÅ lese SUKSESSFULLT under BEGGE lås-tilstandene SAMTIDIG FØR gjenoppretting - live-scriptet registrerer situations.* (den nøstede lesingen get_control_surface_status komponerer), setter BEGGE lås-tilstandene DIREKTE via det durable laget (IKKE en umulig sekvensiell executive.*-oppsett), OG beviser den ordinære handlingen forblir nektet gjennom hele lås-vinduet", () => {
  it("registrerer situations.* på SAMME ToolGateway-instans som owner_controls.*/executive.*/finance.* (situationsToolDefinitions/SituationsTransport/DomainPauseRegistry/SituationEngine) - uten dette ville get_control_surface_status sin nøstede situations.get_pause_state-lesing feilet med en helt annen (ukjent verktøy) grunn", () => {
    expect(liveScriptSource).toContain('import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";');
    expect(liveScriptSource).toContain("situationsToolDefinitions(new SituationsTransport(situationEngine, domainPauses))");
  });
  function getSection4bSlice(): string {
    const section4bIdx = liveScriptSource.indexOf("4b) D-176");
    expect(section4bIdx).toBeGreaterThan(-1);
    const nextSectionIdx = liveScriptSource.indexOf('"5) NEGATIV KONTROLL', section4bIdx);
    expect(nextSectionIdx).toBeGreaterThan(section4bIdx);
    return liveScriptSource.slice(section4bIdx, nextSectionIdx);
  }
  it("BLOKKER B6 (RETTET): seksjon 4b setter BEGGE lås-tilstandene DIREKTE via det durable laget (stack.killSwitch.activateDurable/stack.ownerControls.revokeCredentialDurable) - ALDRI via en sekvensiell executive.activate_kill_switch + executive.revoke_credential (som er STRUKTURELT UMULIG: hver av dem nekter den andre)", () => {
    const section4bSlice = getSection4bSlice();
    expect(section4bSlice).toContain("stack.killSwitch.activateDurable(");
    expect(section4bSlice).toContain("stack.ownerControls.revokeCredentialDurable(");
    expect(section4bSlice).not.toContain('tool_id: "executive", action: "activate_kill_switch"');
    expect(section4bSlice).not.toContain('tool_id: "executive", action: "revoke_credential"');
  });
  it("seksjon 4b kaller get_control_surface_status (via en delt `readStatus()`-hjelpefunksjon som selv sender tool_id:\"executive\"/action:\"get_control_surface_status\") FLERE ganger (under BEGGE tilstander samtidig, OG etter gjenoppretting) - IKKE bare én isolert suksess-sjekk", () => {
    const section4bSlice = getSection4bSlice();
    expect(section4bSlice).toContain('action: "get_control_surface_status"'); // definert ÉN gang, i den delte `readStatus()`-hjelpefunksjonen
    const readStatusCalls = section4bSlice.match(/readStatus\(\)/g) ?? [];
    expect(readStatusCalls.length).toBeGreaterThanOrEqual(2); // kalt FLERE ganger - under begge tilstander samtidig, OG etter gjenoppretting
  });
  it("seksjon 4b beviser at en ORDINÆR handling (owner_controls.freeze_connector) FORTSATT nektes ('kill_switch_active') MENS get_control_surface_status samtidig lykkes - unntaket er ALDRI bredere enn de navngitte lese-/gjenopprettingshandlingene", () => {
    const section4bSlice = getSection4bSlice();
    expect(section4bSlice).toContain('action: "freeze_connector"');
    expect(section4bSlice).toContain('"should-stay-blocked-during-4b"');
  });
  it("seksjon 4b gjenoppretter via executive.restore_credential/executive.deactivate_kill_switch (IKKE direkte owner_controls.*) - SAMME ETT-PANEL-disiplin som resten av D-174/D-175/D-176", () => {
    const section4bSlice = getSection4bSlice();
    expect(section4bSlice).toContain('tool_id: "executive", action: "restore_credential"');
    expect(section4bSlice).toContain('tool_id: "executive", action: "deactivate_kill_switch"');
  });
});

describe("D-178 (arkitekt-review 5252418219, BLOKKER B7 - EKTE Windows-host-kjøring run_id=d265a028 feilet med RLS-avslag): host-fikstur/-tilbakelesing for enhets-/sesjons-/grant-radene (RLS-beskyttet, FORCE ROW LEVEL SECURITY, migrasjon 053) MÅ gå via withTenantTransaction (jarvis.tenant_id satt), ALDRI en rå runtime-pool-spørring uten tenant-kontekst - selve executive.revoke_device-kallet under test forblir UENDRET via ToolGateway/PolicyGateway", () => {
  it("importerer withTenantTransaction fra @jarvis/core (den KANONISKE tenant-kontekst-hjelperen, ingen duplisert kopi)", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
  });
  it("seedDeviceGrant() setter ALLE TRE innsettinger (devices/sessions/session_grants) inni SAMME withTenantTransaction(sidePool, OWNER_TENANT, ...) - ALDRI en rå sidePool.query(...) for disse RLS-beskyttede tabellene", () => {
    const fnIdx = liveScriptSource.indexOf("async function seedDeviceGrant(");
    expect(fnIdx).toBeGreaterThan(-1);
    const nextFnIdx = liveScriptSource.indexOf("async function main(", fnIdx);
    expect(nextFnIdx).toBeGreaterThan(fnIdx);
    const fnSlice = liveScriptSource.slice(fnIdx, nextFnIdx);
    expect(fnSlice).toContain("withTenantTransaction(sidePool, OWNER_TENANT,");
    expect(fnSlice).toContain("INSERT INTO devices");
    expect(fnSlice).toContain("INSERT INTO sessions");
    expect(fnSlice).toContain("INSERT INTO session_grants");
    expect(fnSlice).not.toMatch(/sidePool\.query\(/);
  });
  it("seksjon 9 sin FØR-telling av session_grants går OGSÅ via withTenantTransaction(sidePool!, OWNER_TENANT, ...), ikke en rå sidePool!.query(...)", () => {
    const section9Idx = liveScriptSource.indexOf('"9) EIER-VENDT ENHETSTILBAKEKALLING');
    expect(section9Idx).toBeGreaterThan(-1);
    const section9Slice = liveScriptSource.slice(section9Idx, section9Idx + 1200);
    expect(section9Slice).toContain("withTenantTransaction(sidePool!, OWNER_TENANT,");
    expect(section9Slice).not.toMatch(/sidePool!\.query\(/);
  });
  it("seksjon 10 sin ferske-instans-tilbakelesing går via withTenantTransaction(freshPool, OWNER_TENANT, ...), ikke en rå freshPool.query(...)", () => {
    const section10Idx = liveScriptSource.indexOf('"10) DURABEL FRA FERSK INSTANS');
    expect(section10Idx).toBeGreaterThan(-1);
    const section10Slice = liveScriptSource.slice(section10Idx, section10Idx + 800);
    expect(section10Slice).toContain("withTenantTransaction(freshPool, OWNER_TENANT,");
    expect(section10Slice).not.toMatch(/freshPool\.query\(/);
  });
  it("den FAKTISKE enhetstilbakekallingen under test forblir executive.revoke_device via stack.gateway.execute (UENDRET av B7 - kun fikstur/lesing fikk tenant-kontekst, ALDRI selve handlingen under test)", () => {
    const section9Idx = liveScriptSource.indexOf('"9) EIER-VENDT ENHETSTILBAKEKALLING');
    const section9Slice = liveScriptSource.slice(section9Idx, section9Idx + 1200);
    expect(section9Slice).toContain('tool_id: "executive", action: "revoke_device"');
  });
  it("CLEANUP forblir via adminPool (bevisst UENDRET av B7 - opprydding er IKKE atferden under test, kun fikstur-opprettelse/-lesing måtte flyttes til tenant-kontekst)", () => {
    const cleanupIdx = liveScriptSource.indexOf("CLEANUP (kill switch deaktivert");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupSlice = liveScriptSource.slice(cleanupIdx, cleanupIdx + 1500);
    expect(cleanupSlice).toContain("adminPool.query(`DELETE FROM session_grants");
  });
});

describe("INGEN ekte provider-kall: Wallester-gatewayen er en INJISERT FAKE ved nettverksgrensen, ALDRI en ekte HTTP-transport", () => {
  it("CardService konstrueres med en gatewayFactory som returnerer DEN LOKALE `wallesterFake`, ikke defaultWallesterGatewayFactory/WallesterTransport", () => {
    expect(liveScriptSource).not.toContain("defaultWallesterGatewayFactory");
    expect(liveScriptSource).not.toContain("new WallesterTransport(");
    expect(liveScriptSource).toContain("() => wallesterFake as unknown as WallesterGateway");
  });
  it("beviser B3-fiksen: activate_card blokkeres FØR provider-kallet (activateCalls uendret), og freeze/close forblir tillatt mens nødbryteren er aktiv", () => {
    const activateSectionIdx = liveScriptSource.indexOf("d174_wallester_activate_card_blocked_before_provider_call");
    const spendReducingSectionIdx = liveScriptSource.indexOf("d174_wallester_spend_reducing_actions_still_allowed");
    expect(activateSectionIdx).toBeGreaterThan(-1);
    expect(spendReducingSectionIdx).toBeGreaterThan(activateSectionIdx);
    expect(liveScriptSource).toContain("providerCallNeverMade = wallesterFake.activateCalls === activateCallsBefore");
  });
});

describe("live-scriptet garanterer opprydding OGSÅ ved feil (try/finally), og verifiserer owner_control_state er UENDRET fra FØR kjøringen", () => {
  it("CLEANUP-seksjonen kjøres inni en `finally`-blokk rundt HELE hovedsekvensen", () => {
    const tryIdx = liveScriptSource.indexOf("try {");
    const finallyIdx = liveScriptSource.indexOf("} finally {");
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    expect(cleanupIdx).toBeGreaterThan(finallyIdx);
  });
  it("sammenligner owner_control_state FØR og ETTER byte-for-byte (JSON.stringify-likhet), ikke bare et delmengde-sjekk", () => {
    expect(liveScriptSource).toContain("JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore)");
  });
  it("CLEANUP fjerner de synthetic card-/enhets-/sesjons-/grant-radene (card_events/card_spend_policies/provider_cards/session_grants/sessions/devices) - INGEN residue", () => {
    for (const table of ["card_events", "card_spend_policies", "provider_cards", "session_grants", "sessions", "devices"]) {
      expect(liveScriptSource).toContain(`DELETE FROM ${table}`);
    }
  });
});

describe("live-scriptet bruker ALDRI en fake PASS for Q-21-sjekken (BLOCKED_BY_RUNTIME_ROLE-fallback finnes)", () => {
  it("setter ALLE markører til BLOCKED_BY_RUNTIME_ROLE hvis Q-21-sjekken feiler", () => {
    expect(liveScriptSource).toContain('results[key] = "BLOCKED_BY_RUNTIME_ROLE"');
  });
});

describe("audit-bevis er avgrenset til (session_id, vannmerke) - SAMME D-167-disiplin som K1/B1, ALDRI en håndplukket 'siste N rader'-grense", () => {
  it("importerer captureAuditWatermark/queryRunScopedOwnerControlsAudit fra DEN DELTE hjelpe-modulen (ikke en dupliserende, ad-hoc spørring)", () => {
    expect(liveScriptSource).toMatch(
      /import\s*\{[^}]*captureAuditWatermark[^}]*queryRunScopedOwnerControlsAudit[^}]*\}\s*from\s*"\.\.\/\.\.\/owner-controls\/src\/audit-evidence\.ts"/s
    );
  });
  it("tar vannmerket FØR kjøringens FØRSTE mutasjon", () => {
    const watermarkIdx = liveScriptSource.indexOf("const auditWatermark = await captureAuditWatermark(adminPool);");
    const firstSectionIdx = liveScriptSource.indexOf('section("1) executive.activate_kill_switch');
    expect(watermarkIdx).toBeGreaterThan(-1);
    expect(firstSectionIdx).toBeGreaterThan(-1);
    expect(watermarkIdx).toBeLessThan(firstSectionIdx);
  });
  it("INGEN bar 'ORDER BY audit_id DESC LIMIT N' UTEN en forutgående session_id/vannmerke-avgrensning", () => {
    expect(liveScriptSource).not.toMatch(/ORDER BY audit_id DESC LIMIT \d+/);
  });
  it("audit-spørringen kaller queryRunScopedOwnerControlsAudit med BÅDE sessionId OG watermark", () => {
    const calls = liveScriptSource.match(/queryRunScopedOwnerControlsAudit\(adminPool,\s*\{[^}]*\}/gs) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toContain("sessionId:");
      expect(call).toContain("watermark:");
    }
  });
  it("beviser at INGEN credential-VERDI/grant-token/device-fingerprint lekker i audit-payloaden (kun credential_ref/device_id/reason)", () => {
    expect(liveScriptSource).toContain("noSecretLeak");
    expect(liveScriptSource).toContain('"d174-fake-fingerprint"');
  });
});
