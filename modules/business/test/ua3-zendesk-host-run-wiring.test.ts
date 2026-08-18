import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-3 Support/Tickets (Zendesk, D-64) §37 i byggeordren: strukturelt bevis
 * for `ua3-zendesk-host-run.ts`/`ua3-zendesk-live.ts` - speiler
 * `ua3-host-run-wiring.test.ts`/`ua3-business-events-host-run-wiring.test.ts`
 * sitt mønster uendret, uten aa faktisk kjøre Docker/pnpm/Zendesk-API (det er
 * selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/ua3-zendesk-host-run.ts");
const liveScriptSource = readSource("../scripts/ua3-zendesk-live.ts");

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
    const codeOnly = hostRunSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
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
  it("kjører migrate FØR ua3-zendesk-live.ts (023_zendesk_support.sql maa vaere anvendt før zendesk_tickets leses)", () => {
    const migrateRunIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const liveCallIdx = hostRunSource.indexOf('"modules/business/scripts/ua3-zendesk-live.ts"');
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(liveCallIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeLessThan(liveCallIdx);
  });
});

describe("Q-21 admin/runtime-splitt regresserer ikke", () => {
  it("ua3-zendesk-host-run.ts skriver/endrer ALDRI .env", () => {
    expect(hostRunSource).not.toMatch(/writeFileSync/);
    expect(hostRunSource).not.toMatch(/renameSync/);
    expect(hostRunSource).not.toMatch(/copyFileSync/);
  });
  it("ua3-zendesk-live.ts verifiserer selv Q-21-rollen (assertRuntimeRoleSafe) FØR noe skriving forsøkes", () => {
    expect(liveScriptSource).toContain("assertRuntimeRoleSafe");
    const roleCheckIdx = liveScriptSource.indexOf("assertRuntimeRoleSafe(pool)");
    const firstWriteIdx = liveScriptSource.indexOf("service.createCompany(");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(firstWriteIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeLessThan(firstWriteIdx);
  });
  it("BLOCKED_BY_RUNTIME_ROLE stopper ALL videre skriving hvis rollen ikke er trygg", () => {
    expect(liveScriptSource).toContain("BLOCKED_BY_RUNTIME_ROLE");
    expect(liveScriptSource).toMatch(/if \(!runtimeRoleSafe\)/);
  });
});

describe("live-scriptet bruker UTELUKKENDE syntetiske, kjøre-unike tenants - aldri ekte kundedata, ALDRI en ekte Zendesk-mutasjon", () => {
  it("bruker en run_id-suffikset tenant-prefiks (tenant-ua3-zendesk-live-<run_id>-a/-b)", () => {
    expect(liveScriptSource).toContain("`tenant-ua3-zendesk-live-${runId}-a`");
    expect(liveScriptSource).toContain("`tenant-ua3-zendesk-live-${runId}-b`");
  });
  it("REACHABILITY-seksjonen kaller UTELUKKENDE list_tickets (read-only) - ALDRI create_ticket/reply_ticket/delete_ticket/create_webhook mot ekte Zendesk", () => {
    const reachabilityIdx = liveScriptSource.indexOf("REAL CONNECTOR REACHABILITY");
    const reachabilitySection = liveScriptSource.slice(reachabilityIdx, liveScriptSource.indexOf("DEL 2", reachabilityIdx));
    expect(reachabilitySection).toContain('action: "list_tickets"');
    for (const mutatingAction of ["create_ticket", "reply_ticket", "delete_ticket", "redact_ticket_content", "create_webhook", "update_webhook", "delete_webhook"]) {
      expect(reachabilitySection).not.toContain(`action: "${mutatingAction}"`);
    }
  });
  it("rydder opp egen test-tenant/person ved slutten av kjøringen (CLEANUP-seksjon)", () => {
    const cleanupIdx = liveScriptSource.indexOf('section("CLEANUP"');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(liveScriptSource.slice(cleanupIdx)).toContain("cleanupTenant(TENANT_A)");
    expect(liveScriptSource.slice(cleanupIdx)).toContain("cleanupTenant(TENANT_B)");
  });
  it("selvhelbreder (selfHeal) stale kjøringer fra tidligere avbrutte forsøk FØR ny test-data plantes", () => {
    expect(liveScriptSource).toContain("await selfHeal()");
  });
});

describe("credential-bootstrap gir en presis, sikker markør - ALDRI en vag stack trace, ALDRI en bønn om aa lime inn secrets", () => {
  it("sjekker zendeskCredentialsConfigured() FØR noe live Zendesk-kall forsøkes", () => {
    const reachabilityIdx = liveScriptSource.indexOf("REAL CONNECTOR REACHABILITY");
    const zendeskCallIdx = liveScriptSource.indexOf('action: "list_tickets"', reachabilityIdx);
    const configCheckIdx = liveScriptSource.indexOf("zendeskCredentialsConfigured()", reachabilityIdx);
    expect(configCheckIdx).toBeGreaterThan(-1);
    expect(configCheckIdx).toBeLessThan(zendeskCallIdx);
  });
  it("rapporterer zendesk_credentials_configured=FAIL og zendesk_auth_setup_required=true, aldri en kryptisk feil, når credentials mangler", () => {
    expect(liveScriptSource).toContain("zendesk_credentials_configured=FAIL");
    expect(liveScriptSource).toContain("zendesk_auth_setup_required=true");
    expect(liveScriptSource).not.toContain("paste");
    expect(liveScriptSource).not.toContain("lim inn");
  });
});

describe("PASS-markører og hard_fail beregnes fra faktiske resultater - aldri hardkodet false", () => {
  it("hard_fail avledes fra results-objektet (FAIL/BLOCKED_BY_RUNTIME_ROLE), ikke en konstant", () => {
    expect(liveScriptSource).toMatch(/const hardFail = Object\.values\(results\)\.some/);
    expect(liveScriptSource).not.toMatch(/hard_fail=false`\)/);
  });
  it("resultat-nøklene dekker Q-21/reachability/entitetsgjenkjenning/idempotens/open-loop/webhook/D-klasse-gating/isolasjon/audit/cleanup", () => {
    for (const key of [
      "q21_runtime_role_safe", "ua3_zendesk_runtime_role", "ua3_zendesk_real_connector_reachable",
      "ua3_zendesk_matched", "ua3_zendesk_unmatched", "ua3_zendesk_ambiguous",
      "ua3_zendesk_activity_recorded", "ua3_zendesk_no_body_copied", "ua3_zendesk_ticket_state_upserted",
      "ua3_zendesk_idempotent", "ua3_zendesk_open_loop_created", "ua3_zendesk_open_loop_resolved",
      "ua3_zendesk_webhook_signature_valid", "ua3_zendesk_webhook_signature_invalid_rejected",
      "ua3_zendesk_webhook_replay_rejected", "ua3_zendesk_destructive_gated",
      "ua3_zendesk_tenant_isolation", "ua3_zendesk_space_isolation", "ua3_zendesk_toolgateway",
      "ua3_zendesk_audit_safe", "ua3_zendesk_cleanup"
    ]) {
      expect(liveScriptSource).toContain(key);
    }
  });
});
