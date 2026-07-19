import { Hono } from "hono";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Agent, Run, TaskType, Ticket, TicketStore, WebhookDelivery } from "./db.js";
import {
  agentActivityCreate,
  agentSessionUpdate,
  buildLinearInstallUrl,
  exchangeLinearOAuthCode,
  extractLabelNames,
  isRecentLinearWebhook,
  parseLinearWebhook,
  verifyLinearSignature,
  type LinearClient,
} from "./linear.js";
import {
  commentOnPullRequest,
  countChangesRequestedReviews,
  getMergeReadiness,
  isGithubPullRequestUrl,
  isOpenthrottleBranch,
  mergePullRequest,
  parseGithubWebhook,
  parsePullRequestUrl,
  prepareRepository,
  verifyGithubSignature,
  type GithubClient,
  type GithubWebhookEvent,
} from "./github.js";
import {
  createForTicket,
  findSandboxForTicket,
  getSandboxLogs,
  getSignedPreviewUrl,
  startTask,
  type SandboxEnvContract,
} from "./daytona.js";
import { reconcileSandboxAutostop } from "./sandbox-lifecycle.js";
import { MAX_PRIVATE_LOG_TAIL_CHARS } from "./logs.js";
import { sanitizeText } from "./sanitize.js";
import {
  createLinearClientProvider,
  createLinearOAuthStateStore,
  persistLinearToken,
} from "./linear-auth.js";
import { closeTicketForPullRequest, stopTicket } from "./ticket-control.js";
import {
  createWebhookDeliveryProcessor,
  type WebhookDeliveryProcessor,
} from "./webhook-delivery.js";

export interface ServerDeps {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  runBackground?: (task: Promise<void>) => void;
  getLinearClient?: () => Promise<LinearClient | undefined>;
  deliveryProcessor?: WebhookDeliveryProcessor;
}

interface RunCredentials {
  id: string;
  token: string;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function hasBearer(header: string | undefined, expected: string): boolean {
  const actual = bearerToken(header);
  if (!actual) return false;
  const actualHash = tokenHash(actual);
  const expectedHash = tokenHash(expected);
  return hashesMatch(actualHash, expectedHash);
}

async function settleSandboxAfterRun(params: {
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

function scheduleSandboxSettlement(
  params: Parameters<typeof settleSandboxAfterRun>[0],
  schedule?: (task: Promise<void>) => void
): void {
  const task = settleSandboxAfterRun(params);
  if (schedule) schedule(task);
  else void task.catch((error) => console.error("[daytona] sandbox settlement failed:", error));
}

function pickAgent(labels: string[], defaultAgent: Agent): Agent {
  if (labels.includes("agent:opencode")) return "opencode";
  if (labels.includes("agent:codex")) return "codex";
  if (labels.includes("agent:claude")) return "claude";
  return defaultAgent;
}

function hasAgentSubscription(cfg: Config, agent: Agent): boolean {
  switch (agent) {
    case "codex":
      return Boolean(cfg.codexAuthJson);
    case "claude":
      return Boolean(cfg.claudeCodeOauthToken);
    case "opencode":
      return Boolean(cfg.kimiCodeApiKey);
  }
}

function agentDisplayName(agent: Agent): string {
  switch (agent) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
  }
}

function linearContext(
  payload: ReturnType<typeof parseLinearWebhook>,
  fallback: string
): string {
  return payload.promptContext?.trim() || fallback;
}

function hasTerminalSandboxActivity(store: TicketStore, runId: string): boolean {
  const event = store.getLastProcessedSandboxActivity(runId);
  if (!event) return false;
  try {
    const payload = JSON.parse(event.payload) as { type?: string };
    return ["elicitation", "response", "error"].includes(payload.type ?? "");
  } catch {
    return false;
  }
}

function branchFor(issueIdentifier: string): string {
  return `ot/${issueIdentifier.toLowerCase()}`;
}

function repositoryFor(
  cfg: Config,
  store: TicketStore,
  issue: { team?: { id?: string; key?: string } }
): { repo: string; baseBranch: string } | undefined {
  const registered = store.getRepositoryRegistration(issue.team?.id, issue.team?.key);
  if (registered) {
    return { repo: registered.github_repo, baseBranch: registered.base_branch };
  }
  const byId = issue.team?.id ? cfg.githubRepoMappings[issue.team.id] : undefined;
  const byKey = issue.team?.key ? cfg.githubRepoMappings[issue.team.key] : undefined;
  const legacyMapped = byId ?? byKey;
  if (legacyMapped) return { repo: legacyMapped, baseBranch: cfg.baseBranch };
  if (store.hasRepositoryRegistrations()) return undefined;
  return { repo: cfg.githubRepo, baseBranch: cfg.baseBranch };
}

const LINEAR_TEAM_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function isGithubRepository(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every(
      (part) =>
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9_.-]+$/.test(part)
    )
  );
}

function isSafeBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@") return false;
  if (/^[./-]|[/.]$/.test(value)) return false;
  if (/\.\.|@\{|\/\/|[~^:?*\[\\\s]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function repositoryRegistrationInput(value: unknown): {
  repo: string;
  linearTeamKey: string;
  linearTeamId?: string;
  baseBranch?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.repo !== "string" || !isGithubRepository(input.repo)) {
    throw new Error("repo must be owner/name");
  }
  if (
    typeof input.linearTeamKey !== "string" ||
    !LINEAR_TEAM_KEY_PATTERN.test(input.linearTeamKey)
  ) {
    throw new Error("linearTeamKey is required");
  }
  if (
    input.linearTeamId !== undefined &&
    (typeof input.linearTeamId !== "string" || !input.linearTeamId.trim())
  ) {
    throw new Error("linearTeamId must be a non-empty string");
  }
  if (
    input.baseBranch !== undefined &&
    (typeof input.baseBranch !== "string" || !isSafeBranchName(input.baseBranch))
  ) {
    throw new Error("baseBranch is not a safe Git branch name");
  }
  return {
    repo: input.repo,
    linearTeamKey: input.linearTeamKey.toUpperCase(),
    linearTeamId: typeof input.linearTeamId === "string" ? input.linearTeamId.trim() : undefined,
    baseBranch: input.baseBranch || undefined,
  };
}

function findTicket(store: TicketStore, identifier: string): Ticket | undefined {
  return store.getByIssueId(identifier) ?? store.getByIdentifier(identifier);
}

function beginRun(
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

function baseSandboxEnv(
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
    pullNumber?: number;
    reviewRound?: number;
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
    PR_NUMBER: params.pullNumber === undefined ? undefined : String(params.pullNumber),
    REVIEW_ROUND: params.reviewRound === undefined ? undefined : String(params.reviewRound),
    CLAUDE_CODE_OAUTH_TOKEN:
      params.ticket.agent === "claude" ? cfg.claudeCodeOauthToken : undefined,
    CODEX_AUTH_JSON: params.ticket.agent === "codex" ? cfg.codexAuthJson : undefined,
    KIMI_CODE_API_KEY: params.ticket.agent === "opencode" ? cfg.kimiCodeApiKey : undefined,
    MAX_TURNS: String(cfg.maxTurns),
    TASK_TIMEOUT: String(cfg.taskTimeout),
    DEV_PORT: String(cfg.devPort),
  };
}

async function tryPostError(
  linear: LinearClient | undefined,
  sessionId: string | undefined,
  message: string
): Promise<void> {
  if (!linear || !sessionId) return;
  try {
    await agentActivityCreate(linear, {
      sessionId,
      type: "error",
      body: sanitizeText(message),
    });
  } catch (error) {
    console.error("[linear] failed to post error activity:", error);
  }
}

async function launchExistingTask(params: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  ticket: Ticket;
  taskType: TaskType;
  resumeMessage?: string;
  pullNumber?: number;
  reviewRound?: number;
  linearContext?: string;
}): Promise<boolean> {
  const { cfg, store, daytona, linear, ticket } = params;
  if (!ticket.sandbox_id) return false;
  if (!hasAgentSubscription(cfg, ticket.agent)) {
    await tryPostError(
      linear,
      ticket.linear_session_id,
      `${agentDisplayName(ticket.agent)} subscription login is not configured for OpenThrottle.`
    );
    return false;
  }
  const run = beginRun(store, cfg, ticket.linear_issue_id, params.taskType);
  if (!run) {
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "thought",
      body: "Still working on the last message — reply again when this run finishes.",
    });
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
        pullNumber: params.pullNumber,
        reviewRound: params.reviewRound,
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
    await tryPostError(linear, ticket.linear_session_id, message);
    return false;
  }

  try {
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "Started",
      parameter: `${params.taskType} run on ${ticket.branch}`,
    });
  } catch (error) {
    console.error(`[linear] ${params.taskType} started but its activity could not be posted:`, error);
  }
  return true;
}

export function createServerWebhookDeliveryProcessor(deps: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  getLinearClient: () => Promise<LinearClient | undefined>;
}): WebhookDeliveryProcessor {
  return createWebhookDeliveryProcessor({
    store: deps.store,
    maxAttempts: 8,
    baseDelayMs: 30_000,
    onDead: async (delivery, error) => {
      if (delivery.source !== "linear" || !delivery.session_id) return;
      const linear = await deps.getLinearClient();
      await tryPostError(
        linear,
        delivery.session_id,
        `OpenThrottle could not process this event after ${delivery.attempts} attempts: ${String(error)}`
      );
    },
    handler: async (delivery: WebhookDelivery) => {
      if (!delivery.payload) throw new Error(`Delivery ${delivery.id} has no stored payload`);
      if (delivery.source === "linear") {
        await handleLinearEvent(
          deps.cfg,
          deps.store,
          deps.daytona,
          deps.getLinearClient,
          parseLinearWebhook(delivery.payload)
        );
        return;
      }
      await handleGithubEvent(
        deps.cfg,
        deps.store,
        deps.daytona,
        deps.getLinearClient,
        parseGithubWebhook(delivery.event_name ?? undefined, delivery.payload)
      );
    },
  });
}

export async function completeRun(
  deps: {
    cfg: Config;
    store: TicketStore;
    daytona: Daytona;
    getLinearClient: () => Promise<LinearClient | undefined>;
    schedule?: (task: Promise<void>) => void;
  },
  input: {
    runId: string;
    token: string | undefined;
    exitCode: unknown;
    costUsd?: unknown;
    prUrl?: unknown;
    failureTail?: unknown;
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
  const ticket = deps.store.getByIssueId(run.linear_issue_id);
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
  const linear = await deps.getLinearClient();
  if (linear) {
    try {
      const costLine = costUsd === undefined ? "" : ` Cost: $${costUsd.toFixed(4)}.`;
      const agentAlreadyConcluded = hasTerminalSandboxActivity(deps.store, run.id);
      if (exitCode === 0 && !agentAlreadyConcluded) {
        await agentActivityCreate(linear, {
          sessionId: ticket.linear_session_id,
          type: "response",
          body: `OpenThrottle ${run.task_type} run finished successfully.${prUrl ? ` PR: ${prUrl}` : ""}${costLine}`,
        });
      } else if (exitCode !== 0 && !agentAlreadyConcluded) {
        await agentActivityCreate(linear, {
          sessionId: ticket.linear_session_id,
          type: "error",
          body: `OpenThrottle ${run.task_type} run failed (exit ${exitCode}).${costLine}${failureTail ? `\n\nLast output:\n\`\`\`\n${failureTail}\n\`\`\`` : ""}`,
        });
      }
      if (prUrl) {
        await agentSessionUpdate(linear, {
          sessionId: ticket.linear_session_id,
          addedExternalUrls: [{ label: "Pull Request", url: prUrl }],
        });
      }
    } catch (error) {
      console.error(`[linear] ${run.task_type} completed but its notification could not be posted:`, error);
    }
  }

  if (run.task_type === "review-fix" && exitCode === 0 && prUrl) {
    const pull = parsePullRequestUrl(prUrl);
    const task = triggerReviewTask(
      deps.cfg,
      deps.store,
      deps.daytona,
      linear,
      ticket,
      pull.number,
      "review"
    );
    if (deps.schedule) deps.schedule(task);
    else await task;
  }
  return { status: 200, body: { ok: true } };
}

export function createServer(deps: ServerDeps): Hono {
  const { cfg, store, daytona } = deps;
  const getLinearClient = deps.getLinearClient ?? createLinearClientProvider(cfg, store);
  const deliveryProcessor =
    deps.deliveryProcessor ??
    createServerWebhookDeliveryProcessor({ cfg, store, daytona, getLinearClient });
  const oauthStates = createLinearOAuthStateStore(() => randomBytes(16).toString("hex"));
  const schedule =
    deps.runBackground ??
    ((task: Promise<void>) => {
      void task.catch((error) => console.error("[background] unhandled task error:", error));
    });
  const app = new Hono();

  const requireStatusAuth = (authorization: string | undefined) =>
    hasBearer(authorization, cfg.statusToken);

  app.get("/healthz", (context) => context.json({ ok: true }));

  app.get("/status", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({
      tickets: store.listAll().map((ticket) => ({
        linear_issue_identifier: ticket.linear_issue_identifier,
        branch: ticket.branch,
        repo: ticket.repo,
        base_branch: ticket.base_branch,
        agent: ticket.agent,
        state: ticket.state,
        pr_url: ticket.pr_url,
        sandbox_id: ticket.sandbox_id,
        running_since: ticket.running_since,
        total_cost_usd: ticket.total_cost_usd,
        last_error: ticket.last_error,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
      })),
    });
  });

  app.get("/repositories", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({ repositories: store.listRepositoryRegistrations() });
  });

  app.post("/repositories/register", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    let input: ReturnType<typeof repositoryRegistrationInput>;
    try {
      input = repositoryRegistrationInput(await context.req.json());
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
    try {
      const snapshot = await daytona.snapshot.get(cfg.daytonaSnapshot);
      if (String(snapshot.state).toLowerCase() !== "active") {
        throw new Error(
          `Daytona snapshot ${cfg.daytonaSnapshot} is not active (${String(snapshot.state)})`
        );
      }
      const github = await prepareRepository(
        { token: cfg.githubToken },
        {
          repo: input.repo,
          requestedBaseBranch: input.baseBranch,
          webhookUrl: `${cfg.supervisorUrl}/webhooks/github`,
          webhookSecret: cfg.githubWebhookSecret,
        }
      );
      const registration = store.registerRepository({
        linearTeamKey: input.linearTeamKey,
        linearTeamId: input.linearTeamId,
        githubRepo: github.repo,
        baseBranch: github.baseBranch,
        webhookId: github.webhookId,
        snapshot: cfg.daytonaSnapshot,
      });
      return context.json({
        registration,
        readiness: {
          github: "ready",
          webhook: github.webhookAction,
          snapshot: { name: snapshot.name, state: snapshot.state },
        },
      });
    } catch (error) {
      return context.json(
        { error: sanitizeText(`Repository setup failed: ${String(error)}`) },
        502
      );
    }
  });

  app.get("/oauth/install", (context) => {
    if (!hasBearer(context.req.header("Authorization"), cfg.installSecret)) {
      return context.text("unauthorized", 401);
    }
    const state = oauthStates.issue();
    return context.redirect(
      buildLinearInstallUrl({
        clientId: cfg.linearClientId,
        redirectUri: `${cfg.supervisorUrl}/oauth/callback`,
        state,
      }),
      302
    );
  });

  app.get("/oauth/callback", async (context) => {
    const code = context.req.query("code");
    const state = context.req.query("state");
    if (!code) return context.text("Missing code", 400);
    if (!oauthStates.consume(state)) {
      return context.text("Missing or expired state", 400);
    }
    try {
      const token = await exchangeLinearOAuthCode({
        clientId: cfg.linearClientId,
        clientSecret: cfg.linearClientSecret,
        redirectUri: `${cfg.supervisorUrl}/oauth/callback`,
        code,
      });
      persistLinearToken(store, token);
      return context.text("OpenThrottle Linear app installed successfully. You can close this tab.");
    } catch (error) {
      console.error("[oauth] Linear token exchange failed:", error);
      return context.text("OAuth exchange failed, check supervisor logs.", 500);
    }
  });

  app.post("/webhooks/linear", async (context) => {
    const rawBody = await context.req.text();
    if (!verifyLinearSignature(rawBody, context.req.header("Linear-Signature"), cfg.linearWebhookSecret)) {
      return context.text("invalid signature", 401);
    }
    let payload: ReturnType<typeof parseLinearWebhook>;
    try {
      payload = parseLinearWebhook(rawBody);
    } catch (error) {
      console.warn("[webhooks/linear] invalid payload:", error);
      return context.text("invalid payload", 400);
    }
    if (!isRecentLinearWebhook(payload.webhookTimestamp, cfg.webhookMaxAgeSeconds)) {
      return context.text("stale webhook", 401);
    }
    const deliveryId = context.req.header("Linear-Delivery") ?? payload.webhookId;
    if (
      !store.claimDelivery({
        deliveryId,
        source: "linear",
        sessionId: payload.agentSession.id,
        action: payload.action,
        activityId: payload.agentActivity?.id,
        eventName: payload.type,
        payload: rawBody,
      })
    ) {
      schedule(deliveryProcessor.process(deliveryId));
      return context.text("ok", 200);
    }
    schedule(deliveryProcessor.process(deliveryId));
    return context.text("ok", 200);
  });

  app.post("/webhooks/github", async (context) => {
    const rawBody = await context.req.text();
    if (!verifyGithubSignature(rawBody, context.req.header("X-Hub-Signature-256"), cfg.githubWebhookSecret)) {
      return context.text("invalid signature", 401);
    }
    const eventName = context.req.header("X-GitHub-Event");
    let event: GithubWebhookEvent;
    try {
      event = parseGithubWebhook(eventName, rawBody);
    } catch (error) {
      if (String(error).includes("Unsupported GitHub event")) return context.text("ignored", 200);
      return context.text("invalid payload", 400);
    }
    const deliveryId =
      context.req.header("X-GitHub-Delivery") ?? createHash("sha256").update(rawBody).digest("hex");
    if (
      !store.claimDelivery({
        deliveryId,
        source: "github",
        action: `${event.kind}:${event.action}`,
        eventName,
        payload: rawBody,
      })
    ) {
      schedule(deliveryProcessor.process(deliveryId));
      return context.text("ok", 200);
    }
    schedule(deliveryProcessor.process(deliveryId));
    return context.text("ok", 200);
  });

  app.post("/runs/:id/complete", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "invalid callback body" }, 400);
    }
    const data = body as Record<string, unknown>;
    const result = await completeRun(
      { cfg, store, daytona, getLinearClient, schedule },
      {
        runId: context.req.param("id"),
        token: bearerToken(context.req.header("Authorization")),
        exitCode: data.exit_code,
        costUsd: data.cost_usd,
        prUrl: data.pr_url,
        failureTail: data.failure_tail,
      }
    );
    return context.json(result.body, result.status as 200 | 400 | 401 | 404 | 409);
  });

  app.post("/tickets/:identifier/stop", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    const linear = await getLinearClient();
    try {
      await stopTicket({ store, daytona, linear, ticket, reason: "Stopped by operator." });
      return context.json({ ok: true });
    } catch (error) {
      const message = sanitizeText(`Failed to stop workspace: ${String(error)}`);
      await tryPostError(linear, ticket.linear_session_id, message);
      return context.json({ error: message }, 502);
    }
  });

  app.get("/tickets/:identifier/logs", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    if (ticket.sandbox_id) {
      try {
        const logs = await getSandboxLogs(daytona, ticket.sandbox_id);
        return context.text(sanitizeText(logs).slice(-MAX_PRIVATE_LOG_TAIL_CHARS));
      } catch (error) {
        console.warn(`[logs] live workspace unavailable for ${ticket.linear_issue_identifier}:`, error);
      }
    }
    const durableLogTail = store.getLatestRunWithLog(ticket.linear_issue_id)?.log_tail;
    if (durableLogTail) {
      return context.text(sanitizeText(durableLogTail).slice(-MAX_PRIVATE_LOG_TAIL_CHARS));
    }
    return context.json({ error: "logs not found" }, 404);
  });

  app.get("/preview/:identifier", async (context) => {
    const ticket = findTicket(store, context.req.param("identifier"));
    const token = context.req.query("token");
    if (!ticket?.sandbox_id || !ticket.preview_token_hash || !token) {
      return context.text("preview not found", 404);
    }
    if (!hashesMatch(ticket.preview_token_hash, tokenHash(token))) {
      return context.text("unauthorized", 401);
    }
    try {
      return context.redirect(
        await getSignedPreviewUrl(daytona, ticket.sandbox_id, cfg.devPort),
        302
      );
    } catch (error) {
      console.error("[preview] failed:", error);
      return context.text("preview unavailable", 502);
    }
  });

  return app;
}

async function handleLinearEvent(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  getLinearClient: () => Promise<LinearClient | undefined>,
  payload: ReturnType<typeof parseLinearWebhook>
): Promise<void> {
  const linear = await getLinearClient();
  if (!linear) {
    throw new Error("No valid Linear OAuth token is stored");
  }
  if (payload.action === "created") {
    await handleCreated(cfg, store, daytona, linear, payload);
  } else {
    await handlePrompted(cfg, store, daytona, linear, payload);
  }
}

async function handleCreated(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  payload: ReturnType<typeof parseLinearWebhook>
): Promise<void> {
  const issue = payload.agentSession.issue;
  const sessionId = payload.agentSession.id;
  if (!issue) {
    await tryPostError(linear, sessionId, "OpenThrottle could not find an issue on this agent session.");
    return;
  }
  await agentActivityCreate(linear, {
    sessionId,
    type: "thought",
    body: "Spinning up a workspace…",
    ephemeral: true,
  });

  const labels = extractLabelNames(payload);
  const existing = store.getByIssueId(issue.id);
  const selectedAgent = pickAgent(labels, existing?.agent ?? cfg.defaultAgent);
  if (!hasAgentSubscription(cfg, selectedAgent)) {
    await tryPostError(
      linear,
      sessionId,
      `${agentDisplayName(selectedAgent)} subscription login is not configured for OpenThrottle.`
    );
    return;
  }
  const initialContext = linearContext(
    payload,
    `# ${issue.identifier}\n\nNo Linear prompt context was supplied for this delegation.`
  );
  if (existing?.sandbox_id && existing.state !== "closed" && existing.state !== "expired") {
    const agentChanged = existing.agent !== selectedAgent;
    store.upsert({
      ...existing,
      linear_session_id: sessionId,
      agent: selectedAgent,
      state: "active",
    });
    store.setLinearContext(issue.id, initialContext);
    const current = store.getByIssueId(issue.id)!;
    await launchExistingTask({
      cfg,
      store,
      daytona,
      linear,
      ticket: current,
      taskType: labels.includes("investigate")
        ? "investigate"
        : agentChanged
          ? "implement"
          : "resume",
      resumeMessage: agentChanged
        ? undefined
        : "This ticket was re-delegated. Re-read it and continue from the existing branch.",
      linearContext: initialContext,
    });
    return;
  }

  const taskType: TaskType = labels.includes("investigate") ? "investigate" : "implement";
  const repository = repositoryFor(cfg, store, issue);
  if (!repository) {
    await tryPostError(
      linear,
      sessionId,
      `No repository is registered for Linear team ${issue.team?.key ?? issue.team?.id ?? "unknown"}. Run \`openthrottle init\` in the target repository first.`
    );
    return;
  }
  const ticketCore = {
    linear_issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
    linear_session_id: sessionId,
    sandbox_id: null,
    branch: branchFor(issue.identifier),
    agent: selectedAgent,
    repo: repository.repo,
    base_branch: repository.baseBranch,
    pr_url: null,
    state: "active" as const,
  };
  store.upsert(ticketCore);
  store.setLinearContext(issue.id, initialContext);
  const recovered = await findSandboxForTicket(daytona, issue.identifier);
  if (recovered) {
    store.setSandboxId(issue.id, recovered.id);
    const recoveredTicket = store.getByIssueId(issue.id)!;
    if (recoveredTicket.run_id) {
      await reportCreatedWorkspace(cfg, store, linear, recoveredTicket, recovered.id);
      return;
    }
    await launchExistingTask({
      cfg,
      store,
      daytona,
      linear,
      ticket: recoveredTicket,
      taskType,
      resumeMessage: "Recovered the existing workspace. Re-read the ticket and continue.",
      linearContext: initialContext,
    });
    return;
  }

  const staleRunId = store.getByIssueId(issue.id)?.run_id;
  if (staleRunId) {
    store.finishRun({
      runId: staleRunId,
      status: "failed",
      failureTail: "Provisioning was interrupted before a workspace was created; retrying.",
      ticketState: "error",
    });
  }
  const run = beginRun(store, cfg, issue.id, taskType);
  if (!run) {
    await agentActivityCreate(linear, {
      sessionId,
      type: "thought",
      body: "Still working on this ticket — no second workspace was created.",
    });
    return;
  }

  const ticket = store.getByIssueId(issue.id)!;
  const env = baseSandboxEnv(cfg, {
    ticket,
    taskType,
    run,
  });
  let sandbox;
  try {
    sandbox = await createForTicket(daytona, cfg, {
      issueIdentifier: issue.identifier,
      env,
    });
    store.setSandboxId(issue.id, sandbox.id);
  } catch (error) {
    const partiallyCreated = await findSandboxForTicket(daytona, issue.identifier).catch(
      () => undefined
    );
    if (partiallyCreated) {
      store.setSandboxId(issue.id, partiallyCreated.id);
      await reportCreatedWorkspace(
        cfg,
        store,
        linear,
        store.getByIssueId(issue.id)!,
        partiallyCreated.id
      );
      return;
    }
    const message = sanitizeText(`Failed to create a workspace: ${String(error)}`);
    store.finishRun({
      runId: run.id,
      status: "failed",
      failureTail: message,
      ticketState: "error",
    });
    throw error;
  }
  const provisionedTicket = store.getByIssueId(issue.id)!;

  try {
    await startTask(sandbox, {
      env,
      linearContext: initialContext,
      taskTimeoutSeconds: cfg.taskTimeout,
    });
  } catch (error) {
    const message = sanitizeText(`Failed to start ${taskType}: ${String(error)}`);
    store.finishRun({
      runId: run.id,
      status: "failed",
      failureTail: message,
      ticketState: "error",
    });
    scheduleSandboxSettlement({ daytona, store, ticket: provisionedTicket, taskType });
    await tryPostError(linear, sessionId, message);
    return;
  }

  await reportCreatedWorkspace(cfg, store, linear, provisionedTicket, sandbox.id);
  try {
    await agentActivityCreate(linear, {
      sessionId,
      type: "action",
      action: "Started",
      parameter: `${taskType} run on ${provisionedTicket.branch}`,
    });
  } catch (error) {
    console.error(`[linear] ${taskType} started but its activity could not be posted:`, error);
  }
}

async function reportCreatedWorkspace(
  cfg: Config,
  store: TicketStore,
  linear: LinearClient,
  ticket: Ticket,
  sandboxId: string
): Promise<void> {
  const previewToken = randomBytes(24).toString("base64url");
  store.setPreviewTokenHash(ticket.linear_issue_id, tokenHash(previewToken));
  const previewUrl = `${cfg.supervisorUrl}/preview/${encodeURIComponent(
    ticket.linear_issue_identifier
  )}?token=${encodeURIComponent(previewToken)}`;
  try {
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "Created workspace",
      parameter: `${sandboxId} on ${ticket.repo}:${ticket.branch}`,
      result: `Wake-on-click preview: ${previewUrl}`,
    });
  } catch (error) {
    console.error("[linear] failed to post workspace activity:", error);
  }
  try {
    await agentSessionUpdate(linear, {
      sessionId: ticket.linear_session_id,
      addedExternalUrls: [{ label: "Workspace Preview", url: previewUrl }],
    });
  } catch (error) {
    console.error("[linear] failed to attach workspace preview:", error);
  }
}

async function handlePrompted(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  payload: ReturnType<typeof parseLinearWebhook>
): Promise<void> {
  const sessionId = payload.agentSession.id;
  const issue = payload.agentSession.issue;
  const resumeMessage =
    payload.agentActivity?.content?.body ?? payload.agentActivity?.body ?? "";
  await agentActivityCreate(linear, {
    sessionId,
    type: "thought",
    body: "Picking this back up…",
    ephemeral: true,
  });
  const ticket = issue
    ? store.getByIssueId(issue.id)
    : store.listAll().find((candidate) => candidate.linear_session_id === sessionId);
  if (!ticket || !ticket.sandbox_id) {
    await tryPostError(
      linear,
      sessionId,
      "OpenThrottle couldn't find an existing workspace. Delegate the issue again to start one."
    );
    return;
  }

  const nextContext = linearContext(
    payload,
    `${ticket.linear_context ?? `# ${ticket.linear_issue_identifier}`}\n\n## Latest human reply\n\n${resumeMessage}`
  );
  store.setLinearContext(ticket.linear_issue_id, nextContext);
  const currentTicket = store.getByIssueId(ticket.linear_issue_id) ?? ticket;

  if (resumeMessage.trim() === "/stop") {
    await stopTicket({
      store,
      daytona,
      linear,
      ticket: currentTicket,
      reason: "Stopped from the Linear thread.",
    });
    return;
  }
  if (/^(?:\/merge|merge it)$/i.test(resumeMessage.trim())) {
    await mergeFromLinear(cfg, linear, currentTicket);
    return;
  }

  const labels = extractLabelNames(payload);
  const taskType: TaskType =
    labels.includes("investigate") && /\b(fix it|implement|go ahead)\b/i.test(resumeMessage)
      ? "implement"
      : "resume";
  await launchExistingTask({
    cfg,
    store,
    daytona,
    linear,
    ticket: currentTicket,
    taskType,
    resumeMessage: taskType === "resume" ? resumeMessage : undefined,
    linearContext: nextContext,
  });
}

async function mergeFromLinear(
  cfg: Config,
  linear: LinearClient,
  ticket: Ticket
): Promise<void> {
  if (!cfg.allowLinearMerge) {
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "Linear merge is disabled. Merge from GitHub, or set ALLOW_LINEAR_MERGE=true.",
    });
    return;
  }
  if (!ticket.pr_url) {
    await tryPostError(linear, ticket.linear_session_id, "This ticket has no pull request to merge.");
    return;
  }
  const pull = parsePullRequestUrl(ticket.pr_url);
  const github: GithubClient = { token: cfg.githubToken };
  const readiness = await getMergeReadiness(github, pull.repo, pull.number);
  if (readiness.draft || !readiness.mergeable || !readiness.checksPresent || !readiness.checksGreen) {
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "The PR is not merge-ready: it must be non-draft, mergeable, and have terminal green checks.",
    });
    return;
  }
  const result = await mergePullRequest(github, pull.repo, pull.number, readiness.headSha);
  await agentActivityCreate(linear, {
    sessionId: ticket.linear_session_id,
    type: result.merged ? "response" : "error",
    body: result.merged ? `Merged ${ticket.pr_url}.` : `GitHub did not merge the PR: ${result.message}`,
  });
}

async function handleGithubEvent(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  getLinearClient: () => Promise<LinearClient | undefined>,
  event: GithubWebhookEvent
): Promise<void> {
  const linear = await getLinearClient();
  if (event.kind === "pull_request") {
      const branch = event.pull_request.head.ref;
      if (!isOpenthrottleBranch(branch)) return;
      const ticket = store.getByBranch(event.repository.full_name, branch);
      if (!ticket) return;
      if (event.action === "closed") {
        await closeTicketForPullRequest({
          store,
          daytona,
          linear,
          ticket,
          prUrl: event.pull_request.html_url,
          merged: event.pull_request.merged,
        });
      } else if (
        event.action === "review_requested" ||
        (event.action === "labeled" && event.label?.name === "needs-review")
      ) {
        await triggerReviewTask(
          cfg,
          store,
          daytona,
          linear,
          ticket,
          event.pull_request.number,
          "review"
        );
      }
      return;
  }

  if (event.kind === "pull_request_review") {
      const ticket = store.getByBranch(event.repository.full_name, event.pull_request.head.ref);
      if (!ticket || !linear || event.action !== "submitted") return;
      await agentActivityCreate(linear, {
        sessionId: ticket.linear_session_id,
        type: "action",
        action: "PR review submitted",
        parameter: `${event.review.user?.login ?? "reviewer"}: ${event.review.state}`,
        result: event.review.html_url,
      });
      if (event.review.state.toLowerCase() === "changes_requested") {
        await triggerReviewTask(
          cfg,
          store,
          daytona,
          linear,
          ticket,
          event.pull_request.number,
          "review-fix"
        );
      }
      return;
  }

  const branch =
    event.kind === "workflow_run" ? event.workflow_run.head_branch : event.check_suite.head_branch;
  if (!isOpenthrottleBranch(branch) || !linear || event.action !== "completed") return;
  const ticket = store.getByBranch(event.repository.full_name, branch);
  if (!ticket) return;
  const conclusion =
    event.kind === "workflow_run" ? event.workflow_run.conclusion : event.check_suite.conclusion;
  const url = event.kind === "workflow_run" ? event.workflow_run.html_url : event.check_suite.url;
  await agentActivityCreate(linear, {
    sessionId: ticket.linear_session_id,
    type: "action",
    action: "CI completed",
    parameter: conclusion ?? "unknown",
    result: url,
  });
}

async function triggerReviewTask(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient | undefined,
  ticket: Ticket,
  pullNumber: number,
  taskType: "review" | "review-fix"
): Promise<void> {
  if (!linear) return;
  const round = await countChangesRequestedReviews(
    { token: cfg.githubToken },
    ticket.repo,
    pullNumber
  );
  if (round >= cfg.reviewMaxRounds) {
    const message = `Review rounds exhausted (${round}/${cfg.reviewMaxRounds}) — needs a human decision.`;
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: "error",
      body: message,
    });
    await commentOnPullRequest({ token: cfg.githubToken }, ticket.repo, pullNumber, message);
    return;
  }
  await launchExistingTask({
    cfg,
    store,
    daytona,
    linear,
    ticket: store.getByIssueId(ticket.linear_issue_id) ?? ticket,
    taskType,
    pullNumber,
    reviewRound: round + 1,
  });
}

export async function expireRun(
  daytona: Daytona,
  store: TicketStore,
  linear: LinearClient | undefined,
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
  }
  if (ticket) await tryPostError(linear, ticket.linear_session_id, message);
}
