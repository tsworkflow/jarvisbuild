import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority,
  ContextBuilder,
  DeviceService,
  IdentityService,
  MessageStore,
  SessionGrantService,
  SessionService,
  createPool,
  runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DeploymentService, IncidentService } from "@jarvis/incidents";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import type { JsonValue } from "@jarvis/contracts";
import {
  ToolGateway, type SecretProvider, type ToolDefinition, type ToolInvocationContext, type ToolTransport
} from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";

/**
 * D-105 (UA-5 kriterium 1 host-fix): ENDE-TIL-ENDE HTTP-bevis for den NYE
 * `/deployments/ingest/github`-produksjonsruten - EKTE `createApiServer()` +
 * EKTE `fetch()`, samme presedens som `coding-production-wiring.test.ts`.
 * `github.get_workflow_run`/`get_commit` er registrert med DE EKSAKTE
 * skjemaene/klasse-A/`credential_ref`-verdiene fra `integrations.ts` (samme
 * "hånd-speilet ToolDefinition, ikke `firstWaveTools()`"-mønster som
 * `infra-execution.test.ts` sin `dockerToolDefinitions()`), mot en FAKE
 * github-transport (ALDRI ekte HTTP) - beviser at ingestion går GJENNOM
 * `ToolGateway.execute()`, ikke et direkte provider-kall.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let deploymentService: DeploymentService;

const TENANT_A = "tenant-deploy-a";
const TENANT_B = "tenant-deploy-b";
const REPO = "tsworkflow/example-repo";

const identityA = {
  person_id: "person-deploy-a", tenant_id: TENANT_A, memory_space: "business",
  channel: "api", device_id: "dev-a", session_id: "sess-a", auth_strength: "active"
} as const;
const identityB = {
  person_id: "person-deploy-b", tenant_id: TENANT_B, memory_space: "business",
  channel: "api", device_id: "dev-b", session_id: "sess-b", auth_strength: "active"
} as const;

// Remediering del 2: kontrollrutene tar KUN et grant - identiteten under er bare
// beskrivelsen av HVEM som skal få et grant utstedt via den ekte enhetsbevis-veien.
const deviceKeys: Record<string, TestDeviceKey> = { "dev-a": generateDeviceKey(), "dev-b": generateDeviceKey() };
const grantCache = new Map<string, string>();
async function grantOf(identity: typeof identityA | typeof identityB): Promise<string> {
  const cached = grantCache.get(identity.device_id);
  if (cached) return cached;
  const token = await mintGrant(baseUrl, identity, deviceKeys[identity.device_id]!);
  grantCache.set(identity.device_id, token);
  return token;
}

const FAKE_TOKEN = "fake-github-token-D105-TEST-NEVER-REAL-9f3a";

function defaultRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "555", name: "CI", status: "completed", conclusion: "success",
    head_sha: "abcdef1234567890", head_branch: "main",
    html_url: "https://github.test/owner/repo/actions/runs/555",
    created_at: "2026-08-22T09:00:00Z",
    ...overrides
  };
}

class FakeGithubTransport implements ToolTransport {
  failWorkflowRun: string | null = null;
  workflowRun: Record<string, unknown> | null = defaultRun();
  failCommit = false;
  calls: Array<{ action: string; parameters: Record<string, unknown> }> = [];

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    _context: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "get_workflow_run") {
      if (this.failWorkflowRun) throw new Error(this.failWorkflowRun);
      if (!this.workflowRun) throw new Error("github_404:workflow_run_not_found");
      return { external_id: String(this.workflowRun["id"] ?? ""), data: this.workflowRun as unknown as JsonValue };
    }
    if (action === "get_commit") {
      if (this.failCommit) throw new Error("github_commit_unavailable");
      return {
        external_id: String(parameters["ref"]),
        data: { sha: parameters["ref"], message: "ci: fix flaky test", author: "Tobias", html_url: "https://github.test/owner/repo/commit/x" } as JsonValue
      };
    }
    throw new Error(`unsupported_fake_action:${action}`);
  }
}

function githubToolDefinitions(transport: ToolTransport): ToolDefinition[] {
  const record = (fields: Record<string, z.ZodTypeAny>) => z.object(fields).strict() as unknown as ToolDefinition["input_schema"];
  const base = {
    scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
    idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
    credential_ref: "FAKE_GITHUB_TOKEN", output_trust: "untrusted" as const, transport
  };
  return [
    { tool_id: "github", action: "get_workflow_run", description: "test", input_schema: record({ repo: z.string(), run_id: z.string() }), capability_class: "A", ...base },
    { tool_id: "github", action: "get_commit", description: "test", input_schema: record({ repo: z.string(), ref: z.string() }), capability_class: "A", ...base }
  ];
}

let githubTransport: FakeGithubTransport;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-deploy-ingest-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_deploy_ingest LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_deploy_ingest");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','DeployA','business'), ('${TENANT_B}','DeployB','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-deploy-a','A'), ('person-deploy-b','B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-deploy-a','${TENANT_A}'), ('person-deploy-b','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-a','${TENANT_A}','business'), ('sp-b','${TENANT_B}','business');
  `);
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ('dev-a',$1,'person-deploy-a','api',$3), ('dev-b',$2,'person-deploy-b','api',$4)",
    [TENANT_A, TENANT_B, deviceKeys["dev-a"]!.publicKeyPem, deviceKeys["dev-b"]!.publicKeyPem]
  );
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_deploy_ingest", password: "pw2" });

  githubTransport = new FakeGithubTransport();
  const killSwitch = new KillSwitch();
  const infraGate = new InfraExecutionGate();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, infraGate,
    infraToolIds: new Set(["docker"]),
    authority: { owner_person_id: identityA.person_id, owner_tenants: [TENANT_A, TENANT_B] }
  });
  const secrets: SecretProvider = { name: "fake", get: async () => FAKE_TOKEN };
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const def of githubToolDefinitions(githubTransport)) gateway.register(def);

  const incidentService = new IncidentService(appPool);
  deploymentService = new DeploymentService(appPool);

  const trace = new MemoryTraceSink();
  const modelGateway = new ModelGateway({ pool: appPool, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const queue = new PgTaskQueue(appPool);
  const taskService = new TaskService(appPool, queue, policy);
  const worker = new InProcessWorker(queue, 60);

  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  server = createApiServer({
    identity: identityService,
    sessions: sessionService,
    // D-130/D-131: `ApiDeps.channelAuthority` og `ApiDeps.grants` er nå
    // påkrevde - strukturelt nødvendige her, ikke brukt av denne testens
    // `/deployments/ingest/github`-fokus.
    devices: deviceService,
    grants: grantService,
    channelAuthority: new ChannelSessionAuthority({
      pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService
    }),
    policy,
    worker,
    tasks: taskService,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool), context: new ContextBuilder(appPool), gateway: modelGateway,
      tasks: taskService, worker, trace
    }),
    incidents: { service: incidentService, deployments: deploymentService, gateway, infraGate, pool: appPool }
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

async function ingest(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/deployments/ingest/github`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function correlate(identity: unknown, incident_id: string, repo: string = REPO): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/incidents/correlate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_token: await grantOf(identity as typeof identityA), incident_id, repo })
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("D-105 host-fix: POST /deployments/ingest/github - EKTE ToolGateway.execute()-vei, ALDRI direkte HTTP", () => {
  it("A: identitet nektes -> 403, INGEN ingestion utført", async () => {
    const result = await ingest({ grant_token: "grt_ikke-utstedt-av-serveren", repo: REPO, workflow_run_id: "555" });
    expect(result.status).toBe(403);
    expect(result.body["error"]).toBe("identity_denied");
  });

  it("B: happy path - ekte ToolGateway-kall normaliseres og persisteres, canonical deployment + provenance returneres", async () => {
    githubTransport.workflowRun = defaultRun({ id: "600", head_sha: "sha-happy-path", head_branch: "main", conclusion: "success" });
    const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "600" });
    expect(result.status).toBe(200);
    const deployment = result.body["deployment"] as Record<string, unknown>;
    expect(deployment["commit_sha"]).toBe("sha-happy-path");
    expect(deployment["status"]).toBe("success");
    // FAKTISK provider-tidsstempel, ALDRI Date.now() - Postgres timestamptz normaliserer til millisekund-presisjon ved round-trip.
    expect(new Date(deployment["deployed_at"] as string).toISOString()).toBe("2026-08-22T09:00:00.000Z");
    expect(result.body["created"]).toBe(true);
    const provenance = result.body["provenance"] as Record<string, unknown>;
    expect(provenance["workflow_run_id"]).toBe("600");
    expect(provenance["commit_message"]).toBe("ci: fix flaky test");
    // beviser at kallet FAKTISK gikk via ToolGateway (get_workflow_run + get_commit), ikke en snarvei:
    expect(githubTransport.calls.some((c) => c.action === "get_workflow_run" && c.parameters["run_id"] === "600")).toBe(true);
    expect(githubTransport.calls.some((c) => c.action === "get_commit")).toBe(true);
  });

  it("C: idempotent - SAMME workflow_run_id gir INGEN duplikat, created=false andre gang", async () => {
    githubTransport.workflowRun = defaultRun({ id: "601", head_sha: "sha-idem", head_branch: "main" });
    const first = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "601" });
    expect(first.body["created"]).toBe(true);
    const second = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "601" });
    expect(second.body["created"]).toBe(false);
    expect((second.body["deployment"] as Record<string, unknown>)["deployment_id"]).toBe((first.body["deployment"] as Record<string, unknown>)["deployment_id"]);
  });

  it("D: success/failure/cancelled-mapping uten løgn - EKSPLISITT, ALDRI en antatt suksess", async () => {
    githubTransport.workflowRun = defaultRun({ id: "610", conclusion: "failure" });
    const failed = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "610" });
    expect((failed.body["deployment"] as Record<string, unknown>)["status"]).toBe("failure");

    githubTransport.workflowRun = defaultRun({ id: "611", conclusion: "cancelled" });
    const cancelled = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "611" });
    expect((cancelled.body["deployment"] as Record<string, unknown>)["status"]).toBe("cancelled");

    // Tvetydig/ukjent conclusion (f.eks. "neutral") -> KONSERVATIVT "failure", ALDRI gjettet "success":
    githubTransport.workflowRun = defaultRun({ id: "612", conclusion: "neutral" });
    const ambiguous = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "612" });
    expect((ambiguous.body["deployment"] as Record<string, unknown>)["status"]).toBe("failure");

    // status != completed -> in_progress, uansett hva conclusion (er null) sier:
    githubTransport.workflowRun = defaultRun({ id: "613", status: "in_progress", conclusion: null });
    const running = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "613" });
    expect((running.body["deployment"] as Record<string, unknown>)["status"]).toBe("in_progress");
  });

  it("E: provider utilgjengelig (feilende get_workflow_run) -> 502, ALDRI en fabrikkert deployment", async () => {
    githubTransport.failWorkflowRun = "github_500_simulated_outage";
    try {
      const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "620" });
      expect(result.status).toBe(502);
      expect(result.body["error"]).toBe("provider_unavailable");
    } finally {
      githubTransport.failWorkflowRun = null;
    }
  });

  it("F: manglende workflow (404-lignende) -> 502 provider_unavailable, ALDRI en gjettet deployment", async () => {
    githubTransport.workflowRun = null;
    try {
      const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "not-found-621" });
      expect(result.status).toBe(502);
    } finally {
      githubTransport.workflowRun = defaultRun();
    }
  });

  it("G: misdannet provider-respons (mangler head_sha) -> 422 invalid_provider_response, ALDRI fabrikkert commit_sha", async () => {
    githubTransport.workflowRun = defaultRun({ id: "630", head_sha: "" });
    const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "630" });
    expect(result.status).toBe(422);
    expect(result.body["error"]).toBe("invalid_provider_response");
  });

  it("H: misdannet provider-respons (mangler created_at) -> 422, ALDRI Date.now()-fallback kalt providersannhet", async () => {
    githubTransport.workflowRun = defaultRun({ id: "631" });
    delete githubTransport.workflowRun["created_at"];
    const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "631" });
    expect(result.status).toBe(422);
    githubTransport.workflowRun = defaultRun();
  });

  it("I: get_commit-feil er IKKE fatalt for selve ingestionen - provenance mangler kun commit-detaljer", async () => {
    githubTransport.workflowRun = defaultRun({ id: "640", head_sha: "sha-no-commit-enrichment" });
    githubTransport.failCommit = true;
    try {
      const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "640" });
      expect(result.status).toBe(200);
      expect((result.body["deployment"] as Record<string, unknown>)["commit_sha"]).toBe("sha-no-commit-enrichment");
      expect((result.body["provenance"] as Record<string, unknown>)["commit_message"]).toBeUndefined();
    } finally {
      githubTransport.failCommit = false;
    }
  });

  it("J: TENANT-ISOLASJON - tenant B sin ingestion av SAMME repo er en SEPARAT rad, tenant A ser den ikke som sin active_deployment", async () => {
    githubTransport.workflowRun = defaultRun({ id: "650", head_sha: "sha-tenant-a", created_at: "2026-08-22T08:00:00Z" });
    await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "650" });
    githubTransport.workflowRun = defaultRun({ id: "651", head_sha: "sha-tenant-b", created_at: "2026-08-22T08:30:00Z" });
    await ingest({ grant_token: await grantOf(identityB), repo: REPO, workflow_run_id: "651" });

    const activeA = await deploymentService.findActiveDeployment(TENANT_A, REPO);
    const activeB = await deploymentService.findActiveDeployment(TENANT_B, REPO);
    expect(activeA?.commit_sha).not.toBe("sha-tenant-b");
    expect(activeB?.commit_sha).toBe("sha-tenant-b");
  });

  it("K: hemmeligheter lekker ALDRI - FAKE_TOKEN-verdien dukker ikke opp i noe response-felt", async () => {
    githubTransport.workflowRun = defaultRun({ id: "660" });
    const result = await ingest({ grant_token: await grantOf(identityA), repo: REPO, workflow_run_id: "660" });
    expect(JSON.stringify(result.body)).not.toContain(FAKE_TOKEN);
  });
});

describe("D-105 host-fix: /incidents/correlate bruker canonical DeploymentService ETTER ekte ingestion", () => {
  it("L: active_deployment er FAKTISK deployment etter ingestion (ikke lenger null)", async () => {
    const repoL = `${REPO}-l`;
    const create = await fetch(`${baseUrl}/incidents/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: await grantOf(identityA), title: "D-105 korrelasjonstest L" })
    });
    const incident = ((await create.json()) as { incident: { incident_id: string } }).incident;

    githubTransport.workflowRun = defaultRun({ id: "670", head_sha: "sha-correlate-l", created_at: "2026-08-22T07:00:00Z" });
    await ingest({ grant_token: await grantOf(identityA), repo: repoL, workflow_run_id: "670" });

    const result = await correlate(identityA, incident.incident_id, repoL);
    expect(result.status).toBe(200);
    const correlation = result.body["correlation"] as { active_deployment: { commit_sha: string } | null };
    expect(correlation.active_deployment?.commit_sha).toBe("sha-correlate-l");
  });

  it("M: suspect_deployment velges deterministisk NÅR tidsvinduet støtter det, og matchende deployment-evidence forfremmes til VERIFIED", async () => {
    const repoM = `${REPO}-m`;
    const create = await fetch(`${baseUrl}/incidents/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: await grantOf(identityA), title: "D-105 korrelasjonstest M" })
    });
    const incident = ((await create.json()) as { incident: { incident_id: string } }).incident;

    githubTransport.workflowRun = defaultRun({ id: "680", head_sha: "sha-suspect-m", created_at: "2026-08-22T06:00:00Z" });
    const ingested = await ingest({ grant_token: await grantOf(identityA), repo: repoM, workflow_run_id: "680" });
    const deploymentId = (ingested.body["deployment"] as Record<string, unknown>)["deployment_id"] as string;

    // Log-bevis OBSERVERT ETTER deployen (06:30) - suspect_deployment skal peke på 680.
    await fetch(`${baseUrl}/incidents/evidence/add`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_token: await grantOf(identityA), incident_id: incident.incident_id,
        source_type: "log", summary: "500-feil observert i produksjon", observed_at: "2026-08-22T06:30:00Z"
      })
    });
    // Deployment-typet bevis som FAKTISK matcher suspect_deployment.deployment_id - eneste evidens Q-26 tillater forfremmet.
    await fetch(`${baseUrl}/incidents/evidence/add`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_token: await grantOf(identityA), incident_id: incident.incident_id,
        source_type: "deployment", source_ref: deploymentId, summary: "mistenkt utløsende deploy",
        observed_at: "2026-08-22T06:29:00Z"
      })
    });

    const result = await correlate(identityA, incident.incident_id, repoM);
    const correlation = result.body["correlation"] as {
      suspect_deployment: { deployment_id: string } | null;
      evidence: Array<{ source_type: string; source_ref: string | null; status: string }>;
    };
    expect(correlation.suspect_deployment?.deployment_id).toBe(deploymentId);
    const deploymentEvidence = correlation.evidence.find((e) => e.source_type === "deployment" && e.source_ref === deploymentId);
    expect(deploymentEvidence?.status).toBe("VERIFIED");
    // Q-26: log-bevis forfremmes ALDRI bare fordi en deploy finnes - forblir UNVERIFIED.
    const logEvidence = correlation.evidence.find((e) => e.source_type === "log");
    expect(logEvidence?.status).toBe("UNVERIFIED");
  });

  it("N: INGEN suspect_deployment når tidsdata IKKE støtter det (ingen bevis registrert ennå)", async () => {
    const create = await fetch(`${baseUrl}/incidents/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_token: await grantOf(identityA), title: "D-105 korrelasjonstest N" })
    });
    const incident = ((await create.json()) as { incident: { incident_id: string } }).incident;
    const result = await correlate(identityA, incident.incident_id);
    const correlation = result.body["correlation"] as { suspect_deployment: unknown };
    expect(correlation.suspect_deployment).toBeNull();
  });
});
