import { describe, expect, it } from "vitest";
import {
  ATTEMPT_FORENSICS_PAYLOAD_CONTRACT,
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
  EVIDENCE_ARTIFACT_MAX_BYTES,
  INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  validateAttemptEvidencePayload,
  validateAttemptForensicsPayload,
  validateEvidenceArtifactDescriptor,
  validateInvalidResultEvidencePayload,
} from "./index.js";

const sha = (character: string): string => character.repeat(64);

function attemptForensicsPayload() {
  return {
    schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: sha("a"),
    definition_bundle_hash: sha("b"),
    lease_id: "lease-1",
    work_retry_ordinal: 2,
    operational_signature: sha("c"),
    exit_code: 1,
    runner_stdout_tail: "",
    runner_stderr_tail: "runner failed",
    result_path_state: { state: "missing" },
    session_event_state: { state: "present", bytes: 42, sha256: sha("d") },
    workspace_git_status: { state: "present", summary: " M src/work.ts", detail: "" },
    observed_at: "2026-08-20T12:00:00.000Z",
  } as const;
}

function invalidResultEvidencePayload() {
  return {
    schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: sha("a"),
    definition_bundle_hash: sha("b"),
    phase: "result_correction",
    candidate_hash: sha("e"),
    rejected_candidate: { raw: "not valid" },
    diagnostics: [{ path: "result.payload", detail: "must be an object" }],
    runner_stdout_tail: "",
    runner_stderr_tail: "",
    observed_at: "2026-08-20T12:00:00.000Z",
  } as const;
}

describe("attempt evidence contracts", () => {
  it("validates both evidence payloads through their canonical record contracts", () => {
    const forensics = attemptForensicsPayload();
    const invalidResult = invalidResultEvidencePayload();

    expect(validateAttemptForensicsPayload(forensics).value).toEqual(forensics);
    expect(validateInvalidResultEvidencePayload(invalidResult).value).toEqual(invalidResult);
    expect(validateAttemptEvidencePayload(forensics).value).toEqual(forensics);
    expect(validateAttemptEvidencePayload(invalidResult).value).toEqual(invalidResult);
    expect(ATTEMPT_FORENSICS_PAYLOAD_CONTRACT.kind).toBe("decision");
    expect(ATTEMPT_FORENSICS_PAYLOAD_CONTRACT.parseInline(forensics, "record.payload.inline"))
      .toEqual(forensics);
    expect(INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT.kind).toBe("decision");
    expect(INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT.parseInline(
      invalidResult,
      "record.payload.inline",
    )).toEqual(invalidResult);
  });

  it("validates a content-addressed evidence artifact descriptor", () => {
    const digest = sha("f");
    const descriptor = {
      schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
      file: `evidence-${digest}.json`,
      sha256: digest,
      bytes: 512,
      media_type: "application/json",
      payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    } as const;

    expect(validateEvidenceArtifactDescriptor(descriptor, {
      payloadSchema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    }).value).toEqual(descriptor);
  });

  it("rejects drifted payloads and unsafe descriptors at the shared boundary", () => {
    expect(() => validateAttemptForensicsPayload({
      ...attemptForensicsPayload(),
      unexpected: true,
    })).toThrow(/unexpected: unknown field/);
    expect(() => validateAttemptForensicsPayload({
      ...attemptForensicsPayload(),
      runner_stdout_tail: "x".repeat(16_385),
    })).toThrow(/runner_stdout_tail.*at most 16384/);
    expect(() => validateInvalidResultEvidencePayload({
      ...invalidResultEvidencePayload(),
      observed_at: "August 20, 2026",
    })).toThrow(/observed_at.*ISO-8601/);
    expect(() => validateAttemptEvidencePayload({
      ...invalidResultEvidencePayload(),
      schema: "openthrottle.unknown-evidence/v1",
    })).toThrow(/schema.*must be one of/);

    const digest = sha("f");
    expect(() => validateEvidenceArtifactDescriptor({
      schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
      file: "../evidence.json",
      sha256: digest,
      bytes: 512,
      media_type: "application/json",
      payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    })).toThrow(/file.*invalid format/);
    expect(() => validateEvidenceArtifactDescriptor({
      schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
      file: `evidence-${digest}.json`,
      sha256: digest,
      bytes: EVIDENCE_ARTIFACT_MAX_BYTES + 1,
      media_type: "application/json",
      payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    })).toThrow(/bytes.*between 1 and 1048576/);
    expect(() => validateEvidenceArtifactDescriptor({
      schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
      file: `evidence-${sha("0")}.json`,
      sha256: digest,
      bytes: 512,
      media_type: "application/json",
      payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    })).toThrow(/file.*content digest/);
    expect(() => validateEvidenceArtifactDescriptor({
      schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
      file: `evidence-${digest}.json`,
      sha256: digest,
      bytes: 512,
      media_type: "application/json",
      payload_schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    }, { payloadSchema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA }))
      .toThrow(/payload_schema.*expected payload schema/);
  });
});
