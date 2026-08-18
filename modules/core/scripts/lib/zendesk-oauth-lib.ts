// UA-3 Support/Tickets (Zendesk, D-64): rene, testbare bygge-/parse-/
// beslutningsfunksjoner for `zendesk-reauth.ts`. INGEN nettverk/filsystem/
// prosess-side-effekter her (samme presedens som
// lib/google-drive-reauth-lib.ts/lib/q21-env-recovery.ts).
//
// Bevisst ENKLERE enn Google sin reauth-lib: Zendesk sin OAuth-flyt har
// INGEN "Desktop vs. Web application"-klienttype-tvetydighet (Zendesk-
// klienter opprettes direkte i Admin Center med et client_id/secret-par -
// ingen nedlastet JSON, ingen auto-oppdagelse i Nedlastinger-mappa nødvendig),
// og INGEN flerkonto-tvetydighet (Zendesk-flyten er scoped til ÉN eksplisitt
// konfigurert subdomain FØR scriptet i det hele tatt starter) - disse to
// kildene til Google-libens kompleksitet (D-42 til D-46) gjelder rett og
// slett ikke her, ikke en uteglemt forenkling.

/** Zendesk sine OAuth-scopes er BEVISST BREDE (`read`/`write`) - ikke gjettet, veldokumentert, stabilt mønster i ethvert offisielt Zendesk OAuth-eksempel. Granulære per-ressurs-scopes (f.eks. "tickets:read") er IKKE en bekreftet del av Zendesk sin offentlige OAuth-scope-modell - se D-64 sin capability-audit. */
export const REQUIRED_ZENDESK_SCOPES = ["read", "write"] as const;

export const DEFAULT_ZENDESK_REAUTH_PORT = 8944;
export const ZENDESK_OAUTH_CALLBACK_PATH = "/oauth2callback";

export class MissingZendeskClientCredentialsError extends Error {
  constructor() {
    super(
      "zendesk_reauth_missing_client_credentials: JARVIS_ZENDESK_SUBDOMAIN og/eller " +
        "JARVIS_ZENDESK_CLIENT_ID og/eller JARVIS_ZENDESK_CLIENT_SECRET mangler i .env - " +
        "ingen nettleser åpnet, ingen lokal server startet."
    );
    this.name = "MissingZendeskClientCredentialsError";
  }
}

/** Fail-closed FØR noe (server/nettleser) startes - samme presedens som `validateClientCredentials()` i Google-libens. */
export function validateZendeskClientCredentials(
  subdomain: string | undefined, clientId: string | undefined, clientSecret: string | undefined
): asserts subdomain is string {
  if (!subdomain || !clientId || !clientSecret) {
    throw new MissingZendeskClientCredentialsError();
  }
}

export interface ZendeskAuthorizationUrlParams {
  subdomain: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}

/**
 * Zendesk sitt dokumenterte authorization-code-endepunkt er PER SUBDOMAIN
 * (`https://<subdomain>.zendesk.com/oauth/authorizations/new`) - i motsetning
 * til Google sitt ETT globale endepunkt. `response_type=code` er den eneste
 * støttede flyten for Zendesk sine "Client OAuth"-integrasjoner.
 */
export function buildZendeskAuthorizationUrl(params: ZendeskAuthorizationUrlParams): string {
  const url = new URL(`https://${params.subdomain}.zendesk.com/oauth/authorizations/new`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function buildZendeskRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${ZENDESK_OAUTH_CALLBACK_PATH}`;
}

export class MalformedZendeskAuthorizationUrlError extends Error {
  constructor(missing: string[]) {
    super(`zendesk_reauth_malformed_authorization_url: mangler ${missing.join("; ")} - nettleseren blir IKKE åpnet.`);
    this.name = "MalformedZendeskAuthorizationUrlError";
  }
}

/** Pre-flight-validering FØR nettleseren åpnes - samme sikkerhetsnett-prinsipp som Google-libens `validateAuthorizationUrl()`. */
export function validateZendeskAuthorizationUrl(authorizationUrl: string, requiredScopes: readonly string[]): void {
  const parsed = new URL(authorizationUrl);
  const missing: string[] = [];
  if (parsed.searchParams.get("response_type") !== "code") missing.push("response_type=code");
  if (!parsed.searchParams.get("client_id")) missing.push("client_id");
  if (!parsed.searchParams.get("redirect_uri")) missing.push("redirect_uri");
  if (!parsed.searchParams.get("state")) missing.push("state");
  const scope = parsed.searchParams.get("scope") ?? "";
  if (!hasAllRequiredZendeskScopes(scope, requiredScopes)) {
    const missingScopes = requiredScopes.filter((s) => !new Set(scope.split(/\s+/)).has(s));
    missing.push(`scope (mangler: ${missingScopes.join(", ")})`);
  }
  if (missing.length > 0) throw new MalformedZendeskAuthorizationUrlError(missing);
}

export interface ZendeskCallbackResult {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

export function parseZendeskCallbackQuery(requestUrl: string): ZendeskCallbackResult {
  const url = new URL(requestUrl, "http://127.0.0.1");
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined
  };
}

/** CSRF-vern - samme prinsipp som `isValidCallbackState()` i Google-libens. */
export function isValidZendeskCallbackState(received: string | undefined, expected: string): boolean {
  return Boolean(received) && received === expected;
}

export function zendeskTokenExchangeFailureReason(status: number): string {
  return `zendesk_reauth_token_exchange_failed_${status}`;
}

export function hasAllRequiredZendeskScopes(grantedScope: string, required: readonly string[]): boolean {
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
  return required.every((scope) => granted.has(scope));
}
