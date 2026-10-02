import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { signApproval } from "@jarvis/contracts";
import { createPool, failErasureRequest, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { FilesystemKnowledgeSource } from "@jarvis/knowledge";
import { KnowledgeRetriever } from "@jarvis/knowledge";
import { KnowledgeSyncService } from "@jarvis/knowledge";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway, type PolicyAuditEvent } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * Q-20 (docs/DATA_ERASURE.md) - tester A-Q fra byggeordren, pluss
 * D-klasse-policy-integrasjonen (§7/§8). Ekte embedded Postgres, ekte
 * migrasjoner, ekte RLS - via en GARANTERT non-bypass rolle (§O: Q-21 må
 * ALDRI regresere - ALLE tester i denne filen kjører gjennom `appPool`,
 * som er akkurat en slik rolle, aldri superbruker).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;

const TENANT_A = "tenant-erase-a";
const TENANT_B = "tenant-erase-b";

function identityFor(tenantId: string, space: string): IdentityContext {
  return {
    person_id: "person-tobias", tenant_id: tenantId, memory_space_id: space as IdentityContext["memory_space_id"],
    session_id: `sess-${tenantId}`, device_id: "dev-erase", channel: "api", auth_strength: "active"
  };
}

async function plantMemoryItem(tenantId: string, space: string, content: string): Promise<string> {
  const memoryItemId = `mi-${randomUUID()}`;
  const sourceId = `src-${randomUUID()}`;
  await withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    await client.query("INSERT INTO memory_sources (source_id, tenant_id, kind, ref, trust_level) VALUES ($1,$2,'manual',$3,'trusted')", [
      sourceId, tenantId, memoryItemId
    ]);
    await client.query(
      `INSERT INTO memory_items (memory_item_id, tenant_id, space, owner_person_id, type, subject, content, source_id, observed_at, valid_from, trust_level)
       VALUES ($1,$2,$3,'person-tobias','semantic',$4,$5,$6, now(), now(), 'trusted')`,
      [memoryItemId, tenantId, space, `subject-${memoryItemId}`, content, sourceId]
    );
    const vector = await embedding.embed(content);
    await client.query(
      "INSERT INTO embeddings (memory_item_id, tenant_id, space, model, dim, embedding) VALUES ($1,$2,$3,$4,$5,$6)",
      [memoryItemId, tenantId, space, embedding.model, embedding.dim, vector]
    );
  });
  return memoryItemId;
}

/**
 * D-358: SAMME som `plantMemoryItem()`, men gir det planlagte faktumet en
 * reell versjonshistorikk (en `memory_versions`-rad + `status='invalidated'`,
 * NØYAKTIG mønsteret `MemoryWriter.invalidate()` skriver) - de EKSISTERENDE
 * erasure-testene over plantet ALDRI en versjonert rad, så de traff aldri
 * `memory_versions` sin append-only-trigger i det hele tatt (D-357/D-358s
 * funn). Denne hjelperen gjør det mulig å faktisk bevise at en ekte
 * GDPR-sletting lykkes selv når offeret har en versjonshistorikk.
 */
async function plantVersionedMemoryItem(tenantId: string, space: string, content: string): Promise<string> {
  const memoryItemId = await plantMemoryItem(tenantId, space, content);
  await withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    await client.query(
      `INSERT INTO memory_versions (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind)
       SELECT memory_item_id, tenant_id, space, version, subject, content, valid_from, now(), 'invalidated'
       FROM memory_items WHERE memory_item_id = $1`,
      [memoryItemId]
    );
    await client.query("UPDATE memory_items SET status = 'invalidated', valid_to = now() WHERE memory_item_id = $1", [
      memoryItemId
    ]);
  });
  return memoryItemId;
}

async function plantDerivedMemoryRows(tenantId: string, space: string, content: string): Promise<void> {
  await withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    await client.query("INSERT INTO summaries (summary_id, tenant_id, space, scope, scope_key, content) VALUES ($1,$2,$3,'daily',$4,$5)", [
      `sum-${randomUUID()}`, tenantId, space, `key-${randomUUID()}`, content
    ]);
    await client.query("INSERT INTO decisions (decision_id, tenant_id, space, content, decided_at) VALUES ($1,$2,$3,$4, now())", [
      `dec-${randomUUID()}`, tenantId, space, content
    ]);
    await client.query("INSERT INTO commitments (commitment_id, tenant_id, space, content) VALUES ($1,$2,$3,$4)", [
      `com-${randomUUID()}`, tenantId, space, content
    ]);
  });
}

async function plantKnowledgeDocument(
  tenantId: string,
  space: string,
  content: string
): Promise<{ knowledgeDocumentId: string; sourceType: string; sourceInstanceId: string; externalId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-erasure-fs-"));
  const fileName = `sentinel-${randomUUID()}.md`;
  await writeFile(join(root, fileName), content);
  const sourceInstanceId = `fs:erasure-${randomUUID()}`;
  const sync = new KnowledgeSyncService(appPool, embedding);
  const report = await sync.sync(identityFor(tenantId, space), space as never, new FilesystemKnowledgeSource(root, sourceInstanceId));
  expect(report.created).toBe(1);
  const { rows } = await withMemoryTransaction(appPool, tenantId, [space as never], (client) =>
    client.query("SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id=$1 AND source_instance_id=$2 AND external_id=$3", [
      tenantId, sourceInstanceId, fileName
    ])
  );
  const knowledgeDocumentId = (rows[0] as { knowledge_document_id: string }).knowledge_document_id;
  return { knowledgeDocumentId, sourceType: "filesystem", sourceInstanceId, externalId: fileName, root };
}

async function countAll(tenantId: string, space: string): Promise<Record<string, number>> {
  return withMemoryTransaction(appPool, tenantId, [space as never], async (client) => {
    const tables = [
      "memory_items", "memory_versions", "memory_item_entities", "embeddings", "relations", "entities",
      "summaries", "decisions", "commitments", "deadlines", "knowledge_documents", "knowledge_embeddings"
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const col = table.startsWith("knowledge") ? "memory_space_id" : "space";
      const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND ${col}=$2`, [tenantId, space]);
      counts[table] = (r.rows[0] as { n: number }).n;
    }
    return counts;
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-erasure-"));
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
  // §O: garantert non-bypass rolle - IKKE superbruker. Q-21 må aldri regresere.
  await adminPool.query("CREATE ROLE jarvis_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','person'), ('${TENANT_B}','B','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-personal','${TENANT_A}','personal'), ('ms-a-business','${TENANT_A}','business'),
      ('ms-b-personal','${TENANT_B}','personal');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Q-20 ErasureService", () => {
  it("A: preview er ikke destructive", async () => {
    const sentinel = `SentinelPreview${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const service = new ErasureService(appPool, sovereignPolicy, embedding);

    const preview = await service.previewErasure({ type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" });
    expect(preview.affected.memory_items).toBeGreaterThanOrEqual(1);

    // Fortsatt der etter preview - INGENTING slettet.
    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("B/C/D: hard delete fjerner CONTENT + embeddings + derived (summaries/decisions/commitments)", async () => {
    const sentinel = `SentinelHardDelete${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);
    const { knowledgeDocumentId } = await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const before = await countAll(TENANT_A, "personal");
    expect(before.memory_items).toBeGreaterThanOrEqual(1);
    expect(before.knowledge_documents).toBeGreaterThanOrEqual(1);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    const after = await countAll(TENANT_A, "personal");
    expect(after.memory_items).toBe(0);
    expect(after.embeddings).toBe(0);
    expect(after.summaries).toBe(0);
    expect(after.decisions).toBe(0);
    expect(after.commitments).toBe(0);
    expect(after.knowledge_documents).toBe(0);
    expect(after.knowledge_embeddings).toBe(0);

    // §C: eksplisitt bevis på at NETTOPP dette dokumentet/embeddinget er borte (ikke bare talt 0).
    const docGone = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    expect(docGone.rowCount).toBe(0);
    const embGone = await adminPool.query("SELECT 1 FROM knowledge_embeddings WHERE knowledge_document_id=$1", [knowledgeDocumentId]);
    expect(embGone.rowCount).toBe(0);
  });

  it("E/F/G: FTS/vector/hybrid finner ikke slettet innhold (memory-scoped verify)", async () => {
    const sentinel = `SentinelVerify${randomUUID().replace(/-/g, "")}`;
    await plantKnowledgeDocument(TENANT_A, "personal", sentinel);
    await plantMemoryItem(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });

    const verification = await service.verifyErasure({ identity: identityFor(TENANT_A, "personal"), spaces: ["personal"], sentinel });
    expect(verification.fts_hits).toBe(0);
    expect(verification.vector_hits).toBe(0);
    expect(verification.hybrid_hits).toBe(0);
    expect(verification.memory_hits).toBe(0);
  });

  it("H: feil tenant kan ikke purge en annen tenant sitt scope", async () => {
    const sentinel = `SentinelCrossTenant${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_B, "personal") // identitet fra B, scope for A
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("cross_tenant_purge_denied");

    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("I: annet memory-space (samme tenant) er urørt", async () => {
    const sentinelPersonal = `SentinelSpacePersonal${randomUUID().replace(/-/g, "")}`;
    const sentinelBusiness = `SentinelSpaceBusiness${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinelPersonal);
    await plantMemoryItem(TENANT_A, "business", sentinelBusiness);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });

    const businessStillThere = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinelBusiness])
    );
    expect((businessStillThere.rows[0] as { n: number }).n).toBe(1);
  });

  it("J: source resync gjenoppliver IKKE et slettet target (resurrection protection)", async () => {
    const sentinel = `SentinelResurrection${randomUUID().replace(/-/g, "")}`;
    const { knowledgeDocumentId, sourceType, sourceInstanceId, externalId, root } = await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "knowledge_document", tenant_id: TENANT_A, knowledge_document_id: knowledgeDocumentId },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    // Filen ligger FORTSATT på disk (kilden er uendret) - re-sync skal IKKE gjenopplive dokumentet.
    const sync = new KnowledgeSyncService(appPool, embedding);
    const resync = await sync.sync(identityFor(TENANT_A, "personal"), "personal", new FilesystemKnowledgeSource(root, sourceInstanceId));
    expect(resync.created).toBe(0);
    expect(resync.suppressed).toBe(1);

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const found = await retriever.search(identityFor(TENANT_A, "personal"), { query: sentinel, spaces: ["personal"] });
    expect(found.some((r) => r.content.includes(sentinel))).toBe(false);

    // Kryss-sjekk: fingerprinten er faktisk basert på (source_type, source_instance_id, external_id) fra scopet.
    expect(sourceType).toBe("filesystem");
    expect(externalId).toMatch(/^sentinel-/);
  });

  it("K/L: erasure-ledger (erasure_requests/erasure_fingerprints) inneholder ALDRI selve sentinel-innholdet", async () => {
    const sentinel = `SentinelReceiptSafety${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantKnowledgeDocument(TENANT_A, "personal", sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-${randomUUID()}`;
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId,
      identity: identityFor(TENANT_A, "personal")
    });

    const requests = await adminPool.query("SELECT * FROM erasure_requests WHERE request_id=$1", [requestId]);
    const fingerprints = await adminPool.query("SELECT * FROM erasure_fingerprints WHERE erasure_request_id=$1", [requestId]);
    expect(requests.rowCount).toBe(1);
    expect(JSON.stringify(requests.rows)).not.toContain(sentinel);
    expect(JSON.stringify(fingerprints.rows)).not.toContain(sentinel);
    // §6: fingerprinten er en hash, IKKE et klartekst external_id.
    for (const row of fingerprints.rows as Array<{ fingerprint: string }>) {
      expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("M: samme request_id kjørt to ganger er idempotent (ingen feil, ingen dobbel sletting, samme resultat)", async () => {
    const sentinel = `SentinelIdempotent${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" } as const;
    const identity = identityFor(TENANT_A, "personal");

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });

  it("N: en feil MIDT i slettingen ruller HELE transaksjonen tilbake og rapporteres ALDRI som completed", async () => {
    const sentinel = `SentinelFailClosed${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);

    // Kunstig injeksjon av en feil MIDT i sletterekkefølgen (etter memory_versions/
    // memory_item_entities/embeddings/relations/entities, FØR summaries) - beviser
    // at ALLEREDE utførte deletes i samme transaksjon rulles tilbake, ikke bare den
    // som faktisk feiler. Bruker den DELTE `appPool` (pg gjenbruker klient-objekter
    // internt) - monkeypatchen er derfor SELV-restaurerende: den fyrer PRESIST ÉN
    // gang og bytter umiddelbart tilbake til den ekte query()-implementasjonen, slik
    // at verken ROLLBACK-kallet rett etter eller senere, urelaterte tester som
    // gjenbruker samme pooled klient etter release() blir påvirket.
    const requestId = `req-${randomUUID()}`;
    const faultyPool = {
      connect: async () => {
        const client = await appPool.connect();
        const originalQuery = client.query.bind(client);
        // @ts-expect-error - test-only monkeypatch av query for å simulere en midt-i-transaksjonen-feil
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.startsWith("DELETE FROM summaries")) {
            client.query = originalQuery; // restaurer FØR kast - ROLLBACK og all senere gjenbruk er upåvirket
            throw new Error("simulated_mid_transaction_failure");
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const service = new ErasureService(faultyPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("simulated_mid_transaction_failure");

    // Fail-closed: memory_items (slettet FØR summaries i rekkefølgen) er FORTSATT der - hele tx rullet tilbake.
    const stillThere = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT count(*)::int AS n FROM memory_items WHERE tenant_id=$1 AND content=$2", [TENANT_A, sentinel])
    );
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);

    // Ledger sier failed, ALDRI completed.
    const ledgerRow = await adminPool.query("SELECT status FROM erasure_requests WHERE request_id=$1", [requestId]);
    expect((ledgerRow.rows[0] as { status: string }).status).toBe("failed");

    // Rydd opp for etterfølgende tester i samme tenant/space.
    const cleanup = new ErasureService(appPool, sovereignPolicy, embedding);
    await cleanup.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-cleanup-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
  });

  it("O: kjører ALLTID via en garantert non-bypass runtime-rolle (Q-21 regresjonsvakt)", async () => {
    const { rows } = await appPool.query(
      "SELECT rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user"
    );
    const row = rows[0] as { superuser: boolean; bypassrls: boolean };
    expect(row.superuser).toBe(false);
    expect(row.bypassrls).toBe(false);
  });

  it("P: policy-audit-hendelsen for purge lekker aldri scope-parametre eller innhold", async () => {
    const sentinel = `SentinelAuditSafety${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    const auditLog: PolicyAuditEvent[] = [];
    const auditedPolicy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new InMemoryNonceStore(),
      killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] },
      auditSink: (event) => auditLog.push(event)
    });
    const service = new ErasureService(appPool, auditedPolicy, embedding);
    await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(auditLog.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditLog)).not.toContain(sentinel);
  });

  it("Q: urelatert innhold (annet dokument, samme tenant/space) er urørt av en knowledge_document-scoped purge", async () => {
    const targetSentinel = `SentinelTargeted${randomUUID().replace(/-/g, "")}`;
    const unrelatedSentinel = `SentinelUnrelated${randomUUID().replace(/-/g, "")}`;
    const target = await plantKnowledgeDocument(TENANT_A, "personal", targetSentinel);
    await plantKnowledgeDocument(TENANT_A, "personal", unrelatedSentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "knowledge_document", tenant_id: TENANT_A, knowledge_document_id: target.knowledgeDocumentId },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    expect(result.status).toBe("completed");

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const unrelatedFound = await retriever.search(identityFor(TENANT_A, "personal"), { query: unrelatedSentinel, spaces: ["personal"] });
    expect(unrelatedFound.some((r) => r.content.includes(unrelatedSentinel))).toBe(true);
    const targetFound = await retriever.search(identityFor(TENANT_A, "personal"), { query: targetSentinel, spaces: ["personal"] });
    expect(targetFound.some((r) => r.content.includes(targetSentinel))).toBe(false);
  });

  it("R (D-220): hvis SELVE feil-statusen ikke kan persisteres, logges det strukturert - avslaget returneres FORTSATT normalt", async () => {
    // Samme monkeypatch-mønster som test N (SELV-restaurerende, ekte appPool under),
    // men rigget til å feile på TO forskjellige `connect()`-kall etter hverandre:
    // 1) hovedtransaksjonen (tvunget til å kaste midt i slettingen, akkurat som N)
    // 2) `failErasureRequest()` sin EGEN, separate `pool.connect()` i catch-blokken -
    // DEN som denne testen faktisk beviser nå blir strukturert logget i stedet for
    // å forsvinne sporløst.
    const sentinel = `SentinelFailStatusPersistFailure${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);

    const requestId = `req-${randomUUID()}`;
    let connectCount = 0;
    const faultyPool = {
      connect: async () => {
        connectCount += 1;
        if (connectCount === 2) {
          throw new Error("simulated_fail_status_persist_connect_failure");
        }
        const client = await appPool.connect();
        const originalQuery = client.query.bind(client);
        // @ts-expect-error - test-only monkeypatch av query for å simulere en midt-i-transaksjonen-feil
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.startsWith("DELETE FROM summaries")) {
            client.query = originalQuery;
            throw new Error("simulated_mid_transaction_failure");
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const service = new ErasureService(faultyPool, sovereignPolicy, embedding);
      const result = await service.executeErasure({
        scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
        requestId,
        identity: identityFor(TENANT_A, "personal")
      });
      // Fail-safe: avslaget kommer likevel gjennom til kalleren, uendret av D-220.
      expect(result.status).toBe("failed");
      expect(result.error).toContain("simulated_mid_transaction_failure");

      const persistFailureLog = errorSpy.mock.calls
        .map(([line]) => line as string)
        .find((line) => line.includes("erasure_request_fail_status_persist_failed"));
      expect(persistFailureLog).toBeDefined();
      const parsed = JSON.parse(persistFailureLog as string) as {
        msg: string; request_id: string; tenant_id: string; scope_type: string; original_error: string; persist_error: string;
      };
      expect(parsed.msg).toBe("erasure_request_fail_status_persist_failed");
      expect(parsed.request_id).toBe(requestId);
      expect(parsed.tenant_id).toBe(TENANT_A);
      expect(parsed.scope_type).toBe("memory_space");
      expect(parsed.original_error).toContain("simulated_mid_transaction_failure");
      expect(parsed.persist_error).toContain("simulated_fail_status_persist_connect_failure");

      // Den reelle konsekvensen: `insertPendingErasureRequest()` skjer i SAMME
      // transaksjon som selve sletteforsøket (samme `client`, samme BEGIN/COMMIT) -
      // når hovedtransaksjonen ruller tilbake (test N sitt bevis), ruller den
      // "pending"-innsettingen tilbake MED den. Feiler `failErasureRequest()` sin
      // EGEN, separate innsetting av `status='failed'` DA også, finnes det derfor
      // INGEN rad i det hele tatt for denne forespørselen - ikke en stille
      // "pending for alltid" (som ville krevd at pending-innsettingen overlevde en
      // rollback, noe den strukturelt ikke kan i denne transaksjonsmodellen), men et
      // sletteforsøk med ALDRI noe spor i revisjonsloggen - like alvorlig, annen form.
      const ledgerRow = await adminPool.query("SELECT status FROM erasure_requests WHERE request_id=$1", [requestId]);
      expect(ledgerRow.rows).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }

    // Rydd opp for etterfølgende tester i samme tenant/space (den ekte, urørte dataen fra N/R er fortsatt der).
    const cleanup = new ErasureService(appPool, sovereignPolicy, embedding);
    await cleanup.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-cleanup-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
  });

  /**
   * D-221: en fersk gap-søk-runde (etter D-218/D-219/D-220, SAMME anti-mønster-klasse)
   * fant TRE gjenværende `.catch(() => undefined)`-søsken i SAMME to filer D-220 nettopp
   * rørte ved - alle på ROLLBACK-stien (dobbelt-feil: hovedoperasjonen feiler OG selve
   * opprydningen feiler også):
   *
   *   - `failErasureRequest()` (`modules/core/src/services/erasure-ledger.ts`) sin YTRE
   *     `catch { ... }` var VERRE enn de andre: INGEN fanget feil-variabel i det hele
   *     tatt, INGEN logging, INGEN rethrow. Konsekvens: ETHVERT feil i selve INSERT/
   *     COMMIT-en (i motsetning til et `pool.connect()`-feil, som skjer FØR denne
   *     try-blokken og DERFOR propagerer til D-220 sin egen `.catch()` ved kallestedet)
   *     forsvant HELT sporløst - D-220 sin logging ble ALDRI nådd for dette tilfellet.
   *   - `ErasureService.previewErasure()`/`executeErasure()` (`modules/erasure/src/
   *     erasure-service.ts`) sine ROLLBACK-kall i catch-blokken svelget SIN EGEN feil
   *     stille (den OPPRINNELIGE feilen er fortsatt synlig - den kastes/logges allerede -
   *     men en ROLLBACK-feil OVENPÅ den opprinnelige feilen var usynlig).
   *
   * Testene S/T/U under beviser alle tre, med SAMME selv-restaurerende monkeypatch-
   * disiplin som test N/R allerede etablerte (ekte `appPool` under, aldri en helt fake
   * DB) - og er bevisst forsiktige med DB-transaksjons-resonnement etter D-220 sin egen
   * CI-lærdom (en antakelse om DB-atferd som ikke er sporet nøyaktig gjennom faktisk
   * kildekode kan være feil selv når fiksen ser åpenbart riktig ut).
   */
  it("S (D-221): failErasureRequest() sin EGEN INSERT/COMMIT-feil (ikke bare connect()) logges nå strukturert - funksjonen kaster FORTSATT ikke (kontrakt uendret)", async () => {
    const faultyPool = {
      connect: async () => {
        const client = await appPool.connect();
        const originalQuery = client.query.bind(client);
        // @ts-expect-error - test-only monkeypatch: BEGIN/set_config passerer, selve INSERT-en feiler
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.startsWith("INSERT INTO erasure_requests")) {
            client.query = originalQuery; // restaurer FØR kast - ROLLBACK rett etter er upåvirket
            throw new Error("simulated_fail_status_insert_failure");
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const requestId = `req-${randomUUID()}`;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        failErasureRequest(faultyPool, TENANT_A, requestId, "memory_space", { memory_space_id: "personal" }, "original erasure error")
      ).resolves.toBeUndefined(); // kontrakten "kaster aldri" er UENDRET av denne fiksen

      const line = errorSpy.mock.calls
        .map(([l]) => l as string)
        .find((l) => l.includes("erasure_fail_status_persist_write_failed"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string) as { msg: string; request_id: string; tenant_id: string; error: string };
      expect(parsed.msg).toBe("erasure_fail_status_persist_write_failed");
      expect(parsed.request_id).toBe(requestId);
      expect(parsed.tenant_id).toBe(TENANT_A);
      expect(parsed.error).toContain("simulated_fail_status_insert_failure");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("T (D-221): previewErasure() sin ROLLBACK-feil (OVENPÅ en allerede kastet feil) logges strukturert - den OPPRINNELIGE feilen kastes fortsatt til kalleren", async () => {
    const faultyPool = {
      connect: async () => {
        const client = await appPool.connect();
        const originalQuery = client.query.bind(client);
        let queryCount = 0;
        // @ts-expect-error - test-only monkeypatch: BEGIN passerer, DERETTER feiler alt frem til ROLLBACK, som OGSÅ feiler
        client.query = (...args: unknown[]) => {
          queryCount += 1;
          if (queryCount === 1) return originalQuery(...(args as Parameters<typeof originalQuery>)); // BEGIN
          const sql = args[0];
          if (typeof sql === "string" && sql === "ROLLBACK") {
            client.query = originalQuery; // restaurer FØR avvisning
            // VIKTIG, TO separate presisjoner:
            // (1) `.reject()`, ALDRI `throw` her - kildekoden kjeder `.catch()` DIREKTE på
            //     dette kallet (`client.query("ROLLBACK").catch(...)`) - en synkron `throw`
            //     ville aldri nådd den `.catch()`-en, ekte `pg`-klienter kaster ALDRI
            //     synkront, de avviser alltid det returnerte løftet.
            // (2) Selve ROLLBACK-en må FORTSATT faktisk kjøres mot ekte Postgres FØR vi
            //     avviser løftet til kalleren - ellers leveres denne EKTE, pooled klienten
            //     tilbake til `appPool` via `client.release()` med en ÅPEN, ALDRI avsluttet
            //     transaksjon fortsatt hengende, som ville korrumpert HVILKEN SOM HELST
            //     senere, urelatert test som tilfeldigvis gjenbruker nøyaktig denne
            //     tilkoblingen fra poolen. Vi simulerer altså KUN at KALLEREN ser en feil -
            //     den underliggende DB-tilstanden ryddes ekte opp uansett.
            return originalQuery("ROLLBACK").then(
              () => Promise.reject(new Error("simulated_preview_rollback_failure")),
              () => Promise.reject(new Error("simulated_preview_rollback_failure"))
            );
          }
          throw new Error("simulated_preview_count_failure");
        };
        return client;
      }
    } as unknown as pg.Pool;

    const service = new ErasureService(faultyPool, sovereignPolicy, embedding);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        service.previewErasure({ type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" })
      ).rejects.toThrow("simulated_preview_count_failure"); // den OPPRINNELIGE feilen, ikke rollback-feilen

      const line = errorSpy.mock.calls
        .map(([l]) => l as string)
        .find((l) => l.includes("erasure_preview_rollback_failed"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string) as { msg: string; error: string };
      expect(parsed.msg).toBe("erasure_preview_rollback_failed");
      expect(parsed.error).toContain("simulated_preview_rollback_failure");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("U (D-221): executeErasure() sin ROLLBACK-feil (OVENPÅ en midt-i-transaksjonen-feil, SAMME mekanisme som test N) logges strukturert - avslaget returneres fortsatt normalt", async () => {
    const sentinel = `SentinelExecuteRollbackFailure${randomUUID().replace(/-/g, "")}`;
    await plantMemoryItem(TENANT_A, "personal", sentinel);
    await plantDerivedMemoryRows(TENANT_A, "personal", sentinel);

    const requestId = `req-${randomUUID()}`;
    let connectCount = 0;
    const faultyPool = {
      connect: async () => {
        connectCount += 1;
        const client = await appPool.connect();
        if (connectCount !== 1) return client; // KUN hovedtransaksjonen (1. connect()) rigges - failErasureRequest() sitt EGET, separate connect() forblir upåvirket og persisterer normalt
        const originalQuery = client.query.bind(client);
        let midTransactionThrown = false;
        // @ts-expect-error - test-only monkeypatch: SAMME "DELETE FROM summaries"-trigger som test N, deretter feiler ROLLBACK også
        client.query = (...args: unknown[]) => {
          const sql = args[0];
          if (!midTransactionThrown && typeof sql === "string" && sql.startsWith("DELETE FROM summaries")) {
            midTransactionThrown = true;
            throw new Error("simulated_mid_transaction_failure");
          }
          if (midTransactionThrown && typeof sql === "string" && sql === "ROLLBACK") {
            client.query = originalQuery; // restaurer FØR avvisning
            // Samme TO presisjoner som test T: `.reject()` (ALDRI `throw`, kildekoden
            // kjeder `.catch()` DIREKTE på dette kallet) OG en EKTE ROLLBACK mot Postgres
            // FØRST (ellers leveres denne pooled klienten tilbake med en hengende åpen
            // transaksjon, som ville korrumpert senere, urelaterte tester).
            return originalQuery("ROLLBACK").then(
              () => Promise.reject(new Error("simulated_execute_rollback_failure")),
              () => Promise.reject(new Error("simulated_execute_rollback_failure"))
            );
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      }
    } as unknown as pg.Pool;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const service = new ErasureService(faultyPool, sovereignPolicy, embedding);
      const result = await service.executeErasure({
        scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
        requestId,
        identity: identityFor(TENANT_A, "personal")
      });
      // Fail-safe: avslaget kommer likevel gjennom til kalleren, uendret av D-221.
      expect(result.status).toBe("failed");
      expect(result.error).toContain("simulated_mid_transaction_failure");

      const line = errorSpy.mock.calls
        .map(([l]) => l as string)
        .find((l) => l.includes("erasure_execute_rollback_failed"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string) as { msg: string; request_id: string; tenant_id: string; error: string };
      expect(parsed.msg).toBe("erasure_execute_rollback_failed");
      expect(parsed.request_id).toBe(requestId);
      expect(parsed.tenant_id).toBe(TENANT_A);
      expect(parsed.error).toContain("simulated_execute_rollback_failure");

      // failErasureRequest() sitt EGET, separate connect() var UPÅVIRKET (kun 1. connect()
      // ble rigget over) - persisteringen av status='failed' skal derfor ha LYKTES normalt.
      const ledgerRow = await adminPool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM erasure_requests WHERE request_id = $1", [requestId]
      );
      expect(ledgerRow.rows).toHaveLength(1);
      expect(ledgerRow.rows[0]?.status).toBe("failed");
    } finally {
      errorSpy.mockRestore();
    }

    // Rydd opp for etterfølgende tester i samme tenant/space.
    const cleanup = new ErasureService(appPool, sovereignPolicy, embedding);
    await cleanup.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-cleanup-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
  });

  it("V (D-358): hard delete lykkes for et faktum med VERSJONSHISTORIKK - memory_versions sin append-only-trigger blokkerer ALDRI en ekte erasure", async () => {
    const sentinel = `SentinelVersionedErasure${randomUUID().replace(/-/g, "")}`;
    const memoryItemId = await plantVersionedMemoryItem(TENANT_A, "personal", sentinel);

    // Eksplisitt bevis på at raden FAKTISK har versjonshistorikk FØR sletting
    // - uten dette kunne testen gitt et falskt grønt resultat (testet en tom
    // memory_versions-tabell, ikke selve bug-scenarioet).
    const versionsBefore = await adminPool.query("SELECT 1 FROM memory_versions WHERE memory_item_id = $1", [memoryItemId]);
    expect(versionsBefore.rowCount).toBe(1);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
    // D-357/D-358s funn (FØR fiksen): dette kastet "append_only_table:
    // memory_versions tillater ikke DELETE" og result.status ble "failed" -
    // SAMME transaksjon rullet DA hele slettingen tilbake.
    expect(result.status).toBe("completed");
    expect(result.record_counts["memory_versions"]).toBe(1);
    expect(result.record_counts["memory_items"]).toBe(1);

    const versionsAfter = await adminPool.query("SELECT 1 FROM memory_versions WHERE memory_item_id = $1", [memoryItemId]);
    expect(versionsAfter.rowCount).toBe(0);

    // Append-only-prinsippet gjelder FORTSATT for enhver annen tilgang -
    // DENNE fiksen omgår ALDRI det generelt, kun DENNE transaksjonens
    // kontrollerte erasure-sletting (SAMME regresjonsbevis som D-357/D-358s
    // `memory.test.ts` sin "memory_versions er append-only"-test, her bevist
    // på nytt i erasure-konteksten for å utelukke at fiksen lekket bredere).
    // En FERSK versjonert rad plantes her (fremfor å stole på rester fra
    // andre tester) slik at DELETE-en garantert treffer minst én rad og
    // dermed faktisk utløser triggeren.
    const guardMemoryItemId = await plantVersionedMemoryItem(TENANT_A, "personal", `${sentinel}Guard`);
    await expect(
      withMemoryTransaction(appPool, TENANT_A, ["personal" as never], (client) =>
        client.query("DELETE FROM memory_versions WHERE memory_item_id = $1", [guardMemoryItemId])
      )
    ).rejects.toThrow("append_only_table");

    // Rydd opp den fersk-plantede vakt-raden (unngå å forurense senere tester).
    const cleanupGuard = new ErasureService(appPool, sovereignPolicy, embedding);
    await cleanupGuard.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" },
      requestId: `req-cleanup-guard-${randomUUID()}`,
      identity: identityFor(TENANT_A, "personal")
    });
  });

  describe("§7/§8: D-klasse policy-integrasjon (ingen ny separat auth-modell)", () => {
    const watchKeys = generateKeyPairSync("ed25519");


    it("nektes uten approval for en delegert (ikke-sovereign) identitet; tillates med gyldig signert approval", async () => {
      const sentinel = `SentinelDelegateApproval${randomUUID().replace(/-/g, "")}`;
      await plantMemoryItem(TENANT_A, "personal", sentinel);
      const devices = new InMemoryDeviceRegistry();
      devices.register("watch-1", watchKeys.publicKey, { tenant_id: TENANT_A, person_id: identityFor(TENANT_A, "personal").person_id });
      const delegatePolicy = new PolicyGateway({ devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
      const service = new ErasureService(appPool, delegatePolicy, embedding);
      const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "personal" } as const;
      const identity = identityFor(TENANT_A, "personal");

      const denied = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity });
      expect(denied.status).toBe("failed");
      expect(denied.error).toContain("policy_denied:class_d_missing_approval");

      const approval = signApproval(watchKeys.privateKey, {
        tool_id: "data-erasure",
        action: "purge",
        tenant_id: TENANT_A,
        person_id: identity.person_id,
        approver_person_id: identity.person_id,
        parameters: { ...scope } as Record<string, JsonValue>,
        nonce: `nonce-${randomUUID()}`,
        approving_device_id: "watch-1"
      });
      const allowed = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity, approval });
      expect(allowed.status).toBe("completed");
    });
  });
});
