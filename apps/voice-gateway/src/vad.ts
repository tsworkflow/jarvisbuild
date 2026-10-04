import { rmsEnergy } from "./audio.ts";

export type VadEvent = "speech_start" | "speech" | "silence" | "end_of_turn";

export interface VadAdapter {
  /** Mater én ramme; returnerer hendelsen rammen utløser. */
  push(frame: Buffer, atMs: number): VadEvent;
  reset(): void;
}

/** D-390: valgfri adaptiv terskel (støygulv) + maksimal turlengde. */
export interface EnergyVadOptions {
  /**
   * Adaptiv terskel: følger rommets støygulv (EMA over stille rammer) i stedet for én fast verdi. I et stille rom senkes terskelen
   * (hører svak/fjern tale og avbrudd under TTS), i et støyende rom heves den (færre falske turer). Terskelen beveger seg kun
   * innenfor [`minThreshold`, `maxThreshold`] og starter nøyaktig på `threshold` - uten endring er oppførselen identisk med før.
   */
  adaptive?: boolean;
  /** Laveste effektive terskel i adaptiv modus (standard 0.012 - ~4x mer følsom enn 0.05). */
  minThreshold?: number;
  /** Høyeste effektive terskel i adaptiv modus (standard 2x `threshold`). */
  maxThreshold?: number;
  /** Effektiv terskel = støygulv x denne faktoren (standard 3). */
  noiseRatio?: number;
  /** EMA-vekt per stille ramme (standard 0.05 ≈ 1-2 s tidskonstant ved 64 ms-rammer). */
  alpha?: number;
  /**
   * Maksimal sammenhengende tur (standard 30 000 ms): en tur som aldri får stillhet (vedvarende støy over terskelen, en
   * sammenhengende monolog) tvinges til `end_of_turn`, så STT-en aldri får en uendelig WAV og en støyende endring i rommet aldri
   * låser sesjonen i «speech». I adaptiv modus settes støygulvet til den observerte energien samtidig.
   */
  maxTurnMs?: number;
}

/**
 * Deterministisk energi-VAD (lokal, ingen nettverk - VOICE_ARCHITECTURE §3).
 * end_of_turn utløses etter `hangoverMs` sammenhengende stillhet etter tale.
 * Byttes mot Silero-klasse modell bak samme grensesnitt når det trengs.
 *
 * D-275 (Tobias direkte live-test, ETTER at D-274 kildekode-verifiserte HVER
 * lag nedstrøms for VAD-en som korrekt - WAV-header/stdin/modell/NAS-miljø):
 * bedt om å si ÉN sammenhengende, 4-5 sekunders norsk setning ga en logg som
 * viste RASK, GJENTATT `speech_start`/`end_of_turn`-VEKSLING flere ganger i
 * sekundet gjennom HELE ytringen, i stedet for ÉN sammenhengende tur - kun
 * korte 0,5-2,3 sekunders fragmenter ble noensinne fanget, ALDRI hele
 * setningen. Rotårsak: klienten sender ~256ms lydrammer
 * (`ScriptProcessorNode(4096, ...)` @ 16kHz i `voice.html`), mens den
 * FORRIGE `hangoverMs`-verdien (300) var kun ~1,17 rammer - enhver naturlig,
 * kortvarig energidipp MELLOM ord (en stille konsonant, en pause for pust,
 * en stavelsesgrense) er nok til å utløse `end_of_turn` FØR setningen
 * faktisk er ferdig, og splitter én sammenhengende ytring i mange spredte
 * fragmenter som individuelt mangler nok sammenhengende fonetisk innhold for
 * whisper.cpp å feste seg på - PRESIST samme symptomklasse (ekte
 * dekodingsarbeid, konsekvent tomt resultat) som HELE D-262→D-274-serien
 * observerte, nå funnet i et lag FØR selve STT-en i stedet for i den.
 * **Fiks:** `hangoverMs` økt fra 300 til 700 - trygt over typisk
 * mellomords-pause (vanligvis 50-250ms) og godt over flere rammers
 * energidipp, uten merkbar ekstra ventetid før et FAKTISK avsluttet svar
 * sendes til STT-en. `threshold` UENDRET (0,05 - ingen bevis i loggen for at
 * selve terskelnivået, i motsetning til hangover-varigheten, var problemet).
 * Se D-275 i DECISIONS_AND_ASSUMPTIONS.md.
 *
 * D-390 (Tobias: «hører meg bra»): valgfri ADAPTIV terskel - D-353 fant at det mest sannsynlige hinderet for både «hører meg
 * dårlig» og manglende avbrudd var at én fast terskel ikke passer alle rom/mikrofoner. Støygulvet måles kontinuerlig fra stille
 * rammer; effektiv terskel = gulv x `noiseRatio`, klemt til [min, max]. Klienten sender nå 64 ms-rammer (D-390, `voice.html`),
 * så `hangoverMs` 700 er ~11 rammer - rikelig margin. `maxTurnMs` hindrer at en tur aldri slutter.
 */
export class EnergyVad implements VadAdapter {
  private speaking = false;
  private lastSpeechAt = 0;
  private speechStartedAt = 0;
  private noiseFloor: number;
  private readonly adaptive: boolean;
  private readonly minThreshold: number;
  private readonly maxThreshold: number;
  private readonly noiseRatio: number;
  private readonly alpha: number;
  private readonly maxTurnMs: number;

  constructor(
    private readonly threshold = 0.05,
    private readonly hangoverMs = 700,
    options: EnergyVadOptions = {}
  ) {
    this.adaptive = options.adaptive ?? false;
    this.noiseRatio = options.noiseRatio ?? 3;
    this.minThreshold = options.minThreshold ?? 0.012;
    this.maxThreshold = options.maxThreshold ?? threshold * 2;
    this.alpha = options.alpha ?? 0.05;
    this.maxTurnMs = options.maxTurnMs ?? 30_000;
    // Starter nøyaktig på den konfigurerte terskelen - ingen atferdsendring før rommet faktisk er målt.
    this.noiseFloor = threshold / this.noiseRatio;
  }

  /** Terskelen som gjelder akkurat nå (fast, eller adaptiv innenfor [min, max]). Observerbar for logg/tester. */
  effectiveThreshold(): number {
    if (!this.adaptive) return this.threshold;
    return Math.min(this.maxThreshold, Math.max(this.minThreshold, this.noiseFloor * this.noiseRatio));
  }

  /** Målt støygulv (RMS) - kun informativt. */
  currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  push(frame: Buffer, atMs: number): VadEvent {
    const energy = rmsEnergy(frame);
    const threshold = this.effectiveThreshold();
    if (energy >= threshold) {
      const wasSpeaking = this.speaking;
      if (!wasSpeaking) this.speechStartedAt = atMs;
      // D-390: en tur som aldri får stillhet avsluttes tvungent - og i adaptiv modus regnes energien som nytt støygulv.
      if (wasSpeaking && atMs - this.speechStartedAt >= this.maxTurnMs) {
        this.speaking = false;
        if (this.adaptive) this.noiseFloor = energy;
        return "end_of_turn";
      }
      this.speaking = true;
      this.lastSpeechAt = atMs;
      return wasSpeaking ? "speech" : "speech_start";
    }
    if (this.adaptive && !this.speaking) {
      this.noiseFloor = this.noiseFloor * (1 - this.alpha) + energy * this.alpha;
    }
    if (this.speaking && atMs - this.lastSpeechAt >= this.hangoverMs) {
      this.speaking = false;
      return "end_of_turn";
    }
    return "silence";
  }

  reset(): void {
    this.speaking = false;
    this.lastSpeechAt = 0;
    this.speechStartedAt = 0;
    this.noiseFloor = this.threshold / this.noiseRatio;
  }
}
