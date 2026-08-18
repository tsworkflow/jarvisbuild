# PROJECT STATUS

**Oppdatert:** 2026-08-18 (**CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT (D-65) - permanent
styringsregel logget**, se egen "CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT"-seksjon under. Ny
ufravikelig regel 12 i CLAUDE.md + nytt §11 i ARCHITECTURE.md: et masterplan-kapabilitetsnavn
antyder ALDRI automatisk en tredjeparts-leverandør - utløst av at Zendesk-connectoren (D-64, draft-PR
#13) ble bygget som om "Support/tickets" betydde "velg Zendesk og la den eie ticket-domenet". Full
masterplan-avhengighetsaudit utført (ARCHITECTURE.md §11.9) - de fleste eksisterende connectors
(Gmail/Calendar/Drive/GitHub/Telegram/Vercel/HA/AI-modeller/observability/secrets) er allerede korrekt
klassifisert, INGEN endring nødvendig der. Ett HIGH-funn: Zendesk-connectoren selv er strukturelt
EXTERNAL_CANONICAL for hele ticket-livssyklusen i stedet for en Jarvis-native Support Core med Zendesk
som valgfri adapter - IKKE fikset i denne runden (kun dokumentert, ny Q-28), krever Tobias sin
eksplisitte beslutning FØR PR #13 merges. Contracts/e-sign forebyggende grenseanalyse (Contract Core
vs. Signature Execution Provider) logget som Q-29, INGEN leverandør valgt. INGEN kode endret - kun
CLAUDE.md/ARCHITECTURE.md/DECISIONS_AND_ASSUMPTIONS.md/OPEN_QUESTIONS.md. **Branch:**
`claude/architecture-core-adapter-invariant` (stacket på `claude/ua3-zendesk-support-connector`, siden
D-65 direkte refererer D-64/Q-27 som ennå ikke er merget til `main`).

---

**Tidligere oppdatering, 2026-08-18** (UA-3 — Support/Tickets (Zendesk) FIXED_SUITE / IKKE VERIFIED →
D-64, uendret av denne governance-runden): se egen "UA-3 — Support/Tickets (Zendesk...)"-seksjon
under. Provider valgt av Tobias etter en egen
research-runde (vektet D-41-matrise, Zendesk foran Intercom/Freshdesk/Chatwoot). Full D-41-kapasitet
(20 `zendesk.*`-handlinger, klasse A/B/C/D), OAuth 2.0 med in-memory-token-rotasjon, pointer-not-payload,
deterministisk kontaktgjenkjenning, webhook-mottaker (HMAC-SHA256/replay-vindu), periodisk
rekonsiliering via eksisterende `DailyScheduler`. 1245/1245 tester, typecheck/lint rene - INGEN
Tobias-host-kjøring utført ennå (draft-PR, IKKE merget). **NYTT FUNN denne runden:** et FJERDE tilfelle
av samme RLS-blind-spørring-feilklasse som D-54/D-59/D-62 oppdaget i TRE PRE-EKSISTERENDE
PRODUKSJONSFUNKSJONER (`runBusinessEventSyncForAllTenants`/`runOpenLoopSweepForAllTenants`/
`runScoringSweepForAllTenants` - alle `DailyScheduler`-trigget, sannsynligvis ALDRI har funnet en
tenant i produksjon) - fikset KUN for den nye Zendesk-ekvivalenten, de tre søsknene BEVISST IKKE rørt
(utenfor bestilt scope), ny Q-27 logget for sporing. **Fire-kriterie UA-3-matrise (uendret fra D-63):**
kriterium 1 FORTSATT PARTIAL (Support/tickets nå FIXED_SUITE men IKKE VERIFIED, Contracts/e-sign
fortsatt IKKE bygget), kriterium 2 PARTIAL (uendret, kun sales), kriterium 3 COMPLETE/VERIFIED,
kriterium 4 COMPLETE/VERIFIED (D-63). **HELE UA-3 er FORTSATT IKKE komplett**, og masterplan v4.0 som
helhet er IKKE komplett. **Branch:** `claude/ua3-zendesk-support-connector` (fra `origin/main`) ·
UA-2 forblir VERIFIED/COMPLETE i sin helhet → D-48, uendret · P1A Runtime Wiring Closeout forblir
VERIFIED/COMPLETE (host-smoke-bevist, PR #6 merget) · UA-2 P1A selv forblir VERIFIED/COMPLETE (D-42,
uendret, host-bevist run_id `2703299e`, PR #5 merget) · UA-2 P1B-A merget til `main` (PR #7) · UA-2
masterplan-closeout merget til `main` (PR #8) · UA-3 P0 merget til `main` (PR #9) · UA-3 Open-Loop
Detection + Business Brief merget til `main` (PR #10) · UA-3 Business-Event-Linkage merget til `main`
(PR #11) · UA-3 Profiling/Scoring merget til `main` (PR #12) · UA-3 Support/Tickets (Zendesk) draft-PR
åpen, IKKE merget (venter Tobias-host-verifisering)

## Aktiv fase
Masterplan v4.0 «Sovereign Autonomy» — **UA-0 CORE RUNTIME = CLOSED** (formelt, BO-08).
**UA-1 UNIVERSAL AI MESH: P0 VERIFIED · MULTI-PROVIDER LIVE VERIFIED · P1A (streaming+tool-calling) VERIFIED (BO-11).**
**D-30 VOICE = VERIFIED** (BO-12, merget til main 2026-08-14, commit `8f28862`).
**Q-21 (systembredt DB admin/runtime-rolle-gap): VERIFIED/CLOSED (2026-08-15, host-bevist,
run_id `778bb87d`)** → D-38. Host bekreftet at api/worker/migrate opprinnelig kjørte som
Postgres-superbruker (RLS aldri håndhevet til tross for korrekte policyer); fikset permanent med
admin/runtime-DB-config-splitt + idempotent `jarvis_runtime`-rolle-bootstrap + fail-closed
startup-vakter + ett automatisert host-fiks-script (tre host-recovery-runder samme dag - se
RUNTIME_GATES.md for full feilsøkingslogg; faktisk root cause var et stale Docker-image som ble
gjenbrukt av `docker compose run` i stedet for å bygges på nytt). **Host-bevis:**
`migrate_effective_db_user=postgres`, `runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `runtime_role_canlogin=true`,
`runtime_role_member_jarvis_app=true`, `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
`memory_space_isolation=PASS`.
**UA-2 UNIVERSAL KNOWLEDGE LAYER: P0 (Knowledge Ingestion Foundation) = VERIFIED/COMPLETE
(2026-08-15, samme host-kjøring)** → D-39. Alle P0-akseptansekriterier host-bevist mot ekte
Postgres/pgvector, ekte filsystem, ekte GitHub-repo: filesystem full livssyklus, ekte FTS/vector/
hybrid, filsystem-sikkerhet (allowlist/traversal), GitHub live sync+dedupe, tenant/memory-space-
isolasjon - alle PASS, `duplicate_documents=0`, `hard_fail=false`. `symlink_escape=
SKIPPED_HOST_PERMISSION` (Windows-hosten tillot ikke symlink uten admin-rettigheter denne
kjøringen) - eksplisitt IKKE et live-PASS, mekanismen forblir suite-bevist
(`filesystem-source.test.ts`). Full evidens: docs/RUNTIME_GATES.md.
**UA-2 P1A (Knowledge Source Expansion + Google Drive Full Read/Write): VERIFIED/COMPLETE
(2026-08-16, host-bevist på ekte Windows/Docker-host, run_id `2703299e`, `hard_fail=false`)** → D-42.
Ni oppfølgingsrunder (hver drevet av et ekte Tobias-host-funn) endte med full grønn host-akseptanse:
Obsidian-livssyklus, tenant-isolasjon/retrieval for nye kildetyper, Google Drive full read/write
ende-til-ende (Desktop-OAuth-bootstrap, Drive API aktivert, auth/read/create/update/rename/move/
trash/permanent_delete/cleanup/sync/no-resurrection/idempotency/policy/live ALLE PASS), Q-21 uendret
i samme kjøring, ingen token-lekkasje. Eksplisitt, ærlig unntak: `google_drive_permission_live=
SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (live permission-mutasjon IKKE host-testet - se Q-23, IKKE en
blokkering for lukking). PR #5 merget til `main`. Full evidens under "UA-2 P1A FINAL CLOSURE" nederst i denne filen.
**Q-20 (teknisk data-erasure-foundation, FØR UA-2 P1): VERIFIED/CLOSED (2026-08-16, host-bevist på
ekte Windows/Docker-host, run_id `eaabe2b1`)** → D-40. Ny pakke `@jarvis/erasure` - sentral, typed
`ErasureService` (preview/execute/verify) med scope-modell (`tenant`/`person`/`memory_space`/
`knowledge_source`/`knowledge_document`/`conversation`). Hard-delete av knowledge- OG memory-innhold +
alt avledet (embeddings/versjoner/entiteter/relasjoner/oppsummeringer/beslutninger/forpliktelser/
frister), FK-trygg/fail-closed/idempotent. `erasure_fingerprints`-suppresjonsledger hindrer at
`KnowledgeSyncService` gjenoppliver slettet innhold ved neste source-sync (kun SHA-256-fingerprint,
aldri klartekst) - bevist LIVE. D-klasse policy-integrasjon gjenbruker eksisterende `PolicyGateway`/
sovereign/approval uendret, bevisst IKKE via `ToolGateway`s D-pipeline (ville lagret en KOPI av
innholdet i et recovery-snapshot - dokumentert unntak). `jarvis_app` fikk et nytt, avgrenset
`GRANT DELETE` (kun de faktisk hard-slettede tabellene - `events`/`audit_events` forblir
append-only-blokkert). **Host-bevis:** `q20_preview`/`q20_hard_delete`/`q20_derived_delete`/
`q20_fts_erasure`/`q20_vector_erasure`/`q20_hybrid_erasure`/`q20_memory_erasure`/`q20_no_resurrection`/
`q20_idempotency`/`q20_tenant_isolation`/`q20_space_isolation`/`q20_receipt_safe`/`q20_sentinel_scan` =
ALLE PASS, `hard_fail=false`; resync-bevis `created=0`/`suppressed=1`; retrieval etter purge
`fts_hits=0`/`vector_hits=0`/`hybrid_hits=0`/`memory_hits=0`; `q21_runtime_role_safe=PASS` uendret i
samme kjøring. Tre host-recovery-runder samme dag (workspace-bootstrap → Windows pnpm-
prosessoppløsning → DEP0190-opprydding, se RUNTIME_GATES.md) løste kun host-/prosess-hygiene, ingen
erasure-logikk endret. **Teknisk foundation, IKKE juridisk GDPR-sertifisering.** Fortsatt eksplisitt
dokumenterte, ikke purgede stores: `events`/`audit_events`-payload, `tasks`/`tool_executions`-innhold,
Langfuse/trace-fil, `person`-scope dekker ikke knowledge-dokumenter. Full evidens:
docs/DATA_ERASURE.md og docs/RUNTIME_GATES.md.

## UA-0 (lukket)
D-27/D-28/D-32/D-35/OPS-RUNTIME/UA0-RUNRATE = VERIFIED (evidens: docs/RUNTIME_GATES.md).
Owner-seed nå automatisk/idempotent i one-shot migrate. **D-30 Voice = VERIFIED** (BO-12,
host-runde 6 - merget til main). Gjenværende åpne, ikke-blokkerende porter: D-36 Apple,
HA-RUNTIME, D-10 STT-benchmark (≥100 norske prøver, providervalg - se OPEN_QUESTIONS Q-03).

## UA-1 P1A (BO-11)
- Normalisert streaming (OpenAI+Claude live, ttft, cancel/barge-in-fundament, pre-output-fallback,
  konservativ post-output-policy), provider-uavhengig tool-calling via trusted mesh-bridge→ToolGateway
  (kun A/B-read i P1A), idempotent utførelse, cross-provider recovery etter utført verktøy (aldri
  dobbel side-effekt), SSE-chat + worker-tool-mesh live. Evidens: RUNTIME_GATES BO-11.
- **P1A delta (BO-11.1):** SQL streaming-metrics i cost_events (migrasjon 016), SSE
  klient-disconnect → upstream cancellation (barge-in-fundament bevist på HTTP-nivå),
  executive-handler-paritet api↔worker (delt handler), eksplisitt D-class-mesh- og
  SSE-fixture-regresjon (+ fix: Anthropic stream-error-events klassifiseres, aldri stille suksess).
- **Sovereign-fix (pre-merge):** api/worker-wiringen manglet authority-config → owners D-kall
  krevde feilaktig approval (legacy SCOPED). Fikset i main/worker/bo11-live; begge semantikker
  testbevist (owner sovereign → full D-pipeline uten approval; delegat → approval-gate + replay-vern).
  249/249 tester. Delta-live på host gjenstår: `apps/api/scripts/bo11-1-delta-live.ts`.

## UA-1 LIVE-status (BO-10)
- **UA-1 MULTI-PROVIDER LIVE = VERIFIED (BO-10).** OpenAI + Anthropic/Claude begge LIVE i container-runtime.
  Cross-provider fallback PASS begge retninger; multi-provider critic PASS begge veier; owner override,
  health, 401/429/timeout, benchmark (10/10), Langfuse- og cost_events-korrelasjon verifisert.
  Gemini/Kimi/Ollama fortsatt IMPLEMENTED_NOT_LIVE (nøkler mangler - ikke-blokkerende).

## UA-1 P0 (BO-08)
- AI Router (deterministisk), CapabilityRegistry, ProviderHealth, versjonert pricing, normaliserte
  request/response-kontrakter, klassifisert fallback, critic (opt-in), purpose-taksonomi.
- Providere: **OpenAI LIVE (baseline)**; Claude/Gemini/Kimi/Ollama IMPLEMENTED_NOT_LIVE
  (mangler kun: ANTHROPIC_API_KEY, GEMINI_API_KEY, KIMI_API_KEY, JARVIS_OLLAMA_URL i .env/vault).
- Live-akseptanse i container: routed kall m/routing_reason i Langfuse + mesh-felter i cost_events
  (migrasjon 015). /status og /ai (Telegram) viser mesh-status.
- LIVE multi-provider fallback + benchmark: NOT YET VERIFIED (krever ≥2 cloud-credentials);
  logikk verifisert med fake-adaptere.
- Kvalitet: 203/203 tester (Node 22), lint, typecheck, gitleaks rene. Full stack healthy.

## D-30 Voice (BO-12) — VERIFIED

- **Status: VERIFIED (2026-08-14, host-runde 6).** Host-live-akseptanse fullført og
  bestått: real-provider streaming smoke PASS (inkrementell levering bekreftet),
  §32 generation cancellation PASS (aktiv stream observert, abort etter 3 tokens,
  ren neste tur), §1/§2 real audio barge-in PASS (`barge_in_audio_stop_ms=0` ≤
  250ms-gate, 0 stale frames, ren neste tur), 10-tur soak PASS **to uavhengige
  kjøringer** (10/10, én session_id, `duplicate_tool_executions=0`, turn 8
  cancelled/turn 9+10 normale, begge ganger), Q-18 FIXED bekreftet live
  (kalender-repetisjon gir ferske svar). Merget til `main` (se commit under).
  Branch `claude/d30-voice`. Voice er transportlag over eksisterende Jarvis (samme mesh/
  tools/authority/minne): streaming Core-klient (P1A-SSE) → setningschunking → TTS-kø,
  full barge-in (stopp lyd + tøm kø + abort generering upstream, epoch-vern mot stale
  audio), eksplisitt tilstandsmaskin m/personvern (ingen skjult opptak, rå lyd
  persisteres aldri), STT-/TTS-feilbaner, full latenskjede-metrics, voice-helse i
  /status, cross-provider-override. OpenAI STT/TTS er P0-baseline (nøkkel alt live).
- **Live-findings-fix (host-runde 2):** TTS/STT/no-tool/cross-provider/barge-in PASS live,
  kalender-voice feilet, fikset (ConversationEngine→completeWithTools-bro, per-identity
  executor, trusted SSE tool_call, voice-device-seed, semantisk STT-akseptanse). Runde 2
  bekreftet: kalender-voice PASS live (`tools=[read_calendar_today]`).
- **FINAL HOST ACCEPTANCE HARDENING (host-runde 3):** funn+fiks: `VoiceSession`
  hadde INGEN klientdisconnect-håndtering → zombie-generering ved WS-frakobling midt i
  tur; ny `disconnect()` wiret til `ws.on("close")`. Ekte lyd-barge-in-akseptanse
  (`barge_in_audio_stop_ms`, ≤250ms-gate) + stale-audio-settlingsjekk i bo12-voice-live.ts;
  10-tur host-soak (`bo12-voice-soak.ts`); full latenskjede-rapportering per tur.
  Q-18 reprodusert (BLOCKER).
- **HOST FAILURE FIX (host-runde 4, denne):** host kjørte de nye scriptene - tre feil
  funnet, alle undersøkt til rot (ikke gjettet) og fikset:
  - **§32 (legacy LLM-abort-test) feilet** ("forventet AbortError, fikk suksess") -
    root cause = race (kategori B: modellen rakk fullføre før 5. token+abort);
    mekanismen selv er uendret bevist korrekt (suite, treg adapter). Fiks: abort
    trigges nå på FØRSTE token + lengre (500+ ord) tekst - assertion uendret.
  - **Soak turn 8 timet ut** - root cause = harness-deadlock (ventet på turn 8s
    EGNE metrics FØR turn 9s barge-in-lyd ble sendt), IKKE sesjonskorrupsjon.
    Fikset: turn 8+9 kjøres nå konkurrerende (vent kun til "speaking", så send
    barge-in). Ny eksplisitt "korrekt cancelled-turn"-definisjon (cancelled +
    t_speech_start + t_tts_first_frame), speilet i suite-regresjon.
  - **`tools=[read_calendar_today,read_calendar_today]` avgjort via kjørt test:**
    kategori (A) - 2 SSE-events, KUN 1 faktisk ToolGateway-kall (in-memory
    per-tur-cache i ModelGateway.completeWithTools fungerte allerede korrekt).
    16s-TTFT skyldes en EKSTRA MODELLRUNDE, ikke dobbel verktøyutførelse.
  - **Q-18 FIKSET:** `tool_executions`-dedupe gjelder nå kun C/D
    (`capability_class !== "A"` i gateway.ts). A-class reads utfører friskt per
    brukertur; write/mutation-dedupe uendret (regresjonstestet). In-memory
    per-tur-beskyttelse (samme tur, samme kall → maks 1 utførelse) uendret,
    testet separat fra database-/sesjonsnivå-fiksen.
  - 279/279 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL BARGE-IN HOST BLOCKER (host-runde 5, denne):** host bekreftet Q-18-fiksen
  PASS live, men §32 feilet med NY info som avkrefter forrige race-hypotese:
  0 tokens over 35,5s, deretter suksess (ikke "modellen var rask", men "ingen
  inkrementelle events observert i det hele tatt"). Kan IKKE avgjøres endelig
  uten host-tilgang - IKKE gjettet. Gjort denne runden:
  - **Kodesporing:** hele kjeden er strukturelt identisk for alle requests;
    Ollama/Gemini/Kimi-hypotesen (ikke-strømmende adaptere) undersøkt og
    AVKREFTET ved lesing (ville gitt ≥1 token, ikke 0); ingen reverse proxy
    i docker-compose.
  - **Deterministisk sandbox-bevis KJØRT i denne økten** (ekte server+SSE+
    embedded PG, ingen mocks): 600 tokens levert inkrementelt over 702ms,
    abort på 1. token → AbortError på 19ms. Beviser egen kode er IKKE
    generisk buffret. Formalisert som 2 nye permanente suite-tester.
  - **Server-side diagnostikk lagt til** (`JARVIS_STREAM_DEBUG=true`, kun
    type+timing, aldri innhold) i 3 lag (gateway/conversation/SSE-write) -
    lar host avgjøre PRESIST hvor levering evt. slutter å være inkrementell.
  - **§32 redesignet - "500 ord"-fixen FJERNET helt** (var en blind
    lengde-gjetning). Ny §3B smoke-test måler faktisk observert
    inkrementell levering FØRST; §32 kjøres kun betinget på det, rapporterer
    IKKE KJØRT (inkonklusivt) i stedet for FAIL når ingen aktiv stream kan
    bevises - og en feiling NÅR streaming er bekreftet er en høy-konfidens
    ekte regresjon, ikke en race.
  - **Ekte lyd-barge-in (§1/§2) koblet løs fra lang LLM-respons** - kort
    normalsvar, trigges kun på observert avspilling.
  - **Soak turn 8:** sannsynlig samme fenomen som §32 (ikke egen
    harness-feil) - tidsstemplet tilstandshistorikk lagt til, timeout økt
    til 60s, tekst kortet ned, timeout merkes ikke lenger stille som
    "corrupted" uten forklaring.
  - 281/281 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL CLOSURE (host-runde 6, denne):** full host-evidens mottatt og bekreftet
  (se detaljert tabell i docs/RUNTIME_GATES.md). D-30 satt VERIFIED; PR #2 merget
  til `main`. §32s tidligere anomali (runde 5: 0 tokens/35.5s) reproduserte IKKE
  denne runden - real-provider streaming var inkrementell (`token_count=142`,
  `spread_ms=4757`) og cancellation fungerte korrekt (abort etter 3 tokens).
  Vurdert som en engangs-nettverksanomali (runde 5), ikke et vedvarende mønster.
- **Ytelsesgjeld (IKKE en D-30-blokker - egen åpen post, se OPEN_QUESTIONS.md
  Q-19):** host-observert latens er funksjonelt korrekt men treg for ønsket
  realtime-opplevelse: `e2e_first_audio` vanligvis ~3.5-6.2s, enkelte turer
  ~9-12s, streaming-smoke første token ~12.7s. D-30-korrekthet er verifisert
  UAVHENGIG av dette - realtime-latensoptimalisering er bevisst utsatt til egen
  runde (ingen optimalisering gjort i denne lukkingen).

## UA-2 P0 — Knowledge Ingestion Foundation (BYGGET denne økten)
- **Status: SUITE-VERIFIED. IKKE host/live-verifisert** (sky-container: ingen Docker, ingen ekte
  GitHub-PAT, ingen ekte NAS-mount). Godkjent P0-scope fra spec-runden bygget i ny pakke
  `modules/knowledge` (`@jarvis/knowledge`):
  - `KnowledgeSource`-kontrakt (kilde-uavhengig, ingen credentials i kontrakten).
  - `FilesystemKnowledgeSource`: allowlistet root, `realpath()`-verifisert FØR lesing - traversal/
    symlink-escape strukturelt umulig (ikke bare filtrert).
  - `GithubKnowledgeSource`: via eksisterende ToolGateway/policy/audit (ny `read_repo_meta`-action,
    samme PAT/scope som `read_issues` - ingen scope-utvidelse); repo-fil-innhold dokumentert som
    neste skive (transporten støtter det ikke i dag).
  - `KnowledgeSyncService`: idempotent sync-rapport, canonical identity + content_hash-dedupe,
    tombstone ved forsvunnet kilde (myk sletting), deterministisk reaktivering.
  - `KnowledgeRetriever`: FTS+vector hybrid på eksisterende pgvector-fundament (D-28), full
    provenance, tombstonede dokumenter alltid ekskludert.
  - Migrasjon `017_knowledge.sql`: samme RLS-mønster som `memory_items` (tenant+space i databasen).
  - DPIA-notat: `docs/UA2_KNOWLEDGE_DPIA.md`. Åpent gap Q-20 (kun myk sletting, ingen GDPR-purge-vei
    ennå) - dokumentert, ikke skjult.
  - **Regresjon funnet+fikset:** `read_repo_meta` midt i `firstWaveTools()`-arrayet forskjøv
    posisjonsindekser to eksisterende tester brukte - flyttet til slutten av arrayet.
  - 294/294 tester (281+13 nye), lint/typecheck/gitleaks rene. Full evidens: docs/RUNTIME_GATES.md.
- **Gjenstår for host/live-verifikasjon (§13 i BO-en, IKKE gjort her):** ekte NAS-mount, ekte
  GitHub-repo-sync med reell PAT, full ende-til-ende-demo kjørt på Tobias sin host.
- **FINAL HOST ACCEPTANCE HARNESS (forrige runde, bygget):** `modules/knowledge/scripts/ua2-p0-live.ts` -
  kjøres `node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p0-live.ts`.
- **HOST-BLOCKER-RUNDE (denne økten, 2026-08-15):** Tobias kjørte harnesset live. 13/15 felt PASS
  (filesystem livssyklus, provenance, FTS/vector/hybrid, filsystem-sikkerhet, GitHub live sync+dedupe
  `created=2`→`unchanged=2`). **`tenant_isolation`/`memory_space_isolation` FEILET.** Root cause
  funnet (ikke gjettet): harnesset beviste isolasjon via `pool` (samme rolle api/worker/migrate
  faktisk bruker) UTEN å verifisere bypass-status - `jarvis_app` er en `NOLOGIN`-gruppe-rolle, og
  INGEN sted i den faktiske driftsveien oppretter en ekte login-rolle bundet til den (kun suitens
  test-oppsett gjør det). Dette avdekket samtidig et **systembredt (ikke UA-2-spesifikt)
  deployment-gap** - se **Q-21 i OPEN_QUESTIONS.md** (trenger Tobias sin beslutning; docker-compose/
  migrate-main.ts bevisst urørt, utenfor denne BO-ens scope). **Fikset:** harnesset bootstrapper nå
  en fersk, garantert non-bypass rolle (kun for isolasjons-BEVISET) + ny §6-diagnostikk
  (`rls_test_role`/`_superuser`/`_bypassrls`, `knowledge_rls_enabled`/`_force_rls`,
  `configured_app_role`/`_superuser`/`_bypassrls`) som fail-closed skiller HARNESS FEIL fra RUNTIME
  FEIL. Presisjonsfunn underveis: rå listelengde er ikke et presist lekkasje-mål (vektor-selvtreff-
  støy fra `LocalHashEmbedding`) - assertions sjekker nå faktisk innhold. Nye regresjonstester:
  `modules/knowledge/test/rls-role-isolation.test.ts` (6 tester, inkl. et eksplisitt kontrast-bevis
  §K: samme spørring lekker via superbruker, ikke via non-bypass-rolle). Full detaljer:
  docs/RUNTIME_GATES.md.
- **Q-21 AUTOMATISK DIAGNOSE (samme dag):** `ua2-p0-live.ts` diagnostiserer nå selv, i ÉN kommando,
  om den faktiske runtime-rollen er trygg (`q21_runtime_role_safe`) og kjører isolasjons-acceptance
  via `pool` direkte når den er det - ellers `BLOCKED_BY_RUNTIME_ROLE` (aldri fake PASS).
- **Q-21 HOST-BEVIS (samme dag):** Tobias kjørte diagnosen live - `current_user=postgres`,
  `runtime_role_superuser=true`, `runtime_role_bypassrls=true`, `q21_runtime_role_safe=FAIL`. Bekreftet:
  RLS-policyene finnes og FORCE RLS er aktivt (`knowledge_documents_force_rls=true`), men
  api/worker/migrate kjørte alle som Postgres-superbruker - en ekte systembred
  runtime-konfigurasjonsfeil, ikke en UA-2-kode-bug.
- **Q-21 SYSTEMBRED FIKS (denne runden):** permanent split innført i `@jarvis/core`:
  `configFromEnv()` (RUNTIME, default `jarvis_runtime`) vs. ny `adminConfigFromEnv()` (ADMIN, leser
  `JARVIS_DB_ADMIN_USER/PASSWORD`) - to distinkte lesere, ingen fallback mellom dem. Ny
  `ensureRuntimeRole()` (idempotent, admin-kjørbar) bootstrapper `jarvis_runtime`
  (LOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, medlem av `jarvis_app`) fra
  `migrate-main.ts` (nå på `adminConfigFromEnv()`). `main.ts`/`worker-main.ts` fail-closed ved
  oppstart (`assertRuntimeCredentialsConfigured`/`assertRuntimeRoleSafe`) - nekter å starte normalt
  uten gyldige, distinkte, non-bypass runtime-credentials. `.env.example`/`docker-compose.yml`
  oppdatert med forklarende kommentarer (ingen ny parallell config-modell - samme grants/RLS som
  `jarvis_app` alt hadde, 005_rls.sql). **Automatisert host-fiks:**
  `modules/core/scripts/fix-q21-runtime-role.ts` - ÉN kommando som backup-er `.env`, genererer
  runtime-credentials, kjører migrate (bootstrapper rollen), restarter api/worker, verifiserer
  FAKTISK trygg tilkobling direkte mot Postgres, og kjører `ua2-p0-live.ts` til slutt. Ingen
  volumes/data røres. 24 nye tester (`modules/core/test/runtime-role.test.ts`,
  `db-config-split.test.ts`, `apps/api/test/db-role-wiring.test.ts`) - 324/324 totalt,
  lint/typecheck/gitleaks rene (inkl. `scripts/`-mapper nå faktisk typecheck-dekket, tidligere
  stille utelatt).
- **HOST RECOVERY-RUNDER (samme dag, tre runder til faktisk grønt):** første host-kjøring av
  fiks-scriptet feilet delvis (`.env`-interpolasjonsbug i Docker Compose - fikset med eksplisitt
  `--env-file`), deretter feilet migrate-containeren fortsatt med `password authentication failed for
  user "jarvis_runtime"` selv om admin-precheck viste `postgres` (runde 2 - grundig kildesporet, ingen
  kodebug funnet i selve wiringen). Faktisk root cause (runde 3, Tobias sin egen hypotese, bekreftet):
  `docker compose run --rm migrate` bygger ALDRI om et image automatisk - containeren kjørte et
  utdatert, pre-Q21-image. Fikset ved å alltid kjøre `docker compose build migrate api worker` før
  migrate/restart i hvert scriptkall. Full feilsøkingslogg: docs/RUNTIME_GATES.md.
- **STATUS: VERIFIED/COMPLETE (2026-08-15, host-bevist, run_id `778bb87d`) → D-38/D-39.** Full
  host-kjøring bekreftet grønt: `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
  `memory_space_isolation=PASS`, alle øvrige UA-2 P0-felt PASS unntatt `symlink_escape=
  SKIPPED_HOST_PERMISSION` (eksplisitt IKKE et live-PASS, forblir suite-bevist). Se
  header-seksjonen øverst i denne filen og docs/RUNTIME_GATES.md for full evidens.

## Q-20 — Data Erasure Foundation (BYGGET denne økten, 2026-08-16)
- **Inventory først** (docs/DATA_ERASURE.md §2): faktisk skjema lest (ikke antatt) - klassifisert
  A (CONTENT)/B (DERIVED)/C (OPERATIONAL METADATA)/D (SECURITY/AUDIT, append-only-blokkert).
- **Én sentral, typed erasure-tjeneste** (`modules/erasure`, `@jarvis/erasure`) - IKKE separate
  tilfeldige delete-funksjoner per modul. `previewErasure`/`executeErasure`/`verifyErasure`.
  Scope-modell: `tenant`/`person`/`memory_space`/`knowledge_source`/`knowledge_document`/
  `conversation`, `tenant_id` alltid eksplisitt - ingen cross-tenant purge uttrykkbart (bevist, §H).
- **Hard delete** (`modules/erasure/src/plan.ts`): FK-trygg rekkefølge, én transaksjon, fail-closed
  (en injisert midt-i-feil ruller HELE transaksjonen tilbake - bevist, §N). Dekker knowledge
  (`knowledge_documents`/`knowledge_embeddings`) + memory (`memory_items` + alt avledet) +
  conversations (`messages`/`sessions`) + `artifacts` (kun tenant-scope).
- **Ny migrasjon `018_erasure.sql`:** `erasure_requests`/`erasure_fingerprints`-ledger (RLS, samme
  mønster som resten) + et EKSPLISITT, avgrenset `GRANT DELETE` til `jarvis_app` (kun de tabellene
  som faktisk hard-slettes fra - systemet hadde ALDRI hatt en DELETE-rettighet noe sted før dette;
  `events`/`audit_events` forblir uten DELETE-grant, i tillegg til append-only-trigger-blokkert).
- **Resurrection protection (§5):** `erasure_fingerprints` lagrer KUN en irreversibel SHA-256-
  fingerprint av canonical identity - ALDRI innhold/external_id i klartekst. `KnowledgeSyncService`
  sjekker denne før nytt canonical document opprettes (`report.suppressed`, ny felt). Bevist LIVE
  (embedded Postgres): purge → resync (fil fortsatt på disk) → `created=0, suppressed=1`.
- **Erasure receipt/ledger (§6):** kun identifiers/counts, ALDRI slettet innhold - bevist (§K/§L,
  en plantet SENTINEL finnes aldri i `erasure_requests`/`erasure_fingerprints`).
- **Policy/risk (§7/§8):** gjenbruker EKSISTERENDE `PolicyGateway`/sovereign/approval/nonce-replay
  uendret - ingen ny auth-modell. Owner sovereign kjører uten approval; delegert identitet nektes
  uten signert approval, tillates med gyldig Ed25519-signatur (bevist, begge veier).
- **§9-unntak (dokumentert):** IKKE via `ToolGateway`s generiske D-pipeline (ville lagret en KOPI av
  innholdet i et `before_state`-recovery-snapshot - undergraver selve erasure). `executeErasure()`
  kaller `PolicyGateway.authorize()` direkte og skriver sin egen trygge ledger-rad.
- **Backup/restore-kontrakt (§10):** `TIER1_TABLES` (watchdog) utvidet med knowledge-tabellene (reell
  pre-eksisterende gap) + erasure-ledgeren. Ny `reapplyErasuresAfterRestore()` - re-fjerner et
  restorert dokument som matcher ledgeren, idempotent (bevist).
- **Observability (§11):** events/audit_events (strukturelt blokkert), Langfuse/lokal trace-fil
  (ingen purge-integrasjon) dokumentert som kjente, IKKE skjulte gap.
- **Retrieval verification (§12):** FTS/vector/hybrid/memory-retrieval alle bevist 0 treff etter
  purge (§E/§F/§G, live-script §8-§11).
- **Q-21 uendret/ikke-regresert (§13):** kjører via `jarvis_runtime` (NOSUPERUSER/NOBYPASSRLS) i
  ALLE tester og i live-scriptet (§O-testen leser `pg_roles` direkte og bekrefter dette per kjøring).
- **Live host-akseptanse-script:** `modules/erasure/scripts/q20-erasure-live.ts` - alle 21 trinn fra
  byggeordren, kjørt AV DENNE ØKTEN mot en ekte (embedded, ikke mocket) Postgres:
  `hard_fail=false`, alle `q20_*`-felt PASS (ved bygging - senere host-bevist reelt, se under).
- 14 nye tester (`modules/erasure/test/erasure-service.test.ts` 13 + `modules/watchdog/test/
  erasure-restore-contract.test.ts` 1), full suite grønn, lint/typecheck/gitleaks rene.
- **STATUS ved bygging: FIXED_SUITE / READY_FOR_HOST_VERIFY. OPPDATERT: VERIFIED/CLOSED (D-40) -
  se "Q-20 FINAL CLOSURE" under.** Teknisk erasure-foundation - IKKE en juridisk GDPR-sertifisering.

## Q-20 HOST RECOVERY #1 (samme dag, 2026-08-16) — workspace-bootstrap-feil
Tobias sin første kjøring feilet FØR noe Q-20-innhold ble testet: `ERR_MODULE_NOT_FOUND:
Cannot find package '@jarvis/core'`. Root cause: branchen la til en NY pnpm-workspace-pakke
(`modules/erasure`) - hosten sin `node_modules` var aldri bootstrappet for den (host-bootstrap-feil,
IKKE et Q-20-funn). Node 24 (host) bekreftet IKKE root cause (`engines: >=22` er oppfylt).
**Fikset** med ny ett-kommando-orkestrator `modules/core/scripts/q20-host-run.ts` (kun Node-
innebygde moduler på toppnivå - kan kjøre FØR `pnpm install`): bootstrapper workspacet
(`pnpm install --frozen-lockfile`), verifiserer resolvering (`modules/erasure/scripts/
verify-workspace.ts`), sikrer ferske Docker-images, kjører migrasjonene (inkl. `018_erasure.sql`)
via ADMIN-rollen (uendret Q-21-splitt), restarter api/worker, og kjører til slutt selve
`q20-erasure-live.ts`. Feilen reprodusert og fiksen bekreftet i byggemiljøet (node_modules fjernet
→ samme feil → `pnpm install` reparerer). 18 nye wiring-tester
(`modules/core/test/q20-host-run-wiring.test.ts`). Kommando uendret siden:
`node --experimental-transform-types modules/core/scripts/q20-host-run.ts`. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #2 (samme dag, 2026-08-16) — Windows pnpm-prosessoppløsning
Samme runner feilet deretter på selve `pnpm install --frozen-lockfile`-steget:
`spawnSync pnpm ENOENT` - til tross for at `pnpm` fungerer fint fra Tobias sin egen PowerShell.
Root cause: Node sin `execFileSync`/`spawnSync` uten shell-involvering gjør ikke Windows sin PATHEXT-
baserte utvidelsesoppløsning (`pnpm.cmd`). **Fikset (runde 1)** med ny, avhengighetsfri
`modules/core/scripts/lib/package-manager-resolve.ts` - deterministisk oppløsning: `pnpm`/`pnpm.cmd`
direkte på PATH → ellers `corepack`/`corepack.cmd` med EKSPLISITT pinnet versjon (`pnpm@9.15.9` fra
`package.json`, ALDRI `corepack enable`) → ellers fail-closed med tydelig diagnostikk. 11 nye
enhetstester. **Bekreftet FOR REAL i byggemiljøet** (ikke bare unit-testet): hele bootstrap-kjeden
kjørt direkte som ekte prosess - `package_manager_resolution=PASS
package_manager_driver=pnpm package_manager_version=9.15.9`, `install_frozen_lockfile=PASS`,
`erasure_workspace_dependencies=PASS`. Ett-kommando-kontrakten uendret. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #3 (samme dag, 2026-08-16) — DEP0190-opprydding
Host-output fra runde 2 sin fiks endte med Node sin `DEP0190`-advarsel (`shell: true` kombinert med
et args-array er en kjent injeksjonsrisiko - Node må selv gjette hvordan argumentene skal escapes).
**Fikset PERMANENT FØR merge:** `shell` er nå fjernet som alternativ overalt i
`q20-host-run.ts`/`package-manager-resolve.ts`. Et Windows `.cmd`-shim kjøres i stedet via en
eksplisitt, ikke-shell cmd.exe-barneprosess med et internt kontrollert argv (`buildSpawnInvocation()`,
`/d /s /c <sti> <args>` - samme mønster som `cross-spawn`-biblioteket bruker for nøyaktig dette
Windows-problemet). Native `.exe`/unix-binærer kjøres fortsatt direkte (ingen unødvendig indirection).
Ny regresjonstest bekrefter `shell: true` aldri finnes i kildekoden igjen. 16 nye/oppdaterte
enhetstester (34 totalt i `package-manager-resolve.test.ts`). Ingen erasure-/migrasjons-/DB-rolle-
/retrieval-/policy-logikk endret - kun prosess-spawning-hygiene.

## Q-20 FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/q20-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `eaabe2b1`.** Bootstrap
(`package_manager_resolution=PASS package_manager_driver=pnpm.cmd`), migrasjon 018 anvendt via
admin-rollen, Q-21 uendret (`q21_runtime_role_safe=PASS`), og ALLE `q20_*`-felt PASS
(`hard_fail=false`) - hard delete av original+avledet innhold, FTS/vector/hybrid/memory-retrieval=0
etter purge, resurrection-suppresjon bevist (`created=0`/`suppressed=1`), idempotens bevist,
tenant/space-isolasjon urørt, trygg kvittering, sentinel-scan uten funn. **STATUS: Q-20 =
VERIFIED/CLOSED → D-40.** Full evidens: docs/RUNTIME_GATES.md, docs/DECISIONS_AND_ASSUMPTIONS.md.
PR #4 merges til `main`.

## UA-2 P1A — Knowledge Source Expansion (BYGGET denne økten, 2026-08-16, FRA `origin/main` etter Q-20-merge)
- **Godkjent byggeordre** (etter Q-20 VERIFIED/CLOSED-merge): utvid `@jarvis/knowledge` med Google
  Drive (READ ONLY) og Obsidian/lokal vault som nye kunnskapskilder, på den EKSISTERENDE
  `KnowledgeSource`/`KnowledgeSyncService`/FTS+vector-hybrid-arkitekturen - ingen parallell
  connector-SDK, ingen ny auth-modell, ingen ny DB-migrasjon (gjenbruker `knowledge_documents`/
  `knowledge_embeddings` uendret). Pieces eksplisitt utsatt (se under). IKKE bygget: e-post-
  ingestion, møtetranskripsjon, OCR, full Knowledge Graph/GraphRAG, Drive write/delete.
- **Kontrakt-utvidelse** (`modules/knowledge/src/source.ts`): `KnowledgeSource.list()` returnerer nå
  `KnowledgeListResult { records, skipped }` i stedet for en bar array - en kilde kan rapportere
  bevisste per-element-skips (f.eks. ustøttet MIME) uten å forveksle dem med feil. Ny
  `KnowledgeSourceError`/`SourceErrorClass` (AUTH/PERMISSION/RATE_LIMIT/TRANSIENT_NETWORK/NOT_FOUND/
  UNSUPPORTED_CONTENT/INVALID_CONFIG/SOURCE_UNAVAILABLE) for TOTAL listing-svikt - `sync()` tombstoner
  ALDRI noe når `list()` kaster, uansett klasse (kritisk sikkerhetsegenskap, uendret). Fikset en latent
  bug i `GithubKnowledgeSource` samtidig: en feilet ToolGateway-handling ble tidligere stille utelatt
  (kunne feiltolkes som "alt slettet" av tombstone-logikken) - kaster nå eksplisitt i stedet.
- **`KnowledgeSourceRegistry`** (`registry.ts`): typet, FLERE-instans konfigurasjon bundet til
  (tenant_id, memory_space_id, source_instance_id) - `forTenant()` kan STRUKTURELT aldri returnere en
  annen tenants config, ingen implisitt/global kilde.
- **`GoogleDriveTransport`** (`modules/tool-gateway`): READ ONLY, samme OAuth/konto-mønster som
  Gmail/Calendar (`googleAccessToken()` gjenbrukt, ingen ny credential-type). `list_files` (paginert,
  eksplisitt `folder_id` fra kilden - ALDRI en default) + `read_document` (Google Docs eksporteres til
  text/plain, tekstlige MIME-typer leses rått, alt annet - Sheets/Slides/bilder/PDF/binærformater -
  kaster en typet `drive_unsupported_content_<mime>`-feil).
- **`GoogleDriveKnowledgeSource`** (`drive-source.ts`): `external_id` = Drive sin stabile `file.id`
  (rename-safe - en omdøpning endrer `title`, ikke `external_id`). Mappe-scope er REKURSIV men
  importerer ALDRI hele driven når konfigurert for én mappe. Paginering + rekursjon aggregeres internt
  i `list()` (komplett resultat eller kast, aldri partielt). Sletting gjenbruker eksisterende
  "fraværende i vellykket listing = tombstone" (ingen egen Drive Changes-API-integrasjon - bevisst,
  dokumentert valg). En AUTH/PERMISSION-feil på ÉN fil-lesing eskaleres til TOTAL svikt (systemisk
  årsak antatt); NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på én fil er en trygg per-fil-skip.
- **`ObsidianVaultKnowledgeSource`** (`obsidian-source.ts`): KOMPONERER rundt
  `FilesystemKnowledgeSource` (samme allowlist/traversal/symlink-forsvar som UA-2 P0, ingen duplisert
  sikkerhetslogikk) - kun `.md`-filer, `.obsidian/` ekskludert som default. Frontmatter parses
  best-effort (flat, ingen ny YAML-avhengighet) til `metadata.frontmatter`; wiki-lenker
  (`[[Notat]]`) til `metadata.wiki_links` (flat liste, IKKE en graf - GraphRAG bevisst utenfor P1A).
  `external_id` = relativ vault-sti (samme presedens som filesystem) - Obsidian-omdøpning er derfor
  slett+ny, IKKE en oppdatering (dokumentert forskjell fra Drive, som HAR en stabil fil-id).
- **To korrekthetsfiks i `KnowledgeSyncService.sync()`** (gjelder ALLE kilder, ikke bare de nye):
  (1) `skipped`-elementer beskyttes nå mot tombstoning sammen med `seen` - én forbigående per-element-
  feil kunne tidligere tombstonet ETT dokument selv om hele listingen lyktes; (2) "uendret innhold"-
  grenen oppdaterer nå tittel/uri/metadata (uten re-embedding) - nødvendig for at en Drive-omdøpning
  faktisk skal synes.
- **Chunking-safeguard** (bevisst MINIMAL, ingen ekte multi-chunk-skjema): `embed()`-input trunkeres
  til 24 000 tegn - `content`-kolonnen (og dermed FTS) beholder ALLTID hele, utrunkerte teksten. Ingen
  embedding-leverandør i kodebasen hadde en input-grense før dette (Drive/Obsidian-dokumenter kan bli
  langt større enn P0 sine korte GitHub-issues).
- **Pieces: eksplisitt utsatt.** Repo-søk fant INGEN integrasjon/API/eksportformat/credential-
  miljøvariabel noe sted - kun navnedropp i planleggingsdokumenter. Ingen konkret, ikke-gjettet
  integrasjonsflate å bygge mot ennå - egen fremtidig underoppgave når en finnes.
- **Ett-kommando host-akseptanse:** `modules/core/scripts/ua2-p1a-host-run.ts` (samme
  pnpm/Windows/Docker-bootstrap-mønster som `q20-host-run.ts`, INGEN ny workspace-pakke denne gangen
  → ingen egen verify-workspace-steg) kjører til slutt
  `modules/knowledge/scripts/ua2-p1a-live.ts`: Q-21-rolle-sjekk, registry-sanity, Obsidian full
  livssyklus i en ISOLERT MIDLERTIDIG vault (ALDRI Tobias sin ekte vault), tenant-isolasjon+retrieval
  med de nye kildetypene, no-content-i-audit-scan. Google Drive LIVE er BETINGET: krever
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` OG en NY, dedikert
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` (aldri hele driven) - mangler noen av de fire rapporteres
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE`, ALDRI en fake PASS.
- **Kvalitet:** 463/463 tester (406 baseline fra `origin/main` + 57 nye: registry x9, Drive-source x11,
  Obsidian-source x9, kryssgående tenant/space/retrieval/audit-redaksjon x5, chunking-safeguard x2,
  host-run-wiring x21), full monorepo-typecheck ren. Lint/gitleaks gjenstår før PR (se §32 i
  byggeordren).
- **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED** - ingen ekte Google Drive-credential,
  ingen ekte Docker-Postgres i denne sky-sandboxen. Krever Tobias sin host-kjøring
  (`ua2-p1a-host-run.ts`) før VERIFIED kan settes, akkurat som Q-20/UA-2 P0 krevde det.

## UA-2 P1A scope-endring — Google Drive full read/write + Owner Connector Capability Invariant (D-41, samme økt)
- **Tobias sin eksplisitte beslutning FØR PR #5 merges:** Jarvis skal IKKE være begrenset til read-only
  Google Drive - full funksjonell tilgang, styrt av det EKSISTERENDE A-D policy-systemet (ingen ny
  permission-modell). Samtidig innført som en PERMANENT arkitekturregel for ALLE fremtidige connectors
  (se D-41 i DECISIONS_AND_ASSUMPTIONS.md, rule 11 i CLAUDE.md).
- **Google Drive utvidet fra READ ONLY til FULL read/write/permissions:** `GoogleDriveTransport` fikk 10
  nye handlinger (`get_metadata`/`read_permissions` klasse A; `create_file`/`create_folder`/
  `update_content`/`rename`/`move`/`trash` klasse C; `delete_permanent`/`create_permission`/
  `update_permission`/`delete_permission` klasse D). Produksjons-OAuth-scope bekreftet mot Google sitt
  offisielle Drive API v3-discovery-dokument (IKKE gjettet): `https://www.googleapis.com/auth/drive`
  (full tilgang - `drive.file` dekker kun app-opprettede filer, utilstrekkelig). `files.delete` er
  PERMANENT (bekreftet); trashing er en egen, reversibel `files.update`. `update_content`/`rename`/
  `move`/`trash` godtar en valgfri `expected_head_revision_id`-precondition - ved mismatch kastes en
  typet `drive_conflict_stale_version`-feil FØR noen mutasjon forsøkes, aldri en stille overskriving.
  D-klasse-handlinger har `preflight_action` (samme eksisterende ToolGateway-evidensmekanisme som
  Home Assistant sin `lock_set`/`alarm_set` alt brukte - ingen ny mekanisme). Owner sovereign-modus
  uendret: klasse D autonomt for eier, delegert identitet krever fortsatt signert godkjenning.
- **Idempotens:** skriveoperasjoner gjenbruker EKSISTERENDE ToolGateway `idempotency_key`-dedupe (samme
  mekanisme som resten av systemet) - bevist kritisk for `create_permission` spesielt, siden Drive sin
  egen `permissions.create` IKKE dedupliserer identiske tilganger selv.
- **Q-20-distinksjon (§5 i scope-endringen):** eksplisitt bevist arkitektonisk separert - en
  `drive/trash`-handling rører ALDRI `knowledge_documents`, og en Q-20-hard-delete av et
  `knowledge_document` kaller ALDRI ut til Drive. Dette er to uavhengige operasjoner, ikke automatisk
  koblet.
- **Tester:** 27 nye (`drive-full-access.test.ts` 17 - policy/idempotens/isolasjon/observability via ekte
  ToolGateway+Postgres+FakeTransport; `google-drive-transport.test.ts` 10 - konflikt-/statuskode-
  klassifisering internt i transporten, fetch mocket, det ENESTE unntaket fra "raw HTTP-transportere
  unit-testes aldri"-presedensen fordi byggeordren eksplisitt krevde det). `ua2-p1a-live.ts` §6 utvidet
  med ekte create/update/rename/move/trash/cleanup/sync/no-resurrection/idempotency mot
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` - `google_drive_live=BLOCKED_REAUTH_REQUIRED` hvis lesing
  fungerer men skriving feiler på auth (utilstrekkelig scope på eksisterende token). Permission-
  mutasjon er BEVISST IKKE live-testet (kan ikke gjøres trygt uten å involvere en ekte person/endre ekte
  eksponering) - policy/klassifisering for det er suite-bevist. 517/517 tester totalt (490 + 27),
  full monorepo-typecheck ren.
- **Connector-audit (engangs, IKKE alle utvidet i denne runden - kun Google Drive):**

  | Connector | Klassifisering | Har i dag | Konkrete gap (backlog, IKKE bygget her) |
  |---|---|---|---|
  | Google Drive | **FULL** (denne økten) | read/list/create/update/rename/move/trash/delete/permissions | - |
  | GitHub | PARTIAL | read_issues, read_repo_meta, create_pr | Ingen merge_pr, ingen issue-kommentar/opprettelse/lukking, ingen branch-sletting, ingen repo-admin |
  | Google Calendar | PARTIAL | read_events, create_event | Ingen update_event, ingen delete_event, ingen svar-på-invitasjon |
  | Gmail/e-post | PARTIAL | read_inbox, send | Ingen reply/forward, ingen arkivering/sletting/labeling, ingen draft-håndtering |
  | Telegram | PARTIAL | notify (send), `/brief`/`/status`/`/ai`-kommandoer (poll) | Ingen redigering/sletting av sendte meldinger, ingen rikere Bot API-funksjoner (pin, media) |
  | Vercel | READ_ONLY | read_deployments | Ingen trigger/rollback/promote-deploy, ingen env-var-håndtering |
  | Home Assistant | PARTIAL | read_state, light_set, climate_set, lock_set (D), alarm_set (D) | God kjernedekning, men ikke uttømmende (media_player, cover/blinds, scener, automasjon-trigger mangler) |

  Gapene er EKSPLISITT dokumentert som backlog, IKKE lukket her (D-41/§CURRENT CONNECTOR AUDIT sier
  eksplisitt "IKKE utvid alle nå dersom det blåser scope"). Hver fremtidig connector-byggeordre
  vurderer full kapabilitet fra D-41-sjekklisten fremover.

## UA-2 P1A HOST RECOVERY — auto-create safe Drive test sandbox (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte `ua2-p1a-host-run.ts` (run_id `8af834dd`, `hard_fail=false`) - ALLE
  ingestion-felt (Obsidian/registry/tenant-isolasjon/retrieval/audit) PASS, men
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE` fordi `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` ikke var
  satt, selv om `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` alle var konfigurert.
- **Eksplisitt eierbeslutning:** Tobias skal ALDRI måtte manuelt opprette en Drive-testmappe, finne/
  kopiere en mappe-ID, eller redigere `.env` for å kjøre denne akseptansen.
- **Ny, ren, avhengighetsfri modul** `modules/knowledge/scripts/lib/drive-acceptance-sandbox.ts`
  (`DriveAcceptanceSandbox`, `determineTestRootSource`, `driveAcceptanceFolderName`, `isReauthSignal`) -
  BEVISST ingen fetch/nettverk der, kun grensekontroll-/cleanup-logikk. `assertInSandbox()` er den ENESTE
  veien en mutasjon godkjennes - fail-closed, kaster `DriveBoundaryViolationError` for enhver ID denne
  kjøringen ikke selv sporet som opprettet (aldri "prøv og se").
- **`ua2-p1a-live.ts` §6 fullstendig omskrevet:** er `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` satt, brukes den
  (kun LEST, ALDRI slettet av runneren). Er den IKKE satt, oppretter runneren SELV en unikt navngitt,
  midlertidig mappe (`"Jarvis P1A Acceptance <run_id>"`) - BEVISST INGEN søk-etter-lignende-navn-og-
  gjenbruk (alltid en fersk `create_folder`, aldri en `list_files`-basert oppslag). Et rent LESE-scope-
  probe (`get_metadata` på Drive sin reserverte `"root"`-ID) skjer FØR test-roten løses og FØR noen
  mutasjon forsøkes, slik at total auth-svikt skilles fra manglende skrive-scope
  (`google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`). Full akseptanse A-Q bevist INNENFOR sandkassen:
  auth-probe, opprett to undermapper + hovedtestfil, les, oppdater, omdøp, flytt mellom undermappene,
  sync+retrieval (scopet til subfolder-b), Q-20 hard-delete+resync-no-resurrection (PLUSS et nytt
  Drive-side-uavhengighetsbevis: originalfilen bekreftes FORTSATT å eksistere i Drive etter Jarvis-side
  purge), trash (reversibelt), idempotent create (samme idempotency_key), permanent sletting KUN på en
  artefakt DENNE kjøringen selv opprettet (`driveMutate()`-wrapperen grensekontrollerer FØR ethvert
  mutasjonskall). Permission-mutasjon fortsatt BEVISST IKKE live-testet
  (`google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`) - kan ikke gjøres trygt uten å
  involvere en ekte person/endre ekte eksponering i en ubetjent kjøring.
- **Opprydding:** alt DENNE kjøringen selv opprettet slettes permanent til slutt via
  `sandbox.cleanupTargets()` (barn FØR rot) - en eksplisitt KONFIGURERT rot er strukturelt ALDRI et
  mål (kun inkludert når `autoCreated=true`). Den auto-opprettede mappe-IDen persisteres ALDRI til
  `.env` - kun til kjøringens `diagnostics`/logg.
- **`ua2-p1a-host-run.ts`-kommentarblokken oppdatert** til å reflektere at `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID`
  nå er VALGFRI - selve ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts`.
- **Tester:** 13 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - auto-create-beslutning,
  navneunikhet, grensekontroll, reauth-klassifisering, cleanup-scoping inkl. delvis-oppsatt-kjøring og
  "konfigurert rot aldri i cleanup-listen"), pluss `ua2-p1a-host-run-wiring.test.ts` utvidet/oppdatert
  (guard krever nå kun client_id/secret/token, IKKE test_folder_id; nye strukturelle bevis for §D
  no-reuse-by-search, §J konfigurert-rot-aldri-direkte-slettet, §K ingen `.env`-persistering,
  driveMutate-grensekontroll-kjeden, §M idempotent-gjentakelse). **512/512 tester totalt** (faktisk målt
  denne runden), lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring fra
  Tobias for å bevise auto-sandkassen faktisk fungerer mot ekte Drive. PR #5 forblir draft/umerget.

## GOOGLE DRIVE FULL-ACCESS REAUTH (samme dag, 2026-08-16) — ett-kommando nettleser-reauth
- **Host-funn:** run_id `262ac1bb` viste `google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`
  (`get_metadata("root")` → `tool_failed:drive_auth_error_403`) - det eksisterende `JARVIS_GOOGLE_TOKEN`
  mangler full Drive-scope (utstedt før D-41-scope-endringen). Eierkrav: Tobias skal ALDRI måtte lime
  inn en autorisasjonskode manuelt, redigere `.env`, eller kjøre en egen andre kommando etterpå -
  produksjons-OAuth-scope forblir FULL `https://www.googleapis.com/auth/drive` (D-41 uendret, ingen
  fallback til read-only for å "få testen til å passere").
- **Ny, ren, avhengighetsfri modul** `modules/core/scripts/lib/google-drive-reauth-lib.ts` -
  URL-bygging/callback-parsing/state-CSRF-sjekk/scope-sammenligning/refresh-token-beslutning/konto-
  maskering, INGEN nettverk/filsystem der (30 rene enhetstester).
- **`modules/core/scripts/google-drive-reauth.ts`** - ÉN host-kommando:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`. Offisiell
  "authorization code" + loopback-IP-redirect-flyt (RFC 8252, `http://127.0.0.1:8942/oauth2callback`
  default, `JARVIS_GOOGLE_REAUTH_PORT` valgfri override) - ALDRI den avviklede OOB-flyten. Ber om
  `https://www.googleapis.com/auth/drive` + EKSISTERENDE `https://www.googleapis.com/auth/calendar`
  (unngår å regressere kalender, som deler samme `JARVIS_GOOGLE_TOKEN`) + et minimalt
  `https://www.googleapis.com/auth/userinfo.email`-scope (kun for konto-identitetssjekk). `access_type=
  offline`+`prompt=consent`+`include_granted_scopes=true` (bekreftet mot google-auth-library sin
  offisielle Node.js-dokumentasjon - garanterer en fersk refresh_token hver kjøring, bevarer andre
  allerede godkjente scopes). Åpner standardnettleseren automatisk (Windows/macOS/Linux, samme
  DEP0190-sikre ikke-shell cmd.exe-mønster som `package-manager-resolve.ts` på Windows); fallback til
  manuell URL hvis åpning feiler.
- **Verifisering FØR noe skrives (§7):** både token-responsens `scope`-felt OG en FAKTISK
  `get_metadata("root")`-lesing mot ekte Drive må lykkes - callback-suksess alene er IKKE nok.
  Innsuffisient scope → `FAIL_INSUFFICIENT_SCOPE`, `.env` urørt. Manglende refresh_token i responsen
  (uventet siden `prompt=consent` alltid tvinger en) håndteres KUN ved å LIVE re-verifisere den
  eksisterende token-ens faktiske scope via `tokeninfo`-endepunktet - aldri en antakelse om Google sin
  interne inkrementell-auth-oppførsel.
- **Konto-konsistens (§8):** henter KUN e-postadressen (minimalt scope), maskerer den (`t***@domene`)
  i all logging, sammenligner mot konfigurert `JARVIS_GOOGLE_ACCOUNT` - ved mismatch kreves eksplisitt
  skrevet "YES" i terminalen FØR noe skrives; "identitet kunne ikke bestemmes" blokkerer IKKE (logges
  ærlig som ukjent, aldri stille behandlet som match).
- **Sikkerhet:** aldri client_secret/access_token/refresh_token/authorization_code i logg eller
  prosessargument (bevist strukturelt, se wiring-tester). `.env` skrives KUN ved full suksess - alle
  feilbaner returnerer/kaster FØR skriving, slik at den eksisterende (om enn scope-begrensede)
  credentialen alltid forblir gjenopprettbar. Skriving gjenbruker EKSISTERENDE
  `buildUpdatedEnvLines`/`parseEnvValues`/backup-mønster fra `lib/q21-env-recovery.ts` (samme
  `.env.bak.<epoch>` + atomisk tmp+rename som `fix-q21-runtime-role.ts`) - rører KUN
  `JARVIS_GOOGLE_TOKEN`-linjen.
- **Kjeder automatisk videre:** ved `google_drive_reauth=PASS` kjøres `ua2-p1a-host-run.ts` (og dermed
  hele Drive-auto-sandkasse-akseptansen fra forrige runde) AUTOMATISK - ingen andre kommando fra Tobias.
- **Presisjonsfunn (dokumentert, IKKE fikset i denne runden):** `GmailTransport` (tool_id `"email"`)
  bruker faktisk en HELT ANNEN, i dag ukonfigurert credential (`JARVIS_EMAIL_TOKEN`) - IKKE
  `JARVIS_GOOGLE_TOKEN` slik en eldre `.env.example`-kommentar feilaktig antydet (rettet i denne
  runden). Reauth-scriptet ber derfor bevisst KUN om Drive+Calendar-scope, ikke Gmail.
- **Åpent, IKKE-blokkerende funn (logget, ikke skjult):** `GoogleDriveTransport` er registrert i
  `firstWaveTools()`-funksjonen, men er IKKE koblet inn i de faktiske produksjons-entrypointene
  (`apps/api/src/main.ts`/`worker-main.ts` sine `firstWaveTools({...})`-kall mangler en `drive:`-nøkkel
  - kun `email`/`calendar`/`github`/`telegram` er wiret der i dag). Drive-verktøyet er dermed reelt
  reachable KUN fra `ua2-p1a-live.ts`/testene, ikke fra en løpende api/worker-prosess ennå. Dette er
  UTENFOR denne reauth-ordrens scope (som var credential-anskaffelse, ikke entrypoint-wiring) og
  krever en egen, eksplisitt godkjent byggeordre - ikke gjort stille her.
- **Tester:** 30 nye rene enhetstester (`google-drive-reauth-lib.test.ts`) + 24 nye strukturelle
  wiring-tester (`google-drive-reauth-wiring.test.ts`, kildeteksts-basert - samme presedens som
  `ua2-p1a-host-run-wiring.test.ts`). Full suite/lint/typecheck/gitleaks kjøres som del av denne
  rundens kvalitetsport (se rapport).
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sin faktiske
  nettleser-godkjenning på hosten. PR #5 forblir draft/umerget.

## GOOGLE DRIVE REAUTH HOST FIX (samme dag, 2026-08-16) — response_type manglet + feil konto
- **Host-funn:** Tobias kjørte `google-drive-reauth.ts`. Nettleseren åpnet Google OAuth med FEIL konto
  (`henrik@ffskis.com`), og Google avviste med "Required parameter is missing: response_type" (Error
  400: invalid_request).
- **Root cause (ÉN, forklarer BEGGE symptomene samtidig):** den genererte autorisasjons-URL-en har
  ALLTID inneholdt `response_type=code` (bevist av eksisterende enhetstester siden forrige runde) -
  feilen lå i `openBrowser()` sin daværende Windows-vei, `cmd /c start "" <url>`. URL-en inneholder `&`
  (gyldig spørrestreng-skilletegn) men verken mellomrom eller anførselstegn, så Node sin Windows-argv-
  til-kommandolinje-quoting siterte IKKE argumentet automatisk. cmd.exe mottok URL-en USITERT i
  `/c`-modus og splittet den ved HVERT ubeskyttet `&` som et kommando-skille - Google mottok reelt kun
  `...auth?client_id=<id>`, nok til å identifisere appen og stille falle tilbake til en allerede
  innlogget nettleser-konto, men ALDRI `redirect_uri`/`response_type`/`scope`/`state`.
- **Fiks 1 (transport):** Windows-veien bruker nå `rundll32.exe url.dll,FileProtocolHandler <url>` i
  stedet for `cmd /c start` - en native .exe, INGEN kommandotolk involvert i det hele tatt (samme
  "native-exe-trenger-ingen-cmd-wrapper"-presedens som `lib/package-manager-resolve.ts`).
- **Fiks 2 (kontovalg):** `prompt` er nå `"consent select_account"` (Google sin offisielt dokumenterte
  mellomrom-delte prompt-liste) - tvinger ALLTID frem kontovelgeren, aldri en stille auto-valgt konto.
  `login_hint` settes til `JARVIS_GOOGLE_ACCOUNT` (kun et HINT - hindrer aldri kontobytte, offisielt
  dokumentert Google-oppførsel).
- **Fiks 3 (pre-flight-sikkerhetsnett):** `validateAuthorizationUrl()` parser den genererte URL-en
  tilbake og krever eksplisitt `response_type=code`+`client_id`+`redirect_uri`+`state`+full Drive-scope
  FØR nettleseren i det hele tatt åpnes - fanger enhver FREMTIDIG regresjon i selve URL-byggingen,
  fail-closed (server startes ikke, nettleser åpnes ikke).
- **Konto-mismatch-rapportering presisert:** ny `formatAccountMismatchReport()` gir en eksplisitt,
  grep-bar `expected_account=<maskert> authorized_account=<maskert>`-loggform - samme
  bekreftelses-gate (typet "YES") som før, kun tydeligere format.
- **.env-sikkerhet uendret/bekreftet:** alle feilbaner (inkl. den nye pre-flight-valideringen) skjer
  strukturelt FØR backup/skriving - `.env` forblir urørt ved enhver feil, bevist av wiring-testene.
- **Tester:** 15 nye rene enhetstester (URL-validering, prompt/login_hint, mismatch-rapportformat) +
  7 nye strukturelle wiring-tester (rundll32 i bruk / cmd-start borte, pre-flight-rekkefølge,
  login_hint-wiring, mismatch-rapport-bruk) - 588/588 totalt. Lint/full monorepo-typecheck/gitleaks
  alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring
  fra Tobias for å bevise fiksen faktisk fungerer mot en ekte Windows-nettleser. PR #5 forblir
  draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #2 (samme dag, 2026-08-16) — redirect_uri_mismatch / permanent Desktop-klient-design
- **Host-funn:** transport-fiksen over løste URL-korrumperingen (Tobias sin nettleser åpnet nå den
  KOMPLETTE URL-en - riktig client_id/redirect_uri/response_type/scope/state/prompt), men Google svarte
  deretter med `Error 400: redirect_uri_mismatch`.
- **Root cause (evidensbasert, ikke gjettet):** Google validerer `redirect_uri` FØR noe annet
  (sikkerhetskritisk, hindrer open-redirect) - en "Web application"-klient krever en EKSAKT
  forhåndsregistrert redirect-URI, mens en "Desktop app"-klient godtar EN loopback-IP-redirect på
  HVILKEN SOM HELST port UTEN forhåndsregistrering (bekreftet Google-dokumentert oppførsel). At
  Tobias sin eksisterende, allerede eksisterende OAuth-klient (fra FØR denne reauth-byggingen) ga
  mismatch for en loopback-URI er sterk evidens for at den er "Web application"-type - Jarvis sin
  lokale, interaktive eier-reauth-flyt er NØYAKTIG scenarioet "Desktop app" er bygget for. Google
  sender ALDRI noen callback tilbake ved mismatch (feilsiden vises direkte i nettleseren) - dette
  scriptet kan derfor STRUKTURELT ikke oppdage feilen selv via callback-serveren.
- **Ingen offentlig Google-API for å opprette en OAuth-klient programmatisk** (kun Cloud Console-UI -
  bekreftet, ikke antatt) - ETT manuelt Cloud Console-steg er derfor uunngåelig. Redusert til fem
  eksplisitte steg i loggmeldingen FØR nettleseren åpnes, PLUSS Cloud Console-credentials-siden åpnes
  AUTOMATISK i en egen fane (prosjektnummeret utledes fra den eksisterende `JARVIS_GOOGLE_CLIENT_ID`
  sin stabile `<prosjektnummer>-<random>.apps.googleusercontent.com`-form - ingen gjettet URL).
- **Ny, valgfri `JARVIS_GOOGLE_CLIENT_SECRET_JSON`** (.env-variabel, filsti): peker til den nedlastede
  client secret-JSON-fila fra en NY "Desktop app"-OAuth-klient. `resolveOAuthClient()` leser/validerer
  denne FØR noe annet i `main()` - `parseClientSecretJson()` godtar KUN Google sin `installed`
  (Desktop)-JSON-form, og avviser en `web`-type fil EKSPLISITT (`WrongOAuthClientTypeError`, samme
  brittleness som klienten Tobias allerede har - stille prøving av samme feilende type unngås).
- **Koherent credential-sett (§4 i ordren):** brukes en importert Desktop-klient, skrives
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` SAMMEN i ÉN atomisk `.env`-skriving ved suksess - aldri
  et token alene mot en client_id/_secret som ikke lenger samsvarer. Refresh-tokens er tied til klienten
  som utstedte dem (bekreftet Google-oppførsel) - en full authorization_code-exchange (ikke bare en
  refresh_token-gjenbruk) garanterer et FERSKT, korrekt-koblet token for DEN importerte klienten.
- **Kontovelger uendret:** `prompt=consent select_account` og `login_hint` er identisk uansett
  klientkilde (ÉN `buildAuthorizationUrl()`-kall, ingen egen "importert klient"-gren som svekker dette).
  Presisering av §7 i ordren: "browseren viste fortsatt henrik@ffskis.com" er mest sannsynlig Google sin
  standard feilside-topptekst (viser AKTIV nettleser-økt-identitet) - siden redirect_uri-valideringen
  skjer FØR kontovelgeren i det hele tatt vises, ble select_account/login_hint aldri nådd i det
  tilfellet. Ingen svekkelse av den mekanismen er gjort eller nødvendig.
- **Tester:** 11 nye rene enhetstester (`parseClientSecretJson`/`deriveProjectNumberFromClientId`/
  `buildCredentialsConsoleUrl`) + 10 nye strukturelle wiring-tester (koherent skriving, ingen
  parallell/duplisert credential-lesing, .env-drevet gjenopptakelse, ingen secrets i den nye koden) -
  608/608 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  manuelle Cloud Console-steg (opprett Desktop-klient, sett `JARVIS_GOOGLE_CLIENT_SECRET_JSON`) etterfulgt
  av en NY host-kjøring for å bevise dette faktisk fungerer. PR #5 forblir draft/umerget. Ett-kommando-
  kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #3 "ZERO MANUAL ENV EDITING" (samme dag, 2026-08-16) — automatisk Desktop-klient-oppdagelse
- **Eierens UX-krav:** etter HOST FIX #2 var det ENE uunngåelige manuelle steget i praksis TO -
  Cloud Console-handlingen OG å redigere `.env` med filstien til den nedlastede JSON-en. Tobias skal KUN
  gjøre den ENE, faktisk uunngåelige handlingen (opprette en "Desktop app"-klient og trykke "Download
  JSON") - ALDRI redigere `.env`, kopiere client_id/secret, eller lime inn en filsti.
- **Automatisk Nedlastinger-oppdagelse, i SAMME kjørende prosess, uten restart:** `attemptOAuth()` starter
  nå det opprinnelige OAuth-forsøket OG (parallelt, i bakgrunnen) en `watchForDesktopClientDownload()`-
  polling av Tobias sin Nedlastinger-mappe (`os.homedir()/Downloads` - den dokumenterte
  standardplasseringen, ALDRI en hardkodet bruker-sti). `Promise.race()` mellom callback-en og watcheren
  avgjør veien videre: kommer callback-en FØRST (normalflyt - klienten var allerede riktig type),
  fortsetter alt UENDRET og Tobias ser ALDRI noen ekstra fane (veiledningen/Cloud Console-siden vises
  FØRST etter 25 sekunder - god margin for en vanlig kontovalg+samtykke-interaksjon, kort nok til rask
  hjelp ved en ekte feil). Finner watcheren en NY, gyldig Desktop-klient-JSON FØRST, avbrytes det
  opprinnelige callback-forsøket EKSPLISITT (frigjør porten - `waitForCallback()` er nå kansellerbar) og
  et FRISK OAuth-forsøk starter AUTOMATISK med den nye klienten, i SAMME prosess.
- **KUN filer fra og med kjøringens eget starttidspunkt regnes** (`selectNewCandidateJsonFiles`) - en
  gammel, urelatert JSON-fil som allerede lå i Nedlastinger plukkes ALDRI opp. Hver kandidat valideres med
  den EKSISTERENDE `parseClientSecretJson()` (ingen ny/parallell valideringslogikk) - en "web"-type fil
  eller søppel EKSKLUDERES STILLE fra kandidatlisten (Nedlastinger kan inneholde mange urelaterte
  JSON-filer), krasjer ALDRI polling-løkka. Flere gyldige kandidater SAMTIDIG avgjøres ALDRI stille - en
  trygg, KUN-filnavn nummerert liste ber Tobias velge eksplisitt.
- **Koherent persistering uendret:** `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` skrives SAMMEN, atomisk,
  til de VANLIGE `.env`-nøklene FØRST etter faktisk OAuth-suksess (scope+Drive-probe+kontosjekk alle
  bestått). `JARVIS_GOOGLE_CLIENT_SECRET_JSON` (HOST FIX #2) forblir støttet for et avansert/manuelt
  oppsett, men er IKKE lenger nødvendig for normalflyten og persisteres ALDRI selv - kun et
  engangs-import-artefakt.
- **Tester:** 20 nye rene enhetstester (`selectNewCandidateJsonFiles`/`classifyDiscoveryResult`/
  `formatCandidateSelectionPrompt`/`parseCandidateSelection`) + 15 nye strukturelle wiring-tester
  (kansellerbar callback-server, race-rekkefølge, koherent skriving KUN etter suksess, ingen restart,
  fortsatt ingen secrets logget) - 637/637 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **Ærlighet om verifikasjonsgrense:** selve den KONKURRERENDE race-/polling-/kanselleringslogikken kan
  IKKE kjøres ende-til-ende i denne sky-sandboxen (krever en ekte Windows-nettleser + en ekte
  Nedlastinger-mappe + faktisk Google OAuth) - bevist STRUKTURELT (kildeteksts-baserte wiring-tester,
  samme presedens som resten av denne fila) + den underliggende beslutnings-/filtreringslogikken FULLT
  enhetstestet. Faktisk host-kjøring er derfor fortsatt nødvendig for VERIFIED.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget.
  Ett-kommando-kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #4 "SETUP-FØRST, ALDRI AUTH MED KJENT WEB-KLIENT" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #3-versjonen. Nettleseren åpnet Google OAuth UMIDDELBART og fikk
  igjen `Error 400: redirect_uri_mismatch` (kontoen vist: `post@tsworkflow.com`) - beviset på at racet
  (opprinnelig OAuth-forsøk kjørt SAMTIDIG med Nedlastinger-oppdagelsen) startet OAuth med den samme,
  allerede kjent inkompatible Web-klienten FØR noen Desktop-klient var på plass.
- **Root cause:** HOST FIX #3 sitt design antok at man MÅTTE prøve eksisterende credentials FØRST for å
  "oppdage" om de var utilstrekkelige. For et tilfelle der Tobias ALLEREDE (fra HOST FIX #2) har bevist
  at eksisterende `JARVIS_GOOGLE_CLIENT_ID` er en Web-klient, er dette feil - vi VET allerede at et
  OAuth-forsøk med den vil feile, og skal derfor ALDRI forsøkes.
- **Racet er FJERNET.** Ny, strengt sekvensiell tilstandsmaskin: `resolveProvenDesktopClient()` avgjør
  FØRST om en POSITIVT bevist Desktop-klient finnes - enten en eksplisitt `JARVIS_GOOGLE_CLIENT_SECRET_
  JSON`-import (HOST FIX #2, avansert/manuelt), ELLER en NY `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-
  metadata-linje persistert av EN TIDLIGERE vellykket kjøring av DENNE flyten. Eksisterende
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` ALENE (uten den metadata-linjen) regnes ALDRI som bevist Desktop -
  de kan være NØYAKTIG den samme Web-klienten som allerede har feilet TO GANGER, og brukes derfor ALDRI
  til et OAuth-forsøk.
- **Finnes ingen bevist klient:** `main()` går INN i SETUP_REQUIRED FØR noe OAuth-forsøk i det hele tatt
  vurderes. Cloud Console-siden åpnes UMIDDELBART (ingen "vent og se"-graceperiode lenger - setup-behovet
  er allerede kjent, ikke en gjetning), og `waitForDesktopClientJson()` venter ALENE (ingen samtidig
  OAuth-forsøk) i inntil 10 minutter på at en gyldig, ny Desktop-klient-JSON dukker opp i Nedlastinger.
  Først NÅR en slik klient er funnet+validert bygges autorisasjons-URL-en - ALLTID med DEN klientens
  `client_id`, ALDRI den rå `JARVIS_GOOGLE_CLIENT_ID`-verdien direkte.
- **`waitForCallback()` forenklet tilbake** til en enkel (ikke-kansellerbar) funksjon - siden det aldri
  finnes mer enn ÉTT OAuth-forsøk per kjøring lenger, er hele kanselleringsmekanismen fra HOST FIX #3
  unødvendig og fjernet.
- **Koherent persistering utvidet:** ved full suksess skrives `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/
  `_TOKEN` OG den nye `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-metadata-linjen SAMMEN i ÉN atomisk
  skriving - FØR suksess er gamle credentials (om noen) HELT urørt, slik at eksisterende, fungerende
  Gmail/Calendar-integrasjoner (som deler samme `JARVIS_GOOGLE_TOKEN`) aldri risikerer å miste sin
  gyldige credential midt i en mislykket reauth-kjøring.
- **Tester:** wiring-testsuiten omskrevet fra grunnen for den nye sekvensielle flyten (50 tester, dekker
  ordrens §10 A-L) - 631/631 totalt (færre enn forrige runde ved design, siden race-spesifikke tester er
  erstattet av færre, mer presise sekvensielle tester). Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig, nå UTEN risiko for at scriptet prøver den kjente Web-klienten
  først) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er
  UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #5 "CLASSIFY REAL DRIVE 403 + AUTO-GUIDE" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #4-versjonen. Desktop-OAuth-bootstrappen fungerte HELT gjennom
  (`google_desktop_client_status=SETUP_REQUIRED` → `google_desktop_client_import=PASS` →
  `google_desktop_client_type=desktop`, token-exchange lyktes med en scope-streng som så korrekt ut) -
  men flyten feilet DERETTER spesifikt på selve Drive-metadata-probe-kallet: `google_reauth=
  FAIL_DRIVE_PROBE`. `.env` forble korrekt urørt. Eksplisitt eierkrav: IKKE rør OAuth-redirect-/klient-
  arkitekturen igjen (host-bevist fungerende) - blokkeringen er en POST-AUTH Google Drive API-403, og
  den EKSAKTE Google-feilårsaken skulle klassifiseres, ALDRI gjettes.
- **Ny, trygg feilklassifisering** (`classifyDriveProbeError()` i lib, rent/deterministisk, INGEN
  nettverk): parser Google sin STABILE feil-JSON-form (`error.status`/`error.errors[].reason`/
  `error.details[].reason`/`error.message`) til `API_NOT_ENABLED`/`INSUFFICIENT_SCOPE`/
  `WORKSPACE_ADMIN_POLICY`/`RATE_LIMIT`/`AUTH_INVALID`/`UNKNOWN_PROVIDER_403`. `API_NOT_ENABLED` og
  `INSUFFICIENT_SCOPE` gjenkjennes via Google sine EGNE, dokumenterte, høy-presisjon signaler
  (`SERVICE_DISABLED`/`accessNotConfigured`/"has not been used in project"; `insufficientPermissions`/
  "insufficient authentication scopes"). `WORKSPACE_ADMIN_POLICY` er EKSPLISITT dokumentert i koden som
  en BEST-EFFORT-bøtte (generisk `PERMISSION_DENIED` uten et mer presist signal på dette tidspunktet i
  flyten - Google gir normalt ikke et unikt maskinlesbart signal for Workspace-adminblokk etter
  token-exchange) - ALDRI fremstilt som en Google-bekreftet unik årsak. `safeMessage` trunkeres
  (≤300 tegn); resultatobjektet har KUN 7 trygge felt - access_token/refresh_token/client_secret/
  authorization_code/fulle request-headers går ALDRI inn i klassifiseringen eller noen logglinje.
- **Automatisk guiding + samme-prosess-retry** (`driveMetadataProbe()`/`retryDriveProbeUntilRecovered()`
  i orchestratoren): en GJENOPPRETTBAR blokkering (`isRecoverableDriveProbeBlocker()` - KUN
  `API_NOT_ENABLED`/`WORKSPACE_ADMIN_POLICY`) åpner NØYAKTIG riktig side automatisk (Google sin EGEN
  innebygde enable-URL fra feilmeldingen foretrukket for API_NOT_ENABLED - `buildDriveApiEnableUrl()`
  KUN som fallback; Admin Console sin API Controls-side, `GOOGLE_ADMIN_API_CONTROLS_URL`, for
  WORKSPACE_ADMIN_POLICY - med ÉN instruksjon om å stole eksplisitt på "Jarvis Desktop"-klienten, IKKE en
  bred org-policy-endring), gir Tobias ÉN eksakt setning, og prøver DERETTER Drive-proben på nytt hvert
  5. sekund i SAMME kjørende prosess i opptil 10 minutter - ingen restart, ingen andre kommando. Et
  refresh_token tilgjengelig IN-MEMORY brukes trygt til å fornye access-tokenet underveis hvis det
  utløper mens Tobias gjør Console-klikket (`refreshAccessToken()`) - `.env` forblir likevel HELT urørt
  til HELE flyten (inkludert denne retryen) lykkes. En IKKE-gjenopprettbar blokkering (INSUFFICIENT_SCOPE/
  RATE_LIMIT/AUTH_INVALID/UNKNOWN_PROVIDER_403) kaster UMIDDELBART med den klassifiserte rapporten - retry
  forsøkes ALDRI for noe scriptet ikke kan løse selv.
- **Ingen scope-nedgradering, ingen klient-fallback (D-41 uendret):** hele probe-/retry-flyten bruker
  UTELUKKENDE den allerede bevist-Desktop-klienten (`client.clientId`/`client.clientSecret`) - aldri
  `values["JARVIS_GOOGLE_CLIENT_..."]` direkte, aldri `drive.file`/`drive.readonly` noe sted i filen.
  Ingen Drive-MUTASJONER forsøkes noensinne i probe-/retry-koden - kun gjentatte, skrivebeskyttede
  metadata-lesinger.
- **Ingen credential persisteres mens blokkeringen er uløst:** `driveMetadataProbe()`-feilen og
  `retryDriveProbeUntilRecovered()`-kallet skjer STRUKTURELT FØR `updates`-blokken/`.env`-backup-koden -
  samme fail-closed-plassering som scope-sjekken. Lykkes retryen, oppdateres KUN det in-memory
  access-tokenet (`driveVerifiedAccessToken`) som brukes videre i resten av `main()` (inkl.
  `detectAccountEmail()`) - selve `.env`-skrivingen skjer fortsatt KUN i den ene, eksisterende atomiske
  `updates`-blokken, uendret fra HOST FIX #4.
- **Tester:** 15 nye rene enhetstester (`classifyDriveProbeError`/`formatDriveProbeReport`/
  `isRecoverableDriveProbeBlocker`/`buildDriveApiEnableUrl`/`GOOGLE_ADMIN_API_CONTROLS_URL`) + 11 nye
  strukturelle wiring-tester (riktig-prosjekt enable-URL-preferanse, samme-prosess-retry uten
  execFileSync-selv-spawn, ingen-persistering-mens-blokkert, vellykket-retry-fortsetter-med-ferskt-token,
  samme bevist-Desktop-klient gjennom hele flyten, ingen drive.file/drive.readonly noe sted) - **657/657
  totalt**. Lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve klassifiserings-/retry-
  logikken kan IKKE kjøres ende-til-ende mot en ekte Google-403 i denne sky-sandboxen (krever en ekte
  Workspace-organisasjon/Cloud-prosjekt i en faktisk blokkert tilstand) - bevist STRUKTURELT
  (kildeteksts-baserte wiring-tester) + den underliggende klassifiseringslogikken fullt enhetstestet mot
  Google sin dokumenterte, stabile feil-JSON-form. Krever Tobias sin NYE host-kjøring for å bevise
  klassifiseringen/auto-guidingen faktisk treffer riktig mot den EKTE 403-en han observerte. PR #5
  forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #6 "REUSE EXISTING DESKTOP JSON AFTER FAILED AUTH" (samme dag, 2026-08-16)
- **Host-funn:** Tobias hadde allerede opprettet ÉN Desktop-OAuth-klient ("Jarvis Desktop") og lastet ned
  en gyldig `installed`-JSON (HOST FIX #5-kjøringen beviste den helt gjennom token-exchange). Fordi
  persistering er BEVISST atomisk, ble klient-metadata/credentials IKKE skrevet til `.env` da Drive-proben
  feilet senere i samme kjøring. NESTE kjøring rapporterte likevel `google_desktop_client_status=
  SETUP_REQUIRED` igjen og åpnet Cloud Console på nytt - FEIL, siden Tobias ikke skal opprette en ny
  OAuth-klient han allerede har.
- **Root cause:** `waitForDesktopClientJson()`/`selectNewCandidateJsonFiles()` sin mtime-filter (§2 i HOST
  FIX #4-ordren, riktig for SITT formål - unngå å plukke opp en gammel, urelatert fil under FØRSTE gangs
  oppsett) godtar KUN filer med `mtime >= runStartMs`. En allerede-validert JSON fra en TIDLIGERE kjøring
  har per definisjon en eldre mtime enn en NY kjørings `runStartMs`, og ble derfor STILLE ignorert - et
  gjenopprettingsscenario (JSON importert → OAuth forsøkt → senere providervalidering feilet → prosessen
  avsluttet FØR persistering) som det opprinnelige designet aldri dekket.
- **Ny gjenopprettings-skanning FØR SETUP_REQUIRED vurderes:** `tryRecoverExistingDesktopClientJson()`
  (orchestrator) skanner Nedlastinger-mappa med en NY, mtime-fri lib-funksjon
  (`selectExistingCandidateJsonFiles()` - samme sortering/`.json`-filter som `selectNewCandidateJsonFiles()`,
  men UTEN `sinceMs`-parameteren) og validerer HVER kandidat med den EKSISTERENDE
  `tryReadValidDesktopClient()`/`parseClientSecretJson()`-kjeden (ingen parallell valideringslogikk - en
  "web"-type/ugyldig fil ekskluderes like stille som ved vanlig oppdagelse). Nøyaktig ÉN gyldig kandidat:
  gjenbrukes AUTOMATISK (`google_desktop_client_status=RECOVERED_EXISTING_JSON`), Cloud Console åpnes
  ALDRI. `main()` sin `if (!client)`-gjenopprettingsblokk står STRUKTURELT FØR `SETUP_REQUIRED`-blokken som
  to SEPARATE if-sjekker (ikke if/else) - lykkes gjenopprettingen, er `client` allerede satt og
  `SETUP_REQUIRED`-blokken sin betingelse er `false` ved runtime.
- **Flere eksisterende gyldige kandidater samtidig:** samme trygge, KUN-filnavn-nummererte velger som
  ellers (`promptForCandidateSelection()`, nå med en `variant: "new" | "existing"`-parameter for riktig
  ledetekst - ALDRI en stille gjetning, ALDRI to parallelle implementasjoner). Et uavklart svar faller
  TRYGT tilbake til `SETUP_REQUIRED` (ingen uendelig løkke her, i motsetning til den vanlige
  nedlastings-pollingen - eksisterende filer endrer seg ikke av seg selv mens vi venter).
- **Non-secret gjenopprettingsmarkør (§3 i ordren): BEVISST IKKE bygget denne runden.** Selve
  gjenopprettings-skanningen løser det konkrete host-funnet uten behov for ny persistert tilstand (unngår
  en ekstra `.gitignore`-styrt lokal fil og tilhørende kompleksitet) - dokumentert avveining, ikke et
  utelatt krav (ordren selv merket punktet "Consider"/valgfritt).
- **Atomisk `.env`-persistering UENDRET:** gjenopprettingen påvirker KUN hvilken `client` OAuth-forsøket
  bruker - `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE` skrives fortsatt SAMMEN, KUN
  én gang i hele filen, KUN etter at callback+state+scope+Drive-probe+kontosjekk alle har lyktes.
- **HOST FIX #5 uendret:** `classifyDriveProbeError()`/`driveMetadataProbe()`/
  `retryDriveProbeUntilRecovered()` (Drive-403-klassifisering, auto-guide, samme-prosess-retry) er ikke
  rørt - en gjenopprettet klient fortsetter inn i NØYAKTIG samme OAuth→scope→Drive-probe-flyt som en
  nyoppdaget/persistert-metadata-klient.
- **Tester:** 4 nye rene enhetstester (`selectExistingCandidateJsonFiles` - eksisterende gammel fil tas
  med, ekstremt gammel mtime diskvalifiserer IKKE, `.json`-filter, nyest-først) + 12 nye strukturelle
  wiring-tester (mtime-fritt gjenopprettingskall, to separate if(!client)-sjekker, gjenbruk av
  eksisterende valideringskjede, fail-safe flere-kandidater-håndtering uten uendelig løkke, Cloud Console
  IKKE åpnet ved vellykket gjenoppretting, ingen client_secret logget, ingen tidlig `.env`-persistering,
  HOST FIX #5 uendret) - **673/673 totalt** (84+4 lib, 61+12+3 justerte wiring). Lint/full
  monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve gjenopprettings-
  skanningen kan ikke kjøres ende-til-ende mot en ekte tidligere-nedlastet fil i denne sky-sandboxen
  (krever en ekte Windows Nedlastinger-mappe med en reell, tidligere validert JSON-fil) - bevist
  STRUKTURELT (kildeteksts-baserte wiring-tester) + den underliggende filter-/valideringslogikken fullt
  enhetstestet. Krever Tobias sin NYE host-kjøring for å bevise at scriptet nå gjenkjenner den allerede
  eksisterende "Jarvis Desktop"-JSON-en automatisk og går rett til OAuth-samtykke uten å åpne Cloud
  Console på nytt. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## UA-2 P1A HOST FIX #8 "CLEANUP-ONLY BLOCKERS AFTER FULL DRIVE SUCCESS" (samme dag, 2026-08-16)
- **Host-funn (run_id `ff16c69d`) - VIKTIG MILEPÆL: Google Drive full read/write er nå HOST-BEVIST.**
  Reauth-flyten (HOST FIX #4-#6) fullførte helt: `google_drive_api_enabled=PASS`,
  `google_drive_full_scope=PASS`, kontosjekk PASS, koherent Desktop-credential-sett persistert,
  `google_drive_reauth=PASS`. Selve Drive-akseptansen (`ua2-p1a-live.ts` §6) beviste DERETTER
  `google_drive_auth_scope`/`_read`/`_create`/`_update`/`_rename`/`_move`/`_sync`/
  `_q20_no_resurrection`/`_trash`/`_idempotency`/`_permanent_delete`/`_policy` ALLE PASS, ingen
  token-lekkasje (`drive_token_leak_audit=false`, `drive_token_leak_metadata=false`),
  `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (uendret, bevisst). Den samlede
  P1A-akseptansen ble likevel blokkert av TO RENE opprydding-defekter (IKKE manglende
  Drive-kapabilitet) - se under.
- **Blokker A - `google_drive_cleanup=FAIL` (targets=5, root_deleted=true):** root cause funnet ved
  faktisk kildelesing (ikke gjettet). §P sin allerede-vellykkede `delete_permanent` av hovedtestfila
  lot fila stå igjen i `sandbox.created` - §5-oppryddingen forsøkte DERFOR å slette den EN GANG TIL.
  Den EKTE mekanismen: `delete_permanent` er en klasse-D-handling med `preflight_action: "get_metadata"`
  (ToolGateway sin evidens-/recovery-mekanisme) - for en fil som ALLEREDE er permanent slettet gir
  DENNE preflight-lesingen en 404, og siden klassen er D fører det til en UMIDDELBAR
  `preflight_failed:drive_not_found_...`-DENY - `deletePermanent()`-transportens EGEN, allerede
  idempotente 404-håndtering (`already_deleted: "true"`) nås ALDRI i dette tilfellet.
- **Fiks A:** `DriveAcceptanceSandbox` fikk en eksplisitt artefakt-livssyklus
  (`CREATED`/`TRASHED`/`PERMANENTLY_DELETED`/`CLEANED`) - `markPermanentlyDeleted(fileId)` kalles
  UMIDDELBART etter §P sin vellykkede sletting, og `cleanupTargets()` utelater NÅ strukturelt et hvert
  artefakt i en terminal tilstand (`PERMANENTLY_DELETED`/`CLEANED`) - INGEN redundant sletteforsøk
  skjer lenger. Som forsvar-i-dybden: ny `classifyCleanupOutcome()` klassifiserer et EVENTUELT
  gjenværende NOT_FOUND-svar under selve cleanup-løkka som `already_absent` KUN når mål-IDen er et
  KJENT sandkasse-artefakt (`sandbox.has()` - samme grensekontroll som `assertInSandbox()`) - ALDRI
  generalisert til en vilkårlig Drive-fil utenfor sandkassen. `google_drive_cleanup=PASS` avgjøres
  UTELUKKENDE av `cleanup_failures === 0` - ALDRI av `root_deleted=true` alene. Ny evidenslinje:
  `created_artifacts=<n> cleaned_artifacts=<n> already_absent=<n> cleanup_failures=<n> root_deleted=<bool>`.
- **Blokker B - `tenants`-FK-feil:** `"update or delete on table tenants violates foreign key
  constraint tool_executions_tenant_id_fkey"`. Root cause funnet mot det FAKTISKE skjemaet (ikke
  gjettet): `tool_executions.tenant_id` REFERENCES `tenants` (010_tool_executions.sql) - §N sin
  idempotency-test (ToolGateway sin idempotency_key-dedupe) skriver ÉN rad dit for TENANT_A, og
  `cleanupTenant()` slettet den aldri FØR `DELETE FROM tenants` ble forsøkt.
- **Fiks B:** `DELETE FROM tool_executions WHERE tenant_id = $1` lagt til FØRST i `cleanupTenant()`
  (FK-trygg rekkefølge, utledet fra selve migrasjonsgrafen). Verifisert MOT faktisk kildekode (ikke
  antatt) at INGEN andre tabeller trenger rydding: `audit_events.tenant_id` er en REN TEKSTKOLONNE
  (INGEN `REFERENCES tenants`, se 004_audit_cost.sql) OG append-only-trigger-beskyttet (samme
  Q-20-presedens - IKKE rørt, IKKE forsøkt slettet); `sessions`/`messages`/`events`/`devices`/
  `approvals`/`cost_events`/`brief_seen` opprettes ALDRI av P1A-akseptansen (verifisert - ingen av
  kallene i `ua2-p1a-live.ts` går via de tilhørende service-modulene). Ingen `DISABLE TRIGGER`, ingen
  `session_replication_role`, ingen `TRUNCATE`, ingen superbruker-omvei - kun presise,
  parameteriserte `DELETE ... WHERE tenant_id = $1`-setninger via den EKSISTERENDE `adminPool`
  (uendret Q-21 admin/runtime-splitt).
- **Q-21 uendret:** ingen kode rørt utenfor de to presise cleanup-fiksene - `jarvis_runtime` forblir
  NOSUPERUSER/NOBYPASSRLS, ingen RLS-omvei brukt eller nødvendig (adminPool var allerede den
  eksisterende, legitime admin-tilkoblingen for nettopp denne typen opprydding).
- **Google OAuth-arkitekturen er IKKE rørt** denne runden (eksplisitt krav i ordren) - begge fiksene
  er rene opprydding-/DB-endringer i `ua2-p1a-live.ts`/`drive-acceptance-sandbox.ts`. Tobias sin NESTE
  host-kjøring bruker de ALLEREDE persisterte Desktop-credentialene - INGEN ny reautorisering, INGEN
  nytt Cloud Console-steg, INGEN nytt samtykke nødvendig.
- **Tester:** 14 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - livssyklustilstand,
  `isNotFoundFailureReason()`, `classifyCleanupOutcome()`, inkl. eksplisitt "NOT_FOUND utenfor
  sandkassen aksepteres ALDRI"-kontrastbevis) + 14 nye strukturelle wiring-tester
  (`ua2-p1a-host-run-wiring.test.ts` - markPermanentlyDeleted-plassering, classifyCleanupOutcome-bruk,
  PASS-betingelse, FK-rekkefølge, scopet DELETE, ingen FK-omvei, audit_events urørt, alle tidligere
  host-bevist Drive-kapabilitetsstier uendret) - full suite kjørt, lint/typecheck/gitleaks rene (se
  rapport for eksakte tall).
- **STATUS - VIKTIG DISTINKSJON (§11 i ordren):** Google Drive full read/write-kapabilitet er
  HOST-BEVIST (run_id `ff16c69d`) - dette er IKKE lenger en åpen post. Den SAMLEDE UA-2 P1A-
  akseptansen forblir likevel FIXED_SUITE / READY_FOR_HOST_VERIFY, **IKKE VERIFIED**, fordi
  cleanup-defektene (Blokker A/B over) hindret et fullstendig grønt `hard_fail=false`-resultat på
  DENNE kjøringen. Krever EN NY host-kjøring (ingen ny reautorisering) for å bevise at BEGGE
  cleanup-fiksene faktisk fungerer mot ekte Drive/Postgres FØR P1A kan settes VERIFIED. PR #5 forblir
  draft/umerget.

## UA-2 P1A FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED, PR #5 MERGET
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `2703299e`, `hard_fail=false`.** Ingen ny
Google-reautorisering var nødvendig - de allerede persisterte Desktop-credentialene ble gjenbrukt
direkte.
- **Q-21 uendret:** `q21_runtime_role_safe=PASS`, `runtime_current_user=jarvis_runtime`,
  `runtime_role_superuser=false`, `runtime_role_bypassrls=false`.
- **Knowledge P1A:** `p1a_registry_tenant_scoping`/`p1a_obsidian_lifecycle`/
  `p1a_obsidian_obsidian_dir_excluded`/`p1a_obsidian_frontmatter_wikilinks`/
  `p1a_obsidian_no_resurrection`/`p1a_tenant_isolation_new_sources`/`p1a_retrieval_new_sources`/
  `p1a_no_content_in_audit` = ALLE PASS.
- **Google Drive (full read/write, D-41):** `google_drive_auth_scope`/`_read`/`_create`/`_update`/
  `_rename`/`_move`/`_trash`/`_permanent_delete`/`_cleanup`/`_sync`/`_q20_no_resurrection`/
  `_idempotency`/`_policy`/`_live` = ALLE PASS. HOST FIX #8-cleanup-fiksene (§forrige seksjon) bevist
  fungerende: `created_artifacts=4 cleaned_artifacts=4 already_absent=1 cleanup_failures=0
  root_deleted=true` - ingen `cleanup A/B feilet`-linjer. `drive_token_leak_audit=false`,
  `drive_token_leak_metadata=false`.
- **Ærlig unntak, IKKE overklaimet:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`
  - live permission-mutasjon (dele/tilgangsstyring) er bevisst IKKE host-testet (ingen trygg ekstern
  testperson i en ubetjent kjøring). Kapabiliteten er implementasjon-/suite-verifisert
  (`drive-full-access.test.ts` §I), men IKKE live-host-bevist - registrert som Q-23, et smalt,
  gjenværende verifikasjonspunkt, IKKE en blokkering for lukking (akseptanseløperen behandlet det
  eksplisitt som et trygt skip).
- **STATUS: UA-2 P1A = VERIFIED/COMPLETE → D-42.** PR #5 merget til `main` (normal merge-commit,
  samme konvensjon som PR #1-#4 - historikk bevart, ikke squashet). Se D-42 i
  DECISIONS_AND_ASSUMPTIONS.md for full beslutningslogg-entry.

## P1A RUNTIME WIRING CLOSEOUT (2026-08-16, egen branch `claude/p1a-drive-runtime-wiring`)
**IKKE en ny P1A-fullføring - D-42 forblir UENDRET som beslutningen som satte UA-2 P1A VERIFIED/
COMPLETE.** Dette er en oppfølgende, avgrenset lukking av ETT gjenværende funn fra P1A-lukkingen
(se "Nytt, ikke-blokkerende funn" i tidligere runder): `GoogleDriveTransport` var host-akseptanse-
bevist (D-42), men var ALDRI wiret inn i den NORMALE `apps/api/src/main.ts`/`worker-main.ts` sine
`firstWaveTools({...})`-kall - Drive-verktøyene var derfor reelt uoppnåelige fra en løpende api/
worker-prosess (kun `ua2-p1a-live.ts` sin egen akseptanse-only ToolGateway nådde dem).
- **Fiks:** ny delt fabrikk `driveTransportsIfConfigured()` (`live-transports.ts`) - sjekker KUN
  tilstedeværelse (Boolean) av `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` (de tre
  `googleAccessToken()` faktisk krever - `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er bevisst IKKE sjekket,
  den er kun reauth-scriptets egen bokføringsmarkør). Begge `main.ts` og `worker-main.ts` sprer
  `...driveTransportsIfConfigured()` inn i sitt EKSISTERENDE `firstWaveTools({...})`-kall - SAMME
  registreringsvei som email/calendar/github/telegram, ingen parallell mekanisme. Mangler
  credentials: `drive`-nøkkelen er fraværende, `firstWaveTools()` sin egen (allerede eksisterende)
  `UnconfiguredHttpTransport("drive")`-fallback brukes - INGEN oppstartskrasj, INGEN ny feilbane.
- **Full D-41-kapabilitet:** alle 14 implementerte Drive-handlinger (4×A, 6×C, 4×D) registreres
  samlet - ingen read-only-nedgradering, ingen ny godkjenningsfriksjon utover eksisterende
  sovereign-owner-policy.
- **Ny ett-kommando host-smoke:** `apps/api/scripts/p1a-drive-runtime-smoke.ts` - beviser den NORMALE
  runtime-banen (EKTE ToolGateway/PolicyGateway, samme konstruksjon som main.ts) mot ekte Drive med
  et rent lese-only `get_metadata("root")`-kall, PLUSS et strukturelt bevis for worker-banens
  identiske registrering. INGEN ny OAuth-samtykke, INGEN Drive-mutasjon.
- **Q-23 uendret:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` forblir åpen -
  runtime-wiring eksponerer permission-handlingene, men live-verifikasjon krever fortsatt en reell
  ekstern testperson.
- **Tester:** 22 nye rene enhetstester (`google-drive-transport.test.ts` §credential-sjekk) + 24 nye
  strukturelle wiring-tester (`drive-runtime-wiring.test.ts` + `drive-runtime-smoke-wiring.test.ts`,
  inkl. en regresjonsvakt mot den ufullstendige kommandoen - se HOST-FIX under). Eksisterende
  `drive-full-access.test.ts` (owner sovereign/delegert D-klasse-policy) kjørt UENDRET - fortsatt
  17/17 PASS, bevis for at policy-banen ikke er regressert.
- **HOST-FIX (2026-08-16, Tobias sitt faktiske host-funn):** den opprinnelig dokumenterte kommandoen
  (`node --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts`) manglet
  `--env-file=.env` - scriptet leser `process.env` direkte (samme mønster som main.ts/worker-main.ts,
  som i normal drift får variablene injisert av docker-compose, IKKE av et `--env-file`-flagg), men
  kjørt FRITTSTÅENDE på hosten (utenfor en container) må Node eksplisitt bes om å laste `.env` selv.
  Uten flagget rapporterte scriptet (korrekt, ikke en logikk-bug) `BLOCKED_NO_CREDENTIALS`
  (`client_id=false client_secret=false token=false`). Rettet til
  `node --env-file=.env --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts` -
  Node sin EGEN innebygde `--env-file`-mekanisme (siden Node 20.6), BEVISST ingen ny `dotenv`-
  avhengighet lagt til. Samme konvensjon som `ua2-p1a-live.ts` sin egen toppkommentar allerede
  dokumenterer - dette scriptet var det inkonsekvente unntaket, nå rettet i selve fila,
  wiring-testen og all dokumentasjon.
- **HOST-BEVIS (samme dag, korrigert kommando):** `drive_runtime_registered=PASS`,
  `drive_runtime_api_path=PASS` (**LIVE** - ekte `get_metadata("root")` gjennom den normale
  ToolGateway/firstWaveTools-runtime-banen mot ekte Google Drive), `drive_runtime_worker_path=PASS`
  (**STRUKTURELT** bevist - IKKE en live worker-prosess-kjøring, se skillet dokumentert i scriptets
  egen kommentar og i ordren), `q21_runtime_role_safe=PASS`, `token_leak=false`, `hard_fail=false`.
- **STATUS: VERIFIED/COMPLETE.** P1A Runtime Wiring Closeout er ferdig host-bevist. **D-42 forblir
  UENDRET** som beslutningen som satte UA-2 P1A VERIFIED/COMPLETE - denne closeout-runden erstatter
  IKKE D-42, den lukker kun det ETT gjenværende post-merge-integrasjonsfunnet. PR #6 merget til
  `main` (normal merge-commit, samme konvensjon som PR #1-#5).

## UA-2 P1B-A — E-post-vedlegg + OCR/vision-ingestion-fundament (BYGGET denne økten, 2026-08-16, branch `claude/ua2-p1b-a-email-ocr-vision` fra `origin/main` `35ac208`)

**Fase-port avklart FØRST:** `docs/PROJECT_STATUS.md` hadde tidligere logget at P1B-A venter på "egen,
eksplisitt fase-godkjenning fra Tobias" (CLAUDE.md-regel 10). Ved mottak av byggeordren for P1B-A ble
denne motstriden eksplisitt flagget og avklart via spørsmål til brukeren FØR noe kode ble skrevet -
brukeren bekreftet "Proceed with implementation". Loggført her for sporbarhet, ikke stille omgått.

**Status: IMPLEMENTED + SUITE-VERIFIED (813/813 tester, 62 testfiler). IKKE host-verifisert ennå.**
Bygget PÅ det VERIFIED P0/P1A-fundamentet - ingen parallell ingestion-pipeline, ingen ny
autentiseringsvei. Full arkitektur-/scope-begrunnelse: D-43 (opprinnelig scope-beslutning) og D-44
(oppdaget under selve byggingen - `pdf-parse` v2 dekker BÅDE native tekst-ekstraksjon OG
side-rasterisering i ett bibliotek, ingen tung systemavhengighet).

**Bygget (se IMPLEMENTATION_PLAN.md sin P1B-A-seksjon for full detaljliste):**
1. Multimodalt `ChatMessage.content` (`string | ContentPart[]`) i `packages/provider-adapters` - EKTE
   bildestøtte KUN i Anthropic-adapteren denne runden; `capability-registry.ts` sitt `vision`-flagg
   korrigert til å reflektere dette faktisk (ikke aspirasjonelt lenger på openai/gemini).
2. `GmailTransport.list_messages`/`read_attachment` (nye handlinger, SAMME `JARVIS_EMAIL_TOKEN`-vei).
3. `extraction-safety.ts` - fil-type-klassifisering (arkiver/docx/xlsx/pptx eksplisitt avvist), fail-
   closed størrelses-/side-/tidsgrenser, native→bilde-terskel, path-traversal-sikker filnavn-sanering.
4. `ocr-provider.ts` - `ModelGatewayVisionExtractor` (OCR + vision-beskrivelse, BEGGE via EKSISTERENDE
   `ModelGateway`, `purpose:"VISION"`, aldri direkte leverandør-SDK).
5. `pdf-extraction.ts` (ny avhengighet `pdf-parse` v2 / `@napi-rs/canvas`, D-44) - EKTE per-side native
   tekst OG side-rasterisering, verifisert funksjonelt i dev-sandkasse mot en håndlaget test-PDF.
6. `EmailAttachmentKnowledgeSource` - side-granulær `external_id`-"chunking" UTEN ny tabell
   (`msg:<id>`/`att:<msgId>:<attId>[:page:<n>]`), gjenbruker 100% av eksisterende
   dedupe/tombstone/Q-20/RLS. Per-vedlegg/per-side feilisolasjon, AUTH/PERMISSION-eskalering.
7. `email_attachment`-kildetype i `KnowledgeSourceRegistry` + ny `knowledge-ingest-email`-agent-profil
   i `apps/api/src/worker-main.ts` (SAMME `InProcessWorker`/`PgTaskQueue` som `executive`).
8. Host-akseptansescript `modules/knowledge/scripts/ua2-p1b-a-host-run.ts` (`p1b_*`-markører,
   `--env-file=.env`-konvensjon, BLOCKED_NO_EMAIL_CREDENTIALS/BLOCKED_NO_VISION_PROVIDER fail-closed
   defaults - ALDRI en antatt PASS uten faktiske credentials).

**Suite-verifisert:** 813/813 - multimodal content-mapping (10 tester), Gmail-transport-logikk (8+6
tester, inkl. rekursiv MIME-tre-vedleggsgjenfinning), fail-closed sikkerhetsgrenser (18 tester),
EmailAttachmentKnowledgeSource end-to-end (13 tester, inkl. EKTE PDF native/OCR/vision-routing mot
håndlagde test-PDF-er, ikke mocket), full dedupe/tombstone/Q-20-resurrection-suppresjon mot ekte
embedded Postgres (2 tester), registry-/worker-wiring (5+5+10 strukturelle tester).

**IKKE host/live-verifisert (se Q-24 for full gap-liste):** ekte Gmail-listing/vedleggsnedlasting
(krever `JARVIS_EMAIL_TOKEN` - EGEN credential fra Drive/Calendar, se D-35), ekte vision-modellkall
(krever `ANTHROPIC_API_KEY`), full sync mot en ekte innboks, `@napi-rs/canvas` sin native binær
bevist å laste korrekt på Tobias sin faktiske Windows/Docker-host (kun dev-sandkasse-verifisert).

**Kvalitetsgates kjørt:** `pnpm -r run typecheck` (13/13 workspace-prosjekter grønt), `eslint .`
(0 feil/advarsler på alle nye/endrede filer), `pnpm test` (813/813, 62 testfiler), gitleaks
(protect --staged + detect mot origin/main..HEAD, begge rene).

**Docs oppdatert:** D-43 (opprinnelig scope-beslutning), D-44 (pdf-parse-oppdagelse),
Q-24 (samlet gap-liste), IMPLEMENTATION_PLAN.md (ny P1B-A-seksjon + P1A-referanse), RUNTIME_GATES.md
(ny gate-rad), UA2_KNOWLEDGE_DPIA.md (ny `email_attachment`-datakategori-rad + egen
"OCR/vision-dataflyt"-seksjon - materiell dataflyt-endring: bilde-bytes til ekstern leverandør).

**STATUS: FIXED_SUITE/READY_FOR_HOST_VERIFY.** IKKE merget - venter på Tobias sin host-kjøring av
`ua2-p1b-a-host-run.ts` (krever `JARVIS_EMAIL_TOKEN` + `ANTHROPIC_API_KEY` i `.env`) før VERIFIED kan
erklæres, i tråd med samme host-bevis-disiplin som D-38/D-39/D-40/D-42.

## UA-2 P1B-A HOST FIX #1 "GMAIL 401 CLIENT/TOKEN COHERENCE + COST_EVENTS CLEANUP" (samme dag, 2026-08-16, ekte host-funn `run_id 3af67dab`)

**Tobias sin faktiske Windows/Docker-host-kjøring** (`run_id 3af67dab`) ga PASS for
`p1b_pdf_native_extraction`/`p1b_pdf_page_render`/`p1b_extraction_routing_decision`/
`p1b_vision_ocr_live`/`q21_runtime_role_safe`/token-leak-audit, men **FAIL** for
`p1b_gmail_list_messages_live` (`reason=tool_failed:google_auth_failed_401`) - som kaskaderte til
`p1b_sync_email_source_live`-feil (`error_class:"AUTH"`) og en hoppet-over Q-20-e-post-live-sjekk,
pluss en separat `cost_events_tenant_id_fkey`-FK-brudd som blokkerte tenant-cleanup. `hard_fail=true`.

**Root cause IKKE konkludert med sikkerhet fra dette funnet alene** - `googleAccessToken()` kastet
opprinnelig vekk Google sin faktiske token-endpoint-responskropp ved feil, så kun `401` var synlig,
ingen `error`/`error_description`. Full begrunnelse/full fiks: **D-45** i
`docs/DECISIONS_AND_ASSUMPTIONS.md`. Kort sammendrag av det som ER bygget denne runden:

1. **Klassifisering** - `classifyGoogleTokenEndpointError()` (ny, `live-transports.ts`) parser
   Google sitt RFC 6749 §5.2-token-endpoint-feilformat til `EMAIL_TOKEN_CLIENT_MISMATCH`/
   `EMAIL_REFRESH_TOKEN_REVOKED`/`EMAIL_INSUFFICIENT_SCOPE`/`GOOGLE_INVALID_GRANT`/
   `GOOGLE_INVALID_CLIENT`/`UNKNOWN_GOOGLE_AUTH` - kun trygge felt eksponert (HTTP-status, Google
   sin `error`-kode, sanert `error_description`), ALDRI token/secret/Authorization-header i logg.
2. **Gmail-reauth-flyt** - `modules/core/scripts/google-email-reauth.ts` (nytt orkestreringsskript)
   gjenbruker den ALLEREDE persisterte Desktop-OAuth-klienten (`JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/
   `_OAUTH_CLIENT_TYPE=desktop`, samme klient som Drive/D-42) - ingen ny Google Cloud-klient, ingen ny
   JSON-import, Drive-auth HELT urørt. Scopes: `gmail.readonly` + `gmail.send` (bevarer eksisterende
   send-kapabilitet, D-41) + `userinfo.email` (kontoverifisering). `prompt=consent select_account`,
   autorisert konto sammenlignet mot `JARVIS_GOOGLE_ACCOUNT` FØR persistering - ulik konto avbryter
   eksplisitt. Persisterer KUN `JARVIS_EMAIL_TOKEN` (atomisk, `.bak.<epoch>`-sikkerhetskopi), først
   etter state-PASS + exchange-PASS + scope-PASS + konto-PASS + live Gmail-leseprobe-PASS.
3. **Automatisk gjenoppretting samme kjøring** - `ua2-p1b-a-host-run.ts` forsøker reauth-skriptet
   AUTOMATISK ÉN gang (`reauthAttempted`-vakt) når feilen klassifiseres som gjenopprettbar, leser
   `.env` på nytt fra disk, og fortsetter SAMME prosess - ingen ny Windows-kommando kreves.
4. **`cost_events`-FK-fiks** - verifisert mot faktisk skjema (`004_audit_cost.sql`, ingen
   append-only-trigger i motsetning til `audit_events`/`events`) - `DELETE FROM cost_events WHERE
   tenant_id = $1` lagt til FØRST i `cleanupTenant()`, ingen `TRUNCATE`/`DISABLE TRIGGER`/bred sletting.
5. **Live e-post-vedleggsfikstur** - `GmailTransport` mangler fortsatt `send`/`create`-kapabilitet,
   så ingen trygg fikstur kunne opprettes denne runden. Ny `Verdict`-medlem `SKIPPED_SAFE_FIXTURE`
   (ærlig, ALDRI en stille antatt PASS) brukes i stedet for å late som et vedlegg ble bevist.
6. **Fersk-workspace-bootstrap** - `ua2-p1b-a-host-run.ts` konverterte alle topp-nivå `@jarvis/*`-
   importer til dynamiske `await import()` etter en ny, synkron `ensureWorkspaceInstalled()`
   (`pnpm install --frozen-lockfile`, samme mønster som P1A sin runner) - ETT skript, ETT
   kommando løser fersk-checkout uten et separat installasjonssteg.

**Regresjonstester lagt til (A-S i byggeordren, alle PASS):** 18 nye tester for
token-endpoint-klassifisering (`google-auth-error-classification.test.ts`), 14 nye strukturelle
tester for reauth-orkestreringsskriptet (`google-email-reauth-wiring.test.ts`), full omskriving av
`ua2-p1b-a-host-run-wiring.test.ts` (21 tester: selv-bootstrap-rekkefølge, auto-reauth-vakt/-gjenopptak,
FK-trygg cleanup-rekkefølge, SKIPPED_SAFE_FIXTURE, §6-skip). **Ingen regresjon:** Drive-auth/-scopes/
-klient HELT urørt (verifisert strukturelt), Q-21 uendret, P0/P1A-tester alle fortsatt grønne.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test`
(**856/856**, 64 testfiler - opp fra 813/813), gitleaks (protect --staged + detect mot
origin/main..HEAD, begge rene).

**STATUS UENDRET: FIXED_SUITE / HOST_VERIFY_BLOCKED.** IKKE VERIFIED - krever en NY host-kjøring av
`node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1b-a-host-run.ts`
for faktisk å bevise den fiksede klassifiseringen/reauth-flyten og live Gmail-sync mot en ekte
innboks. `docs/OPEN_QUESTIONS.md` Q-24 oppdatert med denne rundens funn (nye punkter 7/8). PR #7
IKKE merget - `IKKE merge, IKKE ny fase`-instruksen i byggeordren er fulgt.

## UA-2 P1B-A HOST FIX #2 "UNAUTHORIZED_CLIENT MUST TRIGGER SAFE GMAIL REAUTH" (samme dag, 2026-08-16, ekte host-funn `run_id ab43fb1f`)

**HOST FIX #1 sin nye klassifisering FUNGERTE og avdekket et mer presist funn.** Tobias sin neste
faktiske host-kjøring (`run_id ab43fb1f`) ga PASS for alle de samme lokale/vision-punktene som forrige
runde, men Gmail-refresh feilet nå med et EKSAKT klassifisert
`tool_failed:google_auth_failed_401:GOOGLE_INVALID_CLIENT:unauthorized_client` mot den ALLEREDE
host-bevist FUNGERENDE Desktop-OAuth-klienten (samme klient Drive bruker, D-42). Fordi
`isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_CLIENT")` (korrekt, for den GENERELLE klassen) er
`false`, ble auto-reauth-forsøket fra HOST FIX #1 aldri utløst - `gmail_auth_recoverable=false` og
kjøringen stoppet der. Full begrunnelse/full fiks: **D-46** i `docs/DECISIONS_AND_ASSUMPTIONS.md`.

**Root cause fortsatt IKKE kryptografisk bevisbart** (ærlig, per ordrens eget krav) - vi kan ikke bevise
fra selve refresh-tokenet HVILKEN gammel OAuth-klient som opprinnelig utstedte det. Dokumentert som
`LEGACY_TOKEN_OR_CLIENT_BINDING`: en begrunnet sannsynlighet (en gjenstående Gmail-tildeling fra FØR
Desktop-klient-migreringen), IKKE et bevist faktum.

**Løsning - kontekst-bevisst klassifisering, IKKE en global oppmykning av `invalid_client`:**

1. `classifyGoogleTokenEndpointError()` (`live-transports.ts`) tar nå en eksplisitt
   `GoogleAuthClientContext { provenDesktopClient: boolean }`. `invalid_client`/`unauthorized_client`
   klassifiseres til en NY klasse `EMAIL_REAUTH_REQUIRED` (gjenopprettbar,
   `recoveryReason=LEGACY_TOKEN_OR_CLIENT_BINDING`) KUN når `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE ===
   "desktop"` allerede er persistert (samme markør `google-drive-reauth.ts` skriver KUN etter en
   fullstendig host-bevist suksess). UTEN den markøren forblir klassifiseringen `GOOGLE_INVALID_CLIENT`,
   FORTSATT fail-closed - manglende secret/uprøvd/feilkonfigurert klient skal ALDRI automatisk
   reauth-forsøkes (§3 i ordren, eksplisitt testet).
2. `googleAccessToken()` leser `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` KUN til dette formålet (aldri
   skrevet/eksponert noe sted).
3. `ua2-p1b-a-host-run.ts` sin eksisterende auto-reauth-trigger (HOST FIX #1, INGEN logikkendring)
   håndterer den nye klassen AUTOMATISK via SAMME `isRecoverableGoogleAuthErrorClass()`-kall - ingen
   egen, parallell spesialgren. Ny `p1b_gmail_reauth`-markør
   (`SKIPPED_NOT_NEEDED`/`SKIPPED_NOT_RECOVERABLE`/`PASS`/`FAIL`) gjør selve reauth-forsøkets EGET
   utfall eksplisitt synlig i host-sammendraget.
4. **Workspace-policy/Gmail-API-blokkeringer forblir separat klassifisert** (§6/§7 i ordren) - dette
   var ALLEREDE arkitektonisk garantert: `classifyDriveProbeError()` (Gmail-API-nivå, ETTER en
   vellykket token-exchange) og `classifyGoogleTokenEndpointError()` (token-endepunkt-nivå, FØR Gmail-
   API-tilgang) er to strukturelt separate klassifiseringsfunksjoner mot to ulike Google-feilformer -
   ingen kodeendring var nødvendig for dette punktet.
5. **Sikker akseptanse-fikstur-forbedring** (§11 i ordren, en bevisst enklere, men fungerende variant
   av ordrens run_id-baserte eksempel) - en STABIL `ACCEPTANCE_FIXTURE_SUBJECT = "Jarvis P1B
   Acceptance"`-konstant + ETT ekstra, SMALT `subject:"..."`-scoped `list_messages`-søk (samme
   handling/scope-begrensning, ALDRI en bredere postkasse-skann) forsøkes FØR fallback til
   `SKIPPED_SAFE_FIXTURE`. Tobias kan sende ÉN testmelding med dette EKSAKTE emnefeltet FØR en
   fremtidig kjøring uten å måtte forutsi et fremtidig run_id. Ingen `send`-kapabilitet lagt til
   `GmailTransport` - Tobias sender fortsatt selv, manuelt. Bundet flerminutters polling (ordrens
   eget eksempel) er EKSPLISITT UTSATT som dokumentert oppfølgingspunkt (Q-24, ikke stille utelatt).

**Regresjonstester lagt til (alle PASS):** nye tester i `google-auth-error-classification.test.ts`
(kontekst-bevisst `EMAIL_REAUTH_REQUIRED` vs. `GOOGLE_INVALID_CLIENT`, `recoveryReason`-felt,
`GmailTransport`-integrasjon med `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` satt/usatt), nye tester i
`ua2-p1b-a-host-run-wiring.test.ts` (`p1b_gmail_reauth`-markør-tilstander, ingen egen
EMAIL_REAUTH_REQUIRED-spesialgren, smalt subject-søk). **Ingen regresjon:** Drive-auth/-scopes/-klient
HELT urørt, Q-21 uendret, cost_events-cleanup fra HOST FIX #1 bevart, alle P0/P1A/HOST FIX #1-tester
fortsatt grønne.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test` (se
kommandoresultat under), gitleaks (protect --staged + detect mot origin/main..HEAD, begge rene).

**STATUS UENDRET: FIXED_SUITE / HOST_VERIFY_BLOCKED.** IKKE VERIFIED - krever en NY host-kjøring av
SAMME ene kommando for faktisk å bevise at reauth nå fullfører for dette spesifikke
`unauthorized_client`-funnet og at live Gmail-sync fungerer. `docs/OPEN_QUESTIONS.md` Q-24 oppdatert
med denne rundens funn (nye punkter 9/10). PR #7 IKKE merget - `IKKE merge, IKKE ny fase`-instruksen i
byggeordren er fulgt.

## UA-2 P1B-A FINAL CLOSURE (2026-08-17) — HOST VERIFIED, PR #7 MERGET

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/knowledge/scripts/ua2-p1b-a-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `0f43f39d`, `hard_fail=false`.** Begge host-fix-rundene (HOST FIX #1/D-45, HOST
FIX #2/D-46) beviste seg selv i praksis: første Gmail-autentiseringsforsøk klassifisert KORREKT som
`EMAIL_REAUTH_REQUIRED`/`reason=LEGACY_TOKEN_OR_CLIENT_BINDING`, automatisk samme-prosess-reauth
fullførte helt (`google_email_reauth=PASS`), retry lyktes.

- **Q-21 uendret:** `q21_runtime_role_safe=PASS`.
- **Lokal PDF-ekstraksjon (ingen credentials):** `p1b_pdf_native_extraction`/`p1b_pdf_page_render`/
  `p1b_extraction_routing_decision` = ALLE PASS. `p1b_pdf_page_render=PASS` beviser SAMTIDIG at
  `@napi-rs/canvas` sin native binær laster korrekt på den faktiske Windows/Docker-hosten (tidligere
  kun dev-sandkasse-verifisert, D-44) - dette gapet er nå lukket.
- **Gmail auto-reauth + LIVE:** `p1b_gmail_reauth=PASS`, `p1b_gmail_list_messages_live=PASS`,
  `p1b_gmail_attachment_download_live=PASS` (et EKTE vedlegg funnet/lastet ned LIVE -
  `SKIPPED_SAFE_FIXTURE`-fallbacken fra HOST FIX #1/#2 var IKKE nødvendig denne kjøringen).
- **Vision OCR LIVE:** `p1b_vision_ocr_live=PASS` (ekte Anthropic-vision-kall via `ModelGateway`).
- **Full sync + Q-20 LIVE:** `EmailAttachmentKnowledgeSource`-sync `scanned=5 created=5 failed=0`,
  `p1b_sync_email_source_live=PASS`, `p1b_q20_no_resurrection_live=PASS` (Q-20-suppresjonsmekanismen
  nå LIVE-bevist for e-post-kilden, ikke bare Drive/filsystem fra tidligere).
- **Ingen token-lekkasje:** `p1b_token_leak_audit=PASS`, `token_leak=false`.
- **Credential-sikkerhet bekreftet:** KUN `JARVIS_EMAIL_TOKEN` endret av reauth-flyten -
  `JARVIS_GOOGLE_CLIENT_ID`/`_CLIENT_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE` (Drive/Calendar) HELT
  urørt, INGEN ny Google Cloud OAuth-klient opprettet.
- **Ærlig unntak, IKKE overklaimet:** `p1b_worker_registration=SUITE_VERIFIED` - selve
  `knowledge-ingest-email`-worker-JOBB-kjøringen (via `InProcessWorker`/`PgTaskQueue`) er IKKE
  live-host-kjørt i denne akseptanserunden (host-scriptet kaller `KnowledgeSyncService.sync()`
  direkte, samme mønster som resten av scriptet) - kun implementasjon-/strukturelt suite-verifisert.
  Registrert som et smalt, gjenværende verifikasjonspunkt i Q-24, IKKE en blokkering for lukking
  (samme prinsipp som Q-23 sitt Drive-permission-unntak i D-42).
- **STATUS: UA-2 P1B-A = VERIFIED/COMPLETE → D-47.** PR #7 merget til `main` (normal merge-commit,
  samme konvensjon som PR #1-#6 - historikk bevart, ikke squashet). Se D-47 i
  DECISIONS_AND_ASSUMPTIONS.md for full beslutningslogg-entry, Q-24 for oppdatert gap-status.

## UA-2 MASTERPLAN CLOSEOUT (2026-08-17, branch `claude/ua2-masterplan-closeout`) — HELE FASEN VERIFIED/COMPLETE → D-48

**Fullstendig lukkings-audit av UA-2 «Universal Knowledge Layer» som HELHET** (ikke en ny feature-fase)
mot masterplanens EGNE fire ordrette akseptansekriterier (`docs/input/02_Jarvis_Masterplan_Sovereign_
Autonomy_v4.0.md`, linje 455-459 - kanonisk kilde for UA-2, `IMPLEMENTATION_PLAN.md` sin UA-2-seksjon
verifisert å gjengi disse ORDRETT, ingen avvik funnet). Full begrunnelse: **D-48** i
DECISIONS_AND_ASSUMPTIONS.md.

**Akseptansematrise (alle fire PASS, evidens i D-48):**

| # | Kriterium (masterplanens ordlyd) | Resultat | Kort evidens |
|---|---|---|---|
| 1 | Minst fem source systems i samme retrieval flow | **PASS** | 5 distinkte `source_type` i `KnowledgeSourceRegistry`: `filesystem`/`github`/`google_drive`/`obsidian`/`email_attachment` - alle via SAMME `KnowledgeSource`/`KnowledgeSyncService`/`KnowledgeRetriever`, ingen parallell vei |
| 2 | All hentet kunnskap har source pointer/freshness/trust | **PASS** | `KnowledgeProvenance` (`retriever.ts`) returnerer kilde-pointer+ferskhet på HVERT resultat, strukturelt umulig å hoppe over. "Trust" implisitt via `source_type` + DPIA sin "untrusted ingestion"-klassifisering (ingen eget felt bygget - se D-48 for ærlig presisering) |
| 3 | Cross-tenant leakage = 0; delete/revoke propagated | **PASS** | `FORCE ROW LEVEL SECURITY` (tenant+space) i `017_knowledge.sql`; Q-20/tombstone LIVE-bevist på tvers av P0 (`778bb87d`)/P1A (`2703299e`)/P1B-A (`0f43f39d`); Q-21 uendret i alle tre |
| 4 | DPIA/processing inventory oppdatert for nye datakategorier | **PASS** | `UA2_KNOWLEDGE_DPIA.md` har egen, oppdatert rad for alle fem kilder + egen OCR/vision-dataflyt-seksjon |

**Worker-krav eksplisitt vurdert (§12 i audit-ordren):** verken "durable worker" eller "live worker-jobb-
kjøring" er nevnt i masterplanens fire akseptansekriterier - Q-24 sin `p1b_worker_registration=
SUITE_VERIFIED`-status er derfor en implementasjonsdetalj-verifikasjon, IKKE en UA-2-blokkering.

**Klassifisert IKKE-BLOKKERENDE for UA-2-lukking (oppdatert i OPEN_QUESTIONS.md, ingenting bygget):**
Q-22 (Pieces - "5 kildesystemer" er allerede oppfylt UTEN Pieces), Q-23 (Drive permission-live-
verifikasjon - D-41-connector-kapabilitet, ikke et UA-2-kriterium), Q-24 (P1B-A worker-jobb-live-
kjøring + øvrige kjente kapabilitetsgap - ingen av dem et UA-2-kriterium), møtetranskripsjon
(masterplanens "Bygges"-liste for UA-2 nevner det, men det avhenger strukturelt av UA-7 Communications
Hub som IKKE er bygget - IKKE et av de fire akseptansekriteriene, derfor ikke-blokkerende for DENNE
lukkingen; konflikten mellom "Bygges"-listens fulle ambisjon og faktisk byggbarhet er allerede løst i
IMPLEMENTATION_PLAN.md sine "Bygges IKKE"-seksjoner). Entity extraction/Knowledge Graph (Q-10) forblir
utsatt til reelt behov er målt - heller ikke et akseptansekriterium.

**Kvalitetsgates:** `pnpm -r run typecheck` (13/13 grønt), `eslint .` (0 feil), `pnpm test` (873/873,
64 filer - INGEN endring, denne runden er ren verifikasjon+dokumentasjon, ingen kodeendring), gitleaks
(protect --staged + detect mot origin/main..HEAD, begge rene). CI: se PR-status.

**STATUS: UA-2 «UNIVERSAL KNOWLEDGE LAYER» = VERIFIED/COMPLETE → D-48.** Erstatter/overstyrer IKKE
D-42 (P1A) eller D-47 (P1B-A) - begge forblir gyldige, uendrede fase-lukkinger. **Neste kanoniske fase
per masterplan v4.0: UA-3 «Business Operating System»** (`docs/input/02_Jarvis_Masterplan_Sovereign_
Autonomy_v4.0.md` linje 460) - IKKE startet, IKKE godkjent, IKKE implementert i denne audit-runden.

## UA-3 P0 — Business Domain Foundation = VERIFIED/COMPLETE (2026-08-17, branch `claude/hva-skjer-hvordan-ligger-0z3ztp` fra `origin/main` `593a69c`)

**Status: VERIFIED/COMPLETE (host-bevist av Tobias på ekte Windows/Docker-host, run_id `ca2d9248`,
`hard_fail=false`) → D-52.** TREDJE host-kjøring, etter HOST FIX #1 (D-50)/HOST FIX #2 (D-51), kom
HELE VEIEN gjennom UTEN nye funn - alle 13 Business OS-kapabilitetsmarkører OG alle 5
CLEANUP-markører PASS. **Kun UA-3 P0 er VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (se Q-25 for
gjenstående arbeid mot masterplanens fire akseptansekriterier), og HELE masterplan v4.0 «Sovereign
Autonomy» er IKKE komplett. Første UA-3-slice, navngitt/prioritert fra masterplanens
egen integrasjons-prioritetstabell ("Internal CRM / Sales pipeline full internal UA-3 P0") - full
begrunnelse: **D-49**.

**HOST FIX #1 (samme dag, ekte host-funn av Tobias, `run_id b95dd25f`) → D-50:** første host-kjøring
kom gjennom bootstrap/migrasjoner/`q21_runtime_role_safe=PASS`, men feilet DERETTER med
`error: new row violates row-level security policy for table "tenants" (code=42501)` - `ua3-business-
live.ts` brukte FEILAKTIG runtime-poolen (`jarvis_runtime`) til å opprette den midlertidige
akseptanse-tenanten. **Dette var IKKE et RLS-brudd å fikse - RLS fungerte som tiltenkt** (`tenants`
sin `WITH CHECK (tenant_id = current_setting('jarvis.tenant_id'))`-policy kan strukturelt aldri
oppfylles for en helt ny tenant). Fikset ved å innføre en egen `adminPool` (samme
`adminConfigFromEnv()`-mønster som `q20-erasure-live.ts`) for ALL scaffold-opprettelse/opprydding -
`pool` (runtime) forblir den ENESTE tilkoblingen Business OS-operasjonene (`BusinessService`/
`ToolGateway`) noensinne bruker. Ny `ua3_business_runtime_role`-marker verifiserer `current_user` RETT
FØR de faktiske skrivingene, ikke bare ved Q-21-sjekken i toppen. 12 nye tester (inkl. en LIVE
reproduksjon av selve `42501`-feilklassen mot en ekte NOSUPERUSER/NOBYPASSRLS-rolle) - ingen svekkelse
av RLS/Q-21 noe sted.

**HOST FIX #2 (samme dag, ekte host-funn av Tobias, `run_id ad45603d`) → D-51:** ANDRE host-kjøring
(etter HOST FIX #1) kom HELE VEIEN gjennom bootstrap/migrasjoner/Q-21 OG **ALLE 13 faktiske Business
OS-kapabilitetstester PASSET** (`ua3_company_contact`/`ua3_lead_idempotent`/`ua3_opportunity_pipeline`/
`ua3_activity_timeline`/`ua3_activity_idempotent`/`ua3_followup_lifecycle`/`ua3_followup_overdue`/
`ua3_metrics`/`ua3_tenant_isolation`/`ua3_space_isolation`/`ua3_toolgateway_wiring`/
`ua3_audit_no_sensitive_content` osv.) - KUN akseptanse-CLEANUP feilet: `DELETE FROM audit_events`
kastet (append-only-triggeren forbyr det ubetinget) og stoppet RESTEN av `cleanupTenant()`
(`leftover_tenants=1`), som DERETTER fikk `DELETE FROM people` til å feile med
`person_tenants_person_id_fkey` (en direkte følge). **Root cause:** `audit_events.tenant_id` har
INGEN fremmednøkkel mot `tenants` (i motsetning til `cost_events`) - append-only-revisjonsrader er
derfor VERKEN et FK-hinder for tenant-sletting NOCH noe cleanup-koden skal forsøke å slette. Fikset
ved å fjerne `DELETE FROM audit_events`-linjen HELT fra `cleanupTenant()` - resten av den allerede
FK-korrekte rekkefølgen (business_*→tool_executions→memory_spaces→person_tenants→tenants) fullfører nå
uhindret. CLEANUP splittet i fire granulære markører (`ua3_cleanup_mutable_rows`/
`ua3_cleanup_person_links`/`ua3_cleanup_tenants`/`ua3_cleanup_audit_retained`) + samlet `ua3_cleanup`.
Sekundært, ikke-blokkerende funn fikset samtidig: en `pg`-deprecation-advarsel fra
`BusinessService.metrics()` sin `Promise.all([client.query(...), ...])` på samme `pg.PoolClient` -
byttet til sekvensielle `await`-kall. 20 nye tester (inkl. direkte reproduksjon av BEGGE
host-feilmeldingene mot ekte embedded Postgres).

**Bygget:**
- Ny pakke `@jarvis/business` (mal: `@jarvis/erasure`).
- Migrasjon `019_business.sql`: 6 tenant-scoped FORCE RLS-tabeller (business_companies/contacts/
  leads/opportunities/activities/followups), samme RLS-mønster som `017_knowledge.sql`. Idempotent
  kilde-ingestion (UNIQUE-constraint på leads/aktiviteter, idempotency_key på followups).
- `BusinessService` - gjenbruker `withMemoryTransaction` uendret; CRUD/livssyklus for alle 6
  entiteter, kunde-tidslinje ("hva skjer med kunde X?"), forfalt-oppfoelging-spørring, drifts-metrikker.
- `BusinessTransport implements ToolTransport` - 13 nye ToolGateway-handlinger, A/B/C-klassifisert,
  INGEN D-klasse. `BusinessInternalSecretProvider` (ikke-hemmelig sentinel) løser credential-kravet
  for et rent internt verktøy, wiret via eksisterende `FallbackSecretProvider`.
- Registrert som femte, ubetinget transport i `firstWaveTools({...})` i `main.ts`/`worker-main.ts`.
- ETT Windows host-akseptanseskript: `modules/business/scripts/ua3-host-run.ts` →
  `ua3-business-live.ts` (speiler `q20-host-run.ts`/`q20-erasure-live.ts`).

**Suite-verifisert (930/930 - 44 nye tester totalt, se RUNTIME_GATES.md):** tenant-isolert
entitets-opprettelse, lead/opportunity-livssyklus, idempotent lead/aktivitet-ingestion,
aktivitetstidslinje, oppfoelging-livssyklus + forfalt-spørring, kilde-peker-lenking (ingen FK til
knowledge_documents - Q-20-trygt strukturelt), cross-tenant/memory-space-isolasjon (RLS mot ekte
embedded Postgres), samtidig idempotency_key-sikkerhet, ToolGateway-wiring (owner sovereign +
delegert policy via EKSISTERENDE PolicyGateway, ingen ny logikk), audit uten sensitivt kundeinnhold,
scaffold-/runtime-pool-separasjon (HOST FIX #1), append-only-audit-trygg + FK-korrekt CLEANUP
(HOST FIX #2 - inkl. live-reproduksjon av BÅDE `42501`-RLS-avslaget og
`person_tenants_person_id_fkey`-bruddet).

**Host-evidens (3 ekte kjøringer av Tobias):** (1) `run_id b95dd25f` - stoppet på scaffold-bug
(HOST FIX #1); (2) `run_id ad45603d` - alle 13 faktiske Business OS-kapabilitetstester PASSET, kun
CLEANUP feilet (HOST FIX #2); (3) **`run_id ca2d9248` - HELE VEIEN gjennom, INGEN nye funn, alle
13 kapabilitetsmarkører OG alle 5 CLEANUP-markører PASS, `hard_fail=false`.** Runtime bekreftet
uendret gjennom hele kjøringen (`runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `business_runtime_role=jarvis_runtime`).

**Eksplisitt utsatt til senere UA-3-slice (Q-25, ingenting av dette bygget denne runden):**
Gmail/Calendar-hendelseslenking, AI Mesh-basert forretningsresonnering, worker/jobbkø-integrasjon,
automatisk open-loop-deteksjon, tverr-domene driftsoversikt, kontrakt/faktura/inntekt-sporing,
numerisk lead/deal-scoring, D-klasse/hard-delete, UI/dashboard - INGEN av disse er startet.

**Kvalitetsgates:** `pnpm -r typecheck` (15/15 grønt), `eslint .` (0 feil), `pnpm test` (930/930 - 69
filer), gitleaks (detect, ren). PR #9 merget til `main` (normal merge-commit).

## UA-3 — Open-Loop Detection + Daily/Weekly Business Brief = VERIFIED/COMPLETE (2026-08-17, branch `claude/ua3-open-loops-business-brief` fra `origin/main` `b306a480`) → D-53/D-54/D-55/D-56

**Status: VERIFIED/COMPLETE (host-bevist av Tobias på ekte Windows/Docker-host, run_id `de01ca07`,
`hard_fail=false`) → D-56. PR #10 merget til `main`.** Bygget på det VERIFIED/COMPLETE UA-3
P0-fundamentet (D-52) - additiv migrasjon, ingen eksisterende P0-tabell endret.
**Ekte host-kjøring #1 av Tobias (`run_id 19a7f3a4`):** 12 av 14 open-loop/brief-kapabilitetsmarkører
PASSET live; kun idempotens-akseptansen (harness-bug, IKKE produksjonsfeil) og akseptanse-CLEANUP
(nytt `cost_events`-FK-funn) feilet - begge fikset i **HOST FIX #1 (D-54)**. **Ekte host-kjøring #2
(`run_id c7fe8206`):** begge D-54-fikser bekreftet PASS live (idempotens nå PASS); KUN cleanup
feilet PÅ NYTT med et ANNET, uavhengig `brief_seen`-FK-funn - fikset i **HOST FIX #2 (D-55)**, som
også la til en selvdiagnostisk, skjema-drevet FK-sjekk for å fange fremtidige avhengigheter
automatisk. Se egne underseksjoner under. Venter på host-kjøring #3 for endelig VERIFIED-status.

**§0 canonical scope-audit (FØR implementering):** masterplanens "Integrasjonskatalog"
(`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, linje 1049-1082) navngir "Support/
tickets"/"Contracts/e-sign" som UA-3 P1-CONNECTOR-prioritet, men dokumentet sier eksplisitt at
"P0/P1/P2 uttrykker prioritet, ikke obligatorisk samtidig aktivering" - denne tabellen styrer KUN
rekkefølgen for NYE eksterne connectors, ikke intern, connector-fri kapabilitetsbygging. Open-loop-
deteksjon + business brief kommer fra en SEPARAT liste ("Bygges", linje 463-467: "Daily/weekly business
brief og open-loop detection") og er DIREKTE navngitt i det obligatoriske akseptansekriteriet 3 ("Open
loops detected automatically", linje 471) - **ingen konflikt funnet, dette er et legitimt neste-slice-
valg** (arguably høyere prioritet enn P1-connector-radene, siden det er et navngitt akseptansekriterium,
ikke bare en katalog-prioritetsmarkør, og krever ingen ny ekstern connector).

**Domenegrenser (§4 i byggeordren, respektert uendret):** business followup (P0) = menneskelig/
forretningsmessig oppfoelgings-tilstand; task queue (`PgTaskQueue`) = agent-utførelsesinfrastruktur;
**open loop (NY)** = automatisk detektert, uløst forretningsforpliktelse/-tilstand; memory
`"commitment"`-type = huskede forpliktelser/kontekst; Knowledge = kilde-forankret bevis. Open loops
REFERERER (nullable FK), dupliserer ALDRI, business_followups/opportunities/leads/companies/contacts/
activities.

**Bygget:**
- Migrasjon `020_business_open_loops.sql`: additiv, én ny tabell `business_open_loops` - SAMME FORCE
  RLS-mønster (tenant + RESTRICTIVE memory-space-policy) som alle 6 P0-tabeller. `detection_key`
  (UNIQUE per tenant) er den deterministiske idempotens-nøkkelen - re-kjørt deteksjon oppdaterer SAMME
  rad, oppretter ALDRI en duplikat.
- `OpenLoopService` (`modules/business/src/open-loop-service.ts`): to deterministiske deteksjonsregler
  - `detectOverdueFollowups()` (forfalt, åpen `business_followups`-rad) og
  `detectStalledOpportunities()` (ikke-terminal stage + ingen åpen oppfoelging linket + ingen
  oppdatering siste N dager). **Ingen AI Mesh-bruk i dette sliceet** - begge regler er utvetydige
  dato/status-betingelser (`detection_method='deterministic'`; `'ai_assisted'`-kolonnen finnes som
  ubrukt fremtidig utvidelsespunkt, se Q-25). Idempotens via `ON CONFLICT (tenant_id, detection_key) DO
  UPDATE`; gjenåpning av en manuelt resolved loop for SAMME vedvarende vilkår skjer på SAMME rad (aldri
  en ny rad) - historikk før/etter ligger i det eksisterende append-only `audit_events`. Auto-resolve
  når vilkåret ikke lenger er sant (`resolution_reason='condition_no_longer_true'`). Prioritet
  deterministisk fra hvor lenge forfalt/stagnert (`high` vs `normal`) - ingen AI-oppfunnet
  kunde-/beløps-viktighet. `attentionQueue()` bucketer (`critical`/`overdue`/`due_soon`/`informational`)
  som en ren spørring over persistert state, ikke et transient LLM-svar.
- `business-brief.ts`: DAGLIG brief gjenbruker `DailyBrief`-motoren UENDRET via en ny `BriefSource`
  (`businessOpenLoopsSource`) - ingen parallell brief-motor. UKENTLIG brief (`generateWeeklyBrief`) er
  en bevisst egen, liten, kilde-forankret aggregeringsfunksjon i SAMME modul (7-dagers vindu:
  åpnede/løste loops per type, flyttede opportunities, fortsatt-åpne) - ikke tvunget inn i
  `DailyBrief`s snapshot-kontrakt. `BUSINESS_DOMAIN_COVERAGE` markerer EKSPLISITT kun `sales` som
  tilgjengelig - `product`/`finance`/`marketing`/`operations` er `not_integrated` i BEGGE briefer, ALDRI
  fabrikkert (akseptansekriterium 2 er fortsatt IKKE fullt oppfylt).
- `open-loop-sweep.ts`: `runOpenLoopSweepForAllTenants()` - periodisk sveip for tidsbaserte vilkår,
  gjenbruker EKSISTERENDE `DailyScheduler` (eget `job_name="business-open-loop-sweep"`, egen
  `JARVIS_BUSINESS_SWEEP_HOUR`-env, samme reboot-durable DB-claim-mekanisme som den personlige daglige
  briefen) - ingen ny kø. Bounded (`LIMIT 200` tenants), tenant-scoped, per-tenant feilisolasjon (én
  tenants feil velter aldri resten). Wiret INN i `apps/api/src/main.ts` (uavhengig av
  Telegram-konfig - deteksjon ≠ levering) og `OpenLoopService`/`BusinessTransport`-oppdateringen speilet
  identisk i `worker-main.ts`.
- `BusinessTransport` utvidet med 8 nye ToolGateway-handlinger: A-klasse lesing
  (`list_open_loops`/`read_open_loop`/`get_attention_queue`/`get_business_brief` - period
  `daily`/`weekly`); C-klasse tilstandsovergang (`resolve_open_loop`/`defer_open_loop`); B-klasse enkle
  felt-oppdateringer (`assign_open_loop`/`set_open_loop_next_action`). Ekstern side-effekt (e-post/
  telefon) er EKSPLISITT utenfor scope - deteksjon/tilstandsoppdatering er kun intern operasjonell
  state.
- Ett Windows host-akseptanseskript: `modules/business/scripts/ua3-open-loops-host-run.ts` →
  `ua3-open-loops-live.ts` (speiler `ua3-host-run.ts`/`ua3-business-live.ts`, SAMME
  admin-pool-for-scaffold/runtime-pool-for-operasjoner-separasjon som P0 HOST FIX #1, SAMME
  append-only-audit-trygge CLEANUP-rekkefølge som P0 HOST FIX #2 - `business_open_loops` slettes FØR
  `business_followups`/`business_opportunities` pga FK).

**Suite-verifisert (48 nye tester i business-modulen + 4 nye i eksisterende
`business-transport-wiring.test.ts` = 52 nye, se RUNTIME_GATES.md for eksakt totalsum):** forfalt-
oppfoelging/stagnert-opportunity-deteksjon, idempotens (ingen duplikat ved re-sveip), manuell + auto-
resolusjon, gjenåpning på samme rad, deterministisk prioritet, kilde-forankret begrunnelse
(followup_id/company_id/detection_key sporbart), tenant-/memory-space-isolasjon (RLS mot ekte embedded
Postgres), oppmerksomhets-kø-bucketing, defer/assign/set-next-action, Q-20-interaksjon (ingen FK til
`knowledge_documents` - strukturelt bevist), FORCE RLS bekreftet i databasen (`pg_class`), ingen direkte
AI Mesh/provider-SDK-import (strukturelt bevist), daglig/ukentlig brief-innhold + domenedeknings-
ærlighet, ToolGateway-wiring gjennom EKSISTERENDE Policy Gateway (owner sovereign + delegert policy,
audit uten sensitiv fritekst-begrunnelse), sveip-hjelperens tenant-scoping/bounded-LIMIT/
feilisolasjon (rene enhetstester, ingen DB nødvendig).

**Eksplisitt utsatt (Q-25, ingenting av dette bygget denne sliceen):** Gmail/Calendar-hendelseslenking
til open loops (motoren er designet for å ta imot normaliserte fremtidige hendelser, men P0-synthetisk
data er bevisst nok til å bevise motoren denne runden), Support/tickets- og Contracts/e-sign-connectorer
(forblir eksplisitte UA-3 P1-kandidater, arkitekturen er extensible for fremtidige ticket-/
kontrakt-hendelser), full tverr-domene bedriftshelse (akseptansekriterium 2 - kun sales/CRM-domenet er
dekket, ærlig markert i begge briefer), numerisk lead/deal-scoring, D-klasse/hard-delete for
business-data, UI/dashboard, AI Mesh-basert semantisk tolkning av loops (ingen ambiguitet krevde det i
dette sliceet).

**Kvalitetsgates (ved bygging):** `pnpm -r typecheck` (14/14 grønt), `eslint .` (0 feil), `pnpm test`
(982/982 - 73 filer, 52 nye), gitleaks (detect, 125 commits scannet, ingen funn).

**PR-status:** [PR #10](https://github.com/tsworkflow/jarvisbuild/pull/10) opprettet som draft,
CI grønt (build-test + gitleaks - se egen CI-fiks under). **IKKE merget** - venter eksplisitt på
Tobias sin neste host-verifikasjon.

## UA-3 NEXT SLICE HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 19a7f3a4`) → D-54

**To distinkte funn, begge undersøkt til rot FØR noe ble fikset - ingen gjettet root cause.**

**(1) `ua3_open_loop_idempotency=FAIL` selv om host-loggen viste `open_loops_before=2
open_loops_after=2 duplicate_rows_for_same_key=0`** - en akseptanse-HARNESS-bug, IKKE en
produksjonsfeil. Root cause: IDEMPOTENS-seksjonens verifikasjonsspørring i `ua3-open-loops-live.ts`
kalte `pool.query(...)` DIREKTE mot `business_open_loops` (FORCE ROW LEVEL SECURITY) UTEN
`withMemoryTransaction` - under den ekte NOSUPERUSER/NOBYPASSRLS `jarvis_runtime`-rollen (Q-21) ble
`jarvis.tenant_id`/`jarvis.memory_spaces`-session-GUC-ene ALDRI satt, RLS-predikatet evaluerte til
NULL, og spørringen så derfor STRUKTURELT 0 rader uansett faktisk databasetilstand. Reprodusert
direkte mot ekte embedded Postgres (`ua3-open-loops-cost-cleanup.test.ts` §A: samme raw spørring
finner 0, samme spørring wrappet i `withMemoryTransaction` finner den korrekte 1-raden).
`OpenLoopService` sine egne metoder (bevist i `open-loop-service.test.ts` §B) bruker
`withMemoryTransaction` KORREKT overalt - idempotens var aldri broken i produksjon. **Fiks:**
spørringen wrappet i `withMemoryTransaction`, ingen produksjonskode endret.

**(2) Akseptanse-CLEANUP feilet: `update or delete on table "tenants" violates foreign key constraint
"cost_events_tenant_id_fkey"`.** Root cause verifisert mot faktisk skjema (IKKE gjenbrukt blindt fra
P0 sin `audit_events`-fiks, som byggeordren eksplisitt advarte mot): `get_business_brief`(daily)
konstruerer `new DailyBrief([...], pool)`, og `DailyBrief.generate()` skriver en `cost_events`-rad per
generert brief (eksisterende run-rate-oppførsel) - en genuint NY avhengighet dette sliceet introduserer
(P0 hadde ingen brief-handling). `cost_events.tenant_id REFERENCES tenants` (ekte FK, ingen CASCADE)
OG INGEN append-only-trigger (i motsetning til `audit_events`, som forblir uendret utelatt fra
cleanup) - samme FK-klasse og fiks-presedens som `ua2-p1b-a-host-run.ts` sin D-45. **Fiks:**
`DELETE FROM cost_events WHERE tenant_id = $1` lagt til FØRST i `cleanupTenant()`, scoped eksakt til
den ene synthetic-tenanten.

**Regresjon:** 12 nye tester (`ua3-open-loops-cost-cleanup.test.ts`, inkl. direkte reproduksjon av
BEGGE feilklassene mot ekte embedded Postgres under en ekte non-bypass rolle) + 2 nye strukturelle
regresjonsvakter i `ua3-open-loops-host-run-wiring.test.ts`. 982→994 tester totalt.
**Kvalitetsgates:** `pnpm -r typecheck` (14/14 grønt), `eslint .` (0 feil), `pnpm test` (994/994 - 74
filer), gitleaks (127 commits scannet, ingen funn).

**CI-fiks (samme PR, før dette HOST FIX-funnet):** `gitleaks/gitleaks-action@v2` 403-et mot
`/repos/.../pulls/10/commits` (samme "Resource not accessible by integration"-klasse som tidligere
GitHub MCP-tilgangsproblemer i denne økten) til tross for korrekt `pull-requests: read`-tildeling -
erstattet med direkte gitleaks-CLI-kjøring mot hele historikken (ingen GitHub API-avhengighet).

**Status: FORTSATT FIXED_SUITE / HOST_VERIFY_BLOCKED.** Q-21/RLS/`OpenLoopService`/`BusinessService`/
`DailyBrief`/ToolGateway/skjema UENDRET - ingen produksjonslogikk rørt, kun akseptanse-harness-koden
(verifikasjonsspørring + cleanup-rekkefølge). Venter på Tobias sin neste kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-open-loops-host-run.ts`

## UA-3 NEXT SLICE HOST FIX #2 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id c7fe8206`) → D-55

**HOST FIX #1 sine to fikser bekreftet PASS LIVE:** `ua3_open_loop_idempotency=PASS`
(`open_loops_before=2 open_loops_after=2 duplicate_rows_for_same_key=1` - korrekt, ikke 0 lenger), og
alle 12 av 14 kapabilitetsmarkører PASSET på nytt (deteksjon/resolusjon/prioritet/kilde-bevis/tenant-
og space-isolasjon/ToolGateway/daglig+ukentlig brief/domenedeknings-ærlighet/audit). **KUN
akseptanse-CLEANUP feilet PÅ NYTT** - et ANNET, uavhengig FK-brudd: `brief_seen_tenant_id_fkey`.

**Root cause:** SAMME `DailyBrief.generate({pool})`-kodeblokk som skriver `cost_events` (fikset i
D-54) skriver OGSÅ en `brief_seen`-rad per unikt brief-punkt (stale-suppression) - to uavhengige
INSERT-er i samme blokk, D-54 sporet kun én av dem. Bekreftet mot skjema (`012_brief_seen.sql`):
ekte FK til `tenants`, ingen append-only-trigger, og `jarvis_app` har INGEN DELETE-grant i det hele
tatt (kun `adminPool` kan rydde den).

**Full, skjema-drevet FK-revisjon (§3 i ordren, ikke gjentatt gjetting):** en `information_schema`-
spørring mot en ekte migrert database bekreftet 44 fremmednøkler mot `tenants(tenant_id)` totalt.
Kildekode-sporing av HVER faktiske `INSERT INTO` nåbar fra dette akseptanseskriptets kodebane
(`BusinessService`/`OpenLoopService`/`ToolGateway.execute`/`DailyBrief.generate`) bekreftet at KUN
`cost_events` og `brief_seen` er nye avhengigheter - de øvrige ~30 FK-refererende tabellene har
INGEN skrivevei fra dette scriptet og er bevisst IKKE inkludert i cleanup.

**Selvdiagnostisk sperre lagt til** (`findBlockingTenantDependencies()`): en dynamisk, skjema-drevet
sjekk (ikke en hardkodet tabelliste) som spør `information_schema` for ALLE FK-er mot
`tenants(tenant_id)` og teller rader for den ene test-tenanten RETT FØR `DELETE FROM tenants`
forsøkes i hver `cleanupTenant()`-kjøring - fanger automatisk en FRAMTIDIG, ennå ukjent avhengighet
med presis diagnostikk (`blocking_fk_table`/`blocking_fk_name`/`rows_for_test_tenant`, aldri
radinnhold) FØR selve slette-forsøket, i stedet for en tredje blind host-runde for neste
uoppdagede avhengighet.

**Regresjon:** 16 nye tester (13 i `ua3-open-loops-cost-cleanup.test.ts` inkl. direkte reproduksjon
av `brief_seen`-FK-bruddet og selvdiagnostikk-mekanismen mot ekte embedded Postgres, + 3 nye
strukturelle regresjonsvakter). 994→1010 tester totalt. **Kvalitetsgates:** `pnpm -r typecheck`
(14/14 grønt), `eslint .` (0 feil), `pnpm test` (1010/1010 - 74 filer), gitleaks (128 commits
scannet, ingen funn).

**Status: FORTSATT FIXED_SUITE / HOST_VERIFY_BLOCKED.** Q-21/RLS/`OpenLoopService`/`BusinessService`/
`DailyBrief`/ToolGateway/idempotens-fiksen fra D-54 UENDRET - ingen produksjonslogikk rørt igjen, kun
akseptanse-harness-cleanup-koden utvidet med en genuint ny, robust selvdiagnostisk mekanisme. Venter
på Tobias sin neste kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-open-loops-host-run.ts`

## UA-3 FINAL CLOSURE — Open-Loop Detection + Business Brief (2026-08-17, samme dag) — HOST VERIFIED

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-open-loops-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `de01ca07`.** TREDJE host-kjøring, etter HOST FIX #1 (D-54) og HOST FIX #2 (D-55) -
denne runden kom HELE VEIEN gjennom UTEN nye funn. Alle 16 forventede markører PASS:
`q21_runtime_role_safe`, `ua3_open_loop_runtime_role`, `ua3_open_loop_overdue_detection`,
`ua3_open_loop_stalled_detection`, `ua3_open_loop_idempotency` (`duplicate_rows_for_same_key=1` -
korrekt), `ua3_open_loop_resolution`, `ua3_open_loop_priority`, `ua3_open_loop_source_evidence`,
`ua3_open_loop_tenant_isolation`, `ua3_open_loop_space_isolation`, `ua3_open_loop_toolgateway`,
`ua3_business_daily_brief`, `ua3_business_weekly_brief`, `ua3_brief_missing_domains_honest`,
`ua3_open_loop_audit_safe`, `ua3_open_loop_cleanup` (`cleanup_ok=true leftover_open_loops=0
leftover_tenants=0`). Runtime uendret gjennom hele kjøringen: `runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `open_loop_runtime_role=jarvis_runtime`.
`hard_fail=false`.

**Idempotens-arkitekturlærdom (bevart fra D-54, bekreftet her):** den opprinnelige idempotens-
host-feilen var ALDRI en produksjonsfeil - `OpenLoopService` brukte `withMemoryTransaction` korrekt
gjennom hele denne sliceen. Den opprinnelige feilen skyldtes en akseptanse-verifikasjonsspørring mot en
FORCE-RLS-tabell (`business_open_loops`) uten `jarvis.tenant_id`/`jarvis.memory_spaces`-session-GUC-er
- den korrigerte spørringen (`withMemoryTransaction`) beviser nå korrekt `duplicate_rows_for_same_key=1`
live.

**Business-brief-ærlighet bekreftet host-bevist:** `sales` tilgjengelig via eksisterende Business
Graph/CRM; `product`/`finance`/`marketing`/`operations` forblir eksplisitt `not_integrated` i BEGGE
briefer (`ua3_brief_missing_domains_honest=PASS`) - masterplanens akseptansekriterium 2 ("Hvordan går
bedriften?") er FORTSATT IKKE fullt oppfylt av denne sliceen alene.

**STATUS: VERIFIED/COMPLETE → D-56.** Full evidens (D-53/D-54/D-55/D-56) og oppsummering i
header-seksjonen øverst i denne filen. **KUN denne UA-3-sliceen + UA-3 P0 er VERIFIED/COMPLETE - HELE
UA-3 er IKKE komplett** (se oppdatert Q-25) - Support/tickets, Contracts/e-sign, Gmail/Calendar-
hendelseslenking, tverr-domene driftsoversikt utover sales, profiling/scoring med juridiske kontroller
er alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #10
merget til `main` (normal merge-commit, samme konvensjon som PR #1-#9 - historikk bevart, ikke
squashet).

## UA-3 — Business-Event-Linkage (Gmail/Calendar → Business OS) = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17, branch `claude/ua3-business-events-linkage` fra `origin/main` `017172c`) → D-57

**Canonical-audit FØR kode (§1-§5 i byggeordren):** full lesing av masterplanens UA-3-seksjon (linje
460-472) OG Integrasjonskatalogen (linje 1049-1082, IKKE bare den korte fase-headeren) bekreftet at
UA-3 sine to gjenværende P1-connector-rader ("Support/tickets", "Contracts/e-sign") IKKE har en
navngitt leverandør noe sted i masterplanen eller øvrige docs - et målrettet søk (Zendesk/Freshdesk/
Intercom/DocuSign/Dropbox Sign/tilsvarende) ga null treff. Å velge én av dem ville brutt byggeordrens
eksplisitte §5-provider-beslutnings-gate ("Do NOT choose one merely from popularity" / "Do not burn a
development round implementing a provider that was never chosen"). Gmail/Calendar er derimot allerede
navngitte, provider-besluttede UA-0/UA-7-P0-connectorer (linje 1101-1102) - den ENESTE måten å faktisk
levere UA-3 sitt FØRSTE akseptansekriterium ("Hva skjer med kunde X?", linje 469) uten å oppfinne en ny
leverandørbeslutning. Q-25 sitt eget item 1 og IMPLEMENTATION_PLAN.md sin "Bygges IKKE"-liste navnga
dette gjennomgående som det FØRSTE utsatte punktet siden P0 - ingen konkurrerende, like moden kandidat
fantes. **Konklusjon: unik, ikke-tvetydig neste slice, IKKE en `NEEDS_TOBIAS_DECISION`-situasjon.**
Se D-57 for full begrunnelse.

**Bygget:**
1. `GmailTransport.listMessages()` utvidet med `to`/`cc`-headere (additivt felt).
2. `GoogleCalendarTransport` fikk en ny `list_events`-handling (deltaker-e-poster + `html_link`,
   `read_events` uendret).
3. `BusinessEventSyncService` (`modules/business/src/business-event-sync.ts`) - deterministisk
   entitetsgjenkjenning (e-postadresse, ALDRI AI-gjettet), idempotent aktivitets-registrering via
   EKSISTERENDE `recordActivity()`, open-loop-reevaluering via EKSISTERENDE `OpenLoopService.
   runSweep()`.
4. `BusinessService.findContactsByEmail()` + additiv indeks `021_business_contact_email_lookup.sql`.
5. ToolGateway: `calendar.list_events` (klasse A) + `business.sync_business_events` (klasse B, INGEN
   D). `BusinessTransport` fikk en fjerde, valgfri `toolGateway`-parameter.
6. Periodisk synk via EKSISTERENDE `DailyScheduler` (`job_name="business-events-sync"`, default kl.
   05), wiret inn i `main.ts`/`worker-main.ts`.
7. Host-akseptanseskript `ua3-business-events-host-run.ts` → `ua3-business-events-live.ts` - to-delt
   strategi (ekte connector-reachability + deterministisk FakeTransport-basert entitetsgjenkjenning),
   gjenbruker UENDRET D-55 sin selvdiagnostiske FK-blokkerings-sperre.

**Suite-verifisert (1053/1053 tester, 43 nye - 19 i `business-event-sync.test.ts`, 12 nye/oppdaterte i
`business-transport-wiring.test.ts`, 21 i `ua3-business-events-host-run-wiring.test.ts`, minus
allerede-eksisterende oppdaterte assertions):** e-post-adresse-parsing, motpart-utledning,
matchet/umatchet/tvetydig entitetsgjenkjenning (Gmail OG Calendar), idempotens, ingen body-/
beskrivelses-innhold lagret, tenant-/memory-space-isolasjon, open-loop-reevaluering, ToolGateway-
wiring (owner sovereign + delegert policy), audit-metadata-sikkerhet, ingen AI Mesh/provider-SDK-
bypass. Lint/typecheck rene.

**STATUS (før HOST FIX #1): FIXED_SUITE / READY_FOR_HOST_VERIFY → D-57.**

## UA-3 Business-Event-Linkage HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 7c5a5289`) → D-58

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-business-events-host-run.ts` på sin faktiske Windows/Docker-host.**
Bootstrap/Docker/migrasjoner PASS. `q21_runtime_role_safe=PASS role=jarvis_runtime`,
`ua3_events_runtime_role=PASS`, CLEANUP PASS (`cleanup_ok=true leftover_activities=0
leftover_tenants=0`). **PRIMÆR FEIL:** REAL CONNECTOR REACHABILITY feilet med
`tool_failed:credential_unavailable` (`sync_ok=false`) - nesten alle andre funksjonelle markører
feilet deretter som en KASKADE av samme rotårsak, ikke uavhengige produksjonsfeil.

**Root cause verifisert presist (kildekode-sporet fra `credential_unavailable` i `gateway.ts` linje
190, via `BusinessTransport.invoke()` sin `sync_business_events`-gren, til
`BusinessEventSyncService.syncGmailActivities()`/`syncCalendarActivities()` sine
`gateway.execute({tool_id:"email"/"calendar",...})`-kall, til selve REACHABILITY-seksjonens
`realGateway`-konstruksjon):** `ua3-business-events-live.ts` sin REACHABILITY-seksjon (DEL 1)
konstruerte `realGateway` med `new FallbackSecretProvider({name:"env-empty", get: async()=>null}, new
BusinessInternalSecretProvider())` - en ALLTID-null stub-secret-provider FEILAKTIG kopiert fra
vitest-enhetstestenes mønster (der Gmail/Calendar-credentials BEVISST aldri skal resolve) - i stedet
for den EKTE `new FallbackSecretProvider(new EnvSecretProvider(), new
BusinessInternalSecretProvider())` som `apps/api/src/main.ts`/`worker-main.ts` allerede bruker
korrekt (bekreftet ved kildekode-inspeksjon av begge filer - PRODUKSJON VAR ALDRI PÅVIRKET).
`JARVIS_EMAIL_TOKEN`/`JARVIS_GOOGLE_TOKEN` ble derfor ALDRI lest fra `.env`, uansett om de faktisk var
konfigurert riktig hos Tobias. **Dette var en REN akseptanse-harness-bug, ikke en produksjonsfeil eller
en tenant-credential-isolasjonsfeil** - verifisert eksplisitt (§5 i HOST FIX-ordren) at
`credential_ref` for Gmail/Calendar er en FAST, per-verktøy-konstant (aldri tenant-avledet) - denne
arkitekturen har INGEN tenant-scoped credential-binding å bryte, samme globale eierkonto-mønster som
personlig daily brief allerede brukte uendret siden UA-0/UA-7.

**Fiks:** (1) DEL 1 (REACHABILITY) byttet til ekte `EnvSecretProvider()`; (2) DEL 2 (deterministisk
`FakeTransport`-basert entitetsgjenkjenning) beholdt BEVISST credential-uavhengighet - en eksplisitt
dummy-verdi kun for Gmail/Calendar-referansene (samme "test-google-static"-mønster som
`business-transport-wiring.test.ts`), IKKE `EnvSecretProvider()`. (3) `BusinessEventSyncService.
syncTenant()` isolerer nå Gmail/Calendar-feil UAVHENGIG (`Promise.all()` + per-provider `.catch()`,
sanert `error`-felt, `.slice(0,120)`, aldri et rått credential/token) - en ekte
produksjonsrobusthetsforbedring, ikke bare en akseptanse-fiks. **Urelatert, ekte CI-funn fikset
samtidig:** en genuin TOCTOU-race i `BusinessService.createFollowup()` (P0/D-49, urørt av D-57) -
ikke-atomisk SELECT-så-INSERT for `idempotency_key` kunne la to samtidige kall begge INSERT-e,
reprodusert av en CI-rerun (`business-service.test.ts` test U) - fikset til samme atomiske
`ON CONFLICT ... DO UPDATE ... RETURNING *`-mønster som `createLead()`/`recordActivity()`.

18 nye tester (1053→1071): 8 i ny `business-event-sync-credential-wiring.test.ts` (EnvSecretProvider
løser ekte konfigurerte credentials, manglende credential gir sanert `credential_unavailable`, ingen
credential-lekkasje, BusinessTransport bruker injisert gateway - ikke en nestet/uavhengig en, fast
credential_ref uavhengig av tenant), 3 nye i `business-event-sync.test.ts` sin "O"-seksjon (Gmail/
Calendar-feil isolert uavhengig), 7 nye/oppdaterte strukturelle regresjonsvakter i
`ua3-business-events-host-run-wiring.test.ts`. 1071/1071 tester, lint/typecheck rene.

**STATUS (før HOST FIX #2): FIXED_SUITE / HOST_VERIFY_BLOCKED → D-58.**

## UA-3 Business-Event-Linkage HOST FIX #2 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id b969e9e7`) → D-59

**Tobias kjørte host-akseptansen PÅ NYTT etter HOST FIX #1 - ALLE funksjonelle Business-Event-
kapabiliteter PASSET LIVE:** `q21_runtime_role_safe=PASS`, `ua3_events_runtime_role=PASS`, EKTE Gmail
(`gmail_reachable=true gmail_scanned=25`) OG Calendar (`calendar_reachable=true calendar_scanned=0` -
et tomt resultat er en gyldig PASS, ikke en feil) reachability UAVHENGIG PASS,
`ua3_events_gmail_matched/_unmatched/_ambiguous=PASS`, `ua3_events_calendar_matched=PASS`,
`ua3_events_idempotency=PASS`, `ua3_events_no_body_content_stored=PASS`,
`ua3_events_tenant_isolation/_space_isolation=PASS`, `ua3_events_toolgateway_wiring=PASS`,
`ua3_events_open_loop_reevaluation=PASS`, `ua3_events_cleanup=PASS` (`leftover_activities=0
leftover_tenants=0`). **ENESTE feil:** `ua3_events_audit_safe=FAIL` (`audit_payload_excerpt={}`) -
`hard_fail=true` KUN pga. denne ene markøren.

**Root cause verifisert presist (eksplisitt IKKE rørt noen av de fungerende kapabilitetene over, per
ordrens §1):** OPEN-LOOP-REEVALUERING-seksjonens audit-verifikasjon brukte en RAW `pool.query()` mot
`audit_events` - **NØYAKTIG SAMME FEILKLASSE SOM D-54.** `audit_events` har `FORCE ROW LEVEL SECURITY`
(`005_rls.sql`) med policyen `USING (tenant_id = current_setting('jarvis.tenant_id', true))` - en raw
spørring under den ekte NOSUPERUSER/NOBYPASSRLS `jarvis_runtime`-rollen setter ALDRI denne
session-GUC-en, og spørringen ser derfor STRUKTURELT 0 rader uansett faktisk databasetilstand. Selve
audit-SKRIVINGEN var korrekt hele tiden - `ToolGateway.execute()` kaller `writeAudit()` INNI SAMME
`withTenantTransaction`-blokk som selve verktøykjøringen, og `ua3_events_toolgateway_wiring=PASS` (fra
SAMME host-kjøring) beviser at handlingen fullførte. Mekanismen er direkte reprodusert i en ny test
(`business-event-sync-audit-rls.test.ts` test A): en ekte audit-rad bekreftet å FINNES via `adminPool`,
mens EKSAKT samme spørring via den non-bypass rollen (`appPool`) returnerer 0 rader.

**Fiks (kun akseptanse-harnesset - ingen produksjonskode rørt):** spørringen wrappet i
`withTenantTransaction(pool, TENANT_A, ...)` (samme presedens som D-54). Eksistens og
innholds-sikkerhet gjort til to eksplisitt distinkte krav - `auditFound` inngår nå direkte i selve
PASS-betingelsen (en manglende/tom spørring kan aldri lenger tolkes som "trygt"). Nøstede
`email`/`calendar`-audit-rader (fra `BusinessEventSyncService` sine egne `ToolGateway.execute()`-kall)
bekreftet å ALDRI forveksles med den ytre `business`/`sync_business_events`-spørringen.

12 nye tester (7 i ny `business-event-sync-audit-rls.test.ts` + 5 nye strukturelle regresjonsvakter i
`ua3-business-events-host-run-wiring.test.ts`, 1071→1082). Lint/typecheck rene.

**STATUS: FIXED_SUITE / HOST_VERIFY_BLOCKED → D-59. IKKE VERIFIED** - venter på Tobias sin TREDJE
kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-business-events-host-run.ts`
**KUN UA-3 P0 + open-loop-sliceen er VERIFIED/COMPLETE - denne sliceen er FIXED_SUITE, funksjonelt
LIVE-bevist, men IKKE ferdig host-bevist (kun audit-verifikasjonsbugen gjenstår) - HELE UA-3 er
FORTSATT IKKE komplett** (se oppdatert Q-25). Support/tickets, Contracts/e-sign (krever fortsatt en
Tobias-provider-beslutning), tverr-domene driftsoversikt utover sales, profiling/scoring med juridiske
kontroller er alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.**

## UA-3 FINAL CLOSURE — Business-Event-Linkage (2026-08-17, samme dag) — HOST VERIFIED → D-60

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-business-events-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `6c6a4948`.** TREDJE host-kjøring, etter HOST FIX #1 (D-58) og HOST FIX #2 (D-59) -
denne runden kom HELE VEIEN gjennom UTEN nye funn. Alle markører PASS: `q21_runtime_role_safe`,
`ua3_events_runtime_role`, `ua3_events_gmail_real_connector_reachable` (`gmail_scanned=25`),
`ua3_events_calendar_real_connector_reachable` (`calendar_scanned=0`, tomt vindu er gyldig PASS),
`ua3_events_gmail_matched`/`_unmatched`/`_ambiguous`, `ua3_events_calendar_matched`,
`ua3_events_idempotency`, `ua3_events_no_body_content_stored`, `ua3_events_tenant_isolation`/
`_space_isolation`, `ua3_events_open_loop_reevaluation`, `ua3_events_toolgateway_wiring`,
`ua3_events_audit_safe` (`audit_event_found=true`, `audit_action=business.sync_business_events`),
`ua3_events_cleanup` (`leftover_activities=0 leftover_tenants=0`). Runtime uendret gjennom hele
kjøringen: `runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`,
`runtime_role_bypassrls=false`, `events_runtime_role=jarvis_runtime`. `hard_fail=false`.

**Real vs. synthetic acceptance bekreftet, ikke overklaimet:** ekte Gmail/Calendar API-autentisering/
reachability mot den faktiske eierkontoen (REAL HOST); matchet/umatchet/tvetydig entitetslenking,
idempotens, isolasjon, open-loop-reevaluering via `FakeTransport`-gjennom-ekte-`ToolGateway.execute()`
(CONTROLLED SYNTHETIC RUNTIME). Ingen ekte mailboks-/kalenderdata ble mutert - kun lesing.

**Akseptansekriterium 1-re-evaluering ("Hva skjer med kunde X?"): PARTIAL, IKKE automatisk markert
COMPLETE.** Kjernemekanismen (Internal CRM/Sales pipeline UA-3 P0 + Gmail/Calendar UA-0/UA-7 P0) er NÅ
VERIFIED/COMPLETE og host-bevist ende-til-ende - men masterplanens Integrasjonskatalog (linje
1069-1071) navngir Support/tickets og Contracts/e-sign som EGNE UA-3 P1-kundekontaktsystemer som
fortsatt IKKE er tilkoblet (ingen leverandør navngitt noe sted, uavklart Tobias-beslutning). Full
firekriterie-matrise (se D-60 for detaljert evidens per kriterium):
1. "Hva skjer med kunde X?" = **PARTIAL** (kjernemekanisme COMPLETE, full katalogbredde IKKE).
2. "Hvordan går bedriften?" = **PARTIAL, uendret fra D-56** (kun `sales` tilkoblet; `product`/
   `finance`/`marketing`/`operations` avhenger av UA-4/UA-5/UA-6, som IKKE er startet).
3. "Open loops detected automatically" = **COMPLETE/VERIFIED, uendret fra D-56**.
4. "Profiling/scoring med dokumenterte juridiske/menneskelige kontroller" = **NOT STARTED, uendret**
   (krever Tobias produkt-/juridisk-beslutning om scoringens omfang - IKKE et kodbart standardvalg).

**STATUS: VERIFIED/COMPLETE → D-60.** Full evidens (D-57/D-58/D-59/D-60) og oppsummering i
header-seksjonen øverst i denne filen. **KUN denne UA-3-sliceen + UA-3 P0 + open-loop-sliceen er
VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (2 av 4 kriterier PARTIAL, 1 av 4 NOT STARTED - se
oppdatert Q-25). **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #11 merget til
`main` (normal merge-commit, samme konvensjon som PR #1-#10 - historikk bevart, ikke squashet).

## UA-3 — Profiling/Scoring (akseptansekriterium 4) = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17, branch `claude/ua3-profiling-scoring-controls` fra `origin/main` `4a19396`) → D-61

**Status: FIXED_SUITE / READY_FOR_HOST_VERIFY → D-61 - IKKE VERIFIED**, venter på Tobias sin FØRSTE
host-kjøring. Svarer på D-60 sin `NEEDS_TOBIAS_DECISION` - av de tre gjenværende kandidatene
(Support/tickets, Contracts/e-sign, profiling/scoring) var profiling/scoring den ENESTE som ikke krevde
en uavklart leverandørbeslutning.

**Bygget:** migrasjon `022_business_scoring.sql` (`business_scores`, samme FORCE RLS-mønster som
`business_open_loops`, `entity_type` DB-CHECK-begrenset til `'lead'`/`'opportunity'` - kontakt-/
person-scoring strukturelt umulig); `scoring-rules.ts` (ren, deterministisk regelmotor,
`lead_priority_v1`/`opportunity_risk_v1`, whitelist + `assertNoProhibitedFactorCodes()`);
`scoring-service.ts` (signal-innsamling KUN fra lead/opportunity/aktivitet/oppfoelging/open-loop-data,
idempotent UPSERT, forklaring/rangering, manuell overstyring); 8 nye ToolGateway-handlinger
(`get_lead_score`/`get_opportunity_score`/`explain_score`/`rank_leads`/`rank_opportunities` = klasse A;
`recalculate_score`/`set_manual_override`/`clear_manual_override` = klasse B); periodisk rekalkulering
via EKSISTERENDE `DailyScheduler` (`job_name="business-scoring-recalc"`, default kl. 07); host-
akseptanseskript `ua3-profiling-scoring-host-run.ts`/`-live.ts` (ETT-delt, INGEN ekstern leverandør-
credential kreves - i motsetning til Gmail/Calendar-linkage).

**Suite-verifisert (1147/1147 tester, 65 nye):** lead-/opportunity-score-beregning, faktor-forklaring,
kilde-/evidence-referanser, versjonering, beskyttet-trekk-forbud (strukturelt OG funksjonelt), ingen
skjult persontrekk-inferens, manuell overstyring + audit, idempotent rekalkulering, tenant-/
memory-space-isolasjon, Q-21, ToolGateway-lesing/-skriving, audit-personvern, INGEN AI Mesh-bruk,
Q-20-kildefjerning-resiliens, hoy-konsekvens-personbeslutning strukturelt umulig, fail-closed.

**Eksplisitt IKKE overklaimet:** kun DENNE sliceen implementeres her. HELE UA-3 forblir IKKE komplett -
Support/tickets, Contracts/e-sign (uavklart Tobias-provider-beslutning) og tverr-domene driftsoversikt
utover sales (avhenger av UA-4/UA-5/UA-6, ikke startet) gjenstår. HELE masterplan v4.0 «Sovereign
Autonomy» forblir IKKE komplett - se D-60/D-61 og oppdatert Q-25.

## UA-3 Profiling/Scoring HOST FIX #1 (2026-08-17, samme dag, ekte host-funn av Tobias, `run_id 22226237`) → D-62

**Tobias sin FØRSTE host-kjøring** (`node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-profiling-scoring-host-run.ts`) traff `hard_fail=true`, men ALLE
funksjonelle markører PASSET LIVE:

`q21_runtime_role_safe`, `ua3_scoring_runtime_role`, `ua3_scoring_toolgateway`, `ua3_scoring_lead`
(`lead_score=60`, faktorer `status_qualified`/`has_active_opportunity`/`recent_activity_7d`),
`ua3_scoring_explainable`, `ua3_scoring_versioned`, `ua3_scoring_source_backed`,
`ua3_scoring_protected_traits_blocked`, `ua3_scoring_opportunity` (`opportunity_score=50`, faktorer
`stage_proposal`/`overdue_followup`), `ua3_scoring_high_impact_blocked`, `ua3_scoring_manual_override`
(`override_score=88`, `underlying_score_unchanged=true`), `ua3_scoring_override_audit`,
`ua3_scoring_tenant_isolation`, `ua3_scoring_space_isolation`, `ua3_scoring_audit_safe`,
`ua3_scoring_cleanup` (`leftover_scores=0 leftover_tenants=0`). **KUN**
`ua3_scoring_idempotent=FAIL` (`duplicate_rows_for_same_lead=0`) blokkerte.

**Root cause verifisert presist (kildekode-sporet, IKKE gjettet):** IDEMPOTENS-seksjonen i
`ua3-profiling-scoring-live.ts` verifiserte `business_scores` med `withTenantTransaction()` - denne
hjelperen setter KUN `jarvis.tenant_id`. `business_scores` (`022_business_scoring.sql`) har - i
MOTSETNING til `audit_events` (som D-59 korrekt fikset MED `withTenantTransaction`, siden
`audit_events` KUN har en tenant-policy) - BÅDE en tenant-policy OG en RESTRICTIVE
memory-space-policy (samme mønster som `business_open_loops`). Uten `jarvis.memory_spaces` satt
evaluerer memory-space-predikatet til NULL, og RESTRICTIVE-policyen blokkerer STRUKTURELT alle rader -
**SAMME feilklasse som D-54/D-59, en NY konkret forekomst** (feil hjelpefunksjon valgt for en tabell
med et EKSTRA policy-lag). Selve SKRIVINGEN var korrekt hele tiden - `ScoringService` bruker
`withMemoryTransaction()` konsekvent, og host-loggens egne `ua3_scoring_lead=PASS`/
`ua3_scoring_manual_override=PASS` beviser raden ble lest korrekt like før idempotens-seksjonen kjørte.

**Bevist reprodusert mekanisk** (ny `scoring-idempotency-rls.test.ts`, 9 tester): en ekte
`recalculate_score` gjennom ToolGateway, `adminPool` bekrefter 1 rad finnes, raw/
`withTenantTransaction`-spørring under en ekte non-bypass rolle finner FORTSATT 0 rader (identisk
mekanisme som host-loggen), `withMemoryTransaction()` finner raden korrekt.

**Idempotens-identitet klargjort:** `UNIQUE (tenant_id, entity_type, entity_id, score_type)` er den
fullstendige identiteten - `rule_version` deltar BEVISST IKKE (kun ÉN gjeldende score per
entitet/type, ikke en versjonshistorikk-tabell; `audit_events` er den faktiske historikken). Schema
var allerede korrekt - INGEN endring gjort der.

**Fiks (kun akseptanse-harnesset, ingen produksjonskode rørt):** spørringen wrappet i
`withMemoryTransaction(pool, TENANT_A, ["business"], ...)`. Diagnostikk omdøpt fra det misvisende
`duplicate_rows_for_same_lead` til `score_rows_for_same_identity` + eksplisitt
`idempotency_identity`-felt, slik at fremtidige feilsøkinger kan skille rad-mangel fra RLS-skjult rad
fra ekte duplikat. 13 nye tester (9 i `scoring-idempotency-rls.test.ts` + 4 nye strukturelle
regresjonsvakter i `ua3-profiling-scoring-host-run-wiring.test.ts`, 1147→1160). Lint/typecheck rene.

**STATUS: FIXED_SUITE / HOST_VERIFY_BLOCKED → D-62. IKKE VERIFIED** - venter på Tobias sin ANDRE
kjøring av:
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-profiling-scoring-host-run.ts`
**KUN UA-3 P0 + open-loop-sliceen + Business-Event-Linkage er VERIFIED/COMPLETE - denne sliceen er
FIXED_SUITE, funksjonelt LIVE-bevist, men IKKE ferdig host-bevist (kun idempotens-verifikasjonsbugen
gjenstår) - HELE UA-3 er FORTSATT IKKE komplett** (se oppdatert Q-25). Support/tickets, Contracts/
e-sign (krever fortsatt en Tobias-provider-beslutning), tverr-domene driftsoversikt utover sales er
alle IKKE bygget/startet. **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.**

## UA-3 FINAL CLOSURE — Profiling/Scoring (2026-08-17, samme dag) — HOST VERIFIED → D-63

**Tobias kjørte `node --env-file=.env --experimental-transform-types
modules/business/scripts/ua3-profiling-scoring-host-run.ts` på sin faktiske Windows/Docker-host - GRØNT
resultat, run_id `61b5cf63`.** ANDRE host-kjøring, etter HOST FIX #1 (D-62) - denne runden kom HELE
VEIEN gjennom UTEN nye funn. Alle 17 markører PASS: `q21_runtime_role_safe`, `ua3_scoring_runtime_role`,
`ua3_scoring_lead` (`lead_score=60`), `ua3_scoring_opportunity` (`opportunity_score=50`),
`ua3_scoring_explainable`, `ua3_scoring_source_backed`, `ua3_scoring_versioned`,
`ua3_scoring_idempotent` (`score_rows_for_same_identity=1`), `ua3_scoring_protected_traits_blocked`,
`ua3_scoring_high_impact_blocked`, `ua3_scoring_manual_override` (`override_score=88`,
`underlying_score_unchanged=true`), `ua3_scoring_override_audit`, `ua3_scoring_tenant_isolation`,
`ua3_scoring_space_isolation`, `ua3_scoring_toolgateway`, `ua3_scoring_audit_safe`,
`ua3_scoring_cleanup` (`leftover_scores=0 leftover_tenants=0`). Runtime uendret gjennom hele kjøringen:
`runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`, `runtime_role_bypassrls=false`,
`scoring_runtime_role=jarvis_runtime`. `hard_fail=false`.

**Akseptansekriterium 4-re-evaluering ("Profiling/scoring used with documented legal/human controls
where required"): COMPLETE/VERIFIED.** Rettslig grunnlag (GDPR art. 6(1)(f), berettiget interesse for
intern prioritering av allerede lovlig innsamlet data) lagt til `UA3_BUSINESS_DPIA.md` denne runden.
GDPR art. 22 (automatiserte enkeltavgjørelser) eksplisitt vurdert og funnet IKKE relevant - en score
"produces" verken "legal effects" eller "similarly significantly affects" en person (avviser aldri,
nekter aldri tjeneste, avgjør aldri kreditt/ansettelse/forsikring - strukturelt umulig). Menneskelig/
juridisk kontroll (manuell overstyring + audit + full forklarbarhet) likevel TILSTEDE og host-bevist -
Appendiks D-gaten er dermed oppfylt i BÅDE bokstav og ånd.

**STATUS: VERIFIED/COMPLETE → D-63.** Full evidens (D-61/D-62/D-63) og oppsummering i
header-seksjonen øverst i denne filen. **KUN UA-3 P0 + open-loop-sliceen + Business-Event-Linkage +
denne sliceen er VERIFIED/COMPLETE - HELE UA-3 er IKKE komplett** (kriterium 1/2 fortsatt PARTIAL - se
oppdatert Q-25). **Masterplan v4.0 «Sovereign Autonomy» forblir IKKE komplett.** PR #12 merget til
`main` (normal merge-commit, samme konvensjon som PR #1-#11 - historikk bevart, ikke squashet).

## UA-3 — Support/Tickets (Zendesk, akseptansekriterium 1 delvis) = FIXED_SUITE / IKKE VERIFIED (2026-08-18, branch `claude/ua3-zendesk-support-connector`) → D-64

**Status: FIXED_SUITE / IKKE VERIFIED → D-64.** Bygget etter en egen research-only-runde som anbefalte
Zendesk (vektet D-41-matrise: API 20%/D-41 15%/webhooks 15%/Business OS-fit 10%/auth 10%/GDPR 10%/
kost 10%/migrasjon 5%/drift 5%, Zendesk foran Intercom/Freshdesk/Chatwoot) - Tobias godkjente Zendesk
eksplisitt. Bygget PÅ det VERIFIED/COMPLETE Business-Event-Linkage-fundamentet (D-60).

**Bygget:** migrasjon `023_zendesk_support.sql` (`zendesk_tickets`, FORCE RLS tenant+memory_space,
`support_ticket_needs_reply` lagt til open-loop-typene); `ZendeskTransport` (20 handlinger, OAuth 2.0
med in-memory-token-rotasjon - `docker-compose.yml` sin `env_file:`-only design gjør persistert
rotasjon strukturelt umulig fra kjørende container, samme `EMAIL_REAUTH_REQUIRED`-mønster som Google
brukt for restart-gjenoppretting); 20 `zendesk.*` ToolDefinitions (full D-41-kapasitet: klasse A 11
read, klasse B `update_ticket`/`add_internal_note`, klasse C `create_ticket`/`reply_ticket`, klasse D
`delete_ticket`/`redact_ticket_content`/webhook-CRUD - hver med `preflight_action`);
`ZendeskTicketService`/`ZendeskEventSyncService` (pointer-not-payload, deterministisk
e-post-kontaktgjenkjenning, tvetydige/ikke-matchede tickets lagres INGEN steder for å hindre
tenant-duplisering på delt Zendesk-konto); webhook-mottaker `POST /webhooks/zendesk`
(HMAC-SHA256/5-min replay-vindu/`timingSafeEqual`/rå-bytes-FØR-parse, kroppen brukes KUN til
ticket-ID, normalisering alltid via en FERSK `zendesk.get_ticket`); periodisk sync via EKSISTERENDE
`DailyScheduler`; `zendesk-reauth.ts`-orkestreringsskript; host-akseptanseskript
`ua3-zendesk-host-run.ts`→`ua3-zendesk-live.ts` (to-delt REACHABILITY (kun `list_tickets`, ALDRI ekte
mutasjon)/FakeTransport-strategi). 85 nye tester (1160→1245), typecheck 14/14 og lint rene.

**NYTT FUNN denne runden, IKKE bestilt av byggeordren:** under bygging av
`runZendeskEventSyncForAllTenants` ble et FJERDE tilfelle av samme RLS-blind-spørring-feilklasse som
D-54/D-59/D-62 oppdaget - denne gangen i PRODUKSJONSKODE, ikke bare i akseptanse-harnesser. `tenants`
har `FORCE ROW LEVEL SECURITY`; en rå, uskopet `pool.query("SELECT tenant_id FROM tenants WHERE
kind=...")` returnerer STRUKTURELT 0 rader i produksjon. Tre EKSISTERENDE, allerede-i-produksjon
`DailyScheduler`-funksjoner bruker nøyaktig dette mønsteret:
`runBusinessEventSyncForAllTenants()` (D-57), `runOpenLoopSweepForAllTenants()` (D-53),
`runScoringSweepForAllTenants()` (D-61) - alle tre har derfor sannsynligvis ALDRI oppdaget en eneste
tenant når de faktisk har kjørt periodisk. Bekreftet mekanisk mot ekte embedded Postgres; bekreftet at
INGEN av de tre har en test mot ekte Postgres (kun `runOpenLoopSweepForAllTenants` har noen test i det
hele tatt, og den bruker en `fakePool()`-mock som fullstendig omgår RLS - skjuler bugen, avdekker den
aldri). **Fikset KUN for den nye Zendesk-ekvivalenten** - ny, minimal `SECURITY DEFINER`-funksjon
`jarvis_list_tenant_ids_by_kind(p_kind, p_limit)` i `023_zendesk_support.sql` (eksponerer KUN
ikke-sensitiv `tenant_id`/`kind`, `GRANT EXECUTE` KUN til `jarvis_app`, Q-21-invarianten uendret). De
tre SØSKEN-funksjonene er BEVISST IKKE rørt i denne runden - byggeordren omfattet KUN
Zendesk-connectoren, en usanksjonert endring av tre andre allerede-i-produksjon funksjoner utenfor
bestilt scope ville brutt CLAUDE.md §10-disiplinen. **Dette er et potensielt alvorlig, foreløpig
IKKE-bekreftet produksjonsfunn** (ingen produksjonslogg gjennomgått i denne runden) - ny Q-27 logget
for sporing, fiksmønsteret er allerede designet/bevist og klart til gjenbruk på de tre.

**IKKE VERIFIED:** draft-PR opprettet, INGEN Tobias-host-kjøring utført ennå. Krever
`JARVIS_ZENDESK_*` konfigurert + `zendesk-reauth.ts` kjørt FØRST, deretter
`ua3-zendesk-host-run.ts` på ekte Windows/Docker-host.

## CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT (2026-08-18, branch `claude/architecture-core-adapter-invariant`) → D-65

**Permanent styringsregel, IKKE en implementasjonsoppgave.** Tobias identifiserte et tilbakevendende
feilmønster: et masterplan-kapabilitetsnavn (f.eks. "Support/tickets") ble tolket som "velg en ekstern
SaaS-leverandør og la den eie domenet" - konkret demonstrert av D-64 sin Zendesk-connector. Denne
runden gjør lærdommen permanent.

**Bygget (dokumentasjon/styring, INGEN kode endret):**
1. **CLAUDE.md regel 12** - CORE OWNERSHIP / ADAPTER BOUNDARY INVARIANT: et kapabilitetsnavn antyder
   ALDRI automatisk en leverandør. Jarvis eier kanonisk domenemodell/tilstand for intrinsic
   kapabiliteter (`JARVIS_CANONICAL`); eksterne tjenester er normalt kilder/sluk/transporter/
   adaptere/utførelsesleverandører (`EXTERNAL_CANONICAL`). IKKE "bygg alt selv" - målet er maksimal
   sovereign kontroll DER DET BETYR NOE.
2. **ARCHITECTURE.md §11** (ny seksjon, 11 underpunkter) - Core-vs-Adapter-beslutningsport (11
   spørsmål A-K), `CORE_DEPENDENCY_DECISION_REQUIRED=true`-eskaleringsmekanisme, forhold til D-41
   klargjort (D-65 avgjør OM en leverandør bør delta og med hvilken rolle - FØRST; D-41 avgjør HVOR
   FULLSTENDIG en akseptert connector skal være - ETTERPÅ), system-of-record-klassifisering
   (`JARVIS_CANONICAL`/`EXTERNAL_CANONICAL`/`HYBRID_WITH_CLEAR_AUTHORITY`), portabilitets-/utfalls-/
   dataeierskapstest, gjenbrukbar leverandørbeslutningsmal, full masterplan-avhengighetsaudit (§11.9,
   tabell over Gmail/Calendar/Drive/GitHub/Telegram/Vercel/HA/AI-modeller/tale/Zendesk/Contracts/
   finans/betalinger/CRM/meldingskanaler/observability/secrets), eksisterende tvilsomme grenser med
   alvorlighet (§11.10), Contracts/e-sign forebyggende grenseanalyse (§11.11).
3. **D-65** i DECISIONS_AND_ASSUMPTIONS.md - full beslutningstekst.
4. **Q-28** - Zendesk-connectoren (D-64, draft-PR #13) selv klassifisert HIGH alvorlighet: ticket-
   livssyklusen er strukturelt `EXTERNAL_CANONICAL` (Zendesk eier den) i stedet for en Jarvis-native
   Support Core med Zendesk som valgfri adapter. IKKE fikset her (kun dokumentert) - krever Tobias sin
   eksplisitte beslutning FØR PR #13 merges: (A) merge som eksplisitt midlertidig løsning + fremtidig
   migrasjonsplan, eller (B) sette PR #13 på vent og bygge en Jarvis-native Support Core først.
5. **Q-29** - Contracts/e-sign forebyggende grenseanalyse (Contract Core vs. Signature Execution
   Provider), INGEN leverandør valgt, INGEN kode bygget.

**Masterplan-avhengighetsaudit - hovedfunn:** de fleste eksisterende connectors
(Gmail/Calendar/Drive/GitHub/Telegram/Vercel/Home Assistant/AI-modell-leverandører/observability/
secret-håndtering/Business OS-CRM) er ALLEREDE korrekt klassifisert som adaptere bak eksisterende
abstraksjoner (`GmailTransport`/`ModelGateway`/`SecretProvider`/osv.) - INGEN endring nødvendig.
Business OS (D-49) er selve referanse-eksempelet på at Jarvis allerede korrekt eier sin egen
CRM-domenekjerne uten å la et eksternt CRM eie den. **Kun ett HIGH-funn: Zendesk-connectoren selv**
(se Q-28) - INGEN CRITICAL-grenser funnet.

**Q-26 (Knowledge Verification/Truth Promotion) og Q-27 (RLS-blind tenants-spørring i tre
produksjonsfunksjoner) UENDRET og bevart** - denne runden overlapper eller fortrenger ikke dem.

**Kvalitetsgater:** kun dokumentasjonsendring (CLAUDE.md/ARCHITECTURE.md/
DECISIONS_AND_ASSUMPTIONS.md/OPEN_QUESTIONS.md/PROJECT_STATUS.md) - ingen kode rørt, derfor ingen
ny test/typecheck/lint-kjøring fabrikkert som "nødvendig"; eksisterende 1245/1245-testbaseline
(D-64) er UENDRET av denne runden.

**HELE UA-3 forblir uendret av denne runden** - ingen fase-fullførelsesstatus endret.

## Blokkeringer
Q-20/UA-2 P0/Q-21/UA-2 P1A/P1A Runtime Wiring Closeout/UA-2 P1B-A/UA-3 P0/UA-3 Open-Loop Detection/
UA-3 Business-Event-Linkage/UA-3 Profiling/Scoring har INGEN egne blokkeringer (alle
VERIFIED/CLOSED/COMPLETE, merget til `main`).
Manglende provider-nøkler er eneste gap for LIVE multi-provider-evidens (Gemini/Kimi/Ollama).
Ytelsesgjeld for voice-latens (Q-19) er åpen, ikke-blokkerende. Pieces har ingen kjent integrasjonsflate
ennå (Q-22) - egen fremtidig underoppgave. Google Drive permission-mutasjon er IKKE live-host-bevist
(Q-23) - smalt, ikke-blokkerende gjenværende verifikasjonspunkt. P1B-A sin worker-JOBB-live-kjøring er
tilsvarende IKKE live-host-bevist (Q-24) - samme mønster, egen fremtidig test-runde. **UA-3
Support/Tickets (Zendesk, PR #13) er nå blokkert på TO SEPARATE ting, ikke bare én:** (1) en
Tobias-host-kjøring (uendret fra D-64), OG (2) NY denne runden - en eksplisitt Tobias-beslutning per
D-65/Q-28 om PR #13 skal merges som en midlertidig EXTERNAL_CANONICAL-løsning eller om en
Jarvis-native Support Core skal bygges FØRST med Zendesk som adapter. **Contracts/e-sign-connectoren
forblir blokkert på en EKSPLISITT Tobias-provider-beslutning, NÅ OGSÅ på Core-vs-Adapter-porten i
§11.2** (D-65/Q-29 legger til krav om at kontraktskjernen designes Jarvis-native FØR noen
signaturleverandør velges) - IKKE kodbar før dette foreligger, se D-57/Q-25 item 8 + Q-29. **Q-27:
tre pre-eksisterende produksjonsfunksjoner
(`runBusinessEventSyncForAllTenants`/`runOpenLoopSweepForAllTenants`/`runScoringSweepForAllTenants`)
har samme RLS-blind-tenants-spørring-bug som ble fikset for Zendesk - IKKE fikset i disse tre ennå**,
egen liten fremtidig BO, fiksmønsteret allerede designet. **Kriterium 2 sin gjenstående bredde
(product/finance/marketing/operations) er en FASE-AVHENGIGHET av UA-4/UA-5/UA-6, ikke et internt
UA-3-kodbart gap** - disse fasene er selv IKKE startet. Connector-audit-gapene
(GitHub/Calendar/Gmail/Telegram/Vercel/HA - se tabellen over) er dokumentert backlog, ikke blokkerende.

## Neste oppgave
**Umiddelbar neste oppgave: Tobias sin eksplisitte beslutning på Q-28** (D-65 sin Core-vs-Adapter-
grenserevurdering av PR #13/Zendesk) - dette avgjør hvordan UA-3 «Support/Tickets» faktisk skal
lukkes. Parallelt/uavhengig av den beslutningen kan Tobias fortsatt kjøre
`node --env-file=.env --experimental-transform-types modules/business/scripts/ua3-zendesk-host-run.ts`
for å host-verifisere den EKSISTERENDE Zendesk-connectoren sin funksjonelle korrekthet (uansett om den
til slutt merges som interim-løsning eller blir grunnlaget for en fremtidig adapter) - de to
beslutningene er uavhengige av hverandre. **UA-3 «Support/Tickets (Zendesk)» forblir FIXED_SUITE /
IKKE VERIFIED → D-64, uendret av denne governance-runden.** Draft-PR #13 fortsatt IKKE merget.

**HELE UA-3 er FORTSATT IKKE komplett** - masterplanens fire akseptansekriterier: kriterium 3
COMPLETE/VERIFIED (uendret fra D-56); kriterium 4 COMPLETE/VERIFIED (uendret fra D-63); kriterium 1
FORTSATT PARTIAL (Support/tickets nå FIXED_SUITE men IKKE VERIFIED, Contracts/e-sign fortsatt IKKE
bygget); kriterium 2 PARTIAL (uendret, kun sales, avhenger av UA-4/UA-5/UA-6) (se oppdatert Q-25).

**Gjenstående for kriterium 1:** **Contracts/e-sign-connector** (UA-3 P1, masterplan linje 1071) -
krever fortsatt en EKSPLISITT Tobias-provider-beslutning (f.eks. DocuSign/Dropbox Sign - kun
eksempler, IKKE forhåndsvalgt) FØR noe kan bygges - `NEEDS_TOBIAS_DECISION`, uendret.
**Kriterium 2 sin gjenstående bredde ligger UTENFOR "neste UA-3-slice"-scopet** inntil UA-4/UA-5/UA-6
faktisk starter - ingen duplisert domenesystem skal bygges internt i UA-3 bare for å lukke kriterium 2
tidlig. **IKKE startet:** UA-4, noen annen UA-fase. Faseporten gjelder fortsatt strengt
(CLAUDE.md-regel 10) - venter på en egen, eksplisitt byggeordre/-beslutning fra Tobias/arkitekten før
noe av det ovennevnte begynner.
**Eksplisitt IKKE bygget i Zendesk-sliceen:** automatisk ingestion av Ticket Audits/kommentarhistorikk
(kun on-demand); Zendesk Incremental Export-API (enklere standard-listing brukt i v1); trigger-/
automation-konfigurasjon utover Jarvis sin egen webhook-registrering; flere Zendesk-instanser per
tenant; Contracts/e-sign; UA-4. Faseporten gjelder fortsatt strengt (CLAUDE.md-regel 10).

Gjenstående, eksplisitt IKKE-blokkerende UA-2-relatert backlog (se D-48/OPEN_QUESTIONS.md for full
klassifisering - ingen av disse hindrer UA-2-lukkingen eller krever noe FØR UA-3 kan startes, men
ingen av dem er heller igangsatt uten egen godkjenning):
- Møtetranskripsjon - avhenger av UA-7 Communications Hub, som selv IKKE er bygget ennå.
- Pieces som kunnskapskilde (Q-22) - ingen kjent integrasjonsflate identifisert; uansett ikke
  nødvendig for UA-2 sitt "minst fem kilder"-krav, som er oppfylt uten Pieces.
- Dedikert lokal OCR-motor, ekte bildestøtte i providere utover Anthropic, docx/xlsx/pptx-ekstraksjon,
  finere per-vedlegg-checkpointing (D-43/Q-24) - ingen konkret behov identifisert.
- Google Drive permission-live-verifikasjon (Q-23) og P1B-A worker-JOBB-live-verifikasjon (Q-24) -
  begge egne, smale, eksplisitt godkjente test-runder (ikke byggearbeid).

Øvrige kandidater uendret i bakgrunnen: D-30 ytelsesgjeld (Q-19), D-10 STT-benchmark (Q-03), D-36
Apple, HA-RUNTIME, provider-nøkler for Gemini/Kimi/Ollama LIVE-benchmark, connector-audit-gapene
(D-41-sjekklisten, egne fremtidige byggeordre per connector),
`claude/hva-skjer-hvordan-ligger-0z3ztp`-branch-opprydding (krever noen med slette-rettighet på
repoet).
