// UA-3 Support/Tickets (Zendesk, D-64): interaktivt, lokalt (host-kjørt,
// ALDRI i Docker) OAuth-oppsett for Zendesk. Kjøres FØR
// `ua3-zendesk-host-run.ts` - skriver `JARVIS_ZENDESK_REFRESH_TOKEN` til
// `.env` (og `JARVIS_ZENDESK_AGENT_EMAIL` hvis den ikke allerede er satt).
//
// Forutsetning (Tobias, ÉN gang, i Zendesk Admin Center - IKKE i denne
// koden): Admin Center > Apps and integrations > APIs > Zendesk API >
// OAuth Clients > Add OAuth client. Redirect URL:
// `http://127.0.0.1:8944/oauth2callback` (eller porten satt via
// JARVIS_ZENDESK_REAUTH_PORT). Kopier client_id/client_secret til .env FØR
// dette scriptet kjøres - se .env.example.
//
// Bevisst MYE enklere enn google-drive-reauth.ts (841 linjer, D-42 til D-46):
// Zendesk har ingen "Desktop vs. Web application"-klienttype-tvetydighet og
// ingen flerkonto-tvetydighet (se toppkommentaren i zendesk-oauth-lib.ts) -
// disse to var Google-libens hoved-kompleksitetskilder.
//
// Kommando: node --env-file=.env --experimental-transform-types modules/core/scripts/zendesk-reauth.ts

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  DEFAULT_ZENDESK_REAUTH_PORT,
  REQUIRED_ZENDESK_SCOPES,
  ZENDESK_OAUTH_CALLBACK_PATH,
  buildZendeskAuthorizationUrl,
  buildZendeskRedirectUri,
  hasAllRequiredZendeskScopes,
  isValidZendeskCallbackState,
  parseZendeskCallbackQuery,
  validateZendeskAuthorizationUrl,
  validateZendeskClientCredentials,
  zendeskTokenExchangeFailureReason,
  type ZendeskCallbackResult
} from "./lib/zendesk-oauth-lib.ts";
import { buildUpdatedEnvLines, parseEnvValues, type EnvValues } from "./lib/q21-env-recovery.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function log(msg: string): void {
  console.log(`[zendesk-reauth] ${msg}`);
}

function readEnv(): { lines: string[]; values: EnvValues } {
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kjør fra repo-roten, kopier .env.example til .env først`);
  }
  const content = readFileSync(envPath, "utf8");
  return { lines: content.split("\n"), values: parseEnvValues(content) };
}

/** Samme presedens/begrunnelse som google-drive-reauth.ts sin `openBrowser()` - best-effort, feiler aldri hele flyten. */
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      execFileSync("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
    log("åpnet standardnettleseren automatisk.");
  } catch {
    log(`kunne IKKE åpne nettleseren automatisk - åpne denne URL-en manuelt:\n${url}`);
  }
}

const CALLBACK_HTML_OK = "<html><body><h3>Jarvis: Zendesk-autorisasjon mottatt.</h3><p>Du kan lukke denne fanen og gå tilbake til terminalen.</p></body></html>";
const CALLBACK_HTML_ERR = "<html><body><h3>Jarvis: Zendesk-autorisasjon feilet.</h3><p>Gå tilbake til terminalen for detaljer.</p></body></html>";

async function waitForCallback(port: number, expectedState: string): Promise<ZendeskCallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== ZENDESK_OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseZendeskCallbackQuery(req.url ?? "");
      const ok = !parsed.error && isValidZendeskCallbackState(parsed.state, expectedState) && Boolean(parsed.code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ok ? CALLBACK_HTML_OK : CALLBACK_HTML_ERR);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(parsed);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      resolve({ error: "TIMEOUT" });
    }, CALLBACK_TIMEOUT_MS);
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(port, "127.0.0.1");
  });
}

interface ZendeskTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

async function exchangeCode(subdomain: string, clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<ZendeskTokenResponse> {
  const response = await fetch(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: REQUIRED_ZENDESK_SCOPES.join(" ") })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new Error(`zendesk_reauth=FAIL_${zendeskTokenExchangeFailureReason(response.status)} (${body.error ?? "ukjent"}: ${body.error_description ?? "ingen beskrivelse"})`);
  }
  return (await response.json()) as ZendeskTokenResponse;
}

/** Live-bevis (§8-analogt til Google-flyten): en FAKTISK API-lesing med det nye access_token-et, ikke bare en vellykket exchange. Henter samtidig agentens e-post (kun til bokføring - `JARVIS_ZENDESK_AGENT_EMAIL`). */
async function meProbe(subdomain: string, accessToken: string): Promise<{ ok: true; email: string | undefined } | { ok: false; status: number }> {
  const response = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return { ok: false, status: response.status };
  const body = (await response.json()) as { user?: { email?: string } };
  return { ok: true, email: body.user?.email };
}

async function main(): Promise<void> {
  const { lines, values } = readEnv();
  const subdomain = values["JARVIS_ZENDESK_SUBDOMAIN"];
  const clientId = values["JARVIS_ZENDESK_CLIENT_ID"];
  const clientSecret = values["JARVIS_ZENDESK_CLIENT_SECRET"];
  validateZendeskClientCredentials(subdomain, clientId, clientSecret);

  const port = Number(values["JARVIS_ZENDESK_REAUTH_PORT"] ?? DEFAULT_ZENDESK_REAUTH_PORT);
  const state = randomBytes(16).toString("hex");
  const redirectUri = buildZendeskRedirectUri(port);
  const authUrl = buildZendeskAuthorizationUrl({ subdomain, clientId: clientId!, redirectUri, scopes: REQUIRED_ZENDESK_SCOPES, state });
  validateZendeskAuthorizationUrl(authUrl, REQUIRED_ZENDESK_SCOPES);

  log(`starter lokal callback-server på port ${port} ...`);
  const callbackPromise = waitForCallback(port, state);
  log("åpner nettleser for Zendesk-samtykke (Admin Center OAuth-klient kreves på forhånd, se toppkommentaren) ...");
  openBrowser(authUrl);

  const callback = await callbackPromise;
  if (callback.error) {
    throw new Error(`zendesk_reauth=FAIL_CALLBACK_${callback.error}`);
  }
  if (!isValidZendeskCallbackState(callback.state, state)) {
    throw new Error("zendesk_reauth=FAIL_STATE_MISMATCH - mulig CSRF eller en gammel/utløpt fane. Prøv igjen.");
  }
  if (!callback.code) {
    throw new Error("zendesk_reauth=FAIL_NO_CODE - callback mottatt uten en autorisasjonskode.");
  }
  log("callback mottatt - bytter kode mot access/refresh-token ...");

  const tokenResponse = await exchangeCode(subdomain, clientId!, clientSecret!, callback.code, redirectUri);
  if (!tokenResponse.refresh_token) {
    throw new Error(
      "zendesk_reauth=FAIL_NO_REFRESH_TOKEN - token-responsen manglet refresh_token. Fjern Jarvis sin OAuth-klient-" +
        "tilgang i Zendesk Admin Center og prøv igjen for å tvinge en fullstendig ny consent."
    );
  }
  if (!hasAllRequiredZendeskScopes(tokenResponse.scope ?? "", REQUIRED_ZENDESK_SCOPES)) {
    throw new Error(`zendesk_reauth=FAIL_INSUFFICIENT_SCOPE - fikk "${tokenResponse.scope ?? "(tom)"}", krevde "${REQUIRED_ZENDESK_SCOPES.join(" ")}".`);
  }

  log("verifiserer access-token med en ekte API-lesing (GET /api/v2/users/me.json) ...");
  const probe = await meProbe(subdomain, tokenResponse.access_token);
  if (!probe.ok) {
    throw new Error(`zendesk_reauth=FAIL_PROBE_${probe.status} - token-exchange lyktes, men den påfølgende API-lesingen feilet.`);
  }

  const updates: EnvValues = { JARVIS_ZENDESK_REFRESH_TOKEN: tokenResponse.refresh_token };
  if (probe.email && !values["JARVIS_ZENDESK_AGENT_EMAIL"]) {
    updates["JARVIS_ZENDESK_AGENT_EMAIL"] = probe.email;
  }
  const backupPath = `${envPath}.bak.${Date.now()}`;
  copyFileSync(envPath, backupPath);
  const nextContent = buildUpdatedEnvLines(lines, updates).join("\n");
  const tmpPath = `${envPath}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, nextContent);
  renameSync(tmpPath, envPath);

  log(`OK - JARVIS_ZENDESK_REFRESH_TOKEN skrevet til .env (backup: ${backupPath}).`);
  log("Kjør nå: node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-zendesk-host-run.ts");
}

main().catch((err: Error) => {
  console.error(`[zendesk-reauth] ${err.message}`);
  process.exitCode = 1;
});
