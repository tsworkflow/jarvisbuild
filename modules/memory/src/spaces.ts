import type pg from "pg";
import { serializeMemorySpaces, type MemorySpace } from "@jarvis/contracts";

/**
 * Transaksjon med BÅDE tenant- og space-kontekst for minne-RLS.
 * Space-policyen i databasen er RESTRICTIVE: uten gyldig space-liste er
 * minnetabellene usynlige (default deny).
 *
 * Sikkerhetsregel (MEMORY_ARCHITECTURE §4): health er strengere enn andre
 * spaces og kan ALDRI kombineres med andre i samme lesing/skriving.
 */
export function assertSpacesAllowed(spaces: readonly MemorySpace[]): void {
  if (spaces.length === 0) {
    throw new Error("memory_spaces_empty");
  }
  if (spaces.includes("health") && spaces.length > 1) {
    throw new Error("health_space_must_be_isolated");
  }
}

export async function withMemoryTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  spaces: readonly MemorySpace[],
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  assertSpacesAllowed(spaces);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [
      tenantId,
      serializeMemorySpaces(spaces)
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
