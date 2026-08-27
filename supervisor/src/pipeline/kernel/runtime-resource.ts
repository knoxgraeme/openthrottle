import {
  compareCodeUnits,
  type CompiledPipelineManifest,
  type DeliveryRecord,
  type ExecutionRecord,
} from "@openthrottle/contracts";
import type { AttemptScope } from "./types.js";

export const MAX_KERNEL_RUNTIME_POOL_SIZE = 16;

/** Derives the fixed run-scoped pool width from one exact compiled manifest. */
export function kernelRuntimePoolSize(
  manifest: Readonly<CompiledPipelineManifest>,
): number {
  const poolSize = Math.max(1, ...manifest.stages.map((stage) => stage.loop?.max_parallel ?? 1));
  if (
    !Number.isSafeInteger(poolSize) || poolSize < 1 ||
    poolSize > MAX_KERNEL_RUNTIME_POOL_SIZE
  ) {
    throw new Error(
      `compiled runtime pool size must be between 1 and ${MAX_KERNEL_RUNTIME_POOL_SIZE}`,
    );
  }
  return poolSize;
}

/** The exact wire-facing sandbox reference. Keep this shape intentionally small. */
export interface KernelRuntimeResourceIdentity {
  provider: "daytona";
  provider_resource_id: string;
  delivery_record_ids: readonly [string, string];
}

/** Supervisor-private slot evidence. It must never be copied into the runtime wire request. */
export interface KernelRuntimeResourceSlot extends KernelRuntimeResourceIdentity {
  slot_index: number;
  runtime_identity: string;
}

export interface KernelRuntimeResourcePool {
  pool_size: number;
  slots: readonly KernelRuntimeResourceSlot[];
}

export interface KernelRuntimeCleanupTarget {
  runtime_identity: string;
  provider_resource_id: string;
  delivery_records: readonly DeliveryRecord[];
}

interface DaytonaResourceObservation {
  effect_kind: "daytona/create-sandbox@1" | "daytona/start-sandbox@1";
  runtime_identity: string;
  sandbox_id: string | null;
  resource_state: string | null;
}

interface DaytonaResourceEvidence {
  record: DeliveryRecord;
  observation: DaytonaResourceObservation;
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
  const runtimeIdentity = typeof result.identity === "string" &&
      /^[a-f0-9]{64}$/.test(result.identity)
    ? result.identity
    : null;
  if (runtimeIdentity === null) {
    throw new Error(`runtime resource DeliveryRecord ${record.id} has no runtime identity`);
  }
  const sandboxId = typeof result.sandbox_id === "string" && result.sandbox_id.length > 0
    ? result.sandbox_id
    : null;
  if (record.status === "confirmed" && sandboxId === null) {
    throw new Error(`runtime resource DeliveryRecord ${record.id} has no sandbox identity`);
  }
  return {
    effect_kind: payload.effect_kind,
    runtime_identity: runtimeIdentity,
    sandbox_id: sandboxId,
    resource_state: typeof result.resource_state === "string" ? result.resource_state : null,
  };
}

function runtimeEvidence(records: readonly ExecutionRecord[]): DaytonaResourceEvidence[] {
  return records.flatMap((record) => {
    if (record.kind !== "delivery") return [];
    const observation = daytonaObservation(record);
    return observation === null ? [] : [{ record, observation }];
  });
}

function evidenceByRuntimeIdentity(
  records: readonly ExecutionRecord[],
): Map<string, DaytonaResourceEvidence[]> | null {
  const evidence = runtimeEvidence(records);
  if (evidence.length === 0) return null;
  const grouped = new Map<string, DaytonaResourceEvidence[]>();
  for (const entry of evidence) {
    const members = grouped.get(entry.observation.runtime_identity) ?? [];
    members.push(entry);
    grouped.set(entry.observation.runtime_identity, members);
  }
  return new Map([...grouped].sort(([left], [right]) => compareCodeUnits(left, right)));
}

function resourceSlotFor(
  entries: readonly DaytonaResourceEvidence[],
  slotIndex: number,
): KernelRuntimeResourceSlot {
  const creates = entries.filter(({ observation }) =>
    observation.effect_kind === "daytona/create-sandbox@1");
  const starts = entries.filter(({ observation }) =>
    observation.effect_kind === "daytona/start-sandbox@1");
  if (
    creates.length !== 1 || starts.length !== 1 ||
    creates[0]!.record.status !== "confirmed" || starts[0]!.record.status !== "confirmed"
  ) {
    throw new Error(
      "sealed Attempt context must contain exactly one confirmed Daytona create/start delivery pair per runtime identity",
    );
  }
  const createIdentity = creates[0]!.observation;
  const startIdentity = starts[0]!.observation;
  if (createIdentity.sandbox_id !== startIdentity.sandbox_id) {
    throw new Error("Daytona create/start deliveries identify different sandboxes");
  }
  return {
    slot_index: slotIndex,
    runtime_identity: createIdentity.runtime_identity,
    provider: "daytona",
    provider_resource_id: createIdentity.sandbox_id!,
    delivery_record_ids: [creates[0]!.record.id, starts[0]!.record.id]
      .sort(compareCodeUnits) as [string, string],
  };
}

/** Resolves the complete fixed pool only from exact, sealed DeliveryRecords. */
export function resolveKernelRuntimeResourcePool(
  records: readonly ExecutionRecord[],
): KernelRuntimeResourcePool | null {
  const grouped = evidenceByRuntimeIdentity(records);
  if (grouped === null) return null;
  if (grouped.size > MAX_KERNEL_RUNTIME_POOL_SIZE) {
    throw new Error(`runtime resource pool exceeds ${MAX_KERNEL_RUNTIME_POOL_SIZE} slots`);
  }
  const slots = [...grouped.values()].map((entries, slotIndex) =>
    resourceSlotFor(entries, slotIndex));
  const sandboxIds = slots.map(({ provider_resource_id }) => provider_resource_id);
  if (new Set(sandboxIds).size !== sandboxIds.length) {
    throw new Error("Daytona runtime pool assigns one sandbox to multiple slots");
  }
  return { pool_size: slots.length, slots };
}

export function kernelRuntimeResourceSlotIndex(
  scope: AttemptScope,
  poolSize: number,
): number {
  if (
    !Number.isSafeInteger(poolSize) || poolSize < 1 ||
    poolSize > MAX_KERNEL_RUNTIME_POOL_SIZE
  ) throw new Error("runtime resource pool size is outside its sealed bound");
  if (scope.kind === "stage") return 0;
  const memberIndex = scope.kind === "loop_item" ? scope.item_index : scope.member_index;
  if (!Number.isSafeInteger(memberIndex) || memberIndex < 0) {
    throw new Error("runtime resource scope has an invalid member index");
  }
  return memberIndex % poolSize;
}

/** Returns supervisor-private slot evidence for an exact Attempt scope. */
export function resolveKernelRuntimeResourceSlot(
  records: readonly ExecutionRecord[],
  scope?: AttemptScope,
): KernelRuntimeResourceSlot | null {
  const pool = resolveKernelRuntimeResourcePool(records);
  if (pool === null) return null;
  if (scope === undefined && pool.pool_size !== 1) {
    throw new Error("runtime resource scope is required to select from a multi-slot pool");
  }
  return pool.slots[scope === undefined ? 0 : kernelRuntimeResourceSlotIndex(scope, pool.pool_size)]!;
}

/** Resolves one stripped wire identity without leaking supervisor-private slot fields. */
export function resolveKernelRuntimeResourceIdentity(
  records: readonly ExecutionRecord[],
  scope?: AttemptScope,
): KernelRuntimeResourceIdentity | null {
  const slot = resolveKernelRuntimeResourceSlot(records, scope);
  if (slot === null) return null;
  return {
    provider: slot.provider,
    provider_resource_id: slot.provider_resource_id,
    delivery_record_ids: slot.delivery_record_ids,
  };
}

/** Returns every verified create/start pair in canonical slot and lifecycle order. */
export function exactKernelRuntimeResourcePoolDeliveries(
  records: readonly ExecutionRecord[],
): readonly DeliveryRecord[] | null {
  const pool = resolveKernelRuntimeResourcePool(records);
  if (pool === null) return null;
  const evidence = runtimeEvidence(records);
  return pool.slots.flatMap((slot) => {
    const entries = evidence.filter(({ observation }) =>
      observation.runtime_identity === slot.runtime_identity);
    const create = entries.find(({ observation }) =>
      observation.effect_kind === "daytona/create-sandbox@1")!.record;
    const start = entries.find(({ observation }) =>
      observation.effect_kind === "daytona/start-sandbox@1")!.record;
    return [create, start];
  });
}

/** Returns only the verified pair selected for one Attempt scope. */
export function exactKernelRuntimeResourceDeliveries(
  records: readonly ExecutionRecord[],
  scope?: AttemptScope,
): readonly [DeliveryRecord, DeliveryRecord] | null {
  const slot = resolveKernelRuntimeResourceSlot(records, scope);
  if (slot === null) return null;
  const entries = runtimeEvidence(records).filter(({ observation }) =>
    observation.runtime_identity === slot.runtime_identity);
  return [
    entries.find(({ observation }) =>
      observation.effect_kind === "daytona/create-sandbox@1")!.record,
    entries.find(({ observation }) =>
      observation.effect_kind === "daytona/start-sandbox@1")!.record,
  ];
}

/**
 * Returns every exact target proven to exist by a confirmed create. A start
 * delivery is retained when present, even when it was rejected.
 */
export function exactKernelRuntimeCleanupTargets(
  records: readonly ExecutionRecord[],
): readonly KernelRuntimeCleanupTarget[] | null {
  const grouped = evidenceByRuntimeIdentity(records);
  if (grouped === null) return null;
  if (grouped.size > MAX_KERNEL_RUNTIME_POOL_SIZE) {
    throw new Error(`runtime cleanup target pool exceeds ${MAX_KERNEL_RUNTIME_POOL_SIZE} slots`);
  }
  const targets: KernelRuntimeCleanupTarget[] = [];
  for (const [runtimeIdentity, entries] of grouped) {
    const creates = entries.filter(({ observation }) =>
      observation.effect_kind === "daytona/create-sandbox@1");
    const starts = entries.filter(({ observation }) =>
      observation.effect_kind === "daytona/start-sandbox@1");
    if (creates.length !== 1 || starts.length > 1) {
      throw new Error(
        "sealed Attempt context must contain exactly one confirmed Daytona create delivery per runtime identity",
      );
    }
    const create = creates[0]!;
    if (create.record.status !== "confirmed") {
      if (starts.length > 0) {
        throw new Error("Daytona start delivery has no confirmed create authority");
      }
      continue;
    }
    const sandboxId = create.observation.sandbox_id!;
    const startId = starts[0]?.observation.sandbox_id;
    if (startId !== null && startId !== undefined && startId !== sandboxId) {
      throw new Error("Daytona create/start deliveries identify different sandboxes");
    }
    targets.push({
      runtime_identity: runtimeIdentity,
      provider_resource_id: sandboxId,
      delivery_records: [create.record, ...starts.map(({ record }) => record)],
    });
  }
  if (targets.length === 0) return null;
  const sandboxIds = targets.map(({ provider_resource_id }) => provider_resource_id);
  if (new Set(sandboxIds).size !== sandboxIds.length) {
    throw new Error("Daytona runtime cleanup assigns one sandbox to multiple targets");
  }
  return targets;
}

/** Flattens all confirmed-created targets in canonical target and lifecycle order. */
export function exactKernelRuntimeCleanupDeliveries(
  records: readonly ExecutionRecord[],
): readonly DeliveryRecord[] | null {
  return exactKernelRuntimeCleanupTargets(records)?.flatMap(({ delivery_records }) =>
    delivery_records) ?? null;
}

/** Every create must be an explicit rejected/absent observation to prove no pool exists. */
export function exactKernelRuntimeAbsenceDeliveries(
  records: readonly ExecutionRecord[],
): readonly DeliveryRecord[] | null {
  const grouped = evidenceByRuntimeIdentity(records);
  if (grouped === null) return null;
  const creates = [...grouped.values()].flatMap((entries) => entries.filter(({ observation }) =>
    observation.effect_kind === "daytona/create-sandbox@1"));
  const starts = [...grouped.values()].flatMap((entries) => entries.filter(({ observation }) =>
    observation.effect_kind === "daytona/start-sandbox@1"));
  if (creates.length === 0) {
    throw new Error("Daytona absence proof has no create delivery");
  }
  if (creates.some(({ record }) => record.status === "confirmed")) return null;
  if (starts.length > 0 || creates.length !== grouped.size) {
    throw new Error("Daytona absence proof has duplicate or dependent runtime evidence");
  }
  if (creates.some(({ record, observation }) =>
    record.status !== "rejected" || observation.resource_state !== "absent")) {
    throw new Error("Daytona absence requires rejected create deliveries with resource_state absent");
  }
  return creates.sort((left, right) =>
    compareCodeUnits(left.observation.runtime_identity, right.observation.runtime_identity))
    .map(({ record }) => record);
}

/** Backward-compatible singleton absence proof; pooled callers must cite the full roster. */
export function exactKernelRuntimeAbsenceDelivery(
  records: readonly ExecutionRecord[],
): DeliveryRecord | null {
  const deliveries = exactKernelRuntimeAbsenceDeliveries(records);
  if (deliveries === null) return null;
  if (deliveries.length !== 1) {
    throw new Error("Daytona singleton absence helper cannot represent a runtime pool");
  }
  return deliveries[0]!;
}
