import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserBusyError, type BrowserEngine } from "../src/browser-engine.ts";
import { MAX_BODY_BYTES, createBrowserGateway } from "../src/server.ts";
import { SERVICE_TOKEN_AUDIENCE, signServiceToken } from "../src/service-token.ts";

/**
 * D-339 + remediering del 2 (JARVIS-008): HTTP-kontraktstester mot `createBrowserGateway()` med en
 * `FakeBrowserEngine` (ingen ekte Chromium). Beviser at INGEN nettleserhandling kan nås uten et
 * gyldig, bundet tjeneste-token, at kroppen er begrenset, og at feil er generiske.
 */
class FakeBrowserEngine implements BrowserEngine {
  navigateCalls: string[] = [];
  extractCalls: string[] = [];
  healthy = true;
  busy = false;
  closed = false;

  async navigate(url: string) {
    if (this.busy) throw new BrowserBusyError();
    this.navigateCalls.push(url);
    return { url, title: "Fake Page Title" };
  }
  async extractText(url: string) {
    this.extractCalls.push(url);
    return "fake extracted text";
  }
  async screenshot(_url: string) {
    return "ZmFrZS1wbmctYnl0ZXM=";
  }
  async healthCheck() {
    return this.healthy;
  }
  async close() {
    this.closed = true;
  }
}

const SECRET = "s".repeat(48);
let engine: FakeBrowserEngine;
let baseUrl: string;
let server: ReturnType<typeof createBrowserGateway>;
let jtiSeq = 0;

beforeEach(async () => {
  engine = new FakeBrowserEngine();
  server = createBrowserGateway({ engine, tokenSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tokenFor(action: string, body: string, overrides: Record<string, unknown> = {}): string {
  const now = Date.now();
  return signServiceToken(SECRET, {
    aud: SERVICE_TOKEN_AUDIENCE, iat: now, exp: now + 30_000, jti: `jti-${jtiSeq++}`, act: action,
    bh: createHash("sha256").update(body, "utf8").digest("hex"), ...overrides
  } as never);
}

async function invoke(action: string, parameters: Record<string, unknown> = {}, headers: Record<string, string> | "signed" = "signed") {
  const body = JSON.stringify({ action, parameters });
  const h: Record<string, string> = { "content-type": "application/json", ...(headers === "signed" ? { authorization: `Bearer ${tokenFor(action, body)}` } : headers) };
  const response = await fetch(`${baseUrl}/invoke`, { method: "POST", headers: h, body });
  return { status: response.status, body: (await response.json()) as { data?: unknown; error?: string; request_id?: string } };
}

describe("A: /health kjører en ekte side", () => {
  it("200 når nettleseren virker", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
  });

  it("503 når nettleseren IKKE virker (ikke et falskt «ok»)", async () => {
    engine.healthy = false;
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
  });
});

describe("B: autentisering - ingen handling uten gyldig, bundet token (auth-løs /invoke → 401)", () => {
  it("uten Authorization-header → 401, engine IKKE kalt", async () => {
    const { status, body } = await invoke("navigate", { url: "https://example.com" }, {});
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(body.request_id).toMatch(/^bg_/);
    expect(engine.navigateCalls).toEqual([]);
  });

  it("feil skjema / søppel / feil hemmelighet → 401", async () => {
    for (const authorization of ["Basic abc", "Bearer ", "Bearer søppel", `Bearer ${signServiceToken("z".repeat(48), { aud: SERVICE_TOKEN_AUDIENCE, iat: Date.now(), exp: Date.now() + 1000, jti: "x", act: "navigate", bh: "0" })}`]) {
      const { status } = await invoke("navigate", { url: "https://example.com" }, { authorization });
      expect(status, authorization).toBe(401);
    }
    expect(engine.navigateCalls).toEqual([]);
  });

  it("utløpt token → 401", async () => {
    const body = JSON.stringify({ action: "navigate", parameters: { url: "https://example.com" } });
    const old = Date.now() - 120_000;
    const { status } = await invoke("navigate", { url: "https://example.com" }, { authorization: `Bearer ${tokenFor("navigate", body, { iat: old, exp: old + 30_000 })}` });
    expect(status).toBe(401);
  });

  it("token for en ANNEN kropp (en tilfeldig URL byttet inn) → 401 - token kan ikke gjenbrukes mot intern URL", async () => {
    const signedBody = JSON.stringify({ action: "navigate", parameters: { url: "https://example.com" } });
    const evil = JSON.stringify({ action: "navigate", parameters: { url: "http://169.254.169.254/" } });
    const response = await fetch(`${baseUrl}/invoke`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("navigate", signedBody)}` }, body: evil
    });
    expect(response.status).toBe(401);
    expect(engine.navigateCalls).toEqual([]);
  });

  it("token er ENGANGS - replay → 401", async () => {
    const body = JSON.stringify({ action: "navigate", parameters: { url: "https://example.com" } });
    const authorization = `Bearer ${tokenFor("navigate", body)}`;
    const send = () => fetch(`${baseUrl}/invoke`, { method: "POST", headers: { "content-type": "application/json", authorization }, body });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
    expect(engine.navigateCalls).toHaveLength(1);
  });

  it("gatewayen starter ikke med for kort hemmelighet", () => {
    expect(() => createBrowserGateway({ engine, tokenSecret: "kort" })).toThrow("browser_gateway_token_secret_too_short");
  });
});

describe("C: handlinger (autentisert)", () => {
  it("navigate/extract_text/screenshot tar alle en url og kaller motoren", async () => {
    const nav = await invoke("navigate", { url: "https://example.com" });
    expect(nav.status).toBe(200);
    expect(nav.body.data).toEqual({ url: "https://example.com/", title: "Fake Page Title" });
    const ext = await invoke("extract_text", { url: "https://example.com/a" });
    expect(ext.body.data).toEqual({ text: "fake extracted text" });
    expect(engine.extractCalls).toEqual(["https://example.com/a"]);
    const shot = await invoke("screenshot", { url: "https://example.com" });
    expect(shot.body.data).toEqual({ image_base64: "ZmFrZS1wbmctYnl0ZXM=" });
  });

  it("direkte URL til intern adresse → 403 egress_blocked FØR motoren kalles", async () => {
    for (const url of ["http://169.254.169.254/latest/", "http://127.0.0.1:3010/", "http://infisical:8080/", "http://localhost/", "http://[::1]/", "http://2130706433/"]) {
      const { status, body } = await invoke("navigate", { url });
      expect(status, url).toBe(403);
      expect(body.error).toBe("egress_blocked");
    }
    expect(engine.navigateCalls).toEqual([]);
  });

  it("file:// og andre protokoller → 403, manglende url → 403", async () => {
    expect((await invoke("navigate", { url: "file:///etc/passwd" })).status).toBe(403);
    expect((await invoke("navigate", {})).status).toBe(403);
    expect(engine.navigateCalls).toEqual([]);
  });

  it("ukjente handlinger (click/fill_form/submit/call_tool) → 400 action_not_implemented", async () => {
    for (const action of ["click", "fill_form", "submit", "call_tool"]) {
      const { status, body } = await invoke(action, { url: "https://example.com" });
      expect(status).toBe(400);
      expect(body.error).toBe("action_not_implemented");
    }
  });

  it("ukjente parameterfelt avvises (400)", async () => {
    const { status } = await invoke("navigate", { url: "https://example.com", wait: 99999 });
    expect(status).toBe(400);
  });

  it("opptatt motor → 429 busy", async () => {
    engine.busy = true;
    expect((await invoke("navigate", { url: "https://example.com" })).status).toBe(429);
  });
});

describe("D: kropp og feil", () => {
  it("ugyldig JSON → 401 uten gyldig token (ingen innsikt i parsingen), ALDRI uhåndtert exception", async () => {
    const response = await fetch(`${baseUrl}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not valid json" });
    expect(response.status).toBe(401);
  });

  it("for stor kropp → 413 før noe parses", async () => {
    const response = await fetch(`${baseUrl}/invoke`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "navigate", pad: "x".repeat(MAX_BODY_BYTES + 1) })
    });
    expect(response.status).toBe(413);
  });

  it("motor-feil lekker ikke intern feiltekst", async () => {
    engine.navigate = async () => { throw new Error("INTERN: postgres://admin:hemmelig@db/internal"); };
    const { status, body } = await invoke("navigate", { url: "https://example.com" });
    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain("hemmelig");
    expect(body.error).toBe("browser_error");
  });

  it("ukjent sti gir 404 med request-id", async () => {
    const response = await fetch(`${baseUrl}/nonexistent`);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toMatch(/^bg_/);
  });
});
