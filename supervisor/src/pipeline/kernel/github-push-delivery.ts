import {
  validateGithubPushDelivery,
  type DeliveryRecord,
  type ExecutionRecord,
  type GithubPushDelivery,
} from "@openthrottle/contracts";

type ConfirmedGithubPushDeliveryEvidence = Extract<
  GithubPushDelivery,
  { reason?: never }
>;

export type ConfirmedGithubPushDelivery = ConfirmedGithubPushDeliveryEvidence & {
  record: DeliveryRecord;
};

export function isGithubPushDelivery(record: ExecutionRecord): record is DeliveryRecord & {
  payload: { inline: Record<string, unknown> };
} {
  return record.kind === "delivery" &&
    record.payload_schema === "openthrottle.effect-delivery/v1" &&
    "inline" in record.payload && record.payload.inline !== null &&
    typeof record.payload.inline === "object" && !Array.isArray(record.payload.inline) &&
    record.payload.inline.effect_kind === "github/push-checkpoint@1";
}

export function parseConfirmedGithubPushDelivery(input: {
  record: ExecutionRecord;
  label: string;
  pipeline_run_id: string;
}): ConfirmedGithubPushDelivery {
  const { record } = input;
  if (!isGithubPushDelivery(record)) {
    throw new Error(`${input.label} is not task-ref push evidence`);
  }
  const envelope = record.payload.inline;
  if (
    record.pipeline_run_id !== input.pipeline_run_id || record.status !== "confirmed" ||
    envelope.provider !== "github"
  ) throw new Error(`${input.label} contains invalid task-ref push evidence`);
  let value: GithubPushDelivery;
  try {
    value = validateGithubPushDelivery(envelope.result, {
      source: `${input.label}.result`,
    }).value;
  } catch {
    throw new Error(`${input.label} contains invalid task-ref push evidence`);
  }
  if (
    "reason" in value ||
    record.external_identity !== `github:${value.repository}:${value.ref}`
  ) throw new Error(`${input.label} contains invalid task-ref push evidence`);
  return {
    record,
    ...value,
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
