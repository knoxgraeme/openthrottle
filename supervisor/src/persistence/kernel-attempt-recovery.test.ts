import { afterEach, describe, expect, it } from "vitest";
import {
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  type CompiledPipelineManifest,
  type ExecutionRecordPayloadRegistry,
} from "@openthrottle/contracts";
import {
  freshKernelFixture,
  KERNEL_FIXTURE_BUNDLE_HASH,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";
import { SqliteKernelStore } from "./kernel-store.js";

const OBSERVED = "2026-08-20T12:10:00.000Z";
const RENEWED = "2026-08-20T12:20:00.000Z";
const EXPIRED = "2026-08-20T12:05:00.000Z";
const EXECUTION_POLICY = Object.freeze({ max_concurrent_attempts: 1 });
const EXECUTION_POLICY_TWO = Object.freeze({ max_concurrent_attempts: 2 });
let fixture: FreshKernelFixture | undefined;

function recoveryManifest(maxParallel = 1): CompiledPipelineManifest {
  return {
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: "core/implement",
    pipeline_version: 1,
    entry_stage: "implement",
    definition_bundle_hash: KERNEL_FIXTURE_BUNDLE_HASH,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    stages: [{
      id: "implement",
      kind: "agent",
      engine: "codex",
      agent_id: "worker",
      repository_authority: "inspect",
      skills: ["work"],
      entry_skill: "work",
      eval: "result",
      ...(maxParallel === 1 ? {} : {
        loop: {
          over: "items",
          max_parallel: maxParallel,
          max_rounds: 1,
          body: ["implement"],
        },
      }),
      on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
    }],
  };
}

function unitRecoveryManifest(): CompiledPipelineManifest {
  return {
    ...recoveryManifest(),
    stages: [
      {
        id: "implement",
        kind: "agent",
        engine: "codex",
        agent_id: "worker",
        repository_authority: "edit",
        skills: ["work"],
        entry_skill: "work",
        eval: "result",
        loop: {
          over: "execution_plan.units",
          max_parallel: 2,
          max_rounds: 8,
          body: ["implement", "accept", "integration"],
        },
        on: { success: { to: "accept" }, failure: { terminal: "failed" } },
      },
      {
        id: "accept",
        kind: "agent",
        engine: "codex",
        agent_id: "lead",
        repository_authority: "inspect",
        skills: ["work"],
        entry_skill: "work",
        eval: "result",
        on: { success: { to: "integration" }, failure: { terminal: "failed" } },
      },
      {
        id: "integration",
        kind: "effect",
        effect: "core/integrate-unit@1",
        on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
      },
    ],
  };
}

function setFanoutScope(input: {
  db: FreshKernelFixture["db"];
  attempt_id: string;
  parent_attempt_id: string;
  member_index: number;
}): void {
  input.db.prepare(`
    UPDATE attempts SET scope_kind = 'fanout_member', stage_id = 'implement',
      parent_attempt_id = ?, scope_group_id = 'items', scope_item_id = ?,
      scope_item_index = ? WHERE id = ?
  `).run(
    input.parent_attempt_id,
    `item-${input.member_index}`,
    input.member_index,
    input.attempt_id,
  );
}

function setUnitScope(input: {
  db: FreshKernelFixture["db"];
  attempt_id: string;
  parent_attempt_id: string;
  unit_id: string;
  unit_index: number;
}): void {
  input.db.prepare(`
    UPDATE attempts SET scope_kind = 'loop_item', stage_id = 'implement',
      repository_authority = 'edit', parent_attempt_id = ?,
      scope_group_id = 'execution_plan.units', scope_item_id = ?,
      scope_item_index = ? WHERE id = ?
  `).run(
    input.parent_attempt_id,
    input.unit_id,
    input.unit_index,
    input.attempt_id,
  );
}

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
      manifest_resolver: { resolve: () => recoveryManifest() },
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
      manifest_resolver: { resolve: () => recoveryManifest() },
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

  it("drains expired leases admitted before execution width was lowered", async () => {
    fixture = freshKernelFixture();
    for (const ordinal of [1, 2]) {
      seedKernelRun({ db: fixture.db, run_id: `run-${ordinal}` });
      seedKernelAttempt({
        db: fixture.db,
        run_id: `run-${ordinal}`,
        id: `attempt-${ordinal}`,
        status: "pending",
        lease: {
          id: `lease-${ordinal}`,
          worker_id: "worker-before-rollback",
          purpose: "work",
          expires_at: EXPIRED,
          started: false,
        },
      });
    }
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => recoveryManifest() },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY,
      execution_width: 1,
      now: () => OBSERVED,
    });

    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 2,
    })).resolves.toMatchObject([
      { run_id: "run-1", lease: { id: "lease-1", generation: 1 } },
      { run_id: "run-2", lease: { id: "lease-2", generation: 1 } },
    ]);
  });

  it("recovers distinct same-run runtime slots under their original lease fences", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-pool" });
    for (const memberIndex of [0, 1]) {
      seedKernelAttempt({
        db: fixture.db,
        run_id: "run-pool",
        id: `attempt-${memberIndex}`,
        status: "pending",
        lease: {
          id: `lease-${memberIndex}`,
          worker_id: "worker-pool",
          purpose: "work",
          expires_at: EXPIRED,
          started: false,
        },
      });
      setFanoutScope({
        db: fixture.db,
        attempt_id: `attempt-${memberIndex}`,
        parent_attempt_id: "attempt-0",
        member_index: memberIndex,
      });
    }
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => recoveryManifest(2) },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY_TWO,
      execution_width: 1,
      now: () => OBSERVED,
    });

    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 2,
    })).resolves.toMatchObject([
      { run_id: "run-pool", lease: { id: "lease-0", generation: 1 } },
      { run_id: "run-pool", lease: { id: "lease-1", generation: 1 } },
    ]);
  });

  it("recovers distinct same-run unit slots with their exact unit ownership", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-units" });
    for (const unitIndex of [0, 1]) {
      seedKernelAttempt({
        db: fixture.db,
        run_id: "run-units",
        id: `attempt-unit-${unitIndex}`,
        status: "pending",
        lease: {
          id: `lease-unit-${unitIndex}`,
          worker_id: "worker-units",
          purpose: "work",
          expires_at: EXPIRED,
          started: false,
        },
      });
      setUnitScope({
        db: fixture.db,
        attempt_id: `attempt-unit-${unitIndex}`,
        parent_attempt_id: "attempt-unit-0",
        unit_id: `unit-${unitIndex}`,
        unit_index: unitIndex,
      });
    }
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => unitRecoveryManifest() },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY_TWO,
      execution_width: 1,
      now: () => OBSERVED,
    });

    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 2,
    })).resolves.toMatchObject([
      { run_id: "run-units", attempt: { scope: { item_id: "unit-0" } }, lease: { generation: 1 } },
      { run_id: "run-units", attempt: { scope: { item_id: "unit-1" } }, lease: { generation: 1 } },
    ]);
  });

  it("does not recover duplicate unit ownership while an unrelated run progresses", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-duplicate-unit" });
    for (const unitIndex of [0, 1]) {
      seedKernelAttempt({
        db: fixture.db,
        run_id: "run-duplicate-unit",
        id: `attempt-duplicate-unit-${unitIndex}`,
        status: "pending",
        lease: {
          id: `lease-duplicate-unit-${unitIndex}`,
          worker_id: "worker-duplicate-unit",
          purpose: "work",
          expires_at: EXPIRED,
          started: false,
        },
      });
      setUnitScope({
        db: fixture.db,
        attempt_id: `attempt-duplicate-unit-${unitIndex}`,
        parent_attempt_id: "attempt-duplicate-unit-0",
        unit_id: "unit-a",
        unit_index: unitIndex,
      });
    }
    seedKernelRun({ db: fixture.db, run_id: "run-unrelated" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "run-unrelated",
      id: "attempt-unrelated",
      status: "pending",
      lease: {
        id: "lease-unrelated",
        worker_id: "worker-unrelated",
        purpose: "work",
        expires_at: EXPIRED,
        started: false,
      },
    });
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => unitRecoveryManifest() },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY_TWO,
      execution_width: 3,
      now: () => OBSERVED,
    });

    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 3,
    })).resolves.toMatchObject([
      { run_id: "run-unrelated", attempt: { id: "attempt-unrelated" } },
    ]);
    expect(fixture.db.prepare(`
      SELECT id, lease_generation FROM attempts
      WHERE pipeline_run_id = 'run-duplicate-unit' ORDER BY id
    `).all()).toEqual([
      { id: "attempt-duplicate-unit-0", lease_generation: 0 },
      { id: "attempt-duplicate-unit-1", lease_generation: 0 },
    ]);
  });

  it("skips a duplicate-slot run while recovering an unrelated run", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-corrupt" });
    for (const memberIndex of [0, 2]) {
      seedKernelAttempt({
        db: fixture.db,
        run_id: "run-corrupt",
        id: `attempt-corrupt-${memberIndex}`,
        status: "pending",
        lease: {
          id: `lease-corrupt-${memberIndex}`,
          worker_id: "worker-corrupt",
          purpose: "work",
          expires_at: EXPIRED,
          started: false,
        },
      });
      setFanoutScope({
        db: fixture.db,
        attempt_id: `attempt-corrupt-${memberIndex}`,
        parent_attempt_id: "attempt-corrupt-0",
        member_index: memberIndex,
      });
    }
    seedKernelRun({ db: fixture.db, run_id: "run-good" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "run-good",
      id: "attempt-good",
      status: "pending",
      lease: {
        id: "lease-good",
        worker_id: "worker-good",
        purpose: "work",
        expires_at: EXPIRED,
        started: false,
      },
    });
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => recoveryManifest(2) },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY_TWO,
      now: () => OBSERVED,
    });

    await expect(store.recoverExpiredAttemptLeases({
      observed_at: OBSERVED,
      expires_at: RENEWED,
      limit: 3,
    })).resolves.toMatchObject([
      { run_id: "run-good", lease: { id: "lease-good", generation: 1 } },
    ]);
    expect(fixture.db.prepare(`
      SELECT id, lease_generation FROM attempts
      WHERE pipeline_run_id = 'run-corrupt' ORDER BY id
    `).all()).toEqual([
      { id: "attempt-corrupt-0", lease_generation: 0 },
      { id: "attempt-corrupt-2", lease_generation: 0 },
    ]);
  });

  it("leases unrelated work despite incompatible live claims in another run", async () => {
    fixture = freshKernelFixture();
    seedKernelRun({ db: fixture.db, run_id: "run-corrupt" });
    for (const memberIndex of [0, 2]) {
      seedKernelAttempt({
        db: fixture.db,
        run_id: "run-corrupt",
        id: `attempt-corrupt-${memberIndex}`,
        status: "pending",
        lease: {
          id: `lease-corrupt-${memberIndex}`,
          worker_id: "worker-corrupt",
          purpose: "work",
          expires_at: RENEWED,
          started: false,
        },
      });
      setFanoutScope({
        db: fixture.db,
        attempt_id: `attempt-corrupt-${memberIndex}`,
        parent_attempt_id: "attempt-corrupt-0",
        member_index: memberIndex,
      });
    }
    seedKernelRun({ db: fixture.db, run_id: "run-good" });
    seedKernelAttempt({
      db: fixture.db,
      run_id: "run-good",
      id: "attempt-good",
      status: "pending",
    });
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => recoveryManifest(2) },
      payload_schemas: new Map() as ExecutionRecordPayloadRegistry,
      execution_policy: EXECUTION_POLICY_TWO,
      execution_width: 4,
      now: () => OBSERVED,
    });

    await expect(store.leaseNextEligibleAttempt({
      worker_id: "worker-good",
      lease_id: "lease-good",
      expires_at: RENEWED,
    })).resolves.toMatchObject({
      run_id: "run-good",
      attempt: { id: "attempt-good" },
    });
  });

  it("bounds recovery and refuses non-forward lease timestamps", async () => {
    fixture = freshKernelFixture();
    const store = new SqliteKernelStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      manifest_resolver: { resolve: () => recoveryManifest() },
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
