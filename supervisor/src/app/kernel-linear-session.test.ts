import { describe, expect, it, vi } from "vitest";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import {
  KernelLinearSessionStartDispatcher,
  kernelLinearSessionStartRequest,
} from "./kernel-linear-session.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function linearCreatedEvent(id: string): KernelInboxEvent {
  return {
    id: `inbox-${id}`,
    source_provider: "linear",
    delivery_id: `delivery-${id}`,
    kind: "linear/agent-session-event/created@1",
    work_item_id: null,
    pipeline_run_id: null,
    attempt_id: null,
    generation: 0,
    event_group_key: `linear:webhook-${id}`,
    delivery_attempt: 1,
    subject: null,
    payload_hash: "a".repeat(64),
    payload_schema: "openthrottle.provider-event/linear/v1",
    payload: {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: `webhook-${id}`,
      agentSession: { id: `session-${id}` },
    },
    status: "pending",
    available_at: "2026-08-20T12:00:00.000Z",
    lease_id: null,
    lease_owner_id: null,
    lease_expires_at: null,
    version: 0,
    created_at: "2026-08-20T12:00:00.000Z",
    consumed_at: null,
  };
}

describe("KernelLinearSessionStartDispatcher", () => {
  it("bounds fast-path concurrency and reserves durable work for the next slot", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let active = 0;
    let maximumActive = 0;
    const ensureStarted = vi.fn((input: { session_id: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const gate = deferred();
      gates.set(input.session_id, gate);
      return gate.promise.finally(() => {
        active -= 1;
      });
    });
    const dispatcher = new KernelLinearSessionStartDispatcher({
      downstream: { ensureStarted },
      max_concurrency: 2,
    });
    const first = linearCreatedEvent("1");
    const second = linearCreatedEvent("2");
    const saturated = linearCreatedEvent("3");

    expect(dispatcher.wake(first)).toBe(true);
    expect(dispatcher.wake(second)).toBe(true);
    expect(dispatcher.wake(saturated)).toBe(false);
    expect(ensureStarted).toHaveBeenCalledTimes(2);

    const durable = dispatcher.ensureStarted(kernelLinearSessionStartRequest(saturated)!);
    expect(ensureStarted).toHaveBeenCalledTimes(2);
    gates.get("session-1")!.resolve();
    await vi.waitFor(() => expect(ensureStarted).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(2);

    gates.get("session-2")!.resolve();
    gates.get("session-3")!.resolve();
    await durable;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active).toBe(0);
  });

  it("contains a background failure so the durable path can retry", async () => {
    const first = deferred();
    const ensureStarted = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const dispatcher = new KernelLinearSessionStartDispatcher({
      downstream: { ensureStarted },
      max_concurrency: 1,
    });
    const event = linearCreatedEvent("failure");

    expect(dispatcher.wake(event)).toBe(true);
    first.reject(new Error("provider response contained sensitive details"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(
      dispatcher.ensureStarted(kernelLinearSessionStartRequest(event)!),
    ).resolves.toBeUndefined();
    expect(ensureStarted).toHaveBeenCalledTimes(2);
  });
});
