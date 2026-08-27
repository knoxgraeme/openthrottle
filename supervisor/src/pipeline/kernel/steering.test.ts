import { describe, expect, it } from "vitest";
import {
  authorizeKernelSteeringDelivery,
  createKernelSteeringEnvelope,
  deriveKernelSteeringGeneration,
  type KernelRuntimeSessionBinding,
} from "./steering.js";

function binding(
  overrides: Partial<KernelRuntimeSessionBinding> = {},
): KernelRuntimeSessionBinding {
  return {
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "1".repeat(40),
    native_session_id: "session-1",
    scope: { kind: "stage", stage_id: "work" },
    generation: 0,
    attempt_status: "running",
    repository_authority: "edit",
    lease_id: "lease-1",
    lease_generation: 0,
    lease_worker_id: "worker-1",
    lease_purpose: "work",
    lease_expires_at: "2026-08-20T12:05:00.000Z",
    lease_started: true,
    ...overrides,
  };
}

describe("kernel steering", () => {
  it("authorizes only the exact durable attempt/run/session/generation fence", () => {
    const current = binding();
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-1",
      source: "operator",
      body: "Please also cover the restart case.",
      binding: current,
    });
    expect(authorizeKernelSteeringDelivery({ envelope, current_binding: current })).toMatchObject({
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      native_session_id: "session-1",
      scope: { kind: "stage", stage_id: "work" },
      generation: 0,
      lease_generation: 0,
      policy: {
        phase: "work",
        repository_authority: "edit",
        result_only: false,
        allowed_tools: "attempt_profile",
      },
    });

    for (const stale of [
      binding({ pipeline_run_id: "run-2" }),
      binding({ attempt_id: "attempt-2" }),
      binding({ native_session_id: "session-2" }),
      binding({ generation: 1 }),
      binding({ request_hash: "c".repeat(64) }),
      binding({ lease_id: "lease-2" }),
      binding({ lease_generation: 1 }),
    ]) {
      expect(() => authorizeKernelSteeringDelivery({ envelope, current_binding: stale }))
        .toThrow(/stale or mismatched/);
    }
  });

  it("keeps scoped slot affinity private while authorizing the durable Attempt scope", () => {
    const current = binding({
      attempt_id: "attempt-unit-2",
      scope: {
        kind: "loop_item",
        stage_id: "implement",
        parent_attempt_id: "attempt-plan",
        loop_id: "units",
        item_id: "unit-2",
        item_index: 1,
      },
    });
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-unit-2",
      source: "operator",
      body: "Continue in the original isolated runtime.",
      binding: current,
    });

    expect(envelope.binding).not.toHaveProperty("scope");
    expect(authorizeKernelSteeringDelivery({
      envelope,
      current_binding: current,
    }).scope).toEqual(current.scope);
  });

  it("keeps generation stable across renewal but changes it across phase ordinals", () => {
    const beforeRenewal = deriveKernelSteeringGeneration({
      attempt_version: 4,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      lease_purpose: "work",
    });
    const afterRenewal = deriveKernelSteeringGeneration({
      attempt_version: 5,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      lease_purpose: "work",
    });
    expect(afterRenewal).toBe(beforeRenewal);
    const current = binding({ generation: afterRenewal });
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-before-renewal",
      source: "operator",
      body: "Remain valid across heartbeat renewal.",
      binding: binding({ generation: beforeRenewal }),
    });
    expect(() => authorizeKernelSteeringDelivery({ envelope, current_binding: current }))
      .not.toThrow();

    const afterRetry = deriveKernelSteeringGeneration({
      attempt_version: 6,
      work_retry_ordinal: 1,
      result_correction_count: 0,
      lease_purpose: "work",
    });
    expect(afterRetry).not.toBe(beforeRenewal);
    expect(() => authorizeKernelSteeringDelivery({
      envelope,
      current_binding: binding({ generation: afterRetry }),
    })).toThrow(/generation.*stale or mismatched/);

    const firstCorrection = deriveKernelSteeringGeneration({
      attempt_version: 8,
      work_retry_ordinal: 1,
      result_correction_count: 1,
      lease_purpose: "result_correction",
    });
    const secondCorrection = deriveKernelSteeringGeneration({
      attempt_version: 10,
      work_retry_ordinal: 1,
      result_correction_count: 2,
      lease_purpose: "result_correction",
    });
    expect(secondCorrection).not.toBe(firstCorrection);
  });

  it("invalidates a queued envelope when recovery advances only the lease generation", () => {
    const beforeRecovery = binding({ generation: 0, lease_generation: 0 });
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-before-recovery",
      source: "operator",
      body: "This belongs only to the original lease owner.",
      binding: beforeRecovery,
    });

    expect(() => authorizeKernelSteeringDelivery({
      envelope,
      current_binding: binding({ generation: 0, lease_generation: 1 }),
    })).toThrow(/lease_generation.*stale or mismatched/);
  });

  it("fails closed before the runtime session is durably bound", () => {
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-1",
      source: "human",
      body: "Do not lose completed work.",
      binding: binding(),
    });
    expect(() => authorizeKernelSteeringDelivery({
      envelope,
      current_binding: null,
    })).toThrow(/no durable runtime session binding/);
  });

  it("preserves the reduced result-correction policy", () => {
    const correction = binding({
      attempt_status: "result_pending",
      lease_purpose: "result_correction",
      repository_authority: "edit",
    });
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-correction",
      source: "operator",
      body: "Return only the corrected semantic result.",
      binding: correction,
    });
    expect(authorizeKernelSteeringDelivery({
      envelope,
      current_binding: correction,
    }).policy).toEqual({
      phase: "result_correction",
      repository_authority: "inspect",
      result_only: true,
      allowed_tools: ["ot-result"],
      mcp: false,
      provider_access: false,
    });
  });

  it("rejects a session whose persisted attempt phase is no longer live", () => {
    expect(() => createKernelSteeringEnvelope({
      message_id: "message-stale",
      source: "operator",
      body: "stale",
      binding: binding({ attempt_status: "work_complete" }),
    })).toThrow(/not in its bound live phase/);
  });
});
