/**
 * D-353 (Tobias direkte i chat, live bruk: "den leser opp tegn ... den sier
 * bla bla bla så stjerne stjerne punktum" - TTS-en leste Markdown-syntaks
 * (`**fet**`, lister, kodeblokker) bokstavelig i stedet for naturlig tale).
 * Root cause (kildekode-lest, ikke gjettet): `session.ts` sin `enqueueTts()`
 * sendte hver chunk fra `SentenceChunker` RÅTT til `ttsAdapter.synthesize()`
 * - INGEN sanering fantes noe sted i kjeden (samme `/chat`-tekst deles
 * ordrett mellom tekst-UI og tale, `conversation.ts`, så modellen skriver
 * normal Markdown uten å vite at DENNE mottakeren skal HØRE teksten, ikke
 * lese den). Denne funksjonen er det ENE, sentrale sanerings-punktet - kalt
 * FØR hver chunk når TTS-køen (`enqueueTts()`), beskytter derfor ALLE
 * TTS-adaptere (OpenAI/ElevenLabs/lokal Piper) automatisk, uansett fremtidig
 * valg. Ren, deterministisk streng-transformasjon - ingen nettverksavhengighet,
 * ingen modellkall.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text;

  // Kodeblokk-gjerder (```lang / ```) - fjernes helt, beholder innholdet.
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, "");
  // Inline kode (`kode`) -> kun innholdet.
  out = out.replace(/`([^`]+)`/g, "$1");

  // Markdown-lenker [tekst](url) -> kun teksten.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Fet skrift (**tekst**/__tekst__) -> kun teksten. FØR kursiv, ellers
  // ville en enkelt `*` fra kursiv-regexen spist halve **-paret.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  // Kursiv med stjerne (*tekst*) -> kun teksten. Enkelt understrek (_tekst_)
  // saneres BEVISST IKKE - for høy risiko for å ødelegge ekte innhold med
  // understrek (snake_case, filnavn, variabelnavn nevnt i svaret).
  out = out.replace(/\*([^*]+)\*/g, "$1");

  // Linjestart-markører: overskrifter (#/##/...), punktlister (-/*/+ ),
  // nummererte lister (1. 2. ...) - fjernes, innholdet beholdes.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  out = out.replace(/^[ \t]*\d+\.[ \t]+/gm, "");

  // Siste sikkerhetsnett: enhver gjenværende stjerne/backtick (f.eks. et
  // upar t **-tegn som overlevde chunk-grensen) fjernes helt - disse skal
  // ALDRI uttales, uansett hvilket mønster som eventuelt ikke ble fanget over.
  out = out.replace(/[*`]/g, "");

  // D-390 («tydelig svar»): det TTS-en leser dårlig eller bokstavelig, normaliseres til hele norske ord FØR syntese.
  out = normalizeForNorwegianSpeech(out);

  // Slå sammen whitespace som tegnfjerningen kan ha etterlatt.
  out = out.replace(/[ \t]{2,}/g, " ").trim();

  return out;
}

/** Forkortelser som leses opp som bokstaver/«punktum» av TTS - utvides til hele ord (kun med ordgrense, aldri inne i ord). */
const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bf\.eks\./gi, "for eksempel"],
  [/\bbl\.a\./gi, "blant annet"],
  [/\bosv\./gi, "og så videre"],
  [/\bdvs\./gi, "det vil si"],
  [/\bca\.\s*(?=\d)/gi, "cirka "],
  [/\bkl\.\s*(?=\d)/gi, "klokka "],
  [/\bnr\.\s*(?=\d)/gi, "nummer "],
  [/\btlf\.?\s*(?=\d|:)/gi, "telefon "],
  [/\bmill\.\s*/gi, "millioner "],
  [/\bmrd\.\s*/gi, "milliarder "],
  [/\bmvh\b\.?/gi, "med vennlig hilsen"]
];

/**
 * D-390: TTS-vennlig norsk - URL-er og emoji fjernes (leses ellers tegn for tegn / som «smilende ansikt»), prosent/valuta/
 * forkortelser blir ord, og klokkeslett med kolon får punktum («18:30» → «18.30», som piper/OpenAI leser som tid).
 * Bevisst smalt: tall, datoer og vanlige ord røres ikke (D-353-testen «18.30 skal forbli 18.30» holder).
 */
export function normalizeForNorwegianSpeech(text: string): string {
  let out = text;
  // URL-er: en opplest adresse er støy - «se lenken» er ikke bedre, så den fjernes helt.
  out = out.replace(/https?:\/\/\S+/gi, "");
  out = out.replace(/\bwww\.\S+/gi, "");
  // Emoji (inkl. modifikatorer/sammenføyere) - aldri uttalt.
  out = out.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");
  // Prosent og valuta etter tall.
  out = out.replace(/(\d)\s*%/g, "$1 prosent");
  out = out.replace(/(\d)\s*(?:kr|NOK)\b\.?/g, "$1 kroner");
  out = out.replace(/(\d)\s*€/g, "$1 euro");
  out = out.replace(/€\s*(\d)/g, "$1 euro");
  out = out.replace(/\$\s*(\d[\d\s.,]*)/g, "$1 dollar");
  // Klokkeslett «18:30» → «18.30» (men ikke forhold/tidsangivelser som 1:2 eller mm:ss over 24 timer).
  out = out.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, "$1.$2");
  for (const [re, word] of ABBREVIATIONS) out = out.replace(re, word);
  return out;
}
