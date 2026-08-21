import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRecordPayloadRegistry } from "@openthrottle/contracts";
import {
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";
import { SqliteKernelStore } from "./kernel-store.js";

const OBSERVED = "2026-08-20T12:10:00.000Z";
const RENEWED = "2026-08-20T12:20:00.000Z";
const EXPIRED = "2026-08-20T12:05:00.000Z";
const EXECUTION_POLICY = Object.freeze({ max_concurrent_attempts: 1 });
let fixture: FreshKernelFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("expired kernel Attempt lease recovery", () => {
  it.each([
    ["unstarted", "pending", "work", false, null, 0],
    ["started", "running", "work", true, "session-started", 0],
    ["correction", "result_pending", "result_correction", true, "session-correction", 1],
  ] as const)("recovers %s work under its original single lease fence", async (
    runId,
    status,
    purpose,
    started,
    nativeSession,
    resultCorrectionCount,
  ) => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: runId });
    seedKernelAttempt({
      db: fixture.db,
      run_id: runId,
      id: `attempt-${runId}`,
      status,
      native_session_id: nativeSession,
      lease: {
        id: `lease-${runId}`,
        worker_id: `worker-${runId}`,
        purpose,
        expires_at: EXPIRED,
        started,
      },
    });
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => { throw new Error("not used"); } },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY,
      now: () => OBSERVED,
    });

    const recovered = await store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 1,
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.attempt).toMatchObject({
      id: `attempt-${runId}`,
      status,
      request_hash: "a".repeat(64),
      native_session_id: nativeSession,
      work_retry_ordinal: 0,
      result_correction_count: resultCorrectionCount,
      checkpoint_id: null,
      lease: {
        id: `lease-${runId}`,
        generation: 1,
        worker_id: `worker-${runId}`,
        purpose,
        expires_at: RENEWED,
        started,
      },
    });
    await expect(store.renewAttemptLease({
      attempt_id: `attempt-${runId}`,
      lease_id: `lease-${runId}`,
      lease_generation: 0,
      worker_id: `worker-${runId}`,
      expires_at: "2026-08-20T12:30:00.000Z",
    })).rejects.toThrow(/generation|fence/);
    await expect(store.renewAttemptLease({
      attempt_id: `attempt-${runId}`,
      lease_id: `lease-${runId}`,
      lease_generation: 1,
      worker_id: `worker-${runId}`,
      expires_at: "2026-08-20T12:30:00.000Z",
    })).resolves.toMatchObject({
      id: `lease-${runId}`,
      generation: 1,
      worker_id: `worker-${runId}`,
      expires_at: "2026-08-20T12:30:00.000Z",
    });
    expect(await store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 1,
    })).toEqual([]);
    await expect(store.recoverExpiredAttemptLeases({
      observed_at: "2026-08-20T12:31:00.000Z",
      expires_at: "2026-08-20T12:40:00.000Z",
      limit: 1,
    })).resolves.toEqual([
      expect.objectContaining({
        lease: expect.objectContaining({
          id: `lease-${runId}`,
          generation: 2,
          worker_id: `worker-${runId}`,
          purpose,
          started,
        }),
      }),
    ]);
  });

  it("blocks a new lease until one expired lease is recovered and never creates a second", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-expired" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "run-expired",
      id: "attempt-expired",
      status: "pending",
      lease: {
        id: "lease-expired",
        worker_id: "worker-expired",
        purpose: "work",
        expires_at: EXPIRED,
        started: false,
      },
    });
    seedKernelRun({ db: fixture.db, run_id: "run-waiting" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "run-waiting",
      id: "attempt-waiting",
      status: "pending",
    });
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => { throw new Error("not used"); } },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY,
      now: () => OBSERVED,
    });

    expect(await store.leaseNextEligibleAttempt({
      worker_id: "worker-new",
      lease_id: "lease-new",
      expires_at: RENEWED,
    })).toBeNull();
    const recovered = await store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 1,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.lease.id).toBe("lease-expired");
    expect(await store.leaseNextEligibleAttempt({
      worker_id: "worker-new",
      lease_id: "lease-new",
      expires_at: RENEWED,
    })).toBeNull();
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM attempts WHERE lease_id IS NOT NULL",
    ).get()).toEqual({ count: 1 });
  });

  it("bounds recovery and refuses non-forward lease timestamps", async () => {
    fixture = freshKernelFixture();
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => { throw new Error("not used"); } },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY,
    });
    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: OBSERVED,
      limit: 1,
    })).rejects.toThrow(/timestamps are invalid/);
    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 101,
    })).rejects.toThrow(/between 1 and 100/);
  });
});
