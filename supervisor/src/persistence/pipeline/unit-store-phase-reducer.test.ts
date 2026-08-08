import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { insertGateReceipt } from "./unit-store-phase-reducer.js";
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
