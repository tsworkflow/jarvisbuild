import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitCredentialScope } from "../src/git-auth.ts";
import {
  GIT_CREDENTIAL_ISOLATION_ARGS, GIT_CREDENTIAL_TOKEN_ENV, buildCredentialHelperConfigValue,
  createGitAuthHandle, generateCredentialHelperScriptContent
} from "../src/git-auth.ts";

/**
 * D-103 HOST-FIX v2 (2026-08-21, "d103-git-credential-helper-windows-repair"):
 * ren, infrastrukturfri testing av Jarvis sin ephemere `git credential.helper`-
 * mekanisme (erstatter v1s `GIT_ASKPASS`-mekanisme etter en ekte Windows-
 * spawn-feil - se git-auth.ts sin doc-kommentar for full begrunnelse). INGEN
 * ekte git/nettverk/GitHub her - kun skript-innhold, filsystem-ephemeritet,
 * og selve skriptets kjøretidsoppførsel (den EKTE credential-helper-protokollen,
 * kjørt direkte via node, uten git eller shell involvert).
 */
const TEST_SCOPE: GitCredentialScope = { protocol: "https", host: "github.com", path: "acme/repo" };

describe("D-103 HOST-FIX v2: git-auth.ts - ephemer git credential.helper-mekanisme", () => {
  it("A: generateCredentialHelperScriptContent() refererer GIT_CREDENTIAL_TOKEN_ENV, ALDRI et hardkodet token", () => {
    const content = generateCredentialHelperScriptContent(TEST_SCOPE);
    expect(content).toContain(GIT_CREDENTIAL_TOKEN_ENV);
    expect(content).not.toMatch(/sk-ant-|ghp_|gho_/);
  });

  it("B: createGitAuthHandle() skriver credential-helper.cjs på en ephemer sti som faktisk finnes", async () => {
    const handle = await createGitAuthHandle("test-token-b", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1];
      expect(scriptPath).toBeDefined();
      await expect(stat(scriptPath as string)).resolves.toBeDefined();
    } finally {
      await handle.cleanup();
    }
  });

  it("C: GIT_TERMINAL_PROMPT=0 satt - hindrer interaktiv/ambient terminal-fallback selv om credential-helperen skulle feile å svare", async () => {
    const handle = await createGitAuthHandle("test-token-c", TEST_SCOPE);
    try {
      expect(handle.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    } finally {
      await handle.cleanup();
    }
  });

  it("D: token-verdien finnes KUN i env[GIT_CREDENTIAL_TOKEN_ENV] - ingen andre env-nøkler, og ALDRI i credentialHelperArgs, bærer den", async () => {
    const token = "test-token-d-unique-value";
    const handle = await createGitAuthHandle(token, TEST_SCOPE);
    try {
      expect(handle.env[GIT_CREDENTIAL_TOKEN_ENV]).toBe(token);
      const otherKeys = Object.keys(handle.env).filter((k) => k !== GIT_CREDENTIAL_TOKEN_ENV);
      for (const key of otherKeys) {
        expect(handle.env[key as keyof typeof handle.env]).not.toContain(token);
      }
      expect(handle.credentialHelperArgs[0]).not.toContain(token);
      expect(handle.credentialHelperArgs[1]).not.toContain(token);
    } finally {
      await handle.cleanup();
    }
  });

  it("E: selve credential-helper-skriptfilen på disk inneholder ALDRI token-verdien - kun logikk", async () => {
    const token = "test-token-e-never-on-disk";
    const handle = await createGitAuthHandle(token, TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      const fileContent = await readFile(scriptPath, "utf8");
      expect(fileContent).not.toContain(token);
    } finally {
      await handle.cleanup();
    }
  });

  it("F: cleanup() fjerner den ephemere temp-katalogen fullstendig", async () => {
    const handle = await createGitAuthHandle("test-token-f", TEST_SCOPE);
    const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
    await handle.cleanup();
    await expect(stat(scriptPath)).rejects.toThrow();
  });

  it("G: to separate createGitAuthHandle()-kall gir to distinkte, isolerte temp-kataloger", async () => {
    const a = await createGitAuthHandle("token-a", TEST_SCOPE);
    const b = await createGitAuthHandle("token-b", TEST_SCOPE);
    try {
      expect(a.credentialHelperArgs[1]).not.toBe(b.credentialHelperArgs[1]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  // H/I/J/K kjører det EKTE genererte skriptet DIREKTE via node (uten git/shell
  // involvert) - EKSAKT slik git selv ville kalt det ETTER at sh -c har startet
  // node med skriptstien + operasjonen som argv (se buildCredentialHelperConfigValue()).
  it("H: skriptet kjørt med 'get' og stdin lukket returnerer username=x-access-token OG password=<token> på stdout", async () => {
    const handle = await createGitAuthHandle("expected-token-h", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      const result = spawnSync(process.execPath, [scriptPath, "get"], {
        encoding: "utf8",
        input: "protocol=https\nhost=github.com\npath=acme/repo.git\n\n",
        env: { ...process.env, [GIT_CREDENTIAL_TOKEN_ENV]: "expected-token-h" }
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("username=x-access-token\npassword=expected-token-h\n");
    } finally {
      await handle.cleanup();
    }
  });

  it("I: skriptet kjørt med 'get' UTEN token i env svarer ingenting (aldri et tomt passord) - kaster ALDRI, skriver ALDRI 'undefined'", async () => {
    const handle = await createGitAuthHandle("unused-token-i", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      const env = { ...process.env };
      delete env[GIT_CREDENTIAL_TOKEN_ENV];
      const result = spawnSync(process.execPath, [scriptPath, "get"], { encoding: "utf8", input: "protocol=https\nhost=github.com\npath=acme/repo.git\n\n", env });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain("undefined");
    } finally {
      await handle.cleanup();
    }
  });

  it("J: skriptet kjørt med 'store' skriver INGENTING til stdout og eksiterer 0 (git sin forventede kontrakt for persistering-operasjoner)", async () => {
    const handle = await createGitAuthHandle("unused-token-j", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      const result = spawnSync(process.execPath, [scriptPath, "store"], {
        encoding: "utf8",
        input: "protocol=https\nhost=github.com\nusername=x-access-token\npassword=whatever\n\n"
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await handle.cleanup();
    }
  });

  it("K: skriptet kjørt med 'erase' skriver INGENTING til stdout og eksiterer 0 (samme kontrakt som 'store')", async () => {
    const handle = await createGitAuthHandle("unused-token-k", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      const result = spawnSync(process.execPath, [scriptPath, "erase"], {
        encoding: "utf8",
        input: "protocol=https\nhost=github.com\n\n"
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await handle.cleanup();
    }
  });

  it("L: buildCredentialHelperConfigValue() returnerer en '!'-prefikset, anførselstegnet 'node script'-streng - IDENTISK form uansett plattform (ingen gren), POSIX-stier uendret siden de aldri inneholder backslash", () => {
    expect(buildCredentialHelperConfigValue("/usr/bin/node", "/tmp/x/credential-helper.cjs"))
      .toBe('!"/usr/bin/node" "/tmp/x/credential-helper.cjs"');
    expect(buildCredentialHelperConfigValue("/usr/bin/node", "/tmp/x/credential-helper.cjs")).not.toMatch(/sk-ant-|ghp_|gho_/);
  });

  it("L2: buildCredentialHelperConfigValue() ESCAPER ALDRI Windows-sti-backslash - D-103 HOST-FIX v2s Windows-CI-funn viste (empirisk, IKKE antatt) at `-c key=verdi` på kommandolinjen IKKE gjennomgår NOEN escape-prosessering (motsatt av en fil-basert config-linje, som ER backslash-escape-sensitiv - se `git-credential-isolation.test.ts` sin `writeFakeAmbientSystemConfig()` for DEN fiksen)", () => {
    const value = buildCredentialHelperConfigValue("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Tobias H\\Temp\\x\\credential-helper.cjs");
    expect(value).toBe('!"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Tobias H\\Temp\\x\\credential-helper.cjs"');
    expect(value).not.toMatch(/sk-ant-|ghp_|gho_/);
  });

  it("L3: EKTE `git -c credential.helper=<verdi> config --get credential.helper` returnerer verdien BOKSTAVELIG UENDRET (INGEN escape-prosessering for `-c`-verdier) - bevist mot ekte git config-parsing for en simulert Windows-sti", () => {
    const windowsNodePath = "C:\\Program Files\\nodejs\\node.exe";
    const windowsScriptPath = "C:\\Users\\Tobias H\\AppData\\Local\\Temp\\jarvis-git-cred-abc123\\credential-helper.cjs";
    const configValue = buildCredentialHelperConfigValue(windowsNodePath, windowsScriptPath);
    const result = spawnSync("git", ["-c", `credential.helper=${configValue}`, "config", "--get", "credential.helper"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const expectedShellText = `!"${windowsNodePath}" "${windowsScriptPath}"`;
    expect(result.stdout.trimEnd()).toBe(expectedShellText);
  });

  it("M: GIT_CREDENTIAL_ISOLATION_ARGS er eksakt ['-c', 'credential.helper='] - git sin egen dokumenterte nullstill-helper-kjede-mekanisme, ingen hemmelighet (uendret fra v1)", () => {
    expect(GIT_CREDENTIAL_ISOLATION_ARGS).toEqual(["-c", "credential.helper="]);
  });

  it("N: createGitAuthHandle()s credentialHelperArgs har eksakt formen ['-c', 'credential.helper=!\"<node>\" \"<script>\"']", async () => {
    const handle = await createGitAuthHandle("unused-token-n", TEST_SCOPE);
    try {
      expect(handle.credentialHelperArgs[0]).toBe("-c");
      expect(handle.credentialHelperArgs[1]).toMatch(/^credential\.helper=!"/);
      expect(handle.credentialHelperArgs[1]).toContain(process.execPath);
      expect(handle.credentialHelperArgs[1]).toMatch(/credential-helper\.cjs"$/);
    } finally {
      await handle.cleanup();
    }
  });

  it("O: createGitAuthHandle()s env inneholder ALDRI en GIT_ASKPASS-nøkkel (v1-mekanismen er fullstendig fjernet, ikke bare deaktivert)", async () => {
    const handle = await createGitAuthHandle("unused-token-o", TEST_SCOPE);
    try {
      expect("GIT_ASKPASS" in handle.env).toBe(false);
    } finally {
      await handle.cleanup();
    }
  });
});

describe("Remediering del 2 (JARVIS-064): credentialen utleveres KUN til eksakt protokoll + vert + repo", () => {
  const ask = async (input: string) => {
    const handle = await createGitAuthHandle("scoped-token-xyz", TEST_SCOPE);
    try {
      const scriptPath = handle.credentialHelperArgs[1].match(/"([^"]+credential-helper\.cjs)"/)?.[1] as string;
      return spawnSync(process.execPath, [scriptPath, "get"], { encoding: "utf8", input, env: { ...process.env, [GIT_CREDENTIAL_TOKEN_ENV]: "scoped-token-xyz" } });
    } finally {
      await handle.cleanup();
    }
  };
  const OK = "username=x-access-token\npassword=scoped-token-xyz\n";

  it("riktig protokoll + vert + repo (med og uten .git, ulik case) får credential", async () => {
    expect((await ask("protocol=https\nhost=github.com\npath=acme/repo.git\n\n")).stdout).toBe(OK);
    expect((await ask("protocol=https\nhost=GitHub.com\npath=Acme/Repo\n\n")).stdout).toBe(OK);
  });
  it("fremmed vert, undervert, vert med port, http, feil repo, manglende path og userinfo-triks får ALDRI credential", async () => {
    for (const input of [
      "protocol=https\nhost=evil.example\npath=acme/repo.git\n\n",
      "protocol=https\nhost=github.com.evil.example\npath=acme/repo.git\n\n",
      "protocol=https\nhost=gist.github.com\npath=acme/repo.git\n\n",
      "protocol=https\nhost=github.com:8443\npath=acme/repo.git\n\n",
      "protocol=http\nhost=github.com\npath=acme/repo.git\n\n",
      "protocol=https\nhost=github.com\npath=acme/other.git\n\n",
      "protocol=https\nhost=github.com\npath=acme/repo/extra\n\n",
      "protocol=https\nhost=github.com\n\n",
      "protocol=ssh\nhost=github.com\npath=acme/repo.git\n\n",
      "protocol=https\nhost=github.com@evil.example\npath=acme/repo.git\n\n",
      ""
    ]) {
      const res = await ask(input);
      expect(res.status, input).toBe(0);
      expect(res.stdout, input).toBe("");
    }
  });
  it("ugyldig scope (feil vert-/stiformat) avvises ved opprettelse", async () => {
    await expect(createGitAuthHandle("t", { protocol: "https", host: "evil.example/../x", path: "a/b" })).rejects.toThrow("git_credential_scope_invalid");
    await expect(createGitAuthHandle("t", { protocol: "https", host: "github.com", path: "a/b/c" })).rejects.toThrow("git_credential_scope_invalid");
  });
  it("credentialHelperArgs aktiverer credential.useHttpPath slik at helperen ser repo-stien", async () => {
    const handle = await createGitAuthHandle("t", TEST_SCOPE);
    try {
      expect(handle.credentialHelperArgs.slice(2)).toEqual(["-c", "credential.useHttpPath=true"]);
    } finally {
      await handle.cleanup();
    }
  });
});
