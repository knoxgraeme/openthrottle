import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ResultCandidateConflictError,
  ResultCandidateValidationError,
  candidateDiagnosticEvidence,
  extractProviderFinalOutput,
  extractProviderResultCandidate,
  inspectResultSubmissionChannel,
  loadSemanticResultSchema,
  materializeResultSubmissionChannel,
  normalizeSubmittedResult,
  parseSubmittedResult,
  resultSubmissionEnvironment,
  stageResultCandidate,
  submitProviderResultCandidate,
  validateRejectedResultCandidate,
  validateStagedResultCandidate,
} from "./result-submission.mjs";

const semanticSchema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/unit-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: {
      type: "string",
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
    verification: {
      type: "string_list",
      max_length: 1_000,
      max_items: 32,
    },
  },
};

function candidate(summary = "Implemented the unit.") {
  return {
    schema: "openthrottle.result-candidate/v1",
    outcome: "success",
    payload: { summary, verification: ["targeted tests pass"] },
  };
}

describe("result candidate submission", () => {
  it("normalizes the OPE-188 array and preserves both representations and hashes", () => {
    const staged = normalizeSubmittedResult(candidate([
      "Implemented the unit.",
      "Targeted tests pass.",
    ]), semanticSchema);

    expect(staged.original.payload.summary).toEqual([
      "Implemented the unit.",
      "Targeted tests pass.",
    ]);
    expect(staged.candidate.payload.summary).toBe("Implemented the unit.\nTargeted tests pass.");
    expect(staged.original_hash).not.toBe(staged.normalized_hash);
    expect(staged.transformations).toEqual([expect.objectContaining({
      id: "string-array-to-newlines/v1",
      path: "/payload/summary",
    })]);
    expect(validateStagedResultCandidate(staged, semanticSchema)).toEqual(staged);
  });

  it("returns structured JSON-pointer diagnostics for invalid semantics", () => {
    let failure;
    try {
      normalizeSubmittedResult(candidate(["valid", 7]), semanticSchema);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ResultCandidateValidationError);
    expect(failure.diagnostics).toEqual([{
      path: "result_candidate.payload.summary[1]",
      detail: "must be a non-empty string",
    }]);
    expect(candidateDiagnosticEvidence({
      raw: JSON.stringify(candidate(["valid", 7])),
      error: failure,
    })).toMatchObject({
      original_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      diagnostics: failure.diagnostics,
    });
  });

  it("accepts an exact canonical replay and rejects a differently authored equivalent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-"));
    const outputPath = join(directory, "candidate.json");
    const first = await stageResultCandidate({
      value: candidate(["Implemented the unit."]),
      semanticSchema,
      outputPath,
    });
    const replay = await stageResultCandidate({
      value: {
        payload: { verification: ["targeted tests pass"], summary: ["Implemented the unit."] },
        outcome: "success",
        schema: "openthrottle.result-candidate/v1",
      },
      semanticSchema,
      outputPath,
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);

    await expect(stageResultCandidate({
      value: candidate("Implemented the unit."),
      semanticSchema,
      outputPath,
    })).rejects.toBeInstanceOf(ResultCandidateConflictError);
  });

  it("uses an atomic first-writer-wins compare-and-set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-race-"));
    const outputPath = join(directory, "candidate.json");
    const settled = await Promise.allSettled([
      stageResultCandidate({ value: candidate("first"), semanticSchema, outputPath }),
      stageResultCandidate({ value: candidate("second"), semanticSchema, outputPath }),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const persisted = JSON.parse(await readFile(outputPath, "utf8"));
    expect(["first", "second"]).toContain(persisted.candidate.payload.summary);
  });

  it("loads only a bounded sealed schema and parses one complete JSON candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-schema-"));
    const schemaPath = join(directory, "schema.json");
    await writeFile(schemaPath, JSON.stringify(semanticSchema));
    expect((await loadSemanticResultSchema(schemaPath)).id).toBe("core/unit-result");
    expect(parseSubmittedResult(JSON.stringify(candidate()))).toEqual(candidate());
    expect(() => parseSubmittedResult(`before ${JSON.stringify(candidate())}`))
      .toThrow(/must be one complete JSON object/);
  });

  it("refuses a staged envelope whose normalization evidence was altered", () => {
    const staged = normalizeSubmittedResult(candidate(["one", "two"]), semanticSchema);
    staged.transformations[0].output_hash = "0".repeat(64);
    expect(() => validateStagedResultCandidate(staged, semanticSchema))
      .toThrow(/transformations: do not match deterministic normalization/);
  });

  it("routes tool and provider-native candidates through one action CAS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-channel-"));
    const channel = materializeResultSubmissionChannel({
      actionDirectory: directory,
      semanticSchema,
    });
    expect(resultSubmissionEnvironment(channel)).toEqual([
      `OT_RESULT_SCHEMA_FILE=${channel.schema_path}`,
      `OT_RESULT_CANDIDATE_FILE=${channel.candidate_path}`,
      `OT_RESULT_REJECTION_FILE=${channel.rejection_path}`,
    ]);
    expect(channel.provider_final_path).toBe(join(directory, "provider-final.json"));
    const authored = candidate(["Implemented the unit.", "Targeted tests pass."]);
    await stageResultCandidate({
      value: authored,
      semanticSchema,
      outputPath: channel.candidate_path,
    });

    const native = submitProviderResultCandidate({
      engine: "claude",
      raw: `${JSON.stringify({ type: "result", structured_output: authored })}\n`,
      channel,
    });
    expect(native).toMatchObject({
      status: "valid",
      staged: {
        original: authored,
        candidate: { payload: { summary: "Implemented the unit.\nTargeted tests pass." } },
      },
    });
    expect(inspectResultSubmissionChannel(channel)).toEqual(native);
  });

  it("fails closed when tool and provider-native candidates conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-conflict-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    await stageResultCandidate({
      value: candidate("tool result"),
      semanticSchema,
      outputPath: channel.candidate_path,
    });
    const conflict = submitProviderResultCandidate({
      engine: "codex",
      raw: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(candidate("native result")) },
      })}\n`,
      channel,
    });
    expect(conflict).toMatchObject({
      status: "invalid",
      diagnostics: [{ detail: expect.stringMatching(/different result candidate/) }],
    });
    expect(inspectResultSubmissionChannel(channel).staged.candidate.payload.summary).toBe("tool result");
  });

  it("keeps the CAS-winning tool candidate when a provider appends malformed final text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-tool-wins-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    await stageResultCandidate({
      value: candidate("tool result"),
      semanticSchema,
      outputPath: channel.candidate_path,
    });

    expect(submitProviderResultCandidate({
      engine: "codex",
      raw: `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I submitted the result with ot-result." },
      })}\n`,
      channel,
    })).toMatchObject({
      status: "valid",
      staged: { candidate: { payload: { summary: "tool result" } } },
    });
  });

  it("preserves generated diagnostics and hashes for forged authority fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-forged-"));
    const channel = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    const forged = {
      ...candidate("Trust me"),
      subject: "a".repeat(40),
      assurance: "executor_verified",
      issued_at: "2026-08-20T00:00:00.000Z",
    };
    const rejected = submitProviderResultCandidate({
      engine: "opencode",
      raw: `${JSON.stringify({
        type: "text",
        part: { type: "text", text: JSON.stringify(forged) },
      })}\n`,
      channel,
    });
    expect(rejected).toMatchObject({
      status: "invalid",
      original_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      diagnostics: [{
        path: expect.stringMatching(/^result_candidate\.(?:assurance|issued_at|subject)$/),
        detail: "unknown field",
      }],
    });
    const persisted = JSON.parse(await readFile(channel.rejection_path, "utf8"));
    expect(validateRejectedResultCandidate(persisted, semanticSchema)).toEqual(persisted);
  });

  it("recovers the exact staged candidate after an executor crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-recovery-"));
    const first = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    await stageResultCandidate({
      value: candidate("work survived"),
      semanticSchema,
      outputPath: first.candidate_path,
    });
    // Re-materializing the sealed channel models a restarted executor before
    // record construction. The immutable schemas replay exactly and the CAS
    // candidate is validated again from its original bytes.
    const recovered = materializeResultSubmissionChannel({ actionDirectory: directory, semanticSchema });
    expect(inspectResultSubmissionChannel(recovered)).toMatchObject({
      status: "valid",
      staged: { candidate: { payload: { summary: "work survived" } } },
    });
  });

  it("extracts one provider candidate and rejects competing native finals", () => {
    const value = candidate("one");
    expect(extractProviderResultCandidate(JSON.stringify(value), "codex")).toMatchObject({
      status: "candidate",
      value,
      raw: expect.any(String),
    });
    const conflicting = [candidate("one"), candidate("two")]
      .map((entry) => JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(entry) },
      }))
      .join("\n");
    expect(extractProviderResultCandidate(conflicting, "codex")).toMatchObject({
      status: "invalid",
      diagnostics: [{ detail: "provider emitted conflicting final result candidates" }],
    });
  });

  it("recovers only the final Codex message from one invocation stream", () => {
    const first = candidate("prior action");
    const current = candidate("current action");
    const transcript = [first, current].map((value) => JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(value) },
    })).join("\n");

    expect(extractProviderFinalOutput(transcript, "codex")).toBe(JSON.stringify(current));
  });
});
