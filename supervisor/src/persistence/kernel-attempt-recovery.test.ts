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
let fixture: FreshKernelFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("expired kernel Attempt lease recovery", () => {
  it("recovers unstarted work, started work, and correction under their original fence", async () => {
    fixture = freshKernelFixture();
    for (const [runId, status, purpose, started, nativeSession] of [
      ["run-unstarted", "pending", "work", false, null],
      ["run-started", "running", "work", true, "session-started"],
      ["run-correction", "result_pending", "result_correction", true, "session-correction"],
    ] as const) {
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
    }
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => { throw new Error("not used"); } },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      now: () => OBSERVED,
    });

    const recovered = await store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 3,
    });

    expect(recovered).toHaveLength(3);
    expect(recovered.map(({ attempt }) => ({
      id: attempt.id,
      status: attempt.status,
      request_hash: attempt.request_hash,
      native_session_id: attempt.native_session_id,
      work_retry_ordinal: attempt.work_retry_ordinal,
      result_correction_count: attempt.result_correction_count,
      checkpoint_id: attempt.checkpoint_id,
      lease: attempt.lease,
    }))).toEqual([
      expect.objectContaining({
        id: "attempt-run-correction",
        status: "result_pending",
        native_session_id: "session-correction",
        work_retry_ordinal: 0,
        result_correction_count: 1,
        checkpoint_id: null,
        lease: expect.objectContaining({
          id: "lease-run-correction",
          worker_id: "worker-run-correction",
          purpose: "result_correction",
          expires_at: RENEWED,
          started: true,
        }),
      }),
      expect.objectContaining({
        id: "attempt-run-started",
        status: "running",
        native_session_id: "session-started",
        work_retry_ordinal: 0,
        result_correction_count: 0,
        lease: expect.objectContaining({
          id: "lease-run-started",
          worker_id: "worker-run-started",
          expires_at: RENEWED,
          started: true,
        }),
      }),
      expect.objectContaining({
        id: "attempt-run-unstarted",
        status: "pending",
        native_session_id: null,
        lease: expect.objectContaining({
          id: "lease-run-unstarted",
          worker_id: "worker-run-unstarted",
          expires_at: RENEWED,
          started: false,
        }),
      }),
    ]);
    expect(new Set(recovered.map(({ attempt }) => attempt.request_hash))).toEqual(
      new Set(["a".repeat(64)]),
    );
    expect(await store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 3,
    })).toEqual([]);
  });

  it("bounds recovery and refuses non-forward lease timestamps", async () => {
    fixture = freshKernelFixture();
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => { throw new Error("not used"); } },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
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
