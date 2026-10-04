import { guardedFetch } from "./url-safety.ts";

/**
 * D-388 (Tilkoblinger v2, JARVIS-090): felles, cachet OAuth2 `refresh_token`-utveksling for leverandører der et
 * STATISK bearer-token FAKTISK utløper etter timer (Dropbox: kortlivede access-tokens på 4 t; Microsoft Graph: 1 t).
 * Før D-388 lagret `JARVIS_DROPBOX_TOKEN`/`JARVIS_ONEDRIVE_TOKEN`/`JARVIS_OUTLOOK_TOKEN` et access-token rett i
 * Infisical/.env - connectoren virket til tokenet utløp, og deretter aldri mer uten manuell ny innliming.
 *
 * Prinsipper:
 * - Refresh-tokenet er den faktiske, langlivede secreten (Infisical/.env). Access-tokens finnes KUN i minnet, caches til
 *   60 s før `expires_in`, og logges aldri.
 * - Leverandører som ROTERER refresh-tokenet (Microsoft: nytt refresh_token i hvert svar; Spotify: av og til) får det nye
 *   skrevet tilbake via `persist` (ToolGateway.setSecret → Infisical). Mislykket persist er en logget advarsel - det gamle
 *   tokenet er fortsatt gyldig til utløp (Microsoft ~90 d), så kallet feiler ikke.
 * - Bakoverkompatibelt: finnes IKKE refresh-konfig, brukes credentialen som statisk bearer akkurat som før.
 *
 * Endepunkt/parametre verifisert 2026-10-04 mot offisiell dokumentasjon (dropbox.tech «Using OAuth 2.0 with offline
 * access»; Microsoft Entra «v2-oauth2-auth-code-flow», avsnittet «Refresh the access token»).
 */
export interface RefreshedToken {
  access_token: string;
  /** Sekunder til utløp (fra leverandøren). */
  expires_in: number;
  /** Nytt refresh-token når leverandøren roterer. */
  refresh_token?: string;
}

export interface RefreshTokenExchange {
  /** Henter et nytt access-token (+ ev. rotert refresh-token) for refresh-tokenet. */
  exchange(refreshToken: string): Promise<RefreshedToken>;
}

const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;

/**
 * Cache per refresh-token (i minnet, per prosess). `get()` returnerer et gyldig access-token, utveksler ved behov og
 * kaller `persist` når leverandøren roterte refresh-tokenet. Parallelle kall deler samme pågående utveksling.
 */
export class AccessTokenCache {
  private readonly entries = new Map<string, { access_token: string; expires_at_ms: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly exchanger: RefreshTokenExchange,
    private readonly options: { persist?: (newRefreshToken: string) => Promise<void>; now?: () => number; label?: string } = {}
  ) {}

  async get(refreshToken: string): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.entries.get(refreshToken);
    if (cached && cached.expires_at_ms - EXPIRY_MARGIN_MS > now) return cached.access_token;
    const pending = this.inflight.get(refreshToken);
    if (pending) return pending;
    const run = (async () => {
      try {
        const token = await this.exchanger.exchange(refreshToken);
        const expiresIn = Number.isFinite(token.expires_in) && token.expires_in > 0 ? token.expires_in : DEFAULT_EXPIRES_IN_S;
        const entry = { access_token: token.access_token, expires_at_ms: (this.options.now?.() ?? Date.now()) + expiresIn * 1000 };
        this.entries.set(refreshToken, entry);
        if (token.refresh_token && token.refresh_token !== refreshToken) {
          // Rotert: det nye tokenet er gyldig for neste runde - cache det under den nye nøkkelen også, og persister.
          this.entries.set(token.refresh_token, entry);
          if (this.options.persist) {
            try {
              await this.options.persist(token.refresh_token);
            } catch (err) {
              console.error(JSON.stringify({ msg: "oauth_refresh_token_persist_failed", provider: this.options.label ?? "unknown", error: (err as Error).message.slice(0, 200) }));
            }
          }
        }
        return entry.access_token;
      } finally {
        this.inflight.delete(refreshToken);
      }
    })();
    this.inflight.set(refreshToken, run);
    return run;
  }

  /** Kastes når leverandøren avviser tokenet (401/invalid_grant) slik at neste kall gjør en fersk utveksling. */
  invalidate(refreshToken: string): void {
    this.entries.delete(refreshToken);
  }
}

async function postForm(url: string, form: Record<string, string>, headers: Record<string, string>, label: string): Promise<RefreshedToken> {
  const response = await guardedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form)
  });
  if (!response.ok) {
    let raw = "";
    try { raw = await response.text(); } catch { raw = ""; }
    const errorCode = /"error"\s*:\s*"([a-z_]+)"/.exec(raw)?.[1];
    throw new Error(`${label}_auth_failed_${response.status}${errorCode ? `:${errorCode}` : ""}`);
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number | string; refresh_token?: string };
  if (typeof body.access_token !== "string" || body.access_token === "") throw new Error(`${label}_auth_invalid_response`);
  const expiresIn = typeof body.expires_in === "string" ? Number.parseInt(body.expires_in, 10) : body.expires_in;
  return {
    access_token: body.access_token,
    expires_in: Number.isFinite(expiresIn) && (expiresIn as number) > 0 ? (expiresIn as number) : DEFAULT_EXPIRES_IN_S,
    ...(typeof body.refresh_token === "string" && body.refresh_token !== "" ? { refresh_token: body.refresh_token } : {})
  };
}

/** Resolver-closure (samme mønster som n8n/Grafana sin base-URL): konfig leses ved hvert kall via secret-kjeden, aldri fryst fra env ved oppstart. */
export type ConfigResolver = () => Promise<string | null>;

/**
 * Dropbox: `POST https://api.dropboxapi.com/oauth2/token` med `grant_type=refresh_token`, `refresh_token`, `client_id`
 * (app key) og `client_secret` (app secret). Refresh-tokenet roterer IKKE og utløper ikke av seg selv.
 */
export function dropboxRefreshExchange(appKey: ConfigResolver, appSecret: ConfigResolver): RefreshTokenExchange {
  return {
    async exchange(refreshToken) {
      const [key, secret] = await Promise.all([appKey(), appSecret()]);
      if (!key || !secret) throw new Error("dropbox_oauth_app_not_configured");
      return postForm("https://api.dropboxapi.com/oauth2/token", {
        grant_type: "refresh_token", refresh_token: refreshToken, client_id: key, client_secret: secret
      }, {}, "dropbox");
    }
  };
}

/**
 * Microsoft identity platform (Graph): `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` med
 * `client_id`, `scope`, `refresh_token`, `grant_type=refresh_token` og `client_secret` (konfidensiell klient).
 * Svaret inneholder ALLTID et nytt `refresh_token` som skal brukes neste gang - derfor `persist`.
 */
export function microsoftRefreshExchange(
  clientId: ConfigResolver,
  clientSecret: ConfigResolver,
  tenant: ConfigResolver,
  scope: string
): RefreshTokenExchange {
  return {
    async exchange(refreshToken) {
      const [id, secret, tenantId] = await Promise.all([clientId(), clientSecret(), tenant()]);
      if (!id) throw new Error("microsoft_oauth_app_not_configured");
      const form: Record<string, string> = { client_id: id, scope, refresh_token: refreshToken, grant_type: "refresh_token" };
      if (secret) form["client_secret"] = secret;
      const tenantSegment = encodeURIComponent((tenantId ?? "").trim() || "common");
      return postForm(`https://login.microsoftonline.com/${tenantSegment}/oauth2/v2.0/token`, form, {}, "microsoft");
    }
  };
}

/**
 * Spotify Accounts: `POST https://accounts.spotify.com/api/token` med Basic-auth (client_id:client_secret) og
 * `grant_type=refresh_token`. Spotify KAN returnere et nytt `refresh_token` - ignoreres det (JARVIS-090), fortsetter
 * det gamle å virke til Spotify velger å avvise det. Håndteres nå via `persist`.
 */
export function spotifyRefreshExchange(clientId: ConfigResolver, clientSecret: ConfigResolver): RefreshTokenExchange {
  return {
    async exchange(refreshToken) {
      const [id, secret] = await Promise.all([clientId(), clientSecret()]);
      if (!id || !secret) throw new Error("spotify_oauth_client_not_configured");
      return postForm("https://accounts.spotify.com/api/token", { grant_type: "refresh_token", refresh_token: refreshToken }, {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`
      }, "spotify");
    }
  };
}

/**
 * Bakoverkompatibel bærer: finnes et refresh-token i konfig, byttes det til et cachet access-token; ellers brukes
 * `credential` (den gamle statiske token-verdien) uendret. Returnerer også hvilket modus som ble valgt (for tester/logg).
 */
export async function bearerFor(
  credential: string,
  refreshToken: ConfigResolver | undefined,
  cache: AccessTokenCache | undefined
): Promise<{ token: string; mode: "refresh" | "static" }> {
  if (refreshToken && cache) {
    const rt = await refreshToken();
    if (rt && rt.trim() !== "") return { token: await cache.get(rt.trim()), mode: "refresh" };
  }
  return { token: credential, mode: "static" };
}
