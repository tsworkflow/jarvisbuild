import { describe, expect, it } from "vitest";
import {
  DockerJobSandboxRunner, FailClosedSandboxRunner, JobContainerConfigError, buildJobContainerCreateArgs,
  resolveJobSandboxRunner, validateJobContainerPolicy, type DockerExec, type JobContainerPolicy
} from "../src/job-container.ts";

/**
 * Remediering del 2 (JARVIS-010): per-jobb container-grensesnittet. Alt her er ATFERD/KONTRAKT mot
 * `docker`-argv og fail-closed-valg - ingen ekte Docker trengs (worker-containeren har heller ingen
 * Docker-socket). Ekte kjøring mot en runner-tjeneste er `BLOCKED_EXTERNAL`.
 */
const DIGEST = `node:22-bookworm-slim@sha256:${"a".repeat(64)}`;
const policy: JobContainerPolicy = { image: DIGEST, network: "jarvis-jobs", egressProxyUrl: "http://job-egress:3128" };
const NAME = "jarvis-job-123e4567-e89b-12d3-a456-426614174000";

describe("A: policy-validering (fail-closed)", () => {
  it("godtar en digest-pinnet image og dedikert jobb-nettverk", () => {
    expect(() => validateJobContainerPolicy(policy)).not.toThrow();
  });

  it("nekter flytende image-tagger og image uten digest", () => {
    for (const image of ["node:22", "node:latest", "node", "node:22@sha256:kort", `node:22@sha256:${"A".repeat(64)}`]) {
      expect(() => validateJobContainerPolicy({ ...policy, image }), image).toThrow(JobContainerConfigError);
    }
  });

  it("nekter host/bridge/none/default-nettverk (ingen direkte rute ut eller inn)", () => {
    for (const network of ["host", "bridge", "none", "default", "", "A B", "-x"]) {
      expect(() => validateJobContainerPolicy({ ...policy, network }), network).toThrow(JobContainerConfigError);
    }
  });

  it("nekter root-bruker og ugyldig proxy-URL", () => {
    for (const user of ["0:0", "0", "root", "0:10001"]) {
      expect(() => validateJobContainerPolicy({ ...policy, user }), user).toThrow(JobContainerConfigError);
    }
    for (const egressProxyUrl of ["", "ikke-url", "ftp://p:3128", "http://bruker:pw@p:3128"]) {
      expect(() => validateJobContainerPolicy({ ...policy, egressProxyUrl }), egressProxyUrl).toThrow(JobContainerConfigError);
    }
  });
});

describe("B: docker create-argv - grensene er faktisk til stede", () => {
  const args = buildJobContainerCreateArgs(policy, { containerName: NAME, workdir: "/tmp/jarvis-job-abc", envNames: ["ANTHROPIC_API_KEY"] });
  const has = (flag: string, value?: string): boolean => {
    const i = args.indexOf(flag);
    return i >= 0 && (value === undefined || args[i + 1] === value);
  };

  it("ikke-root, read-only rootfs, alle capabilities droppet, no-new-privileges", () => {
    expect(has("--user", "10001:10001")).toBe(true);
    expect(has("--read-only")).toBe(true);
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges:true")).toBe(true);
  });

  it("ressursgrenser og init (prosessgruppe-opprydding)", () => {
    expect(has("--memory", "1g")).toBe(true);
    expect(has("--memory-swap", "1g")).toBe(true);
    expect(has("--cpus", "1.0")).toBe(true);
    expect(has("--pids-limit", "256")).toBe(true);
    expect(has("--init")).toBe(true);
  });

  it("tmpfs for /tmp og hjem; kun /work er en bind-mount", () => {
    expect(args.filter((a) => a.startsWith("/tmp:") || a.startsWith("/home/job:"))).toHaveLength(2);
    expect(args.filter((a) => a.startsWith("type=bind"))).toEqual(["type=bind,source=/tmp/jarvis-job-abc,target=/work"]);
  });

  it("dedikert nettverk + proxy, aldri host-nettverk/privilegert/socket/devices", () => {
    expect(has("--network", "jarvis-jobs")).toBe(true);
    for (const forbidden of ["--privileged", "--pid", "--ipc", "--uts", "--device", "--cap-add", "--volumes-from", "--env-file", "--userns", "-v", "--volume"]) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("--network host");
    expect(args.join(" ")).toContain("HTTPS_PROXY=http://job-egress:3128");
  });

  it("env sendes KUN som NAVN (aldri verdier) - ingen hemmelig verdi kan havne i argv", () => {
    const secretArgs = buildJobContainerCreateArgs(policy, { containerName: NAME, workdir: "/tmp/j", envNames: ["ANTHROPIC_API_KEY"] });
    const i = secretArgs.lastIndexOf("-e");
    expect(secretArgs[i + 1]).toBe("ANTHROPIC_API_KEY");
    expect(secretArgs.join(" ")).not.toMatch(/ANTHROPIC_API_KEY=/);
  });

  it("nekter vault-/DB-/observability-nøkler som env-navn (ingen arvede secrets)", () => {
    for (const name of ["INFISICAL_ENCRYPTION_KEY", "INFISICAL_AUTH_SECRET", "JARVIS_DB_ADMIN_PASSWORD", "JARVIS_DB_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "NEXTAUTH_SECRET", "SALT", "LANGFUSE_SECRET_KEY", "JARVIS_WALLESTER_PRIVATE_KEY_PEM", "FOO_ENCRYPTION_KEY", "JARVIS_BROWSER_GATEWAY_TOKEN_SECRET", "1BAD", "A=B"]) {
      expect(() => buildJobContainerCreateArgs(policy, { containerName: NAME, workdir: "/tmp/j", envNames: [name] }), name).toThrow(JobContainerConfigError);
    }
  });

  it("nekter usikre stier og containernavn (mount-/argv-injeksjon)", () => {
    for (const workdir of ["relativ", "/tmp/a,source=/", "/tmp/../etc", "/tmp/a b", "/var/run/docker.sock\n"]) {
      expect(() => buildJobContainerCreateArgs(policy, { containerName: NAME, workdir, envNames: [] }), workdir).toThrow(JobContainerConfigError);
    }
    expect(() => buildJobContainerCreateArgs(policy, { containerName: "--privileged", workdir: "/tmp/j", envNames: [] })).toThrow(JobContainerConfigError);
  });
});

describe("C: DockerJobSandboxRunner - livssyklus og kill", () => {
  function recorder(handler: (args: string[]) => Partial<ReturnType<DockerExec>> = () => ({})): { exec: DockerExec; calls: Array<{ args: string[]; env?: Record<string, string> }> } {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const exec: DockerExec = (_bin, args, options) => {
      calls.push({ args, ...(options.env !== undefined ? { env: options.env } : {}) });
      return { status: 0, stdout: "", stderr: "", ...handler(args) };
    };
    return { exec, calls };
  }

  it("create → create+start; hemmelige VERDIER ligger i docker-prosessens env, ALDRI i argv", async () => {
    const { exec, calls } = recorder();
    const runner = new DockerJobSandboxRunner(policy, exec, { PATH: "/usr/bin" });
    const sandbox = await runner.create({ ANTHROPIC_API_KEY: "sk-ant-HEMMELIG-VERDI" });
    expect(calls.map((c) => c.args[0])).toEqual(["create", "start"]);
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("sk-ant-HEMMELIG-VERDI");
    expect(calls[0]?.env?.["ANTHROPIC_API_KEY"]).toBe("sk-ant-HEMMELIG-VERDI");
    // docker-prosessen arver IKKE resten av hostmiljøet (kun PATH + eksplisitte verdier)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["ANTHROPIC_API_KEY", "PATH"]);
    await sandbox.dispose();
  });

  it("exec kjører `docker exec` i /work med eksplisitte env-navn; ekstra env med forbudt navn nektes uten å kjøre", async () => {
    const { exec, calls } = recorder((args) => (args[0] === "exec" ? { stdout: "ok" } : {}));
    const sandbox = await new DockerJobSandboxRunner(policy, exec, { PATH: "/usr/bin" }).create();
    const ok = sandbox.exec("git", ["status"], 5_000, { JARVIS_GIT_TOKEN: "tok" });
    expect(ok).toEqual({ code: 0, stdout: "ok", stderr: "" });
    const execCall = calls.find((c) => c.args[0] === "exec");
    expect(execCall?.args.slice(0, 4)).toEqual(["exec", "--workdir", "/work", "-e"]);
    expect(execCall?.args.join(" ")).not.toContain("tok");
    const denied = sandbox.exec("env", [], 5_000, { INFISICAL_ENCRYPTION_KEY: "x" });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("job_env_forbidden");
    expect(calls.filter((c) => c.args[0] === "exec")).toHaveLength(1);
    await sandbox.dispose();
  });

  it("timeout dreper HELE containeren (`rm -f`), og senere exec feiler lukket", async () => {
    const { exec, calls } = recorder((args) => (args[0] === "exec" ? { status: null, timedOut: true } : {}));
    const sandbox = await new DockerJobSandboxRunner(policy, exec, { PATH: "/usr/bin" }).create();
    const hung = sandbox.exec("sleep", ["999"], 1_000);
    expect(hung.code).toBe(124);
    expect(calls.some((c) => c.args[0] === "rm" && c.args[1] === "-f")).toBe(true);
    const after = sandbox.exec("git", ["status"]);
    expect(after).toEqual({ code: 1, stdout: "", stderr: "job_container_terminated" });
    await sandbox.dispose();
  });

  it("dispose fjerner containeren; feilet create/start rydder og kaster", async () => {
    const ok = recorder();
    const sandbox = await new DockerJobSandboxRunner(policy, ok.exec, { PATH: "/usr/bin" }).create();
    await sandbox.dispose();
    expect(ok.calls.at(-1)?.args.slice(0, 2)).toEqual(["rm", "-f"]);

    const failCreate = recorder((args) => (args[0] === "create" ? { status: 1 } : {}));
    await expect(new DockerJobSandboxRunner(policy, failCreate.exec).create()).rejects.toThrow("job_container_create_failed");
    const failStart = recorder((args) => (args[0] === "start" ? { status: 1 } : {}));
    await expect(new DockerJobSandboxRunner(policy, failStart.exec).create()).rejects.toThrow("job_container_start_failed");
    expect(failStart.calls.some((c) => c.args[0] === "rm")).toBe(true);
  });

  it("konstruksjon med ugyldig policy kaster (ingen runner uten gyldig grense)", () => {
    expect(() => new DockerJobSandboxRunner({ ...policy, image: "node:latest" })).toThrow(JobContainerConfigError);
  });
});

describe("D: resolveJobSandboxRunner - fail-closed, aldri prosess-sandbox", () => {
  const valid = { JARVIS_JOB_RUNNER: "container", JARVIS_JOB_IMAGE: DIGEST, JARVIS_JOB_NETWORK: "jarvis-jobs", JARVIS_JOB_EGRESS_PROXY: "http://job-egress:3128" };

  it("gyldig konfig gir container-runner", () => {
    expect(resolveJobSandboxRunner(valid).name).toBe("docker-job-container");
  });

  it("alt annet gir FailClosedSandboxRunner - også det gamle JARVIS_SANDBOX=process|docker", async () => {
    for (const env of [{}, { JARVIS_SANDBOX: "process" }, { JARVIS_SANDBOX: "docker" }, { ...valid, JARVIS_JOB_RUNNER: "process" }, { ...valid, JARVIS_JOB_IMAGE: "node:22" }, { ...valid, JARVIS_JOB_NETWORK: "host" }, { ...valid, JARVIS_JOB_EGRESS_PROXY: "" }]) {
      const runner = resolveJobSandboxRunner(env);
      expect(runner).toBeInstanceOf(FailClosedSandboxRunner);
      await expect(runner.create()).rejects.toThrow(/^job_container_runner_not_configured:/);
    }
  });
});
