import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Remediering del 2 (JARVIS-008): kortlevd, signert tjeneste-token mellom ToolGateway
 * (api/worker) og browser-gateway. Gatewayen hadde tidligere INGEN autentisering på
 * `POST /invoke` - enhver klient på nettet kunne få Chromium til å hente hva som helst.
 *
 * Formatet er `v1.<claims-b64url>.<hmac-b64url>` (HMAC-SHA256 over `v1.<claims-b64url>`):
 *   - `aud`: fast målgruppe, slik at et token for en annen tjeneste ikke kan gjenbrukes her,
 *   - `iat`/`exp`: maks levetid 60 s,
 *   - `jti`: engangs-ID (replay-vern, begrenset minne),
 *   - `act` og `bh`: handlingen og SHA-256 av den eksakte request-kroppen - tokenet kan derfor
 *     ikke gjenbrukes mot en annen handling/URL.
 *
 * Signeringsdelen speiles BEVISST i `modules/tool-gateway/src/browser-transport.ts` (denne
 * pakken har ingen workspace-avhengigheter - en ny ville endret `pnpm-lock.yaml`). En kontrakts-
 * test (`modules/tool-gateway/test/remediation-2-browser-gateway-auth.test.ts`) låser at de to
 * implementasjonene er kompatible.
 */
export const SERVICE_TOKEN_AUDIENCE = "jarvis-browser-gateway";
export const SERVICE_TOKEN_MAX_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
export const MIN_SECRET_LENGTH = 32;

export interface ServiceTokenClaims {
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  act: string;
  bh: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signServiceToken(secret: string, claims: ServiceTokenClaims): string {
  const payload = `v1.${b64url(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  return `${payload}.${b64url(createHmac("sha256", secret).update(payload).digest())}`;
}

export type ServiceTokenVerdict =
  | { ok: true; claims: ServiceTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "wrong_audience" | "expired" | "not_yet_valid" | "ttl_too_long" | "wrong_binding" | "replayed" | "replay_cache_full" };

export class ServiceTokenVerifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly replayCapacity = 10_000
  ) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new Error("browser_gateway_token_secret_too_short");
    }
  }

  verify(token: string | undefined, expected: { action: string; bodySha256: string }): ServiceTokenVerdict {
    if (typeof token !== "string") return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
    const [version, claimsB64, macB64] = parts as [string, string, string];
    const expectedMac = createHmac("sha256", this.secret).update(`${version}.${claimsB64}`).digest();
    let presented: Buffer;
    try {
      presented = Buffer.from(macB64, "base64url");
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (presented.length !== expectedMac.length || !timingSafeEqual(presented, expectedMac)) {
      return { ok: false, reason: "bad_signature" };
    }
    let claims: ServiceTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8")) as ServiceTokenClaims;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (
      typeof claims.aud !== "string" || typeof claims.iat !== "number" || typeof claims.exp !== "number"
      || typeof claims.jti !== "string" || typeof claims.act !== "string" || typeof claims.bh !== "string"
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (claims.aud !== SERVICE_TOKEN_AUDIENCE) return { ok: false, reason: "wrong_audience" };
    const t = this.now();
    if (claims.iat > t + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
    if (claims.exp <= t) return { ok: false, reason: "expired" };
    if (claims.exp - claims.iat > SERVICE_TOKEN_MAX_TTL_MS) return { ok: false, reason: "ttl_too_long" };
    if (claims.act !== expected.action || claims.bh !== expected.bodySha256) return { ok: false, reason: "wrong_binding" };
    // Replay: jti er engangs. Utløpte oppføringer ryddes; full cache = fail-closed.
    for (const [jti, exp] of this.seen) {
      if (exp <= t) this.seen.delete(jti);
    }
    if (this.seen.has(claims.jti)) return { ok: false, reason: "replayed" };
    if (this.seen.size >= this.replayCapacity) return { ok: false, reason: "replay_cache_full" };
    this.seen.set(claims.jti, claims.exp);
    return { ok: true, claims };
  }
}
