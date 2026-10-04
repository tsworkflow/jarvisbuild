/**
 * Del 3 (JARVIS-016/035): deterministisk innholdsbasert sensitivitet. Erstatter det hardkodede «PUBLIC_OR_LOW_SENSITIVITY» for alt innhold.
 * Regelen er FAIL-CLOSED og streng: det strengeste signalet vinner, og helse/finans/hemmeligheter krever LOKAL behandler
 * (`SECRET_RESTRICTED` ⇒ `isSensitivityEligible` slipper kun `locality === "local"`). Privat/forretningsminne og verktøyresultater fra
 * private kilder ekskluderer gratis-/delt sky (`hosted_free_tier`). Kun innhold uten noen slike signaler er `PUBLIC_OR_LOW_SENSITIVITY`.
 *
 * Dette er mønster-/metadatabasert og IKKE en garanti for at ingen sensitiv tekst noen gang når en delt tjeneste: ukjente formater og
 * indirekte omtaler kan slippe gjennom. Det som er garantert er at KJENTE kategorier (se testene) aldri rutes til gratis/delt sky.
 */
import type { DataSensitivity } from "@jarvis/contracts";
import { containsSecret } from "@jarvis/core";

const RANK: Readonly<Record<DataSensitivity, number>> = {
  PUBLIC_OR_LOW_SENSITIVITY: 0,
  PRIVATE: 1,
  BUSINESS_CONFIDENTIAL: 2,
  SECRET_RESTRICTED: 3
};

export function maxSensitivity(...values: Array<DataSensitivity | undefined>): DataSensitivity {
  let best: DataSensitivity = "PUBLIC_OR_LOW_SENSITIVITY";
  for (const v of values) if (v !== undefined && RANK[v] > RANK[best]) best = v;
  return best;
}

const HEALTH =
  /\b(diagnose[a-zæøå]*|sykdom[a-zæøå]*|sykemelding[a-zæøå]*|medisin[a-zæøå]*|resept[a-zæøå]*|legetime|fastlege|lege\b|sykehus[a-zæøå]*|blodprøve[a-zæøå]*|psykolog[a-zæøå]*|psykisk[a-zæøå]*|depresjon[a-zæøå]*|angst\b|symptom[a-zæøå]*|allergi[a-zæøå]*|graviditet[a-zæøå]*|kreft\b|helseopplysning[a-zæøå]*|diabetes|blodtrykk|medication|diagnosis|prescription|therapy|therapist|medical)\b/i;
const FINANCE_STRONG =
  /\b(?:[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}|\d{4}[ .]?\d{2}[ .]?\d{5}|(?:kontonummer|iban|bic|cvv|kortnummer|bankid|saldo|skattemelding|skatteoppgjør|lønnsslipp|lønn|gjeld|lån|formue|inntekt|fødselsnummer|personnummer|salary|mortgage|tax return|bank account)[a-zæøå]*)(?![a-zæøå])/i;
const FINANCE_WEAK = /\b(faktura[a-zæøå]*|regning[a-zæøå]*|betaling[a-zæøå]*|utbetaling|bank\b|budsjett[a-zæøå]*|kredittkort|vipps|stripe|refusjon|invoice|payment)\b/i;
const BUSINESS = /\b(kontrakt[a-zæøå]*|kunde[a-zæøå]*|tilbud[a-zæøå]*|omsetning[a-zæøå]*|avtale[a-zæøå]*|styrereferat|oppkjøp|konkurranse|forretningshemmelighet|nda\b|confidential|konfidensiell)\b/i;
const PRIVATE_HINT = /\b(passord|adresse|telefonnummer|mobilnummer|kjæreste|samboer|ektefelle|barna mine|skilsmisse|private?)\b/i;

export interface SensitivityInput {
  /** Fritekst som skal til modellen (brukermelding, historikk, vedlegg, dokumentutdrag). */
  texts?: ReadonlyArray<string>;
  /** Minnerom elementene i konteksten kommer fra (`health`, `personal`, `business` ...). Tomt = ingen minne i konteksten. */
  memory_spaces?: ReadonlyArray<string>;
  /** `sensitivity`-kolonnen på minneelementene (`normal`/`sensitive`/`special`). */
  memory_sensitivities?: ReadonlyArray<string>;
  /** Verktøyoutput fra private kilder (e-post, kalender, filer) inngår i modellkonteksten. */
  private_tool_output?: boolean;
}

export interface SensitivityDecision {
  sensitivity: DataSensitivity;
  reasons: string[];
}

export function classifyContentSensitivity(input: SensitivityInput): SensitivityDecision {
  const reasons: string[] = [];
  let level: DataSensitivity = "PUBLIC_OR_LOW_SENSITIVITY";
  const raise = (to: DataSensitivity, reason: string): void => {
    level = maxSensitivity(level, to);
    reasons.push(reason);
  };
  for (const space of input.memory_spaces ?? []) {
    if (space === "health") raise("SECRET_RESTRICTED", "memory_space:health");
    else if (space === "business" || space === "project") raise("BUSINESS_CONFIDENTIAL", `memory_space:${space}`);
    else if (space === "personal" || space === "home") raise("PRIVATE", `memory_space:${space}`);
    else raise("PRIVATE", `memory_space:${space}`); // guest/shared/ukjent: fail-closed, aldri «public» fra minne
  }
  for (const s of input.memory_sensitivities ?? []) {
    if (s === "special") raise("SECRET_RESTRICTED", "memory_sensitivity:special");
    else if (s === "sensitive") raise("PRIVATE", "memory_sensitivity:sensitive");
  }
  if (input.private_tool_output) raise("PRIVATE", "private_tool_output");
  for (const text of input.texts ?? []) {
    if (containsSecret(text)) raise("SECRET_RESTRICTED", "text:secret");
    if (HEALTH.test(text)) raise("SECRET_RESTRICTED", "text:health");
    if (FINANCE_STRONG.test(text)) raise("SECRET_RESTRICTED", "text:finance");
    else if (FINANCE_WEAK.test(text)) raise("PRIVATE", "text:finance_weak");
    if (BUSINESS.test(text)) raise("BUSINESS_CONFIDENTIAL", "text:business");
    if (PRIVATE_HINT.test(text)) raise("PRIVATE", "text:private");
  }
  return { sensitivity: level, reasons: [...new Set(reasons)] };
}

/** D-384: så mange av de SISTE historikkmeldingene regnes som «pågående samtale» (oppfølgingsspørsmål beholder konteksten). */
export const RECENT_HISTORY_WINDOW = 4;

/**
 * D-384: én gammel helse-/finansmelding skal ikke låse HELE resten av samtalen (opptil 20 meldinger) til lokal modell.
 * Meldinger i det nylige vinduet beholdes alltid (og klassifiseres som før - et oppfølgingsspørsmål trenger konteksten). Eldre meldinger som
 * ALENE er strengere enn `ceiling` (nivået turen allerede har fra meldingen og det valgte minnet) holdes UTENFOR konteksten, så de aldri
 * sendes til en modell som ikke har lov til å se dem. Rekkefølgen på de som beholdes er uendret.
 */
export function partitionHistoryBySensitivity<T extends { content: string }>(
  history: ReadonlyArray<T>,
  ceiling: DataSensitivity,
  recentWindow: number = RECENT_HISTORY_WINDOW
): { kept: T[]; withheld: number } {
  const cutoff = Math.max(0, history.length - recentWindow);
  const kept: T[] = [];
  let withheld = 0;
  history.forEach((message, index) => {
    const alone = classifyContentSensitivity({ texts: [message.content] }).sensitivity;
    if (index < cutoff && RANK[alone] > RANK[ceiling]) {
      withheld += 1;
      return;
    }
    kept.push(message);
  });
  return { kept, withheld };
}
