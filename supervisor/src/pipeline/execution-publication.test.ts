import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import {
  buildExecutionPublicationSnapshot,
  executionLedgerLines,
  MAX_ACTIVITY_LOG_BYTES,
  MAX_STRUCTURED_LEDGER_BYTES,
  type ExecutionPublicationSnapshot,
} from "./execution-publication.js";

describe("execution publication", () => {
  it("renders a sanitized unit and gate ledger snapshot", () => {
    const gatePayload = canonicalJson({ decision: "accept", reason: "scope matched" });
    const snapshot = buildExecutionPublicationSnapshot({
      graph: {
        id: "graph-1",
        parent_attempt_id: "attempt-parent",
        parent_stage_id: "units",
        integration_subject: "2".repeat(40),
        aggregate_artifact_hash: "aggregate-hash",
        aggregate_emitted_at: "2026-07-29T00:03:00.000Z",
        stopped_at: null,
        stop_reason: null,
      },
      units: [
        {
          id: "execution-unit-a",
          unitId: "U1",
          ordinal: 0,
          dependencies: [],
          status: "completed",
          activeActionId: null,
          phase: "integrate",
          currentCycle: 1,
          repairRounds: 0,
          commandIndex: 0,
          acceptedCandidateSubject: "1".repeat(40),
          integrationSubject: "1".repeat(40),
          terminalLevel: "completed",
          alarm: false,
        },
        {
          id: "execution-unit-b",
          unitId: "U2",
          ordinal: 1,
          dependencies: ["U1"],
          status: "failed",
          activeActionId: null,
          phase: "implement",
          currentCycle: 1,
          repairRounds: 0,
          commandIndex: 0,
          acceptedCandidateSubject: null,
          integrationSubject: null,
          terminalLevel: "failed",
          alarm: true,
        },
      ],
      attempts: [{
        id: "action-1",
        unit_id: "U1",
        attempt_ordinal: 1,
        action_kind: "implement",
        request_hash: "request-hash",
        result_hash: "result-hash",
        native_session_id: "native-session",
        status: "completed",
        output_subject: "1".repeat(40),
        last_error: null,
      }],
      gates: [{
        unit_id: "U1",
        gate_kind: "unit_acceptance",
        evaluator_kind: "human",
        subject: "1".repeat(40),
        result: "passed",
        outcome: "success",
        reason: "Accepted with token sk-example-secret redacted.",
        artifact_hashes: canonicalJson(["artifact-hash"]),
        receipt_hash: digestNormalized(gatePayload),
      }],
      downstreamContext: [{
        from_unit_id: "U1",
        to_unit_id: "U2",
        payload: canonicalJson({ summary: "Reuse the parser helper." }),
        payload_hash: "context-hash",
      }],
    })!;

    expect(snapshot.units).toHaveLength(2);
    expect(snapshot.units[0]?.gates[0]?.reason).toContain("[REDACTED]");
    expect(executionLedgerLines(snapshot)).toEqual(expect.arrayContaining([
      "- U1: completed (no alarm); state=completed `111111111111`",
      "  - unit_acceptance: passed/success by human `111111111111` - Accepted with token [REDACTED] redacted.",
      "  - context to U2: Reuse the parser helper.",
      "- U2: failed (alarm); state=failed",
      "Whole change: subject `222222222222`; aggregate=aggregate-hash",
    ]));
  });

  it("bounds the activity log to an explicit byte budget, dropping the oldest entries first at the exact boundary", () => {
    // 9 single-digit sequence numbers keep every rendered line the same
    // length, so the byte budget lands on an exact 8-kept/1-dropped split:
    // "- [1] k: " is a fixed 9-char prefix, +1 for the newline the bounding
    // helper counts per line, so bodyLength is chosen so each full line is
    // exactly MAX_ACTIVITY_LOG_BYTES / 8 bytes -- 8 lines exactly fill the
    // budget and the 9th (oldest) line would push it over.
    const totalEvents = 9;
    const perLineBytes = MAX_ACTIVITY_LOG_BYTES / (totalEvents - 1);
    const fixedOverhead = "- [1] k: ".length + 1;
    const bodyLength = perLineBytes - fixedOverhead;
    const snapshot: ExecutionPublicationSnapshot = {
      graph: {
        id: "graph-1",
        parent_attempt_id: "attempt-parent",
        parent_stage_id: "units",
        integration_subject: null,
        aggregate_artifact_hash: null,
        aggregate_emitted_at: null,
        stopped_at: null,
        stop_reason: null,
      },
      units: [],
      activity_log: Array.from({ length: totalEvents }, (_, index) => ({
        sequence: index + 1,
        kind: "k",
        unit_id: null,
        body: "b".repeat(bodyLength),
      })),
    };

    const lines = executionLedgerLines(snapshot);
    const logLines = lines.filter((line) => line.startsWith("- ["));

    expect(logLines).toHaveLength(totalEvents - 1);
    expect(logLines[0]).toContain("[2]");
    expect(logLines[logLines.length - 1]).toContain(`[${totalEvents}]`);
    expect(lines.some((line) => line.includes("1 earlier entries omitted"))).toBe(true);
  });

  it("bounds the unit ledger to the aggregate structured-ledger byte budget, dropping the oldest units first at the exact boundary", () => {
    // 9 single-digit unit ordinals keep every rendered unit line the same
    // length, so padding the unit id lands the aggregate budget on an exact
    // 8-kept/1-dropped split, mirroring the activity-log boundary test above.
    const totalUnits = 9;
    const perBlockBytes = MAX_STRUCTURED_LEDGER_BYTES / (totalUnits - 1);
    const suffix = ": completed (no alarm); state=completed";
    const fixedOverhead = "- U1".length + suffix.length + 1;
    const padLength = perBlockBytes - fixedOverhead;
    const snapshot: ExecutionPublicationSnapshot = {
      graph: {
        id: "graph-1",
        parent_attempt_id: "attempt-parent",
        parent_stage_id: "units",
        integration_subject: null,
        aggregate_artifact_hash: null,
        aggregate_emitted_at: null,
        stopped_at: null,
        stop_reason: null,
      },
      units: Array.from({ length: totalUnits }, (_, index) => ({
        unit_id: `U${index + 1}${"x".repeat(padLength)}`,
        ordinal: index,
        dependencies: [],
        status: "completed" as const,
        terminal_level: "completed" as const,
        alarm: false,
        active_action_id: null,
        integration_subject: null,
        attempts: [],
        gates: [],
        downstream_context: [],
      })),
    };

    const lines = executionLedgerLines(snapshot);
    const unitLines = lines.filter((line) => line.startsWith("- U"));

    expect(unitLines).toHaveLength(totalUnits - 1);
    expect(unitLines[0]).toContain("U2x");
    expect(unitLines[unitLines.length - 1]).toContain(`U${totalUnits}x`);
    expect(lines.some((line) => line.includes("1 earlier unit(s) omitted"))).toBe(true);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(MAX_STRUCTURED_LEDGER_BYTES + 100);
  });

  it("reserves the activity log's own budget first, so a huge unit ledger cannot starve the durable activity log", () => {
    const snapshot: ExecutionPublicationSnapshot = {
      graph: {
        id: "graph-1",
        parent_attempt_id: "attempt-parent",
        parent_stage_id: "units",
        integration_subject: null,
        aggregate_artifact_hash: null,
        aggregate_emitted_at: null,
        stopped_at: null,
        stop_reason: null,
      },
      units: Array.from({ length: 64 }, (_, index) => ({
        unit_id: `U${index + 1}`,
        ordinal: index,
        dependencies: [],
        status: "completed" as const,
        terminal_level: "completed" as const,
        alarm: false,
        active_action_id: null,
        integration_subject: null,
        attempts: [],
        gates: [{
          kind: "unit_acceptance",
          evaluator: "human",
          result: "passed",
          outcome: "success",
          subject: null,
          reason: "r".repeat(1_000),
          artifact_hashes: [],
          receipt_hash: "receipt-hash",
        }],
        downstream_context: [],
      })),
      activity_log: [
        { sequence: 1, kind: "unit_settled", unit_id: "U1", body: "Unit U1 completed." },
      ],
    };

    const lines = executionLedgerLines(snapshot);
    expect(lines).toContain("**Structured Activity Log** (ordered)");
    expect(lines).toContain("- [1] `U1` unit_settled: Unit U1 completed.");
    expect(lines.some((line) => line.includes("earlier unit(s) omitted"))).toBe(true);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThan(MAX_STRUCTURED_LEDGER_BYTES + 1_100);
  });
});
