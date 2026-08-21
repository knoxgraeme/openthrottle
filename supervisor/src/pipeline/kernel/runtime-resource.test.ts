import { describe, expect, it } from "vitest";
import type { DeliveryRecord } from "@openthrottle/contracts";
import {
  exactKernelRuntimeAbsenceDelivery,
  exactKernelRuntimeCleanupDeliveries,
  resolveKernelRuntimeResourceIdentity,
} from "./runtime-resource.js";

function delivery(kind: "create" | "start", sandboxId = "sandbox-1"): DeliveryRecord {
  return {
    schema: "openthrottle.record/v1",
    id: `delivery-${kind}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${kind}`,
    idempotency_key: `run-1:${kind}`,
    external_identity: `daytona:${sandboxId}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: {
      inline: {
        effect_kind: `daytona/${kind}-sandbox@1`,
        provider: "daytona",
        observed_via: "reconciliation",
        result: { sandbox_id: sandboxId },
      },
    },
    created_at: "2026-08-20T12:00:00.000Z",
  };
}

function absentCreate(): DeliveryRecord {
  return {
    ...delivery("create"),
    id: "delivery-create-absent",
    status: "rejected",
    payload: { inline: {
      effect_kind: "daytona/create-sandbox@1",
      provider: "daytona",
      observed_via: "reconciliation",
      result: { resource_state: "absent" },
    } },
  };
}

describe("kernel runtime resource context", () => {
  it("derives one reconciled sandbox identity from exact create/start DeliveryRecords", () => {
    expect(resolveKernelRuntimeResourceIdentity([delivery("start"), delivery("create")])).toEqual({
      provider: "daytona",
      provider_resource_id: "sandbox-1",
      delivery_record_ids: ["delivery-create", "delivery-start"],
    });
  });

  it("fails closed on an incomplete or conflicting resource identity", () => {
    expect(() => resolveKernelRuntimeResourceIdentity([delivery("create")]))
      .toThrow(/exactly one.*pair/i);
    expect(() => resolveKernelRuntimeResourceIdentity([
      delivery("create", "sandbox-1"),
      delivery("start", "sandbox-2"),
    ])).toThrow(/different sandboxes/i);
  });

  it("uses confirmed create as cleanup authority even when start was rejected", () => {
    const rejectedStart = { ...delivery("start"), status: "rejected" as const };
    expect(exactKernelRuntimeCleanupDeliveries([rejectedStart, delivery("create")])?.map(({ id }) => id))
      .toEqual(["delivery-create", "delivery-start"]);
    expect(() => exactKernelRuntimeCleanupDeliveries([delivery("create"), delivery("create")]))
      .toThrow(/exactly one confirmed.*create/i);
  });

  it("accepts only explicit rejected-create absence proof", () => {
    expect(exactKernelRuntimeAbsenceDelivery([absentCreate()])?.id).toBe("delivery-create-absent");
    expect(() => exactKernelRuntimeAbsenceDelivery([
      { ...absentCreate(), payload: { inline: {
        effect_kind: "daytona/create-sandbox@1",
        provider: "daytona",
        observed_via: "reconciliation",
        result: { reason: "permission_denied" },
      } } },
    ])).toThrow(/resource_state absent/i);
  });
});
