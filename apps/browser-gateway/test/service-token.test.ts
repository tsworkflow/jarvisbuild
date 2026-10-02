import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBrowserGatewayToken } from "../../../modules/tool-gateway/src/browser-transport.ts";
import {
  SERVICE_TOKEN_AUDIENCE, SERVICE_TOKEN_MAX_TTL_MS, ServiceTokenVerifier, signServiceToken, type ServiceTokenClaims
} from "../src/service-token.ts";

const SECRET = "x".repeat(40);
const sha = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const body = JSON.stringify({ action: "navigate", parameters: { url: "https://example.com" } });

function claims(overrides: Partial<ServiceTokenClaims> = {}, now = 1_000_000): ServiceTokenClaims {
  return { aud: SERVICE_TOKEN_AUDIENCE, iat: now, exp: now + 30_000, jti: `j-${Math.random()}`, act: "navigate", bh: sha(body), ...overrides };
}

describe("tjeneste-token (JARVIS-008)", () => {
  it("gyldig token verifiseres", () => {
    const v = new ServiceTokenVerifier(SECRET, () => 1_000_000);
    expect(v.verify(signServiceToken(SECRET, claims()), { action: "navigate", bodySha256: sha(body) }).ok).toBe(true);
  });

  it("KONTRAKT: tokenet ToolGateway-transporten signerer verifiseres av gatewayens verifikator", () => {
    const now = 5_000_000;
    const v = new ServiceTokenVerifier(SECRET, () => now);
    const token = signBrowserGatewayToken(SECRET, "navigate", body, now);
    expect(v.verify(token, { action: "navigate", bodySha256: sha(body) }).ok).toBe(true);
  });

  const cases: Array<[string, (t: string) => string | undefined, string]> = [
    ["manglende token", () => undefined, "malformed"],
    ["tom streng", () => "", "malformed"],
    ["søppel", () => "abc", "malformed"],
    ["feil versjon", (t) => t.replace(/^v1\./, "v2."), "malformed"],
    ["endret signatur", (t) => `${t.slice(0, -2)}AA`, "bad_signature"],
    ["endret claims", (t) => { const [v, c, m] = t.split("."); return `${v}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(c as string, "base64url").toString()), act: "screenshot" })).toString("base64url")}.${m}`; }, "bad_signature"]
  ];
  for (const [name, mutate, reason] of cases) {
    it(`avviser ${name}`, () => {
      const v = new ServiceTokenVerifier(SECRET, () => 1_000_000);
      const verdict = v.verify(mutate(signServiceToken(SECRET, claims())), { action: "navigate", bodySha256: sha(body) });
      expect(verdict).toEqual({ ok: false, reason });
    });
  }

  it("avviser token signert med en ANNEN hemmelighet", () => {
    const v = new ServiceTokenVerifier(SECRET, () => 1_000_000);
    expect(v.verify(signServiceToken("y".repeat(40), claims()), { action: "navigate", bodySha256: sha(body) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("avviser feil målgruppe, utløpt, fremtidig, for lang levetid", () => {
    const v = (now: number) => new ServiceTokenVerifier(SECRET, () => now);
    const exp = { action: "navigate", bodySha256: sha(body) };
    expect(v(1_000_000).verify(signServiceToken(SECRET, claims({ aud: "annen-tjeneste" })), exp)).toEqual({ ok: false, reason: "wrong_audience" });
    expect(v(1_100_000).verify(signServiceToken(SECRET, claims()), exp)).toEqual({ ok: false, reason: "expired" });
    expect(v(900_000).verify(signServiceToken(SECRET, claims()), exp)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(v(1_000_000).verify(signServiceToken(SECRET, claims({ exp: 1_000_000 + SERVICE_TOKEN_MAX_TTL_MS + 1 })), exp)).toEqual({ ok: false, reason: "ttl_too_long" });
  });

  it("er bundet til handling og eksakt kropp - kan ikke brukes mot en annen URL/handling", () => {
    const v = new ServiceTokenVerifier(SECRET, () => 1_000_000);
    const token = signServiceToken(SECRET, claims());
    expect(v.verify(token, { action: "screenshot", bodySha256: sha(body) })).toEqual({ ok: false, reason: "wrong_binding" });
    const other = JSON.stringify({ action: "navigate", parameters: { url: "http://169.254.169.254/" } });
    expect(v.verify(signServiceToken(SECRET, claims()), { action: "navigate", bodySha256: sha(other) })).toEqual({ ok: false, reason: "wrong_binding" });
  });

  it("er ENGANGS (replay avvises) og replay-cachen er begrenset (fail-closed)", () => {
    const v = new ServiceTokenVerifier(SECRET, () => 1_000_000, 2);
    const exp = { action: "navigate", bodySha256: sha(body) };
    const t = signServiceToken(SECRET, claims({ jti: "samme" }));
    expect(v.verify(t, exp).ok).toBe(true);
    expect(v.verify(t, exp)).toEqual({ ok: false, reason: "replayed" });
    expect(v.verify(signServiceToken(SECRET, claims({ jti: "b" })), exp).ok).toBe(true);
    expect(v.verify(signServiceToken(SECRET, claims({ jti: "c" })), exp)).toEqual({ ok: false, reason: "replay_cache_full" });
  });

  it("verifikatoren nekter å konstrueres med for kort hemmelighet", () => {
    expect(() => new ServiceTokenVerifier("kort")).toThrow("browser_gateway_token_secret_too_short");
  });
});
