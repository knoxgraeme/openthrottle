import { SHA256, arrayAt, enumAt, fail, integerAt, jsonValueAt, normalizedContract, nullable, objectAt, stringAt, timestampAt, } from "./validation.js";
import { compareCodeUnits } from "./canonical.js";
export const ATTEMPT_FORENSICS_PAYLOAD_SCHEMA = "openthrottle.attempt-forensics/v1";
export const INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA = "openthrottle.invalid-result-evidence/v1";
export const EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA = "openthrottle.evidence-artifact-descriptor/v1";
export const EVIDENCE_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const ATTEMPT_EVIDENCE_PAYLOAD_SCHEMAS = [
    ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const EVIDENCE_FILE = /^evidence-[a-f0-9]{64}\.json$/;
const EVIDENCE_TAIL_MAX_CHARACTERS = 16_384;
function id(value, path) {
    return stringAt(value, path, { max: 200, pattern: ID });
}
function digest(value, path) {
    return stringAt(value, path, { max: 64, pattern: SHA256 });
}
function boundedText(value, path, maximum) {
    if (typeof value !== "string")
        fail(path, "must be a string");
    if (value.length > maximum)
        fail(path, `must be at most ${maximum} characters`);
    if (value.includes("\0"))
        fail(path, "must not contain NUL characters");
    return value;
}
function diagnostic(value, path) {
    const input = objectAt(value, path, ["path", "detail"]);
    return {
        path: boundedText(input.path, `${path}.path`, 500),
        detail: boundedText(input.detail, `${path}.detail`, 1_500),
    };
}
export function validateAttemptForensicsPayload(value, options = {}) {
    const source = options.source ?? "attempt_forensics";
    const input = objectAt(value, source, [
        "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
        "lease_id", "work_retry_ordinal", "operational_signature", "exit_code",
        "runner_stdout_tail", "runner_stderr_tail", "result_path_state", "session_event_state",
        "workspace_git_status", "observed_at",
    ]);
    if (input.schema !== ATTEMPT_FORENSICS_PAYLOAD_SCHEMA) {
        fail(`${source}.schema`, `must be ${ATTEMPT_FORENSICS_PAYLOAD_SCHEMA}`);
    }
    return normalizedContract({
        schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
        pipeline_run_id: id(input.pipeline_run_id, `${source}.pipeline_run_id`),
        attempt_id: id(input.attempt_id, `${source}.attempt_id`),
        request_hash: digest(input.request_hash, `${source}.request_hash`),
        definition_bundle_hash: digest(input.definition_bundle_hash, `${source}.definition_bundle_hash`),
        lease_id: id(input.lease_id, `${source}.lease_id`),
        work_retry_ordinal: integerAt(input.work_retry_ordinal, `${source}.work_retry_ordinal`, 0, Number.MAX_SAFE_INTEGER),
        operational_signature: digest(input.operational_signature, `${source}.operational_signature`),
        exit_code: integerAt(input.exit_code, `${source}.exit_code`, 0, 255),
        runner_stdout_tail: boundedText(input.runner_stdout_tail, `${source}.runner_stdout_tail`, EVIDENCE_TAIL_MAX_CHARACTERS),
        runner_stderr_tail: boundedText(input.runner_stderr_tail, `${source}.runner_stderr_tail`, EVIDENCE_TAIL_MAX_CHARACTERS),
        result_path_state: jsonValueAt(input.result_path_state, `${source}.result_path_state`),
        session_event_state: jsonValueAt(input.session_event_state, `${source}.session_event_state`),
        workspace_git_status: jsonValueAt(input.workspace_git_status, `${source}.workspace_git_status`),
        observed_at: timestampAt(input.observed_at, `${source}.observed_at`, { normalize: false }),
    });
}
export function validateInvalidResultEvidencePayload(value, options = {}) {
    const source = options.source ?? "invalid_result_evidence";
    const input = objectAt(value, source, [
        "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
        "phase", "candidate_hash", "rejected_candidate", "diagnostics", "runner_stdout_tail",
        "runner_stderr_tail", "observed_at",
    ]);
    if (input.schema !== INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA) {
        fail(`${source}.schema`, `must be ${INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA}`);
    }
    return normalizedContract({
        schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
        pipeline_run_id: id(input.pipeline_run_id, `${source}.pipeline_run_id`),
        attempt_id: id(input.attempt_id, `${source}.attempt_id`),
        request_hash: digest(input.request_hash, `${source}.request_hash`),
        definition_bundle_hash: digest(input.definition_bundle_hash, `${source}.definition_bundle_hash`),
        phase: enumAt(input.phase, `${source}.phase`, ["work", "result_correction"]),
        candidate_hash: nullable(input.candidate_hash, (entry) => digest(entry, `${source}.candidate_hash`)),
        rejected_candidate: nullable(input.rejected_candidate, (entry) => jsonValueAt(entry, `${source}.rejected_candidate`)),
        diagnostics: arrayAt(input.diagnostics, `${source}.diagnostics`, diagnostic, { max: 100 }).sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.detail, right.detail)),
        runner_stdout_tail: boundedText(input.runner_stdout_tail, `${source}.runner_stdout_tail`, EVIDENCE_TAIL_MAX_CHARACTERS),
        runner_stderr_tail: boundedText(input.runner_stderr_tail, `${source}.runner_stderr_tail`, EVIDENCE_TAIL_MAX_CHARACTERS),
        observed_at: timestampAt(input.observed_at, `${source}.observed_at`, { normalize: false }),
    });
}
export function validateAttemptEvidencePayload(value, options = {}) {
    const source = options.source ?? "attempt_evidence";
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(source, "must be an object");
    }
    const schema = enumAt(value.schema, `${source}.schema`, ATTEMPT_EVIDENCE_PAYLOAD_SCHEMAS);
    return schema === ATTEMPT_FORENSICS_PAYLOAD_SCHEMA
        ? validateAttemptForensicsPayload(value, { source })
        : validateInvalidResultEvidencePayload(value, { source });
}
export function validateEvidenceArtifactDescriptor(value, options = {}) {
    const source = options.source ?? "evidence_artifact";
    const input = objectAt(value, source, [
        "schema", "file", "sha256", "bytes", "media_type", "payload_schema",
    ]);
    if (input.schema !== EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA) {
        fail(`${source}.schema`, `must be ${EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA}`);
    }
    if (input.media_type !== "application/json") {
        fail(`${source}.media_type`, "must be application/json");
    }
    const sha256 = digest(input.sha256, `${source}.sha256`);
    const file = stringAt(input.file, `${source}.file`, { max: 200, pattern: EVIDENCE_FILE });
    if (file !== `evidence-${sha256}.json`) {
        fail(`${source}.file`, "must identify the descriptor content digest");
    }
    const payloadSchema = enumAt(input.payload_schema, `${source}.payload_schema`, ATTEMPT_EVIDENCE_PAYLOAD_SCHEMAS);
    if (options.payloadSchema !== undefined && payloadSchema !== options.payloadSchema) {
        fail(`${source}.payload_schema`, "must match the expected payload schema");
    }
    return normalizedContract({
        schema: EVIDENCE_ARTIFACT_DESCRIPTOR_SCHEMA,
        file,
        sha256,
        bytes: integerAt(input.bytes, `${source}.bytes`, 1, EVIDENCE_ARTIFACT_MAX_BYTES),
        media_type: "application/json",
        payload_schema: payloadSchema,
    });
}
export const ATTEMPT_FORENSICS_PAYLOAD_CONTRACT = Object.freeze({
    kind: "decision",
    parseInline: (value, path) => validateAttemptForensicsPayload(value, { source: path }).value,
});
export const INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT = Object.freeze({
    kind: "decision",
    parseInline: (value, path) => validateInvalidResultEvidencePayload(value, { source: path }).value,
});
