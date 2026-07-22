// Phase 2 item 3: the run lifecycle — beginning a run, building the sandbox
// env contract, launching an already-provisioned sandbox, completing a run
// callback, and expiring a stale run. Split out of server.ts, which keeps
// only the HTTP surface and re-exports `completeRun`/`expireRun` for
// index.ts/sweep.ts.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Agent, Run, TaskType, Ticket, TicketStore } from "./db.js";
import type { LinearClient } from "./linear.js";
import {
  commentOnPullRequest,
  isGithubPullRequestUrl,
  parsePullRequestUrl,
} from "./github.js";
import { setSandboxActive, setSandboxIdle, startTask, type SandboxEnvContract } from "./daytona.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import type { PipelineStore } from "./pipeline-store.js";
import { processPipelineInfrastructureFailure } from "./pipeline-control.js";
import { getCodexAuthForSeed } from "./codex-auth.js";
import { reconcileSandboxAutostop } from "./sandbox-lifecycle.js";
import { MAX_PRIVATE_LOG_TAIL_CHARS } from "./logs.js";
import { sanitizeText } from "./sanitize.js";
import {
  createLinearOutboxProcessor,
  enqueueActivity,
  enqueueSessionUpdate,
  tryPostError,
  type LinearOutboxProcessor,
} from "./linear-outbox.js";
import { drainNextSessionWork, sessionExecutionMode, shouldNudgeAfterRun, type LaunchExistingTask } from "./scheduler.js";

export interface RunCredentials {
  id: string;
  token: string;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashesMatch(left: string, right: string): boolean {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function settleSandboxAfterRun(params: {
  daytona: Daytona;
  store: TicketStore;
  ticket: Ticket;
  taskType: TaskType;
}): Promise<void> {
  const { daytona, store, ticket, taskType } = params;
  if (!ticket.sandbox_id) return;

  try {
    await reconcileSandboxAutostop({
      runtime: {
        setActive: (id) => setSandboxActive(daytona, id),
        setIdle: (id) => setSandboxIdle(daytona, id),
      },
      store,
      issueId: ticket.linear_issue_id,
      providerResourceId: ticket.sandbox_id,
    });
  } catch (error) {
    console.error(
      `[daytona] ${taskType} completed but sandbox ${ticket.sandbox_id} could not be reconciled:`,
      error
    );
  }
}

export function scheduleSandboxSettlement(
  params: Parameters<typeof settleSandboxAfterRun>[0],
  schedule?: (task: Promise<void>) => void
): void {
  const task = settleSandboxAfterRun(params);
  if (schedule) schedule(task);
  else void task.catch((error) => console.error("[daytona] sandbox settlement failed:", error));
}

export function pickAgent(labels: string[], defaultAgent: Agent): Agent {
  if (labels.includes("agent:opencode")) return "opencode";
  if (labels.includes("agent:codex")) return "codex";
  if (labels.includes("agent:claude")) return "claude";
  return defaultAgent;
}

export function hasAgentSubscription(cfg: Config, agent: Agent): boolean {
  switch (agent) {
    case "codex":
      return Boolean(cfg.codexAuthJson);
    case "claude":
      return Boolean(cfg.claudeCodeOauthToken);
    case "opencode":
      return Boolean(cfg.kimiCodeApiKey);
  }
}

export function agentDisplayName(agent: Agent): string {
  switch (agent) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
  }
}

type TerminalActivityType = "elicitation" | "response" | "error";

export type ExecutionOutcome = "success" | "infrastructure_failure" | "failure";

// A process killed by a signal exits with 128 + signal number. These codes are
// runtime/infrastructure terminations (137 = 128+SIGKILL, the OOM/resource kill;
// 143 = SIGTERM; 139 = SIGSEGV; 134 = SIGABRT; 135 = SIGBUS), never a semantic
// outcome the agent chose. They must classify as an infrastructure failure and
// can never be read as a pass or a known-gap success.
const RESOURCE_TERMINATION_EXIT_CODES = new Set([134, 135, 137, 139, 143]);

// The wrapper/process exit code is the authoritative execution signal (audit
// E4 + the E3 exit-zero-conflates-success hazard). A nonzero exit is ALWAYS a
// failure and can never be converted to success by a later completion marker,
// a prior success-shaped terminal response, or a cleanup path. Exit zero is the
// only value eligible for success, and only because the completion callback
// that carries it is required — a callback without a valid integer exit code is
// rejected before this runs, so "exit zero alone" cannot be manufactured.
export function classifyExecutionOutcome(exitCode: number): ExecutionOutcome {
  if (exitCode === 0) return "success";
  if (RESOURCE_TERMINATION_EXIT_CODES.has(exitCode)) return "infrastructure_failure";
  return "failure";
}

export function lastTerminalSandboxActivity(
  store: TicketStore,
  runId: string
): TerminalActivityType | undefined {
  const event = store.getLastProcessedSandboxActivity(runId);
  if (!event) return undefined;
  try {
    const payload = JSON.parse(event.payload) as { type?: string };
    const type = payload.type ?? "";
    return ["elicitation", "response", "error"].includes(type)
      ? (type as TerminalActivityType)
      : undefined;
  } catch {
    return undefined;
  }
}

export function beginRun(
  store: TicketStore,
  cfg: Config,
  issueId: string,
  taskType: TaskType
): RunCredentials | undefined {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + (cfg.taskTimeout + cfg.callbackGraceSeconds) * 1000
  ).toISOString();
  const claimed = store.beginRun({
    issueId,
    runId: id,
    taskType,
    tokenHash: tokenHash(token),
    expiresAt,
  });
  return claimed ? { id, token } : undefined;
}

export function baseSandboxEnv(
  cfg: Config,
  params: {
    ticket: Pick<
      Ticket,
      | "agent"
      | "repo"
      | "branch"
      | "linear_issue_id"
      | "linear_issue_identifier"
      | "base_branch"
    >;
    taskType: TaskType;
    run: RunCredentials;
    resumeMessage?: string;
    codexAuthJson?: string;
  }
): SandboxEnvContract {
  return {
    TASK_TYPE: params.taskType,
    AGENT: params.ticket.agent,
    GITHUB_REPO: params.ticket.repo,
    GITHUB_TOKEN: cfg.githubToken,
    BASE_BRANCH: params.ticket.base_branch,
    BRANCH_NAME: params.ticket.branch,
    LINEAR_ISSUE_ID: params.ticket.linear_issue_id,
    LINEAR_ISSUE_IDENTIFIER: params.ticket.linear_issue_identifier,
    RUN_ID: params.run.id,
    RUN_CALLBACK_TOKEN: params.run.token,
    RESUME_MESSAGE: params.resumeMessage,
    CLAUDE_CODE_OAUTH_TOKEN:
      params.ticket.agent === "claude" ? cfg.claudeCodeOauthToken : undefined,
    CODEX_AUTH_JSON: params.ticket.agent === "codex" ? params.codexAuthJson : undefined,
    KIMI_CODE_API_KEY: params.ticket.agent === "opencode" ? cfg.kimiCodeApiKey : undefined,
    OT_GIT_AUTHOR_NAME: cfg.gitAuthorName,
    OT_GIT_AUTHOR_EMAIL: cfg.gitAuthorEmail,
    MAX_TURNS: String(cfg.maxTurns),
    TASK_TIMEOUT: String(cfg.taskTimeout),
    DEV_PORT: String(cfg.devPort),
  };
}

// Re-assert the agent-owned session external URLs (workspace preview + PR) so
// they stay visible and valid in whatever run the user is looking at — not
// only the one that first created the workspace. A full `externalUrls` replace
// keeps exactly one of each (no duplicates piling up) and mints a fresh preview
// token so the link never points at a rotated/expired one. Returns the preview
// URL so the caller can echo it into the run's "Started" activity. Never
// throws — a link refresh must not fail a run launch.
export async function syncSessionExternalUrls(params: {
  cfg: Config;
  store: TicketStore;
  outbox: LinearOutboxProcessor;
  ticket: Ticket;
}): Promise<string> {
  const { cfg, store, outbox, ticket } = params;
  const previewToken = randomBytes(24).toString("base64url");
  store.setPreviewTokenHash(ticket.linear_issue_id, tokenHash(previewToken));
  const previewUrl = `${cfg.supervisorUrl}/preview/${encodeURIComponent(
    ticket.linear_issue_identifier
  )}?token=${encodeURIComponent(previewToken)}`;
  const externalUrls = [{ label: "Workspace Preview", url: previewUrl }];
  if (ticket.pr_url) externalUrls.push({ label: "Pull Request", url: ticket.pr_url });
  try {
    await enqueueSessionUpdate(store, outbox, {
      sessionId: ticket.linear_session_id,
      issueId: ticket.linear_issue_id,
      externalUrls,
    });
  } catch (error) {
    console.error("[linear] failed to sync session external URLs:", error);
  }
  return previewUrl;
}

export async function launchExistingTask(params: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  taskType: TaskType;
  resumeMessage?: string;
  linearContext?: string;
}): Promise<boolean> {
  const { cfg, store, daytona, ticket } = params;
  if (sessionExecutionMode(store, ticket.linear_session_id) === "pipeline") {
    console.warn(`[run-lifecycle] refusing legacy launch for pipeline-pinned session ${ticket.linear_session_id}`);
    return false;
  }
  if (!ticket.sandbox_id) return false;
  if (!hasAgentSubscription(cfg, ticket.agent)) {
    await tryPostError(
      store,
      params.linearOutbox,
      ticket.linear_session_id,
      ticket.linear_issue_id,
      `${agentDisplayName(ticket.agent)} subscription login is not configured for OpenThrottle.`
    );
    return false;
  }
  const run = beginRun(store, cfg, ticket.linear_issue_id, params.taskType);
  if (!run) {
    await enqueueActivity(store, params.linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "thought",
      body: "Still working on the last message — reply again when this run finishes.",
    }, ticket.linear_issue_id);
    return false;
  }

  try {
    const sandbox = await daytona.get(ticket.sandbox_id);
    await startTask(sandbox, {
      env: baseSandboxEnv(cfg, {
        ticket,
        taskType: params.taskType,
        run,
        resumeMessage: params.resumeMessage,
        codexAuthJson:
          ticket.agent === "codex" ? await getCodexAuthForSeed(cfg, store) : undefined,
      }),
      linearContext:
        params.linearContext ??
        ticket.linear_context ??
        `# ${ticket.linear_issue_identifier}\n\nNo Linear prompt context was supplied.`,
      taskTimeoutSeconds: cfg.taskTimeout,
    });
  } catch (error) {
    const message = sanitizeText(`Failed to start ${params.taskType}: ${String(error)}`);
    store.finishRun({
      runId: run.id,
      status: "failed",
      failureTail: message,
      ticketState: "error",
    });
    scheduleSandboxSettlement({ daytona, store, ticket, taskType: params.taskType });
    await tryPostError(store, params.linearOutbox, ticket.linear_session_id, ticket.linear_issue_id, message);
    return false;
  }

  // Refresh the workspace-preview and PR links on the session, and echo the
  // preview into the "Started" activity, so the preview is surfaced on every
  // run (including resumes) rather than only when the workspace was created.
  const previewUrl = await syncSessionExternalUrls({
    cfg,
    store,
    outbox: params.linearOutbox,
    ticket,
  });
  try {
    await enqueueActivity(store, params.linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "Started",
      parameter: `${params.taskType} run on ${ticket.branch}`,
      result: `Wake-on-click preview: ${previewUrl}`,
    }, ticket.linear_issue_id, run.id);
  } catch (error) {
    console.error(`[linear] ${params.taskType} started but its activity could not be posted:`, error);
  }
  return true;
}

const MISSING_AGENT_SESSION_PATTERN = /agent-session-id is (?:missing|empty)/i;

export async function completeRun(
  deps: {
    cfg: Config;
    store: TicketStore;
    daytona: Daytona;
    getLinearClient: () => Promise<LinearClient | undefined>;
    linearOutbox?: LinearOutboxProcessor;
    schedule?: (task: Promise<void>) => void;
  },
  input: {
    runId: string;
    token: string | undefined;
    exitCode: unknown;
    costUsd?: unknown;
    prUrl?: unknown;
    failureTail?: unknown;
    finalResponse?: unknown;
    logTail?: unknown;
  }
): Promise<{ status: number; body: { ok?: true; error?: string } }> {
  const run = deps.store.getRun(input.runId);
  if (!run) return { status: 404, body: { error: "run not found" } };
  if (!input.token || !hashesMatch(run.token_hash, tokenHash(input.token))) {
    return { status: 401, body: { error: "invalid callback token" } };
  }
  if (run.status !== "running") {
    return { status: 409, body: { error: "callback token already used" } };
  }
  if (!Number.isInteger(input.exitCode)) {
    return { status: 400, body: { error: "exit_code must be an integer" } };
  }

  const exitCode = input.exitCode as number;
  // Precedence is fixed here and reused for every downstream decision so a
  // nonzero exit cannot later be re-read as success: `succeeded` is true only
  // for a clean exit-zero completion.
  const outcome = classifyExecutionOutcome(exitCode);
  const succeeded = outcome === "success";
  const costUsd =
    typeof input.costUsd === "number" &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0
      ? input.costUsd
      : undefined;
  const failureTail =
    typeof input.failureTail === "string"
      ? sanitizeText(input.failureTail).slice(-4_000)
      : undefined;
  const logTail =
    typeof input.logTail === "string"
      ? sanitizeText(input.logTail).slice(-MAX_PRIVATE_LOG_TAIL_CHARS)
      : undefined;
  const prUrl =
    isGithubPullRequestUrl(input.prUrl) ? input.prUrl : undefined;
  const finalResponse =
    typeof input.finalResponse === "string" && input.finalResponse.trim()
      ? sanitizeText(input.finalResponse).slice(0, 8_000)
      : undefined;
  const ticket = deps.store.getByIssueId(run.linear_issue_id);
  const outbox =
    deps.linearOutbox ??
    createLinearOutboxProcessor({ store: deps.store, getLinearClient: deps.getLinearClient });
  const consumedWork = deps.store.getConsumedSessionWorkForRun(run.id);
  const completed = deps.store.finishRun({
    runId: input.runId,
    status: succeeded ? "completed" : "failed",
    exitCode,
    costUsd,
    prUrl,
    failureTail,
    logTail,
    ticketState: succeeded ? "active" : "error",
  });
  if (!completed || !ticket) {
    return { status: 409, body: { error: "run no longer active" } };
  }

  scheduleSandboxSettlement(
    {
      daytona: deps.daytona,
      store: deps.store,
      ticket,
      taskType: run.task_type,
    },
    deps.schedule
  );
  const terminalActivity = lastTerminalSandboxActivity(deps.store, run.id);
  const pausedOnDecisions = succeeded && terminalActivity === "elicitation";
  const sessionId = run.linear_session_id ?? ticket.linear_session_id;
  try {
    const costLine = costUsd === undefined ? "" : ` Cost: $${costUsd.toFixed(4)}.`;
    if (succeeded) {
      // Synthesize a success response only when the agent has not already
      // concluded the session itself (any terminal activity), so we do not
      // double-post over the agent's own response/error/elicitation.
      if (terminalActivity === undefined) {
        await enqueueActivity(deps.store, outbox, {
          sessionId,
          type: "response",
          body: finalResponse ?? `OpenThrottle ${run.task_type} run finished successfully.${prUrl ? ` PR: ${prUrl}` : ""}${costLine}`,
        }, ticket.linear_issue_id, run.id);
      }
    } else if (terminalActivity !== "error") {
      // A nonzero exit is a failure regardless of any success-shaped terminal
      // response the agent posted (audit E4). Suppress the synthetic failure
      // notice ONLY when an error activity already represents this same failure
      // (don't double-report); a prior `response`/`elicitation` must never hide
      // it. `succeeded` is false for the resource-termination class too, so
      // exit 137 is reported as an infrastructure failure, never a pass.
      const infraLine =
        outcome === "infrastructure_failure"
          ? " The run was terminated by the infrastructure (resource limit or signal), not by the agent."
          : "";
      await enqueueActivity(deps.store, outbox, {
        sessionId,
        type: "error",
        body: `OpenThrottle ${run.task_type} run failed (exit ${exitCode}).${infraLine}${costLine}${failureTail ? `\n\nLast output:\n\`\`\`\n${failureTail}\n\`\`\`` : ""}`,
      }, ticket.linear_issue_id, run.id);
    }
    if (prUrl) {
      await enqueueSessionUpdate(deps.store, outbox, {
        sessionId,
        issueId: ticket.linear_issue_id,
        addedExternalUrls: [{ label: "Pull Request", url: prUrl }],
      });
    }
  } catch (error) {
    console.error(`[linear] ${run.task_type} completed but its notification could not be enqueued:`, error);
  }

  // Missing-session resume failure (Phase 1 item 4 / design decision 7): a
  // `resume` requires the saved native session, which can be lost when a
  // sandbox is recreated. Surface a dedicated error rather than silently
  // starting a fresh context — re-delegation is the recovery path.
  if (!succeeded && run.task_type === "resume" && failureTail && MISSING_AGENT_SESSION_PATTERN.test(failureTail)) {
    await tryPostError(
      deps.store,
      outbox,
      sessionId,
      ticket.linear_issue_id,
      "The workspace was recreated and the previous agent session is gone — re-delegate the issue to continue."
    );
  }

  if (pausedOnDecisions) {
    // The agent is waiting on a human decision. Leave queued session work
    // pending so nothing resumes the session before the answer arrives; the
    // answer launches directly and the queue drains after that run.
    return { status: 200, body: { ok: true } };
  }

  if (succeeded) {
    if (
      shouldNudgeAfterRun({
        exitCode,
        pausedOnElicitation: pausedOnDecisions,
        consumedAutomaticWork: consumedWork?.source === "automatic",
        hasPrUrl: Boolean(prUrl ?? ticket.pr_url),
        nudgeComment: deps.cfg.reviewNudgeComment,
      })
    ) {
      const nudgeTask = postReviewNudge(deps.cfg, ticket, prUrl ?? ticket.pr_url ?? undefined);
      if (deps.schedule) deps.schedule(nudgeTask);
      else await nudgeTask;
    }

    const linear = await deps.getLinearClient();
    if (linear) {
      const task = drainNextSessionWork({
        cfg: deps.cfg,
        store: deps.store,
        daytona: deps.daytona,
        linear,
        linearOutbox: outbox,
        ticket,
        launch: launchExistingTask,
      }).then(() => undefined);
      if (deps.schedule) deps.schedule(task);
      else await task;
    }
  }
  return { status: 200, body: { ok: true } };
}

async function postReviewNudge(cfg: Config, ticket: Ticket, prUrl: string | undefined): Promise<void> {
  if (!prUrl) return;
  try {
    const pull = parsePullRequestUrl(prUrl);
    await commentOnPullRequest({ token: cfg.githubToken }, ticket.repo, pull.number, cfg.reviewNudgeComment);
  } catch (error) {
    console.error(`[run-lifecycle] failed to post the review nudge for ${ticket.linear_issue_identifier}:`, error);
  }
}

// Recovery net for the drain-after-run path. `completeRun` is normally the ONLY
// thing that drains queued feedback work for a ticket, and it can skip that
// drain — deliberately (the run paused on an elicitation) or accidentally (the
// Linear client was momentarily unavailable, or the launch failed and released
// the item). Nothing else re-triggers a drain until the next webhook, so a
// single missed drain can strand PR feedback indefinitely. The lifecycle sweep
// calls this to re-drain any idle, active ticket that still has claimable
// pending work — except tickets whose last run parked on an unanswered human
// decision, which must keep waiting for the human reply exactly as
// `completeRun` intends. `claimNextSessionWork` and `beginRun` are both atomic
// compare-and-sets, so racing a concurrent completeRun drain cannot double-launch.
export async function redrainStalledSessionWork(deps: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient | undefined;
  linearOutbox: LinearOutboxProcessor;
  launch?: LaunchExistingTask;
}): Promise<void> {
  const { cfg, store, daytona, linear, linearOutbox } = deps;
  if (!linear) return; // no Linear client this cycle — retry on the next sweep
  const launch = deps.launch ?? launchExistingTask;
  const nowIso = new Date().toISOString();
  for (const ticket of store.listTicketsWithPendingSessionWork(nowIso)) {
    // Mirror completeRun's `pausedOnDecisions`: a run that ended on an
    // elicitation is waiting for a human answer, so its queued work must stay
    // pending until that answer arrives — never re-drained here.
    const latestRun = store.getLatestRun(ticket.linear_issue_id);
    if (latestRun && lastTerminalSandboxActivity(store, latestRun.id) === "elicitation") {
      continue;
    }
    try {
      await drainNextSessionWork({ cfg, store, daytona, linear, linearOutbox, ticket, launch });
    } catch (error) {
      console.error(
        `[sweep] failed to re-drain stalled session work for ${ticket.linear_issue_identifier}:`,
        error
      );
    }
  }
}

export async function expireRun(
  daytona: Daytona,
  store: TicketStore,
  linearOutbox: LinearOutboxProcessor,
  run: Run,
  pipelines?: PipelineStore
): Promise<void> {
  const ticket = store.getByIssueId(run.linear_issue_id);
  const message = `OpenThrottle ${run.task_type} run timed out without a completion result.`;
  if (!ticket) return;
  const pipelineAttempt = pipelines?.getAttemptForRun(run.id);
  const pipeline = pipelineAttempt
    ? pipelines?.getInstance(pipelineAttempt.pipeline_instance_id)
    : undefined;
  const owner = `hard-timeout-${randomUUID()}`;
  const settlement = await terminateAndSettleActor({
    daytona,
    store,
    runId: run.id,
    sandboxId: ticket.sandbox_id,
    owner,
    reason: message,
    status: "timed_out",
    ticketState: "error",
    onSettled: pipelines && pipeline
      ? () => processPipelineInfrastructureFailure({ store: pipelines, runId: run.id })
      : undefined,
  });
  if (settlement.kind === "quarantined") {
    if (pipeline && pipelines?.getRuntimeResource(pipeline.id)) {
      pipelines.setRuntimeResourceStatus(pipeline.id, "quarantined");
    }
    await tryPostError(
      store,
      linearOutbox,
      run.linear_session_id ?? ticket.linear_session_id,
      ticket.linear_issue_id,
      settlement.message
    );
    return;
  }
  if (settlement.kind === "settled") {
    await tryPostError(
      store,
      linearOutbox,
      run.linear_session_id ?? ticket.linear_session_id,
      ticket.linear_issue_id,
      message
    );
  }
}
