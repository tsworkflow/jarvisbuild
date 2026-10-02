import { describe, expect, it } from "vitest";
import {
  GIT_HARDENING_ARGS, GIT_LOCAL_HARDENING_ARGS, GitPolicyError, allowedReposFromEnv, assertJobBranch, assertRepoAllowed,
  assertTestCommand, parseAllowedRepos, parseGitHubRepoUrl
} from "../src/git-policy.ts";

/**
 * Remediering del 2 (JARVIS-009/063/064): deterministisk policy for repo-URL, branch, testkommando og git-hardening.
 * Atferd mot ekte git/credential-helper dekkes av coding-git-auth-wiring.test.ts og git-auth.test.ts.
 */
const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof GitPolicyError) return err.reason;
    throw err;
  }
  return "OK";
};

describe("repo-URL: kun eksakt https://github.com/<owner>/<repo>", () => {
  it("godtar kanonisk form (med og uten .git) og normaliserer", () => {
    const a = parseGitHubRepoUrl("https://github.com/tsworkflow/jarvisbuild");
    const b = parseGitHubRepoUrl("https://github.com/TSWorkflow/JarvisBuild.git");
    expect(a.slug).toBe("tsworkflow/jarvisbuild");
    expect(b.slug).toBe("tsworkflow/jarvisbuild");
    expect(b.canonicalUrl).toBe("https://github.com/TSWorkflow/JarvisBuild.git");
  });
  it.each([
    "http://github.com/a/b",
    "https://evil.example/a/b",
    "https://github.com.evil.example/a/b",
    "https://github.com@evil.example/a/b",
    "https://user:pw@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com/a/b/c",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#frag",
    "https://github.com/a/%2e%2e",
    "https://github.com/a/..",
    "https://github.com/a/-b",
    "https://github.com/a\\b",
    "https://github.com/a/b c",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b.git",
    "file:///etc/passwd",
    "/local/path",
    "ext::sh -c id",
    "--upload-pack=touch /tmp/pwned",
    "-oProxyCommand=id",
    "",
    "https://github.com/" + "a".repeat(300) + "/b"
  ])("avviser %j", (url) => {
    expect(reason(() => parseGitHubRepoUrl(url))).not.toBe("OK");
  });
  it("ikke-streng avvises", () => {
    expect(reason(() => parseGitHubRepoUrl(undefined))).toBe("repo_url_invalid");
    expect(reason(() => parseGitHubRepoUrl(42))).toBe("repo_url_invalid");
  });
});

describe("allowlist: eksakt repo, fail closed", () => {
  it("tom allowlist avviser alt", () => {
    expect(reason(() => assertRepoAllowed("https://github.com/a/b", []))).toBe("git_repo_allowlist_empty");
  });
  it("kun eksakt treff (case-insensitivt) - annet repo i samme org avvises", () => {
    expect(reason(() => assertRepoAllowed("https://github.com/Acme/Repo.git", ["acme/repo"]))).toBe("OK");
    expect(reason(() => assertRepoAllowed("https://github.com/acme/other", ["acme/repo"]))).toBe("git_repo_not_allowlisted");
    expect(reason(() => assertRepoAllowed("https://github.com/acme/repo2", ["acme/repo"]))).toBe("git_repo_not_allowlisted");
    expect(reason(() => assertRepoAllowed("https://github.com/acme/repo", ["acme/*"]))).toBe("git_repo_not_allowlisted");
  });
  it("parseAllowedRepos: komma-separert, ugyldige elementer kaster (aldri stille ignorert)", () => {
    expect(parseAllowedRepos(" Acme/Repo , b/c ")).toEqual(["acme/repo", "b/c"]);
    expect(parseAllowedRepos(undefined)).toEqual([]);
    expect(parseAllowedRepos("")).toEqual([]);
    expect(reason(() => parseAllowedRepos("acme"))).toBe("allowed_repos_invalid");
    expect(reason(() => parseAllowedRepos("acme/*"))).toBe("allowed_repos_invalid");
    expect(reason(() => parseAllowedRepos("https://github.com/a/b"))).toBe("allowed_repos_invalid");
  });
  it("miljø: JARVIS_GIT_ALLOWED_REPOS har forrang, ellers JARVIS_GITHUB_REPO, ellers tom", () => {
    expect(allowedReposFromEnv({ JARVIS_GIT_ALLOWED_REPOS: "a/b", JARVIS_GITHUB_REPO: "c/d" })).toEqual(["a/b"]);
    expect(allowedReposFromEnv({ JARVIS_GITHUB_REPO: "c/d" })).toEqual(["c/d"]);
    expect(allowedReposFromEnv({ JARVIS_GIT_ALLOWED_REPOS: "" })).toEqual([]);
    expect(allowedReposFromEnv({})).toEqual([]);
  });
});

describe("branch", () => {
  it("godtar jarvis/<trygt-id>", () => {
    expect(assertJobBranch("jarvis/task-1234")).toBe("jarvis/task-1234");
  });
  it.each(["main", "jarvis/", "jarvis/../x", "jarvis/a..b", "jarvis/-x", "jarvis/x.lock", "jarvis/a b", "jarvis/a;b", "jarvis/$(id)", "refs/heads/x", "jarvis//x"])("avviser %j", (b) => {
    expect(reason(() => assertJobBranch(b))).toBe("branch_invalid");
  });
});

describe("testkommando: kun kjente testløpere, aldri vilkårlig kode", () => {
  it.each([
    [["npm", "test"]], [["pnpm", "test"]], [["yarn", "test"]], [["pnpm", "run", "test:unit"]], [["npm", "run", "test"]],
    [["node", "--test"]], [["node", "--test", "src/"]], [["node", "test.js"]], [["node", "src/range.test.js"]],
    [["pytest"]], [["pytest", "-q", "tests/"]], [["go", "test", "./..."]], [["cargo", "test"]], [["make", "test"]]
  ])("godtar %j", (cmd) => {
    expect(reason(() => assertTestCommand(cmd))).toBe("OK");
  });
  it.each([
    [["node", "-e", "process.exit(0)"]], [["node", "--eval", "x"]], [["node", "-p", "1"]], [["node", "--require", "evil.js", "t.js"]],
    [["node", "--import", "evil.mjs", "--test"]], [["node", "--eval=x"]], [["node", "/etc/x.js"]], [["node", "../x.js"]], [["node"]],
    [["sh", "-c", "id"]], [["bash", "-c", "id"]], [["curl", "http://evil"]], [["rm", "-rf", "/"]], [["npm", "install"]],
    [["npm", "run", "build"]], [["npm", "run", "test;id"]], [["npm", "exec", "x"]], [["npx", "x"]], [["pnpm", "dlx", "x"]],
    [["pytest", "-p", "evilplugin"]], [["pytest", "conftest.py"]], [["go", "run", "main.go"]], [["go", "test", "-exec", "id"]],
    [["cargo", "run"]], [["make", "all"]], [["make", "test", "SHELL=sh"]], [[]], ["npm test"], [["npm", "test\ninstall"]], [[""]]
  ])("avviser %j", (cmd) => {
    expect(reason(() => assertTestCommand(cmd))).not.toBe("OK");
  });
});

describe("git-hardening-argv", () => {
  const joined = GIT_HARDENING_ARGS.join(" ");
  it("nettverkskall: hooks av, kun https, ingen redirect-følging, ingen submoduler, fsck", () => {
    expect(joined).toContain("core.hooksPath=/dev/null");
    expect(joined).toContain("protocol.allow=never");
    expect(joined).toContain("protocol.https.allow=always");
    expect(joined).toContain("http.followRedirects=false");
    expect(joined).toContain("submodule.recurse=false");
    expect(joined).toContain("transfer.fsckObjects=true");
    expect(joined).not.toContain("protocol.file.allow=always");
    expect(joined).not.toContain("protocol.ext.allow=always");
  });
  it("lokale kall: hooks av + ingen eksterne transporter", () => {
    expect(GIT_LOCAL_HARDENING_ARGS.join(" ")).toContain("core.hooksPath=/dev/null");
    expect(GIT_LOCAL_HARDENING_ARGS.join(" ")).toContain("protocol.allow=never");
  });
  it("argv består av -c <key=value>-par", () => {
    for (let i = 0; i < GIT_HARDENING_ARGS.length; i += 2) {
      expect(GIT_HARDENING_ARGS[i]).toBe("-c");
      expect(GIT_HARDENING_ARGS[i + 1]).toMatch(/^[a-z.]+=/i);
    }
  });
});
