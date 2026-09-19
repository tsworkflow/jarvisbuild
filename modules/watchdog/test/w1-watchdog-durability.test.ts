// W1 (D-180) - WATCHDOG DURABLE EMERGENCY SHUTDOWN
//
// Denne suiten er DIREKTE svar på D182 sitt REAL_INTERNAL_GAP og ordrepunkt E
// ("Fix the masked regression / Do not rely only on pool-less KillSwitch tests").
//
// Den eksisterende `fase10-ops.test.ts`-testen brukte `new KillSwitch()` UTEN
// pool og en superuser-`adminPool`, og maskerte derfor BEGGE
// produksjonsdefektene fullstendig:
//   1. `costExplosionCheck` kalte den PROSESS-LOKALE `killSwitch.activate()`,
//      mens produksjonens `PolicyGateway.authorize()` sjekker
//      `isActiveDurable()` mot `owner_control_state` (K1/D-164).
//   2. `cost_events` er `FORCE ROW LEVEL SECURITY` (migrasjon 005) - en rå
//      pool-spørring uten tenant-kontekst summerer ALLTID 0 under den ekte
//      runtime-rollen.
//
// ALLE tester her bruker derfor `runtimePool` (`jarvis_w1`-rollen:
// NOSUPERUSER, NOBYPASSRLS, medlem av `jarvis_app`) - IKKE `adminPool`.
// `adminPool` brukes UTELUKKENDE til migrering/fikstur-oppsett og
// verifiserende tilbakelesing, aldri til atferden under test.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, runMigrations, withTenantTransaction } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  AlertDeliveryError, MemoryAlertSink, TelegramAlertSink, WATCHDOG_COST_EXPLOSION_REASON_PREFIX,
  WATCHDOG_DEFAULT_INTERVAL_MS, WATCHDOG_MAX_INTERVAL_MS, WATCHDOG_MIN_INTERVAL_MS,
  Watchdog, type Alert, type AlertSink, costExplosionCheck, formatAlertMessage,
  resolveWatchdogIntervalMs, resolveWatchdogTenantIds
} from "@jarvis/watchdog";

const TENANT = "tenant-w1";
const OWNER = "person-tobias";
const AUTHORITY = { owner_person_id: OWNER };
const HARD_LIMIT_ORE = 300_000;

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
/** Den EKTE, RLS-underlagte rollen - alt som er "atferd under test" går gjennom denne. */
let runtimePool: pg.Pool;

function runtimeConfig(): { host: string; port: number; database: string; user: string; password: string } {
  return { host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_w1", password: "pw2" };
}

function buildCheck(pool: pg.Pool, killSwitch: KillSwitch) {
  return costExplosionCheck(pool, killSwitch, {
    hardLimitOre: HARD_LIMIT_ORE, tenantIds: [TENANT], actorPersonId: OWNER
  });
}

async function readDurableRow(): Promise<{ reason: string; actor_person_id: string | null } | null> {
  const { rows } = await adminPool.query(
    `SELECT reason, actor_person_id FROM owner_control_state WHERE control_kind = 'kill_switch' AND control_target = 'GLOBAL'`
  );
  return (rows[0] as { reason: string; actor_person_id: string | null } | undefined) ?? null;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-w1-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // NOSUPERUSER/NOBYPASSRLS er default for CREATE ROLE - eksplisitt her fordi
  // HELE poenget med denne suiten er at RLS faktisk gjelder (jf. Q-21).
  await adminPool.query("CREATE ROLE jarvis_w1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_w1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Tobias W1','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
  runtimePool = createPool(runtimeConfig());
  runtimePool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(async () => {
  await adminPool.query("DELETE FROM owner_control_state WHERE control_kind = 'kill_switch'");
  await adminPool.query(`DELETE FROM cost_events WHERE tenant_id = '${TENANT}'`);
});

describe("A) runtime-rollen er faktisk RLS-underlagt - uten dette beviser resten av suiten ingenting", () => {
  it("jarvis_w1 er NOSUPERUSER og NOBYPASSRLS (Q-21-forutsetningen denne suiten hviler på)", async () => {
    const { rows } = await runtimePool.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("REGRESJONSVAKT for den maskerte defekten: en RÅ cost_events-spørring UTEN tenant-kontekst ser 0 øre, mens den tenant-skopede ser hele beløpet", async () => {
    await seedSpend(400_000);
    const raw = await runtimePool.query(
      `SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`
    );
    expect((raw.rows[0] as { spent: number }).spent).toBe(0); // <- nøyaktig den gamle produksjonsspørringen
    const scoped = await withTenantTransaction(runtimePool, TENANT, (client) =>
      client.query(`SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())`)
    );
    expect((scoped.rows[0] as { spent: number }).spent).toBe(400_000);
  });
});

describe("B) terskel IKKE nådd - den durable nødstoppen forblir inaktiv", () => {
  it("forbruk under hardgrensen gir ok-sjekk, ingen varsel og INGEN rad i owner_control_state", async () => {
    await seedSpend(HARD_LIMIT_ORE - 1);
    const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, killSwitch);
    watchdog.register(buildCheck(runtimePool, killSwitch));

    const fired = await watchdog.tick();

    expect(fired).toEqual([]);
    expect(sink.alerts).toEqual([]);
    expect(await killSwitch.isActiveDurable()).toBe(false);
    expect(await readDurableRow()).toBeNull();
  });
});

describe("C) terskel nådd - activateDurable kjøres og owner_control_state blir aktiv", () => {
  it("skriver EN rad med watchdog-proveniens i reason og den eksplisitte eier-aktøren", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, killSwitch);
    watchdog.register(buildCheck(runtimePool, killSwitch));

    const fired = await watchdog.tick();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe("critical");
    expect(await killSwitch.isActiveDurable()).toBe(true);
    const row = await readDurableRow();
    expect(row?.actor_person_id).toBe(OWNER);
    expect(row?.reason).toContain(WATCHDOG_COST_EXPLOSION_REASON_PREFIX);
    expect(row?.reason).toContain(String(HARD_LIMIT_ORE));
  });

  it("summerer på tvers av FLERE tenanter: to tenanter under grensen hver for seg, men over til sammen, utløser nødstoppen", async () => {
    const otherTenant = "tenant-w1-other";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,'Andre','person') ON CONFLICT DO NOTHING`, [otherTenant]);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [OWNER, otherTenant]);
    try {
      await seedSpend(200_000);
      await seedSpend(200_000, otherTenant);
      const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
      const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
      watchdog.register(
        costExplosionCheck(runtimePool, killSwitch, {
          hardLimitOre: HARD_LIMIT_ORE, tenantIds: [TENANT, otherTenant], actorPersonId: OWNER
        })
      );

      await watchdog.tick();

      expect(await killSwitch.isActiveDurable()).toBe(true);
      expect((await readDurableRow())?.reason).toContain("400000");
    } finally {
      await adminPool.query(`DELETE FROM cost_events WHERE tenant_id = $1`, [otherTenant]);
      await adminPool.query(`DELETE FROM person_tenants WHERE tenant_id = $1`, [otherTenant]);
      await adminPool.query(`DELETE FROM tenants WHERE tenant_id = $1`, [otherTenant]);
    }
  });
});

describe("D) en UAVHENGIG, andre pool + KillSwitch-instans ser den aktive tilstanden UMIDDELBART", () => {
  it("cross-pool-synlighet uten noen delt hukommelse og uten restore()", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const triggeringPool = createPool(runtimeConfig());
    const observingPool = createPool(runtimeConfig());
    try {
      const triggeringSwitch = new KillSwitch(triggeringPool, AUTHORITY);
      const observingSwitch = new KillSwitch(observingPool, AUTHORITY);
      // Bevis at observatøren starter blank: ingen restore(), ingen delt objekt.
      expect(observingSwitch.isActive()).toBe(false);

      const watchdog = new Watchdog(new MemoryAlertSink(), triggeringSwitch);
      watchdog.register(buildCheck(triggeringPool, triggeringSwitch));
      await watchdog.tick();

      expect(await observingSwitch.isActiveDurable()).toBe(true);
    } finally {
      await triggeringPool.end();
      await observingPool.end();
    }
  });
});

describe("E) PolicyGateway bygget på DEN UAVHENGIGE instansen håndhever nødstoppen", () => {
  it("et helt ordinært klasse A-verktøykall nektes med kill_switch_active etter watchdog-utløsningen", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const triggeringPool = createPool(runtimeConfig());
    const enforcingPool = createPool(runtimeConfig());
    try {
      const triggeringSwitch = new KillSwitch(triggeringPool, AUTHORITY);
      const enforcingSwitch = new KillSwitch(enforcingPool, AUTHORITY);
      const policy = new PolicyGateway({
        devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: enforcingSwitch
      });
      const request = {
        identity: {
          person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal" as const,
          session_id: "sess-w1", device_id: "dev-w1", channel: "web" as const, auth_strength: "active" as const
        },
        toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A" as const, parameters: {} }
      };
      // FØR: ikke nektet av kill switchen.
      expect((await policy.authorize(request)).reason).not.toBe("kill_switch_active");

      const watchdog = new Watchdog(new MemoryAlertSink(), triggeringSwitch);
      watchdog.register(buildCheck(triggeringPool, triggeringSwitch));
      await watchdog.tick();

      // ETTER: håndhevet gjennom en instans som aldri rørte watchdogen.
      expect((await policy.authorize(request)).reason).toBe("kill_switch_active");
    } finally {
      await triggeringPool.end();
      await enforcingPool.end();
    }
  });
});

describe("F) omstart-lignende rekonstruksjon - en HELT fersk KillSwitch(pool, authority) husker tilstanden", () => {
  it("restore() på en fersk instans i en fersk pool speiler den aktive tilstanden, og den kanoniske gjenopprettingsstien rydder den", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const bootPool = createPool(runtimeConfig());
    try {
      const killSwitch = new KillSwitch(bootPool, AUTHORITY);
      const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
      watchdog.register(buildCheck(bootPool, killSwitch));
      await watchdog.tick();
    } finally {
      await bootPool.end(); // "prosessen dør" - all in-memory-tilstand er borte
    }

    const restartedPool = createPool(runtimeConfig());
    try {
      const restarted = new KillSwitch(restartedPool, AUTHORITY);
      await restarted.restore(); // samme oppstartsdisiplin som worker-main.ts
      expect(restarted.isActive()).toBe(true);
      expect(await restarted.isActiveDurable()).toBe(true);

      // KANONISK gjenoppretting (D-164/D-166) - ingen egen watchdog-mekanisme.
      await restarted.deactivateDurable(OWNER);
      expect(await restarted.isActiveDurable()).toBe(false);
      expect(await readDurableRow()).toBeNull();
    } finally {
      await restartedPool.end();
    }
  });
});

describe("G) varslingsfeil kan ALDRI oppheve eller forhindre den durable nødstoppen", () => {
  class ThrowingAlertSink implements AlertSink {
    calls = 0;
    async send(): Promise<void> {
      this.calls += 1;
      throw new AlertDeliveryError("telegram_alert_credential_missing:JARVIS_TELEGRAM_TOKEN");
    }
  }

  it("en kastende AlertSink observeres, men nødstoppen står - og tick() kaster ikke videre", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
    const sink = new ThrowingAlertSink();
    const failures: Array<{ alert: Alert; error: Error }> = [];
    const watchdog = new Watchdog(sink, killSwitch, {
      onAlertFailed: (alert, error) => failures.push({ alert, error })
    });
    watchdog.register(buildCheck(runtimePool, killSwitch));

    await expect(watchdog.tick()).resolves.toHaveLength(1);

    expect(sink.calls).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBeInstanceOf(AlertDeliveryError);
    // Det AVGJØRENDE: tilstanden er uendret av varslingsfeilen.
    expect(await killSwitch.isActiveDurable()).toBe(true);
    expect((await readDurableRow())?.reason).toContain(WATCHDOG_COST_EXPLOSION_REASON_PREFIX);
  });

  it("TelegramAlertSink feiler ÅPENT (typet AlertDeliveryError) når tokenet mangler - aldri et stille 'sendt'", async () => {
    let invoked = 0;
    const sink = new TelegramAlertSink(
      { invoke: async () => { invoked += 1; return { external_id: "x" }; } },
      { get: async () => null }
    );
    await expect(sink.send(sampleAlert())).rejects.toBeInstanceOf(AlertDeliveryError);
    expect(invoked).toBe(0); // ingen HTTP-forsøk uten credential
  });

  it("TelegramAlertSink sender via den INJISERTE transporten med notify + fast format, og lekker ALDRI credential-verdien inn i meldingen", async () => {
    // Bevisst en NØYTRAL, ikke-hemmelig-formet fikstur-verdi: poenget er å
    // spore HVOR verdien havner, ikke å ligne på et ekte token (som ville gitt
    // en falsk positiv i gitleaks-jobben).
    const fixtureCredential = `fixture-value-${Math.random().toString(36).slice(2, 10)}`;
    const calls: Array<{ action: string; parameters: Record<string, string>; credential: string }> = [];
    const sink = new TelegramAlertSink(
      { invoke: async (action, parameters, credential) => { calls.push({ action, parameters, credential }); return { external_id: "42" }; } },
      { get: async () => fixtureCredential }
    );
    const alert = sampleAlert();

    await sink.send(alert);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.action).toBe("notify");
    expect(calls[0]?.credential).toBe(fixtureCredential); // KUN til transporten
    expect(calls[0]?.parameters["message"]).toBe(formatAlertMessage(alert));
    expect(calls[0]?.parameters["message"]).not.toContain(fixtureCredential);
  });
});

describe("H) gjentatte watchdog-sykluser korrumperer ikke tilstanden", () => {
  it("tre sykluser over grensen gir NØYAKTIG ÉN tilstandsskriving - reason og changed_at bevares (ingen UPSERT-overskriving av bevisene)", async () => {
    await seedSpend(HARD_LIMIT_ORE);
    const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, killSwitch);
    watchdog.register(buildCheck(runtimePool, killSwitch));

    await watchdog.tick();
    const first = await adminPool.query(
      `SELECT reason, changed_at FROM owner_control_state WHERE control_kind = 'kill_switch'`
    );
    await watchdog.tick();
    await watchdog.tick();
    const after = await adminPool.query(
      `SELECT reason, changed_at FROM owner_control_state WHERE control_kind = 'kill_switch'`
    );

    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toEqual(first.rows[0]); // uendret: hverken reason eller changed_at rørt
    // Varslene fortsetter (eieren skal fortsatt purres), men meldingen sier nå "allerede aktiv".
    expect(sink.alerts).toHaveLength(3);
    expect(sink.alerts[1]?.message).toContain("allerede aktiv");
  });

  it("overlappende sykluser kjøres ALDRI samtidig - den andre tick() hopper over og rapporteres", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const skipped: string[] = [];
    const watchdog = new Watchdog(new MemoryAlertSink(), new KillSwitch(runtimePool, AUTHORITY), {
      onCycleSkipped: (reason) => skipped.push(reason)
    });
    watchdog.register({
      name: "slow", runbook: "docs/runbooks/TIER1_RUNBOOKS.md",
      run: async () => { runs += 1; await gate; return { ok: true, severity: "info", message: "" }; }
    });

    const first = watchdog.tick();
    const second = await watchdog.tick(); // mens den første fortsatt henger

    expect(second).toEqual([]);
    expect(skipped).toEqual(["overlapping_run"]);
    expect(runs).toBe(1);
    release?.();
    await first;
    expect(watchdog.isRunning()).toBe(false);
  });

  it("en krasjende sjekk isoleres, rapporteres til observatøren og stopper ALDRI de øvrige sjekkene", async () => {
    const failed: string[] = [];
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, new KillSwitch(runtimePool, AUTHORITY), {
      onCheckFailed: (check) => failed.push(check)
    });
    watchdog.register({
      name: "boom", runbook: "docs/runbooks/TIER1_RUNBOOKS.md",
      run: async () => { throw new Error("db down"); }
    });
    watchdog.register({
      name: "after_boom", runbook: "docs/runbooks/TIER1_RUNBOOKS.md",
      run: async () => ({ ok: false, severity: "warning", message: "kjørte likevel" })
    });

    const fired = await watchdog.tick();

    expect(failed).toEqual(["boom"]);
    expect(fired.map((a) => a.check)).toEqual(["boom", "after_boom"]);
    expect(fired[0]?.severity).toBe("critical");
  });
});

describe("I) konfigurasjonen er avgrenset og fail-safe", () => {
  it("resolveWatchdogIntervalMs klemmer til [min, maks] og faller tilbake til default for ugyldige verdier", () => {
    expect(resolveWatchdogIntervalMs(undefined)).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("")).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("abc")).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("0")).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("-5000")).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("1")).toBe(WATCHDOG_MIN_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("999999999")).toBe(WATCHDOG_MAX_INTERVAL_MS);
    expect(resolveWatchdogIntervalMs("30000")).toBe(30_000);
  });

  it("resolveWatchdogTenantIds bruker den eksplisitte listen når den finnes, ellers eier-tenanten", () => {
    expect(resolveWatchdogTenantIds(undefined, "tenant-personal")).toEqual(["tenant-personal"]);
    expect(resolveWatchdogTenantIds("  ", "tenant-personal")).toEqual(["tenant-personal"]);
    expect(resolveWatchdogTenantIds("a, b ,,c", "tenant-personal")).toEqual(["a", "b", "c"]);
  });

  it("costExplosionCheck nekter å bli konstruert uten tenant eller uten eksplisitt eier-aktør (fail-closed, aldri en sjekk som ikke kan utløse)", () => {
    const killSwitch = new KillSwitch(runtimePool, AUTHORITY);
    expect(() => costExplosionCheck(runtimePool, killSwitch, { hardLimitOre: 1, tenantIds: [], actorPersonId: OWNER }))
      .toThrow(/cost_explosion_no_tenants/);
    expect(() => costExplosionCheck(runtimePool, killSwitch, { hardLimitOre: 1, tenantIds: [TENANT], actorPersonId: "" }))
      .toThrow(/cost_explosion_no_actor/);
  });
});

function sampleAlert(): Alert {
  return {
    check: "cost_explosion", severity: "critical", message: "kill switch aktivert (3000 kr)",
    runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad", at: "2026-09-19T00:00:00.000Z"
  };
}

/** Fikstur via tenant-kontekst på den EKTE runtime-rollen - beviser samtidig at RLS-skrivingen faktisk er mulig. */
async function seedSpend(amountOre: number, tenantId: string = TENANT): Promise<void> {
  await withTenantTransaction(runtimePool, tenantId, (client) =>
    client.query(`INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1, 'model:w1', $2)`, [tenantId, amountOre])
  );
}
