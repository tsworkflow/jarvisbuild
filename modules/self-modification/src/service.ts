import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import type { SandboxRunner, TaskService } from "@jarvis/tasks";
import {
  GIT_CREDENTIAL_ISOLATION_ARGS, GIT_HARDENING_ARGS, GIT_LOCAL_HARDENING_ARGS, assertRepoAllowed, createGitAuthHandle,
  githubCredentialScope, publishPullRequestForCodingJob, type PrPublishingGateway
} from "@jarvis/tasks";
import { classifySelfModification } from "./policy.ts";
import { PersonalityConfigSchema, type PersonalityConfig, type SelfModificationRequest, type SelfModificationRequestStatus } from "./types.ts";
import type { SelfModificationGithubClient } from "./github-client.ts";

const PERSONALITY_CONFIG_PATH = "config/charlie-personality.json";

export interface SelfModificationServiceDeps {
  pool: pg.Pool;
  sandbox: SandboxRunner;
  /**
   * D-102-mønster (createCodingHandler sitt `gitAuth`-felt): oppløses PÅ
   * HVERT kall, ALDRI cachet - reflekterer token-rotasjon, og en manglende
   * verdi feiler eksplisitt (`self_modification_git_auth_unavailable`) FØR
   * noe git-arbeid forsøkes, ALDRI et stille fall til uautentisert git.
   */
  resolveGitToken: () => Promise<string | null>;
  githubClient: SelfModificationGithubClient;
  /** Gjenbruker DEN SAMME `github.create_pr`-veien (klasse C) som UA-5 sin kodejobb-pipeline - INGEN ny PR-opprettelsesmekanisme. */
  prGateway: PrPublishingGateway;
  /** `owner/repo` - default matcher SAMME repo `connector-registry.ts` sin github-`live_test` allerede antar. */
  repoSlug?: string;
  baseBranch?: string;
  /** `JARVIS_OWNER_PERSON_ID` - selvendring er en eier-KUN-handling, se `assertOwner()`. */
  ownerPersonId: string;
  /**
   * Task #123 (D-214): `proposeCodeChange()` sin ENESTE vei til å faktisk
   * PRODUSERE en kodeendring - SAMME delte `TaskService`-instans som
   * `ConversationEngine`/`/tasks/submit` (apps/api/src/main.ts), ALDRI en
   * parallell kø-tilkobling. `submit()` kjører sin EGEN policy-sjekk
   * (`tasks.submit_task`, klasse B) mot den VIDEREFORMIDLEDE identiteten -
   * denne tjenesten fabrikkerer/eskalerer ALDRI en identitet selv (D-68).
   */
  taskService: TaskService;
  /**
   * Task #123 (D-214, valgfritt): owner-varsling når en rad trenger
   * oppmerksomhet (ny `awaiting_approval`, `pending_job` blokkert av policy,
   * merget). SAMME `sendTelegram`-lukning main.ts allerede bruker for
   * `/brief`/DailyScheduler - INGEN parallell varslingsmekanisme. Valgfri
   * (og feil her svelges, ALDRI kastet videre) slik at en Telegram-feil
   * aldri kan blokkere selve klassifiserings-/tilstandsovergangen - varselet
   * er en bekvemmelighet, IKKE en del av selve sikkerhetsgarantien
   * (eieren kan uansett spørre `getRequest()` eksplisitt).
   */
  notify?: (text: string) => Promise<void>;
}

function requestRowFromDb(row: Record<string, unknown>): SelfModificationRequest {
  return {
    request_id: row["request_id"] as string,
    kind: row["kind"] as string,
    risk: row["risk"] as SelfModificationRequest["risk"],
    target_paths: row["target_paths"] as string[],
    branch: row["branch"] as string,
    pr_number: row["pr_number"] as string,
    pr_url: row["pr_url"] as string,
    status: row["status"] as SelfModificationRequestStatus,
    requested_by_person_id: row["requested_by_person_id"] as string,
    summary: row["summary"] as string,
    created_at: (row["created_at"] as Date).toISOString(),
    resolved_at: row["resolved_at"] ? (row["resolved_at"] as Date).toISOString() : null,
    resolved_by_person_id: (row["resolved_by_person_id"] as string | null) ?? null,
    coding_task_id: (row["coding_task_id"] as string | null) ?? null,
    coding_tenant_id: (row["coding_tenant_id"] as string | null) ?? null
  };
}

/** Svelger en `notify()`-feil (aldri kastet videre) - se `SelfModificationServiceDeps.notify` sin doc-kommentar for hvorfor. */
async function safeNotify(notify: ((text: string) => Promise<void>) | undefined, text: string): Promise<void> {
  if (!notify) return;
  try {
    await notify(text);
  } catch (err) {
    console.error(JSON.stringify({ msg: "self_modification_notify_failed", error: (err as Error).message }));
  }
}

/**
 * Task #121+#123 (D-214): se README-kommentaren i policy.ts/github-client.ts
 * for den fulle sikkerhetsbegrunnelsen. Denne tjenesten eier HELE to-lags-
 * modellen D-208 vedtok, BEGGE produsenter og BEGGE merge-veier:
 *   1. `proposePersonalityChange()` - zero-review, strukturelt begrenset
 *      til ÉN skjemavalidert fil, kjent FØR noe git-arbeid.
 *   2. `proposeCodeChange()` (task #123) - requires_approval, gjenbruker
 *      den eksisterende `createCodingHandler`-kodeagent-pipelinen
 *      ASYNKRONT (task-køen) - target_paths ukjent til jobben fullfører.
 *   3. `sweepPendingJobs()` (task #123) - følger opp #2 sine async-jobber,
 *      klassifiserer den FAKTISKE diffen når den finnes, ruter videre til
 *      enten den eksisterende zero-review-sveipen (#4) eller
 *      `awaiting_approval`.
 *   4. `sweepPendingRequests()` - CI-portvakten for zero-review-automergen.
 *   5. `resolveApproval()` - den generiske Telegram-godkjennings-
 *      tilstandsmaskinen for requires_approval-sporet.
 *   6. `sweepApprovedRequests()` (task #123) - merger en `/godkjenn`-
 *      godkjent rad via DEN SAMME `attemptMerge()` som #4.
 */
export class SelfModificationService {
  private readonly repoSlug: string;
  private readonly baseBranch: string;

  constructor(private readonly deps: SelfModificationServiceDeps) {
    this.repoSlug = deps.repoSlug ?? process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild";
    this.baseBranch = deps.baseBranch ?? "main";
  }

  /**
   * D-68-disiplin: kalleren gir DEN EKTE, løste identiteten - denne
   * metoden fabrikkerer eller eskalerer ALDRI en identitet selv. Kun
   * `assertOwner()` under avgjør autoritet, basert på DEN identiteten.
   */
  private assertOwner(identity: IdentityContext): void {
    if (identity.person_id !== this.deps.ownerPersonId) {
      throw new Error("self_modification_owner_only");
    }
  }

  /**
   * Zero-review-sporet. Skjemavalidering (PersonalityConfigSchema) skjer
   * FØR noe git-arbeid i det hele tatt - en ugyldig konfig kaster her,
   * INGEN branch/commit/PR for den. `classifySelfModification()` kjøres
   * likevel eksplisitt mot den FAKTISKE, ENESTE endrede stien (aldri
   * hardkodet forbi klassifiseringsmotoren) - det er den SAMME autoriteten
   * `sweepPendingRequests()` re-verifiserer senere, ikke en snarvei.
   */
  async proposePersonalityChange(
    identity: IdentityContext,
    input: { tone_descriptors: string[]; style_notes: string }
  ): Promise<{ request_id: string; pr_number: string; pr_url: string; branch: string; risk: string }> {
    this.assertOwner(identity);

    const config: PersonalityConfig = PersonalityConfigSchema.parse({
      tone_descriptors: input.tone_descriptors,
      style_notes: input.style_notes,
      updated_at: new Date().toISOString(),
      updated_by: identity.person_id
    });

    const risk = classifySelfModification([PERSONALITY_CONFIG_PATH]);
    if (risk !== "zero_review") {
      // Strukturelt uråkbart med DAGENS allowlist (policy.ts har KUN denne
      // ene stien) - men fail-closed likevel: en fremtidig regresjon i
      // policy.ts skal ALDRI stille la personlighetsendringer automerges.
      throw new Error(`self_modification_unexpected_risk:${risk}`);
    }

    const gitToken = await this.deps.resolveGitToken();
    if (!gitToken) throw new Error("self_modification_git_auth_unavailable");

    const branch = `jarvis/self-mod/personality-${Date.now()}`;
    // Remediering del 2 (JARVIS-064): credentialen gjelder kun github.com + dette ene (konfigurerte) repoet.
    const repoUrl = `https://github.com/${this.repoSlug}.git`;
    const repoRef = assertRepoAllowed(repoUrl, [this.repoSlug.toLowerCase()]);
    const gitAuth = await createGitAuthHandle(gitToken, githubCredentialScope(repoRef.slug));
    const sandbox = await this.deps.sandbox.create();
    try {
      const netArgs = (args: string[]): string[] => [...GIT_CREDENTIAL_ISOLATION_ARGS, ...gitAuth.credentialHelperArgs, ...GIT_HARDENING_ARGS, ...args];
      const localGit = (args: string[]) => sandbox.exec("git", [...GIT_LOCAL_HARDENING_ARGS, ...args]);
      const mustOk = (label: string, result: { code: number; stderr?: string }) => {
        if (result.code !== 0) throw new Error(`self_modification_${label}_failed:${(result.stderr ?? "").slice(0, 200)}`);
      };
      mustOk("clone", sandbox.exec("git", netArgs(["clone", "--depth", "1", "--branch", this.baseBranch, "--", repoRef.canonicalUrl, "."]), undefined, gitAuth.env));
      mustOk("branch", localGit(["checkout", "-b", branch]));
      const content = `${JSON.stringify(config, null, 2)}\n`;
      const writeResult = sandbox.exec("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(PERSONALITY_CONFIG_PATH)}, ${JSON.stringify(content)})`]);
      mustOk("write_config", writeResult);
      mustOk("add", localGit(["add", "--", PERSONALITY_CONFIG_PATH]));
      // D-101-mønster (coding.ts): sjekk at NØYAKTIG den forventede stien ble
      // endret FØR commit - en agent/prosess-feil som ved et uhell rørte en
      // annen fil skal ALDRI committes stille.
      const staged = localGit(["diff", "--cached", "--name-only"]);
      const stagedPaths = staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (stagedPaths.length !== 1 || stagedPaths[0] !== PERSONALITY_CONFIG_PATH) {
        throw new Error(`self_modification_unexpected_staged_paths:${stagedPaths.join(",")}`);
      }
      mustOk("commit", localGit(["commit", "-m", `jarvis: oppdater Charlie sin personlighetskonfig (${identity.person_id})`]));
      mustOk("push", sandbox.exec("git", netArgs(["push", "origin", `${branch}:${branch}`]), undefined, gitAuth.env));

      const taskId = `self-mod-${randomUUID()}`;
      const jobContract: JobContract = {
        task_id: taskId,
        owner_person_id: identity.person_id,
        tenant_id: identity.tenant_id,
        goal: "self-modification: personality config update",
        acceptance_criteria: ["config/charlie-personality.json validates against PersonalityConfigSchema"],
        input: { data: {}, trust_level: "internal", provenance: "self-modification-service" },
        allowed_tools: ["github"],
        allowed_memory_spaces: [],
        allowed_network_targets: [],
        agent_profile: "executive",
        model_budget_ore: 0,
        retry_policy: { max_attempts: 1, backoff_seconds: 0 },
        max_steps: 1
      };
      const pr = await publishPullRequestForCodingJob({
        gateway: this.deps.prGateway,
        identity,
        jobContract,
        repoUrl,
        branch,
        base: this.baseBranch,
        title: "jarvis: oppdater Charlie sin personlighetskonfig",
        body:
          `Zero-review selvendring (task #121, D-214) - eneste endrede fil: \`${PERSONALITY_CONFIG_PATH}\`.\n\n` +
          `Automerges av \`SelfModificationService.sweepPendingRequests()\` når CI er grønt OG diffen fortsatt ` +
          `er eksakt denne ene filen - ingen manuell gjennomgang for DENNE navngitte, skjemavaliderte konfigurasjonen.`
      });
      if (pr.status === "failed" || pr.status === "skipped_not_allowed" || pr.status === "skipped_unparseable_repo") {
        throw new Error(`self_modification_pr_publish_failed:${pr.status}:${pr.reason ?? ""}`);
      }
      if (!pr.pr_number) {
        throw new Error("self_modification_pr_missing_number");
      }

      const requestId = `selfmod-${randomUUID()}`;
      await this.deps.pool.query(
        `INSERT INTO self_modification_requests
           (request_id, kind, risk, target_paths, branch, pr_number, pr_url, status, requested_by_person_id, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          requestId, "personality_config", risk, [PERSONALITY_CONFIG_PATH], branch, pr.pr_number, pr.pr_url ?? "",
          "pending_ci", identity.person_id, `Personlighetskonfig oppdatert av ${identity.person_id}`
        ]
      );
      return { request_id: requestId, pr_number: pr.pr_number, pr_url: pr.pr_url ?? "", branch, risk };
    } finally {
      await sandbox.dispose();
      await gitAuth.cleanup();
    }
  }

  /**
   * Task #123 (D-214), `requires_approval`-sporets ENESTE produsent av EKTE
   * kodeendrings-forespørsler. I MOTSETNING til `proposePersonalityChange()`
   * skriver denne INGEN fil selv, kjører INGEN sandbox/git direkte - den
   * SENDER en full `JobContract` (agent_profile:"coding") til den
   * EKSISTERENDE, produksjonsreelle kodeagent-pipelinen
   * (`createCodingHandler`/`ClaudeCodeAgent`, D-96/D-100/D-101) via
   * `taskService.submit()`. Grunnen: den pipelinen eier ALLEREDE sandbox-
   * isolasjon, ekte agent-kjøring, testkjøring og PR-opprettelse - å bygge
   * en ANDEN, parallell git-agent-pipeline her ville vært nøyaktig den
   * D-64 CORE OWNERSHIP-feilen (bygge det som allerede eies et annet sted)
   * CLAUDE.md advarer mot.
   *
   * `test_command` er BEVISST IKKE et parameter Charlie kan sette fra chat
   * (ville utvidet chat-overflaten til vilkårlig shell-argument-styring) -
   * default (ingen `test_command` i `input.data`) faller tilbake til
   * `createCodingHandler` sin EGEN no-op-standard. Dette er en bevisst,
   * dokumentert begrensning (D-41-disiplin: DEFERRED, ikke stille utelatt):
   * sandbox-eksekvering av HELE monorepo-test-/typecheck-suiten ville
   * strukturelt oversteget `ProcessSandboxRunner` sin 60s standard-
   * exec-timeout (bevist av denne økten sine egne ~15 min CI-kjøringer) -
   * den REELLE sikkerhetsnetting for kodeendringer er uansett GitHub CI
   * (`sweepPendingJobs()`/`attemptMerge()` under, ALDRI lokal sandbox-
   * testkjøring alene) - SAMME "stol på ekte CI, ikke en sandbox-kopi"-
   * disiplin som zero-review-sporets `attemptMerge()` allerede har.
   *
   * Raden settes inn med status `pending_job` FØR noe er kjent om selve
   * endringen - `target_paths`/`branch`/PR fylles først inn av
   * `sweepPendingJobs()` når jobben faktisk fullfører.
   */
  async proposeCodeChange(
    identity: IdentityContext,
    input: { goal: string }
  ): Promise<{ request_id: string; coding_task_id: string; branch: string }> {
    this.assertOwner(identity);
    if (input.goal.trim().length === 0) {
      throw new Error("self_modification_missing_goal");
    }

    const codingTaskId = `self-mod-code-${randomUUID()}`;
    const branch = `jarvis/${codingTaskId}`;
    const repoUrl = `https://github.com/${this.repoSlug}.git`;
    const jobContract: JobContract = {
      task_id: codingTaskId,
      owner_person_id: identity.person_id,
      tenant_id: identity.tenant_id,
      goal: input.goal,
      acceptance_criteria: ["endringen committes, pushes og en PR opprettes for eier-gjennomgang"],
      input: { data: { repo_url: repoUrl }, trust_level: "internal", provenance: "self-modification-service" },
      allowed_tools: ["github"],
      allowed_memory_spaces: [],
      allowed_network_targets: [],
      agent_profile: "coding",
      model_budget_ore: 0,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 },
      max_steps: 1
    };
    const submitted = await this.deps.taskService.submit(identity, jobContract);
    if (!submitted.ok) {
      throw new Error(`self_modification_job_submit_failed:${submitted.reason}`);
    }

    const requestId = `selfmod-${randomUUID()}`;
    await this.deps.pool.query(
      `INSERT INTO self_modification_requests
         (request_id, kind, risk, target_paths, branch, pr_number, pr_url, status, requested_by_person_id, summary,
          coding_task_id, coding_tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        requestId, "code_change", "requires_approval", [], branch, "", "",
        "pending_job", identity.person_id, input.goal.slice(0, 500),
        codingTaskId, identity.tenant_id
      ]
    );
    return { request_id: requestId, coding_task_id: codingTaskId, branch };
  }

  /**
   * Task #123 (D-214): følger opp `proposeCodeChange()` sine asynkrone
   * kodejobber. For HVER `pending_job`-rad: spør task-køen (SAMME
   * `taskService.get()` som `/tasks/*`-rutene bruker, ALDRI en direkte
   * kø-spørring) om jobbens status.
   *   - fortsatt kjørende -> uendret, prøves igjen neste sveip.
   *   - `cancelled`/`failed` -> `rejected` (ærlig, terminalt - se
   *     `tasks.last_error` for hvorfor via `getRequest()`/task-loggen selv).
   *   - `completed` UTEN en faktisk opprettet PR (ingen endring ble gjort,
   *     eller PR-publisering feilet) -> `rejected`.
   *   - `completed` MED en PR -> FERSK klassifisering av PR-ens FAKTISKE
   *     endrede filer (ALDRI antatt) via `classifySelfModification()`:
   *       - `forbidden` -> `rejected` UMIDDELBART, ALDRI presentert for
   *         godkjenning uansett hva eieren måtte ønske.
   *       - `zero_review` -> `pending_ci` (gjenbruker den EKSISTERENDE
   *         zero-review-automerge-sveipen UENDRET - ingen egen kodevei).
   *       - `requires_approval` -> `awaiting_approval`, eieren varsles.
   */
  async sweepPendingJobs(): Promise<{ advanced: string[]; still_pending: string[]; failed: string[] }> {
    const rows = await this.deps.pool.query(
      "SELECT * FROM self_modification_requests WHERE status = 'pending_job' ORDER BY created_at"
    );
    const advanced: string[] = [];
    const stillPending: string[] = [];
    const failed: string[] = [];
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const request = requestRowFromDb(row);
      try {
        const outcome = await this.attemptAdvanceJob(request);
        if (outcome === "advanced") advanced.push(request.request_id);
        else if (outcome === "failed") failed.push(request.request_id);
        else stillPending.push(request.request_id);
      } catch {
        // Samme per-rad-isolasjon som sweepPendingRequests()/TelegramCommandPoller.
        stillPending.push(request.request_id);
      }
    }
    return { advanced, still_pending: stillPending, failed };
  }

  private async attemptAdvanceJob(request: SelfModificationRequest): Promise<"advanced" | "pending" | "failed"> {
    if (!request.coding_task_id || !request.coding_tenant_id) {
      // Strukturelt uråkbart (kun proposeCodeChange() setter status pending_job,
      // og setter alltid begge feltene sammen) - fail-closed likevel.
      await this.markResolved(request.request_id, "rejected", null);
      return "failed";
    }
    const jobIdentity: IdentityContext = {
      person_id: this.deps.ownerPersonId, tenant_id: request.coding_tenant_id, memory_space_id: "personal",
      session_id: `sess-self-mod-sweep-${randomUUID().slice(0, 8)}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
    };
    const task = await this.deps.taskService.get(jobIdentity, request.coding_task_id);
    if (!task.ok) return "pending"; // f.eks. et forbigående policy-avslag - prøves igjen neste sveip
    const view = task.value;
    if (view.status === "created" || view.status === "running" || view.status === "paused") return "pending";
    if (view.status === "cancelled" || view.status === "failed") {
      await this.markResolved(request.request_id, "rejected", null);
      await safeNotify(this.deps.notify,
        `Selvendring avvist: kodejobb ${view.status === "failed" ? "feilet" : "ble kansellert"} (${request.request_id}).` +
        (view.last_error ? ` Årsak: ${view.last_error.slice(0, 300)}` : ""));
      return "failed";
    }

    // view.status === "completed"
    const result = view.result as { branch?: string; pr?: { status?: string; pr_number?: string; pr_url?: string } } | null;
    const pr = result?.pr;
    if (!pr || !pr.pr_number || (pr.status !== "created" && pr.status !== "found_existing" && pr.status !== "already_published")) {
      await this.markResolved(request.request_id, "rejected", null);
      await safeNotify(this.deps.notify,
        `Selvendring avvist: kodejobben fullførte uten å opprette en PR (${request.request_id}).`);
      return "failed";
    }

    const actualFiles = await this.deps.githubClient.getPullRequestChangedFiles(this.repoSlug, pr.pr_number);
    const risk = classifySelfModification(actualFiles);
    const branch = result?.branch ?? request.branch;
    if (risk === "forbidden") {
      await this.deps.pool.query(
        `UPDATE self_modification_requests
           SET target_paths = $2, branch = $3, pr_number = $4, pr_url = $5, risk = $6, status = 'rejected', resolved_at = now()
         WHERE request_id = $1`,
        [request.request_id, actualFiles, branch, pr.pr_number, pr.pr_url ?? "", risk]
      );
      await safeNotify(this.deps.notify,
        `Selvendring avvist: PR ${pr.pr_url ?? pr.pr_number} rører fil(er) selvendring ALDRI får lov til (${request.request_id}).`);
      return "failed";
    }

    const nextStatus: SelfModificationRequestStatus = risk === "zero_review" ? "pending_ci" : "awaiting_approval";
    await this.deps.pool.query(
      `UPDATE self_modification_requests
         SET target_paths = $2, branch = $3, pr_number = $4, pr_url = $5, risk = $6, status = $7
       WHERE request_id = $1`,
      [request.request_id, actualFiles, branch, pr.pr_number, pr.pr_url ?? "", risk, nextStatus]
    );
    if (nextStatus === "awaiting_approval") {
      await safeNotify(this.deps.notify,
        `Selvendring venter på godkjenning (${request.request_id}): ${pr.pr_url ?? pr.pr_number}\n` +
        `Endrer: ${actualFiles.join(", ")}\nGodkjenn: /godkjenn ${request.request_id}\nAvvis: /avvis ${request.request_id}`);
    }
    return "advanced";
  }

  /**
   * CI-portvakten. Kjøres periodisk (se apps/api/src/main.ts) ELLER on-demand.
   * For HVER åpen `pending_ci`-rad: CI-status FØRST (billig, ingen mutasjon
   * mulig fra en rød/ventende sjekk), DERETTER en FERSK reverifisering av
   * PR-ens FAKTISKE endrede filer direkte fra GitHub (ALDRI kun stolt på
   * `target_paths` fra opprettelsestidspunktet - en branch kunne i
   * prinsippet fått flere pushes siden), FØRST DERETTER selve merget.
   * Et avvik i NOEN av disse stegene lar raden forbli `pending_ci` (prøves
   * på nytt neste sveip) eller markeres `ci_failed` - ALDRI en stille merge.
   */
  async sweepPendingRequests(): Promise<{ merged: string[]; still_pending: string[]; failed: string[] }> {
    const rows = await this.deps.pool.query(
      "SELECT * FROM self_modification_requests WHERE status = 'pending_ci' AND risk = 'zero_review' ORDER BY created_at"
    );
    const merged: string[] = [];
    const stillPending: string[] = [];
    const failed: string[] = [];
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const request = requestRowFromDb(row);
      try {
        const outcome = await this.attemptMerge(request);
        if (outcome === "merged") merged.push(request.request_id);
        else if (outcome === "failed") failed.push(request.request_id);
        else stillPending.push(request.request_id);
      } catch {
        // Én rads feil stjeler ALDRI resten av sveipen (samme isolasjons-
        // disiplin som TelegramCommandPoller sin per-melding-try/catch).
        stillPending.push(request.request_id);
      }
    }
    return { merged, still_pending: stillPending, failed };
  }

  /**
   * DEN ENESTE merge-utførelsen i hele modulen - delt av BÅDE zero-review-
   * automergen (`sweepPendingRequests()`) OG godkjent-kodeendring-merget
   * (`sweepApprovedRequests()`, task #123). Risikosjekken sammenligner mot
   * `request.risk` (raden sin EGEN, allerede lagrede klassifisering) i
   * stedet for et hardkodet `"zero_review"` - dette generaliserer korrekt
   * for BEGGE spor: en `zero_review`-rad krever fortsatt uendret
   * `zero_review`, en owner-godkjent `requires_approval`-rad krever fortsatt
   * uendret `requires_approval` - OG en diff som (uansett årsak) nå
   * klassifiserer som `forbidden` blokkeres ALLTID uansett hvilket spor
   * raden kom fra, siden `forbidden !== request.risk` for begge.
   */
  private async attemptMerge(request: SelfModificationRequest): Promise<"merged" | "pending" | "failed"> {
    const ci = await this.deps.githubClient.getCombinedCiStatus(this.repoSlug, request.branch);
    if (ci === "pending") return "pending";
    if (ci === "failure") {
      await this.markResolved(request.request_id, "ci_failed", null);
      return "failed";
    }

    // Reverifisering: EKSAKT `target_paths` (aldri mer, aldri mindre) - se
    // klassekommentaren. En diff som har vokst siden opprettelsen (uansett
    // årsak) blokkerer automerge her, permanent for DENNE forespørselen -
    // ALDRI et stille "merge likevel fordi CI tilfeldigvis er grønt".
    const actualFiles = await this.deps.githubClient.getPullRequestChangedFiles(this.repoSlug, request.pr_number);
    const expected = [...request.target_paths].sort();
    const actual = [...actualFiles].sort();
    const diffMatches = expected.length === actual.length && expected.every((p, i) => p === actual[i]);
    if (!diffMatches || classifySelfModification(actualFiles) !== request.risk) {
      await this.markResolved(request.request_id, "ci_failed", null);
      await safeNotify(this.deps.notify,
        `Selvendring blokkert FØR merge: diffen har endret seg siden godkjenning/klassifisering (${request.request_id}).`);
      return "failed";
    }

    const headSha = await this.deps.githubClient.getPullRequestHeadSha(this.repoSlug, request.pr_number);
    const result = await this.deps.githubClient.mergePullRequest(this.repoSlug, request.pr_number, {
      sha: headSha,
      commitTitle: `jarvis: ${request.summary}`
    });
    if (!result.merged) return "pending"; // f.eks. 405/stale sha - prøves på nytt neste sveip
    await this.markResolved(request.request_id, "merged", null);
    await safeNotify(this.deps.notify, `Selvendring merget: ${request.pr_url || request.pr_number} (${request.request_id}).`);
    return "merged";
  }

  /**
   * Task #123 (D-214): den siste koblingen `resolveApproval()` sin egen
   * doc-kommentar eksplisitt utsatte - en `requires_approval`-rad
   * `/godkjenn`-godkjent av eieren har ENDA IKKE blitt merget noe sted.
   * Gjenbruker DEN SAMME `attemptMerge()` (CI-grønt FØRST, FERSK
   * diff-reverifisering DERETTER, SAMME smale `githubClient` - ALDRI
   * `github.merge_pr`) som zero-review-sporet - KUN spørringen som velger
   * HVILKE rader som er kandidater er forskjellig (`status='approved'`,
   * uansett `risk`, i stedet for `status='pending_ci' AND risk='zero_review'`).
   */
  async sweepApprovedRequests(): Promise<{ merged: string[]; still_pending: string[]; failed: string[] }> {
    const rows = await this.deps.pool.query(
      "SELECT * FROM self_modification_requests WHERE status = 'approved' ORDER BY created_at"
    );
    const merged: string[] = [];
    const stillPending: string[] = [];
    const failed: string[] = [];
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const request = requestRowFromDb(row);
      try {
        const outcome = await this.attemptMerge(request);
        if (outcome === "merged") merged.push(request.request_id);
        else if (outcome === "failed") failed.push(request.request_id);
        else stillPending.push(request.request_id);
      } catch {
        stillPending.push(request.request_id);
      }
    }
    return { merged, still_pending: stillPending, failed };
  }

  private async markResolved(requestId: string, status: SelfModificationRequestStatus, resolvedBy: string | null): Promise<void> {
    await this.deps.pool.query(
      "UPDATE self_modification_requests SET status = $2, resolved_at = now(), resolved_by_person_id = $3 WHERE request_id = $1",
      [requestId, status, resolvedBy]
    );
  }

  /**
   * Task #121 (D-214), requires_approval-sporet: den GENERISKE Telegram-
   * godkjennings-tilstandsmaskinen - uavhengig av HVA slags endring
   * forespørselen representerer (`kind`). Kalt fra
   * `TelegramCommandPoller`'s nye `/approve`/`/avvis`-håndtering
   * (apps/api/src/main.ts), ALLEREDE autentisert via den eksisterende,
   * betrodde eier-chat-bindingen FØR denne metoden i det hele tatt nås -
   * `actorPersonId` her er derfor den KONFIGURERTE eier-identiteten
   * (JARVIS_OWNER_PERSON_ID), ALDRI noe fra selve Telegram-meldingsteksten.
   *
   * BEVISST IKKE her: selve ANVENDELSEN (merget) av en godkjent rad - denne
   * metoden garanterer KUN at tilstandsoverganger pending->approved/rejected
   * er ekte, auditerte og eier-bundet. Task #123 (D-214) koblet til den
   * siste delen: `sweepApprovedRequests()` sveiper periodisk etter
   * `status='approved'`-rader (uansett `kind`) og merger via DEN SAMME
   * `attemptMerge()` zero-review-sporet bruker - denne metoden er derfor
   * UENDRET av den koblingen, akkurat som forventet ved skrivetidspunktet.
   */
  async resolveApproval(requestId: string, decision: "approved" | "rejected", actorPersonId: string): Promise<SelfModificationRequest> {
    const existing = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("self_modification_request_not_found");
    const request = requestRowFromDb(row);
    if (request.status !== "awaiting_approval") {
      throw new Error(`self_modification_request_not_awaiting_approval:${request.status}`);
    }
    await this.markResolved(requestId, decision, actorPersonId);
    const updated = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    return requestRowFromDb(updated.rows[0] as Record<string, unknown>);
  }

  async getRequest(requestId: string): Promise<SelfModificationRequest | null> {
    const result = await this.deps.pool.query("SELECT * FROM self_modification_requests WHERE request_id = $1", [requestId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? requestRowFromDb(row) : null;
  }
}
