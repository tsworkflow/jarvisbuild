import { BlockList, isIP } from "node:net";

/**
 * Remediering del 2 (JARVIS-008): egress-policy for nettleser-gatewayen. Målet er at INGEN
 * nettverksbane fra Chromium kan nå loopback, RFC1918, link-local, metadata-adresser, CGNAT/
 * Tailscale eller compose-tjenestenavn - verken via direkte URL, redirect, subressurs eller
 * DNS-resultat. Tre lag bruker DENNE filen:
 *   1. `assertPublicHttpUrl()` - rask, syntaktisk sjekk (ingen DNS) før noe kjøres,
 *   2. `context.route()` i motoren - samme sjekk for HVER forespørsel (redirects/subressurser),
 *   3. `EgressProxy` - den AUTORITATIVE sjekken: DNS løses ÉN gang, ALLE svar må være offentlige,
 *      og tilkoblingen gjøres mot den VALIDERTE IP-en (ingen TOCTOU mot en ny DNS-oppslag).
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["100::", 64], ["2001::", 32]
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Trekker ut den innebygde IPv4-adressen fra IPv4-mappet/-kompatibel IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d, 2002:ab:cd::). */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1] ?? null;
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1] ?? "0", 16);
    const lo = parseInt(hexMapped[2] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})::?/.exec(lower);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1] ?? "0", 16);
    const lo = parseInt(sixToFour[2] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** `true` KUN for en offentlig rutbar adresse. Alt ukjent/uparsbart er `false` (fail-closed). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded !== null) return isPublicAddress(embedded);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".docker", ".ts.net", ".svc", ".cluster.local", ".corp", ".intranet"];
const BLOCKED_HOSTS = new Set(["localhost", "host.docker.internal", "gateway.docker.internal", "metadata", "metadata.google.internal", "instance-data"]);
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export class EgressBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`browser_gateway_egress_blocked:${reason}`);
    this.name = "EgressBlockedError";
  }
}

/** Normaliserer hostnavn (små bokstaver, uten avsluttende punktum, uten IPv6-klammer). */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Syntaktisk vurdering av et mål (vert + port). Kaster `EgressBlockedError`. Ingen DNS. */
export function assertAllowedTarget(hostname: string, port: number): void {
  const host = normalizeHost(hostname);
  if (host.length === 0) throw new EgressBlockedError("empty_host");
  if (!ALLOWED_PORTS.has(port)) throw new EgressBlockedError("port_not_allowed");
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new EgressBlockedError("private_address");
    return;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new EgressBlockedError("internal_hostname");
  }
  // Enkeltlabel-vert (`postgres`, `infisical`, `api`, compose-tjenester) er aldri offentlig.
  if (!host.includes(".")) throw new EgressBlockedError("single_label_host");
}

/** Full syntaktisk URL-vurdering: kun http(s), ingen brukerinfo, tillatt port, tillatt vert. Returnerer normalisert URL. */
export function assertPublicHttpUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 2_000) {
    throw new EgressBlockedError("missing_or_oversized_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new EgressBlockedError("unsupported_protocol");
  if (parsed.username !== "" || parsed.password !== "") throw new EgressBlockedError("credentials_in_url");
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  assertAllowedTarget(parsed.hostname, port);
  return parsed.toString();
}
