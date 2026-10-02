import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-212 (task #120): `server.ts` er et top-level side-effekt-skript sammen
 * med resten av API-appen - `main.ts` kan derfor IKKE trygt importeres
 * direkte i en testfil (samme presedens som `executive-query-wiring.test.ts`).
 * Denne suiten verifiserer KUN den statiske serveringen av `voice.html` under
 * `GET /voice` - selve talestrømmen går IKKE via denne prosessen (egen
 * voice-gateway-prosess, CLAUDE.md ufravikelig regel 5), og dekkes derfor av
 * `apps/voice-gateway/test/`, ikke her.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const serverSource = readSource("../src/server.ts");

describe("A: GET /voice serverer apps/web/voice.html, samme mønster som GET /dashboard", () => {
  it("WEB_VOICE peker på apps/web/voice.html", () => {
    expect(serverSource).toMatch(
      /const WEB_VOICE = fileURLToPath\(new URL\("\.\.\/\.\.\/web\/voice\.html", import\.meta\.url\)\);/
    );
  });

  it('ruten sjekker GET og url.pathname === "/voice" FØR den leser WEB_VOICE', () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/voice"');
    expect(routeIdx).toBeGreaterThan(-1);
    const readIdx = serverSource.indexOf("sendStaticPage(res, WEB_VOICE", routeIdx);
    expect(readIdx).toBeGreaterThan(routeIdx);
  });

  it("svarer med text/html; charset=utf-8, samme som WEB_INDEX/WEB_DASHBOARD-rutene", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/voice"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("return;", routeIdx));
    // Remediering del 2: headerne settes nå sentralt i `staticPageHeaders()` (CSP/nonce/rammebeskyttelse) for ALLE sider.
    expect(block).toContain("sendStaticPage(");
    expect(serverSource).toContain('"content-type": "text/html; charset=utf-8"');
  });
});

describe("B: voice.html gjenbruker SAMME enhetsnøkkel-/grant-mekanisme som dashboard.html - ingen ny autentisering oppfunnet", () => {
  const voiceHtml = readSource("../../web/voice.html");
  const dashboardHtml = readSource("../../web/dashboard.html");

  it("bruker samme /devices/challenge + /devices/register-ruter som dashboard.html", () => {
    expect(voiceHtml).toContain('fetch("/devices/challenge"');
    expect(voiceHtml).toContain('fetch("/devices/register"');
  });

  it("bruker SAMME localStorage-nøkkel for enhetsnøkkel som dashboard.html (samme fysiske enhet)", () => {
    expect(voiceHtml).toContain('localStorage.getItem("jarvis.devicekey")');
    expect(dashboardHtml).toContain('localStorage.getItem("jarvis.devicekey")');
  });

  it("device_proof sendes som {challenge, signature} inn i WS start-meldingen, ikke en oppfunnet form", () => {
    expect(voiceHtml).toMatch(/device_proof:\s*\{\s*challenge,\s*signature\s*\}/);
  });

  it("Q-32/processor_terms_status-blokkeringen forklares ÆRLIG for speech_routing_denied_stt/tts, aldri skjules", () => {
    expect(voiceHtml).toContain("speech_routing_denied_stt:");
    expect(voiceHtml).toContain("speech_routing_denied_tts:");
    expect(voiceHtml).toContain("Q-32");
    expect(voiceHtml).not.toMatch(/processor_terms_status\s*=\s*["']VERIFIED["']/);
  });
});

describe("D-259: transcriptEl tømmes ved HVERT 'Start samtale'-klikk - ingen stille sammenblanding av flere test-/bruksøkter i én nettleserfane", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("startConversation() tømmer transcript-panelet FØR mikrofontilgang/WebSocket-oppkobling", () => {
    const fnIdx = voiceHtml.indexOf("async function startConversation()");
    expect(fnIdx).toBeGreaterThan(-1);
    const clearIdx = voiceHtml.indexOf('transcriptEl.innerHTML = \'<p class="empty">Ingen samtale ennå.</p>\';', fnIdx);
    const micIdx = voiceHtml.indexOf("getUserMedia", fnIdx);
    expect(clearIdx).toBeGreaterThan(fnIdx);
    expect(clearIdx).toBeLessThan(micIdx);
  });
});

describe("D-260: innrullering fungerer UTEN manuell kopiering av billett-strengen (?enroll=-URL, automatisk innrullering)", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("tryAutoEnrollFromUrl() leser billetten fra ?enroll= - IKKE fra skjemafeltet", () => {
    expect(voiceHtml).toContain("function tryAutoEnrollFromUrl()");
    expect(voiceHtml).toMatch(/new URLSearchParams\(location\.search\)\.get\("enroll"\)/);
  });

  it("fjerner billetten fra adresselinjen (history.replaceState) FØR selve innrulleringsforsøket - en engangsbillett skal aldri stå igjen synlig eller kunne gjenbrukes ved refresh", () => {
    const fnIdx = voiceHtml.indexOf("function tryAutoEnrollFromUrl()");
    expect(fnIdx).toBeGreaterThan(-1);
    const replaceIdx = voiceHtml.indexOf("history.replaceState(", fnIdx);
    const submitIdx = voiceHtml.indexOf("submitEnrollment(ticket)", fnIdx);
    expect(replaceIdx).toBeGreaterThan(fnIdx);
    expect(replaceIdx).toBeLessThan(submitIdx);
  });

  it("tryAutoEnrollFromUrl() faktisk kalles ved sidelasting (ikke bare definert, aldri påkalt)", () => {
    expect(voiceHtml).toMatch(/\n\s*tryAutoEnrollFromUrl\(\);\s*\n/);
  });

  it("det manuelle skjemaet (enrollForm) og auto-innrulleringen deler SAMME submitEnrollment()-logikk - ingen duplisert/avvikende innrulleringssti", () => {
    const formHandlerIdx = voiceHtml.indexOf('enrollForm.addEventListener("submit"');
    expect(formHandlerIdx).toBeGreaterThan(-1);
    const formBlockEnd = voiceHtml.indexOf("});", formHandlerIdx);
    const formBlock = voiceHtml.slice(formHandlerIdx, formBlockEnd);
    expect(formBlock).toContain("submitEnrollment(ticket)");
  });
});

describe("D-265: mikrofonopptak ber nettleseren resample til 16 kHz DIREKTE i AudioContext-konstruktøren, ikke bare i vår egen hånd-rullede interpolasjon", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("startMicCapture() oppretter captureCtx med { sampleRate: 16000 } - live NAS-funn (D-263/D-264): whisper.cpp brukte ekte encode-tid på opptil 1,6s reell tale-energi og produserte likevel konsekvent null tokens, uten no-speech-advarsel - typisk for anti-alias-forvrengning fra REN lineær interpolasjon ned fra 44,1/48 kHz, som EnergyVad (kun energibasert) ikke fanger opp", () => {
    const fnIdx = voiceHtml.indexOf("function startMicCapture()");
    expect(fnIdx).toBeGreaterThan(-1);
    const ctxIdx = voiceHtml.indexOf("captureCtx = new AudioContext(", fnIdx);
    expect(ctxIdx).toBeGreaterThan(fnIdx);
    const ctxLine = voiceHtml.slice(ctxIdx, voiceHtml.indexOf(";", ctxIdx));
    expect(ctxLine).toContain("{ sampleRate: 16000 }");
  });

  it("downsampleTo16kMono() beholdes som forsvarsnett (inRate === 16000 tidligretur) for nettlesere som ignorerer sampleRate-hintet, IKKE fjernet", () => {
    expect(voiceHtml).toContain("function downsampleTo16kMono(float32, inRate) {");
    expect(voiceHtml).toMatch(/if \(inRate === 16000\) return float32;/);
  });
});

describe("D-269: den FAKTISK forhandlede captureCtx.sampleRate logges synlig - AudioContext-konstruktøren garanterer ALDRI at { sampleRate: 16000 } faktisk innvilges", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("startMicCapture() kaller techLog() med captureCtx.sampleRate RETT ETTER at captureCtx opprettes, FØR MediaStreamSource kobles til", () => {
    const fnIdx = voiceHtml.indexOf("function startMicCapture()");
    expect(fnIdx).toBeGreaterThan(-1);
    const ctxIdx = voiceHtml.indexOf("captureCtx = new AudioContext(", fnIdx);
    const logIdx = voiceHtml.indexOf("techLog(\"mic captureCtx.sampleRate", fnIdx);
    const sourceIdx = voiceHtml.indexOf("createMediaStreamSource(micStream)", fnIdx);
    expect(logIdx).toBeGreaterThan(ctxIdx);
    expect(logIdx).toBeLessThan(sourceIdx);
  });

  it("logglinja skiller eksplisitt mellom OK (nøyaktig 16000) og AVVIK (nettleseren koerset til en annen rate, interpolasjons-forsvarsnettet er aktivt)", () => {
    expect(voiceHtml).toContain("AVVIK - nettleseren ignorerte 16000-hintet");
    expect(voiceHtml).toContain("OK - direkte 16kHz, ingen interpolasjon");
  });
});

describe("D-276: noiseSuppression deaktivert i getUserMedia - isolert diagnostikk-variabel etter at D-274/D-275 utelukket resten av kjeden", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("getUserMedia ber om echoCancellation+autoGainControl UENDRET (D-249), men noiseSuppression: false (D-276)", () => {
    expect(voiceHtml).toMatch(
      /audio:\s*\{\s*echoCancellation:\s*true,\s*noiseSuppression:\s*false,\s*autoGainControl:\s*true\s*\}/
    );
  });

  it("noiseSuppression: true forekommer IKKE lenger noe sted i getUserMedia-konstruktøren", () => {
    expect(voiceHtml).not.toMatch(/noiseSuppression:\s*true/);
  });
});
