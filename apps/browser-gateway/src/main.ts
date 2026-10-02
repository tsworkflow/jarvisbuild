import { PlaywrightBrowserEngine } from "./browser-engine.ts";
import { EgressProxy } from "./egress-proxy.ts";
import { MIN_SECRET_LENGTH } from "./service-token.ts";
import { createBrowserGateway } from "./server.ts";

/**
 * D-339: egen prosess (CLAUDE.md ufravikelig regel 5, SAMME "egen
 * prosess"-presedens som voice-gateway, D-212). Ingen database, ingen
 * leverandør-secrets.
 *
 * REMEDIERING DEL 2 (JARVIS-008): starter FAIL-CLOSED. Uten en tjeneste-token-hemmelighet (>= 32
 * tegn) startes ingenting - en gateway uten autentisering er nettopp feilen som ble rettet.
 * Chromium-sandboxen er påkrevd; `JARVIS_BROWSER_SANDBOX=off` finnes IKKE (kun tester konstruerer
 * motoren med `sandbox:false`).
 */
const secret = process.env["JARVIS_BROWSER_GATEWAY_TOKEN_SECRET"] ?? "";
if (secret.length < MIN_SECRET_LENGTH) {
  console.error(`browser-gateway: JARVIS_BROWSER_GATEWAY_TOKEN_SECRET mangler eller er kortere enn ${MIN_SECRET_LENGTH} tegn - starter ikke`);
  process.exit(1);
}
// D-340: JARVIS_BROWSER_GATEWAY_PORT="" (tom, men til stede i .env) - `||` fanger tom streng (Number("") er 0).
const port = Number(process.env["JARVIS_BROWSER_GATEWAY_PORT"] || "3030");

const proxy = new EgressProxy({
  onDeny: (reason, host, deniedPort) => console.warn(JSON.stringify({ msg: "browser_egress_denied", reason, host, port: deniedPort }))
});
const { port: proxyPort } = await proxy.start();
const engine = new PlaywrightBrowserEngine({ proxyServer: `http://127.0.0.1:${proxyPort}` });
const server = createBrowserGateway({ engine, tokenSecret: secret });

server.listen(port, () => {
  console.log(`jarvis-browser-gateway listening on :${port} (egress proxy on 127.0.0.1:${proxyPort})`);
});

async function shutdown(): Promise<void> {
  server.close();
  await engine.close();
  await proxy.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
