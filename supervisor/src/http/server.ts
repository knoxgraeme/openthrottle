import { Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../app/config.js";
import type { WebhookDelivery } from "../persistence/delivery-store.js";
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import {
  buildLinearInstallUrl,
  exchangeLinearOAuthCode,
  type LinearClient,
} from "../providers/linear/client.js";
import {
  fetchIssueLabels,
  isRecentLinearWebhook,
  linearControlEvent,
  parseLinearWebhook,
  verifyLinearSignature,
} from "../providers/linear/events.js";
import {
  branchExists,
  getMergeReadiness,
  getRepositoryConfigAtCommit,
  getRepositoryDirectoryAtCommit,
  getRepositoryFileAtCommit,
  mergePullRequest,
  parseGithubWebhook,
  parsePullRequestUrl,
  prepareRepository,
  verifyGithubSignature,
  type GithubWebhookEvent,
} from "../providers/github/client.js";
import { MAX_PRIVATE_LOG_TAIL_CHARS } from "../shared/logs.js";
import { sanitizeText } from "../shared/sanitize.js";
import {
  createLinearClientProvider,
  createLinearOAuthStateStore,
  persistLinearToken,
} from "../providers/linear/auth.js";
import {
  createWebhookDeliveryProcessor,
  type WebhookDeliveryProcessor,
} from "./webhook-delivery.js";
import { createLinearActivityPublisher, createLinearOutboxProcessor, tryPostError, type LinearOutboxProcessor } from "../providers/linear/outbox.js";
import { handleControlEvent, type PipelineCoordinatorContext, type SessionServicePorts } from "../app/session-service.js";
import { createAdmissionPreflight } from "../app/admission-preflight.js";
import { handleGithubEvent } from "../providers/github/events.js";
import { renderPipelineLogHeader } from "../pipeline/publication.js";
import { canSteerPipelineRun, requestPipelineStop } from "../pipeline/control.js";
import { stageById } from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { ExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import type { AnalysisStore } from "../persistence/pipeline/analysis-store.js";
import type { CitationGateStore } from "../persistence/pipeline/citation-gate-store.js";
import type { RuntimeInventory, RuntimeLogs, RuntimeSnapshotReadiness } from "../runtime/contracts.js";
import { executeRawCitationGate } from "./citation-executor.js";

const MAX_CITATION_CONTRACT_BYTES = 256 * 1024;

export interface ServerDeps {
  cfg: Config;
  store: SupervisorStore;
  runtime: RuntimeLogs & RuntimeSnapshotReadiness & RuntimeInventory;
  // A plain read-only handle onto run_outcomes/receipt evidence, wired
  // directly off `db` in index.ts -- deliberately not part of
  // pipelineCoordinator.store (PipelineStore), which gate/transition/
  // scheduler/effect-drain code consumes. See analysis-store.ts.
  analysisStore: AnalysisStore;
  citationGateStore: CitationGateStore;
  runBackground?: (task: Promise<void>) => void;
  getLinearClient?: () => Promise<LinearClient | undefined>;
  deliveryProcessor?: WebhookDeliveryProcessor;
  linearOutboxProcessor?: LinearOutboxProcessor;
  pipelineCoordinator: PipelineCoordinatorContext;
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

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function readBoundedUtf8Body(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error("citation_contract: JSON exceeds 256 KiB");
    }
  }

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("citation_contract: JSON exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function findTicket(store: SupervisorStore, identifier: string): Ticket | undefined {
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
  store: SupervisorStore;
  runtime: RuntimeInventory;
  getLinearClient: () => Promise<LinearClient | undefined>;
  linearOutbox?: LinearOutboxProcessor;
  pipelineCoordinator: PipelineCoordinatorContext;
  // OPE-75: best-effort reclaim of eligible terminal stopped runtime
  // resources, wired in index.ts (operations/runtime-resource-reclaim.ts).
  // The admission preflight runs this once before rejecting a delegation on
  // capacity. Kept as a generic callback here so http/ stays clear of an
  // operations/ import (see __tests__/architecture.test.ts boundary map).
  reconcileRuntimeCapacity?: () => Promise<unknown>;
}): WebhookDeliveryProcessor {
  const linearOutbox =
    deps.linearOutbox ??
    createLinearOutboxProcessor({ store: deps.store, getLinearClient: deps.getLinearClient });
  const admissionPreflight = createAdmissionPreflight(deps.cfg, deps.runtime, deps.reconcileRuntimeCapacity);
  const activityPublisher = createLinearActivityPublisher(deps.store, linearOutbox);
  const createSessionServicePorts = (linear: LinearClient): SessionServicePorts => ({
    activityPublisher,
    labelResolver: {
      fetchThreadLabels: (issueId: string) => fetchIssueLabels(linear, issueId),
    },
    repositoryReader: {
      branchExists: (repository: string, branch: string) =>
        branchExists({ token: deps.cfg.githubToken }, repository, branch),
      getRepositoryConfigAtCommit: (repository: string, branch: string) =>
        getRepositoryConfigAtCommit({ token: deps.cfg.githubToken }, repository, branch),
      getRepositoryFileAtCommit: (repository: string, commit: string, path: string) =>
        getRepositoryFileAtCommit({ token: deps.cfg.githubToken }, repository, commit, path),
      getRepositoryDirectoryAtCommit: (repository: string, commit: string, path: string) =>
        getRepositoryDirectoryAtCommit({ token: deps.cfg.githubToken }, repository, commit, path),
    },
    merger: {
      parsePullRequestUrl,
      getMergeReadiness: (repo: string, pullNumber: number) =>
        getMergeReadiness({ token: deps.cfg.githubToken }, repo, pullNumber),
      mergePullRequest: (repo: string, pullNumber: number, expectedHeadSha: string) =>
        mergePullRequest({ token: deps.cfg.githubToken }, repo, pullNumber, expectedHeadSha),
    },
  });
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
        const linear = await deps.getLinearClient();
        if (!linear) throw new Error("No valid Linear OAuth token is stored");
        await handleControlEvent(
          deps.cfg,
          deps.store,
          createSessionServicePorts(linear),
          linearControlEvent(parseLinearWebhook(delivery.payload)),
          deps.pipelineCoordinator,
          admissionPreflight
        );
        return;
      }
      await handleGithubEvent(
        deps.cfg,
        deps.store,
        activityPublisher,
        parseGithubWebhook(delivery.event_name ?? undefined, delivery.payload),
        deps.pipelineCoordinator.store
      );
      await deps.pipelineCoordinator.drainEffects?.();
    },
  });
}

export function createServer(deps: ServerDeps): Hono {
  const { cfg, store, runtime } = deps;
  const getLinearClient = deps.getLinearClient ?? createLinearClientProvider(cfg, store);
  const linearOutboxProcessor =
    deps.linearOutboxProcessor ??
    createLinearOutboxProcessor({ store, getLinearClient });
  const deliveryProcessor =
    deps.deliveryProcessor ??
    createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime,
      getLinearClient,
      linearOutbox: linearOutboxProcessor,
      pipelineCoordinator: deps.pipelineCoordinator,
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

  // Authenticated, bounded evidence of the active runtime release: the CLI's
  // pre-mutation structured-ship gate (RR5/RR9) reads this before any Linear
  // access and must never activate structured mutation on an assumed or
  // cached capability set.
  app.get("/capabilities", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const runtime = deps.pipelineCoordinator.runtime;
    return context.json({
      release: runtime.descriptor.release,
      capabilityDigest: runtime.digest,
      capabilities: runtime.descriptor.capabilities,
      limits: { taskTimeoutSeconds: cfg.taskTimeout },
    });
  });

  app.get("/status", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({
      tickets: store.listAll().map((ticket) => {
        const pipeline = deps.pipelineCoordinator.store.getStatusForIssue(ticket.ticket_id);
        return {
          id: ticket.ticket_id,
          reference: ticket.ticket_reference,
          current_session_id: ticket.session_id,
          control_provider: ticket.control_provider,
          external_thread: {
            provider: ticket.control_provider,
            id: ticket.external_thread_id,
            reference: ticket.external_thread_reference,
          },
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
          pipeline: pipeline ?? null,
        };
      }),
    });
  });

  app.get("/repositories", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({ repositories: store.listRepositoryRegistrations() });
  });

  app.get("/status/journal", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const issue = context.req.query("issue");
    const repository = context.req.query("repository");
    const from = context.req.query("from");
    const to = context.req.query("to");
    const limit = context.req.query("limit");
    if (!issue && !repository) {
      return context.json({ error: "issue or repository is required" }, 400);
    }
    try {
      return context.json({
        journal: deps.pipelineCoordinator.store.listJournalEntries({
          issue,
          repository,
          from,
          to,
          limit: limit ? Number(limit) : undefined,
        }),
      });
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
  });

  // Read-only evidence for improvement proposals: run_outcomes and the
  // receipt data folded into it (see docs/SPEC.md "Analysis read-contract").
  // Never consumed by gate, transition, scheduler, or effect-drain code --
  // enforced by supervisor/src/__tests__/architecture.test.ts.
  app.get("/analysis/runs", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const limit = context.req.query("limit");
    try {
      return context.json({
        runs: deps.analysisStore.listRunOutcomes({
          outcome: context.req.query("outcome"),
          reason: context.req.query("reason"),
          attribution: context.req.query("attribution"),
          graph: context.req.query("graph"),
          skillDigest: context.req.query("skill_digest"),
          from: context.req.query("from"),
          to: context.req.query("to"),
          limit: limit ? Number(limit) : undefined,
        }),
      });
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
  });

  app.post("/analysis/citations/grade", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const execution = executeRawCitationGate({
        raw: await readBoundedUtf8Body(context.req.raw, MAX_CITATION_CONTRACT_BYTES),
        analysisStore: deps.analysisStore,
        citationGateStore: deps.citationGateStore,
      });
      return context.json({
        ...execution.grade,
        gate: {
          result: execution.decision.result,
          outcome: execution.decision.outcome,
          reason: execution.decision.reason,
          proposal_hash: execution.decision.proposal_hash,
          grade_hash: execution.decision.grade_hash,
          receipt_hash: execution.receipt.receipt_hash,
        },
      }, execution.grade.result === "pass" ? 200 : 422);
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
  });

  app.get("/tickets/:identifier/journal", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    try {
      return context.json({
        journal: deps.pipelineCoordinator.store.listJournalEntries({
          issueId: ticket.ticket_id,
          from: context.req.query("from"),
          to: context.req.query("to"),
          limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
        }),
      });
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 400);
    }
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
    if (!cfg.linearWebhookSecret || !cfg.linearClientId || !cfg.linearClientSecret) {
      return context.json({
        error: "Linear control provider is unavailable: LINEAR_WEBHOOK_SECRET/LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET are not configured.",
      }, 503);
    }
    try {
      const snapshot = await runtime.getSnapshot(cfg.daytonaSnapshot);
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
    if (!cfg.linearClientId) {
      return context.text("Linear control provider is unavailable: LINEAR_CLIENT_ID is not configured.", 503);
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
    if (!cfg.linearClientId || !cfg.linearClientSecret) {
      return context.text("Linear control provider is unavailable: LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET are not configured.", 503);
    }
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
    if (!cfg.linearWebhookSecret) {
      return context.text("Linear control provider is unavailable: LINEAR_WEBHOOK_SECRET is not configured.", 503);
    }
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

  app.post("/tickets/:identifier/stop", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    try {
      const pipeline = deps.pipelineCoordinator.store.getInstanceForSession(ticket.session_id);
      if (!pipeline) return context.json({ error: "pipeline not found" }, 409);
      requestPipelineStop({
        store: deps.pipelineCoordinator.store,
        sessionId: ticket.session_id,
        eventId: `operator-stop:${pipeline.id}`,
        reason: "Stopped by operator.",
      });
      await deps.pipelineCoordinator.drainEffects?.();
      const refreshed = findTicket(store, context.req.param("identifier"));
      const stopEffect = deps.pipelineCoordinator.store.listEffects(pipeline.id)
        .filter((effect) => effect.kind === "stop")
        .at(-1);
      const stopped = refreshed?.run_id == null && stopEffect?.status === "acknowledged";
      return context.json({
        ok: true,
        status: stopped ? "stopped" : "stop_requested",
        ...(stopEffect ? { effect: { id: stopEffect.id, status: stopEffect.status } } : {}),
      }, stopped ? 200 : 202);
    } catch (error) {
      const message = sanitizeText(`Failed to stop workspace: ${String(error)}`);
      await tryPostError(
        store,
        linearOutboxProcessor,
        ticket.session_id,
        ticket.ticket_id,
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
    const pipeline = deps.pipelineCoordinator.store.getInstanceForSession(ticket.session_id);
    if (!pipeline) return context.json({ error: "pipeline not found" }, 409);
    const activeAttempt = deps.pipelineCoordinator.store.getActiveAttempt(pipeline.id);
    const canSteerNow = canSteerPipelineRun({
      store: deps.pipelineCoordinator.store,
      sessionId: ticket.session_id,
      runId: ticket.run_id,
      agent: ticket.agent,
      attempt: activeAttempt,
    });
    if (!canSteerNow && pipeline.status !== "running") {
      return context.json({ error: "the current pipeline stage does not accept live steering" }, 409);
    }
    // The message is untrusted data and is never executed. When the current
    // stage accepts steering, fence it to that exact run; otherwise leave it
    // unbound until a later steerable stage can lease it.
    const record = store.enqueueInbox({
      issueId: ticket.ticket_id,
      sessionId: ticket.session_id,
      runId: canSteerNow ? ticket.run_id : null,
      source: "operator",
      body: message,
    });
    // A composite (`for_each_unit`) run has no steerable child-action fence
    // today, so a reply captured here can never be bound and delivered live
    // (see docs/SPEC.md "Live steering"). Record that fact durably in the
    // structured ledger instead of letting it be silently canceled later
    // with no trace, so the terminal receipt says so.
    if (!canSteerNow) {
      const activeStage = activeAttempt
        ? stageById(pipeline.normalized_manifest, activeAttempt.stage_id)
        : undefined;
      if (activeAttempt && activeStage?.executor.kind === "loop_action") {
        // Best-effort: the message is already durably captured above. A
        // failure here should not turn an already-captured steer into a
        // client-visible error or invite a duplicating retry.
        try {
          (deps.pipelineCoordinator.store as PipelineStore & ExecutionUnitStore).recordSteeringCaptured({
            parentAttemptId: activeAttempt.id,
            id: record.id,
            body: "Operator steering message captured but not delivered: this run is a structured multi-unit stage, which does not yet support live steering to a specific child action. The message is recorded in Linear session activity only.",
          });
        } catch (error) {
          console.error("[steer] failed to record steering_undelivered ledger note:", error);
        }
      }
    }
    return context.json({
      ok: true,
      id: record.id,
      status: canSteerNow ? "queued" : "captured",
      ...(canSteerNow
        ? {}
        : { message: "captured — retained for the next implementation or repair stage" }),
    });
  });

  app.get("/tickets/:identifier/logs", async (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    const pipeline = deps.pipelineCoordinator.store.getStatusForIssue(ticket.ticket_id);
    const prefix = pipeline ? `${renderPipelineLogHeader(pipeline)}\n` : "";
    const withPipelinePrefix = (logs: string) =>
      prefix + sanitizeText(logs).slice(-Math.max(0, MAX_PRIVATE_LOG_TAIL_CHARS - prefix.length));
    if (ticket.sandbox_id) {
      try {
        const logs = await runtime.getLogs(ticket.sandbox_id);
        return context.text(withPipelinePrefix(logs));
      } catch (error) {
        console.warn(`[logs] live workspace unavailable for ${ticket.ticket_reference}:`, error);
      }
    }
    const durableLogTail = store.getLatestRunWithLog(ticket.ticket_id)?.log_tail;
    if (durableLogTail) {
      return context.text(withPipelinePrefix(durableLogTail));
    }
    if (pipeline) return context.text(prefix);
    return context.json({ error: "logs not found" }, 404);
  });

  app.post("/tickets/:identifier/publications/:publicationId/retry", (context) => {
    if (!requireStatusAuth(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    const ticket = findTicket(store, context.req.param("identifier"));
    if (!ticket) return context.json({ error: "ticket not found" }, 404);
    const pipelineStore = deps.pipelineCoordinator.store;
    const publication = pipelineStore.getPublication(context.req.param("publicationId"));
    const instance = publication ? pipelineStore.getInstance(publication.pipeline_instance_id) : undefined;
    if (!publication || instance?.ticket_id !== ticket.ticket_id) {
      return context.json({ error: "publication not found" }, 404);
    }
    try {
      const retried = pipelineStore.retryPublication(publication.id);
      if (retried.kind === "control_ledger") {
        schedule(linearOutboxProcessor.process(retried.id));
      }
      return context.json({
        ok: true,
        publication: { id: retried.id, kind: retried.kind, status: retried.status },
      });
    } catch (error) {
      return context.json({ error: sanitizeText(String(error)) }, 409);
    }
  });

  return app;
}
