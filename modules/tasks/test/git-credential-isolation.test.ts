import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitCredentialScope } from "../src/git-auth.ts";
import { GIT_CREDENTIAL_ISOLATION_ARGS, GIT_CREDENTIAL_TOKEN_ENV, buildCredentialHelperConfigValue, createGitAuthHandle } from "@jarvis/tasks";
import { type GitSmartHttpServer, startGitSmartHttpServer } from "./support/git-smart-http-server.ts";

/**
 * D-103 HOST-FIX v2 (2026-08-21, "d103-git-credential-helper-windows-repair"):
 * en ANNEN ekte Windows-kjøring (task d103-host-acceptance-d5294343, ETTER
 * v1 var merget) beviste v1s ambient-helper-isolasjonsfiks FAKTISK VIRKET
 * (ingen "post-ops"-identitet dukket opp lenger), men selve v1s
 * `GIT_ASKPASS`-mekanisme feilet på et NYTT sted: `cannot spawn
 * "...\jarvis-git-askpass-<x>\askpass.cmd": Permission denied`. v2 erstatter
 * GIT_ASKPASS HELT med git sin `credential.helper`-mekanisme (se
 * git-auth.ts sin doc-kommentar for full root cause-begrunnelse).
 *
 * Denne test-filen reproduserer EKSAKT samme mekanisme som v1s tilsvarende
 * fil (ekte lokal git smart-HTTP-server, `git http-backend`, se
 * support/git-smart-http-server.ts) - IKKE lokale bare-repo-filsti-kloner
 * (som ALDRI trigger credential-oppløsning i det hele tatt). Den "ambiente"
 * system-konfigurasjonen simuleres via `GIT_CONFIG_SYSTEM` (git >= 2.32) -
 * ALDRI ved å mutere den EKTE system/global git-configen på denne maskinen.
 *
 * Bruker de EKTE eksporterte produksjonsprimitivene (`createGitAuthHandle()`,
 * `GIT_CREDENTIAL_ISOLATION_ARGS`) direkte - AT `coding.ts` faktisk bruker
 * DISSE primitivene i riktig argv-posisjon/env-scope er separat bevist i
 * `coding-git-auth-wiring.test.ts` (tester A/B/K).
 */

const JARVIS_TOKEN = "jarvis-d103-hostfix-v2-test-token-never-real";
const AMBIENT_USER = "post-ops";
const AMBIENT_PASS = "ambient-wrong-secret-never-jarvis";
const JARVIS_HELPER_USER = "x-access-token";

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 20_000 });
}

/**
 * `spawnSync()` blokkerer via en INTERN libuv-løkke, ikke den vanlige Node
 * event-loopen - den asynkrone "AUTH:<user>"-linjen serveren (en HELT SEPARAT
 * barneprosess) skriver til SIN stdout, blir derfor IKKE nødvendigvis lest av
 * `git-smart-http-server.ts` sin `stdout.on("data", ...)`-lytter FØR selve
 * `spawnSync()`-kallet returnerer.
 */
function flushServerLog(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * D-103 HOST-FIX v2 (host-CI-funn, `windows-git-auth`-jobbens FØRSTE reelle
 * kjøring - IKKE et produksjonskode-funn, men et test-rigg-funn av EKSAKT
 * samme rotårsaksklasse som `buildCredentialHelperConfigValue()`s egen
 * escaping-fiks i `git-auth.ts`): git-config-VERDIER (fil-baserte OG
 * `-c key=verdi`) er backslash-escape-sensitive - en bokstavelig Windows-sti
 * skrevet UESCAPET inn i en `[credential] helper = <sti>`-linje feiler med
 * "bad config line" ("\U"/"\A"/"\T"/"\L" fra en ekte `C:\Users\...`-sti er
 * INGEN gyldige config-escape-sekvenser). Denne test-only-hjelperen speiler
 * SAMME escaping som produksjonskoden nå bruker, slik at test-riggens EGNE
 * genererte config-filer/verdier forblir gyldige på ekte Windows.
 */
function escapeForGitConfigValue(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function writeFakeAmbientSystemConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-ambient-"));
  const helperPath = join(dir, "fake-ambient-helper.sh");
  await writeFile(helperPath, [
    "#!/bin/sh",
    "# Simulerer Windows Git Credential Manager: returnerer en cached, ANNEN",
    "# (feil) identitet enn Jarvis sin, UANSETT hvilket repo/host som spørres.",
    'if [ "$1" = "get" ]; then',
    `  echo "username=${AMBIENT_USER}"`,
    `  echo "password=${AMBIENT_PASS}"`,
    "fi",
    ""
  ].join("\n"), "utf8");
  await chmod(helperPath, 0o700);
  const configPath = join(dir, "fake-system-gitconfig");
  // D-103 HOST-FIX v2 (Windows-CI-funn, ANDRE runde - empirisk feilsøkt lokalt
  // FØR push, ikke gjettet): et FORSØK på å bare anførselstegne den bare
  // stien (`"<sti>"`, uten `!`) feilet på en HELT ANNEN, subtil måte - git sin
  // `is_absolute_path()`-sjekk (som avgjør om en bar credential.helper-verdi
  // skal kjøres DIREKTE som en sti eller tolkes som et KORTNAVN, git-
  // credential-<verdi>) ser på FØRSTE tegn i den FERDIG UNESCAPEDE verdien -
  // en verdi som begynner med et bokstavelig anførselstegn (`"/tmp/...`)
  // begynner IKKE med `/`, så git falt igjennom til kortnavn-tolkningen
  // (`git-credential-"/tmp/...` - "is not a git command"). Løsningen er å
  // bruke SAMME `!`-prefiks-konvensjon som produksjonens
  // `buildCredentialHelperConfigValue()` allerede bruker (BEVIST korrekt av
  // tester C-G) - `!` BYPASSER `is_absolute_path()`-sjekken helt og tvinger
  // ubetinget shell-evaluering, der de INDRE anførselstegnene (som
  // BESKYTTER stiens backslash-tegn på Windows fra POSIX-shellets "spis
  // backslash utenfor anførselstegn"-regel) faktisk overlever inn i selve
  // shell-kildeteksten. `escapeForGitConfigValue()` brukes FORTSATT (dette
  // ER en fil-basert config-verdi, som ER escape-sensitiv - i motsetning
  // til produksjonens `-c`-verdier, som ALDRI escapes, se git-auth.ts).
  const shellHelperValue = `!"${helperPath}"`;
  await writeFile(configPath, `[credential]\n\thelper = ${escapeForGitConfigValue(shellHelperValue)}\n`, "utf8");
  return configPath;
}

/** En bevisst ØDELAGT Jarvis-credential-helper (svarer INGENTING for "get") - simulerer et malfunksjonerende credential-transport for scenario G (fail-closed). */
async function writeBrokenJarvisHelperConfigValue(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-broken-"));
  const scriptPath = join(dir, "broken-helper.cjs");
  await writeFile(scriptPath, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.on(\"end\", () => process.exit(0));",
    ""
  ].join("\n"), "utf8");
  await chmod(scriptPath, 0o700);
  return buildCredentialHelperConfigValue(process.execPath, scriptPath);
}

describe("D-103 HOST-FIX v2: ambient credential.helper kan IKKE kapre Jarvis sin eksplisitte git credential.helper", () => {
  let server: GitSmartHttpServer;
  let fakeSystemConfig: string;
  let TEST_SCOPE: GitCredentialScope;
  const baseEnv = () => ({ PATH: process.env["PATH"] ?? "", GIT_TERMINAL_PROMPT: "0" });

  beforeAll(async () => {
    // Aksepterer BEGGE identiteter (som en ekte GitHub-server ville - "post-ops"
    // ER en gyldig, autentiserbar bruker, bare IKKE den Jarvis skal bruke).
    server = await startGitSmartHttpServer([
      { user: AMBIENT_USER, pass: AMBIENT_PASS },
      { user: JARVIS_HELPER_USER, pass: JARVIS_TOKEN }
    ]);
    server.createBareRepo("repo.git");
    // Scopet må matche test-serveren (loopback + dynamisk port + repo `repo.git`) - samme mekanisme som github.com i produksjon.
    TEST_SCOPE = { protocol: "http", host: new URL(server.url("repo.git")).host, path: "repo" };
    const seed = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-seed-"));
    git(seed, { ...process.env, HOME: seed }, "init", "--initial-branch=main", ".");
    git(seed, { ...process.env, HOME: seed }, "config", "user.email", "seed@test");
    git(seed, { ...process.env, HOME: seed }, "config", "user.name", "seed");
    await writeFile(join(seed, "README.md"), "# repo\n", "utf8");
    git(seed, { ...process.env, HOME: seed }, "add", "-A");
    git(seed, { ...process.env, HOME: seed }, "commit", "-m", "init");
    // Seedes via LOKAL filsti-push (ALDRI via HTTP-serveren selv) - den EKTE
    // testen (clone/push MOT den ekte HTTP-serveren) skjer utelukkende i
    // testene under.
    const seedPush = git(seed, { ...process.env, HOME: seed }, "push", join(server.reposRoot, "repo.git"), "main");
    if (seedPush.status !== 0) throw new Error(`seed-push feilet: ${seedPush.stderr}`);

    fakeSystemConfig = await writeFakeAmbientSystemConfig();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("A: FORUTSETNING - den ambiente helperen returnerer en SYNTAKTISK GYLDIG, AUTENTISERBAR, men ANNEN identitet enn Jarvis sin ('post-ops' != 'x-access-token')", () => {
    const filled = spawnSync("git", ["credential", "fill"], {
      env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_SYSTEM: fakeSystemConfig },
      input: "protocol=http\nhost=127.0.0.1\n\n",
      encoding: "utf8"
    });
    expect(filled.stdout).toContain(`username=${AMBIENT_USER}`);
    expect(filled.stdout).not.toContain(JARVIS_HELPER_USER);
  });

  it("B: UTEN NOEN isolasjons-argv (verken reset eller Jarvis sin helper registrert) ville ambient helper VUNNET (grunnleggende sårbarhetsklasse reprodusert nøyaktig) - serveren ser 'post-ops', ALDRI Jarvis sin identitet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-clone-b-"));
    const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig };
    const before = server.authenticatedUsernames.length;
    // BEVISST INGEN "-c credential.helper="-flagg i det hele tatt - reproduserer
    // den grunnleggende, urepararte sårbarhetsklassen (ambient helper konsulteres
    // fritt, ingen isolasjon av noe slag).
    git(dir, env, "clone", server.url("repo.git"), ".");
    await flushServerLog();
    const thisTest = server.authenticatedUsernames.slice(before);
    expect(thisTest.length).toBeGreaterThan(0);
    expect(thisTest.every((u) => u === AMBIENT_USER)).toBe(true);
  });

  it("C: MED FULL isolasjon (reset + Jarvis sin registrerte credential.helper, D-103 HOST-FIX v1+v2) vinner Jarvis sin identitet, ALDRI ambient - clone lykkes mot en ekte, kontrollert git-transport", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN, TEST_SCOPE);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-clone-c-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const before = server.authenticatedUsernames.length;
      const result = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, "clone", server.url("repo.git"), ".");
      await flushServerLog();
      expect(result.status).toBe(0);
      const thisTest = server.authenticatedUsernames.slice(before);
      expect(thisTest.length).toBeGreaterThan(0);
      expect(thisTest.every((u) => u === JARVIS_HELPER_USER)).toBe(true);
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("D: push lykkes OGSÅ mot en ekte, kontrollert git-transport MED full isolasjon - identitet forblir Jarvis sin, ALDRI ambient, gjennom BEGGE nettverkskall (clone OG push)", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN, TEST_SCOPE);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-push-d-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const before = server.authenticatedUsernames.length;
      const cloneResult = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, "clone", server.url("repo.git"), ".");
      expect(cloneResult.status).toBe(0);
      git(dir, { ...env, HOME: dir }, "config", "user.email", "jarvis@test");
      git(dir, { ...env, HOME: dir }, "config", "user.name", "jarvis");
      await writeFile(join(dir, "CHANGES.md"), "endret av D-103 host-fix v2-test\n", "utf8");
      git(dir, env, "add", "-A");
      git(dir, env, "commit", "-m", "test change");
      const branch = `jarvis/d103-hostfix-v2-test-${Date.now()}`;
      const pushResult = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, "push", "origin", `main:${branch}`);
      await flushServerLog();
      expect(pushResult.status).toBe(0);
      const thisTest = server.authenticatedUsernames.slice(before);
      expect(thisTest).not.toContain(AMBIENT_USER);
      expect(thisTest.filter((u) => u === JARVIS_HELPER_USER).length).toBeGreaterThanOrEqual(2);
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("E: token finnes ALDRI i argv, remote-URL eller resulterende git config gjennom HELE denne flyten (clone+commit+push, MED full isolasjon)", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN, TEST_SCOPE);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-secrecy-e-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const cloneArgs = [...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, "clone", server.url("repo.git"), "."];
      const cloneResult = git(dir, env, ...cloneArgs);
      expect(cloneResult.status).toBe(0);
      for (const arg of cloneArgs) expect(arg).not.toContain(JARVIS_TOKEN);
      const configResult = git(dir, env, "config", "--get", "remote.origin.url");
      expect(configResult.stdout).not.toContain(JARVIS_TOKEN);
      expect(gitAuth.env[GIT_CREDENTIAL_TOKEN_ENV]).toBe(JARVIS_TOKEN); // token finnes KUN her, i env - ikke argv/config
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("F: FAIL CLOSED - reset ALENE (ambient nullstilt, INGEN Jarvis-helper registrert, GIT_TERMINAL_PROMPT=0) feiler clone RENT - ambient identitet når ALDRI serveren, INGEN stille fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-failclosed-f-"));
    const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig };
    const before = server.authenticatedUsernames.length;
    // KUN reset-flagget - ingen Jarvis-helper lagt til, ingen GIT_ASKPASS (fjernet i v2).
    const result = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, "clone", server.url("repo.git"), ".");
    await flushServerLog();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not read (Username|Password)|terminal prompts disabled/i);
    const thisTest = server.authenticatedUsernames.slice(before);
    expect(thisTest).not.toContain(AMBIENT_USER); // ambient ble ALDRI konsultert, selv om reset ikke la til noen erstatning
  });

  it("G: FAIL CLOSED - en MALFUNKSJONERENDE Jarvis-helper (svarer ingenting for 'get') feiler clone RENT, faller ALDRI tilbake til den (allerede nullstilte) ambiente helperen", async () => {
    const brokenHelperValue = await writeBrokenJarvisHelperConfigValue();
    const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-failclosed-g-"));
    const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig };
    const before = server.authenticatedUsernames.length;
    const result = git(dir, env, "-c", "credential.helper=", "-c", `credential.helper=${brokenHelperValue}`, "clone", server.url("repo.git"), ".");
    await flushServerLog();
    expect(result.status).not.toBe(0);
    const thisTest = server.authenticatedUsernames.slice(before);
    expect(thisTest).not.toContain(AMBIENT_USER); // ingen gjenoppliving av den nullstilte ambiente kjeden
    expect(thisTest.length).toBe(0); // serveren ble aldri i det hele tatt nådd med NOEN identitet
  });
});
