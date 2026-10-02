import { EgressBlockedError, assertPublicHttpUrl } from "./egress-policy.ts";
import { EGRESS_DENIED_HEADER } from "./egress-proxy.ts";

/**
 * D-339 (Tobias direkte i chat: "playwrite er viktig for at den skal kunne
 * kontrollere mer" - bekrefter branch (a) fra det tidligere D-326-funnet:
 * lokal/selv-hostet nettleserautomasjon, ALDRI en tredjeparts cloud-browser-
 * leverandør). Denne FØRSTE sliceen bygger KUN read-only nettleser-
 * kapabilitet - `navigate`/`extract_text`/`screenshot`. `click`/`fill_form`/
 * `submit` (mutasjon av tredjeparts nettsider) er BEVISST IKKE bygget denne
 * sliceen.
 *
 * REMEDIERING DEL 2 (JARVIS-008) endrer kontrakten:
 *   - HVERT kall får sin egen, tomme `BrowserContext` (ingen delt side/cookies/lagring mellom
 *     kall, og to kallere kan aldri lese eller bytte hverandres side). `extract_text` og
 *     `screenshot` tar derfor selv en `url` - det finnes ingen «gjeldende side» å huske.
 *   - All trafikk fra Chromium går gjennom `EgressProxy` (se egress-proxy.ts) - ingen bane til
 *     loopback/RFC1918/link-local/metadata/compose-verter, heller ikke via redirects/subressurser.
 *   - Chromium-sandboxen er PÅKREVD (`chromiumSandbox: true`). Starter ikke nettleseren med
 *     sandbox, feiler gatewayen lukket (`/health` = 503) - det finnes ingen stille `--no-sandbox`.
 */
export interface BrowserEngine {
  navigate(url: string): Promise<{ url: string; title: string }>;
  extractText(url: string): Promise<string>;
  screenshot(url: string): Promise<string>;
  /** Starter en ekte tom side (`about:blank`) i en frisk kontekst - svarer `false` hvis nettleseren ikke virker. */
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export const MAX_EXTRACTED_TEXT_CHARS = 200_000;
export const NAVIGATION_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_CONTEXTS = 2;

/** Gjenbrukt syntaktisk validering (ingen DNS) - `EgressBlockedError` ved brudd. */
export function assertNavigableUrl(rawUrl: unknown): string {
  return assertPublicHttpUrl(rawUrl);
}

export interface PlaywrightEngineOptions {
  /** `http://127.0.0.1:PORT` til `EgressProxy`. PÅKREVD - uten proxy finnes ingen egress-kontroll. */
  proxyServer: string;
  /** Chromium-sandbox. Standard `true`; `false` er KUN for tester som kjører som root i en sandkasse. */
  sandbox?: boolean;
  /** Eksplisitt Chromium-binær (KUN tester/dev; produksjonsimaget bruker Playwrights egen). */
  executablePath?: string;
}

export class BrowserBusyError extends Error {
  constructor() {
    super("browser_gateway_busy");
    this.name = "BrowserBusyError";
  }
}

/**
 * Én delt Chromium-PROSESS (starten er dyr), men én ny `BrowserContext` per kall - og
 * konteksten lukkes alltid (også ved feil/timeout).
 */
/**
 * Arkitekt-review av #219 (P2): WebRTC/ICE sender UDP (og TCP-kandidater) DIREKTE, utenom `--proxy-server`. En angriperside kunne
 * dermed nå docker-bro, vertens tjenester og LAN uten om egress-proxyen. `disable_non_proxied_udp` slår av all UDP som ikke går
 * via proxyen (og HTTP-proxyen støtter ikke UDP, så WebRTC mot ikke-proxiede mål blir stengt). Låst av en test mot ekte Chromium.
 */
export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  "--disable-dev-shm-usage",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp"
];

export class PlaywrightBrowserEngine implements BrowserEngine {
  private browserPromise: Promise<import("playwright").Browser> | undefined;
  private inFlight = 0;

  constructor(private readonly options: PlaywrightEngineOptions) {
    if (!options.proxyServer) {
      throw new Error("browser_gateway_proxy_required");
    }
  }

  private async browser(): Promise<import("playwright").Browser> {
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({
          headless: true,
          chromiumSandbox: this.options.sandbox ?? true,
          ...(this.options.executablePath !== undefined ? { executablePath: this.options.executablePath } : {}),
          proxy: { server: this.options.proxyServer, bypass: "<-loopback>" },
          args: [...CHROMIUM_LAUNCH_ARGS]
        });
        // Krasjet nettleser: glem den, så neste kall starter en frisk (ikke en cachet feil).
        browser.on("disconnected", () => {
          this.browserPromise = undefined;
        });
        return browser;
      })();
      this.browserPromise.catch(() => {
        this.browserPromise = undefined;
      });
    }
    return this.browserPromise;
  }

  private async withIsolatedPage<T>(url: string, work: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const safeUrl = assertNavigableUrl(url);
    if (this.inFlight >= MAX_CONCURRENT_CONTEXTS) {
      throw new BrowserBusyError();
    }
    this.inFlight += 1;
    let context: import("playwright").BrowserContext | undefined;
    try {
      const browser = await this.browser();
      context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [] });
      // Lag 2: samme syntaktiske sjekk for HVER forespørsel (redirects, subressurser). Lag 3 (proxyen) er autoritativ.
      await context.route("**/*", async (route) => {
        try {
          assertNavigableUrl(route.request().url());
        } catch {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(safeUrl, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      // En avvisning fra egress-proxyen (intern adresse, redirect til metadata, DNS mot privat IP) er en FEIL -
      // ikke en side som tilfeldigvis sier «forbidden».
      if (response?.headers()[EGRESS_DENIED_HEADER] === "1") {
        throw new EgressBlockedError("blocked_by_egress_proxy");
      }
      return await work(page);
    } finally {
      this.inFlight -= 1;
      await context?.close().catch(() => undefined);
    }
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    return this.withIsolatedPage(url, async (page) => ({ url: page.url(), title: await page.title() }));
  }

  async extractText(url: string): Promise<string> {
    return this.withIsolatedPage(url, async (page) => (await page.innerText("body")).slice(0, MAX_EXTRACTED_TEXT_CHARS));
  }

  async screenshot(url: string): Promise<string> {
    return this.withIsolatedPage(url, async (page) => (await page.screenshot({ type: "png" })).toString("base64"));
  }

  async healthCheck(): Promise<boolean> {
    let context: import("playwright").BrowserContext | undefined;
    try {
      const browser = await this.browser();
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: 5_000 });
      return true;
    } catch {
      return false;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.browserPromise) {
      const browser = await this.browserPromise.catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
    this.browserPromise = undefined;
  }
}
