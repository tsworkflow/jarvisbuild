import { type OwnerConfig, describeOwnerConfigError, loadOwnerConfig } from "@jarvis/contracts";

/**
 * Remediering del 2 (JARVIS-065): prosess-inngang for den ENE eier-identiteten. Ugyldig/manglende konfig
 * stopper oppstarten (fail closed) - aldri en stille default. Kun feilkode + variabelnavn logges, aldri verdier.
 */
export function ownerConfigOrExit(env: Record<string, string | undefined> = process.env): OwnerConfig {
  try {
    return loadOwnerConfig(env);
  } catch (err) {
    console.error(JSON.stringify({ msg: "owner_config_invalid_refusing_to_start", detail: describeOwnerConfigError(err) }));
    process.exit(1);
  }
}
