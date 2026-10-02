import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BrowserBusyError, assertNavigableUrl, type BrowserEngine } from "./browser-engine.ts";
import { EgressBlockedError } from "./egress-policy.ts";
import { ServiceTokenVerifier } from "./service-token.ts";

/**
 * D-339: den interne HTTP-kontrakten `BrowserGatewayTransport`
 * (`modules/tool-gateway/src/browser-transport.ts`) snakker mot. `POST /invoke`
 * er den ENESTE handlings-inngangen - `{action, parameters}` inn, `{data}` ut.
 *
 * REMEDIERING DEL 2 (JARVIS-008):
 *   - `/invoke` krever `Authorization: Bearer <kortlevd signert tjeneste-token>` bundet til
 *     handlingen og den eksakte kroppen (se service-token.ts). Uten gyldig token: 401 -
 *     og INGEN nettleserhandling er kjørt.
 *   - kroppen er størrelsesbegrenset (64 KiB), ugyldig JSON er 400, feil er generiske
 *     (kode + request-id; intern feiltekst lekkes aldri),
 *   - hvert kall har en total tidsgrense, og `/health` kjører en ekte side i nettleseren.
 */
interface InvokeRequestBody {
  action?: unknown;
  parameters?: Record<string, unknown>;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const INVOKE_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, "payload_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const STRICT_KEYS = new Set(["action", "parameters"]);

async function handleInvoke(engine: BrowserEngine, body: InvokeRequestBody): Promise<{ data: unknown }> {
  const action = body.action;
  const parameters = body.parameters ?? {};
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new HttpError(400, "malformed_request");
  }
  if (Object.keys(parameters).some((key) => key !== "url")) {
    throw new HttpError(400, "malformed_request");
  }
  if (action !== "navigate" && action !== "extract_text" && action !== "screenshot") {
    throw new HttpError(400, "action_not_implemented");
  }
  const url = assertNavigableUrl(parameters["url"]);
  if (action === "navigate") {
    return { data: await engine.navigate(url) };
  }
  if (action === "extract_text") {
    return { data: { text: await engine.extractText(url) } };
  }
  return { data: { image_base64: await engine.screenshot(url) } };
}

export interface BrowserGatewayOptions {
  engine: BrowserEngine;
  /** Delt hemmelighet (>= 32 tegn) for tjeneste-tokenet. PÅKREVD - gatewayen starter ikke uten. */
  tokenSecret: string;
  /** Injiserbar klokke (tester). */
  now?: () => number;
}

export function createBrowserGateway(options: BrowserGatewayOptions): Server {
  const verifier = new ServiceTokenVerifier(options.tokenSecret, options.now);
  return createServer((req, res) => {
    const requestId = `bg_${randomUUID()}`;
    res.setHeader("x-request-id", requestId);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") {
      options.engine.healthCheck().then(
        (ok) => send(ok ? 200 : 503, { status: ok ? "ok" : "unhealthy", service: "jarvis-browser-gateway" }),
        () => send(503, { status: "unhealthy", service: "jarvis-browser-gateway" })
      );
      return;
    }
    if (req.method === "POST" && req.url === "/invoke") {
      void (async () => {
        try {
          const raw = await readBody(req);
          // Autentisering FØR parsing av innholdet: ingen handling kan nås uten et gyldig, bundet token.
          let parsed: InvokeRequestBody | undefined;
          try {
            parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString("utf8")) as InvokeRequestBody);
          } catch {
            parsed = undefined;
          }
          const header = req.headers["authorization"];
          const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
          const action = typeof parsed?.action === "string" ? parsed.action : "";
          const verdict = verifier.verify(token, { action, bodySha256: createHash("sha256").update(raw).digest("hex") });
          if (!verdict.ok) {
            return send(401, { error: "unauthorized", request_id: requestId });
          }
          if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
            || Object.keys(parsed).some((key) => !STRICT_KEYS.has(key))) {
            return send(400, { error: "malformed_request", request_id: requestId });
          }
          const result = await Promise.race([
            handleInvoke(options.engine, parsed),
            new Promise<never>((_, reject) => setTimeout(() => reject(new HttpError(504, "timeout")), INVOKE_TIMEOUT_MS).unref())
          ]);
          return send(200, result);
        } catch (error) {
          if (error instanceof HttpError) {
            return send(error.status, { error: error.code, request_id: requestId });
          }
          if (error instanceof EgressBlockedError) {
            return send(403, { error: "egress_blocked", request_id: requestId });
          }
          if (error instanceof BrowserBusyError) {
            return send(429, { error: "busy", request_id: requestId });
          }
          console.error(JSON.stringify({ msg: "browser_gateway_error", request_id: requestId, error: (error as Error).message }));
          return send(502, { error: "browser_error", request_id: requestId });
        }
      })();
      return;
    }
    send(404, { error: "browser_gateway_not_found", request_id: requestId });
  });
}
