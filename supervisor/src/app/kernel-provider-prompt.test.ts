import { describe, expect, it, vi } from "vitest";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelStatusProjection } from "../persistence/kernel-projection-store.js";
import { KernelProviderPromptHandler } from "./kernel-provider-prompt.js";

function event(overrides: Partial<KernelInboxEvent> = {}): KernelInboxEvent {
  return {
    id: "inbox-provider-1",
    source_provider: "linear",
    delivery_id: "linear-delivery-1",
    kind: "linear/agent-session-event/prompted@1",
    work_item_id: null,
    pipeline_run_id: null,
    attempt_id: null,
    generation: 0,
    event_group_key: "linear:delivery-1",
    delivery_attempt: 1,
    subject: null,
    payload_hash: "b".repeat(64),
    payload_schema: "openthrottle.provider-event/linear/v1",
    payload: {
      agentSession: { issue: { identifier: "OPE-188" } },
      agentActivity: {
        id: "activity-1",
        content: { body: "Please focus on the failing contract." },
      },
    },
    status: "processing",
    available_at: "2026-08-20T12:00:00.000Z",
    lease_id: "lease-inbox-1",
    lease_owner_id: "worker-1",
    lease_expires_at: "2026-08-20T12:02:00.000Z",
    version: 1,
    created_at: "2026-08-20T12:00:00.000Z",
    consumed_at: null,
    ...overrides,
  };
}

function status(overrides: Partial<KernelStatusProjection> = {}): KernelStatusProjection {
  return {
    pipeline_run_id: "run-1",
    work_item_id: "work-1",
    source_provider: "linear",
    source_reference: "OPE-188",
    title: "Repair schema handling",
    pipeline_id: "core/implement",
    status: "running",
    terminal_outcome: null,
    stage_id: "implement",
    cursor_version: 4,
    current_subject: "a".repeat(40),
    definition_bundle_hash: "b".repeat(64),
    whose_move: "working",
    attempt_status_counts: {
      pending: 0, running: 1, work_complete: 0, result_pending: 0, recorded: 0,
      settled: 0, needs_human: 0, failed: 0, canceled: 0, superseded: 0,
    },
    effect_status_counts: {
      pending: 0, processing: 0, unknown: 0, acknowledged: 0,
      rejected: 0, canceled: 0, failed: 0,
    },
    attempts: [{
      id: "attempt-1",
      scope_kind: "stage",
      stage_id: "implement",
      status: "running",
      repository_authority: "edit",
      input_subject: "a".repeat(40),
      output_subject: null,
      native_session_bound: true,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      result_correction_deadline: null,
      pending_diagnostic_count: 0,
      lease_purpose: "work",
      lease_expires_at: "2026-08-20T12:02:00.000Z",
      updated_at: "2026-08-20T12:00:00.000Z",
    }],
    effects: [],
    truncated: false,
    updated_at: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

function handler(input: { projected?: KernelStatusProjection } = {}) {
  const requestRunControl = vi.fn(async () => ({ disposition: "consumed" as const }));
  const enqueueSteering = vi.fn(async () => ({
    accepted: true as const,
    acknowledge: true as const,
    retryable: false as const,
    duplicate: false,
    event: event({ id: "steering-activity-1", kind: "steering/message@1" }),
  }));
  return {
    value: new KernelProviderPromptHandler({
      runs: { resolveRun: () => ({
        pipeline_run_id: "run-1",
        work_item_id: "work-1",
        source_provider: "linear",
        source_reference: "OPE-188",
      }) },
      projections: {
        getStatus: () => input.projected ?? status(),
        listLog: () => ({ entries: [], next_cursor: null, truncated: false }),
      },
      control: { requestRunControl, enqueueSteering },
    }),
    requestRunControl,
    enqueueSteering,
  };
}

describe("KernelProviderPromptHandler", () => {
  it("turns a Linear follow-up into attempt-bound durable steering", async () => {
    const test = handler();
    await expect(test.value.handle(event())).resolves.toBe("consumed");
    expect(test.enqueueSteering).toHaveBeenCalledWith({
      message_id: "activity-1",
      source: "human",
      body: "Please focus on the failing contract.",
      source_provider: "linear",
      delivery_id: "steering:activity-1",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
    });
  });

  it("routes a Linear stop signal through the shared run controller", async () => {
    const test = handler();
    await expect(test.value.handle(event({
      payload: {
        agentSession: { issue: { identifier: "OPE-188" } },
        agentActivity: { id: "activity-1", signal: { type: "stop" } },
      },
    }))).resolves.toBe("consumed");
    expect(test.requestRunControl).toHaveBeenCalledWith({
      pipeline_run_id: "run-1",
      action: "stop",
      reason: "Stopped from the linear control thread.",
    });
    expect(test.enqueueSteering).not.toHaveBeenCalled();
  });

  it("keeps a follow-up retryable until an active attempt binds its session", async () => {
    const test = handler({ projected: status({ attempts: [] }) });
    await expect(test.value.handle(event())).rejects.toThrow("no bound steering-capable attempt yet");
  });

  it("routes GitHub issue comments to the same steering primitive", async () => {
    const test = handler();
    await expect(test.value.handle(event({
      source_provider: "github",
      kind: "github/issue-comment/created@1",
      payload: {
        repository: { full_name: "Owner/Repo" },
        issue: { number: 188 },
        comment: { id: 991, body: "Please rerun the focused test." },
      },
    }))).resolves.toBe("consumed");
    expect(test.enqueueSteering).toHaveBeenCalledWith(expect.objectContaining({
      message_id: "991",
      source_provider: "github",
      body: "Please rerun the focused test.",
    }));
  });
});
