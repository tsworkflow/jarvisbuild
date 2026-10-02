import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B: EKSPLISITT
 * git-transport-autentisering for `git clone`/`git push` mot `https://github.com/...`,
 * ALDRI avhengig av ambient vertsmaskin-tilstand. `ProcessSandboxRunner` gir
 * `git clone`/`git push` en REN prosess-env (kun PATH + git-identitet +
 * eksplisitt `jobEnv`) - INGEN `HOME`/`USERPROFILE`/`SSH_AUTH_SOCK` når gjennom.
 *
 * D-103 HOST-FIX v1 (2026-08-21, "d103-host-git-auth-isolation-repair", merget):
 * git sin credential-subsystem spør ALLTID konfigurerte `credential.helper`-
 * kjeder (system+global+repo, akkumulert) FØR `GIT_ASKPASS` konsulteres.
 * Fikset med `-c credential.helper=` (git sin egen "nullstill helper-kjeden
 * for AKKURAT dette kallet"-mekanisme, se `GIT_CREDENTIAL_ISOLATION_ARGS`
 * under - UENDRET av denne v2-reparasjonen, fortsatt korrekt og påkrevd).
 *
 * D-103 HOST-FIX v2 (2026-08-21, "d103-git-credential-helper-windows-repair"):
 * en ANNEN ekte Windows-kjøring (task d103-host-acceptance-d5294343, ETTER
 * v1 var merget til main) beviste v1s isolasjonsfiks FAKTISK VIRKET - INGEN
 * ambient identitet ("post-ops") dukket opp lenger - men selve v1-mekanismen
 * (et generert `GIT_ASKPASS`-skript, satt til en `.cmd`-batch-wrapper-fil på
 * Windows) feilet på et HELT NYTT sted: `cannot spawn
 * "...\jarvis-git-askpass-<x>\askpass.cmd": Permission denied`.
 *
 * ROOT CAUSE v2 (mest sannsynlig mekanisme, utledet fra dokumentert git/
 * Windows-oppførsel - se doc-kommentaren på `buildCredentialHelperConfigValue()`
 * for hvorfor DENNE reparasjonen strukturelt eliminerer usikkerheten i stedet
 * for å anta én bestemt forklaring): `GIT_ASKPASS` kalles av git via
 * `run_command()` med `use_shell=1`, men git sin `cmd_needs_shell()`-heuristikk
 * hopper over selve shell-innpakningen når kommandostrengen IKKE inneholder
 * shell-metategn (mellomrom, `|`, `&`, osv.) - en bar, uanførselstegnet
 * `.cmd`-filsti (slik v1s `buildAskpassEnvValue()` produserte på Windows)
 * kvalifiserer IKKE som "trenger shell", så git kaller `CreateProcessW()`
 * DIREKTE på `.cmd`-stien. `.cmd`/`.bat`-filer er IKKE gyldige Win32 PE-
 * kjørbare avbilder (ingen `MZ`-header) - `CreateProcessW()` kan STRUKTURELT
 * ikke laste dem direkte (kun `cmd.exe`/`ShellExecute` vet hvordan `.cmd`-
 * filer skal tolkes). Windows returnerer i dette tilfellet typisk
 * `ERROR_ACCESS_DENIED`, som MSYS-runtimen (Git for Windows sitt kjørings-
 * lag) oversetter til POSIX-errno `EACCES` - `strerror(EACCES)` = "Permission
 * denied", som SAMSVARER EKSAKT med den observerte feilteksten. Dette er en
 * STRUKTURELL Windows-prosess-oppstart-begrensning, IKKE en fil-tillatelse-
 * feil i vanlig forstand (ingen ACL/eierskap var faktisk feil).
 *
 * FIKS v2: erstatt `GIT_ASKPASS` HELT med git sin ALTERNATIVE, EKSPLISITT
 * shell-evaluerte credential-mekanisme: `credential.helper`. Se
 * `buildCredentialHelperConfigValue()` for hvorfor DENNE mekanismen ikke er
 * utsatt for samme feilklasse på NOEN plattform (POSIX ELLER Windows) - kort
 * fortalt: en `!`-prefikset `credential.helper`-verdi TVINGER git til å
 * evaluere den via en ekte shell (`sh -c`, MSYS sin medfølgende `sh.exe` på
 * Windows) - som launcher `node.exe` (en ekte, allerede installert Win32 PE-
 * binær) med skriptstien som ARGUMENT (aldri som selve prosess-avbildet) -
 * ALDRI en direkte `CreateProcess()` av vår genererte `.cjs`-fil. Denne
 * mekanismen krever INGEN plattform-betinget `.cmd`-wrapper-generering i det
 * hele tatt (fjernet - se historikk i git-loggen for v1s
 * `generateAskpassWindowsWrapper()`/`buildAskpassEnvValue()`), og er derfor
 * strukturelt enklere OG mer robust enn v1.
 */
export const GIT_CREDENTIAL_TOKEN_ENV = "JARVIS_GIT_CREDENTIAL_TOKEN";

/**
 * D-103 HOST-FIX v1 (uendret av v2): git-argv-prefiks som må stå FØRST i argv
 * (før subkommandoen `clone`/`push`) på AKKURAT de to nettverks-autentiserte
 * git-kallene, for å hindre en ambient `credential.helper` (Windows Git
 * Credential Manager, eller enhver annen system/global-konfigurert helper)
 * fra å svare FØR Jarvis sin egen helper (se `GIT_CREDENTIAL_HELPER_ARGS_KEY`
 * under) i det hele tatt konsulteres. `-c credential.helper=` er git sin
 * EGEN, dokumenterte "nullstill helper-kjeden for denne ene prosessen"-
 * mekanisme (git-config(1): en tom verdi nullstiller HELE den akkumulerte
 * helper-listen for AKKURAT dette kallet - `-c`/kommandolinje-config har
 * ALLTID høyest presedens, over system/global/repo-filer, uansett hva som
 * står i dem - muterer INGEN fil, inneholder INGEN hemmelighet).
 */
export const GIT_CREDENTIAL_ISOLATION_ARGS = ["-c", "credential.helper="] as const;

/**
 * D-103 HOST-FIX v2: ren, testbar innholdsgenerator for Jarvis sin ephemere
 * `git credential.helper`-implementasjon - ALDRI hemmeligheten selv, kun
 * logikken som leser den fra `process.env[GIT_CREDENTIAL_TOKEN_ENV]` ved
 * kjøretid. Implementerer git sin dokumenterte credential-helper-protokoll
 * (gitcredentials(7)): git kaller skriptet med ÉN argv-verdi (operasjonen -
 * "get", "store" eller "erase") og, for "get", skriver `protocol=`/`host=`/
 * ...-linjer på stdin (vi trenger IKKE parse disse - Jarvis sin credential
 * er den SAMME identiteten uansett protokoll/host, siden `-c credential.
 * helper=` allerede har nullstilt enhver ambient helper og denne prosessen
 * kun noensinne kjører git mot den ENE, eksplisitt oppgitte `repo_url`-en).
 * Stdin MÅ likevel drenes fullstendig (`resume()`) - ellers kan git sin side
 * av pipen feile med en "broken pipe"-relatert feil før den rekker å lese
 * stdout. For "store"/"erase" gjøres INGENTING (git forventer eksitkode 0 og
 * ingen stdout for disse - Jarvis sin credential skal ALDRI persisteres av
 * git selv, kun leves i denne ene prosessens `extraEnv`).
 */
export function generateCredentialHelperScriptContent(scope: GitCredentialScope): string {
  assertScope(scope);
  return [
    "#!/usr/bin/env node",
    // REMEDIERING DEL 2 (JARVIS-064): credential utleveres KUN til nøyaktig protokoll + vert + repo-sti.
    // Scopet er innebakt (JSON-literal fra validert input) - ikke lesbart/overstyrbart fra jobb-miljøet.
    `const SCOPE = ${JSON.stringify({ protocol: scope.protocol, host: scope.host.toLowerCase(), path: normalizeRepoPath(scope.path) })};`,
    "const operation = process.argv[2] || \"\";",
    "if (operation !== \"get\") {",
    "  process.stdin.resume();",
    "  process.stdin.on(\"end\", () => process.exit(0));",
    "  process.exit(0);",
    "}",
    "let input = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (chunk) => { input += chunk; });",
    "process.stdin.on(\"end\", () => {",
    "  const req = {};",
    "  for (const line of input.split(/\\r?\\n/)) {",
    "    const idx = line.indexOf(\"=\");",
    "    if (idx > 0) req[line.slice(0, idx)] = line.slice(idx + 1);",
    "  }",
    "  const path = String(req.path || \"\").replace(/^\\/+/, \"\").replace(/\\.git$/i, \"\").toLowerCase();",
    "  const ok = req.protocol === SCOPE.protocol",
    "    && String(req.host || \"\").toLowerCase() === SCOPE.host",
    "    && path === SCOPE.path",
    "    && !req.username_override;",
    "  if (!ok) process.exit(0); // ingen svar = ingen credential til fremmed vert/repo",
    `  const token = process.env[${JSON.stringify(GIT_CREDENTIAL_TOKEN_ENV)}] || "";`,
    "  if (!token) process.exit(0); // aldri et tomt passord - ingen credential er bedre enn en tom",
    "  process.stdout.write(\"username=x-access-token\\n\");",
    "  process.stdout.write(\"password=\" + token + \"\\n\");",
    "});",
    ""
  ].join("\n");
}

/**
 * REMEDIERING DEL 2 (JARVIS-064): hvem credentialen er gyldig mot. `host` er git sitt `host=`-felt (inkl. port når
 * den ikke er standard), `path` er `owner/repo` (uten `.git`). Credentialen utleveres ALDRI til noe annet.
 */
export interface GitCredentialScope {
  readonly protocol: "https" | "http";
  readonly host: string;
  readonly path: string;
}

/** Produksjonsscope: eksakt github.com over https + ett eksakt `owner/repo`. */
export function githubCredentialScope(repoSlug: string): GitCredentialScope {
  return { protocol: "https", host: "github.com", path: repoSlug };
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\.git$/i, "").toLowerCase();
}

function assertScope(scope: GitCredentialScope): void {
  if (
    !scope || (scope.protocol !== "https" && scope.protocol !== "http") ||
    typeof scope.host !== "string" || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(scope.host) ||
    typeof scope.path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?(?:\.git)?$/.test(scope.path)
  ) {
    throw new Error("git_credential_scope_invalid");
  }
}

/**
 * D-103 HOST-FIX v2: bygger `credential.helper`-config-VERDIEN (uten
 * `-c`/`credential.helper=`-prefikset - se `GitAuthHandle.credentialHelperArgs`
 * for den fullstendige argv-tuppelen). IDENTISK på POSIX og Windows - INGEN
 * plattform-betinget gren (motsatt av v1s `buildAskpassEnvValue()`), fordi
 * denne mekanismen strukturelt ALDRI ber OS-en om å direkte kjøre en fil git
 * selv må gjette hvordan skal tolkes:
 *
 * `!`-prefikset er git sin EGEN, dokumenterte (gitcredentials(7), samme
 * konvensjon som `core.pager = !less`/`core.editor = !...`) "resten av
 * strengen er en shell-kommando"-markør. Git STRIPPER selve `!`-tegnet FØR
 * strengen når til en shell (bekreftet av at git sitt eget kanoniske
 * dokumentasjonseksempel, `!f() { ...; }; f`, ikke ville vært gyldig
 * shell-syntaks om `!` ble sendt bokstavelig sammenklistret med et
 * funksjonsnavn) - resten (`"<node>" "<script>"`) evalueres av EN EKTE SHELL
 * (`sh -c`, POSIX `/bin/sh` på Linux/macOS, MSYS-en sin medfølgende `sh.exe`
 * på Windows - IKKE `cmd.exe`, IKKE PowerShell). Git legger operasjonen
 * (`get`/`store`/`erase`) til som et EGET, korrekt shell-quotet argv-element
 * (`"$@"`-idiomet), ALDRI streng-sammenslått inn i selve kommandoteksten.
 *
 * Fordi BEGGE de faktisk kjørte programmene (`sh`/`sh.exe` OG `node`/
 * `node.exe`) er ekte, allerede installerte Win32 PE- (eller ELF-)
 * kjørbare filer - ALDRI vår genererte `.cjs`-fil, som kun LESES som
 * JS-KILDEKODE av en allerede kjørende `node`-prosess, aldri selv gjort til
 * et prosess-avbilde - elimineres BÅDE "CreateProcess kan ikke laste en
 * ikke-PE-fil direkte"-feilklassen (v2s mest sannsynlige root cause) OG
 * enhver tenkelig "Windows Defender/AV blokkerer et fersk-skrevet kjørbart
 * objekt i %TEMP%"-variant strukturelt, uavhengig av hvilken av de to som
 * faktisk var den eksakte underliggende Win32-mekanismen (se root cause-
 * doc-kommentaren over toppen av filen - ærlig utledet, ikke live-bevist på
 * ekte Windows av Claude Code selv).
 *
 * Ren/testbar uten filsystem-tilgang: tar node/skript-stier som eksplisitte
 * parametre.
 *
 * D-103 HOST-FIX v2 (host-CI-funn, `windows-git-auth`-jobbens FØRSTE reelle
 * kjøring): `windows-git-auth`-CI-jobben feilet ved sin FØRSTE kjøring, MEN
 * ved feilsøking (empirisk verifisert direkte mot ekte `git` her, ALDRI
 * antatt) viste det seg IKKE å være et produksjonskode-funn - kun et
 * test-rigg-funn (se `git-credential-isolation.test.ts` sin
 * `writeFakeAmbientSystemConfig()`). PRESIST utledet skille: en FIL-basert
 * config-VERDI (`[credential]\n\thelper = <sti>` i en config-FIL) ER
 * backslash-escape-sensitiv (git-config(1): `\`, `"`, `\n`, `\t`, `\b` er de
 * ENESTE gyldige escape-sekvensene der - en bokstavelig Windows-sti-
 * backslash foran en vilkårlig bokstav, f.eks. `\U`/`\A`/`\T`/`\L` fra
 * `C:\Users\...`, er en PARSE-FEIL, "bad config line") - MEN en verdi gitt
 * via kommandolinjen (`-c key=verdi`, det DENNE funksjonen faktisk brukes
 * til) er BEVIST å IKKE gjennomgå NOEN escape-prosessering i det hele tatt -
 * git tar `-c`-verdien 100 % BOKSTAVELIG, inkludert backslash OG
 * anførselstegn, uendret. (Verifisert direkte: `git -c 'credential.helper=
 * C:\Users\Tobia\node.exe' config --get credential.helper` returnerer
 * STRENGEN UENDRET, ingen feil - selv `\n` forblir bokstavelig `\n`, ALDRI
 * en newline; det samme mønsteret via en FIL feiler derimot umiddelbart med
 * "bad config line".) Denne funksjonen skal DERFOR ALDRI escape noe -
 * gjøre det ville PRODUSERT feil verdi (git ville lagt til en ekstra
 * bokstavelig backslash git selv ALDRI fjerner igjen for `-c`-verdier).
 * Formen under (bar sammensetning, ingen escaping) er den EMPIRISK
 * bekreftede korrekte - se `git-auth.test.ts` test L3 for det samme
 * beviset kjørt som en automatisert regresjonstest.
 */
export function buildCredentialHelperConfigValue(nodeExecPath: string, scriptPath: string): string {
  return `!"${nodeExecPath}" "${scriptPath}"`;
}

export interface GitAuthHandle {
  /** Ekstra prosess-env KUN for git clone/push - aldri agentens/øvrige git-kall. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * D-103 HOST-FIX v2: den ANDRE `-c`-flagg-tuppelen (etter
   * `GIT_CREDENTIAL_ISOLATION_ARGS`) som legger Jarvis sin ephemere
   * credential-helper til den (nå tomme) helper-kjeden. Eksportert som en
   * egen argv-tuppel (ikke bakt inn i `env`) fordi git-config-verdier, ikke
   * miljøvariabler, er den korrekte mekanismen for å REGISTRERE en helper -
   * `env` bærer KUN dataene (token + terminal-prompt-sperre) helperen selv
   * leser ved kjøretid.
   */
  readonly credentialHelperArgs: readonly [string, string, string, string];
  /** Fjerner det ephemere credential-helper-skriptet. MÅ kalles i `finally`, uavhengig av `sandbox.dispose()`. */
  cleanup(): Promise<void>;
}

export async function createGitAuthHandle(token: string, scope: GitCredentialScope): Promise<GitAuthHandle> {
  assertScope(scope);
  const dir = await mkdtemp(join(tmpdir(), "jarvis-git-cred-"));
  const scriptPath = join(dir, "credential-helper.cjs");
  await writeFile(scriptPath, generateCredentialHelperScriptContent(scope), "utf8");
  // Ikke strengt nødvendig lenger (skriptet kjøres ALDRI direkte av OS-en -
  // kun lest som kildekode av en allerede kjørende `node`), men ufarlig
  // defense-in-depth på POSIX og en no-op-å-ignorere feil på Windows.
  await chmod(scriptPath, 0o700).catch(() => undefined);

  const configValue = buildCredentialHelperConfigValue(process.execPath, scriptPath);

  return {
    env: {
      GIT_TERMINAL_PROMPT: "0",
      [GIT_CREDENTIAL_TOKEN_ENV]: token
    },
    // `credential.useHttpPath=true`: git sender da `path=` til helperen, slik at scopet kan binde credentialen til ETT repo.
    credentialHelperArgs: ["-c", `credential.helper=${configValue}`, "-c", "credential.useHttpPath=true"],
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
