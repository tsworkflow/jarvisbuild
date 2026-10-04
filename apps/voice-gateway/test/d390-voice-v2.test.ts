import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { VoiceSession, toolActivityText, type CoreClient, type CoreStreamEvent, type SessionEvents, type VoiceIdentity } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import { LocalWhisperStt } from "../src/stt.ts";
import { FakeTts, LocalPiperTts, OpenAiTts, type TtsAdapter, type TtsPlayback } from "../src/tts.ts";
import { EnergyVad } from "../src/vad.ts";
import { normalizeForNorwegianSpeech, sanitizeForSpeech } from "../src/text-sanitize.ts";

/**
 * D-390 (Tobias: «gå over hele voice strukturen så vi får den raskeste responsen med best svar og tydelig svar som hører meg bra»):
 * adaptiv VAD, pre-roll, TTS-forhåndshenting, fyllord, talt verktøystatus, ingen zombie-tur etter frakobling, samplerate per
 * adapter, whisper-tråder og norsk TTS-normalisering. Alle nye sesjonsinnstillinger er AV uten eksplisitt verdi (eldre tester
 * uendret) - denne suiten slår dem på eksplisitt.
 */
const identity: VoiceIdentity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal", channel: "voice" };
const LOCAL: SpeechProcessorDeclaration = { processor_id: "test", locality: "local", processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" };

function spyStt(text: string, opts: { endDelayMs?: number } = {}): { adapter: SttAdapter; frames: Buffer[] } {
  const frames: Buffer[] = [];
  return {
    frames,
    adapter: {
      name: "spy", processor: LOCAL, available: () => true,
      startStream(): SttStream {
        return {
          pushAudio: (f) => { frames.push(f); },
          end: async () => { if (opts.endDelayMs) await new Promise((r) => setTimeout(r, opts.endDelayMs)); return text; },
          onPartial: () => undefined
        };
      }
    }
  };
}

/** TTS-spion: registrerer når synthesize() kalles og når første ramme faktisk trekkes (late generatorer, se `primePlayback`). */
function spyTts(frameDelayMs = 5, framesPerChunk = 3): {
  adapter: TtsAdapter; synthesized: string[]; cancelled: string[]; started: string[]; startedAt: Map<string, number>; finishedAt: Map<string, number>;
} {
  const synthesized: string[] = [];
  const cancelled: string[] = [];
  const started: string[] = [];
  const startedAt = new Map<string, number>();
  const finishedAt = new Map<string, number>();
  return {
    synthesized, cancelled, started, startedAt, finishedAt,
    adapter: {
      name: "spy-tts", processor: LOCAL, sampleRate: 16_000, available: () => true,
      synthesize(text): TtsPlayback {
        synthesized.push(text);
        let stop = false;
        async function* gen(): AsyncIterable<Buffer> {
          started.push(text);
          startedAt.set(text, performance.now());
          for (let i = 0; i < framesPerChunk; i++) {
            await new Promise((r) => setTimeout(r, frameDelayMs));
            if (stop) return;
            const b = Buffer.alloc(64);
            b.write(text.slice(0, 8), 0, "utf8");
            yield b;
          }
          finishedAt.set(text, performance.now());
        }
        return { frames: gen(), cancel: () => { stop = true; cancelled.push(text); } };
      }
    }
  };
}

function events(over: Partial<SessionEvents> = {}): SessionEvents & { frames: Buffer[]; errors: string[]; activity: string[] } {
  const frames: Buffer[] = [];
  const errors: string[] = [];
  const activity: string[] = [];
  return {
    frames, errors, activity,
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
    onTtsFrame: (f) => { frames.push(f); }, onTtsCancelled: () => undefined, onMetrics: () => undefined,
    onError: (e) => { errors.push(e); }, onToolActivity: (a) => { activity.push(a); },
    ...over
  };
}

const speech = (): Buffer => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(9000, i * 2); return b; };
const quiet = (amplitude: number): Buffer => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2); return b; };
const silence = (): Buffer => Buffer.alloc(640);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { vi.restoreAllMocks(); });

describe("adaptiv VAD (hører meg bra)", () => {
  it("fast modus er identisk med før; adaptiv starter på samme terskel og senker den i et stille rom", () => {
    const fixed = new EnergyVad(0.05, 700);
    const adaptive = new EnergyVad(0.05, 700, { adaptive: true });
    expect(fixed.effectiveThreshold()).toBe(0.05);
    expect(adaptive.effectiveThreshold()).toBeCloseTo(0.05, 6);
    // Svak tale (RMS ≈ 0.02) i et stille rom: fast terskel hører den ALDRI, adaptiv gjør det etter at gulvet er målt.
    let t = 0;
    for (let i = 0; i < 80; i++) { fixed.push(silence(), (t += 64)); adaptive.push(silence(), t); }
    expect(adaptive.effectiveThreshold()).toBeCloseTo(0.012, 6);
    const weak = quiet(650); // RMS ≈ 0.0198
    expect(fixed.push(weak, (t += 64))).toBe("silence");
    expect(adaptive.push(weak, t)).toBe("speech_start");
  });

  it("i et støyende rom heves terskelen (opp til 2x), og en tur som aldri får stillhet avsluttes tvungent", () => {
    const vad = new EnergyVad(0.05, 700, { adaptive: true, maxTurnMs: 2000 });
    let t = 0;
    for (let i = 0; i < 120; i++) vad.push(quiet(1200), (t += 64)); // RMS ≈ 0.037 støy, under 0.05
    expect(vad.effectiveThreshold()).toBeGreaterThan(0.09);
    expect(vad.effectiveThreshold()).toBeLessThanOrEqual(0.1);
    // Vedvarende tale/støy over terskelen: maxTurnMs tvinger end_of_turn.
    expect(vad.push(speech(), (t += 64))).toBe("speech_start");
    let ev: string = "speech";
    for (let i = 0; i < 40 && ev !== "end_of_turn"; i++) ev = vad.push(speech(), (t += 64));
    expect(ev).toBe("end_of_turn");
  });
});

describe("pre-roll: ordets begynnelse før VAD-en trigget følger med til STT", () => {
  it("de siste preRollMs ms stillhet/svak lyd sendes FØRST når turen starter - og aldri uten en tur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stt = spyStt("hei charlie");
    const core: CoreClient = { chat: async () => ({ reply: "hei", routed: "model", session_id: "s" }) };
    const session = new VoiceSession(identity, core, stt.adapter, new FakeTts(1), events(), undefined, new EnergyVad(), undefined, undefined, undefined, undefined, "CLIENT_ASSERTED", { preRollMs: 100 });
    let t = 1000;
    for (let i = 0; i < 10; i++) session.pushAudio(quiet(10 + i), (t += 20)); // 200 ms stillhet, kun de siste 100 ms (5 rammer) beholdes
    expect(stt.frames.length).toBe(0);
    session.pushAudio(speech(), (t += 20)); // speech_start → pre-roll (5) + denne (1)
    expect(stt.frames.length).toBe(6);
    expect(stt.frames[0]!.readInt16LE(0)).toBe(15); // den eldste beholdte rammen (i=5), ikke i=0
    expect(stt.frames[5]!.readInt16LE(0)).toBe(9000);
    session.pushAudio(silence(), (t += 800));
    await sleep(30);
  });
});

describe("TTS-forhåndshenting: neste setning syntetiseres mens den første spilles", () => {
  it("chunk 2 er startet FØR chunk 1 er ferdig spilt; rekkefølgen på rammene er bevart; barge-in kansellerer også den forhåndshentede", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tts = spyTts(15, 6);
    const ev = events();
    const core: CoreClient = {
      chat: async () => ({ reply: "", routed: "model", session_id: "s" }),
      chatStream: async (_i, _m, onEvent) => {
        onEvent({ type: "token", text: "Første setning er her. " });
        onEvent({ type: "token", text: "Andre setning er her. " });
        onEvent({ type: "token", text: "Tredje setning er her. " });
        onEvent({ type: "token", text: "Fjerde setning er her." });
        return { reply: "x", routed: "model", session_id: "s" };
      }
    };
    const session = new VoiceSession(identity, core, spyStt("hei").adapter, tts.adapter, ev);
    let t = 1000;
    session.pushAudio(speech(), t);
    session.pushAudio(silence(), (t += 800));
    const andre = "Andre setning er her.";
    const forste = "Første setning er her.";
    await vi.waitFor(() => { expect(tts.startedAt.has(andre)).toBe(true); }, { interval: 2, timeout: 3000 });
    // Forhåndshentet: «Andre» startet mens «Første» fortsatt spilte.
    const forsteFinished = tts.finishedAt.get(forste);
    expect(forsteFinished === undefined || tts.startedAt.get(andre)! < forsteFinished).toBe(true);
    // Barge-in: ingen NY chunk startes etterpå, og alt som var i gang (spillende + forhåndshentet) kanselleres.
    const startedBefore = tts.started.length;
    session.pushAudio(speech(), (t += 50));
    await sleep(120);
    expect(tts.started.length).toBe(startedBefore);
    const inFlight = tts.started.filter((s) => !tts.finishedAt.has(s));
    expect(inFlight.length).toBeGreaterThanOrEqual(1);
    for (const s of inFlight) expect(tts.cancelled).toContain(s);
    expect(tts.started.some((s) => s.startsWith("Fjerde"))).toBe(false);
    // Rammene som faktisk ble sendt ut kom i rekkefølge (aldri «Andre» før «Første»).
    const order = ev.frames.map((f) => f.toString("utf8", 0, 8).replace(/\0/g, ""));
    const firstAndre = order.findIndex((s) => s.startsWith("Andre"));
    const lastForste = order.map((s) => s.startsWith("Første")).lastIndexOf(true);
    if (firstAndre !== -1) expect(lastForste).toBeLessThan(firstAndre);
  });
});

describe("fyllord og talt verktøystatus", () => {
  it("er modellen treg til første token, tales fyllordet FØR svaret - og aldri når svaret kommer raskt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const slowCore: CoreClient = {
      chat: async () => ({ reply: "", routed: "model", session_id: "s" }),
      chatStream: async (_i, _m, onEvent) => { await sleep(120); onEvent({ type: "token", text: "Du har ett møte i dag." }); return { reply: "x", routed: "model", session_id: "s" }; }
    };
    const slowTts = spyTts(1, 1);
    const metricsSeen: Array<Record<string, unknown>> = [];
    const session = new VoiceSession(identity, slowCore, spyStt("hei").adapter, slowTts.adapter, events({ onMetrics: (m) => { metricsSeen.push(m as unknown as Record<string, unknown>); } }), undefined, new EnergyVad(), undefined, undefined, undefined, undefined, "CLIENT_ASSERTED", { fillerMs: 40, fillerText: "Et øyeblikk." });
    session.pushAudio(speech(), 1000);
    session.pushAudio(silence(), 1800);
    await vi.waitFor(() => { expect(metricsSeen.length).toBe(1); });
    expect(slowTts.synthesized[0]).toBe("Et øyeblikk.");
    expect(slowTts.synthesized[1]).toMatch(/^Du har ett møte/);
    expect(metricsSeen[0]!["filler_spoken"]).toBe(true);

    const fastCore: CoreClient = {
      chat: async () => ({ reply: "", routed: "model", session_id: "s" }),
      chatStream: async (_i, _m, onEvent) => { onEvent({ type: "token", text: "Raskt svar." }); return { reply: "x", routed: "model", session_id: "s" }; }
    };
    const fastTts = spyTts(1, 1);
    const fastMetrics: Array<Record<string, unknown>> = [];
    const fast = new VoiceSession(identity, fastCore, spyStt("hei").adapter, fastTts.adapter, events({ onMetrics: (m) => { fastMetrics.push(m as unknown as Record<string, unknown>); } }), undefined, new EnergyVad(), undefined, undefined, undefined, undefined, "CLIENT_ASSERTED", { fillerMs: 40 });
    fast.pushAudio(speech(), 1000);
    fast.pushAudio(silence(), 1800);
    await vi.waitFor(() => { expect(fastMetrics.length).toBe(1); });
    await sleep(60);
    expect(fastTts.synthesized).toEqual(["Raskt svar."]);
    expect(fastMetrics[0]!["filler_spoken"]).toBeUndefined();
  });

  it("verktøystatusen tales (første verktøy per tur) kun når speakToolActivity er på, og alltid før svaret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const core: CoreClient = {
      chat: async () => ({ reply: "", routed: "model", session_id: "s" }),
      chatStream: async (_i, _m, onEvent: (e: CoreStreamEvent) => void) => {
        onEvent({ type: "tool", tool_name: "home-assistant__list_states" });
        onEvent({ type: "tool", tool_name: "calendar__list_events" });
        onEvent({ type: "token", text: "Lyset i stua er på." });
        return { reply: "x", routed: "model", session_id: "s" };
      }
    };
    const on = spyTts(1, 1);
    const evOn = events();
    const s1 = new VoiceSession(identity, core, spyStt("hei").adapter, on.adapter, evOn, undefined, new EnergyVad(), undefined, undefined, undefined, undefined, "CLIENT_ASSERTED", { speakToolActivity: true });
    s1.pushAudio(speech(), 1000);
    s1.pushAudio(silence(), 1800);
    await vi.waitFor(() => { expect(on.synthesized.length).toBe(2); });
    expect(on.synthesized[0]).toBe("Sjekker hjemmet …");
    expect(on.synthesized[1]).toBe("Lyset i stua er på.");
    expect(evOn.activity).toEqual(["Sjekker hjemmet …", "Sjekker kalenderen din …"]);

    const off = spyTts(1, 1);
    const s2 = new VoiceSession(identity, core, spyStt("hei").adapter, off.adapter, events());
    s2.pushAudio(speech(), 1000);
    s2.pushAudio(silence(), 1800);
    await vi.waitFor(() => { expect(off.synthesized.length).toBe(1); });
    expect(off.synthesized).toEqual(["Lyset i stua er på."]);
  });

  it("verktøystatus-tekster dekker de nye tjenestene", () => {
    expect(toolActivityText("home-assistant__read_state")).toBe("Sjekker hjemmet …");
    expect(toolActivityText("vercel__list_projects")).toBe("Sjekker driften …");
    expect(toolActivityText("sentry__list_issues")).toBe("Sjekker systemene …");
    expect(toolActivityText("contract__upcoming_renewals")).toBe("Slår opp i registeret …");
    expect(toolActivityText("ukjent__x")).toBe("Jobber med saken …");
  });
});

describe("JARVIS-079: ingen zombie-tur etter frakobling", () => {
  it("fullfører STT etter at klienten koblet fra, når Core ALDRI (ingen verktøy for en død socket)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let coreCalls = 0;
    const core: CoreClient = { chat: async () => { coreCalls += 1; return { reply: "x", routed: "model", session_id: "s" }; } };
    const stt = spyStt("hei", { endDelayMs: 60 });
    const session = new VoiceSession(identity, core, stt.adapter, new FakeTts(1), events());
    session.pushAudio(speech(), 1000);
    session.pushAudio(silence(), 1800); // end_of_turn → stt.end() tar 60 ms
    session.disconnect();
    await sleep(120);
    expect(coreCalls).toBe(0);
  });
});

describe("samplerate per TTS-adapter og whisper-argumenter", () => {
  it("OpenAI 24 000, ElevenLabs/Fake 16 000, piper fra env (standard 22 050)", () => {
    expect(new OpenAiTts("k").sampleRate).toBe(24_000);
    expect(new FakeTts().sampleRate).toBe(16_000);
    expect(new LocalPiperTts("/bin/x", "/m.onnx").sampleRate).toBe(22_050);
    expect(new LocalPiperTts("/bin/x", "/m.onnx", 16_000).sampleRate).toBe(16_000);
  });

  it("whisper-cli får -t <tråder> (1-8) og --prompt kun når satt; de gamle flaggene er uendret", () => {
    const plain = new LocalWhisperStt("/bin/w", "/m.bin", 16_000, "no", 4, undefined);
    expect(plain.cliArgs("/tmp/out")).toEqual(["-m", "/m.bin", "-f", "-", "-nt", "-otxt", "-of", "/tmp/out", "-nth", "1.01", "-l", "no", "-t", "4"]);
    const prompted = new LocalWhisperStt("/bin/w", "/m.bin", 16_000, "no", 6, "  Samtale på norsk.  ");
    expect(prompted.cliArgs("/tmp/out").slice(-4)).toEqual(["-t", "6", "--prompt", "Samtale på norsk."]);
    const auto = new LocalWhisperStt("/bin/w", "/m.bin");
    const t = Number(auto.cliArgs("/x")[13]);
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(8);
  });
});

describe("norsk TTS-normalisering (tydelig svar)", () => {
  it("forkortelser, prosent, kroner, klokkeslett med kolon, URL-er og emoji", () => {
    expect(normalizeForNorwegianSpeech("Det koster ca. 200 kr, dvs. 20% mer.")).toBe("Det koster cirka 200 kroner, det vil si 20 prosent mer.");
    expect(normalizeForNorwegianSpeech("Møtet er kl. 18:30, f.eks. på Teams 😀")).toBe("Møtet er klokka 18.30, for eksempel på Teams ");
    expect(normalizeForNorwegianSpeech("Se https://example.com/x?y=1 for mer.")).toBe("Se  for mer.");
    expect(normalizeForNorwegianSpeech("Budsjettet er 2 mill. kroner og 1,5 mrd. totalt.")).toBe("Budsjettet er 2 millioner kroner og 1,5 milliarder totalt.");
  });

  it("går gjennom sanitizeForSpeech() og ødelegger ikke D-353-garantiene", () => {
    expect(sanitizeForSpeech("**Møte** kl. 09:15 - ca. 30% ferdig. Se https://a.b/c 🎉")).toBe("Møte klokka 09.15 - cirka 30 prosent ferdig. Se");
    expect(sanitizeForSpeech("Møtet er klokka 18.30 i morgen.")).toBe("Møtet er klokka 18.30 i morgen.");
    expect(sanitizeForSpeech("Forholdet 3:1 og tiden 25:10 røres ikke.")).toBe("Forholdet 3:1 og tiden 25:10 røres ikke.");
  });
});
