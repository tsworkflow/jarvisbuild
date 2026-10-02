import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, renderStaticPage, staticPageHeaders, type ApiDeps } from "../src/server.ts";

/**
 * Remediering del 2 (JARVIS-065/066) - ATFERD over ekte HTTP: statiske sider får eier-identiteten fra validert konfig
 * (aldri hardkodet), nonce-CSP, rammebeskyttelse, og uten eier-konfig svarer de brukervendte sidene 503.
 */
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const pages = readdirSync(WEB_DIR).filter((f) => f.endsWith(".html"));

let withOwner: { url: string; close: () => Promise<void> };
let withoutOwner: { url: string; close: () => Promise<void> };

async function listen(deps?: ApiDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

beforeAll(async () => {
  withOwner = await listen({ owner: { tenant_id: "tenant-acme", person_id: "person-ola" } } as unknown as ApiDeps);
  withoutOwner = await listen(undefined);
});
afterAll(async () => {
  await withOwner?.close();
  await withoutOwner?.close();
});

describe("JARVIS-065: ingen hardkodet eier-identitet i sidene", () => {
  it.each(pages)("%s inneholder verken person-tobias eller tenant-personal", (file) => {
    const html = readFileSync(`${WEB_DIR}${file}`, "utf8");
    expect(html).not.toMatch(/person-tobias|tenant-personal/);
  });
  for (const path of ["/chat", "/voice", "/dashboard"]) {
    it(`GET ${path} med eier-konfig: eieren injiseres i <meta name="jarvis-owner">`, async () => {
      const res = await fetch(`${withOwner.url}${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const meta = /<meta name="jarvis-owner" content="([^"]*)">/.exec(html)?.[1];
      expect(meta).toBeDefined();
      expect(JSON.parse((meta as string).replace(/&quot;/g, '"'))).toEqual({ tenant_id: "tenant-acme", person_id: "person-ola" });
      expect(html).not.toContain("<!--JARVIS_OWNER_META-->");
      expect(html).not.toMatch(/person-tobias|tenant-personal/);
    });
    it(`GET ${path} UTEN eier-konfig: 503 owner_not_configured (aldri en stille default-identitet)`, async () => {
      const res = await fetch(`${withoutOwner.url}${path}`);
      expect(res.status).toBe(503);
      expect((await res.json() as { error: string }).error).toBe("owner_not_configured");
    });
  }
  it("GET / (HUD-skallet) trenger ikke eier og serveres alltid", async () => {
    const res = await fetch(`${withoutOwner.url}/`);
    expect(res.status).toBe(200);
  });
});

describe("JARVIS-066: sikkerhetsheadere og nonce-CSP", () => {
  it("alle sider får CSP med nonce (ingen unsafe-inline), frame-ancestors 'self', X-Frame-Options, nosniff, no-referrer", async () => {
    for (const path of ["/", "/chat", "/voice", "/dashboard"]) {
      const res = await fetch(`${withOwner.url}${path}`);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
      // D-366: `unsafe-inline` finnes KUN i `style-src-attr` (style-attributter); aldri for script-src/style-src (elementer).
      expect(csp.replace("style-src-attr 'unsafe-inline'", ""), path).not.toContain("unsafe-inline");
      expect(csp, path).toContain("style-src-attr 'unsafe-inline'");
      expect(csp, path).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp, path).not.toContain("unsafe-eval");
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("frame-ancestors 'self'");
      expect(csp, path).toContain("base-uri 'none'");
      expect(csp, path).toContain("object-src 'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] as string;
      const html = await res.text();
      // hver <script>/<style> bærer akkurat denne noncen - ingen inline-blokk uten nonce
      expect(html, path).not.toMatch(/<script>|<style>/);
      for (const tag of html.match(/<(script|style)[ >][^>]*>/g) ?? []) {
        if (/^<(script|style)(\s|>)/.test(tag) && !/\bsrc=/.test(tag)) expect(tag, path).toContain(`nonce="${nonce}"`);
      }
    }
  });
  it("noncen er unik per respons", async () => {
    const a = (await fetch(`${withOwner.url}/chat`)).headers.get("content-security-policy");
    const b = (await fetch(`${withOwner.url}/chat`)).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });
  it("sidene har ingen inline event-handlere (ville krevd unsafe-inline)", () => {
    for (const file of pages) {
      const html = readFileSync(`${WEB_DIR}${file}`, "utf8");
      expect(html, file).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(html, file).not.toMatch(/javascript:/i);
    }
  });
  it("renderStaticPage escaper attributtverdier (anførselstegn/vinkelparenteser kan ikke bryte ut av meta-taggen)", () => {
    const out = renderStaticPage("<head><!--JARVIS_OWNER_META--></head>", "N", { tenant_id: 't"><script>x', person_id: "p'q" });
    expect(out).not.toContain("<script>x");
    expect(out.match(/content="([^"]*)"/)?.[1]).toContain("&quot;");
  });
  it("staticPageHeaders: connect-src begrenset til samme opprinnelse + tale-gatewayen (port 3020)", () => {
    const csp = staticPageHeaders("N")["content-security-policy"] as string;
    expect(csp).toContain("connect-src 'self' ws://*:3020 wss://*:3020");
  });
});

describe("JARVIS-066: escapeHtml escaper anførselstegn (attributt-injeksjon)", () => {
  for (const file of ["voice.html", "dashboard.html"]) {
    it(`${file}: escapeHtml("\\"><img onerror=x>") inneholder ingen rå " eller <`, () => {
      const html = readFileSync(`${WEB_DIR}${file}`, "utf8");
      const body = /function escapeHtml\(text\) \{[\s\S]*?\n {2}\}/.exec(html)?.[0] as string;
      expect(body).toBeDefined();
      const escapeHtml = new Function(`${body}; return escapeHtml;`)() as (t: unknown) => string;
      const out = escapeHtml(`"><img src=x onerror='alert(1)'>&\``);
      expect(out).not.toMatch(/["'<>`]/);
      expect(out).toContain("&quot;");
      expect(out).toContain("&#39;");
      expect(out).toContain("&lt;");
    });
  }
});
