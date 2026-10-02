import { existsSync } from "node:fs";
import http, { type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import dgram from "node:dgram";
import { CHROMIUM_LAUNCH_ARGS, PlaywrightBrowserEngine } from "../src/browser-engine.ts";
import { EgressProxy } from "../src/egress-proxy.ts";

/**
 * Remediering del 2 (JARVIS-008): EKTE Chromium bak EKTE egress-proxy. Beviser at ingen nettverksbane
 * fra nettleseren når interne adresser - direkte URL, redirect til metadata/loopback, subressurs (iframe/img/fetch)
 * mot intern tjeneste og DNS-svar mot privat adresse - og at hvert kall har en egen, tom nettleserkontekst.
 *
 * Kjører kun der en Chromium-binær finnes (`/opt/pw-browsers/chromium` i utviklingsmiljøet, eller
 * `JARVIS_TEST_CHROMIUM_PATH`). CI-bildet har ingen nettleser: da hoppes filen over, og
 * bevisene står i `docs/remediation/PHASE_2_GATE.md` (kjørt lokalt) + de rene proxy-testene som ALLTID kjører.
 */
const CHROMIUM = process.env["JARVIS_TEST_CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium";
const hasChromium = existsSync(CHROMIUM);

let internal: Server;
let publicSite: Server;
const internalHits: string[] = [];
const udpHits: string[] = [];
let udp: dgram.Socket;
let udpPort = 0;
let proxy: EgressProxy;
let engine: PlaywrightBrowserEngine;

const DNS: Record<string, string[]> = {
  "public.example.test": ["93.184.216.34"],
  "evil-rebind.example.test": ["10.1.2.3"]
};

describe.skipIf(!hasChromium)("ekte Chromium + EgressProxy", () => {
  beforeAll(async () => {
    internal = http.createServer((req, res) => { internalHits.push(req.url ?? ""); res.end("INTERN-HEMMELIGHET"); });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    // UDP-lytter som en angriperside kunne nådd via WebRTC/ICE (STUN) UTENOM proxyen.
    udp = dgram.createSocket("udp4");
    udp.on("message", (msg) => udpHits.push(msg.toString("hex").slice(0, 16)));
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
    udpPort = (udp.address() as AddressInfo).port;
    const internalPort = (internal.address() as AddressInfo).port;
    publicSite = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/redirect-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
      if (url === "/redirect-loopback") { res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/via-redirect` }); return res.end(); }
      if (url === "/redirect-compose") { res.writeHead(302, { location: "http://infisical/" }); return res.end(); }
      if (url === "/set-cookie") { res.writeHead(200, { "set-cookie": "sid=hemmelig-sesjon; Path=/", "content-type": "text/html" }); return res.end("<html><body><h1>cookie satt</h1><script>localStorage.setItem('k','v')</script></body></html>"); }
      if (url === "/read-state") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><body><div id=o></div><script>document.getElementById('o').textContent='cookie=['+document.cookie+'] ls=['+(localStorage.getItem('k')||'')+']'</script></body></html>`); }
      if (url === "/webrtc") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body><div id=o>start</div><script>
          (async () => {
            try {
              const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }] });
              pc.createDataChannel("x");
              await pc.setLocalDescription(await pc.createOffer());
              await new Promise((r) => setTimeout(r, 2500));
              document.getElementById("o").textContent = "webrtc-ferdig";
            } catch (e) { document.getElementById("o").textContent = "webrtc-feil"; }
          })();</script></body></html>`);
      }
      if (url === "/subresources") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<html><body>subressurs-test
          <img src="http://127.0.0.1:${internalPort}/img">
          <iframe src="http://127.0.0.1:${internalPort}/iframe"></iframe>
          <script>fetch("http://127.0.0.1:${internalPort}/fetch").catch(()=>{});
          fetch("http://169.254.169.254/x").catch(()=>{});</script></body></html>`);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Offentlig tittel</title></head><body>offentlig-innhold</body></html>");
    });
    await new Promise<void>((r) => publicSite.listen(0, "127.0.0.1", r));
    const publicPort = (publicSite.address() as AddressInfo).port;
    proxy = new EgressProxy({
      resolve: async (host) => { const a = DNS[host]; if (!a) throw new Error("ENOTFOUND"); return a; },
      // Alt som går til den «offentlige» IP-en havner hos offentlig-serveren; skulle policyen la noe annet slippe gjennom, treffer det intern-serveren.
      connect: (ip) => net.connect({ host: "127.0.0.1", port: ip === "93.184.216.34" ? publicPort : internalPort })
    });
    const { port } = await proxy.start();
    engine = new PlaywrightBrowserEngine({ proxyServer: `http://127.0.0.1:${port}`, sandbox: false, executablePath: CHROMIUM });
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    await proxy?.stop();
    await new Promise<void>((r) => internal?.close(() => r()));
    await new Promise<void>((r) => { try { udp?.close(() => r()); } catch { r(); } });
    await new Promise<void>((r) => publicSite?.close(() => r()));
  }, 60_000);

  it("positiv kontroll: en offentlig side lastes og leses", async () => {
    const nav = await engine.navigate("http://public.example.test/");
    expect(nav.title).toBe("Offentlig tittel");
    expect(await engine.extractText("http://public.example.test/")).toContain("offentlig-innhold");
    expect((await engine.screenshot("http://public.example.test/")).length).toBeGreaterThan(100);
    expect(internalHits).toEqual([]);
  }, 60_000);

  it("direkte URL til loopback/metadata/compose avvises før nettleseren - og intern server får ALDRI treff", async () => {
    const internalPort = (internal.address() as AddressInfo).port;
    for (const url of [`http://127.0.0.1:${internalPort}/`, "http://169.254.169.254/", "http://localhost/", "http://infisical/", "http://[::1]/"]) {
      await expect(engine.extractText(url), url).rejects.toThrow(/egress_blocked/);
    }
    expect(internalHits).toEqual([]);
  });

  it("DNS-svar mot privat adresse (rebinding) blokkeres av proxyen selv om vertsnavnet ser offentlig ut", async () => {
    await expect(engine.extractText("http://evil-rebind.example.test/")).rejects.toThrow();
    expect(internalHits).toEqual([]);
  }, 60_000);

  it("REDIRECT fra offentlig side til metadata/loopback/compose-vert blokkeres", async () => {
    for (const path of ["/redirect-metadata", "/redirect-loopback", "/redirect-compose"]) {
      await expect(engine.extractText(`http://public.example.test${path}`), path).rejects.toThrow();
    }
    expect(internalHits).toEqual([]);
  }, 90_000);

  it("SUBRESSURSER (img/iframe/fetch) mot intern adresse når aldri intern server, mens siden selv lastes", async () => {
    const text = await engine.extractText("http://public.example.test/subresources");
    expect(text).toContain("subressurs-test");
    expect(internalHits).toEqual([]);
  }, 60_000);

  it("HVERT kall har en egen kontekst: cookies og localStorage lekker ikke mellom kall", async () => {
    await engine.navigate("http://public.example.test/set-cookie");
    const text = await engine.extractText("http://public.example.test/read-state");
    expect(text).toContain("cookie=[]");
    expect(text).toContain("ls=[]");
    expect(text).not.toContain("hemmelig-sesjon");
  }, 60_000);

  it("Arkitekt-review (P2): WebRTC/ICE-UDP går IKKE utenom proxyen - en lokal UDP-lytter får aldri pakker fra siden", async () => {
    expect(CHROMIUM_LAUNCH_ARGS).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    udpHits.length = 0;
    // `extractText` leser sideteksten umiddelbart etter load; vent derfor via en side som selv bruker ~2,5 s på ICE-innsamlingen.
    await engine.extractText("http://public.example.test/webrtc");
    await new Promise((r) => setTimeout(r, 3500));
    expect(udpHits).toEqual([]);
  }, 60_000);

  it("helsesjekken kjører en ekte side", async () => {
    expect(await engine.healthCheck()).toBe(true);
  }, 30_000);
});
