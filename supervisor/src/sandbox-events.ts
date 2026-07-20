import type { AgentActivityInput } from "./linear.js";
import { isGithubPullRequestUrl } from "./github.js";
import { sanitizeText } from "./sanitize.js";

// Sandbox events reach the supervisor by PUSH: the sandbox POSTs each activity
// to `/runs/:id/events` and its completion to `/runs/:id/complete`. This module
// owns only the wire contract — the allow-listed parser, the event types, and
// the projection of an activity into a Linear agent activity. The transport and
// dedupe/projection live in server.ts.

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

export interface SandboxActivityEvent {
  version: 1;
  kind: "activity";
  event_id: string;
  run_id: string;
  created_at: string;
  type: "thought" | "action" | "elicitation" | "response" | "error";
  body: string;
}

export interface SandboxCompletionEvent {
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

/** Project a validated sandbox activity into the Linear agent-activity input. */
export function toLinearActivity(event: SandboxActivityEvent, sessionId: string): AgentActivityInput {
  const body = sanitizeText(event.body);
  if (event.type === "action") {
    return { sessionId, type: "action", action: "Progress", parameter: body };
  }
  return { sessionId, type: event.type, body };
}
