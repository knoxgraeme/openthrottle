import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Run, Ticket, TicketStore, WebhookDelivery } from "./db.js";
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
import type { SpritesClient } from "./sprites.js";
import { getSandboxLogs, getSignedPreviewUrl, readSpooledEvents } from "./sprites.js";
import {
  parseSandboxEvent,
  toLinearActivity,
  type SandboxActivityEvent,
  type SandboxEvent,
} from "./sandbox-events.js";
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
import {
  createLinearOutboxProcessor,
  enqueueActivity,
  tryPostError,
  type LinearOutboxProcessor,
} from "./linear-outbox.js";
import { hashesMatch, tokenHash, completeRun } from "./run-lifecycle.js";
import { handleLinearEvent } from "./linear-events.js";
import { handleGithubEvent } from "./github-events.js";

// index.ts and sweep.ts keep importing `completeRun`/`expireRun` from here so
// their imports need minimal churn; the real implementations live in
// run-lifecycle.ts.
export { completeRun, expireRun } from "./run-lifecycle.js";

export interface ServerDeps {
  cfg: Config;
  store: TicketStore;
  sprites: SpritesClient;
  runBackground?: (task: Promise<void>) => void;
  getLinearClient?: () => Promise<LinearClient | undefined>;
  deliveryProcessor?: WebhookDeliveryProcessor;
  linearOutboxProcessor?: LinearOutboxProcessor;
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

/**
 * Record a single sandbox activity: dedupes by event_id, resolves the run's own
 * session, drops late activity from a superseded session, and enqueues to the
 * Linear outbox (which owns delivery retries). Shared by the `/runs/:id/events`
 * push endpoint and the sweep/complete spool-drain fallback.
 */
async function recordSandboxActivity(
  store: TicketStore,
  outbox: LinearOutboxProcessor,
  run: Run,
  ticket: Ticket,
  event: SandboxActivityEvent
): Promise<void> {
  if (!ticket.sandbox_id) return;
  const payload = JSON.stringify({ ...event, body: sanitizeText(event.body) });
  const existing = store.insertSandboxEvent({
    eventId: event.event_id,
    runId: run.id,
    sandboxId: ticket.sandbox_id,
    kind: "activity",
    payload,
  });
  if (
    existing.run_id !== run.id ||
    existing.sandbox_id !== ticket.sandbox_id ||
    existing.kind !== "activity"
  ) {
    // A different event already claimed this id — ignore the conflicting push.
    return;
  }
  if (existing.status === "processed") return;

  const now = new Date();
  const claimed = store.claimSandboxEvent(
    event.event_id,
    now.toISOString(),
    new Date(now.getTime() + 30_000).toISOString()
  );
  if (!claimed) return; // a concurrent push is already handling it

  try {
    const sessionId = run.linear_session_id ?? ticket.linear_session_id;
    if (run.linear_session_id && run.linear_session_id !== ticket.linear_session_id) {
      const session = store.getSession(run.linear_session_id);
      if (session?.state === "superseded") {
        store.markSandboxEventProcessed(event.event_id);
        return;
      }
    }
    await enqueueActivity(
      store,
      outbox,
      toLinearActivity(event, sessionId),
      run.linear_issue_id ?? ticket.linear_issue_id,
      run.id
    );
    store.markSandboxEventProcessed(event.event_id);
  } catch (error) {
    store.markSandboxEventFailed(
      event.event_id,
      sanitizeText(String(error)).slice(-2_000),
      new Date(Date.now() + 5_000).toISOString()
    );
    throw error;
  }
}

/**
 * Best-effort drain of any events a sandbox spooled to disk when a push failed.
 * Read by the sweep for overdue runs before it times them out, and by
 * `/runs/:id/complete` (activities only) so a spooled elicitation is recorded
 * before the completion finalizes the run — reusing the exact dedupe +
 * projection the push endpoints use.
 */
export async function drainSpooledEventsForRun(
  deps: {
    cfg: Config;
    store: TicketStore;
    sprites: SpritesClient;
    getLinearClient: () => Promise<LinearClient | undefined>;
    linearOutbox: LinearOutboxProcessor;
  },
  run: Run,
  opts: { includeCompletions?: boolean } = {}
): Promise<void> {
  const includeCompletions = opts.includeCompletions ?? true;
  const ticket = deps.store.getByIssueId(run.linear_issue_id);
  if (!ticket?.sandbox_id) return;
  let raws: string[];
  try {
    raws = await readSpooledEvents(deps.sprites, ticket.sandbox_id);
  } catch (error) {
    console.warn(
      `[drain] could not read spooled events for ${ticket.linear_issue_identifier}:`,
      error
    );
    return;
  }
  const events: SandboxEvent[] = [];
  for (const raw of raws) {
    try {
      const event = parseSandboxEvent(raw);
      if (event.run_id === run.id) events.push(event);
    } catch {
      // ignore anything that is not a well-formed event
    }
  }
  // Activities first, then completions: a spooled elicitation must be recorded
  // before any spooled completion finalizes the run's terminal decision.
  for (const event of events) {
    if (event.kind !== "activity") continue;
    try {
      const current = deps.store.getRun(run.id);
      const currentTicket = deps.store.getByIssueId(run.linear_issue_id);
      if (current && currentTicket) {
        await recordSandboxActivity(deps.store, deps.linearOutbox, current, currentTicket, event);
      }
    } catch (error) {
      console.warn(`[drain] failed to apply spooled activity ${event.event_id}:`, error);
    }
  }
  if (!includeCompletions) return;
  for (const event of events) {
    if (event.kind !== "completion") continue;
    try {
      await completeRun(deps, {
        runId: event.run_id,
        token: event.token,
        exitCode: event.exit_code,
        costUsd: event.cost_usd,
        prUrl: event.pr_url,
        failureTail: event.failure_tail,
        finalResponse: event.final_response,
      });
    } catch (error) {
      console.warn(`[drain] failed to apply spooled completion ${event.event_id}:`, error);
    }
  }
}

export function createServerWebhookDeliveryProcessor(deps: {
  cfg: Config;
  store: TicketStore;
  sprites: SpritesClient;
  getLinearClient: () => Promise<LinearClient | undefined>;
  linearOutbox?: LinearOutboxProcessor;
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
          deps.sprites,
          deps.getLinearClient,
          linearOutbox,
          parseLinearWebhook(delivery.payload)
        );
        return;
      }
      await handleGithubEvent(
        deps.cfg,
        deps.store,
        deps.sprites,
        deps.getLinearClient,
        linearOutbox,
        parseGithubWebhook(delivery.event_name ?? undefined, delivery.payload)
      );
    },
  });
}

export function createServer(deps: ServerDeps): Hono {
  const { cfg, store, sprites } = deps;
  const getLinearClient = deps.getLinearClient ?? createLinearClientProvider(cfg, store);
  const linearOutboxProcessor =
    deps.linearOutboxProcessor ??
    createLinearOutboxProcessor({ store, getLinearClient });
  const deliveryProcessor =
    deps.deliveryProcessor ??
    createServerWebhookDeliveryProcessor({
      cfg,
      store,
      sprites,
      getLinearClient,
      linearOutbox: linearOutboxProcessor,
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
      // Liveness/authorization probe: throws if the Sprites token or org is bad.
      // Runs before any GitHub setup so a bad Sprites config fails fast and does
      // not create webhooks.
      await sprites.ping();
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
        // The snapshot column is retained (additive schema) but is meaningless
        // for Sprites, which provisions from the payload tarball, not a snapshot.
        snapshot: "sprites",
      });
      return context.json({
        registration,
        readiness: {
          github: "ready",
          webhook: github.webhookAction,
          sprites: "ready",
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
    const runId = context.req.param("id");
    const token = bearerToken(context.req.header("Authorization"));
    // Before finalizing, record any activities the sandbox spooled to disk when
    // a push failed (e.g. a decision elicitation): completeRun's terminal
    // decision reads the last processed activity, so a lost elicitation would
    // otherwise become a generic success or trigger a premature re-review.
    const pending = store.getRun(runId);
    if (pending && pending.status === "running" && token && hashesMatch(pending.token_hash, tokenHash(token))) {
      await drainSpooledEventsForRun(
        { cfg, store, sprites, getLinearClient, linearOutbox: linearOutboxProcessor },
        pending,
        { includeCompletions: false }
      ).catch((error) => console.warn("[complete] spooled-activity drain failed:", error));
    }
    const result = await completeRun(
      { cfg, store, sprites, getLinearClient, linearOutbox: linearOutboxProcessor, schedule },
      {
        runId,
        token,
        exitCode: data.exit_code,
        costUsd: data.cost_usd,
        prUrl: data.pr_url,
        failureTail: data.failure_tail,
        finalResponse: data.final_response,
      }
    );
    return context.json(result.body, result.status as 200 | 400 | 401 | 404 | 409);
  });

  // Sandbox activities arrive by push (the poll loop is gone). Auth mirrors
  // /runs/:id/complete: the per-run callback token gates the run, and only a
  // running run accepts activity. The body is a single validated activity event;
  // completions still go to /complete.
  app.post("/runs/:id/events", async (context) => {
    const runId = context.req.param("id");
    const token = bearerToken(context.req.header("Authorization"));
    const run = store.getRun(runId);
    if (!run) return context.json({ error: "run not found" }, 404);
    if (!token || !hashesMatch(run.token_hash, tokenHash(token))) {
      return context.json({ error: "invalid callback token" }, 401);
    }
    if (run.status !== "running") {
      return context.json({ error: "run is not active" }, 409);
    }
    let event: SandboxEvent;
    try {
      event = parseSandboxEvent(await context.req.text());
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
    if (event.kind !== "activity") {
      return context.json({ error: "only activity events are accepted here" }, 400);
    }
    if (event.run_id !== run.id) {
      return context.json({ error: "event run_id does not match the run" }, 400);
    }
    const ticket = store.getByIssueId(run.linear_issue_id);
    if (!ticket?.sandbox_id) {
      return context.json({ error: "run no longer active" }, 409);
    }
    try {
      await recordSandboxActivity(store, linearOutboxProcessor, run, ticket, event);
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 502);
    }
    return context.json({ ok: true });
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
        sprites,
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

  app.get("/tickets/:identifier/logs", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    if (ticket.sandbox_id) {
      try {
        const logs = await getSandboxLogs(sprites, ticket.sandbox_id);
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
        await getSignedPreviewUrl(sprites, ticket.sandbox_id, cfg.devPort),
        302
      );
    } catch (error) {
      console.error("[preview] failed:", error);
      return context.text("preview unavailable", 502);
    }
  });

  return app;
}
