import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "Charlie"-minne-verifisering (task #118): komposisjons-rot-regresjonsvakt -
 * SAMME "text-/regresjonsvakt for et side-effekt-skript"-mønster som
 * `executive-wiring.test.ts` (main.ts/worker-main.ts kobler til DB og
 * starter en server idet de importeres, kan derfor ikke trygt importeres
 * direkte i en testfil).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: apps/api/src/main.ts registrerer memory.search i SAMME additionalTools-liste, med DEN SAMME memoryRetriever-instansen ConversationEngine bruker", () => {
  it("importerer MemorySearchTransport/memoryToolDefinitions fra @jarvis/tool-gateway", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*MemorySearchTransport[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
    expect(mainSource).toMatch(/import\s*\{[^}]*memoryToolDefinitions[^}]*\}\s*from\s*"@jarvis\/tool-gateway"/s);
  });

  it("konstruerer memoryRetriever ÉN gang og gjenbruker DEN i BEGGE additionalTools OG conversationEngine - ikke to separate instanser", () => {
    const constructions = mainSource.match(/new MemoryRetriever\(/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(mainSource).toContain("new MemorySearchTransport(memoryRetriever, memoryWriter)");
    // D-283: `memory:` er nå et lite komposisjonsobjekt (contextFor + ingest)
    // i stedet for `memoryRetriever` direkte - `contextFor` DELEGERER fortsatt
    // til DEN SAMME instansen, se egen påstand under.
    expect(mainSource).toContain("contextFor: (identity, userText) => memoryRetriever.contextFor(identity, userText),");
    // D-384: rom/sensitivitet må nå ruteren, ellers klassifiseres aldri helse-/special-minne.
    expect(mainSource).toContain("contextWithMeta: (identity, userText) => memoryRetriever.contextWithMeta(identity, userText),");
  });

  it("D-283/D-300: konstruerer memoryWriter ÉN gang, delt embedding-instans med memoryRetriever, LlmExtractionAdapter(gateway) som extractor, og kobler den inn som conversationEngine sin memory.ingest()", () => {
    const writerConstructions = mainSource.match(/new MemoryWriter\(/g) ?? [];
    expect(writerConstructions).toHaveLength(1);
    expect(mainSource).toMatch(/import\s*\{[^}]*MemoryWriter[^}]*\}\s*from\s*"@jarvis\/memory"/s);
    // D-300 (Tobias direkte i chat: "husker han ingenting... vi trodde det
    // fungerte fungerte det ikke"): D-287 sin regelbaserte extractor var for
    // streng til reell samtale - `LlmExtractionAdapter` er nå den wired-inn
    // implementasjonen, `RuleBasedExtractor` forblir kun en test-/referanse-
    // implementasjon i `@jarvis/memory`, IKKE lenger konstruert i main.ts.
    expect(mainSource).toMatch(/import\s*\{[^}]*LlmExtractionAdapter[^}]*\}\s*from\s*"@jarvis\/memory"/s);
    expect(mainSource).not.toMatch(/import\s*\{[^}]*RuleBasedExtractor[^}]*\}\s*from\s*"@jarvis\/memory"/s);
    expect(mainSource).toContain("new MemoryWriter(pool, memoryEmbedding, new LlmExtractionAdapter(gateway), policy)");
    // Del 3 (JARVIS-013): innlimt/lang tekst (opts.pasted) er ikke eierens egne ord -> untrusted (karantene).
    expect(mainSource).toContain("ingest: (identity, text, opts) =>");
    expect(mainSource).toContain('trust: opts?.pasted ? "untrusted" : "trusted"');
    expect(mainSource).toContain("memoryWriter.ingestText(");
  });

  it("kaller memoryToolDefinitions(new MemorySearchTransport(memoryRetriever, memoryWriter)) INNI additionalTools - IKKE et separat, parallelt registreringssted", () => {
    const callIdx = mainSource.indexOf("firstWaveTools({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = mainSource.slice(callIdx, mainSource.indexOf("})) toolGateway.register(tool);", callIdx));
    expect(callBlock).toContain("additionalTools: [");
    expect(callBlock).toContain("...memoryToolDefinitions(new MemorySearchTransport(memoryRetriever, memoryWriter))");
  });
});

describe("B: apps/api/src/worker-main.ts kobler BEVISST IKKE memory.search - samme klasse som situations/executive/governance selv (API-/HTTP-flate)", () => {
  it("importerer ikke MemorySearchTransport", () => {
    expect(workerSource).not.toContain("MemorySearchTransport");
  });
});
