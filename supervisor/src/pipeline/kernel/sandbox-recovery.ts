import {
  compareCodeUnits,
  type DecisionRecord,
  type DeliveryRecord,
  type ExecutionRecord,
} from "@openthrottle/contracts";

export const SANDBOX_FATAL_RECOVERY_EVALUATOR = "core/sandbox-fatal-recovery@1" as const;
export const SANDBOX_FATAL_FRONTIER_EVALUATOR = "core/sandbox-fatal-frontier@1" as const;
const SANDBOX_RECOVERY_FRONTIER_SCHEMA =
  "openthrottle.sandbox-recovery-frontier-member/v1" as const;

export interface SandboxRecoveryFrontierMember {
  attempt_id: string;
  depends_on: readonly string[];
  stage_id: string;
  record: DecisionRecord;
}

function errorText(value: unknown): string {
  if (value instanceof Error) {
    const fields = value as Error & { code?: unknown; errno?: unknown; cause?: unknown };
    return [fields.message, fields.code, fields.errno, fields.cause === undefined ? "" : errorText(fields.cause)]
      .map(String)
      .join(" ");
  }
  return typeof value === "string" ? value : String(value);
}

/** Daytona and the sandbox runtime expose ENOSPC through several stable surfaces. */
export function isSandboxFatalEnospc(value: unknown): boolean {
  if (value instanceof Error) {
    const fields = value as Error & { code?: unknown; errno?: unknown; cause?: unknown };
    if (fields.code === "ENOSPC" || fields.errno === -28) return true;
    if (fields.cause !== undefined && isSandboxFatalEnospc(fields.cause)) return true;
  }
  const detail = errorText(value);
  return /\bENOSPC\b/i.test(detail) || /errno\s*[:=]?\s*-28\b/i.test(detail) ||
    /no space left on device/i.test(detail) || /\.part:\s*create:\s*open\b/i.test(detail);
}

export function sandboxFailureReason(value: unknown): string {
  return errorText(value).trim().replace(/\s+/g, " ").slice(0, 1_500) || "sandbox ENOSPC";
}

export function sandboxRecoveryEvaluator(attemptId: string): string {
  return `${SANDBOX_FATAL_RECOVERY_EVALUATOR}:${attemptId}`;
}

export function sandboxRecoveryFrontierEvaluator(attemptId: string): string {
  return `${SANDBOX_FATAL_FRONTIER_EVALUATOR}:${attemptId}`;
}

export function sandboxRecoveryFrontierReason(dependsOn: readonly string[]): string {
  return JSON.stringify({
    schema: SANDBOX_RECOVERY_FRONTIER_SCHEMA,
    depends_on: [...dependsOn],
  });
}

export function sandboxRecoveryAttemptId(record: ExecutionRecord): string | null {
  if (
    record.kind !== "decision" ||
    record.payload_schema !== "openthrottle.pipeline-decision-record/v1" ||
    !("inline" in record.payload) || !record.payload.inline ||
    typeof record.payload.inline !== "object" || Array.isArray(record.payload.inline)
  ) return null;
  const evaluator = (record.payload.inline as Record<string, unknown>).evaluator;
  const prefix = `${SANDBOX_FATAL_RECOVERY_EVALUATOR}:`;
  return typeof evaluator === "string" && evaluator.startsWith(prefix) && evaluator.length > prefix.length
    ? evaluator.slice(prefix.length)
    : null;
}

export function exactSandboxRecoveryRecord(records: readonly ExecutionRecord[]): DecisionRecord | null {
  const matches = records.filter((record) => sandboxRecoveryAttemptId(record) !== null);
  if (matches.length > 1) throw new Error("Attempt context contains multiple sandbox-fatal recoveries");
  return (matches[0] as DecisionRecord | undefined) ?? null;
}

export function exactSandboxFatalAbsenceDelivery(
  records: readonly ExecutionRecord[],
): DeliveryRecord | null {
  const matches = records.filter((record): record is DeliveryRecord => {
    if (
      record.kind !== "delivery" || record.status !== "rejected" ||
      record.payload_schema !== "openthrottle.effect-delivery/v1" ||
      !("inline" in record.payload) || !record.payload.inline ||
      typeof record.payload.inline !== "object" || Array.isArray(record.payload.inline)
    ) return false;
    const envelope = record.payload.inline as Record<string, unknown>;
    const result = envelope.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const evidence = result as Record<string, unknown>;
    return envelope.effect_kind === "daytona/integrate-checkpoint@1" &&
      envelope.provider === "daytona" &&
      (envelope.observed_via === "reconciliation" ||
        envelope.observed_via === "post_dispatch_reconciliation") &&
      evidence.schema === "openthrottle.daytona-integration-delivery/v1" &&
      evidence.state === "retryable_failure" &&
      evidence.pipeline_run_id === record.pipeline_run_id &&
      evidence.effect_id === record.effect_id &&
      evidence.idempotency_key === record.idempotency_key &&
      typeof evidence.reason === "string" &&
      evidence.reason.startsWith("sandbox_fatal_absent:");
  });
  if (matches.length > 1) {
    throw new Error("Attempt contains multiple sandbox-fatal absence deliveries");
  }
  return matches[0] ?? null;
}

function sandboxRecoveryFrontierMember(record: ExecutionRecord): SandboxRecoveryFrontierMember | null {
  if (record.kind !== "decision") return null;
  const prefix = `${SANDBOX_FATAL_FRONTIER_EVALUATOR}:`;
  if (!record.reducer.startsWith(prefix)) return null;
  const attemptId = record.reducer.slice(prefix.length);
  if (
    attemptId.length === 0 || record.payload_schema !== "openthrottle.pipeline-decision-record/v1" ||
    !("inline" in record.payload) || !record.payload.inline ||
    typeof record.payload.inline !== "object" || Array.isArray(record.payload.inline)
  ) throw new Error("sandbox recovery frontier record is malformed");
  const payload = record.payload.inline as Record<string, unknown>;
  const payloadKeys = Object.keys(payload).sort(compareCodeUnits);
  if (
    JSON.stringify(payloadKeys) !==
      JSON.stringify(["evaluator", "outcome", "reason", "schema", "stage_id"]) ||
    payload.schema !== "openthrottle.pipeline-decision-record/v1" ||
    payload.evaluator !== record.reducer || payload.outcome !== "retryable_infrastructure_failure" ||
    typeof payload.reason !== "string" || typeof payload.stage_id !== "string" ||
    record.input_record_ids.length !== 0
  ) throw new Error("sandbox recovery frontier record changed its recovery classification");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.reason);
  } catch {
    throw new Error("sandbox recovery frontier record has invalid dependency evidence");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sandbox recovery frontier record has invalid dependency evidence");
  }
  const detail = parsed as Record<string, unknown>;
  const keys = Object.keys(detail).sort(compareCodeUnits);
  if (
    JSON.stringify(keys) !== JSON.stringify(["depends_on", "schema"]) ||
    detail.schema !== SANDBOX_RECOVERY_FRONTIER_SCHEMA || !Array.isArray(detail.depends_on) ||
    detail.depends_on.some((dependency) => typeof dependency !== "string")
  ) throw new Error("sandbox recovery frontier record has invalid dependency evidence");
  const dependsOn = detail.depends_on as string[];
  const canonical = [...new Set(dependsOn)].sort(compareCodeUnits);
  if (
    canonical.length !== dependsOn.length ||
    canonical.some((dependency, index) => dependency !== dependsOn[index])
  ) throw new Error("sandbox recovery frontier dependencies are not canonical");
  return { attempt_id: attemptId, depends_on: canonical, stage_id: payload.stage_id, record };
}

export function exactSandboxRecoveryFrontier(
  records: readonly ExecutionRecord[],
): readonly SandboxRecoveryFrontierMember[] {
  const members = records.flatMap((record) => {
    const member = sandboxRecoveryFrontierMember(record);
    return member === null ? [] : [member];
  }).sort((left, right) => compareCodeUnits(left.attempt_id, right.attempt_id));
  if (new Set(members.map(({ attempt_id }) => attempt_id)).size !== members.length) {
    throw new Error("sandbox recovery frontier contains duplicate Attempt identities");
  }
  return members;
}

export function isDaytonaRuntimeDelivery(record: ExecutionRecord): boolean {
  if (record.kind !== "delivery" || !("inline" in record.payload)) return false;
  const payload = record.payload.inline;
  return record.payload_schema === "openthrottle.effect-delivery/v1" && payload !== null &&
    typeof payload === "object" && !Array.isArray(payload) &&
    (payload.effect_kind === "daytona/create-sandbox@1" ||
      payload.effect_kind === "daytona/start-sandbox@1");
}
