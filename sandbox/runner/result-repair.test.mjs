import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertVerifiedResultCheckpoint,
  resultCorrectionLaunchContract,
  resultCorrectionProfile,
  resultCorrectionTaskPrompt,
  settleActionResult,
  settleResultSubmission,
} from "./result-repair.mjs";
import {
  materializeResultSubmissionChannel,
  resultSubmissionEnvironment,
  stageResultCandidate,
} from "./result-submission.mjs";

const checkpoint = {
  schema: "openthrottle.attempt-checkpoint/v1",
  id: "checkpoint-1",
  pipeline_run_id: "run-1",
  attempt_id: "attempt-1",
  request_hash: "a".repeat(64),
  definition_bundle_hash: "b".repeat(64),
  input_subject: "c".repeat(40),
  output_subject: "d".repeat(40),
  native_session_id: "session-1",
};

const validCandidate = {
  status: "valid",
  staged: {
    schema: "openthrottle.staged-result-candidate/v1",
    original_hash: "e".repeat(64),
    normalized_hash: "f".repeat(64),
  },
};

const invalidCandidate = {
  status: "invalid",
  original_hash: "e".repeat(64),
  diagnostics: [{
    path: "result_candidate.payload.summary",
    detail: "must be a non-empty string",
  }],
};

const semanticSchema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/test-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: {
      type: "string",
      required: true,
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
  },
};

function semanticCandidate(summary, outcome = "success") {
  return {
    schema: "openthrottle.result-candidate/v1",
    outcome,
    payload: { summary },
  };
}

const checkpointFence = {
  attemptId: checkpoint.attempt_id,
  requestHash: checkpoint.request_hash,
  definitionBundleHash: checkpoint.definition_bundle_hash,
  inputSubject: checkpoint.input_subject,
  outputSubject: checkpoint.output_subject,
};

describe("result-only repair lifecycle", () => {
  it("settles a normalized OPE-188 candidate without another work attempt", () => {
    const result = settleActionResult({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint,
      candidate: validCandidate,
    });
    expect(result).toMatchObject({
      state: "work_complete",
      phase: "work",
      checkpoint: { output_subject: "d".repeat(40) },
      candidate: { original_hash: "e".repeat(64) },
      correction_rounds_used: 0,
    });
  });

  it("keeps completed work and resumes only the same session for invalid semantics", () => {
    const result = settleActionResult({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint,
      candidate: invalidCandidate,
      correction: { round: 0, maxRounds: 2, deadlineMs: 2_000 },
      nowMs: 1_000,
    });
    expect(result).toMatchObject({
      state: "result_pending",
      checkpoint: { id: "checkpoint-1", output_subject: "d".repeat(40) },
      correction: {
        phase: "result_correction",
        native_session_id: "session-1",
        output_subject: "d".repeat(40),
        correction_round: 1,
        repository_authority: "inspect",
        repository_subject_locked: true,
        allowed_tools: ["ot-result"],
        mcp_access: false,
        provider_access: false,
        publication_access: false,
      },
    });
  });

  it("exhausts correction into needs_human with the checkpoint and diagnostics intact", () => {
    const result = settleActionResult({
      phase: "result_correction",
      engineExitedCleanly: true,
      checkpoint,
      candidate: invalidCandidate,
      correction: { round: 2, maxRounds: 2, deadlineMs: 2_000 },
      nowMs: 1_000,
    });
    expect(result).toMatchObject({
      state: "needs_human",
      reason: "result_correction_budget_exhausted",
      checkpoint: { id: "checkpoint-1" },
      candidate: {
        status: "invalid",
        diagnostics: invalidCandidate.diagnostics,
      },
    });
  });

  it("does not claim work_complete for a non-clean work exit with a partial candidate", () => {
    expect(settleActionResult({
      phase: "work",
      engineExitedCleanly: false,
      checkpoint,
      candidate: validCandidate,
    })).toMatchObject({ state: "work_failed", reason: "non_clean_work_exit" });
  });

  it("does not rerun completed work when the correction session is unavailable", () => {
    expect(settleActionResult({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint: { ...checkpoint, native_session_id: null },
      candidate: { status: "missing" },
    })).toMatchObject({
      state: "needs_human",
      reason: "result_correction_session_unavailable",
      checkpoint: { id: "checkpoint-1" },
    });
  });

  it("builds a correction profile that cannot widen repository or tool authority", () => {
    const profile = resultCorrectionProfile({
      attemptId: "attempt-1",
      requestHash: "a".repeat(64),
      definitionBundleHash: "b".repeat(64),
      inputSubject: "c".repeat(40),
      outputSubject: "d".repeat(40),
      nativeSessionId: "session-1",
      round: 1,
      deadlineMs: 2_000,
      diagnostics: invalidCandidate.diagnostics,
    });
    expect(profile).not.toHaveProperty("commands");
    expect(profile).not.toHaveProperty("mcp_servers");
    expect(profile).not.toHaveProperty("credentials");
    expect(profile.allowed_tools).toEqual(["ot-result"]);
  });

  it("normalizes OPE-188 and settles work_complete in the original invocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-settle-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    const providerOutput = `${JSON.stringify({
      type: "result",
      structured_output: semanticCandidate(["Implemented.", "Tests pass."]),
    })}\n`;
    const settlement = settleResultSubmission({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint,
      checkpointFence,
      channel,
      engine: "claude",
      providerOutput,
    });
    expect(settlement).toMatchObject({
      state: "work_complete",
      phase: "work",
      candidate: {
        original: { payload: { summary: ["Implemented.", "Tests pass."] } },
        candidate: { payload: { summary: "Implemented.\nTests pass." } },
        transformations: [{ path: "/payload/summary" }],
      },
      correction_rounds_used: 0,
    });
  });

  it("repairs only the result in the same session and never redispatches work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-correct-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    const invalid = settleResultSubmission({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint,
      checkpointFence,
      channel,
      engine: "codex",
      providerOutput: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(semanticCandidate("done", "unknown")) },
      })}\n`,
      correction: { round: 0, maxRounds: 2, deadlineMs: 2_000 },
      nowMs: 1_000,
    });
    expect(invalid).toMatchObject({
      state: "result_pending",
      checkpoint: { id: "checkpoint-1", output_subject: checkpoint.output_subject },
      correction: { native_session_id: "session-1", correction_round: 1 },
      candidate: {
        status: "invalid",
        diagnostics: [{ path: "result_candidate.outcome" }],
      },
    });

    const corrected = settleResultSubmission({
      phase: "result_correction",
      engineExitedCleanly: true,
      checkpoint,
      checkpointFence,
      channel,
      engine: "codex",
      providerOutput: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(semanticCandidate("done")) },
      })}\n`,
      correction: { round: 1, maxRounds: 2, deadlineMs: 2_000 },
      nowMs: 1_100,
    });
    expect(corrected).toMatchObject({
      state: "work_complete",
      phase: "result_correction",
      checkpoint: { id: "checkpoint-1", output_subject: checkpoint.output_subject },
      correction_rounds_used: 1,
    });
  });

  it("keeps an inspect review on its input subject while correcting a malformed result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-review-correct-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    const inspectCheckpoint = { ...checkpoint, output_subject: null };
    const inspectFence = { ...checkpointFence, outputSubject: null };
    const invalid = settleResultSubmission({
      phase: "work",
      engineExitedCleanly: true,
      checkpoint: inspectCheckpoint,
      checkpointFence: inspectFence,
      channel,
      engine: "codex",
      providerOutput: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(semanticCandidate("done", "unknown")) },
      })}\n`,
      correction: { round: 0, maxRounds: 2, deadlineMs: 2_000 },
      nowMs: 1_000,
    });

    expect(invalid).toMatchObject({
      state: "result_pending",
      checkpoint: {
        input_subject: inspectCheckpoint.input_subject,
        output_subject: null,
      },
      correction: {
        input_subject: inspectCheckpoint.input_subject,
        output_subject: null,
        repository_subject_locked: true,
        repository_authority: "inspect",
      },
    });
    expect(resultCorrectionTaskPrompt(invalid.correction)).toContain(
      "(none; inspect action remains bound to its input subject)",
    );
    const launch = resultCorrectionLaunchContract({
      profile: invalid.correction,
      engine: "codex",
      repositoryView: "/sealed/exact-input-subject-view",
      providerSchemaPath: channel.provider_schema_path,
      resultEnvironment: resultSubmissionEnvironment(channel),
    });
    expect(launch).toMatchObject({
      repository_view: "/sealed/exact-input-subject-view",
      locked_output_subject: null,
      repository_authority: "inspect",
      native_session_id: inspectCheckpoint.native_session_id,
    });
  });

  it("keeps a partial tool candidate as evidence but never completes a non-clean exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-nonclean-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    await stageResultCandidate({
      value: semanticCandidate("partial"),
      semanticSchema,
      outputPath: channel.candidate_path,
    });
    expect(settleResultSubmission({
      phase: "work",
      engineExitedCleanly: false,
      checkpoint,
      checkpointFence,
      channel,
      engine: "claude",
      providerOutput: JSON.stringify(semanticCandidate("must not be promoted")),
    })).toMatchObject({
      state: "work_failed",
      reason: "non_clean_work_exit",
      candidate: { status: "valid", staged: { candidate: { payload: { summary: "partial" } } } },
    });
  });

  it("binds checkpoint authority and correction launch to the same subject/session", () => {
    expect(assertVerifiedResultCheckpoint({ checkpoint, ...checkpointFence })).toBe(checkpoint);
    expect(() => assertVerifiedResultCheckpoint({
      checkpoint: { ...checkpoint, output_subject: "e".repeat(40) },
      ...checkpointFence,
    })).toThrow(/output_subject mismatch/);
    const profile = resultCorrectionProfile({
      attemptId: checkpoint.attempt_id,
      requestHash: checkpoint.request_hash,
      definitionBundleHash: checkpoint.definition_bundle_hash,
      inputSubject: checkpoint.input_subject,
      outputSubject: checkpoint.output_subject,
      nativeSessionId: checkpoint.native_session_id,
      round: 1,
      deadlineMs: 2_000,
      diagnostics: invalidCandidate.diagnostics,
    });
    const channel = {
      schema: "openthrottle.result-submission-channel/v1",
      schema_path: "/sealed/schema.json",
      candidate_path: "/sealed/candidate.json",
      rejection_path: "/sealed/rejected.json",
    };
    const launch = resultCorrectionLaunchContract({
      profile,
      engine: "opencode",
      repositoryView: "/sealed/repo-view",
      providerSchemaPath: "/sealed/provider-schema.json",
      resultEnvironment: resultSubmissionEnvironment(channel),
    });
    expect(launch).toMatchObject({
      phase: "result_correction",
      native_session_id: "session-1",
      repository_authority: "inspect",
      locked_output_subject: checkpoint.output_subject,
      allowed_tools: ["ot-result"],
      allowed_repository_commands: [],
      skill_ids: [],
      mcp_servers: [],
      external_provider_credentials: [],
      publication_credentials: [],
    });
    expect(resultCorrectionTaskPrompt(profile)).toContain("work is already complete");
    expect(resultCorrectionTaskPrompt(profile)).toContain(checkpoint.output_subject);
  });
});
