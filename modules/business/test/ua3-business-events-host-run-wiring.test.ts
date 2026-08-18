import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 business-event-linkage (D-57): `modules/business/scripts/ua3-business-events-host-run.ts`
 * er den ENE host-kommandoen Tobias trenger for aa verifisere Gmail/Calendar-
 * linkage mot en ekte Docker-Postgres (+ ekte Gmail/Calendar-credentials for
 * reachability-seksjonen). Speiler NØYAKTIG mønsteret i
 * `ua3-open-loops-host-run-wiring.test.ts` - denne suiten beviser det
 * strukturelt, uten aa faktisk kjøre Docker/pnpm/ekte Google-API-er.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-business-events-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-business-events-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker/migrasjoner, aldri --no-frozen-lockfile", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
    const codeOnly = hostRunSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/shell:\s*true/);
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
  it("kjører migrate FØR ua3-business-events-live.ts (021_business_contact_email_lookup.sql maa vaere anvendt før kontakt-e-post-oppslag brukes)", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua3-business-events-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("Q-21 admin/runtime-splitt regresserer ikke (samme presedens som P0 HOST FIX #1/D-53)", () => {
  it("ua3-business-events-host-run.ts skriver/endrer ALDRI .env", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });
  it("ua3-business-events-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe skriving forsøkes", () => {
    expect(liveScriptSource).toContain("assertRuntimeRoleSafe");
    const roleCheckIdx = liveScriptSource.indexOf("assertRuntimeRoleSafe(pool)");
    const firstWriteIdx = liveScriptSource.indexOf("adminPool.query(\"INSERT INTO tenants");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(firstWriteIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeLessThan(firstWriteIdx);
  });
  it("BLOCKED_BY_RUNTIME_ROLE stopper ALL videre skriving hvis rollen ikke er trygg", () => {
    expect(liveScriptSource).toContain("BLOCKED_BY_RUNTIME_ROLE");
    expect(liveScriptSource).toMatch(/if \(!runtimeRoleSafe\)/);
  });
  it("all scaffold-provisjonering (tenants/people/memory_spaces) gaar via adminPool, aldri pool (runtime)", () => {
    const scaffoldSection = liveScriptSource.slice(
      liveScriptSource.indexOf("await selfHeal()"),
      liveScriptSource.indexOf('section("BUSINESS-EVENTS RUNTIME-ROLLE')
    );
    expect(scaffoldSection).toContain("adminPool.query");
    expect(scaffoldSection).not.toMatch(/(?<!admin)pool\.query\(\s*"INSERT INTO tenants/);
  });
});

describe("live-scriptet bruker UTELUKKENDE syntetiske, kjøre-unike tenants - aldri ekte kundedata", () => {
  it("bruker en run_id-suffikset tenant-prefiks (tenant-ua3-be-live-<run_id>-a/-b), ingen hardkodet ekte tenant_id", () => {
    expect(liveScriptSource).toContain("`tenant-ua3-be-live-${runId}-a`");
    expect(liveScriptSource).toContain("`tenant-ua3-be-live-${runId}-b`");
    expect(liveScriptSource).not.toMatch(/tenant-kundeoppfolging/);
  });
  it("rydder opp egen test-tenant/person ved slutten av kjøringen (CLEANUP-seksjon)", () => {
    const cleanupSectionIdx = liveScriptSource.indexOf('section("CLEANUP"');
    expect(cleanupSectionIdx).toBeGreaterThan(-1);
    expect(liveScriptSource.slice(cleanupSectionIdx)).toContain("cleanupTenant(TENANT_A)");
    expect(liveScriptSource.slice(cleanupSectionIdx)).toContain("cleanupTenant(TENANT_B)");
  });
  it("selvhelbreder (selfHeal) stale kjøringer fra tidligere avbrutte forsøk FØR ny test-data plantes", () => {
    expect(liveScriptSource).toContain("await selfHeal()");
  });
  it("gjenbruker D-54/D-55 sine allerede-kjente FK-avhengigheter (cost_events/brief_seen) FØRST i cleanupTenant() - ikke gjenoppdaget blindt", () => {
    const cleanupTenantFnIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const cleanupFnBody = liveScriptSource.slice(cleanupTenantFnIdx, liveScriptSource.indexOf("async function selfHeal"));
    const costEventsIdx = cleanupFnBody.indexOf("DELETE FROM cost_events");
    const briefSeenIdx = cleanupFnBody.indexOf("DELETE FROM brief_seen");
    const tenantsIdx = cleanupFnBody.lastIndexOf("DELETE FROM tenants");
    expect(costEventsIdx).toBeGreaterThan(-1);
    expect(briefSeenIdx).toBeGreaterThan(-1);
    expect(costEventsIdx).toBeLessThan(tenantsIdx);
    expect(briefSeenIdx).toBeLessThan(tenantsIdx);
  });
  it("audit_events er BEVISST FRAVÆRENDE fra cleanupTenant() - append-only trigger (samme HOST FIX #2-mønster, D-55)", () => {
    const cleanupTenantFnIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const cleanupFnBody = liveScriptSource.slice(cleanupTenantFnIdx, liveScriptSource.indexOf("async function selfHeal"));
    expect(cleanupFnBody).not.toMatch(/DELETE FROM audit_events/);
  });
  it("§23 i byggeordren: gjenbruker den EKSISTERENDE, skjema-drevne selvdiagnostikken (findBlockingTenantDependencies) FØR DELETE FROM tenants forsøkes - ingen ny FK-oppdagelse én blind runde av gangen", () => {
    const cleanupTenantFnIdx = liveScriptSource.indexOf("async function cleanupTenant");
    const cleanupFnBody = liveScriptSource.slice(cleanupTenantFnIdx, liveScriptSource.indexOf("async function selfHeal"));
    const blockerCheckIdx = cleanupFnBody.indexOf("findBlockingTenantDependencies(tenantId)");
    const tenantsDeleteIdx = cleanupFnBody.lastIndexOf("DELETE FROM tenants");
    expect(blockerCheckIdx).toBeGreaterThan(-1);
    expect(blockerCheckIdx).toBeLessThan(tenantsDeleteIdx);
    expect(liveScriptSource).toContain("information_schema.table_constraints");
    expect(liveScriptSource).toContain("assertSafeIdentifier(row.table_name)");
    expect(liveScriptSource).toMatch(/\^\[a-z_\]\[a-z0-9_\]\*\$/);
  });
});

describe("§8 i byggeordren: to-delt akseptansestrategi - EKTE connector-reachability + deterministisk FakeTransport-basert entitetsgjenkjenning", () => {
  it("REACHABILITY-seksjonen bruker EKTE GmailTransport/GoogleCalendarTransport (ikke FakeTransport) via ToolGateway.execute()", () => {
    const sectionIdx = liveScriptSource.indexOf('section("REAL CONNECTOR REACHABILITY');
    const sectionBody = liveScriptSource.slice(sectionIdx, liveScriptSource.indexOf("});\n\n  // ===== DEL 2", sectionIdx));
    expect(sectionBody).toContain("new GmailTransport(ACCOUNT)");
    expect(sectionBody).toContain("new GoogleCalendarTransport(ACCOUNT)");
    expect(sectionBody).toContain("realGateway.execute(");
  });
  it("entitetsgjenkjennings-seksjonene bruker FakeTransport MEN fortsatt via ToolGateway.execute() (ikke et direkte BusinessService-snarvei-kall)", () => {
    expect(liveScriptSource).toContain("new FakeTransport(");
    expect(liveScriptSource).toContain('fakeGateway.execute({');
    expect(liveScriptSource).not.toMatch(/await service\.recordActivity\(/);
  });
});

describe("PASS-markører og hard_fail beregnes fra faktiske resultater - aldri hardkodet false", () => {
  it("hard_fail avledes fra results-objektet (FAIL/BLOCKED_BY_RUNTIME_ROLE), ikke en konstant", () => {
    expect(liveScriptSource).toMatch(/const hardFail = Object\.values\(results\)\.some/);
    expect(liveScriptSource).not.toMatch(/hard_fail=false`\)/);
  });
  it("resultat-nøklene dekker de 16 markørene definert i denne sliceens results-objekt", () => {
    for (const key of [
      "q21_runtime_role_safe", "ua3_events_runtime_role", "ua3_events_gmail_real_connector_reachable",
      "ua3_events_calendar_real_connector_reachable", "ua3_events_gmail_matched", "ua3_events_gmail_unmatched",
      "ua3_events_gmail_ambiguous", "ua3_events_calendar_matched", "ua3_events_idempotency",
      "ua3_events_no_body_content_stored", "ua3_events_tenant_isolation", "ua3_events_space_isolation",
      "ua3_events_open_loop_reevaluation", "ua3_events_toolgateway_wiring", "ua3_events_audit_safe",
      "ua3_events_cleanup"
    ]) {
      expect(liveScriptSource).toContain(key);
    }
  });
});

describe("§9/§11/§12 i byggeordren: deterministisk entitetsgjenkjenning, gjenbruker OpenLoopService uendret, ingen AI Mesh-bruk", () => {
  it("live-scriptet kaller den EKSISTERENDE openLoops.listOpenLoops()/OpenLoopService for aa bevise reevaluering - ingen ny open-loop-klasse definert i scriptet", () => {
    expect(liveScriptSource).toContain("openLoops.listOpenLoops(TENANT_A");
    expect(liveScriptSource).toContain('import { BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService } from "@jarvis/business";');
    expect(liveScriptSource).not.toMatch(/class\s+\w*OpenLoop\w*/);
  });
  it("importerer aldri @jarvis/model-gateway eller @jarvis/provider-adapters", () => {
    expect(liveScriptSource).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
    expect(hostRunSource).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});

describe("HOST FIX #1 (D-58, ekte host-funn run_id 7c5a5289): REACHABILITY-seksjonen bruker EKTE EnvSecretProvider, ikke en alltid-null stub", () => {
  it("importerer EnvSecretProvider fra @jarvis/tool-gateway", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*EnvSecretProvider[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });
  it("REAL CONNECTOR REACHABILITY-seksjonen konstruerer realGateway med new EnvSecretProvider() (ikke en env-empty-stub)", () => {
    const sectionIdx = liveScriptSource.indexOf('section("REAL CONNECTOR REACHABILITY');
    const nextSectionIdx = liveScriptSource.indexOf("// ===== DEL 2", sectionIdx);
    const sectionBody = liveScriptSource.slice(sectionIdx, nextSectionIdx > -1 ? nextSectionIdx : undefined);
    expect(sectionBody).toContain("new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider())");
    expect(sectionBody).not.toMatch(/get:\s*async\s*\(\)\s*=>\s*null/);
  });
  it("DEL 2 (deterministisk entitetsgjenkjenning) forblir credential-UAVHENGIG - bruker en eksplisitt dummy-verdi for Gmail/Calendar-referansene, ALDRI EnvSecretProvider", () => {
    const del2Idx = liveScriptSource.indexOf("// ===== DEL 2");
    const del2Body = liveScriptSource.slice(del2Idx, liveScriptSource.indexOf("let companyId"));
    expect(del2Body).toContain('"test-google-static"');
    expect(del2Body).not.toContain("new EnvSecretProvider()");
  });
  it("REACHABILITY rapporterer Gmail/Calendar UAVHENGIG (§9) - leser gmail.error/calendar.error separat, ikke kun ett samlet sync_ok", () => {
    const sectionIdx = liveScriptSource.indexOf('section("REAL CONNECTOR REACHABILITY');
    const sectionBody = liveScriptSource.slice(sectionIdx, liveScriptSource.indexOf("// ===== DEL 2", sectionIdx));
    expect(sectionBody).toContain("data.gmail?.error");
    expect(sectionBody).toContain("data.calendar?.error");
    expect(sectionBody).toContain("gmailReachable");
    expect(sectionBody).toContain("calendarReachable");
  });
  it("aldri logger et rått credential/token-felt (kun sanerte reason-/failure_class-strenger) - disse ordene forekommer KUN som del av HOST FIX #2 sitt eget saneringsfilter (regex-alternasjon), aldri som en faktisk interpolert verdi i en log()-linje", () => {
    // §9/§17: ordene selv er forventet å forekomme som DEL AV et regex-saneringsfilter
    // (`/subject|body_text|...|authorization|access_token|.../i`, lagt til i HOST FIX #2) -
    // det som faktisk ville vært en lekkasje er om et av dem ble INTERPOLERT i en
    // template-literal sendt til log() (f.eks. `${authorization}`/`${accessToken}`), IKKE at
    // ordet nevnes i en beskyttende filter-regex.
    expect(liveScriptSource).not.toMatch(/log\(`[^`]*\$\{[^}]*(authorization|access_token|refresh_token|client_secret)[^}]*\}[^`]*`\)/i);
  });
});

describe("HOST FIX #1: normal API/worker-runtime wirer EnvSecretProvider inn i SAMME toolGateway som BusinessTransport mottar (§17/§20 F/G)", () => {
  it("apps/api/src/main.ts konstruerer toolGateway med EnvSecretProvider OG gir SAMME toolGateway-variabel til BusinessTransport", () => {
    const mainSource = readSource("../../../apps/api/src/main.ts");
    expect(mainSource).toMatch(/const toolGateway = new ToolGateway\(\s*pool, policy,\s*new FallbackSecretProvider\(new EnvSecretProvider\(\), new BusinessInternalSecretProvider\(\)\)/);
    expect(mainSource).toContain("business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService)");
  });
  it("apps/api/src/worker-main.ts speiler NØYAKTIG samme wiring", () => {
    const workerSource = readSource("../../../apps/api/src/worker-main.ts");
    expect(workerSource).toMatch(/new FallbackSecretProvider\(new EnvSecretProvider\(\), new BusinessInternalSecretProvider\(\)\)/);
    expect(workerSource).toContain("business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService)");
  });
});

describe("HOST FIX #2 (D-59, ekte host-funn run_id b969e9e7): audit-verifikasjonsspørringen bruker withTenantTransaction, aldri en RLS-blind raw pool.query() (samme feilklasse som D-54)", () => {
  it("importerer withTenantTransaction fra @jarvis/core", () => {
    expect(liveScriptSource).toMatch(/import\s*\{[^}]*withTenantTransaction[^}]*\}\s*from\s*"@jarvis\/core"/s);
  });
  it("OPEN-LOOP-REEVALUERING-seksjonens audit-spørring er wrappet i withTenantTransaction(pool, TENANT_A, ...), ikke en raw pool.query()", () => {
    const sectionIdx = liveScriptSource.indexOf("OPEN-LOOP-REEVALUERING");
    const sectionBody = liveScriptSource.slice(sectionIdx);
    expect(sectionBody).toContain("withTenantTransaction(pool, TENANT_A");
    expect(sectionBody).not.toMatch(/await pool\.query\(\s*"SELECT payload FROM audit_events/);
  });
  it("audit-eksistens (auditFound) inngår eksplisitt i PASS-betingelsen for ua3_events_audit_safe - en manglende rad kan aldri stille passere", () => {
    const sectionIdx = liveScriptSource.indexOf("OPEN-LOOP-REEVALUERING");
    const sectionBody = liveScriptSource.slice(sectionIdx, liveScriptSource.indexOf('section("CLEANUP"'));
    expect(sectionBody).toContain("auditFound");
    expect(sectionBody).toMatch(/results\.ua3_events_audit_safe\s*=\s*auditFound\s*&&/);
  });
  it("diagnostikken logger et avkuttet (160-tegn) payload-excerpt, ikke en ubegrenset dump av rå audit-payload", () => {
    const sectionIdx = liveScriptSource.indexOf("OPEN-LOOP-REEVALUERING");
    const sectionBody = liveScriptSource.slice(sectionIdx, liveScriptSource.indexOf('section("CLEANUP"'));
    expect(sectionBody).toContain("audit_event_found=");
    expect(sectionBody).toContain("auditPayload.slice(0, 160)");
  });
});
