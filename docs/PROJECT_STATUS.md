# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/fase-w1-watchdog-runtime-durability`, exact base
`main=9ede3ac1d2e32e708d38104e7a6869772774d628` = PR #95 sin merge-commit).

**Aktiv oppgave: W1 - WATCHDOG PRODUKSJONS-WIRING + DURABEL NØDSTOPP + REELL VARSLING (D-180),**
arkitekt-ordre `D183-W1-WATCHDOG-RUNTIME-DURABILITY-20260919-A`, som lukker `REAL_INTERNAL_GAP`-et
D182 fant. Prioritert FORAN D181 Value Track på sikkerhetsgrunnlag.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Status-flagg (ÆRLIG, FØR host-kjøring)

```
WATCHDOG_IMPLEMENTED=true
WATCHDOG_PRODUCTION_WIRED=true
WATCHDOG_DURABLE_SHUTDOWN_FIXED=true
WATCHDOG_HOST_ACCEPTANCE_REQUIRED=true
HOST_ACCEPTANCE_STATUS=NOT_RUN
INTERNAL_BUILD_COMPLETE=false
INTERNAL_BUILD_BLOCKERS=W1_HOST_ACCEPTANCE_PENDING
SOVEREIGN_COMPLETE=false
SELF_APPROVAL=false
MERGE_AUTHORIZED=false
```

`INTERNAL_BUILD_COMPLETE` er RETTET fra D-179 sin `true`: W1 er en NYOPPDAGET intern mangel, og
produksjonsverifikasjon påstås ikke før den ekte host-kjøringen passerer.

## Hvor `main` står nå

- **PR #95 MERGET 2026-09-18** (`MERGE_SHA=9ede3ac1d2e32e708d38104e7a6869772774d628`, normal
  two-parent merge). Den lukket B2+B3: den samlede eier-kontrolloverflaten (`executive.*` for BÅDE
  lesing OG mutasjon), finans-kill-switch-dekningsreparasjonen og eier-vendt enhetstilbakekalling -
  host-bevist av D-179 (`run_id=bfca277d`, `hard_fail=false`). Den statusen er UENDRET av W1.
- K1/B1 sin durable, delte kjernemekanisme (`KillSwitch`/`OwnerControls`/`owner_control_state`,
  migrasjon 058) forblir `PRODUCTION_VERIFIED`. W1 BYGGER PÅ den - den endrer den ikke.

## Hva W1 (denne branchen) faktisk endret

Full begrunnelse: D-180 i `DECISIONS_AND_ASSUMPTIONS.md`, «W1» i `RUNTIME_GATES.md`.

1. **Produksjons-wiring (`apps/api/src/worker-main.ts`):** ÉN `Watchdog`-instans med de tre kanoniske
   sjekkene, startet HELT NEDERST - garantert etter Q-21-runtimesjekken OG `killSwitch.restore()`.
   Deler DEN SAMME pool-baserte `killSwitch` som `PolicyGateway` håndhever på. Avgrenset,
   konfigurerbart intervall (`JARVIS_WATCHDOG_INTERVAL_MS`, klemt til [5s, 1t], default 60s) via det
   EKSISTERENDE `setInterval`-mønsteret - ingen ny scheduler. `main.ts` får BEVISST ingen watchdog.
2. **Durabel nødstopp:** `costExplosionCheck` bruker nå `activateDurable(reason, actorPersonId)` og
   `isActiveDurable()`, ALDRI den prosess-lokale `activate()`/`isActive()`. Aktøren er eksplisitt og
   påkrevd; watchdog-proveniensen ligger maskinlesbart i `reason` (`watchdog:cost_explosion`).
   Gjentatte sykluser er et rent no-op (bevarer `reason` OG `changed_at`).
3. **ANDRE, DYPERE DEFEKT funnet under implementasjonen (ikke i D182):** `cost_events` OG `tasks` er
   `FORCE ROW LEVEL SECURITY`-beskyttet (migrasjon 005) - de tenant-løse aggregeringene så NULL rader
   under den ekte `jarvis_runtime`-rollen, så hardgrensen kunne STRUKTURELT ALDRI utløses i
   produksjon. Rettet med `withTenantTransaction()` og et eksplisitt `tenantIds`-omfang.
4. **Reell varsling:** `TelegramAlertSink` er ikke lenger et skall som ubetinget kaster - den bruker
   den EKSISTERENDE, delte `TelegramTransport` + `EnvSecretProvider`/`JARVIS_TELEGRAM_TOKEN`. Ingen ny
   klient, ingen ny credential, ingen token i logg/varseltekst. Mangler tokenet: feiler ÅPENT og typet.
5. **Feilisolasjon:** `tick()` sine `.catch(() => undefined)`-svelg erstattet av en `WatchdogObserver`;
   overlappingsvern i `tick()` selv; ytterste `.catch` i `startWatchdog()` slik at watchdogen aldri
   feller worker-prosessen. Rekkefølgen er sikkerhetskritisk: mutasjon FØRST, varsling ETTERPÅ -
   varslingsfeil kan hverken forhindre eller reversere nødstoppen.

## Testevidens

- `modules/watchdog/test/` **61/61 grønne**, hvorav 55 nye:
  `w1-watchdog-durability.test.ts` (18, ekte embedded Postgres på en EKTE `NOSUPERUSER NOBYPASSRLS`-rolle)
  og `w1-watchdog-production-wiring.test.ts` (37, strukturell wiring).
- `fase10-ops.test.ts` sin kostnadseksplosjons-test - SELVE maskeringen (pool-løs `KillSwitch` +
  superuser-`adminPool`) - er bundet om til den durable stien via den RLS-underlagte `appPool`.
- `pnpm -r run typecheck` og `pnpm run lint`: rene på hele workspacet.
- **EKTE REGRESJON fanget av eksakt-HEAD CI, RETTET (ikke bortforklart):** første CI-kjøring (run
  `35409347618`) feilet med NØYAKTIG to feil, begge i `apps/api/test/drive-runtime-wiring.test.ts`.
  W1 sin hoisting av `telegram: new TelegramTransport()` ut av worker-main sin
  `firstWaveTools({...})`-blokk (for å dele instansen med watchdogens alert sink) brøt to
  strukturelle assertions. Vakten er OPPDATERT, IKKE SVEKKET: ny
  `expectUnconditionalHoistedTelegram()` krever en ren, UBETINGET
  `const telegramTransport = new TelegramTransport();` på egen linje, NØYAKTIG ÉN
  `new TelegramTransport(` i filen, og at samme instans gis til `TelegramAlertSink` - altså strengere
  på det som betyr noe (ubetingethet + én delt instans) enn strengsjekken den erstatter. 13/13 grønne.
- **Kjente, PRE-EKSISTERENDE Windows-sandkasse-artefakter (IKKE W1-regresjoner, IKKE skjult) - de
  SAMME testene er grønne i Linux-CI på eksakt denne branchen:**
  - `modules/tool-gateway/test/docker-transport.test.ts` (12) og
    `modules/tasks/test/sandbox-docker-extra-env.test.ts`: `spawnSync` klarer ikke kjøre testenes
    fake `docker.cjs` på denne verten (`EFTYPE`). `modules/tool-gateway` er dessuten BYTE-IDENTISK
    med `main` (`git diff --name-only origin/main -- modules/tool-gateway` = tomt).
  - `apps/api/test/worker-coding-wiring.test.ts` (8): repoet har INGEN `.gitattributes` og
    `core.autocrlf=true`, så hele arbeidstreet er CRLF på Windows; tester som gjør
    `indexOf('...\n  ...')` mot kildetekst kan strukturelt ikke matche her, uavhengig av innhold.
  - Eksakt-HEAD CI (Linux) er autoritet for disse suitene.

## Blokkeringer

- **`HOST_ACCEPTANCE_STATUS=NOT_RUN`** - harnesset er bygget, men krever at Tobias kjører det på den
  ekte Windows/Docker/Postgres-hosten:

  ```
  node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-host-run.ts
  ```

  13 markører dekker alle tolv akseptansekravene. Akseptansen aktiverer KORTVARIG den EKTE globale
  kill switchen - ikke kjør den samtidig med annen aktiv bruk av Jarvis. INGEN destruktivt
  produksjonsforbruk (syntetiske, kjøre-unike `cost_events`-rader; hardgrensen beregnes relativt til
  faktisk forbruk; alt ryddes i CLEANUP, og `owner_control_state` verifiseres byte-identisk etterpå).
- Ingen merge-autoritet: krever en eksplisitt `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` i
  issue #68 (D-120), etter uavhengig arkitekt-review OG grønn eksakt-HEAD CI.

## Neste oppgave

1. Uavhengig arkitekt-review av denne PR-en + grønn eksakt-HEAD CI.
2. Deretter host-akseptansekjøring (kommandoen over), og ærlig oppdatering av
   `HOST_ACCEPTANCE_STATUS`/`INTERNAL_BUILD_COMPLETE` basert på faktisk resultat.
3. Først DERETTER D181 Value Track-målingsslicen (bevisst utsatt av W1 på sikkerhetsgrunnlag).

**Observert, bevisst IKKE rettet i W1 (registrert så det ikke går tapt):** `costReport()`
(`modules/watchdog/src/backup.ts`) har samme tenant-løse RLS-blindhet som `costExplosionCheck` hadde,
men er ikke del av produksjons-wiringen og dermed utenfor ordrens omfang - se D-180 §K.
