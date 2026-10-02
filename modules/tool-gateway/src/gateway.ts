import type pg from "pg";
import { z } from "zod";
import type { CapabilityClass, IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import { isSelfRecoveryAction, type OwnerControls, type PolicyGateway } from "@jarvis/policy";

/** Secrets bak adapter (D-16): env/SOPS nå; Infisical/OpenBao (Q-05, krever Docker) senere. */
export interface SecretProvider {
  readonly name: string;
  /** Returnerer credential eller null. Verdien går ALDRI i logg/trace/modellkontekst. */
  get(ref: string): Promise<string | null>;
}
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env-sops";
  /**
   * D-236 (funn i Tobias sin faktiske host-kjøring, 2026-09-22): en linje som
   * `JARVIS_VIPPS_CLIENT_ID=` i `.env` (uutfylt placeholder, IKKE et bevisst
   * tomt secret) gir `process.env[ref] === ""` inne i containeren - IKKE
   * `undefined`. Det opprinnelige `process.env[ref] ?? null` fanget kun
   * `undefined`/`null`, aldri tom streng, så `hasSecret()`/dashbordets
   * "konfigurert"-visning viste FEILAKTIG ✓ for enhver connector der
   * `.env.example` har en uutfylt `NØKKEL=`-linje for referansen (så godt
   * som alle) - reprodusert live: Vipps viste "konfigurert" med tomme
   * `.env`-felt. En tom streng er ALDRI en gyldig credential-verdi, uansett
   * kilde - behandles nå identisk med "ikke satt".
   */
  async get(ref: string): Promise<string | null> {
    const value = process.env[ref];
    return value ? value : null;
  }
}

/**
 * Task #122 (connector credential-skriving, D-213): en SEPARAT, opt-in
 * kapabilitet - IKKE en del av `SecretProvider` selv (som `FallbackSecretProvider`
 * og `EnvSecretProvider`/`BusinessInternalSecretProvider` FORTSATT bare
 * implementerer les-kontrakten, uendret). Kun leverandører som FAKTISK
 * tilbyr en skrive-API (i dag: Infisical) implementerer denne - et forsøk på
 * å skrive mot en ikke-skrivbar kjede skal feile TYDELIG
 * (`secret_provider_not_writable`), ALDRI stille falle tilbake til å skrive
 * et sted (f.eks. `.env`, som er git-ignorert og IKKE et sted kjørende kode
 * trygt kan skrive til uten å risikere å miste eierens egne, manuelt satte
 * verdier - se D-41: read-only er kun akseptabelt når leverandøren faktisk
 * ikke tilbyr mer ELLER en genuin isolasjonsgrense hindrer det, aldri fordi
 * det var enklere å kode).
 */
export interface WritableSecretProvider extends SecretProvider {
  /** Skriver (oppretter ELLER oppdaterer) en secret-verdi. Verdien logges/auditeres ALDRI. */
  set(ref: string, value: string): Promise<void>;
}
export function isWritableSecretProvider(provider: SecretProvider): provider is WritableSecretProvider {
  return typeof (provider as Partial<WritableSecretProvider>).set === "function";
}
/**
 * Infisical-secret-provider (D-35): maskinidentitet (universal auth) → hent
 * secret via API. Rå verdi returneres KUN til transport-laget; aldri logget,
 * aldri til modell/Langfuse. Helse eksponeres for /status.
 */
export class InfisicalSecretProvider implements SecretProvider {
  readonly name = "infisical";
  private token: string | null = null;
  health: "healthy" | "unavailable" | "unconfigured" = "unconfigured";

  constructor(
    private readonly baseUrl = process.env["INFISICAL_URL"],
    private readonly clientId = process.env["INFISICAL_CLIENT_ID"],
    private readonly clientSecret = process.env["INFISICAL_CLIENT_SECRET"],
    private readonly projectId = process.env["INFISICAL_PROJECT_ID"],
    // D-340: samme "en tom, men til stede, .env-verdi ER IKKE 'usatt'"-bug
    // D-236 (rett over, EnvSecretProvider.get()) allerede fikset i DENNE
    // filen - `??` fanger kun null/undefined, ikke tom streng, så en uutfylt
    // `INFISICAL_ENV=`-linje i .env ga tidligere `environment=""` i alle
    // Infisical-kall i stedet for defaulten "dev". `||` (streng, aldri en
    // gyldig tom verdi) løser det samme her, samme semantikk som ovenfor.
    private readonly env = process.env["INFISICAL_ENV"] || "dev"
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret && this.projectId);
  }

  private async login(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret })
    });
    if (!response.ok) throw new Error(`infisical_login_${response.status}`);
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  async get(ref: string): Promise<string | null> {
    if (!this.available()) {
      this.health = "unconfigured";
      return null;
    }
    try {
      this.token ??= await this.login();
      const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}?workspaceId=${this.projectId}&environment=${this.env}`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (response.status === 401) { this.token = null; throw new Error("infisical_auth_expired"); }
      if (response.status === 404) { this.health = "healthy"; return null; }
      if (!response.ok) throw new Error(`infisical_${response.status}`);
      this.health = "healthy";
      return ((await response.json()) as { secret: { secretValue: string } }).secret.secretValue;
    } catch {
      this.health = "unavailable";
      return null; // fail-closed her; FallbackSecretProvider håndterer rollback
    }
  }

  /**
   * Task #122 (D-213): upsert - PATCH (oppdater eksisterende) FØRST, POST
   * (opprett) KUN på 404 (secreten fantes ikke fra før). Rekkefølgen er
   * bevisst: eieren limer ofte inn en NY verdi for en referanse som ALLEREDE
   * har en (utløpt/feil) verdi fra en tidligere manuell oppsett - PATCH er
   * derfor det VANLIGE tilfellet, POST unntaket. Infisical raw secrets v3-
   * API-et (offisiell dokumentasjon, ikke gjettet): `PATCH /api/v3/secrets/
   * raw/{secretName}` og `POST /api/v3/secrets/raw/{secretName}`, begge med
   * kropp `{workspaceId, environment, secretValue}`. Verdien logges ALDRI -
   * kun HTTP-status/feilkode fanges i feilmeldinger.
   */
  async set(ref: string, value: string): Promise<void> {
    if (!this.available()) {
      throw new Error("infisical_unconfigured");
    }
    this.token ??= await this.login();
    const url = `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(ref)}`;
    const body = JSON.stringify({ workspaceId: this.projectId, environment: this.env, secretValue: value });
    const headers = { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
    let response = await fetch(url, { method: "PATCH", headers, body });
    if (response.status === 401) {
      this.token = null;
      throw new Error("infisical_auth_expired");
    }
    if (response.status === 404) {
      response = await fetch(url, { method: "POST", headers, body });
    }
    if (!response.ok) {
      this.health = "unavailable";
      throw new Error(`infisical_set_${response.status}`);
    }
    this.health = "healthy";
  }
}

/**
 * Staged migration (D-35): prøv primær (vault) først, fall tilbake til .env
 * hvis vault mangler verdien eller er nede. Gir trygg rollback i overgangen.
 */
export class FallbackSecretProvider implements SecretProvider {
  readonly name = "fallback";
  constructor(
    private readonly primary: SecretProvider,
    private readonly fallback: SecretProvider
  ) {}
  async get(ref: string): Promise<string | null> {
    return (await this.primary.get(ref)) ?? this.fallback.get(ref);
  }
}

/**
 * SECURITY FIX #2 (D-68): kontekst fra DEN OPPRINNELIGE kalleren - IdentityContext
 * og en evt. medfulgt signert godkjenning - som en transport kan trenge for å gjøre
 * et NØSTET, autoritetsbevisst `ToolGateway.execute()`-kall (i dag: `SupportTransport`
 * sin `reply`, som ruter GJENNOM `email.send`, klasse D). ALDRI en fabrikkert/eskalert
 * identitet - `resolveAuthorityMode()` skal EVALUERE den ekte kalleren, aldri stoles
 * blindt på. De aller fleste transporter trenger den ikke og kan la parameteren stå
 * ureferert (strukturell typing tillater færre deklarerte parametre - allerede
 * etablert praksis, se f.eks. `FakeTransport`/`UnconfiguredHttpTransport`).
 */
export interface ToolInvocationContext {
  identity: IdentityContext;
  approval?: unknown;
  /**
   * D-317 (modell-selvbevissthet i `check_my_capabilities`): hvilken
   * leverandør/modell som FAKTISK genererer DENNE samtaleturen, hentet fra
   * `ToolCallRequest.provider`/`.model` (allerede stemplet av hver adapter,
   * se `packages/provider-adapters/src/types.ts`). SAMME "ALDRI fra
   * `parameters`, kun trusted-lag"-disiplin som `identity`/`approval` over -
   * en modell kan ALDRI oppgi sin egen leverandør/modell-identitet selv
   * (ville vært nøyaktig den konfabulasjonsveien `check_my_capabilities`
   * finnes for å stenge).
   */
  servingModel?: { provider: string; model: string };
}

/** Transport per integrasjon: ekte HTTP i drift, kontrollert fake i test. */
export interface ToolTransport {
  invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    credential: string,
    context: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }>;
}

/** Maskinlesbar verktøydefinisjon (INTEGRATIONS.md §2). */
export interface ToolDefinition {
  tool_id: string;
  action: string;
  description: string;
  input_schema: z.ZodType<Record<string, JsonValue>>;
  capability_class: CapabilityClass;
  scopes: string[];
  reversible: boolean;
  rollback_procedure: string;
  idempotent_external: boolean;
  timeout_ms: number;
  rate_limit_per_minute: number;
  credential_ref: string;
  output_trust: TrustLevel;
  transport: ToolTransport;
  /** v4.0 D-pipeline: handling som leser nå-tilstand for preflight + readback (før/etter-evidens). */
  preflight_action?: string;
  /**
   * Q-34 (funnet 2026-09-09, D-130; lukket i denne cross-domene-audit-sliceen):
   * FØR denne fantes var "fail-closed på et ukjent mål" for klasse D KUN en
   * tilfeldighet av at `preflight_action` fikk transporten til å KASTE for et
   * ukjent mål - en transport som i stedet svarer NORMALT med `data: null`
   * (en helt reell HTTP-/CLI-oppførsel) lot en klasse D-mutasjon mot et mål
   * som aldri fantes rapportere `ok: true`. Denne flagget gjør sjekken
   * STRUKTURELL i stedet for tilfeldig: satt til `true`, krever
   * `ToolGateway.execute()` at preflight-resultatet er eksplisitt IKKE
   * null/undefined FØR selve mutasjonen tillates (se `execute()` under).
   *
   * IKKE sett denne blindt for alle klasse D-verktøy med `preflight_action` -
   * revider FØRST at et null/undefined preflight-resultat for AKKURAT denne
   * handlingen alltid betyr "mål finnes ikke", aldri en gyldig tom tilstand.
   * `docker.redeploy_container` er det kjente moteksempelet: dens
   * `preflight_action` (`inspect_container`) svarer BEVISST `data: null` for
   * "container finnes ikke ennå" som en LEGITIM førstegangs-deploy-tilstand
   * (D-105) - denne flagget er derfor BEVISST IKKE satt der. Se
   * `q34-preflight-target-existence.test.ts` for revisjonen av samtlige
   * eksisterende brukere og en test som tvinger et eksplisitt valg for hver
   * FREMTIDIG klasse D + `preflight_action`-kombinasjon.
   */
  preflight_requires_target?: boolean;
  /**
   * Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82, EXACT_HEAD_SHA
   * 821545f): `preflight_requires_target` beviser KUN at preflight-svaret som
   * HELHET er ikke-null - for et verktøy med et EGET mål-ID-parameter inni en
   * ellers gyldig, ikke-null tilstand (`drive.update_permission`/
   * `delete_permission` sin `permission_id` inni en gyldig, men tom eller
   * ikke-treffende `{permissions: [...]}`-liste), er det IKKE tilstrekkelig -
   * en fil som EKSISTERER men der DEN SPESIFIKKE tillatelsen ikke gjør det,
   * passerte tidligere sjekken og lot en klasse D-mutasjon gå mot et
   * mål-ID som aldri fantes. Denne PREDIKAT-funksjonen kjøres FØR mutasjonen
   * (samme "ingenting å rulle tilbake"-egenskap) og skal returnere `true` KUN
   * når preflight-dataen faktisk viser at DET PÅSTÅTTE mål-ID-et eksisterer -
   * ALDRI bare at RESSURSEN overordnet gjør det. Samme opt-in-disiplin som
   * `preflight_requires_target`: revider FØR bruk, se
   * `q34-preflight-target-existence.test.ts`.
   */
  preflight_target_check?: (data: JsonValue, parameters: Record<string, JsonValue>) => boolean;
  /**
   * Q-34 P1-oppfølging (uavhengig arkitektkontroll av PR #82): en klasse
   * D-mutasjon hvis readback (etter-tilstand) er ULESELIG (kaster), MANGLER
   * (`data: null`) eller ikke MATCHER det som faktisk ble bedt om, skal ALDRI
   * rapporteres `ok: true` for et verktøy som EKSPLISITT lover
   * resultatverifisering - `ToolGateway.execute()` konverterte tidligere en
   * kastet readback stille til `after_state: null` og returnerte `ok: true`
   * uansett (se `home-assistant-critical-action.test.ts` sine daværende D/E-
   * tester, som nettopp KODIFISERTE dette som akseptert oppførsel). Denne
   * PREDIKAT-funksjonen tar den FAKTISKE etter-tilstanden (aldri `null` når
   * den kalles - `null`/uleselig kortslutter til avslag FØR predikatet nås)
   * og de opprinnelige mutasjonsparametrene, og skal returnere `true` KUN når
   * etter-tilstanden faktisk viser den TILTENKTE nye tilstanden (f.eks.
   * `home-assistant.lock_set` sin `after.locked === parameters.locked`).
   * `tool_executions`-raden og audit-bevismaterialet (before/after/recovery)
   * skrives UENDRET selv når verifiseringen feiler - mutasjonskallet LYKTES
   * strukturelt, og recovery-tooling må fortsatt se before_state - men den
   * RETURNERTE `ToolResult`en blir `ok: false` slik at kalleren ALDRI får
   * inntrykk av en bekreftet handling gatewayen ikke faktisk kunne bevise.
   * Opt-in (samme disiplin som over): uendret oppførsel for alt uten dette
   * feltet satt.
   */
  postcondition_predicate?: (afterState: JsonValue, parameters: Record<string, JsonValue>) => boolean;
  /**
   * D-105 host-fix (D-41-korreksjon): valgfri PARAMETER-nivå-autorisasjon,
   * kjørt av `ToolGateway.execute()` SELV for HVERT kall gjennom denne
   * SAMME, generiske gatewayen - uansett innslagsvei (dedikert REST-rute
   * ELLER en fremtidig samtale-drevet verktøykalls-vei). En transport-
   * spesifikk regel bygget INN I transporten kan omgås av et hvilket som
   * helst annet kall til `gateway.execute()`; denne hooken kan det ikke,
   * fordi den er del av selve gateway-pipelinen (etter policy.authorize()
   * ALLOW, FØR rate-limit/credential/preflight/invoke). I dag brukt KUN av
   * `docker.*`-mål-autorisasjon (se `docker-target-policy.ts`) - generisk
   * mekanisme i gatewayen, ingen docker-spesifikk kode her.
   */
  parameterAuthorizer?: (parameters: Record<string, JsonValue>, identity: IdentityContext) => { allowed: boolean; reason: string };
}

export type ToolResult =
  | { ok: true; external_id?: string; data?: JsonValue; output_trust: TrustLevel; deduplicated: boolean }
  | { ok: false; reason: string };

/**
 * Tool Gateway: eneste vei til eksterne systemer.
 * Pipeline: IdentityContext → (jobbmandat) → Policy Gateway → rate limit →
 * idempotensdedupe → adapter → audit (credential-ref + ekstern ID, aldri selve
 * secreten) → output klassifisert som untrusted der kilden er ekstern.
 */
export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  /** BO-03: connector-health per tool_id (healthy/degraded/auth_failed/rate_limited/unavailable). */
  readonly health = new Map<string, { state: string; at: string; detail?: string }>();
  private setHealth(toolId: string, state: string, detail?: string): void {
    this.health.set(toolId, { state, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  }
  private readonly callTimes = new Map<string, number[]>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: PolicyGateway,
    private readonly secrets: SecretProvider,
    private readonly controls?: OwnerControls,
    /**
     * Task #122 (D-213): SEPARAT fra `secrets` over med hensikt - `secrets`
     * er en LESE-fallback-kjede (Infisical → .env → BusinessInternal, D-211)
     * der EN provider som svarer er nok. Skriving har INGEN slik fallback-
     * semantikk: å skrive til `.env` fra kjørende kode ville enten vært en
     * fil-skriving inn i en git-ignorert fil (aldri gjort av
     * `EnvSecretProvider`, som er ren lesing) eller stille skrevet til feil
     * sted. `writableSecrets` er derfor typisk DEN SAMME `InfisicalSecretProvider`-
     * INSTANSEN som allerede sitter FØRST i `secrets`-kjeden (se main.ts/
     * worker-main.ts), gitt en gang til her, eksplisitt for skriving - ALDRI
     * en egen, parallell Infisical-tilkobling.
     */
    private readonly writableSecrets?: WritableSecretProvider
  ) {}

  /**
   * Task #119 (integrasjons-dashboard, D-211): presence-sjekk for eierens
   * "er X konfigurert"-visning - kaller SAMME `SecretProvider` gatewayen
   * allerede injiseres med (aldri en egen, parallell secret-lesevei), men
   * returnerer KUN en boolean. Selve verdien forlater ALDRI denne metoden -
   * samme "verdien går aldri i logg/trace/modellkontekst"-disiplin som
   * `SecretProvider.get()` sin egen kontrakt (se filhode over).
   */
  async hasSecret(ref: string): Promise<boolean> {
    return (await this.secrets.get(ref)) !== null;
  }

  /**
   * Task #122 (D-213): eierens "lim inn nøkkel"-skrivevei - ALDRI kallbar
   * uten en konfigurert `writableSecrets`-provider (fail-closed med en
   * TYDELIG feil, ALDRI en stille no-op eller et skriveforsøk mot en
   * les-only-kjede). Selve verdien går ALDRI i logg/trace/modellkontekst -
   * samme disiplin som `SecretProvider.get()`/`hasSecret()` sin kontrakt.
   * Kalles UTELUKKENDE gjennom `ToolGateway.execute()` sin vanlige
   * pipeline (Policy Gateway → audit) via `connector_credentials.set_credential`
   * (se `modules/owner-controls`) - ALDRI en direkte, policy-omgått vei.
   */
  async setSecret(ref: string, value: string): Promise<void> {
    if (!this.writableSecrets) {
      throw new Error("secret_provider_not_writable");
    }
    await this.writableSecrets.set(ref, value);
  }

  register(definition: ToolDefinition): void {
    this.tools.set(`${definition.tool_id}:${definition.action}`, definition);
  }

  get(toolId: string, action: string): ToolDefinition | undefined {
    return this.tools.get(`${toolId}:${action}`);
  }

  /**
   * D-289 (Tobias direkte i chat: "vil ha alt at han har full kontroll" -
   * svar på D-288 sitt funn om at samtaleflaten kun kunne kalle 5 av ~28
   * registrerte tool_id-er): eneste kilde `allMeshTools()` (`mesh-bridge.ts`)
   * trenger for å bygge EN mesh-mapping per FAKTISK registrert
   * `tool_id:action`-par - ALDRI en egen, potensielt avvikende opptelling.
   * Returnerer definisjonene selv (inkl. `transport`/`credential_ref`) -
   * disse forlater ALDRI denne prosessen mot modellen (kun `mesh-bridge.ts`
   * sin konverterte `name`/`description`/JSON-schema gjør det); kalleren har
   * samme tillitsnivå som `register()`/`execute()` selv.
   */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(request: {
    identity: IdentityContext;
    tool_id: string;
    action: string;
    parameters: Record<string, JsonValue>;
    idempotency_key?: string;
    approval?: unknown;
    /** Delegert jobb: verktøyet MÅ stå i kontraktens allowed_tools. */
    jobContract?: JobContract;
    /** D-317: se `ToolInvocationContext.servingModel` sitt filhode. */
    servingModel?: { provider: string; model: string };
  }): Promise<ToolResult> {
    const definition = this.get(request.tool_id, request.action);
    if (!definition) {
      return this.deny(request, "unknown_tool");
    }
    if (request.jobContract && !request.jobContract.allowed_tools.includes(request.tool_id)) {
      return this.deny(request, "tool_not_in_job_contract");
    }
    const input = definition.input_schema.safeParse(request.parameters);
    if (!input.success) {
      return this.deny(request, "invalid_parameters");
    }
    const decision = await this.policy.authorize({
      identity: request.identity,
      toolCall: {
        tool_id: request.tool_id,
        action: request.action,
        capability_class: definition.capability_class,
        parameters: request.parameters
      },
      ...(request.approval !== undefined ? { approval: request.approval } : {}),
      // JARVIS-051: noncen forbrukes FØRST rett før handlingen, etter alle ortogonale porter.
      deferNonceConsumption: true
    });
    if (decision.decision !== "ALLOW") {
      return this.deny(request, decision.reason);
    }
    if (definition.parameterAuthorizer) {
      const paramDecision = definition.parameterAuthorizer(request.parameters, request.identity);
      if (!paramDecision.allowed) {
        return this.deny(request, paramDecision.reason);
      }
    }
    if (!this.withinRateLimit(definition, request.identity.tenant_id)) {
      return this.deny(request, "rate_limited");
    }
    // K1 (Sovereign graduation, D-164): LIVE, delt sjekk (aldri den rene
    // synkrone `isFrozen()`/`isRevoked()`) - se `OwnerControls` sitt
    // filhode. `owner_controls` selv kan aldri fryse seg selv ute (samme
    // selvgjenopprettings-unntak som `PolicyGateway.authorize()` - se der).
    if (request.tool_id !== "owner_controls" && (await this.controls?.isFrozenDurable(request.tool_id))) {
      return this.deny(request, "connector_frozen");
    }
    // D-166 (arkitekt-review PR #93, funn B1): `owner_controls.*` deler
    // SAMME `credential_ref` (`BUSINESS_INTERNAL_CREDENTIAL_REF`) som
    // `situations`/`executive`. Uten et unntak ville et eier-kall til
    // `owner_controls.revoke_credential` med DEN delte interne refen (feil,
    // forveksling, eller kompromittert eier-identitet) blokkert `owner_
    // controls.restore_credential` selv med `credential_revoked` - et
    // ENVEIS-LÅS. Unntaket er BEGRENSET til `OWNER_CONTROLS_SELF_RECOVERY_
    // ACTIONS` (SAMME navngitte mengde som `PolicyGateway.authorize()` sin
    // kill-switch-sjekk over bruker - se `owner-control-store.ts` for full
    // begrunnelse, inkl. hvorfor `restore_credential` MÅ stå i begge
    // sjekkene for at en SAMTIDIG kill-switch+tilbakekalt-credential-
    // tilstand skal ha en deterministisk, kanonisk gjenopprettingsvei) -
    // IKKE et blanket-unntak for HELE `owner_controls`-verktøyet slik
    // frys-sjekken over har (den dekker en annen, smalere selv-mål-risiko).
    // `activate_kill_switch`/`freeze_connector`/`unfreeze_connector`/
    // `revoke_credential` er ALDRI unntatt herfra.
    //
    // D-174 (B2, unified owner-control-surface mutation completion):
    // `executive.*` proxyer NÅ de samme selvgjenopprettings-handlingene
    // videre til `owner_controls.*` via en NESTET `ToolGateway.execute()`-
    // kall (executive → owner_controls). Den nestede INDRE kallet er
    // allerede trygt (tool_id="owner_controls" der). Men den YTRE
    // executive.*-kallet vurderes MED SIN EGEN tool_id ("executive") FØR
    // det når det nestede kallet - uten dette tillegget ville den ytre
    // sjekken blokkert executive.deactivate_kill_switch/restore_credential
    // FØR de i det hele tatt kunne nå den trygge, nestede owner_controls-
    // stien, og dermed brutt B1-gjenoppretting via executive.
    // D-176 (RETTET, arkitekt-review 5251073737, BLOKKER B5): den
    // OPPRINNELIGE D-174-antakelsen her - at "executive-handlingsnavnene er
    // IDENTISKE med owner_controls sine" - var FEIL for LESING:
    // `executive.get_control_surface_status` het BEVISST IKKE
    // `get_control_state`, så den ble AVSLÅTT av akkurat denne
    // tilbakekalt-credential-sjekken (og den analoge kill-switch-sjekken i
    // `PolicyGateway.authorize()`) mens den delte refen var tilbakekalt -
    // et REELT brudd på B2 sitt "ETT panel for lesing OG gjenoppretting".
    // `isSelfRecoveryAction()` erstatter nå BEGGE de to tidligere
    // `tool_id === "..."`-unionene med en eksplisitt per-(tool_id,action)-
    // mapping (se owner-control-store.ts) - `executive.get_control_surface_
    // status` OG dens NØSTEDE `situations.get_pause_state`/`finance.
    // get_kill_switch`-kall er NÅ med (uten dette ville selve komposisjonen
    // FORTSATT feilet under lås, selv etter at den ytre executive-sjekken
    // alene var rettet - se D-176), `owner_controls.get_control_state`
    // direkte forblir uendret den kanoniske, alltid-tilgjengelige veien.
    // Unntaket er FORTSATT like smalt - kun disse navngitte handlingene per
    // tool_id, ALDRI en bredere "alle lesinger"-regel for noen av de fire.
    const isCredentialRevocationSelfRecovery = isSelfRecoveryAction(request.tool_id, request.action);
    if (!isCredentialRevocationSelfRecovery && (await this.controls?.isRevokedDurable(definition.credential_ref))) {
      return this.deny(request, "credential_revoked");
    }
    const credential = await this.secrets.get(definition.credential_ref);
    if (!credential) {
      return this.deny(request, "credential_unavailable");
    }

    // SECURITY FIX #2 (D-68): DEN OPPRINNELIGE kalleren sin identitet/godkjenning -
    // gitt uendret videre til transporten for ethvert nøstet gateway-kall den evt.
    // selv gjør. ALDRI fabrikkert/eskalert her - kun videreformidlet.
    const invocationContext: ToolInvocationContext = {
      identity: request.identity,
      ...(request.approval !== undefined ? { approval: request.approval } : {}),
      ...(request.servingModel !== undefined ? { servingModel: request.servingModel } : {})
    };

    // v4.0 D-pipeline: for høyrisiko (C/D) med definert preflight leses
    // nå-tilstanden FØR handlingen (deterministisk preflight + recovery-
    // grunnlag) og PÅ NYTT etterpå (readback/before-after-evidens).
    // Preflight-feil på klasse D er fail-closed.
    let beforeState: JsonValue | null = null;
    const needsEvidence = (definition.capability_class === "C" || definition.capability_class === "D") && definition.preflight_action;
    if (needsEvidence) {
      try {
        const pre = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential, invocationContext);
        beforeState = pre.data ?? null;
        // Q-34: preflight-KALLET lyktes (kastet ikke), men for et revidert
        // klasse D-verktøy betyr et null/undefined resultat FAKTISK "mål
        // finnes ikke" - se `preflight_requires_target` sin doc-kommentar.
        // Denne mutasjonen har ikke skjedd ennå og transaksjonen er ikke
        // startet, så avslaget her har PRESIS samme "ingenting å rulle
        // tilbake"-egenskap som en kastet preflight-feil under.
        if (definition.capability_class === "D" && definition.preflight_requires_target && beforeState === null) {
          return this.deny(request, "preflight_target_not_found");
        }
        // Q-34 P1-oppfølging: den FINERE sjekken - ressursen finnes (over),
        // men det PÅSTÅTTE mål-ID-et inni den må også faktisk finnes.
        if (
          definition.capability_class === "D" &&
          beforeState !== null &&
          definition.preflight_target_check &&
          !definition.preflight_target_check(beforeState, request.parameters)
        ) {
          return this.deny(request, "preflight_target_not_found");
        }
      } catch (err) {
        if (definition.capability_class === "D") {
          return this.deny(request, `preflight_failed:${(err as Error).message.slice(0, 60)}`);
        }
      }
    }

    // JARVIS-051: alle ortogonale porter (parameter, rate limit, frys, credential,
    // preflight) har passert - FØRST NÅ brennes godkjenningens engangs-nonce.
    if (decision.commit) {
      const committed = await decision.commit();
      if (!committed.ok) {
        return this.deny(request, committed.reason);
      }
    }

    // Q-18 (D-30 host-akseptanse): tool_executions-dedupe finnes for å hindre
    // dobbel SIDE-EFFEKT på C/D-mutasjoner (§21/§19 i BO-11) - A-klasse READs
    // har ingen side-effekt å beskytte mot duplisering, og data kan ha endret
    // seg mellom to spørringer (f.eks. to "hva står på kalenderen"-spørsmål i
    // samme langtlevende voice-session). Dedupe på database-/session-nivå
    // gjelder derfor KUN C/D. Beskyttelse mot at MODELLEN utfører samme
    // semantiske kall flere ganger i ÉN modellrunde/samtaletur er uendret og
    // håndheves separat (in-memory `executed`-cache i
    // ModelGateway.completeWithTools, modules/model-gateway/src/model-gateway.ts).
    const dedupeApplies = definition.capability_class !== "A";
    return withTenantTransaction(this.pool, request.identity.tenant_id, async (client) => {
      if (dedupeApplies && request.idempotency_key) {
        const prior = await client.query(
          "SELECT external_id, status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1",
          [request.idempotency_key]
        );
        const row = prior.rows[0] as
          | { external_id: string | null; status: string; postcondition_reason: string | null }
          | undefined;
        if (row?.status === "succeeded") {
          await writeAudit(client, request.identity, {
            type: "tool.deduplicated", tool_id: request.tool_id, action: request.action,
            payload: { external_id: row.external_id }
          });
          return {
            ok: true,
            ...(row.external_id !== null ? { external_id: row.external_id } : {}),
            output_trust: definition.output_trust,
            deduplicated: true
          } as const;
        }
        // Q-34 P2-oppfølging (uavhengig arkitektkontroll av PR #82,
        // EXACT_HEAD_SHA 91b0168): den FØRSTE gjennomkjøringen kunne ikke
        // bekrefte resultatet (`status='unverified'`, migrasjon 054) - en
        // retry med SAMME idempotency_key skal ALDRI utløse en ny mutasjon
        // (den forrige kan strukturelt allerede ha skjedd), men skal OGSÅ
        // ALDRI tilfeldig bli en ok:true. Den MÅ se det NØYAKTIG samme sanne,
        // ikke-suksessfulle resultatet som den opprinnelige kalleren fikk.
        if (row?.status === "unverified") {
          await writeAudit(client, request.identity, {
            type: "tool.postcondition_unverified", decision: "ALLOW",
            tool_id: request.tool_id, action: request.action, capability_class: definition.capability_class,
            payload: { external_id: row.external_id, replayed: true, reason: row.postcondition_reason }
          });
          return { ok: false, reason: row.postcondition_reason ?? "postcondition_unverified:replayed" } as const;
        }
      }
      let external: { external_id?: string; data?: JsonValue };
      try {
        external = await withTimeout(
          definition.transport.invoke(request.action, request.parameters, credential, invocationContext),
          definition.timeout_ms
        );
      } catch (err) {
        const message = (err as Error).message;
        this.setHealth(request.tool_id,
          /401|403|auth/.test(message) ? "auth_failed" : /429|rate/.test(message) ? "rate_limited" : "unavailable",
          message.slice(0, 60));
        // Kontrollert feil: revoked credential/timeout/providerfeil åpner ingenting.
        await writeAudit(client, request.identity, {
          type: "tool.failed", decision: "DENY", reason: (err as Error).message.slice(0, 120),
          tool_id: request.tool_id, action: request.action,
          capability_class: definition.capability_class,
          payload: { credential_ref: definition.credential_ref }
        });
        return { ok: false, reason: `tool_failed:${(err as Error).message.slice(0, 80)}` } as const;
      }
      let afterState: JsonValue | null = null;
      let readbackFailed = false;
      if (needsEvidence) {
        try {
          const post = await definition.transport.invoke(definition.preflight_action!, request.parameters, credential, invocationContext);
          afterState = post.data ?? null;
        } catch {
          afterState = null; // readback-feil skjuler aldri at handlingen skjedde - audit under
          readbackFailed = true;
        }
      }
      // Q-34 P1-oppfølging: for et verktøy som EKSPLISITT lover
      // resultatverifisering (`postcondition_predicate`), avgjør om
      // etter-tilstanden faktisk BEKREFTER den tiltenkte nye tilstanden.
      // `postconditionReason` er `null` NÅR OG BARE NÅR verifisert - både
      // returverdien OG (Q-34 P2) den lagrede raden bruker NØYAKTIG samme
      // strengverdi, slik at en senere replay kan gi et IDENTISK, ikke bare
      // et generisk, avslag. Uendret `null` (verifisert) for ALT uten
      // `postcondition_predicate` satt - samme opt-in-disiplin som resten av
      // Q-34-lukkingen.
      let postconditionReason: string | null = null;
      if (definition.capability_class === "D" && definition.postcondition_predicate) {
        if (readbackFailed) {
          postconditionReason = "postcondition_unverified:readback_failed";
        } else if (afterState === null) {
          postconditionReason = "postcondition_unverified:target_missing";
        } else {
          // Q-34 P2-oppfølging: `postcondition_predicate` er UTVIDELSESKODE
          // (definert av HVERT enkelt verktøy, ikke av gatewayen selv) og
          // kjøres INNI transaksjonen - en kastet feil her (f.eks. et
          // uventet/malformert providersvar) skal IKKE la unntaket boble opp
          // og abortere transaksjonen (som ville tapt audit/tool_executions-
          // bevismaterialet for en mutasjon som FAKTISK skjedde), men
          // behandles som "ikke verifisert", identisk med en uleselig readback.
          let predicateHeld: boolean;
          try {
            predicateHeld = definition.postcondition_predicate(afterState, request.parameters);
          } catch {
            predicateHeld = false;
            postconditionReason = "postcondition_unverified:predicate_error";
          }
          if (postconditionReason === null && !predicateHeld) {
            postconditionReason = "postcondition_mismatch";
          }
        }
      }
      const postconditionVerified = postconditionReason === null;
      if (dedupeApplies && request.idempotency_key) {
        await client.query(
          `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, external_id, status, before_state, after_state, postcondition_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [request.identity.tenant_id, request.idempotency_key, request.tool_id, request.action,
           external.external_id ?? null, postconditionVerified ? "succeeded" : "unverified",
           JSON.stringify(beforeState), JSON.stringify(afterState), postconditionReason]
        );
      }
      await writeAudit(client, request.identity, {
        // Q-34 P1-oppfølging: en EGEN audit-type når verifiseringen feiler -
        // ALDRI "tool.executed" (som en fremtidig leser rimelig ville tolket
        // som "bekreftet vellykket"). before_state/after_state/recovery er
        // UENDRET tilstede i payloaden begge veier - mutasjonskallet lyktes
        // strukturelt, og recovery-tooling må fortsatt se before_state.
        type: postconditionVerified ? "tool.executed" : "tool.postcondition_unverified", decision: "ALLOW",
        tool_id: request.tool_id, action: request.action,
        capability_class: definition.capability_class,
        payload: {
          credential_ref: definition.credential_ref, // referanse - aldri verdien
          external_id: external.external_id ?? null,
          scopes: definition.scopes,
          rollback: definition.rollback_procedure,
          ...(needsEvidence ? { before_state: beforeState, after_state: afterState, recovery: { snapshot: beforeState, procedure: definition.rollback_procedure } } : {})
        }
      });
      if (!postconditionVerified) {
        // Uleselig/manglende/feil etter-tilstand er en driftsavvikelse, ikke
        // en autentiserings-/rate-feil - men FORTSATT ikke "healthy": en
        // fremtidig kaller skal se degraderingen, ikke en falsk grønn status.
        this.setHealth(request.tool_id, "degraded", "postcondition_unverified");
        return { ok: false, reason: postconditionReason! } as const;
      }
      this.setHealth(request.tool_id, "healthy");
      return {
        ok: true,
        ...(external.external_id !== undefined ? { external_id: external.external_id } : {}),
        ...(external.data !== undefined ? { data: external.data } : {}),
        output_trust: definition.output_trust,
        deduplicated: false
      } as const;
    });
  }

  /**
   * D-219: hvis selve audit-skrivingen her feiler (DB-blipp/RLS-/kontekst-
   * problem), skal ALDRI-avslaget likevel returneres til kalleren som normalt
   * (fail-safe - en policy-avslag skal aldri henge fast på en audit-skrivefeil)
   * - MEN et slikt tilfelle er da et avslag som forsvinner sporløst fra
   * revisjonssporet den samme regelen (CLAUDE.md §6, "Policy Gateway aldri
   * hoppes over") faktisk skal bevises av. Samme "isolasjon beholdes, feilen
   * gjøres OBSERVERBAR"-mønster som PR #79 sin fiks for
   * `location`/`health`-retensjonssveipene (`sweep.ts` i begge pakker).
   */
  private async deny(
    request: { identity: IdentityContext; tool_id: string; action: string },
    reason: string
  ): Promise<ToolResult> {
    await withTenantTransaction(this.pool, request.identity.tenant_id, (client) =>
      writeAudit(client, request.identity, {
        type: "tool.denied", decision: "DENY", reason,
        tool_id: request.tool_id, action: request.action
      })
    ).catch((err) => {
      console.error(JSON.stringify({
        msg: "tool_denied_audit_write_failed",
        tool_id: request.tool_id,
        action: request.action,
        reason,
        error: err instanceof Error ? err.message : String(err)
      }));
    });
    return { ok: false, reason };
  }

  private withinRateLimit(definition: ToolDefinition, tenantId: string): boolean {
    const key = `${definition.tool_id}:${definition.action}:${tenantId}`;
    const now = Date.now();
    const times = (this.callTimes.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= definition.rate_limit_per_minute) {
      return false;
    }
    times.push(now);
    this.callTimes.set(key, times);
    return true;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tool_timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
