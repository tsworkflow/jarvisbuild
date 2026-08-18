# UA-3 — DPIA / data-governance-notat (Business Domain Foundation + Open-Loop Detection + Business-Event-Linkage + Profiling/Scoring)

**Status:** UA-3 P0 «Business Domain Foundation» = VERIFIED/COMPLETE (D-52, host-bevist run_id
`ca2d9248`). UA-3 «Open-Loop Detection + Daily/Weekly Business Brief» = VERIFIED/COMPLETE (2026-08-17,
host-bevist run_id `de01ca07`, se D-53/D-54/D-55/D-56 i DECISIONS_AND_ASSUMPTIONS.md). UA-3
«Business-Event-Linkage (Gmail/Calendar → Business OS)» = VERIFIED/COMPLETE (2026-08-17, host-bevist
run_id `6c6a4948`, `hard_fail=false`, se D-57/D-58/D-59/D-60). Personvernsgarantiene under (ingen
Gmail-body/emne/deltakerinnhold i `business_activities`, kun kilde-peker) er nå bekreftet LIVE via
`ua3_events_no_body_content_stored=PASS` og `ua3_events_audit_safe=PASS` på ekte host, ikke kun
suite-bevist. UA-3 «Profiling/Scoring» (akseptansekriterium 4) = FIXED_SUITE / READY_FOR_HOST_VERIFY
(2026-08-17, IKKE host-verifisert ennå, se D-61).
Dette notatet dekker den strukturerte tredjeparts-persondata-kategorien UA-3 introduserer (kunde-/
kontakt-/selskapsdata i `business_*`-tabellene, inkl. NÅ `business_open_loops`) - utfyller, erstatter
ikke, `docs/security/DPIA_DRAFT.md` sin generelle "Bedriftsdata (kunder, e-post)"-rad.

## Business-Event-Linkage (NY, UA-3 D-57)

Gmail/Calendar-hendelser (allerede eier-autoriserte UA-0/UA-7-P0-connectorer - INGEN ny leverandør-
tilgang gitt i dette sliceet) leses forbigående via `BusinessEventSyncService` for å utlede EN kort,
strukturert `business_activities`-rad PER matchet melding/møte. **Kritisk arkitekturprinsipp uendret
fra P0/§15:** selve e-post-body-teksten/møtebeskrivelsen flyter ALDRI inn i `business_activities` -
kun emne/tittel (allerede korte, strukturerte felt fra Gmail/Calendar sine egne metadata) lagres som
`summary`, og `canonical_uri` er en peker TILBAKE til kilden (Gmail sin egen weblenke, Calendar sin
egen `html_link`) - ALDRI en kopi. Strukturelt bevist i `business-event-sync.test.ts` (test C/K: en
syntetisk "HEMMELIG-KROPP"-body-tekst i test-fixturen verifiseres ALDRI å havne i noen lagret rad).

**Entitetsgjenkjenning er deterministisk, ikke AI-basert profiling:** en Gmail-melding/Calendar-
deltaker kobles til en `business_contact` KUN ved eksakt e-postadresse-match (case-insensitiv) - aldri
et LLM-avgjort gjettet navn/identitet-treff. Ved 0 treff (ukjent avsender/deltaker) opprettes INGEN
aktivitet (aldri støy fra ukjente tredjeparter i innboksen); ved >1 distinkt selskaps-treff (tvetydig)
opprettes INGEN aktivitet (aldri en gjettet feilkobling til feil kunde/selskap). Dette er samme
"deterministisk-først, fail-safe-ved-tvetydighet"-prinsipp som `OpenLoopService` sin egen deteksjon
(D-53) - INGEN sensitive kategorier (helse/etnisitet/religion/politikk osv.) utledes noensinne.

**Kildekonto-omfang (kjent, dokumentert forenkling):** alle bedrifts-tenants synkroniseres i dag mot
SAMME ene tilkoblede Google-konto (`JARVIS_GOOGLE_ACCOUNT`) - deterministisk kontakt-e-post-matching
sikrer likevel at en aktivitet KUN registreres for tenanten hvis kontakt faktisk matcher, aldri på
tvers. Ingen ny persondata-kategori utover det P0 allerede etablerte (`business_contacts`) - Gmail/
Calendar-hendelser produserer KUN `business_activities`-rader (samme OPERATIONAL METADATA-kategori
som øvrige aktiviteter, se tabellen under), aldri nye kontakt-/personopplysningsfelt.

## business_open_loops (NY, UA-3 NEXT SLICE / D-53)

`business_open_loops` er en AUTOMATISK DERIVERT tabell - hver rad er et system-generert resultat av en
deterministisk regel kjørt over EKSISTERENDE `business_followups`/`business_opportunities`-data, ikke en
ny persondata-INNTAKSVEI. Ingen nytt personopplysningsfelt introduseres: `reason`/`next_action` er
korte, systemgenererte setninger som refererer et EKSISTERENDE followup/opportunity-tittelfelt (samme
tekst som allerede ligger i P0-tabellene) - klassifisert som **OPERATIONAL METADATA**, samme kategori
som `business_followups`/`business_opportunities`/`business_activities` selv (se tabellen under).
`owner_person_id` refererer en EKSISTERENDE `people`-rad (samme mønster som resten av Business OS).
Ingen AI Mesh-basert profiling/scoring brukt til å utlede `priority` (deterministisk fra forfalt-
/stagnert-varighet) - se D-53 §11/§12 for full begrunnelse. RLS/tenant-/memory-space-isolasjon: SAMME
FORCE RLS-mønster som alle andre business-tabeller (`020_business_open_loops.sql`).

## Hvilke data lagres

| Tabell | Datakategori | Eksempel på innhold |
|---|---|---|
| `business_companies` | Selskapsnavn, domene, status, kilde, eier | "Acme AS", "acme.no", "prospect" |
| `business_contacts` | **Tredjeparts persondata:** navn, e-post, telefon, tittel, tilhørende selskap | "Kari Nordmann", "kari@acme.no", "+47..." - EKTE personopplysninger om personer HOS kunden/selskapet, ikke Tobias selv |
| `business_leads` | Lead-tittel, status, kilde-referanse (source_type/source_instance_id/external_id) | "Interessert i tjeneste X", "new" |
| `business_opportunities` | Deal-tittel, pipeline-stadium, beløp (øre), valuta, forventet lukkedato | "Acme - tjeneste X", "qualified", 500000 |
| `business_activities` | Aktivitetstype, KORT strukturert sammendrag, kilde-peker (`canonical_uri` - ALDRI kopi av fullt innhold) | "E-post mottatt", peker til Knowledge-dokument/ekstern kilde |
| `business_followups` | Oppgave-tittel, frist, prioritet, status, eier, årsak, neste handling | "Send tilbud", forfallsdato, "open" |
| `business_open_loops` (NY, D-53) | **AUTOMATISK DERIVERT** - deteksjonstype, kort systemgenerert begrunnelse (refererer eksisterende followup-/opportunity-tittel), deterministisk prioritet, status, eier | "overdue_followup", "Oppfoelging 'Send tilbud' er forfalt", "high", "open" |
| `business_scores` (NY, D-61) | **AUTOMATISK DERIVERT** - score-type, tall (0-100), versjonert faktor-forklaring (kode+label+vekt), kilde-ID-referanser, valgfri eier-overstyring | "lead_priority", 45, `[{"code":"status_qualified","label":"Lead-status: qualified","weight":30,"contribution":30}]` |

**Kritisk arkitekturprinsipp (§15 i byggeordren):** `business_activities.canonical_uri` er en LØS PEKER
til Knowledge/eksterne kilder - UA-3 P0 kopierer ALDRI fulle e-post-kropper, dokumentinnhold eller
samtaleutskrifter inn i egne tabeller. Selve innholdet forblir i Knowledge (UA-2) eller hos den
eksterne kilden; Business OS lagrer kun strukturert state + en peker.

## Datakategoriklassifisering (§26/§27 i byggeordren)

| Kategori | Tabeller | Retensjon/sletting |
|---|---|---|
| **CONTENT** (tredjeparts persondata Tobias/selskapet er behandlingsansvarlig for) | `business_contacts` (navn/e-post/telefon) | Slettes ved eksplisitt forespørsel (fremtidig D-klasse-operasjon, IKKE bygget i P0 - se Q-25). Ingen automatisk retensjonsgrense satt i P0 - operasjonell forretningsdata, ikke midlertidig cache |
| **OPERATIONAL METADATA** (relasjonens tilstand, ikke selve kildeinnholdet) | `business_companies`/`business_leads`/`business_opportunities`/`business_activities`/`business_followups`/`business_open_loops` (NY, D-53 - automatisk derivert, ikke en ny inntaksvei) | Retained ved Q-20-sletting av et REFERERT Knowledge-dokument (ingen FK - se under). Slettes/anonymiseres KUN sammen med hele tenanten (samme mønster som øvrige tenant-scopede tabeller) |
| **DERIVED / OPERATIONAL METADATA** (systemberegnet prioriteringsverdi, ikke en ny persondata-kilde) | `business_scores` (NY, D-61 - automatisk derivert fra EKSISTERENDE lead-/opportunity-/aktivitets-/oppfoelgings-/open-loop-data) | Samme retensjon som `business_open_loops`. `evidence`-feltet er en løs referanse (ingen FK) - overlever en referert kildes fjerning uten cascade-feil |
| **AUDIT-EVENT** | `audit_events`-rader for `tool_id='business'` | Append-only (uendret fra eksisterende audit-arkitektur), inneholder ALDRI navn/e-post/telefon (kun `credential_ref`/`external_id`/`scopes`/`rollback` - verifisert i `business-transport-wiring.test.ts` §N) |
| **DERIVED / OPERATIONAL METADATA** (Zendesk-ticket current-state, ikke en kopi av kundekommunikasjon) | `zendesk_tickets` (NY, D-64 - subject/status/priority/kontakt-/selskaps-lenke, ALDRI kommentarinnhold) | Samme retensjon som `business_open_loops`/`business_scores`. Slettes/anonymiseres KUN sammen med hele tenanten |

## Q-20-interaksjon (§26 i byggeordren)

`business_activities.canonical_uri` har INGEN fremmednøkkel (FK) til `knowledge_documents` - kun en løs
tekst-peker (strukturelt bevist i `business-service.test.ts` §S/T). Konsekvens: en fremtidig Q-20-hard-
sletting av et Knowledge-dokument en aktivitet peker til gjør pekeren ganske enkelt ustabil/ikke-
oppløsbar - ALDRI en cascade-feil, ALDRI en database-konstraint-krasj, og ALDRI en vei til å
"gjenopplive" det slettede innholdet (aktiviteten selv inneholder kun det korte, allerede lagrede
sammendraget - ikke kildens fulle tekst). Ingen kompleks cascade-slette-logikk er bygget, siden ingen
FK-relasjon finnes å cascade fra - dette er en BEVISST designbeslutning (D-49), ikke et overset gap.
`business_open_loops` (D-53) har SAMME egenskap - `canonical_uri`-feltet er også en løs peker uten FK
til `knowledge_documents`, strukturelt bevist i `open-loop-service.test.ts` §M.

## Tenant-/RLS-isolasjon

Alle 6 tabeller er `FORCE ROW LEVEL SECURITY` med BÅDE tenant- og memory-space-policyer
(`019_business.sql`, samme mønster som `knowledge_documents`/`memory_items`) - databasenivå, ikke kun
applikasjonskode. Multi-selskap (flere bedrifts-tenants) krever INGEN skjemaendring (D-21/
`docs/security/TENANT_MODEL.md` §3) - hver nye bedrift er en egen tenant-rad med egen RLS-isolasjon,
akkurat som Kundeoppfølging AS i dag.

## Rettslig ramme (foreløpig, uendret vurderingsprinsipp fra DPIA_DRAFT.md §2)

`business_contacts` inneholder EKTE tredjeparts persondata (personer hos kunder/prospekter, ikke
Tobias selv) - dette er kjernen i det eksisterende "bedriftsdata gjør Tobias/selskapet
behandlingsansvarlig med fullt GDPR-ansvar"-prinsippet fra `DPIA_DRAFT.md`. UA-3 P0 bygger INGEN ny
juridisk vurdering utover det som allerede er dokumentert der - kun den strukturerte datamodellen
prinsippet nå faktisk gjelder for. Databehandleravtaler/region-/retensjonsmatrise for eksterne
tredjeparter (f.eks. et fremtidig CRM-eksport-mål) er IKKE vurdert i P0, siden ingen ekstern
tredjepartsoverføring er bygget denne runden.

## Profiling/Scoring (NY, UA-3 D-61) - akseptansekriterium 4

`business_scores` (`022_business_scoring.sql`) er en AUTOMATISK DERIVERT tabell - hver rad er et
system-beregnet resultat av en deterministisk regel kjørt over EKSISTERENDE
`business_leads`/`business_opportunities`/`business_activities`/`business_followups`/
`business_open_loops`-data, ikke en ny persondata-INNTAKSVEI. Klassifisert som **DERIVED /
OPERATIONAL METADATA** (samme kategori som `business_open_loops`) - se oppdatert tabell under.

**Formålsbegrensning (purpose limitation):** scoren brukes UTELUKKENDE til intern forretnings-
prioritering (hvilke leads/opportunities trenger oppmerksomhet først) - ALDRI til å avgjøre noe om en
person (kreditt, ansettelse, forsikring eller lignende regulert automatisert beslutning). Se §10 under.

**Tillatte faktorer (allowed factors):** KUN forretnings-tilstandssignaler fra data Business OS allerede
eier - lead-status, opportunity-pipeline-stadium, aktivitets-nylighet, oppfoelgings-status (aapen/
forfalt), EKSISTERENDE `OpenLoopService`-stagnert-flagg. Den fullstendige whitelisten er kodifisert
(`ALLOWED_LEAD_FACTOR_CODES`/`ALLOWED_OPPORTUNITY_FACTOR_CODES` i `scoring-rules.ts`), ikke bare
dokumentert i prosa.

**Forbudte faktorer (prohibited factors):** rase/etnisitet, religion, politisk oppfatning, seksuell
orientering, helsestatus, funksjonsnedsettelse, genetiske/biometriske trekk, fagforeningsmedlemskap,
personlighet/psykologisk profil, formue/inntekt/sosioøkonomisk status, kjønn, sivilstatus - HÅNDHEVET
strukturelt (`assertNoProhibitedFactorCodes()` kaster for enhver kode som matcher, kjørt ved modul-load
OG på hver faktisk beregnet faktor-liste), ikke bare som en policy-tekst. Scoring-motoren leser ALDRI
`business_contacts`/`people`-tabellene utover en eksisterende `owner_person_id`-identitetsreferanse -
kontakt-/person-nivå-scoring er derfor arkitektonisk umulig, ikke bare en utsatt funksjon.

**Kilde-proveniens (source provenance):** hver score har `evidence` (strukturerte `{type,id}`-
referanser til aktivitet-/oppfoelgings-/open-loop-ID-er) - ALDRI kopiert kildeinnhold, samme
løs-peker-prinsipp som `business_activities.canonical_uri`.

**Forklarbarhet (explainability):** hver score returneres ALLTID sammen med `factor_summary` (kode +
menneskelesbar label + vekt + bidrag per faktor) og `rule_version` - aldri et opakt tall alene. Jarvis
kan alltid svare "hvorfor er denne leaden scoret X" med en deterministisk, kilde-forankret begrunnelse.

**Menneskelig/juridisk kontroll:** `set_manual_override`/`clear_manual_override` gir eieren en
eksplisitt, auditert mulighet til å overstyre en beregnet score (uten å forfalske selve de underliggende
faktorene/kildedataene) - auditert via den EKSISTERENDE `ToolGateway`-audit-veien (`audit_events`,
`tool_id='business'`, ALDRI overstyrings-begrunnelsen i klartekst utover det som allerede er tillatt i
audit-payloaden).

**AI-bruksgrenser:** v1 (`lead_priority_v1`/`opportunity_risk_v1`) er 100% deterministisk - INGEN
AI Mesh-/ModelGateway-kall brukes til å beregne scoren (strukturelt bevist: `scoring-rules.ts` importerer
aldri `@jarvis/model-gateway`). En fremtidig versjon som bruker AI Mesh til semantisk tolkning (der ekte
tvetydighet krever det) MÅ fortsatt aldri utlede beskyttede trekk, og MÅ gå gjennom Model Gateway som
resten av kjernen - ingen direkte provider-SDK-bruk.

**Forbud mot autonom hoy-konsekvens-personbeslutning (§10):** en score kan ALDRI autonomt avvise en
person, nekte en tjeneste, avslutte et forhold, eller avgjøre kreditt/ansettelse/forsikring - ingen
slik kobling finnes strukturelt (`business_scores`-skjemaet har ingen slik kolonne, `ScoringService`
kaller aldri en ekstern handling/ToolGateway-transport). Forretnings-PRIORITERING (rangering for
intern oppmerksomhet) er eksplisitt tillatt og er alt denne sliceen gjør.

**Retensjon:** samme mønster som `business_open_loops` - scoren slettes/anonymiseres sammen med hele
tenanten (ingen separat retensjonsgrense denne runden), og en Q-20-sletting av en referert kilde
(f.eks. en aktivitet) etterlater KUN en løs, ikke-oppløsbar `evidence`-referanse - aldri en cascade-feil
eller en vei til å "gjenopplive" slettet innhold (bevist i test V i `scoring-service.test.ts`).

**Rettslig grunnlag (legal basis, Appendiks D-gate "Legal basis/processing inventory; human/legal
control where automated decisions have regulated effect"):** behandlingsgrunnlaget for
`business_scores` er berettiget interesse (GDPR art. 6(1)(f)) - intern forretningsprioritering av
allerede lovlig innsamlet CRM-/aktivitetsdata, ingen ny persondata-kategori innhentet for scoring-
formålet. **GDPR art. 22 (automatiserte enkeltavgjørelser) er IKKE relevant for denne sliceen** - en
score verken "produces legal effects" eller "similarly significantly affects" en person: den avviser
aldri en person, nekter aldri en tjeneste, og avgjør aldri kreditt/ansettelse/forsikring (§10 over) -
den er UTELUKKENDE et internt prioriterings-/rangeringssignal for Tobias/teamet, alltid med eier-
tilgjengelig manuell overstyring og full forklarbarhet selv om art. 22 sitt strengere krav ikke
utløses. Databehandleravtaler/tredjelandsoverføring er IKKE relevant - `business_scores` beregnes og
lagres utelukkende i egen Postgres, ingen ekstern prosessor mottar scoringsdata denne runden.
**Menneskelig/juridisk kontroll er derfor dokumentert TILSTEDE (manuell overstyring + audit + full
forklarbarhet) SELV OM den strengt tatt ikke var juridisk påkrevd** for denne uregulerte,
lav-konsekvens bruken - Appendiks D-gaten er dermed oppfylt både i bokstav (kontroll finnes) og ånd
(ingen regulert-effekt-beslutning å kontrollere for).

**Ikke i scope denne runden (se Q-25):** kontakt-/person-nivå-scoring (arkitektonisk umulig); AI Mesh-
basert scoring-forbedring; finere per-tenant/policy-nivå av/på-bryter utover deployment-wiring;
kontrakt-/faktura-verdi-baserte faktorer.

## Support/Tickets (Zendesk, NY, UA-3 D-64) - akseptansekriterium 1 (delvis)

Zendesk er UA-3 sin FØRSTE ekte kundekontakt-connector med en ekstern leverandør-credential (i
motsetning til Gmail/Calendar, som allerede var provider-besluttede UA-0/UA-7-P0-connectorer, og
profiling/scoring, som ikke hadde noen ekstern credential i det hele tatt). Provider-valget selv
(Zendesk fremfor Intercom/Freshdesk/Chatwoot) er dokumentert som en EGEN, separat beslutning (se
DECISIONS_AND_ASSUMPTIONS.md D-64-forgjengeren - forskningsrapporten levert FØR denne
implementasjonsordren) - denne seksjonen dekker KUN selve implementasjonens data-governance.

**Hva leses (transient), hva lagres (persistent):** Zendesk-ticket-felt (emne, status, prioritet,
tildelt agent, requester-e-post, organisasjon) leses via `ZendeskTransport` PER SYNK-KJØRING - KUN
emne/status/prioritet/tildeling/kontakt-/selskaps-lenke/kilde-URL lagres i `zendesk_tickets`
(current-state) og en tilsvarende, kort `business_activities`-rad (`source_type='zendesk'`). Selve
kommentarinnholdet/samtalen mellom kunde og agent leses ALDRI inn i noen Jarvis-tabell - Zendesk
sin egen Ticket Audits-API forblir den autoritative historikken, hentet on-demand
(`zendesk.get_ticket_audits`, klasse A) når eksplisitt etterspurt, ALDRI automatisk speilet inn i
`business_activities.summary` (strukturelt bevist: testene AE/§summary.length<200 i
`zendesk-event-sync.test.ts` og host-akseptansen `ua3-zendesk-live.ts`).

**Deterministisk kontakt-gjenkjenning (§9/§18 i byggeordren):** requester-e-postadressen er den
ENESTE identiteten brukt for å lenke et ticket til en `business_contact` - SAMME
`findContactsByEmail()`-mekanisme som Gmail/Calendar (D-57), ALDRI en AI Mesh-gjettet kobling. 0
treff eller >1 distinkt selskap blant treffene betyr ticketet IKKE persisteres i det hele tatt
(verken `zendesk_tickets` eller `business_activities`) - unngår at samme fysiske ticket dupliseres
på tvers av flere bedrifts-tenants som deler samme Zendesk-konto (samme delt-konto-forbehold som
Gmail/Calendar, se Q-25 item 10 - dokumentert der, ingen egen Q-postering nødvendig for dette
spesifikke forbeholdet).

**Rettslig grunnlag (legal basis, Appendiks D-gate):** behandlingsgrunnlaget for `zendesk_tickets`/
de Zendesk-avledede `business_activities`-radene er berettiget interesse (GDPR art. 6(1)(f)) - intern
kundeoppfølging av allerede-eksisterende kundekontaktdata (samme prinsipp som Gmail/Calendar-
lenkingen, D-57/D-60). **GDPR art. 22 er IKKE relevant** - hverken det å lenke et ticket til Business
OS-tidslinjen eller `support_ticket_needs_reply`-open-loop-regelen "produces legal effects" eller
"similarly significantly affects" en person: det er utelukkende operasjonell synlighet/prioritering
for Tobias/teamet, aldri en automatisert avgjørelse OM kunden (avviser aldri en tjeneste, fatter
aldri en kreditt-/ansettelses-/forsikringsbeslutning).

**Full useful capability (D-41) og databehandleravtale:** i motsetning til profiling/scoring har
Zendesk-connectoren FULL les/skriv/slett/admin-kapabilitet (D-41 Owner Connector Capability
Invariant - se D-64-kapabilitetsmatrisen i sluttrapporten) - inkludert permanent sletting
(`delete_ticket`) og GDPR-redigering (`redact_ticket_content`, direkte mot Zendesk sin egen
redigeringsfunksjon for kommentarinnhold). Zendesk selv er en databehandler for kundekommunikasjonen
som fortsatt ligger i Zendesk (Jarvis kopierer den aldri inn) - en formell databehandleravtale
(DPA) med Zendesk er Tobias sitt eget ansvar å inngå ved reell produksjonsbruk (utenfor denne
kodebasens scope å dokumentere/signere), men er IKKE en forutsetning for at Jarvis sin egen
tekniske arkitektur (pointer-not-payload, deterministisk lenking, RLS-isolasjon) skal være korrekt
utformet.

**Q-20-interaksjon:** SAMME mønster som Gmail/Calendar/open-loops - `zendesk_tickets.canonical_uri`
og `business_activities.canonical_uri` er LØSE pekere uten FK til noe Knowledge-dokument. En
fremtidig Q-20-sletting av en referert kilde gjør pekeren ustabil/ikke-oppløsbar, ALDRI en
cascade-feil eller en vei til å gjenopplive slettet innhold.

**Webhook-mottak (§22/§23 i byggeordren) - sikkerhetsprinsipp:** `POST /webhooks/zendesk` er den
FØRSTE innkommende webhook-mottakeren i kodebasen. Selve webhook-KROPPEN brukes ALDRI direkte til å
skrive Business OS-data - kun ticket-ID-en trekkes ut (`parseZendeskWebhookEvent()`), og
normalisering skjer UTELUKKENDE via en FERSK `zendesk.get_ticket`-henting gjennom ToolGateway. Selv
om signaturverifiseringen (HMAC-SHA256, Zendesk sin dokumenterte mekanisme) skulle svikte et sted,
kan INGEN utro/uautentisert feltinnhold noensinne nå Business OS.

**Ikke i scope denne runden (se D-64 sluttrapport/Q-25/Q-27):** automatisk ingestion av Zendesk
Ticket Audits/kommentarhistorikk inn i `business_activities` (kun on-demand-lesing via
`zendesk.get_ticket_audits`, aldri auto-speilet); Zendesk sin cursor-baserte Incremental Export-API
(enklere standard-listing brukt i v1, se D-64 kapabilitetsaudit); trigger-/automation-konfigurasjon
utover Jarvis sin egen webhook-registrering; flere Zendesk-instanser per tenant.
