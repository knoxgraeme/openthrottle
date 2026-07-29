import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { digestNormalized } from "../../pipeline/manifest.js";
import { openDb } from "../database.js";
import { createExecutionUnitStore } from "./unit-store.js";

let db: Database.Database | undefined;
let timestamp = "2026-07-29T00:00:00.000Z";

function setup(): ReturnType<typeof createExecutionUnitStore> {
  db = openDb(":memory:");
  db.exec(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
      repo, base_branch, created_at, updated_at
    ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${timestamp}', '${timestamp}');
    INSERT INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    ) VALUES ('session-1', 'issue-1', 1, 'current', '${timestamp}', '${timestamp}');
    INSERT INTO runs (
      id, linear_issue_id, linear_session_id, session_generation, task_type,
      token_hash, status, started_at, expires_at
    ) VALUES (
      'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
      'running', '${timestamp}', '2026-07-29T01:00:00.000Z'
    );
    INSERT INTO repository_config_snapshots (
      id, repository, base_commit, blob_sha, digest, normalized_config, created_at
    ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${timestamp}');
    INSERT INTO runtime_capability_descriptors (
      runtime_release, digest, protocol, normalized_descriptor, accepted_at
    ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${timestamp}');
    INSERT INTO pipeline_catalog_entries (
      pipeline_id, version, digest, normalized_manifest, accepted_at
    ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${timestamp}');
    INSERT INTO pipeline_instances (
      id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
      manifest_digest, normalized_manifest, repository, base_commit, branch,
      repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
      executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
      attempt_count, created_at, updated_at
    ) VALUES (
      'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
      '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
      'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
      'units', 1, 1, '${timestamp}', '${timestamp}'
    );
    INSERT INTO pipeline_instance_stages (
      pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
    ) VALUES ('instance-1', 'units', 1, 'running', 1, '${timestamp}', '${timestamp}');
    INSERT INTO pipeline_stage_attempts (
      id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
      request_hash, idempotency_key, context_revision, native_context_policy,
      planned_run_id, run_id, status, created_at, updated_at
    ) VALUES (
      'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
      'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${timestamp}', '${timestamp}'
    );
  `);
  return createExecutionUnitStore(db, () => timestamp);
}

afterEach(() => {
  db?.close();
  db = undefined;
  timestamp = "2026-07-29T00:00:00.000Z";
});

describe("execution unit store", () => {
  it("creates child state idempotently for a parent attempt", () => {
    const store = setup();
    const input = {
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
    };

    expect(store.createGraph(input)).toMatchObject({ parent_attempt_id: "attempt-parent" });
    expect(store.createGraph(input)).toMatchObject({ parent_attempt_id: "attempt-parent" });
    expect(store.listUnits("attempt-parent").map((unit) => [unit.unitId, unit.dependencies])).toEqual([
      ["a", []],
      ["b", ["a"]],
    ]);
    expect(() => store.createGraph({
      ...input,
      graphDigest: "changed-graph-digest",
    })).toThrow(/replay fence mismatch/);
    expect(() => store.createGraph({
      ...input,
      units: [{ id: "a" }, { id: "c", dependencies: ["a"] }],
    })).toThrow(/replay unit set mismatch/);
  });

  it("leases exactly one active child action and resumes after completion", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
    });

    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });
    const raced = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(first?.unit_id).toBe("a");
    expect(raced).toBeUndefined();

    store.markActionDispatched(first!.id, "request-hash", "native-session");
    store.completeUnitAction({ actionId: first!.id, resultHash: "result-hash", outputSubject: "111" });
    const second = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });
    expect(second?.unit_id).toBe("b");
  });

  it("expires stale leased work and returns the unit to the serial queue", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
    });

    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;

    const recovered = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(recovered?.unit_id).toBe("a");
    expect(recovered?.id).not.toBe(first.id);
    expect(db!.prepare(`
      SELECT status, last_error FROM execution_work_attempts WHERE id = ?
    `).get(first.id)).toEqual({
      status: "failed",
      last_error: "lease expired before acknowledgement",
    });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "running", activeActionId: recovered!.id }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("recovers an expired dispatched action without duplicating work", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
    });

    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(first.id, "request-hash", "native-session");

    const recovered = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(recovered?.id).toBe(first.id);
    expect(recovered?.unit_id).toBe("a");
    expect(db!.prepare(`
      SELECT COUNT(*) AS count FROM execution_work_attempts WHERE parent_attempt_id = ?
    `).get("attempt-parent")).toEqual({ count: 1 });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "running", activeActionId: first.id }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("emits one aggregate only after every unit integrated", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
    });
    expect(() => store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: "111",
    })).toThrow(/unfinished units/);

    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });
    store.completeUnitAction({ actionId: action!.id, resultHash: "result-hash", outputSubject: "111" });

    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: "111",
    })).toBe("emitted");
    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: "111",
    })).toBe("already_emitted");
    expect(() => store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-2",
      integrationSubject: "222",
    })).toThrow(/different aggregate/);
    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "superseded",
    })).toBe("already_stopped");
  });

  it("records child gate receipts idempotently and rejects conflicting replay", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
    });
    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;

    const payload = "{\"ok\":true}";
    const receipt = {
      actionId: action.id,
      gateKind: "unit_acceptance" as const,
      evaluatorKind: "semantic" as const,
      subject: "1".repeat(40),
      result: "passed" as const,
      outcome: "success" as const,
      reason: "typed_semantic_result",
      artifactHashes: ["a".repeat(64)],
      payload,
      hash: digestNormalized(payload),
    };

    expect(store.recordGateReceipt(receipt)).toBe("recorded");
    expect(store.recordGateReceipt(receipt)).toBe("already_recorded");
    const conflictingPayload = "{\"ok\":false}";
    expect(() => store.recordGateReceipt({
      ...receipt,
      payload: conflictingPayload,
      hash: digestNormalized(conflictingPayload),
    }))
      .toThrow(/already recorded a different gate receipt/);
    expect(store.listGateReceipts("attempt-parent")).toEqual([
      expect.objectContaining({
        gate_kind: "unit_acceptance",
        unit_id: "a",
        result: "passed",
        outcome: "success",
      }),
    ]);
  });

  it("appends downstream context immutably for pending units only", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
    });
    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "b", payload: { summary: "not sealed yet" } }],
    })).toThrow(/source a is not integrated/);
    store.completeUnitAction({
      actionId: action.id,
      resultHash: "result-hash",
      outputSubject: "1".repeat(40),
    });

    const records = store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "b", payload: { summary: "use parser shape from unit a" } }],
    });

    expect(records).toEqual([
      expect.objectContaining({
        from_unit_id: "a",
        to_unit_id: "b",
        payload: "{\"summary\":\"use parser shape from unit a\"}",
      }),
    ]);
    expect(store.listDownstreamContext("attempt-parent", "b")).toEqual(records);
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "missing", payload: { summary: "not in graph" } }],
    })).toThrow(/unknown downstream context target/);
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "a", payload: { summary: "already integrated" } }],
    })).toThrow(/is not pending/);
  });

  it("stops active unit work without deleting child graph state", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
    });
    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;

    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "needs_human",
    })).toBe("stopped");
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBeUndefined();
    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "needs_human",
    })).toBe("already_stopped");
    const payload = "{\"ok\":true}";
    expect(() => store.recordGateReceipt({
      actionId: action.id,
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      subject: "1".repeat(40),
      result: "passed",
      outcome: "success",
      reason: "typed_semantic_result",
      artifactHashes: ["a".repeat(64)],
      payload,
      hash: digestNormalized(payload),
    })).toThrow(/is not receivable/);
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "pending", activeActionId: null }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
    expect(db!.prepare("SELECT status, last_error FROM execution_work_attempts WHERE id = ?").get(action.id)).toEqual({
      status: "dead",
      last_error: "needs_human",
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({
      parent_attempt_id: "attempt-parent",
      stopped_at: timestamp,
      stop_reason: "needs_human",
    });
  });

  it("records a graph stop fence before any child action is active", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
    });

    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "superseded",
    })).toBe("stopped");
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBeUndefined();
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "pending", activeActionId: null }),
    ]);
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({
      stopped_at: timestamp,
      stop_reason: "superseded",
    });
  });
});
