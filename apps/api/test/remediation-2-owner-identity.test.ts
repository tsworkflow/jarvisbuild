import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Remediering del 2 (JARVIS-065): ÉN eier-identitet fra validert konfig.
 *  - prosessinngangene feiler lukket (exit 1) uten gyldig eier-konfig, med kun variabelnavn i loggen,
 *  - ingen hardkodet `person-tobias`/`tenant-personal`, ingen `?? "..."`-default, ingen falske faste sesjons-id-er i produksjonskode.
 */
const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ROOT = resolve(API_SRC, "..", "..", "..");
const read = (p: string): string => readFileSync(p, "utf8");

describe("fail closed ved oppstart", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "-e",
      `import("${join(API_SRC, "owner.ts")}").then((m) => { const o = m.ownerConfigOrExit(); console.log(JSON.stringify(o)); })`],
    { env: { PATH: process.env["PATH"] ?? "", ...env }, encoding: "utf8" });

  it("uten eier-konfig: exit 1 og feilkode + variabelnavn (aldri en default-identitet)", () => {
    const res = run({});
    expect(res.status).toBe(1);
    const log = JSON.parse(res.stderr.trim().split("\n").at(-1) as string) as { msg: string; detail: string };
    expect(log.msg).toBe("owner_config_invalid_refusing_to_start");
    expect(log.detail).toContain("owner_config_missing");
    expect(log.detail).toContain("JARVIS_TENANT_ID");
    expect(res.stdout).not.toContain("person-tobias");
  });
  it("ugyldig verdi: exit 1 uten å lekke verdien", () => {
    const res = run({ JARVIS_TENANT_ID: "BAD VALUE secret", JARVIS_OWNER_PERSON_ID: "person-ola", JARVIS_OWNER_NAME: "Ola" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("owner_config_invalid");
    expect(res.stderr).not.toContain("BAD VALUE");
  });
  it("gyldig konfig: prosessen får nøyaktig den ene identiteten", () => {
    const res = run({ JARVIS_TENANT_ID: "tenant-acme", JARVIS_OWNER_PERSON_ID: "person-ola", JARVIS_OWNER_NAME: "Ola" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ tenant_id: "tenant-acme", owner_person_id: "person-ola", owner_display_name: "Ola" });
  });
});

describe("produksjonskode har ingen konkurrerende eier-kilder", () => {
  const entrypoints = ["main.ts", "worker-main.ts", "migrate-main.ts", "enroll-ticket-main.ts", "seed.ts"];
  it.each(entrypoints)("%s: ingen hardkodet eier og ingen env-default", (file) => {
    const src = read(join(API_SRC, file));
    expect(src).not.toMatch(/\?\?\s*"person-tobias"/);
    expect(src).not.toMatch(/\?\?\s*"tenant-personal"/);
    expect(src).not.toMatch(/["']person-tobias["']|["']tenant-personal["']/);
    expect(src).not.toMatch(/process\.env\["JARVIS_OWNER_PERSON_ID"\]\s*\?\?/);
    expect(src).not.toMatch(/process\.env\["JARVIS_TENANT_ID"\]\s*\?\?/);
  });
  it.each(["main.ts", "worker-main.ts", "migrate-main.ts", "enroll-ticket-main.ts"])("%s: kaller ownerConfigOrExit()", (file) => {
    expect(read(join(API_SRC, file))).toContain("ownerConfigOrExit()");
  });
  it("main.ts gir serveren eier-identiteten (ellers 503 owner_not_configured på /chat, /dashboard, /voice i produksjon)", () => {
    const src = read(join(API_SRC, "main.ts"));
    const deps = src.slice(src.indexOf("const deps: ApiDeps = {"));
    expect(deps).toMatch(/owner:\s*\{\s*tenant_id:\s*owner\.tenant_id,\s*person_id:\s*owner\.owner_person_id\s*\}/);
  });
  it("ingen falske faste sesjons-id-er (sess-brief/sess-worker/sess-coding/...) i prosessinngangene", () => {
    for (const file of ["main.ts", "worker-main.ts"]) {
      const src = read(join(API_SRC, file));
      for (const fixed of ["sess-brief", "sess-worker", "sess-coding", "sess-situation-sweep", "sess-business-weekly-brief"]) {
        expect(src, `${file}: ${fixed}`).not.toContain(`"${fixed}"`);
      }
      expect(src).toContain("systemIdentity(owner,");
    }
  });
  it("web-sidene har ingen hardkodet eier (se også remediation-2-static-pages)", () => {
    const dir = join(ROOT, "apps", "web");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
      expect(read(join(dir, f)), f).not.toMatch(/person-tobias|tenant-personal/);
    }
  });
  it("compose krever eier-konfig for api/worker/migrate (manifest + .env.example)", () => {
    const manifest = read(join(ROOT, "infra", "local", "service-env.mjs"));
    for (const name of ["JARVIS_TENANT_ID", "JARVIS_OWNER_PERSON_ID", "JARVIS_OWNER_NAME"]) {
      expect(manifest).toContain(`"${name}"`);
      expect(read(join(ROOT, ".env.example"))).toContain(`${name}=`);
    }
  });
});
