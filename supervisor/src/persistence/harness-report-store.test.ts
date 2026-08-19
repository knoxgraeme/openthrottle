import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessReportEnvelope } from "@openthrottle/contracts";
import { openDb } from "./database.js";
import { createHarnessReportStore } from "./harness-report-store.js";

const envelope: HarnessReportEnvelope = {
  schema: "openthrottle.harness-report-envelope/v1",
  report_id: "40a4dc62-c95e-4e8d-9f15-b5861b0d60a6",
  mode: "deterministic",
  privacy_profile: "closed-vocabulary/v1",
  receipt: {
    schema: "openthrottle.harness-incident/v1",
    runtime: {
      runtime_release: "snapshot/v14",
      protocol: "stage-executor/1",
      capability: "accept-unit/1",
    },
    incident: {
      component: "structured_loop",
      boundary: "gate_evaluation",
      operation: "lead",
      outcome: "revise",
      reason_code: "lead_requested_revision",
      retry_count: 1,
    },
  },
  agent_report_status: "not_requested",
};

describe("harness report store", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  it("enqueues exact replays idempotently but rejects id reuse", () => {
    const store = createHarnessReportStore(db);
    const first = store.enqueue(envelope, "2026-08-17T00:00:00.000Z");
    const replay = store.enqueue(envelope, "2026-08-17T00:00:01.000Z");
    expect(replay).toEqual(first);

    expect(() => store.enqueue({
      ...envelope,
      receipt: {
        ...envelope.receipt,
        incident: { ...envelope.receipt.incident, outcome: "accept" },
      },
    }, "2026-08-17T00:00:02.000Z")).toThrow(/conflicts/);
  });

  it("preserves the opt-in start across restarts and resets it on mode changes", () => {
    const store = createHarnessReportStore(db);
    expect(store.configureMode("on", "2026-08-17T00:00:00.000Z"))
      .toBe("2026-08-17T00:00:00.000Z");
    expect(store.configureMode("on", "2026-08-17T00:01:00.000Z"))
      .toBe("2026-08-17T00:00:00.000Z");
    expect(store.configureMode("off", "2026-08-17T00:02:00.000Z")).toBeNull();
    expect(store.configureMode("deterministic", "2026-08-17T00:03:00.000Z"))
      .toBe("2026-08-17T00:03:00.000Z");
  });

  it("derives recovery candidates from durable completed lead and gate receipts", () => {
    const store = createHarnessReportStore(db);
    db.pragma("foreign_keys = OFF");
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 1, ?, '{}', ?, ?, ?, ?, ?, ?, ?, '[]', 'running', ?, ?)
    `).run(
      "instance-1", "issue-1", "session-1", "structured", "a".repeat(64),
      "owner/repo", "b".repeat(40), "config-1", "c".repeat(64), "runtime/v1",
      "d".repeat(64), "stage-executor@1", "2026-08-17T00:00:00.000Z",
      "2026-08-17T00:00:00.000Z"
    );
    const settledReceipt = JSON.stringify({
      type: "unit_decision",
      payload: { harness_report: envelope.agent_report ?? {
        component: "structured_loop",
        boundary: "gate_evaluation",
        failure_class: "evidence_binding_mismatch",
        observed_signals: ["conflicting_evidence"],
        repeatability: "repeatable",
        confidence: "high",
      } },
    });
    db.prepare(`
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id,
        parent_attempt_id, parent_run_id, unit_id, attempt_ordinal, action_kind,
        cycle, idempotency_key, result_hash, receipt, status, output_subject,
        payload, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'lead', 2, ?, ?, ?, 'completed', ?, '{}', ?, ?, ?)
    `).run(
      "lead-1", "graph-1", "unit-row-1", "instance-1", "attempt-1", "run-1", "unit-1",
      "lead-key", "result-1", settledReceipt, "e".repeat(40),
      "2026-08-17T00:00:00.000Z", "2026-08-17T00:00:01.000Z",
      "2026-08-17T00:00:01.000Z"
    );
    db.prepare(`
      INSERT INTO execution_gate_receipts (
        id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
        parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
        outcome, reason, artifact_hashes, payload, receipt_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'unit_acceptance', 'human', ?, 'failed',
        'semantic_repair_required', 'lead_requested_revision', '[]', '{}', ?, ?)
    `).run(
      "gate-1", "graph-1", "unit-row-1", "lead-1", "attempt-1", "unit-1",
      "e".repeat(40), "f".repeat(64), "2026-08-17T00:00:01.000Z"
    );
    db.pragma("foreign_keys = ON");

    expect(store.listRecoveryCandidates("2026-08-17T00:00:00.000Z")).toEqual([{
      instance_id: "instance-1",
      runtime_release: "runtime/v1",
      action_id: "lead-1",
      cycle: 2,
      receipt: settledReceipt,
      outcome: "semantic_repair_required",
      reason: "lead_requested_revision",
      completed_at: "2026-08-17T00:00:01.000Z",
    }]);
    expect(store.listRecoveryCandidates("2026-08-17T00:00:02.000Z")).toEqual([]);
  });

  it("leases due rows and fences late settlement by payload hash", () => {
    const store = createHarnessReportStore(db);
    const row = store.enqueue(envelope, "2026-08-17T00:00:00.000Z");
    const claimed = store.claim(
      "2026-08-17T00:00:01.000Z",
      "2026-08-17T00:01:01.000Z",
      20
    );
    expect(claimed).toMatchObject([{ id: envelope.report_id, status: "processing", attempts: 1 }]);

    store.markProcessed(row.id, "stale", "2026-08-17T00:00:02.000Z");
    expect(db.prepare("SELECT status FROM harness_report_outbox WHERE id = ?").get(row.id))
      .toEqual({ status: "processing" });

    store.markFailed(
      row.id,
      row.payload_hash,
      "temporary",
      "2026-08-17T00:02:00.000Z",
      "2026-08-17T00:00:03.000Z"
    );
    expect(db.prepare(`
      SELECT status, next_attempt_at, last_error FROM harness_report_outbox WHERE id = ?
    `).get(row.id)).toEqual({
      status: "failed",
      next_attempt_at: "2026-08-17T00:02:00.000Z",
      last_error: "temporary",
    });
  });

  it("reclaims an expired processing lease without duplicating the row", () => {
    const store = createHarnessReportStore(db);
    const row = store.enqueue(envelope, "2026-08-17T00:00:00.000Z");
    store.claim("2026-08-17T00:00:01.000Z", "2026-08-17T00:01:01.000Z", 1);
    expect(store.claim("2026-08-17T00:01:00.000Z", "2026-08-17T00:02:00.000Z", 1)).toEqual([]);
    expect(store.claim("2026-08-17T00:01:01.000Z", "2026-08-17T00:02:01.000Z", 1))
      .toMatchObject([{ id: row.id, status: "processing", attempts: 2 }]);
    expect(db.prepare("SELECT COUNT(*) FROM harness_report_outbox").pluck().get()).toBe(1);
  });

  it("moves permanent failures off the retry clock", () => {
    const store = createHarnessReportStore(db);
    const row = store.enqueue(envelope, "2026-08-17T00:00:00.000Z");
    store.claim("2026-08-17T00:00:01.000Z", "2026-08-17T00:01:01.000Z", 1);
    store.markFailed(row.id, row.payload_hash, "invalid", null, "2026-08-17T00:00:02.000Z");
    expect(db.prepare(`
      SELECT status, next_attempt_at FROM harness_report_outbox WHERE id = ?
    `).get(row.id)).toEqual({ status: "dead", next_attempt_at: null });
  });

  it("discards queued reports that a stricter current mode no longer permits", () => {
    const store = createHarnessReportStore(db);
    store.enqueue(envelope, "2026-08-17T00:00:00.000Z");
    store.enqueue({
      ...envelope,
      report_id: "a0a4dc62-c95e-4e8d-9f15-b5861b0d60a6",
      mode: "on",
      agent_report_status: "included",
      agent_report: {
        component: "structured_loop",
        boundary: "gate_evaluation",
        failure_class: "evidence_binding_mismatch",
        observed_signals: ["conflicting_evidence"],
        suspected_cause: "context_binding",
        suggested_investigation: "inspect_context_binding",
        repeatability: "repeatable",
        confidence: "high",
      },
    }, "2026-08-17T00:00:00.000Z");

    expect(store.discardDisallowed("deterministic", "2026-08-17T00:01:00.000Z")).toBe(1);
    expect(db.prepare(`
      SELECT mode, status FROM (
        SELECT json_extract(payload, '$.mode') AS mode, status FROM harness_report_outbox
      ) ORDER BY mode
    `).all()).toEqual([
      { mode: "deterministic", status: "pending" },
      { mode: "on", status: "dead" },
    ]);
    expect(store.discardDisallowed("off", "2026-08-17T00:02:00.000Z")).toBe(1);
  });

  it("prunes only terminal reports outside the retention window", () => {
    const store = createHarnessReportStore(db);
    const row = store.enqueue(envelope, "2026-08-01T00:00:00.000Z");
    store.claim("2026-08-01T00:00:01.000Z", "2026-08-01T00:01:01.000Z", 1);
    store.markProcessed(row.id, row.payload_hash, "2026-08-01T00:00:02.000Z");

    expect(store.prune("2026-08-02T00:00:00.000Z", 100)).toBe(1);
    expect(db.prepare("SELECT id FROM harness_report_outbox WHERE id = ?").get(row.id))
      .toBeUndefined();
  });
});
