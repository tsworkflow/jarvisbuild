import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGatewayTransport } from "../src/browser-transport.ts";
import { ServiceTokenVerifier } from "../../../apps/browser-gateway/src/service-token.ts";

/**
 * D-339: rene wiring-/kontraktstester (INGEN embedded Postgres, INGEN ekte
 * Chromium - SAMME `fetch`-stubbing-mønster som `mcp-zapier-transport.test.ts`).
 * Beviser: kun de tre kjente handlingene finnes (`click`/`fill_form`/`submit`
 * avvises FØR noe HTTP-kall gjøres, SAMME "bevisst fraværende, ikke stubbet-
 * og-avvist"-disiplin som selve `apps/browser-gateway/src/server.ts` allerede
 * håndhever), base-URL-en (credential) brukes korrekt som endepunkt-prefiks,
 * og en feilrespons fra prosessen propageres uten å svelge feilteksten.
 */
const BASE_URL = "http://127.0.0.1:3030";
const SECRET = "t".repeat(48);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("A: konfigurasjonsvalidering og kjente handlinger", () => {
  it("tom credential (base-URL ikke konfigurert) kaster FØR noe HTTP-kall gjøres", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new BrowserGatewayTransport(SECRET);
    await expect(transport.invoke("navigate", { url: "https://example.com" }, "")).rejects.toThrow("browser_gateway_base_url_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("click/fill_form/submit finnes IKKE denne sliceen - avvist FØR noe HTTP-kall gjøres", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new BrowserGatewayTransport(SECRET);
    for (const action of ["click", "fill_form", "submit"]) {
      await expect(transport.invoke(action, {}, BASE_URL)).rejects.toThrow(`browser_gateway_action_not_implemented:${action}`);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("B: navigate/extract_text/screenshot - den ekte HTTP-kallformen", () => {
  it("navigate POST-er {action, parameters} til {base_url}/invoke og returnerer data", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { url: "https://example.com/", title: "Example" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = new BrowserGatewayTransport(SECRET);
    const result = await transport.invoke("navigate", { url: "https://example.com" }, BASE_URL);
    expect(result.data).toEqual({ url: "https://example.com/", title: "Example" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/invoke`);
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string) as { action: string; parameters: unknown };
    expect(body.action).toBe("navigate");
    expect(body.parameters).toEqual({ url: "https://example.com" });
  });

  it("extract_text returnerer den rå { text }-strukturen fra prosessen uendret", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { text: "hello" } }), { status: 200 })));
    const transport = new BrowserGatewayTransport(SECRET);
    const result = await transport.invoke("extract_text", { url: "https://example.com" }, BASE_URL);
    expect(result.data).toEqual({ text: "hello" });
  });

  it("screenshot returnerer den rå { image_base64 }-strukturen fra prosessen uendret", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { image_base64: "abc123" } }), { status: 200 })));
    const transport = new BrowserGatewayTransport(SECRET);
    const result = await transport.invoke("screenshot", { url: "https://example.com" }, BASE_URL);
    expect(result.data).toEqual({ image_base64: "abc123" });
  });
});

describe("C: feilhåndtering", () => {
  it("en feilrespons fra prosessen (400) propageres MED feilteksten, svelges ALDRI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "browser_gateway_missing_url" }), { status: 400 })));
    const transport = new BrowserGatewayTransport(SECRET);
    await expect(transport.invoke("navigate", {}, BASE_URL)).rejects.toThrow(/browser_gateway_error_400:browser_gateway_missing_url/);
  });

  it("en 500-feil UTEN parsbar JSON-kropp kaster fortsatt tydelig, ALDRI en uhåndtert exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("internal error", { status: 500 })));
    const transport = new BrowserGatewayTransport(SECRET);
    await expect(transport.invoke("navigate", { url: "https://example.com" }, BASE_URL)).rejects.toThrow(/browser_gateway_error_500/);
  });
});

describe("D: remediering del 2 (JARVIS-008) - transporten autentiserer ALLE kall mot gatewayen", () => {
  it("uten konfigurert token-hemmelighet feiler transporten LUKKET - ingen HTTP-kall gjøres", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const secret of [undefined, "", "for-kort"]) {
      const transport = secret === undefined ? new BrowserGatewayTransport() : new BrowserGatewayTransport(secret);
      await expect(transport.invoke("navigate", { url: "https://example.com" }, BASE_URL)).rejects.toThrow("browser_gateway_auth_not_configured");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hvert kall bærer et kortlevd Bearer-token bundet til handling + eksakt kropp, og gatewayens verifikator godtar det", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await new BrowserGatewayTransport(SECRET).invoke("navigate", { url: "https://example.com" }, BASE_URL);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const authorization = (init.headers as Record<string, string>)["authorization"] as string;
    expect(authorization.startsWith("Bearer v1.")).toBe(true);
    const { createHash } = await import("node:crypto");
    const verdict = new ServiceTokenVerifier(SECRET).verify(authorization.slice("Bearer ".length), {
      action: "navigate", bodySha256: createHash("sha256").update(init.body as string, "utf8").digest("hex")
    });
    expect(verdict.ok).toBe(true);
  });

  it("en 200-respons som IKKE er gyldig JSON med data-felt er en FEIL, ikke en vellykket tom respons", async () => {
    for (const response of [() => new Response("<html>ikke json</html>", { status: 200 }), () => new Response(JSON.stringify({ noe: "annet" }), { status: 200 })]) {
      vi.stubGlobal("fetch", vi.fn(async () => response()));
      await expect(new BrowserGatewayTransport(SECRET).invoke("navigate", { url: "https://example.com" }, BASE_URL)).rejects.toThrow("browser_gateway_invalid_response");
    }
  });
});
