import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { UnconfiguredHttpTransport } from "./integrations.ts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";

/**
 * Home Assistant som enhetsbuss via Tool Gateway (INTEGRATIONS.md §5) - aldri
 * samtalemotor. Sikkerhetsautomasjoner (frostsikring, lekkasje, alarm) ligger
 * deterministisk i HA og virker uten sky/Jarvis/LLM - derfor tåler huset
 * skybrudd/romfeil (verifiseres fysisk mot ekte HA-instans, se D-37/status).
 * Lås/alarm er klasse D: signert godkjenning kreves UANSETT kanal, også tale.
 */
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const room = { site_id: z.string(), room_id: z.string() };

export function homeAssistantTools(transport: ToolTransport = new UnconfiguredHttpTransport("home-assistant")): ToolDefinition[] {
  const base = {
    tool_id: "home-assistant" as const,
    credential_ref: "JARVIS_HA_TOKEN",
    timeout_ms: 5_000,
    transport
  };
  return [
    {
      // D-388: oversikt over alle entiteter (valgfritt filtrert på domene, f.eks. "light") - brukes som tilkoblingstest
      // (`live_test`) og for at Charlie kan finne riktig entity_id før en romkart-oppføring lages.
      ...base, action: "list_states", description: "List alle enheter i Home Assistant med nåværende tilstand (GET /api/states, valgfritt domene-filter)",
      input_schema: record({ domain: z.string().regex(/^[a-z_]+$/).optional() }), capability_class: "A",
      scopes: ["states:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, rate_limit_per_minute: 30, output_trust: "untrusted"
    },
    {
      ...base, action: "read_state", description: "Les enhets-/romtilstand",
      input_schema: record({ ...room, entity: z.string().optional() }), capability_class: "A",
      scopes: ["states:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, rate_limit_per_minute: 60, output_trust: "untrusted"
    },
    {
      ...base, action: "light_set", description: "Lys av/på per rom",
      input_schema: record({ ...room, on: z.boolean() }), capability_class: "B",
      scopes: ["light:call"], reversible: true, rollback_procedure: "sett motsatt tilstand",
      idempotent_external: true, rate_limit_per_minute: 60, output_trust: "internal"
    },
    {
      ...base, action: "climate_set", description: "Klima per rom",
      input_schema: record({ ...room, temperature: z.number().min(5).max(30) }), capability_class: "B",
      scopes: ["climate:call"], reversible: true, rollback_procedure: "sett forrige temperatur",
      idempotent_external: true, rate_limit_per_minute: 30, output_trust: "internal"
    },
    {
      // Q-34 (D-130-funn, lukket her): `read_state` for et ukjent entity er
      // ALDRI en gyldig tilstand å låse/alarmere mot - `preflight_requires_target`
      // gjør fail-closed på ukjent mål STRUKTURELT, ikke bare en tilfeldighet
      // av at en streng HA-transport kaster (se gateway.ts).
      // Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82): en uleselig,
      // manglende eller FEIL etter-tilstand (kommandoen ble sendt, men døren
      // låste seg faktisk ikke) skal heller ikke rapporteres ok:true -
      // `postcondition_predicate` krever at readback FAKTISK viser den
      // tiltenkte `locked`-verdien.
      ...base, action: "lock_set", description: "Lås/lås opp dør (KRITISK)",
      input_schema: record({ ...room, entity: z.string(), locked: z.boolean() }), capability_class: "D",
      preflight_action: "read_state", preflight_requires_target: true,
      postcondition_predicate: (after, parameters) => (after as { locked?: boolean } | null)?.locked === parameters["locked"],
      scopes: ["lock:call"], reversible: true, rollback_procedure: "sett motsatt låstilstand + varsle",
      idempotent_external: true, rate_limit_per_minute: 10, output_trust: "internal"
    },
    {
      ...base, action: "alarm_set", description: "Alarm av/på (KRITISK)",
      input_schema: record({ ...room, armed: z.boolean() }), capability_class: "D",
      preflight_action: "read_state", preflight_requires_target: true,
      postcondition_predicate: (after, parameters) => (after as { armed?: boolean } | null)?.armed === parameters["armed"],
      scopes: ["alarm:call"], reversible: true, rollback_procedure: "sett forrige alarmtilstand + varsle",
      idempotent_external: true, rate_limit_per_minute: 10, output_trust: "internal"
    }
  ];
}
