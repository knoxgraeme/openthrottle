import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  type AttemptCheckpoint,
} from "@openthrottle/contracts";
import { describe, expect, it } from "vitest";
import {
  structuredSuccessorCheckpoints,
  type StructuredWaveEvidence,
} from "./kernel-structured-wave.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

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
