import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-339: `apps/browser-gateway` hadde ingen egen docker-compose-tjeneste -
 * fraværende fra det containeriserte lokale oppsettet. Denne suiten beviser
 * at `browser-gateway`-tjenesten faktisk finnes, bruker sitt EGET image
 * (Microsoft sitt offisielle Playwright-baseimage, IKKE det delte
 * `api.Dockerfile`), og har ingen database-/credential-avhengighet - SAMME
 * "egen prosess"-presedens som `voice-gateway` (D-212).
 */
function readCompose(): string {
  return readFileSync(fileURLToPath(new URL("../../../infra/local/docker-compose.yml", import.meta.url)), "utf8");
}

function extractServiceBlock(compose: string, serviceName: string): string {
  const lines = compose.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s{2}${serviceName}:\\s*$`).test(l));
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^ {2}\S/.test(l));
  return lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
}

describe("D-339: browser-gateway-tjenesten finnes i infra/local/docker-compose.yml", () => {
  const compose = readCompose();
  const block = extractServiceBlock(compose, "browser-gateway");

  it("bruker sitt EGET image (browser-gateway.Dockerfile), ikke det delte api.Dockerfile", () => {
    expect(block).toMatch(/dockerfile:\s*infra\/local\/browser-gateway\.Dockerfile/);
    expect(block).not.toMatch(/dockerfile:\s*infra\/local\/api\.Dockerfile/);
  });

  it("ingen command:-overstyring - browser-gateway.Dockerfile sin egen CMD starter apps/browser-gateway/src/main.ts", () => {
    expect(block).not.toMatch(/command:/);
  });

  it("har INGEN depends_on - ingen database-/annen tjeneste-avhengighet i det hele tatt (egen, uavhengig prosess)", () => {
    expect(block).not.toMatch(/depends_on:/);
  });

  it("JARVIS_BROWSER_GATEWAY_PORT (default 3030) styrer lytteporten inni containeren, samme variabel som apps/browser-gateway/src/main.ts leser", () => {
    expect(block).toMatch(/JARVIS_BROWSER_GATEWAY_PORT:\s*"\$\{JARVIS_BROWSER_GATEWAY_PORT:-3030\}"/);
  });

  it("Remediering del 1 (JARVIS-008): INGEN host-publisering - uautentisert gateway nås kun via det interne Docker-nettverket", () => {
    expect(block).not.toMatch(/^\s{4}ports:/m);
    expect(block).not.toMatch(/^\s*-\s*"[\d.]+:\d+(:\d+)?"/m);
  });

  it("har helsesjekk mot /health, samme mønster som api-/voice-gateway-tjenestene", () => {
    expect(block).toMatch(/wget -qO- http:\/\/127\.0\.0\.1:\$\{JARVIS_BROWSER_GATEWAY_PORT:-3030\}\/health/);
  });
});
