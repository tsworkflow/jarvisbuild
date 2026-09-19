import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { KillSwitch } from "@jarvis/policy";

export type Severity = "info" | "warning" | "critical";

export interface Alert {
  check: string;
  severity: Severity;
  message: string;
  runbook: string;
  at: string;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}

/**
 * W1 (D-180): den MINIMALE strukturelle formen av den ALLEREDE EKSISTERENDE
 * `TelegramTransport` (`modules/tool-gateway/src/live-transports.ts`) -
 * `TelegramAlertSink` under tar en INJISERT instans av den, den konstruerer
 * ALDRI en egen HTTP-klient mot api.telegram.org. Grunnen til at typen er
 * strukturell (og ikke et direkte `import type { ToolTransport }`) er den
 * SAMME som `marketingMemoryBriefSource(growthService)` sin injeksjon i
 * app-laget (worker-main.ts): `@jarvis/watchdog` skal IKKE få en
 * pakkeavhengighet til `@jarvis/tool-gateway` kun for varslings-transporten -
 * app-laget eier komposisjonen, modulen eier kontrakten.
 */
export interface AlertNotifyTransport {
  invoke(
    action: string,
    parameters: Record<string, string>,
    credential: string
  ): Promise<{ external_id: string }>;
}

/** Samme strukturelle form som `SecretProvider` (@jarvis/tool-gateway) - se `AlertNotifyTransport` for hvorfor den ikke importeres direkte. */
export interface AlertSecretProvider {
  get(ref: string): Promise<string | null>;
}

/** Den KANONISKE credential-referansen `firstWaveTools()` sin `telegram.notify` allerede bruker - INGEN ny hemmelighet-mekanisme innføres av W1. */
export const TELEGRAM_ALERT_CREDENTIAL_REF = "JARVIS_TELEGRAM_TOKEN";

export class AlertDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertDeliveryError";
  }
}

/**
 * W1 (D-180, ordrepunkt C): ERSTATTER det tidligere skallet som UBETINGET
 * kastet `telegram_alert_unverified` - en blindvei som gjorde at watchdogen
 * i praksis ALDRI kunne varsle Tobias, uansett konfigurasjon.
 *
 * GJENBRUKER den EKTE, allerede eksisterende `TelegramTransport` (injisert,
 * se `AlertNotifyTransport`) og den EKTE, allerede eksisterende
 * `EnvSecretProvider`/`JARVIS_TELEGRAM_TOKEN`-kjeden - INGEN ny
 * Telegram-API-klient, INGEN ny credential-mekanisme, INGEN rå token i
 * modellkontekst, logg, feilmelding eller audit (tokenet hentes rett før
 * kallet, gis KUN til transporten, og navngis aldri annet enn ved sin REF).
 *
 * BEVISST IKKE gjennom `ToolGateway`/`PolicyGateway` (avvik fra den vanlige
 * verktøystien, logget som D-180 §C): watchdogens ENESTE kritiske varsel er
 * nettopp det som sendes I DET SAMME ØYEBLIKKET den globale kill switchen
 * aktiveres. `PolicyGateway.authorize()` nekter da ALT som ikke står i
 * `isSelfRecoveryAction()`-mengden (D-166/D-176) - en `telegram.notify`
 * gjennom gaten ville derfor blitt `kill_switch_active`-avslått AKKURAT når
 * den betyr mest: en selvtaushetsleggende alarm. Å legge `telegram.notify`
 * inn i selvgjenopprettings-unntaket ble forkastet fordi DET er en generell
 * utgående handling (enhver kaller kunne da varsle under nedstengning),
 * altså et bredere hull enn problemet. Watchdogen er per sin egen kontrakt
 * (se `Watchdog` under) UTEN verktøytilgang: ingen modell velger innhold
 * eller mottaker, formatet er fast, og mottakeren er den ENE konfigurerte
 * `JARVIS_TELEGRAM_CHAT_ID`. Dette er en sirene, ikke et verktøykall.
 */
export class TelegramAlertSink implements AlertSink {
  constructor(
    private readonly transport: AlertNotifyTransport,
    private readonly secrets: AlertSecretProvider,
    private readonly credentialRef: string = TELEGRAM_ALERT_CREDENTIAL_REF
  ) {}

  async send(alert: Alert): Promise<void> {
    const credential = await this.secrets.get(this.credentialRef);
    if (!credential) {
      // Navngir KUN referansen, ALDRI en verdi - og feiler ÅPENT (kastet,
      // observerbart via `WatchdogObserver.onAlertFailed`) i stedet for å
      // returnere stille "OK" for et varsel som aldri ble sendt.
      throw new AlertDeliveryError(`telegram_alert_credential_missing:${this.credentialRef}`);
    }
    await this.transport.invoke(
      "notify",
      { message: formatAlertMessage(alert) },
      credential
    );
  }
}

/** Fast, deterministisk varselformat - ingen modell, ingen fri tekst utenfra, ingen credential-verdi. */
export function formatAlertMessage(alert: Alert): string {
  return `[jarvis-watchdog] ${alert.severity.toUpperCase()} ${alert.check}: ${alert.message} (runbook: ${alert.runbook}, at: ${alert.at})`;
}

/**
 * W1 (D-180, ordrepunkt D): feilisolasjon MÅ være OBSERVERBAR. Den tidligere
 * `.catch(() => undefined)`-en i `tick()` svelget BÅDE varslings- og
 * tiltaksfeil sporløst. Observatøren er det ENE stedet slike feil rapporteres;
 * `consoleWatchdogObserver()` under er produksjonsvalget (samme
 * `console.error(JSON.stringify({...}))`-form som resten av worker-main.ts).
 */
export interface WatchdogObserver {
  /** En registrert sjekk kastet - watchdogen fortsetter med de øvrige sjekkene. */
  onCheckFailed?(check: string, error: Error): void;
  /** Varselet nådde ALDRI fram. Kill switch-/tilstandsmutasjonen er ALLEREDE utført på dette tidspunktet og påvirkes IKKE. */
  onAlertFailed?(alert: Alert, error: Error): void;
  /** Et registrert, reversibelt tiltak kastet. */
  onActionFailed?(check: string, error: Error): void;
  /** En ny syklus ble forsøkt mens forrige fortsatt kjørte - hoppet over, aldri kjørt overlappende. */
  onCycleSkipped?(reason: "overlapping_run"): void;
}

export function consoleWatchdogObserver(): WatchdogObserver {
  return {
    onCheckFailed: (check, error) =>
      console.error(JSON.stringify({ msg: "watchdog_check_failed", check, error: error.message })),
    onAlertFailed: (alert, error) =>
      console.error(
        JSON.stringify({
          msg: "watchdog_alert_delivery_failed", check: alert.check, severity: alert.severity,
          // Varselteksten selv tas MED (den er fast-format og inneholder ingen
          // hemmelighet), slik at et varsel som aldri nådde Telegram fortsatt
          // finnes i prosessloggen - ellers ville en Telegram-nedetid gjort en
          // kritisk hendelse HELT usynlig.
          alert_message: formatAlertMessage(alert), error: error.message
        })
      ),
    onActionFailed: (check, error) =>
      console.error(JSON.stringify({ msg: "watchdog_action_failed", check, error: error.message })),
    onCycleSkipped: (reason) => console.warn(JSON.stringify({ msg: "watchdog_cycle_skipped", reason }))
  };
}

export interface HealthCheck {
  name: string;
  runbook: string;
  run(): Promise<{ ok: boolean; severity: Severity; message: string }>;
}

/**
 * Deterministisk watchdog (masterplan §11.2 / CANONICAL §11): oppdager feil,
 * varsler med alvorlighetsgrad + runbook, og utfører KUN eksplisitt
 * registrerte, reversible tiltak med maks antall forsøk. Ingen LLM, ingen
 * autonom reparasjon, ingen vei utenom Policy Gateway (watchdog har ingen
 * verktøytilgang - kun varsling, registrerte restart-hooks og kill switch).
 */
export class Watchdog {
  private readonly checks: HealthCheck[] = [];
  private readonly actions = new Map<string, { run: () => Promise<void>; maxAttempts: number; attempts: number }>();
  /** W1 (D-180, ordrepunkt D): ingen overlappende sykluser - se `tick()`. */
  private running = false;

  constructor(
    private readonly alerts: AlertSink,
    private readonly killSwitch: KillSwitch,
    private readonly observer: WatchdogObserver = {}
  ) {}

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Reversibelt tiltak (f.eks. restart av ÉN tjeneste), aldri destruktivt. */
  registerAction(checkName: string, run: () => Promise<void>, maxAttempts = 2): void {
    this.actions.set(checkName, { run, maxAttempts, attempts: 0 });
  }

  /** Kun for observability/tester - `tick()` sin egen gjensidige utelukkelse er ALLTID autoritativ. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * W1 (D-180): overlappingsvernet ligger HER, i den ENE inngangen, ikke i
   * kalleren. Et vern som kan omgås ved å kalle en annen metode er ikke et
   * vern - og et intervall (worker-main.ts) kan ellers stable opp sykluser
   * hvis en sjekk henger lenger enn intervallet.
   *
   * REKKEFØLGE (sikkerhetskritisk, se ordrepunkt C/D): `check.run()` kjører
   * FØRST og er det ENESTE som muterer tilstand (f.eks.
   * `costExplosionCheck` sin `activateDurable()`). Varslingen skjer ETTERPÅ
   * og kan ALDRI forhindre, reversere eller forsinke den mutasjonen: en
   * kastende `AlertSink` fanges her og rapporteres til observatøren, mens
   * den durable nødstoppen står uendret.
   */
  async tick(): Promise<Alert[]> {
    if (this.running) {
      this.observer.onCycleSkipped?.("overlapping_run");
      return [];
    }
    this.running = true;
    try {
      const fired: Alert[] = [];
      for (const check of this.checks) {
        let result: { ok: boolean; severity: Severity; message: string };
        try {
          result = await check.run();
        } catch (err) {
          this.observer.onCheckFailed?.(check.name, err as Error);
          result = { ok: false, severity: "critical", message: `sjekk feilet: ${(err as Error).message}` };
        }
        if (result.ok) {
          continue;
        }
        const alert: Alert = {
          check: check.name, severity: result.severity, message: result.message,
          runbook: check.runbook, at: new Date().toISOString()
        };
        fired.push(alert);
        try {
          await this.alerts.send(alert);
        } catch (err) {
          this.observer.onAlertFailed?.(alert, err as Error);
        }
        const action = this.actions.get(check.name);
        if (action && action.attempts < action.maxAttempts) {
          action.attempts += 1;
          try {
            await action.run();
          } catch (err) {
            this.observer.onActionFailed?.(check.name, err as Error);
          }
        }
      }
      return fired;
    } finally {
      this.running = false;
    }
  }
}

/** Nedre/øvre grense for watchdog-intervallet - se `resolveWatchdogIntervalMs()`. */
export const WATCHDOG_MIN_INTERVAL_MS = 5_000;
export const WATCHDOG_MAX_INTERVAL_MS = 3_600_000;
export const WATCHDOG_DEFAULT_INTERVAL_MS = 60_000;

/**
 * W1 (D-180, ordrepunkt A - "bounded, configurable interval"): en
 * feilkonfigurert `JARVIS_WATCHDOG_INTERVAL_MS` (tom, "abc", 0, negativ,
 * eller absurd stor) skal ALDRI kunne gi en watchdog som enten hamrer
 * databasen eller i praksis er avslått. Ugyldig verdi ⇒ dokumentert default,
 * gyldig-men-utenfor-området ⇒ klemt til grensen. Ren funksjon, derfor
 * direkte testbar uten å starte noe intervall.
 */
export function resolveWatchdogIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) return WATCHDOG_DEFAULT_INTERVAL_MS;
  return Math.min(WATCHDOG_MAX_INTERVAL_MS, Math.max(WATCHDOG_MIN_INTERVAL_MS, Math.floor(parsed)));
}

/**
 * W1 (D-180, ordrepunkt A/D): den ENE, delte intervall-løkka watchdogen
 * kjøres av i produksjon. GJENBRUKER det EKSISTERENDE `setInterval`-mønsteret
 * worker-main.ts allerede bruker for `worker.drain()` - INGEN nytt
 * scheduler-rammeverk, ingen ny køtype, ingen ny prosess.
 *
 * `tick()` eier selv overlappingsvernet (se der), og fanger selv sjekk-/
 * varslings-/tiltaksfeil. `.catch()` her er derfor det YTTERSTE nettet:
 * en uventet feil i selve løkka skal logges, ALDRI bli en `unhandledRejection`
 * som feller worker-prosessen (ordrepunkt D: "Watchdog checks must not crash
 * the worker process").
 *
 * `unref()` BEVISST IKKE satt: worker-prosessen holdes uansett i live av
 * drain-intervallet, og en watchdog som ikke holder prosessen i live ville
 * vært et stille avvik fra drain-intervallets egen semantikk.
 */
export function startWatchdog(
  watchdog: Watchdog,
  intervalMs: number,
  observer: WatchdogObserver = {}
): { stop: () => void; intervalMs: number } {
  const timer = setInterval(() => {
    void watchdog.tick().catch((err: unknown) => {
      observer.onCheckFailed?.("watchdog_cycle", err as Error);
    });
  }, intervalMs);
  return { stop: () => clearInterval(timer), intervalMs };
}

/**
 * W1 (D-180): tenant-omfanget hardgrensen/fastlås-sjekken summeres over.
 * Default er den SAMME ene eier-tenanten resten av worker-main.ts allerede
 * bruker (`JARVIS_TENANT_ID`) - `JARVIS_WATCHDOG_TENANT_IDS` (komma-separert)
 * finnes fordi en GLOBAL kostnads-hardgrense som kun teller ÉN tenant er en
 * ekte, dokumentert begrensning så snart Jarvis har flere tenanter, ikke noe
 * som skal oppdages som en stille underrapportering. Ingen ny credential,
 * ingen ny leverandør - kun konfigurasjon.
 */
export function resolveWatchdogTenantIds(rawList: string | undefined, fallbackTenantId: string): string[] {
  const parsed = (rawList ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : [fallbackTenantId];
}

/**
 * Fastlåste jobber: running med utløpt lease = fastlåst worker (reclaim finnes, men varsle).
 *
 * W1 (D-180): `tenantIds` er NYTT og OBLIGATORISK - NØYAKTIG samme
 * RLS-defekt som `costExplosionCheck` hadde (se dens §2). `tasks` er
 * `FORCE ROW LEVEL SECURITY`-beskyttet (migrasjon 005); en rå
 * `pool.query(...)` uten tenant-kontekst teller ALLTID 0 under den ekte
 * runtime-rollen, altså en sjekk som strukturelt aldri kan varsle. Å wire en
 * slik sjekk inn i produksjon ville vært verre enn å la den være ukoblet:
 * den ville sett ut som dekning uten å være det.
 */
export function stuckTasksCheck(pool: pg.Pool, tenantIds: readonly string[]): HealthCheck {
  if (tenantIds.length === 0) {
    throw new Error("stuck_tasks_no_tenants: minst én tenant må oppgis - en tom liste ville gitt en sjekk som aldri kan varsle");
  }
  return {
    name: "stuck_tasks",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker",
    async run() {
      let n = 0;
      for (const tenantId of tenantIds) {
        const result = await withTenantTransaction(pool, tenantId, (client) =>
          client.query(`SELECT count(*)::int AS n FROM tasks WHERE status = 'running' AND lease_expires_at < now()`)
        );
        n += (result.rows[0] as { n: number }).n;
      }
      return n === 0
        ? { ok: true, severity: "info", message: "" }
        : { ok: false, severity: "warning", message: `${n} jobber med utløpt lease` };
    }
  };
}

export function databaseCheck(pool: pg.Pool): HealthCheck {
  return {
    name: "database",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#postgres",
    async run() {
      await pool.query("SELECT 1");
      return { ok: true, severity: "info", message: "" };
    }
  };
}

/**
 * W1 (D-180): `costExplosionCheck` sin konfigurasjon er NÅ EKSPLISITT og
 * OBLIGATORISK - ingen posisjonell `hardLimitOre = 300_000`-default, ingen
 * implisitt tenant, og FRAMFOR ALT ingen `actorPersonId`-default.
 *
 * `actorPersonId` MÅ oppgis fordi `KillSwitch.activateDurable()` sin
 * `assertOwnerControlAuthorized()` (D-164) er fail-CLOSED: den krever at
 * aktøren er IDENTISK med `OwnerControlAuthority.owner_person_id` når et
 * `pool` finnes. En `undefined`/fallback-aktør ville derfor ikke gitt en
 * "systemhandling" - den ville gitt en `OwnerControlUnauthorizedError` og en
 * nødstopp som ALDRI ble skrevet.
 *
 * ÆRLIG KONSEKVENS, dokumentert framfor skjult: aktøren som havner i
 * `owner_control_state.actor_person_id` er derfor eierens person-id, ikke en
 * egen "watchdog"-identitet. Watchdogens proveniens bæres av `reason`-teksten
 * (`WATCHDOG_COST_EXPLOSION_REASON_PREFIX` under), som ALLTID er prefikset og
 * maskinlesbar. Å innføre en separat system-aktør ville krevd et NYTT unntak
 * i eier-autoritetsmodellen (D-164) - altså en ny vei rundt akkurat den
 * kontrollen K1 bygde - og ble derfor forkastet. Se D-180 §B.
 */
export interface CostExplosionCheckOptions {
  /** Hardgrense i øre for inneværende kalendermåned, summert over `tenantIds`. */
  hardLimitOre: number;
  /**
   * Tenantene hardgrensen summeres over. EKSPLISITT fordi `cost_events` har
   * `FORCE ROW LEVEL SECURITY` (migrasjon 005) - se `run()` under.
   */
  tenantIds: readonly string[];
  /** Eier-aktøren nødstoppen attribueres til. Se typedoc over for hvorfor den ikke kan være valgfri. */
  actorPersonId: string;
}

/** Maskinlesbar proveniens i `owner_control_state.reason` - beviser at DENNE nødstoppen kom fra watchdogen, ikke fra en manuell eier-handling. */
export const WATCHDOG_COST_EXPLOSION_REASON_PREFIX = "watchdog:cost_explosion";

/**
 * Kostnadseksplosjon (D-09-kriterium): over hardgrensen utløses kill switch -
 * deterministisk, reversibel (deaktiveres manuelt via den KANONISKE
 * eier-/executive-gjenopprettingsstien), og policyen nekter alt til Tobias
 * har vurdert situasjonen.
 *
 * W1 (D-180, ordrepunkt B) RETTET TO PRODUKSJONSDEFEKTER som begge var
 * maskert av at den eneste eksisterende testen brukte en pool-løs
 * `KillSwitch` OG en superuser-`adminPool`:
 *
 * 1. DURABILITET: den kalte `killSwitch.activate()` (ren, PROSESS-LOKAL
 *    in-memory-tilstand). Produksjonens `PolicyGateway.authorize()` sjekker
 *    `isActiveDurable()` mot `owner_control_state` (K1/D-164). En
 *    kostnadseksplosjon ville derfor satt et flagg INGEN håndhevende kode
 *    leser, forsvunnet ved omstart, og vært usynlig for api-prosessen.
 *    RETTET: `await killSwitch.activateDurable(reason, actorPersonId)`, og
 *    "allerede aktiv"-sjekken bruker `await killSwitch.isActiveDurable()`
 *    (ikke den synkrone `isActive()`, som ser samme prosess-lokale cache).
 *
 * 2. RLS: `cost_events` er `FORCE ROW LEVEL SECURITY`-beskyttet med
 *    `tenant_id = current_setting('jarvis.tenant_id', true)` (migrasjon 005).
 *    Den gamle, rå `pool.query(...)`-summeringen UTEN tenant-kontekst ser
 *    derfor NULL rader under den ekte runtime-rollen (`jarvis_runtime`,
 *    NOSUPERUSER/NOBYPASSRLS, Q-21) - summen ville ALLTID vært 0 og grensen
 *    ALDRI utløst i produksjon. Den eksisterende testen skjulte dette
 *    fullstendig ved å sende inn `adminPool` (superuser ⇒ RLS omgått).
 *    RETTET: summeres PER tenant inni den kanoniske
 *    `withTenantTransaction()` (@jarvis/core, samme hjelper
 *    produksjonskoden bruker for alle andre RLS-tabeller, jf. D-178).
 *
 * DUPLIKATVERN (ordrepunkt D): `writeControlState()` er en UPSERT som ville
 * overskrevet `reason` og nullstilt `changed_at` ved hver syklus mens
 * tilstanden var over grensen - altså slettet bevisene for NÅR og HVORFOR
 * nødstoppen først slo inn. `isActiveDurable()`-sjekken FØR aktivering gjør
 * gjentatte sykluser til et rent no-op.
 */
export function costExplosionCheck(
  pool: pg.Pool,
  killSwitch: KillSwitch,
  options: CostExplosionCheckOptions
): HealthCheck {
  const { hardLimitOre, tenantIds, actorPersonId } = options;
  if (tenantIds.length === 0) {
    throw new Error("cost_explosion_no_tenants: minst én tenant må oppgis - en tom liste ville gitt en hardgrense som aldri kan utløses");
  }
  if (!actorPersonId) {
    throw new Error("cost_explosion_no_actor: actorPersonId er påkrevd - activateDurable() er fail-closed uten en eier-aktør");
  }
  return {
    name: "cost_explosion",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad",
    async run() {
      let spent = 0;
      for (const tenantId of tenantIds) {
        const result = await withTenantTransaction(pool, tenantId, (client) =>
          client.query(
            `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
          )
        );
        spent += (result.rows[0] as { spent: number }).spent;
      }
      if (spent < hardLimitOre) {
        return { ok: true, severity: "info", message: "" };
      }
      if (await killSwitch.isActiveDurable()) {
        return { ok: false, severity: "critical", message: "over hardgrense (kill switch allerede aktiv)" };
      }
      await killSwitch.activateDurable(
        `${WATCHDOG_COST_EXPLOSION_REASON_PREFIX}: ${spent} øre >= ${hardLimitOre} øre (tenants: ${tenantIds.join(",")})`,
        actorPersonId
      );
      return { ok: false, severity: "critical", message: `kill switch aktivert (${(spent / 100).toFixed(0)} kr)` };
    }
  };
}
