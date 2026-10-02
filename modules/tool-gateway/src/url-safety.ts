/**
 * Remediering del 2 (JARVIS-091): modellstyrte id-er interpoleres i leverandørenes URL-stier.
 * `encodeURIComponent("..")` er FORTSATT `..`, og WHATWG-URL-parseren normaliserer `/files/../admin` til `/admin` FØR
 * forespørselen sendes - endepunktet endres altså under den opprinnelige kapabilitetsklassen/revisjonen (en `read`-handling
 * kan ende på et helt annet endepunkt). Forsvaret er todelt og sentralt:
 *   1. `encodePathSegment` for rene id-segmenter (avviser `.`/`..`/tom/`/`/`\\`/`?`/`#`/kontrolltegn),
 *   2. `guardedFetch`: ALLE utgående leverandørkall sjekkes på den RÅ URL-strengen FØR de sendes - kun http(s) mot en ren vert[:port], ingen
 *      brukerinfo/backslash/kontrolltegn, fast vert, og ingen `.`/`..`-segmenter (heller ikke prosentkodet `%2e`).
 */
export class UnsafeVendorUrlError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_vendor_url:${reason}`);
    this.name = "UnsafeVendorUrlError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function isDotSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true; // ugyldig prosentkoding i en sti-segment = avvis
  }
  return decoded === "." || decoded === ".." || /^(\.|%2e)+$/i.test(segment);
}

/** Ett sti-segment fra en modell-/klientstyrt verdi. Avviser alt som kan endre stien; ellers `encodeURIComponent`. */
export function encodePathSegment(value: unknown, label = "id"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new UnsafeVendorUrlError(`${label}_invalid`);
  if (CONTROL.test(value) || /[/\\?#]/.test(value) || isDotSegment(value)) throw new UnsafeVendorUrlError(`${label}_unsafe`);
  return encodeURIComponent(value);
}

/** `owner/repo` (GitHub): to segmenter med lukket tegnsett, ingen `.`/`..`. */
export function assertGithubRepoSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value)) throw new UnsafeVendorUrlError("repo_invalid");
  const repo = value.split("/")[1] as string;
  if (repo === "." || repo === ".." || repo.startsWith("-")) throw new UnsafeVendorUrlError("repo_unsafe");
  return value;
}

/** Validerer den RÅ strengen. Kaster `UnsafeVendorUrlError`; returnerer URL-en uendret hvis den er trygg. */
export function assertSafeVendorUrl(raw: string): string {
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.includes("\\")) throw new UnsafeVendorUrlError("url_malformed");
  const m = /^https?:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m) throw new UnsafeVendorUrlError("url_not_plain_http_url");
  const path = m[2] ?? "";
  if (path.split("/").some((segment) => segment !== "" && isDotSegment(segment))) throw new UnsafeVendorUrlError("dot_segment");
  // Parseren må ende på NØYAKTIG samme vert og sti som den rå strengen (ingen stille normalisering).
  const parsed = new URL(raw);
  if (parsed.host.toLowerCase() !== m[1]!.toLowerCase() || parsed.pathname !== (path === "" ? "/" : path)) {
    throw new UnsafeVendorUrlError("normalization_changed_url");
  }
  return raw;
}

/** `fetch` med sentral URL-sikring. Kalles alltid med en streng-URL bygget av vendor-base + (kodede) segmenter. */
export async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input.toString();
  assertSafeVendorUrl(raw);
  return fetch(raw, init);
}
