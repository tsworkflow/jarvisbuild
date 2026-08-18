import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { DeviceService, IdentityService, SessionService } from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import type { InProcessWorker } from "@jarvis/tasks";
import { parseZendeskWebhookEvent, verifyZendeskWebhookSignature } from "@jarvis/tool-gateway";
import type { ConversationEngine } from "./conversation.ts";
import type { AuthStrength, Channel, MemorySpace } from "@jarvis/contracts";

/**
 * Fase 3: minimalt API uten rammeverk (rammeverksvalg utsatt til behovet
 * krever det). Ruter: /health, / (webchat), /chat (SSE/JSON),
 * /tools/critical-demo (klasse D-stub for policybevis i kjørende app).
 *
 * Merk: API-et binder localhost i dev og har ingen egen HTTP-autentisering
 * ennå - enhetsautentisering kommer med kanalene i senere faser (dokumentert).
 */
export interface ApiDeps {
  identity: IdentityService;
  sessions: SessionService;
  conversation: ConversationEngine;
  policy: PolicyGateway;
  worker: InProcessWorker;
  /** Fase 8: enhetsregistrering/challenge-auth for mobil/Watch. */
  devices?: DeviceService;
  /** v4.0 BO-02: Daily Executive Brief on demand. */
  brief?: { generate(identity: unknown): Promise<unknown>; render(artifact: unknown): string };
  /**
   * UA-3 Support/Tickets (Zendesk, D-64): FØRSTE innkommende webhook-mottaker
   * i kodebasen. `secret` er `JARVIS_ZENDESK_WEBHOOK_SIGNING_SECRET` (kan
   * være `undefined` = ikke konfigurert, fail-closed under). `onTicketEvent`
   * er en løst typet callback (samme mønster som `brief` over - server.ts
   * skal ALDRI importere `@jarvis/business` direkte) som gjør den FAKTISKE
   * re-synkroniseringen (§23: alltid via ToolGateway, aldri webhook-kroppen).
   */
  zendeskWebhook?: { secret: string | undefined; onTicketEvent(ticketId: string): Promise<void> };
}

export interface HealthStatus {
  status: "ok";
  service: "jarvis-api";
  version: string;
  time: string;
}

export function healthStatus(): HealthStatus {
  return { status: "ok", service: "jarvis-api", version: "0.1.0", time: new Date().toISOString() };
}

interface ChatBody {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: MemorySpace;
  channel: Channel;
  auth_strength?: AuthStrength;
  message: string;
  /** BO-12 §33: valgfri owner-override av LLM-provider (router §38-semantikk). */
  provider?: string;
}

const WEB_INDEX = fileURLToPath(new URL("../../web/index.html", import.meta.url));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/**
 * §23/§26 i Zendesk-byggeordren: RÅ bytes (HMAC-signaturen beregnes over de
 * eksakte bytene - `readBody()` sin JSON.parse->reserialisering ville gitt
 * en annen signatur). 256 KB-tak (et Zendesk-ticket-varsel er alltid lite -
 * ingen kommentarinnhold sendes i webhook-kroppen, se
 * `parseZendeskWebhookEvent()`) - beskytter mot en ukontrollert/ondsinnet
 * avsender som strømmer et enormt body.
 */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_WEBHOOK_BODY_BYTES) throw new Error("webhook_payload_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApiServer(deps?: ApiDeps): Server {
  return createServer((req, res) => {
    void route(req, res, deps).catch((err: Error) => {
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error", message: err.message });
      } else {
        res.end();
      }
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps?: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, healthStatus());
  }

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(WEB_INDEX, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const depRoutes = ["/chat", "/worker/tick", "/tools/critical-demo", "/webhooks/zendesk"];
  if (!deps) {
    if (depRoutes.includes(url.pathname)) {
      return json(res, 503, { error: "not_configured", message: "API kjører uten database-avhengigheter" });
    }
    return json(res, 404, { error: "not_found" });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    const body = (await readBody(req)) as ChatBody;
    const session = await deps.sessions.resumeOrCreate(
      { tenant_id: body.tenant_id, person_id: body.person_id, device_id: body.device_id },
      body.channel
    );
    const resolved = await deps.identity.resolveIdentity({
      person_id: body.person_id,
      tenant_id: body.tenant_id,
      memory_space: body.memory_space,
      session_id: session.session_id,
      device_id: body.device_id,
      channel: body.channel,
      auth_strength: body.auth_strength ?? "active"
    });
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
    if (wantsStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      // D-30 HOST BLOCKER §1/§2 (spørsmål D): valgfri diagnostikk - kun event-navn/
      // timing, ALDRI dataInnhold (aldri token-tekst/secrets), kun når eksplisitt på.
      const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
      const tSseStart = Date.now();
      const send = (event: string, data: unknown) => {
        // Frakoblet socket får aldri flere events - og aldri duplisert 'done'.
        if (!res.writableEnded && !res.destroyed) {
          if (streamDebug) {
            console.error(JSON.stringify({ msg: "stream_debug_sse_write", event, at_ms: Date.now() - tSseStart }));
          }
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };
      // BO-11.1 §6/§8 (barge-in-fundament for D-30): klient-disconnect propagerer
      // hele veien - HTTP close → AbortSignal → ModelGateway → provider-upstream.
      // Ikke bare slutte å skrive til socketen mens provideren fortsetter.
      const abort = new AbortController();
      // 'close' på RESPONSEN fyrer når forbindelsen termineres for tidlig
      // (req-'close' fyrer ved fullført request-body i moderne Node - feil signal).
      res.on("close", () => {
        if (!res.writableEnded) {
          abort.abort();
        }
      });
      const result = await deps.conversation.handle(
        resolved.identity,
        body.message,
        (token) => send("token", { token }),
        abort.signal,
        body.provider,
        // D-30: trusted verktøy-aktivitet - kun tool_name, aldri args/resultat-JSON.
        // Voice-klientens HttpCoreClient forstår allerede `tool_call`-eventet.
        (toolName) => send("tool_call", { tool_name: toolName })
      );
      send("done", { ...result, session_id: session.session_id });
      res.end();
      return;
    }

    const result = await deps.conversation.handle(resolved.identity, body.message, undefined, undefined, body.provider);
    return json(res, 200, { ...result, session_id: session.session_id });
  }

  if (deps.brief && req.method === "POST" && url.pathname === "/brief") {
    const body = (await readBody(req)) as ChatBody;
    const session = await deps.sessions.resumeOrCreate(
      { tenant_id: body.tenant_id, person_id: body.person_id, device_id: body.device_id }, body.channel ?? "api"
    );
    const resolved = await deps.identity.resolveIdentity({
      person_id: body.person_id, tenant_id: body.tenant_id, memory_space: body.memory_space,
      session_id: session.session_id, device_id: body.device_id,
      channel: body.channel ?? "api", auth_strength: body.auth_strength ?? "active"
    });
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const artifact = await deps.brief.generate(resolved.identity);
    return json(res, 200, { brief: artifact, rendered: deps.brief.render(artifact), session_id: session.session_id });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/register") {
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0];
      device: { device_id: string; kind: string; public_key_pem: string };
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    await deps.devices.registerDevice(resolved.identity, body.device);
    return json(res, 200, { registered: body.device.device_id });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge") {
    const body = (await readBody(req)) as { device_id: string };
    return json(res, 200, { challenge: deps.devices.issueChallenge(body.device_id) });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge/verify") {
    const body = (await readBody(req)) as {
      tenant_id: string; device_id: string; challenge: string; signature: string;
    };
    const ok = await deps.devices.verifyChallenge(body.tenant_id, body.device_id, body.challenge, body.signature);
    return json(res, ok ? 200 : 403, { verified: ok, auth_strength: ok ? "signed" : "passive" });
  }

  if (req.method === "POST" && url.pathname === "/worker/tick") {
    // Dev-hjelper: kjør køen én runde (produksjonsworker kjører på intervall i main).
    const ran = await deps.worker.drain();
    return json(res, 200, { ran });
  }

  /**
   * UA-3 Support/Tickets (Zendesk, D-64) §22/§23/§24/§26 i byggeordren: FØRSTE
   * innkommende webhook-mottaker i kodebasen. Rekkefølge (aldri byttet om):
   * (1) RÅ bytes (§23 - HMAC over eksakte bytes), (2) signatur+tidsstempel-
   * verifisering FØR noe annet skjer, (3) en SMAL, eksplisitt-parset
   * hendelse (KUN ticket-ID - se `parseZendeskWebhookEvent()`), (4) 200
   * returneres UMIDDELBART etter validering (§25: webhook er fast path, ikke
   * eneste sannhetskilde - periodisk synk er sikkerhetsnettet, derfor
   * trenger Jarvis IKKE Zendesk sin egen retry-mekanisme), (5) selve
   * normaliseringen skjer asynkront I BAKGRUNNEN via `onTicketEvent()`, som
   * ALLTID henter ticketen på nytt gjennom ToolGateway - aldri direkte fra
   * denne kroppen.
   */
  if (req.method === "POST" && url.pathname === "/webhooks/zendesk") {
    if (!deps.zendeskWebhook) {
      return json(res, 503, { error: "zendesk_webhook_not_configured" });
    }
    let rawBody: string;
    try {
      rawBody = await readRawBody(req);
    } catch {
      return json(res, 413, { error: "webhook_payload_too_large" });
    }
    const verification = verifyZendeskWebhookSignature({
      secret: deps.zendeskWebhook.secret,
      signatureHeader: req.headers["x-zendesk-webhook-signature"] as string | undefined,
      timestampHeader: req.headers["x-zendesk-webhook-signature-timestamp"] as string | undefined,
      rawBody
    });
    if (!verification.valid) {
      return json(res, 401, { error: verification.reason });
    }
    const event = parseZendeskWebhookEvent(rawBody);
    if (!event) {
      return json(res, 400, { error: "webhook_unparsable_event" });
    }
    // §25: svar UMIDDELBART - selve resynken kjører i bakgrunnen, en feil der
    // krasjer ALDRI HTTP-responsen (periodisk synk fanger opp neste runde).
    void deps.zendeskWebhook.onTicketEvent(event.ticketId).catch(() => undefined);
    return json(res, 200, { received: true, event_type: event.eventType });
  }

  if (req.method === "POST" && url.pathname === "/tools/critical-demo") {
    // Klasse D-stub (fase 3-avgrensning): beviser at kritiske verktøy
    // blokkeres uten gyldig signert godkjenning i den KJØRENDE appen.
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
      parameters: Record<string, never>;
      approval?: unknown;
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const decision = await deps.policy.authorize({
      identity: resolved.identity,
      toolCall: {
        tool_id: "demo",
        action: "critical_demo",
        capability_class: "D",
        parameters: body.parameters ?? {}
      },
      ...(body.approval !== undefined ? { approval: body.approval } : {})
    });
    if (decision.decision !== "ALLOW") {
      return json(res, 403, { decision: decision.decision, reason: decision.reason });
    }
    return json(res, 200, { decision: "ALLOW", executed: "critical_demo_stub" });
  }

  json(res, 404, { error: "not_found" });
}
