import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, MessageStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  LocalHashEmbedding,
  MemoryExporter,
  MemoryRetriever,
  MemoryWriter,
  RuleBasedExtractor,
  SummaryService,
  withMemoryTransaction,
  type SourceRef
} from "@jarvis/memory";

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let writer: MemoryWriter;
let retriever: MemoryRetriever;
let policy: PolicyGateway;

const TRUSTED: SourceRef = { kind: "manual", ref: "seed", trust: "internal" };
const UNTRUSTED: SourceRef = { kind: "document", ref: "ukjent-epost", trust: "untrusted" };

function identity(space: MemorySpace, tenant = "tenant-a", person = "person-tobias"): IdentityContext {
  return {
    person_id: person,
    tenant_id: tenant,
    memory_space_id: space,
    session_id: "sess-mem",
    device_id: "dev-pc",
    channel: "web",
    auth_strength: "active"
  };
}

function candidate(space: MemorySpace, subject: string, content: string, observedAt?: string) {
  return {
    space,
    type: "semantic" as const,
    subject,
    content,
    confidence: 0.9,
    ...(observedAt ? { observed_at: observedAt } : {})
  };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg4-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({
    databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false
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
      ('tenant-a', 'Tobias personlig', 'person'), ('tenant-b', 'Kundeoppfoelging AS', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES
      ('person-tobias', 'tenant-a'), ('person-tobias', 'tenant-b');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES
      ('dev-pc', 'tenant-a', 'person-tobias', 'pc');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id, status) VALUES
      ('sess-mem', 'tenant-a', 'person-tobias', 'web', 'dev-pc', 'active'),
      ('sess-ny-okt', 'tenant-a', 'person-tobias', 'web', 'dev-pc', 'closed');
  `);
  appPool = createPool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw"
  });
  const embeddings = new LocalHashEmbedding();
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch()
  });
  writer = new MemoryWriter(appPool, embeddings, new RuleBasedExtractor(), policy);
  retriever = new MemoryRetriever(appPool, embeddings);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Skriveflyt: ADD/UPDATE/NOOP/INVALIDATE med versjonering", () => {
  it("ADD → NOOP på likt innhold → UPDATE versjonerer gammel sannhet", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.versjon", "Første sannhet omega1."));
    expect(add.op).toBe("ADD");
    const noop = await writer.apply(id, TRUSTED, candidate("personal", "test.versjon", "første sannhet omega1."));
    expect(noop.op).toBe("NOOP");
    const update = await writer.apply(id, TRUSTED, candidate("personal", "test.versjon", "Ny sannhet omega1."));
    expect(update.op).toBe("UPDATE");
    expect((update as { version: number }).version).toBe(2);

    const results = await retriever.search(id, { spaces: ["personal"], query: "omega1" });
    const item = results.find((r) => r.subject === "test.versjon");
    expect(item?.content).toBe("Ny sannhet omega1.");
    expect(item?.has_conflict).toBe(true);
    expect(item?.versions?.map((v) => v.content)).toContain("Første sannhet omega1.");
  });

  it("INVALIDATE fjerner fra retrieval men bevarer historikk", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.invalid", "Utgått fakta sigma1."));
    await writer.invalidate(id, "personal", add.memory_item_id, "test");
    const results = await retriever.search(id, { spaces: ["personal"], query: "sigma1" });
    expect(results.find((r) => r.memory_item_id === add.memory_item_id)).toBeUndefined();
    const versions = await withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) =>
      c.query("SELECT change_kind FROM memory_versions WHERE memory_item_id = $1", [add.memory_item_id])
    );
    expect(versions.rows[0]).toEqual({ change_kind: "invalidated" });
  });

  it("memory_versions er append-only i databasen", async () => {
    await expect(
      withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) => c.query("DELETE FROM memory_versions"))
    ).rejects.toThrow();
  });
});

/**
 * D-357 (funn ved kildekode-gjennomgang av `memory-writer.ts`, IKKE en ny
 * Tobias-rapport): `apply()` sitt eksisterende-rad-oppslag ekskluderte
 * `status='invalidated'` - en tidligere invalidert rad (f.eks. D-287 sin
 * 60-dagers retensjons-sveip) var derfor usynlig for oppslaget, og et forsøk
 * på å lære det SAMME faktumet (samme tenant/space/type/subject) på nytt
 * traff `memory_items` sin `UNIQUE (tenant_id, space, type, subject)`-
 * begrensning i `insertItem()` og kastet - en feil som ble SVELGET stille av
 * `ConversationEngine` sitt fire-and-forget `memory.ingest()`-kall (D-283),
 * så det observerbare symptomet var "dette faktumet kan ALDRI læres på
 * nytt" - samme symptomklasse som D-300 ("husker ingenting"), en ANNEN,
 * uavhengig rotårsak.
 */
describe("D-357: et invalidert faktum kan læres på nytt (gjenoppliving, ikke en UNIQUE-krasj)", () => {
  it("TRUSTED gjenoppliving av et invalidert faktum -> UPDATE (ikke ADD/krasj), status active igjen, synlig i retrieval", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.gjenopplivet", "Første sannhet tau1."));
    await writer.invalidate(id, "personal", add.memory_item_id, "test-utgått");
    let results = await retriever.search(id, { spaces: ["personal"], query: "tau1" });
    expect(results).toHaveLength(0);

    const revived = await writer.apply(id, TRUSTED, candidate("personal", "test.gjenopplivet", "Faktumet er sant igjen tau1."));
    expect(revived.op).toBe("UPDATE");
    expect(revived.memory_item_id).toBe(add.memory_item_id);

    results = await retriever.search(id, { spaces: ["personal"], query: "tau1" });
    const item = results.find((r) => r.memory_item_id === add.memory_item_id);
    expect(item?.content).toBe("Faktumet er sant igjen tau1.");
  });

  it("gjenoppliving med IDENTISK innhold som det invaliderte er IKKE et stille NOOP - status blir active igjen", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.identisk-gjenopplivet", "Uendret sannhet ypsilon1."));
    await writer.invalidate(id, "personal", add.memory_item_id, "test-utgått");

    const revived = await writer.apply(id, TRUSTED, candidate("personal", "test.identisk-gjenopplivet", "Uendret sannhet ypsilon1."));
    expect(revived.op).toBe("UPDATE");

    const results = await retriever.search(id, { spaces: ["personal"], query: "ypsilon1" });
    expect(results.find((r) => r.memory_item_id === add.memory_item_id)).toBeDefined();
  });

  it("UNTRUSTED gjenoppliving av et invalidert faktum blir quarantined (SAMME regel som et helt nytt untrusted faktum), IKKE synlig før eksplisitt promotering", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.untrusted-gjenopplivet", "Sannhet phi1."));
    await writer.invalidate(id, "personal", add.memory_item_id, "test-utgått");

    const revived = await writer.apply(id, UNTRUSTED, candidate("personal", "test.untrusted-gjenopplivet", "Ubetrodd påstand phi1."));
    expect(revived.op).toBe("UPDATE");
    let results = await retriever.search(id, { spaces: ["personal"], query: "phi1" });
    expect(results.find((r) => r.memory_item_id === add.memory_item_id)).toBeUndefined();

    expect(await writer.promoteFromQuarantine(id, "personal", add.memory_item_id)).toBe(true);
    results = await retriever.search(id, { spaces: ["personal"], query: "phi1" });
    expect(results.find((r) => r.memory_item_id === add.memory_item_id)?.content).toBe("Ubetrodd påstand phi1.");
  });

  it("en gjenopplivet rad sin gamle invaliderte tilstand forblir bevart i memory_versions (append-only historikk, aldri skjult)", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, TRUSTED, candidate("personal", "test.historikk-bevart", "Original sannhet chi1."));
    await writer.invalidate(id, "personal", add.memory_item_id, "test-utgått");
    await writer.apply(id, TRUSTED, candidate("personal", "test.historikk-bevart", "Ny sannhet chi1."));

    const versions = await withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) =>
      c.query("SELECT change_kind, content FROM memory_versions WHERE memory_item_id = $1 ORDER BY valid_to", [
        add.memory_item_id
      ])
    );
    expect(versions.rows).toEqual([
      { change_kind: "invalidated", content: "Original sannhet chi1." },
      { change_kind: "superseded", content: "Original sannhet chi1." }
    ]);
  });
});

describe("Akseptanse 3: karantene for ubetrodd innhold", () => {
  it("untrusted kilde → karantene, ikke i retrieval; promotering krever policy-godkjenning", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, UNTRUSTED, candidate("personal", "test.karantene", "Ubetrodd påstand kappa1."));
    expect(add.op).toBe("ADD");
    expect((add as { status: string }).status).toBe("quarantined");

    let results = await retriever.search(id, { spaces: ["personal"], query: "kappa1" });
    expect(results).toHaveLength(0);

    // Promotering med for svak auth (passiv) => policy DENY => fortsatt karantene
    const weak = { ...id, auth_strength: "passive" as const };
    expect(await writer.promoteFromQuarantine(weak, "personal", add.memory_item_id)).toBe(false);
    results = await retriever.search(id, { spaces: ["personal"], query: "kappa1" });
    expect(results).toHaveLength(0);

    // Godkjenningssteg (aktiv auth, klasse B via Policy Gateway) => aktiv
    expect(await writer.promoteFromQuarantine(id, "personal", add.memory_item_id)).toBe(true);
    results = await retriever.search(id, { spaces: ["personal"], query: "kappa1" });
    expect(results.map((r) => r.memory_item_id)).toContain(add.memory_item_id);
  });

  it("untrusted kan aldri overskrive trusted innhold - konflikt karantenesettes", async () => {
    const id = identity("personal");
    const original = await writer.apply(id, TRUSTED, candidate("personal", "test.vern", "Sann verdi lambda1."));
    const attack = await writer.apply(id, UNTRUSTED, candidate("personal", "test.vern", "Falsk verdi lambda1!"));
    expect(attack.op).toBe("QUARANTINED_CONFLICT");

    const results = await retriever.search(id, { spaces: ["personal"], query: "lambda1" });
    const item = results.find((r) => r.memory_item_id === original.memory_item_id);
    expect(item?.content).toBe("Sann verdi lambda1.");
    expect(results.find((r) => r.content.includes("Falsk"))).toBeUndefined();
  });
});

describe("Akseptanse 2: tenant- og space-isolasjon (inkl. health/guest)", () => {
  beforeAll(async () => {
    const spaces: Array<[MemorySpace, string, string]> = [
      ["health", "helse.blodtrykk", "Blodtrykk registrert helsedata1."],
      ["guest", "gjest.notat", "Gjestenotat gjestedata1."],
      ["home", "hjem.varme", "Varmepumpen står på hjemmedata1."]
    ];
    for (const [space, subject, content] of spaces) {
      await writer.apply(identity(space), TRUSTED, candidate(space, subject, content));
    }
    for (let i = 1; i <= 10; i++) {
      await writer.apply(
        identity("business", "tenant-b"), TRUSTED,
        candidate("business", `b.fakta.${i}`, `Bedriftsfakta nummer ${i}: bravo${i} er verdien.`)
      );
    }
  });

  it("space-RLS: personal-kontekst ser aldri health/guest/home-rader (DB-nivå)", async () => {
    const count = await withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) =>
      c.query("SELECT count(*)::int AS n FROM memory_items WHERE space IN ('health','guest','home')")
    );
    expect(count.rows[0].n).toBe(0);
  });

  it("retrieval i personal finner ikke helsedata; health-space (isolert) gjør det", async () => {
    const personal = await retriever.search(identity("personal"), { spaces: ["personal"], query: "helsedata1" });
    expect(personal).toHaveLength(0);
    const health = await retriever.search(identity("health"), { spaces: ["health"], query: "helsedata1" });
    expect(health.length).toBeGreaterThan(0);
  });

  it("health kan aldri kombineres med andre spaces i én retrieval", async () => {
    await expect(
      retriever.search(identity("health"), { spaces: ["health", "personal"], query: "x" })
    ).rejects.toThrow("health_space_must_be_isolated");
  });

  it("kryss-tenant: tenant-a finner aldri tenant-b sine bedriftsfakta", async () => {
    for (const i of [1, 5, 10]) {
      const results = await retriever.search(identity("business", "tenant-a"), {
        spaces: ["business"], query: `bravo${i}`
      });
      expect(results).toHaveLength(0);
    }
    const own = await retriever.search(identity("business", "tenant-b"), { spaces: ["business"], query: "bravo5" });
    expect(own.length).toBeGreaterThan(0);
  });

  it("uten space-kontekst er minnetabellene usynlige (default deny)", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 'tenant-a', true)");
      const result = await client.query("SELECT count(*)::int AS n FROM memory_items");
      expect(result.rows[0].n).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

describe("Akseptanse 1: eval-sett (kilde, tid, motstrid) - 60 spørringer", () => {
  const timeIdentity = identity("personal");

  beforeAll(async () => {
    for (let i = 1; i <= 30; i++) {
      await writer.apply(timeIdentity, TRUSTED,
        candidate("personal", `fakta.${i}`, `Fakta nummer ${i}: alfa${i} er verdien for emne ${i}.`));
    }
    for (let i = 1; i <= 5; i++) {
      await writer.apply(timeIdentity, TRUSTED,
        candidate("personal", `tid.${i}`, `Statusen for tema${i} var gammelverdi${i}.`, "2026-01-01T12:00:00Z"));
      await writer.apply(timeIdentity, TRUSTED,
        candidate("personal", `tid.${i}`, `Statusen for tema${i} er nyverdi${i}.`));
    }
    for (let i = 1; i <= 5; i++) {
      await writer.apply(timeIdentity, TRUSTED,
        candidate("personal", `strid.${i}`, `Første påstand om delta${i}.`));
      await writer.apply(timeIdentity, TRUSTED,
        candidate("personal", `strid.${i}`, `Motstridende påstand om delta${i}.`));
    }
  }, 120_000);

  it("30/30 faktaspørsmål gir riktig svar MED kildeangivelse", async () => {
    let correct = 0;
    for (let i = 1; i <= 30; i++) {
      const results = await retriever.search(timeIdentity, { spaces: ["personal"], query: `alfa${i}` });
      const hit = results.find((r) => r.subject === `fakta.${i}`);
      if (hit && hit.source.kind === "manual" && hit.source.ref === "seed") {
        correct += 1;
      }
    }
    expect(correct).toBe(30);
  });

  it("5/5 tidsspørsmål: timeref bruker valid_from/valid_to og finner historisk sannhet", async () => {
    for (let i = 1; i <= 5; i++) {
      const then = await retriever.search(timeIdentity, {
        spaces: ["personal"], query: `tema${i}`, timeref: new Date("2026-02-01T00:00:00Z")
      });
      expect(then.map((r) => r.content).join(" ")).toContain(`gammelverdi${i}`);
      const now = await retriever.search(timeIdentity, { spaces: ["personal"], query: `tema${i}` });
      const current = now.find((r) => r.subject === `tid.${i}`);
      expect(current?.content).toContain(`nyverdi${i}`);
    }
  });

  it("5/5 motstridsspørsmål: begge versjoner er synlige", async () => {
    for (let i = 1; i <= 5; i++) {
      const results = await retriever.search(timeIdentity, { spaces: ["personal"], query: `delta${i}` });
      const item = results.find((r) => r.subject === `strid.${i}`);
      expect(item?.has_conflict).toBe(true);
      const all = [item?.content, ...(item?.versions?.map((v) => v.content) ?? [])].join(" ");
      expect(all).toContain(`Første påstand om delta${i}`);
      expect(all).toContain(`Motstridende påstand om delta${i}`);
    }
  });

  it("20/20 tilgangsspørsmål: health/guest/kryss-tenant lekker aldri (talt i isolasjonstestene + her)", async () => {
    for (let i = 1; i <= 10; i++) {
      const crossTenant = await retriever.search(identity("business", "tenant-a"), {
        spaces: ["business"], query: `bravo${i}`
      });
      expect(crossTenant).toHaveLength(0);
    }
    for (const query of ["helsedata1", "gjestedata1", "hjemmedata1"]) {
      const leak = await retriever.search(timeIdentity, { spaces: ["personal"], query });
      expect(leak).toHaveLength(0);
    }
  });
});

describe("Ytelse: hybridsøk P95 < 300 ms lokalt", () => {
  beforeAll(async () => {
    for (let i = 1; i <= 200; i++) {
      await writer.apply(identity("personal"), TRUSTED,
        candidate("personal", `fyll.${i}`, `Fyllminne ${i} om ulike temaer som prosjekt, hytte og hus nummer ${i}.`));
    }
  }, 240_000);

  it("20 hybridsøk måles; P95 under 300 ms", async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await retriever.search(identity("personal"), { spaces: ["personal"], query: `hytte nummer ${i * 7}` });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95) - 1] ?? latencies[latencies.length - 1];
    expect(p95).toBeLessThan(300);
  });
});

describe("Sammendrag og eksport (akseptanse 4)", () => {
  it("dagssammendrag genereres og lagres", async () => {
    const summaries = new SummaryService(appPool);
    const content = await summaries.generateDaily(identity("personal"), "personal", new Date().toISOString().slice(0, 10));
    expect(content).toContain("Dagssammendrag");
    const row = await withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) =>
      c.query("SELECT count(*)::int AS n FROM summaries WHERE scope = 'daily'")
    );
    expect(row.rows[0].n).toBeGreaterThan(0);
  });

  it("eksporten genereres komplett fra databasen (inkl. karantenemerking og samtaler)", async () => {
    const messages = new MessageStore(appPool);
    await messages.save(identity("personal"), "user", "Eksporttest-melding chi1.");
    const target = await mkdtemp(join(tmpdir(), "jarvis-export-"));
    const files = await new MemoryExporter(appPool).exportAll(identity("personal"), target);
    expect(files.length).toBeGreaterThan(3);

    const personalMd = await readFile(join(target, "memory", "people", "person-tobias", "personal", "items.md"), "utf8");
    expect(personalMd).toContain("alfa7");
    expect(personalMd).toContain("KARANTENE"); // quarantined vises tydelig merket

    const active = await withMemoryTransaction(appPool, "tenant-a", ["personal"], (c) =>
      c.query("SELECT content FROM memory_items WHERE status = 'active' AND space = 'personal'")
    );
    for (const row of active.rows as Array<{ content: string }>) {
      expect(personalMd).toContain(row.content);
    }

    const conversationFiles = files.filter((f) => f.includes("conversations"));
    expect(conversationFiles.length).toBeGreaterThan(0);
    const conv = await readFile(conversationFiles[0] as string, "utf8");
    expect(conv).toContain("chi1");

    const healthMd = await readFile(join(target, "memory", "people", "person-tobias", "health", "items.md"), "utf8");
    expect(healthMd).toContain("helsedata1");
  });
});

describe("Samtaleintegrasjon: Jarvis husker på tvers av sesjoner med kilde", () => {
  it("modellkallets systemprompt inneholder relevant minne med kildeangivelse", async () => {
    const { ConversationEngine } = await import("../../../apps/api/src/conversation.ts");
    const { ScriptedAdapter } = await import("@jarvis/provider-adapters");
    const { MemoryTraceSink, ModelGateway } = await import("@jarvis/model-gateway");
    const { ContextBuilder } = await import("@jarvis/core");
    const { InProcessWorker, PgTaskQueue, TaskService } = await import("@jarvis/tasks");

    const scripted = new ScriptedAdapter(() => "Svar basert på minnet.");
    const queue = new PgTaskQueue(appPool);
    const engine = new ConversationEngine({
      messages: new MessageStore(appPool),
      context: new ContextBuilder(appPool),
      gateway: new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [scripted] }),
      tasks: new TaskService(appPool, queue, policy),
      worker: new InProcessWorker(queue),
      trace: new MemoryTraceSink(),
      memory: retriever
    });

    const newSession = { ...identity("personal"), session_id: "sess-ny-okt" };
    const reply = await engine.handle(newSession, "Hva er verdien for alfa12?");
    expect(reply.routed).toBe("model");
    const lastCall = scripted.calls[scripted.calls.length - 1];
    expect(lastCall?.system).toContain("Relevant minne");
    expect(lastCall?.system).toContain("alfa12");
    expect(lastCall?.system).toContain("[kilde: manual:seed]");
  });
});
