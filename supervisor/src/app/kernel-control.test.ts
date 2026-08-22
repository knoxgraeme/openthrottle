import { afterEach, describe, expect, it } from "vitest";
import { SqliteKernelInboxStore } from "../persistence/kernel-inbox-store.js";
import type {
  KernelActiveWorkItem,
  KernelActiveWorkProjectionPort,
  KernelActiveWorkSnapshot,
} from "../persistence/kernel-projection-store.js";
import {
  KERNEL_FIXTURE_BUNDLE_HASH,
  KERNEL_FIXTURE_REQUEST_HASH,
  KERNEL_FIXTURE_SUBJECT,
  KERNEL_FIXTURE_NOW,
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "../persistence/__fixtures__/kernel-epoch.js";
import type {
  KernelRuntimeSessionBinding,
  KernelRuntimeSessionBindingPort,
} from "../pipeline/kernel/steering.js";
import {
  KernelControlService,
  type KernelRuntimeInventoryPort,
  type KernelRuntimeInventoryResource,
} from "./kernel-control.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

class SessionBindings implements KernelRuntimeSessionBindingPort {
  current: KernelRuntimeSessionBinding | null = null;
  reads = 0;

  async bindRuntimeSession(): Promise<KernelRuntimeSessionBinding> {
    if (!this.current) throw new Error("test session is not configured");
    return this.current;
  }

  async loadCurrentRuntimeSession(): Promise<KernelRuntimeSessionBinding | null> {
    this.reads += 1;
    return this.current;
  }
}

class ActiveWork implements KernelActiveWorkProjectionPort {
  snapshot: KernelActiveWorkSnapshot = { items: [], truncated: false };

  collectActiveWork(): KernelActiveWorkSnapshot {
    return this.snapshot;
  }
}

class RuntimeInventory implements KernelRuntimeInventoryPort {
  resources: readonly KernelRuntimeInventoryResource[] = [];
  failure: Error | null = null;
  limits: number[] = [];

  async listActiveRuntimeResources(limit: number): Promise<readonly KernelRuntimeInventoryResource[]> {
    this.limits.push(limit);
    if (this.failure) throw this.failure;
    return this.resources.slice(0, limit);
  }
}

function binding(input: {
  status?: "running" | "result_pending";
  purpose?: "work" | "result_correction";
  generation?: number;
  lease_generation?: number;
} = {}): KernelRuntimeSessionBinding {
  return {
    pipeline_run_id: "run-1",
    attempt_id: "attempt-live",
    request_hash: KERNEL_FIXTURE_REQUEST_HASH,
    definition_bundle_hash: KERNEL_FIXTURE_BUNDLE_HASH,
    input_subject: KERNEL_FIXTURE_SUBJECT,
    native_session_id: "session-live",
    generation: input.generation ?? (input.purpose === "result_correction" ? 1 : 0),
    attempt_status: input.status ?? "running",
    repository_authority: "edit",
    lease_id: "lease-live",
    lease_generation: input.lease_generation ?? 0,
    lease_worker_id: "worker-live",
    lease_purpose: input.purpose ?? "work",
    lease_expires_at: "2026-08-20T13:00:00.000Z",
    lease_started: true,
  };
}

function setup(input: {
  status?: "running" | "result_pending";
  purpose?: "work" | "result_correction";
} = {}) {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  seedKernelRun({ db: fixture.db });
  seedKernelAttempt({
    db: fixture.db,
    id: "attempt-live",
    status: input.status ?? "running",
    version: 4,
    native_session_id: "session-live",
    lease: {
      id: "lease-live",
      worker_id: "worker-live",
      purpose: input.purpose ?? "work",
      expires_at: "2026-08-20T13:00:00.000Z",
      started: true,
    },
  });
  const inbox = new SqliteKernelInboxStore({
    db: fixture.db,
    blob_store: fixture.blobs,
    now: () => KERNEL_FIXTURE_NOW,
  });
  const sessions = new SessionBindings();
  const activeWork = new ActiveWork();
  const inventory = new RuntimeInventory();
  const control = new KernelControlService({
    inbox,
    maintenance: inbox,
    runtime_sessions: sessions,
    active_work: activeWork,
    runtime_inventory: inventory,
    now: () => KERNEL_FIXTURE_NOW,
  });
  return { fixture, inbox, sessions, activeWork, inventory, control };
}

describe("KernelControlService", () => {
  it("does not enqueue or deliver mid-work steering before durable session binding", async () => {
    const test = setup();
    await expect(test.control.enqueueSteering({
      message_id: "message-1",
      source: "operator",
      body: "Please include restart coverage.",
      source_provider: "operator",
      delivery_id: "delivery-1",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-live",
    })).rejects.toThrow(/before a durable runtime session is bound/);
    expect(test.fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });

    test.sessions.current = binding();
    const accepted = await test.control.enqueueSteering({
      message_id: "message-1",
      source: "operator",
      body: "Please include restart coverage.",
      source_provider: "operator",
      delivery_id: "delivery-1",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-live",
    });
    expect(accepted).toMatchObject({ accepted: true, acknowledge: true, duplicate: false });
    const leased = test.inbox.leaseNext({
      owner_id: "runtime-delivery",
      lease_id: "inbox-lease",
      expires_at: "2026-08-20T12:05:00.000Z",
    })!;
    expect(await test.control.authorizeLeasedSteering(leased)).toMatchObject({
      body: "Please include restart coverage.",
      policy: { phase: "work", repository_authority: "edit", result_only: false },
    });

    test.sessions.current = binding({ generation: 1 });
    await expect(test.control.authorizeLeasedSteering(leased))
      .rejects.toThrow(/generation.*stale or mismatched/);

    test.sessions.current = binding({ lease_generation: 1 });
    await expect(test.control.authorizeLeasedSteering(leased))
      .rejects.toThrow(/lease_generation.*stale or mismatched/);
  });

  it("cannot widen result-only correction through steering", async () => {
    const test = setup({ status: "result_pending", purpose: "result_correction" });
    test.sessions.current = binding({
      status: "result_pending",
      purpose: "result_correction",
    });
    await test.control.enqueueSteering({
      message_id: "message-correction",
      source: "human",
      body: "Fix only payload.summary.",
      source_provider: "human",
      delivery_id: "delivery-correction",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-live",
    });
    const leased = test.inbox.leaseNext({
      owner_id: "runtime-delivery",
      lease_id: "correction-inbox-lease",
      expires_at: "2026-08-20T12:05:00.000Z",
    })!;
    expect((await test.control.authorizeLeasedSteering(leased)).policy).toEqual({
      phase: "result_correction",
      repository_authority: "inspect",
      result_only: true,
      allowed_tools: ["ot-result"],
      mcp: false,
      provider_access: false,
    });
  });

  it("does not consult session state or persist while maintenance is closed", async () => {
    const test = setup();
    const closed = test.control.closeMutatingIngress(1);
    expect(closed.closed).toBe(true);
    expect(await test.control.enqueueSteering({
      message_id: "during-maintenance",
      source: "operator",
      body: "This must be retried.",
      source_provider: "operator",
      delivery_id: "delivery-maintenance",
      delivery_attempt: 1,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-live",
    })).toEqual({
      accepted: false,
      acknowledge: false,
      retryable: true,
      status_code: 503,
      retry_after_seconds: 30,
      reason: "maintenance",
    });
    expect(test.sessions.reads).toBe(0);
    expect(test.fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });
  });

  it("produces a bounded diagnostic active-work snapshot", async () => {
    const test = setup();
    const durable: KernelActiveWorkItem = {
      key: "run:run-1",
      kind: "run",
      id: "run-1",
      pipeline_run_id: "run-1",
      status: "running",
      detail: "stage=implement",
      observed_at: KERNEL_FIXTURE_NOW,
    };
    test.activeWork.snapshot = { items: [durable], truncated: false };
    test.inventory.resources = [{
      id: "workspace-1",
      provider: "daytona",
      state: "started",
      pipeline_run_id: "run-1",
    }];
    const report = await test.control.activeWorkReport();
    expect(report).toEqual({
      observed_at: KERNEL_FIXTURE_NOW,
      clear: false,
      truncated: false,
      items: [
        durable,
        {
          key: "runtime_resource:daytona:workspace-1",
          kind: "runtime_resource",
          id: "workspace-1",
          pipeline_run_id: "run-1",
          status: "started",
          detail: "provider=daytona",
          observed_at: KERNEL_FIXTURE_NOW,
        },
      ],
    });

    test.activeWork.snapshot = { items: [], truncated: false };
    test.inventory.resources = [];
    expect(await test.control.activeWorkReport()).toEqual({
      observed_at: KERNEL_FIXTURE_NOW,
      clear: true,
      truncated: false,
      items: [],
    });
  });

  it("marks bounded and unavailable runtime inventories as incomplete", async () => {
    const bounded = setup();
    bounded.activeWork.snapshot = {
      items: [{
        key: "run:run-1",
        kind: "run",
        id: "run-1",
        pipeline_run_id: "run-1",
        status: "running",
        detail: "stage=implement",
        observed_at: KERNEL_FIXTURE_NOW,
      }],
      truncated: false,
    };
    expect(await bounded.control.activeWorkReport({ limit: 1 })).toMatchObject({
      clear: false,
      truncated: true,
    });
    expect(bounded.inventory.limits).toEqual([]);

    const maximal = setup();
    expect(await maximal.control.activeWorkReport({ limit: 2_000 })).toMatchObject({
      clear: true,
      truncated: false,
      items: [],
    });
    expect(maximal.inventory.limits).toEqual([2_000]);

    maximal.inventory.resources = Array.from({ length: 2_000 }, (_, index) => ({
      id: `workspace-${String(index).padStart(4, "0")}`,
      provider: "daytona",
      state: "started",
      pipeline_run_id: null,
    }));
    const saturated = await maximal.control.activeWorkReport({ limit: 2_000 });
    expect(saturated).toMatchObject({ clear: false, truncated: true });
    expect(saturated.items).toHaveLength(2_000);
    expect(maximal.inventory.limits).toEqual([2_000, 2_000]);

    const unavailable = setup();
    unavailable.inventory.failure = new Error("provider timeout");
    expect(await unavailable.control.activeWorkReport({ limit: 2 })).toEqual({
      observed_at: KERNEL_FIXTURE_NOW,
      clear: false,
      truncated: false,
      items: [{
        key: "runtime_resource:unknown:inventory-unavailable",
        kind: "runtime_resource",
        id: "inventory-unavailable",
        pipeline_run_id: null,
        status: "unknown",
        detail: "runtime inventory failed: Error: provider timeout",
        observed_at: KERNEL_FIXTURE_NOW,
      }],
    });
    expect(unavailable.inventory.limits).toEqual([3]);
  });
});
