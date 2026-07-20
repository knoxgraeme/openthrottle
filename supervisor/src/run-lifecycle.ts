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
import { startTask, type SandboxEnvContract } from "./daytona.js";
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
import { drainNextSessionWork, shouldNudgeAfterRun } from "./scheduler.js";

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
      daytona,
      store,
      issueId: ticket.linear_issue_id,
      sandboxId: ticket.sandbox_id,
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

function lastTerminalSandboxActivity(
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

  try {
    await enqueueActivity(store, params.linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "Started",
      parameter: `${params.taskType} run on ${ticket.branch}`,
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
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    costUsd,
    prUrl,
    failureTail,
    logTail,
    ticketState: exitCode === 0 ? "active" : "error",
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
  const pausedOnDecisions = exitCode === 0 && terminalActivity === "elicitation";
  const sessionId = run.linear_session_id ?? ticket.linear_session_id;
  try {
    const costLine = costUsd === undefined ? "" : ` Cost: $${costUsd.toFixed(4)}.`;
    const agentAlreadyConcluded = terminalActivity !== undefined;
    if (exitCode === 0 && !agentAlreadyConcluded) {
      await enqueueActivity(deps.store, outbox, {
        sessionId,
        type: "response",
        body: finalResponse ?? `OpenThrottle ${run.task_type} run finished successfully.${prUrl ? ` PR: ${prUrl}` : ""}${costLine}`,
      }, ticket.linear_issue_id, run.id);
    } else if (exitCode !== 0 && !agentAlreadyConcluded) {
      await enqueueActivity(deps.store, outbox, {
        sessionId,
        type: "error",
        body: `OpenThrottle ${run.task_type} run failed (exit ${exitCode}).${costLine}${failureTail ? `\n\nLast output:\n\`\`\`\n${failureTail}\n\`\`\`` : ""}`,
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
  if (exitCode !== 0 && run.task_type === "resume" && failureTail && MISSING_AGENT_SESSION_PATTERN.test(failureTail)) {
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

  if (exitCode === 0) {
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

export async function expireRun(
  daytona: Daytona,
  store: TicketStore,
  linearOutbox: LinearOutboxProcessor,
  run: Run
): Promise<void> {
  const ticket = store.getByIssueId(run.linear_issue_id);
  const message = `OpenThrottle ${run.task_type} run timed out without a completion result.`;
  store.finishRun({
    runId: run.id,
    status: "timed_out",
    failureTail: message,
    ticketState: "error",
  });
  if (ticket) {
    scheduleSandboxSettlement({ daytona, store, ticket, taskType: run.task_type });
    await tryPostError(
      store,
      linearOutbox,
      run.linear_session_id ?? ticket.linear_session_id,
      ticket.linear_issue_id,
      message
    );
  }
}
