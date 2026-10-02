/**
 * Remediering del 2 (JARVIS-009/063/064): ren, deterministisk policy for alt som kan nå `git` fra en kodejobb.
 *
 * Trussel: `repo_url`, `test_command` og branch-navn kommer (indirekte) fra modell-/klientstyrt innhold. Uten
 * validering kan en jobb (a) få Jarvis' GitHub-credential sendt til en FREMMED vert (`https://evil.example/...`,
 * `https://github.com@evil.example/`, redirect), (b) kjøre vilkårlige transporter (`ext::sh -c ...`, `file://`,
 * `--upload-pack=...` som "URL"), (c) kjøre repo-hooks fra et ubetrodd repo, eller (d) kjøre en vilkårlig
 * kommando som "testkommando". Alt avgjøres her i kode og feiler lukket - aldri ved prompt-regler.
 */

export class GitPolicyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "GitPolicyError";
  }
}

export interface GitRepoRef {
  readonly host: "github.com";
  readonly owner: string;
  readonly repo: string;
  /** `owner/repo`, små bokstaver (GitHub er case-insensitivt). */
  readonly slug: string;
  /** Kanonisk klone-URL (alltid `https://github.com/<owner>/<repo>.git`) - det eneste git får se. */
  readonly canonicalUrl: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Eksakt `https://github.com/<owner>/<repo>[.git]` - ingen userinfo, port, query, fragment, prosentkoding,
 * backslash, ekstra stisegmenter, mellomrom/kontrolltegn eller andre verter/protokoller.
 */
export function parseGitHubRepoUrl(raw: unknown): GitRepoRef {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) throw new GitPolicyError("repo_url_invalid");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\%?#@]/.test(raw)) throw new GitPolicyError("repo_url_invalid");
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(raw);
  if (!m) throw new GitPolicyError("repo_url_not_github_https");
  const owner = m[1] as string;
  let repo = m[2] as string;
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || repo.startsWith("-")) {
    throw new GitPolicyError("repo_url_invalid");
  }
  const slug = `${owner}/${repo}`.toLowerCase();
  return { host: "github.com", owner, repo, slug, canonicalUrl: `https://github.com/${owner}/${repo}.git` };
}

/** `owner/repo[,owner/repo]` -> små-bokstav-slugs. Ugyldige elementer ignoreres aldri stille: de kaster. */
export function parseAllowedRepos(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0)) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(part);
    if (!m || !OWNER.test(m[1] as string) || !REPO.test(m[2] as string)) throw new GitPolicyError("allowed_repos_invalid");
    out.push(part.toLowerCase());
  }
  return out;
}

/** Allowlist fra miljøet: `JARVIS_GIT_ALLOWED_REPOS`, ellers den ene konfigurerte `JARVIS_GITHUB_REPO`. Tom liste = ingenting tillatt. */
export function allowedReposFromEnv(env: Record<string, string | undefined>): string[] {
  const explicit = parseAllowedRepos(env["JARVIS_GIT_ALLOWED_REPOS"]);
  if (explicit.length > 0) return explicit;
  return parseAllowedRepos(env["JARVIS_GITHUB_REPO"]);
}

/** Parser URL-en OG krever eksakt treff mot allowlisten. Tom allowlist feiler lukket. */
export function assertRepoAllowed(repoUrl: unknown, allowed: readonly string[]): GitRepoRef {
  const ref = parseGitHubRepoUrl(repoUrl);
  if (allowed.length === 0) throw new GitPolicyError("git_repo_allowlist_empty");
  if (!allowed.includes(ref.slug)) throw new GitPolicyError("git_repo_not_allowlisted");
  return ref;
}

/** Jobb-branch: `jarvis/<id>` med trygt tegnsett (ingen `..`, `//`, `.lock`, ledende `-`). */
export function assertJobBranch(branch: unknown): string {
  if (typeof branch !== "string" || !/^jarvis\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(branch)) throw new GitPolicyError("branch_invalid");
  if (branch.includes("..") || branch.endsWith(".lock") || branch.endsWith(".")) throw new GitPolicyError("branch_invalid");
  return branch;
}

const FORBIDDEN_NODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader", "-i", "--interactive", "--input-type"]);

/**
 * Testkommando: KUN kjente testløpere uten vilkårlig kodeinjeksjon. Aldri en shell, aldri `-e/--eval/--require/--import`.
 * Tillatt: `npm|pnpm|yarn test`, `npm|pnpm run test[:x]`, `node --test [sti]`, `node <fil.js|mjs|cjs>`, `pytest [args]`,
 * `go test ./...`, `cargo test`, `make test`.
 */
export function assertTestCommand(cmd: unknown): string[] {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > 16 || cmd.some((a) => typeof a !== "string" || a.length === 0 || a.length > 200)) {
    throw new GitPolicyError("test_command_invalid");
  }
  const argv = cmd as string[];
  // eslint-disable-next-line no-control-regex
  if (argv.some((a) => /[\u0000-\u001f\u007f]/.test(a))) throw new GitPolicyError("test_command_invalid");
  const [bin, ...rest] = argv as [string, ...string[]];
  const safeArg = (a: string): boolean => /^[A-Za-z0-9_./:=@+-]+$/.test(a) && !a.startsWith("-e") ;
  switch (bin) {
    case "npm":
    case "pnpm":
    case "yarn": {
      const ok = (rest.length === 1 && rest[0] === "test") || (rest.length === 2 && rest[0] === "run" && /^test(:[A-Za-z0-9_-]+)?$/.test(rest[1] as string));
      if (!ok) throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    case "node": {
      if (rest.some((a) => FORBIDDEN_NODE_FLAGS.has(a) || /^--(eval|print|require|import|loader|experimental-loader|input-type)(=|$)/.test(a))) {
        throw new GitPolicyError("test_command_not_allowed");
      }
      const first = rest[0];
      const isTestRunner = first === "--test";
      const isFile = first !== undefined && /^(?!-)[A-Za-z0-9_./-]+\.(?:c|m)?js$/.test(first) && !first.startsWith("/") && !first.split("/").includes("..");
      if (!isTestRunner && !isFile) throw new GitPolicyError("test_command_not_allowed");
      if (!rest.slice(1).every((a) => safeArg(a) && !FORBIDDEN_NODE_FLAGS.has(a))) throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    case "pytest": {
      if (!rest.every((a) => safeArg(a) && !a.startsWith("-p") && !a.startsWith("--rootdir=/") && !a.includes("conftest"))) throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    case "go": {
      if (rest[0] !== "test" || !rest.slice(1).every((a) => /^(?:\.\/\.\.\.|\.\/[A-Za-z0-9_./-]*|-v|-race|-count=\d+|-run=[A-Za-z0-9_|^$.*]+)$/.test(a))) throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    case "cargo": {
      if (rest[0] !== "test" || !rest.slice(1).every((a) => /^(?:--workspace|--all|--release|--lib|-q|--quiet)$/.test(a))) throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    case "make": {
      if (rest.length !== 1 || rest[0] !== "test") throw new GitPolicyError("test_command_not_allowed");
      return argv;
    }
    default:
      throw new GitPolicyError("test_command_not_allowed");
  }
}

/**
 * Hardening som settes foran HVERT git-kall i jobben (git-config via `-c` har høyest presedens):
 *  - `core.hooksPath=/dev/null`: ingen hooks (post-checkout/pre-commit/...) fra et ubetrodd repo kjøres;
 *  - `protocol.allow=never` + kun `https`: ingen `ext::`, `file`, `ssh`, `git`-transport;
 *  - `http.followRedirects=false`: credential følger aldri en redirect til en annen vert;
 *  - `core.fsmonitor=false`, `core.symlinks=false`, `transfer.fsckObjects=true`;
 *  - `submodule.recurse=false`: ingen submodul-henting (ville åpnet nye URL-er utenfor allowlisten).
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.symlinks=false",
  "-c", "transfer.fsckObjects=true",
  "-c", "submodule.recurse=false"
];

/** Hardening for rent lokale git-kall (ingen nettverk): hooks av og ingen eksterne transporter. */
export const GIT_LOCAL_HARDENING_ARGS: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.allow=never",
  "-c", "core.fsmonitor=false"
];
