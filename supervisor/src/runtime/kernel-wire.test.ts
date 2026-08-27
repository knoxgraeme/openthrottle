import { describe, expect, it, vi } from "vitest";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
  type KernelResultCorrectionRequest,
} from "./kernel-contracts.js";
import {
  ATTEMPT_CHECKPOINT_WIRE_SCHEMA,
  KERNEL_RUNTIME_RESULT_SCHEMA,
  parseKernelRuntimeResult,
} from "./kernel-wire.js";
import { ordinaryCheckpointRefForCommit } from "./kernel-checkpoint-bundle.js";

const INPUT_SUBJECT = "1".repeat(40);
const EDITED_SUBJECT = "2".repeat(40);
const INSPECT_CHECKPOINT_COMMIT = "3".repeat(40);
const REQUEST_HASH = "a".repeat(64);
const BUNDLE_HASH = "b".repeat(64);
const ARTIFACT_DIGEST = "c".repeat(64);

function correctionRequest(
  completedWorkAuthority: "inspect" | "edit",
): KernelResultCorrectionRequest {
  return {
    schema: KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
    phase: "result_correction",
    engine: "codex",
    model: null,
    reasoning_effort: null,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    stage_id: "stage-1",
    scope: { kind: "stage", stage_id: "stage-1" },
    request_hash: REQUEST_HASH,
    definition_bundle_hash: BUNDLE_HASH,
    checkpoint_base_subject: INPUT_SUBJECT,
    input_subject: INPUT_SUBJECT,
    locked_subject: completedWorkAuthority === "edit" ? EDITED_SUBJECT : INPUT_SUBJECT,
    completed_work_authority: completedWorkAuthority,
    checkpoint_id: "checkpoint-1",
    native_session_id: "session-1",
    lease_id: "lease-1",
    worker_id: "worker-1",
    correction_deadline: "2026-08-20T13:00:00.000Z",
    diagnostics: [{ path: "/payload/summary", detail: "must be a string" }],
    semantic_result_schema: {
      schema: "openthrottle.semantic-result-schema/v1",
      id: "result-schema",
      outcomes: ["success"],
      payload: {},
    },
    execution_limits: { max_turns: null, task_timeout_seconds: 900 },
    repository_authority: "inspect",
    tools: ["ot-result"],
    mcp: false,
    provider_access: false,
  } as KernelResultCorrectionRequest;
}

function rawCorrectionResult(input: {
  request: KernelResultCorrectionRequest;
  outputSubject: string | null;
  artifactCommit?: string;
  artifactRef?: string;
}): string {
  return JSON.stringify({
    schema: KERNEL_RUNTIME_RESULT_SCHEMA,
    pipeline_run_id: input.request.pipeline_run_id,
    attempt_id: input.request.attempt_id,
    request_hash: input.request.request_hash,
    definition_bundle_hash: input.request.definition_bundle_hash,
    lease_id: input.request.lease_id,
    worker_id: input.request.worker_id,
    outcome: {
      state: "needs_human",
      reason: "correction remains invalid",
      checkpoint: {
        schema: ATTEMPT_CHECKPOINT_WIRE_SCHEMA,
        id: input.request.checkpoint_id,
        pipeline_run_id: input.request.pipeline_run_id,
        attempt_id: input.request.attempt_id,
        request_hash: input.request.request_hash,
        definition_bundle_hash: input.request.definition_bundle_hash,
        input_subject: input.request.input_subject,
        output_subject: input.outputSubject,
        native_session_id: input.request.native_session_id,
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        payload_artifact: {
          file: "checkpoint.bundle",
          sha256: ARTIFACT_DIGEST,
          bytes: 1,
          media_type: "application/x-git-bundle",
          payload_schema: "openthrottle.git-checkpoint-bundle/v1",
          ref: input.artifactRef ?? `refs/openthrottle/checkpoints/${REQUEST_HASH}`,
          commit: input.artifactCommit ?? input.request.locked_subject,
          tree: "d".repeat(40),
        },
        captured_at: "2026-08-20T12:00:00.000Z",
      },
      candidate_hash: null,
      diagnostics: input.request.diagnostics,
    },
  });
}

function artifacts() {
  return {
    materialize: vi.fn().mockResolvedValue({
      algorithm: "sha256",
      digest: ARTIFACT_DIGEST,
      bytes: 1,
      encoding: "binary",
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    }),
  };
}

describe("kernel correction checkpoint wire fencing", () => {
  it("uses the versioned executor protocol that requires sealed limits and bootstrap commands", () => {
    expect(KERNEL_ACTION_REQUEST_SCHEMA).toBe("openthrottle.kernel-action-request/v2");
    expect(KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA)
      .toBe("openthrottle.kernel-result-correction-request/v2");
  });

  it("retains a null output subject when an inspect checkpoint uses a synthetic bundle commit", async () => {
    const request = correctionRequest("inspect");

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({
        request,
        outputSubject: null,
        artifactCommit: INSPECT_CHECKPOINT_COMMIT,
      }),
      request,
      artifacts: artifacts(),
    })).resolves.toMatchObject({
      state: "needs_human",
      checkpoint: {
        input_subject: INPUT_SUBJECT,
        output_subject: null,
      },
    });

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({
        request,
        outputSubject: INSPECT_CHECKPOINT_COMMIT,
        artifactCommit: INSPECT_CHECKPOINT_COMMIT,
      }),
      request,
      artifacts: artifacts(),
    })).rejects.toThrow(/repository authority/);
  });

  it("accepts a stable commit-derived checkpoint ref while retaining legacy request refs", async () => {
    const request = correctionRequest("inspect");

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({
        request,
        outputSubject: null,
        artifactCommit: INSPECT_CHECKPOINT_COMMIT,
        artifactRef: ordinaryCheckpointRefForCommit(INSPECT_CHECKPOINT_COMMIT),
      }),
      request,
      artifacts: artifacts(),
    })).resolves.toMatchObject({ checkpoint: { output_subject: null } });

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({
        request,
        outputSubject: null,
        artifactCommit: INSPECT_CHECKPOINT_COMMIT,
        artifactRef: `refs/openthrottle/checkpoints/${"f".repeat(64)}`,
      }),
      request,
      artifacts: artifacts(),
    })).rejects.toThrow(/commit or sealed request/);
  });

  it("requires edit corrections to retain the exact locked output subject", async () => {
    const request = correctionRequest("edit");

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({ request, outputSubject: EDITED_SUBJECT }),
      request,
      artifacts: artifacts(),
    })).resolves.toMatchObject({
      state: "needs_human",
      checkpoint: { output_subject: EDITED_SUBJECT },
    });

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({ request, outputSubject: null }),
      request,
      artifacts: artifacts(),
    })).rejects.toThrow(/repository authority/);

    await expect(parseKernelRuntimeResult({
      raw: rawCorrectionResult({
        request,
        outputSubject: EDITED_SUBJECT,
        artifactCommit: INSPECT_CHECKPOINT_COMMIT,
      }),
      request,
      artifacts: artifacts(),
    })).rejects.toThrow(/repository authority/);
  });
});
