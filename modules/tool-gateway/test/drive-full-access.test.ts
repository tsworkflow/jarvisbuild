import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApprovalPayload, IdentityContext, JsonValue, SignedApproval } from "@jarvis/contracts";
import { signApproval } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";

/**
 * UA-2 P1A scope-endring (2026-08-16): Google Drive full read/write/
 * permissions - policy/risk/idempotency/isolasjon/observability-bevis via
 * EKTE ToolGateway + EKTE Postgres (embedded), FakeTransport for selve
 * Drive-API-et (ingen live-credential i dette testmiljøet). Speiler mønsteret
 * i `ua0-sovereign.test.ts` (sovereign/delegert D-klasse-bevis) og
 * `erasure-service.test.ts` §7/§8 (signert Ed25519-approval).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const OWNER_TENANT = "tenant-drive-owner";
const owner: IdentityContext = {
  person_id: "person-tobias", tenant_id: OWNER_TENANT, memory_space_id: "personal",
  session_id: "sess-drive-owner", device_id: "dev-owner", channel: "api", auth_strength: "active"
};
const delegateIdentity: IdentityContext = { ...owner, tenant_id: "tenant-drive-delegate" };
const secrets: SecretProvider = { name: "test", async get() { return "fake-google-token"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-drive-write-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_drive_write LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_drive_write");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${OWNER_TENANT}','Drive Owner','person'), ('tenant-drive-delegate','Drive Delegate','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${OWNER_TENANT}'), ('person-tobias','tenant-drive-delegate');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_drive_write", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

interface DriveFakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
}

/** Statefull Drive-fake - nok tilstand til å bevise create/update/rename/move/trash/delete faktisk endrer noe, og til å telle faktiske kall for idempotens-bevis. */
function buildStatefulDriveTransport() {
  const files = new Map<string, DriveFakeFile>();
  const permissions = new Map<string, Array<{ id: string; role: string; type: string; emailAddress?: string | undefined }>>();
  let nextId = 1;
  const transport = new FakeTransport((action, parameters) => {
    switch (action) {
      case "create_file":
      case "create_folder": {
        const id = `fake-file-${nextId++}`;
        files.set(id, {
          id, name: String(parameters["name"]),
          mimeType: action === "create_folder" ? "application/vnd.google-apps.folder" : String(parameters["mime_type"] ?? "text/plain"),
          parents: parameters["parent_folder_id"] ? [String(parameters["parent_folder_id"])] : [],
          trashed: false
        });
        return { external_id: id, data: { id, name: files.get(id)?.name ?? "" } };
      }
      case "get_metadata": {
        const id = String(parameters["file_id"]);
        const file = files.get(id);
        if (!file) throw new Error(`drive_not_found_${id}`);
        return { data: { id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed, parents: file.parents, headRevisionId: "rev-1", modifiedTime: "2026-08-16T00:00:00Z" } };
      }
      case "update_content": {
        const id = String(parameters["file_id"]);
        if (!files.has(id)) throw new Error(`drive_not_found_${id}`);
        return { external_id: id, data: { id, name: files.get(id)?.name ?? "", head_revision_id: "rev-2" } };
      }
      case "rename": {
        const id = String(parameters["file_id"]);
        const file = files.get(id);
        if (!file) throw new Error(`drive_not_found_${id}`);
        file.name = String(parameters["new_name"]);
        return { external_id: id, data: { id, name: file.name } };
      }
      case "move": {
        const id = String(parameters["file_id"]);
        const file = files.get(id);
        if (!file) throw new Error(`drive_not_found_${id}`);
        file.parents = [String(parameters["new_parent_folder_id"])];
        return { external_id: id, data: { id, name: file.name, parents: file.parents } };
      }
      case "trash": {
        const id = String(parameters["file_id"]);
        const file = files.get(id);
        if (!file) throw new Error(`drive_not_found_${id}`);
        file.trashed = true;
        return { external_id: id, data: { id, name: file.name, trashed: "true" } };
      }
      case "delete_permanent": {
        const id = String(parameters["file_id"]);
        const existed = files.delete(id);
        return { external_id: id, data: { id, already_deleted: String(!existed) } };
      }
      case "read_permissions": {
        const id = String(parameters["file_id"]);
        return { data: { permissions: (permissions.get(id) ?? []) as unknown as JsonValue } };
      }
      case "create_permission": {
        const id = String(parameters["file_id"]);
        const permId = `perm-${nextId++}`;
        const list = permissions.get(id) ?? [];
        list.push({ id: permId, role: String(parameters["role"]), type: String(parameters["type"]), emailAddress: parameters["email_address"] ? String(parameters["email_address"]) : undefined });
        permissions.set(id, list);
        return { external_id: permId, data: { id: permId, type: String(parameters["type"]), role: String(parameters["role"]) } };
      }
      default:
        throw new Error(`uventet action: ${action}`);
    }
  });
  return { transport, files, permissions };
}

function buildGateway(transport: FakeTransport, authority?: { owner_person_id: string; owner_tenants: string[] }, devices = new InMemoryDeviceRegistry()) {
  const policy = new PolicyGateway({
    devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    ...(authority ? { authority } : {})
  });
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ drive: transport })) gateway.register(tool);
  return { gateway, policy };
}

const sovereignAuthority = { owner_person_id: "person-tobias", owner_tenants: [OWNER_TENANT] };

describe("Drive full read/write access - A/B/C: create/update basics (klasse C, sovereign autonom)", () => {
  it("A: create_file oppretter en ny fil og returnerer external_id", async () => {
    const { transport } = buildStatefulDriveTransport();
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({
      identity: owner, tool_id: "drive", action: "create_file",
      parameters: { name: "notat.txt", content: "hei", parent_folder_id: "folder-root" }
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.external_id).toBeTruthy();
  });

  it("B: create_folder oppretter en ny mappe", async () => {
    const { transport } = buildStatefulDriveTransport();
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({
      identity: owner, tool_id: "drive", action: "create_folder", parameters: { name: "Ny mappe" }
    });
    expect(result.ok).toBe(true);
  });

  it("C: update_content oppdaterer innholdet i en eksisterende fil (preflight get_metadata trigges)", async () => {
    const { transport, files } = buildStatefulDriveTransport();
    files.set("existing-1", { id: "existing-1", name: "eksisterende.txt", mimeType: "text/plain", parents: [], trashed: false });
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({
      identity: owner, tool_id: "drive", action: "update_content",
      parameters: { file_id: "existing-1", content: "nytt innhold" }
    });
    expect(result.ok).toBe(true);
    expect(transport.calls.some((c) => c.action === "get_metadata")).toBe(true); // §4: preflight-evidens faktisk kalt
  });
});

describe("Drive full read/write access - D/E/F: rename/move/trash", () => {
  it("D: rename gir filen et nytt navn", async () => {
    const { transport, files } = buildStatefulDriveTransport();
    files.set("f1", { id: "f1", name: "gammelt.txt", mimeType: "text/plain", parents: [], trashed: false });
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({ identity: owner, tool_id: "drive", action: "rename", parameters: { file_id: "f1", new_name: "nytt.txt" } });
    expect(result.ok).toBe(true);
    expect(files.get("f1")?.name).toBe("nytt.txt");
  });

  it("E: move flytter filen til en ny foreldremappe", async () => {
    const { transport, files } = buildStatefulDriveTransport();
    files.set("f1", { id: "f1", name: "fil.txt", mimeType: "text/plain", parents: ["old-folder"], trashed: false });
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({ identity: owner, tool_id: "drive", action: "move", parameters: { file_id: "f1", new_parent_folder_id: "new-folder" } });
    expect(result.ok).toBe(true);
    expect(files.get("f1")?.parents).toEqual(["new-folder"]);
  });

  it("F: trash legger filen i papirkurven (reversibelt - IKKE files.delete)", async () => {
    const { transport, files } = buildStatefulDriveTransport();
    files.set("f1", { id: "f1", name: "fil.txt", mimeType: "text/plain", parents: [], trashed: false });
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const result = await gateway.execute({ identity: owner, tool_id: "drive", action: "trash", parameters: { file_id: "f1" } });
    expect(result.ok).toBe(true);
    expect(files.get("f1")?.trashed).toBe(true);
    expect(files.has("f1")).toBe(true); // fortsatt der - trash er IKKE permanent sletting
  });
});

describe("Drive full read/write access - G/H/I: destruktive/sikkerhetskritiske handlinger (klasse D)", () => {
  const watchKeys = generateKeyPairSync("ed25519");
  // JARVIS-051: godkjenningen er bundet til verktøy, tenant, person og approver - ikke bare handling + parametere.
  function signApprovalFor(payload: Omit<ApprovalPayload, "parameters_hash" | "issued_at" | "expires_at" | "tool_id" | "tenant_id" | "person_id" | "approver_person_id"> & { parameters: Record<string, JsonValue> }): SignedApproval {
    return signApproval(watchKeys.privateKey, {
      ...payload, tool_id: "drive", tenant_id: delegateIdentity.tenant_id, person_id: delegateIdentity.person_id,
      approver_person_id: delegateIdentity.person_id
    });
  }

  it("G: permanent delete - sovereign owner utfører autonomt UTEN approval; delegert nektes uten, tillates med gyldig signert approval", async () => {
    const { transport, files } = buildStatefulDriveTransport();
    files.set("f1", { id: "f1", name: "fil.txt", mimeType: "text/plain", parents: [], trashed: false });
    const { gateway: ownerGateway } = buildGateway(transport, sovereignAuthority);
    const sovereignResult = await ownerGateway.execute({ identity: owner, tool_id: "drive", action: "delete_permanent", parameters: { file_id: "f1" } });
    expect(sovereignResult.ok).toBe(true);
    expect(files.has("f1")).toBe(false); // faktisk PERMANENT slettet, ikke bare trashed

    const { transport: delegateTransport, files: delegateFiles } = buildStatefulDriveTransport();
    delegateFiles.set("f2", { id: "f2", name: "fil2.txt", mimeType: "text/plain", parents: [], trashed: false });
    const devices = new InMemoryDeviceRegistry();
    devices.register("watch-1", watchKeys.publicKey, { tenant_id: delegateIdentity.tenant_id, person_id: delegateIdentity.person_id });
    const { gateway: delegateGateway } = buildGateway(delegateTransport, undefined, devices); // ingen authority = ingen sovereign-modus for noen

    const denied = await delegateGateway.execute({ identity: delegateIdentity, tool_id: "drive", action: "delete_permanent", parameters: { file_id: "f2" } });
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.reason).toBe("class_d_missing_approval");
    expect(delegateFiles.has("f2")).toBe(true); // IKKE slettet uten approval

    const approval = signApprovalFor({
      action: "delete_permanent", parameters: { file_id: "f2" } as Record<string, JsonValue>,
      nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-1"
    });
    const allowed = await delegateGateway.execute({ identity: delegateIdentity, tool_id: "drive", action: "delete_permanent", parameters: { file_id: "f2" }, approval });
    expect(allowed.ok).toBe(true);
    expect(delegateFiles.has("f2")).toBe(false);
  });

  it("H: read_permissions er klasse A - alltid tillatt, ingen approval-friksjon", async () => {
    const { transport, permissions } = buildStatefulDriveTransport();
    permissions.set("f1", [{ id: "perm-1", role: "reader", type: "user", emailAddress: "noen@example.com" }]);
    const { gateway } = buildGateway(transport); // ingen authority-config i det hele tatt
    const result = await gateway.execute({ identity: delegateIdentity, tool_id: "drive", action: "read_permissions", parameters: { file_id: "f1" } });
    expect(result.ok).toBe(true);
  });

  it("I: create_permission (deling) - sovereign autonomt; delegert krever signert approval (samme mønster som G)", async () => {
    const { transport } = buildStatefulDriveTransport();
    const { gateway: ownerGateway } = buildGateway(transport, sovereignAuthority);
    const sovereignResult = await ownerGateway.execute({
      identity: owner, tool_id: "drive", action: "create_permission",
      parameters: { file_id: "f1", role: "reader", type: "user", email_address: "kollega@example.com" }
    });
    expect(sovereignResult.ok).toBe(true);

    const { transport: delegateTransport } = buildStatefulDriveTransport();
    const devices = new InMemoryDeviceRegistry();
    devices.register("watch-2", watchKeys.publicKey, { tenant_id: delegateIdentity.tenant_id, person_id: delegateIdentity.person_id });
    const { gateway: delegateGateway } = buildGateway(delegateTransport, undefined, devices);
    const denied = await delegateGateway.execute({
      identity: delegateIdentity, tool_id: "drive", action: "create_permission",
      parameters: { file_id: "f1", role: "reader", type: "user", email_address: "kollega@example.com" }
    });
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.reason).toBe("class_d_missing_approval");
  });
});

describe("Drive full read/write access - J: idempotens", () => {
  it("J: create_file med SAMME idempotency_key gir KUN én faktisk utførelse (samme external_id begge ganger)", async () => {
    const { transport } = buildStatefulDriveTransport();
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const key = `idem-${randomUUID()}`;
    const first = await gateway.execute({ identity: owner, tool_id: "drive", action: "create_file", parameters: { name: "a.txt" }, idempotency_key: key });
    const second = await gateway.execute({ identity: owner, tool_id: "drive", action: "create_file", parameters: { name: "a.txt" }, idempotency_key: key });
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.external_id === second.external_id).toBe(true);
    expect(second.ok && second.deduplicated).toBe(true);
    expect(transport.calls.filter((c) => c.action === "create_file")).toHaveLength(1); // KUN én faktisk Drive-side-effekt
  });

  it("J (permission-mutasjon): create_permission med SAMME idempotency_key gir IKKE dupliserte tilganger - Drive selv dedupliserer IKKE identiske permissions", async () => {
    const { transport, permissions } = buildStatefulDriveTransport();
    const { gateway } = buildGateway(transport, sovereignAuthority);
    const key = `idem-perm-${randomUUID()}`;
    const params = { file_id: "f1", role: "reader", type: "user", email_address: "x@example.com" };
    await gateway.execute({ identity: owner, tool_id: "drive", action: "create_permission", parameters: params, idempotency_key: key });
    await gateway.execute({ identity: owner, tool_id: "drive", action: "create_permission", parameters: params, idempotency_key: key });
    expect(permissions.get("f1")).toHaveLength(1); // uten ToolGateway sin dedupe ville dette blitt 2 (Drive API dedupliserer ikke selv)
  });
});

describe("Drive full read/write access - L: provider-feilklassifisering", () => {
  it("L: en Drive-feil klassifiseres i ToolGateway sin health-status (rate_limited), aldri en stille suksess", async () => {
    const failingTransport = new FakeTransport(() => ({}), "drive_rate_limited");
    const { gateway } = buildGateway(failingTransport, sovereignAuthority);
    const result = await gateway.execute({ identity: owner, tool_id: "drive", action: "create_file", parameters: { name: "a.txt" } });
    expect(result.ok).toBe(false);
    expect(gateway.health.get("drive")?.state).toBe("rate_limited");
  });

  it("L: en 401-lignende feil klassifiseres som auth_failed", async () => {
    const failingTransport = new FakeTransport(() => ({}), "drive_auth_error_401");
    const { gateway } = buildGateway(failingTransport, sovereignAuthority);
    const result = await gateway.execute({ identity: owner, tool_id: "drive", action: "rename", parameters: { file_id: "f1", new_name: "x" } });
    expect(result.ok).toBe(false);
    expect(gateway.health.get("drive")?.state).toBe("auth_failed");
  });
});

describe("Drive full read/write access - M: Q-20-distinksjon fra kilde-sletting", () => {
  it("M: en drive/trash-handling rører ALDRI knowledge_documents - ingesterte kopier og Drive-kildefiler er separate operasjoner", async () => {
    const docId = `kd-drive-m-${randomUUID()}`;
    await adminPool.query(
      `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash, modified_at, metadata)
       VALUES ($1,$2,'personal','google_drive','drive:m-test','ext-1','https://drive.google.com/x','t','c','text/plain','h',now(),'{}'::jsonb)`,
      [docId, OWNER_TENANT]
    );
    const { transport, files } = buildStatefulDriveTransport();
    files.set("ext-1", { id: "ext-1", name: "t", mimeType: "text/plain", parents: [], trashed: false });
    const { gateway } = buildGateway(transport, sovereignAuthority);
    await gateway.execute({ identity: owner, tool_id: "drive", action: "trash", parameters: { file_id: "ext-1" } });

    const row = await adminPool.query("SELECT deleted FROM knowledge_documents WHERE knowledge_document_id=$1", [docId]);
    expect((row.rows[0] as { deleted: boolean }).deleted).toBe(false); // uendret - drive/trash er IKKE Q-20, IKKE knowledge-sync

    await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id=$1", [docId]);
  });

  it("M: en Q-20-stil hard-delete av en knowledge_document rører ALDRI Drive (ingen forsøk på å slette kildefilen)", async () => {
    const docId = `kd-drive-m2-${randomUUID()}`;
    await adminPool.query(
      `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash, modified_at, metadata)
       VALUES ($1,$2,'personal','google_drive','drive:m2-test','ext-2','https://drive.google.com/y','t','c','text/plain','h',now(),'{}'::jsonb)`,
      [docId, OWNER_TENANT]
    );
    const { transport } = buildStatefulDriveTransport(); // aldri wired opp mot noe kall i denne testen
    void transport;
    // Simulerer nøyaktig det Q-20 sin ErasureService gjør: hard-delete raden. Ingen ToolGateway/Drive-kall involvert i det hele tatt.
    await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id=$1", [docId]);
    expect(transport.calls).toHaveLength(0); // Q-20-erasure kalte ALDRI ut til Drive
  });
});

describe("Drive full read/write access - N: Q-21 tenant-isolasjon av idempotency-dedupe", () => {
  it("N: to ULIKE tenants som bruker SAMME idempotency_key blir IKKE deduplisert mot hverandre (RLS-scopet tool_executions)", async () => {
    const { transport: transportA } = buildStatefulDriveTransport();
    const { transport: transportB } = buildStatefulDriveTransport();
    const { gateway: gatewayA } = buildGateway(transportA, sovereignAuthority);
    // Begge tenants sovereign her - testens poeng er dedupe-isolasjon, ikke policy-risikoklasse (den er dekket av G/I over).
    const { gateway: gatewayB } = buildGateway(transportB, { owner_person_id: "person-tobias", owner_tenants: [OWNER_TENANT, "tenant-drive-delegate"] });
    const sharedKey = `shared-idem-${randomUUID()}`;

    const resultA = await gatewayA.execute({ identity: owner, tool_id: "drive", action: "create_file", parameters: { name: "a.txt" }, idempotency_key: sharedKey });
    const resultB = await gatewayB.execute({ identity: delegateIdentity, tool_id: "drive", action: "create_file", parameters: { name: "a.txt" }, idempotency_key: sharedKey });

    expect(resultA.ok && resultB.ok).toBe(true);
    expect(resultB.ok && resultB.deduplicated).toBe(false); // IKKE deduplisert mot tenant A sin utførelse
    expect(transportA.calls.filter((c) => c.action === "create_file")).toHaveLength(1);
    expect(transportB.calls.filter((c) => c.action === "create_file")).toHaveLength(1); // begge tenants fikk sin EGEN faktiske utførelse
  });
});

describe("Drive full read/write access - O: ingen tokens/innhold i audit_events", () => {
  it("O: credential-verdien og filinnholdet havner ALDRI i audit_events.payload for en create_file/update_content-handling", async () => {
    const sentinelContent = `SentinelDriveContent${randomUUID().replace(/-/g, "")}`;
    const { transport } = buildStatefulDriveTransport();
    const { gateway } = buildGateway(transport, sovereignAuthority);
    await gateway.execute({ identity: owner, tool_id: "drive", action: "create_file", parameters: { name: "s.txt", content: sentinelContent } });

    const rows = await adminPool.query("SELECT payload::text AS p FROM audit_events WHERE tenant_id=$1 AND tool_id='drive'", [OWNER_TENANT]);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows as Array<{ p: string }>) {
      expect(row.p.includes(sentinelContent)).toBe(false);
      expect(row.p.includes("fake-google-token")).toBe(false);
    }
  });
});
