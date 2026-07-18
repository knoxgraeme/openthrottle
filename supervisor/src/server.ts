import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Daytona } from "@daytonaio/sdk";
import type { Config } from "./config.js";
import type { Agent, TicketStore } from "./db.js";
import {
  agentActivityCreate,
  agentSessionUpdate,
  buildLinearInstallUrl,
  exchangeLinearOAuthCode,
  extractLabelNames,
  parseLinearWebhook,
  verifyLinearSignature,
  type LinearClient,
} from "./linear.js";
import {
  isOpenthrottleBranch,
  parseGithubPullRequestEvent,
  verifyGithubSignature,
} from "./github.js";
import {
  computePreviewUrl,
  createForTicket,
  deleteSandbox,
  startAndResume,
  type SandboxEnvContract,
} from "./daytona.js";

const SETTINGS_KEY_LINEAR_TOKEN = "linear_access_token";

export interface ServerDeps {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
}

/** In-memory OAuth CSRF state, short-lived (install -> callback round trip). */
const pendingOauthStates = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function pruneOauthStates() {
  const now = Date.now();
  for (const [state, expiry] of pendingOauthStates) {
    if (expiry < now) pendingOauthStates.delete(state);
  }
}

function getLinearClient(store: TicketStore): LinearClient | undefined {
  const token = store.getSetting(SETTINGS_KEY_LINEAR_TOKEN);
  return token ? { accessToken: token } : undefined;
}

function pickAgent(labels: string[]): Agent {
  // SPEC "Repo/agent routing": label `agent:codex` on the issue -> codex, else claude.
  return labels.includes("agent:codex") ? "codex" : "claude";
}

function branchFor(issueIdentifier: string): string {
  return `ot/${issueIdentifier.toLowerCase()}`;
}

function baseSandboxEnv(
  cfg: Config,
  params: {
    agent: Agent;
    branch: string;
    sessionId: string;
    issueId: string;
    issueIdentifier: string;
    linearAccessToken: string;
  }
): Omit<SandboxEnvContract, "TASK_TYPE" | "RESUME_MESSAGE"> {
  return {
    AGENT: params.agent,
    GITHUB_REPO: cfg.githubRepo,
    GITHUB_TOKEN: cfg.githubToken,
    BASE_BRANCH: cfg.baseBranch,
    BRANCH_NAME: params.branch,
    LINEAR_SESSION_ID: params.sessionId,
    LINEAR_ISSUE_ID: params.issueId,
    LINEAR_ISSUE_IDENTIFIER: params.issueIdentifier,
    LINEAR_ACCESS_TOKEN: params.linearAccessToken,
    LINEAR_MCP_API_KEY: cfg.linearMcpApiKey,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeCodeOauthToken,
    ANTHROPIC_API_KEY: cfg.anthropicApiKey,
    CODEX_API_KEY: cfg.codexApiKey,
    CODEX_AUTH_JSON: cfg.codexAuthJson,
    MAX_TURNS: String(cfg.maxTurns),
    TASK_TIMEOUT: String(cfg.taskTimeout),
    DEV_PORT: String(cfg.devPort),
  };
}

/** Best-effort error activity — never lets a posting failure escape. */
async function tryPostError(
  linear: LinearClient | undefined,
  sessionId: string | undefined,
  message: string
): Promise<void> {
  if (!linear || !sessionId) return;
  try {
    await agentActivityCreate(linear, { sessionId, type: "error", body: message });
  } catch (err) {
    console.error("[linear] failed to post error activity:", err);
  }
}

export function createServer(deps: ServerDeps): Hono {
  const { cfg, store, daytona } = deps;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Read-only status endpoint (CLI contract: `openthrottle status` -> GET /status).
  app.get("/status", (c) => {
    const rows = store.listAll().map((t) => ({
      issue: t.linear_issue_identifier,
      branch: t.branch,
      agent: t.agent,
      state: t.state,
      pr_url: t.pr_url,
      sandbox_id: t.sandbox_id,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));
    return c.json({ tickets: rows });
  });

  // -------------------------------------------------------------------
  // Linear OAuth (actor=app install flow)
  // -------------------------------------------------------------------

  app.get("/oauth/install", (c) => {
    pruneOauthStates();
    const state = randomBytes(16).toString("hex");
    pendingOauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    const redirectUri = new URL("/oauth/callback", c.req.url).toString();
    const url = buildLinearInstallUrl({
      clientId: cfg.linearClientId,
      redirectUri,
      state,
    });
    return c.redirect(url, 302);
  });

  app.get("/oauth/callback", async (c) => {
    pruneOauthStates();
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code) return c.text("Missing code", 400);
    if (!state || !pendingOauthStates.has(state)) {
      return c.text("Missing or expired state", 400);
    }
    pendingOauthStates.delete(state);

    const redirectUri = new URL("/oauth/callback", c.req.url).toString();
    try {
      const token = await exchangeLinearOAuthCode({
        clientId: cfg.linearClientId,
        clientSecret: cfg.linearClientSecret,
        redirectUri,
        code,
      });
      store.setSetting(SETTINGS_KEY_LINEAR_TOKEN, token.access_token);
      return c.text("OpenThrottle Linear app installed successfully. You can close this tab.");
    } catch (err) {
      console.error("[oauth] Linear token exchange failed:", err);
      return c.text("OAuth exchange failed, check supervisor logs.", 500);
    }
  });

  // -------------------------------------------------------------------
  // Linear webhook: AgentSessionEvent (created | prompted)
  // -------------------------------------------------------------------

  app.post("/webhooks/linear", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("Linear-Signature"); // TODO(verify-linear-api): confirm header name/casing
    if (!verifyLinearSignature(rawBody, signature, cfg.linearWebhookSecret)) {
      console.warn("[webhooks/linear] invalid signature");
      return c.text("invalid signature", 401);
    }

    let sessionIdForError: string | undefined;
    try {
      const payload = parseLinearWebhook(rawBody);
      const linear = getLinearClient(store);
      const sessionId = payload.agentSession.id;
      sessionIdForError = sessionId;

      if (!linear) {
        console.error("[webhooks/linear] no Linear access token stored — was /oauth/install completed?");
        return c.text("ok", 200);
      }

      if (payload.action === "created") {
        await handleCreated(cfg, store, daytona, linear, payload, sessionId);
      } else if (payload.action === "prompted") {
        await handlePrompted(cfg, store, daytona, linear, payload, sessionId);
      } else {
        console.log(`[webhooks/linear] ignoring action=${payload.action}`);
      }
    } catch (err) {
      console.error("[webhooks/linear] handler error:", err);
      await tryPostError(getLinearClient(store), sessionIdForError, `OpenThrottle hit an error: ${String(err)}`);
    }

    // Always 200 — never let Linear retry-storm on our internal errors.
    return c.text("ok", 200);
  });

  // -------------------------------------------------------------------
  // GitHub webhook: pull_request closed
  // -------------------------------------------------------------------

  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Hub-Signature-256");
    if (!verifyGithubSignature(rawBody, signature, cfg.githubWebhookSecret)) {
      console.warn("[webhooks/github] invalid signature");
      return c.text("invalid signature", 401);
    }

    try {
      const event = parseGithubPullRequestEvent(rawBody);
      if (event.action === "closed" && isOpenthrottleBranch(event.pull_request.head.ref)) {
        await handlePrClosed(store, daytona, getLinearClient(store), event);
      }
    } catch (err) {
      console.error("[webhooks/github] handler error:", err);
    }

    return c.text("ok", 200);
  });

  return app;
}

async function handleCreated(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  payload: ReturnType<typeof parseLinearWebhook>,
  sessionId: string
): Promise<void> {
  const issue = payload.agentSession.issue;
  if (!issue) {
    await tryPostError(linear, sessionId, "OpenThrottle could not find an issue on this agent session.");
    return;
  }

  // 1. Ack IMMEDIATELY, before any sandbox work (SPEC: must happen < 10s).
  await agentActivityCreate(linear, {
    sessionId,
    type: "thought",
    body: "Spinning up a workspace…",
  });

  try {
    const branch = branchFor(issue.identifier);
    const labels = extractLabelNames(payload);
    const agent = pickAgent(labels);

    // Re-delegation guard: if this issue already has a live workspace, reuse
    // it (resume) instead of creating a duplicate sandbox and orphaning the
    // old one. The new agent session id replaces the old on the row.
    const existing = store.getByIssueId(issue.id);
    if (existing?.sandbox_id && existing.state === "active") {
      try {
        const sandbox = await daytona.get(existing.sandbox_id);
        const env = baseSandboxEnv(cfg, {
          agent: existing.agent,
          branch: existing.branch,
          sessionId,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          linearAccessToken: linear.accessToken,
        });
        await startAndResume(daytona, sandbox, {
          resumeMessage:
            "This ticket was re-delegated. Re-read the ticket for any new context, then continue or adjust the existing work on this branch.",
          env,
          taskTimeoutSeconds: cfg.taskTimeout,
        });
        store.upsert({ ...existing, linear_session_id: sessionId, state: "active" });
        await agentActivityCreate(linear, {
          sessionId,
          type: "action",
          body: `Found an existing workspace on \`${existing.branch}\` — resuming there instead of starting over.`,
        });
        return;
      } catch (err) {
        // Sandbox row is stale (sandbox gone / unreachable) — fall through to
        // a fresh create below.
        console.warn(`[linear] stale sandbox for ${issue.identifier}, creating fresh:`, err);
      }
    }

    const env = baseSandboxEnv(cfg, {
      agent,
      branch,
      sessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      linearAccessToken: linear.accessToken,
    });

    const sandbox = await createForTicket(daytona, cfg, {
      issueIdentifier: issue.identifier,
      env,
    });

    store.upsert({
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
      linear_session_id: sessionId,
      sandbox_id: sandbox.id,
      branch,
      agent,
      repo: cfg.githubRepo,
      pr_url: null,
      state: "active",
    });

    const previewUrl = computePreviewUrl(sandbox.id, cfg.devPort);
    await agentActivityCreate(linear, {
      sessionId,
      type: "action",
      body: `Workspace ready on branch \`${branch}\`. Preview (once the dev server is up): ${previewUrl}`,
    });
  } catch (err) {
    console.error(`[linear] created-flow failed for ${issue.identifier}:`, err);
    store.upsert({
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
      linear_session_id: sessionId,
      sandbox_id: null,
      branch: branchFor(issue.identifier),
      agent: pickAgent(extractLabelNames(payload)),
      repo: cfg.githubRepo,
      pr_url: null,
      state: "error",
    });
    await tryPostError(linear, sessionId, `Failed to create a workspace: ${String(err)}`);
  }
}

async function handlePrompted(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  payload: ReturnType<typeof parseLinearWebhook>,
  sessionId: string
): Promise<void> {
  const issue = payload.agentSession.issue;
  const resumeMessage =
    payload.agentActivity?.body ?? payload.agentActivity?.content?.body ?? "";

  // 1. Ack IMMEDIATELY, before any sandbox work.
  await agentActivityCreate(linear, {
    sessionId,
    type: "thought",
    body: "Picking this back up…",
  });

  try {
    const ticket = issue
      ? store.getByIssueId(issue.id)
      : store.listAll().find((t) => t.linear_session_id === sessionId);

    if (!ticket || !ticket.sandbox_id) {
      await tryPostError(
        linear,
        sessionId,
        "OpenThrottle couldn't find an existing workspace for this ticket. Delegate the issue again to start one."
      );
      return;
    }

    const sandbox = await daytona.get(ticket.sandbox_id);
    const env = baseSandboxEnv(cfg, {
      agent: ticket.agent,
      branch: ticket.branch,
      sessionId,
      issueId: ticket.linear_issue_id,
      issueIdentifier: ticket.linear_issue_identifier,
      linearAccessToken: linear.accessToken,
    });

    await startAndResume(daytona, sandbox, {
      resumeMessage,
      env,
      taskTimeoutSeconds: cfg.taskTimeout,
    });

    store.setState(ticket.linear_issue_id, "active");
  } catch (err) {
    console.error("[linear] prompted-flow failed:", err);
    await tryPostError(linear, sessionId, `Failed to resume the workspace: ${String(err)}`);
  }
}

async function handlePrClosed(
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient | undefined,
  event: ReturnType<typeof parseGithubPullRequestEvent>
): Promise<void> {
  const ticket = store.getByBranch(event.pull_request.head.ref);
  if (!ticket) {
    console.log(`[webhooks/github] no ticket for branch ${event.pull_request.head.ref}`);
    return;
  }

  if (ticket.sandbox_id) {
    try {
      await deleteSandbox(daytona, ticket.sandbox_id);
    } catch (err) {
      console.error(`[webhooks/github] failed to delete sandbox ${ticket.sandbox_id}:`, err);
    }
  }

  store.setPrUrl(ticket.linear_issue_id, event.pull_request.html_url);
  store.setState(ticket.linear_issue_id, "closed");

  if (linear) {
    const verb = event.pull_request.merged ? "merged" : "closed";
    try {
      await agentActivityCreate(linear, {
        sessionId: ticket.linear_session_id,
        type: "response",
        body: `PR ${verb}, workspace cleaned up.`,
      });
      await agentSessionUpdate(linear, {
        sessionId: ticket.linear_session_id,
        externalUrl: event.pull_request.html_url,
        externalUrlLabel: "Pull Request",
      });
    } catch (err) {
      console.error("[webhooks/github] failed to post closing activity:", err);
    }
  }
}
