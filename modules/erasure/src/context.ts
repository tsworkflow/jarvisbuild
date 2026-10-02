import type pg from "pg";
import { serializeMemorySpaces } from "@jarvis/contracts";

/**
 * RLS-kontekst-helpers for erasure (docs/DATA_ERASURE.md §3). Speiler
 * `@jarvis/memory`'s `withMemoryTransaction`-mønster, men uten
 * `assertSpacesAllowed()`-helse-vakten: den regelen (`health` kan ALDRI
 * kombineres med andre spaces i SAMME lesing/skriving) gjelder normal
 * innholds-LESING/SKRIVING der en samtale kan blande innhold fra flere
 * spaces i ett resultatsett. Her partisjonerer vi ALLTID `health` i sin
 * EGEN separate RLS-kontekst (se `partitionSpaces`) - den samme
 * sikkerhetsinvarianten håndheves fortsatt, bare eksplisitt i stedet for
 * via den delte hjelperen.
 */
export async function setSpaceContext(client: pg.PoolClient, tenantId: string, spaces: readonly string[]): Promise<void> {
  await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [
    tenantId,
    serializeMemorySpaces(spaces)
  ]);
}

export async function setTenantOnlyContext(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenantId]);
}

/**
 * D-358: transaksjonslokal GUC (`is_local=true`, SAMME mønster som
 * `jarvis.tenant_id` over - forsvinner automatisk ved COMMIT/ROLLBACK,
 * lekker ALDRI til en senere transaksjon/tilkobling) som lar
 * `memory_versions` sin `forbid_mutation()`-trigger (062_memory_erasure_
 * bypass.sql) slippe gjennom NØYAKTIG denne transaksjonens DELETE - append-
 * only-prinsippet gjelder UENDRET for enhver annen tilgang. Kalles KUN av
 * `ErasureService.executeErasure()` sin "delete"-gren, ALDRI "count"/preview.
 */
export async function setErasureInProgress(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
}

/** Splitt en liste med spaces i [ikke-health-gruppen, health-gruppen-eller-tom] - aldri blandet i én RLS-kontekst. */
export function partitionSpaces(spaces: readonly string[]): { rest: string[]; health: string[] } {
  const health = spaces.filter((s) => s === "health");
  const rest = spaces.filter((s) => s !== "health");
  return { rest, health };
}

export async function tenantSpaces(client: pg.PoolClient, tenantId: string): Promise<string[]> {
  await setTenantOnlyContext(client, tenantId);
  const { rows } = await client.query("SELECT DISTINCT space FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  return (rows as Array<{ space: string }>).map((r) => r.space);
}
