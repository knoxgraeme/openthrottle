import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { insertGateReceipt, markActionCompleted } from "./unit-store-phase-reducer.js";
import type { ExecutionWorkAttempt } from "./unit-store.js";

function fakeAction(): ExecutionWorkAttempt {
  return {
    id: "action-1",
    execution_graph_id: "graph-1",
    execution_unit_id: "unit-1",
    pipeline_instance_id: "pipeline-1",
    parent_attempt_id: "parent-1",
    parent_run_id: "run-1",
    unit_id: "unit-1",
    attempt_ordinal: 1,
    action_kind: "lead",
    cycle: 0,
    command_name: null,
    idempotency_key: "idem-1",
    request_hash: null,
    result_hash: "1".repeat(64),
    terminal_result_outcome: null,
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    status: "completed",
    lease_owner: null,
    lease_until: null,
    observation_failure_count: 0,
    observation_retry_at: null,
    observation_epoch: 0,
    output_subject: null,
    payload: "{}",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    completed_at: "2026-08-08T00:00:00.000Z",
    last_error: null,
  };
}

// GATE_RECEIPT_REASONS/STAGE_OUTCOMES have no other production importer, so
// insertGateReceipt is the only runtime enforcement point short of the DB
// CHECK constraint. These assert the fail-closed validation fires before any
// write is attempted -- a bare, tableless DB proves it never reaches SQL.
// markActionCompleted's UPDATE is fenced on the active statuses. Both store
// callers pre-check the loaded status in the same transaction, so the throw is
// today's unreachable backstop; these prove the fence itself fails closed
// instead of silently dropping a completion. A minimal table is enough -- the
// helper touches only execution_work_attempts.
describe("markActionCompleted", () => {
  function actionTable(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE execution_work_attempts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        result_hash TEXT,
        output_subject TEXT,
        receipt TEXT,
        receipt_hash TEXT,
        native_session_id TEXT,
        completed_at TEXT,
        updated_at TEXT
      );
    `);
    return db;
  }

  it("completes an active action exactly once", () => {
    const db = actionTable();
    db.prepare("INSERT INTO execution_work_attempts (id, status) VALUES ('action-1', 'running')").run();

    markActionCompleted(db, {
      action: fakeAction(),
      resultHash: "1".repeat(64),
      outputSubject: "a".repeat(40),
      timestamp: "2026-08-14T00:00:00.000Z",
    });

    expect(db.prepare("SELECT status, output_subject FROM execution_work_attempts WHERE id = 'action-1'").get())
      .toEqual({ status: "completed", output_subject: "a".repeat(40) });
  });

  it("fails closed instead of silently dropping a completion for an inactive action", () => {
    const db = actionTable();
    for (const status of ["completed", "failed"]) {
      db.prepare("DELETE FROM execution_work_attempts").run();
      db.prepare("INSERT INTO execution_work_attempts (id, status) VALUES ('action-1', ?)").run(status);

      expect(() => markActionCompleted(db, {
        action: fakeAction(),
        resultHash: "1".repeat(64),
        outputSubject: "a".repeat(40),
        timestamp: "2026-08-14T00:00:00.000Z",
      })).toThrow("execution work attempt action-1 is not active");
      expect(db.prepare("SELECT status FROM execution_work_attempts WHERE id = 'action-1'").get())
        .toEqual({ status });
    }
  });
});

describe("insertGateReceipt", () => {
  it("fails closed on an unrecognized outcome before touching the database", () => {
    const db = new Database(":memory:");
    expect(() => insertGateReceipt(db, () => "2026-08-08T00:00:00.000Z", {
      action: fakeAction(),
      gateKind: "unit_acceptance",
      evaluatorKind: "human",
      subject: null,
      result: "passed",
      outcome: "not_a_real_outcome" as never,
      reason: "lead_scope_match_accept",
      artifactHashes: [],
      payload: "{}",
      hash: "2".repeat(64),
    })).toThrow(/unrecognized outcome/);
  });

  it("fails closed on an unrecognized reason before touching the database", () => {
    const db = new Database(":memory:");
    expect(() => insertGateReceipt(db, () => "2026-08-08T00:00:00.000Z", {
      action: fakeAction(),
      gateKind: "unit_acceptance",
      evaluatorKind: "human",
      subject: null,
      result: "passed",
      outcome: "success",
      reason: "not_a_real_reason" as never,
      artifactHashes: [],
      payload: "{}",
      hash: "2".repeat(64),
    })).toThrow(/unrecognized reason/);
  });
});
