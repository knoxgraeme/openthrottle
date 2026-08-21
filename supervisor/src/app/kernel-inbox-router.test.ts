import { describe, expect, it, vi } from "vitest";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import { KernelInboxRouter } from "./kernel-inbox-router.js";

function event(overrides: Partial<KernelInboxEvent> = {}): KernelInboxEvent {
  return {
    id: "inbox-1",
    source_provider: "operator",
    delivery_id: "delivery-1",
    kind: "control/stop@1",
    work_item_id: "work-1",
    pipeline_run_id: "run-1",
    attempt_id: null,
    generation: 4,
    event_group_key: "control:run-1:stop:4",
    delivery_attempt: 1,
    subject: "a".repeat(40),
    payload_hash: "b".repeat(64),
    payload_schema: "openthrottle.operator-control/v1",
    payload: {
      schema: "openthrottle.operator-control/v1",
      pipeline_run_id: "run-1",
      action: "stop",
      cursor_version: 4,
      reason: "operator requested stop",
    },
    status: "processing",
    available_at: "2026-08-20T12:00:00.000Z",
    lease_id: "lease-1",
    lease_owner_id: "worker-1",
    lease_expires_at: "2026-08-20T12:02:00.000Z",
    version: 1,
    created_at: "2026-08-20T12:00:00.000Z",
    consumed_at: null,
    ...overrides,
  };
}

function router(input: {
  requestRunControl?: (request: {
    pipeline_run_id: string;
    action: "stop" | "supersede";
    reason: string;
  }) => Promise<{ disposition: "consumed" | "stale" }>;
  authorize?: () => Promise<any>;
  deliver?: () => Promise<void>;
  providerPrompt?: () => Promise<"consumed" | "stale" | "dead" | null>;
} = {}) {
  const admission = { handle: vi.fn(async () => "stale" as const) };
  const requestRunControl = vi.fn(input.requestRunControl ??
    (async () => ({ disposition: "consumed" as const })));
  const authorizeLeasedSteering = vi.fn(input.authorize ?? (async () => ({
    message_id: "message-1",
    source: "operator",
    body: "Focus on the failing test.",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    native_session_id: "session-1",
    generation: 0,
    policy: {
      phase: "work",
      repository_authority: "edit",
      result_only: false,
      allowed_tools: "attempt_profile",
      mcp: "attempt_profile",
      provider_access: "attempt_profile",
    },
  })));
  const deliverSteering = vi.fn(input.deliver ?? (async () => undefined));
  const handleProviderPrompt = vi.fn(input.providerPrompt ?? (async () => null));
  return {
    value: new KernelInboxRouter({
      admission,
      run_control: { requestRunControl },
      steering_authority: { authorizeLeasedSteering },
      steering_delivery: { deliverSteering },
      provider_prompts: { handle: handleProviderPrompt },
    }),
    admission,
    requestRunControl,
    authorizeLeasedSteering,
    deliverSteering,
    handleProviderPrompt,
  };
}

describe("KernelInboxRouter", () => {
  it("routes an exact operator control event to the shared run controller", async () => {
    const test = router();
    await expect(test.value.handle(event())).resolves.toBe("consumed");
    expect(test.requestRunControl).toHaveBeenCalledWith({
      pipeline_run_id: "run-1",
      action: "stop",
      reason: "operator requested stop",
    });
    expect(test.admission.handle).not.toHaveBeenCalled();
  });

  it("dead-letters malformed control authority without retrying it", async () => {
    const test = router();
    await expect(test.value.handle(event({
      payload: {
        schema: "openthrottle.operator-control/v1",
        pipeline_run_id: "another-run",
        action: "stop",
        cursor_version: 4,
        reason: "wrong fence",
      },
    }))).resolves.toBe("dead");
    expect(test.requestRunControl).not.toHaveBeenCalled();
  });

  it("authorizes and durably delivers steering before consuming it", async () => {
    const test = router();
    const steering = event({
      source_provider: "operator",
      kind: "steering/message@1",
      attempt_id: "attempt-1",
      payload_schema: "openthrottle.kernel-steering-envelope/v1",
      payload: {
        schema: "openthrottle.kernel-steering-envelope/v1",
        message_id: "message-1",
        source: "operator",
        body: "Focus on the failing test.",
        binding: {
          pipeline_run_id: "run-1",
          attempt_id: "attempt-1",
          request_hash: "c".repeat(64),
          definition_bundle_hash: "d".repeat(64),
          input_subject: "a".repeat(40),
          native_session_id: "session-1",
          generation: 0,
          lease_id: "lease-1",
          lease_generation: 0,
          lease_purpose: "work",
        },
      },
    });
    await expect(test.value.handle(steering)).resolves.toBe("consumed");
    expect(test.authorizeLeasedSteering).toHaveBeenCalledWith(steering);
    expect(test.deliverSteering).toHaveBeenCalledWith(expect.objectContaining({
      event_id: "inbox-1",
      delivery_id: "delivery-1",
    }));
  });

  it("settles a stale steering fence without redelivery", async () => {
    const test = router({
      authorize: async () => { throw new Error("steering lease_id binding is stale or mismatched"); },
    });
    await expect(test.value.handle(event({
      kind: "steering/message@1",
      payload_schema: "openthrottle.kernel-steering-envelope/v1",
      payload: { schema: "openthrottle.kernel-steering-envelope/v1" },
    }))).resolves.toBe("stale");
    expect(test.deliverSteering).not.toHaveBeenCalled();
  });

  it("routes a provider follow-up before admission", async () => {
    const test = router({ providerPrompt: async () => "consumed" });
    const prompted = event({
      source_provider: "linear",
      kind: "linear/agent-session-event/prompted@1",
    });
    await expect(test.value.handle(prompted)).resolves.toBe("consumed");
    expect(test.handleProviderPrompt).toHaveBeenCalledWith(prompted);
    expect(test.admission.handle).not.toHaveBeenCalled();
  });
});
