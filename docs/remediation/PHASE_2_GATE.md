# PHASE 2 GATE – Remediering del 2 av 10 (nettverk, autentisering, enheter, secrets, isolasjon)

| Felt | Verdi |
|---|---|
| Dato | 2026-10-02 |
| Branch | `remediation/02-identity-network-isolation` (stablet på `remediation/01-containment-baseline` / PR #218) |
| PR | draft, **IKKE merget** (`#219`) |
| Beslutning | D-364 · Q-44 · Q-45 |
| Uavhengig review | **IKKE gjort** – verken del 1 eller del 2. Denne filen er Claude sin egen evidens, ikke en godkjenning. |

## 1. Gate-utfall

**`PHASE 2 GATE: PASS` på repo-nivå (alle akseptansekriterier har atferdsbevis), med `BLOCKED_EXTERNAL` for runtime-verifisering.**

- Alle åtte akseptansepunkter i ordren er dekket av tester som kjører mot ekte Postgres, ekte Chromium, ekte `git`, ekte HTTP-servere eller (compose/Dockerfile) strukturelt – se §2.
- **Ingenting er `VERIFIED` i runtime.** Sandbox-VM-en har ingen Docker-daemon, ingen NAS, ingen Swift-verktøykjede og ingen GitHub App. Ikke-root/read-only/seccomp/Chromium-sandbox i KJØRENDE containere, live-DB-migrering (063/064, nye roller), Infisical/Langfuse under `infisical_app`/`langfuse_app` og Swift-klienten er derfor `BLOCKED_EXTERNAL` (§5).
- Del 2 er stablet på del 1 (PR #218), som heller ikke er gjennomgått. Ingen funn er erklært lukket.

## 2. Bevismatrise mot akseptansekriteriene

Statusvokabular: ADR-001 §2.4. Tall er kjørt i denne økten (§4).

| Akseptanse / krav | Tiltak (kode) | Bevis (test/kommando) | Status |
|---|---|---|---|
| **Ingen relevant route godtar tillitsskapende identity-felt fra body** (krav 1, 2, 8) | `authedRequest`/`grantBodyOrReject` i `apps/api/src/server.ts`: forbudte felt (`person_id`, `tenant_id`, `memory_space`, `session_id`, `device_id`, `channel`, `auth_strength`, `owner_person_id`, …) = 400 `identity_field_forbidden`; hviteliste per rute; `/devices/challenge/verify` fjernet | `apps/api/test/remediation-2-control-plane-auth.test.ts` B: **hvert** forbudt felt × **hver** av 19 kontrollruter, selv med gyldig grant; `executive-query-e2e`, `d131-authority-hardening-e2e`, `session-authority-e2e` (oppdatert) | `CODE_FIXED` |
| **Ukjent/revokert device og feil grant får 401/403 på alle kontrollflater** (krav 1, 3) | 401 `grant_required`, 403 `identity_denied`; permanent revokering (`revoked_device_keys`), `PgDeviceRegistry.approverFor` uten cache | `remediation-2-control-plane-auth.test.ts` A (19 ruter × 3 manglende-token-former + 4 bogus-grants), C (revokert enhet: 403 på alle 19, ny autorisasjon nektes; ukjent enhet, feil nøkkel, gjenbrukt challenge, feil person/tenant), D (20 parallelle autorisasjoner → én aktiv sesjon); `remediation-2-device-revocation-session.test.ts` (14) | `CODE_FIXED` |
| Godkjenninger bundet til tool/action/parametre/tenant/person/approver/issued_at/expiry/nonce; Ed25519 ved enrollment (krav 3) | `packages/contracts/src/approval.ts` v2, `modules/policy/*`, `device-service.ts` | `modules/policy/test/policy-gateway.test.ts` (40: hver binding avvises med egen årsak, TTL, skew, eier-rolle, utsatt nonce), `remediation-2-device-revocation-session.test.ts` | `CODE_FIXED` (Swift-klient `UNVERIFIED`) |
| **Ingen nettverksbane fra browser kan nå interne metadata-/DB-/vault-adresser** (krav 4) | service-token; privat `browser`-nett (kun api/worker/gateway); `egress-proxy` (DNS én gang, alle svar offentlige, redirect/subressurs/WebSocket via proxy, loopback/RFC1918/link-local/CGNAT/169.254.169.254/compose-verter blokkert); per-kall `BrowserContext`; `chromiumSandbox:true` påkrevd | `apps/browser-gateway/test/*` (egress-policy, egress-proxy med DNS-rebinding/blandede svar, `engine-egress.test.ts` med EKTE Chromium mot loopback-server, redirect til loopback, `http://`/`https://` til interne mål), `remediation-2-compose-isolation.test.ts` (browser kun på `browser`-nett, ingen host-port, seccomp-fil) | `CODE_FIXED`; Chromium-sandbox/seccomp i container `BLOCKED_EXTERNAL` |
| **Worker-miljøet inneholder ikke vault master key eller unødvendige leverandørnøkler** (krav 6) | `infra/local/service-env.mjs` (kilde), generert `environment:` per tjeneste, ingen `env_file`, `NEVER_IN_RUNTIME` | `remediation-2-compose-isolation.test.ts` A/B (39): compose = manifest; worker/api/voice/browser får aldri `INFISICAL_ENCRYPTION_KEY`/`INFISICAL_AUTH_SECRET`/`JARVIS_DB_ADMIN_*`/`NEXTAUTH_SECRET`/`SALT`/`LANGFUSE_*`; worker får ikke webhook-/medie-/meldingsnøkler; browser får kun port + token; `docker compose config` (dummy-env) rendret og kontrollert | `CODE_FIXED` |
| **Ingen generell kommando kan startes fra en task contract** (krav 5, 7) | executive `command` avvises (`executive_command_disabled`) og er fjernet i handleren; `test_command` kun kjente testløpere (`assertTestCommand`); `JobContainerPolicy`/`resolveJobSandboxRunner` feiler lukket; ingen Docker-socket; git fjernet fra api-image | `modules/tasks/test/remediation-2-job-container.test.ts` (18), `remediation-2-git-policy.test.ts`, `coding-git-auth-wiring.test.ts` (O: `sh -c`, `node -e`, `curl`, `npm install` avvist før sandbox), `fase6-worker.test.ts`, `check-containment` | `CODE_FIXED`; ingen runner konfigurert (Q-45) |
| **Ikke-root og least-privilege bevises i compose-/prosesstest** (krav 6) | Dockerfiler `USER node`/`pwuser`; `x-hardening` (cap_drop ALL, no-new-privileges, read_only, tmpfs); `infisical_app`/`langfuse_app`/`jarvis_runtime` (NOSUPERUSER/NOBYPASSRLS); `jarvis_definer` | `remediation-2-compose-isolation.test.ts` C + D (bootstrap-SQL mot ekte Postgres: roller, eierskapsoverdragelse av eksisterende DB, idempotens, isolasjon mellom DB-er, ingen CREATEROLE/CREATEDB, passordrotasjon, fail closed uten/for kort passord), `ops/security/test/check-containment.test.mjs` (26), `remediation-2-schema-invariants.test.ts` | `CODE_FIXED` (struktur + ekte Postgres); **kjørende container ikke-root: `BLOCKED_EXTERNAL`** |
| Git-credentials (krav 7) | `git-policy.ts`, `git-auth.ts` (credential kun protokoll+vert+repo-sti), `coding.ts`, `task-service.ts` | `coding-git-auth-wiring.test.ts` (M–P), `git-auth.test.ts`, `git-credential-isolation.test.ts` (ekte git ↔ lokal smart-HTTP), `remediation-2-git-policy.test.ts` | `CODE_FIXED` (kortlevd GitHub-identitet: Q-45) |
| Én eier-identitet (krav 8) | `owner-config.ts`, `owner.ts`, `systemIdentity`, HTML-injeksjon | `remediation-2-owner-identity.test.ts` (15, ekte prosess: exit 1 uten konfig), `owner-config.test.ts`, `remediation-2-static-pages.test.ts` | `CODE_FIXED` |
| SECURITY DEFINER/RLS/scope (krav 9) | migrasjon 064, `serializeMemorySpaces`, SCRAM-verifier | `remediation-2-schema-invariants.test.ts` (15): alle definer-funksjoner eid av ikke-superbruker/ikke-BYPASSRLS, virker for vanlig `jarvis_app`-medlem; RLS-unntaksliste; `true`-policyer; FK-baseline; komma/mellomrom-GUC fail closed; klartekst aldri i DDL | `CODE_FIXED` (DEFERRED: Q-44/Q-45) |
| HTTP/DB/compose-atferdstester (krav 10): uautent., spoofing, revokert, samtidig, fremmed tenant, SSRF (direkte/redirect/DNS), container-secret-isolasjon | se over | spoofing + fremmed tenant: `remediation-2-control-plane-auth.test.ts` B («hendelse i tenant A usynlig for B»); SSRF: `apps/browser-gateway/test/*` + `engine-egress`; secrets: `remediation-2-compose-isolation.test.ts` | `CODE_FIXED` |
| URL-/frontend-/DoS-hardening (JARVIS-063/064/066/091) | `http-guard.ts`, nonce-CSP, `guardedFetch` | `remediation-2-control-plane-auth.test.ts` E/F, `remediation-2-static-pages.test.ts`, `modules/tool-gateway/test/remediation-2-url-safety.test.ts` (49) | `CODE_FIXED` (JARVIS-066 delvis: Q-45) |

## 3. Statiske bevis (compose)

`docker compose --env-file <dummy> -f infra/local/docker-compose.yml config` (kun parsing, ingen daemon):

| Tjeneste | Host-port | Nett | Hardening |
|---|---|---|---|
| api | `127.0.0.1:3010` | `core`, `browser` | `x-hardening` |
| worker | – | `core`, `browser` | `x-hardening` |
| migrate | – | `core` | `x-hardening` (engangs, admin-rolle) |
| voice-gateway | `127.0.0.1:3020` | `core` | `x-hardening` |
| browser-gateway | – | **kun `browser`** | cap_drop ALL + **`cap_add: SYS_CHROOT` (eneste, D-365)**, no-new-privileges, **seccomp-profil**, read_only, tmpfs, `USER pwuser` |
| postgres / infisical / langfuse | `127.0.0.1` | `core` | no-new-privileges (tredjeparts-images) |
| db-bootstrap / infisical-redis | – | `core` | – |

Ingen `env_file`, ingen Docker-socket, ingen `privileged`/`cap_add`.

## 4. Kvalitetsporter (kjørt i denne økten)

| Kommando | Resultat |
|---|---|
| `pnpm -r typecheck` | exit 0 (alle pakker) |
| `pnpm exec eslint . --ignore-pattern ".claude/**"` | 0 feil, 0 advarsler. (`pnpm lint` uten ignore feiler lokalt med ~1000 feil som alle ligger i git-ignorert `.claude/worktrees/`, som ikke finnes i CI.) |
| `pnpm check:containment` | `containment invariants hold` |
| `gitleaks detect` (hele historikken) | `no leaks found` – tre falske positive (testfikstur-passord, miljønavnliste) er dokumentert i `.gitleaksignore`; historikk ikke omskrevet |
| `docker compose --env-file <dummy> config` | OK, se §3 |
| `vitest run` (hele repoet, embedded Postgres som ikke-root) | 416 filer / 7062 tester: 413 filer og 7038 tester passerte, 22 hoppet over, 3 filer feilet i 1. kjøring |
| – `modules/memory/test/memory.test.ts` | **Forårsaket av denne PR-en** (testen seedet to aktive sesjoner for samme person; ny unik indeks avviser det). Seed rettet (andre sesjon `closed`); re-kjørt: 22/22 |
| – `modules/watchdog/test/w1-production-wiring.test.ts` | **Forårsaket av denne PR-en** (strukturtest forventet `?? "tenant-personal"`). Oppdatert til `owner.tenant_id`; re-kjørt: 118/118 i watchdog-suiten |
| – `modules/core/test/embedded-postgres-ipv4-contention.test.ts` («B.3») | **Ikke berørt av denne PR-en:** samme feil som i del 1 (miljørelatert port-/IPv4-kontensjon i sandbox-VM-en); filen og testhjelperne er uendret |
| Del 2-spesifikke tester | control-plane-auth 55 · compose-isolasjon 39 · schema-invarianter 15 · device-revokering/sesjon 14 · policy 40 · browser-gateway 124 · url-sikring 49 · git-policy + wiring 17+ · owner-identitet 15 · static pages · job-container 18 · containment 26 (alle grønne) |
| Full CI på PR #219 | kjører; resultat rapporteres i PR/status |

## 5a. Runtime-observasjoner fra NAS-redeploy (2026-10-02, utskrift limt inn av Tobias; D-365)

Observert i kjørende stack etter `docker compose up -d --build` fra `6b716e3`/`66236c3`:
- **Observert OK:** `migrate` og `db-bootstrap` exit 0; 063/064 registrert i `schema_migrations`; api/worker/voice kjører UID 1000 og browser-gateway UID 1001, alle `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`; browser-gateway under seccomp-profilen; ingen rolle utenom `postgres` er superuser/bypassrls, `jarvis_definer` er NOLOGIN og eier alle 4 SECURITY DEFINER-funksjoner; `/health` 200, `/infra/pause` uten grant 401, browser-gateway uten token 401; kun 127.0.0.1-bindinger (Tailscale Serve er tailnet-only og peker på 127.0.0.1).
- **Funn 1 (rettet `66236c3`):** Infisical krasjet (`permission denied for schema pgboss`) fordi bootstrap bare overdro `public`; nå overdras alle skjemaer/objekttyper. Regresjonstest gjenskaper feilen uten fiksen. Etter fiksen sto Infisical `Up` (ikke restartende).
- **Funn 2 (rettet `6b716e3`):** seccomp-profilstien løstes mot `infra/local/` av Compose v2.
- **Funn 3 (D-365):** `browser-gateway` `unhealthy` (`/health` 503, fail-closed): Chromium-sandboxen krever `SYS_CHROOT` under `cap_drop ALL`. Isolerte prober (`ops/security/diagnose-browser-sandbox.sh`): A–E feiler, C (uten cap_drop) OK, F (`cap_drop ALL` + `SYS_CHROOT`) OK. `cap_add: [SYS_CHROOT]` + allowlist i `check-containment.mjs` er innført; **Bekreftet på NAS etter redeploy av `08ec679`:** `browser-gateway` `Up (healthy)`, `/health` → `{"status":"ok"}` (ekte Chromium startet med `chromiumSandbox:true` under seccomp), `CapAdd=[CAP_SYS_CHROOT] CapDrop=[ALL]`, Infisical `/api/status` 200, alle tjenester `Up`/`healthy`, `migrate`/`db-bootstrap` exit 0.
- **Fortsatt IKKE verifisert i runtime:** en faktisk browser-oppgave gjennom egress-proxyen (SSRF-blokkering mot LAN/metadata fra den kjørende gatewayen), Infisical/Langfuse funksjonelt under `*_app`-rollene utover oppstart/status, Swift-klienten, vertsside job-runner/GitHub App (Q-45), Q-44.
- **Funn 4 (rettet `f1f3103`):** `/chat`, `/dashboard`, `/voice` ga 503 `owner_not_configured` i den kjørende stacken fordi `main.ts` aldri satte `deps.owner` (tester satte den direkte på serveren). Wiring-test lagt til (feiler uten fiksen). **Bekreftet på NAS etter redeploy av `f1f3103`:** `/`, `/chat`, `/dashboard`, `/voice` → 200; `/chat` har nonce-`content-security-policy` og `x-frame-options: SAMEORIGIN`; `/chat` uten grant → 401, med identitetsfelt i body → 400. **Chat observert i runtime (2026-10-02 ~14:17 UTC, `audit_events` limt inn av Tobias):** innrullert nettleserenhet (`web-…`) fikk grant og en egen sesjon (`sess-<uuid>`, ikke en fast id), `identity.resolved` = ALLOW, `message.saved` og `memory.add/update` er merket med den sesjonen og enheten. Ikke dekket av denne observasjonen: innholdet i Jarvis sine svar (Tobias bekrefter visuelt), `/dashboard` og `/voice` med grant, voice-flyten og revokering av enheten i praksis.
- **Browser-egress observert LIVE på NAS (`ops/security/browser-egress-probe.sh`, utskrift limt inn av Tobias, `a9e0cf9`):** `SAMMENDRAG: 25 PASS, 0 WARN, 0 FAIL` – loopback/localhost/metadata/compose-verter (`api`, `postgres`)/docker-bro/NAS-LAN/ruter/CGNAT-Tailscale/IPv6 (inkl. IPv4-mappet)/heltall- og hex-IP/`file://`/credentials i URL/ikke-tillatt port/enkelt-label-vert alle `403 egress_blocked`; kontroll mot offentlig `https://example.com/` 200; REDIRECT fra offentlig side til metadata og til `api` blokkert (403); replay av token, uten token, feil hemmelighet og endret body alle 401; kun api/worker står på `browser`-nettet, gatewayen kun på `browser`, ingen host-port for 3030; gateway-loggen viser `browser_egress_denied` (`private_address`, `single_label_host`). Dette lukker «ikke kjørt live»-punktet for JARVIS-008 i den kjørende gatewayen.
- **Funn 5 (D-366):** CSP blokkerte inline `style`-attributter i `/`, `/dashboard`, `/voice` (konsollfeil limt inn av Tobias). Gjenskapt og fikset (`style-src-attr 'unsafe-inline'`, ellers uendret nonce-CSP); 0 CSP-brudd i ekte Chromium etter fiks. Bekreftelse på NAS gjenstår etter redeploy.

## 5. `BLOCKED_EXTERNAL` / åpne punkter (krever Tobias eller host)

1. **Runtime-verifisering på NAS** etter redeploy: `docker compose up -d --build`, så `docker top`/`docker exec id` (ikke-root), `docker inspect` (ReadonlyRootfs, CapDrop, SecurityOpt), `ss -tln`, og at Chromium faktisk starter med `chromiumSandbox:true` under `browser-gateway.seccomp.json` (ellers feiler gatewayen lukket – ingen stille nedgradering).
2. **`.env`-oppdatering før redeploy** (api/worker/migrate nekter å starte uten): `JARVIS_TENANT_ID`, `JARVIS_OWNER_PERSON_ID`, `JARVIS_OWNER_NAME`, `INFISICAL_DB_PASSWORD`, `LANGFUSE_DB_PASSWORD`, `JARVIS_BROWSER_GATEWAY_TOKEN_SECRET`, `JARVIS_GIT_ALLOWED_REPOS` (se `.env.example`).
3. **Live-DB-migrering 063/064** (`jarvis_definer`, komposittnøkler, unik sesjonsindeks som rydder duplikat-aktive sesjoner) og **`db-bootstrap` mot eksisterende `jarvis-pgdata`-volum** (eierskapsoverdragelse for `infisical`/`langfuse`): ta backup først (del 1-runbook), kontroller at Infisical og Langfuse starter under de nye rollene.
4. **Swift-klienten** (`apps/mobile`): ny godkjenningssignering er skrevet men IKKE kompilert/kjørt – bygg og test på macOS.
5. **Vertsside job-runner** for kodejobber og **kortlevd GitHub-identitet** (GitHub App) – Q-45. Inntil da feiler hver kodejobb lukket.
6. **Revokering av eksisterende enheter** som skal ut av bruk, og kontroll av at ingen aktive grants overlever nøkkelrotasjon på host.
7. Alle `BLOCKED_EXTERNAL` fra del 1 er uendret (backup/NAS-baseline, PC-worker, branch protection, fantomkostnad-kompensasjon).
8. Uavhengig arkitekt-review av BEGGE PR-er før merge (CLAUDE.md).

## 6. Bevisst IKKE gjort

Del 3 (taint-gate/ubetrodd-innhold, bekreftelsesmodell for utvidet verktøyflate, kostnads-/budsjettgrenser, øvrige `OPEN` funn). Q-44-gjelden (≈113 tenant-kryssende FK-er) og `memory_items`-unikhet er kun *låst som baseline*, ikke migrert. Non-extractable nettleser-nøkkel (JARVIS-066 delvis) er ikke bygget. Ingen vertsside job-runner er bygget (kun grensesnittet + fail-closed).

## 7. Arkitekt-review (2026-10-02) – funn og rettelser (D-368)

Uavhengig review av #218 (APPROVE) og #219 (CHANGES_REQUESTED, HEAD 637de6e + delta til 1b38e46). Rettet i denne PR-en:

| Funn | Status | Bevis |
|---|---|---|
| P1 `contract.owner_person_id` kunne settes av klienten (ble kodejobbens identitet / SOVEREIGN) | **Rettet** | `TaskService.submit` → `owner_mismatch`; `modules/tasks/test/fase6-worker.test.ts` (ekte Postgres: avvist før kø + audit; eierens egen kontrakt godtas) |
| P2 WebRTC/UDP utenom egress-proxyen | **Rettet** (gjenskapt: STUN-pakke nådde lokal UDP-lytter uten flaggene) | `CHROMIUM_LAUNCH_ARGS` + ekte-Chromium-test i `apps/browser-gateway/test/engine-egress.test.ts` |
| P3 per-enhet rate limit manglet på `grantBodyOrReject`-rutene | **Rettet** | `apps/api/test/review-219-http-guard.test.ts` |
| P3 `clientKey` stolte på FØRSTE XFF-element | **Rettet** (siste element) | samme testfil |
| P3 klartekst-passord i bootstrap-DDL kunne havne i serverlogg | **Rettet** (logging av) | `remediation-2-compose-isolation.test.ts` + kjører mot ekte Postgres |
| Live egress-bevis: redirect-testene godtok enhver ikke-200 | **Strammet** (krever 403 `egress_blocked`, WARN ellers) | `ops/security/browser-egress-probe.sh` |
| Swift hardkodet identitet, worker `CONNECTOR_ENV`, seccomp-trimming, egen egress-proxy, latent brukket jobb-container, `guardedFetch`-unntak, CSP-unntak, app-styrt RLS | **Utsatt** (alle P3/åpne risikoer) | Q-46 |

**Korrigerte påstander:** se D-368 (identitet fra grant, per-enhet-grenser, hardkodet identitet i Swift, SCRAM-formulering, `guardedFetch`-omfang, draft-status). **Ikke dekket av reviewen** (reviewer oppga selv): `FINAL_AUDIT_REPORT*.md`, de 68 `OPEN`-funnene utenfor del 1/2, `modules/business|finance|growth` utover guard-innsettingene, ops/backup/restore-verify i detalj, `ops/remediation/phantom-cost`-SQL. DB-suitene (control-plane-auth, device-revokering, schema-invarianter, compose-isolasjon/bootstrap) kunne ikke kjøres av reviewer (root); de kjøres her som ikke-root-bruker og i CI.
