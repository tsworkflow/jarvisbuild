# UA-11 — Design-notat (Executive Mode, P0)

**Status:** UA-11 «Executive Mode» — attention-ranking + samlet eier-kontrollflate P0-kjerne bygget
(2026-09-17, D-162). Samme form og disiplin som `UA10_SITUATION_ENGINE_DESIGN.md`: kort og teknisk.
Denne pakken (`@jarvis/executive`) eier INGEN egen tilstand og INGEN egen kilde. Den KOMPONERER
`@jarvis/situations` (UA-10, PRODUCTION_VERIFIED, D-161) - D-64: `situations` er allerede
JARVIS_CANONICAL, så komposisjon (ikke duplisering) er riktig retning for et lag som SAMLER hva som
trenger eierens oppmerksomhet.

## §1. Hvorfor komposisjon, ikke en ny motor

Masterplanens UA-11-mål («executive dashboard, daily brief, attention ranking», «one-tap
pause/override/revoke») beskriver en OVERFLATE, ikke en ny kilde til sannhet. `situations` (UA-10) er
ALLEREDE den kanoniske hendelses-/situasjons-tilstandsmaskinen (ignore -> remember -> inform -> suggest
-> act -> act_notify -> escalate), allerede tenant/space-isolert, allerede autoritets-/pause-/
policy-håndhevet. Å bygge en «Executive Situation Engine» ved siden av ville:

- duplisert `DomainPauseRegistry`/autonomi-policy-logikken (to sannheter om hva som er pauset),
- omgått den ALLEREDE reviewte D-68-identitets-disiplinen (`ToolInvocationContext`, ALDRI parametre),
- brutt D-64 (en ny, parallell kjerne for noe `situations` allerede eier kanonisk).

`@jarvis/executive` gjør derfor INGEN egen SQL. `ExecutiveService` sin konstruktør tar KUN en
`ToolGateway`-referanse - se §2.

## §2. Arkitektur: ETT nøstet ToolGateway-lag, aldri en sidevei

```
Eier/kaller (identity fra ToolInvocationContext, ALDRI fra parametre)
        │
        ▼
ToolGateway.execute({ tool_id: "executive", action, parameters })
        │  PolicyGateway.authorize() (SAMME sovereign-owner-modus/KillSwitch/freeze som ALT annet)
        ▼
ExecutiveTransport.invoke()
        │
        ▼
ExecutiveService (KUN en ToolGateway-referanse - ALDRI SituationEngine/DomainPauseRegistry direkte)
        │
        ▼  gateway.execute({ tool_id: "situations", action, parameters }, SAMME identity)
        │  PolicyGateway.authorize() KJØRER EN GANG TIL (dobbelt-gatet, ikke bypasset)
        ▼
SituationsTransport → SituationEngine / DomainPauseRegistry (UENDRET, D-160)
```

Dette er SAMME «nøstet ToolGateway-kall med uendret, videreført identitet» - mønsteret
`MeshToolExecutor`/`docker`-recovery/`incidents`-modulen allerede bruker for å komponere en annen
allerede-registrert kapabilitet (D-68 «SECURITY FIX #2»: den opprinnelige kallerens identitet gis
UENDRET videre til ethvert nøstet gateway-kall - denne pakken fabrikkerer eller eskalerer den aldri
selv). Konsekvensen: `executive.pause_domain` kan STRUKTURELT ikke gjøre noe `situations.pause_domain`
selv ikke også ville gjort - samme autoritetssjekk, samme audit-rad, samme database-tilstand.

## §3. Attention-ranking er deterministisk - ikke en modell, ikke en skjult heuristikk

`ranking.ts` er en REN modul: ingen database, ingen klokke unntatt en injisert `now`, ingen
ModelGateway/AI-kall. Faktorene som faktisk brukes (kun felt som finnes på `Situation`):

| Faktor | Kilde | Rolle |
|---|---|---|
| `stage` | `Situation.stage` | Primær vekt (`STAGE_ATTENTION_WEIGHT`) - `escalate` størst, `remember`/`ignore` filtreres helt ut (aldri attention-verdige). |
| `priority` | `Situation.priority` | Sekundær vekt (`PRIORITY_WEIGHT`) - kan ALDRI hoppe en hel stage-terskel. |
| `confidence` | `Situation.confidence` | Finjustering (±0,999) - kan ALDRI hoppe en hel priority-terskel. |
| `opened_at` | `Situation.opened_at` | Tie-break #1 ved lik score - eldre (mer «overdue») FØRST. |
| `last_notified_at` + `resuppress_hours` | `Situation.last_notified_at` / `situations.get_notification_policy` | Liten cooldown-nedvekting (aldri undertrykkelse - se §6). |
| `situation_id` | `Situation.situation_id` | Siste, ALDRI-tvetydige tie-break - garanterer total, replay-stabil orden selv ved to identiske rader. |

**Bevisst IKKE brukt:** «business impact» (masterplanens eksempelliste) - `Situation` har intet tallfelt
for forretningsmessig konsekvens. Å konstruere ett her ville vært oppfunnet semantikk dataene selv ikke
sier. Hører til en SENERE UA-11-slice DERSOM en kilde som faktisk bærer det kobles til `situations`
(samme D-64-disiplin).

**Determinisme bevist (ikke bare hevdet):** `modules/executive/test/ranking.test.ts` (21 tester) - samme
input gir alltid samme score (100 repetisjoner), input-rekkefølgen påvirker aldri sluttresultatet, en
komplett `JSON.stringify()`-likhet mellom to kjøringer med reversert inputrekkefølge.

## §4. Kontrollflaten (`tool_id: "executive"`)

| Action | Klasse | Gjennomslag til |
|---|---|---|
| `get_attention_queue` | A | `situations.get_queue` + `get_pause_state` + `list_autonomy_policies` + `get_notification_policy` (aggregert, rangert) |
| `get_attention_item` | A | Samme som over, filtrert til ETT `situation_id` + selve kilde-`Situation`-raden |
| `get_pause_state` | A | `situations.get_pause_state` |
| `pause_domain` | C | `situations.pause_domain` |
| `resume_domain` | C | `situations.unpause_domain` |
| `resolve_situation` | B | `situations.resolve` |
| `get_control_surface_status` | A | `owner_controls.get_control_state` + `situations.get_pause_state` (K1, D-164) |

Ingen handling har en HØYERE eller LAVERE kapabilitetsklasse enn den underliggende `situations.*`-
handlingen den videresender til - executive-laget innfører ALDRI en egen risikoklassifisering for
samme reelle mutasjon. `resolveIdentity()`-avslag/PolicyGateway-avslag/KillSwitch/freeze fra det
nøstede kallet PROPAGERES transparent (kastes videre av transporten, se `transport.ts` sin
`toolResultToTransportResult()`) - ALDRI en stille `ok:true` på executive-laget for noe det
underliggende laget faktisk nektet.

**K1-tillegg (2026-09-17, D-164): `get_control_surface_status`.** Lukker UA-11 akseptansekriterium 3
sitt siste gjenstående gap (D-163 §C(1)): eieren kunne se `situations`-domenepause via `executive.*`,
men IKKE den globale kill switch-/frys-/tilbakekall-tilstanden fra ÉN samlet overflate. Denne
handlingen komponerer `owner_controls.get_control_state` (den nye, durable/delte `@jarvis/owner-
controls`-pakken, D-164) OG `situations.get_pause_state` via TO nøstede `gateway.execute()`-kall -
SAMME komposisjonsdisiplin som §2 (`ExecutiveService` rører ALDRI `KillSwitch`/`OwnerControls`/
`DomainPauseRegistry` direkte). Svaret har TO EGNE, aldri-flettede felt: `owner_control` (global
sovereign-autoritet: kill switch + navngitte frosne connectorer/tilbakekalte credentials, hver med
reason/actor/changed_at) og `situation_domain_pauses` (domene-avgrenset UA-10-pausetilstand, KUN
domenenavn - `situations.get_pause_state` sin egen, pre-eksisterende kontrakt eksponerer ikke reason/
actor per domene, en dokumentert, IKKE-K1-relatert begrensning). Se `modules/executive/test/service-
transport.test.ts` gruppe G (5 tester: baseline, kill switch med reason/actor, frys+tilbakekall
samtidig, domenepause+connector-frys forblir distinkte lag, global KillSwitch nekter også denne
lesingen). Klasse A (les) - UENDRET av D-164/D-166 sitt selvgjenopprettings-unntak i `PolicyGateway`
(det unntaket gjelder KUN de tre navngitte `owner_controls`-handlingene
`get_control_state`/`deactivate_kill_switch`/`restore_credential` - sistnevnte lagt til av D-166 sin
B1-fiks, se der - ALDRI `executive.get_control_surface_status`: en aktiv kill switch nekter DENNE
lesingen også, se testen).

## §5. Persistens: NULL ny tabell

`ExecutiveService`/`ExecutiveTransport` gjør ZERO SQL. Attention-køen avledes DETERMINISTISK av
`situations.get_queue()` HVER gang - det finnes derfor ingen «cache» som kan bli stale, ingen
Q-20-erasure-registrering å legge til (ingen persondata lagres av denne pakken selv - `situations`
sin EGEN, allerede-registrerte erasure-plikt er uendret og fullt tilstrekkelig), ingen RLS å bygge
(RLS-grensen `situations` allerede håndhever er UENDRET arvet).

## §6. Sikkerhetsmodell (uendret, arvet - ikke re-implementert)

- **Identitet:** `ToolInvocationContext.identity` ALENE, ALDRI parametre (`.strict()`-skjemaer uten
  identitetsfelt - et forsøk på å oppgi `tenant_id`/`actor_person_id` i parametre avvises av
  `ToolGateway` som `invalid_parameters` FØR transporten nås - bevist i `service-transport.test.ts`).
- **Autoritet:** sovereign-eiermodus, KillSwitch, freeze, rate-limit - ALLE håndheves av DET NØSTEDE
  `situations.*`-kallets EGEN `PolicyGateway.authorize()`-runde, i tillegg til executive-lagets EGEN
  runde (dobbelt-gatet, aldri enkelt-gatet eller bypasset). Bevist: en global `KillSwitch.activate()`
  nekter LESING gjennom executive også, ikke bare mutasjon.
- **Tenant-/space-isolasjon:** RLS-grensen `situations` allerede håndhever - IKKE en egen
  policy-regel. En identitet for en tenant UTEN data får et gyldig, TOMT resultat (RLS - dette er
  IKKE et sikkerhetshull, se `service-transport.test.ts` sin eksplisitte, dokumenterte test av denne
  grensen: lesing er RLS-skopet, mutasjon er sovereign-owner-policy-gatet).
- **Cooldown ≠ undertrykkelse:** en nylig varslet situasjon nedvektes MARGINALT (§3), men forsvinner
  ALDRI fra køen - masterplanens «no duplicate spam»-krav gjelder SELVE VARSLINGEN (`situations`
  sin egen resuppress-mekanikk, uendret), ikke synligheten i attention-køen.

## §7. Bygges IKKE i denne sliceen (DEFERRED, eksplisitt - ikke glemt)

- **Executive dashboard/UI, MUTASJONS-DELEN.** D-199 leverte den LESE-KUN delen: `POST /executive/query`
  (hardkodet allowlist `get_attention_queue`/`get_control_surface_status`) + `GET /dashboard`
  (`apps/web/dashboard.html`, samme Ed25519-enhetsnøkkel-/grant-autentisering som `apps/web/index.html`)
  - viser attention-køen og kontrolloverflaten, INGEN handlingsknapper. De 15 mutasjonshandlingene
  (`pause_domain`/`resume_domain`/`resolve_situation`/`activate_kill_switch`/`deactivate_kill_switch`/
  `freeze_connector`/`unfreeze_connector`/`revoke_credential`/`restore_credential`/`revoke_device`/
  `enable_finance_kill_switch`/`disable_finance_kill_switch` m.fl.) forblir BEVISST utenfor
  `EXECUTIVE_QUERY_ACTIONS`-allowlistet - egen, senere, separat gjennomgått slice (bekreftelsesdialoger,
  klasse D-preflight-visning for eieren) som denne sliceen ikke forsøker å løse stille.
- **Business health / personal-domenekilder** (cash/revenue/pipeline/churn/marketing/schedule/travel/
  home/health-signaler). `situations` har ingen slik kilde koblet til ennå (kun `business_open_loops`-
  broen fra UA-10 P1) - når/hvis en slik kilde kobles til `situations` (D-64-disiplinen: KOMPOSISJON),
  vil den automatisk vises i attention-køen uten en executive-side-endring.
- **Decision log, scenarios, risk register, goals/OKRs, delegation board.** Masterplan-bullets uten en
  eksisterende kanonisk kilde i repoet ennå.
- **"Business impact"-vekting i ranking** - se §3.
- **Modell-assistert ranking/klassifisering.** P0 er 100% deterministisk (byggeordrenes eksplisitte
  krav: en modell autoriserer ALDRI en handling alene, og fail-closed deterministisk fallback er
  påkrevd DERSOM modellbruk introduseres - P0 introduserer INGEN modellbruk i det hele tatt).
- **Worker-wiring.** `worker-main.ts` kobler bevisst ikke til `executive` (eller til `situations` -
  se D-162 sitt eget funn i DECISIONS_AND_ASSUMPTIONS.md: dette er en PRE-EKSISTERENDE, dokumentert
  tilstand fra D-160, ikke noe DENNE sliceen skaper). Executive Mode har, som `situations`, ingen
  faktisk kaller i workerens prosess - å koble den inn nå ville vært utestet, ubrukt kode.
- **Host-akseptanse-harness/RUNTIME_GATES-rad (P0-scope, uendret).** P0 selv introduserer ZERO ny
  migrasjon, ZERO ny leverandør, ZERO ny runtime-avhengighet - se RUNTIME_GATES.md for gate-status og
  begrunnelse. K1 (D-164, egen slice) la til migrasjon 058 + en EGEN host-harness
  (`modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts`) for DEN sliceens
  `owner_controls.*`/durabilitets-gap - IKKE for `executive.*` sin egen kontrollflate, som forblir
  `HOST_ACCEPTANCE_REQUIRED=false` for alt utenom den nye `get_control_surface_status`-handlingen
  (som selv har ZERO ny migrasjon/credential - den leser KUN de to allerede-durable lagene).

## §8. Tester

- `modules/executive/test/ranking.test.ts` (21) - REN, ingen database: stage/priority-totalordning,
  determinisme, tie-break-stabilitet, replay-stabilitet, autoritetsstatus-felt, forklaringsfelt.
- `modules/executive/test/service-transport.test.ts` (17) - ekte embedded Postgres/RLS + ekte
  `ToolGateway`/`PolicyGateway`/`SituationEngine`/`DomainPauseRegistry`: komposisjon (ikke kopi) av
  `situations.get_queue`, tenant-isolasjon, memory-space-isolasjon, eier-autoritet, forfalsket
  identitet avvist, manglende invocation-context feiler lukket, global KillSwitch nekter lesing,
  pause/resume gjennom kanonisk `situations.*` (samme DB-tilstand, ingen duplikat-rad, ingen
  varsel-sideeffekt), pauset domene gjenspeiles korrekt i attention-køen, resolve/stale forsvinner
  fra køen, `get_attention_item` viser full begrunnelse + kilde-situation.
- `apps/api/test/executive-wiring.test.ts` (4) - komposisjons-rot-regresjonsvakt (SAMME mønster som
  `drive-runtime-wiring.test.ts`): `executiveToolDefinitions()` er INNI samme `additionalTools`-liste
  som `situationsToolDefinitions()`, `ExecutiveService` konstrueres med `toolGateway` (aldri motoren
  direkte), `worker-main.ts` importerer bevisst ikke `@jarvis/executive`.
- **K1-tillegg (D-164):** `service-transport.test.ts` gruppe G (5, se §4) beviser
  `get_control_surface_status` sin komposisjon. Selve `owner_controls.*`-namespacet (durabilitet,
  api-/worker-parity, autorisasjon, audit, restart) er dekket av EN EGEN suite,
  `modules/owner-controls/test/owner-control-authority.test.ts` (22) - se D-164, ikke duplisert her.

## §9. Akseptansekriterier - status etter P0

Masterplanens UA-11-akseptansekriterier:

1. **"Top priorities are source-backed and actionable."** Hvert attention-item peker til en
   `situation_id` (+ `source_open_loop_id`/`detection_key` der relevant) - INGEN item uten en
   kanonisk kilde. `action_kind` (`read`/`suggest`/`act`) sier eksplisitt hva som er handlingsbart.
2. **"Jarvis explains why something was prioritized or executed."** `explanation: string[]` +
   `recommended_next_action` på HVERT item - deterministisk avledet av de faktiske feltene som deltok
   i scoren (§3), aldri en skjult vektsum eller en modell-generert tekst.
3. **"Owner can stop/revoke/reconfigure any connector, provider, agent or autonomy domain from one
   control surface."** For P0: DELVIS - `executive.pause_domain`/`resume_domain` gir ÉN flate for
   Situation Engine-domener (komponerer `situations.*`). Connector-/provider-nivå kontroll
   (`OwnerControls`/`KillSwitch`) var fortsatt in-memory, per-prosess (D-163).
   **OPPDATERT 2026-09-17 (K1, D-164): gapet er nå IMPLEMENTERT.** `OwnerControls`/`KillSwitch` er
   durable+delt (migrasjon 058), eksponert som kanonisk `owner_controls.*` ToolGateway-namespace
   (aktivere/deaktivere kill switch, fryse/gjenåpne connector, tilbakekalle/gjenopprette credential -
   alle klasse C/D, sovereign-eier instant), OG `executive.get_control_surface_status` (§4) samler
   BÅDE dette laget og `situations`-domenepausen i ÉN lesing. Kriteriet er dermed oppfylt i kode/
   suite. **OPPDATERT 2026-09-18 (K1 host-akseptanse, D-165): kjernemekanismen (kill switch +
   connector-frys, api-/worker-cross-prosess-parity, restart-persistens, audit) er nå
   `PRODUCTION_VERIFIED` på ekte Windows/Docker Desktop-host (run_id `d7d5d246`, 10/10 PASS,
   `hard_fail=false`, EKTE `docker compose restart api worker`).** `executive.get_control_surface_status`/
   idempotency ble IKKE øvet av dette spesifikke host-harnesset og forblir suite/CI-proven, ikke
   overdrevet til host-proven - se RUNTIME_GATES.md for den eksplisitte distinksjonen. **OPPDATERT
   2026-09-18 (K1 B1-fiks, D-166): `revoke_credential`/`restore_credential` var IKKE bare "ikke øvet
   ennå" som antatt over - uavhengig arkitekt-review av PR #93 fant en REELL selv-lås-bug (`restore_credential`
   på den delte `credential_ref` ville blitt blokkert av sin egen tilbakekalt-credential-sjekk, ingen
   kanonisk gjenopprettingsvei). Fikset med en minimal, handlings-nivå selvgjenopprettings-mengde
   (`OWNER_CONTROLS_SELF_RECOVERY_ACTIONS`, delt av BÅDE `PolicyGateway`- og `ToolGateway`-gaten - se
   D-166 for samtidig-kill-switch-deadlock-analysen). Suite-bevist (30/30+809/809 grønne); host-harnesset
   utvidet. **OPPDATERT 2026-09-18 (host-rerun #1, D-167): Tobias kjørte det utvidede harnesset på ekte
   host (HEAD `ca167dba...`) - B1 sin funksjonalitet var `PASS` (selvgjenoppretting/samtidig-deadlock/
   cleanup), men harnessets EGEN, sekundære audit-bevis-spørring (en håndplukket "siste 10 rader"-grense
   satt før D-166 fantes) mistet den opprinnelige aktiveringsraden etter at D-166 la til flere
   `owner_controls`-kall enn grensen tålte - IKKE en produksjonsfeil, se D-167. Rettet med en
   run-avgrenset (`session_id`+vannmerke, ingen `LIMIT`) spørring i ny
   `modules/owner-controls/src/audit-evidence.ts`.** **OPPDATERT 2026-09-18 (host-rerun #2 + merge,
   D-168): Tobias kjørte det D-167-fiksede harnesset PÅ NYTT på eksakt HEAD `9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25`
   (samme HEAD en uavhengig arkitekt-review, `5247323973`, RESULT=PASS, reviewet) - ALLE K1-markører
   PASS inkl. `k1_audit_evidence=PASS` (`hard_fail=false`, run-avgrenset audit-bevis `audit_rows=15`,
   `deactivate_count=2`/`restore_count=2` - BÅDE selvgjenoppretting OG samtidig-deadlock-gjenoppretting
   bekreftet kjørt gjennom kanonisk `ToolGateway` på EKTE host). Arkitekt-review PASS + Tobias sin
   eksplisitte merge-closeout-ordre → PR #93 MERGET (`MERGE_SHA=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`),
   postmerge CI grønn.** Status for DENNE delkapabiliteten (og HELE UA-11 akseptansekriterium 3): NÅ
   `PRODUCTION_VERIFIED`, `HOST_ACCEPTANCE_REQUIRED=false`. D-165 sin kjernemekanisme-`PRODUCTION_VERIFIED`
   var allerede gyldig og er UPÅVIRKET; denne oppdateringen utvider samme status til B1-selvgjenopprettingen
   OG audit-beviset. `/infra/pause` (D-104, `InfraExecutionGate`) forblir en SEPARAT, allerede-dokumentert,
   snevrere mekanisme - fersk-verifisert IKKE en del av dette gapet (D-164 F), ikke rørt av K1.
   **RETTET 2026-09-18 (D-171, uavhengig arkitekt-re-review `5248461491`, BLOKKER B2):** paastanden
   "HELE UA-11 akseptansekriterium 3 NÅ PRODUCTION_VERIFIED" over var OVERCLAIMED for selve "ÉN
   kontrolloverflate"-delen av kriteriet. Fersk kildekode-audit av `modules/executive/src/transport.ts`
   viser at `executive.*` KUN videresender lesing (`get_control_surface_status`) og
   `situations.pause_domain`/`resume_domain`/`resolve_situation` - `executive.*` inneholder INGEN
   videresending for `owner_controls.activate_kill_switch`/`deactivate_kill_switch`/`freeze_connector`/
   `unfreeze_connector`/`revoke_credential`/`restore_credential`. Kriteriets ordlyd ("owner can
   stop/revoke/reconfigure any connector, provider, agent or autonomy domain from ONE control
   surface") krever MUTASJON fra samme flate, ikke bare lesing av kombinert status - dette er i dag
   SPLITTET mellom `owner_controls.*` (mutasjon) og `executive.*` (lesing + kun
   `situations`-mutasjon). K1 sin underliggende kjernemekanisme (kalt DIREKTE via `owner_controls.*`)
   FORBLIR `PRODUCTION_VERIFIED` - denne rettelsen gjelder KUN paastanden om at ÉN flate allerede
   dekker MUTASJON for alle fire navngitte mål (connector/provider/agent/autonomy-domene). Rettet
   status: **`PARTIAL` - lesing samlet, mutasjon SPLITTET.** Valgt neste slice (D-171, IKKE
   implementert i PR #94): "Samlet eier-kontrolloverflate, mutasjonsfullføring (B2)" - se
   `DECISIONS_AND_ASSUMPTIONS.md` D-171 for full mål-for-mål-kartlegging.

   **IMPLEMENTERT 2026-09-18 (D-174):** `executive.*` fikk ti nye videresendinger
   (`activate_kill_switch`/`deactivate_kill_switch`/`freeze_connector`/`unfreeze_connector`/
   `revoke_credential`/`restore_credential`/`revoke_device`/`enable_finance_kill_switch`/
   `disable_finance_kill_switch`/`get_finance_kill_switch`) - kriteriets ordlyd ("owner can
   stop/revoke/reconfigure any connector, provider, agent or autonomy domain from ONE control
   surface") er nå oppfylt for BÅDE lesing OG mutasjon, for ALLE syv kapittel-28-mål (inkl. enhet, via
   den nye `revoke_device`, og finansdomene). Status rettet fra `PARTIAL` til **`FULFILLED (suite-
   verified; HOST_ACCEPTANCE_STATUS=PENDING)`** - K1/B1 sin kjernemekanisme (kalt DIREKTE via
   `owner_controls.*`) forblir `PRODUCTION_VERIFIED`, uendret; DEN NYE `executive.*`-flaten er
   suite-bevist (ny "H"-testblokk i `service-transport.test.ts`, fullt koblet lokal stack mot ekte
   `PolicyGateway`/`ToolGateway`) men IKKE ennå host-bevist (nytt script
   `d174-executive-control-surface-live.ts`+`-host-run.ts`, klart for Tobias). B1
   selvgjenopprettingsgaten (D-166) utvidet til `tool_id === "executive"` - se D-174 i
   `DECISIONS_AND_ASSUMPTIONS.md` for full begrunnelse.

   **RETTET 2026-09-18 (D-175, arkitekt-review 5250409538, BLOKKER B4):** D-174 sin `revoke_device` tok
   feilaktig et FRITT kaller-oppgitt `tenant_id`-parameter (feilaktig analogi til det tenant-frie
   `owner_control_state` som `credential_ref`/`connector_id` treffer) - et REELT cross-tenant-hull mot det
   RLS-scopede (`FORCE ROW LEVEL SECURITY`) `session_grants`/`devices`. RETTET: mål-tenanten er nå
   UBETINGET `identity.tenant_id` (INGEN `tenant_id`-felt i skjemaet); mål-enheten kan fortsatt tilhøre en
   ANNEN PERSON/delegat i SAMME tenant; en enhet i en ANNEN tenant feiler LUKKET (`DeviceNotFoundError`),
   ALDRI et stille `ok:true`/`revoked_grants:0`. Se D-175 for full begrunnelse/testevidens.

   **RETTET 2026-09-18 (D-176, arkitekt-re-review 5251073737, BLOKKER B5):** `executive.
   get_control_surface_status` selv ble AVSLÅTT av NØYAKTIG kill-switch-aktiv-/tilbakekalt-credential-
   gaten den skulle la eieren SE FORBI - D-174/D-175 sin `tool_id === "executive"`-utvidelse antok
   feilaktig identiske handlingsnavn (`get_control_surface_status` ≠ `get_control_state`), OG de to
   nøstede lesingene den komponerer (`situations.get_pause_state`/`finance.get_kill_switch`) var
   HELLER IKKE unntatt. Ny `isSelfRecoveryAction(toolId, action)` erstatter unionen med en eksplisitt
   per-(tool_id,action)-mapping for alle fire tool_id-ene - fortsatt like smalt, INGEN mutasjon lagt
   til. Se D-176 for full begrunnelse/testevidens.

   **RETTET 2026-09-18 (D-177, arkitekt-re-review 5252077633, BLOKKER B6):** D-176 sitt host-
   akseptanse-harness (seksjon 4b i `d174-executive-control-surface-live.ts`) satte opp "begge låser
   samtidig"-forutsetningen via en sekvensiell `executive.activate_kill_switch`+`executive.
   revoke_credential`-rekkefølge - STRUKTURELT UMULIG (hver av dem nekter den andre via delt
   `BUSINESS_INTERNAL_CREDENTIAL_REF`), samme bug-klasse testsuiten allerede var rettet for i D-176
   selv, men ikke anvendt på host-scriptet før denne re-reviewen. RETTET: begge lås-tilstandene settes
   nå DIREKTE via det durable laget (`stack.killSwitch.activateDurable(...)`/`stack.ownerControls.
   revokeCredentialDurable(...)`); selve lesingen (`executive.get_control_surface_status`)/
   gjenopprettingen under test forblir via `executive.*`. Se D-177 for full begrunnelse/testevidens.

   **RETTET 2026-09-18 (D-178, arkitekt-host-akseptanse-review 5252418219, BLOKKER B7):** FØRSTE
   EKTE Windows-host-kjøring (`run_id=d265a028`) av harnesset feilet (`hard_fail=true`) - ALT ANNET
   (inkl. B4/B5/B6) var PASS, men enhets-tilbakekallings-fikstur/-lesing (seksjon 9/10) gjorde rå
   `sidePool`/`freshPool`-spørringer mot RLS-beskyttede `devices`/`sessions`/`session_grants`
   (FORCE ROW LEVEL SECURITY) UTEN tenant-kontekst - avslått under den ekte `jarvis_runtime`-rollen
   FØR selve `executive.revoke_device`-kallet under test ble nådd. RETTET: fikstur/lesing bruker nå
   den eksisterende `withTenantTransaction()`-hjelperen (`@jarvis/core`); `executive.revoke_device`-
   kallet uendret; `adminPool` bevisst IKKE brukt for fikstur/lesing. `INTERNAL_BUILD_COMPLETE=false`
   til en FERSK host-kjøring beviser fiksen. Se D-178 for full begrunnelse/testevidens.

   **LIVE-BEVIST 2026-09-18 (D-179, arkitekt-host-akseptanse-review 5253069695, RESULT=PASS):** Tobias
   kjørte det D-178-rettede harnesset PÅ NYTT, faktisk to ganger - begge PASS (`run_id=fc9b99e5` og
   den avsluttende `run_id=bfca277d`, BEGGE `hard_fail=false`). ALLE markører PASS, inkl.
   `executive.revoke_device` (`grants_before=1`, `revoked_grants=1`, tenant bundet til
   `tenant-personal`) og ferskinstans-holdbarhetslesingen. `HOST_ACCEPTANCE_STATUS=PASS` (RETTET fra
   `REQUIRES_RERUN`), `INTERNAL_BUILD_COMPLETE=true` (RETTET fra `false`). `SOVEREIGN_COMPLETE=false`
   FORBLIR UENDRET. Se D-179 for full begrunnelse/testevidens.
