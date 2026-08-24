import type {
  DeliveryRecord,
  ExecutionRecord,
} from "@openthrottle/contracts";

export interface ConfirmedGithubPushDelivery {
  record: DeliveryRecord;
  repository: string;
  ref: string;
  sha: string;
  ref_mode: "create" | "update";
}

export function isGithubPushDelivery(record: ExecutionRecord): record is DeliveryRecord & {
  payload: { inline: Record<string, unknown> };
} {
  return record.kind === "delivery" &&
    record.payload_schema === "openthrottle.effect-delivery/v1" &&
    "inline" in record.payload && record.payload.inline !== null &&
    typeof record.payload.inline === "object" && !Array.isArray(record.payload.inline) &&
    record.payload.inline.effect_kind === "github/push-checkpoint@1";
}

function parseConfirmedGithubPushDelivery(input: {
  record: ExecutionRecord;
  label: string;
  pipeline_run_id: string;
}): ConfirmedGithubPushDelivery {
  const { record } = input;
  if (!isGithubPushDelivery(record)) {
    throw new Error(`${input.label} is not task-ref push evidence`);
  }
  const envelope = record.payload.inline;
  const result = envelope.result;
  if (
    record.pipeline_run_id !== input.pipeline_run_id || record.status !== "confirmed" ||
    envelope.provider !== "github" ||
    !result || typeof result !== "object" || Array.isArray(result)
  ) throw new Error(`${input.label} contains invalid task-ref push evidence`);
  const value = result as Record<string, unknown>;
  if (
    value.schema !== "openthrottle.github-push-delivery/v1" ||
    typeof value.repository !== "string" ||
    typeof value.ref !== "string" || !/^refs\/heads\/ot\//.test(value.ref) ||
    typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha) ||
    (value.ref_mode !== "create" && value.ref_mode !== "update") ||
    record.external_identity !== `github:${value.repository}:${value.ref}`
  ) throw new Error(`${input.label} contains invalid task-ref push evidence`);
  return {
    record,
    repository: value.repository,
    ref: value.ref,
    sha: value.sha,
    ref_mode: value.ref_mode,
  };
}

export function exactConfirmedGithubPushDelivery(input: {
  records: readonly ExecutionRecord[];
  label: string;
  pipeline_run_id: string;
}): ConfirmedGithubPushDelivery | null {
  const pushes = [...new Map(
    input.records.filter(isGithubPushDelivery).map((record) => [record.id, record]),
  ).values()];
  if (pushes.length > 1) {
    throw new Error(`${input.label} contains multiple task-ref push deliveries`);
  }
  const record = pushes[0];
  return record
    ? parseConfirmedGithubPushDelivery({
      record,
      label: input.label,
      pipeline_run_id: input.pipeline_run_id,
    })
    : null;
}
