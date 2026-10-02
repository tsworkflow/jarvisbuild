#!/bin/sh
# Live egress-test av KJØRENDE browser-gateway (Remediering del 2, JARVIS-008). Kjøres på NAS-en fra repo-roten:
#   sh ops/security/browser-egress-probe.sh            # standard
#   RUN_REDIRECT=1 sh ops/security/browser-egress-probe.sh   # + redirect-test via en offentlig tjeneste (krever internett)
#
# Hvordan: api-containeren HAR tjeneste-hemmeligheten og står på `browser`-nettet, så testen kjører INNE i den og signerer
# ekte tjeneste-tokens (hemmeligheten leses fra containerens miljø og skrives ALDRI ut). Hvert forsøk ber gatewayen om å
# hente en URL; interne mål SKAL gi 403 `egress_blocked`, kontrollen (offentlig side) SKAL gi 200. Kun statuskode og
# feilkode skrives ut (aldri sideinnhold). Ingenting endres; alle mål er kun lesing (GET via nettleser) og interne mål
# blir aldri hentet hvis policyen virker.
#
# MERK (arkitekt-review, D-368): de 17 direkte målene avvises av det SYNTAKTISKE laget (assertNavigableUrl) FØR Chromium. Det er
# REDIRECT-testene (kun med RUN_REDIRECT=1, krever internett), `browser_egress_denied`-linjene i gateway-loggen (del 4) og ekte-Chromium-testen
# i apps/browser-gateway/test/engine-egress.test.ts som viser at PROXY-laget håndhever. En redirect-test som ikke gir 403 egress_blocked
# (f.eks. 502 fordi httpbin er nede) er WARN, aldri PASS.
set -u
API="${API_CONTAINER:-local-api-1}"
RUN_REDIRECT="${RUN_REDIRECT:-0}"
docker inspect "$API" >/dev/null 2>&1 || { echo "finner ikke container $API (kjør på NAS-en)"; exit 2; }

echo "=== 1. Egress-policy fra api-containeren mot kjørende gateway"
docker exec -e RUN_REDIRECT="$RUN_REDIRECT" "$API" node --experimental-transform-types --input-type=module -e '
import { signBrowserGatewayToken } from "/app/modules/tool-gateway/src/browser-transport.ts";
const secret = process.env.JARVIS_BROWSER_GATEWAY_TOKEN_SECRET ?? "";
const base = process.env.JARVIS_BROWSER_GATEWAY_BASE_URL || "http://browser-gateway:3030";
if (secret.length < 32) { console.log("SETUP_FAIL tjeneste-hemmelighet mangler i api-containeren"); process.exit(2); }
const results = [];
async function call(url, { token, action = "extract_text" } = {}) {
  const body = JSON.stringify({ action, parameters: { url } });
  const auth = token ?? signBrowserGatewayToken(secret, action, body);
  const res = await fetch(base + "/invoke", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + auth }, body });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, error: j.error ?? "", hasData: j.data !== undefined, body, auth };
}
function record(label, expect, r) {
  const ok = expect === "BLOCK" ? r.status === 403 && r.error === "egress_blocked"
           : expect === "NOT200" ? r.status !== 200 && !r.hasData
           : expect === "401" ? r.status === 401
           : r.status === 200 && r.hasData;
  const warn = expect === "BLOCK" && !ok && r.status !== 200 && !r.hasData; // avvist, men ikke av egress-policyen
  results.push({ label, ok, warn });
  console.log((ok ? "PASS " : warn ? "WARN " : "FAIL ") + label.padEnd(46) + " forventet=" + expect + " fikk=" + r.status + (r.error ? " (" + r.error + ")" : "") + (r.hasData ? " [DATA MOTTATT]" : ""));
}
const BLOCK = [
  ["loopback 127.0.0.1 (gatewayen selv)", "http://127.0.0.1/"],
  ["localhost", "http://localhost/"],
  ["metadata 169.254.169.254", "http://169.254.169.254/latest/meta-data/"],
  ["compose-vert api (på browser-nettet!)", "http://api/"],
  ["compose-vert postgres", "http://postgres/"],
  ["docker-bro 172.17.0.1", "http://172.17.0.1/"],
  ["LAN 10.0.0.30 (NAS)", "http://10.0.0.30/"],
  ["LAN 192.168.1.1 (ruter)", "http://192.168.1.1/"],
  ["CGNAT/Tailscale 100.76.2.58", "http://100.76.2.58/"],
  ["IPv6 loopback", "http://[::1]/"],
  ["IPv4-mappet IPv6", "http://[::ffff:127.0.0.1]/"],
  ["heltall-IP 2130706433", "http://2130706433/"],
  ["hex-IP 0x7f000001", "http://0x7f000001/"],
  ["file://", "file:///etc/passwd"],
  ["credentials i URL", "http://user:pw@example.com/"],
  ["ikke-tillatt port (offentlig vert)", "http://example.com:5432/"],
  ["enkelt-label vert", "http://intranet/"]
];
for (const [label, url] of BLOCK) record(label, "BLOCK", await call(url));
// Kontroll: en vanlig offentlig side SKAL fungere (ellers er blokkeringene over bevisløse)
record("KONTROLL offentlig https://example.com/", "200", await call("https://example.com/"));
// Autentisering
{
  const r1 = await call("http://169.254.169.254/");               // gyldig token, blokkert mål -> 403
  record("token første bruk (gyldig, mål blokkert)", "BLOCK", r1);
  const res = await fetch(base + "/invoke", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + r1.auth }, body: r1.body });
  record("REPLAY av samme token (engangs)", "401", { status: res.status, error: (await res.json().catch(() => ({}))).error ?? "", hasData: false });
  const res2 = await fetch(base + "/invoke", { method: "POST", headers: { "content-type": "application/json" }, body: r1.body });
  record("uten token", "401", { status: res2.status, error: "", hasData: false });
  const wrong = signBrowserGatewayToken("x".repeat(40), "extract_text", r1.body);
  const res3 = await fetch(base + "/invoke", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + wrong }, body: r1.body });
  record("feil hemmelighet", "401", { status: res3.status, error: "", hasData: false });
  const t = signBrowserGatewayToken(secret, "extract_text", r1.body);
  const res4 = await fetch(base + "/invoke", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: r1.body.replace("169.254.169.254", "169.254.169.255") });
  record("token gjenbrukt med ENDRET body", "401", { status: res4.status, error: "", hasData: false });
}
if (process.env.RUN_REDIRECT === "1") {
  record("REDIRECT fra offentlig side til metadata", "BLOCK", await call("https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F&status_code=302"));
  record("REDIRECT til compose-vert api", "BLOCK", await call("https://httpbin.org/redirect-to?url=http%3A%2F%2Fapi%2F&status_code=302"));
}
const fail = results.filter((r) => !r.ok && !r.warn).length;
const warn = results.filter((r) => r.warn).length;
console.log("SAMMENDRAG: " + results.filter((r) => r.ok).length + " PASS, " + warn + " WARN, " + fail + " FAIL");
process.exit(fail > 0 ? 1 : 0);
' 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"

echo
echo "=== 2. Nettverksisolasjon: kun api/worker skal stå på browser-nettet sammen med gatewayen"
for c in local-api-1 local-worker-1; do
  nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null)"
  case "$nets" in *browser*) echo "PASS $c står på browser-nettet (forventet): $nets" ;; *) echo "FAIL $c står IKKE på browser-nettet: $nets" ;; esac
done
for c in local-postgres-1 local-voice-gateway-1 local-infisical-1 local-infisical-redis-1 local-langfuse-1; do
  nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null)"
  case "$nets" in *browser*) echo "FAIL $c står på browser-nettet: $nets" ;; *) echo "PASS $c står IKKE på browser-nettet: $nets" ;; esac
done
nets="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' local-browser-gateway-1 2>/dev/null)"
case "$nets" in *core*) echo "FAIL browser-gateway står på core-nettet: $nets" ;; *) echo "PASS browser-gateway står kun på: $nets" ;; esac
echo
echo "=== 3. Gatewayen er ikke publisert på verten"
if (command -v curl >/dev/null) && curl -s -m 3 -o /dev/null http://127.0.0.1:3030/health; then echo "FAIL gatewayen svarer på 127.0.0.1:3030 fra verten"; else echo "PASS ingen host-port for 3030"; fi
echo
echo "=== 4. Gateway-logg (kun egress-relaterte linjer, siste 10)"
docker logs --tail 200 local-browser-gateway-1 2>&1 | grep -iE "egress|blocked|browser_gateway_error" | cut -c1-200 | tail -10
