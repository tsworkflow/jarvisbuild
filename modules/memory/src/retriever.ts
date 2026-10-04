import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { EmbeddingProvider } from "./embedding.ts";
import { withMemoryTransaction } from "./spaces.ts";

export interface RetrievedVersion {
  version: number;
  content: string;
  valid_from: string;
  valid_to: string;
}

export interface RetrievedItem {
  memory_item_id: string;
  subject: string;
  content: string;
  type: string;
  space: string;
  score: number;
  valid_from: string;
  valid_to: string | null;
  has_conflict: boolean;
  source: { kind: string; ref: string; trust_level: string };
  versions?: RetrievedVersion[];
  via?: "search" | "relation";
}

export interface SearchOptions {
  spaces: MemorySpace[];
  query: string;
  /** Tidsreferanse: «hva var sant da» - filtrerer på valid_from/valid_to og søker versjoner. */
  timeref?: Date;
  limit?: number;
}

/** D-384: laveste rangeringsscore for at strengt minne (helse/special) regnes som et direkte treff på eierens melding. */
export const RESTRICTED_MEMORY_MIN_SCORE = 0.3;

/**
 * Context Builder v2 / hybrid retrieval (MEMORY_ARCHITECTURE §7):
 * fulltekst + vektor + relasjonsutvidelse (1 hopp) + tid + kilde → reranking.
 * All lesing skjer under tenant- OG space-RLS i databasen; karantene og
 * invaliderte items er aldri med i konteksten.
 */
export class MemoryRetriever {
  private pgVectorCache: boolean | undefined;

  /** Runtime-probe: er `embeddings.vec` (pgvector) tilgjengelig? Caches. */
  private async usesPgVector(client: pg.PoolClient): Promise<boolean> {
    if (this.pgVectorCache === undefined) {
      const r = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='embeddings' AND column_name='vec') AS has"
      );
      this.pgVectorCache = (r.rows[0] as { has: boolean }).has;
    }
    return this.pgVectorCache;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddings: EmbeddingProvider
  ) {}

  async search(identity: IdentityContext, options: SearchOptions): Promise<RetrievedItem[]> {
    const limit = options.limit ?? 8;
    const queryVector = await this.embeddings.embed(options.query);
    return withMemoryTransaction(this.pool, identity.tenant_id, options.spaces, async (client) => {
      const timeref = options.timeref ?? null;

      const fts = await client.query(
        `SELECT m.memory_item_id, m.subject, m.content, m.type, m.space, m.valid_from, m.valid_to,
                m.has_conflict, m.observed_at, s.kind AS source_kind, s.ref AS source_ref,
                m.trust_level,
                ts_rank(m.fts, plainto_tsquery('norwegian', $1)) AS fts_rank
         FROM memory_items m JOIN memory_sources s ON s.source_id = m.source_id
         WHERE m.status = 'active'
           AND ($2::timestamptz IS NULL OR (m.valid_from <= $2 AND (m.valid_to IS NULL OR m.valid_to > $2)))
           AND m.fts @@ plainto_tsquery('norwegian', $1)
         ORDER BY fts_rank DESC LIMIT 60`,
        [options.query, timeref]
      );

      // D-28: bruk pgvector (HNSW, <=> cosine) når kolonnen `vec` finnes i
      // Docker-PG; ellers real[]+cosine_sim (embedded test-PG). Samme ordering.
      const pgv = await this.usesPgVector(client);
      const simExpr = pgv ? "1 - (e.vec <=> ($1::text)::vector)" : "cosine_sim(e.embedding, $1::real[])";
      const vecArg = pgv ? JSON.stringify(queryVector) : queryVector;
      const vec = await client.query(
        `SELECT m.memory_item_id, m.subject, m.content, m.type, m.space, m.valid_from, m.valid_to,
                m.has_conflict, m.observed_at, s.kind AS source_kind, s.ref AS source_ref,
                m.trust_level,
                ${simExpr} AS sim
         FROM embeddings e
         JOIN memory_items m ON m.memory_item_id = e.memory_item_id
         JOIN memory_sources s ON s.source_id = m.source_id
         WHERE m.status = 'active'${pgv ? " AND e.vec IS NOT NULL" : ""}
           AND ($2::timestamptz IS NULL OR (m.valid_from <= $2 AND (m.valid_to IS NULL OR m.valid_to > $2)))
           AND ${simExpr} >= 0.6
         ORDER BY sim DESC LIMIT 60`,
        [vecArg, timeref]
      );

      // Reranking: kombiner tekst-, vektor- og ferskhetssignal.
      const byId = new Map<string, RetrievedItem & { fts_rank: number; sim: number; observed_at: Date }>();
      const upsert = (row: Record<string, unknown>, kind: "fts" | "vec") => {
        const id = row["memory_item_id"] as string;
        const entry = byId.get(id) ?? {
          memory_item_id: id,
          subject: row["subject"] as string,
          content: row["content"] as string,
          type: row["type"] as string,
          space: row["space"] as string,
          valid_from: String(row["valid_from"]),
          valid_to: row["valid_to"] ? String(row["valid_to"]) : null,
          has_conflict: row["has_conflict"] as boolean,
          source: {
            kind: row["source_kind"] as string,
            ref: row["source_ref"] as string,
            trust_level: row["trust_level"] as string
          },
          score: 0,
          fts_rank: 0,
          sim: 0,
          observed_at: new Date(String(row["observed_at"])),
          via: "search" as const
        };
        if (kind === "fts") entry.fts_rank = Number(row["fts_rank"]);
        else entry.sim = Number(row["sim"]);
        byId.set(id, entry);
      };
      for (const row of fts.rows) upsert(row as Record<string, unknown>, "fts");
      for (const row of vec.rows) upsert(row as Record<string, unknown>, "vec");

      const maxFts = Math.max(0.001, ...[...byId.values()].map((e) => e.fts_rank));
      const now = Date.now();
      for (const entry of byId.values()) {
        const recency = Math.max(0, 1 - (now - entry.observed_at.getTime()) / (365 * 24 * 3600 * 1000));
        entry.score = 0.5 * (entry.fts_rank / maxFts) + 0.4 * entry.sim + 0.1 * recency;
      }
      let ranked: RetrievedItem[] = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);

      // Relasjonsutvidelse (1 hopp): items som deler entiteter med topptreffene.
      if (ranked.length > 0) {
        const topIds = ranked.slice(0, 3).map((r) => r.memory_item_id);
        const related = await client.query(
          `SELECT DISTINCT m.memory_item_id, m.subject, m.content, m.type, m.space, m.valid_from,
                  m.valid_to, m.has_conflict, m.observed_at, s.kind AS source_kind, s.ref AS source_ref,
                  m.trust_level
           FROM memory_item_entities me1
           JOIN relations r ON (r.from_entity = me1.entity_id OR r.to_entity = me1.entity_id)
           JOIN memory_item_entities me2
             ON me2.entity_id IN (r.from_entity, r.to_entity) AND me2.memory_item_id <> me1.memory_item_id
           JOIN memory_items m ON m.memory_item_id = me2.memory_item_id AND m.status = 'active'
           JOIN memory_sources s ON s.source_id = m.source_id
           WHERE me1.memory_item_id = ANY($1)
           LIMIT 5`,
          [topIds]
        );
        for (const row of related.rows as Array<Record<string, unknown>>) {
          const id = row["memory_item_id"] as string;
          if (!byId.has(id) && ranked.length < limit + 3) {
            ranked.push({
              memory_item_id: id,
              subject: row["subject"] as string,
              content: row["content"] as string,
              type: row["type"] as string,
              space: row["space"] as string,
              valid_from: String(row["valid_from"]),
              valid_to: row["valid_to"] ? String(row["valid_to"]) : null,
              has_conflict: row["has_conflict"] as boolean,
              source: {
                kind: row["source_kind"] as string,
                ref: row["source_ref"] as string,
                trust_level: row["trust_level"] as string
              },
              score: 0.15,
              via: "relation"
            });
          }
        }
      }

      // Tidssøk: inkluder historiske versjoner som var gyldige på tidspunktet.
      if (options.timeref) {
        const versions = await client.query(
          `SELECT memory_item_id, version, subject, content, valid_from, valid_to
           FROM memory_versions
           WHERE valid_from <= $1 AND valid_to > $1
             AND to_tsvector('norwegian', subject || ' ' || content) @@ plainto_tsquery('norwegian', $2)
           LIMIT 10`,
          [options.timeref, options.query]
        );
        for (const row of versions.rows as Array<Record<string, unknown>>) {
          ranked.push({
            memory_item_id: row["memory_item_id"] as string,
            subject: row["subject"] as string,
            content: row["content"] as string,
            type: "semantic",
            space: options.spaces[0] as string,
            valid_from: String(row["valid_from"]),
            valid_to: String(row["valid_to"]),
            has_conflict: true,
            source: { kind: "version", ref: `v${row["version"]}`, trust_level: "internal" },
            score: 0.5,
            via: "search"
          });
        }
        ranked = ranked.sort((a, b) => b.score - a.score);
      }

      // Motstrid: legg ved alle versjoner slik at begge sider er synlige.
      for (const item of ranked) {
        if (item.has_conflict && item.source.kind !== "version") {
          const versions = await client.query(
            `SELECT version, content, valid_from, valid_to FROM memory_versions
             WHERE memory_item_id = $1 ORDER BY version`,
            [item.memory_item_id]
          );
          item.versions = versions.rows as RetrievedVersion[];
        }
      }
      return ranked;
    });
  }

  /** Kompakt kontekstblokk med kildeangivelse for Conversation Engine. */
  async contextFor(identity: IdentityContext, userText: string): Promise<string> {
    return (await this.contextWithMeta(identity, userText)).text;
  }

  /**
   * Del 3 (JARVIS-016/035): samme kontekstblokk + metadata om HVA som faktisk ble hentet (minnerom og `sensitivity`-kolonnen), slik at
   * ruteren kan utlede sensitivitet fra innholdet i stedet for å anta «public». Tom kontekst = ingen minne er med i modellkallet.
   */
  async contextWithMeta(
    identity: IdentityContext,
    userText: string,
    options: { restrictedMinScore?: number } = {}
  ): Promise<{ text: string; spaces: string[]; sensitivities: string[]; withheld_restricted: number }> {
    const items = await this.search(identity, {
      spaces: [identity.memory_space_id],
      query: userText,
      limit: 5
    });
    if (items.length === 0) {
      return { text: "", spaces: [], sensitivities: [], withheld_restricted: 0 };
    }
    const ids = items.map((item) => item.memory_item_id);
    const sensitivityById = new Map<string, string>(
      await withMemoryTransaction(this.pool, identity.tenant_id, [identity.memory_space_id], async (client) =>
        ((await client.query("SELECT memory_item_id, sensitivity FROM memory_items WHERE memory_item_id = ANY($1)", [ids])).rows as Array<{
          memory_item_id: string;
          sensitivity: string;
        }>).map((r) => [r.memory_item_id, r.sensitivity] as [string, string])
      )
    );
    // D-384: strengt (helserom / `special`) minne tas KUN med når det er et DIREKTE treff på det eieren skriver nå. Et svakt treff
    // eller en relasjonsutvidelse holdes helt utenfor konteksten (sendes aldri til noen modell) i stedet for å låse hele turen til lokal modell.
    const minScore = options.restrictedMinScore ?? RESTRICTED_MEMORY_MIN_SCORE;
    const kept = items.filter((item) => {
      const restricted = item.space === "health" || sensitivityById.get(item.memory_item_id) === "special";
      return !restricted || (item.via !== "relation" && item.score >= minScore);
    });
    const withheld = items.length - kept.length;
    if (kept.length === 0) {
      return { text: "", spaces: [], sensitivities: [], withheld_restricted: withheld };
    }
    const lines = kept.map((item) => `- ${item.content} [kilde: ${item.source.kind}:${item.source.ref}]`);
    return {
      text: `Relevant minne (med kilde):\n${lines.join("\n")}`,
      spaces: [...new Set(kept.map((item) => item.space))],
      sensitivities: [...new Set(kept.map((item) => sensitivityById.get(item.memory_item_id) ?? "normal"))],
      withheld_restricted: withheld
    };
  }
}
