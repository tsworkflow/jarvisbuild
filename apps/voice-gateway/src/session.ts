import {
  evaluateSpeechRouting,
  type MemorySpaceAuthority,
  type SpeechRoutingDecision,
  type VoiceAuthorizationResult
} from "@jarvis/contracts";
import { PassthroughAec, PassthroughNoiseSuppressor, rmsEnergy, type AudioFilter } from "./audio.ts";
import { EnergyVad, type VadAdapter } from "./vad.ts";
import { SentenceChunker } from "./chunker.ts";
import { sanitizeForSpeech } from "./text-sanitize.ts";
import type { VoiceHealth } from "./health.ts";
import type { SttAdapter, SttStream } from "./stt.ts";
import type { TtsAdapter, TtsPlayback } from "./tts.ts";

/**
 * BO-12 §23: eksplisitt tilstandsmaskin. idle = før klienten har aktivert
 * mikrofon (start-melding = eksplisitt aktivering, aldri skjult opptak);
 * interrupted = barge-in registrert; error via egne error-events.
 */
export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

export interface VoiceIdentity {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: string;
  channel: "voice";
  /** BO-12 §33: valgfri owner-override av LLM-provider - voice-laget er likt uansett. */
  provider?: string;
  /**
   * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): det betrodde
   * BÆRER-BEVISET fra en vellykket `/voice/session/authorize`.
   *
   * D-130-runden la her et `session_id`. Reviewen påviste at en sesjons-ID
   * ikke KAN være et autorisasjonsbevis: den er bevisst delt mellom personens
   * kanaler, og `last_device_id` overskrives ved hvert kanalbytte. Feltet er
   * derfor byttet til `grant_token` - et serverutstedt, avgrenset og
   * revokerbart bevis bundet til NØYAKTIG denne enheten, dette scopet og denne
   * kanalen, med utløp og en fingerprint av enhetsnøkkelen.
   *
   * KUN satt på den BEVISTE stien (`server.ts` sin `grant`-gren) - `undefined`
   * på den ubeviste/`CLIENT_ASSERTED`-stien. Rent additivt felt: alle
   * eksisterende felter over er UENDRET, så D-122 sin rutingslogikk
   * (`identity.memory_space`/`identity.channel`) fortsetter å virke akkurat
   * som før.
   */
  grant_token?: string;
}

export interface CoreReply {
  reply: string;
  routed: string;
  session_id: string;
  task_id?: string;
  cancelled?: boolean;
  interrupted?: boolean;
}

/** Normaliserte streaming-events fra Core (§12): kun brukerrettet innhold + tool-status. */
export type CoreStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool"; tool_name: string };

/** Core-klient: gatewayen snakker KUN med Core - all dialog/policy/minne bor der. */
export interface CoreClient {
  /**
   * D-123 (Q-32 punkt 2): be Core avgjøre om et klientbevis gir en betrodd
   * sesjons-/memory-space-autoritet. Dette er den ENESTE veien til
   * `SERVER_VERIFIED` i voice-transporten.
   *
   * Ligger på `CoreClient` og ikke i gatewayen selv fordi CLAUDE.md regel 5
   * gjør Voice Gateway til en EGEN prosess: identitet, sesjon og policy bor i
   * Core, og gatewayen skal spørre - aldri holde sin egen kopi av
   * enhetsnøkler, sesjonstabell eller space-regler. Valgfri på interfacet slik
   * at eksisterende `CoreClient`-implementasjoner (tester, fakes) forblir
   * gyldige og deterministisk havner i den fail-closed grenen.
   */
  authorizeVoiceSession?(evidence: unknown): Promise<VoiceAuthorizationResult>;
  chat(identity: VoiceIdentity, message: string): Promise<CoreReply>;
  /**
   * BO-12 §12-§13: streaming-variant - tokens driver setningschunking → TTS
   * mens generering pågår. signal aborterer helt inn i provider-upstream
   * (P1A-kjeden). Valgfri: uten denne brukes chat() (fullført svar → TTS).
   */
  chatStream?(
    identity: VoiceIdentity,
    message: string,
    onEvent: (event: CoreStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<CoreReply>;
}

/** Per-tur-tidsstempler for latensanalyse (BO-12 §19; P50/P95 beregnes over turer). */
export interface TurnMetrics {
  utterance_id: string;
  t_speech_start: number;
  t_first_partial?: number;
  t_end_of_turn?: number;
  /** §19: speech_end → endelig transkript. */
  t_final_transcript?: number;
  /** §19: første modell-token mottatt fra Core. */
  t_model_first_token?: number;
  /** §19: første chunk sendt til TTS. */
  t_first_tts_request?: number;
  t_tts_first_frame?: number;
  t_core_reply?: number;
  t_done?: number;
  /** D-30 hardening §6: tidspunkt trusted tool-status ble varslet (tool_call_complete). */
  t_tool_activity?: number;
  barge_in_ms?: number;
  /** §19 hovedmål: end-of-user-speech → første Jarvis-lyd. */
  end_of_speech_to_first_audio_ms?: number;
  /** D-390: et kort fyllord ble talt fordi modellen brukte lenger enn `fillerMs` på første token. */
  filler_spoken?: boolean;
  /** §20: separat usage-grunnlag for STT-/TTS-kost (aldri blandet med LLM-kost). */
  stt_audio_ms?: number;
  tts_chars?: number;
  cancelled?: boolean;
  routed?: string;
}

export interface SessionEvents {
  onState(state: VoiceState): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onReply(reply: CoreReply): void;
  onTtsFrame(frame: Buffer): void;
  onTtsCancelled(afterMs: number): void;
  onMetrics(metrics: TurnMetrics): void;
  onError(message: string): void;
  /** BO-12 §26: kort brukerrettet verktøystatus ("Sjekker kalenderen …") - aldri intern JSON. */
  onToolActivity?(activity: string): void;
}

/**
 * D-390 (Tobias: «raskeste responsen med best svar og tydelig svar som hører meg bra»): valgfrie sesjonsinnstillinger. Alle er AV
 * uten eksplisitt verdi (identisk oppførsel med før) - `main.ts` slår dem på fra miljøet.
 */
export interface VoiceSessionOptions {
  /**
   * Lyd FØR `speech_start` (ms) som holdes i en ringbuffer og sendes til STT når turen starter - energi-VAD-en trigger først
   * MIDT i første stavelse, så uten dette mister whisper ordets begynnelse («hei Charlie» → «ei Charlie»). 0 = av.
   */
  preRollMs?: number;
  /**
   * Går det lenger enn dette (ms) fra turstart til første modell-token/verktøystatus, tales `fillerText` kort - så Tobias hører at
   * Charlie er i gang i stedet for stillhet. Tales kun én gang per tur og aldri etter at svaret har begynt. 0 = av.
   */
  fillerMs?: number;
  fillerText?: string;
  /** Tal verktøystatusen («Sjekker kalenderen …») i tillegg til å sende den som tekst - første verktøy per tur. */
  speakToolActivity?: boolean;
}

const DEFAULT_FILLER_TEXT = "Et øyeblikk.";
/** PCM16 mono 16 kHz = 32 byte per millisekund. */
const PCM16_16K_BYTES_PER_MS = 32;

/** §26: trusted mapping verktøynavn → kort brukerrettet status. Ukjente får generisk tekst. */
const TOOL_ACTIVITY_TEXT: Record<string, string> = {
  read_calendar_today: "Sjekker kalenderen din …",
  read_recent_email: "Ser på e-posten din …",
  read_github_issues: "Sjekker GitHub …"
};
/** D-382: lese-nivået (D-381) gir verktøynavn på formen `tool_id__action` - kort, trusted status per tjeneste (aldri payload). */
const TOOL_ACTIVITY_BY_PREFIX: ReadonlyArray<[RegExp, string]> = [
  [/^calendar/, "Sjekker kalenderen din …"],
  [/^email|^microsoft_outlook/, "Ser på e-posten din …"],
  [/^github/, "Sjekker GitHub …"],
  [/^memory/, "Leter i minnet …"],
  [/^finance/, "Sjekker økonomien …"],
  [/^(brave_search|tavily|exa)/, "Søker på nettet …"],
  [/^(notion|drive|dropbox|onedrive|google_sheets)/, "Ser i dokumentene …"],
  [/^(todoist|trello|jira|linear)/, "Sjekker oppgavene …"],
  [/^(slack|discord|telegram|whatsapp|twilio|telnyx)/, "Sjekker meldingene …"],
  // D-390: resten av tjenestene Charlie faktisk kan nå fra tale (D-389), så statusen aldri blir generisk når det finnes et bedre ord.
  [/^home-assistant/, "Sjekker hjemmet …"],
  [/^(vercel|n8n|make)/, "Sjekker driften …"],
  [/^(sentry|grafana|prometheus)/, "Sjekker systemene …"],
  [/^(business|contract|support|operations|product|conversation_graph)/, "Slår opp i registeret …"],
  [/^(hubspot|pipedrive)/, "Sjekker CRM-et …"],
  [/^(google_maps|google_places|google_routes)/, "Sjekker kartet …"],
  [/^spotify/, "Sjekker musikken …"],
  [/^executive/, "Sjekker statusen min …"]
];
export function toolActivityText(toolName: string): string {
  const exact = TOOL_ACTIVITY_TEXT[toolName];
  if (exact) return exact;
  for (const [re, text] of TOOL_ACTIVITY_BY_PREFIX) if (re.test(toolName)) return text;
  return "Jobber med saken …";
}

/**
 * Utterance-journal: gjør turer idempotente ved failover/gjenopptak.
 * En allerede fullført utterance_id re-sendes ALDRI til Core (ingen doble
 * verktøyhandlinger). In-memory i piloten; persistent lager når gatewayen
 * får delt tilstand (dokumentert avvik).
 */
export class UtteranceJournal {
  private readonly completed = new Set<string>();
  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }
  markCompleted(id: string): void {
    this.completed.add(id);
  }
}

/**
 * Full-duplex talesesjon (VOICE_ARCHITECTURE §3-§5 + BO-12): VAD → streaming
 * STT → Core (AI Mesh, streaming) → setningschunket streaming TTS, med ekte
 * barge-in: tale under avspilling stopper lyd, tømmer TTS-køen, forkaster
 * buffret tekst OG aborterer modellgenereringen upstream (P1A-kjeden, §15).
 * Epoch-vern garanterer at gammel tale aldri spilles etter ny tur (§16).
 * Gatewayen har ingen samtalelogikk; tale gir ingen ekstra authority (§43).
 */
export class VoiceSession {
  private state: VoiceState = "listening";
  private stt: SttStream | null = null;
  private playback: TtsPlayback | null = null;
  private metrics: TurnMetrics | null = null;
  private utteranceCounter = 0;
  private turnChain: Promise<void> = Promise.resolve();
  /** §16: epoch bumpes ved barge-in - alt fra gammel epoch droppes deterministisk. */
  private epoch = 0;
  private ttsQueue: TtsQueueItem[] = [];
  private ttsWorker: Promise<void> = Promise.resolve();
  private activeTurnAbort: AbortController | null = null;
  /** D-390 (JARVIS-079): etter `disconnect()` når ingen tur Core - en STT som fullfører etterpå kjører aldri verktøy for en død socket. */
  private closed = false;
  /** D-390: ringbuffer med lyd fra FØR turen (se `VoiceSessionOptions.preRollMs`). */
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  /**
   * D-122 (UA-7 kriterium 4): rutingsporten avgjøres ÉN gang per sesjon, ved
   * konstruksjon, fra sesjonens memory space, space-verdiens TILLITSNIVÅ og
   * adapterens egen databehandler-erklæring. Deterministisk og uforanderlig
   * gjennom sesjonen - en kaller kan ikke «forhandle» seg til en ekstern
   * behandler midt i en samtale ved å endre noe underveis.
   */
  private readonly sttRouting: SpeechRoutingDecision;
  private readonly ttsRouting: SpeechRoutingDecision;
  /** Avslaget rapporteres ÉN gang per sesjon per retning - aldri per lydramme. */
  private sttDenialReported = false;
  private ttsDenialReported = false;
  /**
   * D-261 (Tobias direkte i chat: en ellers HELT feilfri tilkobling -
   * "started" med SERVER_VERIFIED, ingen krasj, ingen feilmelding noe sted -
   * etterfulgt av total stillhet (INGEN state-endring i det hele tatt) i
   * ~57 sekunder, deretter en ren frakobling. Verken klientens Tekniske logg
   * (kun mottatte meldinger) eller container-loggen (ingen console.error i
   * `pushAudio()` i det hele tatt) kunne skille mellom "lydrammer når aldri
   * serveren" og "lydrammer ankommer, men krysser aldri VAD-terskelen
   * (`EnergyVad` sin `threshold = 0.05`)" - eksplisitt gjentatt tilbakemelding
   * gjennom hele denne økten: "sett opp bedre logging på hele systemet".
   * Disse to feltene + logglinjene under svarer PRESIST på det spørsmålet
   * direkte i `docker compose logs voice-gateway` ved NESTE forsøk, uten at
   * Tobias må navigere en DevTools WS-"Messages"-fane (upraktisk å forklare
   * presist over chat, se forsøket rett før denne fiksen).
   */
  private audioFrameCount = 0;
  private lastAudioHeartbeatAt = 0;
  /**
   * D-262 (Tobias direkte i chat, live NAS-test MED D-261 sin nye logging
   * aktiv): heartbeaten viste ekte tale/stillhet-mønster (RMS 0.17-0.52 under
   * tale, nær 0 i pauser) og INGEN feillogg noe sted (`voice_stt_error`/
   * `voice_core_error`/`voice_message_error` alle fraværende) - likevel
   * svarte Jarvis fortsatt ikke ("ingen svar"). D-261 sin sampling (kun
   * ~1-av-24 rammer, hvert 2. sekund) kan strukturelt ALDRI bekrefte om
   * `end_of_turn` faktisk noen gang fyrte mellom to målinger, og
   * `finishTurn()` sin `if (!text) return`-gren (linje ~352, FØR denne
   * fiksen) var - og er, for tomt transkript - fullstendig stille: intet
   * logglinje, ingen event, ingenting. Whisper.cpp er DOKUMENTERT kjent for
   * å returnere tom/whitespace-transkripsjon for reell, men for kort/svak
   * tale - som ville reprodusere PRESIST det observerte bildet (sunn
   * VAD-aktivitet, null feil, null svar). De tre nye, upåkrevde
   * (ikke-throttlede) logglinjene under gjør de to strukturelt umulig-å-
   * skille-fra-hverandre spørsmålene direkte observerbare ved NESTE forsøk:
   * (1) fyrte `end_of_turn` i det hele tatt, (2) hva fikk STT-en tilbake
   * (KUN lengde - aldri selve teksten, samme personvern-disiplin som §22),
   * (3) leverte Core faktisk et svar som ble sendt videre til klienten.
   */

  constructor(
    private readonly identity: VoiceIdentity,
    private readonly core: CoreClient,
    private readonly sttAdapter: SttAdapter,
    private readonly ttsAdapter: TtsAdapter,
    private readonly events: SessionEvents,
    private readonly journal: UtteranceJournal = new UtteranceJournal(),
    private readonly vad: VadAdapter = new EnergyVad(),
    private readonly aec: AudioFilter = new PassthroughAec(),
    private readonly noise: AudioFilter = new PassthroughNoiseSuppressor(),
    /** Failover-tilfelle: gjenoppta med kjente utterance-IDer. */
    private readonly utteranceIdPrefix = `utt-${Date.now().toString(36)}`,
    private readonly health?: VoiceHealth,
    /**
     * D-122 (rettelse etter arkitekt-review av PR #71): HVOR
     * `identity.memory_space` kom fra. Bevisst et EGET konstruktørargument og
     * IKKE et felt på `VoiceIdentity`: `VoiceIdentity` er nøyaktig den
     * strukturen klienten sender i `start`-meldingen, så et tillitsnivå der
     * ville vært selv-erklært av den parten vi ikke stoler på.
     *
     * Default er `CLIENT_ASSERTED` = fail-closed. En kaller som IKKE tar
     * stilling får det svakeste nivået, aldri det sterkeste. Voice-transporten
     * har ingen betrodd server-side space-autoritet i dag (Q-32), så
     * `server.ts` setter denne eksplisitt til `CLIENT_ASSERTED`.
     */
    private readonly memorySpaceAuthority: MemorySpaceAuthority = "CLIENT_ASSERTED",
    /** D-390: pre-roll, fyllord, talt verktøystatus - alle av uten eksplisitt verdi. */
    private readonly options: VoiceSessionOptions = {}
  ) {
    // Bruker parameterne direkte (ikke `this.*`): parameter-properties og
    // felt-initialisering har subtil rekkefølge, og denne porten skal aldri
    // avhenge av den.
    this.sttRouting = evaluateSpeechRouting(sttAdapter.processor, identity.memory_space, memorySpaceAuthority);
    this.ttsRouting = evaluateSpeechRouting(ttsAdapter.processor, identity.memory_space, memorySpaceAuthority);
  }

  currentState(): VoiceState {
    return this.state;
  }

  /** D-122: observerbar for `/status`, tester og revisjon - aldri en skjult beslutning. */
  speechRouting(): { stt: SpeechRoutingDecision; tts: SpeechRoutingDecision } {
    return { stt: this.sttRouting, tts: this.ttsRouting };
  }

  /** Mater én lydramme inn i kjeden. Full duplex: mottas også mens Jarvis snakker. */
  pushAudio(rawFrame: Buffer, atMs: number = Date.now()): void {
    // D-122: FØR filtre, VAD og adapter. Er STT-behandleren ikke kvalifisert
    // for denne sesjonens memory space, skal IKKE ÉN lydramme nå adapteren.
    // Ingen stille fallback til en annen behandler: sesjonen feiler synlig, og
    // det er hele poenget (et fallback ville skjult at porten slo inn).
    if (!this.sttRouting.allowed) {
      if (!this.sttDenialReported) {
        this.sttDenialReported = true;
        this.events.onError(`speech_routing_denied_stt:${this.sttRouting.outcome}`);
      }
      return;
    }
    const frame = this.noise.process(this.aec.process(rawFrame));
    const vadEvent = this.vad.push(frame, atMs);

    // D-261: se feltkommentaren over - bekrefter BÅDE at rammer faktisk
    // ankommer (første ramme, logges ÉN gang) OG hvilken energi/VAD-hendelse
    // hver ramme faktisk gir (et 2-sekunders "hjertesignal", aldri per
    // ramme - dette kalles opptil 50x/sekund og ville oversvømmet loggen).
    this.audioFrameCount += 1;
    if (this.audioFrameCount === 1) {
      console.error(JSON.stringify({ msg: "voice_audio_first_frame", bytes: rawFrame.length }));
    }
    if (atMs - this.lastAudioHeartbeatAt >= 2000) {
      this.lastAudioHeartbeatAt = atMs;
      console.error(
        JSON.stringify({
          msg: "voice_audio_heartbeat",
          frame_count: this.audioFrameCount,
          rms_energy: Number(rmsEnergy(frame).toFixed(4)),
          vad_event: vadEvent
        })
      );
    }

    // D-262: ALDRI throttlet, i motsetning til heartbeaten over - dette er
    // sjeldne tilstandsoverganger (typisk noen få per ytring), ikke en
    // per-ramme-hendelse, så det finnes ingen fare for logg-oversvømmelse.
    // Beviser DEFINITIVT om `end_of_turn` faktisk fyrer, noe 2-sekunders
    // sampling strukturelt aldri kan bekrefte mellom to målinger.
    if (vadEvent === "speech_start" || vadEvent === "end_of_turn") {
      console.error(JSON.stringify({ msg: "voice_vad_transition", vad_event: vadEvent }));
    }

    // D-390: utenfor en tur holdes de siste `preRollMs` ms i en ringbuffer (aldri sendt noe sted før en tur faktisk starter -
    // ingen skjult, kontinuerlig lagring; bufferen overskrives løpende og tømmes når den er brukt).
    const preRollMs = this.options.preRollMs ?? 0;
    if (preRollMs > 0 && !this.stt && vadEvent !== "speech_start") {
      this.preRoll.push(frame);
      this.preRollBytes += frame.length;
      const maxBytes = preRollMs * PCM16_16K_BYTES_PER_MS;
      while (this.preRollBytes > maxBytes && this.preRoll.length > 1) {
        const dropped = this.preRoll.shift() as Buffer;
        this.preRollBytes -= dropped.length;
      }
    }

    if (vadEvent === "speech_start") {
      if (this.state === "speaking" || this.state === "thinking") {
        this.bargeIn(atMs);
      }
      if (!this.stt) {
        this.beginTurn(atMs);
      }
    }
    // D-268 (live NAS-funn, SAMME test-runde som D-267 sin -nth 1.01-fiks):
    // D-267 beviste at whisper.cpp sin egen no-speech-vakt IKKE lenger var
    // problemet (ekte, ikke-null decode-tid observert), men transkripsjonen
    // var FORTSATT `text_length: 0` - med en whisper-rapportert varighet på
    // kun 0,6-0,7 sek for en hel ytring. Årsaken: denne grenen filtrerte KUN
    // på "speech"/"speech_start" - EnergyVad returnerer "silence" for ENHVER
    // ramme under terskelen, også midt i en aktiv tur (et kort opphold
    // mellom ord, en stemmeløs konsonant) FØR `hangoverMs` faktisk er
    // oppnådd og `end_of_turn` fyrer. Slike rammer ble ALDRI sendt til STT-
    // adapteren - de ble ikke bare trimmet i endene, de ble SPLEISET UT AV
    // MIDTEN av WAV-en, som produserer diskontinuerlig/knepen lyd whisper.cpp
    // ikke kan gjenkjenne som sammenhengende tale. Fikset ved å sende ALLE
    // rammer så lenge en tur faktisk er aktiv (`this.stt` satt) og rammen
    // ikke er selve `end_of_turn`-avslutningsrammen - `vad.ts` sin egen
    // `hangoverMs`-logikk avgjør fortsatt PRESIST når turen faktisk slutter;
    // denne grenen bestemmer kun hvilke rammer som når adapteren mens den
    // pågår.
    if (this.stt && vadEvent !== "end_of_turn") {
      this.stt.pushAudio(frame);
    }
    if (vadEvent === "end_of_turn" && this.stt) {
      this.finishTurn(atMs);
    }
  }

  /** Eksplisitt gjenopptak etter failover: samme utterance-id gir NOOP. */
  replayFinal(utteranceId: string, text: string): void {
    if (this.journal.isCompleted(utteranceId)) {
      this.events.onError(`utterance_already_completed:${utteranceId}`);
      return;
    }
    this.turnChain = this.turnChain.then(() => this.runTurn(utteranceId, text, Date.now()));
  }

  private beginTurn(atMs: number): void {
    this.utteranceCounter += 1;
    this.metrics = {
      utterance_id: `${this.utteranceIdPrefix}-${this.utteranceCounter}`,
      t_speech_start: atMs
    };
    this.stt = this.sttAdapter.startStream();
    // D-390: lyden rett FØR speech_start (ordets begynnelse) går først inn i turen.
    if (this.preRoll.length > 0) {
      for (const f of this.preRoll) this.stt.pushAudio(f);
      this.preRoll = [];
      this.preRollBytes = 0;
    }
    this.stt.onPartial((text) => {
      if (this.metrics && this.metrics.t_first_partial === undefined) {
        this.metrics.t_first_partial = Date.now();
      }
      this.events.onPartial(text);
    });
  }

  private finishTurn(atMs: number): void {
    const stt = this.stt;
    const metrics = this.metrics;
    this.stt = null;
    if (!stt || !metrics) {
      return;
    }
    metrics.t_end_of_turn = atMs;
    metrics.stt_audio_ms = atMs - metrics.t_speech_start;
    this.turnChain = this.turnChain.then(async () => {
      let text: string;
      try {
        text = await stt.end();
      } catch (err) {
        // §35: STT-feil → normalisert feil til klienten, ALDRI modellkjøring på
        // manglende transkript. D-254: den tekniske detaljen (whisper.cpp
        // exit code/stderr, OpenAI-status osv.) ble tidligere KUN lagret i
        // in-memory health-state, aldri logget eller eksponert noe sted - en
        // reell feil var derfor praktisk udiagnostiserbar uten kildekode-
        // endring + redeploy hver gang. Logg den nå server-side, samme
        // mønster som voice_core_error/voice_message_error under.
        console.error(JSON.stringify({ msg: "voice_stt_error", error: (err as Error).message.slice(0, 200) }));
        this.health?.recordFailure("stt", (err as Error).message);
        this.events.onError("stt_error");
        this.setState("listening");
        return;
      }
      metrics.t_final_transcript = Date.now();
      // D-262: KUN lengde, ALDRI selve transkriptet (§22-personvernsdisiplinen
      // gjelder også diagnostikk) - avslører presist om STT-en returnerte tomt
      // (whisper.cpp-mønster for svak/kort tale) FØR den stille `return`
      // under, som tidligere ga NULL signal om at dette i det hele tatt skjedde.
      console.error(JSON.stringify({ msg: "voice_stt_result", text_length: text.length }));
      if (!text) {
        // §35: tom/ugyldig transkript (støy, ingen tale) → ingen modellkjøring.
        return;
      }
      this.health?.recordSuccess("stt");
      this.events.onFinal(text);
      await this.runTurn(metrics.utterance_id, text, atMs, metrics);
    });
  }

  private async runTurn(utteranceId: string, text: string, _atMs: number, metrics?: TurnMetrics): Promise<void> {
    if (this.journal.isCompleted(utteranceId)) {
      this.events.onError(`utterance_already_completed:${utteranceId}`);
      return;
    }
    // D-390 (JARVIS-079 «zombie turn executes after disconnect»): klienten er borte - turen når aldri Core, ingen verktøy kjøres
    // for en socket som ikke lenger lytter. Logges (aldri selve teksten).
    if (this.closed) {
      console.error(JSON.stringify({ msg: "voice_turn_dropped_after_disconnect", utterance_id: utteranceId }));
      return;
    }
    const turnMetrics = metrics ?? { utterance_id: utteranceId, t_speech_start: Date.now() };
    const turnEpoch = this.epoch;
    this.setState("thinking");
    const abort = new AbortController();
    this.activeTurnAbort = abort;
    // D-390: fyllord når modellen er treg til første token - kun før svaret har begynt, kun én gang, kun i samme epoch.
    const fillerMs = this.options.fillerMs ?? 0;
    let fillerTimer: ReturnType<typeof setTimeout> | undefined;
    let progressed = false;
    const onProgress = (): void => {
      progressed = true;
      if (fillerTimer !== undefined) {
        clearTimeout(fillerTimer);
        fillerTimer = undefined;
      }
    };
    if (fillerMs > 0 && this.core.chatStream) {
      fillerTimer = setTimeout(() => {
        fillerTimer = undefined;
        if (progressed || this.epoch !== turnEpoch || this.closed) return;
        turnMetrics.filler_spoken = true;
        this.enqueueTts(this.options.fillerText ?? DEFAULT_FILLER_TEXT, turnEpoch, turnMetrics);
      }, fillerMs);
    }
    try {
      const reply = this.core.chatStream
        ? await this.streamTurn(text, turnMetrics, turnEpoch, abort.signal, onProgress)
        : await this.core.chat(this.identity, text);
      turnMetrics.t_core_reply = Date.now();
      turnMetrics.routed = reply.routed;
      // Turen regnes fullført NÅR Core har utført den - replay etter dette er
      // idempotent-nekt. Gjelder også avbrutte turer: voice-avbrudd ruller
      // ALDRI tilbake/re-utfører allerede utførte verktøy (§17).
      this.journal.markCompleted(utteranceId);
      this.events.onReply(reply);
      // D-262: bekrefter at Core faktisk produserte et svar OG at det ble
      // videresendt til transportlaget (`server.ts` sin `onReply` -> `ws.send`)
      // - uten dette kan et "ingen svar"-symptom ALDRI skilles mellom "turen
      // kjørte aldri" og "turen kjørte, svaret nådde bare ikke klienten".
      console.error(
        JSON.stringify({
          msg: "voice_core_reply_sent",
          reply_chars: reply.reply.length,
          routed: reply.routed,
          cancelled: Boolean(reply.cancelled)
        })
      );
      if (this.epoch === turnEpoch && !reply.cancelled) {
        if (!this.core.chatStream) {
          // Ikke-streaming Core: hele svaret tales som ett stykke via køen.
          this.enqueueTts(reply.reply, turnEpoch, turnMetrics);
        }
        await this.drainTts(turnEpoch);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || this.epoch !== turnEpoch) {
        // Barge-in avbrøt turen - rent avbrudd, ingen feil (§15).
        turnMetrics.cancelled = true;
        this.journal.markCompleted(utteranceId);
      } else {
        // §27: normalisert brukerrettet feil - tekniske detaljer kun i logg/audit.
        console.error(JSON.stringify({ msg: "voice_core_error", error: (err as Error).message.slice(0, 200) }));
        this.events.onError("core_error");
      }
    } finally {
      onProgress();
      if (this.activeTurnAbort === abort) {
        this.activeTurnAbort = null;
      }
      turnMetrics.t_done = Date.now();
      if (turnMetrics.t_tts_first_frame !== undefined && turnMetrics.t_end_of_turn !== undefined) {
        turnMetrics.end_of_speech_to_first_audio_ms = turnMetrics.t_tts_first_frame - turnMetrics.t_end_of_turn;
      }
      this.events.onMetrics(turnMetrics);
      if (this.epoch === turnEpoch) {
        this.setState("listening");
      }
    }
  }

  /** §13: streamet svar → setningschunker → TTS-kø mens genereringen pågår. */
  private async streamTurn(
    text: string,
    metrics: TurnMetrics,
    turnEpoch: number,
    signal: AbortSignal,
    onProgress: () => void = () => undefined
  ): Promise<CoreReply> {
    const chunker = new SentenceChunker((chunk) => this.enqueueTts(chunk, turnEpoch, metrics));
    let activitySpoken = false;
    const reply = await (this.core.chatStream as NonNullable<CoreClient["chatStream"]>)(
      this.identity,
      text,
      (event) => {
        if (this.epoch !== turnEpoch) {
          return; // barge-in har skjedd - gamle events forkastes (§16)
        }
        if (event.type === "token") {
          if (metrics.t_model_first_token === undefined) {
            metrics.t_model_first_token = Date.now();
          }
          onProgress();
          chunker.push(event.text);
        } else if (event.type === "tool") {
          // §26: kun kort trusted status - aldri tool-payload/intern JSON i tale.
          if (metrics.t_tool_activity === undefined) {
            metrics.t_tool_activity = Date.now();
          }
          onProgress();
          const activity = toolActivityText(event.tool_name);
          this.events.onToolActivity?.(activity);
          // D-390: tal statusen (første verktøy per tur) - Tobias hører at noe skjer i stedet for stillhet mens verktøyet kjører.
          if (this.options.speakToolActivity === true && !activitySpoken) {
            activitySpoken = true;
            this.enqueueTts(activity, turnEpoch, metrics);
          }
        }
      },
      signal
    );
    if (this.epoch === turnEpoch && !reply.cancelled) {
      chunker.flush();
    } else {
      chunker.discard();
    }
    return reply;
  }

  /**
   * D-122: ett avslag, rapportert ÉN gang per sesjon. `health.recordFailure`
   * kalles bevisst IKKE - se begrunnelsen i `speakNext()`.
   */
  private reportTtsDenial(): void {
    this.clearTtsQueue();
    if (!this.ttsDenialReported) {
      this.ttsDenialReported = true;
      this.events.onError(`speech_routing_denied_tts:${this.ttsRouting.outcome}`);
    }
  }

  /** Sekvensiell TTS-kø med epoch-vern: chunk fra gammel epoch tales aldri (§16). */
  private enqueueTts(chunk: string, turnEpoch: number, metrics?: TurnMetrics): void {
    if (this.epoch !== turnEpoch || chunk.trim().length === 0) {
      return;
    }
    // D-353: ETT sentralt sanerings-punkt, FØR chunken noen gang når en
    // TTS-adapter - beskytter samtlige (OpenAI/ElevenLabs/lokal Piper) mot å
    // uttale rå Markdown-syntaks (**fet**, lister, kodeblokker, lenker) som
    // modellen skriver uvitende om at denne mottakeren HØRER teksten.
    const sanitized = sanitizeForSpeech(chunk);
    if (sanitized.length === 0) {
      return;
    }
    // D-122: køes ikke i det hele tatt når behandleren er avvist - da forblir
    // `tts_chars` ÆRLIG null i stedet for å telle tegn som aldri ble behandlet.
    if (!this.ttsRouting.allowed) {
      this.reportTtsDenial();
      return;
    }
    if (metrics) {
      metrics.tts_chars = (metrics.tts_chars ?? 0) + sanitized.length;
      if (metrics.t_first_tts_request === undefined) {
        metrics.t_first_tts_request = Date.now();
      }
    }
    this.ttsQueue.push({ text: sanitized });
    this.ttsWorker = this.ttsWorker.then(() => this.speakNext(turnEpoch, metrics));
  }

  /** D-390: tømmer køen OG kansellerer chunker som allerede er forhåndssyntetisert (aldri en hengende leverandørstrøm/prosess). */
  private clearTtsQueue(): void {
    for (const item of this.ttsQueue) item.primed?.playback.cancel();
    this.ttsQueue = [];
  }

  private async speakNext(turnEpoch: number, metrics?: TurnMetrics): Promise<void> {
    if (this.epoch !== turnEpoch) {
      this.clearTtsQueue();
      return;
    }
    const item = this.ttsQueue.shift();
    if (item === undefined) {
      return;
    }
    // D-122: svarteksten fra en sensitiv samtale er like avslørende som
    // spørsmålet. Er TTS-behandleren ikke kvalifisert, syntetiseres INGENTING.
    // `health.recordFailure` kalles bevisst IKKE: dette er et policy-avslag,
    // ikke en leverandørfeil - å merke leverandøren «unhealthy» ville vært
    // direkte usant og kunne utløst feilaktig failover.
    if (!this.ttsRouting.allowed) {
      this.clearTtsQueue();
      this.reportTtsDenial();
      return;
    }
    this.setState("speaking");
    let primed: PrimedPlayback;
    try {
      primed = item.primed ?? primePlayback(this.ttsAdapter, item.text);
    } catch (err) {
      // §36: TTS-feil forkaster ALDRI Jarvis-svaret (teksten er alt levert via onReply).
      this.health?.recordFailure("tts", (err as Error).message);
      this.events.onError("tts_error");
      return;
    }
    // D-390: NESTE chunk syntetiseres MENS denne spilles (én foran) - nettverks-TTS (OpenAI/ElevenLabs) og piper sin
    // prosess-/modellstart per chunk overlapper da med avspillingen i stedet for å gi en pause mellom hver setning.
    // Kun én foran: bundet ressursbruk, og barge-in har maks én ekstra strøm å kansellere.
    const next = this.ttsQueue[0];
    if (next !== undefined && next.primed === undefined) {
      try {
        next.primed = primePlayback(this.ttsAdapter, next.text);
      } catch {
        // Rapporteres når chunken selv skal tales (samme feilvei som over).
      }
    }
    const playback = primed.playback;
    this.playback = playback;
    let first = true;
    try {
      for await (const frame of alignPcm16Frames(primedFrames(primed))) {
        if (this.epoch !== turnEpoch) {
          playback.cancel();
          return; // gammel lyd slippes aldri gjennom etter barge-in (§16)
        }
        if (first) {
          if (metrics && metrics.t_tts_first_frame === undefined) {
            metrics.t_tts_first_frame = Date.now();
          }
          first = false;
        }
        this.events.onTtsFrame(frame);
      }
      this.health?.recordSuccess("tts");
    } catch (err) {
      this.health?.recordFailure("tts", (err as Error).message);
      this.events.onError("tts_error");
    } finally {
      if (this.playback === playback) {
        this.playback = null;
      }
    }
  }

  /** Venter til køen for gjeldende epoch er ferdigspilt (eller barge-in tømmer den). */
  private async drainTts(turnEpoch: number): Promise<void> {
    for (;;) {
      await this.ttsWorker;
      if (this.epoch !== turnEpoch || (this.ttsQueue.length === 0 && this.playback === null)) {
        return;
      }
    }
  }

  /**
   * §15: barge-in - (1) stopp avspilling, (2) tøm TTS-kø, (3) abort aktiv
   * modellgenerering upstream, (4) marker interrupted, (5) klar for ny tur.
   */
  private bargeIn(atMs: number): void {
    this.epoch += 1;
    if (this.health) {
      this.health.bargeInSeen = true;
    }
    this.clearTtsQueue();
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
      const afterMs = Date.now() - atMs;
      if (this.metrics) {
        this.metrics.barge_in_ms = afterMs;
        this.metrics.cancelled = true;
      }
      this.events.onTtsCancelled(afterMs);
    }
    // Modellgenerering som ikke lenger trengs aborteres helt til provider (P1A).
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = null;
    this.setState("interrupted");
    this.setState("listening");
  }

  /**
   * D-30 hardening §3D: klienten (WebSocket) koblet fra. Uten dette fortsetter
   * en aktiv tur å generere/tale for en tilkobling som ikke lenger lytter -
   * zombie-generering og bortkastet modell-/TTS-kost. Bumper epoch (all
   * gjenværende lyd/eventer fra denne turen forkastes deterministisk, samme
   * vern som barge-in) og aborterer modellgenereringen helt til provider-
   * upstream (P1A-kjeden) - symmetrisk med bargeIn(), men uten ny tur/state.
   */
  disconnect(): void {
    this.closed = true;
    this.epoch += 1;
    this.clearTtsQueue();
    this.preRoll = [];
    this.preRollBytes = 0;
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
    }
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = null;
  }

  private setState(state: VoiceState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onState(state);
    }
  }
}

/**
 * D-258 (Tobias direkte i chat, live NAS-test etter D-257: talegjenkjenning/
 * -svar fungerte ("Hallo?" -> ekte modellsvar), men klienten logget
 * "ugyldig melding fra server" gjentatte ganger per tur og lyden var brutt/
 * uteble - opplevd av Tobias som "ingen respons").
 *
 * Root cause: `apps/web/voice.html` sin `playTtsFrame()` bygger
 * `new Int16Array(bytes.buffer)` fra HVER `tts_frame`-melding for seg
 * (PCM16 mono) - `Int16Array` KREVER at buffer-lengden er et partall
 * (et helt antall 2-byte samples), ellers kaster konstruktøren en
 * `RangeError`, fanget av `voice.html`s generiske
 * `catch { techLog("ugyldig melding fra server") }` (linje ~484) - hele
 * rammen forkastes stille.
 *
 * `speakNext()` under (linje ~481, FØR denne fiksen) videresendte HVER
 * rå chunk fra `playback.frames` direkte som én `tts_frame`-melding
 * (`server.ts` sin `onTtsFrame`). For `LocalPiperTts` (D-253) kommer disse
 * chunkene rett fra `for await (const chunk of proc.stdout)` i tts.ts -
 * Node sin Readable-strøm grupperer bytes etter hva OS-pipen leverer i hvert
 * øyeblikk, UTEN å respektere PCM-sample-grenser. Enhver chunk med et
 * oddetall antall bytes (statistisk ca. halvparten, konsistent med det
 * observerte mønsteret av annenhver `tts_frame` som feilet) produserte denne
 * krasjen på klienten. Samme strukturelle sårbarhet fantes allerede i
 * `OpenAiTts` (fetch-body-chunks er heller ikke sample-justerte), men er
 * ALDRI blitt utøvd i praksis før D-253 - `MarkerStt`/`FakeTts` var eneste
 * reelt kjørte adapter helt til nå (se D-253-kommentaren i
 * d253-voice-gateway-local-stt-tts.test.ts).
 *
 * Fiksen legges HER (session.ts, sentralt FØR `onTtsFrame` kalles), ikke i
 * hver enkelt adapter - session.ts er allerede stedet som eier hele
 * TTS-avspillingsløkken (`speakNext()`), og enhver FREMTIDIG TTS-adapter
 * arver beskyttelsen automatisk uten å måtte huske på den selv.
 *
 * Bufrer en eventuell overskytende siste byte fra én chunk og limer den inn
 * FØRST i neste chunk, slik at HVER `yield`-ede buffer alltid har et partall
 * lengde (et helt antall samples) - ingen lyddata går tapt, kun en evt.
 * midlertidig 1-bytes forsinkelse på selve sample-grensen. En eventuell
 * ufullstendig siste byte ved STRØMMENS slutt (ingen mer data kommer) kan
 * strukturelt aldri bli en hel sample og forkastes bevisst der.
 */
/** D-390: én TTS-chunk i køen - eventuelt allerede forhåndssyntetisert (`primed`). */
interface TtsQueueItem {
  text: string;
  primed?: PrimedPlayback;
}

/**
 * D-390: en TTS-avspilling der syntesen FAKTISK er startet. Adapterenes `frames` er late async-generatorer (kroppen - fetch/
 * spawn - kjører først ved første `next()`), så «å ha kalt synthesize()» starter ingenting; første `next()` må trekkes nå.
 */
interface PrimedPlayback {
  playback: TtsPlayback;
  iterator: AsyncIterator<Buffer>;
  first: Promise<IteratorResult<Buffer>>;
}

function primePlayback(adapter: TtsAdapter, text: string): PrimedPlayback {
  const playback = adapter.synthesize(text);
  const iterator = playback.frames[Symbol.asyncIterator]();
  const first = iterator.next();
  // Avvisningen håndteres når chunken spilles (`primedFrames` kaster den videre) - aldri en «unhandled rejection» i mellomtiden.
  first.catch(() => undefined);
  return { playback, iterator, first };
}

async function* primedFrames(primed: PrimedPlayback): AsyncIterable<Buffer> {
  let result = await primed.first;
  while (!result.done) {
    yield result.value;
    result = await primed.iterator.next();
  }
}

export async function* alignPcm16Frames(frames: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  let carry: Buffer | null = null;
  for await (const chunk of frames) {
    const combined: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const evenLength: number = combined.length - (combined.length % 2);
    if (evenLength > 0) {
      yield combined.subarray(0, evenLength);
    }
    carry = evenLength < combined.length ? combined.subarray(evenLength) : null;
  }
}
