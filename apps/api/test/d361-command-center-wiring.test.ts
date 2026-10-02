import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-361 (Tobias direkte i chat: "sinnsyk interface ... et sted hvor jeg kan
 * skrive og snakke med jarvis direkte ... slipper og skrive 3 forskjellige
 * url"). `apps/web/command.html` er et HUD-SKALL som viser de tre allerede
 * eksisterende, allerede testede sidene (nå `/chat`, `/voice`, `/dashboard`)
 * som samme-origin iframes bak faner - ingen enhetsautentisering/lyd-/SSE-
 * logikk er duplisert. Denne suiten speiler `voice-page-wiring.test.ts` sitt
 * statiske kildetekst-mønster (ingen ekte HTTP-server startes).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const serverSource = readSource("../src/server.ts");
const commandHtml = readSource("../../web/command.html");

describe("A: GET / serverer nå apps/web/command.html (HUD-skallet), ikke lenger den rene chat-siden direkte", () => {
  it("WEB_COMMAND peker på apps/web/command.html", () => {
    expect(serverSource).toMatch(
      /const WEB_COMMAND = fileURLToPath\(new URL\("\.\.\/\.\.\/web\/command\.html", import\.meta\.url\)\);/
    );
  });

  it('ruten sjekker GET og url.pathname === "/" FØR den leser WEB_COMMAND', () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/"');
    expect(routeIdx).toBeGreaterThan(-1);
    const readIdx = serverSource.indexOf("sendStaticPage(res, WEB_COMMAND", routeIdx);
    expect(readIdx).toBeGreaterThan(routeIdx);
  });

  it("svarer med text/html; charset=utf-8 og no-cache, samme mønster som de andre sidene", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("return;", routeIdx));
    // Remediering del 2: headerne settes nå sentralt i `staticPageHeaders()` (CSP/nonce/rammebeskyttelse) for ALLE sider.
    expect(block).toContain("sendStaticPage(");
    expect(serverSource).toContain('"content-type": "text/html; charset=utf-8"');
    expect(serverSource).toContain('"cache-control": "no-cache"');
  });
});

describe("B: GET /chat serverer den uendrede, opprinnelige chat-siden (WEB_INDEX) - flyttet fra /, ikke omskrevet", () => {
  it('ny rute "/chat" leser WEB_INDEX (samme fil som FØR lå på /)', () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/chat"');
    expect(routeIdx).toBeGreaterThan(-1);
    const readIdx = serverSource.indexOf("sendStaticPage(res, WEB_INDEX", routeIdx);
    expect(readIdx).toBeGreaterThan(routeIdx);
    expect(readIdx).toBeLessThan(serverSource.indexOf("return;", routeIdx));
  });

  it("WEB_INDEX-konstanten selv er UENDRET (fortsatt apps/web/index.html)", () => {
    expect(serverSource).toMatch(
      /const WEB_INDEX = fileURLToPath\(new URL\("\.\.\/\.\.\/web\/index\.html", import\.meta\.url\)\);/
    );
  });
});

describe("C: GET /dashboard og GET /voice er UBERØRT av denne sliceen", () => {
  it("/dashboard-ruten finnes fortsatt og leser WEB_DASHBOARD", () => {
    expect(serverSource).toContain('url.pathname === "/dashboard"');
    expect(serverSource).toContain("sendStaticPage(res, WEB_DASHBOARD");
  });
  it("/voice-ruten finnes fortsatt og leser WEB_VOICE", () => {
    expect(serverSource).toContain('url.pathname === "/voice"');
    expect(serverSource).toContain("sendStaticPage(res, WEB_VOICE");
  });
});

describe("D: command.html monterer de tre sidene som samme-origin iframes, ingen duplisert identitets-/lyd-/SSE-logikk", () => {
  it('chat-fanen peker til "/chat"', () => {
    expect(commandHtml).toMatch(/id="frame-chat"[^>]*src="\/chat"/);
  });
  it('tale-fanen peker til "/voice" og ber om mikrofontilgang for iframen (allow="microphone")', () => {
    expect(commandHtml).toMatch(/id="frame-voice"[^>]*src="\/voice"/);
    expect(commandHtml).toMatch(/id="frame-voice"[^>]*allow="[^"]*microphone/);
  });
  it('oversikt-fanen peker til "/dashboard"', () => {
    expect(commandHtml).toMatch(/id="frame-dashboard"[^>]*src="\/dashboard"/);
  });
  it("skallet selv inneholder INGEN WebCrypto-enhetsautentisering (crypto.subtle) - det er iframenes ansvar, ikke duplisert her", () => {
    expect(commandHtml).not.toContain("crypto.subtle");
  });
  it("skallet selv åpner INGEN egen WebSocket (tale-strømmen eies av voice.html inne i sin iframe, CLAUDE.md regel 5)", () => {
    expect(commandHtml).not.toContain("new WebSocket(");
  });
});

describe("E: command.html sin ?enroll=-videresending (D-347/D-260-mønsteret, nå ett nivå ut)", () => {
  it("leser ?enroll= fra EGEN URL, fjerner den UMIDDELBART (history.replaceState) FØR videresending", () => {
    const idx = commandHtml.indexOf("incomingTicket");
    expect(idx).toBeGreaterThan(-1);
    const replaceIdx = commandHtml.indexOf("history.replaceState(", idx);
    const forwardIdx = commandHtml.indexOf("frames.chat.src", idx);
    expect(replaceIdx).toBeGreaterThan(idx);
    expect(forwardIdx).toBeGreaterThan(replaceIdx);
  });
  it("videresender til /chat?enroll=<billett>, konsumeres av chat-iframens EGEN tryAutoEnrollFromUrl() - ingen egen innrulleringslogikk her", () => {
    expect(commandHtml).toMatch(/frames\.chat\.src = "\/chat\?enroll="/);
  });
});

describe("F: ingen ekstern font-/CDN-avhengighet (CLAUDE.md regel 9, lokal først)", () => {
  it("ingen <link> mot et eksternt font-/CDN-domene", () => {
    expect(commandHtml).not.toMatch(/<link[^>]+href="https?:\/\//);
  });
  it("ingen <script src> mot et eksternt domene", () => {
    expect(commandHtml).not.toMatch(/<script[^>]+src="https?:\/\//);
  });
});
