import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";

/**
 * P1A RUNTIME WIRING CLOSEOUT (2026-08-16): `GoogleDriveTransport` var
 * implementert og host-akseptanse-bevist (D-42, run_id `2703299e`), men
 * ALDRI wiret inn i den normale `apps/api/src/main.ts`/`worker-main.ts`
 * sine `firstWaveTools({...})`-kall - Drive-verktøyene var derfor reelt
 * uoppnåelige fra en løpende api/worker-prosess (kun `ua2-p1a-live.ts`
 * kunne nå dem). `main.ts`/`worker-main.ts` er top-level side-effekt-
 * skript (kobler til DB og starter en server/lytter idet de importeres) -
 * samme "kan IKKE trygt importeres direkte i en testfil"-presedens som
 * `db-role-wiring.test.ts` - denne suiten verifiserer wiringen som en
 * tekst-/regresjonsvakt i stedet.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: apps/api/src/main.ts sprer driveTransportsIfConfigured() inn i firstWaveTools()", () => {
  it("importerer driveTransportsIfConfigured fra @jarvis/tool-gateway", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*driveTransportsIfConfigured[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });
  it("kaller ...driveTransportsIfConfigured() INNI firstWaveTools({...})-kallet - ikke et separat, parallelt registreringssted", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("...driveTransportsIfConfigured()");
    // De fire eksisterende transportene forblir UBETINGET konstruert - uendret fra før denne fiksen:
    expect(callBlock).toContain("email: new GmailTransport()");
    expect(callBlock).toContain("calendar: new GoogleCalendarTransport()");
    expect(callBlock).toContain("github: new GithubTransport()");
    expect(callBlock).toContain("telegram: new TelegramTransport()");
    // UA-3 Support/Tickets (Zendesk, D-64): sjette ubetingede transport - samme
    // mønster som de fire over (ingen "konfigurert"-betingelse, credential_unavailable
    // håndteres av ToolGateway.execute() selv når JARVIS_ZENDESK_REFRESH_TOKEN mangler).
    expect(callBlock).toContain("zendesk: new ZendeskTransport()");
    // UA-3 P0 (D-49): femte ubetingede transport - Business OS har ingen ekstern credential
    // aa vaere "konfigurert" av, saa den registreres alltid, samme mønster som de fire over.
    // UA-3 next slice (D-53): BusinessTransport tar naa ogsaa OpenLoopService + pool.
    // UA-3 business-event-linkage (D-57): BusinessTransport tar naa ogsaa toolGateway
    // (sync_business_events maa kunne kalle email/calendar via SAMME gateway-instans).
    // UA-3 profiling/scoring-slice (D-61): BusinessTransport tar naa ogsaa ScoringService
    // (score-handlingene, sjette konstruktørparameter).
    // UA-3 Support/Tickets (Zendesk, D-64): BusinessTransport tar naa ogsaa
    // ZendeskTicketService (sync_zendesk_tickets, syvende konstruktørparameter).
    expect(callBlock).toContain("business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService)");
  });
});

describe("B: apps/api/src/worker-main.ts speiler NØYAKTIG samme wiring som main.ts", () => {
  it("importerer driveTransportsIfConfigured fra @jarvis/tool-gateway", () => {
    expect(workerSource).toMatch(/import\s*\{[^}]*driveTransportsIfConfigured[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });
  it("kaller ...driveTransportsIfConfigured() INNI firstWaveTools({...})-kallet", () => {
    const callIdx = workerSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = workerSource.slice(callIdx, workerSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("...driveTransportsIfConfigured()");
    expect(callBlock).toContain("email: new GmailTransport()");
    expect(callBlock).toContain("calendar: new GoogleCalendarTransport()");
    expect(callBlock).toContain("github: new GithubTransport()");
    expect(callBlock).toContain("telegram: new TelegramTransport()");
    expect(callBlock).toContain("zendesk: new ZendeskTransport()");
    // UA-3 business-event-linkage (D-57): BusinessTransport tar naa ogsaa toolGateway
    // (sync_business_events maa kunne kalle email/calendar via SAMME gateway-instans).
    // UA-3 profiling/scoring-slice (D-61): BusinessTransport tar naa ogsaa ScoringService.
    // UA-3 Support/Tickets (Zendesk, D-64): BusinessTransport tar naa ogsaa ZendeskTicketService.
    expect(callBlock).toContain("business: new BusinessTransport(businessService, openLoopService, pool, toolGateway, scoringService, zendeskTicketService)");
  });
});

describe("K: api og worker sine firstWaveTools()-kall bruker BOKSTAVELIG TALT samme spredningsuttrykk - kan strukturelt ikke divergere", () => {
  it("begge kaller EKSAKT '...driveTransportsIfConfigured()' - samme delte funksjon, ingen duplisert credential-sjekk", () => {
    const mainCallIdx = mainSource.indexOf("firstWaveTools({");
    const mainBlock = mainSource.slice(mainCallIdx, mainSource.indexOf("})) toolGateway.register(tool);", mainCallIdx));
    const workerCallIdx = workerSource.indexOf("firstWaveTools({");
    const workerBlock = workerSource.slice(workerCallIdx, workerSource.indexOf("})) toolGateway.register(tool);", workerCallIdx));
    expect(mainBlock).toContain("...driveTransportsIfConfigured()");
    expect(workerBlock).toContain("...driveTransportsIfConfigured()");
  });
  it("ingen av filene definerer sin EGEN credential-tilstedeværelse-sjekk (f.eks. en lokal 'JARVIS_GOOGLE_CLIENT_ID &&'-betingelse) - all logikk bor i den delte funksjonen", () => {
    expect(mainSource).not.toMatch(/JARVIS_GOOGLE_CLIENT_ID/);
    expect(workerSource).not.toMatch(/JARVIS_GOOGLE_CLIENT_ID/);
  });
});

describe("I: eksisterende Google Calendar/Gmail (+ GitHub/Telegram) wiring er UENDRET av denne fiksen", () => {
  it("main.ts sin firstWaveTools()-blokk inneholder fortsatt NØYAKTIG de samme fire ubetingede transport-konstruksjonene som før", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    // UA-3 Support/Tickets (Zendesk, D-64): femte -> naa SEKS ubetingede transport-
    // konstruksjoner etter ZendeskTransport-tillegget (email/calendar/github/telegram/zendesk).
    const unconditionalConstructions = [...callBlock.matchAll(/:\s*new \w+Transport\(\)/g)];
    expect(unconditionalConstructions).toHaveLength(5);
  });
  it("worker-main.ts sin firstWaveTools()-blokk inneholder fortsatt NØYAKTIG de samme fire ubetingede transport-konstruksjonene som før", () => {
    const callIdx = workerSource.indexOf("firstWaveTools({");
    const callBlock = workerSource.slice(callIdx, workerSource.indexOf("})) toolGateway.register(tool);", callIdx));
    const unconditionalConstructions = [...callBlock.matchAll(/:\s*new \w+Transport\(\)/g)];
    expect(unconditionalConstructions).toHaveLength(5);
  });
});

describe("J: ingen duplisert Drive-registrering - firstWaveTools() returnerer nøyaktig ÉN ToolDefinition-liste, INGEN separat manuell toolGateway.register('drive', ...) et annet sted", () => {
  it("main.ts har KUN ett toolGateway.register(tool)-løkke-sted, ikke et ekstra Drive-spesifikt register-kall", () => {
    expect([...mainSource.matchAll(/toolGateway\.register\(/g)]).toHaveLength(1);
  });
  it("worker-main.ts har KUN ett toolGateway.register(tool)-løkke-sted, ikke et ekstra Drive-spesifikt register-kall", () => {
    expect([...workerSource.matchAll(/toolGateway\.register\(/g)]).toHaveLength(1);
  });
});

describe("L: Q-21 runtime-DB-oppførsel er urørt av denne closeout-fiksen (uendret fra db-role-wiring.test.ts sine invarianter)", () => {
  it("main.ts/worker-main.ts bruker fortsatt configFromEnv (runtime), ALDRI adminConfigFromEnv, og kaller fortsatt assertRuntimeCredentialsConfigured/assertRuntimeRoleSafe", () => {
    for (const source of [mainSource, workerSource]) {
      expect(source).toMatch(/createPool\(configFromEnv\(\)\)/);
      expect(source).not.toMatch(/adminConfigFromEnv/);
      expect(source).toMatch(/assertRuntimeCredentialsConfigured\(\)/);
      expect(source).toMatch(/assertRuntimeRoleSafe\(pool\)/);
    }
  });
});

describe("D: alle 14 implementerte Drive-handlinger forblir registrert i firstWaveTools() (uendret siden D-41/D-42) - denne fiksen la KUN til registreringsveien inn i runtime, ikke definisjonene selv", () => {
  it("firstWaveTools({ drive: <transport> }) inneholder alle A/C/D-klasse Drive-handlingene", () => {
    const definitions = firstWaveTools({});
    const driveActions = definitions.filter((d) => d.tool_id === "drive").map((d) => d.action);
    const expectedA = ["list_files", "read_document", "get_metadata", "read_permissions"];
    const expectedC = ["create_file", "create_folder", "update_content", "rename", "move", "trash"];
    const expectedD = ["delete_permanent", "create_permission", "update_permission", "delete_permission"];
    for (const action of [...expectedA, ...expectedC, ...expectedD]) {
      expect(driveActions).toContain(action);
    }
    expect(driveActions).toHaveLength(14);
  });

  it("E: risikoklassene er uendret - A for lesing, C for reversible skriveoperasjoner, D for destruktive/tilgangsstyring", () => {
    const definitions = firstWaveTools({});
    const byAction = new Map(definitions.filter((d) => d.tool_id === "drive").map((d) => [d.action, d.capability_class]));
    expect(byAction.get("list_files")).toBe("A");
    expect(byAction.get("read_document")).toBe("A");
    expect(byAction.get("get_metadata")).toBe("A");
    expect(byAction.get("read_permissions")).toBe("A");
    expect(byAction.get("create_file")).toBe("C");
    expect(byAction.get("create_folder")).toBe("C");
    expect(byAction.get("update_content")).toBe("C");
    expect(byAction.get("rename")).toBe("C");
    expect(byAction.get("move")).toBe("C");
    expect(byAction.get("trash")).toBe("C");
    expect(byAction.get("delete_permanent")).toBe("D");
    expect(byAction.get("create_permission")).toBe("D");
    expect(byAction.get("update_permission")).toBe("D");
    expect(byAction.get("delete_permission")).toBe("D");
  });
});
