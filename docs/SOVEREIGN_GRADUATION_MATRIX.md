# Sovereign Autonomy v4.0 – graduation-matrise

**Sist oppdatert:** 2026-09-18 (D-173, rettet av uavhengig arkitekt-re-review 5248894556 mot exact HEAD
`b7967fc0d92bad52fa14f2dcbe68f252cd4afdb8`, PR #94). Denne filen er den KONSISE, oversiktlige statusen
for hele masterplanen ("Sovereign graduation") - `docs/RUNTIME_GATES.md` og
`docs/DECISIONS_AND_ASSUMPTIONS.md` forblir de detaljerte, autoritative kildene; denne filen peker til
dem, den erstatter dem ikke.

`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` er den faktiske v4.0-masterplanteksten
(distinkt fra v2.1-dokumentet CLAUDE.md sin dokumenthierarki navngir). Fasene løper **UA-0 til UA-11**;
det finnes ingen UA-12 eller senere fase i repoet - UA-11 (Executive Mode) er masterplanens TERMINALE
UA-fase. "Sovereign komplett" betyr derfor: summen av UA-0..UA-11 sine egne, ordrette akseptansekriterier
faktisk oppfylt og der masterplanen krever det, host-bevist - IKKE et eget, separat toppnivå-graduation-
kriterium utover disse.

**Status per 2026-09-18 (D-171, KORRIGERER D-170 sin `INTERNAL_BUILD_COMPLETE=true`):**
`SOVEREIGN_COMPLETE=false` (D-170 sin rettelse STÅR FORTSATT KORREKT, uendret av D-171).
**`INTERNAL_BUILD_COMPLETE=false` (RETTET fra D-169/D-170 sin `true`):** en fersk kildekode-audit
(D-171, arkitekt-review `5248461491`) fant at kapittel-28 punkt 15 ("eier kan fra ÉTT kontrollpanel
pause/revoke connector/enhet/leverandør/agent/finansdomene/HELE Jarvis") var overclaimed - `executive.*`
samler i dag LESING (status) av kontrolloverflaten, men IKKE MUTASJON: `owner_controls.*` sine seks
mutasjonshandlinger (kill switch/connector-frys/credential-tilbakekalling) er ikke nåbare fra
`executive.*`, og enhets-tilbakekalling (`SessionGrantService.revokeForDeviceOn`) mangler helt som
eier-vendt handling. **RETTET (D-172, arkitekt-re-review `5248756307`):** D-171 sin påstand om at
"domene-nivå finans-frys mangler helt" var selv unøyaktig - `finance.enable_kill_switch`/
`disable_kill_switch`/`get_kill_switch` (tenant-skopet `finance_kill_switch`) EKSISTERER ALLEREDE og
dekker Fiken/Stripe/Vipps-utbetalingsstier + Wallester-kort-mutasjoner - finansdomene er derfor SAMME
gap-type som connector/provider/agent (eksponeringsgap), IKKE en manglende primitiv. `INTERNAL_BUILD_BLOCKERS`
er derfor NAVNGITT: **"Samlet eier-kontrolloverflate, mutasjonsfullføring (B2)"** (nå: eksponering av
`owner_controls.*`+`finance.*` OG én ny enhets-tilbakekallingshandling) - se D-171/D-172 for full
mål-for-mål-kartlegging og RUNTIME_GATES.md for detaljer. K1 sin durable/delte KJERNEMEKANISME (kill
switch, connector-frys, credential-tilbakekalling/-gjenoppretting, kalt DIREKTE via `owner_controls.*`)
FORBLIR `PRODUCTION_VERIFIED` - D-171/D-172 tilbakekaller IKKE D-164 t.o.m. D-168, de korrigerer KUN
påstanden om at ETT PANEL (`executive.*`) allerede dekker mutasjon for alle syv kapittel-28-mål.
De øvrige `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170 sin sjekkliste: fire AI-leverandørfamilier+lokal
live-rutet, Growth-stack med before/after-evidens, reelle Finance-transaksjoner,
iPhone/Watch/Home/Personal/Health LIVE, backups/monitoring PRODUCTION_VERIFIED) forblir UENDRET FAKTISKE
eksterne graduation-blokkeringer for FULL Sovereign-status, uavhengig av B2 (som er INTERN). Roadmap-/
"Bygges"-liste-punkter utenfor de faktiske UA-fase-akseptansekriteriene forblir korrekt
`NOT_REQUIRED_FOR_GRADUATION` (D-169 sin analyse av DETTE punktet var korrekt, uendret av D-170/D-171/
D-172).
**RETTET IGJEN (D-173, arkitekt-re-review `5248894556`, BLOKKER B3):** D-172 sin
`FINANCE_UNCOVERED_MUTATIONS=NONE`-konklusjon var selv feil. Kall-for-kall-verifisering av
`modules/finance/src/card-service.ts` viser at `CardService.activateCard()` kaller `lifecycleAction()`
med et TOMT options-objekt (`{}`) - `killSwitchGated` er `undefined`, så `finance_kill_switch` sjekkes
ALDRI før et kort aktiveres. `submitCard()`/`unfreezeCard()`/spend-limit-økninger i `updateSpendPolicy()`
ER korrekt gatet; `freezeCard()`/`closeCard()` er bevisst IKKE gatet (spend-reduserende, riktig). Dette
er et REELT, navngitt internt implementasjonshull (`FINANCE_UNCOVERED_MUTATIONS=finance_wallester.
activate_card`), ikke bare eksponering - B2 sitt scope utvides til å inkludere denne reparasjonen FØR
finansdomenet eksponeres via `executive.*`. `INTERNAL_BUILD_COMPLETE=false` FORBLIR uendret.
**Se D-169 for re-audit-en, D-170 for den første to-aksede korreksjonen, D-171 for den ANDRE
korreksjonen (B2, mål-for-mål-kartlegging + valgt neste slice), D-172 for den TREDJE korreksjonen
(finansdomene-mapping rettet), og D-173 for den FJERDE korreksjonen (BLOKKER B3, finans-kill-switch-
dekningshull). Neste-steg er å IMPLEMENTERE B2+B3 som en egen slice, IKKE fortsette i denne
docs-only-PR-en, IKKE K2, IKKE en "final Sovereign graduation closeout".**

**D-174 (2026-09-18, IMPLEMENTERT - B2+B3 er NÅ LUKKET, IKKE lenger docs-only/neste-steg):**
`CardService.activateCard()` fikset (BLOKKER B3); `executive.*` fikk ti nye mutasjonsgjennomslag
(`activate/deactivate_kill_switch`, `freeze/unfreeze_connector`, `revoke/restore_credential`,
`revoke_device`, `enable/disable/get_finance_kill_switch`) - alle syv kapittel-28-mål (connector, hele
systemet, leverandør, agent, finansdomene, enhet, autonomi-/situasjonsdomene) er nå nåbare fra ÉTT
kontrollpanel for BÅDE lesing OG mutasjon. Ny `owner_controls.revoke_device` lukker mål 6 (enhet,
tidligere REELT GAP). Fresh arkitektonisk funn under implementasjonen: `gateway.ts`/`policy-gateway.ts`
sin B1-selvgjenopprettings-sjekk (D-166) måtte utvides til å gjelde `tool_id === "executive"` i tillegg
til `"owner_controls"` - uten dette ville de nye `executive.deactivate_kill_switch`/`restore_credential`
blitt blokkert av sin EGEN ytre tool_id FØR de nådde det trygge, nøstede kallet. **`INTERNAL_BUILD_
BLOCKERS=NONE` (RETTET fra D-171/D-173 sin navngitte liste). `INTERNAL_BUILD_COMPLETE=true` (RETTET fra
`false`).** `SOVEREIGN_COMPLETE=false` FORBLIR UENDRET - de navngitte `EXTERNAL_RUNTIME_EVIDENCE_
BLOCKERS` (D-170) er utenfor denne postens scope. `HOST_ACCEPTANCE_STATUS=PENDING` for den nye
`executive.*`-mutasjonsflaten (kjernemekanismen kalt DIREKTE via `owner_controls.*` forblir
`PRODUCTION_VERIFIED` fra K1/B1, uendret) - se D-174 i DECISIONS_AND_ASSUMPTIONS.md og RUNTIME_GATES.md
for full testevidens/host-harness-status.

**D-175 (2026-09-18, RETTET - arkitekt-review 5250409538, BLOKKER B4):** D-174 sin `owner_controls.revoke_device`/
`executive.revoke_device` tok feilaktig et FRITT kaller-oppgitt `tenant_id`-parameter, ved analogi til
`credential_ref`/`connector_id` (som treffer det tenant-frie `owner_control_state`). Denne analogien var
arkitektonisk feil: `session_grants`/`devices` er RLS-scopet (`FORCE ROW LEVEL SECURITY`) per tenant, så et
fritt `tenant_id`-parameter var et REELT cross-tenant-hull. RETTET: mål-tenanten er nå UBETINGET
`identity.tenant_id` (skjemaet har INGEN `tenant_id`-felt i det hele tatt); mål-enheten kan fortsatt tilhøre
en ANNEN PERSON/delegat i SAMME tenant (tillatt og nyttig); en enhet som kun finnes i en ANNEN tenant feiler
LUKKET (`DeviceNotFoundError`), IKKE et stille `ok:true`/`revoked_grants:0`. Ingen ny autorisasjonsbutikk,
ingen ny tenant-tilstand - kun identitetsbinding rettet. `HOST_ACCEPTANCE_STATUS=PENDING` uendret; harnesset
er oppdatert til å bevise D-175-korreksjonen via `executive.revoke_device` (ett-panel-bevis), men IKKE kjørt
i denne sesjonen. Se D-175 i DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse/testevidens.

**D-176 (2026-09-18, RETTET - arkitekt-re-review 5251073737, BLOKKER B5):** `executive.
get_control_surface_status` selv ble AVSLÅTT av NØYAKTIG kill-switch-aktiv-/tilbakekalt-credential-
gaten den skulle la eieren SE FORBI - D-174/D-175 sin `tool_id === "executive"`-utvidelse antok
FEILAKTIG identiske handlingsnavn (`get_control_surface_status` ≠ `get_control_state`), OG de TO
NØSTEDE lesingene den komponerer (`situations.get_pause_state`/`finance.get_kill_switch`) var HELLER
IKKE unntatt fra samme gate. Ny `isSelfRecoveryAction(toolId, action)` (owner-control-store.ts)
erstatter unionen med en eksplisitt per-(tool_id,action)-mapping for ALLE FIRE tool_id-ene - fortsatt
like smalt, INGEN mutasjon lagt til. `HOST_ACCEPTANCE_STATUS=PENDING` uendret; ny seksjon 4b i
harnesset beviser dette, men IKKE kjørt i denne sesjonen. Se D-176 i DECISIONS_AND_ASSUMPTIONS.md for
full begrunnelse/testevidens.

**D-177 (2026-09-18, RETTET - arkitekt-re-review 5252077633, BLOKKER B6):** D-176 sin seksjon 4b i
host-akseptanse-harnesset (`d174-executive-control-surface-live.ts`) brukte en sekvensiell
`executive.activate_kill_switch`+`executive.revoke_credential`-rekkefølge for å etablere "begge
låser samtidig" - STRUKTURELT UMULIG (samme bug-klasse testsuiten allerede var rettet for i D-176
selv, men IKKE anvendt på host-scriptet). Rettet til å sette BEGGE lås-tilstandene DIREKTE via det
durable laget (`stack.killSwitch.activateDurable(...)`/`stack.ownerControls.revokeCredentialDurable(
...)`), mens selve LESINGEN (`executive.get_control_surface_status`)/gjenopprettingen under test
fortsatt går via `executive.*`. `HOST_ACCEPTANCE_STATUS=PENDING` uendret. Se D-177 i
DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse/testevidens.

**D-178 (2026-09-18, RETTET - arkitekt-host-akseptanse-review 5252418219, BLOKKER B7):** FØRSTE EKTE
Windows-host-kjøring av D-174→D-177-harnesset (`run_id=d265a028`, mot HEAD
`f32ffe92850cf46d9cf4922d4d47ee890b7c378f`) - `hard_fail=true`. Q-21 OG ALLE ANDRE markører
(B4/B5/B6, D-176-seksjon-4b, negative kontroller, finans/Wallester-gating, cleanup) var PASS - KUN
enhets-tilbakekallings-fikstur/-lesing (seksjon 9/10) feilet: rå `sidePool`/`freshPool`-spørringer mot
RLS-beskyttede `devices`/`sessions`/`session_grants` (FORCE ROW LEVEL SECURITY, migrasjon 053) UTEN
tenant-kontekst, avslått under den ekte `jarvis_runtime`-rollen FØR selve `executive.revoke_device`-
kallet under test kunne nås. Rettet til å bruke den EKSISTERENDE kanoniske `withTenantTransaction()`-
hjelperen (`@jarvis/core`) for fikstur-innsetting OG begge lesinger; `adminPool` bevisst IKKE brukt for
fikstur/lesing (kun CLEANUP, uendret); `executive.revoke_device`-kallet under test er UENDRET.
`INTERNAL_BUILD_COMPLETE` satt til `false` (RETTET fra D-174/D-176/D-177 sin `true`) -
`HOST_ACCEPTANCE_STATUS=REQUIRES_RERUN` (den forrige host-kjøringen er SUPERSEDED av denne fiksen, en
FERSK host-kjøring er nødvendig FØR `INTERNAL_BUILD_COMPLETE` kan settes tilbake til `true`). Produk-
sjonskoden (executive/owner-controls/policy/tool-gateway) er UPÅVIRKET - B7 er en feil i AKSEPTANSE-
SCRIPTETS egen fikstur-/lesekode. Se D-178 i DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse/
testevidens.

**D-179 (2026-09-18, LIVE-BEVIST - arkitekt-host-akseptanse-review 5253069695, RESULT=PASS, mot
eksakt HEAD `d8d91fd3a55787191c234b17ce4a4a240dcbae97`, docs-only closeout, INGEN produksjonskode
endret av denne posten):** Tobias kjørte det D-178-rettede harnesset PÅ NYTT, faktisk to ganger -
begge PASS (`run_id=fc9b99e5` og den avsluttende `run_id=bfca277d`, BEGGE `hard_fail=false`). ALLE
markører PASS, inkl. `executive.revoke_device` (`grants_before=1`, `revoked_grants=1`, tenant bundet
til `tenant-personal` - NØYAKTIG den handlingen `d265a028` aldri nådde) og ferskinstans-
holdbarhetslesingen. Eksakt-HEAD CI (run `35394376138`) forble grønt. `HOST_ACCEPTANCE_STATUS=PASS`
(RETTET fra `REQUIRES_RERUN`), `INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true` (RETTET
fra D-178 sin `false`). `SOVEREIGN_COMPLETE=false` FORBLIR UENDRET - full kapittel-28-graduering er
FORTSATT ikke fullført, kun DENNE interne B2+B3-slicen. `MERGE_AUTHORIZED` krever fortsatt en
eksplisitt `ARCHITECT_TASK`-merge-ordre i issue #68 (D-120-protokollen), IKKE noe en PR-review alene
gir. Se D-179 i DECISIONS_AND_ASSUMPTIONS.md for full begrunnelse/testevidens.

**D-180 (2026-09-19, W1 IMPLEMENTERT - arkitekt-ordre `D183-W1-WATCHDOG-RUNTIME-DURABILITY-20260919-A`,
base `main=9ede3ac1d2e32e708d38104e7a6869772774d628`):** D182 sin rekognosering beviste et
`REAL_INTERNAL_GAP`: `@jarvis/watchdog` var fullt implementert OG fullt testet, men ALDRI koblet inn i
noen kjørende prosess, og `costExplosionCheck()` kalte den PROSESS-LOKALE `killSwitch.activate()` mens
produksjonens `PolicyGateway` sjekker `isActiveDurable()` mot `owner_control_state` - en
kostnadseksplosjon ville satt et flagg ingen håndhevende kode leser. `TelegramAlertSink.send()` var et
skall som ubetinget kastet. **En ANDRE, dypere defekt ble funnet under implementasjonen:** `cost_events`
OG `tasks` er `FORCE ROW LEVEL SECURITY`-beskyttet (migrasjon 005), så de rå, tenant-løse
aggregeringene i `costExplosionCheck`/`stuckTasksCheck` ser NULL rader under den ekte
`jarvis_runtime`-rollen - hardgrensen kunne strukturelt ALDRI utløses i produksjon. Begge defektene var
maskert av at den eneste eksisterende testen brukte BÅDE en pool-løs `KillSwitch` OG en
superuser-`adminPool` (samme bug-klasse som D-178/B7, denne gangen i produksjonskode). RETTET:
`activateDurable(reason, actorPersonId)` med eksplisitt, påkrevd eier-aktør og watchdog-proveniens i
`reason`; tenant-skopet summering via `withTenantTransaction()`; produksjons-wiring av ÉN
watchdog-instans i `apps/api/src/worker-main.ts` (etter Q-21-sjekken OG `killSwitch.restore()`, med
avgrenset konfigurerbart intervall, ingen duplikat i `main.ts`); reell varsling via den EKSISTERENDE,
delte `TelegramTransport`+`JARVIS_TELEGRAM_TOKEN`-kjeden; observerbar feilisolasjon og
overlappingsvern i `tick()`. 55 nye tester grønne (18 durabilitet mot en ekte
`NOSUPERUSER NOBYPASSRLS`-rolle + 37 strukturell wiring); typecheck/lint rene.
**`INTERNAL_BUILD_COMPLETE=false` (RETTET fra D-179 sin `true`), `INTERNAL_BUILD_BLOCKERS=
W1_HOST_ACCEPTANCE_PENDING`, `HOST_ACCEPTANCE_STATUS=NOT_RUN`** - harnesset
(`modules/watchdog/scripts/w1-watchdog-durability-{live,host-run}.ts`) er bygget, men IKKE kjørt mot
ekte Docker/Postgres. `SOVEREIGN_COMPLETE=false` FORBLIR UENDRET. Ingen Value Track-arbeid, ingen
berøring av PR #87, ingen UGREEN-migrering, ingen nye eksterne credentials. Se D-180 i
DECISIONS_AND_ASSUMPTIONS.md og «W1» i RUNTIME_GATES.md.

## 16-områders graduation-matrise

| Område | Status | Evidens (kort) |
|---|---|---|
| AI Mesh / routing / fallback | LIVE-PROVEN (kjerne) | Ekte OpenAI-kall bevist (UA0-RUNRATE); Gemma-first routing CI_VERIFIED (D-80/D-81); enkelte providere (Gemini m.fl.) fortsatt ukonfigurert i dette miljøet |
| Memory / knowledge / retrieval | LIVE-PROVEN | UA-2 P0/P1A/P1B PRODUCTION_VERIFIED; pgvector/HNSW selv BLOCKED_EXTERNAL (portabel `real[]`+cosine i drift) |
| Business Graph | LIVE-PROVEN | UA-3 P0 PRODUCTION_VERIFIED (host run `ca2d9248`) |
| Ads / Growth | TESTED (ikke live-provider-verifisert) | UA-4 CI_VERIFIED/COMPLETE mot masterplanens fire kriterier; Google Ads live-verifisering `DEFERRED_TO_FINAL_INTEGRATION_PHASE` (D-86) |
| Cloud / dev / task execution | LIVE-PROVEN | UA-5 v2 LIVE_VERIFIED, alle fire kriterier COMPLETE (D-105) |
| Finance | TESTED (ikke live) | FIXED_SUITE_VERIFIED; Stripe `STRIPE_LIVE_GATE=PENDING_CREDENTIALS` |
| Communications / voice | LIVE-PROVEN (Telegram/Gmail) + BLOCKED_EXTERNAL (voice-benchmark) | Telegram/Gmail LIVE+VERIFIED; D-30 voice-benchmark krever ≥100 norske prøver + STT/TTS-nøkler. **UA-7 har ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Personal / device / home | BLOCKED_EXTERNAL | D-36 Apple runtime krever Mac/Xcode/Developer-konto; HA-RUNTIME krever ekte HA-instans+token. **UA-8 har ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Vision (UA-9) | IMPLEMENTED, provider-uavhengig kjerne, ikke live | D-153: `CAN_RUN_WITHOUT_PROVIDER=true`, ZERO leverandør koblet. Live kamera/klassifiserer = BLOCKED_EXTERNAL. **Ingen egen RUNTIME_GATES.md-rad (dokumentasjonshull, se Q-35)** |
| Situation Engine (UA-10) | LIVE-PROVEN | P1 Aktivering PRODUCTION_VERIFIED (D-161, host run `0562c48a`, 18/18 PASS, ekte Telegram) |
| Executive Mode (UA-11) | TESTED, host ikke nødvendig for P0 | FIXED_SUITE_VERIFIED (D-162); `HOST_ACCEPTANCE_REQUIRED=false` (zero ny migrasjon/credential/leverandør) |
| Class D authority | TESTED (suite), live mot ekte connectors delvis | UA0-AUTHORITY PARTIAL_RUNTIME i eget navn, men substansielt dekket kumulativt av UA-5/UA-10 P1 sine host-bevis |
| Pause / revoke / kill switch | KJERNEMEKANISME LIVE-PROVEN (K1); **ÉTT-PANEL-MUTASJON LUKKET OG LIVE-BEVIST (D-174→D-179, B2+B3) - HOST_ACCEPTANCE_STATUS=PASS for executive.\*-flaten (D-179, host run_id `bfca277d`)** | `situations`-domener durable+delt (D-160 F); `OwnerControls`/`KillSwitch` durable+delt (D-164, migrasjon 058, `owner_control_state`) - api/worker deler SAMME live DB-autoritet. `PRODUCTION_VERIFIED` NÅR KALT DIREKTE via `owner_controls.*` for kill switch + connector-frys (D-165) OG `revoke_credential`/`restore_credential`/samtidig-deadlock-gjenoppretting/run-avgrenset audit-bevis (D-166/D-167/D-168, alle markører PASS). **D-174 (2026-09-18, IMPLEMENTERT):** disse seks mutasjonene ER NÅ nåbare fra `executive.*` (tynne `gateway.execute()`-gjennomslag), PLUSS en ny `revoke_device` (enhet) og finans-nødbryter-videresendinger - "ett kontrollpanel" er nå samlet for BÅDE LESING OG MUTASJON. Se RUNTIME_GATES.md og D-174 sin fulle begrunnelse. **D-175 (RETTET, BLOKKER B4):** `revoke_device` tok feilaktig et fritt kaller-oppgitt `tenant_id`; nå UBETINGET `identity.tenant_id` (INGEN `tenant_id`-felt i skjemaet), enhet i annen tenant feiler LUKKET (`DeviceNotFoundError`). **D-176 (RETTET, BLOKKER B5):** `get_control_surface_status` selv (PLUSS dens to nøstede `situations`/`finance`-lesekall) er nå OGSÅ unntatt fra kill-switch-/tilbakekalt-credential-gaten, via `isSelfRecoveryAction()`. **D-177 (RETTET, BLOKKER B6):** host-harnessets lås-oppsett rettet til durable-lag i stedet for umulig sekvensiell `executive.*`-oppsett. **D-178 (RETTET, BLOKKER B7):** host-harnessets enhets-fikstur/-lesing rettet til `withTenantTransaction()` under ekte RLS. **D-179 (LIVE-BEVIST, 2026-09-18):** Tobias sin ekte host-rerun (`run_id=bfca277d`/`fc9b99e5`, BEGGE `hard_fail=false`) beviser ALLE markører PASS, inkl. `executive.revoke_device` - `HOST_ACCEPTANCE_STATUS=PASS`, `INTERNAL_BUILD_COMPLETE=true` |
| Erasure / retention | LIVE-PROVEN (teknisk fundament) | Q-20 PRODUCTION_VERIFIED (2026-08-16) - teknisk fundament, IKKE juridisk GDPR-sertifisering |
| Audit / provenance | TESTED, live-datastrøm gjenstår | UA0-PRIVACY PARTIAL_RUNTIME - RLS/karantene/injection-vern suite-bevist |
| Restart / restore / recovery | LIVE-PROVEN (lokalt) / BLOCKED (off-site) | OPS-RUNTIME VERIFIED lokalt; ekstern uptime/off-site backup gjenstår |
| Watchdog / automatisk nødstopp (W1) | IMPLEMENTERT + PRODUKSJONS-WIRET, host-akseptanse IKKE kjørt | **D-180 (2026-09-19):** D182 fant at `@jarvis/watchdog` ALDRI var koblet inn i noen kjørende prosess, og at `costExplosionCheck` brukte den prosess-lokale `killSwitch.activate()` mens `PolicyGateway` håndhever på `isActiveDurable()`. En ANDRE, dypere defekt ble funnet under implementasjonen: `cost_events`/`tasks` er FORCE RLS-beskyttet, så de tenant-løse aggregeringene så NULL rader under den ekte runtime-rollen - hardgrensen kunne strukturelt aldri utløses. Begge rettet (`activateDurable()` + `withTenantTransaction()`), watchdogen er wiret inn i `apps/api/src/worker-main.ts`, og `TelegramAlertSink` bruker nå den ekte, eksisterende `TelegramTransport`. 55 nye tester grønne. `HOST_ACCEPTANCE_STATUS=NOT_RUN` - se RUNTIME_GATES.md «W1» og D-180 |

## UA-9/UA-10/UA-11 deferred-punkter - IMPLEMENTATION_STATUS / LIVE_EVIDENCE_STATUS

Full begrunnelse per punkt: D-163 (alle runder) og D-153/D-160/D-161/D-162 (tidligere faser).
`A = IMPLEMENT_NOW` (kodbar nå, ingen ekstern avhengighet) · `B = PROVE_NOT_REQUIRED` (utenfor
nåværende graduation-scope, med konkret masterplan-begrunnelse) · `C = BLOCKED_EXTERNAL` (krever
navngitt ekstern/fysisk avhengighet for selve completion).

**RETTET etter arkitekt-review runde 1 OG 2 (review 5241197516, RESULT=CHANGES_REQUIRED, D-163 F/G):**
den FØRSTE versjonen av denne tabellen konflaterte IMPLEMENTASJON med LIVE-BEVIS og klassifiserte
derfor flere internt kodbare punkter som `C` når kun deres produksjons-/live-evidens faktisk var
eksternt blokkert. Hvert punkt der de to reelt er forskjellige er nå splittet i to EGNE kolonner -
`IMPLEMENTATION_STATUS` (kan selve koden/pipelinen/broen bygges og testes nå, mot canonical
contracts/fake sources/eksisterende intern data?) og `LIVE_EVIDENCE_STATUS` (krever den FAKTISKE
production-completion en navngitt ekstern/fysisk avhengighet?). `C` brukes KUN når selve completion
faktisk krever den eksterne avhengigheten - aldri som en samlebetegnelse for "ingen har bygget dette
ennå".

| Punkt | IMPLEMENTATION_STATUS | LIVE_EVIDENCE_STATUS | Begrunnelse |
|---|---|---|---|
| UA-9: objektklassifiserer/model-pipeline | **B** (rettet fra C) | **C** | `ModelGateway`/Gemma-vision-stien (D-81) finnes allerede og kan kalles mot et test-/syntetisk bilde uten fysisk kamera - klassifiserer-KODEN er ikke eksternt blokkert (`IMPLEMENTATION_STATUS=B`, ikke påkrevd av UA-9 P0-DoD som eksplisitt valgte en provider-uavhengig kjerne, D-153). Kun kamerafangst/live strøm-ruting krever fysisk iPhone-/HA-kamera + valgt modell-leverandør-avtale (`LIVE_EVIDENCE_STATUS=C`, egen D-64/D-41-port) |
| UA-9: biometrisk ansiktsgjenkjenning, kontinuerlig rå video | B | N/A | Eksplisitt UTENFOR masterplan v4.0 UA-9-scope (DPIA §5) - ingen live-bevis-spørsmål oppstår når implementasjonen selv ikke skal bygges |
| UA-10: infra-detektor (bro fra incidents/deploy-tilstand til situations) | **B** (rettet fra C) | **C** | `modules/incidents` har ALLEREDE ekte, internt kanonisk deploy-/incident-tilstand (`correlateIncident()`, D-104/D-105) - broen er kodbar/testbar NÅ mot eksisterende intern data, ingen fysisk avhengighet (`IMPLEMENTATION_STATUS=B`: UA-10s egne akseptansekriterier - dedupe/ACT-autoritet/varsel/pause - er allerede oppfylt uten den, masterplanen krever den ikke ennå). Ekte tverr-provider-korrelasjon (GitHub/Vercel/GCP) for PRODUKSJON krever leverandør-tilkobling (Q-31) (`LIVE_EVIDENCE_STATUS=C`) |
| UA-10: home-/health-detektor (bro fra `@jarvis/health`/`@jarvis/location` til situations) | **B** (rettet fra C) | **C** | `@jarvis/health`/`@jarvis/location` har canonical schema + `FakeHealthMetricSource`/test-kilder - broen er kodbar/testbar NÅ, samme mønster som open-loop-broen mot intern Business OS-data (`IMPLEMENTATION_STATUS=B`: ikke et UA-10-akseptansekrav ennå). Ekte fysiske health-/home-signaler krever enhets-/HA-tilkobling (D-36, HA-RUNTIME) (`LIVE_EVIDENCE_STATUS=C`) |
| UA-10: modell-assistert klassifisering | **B** (rettet fra C) | **C** (betinget) | `ModelGateway` og provider-uavhengig modell-infrastruktur finnes ALLEREDE i repoet - IKKE en ekstern blokkering i seg selv (`IMPLEMENTATION_STATUS=B`: masterplanens egen valgfrie forbedring av en allerede fullt deterministisk, host-verifisert P0/P1-motor, ikke et akseptansekrav). `LIVE_EVIDENCE_STATUS=C` reservert KUN for et navngitt credential-/leverandørkrav hvis/når en spesifikk leverandør faktisk velges - ikke en generell blokkering av kapabiliteten |
| UA-10: simulation/counterfactual/feedback learning | B | N/A | Masterplanens egen 'where useful'-kvalifikator, ikke et akseptansekrav |
| UA-10: vision-/helse-/lokasjonsbro (situations-siden av broen) | **B** (rettet fra C) | **C** | Broen selv ER kodbar/testbar mot canonical schema + fake sources, samme mønster som open-loop-broen (`IMPLEMENTATION_STATUS=B`: ikke et UA-10-akseptansekrav ennå). Reell PRODUKSJONSVERDI krever at UA-9/helse/lokasjon faktisk har en live kilde (`LIVE_EVIDENCE_STATUS=C`) - en verdi-/live-bevis-blokkering, ikke en kode-blokkering |
| UA-10: `situations`/`executive` i `worker-main.ts` | **A (rettet av D-171 - allerede wired)** | N/A | D-171 sin fersk kildekode-audit bekrefter `apps/api/src/worker-main.ts` konstruerer SAMME delte `KillSwitch`/`OwnerControls`/`ToolGateway`-par som `main.ts` mot samme databasetabell - `owner_controls.*` er dermed identisk håndhevet i begge prosesser. `situations`/`executive` sine EGNE eier-vendte transportlag var IKKE del av denne verifiseringen og kan fortsatt være unwired der - ingen ny eier-vendt kaller er bekreftet i worker-prosessen for disse to spesifikt |
| UA-11: dashboard/UI | B | N/A | Kun i masterplanens 'Bygges'-ROADMAP-liste, ikke i de tre faktiske akseptansekriteriene; `situations.*` fikk samme behandling |
| UA-11: business health/personal attention-kilder utover `situations` | B (delvis allerede dekket) | N/A | Sales/support/kontrakt/marketing/finans/produkt/drift flyter allerede inn via de 26 `OpenLoopType`-verdiene og den eksisterende broen (D-160 B) - personal/home/health-signaler avhenger av UA-10s helse-/lokasjonsbro over, som nå er `IMPLEMENTATION_STATUS=B` (kodbar), ikke C |
| UA-11: decision log/scenario/risikoregister/OKR/delegasjonstavle | **B (rettet fra A, D-169) - NOT_REQUIRED_FOR_GRADUATION** | N/A | Ordrett i masterplanens 'Bygges'-ROADMAP-liste, men IKKE blant de TRE faktiske, ordrette UA-11-akseptansekriteriene (`UA11_EXECUTIVE_MODE_DESIGN.md` §7/§9: "Masterplan-bullets uten en eksisterende kanonisk kilde i repoet ennå" - eksplisitt DEFERRED, samme behandling som dashboard/UI). INGEN kanonisk datakilde finnes; K2 (denne kandidaten) er derfor IKKE en Sovereign-graduation-blokkering - kun en fremtidig, lavere-prioritert, eksplisitt IKKE-valgt utvidelse utover selve akseptansekriteriene (D-169) |
| UA-11: akseptansekriterium 3 ('one control surface' for connector/provider/agent/autonomy-domene) | **A - KRITERIUM OPPFYLT OG LIVE-BEVIST (D-174→D-179, B2+B3, HOST_ACCEPTANCE_STATUS=PASS)** | LIVE-PROVEN for kill switch + connector-frys-kjernen (host run_id `d7d5d246`) OG for B1 sin credential-selvgjenoppretting/samtidig-deadlock-gjenoppretting/audit-bevis, ALLE KALT DIREKTE via `owner_controls.*`; NÅ OGSÅ host-bevist for de NYE `executive.*`-gjennomslagene (D-179, host run_id `bfca277d`) | `situations` dekket via `executive.*` (pause/resume/get_pause_state); `OwnerControls`/`KillSwitch` durable+delt (D-164) og host-bevist (D-165/D-166/D-167/D-168). **D-171→D-173 (arkitekt-reviews `5248461491`/`5248756307`/`5248894556`):** fant og korrigerte at `executive.*` KUN samlet lesing, at finansdomenet FAKTISK hadde en eksisterende primitiv (kun eksponeringsgap), og at `CardService.activateCard()` hadde et REELT dekningshull. **D-174 (2026-09-18, IMPLEMENTERT):** ALLE tre lukket - `executive.*` fikk ti nye mutasjonsgjennomslag (`activate/deactivate_kill_switch`/`freeze/unfreeze_connector`/`revoke/restore_credential`/`revoke_device`/`enable/disable/get_finance_kill_switch`), `CardService.activateCard()` fikset (`{ killSwitchGated: true }`), ny `owner_controls.revoke_device` lukker enhets-gapet (mål 6). B1-selvgjenopprettingsgaten (D-166) utvidet til `tool_id === "executive"` (fresh funn under implementasjonen). Kapittel 28 sitt "ett kontrollpanel" er nå samlet for BÅDE lesing OG mutasjon, for ALLE syv navngitte mål. **D-175 (RETTET, BLOKKER B4):** `revoke_device` sin mål-tenant er nå UBETINGET `identity.tenant_id`, ALDRI et kaller-oppgitt parameter - se D-175. **D-176 (RETTET, BLOKKER B5):** `get_control_surface_status` selv (og sine nøstede lesekall) overlever nå lås-gatene den tidligere ble avslått av - se D-176. **D-177 (RETTET, BLOKKER B6):** host-harnessets umulige sekvensielle lås-oppsett rettet til durable-lag - se D-177. **D-178 (RETTET, BLOKKER B7):** host-harnessets enhets-fikstur/-lesing (seksjon 9/10) rettet til `withTenantTransaction()` under ekte RLS - se D-178. **D-179 (LIVE-BEVIST, denne raden):** Tobias sin ekte host-rerun (`run_id=bfca277d`/`fc9b99e5`, BEGGE `hard_fail=false`) beviser ALLE markører PASS, inkl. `executive.revoke_device` - `HOST_ACCEPTANCE_STATUS=PASS` (RETTET fra `PENDING`/`REQUIRES_RERUN`) - se D-179 |
| UA-11: host-akseptanse-harness | B | N/A | Zero ny migrasjon/credential/leverandør i P0 - ingenting å bevise live |

## Neste-steg (D-171→D-173 definerte B2+B3; D-174 IMPLEMENTERTE den - `INTERNAL_BUILD_COMPLETE=true`, `INTERNAL_BUILD_BLOCKERS=NONE`, `SOVEREIGN_COMPLETE=false` uendret)

**K1 sin durable/delte KJERNEMEKANISME er FERDIG: IMPLEMENTERT, HOST-BEVIST, MERGET** (kill switch,
connector-frys, credential-tilbakekalling/-gjenoppretting - se D-164 t.o.m. D-168 og RUNTIME_GATES.md).
Dette er UENDRET av D-171/D-172. En fersk kildekode-audit (D-171, uavhengig arkitekt-re-review
`5248461491` mot exact HEAD `5426a6d...`) fant at kapittel-28 punkt 15 ("ett kontrollpanel") var
overclaimed: `executive.*` samler kun LESING av kontrolloverflaten, ikke MUTASJON. De seks
`owner_controls.*`-mutasjonene (kill switch/frys/tilbakekalling) er ikke nåbare fra `executive.*`; en
eier-vendt enhets-tilbakekallingshandling mangler helt. **RETTET (D-172, arkitekt-re-review
`5248756307`):** D-171 sin påstand om at "en domene-nivå finans-fryseprimitiv mangler helt" var selv
unøyaktig - `finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` (`finance_kill_switch`,
tenant-skopet) EKSISTERER ALLEREDE og dekker Fiken/Stripe/Vipps-utbetalingsstier +
`submitCard()`/`unfreezeCard()`/spend-limit-økninger - finansdomene er SAMME eksponeringsgap-type som
connector/provider/agent (se mål-for-mål-tabellen over i UA-11-raden). **RETTET IGJEN (D-173,
arkitekt-re-review `5248894556`, BLOKKER B3):** D-172 sin dekningsaudit selv hadde et hull -
`CardService.activateCard()` (`modules/finance/src/card-service.ts` linje 314-315) kaller
`lifecycleAction()` med et TOMT options-objekt, `killSwitchGated` er `undefined` - `finance_kill_switch`
sjekkes ALDRI ved kortaktivering. `FINANCE_UNCOVERED_MUTATIONS` navngir nå
`finance_wallester.activate_card`/`CardService.activateCard()` - et REELT internt kode-hull (ikke bare
eksponering), som må rettes SOM DEL av B2-implementasjonen før finansdomenet eksponeres. **Rettet
status:** `INTERNAL_BUILD_BLOCKERS` er derfor NAVNGITT (**"Samlet eier-kontrolloverflate,
mutasjonsfullføring, B2+B3"**), IKKE `NONE` som D-169/D-170 sa. `INTERNAL_BUILD_COMPLETE=false`
(RETTET fra D-170 sin `true`, FORBLIR `false` UENDRET av D-172/D-173 - enhet ALENE var allerede
tilstrekkelig til å holde denne `false`, B3 legger til ett navngitt gap videre). `SOVEREIGN_COMPLETE=false`
forblir UENDRET (allerede korrekt i D-170 - ingen av rettelsene endrer den konklusjonen, kun hvorvidt "intern bygging"
faktisk var ferdig).

**D-174 (2026-09-18) - B2+B3 ER NÅ IMPLEMENTERT (den planlagte slicen under er UTFØRT, ikke lenger
fremtidig):** `executive.*` komponerer nå `owner_controls.*`/`situations.*`/`finance.*` for BÅDE lesing
OG mutasjon (ti nye tynne gjennomslag); `owner_controls.revoke_device` pakker inn
`SessionGrantService.revokeForDeviceOn()`; `CardService.activateCard()` sender nå
`{ killSwitchGated: true }` (B3-fiksen). `INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true`
**- RETTET IGJEN av D-178/BLOKKER B7 (2026-09-18): den FØRSTE ekte host-kjøringen fant at host-
harnessets EGEN enhets-tilbakekallings-fikstur/-lesing manglet RLS-tenant-kontekst; `INTERNAL_BUILD_
BLOCKERS` var derfor på ny NAVNGITT ("B7 host fixture/readback RLS tenant-context proof") og
`INTERNAL_BUILD_COMPLETE=false` inntil en FERSK host-kjøring beviste D-178-fiksen - se D-178.**
**- RETTET TILBAKE av D-179/LIVE-BEVIST (2026-09-18): Tobias sin ekte host-rerun (`run_id=bfca277d`/
`fc9b99e5`, BEGGE `hard_fail=false`) beviser NÅ D-178-fiksen LIVE - `INTERNAL_BUILD_BLOCKERS=NONE`,
`INTERNAL_BUILD_COMPLETE=true` - se D-179.**
`SOVEREIGN_COMPLETE` FORBLIR `false` (eksterne blokkere, D-170, uendret). Planbeskrivelsen under er
BEVART som historisk kontekst for HVORFOR/HVORDAN slicen ble formet, ikke redigert.

**Opprinnelig planlagt slice (definert i D-171, RETTET av D-172/D-173 - NÅ IMPLEMENTERT av D-174, se
over):** B2+B3 -
`executive.*` blir DEN ENE eier-vendte mutasjonsoverflaten ved å komponere (ikke duplisere)
`owner_controls.*`/`situations.*`/`finance.*` gjennom `ToolGateway.execute()`; legg til én ny
eier-vendt enhets-tilbakekallingshandling over `SessionGrantService.revokeForDeviceOn()`; RETT
`CardService.activateCard()` sitt `lifecycleAction()`-kall til å sende `{ killSwitchGated: true }`
(D-173, BLOKKER B3 - MÅ gjøres FØR finansdomenet eksponeres, ellers eksponeres et hull, ikke løses det);
legg deretter til `executive`-videresendinger for de EKSISTERENDE `finance.enable_kill_switch`/
`disable_kill_switch`/`get_kill_switch`-handlingene (**RETTET, D-172: INGEN ny domene-nivå-primitiv
skal oppfinnes**). IKKE K2, IKKE en "final Sovereign graduation closeout", IKKE ny masterplan, IKKE
UGREEN-migrering.

- **K1 - Durable, delt owner-kontroll, KJERNEMEKANISME (FULLFØRT: IMPLEMENTERT, HOST-BEVIST, MERGET).**
  `OwnerControls`/`KillSwitch` er durable og delt mellom api-/worker-prosessene (samme mønster som
  `DomainPauseRegistry`, D-160 F; bekreftet identisk wiring i BÅDE `main.ts` og `worker-main.ts`,
  D-171), eksponert via kanonisk `owner_controls.*` og komponert av `executive.*` for BÅDE lesing OG
  mutasjon (**D-174, B2+B3 IMPLEMENTERT** - host-akseptanse for denne flaten er `PENDING`).
- **K2 - Decision log.** Reklassifisert `NOT_REQUIRED_FOR_GRADUATION` (D-169) - roadmap-only, ikke et
  UA-11-akseptansekriterium. Forblir en fremtidig, lavere prioritert, IKKE startet, IKKE valgt kandidat
  dersom Tobias på et senere tidspunkt ønsker den utover selve Sovereign-graduation-scopet.

## Dokumentasjonshull (registrert, ikke rettet i kode)

UA-7 (Communications Hub, D-119) og UA-8 (Personal Digital Twin, D-130/D-131) er kode-implementert og
dokumentert i `IMPLEMENTATION_PLAN.md`/`DECISIONS_AND_ASSUMPTIONS.md`, men har INGEN egen rad i
`docs/RUNTIME_GATES.md`. UA-9 (Vision) har samme mangel. Registrert som Q-35 - en fremtidig, ren
dokumentasjons-oppfølging, ikke en del av mandatet for denne audit-runden.
