import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-240 (funnet live av Tobias, "database infisical does not exist"-
 * krasjløkke): `postgres`-tjenestens EGEN `POSTGRES_DB` (docker-compose.yml)
 * oppretter KUN én database (`jarvis`) - `infisical`/`langfuse` trenger HVER
 * SIN EGEN, separate database på SAMME Postgres-instans, og INGENTING i
 * compose-filen opprettet dem FØR denne fiksen. `db-bootstrap`-tjenesten
 * kjører `bootstrap-databases.sql` (idempotent `CREATE DATABASE ... WHERE
 * NOT EXISTS`) FØR infisical/langfuse startes. SQL-logikken selv er
 * host-verifisert direkte mot en ekte lokal Postgres 16 (kjørt to ganger -
 * første gang opprettet begge databasene, andre gang var et rent no-op,
 * exit 0) - DENNE suiten beviser KUN at compose-oppsettet faktisk
 * er koblet til den verifiserte SQL-en i riktig rekkefølge, ikke SQL-en selv.
 */
function readCompose(): string {
  return readFileSync(fileURLToPath(new URL("../../../infra/local/docker-compose.yml", import.meta.url)), "utf8");
}

function readBootstrapSql(): string {
  return readFileSync(fileURLToPath(new URL("../../../infra/local/bootstrap-databases.sql", import.meta.url)), "utf8");
}

function extractServiceBlock(compose: string, serviceName: string): string {
  const lines = compose.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s{2}${serviceName}:\\s*$`).test(l));
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^ {2}\S/.test(l));
  return lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join("\n");
}

describe("D-240: db-bootstrap-tjenesten finnes og kjører bootstrap-databases.sql mot postgres", () => {
  const compose = readCompose();
  const block = extractServiceBlock(compose, "db-bootstrap");

  it("bruker SAMME image som postgres-tjenesten (psql tilgjengelig, ingen ny image å hente)", () => {
    expect(block).toMatch(/image:\s*pgvector\/pgvector:pg16/);
  });

  it("monterer bootstrap-databases.sql read-only og kjører den via psql -f", () => {
    expect(block).toMatch(/\.\/bootstrap-databases\.sql:\/bootstrap\/bootstrap-databases\.sql:ro/);
    expect(block).toMatch(/psql[\s\S]*?-f\s+\/bootstrap\/bootstrap-databases\.sql/);
  });

  it("avhenger av at postgres er HELSEFRISK (service_healthy) FØR den kjøres", () => {
    expect(block).toMatch(/depends_on:\s*\n\s*postgres:\s*\n\s*condition:\s*service_healthy/);
  });

  it("er en engangstjeneste (restart: \"no\"), samme presedens som migrate-tjenesten", () => {
    expect(block).toMatch(/restart:\s*"no"/);
  });
});

describe("D-240: infisical/langfuse venter på db-bootstrap FØR de startes - ALDRI direkte på postgres alene lenger", () => {
  const compose = readCompose();

  it("infisical: depends_on inneholder db-bootstrap (service_completed_successfully)", () => {
    const block = extractServiceBlock(compose, "infisical");
    expect(block).toMatch(/depends_on:\s*\n\s*db-bootstrap:\s*\n\s*condition:\s*service_completed_successfully/);
  });

  it("langfuse: depends_on inneholder db-bootstrap (service_completed_successfully)", () => {
    const block = extractServiceBlock(compose, "langfuse");
    expect(block).toMatch(/depends_on:\s*\n\s*db-bootstrap:\s*\n\s*condition:\s*service_completed_successfully/);
  });
});

describe("D-240: bootstrap-databases.sql sitt idempotens-mønster (host-verifisert direkte mot ekte Postgres 16, se filhode)", () => {
  const sql = readBootstrapSql();

  it("oppretter infisical KUN når den ikke allerede finnes (WHERE NOT EXISTS + \\gexec)", () => {
    expect(sql).toMatch(/CREATE DATABASE infisical OWNER infisical_app'\s+WHERE NOT EXISTS[^\n]*datname = 'infisical'\)\s*\\gexec/);
  });

  it("oppretter langfuse KUN når den ikke allerede finnes (WHERE NOT EXISTS + \\gexec)", () => {
    expect(sql).toMatch(/CREATE DATABASE langfuse OWNER langfuse_app'\s+WHERE NOT EXISTS[^\n]*datname = 'langfuse'\)\s*\\gexec/);
  });
});
