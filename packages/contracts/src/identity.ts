import { z } from "zod";

/**
 * Minneområder (memory spaces) per CANONICAL_SPEC §3.
 * Ett logisk minne, strengt adskilte sikkerhetsområder.
 */
export const MemorySpaceSchema = z.enum([
  "personal",
  "business",
  "project",
  "health",
  "home",
  "guest",
  "shared"
]);
export type MemorySpace = z.infer<typeof MemorySpaceSchema>;

/**
 * Remediering del 2 (JARVIS-076): RLS leser `jarvis.memory_spaces` som en KOMMA-separert liste
 * (`string_to_array(current_setting('jarvis.memory_spaces', true), ',')`). Semantikken er derfor presis: elementene
 * sammenlignes EKSAKT (ingen trimming - `'personal, business'` gir elementene `personal` og ` business`, og det
 * siste matcher ingenting = fail closed). Serialiseringen skjer KUN her: hvert element må være en gyldig
 * `MemorySpace` (ingen komma/mellomrom/injeksjon), duplikater fjernes, og en tom liste avvises (en tom GUC ville
 * gitt tom rad-mengde, men en eksplisitt feil er tryggere enn en stille tom kontekst).
 */
export function serializeMemorySpaces(spaces: readonly string[]): string {
  if (!Array.isArray(spaces) || spaces.length === 0) throw new Error("memory_spaces_empty");
  const parsed = spaces.map((s) => MemorySpaceSchema.safeParse(s));
  if (parsed.some((r) => !r.success)) throw new Error("memory_spaces_invalid");
  return [...new Set(parsed.map((r) => (r as { data: string }).data))].join(",");
}

/**
 * Gradert autentiseringsstyrke (SECURITY_MODEL §10).
 * passive < active < signed. Stemme alene gir aldri forhøyet styrke.
 */
export const AuthStrengthSchema = z.enum(["passive", "active", "signed"]);
export type AuthStrength = z.infer<typeof AuthStrengthSchema>;

/**
 * D-125 (UA-7): `telegram` er lagt til fordi eier-innkommende Telegram-tekst nå
 * faktisk går inn i den kanoniske samtale-/sesjonsbanen. Uten verdien måtte den
 * banen ha merket `sessions.last_channel` og audit-radene som `api` - altså
 * skrevet en USANN kilde (CLAUDE.md regel 4: alt minne og alle handlinger merkes
 * med kilde). Utvidelsen krever INGEN migrasjon (`sessions.last_channel` er
 * `text NOT NULL` uten CHECK-constraint, 002_sessions_events.sql) og INGEN
 * kodeendring andre steder (ingen uttømmende `switch` over `Channel` finnes;
 * `ChannelSchema` brukes kun i denne filen). Den utvider kun hva som ER gyldig -
 * den fjerner ingen tidligere gyldig verdi. Telegram forblir en TRANSPORT
 * (D-64 `EXTERNAL_CANONICAL`), aldri en identitets- eller autoritetskilde.
 */
/**
 * `desktop` (UA-7-generalisering av D-123/D-125, kanonisk local-agent-kontrakt
 * for Mac/Windows fra masterplanen): modellerer en lokal desktop-agent som en
 * ordinær `devices`-rad (`kind = 'desktop-agent'` - ingen skjemaendring,
 * `devices.kind` er allerede fritekst), autentisert med SAMME
 * `DeviceService.verifyChallenge()` Ed25519-proof-of-possession-primitiv som
 * enhver annen enhet, og autorisert via den nye, generiske
 * `ChannelSessionAuthority` (`modules/core/src/services/
 * channel-session-authority.ts`) med `channel = "desktop"` - IKKE en parallell
 * lokal-agent-infrastruktur. `desktop` er bevisst IKKE en tredjeparts-
 * leverandør-integrasjon (D-64): enheten er alltid Tobias sin egen, kjørt på
 * hans egen maskin, og eies fullt ut av den eksisterende kanoniske
 * enhets-/identitetsmodellen.
 *
 * Krever INGEN migrasjon, av samme grunn som D-125 sin `telegram`-utvidelse
 * over: `sessions.last_channel` er `text NOT NULL` uten CHECK-constraint
 * (002_sessions_events.sql), og ingen uttømmende `switch` over `Channel`
 * finnes andre steder - `ChannelSchema` brukes kun i denne filen. Utvidelsen
 * legger kun til en gyldig verdi; ingen tidligere gyldig verdi fjernes.
 *
 * FORMALISERT (D-292, 2026-09-26): denne verdien manglet et logget D-nummer
 * fordi økten som la den til ikke fikk endre `docs/*` - rettet i samme post
 * som la til `slack` under (se D-292 i `DECISIONS_AND_ASSUMPTIONS.md`).
 */
/**
 * `discord` (D-294, samme UA-7-generalisering av D-125 sitt `telegram`-
 * mønster som `slack` under): Discord-boten (`DiscordTransport`,
 * `live-transports.ts`) er en TRANSPORT (D-64 `EXTERNAL_CANONICAL`), aldri
 * en identitets- eller autoritetskilde - IDENTISK begrunnelse som `telegram`/
 * `slack`. Krever INGEN migrasjon, samme uendrede `text NOT NULL`-kolonne.
 */
/**
 * `twilio` (D-295, samme UA-7-generalisering av D-125 sitt `telegram`-
 * mønster som `slack`/`discord`): SMS via `TwilioTransport` er en TRANSPORT
 * (D-64 `EXTERNAL_CANONICAL`), aldri en identitets- eller autoritetskilde -
 * IDENTISK begrunnelse som `telegram`/`slack`/`discord`. Krever INGEN
 * migrasjon, samme uendrede `text NOT NULL`-kolonne.
 */
/**
 * `slack` (D-292, UA-7-generalisering av D-125 sitt `telegram`-mønster):
 * Slack-boten (`SlackTransport`, `live-transports.ts`) er en TRANSPORT
 * (D-64 `EXTERNAL_CANONICAL`), aldri en identitets- eller autoritetskilde -
 * IDENTISK begrunnelse som `telegram` over. Krever INGEN migrasjon, samme
 * grunn: `sessions.last_channel` er `text NOT NULL` uten CHECK-constraint,
 * ingen uttømmende `switch` over `Channel` finnes andre steder.
 */
export const ChannelSchema = z.enum([
  "web", "mobile", "watch", "voice", "api", "system", "telegram", "desktop", "slack", "discord", "twilio"
]);
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Identitetskontekst som følger hver forespørsel (CANONICAL_SPEC §3).
 * Fase 1: bevisst minimal - ingen auth-flyt, kun kontrakten.
 */
export const IdentityContextSchema = z
  .object({
    person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    memory_space_id: MemorySpaceSchema,
    session_id: z.string().min(1),
    device_id: z.string().min(1),
    site_id: z.string().min(1).optional(),
    room_id: z.string().min(1).optional(),
    channel: ChannelSchema,
    auth_strength: AuthStrengthSchema,
    /** Satt når en agent handler på vegne av personen. Revisjon av kjeden kommer i fase 2 (K-10). */
    delegation_id: z.string().min(1).optional()
  })
  .strict();
export type IdentityContext = z.infer<typeof IdentityContextSchema>;
