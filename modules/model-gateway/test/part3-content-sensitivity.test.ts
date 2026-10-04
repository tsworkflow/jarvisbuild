import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../src/capability-registry.ts";
import { classifyContentSensitivity, isSensitivityEligible, maxSensitivity, partitionHistoryBySensitivity } from "@jarvis/model-gateway";

/** Del 3 (JARVIS-016/035): innholdsbasert sensitivitet. Kun TESTEDE kategorier er garantert; dette er ikke en generell DLP. */
const freeCloud = { hosted_free_tier: true, locality: "cloud" } as unknown as ModelProfile;
const paidCloud = { hosted_free_tier: false, locality: "cloud" } as unknown as ModelProfile;
const local = { hosted_free_tier: false, locality: "local" } as unknown as ModelProfile;

describe("classifyContentSensitivity", () => {
  it("vanlig småprat uten minne er PUBLIC → gratis sky er kvalifisert (D-203-standarden består)", () => {
    const d = classifyContentSensitivity({ texts: ["Hva er hovedstaden i Frankrike?", "Hei!"] });
    expect(d.sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(isSensitivityEligible(freeCloud, d.sensitivity)).toBe(true);
  });
  it.each([
    ["helsespørsmål", { texts: ["Jeg har fått en ny diagnose og trenger å bestille legetime"] }],
    ["resept", { texts: ["Når går resepten på blodtrykksmedisinen ut?"] }],
    ["helse-minnerom", { texts: ["hva var det igjen?"], memory_spaces: ["health"] }],
    ["minneelement merket special", { texts: ["hei"], memory_spaces: [], memory_sensitivities: ["special"] }],
    ["kontonummer", { texts: ["Kontonummeret mitt er 1234.56.78901"] }],
    ["IBAN", { texts: ["IBAN NO93 8601 1117 947"] }],
    ["saldo", { texts: ["Hva er saldoen min?"] }],
    ["lønn", { texts: ["Hva er lønnen min i år?"] }],
    ["API-nøkkel", { texts: ["her er den: ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop"] }],
    ["kortnummer (Luhn)", { texts: ["kortet 4111 1111 1111 1111"] }]
  ] as const)("%s ⇒ SECRET_RESTRICTED: kun lokal behandler, aldri gratis/betalt sky", (_name, input) => {
    const d = classifyContentSensitivity(input);
    expect(d.sensitivity).toBe("SECRET_RESTRICTED");
    expect(isSensitivityEligible(freeCloud, d.sensitivity)).toBe(false);
    expect(isSensitivityEligible(paidCloud, d.sensitivity)).toBe(false);
    expect(isSensitivityEligible(local, d.sensitivity)).toBe(true);
  });
  it("privat minne (personal/home) eller verktøyoutput fra private kilder ekskluderer gratis/delt sky men tillater betalt sky", () => {
    for (const input of [{ memory_spaces: ["personal"] }, { memory_spaces: ["home"] }, { private_tool_output: true }, { memory_sensitivities: ["sensitive"] }, { memory_spaces: ["guest"] }]) {
      const d = classifyContentSensitivity({ texts: ["hei"], ...input });
      expect(d.sensitivity).not.toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(isSensitivityEligible(freeCloud, d.sensitivity)).toBe(false);
      expect(isSensitivityEligible(paidCloud, d.sensitivity)).toBe(true);
    }
  });
  it("forretningsminne ⇒ BUSINESS_CONFIDENTIAL, svak finans (faktura) ⇒ minst PRIVATE", () => {
    expect(classifyContentSensitivity({ memory_spaces: ["business"] }).sensitivity).toBe("BUSINESS_CONFIDENTIAL");
    expect(classifyContentSensitivity({ texts: ["send fakturaen til kunden"] }).sensitivity).not.toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
  it("det strengeste signalet vinner og årsakene er sporbare", () => {
    const d = classifyContentSensitivity({ texts: ["hva med lønnen?"], memory_spaces: ["personal"] });
    expect(d.sensitivity).toBe("SECRET_RESTRICTED");
    expect(d.reasons).toEqual(expect.arrayContaining(["memory_space:personal", "text:finance"]));
  });
  it("maxSensitivity", () => {
    expect(maxSensitivity("PRIVATE", "SECRET_RESTRICTED", undefined)).toBe("SECRET_RESTRICTED");
    expect(maxSensitivity()).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});

describe("D-384: partitionHistoryBySensitivity", () => {
  const msgs = (...c: string[]) => c.map((content) => ({ role: "user" as const, content }));

  it("eldre helse-/finansmelding utenfor det nylige vinduet holdes utenfor når turen ellers er lav-sensitiv", () => {
    const history = msgs("jeg fikk en ny diagnose i går", "ok", "hva er hovedstaden i Frankrike?", "Paris", "og Tyskland?", "Berlin");
    const { kept, withheld } = partitionHistoryBySensitivity(history, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(withheld).toBe(1);
    expect(kept.map((m) => m.content)).not.toContain("jeg fikk en ny diagnose i går");
    expect(kept).toHaveLength(5);
  });

  it("sensitiv melding i det nylige vinduet beholdes (oppfølgingsspørsmål), så turen forblir låst lokalt", () => {
    const history = msgs("hei", "hei!", "hva er saldoen min?", "Saldoen er ...");
    const { kept, withheld } = partitionHistoryBySensitivity(history, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(withheld).toBe(0);
    expect(kept).toHaveLength(4);
    expect(classifyContentSensitivity({ texts: kept.map((m) => m.content) }).sensitivity).toBe("SECRET_RESTRICTED");
  });

  it("tak = SECRET_RESTRICTED beholder alt; hemmelighet i gammel melding holdes ute ved lavere tak; rekkefølgen bevares", () => {
    const history = msgs("saldo 1", "a", "b", "c", "d", "e");
    expect(partitionHistoryBySensitivity(history, "SECRET_RESTRICTED").withheld).toBe(0);
    const out = partitionHistoryBySensitivity(history, "PRIVATE");
    expect(out.kept.map((m) => m.content)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
