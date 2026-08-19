import { describe, expect, it, vi } from "vitest";
import type {
  HarnessAgentReport,
  HarnessReportEnvelope,
  UnitDecisionReceipt,
} from "@openthrottle/contracts";
import type { PipelineInstance } from "../pipeline/store.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { HarnessReportStore } from "../persistence/harness-report-store.js";
import { buildHarnessReportEnvelope, createHarnessReportProcessor } from "./harness-reporting.js";

const report: HarnessAgentReport = {
  component: "structured_loop",
  boundary: "gate_evaluation",
  failure_class: "evidence_binding_mismatch",
  observed_signals: ["conflicting_evidence"],
  suspected_cause: "context_binding",
  suggested_investigation: "inspect_context_binding",
  repeatability: "repeatable",
  confidence: "high",
};

const instance = {
  id: "instance-private-123",
  ticket_id: "customer-ticket-9",
  session_id: "session-private-123",
  repository: "secret-owner/private-repo",
  base_commit: "a".repeat(40),
  base_branch: "main",
  branch: "ot/private-work",
  published_commit: null,
  published_subject: null,
  runtime_release: "snapshot/v14",
} as PipelineInstance;

const action = {
  id: "action-private-123",
  execution_graph_id: "graph-private-123",
  execution_unit_id: "unit-private-123",
  parent_attempt_id: "attempt-private-123",
  parent_run_id: "run-private-123",
  unit_id: "unit-private-123",
  request_hash: "b".repeat(64),
  output_subject: null,
  cycle: 2,
} as ExecutionWorkAttempt;

const receipt = {
  payload: { harness_report: report },
  issued_at: "2026-08-17T00:00:00.000Z",
} as UnitDecisionReceipt;

const decision = {
  outcome: "semantic_repair_required",
  reason: "lead_requested_revision",
} as Parameters<ReturnType<typeof createHarnessReportProcessor>["capture"]>[0]["decision"];

function memoryStore() {
  const rows: HarnessReportEnvelope[] = [];
  const records: Array<{
    id: string;
    payload: string;
    payload_hash: string;
    status: "processing";
    attempts: number;
    next_attempt_at: string;
    processed_at: null;
    last_error: null;
    created_at: string;
    updated_at: string;
  }> = [];
  const markProcessed = vi.fn();
  const markFailed = vi.fn();
  const store: HarnessReportStore = {
    configureMode: vi.fn(() => null),
    enqueue(envelope, nowIso) {
      if (!rows.some((row) => row.report_id === envelope.report_id)) rows.push(envelope);
      return {
        id: envelope.report_id,
        payload: JSON.stringify(envelope),
        payload_hash: "c".repeat(64),
        status: "pending",
        attempts: 0,
        next_attempt_at: nowIso,
        processed_at: null,
        last_error: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
    },
    claim() {
      return records;
    },
    listRecoveryCandidates: vi.fn(() => []),
    markProcessed,
    markFailed,
    discardDisallowed: vi.fn(() => 0),
    prune: vi.fn(() => 0),
  };
  return { store, rows, records, markProcessed, markFailed };
}

function queueForDelivery(
  memory: ReturnType<typeof memoryStore>,
  envelope: HarnessReportEnvelope,
  attempts = 1
): void {
  memory.records.push({
    id: envelope.report_id,
    payload: JSON.stringify(envelope),
    payload_hash: "c".repeat(64),
    status: "processing",
    attempts,
    next_attempt_at: "2026-08-17T00:01:00.000Z",
    processed_at: null,
    last_error: null,
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
  });
}

describe("harness reporting", () => {
  it("sends no report when the operator setting is off", async () => {
    const memory = memoryStore();
    const fetch = vi.fn();
    const processor = createHarnessReportProcessor({ mode: "off", fetch });
    processor.capture({ instance, action, receipt, decision });
    await processor.drain();
    expect(memory.rows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps agent diagnosis out of deterministic receipts", () => {
    const memory = memoryStore();
    const processor = createHarnessReportProcessor({
      mode: "deterministic",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "token",
      store: memory.store,
    });
    processor.capture({ instance, action, receipt, decision });
    expect(memory.rows).toMatchObject([{
      mode: "deterministic",
      agent_report_status: "not_requested",
      receipt: { incident: { retry_count: 2, reason_code: "lead_requested_revision" } },
    }]);
    expect(memory.rows[0]).not.toHaveProperty("agent_report");
  });

  it("emits a deterministic receipt for a lead blocker without agent diagnosis", () => {
    const memory = memoryStore();
    const processor = createHarnessReportProcessor({
      mode: "deterministic",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "token",
      store: memory.store,
    });
    processor.capture({
      instance,
      action,
      receipt: {
        ...receipt,
        payload: { rationale: "The sealed evidence is insufficient.", context_updates: [] },
      },
      decision: { ...decision, outcome: "needs_human", reason: "lead_needs_human" },
    });
    expect(memory.rows).toMatchObject([{
      mode: "deterministic",
      agent_report_status: "not_requested",
      receipt: { incident: { outcome: "needs_human", reason_code: "lead_needs_human" } },
    }]);
  });

  it("records when on mode has no lead diagnosis for a deterministic blocker", () => {
    const memory = memoryStore();
    const processor = createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "token",
      store: memory.store,
    });
    processor.capture({
      instance,
      action,
      receipt: {
        ...receipt,
        payload: { rationale: "The sealed evidence is insufficient.", context_updates: [] },
      },
      decision: { ...decision, outcome: "needs_human", reason: "lead_needs_human" },
    });
    expect(memory.rows).toMatchObject([{ mode: "on", agent_report_status: "not_provided" }]);
  });

  it("includes privacy-safe lead context in on mode", () => {
    const memory = memoryStore();
    const processor = createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "token",
      store: memory.store,
    });
    processor.capture({ instance, action, receipt, decision });
    expect(memory.rows).toMatchObject([{
      mode: "on",
      agent_report_status: "included",
      agent_report: { failure_class: "evidence_binding_mismatch" },
    }]);
  });

  it("recovers a settled lead with a missing outbox row exactly once after restart", () => {
    const memory = memoryStore();
    vi.mocked(memory.store.listRecoveryCandidates).mockReturnValue([{
      instance_id: instance.id,
      runtime_release: instance.runtime_release,
      action_id: action.id,
      cycle: action.cycle,
      receipt: JSON.stringify({ ...receipt, type: "unit_decision" }),
      outcome: decision.outcome,
      reason: decision.reason,
      completed_at: "2026-08-17T00:00:01.000Z",
    }]);
    const createRestartedProcessor = () => createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "token",
      store: memory.store,
      recoverySinceIso: "2026-08-17T00:00:00.000Z",
      now: () => new Date("2026-08-17T00:01:00.000Z"),
    });

    expect(memory.rows).toEqual([]);
    createRestartedProcessor().reconcile();
    expect(memory.rows).toHaveLength(1);

    createRestartedProcessor().reconcile();
    expect(memory.rows).toHaveLength(1);
  });

  it("delivers with occurrence idempotency and validates the backend receipt", async () => {
    const memory = memoryStore();
    const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
    queueForDelivery(memory, envelope);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      schema: "openthrottle.harness-report-receipt/v1",
      report_id: memory.records[0]!.id,
      status: "queued",
    }), { status: 202 }));
    const processor = createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "report-token",
      store: memory.store,
      fetch,
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });

    await processor.drain();

    expect(fetch).toHaveBeenCalledWith(
      "https://reports.test/v1/harness-incidents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer report-token",
          "idempotency-key": memory.records[0]!.id,
        }),
      })
    );
    expect(memory.markProcessed).toHaveBeenCalledWith(
      memory.records[0]!.id,
      memory.records[0]!.payload_hash,
      "2026-08-17T00:00:00.000Z"
    );
  });

  it.each([
    { status: 400, retryable: false },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])("classifies HTTP $status delivery failures", async ({ status, retryable }) => {
    const memory = memoryStore();
    const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
    queueForDelivery(memory, envelope);
    const processor = createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "report-token",
      store: memory.store,
      fetch: vi.fn(async () => new Response("rejected", { status })),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });

    await processor.drain();

    expect(memory.markProcessed).not.toHaveBeenCalled();
    expect(memory.markFailed).toHaveBeenCalledWith(
      envelope.report_id,
      "c".repeat(64),
      expect.stringContaining(`HTTP ${status}`),
      retryable ? expect.any(String) : null,
      "2026-08-17T00:00:00.000Z"
    );
  });

  it("marks malformed typed success receipts and oversized bodies permanent", async () => {
    for (const response of [
      new Response(JSON.stringify({ schema: "wrong", report_id: "wrong", status: "queued" }), {
        status: 202,
      }),
      new Response("{}", { status: 202, headers: { "content-length": String(17 * 1024) } }),
    ]) {
      const memory = memoryStore();
      const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
      queueForDelivery(memory, envelope);
      const processor = createHarnessReportProcessor({
        mode: "on",
        endpoint: "https://reports.test/v1/harness-incidents",
        token: "report-token",
        store: memory.store,
        fetch: vi.fn(async () => response),
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });

      await processor.drain();

      expect(memory.markFailed).toHaveBeenCalledWith(
        envelope.report_id,
        "c".repeat(64),
        expect.stringMatching(/invalid receipt|oversized receipt/),
        null,
        "2026-08-17T00:00:00.000Z"
      );
    }
  });

  it("never sends a queued on envelope while running in deterministic mode", async () => {
    const memory = memoryStore();
    const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
    queueForDelivery(memory, envelope);
    const fetch = vi.fn();
    const processor = createHarnessReportProcessor({
      mode: "deterministic",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "report-token",
      store: memory.store,
      fetch,
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });

    await processor.drain();

    expect(fetch).not.toHaveBeenCalled();
    expect(memory.markFailed).toHaveBeenCalledWith(
      envelope.report_id,
      "c".repeat(64),
      "reporting mode no longer permits queued envelope",
      null,
      "2026-08-17T00:00:00.000Z"
    );
  });

  it("retries thrown transport failures but stops at the attempt budget", async () => {
    for (const attempts of [1, 10]) {
      const memory = memoryStore();
      const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
      queueForDelivery(memory, envelope, attempts);
      const processor = createHarnessReportProcessor({
        mode: "on",
        endpoint: "https://reports.test/v1/harness-incidents",
        token: "report-token",
        store: memory.store,
        fetch: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });

      await processor.drain();

      expect(memory.markFailed).toHaveBeenCalledWith(
        envelope.report_id,
        "c".repeat(64),
        "network unavailable",
        attempts < 10 ? expect.any(String) : null,
        "2026-08-17T00:00:00.000Z"
      );
    }
  });

  it("marks a mismatched success receipt permanent", async () => {
    const memory = memoryStore();
    const envelope = buildHarnessReportEnvelope({ mode: "on", instance, action, receipt, decision });
    const mismatchedReportId = `${envelope.report_id.startsWith("0") ? "1" : "0"}${envelope.report_id.slice(1)}`;
    queueForDelivery(memory, envelope);
    const processor = createHarnessReportProcessor({
      mode: "on",
      endpoint: "https://reports.test/v1/harness-incidents",
      token: "report-token",
      store: memory.store,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        schema: "openthrottle.harness-report-receipt/v1",
        report_id: mismatchedReportId,
        status: "queued",
      }), { status: 202 })),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });

    await processor.drain();

    expect(memory.markFailed).toHaveBeenCalledWith(
      envelope.report_id,
      "c".repeat(64),
      "harness reporting backend receipt id mismatch",
      null,
      "2026-08-17T00:00:00.000Z"
    );
  });
});
