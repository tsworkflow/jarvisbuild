import {
  IdentityContextSchema,
  ToolCallSchema,
  type IdentityContext,
  type ToolCall
} from "@jarvis/contracts";
import { verifyApproval } from "./approval-verifier.ts";
import { resolveAuthorityMode, type AuthorityConfig, type OwnerControls } from "./authority.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import type { InfraExecutionGate } from "./infra-execution-gate.ts";
import { KillSwitch } from "./kill-switch.ts";
import type { NonceStore } from "./nonce-store.ts";
import { isSelfRecoveryAction } from "./owner-control-store.ts";

export type Decision = "ALLOW" | "DENY";

export interface AuthorizationResult {
  decision: Decision;
  /** Maskinlesbar årsak - logges alltid til audit. */
  reason: string;
  /**
   * Remediering del 2 (JARVIS-051): satt KUN når kalleren ba om utsatt nonce-forbruk
   * (`deferNonceConsumption`) og en signert godkjenning ble verifisert. Kalleren MÅ
   * kalle den (og kreve `ok: true`) rett FØR den irreversible handlingen - etter at alle
   * andre porter (rate limit, frys, credential, preflight) har passert. En godkjenning
   * som feiler en ortogonal port brenner dermed ikke engangs-noncen.
   */
  commit?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface AuthorizationRequest {
  identity: IdentityContext;
  toolCall: ToolCall;
  /** Kreves for klasse D. Ignoreres ikke for andre klasser hvis oppgitt, men er ikke påkrevd. */
  approval?: unknown;
  /** Utsett forbruk av godkjenningens nonce til kalleren kaller `commit()` (se `AuthorizationResult.commit`). */
  deferNonceConsumption?: boolean;
}

/** Audit-hendelse fra Policy Gateway. Append-only sink; ekstern lagring fra fase 2. */
export interface PolicyAuditEvent {
  at: string;
  decision: Decision;
  reason: string;
  person_id: string;
  tenant_id: string;
  session_id: string;
  tool_id: string;
  action: string;
  capability_class: string;
}

export interface PolicyGatewayOptions {
  devices: DeviceRegistry;
  nonces: NonceStore;
  killSwitch: KillSwitch;
  /** Mandater for klasse C i fase 1: liste av "tool_id:action" som er eksplisitt tillatt. */
  mandates?: ReadonlySet<string>;
  /** v4.0: sovereign owner-modus. Uten config gjelder legacy-reglene uendret. */
  authority?: AuthorityConfig;
  /** v4.0: owner-kontroller (freeze/revoke) håndhevet i execution path. */
  controls?: OwnerControls;
  /**
   * D-104 (UA-5 Production Operations Control Plane v1): global infra-
   * eksekusjonsmodus (NORMAL/DEGRADED/PAUSED) - EN NY, SNEVRERE bryter enn
   * `killSwitch` (som forblir strengest/uendret, blokkerer ALT). Gjelder
   * KUN `toolCall.tool_id`-er i `infraToolIds` - alle andre verktøy er
   * 100% uendret av denne gaten. Uten begge feltene satt er oppførselen
   * BYTE-IDENTISK fra før D-104.
   */
  infraGate?: InfraExecutionGate;
  infraToolIds?: ReadonlySet<string>;
  auditSink?: (event: PolicyAuditEvent) => void;
  clock?: () => Date;
}

/**
 * Deterministisk Policy Gateway (SECURITY_MODEL §4) - fase 1-skjelett.
 * ALLE verktøykall skal gjennom authorize(); rask bane hopper over LLM,
 * aldri over policyen. Ingen LLM brukes i sikkerhetsavgjørelser.
 */
export class PolicyGateway {
  private readonly devices: DeviceRegistry;
  private readonly nonces: NonceStore;
  private readonly killSwitch: KillSwitch;
  private readonly mandates: ReadonlySet<string>;
  private readonly auditSink: (event: PolicyAuditEvent) => void;
  private readonly clock: () => Date;
  readonly auditLog: PolicyAuditEvent[] = [];
  private readonly opts: PolicyGatewayOptions;

  constructor(options: PolicyGatewayOptions) {
    this.opts = options;
    this.devices = options.devices;
    this.nonces = options.nonces;
    this.killSwitch = options.killSwitch;
    this.mandates = options.mandates ?? new Set();
    this.clock = options.clock ?? (() => new Date());
    this.auditSink = options.auditSink ?? ((event) => this.auditLog.push(event));
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    // Kontraktvalidering først: ugyldig input er alltid DENY, aldri unntak videre opp.
    const identity = IdentityContextSchema.safeParse(request.identity);
    if (!identity.success) {
      return this.finish(request, "DENY", "invalid_identity_context");
    }
    const toolCall = ToolCallSchema.safeParse(request.toolCall);
    if (!toolCall.success) {
      return this.finish(request, "DENY", "invalid_tool_call");
    }

    // K1 (Sovereign graduation, D-164), UTVIDET D-166 (arkitekt-review
    // PR #93, funn B1): kill switch-sjekken bruker NÅ den AUTORITATIVE,
    // LIVE `isActiveDurable()`-spørringen (aldri den rene synkrone
    // `isActive()`) - se `KillSwitch` sitt filhode for hvorfor. Unntaket
    // fra "kill switch blokkerer ALT" er BEGRENSET til den delte,
    // navngitte `OWNER_CONTROLS_SELF_RECOVERY_ACTIONS`-mengden
    // (`get_control_state`/`deactivate_kill_switch`/`restore_credential` -
    // se `owner-control-store.ts` for FULL begrunnelse, inkl. hvorfor
    // `restore_credential` MÅ være i SAMME mengde som brukes her OG i
    // `ToolGateway.execute()` sin tilbakekalt-credential-sjekk: uten det
    // kunne en SAMTIDIG aktiv kill switch + tilbakekalt delt credential_ref
    // blitt et deadlock ingen kanonisk vei kunne bryte). Unntaket fjerner
    // KUN denne ene, tidlige DENY-en - resten av `authorize()` (identitet/
    // kontrakt/sovereign-autoritet/klasse-D-godkjenning) gjelder UENDRET
    // for disse handlingene, så en forfalsket eller ikke-eier-identitet
    // kan FORTSATT ikke deaktivere kill switchen eller gjenopprette en
    // tilbakekalt credential.
    //
    // D-174 (B2): SAMME utvidelse som `ToolGateway.execute()` sin
    // tilbakekalt-credential-sjekk (se der for full begrunnelse) - den
    // YTRE `executive.*`-proxyen for disse navngitte handlingene må
    // IKKE selv bli avslått av kill-switch-aktiv-sjekken FØR den når det
    // nestede, allerede trygge `owner_controls.*`-kallet.
    // D-176 (RETTET, BLOKKER B5): `executive` sine handlingsnavn er IKKE
    // identiske med `owner_controls` sine for LESING (`get_control_surface_
    // status` vs. `get_control_state`), OG `get_control_surface_status`
    // komponerer i tillegg `situations.get_pause_state`/`finance.
    // get_kill_switch` - se `isSelfRecoveryAction()` i owner-control-store.ts
    // for den eksplisitte per-(tool_id,action)-mappingen som ERSTATTER den
    // tidligere (feilaktige) antakelsen om identiske navn/kun to tool_id-er.
    const isKillSwitchSelfRecovery = isSelfRecoveryAction(toolCall.data.tool_id, toolCall.data.action);
    if (!isKillSwitchSelfRecovery && (await this.killSwitch.isActiveDurable())) {
      return this.finish(request, "DENY", "kill_switch_active");
    }
    // `owner_controls`-verktøyet selv kan ALDRI fryses ut av sin egen
    // frys-mekanisme (samme selvgjenopprettings-prinsipp som over) - uten
    // dette unntaket kunne en frys av "owner_controls" gjort
    // `unfreeze_connector` permanent utilgjengelig for AKKURAT den frysen.
    if (toolCall.data.tool_id !== "owner_controls" && (await this.opts?.controls?.isFrozenDurable(toolCall.data.tool_id))) {
      return this.finish(request, "DENY", "connector_frozen");
    }
    // D-104: infra-modus-gaten gjelder KUN registrerte infra-tool_id-er -
    // for alle andre tool_id-er (eller uten infraGate/infraToolIds
    // konfigurert i det hele tatt) er denne sjekken et strukturelt no-op.
    if (this.opts?.infraGate && this.opts?.infraToolIds?.has(toolCall.data.tool_id)) {
      const infraDeny = this.opts.infraGate.check(toolCall.data.capability_class);
      if (infraDeny) {
        return this.finish(request, "DENY", infraDeny);
      }
    }
    // v4.0: A-D er risikoklasser. SOVEREIGN owner-modus gir autonom utførelse;
    // sikkerheten leveres av D-pipelinen (preflight/readback/evidens/recovery)
    // i Tool Gateway + owner-kontrollene over - ikke av approval-friksjon.
    const mode = resolveAuthorityMode(this.opts?.authority, identity.data);

    switch (toolCall.data.capability_class) {
      case "A":
        return this.finish(request, "ALLOW", "class_a_read");
      case "B": {
        if (identity.data.auth_strength === "passive" && mode !== "SOVEREIGN") {
          return this.finish(request, "DENY", "class_b_requires_active_auth");
        }
        return this.finish(request, "ALLOW", "class_b_reversible_internal");
      }
      case "C": {
        if (mode === "SOVEREIGN") {
          return this.finish(request, "ALLOW", "class_c_sovereign_authority");
        }
        const mandateKey = `${toolCall.data.tool_id}:${toolCall.data.action}`;
        if (!this.mandates.has(mandateKey)) {
          return this.finish(request, "DENY", "class_c_no_mandate");
        }
        return this.finish(request, "ALLOW", "class_c_within_mandate");
      }
      case "D": {
        if (mode === "SOVEREIGN" && request.approval === undefined) {
          return this.finish(request, "ALLOW", "class_d_sovereign_authority");
        }
        // Approval-systemet beholdes: brukes for scoped tenants/delegater, og
        // valgfritt for owner når en approval faktisk sendes med.
        return this.authorizeClassD(request, toolCall.data);
      }
    }
  }

  private async authorizeClassD(
    request: AuthorizationRequest,
    toolCall: ToolCall
  ): Promise<AuthorizationResult> {
    if (request.approval === undefined) {
      return this.finish(request, "DENY", "class_d_missing_approval");
    }
    const check = await verifyApproval(
      request.approval,
      {
        tool_id: toolCall.tool_id,
        action: toolCall.action,
        parameters: toolCall.parameters,
        tenant_id: request.identity.tenant_id,
        person_id: request.identity.person_id
      },
      this.devices,
      this.clock()
    );
    if (!check.valid) {
      return this.finish(request, "DENY", `class_d_${check.reason}`);
    }
    const approval = check.approval;
    // Alle kontroller OK - forbruk engangs-ID-en (replay-vern). Feil i lageret er
    // DENY (fail-closed): usikkerhet gir aldri ALLOW.
    const consume = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      let firstUse: boolean;
      try {
        firstUse = await this.nonces.consume({
          nonce: approval.nonce,
          tenant_id: request.identity.tenant_id,
          tool_id: approval.tool_id,
          action: approval.action,
          parameters: toolCall.parameters,
          parameters_hash: approval.parameters_hash,
          requester_person_id: approval.person_id,
          approver_person_id: approval.approver_person_id,
          approving_device_id: approval.approving_device_id,
          issued_at: approval.issued_at,
          expires_at: approval.expires_at
        });
      } catch {
        return { ok: false, reason: "class_d_nonce_store_error" };
      }
      return firstUse ? { ok: true } : { ok: false, reason: "class_d_nonce_already_used" };
    };
    if (request.deferNonceConsumption === true) {
      const decided = this.finish(request, "ALLOW", "class_d_valid_signed_approval_pending_commit");
      return {
        ...decided,
        commit: async () => {
          const result = await consume();
          if (!result.ok) {
            this.finish(request, "DENY", result.reason);
          }
          return result;
        }
      };
    }
    const consumed = await consume();
    if (!consumed.ok) {
      return this.finish(request, "DENY", consumed.reason);
    }
    return this.finish(request, "ALLOW", "class_d_valid_signed_approval");
  }

  private finish(request: AuthorizationRequest, decision: Decision, reason: string): AuthorizationResult {
    this.auditSink({
      at: this.clock().toISOString(),
      decision,
      reason,
      person_id: request.identity?.person_id ?? "unknown",
      tenant_id: request.identity?.tenant_id ?? "unknown",
      session_id: request.identity?.session_id ?? "unknown",
      tool_id: request.toolCall?.tool_id ?? "unknown",
      action: request.toolCall?.action ?? "unknown",
      capability_class: request.toolCall?.capability_class ?? "unknown"
    });
    return { decision, reason };
  }
}
