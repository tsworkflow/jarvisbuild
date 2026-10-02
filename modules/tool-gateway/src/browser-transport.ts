import { createHash, createHmac, randomUUID } from "node:crypto";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * D-339: bro INN i `apps/browser-gateway` sin egen prosess (SAMME "egen
 * prosess, snakkes med via vanlig HTTP fetch()"-mønster som voice-gateway
 * sin `HttpCoreClient`, D-212 - her motsatt retning). `credential_ref`
 * (`JARVIS_BROWSER_GATEWAY_BASE_URL`) er selve BASE-URL-en til prosessen -
 * INGEN ekte ekstern hemmelighet finnes (Jarvis sin egen sideprosess, ikke
 * en tredjeparts-API), SAMME "credential_ref peker på en konfig-verdi, ikke
 * nødvendigvis et hemmelig token"-mønster som Docker sin
 * `JARVIS_DOCKER_BIN`.
 *
 * KUN de tre read-only handlingene finnes (`navigate`/`extract_text`/
 * `screenshot`) - `click`/`fill_form`/`submit` er BEVISST IKKE bygget denne
 * sliceen, se `browser-engine.ts` sitt filhode for full begrunnelse.
 */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(["navigate", "extract_text", "screenshot"]);

/**
 * Remediering del 2 (JARVIS-008): HVERT kall til gatewayen bærer et kortlevd, signert
 * tjeneste-token (HMAC-SHA256) bundet til handlingen og den eksakte request-kroppen. Formatet
 * og verifiseringen ligger i `apps/browser-gateway/src/service-token.ts` - signeringen speiles
 * her (pakkene deler bevisst ingen workspace-avhengighet) og låses av en kontraktstest.
 * Hemmeligheten (`JARVIS_BROWSER_GATEWAY_TOKEN_SECRET`) leses av `main.ts`/`worker-main.ts` og
 * gis hit ved konstruksjon; uten den feiler transporten LUKKET (aldri et uautentisert kall).
 */
const TOKEN_AUDIENCE = "jarvis-browser-gateway";
const TOKEN_TTL_MS = 30_000;

export function signBrowserGatewayToken(
  secret: string,
  action: string,
  body: string,
  nowMs: number = Date.now()
): string {
  const claims = {
    aud: TOKEN_AUDIENCE, iat: nowMs, exp: nowMs + TOKEN_TTL_MS, jti: randomUUID(), act: action,
    bh: createHash("sha256").update(body, "utf8").digest("hex")
  };
  const payload = `v1.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export class BrowserGatewayTransport implements ToolTransport {
  constructor(private readonly tokenSecret: string = "") {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!credential) {
      throw new Error("browser_gateway_base_url_not_configured");
    }
    if (this.tokenSecret.length < 32) {
      throw new Error("browser_gateway_auth_not_configured");
    }
    if (!KNOWN_ACTIONS.has(action)) {
      throw new Error(`browser_gateway_action_not_implemented:${action}`);
    }
    const body = JSON.stringify({ action, parameters });
    const response = await fetch(`${credential}/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signBrowserGatewayToken(this.tokenSecret, action, body)}`
      },
      body
    });
    const parsed = (await response.json().catch(() => undefined)) as { data?: JsonValue; error?: string } | undefined;
    if (!response.ok) {
      throw new Error(`browser_gateway_error_${response.status}:${parsed?.error ?? "unknown"}`);
    }
    // En 200 som ikke er gyldig JSON med et `data`-felt er en FEIL, ikke en vellykket tom respons.
    if (parsed === undefined || typeof parsed !== "object" || !("data" in parsed)) {
      throw new Error("browser_gateway_invalid_response");
    }
    return { data: parsed.data ?? null };
  }
}
