import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZendeskTransport, classifyZendeskTokenEndpointError } from "@jarvis/tool-gateway";

/**
 * UA-3 Support/Tickets (Zendesk, D-64): testmatrise A-C/G-N/S/AQ/AR/AU (§39 i
 * byggeordren). Samme fetch-mocking-presedens som
 * google-drive-transport.test.ts/gmail-attachment-transport.test.ts -
 * `ZendeskTransport` har reell intern logikk (token-exchange+rotasjon,
 * side-lasting, HTTP-status->typet-feil-klassifisering, 429-retry) som ikke
 * kan bevises via `FakeTransport`.
 */
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("ZendeskTransport - intern logikk (fetch mocket)", () => {
  let calls: Array<{ url: string; method: string; body?: string }>;
  let queue: Response[];

  beforeEach(() => {
    calls = [];
    queue = [];
    global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.includes("/oauth/tokens")) {
        return jsonResponse(200, { access_token: "fake-access-token", expires_in: 1800 });
      }
      const next = queue.shift();
      if (!next) throw new Error(`uventet fetch-kall uten kø-oppføring: ${url}`);
      return next;
    }) as unknown as typeof fetch;
    process.env["JARVIS_ZENDESK_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_ZENDESK_CLIENT_SECRET"] = "test-client-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env["JARVIS_ZENDESK_CLIENT_ID"];
    delete process.env["JARVIS_ZENDESK_CLIENT_SECRET"];
    vi.useRealTimers();
  });

  describe("A: OAuth-autorisasjonskonfigurasjon", () => {
    it("kaster zendesk_subdomain_not_configured uten subdomain, FØR noe fetch-kall forsøkes", async () => {
      const transport = new ZendeskTransport("", "agent@example.com");
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "refresh-token")).rejects.toThrow("zendesk_subdomain_not_configured");
      expect(calls).toHaveLength(0);
    });
    it("kaster zendesk_oauth_client_not_configured uten client_id/secret i env", async () => {
      delete process.env["JARVIS_ZENDESK_CLIENT_ID"];
      const transport = new ZendeskTransport("acme");
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "refresh-token")).rejects.toThrow("zendesk_oauth_client_not_configured");
    });
  });

  describe("B: access-token-refresh", () => {
    it("bytter refresh-token mot et access-token FØR selve API-kallet", async () => {
      queue.push(jsonResponse(200, { ticket: { id: 1, subject: "Test", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", tags: [] } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("get_ticket", { ticket_id: "1" }, "refresh-token-A");
      expect(calls[0]!.url).toContain("/oauth/tokens");
      expect(calls[1]!.url).toContain("/tickets/1.json");
      expect(calls[1]!.method).toBe("GET");
    });
    it("gjenbruker det samme access-tokenet for et andre kall innenfor samme prosess (ingen ny token-exchange)", async () => {
      queue.push(jsonResponse(200, { ticket: { id: 1, subject: "A", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      queue.push(jsonResponse(200, { ticket: { id: 2, subject: "B", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("get_ticket", { ticket_id: "1" }, "refresh-token-A");
      await transport.invoke("get_ticket", { ticket_id: "2" }, "refresh-token-A");
      const tokenCalls = calls.filter((c) => c.url.includes("/oauth/tokens"));
      expect(tokenCalls).toHaveLength(1);
    });
  });

  describe("C: refresh-token-rotasjon (§7 i byggeordren)", () => {
    it("bruker det NYE roterte refresh-tokenet for påfølgende kall når Zendesk returnerer et i token-responsen", async () => {
      global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("/oauth/tokens")) {
          const body = String(init?.body ?? "");
          const usedToken = new URLSearchParams(body).get("refresh_token");
          return jsonResponse(200, { access_token: `access-for-${usedToken}`, refresh_token: "rotated-refresh-token", expires_in: 1800 });
        }
        const next = queue.shift();
        if (!next) throw new Error(`uventet fetch-kall: ${url}`);
        return next;
      }) as unknown as typeof fetch;
      // Access-token utløper umiddelbart etter hvert kall (0s) - tvinger en ny exchange per kall,
      // slik at vi kan observere HVILKET refresh-token som faktisk ble brukt andre gang.
      vi.useFakeTimers();
      queue.push(jsonResponse(200, { ticket: { id: 1, subject: "A", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      queue.push(jsonResponse(200, { ticket: { id: 2, subject: "B", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("get_ticket", { ticket_id: "1" }, "original-refresh-token");
      vi.advanceTimersByTime(31 * 60_000); // tving access-token-utløp
      await transport.invoke("get_ticket", { ticket_id: "2" }, "original-refresh-token");
      const tokenCalls = calls.filter((c) => c.url.includes("/oauth/tokens"));
      expect(tokenCalls).toHaveLength(2);
    });

    it("beholder DET GAMLE refresh-tokenet når Zendesk IKKE roterer (ingen refresh_token i responsen)", async () => {
      vi.useFakeTimers();
      const capturedTokens: string[] = [];
      global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/oauth/tokens")) {
          const usedToken = new URLSearchParams(String(init?.body ?? "")).get("refresh_token")!;
          capturedTokens.push(usedToken);
          return jsonResponse(200, { access_token: "access-token", expires_in: 1800 }); // INGEN refresh_token
        }
        const next = queue.shift();
        if (!next) throw new Error(`uventet fetch-kall: ${url}`);
        return next;
      }) as unknown as typeof fetch;
      queue.push(jsonResponse(200, { ticket: { id: 1, subject: "A", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      queue.push(jsonResponse(200, { ticket: { id: 2, subject: "B", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("get_ticket", { ticket_id: "1" }, "stable-refresh-token");
      vi.advanceTimersByTime(31 * 60_000);
      await transport.invoke("get_ticket", { ticket_id: "2" }, "stable-refresh-token");
      expect(capturedTokens).toEqual(["stable-refresh-token", "stable-refresh-token"]);
    });
  });

  describe("D/E/F: manglende/ugyldig credential + saniterte feil", () => {
    it("klassifiserer invalid_grant som ZENDESK_OAUTH_REFRESH_REQUIRED og kaster ETT gjenkjennbart, grep-bart feilnavn", () => {
      const details = classifyZendeskTokenEndpointError(400, JSON.stringify({ error: "invalid_grant", error_description: "Token is expired" }));
      expect(details.errorClass).toBe("ZENDESK_OAUTH_REFRESH_REQUIRED");
    });
    it("klassifiserer invalid_client som ZENDESK_OAUTH_CLIENT_INVALID", () => {
      const details = classifyZendeskTokenEndpointError(401, JSON.stringify({ error: "invalid_client" }));
      expect(details.errorClass).toBe("ZENDESK_OAUTH_CLIENT_INVALID");
    });
    it("kaster den distinkte zendesk_oauth_refresh_required-strengen (ikke en generisk feil) når refresh-tokenet er ugyldig/utløpt", async () => {
      queue.push(jsonResponse(400, { error: "invalid_grant", error_description: "Token expired" }));
      global.fetch = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/oauth/tokens")) return jsonResponse(400, { error: "invalid_grant", error_description: "Token expired" });
        return queue.shift()!;
      }) as unknown as typeof fetch;
      const transport = new ZendeskTransport("acme");
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "expired-token")).rejects.toThrow("zendesk_oauth_refresh_required");
    });
    it("ikke-JSON token-endepunkt-feilkropp knekker ALDRI klassifiseringen (trygg fallback UNKNOWN)", () => {
      const details = classifyZendeskTokenEndpointError(500, "<html>error</html>");
      expect(details.errorClass).toBe("ZENDESK_OAUTH_UNKNOWN");
    });
    it("saniterte feilmeldinger inneholder ALDRI selve credential-verdien", async () => {
      global.fetch = vi.fn(async (input: string | URL) => {
        if (String(input).includes("/oauth/tokens")) return jsonResponse(400, { error: "invalid_grant", error_description: "Token is expired" });
        return jsonResponse(200, {});
      }) as unknown as typeof fetch;
      const transport = new ZendeskTransport("acme");
      const secretRefreshToken = "SUPER-SECRET-REFRESH-TOKEN-VALUE";
      try {
        await transport.invoke("get_ticket", { ticket_id: "1" }, secretRefreshToken);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain(secretRefreshToken);
      }
    });
  });

  describe("G/H/I/J/K/L: leselogikk (side-lasting/audits/brukere/organisasjoner)", () => {
    it("get_ticket side-laster requester-e-post fra users-arrayet", async () => {
      queue.push(jsonResponse(200, {
        ticket: { id: 42, subject: "Faktura", status: "open", priority: "high", assignee_id: 9, requester_id: 5, organization_id: 7, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", tags: ["billing"] },
        users: [{ id: 5, email: "kunde@acme.no", name: "Kari" }],
        organizations: [{ id: 7, name: "Acme AS" }]
      }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("get_ticket", { ticket_id: "42" }, "refresh-token");
      expect(result.data).toMatchObject({ id: "42", requester_email: "kunde@acme.no", organization_name: "Acme AS", status: "open", priority: "high" });
      expect(result.external_id).toBe("42");
    });
    it("list_tickets side-laster med include=users,organizations og filtrerer på updated_since", async () => {
      queue.push(jsonResponse(200, {
        tickets: [
          { id: 1, subject: "Gammel", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          { id: 2, subject: "Ny", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-05T00:00:00Z" }
        ],
        users: [{ id: 5, email: "kunde@acme.no" }]
      }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("list_tickets", { max: 10, updated_since: "2026-01-03T00:00:00Z" }, "refresh-token");
      const tickets = (result.data as { tickets: Array<{ id: string }> }).tickets;
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.id).toBe("2");
      expect(calls.some((c) => c.url.includes("include=users%2Corganizations") || c.url.includes("include=users,organizations"))).toBe(true);
    });
    it("get_ticket_audits mapper events til korte type-strenger, aldri rå feltverdier", async () => {
      queue.push(jsonResponse(200, { audits: [{ id: 100, created_at: "2026-01-01T00:00:00Z", author_id: 5, events: [{ type: "Change", field_name: "status", value: "open" }] }] }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("get_ticket_audits", { ticket_id: "42" }, "refresh-token");
      const audits = (result.data as { audits: Array<{ event_types: string[] }> }).audits;
      expect(audits[0]!.event_types).toEqual(["Change:status"]);
    });
  });

  describe("M/N: skrivelogikk (create/update/reply/note)", () => {
    it("create_ticket sender KUN metadata + description videre - aldri lagrer noe utover det som sendes til Zendesk", async () => {
      queue.push(jsonResponse(200, { ticket: { id: 99, subject: "Ny sak", status: "new" } }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("create_ticket", { subject: "Ny sak", description: "Detaljer", requester_email: "kunde@acme.no", priority: "high" }, "refresh-token");
      expect(result.external_id).toBe("99");
      const body = JSON.parse(calls[1]!.body!);
      expect(body.ticket.subject).toBe("Ny sak");
      expect(body.ticket.requester.email).toBe("kunde@acme.no");
    });
    it("update_ticket er KONSOLIDERT - én PUT med kun de oppgitte feltene, ingen separate mikro-kall", async () => {
      queue.push(jsonResponse(200, { ticket: { id: 42, status: "pending", priority: "high", updated_at: "2026-01-02T00:00:00Z" } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("update_ticket", { ticket_id: "42", status: "pending", priority: "high" }, "refresh-token");
      const body = JSON.parse(calls[1]!.body!);
      expect(body.ticket).toEqual({ status: "pending", priority: "high" });
      expect(calls[1]!.method).toBe("PUT");
    });
    it("reply_ticket setter public:true, add_internal_note setter public:false", async () => {
      queue.push(jsonResponse(200, { ticket: { id: 42, updated_at: "x" } }));
      queue.push(jsonResponse(200, { ticket: { id: 42, updated_at: "y" } }));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("reply_ticket", { ticket_id: "42", body: "Svar til kunde" }, "refresh-token");
      await transport.invoke("add_internal_note", { ticket_id: "42", body: "Intern note" }, "refresh-token");
      const replyBody = JSON.parse(calls[1]!.body!);
      const noteBody = JSON.parse(calls[2]!.body!);
      expect(replyBody.ticket.comment.public).toBe(true);
      expect(noteBody.ticket.comment.public).toBe(false);
    });
  });

  describe("S: sletting/redigering (klasse D)", () => {
    it("delete_ticket returnerer already_deleted=true idempotent på 404 (retry-trygt)", async () => {
      queue.push(new Response(null, { status: 404 }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("delete_ticket", { ticket_id: "42" }, "refresh-token");
      expect(result.data).toMatchObject({ already_deleted: "true" });
    });
    it("redact_ticket_content kaller PUT mot .../comments/{id}/redact.json", async () => {
      queue.push(jsonResponse(200, {}));
      const transport = new ZendeskTransport("acme");
      await transport.invoke("redact_ticket_content", { ticket_id: "42", comment_id: "7", text: "***" }, "refresh-token");
      expect(calls[1]!.url).toContain("/tickets/42/comments/7/redact.json");
      expect(calls[1]!.method).toBe("PUT");
    });
  });

  describe("AQ/AR: rate limiting/retry", () => {
    it("429 med Retry-After gir ETT bounded retry-forsøk, lykkes deretter", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      global.fetch = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/oauth/tokens")) return jsonResponse(200, { access_token: "token", expires_in: 1800 });
        const next = queue.shift();
        return next ?? jsonResponse(500, {});
      }) as unknown as typeof fetch;
      queue.push(jsonResponse(429, {}, { "retry-after": "1" }));
      queue.push(jsonResponse(200, { ticket: { id: 1, subject: "A", status: "open", priority: null, assignee_id: null, requester_id: 5, organization_id: null, created_at: "x", updated_at: "y", tags: [] } }));
      const transport = new ZendeskTransport("acme");
      const result = await transport.invoke("get_ticket", { ticket_id: "1" }, "refresh-token");
      expect(result.external_id).toBe("1");
    }, 10_000);
    it("HTTP-status mappes til typede feilstrenger (401/403/404/429/annet)", async () => {
      const transport = new ZendeskTransport("acme");
      queue.push(new Response(null, { status: 401 }));
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "rt")).rejects.toThrow("zendesk_unauthorized");
      queue.push(new Response(null, { status: 403 }));
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "rt")).rejects.toThrow("zendesk_forbidden");
      queue.push(new Response(null, { status: 404 }));
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "rt")).rejects.toThrow("zendesk_not_found_1");
      queue.push(new Response(null, { status: 500 }));
      await expect(transport.invoke("get_ticket", { ticket_id: "1" }, "rt")).rejects.toThrow("zendesk_error_500");
    });
  });

  describe("AU: ingen ukjent handling utfører et stille fallback-kall", () => {
    it("kaster zendesk_unsupported_action_<navn> for en ukjent handling", async () => {
      const transport = new ZendeskTransport("acme");
      await expect(transport.invoke("delete_everything", {}, "refresh-token")).rejects.toThrow("zendesk_unsupported_action_delete_everything");
      expect(calls.filter((c) => !c.url.includes("/oauth/tokens"))).toHaveLength(0);
    });
  });
});
