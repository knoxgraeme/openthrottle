import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Ticket, TicketStore, WebhookDelivery } from "./db.js";
import {
  buildLinearInstallUrl,
  exchangeLinearOAuthCode,
  isRecentLinearWebhook,
  parseLinearWebhook,
  verifyLinearSignature,
  type LinearClient,
} from "./linear.js";
import {
  parseGithubWebhook,
  prepareRepository,
  verifyGithubSignature,
  type GithubWebhookEvent,
} from "./github.js";
import { getSandboxLogs, getSignedPreviewUrl, reviveDevServer, type DevServerRevival } from "./daytona.js";
import { MAX_PRIVATE_LOG_TAIL_CHARS } from "./logs.js";
import { sanitizeText } from "./sanitize.js";
import {
  createLinearClientProvider,
  createLinearOAuthStateStore,
  persistLinearToken,
} from "./linear-auth.js";
import { stopTicket } from "./ticket-control.js";
import {
  createWebhookDeliveryProcessor,
  type WebhookDeliveryProcessor,
} from "./webhook-delivery.js";
import { createLinearOutboxProcessor, tryPostError, type LinearOutboxProcessor } from "./linear-outbox.js";
import { hashesMatch, tokenHash, completeRun } from "./run-lifecycle.js";
import { handleLinearEvent, type PipelineAdmissionContext } from "./linear-events.js";
import { handleGithubEvent } from "./github-events.js";

// index.ts and sweep.ts keep importing `completeRun`/`expireRun` from here so
// their imports need minimal churn; the real implementations live in
// run-lifecycle.ts.
export { completeRun, expireRun } from "./run-lifecycle.js";

export interface ServerDeps {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  runBackground?: (task: Promise<void>) => void;
  getLinearClient?: () => Promise<LinearClient | undefined>;
  deliveryProcessor?: WebhookDeliveryProcessor;
  linearOutboxProcessor?: LinearOutboxProcessor;
  pipelineAdmission?: PipelineAdmissionContext;
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

function findTicket(store: TicketStore, identifier: string): Ticket | undefined {
  return store.getByIssueId(identifier) ?? store.getByIdentifier(identifier);
}

const LINEAR_TEAM_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// Upper bound on an operator steering message. Keeps a single injected file
// bounded (it is written verbatim into the sandbox and framed as untrusted data
// for the agent) and roughly aligns with the sandbox event body cap.
const MAX_STEER_MESSAGE_CHARS = 8_000;

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

export function createServerWebhookDeliveryProcessor(deps: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  getLinearClient: () => Promise<LinearClient | undefined>;
  linearOutbox?: LinearOutboxProcessor;
  pipelineAdmission?: PipelineAdmissionContext;
}): WebhookDeliveryProcessor {
  const linearOutbox =
    deps.linearOutbox ??
    createLinearOutboxProcessor({ store: deps.store, getLinearClient: deps.getLinearClient });
  return createWebhookDeliveryProcessor({
    store: deps.store,
    maxAttempts: 8,
    baseDelayMs: 30_000,
    onDead: async (delivery, error) => {
      if (delivery.source !== "linear" || !delivery.session_id) return;
      await tryPostError(
        deps.store,
        linearOutbox,
        delivery.session_id,
        undefined,
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
          linearOutbox,
          parseLinearWebhook(delivery.payload),
          deps.pipelineAdmission
        );
        return;
      }
      await handleGithubEvent(
        deps.cfg,
        deps.store,
        deps.daytona,
        deps.getLinearClient,
        linearOutbox,
        parseGithubWebhook(delivery.event_name ?? undefined, delivery.payload)
      );
    },
  });
}

export function createServer(deps: ServerDeps): Hono {
  const { cfg, store, daytona } = deps;
  const getLinearClient = deps.getLinearClient ?? createLinearClientProvider(cfg, store);
  const linearOutboxProcessor =
    deps.linearOutboxProcessor ??
    createLinearOutboxProcessor({ store, getLinearClient });
  const deliveryProcessor =
    deps.deliveryProcessor ??
    createServerWebhookDeliveryProcessor({
      cfg,
      store,
      daytona,
      getLinearClient,
      linearOutbox: linearOutboxProcessor,
      pipelineAdmission: deps.pipelineAdmission,
    });
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
      { cfg, store, daytona, getLinearClient, linearOutbox: linearOutboxProcessor, schedule },
      {
        runId: context.req.param("id"),
        token: bearerToken(context.req.header("Authorization")),
        exitCode: data.exit_code,
        costUsd: data.cost_usd,
        prUrl: data.pr_url,
        failureTail: data.failure_tail,
        finalResponse: data.final_response,
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
      await stopTicket({
        store,
        daytona,
        linear,
        linearOutbox: linearOutboxProcessor,
        ticket,
        reason: "Stopped by operator.",
      });
      return context.json({ ok: true });
    } catch (error) {
      const message = sanitizeText(`Failed to stop workspace: ${String(error)}`);
      await tryPostError(
        store,
        linearOutboxProcessor,
        ticket.linear_session_id,
        ticket.linear_issue_id,
        message
      );
      return context.json({ error: message }, 502);
    }
  });

  app.post("/tickets/:identifier/steer", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid JSON" }, 400);
    }
    const message = (body as Record<string, unknown> | null)?.message;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > MAX_STEER_MESSAGE_CHARS
    ) {
      return context.json({ error: "message is required" }, 400);
    }
    // Enqueue durably even if the ticket is not currently running — the inbox
    // poller delivers it on the next run. The body is untrusted data; it is only
    // stored here and later written as a file, never executed.
    const record = store.enqueueInbox({
      issueId: ticket.linear_issue_id,
      sessionId: ticket.linear_session_id,
      runId: ticket.run_id,
      source: "operator",
      body: message,
    });
    return context.json({ ok: true, id: record.id });
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
      // Probe and, if the dev server is down, restart it. `listening` → the app
      // is up, redirect to it. `starting` → it was down and has been
      // (re)started, show a page that auto-refreshes until it is ready.
      // `no-dev` → show the log with a clear "no dev server" note. A probe
      // failure (`unknown`) falls back to the plain redirect (previous
      // behavior), so a broken restart never worsens the outcome.
      let revival: DevServerRevival;
      try {
        revival = await reviveDevServer(daytona, ticket.sandbox_id, cfg.devPort);
      } catch (error) {
        console.warn("[preview] dev-server probe/restart failed, redirecting anyway:", error);
        revival = { state: "unknown", log: "" };
      }
      if (revival.state === "listening" || revival.state === "unknown") {
        return context.redirect(
          await getSignedPreviewUrl(daytona, ticket.sandbox_id, cfg.devPort),
          302
        );
      }
      return context.html(
        renderDevPreviewPage(
          ticket.linear_issue_identifier,
          cfg.devPort,
          revival.state,
          sanitizeText(revival.log).slice(-MAX_PRIVATE_LOG_TAIL_CHARS)
        ),
        200
      );
    } catch (error) {
      console.error("[preview] failed:", error);
      return context.text("preview unavailable", 502);
    }
  });

  return app;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Rendered when the wake-on-click preview restarted the dev server (`starting`,
// with an auto-refresh so the page becomes the app once it is up) or found no
// dev command (`no-dev`). Either way the latest dev log is shown so any
// startup/crash error is visible instead of a blank connection refusal.
function renderDevPreviewPage(
  identifier: string,
  port: number,
  state: "starting" | "no-dev",
  log: string
): string {
  const starting = state === "starting";
  const refresh = starting ? `<meta http-equiv="refresh" content="5">` : "";
  const heading = starting
    ? `Starting the dev server for ${escapeHtml(identifier)}`
    : `No dev server for ${escapeHtml(identifier)}`;
  const intro = starting
    ? `The dev server was not running (the workspace idled), so it is being restarted on port ${port}. This page refreshes automatically and will open the app once it is ready.`
    : `This repository does not configure a <code>dev</code> command in <code>.openthrottle.yml</code>, so nothing serves on port ${port}.`;
  const body = log.trim() ? `<pre>${escapeHtml(log)}</pre>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}` +
    `<title>Preview — ${escapeHtml(identifier)}</title>` +
    `<style>body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem;max-width:64rem;line-height:1.5}` +
    `h1{font-size:1.25rem}pre{white-space:pre-wrap;word-break:break-word;background:#111;color:#eee;padding:1rem;border-radius:8px;overflow:auto;max-height:70vh}</style>` +
    `</head><body><h1>${heading}</h1><p>${intro}</p>${body}</body></html>`
  );
}
