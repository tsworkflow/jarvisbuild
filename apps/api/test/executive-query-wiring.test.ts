import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-199 (UA-11 Executive dashboard-UI, lese-delen): `main.ts` er et
 * top-level side-effekt-skript (kobler til DB idet det importeres) - kan
 * derfor IKKE trygt importeres direkte i en testfil, samme presedens som
 * `drive-runtime-wiring.test.ts`/`business-weekly-brief-wiring.test.ts`.
 * Denne suiten verifiserer at `executive: { gateway: toolGateway }` faktisk
 * er wiret inn i `ApiDeps` (SAMME toolGateway-instans som resten av appen -
 * ALDRI en ny), og at `/executive/query` sitt eget hvitelistert-handling-
 * allowlist i `server.ts` FORBLIR begrenset til de to lese-handlingene -
 * ALDRI en mutasjonshandling smuglet inn ved en fremtidig endring.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const serverSource = readSource("../src/server.ts");

describe("A: main.ts wirer executive.gateway inn i ApiDeps med SAMME toolGateway-instans som resten av appen", () => {
  it("deps-objektet inneholder 'executive: { gateway: toolGateway }'", () => {
    expect(mainSource).toMatch(/executive:\s*\{\s*gateway:\s*toolGateway\s*\}/);
  });

  it("den EKSISTERENDE, allerede-konstruerte toolGateway-instansen brukes - ingen ny ToolGateway(...) nær 'executive:'", () => {
    const idx = mainSource.indexOf("executive: { gateway: toolGateway }");
    expect(idx).toBeGreaterThan(-1);
    // Samme deps-objekt som incidents/finance/conversation - beviser at
    // executive-feltet faktisk sitter i DEN samme `const deps: ApiDeps = {...}`-
    // konstruksjonen, ikke et løsrevet objekt et annet sted.
    const depsBlockStart = mainSource.lastIndexOf("const deps: ApiDeps = {", idx);
    expect(depsBlockStart).toBeGreaterThan(-1);
    expect(mainSource.slice(depsBlockStart, idx)).toContain("conversation: conversationEngine");
  });
});

describe("B: server.ts sin /executive/query-allowlist er og forblir LESE-KUN", () => {
  it("EXECUTIVE_QUERY_ACTIONS inneholder KUN get_attention_queue og get_control_surface_status", () => {
    const match = serverSource.match(/const EXECUTIVE_QUERY_ACTIONS = \[([^\]]*)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(actions.sort()).toEqual(["get_attention_queue", "get_control_surface_status"].sort());
  });

  it("ingen kjent mutasjonshandling (pause_domain/resume_domain/resolve_situation/activate_kill_switch/deactivate_kill_switch/freeze_connector/unfreeze_connector/revoke_credential/restore_credential/revoke_device/enable_finance_kill_switch/disable_finance_kill_switch) forekommer i EXECUTIVE_QUERY_ACTIONS-linjen", () => {
    const match = serverSource.match(/const EXECUTIVE_QUERY_ACTIONS = \[[^\]]*\] as const;/);
    expect(match).not.toBeNull();
    const line = match?.[0] ?? "";
    for (const mutation of [
      "pause_domain", "resume_domain", "resolve_situation", "activate_kill_switch", "deactivate_kill_switch",
      "freeze_connector", "unfreeze_connector", "revoke_credential", "restore_credential", "revoke_device",
      "enable_finance_kill_switch", "disable_finance_kill_switch"
    ]) {
      expect(line).not.toContain(mutation);
    }
  });

  it("/executive/query-ruten avslår en handling utenfor allowlistet FØR gateway.execute() nås (action_not_allowed-sjekken kommer FØR gateway.execute()-kallet)", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/query"');
    expect(routeIdx).toBeGreaterThan(-1);
    const executeIdx = serverSource.indexOf("deps.executive.gateway.execute(", routeIdx);
    const allowlistCheckIdx = serverSource.indexOf("action_not_allowed", routeIdx);
    expect(allowlistCheckIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(allowlistCheckIdx).toBeLessThan(executeIdx);
  });

  it("identiteten som sendes til gateway.execute() kommer fra resolveFromGrant() (grantet), ALDRI fra en kaller-oppgitt identitet i body", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/query"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toContain("resolveFromGrant(deps,");
    expect(block).toContain("identity: resolved.identity");
  });
});
