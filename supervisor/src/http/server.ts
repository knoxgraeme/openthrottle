import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  EXECUTION_RECORD_KINDS,
  PIPELINE_TERMINAL_OUTCOMES,
  digestCanonicalJson,
  jsonValueAt,
  type ExecutionRecordKind,
  type JsonValue,
  type PipelineTerminalOutcome,
} from "@openthrottle/contracts";
import { Hono, type Context } from "hono";
import type { Config } from "../app/config.js";
import type { KernelExecutionPolicy } from "../app/kernel-composition.js";
import {
  KernelHttpConflictError,
  KernelHttpNotFoundError,
  type KernelHttpService,
  type KernelProviderWebhookResponse,
  type KernelRepositorySetupInput,
  type KernelRepositorySetupPort,
} from "../app/kernel-http.js";
import type { KernelHistoricalRunQuery } from "../persistence/kernel-analysis-store.js";
import { KERNEL_INBOX_MAX_PAYLOAD_BYTES } from "../persistence/kernel-inbox-store.js";
import type { KernelLogCursor, KernelLogKind } from "../persistence/kernel-projection-store.js";
import { readStreamUpToByteLimit } from "../shared/bounded-stream.js";
import { sanitizeText } from "../shared/sanitize.js";

const CONTROL_BODY_MAX_BYTES = 16 * 1024;
const REGISTRATION_BODY_MAX_BYTES = 32 * 1024;
const WEBHOOK_BODY_TOO_LARGE = `webhook payload exceeds ${KERNEL_INBOX_MAX_PAYLOAD_BYTES} bytes`;
const LOG_KINDS: readonly KernelLogKind[] = [
  "run", "attempt", "record", "effect", "checkpoint", "inbox",
];
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEAM_KEY = /^[A-Za-z0-9_-]+$/;

type KernelHttpConfig = Pick<
  Config,
  | "statusToken"
  | "deployToken"
  | "linearWebhookSecret"
  | "githubWebhookSecret"
  | "webhookMaxAgeSeconds"
>;

export interface KernelServerCapabilities {
  release: string;
  capability_digest: string;
  capabilities: readonly string[];
  execution_policy: KernelExecutionPolicy;
  task_timeout_seconds: number;
}

export interface KernelServerDeps {
  cfg: KernelHttpConfig;
  capabilities: KernelServerCapabilities;
  service: KernelHttpService;
  repository_setup: KernelRepositorySetupPort;
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function hasBearer(header: string | undefined, expected: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return false;
  return timingSafeEqual(tokenHash(match[1]), tokenHash(expected));
}

async function readBoundedUtf8Body(
  request: Request,
  maximum: number,
  tooLargeMessage: string,
): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximum) throw new Error(tooLargeMessage);
  }
  if (request.body === null) return "";
  const read = await readStreamUpToByteLimit(request.body, maximum);
  if (read.exceeded) throw new Error(tooLargeMessage);
  return new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maximum = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function jsonPayload(raw: string): { object: Record<string, unknown>; value: JsonValue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("request body is not valid JSON");
  }
  return {
    object: record(parsed, "request body"),
    value: jsonValueAt(parsed, "request.body"),
  };
}

function positiveInteger(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function optionalNonnegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return value as number;
}

function slug(value: unknown, name: string): string {
  const normalized = string(value, name, 100)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`${name} cannot be normalized`);
  return normalized;
}

function deliveryAttempt(request: Request): number {
  return positiveInteger(
    request.headers.get("x-openthrottle-delivery-attempt") ?? undefined,
    "delivery attempt",
    1_000_000,
  ) ?? 1;
}

function verifySignature(raw: string, signature: string | undefined, secret: string, github: boolean): boolean {
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const expected = github ? `sha256=${digest}` : digest;
  if (typeof signature !== "string" || signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function nestedObject(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = parent[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function linearWebhook(raw: string, request: Request, maxAgeSeconds: number) {
  const { object: payload, value } = jsonPayload(raw);
  const action = slug(payload.action, "Linear action");
  const type = slug(payload.type, "Linear event type");
  const webhookId = string(payload.webhookId, "Linear webhookId");
  if (typeof payload.webhookTimestamp !== "number" || !Number.isFinite(payload.webhookTimestamp)) {
    throw new Error("Linear webhookTimestamp must be a number");
  }
  if (Math.abs(Date.now() - payload.webhookTimestamp) > maxAgeSeconds * 1_000) {
    throw new KernelWebhookStaleError();
  }
  const session = nestedObject(payload, "agentSession");
  const issue = session ? nestedObject(session, "issue") : undefined;
  const team = issue ? nestedObject(issue, "team") : nestedObject(payload, "team");
  if (!team) throw new Error("Linear webhook does not identify a team route");
  const teamId = typeof team.id === "string" ? string(team.id, "Linear team ID", 300) : undefined;
  const teamKey = typeof team.key === "string" ? string(team.key, "Linear team key", 300) : undefined;
  if (!teamId && !teamKey) throw new Error("Linear webhook does not identify a team route");
  return {
    provider: "linear" as const,
    delivery_id: request.headers.get("linear-delivery") ?? webhookId,
    kind: `linear/${type}/${action}@1`,
    event_group_key: `linear:${webhookId}`,
    delivery_attempt: deliveryAttempt(request),
    route: {
      ...(teamId ? { linear_team_id: teamId } : {}),
      ...(teamKey ? { linear_team_key: teamKey } : {}),
    },
    payload_schema: "openthrottle.provider-event/linear/v1",
    payload: value,
  };
}

function githubGroupKey(event: string, action: string, payload: JsonValue): string {
  // GitHub retries normally retain the delivery ID. Including a canonical
  // semantic digest also recognizes an identical event delivered under a new
  // ID without collapsing two legitimate updates to the same Issue or PR.
  return `github:${event}:${action}:${digestCanonicalJson(payload)}`;
}

function githubWebhook(raw: string, request: Request) {
  const { object: payload, value } = jsonPayload(raw);
  const action = slug(payload.action, "GitHub action");
  const event = slug(request.headers.get("x-github-event"), "X-GitHub-Event");
  const deliveryId = string(
    request.headers.get("x-github-delivery"),
    "X-GitHub-Delivery",
  );
  const repository = nestedObject(payload, "repository");
  const fullName = string(repository?.full_name, "GitHub repository.full_name", 300);
  if (!REPOSITORY.test(fullName)) throw new Error("GitHub repository.full_name is invalid");
  return {
    provider: "github" as const,
    delivery_id: deliveryId,
    kind: `github/${event}/${action}@1`,
    event_group_key: githubGroupKey(event, action, value),
    delivery_attempt: deliveryAttempt(request),
    route: { github_repo: fullName },
    payload_schema: "openthrottle.provider-event/github/v1",
    payload: value,
  };
}

class KernelWebhookStaleError extends Error {
  constructor() {
    super("webhook timestamp is stale");
    this.name = "KernelWebhookStaleError";
  }
}

function registrationInput(value: Record<string, unknown>): KernelRepositorySetupInput {
  const repo = string(value.repo, "repo", 300);
  if (!REPOSITORY.test(repo)) throw new Error("repo must be owner/name");
  const controlProvider = value.controlProvider ?? "linear";
  if (controlProvider !== "linear" && controlProvider !== "github") {
    throw new Error("controlProvider must be linear or github");
  }
  const baseBranch = value.baseBranch === undefined
    ? undefined
    : string(value.baseBranch, "baseBranch", 300);
  if (controlProvider === "github") {
    if (value.linearTeamKey !== undefined || value.linearTeamId !== undefined) {
      throw new Error("GitHub control does not accept Linear team fields");
    }
    return { repo, controlProvider, ...(baseBranch ? { baseBranch } : {}) };
  }
  const linearTeamKey = string(value.linearTeamKey, "linearTeamKey", 300).toUpperCase();
  if (!TEAM_KEY.test(linearTeamKey)) throw new Error("linearTeamKey is invalid");
  const linearTeamId = value.linearTeamId === undefined
    ? undefined
    : string(value.linearTeamId, "linearTeamId", 300);
  return {
    repo,
    controlProvider,
    linearTeamKey,
    ...(linearTeamId ? { linearTeamId } : {}),
    ...(baseBranch ? { baseBranch } : {}),
  };
}

function analysisQuery(request: Request): KernelHistoricalRunQuery {
  const url = new URL(request.url);
  const terminal = url.searchParams.get("terminal_outcome") ?? undefined;
  if (terminal !== undefined && !PIPELINE_TERMINAL_OUTCOMES.includes(terminal as PipelineTerminalOutcome)) {
    throw new Error(`terminal_outcome must be one of: ${PIPELINE_TERMINAL_OUTCOMES.join(", ")}`);
  }
  const kind = url.searchParams.get("record_kind") ?? undefined;
  if (kind !== undefined && !EXECUTION_RECORD_KINDS.includes(kind as ExecutionRecordKind)) {
    throw new Error(`record_kind must be one of: ${EXECUTION_RECORD_KINDS.join(", ")}`);
  }
  return {
    ...(url.searchParams.get("pipeline_id")
      ? { pipeline_id: url.searchParams.get("pipeline_id")! }
      : {}),
    ...(terminal === undefined ? {} : { terminal_outcome: terminal as PipelineTerminalOutcome }),
    ...(kind === undefined ? {} : { record_kind: kind as ExecutionRecordKind }),
    ...(url.searchParams.get("from") ? { from: url.searchParams.get("from")! } : {}),
    ...(url.searchParams.get("to") ? { to: url.searchParams.get("to")! } : {}),
    ...(url.searchParams.get("limit")
      ? { limit: positiveInteger(url.searchParams.get("limit")!, "limit", 500) }
      : {}),
  };
}

function logCursor(request: Request): KernelLogCursor | undefined {
  const url = new URL(request.url);
  const occurredAt = url.searchParams.get("after_at") ?? undefined;
  const kind = url.searchParams.get("after_kind") ?? undefined;
  const id = url.searchParams.get("after_id") ?? undefined;
  if (occurredAt === undefined && kind === undefined && id === undefined) return undefined;
  if (!occurredAt || !kind || id === undefined || !LOG_KINDS.includes(kind as KernelLogKind)) {
    throw new Error("log cursor requires valid after_at, after_kind, and after_id");
  }
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("after_at must be an ISO timestamp");
  return { occurred_at: occurredAt, kind: kind as KernelLogKind, id };
}

function webhookResponse(context: Context, result: KernelProviderWebhookResponse) {
  if (!result.accepted) {
    if (!result.acknowledge) {
      context.header("Retry-After", String(result.retry_after_seconds));
      return context.json(result, 503);
    }
    return context.json(result, 202);
  }
  return context.json({
    accepted: true,
    acknowledge: true,
    retryable: false,
    event_id: result.event.id,
    duplicate: result.duplicate,
  }, result.duplicate ? 200 : 202);
}

function errorStatus(error: unknown): 400 | 404 | 409 {
  if (error instanceof KernelHttpNotFoundError) return 404;
  if (error instanceof KernelHttpConflictError) return 409;
  return 400;
}

function safeError(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 1_500);
}

export function createServer(deps: KernelServerDeps): Hono {
  const app = new Hono();
  const statusAuthorized = (header: string | undefined) => hasBearer(header, deps.cfg.statusToken);
  const deployAuthorized = (header: string | undefined) => hasBearer(header, deps.cfg.deployToken);

  app.get("/healthz", (context) => context.json({ ok: true }));

  app.get("/capabilities", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({
      release: deps.capabilities.release,
      capabilityDigest: deps.capabilities.capability_digest,
      capabilities: deps.capabilities.capabilities,
      limits: {
        maxConcurrentAttempts: deps.capabilities.execution_policy.max_concurrent_attempts,
        taskTimeoutSeconds: deps.capabilities.task_timeout_seconds,
      },
    });
  });

  app.get("/runs/:reference/status", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const limit = positiveInteger(context.req.query("limit"), "limit", 200);
      return context.json({ run: deps.service.status(context.req.param("reference"), limit) });
    } catch (error) {
      return context.json({ error: safeError(error) }, errorStatus(error));
    }
  });

  app.get("/runs/:reference/logs", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      return context.json(deps.service.logs({
        reference: context.req.param("reference"),
        ...(logCursor(context.req.raw) ? { after: logCursor(context.req.raw)! } : {}),
        ...(context.req.query("limit")
          ? { limit: positiveInteger(context.req.query("limit"), "limit", 500) }
          : {}),
      }));
    } catch (error) {
      return context.json({ error: safeError(error) }, errorStatus(error));
    }
  });

  app.get("/analysis/runs", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      return context.json({ runs: deps.service.analysis(analysisQuery(context.req.raw)) });
    } catch (error) {
      return context.json({ error: safeError(error) }, 400);
    }
  });

  app.get("/runs/:reference/analysis", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const kind = context.req.query("kind");
      if (kind !== undefined && !EXECUTION_RECORD_KINDS.includes(kind as ExecutionRecordKind)) {
        throw new Error(`kind must be one of: ${EXECUTION_RECORD_KINDS.join(", ")}`);
      }
      return context.json(deps.service.runAnalysis({
        reference: context.req.param("reference"),
        ...(kind === undefined ? {} : { kind: kind as ExecutionRecordKind }),
        ...(context.req.query("limit")
          ? { limit: positiveInteger(context.req.query("limit"), "limit", 500) }
          : {}),
      }));
    } catch (error) {
      return context.json({ error: safeError(error) }, errorStatus(error));
    }
  });

  app.post("/runs/:reference/control", async (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const raw = await readBoundedUtf8Body(
        context.req.raw,
        CONTROL_BODY_MAX_BYTES,
        `control request exceeds ${CONTROL_BODY_MAX_BYTES} bytes`,
      );
      const body = jsonPayload(raw).object;
      const action = body.action;
      if (action !== "stop" && action !== "supersede") {
        throw new Error("action must be stop or supersede");
      }
      const reason = body.reason === undefined ? undefined : string(body.reason, "reason", 1_500);
      const result = deps.service.requestRunControl({
        reference: context.req.param("reference"),
        action,
        ...(reason ? { reason } : {}),
      });
      if (!result.accepted) {
        context.header("Retry-After", String(result.retry_after_seconds ?? 30));
        return context.json(result, 503);
      }
      return context.json(result, result.duplicate ? 200 : 202);
    } catch (error) {
      return context.json({ error: safeError(error) }, errorStatus(error));
    }
  });

  app.get("/repositories", (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({ repositories: deps.service.registrations() });
  });

  app.post("/repositories/register", async (context) => {
    if (!statusAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    let input: KernelRepositorySetupInput;
    try {
      const raw = await readBoundedUtf8Body(
        context.req.raw,
        REGISTRATION_BODY_MAX_BYTES,
        `registration request exceeds ${REGISTRATION_BODY_MAX_BYTES} bytes`,
      );
      input = registrationInput(jsonPayload(raw).object);
    } catch (error) {
      return context.json({ error: safeError(error) }, 400);
    }
    try {
      const result = deps.service.registerPrepared(await deps.repository_setup.prepare(input));
      return context.json(result, result.disposition === "unchanged" ? 200 : 201);
    } catch (error) {
      return context.json({ error: safeError(error) }, 502);
    }
  });

  app.get("/maintenance", (context) => {
    if (!deployAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return context.json({ maintenance: deps.service.maintenanceState() });
  });

  const maintenanceMutation = (closed: boolean) => async (context: Context) => {
    if (!deployAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const raw = await readBoundedUtf8Body(
        context.req.raw,
        CONTROL_BODY_MAX_BYTES,
        `maintenance request exceeds ${CONTROL_BODY_MAX_BYTES} bytes`,
      );
      const expectedVersion = raw === ""
        ? undefined
        : optionalNonnegativeInteger(jsonPayload(raw).object.expected_version, "expected_version");
      const maintenance = closed
        ? deps.service.closeMaintenance(expectedVersion)
        : deps.service.openMaintenance(expectedVersion);
      return context.json({ maintenance });
    } catch (error) {
      return context.json({ error: safeError(error) }, 409);
    }
  };
  app.post("/maintenance/close", maintenanceMutation(true));
  app.post("/maintenance/open", maintenanceMutation(false));

  app.get("/maintenance/active-work", async (context) => {
    if (!deployAuthorized(context.req.header("Authorization"))) {
      return context.json({ error: "unauthorized" }, 401);
    }
    try {
      const limit = positiveInteger(context.req.query("limit"), "limit", 2_000);
      return context.json(await deps.service.activeWork(limit));
    } catch (error) {
      return context.json({ error: safeError(error) }, 400);
    }
  });

  app.post("/webhooks/linear", async (context) => {
    if (!deps.cfg.linearWebhookSecret) {
      return context.json({ error: "Linear webhook ingress is unavailable" }, 503);
    }
    let raw: string;
    try {
      raw = await readBoundedUtf8Body(
        context.req.raw,
        KERNEL_INBOX_MAX_PAYLOAD_BYTES,
        WEBHOOK_BODY_TOO_LARGE,
      );
    } catch (error) {
      return context.json({ error: safeError(error) },
        error instanceof Error && error.message === WEBHOOK_BODY_TOO_LARGE ? 413 : 400);
    }
    if (!verifySignature(
      raw,
      context.req.header("Linear-Signature"),
      deps.cfg.linearWebhookSecret,
      false,
    )) return context.json({ error: "invalid signature" }, 401);
    try {
      return webhookResponse(
        context,
        deps.service.ingestProviderWebhook(linearWebhook(raw, context.req.raw, deps.cfg.webhookMaxAgeSeconds)),
      );
    } catch (error) {
      return context.json(
        { error: safeError(error) },
        error instanceof KernelWebhookStaleError ? 401 : 400,
      );
    }
  });

  app.post("/webhooks/github", async (context) => {
    let raw: string;
    try {
      raw = await readBoundedUtf8Body(
        context.req.raw,
        KERNEL_INBOX_MAX_PAYLOAD_BYTES,
        WEBHOOK_BODY_TOO_LARGE,
      );
    } catch (error) {
      return context.json({ error: safeError(error) },
        error instanceof Error && error.message === WEBHOOK_BODY_TOO_LARGE ? 413 : 400);
    }
    if (!verifySignature(
      raw,
      context.req.header("X-Hub-Signature-256"),
      deps.cfg.githubWebhookSecret,
      true,
    )) return context.json({ error: "invalid signature" }, 401);
    try {
      return webhookResponse(context, deps.service.ingestProviderWebhook(githubWebhook(raw, context.req.raw)));
    } catch (error) {
      return context.json({ error: safeError(error) }, 400);
    }
  });

  return app;
}
