import { z } from "zod";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { MemoryWriter } from "@jarvis/memory";
import { authorizeDockerTarget, type DockerMutationAction } from "./docker-target-policy.ts";
import { authorizeGceTarget, type GceMutationAction } from "./gce-target-policy.ts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";

/**
 * Første bølge-adaptere (INTEGRATIONS.md §3). Reelle HTTP-transporter krever
 * OAuth-/API-credentials som ikke finnes i miljøet - de er skall og er ærlig
 * UVERIFISERTE. FakeTransport brukes i tester og beviser hele pipelinen.
 * Q-07 (Gmail vs. Outlook) er åpen: adapterne er leverandørnøytrale kontrakter;
 * gmail-* er skallnavn fordi INTEGRATIONS.md lister Gmail i første bølge.
 */
export class FakeTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  constructor(
    private readonly reply: (action: string, parameters: Record<string, JsonValue>) => { external_id?: string; data?: JsonValue } = () => ({ external_id: "ext-1" }),
    private readonly failWith?: string
  ) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    this.calls.push({ action, parameters });
    return this.reply(action, parameters);
  }
}

/** HTTP-skall: kaster til reelle credentials/endepunkt konfigureres. */
export class UnconfiguredHttpTransport implements ToolTransport {
  constructor(private readonly service: string) {}
  async invoke(): Promise<never> {
    throw new Error(`${this.service}_not_configured`);
  }
}

const empty = z.object({}).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82): `read_permissions`
 * som preflight beviser KUN at FILEN har en (evt. tom) tilgangsliste - for
 * `update_permission`/`delete_permission`, som begge har et EGET
 * `permission_id` som identifiserer AKKURAT HVILKEN tilgang som skal endres,
 * er det IKKE tilstrekkelig: en fil med ANDRE tilganger, men uten NØYAKTIG
 * den påståtte `permission_id`-en, passerte tidligere den grovere sjekken og
 * lot en klasse D-mutasjon gå mot en tilgang som aldri fantes. `create_permission`
 * har IKKE et `permission_id`-parameter (den OPPRETTER en) og bruker derfor
 * bevisst IKKE denne - den grovere fil-eksistens-sjekken er riktig for den.
 */
/** Del 3: etterbetingelse for `create_permission` - en tilgang med forespurt rolle/type/mottaker finnes nå. */
function drivePermissionCreated(data: JsonValue, parameters: Record<string, JsonValue>): boolean {
  const permissions = (data as { permissions?: Array<{ role?: unknown; type?: unknown; emailAddress?: unknown; domain?: unknown }> } | null)?.permissions ?? [];
  return permissions.some((p) =>
    p?.role === parameters["role"] && p?.type === parameters["type"] &&
    (parameters["email_address"] === undefined || p?.emailAddress === parameters["email_address"]) &&
    (parameters["domain"] === undefined || p?.domain === parameters["domain"]));
}

function drivePermissionIdExists(data: JsonValue, parameters: Record<string, JsonValue>): boolean {
  const permissions = (data as { permissions?: Array<{ id?: unknown }> } | null)?.permissions ?? [];
  return permissions.some((p) => p?.id === parameters["permission_id"]);
}

/**
 * Standard førstebølge-register. transportOverride lar tester injisere fakes.
 * D-105 host-fix: `config.dockerMutationTargets` er de EIER-KONFIGURERTE,
 * eksakte produksjons-containernavnene Tobias har autorisert for docker-
 * mutasjon (parset FØR kallet via `parseDockerMutationTargets(process.env[
 * "JARVIS_DOCKER_MUTATION_TARGETS"])` i main.ts/worker-main.ts - SAMME
 * "les env ÉN gang ved oppstart"-mønster som resten av denne funksjonen).
 * Tomt/utelatt -> INGEN produksjonsmål autorisert (fail-closed - sentinel-
 * mål er UPÅVIRKET, se docker-target-policy.ts).
 */
export function firstWaveTools(
  transports: Partial<Record<string, ToolTransport>> = {},
  config: {
    dockerMutationTargets?: ReadonlySet<string>;
    /** D-337: SAMME "eier-konfigurert produksjonsmål-autorisasjon"-mønster som `dockerMutationTargets` over, for GCE-mutasjon - se `gce-target-policy.ts`. */
    gceMutationTargets?: ReadonlySet<string>;
    /**
     * UA-10 P1 (D-160): domenepakker som eier sine EGNE `ToolDefinition`-lister
     * (f.eks. `@jarvis/situations` sin `situationsToolDefinitions()`) legges
     * inn HER, slik at komposisjons-roten fortsatt har NØYAKTIG ETT
     * `toolGateway.register(tool)`-sted (regresjonsvakten i
     * `apps/api/test/drive-runtime-wiring.test.ts`) - aldri en parallell,
     * separat registreringsløkke. Ren tilføyelse på slutten av listen.
     */
    additionalTools?: readonly ToolDefinition[];
  } = {}
): ToolDefinition[] {
  const transport = (key: string) => transports[key] ?? new UnconfiguredHttpTransport(key);
  const dockerMutationTargets = config.dockerMutationTargets ?? new Set<string>();
  const dockerTargetAuthorizer = (action: DockerMutationAction) => (parameters: Record<string, JsonValue>) => {
    const name = parameters["name"];
    if (typeof name !== "string") return { allowed: false, reason: "missing_name_parameter" };
    return authorizeDockerTarget(action, name, dockerMutationTargets);
  };
  const gceMutationTargets = config.gceMutationTargets ?? new Set<string>();
  const gceTargetAuthorizer = (action: GceMutationAction) => (parameters: Record<string, JsonValue>) => {
    const zone = parameters["zone"];
    const instanceName = parameters["instance_name"];
    if (typeof zone !== "string" || typeof instanceName !== "string") return { allowed: false, reason: "missing_target_parameters" };
    return authorizeGceTarget(action, zone, instanceName, gceMutationTargets);
  };
  return [
    {
      tool_id: "github", action: "read_issues", description: "Les issues (untrusted ingestion)",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      // UA-5 D-41-audit (2026-08-20): "aldri merge" var en TIDLIGERE
      // begrensning fordi ingen merge-handling fantes ennå - IKKE et
      // permanent forbud. Merge finnes nå separat som `merge_pr` (klasse D,
      // se SLUTTEN av arrayet) - denne handlingen oppretter/finner PR-en,
      // den utfører aldri selve mergingen.
      tool_id: "github", action: "create_pr", description: "Opprett PR fra jobb-branch (idempotent - finner eksisterende åpen PR for samme head/base ved 422)",
      input_schema: record({ repo: z.string(), branch: z.string(), title: z.string(), base: z.string().optional(), body: z.string().optional() }),
      capability_class: "C", scopes: ["repo:write-pr"], reversible: true,
      rollback_procedure: "lukk PR (github.update_pr med state=closed)", idempotent_external: true, timeout_ms: 15_000,
      rate_limit_per_minute: 10, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "calendar", action: "read_events", description: "Les kalender",
      input_schema: record({ from: z.string(), to: z.string() }), capability_class: "A",
      scopes: ["calendar.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("calendar")
    },
    {
      tool_id: "calendar", action: "create_event", description: "Opprett kalenderhendelse",
      input_schema: record({ title: z.string(), start: z.string(), end: z.string() }),
      capability_class: "C", scopes: ["calendar.events"], reversible: true,
      rollback_procedure: "slett opprettet hendelse via external_id", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("calendar")
    },
    {
      tool_id: "email", action: "read_inbox", description: "Les e-post (untrusted ingestion)",
      input_schema: record({ max: z.number().int().min(1).max(50) }), capability_class: "A",
      scopes: ["mail.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_EMAIL_TOKEN", output_trust: "untrusted", transport: transport("email")
    },
    {
      // Sending av e-post er klasse D i startfasen (INTEGRATIONS.md: alltid godkjenning).
      tool_id: "email", action: "send", description: "Send e-post (krever signert godkjenning)",
      input_schema: record({ to: z.string().max(254), subject: z.string().max(200), body: z.string().max(100_000) }),
      capability_class: "D", scopes: ["mail.send"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "internal", transport: transport("email"),
      // Del 3: ingen forhåndseksisterende tilstand - mottaker valideres i transporten, Gmail sin melding-ID er etterbetingelsen.
      class_d_profile: "outbound_message"
    },
    {
      tool_id: "drive", action: "read_document", description: "Les dokument (untrusted ingestion)",
      input_schema: record({ document_id: z.string(), mime_type: z.string().optional() }), capability_class: "A",
      scopes: ["drive.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "telegram", action: "notify", description: "Send varsel til Tobias",
      input_schema: record({ message: z.string().max(4000) }), capability_class: "B",
      scopes: ["bot:send"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TELEGRAM_TOKEN", output_trust: "internal", transport: transport("telegram")
    },
    {
      tool_id: "vercel", action: "read_deployments", description: "Les deploy-status (GET /v6/deployments, valgfritt filtrert på prosjekt)",
      input_schema: record({ project: z.string().max(200).optional() }), capability_class: "A", scopes: ["deployments:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
    },
    /**
     * D-388 (D-41 full kapabilitet for Vercel, den bredere vurderingen D-248 utsatte). Endepunkter verifisert mot
     * Vercel sin egen REST-API-dokumentasjon 2026-10-04, se `VercelTransport` sin doc-kommentar. Lesing (A): prosjekter,
     * én deployment, env-NØKLER (aldri verdier). Skriving: `upsert_env` (C - endrer kjørende konfig ved neste bygg),
     * `promote_deployment`/`rollback_deployment` (C - flytter produksjonstrafikk, reversibelt med motsatt handling),
     * `cancel_deployment` (B). `redeploy` (nytt bygg) er BEVISST DEFERRED.
     */
    {
      tool_id: "vercel", action: "list_projects", description: "List Vercel-prosjekter (GET /v9/projects)",
      input_schema: empty, capability_class: "A", scopes: ["projects:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "read_deployment", description: "Les én deployment (GET /v13/deployments/{id}): tilstand, URL, mål, git-meta",
      input_schema: record({ deployment_id: z.string().min(1).max(200) }), capability_class: "A", scopes: ["deployments:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "list_env", description: "List miljøvariabel-NØKLER for et prosjekt (GET /v9/projects/{id}/env) - verdier returneres aldri",
      input_schema: record({ project: z.string().min(1).max(200) }), capability_class: "A", scopes: ["env:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "upsert_env", description: "Opprett/oppdater en miljøvariabel for et prosjekt (POST /v10/projects/{id}/env?upsert=true) - virker ved neste bygg",
      input_schema: record({
        project: z.string().min(1).max(200), key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), value: z.string().max(65_536),
        target: z.array(z.enum(["production", "preview", "development"])).min(1).optional(), sensitive: z.boolean().optional()
      }),
      capability_class: "C", scopes: ["env:write"], reversible: true,
      rollback_procedure: "sett forrige verdi på nytt via upsert_env (forrige verdi må hentes fra Vercel-dashbordet)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "internal", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "promote_deployment", description: "Promoter en eksisterende deployment til produksjon (POST /v10/projects/{id}/promote/{deploymentId}) - bygger ikke på nytt",
      input_schema: record({ project: z.string().min(1).max(200), deployment_id: z.string().min(1).max(200) }),
      capability_class: "C", scopes: ["deployments:write"], reversible: true,
      rollback_procedure: "promoter forrige produksjonsdeployment på nytt, eller bruk rollback_deployment", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "internal", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "rollback_deployment", description: "Rull produksjon tilbake til en tidligere deployment (POST /v1/projects/{id}/rollback/{deploymentId})",
      input_schema: record({ project: z.string().min(1).max(200), deployment_id: z.string().min(1).max(200) }),
      capability_class: "C", scopes: ["deployments:write"], reversible: true,
      rollback_procedure: "promoter den nyere deploymenten igjen via promote_deployment", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "internal", transport: transport("vercel")
    },
    {
      tool_id: "vercel", action: "cancel_deployment", description: "Avbryt en pågående deployment/bygg (PATCH /v12/deployments/{id}/cancel)",
      input_schema: record({ deployment_id: z.string().min(1).max(200) }),
      capability_class: "B", scopes: ["deployments:write"], reversible: false,
      rollback_procedure: "start et nytt bygg fra git (redeploy er ikke bygget her - gjøres i Vercel-dashbordet)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "internal", transport: transport("vercel")
    },
    {
      // UA-2 P0: repo-metadata for kunnskaps-ingestion (samme scope som read_issues).
      // Lagt til på SLUTTEN av arrayet med hensikt - eksisterende tester bruker
      // posisjonsindeks (f.eks. firstWaveTools({...})[4]) inn i dette arrayet,
      // og en innsetting midt i listen ville forskjøvet dem (regresjon funnet
      // og fikset under denne BO-en).
      tool_id: "github", action: "read_repo_meta", description: "Les repo-metadata (untrusted ingestion)",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      // UA-2 P1A §18/§24: én side av en Drive-filliste (mappe-scope ELLER hele
      // driven - avgjøres av `folder_id`-parameteren fra kilden, aldri en
      // default her). Lagt til på SLUTTEN av samme grunn som read_repo_meta
      // over - eksisterende tester indekserer dette arrayet posisjonelt.
      tool_id: "drive", action: "list_files", description: "List filer i en Drive-mappe eller hele driven (untrusted ingestion)",
      input_schema: record({ folder_id: z.string().optional(), page_token: z.string().optional() }),
      capability_class: "A", scopes: ["drive.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "untrusted", transport: transport("drive")
    },
    // UA-2 P1A scope-endring (2026-08-16, se OWNER CONNECTOR CAPABILITY
    // INVARIANT i CLAUDE.md): Google Drive full read/write/permissions -
    // produksjons-scope er `https://www.googleapis.com/auth/drive` (bekreftet
    // mot Google sitt offisielle Drive API v3-discovery-dokument, IKKE gjettet
    // - `drive.file` dekker kun app-opprettede filer, utilstrekkelig for full
    // tilgang). Lagt til på SLUTTEN av arrayet av samme grunn som de
    // eksisterende drive-oppføringene over - eksisterende tester indekserer
    // posisjonelt.
    {
      tool_id: "drive", action: "get_metadata", description: "Les filmetadata (id/navn/foreldre/trashed/revisjon) - brukes også som preflight/konfliktsjekk før mutasjoner",
      input_schema: record({ file_id: z.string() }), capability_class: "A",
      scopes: ["drive.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "read_permissions", description: "Les delinger/tilgangsstyring på en fil",
      input_schema: record({ file_id: z.string() }), capability_class: "A",
      scopes: ["drive.permissions.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "create_file", description: "Opprett en ny tekstfil i Drive (valgfri mappe)",
      input_schema: record({ name: z.string(), content: z.string().optional(), mime_type: z.string().optional(), parent_folder_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "legg det opprettede dokumentet (external_id) i papirkurven", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "create_folder", description: "Opprett en ny mappe i Drive (valgfri foreldremappe)",
      input_schema: record({ name: z.string(), parent_folder_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "legg den opprettede mappen (external_id) i papirkurven", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "update_content", description: "Erstatt innholdet i en eksisterende Drive-fil (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), content: z.string(), mime_type: z.string().optional(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gjenopprett forrige innhold via Drive sin revisjonshistorikk", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "rename", description: "Gi en Drive-fil/mappe et nytt navn (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), new_name: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gi tilbake det opprinnelige navnet", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "move", description: "Flytt en Drive-fil/mappe til en ny foreldremappe (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), new_parent_folder_id: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "flytt tilbake til den opprinnelige foreldremappen", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "trash", description: "Legg en Drive-fil/mappe i papirkurven (reversibelt - IKKE permanent sletting; valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gjenopprett fra papirkurven (trashed=false)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      // Drive sin `files.delete` er PERMANENT (bekreftet mot API-dokumentasjonen -
      // flytter IKKE til papirkurv). Klasse D: irreversibel, samme mønster som
      // email.send.
      // Q-34-revisjon: `get_metadata` KASTER allerede på et ukjent `file_id`
      // (`drive_not_found_...`, live-transports.ts) - `preflight_requires_target`
      // er derfor et strukturelt sikkerhetsnett, ikke en oppførselsendring.
      tool_id: "drive", action: "delete_permanent", description: "Slett en Drive-fil/mappe PERMANENT (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string() }), capability_class: "D",
      scopes: ["drive.delete"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata", preflight_requires_target: true,
      postcondition_target_absent: true
    },
    {
      // Deling/tilgangsstyring er sikkerhetskritisk (kan eksponere innhold for
      // nye parter) - klasse D uavhengig av at selve handlingen teknisk er
      // reverserbar (fjerne tilgangen igjen).
      // Q-34-revisjon: `read_permissions` returnerer ALDRI `data: null` for en
      // EKSISTERENDE fil (en fil uten delinger gir `{permissions: []}` - en
      // gyldig, DEFINERT verdi) og kaster på ukjent `file_id` - "tom" og
      // "finnes ikke" er derfor aldri det samme svaret her.
      tool_id: "drive", action: "create_permission", description: "Del en Drive-fil/mappe med en bruker/domene/alle (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), role: z.string(), type: z.string(), email_address: z.string().optional(), domain: z.string().optional() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "fjern den opprettede tilgangen (delete_permission)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions", preflight_requires_target: true,
      postcondition_predicate: drivePermissionCreated
    },
    {
      tool_id: "drive", action: "update_permission", description: "Endre rollen på en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string(), role: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "sett rollen tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions",
      preflight_requires_target: true, preflight_target_check: drivePermissionIdExists,
      postcondition_predicate: (after, params) => (after as { permissions?: Array<{ id?: unknown; role?: unknown }> } | null)?.permissions?.some((p) => p?.id === params["permission_id"] && p?.role === params["role"]) === true
    },
    {
      tool_id: "drive", action: "delete_permission", description: "Fjern en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "gjenopprett tilgangen manuelt (ikke automatisk reverserbar)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions",
      preflight_requires_target: true, preflight_target_check: drivePermissionIdExists,
      postcondition_predicate: (after, params) => !drivePermissionIdExists(after, params)
    },
    // UA-2 P1B-A §2: e-post-vedlegg-ingestion - full meldingslisting (body-tekst
    // + vedleggs-MIME-metadata) og separat vedleggsnedlasting. Lagt til på
    // SLUTTEN av arrayet av samme grunn som alle tidligere tillegg over -
    // eksisterende tester indekserer dette arrayet posisjonelt.
    {
      tool_id: "email", action: "list_messages", description: "List e-post FULLT (body-tekst + vedleggs-MIME-metadata) for ingestion",
      input_schema: record({ max: z.number().int().min(1).max(50), query: z.string().optional() }),
      capability_class: "A", scopes: ["mail.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "untrusted", transport: transport("email")
    },
    {
      tool_id: "email", action: "read_attachment", description: "Last ned RÅ bytes for ETT e-postvedlegg (standard base64, untrusted ingestion)",
      input_schema: record({ message_id: z.string(), attachment_id: z.string() }),
      capability_class: "A", scopes: ["mail.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "untrusted", transport: transport("email")
    },
    // UA-3 business-event-linkage (D-57): struktur-fokusert kalenderlisting med
    // faktiske deltaker-e-poster + html_link - brukes til deterministisk
    // kontakt-/selskaps-gjenkjenning (§9 i byggeordren), IKKE av personlig
    // daily brief (som fortsatt bruker read_events uendret). Lagt til på
    // SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "calendar", action: "list_events", description: "List kalenderhendelser MED deltaker-e-poster + kilde-lenke (untrusted ingestion, for forretnings-entitetsgjenkjenning)",
      input_schema: record({ from: z.string(), to: z.string(), max: z.number().int().min(1).max(50).optional() }),
      capability_class: "A", scopes: ["calendar.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "untrusted", transport: transport("calendar")
    },
    // UA-3 P0 (Business Domain Foundation, D-49): rent internt Business Graph-
    // verktøy - INGEN ekstern leverandør, `credential_ref` er en ikke-hemmelig
    // sentinel (se @jarvis/business sin BusinessInternalSecretProvider) kun
    // for å tilfredsstille ToolGateway sin ubetingede credential-sjekk.
    // `tenant_id`/`memory_space` MÅ bygges av TRUSTED kallerlag (identity),
    // ALDRI av modell-output - samme presedens som calendar/email/github sin
    // trusted parameterbygging i mesh-bridge.ts (ToolTransport.invoke() får
    // ikke IdentityContext - kjent, delt arkitekturbegrensning, ikke ny her).
    // Lagt til på SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "create_company", description: "Opprett et forretningsselskap (kunde/prospect)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), domain: z.string().optional(), status: z.string().optional(), source: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status til 'inactive'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_contact", description: "Opprett en forretningskontakt (person hos et selskap)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), company_id: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), title: z.string().optional(), source: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - korriger via ny create_contact/oppdatering", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_lead", description: "Opprett/idempotent-oppdater en lead (idempotent naar source_type+source_instance_id+external_id oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), status: z.string().optional(), source: z.string().optional(), source_type: z.string().optional(), source_instance_id: z.string().optional(), external_id: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status til 'disqualified'", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "update_lead_status", description: "Endre status-stadiet til en lead",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), lead_id: z.string(), status: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_opportunity", description: "Opprett en salgsmulighet/deal",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), lead_id: z.string().optional(), stage: z.string().optional(), value_ore: z.number().optional(), currency: z.string().optional(), expected_close_date: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett stage til 'lost'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "update_opportunity_stage", description: "Flytt en salgsmulighet til et nytt pipeline-stadium (og valgfritt oppdater endelig verdi)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), opportunity_id: z.string(), stage: z.string(), value_ore: z.number().optional() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett stage (og value_ore) tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "record_activity", description: "Registrer en forretningsaktivitet i tidslinjen (idempotent naar source_type+source_instance_id+external_id oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), activity_type: z.string(), summary: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), opportunity_id: z.string().optional(), lead_id: z.string().optional(), source_type: z.string().optional(), source_instance_id: z.string().optional(), external_id: z.string().optional(), canonical_uri: z.string().optional(), owner_person_id: z.string().optional(), occurred_at: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - append-only tidslinje", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_company_timeline", description: "Les komplett aktivitetstidslinje for ett selskap ('hva skjer med kunde X?')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_followup", description: "Opprett en oppfoelging/TODO knyttet til kunde/selskap/deal (idempotent naar idempotency_key oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), due_at: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), opportunity_id: z.string().optional(), lead_id: z.string().optional(), activity_id: z.string().optional(), reason: z.string().optional(), next_action: z.string().optional(), priority: z.string().optional(), owner_person_id: z.string().optional(), idempotency_key: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "avbryt oppfoelgingen (cancel_followup)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "complete_followup", description: "Marker en oppfoelging som fullført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), followup_id: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - opprett ny oppfoelging ved behov", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "cancel_followup", description: "Avbryt en åpen oppfoelging",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), followup_id: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - opprett ny oppfoelging ved behov", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "list_overdue_followups", description: "List forfalte, åpne oppfoelginger (hvem trenger oppfoelging nå)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), as_of: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_metrics", description: "Les grunnleggende drifts-metrikker (åpne leads, aktive muligheter, pipeline-verdi, forfalte oppfoelginger)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 neste slice (D-53): automatisk open-loop-deteksjon + daglig/ukentlig
    // business-brief. Samme "business"-transport/credential-sentinel som P0 -
    // lagt til på SLUTTEN av arrayet, samme grunn som øvrige senere tilføyelser.
    {
      tool_id: "business", action: "list_open_loops", description: "List open loops (uloeste forretningsforhold) for tenanten",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_open_loop", description: "Les ett open loop med full begrunnelse/kilde-referanse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_attention_queue", description: "Les prioritert oppmerksomhets-kø (critical/overdue/due_soon/informational) over aapne open loops",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_business_brief", description: "Generer daglig eller ukentlig business-brief (period: 'daily'|'weekly')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), period: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "resolve_open_loop", description: "Marker et open loop som loest (manuell resolusjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), resolution_reason: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - deteksjon gjenaapner automatisk hvis vilkaaret fortsatt er sant", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "defer_open_loop", description: "Utsett (snooze) et open loop til en ny forfallsdato",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), due_at: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett due_at tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "assign_open_loop", description: "Tildel et open loop til en eier/ansvarlig person",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), owner_person_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "tildel tilbake til forrige eier", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "set_open_loop_next_action", description: "Oppdater anbefalt neste handling for et open loop",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), next_action: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett next_action tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 business-event-linkage (D-57): synkroniser Gmail/Calendar via de
    // EKSISTERENDE UA-0/UA-7-P0-connectorene inn i Business OS-tidslinjen -
    // deterministisk kontakt-/selskaps-gjenkjenning, ALDRI kildeinnhold kopiert
    // (§15). Skriver KUN via `BusinessService.recordActivity()` sin allerede
    // idempotente `ON CONFLICT (tenant_id, source_type, source_instance_id,
    // external_id)` - ingen ny idempotens-mekanisme. Klasse B (interne
    // forretnings-tilstandsskrivinger avledet fra allerede-autoriserte
    // lese-handlinger - samme klasse som `record_activity` selv). Lagt til på
    // SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "sync_business_events", description: "Synkroniser nylige Gmail/Calendar-hendelser inn i forretningstidslinjen (deterministisk kontakt-/selskaps-gjenkjenning, aldri gjettet)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - append-only tidslinje, re-sync er trygt (idempotent)", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 profiling/scoring-slice (D-61): transparent, deterministisk
    // BUSINESS-OPERASJONELL prioritering/risiko-scoring over lead/opportunity
    // (akseptansekriterium 4) - ALDRI generalisert personprofilering (§4/§11 i
    // byggeordren). Scoren er ALLTID forklarbar (faktorer+kilde-referanser er
    // en del av selve svaret på hver lesing) og utleder ALDRI en autonom
    // hoy-konsekvens personbeslutning - kun intern prioriteringstilstand.
    // Klasse A for alle lesinger (samme som read_metrics/list_open_loops).
    // Lagt til på SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "get_lead_score", description: "Les gjeldende prioritets-score for en lead, med full faktor-/kilde-forklaring",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), lead_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_opportunity_score", description: "Les gjeldende risiko-score for en opportunity, med full faktor-/kilde-forklaring",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), opportunity_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "explain_score", description: "Les gjeldende score for en vilkaarlig entitet (entity_type: 'lead'|'opportunity') med full begrunnelse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "rank_leads", description: "Ranger leads etter gjeldende prioritets-score (hoyest foerst)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "rank_opportunities", description: "Ranger opportunities etter gjeldende risiko-score (hoyest foerst)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "recalculate_score", description: "Tving rekalkulering av scoren for én lead/opportunity (idempotent - samme regelsett, ny beregning)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - rekalkulering er idempotent og overskriver kun tidligere beregnet score, aldri manuell overstyring", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "set_manual_override", description: "Sett en eier-autorisert manuell overstyring av en scores prioriteringsverdi (endrer ALDRI de underliggende faktorene/kildedataene)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string(), override_score: z.number(), reason: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "clear_manual_override (tilbake til beregnet score)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "clear_manual_override", description: "Fjern en manuell overstyring - gaar tilbake til den sist beregnede scoren",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - sett en ny manuell overstyring ved behov (set_manual_override)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 Native Jarvis Support Core (D-66) §19/§20: provider-nøytralt
    // support.*-namespace - JARVIS_CANONICAL, ZERO ekstern support-
    // leverandør-avhengighet (D-64). Lagt til på SLUTTEN av samme grunn som
    // read_repo_meta/list_files over - eksisterende tester indekserer dette
    // arrayet posisjonelt.
    {
      tool_id: "support", action: "create_ticket", description: "Opprett en support-ticket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), subject: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), priority: z.string().optional(), assignee_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status til 'closed'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "get_ticket", description: "Les én support-ticket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "list_tickets", description: "List support-tickets etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "search_tickets", description: "Deterministisk filter-/fritekstsøk i support-tickets (ticket-nummer/selskap/kontakt/status/prioritet/ansvarlig/emne)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), priority: z.string().optional(),
        assignee_person_id: z.string().optional(), company_id: z.string().optional(), contact_id: z.string().optional(),
        subject_contains: z.string().optional(), ticket_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "update_ticket", description: "Oppdater status og/eller prioritet på en ticket i ett kall",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), status: z.string().optional(), priority: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status/prioritet tilbake via nytt update_ticket-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "set_status", description: "Deterministisk statusovergang (state-machine.ts - ugyldig overgang feiler trygt)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "set_priority", description: "Sett prioritet (low/normal/high/urgent) - ALDRI avledet fra beskyttede/sensitive kjennetegn",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), priority: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett prioritet tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "assign_ticket", description: "Tildel/fjern tildeling av en ticket (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), assignee_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "tildel tilbake til forrige ansvarlig", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "add_internal_note", description: "Legg til et internt notat (ALDRI kunde-synlig, sender ALDRI e-post)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), note: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - notater er append-only historikk", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "list_events", description: "List hele hendelseshistorikken for én ticket (kunde-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      // §16/§20 i byggeordren: kunde-synlig utgående kommunikasjon - klasse C.
      // Delegerer INTERNT til den EKSISTERENDE `email.send` (klasse D, krever
      // signert godkjenning) via ToolGateway/Policy Gateway igjen - denne
      // klassifiseringen svekker ALDRI den underliggende D-håndhevingen for
      // selve e-postutsendelsen.
      tool_id: "support", action: "reply", description: "Svar en kunde på en ticket (ruter GJENNOM eksisterende email.send, klasse D der)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), to: z.string(), subject: z.string(), body: z.string(), idempotency_key: z.string() }),
      capability_class: "C", scopes: ["support.write", "mail.send"], reversible: false,
      rollback_procedure: "send en oppfølgende korreksjon - selve e-posten kan ikke kalles tilbake", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      // Untrusted ingestion-vei (Gmail-normalisert melding) - se
      // `email-ingress.ts`. `ingest_message` selv skriver kun strukturerte
      // pekere (§11 pointer-not-payload), aldri rått eksternt innhold.
      tool_id: "support", action: "ingest_message", description: "Ingest en normalisert kanal-melding (kalles av email-ingress.ts, aldri direkte fra rå ekstern payload)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), channel: z.string().optional(),
        source_type: z.string(), source_instance_id: z.string(), source_thread_id: z.string(), source_message_id: z.string(),
        canonical_uri: z.string().optional(), subject: z.string(), summary: z.string(), is_from_customer: z.boolean(),
        entity_resolution: z.string().optional(), company_id: z.string().optional(), contact_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett ticket-status til 'closed'", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "untrusted", transport: transport("support")
    },
    // UA-3 Native Jarvis Contracts Core (D-71): provider-nøytralt
    // `contract.*`-namespace - JARVIS_CANONICAL, ZERO ekstern e-sign-
    // leverandør-avhengighet (D-71/D-64). Lagt til på SLUTTEN av samme
    // grunn som support.* over - eksisterende tester indekserer dette
    // arrayet posisjonelt. Ingen handling her er klasse D (ingen nøstet
    // e-sign-/utsendelseshandling i denne sliceen - juridisk
    // signeringsutførelse er en FREMTIDIG, valgfri adapter).
    {
      tool_id: "contract", action: "create_contract", description: "Opprett en kontrakt (motpart via eksisterende Business OS company/contact)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), contract_type: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), effective_date: z.string().optional(),
        start_date: z.string().optional(), end_date: z.string().optional(), termination_deadline: z.string().optional(),
        renewal_date: z.string().optional(), auto_renew: z.boolean().optional(), owner_person_id: z.string().optional(),
        canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett status til 'cancelled'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "get_contract", description: "Les én kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_contracts", description: "List kontrakter etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "search_contracts", description: "Deterministisk filter-/fritekstsøk i kontrakter (kontraktnummer/selskap/kontakt/status/eier/tittel)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), owner_person_id: z.string().optional(),
        title_contains: z.string().optional(), contract_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_by_company", description: "Hva har selskap X aktivt med oss? - deterministisk motparts-oppslag",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "upcoming_renewals", description: "Hvilke kontrakter fornyes snart?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "upcoming_termination_deadlines", description: "Hvilke avtaler utløper/har nærstående oppsigelsesfrist?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "cancellable_now", description: "Hvilke kontrakter kan vi si opp nå? (fortsatt innenfor oppsigelsesvinduet)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "due_obligations", description: "Hva forfaller snart på tvers av kontrakter? (\"What is due next?\")",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "overdue_obligations", description: "Hvilke forpliktelser er forfalt?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      // Deterministisk lifecycle-overgang (state-machine.ts) - klasse C: en
      // kontrakts juridiske/forretningsmessige status har et reelt effekt-
      // nivå utover en vanlig feltoppdatering (§"risk classes A-D based on
      // effect" i byggeordren), selv uten noen nøstet ekstern handling.
      tool_id: "contract", action: "set_status", description: "Deterministisk lifecycle-overgang (draft/review/approved/active/expiring/expired/terminated/cancelled)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_status-kall tilbake til forrige status (unntatt korreksjonsveien fra terminated/cancelled, som kun går til draft)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_owner", description: "Sett/fjern kontrakteier (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett eier tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "link_counterparty", description: "Oppdater motpart (selskap/kontakt) - gjenbruker eksisterende Business OS-entiteter",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett motpart tilbake via nytt link_counterparty-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_renewal_date", description: "Sett/fjern fornyelsesdato",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), renewal_date: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett dato tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_termination_deadline", description: "Sett/fjern oppsigelses-/kanselleringsfrist",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), termination_deadline: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett frist tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      // Kontraktversjoner er EKSPLISITTE og IMMUTABLE (byggeordren) - kun
      // append-only, aldri en oppdatering av en eksisterende versjon.
      tool_id: "contract", action: "add_version", description: "Legg til en ny, immutable kontraktversjon (pointer-not-payload - peker til dokumentet, kopierer aldri innholdet)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), summary: z.string(),
        source_type: z.string().optional(), source_instance_id: z.string().optional(), source_message_id: z.string().optional(),
        canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - versjoner er append-only historikk", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_versions", description: "List alle versjoner av en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "get_current_version", description: "Les gjeldende (nyeste) versjon av en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "add_obligation", description: "Legg til en forpliktelse (\"What must we do under this contract?\")",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), description: z.string(),
        owner_person_id: z.string().optional(), due_at: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "waive_obligation (marker som frafalt)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_obligations", description: "List forpliktelser for en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "complete_obligation", description: "Marker en forpliktelse som fullført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "reopen_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "waive_obligation", description: "Marker en forpliktelse som frafalt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "reopen_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "reopen_obligation", description: "Gjenåpne en fullført/frafalt forpliktelse (administrativ korreksjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "complete_obligation/waive_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_events", description: "List hele hendelseshistorikken for én kontrakt (kontrakt-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    // UA-4 Native Jarvis Growth Core (D-74): provider-nøytralt `growth.*`-
    // namespace - JARVIS_CANONICAL/HYBRID_WITH_CLEAR_AUTHORITY, ZERO
    // annonseplattform-avhengighet (D-74/D-64). Lagt til på SLUTTEN av
    // samme grunn som contract.* over - eksisterende tester indekserer
    // dette arrayet posisjonelt. Ingen handling her er klasse D (ingen
    // nøstet live budsjett-/bud-/kampanjeutførelse mot en ekstern
    // annonseplattform i denne sliceen - det er en FREMTIDIG, valgfri
    // adapter, se D-74 REPLACEMENT_PATH).
    {
      tool_id: "growth", action: "create_campaign", description: "Opprett en markedsføringskampanje (kanal-nøytral, ingen ekstern leverandør krevd)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), channel: z.string(), name: z.string(),
        budget_amount_ore: z.number().optional(), currency: z.string().optional(), external_campaign_id: z.string().optional(),
        canonical_uri: z.string().optional(), owner_person_id: z.string().optional(), started_at: z.string().optional(),
        actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "sett status til 'ended'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "get_campaign", description: "Les én kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_campaigns", description: "List kampanjer etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "search_campaigns", description: "Deterministisk filter-/fritekstsøk i kampanjer (kanal/status/eier/navn)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), channel: z.string().optional(),
        owner_person_id: z.string().optional(), name_contains: z.string().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_by_company", description: "Hvilke kampanjer har generert leads/opportunities for selskap X? - via attribusjon, ikke en direkte kampanje-selskap-kobling",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Deterministisk lifecycle-overgang (state-machine.ts) - klasse C: en
      // kampanjes operasjonelle status (aktiv/pause/avsluttet) har reell
      // budsjett-/forretningseffekt utover en vanlig feltoppdatering (§"risk
      // classes A-D based on effect" i byggeordren), selv uten noen nøstet
      // ekstern handling i denne sliceen.
      tool_id: "growth", action: "set_campaign_status", description: "Deterministisk lifecycle-overgang (draft/active/paused/ended)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_campaign_status-kall tilbake til forrige status (unntatt korreksjonsveien fra 'ended', som kun går til 'draft')",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "set_budget", description: "Sett/fjern kampanjebudsjett",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), budget_amount_ore: z.number().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "sett budsjett tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Idempotent per (kampanje, dato, kildetype) - re-synk av samme dag
      // oppdaterer SAMME rad (§"idempotent, auditable, before/after state"
      // i byggeordren), oppretter aldri en duplikatrad.
      tool_id: "growth", action: "record_spend_event", description: "Registrer/oppdater utgift for én kampanje-dag (manuelt/CSV-import/fremtidig live-synk)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), event_date: z.string(),
        spend_amount_ore: z.number(), currency: z.string().optional(), clicks: z.number().optional(), impressions: z.number().optional(),
        source_type: z.string().optional(), source_pointer: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "nytt record_spend_event-kall med korrigert beløp for SAMME (kampanje, dato, kildetype)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_spend_events", description: "List utgiftshistorikk for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "campaign_performance", description: "Deterministisk kampanje-funnel (leads/møter/opportunities/won/CAC/ROAS) knyttet til ekte CRM-data (business_activities.activity_type='meeting'/business_opportunities.value_ore/stage='won')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Deterministisk, EKSPLISITT kobling av kaller - ALDRI AI-utledet
      // (Q-26-grensen: ingen inferert kausal påstand i denne sliceen).
      tool_id: "growth", action: "attribute_to_campaign", description: "Koble en eksisterende lead/opportunity til en kampanje (deterministisk, eksplisitt - ingen AI-gjettet tilskrivning)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), entity_type: z.string(), entity_id: z.string(),
        attribution_model: z.string().optional(), source_pointer: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk attribusjonsrad", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_attributions", description: "List alle lead/opportunity-attribusjoner for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "create_experiment", description: "Opprett et eksperiment i eksperimentregisteret (valgfritt knyttet til en kampanje)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), hypothesis: z.string().optional(),
        campaign_id: z.string().optional(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "set_experiment_status til 'abandoned'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "get_experiment", description: "Les ett eksperiment",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), experiment_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_experiments", description: "List eksperimenter etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Klasse C: å konkludere/forlate et eksperiment låser et resultat som
      // fremtidige beslutninger bygger på - reelt effektnivå utover en
      // vanlig feltoppdatering.
      tool_id: "growth", action: "set_experiment_status", description: "Deterministisk lifecycle-overgang (draft/running/concluded/abandoned) + valgfri resultatoppsummering",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), experiment_id: z.string(), status: z.string(),
        result_summary: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "C", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_experiment_status-kall tilbake til forrige status (unntatt korreksjonsveien fra 'concluded'/'abandoned', som kun går til 'draft')",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_events", description: "List hele hendelseshistorikken for én kampanje (vekst-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-82: deterministisk UTM-/klikk-ID-basert auto-attribusjon (lukker
    // Q-29 punkt 6). Lagt til på SLUTTEN av samme grunn som resten av
    // growth.*-namespacet - eksisterende tester indekserer arrayet
    // posisjonelt. ZERO ekstern leverandør - ren Jarvis-intern
    // oppslagslogikk mot EGNE registrerte tagger (027/028_growth*.sql).
    {
      tool_id: "growth", action: "register_campaign_tracking_tag",
      description: "Registrer en sporingstagg (klikk-ID ELLER full utm_source/utm_medium/utm_campaign-triplett) på en kampanje - idempotent, EKSAKT matching",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(),
        actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "registrer en ny tagg med korrigerte verdier for SAMME kampanje (ingen direkte fjerning i denne sliceen - historisk sporingskonfigurasjon)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_campaign_tracking_tags", description: "List alle registrerte sporingstagger for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "resolve_campaign_from_tracking",
      description: "Deterministisk oppslag: hvilken kampanje (om noen) matcher disse sporingsparametrene EKSAKT? Returnerer null (aldri en gjettet kampanje) ved ingen match",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional()
      }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Klasse B, SAMME risikonivå som attribute_to_campaign (§9 i
      // byggeordren: denne handlingen ER attribute_to_campaign, bare nådd
      // via en deterministisk sporingsoppslag i stedet for en direkte
      // campaign_id - ingen AI-gjettet tilskrivning innføres.
      tool_id: "growth", action: "attribute_from_tracking",
      description: "Koble en eksisterende lead/opportunity til en kampanje via deterministisk sporingsoppslag (klikk-ID/utm) - kaster ved ingen EKSAKT match, gjetter aldri",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(),
        attribution_model: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk attribusjonsrad (samme som attribute_to_campaign)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-85: anomaly -> recommended-action control-plane-fundament.
    // BESLUTNINGS-lag ALENE - `resolve_action_recommendation` er klasse B
    // (REN Jarvis-intern disposisjon-sporing), ALDRI klasse C/D, siden
    // handlingen ALDRI utfører noe mot en ekte annonseplattform (ingen
    // provider-mutate-kapabilitet finnes for noen leverandør i denne
    // kodebasen ennå - Finance Integrity-grensen, D-83/UA-6).
    {
      tool_id: "growth", action: "list_action_recommendations", description: "List deterministiske kampanje-handlingsanbefalinger (generert av anomali-deteksjon), valgfritt filtrert på kampanje/status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "resolve_action_recommendation",
      description: "Marker en anbefaling som godkjent/avvist av eieren - REN Jarvis-intern disposisjon-sporing, utfører ALDRI noe mot en ekte annonseplattform",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), recommendation_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "kall på nytt med motsatt status (ingen provider-side-effekt å rulle tilbake)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-87: provider-nøytral UTFØRELSES-KOMMANDO-modell - det strukturelle
    // bindeleddet mellom D-85 sitt BESLUTNINGS-lag og en FREMTIDIG
    // utførelses-kapabilitet. `generate_execution_command`/
    // `cancel_execution_command` er klasse B (REN Jarvis-intern beregning/
    // kansellering) - ALDRI klasse C/D, siden INGEN kode noensinne kan
    // markere et command 'executed' (databasens CHECK-constraint inneholder
    // ikke den verdien i det hele tatt, se 030_growth_execution_commands.sql).
    {
      tool_id: "growth", action: "generate_execution_command",
      description: "Oversett en ALLEREDE eier-godkjent anbefaling til en presis, provider-nøytral budsjett-kommando - beregner KUN, utfører ALDRI noe mot en ekte annonseplattform",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), recommendation_id: z.string(), actor_person_id: z.string().optional(), reduction_fraction: z.number().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "kanseller kommandoen (cancel_execution_command) - ingen provider-side-effekt å rulle tilbake", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "cancel_execution_command",
      description: "Kanseller en ventende utførelses-kommando FØR den (aldri) noensinne kunne vært utført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), command_id: z.string(), actor_person_id: z.string().optional(), reason: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: false,
      rollback_procedure: "ingen (kansellering er en endelig disposisjon, samme prinsipp som avvist anbefaling)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_execution_commands", description: "List provider-nøytrale utførelses-kommandoer, valgfritt filtrert på kampanje/status - ALDRI utført av noen kode i denne sliceen",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-89 MARKETING MEMORY v1: et NARROW, deterministisk OBSERVASJON-lag
    // (`meetings_without_conversion`/`recommendation_disposition_summary`)
    // over ALLEREDE eksisterende kanonisk data - ALDRI en "sannhet"
    // (`status` har INGEN 'verified'-verdi), ALDRI et automatisk
    // handlingstriggerpunkt (kun lesing/deterministisk avledning, ZERO
    // kobling til D-85-anbefalinger/D-87-kommandoer utover å LESE deres
    // status som evidens). `generate_marketing_observations` er klasse B
    // (REN Jarvis-intern beregning/persistens av en observasjon, ALDRI en
    // provider-handling) - ALDRI klasse C/D.
    {
      tool_id: "growth", action: "generate_marketing_observations",
      description: "Avled deterministiske markedsførings-observasjoner for en kampanje (møter-uten-konvertering-gap, anbefaling/kommando-disposisjonsoppsummering) - ALDRI en kausal påstand, ALDRI AI-inferens",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen provider-side-effekt å rulle tilbake (ren intern observasjons-persistens)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_marketing_observations", description: "List markedsførings-observasjoner, valgfritt filtrert på kampanje/type/status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), observation_type: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // UA-4 Google Ads-slice (D-83): FØRSTE ekte leverandøradapter for
    // Growth Core - Google Ads er en ADAPTER (D-64), ALDRI domeneeier.
    // `list_campaigns` er en ren speilings-lesing (INGEN Jarvis-DB-skriving)
    // - klasse A. `sync_*` skriver INN i den EKSISTERENDE, kanoniske
    // Growth-modellen (via `GrowthService.upsertCampaignFromProvider()`/
    // `recordSpendEvent()`/`registerCampaignTrackingTag()`, ALDRI en ny
    // modell) - klasse B, SAMME nivå som `growth.record_spend_event`/
    // `growth.register_campaign_tracking_tag`. INGEN klasse D her - denne
    // sliceen implementerer BEVISST INGEN mutate-/budsjett-/bud-/
    // kampanje-skriving MOT Google (Finance Integrity-grensen, D-83 -
    // se DECISIONS_AND_ASSUMPTIONS.md for D-41-STOPP-begrunnelsen).
    {
      tool_id: "googleads", action: "list_campaigns", description: "Les kampanjeliste direkte fra Google Ads (GAQL, ingen Jarvis-DB-skriving - ren leverandør-speiling)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional() }),
      capability_class: "A", scopes: ["googleads.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      tool_id: "googleads", action: "sync_campaigns", description: "Synk kampanjeliste fra Google Ads inn i Growth Core (idempotent upsert via external_campaign_id, ingen ny domenemodell)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning - kampanjerader er historiske Growth Core-fakta, samme som growth.create_campaign", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      tool_id: "googleads", action: "sync_spend", description: "Synk daglig utgift/klikk/visning per kampanje fra Google Ads inn i marketing_spend_events (source_type=provider_sync, idempotent per kampanje+dato)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional(), start_date: z.string(), end_date: z.string() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "nytt sync_spend-kall overskriver SAMME (kampanje, dato, provider_sync)-rad ved korrigert kilde-tall", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      // D-82-integrasjon: gclid fra Google Ads sin click_view-ressurs
      // registrert som EKSAKT samme click_id_param-verdi D-82 sitt skjema
      // allerede anser gyldig - ingen skjemaendring, ingen gjettet
      // attribusjon (kalleren MÅ ha kjørt sync_campaigns FØRST for at en
      // kampanje skal finnes å knytte gclid-en til).
      tool_id: "googleads", action: "sync_tracking_tags", description: "Synk gclid fra Google Ads sin click_view-ressurs inn i marketing_campaign_tracking_tags for ÉN dato (D-82 deterministisk auto-attribusjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional(), date: z.string() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk sporingstagg (samme som growth.register_campaign_tracking_tag)", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    // D-335 (UA-4 Meta Ads-slice): SAMME Growth Core-adapter-arkitektur som
    // googleads.* over (D-64-korrekt - marketing_campaigns/spend_events
    // forblir JARVIS_CANONICAL, Meta er EXTERNAL_CANONICAL fakta-kilde).
    // access_token som QUERY-PARAMETER (ikke en Bearer-header) - se
    // MetaAdsTransport sin doc-kommentar for full D-41-begrunnelse.
    // sync_tracking_tags (fbclid) er BEVISST IKKE registrert her (D-41
    // DEFERRED - ingen bekreftet spørrbar fbclid-ressurs funnet).
    {
      tool_id: "metaads", action: "list_campaigns", description: "Les kampanjeliste direkte fra Meta Ads (Graph API, ingen Jarvis-DB-skriving - ren leverandør-speiling)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ad_account_id: z.string().optional() }),
      capability_class: "A", scopes: ["metaads.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_META_ADS_ACCESS_TOKEN",
      output_trust: "internal", transport: transport("metaads")
    },
    {
      tool_id: "metaads", action: "sync_campaigns", description: "Synk kampanjeliste fra Meta Ads inn i Growth Core (idempotent upsert via external_campaign_id, ingen ny domenemodell)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ad_account_id: z.string().optional() }),
      capability_class: "B", scopes: ["metaads.read", "growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning - kampanjerader er historiske Growth Core-fakta, samme som growth.create_campaign", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_META_ADS_ACCESS_TOKEN",
      output_trust: "internal", transport: transport("metaads")
    },
    {
      tool_id: "metaads", action: "sync_spend", description: "Synk daglig utgift/klikk/visning per kampanje fra Meta Ads Insights inn i marketing_spend_events (source_type=provider_sync, idempotent per kampanje+dato)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ad_account_id: z.string().optional(), start_date: z.string(), end_date: z.string() }),
      capability_class: "B", scopes: ["metaads.read", "growth.write"], reversible: true,
      rollback_procedure: "nytt sync_spend-kall overskriver SAMME (kampanje, dato, provider_sync)-rad ved korrigert kilde-tall", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_META_ADS_ACCESS_TOKEN",
      output_trust: "internal", transport: transport("metaads")
    },
    // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
    // Core - provider-nøytralt `consent.*`-namespace. `record_decision`
    // appender EN NY, permanent rad i en append-only-logg (ALDRI en UPDATE)
    // - klasse B (REN Jarvis-intern tilstandsskriving, ALDRI en provider-
    // handling/uigjenkallelig ekstern effekt). `get_current_state`/
    // `list_decisions`/`evaluate_processing_decision` er RENE lesinger -
    // klasse A. `evaluate_processing_decision` er den DETERMINISTISKE,
    // fail-closed håndhevings-kjernen (fravær av data -> ALDRI 'ALLOWED') -
    // ZERO ModelGateway noe sted i dette namespacet.
    {
      tool_id: "consent", action: "record_decision", description: "Registrer EN NY samtykke-/rettslig-grunnlag-beslutning for en kontakt+formål (append-only, ALDRI en overskriving av en tidligere beslutning). 'evidence' er KUN en proveniens-peker (kilde/skjema-versjon/kanal) - ALDRI hemmeligheter (tokens/nøkler/passord) eller full rå persondata-payload.",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string(),
        state: z.string(), legal_basis: z.string(), evidence: z.record(z.string(), z.unknown()).optional(),
        policy_version: z.string(), actor_person_id: z.string().optional(), expires_at: z.string().optional()
      }),
      capability_class: "B", scopes: ["consent.write"], reversible: true,
      rollback_procedure: "ingen sletting av rader - registrer en NY beslutning (f.eks. 'withdrawn') for å endre gjeldende tilstand", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "get_current_state", description: "Hent den nyeste registrerte samtykke-/rettslig-grunnlag-beslutningen for en kontakt+formål (null hvis ingen finnes)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "list_decisions", description: "List alle registrerte samtykke-beslutninger, valgfritt filtrert på kontakt/formål (fullstendig, append-only historikk)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string().optional(), purpose: z.string().optional() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "evaluate_processing_decision", description: "Deterministisk, fail-closed evaluering: kan denne kontaktens data behandles for dette formålet? (ALLOWED/DENIED/UNKNOWN_NOT_CONFIGURED - ALDRI en bar boolean, ZERO AI-inferens)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    // D-92 (UA-4 NESTE SLICE): Consent Enforcement Activation / Rollout v1 -
    // provider-nøytral aktiverings-flate for D-91-motoren. `get_enforcement_
    // policy` er RENT lesing - klasse A. `set_enforcement_policy` endrer KUN
    // Jarvis-intern rollout-konfigurasjon (disabled/audit/enforce) - ALDRI en
    // ekstern/leverandør-handling, ALDRI en samtykke-beslutning i seg selv -
    // klasse B, SAMME begrunnelse som `consent.record_decision`.
    {
      tool_id: "consent", action: "get_enforcement_policy", description: "Hent gjeldende håndhevings-modus (disabled/audit/enforce) for tenant+space+formål (disabled hvis ingen rad finnes - ALDRI stille 'enforce')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "set_enforcement_policy", description: "Sett håndhevings-modus (disabled/audit/enforce) for tenant+space+formål - eksplisitt eier-aktivering, ALDRI en påstand om at et datasubjekt faktisk har samtykket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), purpose: z.string(), mode: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["consent.write"], reversible: true,
      rollback_procedure: "sett modus tilbake til forrige verdi (f.eks. 'disabled') via et nytt set_enforcement_policy-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    // UA-5 GitHub Developer Control Plane v1 (2026-08-20, D-64: GitHub er
    // EXTERNAL_CANONICAL for repo/PR/workflow-tilstand - D-41-audit: forrige
    // to github-oppføringer over (read_issues/create_pr fra UA-2 P0, samt
    // read_repo_meta) var UTILSIKTET begrenset til lesing + "aldri merge" -
    // IKKE fordi GitHub mangler kapabilitet. Denne sliceen bygger den
    // gjenstående nyttige overflaten (branch/PR/issue/workflow-livssyklus)
    // - IKKE hvert eneste GitHub-endepunkt, kun det som materielt tjener
    // UA-5 sitt "tested-fix"-akseptansekriterium 2. Lagt til på SLUTTEN av
    // samme grunn som alle tidligere tillegg - eksisterende tester
    // indekserer dette arrayet posisjonelt.
    {
      tool_id: "github", action: "list_branches", description: "List branches i et repo",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "get_branch", description: "Les én branch (navn/sha/protected) - brukes også som preflight/recovery-grunnlag før delete_branch",
      input_schema: record({ repo: z.string(), branch: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "get_commit", description: "Les én commit (sha/melding/forfatter/dato)",
      input_schema: record({ repo: z.string(), ref: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "list_pull_requests", description: "List PR-er (valgfri state: open/closed/all)",
      input_schema: record({ repo: z.string(), state: z.string().optional() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "get_pull_request", description: "Les én PR (inkl. mergeable/mergeable_state) - brukes også som preflight/target-re-read før merge_pr",
      input_schema: record({ repo: z.string(), pr_number: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "list_workflow_runs", description: "List Actions-workflow-kjøringer (valgfri branch/status-filter)",
      input_schema: record({ repo: z.string(), branch: z.string().optional(), status: z.string().optional() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "get_workflow_run", description: "Les én Actions-workflow-kjøring (status/conclusion/head_sha)",
      input_schema: record({ repo: z.string(), run_id: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "list_workflow_jobs", description: "List jobber/steg for én Actions-workflow-kjøring (hvilken jobb/steg feilet)",
      input_schema: record({ repo: z.string(), run_id: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "create_branch", description: "Opprett en ny branch fra en gitt sha (idempotent - 422 'already exists' behandles som samme sluttilstand)",
      input_schema: record({ repo: z.string(), branch: z.string(), from_sha: z.string() }),
      capability_class: "B", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "github.delete_branch", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "update_pr", description: "Oppdater PR-metadata (tittel/body/state open|closed - ALDRI merged, se merge_pr)",
      input_schema: record({ repo: z.string(), pr_number: z.string(), title: z.string().optional(), body: z.string().optional(), state: z.string().optional() }),
      capability_class: "B", scopes: ["repo:write-pr"], reversible: true,
      rollback_procedure: "sett feltene tilbake til forrige verdi via et nytt update_pr-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "comment_on_issue", description: "Kommenter på et issue eller en PR (samme endepunkt)",
      input_schema: record({ repo: z.string(), issue_number: z.string(), body: z.string() }),
      capability_class: "C", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "ingen automatisk sletting av kommentaren bygget - manuell oppfølging", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "set_labels", description: "Sett HELE label-settet på et issue/PR (PUT - erstatter, ikke akkumulerer)",
      input_schema: record({ repo: z.string(), issue_number: z.string(), labels: z.array(z.string()) }),
      capability_class: "B", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "sett tilbake til forrige label-sett via et nytt set_labels-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "request_reviewers", description: "Be om reviewers på en PR",
      input_schema: record({ repo: z.string(), pr_number: z.string(), reviewers: z.array(z.string()) }),
      capability_class: "B", scopes: ["repo:write-pr"], reversible: true,
      rollback_procedure: "fjern forespørselen manuelt via GitHub (ingen egen remove-handling bygget denne sliceen)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "create_issue", description: "Opprett et nytt issue",
      input_schema: record({ repo: z.string(), title: z.string(), body: z.string().optional() }),
      capability_class: "B", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "github.update_issue med state=closed", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "update_issue", description: "Oppdater issue-metadata (tittel/body/state open|closed - dekker close/reopen)",
      input_schema: record({ repo: z.string(), issue_number: z.string(), title: z.string().optional(), body: z.string().optional(), state: z.string().optional() }),
      capability_class: "B", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "sett feltene tilbake til forrige verdi via et nytt update_issue-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "rerun_workflow_run", description: "Kjør en Actions-workflow-kjøring på nytt (valgfri failed_only for kun feilede jobber)",
      input_schema: record({ repo: z.string(), run_id: z.string(), failed_only: z.boolean().optional() }),
      capability_class: "C", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "github.cancel_workflow_run", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "github", action: "cancel_workflow_run", description: "Avbryt en pågående Actions-workflow-kjøring",
      input_schema: record({ repo: z.string(), run_id: z.string() }),
      capability_class: "C", scopes: ["repo:write"], reversible: true,
      rollback_procedure: "github.rerun_workflow_run", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      // Trigger av en ny workflow-kjøring (kan utløse deploy/CI-ressursbruk) -
      // klasse C, samme begrunnelse som create_pr (betydelig, men gjenopprettbar
      // via cancel_workflow_run av den utløste kjøringen).
      tool_id: "github", action: "dispatch_workflow", description: "Trigger en workflow_dispatch-kjøring på en gitt ref (valgfrie inputs)",
      input_schema: record({ repo: z.string(), workflow_id: z.string(), ref: z.string(), inputs: z.record(z.string(), z.string()).optional() }),
      capability_class: "C", scopes: ["repo:write", "actions:write"], reversible: true,
      rollback_procedure: "github.cancel_workflow_run på den utløste kjøringen", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      // Merge er UGJENKALLELIG i praksis (kun revert-commit, ikke ekte "unmerge") -
      // klasse D uavhengig av at branch-push/PR-opprettelse selv er reversible.
      // Sovereign owner-modus (D-41/UA0-AUTHORITY) utfører autonomt UTEN kunstig
      // godkjenningssperre - sikkerheten kommer fra preflight/target-re-read
      // (`get_pull_request` leser mergeable_state RETT FØR merge) + valgfri
      // `expected_head_sha` (sendes som GitHub sin egen `sha`-precondition på
      // merge-endepunktet - IKKE en Jarvis-oppfunnet sjekk) + full before/after-
      // audit (håndteres generisk av ToolGateway.execute() sin D-pipeline).
      tool_id: "github", action: "merge_pr", description: "Merge en PR (merge_method: merge|squash|rebase; valgfri expected_head_sha-precondition mot stale state)",
      input_schema: record({ repo: z.string(), pr_number: z.string(), merge_method: z.string().optional(), expected_head_sha: z.string().optional() }),
      capability_class: "D", scopes: ["repo:write-pr", "repo:merge"], reversible: false,
      rollback_procedure: "IKKE en ekte 'unmerge' - opprett en revert-PR (github.create_pr fra en revert-commit) og merge den, ELLER github.update_pr for å dokumentere avviket. Ikke reverserbar - derfor klasse D.",
      idempotent_external: false, timeout_ms: 15_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "internal", transport: transport("github"),
      // Q-34-revisjon: `get_pull_request` kaster allerede på et ukjent
      // `pr_number` (404 er ikke i GITHUB_RETRYABLE_STATUS, live-transports.ts)
      // - strukturelt sikkerhetsnett, ikke en oppførselsendring.
      preflight_action: "get_pull_request", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { merged?: unknown } | null)?.merged === true
    },
    {
      // Branch-sletting er PERMANENT hvis sha-en ikke er kjent fra andre steder -
      // klasse D, samme mønster som drive.delete_permanent. Strukturelt umulig å
      // slette main/master/production (GITHUB_PROTECTED_BRANCHES i transporten,
      // samme konvensjon som modules/tasks/src/coding.ts).
      tool_id: "github", action: "delete_branch", description: "Slett en branch PERMANENT (main/master/production strukturelt nektet)",
      input_schema: record({ repo: z.string(), branch: z.string() }), capability_class: "D",
      scopes: ["repo:write"], reversible: true,
      rollback_procedure: "gjenopprett branchen fra sha-en get_branch (preflight) fanget FØR sletting, via github.create_branch",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "internal", transport: transport("github"),
      // Q-34-revisjon: `get_branch` kaster allerede på en ukjent branch (samme
      // begrunnelse som merge_pr over).
      preflight_action: "get_branch", preflight_requires_target: true,
      postcondition_target_absent: true
    },
    {
      // D-105 (UA-5 kriterium 1): Docker-lesehandlinger - virker mot ETHVERT
      // containernavn (reell driftsdiagnostikk, ikke kun sentinel-mål).
      tool_id: "docker", action: "list_containers", description: "List kjørende Docker-containere (valgfritt label-filter)",
      input_schema: record({ label_filter: z.string().optional() }), capability_class: "A",
      scopes: ["docker:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "untrusted", transport: transport("docker")
    },
    {
      tool_id: "docker", action: "inspect_container", description: "Les én containers tilstand (id/image/status/health) - null hvis den ikke finnes",
      input_schema: record({ name: z.string() }), capability_class: "A",
      scopes: ["docker:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "untrusted", transport: transport("docker")
    },
    {
      tool_id: "docker", action: "get_logs", description: "Les containerlogger (bundet tidsvindu/tail, hemmeligheter redigert FØR retur)",
      input_schema: record({ name: z.string(), since: z.string().optional(), until: z.string().optional(), tail: z.number().optional() }),
      capability_class: "A", scopes: ["docker:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "untrusted", transport: transport("docker")
    },
    {
      // D-105 host-fix (D-41-korreksjon): mål-autorisasjon for DENNE
      // handlingen håndheves nå av `parameterAuthorizer` (docker-target-
      // policy.ts), IKKE av transporten (som transporterer rent - se
      // docker-transport.ts). `redeploy_container` sin nåværende
      // implementasjon (rm -f + run -d, kun navn/image bevart) er IKKE bevist
      // trygg mot en ekte kjørende produksjonscontainer (mounts/env/nettverk/
      // porter/restart-policy/healthcheck går tapt) - derfor forblir den
      // STRUKTURELT DEFERRED for produksjon (kun `jarvis-sentinel-*`, host-
      // akseptanse) inntil en konfigurasjonsbevarende redeploy er bygget og
      // bevist. `preflight_action: "inspect_container"` gjenbruker DEN
      // EKSISTERENDE ToolGateway-D-pipelinen (before/after via tool_executions)
      // UENDRET - se executeInfraMutation() i modules/incidents.
      // Q-34-revisjon: `preflight_requires_target` er BEVISST satt til `false`
      // her (EKSPLISITT, ikke utelatt - uavhengig arkitektkontroll av PR #82
      // påpekte at en utelatt boolean ikke beviser et FAKTISK revidert valg).
      // `inspect_container` svarer `data: null` for "container finnes ikke
      // ennå" (docker-transport.ts) som en LEGITIM førstegangs-deploy-tilstand
      // - strukturelt umulig å ha noen forutgående tilstand for den. Motsatt
      // av stop/start_container under, som KREVER en eksisterende container.
      tool_id: "docker", action: "redeploy_container", description: "Gjenskap en container med et gitt image (rm -f + run -d) - DEFERRED for produksjon, kun jarvis-sentinel-* (host-akseptanse) inntil konfigurasjonsbevarende redeploy er bevist",
      input_schema: record({ name: z.string(), image: z.string() }), capability_class: "D",
      scopes: ["docker:write"], reversible: true,
      rollback_procedure: "docker.redeploy_container på nytt med image-verdien fra preflight-inspeksjonen (before_state)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "internal", transport: transport("docker"),
      preflight_action: "inspect_container", preflight_requires_target: false, allows_missing_preflight_target: true,
      postcondition_predicate: (after, params) => {
        const c = after as { status?: unknown; image?: unknown } | null;
        return c?.status === "running" && c?.image === params["image"];
      },
      parameterAuthorizer: dockerTargetAuthorizer("redeploy_container")
    },
    {
      // D-105 host-fix (D-41-korreksjon): PRODUKSJONS-autorisert muterende
      // handling - endrer KUN kjøretilstand (docker stop), INGEN
      // konfigurasjon går tapt (motsatt av redeploy_container over) - derfor
      // tillatt mot ethvert EIER-KONFIGURERT mål (JARVIS_DOCKER_MUTATION_
      // TARGETS), ikke bare sentinel. Genuint reversibel: recovery starter
      // containeren igjen og reinspiserer for å VERIFISERE (se recovery.ts).
      tool_id: "docker", action: "stop_container", description: "Stopp en container (docker stop) - eier-konfigurert produksjonsmål ELLER jarvis-sentinel-* (akseptanse)",
      input_schema: record({ name: z.string() }), capability_class: "D",
      scopes: ["docker:write"], reversible: true,
      rollback_procedure: "docker.start_container mot samme mål, reinspisert for å verifisere kjøretilstand",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "internal", transport: transport("docker"),
      // Q-34-revisjon: i motsetning til redeploy_container over, finnes det
      // INGEN legitim "stopp en container som ikke finnes"-tilstand - null
      // preflight betyr her alltid "mål finnes ikke".
      preflight_action: "inspect_container", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { status?: unknown } | null)?.status !== "running",
      parameterAuthorizer: dockerTargetAuthorizer("stop_container")
    },
    {
      tool_id: "docker", action: "start_container", description: "Start en container (docker start) - eier-konfigurert produksjonsmål ELLER jarvis-sentinel-* (akseptanse)",
      input_schema: record({ name: z.string() }), capability_class: "D",
      scopes: ["docker:write"], reversible: true,
      rollback_procedure: "docker.stop_container mot samme mål, reinspisert for å verifisere kjøretilstand",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_DOCKER_BIN", output_trust: "internal", transport: transport("docker"),
      // Q-34-revisjon: samme begrunnelse som stop_container over.
      preflight_action: "inspect_container", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { status?: unknown } | null)?.status === "running",
      parameterAuthorizer: dockerTargetAuthorizer("start_container")
    },
    // D-337 (Google Cloud "servere"-sliceen, Tobias sin eksplisitte Q-41-
    // presisering i chat). SAMME "transporten transporterer, target-policy
    // autoriserer"-oppdeling som Docker over - se gce-target-policy.ts.
    // list_instances/get_instance er ren lesing (klasse A). start_instance/
    // stop_instance endrer KUN kjøretilstand (ingen data tapt) - SAMME
    // "bevist trygg mot produksjon"-status som Docker sin stop/start -
    // derfor PRODUKSJONS-autorisert (JARVIS_GCE_MUTATION_TARGETS) i tillegg
    // til sentinel. reset_instance er en HARD reboot (kan kappe pågående
    // skriving) - SAMME "ikke bevist trygg"-status som Docker sin
    // redeploy_container - derfor STRUKTURELT DEFERRED for produksjon (kun
    // jarvis-sentinel-*) inntil egen vurdering er gjort.
    {
      tool_id: "gce", action: "list_instances", description: "List GCE-instanser i én sone",
      input_schema: record({ zone: z.string() }), capability_class: "A",
      scopes: ["gce:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("gce")
    },
    {
      tool_id: "gce", action: "get_instance", description: "Les én GCE-instans sin tilstand",
      input_schema: record({ zone: z.string(), instance_name: z.string() }), capability_class: "A",
      scopes: ["gce:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("gce")
    },
    {
      tool_id: "gce", action: "start_instance", description: "Start en GCE-instans (asynkron - polles til DONE FØR retur) - eier-konfigurert produksjonsmål ELLER jarvis-sentinel-* (akseptanse)",
      input_schema: record({ zone: z.string(), instance_name: z.string() }), capability_class: "D",
      scopes: ["gce:write"], reversible: true,
      rollback_procedure: "gce.stop_instance mot samme mål, reinspisert for å verifisere kjøretilstand",
      idempotent_external: true, timeout_ms: 90_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN", output_trust: "internal", transport: transport("gce"),
      preflight_action: "get_instance", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { status?: string } | null)?.status === "RUNNING",
      parameterAuthorizer: gceTargetAuthorizer("start_instance")
    },
    {
      tool_id: "gce", action: "stop_instance", description: "Stopp en GCE-instans (asynkron - polles til DONE FØR retur) - eier-konfigurert produksjonsmål ELLER jarvis-sentinel-* (akseptanse)",
      input_schema: record({ zone: z.string(), instance_name: z.string() }), capability_class: "D",
      scopes: ["gce:write"], reversible: true,
      rollback_procedure: "gce.start_instance mot samme mål, reinspisert for å verifisere kjøretilstand",
      idempotent_external: true, timeout_ms: 90_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN", output_trust: "internal", transport: transport("gce"),
      preflight_action: "get_instance", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { status?: string } | null)?.status === "TERMINATED",
      parameterAuthorizer: gceTargetAuthorizer("stop_instance")
    },
    {
      tool_id: "gce", action: "reset_instance", description: "Hard reboot av en GCE-instans (asynkron - polles til DONE FØR retur) - DEFERRED for produksjon, kun jarvis-sentinel-* (akseptanse) inntil egen vurdering er gjort",
      input_schema: record({ zone: z.string(), instance_name: z.string() }), capability_class: "D",
      scopes: ["gce:write"], reversible: true,
      rollback_procedure: "ingen automatisk - verifiser RUNNING på nytt, varsle eier ved avvik",
      idempotent_external: false, timeout_ms: 90_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_GOOGLE_CLOUD_REFRESH_TOKEN", output_trust: "internal", transport: transport("gce"),
      preflight_action: "get_instance", preflight_requires_target: true,
      postcondition_predicate: (after) => (after as { status?: string } | null)?.status === "RUNNING",
      parameterAuthorizer: gceTargetAuthorizer("reset_instance")
    },
    // D-338 (Tobias direkte i chat: "ja bygg mcp zapier"): MCP-klient-
    // discovery. `list_tools` (klasse A) kaller Zapier sin MCP-server sin
    // `tools/list` og returnerer den RÅ listen ufiltrert - `output_trust:
    // "untrusted"` fordi innholdet er ekstern, DYNAMISK oppdaget data
    // (CLAUDE.md regel 7 - Ingestion Zone, aldri instruksjoner, aldri
    // direkte til autoritativt minne). Selve MCP-server-URL-en er
    // hemmelighets-ekvivalent (Zapier provisjonerer den PER BRUKER) og
    // lagres derfor som `credential_ref`, ALDRI som en parameter - se
    // `mcp-zapier-transport.ts`.
    {
      tool_id: "mcp_zapier", action: "list_tools", description: "List verktøyene Zapier sin MCP-server for øyeblikket eksponerer (read-only discovery, untrusted - ALDRI invokert)",
      input_schema: empty, capability_class: "A",
      scopes: ["mcp_zapier:read"], reversible: true,
      rollback_procedure: "ingen mutasjon utført - ren lesing",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_MCP_ZAPIER_SERVER_URL", output_trust: "untrusted", transport: transport("mcp_zapier")
    },
    // D-350 (Tobias direkte i chat, 2026-09-30, eksplisitt spurt via
    // AskUserQuestion - IKKE gjettet: "klasse D som standard" valgt av tre
    // tilbudte alternativer) - løser Q-40 (b). `call_tool` er ALLTID klasse
    // D, FAST for ALLE dynamisk oppdagede Zapier-verktøy uansett navn/
    // formodet risiko - Jarvis kan strukturelt IKKE vurdere et verktøy den
    // aldri har sett kildekoden/dokumentasjonen til, så den strengeste
    // klassen brukes ubetinget for samtlige, aldri en per-verktøy-gjetning.
    // Den smale, eier-konfigurerte unntakslisten (det andre tilbudte
    // alternativet) ble EKSPLISITT valgt BORT - ikke bygget. `tool_name`/
    // `arguments` er RENE PÅSTANDER fra kalleren (samme "aldri instruksjon"-
    // presedens som all annen ekstern input) - selve MCP-kallet, og dermed
    // hva som FAKTISK skjer, skjer alltid PostFlight for godkjenningen
    // (`ToolGateway.execute()` sin generiske klasse D-håndtering, keyed KUN
    // på `capability_class` - ingen ny godkjenningsmekanisme oppfunnet her).
    // `output_trust: "untrusted"` for returnert `content` av SAMME grunn som
    // `list_tools` - et Zap sin utdata er like ekstern/dynamisk som listen.
    {
      tool_id: "mcp_zapier", action: "call_tool", description: "Kjør ett navngitt Zapier MCP-verktøy med oppgitte argumenter (tools/call, klasse D FAST for ALLE, uansett verktøy - se D-350)",
      input_schema: record({ tool_name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).optional() }),
      capability_class: "D", scopes: ["mcp_zapier:call"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D (Jarvis kjenner ikke det faktiske verktøyets virkning)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_MCP_ZAPIER_SERVER_URL", output_trust: "untrusted", transport: transport("mcp_zapier")
    },
    // D-339 (Tobias direkte i chat: "playwrite er viktig for at den skal
    // kunne kontrollere mer" - bekrefter lokal/selv-hostet nettleser-
    // automasjon, ALDRI en tredjeparts cloud-browser-leverandør). KUN
    // read-only-handlingene denne FØRSTE sliceen - `click`/`fill_form`/
    // `submit` (mutasjon av tredjeparts nettsider) er BEVISST IKKE bygget,
    // se `apps/browser-gateway/src/browser-engine.ts` sitt filhode for full
    // begrunnelse. `output_trust: "untrusted"` for ALLE tre - sideinnhold
    // (tittel/tekst/skjermbilde) er ekstern data (CLAUDE.md regel 7).
    // `credential_ref` er selve BASE-URL-en til `apps/browser-gateway`
    // sin egen prosess (`JARVIS_BROWSER_GATEWAY_BASE_URL`) - INGEN ekte
    // hemmelighet finnes (Jarvis sin egen sideprosess), se
    // `browser-transport.ts`.
    {
      tool_id: "browser", action: "navigate", description: "Last en URL (http/https, KUN offentlige nettsteder - intern/privat adresse nektes) i en frisk, isolert nettleserkontekst og returner den faktiske URL-en/tittelen (untrusted)",
      input_schema: record({ url: z.string().max(2000) }), capability_class: "A",
      scopes: ["browser:read"], reversible: true, rollback_procedure: "ingen (ren navigering, ingen tilstand endres utenfor selve fanen)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_BROWSER_GATEWAY_BASE_URL", output_trust: "untrusted", transport: transport("browser")
    },
    {
      tool_id: "browser", action: "extract_text", description: "Last en URL (http/https, KUN offentlige nettsteder) i en frisk, isolert nettleserkontekst og les den synlige teksten (untrusted)",
      input_schema: record({ url: z.string().max(2000) }), capability_class: "A",
      scopes: ["browser:read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_BROWSER_GATEWAY_BASE_URL", output_trust: "untrusted", transport: transport("browser")
    },
    {
      tool_id: "browser", action: "screenshot", description: "Last en URL (http/https, KUN offentlige nettsteder) i en frisk, isolert nettleserkontekst og ta et skjermbilde (PNG, base64) (untrusted)",
      input_schema: record({ url: z.string().max(2000) }), capability_class: "A",
      scopes: ["browser:read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_BROWSER_GATEWAY_BASE_URL", output_trust: "untrusted", transport: transport("browser")
    },
    // UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107):
    // provider-nøytralt `finance.*`-namespace. `submit_payment_intent` er
    // klasse D (den ENESTE handlingen som faktisk poster en ekte
    // regnskapspost i Tobias sitt virkelige Fiken-selskap - INGEN bygget
    // automatisk reversering denne sliceen, samme forsiktighetsnivå som
    // `mail.send`/`docker.stop_container`). `enable_kill_switch`/
    // `disable_kill_switch` er ogsa klasse D (eier-sovereign kritisk
    // kontroll, D-41: INGEN kunstig godkjenningssperre for eieren selv,
    // men risikoKLASSEN styrer likevel HVORDAN - preflight/audit -
    // uendret). `create_payment_intent`/`settle_payment_intent`/
    // `cancel_payment_intent`/`reconcile_payment_intent` er klasse B (REN
    // Jarvis-intern tilstand/idempotens/avstemming - ALDRI en
    // leverandørhandling).
    {
      tool_id: "finance", action: "create_payment_intent", description: "Opprett en betalingsintensjon (idempotent - samme idempotency_key returnerer ALLTID samme intensjon, aldri en duplikat)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), idempotency_key: z.string(), purpose: z.string(),
        amount_ore: z.number().int().positive(), currency: z.string().optional(), vendor_name: z.string(),
        vendor_provider_ref: z.string().optional(), account_code: z.string(), counter_account_code: z.string().optional(),
        owner_person_id: z.string().optional(), actor_person_id: z.string().optional(),
        // D-109: valgfri - udefinert beholder DB-defaulten 'fiken'.
        provider: z.enum(["fiken", "stripe", "vipps", "neonomics"]).optional(),
        // D-116: valgfri eksplisitt canonical vendor-identitet (finance_vendors.vendor_id) - udefinert gir INGEN vendor-korrekthetskontroll (byte-for-byte uendret for enhver eksisterende kaller).
        vendor_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true,
      rollback_procedure: "cancel_payment_intent (kun gyldig fra draft - ingen provider-side-effekt å rulle tilbake)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "get_payment_intent", description: "Les én betalingsintensjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "list_payment_intents", description: "List betalingsintensjoner, valgfritt filtrert på state",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), state: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "submit_payment_intent",
      description: "Send en betalingsintensjon til Fiken (postering av en ekte regnskapspost) - fail-closed mot kill switch/manglende vendor-/motkonto FØR noe providerkall, idempotent no-op ved gjentatt kall på en allerede innsendt intensjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "D", scopes: ["finance.execute"], reversible: false,
      rollback_procedure: "ingen automatisk reversering bygget denne sliceen - krever en manuell korrigerende journalpost direkte i Fiken",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_FIKEN_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "settle_payment_intent", description: "Marker en innsendt/bekreftet intensjon som endelig oppgjort (f.eks. etter manuell bankavstemming) - ren intern disposisjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false,
      rollback_procedure: "ingen (oppgjort er en endelig disposisjon som speiler en allerede skjedd ekstern hendelse)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "cancel_payment_intent", description: "Kanseller en betalingsintensjon FØR den er innsendt (kun gyldig fra draft - ingen provider-side-effekt)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false,
      rollback_procedure: "ingen (kansellering er en endelig disposisjon for en ALDRI innsendt intensjon)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "reconcile_payment_intent", description: "Marker deterministisk avstemmingsresultat (matched/mismatched) mot Fiken sin bokførte post - mismatched plukkes opp av OpenLoopService",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), matched: z.boolean(), actor_person_id: z.string().optional(), note: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true,
      rollback_procedure: "reconcile_payment_intent på nytt med korrigert matched-verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "enable_kill_switch", description: "Aktiver finans-nødbryteren (akseptansekriterium 5) - stopper ALLE nye submit_payment_intent-forsøk umiddelbart, deterministisk håndhevet i FinanceService",
      input_schema: record({ tenant_id: z.string(), actor_person_id: z.string(), reason: z.string() }),
      capability_class: "D", scopes: ["finance.admin"], reversible: true,
      rollback_procedure: "disable_kill_switch", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "disable_kill_switch", description: "Deaktiver finans-nødbryteren",
      input_schema: record({ tenant_id: z.string(), actor_person_id: z.string() }),
      capability_class: "D", scopes: ["finance.admin"], reversible: true,
      rollback_procedure: "enable_kill_switch", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "get_kill_switch", description: "Les gjeldende finans-nødbryter-tilstand for tenanten",
      input_schema: record({ tenant_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    // UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116): vendor-
    // identitetsregister. REN lokal Jarvis-tilstandsmutasjon (klasse B,
    // SAMME begrunnelse som create_payment_intent/settle/cancel over) -
    // ALDRI et provider-kall. Selve pengehandlingen som BRUKER en binding
    // (submit_payment_intent) forblir uendret klasse D.
    {
      tool_id: "finance", action: "create_vendor", description: "Opprett en ny canonical Jarvis-vendor-identitet (D-116 vendor-identitetsregister)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false,
      rollback_procedure: "ingen automatisk sletting bygget denne sliceen - vendor forblir registrert inntil eksplisitt Q-20-erasure", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "list_vendors", description: "List canonical Jarvis-vendor-identiteter for tenanten",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "bind_vendor_provider", description: "Registrer/reaktiver DEN eier-/systemregistrerte provider-referansen for en canonical vendor (fiken/stripe/vipps/neonomics) - denne bindingen er selve identitetsmatchen submit_payment_intent validerer mot FØR provider-kallet",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), vendor_id: z.string(), provider: z.enum(["fiken", "stripe", "vipps", "neonomics"]), provider_vendor_ref: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "revoke_vendor_provider_binding",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "revoke_vendor_provider_binding", description: "Revoker en vendor-provider-binding - en revokert binding kan ALDRI brukes for en NY pengehandling (submit_payment_intent feiler deterministisk FØR provider-kall)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), provider: z.enum(["fiken", "stripe", "vipps", "neonomics"]), provider_vendor_ref: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "bind_vendor_provider på nytt med samme vendor",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      tool_id: "finance", action: "list_vendor_bindings", description: "List alle provider-bindinger (aktive og revokerte) for én canonical vendor",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), vendor_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance")
    },
    {
      // D-242: connector-helsesjekk-probe for `fiken` (`connector-registry.ts`
      // sin nye `live_test`) - Fiken sin egen dokumenterte "hent
      // companySlug"-inngang (`FikenTransport.listCompanies()`), INGEN
      // mutasjon. SAMME `credential_ref` som `submit_payment_intent` (den
      // ENESTE andre `finance.*`-handlingen som faktisk rører Fiken), IKKE
      // `JARVIS_BUSINESS_INTERNAL_TOKEN` (som resten av det lokale-kun
      // `finance.*`-namespacet bruker).
      tool_id: "finance", action: "list_companies", description: "List Fiken-firmaer/-slugs tilgjengelig for det konfigurerte refresh-tokenet (helsesjekk/reachability-probe, ingen mutasjon)",
      input_schema: record({ tenant_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_FIKEN_REFRESH_TOKEN",
      output_trust: "untrusted", transport: transport("finance")
    },
    // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): eget
    // `finance_spend.*`-namespace, SEPARAT fra `finance.*` over - ALDRI en
    // ekstern leverandør rørt (kun interne kilder Jarvis allerede eier, se
    // spend-service.ts). Klasse A/B UTELUKKENDE - INGEN klasse C/D-handling
    // finnes i dette namespacet i det hele tatt (ingen providerkall).
    {
      tool_id: "finance_spend", action: "create_recurring_commitment", description: "Opprett en abonnements-/gjentakende forpliktelse",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), vendor_name: z.string(), description: z.string(),
        cadence: z.enum(["monthly", "yearly", "custom_days"]), cadence_interval_days: z.number().int().positive().optional(),
        expected_billing_day_of_month: z.number().int().min(1).max(31).optional(), expected_amount_ore: z.number().int().positive(),
        currency: z.string().optional(), amount_tolerance_ore: z.number().int().nonnegative().optional(),
        source_mapping: z.record(z.unknown()).optional(), payment_intent_id: z.string().optional(),
        owner_person_id: z.string().optional(), start_date: z.string(), end_date: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "cancel_recurring_commitment",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "get_recurring_commitment", description: "Les én forpliktelse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), commitment_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "list_recurring_commitments", description: "List forpliktelser, valgfritt filtrert på state",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), state: z.enum(["active", "paused", "cancelled"]).optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "update_recurring_commitment", description: "Oppdater beskrivelse/beløp/toleranse/mapping-regler for en forpliktelse (ingen state-endring)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), commitment_id: z.string(), description: z.string().optional(),
        expected_amount_ore: z.number().int().positive().optional(), amount_tolerance_ore: z.number().int().nonnegative().optional(),
        source_mapping: z.record(z.unknown()).optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "update_recurring_commitment på nytt med forrige verdi",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "pause_recurring_commitment", description: "Sett en forpliktelse på pause (deterministisk state-overgang)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), commitment_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "resume_recurring_commitment",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "resume_recurring_commitment", description: "Gjenoppta en pauset forpliktelse (deterministisk state-overgang)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), commitment_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "pause_recurring_commitment",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "cancel_recurring_commitment", description: "Kanseller en forpliktelse (terminal - ingen vei tilbake, se spend-state-machine.ts)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), commitment_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (kansellering er en endelig disposisjon) - opprett en ny forpliktelse",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "create_procurement_item", description: "Registrer en forventet anskaffelse/utgift",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), vendor_name: z.string(), description: z.string(),
        expected_amount_ore: z.number().int().positive(), currency: z.string().optional(), expected_date: z.string(),
        expected_window_days: z.number().int().nonnegative().optional(), payment_intent_id: z.string().optional(), owner_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "cancel_procurement_item",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "get_procurement_item", description: "Les én forventet anskaffelse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), procurement_item_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "list_procurement_items", description: "List forventede anskaffelser, valgfritt filtrert på status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.enum(["expected", "fulfilled", "cancelled"]).optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "update_procurement_item", description: "Oppdater forventet beløp/dato/vindu for en anskaffelse (kun mens 'expected')",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), procurement_item_id: z.string(),
        expected_amount_ore: z.number().int().positive().optional(), expected_date: z.string().optional(), expected_window_days: z.number().int().nonnegative().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "update_procurement_item på nytt med forrige verdi",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "cancel_procurement_item", description: "Kanseller en forventet anskaffelse (terminal)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), procurement_item_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (kansellering er en endelig disposisjon) - opprett en ny anskaffelse",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "list_spend_records", description: "List normaliserte interne utgiftsposter (marketing/model_cost), valgfritt filtrert",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), source_family: z.enum(["marketing", "model_cost"]).optional(), campaign_id: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "get_spend_record", description: "Les én normalisert utgiftspost, inkludert kildeproveniens",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), spend_record_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "list_unresolved_spend_anomalies", description: "List uløste deterministiske avvik på tvers av utgiftsposter/forpliktelser/anskaffelser",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "sync_internal_spend", description: "Trigger inkrementell synk av marketing_spend_events + cost_events til finance_spend_records nå (i tillegg til den daglige sveipen) - idempotent, retry-trygg",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rene idempotente leserader, ingen ekstern side-effekt å rulle tilbake)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "run_spend_reconciliation", description: "Trigger deterministisk matching/avstemming av utgiftsposter mot forpliktelser/anskaffelser nå",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "reconcile_spend_record manuelt for feilaktig matchede rader",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    {
      tool_id: "finance_spend", action: "run_spend_anomaly_detection", description: "Trigger deterministisk avviksdeteksjon (§8: alle 7 typer) nå",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende - se runAnomalyDetection-JSDoc)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_spend")
    },
    // D-109 (UA-6 Slice 3): `finance_stripe.*` - de handlingene som er GENUINT
    // Stripe-spesifikke (refusjon, eksplisitt provider-oppfrisking, hendelses-
    // inspeksjon). `submit_payment_intent`/`get_payment_intent`/`create_payment_intent`
    // forblir i det EKSISTERENDE `finance.*`-namespacet (provider-dispatchet
    // internt av FinanceService - ingen duplisert handling for samme konsept).
    {
      tool_id: "finance_stripe", action: "request_refund", description: "Opprett refusjonsutkast (draft) mot en avsluttet Stripe-betalingsintensjon - INGEN Stripe-kall ennå, kun intern tilstand",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(),
        idempotency_key: z.string(), payment_intent_id: z.string(), amount_ore: z.number().int().positive(),
        reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
        owner_person_id: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "refusjonsutkast forblir i draft - ingen ekstern side-effekt å rulle tilbake før submit_refund",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "submit_refund", description: "Utfør refusjon mot Stripe for et eksisterende refusjonsutkast (klasse D - reell utgående økonomisk handling, kill-switch-gated, deterministisk provider-idempotens)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), refund_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "D", scopes: ["finance.write", "finance.stripe"], reversible: false,
      rollback_procedure: "ikke reverserbar hos Stripe - ny motsatt-rettet finansoperasjon kreves ved feil, ALDRI en stille reversering",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_STRIPE_SECRET_KEY",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "get_refund", description: "Les én Stripe-refusjonsrad",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), refund_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "list_refunds", description: "List Stripe-refusjoner, valgfritt filtrert på betalingsintensjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "refresh_payment_state", description: "Eksplisitt GET-basert oppfrisking av Stripe-betalingsstatus (samme deterministiske domene-sti som webhook-synk, aldri antatt utfall)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ekstern lesing, ingen økonomisk side-effekt)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_STRIPE_SECRET_KEY",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "get_webhook_event", description: "Inspiser én mottatt Stripe-webhook-hendelse (status/behandlingsutfall) for feilsøking/revisjon",
      input_schema: record({ tenant_id: z.string(), stripe_event_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      tool_id: "finance_stripe", action: "run_provider_anomaly_detection", description: "Trigger deterministisk Stripe-provider-avviksdeteksjon (§10: PROVIDER_AMOUNT_MISMATCH/PROVIDER_CURRENCY_MISMATCH/PROVIDER_DUPLICATE_OBJECT_CONFLICT/UNKNOWN_PROVIDER_OUTCOME/WEBHOOK_STATE_CONFLICT/REFUND_AMOUNT_CONFLICT/PROVIDER_OBJECT_TENANT_CONFLICT) nå",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende - se runProviderAnomalyDetection-JSDoc)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_stripe")
    },
    {
      // D-242: connector-helsesjekk-probe for `stripe` - `GET /v1/balance`
      // (`StripeTransport.getBalance()`), INGEN mutasjon. SAMME
      // `credential_ref` som `refresh_payment_state` (ekte Stripe-kall).
      tool_id: "finance_stripe", action: "get_balance", description: "Hent Stripe-kontosaldo (helsesjekk/reachability-probe, ingen mutasjon)",
      input_schema: record({ tenant_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_STRIPE_SECRET_KEY",
      output_trust: "untrusted", transport: transport("finance_stripe")
    },
    // D-110 (UA-6 Slice 4): `finance_vipps.*` - de handlingene som er GENUINT
    // Vipps-spesifikke (capture/cancel/refusjon/oppfrisking/hendelses-
    // inspeksjon). Betalingsopprettelse/-innsending forblir i det
    // EKSISTERENDE `finance.*`-namespacet (provider-dispatchet internt av
    // FinanceService - ingen duplisert handling for samme konsept).
    {
      tool_id: "finance_vipps", action: "request_capture", description: "Opprett capture-utkast (draft) mot en autorisert Vipps-betaling - INGEN Vipps-kall ennå, kun intern tilstand (over-capture avvises deterministisk allerede her)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(),
        idempotency_key: z.string(), payment_intent_id: z.string(), amount_ore: z.number().int().positive(),
        owner_person_id: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "capture-utkast forblir i draft - ingen ekstern side-effekt å rulle tilbake før submit_capture",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "submit_capture", description: "Utfør capture mot Vipps for et eksisterende capture-utkast (klasse D - reell økonomisk handling som faktisk flytter reserverte kundepenger, kill-switch-gated, deterministisk provider-idempotens)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), capture_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "D", scopes: ["finance.write", "finance.vipps"], reversible: false,
      rollback_procedure: "ikke reverserbar hos Vipps - en fanget betaling korrigeres kun via en NY, separat refusjon (request_refund/submit_refund), ALDRI en stille reversering",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_VIPPS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "get_capture", description: "Les én Vipps-capture-rad",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), capture_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "list_captures", description: "List Vipps-captures, valgfritt filtrert på betalingsintensjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "cancel_payment", description: "Avbryt en Vipps-betaling (før brukerbekreftelse, eller etter autorisering før full capture - frigjør reservasjonen; klasse C - påvirker kun en IKKE-oppgjort reservasjon, aldri allerede flyttede penger)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["finance.write", "finance.vipps"], reversible: false,
      rollback_procedure: "en avbrutt Vipps-betaling kan IKKE gjenopptas - en ny betalingsintensjon må opprettes",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_VIPPS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "request_refund", description: "Opprett refusjonsutkast (draft) mot en oppgjort Vipps-betaling - INGEN Vipps-kall ennå, kun intern tilstand (over-refusjon avvises deterministisk allerede her)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(),
        idempotency_key: z.string(), payment_intent_id: z.string(), amount_ore: z.number().int().positive(),
        owner_person_id: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "refusjonsutkast forblir i draft - ingen ekstern side-effekt å rulle tilbake før submit_refund",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "submit_refund", description: "Utfør refusjon mot Vipps for et eksisterende refusjonsutkast (klasse D - reell utgående økonomisk handling, kill-switch-gated, deterministisk provider-idempotens)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), refund_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "D", scopes: ["finance.write", "finance.vipps"], reversible: false,
      rollback_procedure: "ikke reverserbar hos Vipps - ny motsatt-rettet finansoperasjon kreves ved feil, ALDRI en stille reversering",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_VIPPS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "get_refund", description: "Les én Vipps-refusjonsrad",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), refund_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "list_refunds", description: "List Vipps-refusjoner, valgfritt filtrert på betalingsintensjon",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "refresh_payment_state", description: "Eksplisitt GET-basert oppfrisking av Vipps-betalingsstatus (samme deterministiske domene-sti som webhook-synk, aldri antatt utfall)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ekstern lesing, ingen økonomisk side-effekt)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_VIPPS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "get_webhook_event", description: "Inspiser én mottatt Vipps-webhook-hendelse (status/behandlingsutfall) for feilsøking/revisjon",
      input_schema: record({ tenant_id: z.string(), dedupe_key: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      tool_id: "finance_vipps", action: "run_provider_anomaly_detection", description: "Trigger deterministisk Vipps-provider-avviksdeteksjon (§12: PROVIDER_AMOUNT_MISMATCH/PROVIDER_CURRENCY_MISMATCH/PROVIDER_REFERENCE_CONFLICT/UNKNOWN_PROVIDER_OUTCOME/PROVIDER_STATE_CONFLICT/CAPTURE_AMOUNT_CONFLICT/REFUND_AMOUNT_CONFLICT/PROVIDER_OBJECT_TENANT_CONFLICT/EXPIRED_PAYMENT_WITH_ACTIVE_INTENT) nå",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende - se runVippsProviderAnomalyDetection-JSDoc)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_vipps")
    },
    {
      // D-242: connector-helsesjekk-probe for `vipps` - `POST
      // /accesstoken/get` (`VippsTransport.checkCredentials()`), INGEN
      // mutasjon (Vipps har INGEN parameterløs "whoami"-lesing i ePayment-
      // API-et, se `VippsTransport.checkCredentials()` sin doc-kommentar).
      // SAMME `credential_ref` som `refresh_payment_state` (ekte Vipps-kall).
      tool_id: "finance_vipps", action: "check_credentials", description: "Verifiser Vipps-credentials via access-token-endepunktet (helsesjekk/reachability-probe, ingen mutasjon)",
      input_schema: record({ tenant_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_VIPPS_CLIENT_SECRET",
      output_trust: "untrusted", transport: transport("finance_vipps")
    },
    // D-111 (UA-6 Slice 5): `finance_neonomics.*` - open-banking-handlingene
    // (samtykke/kontoer/saldo/transaksjoner/avstemming + PIS-status/SCA).
    // PIS-innsendingen forblir i `finance.submit_payment_intent`
    // (provider-dispatchet, aldri to konkurrerende handlinger). INGEN rå
    // Neonomics-proxy eksponeres. A-D-klassene speiler reell økonomisk
    // risiko: rene lesinger A, samtykke-/synk-/avstemmings-mutasjoner mot
    // Jarvis sin egen tilstand B, samtykke-tilbakekalling C (fjerner reell
    // banktilgang), selve pengebevegelsen (submit_payment_intent) er
    // allerede klasse C i finance.* med kill-switch-gate i FinanceService.
    {
      tool_id: "finance_neonomics", action: "list_banks", description: "List bankene/institusjonene Neonomics dekker (Norge-først) - katalogoppslag for samtykkeopprettelse",
      input_schema: record({ tenant_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "untrusted", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "create_consent", description: "Opprett banksamtykke-sesjon hos Neonomics for en gitt bank (starter samtykke-livssyklusen - selve SCA-en er ALLTID en brukerhandling via authorization-URL)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), bank_id: z.string(), bank_name: z.string().optional(), requested_scope: z.enum(["ais", "pis", "ais_pis"]).optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "revoke_consent",
      idempotent_external: false, timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "get_consent_authorization_url", description: "Hent SCA-autorisasjons-URL-en sluttbrukeren MÅ besøke hos banken (genererer samtidig Jarvis sin CSRF-callback-state)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string(), redirect_base_url: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "ingen (URL-utstedelse muterer kun Jarvis-tilstand)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "complete_consent_callback", description: "Fullfør samtykke-callbacken etter bank-SCA (konstant-tid state-verifisering, fail-closed på CSRF/replay/stale)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string(), callback_state: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "revoke_consent",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "get_consent", description: "Les ett banksamtykke",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "list_consents", description: "List banksamtykker",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "verify_consent", description: "Verifiser at et aktivt samtykke fortsatt gir banktilgang (billig provider-probe - utløpt tilgang blir en operasjonell 'expired'-tilstand, aldri en skjult feil)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "ingen (kun tilstandsobservasjon)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "revoke_consent", description: "Tilbakekall et banksamtykke (klasse C - fjerner reell banktilgang; gjenoppretting krever ny SCA hos banken)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string() }),
      capability_class: "C", scopes: ["finance.write", "finance.banking"], reversible: false, rollback_procedure: "opprett NYTT samtykke + ny bruker-SCA - det gamle kan ikke gjenopplives",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "sync_accounts", description: "Synk bankkontoer fra et aktivt samtykke inn i kanoniske bank_accounts (idempotent - dupliserer aldri; forsvunne kontoer inaktiveres, aldri slettes)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), consent_id: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "ingen (idempotent synk av Jarvis-tilstand)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "list_bank_accounts", description: "List kanoniske bankkontoer",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), include_inactive: z.boolean().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "sync_balances", description: "Hent ferske saldo-observasjoner for en bankkonto (append-only, provider-saldotypene bevares rått)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), bank_account_id: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "ingen (append-only observasjon)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "list_balances", description: "Les lagrede saldo-observasjoner for en bankkonto",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), bank_account_id: z.string(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "sync_transactions", description: "Synk banktransaksjoner (paginert, inkrementell, idempotent - pending->booked-overganger håndteres, provider-korreksjoner flagges i stedet for å overskrive)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), bank_account_id: z.string(), max_pages: z.number().optional() }),
      capability_class: "B", scopes: ["finance.write", "finance.banking"], reversible: true, rollback_procedure: "ingen (idempotent synk)",
      idempotent_external: true, timeout_ms: 60_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "list_bank_transactions", description: "List/filtrer kanoniske banktransaksjoner (konto/avstemmingstilstand)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), bank_account_id: z.string().optional(), reconciliation_state: z.enum(["unmatched", "matched", "ambiguous"]).optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "reconcile_bank_transactions", description: "Kjør deterministisk bankavstemming nå (regel 1 provider-referanse, regel 2 eksakt-én-kandidat beløp+dato-vindu - tvetydige forblir uløste)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (en match er bevisbasert lenking - manuell reconcile_payment_intent(matched=false) korrigerer ved behov)",
      idempotent_external: true, timeout_ms: 60_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "run_bank_anomaly_detection", description: "Trigger deterministisk bank-avviksdeteksjon nå (UNMATCHED_BANK_DEBIT/UNMATCHED_BANK_CREDIT/UNEXPECTED_LARGE_DEBIT/BANK_DUPLICATE_TRANSACTION - korreksjons-/mismatch-flagg settes ved kilden)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "refresh_payment_state", description: "Eksplisitt oppfrisking av Neonomics-bankbetalingsstatus (ISO 20022 - kun ACSC/ACCC regnes som oppgjort, aldri 'accepted')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "ingen (kun observasjons-synk)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "get_payment_authorization_url", description: "Hent SCA-URL-en sluttbrukeren MÅ besøke for å autorisere en initiert bankbetaling (1428-flyten - Jarvis fullfører ALDRI SCA autonomt)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), payment_intent_id: z.string(), redirect_url: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "ingen (URL-utstedelse)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_NEONOMICS_CLIENT_SECRET",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    {
      tool_id: "finance_neonomics", action: "run_provider_anomaly_detection", description: "Trigger deterministisk Neonomics-betalingsavviksdeteksjon nå (UNKNOWN_PROVIDER_OUTCOME/PROVIDER_DUPLICATE_OBJECT_CONFLICT/PROVIDER_OBJECT_TENANT_CONFLICT)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_neonomics")
    },
    // D-112 (UA-6 Slice 6): `finance_wallester.*` - programmerbare kort
    // (opprettelse/livssyklus/spend-kontroller/synk/avstemming/avvik).
    // INGEN rå Wallester-proxy eksponeres. A-D-klassene speiler reell
    // økonomisk risiko: rene lesinger A, lokale Jarvis-mutasjoner/synk B,
    // spend-MULIGGJØRENDE handlinger C (submit_card oppretter et reelt
    // spend-kapabelt instrument, unfreeze re-muliggjør spend,
    // update_spend_policy kan HEVE grenser, close_card er irreversibel) -
    // ingen egen D: selve pengetrekket skjer hos brukersteder besluttet av
    // WALLESTER mot provider-anvendte grenser (§10 NOT_APPLICABLE), aldri
    // som en Jarvis-handling.
    {
      tool_id: "finance_wallester", action: "create_card", description: "Opprett kanonisk kortutkast (draft) med formål/policy - deterministisk idempotent, INGEN provider-kall (submit_card er den spend-muliggjørende innsendingen)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), idempotency_key: z.string(), name: z.string(), purpose: z.string(), card_type: z.enum(["virtual", "physical", "disposable"]), currency: z.string().optional(), cardholder_person_id: z.string().optional(), commitment_id: z.string().optional(), campaign_id: z.string().optional(), vendor_name: z.string().optional(), transaction_limit_ore: z.number().optional(), daily_limit_ore: z.number().optional(), weekly_limit_ore: z.number().optional(), monthly_limit_ore: z.number().optional(), atm_enabled: z.boolean().optional(), online_enabled: z.boolean().optional(), contactless_enabled: z.boolean().optional() }),
      capability_class: "B", scopes: ["finance.write", "finance.cards"], reversible: true, rollback_procedure: "close_card (utkast uten provider-kort kan lukkes fritt)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "submit_card", description: "Send kortutkastet til Wallester (oppretter det REELLE kortet - spend-muliggjørende, kill-switch-gated; idempotent retry kan aldri duplisere)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "C", scopes: ["finance.write", "finance.cards"], reversible: false, rollback_procedure: "freeze_card + close_card (kortet kan fryses/lukkes, men utstedelsen har skjedd)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "get_card", description: "Les ett kanonisk kort",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "list_cards", description: "List kanoniske kort",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), include_closed: z.boolean().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "activate_card", description: "Aktiver et provider-opprettet kort (fysiske kort krever aktivering - spend-muliggjørende, kill-switch-gated; reversibelt via freeze_card)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "C", scopes: ["finance.write", "finance.cards"], reversible: true, rollback_procedure: "freeze_card",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "freeze_card", description: "Frys/blokker et kort (spend-REDUSERENDE - alltid tillatt, også under nødbryter)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "B", scopes: ["finance.write", "finance.cards"], reversible: true, rollback_procedure: "unfreeze_card",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "unfreeze_card", description: "Avfrys et kort (RE-muliggjør spend - kill-switch-gated, klasse C)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "C", scopes: ["finance.write", "finance.cards"], reversible: true, rollback_procedure: "freeze_card",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "close_card", description: "Lukk et kort permanent (irreversibelt - historiske transaksjoner/hendelser BEVARES)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "C", scopes: ["finance.write", "finance.cards"], reversible: false, rollback_procedure: "opprett NYTT kort - et lukket kort kan ikke gjenopplives",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "get_spend_policy", description: "Les kortets spend-policy (ØNSKET vs PROVIDER-ANVENDT - aldri antatt like)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "update_spend_policy", description: "Oppdater kortets spend-grenser/kanaler og push til provider (grense-ØKNINGER er kill-switch-gated; anvendt tilstand settes KUN fra provider-bekreftelse)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string(), transaction_limit_ore: z.number().nullable().optional(), daily_limit_ore: z.number().nullable().optional(), weekly_limit_ore: z.number().nullable().optional(), monthly_limit_ore: z.number().nullable().optional(), atm_enabled: z.boolean().optional(), online_enabled: z.boolean().optional(), contactless_enabled: z.boolean().optional() }),
      capability_class: "C", scopes: ["finance.write", "finance.cards"], reversible: true, rollback_procedure: "sett grensene tilbake (ny update_spend_policy)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "sync_card_state", description: "Passiv reparasjon av kanonisk korttilstand fra provider-sannheten (resurrekterer aldri et lukket kort - konflikt flagges)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "ingen (observasjons-synk)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "sync_authorizations", description: "Synk kortautorisasjoner (paginert, idempotent - statusprogresjon på samme rad)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string(), max_pages: z.number().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "ingen (idempotent synk)",
      idempotent_external: true, timeout_ms: 60_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "sync_transactions", description: "Synk oppgjorte korttransaksjoner (paginert, idempotent - autorisasjon<->oppgjør lenkes deterministisk, korreksjoner flagges i stedet for å overskrive)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string(), max_pages: z.number().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: true, rollback_procedure: "ingen (idempotent synk)",
      idempotent_external: true, timeout_ms: 60_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "list_authorizations", description: "List kortautorisasjoner (approve/decline/reversering/oppgjør - besluttet av Wallester mot provider-anvendte grenser)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "list_card_transactions", description: "List/filtrer kanoniske korttransaksjoner (kort/avstemmingstilstand)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), card_id: z.string().optional(), reconciliation_state: z.enum(["unmatched", "matched", "ambiguous"]).optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "reconcile_card_transactions", description: "Kjør deterministisk kortspend-avstemming nå (regel 1 formålsbundet forpliktelse, regel 2 eksakt-én-kandidat beløp - tvetydige forblir uløste)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (en match er bevisbasert lenking)",
      idempotent_external: true, timeout_ms: 60_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "run_card_anomaly_detection", description: "Trigger deterministisk kortavviksdeteksjon nå (UNEXPECTED_CARD_SPEND/CARD_AMOUNT_LIMIT_BREACH/CARD_CURRENCY_MISMATCH/CARD_DUPLICATE_TRANSACTION/CARD_SPEND_AFTER_FREEZE/CARD_SPEND_AFTER_CLOSE/UNEXPECTED_CASH_WITHDRAWAL/UNEXPECTED_ONLINE_PURCHASE m.fl. - kilde-satte flagg bevares)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["finance.write"], reversible: false, rollback_procedure: "ingen (rekjøring er selv-korrigerende)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("finance_wallester")
    },
    {
      tool_id: "finance_wallester", action: "get_provider_balance", description: "Les Wallester-kontosaldoen (read-only provider-tilstand - dupliserer aldri Neonomics-bankautoriteten)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["finance.read"], reversible: true, rollback_procedure: "ingen (ren lesing)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM",
      output_trust: "untrusted", transport: transport("finance_wallester")
    },
    // UA-7 Communications Hub - foerste slice (D-119): provider-nøytralt
    // conversation_graph.*-namespace - JARVIS_CANONICAL (D-64), ZERO ekstern
    // leverandør-avhengighet (samme interne sentinel-credential-mønster som
    // business/support). Lagt til på SLUTTEN av samme grunn som over -
    // eksisterende tester indekserer dette arrayet posisjonelt.
    //
    // D-119 SECURITY HARDENING, FOERSTE runde (pre-merge, PR #67):
    // `merge_identities`/`split_merge` BEVISST FJERNET - `performed_by` ble
    // akseptert UKRITISK fra kallerparametre (bevist adversarielt).
    //
    // D-119 FINAL AUTHORITY / TENANT-BOUNDARY HARDENING, ANDRE runde (pre-
    // merge, PR #67, se `transport.ts` sitt filhode for full begrunnelse):
    // en ANDRE ekstern final-review fant at `tenant_id`/`memory_space`
    // FORTSATT ble lest fra kallerparametre for de resterende handlingene -
    // SAMME feilklasse som `performed_by`-funnet, bevist adversarielt via
    // full `ToolGateway.execute()` (en tenant-A-autentisert kaller kunne
    // lese OG skrive tenant B sine rader ved å sette
    // `parameters.tenant_id`). `tenant_id`/`memory_space` er derfor FJERNET
    // fra ALLE `input_schema`-er under - `strict()` zod avviser nå enhver
    // kaller som fortsatt sender dem, og `ConversationGraphTransport`
    // henter `tenantId`/`memorySpace` UTELUKKENDE fra den tiltrodde
    // `ToolInvocationContext` (D-68). SAMME gjennomgang fjernet ALSO
    // `link_channel_identity` helt (ZERO reelle produksjonskallere,
    // `created_by_person_id`/`source_type`/`source_instance_id`/
    // `external_id` hadde ingen legitim kallerstyrt bruk, og
    // `reversible: true` var en usann påstand om en ikke-eksisterende
    // revoke-vei) - `conversation_graph.*` er derfor READ-ONLY via
    // ToolGateway (6 handlinger, alle klasse A). Canonical linking skjer
    // KUN via `ConversationGraphSyncService`, som kaller
    // `ConversationGraphService` DIREKTE, aldri via ToolGateway.
    {
      tool_id: "conversation_graph", action: "resolve_identity", description: "Slå opp kanonisk Conversation Graph-identitet for en kjent kanal-identifikator (eksakt, deterministisk - aldri fuzzy). tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ channel: z.string(), channel_identifier: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "read_identity", description: "Les én Conversation Graph-identitet. tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "list_channel_links", description: "List alle kanal-lenker (aktive og revokerte) for én identitet. tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "resolve_effective_identity", description: "Følg merged_into_identity_id transitivt til den nåværende AKTIVE identiteten i en flertrinns merge-kjede (deterministisk 'hvem eier dette nå') - rent lese-oppslag, endrer ingenting. tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "read_cross_channel_commitments", description: "Les åpne forpliktelser/neste-handlinger for en identitet på tvers av kanaler (akseptansekriterium 1 - gjenbruker business_followups uendret). tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "read_identity_timeline", description: "Les komplett, kilde-forankret aktivitetstidslinje for en identitet på tvers av kanaler (gjenbruker business_activities uendret). tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    // UA-7 slice 2 (D-121): akseptansekriterium 1 FULLT UT ("open commitments
    // AND NEXT ACTIONS visible ACROSS CHANNELS"). Begge er rene lese-oppslag,
    // klasse A - `conversation_graph.*` forblir READ-ONLY (D-119 FINAL
    // AUTHORITY HARDENING uendret), namespacet gaar 6 -> 8 handlinger. Ingen
    // ny tabell, ingen ny leverandoer, ingen nye scopes: begge unionerer de
    // EKSISTERENDE `business_followups`/`business_open_loops`. `tenant_id`/
    // `memory_space`/`now` er BEVISST fravaerende fra begge input_schema-er -
    // ingen parameter = ingen forfalskningsflate.
    {
      tool_id: "conversation_graph", action: "read_cross_channel_commitment_view", description: "Les FULL tverr-kanal-visning for én identitet: åpne forpliktelser (business_followups) OG deterministisk detekterte neste handlinger (business_open_loops), med kilde-proveniens, prioritets-bucket og hvilke kanaler motparten faktisk er nåbar på. Følger merge-kjeden til den effektive identiteten og skiller eksplisitt mellom 'ingenting åpent', 'identitet ikke funnet' og 'ingen lenket kontakt'. tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: record({ identity_id: z.string() }),
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    {
      tool_id: "conversation_graph", action: "read_cross_channel_attention", description: "Les tenant-bred 'hva er åpent på tvers av kanaler nå?' - alle åpne forpliktelser/neste handlinger sortert på forfall, hver merket med kanal-nåbarhet aggregert over ALLE aktive Conversation Graph-identiteter for kontakten (identities[] gir eksakt hvilken identitet som eier hvilken kanal - aldri én vilkårlig valgt identitet). Forpliktelser som INGEN kanal når rapporteres eksplisitt (channel_reachable=false), aldri stille utelatt. tenant/space kommer fra den tiltrodde kalleridentiteten, ALDRI fra parametre",
      input_schema: empty,
      capability_class: "A", scopes: ["conversation_graph.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("conversation_graph")
    },
    // UA-3 Native Jarvis Product Core (D-128): provider-nøytralt
    // `product.*`-namespace - JARVIS_CANONICAL, ZERO ekstern produkt-
    // analytics-/issue-tracker-leverandør-avhengighet (D-128/D-64). Lagt
    // til på SLUTTEN (samme grunn som contract.*/growth.* over -
    // eksisterende tester indekserer dette arrayet posisjonelt). Ingen
    // handling her er klasse D (ingen nøstet ekstern handling i denne
    // sliceen).
    {
      tool_id: "product", action: "create_item", description: "Opprett et produktpunkt (feature request/bug report/usage feedback/improvement); rapportør via eksisterende Business OS company/contact",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), description: z.string().optional(),
        item_type: z.string().optional(), priority: z.string().optional(), company_id: z.string().optional(), contact_id: z.string().optional(),
        owner_person_id: z.string().optional(), canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["product.write"], reversible: true,
      rollback_procedure: "sett status til 'declined'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "get_item", description: "Les ett produktpunkt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string() }),
      capability_class: "A", scopes: ["product.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "list_items", description: "List produktpunkter etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["product.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "search_items", description: "Deterministisk filter-/fritekstsøk i produktpunkter (punktnummer/selskap/kontakt/status/prioritet/eier/tittel)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), priority: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), owner_person_id: z.string().optional(),
        title_contains: z.string().optional(), item_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["product.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "list_by_company", description: "Hva har selskap X rapportert? - deterministisk rapportør-oppslag",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["product.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "set_status", description: "Deterministisk lifecycle-overgang (new/triaged/planned/in_progress/shipped/declined/closed)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["product.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_status-kall tilbake til forrige status (unntatt gjenåpningsveien fra shipped/declined/closed, som kun går til new)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "set_priority", description: "Sett prioritet (low/normal/high/critical)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string(), priority: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["product.write"], reversible: true,
      rollback_procedure: "sett prioritet tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "set_owner", description: "Sett/fjern punkteier (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["product.write"], reversible: true,
      rollback_procedure: "sett eier tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "link_reporter", description: "Oppdater rapportør (selskap/kontakt) - gjenbruker eksisterende Business OS-entiteter",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["product.write"], reversible: true,
      rollback_procedure: "sett rapportør tilbake via nytt link_reporter-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    {
      tool_id: "product", action: "list_events", description: "List hele hendelseshistorikken for ett produktpunkt (produkt-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), item_id: z.string() }),
      capability_class: "A", scopes: ["product.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("product")
    },
    // UA-3 Native Jarvis Operations Core (D-129): provider-nøytralt
    // `operations.*`-namespace - JARVIS_CANONICAL, ZERO ekstern
    // driftsplattform-/ticketing-leverandør-avhengighet (D-129/D-64). Lagt
    // til på SLUTTEN (samme grunn som product.* over - eksisterende tester
    // indekserer dette arrayet posisjonelt). `escalate_task` er klasse C
    // (endrer eskaleringsnivå/mottaker - reell konsekvens, men ingen
    // nøstet klasse D-handling i denne sliceen, ingen utgående kommunikasjon
    // bygget her).
    {
      tool_id: "operations", action: "create_vendor", description: "Registrer en leverandør (suppliers) - valgfri kobling til eksisterende Business OS company/contact",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), category: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), escalation_contact_person_id: z.string().optional(), notes: z.string().optional()
      }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett status til 'inactive'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "get_vendor", description: "Les én leverandør",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), vendor_id: z.string() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "list_vendors", description: "List leverandører etter status (default: active)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_vendor_status", description: "Sett leverandørstatus (active/inactive)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), vendor_id: z.string(), status: z.string() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett status tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "create_runbook", description: "Opprett et runbook (driftsdokumentasjon) - valgfritt koblet til en leverandør",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), content: z.string(),
        category: z.string().optional(), vendor_id: z.string().optional(), owner_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett is_active til false", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "get_runbook", description: "Les ett runbook",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), runbook_id: z.string() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "list_runbooks", description: "List runbooks (default: kun aktive)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), active_only: z.boolean().optional() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "update_runbook_content", description: "Oppdater innholdet i et runbook",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), runbook_id: z.string(), content: z.string() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt update_runbook_content-kall med forrige innhold", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_runbook_active", description: "Aktiver/deaktiver et runbook",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), runbook_id: z.string(), is_active: z.boolean() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett is_active tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "create_task", description: "Opprett en driftsoppgave (tasks/owners/deadlines) - valgfritt koblet til leverandør/runbook",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), description: z.string().optional(),
        priority: z.string().optional(), vendor_id: z.string().optional(), runbook_id: z.string().optional(),
        owner_person_id: z.string().optional(), due_at: z.string().optional(), canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett status til 'cancelled'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "get_task", description: "Les én driftsoppgave",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "list_tasks", description: "List driftsoppgaver etter status (default: open)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "search_tasks", description: "Deterministisk filter-/fritekstsøk i driftsoppgaver (oppgavenummer/leverandør/status/prioritet/eier/tittel)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), priority: z.string().optional(),
        vendor_id: z.string().optional(), owner_person_id: z.string().optional(), title_contains: z.string().optional(),
        task_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "list_by_vendor", description: "Hva er utestående for leverandør X? - deterministisk leverandør-oppslag",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), vendor_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_status", description: "Deterministisk lifecycle-overgang (open/in_progress/blocked/done/cancelled)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_status-kall tilbake til forrige status (unntatt gjenåpningsveien fra done/cancelled, som kun går til open)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_priority", description: "Sett prioritet (low/normal/high/critical)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), priority: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett prioritet tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_owner", description: "Sett/fjern oppgaveeier (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett eier tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "set_due_at", description: "Sett/fjern frist (deadline)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), due_at: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett frist tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "link_vendor", description: "Koble/fjern leverandør på en driftsoppgave",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), vendor_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett leverandørkobling tilbake via nytt link_vendor-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "link_runbook", description: "Koble/fjern runbook på en driftsoppgave",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), runbook_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["operations.write"], reversible: true,
      rollback_procedure: "sett runbook-kobling tilbake via nytt link_runbook-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "escalate_task", description: "Eskaler en driftsoppgave (§13 'escalations') - inkrementerer eskaleringsnivå, faller tilbake til leverandørens eskaleringskontakt hvis ingen mottaker oppgitt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string(), escalated_to_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["operations.write"], reversible: false,
      rollback_procedure: "ingen (eskaleringsnivå er en akkumulerende historikk, aldri tilbakestilt)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      tool_id: "operations", action: "list_task_events", description: "List hele hendelseshistorikken for én driftsoppgave (driftsoppgave-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), task_id: z.string() }),
      capability_class: "A", scopes: ["operations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("operations")
    },
    {
      // Task #122 (D-213): Telegram Bot API sin `getMe` - lagt til på
      // SLUTTEN av samme grunn som read_repo_meta/list_files over
      // (eksisterende tester indekserer dette arrayet posisjonelt). Ren,
      // side-effektfri lesing av botens EGEN identitet - ALDRI en ekte
      // meldingsutsendelse (`notify` over er klasse B med reell sideeffekt).
      // Brukes som `live_test` for Telegram-connectoren (D-211/D-213).
      tool_id: "telegram", action: "get_bot_info", description: "Les botens egen identitet (Telegram Bot API getMe) - brukes som tilkoblingstest, ALDRI en ekte meldingsutsendelse",
      input_schema: empty, capability_class: "A", scopes: ["bot:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_TELEGRAM_TOKEN",
      output_trust: "untrusted", transport: transport("telegram")
    },
    /**
     * D-292 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - første konkrete slice av den brede ordren). SAMME mønster
     * som `telegram` over (D-125/D-213) - `notify`/`get_bot_info` identisk
     * begrunnelse, pluss to lese-handlinger for D-41 sin "maksimal nyttig
     * kapabilitet"-plikt (Slack Web API sitt eget dokumenterte scope-sett,
     * IKKE gjettet: `chat:write` for postMessage, `channels:read` for
     * conversations.list, `channels:history` for conversations.history).
     * Lagt til på SLUTTEN av arrayet, samme posisjonelle test-disiplin som
     * telegram/vercel/read_repo_meta over.
     */
    {
      tool_id: "slack", action: "notify", description: "Send melding til en Slack-kanal (chat.postMessage)",
      input_schema: record({ channel: z.string(), message: z.string().max(4000) }), capability_class: "C",
      scopes: ["chat:write"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SLACK_BOT_TOKEN", output_trust: "internal", transport: transport("slack")
    },
    {
      tool_id: "slack", action: "get_bot_info", description: "Les botens egen identitet (Slack Web API auth.test) - brukes som tilkoblingstest, ALDRI en ekte meldingsutsendelse",
      // Slack sin auth.test krever INGEN scope utover en gyldig token - `bot:read` er samme
      // logiske plassholder-konvensjon som Telegrams get_bot_info over (getMe har heller ingen
      // ekte OAuth-scope), IKKE en faktisk Slack-dokumentert scope-streng.
      input_schema: empty, capability_class: "A", scopes: ["bot:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_SLACK_BOT_TOKEN",
      output_trust: "untrusted", transport: transport("slack")
    },
    {
      tool_id: "slack", action: "list_channels", description: "List kanaler boten kan se (conversations.list, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["channels:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_SLACK_BOT_TOKEN",
      output_trust: "untrusted", transport: transport("slack")
    },
    {
      tool_id: "slack", action: "read_channel_history", description: "Les nylige meldinger i en kanal (conversations.history, untrusted ingestion)",
      input_schema: record({ channel: z.string(), limit: z.number().int().min(1).max(200).optional() }),
      capability_class: "A", scopes: ["channels:history"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SLACK_BOT_TOKEN", output_trust: "untrusted", transport: transport("slack")
    },
    /**
     * D-294 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - andre slice). SAMME "notify er ekte utsendelse (klasse B),
     * get_bot_info er trygg tilkoblingstest (klasse A)"-mønster som Telegram/
     * Slack over. Discord sitt eget dokumenterte permission-bitfield-navn
     * brukes for `scopes` (IKKE gjettet: `SEND_MESSAGES`/`VIEW_CHANNEL`/
     * `READ_MESSAGE_HISTORY`, discord.com/developers/docs/topics/permissions).
     * Lagt til på SLUTTEN av arrayet, samme posisjonelle test-disiplin som
     * telegram/vercel/slack over.
     */
    {
      tool_id: "discord", action: "notify", description: "Send melding til en Discord-kanal (POST /channels/{id}/messages)",
      input_schema: record({ channel_id: z.string(), message: z.string().max(2000) }), capability_class: "C",
      scopes: ["SEND_MESSAGES"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_DISCORD_BOT_TOKEN", output_trust: "internal", transport: transport("discord")
    },
    {
      tool_id: "discord", action: "get_bot_info", description: "Les botens egen identitet (GET /users/@me) - brukes som tilkoblingstest, ALDRI en ekte meldingsutsendelse",
      input_schema: empty, capability_class: "A", scopes: ["identify"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_DISCORD_BOT_TOKEN",
      output_trust: "untrusted", transport: transport("discord")
    },
    {
      tool_id: "discord", action: "list_channels", description: "List kanaler i en server (GET /guilds/{id}/channels, untrusted ingestion)",
      input_schema: record({ guild_id: z.string() }), capability_class: "A", scopes: ["VIEW_CHANNEL"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_DISCORD_BOT_TOKEN",
      output_trust: "untrusted", transport: transport("discord")
    },
    {
      tool_id: "discord", action: "read_channel_history", description: "Les nylige meldinger i en kanal (GET /channels/{id}/messages, untrusted ingestion)",
      input_schema: record({ channel_id: z.string(), limit: z.number().int().min(1).max(100).optional() }),
      capability_class: "A", scopes: ["READ_MESSAGE_HISTORY"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_DISCORD_BOT_TOKEN", output_trust: "untrusted", transport: transport("discord")
    },
    /**
     * D-295 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - tredje slice). SAMME "notify er ekte utsendelse (klasse
     * B), get_account_info er trygg tilkoblingstest (klasse A)"-mønster som
     * Telegram/Slack/Discord over. Twilio sin klassiske AccountSid/AuthToken-
     * modell har INGEN OAuth-scope-konsept (full kontotilgang alltid) - derfor
     * er `sms:send`/`sms:read` interne Jarvis-plassholdere, SAMME konvensjon
     * som Telegrams `bot:read` (IKKE en faktisk Twilio-dokumentert scope-
     * streng).
     */
    {
      tool_id: "twilio", action: "notify", description: "Send SMS (POST /Messages.json)",
      input_schema: record({ to: z.string(), message: z.string().max(1600) }), capability_class: "C",
      scopes: ["sms:send"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TWILIO_AUTH_TOKEN", output_trust: "internal", transport: transport("twilio")
    },
    {
      tool_id: "twilio", action: "get_account_info", description: "Les kontoens egen identitet (GET /Accounts/{sid}.json) - brukes som tilkoblingstest, ALDRI en ekte SMS-utsendelse",
      input_schema: empty, capability_class: "A", scopes: ["sms:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_TWILIO_AUTH_TOKEN",
      output_trust: "untrusted", transport: transport("twilio")
    },
    {
      tool_id: "twilio", action: "read_messages", description: "List nylige SMS-meldinger på kontoen (GET /Messages.json, untrusted ingestion)",
      input_schema: record({ limit: z.number().int().min(1).max(1000).optional() }),
      capability_class: "A", scopes: ["sms:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TWILIO_AUTH_TOKEN", output_trust: "untrusted", transport: transport("twilio")
    },
    /**
     * D-296 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - fjerde slice). STRUKTURELT ULIK Telegram/Slack/Discord/
     * Twilio: INGEN klasse B/C/D-handling finnes for denne connectoren i
     * det hele tatt - Brave Search sitt REST-API tilbyr genuint bare lesing,
     * så D-41 sitt "read-only kun når leverandøren faktisk ikke tilbyr mer"-
     * unntak er ÆRLIG oppfylt her (ikke en snarvei). `live_test` (se
     * `connector-registry.ts`) bruker `web_search` DIREKTE - ingen egen
     * "get_account_info"-handling trengs siden ALT allerede er sideeffekt-
     * fritt, og Brave har uansett intet kontoidentitets-endepunkt.
     */
    {
      tool_id: "brave_search", action: "web_search", description: "Websøk (GET /res/v1/web/search, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400), count: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_BRAVE_SEARCH_API_KEY", output_trust: "untrusted", transport: transport("brave_search")
    },
    {
      tool_id: "brave_search", action: "news_search", description: "Nyhetssøk (GET /res/v1/news/search, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400), count: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_BRAVE_SEARCH_API_KEY", output_trust: "untrusted", transport: transport("brave_search")
    },
    /**
     * D-297 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - femte slice). Sentry sitt organisasjonsscopede REST-API v0
     * (`sentry.io/api/0/organizations/{org_slug}/...`), `Authorization:
     * Bearer <token>`. **IKKE denne-økten-verifisert mot en live hentet kopi
     * av offisiell dokumentasjon** (nettverksegress blokkert i dette miljøet,
     * se `SentryTransport` sin doc-kommentar i `live-transports.ts` og D-297 i
     * DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse) - basert på trent
     * kunnskap om et offentlig, år-stabilt API-mønster, IKKE gjettet fra
     * forrige connectors mønster. `update_issue` er FØRSTE skrivehandling i
     * denne rekken som er en REN TILSTANDSENDRING (issue-status), ikke en
     * utgående melding til en tredjepart - reversibel OG idempotent, ULIKT
     * Slack/Discord/Twilio sin `notify`.
     */
    {
      tool_id: "sentry", action: "list_projects", description: "List prosjekter i organisasjonen (GET /organizations/{org}/projects/, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["project:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_SENTRY_API_TOKEN",
      output_trust: "untrusted", transport: transport("sentry")
    },
    {
      tool_id: "sentry", action: "list_issues", description: "List issues i organisasjonen (GET /organizations/{org}/issues/, untrusted ingestion)",
      input_schema: record({ query: z.string().max(200).optional() }),
      capability_class: "A", scopes: ["project:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SENTRY_API_TOKEN", output_trust: "untrusted", transport: transport("sentry")
    },
    {
      tool_id: "sentry", action: "get_issue", description: "Les ett issue (GET /organizations/{org}/issues/{id}/, untrusted ingestion)",
      input_schema: record({ issue_id: z.string() }),
      capability_class: "A", scopes: ["project:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SENTRY_API_TOKEN", output_trust: "untrusted", transport: transport("sentry")
    },
    {
      tool_id: "sentry", action: "update_issue", description: "Endre issue-status (PUT /organizations/{org}/issues/{id}/, f.eks. resolved/ignored/unresolved)",
      input_schema: record({ issue_id: z.string(), status: z.enum(["resolved", "ignored", "unresolved"]) }),
      capability_class: "B", scopes: ["event:write"], reversible: true,
      rollback_procedure: "ny update_issue-kalling med forrige status", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_SENTRY_API_TOKEN",
      output_trust: "internal", transport: transport("sentry")
    },
    /**
     * D-298 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - sjette slice). Google Maps Platform sitt Geocoding-API
     * (`maps.googleapis.com/maps/api/geocode/json`) - API-nøkkel som `key`-
     * query-parameter. BEVISST AVGRENSET til KUN Geocoding - `google_places`/
     * `google_routes` er separate, fortsatt ubygde backlog-id-er. INGEN
     * skrivehandling finnes for denne connectoren i det hele tatt (samme
     * D-41 read-only-unntak som Brave Search).
     */
    {
      tool_id: "google_maps", action: "geocode", description: "Adresse -> koordinater (GET /maps/api/geocode/json?address=..., untrusted ingestion)",
      input_schema: record({ address: z.string().max(400) }),
      capability_class: "A", scopes: ["maps:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_MAPS_API_KEY", output_trust: "untrusted", transport: transport("google_maps")
    },
    {
      tool_id: "google_maps", action: "reverse_geocode", description: "Koordinater -> adresse (GET /maps/api/geocode/json?latlng=..., untrusted ingestion)",
      input_schema: record({ latlng: z.string().max(60) }),
      capability_class: "A", scopes: ["maps:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_MAPS_API_KEY", output_trust: "untrusted", transport: transport("google_maps")
    },
    /**
     * D-299 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - syvende slice). Google Sheets API v4 - gjenbruker
     * `googleAccessToken()` OAuth-refresh-token-utveksleren, MEN med sin EGEN
     * `credential_ref` (`JARVIS_GOOGLE_SHEETS_TOKEN`, IKKE `JARVIS_GOOGLE_
     * TOKEN` - Sheets krever den dedikerte `spreadsheets`-scopen, som Drive
     * sin bredere `auth/drive`-scope ikke dekker). D-41 sitt "maksimal
     * nyttig kapabilitet"-prinsipp: `update_range`/`append_row` er EKTE
     * skrivehandlinger (klasse B), ikke kunstig innsnevret til read-only.
     */
    {
      tool_id: "google_sheets", action: "list_sheets", description: "List faner i et regneark (GET /v4/spreadsheets/{id}, untrusted ingestion)",
      input_schema: record({ spreadsheet_id: z.string() }),
      capability_class: "A", scopes: ["https://www.googleapis.com/auth/spreadsheets"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_SHEETS_TOKEN", output_trust: "untrusted", transport: transport("google_sheets")
    },
    {
      tool_id: "google_sheets", action: "read_range", description: "Les celleverdier fra et område (GET /v4/spreadsheets/{id}/values/{range}, untrusted ingestion)",
      input_schema: record({ spreadsheet_id: z.string(), range: z.string().max(200) }),
      capability_class: "A", scopes: ["https://www.googleapis.com/auth/spreadsheets"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_SHEETS_TOKEN", output_trust: "untrusted", transport: transport("google_sheets")
    },
    {
      tool_id: "google_sheets", action: "update_range", description: "Overskriv celleverdier i et område (PUT /v4/spreadsheets/{id}/values/{range})",
      input_schema: record({ spreadsheet_id: z.string(), range: z.string().max(200), values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))), value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional() }),
      capability_class: "B", scopes: ["https://www.googleapis.com/auth/spreadsheets"], reversible: true,
      rollback_procedure: "ny update_range-kalling med forrige verdier", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_SHEETS_TOKEN",
      output_trust: "internal", transport: transport("google_sheets")
    },
    {
      tool_id: "google_sheets", action: "append_row", description: "Legg til en NY rad nederst i et område (POST /v4/spreadsheets/{id}/values/{range}:append)",
      input_schema: record({ spreadsheet_id: z.string(), range: z.string().max(200), row: z.array(z.union([z.string(), z.number(), z.boolean()])), value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional() }),
      capability_class: "B", scopes: ["https://www.googleapis.com/auth/spreadsheets"], reversible: false,
      rollback_procedure: "slett raden manuelt i regnearket (ingen radidentifikator returneres av API-et)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_SHEETS_TOKEN",
      output_trust: "internal", transport: transport("google_sheets")
    },
    /**
     * D-301 (Tobias direkte i chat: "jeg vil at alt i planen skal bygges og
     * fullføres" - åttende slice). STRUKTURELT LIK Brave Search (D-296):
     * INGEN klasse B/C/D-handling finnes - Tavily sitt API tilbyr genuint
     * bare lesing, D-41 sitt read-only-unntak ærlig oppfylt. **IKKE denne-
     * økten-verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om ETT kjent endepunkt (`POST /search`),
     * `web_search`/`news_search` differensiert kun via `topic`-felt i
     * request-body, se `TavilyTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "tavily", action: "web_search", description: "Websøk (POST /search, topic=general, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400), max_results: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TAVILY_API_KEY", output_trust: "untrusted", transport: transport("tavily")
    },
    {
      tool_id: "tavily", action: "news_search", description: "Nyhetssøk (POST /search, topic=news, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400), max_results: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TAVILY_API_KEY", output_trust: "untrusted", transport: transport("tavily")
    },
    /**
     * D-302 (Tobias direkte i chat: "fortsett og jobbe ikke vent på ci" -
     * niende slice). STRUKTURELT LIK Brave Search/Tavily: INGEN klasse
     * B/C/D-handling finnes - Exa sitt nevrale søke-API tilbyr genuint bare
     * lesing, D-41 sitt read-only-unntak ærlig oppfylt. **IKKE denne-økten-
     * verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om Exa sitt offentlige API. TO separate,
     * EGNE endepunkter (`POST /search`/`POST /findSimilar`), ULIK Tavily
     * sitt delte endepunkt, se `ExaTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "exa", action: "web_search", description: "Nevralt websøk (POST /search, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400), num_results: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_EXA_API_KEY", output_trust: "untrusted", transport: transport("exa")
    },
    {
      tool_id: "exa", action: "find_similar", description: "Finn sider som ligner en gitt URL (POST /findSimilar, untrusted ingestion)",
      input_schema: record({ url: z.string().max(2000), num_results: z.number().int().min(1).max(20).optional() }),
      capability_class: "A", scopes: ["search:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_EXA_API_KEY", output_trust: "untrusted", transport: transport("exa")
    },
    /**
     * D-303 (bygget parallelt mens D-302 sin CI kjørte - tiende slice).
     * SAMME D-64-domenevurdering som Google Maps (D-298): stateless
     * tredjeparts-stedoppslag, IKKE eierens egen posisjon/geofence. STRUKTURELT
     * LIK Google Maps: INGEN klasse B/C/D-handling finnes - Places-API-et
     * tilbyr genuint bare lesing, D-41 sitt read-only-unntak ærlig oppfylt.
     * **IKKE denne-økten-verifisert mot en live hentet kopi av offisiell
     * dokumentasjon** (nettverksegress blokkert i dette miljøet, samme
     * D-297-forbehold) - basert på trent kunnskap om det ELDRE, stabile
     * Places-API-et, se `GooglePlacesTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "google_places", action: "search_places", description: "Tekstsøk etter steder (GET /place/textsearch/json, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400) }),
      capability_class: "A", scopes: ["places:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_PLACES_API_KEY", output_trust: "untrusted", transport: transport("google_places")
    },
    {
      tool_id: "google_places", action: "get_place_details", description: "Les detaljer om ett sted (GET /place/details/json, untrusted ingestion)",
      input_schema: record({ place_id: z.string().max(400) }),
      capability_class: "A", scopes: ["places:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_PLACES_API_KEY", output_trust: "untrusted", transport: transport("google_places")
    },
    /**
     * D-304 (bygget parallelt mens D-303 sin CI kjørte - ellevte slice).
     * SAMME D-64-domenevurdering som Google Maps/Google Places: stateless
     * tredjeparts-rute-oppslag, IKKE eierens egen posisjon/geofence.
     * STRUKTURELT LIK Google Maps/Google Places: INGEN klasse B/C/D-handling
     * finnes - Directions-/Distance Matrix-API-et tilbyr genuint bare
     * lesing, D-41 sitt read-only-unntak ærlig oppfylt. **IKKE denne-økten-
     * verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om det ELDRE, stabile Directions-/Distance
     * Matrix-API-et, se `GoogleRoutesTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "google_routes", action: "get_directions", description: "Rutebeskrivelse mellom to punkter (GET /directions/json, untrusted ingestion)",
      input_schema: record({ origin: z.string().max(400), destination: z.string().max(400) }),
      capability_class: "A", scopes: ["routes:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_ROUTES_API_KEY", output_trust: "untrusted", transport: transport("google_routes")
    },
    {
      tool_id: "google_routes", action: "get_distance_matrix", description: "Reisetid/avstand mellom flere opprinnelser/destinasjoner (GET /distancematrix/json, untrusted ingestion)",
      input_schema: record({ origins: z.string().max(800), destinations: z.string().max(800) }),
      capability_class: "A", scopes: ["routes:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_ROUTES_API_KEY", output_trust: "untrusted", transport: transport("google_routes")
    },
    /**
     * D-305 (bygget parallelt mens D-304 sin CI kjørte - tolvte slice).
     * STRUKTURELT LIK Google Maps/Places/Routes/Brave Search/Tavily/Exa:
     * INGEN klasse B/C/D-handling finnes - Grafana sitt HTTP-API tilbyr her
     * kun lesing, D-41 sitt read-only-unntak ærlig oppfylt. **IKKE denne-
     * økten-verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om Grafana sitt HTTP-API, se
     * `GrafanaTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "grafana", action: "search_dashboards", description: "Søk etter dashboards/mapper (GET /api/search, untrusted ingestion)",
      input_schema: record({ query: z.string().max(400).optional() }),
      capability_class: "A", scopes: ["dashboards:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GRAFANA_API_KEY", output_trust: "untrusted", transport: transport("grafana")
    },
    {
      tool_id: "grafana", action: "get_dashboard", description: "Les ett dashboard ved uid (GET /api/dashboards/uid/{uid}, untrusted ingestion)",
      input_schema: record({ uid: z.string().max(200) }),
      capability_class: "A", scopes: ["dashboards:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GRAFANA_API_KEY", output_trust: "untrusted", transport: transport("grafana")
    },
    /**
     * D-306 (bygget parallelt mens D-305 sin CI kjørte - trettende slice).
     * STRUKTURELT LIK Grafana/Google-familien/Brave Search/Tavily/Exa: INGEN
     * klasse B/C/D-handling finnes - Prometheus sitt HTTP-API tilbyr genuint
     * bare lesing, D-41 sitt read-only-unntak ærlig oppfylt. **IKKE denne-
     * økten-verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om Prometheus sitt HTTP-API, se
     * `PrometheusTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "prometheus", action: "query", description: "PromQL instant-spørring (GET /api/v1/query, untrusted ingestion)",
      input_schema: record({ query: z.string().max(1000) }),
      capability_class: "A", scopes: ["metrics:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_PROMETHEUS_TOKEN", output_trust: "untrusted", transport: transport("prometheus")
    },
    {
      tool_id: "prometheus", action: "query_range", description: "PromQL rekke-spørring over tid (GET /api/v1/query_range, untrusted ingestion)",
      input_schema: record({ query: z.string().max(1000), start: z.string().max(64), end: z.string().max(64), step: z.string().max(32) }),
      capability_class: "A", scopes: ["metrics:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_PROMETHEUS_TOKEN", output_trust: "untrusted", transport: transport("prometheus")
    },
    /**
     * D-307 (bygget parallelt mens D-306 sin CI kjørte - fjortende slice).
     * D-41 sitt "maksimal nyttig kapabilitet"-prinsipp fulgt - EKTE
     * skrivehandling (`create_folder`), ikke kunstig innsnevret til
     * read-only (samme disiplin som Drive/Sheets). **IKKE denne-økten-
     * verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om Dropbox API v2, se `DropboxTransport` sin
     * doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "dropbox", action: "list_folder", description: "List innhold i en mappe (POST /2/files/list_folder, untrusted ingestion)",
      input_schema: record({ path: z.string().max(1000).optional() }),
      capability_class: "A", scopes: ["files.metadata.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_DROPBOX_TOKEN", output_trust: "untrusted", transport: transport("dropbox")
    },
    {
      tool_id: "dropbox", action: "create_folder", description: "Opprett en NY, tom mappe (POST /2/files/create_folder_v2)",
      input_schema: record({ path: z.string().max(1000) }),
      capability_class: "B", scopes: ["files.content.write"], reversible: true,
      rollback_procedure: "slett den nyopprettede mappen manuelt", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_DROPBOX_TOKEN",
      output_trust: "internal", transport: transport("dropbox")
    },
    /**
     * D-388: D-307 sin DEFERRED filinnhold-overføring (content.dropboxapi.com, `Dropbox-API-Arg`-header) er bygget -
     * tekst eller base64, maks 1 MiB per kall. `upload_file` med `overwrite:false` (default) feiler aldri stille over
     * en eksisterende fil (Dropbox `mode: add` + `autorename`).
     */
    {
      tool_id: "dropbox", action: "download_file", description: "Last ned en fil (POST content.dropboxapi.com/2/files/download, maks 1 MiB) - tekst som utf8, ellers base64",
      input_schema: record({ path: z.string().min(1).max(1000) }),
      capability_class: "A", scopes: ["files.content.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_DROPBOX_TOKEN", output_trust: "untrusted", transport: transport("dropbox")
    },
    {
      tool_id: "dropbox", action: "upload_file", description: "Last opp en fil (POST content.dropboxapi.com/2/files/upload, maks 1 MiB) - `content` som utf8-tekst eller base64 (`encoding`)",
      input_schema: record({
        path: z.string().min(1).max(1000), content: z.string().max(1_400_000),
        encoding: z.enum(["utf8", "base64"]).optional(), overwrite: z.boolean().optional()
      }),
      capability_class: "B", scopes: ["files.content.write"], reversible: true,
      rollback_procedure: "slett/gjenopprett filen i Dropbox (versjonshistorikk finnes i Dropbox)", idempotent_external: false,
      timeout_ms: 20_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_DROPBOX_TOKEN",
      output_trust: "internal", transport: transport("dropbox")
    },
    /**
     * D-308 (bygget parallelt mens D-307 sin CI kjørte - femtende slice,
     * Tobias direkte i chat gjentatt, niende gang: "fortsett og jobbe ikke
     * vent på ci"). `Authorization: Bearer`-header + fast `Notion-Version`-
     * header mot Notion sitt REST-API. D-41: `create_page` er en EKTE
     * skrivehandling (ikke kunstig innsnevret til read-only) - reversibel
     * via arkivering i Notion sitt UI (ingen dedikert arkiver-endepunkt
     * bygget her ennå). **IKKE denne-økten-verifisert mot en live hentet
     * kopi av offisiell dokumentasjon** (nettverksegress blokkert i dette
     * miljøet, samme D-297-forbehold) - basert på trent kunnskap om Notion
     * API v1 (2022-06-28), se `NotionTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "notion", action: "search", description: "Søk på tvers av sider/databaser eieren har delt med integrasjonen (POST /v1/search, untrusted ingestion)",
      input_schema: record({ query: z.string().max(2000).optional() }),
      capability_class: "A", scopes: ["read_content"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_NOTION_API_KEY", output_trust: "untrusted", transport: transport("notion")
    },
    {
      tool_id: "notion", action: "create_page", description: "Opprett en NY side under en gitt parent (POST /v1/pages)",
      input_schema: record({
        parent: z.record(z.string(), z.unknown()), properties: z.record(z.string(), z.unknown())
      }),
      capability_class: "B", scopes: ["insert_content"], reversible: true,
      rollback_procedure: "arkiver siden manuelt i Notion", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_NOTION_API_KEY",
      output_trust: "internal", transport: transport("notion")
    },
    /**
     * D-309 (bygget parallelt mens D-308 sin CI kjørte - sekstende slice,
     * Tobias direkte i chat gjentatt, tiende gang: "fortsett og jobbe ikke
     * vent på ci"). `Authorization: Bearer`-header mot Microsoft Graph
     * v1.0. D-41: `create_folder` er en EKTE skrivehandling (ikke kunstig
     * innsnevret til read-only). **IKKE denne-økten-verifisert mot en live
     * hentet kopi av offisiell dokumentasjon** (nettverksegress blokkert i
     * dette miljøet, samme D-297-forbehold) - basert på trent kunnskap om
     * Microsoft Graph Drive API, se `OneDriveTransport` sin doc-kommentar i
     * `live-transports.ts`.
     */
    {
      tool_id: "onedrive", action: "list_folder", description: "List innhold i en mappe (GET /me/drive/root/children eller .../root:/{path}:/children, untrusted ingestion)",
      input_schema: record({ path: z.string().max(1000).optional() }),
      capability_class: "A", scopes: ["Files.Read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_ONEDRIVE_TOKEN", output_trust: "untrusted", transport: transport("onedrive")
    },
    {
      tool_id: "onedrive", action: "create_folder", description: "Opprett en NY mappe under rot (POST /me/drive/root/children)",
      input_schema: record({ name: z.string().max(255) }),
      capability_class: "B", scopes: ["Files.ReadWrite"], reversible: true,
      rollback_procedure: "slett den nyopprettede mappen manuelt", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_ONEDRIVE_TOKEN",
      output_trust: "internal", transport: transport("onedrive")
    },
    /**
     * D-310 (syttende slice, FØRSTE etter D-192-merge av PR #190 - tilbake
     * til ett-connector-per-PR-mønsteret). `Authorization: Bearer`-header
     * mot Microsoft Graph v1.0 (SAMME familie som OneDrive D-309).
     * `list_messages` er klasse A (lesing). `send_mail` er BEVISST klasse D
     * - SAMME klassifisering som `email.send` (Gmail) lenger opp i denne
     * filen: sending av e-post er ikke reverserbar, derfor klasse D (D-192-
     * strekpunktene/CLAUDE.md regel 2 - kritiske handlinger håndheves i
     * deterministisk kode, ALDRI kun promptregler - `PolicyGateway`/
     * `ToolGateway.execute()` sin generiske klasse D-håndtering, IKKE egen
     * per-connector-kode, dekker denne handlingen identisk til `email.send`
     * uten ekstra arbeid her). **IKKE denne-økten-verifisert mot en live
     * hentet kopi av offisiell dokumentasjon** (nettverksegress blokkert i
     * dette miljøet, samme D-297-forbehold) - basert på trent kunnskap om
     * Microsoft Graph Mail API, se `MicrosoftOutlookTransport` sin
     * doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "microsoft_outlook", action: "list_messages", description: "List nylige e-poster (GET /me/messages, untrusted ingestion)",
      input_schema: record({ max: z.number().int().min(1).max(50).optional() }),
      capability_class: "A", scopes: ["Mail.Read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_OUTLOOK_TOKEN", output_trust: "untrusted", transport: transport("microsoft_outlook")
    },
    {
      // Sending av e-post er klasse D, SAMME begrunnelse som email.send over.
      tool_id: "microsoft_outlook", action: "send_mail", description: "Send e-post via Outlook (POST /me/sendMail, krever signert godkjenning)",
      input_schema: record({ to: z.string().max(254), subject: z.string().max(200), body: z.string().max(100_000) }),
      capability_class: "D", scopes: ["Mail.Send"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_OUTLOOK_TOKEN",
      output_trust: "internal", transport: transport("microsoft_outlook")
    },
    /**
     * D-311 (attende slice, Tobias direkte i chat gjentatt, ellevte gang:
     * "fortsett og jobbe ikke vent på ci"). `X-N8N-API-KEY`-header (IKKE
     * `Authorization: Bearer` - n8n sitt eget API-nøkkel-headernavn) mot
     * n8n sitt REST-API v1. n8n er TYPISK selv-hostet (SAMME
     * "typisk selv-hostet"-mønster som Grafana D-305/Prometheus D-306) -
     * base-URL-en må konfigureres via `JARVIS_N8N_API_BASE_URL`,
     * resolver-closure. `activate_workflow` er en EKTE klasse B-
     * skrivehandling (D-41), reversibel via `deactivate_workflow`
     * (IKKE bygget her ennå - bevisst DEFERRED, samme disiplin som
     * Dropbox/Notion sine deferred handlinger). **IKKE denne-økten-
     * verifisert mot en live hentet kopi av offisiell dokumentasjon**
     * (nettverksegress blokkert i dette miljøet, samme D-297-forbehold) -
     * basert på trent kunnskap om n8n sitt Public REST API, se
     * `N8nTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "n8n", action: "list_workflows", description: "List workflows (GET /api/v1/workflows, untrusted ingestion)",
      input_schema: empty,
      capability_class: "A", scopes: ["workflow:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_N8N_API_KEY", output_trust: "untrusted", transport: transport("n8n")
    },
    {
      tool_id: "n8n", action: "activate_workflow", description: "Aktiver en workflow (POST /api/v1/workflows/{id}/activate)",
      input_schema: record({ id: z.string() }),
      capability_class: "C", scopes: ["workflow:write"], reversible: true,
      rollback_procedure: "deaktiver workflowen via deactivate_workflow",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_N8N_API_KEY", output_trust: "internal", transport: transport("n8n")
    },
    {
      // D-388: D-311 sin DEFERRED motsats - gjør activate_workflow reversibel i kode, ikke bare «manuelt i UI».
      tool_id: "n8n", action: "deactivate_workflow", description: "Deaktiver en workflow (POST /api/v1/workflows/{id}/deactivate)",
      input_schema: record({ id: z.string() }),
      capability_class: "C", scopes: ["workflow:write"], reversible: true,
      rollback_procedure: "aktiver workflowen igjen via activate_workflow",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_N8N_API_KEY", output_trust: "internal", transport: transport("n8n")
    },
    /**
     * D-313 (bygget, flyttet ut av backlog): Spotify Web API. `credential_ref`
     * peker på REFRESH-tokenet (den faktiske, roterte secreten) - `client_id`/
     * `client_secret` er DELT app-konfig lest direkte fra env inne i
     * `spotifyAccessToken()`, SAMME mønster som `googleAccessToken()`
     * (Google Sheets D-299 bruker identisk oppdeling).
     * Nettverksegress blokkert i dette miljøet denne økten (D-297-forbehold) -
     * basert på trent kunnskap om Spotify sitt Web API/Accounts-API, se
     * `SpotifyTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "spotify", action: "get_currently_playing", description: "Hent nåværende avspilling (GET /v1/me/player/currently-playing, untrusted ingestion)",
      input_schema: empty,
      capability_class: "A", scopes: ["user-read-playback-state"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SPOTIFY_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("spotify")
    },
    {
      tool_id: "spotify", action: "add_to_queue", description: "Legg en sang til i avspillingskøen (POST /v1/me/player/queue)",
      input_schema: record({ uri: z.string() }),
      capability_class: "B", scopes: ["user-modify-playback-state"], reversible: true,
      rollback_procedure: "hopp over sangen manuelt via skip_to_next (Spotify har ikke et dedikert fjern-fra-kø endepunkt)",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_SPOTIFY_REFRESH_TOKEN", output_trust: "internal", transport: transport("spotify")
    },
    /**
     * D-314 (bygget, flyttet ut av backlog): WhatsApp Business Cloud API
     * (Meta Graph API). `phone_number_id` er Jarvis sin EGEN
     * avsender-identitet (SAMME rolle som Telegram sin `chat_id`),
     * injisert som en resolver-closure. `notify` navngitt IDENTISK med
     * Slack/Discord/Telegram sin send-melding-handling.
     * Nettverksegress blokkert i dette miljøet denne økten (D-297-forbehold) -
     * basert på trent kunnskap om Meta Graph API/WhatsApp Business Cloud
     * API, se `WhatsAppTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "whatsapp", action: "get_phone_number_info", description: "Les avsendernummerets metadata (GET /{phone_number_id}, untrusted ingestion)",
      input_schema: empty,
      capability_class: "A", scopes: ["whatsapp_business_management"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_WHATSAPP_TOKEN", output_trust: "untrusted", transport: transport("whatsapp")
    },
    {
      tool_id: "whatsapp", action: "notify", description: "Send melding via WhatsApp (POST /{phone_number_id}/messages)",
      input_schema: record({ to: z.string(), message: z.string().max(4096) }),
      capability_class: "C", scopes: ["whatsapp_business_messaging"], reversible: true,
      rollback_procedure: "send korreksjonsmelding", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_WHATSAPP_TOKEN", output_trust: "internal", transport: transport("whatsapp")
    },
    /**
     * D-315 (bygget, flyttet ut av backlog): Make (tidligere Integromat).
     * `Authorization: Token <token>` (IKKE Bearer) mot Make sitt API v2 -
     * zone-spesifikk base-URL, resolver-closure, SAMME mønster som n8n.
     * Nettverksegress blokkert i dette miljøet denne økten (D-297-forbehold) -
     * basert på trent kunnskap om Make sitt API v2, se `MakeTransport` sin
     * doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "make", action: "get_current_user", description: "Les egen brukeridentitet (GET /api/v2/users/me) - brukes som tilkoblingstest, ALDRI en ekte kjøring",
      input_schema: empty,
      capability_class: "A", scopes: ["user:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_MAKE_API_KEY", output_trust: "untrusted", transport: transport("make")
    },
    {
      tool_id: "make", action: "run_scenario", description: "Kjør en scenario (POST /api/v2/scenarios/{id}/run)",
      input_schema: record({ scenario_id: z.string() }),
      capability_class: "C", scopes: ["scenarios:run"], reversible: true,
      rollback_procedure: "ingen generell angrehandling - avhenger av hva scenarioet faktisk gjør, vurderes per scenario",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_MAKE_API_KEY", output_trust: "internal", transport: transport("make")
    },
    /**
     * D-316 (bygget, flyttet ut av backlog): OpenAI Images API. Egen
     * `tool_id` fra `openai` sin model_provider-oppføring (ModelGateway) -
     * strukturelt ulik kapabilitet (bildegenerering, ikke tekst-fullføring).
     * `list_models` er en GRATIS/sideeffekt-fri tilkoblingstest -
     * `generate_image` har EKTE kostnad per kall (ALDRI brukt som live_test).
     * Nettverksegress blokkert i dette miljøet denne økten (D-297-forbehold) -
     * basert på trent kunnskap om OpenAI sitt Images API, se
     * `OpenAIImagesTransport` sin doc-kommentar i `live-transports.ts`.
     */
    {
      tool_id: "openai_images", action: "list_models", description: "List tilgjengelige modeller (GET /v1/models, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: empty,
      capability_class: "A", scopes: ["models:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_OPENAI_IMAGES_API_KEY", output_trust: "untrusted", transport: transport("openai_images")
    },
    {
      tool_id: "openai_images", action: "generate_image", description: "Generer et bilde fra en tekstbeskrivelse (POST /v1/images/generations, EKTE kostnad per kall)",
      input_schema: record({ prompt: z.string().max(4000), n: z.number().min(1).max(10).optional(), size: z.string().optional() }),
      capability_class: "C", scopes: ["images:generate"], reversible: true,
      rollback_procedure: "ingen (ingen varig ekstern tilstand endres - kun forbrukt API-kvote/kostnad, kan ikke og trenger ikke reverseres)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 10,
      credential_ref: "JARVIS_OPENAI_IMAGES_API_KEY", output_trust: "internal", transport: transport("openai_images")
    },
    /**
     * D-321. SAMME "notify er ekte utsendelse (klasse B), get_account_info er
     * trygg tilkoblingstest (klasse A)"-mønster som Telegram/Slack/Discord/
     * Twilio (D-295) - Telnyx er en ordinær `ToolGateway`-meldingsleverandør-
     * connector, IKKE en `SpeechAdapter` (D-64-vurdering FØR bygging, se
     * `TelnyxTransport` sin doc-kommentar i `live-transports.ts`). ETT enkelt
     * Bearer-API-nøkkel (IKKE Twilio sin to-delte AccountSid/AuthToken-modell)
     * - `telnyx:send`/`telnyx:read` er interne Jarvis-plassholder-scopes,
     * SAMME konvensjon som Twilio sin `sms:send`/`sms:read`.
     */
    {
      tool_id: "telnyx", action: "notify", description: "Send SMS (POST /v2/messages)",
      input_schema: record({ to: z.string(), message: z.string().max(1600) }), capability_class: "C",
      scopes: ["telnyx:send"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TELNYX_API_KEY", output_trust: "internal", transport: transport("telnyx")
    },
    {
      tool_id: "telnyx", action: "get_account_info", description: "Les kontoens gjeldende saldo (GET /v2/balance) - brukes som tilkoblingstest, ALDRI en ekte SMS-utsendelse",
      input_schema: empty, capability_class: "A", scopes: ["telnyx:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_TELNYX_API_KEY",
      output_trust: "untrusted", transport: transport("telnyx")
    },
    /**
     * D-322. Runway sitt REST-API v1 (`api.dev.runwayml.com`) - BEKREFTET via
     * `WebSearch` denne økten (flere uavhengige kilder krysset), se
     * `RunwayTransport` sin doc-kommentar i `live-transports.ts` for full
     * evidens-kategorisering. `get_account_info` er GRATIS/sideeffekt-fri
     * (brukes som `live_test` NETTOPP fordi `generate_video` har reell
     * kostnad per kall, SAMME disiplin som OpenAI Images D-316).
     * `get_task_status` er også gratis lesing - asynkron generering krever
     * polling for å faktisk få resultatet.
     */
    {
      tool_id: "runway", action: "get_account_info", description: "Les organisasjonens kredittbalanse/tier (GET /v1/organization, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_RUNWAY_API_KEY",
      output_trust: "untrusted", transport: transport("runway")
    },
    {
      tool_id: "runway", action: "generate_video", description: "Generer en video fra et bilde + tekstbeskrivelse (POST /v1/image_to_video, EKTE kostnad per kall, asynkron - returnerer en task-id, poll get_task_status for resultat)",
      input_schema: record({
        promptImage: z.string(), promptText: z.string().max(1000).optional(),
        model: z.string().optional(), ratio: z.string().optional(), duration: z.number().min(1).max(60).optional()
      }),
      capability_class: "C", scopes: ["video:generate"], reversible: true,
      rollback_procedure: "ingen (ingen varig ekstern tilstand endres - kun forbrukt API-kreditt/kostnad, kan ikke og trenger ikke reverseres)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_RUNWAY_API_KEY", output_trust: "internal", transport: transport("runway")
    },
    {
      tool_id: "runway", action: "get_task_status", description: "Sjekk status/resultat for en tidligere generering (GET /v1/tasks/{id}, gratis/sideeffekt-fritt, untrusted ingestion - PÅKREVD for å faktisk hente ut ferdig video siden generate_video kun returnerer en task-id)",
      input_schema: record({ task_id: z.string() }), capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_RUNWAY_API_KEY",
      output_trust: "untrusted", transport: transport("runway")
    },
    /**
     * D-323. Kling sitt REST-API (`api.klingai.com`) - autentisering er en
     * selv-generert JWT (HS256, Access Key/Secret Key), IKKE en statisk
     * Bearer-token, se `KlingTransport` sin doc-kommentar i
     * `live-transports.ts` for full evidens-kategorisering.
     * `credential_ref` her er Secret Key (brukt til signering) - Access
     * Key injiseres separat som resolver-closure i main.ts/worker-main.ts
     * (SAMME "fast konfigurasjonsverdi utover credential"-mønster som
     * Twilio sin accountSid, D-295). BEVISST INGEN klasse A-handling her -
     * ingen verifisert gratis/parameterløst kontoendepunkt funnet denne
     * økten (D-41 DEFERRED), derfor heller ingen `live_test` i
     * connector-registry.ts.
     */
    {
      tool_id: "kling", action: "generate_video", description: "Generer en video fra et bilde + tekstbeskrivelse (POST /v1/videos/image2video, EKTE kostnad per kall, asynkron - returnerer en task-id, poll get_task_status for resultat)",
      input_schema: record({
        image_url: z.string(), prompt: z.string().max(1000).optional(),
        duration: z.string().optional(), aspect_ratio: z.string().optional()
      }),
      capability_class: "C", scopes: ["video:generate"], reversible: true,
      rollback_procedure: "ingen (ingen varig ekstern tilstand endres - kun forbrukt API-kreditt/kostnad, kan ikke og trenger ikke reverseres)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_KLING_SECRET_KEY", output_trust: "internal", transport: transport("kling")
    },
    {
      tool_id: "kling", action: "get_task_status", description: "Sjekk status/resultat for en tidligere generering (GET /v1/videos/image2video/{task_id}, gratis/sideeffekt-fritt, untrusted ingestion - PÅKREVD for å faktisk hente ut ferdig video siden generate_video kun returnerer en task-id)",
      input_schema: record({ task_id: z.string() }), capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_KLING_SECRET_KEY",
      output_trust: "untrusted", transport: transport("kling")
    },
    /**
     * D-324. Google Veo kjøres over den SAMME Gemini API-vert/auth-form som
     * `gemini` sin model_provider-oppføring (`x-goog-api-key`), men
     * `predictLongRunning` er en strukturelt ulik kapabilitet
     * (videogenerering, ikke tekst-fullføring) - egen `tool_id` her, se
     * `GoogleVeoTransport` sin doc-kommentar i `live-transports.ts` for full
     * evidens-kategorisering.
     */
    {
      tool_id: "google_veo", action: "list_models", description: "List tilgjengelige Gemini/Veo-modeller (GET /v1beta/models, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_VEO_API_KEY",
      output_trust: "untrusted", transport: transport("google_veo")
    },
    {
      tool_id: "google_veo", action: "generate_video", description: "Generer en video fra en tekstbeskrivelse (POST /v1beta/models/{model}:predictLongRunning, EKTE kostnad per kall, asynkron - returnerer et operation-navn, poll get_task_status for resultat)",
      input_schema: record({
        prompt: z.string(), model: z.string().optional(), aspect_ratio: z.string().optional()
      }),
      capability_class: "C", scopes: ["video:generate"], reversible: true,
      rollback_procedure: "ingen (ingen varig ekstern tilstand endres - kun forbrukt API-kreditt/kostnad, kan ikke og trenger ikke reverseres)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_GOOGLE_VEO_API_KEY", output_trust: "internal", transport: transport("google_veo")
    },
    {
      tool_id: "google_veo", action: "get_task_status", description: "Sjekk status/resultat for en tidligere generering (GET /v1beta/{operation_name}, gratis/sideeffekt-fritt, untrusted ingestion - PÅKREVD for å faktisk hente ut ferdig video siden generate_video kun returnerer et operation-navn)",
      input_schema: record({ operation_name: z.string() }), capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_VEO_API_KEY",
      output_trust: "untrusted", transport: transport("google_veo")
    },
    /**
     * D-327. Higgsfield sitt REST-API (`api.higgsfield.ai`) er en MULTI-
     * MODELL-markedsplass (proxyer tredjeparts-modeller under vertsnavnet,
     * f.eks. `bytedance/seedance-2.0`) - `model_path` er derfor et
     * PÅKREVD parameter fra kalleren (INGEN hardkodet default-modell), se
     * `HiggsfieldTransport` sin doc-kommentar i `live-transports.ts` for
     * full D-64-begrunnelse. `credential_ref` her er Key Secret - Key ID
     * injiseres separat som resolver-closure i main.ts/worker-main.ts.
     * BEVISST INGEN klasse A-handling/`live_test` - ingen verifisert
     * gratis/parameterløst kontoendepunkt funnet (D-41 DEFERRED).
     */
    {
      tool_id: "higgsfield", action: "generate_video", description: "Generer en video fra en tekstbeskrivelse via en NAVNGITT Higgsfield-modellsti (POST /{model_path}/text-to-video, EKTE kostnad per kall, asynkron - returnerer en request_id, poll get_task_status for resultat). model_path er PÅKREVD - Higgsfield er en multi-modell-markedsplass, ingen default-modell er valgt på forhånd",
      input_schema: record({ model_path: z.string(), prompt: z.string() }),
      capability_class: "C", scopes: ["video:generate"], reversible: true,
      rollback_procedure: "ingen (ingen varig ekstern tilstand endres - kun forbrukt API-kreditt/kostnad, kan ikke og trenger ikke reverseres)",
      idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 5,
      credential_ref: "JARVIS_HIGGSFIELD_KEY_SECRET", output_trust: "internal", transport: transport("higgsfield")
    },
    {
      tool_id: "higgsfield", action: "get_task_status", description: "Sjekk status/resultat for en tidligere generering (GET /requests/{request_id}/status, gratis/sideeffekt-fritt, untrusted ingestion - PÅKREVD for å faktisk hente ut ferdig video siden generate_video kun returnerer en request_id)",
      input_schema: record({ request_id: z.string() }), capability_class: "A", scopes: ["video:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_HIGGSFIELD_KEY_SECRET",
      output_trust: "untrusted", transport: transport("higgsfield")
    },
    /**
     * D-329. Todoist - FØRSTE av de seks D-64-port-krevende CRM-/
     * prosjektstyrings-leverandørene som faktisk er bygget (D-291 stengte
     * porten selv; dette er transport-laget). API-formen (unifisert
     * `/api/v1/`, IKKE den pensjonerte `/rest/v2/`-veien) er BEVISST
     * verifisert via WebSearch denne økten, se TodoistTransport sin doc-
     * kommentar i live-transports.ts. `delete_task` er BEVISST UTELATT
     * (D-41 DEFERRED) - ingen sekundærkilde bekreftet eksakt HTTP-metode/
     * status for slette-endepunktet i dette søket.
     */
    {
      tool_id: "todoist", action: "list_tasks", description: "List alle aktive oppgaver (GET /tasks, gratis/sideeffekt-fritt, untrusted ingestion - kun aktive/uferdige oppgaver returneres, lukkede er ikke tilgjengelig via dette endepunktet)",
      input_schema: empty, capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_TODOIST_API_TOKEN",
      output_trust: "untrusted", transport: transport("todoist")
    },
    {
      tool_id: "todoist", action: "get_task", description: "Hent én oppgave (GET /tasks/{task_id}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ task_id: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_TODOIST_API_TOKEN",
      output_trust: "untrusted", transport: transport("todoist")
    },
    {
      tool_id: "todoist", action: "create_task", description: "Opprett en ny oppgave (POST /tasks, EKTE ekstern tilstand skapes)",
      input_schema: record({
        content: z.string(), project_id: z.string().optional(), description: z.string().optional(),
        due_string: z.string().optional(), priority: z.number().optional()
      }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "close_task eller manuell sletting i Todoist",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TODOIST_API_TOKEN", output_trust: "internal", transport: transport("todoist")
    },
    {
      tool_id: "todoist", action: "update_task", description: "Oppdater felter på en eksisterende oppgave (POST /tasks/{task_id}, delvis oppdatering)",
      input_schema: record({
        task_id: z.string(), content: z.string().optional(), description: z.string().optional(),
        due_string: z.string().optional(), priority: z.number().optional()
      }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "ny update_task med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TODOIST_API_TOKEN", output_trust: "internal", transport: transport("todoist")
    },
    {
      tool_id: "todoist", action: "close_task", description: "Fullfør (lukk) en oppgave (POST /tasks/{task_id}/close, returnerer 204)",
      input_schema: record({ task_id: z.string() }), capability_class: "B", scopes: ["tasks:write"],
      reversible: true, rollback_procedure: "reopen_task med samme task_id",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TODOIST_API_TOKEN", output_trust: "internal", transport: transport("todoist")
    },
    {
      tool_id: "todoist", action: "reopen_task", description: "Gjenåpne en tidligere lukket oppgave, samme id (POST /tasks/{task_id}/reopen, returnerer 204)",
      input_schema: record({ task_id: z.string() }), capability_class: "B", scopes: ["tasks:write"],
      reversible: true, rollback_procedure: "close_task med samme task_id",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TODOIST_API_TOKEN", output_trust: "internal", transport: transport("todoist")
    },
    /**
     * D-330. Trello - ANDRE av de seks D-64-port-krevende faktisk bygget
     * (D-291 stengte porten; D-329 bygget Todoist FØRST). `key`/`token`
     * som query-parametere (IKKE en Authorization-header), se
     * TrelloTransport sin doc-kommentar i live-transports.ts.
     */
    {
      tool_id: "trello", action: "list_boards", description: "List alle boards eieren har tilgang til (GET /members/me/boards, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_TRELLO_TOKEN",
      output_trust: "untrusted", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "list_cards", description: "List alle kort på et board (GET /boards/{board_id}/cards, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ board_id: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_TRELLO_TOKEN",
      output_trust: "untrusted", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "get_card", description: "Hent ett kort (GET /cards/{card_id}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ card_id: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_TRELLO_TOKEN",
      output_trust: "untrusted", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "create_card", description: "Opprett et nytt kort på en liste (POST /cards, EKTE ekstern tilstand skapes)",
      input_schema: record({ list_id: z.string(), name: z.string(), desc: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "close_card eller manuell sletting i Trello",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TRELLO_TOKEN", output_trust: "internal", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "update_card", description: "Oppdater felter på et eksisterende kort (PUT /cards/{card_id}, delvis oppdatering)",
      input_schema: record({ card_id: z.string(), name: z.string().optional(), desc: z.string().optional(), list_id: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "ny update_card med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TRELLO_TOKEN", output_trust: "internal", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "close_card", description: "Arkiver (lukk) et kort (PUT /cards/{card_id} {closed:true})",
      input_schema: record({ card_id: z.string() }), capability_class: "B", scopes: ["tasks:write"],
      reversible: true, rollback_procedure: "reopen_card med samme card_id",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TRELLO_TOKEN", output_trust: "internal", transport: transport("trello")
    },
    {
      tool_id: "trello", action: "reopen_card", description: "Gjenåpne et tidligere arkivert kort, samme id (PUT /cards/{card_id} {closed:false})",
      input_schema: record({ card_id: z.string() }), capability_class: "B", scopes: ["tasks:write"],
      reversible: true, rollback_procedure: "close_card med samme card_id",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TRELLO_TOKEN", output_trust: "internal", transport: transport("trello")
    },
    /**
     * D-331. Jira - TREDJE av de seks D-64-port-krevende faktisk bygget
     * (D-291 stengte porten; D-329/D-330 bygget Todoist/Trello først).
     * `/rest/api/3/search/jql` (IKKE den fjernede `/search`-veien), Basic
     * auth (`email:api_token`), base-URL er per-tenant - se JiraTransport
     * sin doc-kommentar i live-transports.ts.
     */
    {
      // D-349 (Tobias live via Charlie: "test jira" → 400 Bad Request BÅDE med og
      // uten oppgitt jql). WebSearch-verifisert mot Atlassian sin egen dokumentasjon
      // denne økten: /rest/api/3/search/jql krever en "bounded" JQL - en TOM streng
      // gir eksplisitt 400 ("unbounded query"). z.string() alene tillater "" å bestå
      // Zod-valideringen, som deretter sendte en tom/uendret query til Jira og fikk
      // en forvirrende live 400 i stedet for en rask, lokal, forklarende avvisning -
      // .min(1) lukker gapet FØR nettverkskallet i det hele tatt skjer.
      tool_id: "jira", action: "search_issues", description: "Søk etter issues med JQL (GET /rest/api/3/search/jql, gratis/sideeffekt-fritt, untrusted ingestion - den gamle /search-veien er HELT FJERNET fra Jira Cloud)",
      input_schema: record({ jql: z.string().min(1) }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_JIRA_API_TOKEN",
      output_trust: "untrusted", transport: transport("jira")
    },
    {
      tool_id: "jira", action: "get_issue", description: "Hent én issue (GET /rest/api/3/issue/{issue_key}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ issue_key: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_JIRA_API_TOKEN",
      output_trust: "untrusted", transport: transport("jira")
    },
    {
      tool_id: "jira", action: "list_transitions", description: "List tilgjengelige status-overganger for en issue (GET /rest/api/3/issue/{issue_key}/transitions, gratis/sideeffekt-fritt - PÅKREVD for å finne riktig transition_id FØR transition_issue)",
      input_schema: record({ issue_key: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_JIRA_API_TOKEN",
      output_trust: "untrusted", transport: transport("jira")
    },
    {
      tool_id: "jira", action: "create_issue", description: "Opprett en ny issue (POST /rest/api/3/issue, EKTE ekstern tilstand skapes - description konverteres internt til Atlassian Document Format)",
      input_schema: record({ project_key: z.string(), summary: z.string(), issue_type: z.string(), description: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "manuell sletting/arkivering i Jira",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_JIRA_API_TOKEN", output_trust: "internal", transport: transport("jira")
    },
    {
      tool_id: "jira", action: "update_issue", description: "Oppdater felter på en eksisterende issue (PUT /rest/api/3/issue/{issue_key}, delvis oppdatering)",
      input_schema: record({ issue_key: z.string(), summary: z.string().optional(), description: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "ny update_issue med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_JIRA_API_TOKEN", output_trust: "internal", transport: transport("jira")
    },
    {
      tool_id: "jira", action: "transition_issue", description: "Flytt en issue til en ny status (POST /rest/api/3/issue/{issue_key}/transitions {transition:{id}} - transition_id må hentes via list_transitions FØRST)",
      input_schema: record({ issue_key: z.string(), transition_id: z.string() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: false,
      rollback_procedure: "ny transition_issue til en tilbake-transition, hvis en slik finnes i workflowen (IKKE garantert reversibel)",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_JIRA_API_TOKEN", output_trust: "internal", transport: transport("jira")
    },
    /**
     * D-332. Linear - FJERDE av de seks D-64-port-krevende faktisk bygget
     * (D-291 stengte porten; D-329/D-330/D-331 bygget Todoist/Trello/Jira
     * først). ETT GraphQL-endepunkt, INGEN REST-API - se LinearTransport
     * sin doc-kommentar i live-transports.ts. Rå API-nøkkel i
     * Authorization-headeren, BEKREFTET UTEN Bearer-prefiks.
     */
    {
      tool_id: "linear", action: "list_teams", description: "List alle team eieren har tilgang til (GraphQL query, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: empty, capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_LINEAR_API_KEY",
      output_trust: "untrusted", transport: transport("linear")
    },
    {
      tool_id: "linear", action: "list_issues", description: "List issues, valgfritt filtrert på team_id (GraphQL query, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ team_id: z.string().optional() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_LINEAR_API_KEY",
      output_trust: "untrusted", transport: transport("linear")
    },
    {
      tool_id: "linear", action: "get_issue", description: "Hent én issue (GraphQL query, gratis/sideeffekt-fritt, untrusted ingestion - issue_id kan være UUID eller identifier som 'ENG-123')",
      input_schema: record({ issue_id: z.string() }), capability_class: "A", scopes: ["tasks:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_LINEAR_API_KEY",
      output_trust: "untrusted", transport: transport("linear")
    },
    {
      tool_id: "linear", action: "create_issue", description: "Opprett en ny issue (GraphQL mutation issueCreate, EKTE ekstern tilstand skapes)",
      input_schema: record({ team_id: z.string(), title: z.string(), description: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "manuell arkivering/sletting i Linear",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_LINEAR_API_KEY", output_trust: "internal", transport: transport("linear")
    },
    {
      tool_id: "linear", action: "update_issue", description: "Oppdater felter på en eksisterende issue, inkl. status via state_id (GraphQL mutation issueUpdate, delvis oppdatering)",
      input_schema: record({ issue_id: z.string(), title: z.string().optional(), description: z.string().optional(), state_id: z.string().optional() }),
      capability_class: "B", scopes: ["tasks:write"], reversible: true,
      rollback_procedure: "ny update_issue med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_LINEAR_API_KEY", output_trust: "internal", transport: transport("linear")
    },
    /**
     * D-333. HubSpot - FEMTE av de seks D-64-port-krevende faktisk bygget
     * (D-291 stengte porten; D-329/D-330/D-331/D-332 bygget Todoist/Trello/
     * Jira/Linear først). `/crm/v3/objects/{objectType}` - `object_type`
     * er PÅKREVD fra kalleren (contacts/companies/deals deler EKSAKT
     * samme URL-mønster), se HubSpotTransport sin doc-kommentar i
     * live-transports.ts.
     */
    {
      tool_id: "hubspot", action: "list_objects", description: "List objekter av en gitt type (GET /crm/v3/objects/{object_type}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["contacts", "companies", "deals"]), limit: z.number().optional() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_HUBSPOT_API_KEY",
      output_trust: "untrusted", transport: transport("hubspot")
    },
    {
      tool_id: "hubspot", action: "get_object", description: "Hent ett objekt (GET /crm/v3/objects/{object_type}/{id}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["contacts", "companies", "deals"]), id: z.string() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_HUBSPOT_API_KEY",
      output_trust: "untrusted", transport: transport("hubspot")
    },
    {
      tool_id: "hubspot", action: "search_objects", description: "Søk etter objekter med HubSpot sin filterGroups-syntaks (POST /crm/v3/objects/{object_type}/search, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["contacts", "companies", "deals"]), filter_groups: z.array(z.record(z.string(), z.unknown())).optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_HUBSPOT_API_KEY",
      output_trust: "untrusted", transport: transport("hubspot")
    },
    {
      tool_id: "hubspot", action: "create_object", description: "Opprett et nytt objekt (POST /crm/v3/objects/{object_type} {properties}, EKTE ekstern tilstand skapes)",
      input_schema: record({ object_type: z.enum(["contacts", "companies", "deals"]), properties: z.record(z.string(), z.unknown()) }),
      capability_class: "B", scopes: ["crm:write"], reversible: true,
      rollback_procedure: "manuell arkivering/sletting i HubSpot",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_HUBSPOT_API_KEY", output_trust: "internal", transport: transport("hubspot")
    },
    {
      tool_id: "hubspot", action: "update_object", description: "Oppdater felter på et eksisterende objekt (PATCH /crm/v3/objects/{object_type}/{id} {properties}, delvis oppdatering)",
      input_schema: record({ object_type: z.enum(["contacts", "companies", "deals"]), id: z.string(), properties: z.record(z.string(), z.unknown()) }),
      capability_class: "B", scopes: ["crm:write"], reversible: true,
      rollback_procedure: "ny update_object med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_HUBSPOT_API_KEY", output_trust: "internal", transport: transport("hubspot")
    },
    /**
     * D-334. Pipedrive - SJETTE og SISTE av de seks D-64-port-krevende
     * faktisk bygget (D-291 stengte porten; D-329 til D-333 bygget
     * Todoist/Trello/Jira/Linear/HubSpot først). `/api/v2/{objectType}` -
     * `object_type` er PÅKREVD fra kalleren (persons/organizations/deals
     * deler EKSAKT samme URL-mønster), se PipedriveTransport sin doc-
     * kommentar i live-transports.ts.
     */
    {
      tool_id: "pipedrive", action: "list_objects", description: "List objekter av en gitt type (GET /api/v2/{object_type}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["persons", "organizations", "deals"]), limit: z.number().optional() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_PIPEDRIVE_API_KEY",
      output_trust: "untrusted", transport: transport("pipedrive")
    },
    {
      tool_id: "pipedrive", action: "get_object", description: "Hent ett objekt (GET /api/v2/{object_type}/{id}, gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["persons", "organizations", "deals"]), id: z.string() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_PIPEDRIVE_API_KEY",
      output_trust: "untrusted", transport: transport("pipedrive")
    },
    {
      tool_id: "pipedrive", action: "search_objects", description: "Søk etter objekter med et fritekst-søkeord (GET /api/v2/{object_type}/search?term=..., gratis/sideeffekt-fritt, untrusted ingestion)",
      input_schema: record({ object_type: z.enum(["persons", "organizations", "deals"]), term: z.string() }),
      capability_class: "A", scopes: ["crm:read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_PIPEDRIVE_API_KEY",
      output_trust: "untrusted", transport: transport("pipedrive")
    },
    {
      tool_id: "pipedrive", action: "create_object", description: "Opprett et nytt objekt (POST /api/v2/{object_type} {properties}, EKTE ekstern tilstand skapes)",
      input_schema: record({ object_type: z.enum(["persons", "organizations", "deals"]), properties: z.record(z.string(), z.unknown()) }),
      capability_class: "B", scopes: ["crm:write"], reversible: true,
      rollback_procedure: "manuell arkivering/sletting i Pipedrive",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_PIPEDRIVE_API_KEY", output_trust: "internal", transport: transport("pipedrive")
    },
    {
      tool_id: "pipedrive", action: "update_object", description: "Oppdater felter på et eksisterende objekt (PATCH /api/v2/{object_type}/{id} {properties}, delvis oppdatering)",
      input_schema: record({ object_type: z.enum(["persons", "organizations", "deals"]), id: z.string(), properties: z.record(z.string(), z.unknown()) }),
      capability_class: "B", scopes: ["crm:write"], reversible: true,
      rollback_procedure: "ny update_object med forrige verdier",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_PIPEDRIVE_API_KEY", output_trust: "internal", transport: transport("pipedrive")
    },
    ...(config.additionalTools ?? [])
  ];
}

/**
 * Ingestion-pipeline (SECURITY_MODEL §2/§9): ekstern kilde → Ingestion Zone →
 * karantene via fase 4-MemoryWriter (untrusted blir ALDRI autoritativt uten
 * policy-godkjent promotering). Proveniens/tenant/tid/tillit bevares.
 */
export class IngestionService {
  constructor(private readonly writer: MemoryWriter) {}

  async ingestExternal(
    identity: IdentityContext,
    source: { kind: "document" | "tool"; ref: string },
    content: string
  ) {
    return this.writer.ingestText(identity, { ...source, trust: "untrusted" }, content);
  }
}
