import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCompose,
  checkDockerfile,
  checkEntrypoints,
  checkEnvExample,
  checkScratchImageMatchesCompose,
  extractCall,
  publishedPorts,
  parseComposeServices,
  runChecks
} from "../check-containment.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIGEST = "@sha256:" + "a".repeat(64);

const compose = (service) => `services:\n${service}\nvolumes:\n  data:\n`;
const svc = (name, body) => `  ${name}:\n${body}`;

describe("repoet slik det ligger nå", () => {
  it("alle containment-invarianter holder (compose, Dockerfiler, entrypoints, .env.example, scratch-image)", () => {
    expect(runChecks(ROOT)).toEqual([]);
  });
});

describe("compose-porter: åpne publiseringer avvises", () => {
  const bad = [
    ['"5432:5432"', "ALL interfaces"],
    ['"0.0.0.0:3050:3000"', "0.0.0.0"],
    ['"${JARVIS_API_PORT:-3010}:3010"', "ALL interfaces"],
    ['"[::]:3060:8080"', "[::]"],
    ["3030:3030", "ALL interfaces"],
    ['"192.168.1.5:5432:5432"', "192.168.1.5"]
  ];
  for (const [entry, expected] of bad) {
    it(`avviser ${entry}`, () => {
      const v = checkCompose(compose(svc("postgres", `    image: pgvector/pgvector:pg16${DIGEST}\n    ports:\n      - ${entry}\n`)));
      expect(v.length).toBeGreaterThan(0);
      expect(v.join("\n")).toContain(expected);
    });
  }

  it("godtar kun loopback (kort og lang syntaks)", () => {
    const ok = compose(
      svc("postgres", `    image: pgvector/pgvector:pg16${DIGEST}\n    ports:\n      - "127.0.0.1:\${JARVIS_DB_PORT:-5432}:5432"\n      - "[::1]:5433:5432"\n`) +
        svc("api", `    <<: *hardening\n    image: x/y:1${DIGEST}\n    ports:\n      - target: 3010\n        published: 3010\n        host_ip: 127.0.0.1\n`)
    );
    expect(checkCompose(ok)).toEqual([]);
  });

  it("lang syntaks uten host_ip, eller med 0.0.0.0, avvises", () => {
    const noIp = compose(svc("api", `    <<: *hardening\n    image: x/y:1${DIGEST}\n    ports:\n      - target: 3010\n        published: 3010\n`));
    expect(checkCompose(noIp).join("\n")).toContain("ALL interfaces");
    const wide = compose(svc("api", `    <<: *hardening\n    image: x/y:1${DIGEST}\n    ports:\n      - target: 3010\n        published: 3010\n        host_ip: 0.0.0.0\n`));
    expect(checkCompose(wide).join("\n")).toContain("0.0.0.0");
  });

  it("browser-gateway (og redis/worker/migrate) skal ikke publisere NOEN port, heller ikke på loopback", () => {
    const v = checkCompose(compose(svc("browser-gateway", `    image: x/y:1${DIGEST}\n    ports:\n      - "127.0.0.1:3030:3030"\n`)));
    expect(v.join("\n")).toContain("must not publish any host port");
  });

  it("host-nettverk, privilegert modus, Docker-socket og flytende image avvises", () => {
    const v = checkCompose(
      compose(
        svc("a", `    image: redis:7-alpine\n    network_mode: host\n`) +
          svc("b", `    image: x/y:1${DIGEST}\n    privileged: true\n`) +
          svc("c", `    image: x/y:1${DIGEST}\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`)
      )
    ).join("\n");
    expect(v).toContain("network_mode: host");
    expect(v).toContain("privileged");
    expect(v).toContain("Docker socket");
    expect(v).toContain("not pinned");
  });

  it("rå-lyd-dump-variabelen kan ikke videresendes i compose", () => {
    const v = checkCompose(compose(svc("voice-gateway", `    image: x/y:1${DIGEST}\n    environment:\n      JARVIS_VOICE_DEBUG_DUMP_DIR: "\${JARVIS_VOICE_DEBUG_DUMP_DIR:-}"\n`)));
    expect(v.join("\n")).toContain("JARVIS_VOICE_DEBUG_DUMP_DIR");
  });

  it("kommentarer teller ikke (en kommentert port-linje er ikke en publisering)", () => {
    const text = compose(svc("postgres", `    image: pgvector/pgvector:pg16${DIGEST}\n    ports:\n      # - "5432:5432"\n      - "127.0.0.1:5432:5432"\n`));
    expect(checkCompose(text)).toEqual([]);
    expect(publishedPorts(parseComposeServices(text)["postgres"])).toHaveLength(1);
  });
});

describe("Dockerfile-baseimages", () => {
  it("flytende FROM avvises; digest og stage-referanser godtas", () => {
    expect(checkDockerfile("FROM node:22-alpine\nUSER node\n", "x.Dockerfile")).toHaveLength(1);
    expect(checkDockerfile(`FROM node:22-alpine${DIGEST}\nUSER node\n`, "x.Dockerfile")).toEqual([]);
    expect(checkDockerfile(`FROM debian:bookworm-slim${DIGEST} AS build\nFROM build AS final\nUSER 1000\n`, "x.Dockerfile")).toEqual([]);
    expect(checkDockerfile(`FROM debian:bookworm-slim${DIGEST} AS build\nFROM node:22 AS runtime\nUSER node\n`, "x.Dockerfile")).toHaveLength(1);
  });
});

describe("entrypoints", () => {
  const good = {
    "apps/api/src/main.ts": "const s = resolveModelToolSurface(toolGateway);\n",
    "apps/api/src/worker-main.ts": "const s = resolveModelToolSurface(toolGateway, { onlyRegistered: true });\nexecutiveHandler({ gateway, tools })\ncreateCodingHandler({ sandbox: runner })\n",
    "apps/api/src/server.ts": 'if (deps.enableDevRoutes === true && req.method === "POST" && url.pathname === "/worker/tick") {\n',
    "apps/api/src/executive.ts": "export function executiveHandler() {}\n"
  };
  it("rent oppsett godtas", () => {
    expect(checkEntrypoints(good)).toEqual([]);
  });
  it("full mesh, delegering, selvmodifikasjon og dev-ruter inn igjen avvises", () => {
    for (const [file, add, expected] of [
      ["apps/api/src/main.ts", "const t = allMeshTools(toolGateway);", "allMeshTools("],
      ["apps/api/src/main.ts", "const t = [...fullMeshTools];", "fullMeshTools"],
      ["apps/api/src/main.ts", "const d = SPECIALIST_DELEGATION_TOOLS;", "SPECIALIST_DELEGATION_TOOLS"],
      ["apps/api/src/main.ts", "new SelfModificationService({});", "SelfModificationService"],
      ["apps/api/src/main.ts", "setInterval(() => svc.sweepApprovedRequests(), 1)", "sweepApprovedRequests"],
      ["apps/api/src/main.ts", "const deps = { enableDevRoutes: true };", "enableDevRoutes"],
      ["apps/api/src/worker-main.ts", "const t = allMeshTools(toolGateway);", "allMeshTools("],
      ["apps/api/src/executive.ts", "const sb = opts.sandbox.create();", "sandbox branch"]
    ]) {
      const files = { ...good, [file]: good[file] + add + "\n" };
      expect(checkEntrypoints(files).join("\n"), `${file} + ${add}`).toContain(expected);
    }
  });
  it("manglende resolveModelToolSurface avvises", () => {
    expect(checkEntrypoints({ ...good, "apps/api/src/main.ts": "const a = 1;\n" }).join("\n")).toContain("resolveModelToolSurface");
  });
  it("ugated /worker/tick eller /tools/critical-demo avvises", () => {
    const server = 'if (req.method === "POST" && url.pathname === "/tools/critical-demo") {\n';
    expect(checkEntrypoints({ ...good, "apps/api/src/server.ts": server }).join("\n")).toContain("not gated");
  });
  it("sandbox til executiveHandler i worker avvises, men sandbox til coding-handleren er lov", () => {
    const bad = { ...good, "apps/api/src/worker-main.ts": good["apps/api/src/worker-main.ts"].replace("executiveHandler({ gateway, tools })", "executiveHandler({ gateway, tools, sandbox: runner })") };
    expect(checkEntrypoints(bad).join("\n")).toContain("passes a sandbox to executiveHandler");
    expect(extractCall("a executiveHandler({ x: f(1) }) b )", "executiveHandler(")).toBe("executiveHandler({ x: f(1) })");
  });
});

describe(".env.example og scratch-image", () => {
  it("setter ikke rå-lyd-dump som standard (kommentert linje er ok)", () => {
    expect(checkEnvExample("# JARVIS_VOICE_DEBUG_DUMP_DIR=/x\nJARVIS_VOICE_DEBUG_DUMP_DIR=\n")).toEqual([]);
    expect(checkEnvExample("JARVIS_VOICE_DEBUG_DUMP_DIR=/voice-debug\n")).toHaveLength(1);
    expect(checkEnvExample("JARVIS_VOICE_DEBUG_DUMP_CONSENT=I_ACCEPT_RAW_AUDIO_ON_DISK\n")).toHaveLength(1);
  });
  it("scratch-imaget i restore-skriptet må være det samme som compose sitt pgvector-image", () => {
    const c = `image: pgvector/pgvector:pg16${DIGEST}`;
    expect(checkScratchImageMatchesCompose(c, `IMAGE="pgvector/pgvector:pg16${DIGEST}"\n`)).toEqual([]);
    expect(checkScratchImageMatchesCompose(c, `IMAGE="pgvector/pgvector:pg16@sha256:${"b".repeat(64)}"\n`)).toHaveLength(1);
    expect(checkScratchImageMatchesCompose(c, "")).toHaveLength(1);
  });
});

describe("Del 2: isolasjon (JARVIS-009/010/011) - strukturelle invarianter", () => {
  const hardened = "    <<: *hardening\n";
  it("avviser env_file, cap_add, unconfined seccomp og root-user", () => {
    for (const extra of ["    env_file: [../../.env]\n", "    cap_add: [SYS_ADMIN]\n", "    security_opt: [seccomp=unconfined]\n", "    user: root\n"]) {
      const v = checkCompose(compose(svc("api", `${hardened}${extra}`)));
      expect(v.length, extra).toBeGreaterThan(0);
    }
  });
  it("cap_add: kun SYS_CHROOT på browser-gateway (D-365); alt annet avvises", () => {
    const b = (extra) => checkCompose(compose(svc("browser-gateway", `${hardened}    networks: [browser]\n${extra}`)));
    expect(b('    cap_add: ["SYS_CHROOT"]\n')).toEqual([]);
    expect(b("    cap_add:\n      - SYS_CHROOT\n")).toEqual([]);
    expect(b('    cap_add: ["SYS_ADMIN"]\n').length).toBeGreaterThan(0);
    expect(b('    cap_add: ["SYS_CHROOT", "NET_ADMIN"]\n').length).toBeGreaterThan(0);
    expect(b("    cap_add:\n      - SYS_CHROOT\n      - SYS_ADMIN\n").length).toBeGreaterThan(0);
    // SYS_CHROOT er ikke et generelt unntak: andre tjenester får ikke legge den til.
    expect(checkCompose(compose(svc("api", `${hardened}    cap_add: ["SYS_CHROOT"]\n`))).length).toBeGreaterThan(0);
  });
  it("krever herding på api/worker/migrate/voice/browser", () => {
    const v = checkCompose(compose(svc("worker", "    command: [node]\n")));
    expect(v.some((x) => x.includes("drop all capabilities"))).toBe(true);
    expect(v.some((x) => x.includes("no-new-privileges"))).toBe(true);
    expect(v.some((x) => x.includes("read-only"))).toBe(true);
    expect(checkCompose(compose(svc("worker", hardened)))).toEqual([]);
  });
  it("browser-gateway kan kun ligge på browser-nettverket", () => {
    const body = `${hardened}    networks: [core, browser]\n`;
    expect(checkCompose(compose(svc("browser-gateway", body))).some((x) => x.includes("ONLY"))).toBe(true);
    expect(checkCompose(compose(svc("browser-gateway", `${hardened}    networks: [browser]\n`)))).toEqual([]);
  });
  it("vault/DB-admin-hemmeligheter nektes i api/worker/voice/browser", () => {
    for (const name of ["api", "worker", "voice-gateway", "browser-gateway"]) {
      const v = checkCompose(compose(svc(name, `${hardened}    environment:\n      INFISICAL_ENCRYPTION_KEY: x\n`)));
      expect(v.some((x) => x.includes("INFISICAL_ENCRYPTION_KEY")), name).toBe(true);
    }
  });
  it("Dockerfile uten (eller med root) USER avvises", () => {
    expect(checkDockerfile(`FROM node:22${DIGEST}\n`, "x.Dockerfile")).toHaveLength(1);
    expect(checkDockerfile(`FROM node:22${DIGEST}\nUSER root\n`, "x.Dockerfile")).toHaveLength(1);
    expect(checkDockerfile(`FROM node:22${DIGEST}\nUSER node\n`, "x.Dockerfile")).toEqual([]);
  });
});
