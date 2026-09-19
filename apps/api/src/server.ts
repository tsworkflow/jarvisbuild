import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type {
  ChannelSessionAuthority, DeviceEnrollmentService, DeviceService, IdentityService,
  SessionGrantService, SessionService, VoiceSessionAuthority
} from "@jarvis/core";
import {
  acquireContainerLogs, attemptRecovery, correlateDbState, correlateIncident, dockerProviderStatus, executeInfraMutation,
  getInfraExecution, ingestGithubDeployment, proposeRepairTask, type DeploymentService, type DiagnosisService, type IncidentService
} from "@jarvis/incidents";
import type { InfraExecutionGate, OwnerControls, PolicyGateway } from "@jarvis/policy";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import type { DockerMutationAction, ToolGateway } from "@jarvis/tool-gateway";
import {
  InvalidWebhookSignatureError, StripeCredentialsUnavailableError, StripeTenantNotConfiguredError,
  VippsCredentialsUnavailableError, VippsTenantNotConfiguredError,
  NeonomicsCredentialsUnavailableError, NeonomicsTenantNotConfiguredError,
  WallesterCredentialsUnavailableError, WallesterTenantNotConfiguredError,
  type CardService, type FinanceService
} from "@jarvis/finance";
import type { ConversationEngine } from "./conversation.ts";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";

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
  /**
   * D-123 (UA-7 slice 4, Q-32 punkt 2): betrodd server-side sesjons-/
   * memory-space-autoritet for Voice Gateway. Valgfri av samme grunn som
   * `devices`/`tasks`: uten database-avhengigheter kjører API-et i helse-modus.
   * Ingen NY autorisasjonsmekanisme - se `VoiceSessionAuthority`.
   */
  voiceAuthority?: VoiceSessionAuthority;
  /**
   * D-130 arkitekt-review MERGE BLOCKER 1-fiks: den generaliserte, kanal-
   * uavhengige søsteren til `voiceAuthority` over - PÅKREVD (ikke valgfri, i
   * motsetning til `voiceAuthority`) fordi `/chat`/`/brief` fra nå av ALDRI
   * stoler på klient-oppgitt `person_id`/`device_id`/`auth_strength` direkte
   * (se `/session/authorize`-ruten og de nye `/chat`/`/brief`-grenene under).
   * Konstrueres i `main.ts` fra de SAMME delte `devices`/`sessions`/`identity`-
   * instansene som `voiceAuthority` allerede bruker (samme delingsdisiplin som
   * D-123 krevde - `DeviceService` holder utstedte challenges in-memory).
   */
  channelAuthority: ChannelSessionAuthority;
  /**
   * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): den server-side
   * eieren av `session_grants`. PÅKREVD, ikke valgfri: `/chat`/`/brief` har
   * ingen annen autoritetskilde igjen - de godtar KUN et `grant_token`, og
   * ALDRI en rå sesjons-ID.
   */
  grants: SessionGrantService;
  /**
   * D-131 funn 2: den betrodde innrullerings-autoriteten bak
   * `/devices/register`. Valgfri på samme måte som `devices`: uten
   * database-avhengigheter kjører API-et i helse-modus, og da er ruten 404
   * i stedet for en åpen innrulleringsflate.
   */
  enrollment?: DeviceEnrollmentService;
  /** v4.0 BO-02: Daily Executive Brief on demand. */
  brief?: { generate(identity: unknown): Promise<unknown>; render(artifact: unknown): string };
  /**
   * D-199 (UA-11 Executive dashboard-UI, LESE-DELEN): SAMME allerede-
   * konstruerte `toolGateway`-instans som resten av appen (`incidents.gateway`
   * over, `situations`-sveipet, osv.) - INGEN ny autorisasjonsmekanisme,
   * INGEN ny ToolGateway-instans. Valgfritt, samme mønster som `brief`/
   * `tasks`/`incidents`: uten database-avhengigheter kjører API-et i
   * helse-modus. Route-en under (`/executive/query`) begrenser SEG SELV til
   * et hardkodet, LESE-KUN allowlist av `executive.*`-handlinger (se
   * `EXECUTIVE_QUERY_ACTIONS`) - mutasjoner (pause/revoke/kill switch osv.)
   * er BEVISST IKKE eksponert her ennå, egen fremtidig slice (samme
   * "P0 lese/komposisjon FØR P1 mutasjon/autonomi"-rekkefølge som UA-9/
   * UA-10/UA-11 selv allerede fulgte).
   */
  executive?: { gateway: ToolGateway };
  /**
   * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
   * SAMME `TaskService`-instans som allerede konstrueres for `ConversationEngine`
   * (main.ts) - eksponerer den EKSISTERENDE, allerede validerte/policy-håndhevede
   * `submit()`-metoden (full `JobContract`, klasse B) over HTTP i stedet for å
   * bygge en ny innsendingsmekanisme. Valgfritt: uten database-avhengigheter
   * kjører API-et i helse-modus (samme mønster som `worker`/`brief`).
   */
  tasks?: TaskService;
  /**
   * D-104 (UA-5 Production Operations Control Plane v1): valgfritt - uten
   * database-avhengigheter kjører API-et i helse-modus (samme mønster som
   * `tasks`/`worker`/`brief`). `gate`/`infraToolIds` er DEN SAMME
   * `InfraExecutionGate`-instansen `PolicyGateway` allerede håndhever -
   * disse rutene MUTERER kun dens tilstand, de omgår ALDRI `policy.
   * authorize()` (hver rute kaller `policy.authorize()` FØRST, identisk
   * mønster som `/tools/critical-demo`).
   */
  incidents?: {
    service: IncidentService;
    deployments: DeploymentService;
    /** D-105: valgfritt - diagnose-rutene forblir 404 uten den (samme mønster som `tasks`). */
    diagnosis?: DiagnosisService;
    gateway: ToolGateway;
    controls?: OwnerControls;
    infraGate: InfraExecutionGate;
    pool: pg.Pool;
  };
  /**
   * D-109 (UA-6 Slice 3): eksponerer `FinanceService` for `/webhooks/stripe`.
   * Valgfritt - uten database-avhengigheter kjører API-et i helse-modus
   * (samme mønster som `tasks`/`incidents`/`brief`). Denne ruten leser
   * RÅ body direkte (IKKE via `readBody()`, som JSON-parser og dermed
   * ødelegger byte-for-byte-signaturen Stripe krever) - se egen gren under.
   */
  finance?: { service: FinanceService; cards?: CardService };
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

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): kroppen inneholder nå
 * IKKE ETT ENESTE identitetsbærende felt.
 *
 * D-130-runden fjernet `person_id`/`device_id`/`auth_strength`, men beholdt
 * `session_id` som bevis - og slo opp `person_id`/`device_id` fra sesjonsraden
 * via `sessions.getActive()`. Reviewen påviste at det gjorde
 * SAMTALEKONTINUITET om til DEVICE-AUTHENTICATION: en sesjon deles bevisst
 * mellom personens kanaler og `last_device_id` overskrives ved hvert
 * kanalbytte, så en eldre klient ble re-attribuert til den sist aktive
 * enhetens identitet, en tilbakekalt nøkkel fortsatte å virke, og en
 * `TelegramOwnerAuthority`-sesjon (`active`) ble oppgradert til `signed`.
 *
 * Nå presenteres KUN et `grant_token`: et serverutstedt, avgrenset og
 * revokerbart bevis (`session_grants`, migrasjon 053) bundet til NØYAKTIG én
 * bevist enhet, ett autorisert scope, én kanal og et utløp.
 * `tenant_id`/`memory_space`/`channel` er FJERNET fordi de nå leses ut av
 * grantet - en klient kan ikke lenger be om et annet scope enn det den faktisk
 * er autorisert for. Vil den ha en annen memory space, må den autorisere på
 * nytt (én signatur). `session_id` returneres i SVARET som ren
 * samtalekontinuitet, men godtas aldri mer som input.
 */
interface ChatBody {
  grant_token: string;
  message: string;
  /** BO-12 §33: valgfri owner-override av LLM-provider (router §38-semantikk). */
  provider?: string;
}

/** Kroppen for `/brief` - samme grant-baserte autoritet som `/chat`, uten `message`. */
interface BriefBody {
  grant_token: string;
}

/** Nøkkel-hvitelistene for de to kroppene - alt annet er fail-closed avvist. */
const CHAT_BODY_KEYS = ["grant_token", "message", "provider"] as const;
const BRIEF_BODY_KEYS = ["grant_token"] as const;

/**
 * D-199: `/executive/query` sin egen, EKSPLISITTE hvitelilste - kun de to
 * LESE-handlingene (klasse A) `executive.*` selv definerer i dag. Enhver
 * fremtidig mutasjonshandling (pause_domain/activate_kill_switch/
 * revoke_device/osv.) MÅ IKKE kunne nås via denne ruten uten en bevisst,
 * separat kodeendring her - en hardkodet allowlist, ALDRI "alt executive.*
 * tilbyr", er nettopp poenget: ruten skal forbli lese-kun helt til en egen,
 * separat gjennomgått slice bevisst utvider den.
 */
const EXECUTIVE_QUERY_ACTIONS = ["get_attention_queue", "get_control_surface_status"] as const;
const EXECUTIVE_QUERY_BODY_KEYS = ["grant_token", "action", "parameters"] as const;

/**
 * Fail-closed parsing, speilbildet av `.strict()`: et forsøk på å sende f.eks.
 * `session_id`, `tenant_id`, `person_id`, `memory_space`, `channel` eller
 * `auth_strength` gir `malformed_request` i stedet for å bli stille ignorert.
 * Stille ignorering er farlig her: en klient (eller en fremtidig
 * refaktorering) kunne ellers TRO at feltet virket.
 */
function parseGrantBody<K extends readonly string[]>(raw: unknown, allowedKeys: K): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !(allowedKeys as readonly string[]).includes(key))) {
    return null;
  }
  if (typeof obj["grant_token"] !== "string" || obj["grant_token"].length === 0) {
    return null;
  }
  return obj;
}

/**
 * D-131 funn 1: DEN ENE veien fra et framlagt bærer-bevis til en
 * kontraktvalidert `IdentityContext`.
 *
 * To uavhengige porter, i denne rekkefølgen:
 *
 *   1. `grants.verify()` - er beviset selv fortsatt gyldig? (finnes / ikke
 *      utløpt / ikke tilbakekalt / enhetsnøkkelen er fortsatt NØYAKTIG den som
 *      ble bevist da grantet ble utstedt). Det er her tilbakekalling og
 *      nøkkelrotasjon slår inn STRUKTURELT, ved hvert eneste kall.
 *   2. `identity.resolveIdentity()` - er kombinasjonen person↔tenant↔enhet↔
 *      space fortsatt tillatt NÅ? Et grant fryser ikke medlemskap: mister
 *      personen tilgangen, eller slettes enheten/space-en, nektes kallet
 *      umiddelbart selv om grantet ennå ikke er utløpt.
 *
 * Hvert felt kommer fra grant-raden - `auth_strength` inkludert. En transport
 * kan derfor ikke lenger «oppgradere» seg selv: en `active`-autoritet (f.eks.
 * Telegram sin bot-token-baserte sesjon) forblir `active` hele veien, mens
 * kun et enhetssignert grant er `signed`.
 */
async function resolveFromGrant(
  deps: ApiDeps,
  grantToken: string
): Promise<{ ok: true; identity: IdentityContext } | { ok: false; reason: string }> {
  const verified = await deps.grants.verify(grantToken);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  const grant = verified.grant;
  const resolved = await deps.identity.resolveIdentity({
    person_id: grant.person_id,
    tenant_id: grant.tenant_id,
    memory_space: grant.memory_space,
    session_id: grant.session_id,
    device_id: grant.device_id,
    channel: grant.channel,
    auth_strength: grant.auth_strength
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  return { ok: true, identity: resolved.identity };
}

const WEB_INDEX = fileURLToPath(new URL("../../web/index.html", import.meta.url));
/** D-199: samme statiske servering som WEB_INDEX over, egen side for dashboard.html. */
const WEB_DASHBOARD = fileURLToPath(new URL("../../web/dashboard.html", import.meta.url));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/**
 * D-109: rå byte-for-byte body - `readBody()` over ville JSON.parse()-et og
 * dermed gjort HMAC-signaturverifisering (som må hashe EKSAKT det Stripe
 * sendte) umulig å reprodusere korrekt.
 */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
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

  if (req.method === "GET" && url.pathname === "/dashboard") {
    const html = await readFile(WEB_DASHBOARD, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const depRoutes = [
    "/chat", "/worker/tick", "/tools/critical-demo", "/tasks/submit", "/voice/session/authorize", "/session/authorize",
    "/incidents/create", "/incidents/get", "/incidents/list", "/incidents/evidence/add", "/incidents/correlate", "/incidents/repair",
    "/infra/recovery/attempt", "/infra/pause", "/infra/resume", "/infra/degrade", "/infra/status"
  ];
  if (!deps) {
    if (depRoutes.includes(url.pathname)) {
      return json(res, 503, { error: "not_configured", message: "API kjører uten database-avhengigheter" });
    }
    return json(res, 404, { error: "not_found" });
  }

  if (req.method === "POST" && url.pathname === "/session/authorize") {
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: generisk, kanal-uavhengig
    // søster til `/voice/session/authorize` - eneste vei til et gyldig
    // `session_id` for `/chat`/`/brief` fra nå av. INGEN egen logikk her,
    // nøyaktig samme disiplin som `/voice/session/authorize`: les kroppen,
    // gi den til `ChannelSessionAuthority.authorize()` (som selv krever ekte
    // enhetsbevis FØR noen sesjonsrad røres), returner vedtaket. Ugyldig JSON
    // fanges og sendes inn som `undefined` -> deterministisk fail-closed
    // `403 malformed_evidence` (aldri en `500` en klient kan skille fra et
    // ekte avslag). `channel` skilles ut FØR resten sendes som bevismateriale
    // - `ChannelSessionAuthority.authorize()` avviser ukjente nøkler i
    // bevismaterialet (inkl. et forsøk på å smugle inn `channel` der).
    //
    // D-131 funn 3: `channel` sendes videre som `unknown` og valideres mot
    // kontraktens ENUM inne i autoriteten. Ruten sjekket tidligere kun
    // `typeof === "string"`, så en vilkårlig streng ble skrevet rett inn i
    // `sessions.last_channel` og i audit-radene - en usann kildemerking
    // (CLAUDE.md regel 4). Valideringen hører hjemme i autoriteten slik at det
    // finnes ÉN valideringssannhet uansett hvilken transport som kaller.
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      raw = undefined;
    }
    const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const { channel, ...evidence } = obj;
    const result = await deps.channelAuthority.authorize(channel, evidence);
    if (!result.ok) {
      return json(res, 403, result);
    }
    // D-131 funn 1: `grant` er det klienten skal bruke videre. `session_id`
    // beholdes i svaret som SAMTALEKONTINUITET (og for bakoverkompatibel
    // korrelasjon/logging), men gir i seg selv ingen tilgang lenger.
    return json(res, 200, {
      ok: true,
      grant: result.grant,
      session_id: result.session.session_id,
      identity: result.identity
    });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    const parsedBody = parseGrantBody(await readBody(req), CHAT_BODY_KEYS);
    if (!parsedBody || typeof parsedBody["message"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed" });
    }
    const body: ChatBody = {
      grant_token: parsedBody["grant_token"] as string,
      message: parsedBody["message"],
      ...(typeof parsedBody["provider"] === "string" ? { provider: parsedBody["provider"] } : {})
    };
    const resolved = await resolveFromGrant(deps, body.grant_token);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const sessionId = resolved.identity.session_id;

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
      send("done", { ...result, session_id: sessionId });
      res.end();
      return;
    }

    const result = await deps.conversation.handle(resolved.identity, body.message, undefined, undefined, body.provider);
    return json(res, 200, { ...result, session_id: sessionId });
  }

  if (deps.brief && req.method === "POST" && url.pathname === "/brief") {
    // D-131 funn 1: identisk autoritetsmodell som `/chat` over - `/brief` var
    // den ANDRE ruten som oppgraderte en rå sesjons-ID til `signed`.
    const parsedBody = parseGrantBody(await readBody(req), BRIEF_BODY_KEYS);
    if (!parsedBody) {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed" });
    }
    const body: BriefBody = { grant_token: parsedBody["grant_token"] as string };
    const resolved = await resolveFromGrant(deps, body.grant_token);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const artifact = await deps.brief.generate(resolved.identity);
    return json(res, 200, {
      brief: artifact,
      rendered: deps.brief.render(artifact),
      session_id: resolved.identity.session_id
    });
  }

  if (deps.executive && req.method === "POST" && url.pathname === "/executive/query") {
    // D-199 (UA-11 Executive dashboard-UI, lese-delen): SAMME grant-baserte
    // autoritetsmodell som `/chat`/`/brief` - INGEN egen autentisering
    // oppfunnet her. `action` valideres FØR grantet løses (billigere avslag
    // for en åpenbart ugyldig forespørsel), men et ugyldig grant avslås
    // UANSETT FØR selve `toolGateway.execute()`-kallet - identisk rekkefølge
    // som `/chat`.
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      raw = undefined;
    }
    const parsedBody = parseGrantBody(raw, EXECUTIVE_QUERY_BODY_KEYS);
    if (!parsedBody || typeof parsedBody["action"] !== "string") {
      return json(res, 400, { error: "malformed_request", reason: "grant_malformed" });
    }
    const action = parsedBody["action"];
    if (!(EXECUTIVE_QUERY_ACTIONS as readonly string[]).includes(action)) {
      return json(res, 400, { error: "malformed_request", reason: "action_not_allowed" });
    }
    const parameters =
      typeof parsedBody["parameters"] === "object" && parsedBody["parameters"] !== null && !Array.isArray(parsedBody["parameters"])
        ? (parsedBody["parameters"] as Record<string, JsonValue>)
        : {};
    const resolved = await resolveFromGrant(deps, parsedBody["grant_token"] as string);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.executive.gateway.execute({
      identity: resolved.identity, tool_id: "executive", action, parameters
    });
    if (!result.ok) {
      return json(res, 403, { error: "tool_denied", reason: result.reason });
    }
    return json(res, 200, { ok: true, data: result.data, session_id: resolved.identity.session_id });
  }

  if (deps.enrollment && req.method === "POST" && url.pathname === "/devices/register") {
    // D-131 funn 2: ruten har med vilje INGEN egen logikk lenger - den leser en
    // kropp og gir den til `DeviceEnrollmentService.enroll()`, som krever
    // eksplisitt eier-/bootstrap-autoritet (proof-of-possession fra en allerede
    // innrullert enhet, ELLER en engangs innrullerings-billett fra en lokal
    // eier-handling). Den gamle veien - `resolveIdentity(body.identity)` -
    // VERIFISERTE EKSISTENS og autentiserte ingenting: en caller med bare
    // gyldige, ikke-hemmelige ID-er kunne skrive sin egen nøkkel inn på en
    // fremmed enhet og deretter «bevise» den.
    //
    // Ugyldig JSON fanges og sendes inn som `undefined` → deterministisk
    // `malformed_request`, aldri en 500 en klient kan skille fra et avslag.
    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch {
      raw = undefined;
    }
    const result = await deps.enrollment.enroll(raw);
    if (!result.ok) {
      // 400 for en syntaktisk ugyldig kropp, 403 for et ekte
      // autorisasjons-/eierskapsavslag.
      const status = result.reason === "malformed_request" || result.reason === "invalid_public_key" ? 400 : 403;
      return json(res, status, { ok: false, reason: result.reason });
    }
    return json(res, 200, {
      ok: true,
      registered: result.device_id,
      rotated: result.rotated,
      revoked_grants: result.revoked_grants
    });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge") {
    const body = (await readBody(req)) as { device_id: string };
    return json(res, 200, { challenge: deps.devices.issueChallenge(body.device_id) });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge/verify") {
    const body = (await readBody(req)) as {
      tenant_id: string; device_id: string; challenge: string; signature: string;
    };
    const fingerprint = await deps.devices.verifyChallenge(body.tenant_id, body.device_id, body.challenge, body.signature);
    const ok = fingerprint !== null;
    return json(res, ok ? 200 : 403, { verified: ok, auth_strength: ok ? "signed" : "passive" });
  }

  if (deps.voiceAuthority && req.method === "POST" && url.pathname === "/voice/session/authorize") {
    // D-123 (Q-32 punkt 2): den BETRODDE server-side space-/sesjonsautoriteten
    // for voice-transporten. Ruten har med vilje INGEN egen logikk - den leser
    // en kropp, gir den til `VoiceSessionAuthority.authorize()` (som kun
    // komponerer `DeviceService`/`SessionService`/`resolveIdentity()`) og
    // returnerer vedtaket. Ingen `resolveIdentity()`-kall her oppe: det ville
    // vært en ANDRE identitetssti ved siden av den autoriteten selv kjører.
    //
    // Kroppen valideres inne i autoriteten (`.strict()`-skjema), ikke her, slik
    // at det finnes ÉN valideringssannhet. Ugyldig JSON fanges likevel her og
    // sendes inn som `undefined`, slik at ALLE former for ugyldig input gir
    // det samme fail-closed `403 malformed_evidence` - aldri en `500` som en
    // klient kan bruke til å skille «parseren knakk» fra «beviset holdt ikke».
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      body = undefined;
    }
    const result = await deps.voiceAuthority.authorize(body);
    return json(res, result.ok ? 200 : 403, result);
  }

  if (deps.tasks && req.method === "POST" && url.pathname === "/tasks/submit") {
    // D-102: minimal, provider-nøytral ingress for en fullstendig `JobContract`
    // (inkl. `agent_profile: "coding"`) - gjenbruker `TaskService.submit()`
    // UENDRET: kontraktvalidering (Zod), tenant-match, untrusted-privat-
    // minne-og-nettverk-invarianten, klasse B policy-autorisasjon og audit
    // skjer ALT i den eksisterende metoden. INGEN ny autorisasjonsmekanisme.
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
      contract: unknown;
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.tasks.submit(resolved.identity, body.contract);
    if (!result.ok) {
      return json(res, 400, { error: "task_rejected", reason: result.reason });
    }
    return json(res, 200, { task_id: result.value.task_id });
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/stripe") {
    // D-109 (UA-6 Slice 3): INGEN identity-oppløsning her - Stripe sender
    // denne ruten direkte, uten en Jarvis-owner-identitet å oppløse. Selve
    // autentiseringen ER HMAC-signaturverifiseringen (`Stripe-Signature`-
    // headeren), håndhevet inni `ingestStripeWebhookEvent()` - SAMME
    // "signatur ER autentisering"-prinsipp som ethvert annet webhook-mottak.
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers["stripe-signature"];
    try {
      const result = await deps.finance.service.ingestStripeWebhookEvent(
        rawBody, typeof signatureHeader === "string" ? signatureHeader : undefined
      );
      // Stripe tolker 2xx som "stopp gjentakelse", ALT annet som "prøv igjen
      // senere" - `failed_retryable` er derfor BEVISST et 502 her (samme
      // navn/semantikk som `stripe_webhook_events.status`), IKKE en stille 200.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 400, { error: "invalid_signature", message: err.message });
      }
      if (err instanceof StripeCredentialsUnavailableError || err instanceof StripeTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", message: err.message });
      }
      throw err;
    }
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/vipps") {
    // D-110 (UA-6 Slice 4): SAMME "signatur ER autentisering"-prinsipp som
    // /webhooks/stripe, men med Vipps sin HELT ANDERLEDES HMAC-kontrakt
    // (Host/X-Ms-Date/X-Ms-Content-Sha256/Authorization-headere, se
    // vipps-webhook.ts) - `method`/`pathAndQuery` deltar i den signerte
    // strengen og MÅ derfor speile den faktiske forespørselen eksakt.
    const rawBody = await readRawBody(req);
    const hostHeader = req.headers["host"];
    const dateHeader = req.headers["x-ms-date"];
    const contentHashHeader = req.headers["x-ms-content-sha256"];
    const authHeader = req.headers["authorization"];
    try {
      const result = await deps.finance.service.ingestVippsWebhookEvent(
        rawBody, req.method, url.pathname + url.search,
        {
          host: typeof hostHeader === "string" ? hostHeader : undefined,
          xMsDate: typeof dateHeader === "string" ? dateHeader : undefined,
          xMsContentSha256: typeof contentHashHeader === "string" ? contentHashHeader : undefined,
          authorization: typeof authHeader === "string" ? authHeader : undefined
        }
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som Stripe-ruten.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_signature", message: err.message });
      }
      if (err instanceof VippsCredentialsUnavailableError || err instanceof VippsTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", message: err.message });
      }
      throw err;
    }
  }

  if (deps.finance && req.method === "POST" && url.pathname === "/webhooks/neonomics") {
    // D-111 (UA-6 Slice 5): Neonomics sin EGEN offisielle webhook-kontrakt
    // (betalingsstatus-oppdateringer): API-NØKKEL-autentisering - nøkkelen
    // Tobias selv velger ved registrering i Merchant-portalen, sendt av
    // Neonomics i `x-api-key`-headeren. IKKE HMAC (Stripe) og IKKE
    // forespørselssignering (Vipps) - se neonomics-webhook.ts.
    const rawBody = await readRawBody(req);
    const apiKeyHeader = req.headers["x-api-key"];
    try {
      const result = await deps.finance.service.ingestNeonomicsWebhookEvent(
        rawBody, typeof apiKeyHeader === "string" ? apiKeyHeader : undefined
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som
      // Stripe-/Vipps-rutene (Neonomics retryer eksponentielt i opptil 7
      // dager på alt annet enn 200).
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId });
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_api_key", message: err.message });
      }
      if (err instanceof NeonomicsCredentialsUnavailableError || err instanceof NeonomicsTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", message: err.message });
      }
      throw err;
    }
  }

  if (deps.finance?.cards && req.method === "POST" && url.pathname === "/webhooks/wallester") {
    // D-112 (UA-6 Slice 6): Wallester sin EGEN offisielle webhook-kontrakt
    // (autorisasjons-/transaksjons-/korthendelser): HTTP BASIC-
    // autentisering med kunde-konfigurert brukernavn/passord i
    // `Authorization`-headeren, verifisert konstant-tid i
    // ingestWallesterWebhookEvent(). IKKE HMAC (Stripe), IKKE
    // forespørselssignering (Vipps), IKKE API-nøkkel (Neonomics) - se
    // wallester-webhook.ts.
    const rawBody = await readRawBody(req);
    const authHeader = req.headers["authorization"];
    // Owner-provided primary-source-audit (PR #62 runde 4): Wallester
    // Business ekko-er X-Request-ID for korrelasjon - fanges opp her og
    // speiles tilbake i responsen (rent transport-nivå, IKKE noe
    // envelope-parsing-anliggende - se wallester-webhook.ts filhode).
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" ? requestIdHeader : undefined;
    const echoHeaders = requestId ? { "x-request-id": requestId } : {};
    try {
      const result = await deps.finance.cards.ingestWallesterWebhookEvent(
        rawBody, typeof authHeader === "string" ? authHeader : undefined
      );
      // SAMME 2xx-stopper-gjentakelse / ikke-2xx-be-om-retry-semantikk som
      // de øvrige webhook-rutene.
      const status = result.status === "failed_retryable" ? 502 : 200;
      return json(res, status, { received: true, status: result.status, event_id: result.eventId }, echoHeaders);
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        return json(res, 401, { error: "invalid_basic_auth", message: err.message }, echoHeaders);
      }
      if (err instanceof WallesterCredentialsUnavailableError || err instanceof WallesterTenantNotConfiguredError) {
        return json(res, 503, { error: "not_configured", message: err.message }, echoHeaders);
      }
      throw err;
    }
  }

  if (req.method === "POST" && url.pathname === "/worker/tick") {
    // Dev-hjelper: kjør køen én runde (produksjonsworker kjører på intervall i main).
    const ran = await deps.worker.drain();
    return json(res, 200, { ran });
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

  if (deps.incidents) {
    const { service, deployments, gateway, controls, infraGate, pool } = deps.incidents;

    if (req.method === "POST" && url.pathname === "/incidents/create") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0];
        memory_space: MemorySpace; title: string; severity?: "low" | "normal" | "high" | "critical"; owner_person_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.createIncident(resolved.identity.tenant_id, body.memory_space, {
        title: body.title, ...(body.severity !== undefined ? { severity: body.severity } : {}),
        ...(body.owner_person_id !== undefined ? { owner_person_id: body.owner_person_id } : {})
      });
      return json(res, 200, { incident });
    }

    if (req.method === "POST" && url.pathname === "/incidents/get") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.getIncident(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      if (!incident) return json(res, 404, { error: "incident_not_found" });
      const evidence = await service.listEvidence(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      return json(res, 200, { incident, evidence });
    }

    if (req.method === "POST" && url.pathname === "/incidents/list") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace;
        status?: "open" | "diagnosing" | "repair_proposed" | "repair_in_progress" | "resolved" | "wont_fix" | "all";
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incidents = await service.listIncidents(resolved.identity.tenant_id, body.memory_space, body.status ?? "open");
      return json(res, 200, { incidents });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/add") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        source_type: string; status?: string; source_ref?: string; summary: string; observed_at: string; contradicts_evidence_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const evidence = await service.addEvidence(resolved.identity.tenant_id, body.memory_space, body.incident_id, {
          source_type: body.source_type as never, ...(body.status !== undefined ? { status: body.status as never } : {}),
          ...(body.source_ref !== undefined ? { source_ref: body.source_ref } : {}), summary: body.summary, observed_at: body.observed_at,
          ...(body.contradicts_evidence_id !== undefined ? { contradicts_evidence_id: body.contradicts_evidence_id } : {})
        });
        return json(res, 200, { evidence });
      } catch (err) {
        return json(res, 400, { error: "evidence_rejected", message: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string; repo: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const correlation = await correlateIncident(service, deployments, resolved.identity.tenant_id, body.memory_space, body.incident_id, body.repo);
        return json(res, 200, { correlation });
      } catch (err) {
        return json(res, 404, { error: "correlation_failed", message: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/deployments/ingest/github") {
      // D-105 (UA-5 kriterium 1 host-fix): den EKSISTERENDE `DeploymentService.
      // recordDeployment()` sin FØRSTE produksjons-callsite - lukker gapet
      // closeout-audit fant ("ingen produksjons-callsite, kun testtreff").
      // Kaller UTELUKKENDE `ingestGithubDeployment()`, som selv går via
      // `ToolGateway`/`github.get_workflow_run` - INGEN egen HTTP/Octokit-
      // klient her, INGEN rå credential i request-body (samme "identity inn,
      // credential hentes internt via SecretProvider"-mønster som ENHVER
      // annen rute i denne filen).
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; repo: string; workflow_run_id: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const outcome = await ingestGithubDeployment({ gateway, deployments }, resolved.identity, {
        repo: body.repo, workflow_run_id: body.workflow_run_id
      });
      if (outcome.status === "provider_unavailable") return json(res, 502, { error: "provider_unavailable", reason: outcome.reason });
      if (outcome.status === "invalid_provider_response") return json(res, 422, { error: "invalid_provider_response", reason: outcome.reason });
      return json(res, 200, { deployment: outcome.deployment, created: outcome.created, provenance: outcome.provenance });
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate/db") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; window_start: string; window_end: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const db_state = await correlateDbState(pool, resolved.identity.tenant_id, body.window_start, body.window_end);
      return json(res, 200, { db_state });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/acquire_logs") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        container: string; since?: string; until?: string; tail?: number;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const outcome = await acquireContainerLogs({ gateway, incidents: service }, resolved.identity, body.memory_space, body.incident_id, {
        container: body.container, ...(body.since !== undefined ? { since: body.since } : {}),
        ...(body.until !== undefined ? { until: body.until } : {}), ...(body.tail !== undefined ? { tail: body.tail } : {})
      });
      if (outcome.status === "unavailable") return json(res, 502, { error: "acquisition_unavailable", reason: outcome.reason });
      return json(res, 200, { evidence: outcome.evidence });
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/create") {
      const diagnosisService = deps.incidents.diagnosis;
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        conclusion: string; status?: string; source: string; supersedes_diagnosis_id?: string;
        supporting_evidence_ids?: string[]; contradicting_evidence_ids?: string[];
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const diagnosis = await diagnosisService.createDiagnosis(resolved.identity.tenant_id, body.memory_space, body.incident_id, {
          conclusion: body.conclusion, source: body.source as never, ...(body.status !== undefined ? { status: body.status as never } : {}),
          ...(body.supersedes_diagnosis_id !== undefined ? { supersedes_diagnosis_id: body.supersedes_diagnosis_id } : {}),
          ...(body.supporting_evidence_ids !== undefined ? { supporting_evidence_ids: body.supporting_evidence_ids } : {}),
          ...(body.contradicting_evidence_ids !== undefined ? { contradicting_evidence_ids: body.contradicting_evidence_ids } : {})
        });
        return json(res, 200, { diagnosis });
      } catch (err) {
        return json(res, 400, { error: "diagnosis_rejected", message: (err as Error).message });
      }
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/list") {
      const diagnosisService = deps.incidents.diagnosis;
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const diagnoses = await diagnosisService.listDiagnoses(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      return json(res, 200, { diagnoses });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/mutate") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0];
        target: string; action?: DockerMutationAction; target_image?: string; idempotency_key: string; incident_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      // D-105 host-fix: `action` er valgfri - default `redeploy_container`
      // (bakoverkompatibelt med D105_INFRA_OPS_V2_HOST_ACCEPTANCE.md sine
      // eksisterende eksempler, som ikke sender `action`). Nye kall bruker
      // `stop_container`/`start_container` for produksjons-autorisert mutasjon.
      const execution = await executeInfraMutation({ pool, gateway }, resolved.identity, {
        tenant_id: resolved.identity.tenant_id, person_id: resolved.identity.person_id,
        device_id: resolved.identity.device_id,
        target: body.target, action: body.action ?? "redeploy_container", idempotency_key: body.idempotency_key,
        ...(body.target_image !== undefined ? { target_image: body.target_image } : {}),
        ...(body.incident_id !== undefined ? { incident_id: body.incident_id } : {})
      });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/get") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0]; execution_id: string };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const execution = await getInfraExecution(pool, resolved.identity.tenant_id, body.execution_id);
      if (!execution) return json(res, 404, { error: "execution_not_found" });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/observability/docker/status") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0] };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const status = await dockerProviderStatus(gateway, resolved.identity);
      return json(res, 200, { status });
    }

    if (deps.tasks && req.method === "POST" && url.pathname === "/incidents/repair") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
        memory_space: MemorySpace; incident_id: string; repo_url: string; goal: string;
        test_command?: string[]; publish_pr?: boolean; model_budget_ore?: number;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.getIncident(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      if (!incident) return json(res, 404, { error: "incident_not_found" });
      const result = await proposeRepairTask(
        { taskService: deps.tasks, pool, incidents: service },
        resolved.identity, body.memory_space, incident,
        {
          repo_url: body.repo_url, goal: body.goal, ...(body.test_command !== undefined ? { test_command: body.test_command } : {}),
          ...(body.publish_pr !== undefined ? { publishPr: body.publish_pr } : {}),
          ...(body.model_budget_ore !== undefined ? { model_budget_ore: body.model_budget_ore } : {})
        }
      );
      if (!result.ok) return json(res, 400, { error: "repair_task_rejected", reason: result.reason });
      return json(res, 200, { task_id: result.task_id });
    }

    if (req.method === "POST" && url.pathname === "/infra/recovery/attempt") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; tool_id: string; action: string;
        idempotency_key: string; parameters: Record<string, never>; incident_id?: string; execution_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const decision = await deps.policy.authorize({
        identity: resolved.identity,
        toolCall: { tool_id: "infra", action: "attempt_recovery", capability_class: "B", parameters: { tool_id: body.tool_id, action: body.action } }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      const recovery = await attemptRecovery({ pool, gateway }, resolved.identity, {
        tenant_id: resolved.identity.tenant_id, tool_id: body.tool_id, action: body.action,
        idempotency_key: body.idempotency_key, parameters: body.parameters,
        ...(body.incident_id !== undefined ? { incident_id: body.incident_id } : {}),
        ...(body.execution_id !== undefined ? { execution_id: body.execution_id } : {})
      });
      return json(res, 200, { recovery });
    }

    if (req.method === "POST" && (url.pathname === "/infra/pause" || url.pathname === "/infra/resume" || url.pathname === "/infra/degrade")) {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0]; reason?: string };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const action = url.pathname.slice("/infra/".length);
      const decision = await deps.policy.authorize({
        identity: resolved.identity,
        toolCall: { tool_id: "infra", action, capability_class: "B", parameters: {} }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      if (action === "pause") infraGate.pause(body.reason ?? "owner_requested");
      else if (action === "degrade") infraGate.degrade(body.reason ?? "owner_requested");
      else infraGate.resume();
      return json(res, 200, { state: infraGate.current() });
    }

    if (req.method === "POST" && url.pathname === "/infra/status") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0] };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      return json(res, 200, {
        infra_mode: infraGate.current(),
        connector_health: Object.fromEntries(gateway.health),
        frozen_connectors: controls ? ["github"].filter((id) => controls.isFrozen(id)) : []
      });
    }
  }

  json(res, 404, { error: "not_found" });
}
