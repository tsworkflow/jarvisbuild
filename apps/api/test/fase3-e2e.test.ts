import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApproval, type ApprovalPayload, type IdentityContext, type JsonValue, type SignedApproval } from "@jarvis/contracts";
import {
  ChannelSessionAuthority,
  ContextBuilder,
  DeviceService,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  SessionGrantService,
  SessionService,
  createPool,
  runMigrations,
  withTenantTransaction
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FailingAdapter, ScriptedAdapter, textOnly } from "@jarvis/provider-adapters";
import {
  FakeTransport,
  MeshToolExecutor,
  ToolGateway,
  firstWaveTools,
  meshToolDefinitions,
  type SecretProvider
} from "@jarvis/tool-gateway";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { seedOwner } from "../src/seed.ts";
import { createApiServer } from "../src/server.ts";

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
const watchKeys = generateKeyPairSync("ed25519");
// D-130 arkitekt-review MERGE BLOCKER 1-fiks: `/chat`/`/brief` stoler ikke
// lenger på klient-oppgitt `person_id`/`device_id`/`auth_strength` - ETT
// Ed25519-nøkkelpar per test-enhet, registrert med ekte `public_key_pem` i
// seed-SQL under, brukt til å faktisk BEVISE enhetsbesittelse via
// `/devices/challenge` + `/session/authorize` FØR hvert `/chat`-kall (samme
// mønster som `modules/tool-gateway/test/channel-session-continuity-dedupe.test.ts`).
const deviceKeys: Record<string, ReturnType<typeof generateKeyPairSync>> = {
  "dev-web": generateKeyPairSync("ed25519"),
  "dev-web-b": generateKeyPairSync("ed25519"),
  "dev-voice": generateKeyPairSync("ed25519"),
  "dev-web-c": generateKeyPairSync("ed25519")
};
function keyFor(deviceId: string): ReturnType<typeof generateKeyPairSync> {
  const keys = deviceKeys[deviceId];
  if (!keys) throw new Error(`no test keypair seeded for device_id ${deviceId}`);
  return keys;
}
const devicePem = (deviceId: string): string =>
  keyFor(deviceId).publicKey.export({ type: "spki", format: "pem" }).toString();

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let scripted: ScriptedAdapter;
let trace: MemoryTraceSink;
let worker: InProcessWorker;
let gateway: ModelGateway;
// D-30 live-funn-fix: samtalebanens tool-bro testes mot EKTE firstWave-skjemaer.
let calendarTransport: FakeTransport;
const executorIdentities: IdentityContext[] = [];
let toolCallSeq = 0;
// Marker i tool-resultatet: skal ALDRI dukke opp i SSE-events (kun tool_name gjør det).
const TOOL_PAYLOAD_MARKER = "INTERN-TOOL-PAYLOAD-9f3a";

const webIdentity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-web",
  memory_space: "personal",
  channel: "web"
} as const;

function makeApproval(overrides: Partial<Omit<ApprovalPayload, "parameters_hash">> & { parameters?: Record<string, JsonValue> } = {}): SignedApproval {
  return signApproval(watchKeys.privateKey, {
    tool_id: "demo",
    action: "critical_demo",
    tenant_id: webIdentity.tenant_id,
    person_id: webIdentity.person_id,
    approver_person_id: webIdentity.person_id,
    parameters: { confirm: true },
    nonce: `nonce-${randomUUID()}`,
    approving_device_id: "watch-1",
    ...overrides
  });
}

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): ekte enhetsbevis
 * (utstedt challenge signert med enhetens Ed25519-nøkkel) →
 * `/session/authorize` → et SERVERUTSTEDT, AVGRENSET og REVOKERBART
 * `grant_token`. D-130-runden returnerte her et `session_id`; reviewen påviste
 * at en samtale-ID ikke kan være et autorisasjonsbevis (delt på tvers av
 * kanaler, mutabel `last_device_id`, ingen utløp, ingen tilbakekalling).
 *
 * Kaster på avslag (aldri en stille `undefined`) - en test som feiler her
 * betyr autorisasjonen faktisk ble avvist, ikke en tilfeldig 403 lenger nede.
 */
async function authorize(identity: Record<string, string>): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}/devices/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: identity["device_id"] })
  });
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const signature = sign(null, Buffer.from(challenge, "utf8"), keyFor(identity["device_id"] as string).privateKey).toString("base64");
  const res = await fetch(`${baseUrl}/session/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: identity["channel"], person_id: identity["person_id"], tenant_id: identity["tenant_id"],
      device_id: identity["device_id"], memory_space: identity["memory_space"],
      device_proof: { challenge, signature }
    })
  });
  const body = (await res.json()) as { ok: boolean; grant?: { grant_token: string }; reason?: string };
  if (!body.ok || !body.grant) {
    throw new Error(`authorize_failed:${body.reason ?? "unknown"}`);
  }
  return body.grant.grant_token;
}

async function chat(message: string, identity: Record<string, string> = webIdentity) {
  const grant_token = await authorize(identity);
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // D-131 funn 1: KUN beviset. `tenant_id`/`memory_space`/`channel`/
    // `session_id` leses server-side ut av grant-raden, og en kropp med
    // ukjente felter avvises som `malformed_request`.
    body: JSON.stringify({ grant_token, message })
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Samme grant-autorisering som `chat()`, for de rå SSE-`fetch()`-kallene under. */
async function chatSseBody(message: string, identity: Record<string, string> = webIdentity): Promise<string> {
  const grant_token = await authorize(identity);
  return JSON.stringify({ grant_token, message });
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg3-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "test-superuser-pw",
    port,
    persistent: false
  })
,
    // D-141 B: proben maa bruke instansens EGNE credentials.
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw"
  });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES
      ('tenant-personal', 'Tobias personlig', 'person'),
      ('tenant-budget', 'Budsjett-test', 'person'),
      ('tenant-second', 'Tenant-isolasjon-test', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES
      ('person-tobias', 'tenant-personal'), ('person-tobias', 'tenant-budget'),
      ('person-tobias', 'tenant-second');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES
      ('dev-web', 'tenant-personal', 'person-tobias', 'web'),
      ('dev-web-b', 'tenant-budget', 'person-tobias', 'web'),
      ('dev-voice', 'tenant-personal', 'person-tobias', 'voice'),
      ('dev-web-c', 'tenant-second', 'person-tobias', 'web');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('sp-personal', 'tenant-personal', 'personal'),
      ('sp-budget', 'tenant-budget', 'personal'),
      ('sp-second', 'tenant-second', 'personal');
    -- Simulert forbruk over hardgrensen (3 000 kr = 300 000 øre) for tenant-budget:
    INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ('tenant-budget', 'model:test', 310000);
  `);
  // D-130 arkitekt-review MERGE BLOCKER 1-fiks: `public_key_pem` satt via
  // PARAMETRISERT spørring (aldri tekstlig interpolert inn i SQL-en over) -
  // en PEM-streng inneholder ekte linjeskift, som ikke overlever
  // tekst-escaping inn i en enkeltsitert SQL-literal uten `E''`-syntaks.
  for (const deviceId of Object.keys(deviceKeys)) {
    await adminPool.query("UPDATE devices SET public_key_pem = $1 WHERE device_id = $2", [devicePem(deviceId), deviceId]);
  }

  appPool = createPool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw"
  });

  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey, { tenant_id: "tenant-personal", person_id: "person-tobias" });
  const policy = new PolicyGateway({
    devices,
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch()
  });
  scripted = new ScriptedAdapter(
    (req) =>
      // D-30: syntese-runden ETTER verktøyresultat - fast tekst (aldri payload-lekkasje her).
      req.tool_exchanges?.length
        ? "Kalenderen din i dag: standup 09:00."
        : // BO-11.1 §7: "langsom" gir mange tokens (~1 ms hver i stream) slik at
          // klient-frakobling deterministisk treffer midt i genereringen.
          textOnly(req.messages.at(-1)?.content ?? "").includes("langsom")
          ? Array.from({ length: 150 }, (_, i) => `ord${i} `).join("")
          : "Hei Tobias, dette er et modellsvar.",
    // D-30 live-funn-fix: kalender-intent → normalized tool call (runde 1); etter
    // utført verktøy (tool_exchanges) → ferdig syntese. Unik call-id per request.
    (req) => {
      if (req.tool_exchanges?.length) {
        return [];
      }
      if (!textOnly(req.messages.at(-1)?.content ?? "").includes("kalenderen")) {
        return [];
      }
      toolCallSeq += 1;
      return [{
        tool_call_id: `call-cal-${toolCallSeq}`, tool_name: "read_calendar_today",
        arguments: {}, provider: "scripted", model: "scripted-1"
      }];
    }
  );
  trace = new MemoryTraceSink();
  gateway = new ModelGateway({
    pool: appPool,
    trace,
    providers: [new FailingAdapter(), scripted], // beviser også fallback: failing → scripted
    // Remediering del 1 (JARVIS-006): `scripted` er nå en eksplisitt LOCAL/0-provider i
    // DEFAULT_PRICING (tidligere falt den til `default_rate` = fantomkostnad). Akseptanse 2
    // beviser at en kostnad BLIR bokført og knyttet til session/task - til det trengs en
    // eksplisitt, ikke-null test-sats (legacy `rates`-opsjonen vinner over pricing-tabellen).
    rates: { scripted: { input_per_1k_ore: 30, output_per_1k_ore: 150 } }
  });
  const queue = new PgTaskQueue(appPool);
  worker = new InProcessWorker(queue);
  worker.register("executive", async (task) => ({ echo: task.contract.goal }));
  // D-30 live-funn-fix: EKTE firstWave-verktøydefinisjoner (ekte input-skjemaer,
  // {from,to}/{max}/{repo}) med fake transporter - beviser at mesh-broens trusted
  // parameterbygging validerer mot produksjonsskjemaene (live-funnet var nettopp
  // at samtalebanen aldri nådde hit).
  calendarTransport = new FakeTransport(() => ({
    data: { events: [{ id: "ev-1", title: `standup ${TOOL_PAYLOAD_MARKER}`, start: "09:00" }] }
  }));
  const testSecrets: SecretProvider = { name: "test", get: async () => "test-credential-never-leaks" };
  const toolGateway = new ToolGateway(appPool, policy, testSecrets);
  for (const tool of firstWaveTools({
    calendar: calendarTransport, email: new FakeTransport(), github: new FakeTransport(), telegram: new FakeTransport()
  })) toolGateway.register(tool);
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  server = createApiServer({
    // Remediering del 1: dev-rutene (/worker/tick, /tools/critical-demo) er av i produksjon;
    // denne testen trenger dem eksplisitt.
    enableDevRoutes: true,
    identity: identityService,
    sessions: sessionService,
    // D-130/D-131: `/chat` krever nå et ekte, enhetsbevist GRANT (ikke lenger
    // en sesjons-ID) - `devices`/`channelAuthority`/`grants` må derfor faktisk
    // være wired her (ikke bare strukturelt til stede), siden
    // `authorize()`-hjelperen over faktisk kaller `/devices/challenge` og
    // `/session/authorize`.
    devices: deviceService,
    grants: grantService,
    channelAuthority: new ChannelSessionAuthority({
      pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService
    }),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool),
      context: new ContextBuilder(appPool),
      gateway,
      tasks: new TaskService(appPool, queue, policy),
      worker,
      trace,
      // §3 (live-funn-fix): executor bindes til samtalens RESOLVED identity per
      // kall - fabrikken registrerer hver binding så feil (global owner) avsløres.
      tools: {
        definitions: meshToolDefinitions(),
        executorFor: (identity) => {
          executorIdentities.push(identity);
          return new MeshToolExecutor(toolGateway, identity);
        }
      }
    })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Akseptanse 1: samtale oppretter og følger jobb til sluttstatus", () => {
  it("opprett jobb → worker kjører → jobbstatus viser completed", async () => {
    const created = await chat("opprett jobb: skriv ukesrapport");
    expect(created.status).toBe(200);
    const taskId = created.body["task_id"] as string;
    expect(taskId).toMatch(/^task-/);
    expect(created.body["routed"]).toBe("fast");

    const before = await chat(`jobbstatus ${taskId}`);
    expect(before.body["reply"]).toContain("created");

    await fetch(`${baseUrl}/worker/tick`, { method: "POST" });

    const after = await chat(`jobbstatus ${taskId}`);
    expect(after.body["reply"]).toContain("completed");
    expect(after.body["reply"]).toContain("skriv ukesrapport");
  });
});

describe("Akseptanse 2: modellkall har kostnad knyttet til session/task", () => {
  it("modellsvar skriver cost_events-rad og trace-span med kostnad", async () => {
    const result = await chat("hva synes du om planen min?");
    expect(result.body["routed"]).toBe("model");
    const sessionId = result.body["session_id"] as string;

    const cost = await withTenantTransaction(appPool, "tenant-personal", (c) =>
      // UA-1: også feilforsøk (failing-provider) logges som egne rader - filtrer på suksessraden.
      c.query("SELECT kind, amount_ore, session_id FROM cost_events WHERE session_id = $1 AND kind = 'model:scripted'", [sessionId])
    );
    expect(cost.rows.length).toBeGreaterThan(0);
    expect(cost.rows[0].kind).toBe("model:scripted");
    expect(Number(cost.rows[0].amount_ore)).toBeGreaterThan(0);

    const span = trace.spans.find((s) => s.kind === "model_call" && s.session_id === sessionId);
    expect(span).toBeDefined();
    expect(span?.cost_ore).toBeGreaterThan(0);
  });

  it("fallback: første provider feiler, neste brukes", async () => {
    const result = await chat("fortell en kort vits");
    expect(result.body["routed"]).toBe("model");
    expect((result.body["reply"] as string).length).toBeGreaterThan(0);
  });
});

describe("Akseptanse 3: kritisk verktøy (klasse D) i kjørende app", () => {
  async function criticalDemo(approval?: SignedApproval) {
    const response = await fetch(`${baseUrl}/tools/critical-demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: await authorize(webIdentity), parameters: { confirm: true }, approval })
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("uten godkjenning → 403 DENY", async () => {
    const result = await criticalDemo();
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("class_d_missing_approval");
  });

  it("gyldig signert godkjenning → ALLOW; replay → DENY (persistent nonce)", async () => {
    const approval = makeApproval();
    const first = await criticalDemo(approval);
    expect(first.status).toBe(200);
    expect(first.body["decision"]).toBe("ALLOW");

    const replay = await criticalDemo(approval);
    expect(replay.status).toBe(403);
    expect(replay.body["reason"]).toBe("class_d_nonce_already_used");
  });

  it("to samtidige forsøk med samme godkjenning → nøyaktig én ALLOW", async () => {
    const approval = makeApproval();
    const [a, b] = await Promise.all([criticalDemo(approval), criticalDemo(approval)]);
    const allowed = [a, b].filter((r) => r.status === 200);
    expect(allowed).toHaveLength(1);
  });

  it("feil action brenner ikke nonce; korrekt bruk etterpå → ALLOW", async () => {
    const approval = makeApproval({ action: "annen_handling" });
    const wrong = await criticalDemo(approval);
    expect(wrong.status).toBe(403);
    expect(wrong.body["reason"]).toBe("class_d_action_mismatch");

    const correct = makeApproval({ nonce: approval.nonce });
    const ok = await criticalDemo(correct);
    expect(ok.status).toBe(200);
  });
});

describe("Akseptanse 4: kjente kommandoer uten LLM-kall (verifisert i trace)", () => {
  it("'status' rutes deterministisk; ingen modellkall gjøres", async () => {
    const callsBefore = scripted.calls.length;
    const result = await chat("status");
    expect(result.body["routed"]).toBe("fast");
    expect(scripted.calls.length).toBe(callsBefore);

    const span = trace.spans.find((s) => s.kind === "fast_route" && s.name === "system_status");
    expect(span).toBeDefined();
    expect(span?.metadata?.["llm_used"]).toBe(false);
  });
});

describe("Akseptanse 5: hardgrense på budsjett håndheves med tydelig feilmelding", () => {
  it("tenant over 3 000 kr/mnd får modellkall nektet", async () => {
    const result = await chat("hva bør jeg prioritere?", {
      person_id: "person-tobias",
      tenant_id: "tenant-budget",
      device_id: "dev-web-b",
      memory_space: "personal",
      channel: "web"
    });
    expect(result.body["routed"]).toBe("blocked");
    expect(result.body["reply"]).toContain("budsjett");
    expect(result.body["reply"]).toContain("nektes");
  });
});

describe("SSE-streaming", () => {
  it("chat med Accept: text/event-stream gir token- og done-events", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: await chatSseBody("status")
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: token");
    expect(text).toContain("event: done");
  });
});

describe("BO-11.1 §6-§7: SSE klient-disconnect → upstream abort (barge-in-fundament §8)", () => {
  it("A/C/E: frakobling midt i stream kansellerer generasjonen upstream - ingen health-straff, ingen zombie", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: await chatSseBody("fortell en langsom historie"),
      signal: controller.signal
    });
    // Les til første token-event er mottatt, koble så fra midt i genereringen:
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes("event: token")) {
        controller.abort();
        break;
      }
    }
    // Gi serveren tid til å registrere close og kansellere upstream:
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A: generasjonen ble faktisk kansellert i Conversation Engine (ikke bare
    // stoppet socket-skriving) - delvis svar persistert med eksplisitt markør:
    const saved = await adminPool.query(
      `SELECT content FROM messages WHERE content LIKE '%[avbrutt av bruker]%' LIMIT 1`
    );
    expect(saved.rowCount).toBe(1);
    // C (§35): bruker-kansellering er ALDRI provider-feil:
    expect(gateway.meshStatus().providers.find((p) => p.provider === "scripted")?.failures).toBe(0);
  });

  it("B/D: ny request rett etterpå fungerer normalt med nøyaktig ett done-event", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: await chatSseBody("hva er planen for dagen?")
    });
    const text = await response.text();
    expect(text).toContain("Hei Tobias, dette er et modellsvar.".split(" ")[0] as string);
    expect(text.match(/event: done/g)?.length).toBe(1); // aldri duplisert final
  });
});

describe("D-30 HOST BLOCKER §1-§3/§8: stream-levering + kansellering mot EKTE HTTP/SSE (ikke mocks)", () => {
  it("§8.D: mange distinkte SSE token-events spredt over tid - ekte inkrementell levering, ikke ett bufret burst", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: await chatSseBody("fortell en langsom historie")
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const tokenTimestamps: number[] = [];
    let buffer = "";
    const tStart = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: token")) {
        tokenTimestamps.push(Date.now() - tStart);
        buffer = "";
      }
    }
    // "langsom historie" scripter 150 tokens á ~1ms - dette beviser at HELE
    // HTTP/SSE-kjeden (server.ts→HttpCoreClient-ekvivalent fetch-parsing)
    // leverer inkrementelt for et LANGT svar, ikke i ett bufret burst ved slutt:
    expect(tokenTimestamps.length).toBeGreaterThanOrEqual(50);
    expect((tokenTimestamps.at(-1) ?? 0) - (tokenTimestamps[0] ?? 0)).toBeGreaterThan(20);
  });

  it("§8.D: AbortSignal etter observert AKTIV stream (2+ tokens) gir deterministic AbortError, uansett svarlengde", async () => {
    const controller = new AbortController();
    let tokens = 0;
    const tStart = Date.now();
    let errName: string | undefined;
    try {
      const response = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: await chatSseBody("fortell en langsom historie to"),
        signal: controller.signal
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("event: token")) {
          tokens += 1;
          if (tokens === 2) controller.abort();
          buffer = "";
        }
      }
    } catch (err) {
      errName = (err as Error).name;
    }
    const elapsed = Date.now() - tStart;
    // Deterministisk (ikke en race): en 150-tokens/~150ms-generering avbrutt
    // etter kun 2 tokens skal ALLTID gi AbortError, uansett total svarlengde:
    expect(errName).toBe("AbortError");
    expect(tokens).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(500); // avbrutt tidlig - IKKE etter naesten hele generasjonen
  });
});

describe("D-30 live-funn-fix: ConversationEngine → mesh tool bridge (§1-§6)", () => {
  it("A/B: kalender-intent → completeWithTools → ToolGateway (ekte skjema) → syntese-svar", async () => {
    const before = calendarTransport.calls.length;
    const result = await chat("Hva står på kalenderen min i dag?", { ...webIdentity, device_id: "dev-voice" });
    expect(result.status).toBe(200);
    expect(result.body["routed"]).toBe("model");
    expect(result.body["reply"]).toContain("standup 09:00");
    // Verktøyet ble FAKTISK utført gjennom Tool Gateway mot ekte input-skjema:
    expect(calendarTransport.calls.length).toBe(before + 1);
    const params = calendarTransport.calls.at(-1)?.parameters as { from: string; to: string };
    // Trusted parameterbygging (live-funn: tomme model-args ga invalid_parameters):
    expect(typeof params.from).toBe("string");
    expect(typeof params.to).toBe("string");
    expect(new Date(params.to).getTime() - new Date(params.from).getTime()).toBe(86_400_000);
    // B: banen var completeWithTools - modellen fikk tool-definisjoner i requesten:
    expect(scripted.calls.some((c) => (c.tools?.length ?? 0) > 0)).toBe(true);
  });

  it("D: SSE sender trusted tool_call-event med KUN tool_name - aldri args/tool-result", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: await chatSseBody("Hva står på kalenderen min i dag?")
    });
    const text = await response.text();
    expect(text).toContain("event: tool_call");
    const dataLine = text.split("\n").find((l, i, all) => all[i - 1] === "event: tool_call");
    const payload = JSON.parse((dataLine as string).replace("data: ", "")) as Record<string, unknown>;
    // Eksakt kontrakt: kun tool_name krysser trust-grensen til klienten.
    expect(payload).toEqual({ tool_name: "read_calendar_today" });
    // Tool-RESULTATET (markert payload) finnes i transporten, men ALDRI i SSE-stremmen:
    expect(text).not.toContain(TOOL_PAYLOAD_MARKER);
    expect(text.match(/event: done/g)?.length).toBe(1);
  });

  it("C: executor bindes til samtalens resolved identity - tenant følger tool-utførelsen", async () => {
    const before = calendarTransport.calls.length;
    const result = await chat("Hva står på kalenderen min i dag?", {
      person_id: "person-tobias",
      tenant_id: "tenant-second",
      device_id: "dev-web-c",
      memory_space: "personal",
      channel: "web"
    });
    expect(result.body["routed"]).toBe("model");
    expect(calendarTransport.calls.length).toBe(before + 1);
    // Fabrikken fikk tenant-second-identiteten (IKKE en global ownerIdentity):
    const bound = executorIdentities.find((i) => i.tenant_id === "tenant-second");
    expect(bound).toBeDefined();
    expect(bound?.device_id).toBe("dev-web-c");
    // Og utførelsen ble auditert i RIKTIG tenant - begge tenants har egne spor:
    const audit = await adminPool.query(
      "SELECT DISTINCT tenant_id FROM audit_events WHERE type = 'tool.executed' AND tool_id = 'calendar'"
    );
    const tenants = audit.rows.map((r: { tenant_id: string }) => r.tenant_id).sort();
    expect(tenants).toEqual(["tenant-personal", "tenant-second"]);
  });

  it("H: owner-seed (inkl. voice-device og web-device) er idempotent - to kjøringer, én rad per device", async () => {
    const owner = { tenant_id: "tenant-personal", owner_person_id: "person-tobias", owner_display_name: "Tobias" };
    await seedOwner(adminPool, owner);
    await seedOwner(adminPool, owner); // idempotens: andre kjøring endrer ingenting
    const devices = await adminPool.query(
      "SELECT device_id, kind, COUNT(*)::int AS n FROM devices WHERE device_id IN ('jarvis-core','jarvis-voice-live','dev-web') GROUP BY device_id, kind ORDER BY device_id"
    );
    // D-130: `dev-web` finnes FRA FØR (seedet med ekte public_key_pem i denne
    // filens egen beforeAll) - `ON CONFLICT DO NOTHING` etterlater den
    // eksisterende nøkkelen urørt, kun ÉN rad totalt.
    expect(devices.rows).toEqual([
      { device_id: "dev-web", kind: "web", n: 1 },
      { device_id: "jarvis-core", kind: "service", n: 1 },
      { device_id: "jarvis-voice-live", kind: "voice", n: 1 }
    ]);
  });
});
