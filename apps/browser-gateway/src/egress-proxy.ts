import { lookup } from "node:dns/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import { EgressBlockedError, assertAllowedTarget, isPublicAddress, normalizeHost } from "./egress-policy.ts";

/**
 * Remediering del 2 (JARVIS-008): AUTORITATIV egress-proxy. Chromium startes med
 * `--proxy-server` mot denne (og `<-loopback>` i bypass-listen, slik at selv loopback går
 * hit og kan nektes). Proxyen:
 *   - løser DNS ÉN gang og krever at ALLE svar er offentlige adresser (en blanding avvises -
 *     DNS-rebinding-forsvar),
 *   - kobler til den VALIDERTE IP-en (aldri en ny oppslag),
 *   - gjelder derfor også redirects, subressurser, iframes og WebSocket - alt Chromium gjør
 *     går gjennom CONNECT/forward her,
 *   - tillater kun portene i `egress-policy.ts`.
 */

/** Satt på alle avvisninger av plain-HTTP-forespørsler, slik at motoren kan feile navigasjonen i stedet for å vise en «forbidden»-side. */
export const EGRESS_DENIED_HEADER = "x-jarvis-egress-denied";

export interface EgressProxyOptions {
  /** Injiserbar DNS-oppløsning (tester). Standard: `dns.lookup({ all: true })`. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Injiserbar tilkobling (tester). Standard: `net.connect` mot den validerte IP-en. */
  connect?: (ip: string, port: number) => Socket;
  /** Maks samtidige tunneler/forespørsler. */
  maxConnections?: number;
  /** Idle-timeout per socket. */
  idleTimeoutMs?: number;
  /** Mottar avvisningsårsaker (aldri innhold/URL-query). */
  onDeny?: (reason: string, host: string, port: number) => void;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade"
]);

async function defaultResolve(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

export class EgressProxy {
  private server: Server | undefined;
  private active = 0;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly dial: (ip: string, port: number) => Socket;
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly onDeny: (reason: string, host: string, port: number) => void;

  constructor(options: EgressProxyOptions = {}) {
    this.resolveHost = options.resolve ?? defaultResolve;
    this.dial = options.connect ?? ((ip, port) => net.connect({ host: ip, port }));
    this.maxConnections = options.maxConnections ?? 64;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.onDeny = options.onDeny ?? (() => undefined);
  }

  /** Validerer mål og returnerer de VALIDERTE adressene (alle offentlige). Kaster `EgressBlockedError`. */
  async validate(host: string, port: number): Promise<string[]> {
    const normalized = normalizeHost(host);
    assertAllowedTarget(normalized, port);
    if (net.isIP(normalized) !== 0) {
      return [normalized];
    }
    let addresses: string[];
    try {
      addresses = await this.resolveHost(normalized);
    } catch {
      throw new EgressBlockedError("dns_failure");
    }
    if (addresses.length === 0) throw new EgressBlockedError("dns_empty");
    // Én privat adresse i svaret avviser HELE målet (rebinding/blandede svar).
    if (addresses.some((a) => !isPublicAddress(a))) throw new EgressBlockedError("resolves_to_private_address");
    return addresses;
  }

  async start(port = 0, host = "127.0.0.1"): Promise<{ port: number }> {
    const server = http.createServer((req, res) => void this.handleForward(req, res));
    server.on("connect", (req, clientSocket, head) => void this.handleConnect(req, clientSocket as Socket, head));
    server.on("clientError", (_err, socket) => socket.destroy());
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    return { port: (server.address() as net.AddressInfo).port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async connectValidated(addresses: string[], port: number): Promise<Socket> {
    let lastError: unknown;
    for (const ip of addresses) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = this.dial(ip, port);
          socket.setTimeout(this.idleTimeoutMs, () => socket.destroy(new Error("egress_idle_timeout")));
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("egress_connect_failed");
  }

  private async handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): Promise<void> {
    const fail = (status: number, text: string): void => {
      clientSocket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    clientSocket.on("error", () => clientSocket.destroy());
    if (this.active >= this.maxConnections) return fail(503, "Busy");
    const target = req.url ?? "";
    const idx = target.lastIndexOf(":");
    const host = idx > 0 ? target.slice(0, idx) : target;
    const port = idx > 0 ? Number(target.slice(idx + 1)) : 443;
    this.active += 1;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
    clientSocket.once("close", release);
    try {
      const addresses = await this.validate(host, port);
      const upstream = await this.connectValidated(addresses, port);
      upstream.on("error", () => upstream.destroy());
      upstream.once("close", () => clientSocket.destroy());
      clientSocket.once("close", () => upstream.destroy());
      clientSocket.setTimeout(this.idleTimeoutMs, () => clientSocket.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    } catch (err) {
      release();
      if (err instanceof EgressBlockedError) {
        this.onDeny(err.reason, host, port);
        return fail(403, "Forbidden");
      }
      return fail(502, "Bad Gateway");
    }
  }

  private async handleForward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const deny = (status: number, text: string): void => {
      // Markøren lar motoren skille en proxy-avvisning fra en vanlig 403 fra nettstedet.
      res.writeHead(status, { "content-type": "text/plain", connection: "close", [EGRESS_DENIED_HEADER]: "1" });
      res.end(text);
    };
    if (this.active >= this.maxConnections) return deny(503, "busy");
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return deny(400, "absolute-uri required");
    }
    if (url.protocol !== "http:") return deny(400, "only http: is forwarded; https uses CONNECT");
    const port = url.port === "" ? 80 : Number(url.port);
    this.active += 1;
    try {
      const addresses = await this.validate(url.hostname, port);
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
      }
      headers["host"] = url.host;
      const ip = addresses[0] as string;
      await new Promise<void>((resolve) => {
        const upstream = http.request(
          {
            host: ip, port, method: req.method, path: `${url.pathname}${url.search}`, headers,
            createConnection: () => this.dial(ip, port), timeout: this.idleTimeoutMs
          },
          (upstreamRes) => {
            const out: Record<string, string | string[]> = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
            }
            res.writeHead(upstreamRes.statusCode ?? 502, out);
            upstreamRes.pipe(res);
            upstreamRes.once("end", resolve);
            upstreamRes.once("error", () => { res.destroy(); resolve(); });
          }
        );
        upstream.once("timeout", () => upstream.destroy(new Error("egress_idle_timeout")));
        upstream.once("error", () => {
          if (!res.headersSent) deny(502, "bad gateway");
          else res.destroy();
          resolve();
        });
        req.pipe(upstream);
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        this.onDeny(err.reason, url.hostname, port);
        return deny(403, "forbidden");
      }
      return deny(502, "bad gateway");
    } finally {
      this.active -= 1;
    }
  }
}
