import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-125 (UA-7, FEMTE slice): strukturelle bevis for SELVE SAMMENKOBLINGEN i
 * `apps/api/src/main.ts` - påstander som ikke kan uttrykkes som ren
 * funksjonslogikk fordi de handler om HVA som er koblet til HVA, og i hvilken
 * REKKEFØLGE. Samme kildeteksts-baserte mønster som
 * `modules/core/test/google-drive-reauth-wiring.test.ts`.
 *
 * Oppførselen selv er bevist andre steder mot ekte kode/DB:
 *   - `modules/core/test/d125-telegram-owner-authority.test.ts` (autoriteten),
 *   - `modules/tool-gateway/test/d125-telegram-inbound-poller.test.ts` (transporten),
 *   - `modules/conversation-graph/test/d125-owner-telegram-link.test.ts` (lenkingen).
 * Denne filen beviser at produksjonsbanen faktisk BRUKER dem, og at ingen
 * parallell chat-motor/identitetslagring/sesjonsmodell er innført.
 */
const source = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const codeOnly = source
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

/** Telegram-`chat`-handlerens kropp - der hele den nye banen bor. */
const chatHandler = (() => {
  const start = codeOnly.indexOf("chat: async ({ chat_id, text })");
  expect(start, "forventet en chat-handler i Telegram-pollerens handlers").toBeGreaterThan(-1);
  return codeOnly.slice(start, codeOnly.indexOf("}, sendTelegram).start();", start));
})();

describe("D-125 A: ingen parallell motor - den kanoniske banen gjenbrukes", () => {
  it("A1: NØYAKTIG én ConversationEngine konstrueres i hele main.ts", () => {
    expect(codeOnly.split("new ConversationEngine(").length - 1).toBe(1);
  });

  it("A2: SAMME instans brukes av både /chat-deps og Telegram-banen", () => {
    expect(codeOnly).toContain("conversation: conversationEngine");
    expect(chatHandler).toContain("conversationEngine.handle(");
  });

  it("A3: ingen ny Telegram-transport, ingen ny identitetslagring, ingen ny sesjonsmodell", () => {
    // Fortsatt kun ÉN poller, ÉN SessionService, ÉN IdentityService.
    expect(codeOnly.split("new TelegramCommandPoller(").length - 1).toBe(1);
    expect(codeOnly.split("new SessionService(").length - 1).toBe(1);
    expect(codeOnly.split("new IdentityService(").length - 1).toBe(1);
    // Svaret går ut via den EKSISTERENDE ToolGateway-styrte send-banen.
    expect(codeOnly).toContain("}, sendTelegram).start();");
  });

  it("A4: den eksisterende sendTelegram går fortsatt gjennom ToolGateway (ikke direkte fetch)", () => {
    const send = codeOnly.slice(codeOnly.indexOf("const sendTelegram"), codeOnly.indexOf("const aiMeshText"));
    expect(send).toContain("toolGateway.execute(");
    expect(send).not.toContain("fetch(");
  });
});

describe("D-125 B: identitet/tenant/space/sesjon bindes KUN fra betrodd server-side konfigurasjon", () => {
  const authorityConstruction = codeOnly.slice(
    codeOnly.indexOf("new TelegramOwnerAuthority("),
    codeOnly.indexOf("new TelegramCommandPoller(")
  );

  it("B1: autoriteten får sesjons-/identitetsprimitivene, ikke egne kopier", () => {
    expect(authorityConstruction).toContain("sessions: sessionService");
    expect(authorityConstruction).toContain("identity: identityService");
  });

  it("B2: hver autoritetsverdi kommer fra env/seed-konstanter - ingen fra en melding", () => {
    expect(authorityConstruction).toContain('owner_chat_id: process.env["JARVIS_TELEGRAM_CHAT_ID"]');
    // Remediering del 2 (JARVIS-065): tenant/person kommer fra den ENE validerte eier-konfigen (`owner`), ikke fra env-defaults.
    expect(authorityConstruction).toContain("tenant_id: owner.tenant_id");
    expect(authorityConstruction).toContain("person_id: owner.owner_person_id");
    expect(authorityConstruction).toContain('device_id: "jarvis-core"');
    expect(authorityConstruction).toContain('memory_space: "personal"');
  });

  it("B3: person-ID-en utledes fra SAMME validerte eier-konfig som seedOwner() bruker (ingen hardkodet default)", () => {
    const seed = readFileSync(fileURLToPath(new URL("../src/seed.ts", import.meta.url)), "utf8");
    expect(seed).toContain("owner.owner_person_id");
    expect(authorityConstruction).toContain("owner.owner_person_id");
    expect(seed).not.toContain("person-tobias");
    expect(authorityConstruction).not.toContain("person-tobias");
  });

  it("B4: autoriteten kalles med KUN chat_id - meldingsteksten er aldri et argument", () => {
    expect(chatHandler).toContain("telegramOwnerAuthority.authorize(chat_id)");
    expect(/authorize\([^)]*text/.test(chatHandler), "text skal aldri sendes til authorize()").toBe(false);
  });
});

describe("D-125 C: fail-closed FØR modell-, verktøy- og lenkearbeid", () => {
  it("C1: avslag returnerer undefined FØR identitetslenking og FØR samtalemotoren", () => {
    const guard = chatHandler.indexOf("if (!authorized.ok) return undefined;");
    const link = chatHandler.indexOf("linkOwnerTelegramIdentity(");
    const handle = chatHandler.indexOf("conversationEngine.handle(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(link);
    expect(link).toBeLessThan(handle);
  });

  it("C2: autorisasjonen skjer FØR alt annet i handleren", () => {
    const authorize = chatHandler.indexOf("telegramOwnerAuthority.authorize(");
    expect(authorize).toBeGreaterThan(-1);
    expect(authorize).toBeLessThan(chatHandler.indexOf("linkOwnerTelegramIdentity("));
  });

  it("C3: pollerens egen eier-grense er uendret (forsvar i dybden - to uavhengige porter)", () => {
    const transports = readFileSync(
      fileURLToPath(new URL("../../../modules/tool-gateway/src/live-transports.ts", import.meta.url)),
      "utf8"
    );
    expect(transports).toContain("if (chat !== this.ownerChatId) continue;");
  });
});

describe("D-125 D: identitetslenking bruker chat-ID + oppløst identitet, aldri meldingsinnhold", () => {
  const linkCall = chatHandler.slice(
    chatHandler.indexOf("linkOwnerTelegramIdentity("),
    chatHandler.indexOf(");", chatHandler.indexOf("linkOwnerTelegramIdentity("))
  );

  it("D1: argumentene er utelukkende autoritetens egne, oppløste verdier", () => {
    expect(linkCall).toContain("authorized.identity.tenant_id");
    expect(linkCall).toContain("authorized.identity.memory_space_id");
    expect(linkCall).toContain("authorized.chat_id");
    expect(linkCall).toContain("authorized.identity.person_id");
  });

  it("D2: meldingsteksten forekommer ikke i lenkekallet", () => {
    expect(/\btext\b/.test(linkCall), "text skal ikke delta i lenkingen").toBe(false);
  });

  it("D3: en feilende lenking blokkerer ikke samtalen (proveniens, ikke autorisasjon)", () => {
    expect(chatHandler).toContain("catch (err)");
    expect(chatHandler).toContain("telegram_owner_identity_link_failed");
  });

  it("D4: teksten brukes KUN som samtaleinnhold - ett eneste sted i hele handleren", () => {
    // `text` skal forekomme i destruktureringen og i handle()-kallet. Ingen
    // tredje bruk betyr at ubetrodd innhold ikke lekker inn i noen annen avgjørelse.
    expect(chatHandler.match(/\btext\b/g) ?? []).toHaveLength(2);
    expect(chatHandler).toContain("conversationEngine.handle(authorized.identity, text)");
  });
});
