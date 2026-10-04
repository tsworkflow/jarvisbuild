import { serviceLabel } from "./tool-catalog.ts";
import type { Surface } from "./tool-manifest.ts";

/**
 * D-389: deterministisk forklaring av et mislykket verktøykall - til MODELLEN, så Charlie kan si på vanlig norsk hva som gikk galt og
 * hva Tobias selv kan gjøre (f.eks. legge inn en nøkkel under Integrasjoner) i stedet for å gjette, prøve blindt på nytt eller påstå
 * at tjenesten ikke finnes. Teksten er kun veiledning: hvorvidt kallet ble avvist, avgjøres UENDRET i trusted lag (gateway/policy/
 * executor). Ingen hemmeligheter, ingen interne stier - kun kategori, tjeneste og handling.
 */
export interface ToolFailureExplanation {
  /** Hva som skjedde og hva Tobias kan gjøre - skrives for å gjengis til eieren. */
  message: string;
  /** Om modellen bør prøve igjen: aldri / senere (ikke i denne turen) / én gang til med rettede parametre. */
  retry: "never" | "later" | "with_corrected_parameters";
  /** Hvor problemet løses, når det er eierens sak. */
  fix_location?: "integrations_dashboard" | "owner_controls" | "owner_message";
}

export interface ToolFailureContext {
  tool_id?: string;
  action?: string;
  surface?: Surface;
  /** Tjenester som finnes på flaten (brukes når verktøyet ikke finnes). */
  available_services?: ReadonlyArray<string>;
}

const label = (ctx: ToolFailureContext) => (ctx.tool_id ? serviceLabel(ctx.tool_id) : "tjenesten");
/** HTTP-status i en transportfeil (`jira_http_401`, `HTTP 404`, `status=429`) - `\b` virker ikke rundt understrek. */
const hasStatus = (detail: string, codes: string) => new RegExp(`(^|\\D)(${codes})(\\D|$)`).test(detail);

function explainTransportError(detail: string, ctx: ToolFailureContext): ToolFailureExplanation {
  const svc = label(ctx);
  if (/home_assistant_base_url_not_configured|home_rooms_not_configured|home_rooms_invalid_json/.test(detail)) {
    return {
      message: `Hjemmet (Home Assistant) er ikke ferdig satt opp: adresse og/eller romkart (JARVIS_HA_BASE_URL/JARVIS_HA_ROOMS) mangler eller er ugyldig. Si til Tobias at han kan fylle dette inn under Integrasjoner → Home Assistant.`,
      retry: "never", fix_location: "integrations_dashboard"
    };
  }
  if (/home_room(_domain)?_not_mapped:/.test(detail)) {
    return {
      message: `Rommet/enheten finnes ikke i romkartet for hjemmet (${detail.replace(/^.*not_mapped:/, "")}). Spør Tobias hvilket rom han mener, eller si at rommet må legges inn i romkartet under Integrasjoner.`,
      retry: "with_corrected_parameters", fix_location: "integrations_dashboard"
    };
  }
  if (/_not_configured|not configured|missing_(base_url|team_id|workspace)/i.test(detail)) {
    return {
      message: `${svc} mangler en innstilling (${detail}). Si til Tobias at han kan fylle den inn under Integrasjoner i dashbordet.`,
      retry: "never", fix_location: "integrations_dashboard"
    };
  }
  if (hasStatus(detail, "401|403") || /unauthori[sz]ed|forbidden|invalid[_ ]token|token[_ ]expired|auth/i.test(detail)) {
    return {
      message: `${svc} avviste nøkkelen (ikke autorisert). Nøkkelen kan være utløpt eller mangle rettigheter - si til Tobias at han kan fornye den under Integrasjoner. Ikke prøv igjen nå.`,
      retry: "never", fix_location: "integrations_dashboard"
    };
  }
  if (hasStatus(detail, "404") || /not[_ ]found/i.test(detail)) {
    return {
      message: `${svc} fant ikke det du ba om (finnes ikke, eller feil id/navn). Sjekk id-en mot en liste-handling først, eller spør Tobias hva han mener.`,
      retry: "with_corrected_parameters"
    };
  }
  if (hasStatus(detail, "429") || /rate|too many/i.test(detail)) {
    return { message: `${svc} er midlertidig begrenset (for mange kall). Svar med det du har og si at det kan prøves igjen om litt.`, retry: "later" };
  }
  if (hasStatus(detail, "5\\d\\d") || /timeout|timed out|econn|enotfound|fetch failed|network|unavailable/i.test(detail)) {
    return {
      message: `${svc} svarer ikke akkurat nå (nettverk/tjenestefeil). Si det ærlig til Tobias og foreslå å prøve igjen senere - ikke i denne turen.`,
      retry: "later"
    };
  }
  if (/unsupported_action|unsupported/i.test(detail)) {
    return { message: `Handlingen støttes ikke av ${svc} sin tilkobling ennå (${detail}). Si det til Tobias; ikke prøv igjen.`, retry: "never" };
  }
  if (hasStatus(detail, "400|422") || /invalid|validation|bad request/i.test(detail)) {
    return {
      message: `${svc} avviste innholdet i kallet (${detail}). Sjekk feltene mot skjemaet og prøv én gang til med rettede verdier - ellers spør Tobias.`,
      retry: "with_corrected_parameters"
    };
  }
  return { message: `${svc} feilet: ${detail}. Si det ærlig til Tobias; prøv ikke samme kall på nytt i denne turen.`, retry: "later" };
}

export function explainToolFailure(category: string, ctx: ToolFailureContext = {}): ToolFailureExplanation {
  const svc = label(ctx);
  const act = ctx.action ? ` (${ctx.action})` : "";
  switch (category) {
    case "TOOL_NOT_FOUND":
    case "unknown_tool": {
      const list = (ctx.available_services ?? []).map(serviceLabel);
      return {
        message:
          `Verktøyet finnes ikke i denne runden. ` +
          (list.length > 0
            ? `Tjenester som finnes her: ${list.join(", ")}. Be Tobias nevne tjenesten han mener, så får du skjemaet neste melding.`
            : "Be Tobias nevne tjenesten han mener."),
        retry: "never", fix_location: "owner_message"
      };
    }
    case "TOOL_NOT_ON_SURFACE":
      return {
        message:
          `${svc}${act} er ikke tilgjengelig i ${ctx.surface === "voice" ? "talesamtalen" : ctx.surface === "telegram" ? "Telegram" : "denne kanalen"} ` +
          "(tale og Telegram har bare lesing av et lite utvalg). Si til Tobias at dette gjøres i chatten eller dashbordet.",
        retry: "never"
      };
    case "TOOL_CALL_LIMIT":
      return {
        message: "Grensen for verktøykall i denne meldingen er nådd. Svar med det du har, og si at du fortsetter i neste melding om Tobias vil.",
        retry: "never"
      };
    case "TOOL_NOT_IN_MANIFEST":
      return { message: `${svc}${act} mangler i verktøymanifestet (intern konfigurasjonsfeil). Si det til Tobias; ikke prøv igjen.`, retry: "never" };
    case "credential_unavailable":
    case "credential_revoked":
    case "credential_not_bound_to_identity":
      return {
        message:
          `${svc} er ikke koblet til ennå (nøkkel mangler eller er tilbakekalt). Si til Tobias at han kan legge inn nøkkelen under ` +
          "Integrasjoner i dashbordet - og bruk gjerne check_my_capabilities for å vise hva som faktisk er koblet til. Ikke prøv igjen nå.",
        retry: "never", fix_location: "integrations_dashboard"
      };
    case "connector_frozen":
      return {
        message: `Tobias har fryst ${svc} i eierkontrollene. Si det, og at han kan oppheve frysingen i dashbordet om han vil. Ikke prøv igjen.`,
        retry: "never", fix_location: "owner_controls"
      };
    case "rate_limited":
      return { message: `${svc} har nådd kallgrensen for dette minuttet. Svar med det du har og si at det kan prøves igjen om litt.`, retry: "later" };
    case "invalid_parameters":
      return {
        message: `Kallet til ${svc}${act} hadde feil eller manglende felt. Les skjemaet (påkrevde felt og typer) og prøv én gang til med riktige verdier - ellers spør Tobias om det som mangler.`,
        retry: "with_corrected_parameters"
      };
    case "preflight_target_not_found":
      return { message: `Målet for ${svc}${act} finnes ikke (sjekk id/rom/navn med en lese-handling først).`, retry: "with_corrected_parameters" };
    case "confirmation_unavailable":
      return { message: "Bekreftelsesporten er ikke tilgjengelig, så handlingen kan ikke legges til godkjenning. Si det til Tobias; ikke prøv igjen.", retry: "never" };
    default:
      break;
  }
  if (category.startsWith("tool_failed:")) return explainTransportError(category.slice("tool_failed:".length), ctx);
  if (category.startsWith("preflight_failed:")) {
    return { message: `Forhåndssjekken før ${svc}${act} feilet (${category.slice("preflight_failed:".length)}). Si det til Tobias; ikke prøv igjen nå.`, retry: "never" };
  }
  if (category.startsWith("scope_mismatch:") || category.startsWith("job_") || category === "tool_not_in_job_contract") {
    return { message: `Kallet gjaldt noe utenfor det denne samtalen/jobben har lov til (${category}). Ikke prøv igjen; si det til Tobias.`, retry: "never" };
  }
  if (category.startsWith("class_d_")) {
    return {
      message: `${svc}${act} er en kritisk handling som krever Tobias sin signerte godkjenning i dashbordet (${category}). Forklar det kort; ikke prøv igjen her.`,
      retry: "never", fix_location: "owner_controls"
    };
  }
  if (category.startsWith("postcondition")) {
    return {
      message: `${svc}${act} ble utført, men resultatet kunne ikke verifiseres etterpå (${category}). Si det ærlig til Tobias og be ham sjekke i tjenesten - ikke kjør handlingen på nytt.`,
      retry: "never"
    };
  }
  if (/kill_switch|paused|halt/i.test(category)) {
    return { message: `Alt er satt på pause av Tobias (${category}). Si det, og at han kan oppheve pausen i dashbordet. Ikke prøv igjen.`, retry: "never", fix_location: "owner_controls" };
  }
  if (/denied|not_allowed|forbidden|policy/i.test(category)) {
    return { message: `Sikkerhetspolicyen avviste ${svc}${act} (${category}). Si det til Tobias; ikke prøv igjen.`, retry: "never" };
  }
  return { message: `${svc}${act} feilet (${category}). Si det ærlig til Tobias; prøv ikke samme kall på nytt i denne turen.`, retry: "later" };
}
