import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  type AttemptCheckpoint,
} from "@openthrottle/contracts";
import { describe, expect, it } from "vitest";
import {
  structuredSuccessorCheckpoints,
  structuredWaveSuccessorContextRecords,
  type StructuredWaveEvidence,
} from "./kernel-structured-wave.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RUN_ID = "run-1";

type SettlementDecision = Parameters<
  typeof structuredWaveSuccessorContextRecords
>[0]["settlement_decision"];

function checkpoint(id: string, input: string, output: string): AttemptCheckpoint {
  return {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id,
    pipeline_run_id: "run-1",
    attempt_id: `attempt-${id}`,
    request_hash: id.padEnd(64, "0").slice(0, 64),
    definition_bundle_hash: "d".repeat(64),
    input_subject: input,
    output_subject: output,
    native_session_id: `session-${id}`,
    payload_schema: "openthrottle.test-checkpoint/v1",
    payload: { inline: { exact: true } },
    captured_at: "2026-08-22T00:00:00.000Z",
  };
}

function waveEvidence(input: {
  attempt_id: string;
  result_id: string;
  decision_id: string;
}): StructuredWaveEvidence {
  return {
    attempt: { id: input.attempt_id, pipeline_run_id: RUN_ID },
    result: { id: input.result_id, pipeline_run_id: RUN_ID },
    decision: { id: input.decision_id, pipeline_run_id: RUN_ID },
  } as unknown as StructuredWaveEvidence;
}

function settlementDecision(id: string, pipelineRunId = RUN_ID): SettlementDecision {
  return { id, pipeline_run_id: pipelineRunId } as unknown as SettlementDecision;
}

describe("structured successor checkpoints", () => {
  it("preserves the cumulative boundary after a content-no-op edit", () => {
    const inherited = checkpoint("checkpoint-inherited", A, B);
    const current = checkpoint("checkpoint-current", B, B);
    const evidence = {
      member_id: "unit-a",
      attempt: { input_subject: B, output_subject: B },
      checkpoint: current,
      request_inputs: {
        context: { checkpoints: new Map([[inherited.id, inherited]]) },
      },
    } as unknown as StructuredWaveEvidence;

    expect(structuredSuccessorCheckpoints(evidence)).toEqual([inherited]);
  });
});

describe("structured wave successor records", () => {
  it("replaces a transient current-member decision with the aggregate settlement decision", () => {
    const prior = waveEvidence({
      attempt_id: "attempt-prior",
      result_id: "result-prior",
      decision_id: "decision-prior",
    });
    const current = waveEvidence({
      attempt_id: "attempt-current",
      result_id: "result-current",
      decision_id: "decision-current-transient",
    });
    const aggregate = settlementDecision("decision-aggregate");

    expect(structuredWaveSuccessorContextRecords({
      evidence: [prior, current],
      current_attempt_id: current.attempt.id,
      settlement_decision: aggregate,
    }).map(({ id }) => id)).toEqual([
      aggregate.id,
      prior.decision.id,
      prior.result.id,
      current.result.id,
    ].sort());
  });

  it("fails closed when the current member or record run is not exact", () => {
    const evidence = [waveEvidence({
      attempt_id: "attempt-prior",
      result_id: "result-prior",
      decision_id: "decision-prior",
    })];
    const aggregate = settlementDecision("decision-aggregate");

    expect(() => structuredWaveSuccessorContextRecords({
      evidence,
      current_attempt_id: "attempt-missing",
      settlement_decision: aggregate,
    })).toThrow("structured wave successor has no exact current member");
    expect(() => structuredWaveSuccessorContextRecords({
      evidence,
      current_attempt_id: "attempt-prior",
      settlement_decision: settlementDecision(aggregate.id, "run-foreign"),
    })).toThrow("structured wave successor contains another run's record");
    expect(() => structuredWaveSuccessorContextRecords({
      evidence,
      current_attempt_id: "attempt-prior",
      settlement_decision: { ...aggregate, id: evidence[0]!.result.id },
    })).toThrow("structured wave successor contains duplicate record IDs");
  });
});
