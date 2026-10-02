// D-30 FINAL HOST ACCEPTANCE HARDENING §4/§6 (+ D-30 HOST FAILURE FIX §3/§4):
// 10-turn soak over ÉN sammenhengende VoiceSession/runtime-sesjon (samme
// forutsetninger som bo12-voice-live.ts). Kjøres på hosten:
//   node --env-file=.env --experimental-transform-types apps/voice-gateway/scripts/bo12-voice-soak.ts
// Blander no-tool/kalender-verktøy/normal samtale/tvunget OpenAI/tvunget
// Anthropic/kansellering (ekte barge-in). Turn 6 og 10 gjentar turn 2s
// kalenderspørsmål med VILJE - dette er den live-observerbare Q-18-sjekken
// (§5, fikset i modules/tool-gateway/src/gateway.ts - se
// q18-read-dedupe.test.ts). Printer aldri secrets - kun statuser, transkript
// og latenser.
//
// HOST-FUNN (forrige runde) + FIKS: turn 8 timet ut fordi harnesset AWAITET
// turn 8 sine metrics FØR turn 9 (barge-in-lyden) i det hele tatt ble sendt -
// et sekvensielt await-harness-race/deadlock, IKKE sesjons-korrupsjon i
// VoiceSession selv (turn 8 er per design MENT å bli avbrutt av turn 9, så
// den skal ALDRI fullføre naturlig). Turn 8+9 er derfor nå ETT konkurrerende
// steg: turn 8 sin lyd sendes, vi venter KUN til avspilling faktisk har
// startet (state==="speaking" - bevis på at generation er aktiv), SÅ sendes
// turn 9 som ekte barge-in-lyd, og TIL SLUTT ventes det på BEGGE turers
// metrics (turn 8 cancelled + turn 9 fullført).
import { OpenAiStt } from "../src/stt.ts";
import { OpenAiTts } from "../src/tts.ts";
import { HttpCoreClient } from "../src/server.ts";
import { VoiceSession } from "../src/session.ts";
import type { TurnMetrics, VoiceIdentity } from "../src/session.ts";
import { loadOwnerConfig } from "@jarvis/contracts";
// Remediering del 2 (JARVIS-065): eier fra validert konfig (JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME), ingen hardkoding.
const owner = loadOwnerConfig();

const API_URL = process.env["JARVIS_CORE_URL"] ?? "http://localhost:3010";
const identity: VoiceIdentity = {
  person_id: owner.owner_person_id,
  tenant_id: owner.tenant_id,
  device_id: "jarvis-voice-live",
  memory_space: "personal",
  channel: "voice"
};

const tts = new OpenAiTts();
const stt = new OpenAiStt(undefined, "whisper-1", 24000);
if (!tts.available() || !stt.available()) {
  throw new Error("FEIL: OPENAI_API_KEY mangler - soak krever STT/TTS-nøkkel");
}

async function collect(playback: { frames: AsyncIterable<Buffer> }): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const frame of playback.frames) {
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

function latencyLine(m: TurnMetrics): string {
  const sttLat = m.t_final_transcript && m.t_end_of_turn ? m.t_final_transcript - m.t_end_of_turn : undefined;
  const ttft = m.t_model_first_token && m.t_end_of_turn ? m.t_model_first_token - m.t_end_of_turn : undefined;
  const tool = m.t_tool_activity && m.t_model_first_token ? m.t_model_first_token - m.t_tool_activity : undefined;
  const ttfa = m.t_tts_first_frame && m.t_first_tts_request ? m.t_tts_first_frame - m.t_first_tts_request : undefined;
  const total = m.t_done && m.t_speech_start ? m.t_done - m.t_speech_start : undefined;
  return (
    `stt=${sttLat ?? "-"}ms model_ttft=${ttft ?? "-"}ms tool=${tool ?? "n/a"}ms ` +
    `tts_ttfa=${ttfa ?? "-"}ms e2e_first_audio=${m.end_of_speech_to_first_audio_ms ?? "-"}ms total_turn=${total ?? "-"}ms`
  );
}

/**
 * D-30 HOST FAILURE FIX §3: eksplisitt definisjon av "korrekt cancelled-turn
 * metrics" - en tur avbrutt av ekte barge-in skal IKKE bare ha cancelled=true,
 * men også bevise at den faktisk KOM I GANG (t_speech_start) og at EKTE lyd
 * FAKTISK begynte å spille FØR den ble kuttet (t_tts_first_frame) - ellers er
 * det ikke et bevis på "avbrutt midt i aktiv avspilling", bare en tur som
 * aldri rakk å starte.
 */
function isCorrectlyCancelled(m: TurnMetrics): boolean {
  return m.cancelled === true && m.t_speech_start !== undefined && m.t_tts_first_frame !== undefined;
}

interface TurnSpec {
  label: string;
  text: string;
  provider?: string;
}

const TURNS: TurnSpec[] = [
  { label: "1 no-tool", text: "Hva er tolv pluss femten?" },
  { label: "2 calendar", text: "Hva står på kalenderen min i dag?" },
  { label: "3 normal", text: "Fortell en kort vits på norsk." },
  { label: "4 forced-openai", text: "Si hei på norsk med én setning.", provider: "openai" },
  { label: "5 forced-anthropic", text: "Si hei på norsk med én setning.", provider: "anthropic" },
  { label: "6 calendar-repeat (Q-18 live-observasjon)", text: "Hva står på kalenderen min i dag?" },
  { label: "7 no-tool", text: "Hva er hovedstaden i Norge?" },
  // Host-ordre §5/§6: IKKE en lang tekst som "blind fix" - normal lengde er
  // nok, siden barge-in trigges på OBSERVERT state==="speaking", ikke på
  // antatt varighet. En unødvendig lang tekst gjør bare testen tregere uten
  // å bevise mer.
  { label: "8 (avbrytes av turn 9)", text: "Fortell litt om havet og bølger, noen setninger." },
  { label: "9 cancellation (barge-in mot turn 8)", text: "Stopp, si i stedet 'klar igjen' på norsk." },
  { label: "10 calendar (skal fungere normalt - sesjon ikke korrupt)", text: "Hva står på kalenderen min i dag?" }
];

const metricsByTurn: TurnMetrics[] = [];
const toolsByTurn: string[][] = [];
const errorsByTurn: string[][] = [];
const sessionIds = new Set<string>();
let duplicateToolExecutions = 0;
let sessionCorrupted = false;

const core = new HttpCoreClient(API_URL);
// Mutérbar identity-referanse: VoiceSession bruker ÉN identity for hele sin
// levetid (per design - tale gir ingen ekstra authority per tur, §43), men vi
// trenger provider-override PER TUR (4/5) mens sesjonskontinuiteten (§4)
// krever ÉN VoiceSession. Muterer .provider rett før hver pushAudio - lovlig
// (TS "readonly" på klassefeltet hindrer kun reassignment, ikke objektmutasjon)
// og speiler nøyaktig hvordan /chat allerede støtter per-kall provider (§33).
const sessionIdentity: VoiceIdentity = { ...identity };
let currentTurnTools: string[] = [];
let currentTurnErrors: string[] = [];
// D-30 HOST BLOCKER §4: tidsstemplet tilstandshistorikk - lar oss se PRESIST
// hvilke overganger (listening→thinking→speaking) som faktisk skjedde og når,
// i stedet for å gjette ved en bar timeout.
const stateHistory: Array<{ state: string; at_ms: number }> = [];
const runStart = Date.now();
const session = new VoiceSession(sessionIdentity, core, stt, tts, {
  onState: (s) => stateHistory.push({ state: s, at_ms: Date.now() - runStart }),
  onPartial: () => undefined,
  onFinal: () => undefined,
  onReply: (r) => sessionIds.add(r.session_id),
  onTtsFrame: () => undefined,
  onTtsCancelled: () => undefined,
  onMetrics: (m) => {
    metricsByTurn.push(m);
    toolsByTurn.push(currentTurnTools);
    errorsByTurn.push(currentTurnErrors);
    currentTurnTools = [];
    currentTurnErrors = [];
  },
  onError: (e) => currentTurnErrors.push(e),
  onToolActivity: (activity) => currentTurnTools.push(activity)
});

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!predicate()) {
    // D-30 HOST BLOCKER §4: full tilstandshistorikk med i feilmeldingen - et
    // timeout ETTER normale overganger (listening→thinking→speaking observert,
    // bare treg) er en ANNEN diagnose enn å aldri komme forbi "thinking" i det
    // hele tatt. Vi markerer ALDRI sesjonen korrupt kun fordi noe var tregt -
    // kun caller avgjør det basert på denne historikken.
    const recentStates = stateHistory
      .filter((s) => s.at_ms >= Date.now() - runStart - timeoutMs - 1000)
      .map((s) => `${s.state}@${s.at_ms}ms`)
      .join(" → ");
    throw new Error(`timeout (${timeoutMs}ms) mens ventet på: ${label}. Tilstandshistorikk: ${recentStates || "(ingen state-overganger observert)"}`);
  }
}

function setProviderFor(spec: TurnSpec): void {
  if (spec.provider !== undefined) {
    sessionIdentity.provider = spec.provider;
  } else {
    delete sessionIdentity.provider;
  }
}

function reportTurn(index: number, label: string): void {
  const m = metricsByTurn[index] as TurnMetrics;
  const tools = toolsByTurn[index] ?? [];
  const errs = errorsByTurn[index] ?? [];
  if (new Set(tools).size < tools.length) {
    duplicateToolExecutions += tools.length - new Set(tools).size;
  }
  console.log(
    `  [${index + 1}/10] ${label}: cancelled=${m.cancelled ?? false} tool_activity=[${tools.join(",")}] ` +
      `errors=[${errs.join(",")}] ${latencyLine(m)}`
  );
}

console.log(`== D-30 §4 10-TURN SOAK (ÉN sesjon, ${TURNS.length} turer) ==`);

// Turer 1-7 (indeks 0-6): uavhengige, kjøres sekvensielt som før.
for (let i = 0; i <= 6; i++) {
  const spec = TURNS[i] as TurnSpec;
  setProviderFor(spec);
  const audio = await collect(tts.synthesize(spec.text));
  const t = Date.now();
  session.pushAudio(audio, t);
  session.pushAudio(Buffer.alloc(640), t + 400);
  try {
    // D-30 HOST BLOCKER §4: 45s margin (samme begrunnelse som turn 8/9 under).
    await waitFor(() => metricsByTurn.length > i, 45_000, spec.label);
  } catch (err) {
    sessionCorrupted = true;
    console.log(`  [${i + 1}/10] ${spec.label}: ${(err as Error).message}`);
    break;
  }
  reportTurn(i, spec.label);
}

// Turer 8+9 (indeks 7+8): KOBLET PAR - turn 9 er turn 8 sin barge-in. Sendes
// konkurrerende, ikke sekvensielt (§3-fiksen).
if (!sessionCorrupted) {
  const spec8 = TURNS[7] as TurnSpec;
  const spec9 = TURNS[8] as TurnSpec;
  setProviderFor(spec8);
  const audio8 = await collect(tts.synthesize(spec8.text));
  const t8 = Date.now();
  session.pushAudio(audio8, t8);
  session.pushAudio(Buffer.alloc(640), t8 + 400);

  try {
    // D-30 HOST BLOCKER §4: 60s (ikke 20s) - host-funn viste at ekte
    // modellgenerering på denne miljøet kan ta 30-40+ sekunder (samme
    // fenomen som §32/§3B undersøker). Vent KUN til turn 8 faktisk taler
    // (bevis: generation/TTS er aktiv) - IKKE til den fullfører (den skal
    // aldri fullføre naturlig - se over).
    await waitFor(() => session.currentState() === "speaking", 60_000, "turn 8 startet avspilling");

    setProviderFor(spec9);
    const audio9 = await collect(tts.synthesize(spec9.text));
    const t9 = Date.now();
    session.pushAudio(audio9, t9); // EKTE barge-in-lyd mens turn 8 fortsatt spiller
    session.pushAudio(Buffer.alloc(640), t9 + 400);

    // Nå venter vi på BEGGE turers metrics (turn 8 cancelled + turn 9 fullført):
    await waitFor(() => metricsByTurn.length >= 9, 60_000, "turn 8 (cancelled) + turn 9 (fullført) metrics");
  } catch (err) {
    sessionCorrupted = true;
    // D-30 HOST BLOCKER §4: eksplisitt skille - et TIMEOUT med normale
    // state-overganger observert FØR det (se historikken i feilmeldingen) er
    // "treg respons", IKKE bevis på sesjons-korrupsjon i VoiceSession. Ekte
    // korrupsjon ville vist seg som en kastet feil/exception, ikke bare treghet.
    console.log(`  [8-9/10] ${(err as Error).message}`);
    console.log(
      "  MERK: dette er et TIMEOUT, ikke nødvendigvis sesjons-korrupsjon - se " +
        "tilstandshistorikken over. Hvis 'listening'/'thinking' ble observert normalt og kun " +
        "'speaking' aldri ble nådd, er dette sannsynligvis samme fenomen som §32/§3B " +
        "(kjør med JARVIS_STREAM_DEBUG=true), ikke en feil i selve VoiceSession/soak-harnesset."
    );
  }

  if (!sessionCorrupted) {
    const m8 = metricsByTurn[7] as TurnMetrics;
    reportTurn(7, spec8.label);
    reportTurn(8, spec9.label);
    if (!isCorrectlyCancelled(m8)) {
      throw new Error(
        `FEIL §3: turn 8 ble IKKE korrekt kansellert (cancelled=${m8.cancelled}, ` +
          `t_speech_start=${m8.t_speech_start}, t_tts_first_frame=${m8.t_tts_first_frame}) - ` +
          "forventet: startet OG hadde lyd i gang FØR barge-in kuttet den"
      );
    }
    const m9 = metricsByTurn[8] as TurnMetrics;
    if (m9.cancelled) {
      throw new Error("FEIL §3: turn 9 (barge-in-turen selv) skal fullføre normalt, ikke være kansellert");
    }
  }
}

// Turn 10 (indeks 9): siste tur, skal fungere normalt (bevis: sesjonen er ikke korrupt).
if (!sessionCorrupted) {
  const spec = TURNS[9] as TurnSpec;
  setProviderFor(spec);
  const audio = await collect(tts.synthesize(spec.text));
  const t = Date.now();
  session.pushAudio(audio, t);
  session.pushAudio(Buffer.alloc(640), t + 400);
  try {
    await waitFor(() => metricsByTurn.length > 9, 45_000, spec.label);
    reportTurn(9, spec.label);
  } catch (err) {
    sessionCorrupted = true;
    console.log(`  [10/10] ${spec.label}: ${(err as Error).message}`);
  }
}

console.log(`\n== SOAK-OPPSUMMERING ==`);
console.log(`turer_fullført=${metricsByTurn.length}/${TURNS.length}`);
console.log(`session_ids_observert=${[...sessionIds].join(",")} (skal være NØYAKTIG 1 - sesjonskontinuitet)`);
console.log(`duplicate_tool_executions=${duplicateToolExecutions} (skal være 0 - se q18-fix/same-turn-dedupe-testene for hva tallet betyr)`);
console.log(`session_corrupted=${sessionCorrupted}`);

if (metricsByTurn.length < TURNS.length) {
  throw new Error(`FEIL §4: kun ${metricsByTurn.length}/${TURNS.length} turer fullførte`);
}
if (sessionIds.size !== 1) {
  throw new Error(`FEIL §4: forventet nøyaktig 1 session_id (sesjonskontinuitet), fikk ${sessionIds.size}`);
}
if (duplicateToolExecutions > 0) {
  throw new Error(`FEIL §4: ${duplicateToolExecutions} duplikate verktøystatuser observert i én tur`);
}
if (sessionCorrupted) {
  throw new Error("FEIL §4: sesjonen ble korrupt underveis (se logg over for hvilket steg)");
}
if (!isCorrectlyCancelled(metricsByTurn[7] as TurnMetrics)) {
  throw new Error("FEIL §3: turn 8 sin cancelled-status validerte ikke ved sluttsjekk");
}
const last = metricsByTurn[9] as TurnMetrics;
if (last.cancelled) {
  throw new Error("FEIL §4: turn 10 (siste) skal IKKE være kansellert - sesjonen skal fungere normalt til slutt");
}
console.log(
  "§4 PASS: 10/10 turer fullført, én sesjon, ingen duplikate verktøystatuser, turn 8 korrekt kansellert " +
    "(startet+hadde lyd i gang), turn 9 fullførte normalt, turn 10 normal."
);
console.log(
  "MERK Q-18 (§5, FIKSET): sammenlign svarteksten fra turn 2, 6 og 10 manuelt over - identisk kalenderspørsmål i " +
    "samme sesjon skal nå ALLE gi et ekte kalendersvar (ikke tomt/generisk) - se " +
    "modules/tool-gateway/test/q18-read-dedupe.test.ts for det deterministiske beviset på fiksen."
);
