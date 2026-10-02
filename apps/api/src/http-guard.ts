import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Remediering del 2 (JARVIS-001/063/064): felles HTTP-vern for API-et.
 *
 *  - body-størrelsesgrense FØR parsing (413), og malformed JSON er en klientfeil (400), aldri 500;
 *  - generiske feilsvar med request-ID (intern feiltekst/pg-feil/ID-er lekkes aldri til klienten);
 *  - per-nøkkel rate limit (per IP før autentisering, per device etter at grantet er løst).
 */

/** JSON-kropper på kontrollflatene er små (grant + noen felt). 64 KiB er rikelig. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Webhook-kropper (Stripe/Vipps/...) kan være større, men grensen gjelder FØR signaturverifisering. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(`${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
  }
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

async function readLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Slipp å lese noe som helst - og stopp videre opplasting.
    req.resume();
    throw new HttpError(413, "payload_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parser en JSON-kropp med størrelsesgrense. Tom kropp = `{}`. Ugyldig JSON = 400 `malformed_json`. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const raw = await readLimited(req, maxBytes);
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed_json");
  }
}

/** Rå, byte-for-byte kropp for webhook-signaturer - men med størrelsesgrense FØR signaturkontrollen. */
export async function readRawBodyLimited(req: IncomingMessage, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  return readLimited(req, maxBytes);
}

/** Vinduet-basert teller. Enkel og deterministisk (klokke injiserbar for test). */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Øvre grense for antall nøkler - minnet er aldri ubegrenset (JARVIS-063). */
    private readonly maxKeys = 10_000
  ) {}

  /** `true` = innenfor grensen, `false` = avvis (429). */
  take(key: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(t);
        if (this.buckets.size >= this.maxKeys) {
          // Fail-closed under et nøkkelflom-angrep: nye nøkler avvises til vinduet utløper.
          return false;
        }
      }
      bucket = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket ? Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)) : 1;
  }

  private sweep(t: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) {
        this.buckets.delete(key);
      }
    }
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Klient-IP for rate limiting. `X-Forwarded-For` stoles KUN på når selve TCP-peeren er loopback (Tailscale Serve/lokal reverse
 * proxy) - ellers kunne enhver klient velge sin egen rate-limit-nøkkel. Arkitekt-review (P3): vi bruker SISTE element (det vår egen,
 * betrodde proxy la til) - aldri det første, som en klient selv kan ha satt når proxyen appender i stedet for å overskrive.
 */
export function clientKey(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress;
  if (isLoopback(peer)) {
    const fwd = req.headers["x-forwarded-for"];
    const parts = (Array.isArray(fwd) ? fwd.join(",") : fwd)?.split(",").map((p) => p.trim()).filter((p) => p.length > 0) ?? [];
    const last = parts[parts.length - 1];
    if (last) {
      return last;
    }
  }
  return peer ?? "unknown";
}

/**
 * Felter som aldri kan komme fra en klient-kropp på en grant-beskyttet rute:
 * identitet, tenant, person, enhet, sesjon, kanal og autentiseringsstyrke
 * utledes KUN server-side fra det verifiserte grantet.
 */
export const FORBIDDEN_IDENTITY_BODY_KEYS: ReadonlyArray<string> = [
  "identity", "person_id", "tenant_id", "memory_space", "memory_space_id", "session_id",
  "device_id", "channel", "auth_strength", "delegation_id", "owner_person_id", "actor_person_id"
];
