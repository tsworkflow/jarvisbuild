import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { guardedFetch } from "./url-safety.ts";

/**
 * D-388 (lukker JARVIS-061 «Home Assistant is a ghost» og D-336 sitt bevisste STOPP): ekte `HomeAssistantTransport`
 * bak de ALLEREDE definerte og testede `homeAssistantTools()` (read_state/light_set/climate_set/lock_set/alarm_set).
 *
 * Home Assistant REST API (verifisert 2026-10-04 mot developers.home-assistant.io/docs/api/rest): alle kall bærer
 * `Authorization: Bearer <langlivet tilgangstoken>`; `GET /api/states` (alle entiteter), `GET /api/states/<entity_id>`
 * (én entitet, 404 når den ikke finnes), `POST /api/services/<domain>/<service>` med JSON-kropp (`entity_id` + data).
 *
 * D-336 sin åpne designavgjørelse («hvordan mapper site_id/room_id til HA sin entity_id/area_id?») løses her EKSPLISITT
 * og uten gjetting: eieren konfigurerer en romkart-JSON (`JARVIS_HA_ROOMS`) som peker hvert `site_id`/`room_id` til
 * entity-id-er per domene (`light`, `climate`, `lock`, `alarm`). Mangler et rom/domene i kartet, feiler kallet lukket
 * (`home_room_not_mapped`) - Jarvis gjetter ALDRI hvilken dør eller alarm et rom betyr (CLAUDE.md regel 2/8).
 * REST-API-et eksponerer ikke area-registeret (kun WebSocket), så et eksplisitt eierkart er også den ærlige løsningen.
 *
 * `read_state` returnerer et normalisert bilde (`on`/`temperature`/`locked`/`armed`) slik at `lock_set`/`alarm_set`
 * sine preflight-/postcondition-predikater (Q-34) fungerer uendret, pluss HA sin rå `state`/`attributes`.
 */
export interface HomeAssistantRoomMap {
  [siteId: string]: {
    [roomId: string]: {
      light?: string | string[];
      climate?: string;
      lock?: string;
      alarm?: string;
    };
  };
}

export type HomeAssistantRoomMapResolver = () => Promise<HomeAssistantRoomMap | string | null>;

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

export function assertEntityId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENTITY_ID.test(value)) throw new Error(`home_invalid_entity_id:${label}`);
  return value;
}

/** Normaliserer én HA-tilstand til det `homeAssistantTools()` sine predikater forventer. */
export function normalizeHomeState(entity: { entity_id: string; state: string; attributes?: Record<string, unknown> }): Record<string, JsonValue> {
  const domain = entity.entity_id.split(".")[0] ?? "";
  const attributes = (entity.attributes ?? {}) as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = { entity_id: entity.entity_id, domain, state: entity.state, attributes };
  if (domain === "lock") out["locked"] = entity.state === "locked";
  if (domain === "alarm_control_panel") out["armed"] = entity.state !== "disarmed" && entity.state !== "unknown" && entity.state !== "unavailable";
  if (domain === "light" || domain === "switch") out["on"] = entity.state === "on";
  if (domain === "climate") {
    const t = attributes["temperature"];
    out["temperature"] = typeof t === "number" ? t : null;
    out["current_temperature"] = typeof attributes["current_temperature"] === "number" ? (attributes["current_temperature"] as number) : null;
  }
  return out;
}

export class HomeAssistantTransport implements ToolTransport {
  constructor(
    private readonly baseUrl: () => Promise<string | null>,
    private readonly rooms: HomeAssistantRoomMapResolver
  ) {}

  private async root(): Promise<string> {
    const url = (await this.baseUrl())?.trim();
    if (!url) throw new Error("home_assistant_base_url_not_configured");
    return url.replace(/\/+$/, "");
  }

  private async roomMap(): Promise<HomeAssistantRoomMap> {
    const raw = await this.rooms();
    if (!raw) throw new Error("home_rooms_not_configured");
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
        return parsed as HomeAssistantRoomMap;
      } catch {
        throw new Error("home_rooms_invalid_json");
      }
    }
    return raw;
  }

  private async entityFor(siteId: string, roomId: string, domain: "light" | "climate" | "lock" | "alarm"): Promise<string[]> {
    const map = await this.roomMap();
    const room = map[siteId]?.[roomId];
    if (!room) throw new Error(`home_room_not_mapped:${siteId}/${roomId}`);
    const value = room[domain];
    if (!value || (Array.isArray(value) && value.length === 0)) throw new Error(`home_room_domain_not_mapped:${siteId}/${roomId}/${domain}`);
    const list = Array.isArray(value) ? value : [value];
    return list.map((e) => assertEntityId(e, domain));
  }

  private async call(method: "GET" | "POST", path: string, credential: string, body?: Record<string, JsonValue>): Promise<{ status: number; json: unknown }> {
    const response = await guardedFetch(`${await this.root()}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 404) return { status: 404, json: null };
    if (!response.ok) throw new Error(`home_assistant_error_${response.status}`);
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
  }

  private async readEntity(entityId: string, credential: string): Promise<Record<string, JsonValue> | null> {
    const { status, json } = await this.call("GET", `/api/states/${encodeURIComponent(entityId)}`, credential);
    if (status === 404 || !json) return null;
    return normalizeHomeState(json as { entity_id: string; state: string; attributes?: Record<string, unknown> });
  }

  private async service(domain: string, service: string, data: Record<string, JsonValue>, credential: string): Promise<JsonValue> {
    const { json } = await this.call("POST", `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, credential, data);
    return (json as JsonValue) ?? null;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string) {
    const siteId = String(parameters["site_id"] ?? "");
    const roomId = String(parameters["room_id"] ?? "");
    switch (action) {
      case "list_states": {
        const { json } = await this.call("GET", "/api/states", credential);
        const all = Array.isArray(json) ? (json as Array<{ entity_id: string; state: string; attributes?: Record<string, unknown> }>) : [];
        const domain = typeof parameters["domain"] === "string" ? parameters["domain"] : null;
        const filtered = domain ? all.filter((e) => e.entity_id.startsWith(domain + ".")) : all;
        return { data: filtered.slice(0, 200).map((e) => ({ entity_id: e.entity_id, state: e.state, name: (e.attributes?.["friendly_name"] as JsonValue) ?? null })) };
      }
      case "read_state": {
        // Q-34: et ukjent mål gir `data: null` → `preflight_requires_target` avviser lock/alarm lukket.
        if (typeof parameters["entity"] === "string") {
          return { data: await this.readEntity(assertEntityId(parameters["entity"], "entity"), credential) };
        }
        const map = await this.roomMap();
        const room = map[siteId]?.[roomId];
        if (!room) throw new Error(`home_room_not_mapped:${siteId}/${roomId}`);
        const out: Record<string, JsonValue> = {};
        for (const domain of ["light", "climate", "lock", "alarm"] as const) {
          const value = room[domain];
          if (!value) continue;
          const first = Array.isArray(value) ? value[0] : value;
          if (!first) continue;
          const state = await this.readEntity(assertEntityId(first, domain), credential);
          out[domain] = state;
          if (state) {
            if (domain === "lock") out["locked"] = state["locked"] ?? null;
            if (domain === "alarm") out["armed"] = state["armed"] ?? null;
            if (domain === "light") out["on"] = state["on"] ?? null;
            if (domain === "climate") out["temperature"] = state["temperature"] ?? null;
          }
        }
        return { data: out };
      }
      case "light_set": {
        const entities = await this.entityFor(siteId, roomId, "light");
        const on = parameters["on"] === true;
        await this.service("light", on ? "turn_on" : "turn_off", { entity_id: entities.length === 1 ? entities[0]! : entities }, credential);
        return { external_id: `${on ? "on" : "off"}:${entities.join(",")}` };
      }
      case "climate_set": {
        const [entity] = await this.entityFor(siteId, roomId, "climate");
        const temperature = Number(parameters["temperature"]);
        if (!Number.isFinite(temperature)) throw new Error("home_invalid_temperature");
        await this.service("climate", "set_temperature", { entity_id: entity!, temperature }, credential);
        return { external_id: `temp:${entity}:${temperature}` };
      }
      case "lock_set": {
        const entity = assertEntityId(parameters["entity"], "entity");
        if (!entity.startsWith("lock.")) throw new Error("home_invalid_entity_id:entity_not_lock");
        const locked = parameters["locked"] === true;
        await this.service("lock", locked ? "lock" : "unlock", { entity_id: entity }, credential);
        return { external_id: `${locked ? "lock" : "unlock"}:${entity}` };
      }
      case "alarm_set": {
        const [entity] = await this.entityFor(siteId, roomId, "alarm");
        const armed = parameters["armed"] === true;
        await this.service("alarm_control_panel", armed ? "alarm_arm_away" : "alarm_disarm", { entity_id: entity! }, credential);
        return { external_id: `${armed ? "arm" : "disarm"}:${entity}` };
      }
      default:
        throw new Error(`home_assistant_unsupported_action_${action}`);
    }
  }
}
