import type { Daytona, Sandbox } from "@daytona/sdk";
import type { AgentActivityInput } from "./linear.js";
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

export type SandboxEvent = SandboxActivityEvent | SandboxCompletionEvent;

interface SandboxActivityEvent {
  version: 1;
  kind: "activity";
  event_id: string;
  run_id: string;
  created_at: string;
  type: "thought" | "action" | "elicitation" | "response" | "error";
  body: string;
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
    return {
      version: 1,
      kind: "activity",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      type: value.type,
      body: value.body,
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
  if (event.type === "action") {
    return { sessionId, type: "action", action: "Progress", parameter: body };
  }
  return { sessionId, type: event.type, body };
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
          ? { ...event, body: sanitizeText(event.body) }
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
      } else {
        const logTail = await readTaskLogTail(sandbox, event.token);
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
        // The run rotated its credentials in the sandbox; capture them before
        // the workspace is torn down so the next run seeds the live token.
        await params.captureAgentAuth?.(sandbox, ticket);
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
