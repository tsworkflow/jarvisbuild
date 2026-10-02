// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
//
// D-131 (uavhengig arkitektkontroll av PR #79, funn 2): DEN DOKUMENTERTE,
// TRYGGE LOKALE BOOTSTRAPPEN for enhets-innrullering.
//
// Reviewen krevde at anonym innrullering/nøkkeloverskriving nektes, MEN uten en
// hardkodet bypass og uten nye eksterne credentials. Denne CLI-en er svaret:
//
//   - Den er en EKSPLISITT eier-handling på Tobias sin egen maskin, ikke en
//     nettverksrute. Autoriteten er «du har admin-tilgang til databasen og
//     kjørte denne kommandoen», ikke «du klarte å nå en HTTP-port».
//   - Den bruker de SAMME admin-DB-credentialene migrasjonene allerede kjører
//     med (`adminConfigFromEnv`, allerede i `.env.example`). INGEN ny credential,
//     ingen ny leverandør, ingen ny hemmelighet i repoet.
//   - Billetten er engangs, kortlevd, bundet til tenant/person (og valgfritt én
//     device_id), og lagres KUN som SHA-256. Hemmeligheten vises ÉN gang, her.
//
// Etter at FØRSTE enhet er innrullert trengs ikke CLI-en igjen: nye enheter og
// nøkkelrotasjon autoriseres med proof-of-possession fra en enhet som allerede
// er innrullert (`enrollment.kind = "device_proof"`).
//
// Bruk:
//   node --experimental-transform-types src/enroll-ticket-main.ts \
//     [--tenant <id>] [--person <id>] [--device <id>] [--ttl-minutes <n>] [--path <side>]
//
// Uten flagg brukes SAMME validerte eier-konfig som `seedOwner()`
// (JARVIS_TENANT_ID / JARVIS_OWNER_PERSON_ID).
//
// D-347: `--path` velger hvilken side den klikkbare lenken peker til
// (`voice` er uendret default - D-260 sin opprinnelige, testede oppførsel).
// `apps/web/index.html` og `apps/web/dashboard.html` fikk NÅ samme
// `tryAutoEnrollFromUrl()`-mønster som `voice.html` (delt `jarvis.deviceid`/
// `jarvis.devicekey` i localStorage PER OPPRINNELSE - alle tre sidene på
// samme host:port innrullerer derfor SAMME enhet uansett hvilken side
// billetten konsumeres fra). Flagget finnes for å kunne peke lenken direkte
// til siden eieren faktisk trenger akkurat da (f.eks. `--path dashboard`),
// uten en ekstra manuell navigering etter innrullering.
import { ownerConfigOrExit } from "./owner.ts";
import { adminConfigFromEnv, createEnrollmentTicket, createPool } from "@jarvis/core";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Remediering del 2 (JARVIS-065): eier fra validert konfig (fail closed uten); flagg kan overstyre KUN eksplisitt.
const ownerConfig = ownerConfigOrExit();
const tenantId = flag("tenant") ?? ownerConfig.tenant_id;
const personId = flag("person") ?? ownerConfig.owner_person_id;
const deviceId = flag("device");
const targetPath = (flag("path") ?? "voice").replace(/^\/+/, "");
const ttlRaw = flag("ttl-minutes");
const ttlMinutes = ttlRaw === undefined ? 15 : Number(ttlRaw);
if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 120) {
  console.error("ugyldig --ttl-minutes (1-120)");
  process.exit(2);
}

const adminPool = createPool(adminConfigFromEnv());
try {
  const created = await createEnrollmentTicket(adminPool, {
    tenant_id: tenantId,
    person_id: personId,
    ...(deviceId !== undefined ? { device_id: deviceId } : {}),
    ttl_minutes: ttlMinutes
  });
  // Hemmeligheten skrives til stdout på eierens egen terminal og ingen andre
  // steder - ALDRI til en loggfil, aldri til audit, aldri til databasen
  // (der ligger kun SHA-256 av den).
  console.log("");
  console.log("Innrullerings-billett (vises kun nå, engangs):");
  console.log("");
  console.log(`  ${created.ticket}`);
  console.log("");
  console.log(`  tenant: ${tenantId}`);
  console.log(`  person: ${personId}`);
  console.log(`  enhet:  ${deviceId ?? "(enhver device_id for denne personen)"}`);
  console.log(`  utloper: ${created.expires_at.toISOString()}`);
  console.log("");
  // D-260 (Tobias direkte i chat: gjentatte "enrollment_ticket_invalid"-feil
  // på tvers av flere FERSKE, korrekt genererte billetter - bekreftet
  // rotårsak "skrev feil": manuell kopiering av denne 44-tegns base64url-
  // strengen FRA en terminal TIL et nettleser-skjema er strukturelt
  // feilutsatt (mobile nettlesere/SSH-klienter tolker ofte `-`/`_` som
  // ordgrenser ved dobbelttrykk-for-å-velge). `apps/web/voice.html` sin
  // `tryAutoEnrollFromUrl()` leser nå billetten fra en `?enroll=`-URL-
  // parameter og innrullerer AUTOMATISK ved sidelasting - null manuell
  // tekstseleksjon. Når `JARVIS_PUBLIC_VOICE_BASE_URL` er satt (én gang, i
  // `.env` - se `.env.example`), skrives derfor en FULLSTENDIG, KLIKKBAR
  // lenke her: de fleste SSH-klienter/terminalemulatorer gjenkjenner en
  // `https://`-URL i output og gjør den klikkbar uten at brukeren markerer
  // noe som helst selv.
  const publicBaseUrl = process.env["JARVIS_PUBLIC_VOICE_BASE_URL"];
  if (publicBaseUrl) {
    const enrollUrl = `${publicBaseUrl.replace(/\/+$/, "")}/${targetPath}?enroll=${created.ticket}`;
    console.log("  Åpne denne lenken direkte (innrullerer automatisk, ingen kopiering nødvendig):");
    console.log("");
    console.log(`  ${enrollUrl}`);
    console.log("");
  } else {
    console.log(
      "  (Sett JARVIS_PUBLIC_VOICE_BASE_URL i .env for å få en klikkbar innrulleringslenke her i stedet " +
        "for å måtte kopiere billetten manuelt - se .env.example.)"
    );
    console.log("");
  }
} finally {
  await adminPool.end();
}
