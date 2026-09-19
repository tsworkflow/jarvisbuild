# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/v4-weekly-business-brief-push`, to lokale commits klare
for push: D-198 (`3d84cd0`) + D-199 (`c92a0db`). **PR #95/#96(W1)/#98/#87/#99(D-194)/#100(D-195)/
#101(D-196)/#102(D-197) er ALLE MERGET.** Aktiv oppgave: **D-198 (V4 ukentlig business-brief-push)
+ D-199 (UA-11 Executive dashboard-UI, lese-delen) - klar for push/PR under D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. **D-198 og D-199 eksplisitt delegert av Tobias** - D-198s designbeslutning
("din call, fortsett med det du mener er riktig") og D-199s prioriteringsrekkefølge ("Begge, din
prioriterte rekkefølge" - dashboard-UI FØR UA-11 K2) avgjort/utført av Claude selv. Se D-192 i
DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet. Brukt for PR #96, #98, #87, #99, #100,
#101, #102 og kommende D-198/D-199-PR.

## Hvor `main` står nå

- **PR #95/#96(W1)/#98/#87 MERGET** (se tidligere økters detaljer i git-historikk/DECISIONS_AND_ASSUMPTIONS.md).
- **PR #99 (D-194, V1 Value Track Telegram-leveringsfiks) MERGET** (`569f39f`).
- **PR #100 (D-195, UA-10 infra-slice: incidents-broen) MERGET** (`6a78c8d0`).
- **PR #101 (D-196, V3 Builder Loop: main.ts drain-løkke-feillogging-fiks) MERGET** (`a794d66d`).
- **PR #102 (D-197, RUNTIME_GATES.md UA-7/UA-8/UA-9-dokumentasjonshull lukket) MERGET** (`f5b5f346`).
- **D-198 (V4 Business Operating Loop: ukentlig business-brief-push, DENNE BRANCHEN, commit `3d84cd0`,
  IKKE PUSHET ENNÅ):** `business.get_business_brief` (D-53) var ALDRI schedulert/pushet - kun
  on-demand. Bygget KUN den ukentlige push-varianten (mandag kl. 07 default, `DailyScheduler`),
  BEVISST IKKE en daglig push (ville duplisert `situations`-broens allerede eksisterende
  sanntidsvarsling av de samme individuelle hendelsene) og BEVISST IKKE V2s cross-channel-visning
  (samme overlapp-begrunnelse). Ekstraherte `DailyBrief.deliverViaTelegram()` sin chunket/idempotente
  Telegram-leverings-mekanisme til en delt `deliverChunkedTextViaTelegram()` FØR den fikk en andre
  bruker. 16 nye tester (12 i `business-brief.test.ts`, 4 strukturell wiring-vakt). Se D-198.
- **D-199 (UA-11 Executive dashboard-UI, lese-delen, SAMME BRANCH, commit `c92a0db`, IKKE PUSHET
  ENNÅ):** `modules/executive` sitt fullt bygde 17-handlings `executive.*` ToolGateway-namespace
  hadde INGEN HTTP-rute/UI. Bygget KUN de to lese-handlingene (`get_attention_queue`,
  `get_control_surface_status`) via ny `POST /executive/query` (hardkodet allowlist, samme
  grant-autoritet som `/chat`/`/brief`) + ny `GET /dashboard` (`apps/web/dashboard.html`, samme
  enhetsnøkkel-/grant-flyt som `apps/web/index.html`). De 15 mutasjonshandlingene (pause/resume/
  kill-switch/revoke osv.) forblir BEVISST utenfor allowlistet - egen, senere slice. 16 nye tester
  (10 e2e - ekte HTTP/Postgres, ikke kjørt lokalt pga. sandbox-`initdb`-begrensning, verifiseres av
  CI; 6 DB-uavhengig strukturell wiring-vakt, kjørt og grønt lokalt). Se D-199.

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Push denne branchen (D-198 + D-199, to commits), åpne draft-PR, vent på CI, merge under D-192.
2. Videre kodbart masterplan-arbeid (samme "fullfør planen til credential-grensen"-oppdrag):
   - UA-11 Executive Mode "K2": decision log/scenarios/risk register/OKRs/delegation board (navngitt
     i masterplanen, zero kode, zero ekstern avhengighet - ingen eksisterende kanonisk kilde å
     komponere fra, krever ny datamodell fra bunnen).
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer.
