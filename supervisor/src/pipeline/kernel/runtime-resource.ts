import {
  compareCodeUnits,
  type DeliveryRecord,
  type ExecutionRecord,
} from "@openthrottle/contracts";

export interface KernelRuntimeResourceIdentity {
  provider: "daytona";
  provider_resource_id: string;
  delivery_record_ids: readonly [string, string];
}

interface DaytonaResourceObservation {
  effect_kind: "daytona/create-sandbox@1" | "daytona/start-sandbox@1";
  sandbox_id: string | null;
  resource_state: string | null;
}

function daytonaObservation(
  record: DeliveryRecord,
): DaytonaResourceObservation | null {
  if (
    record.payload_schema !== "openthrottle.effect-delivery/v1" ||
    !("inline" in record.payload)
  ) return null;
  const payload = record.payload.inline;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (
    payload.effect_kind !== "daytona/create-sandbox@1" &&
    payload.effect_kind !== "daytona/start-sandbox@1"
  ) return null;
  if (payload.provider !== "daytona") {
    throw new Error(`runtime resource DeliveryRecord ${record.id} has another provider`);
  }
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`runtime resource DeliveryRecord ${record.id} has no result object`);
  }
  const sandboxId = typeof result.sandbox_id === "string" && result.sandbox_id.length > 0
    ? result.sandbox_id
    : null;
  if (record.status === "confirmed" && sandboxId === null) {
    throw new Error(`runtime resource DeliveryRecord ${record.id} has no sandbox identity`);
  }
  return {
    effect_kind: payload.effect_kind,
    sandbox_id: sandboxId,
    resource_state: typeof result.resource_state === "string" ? result.resource_state : null,
  };
}

/** Resolves one sandbox only from exact, sealed DeliveryRecords. */
export function resolveKernelRuntimeResourceIdentity(
  records: readonly ExecutionRecord[],
): KernelRuntimeResourceIdentity | null {
  const pair = exactKernelRuntimeResourceDeliveries(records);
  if (pair === null) return null;
  const [create, start] = pair;
  const createIdentity = daytonaObservation(create)!;
  const startIdentity = daytonaObservation(start)!;
  if (createIdentity.sandbox_id !== startIdentity.sandbox_id) {
    throw new Error("Daytona create/start deliveries identify different sandboxes");
  }
  return {
    provider: "daytona",
    provider_resource_id: createIdentity.sandbox_id!,
    delivery_record_ids: [create.id, start.id].sort() as [string, string],
  };
}

/** Returns only the verified resource pair; unrelated evidence is not widened. */
export function exactKernelRuntimeResourceDeliveries(
  records: readonly ExecutionRecord[],
): readonly [DeliveryRecord, DeliveryRecord] | null {
  const matches = records.flatMap((record) => {
    if (record.kind !== "delivery") return [];
    const identity = daytonaObservation(record);
    return identity === null || record.status !== "confirmed" ? [] : [{ record, identity }];
  });
  if (matches.length === 0) return null;
  const creates = matches.filter(({ identity }) => identity.effect_kind === "daytona/create-sandbox@1");
  const starts = matches.filter(({ identity }) => identity.effect_kind === "daytona/start-sandbox@1");
  if (creates.length !== 1 || starts.length !== 1) {
    throw new Error("sealed Attempt context must contain exactly one Daytona create/start delivery pair");
  }
  if (creates[0]!.identity.sandbox_id !== starts[0]!.identity.sandbox_id) {
    throw new Error("Daytona create/start deliveries identify different sandboxes");
  }
  return [creates[0]!.record, starts[0]!.record];
}

/**
 * Returns the smallest exact evidence set that proves a sandbox exists and
 * therefore must pass through stop + cleanup. A confirmed create is
 * sufficient even when start was definitively rejected.
 */
export function exactKernelRuntimeCleanupDeliveries(
  records: readonly ExecutionRecord[],
): readonly DeliveryRecord[] | null {
  const matches = records.flatMap((record) => {
    if (record.kind !== "delivery") return [];
    const observation = daytonaObservation(record);
    return observation === null ? [] : [{ record, observation }];
  });
  if (matches.length === 0) return null;
  const creates = matches.filter(({ observation }) =>
    observation.effect_kind === "daytona/create-sandbox@1");
  const starts = matches.filter(({ observation }) =>
    observation.effect_kind === "daytona/start-sandbox@1");
  if (creates.length !== 1 || creates[0]!.record.status !== "confirmed" || starts.length > 1) {
    throw new Error("sealed Attempt context must contain exactly one confirmed Daytona create delivery");
  }
  const sandboxId = creates[0]!.observation.sandbox_id!;
  const startId = starts[0]?.observation.sandbox_id;
  if (startId !== null && startId !== undefined && startId !== sandboxId) {
    throw new Error("Daytona create/start deliveries identify different sandboxes");
  }
  return [creates[0]!.record, ...starts.map(({ record }) => record)]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

/** A rejected create is absence proof only when the adapter said so exactly. */
export function exactKernelRuntimeAbsenceDelivery(
  records: readonly ExecutionRecord[],
): DeliveryRecord | null {
  const matches = records.flatMap((record) => {
    if (record.kind !== "delivery") return [];
    const observation = daytonaObservation(record);
    return observation?.effect_kind === "daytona/create-sandbox@1"
      ? [{ record, observation }]
      : [];
  });
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 || matches[0]!.record.status !== "rejected" ||
    matches[0]!.observation.resource_state !== "absent"
  ) {
    throw new Error("Daytona absence requires one rejected create delivery with resource_state absent");
  }
  return matches[0]!.record;
}
