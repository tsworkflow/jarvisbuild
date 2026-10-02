import http, { type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressProxy } from "../src/egress-proxy.ts";

/**
 * Remediering del 2 (JARVIS-008): atferdstester mot den ekte `EgressProxy` med ekte sockets.
 * "Intern tjeneste" og "offentlig nettsted" er to lokale servere; DNS og tilkobling injiseres
 * slik at «offentlig» vert → falsk offentlig IP → dial mot test-serveren.
 */
let internal: Server; // simulerer Postgres/Infisical/metadata på loopback
let publicSite: Server; // simulerer et offentlig nettsted
let internalHits = 0;
let publicHits = 0;
let proxy: EgressProxy;
let proxyPort = 0;
const denied: string[] = [];

const DNS: Record<string, string[]> = {
  "public.example.test": ["93.184.216.34"],
  "rebinding.example.test": ["93.184.216.34", "10.0.0.5"], // blandet svar
  "to-loopback.example.test": ["127.0.0.1"],
  "to-metadata.example.test": ["169.254.169.254"],
  "to-private.example.test": ["192.168.1.10"],
  "to-mapped.example.test": ["::ffff:127.0.0.1"],
  "nxdomain.example.test": []
};

beforeAll(async () => {
  internal = http.createServer((_req, res) => { internalHits += 1; res.end("INTERN-HEMMELIGHET"); });
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  publicSite = http.createServer((_req, res) => { publicHits += 1; res.end("offentlig-side"); });
  await new Promise<void>((r) => publicSite.listen(0, "127.0.0.1", r));
  proxy = new EgressProxy({
    resolve: async (host) => {
      const answer = DNS[host];
      if (answer === undefined) throw new Error("ENOTFOUND");
      return answer;
    },
    // ALLE tilkoblinger til en «offentlig» IP havner hos offentlig-test-serveren; en tilkobling til noe annet
    // (som en feil i policyen ville latt passere) ville truffet intern-serveren og telles som brudd.
    connect: (ip) => net.connect({ host: "127.0.0.1", port: ip === "93.184.216.34" ? (publicSite.address() as AddressInfo).port : (internal.address() as AddressInfo).port }),
    onDeny: (reason) => denied.push(reason)
  });
  proxyPort = (await proxy.start()).port;
});

afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((r) => internal.close(() => r()));
  await new Promise<void>((r) => publicSite.close(() => r()));
});

function connectThroughProxy(target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (buf) => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString())?.[1]), socket }));
    socket.once("error", reject);
  });
}

function forward(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("CONNECT (https-tunneler)", () => {
  it("nekter direkte loopback/privat/metadata-IP FØR noen tilkobling gjøres", async () => {
    for (const target of ["127.0.0.1:443", "10.0.0.5:443", "169.254.169.254:80", "192.168.1.1:443", "[::1]:443", "100.100.1.1:443"]) {
      const r = await connectThroughProxy(target);
      expect(r.status, target).toBe(403);
      r.socket.destroy();
    }
    expect(internalHits).toBe(0);
  });

  it("nekter compose-tjenestenavn og interne vertsnavn", async () => {
    for (const target of ["postgres:443", "infisical:8080", "metadata.google.internal:80", "localhost:443", "api.localhost:443"]) {
      const r = await connectThroughProxy(target);
      expect(r.status, target).toBe(403);
      r.socket.destroy();
    }
  });

  it("nekter DNS-resultater som peker mot privat/loopback/metadata/mappet-IPv6 (rebinding-forsvar)", async () => {
    for (const host of ["to-loopback.example.test", "to-metadata.example.test", "to-private.example.test", "to-mapped.example.test", "rebinding.example.test"]) {
      const r = await connectThroughProxy(`${host}:443`);
      expect(r.status, host).toBe(403);
      r.socket.destroy();
    }
    expect(denied).toContain("resolves_to_private_address");
    expect(internalHits).toBe(0);
  });

  it("nekter porter utenfor allowlisten, også for offentlig vert", async () => {
    const r = await connectThroughProxy("public.example.test:5432");
    expect(r.status).toBe(403);
    r.socket.destroy();
  });

  it("DNS-feil og tomt svar er 403 (fail-closed), ikke en åpning", async () => {
    for (const host of ["nxdomain.example.test", "ukjent.example.test"]) {
      const r = await connectThroughProxy(`${host}:443`);
      expect(r.status, host).toBe(403);
      r.socket.destroy();
    }
  });

  it("slipper gjennom en offentlig vert og tunnelerer data (positiv kontroll)", async () => {
    const r = await connectThroughProxy("public.example.test:443");
    expect(r.status).toBe(200);
    const body = await new Promise<string>((resolve) => {
      let data = "";
      r.socket.on("data", (c) => (data += c));
      r.socket.on("end", () => resolve(data));
      r.socket.write("GET / HTTP/1.1\r\nHost: public.example.test\r\nConnection: close\r\n\r\n");
    });
    expect(body).toContain("offentlig-side");
    expect(publicHits).toBeGreaterThan(0);
  });
});

describe("plain HTTP-videresending", () => {
  it("nekter direkte intern IP og interne DNS-svar - intern server får ALDRI treff", async () => {
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://to-loopback.example.test/", "http://postgres/", "http://10.0.0.5/"]) {
      const r = await forward(url);
      expect(r.status, url).toBe(403);
      expect(r.body).not.toContain("INTERN-HEMMELIGHET");
    }
    expect(internalHits).toBe(0);
  });

  it("videresender til en validert offentlig vert (positiv kontroll)", async () => {
    const before = publicHits;
    const r = await forward("http://public.example.test/side");
    expect(r.status).toBe(200);
    expect(r.body).toBe("offentlig-side");
    expect(publicHits).toBe(before + 1);
  });

  it("avviser en relativ forespørsel (ikke absolutt URI)", async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: "/", headers: { host: "x" } }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(r).toBe(400);
  });
});
