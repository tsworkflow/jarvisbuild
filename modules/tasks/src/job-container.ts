import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Sandbox, SandboxRunner } from "./sandbox.ts";

/**
 * Remediering del 2 (JARVIS-010): eksplisitt PER-JOBB CONTAINERGRENSESNITT for kodejobber.
 *
 * Tidligere kjørte `coding`-jobber i `ProcessSandboxRunner` - en `spawnSync` INNE i worker-containeren
 * (root, hele `.env`, DB-nettverk). Det er ingen grense. Denne filen definerer den ENESTE godkjente
 * veien: en egen, kortlevd container per jobb med
 *   - ikke-root bruker, read-only rootfs, `tmpfs` for /tmp og hjem, kun `/work` som skrivbar monteringsflate,
 *   - alle capabilities droppet, `no-new-privileges`, ressursgrenser (minne/CPU/PID),
 *   - nettverk KUN via et eksplisitt jobb-nettverk som bare når en allowlistet egress-proxy (ingen
 *     direkte rute til DB/vault/compose-nettverket),
 *   - INGEN arvede secrets: env er en eksplisitt liste; verdier sendes aldri i argv; vault-/DB-nøkler nektes,
 *   - kill av HELE prosessgruppen (container-PID-namespace) ved timeout og ved dispose.
 *
 * Finnes ikke runneren (`JARVIS_JOB_RUNNER=container` + gyldig konfig), er den ENESTE tilgjengelige
 * implementasjonen `FailClosedSandboxRunner`: jobben feiler med `job_container_runner_not_configured` -
 * den faller ALDRI tilbake til prosess-sandbox. Worker-containeren har ikke Docker-socket; en reell
 * runner krever en egen, vertsside runner-tjeneste (se docs/remediation/PHASE_2_GATE.md, `BLOCKED_EXTERNAL`).
 */

const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const FORBIDDEN_NETWORKS: ReadonlySet<string> = new Set(["host", "bridge", "none", "default"]);
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Navn som ALDRI kan inn i en jobb-container (vault-hovednøkkel, DB-superbruker, observability-hemmeligheter m.m.). */
const FORBIDDEN_ENV =
  /^(INFISICAL_|JARVIS_DB_|POSTGRES_|PG|NEXTAUTH_|SALT$|LANGFUSE_|AUTH_SECRET$|ENCRYPTION_KEY$|JARVIS_BROWSER_GATEWAY_TOKEN_SECRET$)|(_ENCRYPTION_KEY|_MASTER_KEY|_PRIVATE_KEY_PEM)$/;

export class JobContainerConfigError extends Error {
  constructor(readonly reason: string) {
    super(`job_container_config_invalid:${reason}`);
    this.name = "JobContainerConfigError";
  }
}

export interface JobContainerPolicy {
  /** Image PINNET til digest (`...@sha256:<64 hex>`). Flytende tagger nektes. */
  image: string;
  /** Eksisterende docker-nettverk for jobber (internal; når kun egress-proxyen). `host`/`bridge`/`none` nektes. */
  network: string;
  /** `http(s)://host:port` til egress-proxyen med vert-allowlist (github.com, api.anthropic.com). */
  egressProxyUrl: string;
  user?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
  dockerBin?: string;
  /** KUN tester: tillat uten digest. */
  allowUnpinnedImage?: boolean;
}

export function validateJobContainerPolicy(policy: JobContainerPolicy): void {
  if (!(policy.allowUnpinnedImage === true) && !DIGEST_PINNED_IMAGE.test(policy.image)) {
    throw new JobContainerConfigError("image_not_digest_pinned");
  }
  if (!NETWORK_NAME.test(policy.network) || FORBIDDEN_NETWORKS.has(policy.network)) {
    throw new JobContainerConfigError("network_must_be_a_dedicated_jobs_network");
  }
  let proxy: URL;
  try {
    proxy = new URL(policy.egressProxyUrl);
  } catch {
    throw new JobContainerConfigError("egress_proxy_url_invalid");
  }
  if (!(proxy.protocol === "http:" || proxy.protocol === "https:") || proxy.username !== "" || proxy.password !== "") {
    throw new JobContainerConfigError("egress_proxy_url_invalid");
  }
  const user = policy.user ?? "10001:10001";
  if (!/^\d+:\d+$/.test(user) || user.startsWith("0:") || user === "0") {
    throw new JobContainerConfigError("user_must_be_non_root_numeric");
  }
}

/** Ren, deterministisk bygging av `docker create`-argv. Returnerer aldri hemmelige VERDIER - kun env-NAVN. */
export function buildJobContainerCreateArgs(
  policy: JobContainerPolicy,
  job: { containerName: string; workdir: string; envNames: readonly string[] }
): string[] {
  validateJobContainerPolicy(policy);
  if (!SAFE_PATH.test(job.workdir) || job.workdir.includes("..")) {
    throw new JobContainerConfigError("workdir_path_unsafe");
  }
  if (!/^jarvis-job-[a-f0-9-]{36}$/.test(job.containerName)) {
    throw new JobContainerConfigError("container_name_invalid");
  }
  for (const name of job.envNames) {
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name)) {
      throw new JobContainerConfigError(`env_name_forbidden:${name}`);
    }
  }
  const proxy = policy.egressProxyUrl;
  return [
    "create",
    "--name", job.containerName,
    "--init", // PID 1 høster zombier og videresender signaler
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize ?? "256m"}`,
    "--tmpfs", `/home/job:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize ?? "256m"},uid=10001,gid=10001`,
    "--mount", `type=bind,source=${job.workdir},target=/work`,
    "--workdir", "/work",
    "--user", policy.user ?? "10001:10001",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--memory", policy.memory ?? "1g",
    "--memory-swap", policy.memory ?? "1g",
    "--cpus", policy.cpus ?? "1.0",
    "--pids-limit", String(policy.pidsLimit ?? 256),
    "--network", policy.network,
    "--label", "jarvis.role=job",
    "-e", `HTTP_PROXY=${proxy}`, "-e", `HTTPS_PROXY=${proxy}`, "-e", `http_proxy=${proxy}`, "-e", `https_proxy=${proxy}`,
    "-e", "NO_PROXY=", "-e", "no_proxy=",
    "-e", "HOME=/home/job",
    ...job.envNames.flatMap((name) => ["-e", name]),
    policy.image,
    "sleep", "infinity"
  ];
}

export interface DockerExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type DockerExec = (bin: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number }) => DockerExecResult;

const defaultExec: DockerExec = (bin, args, options) => {
  const r = spawnSync(bin, args, {
    encoding: "utf8", shell: false, ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    ...(options.env !== undefined ? { env: options.env } : {})
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
};

/**
 * Per-jobb container-runner. Implementerer det eksisterende `SandboxRunner`-grensesnittet slik at
 * `createCodingHandler` er uendret, men BARE med en container som oppfyller `JobContainerPolicy`.
 */
export class DockerJobSandboxRunner implements SandboxRunner {
  readonly name = "docker-job-container";

  constructor(
    private readonly policy: JobContainerPolicy,
    private readonly exec: DockerExec = defaultExec,
    private readonly hostEnv: Record<string, string | undefined> = process.env
  ) {
    validateJobContainerPolicy(policy);
  }

  async create(jobEnv: Record<string, string> = {}): Promise<Sandbox> {
    const bin = this.policy.dockerBin ?? "docker";
    const envNames = Object.keys(jobEnv);
    const workdir = await mkdtemp(join(tmpdir(), "jarvis-job-"));
    const containerName = `jarvis-job-${randomUUID()}`;
    const createArgs = buildJobContainerCreateArgs(this.policy, { containerName, workdir, envNames });
    // Verdiene leveres til `docker`-prosessens EGEN env og videresendes med `-e NAVN` - de står aldri i argv.
    const baseEnv: Record<string, string> = { PATH: this.hostEnv["PATH"] ?? "" };
    const createEnv = { ...baseEnv, ...jobEnv };
    const created = this.exec(bin, createArgs, { env: createEnv, timeoutMs: 30_000 });
    if (created.status !== 0) {
      await rm(workdir, { recursive: true, force: true });
      throw new Error("job_container_create_failed");
    }
    const started = this.exec(bin, ["start", containerName], { env: baseEnv, timeoutMs: 30_000 });
    if (started.status !== 0) {
      this.exec(bin, ["rm", "-f", containerName], { env: baseEnv, timeoutMs: 30_000 });
      await rm(workdir, { recursive: true, force: true });
      throw new Error("job_container_start_failed");
    }
    let dead = false;
    const kill = (): void => {
      dead = true;
      // `rm -f` dreper HELE container-prosessgruppen (PID-namespace) - ikke bare `docker exec`-klienten.
      this.exec(bin, ["rm", "-f", containerName], { env: baseEnv, timeoutMs: 30_000 });
    };
    return {
      workdir,
      exec: (command: string, args: string[], timeoutMs = 60_000, extraEnv?: Record<string, string>): ExecResult => {
        if (dead) {
          return { code: 1, stdout: "", stderr: "job_container_terminated" };
        }
        const extraNames = Object.keys(extraEnv ?? {});
        for (const name of extraNames) {
          if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name)) {
            return { code: 1, stdout: "", stderr: `job_env_forbidden:${name}` };
          }
        }
        const execArgs = ["exec", "--workdir", "/work", ...extraNames.flatMap((n) => ["-e", n]), containerName, command, ...args];
        const result = this.exec(bin, execArgs, { env: { ...baseEnv, ...(extraEnv ?? {}) }, timeoutMs });
        if (result.timedOut) {
          kill();
          return { code: 124, stdout: result.stdout, stderr: `${result.stderr}\njob_exec_timeout` };
        }
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
      dispose: async (): Promise<void> => {
        if (!dead) kill();
        await rm(workdir, { recursive: true, force: true });
      }
    };
  }
}

/** Den eneste tilgjengelige «runneren» når ingen gyldig container-runner er konfigurert: ALLE jobber feiler. */
export class FailClosedSandboxRunner implements SandboxRunner {
  readonly name = "fail-closed";
  constructor(readonly reason: string) {}

  async create(): Promise<Sandbox> {
    throw new Error(`job_container_runner_not_configured:${this.reason}`);
  }
}

/**
 * Velger kodejobb-runner fra miljøet. `JARVIS_JOB_RUNNER=container` + gyldig `JARVIS_JOB_IMAGE` (digest-pinnet),
 * `JARVIS_JOB_NETWORK` og `JARVIS_JOB_EGRESS_PROXY` gir `DockerJobSandboxRunner`; ALT annet - inkludert det
 * gamle `JARVIS_SANDBOX=process|docker` - gir `FailClosedSandboxRunner`. Aldri en stille nedgradering.
 */
export function resolveJobSandboxRunner(env: Record<string, string | undefined> = process.env): SandboxRunner {
  if (env["JARVIS_JOB_RUNNER"] !== "container") {
    return new FailClosedSandboxRunner("JARVIS_JOB_RUNNER_not_container");
  }
  const policy: JobContainerPolicy = {
    image: env["JARVIS_JOB_IMAGE"] ?? "",
    network: env["JARVIS_JOB_NETWORK"] ?? "",
    egressProxyUrl: env["JARVIS_JOB_EGRESS_PROXY"] ?? "",
    ...(env["JARVIS_DOCKER_BIN"] ? { dockerBin: env["JARVIS_DOCKER_BIN"] } : {})
  };
  try {
    return new DockerJobSandboxRunner(policy);
  } catch (err) {
    return new FailClosedSandboxRunner(err instanceof JobContainerConfigError ? err.reason : "invalid_configuration");
  }
}
