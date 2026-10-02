#!/usr/bin/env node
/**
 * Remediation part 1 - structural containment invariants (JARVIS-001/002/008/009/010/035/042/080/089).
 *
 * This is a STRUCTURAL guard against re-opening the dangerous surfaces: it reads compose files,
 * Dockerfiles and a few entrypoints and fails when a database / vault / browser / API port is
 * published on all interfaces, an image is floating, or an entrypoint wires the full tool mesh,
 * self-modification or the dev routes back in. It does NOT replace behavioural tests - those are the
 * remediation-1 test files under apps/api/test, modules/core/test, modules/model-gateway/test,
 * apps/voice-gateway/test and ops/claude-worker/test.
 *
 *   node ops/security/check-containment.mjs        # exit 0 = clean, 1 = violations (listed)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)$/;
const IP_PREFIX = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):/;

/** Strip comment-only lines and trailing `# comments` (compose/Dockerfile/TS single-line). */
function stripYamlComments(text) {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.replace(/\s+#\s.*$/, ""));
}

export function parseComposeServices(text) {
  const lines = stripYamlComments(text);
  const servicesIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (servicesIdx === -1) return {};
  const services = {};
  let current;
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // next top-level key (volumes:, etc.)
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      services[current] = [];
    } else if (current) {
      services[current].push(line);
    }
  }
  return services;
}

/** Published-port entries for one service block: [{raw, ip}] (ip undefined = all interfaces). */
export function publishedPorts(blockLines) {
  const entries = [];
  const portsIdx = blockLines.findIndex((l) => /^ {4}ports:\s*$/.test(l));
  if (portsIdx === -1) return entries;
  let item;
  const flush = () => {
    if (!item) return;
    if (item.long) {
      const hostIp = /host_ip:\s*["']?([^"'\s]+)["']?/.exec(item.text)?.[1];
      entries.push({ raw: item.text.replace(/\s+/g, " ").trim(), ip: hostIp });
    } else {
      const value = item.text.replace(/^["']|["']$/g, "");
      entries.push({ raw: value, ip: IP_PREFIX.exec(value)?.[1] });
    }
    item = undefined;
  };
  for (let i = portsIdx + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (/^ {4}\S/.test(line) || (line.trim() !== "" && !/^ {6}/.test(line))) break;
    const m = /^ {6}-\s*(.*)$/.exec(line);
    if (m) {
      flush();
      const body = m[1].trim();
      item = { long: /^[A-Za-z_]+:\s/.test(body) || /^[A-Za-z_]+:$/.test(body), text: body };
    } else if (item && line.trim() !== "") {
      item.long = true;
      item.text += ` ${line.trim()}`;
    }
  }
  flush();
  return entries;
}

function pinned(imageRef) {
  return /@sha256:[0-9a-f]{64}$/.test(imageRef.trim());
}

/** Navn i `cap_add` (flow-liste `[A, B]` eller blokkliste `- A`), uten anførselstegn. */
function capAddNames(block) {
  const names = [];
  for (let i = 0; i < block.length; i++) {
    const m = /^\s{4}cap_add:\s*(.*)$/.exec(block[i] ?? "");
    if (!m) continue;
    const inline = (m[1] ?? "").replace(/#.*$/, "");
    for (const t of inline.match(/[A-Za-z_]+/g) ?? []) names.push(t.toUpperCase());
    for (let j = i + 1; j < block.length && /^\s{6}-\s*/.test(block[j] ?? ""); j++) {
      for (const t of (block[j] ?? "").replace(/#.*$/, "").match(/[A-Za-z_]+/g) ?? []) names.push(t.toUpperCase());
    }
  }
  return names;
}

export function checkCompose(text, label = "docker-compose.yml") {
  const violations = [];
  const services = parseComposeServices(text);
  for (const [name, block] of Object.entries(services)) {
    for (const p of publishedPorts(block)) {
      if (!p.ip || !LOOPBACK.test(p.ip)) {
        violations.push(`${label}: service '${name}' publishes '${p.raw}' on ${p.ip ?? "ALL interfaces"} - bind to 127.0.0.1 or remove host publishing`);
      }
    }
    const body = block.join("\n");
    if (/^\s{4}network_mode:\s*["']?host/m.test(body)) violations.push(`${label}: service '${name}' uses network_mode: host`);
    if (/^\s{4}privileged:\s*true/m.test(body)) violations.push(`${label}: service '${name}' is privileged`);
    if (/docker\.sock/.test(body)) violations.push(`${label}: service '${name}' mounts the Docker socket`);
    // Del 2 (JARVIS-009/010): ingen tjeneste får hele .env-settet; capabilities legges aldri til; ingen sandbox-av.
    if (/^\s{4}env_file:/m.test(body)) violations.push(`${label}: service '${name}' uses env_file (whole .env set) - list per-service variables explicitly`);
    // D-365: eneste tillatte unntak er `SYS_CHROOT` på browser-gateway (Chromium-sandboxens chroot under `cap_drop: ALL`).
    if (/^\s{4}cap_add:/m.test(body)) {
      const added = capAddNames(block);
      const allowed = name === "browser-gateway" && added.length === 1 && added[0] === "SYS_CHROOT";
      if (!allowed) violations.push(`${label}: service '${name}' adds Linux capabilities (cap_add: ${added.join(",") || "?"}) - only SYS_CHROOT on browser-gateway is allowed (D-365)`);
    }
    if (/seccomp[=:]\s*unconfined/.test(body) || /apparmor[=:]\s*unconfined/.test(body)) violations.push(`${label}: service '${name}' disables seccomp/apparmor (unconfined)`);
    if (/^\s{4}user:\s*["']?(root|0)\b/m.test(body)) violations.push(`${label}: service '${name}' runs as root`);
    const image = /^\s{4}image:\s*(\S+)/m.exec(body)?.[1];
    if (image && !pinned(image)) violations.push(`${label}: service '${name}' image '${image}' is not pinned to a @sha256 digest`);
    if (/JARVIS_VOICE_DEBUG_DUMP_DIR/.test(body)) violations.push(`${label}: service '${name}' forwards JARVIS_VOICE_DEBUG_DUMP_DIR (raw audio dump must not be wired in compose)`);
  }
  // Del 2: Node-/Chromium-tjenestene skal være herdet (cap_drop ALL + no-new-privileges + read-only rootfs).
  for (const name of ["api", "worker", "migrate", "voice-gateway", "browser-gateway"]) {
    const block = services[name];
    if (!block) continue;
    const body = block.join("\n");
    const hardened = /<<:\s*\*hardening/.test(body);
    if (!hardened && !/cap_drop:\s*\[\s*["']?ALL/.test(body)) violations.push(`${label}: service '${name}' must drop all capabilities (cap_drop: [ALL] / <<: *hardening)`);
    if (!hardened && !/no-new-privileges:true/.test(body)) violations.push(`${label}: service '${name}' must set no-new-privileges`);
    if (!hardened && !/^\s{4}read_only:\s*true/m.test(body)) violations.push(`${label}: service '${name}' must have a read-only root filesystem`);
  }
  // Del 2: Chromium-tjenesten er aldri på `core`-nettverket (ville gitt vei til DB/vault) og har kun egen seccomp-profil.
  const browser = services["browser-gateway"];
  if (browser) {
    const body = browser.join("\n");
    if (!/^\s{4}networks:\s*\[\s*browser\s*\]/m.test(body)) violations.push(`${label}: service 'browser-gateway' must be attached ONLY to the 'browser' network`);
  }
  // Del 2: hemmeligheter som kun hører hjemme hos vault/DB-bootstrap må ikke lekke inn i app-/worker-/browser-/voice-tjenester.
  const VAULT_ONLY = ["INFISICAL_ENCRYPTION_KEY", "INFISICAL_AUTH_SECRET", "JARVIS_DB_ADMIN_PASSWORD", "INFISICAL_DB_PASSWORD", "LANGFUSE_DB_PASSWORD", "NEXTAUTH_SECRET"];
  for (const name of ["api", "worker", "voice-gateway", "browser-gateway"]) {
    const body = (services[name] ?? []).join("\n");
    for (const key of VAULT_ONLY) {
      if (new RegExp(`\\b${key}\\b`).test(body)) violations.push(`${label}: service '${name}' receives ${key} (vault/DB-admin secret must not reach this service)`);
    }
  }
  // services that must never publish a host port at all
  for (const name of ["browser-gateway", "infisical-redis", "db-bootstrap", "migrate", "worker"]) {
    if (services[name] && publishedPorts(services[name]).length > 0) {
      violations.push(`${label}: service '${name}' must not publish any host port`);
    }
  }
  return violations;
}

export function checkDockerfile(text, label) {
  const violations = [];
  const stages = new Set();
  for (const line of stripYamlComments(text)) {
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
    if (!m) continue;
    const ref = m[1];
    if (ref !== "scratch" && !stages.has(ref) && !pinned(ref)) violations.push(`${label}: FROM ${ref} is not pinned to a @sha256 digest`);
    if (m[2]) stages.add(m[2]);
  }
  // Del 2: den SISTE (kjørende) stage skal ha en ikke-root USER.
  const users = stripYamlComments(text).filter((l) => /^USER\s+/i.test(l.trim())).map((l) => l.trim().split(/\s+/)[1]);
  const last = users[users.length - 1];
  if (!last || last === "root" || last === "0" || last.startsWith("0:")) {
    violations.push(`${label}: final stage must set a non-root USER (found ${last ?? "none"})`);
  }
  return violations;
}

const codeOnly = (text) =>
  text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

/** The balanced-parenthesis text of the first call starting at `needle` (e.g. "executiveHandler("). */
export function extractCall(src, needle) {
  const start = src.indexOf(needle);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start + needle.length - 1; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

export function checkEntrypoints(files) {
  const violations = [];
  for (const label of ["apps/api/src/main.ts", "apps/api/src/worker-main.ts"]) {
    const src = codeOnly(files[label] ?? "");
    for (const forbidden of ["allMeshTools(", "fullMeshTools", "SPECIALIST_DELEGATION_TOOLS", "createSpecialistDelegationExecutor", "SelfModificationService", "selfModificationToolDefinitions", "sweepPendingRequests", "sweepPendingJobs", "sweepApprovedRequests"]) {
      if (src.includes(forbidden)) violations.push(`${label}: references '${forbidden}' (full tool mesh / delegation / self-modification must stay out of the active surface)`);
    }
    if (!src.includes("resolveModelToolSurface(")) violations.push(`${label}: does not build the model tool surface via resolveModelToolSurface()`);
  }
  const main = codeOnly(files["apps/api/src/main.ts"] ?? "");
  if (/enableDevRoutes/.test(main)) violations.push("apps/api/src/main.ts: sets enableDevRoutes (dev routes must be test-only)");
  const server = codeOnly(files["apps/api/src/server.ts"] ?? "");
  for (const route of ["/worker/tick", "/tools/critical-demo"]) {
    const line = server.split("\n").find((l) => l.includes(`url.pathname === "${route}"`));
    if (!line) continue;
    if (!line.includes("deps.enableDevRoutes === true")) violations.push(`apps/api/src/server.ts: route ${route} is not gated by enableDevRoutes`);
  }
  const exec = codeOnly(files["apps/api/src/executive.ts"] ?? "");
  if (/sandbox\.(create|exec)|opts\.sandbox/.test(exec)) violations.push("apps/api/src/executive.ts: the executive command/sandbox branch is back");
  const wm = codeOnly(files["apps/api/src/worker-main.ts"] ?? "");
  if (/sandbox\s*:/.test(extractCall(wm, "executiveHandler("))) violations.push("apps/api/src/worker-main.ts: passes a sandbox to executiveHandler");
  return violations;
}

export function checkEnvExample(text) {
  const violations = [];
  for (const line of text.split("\n")) {
    if (/^\s*JARVIS_VOICE_DEBUG_DUMP_DIR\s*=\s*\S+/.test(line)) violations.push(".env.example: sets JARVIS_VOICE_DEBUG_DUMP_DIR to a value");
    if (/^\s*JARVIS_VOICE_DEBUG_DUMP_CONSENT\s*=\s*\S+/.test(line)) violations.push(".env.example: sets JARVIS_VOICE_DEBUG_DUMP_CONSENT to a value");
  }
  return violations;
}

export function checkScratchImageMatchesCompose(composeText, scriptText) {
  const compose = /image:\s*(pgvector\/pgvector:\S+)/.exec(composeText)?.[1];
  const script = /^IMAGE="([^"]+)"/m.exec(scriptText)?.[1];
  if (!compose || !script) return ["ops/backup/nas-restore-verify.sh: could not compare the scratch image with the compose pgvector image"];
  return compose === script ? [] : [`ops/backup/nas-restore-verify.sh: scratch image '${script}' differs from compose pgvector image '${compose}'`];
}

export function runChecks(repoRoot) {
  const read = (rel) => (existsSync(join(repoRoot, rel)) ? readFileSync(join(repoRoot, rel), "utf8") : "");
  const violations = [];
  const compose = read("infra/local/docker-compose.yml");
  if (!compose) violations.push("infra/local/docker-compose.yml: missing");
  violations.push(...checkCompose(compose, "infra/local/docker-compose.yml"));
  const dockerDir = join(repoRoot, "infra/local");
  if (existsSync(dockerDir)) {
    for (const f of readdirSync(dockerDir).filter((n) => n.endsWith(".Dockerfile"))) {
      violations.push(...checkDockerfile(read(`infra/local/${f}`), `infra/local/${f}`));
    }
  }
  const files = Object.fromEntries(
    ["apps/api/src/main.ts", "apps/api/src/worker-main.ts", "apps/api/src/server.ts", "apps/api/src/executive.ts"].map((p) => [p, read(p)])
  );
  violations.push(...checkEntrypoints(files));
  violations.push(...checkEnvExample(read(".env.example")));
  violations.push(...checkScratchImageMatchesCompose(compose, read("ops/backup/nas-restore-verify.sh")));
  return violations;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(here, "..", "..");
  const violations = runChecks(root);
  if (violations.length > 0) {
    console.error(`containment invariants VIOLATED (${violations.length}):\n- ${violations.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`containment invariants hold (${relative(process.cwd(), root) || "."})`);
  }
}
