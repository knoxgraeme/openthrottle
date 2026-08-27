import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  type DeliveryRecord,
} from "@openthrottle/contracts";
import { exactStructuredRuntimeRecords } from "./kernel-structured-evidence.js";

const NOW = "2026-08-27T12:00:00.000Z";

function runtimeDelivery(slotIndex: number, kind: "create" | "start"): DeliveryRecord {
  const identity = String(slotIndex + 1).repeat(64);
  const sandboxId = `sandbox-${slotIndex + 1}`;
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-runtime-${kind}-${slotIndex}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-runtime-${kind}-${slotIndex}`,
    idempotency_key: `run-1:runtime:${kind}:${identity}`,
    external_identity: `daytona:${identity}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind}-sandbox@1`,
      provider: "daytona",
      result: {
        identity,
        sandbox_id: sandboxId,
        resource_state: kind === "create" ? "created" : "started",
      },
    } },
    created_at: NOW,
  };
}

describe("structured runtime evidence", () => {
  it("returns every canonical runtime-pool pair without widening unrelated context", () => {
    const pool = [
      runtimeDelivery(0, "create"),
      runtimeDelivery(0, "start"),
      runtimeDelivery(1, "create"),
      runtimeDelivery(1, "start"),
    ];
    const inputs = (records: readonly DeliveryRecord[]) => ({
      task_prompt: "Preserve the exact run-scoped runtime pool.",
      context: {
        records: new Map(records.map((record) => [record.id, record])),
        checkpoints: new Map(),
      },
    });

    const forward = exactStructuredRuntimeRecords(inputs(pool));
    const reversed = exactStructuredRuntimeRecords(inputs([...pool].reverse()));

    expect(reversed).toEqual(forward);
    expect(forward.map(({ id }) => id).sort()).toEqual(pool.map(({ id }) => id).sort());
  });
});
