import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubTransport, GoogleDriveTransport, GoogleSheetsTransport } from "../src/live-transports.ts";
import { UnsafeVendorUrlError, assertGithubRepoSlug, assertSafeVendorUrl, encodePathSegment, guardedFetch } from "../src/url-safety.ts";

/**
 * Remediering del 2 (JARVIS-091): `encodeURIComponent("..")` er `..` - WHATWG-URL normaliserer `/x/../admin` til `/admin`
 * og endrer endepunktet under den opprinnelige kapabilitetsklassen. Sentral sikring på den RÅ URL-en + segmentkoding.
 */
const reason = (fn: () => unknown): string => {
  try { fn(); } catch (err) { if (err instanceof UnsafeVendorUrlError) return err.reason; throw err; }
  return "OK";
};

describe("encodePathSegment", () => {
  it("koder trygge id-er (inkl. mellomrom/:/@) og beholder dem som ETT segment", () => {
    expect(encodePathSegment("abc-123_X")).toBe("abc-123_X");
    expect(encodePathSegment("a b@c:d")).toBe("a%20b%40c%3Ad");
  });
  it.each(["..", ".", "%2e%2e", "%2E", "a/b", "a\\b", "a?b=1", "a#b", "", "x\u0000y", "x\ny", "a".repeat(513), "%2e.", ".%2E"])("avviser %j", (v) => {
    expect(reason(() => encodePathSegment(v, "file_id"))).toMatch(/^file_id_(invalid|unsafe)$/);
  });
  it("ikke-streng avvises", () => {
    expect(reason(() => encodePathSegment(undefined))).toBe("id_invalid");
    expect(reason(() => encodePathSegment(5 as unknown as string))).toBe("id_invalid");
  });
});

describe("assertGithubRepoSlug", () => {
  it("godtar owner/repo", () => expect(assertGithubRepoSlug("tsworkflow/jarvisbuild")).toBe("tsworkflow/jarvisbuild"));
  it.each(["a", "a/b/c", "../x", "a/..", "a/.", "a b/c", "a/b?x=1", "a/-b", "/a/b", "a/b/", "https://github.com/a/b", ""])("avviser %j", (v) => {
    expect(reason(() => assertGithubRepoSlug(v))).not.toBe("OK");
  });
});

describe("assertSafeVendorUrl: den RÅ URL-en sjekkes før sending", () => {
  it.each([
    "https://api.github.com/repos/a/b/branches/main",
    "https://api.github.com/repos/a/b/branches/feature%2Fx?per_page=1",
    "https://www.googleapis.com/drive/v3/files/abc?alt=media",
    "https://sheets.googleapis.com/v4/spreadsheets/x/values/Sheet1!A1%3AB2:append?valueInputOption=USER_ENTERED",
    "http://127.0.0.1:3000/api/x"
  ])("godtar %s", (u) => expect(reason(() => assertSafeVendorUrl(u))).toBe("OK"));
  it.each([
    ["https://api.github.com/repos/a/b/branches/..", "dot_segment"],
    ["https://api.github.com/repos/a/b/branches/../../../user", "dot_segment"],
    ["https://api.github.com/repos/a/b/%2e%2e/%2E%2e/user", "dot_segment"],
    ["https://api.github.com/repos/a/b/./x", "dot_segment"],
    ["https://api.github.com/repos/a/b/%2E/x", "dot_segment"],
    ["https://api.github.com/repos\\..\\x", "url_malformed"],
    ["https://api.github.com/repos/a/b\u0000", "url_malformed"],
    ["https://evil.example@api.github.com/x", "url_not_plain_http_url"],
    ["ftp://api.github.com/x", "url_not_plain_http_url"],
    ["//api.github.com/x", "url_not_plain_http_url"],
    ["https://api.github.com/x/%zz", "dot_segment"]
  ])("avviser %s (%s)", (u, expected) => {
    expect(reason(() => assertSafeVendorUrl(u))).toBe(expected);
  });
});

describe("guardedFetch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sender trygge URL-er uendret og nekter dot-segmenter UTEN å kalle nettverket", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await guardedFetch("https://api.github.com/repos/a/b/branches/main", { method: "GET" });
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(guardedFetch("https://api.github.com/repos/a/b/branches/..")).rejects.toThrow("unsafe_vendor_url:dot_segment");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("transporter: modellstyrte id-er kan ikke endre endepunktet", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const stub = () => {
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("JARVIS_GOOGLE_CLIENT_SECRET", "client-secret");
    const spy = vi.fn(async (input: unknown) =>
      String(input).includes("oauth2.googleapis.com")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    // Kun kall mot LEVERANDØR-endepunktene teller (token-utveksling er ikke modellstyrt).
    return { get calls() { return spy.mock.calls.filter((c) => !String(c[0]).includes("oauth2.googleapis.com") && !String(c[0]).includes("api.github.com/rate_limit")); } };
  };
  it("GitHub: branch `..` (encodeURIComponent lar `..` stå) og repo `../x` avvises før nettverket", async () => {
    const spy = stub();
    const t = new GithubTransport();
    await expect(t.invoke("get_branch", { repo: "a/b", branch: ".." }, "tok")).rejects.toThrow(/unsafe_vendor_url/);
    await expect(t.invoke("get_branch", { repo: "../x", branch: "main" }, "tok")).rejects.toThrow(/unsafe_vendor_url:repo/);
    await expect(t.invoke("get_pull_request", { repo: "a/b", pr_number: ".." }, "tok")).rejects.toThrow(/unsafe_vendor_url/);
    expect(spy.calls).toHaveLength(0);
  });
  it("Drive: file_id `..`, `../x` og `a/b` avvises; en vanlig id virker", async () => {
    const spy = stub();
    const t = new GoogleDriveTransport();
    for (const bad of ["..", "../admin", "a/b", "x?alt=media", "%2e%2e"]) {
      await expect(t.invoke("get_metadata", { file_id: bad }, "tok")).rejects.toThrow(/unsafe_vendor_url/);
    }
    expect(spy.calls).toHaveLength(0);
  });
  it("Sheets: spreadsheet_id med sti-tegn avvises", async () => {
    const spy = stub();
    const t = new GoogleSheetsTransport();
    for (const bad of ["..", "x/../y", "a/b"]) {
      await expect(t.invoke("read_range", { spreadsheet_id: bad, range: "A1:B2" }, "tok")).rejects.toThrow(/unsafe_vendor_url/);
    }
    expect(spy.calls).toHaveLength(0);
  });
});
