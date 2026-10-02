import { guardedFetch } from "./url-safety.ts";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { googleAccessToken } from "./live-transports.ts";

/**
 * D-337 (Google Cloud "servere"-sliceen). Tobias sin eksplisitte presisering
 * i chat (svar på Q-41 sin `google_cloud`-vaghet): "Google cloud skal være
 * Google ads alle servere alle markedsføring osv osv" - Google Ads er
 * ALLEREDE bygget (D-83, `modules/growth`); "alle servere" tolkes som Google
 * Compute Engine (GCE) - standard-betydningen av "servere" på GCP. "All
 * markedsføring osv osv" utover Ads er BEVISST IKKE bygget denne sliceen
 * (hundrevis av andre GCP-del-API-er finnes - Analytics/Search Console/
 * Merchant Center/osv - hver krever sin egen D-41-verifisering, ikke gjettet
 * frem sammen med denne).
 *
 * D-41-verifiseringsstatus: WebSearch denne økten (via en Explore-agent)
 * fant `https://compute.googleapis.com/compute/v1/projects/{project}/
 * zones/{zone}/instances/...` - `VERIFIED_OFFICIAL_SEARCH_SNIPPET`
 * (WebFetch direkte mot cloud.google.com ikke forsøkt - samme D-297-mønster
 * som resten av økten), IKKE `VERIFIED_PRIMARY_SOURCE`. Bekreftet:
 * `instances.start`/`.stop`/`.reset` er ASYNKRONE - de returnerer et
 * `Operation`-objekt UMIDDELBART, IKKE den faktiske sluttilstanden; kalleren
 * MÅ polle et separat `zoneOperations.get`-endepunkt til `status: "DONE"`.
 * `instances.get.status` sitt enum er bekreftet: PROVISIONING/STAGING/
 * RUNNING/STOPPING/SUSPENDING/SUSPENDED/REPAIRING/TERMINATED.
 *
 * Arkitektur: SAMME "transporten transporterer KUN, mål-autorisasjon skjer
 * FØR transporten nås"-mønster som Docker (D-105 host-fix) - se
 * `gce-target-policy.ts` sin `authorizeGceTarget()` (håndhevet av
 * `ToolGateway.execute()` via `ToolDefinition.parameterAuthorizer`, se
 * `integrations.ts`). Denne filen validerer KUN at `zone`/`instance_name`
 * er strukturelt trygge (URL-path-segmenter), ALDRI en forretningsregel om
 * HVEM som får mutere.
 *
 * Auth: SAMME `googleAccessToken()` OAuth-refresh-token-utveksler som
 * Gmail/Calendar/Drive/Sheets/Ads allerede bruker (`JARVIS_GOOGLE_CLIENT_ID`/
 * `_SECRET`, delt app-konfig) - MEN med sin EGEN, separate `credential_ref`
 * (`JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN`), SAMME "egen scope krever eget
 * consent/token"-begrunnelse som Google Ads (D-83) og Sheets (D-299): GCE
 * krever `https://www.googleapis.com/auth/compute`-scopen, som INGEN av de
 * eksisterende Google-tokenene kan antas å ha (usikker antakelse, ALDRI
 * gjort).
 *
 * INGEN offisiell Node/TypeScript Compute-klient importert - rå REST via
 * `fetch()` er BEVISST valgt (CLAUDE.md regel 3, SAMME "ingen ny SDK uten
 * begrunnelse"-prinsipp som ALLE andre provider-adaptere i denne
 * kodebasen).
 */

const API_VERSION = "v1";
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/** Bounded operation-polling - ALDRI en uendelig løkke (samme "no retry storms"-prinsipp som resten av kodebasen). 30 forsøk x maks 2s backoff-tak = maks ca. 60s ventetid per mutasjon. */
const MAX_OPERATION_POLLS = 30;
const OPERATION_POLL_INTERVAL_MS = 2_000;

/** GCE sitt eget navnealfabet for zone/instance-segmenter (RFC 1035-lignende). SAMME mønster som `gce-target-policy.ts` - injeksjons-/path-forveksling-forsvar FØR strenginterpolering inn i URL-en. */
const VALID_PATH_SEGMENT = /^[a-z][a-z0-9-]{0,62}$/;

export class GceApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GceApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tolerant JSON-parsing av Google sin generiske API-feilkonvolutt (`{error:{code,message,status}}`, SAMME form som `classifyGoogleAdsErrorBody`/Drive-feil andre steder i denne kodebasen). Avkortet (200 tegn), ALDRI rå kropp/headere videre. */
function classifyGceErrorBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { status?: string; message?: string } };
    const status = parsed.error?.status ?? "UNKNOWN";
    const message = (parsed.error?.message ?? "").slice(0, 200);
    return message ? `${status}:${message}` : status;
  } catch {
    return "UNCLASSIFIED_ERROR_BODY";
  }
}

function assertValidPathSegment(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !VALID_PATH_SEGMENT.test(value)) {
    throw new Error(`gce_invalid_${label}:${JSON.stringify(value).slice(0, 80)}`);
  }
}

interface GceRequestOptions {
  method: "GET" | "POST";
  path: string;
  accessToken: string;
}

/** Bounded retry KUN på bekreftede retry-bare statuser (429/5xx) - ALDRI en retry-storm, ALDRI retry på 401/403 (permanent auth-feil, kastes umiddelbart). */
async function gceRequest(options: GceRequestOptions): Promise<JsonValue> {
  const url = `https://compute.googleapis.com/compute/${API_VERSION}/${options.path}`;
  let lastError: GceApiError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await guardedFetch(url, {
      method: options.method,
      headers: { authorization: `Bearer ${options.accessToken}` }
    });
    if (response.ok) {
      return (await response.json()) as JsonValue;
    }
    const rawBody = await response.text().catch(() => "");
    const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
    lastError = new GceApiError(`gce_api_error_${response.status}:${classifyGceErrorBody(rawBody)}`, response.status, retryable);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  throw lastError!;
}

interface GceOperation {
  name?: string;
  status?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

/**
 * `instances.start`/`.stop`/`.reset` returnerer et `Operation` UMIDDELBART -
 * denne funksjonen poller `zoneOperations.get` til `status: "DONE"` FØR
 * `invoke()` returnerer, slik at gateway.ts sin preflight/postcondition-
 * readback (kalt RETT ETTER mutasjonen) faktisk ser den KONVERGERTE
 * sluttilstanden, ikke en operasjon fortsatt underveis. Bounded til
 * `MAX_OPERATION_POLLS` - ALDRI en uendelig venting.
 */
async function waitForOperation(projectId: string, zone: string, operationName: string, accessToken: string, pollIntervalMs: number): Promise<void> {
  for (let poll = 0; poll < MAX_OPERATION_POLLS; poll++) {
    const operation = (await gceRequest({
      method: "GET",
      path: `projects/${projectId}/zones/${zone}/operations/${operationName}`,
      accessToken
    })) as unknown as GceOperation;
    if (operation.status === "DONE") {
      const firstError = operation.error?.errors?.[0];
      if (firstError) {
        throw new Error(`gce_operation_failed:${firstError.code ?? "UNKNOWN"}:${(firstError.message ?? "").slice(0, 160)}`);
      }
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("gce_operation_poll_timeout");
}

export class GceTransport implements ToolTransport {
  /** `operationPollIntervalMs` er et bevisst test-hull (SAMME "injiserbar timeout"-mønster som `DockerTransport` sin `timeoutMs`) - produksjon bruker ALLTID default-verdien, aldri en env-lest overstyring (ingen legitim grunn til å endre pollingtakten mot en ekte GCE-instans). */
  constructor(
    private readonly projectId: string | undefined = process.env["JARVIS_GOOGLE_CLOUD_PROJECT_ID"],
    private readonly operationPollIntervalMs: number = OPERATION_POLL_INTERVAL_MS
  ) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!this.projectId) throw new Error("gce_project_id_not_configured");
    const accessToken = await googleAccessToken(credential);

    switch (action) {
      case "list_instances": {
        const zone = parameters["zone"];
        assertValidPathSegment(zone, "zone");
        const body = await gceRequest({ method: "GET", path: `projects/${this.projectId}/zones/${zone}/instances`, accessToken });
        const instances = (body as { items?: JsonValue[] }).items ?? [];
        return { data: instances as unknown as JsonValue };
      }
      case "get_instance": {
        const { zone, instanceName } = this.requireTarget(parameters);
        const body = await gceRequest({ method: "GET", path: `projects/${this.projectId}/zones/${zone}/instances/${instanceName}`, accessToken });
        return { data: body };
      }
      case "start_instance":
        return this.mutate(parameters, accessToken, "start");
      case "stop_instance":
        return this.mutate(parameters, accessToken, "stop");
      case "reset_instance":
        return this.mutate(parameters, accessToken, "reset");
      default:
        throw new Error(`gce_action_not_implemented:${action}`);
    }
  }

  private requireTarget(parameters: Record<string, JsonValue>): { zone: string; instanceName: string } {
    const zone = parameters["zone"];
    const instanceName = parameters["instance_name"];
    assertValidPathSegment(zone, "zone");
    assertValidPathSegment(instanceName, "instance_name");
    return { zone, instanceName };
  }

  /**
   * Utsteder mutasjonskallet, poller den returnerte operasjonen til DONE,
   * og leser DERETTER den faktiske instans-tilstanden på nytt - `invoke()`
   * returnerer ALDRI før den ekte, konvergerte sluttilstanden er bekreftet
   * (ALDRI kun operasjonens egen "akseptert"-signal).
   */
  private async mutate(
    parameters: Record<string, JsonValue>,
    accessToken: string,
    verb: "start" | "stop" | "reset"
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zone, instanceName } = this.requireTarget(parameters);
    const operation = (await gceRequest({
      method: "POST",
      path: `projects/${this.projectId}/zones/${zone}/instances/${instanceName}/${verb}`,
      accessToken
    })) as unknown as GceOperation;
    const operationName = operation.name;
    if (!operationName) throw new Error("gce_operation_response_missing_name");
    await waitForOperation(this.projectId!, zone, operationName, accessToken, this.operationPollIntervalMs);
    const finalState = await gceRequest({ method: "GET", path: `projects/${this.projectId}/zones/${zone}/instances/${instanceName}`, accessToken });
    return { external_id: operationName, data: finalState };
  }
}
