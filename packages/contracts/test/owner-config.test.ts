import { describe, expect, it } from "vitest";
import { OwnerConfigError, describeOwnerConfigError, loadOwnerConfig, systemIdentity } from "../src/owner-config.ts";

const OK = { JARVIS_TENANT_ID: "tenant-acme", JARVIS_OWNER_PERSON_ID: "person-ola", JARVIS_OWNER_NAME: "Ola Nordmann" };

describe("Remediering del 2 (JARVIS-065): loadOwnerConfig - én validert eier-identitet, fail closed", () => {
  it("leser og normaliserer gyldig konfig", () => {
    expect(loadOwnerConfig({ ...OK, JARVIS_OWNER_NAME: "  Ola Nordmann " })).toEqual({
      tenant_id: "tenant-acme", owner_person_id: "person-ola", owner_display_name: "Ola Nordmann"
    });
  });
  it.each(["JARVIS_TENANT_ID", "JARVIS_OWNER_PERSON_ID", "JARVIS_OWNER_NAME"])("mangler %s -> owner_config_missing (ingen default)", (name) => {
    for (const value of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { ...OK, [name]: value };
      expect(() => loadOwnerConfig(env)).toThrow(OwnerConfigError);
      try { loadOwnerConfig(env); } catch (err) {
        expect((err as OwnerConfigError).code).toBe("owner_config_missing");
        expect((err as OwnerConfigError).variable).toBe(name);
      }
    }
  });
  it.each(["Tenant With Space", "UPPER", "a", "../x", "x;drop", "a".repeat(65), "tenant\nid"])("ugyldig id %j avvises", (bad) => {
    expect(() => loadOwnerConfig({ ...OK, JARVIS_TENANT_ID: bad })).toThrow(/owner_config_invalid/);
    expect(() => loadOwnerConfig({ ...OK, JARVIS_OWNER_PERSON_ID: bad })).toThrow(/owner_config_invalid/);
  });
  it("ugyldig visningsnavn (kontrolltegn, <>, for langt) avvises", () => {
    for (const bad of ["a\u0000b", "<script>", "x".repeat(81)]) {
      expect(() => loadOwnerConfig({ ...OK, JARVIS_OWNER_NAME: bad })).toThrow(/owner_config_invalid/);
    }
  });
  it("feilmeldingen inneholder kun kode + variabelnavn, aldri verdien", () => {
    try { loadOwnerConfig({ ...OK, JARVIS_TENANT_ID: "Secret Value!" }); } catch (err) {
      expect((err as Error).message).not.toContain("Secret");
      expect(describeOwnerConfigError(err)).toContain("JARVIS_TENANT_ID");
      expect(describeOwnerConfigError(err)).not.toContain("Secret");
    }
  });
});

describe("systemIdentity: unike, ikke-falske sesjoner", () => {
  const owner = loadOwnerConfig(OK);
  it("bruker eierens tenant/person, kanal 'system', og unik sesjons-id per kall", () => {
    const a = systemIdentity(owner, "brief");
    const b = systemIdentity(owner, "brief");
    expect(a.person_id).toBe("person-ola");
    expect(a.tenant_id).toBe("tenant-acme");
    expect(a.channel).toBe("system");
    expect(a.session_id).toMatch(/^sess-sys-brief-[0-9a-f]{8}$/);
    expect(a.session_id).not.toBe(b.session_id);
    for (const fixed of ["sess-brief", "sess-worker", "sess-coding"]) expect(a.session_id).not.toBe(fixed);
  });
  it("overrides gjelder, ugyldig formål kaster", () => {
    expect(systemIdentity(owner, "worker", { channel: "api" }).channel).toBe("api");
    expect(() => systemIdentity(owner, "Bad Purpose")).toThrow("system_identity_purpose_invalid");
  });
});
