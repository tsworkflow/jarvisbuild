import { describe, expect, it } from "vitest";
import { EgressBlockedError, assertAllowedTarget, assertPublicHttpUrl, isPublicAddress } from "../src/egress-policy.ts";

/**
 * Remediering del 2 (JARVIS-008): ingen nettverksbane fra browser kan nå interne adresser.
 * Tabelltester over adresseklasser og alle URL-formene en angriper kan bruke for å skjule dem.
 */
describe("isPublicAddress", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.100.100.100", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.2.5", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::7f00:1".replace("7f00:1", "127.0.0.1"),
    "2002:7f00:1::1", "not-an-ip", ""
  ];
  for (const ip of blocked) {
    it(`avviser ${JSON.stringify(ip)}`, () => {
      expect(isPublicAddress(ip)).toBe(false);
    });
  }
  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of allowed) {
    it(`slipper gjennom ${ip}`, () => {
      expect(isPublicAddress(ip)).toBe(true);
    });
  }
});

describe("assertPublicHttpUrl - alle former for intern adresse avvises", () => {
  const rejected: Array<[string, string]> = [
    ["http://127.0.0.1/", "private_address"],
    ["http://localhost/", "internal_hostname"],
    ["http://LOCALHOST./", "internal_hostname"],
    ["http://foo.localhost/", "internal_hostname"],
    ["http://2130706433/", "private_address"], // desimal 127.0.0.1
    ["http://0x7f000001/", "private_address"], // hex
    ["http://0177.0.0.1/", "private_address"], // oktal
    ["http://127.1/", "private_address"], // forkortet
    ["http://[::1]/", "private_address"],
    ["http://[::ffff:127.0.0.1]/", "private_address"],
    ["http://[::ffff:7f00:1]/", "private_address"],
    ["http://10.0.0.5/", "private_address"],
    ["http://192.168.0.10:8080/", "private_address"],
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://metadata.google.internal/computeMetadata/v1/", "internal_hostname"],
    ["http://host.docker.internal/", "internal_hostname"],
    ["http://postgres/", "single_label_host"],
    ["http://infisical:8080/", "single_label_host"],
    ["http://api:3010/", "port_not_allowed"],
    ["http://api/", "single_label_host"],
    ["http://langfuse/", "single_label_host"],
    ["http://browser-gateway:3030/", "port_not_allowed"],
    ["http://browser-gateway/", "single_label_host"],
    ["http://mitt-nas.tail1234.ts.net/", "internal_hostname"],
    ["http://nas.lan/", "internal_hostname"],
    ["http://router.home.arpa/", "internal_hostname"],
    ["http://100.100.1.1/", "private_address"], // Tailscale/CGNAT
    ["https://example.com:22/", "port_not_allowed"],
    ["https://example.com:5432/", "port_not_allowed"],
    ["https://bruker:passord@example.com/", "credentials_in_url"],
    ["file:///etc/passwd", "unsupported_protocol"],
    ["ftp://example.com/", "unsupported_protocol"],
    ["gopher://example.com/", "unsupported_protocol"],
    ["javascript:alert(1)", "unsupported_protocol"],
    ["data:text/html,<h1>x</h1>", "unsupported_protocol"],
    ["", "missing_or_oversized_url"],
    ["ikke en url", "invalid_url"]
  ];
  for (const [url, reason] of rejected) {
    it(`${JSON.stringify(url)} -> ${reason}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrowError(new EgressBlockedError(reason));
    });
  }

  it("avviser ikke-streng og for lang URL", () => {
    expect(() => assertPublicHttpUrl(undefined)).toThrow(EgressBlockedError);
    expect(() => assertPublicHttpUrl(42)).toThrow(EgressBlockedError);
    expect(() => assertPublicHttpUrl(`https://example.com/${"a".repeat(2_001)}`)).toThrow(EgressBlockedError);
  });

  it("godtar vanlige offentlige URL-er (positiv kontroll)", () => {
    expect(assertPublicHttpUrl("https://example.com/side?x=1")).toBe("https://example.com/side?x=1");
    expect(assertPublicHttpUrl("http://example.org")).toBe("http://example.org/");
    expect(assertPublicHttpUrl("https://example.com:8443/x")).toContain(":8443");
    expect(assertPublicHttpUrl("http://93.184.216.34/")).toBe("http://93.184.216.34/");
  });
});

describe("assertAllowedTarget", () => {
  it("avviser port utenfor 80/443/8080/8443 selv for offentlig vert", () => {
    expect(() => assertAllowedTarget("example.com", 25)).toThrow(EgressBlockedError);
    expect(() => assertAllowedTarget("example.com", 6379)).toThrow(EgressBlockedError);
    expect(() => assertAllowedTarget("example.com", 443)).not.toThrow();
  });
});
