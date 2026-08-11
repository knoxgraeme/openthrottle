import { sanitizeText } from "../shared/sanitize.js";
import { STAGE_OUTCOMES } from "../pipeline/manifest.js";
import { LAUNCH_FAULT_REASONS, type LaunchFaultReason } from "../pipeline/fault-attribution.js";
import type { PipelineCoordinatorEvent, PipelineEventArtifact } from "../pipeline/coordinator.js";
import { isPathSafeActionId } from "./action-id.js";

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STAGE_EVENT_BYTES = 64 * 1024;
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
const PLAN_STATUSES: ReadonlyArray<RuntimePlanStatus> = [
  "pending",
  "inProgress",
  "completed",
  "canceled",
];
const MAX_PLAN_ITEMS = 50;
const MAX_PLAN_CONTENT = 500;

export type RuntimeProgressActivityInput =
  | {
      id?: string;
      sessionId: string;
      type: "thought" | "elicitation" | "response" | "error";
      body: string;
      ephemeral?: boolean;
    }
  | {
      id?: string;
      sessionId: string;
      type: "action";
      action: string;
      parameter: string;
      result?: string;
      ephemeral?: boolean;
    };

export type RuntimePlanStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface RuntimePlanItem {
  content: string;
  status: RuntimePlanStatus;
}

export type SandboxEvent = SandboxActivityEvent | SandboxPlanEvent | SandboxHeartbeatEvent | SandboxStageResultEvent;

export interface SandboxStageResultEvent {
  version: 1;
  kind: "stage_result";
  event_id: string;
  run_id: string;
  created_at: string;
  pipeline_instance_id: string;
  generation: number;
  stage_id: string;
  attempt_id: string;
  request_hash: string;
  outcome: PipelineCoordinatorEvent["outcome"];
  result_hash: string;
  native_session_id: string | null;
  subject: string;
  // Optional and additive: only present when the sandbox classified a launch
  // failure (see LAUNCH_FAILURE_REASONS in launch-failure.mjs). Absent on
  // older runners and on any other terminal outcome; the supervisor treats
  // absence as "attribute unknown", never as an error.
  fault_reason?: LaunchFaultReason;
  artifacts: PipelineEventArtifact[];
}

export interface SandboxHeartbeatEvent {
  version: 1;
  kind: "heartbeat";
  event_id: string;
  run_id: string;
  created_at: string;
  child_action_id?: string;
}

export interface SandboxActivityEvent {
  version: 1;
  kind: "activity";
  event_id: string;
  run_id: string;
  created_at: string;
  type: "thought" | "action" | "elicitation" | "response" | "error";
  body: string;
  // Ephemeral thoughts/actions self-replace in Linear. It is used for live
  // progress updates emitted by sandbox activity tooling.
  ephemeral?: boolean;
  // Structured fields for `action` events: verb + parameter, plus an optional
  // result once the step completes.
  action?: string;
  parameter?: string;
  result?: string;
}

export interface SandboxPlanEvent {
  version: 1;
  kind: "plan";
  event_id: string;
  run_id: string;
  created_at: string;
  plan: RuntimePlanItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActivityType(value: unknown): value is SandboxActivityEvent["type"] {
  return typeof value === "string" && ACTIVITY_TYPES.includes(value as SandboxActivityEvent["type"]);
}

function parsePlanItems(value: unknown): RuntimePlanItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_ITEMS) {
    throw new Error("sandbox plan has an invalid item list");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > MAX_PLAN_CONTENT ||
      !PLAN_STATUSES.includes(item.status as RuntimePlanStatus)
    ) {
      throw new Error("sandbox plan has an invalid item");
    }
    return { content: item.content, status: item.status as RuntimePlanStatus };
  });
}

export function parseSandboxEvent(raw: string): SandboxEvent {
  const rawBytes = Buffer.byteLength(raw);
  if (rawBytes > MAX_STAGE_EVENT_BYTES) throw new Error("sandbox event is too large");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1) throw new Error("unsupported sandbox event");
  if (value.kind !== "stage_result" && rawBytes > MAX_EVENT_BYTES) throw new Error("sandbox event is too large");
  if (typeof value.event_id !== "string" || !EVENT_ID_PATTERN.test(value.event_id)) {
    throw new Error("sandbox event has an invalid event_id");
  }
  if (typeof value.run_id !== "string" || !RUN_ID_PATTERN.test(value.run_id)) {
    throw new Error("sandbox event has an invalid run_id");
  }
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new Error("sandbox event has an invalid created_at");
  }

  if (value.kind === "heartbeat") {
    if (value.child_action_id !== undefined &&
        (typeof value.child_action_id !== "string" || !isPathSafeActionId(value.child_action_id))) {
      throw new Error("sandbox heartbeat has an invalid child_action_id");
    }
    return {
      version: 1,
      kind: "heartbeat",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      ...(value.child_action_id ? { child_action_id: value.child_action_id } : {}),
    };
  }
  if (value.kind === "stage_result") {
    const id = (field: unknown, label: string) => {
      if (typeof field !== "string" || !RUN_ID_PATTERN.test(field)) throw new Error(`stage result has invalid ${label}`);
      return field;
    };
    const sha = (field: unknown, label: string) => {
      if (typeof field !== "string" || !/^[a-f0-9]{64}$/.test(field)) throw new Error(`stage result has invalid ${label}`);
      return field;
    };
    if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
      throw new Error("stage result has invalid generation");
    }
    if (!STAGE_OUTCOMES.includes(value.outcome as never)) throw new Error("stage result has invalid outcome");
    if (value.native_session_id !== null &&
        (typeof value.native_session_id !== "string" || !RUN_ID_PATTERN.test(value.native_session_id))) {
      throw new Error("stage result has invalid native_session_id");
    }
    if (typeof value.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.subject)) {
      throw new Error("stage result has invalid subject");
    }
    if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 8) {
      throw new Error("stage result has invalid artifacts");
    }
    if (value.fault_reason !== undefined && !LAUNCH_FAULT_REASONS.includes(value.fault_reason as never)) {
      throw new Error("stage result has invalid fault_reason");
    }
    const artifacts = value.artifacts.map((entry, index): PipelineEventArtifact => {
      if (!isRecord(entry)) throw new Error(`stage result artifact ${index} is invalid`);
      if (typeof entry.kind !== "string" || entry.kind.length > 80 ||
          !Number.isSafeInteger(entry.schema_version) || (entry.schema_version as number) < 1 ||
          typeof entry.assurance !== "string" || entry.assurance.length > 80 ||
          typeof entry.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(entry.subject) ||
          typeof entry.payload !== "string" || Buffer.byteLength(entry.payload, "utf8") > 256 * 1024) {
        throw new Error(`stage result artifact ${index} is invalid`);
      }
      return {
        kind: entry.kind,
        schemaVersion: entry.schema_version as number,
        assurance: entry.assurance as PipelineEventArtifact["assurance"],
        subject: entry.subject,
        payload: entry.payload,
        hash: sha(entry.hash, `artifact ${index} hash`),
      };
    });
    return {
      version: 1,
      kind: "stage_result",
      event_id: value.event_id,
      run_id: value.run_id,
      created_at: value.created_at,
      pipeline_instance_id: id(value.pipeline_instance_id, "pipeline_instance_id"),
      generation: value.generation as number,
      stage_id: id(value.stage_id, "stage_id"),
      attempt_id: id(value.attempt_id, "attempt_id"),
      request_hash: sha(value.request_hash, "request_hash"),
      outcome: value.outcome as PipelineCoordinatorEvent["outcome"],
      result_hash: sha(value.result_hash, "result_hash"),
      native_session_id: value.native_session_id as string | null,
      subject: value.subject,
      ...(value.fault_reason ? { fault_reason: value.fault_reason as LaunchFaultReason } : {}),
      artifacts,
    };
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
  throw new Error("sandbox event has an invalid kind");
}

export function toProgressActivity(event: SandboxActivityEvent, sessionId: string): RuntimeProgressActivityInput {
  const body = sanitizeText(event.body);
  // Linear only honors `ephemeral` on thought/action activities; it is ignored
  // and omitted for the others.
  if (event.type === "action") {
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

export function sanitizePlan(plan: RuntimePlanItem[]): RuntimePlanItem[] {
  return plan.map((item) => ({ content: sanitizeText(item.content), status: item.status }));
}
