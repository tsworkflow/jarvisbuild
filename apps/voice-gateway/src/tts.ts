import { spawn } from "node:child_process";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";

/**
 * SpeechAdapter (TTS): streaming-kontrakt med kansellering (barge-in-krav).
 * cancel() SKAL stoppe produksjonen umiddelbart - avbrutt tale logges som
 * ikke levert av sesjonsmotoren.
 */
export interface TtsPlayback {
  /** Async-strøm av lydrammer; avsluttes ved ferdig eller kansellering. */
  frames: AsyncIterable<Buffer>;
  cancel(): void;
}

export interface TtsAdapter {
  readonly name: string;
  /**
   * D-122: samme erklæring som `SttAdapter.processor`. TTS er tatt med fordi
   * SVAR-teksten fra en `health`-samtale er like avslørende som spørsmålet -
   * å beskytte kun STT ville lekket halve samtalen.
   */
  readonly processor: SpeechProcessorDeclaration;
  /**
   * D-390: samplerate (Hz) på PCM16-rammene adapteren leverer. Sendes til klienten i `started`-meldingen så avspillingen bruker
   * RIKTIG rate - før dette antok `voice.html` alltid 24 kHz (OpenAI), som spilte piper (22 050 Hz) ~9 % for fort/lyst og
   * ElevenLabs (16 kHz) 50 % for fort. Udefinert = 24 000 (bakoverkompatibelt med testadaptere uten feltet).
   */
  readonly sampleRate?: number;
  available(): boolean;
  synthesize(text: string): TtsPlayback;
}

export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

/**
 * Deterministisk testadapter: produserer 20 ms-rammer i sanntidstakt slik at
 * barge-in kan MÅLES reelt (kanselleringstidspunkt mot rammestrøm).
 */
export class FakeTts implements TtsAdapter {
  readonly name = "fake-tts";
  /** Ren testadapter i prosessen - ingen tekst/lyd forlater maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "fake-tts",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  /** Rammene under er 20 ms @ 16 kHz. */
  readonly sampleRate = 16_000;
  constructor(private readonly msPerChar = 40) {}

  available(): boolean {
    return true;
  }

  synthesize(text: string): TtsPlayback {
    const totalMs = Math.max(200, text.length * this.msPerChar);
    const frameCount = Math.ceil(totalMs / 20);
    let cancelled = false;
    async function* generate(): AsyncIterable<Buffer> {
      for (let i = 0; i < frameCount; i++) {
        if (cancelled) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancelled) {
          return;
        }
        const frame = Buffer.alloc(640); // 20ms @16kHz PCM16
        frame.fill(i % 120);
        yield frame;
      }
    }
    return {
      frames: generate(),
      cancel(): void {
        cancelled = true;
      }
    };
  }
}

/** OpenAI TTS (batch; streaming-kandidater vurderes i benchmark). UVERIFISERT uten nøkkel. */
export class OpenAiTts implements TtsAdapter {
  readonly name = "openai-tts";
  /**
   * EKSTERN databehandler: svartekst sendes til OpenAI. Navngitt rad, regel
   * 3-feltene nå BEKREFTET (D-226, 2026-09-22) - se `OpenAiStt.processor` for
   * full detalj (samme org-konto/vilkår gjelder begge tjenestene).
   */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "openai-audio-speech",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "VERIFIED"
  };
  /** `response_format: "pcm"` er PCM16 mono 24 kHz. */
  readonly sampleRate = 24_000;
  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = "gpt-4o-mini-tts",
    private readonly voice: string = "alloy"
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.apiKey) {
      throw new Error("openai_tts_not_configured");
    }
    const { apiKey, model, voice } = this;
    let cancelled = false;
    async function* generate(): AsyncIterable<Buffer> {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, voice, input: text, response_format: "pcm" })
      });
      if (!response.ok || !response.body) {
        throw new Error(`openai_tts_error_${response.status}`);
      }
      const reader = response.body.getReader();
      for (;;) {
        if (cancelled) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield Buffer.from(value);
      }
    }
    return { frames: generate(), cancel: () => (cancelled = true) };
  }
}

/**
 * D-319 (harder-tier tale-backlog, Tobias direkte i chat: "Bygg videre" - D-64-
 * stil sjekk mot `SpeechAdapter`-arkitekturen gjort FØR bygging, som lovet i
 * PROJECT_STATUS.md): FØRSTE tale-backlog-punkt (`elevenlabs`) løftet ut av
 * `connector-registry.ts` sin backlog og bygget som en NY `TtsAdapter`-
 * implementasjon her - IKKE en `ToolGateway`-connector. `elevenlabs` sto
 * opprinnelig i `connector-registry.ts` under §4.7 "Tale/video/media-AI"
 * sammen med de andre backlog-punktene, men CLAUDE.md regel 3 (alle
 * leverandører bak adaptere, `SpeechAdapter` eksplisitt navngitt) og D-122
 * sin `PROCESSOR_REGION_MATRIX.md`-port gjelder ALLE STT/TTS-leverandører,
 * uansett hvor de opprinnelig ble listet - en `ElevenLabsTransport` i
 * `live-transports.ts` ville vært STRUKTURELT FEIL (samme domenegrense-feil
 * D-64 finnes for å forhindre, bare på tale-siden i stedet for CRM/tickets).
 *
 * `processor.processor_terms_status` er BEVISST `"NOT_VERIFIED"`
 * (fail-closed default, ALDRI utledet av Jarvis selv - se `speech.ts` sin
 * egen doc-kommentar) - IKKE `"VERIFIED"` slik OpenAI (D-226) er, fordi DEN
 * statusen krever en EKTE eier-/juridisk handling (Tobias sin egen gjennomgang
 * av leverandørens Data controls-side, SAMME Q-32-mønster som OpenAI) som
 * ALDRI har skjedd for ElevenLabs. `evaluateSpeechRouting()` avviser derfor
 * denne behandleren for ALLE memory spaces inntil Tobias selv gjør den
 * gjennomgangen og `PROCESSOR_REGION_MATRIX.md` sin nye ElevenLabs-rad
 * oppdateres til `VERIFIED` - EKSAKT samme "kode finnes, gated til eier
 * handler"-disiplin som `PENDING_CREDENTIALS`-mønsteret i
 * `connector-registry.ts`, bare håndhevet av en ANNEN port (`speech.ts`,
 * ikke `ToolGateway`).
 *
 * BEVISST IKKE wiret inn i `main.ts` sin aktive adapter-utvelgelse i denne
 * sliceen: Tobias sin lokale piper-installasjon er ALLEREDE host-verifisert
 * fungerende (D-223) - å legge `ElevenLabsTts` inn i utvelgelseskjeden ville
 * risikert å FORTRENGE en allerede fungerende, ren lokal løsning med en
 * behandler `evaluateSpeechRouting()` uansett avviser (routingen har INGEN
 * stille fallback til neste adapter når en aktiv adapter blir avvist - D-122
 * sin "fail-closed, aldri stille sky-fallback"-disiplin, samme regelform som
 * `isSensitivityEligible()`). Wiring inn i den aktive kjeden er en EGEN,
 * senere beslutning Tobias selv tar når/hvis kontovilkårene er gjennomgått.
 *
 * API-formen (`POST /v1/text-to-speech/{voice_id}`, `xi-api-key`-header,
 * `output_format=pcm_16000`-query-parameter for RÅ PCM S16LE 16kHz - SAMME
 * samplerate som resten av tale-pipelinen bruker internt, IKKE OpenAI sin
 * 24kHz-respons sitt kjente re-samplings-gap) er ElevenLabs sin langvarig
 * dokumenterte, stabile REST-API-konvensjon - SAMME D-297-ærlighetsforbehold
 * som resten av denne økten: trent kunnskap, IKKE denne-økten-verifisert mot
 * live dokumentasjon (nettverksegress til `elevenlabs.io`/doc-domener
 * blokkert denne økten, forsøkt og bekreftet FØR denne sliceen ble valgt).
 */
export class ElevenLabsTts implements TtsAdapter {
  readonly name = "elevenlabs-tts";
  /** EKSTERN databehandler - se klassekommentaren for D-319/Q-32-status. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "elevenlabs-text-to-speech",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "NOT_VERIFIED"
  };
  /** `output_format=pcm_16000`. */
  readonly sampleRate = 16_000;
  constructor(
    private readonly apiKey: string | undefined = process.env["JARVIS_ELEVENLABS_API_KEY"],
    /** Påkrevd i selve URL-stien - ElevenLabs har intet "standard stemme"-endepunkt. */
    private readonly voiceId: string | undefined = process.env["JARVIS_ELEVENLABS_VOICE_ID"],
    private readonly modelId: string = "eleven_multilingual_v2"
  ) {}

  /** Stemme-ID-en er like påkrevd som nøkkelen - ElevenLabs kan strukturelt ikke kalles uten den. */
  available(): boolean {
    return Boolean(this.apiKey) && Boolean(this.voiceId);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.apiKey || !this.voiceId) {
      throw new Error("elevenlabs_tts_not_configured");
    }
    const { apiKey, voiceId, modelId } = this;
    let cancelled = false;
    async function* generate(): AsyncIterable<Buffer> {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "xi-api-key": apiKey },
          body: JSON.stringify({ text, model_id: modelId })
        }
      );
      if (!response.ok || !response.body) {
        throw new Error(`elevenlabs_tts_error_${response.status}`);
      }
      const reader = response.body.getReader();
      for (;;) {
        if (cancelled) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield Buffer.from(value);
      }
    }
    return { frames: generate(), cancel: () => (cancelled = true) };
  }
}

/**
 * Task #125 (D-217): lokal TTS via piper-binæren i `JARVIS_PIPER_BIN` +
 * stemmemodellen i `JARVIS_PIPER_MODEL` (`--model`-flagget piper krever).
 * I MOTSETNING til `LocalWhisperStt` (batch) ER piper EKTE strømmende: teksten
 * skrives til prosessens stdin, rå PCM-lydrammer leses FORTLØPENDE fra stdout
 * etter hvert som de produseres - ingen mellomlagret fil, ingen venting på at
 * HELE syntesen fullfører FØR første ramme. `cancel()` DREPER prosessen
 * umiddelbart (`child.kill()`) i stedet for kun å sette et flagg konsumenten
 * selv må polle - session.ts sin `bargeIn()` kaller `cancel()` FRA UTSIDEN
 * mens `for await`-løkken kan stå og vente på neste stdout-chunk (§15/§16:
 * barge-in skal stoppe avspilling UMIDDELBART) - et rent boolsk flagg ville
 * IKKE klart å avbryte et kall som allerede henger på en `await read()`.
 *
 * UNVERIFIED (D-41-disiplin, eksplisitt disclosed): `--model`/`--output_raw`
 * (understrek, ikke bindestrek) er den LANGVARIG DOKUMENTERTE, mest utbredte
 * piper-CLI-konvensjonen, men ALDRI kjørt mot en ekte installert binær i
 * denne økten (Q-32 punkt 3). Utdataens samplerate bestemmes av HVILKEN
 * stemmemodell Tobias installerer (typisk 22050 Hz, noen 16 kHz-varianter
 * finnes) - denne adapteren re-samplerer ALDRI selv (samme, allerede
 * eksisterende gap som `OpenAiTts` sin egen 24 kHz-respons - ingen
 * resampling noe sted i piloten ennå, IKKE noe denne sliceen bevisst løser).
 * Selve subprosess-/strømme-/kanselleringskoden ER testet, mot en faket
 * binær (se `test/local-piper-tts.test.ts`).
 */
export class LocalPiperTts implements TtsAdapter {
  readonly name = "local-piper";
  /** Lokal binær - tekst/lyd forlater aldri maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "local-piper",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  /**
   * D-390: piper-stemmer er typisk 22 050 Hz (noen 16 000) - raten bestemmes av stemmemodellen Tobias installerer, og settes med
   * `JARVIS_PIPER_SAMPLE_RATE` (standard 22 050). Adapteren re-samplerer ikke; klienten spiller av i denne raten.
   */
  readonly sampleRate: number;
  constructor(
    private readonly binPath: string | undefined = process.env["JARVIS_PIPER_BIN"],
    private readonly modelPath: string | undefined = process.env["JARVIS_PIPER_MODEL"],
    sampleRate: number = Number(process.env["JARVIS_PIPER_SAMPLE_RATE"] ?? "") || 22_050
  ) {
    this.sampleRate = sampleRate;
  }

  /** Stemmemodellen er like påkrevd som binæren - piper kan strukturelt ikke kjøre uten `--model`. */
  available(): boolean {
    return Boolean(this.binPath) && Boolean(this.modelPath);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.binPath || !this.modelPath) {
      throw new Error("local_piper_not_configured");
    }
    const { binPath, modelPath } = this;
    let cancelled = false;
    let child: ReturnType<typeof spawn> | undefined;
    async function* generate(): AsyncIterable<Buffer> {
      if (cancelled) {
        return;
      }
      // `detached: true` (POSIX): piper blir gruppeleder for en NY
      // prosessgruppe - `killProcessGroup()` under kan da drepe HELE
      // undertreet (`-pid`), ikke kun selve piper-PID-en. Nødvendig fordi et
      // reelt binær-kall i praksis kan spawne egne barneprosesser som ARVER
      // stdout-pipen - å drepe KUN toppen ville da latt pipen forbli åpen
      // (Node ser aldri EOF) og cancel() ville hengt til den underliggende
      // prosessen selv ga opp, EKSAKT det §15/§16 (barge-in) forbyr. Bevist
      // av `test/local-piper-tts.test.ts` sin `mock-piper-hang.sh`.
      const proc = spawn(binPath, ["--model", modelPath, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
      child = proc;
      let stderr = "";
      let stdinError: Error | null = null;
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      // D-256: SAMME bug-klasse som `LocalWhisperStt.end()` (se stt.ts sin
      // kommentar) - avslutter/lukker piper sin egen stdin FØR `.end(text)`
      // er ferdigskrevet, feiler skrivingen med EPIPE. Uten en egen lytter
      // her ville det vært en UHÅNDTERT "error"-hendelse på understrømmen
      // `proc.stdin`, ALDRI fanget av `proc.once("close", ...)` under - Node
      // kaster/krasjer HELE voice-gateway-prosessen på nøyaktig samme måte.
      proc.stdin.on("error", (err: Error) => {
        stdinError = err;
      });
      proc.stdin.end(text);
      const exitCode = new Promise<number | null>((resolve) => proc.once("close", resolve));
      try {
        for await (const chunk of proc.stdout) {
          if (cancelled) {
            return;
          }
          yield chunk as Buffer;
        }
      } finally {
        killProcessGroup(proc);
      }
      const code = await exitCode;
      if (!cancelled && code !== 0) {
        const detail = stdinError
          ? `${stderr.slice(0, 150)} (stdin write: ${(stdinError as Error).message})`
          : stderr.slice(0, 200);
        throw new Error(`local_piper_process_failed:${code ?? "unknown"}:${detail}`);
      }
    }
    return {
      frames: generate(),
      cancel(): void {
        cancelled = true;
        if (child) {
          killProcessGroup(child);
        }
      }
    };
  }
}

/**
 * Dreper HELE prosessgruppen `proc` leder (se `detached: true`-kommentaren
 * over), ALDRI kun selve PID-en - `ESRCH` (prosessen/gruppen er allerede
 * borte) svelges bevisst, det er den FORVENTEDE, harmløse utfallsformen når
 * prosessen allerede rakk å avslutte selv (f.eks. lykkes-banen der
 * `finally`-blokken kjører etter en NORMAL EOF, ikke en kansellering).
 */
function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  if (proc.killed || proc.exitCode !== null || proc.pid === undefined) {
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // ESRCH: allerede avsluttet - se filhode.
  }
}
