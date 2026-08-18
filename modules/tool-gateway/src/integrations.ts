import { z } from "zod";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { MemoryWriter } from "@jarvis/memory";
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

/** Standard førstebølge-register. transportOverride lar tester injisere fakes. */
export function firstWaveTools(transports: Partial<Record<string, ToolTransport>> = {}): ToolDefinition[] {
  const transport = (key: string) => transports[key] ?? new UnconfiguredHttpTransport(key);
  return [
    {
      tool_id: "github", action: "read_issues", description: "Les issues (untrusted ingestion)",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "create_pr", description: "Opprett PR fra jobb-branch (aldri merge)",
      input_schema: record({ repo: z.string(), branch: z.string(), title: z.string() }),
      capability_class: "C", scopes: ["repo:write-pr"], reversible: true,
      rollback_procedure: "lukk PR", idempotent_external: false, timeout_ms: 15_000,
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
      input_schema: record({ to: z.string(), subject: z.string(), body: z.string() }),
      capability_class: "D", scopes: ["mail.send"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "internal", transport: transport("email")
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
      tool_id: "vercel", action: "read_deployments", description: "Les deploy-status",
      input_schema: empty, capability_class: "A", scopes: ["deployments:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
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
      tool_id: "drive", action: "delete_permanent", description: "Slett en Drive-fil/mappe PERMANENT (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string() }), capability_class: "D",
      scopes: ["drive.delete"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      // Deling/tilgangsstyring er sikkerhetskritisk (kan eksponere innhold for
      // nye parter) - klasse D uavhengig av at selve handlingen teknisk er
      // reverserbar (fjerne tilgangen igjen).
      tool_id: "drive", action: "create_permission", description: "Del en Drive-fil/mappe med en bruker/domene/alle (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), role: z.string(), type: z.string(), email_address: z.string().optional(), domain: z.string().optional() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "fjern den opprettede tilgangen (delete_permission)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
    },
    {
      tool_id: "drive", action: "update_permission", description: "Endre rollen på en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string(), role: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "sett rollen tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
    },
    {
      tool_id: "drive", action: "delete_permission", description: "Fjern en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "gjenopprett tilgangen manuelt (ikke automatisk reverserbar)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
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
      tool_id: "business", action: "update_opportunity_stage", description: "Flytt en salgsmulighet til et nytt pipeline-stadium",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), opportunity_id: z.string(), stage: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett stage tilbake til forrige verdi", idempotent_external: true,
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
    // UA-3 Support/Tickets (D-64): Zendesk full read/write/delete/admin-kapabilitet
    // (Owner Connector Capability Invariant, D-41 - IKKE read-only fordi det er
    // enklere). Lagt til på SLUTTEN av arrayet (samme presedens som alle
    // tidligere tillegg - eksisterende tester indekserer dette arrayet
    // posisjonelt). OAuth refresh-token credential (§5/§7 i byggeordren).
    {
      tool_id: "zendesk", action: "list_tickets", description: "List nylig oppdaterte Zendesk-tickets (untrusted ingestion)",
      input_schema: record({ max: z.number().int().min(1).max(100).optional(), updated_since: z.string().optional() }),
      capability_class: "A", scopes: ["zendesk.tickets.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "get_ticket", description: "Les ett Zendesk-ticket med side-lastet requester/organisasjon (untrusted ingestion)",
      input_schema: record({ ticket_id: z.string() }), capability_class: "A",
      scopes: ["zendesk.tickets.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "search_tickets", description: "Søk Zendesk-tickets med fritekst-/felt-spørring (untrusted ingestion)",
      input_schema: record({ query: z.string() }), capability_class: "A",
      scopes: ["zendesk.tickets.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "get_ticket_audits", description: "Les full endringshistorikk (status/felt/tildeling/tagger) for ett ticket - Zendesk sin egen historikk, IKKE Jarvis sin audit_events",
      input_schema: record({ ticket_id: z.string() }), capability_class: "A",
      scopes: ["zendesk.tickets.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "get_user", description: "Les én Zendesk-bruker (untrusted ingestion)",
      input_schema: record({ user_id: z.string() }), capability_class: "A",
      scopes: ["zendesk.users.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "search_users", description: "Søk Zendesk-brukere (untrusted ingestion)",
      input_schema: record({ query: z.string() }), capability_class: "A",
      scopes: ["zendesk.users.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "get_organization", description: "Les én Zendesk-organisasjon (untrusted ingestion)",
      input_schema: record({ organization_id: z.string() }), capability_class: "A",
      scopes: ["zendesk.organizations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "search_organizations", description: "Søk Zendesk-organisasjoner (untrusted ingestion)",
      input_schema: record({ query: z.string() }), capability_class: "A",
      scopes: ["zendesk.organizations.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN", output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "list_groups", description: "List Zendesk-agentgrupper (admin-synlighet, lesing)",
      input_schema: empty, capability_class: "A", scopes: ["zendesk.admin.read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "list_agents", description: "List Zendesk-agenter/admins (admin-synlighet, lesing)",
      input_schema: empty, capability_class: "A", scopes: ["zendesk.admin.read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "list_webhooks", description: "List Zendesk-webhooks (admin-synlighet, lesing)",
      input_schema: empty, capability_class: "A", scopes: ["zendesk.admin.read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "untrusted", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "create_ticket", description: "Opprett et nytt Zendesk-ticket (kundesynlig - klasse C)",
      input_schema: record({
        subject: z.string(), description: z.string().optional(), requester_email: z.string().optional(),
        priority: z.string().optional(), tags: z.array(z.string()).optional()
      }),
      capability_class: "C", scopes: ["zendesk.tickets.write"], reversible: true,
      rollback_procedure: "delete_ticket (myk sletting)", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "update_ticket", description: "Konsolidert oppdatering av status/prioritet/tildeling/tagger/egendefinerte felt (internt/reversibelt - klasse B)",
      input_schema: record({
        ticket_id: z.string(), status: z.string().optional(), priority: z.string().optional(),
        assignee_id: z.string().optional(), tags: z.array(z.string()).optional(),
        custom_fields: z.array(z.object({ id: z.number(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })).optional()
      }),
      capability_class: "B", scopes: ["zendesk.tickets.write"], reversible: true,
      rollback_procedure: "sett feltene tilbake til forrige verdi via samme handling", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "get_ticket"
    },
    {
      tool_id: "zendesk", action: "add_internal_note", description: "Legg til en INTERN note (ikke kundesynlig - klasse B)",
      input_schema: record({ ticket_id: z.string(), body: z.string() }),
      capability_class: "B", scopes: ["zendesk.tickets.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - notatet blir en del av tickethistorikken", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk")
    },
    {
      tool_id: "zendesk", action: "reply_ticket", description: "Send et OFFENTLIG, kundesynlig svar (krever signert godkjenning for delegerte identiteter - klasse C)",
      input_schema: record({ ticket_id: z.string(), body: z.string() }),
      capability_class: "C", scopes: ["zendesk.tickets.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - svaret er sendt til kunden", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk")
    },
    {
      // Myk sletting hos Zendesk (30-dagers gjenoppretting), likevel klasse D -
      // kundedata-sensitiv, samme forsiktighetsprinsipp som email.send.
      tool_id: "zendesk", action: "delete_ticket", description: "Slett et Zendesk-ticket (myk sletting, 30-dagers gjenopprettingsvindu hos Zendesk - krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ ticket_id: z.string() }), capability_class: "D",
      scopes: ["zendesk.tickets.delete"], reversible: true,
      rollback_procedure: "gjenopprett fra Zendesk sin \"Deleted tickets\"-visning innen 30 dager", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "get_ticket"
    },
    {
      tool_id: "zendesk", action: "redact_ticket_content", description: "Overskriv permanent kommentarinnhold på et ticket (GDPR-redigering - IKKE reverserbar, krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ ticket_id: z.string(), comment_id: z.string(), text: z.string() }),
      capability_class: "D", scopes: ["zendesk.tickets.redact"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "get_ticket"
    },
    {
      // Config-as-code (§14 i byggeordren): Jarvis sin EGEN webhook-registrering
      // hos Zendesk - sikkerhetskritisk (styrer hvor Zendesk sender hendelser),
      // klasse D uavhengig av teknisk reverserbarhet, samme prinsipp som Drive
      // sin deling/tilgangsstyring.
      tool_id: "zendesk", action: "create_webhook", description: "Registrer en ny Zendesk-webhook (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ name: z.string(), endpoint: z.string(), subscriptions: z.array(z.string()).optional() }),
      capability_class: "D", scopes: ["zendesk.admin.write"], reversible: true,
      rollback_procedure: "delete_webhook (fjern den opprettede webhooken)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "list_webhooks"
    },
    {
      tool_id: "zendesk", action: "update_webhook", description: "Oppdater status/endepunkt for en eksisterende Zendesk-webhook (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ webhook_id: z.string(), status: z.string().optional(), endpoint: z.string().optional() }),
      capability_class: "D", scopes: ["zendesk.admin.write"], reversible: true,
      rollback_procedure: "sett feltene tilbake til forrige verdi via samme handling", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "list_webhooks"
    },
    {
      tool_id: "zendesk", action: "delete_webhook", description: "Fjern en eksisterende Zendesk-webhook (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ webhook_id: z.string() }), capability_class: "D",
      scopes: ["zendesk.admin.write"], reversible: true,
      rollback_procedure: "gjenopprett webhooken manuelt (ikke automatisk reverserbar)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_ZENDESK_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("zendesk"), preflight_action: "list_webhooks"
    },
    {
      tool_id: "business", action: "sync_zendesk_tickets", description: "Synkroniser nylige Zendesk-tickets inn i forretningstidslinjen + open-loop-reevaluering (deterministisk kontakt-/selskaps-gjenkjenning, aldri gjettet)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), max: z.number().int().min(1).max(100).optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - append-only tidslinje, re-sync er trygt (idempotent)",
      idempotent_external: true, timeout_ms: 30_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", output_trust: "internal", transport: transport("business")
    }
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
