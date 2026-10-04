import "./normalize-env.ts";
import { envPort } from "@jarvis/contracts";
import { VoiceHealth } from "./health.ts";
import { createVoiceGateway, HttpCoreClient } from "./server.ts";
import { selectSpeechAdapters } from "./adapter-selection.ts";
import { LocalWhisperStt, OpenAiStt } from "./stt.ts";
import { LocalPiperTts, OpenAiTts } from "./tts.ts";
import { EnergyVad } from "./vad.ts";

const port = envPort("JARVIS_VOICE_PORT", 3020);
const coreUrl = process.env["JARVIS_CORE_URL"] ?? "http://127.0.0.1:3010";

/**
 * D-353 (Tobias direkte i chat, live bruk: "den hører meg veldig dårlig
 * ... kan heller ikke bryte han midt i en samtale"). `EnergyVad` sin
 * `threshold`/`hangoverMs` var FØR dette kun tunbare via en kodeendring +
 * redeploy - ingen vei til å kalibrere dem mot Tobias sin FAKTISKE
 * mikrofon/rom uten en hel PR-runde per forsøk. Gjort miljøvariabel-styrt,
 * SAMME default-verdier som før (0.05/700ms, D-275) hvis variablene ikke
 * er satt - ingen atferdsendring uten eksplisitt operatør-handling. Lavere
 * `threshold` fanger svakere/lengre unna tale (inkl. avbrudds-forsøk midt i
 * Jarvis sin egen TTS-avspilling, se `session.ts` sin `bargeIn()` - selve
 * avbruddsmekanismen er BYGGET og testet, D-353 sin undersøkelse fant at
 * det mest sannsynlige hinderet er at VAD-en rett og slett ikke oppdager
 * avbruddsforsøket som tale i utgangspunktet).
 *
 * `numericEnvOrDefault()`: SAMME "tom streng er IKKE usatt"-disiplin som
 * D-236/D-340 allerede etablerte andre steder i kodebasen - `docker compose`
 * sin `${VAR:-}`-interpolasjon setter variabelen til en FAKTISK tom streng
 * når `.env` mangler verdien, og `Number("") ?? default` ville STILLE blitt
 * `0` (tom streng er ikke `null`/`undefined`, så `??` faller ALDRI tilbake) -
 * en reell, ikke-hypotetisk felle her: `threshold=0` ville gjort VAD-en
 * "alt er tale", en FORVERRING, ikke en no-op.
 */
function numericEnvOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const vadThreshold = numericEnvOrDefault("JARVIS_VOICE_VAD_THRESHOLD", 0.05);
const vadHangoverMs = numericEnvOrDefault("JARVIS_VOICE_VAD_HANGOVER_MS", 700);
/**
 * D-390: adaptiv terskel (støygulv) er PÅ som standard (`JARVIS_VOICE_VAD_ADAPTIVE=false` slår av) - D-353 fant at én fast
 * terskel var det mest sannsynlige hinderet for både «hører meg dårlig» og manglende avbrudd. Terskelen starter på
 * `vadThreshold` og flytter seg kun innenfor [0.012, 2x] etter hva rommet faktisk måler. ÉN VAD PER SESJON (fabrikk) - JARVIS-079.
 */
const vadAdaptive = (process.env["JARVIS_VOICE_VAD_ADAPTIVE"] ?? "true") !== "false";
const vad = (): EnergyVad => new EnergyVad(vadThreshold, vadHangoverMs, { adaptive: vadAdaptive });
/**
 * D-390: pre-roll (ordets begynnelse før VAD-en trigget), fyllord når modellen er treg til første token, og talt verktøystatus.
 * Alle styres fra miljøet; 0/false slår av.
 */
const sessionOptions = {
  preRollMs: numericEnvOrDefault("JARVIS_VOICE_PREROLL_MS", 300),
  fillerMs: numericEnvOrDefault("JARVIS_VOICE_FILLER_MS", 1500),
  speakToolActivity: (process.env["JARVIS_VOICE_SPEAK_TOOL_ACTIVITY"] ?? "true") !== "false"
};

// Leverandørvalg skjer i stop/go-porten (D-10/D-29); inntil da brukes første
// tilgjengelige adapter, med deterministisk fallback uten nettverk.
// BO-12 §5-§7: OpenAI STT/TTS er P0-baseline fordi OPENAI_API_KEY allerede er
// live i runtime; andre providere kommer bak samme adapterlag etter benchmark.
// Task #125 (D-217): lokal whisper.cpp/piper er NESTE tilgjengelige tier - kun
// aktiv når Tobias faktisk har satt JARVIS_WHISPER_BIN/_MODEL eller
// JARVIS_PIPER_BIN/_MODEL (Q-32 punkt 3) - `available()` er `false` inntil da,
// og kjeden faller videre til den deterministiske test-adapteren uendret.
const openAiStt = new OpenAiStt();
const openAiTts = new OpenAiTts();
const localWhisperStt = new LocalWhisperStt();
const localPiperTts = new LocalPiperTts();
// REMEDIERING DEL 1 (JARVIS-080): INGEN stille fallback til MarkerStt/FakeTts - oppstarten
// feiler lukket uten en ekte adapter (se `adapter-selection.ts`).
function selectOrExit() {
  try {
    return selectSpeechAdapters({ openAiStt, localWhisperStt, openAiTts, localPiperTts });
  } catch (err) {
    console.error(JSON.stringify({ msg: "jarvis-voice-gateway startup_failed", error: (err as Error).message }));
    process.exit(1);
  }
}
const { stt, tts } = selectOrExit();
const health = new VoiceHealth();

const server = createVoiceGateway({ core: new HttpCoreClient(coreUrl), stt, tts, health, vad, session: sessionOptions });
server.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "jarvis-voice-gateway listening",
      port,
      stt: stt.name,
      tts: tts.name,
      tts_sample_rate: tts.sampleRate ?? 24_000,
      vad_threshold: vadThreshold,
      vad_hangover_ms: vadHangoverMs,
      vad_adaptive: vadAdaptive,
      ...sessionOptions
    })
  );
});
