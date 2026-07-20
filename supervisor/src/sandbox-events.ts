import type { Daytona, Sandbox } from "@daytona/sdk";
import type { AgentActivityInput, AgentPlanItem, AgentPlanStatus } from "./linear.js";
import type { Ticket, TicketStore } from "./db.js";
import { ensureSandboxActive } from "./daytona.js";
import { reconcileSandboxAutostop } from "./sandbox-lifecycle.js";
import { isGithubPullRequestUrl } from "./github.js";
import { MAX_PRIVATE_LOG_TAIL_BYTES, MAX_PRIVATE_LOG_TAIL_CHARS } from "./logs.js";
import { sanitizeText } from "./sanitize.js";

const OUTBOX_DIR = "/home/agent/.ot/outbox";
const TASK_LOG_TAIL_COMMAND = `tail -c ${MAX_PRIVATE_LOG_TAIL_BYTES} /home/agent/.ot/task.log`;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_BODY_LENGTH = 8_000;
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVITY_TYPES: ReadonlyArray<SandboxActivityEvent["type"]> = [
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
];
const PLAN_STATUSES: ReadonlyArray<AgentPlanStatus> = [
  "pending",
  "inProgress",
  "completed",
  "canceled",
];
const MAX_PLAN_ITEMS = 50;
const MAX_PLAN_CONTENT = 500;

export type SandboxEvent = SandboxActivityEvent | SandboxPlanEvent | SandboxCompletionEvent;

interface SandboxActivityEvent {
  version: 1;
  kind: "activity";
  event_id: string;
  run_id: string;
  created_at: string;
  type: "thought" | "action" | "elicitation" | "response" | "error";
  body: string;
  // Ephemeral thoughts/actions self-replace in Linear — used for the live
  // progress heartbeat emitted by runner/normalize.mjs.
  ephemeral?: boolean;
  // Structured fields for `action` events: verb + parameter, plus an optional
  // result once the step completes. When present they render as a proper
  // Linear action instead of the flat "Progress: <body>" fallback.
  action?: string;
  parameter?: string;
  result?: string;
}

interface SandboxPlanEvent {
  version: 1;
  kind: "plan";
  event_id: string;
  run_id: string;
  created_at: string;
  plan: AgentPlanItem[];
}

interface SandboxCompletionEvent {
  version: 1;
  kind: "completion";
  event_id: string;
  run_id: string;
  created_at: string;
  token: string;
  exit_code: number;
  cost_usd?: number;
  pr_url?: string;
  failure_tail?: string;
  final_response?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActivityType(value: unknown): value is SandboxActivityEvent["type"] {
  return typeof value === "string" && ACTIVITY_TYPES.includes(value as SandboxActivityEvent["type"]);
}

function parsePlanItems(value: unknown): AgentPlanItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_ITEMS) {
    throw new Error("sandbox plan has an invalid item list");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > MAX_PLAN_CONTENT ||
      !PLAN_STATUSES.includes(item.status as AgentPlanStatus)
    ) {
      throw new Error("sandbox plan has an invalid item");
    }
    return { content: item.content, status: item.status as AgentPlanStatus };
  });
}

export function parseSandboxEvent(raw: string): SandboxEvent {
  if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new Error("sandbox event is too large");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1) throw new Error("unsupported sandbox event");
  if (typeof value.event_id !== "string" || !EVENT_ID_PATTERN.test(value.event_id)) {
    throw new Error("sandbox event has an invalid event_id");
  }
  if (typeof value.run_id !== "string" || !RUN_ID_PATTERN.test(value.run_id)) {
    throw new Error("sandbox event has an invalid run_id");
  }
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new Error("sandbox event has an invalid created_at");
  }

  if (value.kind === "activity") {
    if (!isActivityType(value.type)) {
      throw new Error("sandbox activity has an invalid type");
    }
    if (typeof value.body !== "string" || !value.body.trim() || value.body.length > MAX_BODY_LENGTH) {
      throw new Error("sandbox activity has an invalid body");
    }
    if (value.ephemeral !== undefined && typeof value.ephemeral !== "boolean") {
      throw new Error("sandbox activity has an invalid ephemeral flag");
    }
    const actionFields: Pick<SandboxActivityEvent, "action" | "parameter" | "result"> = {};
    if (value.type === "action") {
      for (const key of ["action", "parameter", "result"] as const) {
        const field = value[key];
        if (field === undefined) continue;
        if (typeof field !== "string" || field.length > MAX_BODY_LENGTH) {
          throw new Error(`sandbox activity has an invalid ${key}`);
        }
        actionFields[key] = field;
      }
    }
    return {
      version: 1,
      kind: "activity",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      type: value.type,
      body: value.body,
      ...(value.ephemeral === true ? { ephemeral: true } : {}),
      ...actionFields,
    };
  }
  if (value.kind === "plan") {
    return {
      version: 1,
      kind: "plan",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      plan: parsePlanItems(value.plan),
    };
  }
  if (value.kind === "completion") {
    if (typeof value.token !== "string" || value.token.length < 16 || value.token.length > 256) {
      throw new Error("sandbox completion has an invalid token");
    }
    if (typeof value.exit_code !== "number" || !Number.isInteger(value.exit_code)) {
      throw new Error("sandbox completion has an invalid exit_code");
    }
    if (
      value.cost_usd !== undefined &&
      (typeof value.cost_usd !== "number" || !Number.isFinite(value.cost_usd) || value.cost_usd < 0)
    ) {
      throw new Error("sandbox completion has an invalid cost_usd");
    }
    if (value.pr_url !== undefined && !isGithubPullRequestUrl(value.pr_url)) {
      throw new Error("sandbox completion has an invalid pr_url");
    }
    if (
      value.failure_tail !== undefined &&
      (typeof value.failure_tail !== "string" || value.failure_tail.length > 4_000)
    ) {
      throw new Error("sandbox completion has an invalid failure_tail");
    }
    if (
      value.final_response !== undefined &&
      (typeof value.final_response !== "string" || value.final_response.length > MAX_BODY_LENGTH)
    ) {
      throw new Error("sandbox completion has an invalid final_response");
    }
    return {
      version: 1,
      kind: "completion",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      token: value.token,
      exit_code: value.exit_code,
      ...(typeof value.cost_usd === "number" ? { cost_usd: value.cost_usd } : {}),
      ...(isGithubPullRequestUrl(value.pr_url) ? { pr_url: value.pr_url } : {}),
      ...(typeof value.failure_tail === "string"
        ? { failure_tail: value.failure_tail }
        : {}),
      ...(typeof value.final_response === "string"
        ? { final_response: sanitizeText(value.final_response).slice(0, MAX_BODY_LENGTH) }
        : {}),
    };
  }
  throw new Error("sandbox event has an invalid kind");
}

function toLinearActivity(event: SandboxActivityEvent, sessionId: string): AgentActivityInput {
  const body = sanitizeText(event.body);
  // Linear only honors `ephemeral` on thought/action activities; it is ignored
  // (and omitted) for the others.
  if (event.type === "action") {
    // Prefer the structured verb/parameter/result; fall back to the flat
    // "Progress: <body>" shape for legacy single-string actions.
    if (event.action && event.parameter) {
      return {
        sessionId,
        type: "action",
        action: sanitizeText(event.action),
        parameter: sanitizeText(event.parameter),
        ...(event.result ? { result: sanitizeText(event.result) } : {}),
        ...(event.ephemeral ? { ephemeral: true } : {}),
      };
    }
    return {
      sessionId,
      type: "action",
      action: "Progress",
      parameter: body,
      ...(event.ephemeral ? { ephemeral: true } : {}),
    };
  }
  if (event.type === "thought") {
    return { sessionId, type: "thought", body, ...(event.ephemeral ? { ephemeral: true } : {}) };
  }
  return { sessionId, type: event.type, body };
}

function sanitizePlan(plan: AgentPlanItem[]): AgentPlanItem[] {
  return plan.map((item) => ({ content: sanitizeText(item.content), status: item.status }));
}

async function listEventFiles(sandbox: Sandbox) {
  const files = await sandbox.fs.listFiles(OUTBOX_DIR);
  return files
    .filter((file) => !file.isDir && /^[A-Za-z0-9._-]+\.json$/.test(file.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readTaskLogTail(sandbox: Sandbox, callbackToken: string): Promise<string | undefined> {
  if (!sandbox.process?.executeCommand) return undefined;
  try {
    const result = await sandbox.process.executeCommand(TASK_LOG_TAIL_COMMAND, undefined, undefined, 10);
    if (result.exitCode !== 0 || !result.result) return undefined;
    return sanitizeText(result.result, process.env, [callbackToken]).slice(-MAX_PRIVATE_LOG_TAIL_CHARS);
  } catch (error) {
    console.warn("[sandbox-events] could not preserve the private task log tail:", error);
    return undefined;
  }
}

interface SandboxEventPollerParams {
  daytona: Daytona;
  store: TicketStore;
  postActivity: (
    activity: AgentActivityInput,
    event: SandboxActivityEvent & { issueId: string }
  ) => Promise<unknown>;
  // Forwards a session-level plan (live gate/phase checklist) to Linear.
  // Optional so tests and older callers that never emit plans compile
  // unchanged; a plan event with no handler is dropped, not retried forever.
  postSessionUpdate?: (params: {
    sessionId: string;
    issueId: string;
    plan: AgentPlanItem[];
    eventId: string;
  }) => Promise<unknown>;
  finishCompletion: (completion: {
    runId: string;
    token: string;
    exitCode: number;
    costUsd?: number;
    prUrl?: string;
    failureTail?: string;
    finalResponse?: string;
    logTail?: string;
  }) => Promise<{ status: number }>;
  // Best-effort read-back of a rotating agent credential (Codex refresh token)
  // from the sandbox after a run completes. Must not throw.
  captureAgentAuth?: (sandbox: Sandbox, ticket: Ticket) => Promise<void>;
}

async function pollTicketEvents(
  params: SandboxEventPollerParams,
  ticket: Ticket
): Promise<void> {
  if (!ticket.sandbox_id || !ticket.run_id) return;
  let sandbox: Sandbox;
  let files;
  try {
    sandbox = await params.daytona.get(ticket.sandbox_id);
    if (sandbox.state !== "started") await sandbox.start(60);
    await ensureSandboxActive(sandbox);
    if (params.store.getByIssueId(ticket.linear_issue_id)?.run_id !== ticket.run_id) {
      await reconcileSandboxAutostop({
        daytona: params.daytona,
        store: params.store,
        issueId: ticket.linear_issue_id,
        sandboxId: ticket.sandbox_id,
      });
      return;
    }
    files = await listEventFiles(sandbox);
  } catch (error) {
    console.error(`[sandbox-events] could not inspect ${ticket.linear_issue_identifier}:`, error);
    return;
  }

  for (const file of files) {
    const remotePath = `${OUTBOX_DIR}/${file.name}`;
    if (file.size > MAX_EVENT_BYTES) {
      console.error(`[sandbox-events] deleting oversized event ${file.name}`);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }

    let event: SandboxEvent;
    try {
      const raw = (await sandbox.fs.downloadFile(remotePath)).toString("utf8");
      event = parseSandboxEvent(raw);
    } catch (error) {
      console.error(`[sandbox-events] deleting invalid event ${file.name}:`, error);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }

    if (event.run_id !== ticket.run_id) {
      console.warn(`[sandbox-events] deleting stale event ${event.event_id} for ${event.run_id}`);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }

    const existing = params.store.insertSandboxEvent({
      eventId: event.event_id,
      runId: event.run_id,
      sandboxId: ticket.sandbox_id,
      kind: event.kind,
      payload: JSON.stringify(
        event.kind === "activity"
          ? {
              ...event,
              body: sanitizeText(event.body),
              ...(event.action ? { action: sanitizeText(event.action) } : {}),
              ...(event.parameter ? { parameter: sanitizeText(event.parameter) } : {}),
              ...(event.result ? { result: sanitizeText(event.result) } : {}),
            }
          : event.kind === "plan"
            ? { ...event, plan: sanitizePlan(event.plan) }
            : {
                ...event,
                token: "[redacted]",
                ...(event.failure_tail
                  ? { failure_tail: sanitizeText(event.failure_tail) }
                  : {}),
              }
      ),
    });
    if (
      existing.run_id !== event.run_id ||
      existing.sandbox_id !== ticket.sandbox_id ||
      existing.kind !== event.kind
    ) {
      console.error(`[sandbox-events] deleting conflicting event id ${event.event_id}`);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }
    if (existing.status === "processed") {
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }

    const now = new Date();
    const claimed = params.store.claimSandboxEvent(
      event.event_id,
      now.toISOString(),
      new Date(now.getTime() + 30_000).toISOString()
    );
    if (!claimed) break;

    try {
      if (event.kind === "activity") {
        const run = params.store.getRun(event.run_id);
        const sessionId = run?.linear_session_id ?? ticket.linear_session_id;
        if (run?.linear_session_id && run.linear_session_id !== ticket.linear_session_id) {
          const session = params.store.getSession(run.linear_session_id);
          if (session?.state === "superseded") {
            await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
            params.store.markSandboxEventProcessed(event.event_id);
            continue;
          }
        }
        await params.postActivity(toLinearActivity(event, sessionId), {
          ...event,
          issueId: run?.linear_issue_id ?? ticket.linear_issue_id,
        });
      } else if (event.kind === "plan") {
        const run = params.store.getRun(event.run_id);
        const sessionId = run?.linear_session_id ?? ticket.linear_session_id;
        if (run?.linear_session_id && run.linear_session_id !== ticket.linear_session_id) {
          const session = params.store.getSession(run.linear_session_id);
          if (session?.state === "superseded") {
            await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
            params.store.markSandboxEventProcessed(event.event_id);
            continue;
          }
        }
        // A plan event with no wired handler is simply dropped below (marked
        // processed), never retried forever.
        if (params.postSessionUpdate) {
          await params.postSessionUpdate({
            sessionId,
            issueId: run?.linear_issue_id ?? ticket.linear_issue_id,
            plan: sanitizePlan(event.plan),
            eventId: event.event_id,
          });
        }
      } else {
        const logTail = await readTaskLogTail(sandbox, event.token);
        // Capture the token the run rotated in the sandbox BEFORE finishing:
        // completeRun schedules follow-up work (a queued resume) before it
        // returns, and that resume reseeds Codex auth from the settings store.
        // Persisting the rotation first keeps the resume from replaying the
        // spent token. Best-effort — the hook must not throw.
        await params.captureAgentAuth?.(sandbox, ticket);
        const result = await params.finishCompletion({
          runId: event.run_id,
          token: event.token,
          exitCode: event.exit_code,
          costUsd: event.cost_usd,
          prUrl: event.pr_url,
          failureTail: event.failure_tail,
          finalResponse: event.final_response,
          logTail,
        });
        if (result.status !== 200 && result.status !== 409) {
          throw new Error(`completion rejected with status ${result.status}`);
        }
      }
      params.store.markSandboxEventProcessed(event.event_id);
    } catch (error) {
      const message = sanitizeText(String(error)).slice(-2_000);
      params.store.markSandboxEventFailed(
        event.event_id,
        message,
        new Date(Date.now() + 5_000).toISOString()
      );
      console.error(`[sandbox-events] event ${event.event_id} failed:`, error);
      break;
    }
    await sandbox.fs.deleteFile(remotePath).catch((error) =>
      console.warn(`[sandbox-events] processed ${event.event_id} but could not delete its file:`, error)
    );
  }
}

export async function pollSandboxEvents(params: SandboxEventPollerParams): Promise<void> {
  await Promise.all(
    params.store.listRunning().map((ticket) => pollTicketEvents(params, ticket))
  );
}
