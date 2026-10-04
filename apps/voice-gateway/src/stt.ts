import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { WebSocket as WsClient } from "ws";
import { maybeDumpAudioForDebug } from "./debug-audio-dump.ts";

/**
 * SpeechAdapter (STT): streaming-kontrakt bak adapter - ingen leverandørkode
 * utenfor denne filen. Valg av leverandør skjer i stop/go-porten etter norsk
 * benchmark (D-10); arkitekturen låses ikke til én leverandør.
 */
export interface SttStream {
  pushAudio(frame: Buffer): void;
  /** Kalles ved end-of-turn; resolver med endelig transkript. */
  end(): Promise<string>;
  onPartial(cb: (text: string) => void): void;
}

export interface SttAdapter {
  readonly name: string;
  /**
   * D-122: erklæringen rutingsporten (`evaluateSpeechRouting`) dømmer på.
   * PÅKREVD - en ny STT-leverandør kan ikke legges til uten å ta stilling til
   * lokalitet og matriserad (`docs/security/PROCESSOR_REGION_MATRIX.md`).
   */
  readonly processor: SpeechProcessorDeclaration;
  available(): boolean;
  startStream(): SttStream;
}

/**
 * Deterministisk testadapter: testklienten koder tekst inn i lydrammer med
 * "TXT:"-prefiks. Rammene går gjennom hele den reelle kjeden (WS → filtre →
 * VAD → STT) slik at timing og tilstandsmaskin testes ekte.
 */
export class MarkerStt implements SttAdapter {
  readonly name = "marker-test";
  /** Ren testadapter i prosessen - ingen lyd forlater maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "marker-test",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  constructor(private readonly partialDelayMs = 40) {}

  available(): boolean {
    return true;
  }

  startStream(): SttStream {
    let text = "";
    let partialCb: ((t: string) => void) | undefined;
    let partialSent = false;
    const delay = this.partialDelayMs;
    return {
      pushAudio(frame: Buffer): void {
        const idx = frame.indexOf("TXT:");
        if (idx >= 0) {
          const end = frame.indexOf(0, idx);
          text += frame.subarray(idx + 4, end > idx ? end : undefined).toString("utf8");
          if (!partialSent && partialCb) {
            partialSent = true;
            const cb = partialCb;
            const partial = text;
            setTimeout(() => cb(partial), delay);
          }
        }
      },
      async end(): Promise<string> {
        return text.trim();
      },
      onPartial(cb): void {
        partialCb = cb;
      }
    };
  }
}

/**
 * OpenAI STT (batch transcriptions-API; streaming-STT vurderes i benchmark).
 * UVERIFISERT uten reell nøkkel - kandidat for norsk benchmark, ikke et valg.
 */
export class OpenAiStt implements SttAdapter {
  readonly name = "openai-stt";
  /**
   * EKSTERN databehandler: rå lyd (wav) sendes til OpenAI. Raden er NAVNGITT i
   * `PROCESSOR_REGION_MATRIX.md` (regel 1 oppfylt). Region (EU)/
   * databehandleravtale (godkjent)/treningsvilkår (nei, org-nivå-deling
   * deaktivert)/retensjon (inntil 30 dager, deretter slettet, ZDR
   * tilgjengelig for kvalifiserte) er nå faktisk BEKREFTET av Tobias sin egen
   * konto-gjennomgang (D-226, 2026-09-22) - regel 3 er derfor OPPFYLT og
   * `evaluateSpeechRouting()` slipper nå denne behandleren gjennom (fortsatt
   * betinget av `memory_space_authority: "SERVER_VERIFIED"`, se D-123).
   * Verdien endres KUN sammen med matriseraden - se PROCESSOR_REGION_MATRIX.md.
   */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "openai-audio-transcriptions",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "VERIFIED"
  };
  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = "whisper-1",
    /** PCM-samplerate for wav-innpakking (mikrofon 16k; OpenAI TTS-rundtur 24k). */
    private readonly sampleRate: number = 16000
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  startStream(): SttStream {
    if (!this.apiKey) {
      throw new Error("openai_stt_not_configured");
    }
    const chunks: Buffer[] = [];
    const { apiKey, model, sampleRate } = this;
    return {
      pushAudio(frame: Buffer): void {
        chunks.push(frame);
      },
      async end(): Promise<string> {
        const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate);
        const form = new FormData();
        form.set("model", model);
        form.set("language", "no");
        form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form
        });
        if (!response.ok) {
          throw new Error(`openai_stt_error_${response.status}`);
        }
        return ((await response.json()) as { text: string }).text;
      },
      onPartial(): void {
        // Batch-API gir ikke partials; streaming-kandidater vurderes i benchmark.
      }
    };
  }
}

/**
 * D-320 (harder-tier tale-backlog, andre slice - SAMME D-64-stil sjekk mot
 * `SpeechAdapter` som D-319/ElevenLabs gjorde for TTS-siden): `deepgram`
 * fjernet fra `connector-registry.ts` sin backlog og bygget her som en NY
 * `SttAdapter`, IKKE en `ToolGateway`-connector - se `tts.ts` sin
 * `ElevenLabsTts`-klassekommentar for full begrunnelse (SAMME resonnement,
 * bare STT i stedet for TTS).
 *
 * `processor.processor_terms_status` er BEVISST `"NOT_VERIFIED"` - SAMME
 * Q-32-mønster som ElevenLabs (D-319): krever en EKTE Tobias-gjennomgang av
 * Deepgram sin Data controls-side FØR `evaluateSpeechRouting()` slipper
 * behandleren gjennom for noen memory space. BEVISST IKKE wiret inn i
 * `main.ts` sin aktive adapter-utvelgelse - SAMME regresjonsbegrunnelse som
 * D-319 (routing-porten har ingen stille fallback, ville risikert å
 * fortrenge Tobias sin host-verifiserte lokale whisper.cpp-installasjon,
 * D-223, med en behandler routingen uansett avviser).
 *
 * Deepgram sitt forhåndsinnspilte ("batch") `/v1/listen`-endepunkt brukes -
 * SAMME "batch, ingen ekte partials"-disiplin som `OpenAiStt`/`LocalWhisperStt`
 * over (Deepgram tilbyr ekte streaming via WebSocket, men det er en HELT
 * annen transportform enn denne buffer-og-transkriber-kontrakten - vurderes
 * ikke her). Lyden sendes som en WAV-fil (`pcm16ToWav()`, SAMME hjelpefunksjon
 * som `OpenAiStt`/`LocalWhisperStt` bruker) i selve request-kroppen - Deepgram
 * detekterer format/samplerate fra WAV-headeren selv, ingen separate
 * `encoding`/`sample_rate`-query-parametre nødvendig når kroppen allerede er
 * en gyldig WAV-fil. `language`-query-parameteret defaulter til norsk, SAMME
 * som `OpenAiStt`/`LocalWhisperStt`.
 *
 * Samme D-297-ærlighetsforbehold som D-319/ElevenLabs: API-formen
 * (`Authorization: Token <key>`-header, `POST /v1/listen`, JSON-svaret sin
 * `results.channels[0].alternatives[0].transcript`-struktur) er Deepgram sin
 * langvarig dokumenterte, stabile konvensjon - trent kunnskap, IKKE denne-
 * økten-verifisert mot live dokumentasjon (nettverksegress til
 * `deepgram.com`/doc-domener bekreftet blokkert).
 */
export class DeepgramStt implements SttAdapter {
  readonly name = "deepgram-stt";
  /** EKSTERN databehandler - se klassekommentaren for D-320/Q-32-status. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "deepgram-listen",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "NOT_VERIFIED"
  };
  constructor(
    private readonly apiKey: string | undefined = process.env["JARVIS_DEEPGRAM_API_KEY"],
    private readonly language: string = process.env["JARVIS_DEEPGRAM_LANG"] ?? "no",
    /** PCM-samplerate for wav-innpakking - SAMME 16 kHz-forventning som resten av piloten. */
    private readonly sampleRate: number = 16000
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  startStream(): SttStream {
    if (!this.apiKey) {
      throw new Error("deepgram_stt_not_configured");
    }
    const chunks: Buffer[] = [];
    const { apiKey, language, sampleRate } = this;
    return {
      pushAudio(frame: Buffer): void {
        chunks.push(frame);
      },
      async end(): Promise<string> {
        const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate);
        const response = await fetch(`https://api.deepgram.com/v1/listen?language=${language}`, {
          method: "POST",
          headers: { authorization: `Token ${apiKey}`, "content-type": "audio/wav" },
          body: wav
        });
        if (!response.ok) {
          throw new Error(`deepgram_stt_error_${response.status}`);
        }
        const body = (await response.json()) as {
          results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
        };
        return body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      },
      onPartial(): void {
        // Batch-API gir ikke partials; streaming-kandidater vurderes i benchmark.
      }
    };
  }
}

/** Minimal, injiserbar WS-kontrakt - lar tester fake'e tilkoblingen uten ekte nettverk. */
interface DeepgramSocket {
  sendBinary(data: Buffer): void;
  sendText(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  onClose(cb: () => void): void;
}

function defaultDeepgramSocketFactory(url: string, headers: Record<string, string>): DeepgramSocket {
  const socket = new WsClient(url, { headers });
  return {
    sendBinary: (data) => socket.send(data),
    sendText: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (cb) => socket.on("open", cb),
    onMessage: (cb) => socket.on("message", (data) => cb(data.toString())),
    onError: (cb) => socket.on("error", cb),
    onClose: (cb) => socket.on("close", cb)
  };
}

/**
 * D-356 (Tobias direkte i chat: "fortsett og fikse voice ferdig" - direkte
 * oppfølging av D-353s EKSPLISITT UTSATTE latens-funn: "flaskehalsen er
 * batch-STT ... ekte fiks (streaming STT) er en STØRRE arkitektonisk
 * endring - IKKE forsøkt i dag").
 *
 * Deepgram sitt EKTE strømmings-endepunkt (`wss://api.deepgram.com/v1/listen`)
 * - til forskjell fra `DeepgramStt` over (batch, `POST /v1/listen`, venter
 * på HELE ytringen). Server transkriberer FORTLØPENDE mens råe PCM16-
 * lydrammer sendes BINÆRT over SAMME WebSocket - ingen JSON-innpakking av
 * selve lyden.
 *
 * BEVISST IKKE OpenAI Realtime API (`/v1/realtime`): en TIDLIGERE økt
 * undersøkte DEN via ekte `WebSearch` (D-328/Q-42, nettverk var da
 * tilgjengelig) og konkluderte eksplisitt "Ikke kodbar før presisert" - det
 * er en VEDVARENDE, full-dupleks samtale-økt (tur-deteksjon/avbrudds-
 * håndtering/verktøykall INNI selve tilkoblingen), en STØRRE arkitektur-
 * beslutning Tobias selv må ta FØRST (Q-42, fortsatt åpent). Denne posten
 * respekterer den porten UENDRET - bygger IKKE mot `/v1/realtime` i noen
 * form (et FØRSTE forsøk i DENNE økten bygget faktisk mot OpenAI sitt
 * transkripsjons-underformat av `/v1/realtime`, men ble reversert da denne
 * motsigelsen mot D-328/Q-42 ble oppdaget midt i byggingen - se D-356 sin
 * fulle ærlighetsnotat i DECISIONS_AND_ASSUMPTIONS.md). Deepgram sitt
 * STT-strømmings-produkt er derimot et rent, avgrenset transkripsjons-API
 * (INGEN samtaletilstand/verktøykall inni tilkoblingen) - passer den
 * EKSISTERENDE `SttAdapter`/`SttStream`-kontrakten uendret, SAMME
 * grensesnitt som `DeepgramStt`/`OpenAiStt` over, ingen ny
 * arkitekturkategori.
 *
 * Turens START/SLUTT styres FORTSATT av VÅR EGEN, allerede tunede
 * `EnergyVad` (`vad.ts`, D-275) - IKKE Deepgram sin egen server-side
 * endpointing (`vad_events`/`utterance_end_ms` BEVISST IKKE satt i
 * query-strengen under) - ETT sted avgjør turgrenser, ALDRI to
 * konkurrerende VAD-er. Når VÅR VAD sin `end_of_turn` trigger `session.ts`
 * sin `finishTurn()` -> `stt.end()`, sendes `{"type":"CloseStream"}` -
 * serveren har ALLEREDE transkribert fortløpende underveis, så
 * sluttresultatet er nær øyeblikkelig i stedet for å vente på
 * whisper.cpp/OpenAI sin hele-ytringen-batch-dekoding (D-353s dokumenterte
 * flaskehals).
 *
 * SAMME leverandør som `DeepgramStt` - MEN en distinkt `processor_id` her
 * (`deepgram-listen-streaming`) siden D-122 regel 3 gjelder PER TJENESTE.
 * `processor_terms_status: "NOT_VERIFIED"` (SAMME D-320-fail-closed-
 * mønster, UENDRET - en strømmings-variant av en allerede IKKE-godkjent
 * leverandør er IKKE mer godkjent enn batch-varianten). BEVISST IKKE wiret
 * inn i `main.ts` sin aktive adapter-utvelgelse, SAMME regresjonsbegrunnelse
 * som D-319/D-320 (rutingporten har ingen stille fallback).
 *
 * D-297-ærlighetsforbehold: nettverksegress til `api.deepgram.com` bekreftet
 * BLOKKERT i DENNE sandkassen (samme sjekk som D-320) - meldingsprotokollen
 * under (query-parametre, `Results`/`Metadata`-eventformen, `CloseStream`)
 * er TRENT KUNNSKAP om en offentlig, langvarig stabil API-flate - IKKE
 * denne-økten-verifisert mot live dokumentasjon. Krever Tobias sin egen
 * live-test FØR protokollen regnes bekreftet, HELT UAVHENGIG av
 * DPA-statusen over (to separate porter, aldri sammenblandet).
 */
export class DeepgramStreamingStt implements SttAdapter {
  readonly name = "deepgram-streaming-stt";
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "deepgram-listen-streaming",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "NOT_VERIFIED"
  };

  constructor(
    private readonly apiKey: string | undefined = process.env["JARVIS_DEEPGRAM_API_KEY"],
    private readonly language: string = process.env["JARVIS_DEEPGRAM_LANG"] ?? "no",
    private readonly sampleRate: number = 16000,
    private readonly socketFactory: (url: string, headers: Record<string, string>) => DeepgramSocket = defaultDeepgramSocketFactory
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  startStream(): SttStream {
    if (!this.apiKey) {
      throw new Error("deepgram_streaming_stt_not_configured");
    }
    const { apiKey, language, sampleRate, socketFactory } = this;
    let partialCb: (text: string) => void = () => {};
    let finalText = "";
    let sessionReady = false;
    const queue: Array<() => void> = [];
    let resolveEnd: ((text: string) => void) | undefined;
    let rejectEnd: ((err: Error) => void) | undefined;
    let terminalError: Error | undefined;
    let terminalText: string | undefined;
    let closeRequested = false;

    const settleError = (err: Error): void => {
      if (terminalError !== undefined || terminalText !== undefined) return;
      terminalError = err;
      rejectEnd?.(err);
    };
    const settleText = (text: string): void => {
      if (terminalError !== undefined || terminalText !== undefined) return;
      terminalText = text;
      resolveEnd?.(text);
    };
    const sendOrQueue = (fn: () => void): void => {
      if (sessionReady) fn();
      else queue.push(fn);
    };

    const url =
      `wss://api.deepgram.com/v1/listen?language=${language}` +
      `&encoding=linear16&sample_rate=${sampleRate}&interim_results=true&punctuate=true`;
    const socket = socketFactory(url, { authorization: `Token ${apiKey}` });

    socket.onOpen(() => {
      sessionReady = true;
      for (const fn of queue.splice(0)) fn();
    });

    socket.onMessage((raw) => {
      let event: { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return;
      }
      if (event.type === "Results") {
        const transcript = event.channel?.alternatives?.[0]?.transcript ?? "";
        if (transcript.length === 0) return;
        if (event.is_final) {
          finalText = finalText.length > 0 ? `${finalText} ${transcript}` : transcript;
        }
        partialCb(finalText.length > 0 ? finalText : transcript);
        return;
      }
      if (event.type === "Metadata") {
        socket.close();
        if (closeRequested) {
          settleText(finalText);
        }
      }
    });
    socket.onError((err) => settleError(err instanceof Error ? err : new Error(String(err))));
    socket.onClose(() => {
      if (closeRequested) {
        settleText(finalText);
      } else {
        settleError(new Error("deepgram_streaming_stt_closed_before_result"));
      }
    });

    return {
      pushAudio(frame: Buffer): void {
        sendOrQueue(() => socket.sendBinary(frame));
      },
      end(): Promise<string> {
        return new Promise((resolve, reject) => {
          if (terminalError !== undefined) {
            reject(terminalError);
            return;
          }
          if (terminalText !== undefined) {
            resolve(terminalText);
            return;
          }
          resolveEnd = resolve;
          rejectEnd = reject;
          closeRequested = true;
          sendOrQueue(() => socket.sendText(JSON.stringify({ type: "CloseStream" })));
        });
      },
      onPartial(cb: (text: string) => void): void {
        partialCb = cb;
      }
    };
  }
}

/**
 * Task #125 (D-217): lokal STT via whisper.cpp-binæren i `JARVIS_WHISPER_BIN`
 * (full sti til den installerte kjørbare filen - navnet varierer mellom
 * whisper.cpp-versjoner, f.eks. `main`/`whisper-cli`, derfor ALDRI hardkodet
 * her) + modellfilen i `JARVIS_WHISPER_MODEL` (`-m`-flagget whisper.cpp
 * krever). SAMME "batch, ingen ekte partials"-disiplin som `OpenAiStt` over -
 * whisper.cpp sin vanlige CLI transkriberer HELE lydfilen på én gang, den har
 * INGEN inkrementell strømmemodus for dette buffer-og-transkriber-mønsteret
 * (VAD-en avgjør allerede turgrensene FØR STT-en i det hele tatt kalles) -
 * `onPartial()` er derfor bevisst en no-op, EKSAKT samme, allerede etablerte
 * ærlighetsdisiplin som `OpenAiStt` sin egen kommentar ("Batch-API gir ikke
 * partials").
 *
 * §22-INVARIANT (`test/d30-foundation.test.ts` "Personvern: rå lyd
 * persisteres aldri"): denne filen forbys STATISK å inneholde NOEN
 * disk-skrive-API fra `node:fs` (fil-skriving/vedlegging/skrivestrøm-
 * konstruktøren) - rå lyd skal ALDRI treffe disk, ikke engang midlertidig.
 * whisper.cpp sin vanlige CLI krever normalt en fil via `-f`, men `end()`
 * under sender i stedet WAV-bytene DIREKTE på prosessens STDIN og kaller
 * den med `-f -` (Unix-konvensjonen for "les fra stdin") - lyden forlater
 * derfor prosessminnet KUN via et pipe til den lokale binæren, ALDRI via
 * filsystemet.
 *
 * D-279 (2026-09-26, Tobias sitt EKSPLISITTE samtykke i chat, ETTER at
 * D-262→D-278, 17 poster, hadde individuelt utelukket HVER kildekode-
 * testbar hypotese): DENNE filen kaller nå `maybeDumpAudioForDebug()`
 * (`debug-audio-dump.ts` - bevisst IKKE i §22-testens filliste) når
 * resultatet er tomt - men selve filskrivingen skjer UTELUKKENDE i DEN
 * separate filen, aldri her. `stt.ts` inneholder derfor FORTSATT null
 * disk-skrive-API-er selv - påstanden over ("lyden forlater prosessminnet
 * KUN via et pipe") forblir bokstavelig sann for STT-KALLET; unntaket er et
 * bevisst, eksplisitt Tobias-autorisert sidespor, AV som standard
 * (`JARVIS_VOICE_DEBUG_DUMP_DIR` usatt = no-op), for denne ene, midlertidige
 * diagnostikk-undersøkelsen. Se D-279 i DECISIONS_AND_ASSUMPTIONS.md.
 *
 * UNVERIFIED (D-41-disiplin, eksplisitt disclosed, ikke stille antatt): BÅDE
 * de eksakte CLI-flaggene (`-m`/`-f`/`-nt`/`-l`) OG antagelsen om at
 * whisper.cpp faktisk støtter `-f -` for stdin, er whisper.cpp sin
 * LANGVARIG DOKUMENTERTE, mest utbredte konvensjon, men ALDRI kjørt mot en
 * ekte installert binær i denne økten (Q-32 punkt 3 - Tobias har ikke
 * installert whisper.cpp ennå) - dersom den installerte binæren IKKE støtter
 * `-f -`, feiler `end()` synlig (`local_whisper_process_failed`), ALDRI en
 * stille disk-skriving som fallback. Selve subprosess-/stdin-/
 * feilhåndteringskoden ER testet, mot en faket binær (se
 * `test/local-whisper-stt.test.ts`).
 */
export class LocalWhisperStt implements SttAdapter {
  readonly name = "local-whisper";
  /** Lokal binær - rå lyd forlater aldri maskinen (D-23-kandidaten for `health`). */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "local-whisper-cpp",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  constructor(
    private readonly binPath: string | undefined = process.env["JARVIS_WHISPER_BIN"],
    private readonly modelPath: string | undefined = process.env["JARVIS_WHISPER_MODEL"],
    /** PCM-samplerate for wav-innpakking - SAMME 16 kHz-forventning som resten av piloten (`pcm16ToWav`/`docs/VOICE_BENCHMARK.md`). */
    private readonly sampleRate: number = 16000,
    /** whisper.cpp sitt `-l`-språkflagg - default norsk, SAMME som `OpenAiStt`. */
    private readonly language: string = process.env["JARVIS_WHISPER_LANG"] ?? "no",
    /**
     * D-390: `-t` tråder - whisper.cpp sin standard er 4 uansett maskin; på en NAS/PC med flere kjerner er dekodingen den største
     * delen av svartiden (batch-STT, D-353), så alle kjerner (maks 8) brukes med mindre `JARVIS_WHISPER_THREADS` sier noe annet.
     */
    private readonly threads: number = Number(process.env["JARVIS_WHISPER_THREADS"] ?? "") || Math.max(1, Math.min(8, cpus().length)),
    /**
     * D-390: valgfri `--prompt` - whisper bruker den som stilkontekst (norsk bokmål, navnene Charlie/Tobias/Jarvis) og gjenkjenner
     * egennavn og norsk ortografi bedre. Tom = ikke sendt.
     */
    private readonly prompt: string | undefined = process.env["JARVIS_WHISPER_PROMPT"]
  ) {}

  /** Argumentene som sendes til whisper-cli (observerbart for tester). */
  cliArgs(tmpOutBase: string): string[] {
    const args = ["-m", this.modelPath ?? "", "-f", "-", "-nt", "-otxt", "-of", tmpOutBase, "-nth", "1.01", "-l", this.language, "-t", String(this.threads)];
    if (this.prompt !== undefined && this.prompt.trim().length > 0) args.push("--prompt", this.prompt.trim());
    return args;
  }

  /** Modellen er like påkrevd som binæren - whisper.cpp kan strukturelt ikke kjøre uten `-m`. */
  available(): boolean {
    return Boolean(this.binPath) && Boolean(this.modelPath);
  }

  startStream(): SttStream {
    if (!this.binPath || !this.modelPath) {
      throw new Error("local_whisper_not_configured");
    }
    const { binPath, sampleRate } = this;
    const cliArgs = (tmpOutBase: string): string[] => this.cliArgs(tmpOutBase);
    const chunks: Buffer[] = [];
    return {
      pushAudio(frame: Buffer): void {
        chunks.push(frame);
      },
      async end(): Promise<string> {
        const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate);
        // D-266 (Tobias direkte i chat, live NAS-test MED D-265 sin
        // anti-alias-fiks aktiv): IDENTISK symptom som FØR D-265 - whisper.cpp
        // brukte fortsatt ekte, lengde-proporsjonal encode-/decode-tid (opptil
        // 1766ms) på flere turer (0,6-0,8 sek reell tale), OG `fallbacks = 1
        // p / 0 h` (whisper.cpp sin EGEN temperatur-refallback, utløst av
        // dens interne selvtillits-vakter) - men produserte likevel
        // KONSEKVENT tomt resultat. Dette utelukker anti-alias-forvrengning
        // som eneste/hovedårsak: selv med korrekt resamplet lyd (D-265)
        // vedvarer mønsteret UENDRET. Verifisert mot whisper.cpp v1.9.4 sin
        // faktiske kildekode (examples/cli/cli.cpp, IKKE gjettet - D-41-
        // disiplin): `-nth`/`--no-speech-thold` (standard 0.6) sammen med
        // `-et`/`--entropy-thold` (2.40) og `-lpt`/`--logprob-thold` (-1.00)
        // er whisper.cpp sin EGEN interne "er dette faktisk tale"-vakt som
        // stille forkaster et dekodet segment når den ikke er trygg nok -
        // PRESIST forklarer et ekte dekodeforsøk (ikke-null sample-/decode-
        // tid, en fallback-retry) som likevel ender tomt. Denne vakten er
        // STRUKTURELT REDUNDANT her: `EnergyVad` (`vad.ts`) har ALLEREDE
        // avgjort at dette ER tale FØR STT-en i det hele tatt kalles (en tur
        // starter kun ved `speech_start`, lyd mates kun under `speech`-
        // tilstand) - whisper.cpp sin egen, dårligere kalibrerte
        // (svakeste "base"-modell, norsk som ikke-engelsk språk) gjetning på
        // det SAMME spørsmålet overstyrer i praksis vår VAD sitt allerede
        // tatte vedtak.
        //
        // D-267 (RETTELSE, funnet FØRSTE live-forsøk med D-266 sin
        // `-nth 0.0`-fiks): D-266 hadde retningen på terskelen BAKVENDT -
        // whisper.cpp (identisk med OpenAI Whisper sin referanseimplementasjon
        // sin `decoding.py`) forkaster et segment når `no_speech_prob >
        // no_speech_thold` - en LAV terskel gjør det derfor LETTERE å
        // overskride (nesten enhver ikke-null no-speech-sannsynlighet > 0.0),
        // altså MER aggressiv forkasting, IKKE mindre. Live-loggen etter
        // D-266 bekreftet dette PRESIST: flere forsøk viste nå
        // `decode time = 0.00 ms / 1 runs` (whisper.cpp forkastet FØR reell
        // dekoding i det hele tatt startet) - enda raskere avvist enn med
        // standardverdien 0.6. Riktig retning for å DEAKTIVERE vakten er å
        // gjøre terskelen umulig å overskride: en gyldig sannsynlighet kan
        // aldri overstige 1.0, så `1.01` garanterer at
        // `no_speech_prob > no_speech_thold` ALDRI blir sann.
        // D-270 (DEN FAKTISKE root cause, funnet ved a lese whisper.cpp v1.9.4
        // sin EGEN kildekode direkte - examples/cli/cli.cpp, IKKE gjettet,
        // etter at D-269 sin sampleRate-diagnostikk beviste at ALLE tidligere
        // lag (VAD, WAV-header, no-speech-vakt, midt-i-turen-spleising,
        // nettleser-resampling) FAKTISK var korrekte, mens text_length: 0
        // FORTSATT var 100% konsekvent pa tvers av ni pafolgende, hoylytte,
        // fullengde-turer): whisper-cli sin fout_factory
        // (cli.cpp linje ca 1117-1131) setter fname_out til INPUT-filnavnet
        // (fname_inp) nar -of/--output-file IKKE er gitt - og siden vi
        // sender -f - (stdin), blir fname_inp (og dermed fname_out)
        // BOKSTAVELIG "-". is_stdout = (fname_out == "-") blir dermed
        // SANN, og konstruktoren setter
        // print_segment_callback = is_stdout ? nullptr : whisper_print_segment_callback
        // - selve callback-en som ville skrevet HVERT transkribert segment
        // blir EKSPLISITT deaktivert (nullptr) utelukkende FORDI stdin-input
        // tilfeldigvis kolliderer med "-"-sentinelen for stdout-output.
        // output_txt() (funksjonen som FAKTISK ville skrevet klartekst-
        // resultatet) kalles KUN nar params.output_txt er satt (cli.cpp sin
        // output_ext(txt, ...)-makro) - et flagg vi ALDRI har sendt.
        // Nettoresultat: whisper.cpp gjor EKTE, fullstendig dekodingsarbeid
        // (bekrefter ALLE tidligere observerte ikke-null encode-/decode-
        // tider gjennom HELE denne okten), beregner et EKTE transkript
        // internt, og SKRIVER DET DERETTER INGEN STEDER. Den evig
        // tilstedevaerende "warning: '--output-file -' used without any
        // other '--output-*'" (synlig i HVER ENESTE stderr-logg denne
        // okten, konsekvent avfeid som stoy) var whisper.cpp sin egen,
        // aerlige innrommelse av PRESIST dette. Fiks: legg til
        // -otxt/--output-txt - dette setter params.output_txt = true, som
        // far output_ext(txt, ...) til faktisk a kalle
        // fout_factory.open(".txt", ...) (som, siden is_stdout er sann,
        // apner /dev/stdout DIREKTE) og deretter output_txt(...), som
        // skriver hvert segment sin klartekst (ledende whitespace trimmet,
        // ingen tidsstempler/JSON, verifisert linje-for-linje mot
        // output_txt() sin egen kildekode) til akkurat den strommen var
        // proc.stdout.on("data", ...)-lytter allerede fanger opp.
        // D-281 (root cause FUNNET og VERIFISERT ved å lese whisper.cpp v1.9.4
        // sin faktiske kildekode - examples/cli/cli.cpp, fout_factory::open(),
        // linje ca 1135-1150 - OG ved en isolert, app-uavhengig reproduksjon
        // via en frittstående Node.js-spawn()-testskript rett mot den ekte
        // binæren og en av de FAKTISK innspilte, ETTER D-270/D-271-fiksene
        // fortsatt tomme, lydklippene, bekreftet i live lytting å inneholde
        // klar, tydelig tale - "hører meg selv klart og tydelig", Tobias):
        // D-270 sin `-otxt`-fiks fikk whisper.cpp til å FAKTISK KALLE
        // output_txt() - men UTEN et eksplisitt `-of`-flagg forblir
        // fname_out == fname_inp == "-" (stdin-sentinelen), altså
        // is_stdout == true, og fout_factory::open() prøver da å skrive til
        // stdout ved å ÅPNE "/dev/stdout" PÅ NYTT som en helt FERSK
        // std::ofstream (ikke ved å gjenbruke selve filedeskriptor 1) -
        // KOMMENTERT rett over selve koden i whisper.cpp: "Also assuming
        // /dev is mounted" - open()-resultatet sjekkes ALDRI, og feil
        // rapporteres BEVISST ALDRI ("Not using fprintf stderr here because
        // it might equal stdout"). Manuelle `docker exec`/shell-tester
        // (Test A/B/C) LYKTES alle konsekvent, FORDI en shell allerede har
        // satt opp fd 1 til å PEKE PÅ noe reelt før whisper-cli i det hele
        // tatt starter. Node.js sin `child_process.spawn()` med
        // `stdio: ["pipe","pipe","pipe"]` gir derimot whisper-cli et helt
        // NYTT, Node-eid anonymt pipe som fd 1 - og whisper.cpp sin egen,
        // pathname-baserte "/dev/stdout"-gjenåpning klarer IKKE å levere
        // bytes til DEN, selv om selve dekodingen (bekreftet identisk,
        // ekte, ikke-null encode-/decode-tid gjennom HELE D-262→D-280-
        // serien) skjer helt normalt internt. Fiksen slutter å stole på
        // denne skjøre stdout-gjenåpningen: `-of <midlertidig-basenavn>`
        // ber whisper.cpp skrive til en EKTE fil (whisper.cpp sin egen,
        // lenge etablerte, velprøvde skrivevei - IKKE en spesialtilpasset
        // stdout-sti), og koden under leser DEN filen eksplisitt etter at
        // prosessen er ferdig. KUN transkribert TEKST berører disk
        // midlertidig her, ALDRI selve lyden - lyden går fortsatt
        // UTELUKKENDE via stdin-pipen (`proc.stdin.end(wav)` under, uendret
        // fra før) - §22-invarianten (rå lyd persisteres aldri) er derfor
        // fortsatt intakt.
        const tmpOutBase = join(tmpdir(), `jarvis-whisper-${randomUUID()}`);
        // D-390: `-t <tråder>` (+ valgfri `--prompt`) i tillegg - se `cliArgs()`.
        const proc = spawn(binPath, cliArgs(tmpOutBase), {
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let stdinError: Error | null = null;
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        proc.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        // D-256: hvis binæren avslutter (eller lukker sin egen stdin) FØR vi er
        // ferdige med å skrive, feiler `.end(wav)` under med EPIPE. `proc`s
        // EGET "error"-event (håndtert i exitCode-løftet under) dekker KUN
        // spawn-feil på selve prosessen, ALDRI en skrivefeil på understrømmen
        // `proc.stdin` - uten en egen lytter her er det en UHÅNDTERT
        // "error"-hendelse, og Node kaster/krasjer HELE prosessen (funnet
        // live på NAS-en: "den bare lukker seg" - containeren restartet på
        // hver eneste taleytring). Lagre feilen i stedet, la `close`-eventet
        // (som fortsatt fyres uansett) avgjøre utfallet som normalt.
        proc.stdin.on("error", (err: Error) => {
          stdinError = err;
        });
        const exitCode = new Promise<number | null>((resolve, reject) => {
          proc.once("error", reject);
          proc.once("close", resolve);
        });
        proc.stdin.end(wav);
        let code: number | null;
        try {
          code = await exitCode;
        } catch (err) {
          throw new Error(`local_whisper_spawn_failed:${(err as Error).message.slice(0, 200)}`);
        }
        if (code !== 0) {
          await cleanupTmpOutput(tmpOutBase);
          const detail = stdinError
            ? `${stderr.slice(0, 150)} (stdin write: ${(stdinError as Error).message})`
            : stderr.slice(0, 200);
          throw new Error(`local_whisper_process_failed:${code ?? "unknown"}:${detail}`);
        }
        // D-281: teksten leses nå fra `-of`-filen (se spawn-kommentaren over),
        // IKKE lenger fra `stdout` - `-otxt` uten `-of` skrev (upålitelig) til
        // en gjenåpnet "/dev/stdout"; `-of <tmpOutBase>` skriver til en EKTE
        // fil whisper.cpp selv oppretter (`<tmpOutBase>.txt`). Filen inneholder
        // KUN transkribert tekst (whisper.cpp sin egen output_txt(), ingen
        // tidsstempler/JSON - samme innhold som FØR, bare en annen kanal) -
        // slettes uansett utfall (`cleanupTmpOutput`), ALDRI liggende igjen.
        let text: string;
        try {
          text = (await readFile(`${tmpOutBase}.txt`, "utf8")).trim();
        } catch (err) {
          await cleanupTmpOutput(tmpOutBase);
          throw new Error(`local_whisper_output_file_missing:${(err as Error).message.slice(0, 200)}`);
        }
        await cleanupTmpOutput(tmpOutBase);
        // D-263 (Tobias direkte i chat, live NAS-test MED D-262 sin nye logging
        // aktiv): HVER eneste tur, inkludert én med 2+ sekunder sammenhengende
        // tale-energi, ga `voice_stt_result` med `text_length: 0` - ALDRI
        // `voice_core_reply_sent`. whisper-cli avsluttet med kode 0 (INGEN
        // `local_whisper_process_failed`) - prosessen kjørte altså "vellykket",
        // den bare fant ingenting å transkribere. `stderr` (whisper.cpp sin
        // EGEN diagnostikk - modell-/decode-/"no speech"-info, ALDRI selve
        // transkripsjonen, som kun skrives til stdout) ble FØR denne fiksen
        // fanget opp, men stille kastet bort på nøyaktig denne (suksess+tomt
        // resultat) stien - samme "en feil/et signal svelges stille"-mønster
        // som D-254/D-261/D-262, nå ett lag dypere inne i selve STT-adapteren.
        // KUN logget når resultatet faktisk er tomt (aldri når en transkripsjon
        // finnes) - unngår enhver risiko for at whisper.cpp sin verbose stderr
        // skulle inneholde delvis gjenkjent tale, samme personvern-disiplin
        // som §22 andre steder i filen.
        //
        // D-264 (Tobias direkte i chat, FØRSTE live-forsøk MED denne
        // diagnostikken på): et 300-tegns utdrag var IKKE nok - whisper.cpp
        // sitt modell-laste-banner alene (GPU-init/flash-attn/dtw-linjene,
        // ALLTID skrevet FØRST) fylte hele budsjettet og kuttet av FØR selve
        // prosesserings-/"no speech"-diagnostikken lenger ned i stderr kunne
        // nås. 4000 tegn er rikelig for whisper.cpp sin fulle stderr for én
        // kort ytring (banner + system_info + evt. per-segment-info +
        // timing-oppsummering), fortsatt trygt bundet (aldri ubegrenset).
        if (!text) {
          // D-271 (live NAS-forsøk MED D-270 sin -otxt-fiks aktiv, bekreftet
          // via at "--output-file -"-advarselen ENDELIG er borte fra
          // stderr): FORTSATT `text_length: 0` på noen turer, men denne
          // gangen med synlig EKTE flerrunde-dekoding (sample-/batchd-tid),
          // ikke lenger det gamle "decode time = 0.00 ms / 1 run FØR reell
          // dekoding startet"-mønsteret D-266/D-267 identifiserte. To
          // gjenstående, ikke-utelukkede forklaringer: (a) `output_txt()`
          // FAKTISK skriver whisper.cpp sitt EGNE, legitime "ingen
          // gjenkjennbar tale"-resultat (en ekte modell-avgjørelse på denne
          // spesifikke lyden, ikke en kode-bug), eller (b) et FORTSATT
          // gjenværende plumbing-lag mellom `output_txt()` sin
          // `/dev/stdout`-skriving og vår `proc.stdout.on("data", ...)`-
          // lytter. `stdout.length` (RÅ byte-lengde FØR trim, ALDRI selve
          // innholdet - samme §22-personvernsdisiplin som resten av denne
          // klassen) skiller de to: 0 betyr INGEN bytes noensinne ankom
          // (fortsatt et plumbing-lag), mens et positivt tall (f.eks. kun
          // whitespace/linjeskift) beviser whisper.cpp FAKTISK skrev noe -
          // og at selve MODELLEN, ikke rørledningen, er neste sted å se.
          console.error(
            JSON.stringify({
              msg: "voice_stt_empty_result_diagnostic",
              wav_bytes: wav.length,
              // D-281: `stdout_raw_length` var den avgjørende diagnostikken
              // FØR fiksen (0 bekreftet plumbing-laget, se D-271-kommentaren
              // over) - stdout brukes ikke lenger som teksttransport, men
              // feltet beholdes uendret (nå typisk 0/nær-0) for kontinuitet
              // i loggmønsteret. `text.length` er den NYE, avgjørende
              // diagnostikken: 0 her betyr whisper.cpp selv skrev en tom
              // `.txt`-fil (en EKTE modell-avgjørelse på lyden), ikke lenger
              // et transportspørsmål.
              stdout_raw_length: stdout.length,
              output_file_text_length: text.length,
              stderr_excerpt: stderr.slice(0, 4000)
            })
          );
          // D-279: se filhode-kommentaren over. AV med mindre Tobias selv har
          // satt JARVIS_VOICE_DEBUG_DUMP_DIR - da en no-op. `.catch()` i
          // stedet for await-i-try: en feil her (f.eks. mappen ikke skrivbar)
          // skal ALDRI kaste videre og forstyrre selve STT-svaret.
          maybeDumpAudioForDebug(wav)
            .then((path) => {
              if (path) {
                console.error(JSON.stringify({ msg: "voice_debug_audio_dumped", path }));
              }
            })
            .catch((err: unknown) => {
              console.error(
                JSON.stringify({ msg: "voice_debug_audio_dump_failed", error: (err as Error).message })
              );
            });
        }
        return text;
      },
      onPartial(): void {
        // whisper.cpp sin batch-CLI gir ingen inkrementelle partials - se klassekommentaren.
      }
    };
  }
}

/**
 * D-281: sletter whisper.cpp sin `-of`-utdatafil (`<base>.txt`) etter at
 * `LocalWhisperStt.end()` er ferdig med å lese den - uansett om lesingen
 * lyktes, feilet, eller prosessen aldri produserte filen i det hele tatt
 * (f.eks. `code !== 0`). Kun den MIDLERTIDIGE TRANSKRIPT-TEKSTEN berører
 * disk her, ALDRI selve lyden (§22 uendret - se filhode-kommentaren).
 * `unlink()` sin egen feil (typisk ENOENT når filen aldri ble opprettet)
 * svelges bevisst - opprydding skal ALDRI kaste og overstyre det egentlige
 * STT-resultatet/-feilen den ble kalt etter.
 */
async function cleanupTmpOutput(tmpBase: string): Promise<void> {
  try {
    await unlink(`${tmpBase}.txt`);
  } catch {
    // Forventet når filen aldri ble opprettet (f.eks. prosessen feilet FØR
    // output_txt() ble kalt) - ikke en feil å rapportere videre.
  }
}

export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
