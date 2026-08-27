import { describe, expect, it } from "vitest";
import type { CompiledPipelineManifest, DeliveryRecord } from "@openthrottle/contracts";
import {
  exactKernelRuntimeAbsenceDelivery,
  exactKernelRuntimeAbsenceDeliveries,
  exactKernelRuntimeCleanupDeliveries,
  exactKernelRuntimeCleanupTargets,
  exactKernelRuntimeResourcePoolDeliveries,
  kernelRuntimePoolSize,
  kernelRuntimeResourceSlotIndex,
  resolveKernelRuntimeResourceIdentity,
  resolveKernelRuntimeResourcePool,
} from "./runtime-resource.js";

function delivery(
  kind: "create" | "start",
  sandboxId = "sandbox-1",
  identity = "a".repeat(64),
): DeliveryRecord {
  return {
    schema: "openthrottle.record/v1",
    id: `delivery-${kind}-${identity[0]}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${kind}-${identity[0]}`,
    idempotency_key: `run-1:${kind}:${identity}`,
    external_identity: `daytona:${sandboxId}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: `daytona/${kind}-sandbox@1`,
        provider: "daytona",
        observed_via: "reconciliation",
        result: { identity, sandbox_id: sandboxId },
      },
    },
    created_at: "2026-08-20T12:00:00.000Z",
  };
}

function absentCreate(): DeliveryRecord {
  return {
    ...delivery("create"),
    id: "delivery-create-absent-a",
    status: "rejected",
    payload: { inline: {
      effect_kind: "daytona/create-sandbox@1",
      provider: "daytona",
      observed_via: "reconciliation",
      result: { identity: "a".repeat(64), resource_state: "absent" },
    } },
  };
}

describe("kernel runtime resource context", () => {
  it("derives one bounded fixed pool width from the exact compiled manifest", () => {
    const manifest = (widths: readonly number[]): CompiledPipelineManifest => ({
      schema: "openthrottle.compiled-pipeline-manifest/v1",
      pipeline_id: "core/test",
      pipeline_version: 1,
      entry_stage: "stage-0",
      definition_bundle_hash: "b".repeat(64),
      compiler_version: "definition-compiler/v1",
      runtime_capability_digest: "c".repeat(64),
      stages: (widths.length === 0 ? [undefined] : widths).map((width, index) => ({
        id: `stage-${index}`,
        kind: "effect" as const,
        effect: "core/test@1",
        ...(width === undefined ? {} : { loop: {
          over: "execution_plan.units",
          max_parallel: width,
          max_rounds: 1,
          body: [`stage-${index}`],
        } }),
        on: { success: { terminal: "completed" as const } },
      })),
    });

    expect(kernelRuntimePoolSize(manifest([]))).toBe(1);
    expect(kernelRuntimePoolSize(manifest([2, 5, 3]))).toBe(5);
    expect(() => kernelRuntimePoolSize(manifest([17]))).toThrow(/between 1 and 16/i);
  });

  it("derives one reconciled sandbox identity from exact create/start DeliveryRecords", () => {
    expect(resolveKernelRuntimeResourceIdentity([delivery("start"), delivery("create")])).toEqual({
      provider: "daytona",
      provider_resource_id: "sandbox-1",
      delivery_record_ids: ["delivery-create-a", "delivery-start-a"],
    });
  });

  it("fails closed on an incomplete or conflicting resource identity", () => {
    expect(() => resolveKernelRuntimeResourceIdentity([delivery("create")]))
      .toThrow(/exactly one.*pair/i);
    expect(() => resolveKernelRuntimeResourceIdentity([
      delivery("create", "sandbox-1"),
      delivery("start", "sandbox-2", "a".repeat(64)),
    ])).toThrow(/different sandboxes/i);
  });

  it("recovers a canonical complete pool and selects distinct slots from Attempt scope", () => {
    const identityA = "a".repeat(64);
    const identityB = "b".repeat(64);
    const records = [
      delivery("start", "sandbox-b", identityB),
      delivery("create", "sandbox-b", identityB),
      delivery("start", "sandbox-a", identityA),
      delivery("create", "sandbox-a", identityA),
    ];

    expect(resolveKernelRuntimeResourcePool(records)).toEqual({
      pool_size: 2,
      slots: [
        {
          slot_index: 0,
          runtime_identity: identityA,
          provider: "daytona",
          provider_resource_id: "sandbox-a",
          delivery_record_ids: ["delivery-create-a", "delivery-start-a"],
        },
        {
          slot_index: 1,
          runtime_identity: identityB,
          provider: "daytona",
          provider_resource_id: "sandbox-b",
          delivery_record_ids: ["delivery-create-b", "delivery-start-b"],
        },
      ],
    });
    expect(exactKernelRuntimeResourcePoolDeliveries(records)?.map(({ id }) => id)).toEqual([
      "delivery-create-a", "delivery-start-a", "delivery-create-b", "delivery-start-b",
    ]);
    expect(kernelRuntimeResourceSlotIndex({
      kind: "loop_item",
      stage_id: "unit",
      parent_attempt_id: "parent",
      loop_id: "units",
      item_id: "unit-3",
      item_index: 3,
    }, 2)).toBe(1);
    expect(kernelRuntimeResourceSlotIndex({
      kind: "fanout_member",
      stage_id: "review",
      parent_attempt_id: "parent",
      fanout_id: "reviews",
      member_id: "security",
      member_index: 4,
    }, 2)).toBe(0);
    expect(resolveKernelRuntimeResourceIdentity(records, {
      kind: "loop_item",
      stage_id: "unit",
      parent_attempt_id: "parent",
      loop_id: "units",
      item_id: "unit-1",
      item_index: 1,
    })).toEqual({
      provider: "daytona",
      provider_resource_id: "sandbox-b",
      delivery_record_ids: ["delivery-create-b", "delivery-start-b"],
    });
    expect(Object.keys(resolveKernelRuntimeResourceIdentity(records, {
      kind: "loop_item",
      stage_id: "unit",
      parent_attempt_id: "parent",
      loop_id: "units",
      item_id: "unit-1",
      item_index: 1,
    })!).sort()).toEqual(["delivery_record_ids", "provider", "provider_resource_id"]);
    expect(() => resolveKernelRuntimeResourceIdentity(records)).toThrow(/scope.*pool/i);
  });

  it("rejects cross-identity pairs and one provider sandbox reused by multiple identities", () => {
    const identityA = "a".repeat(64);
    const identityB = "b".repeat(64);
    expect(() => resolveKernelRuntimeResourcePool([
      delivery("create", "sandbox-a", identityA),
      delivery("start", "sandbox-a", identityB),
    ])).toThrow(/exactly one confirmed.*pair/i);
    expect(() => resolveKernelRuntimeResourcePool([
      delivery("create", "sandbox-shared", identityA),
      delivery("start", "sandbox-shared", identityA),
      delivery("create", "sandbox-shared", identityB),
      delivery("start", "sandbox-shared", identityB),
    ])).toThrow(/one sandbox.*multiple slots/i);
  });

  it("uses confirmed create as cleanup authority even when start was rejected", () => {
    const rejectedStart = { ...delivery("start"), status: "rejected" as const };
    expect(exactKernelRuntimeCleanupDeliveries([rejectedStart, delivery("create")])?.map(({ id }) => id))
      .toEqual(["delivery-create-a", "delivery-start-a"]);
    expect(() => exactKernelRuntimeCleanupDeliveries([delivery("create"), delivery("create")]))
      .toThrow(/exactly one confirmed.*create/i);
  });

  it("includes every confirmed-created pool target in canonical cleanup evidence", () => {
    const identityA = "a".repeat(64);
    const identityB = "b".repeat(64);
    const rejectedStart = {
      ...delivery("start", "sandbox-b", identityB),
      status: "rejected" as const,
    };
    const records = [
      rejectedStart,
      delivery("create", "sandbox-b", identityB),
      delivery("start", "sandbox-a", identityA),
      delivery("create", "sandbox-a", identityA),
    ];

    expect(exactKernelRuntimeCleanupTargets(records)).toEqual([
      {
        runtime_identity: identityA,
        provider_resource_id: "sandbox-a",
        delivery_records: [delivery("create", "sandbox-a", identityA), delivery("start", "sandbox-a", identityA)],
      },
      {
        runtime_identity: identityB,
        provider_resource_id: "sandbox-b",
        delivery_records: [delivery("create", "sandbox-b", identityB), rejectedStart],
      },
    ]);
    expect(exactKernelRuntimeCleanupDeliveries(records)?.map(({ id }) => id)).toEqual([
      "delivery-create-a", "delivery-start-a", "delivery-create-b", "delivery-start-b",
    ]);

    expect(exactKernelRuntimeCleanupTargets([
      ...records,
      {
        ...absentCreate(),
        id: "delivery-create-absent-c",
        payload: { inline: {
          effect_kind: "daytona/create-sandbox@1",
          provider: "daytona",
          observed_via: "reconciliation",
          result: { identity: "c".repeat(64), resource_state: "absent" },
        } },
      },
    ])?.map(({ runtime_identity }) => runtime_identity)).toEqual([identityA, identityB]);
  });

  it("accepts only explicit rejected-create absence proof", () => {
    expect(exactKernelRuntimeAbsenceDelivery([absentCreate()])?.id).toBe("delivery-create-absent-a");
    const second = {
      ...absentCreate(),
      id: "delivery-create-absent-b",
      effect_id: "effect-create-b",
      idempotency_key: `run-1:create:${"b".repeat(64)}`,
      payload: { inline: {
        effect_kind: "daytona/create-sandbox@1",
        provider: "daytona",
        observed_via: "reconciliation",
        result: { identity: "b".repeat(64), resource_state: "absent" },
      } },
    } satisfies DeliveryRecord;
    expect(exactKernelRuntimeAbsenceDeliveries([second, absentCreate()])?.map(({ id }) => id))
      .toEqual(["delivery-create-absent-a", "delivery-create-absent-b"]);
    expect(() => exactKernelRuntimeAbsenceDelivery([second, absentCreate()]))
      .toThrow(/singleton/i);
    expect(() => exactKernelRuntimeAbsenceDelivery([
      { ...absentCreate(), payload: { inline: {
        effect_kind: "daytona/create-sandbox@1",
        provider: "daytona",
        observed_via: "reconciliation",
        result: { identity: "a".repeat(64), reason: "permission_denied" },
      } } },
    ])).toThrow(/resource_state absent/i);
  });
});
