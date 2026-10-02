import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientKey } from "../src/http-guard.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * Arkitekt-review av #219 (P3): (a) per-enhet rate limit gjelder også de grant-beskyttede rutene som tolker kroppen selv
 * (/chat, /brief, /executive/*, /governance/*, /owner-controls/*), ikke bare `authedRequest`-rutene.
 * (b) `clientKey` bruker SISTE X-Forwarded-For-element (satt av vår betrodde proxy), aldri det første (klient-satt).
 */
const req = (peer: string, xff?: string | string[]) =>
  ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;

describe("clientKey (P3-b)", () => {
  it("peer som ikke er loopback: X-Forwarded-For ignoreres helt", () => {
    expect(clientKey(req("172.21.0.1", "1.2.3.4"))).toBe("172.21.0.1");
  });
  it("loopback-peer: siste XFF-element brukes (ikke det første som klienten kan ha satt)", () => {
    expect(clientKey(req("127.0.0.1", "6.6.6.6, 100.64.0.9"))).toBe("100.64.0.9");
    expect(clientKey(req("::1", "6.6.6.6,7.7.7.7,100.64.0.9"))).toBe("100.64.0.9");
    expect(clientKey(req("127.0.0.1", ["6.6.6.6", "100.64.0.9"]))).toBe("100.64.0.9");
    expect(clientKey(req("127.0.0.1", "100.64.0.9"))).toBe("100.64.0.9");
  });
  it("loopback uten (eller med tom) XFF: peer", () => {
    expect(clientKey(req("127.0.0.1"))).toBe("127.0.0.1");
    expect(clientKey(req("127.0.0.1", " , "))).toBe("127.0.0.1");
  });
});

describe("per-enhet rate limit på grantBodyOrReject-rutene (P3-a)", () => {
  let url = "";
  let close: () => Promise<void>;
  const executed: string[] = [];
  const deps = {
    rateLimits: { perDevicePerMinute: 3, perIpPerMinute: 1000 },
    grants: { verify: async (t: string) => (t === "good"
      ? { ok: true, grant: { person_id: "p1", tenant_id: "t1", memory_space: "personal", session_id: "s1", device_id: "dev-1", channel: "web", auth_strength: "signed" } }
      : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    executive: { gateway: { execute: async (c: { action: string }) => { executed.push(c.action); return { ok: true, data: {} }; } } }
  } as unknown as ApiDeps;
  beforeAll(async () => {
    const server = createApiServer(deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
  afterAll(async () => { await close?.(); });

  it("etter grensen svarer ALLE grant-rutene 429 (også /executive/query og /governance/query), og verktøyet kalles ikke mer", async () => {
    const call = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const statuses: number[] = [];
    statuses.push((await call("/executive/query", { grant_token: "good", action: "get_attention_queue" })).status);
    statuses.push((await call("/governance/query", { grant_token: "good", action: "list_decisions" })).status);
    statuses.push((await call("/executive/query", { grant_token: "good", action: "get_control_surface_status" })).status);
    expect(statuses).toEqual([200, 200, 200]);
    const before = executed.length;
    for (const [path, body] of [
      ["/executive/query", { grant_token: "good", action: "get_attention_queue" }],
      ["/governance/query", { grant_token: "good", action: "list_decisions" }],
      ["/owner-controls/connector-credentials", { grant_token: "good", action: "test_connector" }]
    ] as const) {
      const res = await call(path, body);
      expect(res.status, path).toBe(429);
      expect((await res.json() as { error: string }).error).toBe("rate_limited");
    }
    expect(executed.length).toBe(before);
  });

  it("en ugyldig grant teller IKKE mot en enhets grense (403 før telling)", async () => {
    const res = await fetch(`${url}/executive/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: "bogus", action: "get_attention_queue" }) });
    expect(res.status).toBe(403);
  });
});
