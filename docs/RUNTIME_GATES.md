# Runtime gates – status og evidens (v4.0 reality check, 2026-08-13)

Statusverdier: NOT_IMPLEMENTED · IMPLEMENTED_NOT_VERIFIED · PARTIAL_RUNTIME · PRODUCTION_VERIFIED · BLOCKED_EXTERNAL

**Se også** [`docs/SOVEREIGN_GRADUATION_MATRIX.md`](SOVEREIGN_GRADUATION_MATRIX.md) (D-163, 2026-09-17)
for en konsis 16-områders graduation-oversikt som peker tilbake til de detaljerte radene her - denne
filen forblir den autoritative, detaljerte kilden. **UA-7/UA-8/UA-9-dokumentasjonshullet under er nå
LUKKET (D-197, 2026-09-19)** - de manglet tidligere en egen rad her til tross for å være kode-
implementert. Den opprinnelige sporingen skjedde under Q-35 (`docs/OPEN_QUESTIONS.md`), men Q-35 ble
LUKKET 2026-09-17 og deretter GJENBRUKT for et urelatert K1/owner-controls-tema (D-164→D-179) - denne
krysshenvisningen var derfor selv utdatert og er korrigert her, ikke fulgt blindt videre.

| Gate | Status | Evidens / gap |
|---|---|---|
| D-27 Langfuse | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | LangfuseTraceSink implementert (`modules/model-gateway/src/trace.ts`); krever Docker for kjørende instans |
| D-28 pgvector/HNSW | BLOCKED_EXTERNAL | Portabel `real[]`+cosine i drift (P95<300ms bevist i test); pgvector-migrasjon venter på Docker-image |
| D-30 Voice benchmark | BLOCKED_EXTERNAL | Harness + WER testet; krever ≥100 norske prøver + STT/TTS-nøkler |
| D-32 Worker Docker/GitHub | PARTIAL_RUNTIME + BLOCKED_EXTERNAL | Prosess-sandbox/lease/reclaim/kodejobb bevist (96→128-suiten); container + ekte GitHub-API mangler |
| D-35 Vault + live integrations | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | Alle adaptere/transportskall + SecretProvider klare; krever Infisical (Docker) + OAuth/API-credentials |
| D-36 Apple runtime | BLOCKED_EXTERNAL | Swift-kilde klar; krever Mac/Xcode/Developer-konto (sjekkliste: APPLE_PHASE8_CHECKLIST.md) |
| HA-RUNTIME | BLOCKED_EXTERNAL | HA-verktøy m/D-pipeline testet mot fake; krever HA-instans + token |
| OPS-RUNTIME | PARTIAL_RUNTIME | Watchdog/kill-switch-kriterier/backup+restore målt i test (fase 10); ekstern uptime/off-site backup gjenstår. **D-180 (W1, 2026-09-18/19):** watchdog-modulen var tidligere NULL-koblet til produksjon (ingen wiring i `apps/api`) og hadde en ikke-durabel kill-switch-aktivering i `costExplosionCheck` - begge rettet, nå wiret i `worker-main.ts` og bruker `killSwitch.activateDurable()`. **RETTET (D-181, BLOKKER B1, arkitekt-review av PR #96):** D-180 sin `GatewayAlertSink` rutet nødvarselet gjennom den ordinære `ToolGateway.execute({tool_id:"telegram", action:"notify"})`-stien - nektet av `PolicyGateway` med `kill_switch_active` når kill switchen (watchdog-ens EGEN aktivering) er aktiv. Erstattet av `WatchdogEmergencyAlertSink` som bevisst hopper over gateway/policy for KUN dette nødvarselet, uten å utvide `isSelfRecoveryAction()`. Kode-/suite-bevist; `WATCHDOG_HOST_ACCEPTANCE_REQUIRED=true` (IKKE kjørt ennå - se D-180/D-181) |
| UA0-AUTHORITY | PARTIAL_RUNTIME | **Implementert 2026-08-13:** `resolveAuthorityMode` (SOVEREIGN for owner-tenant, delegat arver aldri), sovereign klasse C/D uten approval, D-pipeline (preflight→state readback→before/after→recovery-snapshot→audit), OwnerControls (pause/freeze/revoke) håndhevet i policy+gateway. Evidens: `modules/tool-gateway/test/ua0-sovereign.test.ts` (pnpm test → 128/128). Live-verifikasjon mot ekte connectors gjenstår |
| UA0-PRIVACY | PARTIAL_RUNTIME | Tenant+space-RLS, karantene, injection-vern bevist i suiten; live-datastrøm gjenstår |
| UA0-RUNRATE | **PARTIAL_RUNTIME m/LIVE PROVIDER-EVIDENS** | 2026-08-13: ekte OpenAI-kall (gpt-4o-mini) gjennom ModelGateway mot ekte Postgres: cost_events={provider:openai, model:gpt-4o-mini, in:30, out:9, 3 øre, task-live-runrate/sess-live-1}, trace-span 2067 ms. Kommando: `node --experimental-transform-types modules/tool-gateway/scripts/live-runrate.ts`. Brief-generering skriver egen cost-rad (kind=brief:generation) → cost_per_daily_brief beregnes reelt. Sky-/connector-kost mangler live kilder |
| Q-21 DB admin/runtime-splitt | **PRODUCTION_VERIFIED (2026-08-15)** | Host-bevist (run_id `778bb87d`): `migrate_effective_db_user=postgres`, `runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`/`bypassrls=false`/`canlogin=true`/`member_jarvis_app=true`, `q21_runtime_role_safe=PASS`. Se D-38 og eget avsnitt under |
| UA-2 P0 Knowledge Ingestion | **PRODUCTION_VERIFIED (2026-08-15)** | Host-bevist (run_id `778bb87d`), ekte Postgres/pgvector+filsystem+GitHub, via `jarvis_runtime` (non-bypass). `symlink_escape=SKIPPED_HOST_PERMISSION` (suite-bevist, ikke live) - eksplisitt IKKE presentert som live-PASS. Se D-39 og eget avsnitt under |
| Q-20 Data erasure foundation | **PRODUCTION_VERIFIED (2026-08-16)** | Host-bevist på ekte Windows/Docker-host (run_id `eaabe2b1`): alle `q20_*`-felt PASS, `hard_fail=false`, `q21_runtime_role_safe=PASS`. Teknisk foundation, IKKE juridisk GDPR-sertifisering. Se D-40 og eget avsnitt under |
| UA-2 P1A Knowledge Source Expansion (Drive/Obsidian) | **PRODUCTION_VERIFIED (2026-08-16)** | Host-bevist på ekte Windows/Docker-host (run_id `2703299e`, `hard_fail=false`) etter ni oppfølgingsrunder. Obsidian-livssyklus + tenant-isolasjon/retrieval + Google Drive full read/write ende-til-ende (auth/read/create/update/rename/move/trash/permanent_delete/cleanup/sync/no-resurrection/idempotency/policy/live) alle PASS, ingen token-lekkasje. `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` - live permission-mutasjon IKKE host-bevist (se Q-23, ikke-blokkerende). Se D-42 og eget avsnitt under |
| UA-2 P1B-A E-post-vedlegg + OCR/vision | **PRODUCTION_VERIFIED (2026-08-17)** | Host-bevist på ekte Windows/Docker-host (run_id `0f43f39d`, `hard_fail=false`) etter to host-fix-runder (D-45/D-46). Gmail auto-reauth (`EMAIL_REAUTH_REQUIRED`→`google_email_reauth=PASS`), live Gmail-listing/vedleggsnedlasting, live vision-OCR, full sync (`scanned=5 created=5 failed=0`), Q-20-no-resurrection LIVE, `@napi-rs/canvas` native binær bevist lastet korrekt, ingen token-lekkasje - alle PASS. `p1b_worker_registration=SUITE_VERIFIED` - selve worker-JOBB-kjøringen (IKKE den direkte sync-kjøringen host-scriptet bruker) er IKKE live-host-bevist, se Q-24 (ikke-blokkerende, smalt gjenværende punkt). Se D-47 og eget avsnitt i PROJECT_STATUS.md |
| **UA-2 HELE FASEN (Universal Knowledge Layer, masterplan-closeout)** | **PRODUCTION_VERIFIED (2026-08-17)** | Overordnet lukking av UA-2 som helhet mot masterplanens fire ordrette akseptansekriterier (kildesystemer/provenance/tenant-isolasjon/DPIA) - se D-48. Bygger PÅ, erstatter IKKE, P0/P1A/P1B-A sine egne rader over. Worker-live-kjøring (Q-24) og Drive permission-live-verifikasjon (Q-23) eksplisitt vurdert og klassifisert IKKE-BLOKKERENDE - ingen av dem er et masterplan-akseptansekriterium |
| UA-3 P0 Business Domain Foundation | **PRODUCTION_VERIFIED (2026-08-17)** | Host-bevist på ekte Windows/Docker-host (run_id `ca2d9248`, `hard_fail=false`) etter tre host-runder: (1) `run_id b95dd25f` - scaffold-vs-runtime-pool-bug, fikset D-50; (2) `run_id ad45603d` - alle 13 Business OS-kapabilitetstester PASSET, kun CLEANUP feilet, fikset D-51; (3) `run_id ca2d9248` - HELE VEIEN gjennom, alle 13 kapabilitetsmarkører OG alle 5 CLEANUP-markører PASS, ingen nye funn. Runtime uendret (`jarvis_runtime`/NOSUPERUSER/NOBYPASSRLS) gjennom alle tre kjøringer. Suite-verifisert (930/930, 44 nye tester). Se D-52 og eget avsnitt i PROJECT_STATUS.md. Kun P0 er VERIFIED - resten av UA-3 er IKKE komplett (se Q-25) |
| UA-3 Open-Loop Detection + Business Brief | **PRODUCTION_VERIFIED (2026-08-17)** | Host-bevist på ekte Windows/Docker-host (run_id `de01ca07`, `hard_fail=false`) etter tre host-runder: (1) `run_id 19a7f3a4` - 12/14 kapabilitetsmarkører PASS, idempotens-akseptansen (RLS-blind harness-spørring) og CLEANUP (`cost_events`-FK) feilet, fikset D-54; (2) `run_id c7fe8206` - begge D-54-fikser bekreftet PASS live (`ua3_open_loop_idempotency=PASS`, `duplicate_rows_for_same_key=1`), CLEANUP feilet PÅ NYTT med et uavhengig `brief_seen`-FK-funn (samme `DailyBrief.generate({pool})`-kodeblokk som cost_events), fikset D-55 (+ selvdiagnostisk, skjema-drevet FK-sjekk som fanger fremtidige ukjente avhengigheter automatisk); (3) `run_id de01ca07` - HELE VEIEN gjennom, alle 16 markører PASS, ingen nye funn. `q21_runtime_role_safe=PASS`/`ua3_open_loop_runtime_role=PASS`/`runtime_role_superuser=false`/`runtime_role_bypassrls=false` uendret alle tre kjøringer. 1010/1010 tester, lint/typecheck/gitleaks rene. Se D-53/D-54/D-55/D-56 og eget avsnitt i PROJECT_STATUS.md. Kun P0 + denne sliceen er VERIFIED - resten av UA-3 er IKKE komplett (se Q-25) |
| UA-3 Business-Event-Linkage (Gmail/Calendar → Business OS) | **PRODUCTION_VERIFIED (2026-08-17)** | Host-bevist på ekte Windows/Docker-host (run_id `6c6a4948`, `hard_fail=false`) etter tre host-runder: (1) `run_id 7c5a5289` traff `tool_failed:credential_unavailable` på REACHABILITY - akseptanseskriptets secret-provider-bug, fikset D-58; (2) `run_id b969e9e7` - ALLE funksjonelle markører PASSET LIVE (ekte Gmail `scanned=25`/Calendar reachability, matched/unmatched/ambiguous, idempotens, isolasjon, open-loop-reevaluering, cleanup) - KUN `ua3_events_audit_safe=FAIL` blokkerte, rotårsak SAMME feilklasse som D-54 (RLS-blind raw `pool.query()` mot `audit_events`, som har FORCE RLS) - fikset D-59 (`withTenantTransaction()`, ren akseptanse-harness-fiks, ingen produksjonskode rørt); (3) `run_id 6c6a4948` - HELE VEIEN gjennom, alle markører PASS inkl. `ua3_events_audit_safe=PASS` (`audit_event_found=true`), ingen nye funn. Runtime uendret (`jarvis_runtime`/NOSUPERUSER/NOBYPASSRLS) gjennom alle tre kjøringer. 1082/1082 tester, lint/typecheck rene. Se D-60 og eget avsnitt i PROJECT_STATUS.md. **KUN denne sliceen er VERIFIED - HELE UA-3 er FORTSATT IKKE komplett** (akseptansekriterium 1 kun PARTIAL på full katalogbredde, kriterium 2 PARTIAL, kriterium 4 NOT STARTED - se D-60 firekriterie-matrise og Q-25) |
| UA-3 Profiling/Scoring (akseptansekriterium 4) | **PRODUCTION_VERIFIED (2026-08-17)** | Host-bevist på ekte Windows/Docker-host (run_id `61b5cf63`, `hard_fail=false`) etter to host-runder: (1) `run_id 22226237` - ALLE funksjonelle markører PASSET LIVE (lead-score=60, opportunity-score=50, manuell overstyring, isolasjon, audit, cleanup), KUN `ua3_scoring_idempotent=FAIL` (RLS-blind `withTenantTransaction()`-spørring mot `business_scores`, samme feilklasse som D-54/D-59), fikset D-62; (2) `run_id 61b5cf63` - HELE VEIEN gjennom, alle 17 markører PASS inkl. `ua3_scoring_idempotent=PASS` (`score_rows_for_same_identity=1`), ingen nye funn. Transparent, deterministisk BUSINESS-OPERASJONELL prioritering (`lead_priority_v1`)/risiko-scoring (`opportunity_risk_v1`) - ALDRI generalisert personprofilering (entitetsscope strukturelt begrenset via DB-CHECK). Full forklarbarhet, versjonert regelmotor, manuell eier-overstyring, 100% deterministisk v1, hoy-konsekvens-personbeslutning strukturelt umulig, GDPR art. 22 eksplisitt vurdert og funnet ikke relevant, rettslig grunnlag (art. 6(1)(f)) dokumentert i `UA3_BUSINESS_DPIA.md`. Runtime uendret (`jarvis_runtime`/NOSUPERUSER/NOBYPASSRLS) begge kjøringer. 1160/1160 tester, lint/typecheck rene. Se D-61/D-62/D-63 og eget avsnitt i PROJECT_STATUS.md. **Akseptansekriterium 4 = COMPLETE/VERIFIED. HELE UA-3 er FORTSATT IKKE komplett** (kriterium 1/2 PARTIAL - se D-60/D-63 firekriterie-matrise og oppdatert Q-25) |
| Q-27 RLS-blind business-tenant-enumering (produksjonsfiks) | **PRODUCTION_VERIFIED (2026-08-18)** | Host-bevist på ekte Windows/Docker-host, run_id `8549d23f`, `hard_fail=false`, ALLE 15 markører PASS (`q21_runtime_role_safe`, `q27_direct_runtime_global_query_restricted`, `q27_catalog_business_tenants`, `q27_catalog_excludes_nonbusiness`, `q27_catalog_minimal_surface`, `q27_catalog_public_execute_denied`, `q27_catalog_runtime_execute_allowed`, `q27_open_loop_scheduler`, `q27_business_event_scheduler`, `q27_scoring_scheduler`, `q27_multiple_business_tenants`, `q27_tenant_isolation`, `q27_runtime_no_superuser`, `q27_runtime_no_bypassrls`, `q27_cleanup`). Ny `SECURITY DEFINER`-katalogfunksjon `jarvis_list_business_tenant_ids()` (`023_business_tenant_catalog.sql`) + delt TS-hjelper `listBusinessTenantIds()` (`@jarvis/core`) erstatter tre uavhengige, RLS-blinde rå spørringer i `runOpenLoopSweepForAllTenants`/`runBusinessEventSyncForAllTenants`/`runScoringSweepForAllTenants` (D-53/D-57/D-61). `jarvis_runtime` bekreftet UENDRET NOSUPERUSER/NOBYPASSRLS (Q-21) i selve host-kjøringen. 16 nye tester (ekte embedded Postgres, IKKE `fakePool()`) + eksisterende `fakePool()`-tester beholdt. 1176/1176 tester, typecheck 14/14, lint rene. Se D-65 og Q-27 (VERIFIED/CLOSED). PR #16 klar for review - **MERGES IKKE uten Tobias' eksplisitte godkjenning** |
| UA-3 Native Jarvis Support Core (Support/tickets, akseptansekriterium 1) | **VERIFIED/COMPLETE (2026-08-18, D-66/D-67/D-68/D-69/D-70, host-bevist run_id `da7e0c1b`, `hard_fail=false`)** | Implementerer D-64 sitt `JARVIS_CANONICAL`-vedtak: ny pakke `@jarvis/support`, migrasjon `024_support.sql` (`support_tickets`/`support_ticket_events`). ZERO Zendesk-avhengighet (bevist mekanisk, `ua3_support_no_zendesk_dependency=PASS`). Deterministisk lifecycle, Gmail-ingress via EKSISTERENDE `GmailTransport`, entitetsresolusjon gjenbruker `BusinessService.findContactsByEmail()`, kunde-svar ruter GJENNOM eksisterende `email.send` (klasse D uendret, autoritet propagert fra DEN EKTE kalleren - se D-68), open-loop-integrasjon gjenbruker `OpenLoopService.runSweep()` UENDRET, tenant-katalog gjenbruker Q-27 sin `listBusinessTenantIds()`. **Tre host-funn-runder FØR endelig grønn kjøring:** (1) D-67, run_id `60f0d682`/`5457c59a` - akseptanse-credential-provider-bug + Q-20 FK-erasure-ordering (`025_business_open_loops_ticket_grant.sql`); (2) D-68 (SIKKERHETSFIKS) - D-67 sin `JARVIS_OWNER_PERSON_ID`-reply-fiks var en REELL rettighetseskalering (enhver support.reply-autorisert kaller fikk sitt nøstede `email.send` utført MED eier-authority) - fikset ved `ToolInvocationContext` (`{identity, approval}`) som 4. parameter på `ToolTransport.invoke()`, ekte kaller-identitet/godkjenning propagert UENDRET; (3) D-69, run_id `1e821a86` - kun syntetisk akseptanse-teardown (`business_followups`/`erasure_requests`), produksjonens erasure-retensjon UENDRET. **D-70 (2026-08-18): FJERDE, REN host-kjøring** - run_id `da7e0c1b`, `hard_fail=false`, ALLE 26 markører PASS (inkl. `ua3_support_reply_path`, `ua3_support_q20`, `ua3_support_cleanup`). Runtime bekreftet: `jarvis_runtime`, `superuser=false`, `bypassrls=false` - Q-21 uendret gjennom alle fire runder. 98 nye tester totalt over hele slicen (1176→1268, full suite grønn), typecheck/lint rene, GitHub CI (`gitleaks`+`build-test`) grønn. Draft-PR #17 klar for review - **MERGES IKKE uten Tobias sin eksplisitte godkjenning**. Support/tickets K1-delkriterium VERIFIED; K1 SOM HELHET forblir PARTIAL (Contracts/e-sign, Q-28, fortsatt ikke bygget) |
| UA-3 Native Jarvis Contracts Core (Contracts/e-sign, CONTRACT CORE-halvpart, K1) | **VERIFIED/COMPLETE (2026-08-18, D-71/D-72/D-73, host-bevist run_id `5ca4765b`, `hard_fail=false`, ALLE 26 markører PASS)** | Implementerer D-64/Q-28 sitt `JARVIS_CANONICAL`-vedtak for kontraktdomenet: ny pakke `@jarvis/agreements` (IKKE `@jarvis/contracts` - navnekollisjon med den delte type-kontrakt-pakken), migrasjon `026_contracts.sql` (`contracts`/`contract_versions`/`contract_obligations`/`contract_events`). ZERO e-sign-leverandør-avhengighet (bevist mekanisk, `ua3_contracts_no_esign_dependency=PASS`). Deterministisk lifecycle (`draft→review→approved→active→expiring→expired→terminated→cancelled`, terminale statuser kun korrigerbare tilbake til `draft`), eksplisitte immutable versjoner, motparter gjenbruker EKSISTERENDE `business_companies`/`business_contacts`, forpliktelser (`open/completed/waived`) besvarer "hva må vi gjøre"/"hva forfaller"/overdue deterministisk, open-loop-integrasjon utvider `OpenLoopService.runSweep()` UENDRET (fire nye regler: renewal/termination/obligation/review), tenant-katalog gjenbruker Q-27 sin `listBusinessTenantIds()`. `contract.*`-ToolGateway-namespace (24 handlinger): klasse A lesing, klasse B interne skrivinger, klasse C KUN `set_status` (ingen klasse D i denne sliceen). Q-20: alle fire tabeller + kontrakt-tilknyttede `business_open_loops`-rader registrert i `plan.ts` FØR noen host-runde (samme FK-lærdom som D-67, anvendt forebyggende), ekte `ErasureService` host-bevist. **To host-funn-runder FØR endelig grønn kjøring:** D-72 (run_id `1e9ae3a8`/`53d294b8`, begge `hard_fail=true`, KUN `ua3_contracts_cleanup=FAIL` - `business_followups`-akseptansefixture ikke ryddet av `cleanupTenant()`, samme feilklasse som Support sin D-69, fikset uten produksjonskode-endring). **D-73 (2026-08-18): TREDJE, REN host-kjøring** - run_id `5ca4765b`, `hard_fail=false`, ALLE 26 markører PASS. Runtime bekreftet `jarvis_runtime`/`superuser=false`/`bypassrls=false` - Q-21 uendret. 104 tester totalt (typecheck 16/16 rent, lint rent, full suite grønn). Draft-PR #18 klar for review - **MERGES IKKE uten Tobias sin eksplisitte godkjenning**. Contracts-delkriterium (K1) er NÅ VERIFIED/COMPLETE; **K1 SOM HELHET er NÅ OGSÅ VERIFIED/COMPLETE** (D-73: det ordrette akseptansekriteriet - "complete source-backed timeline" - krever ikke juridisk e-signaturutførelse; Q-28 sin SIGNATURE EXECUTION ADAPTER-halvpart forblir et separat, ÅPENT Integrasjonskatalog-punkt, ikke en del av K1 selv) |
| UA-4 Growth → Business Domain Coverage-integrasjon (UA4_SLICE_2) | **CI_VERIFIED / COMPLETE (2026-08-19, D-78/D-79)** | Lukker Q-29 punkt 7: `BUSINESS_DOMAIN_COVERAGE` (`business-brief.ts`) hardkodet FORTSATT `marketing: "not_integrated"` etter at Native Growth Core (D-74/D-77) allerede var VERIFIED/COMPLETE - datakilden fantes, men var ikke koblet inn i rapporteringen. D-64-gate: `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true`, ingen leverandør. Verdien utvidet fra bar streng til `{status, source, live_provider_connected}` - domenekapabilitet (`status`) og ekstern leverandør-tilkobling (`live_provider_connected`) er BEVISST separate felt, forveksles ALDRI. `marketing.status="available"` (Native Jarvis Growth Core), `marketing.live_provider_connected=false`. `sales`/`product`/`finance`/`operations` uendret i sak. **D-79 (2026-08-19): CI-akseptanse erstatter manuell host-kjøring, slice-spesifikt unntak** - kvalifiseringssjekk bekreftet: ingen migrasjon/credential/leverandør/ny ToolGateway-handling/OS-spesifikk atferd, ren rapporteringsendring. Ny CI-kjørt test `business-brief.test.ts` §E beviser Business OS-tidslinjen (`companyTimeline()`) upåvirket av en sameksisterende ekte `marketing_campaigns`-rad (ekte embedded Postgres, del av `pnpm test` i `build-test`-CI-jobben). Alle 10 host-script-markører kartlagt til automatisert CI-dekning. `Q21_REGRESSION=UNCHANGED` (kanonisk `runtime-role.test.ts` 6/6 grønn, uendret av denne sliceen). Host-scriptet (`ua4-growth-domain-coverage-host-run.ts`/`-live.ts`) beholdt KUN som referanse - IKKE lenger release-gate, `TOBIAS_HOST_ACTION_REQUIRED=false`. **Verifiseringsklasse:** `CI_VERIFIED` ≠ `HOST_VERIFIED` (annen, ikke svakere, bevis-kilde) - SLICE-SPESIFIKT unntak, IKKE en generell fjerning av host-verifisering for fremtidig UA-4-arbeid med ekte leverandører/Docker-topologi/credentials/nettverk/Home Assistant/tale/maskinvare/Windows-spesifikk atferd. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full suite 107/107 filer, 1439/1439 tester grønn (+1 §E-test), lokal `gitleaks` "no leaks found". UA-3 kriterium 2: `sales=AVAILABLE marketing=AVAILABLE product/finance/operations=NOT_INTEGRATED` - fortsatt IKKE komplett (2/5). Q-20 N/A (ingen ny tabell). Q-21/Q-27/Q-26 uendret. Ingen ny ToolGateway-handling. Draft-PR #20, IKKE merget. **PR #20 MERGET 2026-08-19 etter Tobias sin eksplisitte godkjenning** (merge-SHA `f602040`) - status forblir uendret CI_VERIFIED/COMPLETE på `main`. |
| UA-4 Google Ads-adapter, LIVE-VERIFISERINGSVEI + D-41-RE-AUDIT (PR #23 pre-merge hardening) | **FIXED_SUITE_COMPLETE=true / LIVE_RUNNER_READY=true / IKKE LIVE_PROVIDER_VERIFIED (2026-08-19, D-84, D-83-oppfølging)** | Lukker D-83 sitt `HOST_ACTION_REQUIRED=true`-gap FØR review/merge, UTEN å endre adapterens produksjonsatferd (kun kommentaroppdatering). Ny live-runner: `modules/growth/scripts/google-ads-live-host-run.ts`+`google-ads-live.ts` (samme bootstrap+akseptanse-todeling som alle øvrige UA-3/UA-4-scripts) + `scripts/lib/google-ads-live-lib.ts` (enhetstestbare rene funksjoner). ÉN Windows-kommando, uendret FØR/ETTER Tobias' oppsett: `node --env-file=.env --experimental-transform-types modules/growth/scripts/google-ads-live-host-run.ts`. Env-preksjekk navngir eksakt manglende variabel (aldri verdi); `BLOCKED_NO_CREDENTIALS` er FORVENTET (`hard_fail=false`) FØR oppsett, Q-21-regresjon ALLTID hard_fail. `list_campaigns` beviser auth/customer-access/provider-read SAMTIDIG (tom liste = PASS). Kampanje-/utgiftssynk kjørt to ganger via `ToolGateway.execute()` for idempotens. NO_DATA (scanned=0) DISTINKT fra FAIL. gclid NO-GUESS-bevis strukturelt (registered<=raw). Tenant-isolasjon + cleanup (kun egen syntetisk tenant, Google Ads-kontoen ALDRI rørt). Secret-safety etterprøvbart bevist (skanner hele loggbufferet). **D-41 re-audit:** ny research-agent styrket alle 8 implementerte-behaviour-punkter fra `VERIFIED_SEARCH_SNIPPET` til `VERIFIED_OFFICIAL_SEARCH_SNIPPET` (WebFetch fortsatt blokkert); 401/403-aldri-retries nedgradert til `UNVERIFIED_INFERRED` (utledet, ikke sitert - INGEN kodeendring, koden var allerede konservativ). 31 nye tester (`google-ads-live-lib.test.ts` §A-H, inkl. strukturelt kildetekst-bevis mot mutate-handlinger/unscoped DELETE). `main` FØR=1552/110 → ETTER=1583 (+31)/111 filer, 111/111 grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. PR #23 oppdatert, IKKE merget. Full detalj: D-84 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-4 Google Ads-adapter, LES/RAPPORTERING/SYNK (første live markedsføringsprovider) | **FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED (2026-08-19, D-83)** | Tobias bekreftet Google Ads som `FIRST_MARKETING_PROVIDER` (forrige research-runde). WebFetch mot `developers.google.com` BLOKKERT i dette miljøet - Google Ads REST/GAQL-fakta verifisert av en research-agent og merket `VERIFIED_SEARCH_SNIPPET`/`UNVERIFIED` per påstand; `UNVERIFIED`-kapabiliteter (mutate-idempotens, conversion-upload) STOPPET eksplisitt fremfor gjettet virkemåte. D-64-gate: `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY` (Jarvis = kanonisk kampanje-/attribusjonsmodell uendret siden D-74; Google = autoritativ kilde for RÅ leverandørfakta med proveniens), `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Growth Core fungerer UENDRET UTEN Google Ads. D-41: LESING/RAPPORTERING/`click_view`(gclid) = IMPLEMENTERT (klasse A/B); OPPRETT/OPPDATER/FJERN/PAUSE/RESUME/BUDSJETT/BUD/NØKKELORD/MÅLGRUPPE/KREATIV/KONVERTERING-OPPLASTING = EKSPLISITT UTSATT (Finance Integrity-sekvenseringsgrense, IKKE permanent read-only). Denne sliceen øker ALDRI budsjett/bud, oppretter ALDRI ekte forbruk. `click_view.gclid` mappes til EKSISTERENDE `marketing_campaign_tracking_tags` (D-82) via EKSISTERENDE `registerCampaignTrackingTag()` - INGEN ny attribusjonsmekanisme. `GoogleAdsTransport` i `modules/growth` (unngår sirkulær pakkeavhengighet), delt OAuth-tokenfornyelse gjenbrukt fra `googleAccessToken()` (`modules/tool-gateway`, kun `export` lagt til) med EGET `JARVIS_GOOGLE_ADS_REFRESH_TOKEN`/`adwords`-scope. To nye `GrowthService`-metoder (`findCampaignByExternalId`/`upsertCampaignFromProvider`, idempotent via EKSISTERENDE UNIQUE-constraint, INGEN ny migrasjon). Streng datovalidering FØR GAQL-strenginterpolasjon, bounded retry (3 forsøk, kun 429/5xx), per-rad try/catch (delvis-synk-sikkerhet), 24t Google-utfall tar Growth Core NED for NY synk men eksisterende tilstand forblir brukbar. `googleads.*`-ToolGateway (4 handlinger, klasse A/B, INGEN klasse D). ZERO ModelGateway-kall, tokens KUN i HTTP-headere (bevist), feilmeldinger fri for hemmeligheter (bevist). Q-20/21/26/27 uendret prinsipp. Reell bug funnet+fikset: `started_at` ikke satt ved første insert. 38 nye tester, `main` FØR=1514/108 → ETTER=1552 (+38)/110 filer, 110/110 grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **HOST_ACTION_REQUIRED=true for LIVE-verifisering** (Google Ads API-aktivering, adwords-scope, ny refresh-token, Developer Token-søknad, Customer ID, `.env`) - INGEN Tobias-handling krevd for denne kode-lukkingen selv. Draft-PR, IKKE merget. UA-4 SOM HELHET forblir IKKE komplett. |
| UA-4 Deterministisk UTM-/klikk-ID-basert auto-attribusjon (SLICE 3) | **CI_VERIFIED / COMPLETE (2026-08-19, D-82)** | Lukker Q-29 punkt 6. D-64-gate: `CORE_DEPENDENCY_DECISION_REQUIRED=false` - ren applikasjonslag-oppslagslogikk mot Jarvis sine EGNE registrerte kampanje-sporingstagger, ZERO ekstern annonseplattform-avhengighet. Ny migrasjon `028_growth_attribution_tracking.sql` (`marketing_campaign_tracking_tags`, to gjensidig utelukkende taggtyper - `click_id`/`utm`-triplett, to partial UNIQUE-indekser sikrer idempotent registrering OG strukturelt umulig ambiguity). Fire nye `GrowthService`-metoder (`registerCampaignTrackingTag`/`listCampaignTrackingTags`/`resolveCampaignFromTracking`/`attributeFromTracking` - sistnevnte kaller den EKSISTERENDE `attributeToCampaign()` uendret). Fire nye `growth.*`-ToolGateway-handlinger (klasse A/B, INGEN klasse D). Deterministisk oppslag returnerer `null`/kaster `no_matching_campaign_for_tracking` ved ingen EKSAKT match - ALDRI en gjettet kampanje (Q-26-grensen). Ny tabell registrert i erasure-planen (Q-20), bevist erasert. Q-21/Q-27 uendret. 17 nye tester (11 `service-rls.test.ts` §M mot ekte embedded Postgres/RLS + 6 `transport-wiring.test.ts` §C2). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full suite 108/108 filer, 1514/1514 tester grønn (var 1497). INGEN Tobias-host-handling krevd (rent CI-verifiserbart). Draft-PR, IKKE merget. UA-4 SOM HELHET forblir IKKE komplett (live connectorer/autonome endringer/kreativ intelligens/Finance Integrity Gateway/samtykke-dokumentasjon alle fortsatt NOT_STARTED/BLOCKED/DEFERRED). |
| Jarvis AI Mesh — Gemma-first kost-/personvernarkitektur | **CI_VERIFIED / COMPLETE (2026-08-19, D-80/D-81, INGEN EKTE LIVE-PROVIDER-KJØRING)** | Claude er IKKE lenger standardmodell for ordinær 24/7-drift. D-64-gate: `JARVIS_CORE=`rutingpolicy/kapabilitetsregister/kost-/helse-/budsjett-sporing (allerede referanse-eksempel på korrekt grense, `ARCHITECTURE.md` §11.1); `EXTERNAL_ROLE=`selve modell-inferensen; `SYSTEM_OF_RECORD=JARVIS_CANONICAL`; `CAN_RUN_WITHOUT_PROVIDER=true`. D-41-gate for hostet Gemma: ekte tool calling/strukturert output/usage/helse/retry/timeout wiret, streaming bevisst utelatt (samme grense som eksisterende `gemini`-adapter). To nye providere: `gemma_hosted` (`packages/provider-adapters/src/gemma.ts`, Gemini API, nøkkel i header) og `local_llm` (`local-llm.ts`, OpenAI-kompatibelt lokalt endepunkt, `LOCAL_LLM_BASE_URL`, ingen default-URL/IP). Ny `DataSensitivity`-klassifisering (`@jarvis/contracts`) + valgfritt `sensitivity`-felt på `RouteInput`/`CompleteInput` (udefinert = uendret ruting, migrasjonssikkert) + `hosted_free_tier`-markør (kun `gemma_hosted=true`). Router: `PRIVATE`/`BUSINESS_CONFIDENTIAL` ekskluderer gratis-tier, foretrekker lokal (myk bonus); `SECRET_RESTRICTED` = kun lokal, fail-closed uten lokal (også ved eier-override). `gemma_hosted` vinner AUTO/BACKGROUND-ruting matematisk (registry-tall: cost_class=1, quality_class=4); Claude/OpenAI vinner fortsatt `QUALITY`/`CRITIC`/`VISION`. Bakgrunnsjobb-audit: alle `DailyScheduler`-jobber er 100% deterministiske (ingen ModelGateway-kall); executive-worker arver Gemma-standarden automatisk men klassifiserer IKKE ennå `sensitivity` (Q-30). Bugfiks: `gemini`-profilen sin feilaktige `streaming: true`-påstand fjernet (adapteren har aldri hatt `.stream()`). 44 nye tester (22 + 22 = 44 - `modules/model-gateway/test/gemma-first-routing.test.ts` 22 + `conformance.test.ts` utvidet 22 nye saker). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full suite 108/108 filer, 1483/1483 tester grønn. INGEN ekte live-provider-kjøring i denne økten (ingen API-nøkkel konfigurert) - arkitektur-/enhets-/integrasjonsverifisering ikke blokkert (alt bevist mot mocket fetch). Draft-PR, IKKE merget. Q-30 registrert for gjenstående kabling (bakgrunnsjobb-sensitivitetsklassifisering, Gemma-streaming, lokal maskinvare, kostmetrikk-dashbord). **D-81 (2026-08-19, samme PR #21, pre-merge sikkerhetsherding): P0-FUNN OG FIKS** - udefinert sensitivitet kunne feilaktig nå `hosted_free_tier` (`gemma_hosted`); `isSensitivityEligible()` krever nå eksplisitt `PUBLIC_OR_LOW_SENSITIVITY` for gratis-tier-kvalifisering (fail-safe), gjelder også eier-override. Full entry-point-audit fant OGSÅ `apps/api/src/conversation.ts` (hoved-samtalemotoren, ikke revidert i D-80) - ingen kodeendring nødvendig der, fiksen i routeren dekker den strukturelt. D-41 korrigert: Gemma-vision NÅ EKTE IMPLEMENTERT (`toGemmaParts()`, `inlineData`); streaming forblir bevisst utsatt med presis `PROVIDER_SUPPORT=true`/`ADAPTER_SUPPORT=false`-distinksjon (ikke lenger feilaktig fremstilt som en Gemma-begrensning). Pris-metadata (`pricing_mode`/`pricing_verified_at`) lagt til. Testregnskap korrigert (44, ikke 26) + 14 nye D-81-tester (33+13=46 i berørte filer). Nytt totalregnskap: 1439→1483 (D-80)→1497 (D-81), 108/108 filer grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, lokal gitleaks "no leaks found". **D-80 = CI_VERIFIED/COMPLETE ETTER D-81 sin fiks.** Draft-PR #21, IKKE merget. |
| UA-4 Native Jarvis Growth Core (Growth & Marketing Control Plane, UA4_SLICE_1) | **VERIFIED/COMPLETE (2026-08-19, D-74/D-75/D-76/D-77, fjerde og RENE host-kjøring run_id `8f2b89e1`, `hard_fail=false`, ALLE 23 markører PASS)** | ENDELIG LUKKING (D-77): fjerde host-runde, INGEN nye funn - alle tre tidligere FAIL-markører (`ua4_growth_spend_idempotent`, `ua4_growth_cac_roas`, `ua4_growth_open_loop_resolved`) nå bekreftet PASS live. Repo-sannhet bekreftet (HEAD `598f4547` identisk lokal/origin, GitHub CI gitleaks+build-test begge grønne, `mergeable_state=clean`). **UA-3 kriterium 2 re-evaluert mot det ordrette "kombinerer sales/product/finance/marketing/operations"-kriteriet** (INTEGRASJONS-kriterium, ulikt K1 sitt RESULTAT-kriterium): `business-brief.ts` lest direkte - `BUSINESS_DOMAIN_COVERAGE` har FORTSATT `marketing: "not_integrated"` hardkodet, ingen kabling til `growth.*` finnes. Kriterium 2 markeres derfor FORTSATT IKKE oppfylt - datakilden eksisterer nå (nødvendig, ikke tilstrekkelig), kombineringen er ugjort (Q-29 punkt 7). PR #19 klar for review, `MERGE_READY=true`, MERGES IKKE uten Tobias sin eksplisitte godkjenning. UA-4 SOM HELHET forblir IKKE komplett (kun første slice). Full detalj D-77 i DECISIONS_AND_ASSUMPTIONS.md. HOST FIX #2 (D-76): 18/19 markører PASS (CAC/ROAS + open-loop-resolusjon nå bekreftet PASS live etter D-75), KUN `ua4_growth_spend_idempotent=FAIL` gjensto - rotårsak var en tidssone-bug i D-75 sin EGEN dato-fiks (`new Date(pgDate).toISOString()` konverterer pg-types sin LOKALT-konstruerte `date`-verdi til UTC, som ruller datoen tilbake én dag på enhver host med UTC-offset ≠ 0 - reprodusert eksplisitt med `TZ=Europe/Oslo`). Fikset med én kanonisk `pgDateToIsoDate()`-helper (`@jarvis/core`, lokale getter-baserte, tidssone-uavhengig), brukt baade i host-scriptet og i det latente (usett i UTC-CI) tilsvarende mønsteret i `service-rls.test.ts`. Den sammenslaatte spend-idempotens-sjekken er nå splittet i fire eksplisitte delmarkører + et urelatert-kampanje-bevis, saa en fremtidig delvis regresjon ikke kan skjule seg bak et for grovkornet aggregat. PRODUCTION_BUG=false begge host-fix-rundene. 4 nye regresjonstester (inkl. to `TZ=Europe/Oslo`-barneprosess-bevis). HOST FIX #1 (D-75): eksakt tre markører FAIL begge ganger (`ua4_growth_spend_idempotent`, `ua4_growth_cac_roas`, `ua4_growth_open_loop_resolved`), 16/19 øvrige PASS. Alle tre spores til `ua4-growth-core-live.ts` sin EGEN verifikasjons-/fixture-kode (Date-til-streng-koersjonsbug, RLS-kontekstløs rå `pool.query()`-UPDATE, terskel-matte kopiert fra en annen spike-størrelse) - IKKE til `GrowthService`/`OpenLoopService`, som begge var korrekte hele tiden. Ett ekte produksjonshull avdekket og fikset: `BusinessService.updateOpportunityStage()` fikk en ny valgfri `valueOre`-parameter (RLS-trygg, D-41-samsvarende) - tidligere fantes INGEN kanonisk vei til å sette `value_ore` ved lukking. 3 nye regresjonstester, full detalj i D-75/D-76. Krever ÉN NY REN host-kjøring før D-74 kan markeres VERIFIED/COMPLETE. Første UA-4-slice etter eksplisitt masterplan-lesing (INGEN UA-4-detalj fantes i CANONICAL_SPEC/ARCHITECTURE/IMPLEMENTATION_PLAN fra før). D-64-gate kjørt FØRST: `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY` (attribusjon/kampanjesporing/eksperimentregister/avviksdeteksjon = `JARVIS_CANONICAL`; RÅ spend-/klikk-/visningstall fra en fremtidig plattform = `EXTERNAL_CANONICAL`), `CAN_RUN_WITHOUT_PROVIDER=true`. Ny pakke `@jarvis/growth`, migrasjon `027_growth.sql` (`marketing_campaigns`/`marketing_spend_events`/`marketing_attributions`/`marketing_experiments`/`marketing_campaign_events`). ZERO annonseplattform-leverandør-avhengighet (bevist mekanisk, `ua4_growth_no_ad_platform_dependency` strukturelt bevist i transport-wiring-tester). Deterministisk kampanje-lifecycle (`draft→active→paused→ended`, korreksjon kun `ended→draft`) og eksperiment-lifecycle (`draft→running→concluded/abandoned`, korreksjon kun tilbake til `draft`). Idempotent utgifts-ingestion (`UNIQUE(tenant_id, campaign_id, event_date, source_type)`, `ON CONFLICT DO UPDATE`, before/after logget på `spend_recorded`-event). Attribusjon EKSPLISITT/deterministisk (polymorft `entity_type`/`entity_id` mot `business_leads`/`business_opportunities`, samme mønster som `business_scores`) - ALDRI AI-gjettet. CAC/ROAS ren deterministisk SQL-aggregering mot ekte `business_opportunities.value_ore`/`stage='won'`, `null` (ikke `0`) når nevneren er `0`. Kampanjer er BEVISST IKKE knyttet til ett selskap - "Hva skjer med kunde X?" dekkes via `growth.list_by_company()` GJENNOM en attribuert lead/opportunity. Open-loop-integrasjon utvider `OpenLoopService.runSweep()` UENDRET (én ny regel: `marketing_spend_anomaly`, glidende 7-dagers-snitt, terskel ×1.5, beløps-gulv 100 øre), tenant-katalog gjenbruker Q-27 sin `listBusinessTenantIds()`. `growth.*`-ToolGateway-namespace (16 handlinger): klasse A lesing, klasse B interne skrivinger, klasse C for lifecycle-overganger (ingen klasse D i denne sliceen - ingen nøstet ekstern annonseplattform-handling ennå). Q-20: alle fem tabeller + kampanje-tilknyttede `business_open_loops`-rader registrert i `plan.ts` FØR noen host-runde (samme FK-lærdom som D-67/D-72, anvendt proaktivt). 66 nye tester (typecheck 17/17 rent, lint rent, full suite grønn). **INGEN ekte host-kjøring i denne økten** (Docker/Windows-host ikke tilgjengelig her) - `ua4-growth-core-host-run.ts`/`-live.ts` skrevet og klar, status ærlig FIXED_SUITE til Tobias faktisk kjører den. Draft-PR klar - **MERGES IKKE uten Tobias sin eksplisitte godkjenning**. UA-4 SOM HELHET forblir IKKE komplett (kun første av flere planlagte slices - se Q-29) |
| UA-4 D-85 t.o.m. D-92 (Slice 4-7 + Consent Governance/Enforcement) — hygiene-rad lagt til ved D-93-fase-lukking | **FIXED_SUITE_COMPLETE for hver enkelt slice (se DECISIONS_AND_ASSUMPTIONS.md for eksakte datoer/status per D-nummer) - INGEN egen rad var skrevet her FØR D-93, kun oppdaget som gap under fase-lukkings-verifiseringen** | D-85 (avviksdeteksjon→anbefaling), D-86 (Google Ads LIVE-verifisering DEFERRED_TO_FINAL_INTEGRATION_PHASE, sekvensering IKKE kansellering), D-87 (utførelses-kommando-REPRESENTASJON, INGEN `'executed'`-status i CHECK-constraint), D-88 (kontakt→møte-funnel-synlighet), D-89 (Marketing Memory v1), D-90 (Business OS daglig markedsførings-synlighet), D-91 (Consent Governance Core - motor, IKKE koblet inn), D-92 (Consent Enforcement Activation/Rollout v1 - motoren koblet inn for `attribution`-formålet, standard `disabled`). Ingen av disse markerte HELE UA-4 som komplett individuelt - se D-93 for den samlede fase-lukkingen. |
| UA-4 «Growth & Marketing Control Plane» — HELE FASEN VERIFIED/COMPLETE (2026-08-20, D-93) | **CANONICAL/VERIFIED/COMPLETE** - overordnet lukkings-beslutning mot masterplanens fire ordrette akseptansekriterier (`docs/input/02_...v4.0.md` linje 482-486), SAMME metodikk som D-48 (UA-2) | ALLE FIRE akseptansekriterier PASS: CAC/ROAS↔ekte CRM/revenue; tracking-/kampanje-avvik detektert+handlingsbart; skrivehandlinger idempotente/auditerbare/før-etter-tilstand; samtykke/cookie/databehandlingskrav dokumentert (OVERGÅTT med faktisk håndhevingsmotor D-91/D-92). `UA4_REQUIRES_UA6_COMPLETION=false`, `D86_BLOCKS_UA4_CLOSURE=false` (begge eksplisitt vurdert mot masterplanens fasesekvensdiagram `UA-4/5 → UA-6`). GA4/Meta Ads/øvrige providere, Creative/Experiment Intelligence, tracking runtime-håndheving, cookie-banner, samtykke-provenance-taksonomi, Business OS ukentlig synlighet, ekte leverandør-mutasjon, Q-26 - alle eksplisitt klassifisert IKKE-blokkerende «Bygges»-listeambisjoner, INGEN av dem et akseptansekriterium. Ingen kodeendring - kun verifikasjon + dokumentasjonslukking (to uavhengige research-agenter FØR beslutningen). Full `pnpm -w test` re-kjørt: 1708/1708 tester, 115/115 filer, exit 0. `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. Sovereign Autonomy v4.0-masterplanen SOM HELHET forblir IKKE komplett - UA-5/UA-6/UA-7/... gjenstår. Draft-PR, IKKE merget. Full detalj: D-93 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-5 «Developer & Cloud Control Plane» — GitHub Developer Control Plane v1 (2026-08-20, D-94) | **FIXED_SUITE_COMPLETE / LIVE_RUNNER_READY=true / IKKE LIVE_PROVIDER_VERIFIED** | FØRSTE UA-5-provider-slice (ikke fasen som helhet) - forrige rekonstruksjon konkluderte `PHASE_CLOSURE_DECISION=C` (blokkert uten levende leverandørtilkobling), denne ordren instruerte GitHub som første provider eksplisitt. D-64: GitHub = `EXTERNAL_CANONICAL` for repo/PR/workflow-tilstand, `CORE_DEPENDENCY_DECISION_REQUIRED=false`. D-41: 23-handlings-matrise (10×A/9×B/2×C/2×D) i `GithubTransport`/`firstWaveTools()` - erstatter forrige utilsiktede "read_issues/read_repo_meta/create_pr (aldri merge)"-begrensning; `merge_pr`(D, sovereign autonomt, preflight `get_pull_request`, valgfri `expected_head_sha`-precondition) og `delete_branch`(D, strukturelt vernet mot main/master/production) nye. Eksisterende kodejobb-worker (`modules/tasks/src/coding.ts`) bekreftet fortsatt eier kilde-endringen - denne sliceen bygger KUN GitHub-siden (PR/Actions/merge). INGEN ny Jarvis-DB-tabell. 100 nye tester, full suite 1808/1808 (117 filer), `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. `GITHUB_CREDENTIAL_CONFIGURED=false` i dette miljøet - `ua5-github-live.ts` skrevet og klar, IKKE kjørt. UA-5 kriterium 1-4 alle PARTIAL/NOT_STARTED etter denne sliceen (ingen av de fire fullt oppfylt). `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-94 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-5 «Developer & Cloud Control Plane» — Tested Fix Orchestrator v1 (2026-08-20, D-95) | **FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED** | D-94 nå merget til main. Koblet den eksisterende, ekte/testede kodejobb-workeren (`modules/tasks/src/coding.ts`) sammen med D-94s GitHub-transport - en vellykket kodejobb (test-gate bestått, pusher til jobb-branch) åpner nå en EKTE GitHub-PR via `github.create_pr` (klasse C, uendret), KUN når jobbkontrakten selv lister `"github"` i `allowed_tools` (ingen ny blanket-godkjenningssperre). Nytt `modules/tasks/src/pr-publisher.ts` (`parseGithubRepoSlug`/`publishPullRequestForCodingJob`) - strukturelt duck-typed mot `ToolGateway.execute()` for å unngå en sirkulær workspace-graf (`@jarvis/memory` har `@jarvis/tasks` som devDependency; `@jarvis/tool-gateway` avhenger av `@jarvis/memory`). Commit-sha fanges nå alltid i jobbresultatet (reell mangel FØR denne sliceen). GitHub-side-feil gjør ALDRI en vellykket test+push-jobb til "failed" - synlig i `pr.status`/`pr-result`-artefakt, aldri skjult. ALDRI merge herfra - `merge_pr` (klasse D, D-94, uendret) forblir en separat eier-handling. Diagnose-laget UENDRET ikke ekte (`ScriptedCodingAgent`=placeholder, `ClaudeCodeAgent`=stub). 16 nye tester (`pr-publisher.test.ts`, inkl. `RepoUrlRedirectingSandboxRunner` for ende-til-ende PR-opprettelse uten å røre virkelig github.com); alle 15 eksisterende `fase6-worker.test.ts`-tester består urørt. `pnpm -w typecheck`/`lint` rent. UA-5 kriterium 2 forblir PARTIAL (GitHub-siden nå sammenkoblet, diagnose fortsatt ikke bygget); kriterium 1/3/4 uendret. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-95 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-5 «Developer & Cloud Control Plane» — Real Coding Agent v1 (2026-08-20, D-96) | **FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED** | D-95 nå merget til main. `createCodingHandler` har INGEN produksjons-callere (verken `apps/api/src/main.ts` eller `worker-main.ts` registrerer `agent_profile="coding"`) - bevisst utsettelse, ikke et hull (en placeholder-agent i produksjon ville fylt ekte GitHub-PR-er med fabrikkert innhold). `CANONICAL_SPEC.md`/`ARCHITECTURE.md`/`INTEGRATIONS.md`/kildemasterplanene spesifiserer eksplisitt "Claude Code / Codex (headless)" som kodejobb-agentprofilen - `ClaudeCodeAgent` (CLI/prosess-adapter) var derfor allerede kanonisk arkitektur. CLI-flaggsettet verifisert MOT fersk offisiell dokumentasjon (`code.claude.com/docs/en/headless`) FØR kode ble skrevet - ingen gjettet syntaks. `ClaudeCodeAgent.modify()` kjører nå ekte `claude -p "<mål>" --bare --output-format json --permission-mode acceptEdits --allowedTools Read,Edit` via den eksisterende sandbox-`exec`-en (ingen ny sandbox), autentisert via `ANTHROPIC_API_KEY` injisert i sandboxens rene prosess-env (`claudeCodeCredential`, duck-typed `SecretProvider`, samme mønster som D-95s `PrPublishingGateway`). `--allowedTools "Read,Edit"` er bevisst IKKE "Bash" - agenten foreslår kun en diff, den eksisterende test-porten kjører den ekte testkommandoen på nytt uendret. Uten `claudeCodeCredential` er oppførselen 100% uendret (alle 15+16 eksisterende tester består urørt). Kjent, notert (ikke fikset) begrensning: `DockerSandboxRunner.create()` ignorerer i dag `jobEnv` - credential-injeksjon fungerer kun med `ProcessSandboxRunner`. 15 nye tester (`claude-code-agent.test.ts`, inkl. en ekte kjørt fake-`claude`-binær for wiring-bevis). `pnpm -w typecheck`/`lint` rent. UA-5 kriterium 2 forblir PARTIAL - agent-invokeringen er nå ekte og testet, men modellkvalitet er strukturelt uverifiserbar uten en ekte, konfigurert binær (`JARVIS_CLAUDE_BIN`/`ANTHROPIC_API_KEY` ikke satt i dette miljøet, `HOST_ACTION_REQUIRED_FOR_LIVE_VERIFICATION=true`); kriterium 1/3/4 uendret. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-96 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-5 «Developer & Cloud Control Plane» — GitHub Rate-Limit Controller v1 (2026-08-20, D-97) | **FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED** | D-96 nå merget til main. Skrevet i respons på en ekte hendelse denne økten (`update_pull_request` secondary-rate-limited ~9x/30+min mens PR #37 ble merget, lesekall upåvirket). Fersk rekonstruksjon fant `githubFetch()` (D-94) leste ALDRI `x-ratelimit-*`, hadde intet sekundær-rate-limit-begrep (ALLE 403 ikke-retrybare - umulig å skille throttle fra tilgangsfeil), og sov INLINE ved 429 (ville blokkert kallende tråd i timevis). Offisiell GitHub-kontrakt verifisert FØR kode. Bygget `GithubRateLimitController` - EN beslutningsplass alle 23 `github.*`-handlinger allerede funnel gjennom. `classifyGithubResponse()` skiller PRIMARY/SECONDARY_RATE_LIMIT/PERMISSION_403 UTELUKKENDE på dokumenterte signaler. `checkEligible()` er synkron DB-lesning + umiddelbar avvisning FØR nettverkskallet - ALDRI sleep/busy-wait. Fallback-cooldown: base 60s, doblet per brudd, tak 60 min, bundet jitter. `RATE_LIMIT_STATE_SCOPE=SHARED_RUNTIME` (ny tabell `github_rate_limit_state`, migrasjon 034, keyet på `credential_ref`, BEVISST ingen `tenant_id`/RLS - global credential, speiler `scheduler_state`-presedensen). `GithubTransport`s nye `rateLimitController`-argument er valgfritt - alle ~50 eksisterende kallesteder uendret; wired KUN i produksjon (`main.ts`+`worker-main.ts`). Eierkontroller (freeze/kill-switch) uendret håndhevet FORAN transporten (bevist mot ekte embedded-Postgres). Prosess-lokal mutasjons-serialisering (min. 1s avstand); ærlig IKKE tverr-prosess-konkurransebegrensning. 33 nye tester (`github-rate-limit-controller.test.ts`, alle 25 punkter i byggeordrens matrise inkl. PR37-klasse-regresjon); alle 43+13 eksisterende GitHub-relaterte tester består uendret. Full suite 1878/1878, `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. UA-5 kriterium 2/3/4 HERDET, ingen heves til COMPLETE (infrastruktur-herding, ikke ny kapabilitet). `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-97 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-5 «Developer & Cloud Control Plane» — Real Coding Agent Live Quality Evaluation Harness v1 (2026-08-21, D-98) | **FIXED_SUITE_COMPLETE / IKKE LIVE_QUALITY_VERIFIED** | D-97 nå merget til main (`d5ebc40c05d68cf1b11ac078eb85c580f0042fb5`), post-D97 CI grønt. Fersk rekonstruksjon av de 4 literale UA-5-kriteriene (dispatchet som egen research-subagent, ikke gjenbrukt forrige rapport) fant kriterium 1/3/4 strukturelt krever en ny infrastruktur-leverandør (Vercel/GCP/Cloudflare) ordren eksplisitt forbød å røre - kriterium 2s live-kvalitets-undergap (agent-invokering ekte/testet siden D-96/D-97, MEN modellkvalitet fortsatt uverifisert) var derfor den eneste gyldige neste sliceen. CLI-kontrakt re-verifisert mot fersk offisiell dokumentasjon - ingen kodekorreksjon; D-96s `--allowedTools "Read,Edit"`-sikkerhetsgrense bekreftet intakt. Bygget ren `coding-agent-eval.ts` (INGEN prosess-/nettverks-/DB-kall) - 3 deterministiske fixtures (lokal av-med-en-feil, kryssfil-kontraktsfeil, bevisst uløselig "ærlig feiling"-case) med orakel-/testfiler bevisst ekskludert fra tillatte skrivbare stier. `QUALITY_THRESHOLD` definert FØR kjøring, aldri flyttet etterpå. `classifyChangedFiles()` gjør uavhengig etterkontroll (aldri stol på jobbens egen "completed"-status). `computeVerifiedFix()` beviser eksplisitt `AGENT_RETURNED_SUCCESS != TEST_GATE_PASSED`. `ua5-coding-agent-live-eval.ts` (aldri kjørt i CI) gjenbruker EKSAKT den ekte `createCodingHandler`/`ProcessSandboxRunner`/`ClaudeCodeAgent`-koblingen - ingen parallell arkitektur - men utelater bevisst `github`-feltet, strukturelt umulig å åpne en ekte PR selv under live-kjøring. 3 fixtures kjøres sekvensielt (`PROVIDER_CALLS_COUNT=3`, ingen retry-storm). Miljø-sjekk: `claude`-binæren finnes (`/opt/node22/bin/claude`), `ANTHROPIC_API_KEY` er IKKE satt - `ProcessSandboxRunner` arver aldri forelder-env, derfor ærlig konkludert at dette miljøet ikke kan live-verifisere modellkvalitet (`HOST_ACTION_REQUIRED=true`, eksakt host-kommando dokumentert, ingen hemmelighet ekko'et, kan verken pushe eller opprette ekte PR). Timeout-banen bevist DETERMINISTISK uten et ekte provider-kall (fake-binær som aldri avslutter + kort timeout) - `spawnSync({timeout})` dreper prosessen trygt, jobben aldri markeres bestått, ingen branch pushes; ærlig notert at `ClaudeCodeAgent` mangler en egen timeout-feilklasse (best-effort heuristikk). 36 nye tester (`coding-agent-eval.test.ts` 35 + `coding-agent-eval-timeout.test.ts` 1). Full suite 122/122 filer, 1923/1923 tester grønt (opp fra 120/1887), `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. `PRODUCTION_CODING_HANDLER_WIRED=false`, `PRODUCTION_CODING_AGENT_WIRED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` uendret. UA-5 kriterium 2 forblir PARTIAL (harness ekte/klart, modellkvalitet fortsatt uverifisert i dette miljøet); kriterium 1/3/4 uendret fra D-97. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-98 i DECISIONS_AND_ASSUMPTIONS.md. |
| D-98 live-evaluation harness portability repair (2026-08-21, D-99) | **FIXED_SUITE_COMPLETE / IKKE LIVE_QUALITY_VERIFIED (NARROW REPARASJON, ikke ny kapabilitet)** | Ekte Windows-vertskjøring av D-98s live-evaluator feilet FØR noe Claude-kall med `git commit -m seed feilet: ` (tom stderr). Rotårsak (kodeinspeksjon, ikke gjettet): `seedFixtureRepo()` spawnet det POSIX-eksterne `mkdir -p` for å lage `src/`-undermappen alle 3 fixtures bruker - `mkdir` finnes IKKE som frittstående kjørbar fil på Windows, feilet ukontrollert ENOENT, den påfølgende filskrivingen feilet derfor også, seed-arbeidstreet endte HELT tomt, `git commit` feilet med "nothing to commit" (skrives til STDOUT, ikke stderr - derfor den tomme feilmeldingen). `PROVIDER_CALL_OCCURRED_BEFORE_FAILURE=false`. Fikset i nytt `modules/tasks/src/eval-fixture-repo.ts` (typechecket, i `src/`): bruker UTELUKKENDE `node:fs`s `mkdirSync`/`writeFileSync`, ALDRI en spawnet ekstern prosess. Hvert disponibelt repo får LOKAL (ALDRI `--global`) `commit.gpgsign=false`/`tag.gpgSign=false`+tomt `core.hooksPath` - deterministisk uansett vertens globale signerings-/hook-konfigurasjon, Tobias sin globale git-config aldri rørt. Ny `describeGitFailure()` inkluderer `exit_code`+sanert `stderr` OG `stdout` (kritisk - "nothing to commit" er kun et stdout-signal); `redactSecrets()` nå også på scriptets topp-nivå `fatal_error`-felt (uendret sanert før). 8 nye tester (`eval-fixture-repo.test.ts`, INGEN ekte Claude-/Postgres-/nettverkskall) A-G + Windows-regresjonsklasse-test. Alle 36 eksisterende D-98-tester består uendret. Full suite 123/123 filer, 1931/1931 tester grønt (opp fra 122/1923), typecheck/lint/gitleaks rent. `LIVE_AGENT_INVOCATION_VERIFIED/LIVE_DIAGNOSTIC_QUALITY_VERIFIED/LIVE_FIX_QUALITY_VERIFIED` uendret `false` (ingen live-kjøring i denne runden). UA-5 kriterium 1-4 UENDRET fra D-98. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-99 i DECISIONS_AND_ASSUMPTIONS.md. |
| D-98 Live Evaluation Harness Evidence Repair v2 (2026-08-21, D-100) | **FIXED_SUITE_COMPLETE / IKKE LIVE_QUALITY_VERIFIED (EVIDENCE-DRIVEN REPARASJON, ikke ny kapabilitet)** | En ANDRE ekte Windows-vertskjøring (D-99s reparerte harness) produserte konkret bevis på ekte agent-invokering (`PROVIDER_CALLS_COUNT=3`, `LIVE_AGENT_INVOCATION_VERIFIED=true`), men `LIVE_DIAGNOSTIC_QUALITY_VERIFIED=false`/`LIVE_FIX_QUALITY_VERIFIED=false` forble uavklart pga. TO harness-defekter, ALDRI modellkvalitetsbevis: (1) Task A/B fikk `patch_created=true` men en strukturell Postgres-encoding-feil (embedded Postgres initialiserte `WIN1252` i stedet for `UTF8` på denne Windows-verten, funnet ved å lese `embedded-postgres`-pakkens egen `dist/types.d.ts`) avviste `≥`/`✓` fra agentens PR-forslag-beskrivelse - fikset med ny `LIVE_EVAL_INITDB_FLAGS=["--encoding=UTF8","--locale=C"]` + 6 nye `live-eval-utf8-persistence.test.ts`-tester (EKTE embedded-Postgres, beviser `≥`/`✓`/`æøå`/generell Unicode overlever en ekte `ArtifactStore`-INSERT/SELECT-runde + `SHOW server_encoding`='UTF8'); (2) Task C rapporterte `verified_fix=true` men den forventede orakel-verdien (`5000`) var lekket i agent-synlig testfilinnhold - `TASK_C_V1_INVALID_FOR_QUALITY_PROMOTION=true` (ikke retroaktivt omklassifisert som modellfeil). Task C v2 redesignet med `EvalFixture.hiddenOracle` - svaret lever UTELUKKENDE i harnessets kildekode, ALDRI serialisert til agent-synlig fixture-data (6 "aldri lekket"-tester), sjekket HELT UTENFOR sandboxen av selve live-eval-scriptet via `git show` på det pushede branch-innholdet, KUN til diagnostikk - ny `computeIndependentTestsPassed()` returnerer STRUKTURELT `false` for enhver `hiddenOracle`-fixture, garanterer `verified_fix` aldri fabrikkeres sann. Ny typet `FailureCategory`-klassifisering (`classifyFailureCategory()`) og presis `provider_invocation_success` (`computeProviderInvocationSuccess()`) atskiller nå "lyktes det ekte Claude-kallet" fra "fullførte hele jobb-pipelinen" - forklarer Task A/B sin ekte hendelse (en sen `pr-proposal`-artefakt-lagring feilet ETTER en allerede vellykket push) som `HARNESS_PERSISTENCE_FAILURE`, aldri en modellfeil; Task A/B MÅ kjøres på nytt fra FERSKE fixtures. `pg_pool_idle_client_error`-teardown-støy fikset (appPool lukkes nå FØR adminPool/epg.stop()). `coding-agent-eval.test.ts` utvidet fra 35 til 68 tester. Full suite 124/124 filer, 1970/1970 tester grønt (opp fra 123/1931), `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent. Én isolert `q18-read-dedupe.test.ts`-hook-timeout under full parallell suite bevist urelatert (embedded-Postgres ressurskonkurranse, 2/2 grønt kjørt alene). `TOTAL_REAL_PROVIDER_CALLS_FROM_FIRST_RUN=3` BEVART - ingen nytt ekte provider-kall. `LIVE_AGENT_INVOCATION_VERIFIED=true` BEVART (aldri nedgradert); `LIVE_DIAGNOSTIC_QUALITY_VERIFIED/LIVE_FIX_QUALITY_VERIFIED` uendret `false`. UA-5 kriterium 2 uendret PARTIAL. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-100 i DECISIONS_AND_ASSUMPTIONS.md. |
| Real Coding Agent Live Quality Verification + Honest-Noop Eval Repair (2026-08-21, D-101) | **FIXED_SUITE_COMPLETE / LIVE_QUALITY_VERIFIED=true (EVIDENSKANONISERING + SMAL harness-korrekthetsreparasjon, ikke ny kapabilitet, ikke produksjonskobling)** | En ANDRE, KORRIGERT ekte Windows-live-kjøring (D-100s reparerte harness) fullførte VELLYKKET: `PROVIDER_CALLS_COUNT=3`, `LIVE_AGENT_INVOCATION_VERIFIED=true`, `LIVE_DIAGNOSTIC_QUALITY_VERIFIED=true`, `LIVE_FIX_QUALITY_VERIFIED=true`. Task A/B nådde `verified_fix=true`; Task C nådde `verified_fix=false` med `oracle_tampering=false`/`unauthorized_changes=false` - PASS mot den FROSNE D-98/D-100-terskelen (`QUALITY_THRESHOLD_MET=true` for alle 3). Task C sitt resultat inneholdt likevel `harness_persistence_success=false`/`failure_category=HARNESS_PERSISTENCE_FAILURE`/`error_class=commit_failed` - et EKTE harness-semantikk-funn (ALDRI et modellkvalitetsfunn) som ikke fikk nedgradere noen `LIVE_*_VERIFIED`-flagg. Rotårsak sporet i `coding.ts` (produksjonskode): `createCodingHandler` kjørte FØR denne reparasjonen UBETINGET `git add -A`+`git commit` selv naar agenten (korrekt og ærlig, Task C sin `honest_failure`-fixture) ikke gjorde noen endring - `git commit` feiler da strukturelt ("nothing to commit", STDOUT ikke stderr), fanget av `must("commit",...)` som en tom `commit_failed:`-feil. Sekundær, tidligere ufunnet klassifiseringsbug oppdaget samtidig: `must()` kaster ALLTID `"<label>_failed:..."`, men `KNOWN_ERROR_CLASSES`/`PRE_AGENT_SUCCESS_LABELS` i `coding-agent-eval.ts` hadde kun de usuffikserte etikettene - matchet derfor ALDRI en ekte kjøretids-`error_class`, alle seks `must()`-baserte feilklasser ble feilaktig `HARNESS_PERSISTENCE_FAILURE` ved eliminasjon. Fikset: ny `coding.ts`-eksportert `NO_CHANGES_TO_COMMIT_LABEL` kastes nå (via `git status --porcelain` sjekket FØR add/commit) i stedet for en tvunget tom commit - ingen empty commit, ingen meningsløs branch-push, ingen fabrikkert patch; `classifyFailureCategory` behandler etiketten eksplisitt som `null`; begge klassifiseringstabellene rettet til de faktiske suffikserte strengene. §9-invariant bevart: jobben forblir FORTSATT "failed" (aldri "completed") naar agenten ikke gjør noen endring - kun HVILKEN feil som rapporteres endret, aldri om jobben lykkes (bevist av en dedikert regresjonstest: `ScriptedCodingAgent`-banen 100% uendret). Q-26: kvalitetspromoteringen gyldig fordi terskelen ble frosset FØR resultatet ble sett OG begge fixture-typer faktisk oppfylte den; `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` forblir globalt uendret. UA-5 kriterium 2 vurdert på nytt (IKKE automatisk hevet): `PRODUCTION_CODING_HANDLER_WIRED=false`/`PRODUCTION_CODING_AGENT_WIRED=false`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` UENDRET - kriterium 2 forblir PARTIAL, gap nå presist avgrenset til produksjons-tilkobling, aldri lenger modellkvalitet. Kriterium 1/3/4 uendret fra D-100. `coding-agent-eval.test.ts` 68→74 tester, `fase6-worker.test.ts` +2 tester (ekte embedded-Postgres+git). Full suite 124/124 filer, 1978/1978 tester grønt (opp fra 124/1970), `pnpm -w typecheck`/`lint` rent. Alle D-96/D-97/D-98/D-99/D-100-relaterte suiter re-kjørt grønt uendret. `TOTAL_REAL_PROVIDER_CALLS_FROM_FIRST_RUN=3` bevart - ingen nytt ekte provider-kall i selve reparasjonen. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Neste faktiske UA-5-gap (produksjons-tilkobling) identifisert, IKKE startet. Full detalj: D-101 i DECISIONS_AND_ASSUMPTIONS.md. |
| Production Real Coding Agent / Tested-Fix Pipeline Wiring v1 (2026-08-21, D-102) | **STRUCTURAL_WIRING_VERIFIED / IKKE LIVE ENDE-TIL-ENDE-VERIFISERT (produksjons-wiring, ikke ny kapabilitet)** | FØR denne sliceen (D-101): `PRODUCTION_CODING_HANDLER_WIRED=false`/`PRODUCTION_CODING_AGENT_WIRED=false`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` - `createCodingHandler` hadde INGEN produksjons-callere. Wiret nå inn i `apps/api/src/worker-main.ts`: `worker.register("coding", withSecretRedaction(createCodingHandler({...}), [secrets]))` på samme `InProcessWorker` som `"executive"`/`"knowledge-ingest-email"`, gjenbruker samme sandbox (`ProcessSandboxRunner`, produksjonsdefault), samme `ArtifactStore(pool)`, samme `toolGateway` (arver D-97). ABSOLUTT SIKKERHETSREGEL bevart: `ScriptedCodingAgent` verken importert eller instansiert - EKTE `ClaudeCodeAgent` (D-96/D-100/D-101) brukt; mangler credential feiler strukturelt lukket (`claude_code_not_configured`), ALDRI stille fall til Scripted, ALDRI fabrikkert kode/PR. `EnvSecretProvider` gjenbrukt uendret for `ANTHROPIC_API_KEY` - INGEN nytt credential-lager. `identityFor` bruker jobbens EGEN `owner_person_id`/`tenant_id` (kodelest nødvendig: produksjonens `PolicyGateway` har INGEN `mandates`, klasse C auto-ALLOW skjer KUN via SOVEREIGN-identitetsmatch). D-94-klasser bekreftet uendret (`create_pr`=C, `merge_pr`=D) - INGEN auto-merge denne sliceen. Minimal ny inngang: eksisterende `TaskService.submit()` (null produksjons-callere før) eksponert som `POST /tasks/submit`, gjenbruker SAMME `TaskService`-instans som `ConversationEngine`. Nytt forsvar-i-dybden: `withSecretRedaction()` redigerer kjente hemmeligheter fra thrown-feil FØR `tasks.last_error`. Genuint pre-eksisterende hull lukket: `modules/tasks/src/index.ts` manglet `pr-publisher.ts`-re-eksport siden D-95 (fikset additivt). 22 nye tester i 3 nye filer, inkl. `coding-production-wiring.test.ts` (5, EKTE embedded-Postgres + EKTE HTTP-server + EKTE git-bare-repo - Test A beviser `/tasks/submit`→queue→worker→`createCodingHandler`→EKTE `ClaudeCodeAgent` nåbar og feiler korrekt lukket uten credential; Test D beviser hele suksessveien via DEN SAMME produksjonsfunksjonen). Full suite 127/127 filer, 2000/2000 tester grønt (opp fra 124/1978), `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent, ingen regresjon. ÆRLIG: dette kjøremiljøet har INGEN `ANTHROPIC_API_KEY`/`JARVIS_GITHUB_TOKEN` konfigurert - ekte live ende-til-ende-kjøring IKKE mulig her, `HOST_ACTION_REQUIRED=true` rapportert i stedet for fabrikkert bevis. `PRODUCTION_CODING_HANDLER_WIRED=true`/`PRODUCTION_CODING_AGENT_WIRED=true` (strukturelt OG kjøretids-bevist), men `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE` forblir IKKE live-verifisert. UA-5 kriterium 2 forblir PARTIAL - gap presist avgrenset til ekte credential + én eierautorisert live-kjøring. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-102 i DECISIONS_AND_ASSUMPTIONS.md. |
| Production Coding Reachability Repair v1 (2026-08-21, D-103) | **TWO_PRODUCTION_BLOCKERS_REPAIRED / IKKE LIVE ENDE-TIL-ENDE-VERIFISERT (reachability-reparasjon, ikke ny kapabilitet)** | Oppdaget under D-102s host-akseptanse-forberedelse: to reelle produksjons-nåbarhetsblokkere. Blokker A: `main.ts` sin egen `InProcessWorker` (kun "executive") og `worker-main.ts` sin (har "coding") polte SAMME kø samtidig - agent-profil-blind `claim_next_task()` lot `main.ts` claime og terminalt feile en coding-jobb. Fikset: ny migrasjon `035_worker_claim_profile_filter.sql` filtrerer claimet ATOMISK på et nytt `p_agent_profiles text[]`-argument i SAMME `FOR UPDATE SKIP LOCKED`-transaksjon - en ustøttet jobb forblir `'created'` (aldri feilet), ingen starvation, lease/reclaim/retry/RLS uendret. Blokker B: `ProcessSandboxRunner` ga `git clone`/`git push` en ren env uten HOME/SSH_AUTH_SOCK - push mot en ekte GitHub-remote hadde ingen eksplisitt credential-kanal, ville avhengt av ambient vertstilstand. Fikset: ny `git-auth.ts` - et ephemert `GIT_ASKPASS`-skript per jobb (filen inneholder aldri tokenet), `Sandbox.exec()` fikk en valgfri `extraEnv`-parameter gitt KUN til de to faktiske clone/push-kallene (aldri til `run`, som agent.modify() OG alle lokale git-operasjoner bruker - `ClaudeCodeAgent` ser derfor strukturelt aldri GitHub-tokenet). `createCodingHandler` fikk et nytt valgfritt `gitAuth`-felt (default `JARVIS_GITHUB_TOKEN`, samme `EnvSecretProvider`-arkitektur som `claudeCodeCredential`, helt atskilt referanse) - mangler secreten: `git_auth_unavailable` FØR clone forsøkes, aldri et stille fall til uautentisert git; uten `gitAuth` i det hele tatt er sandbox-oppførselen 100% uendret. Cancellation lagt til FØR push og FØR PR-publisering (nye, produksjons-nåbare grenser). 34 nye tester i 3 nye filer (`worker-claim-routing.test.ts` 12 ekte embedded-Postgres inkl. et D-92-klasse RLS-fallgruve-funn, `git-auth.test.ts` 10 ren logikk, `coding-git-auth-wiring.test.ts` 10 ekte embedded-Postgres + ekte lokalt git-bare-repo som beviser extraEnv-isolasjon/ingen token i argv-config-feilmeldinger/fail-closed/ephemer opprydding/D-95 PR-flyt upåvirket) + 2 i `worker-coding-wiring.test.ts`. Full suite 130/130 filer, 2034/2034 tester grønt (opp fra 127/2000), `pnpm -w typecheck`/`lint` rent, ingen regresjon i D-95/D-96/D-97/D-100/D-101/D-102-suiter. Ærlig: ingen ekte Anthropic/GitHub-credential i dette miljøet - `LIVE_E2E_VERIFIED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`, `HOST_ACTION_REQUIRED=true` uendret; denne sliceen reparerer forutsetninger, hevder IKKE live-verifisering. UA-5 kriterium 2 forblir bevisst PARTIAL. `UA5_IMPLEMENTATION_COMPLETE=false`. Draft-PR, IKKE merget. Full detalj: D-103 i DECISIONS_AND_ASSUMPTIONS.md. |
| D-103 HOST-FIX: git credential.helper isolation (2026-08-21) | **AMBIENT_CREDENTIAL_HIJACK_FIXED / IKKE LIVE ENDE-TIL-ENDE-VERIFISERT (amendment til D-103, ikke ny D-nummer)** | Tobias sin FØRSTE ekte Windows host-akseptanse: Blokker A-fiksen fungerte live (riktig worker claimet jobben), den ekte kodeagenten nådde `git push` - men autentiserte som ambient `post-ops` i stedet for `JARVIS_GITHUB_TOKEN`. Root cause: git spør ALLTID `credential.helper`-kjeder FØR `GIT_ASKPASS` (som er en ren prompt-fallback, ikke en prioritert kilde) - Windows Git for Windows registrerer ofte Git Credential Manager system-nivå, uavhengig av HOME. To fiks: (1) `-c credential.helper=` (`GIT_CREDENTIAL_ISOLATION_ARGS`, git sin egen nullstill-kjeden-mekanisme, ingen filmutasjon, ingen hemmelighet) prependet KUN til clone/push-argv. (2) en LATENT bug i D-103s opprinnelige `GIT_ASKPASS`-format (anførselstegnet `"<node>" "<skript>"`) - empirisk bevist å IKKE bli kommandolinje-parset av git på POSIX (aldri fanget FØR siden alle D-103-tester brukte lokale bare-repo-kloner uten credential-oppløsning) - fikset med plattform-betinget `buildAskpassEnvValue()` (bar sti POSIX, `.cmd`-wrapper Windows). 20 nye tester (1 ny fil `git-credential-isolation.test.ts` med 5 tester mot en EKTE selvhostet git smart-HTTP-server i egen barneprosess, som beviser ambient-helper-hijack UTEN fiksen og korrekt Jarvis-identitet MED; `git-auth.test.ts` +6, `coding-git-auth-wiring.test.ts` +3 inkl. cleanup-på-fortvunget-feil). Full suite 131/131 filer, 2048/2048 tester grønt (opp fra 130/2034), typecheck/lint rent. INGEN system/global git-config mutert, INGEN credential-store rørt, Tobias sin `post-ops`-konto uendret. `WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true`/`REAL_CODING_JOB_REACHED_GIT_PUSH=true` (ekte). `LIVE_E2E_VERIFIED=false`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`/`HOST_ACTION_REQUIRED=true`/`UA5_CRITERION_2=PARTIAL` uendret inntil Tobias' neste host-kjøring. Ny draft-PR, IKKE merget. |
| D-103 HOST-FIX v2: git credential.helper erstatter GIT_ASKPASS (2026-08-21) | **STRUCTURAL_AUTH_ISOLATION_VERIFIED / WINDOWS_LIVE_AUTH_ISOLATION_VERIFIED=false (amendment til D-103, ikke ny D-nummer)** | En ANNEN ekte Windows-kjøring, ETTER v1 var merget: v1s ambient-helper-isolasjon fungerte LIVE (ingen `post-ops` lenger), men v1s `GIT_ASKPASS`-mekanisme feilet på et NYTT sted - `cannot spawn "...\jarvis-git-askpass-<x>\askpass.cmd": Permission denied`. Root cause (utledet, ikke live-bevist av Claude Code): git kaller `GIT_ASKPASS` med `use_shell=1`, men hopper over shell-innpakning for en bar sti uten metategn - `CreateProcessW()` direkte på en `.cmd`-fil (ikke et gyldig PE-avbilde) feiler strukturelt. Fiks: GIT_ASKPASS erstattet HELT med `credential.helper=!"<node>" "<skript>"` (etter uendret `GIT_CREDENTIAL_ISOLATION_ARGS`-reset) - `!`-prefikset tvinger git til shell-evaluering (`sh -c`, MSYS `sh.exe` på Windows), som launcher `node.exe` (ekte PE-binær) med skriptet som argument - ALDRI direkte `CreateProcess()` av vår fil. IDENTISK form på begge plattformer, ingen plattform-gren lenger. `DockerSandboxRunner.exec(extraEnv)`-gap (ikke koblet til `docker run`) reparert samtidig via bar `-e <NAVN>`-argv. 26 nye/omskrevne tester (`sandbox-docker-extra-env.test.ts` 5 ny; `git-auth.test.ts` 15 omskrevet; `git-credential-isolation.test.ts` 7 omskrevet - C/D beviser nå ekte git-invokering av mekanismen mot en ekte HTTP-credential-utfordring, nye F/G beviser fail-closed; `coding-git-auth-wiring.test.ts` 13 omskrevet argv-form). Full suite 132/132 filer, opprinnelig rapportert 2054/2054 tester grønt (opp fra 131/2048) på FØRSTE commit i denne sliceen; to påfølgende `windows-git-auth`-CI-fiks-commits (test-rigg-bugs, ikke produksjonskode) la til to flere tester - PR #46s faktiske merget HEAD (`ad96d33`) hadde `2056/2056`, se korrigert tall i raden under. typecheck/lint rent. Ny, fokusert `windows-git-auth`-CI-jobb (`windows-latest`, kun de to Postgres-frie testfilene) lagt til CI - direkte mot "korrekt på Linux, feiler på ekte Windows"-klassen. INGEN system/global git-config mutert, INGEN credential-store rørt. `WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true`/`REAL_CODING_JOB_REACHED_GIT_PUSH=true`/`AMBIENT_CREDENTIAL_HELPER_CAN_OVERRIDE_JARVIS_AUTH=false` (ekte). `WINDOWS_LIVE_AUTH_ISOLATION_VERIFIED=false`/`LIVE_E2E_VERIFIED=false`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`/`HOST_ACTION_REQUIRED=true`/`UA5_CRITERION_2=PARTIAL` uendret inntil Tobias' neste host-kjøring. Ny draft-PR, IKKE merget. |
| D-103 HOST-FIX v2: Windows live host-akseptanse LYKTES (run-3, 2026-08-21) | **WINDOWS_LIVE_AUTH_ISOLATION_VERIFIED=true / LIVE_E2E_VERIFIED=true / UA5_CRITERION_2=COMPLETE** | PR #46 merget til main (merge-commit `ad96d33466315a5687ec977ce33ff36aa5fda7c7`, CI grønn på merge-commiten: windows-git-auth/gitleaks/build-test alle SUCCESS, 132/132 filer, 2056/2056 tester bekreftet direkte). Tobias sin TREDJE ekte Windows host-akseptanse (task `d103-host-final-ea3e6b3f`, worker `worker-aa818fcf`) LYKTES: `status=completed`, `tests=passed`, `branch=jarvis/d103-host-final-ea3e6b3f`, `commit_sha=8a9fda6d172193e4abb002dad814411ffb629300`, ekte PR opprettet (`tsworkflow/jarvis-d103-acceptance#1`, IKKE merget - engangs disponibelt aksepttest-repo). System-nivå `credential.helper=manager` (`C:/Program Files/Git/etc/gitconfig`) forble BEVISST uendret gjennom hele kjøringen - `AMBIENT_HOST_CREDENTIAL_DID_NOT_OVERRIDE=true` bekreftet under en EKTE konkurrerende ambient helper, ikke bare et rent testmiljø. `EXPECTED_TOKEN_IDENTITY_MATCH` ble IKKE friskt re-bevist via en egen `/user`-kall-preflight i DENNE kjøringen (den mottok en GitHub 403 - ingen fabrikkert identitetsbekreftelse); den strukturelle proof-of-work er likevel den isolerte, autentiserte clone→endre→teste→commit→push→PR-kjeden som selv lyktes MENS ambient forble konfigurert (samme bevisklasse som run-2s isolasjonsbevis, nå fullført til faktisk push+PR). Agentens egen resultattekst inneholdt et stale utsagn ("ikke committet ennå") SAMTIDIG som den strukturerte pipeline-tilstanden bar en ekte `commit_sha` og en opprettet PR - kanonisk sannhet er den STRUKTURERTE tilstanden (`tasks.result`/`commit_sha`/PR-URL), ALDRI agentens frie tekst, jf. Q-26. `WINDOWS_CREDENTIAL_TRANSPORT_EXECUTED=true`/`CLONE_AUTH_VERIFIED=true`/`PUSH_AUTH_VERIFIED=true`/`PR_CREATED=true`/`TASK_COMPLETED=true`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=true`/`HOST_ACTION_REQUIRED=false`. **UA-5 kriterium 2 er nå `COMPLETE`** - dette er den FØRSTE UA-5-kriteriedelen som når full live-verifisering. Acceptance-PR-en (`tsworkflow/jarvis-d103-acceptance#1`) forblir bevisst UMERGET (engangs bevis, ikke et produksjonsartefakt). D-103 (inkl. v1/v2-amendments) er dermed `CANONICAL / FIXED_SUITE_VERIFIED / WINDOWS_CI_AUTH_TRANSPORT_VERIFIED / WINDOWS_LIVE_E2E_VERIFIED / COMPLETE`. |

| D-104: UA-5 Production Operations Control Plane v1 (2026-08-21) | **FIXED_SUITE_VERIFIED (kriterium 1/3 PARTIAL, kriterium 4 COMPLETE) - se D-104 i DECISIONS_AND_ASSUMPTIONS.md** | Ny `@jarvis/incidents`-pakke (hendelse/deploy/bevis-korrelasjon, gjenbruker D-102/D-103-testet-fiks-pipelinen uendret for reparasjonsjobber) + ny `InfraExecutionGate` (NORMAL/DEGRADED/PAUSED, `modules/policy`) koblet inn i `PolicyGateway.authorize()` i BEGGE produksjonsprosesser. 42 nye tester (5 filer) mot EKTE embedded-Postgres/EKTE lokalt git-bare-repo/EKTE `ToolGateway`. Kriterium 1 (deploy/log/db-korrelasjon) og 3 (before/after+recovery) forblir `PARTIAL` - INGEN ekte GitHub-webhook/provider-rollback utøvd, kun deterministisk fixture-/integrasjonsbevis. Kriterium 4 (pause/degradert modus) er `COMPLETE` - fullt koblet inn og test-bevist mot ekte `PolicyGateway`-runtime, ÉN dokumentert begrensning (prosess-lokal tilstand, samme klasse som eksisterende `KillSwitch`). INGEN ny ekstern leverandør (D-64-audit: GCP/Cloudflare/Sentry/Vercel-deploy eksisterer ikke i repoet, bevisst ikke bygget). |
| D-105: UA-5 Production Operations Control Plane v2 (2026-08-22) | **LIVE_VERIFIED - alle fire UA-5-kriterier COMPLETE (kriterium 1/3 live-bevist av Tobias 2026-08-22), `UA5_IMPLEMENTATION_COMPLETE=true` - se D-105 i DECISIONS_AND_ASSUMPTIONS.md** | Ny `docker`-transport (`modules/tool-gateway/src/docker-transport.ts`, D-64: `HYBRID_WITH_CLEAR_AUTHORITY`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`) - lese-handlinger virker mot ETHVERT containernavn, `redeploy_container` (klasse D) STRUKTURELT nektet mot alt utenfor `jarvis-sentinel-*`. Real log-innhenting (redigert to ganger, hard tail-grense) + ekte DB-tilstand-korrelasjon (`schema_migrations`, INGEN ny leverandør). Ny diagnose-modell (`incident_diagnoses`, ATSKILT fra evidens, revurdering=ny rad). Ny APPEND-ONLY `infra_executions`-journal (VED SIDEN AV uendret `tool_executions`) med deterministisk diff (`computeStateDiff()`) og firetilstands-utfall (SUCCESS/PARTIAL/FAILED/UNKNOWN). `docker:redeploy_container`-recovery REQUERIER tilstand for ekte verifisering (ikke bare "kallet returnerte ok"). `InfraExecutionGate.infraToolIds` utvidet til `{"github","docker"}` - samme gate, bevist for docker inkl. KillSwitch-supremati. 47 nye tester (6 filer) mot EKTE embedded-Postgres + EKTE subprosess-kall mot en fake `docker`-CLI (ALDRI en ekte daemon i CI - ingen daemon tilgjengelig i dette kjøremiljøet). `LIVE_VERIFIED=false` for alle nye flagg - host-runbook levert for Tobias. **HOST-FIX (2026-08-22, D-41-korreksjon):** `assertSentinelTarget()` FJERNET fra transporten (var en permanent produksjons-restriksjon, ikke akseptanse-scoping - i strid med D-41). Mål-autorisasjon nå i `docker-target-policy.ts`, håndhevet av `ToolGateway.execute()` selv (ny generisk `parameterAuthorizer`-hook). Nye `stop_container`/`start_container` (ren kjøretilstand) er PRODUKSJONS-autoriserte mot `JARVIS_DOCKER_MUTATION_TARGETS` (eksakt, eier-konfigurert); `redeploy_container` forblir DEFERRED for produksjon (sentinel-only) - nåværende implementasjon bevarer ikke mounts/env/nettverk/porter/restart-policy/healthcheck. Sentinel forblir ALLTID tillatt for akseptanse. Sovereign eier-autoritet uendret. **LIVE HOST-AKSEPTANSE §1/§2 (2026-08-22, Tobias sin egen kjøring):** `OBSERVABILITY_PROVIDER_LIVE=true`, `REAL_LOG_ACQUISITION=true`, `DB_STATE_CORRELATION_LIVE=true`, `UA5_CRITERION_3=COMPLETE` (full ekte redeploy/before-after/diff/recovery mot et disponibelt sentinel-mål, produksjon utouched). **HOST-FIX #2 (2026-08-22, GitHub deployment-ingestion, samme D-105, ingen ny D-ID):** ny `modules/incidents/src/deployment-ingestion.ts` (`ingestGithubDeployment()`) er DEN produksjons-callsiten `DeploymentService.recordDeployment()` manglet - henter én Actions-workflow-kjøring UTELUKKENDE via `ToolGateway.execute()` (`github.get_workflow_run`, ALDRI direkte HTTP), validerer providerresultatet strukturelt (`invalid_provider_response` for manglende/ugyldig `head_sha`/`status`/`created_at`), normaliserer deterministisk (konservativ status-mapping, `deployed_at` fra GitHub sitt EKTE `created_at` - ALDRI `Date.now()`). Ny `POST /deployments/ingest/github`-rute (tenant-scopet, feiler lukket). `/incidents/correlate` uendret, nå med FAKTISK data etter ingestion. `get_workflow_run`-transporten utvidet med `created_at` (manglet før, provider-repair). 14 nye HTTP-integrasjonstester + 1 transport-test, `FIXED_SUITE_VERIFIED=true`. **UA-5 KANONISK CLOSEOUT (2026-08-22, Tobias sin egen kjøring av runbokens §3):** ingesterte en ekte `tsworkflow/jarvisbuild`-Actions-kjøring (`workflow_run_id=32593753550`, `head_sha=63c598ec...` - PR #49 sin egen merge-commit), idempotens bekreftet, `/incidents/correlate` returnerte en ikke-null `active_deployment` som eksakt matchet den ingesterte deploy-en (`suspect_deployment=null` FORVENTET - ingen bevis-tidsvindu på den ferske hendelsen, ikke en mangel). `DEPLOY_OR_VERSION_CORRELATION_LIVE=true`, `UA5_CRITERION_1=COMPLETE`. Sammen med `UA5_CRITERION_2/3/4=COMPLETE`: `UA5_IMPLEMENTATION_COMPLETE=true`, `UA5_CANONICAL_CLOSEOUT_READY=true` - INGEN kriterium forblir `PARTIAL`. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` og `PRODUCTION_REDEPLOY_CONTAINER_SAFE=false` UENDRET. Se D-105-raden i DECISIONS_AND_ASSUMPTIONS.md for full detalj. |
| D-106: AI Mesh Council/Collaboration/lokal-Gemma-utvidelse (2026-08-22) | **FIXED_SUITE_VERIFIED. OpenAI/Anthropic uendret LIVE (tidligere bevist); Gemini/Kimi/Gemma-local `UNCONFIGURED`/`HOST_RUNTIME_REQUIRED` i dette miljøet - se D-106 i DECISIONS_AND_ASSUMPTIONS.md** | D-64/D-41-audit: eksisterende AI Mesh (D-79/D-80/D-81) var ALLEREDE en moden, testet Gemma-first arkitektur (`AiRouter`/`CapabilityRegistry`/`ProviderHealthTracker`/budsjett/kost/trace/tool-loop-idempotens/critic) - `EXISTING_AI_MESH_AUDITED=true`, `D80_REUSED=true`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`. Nytt: `gemma_local`-providerprofil (SAMME `LocalOpenAiCompatibleAdapter` som `local_llm`, nå navn-injiserbar, registrert under `JARVIS_GEMMA_LOCAL_URL`/`JARVIS_GEMMA_LOCAL_MODEL` - distinkt fra hostet `gemma_hosted`). `paid_models_allowed`-policyfelt i `router.ts`/`CompleteInput` (`false`->kun lokale providere, fail-closed `PaidModelsDisabledError`, gjelder også eier-override). `providerPreference` (ordnet preferanseliste, "bruk Gemma"->`[gemma_local,gemma_hosted]`). `override-parser.ts` - 100% deterministisk fraseparsing for eksplisitte routing-instruksjoner (aldri LLM), komponert inn i `ConversationEngine.handle()`. Ny `AiCouncil` (`council.ts`) - 3-runders protokoll (uavhengig runde 1 = anti-anchoring, kryss-kritikk runde 2, revisjon runde 3), ETT synteseanrop, `consensus_status` beregnet deterministisk i kode (aldri en selvrapportert modell-enum), degradert Council eksplisitt håndtert (`full_council`/`unavailable_members`), `requireAllFive` fail-closed (`IncompleteCouncilError`). Ny `AiCollaboration` (`collaboration.ts`) - deterministisk rolletildeling (kode, ikke LLM)->parallelt arbeid->kryssgjennomgang (aldri selvgjennomgang)->syntese, opt-in revisjon/verifikasjon. Begge persisterer til EKSISTERENDE `events`(`EventWriter`)/`artifacts`-tabeller - INGEN ny tabell. 65 nye tester (13 router/paid-models/providerPreference, 15 override-parser, 12 council, 12 collaboration, 8 ConversationEngine-wiring, 5 registry) mot fake `ModelGateway`-providere (ingen ekte nettverk) + full eksisterende suite uendret grønn (2259/2261 passert, 2 skipped, én kjent embedded-Postgres parallell-CI-hook-timeout i en UBERØRT fil (`modules/knowledge/email-sync-integration.test.ts`) bevist som flake ved isolert kjøring - 2/2 grønt alene). Eksplisitt DEFERRED (v1, korrigert av HOST-FIX under): automatisk høy-innvirkning-beslutning-klassifisering (kun eksplisitt bruker-trigger for Council bygget), tekst-override persisterer kun for gjeldende samtaletur (ikke sesjonsskopet), `AiCollaboration` ikke automatisk TaskEngine-trigger-klassifisert. |
| D-106 HOST-FIX: automatisk høy-innvirkning-beslutning-klassifisering for Council (2026-08-22) | **HIGH_IMPACT_CLASSIFIER_IMPLEMENTED=true / HIGH_IMPACT_COUNCIL_AUTO_TRIGGER=true / CLASS_D_NOT_EQUAL_COUNCIL=true / COUNCIL_TRIGGER_AUDITABLE=true - samme PR #51, AMENDMENT ikke ny D-nummer - se D-106 HOST-FIX i DECISIONS_AND_ASSUMPTIONS.md** | Tobias avviste v1-closeoutet: den godkjente spesifikasjonen krevde BÅDE eksplisitt bruker-trigger OG automatisk høy-innvirkning-klassifisering for Council, kun den første var bygget. Reparert med ny, 100% deterministisk klassifiserer (`decision-importance.ts`, `classifyDecisionImportance()` - INGEN modellkall, regex-mønstre, versjonert `CLASSIFIER_VERSION`) som klassifiserer `ROUTINE`/`SIGNIFICANT`/`HIGH_IMPACT_DECISION` over åtte harde + tre svake kategorier (arkitektur/kjerneavhengighet gjenbruker D-64s terminologi, produksjon/sikkerhet/finans/strategi/hendelse/eksplisitt-språk). Risikoklasse (A-D) og beslutnings-viktighet er BEVISST distinkte dimensjoner - klasse-D alene trigger IKKE Council (bevist eksplisitt). Trigger-presedens i `ConversationEngine.handle()`: eksplisitt undertrykkelse ("ikke bruk AI-rådet", ny `suppressCouncil` i `override-parser.ts`) > eksplisitt trigger > automatisk klassifiserer - undertrykkelse ALDRI stille, alltid auditert (ny `council_suppressed`-trace-kind). Gjenbruker DEN EKSISTERENDE Council-implementasjonen UENDRET (ingen ny Council-vei) - nytt valgfritt `CouncilInput.trigger`/`CouncilResult.provenance.trigger`-felt persistert til SAMME `events`/`artifacts`-tabeller. 34 nye tester (20 `decision-importance.test.ts` inkl. alle seks HIGH_IMPACT-eksempler fra ordren + ni ROUTINE-negativer, +3 `override-parser.test.ts`, +11 `conversation-d106-overrides.test.ts` inkl. tenant-isolasjon/determinisme/degradert-Council-fail-closed/eksisterende-overrides-uendret). Full suite `151/151`filer/`2295/2295`tester (opp fra `150`/`2261`), typecheck 19/19 rent, lint rent, INGEN regresjon. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. Gjenværende DEFERRED (ikke-blokkerende, se begrunnelse i DECISIONS_AND_ASSUMPTIONS.md): tekst-override-persistens på tvers av samtaleturer, `AiCollaboration` automatisk TaskEngine-trigger. |
| D-106 HOST-FIX 2: Council Gemma-familie-mismatch (2026-08-22) | **COUNCIL_GEMMA_FAMILY_RESOLUTION_IMPLEMENTED=true / GEMMA_LOCAL_PREFERRED_FOR_COUNCIL=true / GEMMA_FAMILY_COUNTED_ONCE=true / FULL_COUNCIL_FAMILY_SEMANTICS=true - egen reparasjons-PR fra `main` (PR #51 allerede merget), AMENDMENT ikke ny D-nummer - se D-106 HOST-FIX 2 i DECISIONS_AND_ASSUMPTIONS.md** | Etter at Tobias fikk `gemma_local` live-verifisert (RTX 4070, Ollama, `gemma3:4b`), identifiserte han at `AiCouncil` hardkodet `gemma_hosted` som Gemma-familiens Council-medlem (`DEFAULT_COUNCIL_MEMBERS`), mens den kanoniske lokale runtimen er `gemma_local` - et strukturelt mismatch. Reparert: `DEFAULT_COUNCIL_MEMBERS` erstattet med `CANONICAL_COUNCIL_FAMILIES` (`"gemma"` er nå en familie-label) + ny `AiCouncil.resolveGemmaFamilyProvider()` som løser familiens KONKRETE medlem DYNAMISK per kjøring: `gemma_local` foretrukket (konfigurert + helse ikke `UNAVAILABLE`) -> `gemma_hosted` som fallback (konfigurert + helse ikke `UNAVAILABLE` + `paid_models_allowed!==false` + `sensitivity==="PUBLIC_OR_LOW_SENSITIVITY"`, D-81s `isSensitivityEligible()` gjenbrukt uendret, nå eksportert fra `router.ts`) -> ellers familien `unavailable` (seedet EKSPLISITT før runde 1, `full_council` korrekt `false` i stedet for en tidligere falsk `true`). Gemma telles ALDRI som to medlemmer. Ny `CouncilResult.provenance.gemma_family_provider`-felt. Dynamisk oppløsning gjelder KUN default-veien (`ConversationEngine` sender aldri `members` - urørt, BÅDE eksplisitt og automatisk høy-innvirkning-trigger går uendret til samme Council). Eksplisitt `members`-kall (alle 12 opprinnelige tester) 100% uendret. +9 nye tester (`council.test.ts` M-T), alle 12 opprinnelige uendret grønne, typecheck/lint rent. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. |
| D-106 HOST-FIX 3: produksjonsherding etter FØRSTE ekte host-live-akseptanse - fem defekter A/C/D/B/E (2026-08-23, oppdatert samme dag) | **GEMMA_URL_NORMALIZATION_FIXED=true / GEMMA_FIRST_DETERMINISTIC=true / REGISTRATION_ORDER_INDEPENDENT=true / COUNCIL_STRUCTURED_OUTPUT_FIXED=true (re-audit: tekst-parser oppfyller ALLE åtte kravklassene + skjema-strenghet, bevist ende-til-ende - provider-native modus fortsatt bevisst utelatt) / GEMINI_ADAPTER_FIXED=false / KIMI_ADAPTER_FIXED=false (diagnostikk levert, INGEN gjettet fiks - live rot-årsak UMULIG å bevise i denne økten, INGEN leverandørnøkler tilgjengelig for NOEN av de fem familiene, bekreftet eksplisitt) / SCRIPTED_ADAPTER_PRODUCTION_ELIGIBLE=false / LOCAL_ONLY_NO_REAL_PROVIDER_FAILS_HONESTLY=true - AMENDMENT ikke ny D-nummer - se D-106 HOST-FIX 3 (inkl. fortsettelse) i DECISIONS_AND_ASSUMPTIONS.md** | Tobias sin FØRSTE ekte host-live-akseptansekjøring (etter PR #52) avdekket fem produksjonskode-defekter, ikke bare dokumentgap. **A:** `LocalOpenAiCompatibleAdapter` fikk en live-bevist dobbel `/v1/v1` (runbok instruerte `/v1`-suffiks, adapteren appenderte selv `/v1/chat/completions`) - ny eksportert `normalizeLocalLlmBaseUrl()` strips EN eksakt avsluttende `/v1` (aldri delvis match/urelatert mangling), adapteren bygger stien nøyaktig én gang. **C:** live-bevist eksakt 132=132-uavgjort mellom `gemma_local`/`openai` i AUTO-scoringen, avgjort av REGISTRERINGS-REKKEFØLGE (stabil sort), ikke policy - ny `AUTO_LOCAL_TIE_BREAK_BONUS=0.5` (router.ts, bevisst mindre enn minste mulige heltalls-scoringsdifferanse - kan ALDRI overstyre en reell kvalitets-/kost-forskjell, KUN et eksakt uavgjort), ny `RoutingReason` `LOCAL_PREFERRED_ON_TIE`, provider-nøytral (locality-drevet, IKKE et `gemma_local`-navnesjekk), registrerings-rekkefølge-uavhengighet eksplisitt bevist. **D:** live-bevist `invalid_json_shape`/`council_synthesis_invalid` mot ekte modellsvar - `extractJson()` (council.ts, delt med collaboration.ts) helt omskrevet: strippet markdown-fences (én fence = bruk KUN den, aldri fallback; flere fences = tvetydig, feiler), streng-bevisst balansert-brace-skanning som krever PRESIST én gyldig kandidat (null ELLER flere feiler begge ÆRLIG). Skjemavalidering hos kalleren uendret. Provider-native structured-output-modus vurdert, bevisst UTELATT (ikke alle fem familier hevder capability-en, ville tvunget en enkelt-leverandør-avhengighet) - re-audit 2026-08-23 bekreftet at kravet var en robust parser, IKKE provider-native modus, og 4 nye ende-til-ende-tester (council.test.ts U-X) beviser den FAKTISKE rundeprotokollen håndterer messy-fenced/bounded-prose-formatering repeterbart. **B:** live-bevist Gemini/Kimi 404 - rot-årsak undersøkt mot gjeldende offisiell dokumentasjon (2 forskningsrunder), INGEN bevist avvik funnet i eksisterende endepunkt-/modell-/auth-konstruksjon. En live diagnostisk probe med Tobias sin ekte nøkkel ble ORDRET i en oppfølgingsrunde - `env`/filsystem ble eksplisitt undersøkt, og INGEN leverandørnøkler (for NOEN av de fem AI Mesh-familiene, ikke bare Gemini/Kimi) finnes i dette sandbox-miljøet - en strukturell miljøbegrensning, bekreftet ikke antatt. Levert TRYGG diagnostikk i stedet (`classifyHttpStatus()` nytt valgfritt `diagnostic`-parameter: `provider_error_code`/`sanitized_endpoint`/`request_operation`, ALDRI nøkkel/auth-header/query-string/prompts), `GeminiAdapter`/`KimiAdapter` fyller det fra faktisk feilrespons-body. En uverifisert (kun aggregator-kilder, primær Moonshot-dokumentasjon nettverks-blokkert) hypotese om at default-modellen `"kimi-latest"` kan være avviklet ble IKKE omsatt til en kodeendring - beviskravet ("prove exact cause first") er ikke oppfylt. **E:** live-bevist `PAID_MODELS_DISABLED_PROVIDERS_INVOKED=...,scripted:true` - `ScriptedAdapter` (test-dobbel) var registrert i `main.ts` sin PRODUKSJONS-`ModelGateway`, kunne under `paid_models_allowed=false` uten ekte lokal provider bli et legitimt rutingvalg og returnere et FAKE svar i produksjon. Fjernet helt fra produksjonswiring (`worker-main.ts` registrerte den aldri) - tester injiserer den eksplisitt selv, uendret mønster. 44 nye tester totalt (2 nye filer: `d106-council-json-extraction.test.ts` 14, `d106-scripted-adapter-production-wiring.test.ts` 3; 3 utvidede: `conformance.test.ts` +16, `d106-router-extensions.test.ts` +7, `council.test.ts` +4 U-X). Full workspace-suite re-kjørt: INGEN feil, INGEN kjent flake. typecheck 19/19 rent, lint rent. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. Gjenstående, eksplisitt IKKE-stille-utelatt live-blokker: ALL live-verifisering (Gemini/Kimi OG de øvrige tre familiene) krever at Tobias kjører en snever akseptanseskript-kjøring PÅ SIN EGEN maskin med sine egne nøkler, samme mønster som resten av D-106 - dette er STRUKTURELT umulig fra denne økten, ikke en unnlatelse. |
| D-106 HOST-FIX 3, fortsettelse 2: FØRSTE OG ANDRE ekte host-live-akseptanse mot PR #53 (2026-08-23, samme dag) | **GEMMA_PRODUCTION_ADAPTER_LIVE=true / GEMMA_FIRST_ROUTING_LIVE=true / PAID_MODELS_DISABLED_LIVE=true (ekte live-bevist, ikke lenger kun FIXED_SUITE_VERIFIED) / COUNCIL_ROUND_MAX_TOKENS_FIXED=true / KIMI_DEFAULT_MODEL_FIXED=true / GEMINI_ADAPTER_FIXED=false (bevisst - modell bekreftet i katalogen, men entitlement-mangel på selve generateContent er ekstern) - AMENDMENT ikke ny D-nummer - se D-106 HOST-FIX 3, fortsettelse 2, i DECISIONS_AND_ASSUMPTIONS.md** | Tobias kjørte den narrow akseptanseskripten faktisk (13 HOST SAFETY-krav, A-F) mot PR #53 sin ekte kode, med sine egne OpenAI/Anthropic/Gemini/Kimi-nøkler + lokal Ollama/gemma3:4b - den forrige radens "strukturelt umulige" live-blokker er nå løst. Runde 1 avdekket en bug i AKSEPTANSESKRIPTET selv (oppdiktet tenant-id uten rad i `tenants`, ga en misvisende `kind="server"`-feil via `recordCost()` sin delte catch i `executePlan()`) - fikset i skriptet (`tenant-personal`), IKKE produksjonskode. Runde 2 beviste Gemma-adapter/Gemma-first-ruting/`paid_models_allowed=false` EKTE live, OG avdekket to genuine PR #53-defekter: Council `max_tokens: 1024` var for lavt for ekte GPT-5 (reasoning-tokens brukte HELE budsjettet, `finish_reason=length`, `text.length=0`) og Anthropic (kuttet midt i gyldig JSON) - hevet til `COUNCIL_ROUND_MAX_TOKENS=4096`/`COUNCIL_SYNTHESIS_MAX_TOKENS=4096` (council.ts), ny regresjonstest Y fanger `max_tokens` per kall. Kimi sin default-modell `"kimi-latest"` (forrige rad sin ubekreftede hypotese) BEKREFTET å ikke finnes i Moonshot sin katalog via Tobias sin ekte kontos `/v1/models`-svar + uavhengig WebSearch (kimi-k3 er flaggskipet) - rettet i `kimi.ts`/`capability-registry.ts`. Gemini 404 FORTSATT ikke en kodedefekt - diagnostikk-probe mot Google sitt EGET models-listeendepunkt bekreftet `gemini-2.5-flash` FINNES i katalogen for nøkkelen, men `generateContent` 404r likevel (kjent mønster: katalog er global, invoke håndhever entitlement per nøkkel/prosjekt separat) - `GeminiAdapter` bevisst ikke endret, Tobias må sjekke modell-/faktureringstilgang i Google-konsollen selv. Full regresjon (test/typecheck/lint) kjørt på nytt før commit. Ny commit på SAMME branch/PR #53. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. PR forblir draft, IKKE merget. INGEN UA-6. |
| D-106 PR #53: ModelGateway functional-success-invariant (2026-08-23, samme dag) | **FIXED_SUITE_VERIFIED=true / LIVE_VERIFIED=false (ingen leverandørnøkler i denne økten, uendret fra raden over) - AMENDMENT ikke ny D-nummer - se D-106 PR #53 MODELGATEWAY FUNCTIONAL-SUCCESS-INVARIANT i DECISIONS_AND_ASSUMPTIONS.md** | Fikset den dypere `ModelGateway`-korrekthetsdefekten raden over sitt Kimi-funn eksponerte (`kimi-k3` brukte hele `max_tokens=200` på skjulte resonnement-tokens, `finish_reason: "length"`, `text.length=0` - `executePlan()` behandlet FØR dette ENHVER ikke-kastet respons som ubetinget suksess uansett innhold). Nytt `completion-outcome.ts`: `isFunctionalSuccess()`/`classifyCompletionOutcome()` (`USABLE_SUCCESS`/`EMPTY_OUTPUT`/`TRUNCATED_NO_USABLE_OUTPUT`, provider-nøytral finish_reason-liste `length`/`max_tokens`/`MAX_TOKENS`)/`computeAdaptiveRetryMaxTokens()` (evidensbasert fra faktisk `usage.output_tokens`, ×4, klemt 2048-8192). `executePlan()` klassifiserer FØR retur; tool-call-only/structured-output-only forblir bevisst suksess (regresjonstestet); `TRUNCATED_NO_USABLE_OUTPUT` trigger ETT begrenset adaptivt retry (samme provider, økt max_tokens, fersk `BudgetGuard.evaluate()`-sjekk); provider-helse ALDRI straffet av tomt/trunkert innhold (transport lyktes); begge forsøk ekte kostnadsført/sporet, historikk aldri slettet. Streaming-kontrakten bevisst UENDRET (finish/usage allerede levert før klassifisering er mulig - retry gjelder KUN `.complete()`, samme sti defekten ble reprodusert gjennom). 23 nye tester (`d106-functional-success.test.ts`, alle 19 ordrede scenarier + 4 helper-tester). `pnpm -w typecheck` 19/19 rent, `pnpm -w lint` rent, full suite 154 filer/2372 tester grønt. Tobias sitt eksisterende akseptanseskript (scratchpad) oppdatert til å logge `KIMI_FIRST_ATTEMPT_FUNCTIONAL_SUCCESS`/`KIMI_ADAPTIVE_RETRY_TRIGGERED`/`KIMI_SECOND_ATTEMPT_FUNCTIONAL_SUCCESS` fra samme, allerede beskjedne kall - INGEN max_tokens-workaround. Gemini-koden fortsatt bevisst ikke rørt. Ny commit på SAMME branch/PR #53. PR forblir draft, IKKE merget. INGEN UA-6. |
| D-106 PR #53: narrow live Kimi-verifisering (2026-08-23, samme dag) | **KIMI_LIVE_VERIFIED=true / KIMI_RETRY_TRACE_PROVENANCE_LIVE=true / KIMI_RETRY_COST_ACCOUNTING_LIVE=true / PASS_A (første forsøk allerede brukbart, retry ikke trigget denne runden - retry-mekanismen selv forblir kun FIXED_SUITE_VERIFIED, se DECISIONS_AND_ASSUMPTIONS.md for presis grensedragning) / D106_CODE_REPAIR_COMPLETE=true / MERGE_READY=true (men IKKE merget - venter på Tobias sin eksplisitte godkjenning) - AMENDMENT ikke ny D-nummer - se D-106 PR #53 NARROW LIVE KIMI-VERIFISERING i DECISIONS_AND_ASSUMPTIONS.md** | Tobias kjørte et smalt, Kimi-only akseptansescript (streng git-preflight: rent arbeidstre, fetch, eksakt SHA-match mot PR #53 sin remote head `31a329e...` FØR kjøring, fail-closed ved avvik) mot `gateway.complete({provider:"kimi", max_tokens:200})` - kanonisk `KimiAdapter`+`ModelGateway`, ingen manuell max_tokens-heving, ingen manuelt retry fra scriptet. Bevis fra to ekte kilder: en `MemoryTraceSink`-instans inspisert for de faktiske `model_call`-spanene, og en RLS-trygg `cost_events`-spørring avgrenset til rader denne kjøringen selv produserte. Resultat: `finish_reason=stop`, `output_tokens=153`, synlig tekst 4 tegn - brukbart FØRSTE forsøk, ingen retry nødvendig denne gangen (reasoning-token-forbruk er ikke-deterministisk per kall; forrige runde brukte HELE budsjettet med samme `max_tokens=200`). Ingen kodeendring - kun dokumentasjon. `FULL_FIVE_MEMBER_COUNCIL_LIVE=false`, `GEMINI_EXTERNAL_BLOCKER=true` uendret. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. PR #53 forblir draft, IKKE merget. INGEN UA-6. |
| D-106 PR #53 merget; ny PR (`claude/d106-gemini-3-6-flash-migration`) - Gemini model-migrasjon gemini-2.5-flash→gemini-3.6-flash (2026-08-23/24) | **FIXED_SUITE_VERIFIED=true / GEMINI_25_FLASH_404_ROOT_CAUSE_CONFIRMED=true (CONFIRMED_OUTDATED_DEFAULT_MODEL, ikke lenger external_key_entitlement_suspected) / GEMINI_36_FLASH_DIRECT_PROVIDER_LIVE=true (Tobias sin direkte Google HTTP-probe, teller IKKE som Jarvis-akseptanse) / GEMINI_DEFAULT_MODEL_UPDATED=true / GEMINI_EXPLICIT_OVERRIDE_PRESERVED=true / GEMINI_CAPABILITY_METADATA_UPDATED=true / GEMINI_MODEL_GATEWAY_LIVE=false (gjenstår, Tobias sin host-kjøring via kanonisk GeminiAdapter→ModelGateway) / MERGE_READY=false inntil den kjøringen foreligger - AMENDMENT ikke ny D-nummer, samme D-106 - se D-106 PR #53 MERGET; NY PR - GEMINI MODEL MIGRATION i DECISIONS_AND_ASSUMPTIONS.md** | PR #53 merget til `main` (merge-commit `4ef8d72cc1da0006fb49eb131e3e658ebd540376`, post-merge CI grønt). Ny host-diagnostikk: Tobias sin autentiserte `POST /v1beta/models/gemini-2.5-flash:generateContent`-probe returnerte 404 med Google sin egen migreringsbeskjed til `models/gemini-3.6-flash`; identisk probe mot `gemini-3.6-flash` lyktes. WebSearch (direkte `WebFetch` mot `ai.google.dev`/`deepmind.google`/`blog.google` nettverks-blokkert denne økten) bekreftet uavhengig at `gemini-3.6-flash` er en ekte Google DeepMind-modell (lansert 21. juli 2026, 1 048 576 input-tokens) FØR koden ble endret (samme D-41-disiplin som `kimi-k3`). Fiks: `GeminiAdapter` sin default (`gemini.ts`) endret til `gemini-3.6-flash` (URL-konstruksjon allerede dynamisk, ingen endring nødvendig der); `JARVIS_GEMINI_MODEL`-override (dokumentert i `.env.example`) vinner fortsatt alltid; `capability-registry.ts` sin `gemini`-profil oppdatert (`model`, `context_tokens: 1_048_576`) - `capabilities` BEVISST UENDRET (D-43 §3: `GeminiAdapter` har fortsatt ingen tool-calling/vision wired, selv om leverandøren støtter det); `pricing.ts` sin `gemini`-rate oppdatert (1,58/7,88 øre, `pricing_mode: PAID`, `pricing_verified_at: 2026-08-23`) - nødvendig konsekvens, gammel rate ville under-sporet kostnad ~5x/~2,9x. `router.ts`/`council.ts` urørt (refererer kun provider-navn, aldri modellstreng). 4 nye/oppdaterte tester, full suite **154 filer/2376 tester grønt**, `typecheck`/`lint` rent. Ny, egen PR fra `origin/main` - IKKE en gjenåpning av PR #53. `FULL_FIVE_MEMBER_COUNCIL_LIVE=false`, `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. PR forblir draft, IKKE merget. INGEN UA-6. |

| D-107 UA-6 Finance & Spend Integrity Gateway - FØRSTE slice: Payment/Spend Intent-domene + Fiken (2026-08-24) | **FIXED_SUITE_VERIFIED=true / LIVE_VERIFIED=false (avventer host-kjøring) / UA6_STARTED=true / UA6_COMPLETE=false (kun slice 1 - Fiken P0; bank/Stripe/Vipps P1 og kort/wallet P2 ikke startet)** | `SOR=HYBRID_WITH_CLEAR_AUTHORITY` (D-64-port kjørt FØRST): Jarvis eier idempotens/validering/kill-switch/state-machine/avstemming/audit (`JARVIS_CANONICAL`); Fiken eier det offisielle bokførte regnskapet (`EXTERNAL_CANONICAL`, bokføringsloven). `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Fiken masterplan-navngitt P0. D-41-audit: primær `api.fiken.no`-kilde `EGRESS_BLOCKED`, falt eksplisitt tilbake til Fikens egen swagger.json speilet i `bjerkio/fiken-js` (lavere tillitsnivå, merket `VERIFIED_SEARCH_SNIPPET`). `POST /purchases` BEVISST IKKE implementert (intet pålitelig skjema kunne verifiseres - D-41 nekter gjetting). Ny migrasjon `038_finance.sql`, pakke `@jarvis/finance`, 10 `finance.*` ToolGateway-handlinger (risikoklasse D for `submit_payment_intent`/kill-switch), `OpenLoopService.detectPaymentAnomalies()`, Q-20 erasure-plan utvidet. Tre ekte produksjonsbugs funnet+fikset via faktisk testkjøring: RLS-kontekst-brudd på `finance_kill_switch`, `bigint`→streng pg-koersjonsbug i Fiken-postering, kryss-tilkoblings FK-radlås-selvlåsing (nøstet transaksjon ventet på en radlås den ytre transaksjonen aldri ville slippe). 53 nye finance-tester + 9 nye open-loop-tester, full workspace **160 filer/2456 tester grønt** (opp fra 159/2445), typecheck/lint rent. Host-akseptanse-script bygget (`modules/finance/scripts/fiken-live-host-run.ts`→`fiken-live.ts`→`lib/fiken-live-lib.ts`) - beviser hele JARVIS_CANONICAL-domenet UAVHENGIG av Fiken-credentials; Fiken har INGEN dokumentert sandbox, så et ekte `submit`-skriveforsøk gjøres ALDRI av scriptet selv med opt-in. Full detalj: D-107 i DECISIONS_AND_ASSUMPTIONS.md. |

| D-109 UA-6 Finance & Spend Integrity Gateway - TREDJE slice: Stripe betalinger/refusjoner/webhooks/avstemming (2026-08-25) | **FIXED_SUITE_VERIFIED=<se PR-closeout> / STRIPE_LIVE_VERIFIED=false / STRIPE_LIVE_GATE=PENDING_CREDENTIALS / UA6_STARTED=true (uendret) / UA6_COMPLETE=false (tredje av flere slices - bank/Vipps/kort-wallet ikke startet)** | `SOR=HYBRID_WITH_CLEAR_AUTHORITY` (D-64-port kjørt FØRST, `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Stripe masterplan-navngitt P1). D-41-audit: `docs.stripe.com`/`cdn.jsdelivr.net`/`raw.githubusercontent.com`/`stripe.dev`/`web.archive.org` ALLE `EGRESS_BLOCKED`, falt tilbake til uavhengig `WebSearch`, merket `VERIFIED_SEARCH_SNIPPET`. Ny migrasjon `040_stripe.sql`, `FinanceService` utvidet med Stripe-utførelse (PaymentIntent UTEN betalingsmetode, deterministisk `provider_acknowledged`)/refusjon (gjenbruker eksisterende state-machine)/webhook-ingestion (rå body, HMAC-signatur, event-ID-idempotens, fail-closed tenant-krysssjekk)/oppfrisking/avstemming - ALT gjennom ÉN ordens-voktet domene-sti. 7 nye `finance_stripe.*` ToolGateway-handlinger, 7 provider-avvikstyper skrevet til den EKSISTERENDE `payment_intents.anomaly_flags` (ingen ny OpenLoop-kode trengtes), `/webhooks/stripe`-rute, `stripe-payment-sync`-sveip (kl. 03), erasure-plan utvidet. To selv-fangede designfeil rettet FØR test (RLS-space-kontekst-bug i webhook-ingestion, `canceled`→`cancelled`-mapping-korreksjon). Test-/host-akseptansetall og PR-detaljer dokumenteres ved denne PR-ens closeout. Full detalj: D-109 i DECISIONS_AND_ASSUMPTIONS.md. |
| UA-7 Communications Hub (D-197 dokumentasjonslukking, 2026-09-19 - kode allerede levert 2026-08→09 under D-119/D-121/D-122/D-123/D-125, PR #66/#67/#70/#71) | **IMPLEMENTED_NOT_VERIFIED** (suite-/CI-bevist, ingen host-akseptanse - `HOST_ACCEPTANCE_REQUIRED=false` eksplisitt for alle fem D-IDer: ren TypeScript/ToolGateway/PolicyGateway/Postgres/RLS, ingen Windows-/Docker-/enhets-/live-leverandør-avhengighet). Masterplanens fire akseptansekriterier: `UA7_ACCEPTANCE_1=PASS` (åpne forpliktelser/neste-steg synlig på tvers av kanaler), `UA7_ACCEPTANCE_2=PASS` (Gmail-sti), `UA7_ACCEPTANCE_3=PASS` (reversibel/konfidens-sporet identitets-sammenslåing), `UA7_ACCEPTANCE_4=PARTIAL` (blokkert på Q-32 punkt 1 - OpenAI-som-databehandler-verifisering for STT/TTS, en eier-/juridisk handling, IKKE et kodegap). `UA7_COMPLETE=false`. | `modules/conversation-graph/src/{types,service,sync,transport,normalize,index}.ts` (migrasjon `046_conversation_graph.sql`), `packages/contracts/src/speech.ts` (deterministisk tale-rutingsport), `modules/core/src/services/{voice-session-authority,telegram-owner-authority}.ts`, `apps/voice-gateway/src/{server,session,stt}.ts`. D-119 (grunnslice, PR #66/#67, to selvfangede pre-merge-funn: en `performed_by`-forfalskning og en samtidig split/foreldreløs-identitet-rase), D-121 (kryss-kanal forpliktelser/neste-steg, PR #70), D-122 (tale-/transkripsjons-oppbevaring+rettslig-grunnlag-port, PR #71 - fant og rettet at `DPIA_VOICE.md` sin "ingen rå lyd forlater maskinen"-påstand allerede var usann siden BO-12), D-123 (betrodd server-side taleøkt-/minne-space-autoritet), D-125 (kun-eier Telegram-innkommende kanal). 209 tester på tvers av `conversation-graph`/`voice-gateway`/`core`/`tool-gateway`/`api` (60+14+6 i conversation-graph alene, 80 totalt; +32+15+14+15+15+15 for tale-/Telegram-autoritet-wiring). Bygges IKKE ennå: Slack/Teams/WhatsApp/Messenger/Discord/SMS/SIP (D-108-credential-portet, zero kode), Gmail `send`/Calendar `create_event` (registrerte `ToolDefinition`-er UTEN utførende transport), møtetranskripsjon (`UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`), autonom utgående AI-samtale. |
| UA-8 Personal Digital Twin (D-197 dokumentasjonslukking, 2026-09-19 - kode allerede levert 2026-09 under D-130/D-131/D-131b, PR #79 `f12ff3b`) | **IMPLEMENTED_NOT_VERIFIED** (suite-/CI-bevist, ingen host-akseptanse for selve provider-nøytrale kjernen - fysiske iPhone/Watch/Mac-klienter og en ekte HA-instans er EGNE, allerede `BLOCKED_EXTERNAL`-rader, se D-36/HA-RUNTIME). Masterplanens fire akseptansekriterier: `UA8_ACCEPTANCE_1=PASS` (øktkontinuitet web/telefon/Watch/tale), `2=PASS` (helse-/lokasjonsdata følger konfigurert ruting+oppbevaring), `3=PARTIAL` (før/etter-tilstand+feilsynlighet for kritiske home/car-handlinger PASS, men en mål-eksistens-sjekk-svakhet ble funnet og IKKE rettet - sporet som Q-34, egen fremtidig cross-domene-revisjon), `4=PASS` (DPIA/behandlingsoversikt oppdatert, `docs/UA8_PERSONAL_TWIN_DPIA.md`). `UA3_COMPLETE=true` som bieffekt (D-130 fant og rettet at UA-3 akseptansekriterium 1 var FEILAKTIG hevdet VERIFIED - Support/Agreements skrev aldri faktisk til `business_activities`). | `modules/context/src` (`049_context_engine.sql`), `modules/location/src` (`050_location.sql`), `modules/health/src` (`051_health.sql`), `modules/core/src/services/channel-session-authority.ts`, `packages/contracts/src/mobility.ts` (kun typer, ingen leverandør valgt), `052_tenant_catalog_all.sql`. D-130 (seks parallelle, filpartisjonerte leveranser), D-131 (uavhengig arkitekt-review, fem merge-blokkere rettet: `ChannelSessionAuthority` var IKKE faktisk wiret inn i `/chat`/`/brief`; UA-3-kriterium-1-tidslinjeskrivingen var ikke-atomisk to-transaksjoners; Q-33 kryss-tenant-gap lukket; alle fem nye UA-8-tabellers `person_id`-FK-er utvidet til sammensatt `(person_id, tenant_id)`; lokasjons-oppbevaring svelget FK-feil stille), D-131b (TOCTOU-fiks i enhetsnøkkel-fingeravtrykk→grant-bindingen delt av `ChannelSessionAuthority`/`VoiceSessionAuthority`). 98 tester (52 context/location/health RLS+scope-integritet, 46 økt-autoritet-e2e/TOCTOU). D-131b sin egen sluttmåling for HELE workspace: 237/237 filer, 3856/3856 tester grønt. Bygges IKKE ennå: fysisk iPhone/Watch/Mac-kompilering (D-36, Apple-utviklerkonto), ekte HA-instans+token (HA-RUNTIME), kjøretøy-/bil-leverandør (kun typer). |
| UA-9 Vision & Physical World (D-197 dokumentasjonslukking, 2026-09-19 - kode allerede levert 2026-09 under D-153, PR #83 `c7bc3a4`) | **IMPLEMENTED_NOT_VERIFIED** (suite-/CI-bevist, provider-uavhengig kjerne - `CAN_RUN_WITHOUT_PROVIDER=true`, zero leverandør wiret). Masterplanens tre akseptansekriterier: kriterium 1 (objekt-identifikasjon/"sist sett"-arbeidsflyt) og 2 (oppbevarings-/slette-regler håndhevet) PASS strukturelt via RLS/multi-space/CHECK-håndhevet oppbevaring; kriterium 3 (sensitive kamerastrømmer rutet per datapolicy) er PARTIAL - multi-space-RLS-/tenant-isolasjon for LAGREDE hendelser er strukturelt bevist, men faktisk kamerastrøm-ruting krever en live adapter som ikke er bygget her. | `modules/vision/src/{types,service,sweep,fake-source,index}.ts` (migrasjon `055_vision.sql`: `vision_retention_policies`/`vision_rooms`/`vision_event_observations`), `docs/UA9_VISION_DPIA.md`. Multi-space (lokasjon-stil) arkitektur, IKKE ett låst `memory_space` (D-153, bevisst valg). `snapshot_ref` er STRUKTURELT forbudt (DB-CHECK) inntil en ekte snapshot-lagringsadapter finnes. D-153 (P0-kjerne) + to samme-PR arkitekt-review-herdingsrunder (runde 1: manglende kildestabil hendelsesidentitet/atomisk batch-semantikk + oppbevaring feilaktig ankret på ubetrodd `observed_at` i stedet for `recorded_at`; runde 2: dedupe-nøkkel manglet `source_instance_id`, kryss-enhet-kollisjonsrisiko, + `payload_fingerprint`/`VisionReplayConflictError` lagt til så en samme-nøkkel-annet-innhold-replay feiler LUKKET i stedet for å returnere utdatert data stille). 45 tester (34 service-RLS + 8 rom-scope-integritet + 3 erasure). Bygges IKKE ennå (alle `DEFERRED_WITHIN_UA9_BY_DEPENDENCY`, D-153/DPIA §5): live iPhone-/HA-kamera/dørklokke/sikkerhetshendelser (fysisk maskinvare + D-64/D-41-leverandørport), faktisk objekt-klassifiserings-modellpipeline (leverandørvalg - selve klassifiserings-KODEN mot `ModelGateway`/Gemma-vision er allerede kallbar mot et syntetisk bilde uten fysisk kamera, kun live-fangst er blokkert), biometrisk ansiktsgjenkjenning (eksplisitt utenfor masterplan v4.0 UA-9-scope). |
| UA-10 P1 Aktivering: Situation Engine live (bro fra business_open_loops, INFORM/SUGGEST-leveranse, eier-bundet auto-ACT, kontrollflate) (2026-09-16, D-160; merget til main `ecb99eab` 2026-09-17) | **PRODUCTION_VERIFIED (2026-09-17)** - host-bevist paa ekte Windows/Docker-host (run_id `0562c48a`, main `e34cb8a92764e0274a74afcdc7798b495822c821`, **18/18 markoerer PASS, `hard_fail=false`, `blocked_external=0`**, ekte Telegram INFORM + ACT) etter to host-runder: (1) run `2105bb7d` (main `fadad73e`) FAIL 11/18 => to harness-feil (D-160 I, PR #89 merget `e34cb8a9`); (2) run `0562c48a` PASS. Historikk: FIXED_SUITE_VERIFIED -> HOST_ACCEPTANCE_HARNESS_BUILT -> CONTAINER_RUNTIME_VERIFIED (`14b04af4`, `72aef659`, `4b5961c3`) -> produksjonsbug funnet+fikset (PR #88 `fadad73e`) -> HOST_VERIFY_FAILED (`2105bb7d`) -> harness-fiks (PR #89) -> PRODUCTION_VERIFIED. Se D-161. | `057_situations_activation.sql`, `modules/situations/src/{open-loop-bridge,sweep,transport}.ts`, motor-utvidelser i `service.ts`, wiring i `apps/api/src/main.ts` (`situation-sweep`, `JARVIS_SITUATION_SWEEP_HOUR` default 07). Suite-bevis: `activation.test.ts` 22, `open-loop-bridge.test.ts` 12 (ekte embedded Postgres/RLS, ekte `OpenLoopService`/`ToolGateway`/`PolicyGateway`/`DailyScheduler`). **Host-akseptanse-harness bygget (2026-09-17, SAMME to-fils-mønster som UA-3/UA-4):** `modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts` (bootstrap: pnpm install --frozen-lockfile -> docker compose up postgres -> build migrate/api/worker -> run migrate (057) -> restart api/worker) -> `ua10-p1-situation-sweep-live.ts` (18 markører: Q-21, migrasjon 057 etter 055/056, runtime-init, kontrollflate-credential, open-loop-bro live, sveip healthy, evidens-først leveranse, live Telegram-transport, idempotens/replay, eier-autoritet, identitetsforfalskning, domene-pause, auto-ACT nøyaktig én gang, tenant/space-isolasjon, fail-closed scheduler med EKTE `DailyScheduler` og kjøre-unike jobbnavn, release-stuck-claim, cleanup) + CI-vakt `ua10-p1-situation-sweep-host-run-wiring.test.ts` (25) + `ua10-p1-canonical-telegram-path.test.ts` (3) + `migration-evidence.test.ts` (8). Kommando på hosten: `node --env-file=.env --experimental-transform-types modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts`. **Container-runtime-kjøring (IKKE Tobias sin Windows/Docker-host - cloud-container uten Docker-daemon/.env/Telegram):** ekte PostgreSQL 16.13-klynge, `apps/api/src/migrate-main.ts` kjørt som admin (57 migrasjoner, `054 -> 055_vision -> 056_situations -> 057_situations_activation`, `runtime_role_ensured jarvis_runtime`, owner-seed), live-scriptet som `jarvis_runtime` (`superuser=false`, `bypassrls=false`). Run 1 (run_id `cf8b750d`, main `ecb99eab` UENDRET): **`ua10_control_surface_credential=FAIL` (`credential_unavailable`)** - PRODUKSJONSBUG: `situations.*` brukte en oppfunnet `credential_ref` (`JARVIS_SITUATIONS_INTERNAL_TOKEN`) som produksjonens secret-kjede aldri leverer; hele eier-kontrollflaten (pause/policy/kø/release) var død i drift, skjult av test-provideren i `activation.test.ts`. Sveip/bro/leveranse/replay/scheduler PASS også før fiks. Run 2 (run_id `14b04af4`, etter minste fiks = samme interne sentinel som alle andre interne verktøy): 16/17 PASS, `hard_fail=false`; `ua10_notification_live_transport=BLOCKED_EXTERNAL` (ingen Telegram-credential i containeren - lokal opptaker under den KANONISKE `telegram.notify`-definisjonen, ærlig merket). Runtime etter kjøring: 0 rester (tenants/people/situations/policies/open loops/tool_executions/scheduler-rader/pauser), owner-seed intakt. **Gjenstår for LIVE:** Tobias kjører kommandoen over på Windows/Docker-hosten med `.env` (Telegram allerede konfigurert => `ua10_notification_live_transport` bevises mot ekte transport, ett syntetisk INFORM- + ett ACT-varsel til eierens chat) og limer inn hele output-blokken; deretter flippes denne raden til VERIFIED/COMPLETE med host-run_id. Se D-160 G. **Arkitekt-review runde 1 (5234145170) rettet (2026-09-17, D-160 H):** akseptansen muterte den GLOBALE `spend`-pausen; naa kjoere-unikt akseptansedomene `ua10_acceptance_<runId>` for alle pause/unpause/restore-bevis, syntetisk ACT-kandidat direkte via `SituationEngine.evaluateCandidate()`, cleanup kun `LIKE 'ua10_acceptance_%'`, ny markoer `ua10_existing_global_pauses_preserved` (full rad-snapshot foer/etter), CI-vakt 19 tester som avviser hardkodet pause av ekte domener/`*`. Run 3 `72aef659` (container, ny klynge, vitnepause paa `spend` saadd foer kjoering): 17/18 PASS, `hard_fail=false`, `ua10_notification_live_transport=BLOCKED_EXTERNAL`, vitne-raden byte-identisk etterpaa, 0 rester. Host-akseptanse paa Windows/Docker skal IKKE kjoeres foer ny arkitekt-review. **Foerste EKTE host-kjoering (Tobias, main `fadad73e`, run_id `2105bb7d`, 2026-09-17): `hard_fail=true`, 11/18 PASS, 7 FAIL** (`ua10_migration_057_applied`, sveip-healthy, evidens-foerst, live-transport, replay, auto-ACT, fail-closed scheduler). Reprodusert EKSAKT i container (run `d9c2d9dc`) og sporet til TO HARNESS-FEIL, INGEN produksjonsbug (D-160 I): (A) for bred migrasjonspaastand - hostens historiske `014`/`023`-rader (`014_pgvector_embeddings.sql` fra Tobias sin `6a306f6` 2026-08-13; `023_zendesk_support.sql` fra ikke-merget branch 2026-08-18) er migrator-stoettet, ikke en kollisjon; naa ren `evaluateMigrationEvidence()` (055/056/057 unike/ordnet/anvendt, historikk rapportert). (B) `CountingTransport` droppet `credential` foran `TelegramTransport` => `botundefined` => 404 => `tool.failed` i audit, ingen tool_executions-rad, `pending` uten grunn, `stage=act`; naa videresendes alle argumenter, forsoek telles ved inngang, `scripts/` typesjekkes (TS2554 hadde fanget det), diagnostikk uten secrets viser foerste avvikspunkt. Etter fiks: container run `4b5961c3` 17/18 PASS (`hard_fail=false`, notification BLOCKED_EXTERNAL), kanonisk-sti-test (ekte TelegramTransport, stubbet fetch) beviser INFORM+ACT med credential i URL. **ANDRE EKTE HOST-KJOERING (Tobias, Windows/Docker, main `e34cb8a9`, run_id `0562c48a`, 2026-09-17) - PRODUCTION_VERIFIED (D-161):** 18/18 PASS, `hard_fail=false`, `blocked_external=0`. Live-evidens: runtime-rolle `jarvis_runtime` (`superuser=false`, `bypassrls=false`); 055/056/057 til stede og i rekkefoelge, `required_prefix_collisions=(ingen)`, `repo_prefix_collisions=(ingen)`; historisk orphan rapportert eksplisitt `023:023_business_tenant_catalog.sql,023_zendesk_support.sql` (migratoren noekler paa eksakt filnavn - historisk rad, IKKE en UA-10 runtime-blocker; `014`-duplikatet fantes ikke paa hosten); `telegram_mode=LIVE_TRANSPORT`, `credential_resolved=true`, `chat_id_configured=true`; INFORM: `transport_attempts=1`, `transport_successes=1`, `tool_executions=succeeded` med external_id, `delivered=1`, `pending=0`; replay: `new_transport_calls=0`, `after_crash_reconciled=1`; ACT: `actuator_sequence=read_state,assign,read_state`, `act_result=succeeded`, `stage=act_notify`, `act_notify_calls=1`, replay `attempted=0`; scheduler: healthy `completed_at=2026-09-17T13:45:10.292Z`, mismatch `completed_at=NULL`; `global_pauses_before=(ingen)`, `global_pauses_after=(ingen)`; cleanup: 0 situations/policies/tenants/scheduler-jobber/akseptansepauser igjen, `production_situation_sweep_untouched=true`. Masterplanens fire UA-10-akseptansekriterier er dermed bevist LIVE i drift, ikke bare i suiten. UA-10 P1 runtime-gaten er LUKKET; neste Sovereign-arbeid er UA-11 Executive Mode P0 (ikke startet). |

| UA-10 infra-slice: incidents-broen (D-195, direkte Tobias-chat-oppgave under D-192, 2026-09-19) | **FIXED_SUITE_VERIFIED - host-akseptanse IKKE kjørt i denne økten.** `infra-incident-bridge.ts` (ren bro, samme mønster som `open-loop-bridge.ts`) + `SituationEngine.resolveStaleForDomain()` (generalisert domene-basert kildeløsning) + `sweep.ts` sitt frivillige `incidents?: IncidentReader`-felt + wiring av den allerede-konstruerte `incidentService` (UA-5) i `apps/api/src/main.ts` sitt `situation-sweep`-kall. ZERO ny migrasjon (domain var allerede fri tekst, source_open_loop_id allerede nullable), ZERO ny credential/leverandør (samme interne `incidents`-modul som UA-5 allerede er host-verifisert på). 18 nye tester grønne: `modules/situations/test/infra-incident-bridge.test.ts` (15, rene enhetsbevis - ingen database), `apps/api/test/situation-sweep-infra-wiring.test.ts` (3, strukturell wiring-regresjonsvakt). `pnpm --filter @jarvis/situations typecheck`/`pnpm --filter @jarvis/api typecheck`/`pnpm -w lint` rene. DB-avhengige eksisterende suiter (`activation.test.ts` osv.) IKKE kjørt lokalt denne økten (sandbox mangler tilgang til å starte embedded Postgres - samme begrensning som D-193/D-194, ikke en regresjon fra denne sliceen) - verifiseres av CI. Ingen host-akseptanse kjørt for denne sliceen ennå (ingen ny ekstern atferd å bevise - samme begrunnelse som UA-11 P0 sin `HOST_ACCEPTANCE_REQUIRED=false`). Se D-195. |
| UA-11 Executive Mode P0 (attention-ranking + samlet kontrollflate, komponerer `situations`) (2026-09-17, D-162, branch `tobias/manual-masterplan-ua11-executive-mode-p0`, IKKE merget) | **FIXED_SUITE_VERIFIED - INGEN HOST-AKSEPTANSE NOEDVENDIG FOR DENNE SLICEN.** Ny pakke `@jarvis/executive` har ZERO ny migrasjon, ZERO ny credential/leverandoer, ZERO ny persistens (koeen er fullt deriverbar fra `situations.get_queue()` ved lesetidspunkt) - komposisjonen gaar via ETT nestet `ToolGateway.execute({tool_id:"situations",...})`-kall under den SAMME produksjonssikringen (PolicyGateway/KillSwitch/RLS/D-68-identitet) som UA-10 P1 allerede er host-verifisert (PRODUCTION_VERIFIED) paa - det finnes derfor INGEN ny leverandoer-/host-spesifikk atferd for denne sliceen aa bevise paa Tobias sin Windows/Docker-host. `HOST_ACCEPTANCE_REQUIRED=false` for P0; en fremtidig UA-11-slice som legger til en ny HTTP-rute/dashboard/modell-assistert ranking vurderer host-gate paa nytt da. | 42 nye/paavirkede tester groenne: `modules/executive/test/ranking.test.ts` (21, ren funksjon), `modules/executive/test/service-transport.test.ts` (17, ekte embedded Postgres/RLS - komposisjon-via-gateway, tenant-isolasjon via RLS, KillSwitch-basert PolicyGateway-avvisning, forfalsket identitet avvist, pause/resume via kanonisk `situations.*`, replay-stabil ranking), `apps/api/test/executive-wiring.test.ts` (4, strukturell komposisjons-/worker-fravaer-regresjonsvakt). Ingen regresjon i `drive-runtime-wiring.test.ts` (13) eller `executive-parity.test.ts` (4, urelatert BO-11.1-navnekollisjon). `pnpm --filter @jarvis/executive typecheck`/`pnpm --filter @jarvis/api typecheck`/`pnpm -w lint` rene. Se D-162 og `docs/UA11_EXECUTIVE_MODE_DESIGN.md`. |
| K1 - UA-11 akseptansekriterium 3: durable/delt `KillSwitch`/`OwnerControls` + kanonisk `owner_controls.*` + `executive.get_control_surface_status` (2026-09-17/18, D-164/D-165/D-166/D-167/D-168, branch `tobias/manual-masterplan-k1-owner-control-authority`, **PR #93 MERGET** `MERGE_SHA=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`, parents `34c9c474a478cb7aab7858284ec0606eab51c128`+`9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25`) | **PRODUCTION_VERIFIED FOR HELE FLATEN (D-168, 2026-09-18) - kjernemekanisme (freeze/unfreeze/kill-switch-parity, host run_id `d7d5d246`) OG credential-revoke/restore-selvgjenopprettingsstien (inkl. samtidig-deadlock-gjenoppretting OG det D-167-fiksede audit-beviset) er NÅ BEGGE host-bevist: fersk EKTE Windows/Docker Desktop-kjøring av det D-167-fiksede harnesset på eksakt HEAD `9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25` (samme HEAD uavhengig arkitekt-review `5247323973` reviewet) ga `k1_credential_revocation_self_recovery=PASS`/`k1_combined_deadlock_recovery=PASS`/`k1_audit_evidence=PASS`/`k1_cleanup_state_unchanged=PASS`, ALLE K1-markører PASS, `hard_fail=false`, run-avgrenset audit-bevis `audit_rows=15`/`deactivate_count=2`/`restore_count=2`/ingen secret-leak. Uavhengig arkitekt-review PASS + Tobias sin eksplisitte merge-closeout-ordre → merget, post-merge CI (run `35340723640`) grønn på alle tre jobber. Se D-168 for full begrunnelse; historikken under (D-164 t.o.m. D-167) forblir uendret som forklaring på HVORDAN denne tilstanden ble nådd.** Kommando: `node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts` på HEAD `2af8295cd43462215084da843a77ebc8e813fd81`. **10/10 markører PASS, `hard_fail=false`:** `q21_runtime_role_safe`, `k1_migration_058_applied`, `k1_activation`, `k1_api_side_blocked`, `k1_worker_side_blocked`, `k1_restart_state_survives`, `k1_no_startup_window`, `k1_resume_restores_both_sides`, `k1_audit_evidence`, `k1_cleanup_state_unchanged`. Live-evidens: `jarvis_runtime` (`superuser=false`/`bypassrls=false`); migrasjon 058 til stede med korrekte kolonner; EKTE eier-identitet (`person-tobias`) aktiverer kill switch; separate "api"-/"worker"-side (egen `pg.Pool` hver, null delt JS-hukommelse) nekter BEGGE `freeze_connector` med `kill_switch_active`; EKTE `docker compose restart api worker` utført midt i kjøringen; FERSKE instanser (ingen `restore()` kalt) ser kill switchen fortsatt aktiv på FØRSTE spørring rett etter restart (intet oppstartsvindu); `deactivate_kill_switch` fra "worker"-siden gjenoppretter tilgang sett fra BEGGE sider, inkl. `worker_saw_freeze=true` (ekte cross-prosess connector-frys-synlighet); `audit_events` 6 rader med korrekt actor/reason, ingen credential-verdi i payload; `owner_control_state_before=[]`/`_after=[]` byte-identisk. Se D-165 for full kryssjekk mot scriptets kildekode. **Migrasjon `058_owner_control_authority.sql`** (`owner_control_state`, global, ingen RLS/tenant_id). `KillSwitch`/`OwnerControls` (modules/policy) fikk `*Durable()`-metoder (LIVE per-kall DB-spørring, ingen cache - se D-164 B) + `restore()`; eksisterende synkrone metoder byte-identisk uendret. Ny pakke `@jarvis/owner-controls` (`owner_controls.*` ToolGateway-namespace, 7 handlinger, D-68-identitetsdisiplin). `apps/api/src/main.ts`+`worker-main.ts` konstruerer nå BEGGE `killSwitch`/`ownerControls` med samme `pool`+`authority`, kaller `restore()` FØR bruk, og setter `controls: ownerControls` i `PolicyGateway` (tidligere aldri satt). To dokumenterte selvgjenopprettings-unntak i `PolicyGateway.authorize()`/`ToolGateway.execute()` hindrer et permanent kill-switch-/frys-lås. `/infra/pause`-ruten URØRT (fersk-verifisert: muterer `InfraExecutionGate`/D-104, en annen mekanisme - K1-ordrens premiss om denne ruten var feil, korrigert). **IKKE host-bevist av DENNE (D-165) spesifikke kjøringen (forblir SUITE/CI-PROVEN, ikke overdrevet til host-proven):** `executive.get_control_surface_status` (harnesset importerer ikke `@jarvis/executive`), `idempotency_key`-dedupe (ingen kall i live-scriptet sender én). **`revoke_credential`/`restore_credential` - STATUS KORRIGERT (D-166, 2026-09-18):** uavhengig arkitekt-review av PR #93 (kommentar `5723356282`) fant BLOCKER B1 her - IKKE bare "ikke øvet ennå" (som D-165 sa), men en REELL selv-lås-bug: `owner_controls.restore_credential` bruker SAMME delte `credential_ref` som `owner_controls`/`situations`/`executive` selv, og `ToolGateway.execute()` sin `isRevokedDurable()`-sjekk hadde INGEN unntak - en tilbakekalling av den delte refen ville blokkert sin egen gjenoppretting, kun løsbart med manuell SQL. Fikset med en minimal, DELT, handlings-nivå selvgjenopprettings-mengde (`OWNER_CONTROLS_SELF_RECOVERY_ACTIONS = {get_control_state, deactivate_kill_switch, restore_credential}`, IKKE en blanket-unntak for hele `owner_controls`), brukt identisk av BÅDE `PolicyGateway.authorize()` sin kill-switch-sjekk OG `ToolGateway.execute()` sin nye tilbakekalt-credential-sjekk - nødvendig for at en SAMTIDIG kill-switch+tilbakekalt-credential-tilstand skal ha en deterministisk gjenopprettingsvei i begge rekkefølger, ikke bare hver for seg. 30/30 tester i `owner-control-authority.test.ts` grønne (22 eksisterende + 8 nye, inkl. samtidig-deadlock begge rekkefølger, ikke-eier-avvisning, normal-nektelse-regresjon), 809/809 full regresjon grønn, typecheck/lint rene. Host-harnesset (`k1-owner-control-authority-live.ts`) er UTVIDET med nye seksjoner (I/J) som øver DENNE spesifikke stien + samtidig-deadlock-invarianten, men er ALDRI KJØRT PÅ NYTT av Tobias etter utvidelsen. Status for DENNE delkapabiliteten: **`FIXED_SUITE_VERIFIED_AFTER_B1`, `HOST_ACCEPTANCE_REQUIRED=true`** - IKKE `PRODUCTION_VERIFIED`. D-165 sin kjernemekanisme-`PRODUCTION_VERIFIED` (freeze/unfreeze/kill-switch-parity, ovenfor) er UPÅVIRKET og forblir gyldig; dette er en presis nedgradering av KUN credential-revoke/restore-selvgjenopprettingsstien, ikke en tilbakekalling av D-165 sin host-kjøring. Se D-166 for full begrunnelse. | 96 nye/påvirkede tester grønne (empirisk kjørt, ikke bare typecheck): `modules/owner-controls/test/owner-control-authority.test.ts` (30 etter D-166: 22 fra D-164 + 8 nye B1-fiks-tester, ekte embedded Postgres - persistens over simulert restart, TO uavhengige `pg.Pool` ser samme tilstand LIVE, autorisasjon/klasse-D-semantikk/selvgjenopprettings-unntak inkl. B1-fiksens minimale handlings-nivå-mengde, ToolGateway-komposisjon/strict-skjema, "intet oppstartsvindu", audit uten secret-leak, RLS-N/A bevist, idempotency-dedupe, credential revoke/restore inkl. samtidig kill-switch-deadlock, executive-komposisjon - suite-bevist, IKKE host-bevist av K1-harnesset ennå), `k1-owner-control-authority-host-run-wiring.test.ts` (15, strukturell), `modules/executive/test/service-transport.test.ts` gruppe G (5 nye, komposisjon + situations-koeksistens). Regresjon empirisk bekreftet grønn etter D-166: policy/tool-gateway/situations/executive/apps-api/owner-controls (809 totalt) - null endring i utfall utover B1-fiksen selv. Full workspace-suiten (`pnpm -w test`, alle pakker inkl. urelaterte) treffer fortsatt den PRE-EKSISTERENDE, allerede dokumenterte embedded-Postgres B.3 port-kontensjon-flaken (uendret, IKKE K1-relatert, IKKE skjult av denne raden). **D-167 (host-rerun, 2026-09-18):** Tobias kjørte det D-166-utvidede harnesset på ekte host mot HEAD `ca167dba...` - B1 sin funksjonalitet var `PASS` (selvgjenoppretting, samtidig-deadlock-gjenoppretting, cleanup), men harnessets EGEN, sekundære audit-bevis-spørring (`ORDER BY audit_id DESC LIMIT 10`, satt før D-166 fantes) var ikke-deterministisk - 12 senere matchende `owner_controls`-kall fra I/J skjøv den opprinnelige aktiveringsraden utenfor vinduet (`k1_audit_evidence=FAIL`, `hard_fail=true`), IKKE en produksjonsfeil. Fikset med en run-avgrenset (`session_id`+vannmerke, ingen `LIMIT`) spørring i ny, delt `modules/owner-controls/src/audit-evidence.ts`; 32/32 tester i `owner-control-authority.test.ts` (2 nye, inkl. en direkte reproduksjon av den GAMLE buggen), 19/19 i host-run-wiring-testen (4 nye strukturelle). **D-168 (host-rerun PASS + merge, 2026-09-18):** det D-167-fiksede harnesset ER kjørt på nytt av Tobias på eksakt HEAD `9fcf1a3d3aa1b0d39f0311dc7be6f07150831a25` - ALLE markører PASS inkl. `k1_audit_evidence=PASS`, `hard_fail=false`, `owner_control_state` før/etter byte-identisk (`[]`/`[]`). Uavhengig arkitekt-review `5247323973` (RESULT=PASS, MERGE_AUTHORIZED=true) mot samme eksakte HEAD, deretter Tobias sin eksplisitte merge-closeout-ordre → PR #93 MERGET (`MERGE_SHA=22d391d248c3b99f2a3949b2606bfab2d7e7bcb3`, normal two-parent merge, verifisert via `git cat-file -p`), post-merge CI (run `35340723640`) grønn (`build-test`/`gitleaks`/`windows-git-auth` alle `success`). `HOST_ACCEPTANCE_REQUIRED=false` NÅ - B1-gjenopprettingsstien OG audit-beviset er `PRODUCTION_VERIFIED`, ikke lenger utestående. Se D-164/D-165/D-166/D-167/D-168. **D-171 PRESISERING (2026-09-18, arkitekt-re-review `5248461491`, IKKE en tilbakekalling av noe over):** `PRODUCTION_VERIFIED FOR HELE FLATEN` over gjelder kjernemekanismen KALT DIREKTE via `owner_controls.*` (kill switch/frys/tilbakekalling) - dette er FORTSATT sant og uendret. Det gjelder IKKE en påstand om at `executive.*` ("ett kontrollpanel") allerede videresender disse seks mutasjonene - det gjør det ikke (fersk kildekode-audit av `modules/executive/src/transport.ts`, D-171). Enhets-tilbakekalling (`SessionGrantService.revokeForDeviceOn`) mangler også helt som eier-vendt handling. **RETTET (D-172, arkitekt-re-review `5248756307`, IKKE en tilbakekalling av D-171 sine øvrige funn):** D-171 sin påstand om at "en domene-nivå finans-fryseprimitiv mangler helt" var selv unøyaktig - `finance.enable_kill_switch`/`disable_kill_switch`/`get_kill_switch` (`finance_kill_switch`, tenant-skopet, migrasjon 038, D-41-klasse D) EKSISTERER ALLEREDE og dekker Fiken-/Stripe-/Vipps-utbetalingsstier + Wallester-kort-spend-limit-mutasjoner (bekreftet i `modules/finance/src/service.ts` linje 738-770/1142/1643/1762/1839 og `card-service.ts` linje 147-149) - finansdomene er derfor SAMME eksponeringsgap-type som connector/provider/agent, IKKE en manglende primitiv. **RETTET IGJEN (D-173, arkitekt-re-review `5248894556`, BLOKKER B3, IKKE en tilbakekalling av D-172 sin hovedkorreksjon):** D-172 sin dekningsaudit selv hadde ETT hull - kall-for-kall-verifisering av `modules/finance/src/card-service.ts` viser at `CardService.activateCard()` (linje 314-315) kaller `lifecycleAction()` med et TOMT options-objekt (`killSwitchGated` er `undefined`) - `finance_kill_switch` sjekkes ALDRI før et kort aktiveres, mens `submitCard()`/`unfreezeCard()`/spend-limit-økninger ER korrekt gatet og `freezeCard()`/`closeCard()` er bevisst IKKE gatet (spend-reduserende, riktig). Dette er et REELT internt kode-hull (`FINANCE_UNCOVERED_MUTATIONS=finance_wallester.activate_card`), IKKE bare eksponering - må rettes (én manglende `{ killSwitchGated: true }`) SOM DEL av B2-implementasjonen, før finansdomenet eksponeres fra `executive.*`. Se D-171/D-172/D-173 i `DECISIONS_AND_ASSUMPTIONS.md` og `SOVEREIGN_GRADUATION_MATRIX.md` for full mål-for-mål-kartlegging og valgt neste slice ("Samlet eier-kontrolloverflate, mutasjonsfullføring, B2+B3", IKKE implementert i PR #94). **D-174 (2026-09-18, IMPLEMENTERT, IKKE lenger docs-only) - B2+B3 LUKKER kapittel-28 punkt 15 sitt eksponerings-/dekningsgap:** `CardService.activateCard()` fikset (`{ killSwitchGated: true }`); `gateway.ts`/`policy-gateway.ts` sin `OWNER_CONTROLS_SELF_RECOVERY_ACTIONS`-sjekk utvidet til også å gjelde `tool_id === "executive"` (uten dette ville `executive.deactivate_kill_switch`/`restore_credential` blitt blokkert av SIN EGEN ytre kill-switch-/credential-revoked-sjekk før den nådde det trygge, nøstede `owner_controls`-kallet - et nytt B1-lignende funn, se D-174); `executive.*` fikk ti nye videresendinger (`activate_kill_switch`/`deactivate_kill_switch`/`freeze_connector`/`unfreeze_connector`/`revoke_credential`/`restore_credential`/`revoke_device`/`enable_finance_kill_switch`/`disable_finance_kill_switch`/`get_finance_kill_switch`), ALLE tynne `gateway.execute()`-gjennomslag; ny `owner_controls.revoke_device` pakker inn `SessionGrantService.revokeForDeviceOn()` (eier-vendt, tidligere REELT GAP for mål 6). `HOST_ACCEPTANCE_REQUIRED=true` for DENNE utvidelsen (ny `modules/executive/scripts/d174-executive-control-surface-live.ts`+`-host-run.ts`, `HOST_ACCEPTANCE_STATUS=PENDING` - klar for Tobias, ikke kjørt mot ekte Docker/Postgres i implementasjonssesjonen). Se D-174 for full begrunnelse/testevidens. **D-175 (RETTET, arkitekt-review 5250409538, BLOKKER B4):** D-174 sin opprinnelige `revoke_device` tok et FRITT kaller-oppgitt `tenant_id`-parameter (feilaktig analogi til det tenant-frie `owner_control_state`) - det var et REELT cross-tenant-brudd mot RLS-scopet `session_grants`/`devices`. Nå UBETINGET bundet til `identity.tenant_id` (skjemaet har INGEN `tenant_id`-felt); enhet i en ANNEN tenant feiler LUKKET (`DeviceNotFoundError`, IKKE et stille `ok:true`/`revoked_grants:0`); eier kan fortsatt tilbakekalle en ANNEN PERSONS enhet i SAMME tenant. `HOST_ACCEPTANCE_STATUS` fortsatt `PENDING` - host-harnesset er oppdatert til å bevise dette via `executive.revoke_device`, men IKKE kjørt i denne sesjonen. **D-176 (RETTET, arkitekt-review 5251073737, BLOKKER B5):** `executive.get_control_surface_status` selv ble AVSLÅTT av NØYAKTIG den kill-switch-/tilbakekalt-credential-gaten den skulle la eieren SE FORBI - D-174/D-175 sin `tool_id === "executive"`-utvidelse antok feilaktig identiske handlingsnavn (`get_control_surface_status` ≠ `get_control_state`), OG de TO nøstede lesingene (`situations.get_pause_state`/`finance.get_kill_switch`) den komponerer var HELLER IKKE unntatt. Ny `isSelfRecoveryAction(toolId, action)` (owner-control-store.ts) erstatter unionen med en eksplisitt per-(tool_id,action)-mapping for alle fire tool_id-ene - fortsatt like smalt, INGEN mutasjon lagt til. `HOST_ACCEPTANCE_STATUS` fortsatt `PENDING` - ny seksjon 4b beviser dette, men IKKE kjørt i denne sesjonen. **D-177 (RETTET, arkitekt-review 5252077633, BLOKKER B6):** seksjon 4b sitt oppsett brukte en sekvensiell `executive.activate_kill_switch`+`executive.revoke_credential`-rekkefølge for å etablere "begge låser samtidig" - STRUKTURELT UMULIG (hver av dem nekter den andre via delt `BUSINESS_INTERNAL_CREDENTIAL_REF`), samme bug-klasse testsuiten allerede var rettet for i D-176 selv, men IKKE anvendt på host-scriptet før denne re-reviewen. Rettet til å sette BEGGE lås-tilstandene DIREKTE via det durable laget (`stack.killSwitch.activateDurable(...)`/`stack.ownerControls.revokeCredentialDurable(...)`), mens selve LESINGEN/gjenopprettingen under test fortsatt går via `executive.*`. `HOST_ACCEPTANCE_STATUS` fortsatt `PENDING`. **D-178 (RETTET, arkitekt-host-akseptanse-review 5252418219, BLOKKER B7):** FØRSTE EKTE Windows-host-kjøring (`run_id=d265a028`, mot HEAD `f32ffe92850cf46d9cf4922d4d47ee890b7c378f`) - `hard_fail=true`. Q-21 OG ALLE ANDRE markører (B4/B5/B6/D-176-seksjon-4b, negative kontroller, finans/Wallester-gating, cleanup) var PASS; KUN enhets-tilbakekallings-fikstur/-lesing (seksjon 9/10) feilet: `seedDeviceGrant()` gjorde tre rå `sidePool.query(...)`-innsettinger i `devices`/`sessions`/`session_grants` (FORCE ROW LEVEL SECURITY, migrasjon 053) UTEN tenant-kontekst, avslått av RLS under den ekte `jarvis_runtime`-rollen - selve `executive.revoke_device`-kallet under test ble ALDRI nådd (audit-FAIL er en direkte følge, ikke et selvstendig funn). SAMME mangel i seksjon 9 sin FØR-telling og seksjon 10 sin ferskinstans-lesing. Rettet: alle tre bruker nå den EKSISTERENDE `withTenantTransaction()`-hjelperen (`@jarvis/core`, ingen ny mekanisme); `adminPool` bevisst IKKE brukt for fikstur/lesing (kun CLEANUP, uendret); selve `executive.revoke_device`-kallet uendret. `INTERNAL_BUILD_COMPLETE` satt til `false` (RETTET fra `true`) til en FERSK host-kjøring beviser fiksen; `HOST_ACCEPTANCE_STATUS=REQUIRES_RERUN`. **D-179 (LIVE-BEVIST, arkitekt-host-akseptanse-review 5253069695, RESULT=PASS, mot eksakt HEAD `d8d91fd3a55787191c234b17ce4a4a240dcbae97`, 2026-09-18, docs-only closeout, INGEN produksjonskode endret):** Tobias kjørte det D-178-rettede harnesset PÅ NYTT, faktisk to ganger - begge PASS (`run_id=fc9b99e5` og den avsluttende `run_id=bfca277d`, BEGGE `hard_fail=false`). Full markørliste fra siste kjøring: Q-21 runtime-rolle PASS; global kill-switch-aktivering/-gjenoppretting PASS; delt-credential-gjenoppretting PASS; samtidig-lås-gjenoppretting PASS; samlet executive-statuslesing under begge låser PASS; negativ kontroll PASS; finans-kill-switch via executive PASS; Wallester `activate_card`-gating PASS; spend-reduserende freeze/close PASS; `executive.revoke_device` PASS (`grants_before=1`, `revoked_grants=1`, tenant bundet til `tenant-personal` - NØYAKTIG den handlingen `d265a028` aldri nådde); ferskinstans-holdbarhetslesing PASS; audit-bevis inkl. `revoke_device`-evidens og ingen secret-leak PASS; opprydding/`owner_control_state`-gjenoppretting PASS. Eksakt-HEAD CI (run `35394376138`) forble grønt. `HOST_ACCEPTANCE_STATUS=PASS` (RETTET fra `REQUIRES_RERUN`), `INTERNAL_BUILD_BLOCKERS=NONE`, `INTERNAL_BUILD_COMPLETE=true` (RETTET fra `false`). `SOVEREIGN_COMPLETE=false` FORBLIR UENDRET - `MERGE_AUTHORIZED=false` inntil en eksplisitt `ARCHITECT_TASK`-merge-ordre (issue #68). |

| UA-11 Executive dashboard-UI, lese-delen (D-199, direkte Tobias-chat-oppgave under D-192, "Begge, din prioriterte rekkefølge", 2026-09-19) | **FIXED_SUITE_VERIFIED for wiring-testen (kjørt og grønn lokalt); embedded-Postgres-e2e-suiten IKKE kjørt lokalt denne økten - INGEN HOST-AKSEPTANSE NØDVENDIG FOR DENNE SLICEN.** `POST /executive/query` (hardkodet lese-kun `EXECUTIVE_QUERY_ACTIONS`-allowlist) + `GET /dashboard` (`apps/web/dashboard.html`) bruker UTELUKKENDE ALLEREDE host-/CI-bevist infrastruktur - SAMME grant-autoritetsmodell som `/chat`/`/brief` (D-131, PRODUCTION_VERIFIED-nivå bevist der), SAMME `toolGateway`-instans/`executive.*`-namespace som UA-11 P0/K1 (allerede FIXED_SUITE_VERIFIED/PRODUCTION_VERIFIED). ZERO ny migrasjon, ZERO ny credential/leverandør, ZERO ny mutasjon eksponert (kun de to eksisterende lese-handlingene) - det finnes derfor INGEN ny leverandør-/host-spesifikk atferd for denne sliceen å bevise på Tobias sin Windows/Docker-host, identisk begrunnelse som UA-11 P0 sin `HOST_ACCEPTANCE_REQUIRED=false`. | `apps/api/src/server.ts` (`/executive/query`, `/dashboard`), `apps/api/src/main.ts` (`executive: { gateway: toolGateway }`), `apps/web/dashboard.html`. 16 nye tester: `apps/api/test/executive-query-e2e.test.ts` (10, ekte HTTP/Postgres/grant-autoritet - IKKE kjørt lokalt denne økten, samme `initdb: Permission denied`-sandbox-begrensning som D-193→D-198, verifiseres av CI), `apps/api/test/executive-query-wiring.test.ts` (6, DB-uavhengig strukturell regresjonsvakt - kjørt og bekreftet grønt lokalt, 6/6). `pnpm --filter @jarvis/api typecheck`/`npx eslint` rene. Se D-199 og `docs/UA11_EXECUTIVE_MODE_DESIGN.md` §7. |

**Regel:** Ingen gate settes til PRODUCTION_VERIFIED uten faktisk runtime-evidens (kommando + resultat + dato) logget her.

## FINAL INTEGRATION & CREDENTIALS PHASE — KANONISK SJEKKLISTE OVER UTSATTE LIVE-VERIFISERINGER (D-108)

**Policy (D-108, Tobias 2026-08-25): `EXTERNAL_CREDENTIAL_SETUP_POLICY=DEFER_UNTIL_FINAL_INTEGRATION_PHASE`.**
Integrasjoner bygges og suite-/host-verifiseres så langt det er mulig UTEN eksterne credentials; selve
credential-oppsettet + live-verifiseringen samles i én konsolidert fase nær slutten av masterplanen.
Denne listen er det KANONISKE stedet for alt som er BYGGET men ikke LIVE-verifisert - hver ny utsatt
integrasjon SKAL legges til her (aldri stille glemmes), og ingen rad her betyr noensinne at gaten er
bestått. Ikke-bygde integrasjoner står IKKE her (de bor i sine UA-/Q-backlogs til de faktisk bygges).

| Integrasjon | Implementasjonsstatus | Utsatt live-gate | Live-runner klar | Credential-krav (se .env.example) |
|---|---|---|---|---|
| Fiken (UA-6/D-107) | COMPLETE (domene+adapter+OAuth-bootstrap suite-verifisert; kanonisk domene host-verifisert) | `FIKEN_LIVE_GATE=PENDING_CREDENTIALS` (`provider_auth`/`provider_read`; `provider_write` krever i tillegg trygt test-selskap eller eksplisitt godkjenning - ingen sandbox finnes) | JA - `fiken-reauth.ts` (bootstrap) + `fiken-live-host-run.ts` (guardet akseptanse) | `JARVIS_FIKEN_CLIENT_ID`/`_CLIENT_SECRET`/`_REFRESH_TOKEN`/`_COMPANY_SLUG` |
| Google Ads (UA-4/D-83/D-86) | COMPLETE for lesing/rapportering (mutate eksplisitt utsatt bak UA-6) | `GOOGLE_ADS_LIVE_VERIFICATION=DEFERRED_TO_FINAL_INTEGRATION_PHASE` (D-86, syv-punkts backlog der) | JA - `google-ads-live-host-run.ts` | `JARVIS_GOOGLE_ADS_REFRESH_TOKEN`/`_DEVELOPER_TOKEN`/`_CUSTOMER_ID`(/`_LOGIN_CUSTOMER_ID`) |
| GitHub Developer Control Plane (UA-5/D-94) | COMPLETE (23-handlings D-41-matrise) | `LIVE_PROVIDER_VERIFIED=false` (Q-31 punkt 1) | JA - `ua5-github-live.ts` | `JARVIS_GITHUB_TOKEN` (`repo`+`workflow`-scope) |
| Stripe (UA-6/D-109) | COMPLETE (adapter+refusjon+webhook-ingestion+avstemming+ToolGateway+worker-sveip suite-verifisert; guardet no-credential host-akseptanse under bygging) | `STRIPE_LIVE_GATE=PENDING_CREDENTIALS` (`stripe_payment_execution`/`stripe_refund_execution`/`stripe_webhook_reachability` - alle krever en ekte Stripe-konto Tobias selv oppretter) | JA - guardet host-akseptansescript (se D-109-PR for eksakt filnavn) | `JARVIS_STRIPE_SECRET_KEY`/`_WEBHOOK_SECRET`/`_TENANT_ID` |
| Vipps MobilePay (UA-6/D-110) | COMPLETE + HOST-VERIFISERT (ePayment-adapter+capture/cancel+refusjon+webhook-ingestion+avstemming+ToolGateway+worker-sveip; guardet no-credential host-akseptanse `vipps-live-host-run.ts` BESTÅTT på Tobias sin ekte host 2026-08-26: `run_id=b5cd45bb`, alle 19 markører PASS, `hard_fail=false` - beviser produkt-wiring, IKKE live Vipps-reachability) | `VIPPS_LIVE_GATE=PENDING_CREDENTIALS` (`vipps_payment_execution`/`vipps_capture_execution`/`vipps_refund_execution`/`vipps_webhook_reachability` - alle krever en ekte Vipps MobilePay-selgerkonto (MSN) Tobias selv oppretter) | JA - `modules/finance/scripts/vipps-live-host-run.ts` | `JARVIS_VIPPS_CLIENT_ID`/`_CLIENT_SECRET`/`_SUBSCRIPTION_KEY`/`_MSN`/`_ENVIRONMENT`/`_WEBHOOK_SECRET`/`_TENANT_ID` |
| Neonomics Open Banking (UA-6/D-111) | COMPLETE + HOST-VERIFISERT (samtykke-livssyklus+kontodiscovery+saldo+transaksjoner+PIS-initiering+bank<->Finance-avstemming+bank-avvik+OpenLoop+ToolGateway+worker-sveip; guardet no-credential host-akseptanse `neonomics-live-host-run.ts` BESTÅTT på Tobias sin ekte host 2026-08-26: `run_id=6b99ca26`, alle 23 markører PASS, `hard_fail=false` - beviser produkt-wiring, IKKE live Neonomics-reachability) | `NEONOMICS_LIVE_GATE=PENDING_CREDENTIALS` (`neonomics_ais_reachability`/`neonomics_consent_sca_flow`/`neonomics_pis_execution`/`neonomics_webhook_reachability` - alle krever en ekte Neonomics-konto Tobias selv oppretter; `x-psu-id`-kontraktsdetaljen verifiseres samtidig) | JA - `modules/finance/scripts/neonomics-live-host-run.ts` | `JARVIS_NEONOMICS_CLIENT_ID`/`_CLIENT_SECRET`/`_DEVICE_ID`/`_ENVIRONMENT`/`_REALM`/`_WEBHOOK_API_KEY`/`_TENANT_ID`/`_SYNC_HOUR` |
| Wallester programmerbare kort (UA-6/D-112/D-113/D-114) | COMPLETE (kanonisk kortmodell+livssyklus+spend-kontroller+autorisasjon->oppgjør+transaksjonssynk+webhook-ingestion+kort<->Finance-avstemming+kortavvik+OpenLoop+ToolGateway+worker-sveip suite-verifisert; guardet no-credential host-akseptanse `wallester-live-host-run.ts` HOST-VERIFISERT av Tobias på eksakt HEAD `a5d8c5ae977b6526c7484eae4599f0bd2dd9e059` (`run_id=ab30dbcf`): alle 24 kjørbare markører PASS inkl. `wallester_business_auth_contract` og `wallester_secret_safety` (ekte fail-closed uten credentials), `hard_fail=false` - beviser produkt-wiring, IKKE live Wallester-reachability; auth-kontrakt korrigert TO ganger: D-113 rettet `sub`/`Bearer`-detaljer mot Wallester Card API (feil produkt); D-114 (`PRIMARY_SOURCE_EVIDENCE_MODE=OWNER_PROVIDED_PRIMARY_SOURCE_AUDIT`) erstattet HELE auth-/kort-/grense-/paginerings-/saldo-/webhook-kontrakten med Wallester BUSINESS sin egen (api_key/ts/RS256/Bearer, PATCH-livssyklus, separate limits/security-endepunkter, from_record-paginering, konto-basert saldo, event/type-webhook-skille) - Card API-modellen (D-112/D-113) beskrev feil produkt. `BUSINESS_AUTH_SIGNING_MATERIAL=PRIMARY_SOURCE_PUBLIC_DOC_GAP`: signeringsnøkkel-provisjonering løst via injiserbar `WallesterBusinessJwtSigner`, ALDRI gjettet. Fail-safe utvidet: ukjent status/type lagres `"unknown"` (ALDRI stille "approved"/"purchase"); fysisk (ChipAndPin) kort er FAIL-CLOSED (ingen embossing-/utleveringsfelt samlet inn). Sanntidsautorisasjon reklassifisert D-113→D-114: `UNVERIFIED_PRODUCT_ENTITLEMENT` → `NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API` (Business har ingen synkron decision-request; den kapabiliteten tilhører det ikke-valgte Card API-produktet)) | `WALLESTER_LIVE_GATE=PENDING_CREDENTIALS` (`wallester_api_reachability`/`wallester_card_issuing`/`wallester_limits_live`/`wallester_webhook_reachability`/produksjons-signeringsnøkkel-provisjonering - alle krever en ekte Wallester Business-konto m/ API-tilgang Tobias selv oppretter) | JA - `modules/finance/scripts/wallester-live-host-run.ts` | `JARVIS_WALLESTER_API_BASE_URL`/`_API_KEY`/`_ACCOUNT_ID`/`_PRIVATE_KEY_PEM`/`_ENVIRONMENT`/`_WEBHOOK_BASIC_USER`/`_WEBHOOK_BASIC_PASSWORD`/`_TENANT_ID`/`_SYNC_HOUR` |

**Fremtidige kapabilitetspunkter bevart under Universal Tool & Connector Layer (D-108 §Tools/Skills/MCP - IKKE bygget, IKKE utsatt-live, kun backlog-registrert så de ikke forsvinner):** (1) videre ToolGateway-/connector-utvidelse per masterplanens «Universal Tool & Connector Layer»; (2) MCP-server-tilkobling - governance finnes allerede (CLAUDE.md regel 7, INTEGRATIONS.md §4: ubetrodd inntil verifisert, aldri utenom ToolGateway/Policy Gateway/tenant-isolasjon/A-D-klassifisering), byggefase ikke definert i masterplanen og krever egen D-64/D-41-port når den bestilles; (3) «Skills»-lag - ingen masterplan-forekomst funnet; krever eksplisitt Tobias-definisjon/-bestilling før noe bygges.

## D-107 HOST-FIX #2 — AGGREGERINGS-SPLITT: JARVIS_CANONICAL-domene vs. Fiken-leverandør (2026-08-24)
- **Host-evidens (Tobias, head `a5f3d1a` - tre-identisk med host-fix #1-headen `4bb62cd`, mellomcommiten er en TOM CI-retrigger):** alle åtte credential-uavhengige gater PASS live (`q21_runtime_role_safe` + `finance_live_db_idempotency`/`_validation`/`_kill_switch`/`_state_machine`/`_reconciliation`/`_tenant_isolation` + `finance_live_cleanup`), provider-markørene ærlig NOT_RUN (credentials fraværende). **`CANONICAL_DB_GATES_LIVE_PASS=true`.** MEN runneren rapporterte selvmotsigende `JARVIS_CANONICAL_DOMAIN_VERIFIED=false`/`hard_fail=true` samtidig som den logget at domenet var "FULLT ut bevist" - `FINAL_HOST_ACCEPTANCE_VALID=false` inntil re-kjøring på rettet head.
- **Root cause (aggregeringsdefekt i `fiken-live-lib.ts`, IKKE i domenet):** `finance_live_env_safe` (=`BLOCKED_NO_CREDENTIALS` uten credentials) og `finance_live_secret_safety` (=`NO_DATA` uten secrets å sjekke) lå i SAMME hard-krav-sett som domenegatene, og `JARVIS_CANONICAL_DOMAIN_VERIFIED` ble avledet som `!hard_fail` - manglende credentials tvang dermed hele kjøringen til feil, i strid med bibliotekets egen dokumenterte intensjon OG google-ads-presedensen (`computeHardFail` der returnerer eksplisitt `false` uten credentials).
- **Fiks:** to adskilte, aldri koblede beregninger - `computeCanonicalDomainVerified()` (KUN de åtte credential-uavhengige gatene) og `computeFikenLiveVerified()` (credentials + ekte auth + ekte lesing); `computeHardFail()` = Q-21-regresjon ELLER domenegate-feil ELLER faktisk secret-lekkasje ELLER (KUN når credentials ER konfigurert) provider-FAIL. Runneren printer nå begge flaggene + `PROVIDER_LIVE_BLOCKED_NO_CREDENTIALS` eksplisitt. 30 lib-tester (opp fra 11) låser semantikken, inkl. den eksakte a5f3d1a-regresjonen.
- **Terminalflagg:** `CANONICAL_DB_GATES_LIVE_PASS=true`, `FINAL_HOST_ACCEPTANCE_VALID=false`, `HOST_REACCEPTANCE_REQUIRED=true`, `JARVIS_CANONICAL_DOMAIN_VERIFIED=false` (inntil re-kjøring), `FIKEN_LIVE_VERIFIED=false`.

## D-107 — UA-6 FINANCE & SPEND INTEGRITY GATEWAY, FØRSTE SLICE: SUITE-VERIFIED (2026-08-24, IKKE host-verifisert ennå)
- **HOST-FIX #1 (2026-08-24, etter Tobias sin første ekte host-kjøring mot head `748ecd0`):** fire credential-uavhengige
  kanonisk-domene-sjekker feilet med `*_did_not_return_external_id`. To lagvise root causes funnet og rettet i samme PR:
  (1) host-scriptet brukte en bar `EnvSecretProvider` i stedet for produksjonens `FallbackSecretProvider(env,
  BusinessInternalSecretProvider)` → `credential_unavailable`-DENY for hvert internt finance-kall (D-49-sentinelen
  `JARVIS_BUSINESS_INTERNAL_TOKEN` er ALDRI i .env); (2) EKTE produksjonsdefekt i `FinanceTransport`:
  `Number(requireString(parameters, "amount_ore"))` for en `z.number()`-parameter kastet
  `finance_missing_parameter:amount_ore` for HVERT ekte ToolGateway-kall (+ samme latente feilklasse i `matched`-
  håndteringen rettet). 10 nye regresjonstester (`toolgateway-live-wiring.test.ts`) reproduserer den eksakte
  host-feilen og beviser hele finance.*-kontrakten (`{ok:true, external_id: payment_intent_id, data}`) gjennom
  EKTE ToolGateway med produksjons-secret-sammensetning. Full detalj: D-107 HOST-FIX #1 i DECISIONS_AND_ASSUMPTIONS.md.
- **Kommando (host, re-kjøres av Tobias etter grønn CI):** `node --env-file=.env --experimental-transform-types modules/finance/scripts/fiken-live-host-run.ts`
- **Bevist i denne økten (embedded Postgres, ekte ToolGateway-kjede, ingen Fiken-nettverkskall):** idempotent opprettelse (samme `idempotency_key` → nøyaktig én DB-rad, samme `external_id`), deterministisk validering (ugyldig beløp/valuta/kontokode/motkontokode avvist FØR noe forsøk), anomali-flagging ved opprettelse (manglende leverandørreferanse/motkonto flagges, blokkerer ikke draft), fail-closed innsendingsrekkefølge (manglende leverandørreferanse/motkonto/ukjent id/manglende credentials kastes ALLE FØR noe Fiken-kall), finans-nødbryter (aktivert blokkerer innsending, tilstand forblir `draft`, `kill_switch_blocked`-hendelse persisterer, `get_kill_switch` reflekterer tilstand), full innsendingsflyt (poster til Fiken nøyaktig én gang, korrekte kontolinjer verifisert), idempotent gjentatt innsending (null nye Fiken-kall ved allerede innsendt), terminal-tilstand-gjeninnsending kastes, avstemming (matched/mismatched + hendelse), tenant-isolasjon (TENANT_B ser aldri TENANT_A sine intents/kill-switch), open-loop-integrasjon (anomali/avstemmingsavvik → open loop, auto-resolve ved retting).
- **IKKE bevist i denne økten (avventer host):** ekte Fiken OAuth2-token-utveksling, ekte `listCompanies()`-reachability, faktisk `POST /companies/{slug}/generalJournalEntries` mot Tobias sin virkelige Fiken-konto.
- **Terminalflagg:** `FIXED_SUITE_VERIFIED=true`, `LIVE_VERIFIED=false`, `UA6_STARTED=true`, `UA6_COMPLETE=false`.

## D-107 — UA-6 FINANCE & SPEND INTEGRITY GATEWAY, ANDRE SLICE (Slice 2): SUITE-VERIFIED + HOST-VERIFIED (2026-08-25)
- **Omfang:** intern utgifts-synk (marketing_spend_events/cost_events -> `finance_spend_records`), abonnements-/
  gjentakende forpliktelsesregister, anskaffelses-/forventet-utgifts-register, deterministisk avviksdeteksjon (alle
  7 typer: `DUPLICATE_SOURCE_SPEND`/`UNEXPECTED_SPEND`/`AMOUNT_DEVIATION`/`MISSING_EXPECTED_SPEND`/
  `DUPLICATE_RECURRING_CHARGE`/`CURRENCY_MISMATCH`/`SOURCE_CORRECTION_CONFLICT`), avstemming/matching (ambiguity-
  safe), OpenLoop-surfacing (fem nye loop_type-verdier). ZERO ny ekstern leverandør, ZERO nye credentials
  (D-108 uendret) - HELE sliceen mot to ALLEREDE eksisterende interne kilder.
- **§2-designvalg (INGEN ny D-beslutning - byggeordrens egen tillatelse):** dedikert `finance_spend_records`-tabell
  fremfor gjenbruk av `payment_intents` - se `039_finance_spend_integrity.sql` sin toppkommentar for full
  begrunnelse.
- **Kommando (host, kjørt av Tobias):** `node --env-file=.env --experimental-transform-types modules/finance/scripts/spend-integrity-live-host-run.ts`
- **Suite-bevist i implementasjonsøkten (embedded Postgres-harness, IKKE Docker):** alle 12 markører i
  `spend-integrity-live.ts` PASS - `finance_d107_invariant_preserved` (D-107 FØRSTE-slice-idempotens UENDRET),
  `finance_internal_spend_marketing_sync`, `finance_internal_spend_model_cost_sync`,
  `finance_internal_spend_idempotency`, `finance_subscription_registry`, `finance_procurement_registry`,
  `finance_spend_anomaly_detection`, `finance_spend_reconciliation`, `finance_spend_openloop`,
  `finance_spend_tenant_isolation`, `finance_spend_cleanup`. Full test-matrise (50 nye tester på tvers av
  `spend-service.test.ts`/`open-loop-finance-spend.test.ts`/`finance-spend-erasure.test.ts`/
  `spend-transport-wiring.test.ts`) + FULL eksisterende regresjonssuite (165 filer/2550 tester) grønn.
- **HOST-BEVIST (2026-08-25, Tobias, ekte `docker compose`-basert kjøring mot PR #58 sin faktiske kode - verifisert
  eksakt commit-SHA-match `d324f49c6bebe3ce75f2b3e846b9f1e74447fb41` FØR noe kjørte, fail-closed ellers,
  `git status --porcelain` bekreftet rent FØR kjøring):** `run_id=05e33a86`. Ferske `migrate`/`api`/`worker`-images
  bygget fra denne commiten, migrasjoner kjørt via admin-rollen, `spend-integrity-live.ts` kjørt mot den ekte
  containeriserte stacken. **Alle 12 markører PASS**, `hard_fail=false`, `runtime_current_user=jarvis_runtime`
  (NOSUPERUSER/NOBYPASSRLS uendret) - identisk sett som suite-kjøringen over, nå bevist mot ekte Docker-Postgres i
  stedet for embedded-postgres-substituttet. `finance_d107_invariant_preserved=PASS` bekrefter D-107 FØRSTE-slice
  sin idempotens-invariant fortsatt holder UENDRET etter denne sliceen, live. ZERO Fiken/Google Ads-credentials
  involvert (D-108 uendret - denne sliceen krever ingen). **`UA6_SLICE2_HOST_VERIFIED=true`,
  `UA6_SLICE2_STATUS=CANONICAL/HOST_VERIFIED/COMPLETE`, `UA6_COMPLETE=false` uendret** (kun to sliceer av UA-6;
  bank/Stripe/Vipps P1 og kort/wallet P2 fortsatt ikke startet). Full kvalitetsport re-verifisert PÅ denne eksakte
  host-testede SHA-en rett før dette closeout-punktet: `pnpm -w typecheck` 20/20 pakker rent, `pnpm -w lint` rent,
  full suite 165/166 filer/2547/2556 tester grønt (ett fil-nivå-flake i en UBERØRT, ikke-relatert testfil bekreftet
  ved isolert re-kjøring - 9/9 grønt alene, samme flake-klasse som CI sine tre re-kjøringer under denne PR-en, se
  under).
- **Tre reelle defekter funnet og rettet av ekte Postgres-integrasjonstester (IKKE antatt riktig ved skriving):**
  (1) `timestamptz`-cursor-presisjonstap (uendelig re-synk-sløyfe, rettet med `date_trunc('milliseconds', ...)`);
  (2) `matchAndReconcile()` sin opprinnelige per-forpliktelse-løkke kunne stille koble utgift til FEIL forpliktelse
  ved flere kandidater - erstattet med ambiguity-safe CTE; (3) erasure-planens nye finans-utgifts-blokk var
  opprinnelig plassert ETTER `marketing_campaigns`-slettingen til tross for en NY FK som krever motsatt rekkefølge
  - fanget av `growth-erasure.test.ts` sin schema-drevne FK-audit.
- **IKKE bevist i denne økten (avventer host):** ekte docker-compose-full-stack-kjøring (migrate/api/worker-images),
  ekte Windows-host-miljø.
- **Terminalflagg:** `FIXED_SUITE_VERIFIED=true`, `LIVE_VERIFIED=false` (avventer Tobias sin host-kjøring),
  `UA6_FIRST_SLICE_COMPLETE=true`, `UA6_SLICE2_IMPLEMENTATION_COMPLETE=true`, `UA6_COMPLETE=false`.

## D-41 — GOOGLE DRIVE FULL READ/WRITE SCOPE-ENDRING: SUITE-VERIFIED (2026-08-16, IKKE host-verifisert ennå, samme dag som P1A-bygget under)

**Eier-beslutning FØR PR #5 merges** (se D-41 i DECISIONS_AND_ASSUMPTIONS.md, rule 11 i CLAUDE.md):
Jarvis skal IKKE være begrenset til read-only Google Drive - produksjon skal ha FULL funksjonell
tilgang, styrt av det EKSISTERENDE A-D policy-risikoklassesystemet (ingen ny permission-modell).
Permanent arkitekturregel innført samtidig for ALLE fremtidige connectors.

- **`GoogleDriveTransport`** (`modules/tool-gateway/src/live-transports.ts`) utvidet fra 2
  (`list_files`/`read_document`) til 12 handlinger: `get_metadata`/`read_permissions` (klasse A),
  `create_file`/`create_folder`/`update_content`/`rename`/`move`/`trash` (klasse C - reversible),
  `delete_permanent`/`create_permission`/`update_permission`/`delete_permission` (klasse D -
  irreversible/sikkerhetskritiske).
- **OAuth-scope for produksjon bekreftet mot Google sitt offisielle Drive API v3-discovery-dokument
  (IKKE gjettet):** `https://www.googleapis.com/auth/drive` (full read/write) - `drive.file` dekker
  KUN app-opprettede filer, utilstrekkelig for faktisk full tilgang. `files.delete` bekreftet PERMANENT
  (flytter ikke til papirkurv); trashing er en separat, reversibel `files.update` med `trashed: true`.
  `headRevisionId`/`modifiedTime` finnes på File-ressursen for optimistic concurrency (Drive har INGEN
  native If-Match-precondition-header).
- **Konflikthåndtering:** `update_content`/`rename`/`move`/`trash` godtar en valgfri
  `expected_head_revision_id` - ved mismatch kastes `drive_conflict_stale_version` FØR noen mutasjon
  forsøkes, aldri en stille overskriving av en nyere endring.
- **Policy uendret, kun anvendt på nye handlinger:** D-klasse-handlinger fikk `preflight_action` (samme
  eksisterende ToolGateway-evidensmekanisme Home Assistant sin `lock_set`/`alarm_set` alt brukte).
  Owner sovereign-modus autonomt for klasse D (ingen ny approval-friksjon for eier); delegert identitet
  krever fortsatt signert Ed25519-godkjenning (uendret `PolicyGateway`-logikk, bevist for Drive spesifikt
  i `drive-full-access.test.ts` §G/§I).
- **Idempotens:** skriveoperasjoner bruker EKSISTERENDE ToolGateway `idempotency_key`-dedupe. Bevist
  kritisk for `create_permission` spesielt - Drive sin egen `permissions.create` dedupliserer IKKE
  identiske tilganger selv, så ToolGateway-nivået er den faktiske håndhevingsmekanismen.
- **Q-20-distinksjon (§5):** `drive/trash` rører ALDRI `knowledge_documents`; en Q-20-hard-delete av et
  `knowledge_document` kaller ALDRI ut til Drive. Arkitektonisk uavhengige operasjoner, bevist begge veier.
- **Ingestion-siden uendret:** `GoogleDriveKnowledgeSource` (sync-kilden) er og forblir READ ONLY mot
  Drive by design (en sync-kilde skal aldri mutere det den leser fra) - dette er en egenskap ved
  ingestion-arkitekturen, ikke en begrensning på Drive-VERKTØYET.
- **Tester:** 27 nye - `drive-full-access.test.ts` (17, ekte ToolGateway+embedded Postgres+FakeTransport:
  create/update/rename/move/trash, sovereign/delegert D-klasse-bevis, idempotens, Q-20-distinksjon,
  Q-21 tenant-isolasjon av dedupe, ingen token/innhold i audit) + `google-drive-transport.test.ts` (10,
  DET ENESTE stedet i repoet `fetch` mockes - bevisst, avgrenset unntak fra "raw HTTP-transportere
  unit-testes aldri, kun live-verifisert"-presedensen, fordi byggeordren eksplisitt krevde deterministisk
  bevis for konflikt-/statuskode-håndtering: `drive_conflict_stale_version`, 401/403/429/404/500-
  klassifisering, idempotent 404-håndtering på permanent sletting).
- **Live-akseptanse utvidet** (`modules/knowledge/scripts/ua2-p1a-live.ts` §6): ekte
  create/read/update/rename/move/trash/cleanup/sync/no-resurrection/idempotency mot
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` (dedikert, trygg test-mappe - ALDRI hele driven). Rapporterer
  `google_drive_live=BLOCKED_REAUTH_REQUIRED` (IKKE en fake PASS) hvis eksisterende
  `JARVIS_GOOGLE_TOKEN` mangler write-scope (lesing fungerer, skriving feiler på auth). Permission-
  mutasjon BEVISST IKKE live-testet - kan ikke gjøres trygt uten å involvere en ekte person/endre ekte
  eksponering; policy for det er suite-bevist.
- **Engangs connector-capability-audit** (D-41 krever dette, IKKE en utvidelse av alle nå):
  GitHub/Google Calendar/Gmail/Telegram/Vercel/Home Assistant klassifisert PARTIAL eller READ_ONLY med
  konkrete gap dokumentert som backlog - se tabellen i docs/PROJECT_STATUS.md. Google Drive er nå
  eneste **FULL**-klassifiserte connector.
- **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED** - samme host-kjøring
  (`ua2-p1a-host-run.ts`) som resten av P1A beviser dette; ingen egen host-kommando.

## UA-2 P1A — KNOWLEDGE SOURCE EXPANSION: SUITE-VERIFIED (2026-08-16, IKKE host-verifisert ennå)

*(Historisk byggeordre, som opprinnelig utstedt. Se D-41-seksjonen OVER for scope-endringen som fulgte
samme dag - Drive-VERKTØYET har siden full read/write; INGESTION-kilden `GoogleDriveKnowledgeSource`
beskrevet under er fortsatt READ ONLY, uendret, by design.)*

**Byggeordre** (etter Q-20 VERIFIED/CLOSED-merge til `main`, commit `2dbc3a5`): utvid
`@jarvis/knowledge` med Google Drive (opprinnelig READ ONLY, senere samme dag utvidet - se over) og
Obsidian/lokal vault som nye kunnskapskilder på
den EKSISTERENDE `KnowledgeSource`/`KnowledgeSyncService`/FTS+vector-hybrid-arkitekturen fra UA-2 P0 -
ingen parallell connector-SDK, ingen ny auth-modell, ingen ny DB-migrasjon. Pieces eksplisitt utsatt
(se Q-22 i OPEN_QUESTIONS.md - ingen konkret integrasjonsflate funnet i repoet). IKKE bygget:
e-post-ingestion, møtetranskripsjon, OCR, full Knowledge Graph/GraphRAG, Drive write/delete.

- **Kontrakt-utvidelse** (`modules/knowledge/src/source.ts`): `KnowledgeSource.list()` returnerer
  `KnowledgeListResult { records, skipped }` (var en bar array). Ny `SourceErrorClass`/
  `KnowledgeSourceError` for TOTAL listing-svikt (AUTH/PERMISSION/RATE_LIMIT/TRANSIENT_NETWORK/
  NOT_FOUND/UNSUPPORTED_CONTENT/INVALID_CONFIG/SOURCE_UNAVAILABLE) - `KnowledgeSyncService.sync()`
  tombstoner ALDRI noe når `list()` kaster, uansett klasse (uendret kritisk sikkerhetsegenskap).
  Fikset samtidig en latent bug i `GithubKnowledgeSource`: en feilet ToolGateway-handling ble
  tidligere stille utelatt fra resultatet i stedet for å kaste - kunne fått en forbigående feil
  feiltolket som "alle issues slettet" av tombstone-logikken.
- **`KnowledgeSourceRegistry`** (`registry.ts`): typet, FLERE-instans konfigurasjon bundet til
  (tenant_id, memory_space_id, source_instance_id) - `forTenant()` filtrerer strukturelt, kan aldri
  returnere en annen tenants konfig; ingen implisitt/global kilde.
- **`GoogleDriveTransport`** (`modules/tool-gateway/src/live-transports.ts`): READ ONLY, samme
  OAuth/konto-mønster som Gmail/Calendar (`googleAccessToken()` gjenbrukt uendret). `list_files`
  (paginert, `folder_id` alltid eksplisitt fra kilden - aldri en default her) + `read_document`
  (Google Docs → text/plain-eksport; tekstlige MIME-typer leses rått; Sheets/Slides/bilder/PDF/
  binærformater kaster en typet `drive_unsupported_content_<mime>`-feil).
- **`GoogleDriveKnowledgeSource`** (`drive-source.ts`): `external_id` = Drive sin stabile `file.id`
  (rename-safe by construction). Mappe-scope rekursiv, men henter ALDRI utenfor den konfigurerte
  mappen; whole-drive-scope må velges eksplisitt. Paginering+rekursjon aggregeres INNENFOR `list()`
  (komplett eller kast, aldri partielt). Sletting gjenbruker eksisterende "fraværende i vellykket
  listing = tombstone" (ingen egen Drive Changes-API - bevisst, dokumentert). En AUTH/PERMISSION-feil
  på ÉN fil-lesing eskaleres til TOTAL svikt (antatt systemisk årsak - f.eks. tilbakekalt token);
  NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på én fil er en trygg per-fil-skip (beskyttet mot
  tombstoning, prøves igjen neste sync).
- **`ObsidianVaultKnowledgeSource`** (`obsidian-source.ts`): KOMPONERER rundt
  `FilesystemKnowledgeSource` (samme allowlist/traversal/symlink-forsvar som UA-2 P0, ALDRI
  arv/duplisering av sikkerhetslogikken) - kun `.md`, `.obsidian/` ekskludert som default.
  Frontmatter parses best-effort (flat nøkkel/verdi, IKKE en generell YAML-parser - ingen ny
  avhengighet) til `metadata.frontmatter`; `content` beholder HELE filen uendret. Wiki-lenker
  (`[[Notat]]`) til `metadata.wiki_links` (flat liste per dokument - IKKE en graf/GraphRAG, bevisst
  utenfor P1A). `external_id` = relativ vault-sti (samme presedens som filesystem) - Obsidian-
  omdøpning er derfor slett+ny, IKKE en oppdatering (dokumentert, bevisst forskjell fra Drive).
- **To korrekthetsfiks i `KnowledgeSyncService.sync()`** (gjelder ALLE kilder): (1) elementer i
  `skipped` beskyttes nå mot tombstoning sammen med `seen` external_ids - én forbigående per-element-
  feil kunne tidligere feilaktig tombstonet nettopp DET elementet selv om resten av listingen lyktes;
  (2) "uendret innhold"-grenen oppdaterer nå tittel/uri/modified_at/metadata (fortsatt INGEN
  re-embedding) - nødvendig for at en Drive-omdøpning faktisk skal synes ved neste sync.
- **Chunking-safeguard** (`sync.ts`, bevisst MINIMAL - ingen ekte multi-chunk-skjema/-rader):
  `embed()`-input trunkeres til 24 000 tegn; `content`-kolonnen (og dermed FTS, generert derfra)
  beholder ALLTID hele, utrunkerte teksten. Ingen embedding-leverandør i kodebasen (inkl.
  `OpenAiEmbedding`) hadde noen input-grense før dette - Drive/Obsidian-dokumenter kan bli langt
  større enn P0 sine korte GitHub-issues/notater, og ville uten dette enten kastet en API-feil (ekte
  leverandør med token-tak) eller stille kastet bort tokens/latens på irrelevant hale-innhold.
- **Ett-kommando host-akseptanse:** `modules/core/scripts/ua2-p1a-host-run.ts` (samme
  pnpm/Windows/Docker-bootstrap-mønster som `q20-host-run.ts` - INGEN ny pnpm-workspace-pakke denne
  gangen, derfor ingen egen verify-workspace-steg) → kjører til slutt
  `modules/knowledge/scripts/ua2-p1a-live.ts`: Q-21-rolle-sjekk (fail-closed), registry-sanity,
  Obsidian full livssyklus i en ISOLERT MIDLERTIDIG vault (mkdtemp under OS-temp - ALDRI Tobias sin
  ekte vault), tenant-isolasjon+retrieval bevist DIREKTE med de nye kildetypene (ikke bare antatt fra
  filesystem/GitHub), no-content-i-audit-scan (OAuth-token og dokumentinnhold scannet mot
  `audit_events`/`knowledge_documents.metadata` etter en Drive-sync). Google Drive LIVE er BETINGET:
  krever `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` OG en NY, dedikert
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` (aldri hele driven, aldri skriving/sletting mot ekte
  Drive-data) - mangler noen av de fire rapporteres `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE`,
  ALDRI en fake PASS.
- **Kvalitet:** 463/463 tester (406 baseline + 57 nye: registry x9, Drive-source x11, Obsidian-source
  x9, kryssgående tenant/space/retrieval/audit-redaksjon x5, chunking-safeguard x2, host-run-wiring
  x21), full monorepo-typecheck ren.
- **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED.** Ingen ekte Google Drive-credential,
  ingen ekte Docker-Postgres i denne sky-sandboxen. Krever Tobias sin host-kjøring
  (`node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts`) før VERIFIED kan
  settes - akkurat som Q-20/UA-2 P0 krevde det. Draft PR opprettet, IKKE merget.

## Q-20 FINAL CLOSURE: HOST VERIFIED (2026-08-16, run_id `eaabe2b1`)

**Tobias kjørte `node --experimental-transform-types modules/core/scripts/q20-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, hele kjeden i én kommando.**

### Bootstrap

```
package_manager_resolution=PASS
package_manager_driver=pnpm.cmd
package_manager_version=9.15.9

install_frozen_lockfile=PASS
workspace_install=PASS
erasure_workspace_dependencies=PASS
```

### Ferske images + migrasjon (Q-21 uendret)

`migrate`/`api`/`worker` bygget fra gjeldende checkout. `migrate_effective_db_user=postgres`,
migrasjonene (inkl. `018_erasure.sql`) anvendt. `q21_runtime_role_safe=PASS`,
`runtime_current_user=jarvis_runtime`, `runtime_role_superuser=false`, `runtime_role_bypassrls=false` -
Q-21 sin admin/runtime-splitt fortsatt intakt, ikke regresert av Q-20.

### Q-20-akseptanse (alle 21 trinn fra byggeordren)

```
q20_preview=PASS            q20_hard_delete=PASS        q20_derived_delete=PASS
q20_fts_erasure=PASS        q20_vector_erasure=PASS     q20_hybrid_erasure=PASS
q20_memory_erasure=PASS     q20_no_resurrection=PASS    q20_idempotency=PASS
q20_tenant_isolation=PASS   q20_space_isolation=PASS    q20_receipt_safe=PASS
q20_sentinel_scan=PASS

run_id=eaabe2b1
hard_fail=false
```

Resync-bevis (resurrection protection): `created=0`, `suppressed=1` - det slettede dokumentet kom
IKKE tilbake ved neste source-sync, selv om kildefilen fortsatt fantes på disk.

Retrieval etter purge (alle fire lag separat bevist 0 treff): `fts_hits=0`, `vector_hits=0`,
`hybrid_hits=0`, `memory_hits=0`.

Bevist på EKTE (ikke embedded) Postgres/pgvector, ekte Docker, ekte Windows-host - dette er den
FAKTISKE produksjonsmiljø-verifikasjonen, ikke bare suite-/byggemiljø-bevis.

### Reisen til dette punktet (tre host-recovery-runder, samme dag - se seksjonene under for full detalj)

1. **Runde 1 (workspace-bootstrap):** ny `modules/erasure`-workspace-pakke aldri bootstrappet på
   hosten (`ERR_MODULE_NOT_FOUND: @jarvis/core`) - fikset med ett-kommando-runner
   `modules/core/scripts/q20-host-run.ts`.
2. **Runde 2 (Windows pnpm-prosessoppløsning):** `spawnSync pnpm ENOENT` - Node gjør ikke Windows sin
   PATHEXT-oppløsning uten shell-involvering - fikset med eksplisitt `pnpm`/`pnpm.cmd`→
   `corepack`-oppløsning (`lib/package-manager-resolve.ts`).
3. **Runde 3 (DEP0190-opprydding, FØR merge):** runde 2 sin fiks brukte `shell: true` + args-array,
   som Node flagger som en kjent injeksjonsrisiko (`DEP0190`). Erstattet PERMANENT med en eksplisitt,
   ikke-shell cmd.exe-barneprosess (`buildSpawnInvocation()` - `/d /s /c <sti> <args>`, samme mønster
   som `cross-spawn`-biblioteket bruker for nøyaktig dette Windows-problemet).

**Ingen av de tre rundene endret erasure-, migrasjons-, DB-rolle-, retrieval-, suppresjons- eller
policy-logikken** - kun host-bootstrap/prosess-spawning-hygiene. Q-20 sin featuresemantikk var allerede
uendret gjennom alle tre rundene; selve host-akseptansen (over) er det som beviser den reelt.

### Fortsatt eksplisitt dokumenterte, IKKE purgede stores (uendret fra suite-lukkingen)

`events`/`audit_events`-payload (strukturelt append-only-blokkert, gjelder alle roller inkl.
superbruker); `tasks`/`tool_executions`-innhold (ingen stabil kobling til en scope-id); Langfuse/lokal
trace-fil (ingen purge-integrasjon bygget); `person`-scope dekker ikke knowledge-dokumenter (mangler
person-kolonne i skjema). Se docs/DATA_ERASURE.md §2/§10 for full begrunnelse.

**Status: Q-20 = VERIFIED/CLOSED (D-40).** Teknisk data-erasure-foundation - IKKE en juridisk
GDPR-compliance-sertifisering. PR #4 klargjøres for merge til `main`.

## Q-20 HOST RECOVERY #2: WINDOWS PNPM-PROSESSOPPLØSNING (2026-08-16, samme dag)

**Host-feil:** Tobias kjørte den nye ett-kommando-runneren fra host-runde 1
(`node --experimental-transform-types modules/core/scripts/q20-host-run.ts`). Runneren startet korrekt
(`repo_root=PASS`, `host_node_version=v24.11.1`), men feilet umiddelbart på selve
`pnpm install --frozen-lockfile`-steget med `spawnSync pnpm ENOENT` - til tross for at `pnpm` fungerer
helt fint fra Tobias sin egen PowerShell.

**Root cause:** Node sin `child_process.execFileSync`/`spawnSync` UTEN `shell: true` gjør IKKE Windows
sin PATHEXT-baserte utvidelsesoppløsning (`.COM`/`.EXE`/`.BAT`/`.CMD`) - kun en ekte shell (cmd.exe/
PowerShell) gjør det. `pnpm` er normalt installert som `pnpm.cmd` (eller et Corepack-shim) på Windows -
et rått `execFileSync("pnpm", ...)`-kall feiler derfor alltid med `ENOENT`, uavhengig av at `pnpm`
fungerer interaktivt. Dette er en Windows-spesifikk prosess-spawning-detalj, IKKE et Q-20-funn - ingen
erasure-semantikk endret.

**Fiks:** ny, ren, testbar `modules/core/scripts/lib/package-manager-resolve.ts` - INGEN imports (må
virke FØR `pnpm install`), deterministisk oppløsningsrekkefølge: (1) finn `pnpm`/`pnpm.cmd` direkte på
PATH (skanner hver PATHEXT-utvidelse på Windows), (2) ellers finn `corepack`/`corepack.cmd` på PATH og
påkall med EKSPLISITT pinnet versjon fra `package.json` sitt `packageManager`-felt
(`corepack pnpm@9.15.9 ...` - ALDRI `corepack enable`, som kan kreve forhøyede rettigheter), (3) ellers
fail-closed med en tydelig, handlingsrettet feil. Den resolverte, filsystem-bekreftede stien kjøres med
`shell: true` KUN fordi et `.cmd`-shim selv krever shell-tolkning for å kjøre i det hele tatt (Windows
CreateProcess kan ikke starte batch-filer direkte) - aldri brukerstyrt/injiserbar input, kun en verifisert
filsti + statiske argumenter. `pnpm`-versjonen og lockfilen røres IKKE (fortsatt `pnpm@9.15.9`,
`--frozen-lockfile` uendret).

**Bevist:**
- 11 nye rene enhetstester (`modules/core/test/package-manager-resolve.test.ts`, §9.A-G i BO-en) -
  Windows `.cmd`-oppløsning, Corepack-fallback m/pinnet versjon, fail-closed uten kjørbar fil (aldri en
  instruksjon om `corepack enable`), pinnet versjon lest korrekt fra `package.json`.
- 18 oppdaterte wiring-tester (`q20-host-run-wiring.test.ts`) - fortsatt grønne, bekrefter riktig
  rekkefølge/idempotens/ingen secrets med den nye resolver-logikken innbakt.
- **Kjørt FOR REAL i byggemiljøet** (ikke bare unit-testet): `node --experimental-transform-types
  modules/core/scripts/q20-host-run.ts` kjørt direkte - `package_manager_resolution=PASS
  package_manager_driver=pnpm package_manager_version=9.15.9`, `install_frozen_lockfile=PASS`,
  `erasure_workspace_dependencies=PASS`, deretter korrekt (forventet) fail-closed på manglende `.env` i
  byggemiljøet (som ikke har Q-21 sin `.env`) - beviser hele bootstrap-kjeden fungerer ende-til-ende
  FØR Docker-stegene, uten regresjon fra host-runde 1.

**Ett-kommando-kontrakten uendret:**
```
node --experimental-transform-types modules/core/scripts/q20-host-run.ts
```
Ingen manuell `pnpm install`, ingen PATH-redigering, ingen SQL, ingen Docker-kommandoer for Tobias.

**Status ved denne runden: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY** (denne runden løste kun den
Windows-spesifikke prosess-spawning-feilen som hindret bootstrap-steget fra å fullføre).
**OPPDATERT: en påfølgende DEP0190-opprydding (runde 3) + faktisk host-akseptanse fulgte -
Q-20 er nå VERIFIED/CLOSED (D-40, run_id `eaabe2b1`), se "Q-20 FINAL CLOSURE"-seksjonen øverst i
dette dokumentet.**

## Q-20 HOST RECOVERY #1: WORKSPACE BOOTSTRAP-FEIL (2026-08-16, samme dag)

**Host-feil:** Tobias kjørte den instruerte kommandoen
(`node --env-file=.env --experimental-transform-types modules/erasure/scripts/q20-erasure-live.ts`)
og fikk umiddelbart `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@jarvis/core' imported from
modules/erasure/scripts/q20-erasure-live.ts` - FØR noe Q-20-innhold i det hele tatt ble testet.
Host-Node: v24.11.1.

**Root cause (ikke gjettet, bekreftet ved reproduksjon i byggemiljøet):** denne branchen la til en HELT
NY pnpm-workspace-pakke (`modules/erasure`). Hosten sin `node_modules` ble sist bootstrappet FØR den
pakken eksisterte - `pnpm-lock.yaml` (fra git) kjenner den korrekt, men de lokale
`node_modules/@jarvis/*`-symlinkene for `modules/erasure` var aldri opprettet. **Dette er en
host-bootstrap-feil, IKKE et Q-20-funn** - ingen erasure-semantikk er endret for å "fikse" dette.

**Node 24-vurdering (§6 i BO-en):** IKKE root cause. `package.json` sitt `engines`-felt krever kun
`>=22`, og `--experimental-transform-types` finnes fortsatt på Node 24 - host-Noden er kompatibel.
Feilen var utelukkende workspace-bootstrap, ikke Node-versjon.

**Fiks (bevarer ett-kommando-kontrakten):** ny `modules/core/scripts/q20-host-run.ts` - en
ett-kommando-orkestrator som BEVISST kun bruker Node-innebygde moduler på toppnivå (`node:child_process`/
`node:fs`/`node:path`) - må kunne kjøre FØR `pnpm install` har bootstrappet workspacet, som er selve
poenget. Rekkefølge: (1) verifiser repo-rot, (2) `pnpm install --frozen-lockfile` (ALDRI oppdaterer
pnpm-versjon eller lockfile), (3) `modules/erasure/scripts/verify-workspace.ts` (isolert, tydelig
PASS/FAIL-diagnostikk - `erasure_workspace_dependencies=PASS`), (4) Postgres oppe, (5) bygg
migrate/api/worker FERSKT fra gjeldende checkout (samme "always rebuild"-leksjon som Q-21 host-runde 3),
(6) kjør migrate (anvender `018_erasure.sql` idempotent via ADMIN-rollen, uendret fra Q-21), (7) restart
api/worker fra de ferske imagene (plukker opp EKSISTERENDE `.env` uendret - Q-21 sin runtime-rolle
røres IKKE), (8) kjør `q20-erasure-live.ts` (som selv verifiserer Q-21-rollen på nytt, §1, FØR noe
destruktivt forsøkes - ingen duplisert logikk). `.env` skrives/endres ALDRI av denne runneren.

**Bevist i byggemiljøet:** feilen reprodusert eksakt (fjernet `modules/erasure/node_modules`, samme
`ERR_MODULE_NOT_FOUND`), deretter bekreftet at `pnpm install` (standard, veletablert pnpm-semantikk for
et nytt workspace-medlem) reparerer resolveringen - `verify-workspace.ts` går fra
`erasure_workspace_dependencies=FAIL` til `PASS`. Docker-orkestreringsstegene er IKKE kjørt live i
byggemiljøet (ingen Docker-daemon tilgjengelig der) - verifisert via 18 nye wiring-tester
(`modules/core/test/q20-host-run-wiring.test.ts`, §7.A-I i BO-en: bootstrap-rekkefølge, frozen-lockfile,
migrasjon-018-rekkefølge, ferskt image FØR migrate, Q-21 uendret/`.env` aldri skrevet, idempotens (ingen
destruktive flagg), ingen secrets logget, tydelig feilmelding FØR bootstrap, og at runneren faktisk når
frem til `q20-erasure-live.ts`).

**Eksakt ÉN kommando for Tobias (erstatter forrige runde sin kommando):**
```
node --experimental-transform-types modules/core/scripts/q20-host-run.ts
```

**Status ved denne runden: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY** (denne runden løste kun
bootstrap-blokkeringen som hindret akseptansen fra å starte i det hele tatt).
**OPPDATERT: Q-20 er nå VERIFIED/CLOSED (D-40, run_id `eaabe2b1`), se "Q-20 FINAL CLOSURE"-seksjonen
øverst i dette dokumentet.**

## Q-20: DATA ERASURE FOUNDATION - SUITE-VERIFIED (2026-08-16, IKKE host-verifisert ennå)

**Teknisk data-erasure-foundation, IKKE en juridisk GDPR-compliance-sertifisering.** Bygget for å redusere
persondata-eksponeringsrisikoen FØR UA-2 P1 (flere kunnskapskilder) øker mengden ingestert persondata.
Full arkitektur/rasjonale: [DATA_ERASURE.md](DATA_ERASURE.md).

**Sentral, typed `ErasureService`** (`modules/erasure/src/erasure-service.ts`) - `previewErasure`/
`executeErasure`/`verifyErasure`. Scope-uttrykk (`modules/erasure/src/scope.ts`): `tenant`/`person`/
`memory_space`/`knowledge_source`/`knowledge_document`/`conversation`, `tenant_id` ALLTID eksplisitt -
ingen cross-tenant purge uttrykkbart. Hard-delete dekker (FK-trygg rekkefølge, én transaksjon,
fail-closed - hele transaksjonen rulles tilbake ved enhver feil, ALDRI delvis sletting):
`knowledge_documents`/`knowledge_embeddings`, `memory_items` + alt avledet (`memory_versions`/
`embeddings`/`entities`/`relations`/`memory_item_entities`/`summaries`/`decisions`/`commitments`/
`deadlines`), `messages`/`sessions`, `artifacts` (tenant-scope). Migrasjon `018_erasure.sql` ga
`jarvis_app` et nytt, EKSPLISITT avgrenset `GRANT DELETE` (kun disse tabellene - systemet hadde
ALDRI hatt en DELETE-rettighet noe sted før dette; `events`/`audit_events` forblir UTEN DELETE-grant
i tillegg til å være append-only-trigger-blokkert for enhver rolle).

**Resurrection protection (§5):** ny `erasure_fingerprints`-ledger (samme migrasjon) - lagrer KUN en
irreversibel SHA-256-fingerprint av canonical identity (`tenant_id|source_type|source_instance_id|
external_id`), ALDRI selve innholdet/external_id i klartekst. `KnowledgeSyncService.sync()`
(`modules/knowledge/src/sync.ts`) sjekker denne FØR den oppretter et nytt canonical document - en
matchende fingerprint gir `report.suppressed += 1`, ALDRI re-insert. Bevist LIVE (embedded Postgres,
denne økten): purge → resync (samme fil fortsatt på disk) → `created=0, suppressed=1` → retriever
finner ingenting.

**Policy/D-klasse (§7/§8):** `executeErasure()` bygger et `ToolCall`
(`{tool_id:"data-erasure", action:"purge", capability_class:"D"}`) og kaller EKSISTERENDE
`PolicyGateway.authorize()` direkte - samme sovereign-/approval-/nonce-replay-mekanikk som alle andre
D-handlinger, INGEN ny auth-modell. Bevist: owner sovereign kjører uten approval; delegert identitet
nektes uten signert approval og tillates med en gyldig Ed25519-signert godkjenning (samme
`approvalSigningBytes`/`verifyApproval` som resten av systemet).

**§9-unntak (dokumentert, bevisst):** går IKKE via `ToolGateway.execute()` sin generiske D-pipeline -
den ville lagret en KOPI av innholdet som skal slettes i et `before_state`-recovery-snapshot, som ville
strukturelt UNDERGRAVD selve erasure. `executeErasure()` skriver i stedet sin egen trygge
`erasure_requests`-ledger-rad (kun identifiers/counts - bevist i test at raden ALDRI inneholder en
plantet SENTINEL-streng).

**Backup/restore-kontrakt (§10):** `modules/watchdog/src/backup.ts` sin `TIER1_TABLES` utvidet med
`knowledge_documents`/`knowledge_embeddings` (reell pre-eksisterende gap - manglet helt fra UA-2 P0) +
`erasure_requests`/`erasure_fingerprints`. Ny `reapplyErasuresAfterRestore(adminPool)` - leser HELE
fingerprint-ledgeren fra en restorert database og fjerner på nytt ethvert restorert knowledge-dokument
som matcher, idempotent. Bevist (`modules/watchdog/test/erasure-restore-contract.test.ts`).

**Kjent, dokumentert (ikke skjult) residual-gap** (se DATA_ERASURE.md §2/§10 for full begrunnelse):
- `events`/`audit_events`-payload: strukturelt BLOKKERT (append-only-trigger gjelder alle roller).
- `tasks`/`tool_executions`-innhold: ikke pålitelig adresserbart (ingen stabil kobling til en scope-id).
- Langfuse/lokal trace-fil (`var/traces.jsonl`): ingen purge-integrasjon bygget.
- `person`-scope dekker ikke knowledge-dokumenter (skjemaet mangler en person-/subject-kolonne der).

**Tester:** `modules/erasure/test/erasure-service.test.ts` (13 tester: A-Q fra byggeordren + D-klasse-
policy-integrasjon), `modules/watchdog/test/erasure-restore-contract.test.ts` (1 test) - alle grønne mot
embedded Postgres. Live-scriptet `modules/erasure/scripts/q20-erasure-live.ts` implementerer alle 21
akseptansetrinnene fra byggeordren og er selv kjørt end-to-end i denne økten mot en ekte (embedded, ikke
mocket) Postgres-instans:

```
q20_preview=PASS            q20_hard_delete=PASS        q20_derived_delete=PASS
q20_fts_erasure=PASS        q20_vector_erasure=PASS     q20_hybrid_erasure=PASS
q20_memory_erasure=PASS     q20_no_resurrection=PASS    q20_idempotency=PASS
q20_tenant_isolation=PASS   q20_space_isolation=PASS    q20_receipt_safe=PASS
q20_sentinel_scan=PASS      q21_runtime_role_safe=PASS  hard_fail=false
```

**Dette var (ved bygging) embedded (byggemiljø) Postgres, IKKE Tobias sin faktiske Docker/pgvector-
host.** Denne suite-kjøringen krevde deretter tre host-recovery-runder (workspace-bootstrap → Windows
pnpm-prosessoppløsning → DEP0190-opprydding) før selve host-akseptansen kunne kjøres - se
"Q-20 HOST RECOVERY #1/#2"-seksjonene. **OPPDATERT: Q-20 er nå VERIFIED/CLOSED (D-40, host-bevist,
run_id `eaabe2b1`) - se "Q-20 FINAL CLOSURE"-seksjonen øverst i dette dokumentet for det faktiske
host-beviset.**

## BO-02-tillegg (2026-08-13)
- **Node 22-avvik løst:** `pnpm --use-node-version=22.14.0 vitest run` → **128/128 PASS** (re-kjørt);
  gårsdagens «6 skipped» er ikke reproduserbart (transient, trolig portkollisjon/timing i voice-e2e).
  Node 22 bekreftet som production target; ingen tester fjernet/deaktivert.
- **Model-provider live:** OpenAI PRODUCTION-kall verifisert (evidens over). Anthropic/Ollama: nøkkel/endepunkt mangler.
- **Nytt:** POST /brief (JSON+rendert+session), Telegram-levering (chunket, idempotent, via Tool Gateway - venter bot-token), persistent seen/stale-suppression (migrasjon 012, testet), brief-cost-rad per generering.
- **Docker fortsatt fraværende** → D-27/D-28/D-32/Infisical-D-35 uendret BLOCKED_EXTERNAL.

## BO-03-tillegg (2026-08-13)
- **Docker/credentials re-probet: fortsatt fraværende** (ingen docker-binaer, ingen .env) -
  D-27/D-28/D-32/D-35 og alle live-connector-maal forblir BLOCKED_EXTERNAL.
- **Produksjonstransporter implementert og typesjekket (live-kall venter kun paa .env):**
  GmailTransport (OAuth refresh->access, metadata, unread/important, konto-merket),
  GoogleCalendarTransport (dagens/kommende events m/attendees/prep), GithubTransport (issues/PR),
  TelegramTransport (sendMessage til owner-chat) + TelegramCommandPoller (/brief, /status,
  kun owner-chat, svar via Tool Gateway/audit).
- **Konto-/tenant-opploesning:** transport-instans er bundet til eksplisitt konto
  (JARVIS_GOOGLE_ACCOUNT, default post@tsworkflow.com per D-34, som konfig - aldri hardkodet i
  domenelogikk); ingen implisitt cross-account fallback.
- **Connector-health:** healthy/auth_failed/rate_limited/unavailable per tool_id oppdateres av
  hvert kall i Tool Gateway; eksponeres i /status.
- **Morgenlevering:** konfigurerbar (JARVIS_BRIEF_HOUR, default 07), en gang per dag, degraderer
  pent (brief-kilder feiler enkeltvis; Telegram-feil stopper ikke prosessen).
- .env-noekler som aktiverer alt: JARVIS_GOOGLE_CLIENT_ID/SECRET, JARVIS_EMAIL_TOKEN +
  JARVIS_GOOGLE_TOKEN (refresh tokens), JARVIS_GITHUB_TOKEN, JARVIS_TELEGRAM_TOKEN +
  JARVIS_TELEGRAM_CHAT_ID.

## BO-04 LIVE-EVIDENS (2026-08-13, kommando: node --experimental-transform-types modules/tool-gateway/scripts/live-verify.ts)
- **Gmail: LIVE+VERIFIED** (post@tsworkflow.com, ekte meldinger normalisert inn i brief; health=healthy)
- **Calendar: LIVE+VERIFIED** (primary, 0 events i dag - reelt; health=healthy)
- **GitHub: LIVE+VERIFIED** (tsworkflow/jarvisbuild, 0 aapne issues - reelt; health=healthy)
- **Telegram: LIVE+VERIFIED** (owner-chat 8602032369; testmelding message_id=5; owner-only isolation i poller)
- **FOERSTE EKTE DAILY BRIEF generert av live kilder og LEVERT til Telegram** (delivered=true,
  top=3, follow-ups=15 fra ekte e-post, 0 source_errors, seen-state persistert 20 items,
  2x brief:generation i cost_events, /status levert). D-35 live-integrasjonsdel: **PRODUCTION_VERIFIED
  for Gmail/Calendar/GitHub/Telegram**; Infisical-delen fortsatt BLOCKED_EXTERNAL (Docker mangler - reprobet).
- Kjente gap: scheduler er prosess-lokal (ikke reboot-durabel); inbound /brief-/status-kommandoer
  krever kjoerende API-prosess (poller starter med main).

## BO-05 LIVE-EVIDENS (2026-08-13, Docker server 29.7.2 / Desktop 4.86)
- **D-28: LIVE+VERIFIED (runtime):** PostgreSQL 16.14 i Docker (compose, persistent volum),
  pgvector **0.8.6**, HNSW-indeks opprettet, `<=>`-similarity korrekt, RLS aktivert,
  **data overlevde container-restart** (count uendret). Alle 13 migrasjoner kjørt mot Docker-PG
  (34 tabeller). GJENSTÅR: konvertere embeddings-kolonnen real[]→vector + retrieval-bytte +
  eval-regresjon (D-28-portens migreringssteg).
- **D-32 (delvis):** kastbar worker-container bevist: node:22-alpine, non-root (node),
  --network none, --memory 256m, --pids-limit 64, INGEN JARVIS-env (0 treff), workspace i
  container, testkommando OK. GJENSTÅR: DockerSandboxRunner-wiring i worker + reclaim-test i
  container + ekte GitHub-PR-flyt.
- **Scheduler: VERIFIED reboot-durabel** (migrasjon 013 + DailyScheduler: DB-lås, Europe/Oslo,
  catch-up, multi-instans → nøyaktig én vinner, testet; main bruker den).
- **D-27 Langfuse / Infisical-D-35: IKKE startet i denne økten** (bevisst prioritering) —
  neste økt: legg langfuse:2 + infisical i compose med LANGFUSE_INIT_*-nøkler, ekte trace + secret-flyt.
- Docker-CLI-merknad: binærer ligger på per-bruker-sti
  C:\Users\Tobia\AppData\Local\Programs\DockerDesktop\resources\bin (ikke i systemets PATH for shells).

## BO-06 LIVE-EVIDENS (2026-08-13)
- **D-28: VERIFIED.** Migrasjon 014 (betinget pgvector, ikke-destruktiv). Mot Docker-PG: ekte Jarvis
  embeddings-kolonne `vec` = pgvector `vector`, HNSW-indeks `embeddings_vec_hnsw`, writer fyller vec
  (3/3 rader), MemoryRetriever bruker `<=>`-cosine via pgvector (runtime-probe; real[]-fallback for
  embedded test-PG). Retrieval-regresjon: semantisk topptreff korrekt (score 0.914), kryss-tenant
  A→B = 0 (RLS holder gjennom pgvector-pathen), tom/irrelevant spørring = 0. Persistens (BO-05) PASS.
  130/130 tester fortsatt grønne (real[]-pathen uendret).
- **UA0-RUNRATE: VERIFIED mot Docker-PG.** Ekte OpenAI-kall (gpt-4o-mini) → cost_events i Docker-PG
  {provider:openai, model:gpt-4o-mini, in:25, out:8, 2 øre, task-bo6}. Ingen secrets i rad/trace.
- **OPS backup/restore: VERIFIED.** pg_dump -Fc av Docker-PG → restore til fersk DB: cost_events=1,
  embeddings=3, vec-type=vector, 33 tabeller bevart. Backup-fil i scratchpad (ikke i repo), slettet.
- **IKKE gjort i BO-06 (ærlig - neste økt):** D-32 DockerSandboxRunner-wiring i worker + reclaim i
  container; D-27 Langfuse-runtime + trace; D-35 Infisical-runtime; API-autostart-container;
  full-stack compose (langfuse/infisical/api) + failure-injection. Alt er ren byggetid, ingen
  eksterne blockere.

## UA-0 FORMELL LUKKING (BO-08, 2026-08-13)

**UA-0 CORE RUNTIME = CLOSED.** Reality-check ved lukking: HEAD `fc1dd27`, full compose-stack healthy
(postgres/langfuse/infisical(+redis)/api/worker), 130/130 tester, lint/typecheck/gitleaks rene.

| Gate | Sluttstatus | Evidens |
|---|---|---|
| D-27 Langfuse | **VERIFIED** | BO-07-seksjonen under |
| D-28 pgvector/HNSW/retrieval | **VERIFIED** | BO-06-seksjonen |
| D-32 Docker-sandbox/durable worker | **VERIFIED** | BO-07-seksjonen |
| D-35 Infisical/SecretProvider/pilot | **VERIFIED** | BO-07-seksjonen |
| OPS-RUNTIME (full stack/restart/failure-injection) | **VERIFIED** | BO-07-seksjonen |
| UA0-RUNRATE | **VERIFIED** | BO-06/BO-07-seksjonene |

**Egne åpne porter (blokkerer IKKE UA-0 core, status ved UA-0-lukking):** D-30 Voice = OPEN (krever
≥100 norske prøver + STT/TTS-nøkler) · D-36 Apple = OPEN (krever Mac/Xcode/Developer-konto) ·
HA-RUNTIME = OPEN (krever HA-instans + token). **Oppdatering:** D-30 P0 (funksjonell korrekthet) er
nå VERIFIED (BO-12-seksjonen, host-runde 6) - kun det formelle D-10-STT-benchmarken (≥100 norske
prøver, providervalg) forblir separat åpen, ikke-blokkerende (se D-30 Voice benchmark-raden over).

**Owner-seed:** fra BO-08 automatisk og idempotent i `apps/api/src/migrate-main.ts` (one-shot
migrate-tjenesten); det manuelle SQL-steget fra BO-07 er fjernet. ID-er konfigurerbare via
JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME.

## Q-21 CLOSURE + UA-2 P0 CLOSURE: HOST VERIFIED (2026-08-15, run_id `778bb87d`)

**Tobias kjørte `node --experimental-transform-types modules/core/scripts/fix-q21-runtime-role.ts`
på sin faktiske Windows-host - GRØNT resultat, hele kjeden i én kommando.**

### Q-21 (D-38): DB admin/runtime-rolle-splitt - VERIFIED

```
migrate_effective_db_user=postgres

runtime_connection=PASS
runtime_current_user=jarvis_runtime
runtime_role_superuser=false
runtime_role_bypassrls=false
runtime_role_canlogin=true
runtime_role_member_jarvis_app=true

q21_runtime_role_safe=PASS
```

Bevist LIVE, ikke bare i kode/suite:
- **Migrate/admin-tilkoblingen** bruker `postgres` (admin-rollen) - ALDRI runtime-rollen.
- **API/worker/runtime**-tilkoblingen bruker `jarvis_runtime` - ALDRI admin-rollen.
- `jarvis_runtime` er faktisk `NOSUPERUSER` (`runtime_role_superuser=false`).
- `jarvis_runtime` er faktisk `NOBYPASSRLS` (`runtime_role_bypassrls=false`).
- `jarvis_runtime` er en ekte `LOGIN`-rolle (`runtime_role_canlogin=true`).
- `jarvis_runtime` er bevist medlem av `jarvis_app` (`runtime_role_member_jarvis_app=true`) - arver
  samme grants for identity/sessions/messages/tasks/memory/approvals/devices/tool-audit/cost-events/
  knowledge som resten av systemet alltid har forutsatt (005_rls.sql), ingen ny permission-modell.

### RLS - tenant + memory-space isolasjon - VERIFIED LIVE

```
tenant_a_sees_tenant_b=0
tenant_b_sees_tenant_a=0
tenant_a_sees_own=1

personal_sees_business=0
business_sees_personal=0

tenant_isolation=PASS
memory_space_isolation=PASS
```

Dette er den FAKTISKE RLS-DENY-veien - forrige host-runde (2026-08-15, tidligere samme dag) beviste at
denne EKSAKT samme sjekken feilet (`BLOCKED_BY_RUNTIME_ROLE`) mens systemet kjørte som superbruker.
Nå bevist PASS gjennom den korrekte, non-bypass `jarvis_runtime`-rollen.

### UA-2 P0 (D-39): Knowledge Ingestion Foundation - VERIFIED/COMPLETE

```
filesystem_ingest=PASS          unchanged_resync=PASS       update_same_canonical=PASS
tombstone=PASS                  reactivation=PASS            provenance=PASS
fts=PASS                        vector=PASS                  hybrid=PASS
filesystem_allowlist=PASS       traversal_deny=PASS          symlink_escape=SKIPPED_HOST_PERMISSION
github_live=PASS                duplicate_documents=0

hard_fail=false
```

Alle P0-akseptansekriteriene fra BO-en (§13 i opprinnelig byggeordre) er nå host-verifisert mot
Tobias sin FAKTISKE lokale Postgres/pgvector, ekte filsystem, og et ekte GitHub-repo (`github_live=PASS`,
`duplicate_documents=0` - ingen duplikater ved resync):
- Filesystem full livssyklus: ingest → uendret resync (no-op) → endring (samme canonical document, ny
  versjon) → sletting (tombstone) → gjenoppdukking (deterministisk reaktivering) - alle PASS.
- Ekte FTS + vektor + hybrid retrieval mot ekte pgvector (ikke embedded-test-Postgres) - alle PASS.
- Filsystem-sikkerhet: allowlistet root + `../`-traversal-nøytralisering - begge PASS.
- GitHub live-kilde: repo-metadata/issues faktisk hentet og synkronisert via ekte credentials.
- Tenant- og memory-space-isolasjon: se Q-21-seksjonen over (samme host-kjøring, samme bevis).

**`symlink_escape=SKIPPED_HOST_PERMISSION` - eksplisitt IKKE et live-PASS.** Windows-hosten tillot ikke
symlink-opprettelse uten administratorrettigheter i denne kjøringen, så harnesset rapporterte ærlig
SKIPPED i stedet for å late som en test kjørte. Symlink-escape-DENY-mekanismen (samme
`realpath()`-baserte sjekk som allowlist/traversal) er FORTSATT fullt suite-bevist
(`modules/knowledge/test/filesystem-source.test.ts`, embedded Postgres + ekte filsystem-I/O) - dette er
en dokumentert host-begrensning, ikke en udekket sikkerhetssjekk.

**Fortsatt bevisst utenfor P0-scope (uendret):** kun myk sletting/tombstone (Q-20 - ingen GDPR
hard-delete-vei bygget ennå), Knowledge Graph/GraphRAG, Obsidian/Pieces/Drive/e-post/
møtetranskripsjon-ingest, OCR/vision, autonom web-crawling, UA-3-forretningslogikk,
voice-ytelsesoptimalisering, skriving tilbake til kildene.

### Reisen til dette punktet (tre host-recovery-runder, samme dag)

1. **Runde 1:** `docker compose up -d postgres` feilet - Compose sin egen `.env`-interpolasjon fant
   ikke `JARVIS_DB_ADMIN_PASSWORD` selv om verdien var korrekt i filen. Fikset med eksplisitt
   `--env-file`.
2. **Runde 2:** migrate autentiserte likevel som `jarvis_runtime` - prøvd fikset med eksplisitt
   `-e VARNAME`-overstyring av miljøvariabler til migrate-kallet.
3. **Runde 3 (faktisk root cause):** `-e`-fiksen løste det ikke - migrate-containeren kjørte et
   EKSISTERENDE, UTDATERT Docker-image (Compose bygger aldri automatisk på nytt ved kildekodeendring).
   Fikset ved å ALLTID bygge migrate/api/worker fra aktuell checkout FØR de kjøres/restartes, hver
   eneste gang scriptet kjører.

Denne runden (4.) bekrefter at runde 3 sin fiks faktisk var den avgjørende: `migrate_effective_db_user`
viser nå korrekt `postgres`, og hele kjeden - Q-21 OG UA-2 P0 - er grønn i én sammenhengende
host-kjøring.

**Status: Q-21 = VERIFIED/CLOSED. UA-2 P0 = VERIFIED/COMPLETE.** PR #3 klargjøres for merge til `main`.

## Q-21 HOST FIX RECOVERY #3: STALE MIGRATE DOCKER-IMAGE (2026-08-15, samme dag - faktisk root cause)

**Host-feil:** Tobias kjørte scriptet på nytt etter runde #2-fiksen (eksplisitt `-e VARNAME`-
overstyring til migrate). `admin_connection=PASS admin_current_user=postgres` (scriptets egen direkte
tilkobling fungerte), men `docker compose ... run --rm migrate` feilet FORTSATT med
`password authentication failed for user "jarvis_runtime"`.

**Root cause (bekreftet fra kodeflyt, ikke gjettet):** scriptet gjorde aldri noen `docker compose
build` FØR `run --rm migrate` - kun `up -d postgres` etterfulgt direkte av `run --rm migrate`. Docker
Compose bygger ALDRI et image på nytt automatisk bare fordi kildekoden på disk har endret seg - kun en
eksplisitt `build`/`--build` gjør det. Migrate-containeren kjørte dermed et EKSISTERENDE, UTDATERT
lokalt image - fra FØR `adminConfigFromEnv()`-splitten (og trolig fra før `-e VARNAME`-fiksen) i det
hele tatt eksisterte i kildekoden. Dette forklarer PERFEKT alle tre rundenes symptomer samtidig:
scriptets EGEN pg-tilkobling (kjører direkte via Node, alltid fersk kildekode) beviste konsekvent at
admin-credentials var korrekte, mens SELVE MIGRATE-CONTAINEREN kjørte en helt annen, eldre versjon av
`migrate-main.ts` - uavhengig av hva `.env` eller `-e`-flagg noensinne inneholdt. Runde #2 sin
`-e VARNAME`-fiks var derfor irrelevant fra start: den utdaterte containerens gamle kode leste
sannsynligvis aldri `JARVIS_DB_ADMIN_USER` i det hele tatt.

**Fiks:**
- Ny `buildImageBuildArgs(composeArgs)` (`lib/q21-env-recovery.ts`): `docker compose --env-file <env>
  -f <compose> build migrate api worker`. Kjøres UBETINGET (ingen sjekk som kunne hoppe over den) RETT
  ETTER admin-precheck og FØR migrate kjøres - "always rebuild" er den minste robuste løsningen
  (BO-ens eget ord), ingen SHA-labels eller annen overengineering.
- `-e VARNAME`-overstyringen fra runde #2 er FJERNET igjen (§3 i BO-en - unødvendig ambiguitet når
  imaget garantert er ferskt bygget): `buildMigrateRunArgs` er tilbake til den enkle formen
  (`run --rm migrate`, kun service+`--env-file`, ingen egne miljøoverstyringer). `run()`-funksjonen i
  hovedscriptet mistet dermed sin `extraEnv`-parameter helt.
- Ny operasjonsrekkefølge: postgres opp → admin-precheck → **bygg migrate/api/worker** → kjør migrate
  → restart api/worker (fra de FERSKT bygde imagene) → runtime-verifikasjon → `ua2-p0-live.ts`.
- `migrate_effective_db_user`-diagnostikken fra runde #2 beholdes uendret - den er nå den DEFINITIVE
  testen: viser den fortsatt IKKE `postgres` på neste host-kjøring til tross for et garantert ferskt
  image, er det sterkt bevis for en helt annen årsak (f.eks. en Postgres-side `pg_hba.conf`-anomali).

**Nye tester** (`modules/core/test/q21-migrate-role-wiring.test.ts`, utvidet til 19 tester): §10.A/B
(rebuild skjer FØR migrate OG FØR api/worker restartes), §10.C (rebuild-steget er ubetinget, ingen
vei rundt det), §10.D/E (migrate-kommandoen er tilbake til den enkle formen, ingen `-e`-ambiguitet),
§10.F (uendret grunnsannhets-diagnostikk), §10.G (ingen credential-verdier logges noe sted, `run()`
tar ikke lenger imot en verdi-parameter i det hele tatt), §10.H (full operasjonsrekkefølge inkl. det
nye build-steget, idempotent rerun).

**Regresjon fanget og fikset underveis:** fjerning av `buildMigrateRunArgs` sin gamle `-e`-variant og
`MIGRATE_ADMIN_ENV_KEYS`-eksporten krevde oppdatering av eksisterende tester fra forrige runde som
fortsatt refererte til dem.

**Kvalitet:** 358/358 tester (352 baseline + 6 netto nye), lint/typecheck/gitleaks rene.

**Status:** samme ÉN kommando som før (`node --experimental-transform-types
modules/core/scripts/fix-q21-runtime-role.ts`) - fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, venter
på Tobias sin faktiske re-kjøring.

## Q-21 HOST FIX RECOVERY #2: MIGRATE BRUKER FEIL DB-ROLLE (2026-08-15, samme dag)

**Host-feil:** Tobias kjørte `fix-q21-runtime-role.ts` på nytt. Scriptet rapporterte korrekt
`admin-rolle: postgres`, skrev `.env` med BÅDE ADMIN- og RUNTIME-settet, og Postgres startet
korrekt via det eksplisitte `--env-file`-flagget (forrige rundes fiks holdt). Deretter feilet
`docker compose ... run --rm migrate` inni migrasjonsprosessen: `runMigrations()` kastet
`password authentication failed for user "jarvis_runtime"` (Postgres-kode `28P01`) - til tross
for at scriptet mente admin-brukeren var `postgres`.

**Sporing gjennom hele kjeden (§1 i BO-en, ingen gjetning):** `.env` (bekreftet korrekt av
scriptets egen log RETT FØR feilen) → `docker-compose.yml` sin `migrate:`-tjeneste (kun
`env_file: ["../../.env"]` + statiske `JARVIS_DB_HOST/PORT/NAME` - INGEN `${JARVIS_DB_ADMIN_USER}`-
interpolasjon involvert for admin-nøklene der) → `migrate-main.ts` sin `adminConfigFromEnv()` → `pg.Pool`.
Ingen kodefeil funnet i noe av dette - `api.Dockerfile` (delt image for migrate/api/worker) bekrefter
også ingen bakt-inn `ENV`-verdier. Konklusjon: den mest sannsynlige gjenværende årsaken er en
Docker Compose-spesifikk miljøvariabel-presedens-mekanisme for `docker compose run` (shell-arv vs.
`env_file`-oppløsning) som IKKE kan bekreftes 100% uten faktisk host-tilgang til å inspisere
effektiv container-config.

**Fiks - fjerner hele tvetydighetsklassen i stedet for å gjette videre:**
- `modules/core/scripts/lib/q21-env-recovery.ts`: ny `buildMigrateRunArgs(composeArgs)` - bygger
  `docker compose run --rm -e JARVIS_DB_ADMIN_USER -e JARVIS_DB_ADMIN_PASSWORD migrate` (BAR
  `-e VARNAME`-form, ALDRI `-e VARNAME=verdi`). Ren funksjon - returnerer kun nøkkelNAVN, aldri en
  verdi, trygt å logge hele resultatet.
- `fix-q21-runtime-role.ts`: `run()` fikk en `extraEnv`-parameter som injiserer verdiene KUN i
  `execFileSync` sin `env`-opsjon (barneprosessens - docker-CLI-ets - eget miljø) - ALDRI som del av
  det loggede `args`-arrayet. Docker Compose sin `-e VARNAME` (bar form) leser da fra NETTOPP denne
  kontrollerte prosessens miljø, med Compose sin høyeste presedens for `run` - garantert uavhengig av
  `.env`/`env_file`/prosjektmappe-tvetydighet.
- Ny **admin-tilkoblings-precheck** (§6 i BO-en) RETT FØR migrate kjøres: en direkte `pg.Pool`-
  tilkobling fra SCRIPTET selv (ikke via Docker) med de beregnede admin-credentials, logger
  `admin_connection=PASS`/`admin_current_user=<navn>`. Fanger en feilkonfigurasjon FØR et
  migrate-forsøk kastes bort på den.
- Ny **grunnsannhets-diagnostikk** i `migrate-main.ts` selv: `migrate_effective_db_user=<navn>`
  skrevet FØR `runMigrations()` kjøres - viser PRESIST hvilken rolle migrate-PROSESSEN faktisk
  forsøker å koble til med, uavhengig av hva host-scriptet antok. Forventet verdi: `postgres`.
- Runtime-verifikasjonen (etter migrate+restart) fikk utvidede, eksplisitt navngitte felt:
  `runtime_connection`, `runtime_current_user`, `runtime_role_exists`, `runtime_role_superuser`,
  `runtime_role_bypassrls`, `runtime_role_canlogin`, `runtime_role_member_jarvis_app`.

**Nye tester** (`modules/core/test/q21-migrate-role-wiring.test.ts`, 13 tester): §9.A
(`migrate_effective_db_user` skrevet FØR `runMigrations`, fra `adminConfigFromEnv()`), §9.B/§9.C
(api/worker fortsatt kun `configFromEnv`), §9.D/§9.E (admin/runtime-config kan fortsatt ikke lese
hverandres variabler), §9.F (compose sin `migrate:`-blokk setter aldri `JARVIS_DB_USER/PASSWORD`
eksplisitt - ville skygget for `env_file`), §9.G (partial-rerun idempotent), §9.H/§9.J (kildekode-
rekkefølge: admin-precheck → migrate → api/worker-restart → runtime-verifikasjon → `ua2-p0-live.ts`),
§9.I (`buildMigrateRunArgs` inneholder aldri en verdi, kun nøkkelnavn - trygt å logge; scriptet logger
aldri en passordvariabel direkte).

**Regresjon fanget og fikset underveis:** endringen i `migrate-main.ts` (caching av
`adminConfigFromEnv()`-resultatet i en variabel for å kunne logge diagnostikken FØR `createPool`)
brøt en eksisterende tekstbasert wiring-test fra forrige runde (`db-role-wiring.test.ts` forventet
det eksakte inline-mønsteret `createPool(adminConfigFromEnv())`) - oppdatert til å sjekke selve
INVARIANTEN (adminConfigFromEnv brukes, resultatet kobles til createPool) i stedet for eksakt syntaks.

**Kvalitet:** 352/352 tester (339 baseline + 13 nye), lint/typecheck/gitleaks rene.

**Status:** samme ÉN kommando som før (`node --experimental-transform-types
modules/core/scripts/fix-q21-runtime-role.ts`) - fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, venter
på Tobias sin faktiske re-kjøring. Skulle `migrate_effective_db_user` fortsatt IKKE vise `postgres`
på neste host-kjøring til tross for disse eksplisitte `-e`-overstyringene, er det sterkt bevis for at
årsaken ligger et sted `-e`-mekanismen selv ikke kan overstyre (f.eks. en Postgres-side `pg_hba.conf`/
autentiseringsregel-anomali) - noe kun host-loggen kan avgjøre videre.

## Q-21 HOST FIX RECOVERY: ADMIN ENV BOOTSTRAP BUG (2026-08-15, samme dag)

**Host-feil:** Tobias kjørte `fix-q21-runtime-role.ts` - scriptet leste `.env` (admin-credentials fantes
og ble lest korrekt, backup skrevet, `.env` oppdatert med nye runtime-credentials), men
`docker compose ... up -d postgres` feilet: `required variable JARVIS_DB_ADMIN_PASSWORD is missing a
value`, til tross for at verdien FAKTISK sto riktig i `.env`.

**Root cause (funnet, ikke gjettet):** `docker compose`s EGEN `${VAR}`-interpolasjon inne i selve
compose-YAML-filen (f.eks. `POSTGRES_PASSWORD: "${JARVIS_DB_ADMIN_PASSWORD:?...}"`) bruker et ANNET
`.env`-oppslag enn tjenestenes `env_file:`-direktiv (som eksplisitt peker på `../../.env` og alltid har
fungert). Uten et eksplisitt `--env-file`-flagg avgjør Compose selv hvilken mappe den leter i for denne
interpolasjonen - scriptets `execFileSync("docker", [...], {cwd: repoRoot})` med en RELATIV `-f
infra/local/docker-compose.yml`-sti ga tvetydig/feil oppslagssted. **Fiks:** alle `docker compose`-kall
i scriptet gir nå eksplisitt `--env-file <absolutt sti til repoRoot/.env>` - garanterer samme fil brukes
for BÅDE `env_file:`-direktivet og compose-filens egen interpolasjon, uansett Compose-versjon eller
"prosjektmappe"-antakelser.

**Sekundær herding (BO-ens eksplisitte ønske, defense-in-depth uavhengig av root cause over):** ny
`modules/core/scripts/lib/q21-env-recovery.ts` - rene, testbare funksjoner:
- `resolveAdminCredentials(current, backupsNewestFirst)`: FRESH CASE (§3) - gjenkjenner
  `JARVIS_DB_USER=postgres` i NÅVÆRENDE `.env` som admin-kandidat når ADMIN-vars mangler, ingen backup
  nødvendig. PARTIAL-MIGRATION CASE (§2, det faktiske host-scenariet) - skanner `.env.bak.*` nyest-først,
  først for egne ADMIN-vars, deretter for en `JARVIS_DB_USER=postgres`-verdi fra FØR en tidligere
  (ufullstendig) kjøring byttet den. Kaster fail-closed (`q21_admin_credentials_unrecoverable`, ingen
  gjetning) hvis INGEN kilde gir gjenopprettbare credentials.
- `resolveRuntimeCredentials`: gjenbruker eksisterende runtime-credentials uendret på idempotent
  re-kjøring - regenererer ALDRI passord uten grunn.
- `validateRequiredEnv`: alle fire (`JARVIS_DB_ADMIN_USER/PASSWORD`, `JARVIS_DB_USER/PASSWORD`) MÅ
  finnes og være ikke-tomme FØR noe skrives - kalt FØR backup/write, ikke etter.
- `buildUpdatedEnvLines`: setter/legger til nøyaktig de fire nøklene, rører aldri andre linjer/kommentarer.
- Hovedscriptet: backup skrives FØRST, deretter atomisk skriv (tmp-fil + `renameSync` - aldri en delvis
  skrevet `.env` synlig for noen annen prosess), og et no-op-hurtigspor (ingen skriving i det hele tatt)
  når `.env` allerede er komplett korrekt.

**Nye tester** (`modules/core/test/q21-env-recovery.test.ts`, 15 tester, ren logikk - ingen fs/Docker/DB):
§8.A (fresh legacy migration via nåværende `.env`), §8.B (partial-migration recovery fra nyeste/riktige
backup, inkl. prioritet egne-ADMIN-vars > postgres-gjetning), §8.C (nekter en ikke-postgres-lik
backup-bruker), §8.D (ingen gyldig kilde → fail-closed, eksplisitt "IKKE endret"-melding), §8.E (rene
returverdier, ingen skjult logging-bivirkning), §8.F/§8.I (idempotent - passord uendret på gjentatt
kjøring), §8.G (validering av komplett sett), §8.H (admin-passord bevart eksakt gjennom
resolve+build-runden), §8.J (admin/runtime forblir distinkte verdier i sluttresultatet).

**Sikkerhet (§9):** ingen `.env`/`.env.bak.*`/volumes/data slettes eller bes slettet noe sted -
eksisterende backup er fortsatt eneste recovery-kilde, urørt av denne fiksen.

**Kvalitet:** 339/339 tester (324 baseline + 15 nye), lint/typecheck/gitleaks rene.

**Status:** samme ÉN kommando som før (`node --experimental-transform-types
modules/core/scripts/fix-q21-runtime-role.ts`) - fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, venter
på Tobias sin faktiske re-kjøring.

## Q-21 SYSTEMBRED FIKS: DB ADMIN/RUNTIME-ROLLE-SPLITT (2026-08-15)

**Host-bevis (Tobias, samme dag som Q-21-diagnosen ble automatisert):**
```
current_user=postgres              session_user=postgres
runtime_db_role=postgres           runtime_role_superuser=true    runtime_role_bypassrls=true    runtime_role_canlogin=true
knowledge_documents_rls=true       knowledge_documents_force_rls=true
knowledge_embeddings_rls=true      knowledge_embeddings_force_rls=true
q21_runtime_role_safe=FAIL
tenant_isolation=BLOCKED_BY_RUNTIME_ROLE     memory_space_isolation=BLOCKED_BY_RUNTIME_ROLE
```
**Konklusjon bekreftet:** RLS-policyene fantes og var FORCE-et - api/worker/migrate kjørte likevel som
Postgres-superbruker (`JARVIS_DB_USER` var satt til samme verdi som `JARVIS_DB_ADMIN_USER` i den
faktiske `.env`). Dette er en ekte systembred runtime-konfigurasjonsfeil, IKKE en UA-2-kode-bug -
RLS er strukturelt umulig å håndheve for en superbruker/BYPASSRLS-tilkobling uansett policy-korrekthet.

**Root cause (uendret fra forrige runde, nå fikset permanent):** `jarvis_app` (005_rls.sql) er en
`NOLOGIN`-gruppe-rolle - ingen sted i den faktiske driftsveien (`migrate-main.ts`,
`docker-compose.yml`) opprettet en ekte `LOGIN`-rolle bundet til den; kun suitens test-oppsett gjorde
det.

**Fiks - permanent admin/runtime-config-splitt (§1-§4 i BO-en):**
- `modules/core/src/db/pool.ts`: `configFromEnv()` er RUNTIME-config (leser `JARVIS_DB_USER`/
  `PASSWORD`, default-bruker endret fra `jarvis_app` - som aldri kunne logges inn med - til
  `jarvis_runtime`, en ekte bootstrappbar rolle). Ny `adminConfigFromEnv()` er ADMIN-config (leser
  `JARVIS_DB_ADMIN_USER`/`PASSWORD`) - to DISTINKTE lesere av to distinkte variabelsett, ingen
  fallback mellom dem noe sted.
- `modules/core/src/services/runtime-role.ts` (ny): `ensureRuntimeRole(adminPool, {user,password})` -
  idempotent, admin-kjørbar bootstrap som sikrer `jarvis_runtime` finnes som LOGIN-rolle, eksplisitt
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, `GRANT`et inn i `jarvis_app` (samme grants/RLS
  som gruppe-rollen allerede har - ingen ny parallell permission-modell). Nekter eksplisitt å
  bootstrappe `jarvis_app` selv som runtime-bruker. `checkRuntimeRoleStatus()`/`assertRuntimeRoleSafe()`
  (ren lesing) og `assertRuntimeCredentialsConfigured()` (fail-closed FØR tilkobling forsøkes -
  kaster hvis `JARVIS_DB_USER` mangler, er tom, er identisk med admin-brukeren, eller er `jarvis_app`).
- `apps/api/src/migrate-main.ts`: kjører nå på `adminConfigFromEnv()` (CREATE ROLE/ALTER TABLE...
  ENABLE RLS/CREATE EXTENSION krever admin-privilegier) og kaller `ensureRuntimeRole()` i samme
  kjøring - bootstrapper runtime-rollen automatisk hver gang migrasjoner kjøres, idempotent.
- `apps/api/src/main.ts`/`worker-main.ts`: uendret på `configFromEnv()` (RUNTIME) for sin egen pool,
  men nå med fail-closed startup-vakter (`assertRuntimeCredentialsConfigured()` FØR tilkobling,
  `assertRuntimeRoleSafe(pool)` RETT ETTER) - prosessen logger en tydelig JSON-feil og avslutter
  (`process.exit(1)`) i stedet for å starte videre med en usikker/manglende DB-rolle.
- `.env.example`: `JARVIS_DB_USER` default endret til `jarvis_runtime` (var `jarvis_app` - alltid
  ubrukelig som bokstavelig login-verdi), utvidet forklarende kommentarer om admin- vs. runtime-splitten.
- `infra/local/docker-compose.yml`: forklarende kommentarer lagt til migrate/api/worker-tjenestene
  (ingen funksjonell endring nødvendig - separasjonen skjer i KODEN, ikke i hvilke env-variabler hver
  container ser, siden `configFromEnv()`/`adminConfigFromEnv()` leser disjunkte variabelsett).

**Automatisert host-fiks (§5 i BO-en):** `modules/core/scripts/fix-q21-runtime-role.ts` - ÉN
host-kommando (`node --experimental-transform-types modules/core/scripts/fix-q21-runtime-role.ts`,
kjøres fra repo-roten PÅ HOSTEN):
1. Leser `.env`, beholder admin-credentials uendret.
2. Genererer trygge runtime-credentials (`jarvis_runtime` + tilfeldig passord) hvis dagens
   `JARVIS_DB_USER` er tom, lik admin-brukeren, eller `jarvis_app`.
3. Sikkerhetskopierer `.env` FØR endring (`*.bak.<timestamp>`).
4. Skriver oppdatert `.env` (aldri logger passordverdien).
5. `docker compose up -d postgres` (rører ALDRI volumes).
6. `docker compose run --rm migrate` (bootstrapper `jarvis_runtime` idempotent via `ensureRuntimeRole`).
7. `docker compose up -d --force-recreate api worker` (tvinger re-lesing av ny `.env`).
8. Verifiserer FAKTISK direkte mot Postgres (egen tilkobling som runtime-rollen): `rolsuper=false`,
   `rolbypassrls=false`, `rolcanlogin=true`, medlemskap i `jarvis_app` via `pg_auth_members` - kaster
   hvis fortsatt usikker, ingen fake PASS.
9. Kjører `ua2-p0-live.ts` automatisk til slutt (samme eksisterende script, urørt).

Idempotent (trygt å kjøre flere ganger), ingen factory reset, ingen volume-sletting, ingen tap av
eksisterende data.

**Nye tester (§10 A-L i BO-en):**
- `modules/core/test/runtime-role.test.ts` (6 tester, embedded Postgres): A-D (LOGIN/NOSUPERUSER/
  NOBYPASSRLS/medlem av jarvis_app), idempotens (kjør 2x, passord oppdateres, ingen duplikat-rolle),
  nekter jarvis_app som runtime-bruker, `assertRuntimeRoleSafe` kaster for superbruker-tilkobling,
  §J (tenant-RLS) og §K (memory-space-RLS på `knowledge_documents`) med den bootstrappede rollen.
- `modules/core/test/db-config-split.test.ts` (10 tester): §E/H (`configFromEnv`/`adminConfigFromEnv`
  leser disjunkte variabelsett, aldri hverandres), §I (`assertRuntimeCredentialsConfigured` fail-closed
  for manglende/identisk-med-admin/jarvis_app-runtime-bruker).
- `apps/api/test/db-role-wiring.test.ts` (8 tester): §F/G/H - tekstbaserte regresjonsvakter som
  beviser `main.ts`/`worker-main.ts` bruker `configFromEnv` (aldri `adminConfigFromEnv`) og har
  fail-closed-kallene, `migrate-main.ts` bruker `adminConfigFromEnv` + `ensureRuntimeRole`
  (`main.ts`/`worker-main.ts` er side-effekt-skript som kobler til DB idet de importeres - kan ikke
  trygt importeres direkte i en test, derfor tekstbasert wiring-vakt i stedet).
- **§L (eksisterende UA-0/UA-1/D-30-baner beholder DB-tilgang):** bevist ved at HELE den eksisterende
  suiten (300 tester på tvers av core/memory/tool-gateway/tasks/watchdog/voice/api) fortsatt er
  100% grønn - disse har ALLTID koblet til via en `jarvis_app`-medlem LOGIN-rolle i sitt eget
  test-oppsett (samme mønster `ensureRuntimeRole` nå formaliserer), så uendrede grants der er allerede
  det sterkeste beviset ingen eksisterende tilgang ble fjernet.

**Sidefunn:** `modules/core`/`modules/knowledge` sine `scripts/`-mapper var ALDRI inkludert i
`tsconfig.json` sin `include`-liste - `pnpm typecheck` har derfor stille aldri faktisk kompilert
`ua2-p0-live.ts` eller det nye `fix-q21-runtime-role.ts` frem til nå. Lagt til `"scripts"` i begge
sine `include`-lister (kun disse to pakkene - urelaterte pakkers `scripts/`-mapper er utenfor scope
her og ikke rørt).

**Kvalitet:** 324/324 tester (300 baseline + 24 nye), lint/typecheck/gitleaks rene.

**Status: FIXED_SUITE / READY_FOR_HOST_VERIFY - IKKE VERIFIED.** Venter på Tobias sin faktiske kjøring
av `fix-q21-runtime-role.ts` på hosten og bekreftelse av `q21_runtime_role_safe=PASS`/
`tenant_isolation=PASS`/`memory_space_isolation=PASS` live.

## Q-21 AUTOMATISK HOST-DIAGNOSE (2026-08-15, samme dag som RLS-host-blockeren)

**Bestilling:** ikke be Tobias kjøre separate SQL-/Docker-/`.env`-diagnosekommandoer - ÉN
host-kommando (samme som før) skal automatisk avgjøre Q-21 og kjøre isolasjons-acceptance deretter.

**Endring i `ua2-p0-live.ts`:** forrige rundes fiks (bootstrappet en DEDIKERT non-bypass rolle KUN
for isolasjons-testen, uavhengig av hva `JARVIS_DB_USER` faktisk er) erstattet med en direkte
diagnose av den FAKTISKE runtime-rollen:
- Ny `diagnoseQ21()`-seksjon (kjøres FØRST, rett etter pgvector-sjekken) leser via `pool` selv
  (aldri adminPool - vi diagnostiserer nettopp DENNE tilkoblingen): `current_user`/`session_user`,
  `runtime_db_role`/`_superuser`/`_bypassrls`/`_canlogin` (fra `pg_roles`), og
  `knowledge_documents_rls`/`_force_rls` + `knowledge_embeddings_rls`/`_force_rls` separat (fra
  `pg_class`) - ingen produksjonsrolle endres, kun lest.
- `q21_runtime_role_safe = PASS` krever `superuser=false OG bypassrls=false`.
- **Trygg:** §2 (tenant/memory-space-isolasjon) kjøres nå via `sync`/`retriever` DIREKTE (samme
  `pool` som nettopp ble bevist trygg) - ingen lenger separat testrolle. Rapporterer
  `tenant_a_sees_tenant_b`/`tenant_b_sees_tenant_a`/`tenant_a_sees_own` og
  `personal_sees_business`/`business_sees_personal` (innholdsbaserte, ikke rå listelengde - samme
  presisjonsfiks som forrige runde).
- **Ikke trygg:** isolasjons-acceptance kjøres IKKE i det hele tatt - `tenant_isolation` og
  `memory_space_isolation` settes eksplisitt til `BLOCKED_BY_RUNTIME_ROLE` (ny `Verdict`-variant,
  ALDRI fake PASS), med presis logget forklaring på nøyaktig hva som må fikses
  (`JARVIS_DB_USER` → en `NOSUPERUSER NOBYPASSRLS`-rolle, medlem av `jarvis_app`).
- `adminPool` (JARVIS_DB_ADMIN_USER/PASSWORD) brukes fortsatt, men KUN til orkestrering (kast-tenant-
  provisjonering/opprydding) - aldri som bevis for RLS, og aldri til å endre `JARVIS_DB_USER` sin
  rolle automatisk.

**Kvalitet:** 300/300 tester (uendret - ingen ny gjenbrukbar logikk introdusert, kun harness-
omskriving), lint/typecheck/gitleaks rene.

**Status:** samme ÉN kommando som før: `node --env-file=.env --experimental-transform-types
modules/knowledge/scripts/ua2-p0-live.ts`. Venter fortsatt på Tobias sin kjøring - denne runden gir
ham nå BÅDE Q-21-svaret OG (hvis trygt) et faktisk `tenant_isolation`/`memory_space_isolation`-PASS/
FAIL i samme output.

## UA-2 P0 HOST ACCEPTANCE HARNESS + RLS HOST-BLOCKER (2026-08-15)

**Harness bygget (forrige runde):** ett host-script, `modules/knowledge/scripts/ua2-p0-live.ts`
(kjøres `node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p0-live.ts`),
beviser hele UA-2 P0-akseptansen mot ekte lokal Postgres/pgvector + ekte filsystem på Tobias sin
Windows-host. Gjenbruker eksisterende arkitektur (ingen alternativ testimplementasjon).

**HOST-RESULTAT (Tobias, 2026-08-15):** 13/15 felt PASS live (filesystem full livssyklus, provenance,
FTS/vector/hybrid, filsystem-allowlist/traversal-deny, GitHub live sync+resync-dedupe `created=2`→
`unchanged=2`, `duplicate_documents=0`). `symlink_escape=SKIPPED_HOST_PERMISSION` (akseptabelt - suite
dekker escape-DENY deterministisk). **BLOCKER:** `tenant_isolation=FAIL` (a_ser_b=2, b_ser_a=2,
a_finner_egen=2) og `memory_space_isolation=FAIL` (personal_ser_business=3, business_finner=3).

**Root cause (undersøkt, ikke gjettet):** harnesset kjørte isolasjons-ASSERTIONS via `pool`
(`configFromEnv()`/`JARVIS_DB_USER` - SAMME tilkobling api/worker/migrate faktisk bruker) UTEN
noensinne å verifisere rollens bypass-status. `jarvis_app` (005_rls.sql) er en `NOLOGIN`-gruppe-rolle -
INGEN sted i den faktiske driftsveien (`migrate-main.ts`, `docker-compose.yml`) oppretter en ekte
`LOGIN`-rolle `GRANT`et inn i den; kun suitens `beforeAll`-oppsett gjør det. Dette betyr Tobias sin
reelle `.env` mest sannsynlig peker `JARVIS_DB_USER` på en superbruker (samme som
`JARVIS_DB_ADMIN_USER`) for at systemet i det hele tatt skal koble til - en superbruker bypasser RLS
UANSETT policy-korrekthet. Se **Q-21 i OPEN_QUESTIONS.md** - dette er et systembredt
deployment-/konfigurasjonsgap (ikke UA-2-spesifikt; docker-compose/migrate-main.ts er BEVISST urørt,
utenfor denne BO-ens scope), rapportert til Tobias for egen beslutning.

**Fiks (isolasjons-seksjonen i harnesset omskrevet, resten av harnesset urørt):**
- Bootstrapper nå en FERSK, garantert non-bypass rolle (`NOSUPERUSER NOBYPASSRLS`, `GRANT jarvis_app
  TO ...`, samme mønster som ALLE suite-tester alltid har brukt) via en separat admin-tilkobling
  (`JARVIS_DB_ADMIN_USER`/`_PASSWORD`, allerede i `.env.example`/docker-compose). Isolasjons-BEVISET
  kjøres UTELUKKENDE gjennom denne rollen - aldri gjennom en tilkobling med uverifisert privilegiestatus.
- Ny §6-diagnostikk skrevet til output FØR assertions: `rls_test_role`, `rls_role_superuser`,
  `rls_role_bypassrls`, `knowledge_rls_enabled`, `knowledge_force_rls` - fail-closed (rapporterer
  `FAIL` med forklaring) hvis test-rollen mot formodning skulle rapportere bypass, ELLER hvis skjemaet
  mangler ENABLE/FORCE ROW LEVEL SECURITY (skiller eksplisitt HARNESS FEIL fra RUNTIME FEIL - RLS ble
  ALDRI svekket for å gjøre testen grønn).
- Ny transparens-diagnostikk for `pool` (den faktiske app-konfigurerte tilkoblingen): `configured_app_role`/
  `_superuser`/`_bypassrls`, med eksplisitt advarsel i loggen hvis JARVIS_DB_USER selv er en
  superbruker - direkte relevant for å tolke §1/§4/§5 sine tidligere PASS-resultater riktig (de øvde
  aldri en cross-tenant/cross-space DENY-vei, så de er IKKE bevis på RLS-håndhevelse alene).
- Opprydding (tenant-provisjonering/sletting av kast-tenants, sletting av synteststed-dokumenter)
  flyttet fra `pool` til admin-tilkoblingen - `jarvis_app` har bevisst INGEN `DELETE`-grant noe sted
  (append-only-prinsipp), så disse operasjonene var uansett aldri korrekte via app-rollen.
- **Presisjonsfunn under regresjonstest-skrivingen:** rå listelengde (`results.length === 0`) er IKKE
  et presist mål for "ingen lekkasje" - `LocalHashEmbedding` (enkel trigram-hash) kan legitimt gi en
  tenants EGET nesten-like dokument som svak vektor-treffkandidat på en trigram-lik spørring om en
  ANNEN tenants fakta, uten at RLS er brutt. Assertions i BÅDE harnesset og de nye suite-testene sjekker
  nå om det FAKTISKE innholdet fra den andre tenanten/spacet dukker opp (`content.includes(...)`), ikke
  bare om listen er tom - samme presiseringsmønster som allerede fantes i
  `knowledge-fundament.test.ts` §7.G/§7.H.

**Nye regresjonstester** (`modules/knowledge/test/rls-role-isolation.test.ts`, embedded Postgres, 6
tester, dekker BO-ens §5.A-K): tenant-isolasjon via non-bypass rolle + `KnowledgeRetriever` (A-D),
memory-space-isolasjon innen samme tenant (E-F/I), FTS-spørringen ALENE respekterer space (G),
vektor-spørringen ALENE respekterer space (H), tombstone+isolasjon samtidig (J), og **§K: eksplisitt
kontrast-bevis** - samme spørringstekst gir cross-tenant-data via en superbruker-tilkobling (ingen
tenant-filter i SQL-teksten - stoler utelukkende på RLS, akkurat som `retriever.ts` er skrevet) men
korrekt 0-treff via den non-bypass-rollen - dokumenterer eksakt bug-klassen som forårsaket
host-blockeren, som permanent suite-bevis.

**Kvalitet:** 300/300 tester (294 baseline + 6 nye), lint/typecheck/gitleaks rene. Ingen regresjon.

**Status: BLOCKED - venter på Tobias sin re-kjøring** av oppdatert `ua2-p0-live.ts` på hosten.
UA-2 P0 kan IKKE settes VERIFIED/merges før `tenant_isolation=PASS` og `memory_space_isolation=PASS`
er bekreftet live gjennom den non-bypass-rollen.

## UA-2 P0 — KNOWLEDGE INGESTION FOUNDATION (2026-08-14)

**Status ved bygging: SUITE-VERIFIED, IKKE host/live-verifisert** (bygget i sky-container - ingen
Docker, ingen ekte GitHub-PAT, ingen ekte NAS-mount tilgjengelig i byggemiljøet). **OPPDATERT
2026-08-15: nå PRODUCTION_VERIFIED (host-bevist, run_id `778bb87d`) - se D-39 og "Q-21 CLOSURE +
UA-2 P0 CLOSURE"-seksjonen øverst i dette dokumentet for full host-evidens.** Historisk
suite-bygge-logg beholdt uendret under. Første byggbare UA-2-skive,
godkjent av Tobias etter spec-runden (PR #3). Full arkitektur/rasjonale i
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (UA-2 P0-seksjonen) og
[UA2_KNOWLEDGE_DPIA.md](UA2_KNOWLEDGE_DPIA.md).

**Arkitektur (`modules/knowledge`, ny pakke `@jarvis/knowledge`):**
- `KnowledgeSource`-kontrakt (provider-uavhengig: source_type/source_instance_id/external_id/
  canonical_uri/title/content/content_type/content_hash/modified_at/metadata - ingen credentials i
  kontrakten).
- `FilesystemKnowledgeSource`: allowlistet root, `realpath()`-verifisering FØR hver fil leses (§10) -
  path-traversal og symlink-escape til utenfor roten er strukturelt umulig, ikke bare filtrert i
  ettertid. Tekstformater (.md/.txt/.json/.yaml/.ts/.js/.py/.sql/.html/.css); binær/OCR/PDF eksplisitt
  utenfor P0.
- `GithubKnowledgeSource`: går via EKSISTERENDE `ToolGateway` (samme policy/audit/credential-vei som
  `daily-brief.ts`) - ny `read_repo_meta`-action lagt til `GithubTransport` (samme PAT/scope som
  `read_issues`, ingen scope-utvidelse). Repo-fil-innhold IKKE bygget (transporten støtter det ikke
  uten en større connector-endring - dokumentert som neste skive, ikke stille utelatt).
- `KnowledgeSyncService`: idempotent sync-rapport (scanned/created/updated/unchanged/tombstoned/
  reactivated/failed). Canonical identity = `(tenant_id, source_type, source_instance_id, external_id)`
  UNIQUE-constraint (migrasjon `017_knowledge.sql`); `content_hash` avgjør re-embedding (aldri ved
  uendret innhold - bevist ved å telle faktiske `embed()`-kall i test). En FEILET listing (nettverk/
  credential) tombstoner ALDRI eksisterende dokumenter - kun en vellykket listing kan tombstone det som
  manglet i den.
- `KnowledgeRetriever`: FTS + vector hybrid, samme `pgvector`/`cosine_sim`-fundament som
  `MemoryRetriever` (D-28) - INGEN ny retrieval-stack. Tombstonede dokumenter alltid ekskludert.
  Fullstendig provenance (kilde/instans/ekstern-id/URI/hash/versjon/sist-synket/endret) på hvert
  resultat - aldri modellgenerert.
- Storage: `knowledge_documents`/`knowledge_embeddings`, SAMME RLS-mønster som `memory_items`
  (tenant_id OG memory_space_id håndhevet i databasen via RESTRICTIVE policies) - ingen ny database.

**Suite-verifisert (embedded Postgres + ekte filsystem-I/O, `modules/knowledge/test/`):**
- Hele livssyklusen i én sammenhengende test: ingest → uendret resync (no-op, ingen duplikat, ingen
  re-embedding) → endret fil (samme canonical document, ny versjon/hash) → slettet fil (tombstone, IKKE
  hard-delete) → tombstonet dokument usynlig i retrieval → gjenopprettet fil MED samme innhold
  (deterministisk reaktivering).
- En feilende kilde rapporteres `failed`, tombstoner ALDRI eksisterende data ved siden av.
- Tenant-isolasjon: tenant A finner aldri tenant B sitt innhold (og omvendt), egen kunnskap fungerer
  normalt.
- Memory-space-isolasjon: søk i `personal` finner aldri `business`-space-innhold.
- Filsystem-sikkerhet: allowlistede tekstformater; symlink UT av roten hoppes over (scanningen
  fortsetter, stopper ikke på én ondsinnet lenke); symlink INNENFOR roten fungerer normalt; `../`
  i konfigurert path er strukturelt ufarlig (`resolve()`-basert rot).
- GitHub-kilde: repo-metadata + issues mappes korrekt til `KnowledgeRecord`; går gjennom ekte
  `ToolGateway`-policy/audit; manglende registrert transport gir `unknown_tool`-DENY (håndtert som
  "ingen record", ikke krasj); full sync + idempotent resync mot embedded PG.
- Vektor-mekanisme: `cosine_sim`-verdier for nesten-identisk innhold ligger godt over retrieverens
  0,4-terskel, godt over urelatert innholds similarity.
- Hybrid ranking: relevant treff rangeres øverst med korrekt provenance; urelatert innhold dominerer
  ikke toppen.
- **Regresjon funnet og fikset underveis:** å sette inn `read_repo_meta` MIDT i `firstWaveTools()`-
  arrayet forskjøv posisjonsindekser to eksisterende tester i `fase7-tools.test.ts` brukte
  (`firstWaveTools({...})[4]`/`[7]`) - flyttet til SLUTTEN av arrayet i stedet; ingen testfil endret.

**IKKE host/live-verifisert (§13 i BO - krever Tobias sin host):**
- Ekte NAS-mount som allowlistet root (kun lokale tmp-mapper i byggemiljøet).
- Ekte GitHub-repo-sync med reell `JARVIS_GITHUB_TOKEN` (kun `FakeTransport` i suiten).
- Ende-til-ende-demoen fra §13 kjørt PÅ HOSTEN: ingest allowlistet mappe → spør om et konkret faktum →
  få svar med korrekt provenance → endre filen → resync → se ny versjon → slett filen → resync → se at
  slettet dokument IKKE returneres. (Denne sekvensen ER suite-verifisert i sky-containeren mot ekte
  lokalt filsystem + ekte embedded Postgres - se testen over - men det er IKKE det samme som å kjøre
  det på Tobias sin faktiske host/NAS/GitHub-repo.)

**Bygges IKKE i P0 (uendret fra godkjent forslag):** Knowledge Graph/GraphRAG, Obsidian/Pieces/Google
Drive/e-post/møtetranskripsjon-ingest, OCR/vision-ingest, autonom web-crawling, UA-3-forretningslogikk,
voice-ytelsesoptimalisering, skriving tilbake til kildene.

**Kjent åpent gap (Q-20, ikke skjult):** kun myk sletting (tombstone) - ingen hard-delete/GDPR-
purge-vei ennå. Dokumentert i DPIA-notatet, ikke løst her (utenfor P0-scope).

**Kvalitet:** 294/294 tester (281 baseline fra D-30-lukkingen + 13 nye: filsystem-source×5,
github-source×2, knowledge-fundament×6), lint/typecheck/gitleaks rene. Ingen regresjon i UA-0/UA-1/D-30
(identitet, sovereign authority, Tool Gateway, minne, RLS - alle eksisterende suiter uendret grønne).

## BO-12 — D-30 VOICE FOUNDATION (2026-08-14)

**Status: D-30 P0 = VERIFIED (host-runde 6, se "D-30 FINAL CLOSURE — HOST VERIFIED" under for
fullstendig evidens-tabell).** Historikken under er bevart som byggerekkefølgen (sky-container →
suite-verifisert → host-live funn/fiks-runder → verifisert lukking) - kun DENNE statuslinjen er
kanonisk gjeldende.
Bygget i sky-container uten nøkler/Docker; live-porten lukkes på hosten med
`node --env-file=.env --experimental-transform-types apps/voice-gateway/scripts/bo12-voice-live.ts`
(host-bevist kommando: `--experimental-strip-types` feilet på Node 24-host med
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX pga. TS parameter properties; transform-types kreves.
Krever OPENAI_API_KEY + kjørende jarvis-api; mikrofon trengs ikke - norsk testlyd
genereres via TTS→STT-rundtur; dekker §30-§33 inkl. barge-in-abort og cross-provider).

**Voice er transportlag over Jarvis (§50):** samme Conversation/AI Mesh/Tool Gateway/
authority/minne som tekst - tale gir ingen ekstra authority (§43). Bygget som DELTA på
fase 5-fundamentet (VoiceSession/VAD/STT-TTS-adaptere/WS-transport/WER-benchmark):
- **Streaming Core-klient (§12-§13):** HttpCoreClient.chatStream mot eksisterende
  /chat-SSE (P1A) - tokens → SentenceChunker (aldri halvferdige ord; splitter ikke
  "18.30") → sekvensiell TTS-kø. TTS starter på første setning FØR generering er
  ferdig (testbevist). Tool-events → korte norske statuser ("Sjekker kalenderen …",
  §26) - aldri intern JSON/payload i tale (§14/§27).
- **Barge-in (§15-§17):** tale under speaking/thinking → stopp avspilling + tøm
  TTS-kø + forkast chunker-buffer + ABORT modellgenerering upstream (P1A-kjeden) +
  interrupted-state + ny tur. Epoch-vern: gammel lyd kan aldri spilles etter ny tur
  (§16, testbevist med taggede rammer). Utført verktøy rulles aldri tilbake (§17 -
  journal + ToolGateway-idempotens).
- **Tilstandsmaskin (§23):** idle/listening/thinking/speaking/interrupted eksplisitt;
  start-melding = eksplisitt mikrofonaktivering; ingen skjult opptak.
- **Feilbaner:** STT-feil → normalisert `stt_error`, ALDRI modellkjøring på tom/
  ugyldig transkript (§35); TTS-feil → tekstsvaret leveres uansett, `tts_error`
  normalisert uten detaljer, helse DEGRADED (§36/§27). Fixtures (§28): kort/lang,
  pause midt i setning (bryter ikke turen), støy, ingen tale, avbrutt tale.
- **Metrics (§19-§20):** full latenskjede per tur (t_final_transcript,
  t_model_first_token, t_first_tts_request, t_tts_first_frame, hovedmål
  end_of_speech_to_first_audio_ms) + stt_audio_ms/tts_chars som kost-grunnlag
  (STT/LLM/TTS holdes adskilt). summarizeLatency gir P50; P95 kun ved ≥20 samples
  (§39 - aldri fake presisjon). Faktiske måltall settes av host-live/benchmark.
- **Helse (§36-§37):** VoiceHealth (stt/tts LIVE/DEGRADED/UNAVAILABLE fra faktiske
  kall), gateway /status (transport/stt/tts/barge_in/audio_persistence=none);
  api-/status viser voice-helse når JARVIS_VOICE_URL er satt.
- **Cross-provider (§33):** valgfri provider-override i /chat (router §38-semantikk)
  - voice-pipelinen er identisk uansett LLM (testbevist openai vs anthropic).
- **Personvern (§22):** rå lyd persisteres aldri (strukturelt testbevist: ingen
  filskriving i lydkjedens moduler); transcript følger eksisterende
  conversation-semantikk. STT/TTS-baseline: OpenAI (nøkkel alt live i runtime, §5-§7);
  andre providere bak samme adapterlag etter D-10-benchmark.
- **Kvalitet:** 264/264 (248 baseline + 16 nye), lint/typecheck/gitleaks rene.
  Eksisterende fase 5-akseptanser (barge-in ≤250 ms, median <1500 ms med test-
  adaptere, failover-idempotens, sesjonskontinuitet tekst↔tale) fortsatt PASS -
  e2e kjører nå den nye streaming-banen mot ekte api-SSE.

**Gjenstår for D-30 P0 = VERIFIED:** host-live (§30-§33 via scriptet over) + reelle
latens-/kostmålinger (§38-§39) + D-10-benchmark (≥100 norske prøver) for providervalg.

### D-30 LIVE FINDINGS FIX — Conversation tool bridge (2026-08-14)

Første EKTE host-live-kjøring (Windows-host m/Docker+credentials) beviste: runtime healthy,
ekte OpenAI TTS/STT (norsk) PASS, no-tool voice-rundtur PASS ("18 ganger 7" → "126"),
OpenAI- og Anthropic-LLM-voice-path PASS, barge-in/abort upstream PASS, next-turn recovery
PASS — men **kalender-voice FEILET funksjonelt** (`tools=[]`, "har ikke tilgang til
kalenderen"). Root cause + fix (denne runden, suite-verifisert i sky - IKKE nye live-claims):
- **ConversationEngine hadde aldri tool-broen fra BO-11:** fase-3-wiring brukte
  `gateway.stream/complete` uten tools, og system-prompten sa eksplisitt "ikke tilgang til
  verktøy". Fikset: `ConversationDeps.tools {definitions, executorFor(identity)}` →
  `gateway.completeWithTools` for BÅDE streaming- og JSON-banen (samme normaliserte
  tool-løkke som executive; ingen voice-spesifikk sidevei). Prompt oppdatert (ingen
  permissions i prompt - Policy/Authority forblir trusted runtime).
- **Identity-binding:** executor bindes til samtalens RESOLVED identity per kall
  (`executorFor(identity)` → `MeshToolExecutor(toolGateway, identity)`) - aldri global
  ownerIdentity - tenant/delegation/authority følger den som snakker (testbevist m/2 tenants).
- **SSE `tool_call`-event:** `tool_call_complete` → `event: tool_call` m/KUN `tool_name`
  (aldri raw args/tool-result; testbevist). Voice-HttpCoreClient forsto allerede eventet.
- **Voice-device-seed:** host-live ga 403 unknown_device for `jarvis-voice-live` (kun
  jarvis-core var seedet). Seed er nå delt idempotent funksjon (`apps/api/src/seed.ts`,
  brukt av one-shot migrate) og inkluderer voice-device (JARVIS_VOICE_DEVICE_ID ??
  jarvis-voice-live, kind=voice, samme konfigurerte owner tenant/person).
- **Host-kommando korrigert** (strip→transform-types, se over) og **STT-akseptansen gjort
  semantisk robust** (`apps/voice-gateway/src/acceptance.ts`: "atten ganger sju" ≙
  "18 x 7"/"18 × 7"; terskel uendret - norsk kalender-setning er ikke svekket).

**Neste:** pull ny HEAD på hosten, rebuild api-runtime, re-kjør bo12-voice-live.ts
(kalender-flyten skal nå gi `tools=[read_calendar_today]`), og lukk D-30 P0 på evidensen.

### D-30 FINAL HOST ACCEPTANCE HARDENING (2026-08-14, runde 3)

Windows-host bekreftet (runde 2): API healthy, norsk TTS→STT PASS, ConversationEngine
tool bridge PASS (`tools=[read_calendar_today]`, ekte kalendersvar), no-tool/OpenAI/
Anthropic voice-path PASS, upstream-generation-cancellation PASS, ren neste tur PASS.
Denne runden lukker gatene bo12-voice-live.ts IKKE beviste: ekte lyd-barge-in (ikke
bare LLM AbortSignal), stale-audio-epoch med eksplisitte tellere, kontrollert failure-
recovery (STT/TTS/provider/disconnect), 10-tur soak, Q-18-repro, full latenskjede,
observability-korrelasjon. **Ingen av gatene under er kjørt LIVE i sky-containeren -
kun suite-verifisert her + nye host-scripts levert for hosten.**

- **§1/§2 Real audio barge-in + stale-audio-epoch (host-script, IKKE kjørt her):**
  `bo12-voice-live.ts` har ny seksjon "D-30 HARDENING §1/§2" - full `VoiceSession`
  (ekte VAD→STT→Core→TTS, IKKE en isolert `AbortController`), "brukerens" barge-in
  spilles inn som EKTE TTS-lyd gjennom `pushAudio()` (samme rundtur-teknikk som §30).
  Rapporterer `barge_in_audio_stop_ms` (fra `onTtsCancelled`, dvs. `playback.cancel()`-
  signalet - eksplisitt SKILT fra `activeTurnAbort` som er LLM-siden) med
  ≤250ms-gate-sjekk, og et eksplisitt 500ms-settle-vindu der ENHVER TTS-ramme fra
  turn A etter barge-in feiler scriptet hardt (`staleFramesAfterBarge > 0` →
  kastet feil). Deterministisk stale-audio-bevis finnes FRA FØR i suiten
  (`d30-foundation.test.ts` "Barge-in": taggede rammer `S{n}-f{i}`, bevist 0 gamle
  tagger etter ny epoch) - host-scriptet legger til det ekte lyd-laget.
- **§3 Failure recovery - fault injection (suite-verifisert, ikke live-fremprovosert
  per ordre):** A (STT) og B (TTS) var alt dekket; NYE tester lagt til:
  - **C (provider/model-feil FØR output):** `chatStream` kaster FØR første token →
    normalisert `core_error`, state går til `listening` (ingen zombie), rå
    feilmelding (inkl. simulert secret-streng) krysser ALDRI til klient-events,
    neste tur fungerer uendret.
  - **D (klientdisconnect):** **FUNN + FIKS** - `VoiceSession` hadde INGEN
    `disconnect()`-håndtering og `server.ts` lyttet aldri på WS `close`. En
    frakoblet klient midt i en tur lot modellgenereringen fortsette som zombie
    (bortkastet modell-/TTS-kost, ingen mottaker). Fikset: ny
    `VoiceSession.disconnect()` (bumper epoch, tømmer TTS-kø, aborterer
    `activeTurnAbort` upstream - symmetrisk med `bargeIn()`) wiret til
    `ws.on("close", ...)`. Testbevist: abort skjer, `coreReturned` blir aldri
    sann, ny sesjon etterpå fungerer. **Denne wiringen er unit-/suite-testet,
    IKKE host-live end-to-end testet** (krever ekte WS-klient mot en kjørende
    voice-gateway-prosess - dokumentert gjenstående host-steg, ikke påstått
    VERIFIED live).
- **§4 10-tur host-soak (nytt script, IKKE kjørt her):**
  `apps/voice-gateway/scripts/bo12-voice-soak.ts` - ÉN sammenhengende
  `VoiceSession` gjennom 10 turer (no-tool/kalender/normal/tvunget OpenAI/tvunget
  Anthropic/ekte barge-in-kansellering av en pågående tur/kalender-repetisjon for
  Q-18). Feiler hardt på: <10/10 fullførte turer, >1 observert `session_id`
  (sesjonskontinuitet brutt), duplikate verktøystatuser i samme tur, korrupt
  sesjon, eller kansellert siste tur. Full latenskjede logges per tur.
- **§5 Q-18 (tool-dedupe på A-klasse read i samme session) - REPRODUSERT, BLOKKERER
  IKKE dette, men er BLOCKER for repetert kalenderspørring i samme sesjon.** Se
  OPEN_QUESTIONS.md Q-18 for fullt bevis (`q18-read-dedupe.test.ts`, 2 tester mot
  ekte embedded PG) + foreslått minste fix (IKKE implementert - egen BO kreves).
  `bo12-voice-soak.ts` turn 6/10 gir en live-observerbar krysssjekk av samme funn.
- **§6 Latenskjede:** `TurnMetrics` utvidet med `t_tool_activity` (tidspunkt trusted
  tool-status varsles); ny `latencyLine()`-formatterer i begge live-scripts
  rapporterer `stt`/`model_ttft`/`tool`/`tts_ttfa`/`e2e_first_audio`/`total_turn`
  per tur - ingen fabrikkerte tall, kun det som faktisk er målt (`-`/`n/a` når et
  tidsstempel mangler, f.eks. `tool` for turer uten verktøykall). Kjente
  host-tall fra runde 2 (funksjonelt PASS, men trege: kalender 8263ms, no-tool
  3633ms, OpenAI 5761ms, Anthropic 4093ms end_of_speech→first_audio) er IKKE
  reoptimalisert i denne runden (eksplisitt utenfor scope: "korrekt baseline
  først").
- **§7 Observability-korrelasjon:** basert på kombinert bevis (IKKE en ny live
  DB-spørring fra voice-gateway-prosessen, som ikke har poolgang til api sin
  Postgres over prosessgrensen) - BO-10/BO-11 har alt live-verifisert
  session_id/provider/kost i `cost_events` + Langfuse; D-30-live-funn-fix-runden
  (denne branchen, commit før denne) testbeviste at `tool.executed`-audit-rader
  er korrekt tenant/session-tagget for BÅDE owner- og cross-tenant-identiteter.
  Ingen rå lyd i noen av disse sporene (strukturelt testbevist fra før).
- **Kvalitet:** 277/277 (273 + 4 nye: provider-feil-før-output, klientdisconnect,
  2× Q-18-repro), lint/typecheck/gitleaks rene. Ingen regresjon: sovereign owner,
  delegert identitet, D-class, Tool Gateway, P1A-fallback, cross-provider
  tool-resume, kalender-tool-bro - alle eksisterende suiter uendret grønne.

**D-30-anbefaling denne runden: fortsatt PARTIAL.** Suite-nivå er komplett og
grønt; de nye host-scriptene (§1/§2/§4) og WS-disconnect-wiringen (§3D) er IKKE
kjørt mot ekte runtime i denne (sky-)økten - kun levert klare til hosten. D-30
kan først settes VERIFIED når: (a) `bo12-voice-live.ts` §1/§2-seksjonen PASSer
live med `barge_in_audio_stop_ms` rapportert, (b) `bo12-voice-soak.ts` fullfører
10/10 live, og (c) Q-18 enten er akseptert som dokumentert kjent begrensning
(ikke en D-30-blokker i seg selv) eller fikset i egen runde.

### D-30 HOST FAILURE FIX (2026-08-14, runde 4)

Første EKTE host-kjøring av hardening-scriptene (runde 3) fant tre feil. Alle
tre er nå undersøkt (ikke gjettet) og fikset/dokumentert:

- **§1 §32-legacy-testen feilet live** ("forventet AbortError, fikk suksess").
  **Root cause (undersøkt): kategori B (race), IKKE en ødelagt
  kanselleringsmekanisme.** Selve kanselleringskjeden (`res.on('close')` →
  `AbortController` → `ModelGateway.stream` → provider-abort) er BEVIST
  korrekt i suiten mot en EKTE HTTP-server (`fase3-e2e.test.ts` "SSE
  klient-disconnect → upstream abort") - men suite-testen bruker en BEVISST
  treg adapter (millisekunder per token) for å garantere margin. Live mot
  ekte providere er marginen mye trangere: abort ble trigget FØRST etter 5
  tokens, og for en kort/rask generering kan HELE svaret alt være mottatt og
  lokalt bufret av fetch/undici innen abort() kalles - da er det ingenting
  igjen å kansellere, og streamen fullfører normalt. Fiks (§32 uendret
  assertion - IKKE svekket for å bli grønn): abort trigges nå på FØRSTE
  token (ikke femte) og teksten som bes om er vesentlig lengre (500+ ord,
  flere avsnitt) - begge reduserer race-vinduet uten å fjerne kravet om
  AbortError. Feilmeldingen ved ny feiling gir nå diagnostikk (tokens
  mottatt + elapsed ms) som skiller kategori A fra B.
- **§2 Ekte lyd-barge-in-seksjonen kjørte aldri** (avhengig av §32 sin
  suksess i scriptets rekkefølge - ingen egen feil i selve §1/§2-koden).
  Klar til å kjøre når §32 er stabil.
- **§3 Soak turn 8 timet ut** (`FEIL §4: kun 7/10 turer fullførte`).
  **Root cause (undersøkt): test-harness sekvensielt await-race/deadlock,
  IKKE sesjons-korrupsjon i VoiceSession.** Turn 8 er PER DESIGN ment å bli
  avbrutt av turn 9, men den forrige loop-strukturen ventet på turn 8 sine
  EGNE metrics FØR turn 9 sin lyd i det hele tatt ble sendt - siden turn 8
  aldri var ment å fullføre naturlig, timet den ut og turn 9 ble aldri
  utløst. Fiksen (`bo12-voice-soak.ts`): turn 8+9 er nå ETT konkurrerende
  steg - turn 8 sin lyd sendes, harnesset venter KUN til
  `state === "speaking"` (bevis på at generering/avspilling faktisk er
  aktiv), SÅ sendes turn 9 som ekte barge-in-lyd, og TIL SLUTT ventes det på
  BEGGE turers metrics. Ny eksplisitt definisjon av "korrekt cancelled-turn"
  (`isCorrectlyCancelled()`): `cancelled===true` OG `t_speech_start` OG
  `t_tts_first_frame` begge satt - dvs. turen beviselig KOM I GANG MED EKTE
  LYD før den ble kuttet, ikke bare en tur som aldri startet. Deterministisk
  regresjonsbevis for nøyaktig dette konkurrerende mønsteret finnes ALLEREDE
  i suiten (`d30-foundation.test.ts` "Barge-in": venter på `state==="speaking"`
  FØR barge-in-lyd sendes, ALDRI på fullføring først) - denne runden la til
  eksplisitte shape-asserts (`t_speech_start`/`t_tts_first_frame` på den
  kansellerte turen, nøyaktig 2 distinkte metrics-innslag, neste tur IKKE
  kansellert) som speiler `isCorrectlyCancelled()` 1:1.
- **§5/§6 `tools=[read_calendar_today,read_calendar_today]` på ÉN
  kalenderturn - DEFINITIVT AVGJORT VIA KJØRT TEST, ikke gjetting:
  kategori (A) - to SSE/tool_call_complete-events for ÉTT faktisk
  ToolGateway-/transport-kall.** Bevist i
  `modules/tool-gateway/test/same-turn-tool-dedupe.test.ts` (2 tester, ekte
  embedded PG + `ModelGateway.completeWithTools` + `MeshToolExecutor` +
  `ToolGateway`): both en modell som ber om samme verktøy TO GANGER i SAMME
  runde og en modell som ber om det i to ETTERFØLGENDE runder gir 2
  `tool_call_complete`-SSE-events, men KUN 1 faktisk transport-kall -
  `ModelGateway.completeWithTools` sin in-memory `executed`-cache
  (uendret av denne runden) deduper korrekt UANSETT om duplikatet skjer i
  samme eller senere runde INNENFOR én brukertur. Den observerte
  `model_ttft=16041ms`/`e2e_first_audio=17566ms` skyldes derfor en EKSTRA
  MODELLRUNDE (modellen ba om kalenderen på nytt før den svarte -
  `tool_rounds:2` i stedet for forventet `1`), IKKE en ekstra
  ToolGateway-/kalender-transport-utførelse. Nøyaktig ms-fordeling FØR/ETTER
  kan ikke oppgis uten nytt host-tall (ingen fabrikkerte tall) - men
  strukturelt er "duplicate_tool_executions"-tallet fra forrige runde sin
  soak-rapport (som telte SSE/tool_activity-events, ikke faktiske
  utførelser) misvisende navngitt; det måler nå riktig ting siden
  Q-18-fiksen (under) uansett endrer hva som telles som "duplikat" på tvers
  av turer.
- **Q-18 FIKSET (ikke lenger BLOCKER):** `modules/tool-gateway/src/gateway.ts`
  - `tool_executions`-dedupe (database-/sesjonsnivå) gjelder nå KUN C/D
  (`dedupeApplies = capability_class !== "A"`). A-klasse reads utfører alltid
  friskt per brukertur (data kan ha endret seg); write/mutation-dedupe (C/D)
  er UENDRET og fortsatt bevist aktiv
  (`q18-read-dedupe.test.ts` regresjon C). In-memory per-tur-beskyttelse
  (samme modellrunde/tur, samme kall → maks 1 utførelse) var aldri en del av
  bugen og er uendret, bevist separat i `same-turn-tool-dedupe.test.ts`.
  Skillet er nå eksplisitt testet på begge sider: NY brukertur + samme
  lesekall → fersk utførelse (§7.B); SAMME modellrunde/tur + samme lesekall
  → maks 1 utførelse (§7.A).
- **Regresjonstester lagt til/utvidet (§7 A-I):** A/B/C i
  `q18-read-dedupe.test.ts` + `same-turn-tool-dedupe.test.ts`; D (legacy §32)
  uendret dekket av `fase3-e2e.test.ts`; E/F/H utvidet i
  `d30-foundation.test.ts` sin barge-in-test (eksplisitt metrics-shape +
  nøyaktig 2 distinkte turer); G dekket av samme test (turen etter
  kansellering fullfører); I uendret dekket av forrige rundes
  disconnect-test. Ingen regresjon: sovereign/delegert/D-class/Tool
  Gateway-policy/tenant-isolasjon/cross-provider-fallback/cross-provider
  tool-resume/unknown-tool-DENY/write-idempotency - alle eksisterende
  suiter uendret grønne (`ua0-sovereign.test.ts`, `ua1-p1a-dclass-mesh.test.ts`,
  `policy-gateway.test.ts` osv.).
- **Kvalitet:** 279/279 (277 + 2 nye i `same-turn-tool-dedupe.test.ts`;
  `q18-read-dedupe.test.ts` beholdt 2 tester men skriver nå FIKS-bevis i
  stedet for kun reprodusering), lint/typecheck/gitleaks rene.

**D-30-anbefaling denne runden: READY_FOR_HOST_RETEST (fortsatt ikke
VERIFIED).** Alle tre host-funnene er undersøkt til rot og fikset i kode;
suiten er komplett og grønn; INGEN av fiksene er kjørt mot ekte runtime i
denne (sky-)økten. Nye host-kommandoer (uendret fra forrige runde, men med
fikset innhold): `bo12-voice-live.ts` (§32 skal nå PASSE deterministisk,
§1/§2 skal fullføre og gi `barge_in_audio_stop_ms`) og `bo12-voice-soak.ts`
(10/10 skal fullføre, turn 8 skal vise `cancelled=true` med lyd i gang,
kalenderspørring i turn 2/6/10 skal ALLE gi ekte svar).

### D-30 FINAL BARGE-IN HOST BLOCKER (2026-08-14, runde 5)

Host kjørte runde 4s fikser: Q-18-fiksen bekreftet PASS live (kalender
fungerer på gjentatt spørring, `duplicate_tool_executions=0`), men §32 feilet
med NY informasjon som avkreftet forrige runsdes race-hypotese: **0 tokens
mottatt over 35,5 sekunder, deretter suksess** - ikke "modellen var rask nok
til å fullføre", men "ingen inkrementelle token-events ble observert i det
hele tatt". Root cause kan IKKE avgjøres endelig fra sky-container uten
host-tilgang til de faktiske providerne/nettverket - dette er eksplisitt
IKKE gjettet. I stedet:

- **Kodesporing (spørsmål 1.A-F i host-ordren), gjort ved lesing - ingen
  gjetting:** hele kjeden (provider-adapter → `sseLines()` → `ModelGateway.
  executePlan`/`guardedOnEvent` → `ConversationEngine.handle`s `onEvent` →
  `server.ts` sin SSE `send()` → `HttpCoreClient.chatStream`s fetch-parsing)
  er strukturelt IDENTISK for alle requests (kalender/no-tool/forced-provider
  fungerte ALLE live i denne runden) - ingen kodeforskjell funnet som
  spesifikt rammer §32s request. **Ollama/Gemini/Kimi-hypotesen (adaptere uten
  native `stream()`) undersøkt og AVKREFTET ved lesing:** alle tre kaller
  `onToken?.(text)` ubetinget i sin `complete()` (Gemini/Kimi) eller med kun
  tom-streng-guard (Ollama) - selv en tom/enkelt levering ville gitt
  `tokens_mottatt>=1`, ikke eksakt 0. Docker-compose (`infra/local/docker-
  compose.yml`) har INGEN reverse proxy/nginx-buffringslag - api-porten
  eksponeres direkte.
- **Deterministisk sandbox-bevis (KJØRT i denne (sky-)økten - ikke en
  live-host-påstand, et faktisk utført resultat):** en selvstendig probe
  (ekte `createApiServer` + ekte fetch-SSE-klient + embedded Postgres, INGEN
  vitest-mocks) med en kontrollert treg adapter (600 "ord" á 5ms) viste: 600
  distinkte SSE token-mottak spredt over 702ms (første=1ms, siste=694ms -
  ekte inkrementell levering, ikke ett bufret burst), og abort() på FØRSTE
  token ga AbortError etter 19ms. **Dette beviser at HELE vår egen HTTP/SSE/
  ConversationEngine/ModelGateway-kode fungerer korrekt** når en adapter
  faktisk streamer - koden er IKKE generisk buffret. Formalisert som 2 nye
  permanente suite-tester i `fase3-e2e.test.ts` (§8.D): mange distinkte
  SSE-mottak spredt over tid + AbortSignal etter 2 observerte tokens →
  deterministisk AbortError innen 500ms.
- **Server-side diagnostikk lagt til (spørsmål 2, `JARVIS_STREAM_DEBUG=true`):**
  kun type+timing, ALDRI event-innhold/secrets/prompt/svar-tekst. Tre
  punkter: `stream_debug_gateway` (ModelGateway sin `guardedOnEvent` - svarer
  A/B), `stream_debug_conversation` (ConversationEngine sin `onEvent` -
  svarer C), `stream_debug_sse_write` (server.ts sin SSE `send()` - svarer
  D). Host kan nå kjøre med dette slått på og korrelere jarvis-api-loggen for
  å se PRESIST hvor leveringen slutter å være inkrementell.
- **§32/§1-§2 redesignet - IKKE lenger en "500 ord"-blind fix (fjernet
  helt):** ny §3B-seksjon i `bo12-voice-live.ts` kjører FØRST en ren
  smoke-test (ingen cancellation) som måler `token_count`/`first_token_ms`/
  `last_token_ms`/`spread_ms` for et normallangt svar - `incrementalStreaming
  Observed` settes KUN når ≥3 distinkte mottak spredt over >100ms er
  observert. §32 kjøres BETINGET på dette: hvis smoke-testen IKKE fant
  inkrementell levering, rapporteres §32 som **IKKE KJØRT (inkonklusivt)**
  med henvisning til den deterministiske suite-/sandbox-evidensen - IKKE en
  hard FAIL (siden det ikke finnes noen bevisbar aktiv stream å avbryte midt
  i på den hosten). Hvis smoke-testen VISER inkrementell levering, kjøres
  §32 og en feiling DER er nå en høy-konfidens ekte regresjon (kategori A),
  siden race (kategori B) nettopp er utelukket i samme kjøring. Abort trigges
  på 2. observerte token (bevis på en PÅGÅENDE stream, ikke bare ett burst).
- **D-30 HARDENING §1/§2 (ekte lyd-barge-in) koblet løs fra lang LLM-respons
  (host-ordre §5):** turn A ber nå om et normallangt svar ("tre norske
  fjell, én setning om hvert") i stedet for "minst 200/500 ord" - barge-in
  trigges UTELUKKENDE på observert `frames.length>0` (ekte avspilling i
  gang), aldri på antatt svarlengde. Generation cancellation (§32) og audio
  cancellation (§1/§2) er nå eksplisitt to separate gates, som i host-ordren.
- **Soak turn 8 (host-ordre §4) - root cause identifisert som SANNSYNLIG
  SAMME fenomen som §32, ikke en egen harness-feil:** forrige rundes
  turn-8/9-redesign (konkurrerende sending) er strukturelt korrekt (samme
  mønster ligger ALLEREDE i `d30-foundation.test.ts` sin suite-bevist
  barge-in-test), men 20s-timeout var for kort dersom EKTE generering på
  denne hosten faktisk kan ta 30-40+ sekunder (matcher §32-funnet). Fikset:
  (a) tidsstemplet tilstandshistorikk (`onState`-overganger med ms-offset)
  inkluderes i enhver timeout-feilmelding - skiller "trege men normale
  overganger" fra "aldri kom forbi thinking"; (b) timeout økt til 60s for
  turn 8/9, 45s for øvrige turer; (c) turn 8s tekst KORTET NED (var "minst
  fem hundre ord" - fjernet som blind fix, siden barge-in uansett trigges på
  observert `state==="speaking"`, ikke på lengde); (d) et timeout merkes
  IKKE lenger stille som "session_corrupted" uten forklaring - loggen sier
  eksplisitt at det er en timeout, ikke nødvendigvis korrupsjon, med
  henvisning til §32/§3B for videre diagnose.
- **Q-18: IKKE rørt igjen** (host bekreftet PASS live: `tools=
  [read_calendar_today]`, kalender-repetisjon fungerer, `duplicate_tool_
  executions=0`) - forblir FIKSET fra forrige runde.
- **Kvalitet:** 281/281 (279 + 2 nye §8.D-tester i `fase3-e2e.test.ts`),
  lint/typecheck/gitleaks rene. Ingen regresjon: Q-18-fiks, same-turn
  tool-dedupe, write-dedupe, sovereign/delegert/D-class/tenant-isolasjon/
  cross-provider-fallback/tool-resume/unknown-tool-DENY - alle eksisterende
  suiter uendret grønne.

**D-30-anbefaling denne runden (før host-runde 6): READY_FOR_HOST_RETEST
(fortsatt ikke VERIFIED, fortsatt ikke BLOCKED).** Egen kode er nå bevist
korrekt (suite + sandbox-probe) for streaming/kansellering NÅR en adapter
faktisk streamer; det gjenstår å avgjøre PÅ HOSTEN (med
`JARVIS_STREAM_DEBUG=true`) om §32s opprinnelige host-funn var en
engangs-nettverksanomali eller et vedvarende mønster for ekte
OpenAI/Anthropic-kall i dette miljøet. Scriptene er redesignet til å
rapportere ærlig i begge tilfeller (PASS/IKKE KJØRT/FEIL) i stedet for å
tvinge frem en påstått grønn status. **Denne anbefalingen er SUPERSEDERT av
host-runde 6 under - D-30 er nå VERIFIED.**

### D-30 FINAL CLOSURE — HOST VERIFIED (2026-08-14, runde 6)

Windows-host kjørte de redesignede scriptene fra runde 5 (`JARVIS_STREAM_DEBUG`-
klare `bo12-voice-live.ts`/`bo12-voice-soak.ts`) og bekreftet ALLE gjenstående
gater PASS. §32s runde 5-anomali (0 tokens/35,5s) reproduserte IKKE denne
runden - vurdert som en engangs-nettverksanomali, ikke et vedvarende mønster
(egen kode var allerede bevist korrekt via sandbox-probe + suite i runde 5).

| Gate | Host-resultat |
|---|---|
| §3B Real-provider streaming smoke | PASS - `token_count=142`, `first_token_ms=12675`, `last_token_ms=17432`, `spread_ms=4757` (ekte inkrementell levering bekreftet) |
| §32 Generation cancellation | PASS - aktiv stream observert, abort etter 3 tokens, upstream kansellert, ren neste tur ("Klar igjen.") |
| §1/§2 Real audio barge-in | PASS - 8 rammer mottatt før barge-in, `barge_in_audio_stop_ms=0` (≤250ms-gate), 0 stale rammer i 500ms-settle-vindu, `cancelled=true` på avbrutt tur, ren neste tur |
| 10-tur soak - kjøring #1 | PASS - 10/10, én session_id, `duplicate_tool_executions=0`, `session_corrupted=false`, turn 8 cancelled, turn 9+10 normale |
| 10-tur soak - kjøring #2 (uavhengig gjentak) | PASS - identisk resultat: 10/10, én session_id, `duplicate_tool_executions=0`, `session_corrupted=false`, turn 8 cancelled, turn 9+10 normale |
| Q-18 (repetert kalenderlesing i samme sesjon) | FIXED bekreftet live - ferske svar på gjentatt spørring, `duplicate_tool_executions=0`, same-turn-dedupe og write-dedupe uendret |

**Ytelsesgjeld registrert (IKKE en korrekthets-blokker - se OPEN_QUESTIONS.md
Q-19):** host-observert latens er treg for ønsket realtime-opplevelse
(`e2e_first_audio` vanligvis ~3,5-6,2s, enkelte turer ~9-12s, streaming-smoke
første token ~12,7s). D-30s funksjonelle korrekthet er verifisert UAVHENGIG av
dette tallet - realtime-latensoptimalisering er en bevisst utsatt, egen runde
(ingen optimalisering forsøkt i denne lukkingen, som beordret).

**D-30 P0 STATUS: VERIFIED.** Merget til `main` (se PROJECT_STATUS.md for
commit-referanse). D-30 er ikke lenger en åpen, ikke-blokkerende port -
voice-laget er nå en verifisert del av v4.0-runtimen.

## BO-11.1 — P1A DELTA-HARDENING (2026-08-14)

**UA-1 P1A forblir VERIFIED.** Kontrollert delta-port oppå BO-11 (ingen redesign):
- **SQL streaming-metrics (§3-§5):** migrasjon `016_cost_events_stream_metrics` (ttft_ms int,
  stream bool default false, tool_calls int default 0) + write-path i ModelGateway (én kostrad per
  modellkall som før). Verifisert mot ekte embedded-PG: gamle inserts overlever m/defaults; ekte
  streaming-kall → SQL-rad m/provider/model/purpose/ttft_ms/stream/tool_calls/kost; P1B-aggregering
  (avg ttft per provider/purpose) SQL-spørrbar. Kompletterer Langfuse - erstatter ikke (§14).
- **SSE-disconnect → upstream abort (§6-§8):** HTTP-klient kobler fra → res-'close' (req-'close'
  fyrer ved fullført body i moderne Node - feil signal) → AbortSignal → ModelGateway.stream →
  provider-abort → normalisert cancelled → delvis svar persistert m/`[avbrutt av bruker]`-markør.
  E2E-bevist mot kjørende http-server + embedded-PG: kansellering skjer upstream (ikke bare
  socket-stopp), ingen health-straff, ingen zombie, neste request OK, nøyaktig ett done-event.
  Barge-in-fundamentet for D-30 er dermed bevist på HTTP-nivå (§8).
- **Executive-handler-paritet (§9-§10):** delt handler (`apps/api/src/executive.ts`) registrert i
  BÅDE api-workeren (main.ts - hadde fortsatt gammel provider-direkte handler uten tools) og
  worker-containeren. Paritetstest: samme durable jobb → semantisk likt resultat, samme
  idempotensnøkkel, mesh (aldri echo) for prompt-jobber, sandbox kun der den finnes.
- **D-class-mesh-regresjon (§11) + SOVEREIGN-FUNN (pre-merge-akseptansen):** D er risikoklasse,
  ikke permission-gate. Funn: `resolveAuthorityMode`/policy-motoren hadde korrekt sovereign-semantikk
  (UA0-AUTHORITY), men **api/worker-wiringen sendte ikke authority-config** → runtime kjørte legacy
  SCOPED og krevde approval for owners D-kall. Fikset: main.ts, worker-main.ts og bo11-live.ts wirer
  nå `authority: {owner_person_id, owner_tenants}` fra env (defaults person-tobias/tenant-personal).
  Begge semantikker bevist mot ekte PG i full mesh-kjede: **OWNER SOVEREIGN** (ingen delegation):
  D-kall uten approval → authority PASS → preflight → execute → readback → before/after-evidens →
  audit. **DELEGERT/SCOPED** (delegation_id - arver aldri owner authority): uten approval →
  deterministisk DENY m/null transport-kall + audit; med gyldig signert approval → ALLOW
  m/preflight+readback; nonce-replay → DENY. Klassifisering D bevart.
- **SSE-fixtures (§12):** provider-uavhengige fixtures - samme logiske utveksling gir IDENTISK
  normalisert event-sekvens fra OpenAI- og Anthropic-SSE; terminal-invarianter (nøyaktig én
  terminal, aldri events etter, complete etter siste delta). **Funn fikset:** Anthropic-adapteren
  ignorerte `error`-events i stream (ble stille suksess) → nå klassifisert server/rate_limit;
  allerede klassifiserte feil beholder klassifisering gjennom stream-catch.
- **Kvalitet:** 247/247 (225 baseline + 22 nye; disconnect-e2e stabil 3×), lint/typecheck/gitleaks
  rene. Kritisk recovery-regresjon (§13/§45: tool utført → provider-død → resume uten dobbel
  utførelse) PASS i suiten.
- **Gjenstår på host (utenfor denne byggerundens miljø - ingen Docker/nøkler):** delta-live-porten
  `node --env-file=.env --experimental-transform-types apps/api/scripts/bo11-1-delta-live.ts`
  (samme Node 24-host-funn som bo12: strip-types feiler på parameter properties; Docker-PG-SQL §5 + live
  SSE-disconnect §7) + live provider-regresjon §13 (re-kjør bo11-live.ts) + §16 runtime-helse.
  BO-11s live-evidens er uendret gyldig; deltaet endrer ikke provider-kontraktene.

## BO-11 — UA-1 P1A STREAMING + TOOL-CALLING = VERIFIED (2026-08-14)

**Arkitektur:** normalisert StreamEvent-kontrakt + provider-nøytral tool-løkke i ModelGateway.
Adaptere (OpenAI/Anthropic) oversetter native SSE/tool-formater; resten av Jarvis ser aldri
provider-format. Tool-utførelse går KUN via trusted mesh-bridge → ToolGateway → Policy/Authority
(§17); P1A eksponerer kun A/B-read-verktøy (read_recent_email/read_calendar_today/read_github_issues).

**Live-evidens (bo11-live.ts i jarvis-api-containeren, ekte OpenAI+Claude):**
- **Streaming (§5-§7):** openai 19 deltas, ttft 1477 ms, rekonstruksjon=MATCH; anthropic ttft 2758 ms,
  MATCH. TTFT spores i result/trace (§8).
- **Cancellation (§9/§46):** begge providere - abort midt i stream → `cancelled`, ingen health-straff,
  ingen zombie-state, neste request OK. (Barge-in-fundamentet for D-30, §28.)
- **Pre-output stream-fallback (§10):** kontrollert timeout på openai → fallback-event
  openai→anthropic(timeout) → Claude fullførte streamen. (Frasering avvek fra ordrett sentinel -
  funksjonelt PASS.) **Post-output (§11):** konservativ policy - stream markeres `stream_interrupted`,
  aldri stille provider-bytte (enhetstestet).
- **Tool calling live (§14-§16):** BEGGE providere → read_github_issues via samme trusted gateway:
  tool_rounds=2, nøyaktig 1 utførelse, korrekt svar. **Multi-tool (§23):** calendar+github i samme
  oppgave: 2 utførelser, syntese 320 tegn (loop-vern: siste runde uten tools tvinger syntese).
- **Cross-provider recovery (§45/§21):** openai døde ETTER utført verktøy → Claude gjenopptok fra
  persistert tool-resultat (tool_exchanges) og svarte - utførelser=1, ALDRI dobbel side-effekt.
- **Idempotens (§19):** sha256-nøkkel per (tenant,task,tool,args); cache + ToolGateway-idempotens.
- **Ukjent verktøy (§26):** TOOL_NOT_FOUND uten utførelse (live). **Ugyldige args (§25):** schema-feil
  → normalisert feil, ingen utførelse, én reparasjonsrunde (enhetstestet).
- **Conversation (§27):** live SSE-chat streamer ekte deltas gjennom normalisert kontrakt
  (`en`/`to`/`tre` + done). **Worker (§29):** durable jobb m/tools=true → mesh-verktøy via samme
  ToolGateway i worker-containeren (tool_rounds=3, resultat persistert).
- **Critic (§30):** får aldri tools (enhetstestet). **Owner override (§38):** manglende capability →
  tydelig `override_capability_missing`-feil (enhetstestet).
- **Kost/trace (§31-§32):** provider-fordelt kost m/failures i cost_events (sess-bo11: anthropic
  21 kall/58 øre, openai 34 kall/20 øre inkl. simulerte feilforsøk med amount 0); ttft/tool_calls i
  Langfuse-metadata. Brief 200-regresjon.
- **Kvalitet:** 225/225 (Node 22; +20 nye: stream-normalisering/-cancel/-feil, tool-normalisering,
  idempotens, fallback-etter-tool, multi-tool, critic-restriksjon, capability-routing, adapter-SSE-
  conformance begge providere, cross-provider tool_exchange-oversetting), lint/typecheck rene.
- **Merknad:** Gemini/Kimi/Ollama-adaptere uendret på complete-path (streaming/tools kan legges til
  senere uten kontraktsendring, §39).

## BO-10 — UA-1 MULTI-PROVIDER LIVE = VERIFIED (2026-08-13)

**Credential:** ANTHROPIC_API_KEY=SET (eier-levert; .env + speilet til Infisical-vault via
universal-auth; injisert i api+worker via env_file; aldri i repo/logg/trace). OPENAI uendret.

**Live-evidens (bo10-live.ts i jarvis-api-containeren, alle kall mot ekte API-er):**
- **Anthropic LIVE:** claude-sonnet-5, tokens 21/20, 1576 ms, finish_reason + provider request id.
- **Owner override (§3):** SPECIFIC_PROVIDER/OWNER_OVERRIDE PASS for både openai og anthropic.
- **AUTO (§4):** 5 purposes; router valgte openai etter policy (LOW_COST/DEFAULT_BALANCED/
  REASONING_REQUIRED) - ingen kunstig trafikkfordeling.
- **Cross-provider fallback (§5): PASS BEGGE RETNINGER.** OpenAI→Claude: kontrollert timeout x2
  (wrapper, ekte nøkler urørt) → anthropic ekte suksess, fallback_from=[openai], mesh.fallback=VERIFIED.
  Claude→OpenAI: tilsvarende med registry-konfigurert kandidatrekkefølge → openai suksess,
  fallback_from=[anthropic]. Feilforsøk + suksess persistert i cost_events; ingen tool-side-effects.
- **Auth (§6):** ugyldig Anthropic-nøkkel → ekte 401 → auth, ingen retry-spam.
- **429 (§7):** simulert på openai → health=RATE_LIMITED m/backoff → anthropic tok kallet.
- **Timeout (§8):** ekte 1 ms-timeout mot Anthropic → timeout-klassifisering; retry-policy (maks 1) + fallback.
- **Multi-provider critic (§9-10): PASS BEGGE VEIER.** openai-primær → anthropic-critic (1064 tegn);
  anthropic-primær → openai-critic (576 tegn). Egen kostrad/trace per critic; critic≠primary bevist.
- **Benchmark (§11):** 5 oppgaver × 2 providere = 10/10 suksess. openai/gpt-4o-mini avg ~1.1 s;
  anthropic/claude-sonnet-5 avg ~3.1 s (høyere kvalitetsklasse, høyere kost: 27 øre vs 14 øre totalt
  i sesjonen). Structured (prompt-JSON): anthropic compliant, openai ikke i denne kjøringen - men
  openai består schema-håndhevet structured output (BO-09-evidens). Ingen «best modell»-konklusjon.
- **Health (§12):** begge LIVE (openai ~1.3 s, anthropic ~4.0 s snitt); DEGRADED/RATE_LIMITED/
  UNAVAILABLE-transisjoner dekket (429-sim live + suiten).
- **Langfuse (§13):** 10 anthropic-observasjoner, 2 critic-traces (critic:openai/critic:anthropic),
  3 fallback-observasjoner m/fallback_from + reason. Secret-scan RENT.
- **cost_events (§14):** per provider: anthropic 13 kall/2 fallbacks/1 critic/2 feilforsøk/27 øre;
  openai 17 kall/1 fallback/1 critic/3 feilforsøk/14 øre. Feilforsøk = amount 0.
- **Regresjon:** brief 200; chat «fire» routed=model; worker-mesh-jobb «Grønn» (gpt-5) - api-workerens
  executive-handler harmonisert med worker-containeren (samme kø, samme kontrakt); max_tokens 1024
  for gpt-5-reasoning. Full stack healthy; D-class/OwnerControls/kill switch PASS i suiten.
- **Kvalitet:** 205/205 (Node 22), lint/typecheck/gitleaks rene.

**UA-1 MULTI-PROVIDER LIVE = VERIFIED.**

## BO-09 AI MESH LIVE-VALIDERING (2026-08-13)

**Secret discovery (kun presence):** OPENAI_API_KEY=SET (host). ANTHROPIC_API_KEY/GEMINI_API_KEY/
KIMI_API_KEY/MOONSHOT_API_KEY/JARVIS_OLLAMA_URL = **MISSING** i både .env, host-env og Infisical-vault
(sjekket via InfisicalSecretProvider, vault healthy). Ollama ikke installert (port 11434 død).
→ **UA-1 MULTI-PROVIDER LIVE = BLOCKED_BY_CREDENTIALS** (ærlig per §30; arkitektur forblir READY).

**Live-verifisert i container-runtime (bo9-live.ts i jarvis-api):**
- **AUTO-routing (§9):** 5 purposes → openai (eneste live) med korrekte reasons:
  QUICK_CLASSIFICATION→LOW_COST, SUMMARIZE→ONLY_AVAILABLE, CODE/REASON/PLAN→REASONING_REQUIRED;
  latency 1.0-2.5 s, kost 1 øre/kall i cost_events.
- **Owner override (§8):** SPECIFIC_PROVIDER/OWNER_OVERRIDE PASS.
- **Structured output live (§7C):** json_schema → parsed {"verdict":"ja"} PASS.
- **Critic/second opinion (§15-16):** live critic-run (single-provider: openai kritiserer openai -
  multi-provider critic venter på credential), critique 644 tegn, egen kostrad, status critic=VERIFIED.
- **Auth (§12):** ugyldig nøkkel mot ekte endepunkt → 401 → ProviderError(auth), ingen retry-spam.
- **Timeout (§14):** 1 ms-timeout mot ekte endepunkt → ProviderError(timeout).
- **429 (§13):** IKKE fremprovosert live (bevisst); RATE_LIMITED/backoff/fallback dekket i suiten.
- **Kvalitetssignal-korrelasjon (§19):** cost_events grupperer purpose×provider×model med
  calls/avg_ms/sum_ore/failures/critic_calls - grunnlag for senere quality-routing, ingen læring aktivert.
- **Worker-mesh (§22):** executive-jobb m/prompt gjennom durable kø i worker-container →
  ModelGateway purpose-routing → svar "42" (openai:gpt-5) med provider/tokens i result. Worker er
  ikke bundet til én provider.
- **Conversation (§21):** live /chat i container → "Oslo", routed=model, Langfuse-observasjon
  CHAT:DEFAULT_BALANCED. Ingen direkte provider-avhengighet i Conversation Engine.
- **Brief (§20):** 200, 6839 tegn, 0 source_errors, ingen Telegram-spam.
- **Fix underveis:** OpenAI-adapteren sendte legacy `max_tokens` → 400 på gpt-5; byttet til
  `max_completion_tokens` (gjelder alle chat-modeller). Verifisert live med gpt-5 og gpt-4o-mini.
- **Trace-sink:** api+worker bruker nå `traceSinkFromEnv` (Langfuse når konfigurert, ellers JSONL).
- **/status (§25):** evidensbasert: fallback=LOGIC_ONLY (<2 reelle providere), critic=VERIFIED
  etter faktisk run; VERIFIED for fallback settes først ved ekte cross-provider fallback.
- **Sikkerhet (§26):** audit_events/cost_events/Langfuse credential-scans = 0 treff; image uten .env;
  gitleaks rent. **Benchmark (§17): N/A** (krever ≥2 live cloud-providere).
- **Kvalitet:** 205/205 (Node 22; +2 evidensstatus-tester), lint/typecheck rene.

## BO-08 UA-1 P0 — UNIVERSAL AI MESH (2026-08-13)

**Arkitektur:** ModelGateway → AiRouter (deterministisk/scoret, aldri LLM-for-å-velge-LLM) →
ProviderAdapter → normalisert respons → cost_events + Langfuse. Modellvalg skjer KUN i trusted
gateway-lag (§35). Kontrakter i `@jarvis/contracts` (purpose/mode/reason), registry/health/pricing/
router i `modules/model-gateway`, adaptere i `packages/provider-adapters`.

- **Providere:** OpenAI **LIVE (baseline)**; Anthropic/Claude, Gemini, Kimi (Moonshot,
  OpenAI-kompatibelt API), Ollama = **IMPLEMENTED_NOT_LIVE** (adapter + conformance-tester;
  mangler kun credential/endepunkt: ANTHROPIC_API_KEY, GEMINI_API_KEY, KIMI_API_KEY/MOONSHOT_API_KEY,
  JARVIS_OLLAMA_URL). Ingen fake LIVE-status: health = CONFIGURED til første faktiske suksess.
- **Routing-modes:** AUTO/FAST/QUALITY/CHEAP/LOCAL/SPECIFIC_PROVIDER/CRITIC. Owner-override (§10):
  eksakt provider, ingen stille fallback. LOCAL uten lokal modell → tydelig feil, aldri sky (§26).
- **Fallback (§12):** klassifiserte feil (auth/rate_limit/timeout/server/network/invalid_response/
  bad_request); auth = aldri retry-spam; transient = maks én retry samme provider; deretter neste
  kandidat. Feilforsøk logges som egne cost_events-rader (amount 0, kind model:failed:<kind>).
  Ingen doble tool-side-effects: AI-generering og tool-execution er fortsatt separert (Tool/Policy).
- **Cost (§14):** migrasjon 015 (purpose/success/fallback/critic/latency_ms på cost_events);
  versjonert pricing-tabell (2026-08.1) med cached-token-rabatt; critic har egen kostrad.
- **Critic (§18):** opt-in only (critic:true / mode CRITIC), foretrekker annen provider, feil i critic
  velter aldri primærsvar, ikke koblet til D-class.
- **LIVE-akseptanse i container-runtime (§45):** `mesh-live.ts` i jarvis-api-containeren →
  routed openai:gpt-4o-mini, cost_event {purpose:QUICK_CLASSIFICATION, success:true, fallback:false,
  latency_ms:851, 1 øre}, Langfuse-observasjon med metadata {router_mode:AUTO, routing_reason:LOW_COST,
  purpose} (secret-scan RENT). Fix underveis: span-create manglet body.id - observasjoner ble aldri
  opprettet før BO-08; nå verifisert.
- **LIVE multi-provider fallback/benchmark: NOT YET VERIFIED** (kun én cloud-provider har credential;
  logikken er verifisert via kontrollerte fake-adaptere i suiten, §29).
- **Tester:** 203/203 (Node 22) - 73 nye (router-eval §27, adapter-conformance §28 med full feilmatrise,
  fallback/critic/kost/health/registry/pricing). /status + /ai viser mesh-status (ingen secrets).
- **Regresjon:** brief 200 (0 source_errors, live-kilder), full stack healthy, D-class/OwnerControls/
  kill switch dekket i suiten, gitleaks rent.

## BO-07 LIVE-EVIDENS (2026-08-13)
- **D-27 Langfuse: VERIFIED.** langfuse/langfuse:2 i compose (headless init via .env, restart:unless-stopped,
  Postgres-avhengig, health OK v2.95.11). Ekte OpenAI-kall → trace i Langfuse (navn openai:gpt-4o-mini,
  userId=tenant, sessionId, metadata.task_id/cost_ore), korrelert med cost_events (2 øre). Redaction:
  sentinel + credential-mønstre = IKKE i trace (sentinel_leak=false, key_leak=false). Outage: Langfuse
  stoppet → core model-call lykkes fortsatt (DEGRADED, ikke krasj) → restart → health OK.
- **FULL STACK (OPS): VERIFIED.** Ett image (infra/local/api.Dockerfile, hele workspacet, --prod,
  ingen .env i image - bekreftet med ls i container). Tjenester: postgres(healthcheck) → migrate
  (one-shot, service_completed_successfully, `{"msg":"migrations_complete"}`, 14 migrasjoner) →
  api(healthy, /health 200) + worker (egen container, drenerer durable kø; sandbox-jobb fullført:
  `container-worker-ok`, process-sandbox i container - Docker-sandbox gjelder host, D-32) + langfuse +
  infisical(+redis). **Live fra container-runtime:** gmail/calendar/github read = ALLOW i audit,
  scheduler-catch-up leverte dagens brief til Telegram (2 chunks, audit 17:47:42Z) - nøyaktig én.
  **Restart-test:** compose restart → alt healthy, ingen duplikat-brief. **Down/up (uten -v):** data
  persistert (tasks=6, telegram-audit=2, migrasjoner=14). **Failure-injection:** A postgres-stopp →
  api /health 200 under utfall, brief 200 etter recovery; B crash-restart-policy bevist (testcontainer
  exit 1 → restarts=5; docker kill/stop regnes som brukerstopp og trigges ikke - dokumentert semantikk);
  C langfuse-utfall → api 200; D infisical-utfall → api 200 (+ env-fallback); E api-restart → 200.
  **Host-readiness:** Docker Desktop AutoStart=true satt; restart:unless-stopped bevist i praksis
  (containere kom selv opp etter dagens daemon-krasj). Status: HOST_REBOOT_READY_NOT_PHYSICALLY_TESTED.
  **Sikkerhet:** image uten .env; audit/cost-tabeller scannet for credential-mønstre = 0; gitleaks 59
  commits = no leaks; 130/130 tester (Node 22), typecheck+lint rene. **Merk (bootstrap):** owner-seed
  (tenants/people/devices/memory_spaces for person-tobias/jarvis-core) er idempotent SQL utenfor
  migrasjonene - kjøres én gang per fersk database.
- **UA-0 KJERNEBESLUTNING: CORE RUNTIME READY.** D-27/D-28/D-32/D-35/OPS/scheduler = VERIFIED i
  Docker-runtime. D-30 (Voice), D-36 (Apple), HA-RUNTIME blokkerer ikke UA-0 og står som egne porter.
- **D-35 Infisical: VERIFIED.** infisical/infisical:latest-postgres + redis:7 i compose (egen db `infisical`
  i Docker-PG, restart:unless-stopped, health Ok). Headless bootstrap via `/api/v1/admin/bootstrap`
  (admin + org + maskinidentitet, ingen UI-steg). Prosjekt `jarvis` + universal-auth clientId/clientSecret
  opprettet via API (kun i .env, aldri i repo). InfisicalSecretProvider (universal-auth login → v3 raw
  secrets, fail-closed): testsecret JARVIS_VAULT_TEST hentet = PASS. **Pilot-migrering:** JARVIS_GITHUB_TOKEN
  lagt i vault → FallbackSecretProvider(inf→env) hentet fra vault (MATCH mot .env) → live GitHub-kall med
  vault-verdien = 200 PASS. **Outage:** infisical stoppet → fallback ga env-verdi (MATCH), health=unavailable
  (fail-closed, ingen krasj) → restart → recovery PASS (health=healthy). .env beholdt som fallback/rollback.
- **D-32 DockerSandboxRunner: VERIFIED.** Koblet i ekte durable-kø (enqueue→lease→worker→
  DockerSandboxRunner→container→resultat). Isolasjon: non-root node, --network none, --memory 256m,
  --pids-limit 128, /work-mount, INGEN Jarvis/OpenAI/token-env (0 treff). Acceptance=completed;
  crash/reclaim=completed (A leaset+krasjet, B reclaimet, attempts=2, resultat én gang); timeout=failed;
  cancellation=cancelled; failed-command(exit3)=failed; result-persistens PASS over Postgres-restart.
