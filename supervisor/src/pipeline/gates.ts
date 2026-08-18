import {
  canonicalJson,
  digestNormalized,
  TUNE_ANALYSIS_INPUT_SCHEMA,
  validateStandardReceipt,
  validateTuneAnalysisInputContract,
  type StandardReceipt,
} from "@openthrottle/contracts";
import {
  ASSURANCE_CLASSES,
  PIPELINE_OUTCOMES,
  STAGE_OUTCOMES,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineStage,
  type StageOutcome,
} from "./manifest.js";
import { validateCitationGateDecision } from "./citation-gate.js";
import {
  coordinatePipelineEvent,
  type PipelineCoordinatorEvent,
  type PipelineEventArtifact,
} from "./coordinator.js";
import { evaluateImprovementProposalGate } from "./improvement-proposal-gate.js";
import type {
  CoordinatorGateReceiptWrite,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "./store.js";
import { extractJsonBlocks } from "./markdown.js";
import { TUNE_ARTIFACT_PAYLOAD_LIMIT_BYTES } from "./evidence-limits.js";
import { containsSecretShapedValue } from "../shared/sanitize.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const ARTIFACT_LIMIT = 12 * 1024;
const ARTIFACT_KEYS = new Set([
  "schema", "kind", "producer", "pipeline", "stage", "run", "repository",
  "assurance", "result", "summary", "evidence", "findings", "actions",
  "uncertainty", "started_at", "completed_at", "details",
]);

type ArtifactResult = StageOutcome | "not_configured";
export type GateResult = CoordinatorGateReceiptWrite["result"];

// The closed, bottom-up vocabulary for execution_gate_receipts.reason (see
// the LAUNCH_FAILURE_REASONS pattern in sandbox/runner/launch-failure.mjs).
// Every value here is produced somewhere in gates.ts or execution-gates.ts;
// a new gate decision reason must be added here (and to the DB CHECK
// constraint via a migration) before it can be written to a receipt.
export const GATE_RECEIPT_REASONS = Object.freeze([
  // gates.ts: semanticDecisionForEvidence / commandDecisionForEvidence
  "blocking_findings",
  "no_change_contradicted_by_tree_delta",
  "typed_semantic_result",
  "command_not_configured",
  "command_terminated",
  "command_exit_zero",
  "command_exit_nonzero",
  // execution-gates.ts: commandOutcome / evaluateUnitAcceptanceGate / evaluateIntegrationGate
  "command_receipts_missing_or_unexpected",
  "required_command_not_configured",
  "command_receipt_failed",
  "all_commands_current",
  "candidate_evidence_failed",
  "worker_completion_not_success",
  "lead_scope_match_accept",
  "lead_requested_revision",
  "lead_needs_human",
  "lead_context_update",
  "executor_integrated_candidate",
  "integration_evidence_failed",
] as const);
export type GateReceiptReason = (typeof GATE_RECEIPT_REASONS)[number];
type StageGateReason =
  | GateReceiptReason
  | "citation_gate_passed"
  | "citation_gate_failed"
  | "differential_ratchet_passed"
  | "differential_ratchet_failed";

function providerRevisionFromPayload(payload: Record<string, unknown>): string | undefined {
  const revision = payload.expected_published_commit ?? payload.head_sha;
  return typeof revision === "string" && GIT_COMMIT.test(revision) ? revision : undefined;
}

export interface SemanticDecisionEvidence {
  result: ArtifactResult;
  findings: Array<{ severity: string }>;
  repository: {
    pre_subject: string;
    post_subject: string;
  };
}

export interface CommandDecisionEvidence {
  not_configured: boolean;
  timed_out: boolean;
  exit_code: number | null;
  signal: string | null;
}

export interface Finding {
  severity: "P0" | "P1" | "P2" | "P3";
  code: string;
  summary: string;
  path?: string;
  line?: number;
}

interface TypedArtifactPayload {
  schema: string;
  kind: string;
  producer: {
    capability: string;
    runtime_release: string;
    capability_digest: string;
    version: number;
  };
  pipeline: { instance_id: string; manifest_digest: string };
  stage: {
    id: string;
    attempt_id: string;
    request_hash: string;
    context_revision: number;
    context_policy: string;
  };
  run: {
    id: string;
    ticket_id: string;
    session_id: string;
    generation: number;
    native_session_id: string | null;
  };
  repository: {
    name: string;
    base_commit: string;
    subject: string;
    pre_subject: string;
    post_subject: string;
  };
  assurance: AssuranceClass;
  result: ArtifactResult;
  summary: string;
  evidence: string[];
  findings: Finding[];
  actions: string[];
  uncertainty: string[];
  started_at: string;
  completed_at: string;
  details: Record<string, unknown>;
}

export interface StageGateEvaluation {
  event: PipelineCoordinatorEvent;
  receipt: CoordinatorGateReceiptWrite;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[] | Set<string>, label: string): void {
  const allowed = keys instanceof Set ? keys : new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  const missing = [...allowed].find((key) => !(key in value));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
  if (missing) throw new Error(`${label} is missing field ${missing}`);
}

function boundedString(value: unknown, label: string, max = 8_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return boundedString(value, label, 200);
}

function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${label} is invalid`);
  return value as number;
}

function strings(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is not a bounded array`);
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, maxLength));
}

function timestamp(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} is invalid`);
  return result;
}

function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("artifact findings are not bounded");
  return value.map((entry, index) => {
    const finding = record(entry, `findings[${index}]`);
    const allowed = ["severity", "code", "summary", "path", "line"];
    const unknown = Object.keys(finding).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`findings[${index}] has unknown field ${unknown}`);
    if (!["P0", "P1", "P2", "P3"].includes(String(finding.severity))) {
      throw new Error(`findings[${index}] has invalid severity`);
    }
    return {
      severity: finding.severity as Finding["severity"],
      code: boundedString(finding.code, `findings[${index}].code`, 80),
      summary: boundedString(finding.summary, `findings[${index}].summary`, 1_000),
      ...(finding.path === undefined
        ? {}
        : { path: boundedString(finding.path, `findings[${index}].path`, 500) }),
      ...(finding.line === undefined ? {} : { line: integer(finding.line, `findings[${index}].line`, 1) }),
    };
  });
}

function parseArtifactPayload(artifact: PipelineEventArtifact, limit = ARTIFACT_LIMIT): TypedArtifactPayload {
  if (artifact.schemaVersion !== 1) throw new Error(`artifact ${artifact.kind} schema version is unsupported`);
  if (Buffer.byteLength(artifact.payload, "utf8") > limit) {
    throw new Error(`artifact ${artifact.kind} exceeds the gate size limit`);
  }
  if (containsSecretShapedValue(artifact.payload)) {
    throw new Error(`artifact ${artifact.kind} contains a secret-shaped value`);
  }
  if (!SHA256.test(artifact.hash) || digestNormalized(artifact.payload) !== artifact.hash) {
    throw new Error(`artifact ${artifact.kind} hash mismatch`);
  }
  const parsed: unknown = JSON.parse(artifact.payload);
  if (canonicalJson(parsed) !== artifact.payload) {
    throw new Error(`artifact ${artifact.kind} is not canonical JSON`);
  }
  const input = record(parsed, `artifact ${artifact.kind}`);
  exactKeys(input, ARTIFACT_KEYS, `artifact ${artifact.kind}`);
  if (input.schema !== `openthrottle.artifact/${artifact.kind}@1` || input.kind !== artifact.kind) {
    throw new Error(`artifact ${artifact.kind} schema binding mismatch`);
  }
  const producer = record(input.producer, `artifact ${artifact.kind}.producer`);
  exactKeys(producer, ["capability", "runtime_release", "capability_digest", "version"], "artifact producer");
  const pipeline = record(input.pipeline, `artifact ${artifact.kind}.pipeline`);
  exactKeys(pipeline, ["instance_id", "manifest_digest"], "artifact pipeline");
  const stage = record(input.stage, `artifact ${artifact.kind}.stage`);
  exactKeys(stage, ["id", "attempt_id", "request_hash", "context_revision", "context_policy"], "artifact stage");
  const run = record(input.run, `artifact ${artifact.kind}.run`);
  exactKeys(run, ["id", "ticket_id", "session_id", "generation", "native_session_id"], "artifact run");
  const repository = record(input.repository, `artifact ${artifact.kind}.repository`);
  exactKeys(repository, ["name", "base_commit", "subject", "pre_subject", "post_subject"], "artifact repository");
  if (!ASSURANCE_CLASSES.includes(input.assurance as AssuranceClass)) throw new Error("artifact assurance is invalid");
  if (![...STAGE_OUTCOMES, "not_configured"].includes(input.result as ArtifactResult)) {
    throw new Error("artifact result is invalid");
  }
  const startedAt = timestamp(input.started_at, "artifact started_at");
  const completedAt = timestamp(input.completed_at, "artifact completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error("artifact completion precedes its start");
  const subject = boundedString(repository.subject, "artifact repository subject", 64);
  const preSubject = boundedString(repository.pre_subject, "artifact repository pre_subject", 64);
  const postSubject = boundedString(repository.post_subject, "artifact repository post_subject", 64);
  if (![subject, preSubject, postSubject].every((value) => GIT_SUBJECT.test(value))) {
    throw new Error("artifact repository subject is invalid");
  }
  return {
    schema: input.schema as string,
    kind: input.kind as string,
    producer: {
      capability: boundedString(producer.capability, "artifact producer capability", 160),
      runtime_release: boundedString(producer.runtime_release, "artifact runtime release", 160),
      capability_digest: boundedString(producer.capability_digest, "artifact capability digest", 64),
      version: integer(producer.version, "artifact producer version", 1),
    },
    pipeline: {
      instance_id: boundedString(pipeline.instance_id, "artifact pipeline instance", 200),
      manifest_digest: boundedString(pipeline.manifest_digest, "artifact manifest digest", 64),
    },
    stage: {
      id: boundedString(stage.id, "artifact stage id", 200),
      attempt_id: boundedString(stage.attempt_id, "artifact attempt id", 200),
      request_hash: boundedString(stage.request_hash, "artifact request hash", 64),
      context_revision: integer(stage.context_revision, "artifact context revision"),
      context_policy: boundedString(stage.context_policy, "artifact context policy", 40),
    },
    run: {
      id: boundedString(run.id, "artifact run id", 200),
      ticket_id: boundedString(run.ticket_id, "artifact ticket id", 200),
      session_id: boundedString(run.session_id, "artifact session id", 200),
      generation: integer(run.generation, "artifact generation", 1),
      native_session_id: nullableString(run.native_session_id, "artifact native session id"),
    },
    repository: {
      name: boundedString(repository.name, "artifact repository", 240),
      base_commit: boundedString(repository.base_commit, "artifact base commit", 64),
      subject,
      pre_subject: preSubject,
      post_subject: postSubject,
    },
    assurance: input.assurance as AssuranceClass,
    result: input.result as ArtifactResult,
    summary: boundedString(input.summary, "artifact summary", 2_000),
    evidence: strings(input.evidence, "artifact evidence", 50, 1_000),
    findings: parseFindings(input.findings),
    actions: strings(input.actions, "artifact actions", 50, 1_000),
    uncertainty: strings(input.uncertainty, "artifact uncertainty", 20, 1_000),
    started_at: startedAt,
    completed_at: completedAt,
    details: record(input.details, "artifact details"),
  };
}

function tuneReceipt<T extends "tune_analysis" | "tune_proposal">(
  payloads: readonly TypedArtifactPayload[],
  expectedType: T,
  source: string
): Extract<StandardReceipt, { type: T }> {
  const artifact = payloads.find((payload) => payload.kind === "standard_receipt");
  if (!artifact) throw new Error(`${source} is missing its standard receipt`);
  const receipt = validateStandardReceipt(artifact.details.receipt, { source }).value;
  if (receipt.type !== expectedType) throw new Error(`${source} must be ${expectedType}`);
  return receipt as Extract<StandardReceipt, { type: T }>;
}

function validateTuneReceiptAuthority(
  attempt: PipelineStageAttempt,
  stage: PipelineStage,
  payloads: readonly TypedArtifactPayload[]
): void {
  if (stage.id !== "analysis" && stage.id !== "proposal") return;
  if (!attempt.request_payload) throw new Error(`tune ${stage.id} request is not sealed`);
  const request = JSON.parse(attempt.request_payload) as {
    taskContext?: unknown;
    inputArtifacts?: Array<{ kind?: unknown; payload?: unknown; hash?: unknown }>;
  };
  if (stage.id === "analysis") {
    const receipt = tuneReceipt(payloads, "tune_analysis", "stage.analysis.receipt");
    if (typeof request.taskContext !== "string") throw new Error("tune analysis has no sealed task context");
    const blocks = extractJsonBlocks(request.taskContext, TUNE_ANALYSIS_INPUT_SCHEMA);
    if (blocks.length !== 1) throw new Error("tune analysis requires one supervisor-sealed analysis input");
    const authorized = validateTuneAnalysisInputContract(JSON.parse(blocks[0]!) as unknown, {
      source: "stage.analysis.authorized_input",
    });
    const { generated_at: _generatedAt, ...analysisMaterial } = receipt.payload.analysis;
    const producedInput = validateTuneAnalysisInputContract({
      ...analysisMaterial,
      schema: TUNE_ANALYSIS_INPUT_SCHEMA,
    }, { source: "stage.analysis.receipt_input" });
    if (producedInput.normalized !== authorized.normalized) {
      throw new Error("tune analysis receipt does not preserve the supervisor-sealed input");
    }
    return;
  }

  const receipt = tuneReceipt(payloads, "tune_proposal", "stage.proposal.receipt");
  const predecessor = request.inputArtifacts?.find((artifact) => artifact.kind === "standard_receipt");
  if (!predecessor || typeof predecessor.payload !== "string" || typeof predecessor.hash !== "string" ||
      digestNormalized(predecessor.payload) !== predecessor.hash) {
    throw new Error("tune proposal is missing its sealed analysis receipt");
  }
  const wrapper = JSON.parse(predecessor.payload) as { details?: { receipt?: unknown } };
  const analysisReceipt = validateStandardReceipt(wrapper.details?.receipt, {
    source: "stage.proposal.authorized_analysis_receipt",
  }).value;
  if (analysisReceipt.type !== "tune_analysis" ||
      canonicalJson(receipt.payload.proposal.analysis) !== canonicalJson(analysisReceipt.payload.analysis)) {
    throw new Error("tune proposal is not bound to its authorized analysis receipt");
  }
}

function validateFence(
  payload: TypedArtifactPayload,
  artifact: PipelineEventArtifact,
  instance: PipelineInstance,
  attempt: PipelineStageAttempt,
  stage: PipelineStage,
  event: PipelineCoordinatorEvent,
  subject: string
): void {
  const sealedRequestTicketId = attempt.request_payload === null
    ? null
    : (JSON.parse(attempt.request_payload) as { issueId?: unknown }).issueId;
  // V35 provider-qualifies existing Linear identities without rewriting an
  // already-sealed request or its hash. Accept that one rolling-deploy shape
  // only when the artifact repeats the immutable request identity and the
  // durable instance is its exact `linear:` qualification.
  const ticketIdentityMatches = payload.run.ticket_id === instance.ticket_id ||
    (typeof sealedRequestTicketId === "string" &&
      payload.run.ticket_id === sealedRequestTicketId &&
      instance.ticket_id === `linear:${sealedRequestTicketId}`);
  if (
    payload.producer.capability !== stage.executor.capability ||
    payload.producer.runtime_release !== instance.runtime_release ||
    payload.producer.capability_digest !== instance.capability_digest ||
    payload.pipeline.instance_id !== instance.id ||
    payload.pipeline.manifest_digest !== instance.manifest_digest ||
    payload.stage.id !== stage.id ||
    payload.stage.attempt_id !== attempt.id ||
    payload.stage.request_hash !== attempt.request_hash ||
    payload.stage.context_revision !== attempt.context_revision ||
    payload.stage.context_policy !== attempt.native_context_policy ||
    payload.run.id !== event.runId ||
    !ticketIdentityMatches ||
    payload.run.session_id !== instance.session_id ||
    payload.run.generation !== instance.generation ||
    payload.run.native_session_id !== (event.nativeSessionId ?? null) ||
    payload.repository.name !== instance.repository ||
    payload.repository.base_commit !== instance.base_commit
  ) throw new Error(`artifact ${artifact.kind} provenance fence mismatch`);
  if (attempt.expected_subject !== null && payload.repository.pre_subject !== attempt.expected_subject) {
    throw new Error(`artifact ${artifact.kind} input subject fence mismatch`);
  }
  // A contextless attempt may retain lineage that is intentionally absent
  // from its request and result. During a rolling deploy, an already-sealed
  // legacy request may still carry that session, so accept a reported value
  // only when it is bound to the sealed request. Resumable policies continue
  // to fence against the attempt's durable session identity.
  const sealedRequestNativeSessionId = stage.context === "none" && attempt.request_payload !== null
    ? (JSON.parse(attempt.request_payload) as { nativeSessionId?: unknown }).nativeSessionId
    : null;
  if ((stage.context === "none" && payload.run.native_session_id !== null &&
        payload.run.native_session_id !== sealedRequestNativeSessionId) ||
      (stage.context !== "none" && attempt.native_session_id !== null &&
        payload.run.native_session_id !== attempt.native_session_id)) {
    throw new Error(`artifact ${artifact.kind} native session fence mismatch`);
  }
  if (payload.assurance !== stage.evaluator.assurance || artifact.assurance !== payload.assurance) {
    throw new Error(`artifact ${artifact.kind} assurance mismatch`);
  }
  if (payload.repository.subject !== payload.repository.post_subject ||
      payload.repository.subject !== subject || artifact.subject !== subject) {
    throw new Error(`artifact ${artifact.kind} subject fence mismatch`);
  }
}

export function gateResultForOutcome(outcome: StageOutcome): GateResult {
  if (outcome === "success" || outcome === "no_change") return "passed";
  if (outcome === "retryable_infrastructure_failure" || outcome === "needs_human") return "indeterminate";
  return "failed";
}

export function semanticDecisionForEvidence(input: SemanticDecisionEvidence): { outcome: StageOutcome; result: GateResult; reason: GateReceiptReason } {
  if (input.result === "not_configured" || input.result === "canceled" || input.result === "superseded") {
    throw new Error(`semantic stage proposed forbidden result ${input.result}`);
  }
  const blocking = input.findings
    .filter((finding) => finding.severity === "P0" || finding.severity === "P1");
  if (blocking.length > 0) {
    return { outcome: "semantic_repair_required", result: "failed", reason: "blocking_findings" };
  }
  // A no_change outcome is honored only when the sealed tree is genuinely
  // unchanged. The agent's self-reported result is advisory; the sealed
  // pre/post subjects are authoritative. If the workspace tree actually moved
  // (pre_subject != post_subject) the agent misclassified a real edit, so
  // reclassify to success. Otherwise a modified tree could take a stage's
  // no_change shortcut (e.g. simplification skipping post_simplify_review) and
  // reach the command gates unreviewed on the agent's word alone.
  if (input.result === "no_change" &&
      input.repository.pre_subject !== input.repository.post_subject) {
    return { outcome: "success", result: gateResultForOutcome("success"), reason: "no_change_contradicted_by_tree_delta" };
  }
  return {
    outcome: input.result,
    result: gateResultForOutcome(input.result),
    reason: "typed_semantic_result",
  };
}

function semanticDecision(payloads: TypedArtifactPayload[]): { outcome: StageOutcome; result: GateResult; reason: GateReceiptReason } {
  const stageResult = payloads.find((payload) => payload.kind === "stage_result")!;
  return semanticDecisionForEvidence({
    result: stageResult.result,
    findings: payloads.flatMap((payload) => payload.findings),
    repository: stageResult.repository,
  });
}

export function commandDecisionForEvidence(input: CommandDecisionEvidence): { outcome: StageOutcome; result: GateResult; reason: GateReceiptReason } {
  if (input.not_configured) return { outcome: "no_change", result: "not_configured", reason: "command_not_configured" };
  if (input.timed_out || input.signal !== null || input.exit_code === 137) {
    return { outcome: "retryable_infrastructure_failure", result: "indeterminate", reason: "command_terminated" };
  }
  if (input.exit_code === 0) return { outcome: "success", result: "passed", reason: "command_exit_zero" };
  return { outcome: "failure", result: "failed", reason: "command_exit_nonzero" };
}

function commandDecision(payloads: TypedArtifactPayload[]): { outcome: StageOutcome; result: GateResult; reason: GateReceiptReason } {
  const command = payloads.find((payload) => payload.kind === "command_result");
  if (!command) throw new Error("command gate is missing command_result");
  const details = command.details;
  const notConfigured = details.not_configured;
  const timedOut = details.timed_out;
  const exitCode = details.exit_code;
  const signal = details.signal;
  if (typeof notConfigured !== "boolean" || typeof timedOut !== "boolean" ||
      (exitCode !== null && !Number.isInteger(exitCode)) ||
      (signal !== null && typeof signal !== "string")) {
    throw new Error("command_result has invalid executor evidence");
  }
  return commandDecisionForEvidence({
    not_configured: notConfigured,
    timed_out: timedOut,
    exit_code: exitCode as number | null,
    signal: signal as string | null,
  });
}

function evaluatorDetails(stage: PipelineStage, payloads: TypedArtifactPayload[]): Record<string, unknown> {
  const evidence = payloads.find((payload) =>
    payload.kind === (stage.executor.kind === "supervisor" ? "stage_result" : "standard_receipt")
  );
  if (!evidence) throw new Error("supervisor evaluator is missing its authoritative artifact");
  return evidence.details;
}

function citationDecision(stage: PipelineStage, payloads: TypedArtifactPayload[]): { outcome: StageOutcome; result: GateResult; reason: StageGateReason } {
  const details = evaluatorDetails(stage, payloads);
  const decision = validateCitationGateDecision(details.citation_gate);
  return decision.result === "passed" && decision.outcome === "success"
    ? { outcome: "success", result: "passed", reason: "citation_gate_passed" }
    : { outcome: "failure", result: "failed", reason: "citation_gate_failed" };
}

function differentialRatchetDecision(stage: PipelineStage, payloads: TypedArtifactPayload[]): { outcome: StageOutcome; result: GateResult; reason: StageGateReason } {
  const details = evaluatorDetails(stage, payloads);
  const evaluation = evaluateImprovementProposalGate({
    citationGate: details.citation_gate,
    ratchetInput: details.ratchet_input,
  }, {
    citationReceipts: {
      getCitationGateReceipt() {
        return details.citation_receipt;
      },
    },
  });
  return evaluation.accepted
    ? { outcome: "success", result: "passed", reason: "differential_ratchet_passed" }
    : { outcome: "failure", result: "failed", reason: "differential_ratchet_failed" };
}

function stageDecision(
  stage: PipelineStage,
  payloads: TypedArtifactPayload[]
): { outcome: StageOutcome; result: GateResult; reason: StageGateReason } {
  if (stage.evaluator.kind === "command") return commandDecision(payloads);
  if (stage.evaluator.kind === "citation") return citationDecision(stage, payloads);
  if (stage.evaluator.kind === "differential_ratchet") return differentialRatchetDecision(stage, payloads);
  return semanticDecision(payloads);
}

export function evaluateStageGate(
  store: PipelineStore,
  event: PipelineCoordinatorEvent,
  options: { observedSubject?: string } = {}
): StageGateEvaluation {
  if (event.kind !== "stage_result") throw new Error("sandbox gate accepts only stage_result events");
  if (!event.runId || !event.stageId) throw new Error("stage result is missing its run or stage fence");
  const instance = store.getInstance(event.instanceId);
  if (!instance) throw new Error(`unknown pipeline instance ${event.instanceId}`);
  const attempt = store.getAttempt(event.attemptId);
  if (!attempt || attempt.pipeline_instance_id !== instance.id) throw new Error(`unknown pipeline attempt ${event.attemptId}`);
  if (!attempt.run_id || attempt.run_id !== event.runId) throw new Error("stage result run fence mismatch");
  if (attempt.stage_id !== event.stageId || attempt.request_hash !== event.requestHash) {
    throw new Error("stage result attempt fence mismatch");
  }
  if (instance.generation !== event.generation) throw new Error("stage result generation is stale");
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const stage = manifest.stages.find((candidate) => candidate.id === attempt.stage_id);
  if (!stage) throw new Error(`stage ${attempt.stage_id} is absent from the pinned manifest`);
  const artifacts = event.artifacts ?? [];
  if (new Set(artifacts.map((artifact) => artifact.kind)).size !== artifacts.length) {
    throw new Error("stage result contains duplicate artifact kinds");
  }
  for (const required of ["stage_result", ...stage.evaluator.required_artifacts]) {
    if (!artifacts.some((artifact) => artifact.kind === required)) {
      throw new Error(`stage result is missing required ${required}`);
    }
  }
  if (artifacts.some((artifact) => !stage.produces.includes(artifact.kind as never))) {
    throw new Error("stage result contains undeclared evidence");
  }
  const subject = options.observedSubject ?? event.subject;
  if (!subject || !GIT_SUBJECT.test(subject)) throw new Error("stage result has no valid gated subject");
  if (options.observedSubject && event.subject !== options.observedSubject) {
    throw new Error("workspace changed after stage evidence was sealed");
  }
  const artifactLimit = instance.task_type === "tune" ? TUNE_ARTIFACT_PAYLOAD_LIMIT_BYTES : ARTIFACT_LIMIT;
  const payloads = artifacts.map((artifact) => {
    const payload = parseArtifactPayload(artifact, artifactLimit);
    validateFence(payload, artifact, instance, attempt, stage, event, subject);
    return payload;
  });
  if (instance.task_type === "tune") validateTuneReceiptAuthority(attempt, stage, payloads);
  const stageResult = payloads.find((payload) => payload.kind === "stage_result")!;
  if (artifacts.find((artifact) => artifact.kind === "stage_result")?.hash !== event.resultHash) {
    throw new Error("stage result event hash does not match its artifact");
  }
  if (payloads.some((payload) => payload.result !== stageResult.result)) {
    throw new Error("stage artifacts disagree on their proposed result");
  }
  const decision = stageDecision(stage, payloads);
  let providerRevision: string | undefined;
  if (stage.evaluator.kind === "publish_subject" && decision.outcome === "success") {
    const revision = payloads.find((payload) => payload.kind === "publish_subject")?.details.published_commit;
    if (typeof revision !== "string" || !GIT_COMMIT.test(revision)) {
      throw new Error("publish gate has no executor-verified provider commit");
    }
    providerRevision = revision;
  }
  const artifactHashes = artifacts.map((artifact) => artifact.hash).sort();
  const policy = {
    evaluator: stage.evaluator,
    executor: stage.executor,
    context: stage.context,
    produces: [...stage.produces].sort(),
  };
  const policyDigest = digestNormalized(canonicalJson(policy));
  const receiptPayload = canonicalJson({
    schema: "openthrottle.gate-receipt/v1",
    pipeline_instance_id: instance.id,
    manifest_digest: instance.manifest_digest,
    stage_id: stage.id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    run_id: event.runId,
    generation: instance.generation,
    evaluator_kind: stage.evaluator.kind,
    policy_digest: policyDigest,
    subject,
    proposed_result: stageResult.result,
    decision: decision.result,
    outcome: decision.outcome,
    reason: decision.reason,
    provider_revision: providerRevision ?? null,
    artifact_hashes: artifactHashes,
  });
  return {
    event: {
      ...event,
      outcome: decision.outcome,
      subject,
      ...(providerRevision ? { providerRevision } : {}),
      resultHash: artifacts.find((artifact) => artifact.kind === "stage_result")!.hash,
    },
    receipt: {
      evaluatorKind: stage.evaluator.kind,
      policyDigest,
      subject,
      result: decision.result,
      artifactHashes,
      payload: receiptPayload,
      hash: digestNormalized(receiptPayload),
    },
  };
}

function providerGateReceipt(
  instance: PipelineInstance,
  attempt: PipelineStageAttempt,
  stage: PipelineStage,
  event: PipelineCoordinatorEvent
): CoordinatorGateReceiptWrite {
  const artifactHashes = (event.artifacts ?? []).map((artifact) => artifact.hash).sort();
  const subject = event.subject ?? null;
  const policyDigest = digestNormalized(canonicalJson({ evaluator: stage.evaluator, executor: stage.executor }));
  const payload = canonicalJson({
    schema: "openthrottle.gate-receipt/v1",
    pipeline_instance_id: instance.id,
    stage_id: stage.id,
    attempt_id: attempt.id,
    evaluator_kind: "provider",
    policy_digest: policyDigest,
    subject,
    outcome: event.outcome,
    artifact_hashes: artifactHashes,
  });
  return {
    evaluatorKind: "provider",
    policyDigest,
    subject,
    result: event.outcome === "success" || event.outcome === "no_change" ? "passed" : "failed",
    artifactHashes,
    payload,
    hash: digestNormalized(payload),
  };
}

function assertPublishedTaskBranch(store: PipelineStore, instance: PipelineInstance): void {
  const taskBranch = store.getTaskBranch(instance.id);
  if (!taskBranch) return;
  if (
    taskBranch.status !== "published" ||
    taskBranch.accepted_integration_sha !== taskBranch.acknowledged_remote_sha ||
    taskBranch.acknowledged_remote_sha !== instance.published_subject
  ) {
    throw new Error("provider evidence requires the exact published task branch checkpoint");
  }
}

export function processProviderEvidence(
  store: PipelineStore,
  input: {
    id: string;
    instanceId: string;
    outcome: "success" | "no_change" | "semantic_repair_required" | "retryable_infrastructure_failure" | "needs_human" | "failure";
    summary: string;
    evidence: string[];
    findings?: Finding[];
    providerPayload: Record<string, unknown>;
  }
): PipelineInstance {
  const instance = store.getInstance(input.instanceId);
  if (!instance) throw new Error(`unknown pipeline instance ${input.instanceId}`);
  const existing = store.getInboxEvent(input.id);
  if (existing?.status === "consumed") {
    if (existing.pipeline_instance_id !== instance.id || existing.generation !== instance.generation) {
      throw new Error(`provider event ${input.id} was consumed by a different pipeline generation`);
    }
    const prior = JSON.parse(existing.payload) as PipelineCoordinatorEvent;
    const priorStageResult = prior.artifacts?.find((artifact) => artifact.kind === "stage_result");
    const priorPayload = priorStageResult
      ? JSON.parse(priorStageResult.payload) as { summary?: unknown; evidence?: unknown; details?: unknown }
      : undefined;
    if (prior.outcome !== input.outcome || priorPayload?.summary !== input.summary ||
        canonicalJson(priorPayload?.evidence) !== canonicalJson(input.evidence) ||
        canonicalJson(priorPayload?.details) !== canonicalJson(input.providerPayload)) {
      throw new Error(`provider event ${input.id} conflicts with its consumed payload`);
    }
    return instance;
  }
  const providerRevision = providerRevisionFromPayload(input.providerPayload);
  const recoveringCanceledMerge =
    instance.status === "canceled" &&
    instance.terminal_outcome === "canceled" &&
    input.outcome === "success" &&
    input.providerPayload.kind === "pull_request" &&
    input.providerPayload.action === "closed" &&
    input.providerPayload.merged === true &&
    providerRevision !== undefined &&
    providerRevision === instance.published_commit;
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const attempt = store.getActiveAttempt(instance.id) ?? (recoveringCanceledMerge
    ? [...store.listAttempts(instance.id)].reverse().find((candidate) => {
        const candidateStage = manifest.stages.find((stage) => stage.id === candidate.stage_id);
        return candidate.status === "canceled" &&
          candidateStage?.executor.kind === "provider_wait" &&
          candidateStage.evaluator.kind === "provider";
      })
    : undefined);
  if (!attempt) throw new Error(`pipeline instance ${input.instanceId} has no provider attempt`);
  const stage = manifest.stages.find((candidate) => candidate.id === attempt.stage_id);
  if (!stage || stage.executor.kind !== "provider_wait" || stage.evaluator.kind !== "provider") {
    throw new Error(`pipeline attempt ${attempt.id} is not a provider-wait stage`);
  }
  const subject = instance.immutable_subject;
  if (!subject || !GIT_SUBJECT.test(subject)) throw new Error("provider evidence has no immutable subject");
  // Provider webhook identities are replayed by GitHub. Bind receipt time to
  // the immutable provider attempt so the same stable event ID always hashes
  // to the same inbox payload across retries and supervisor restarts.
  const timestamp = attempt.created_at;
  const makeArtifact = (kind: "stage_result" | "provider_check"): PipelineEventArtifact => {
    const payload = canonicalJson({
      schema: `openthrottle.artifact/${kind}@1`,
      kind,
      producer: {
        capability: stage.executor.capability,
        runtime_release: instance.runtime_release,
        capability_digest: instance.capability_digest,
        version: 1,
      },
      pipeline: { instance_id: instance.id, manifest_digest: instance.manifest_digest },
      stage: {
        id: stage.id,
        attempt_id: attempt.id,
        request_hash: attempt.request_hash,
        context_revision: attempt.context_revision,
        context_policy: attempt.native_context_policy,
      },
      run: {
        id: attempt.planned_run_id,
        ticket_id: instance.ticket_id,
        session_id: instance.session_id,
        generation: instance.generation,
        native_session_id: stage.context === "none" ? null : attempt.native_session_id,
      },
      repository: {
        name: instance.repository,
        base_commit: instance.base_commit,
        subject,
        pre_subject: subject,
        post_subject: subject,
      },
      assurance: "provider_verified",
      result: input.outcome,
      summary: input.summary,
      evidence: input.evidence,
      findings: input.findings ?? [],
      actions: [],
      uncertainty: [],
      started_at: timestamp,
      completed_at: timestamp,
      details: input.providerPayload,
    });
    return {
      kind,
      schemaVersion: 1,
      assurance: "provider_verified",
      subject,
      payload,
      hash: digestNormalized(payload),
    };
  };
  const artifacts = [makeArtifact("stage_result"), makeArtifact("provider_check")];
  const event: PipelineCoordinatorEvent = {
    id: input.id,
    kind: "provider_snapshot",
    instanceId: instance.id,
    generation: instance.generation,
    attemptId: attempt.id,
    requestHash: attempt.request_hash,
    outcome: input.outcome,
    resultHash: artifacts[0]!.hash,
    subject,
    ...(providerRevision ? { providerRevision } : {}),
    nativeSessionId: stage.context === "none" ? null : attempt.native_session_id,
    artifacts,
  };
  if (instance.status === "completion_pending_publication" || instance.status === "publication_blocked") {
    store.enqueueInboxEvent({
      id: event.id,
      instanceId: instance.id,
      generation: instance.generation,
      kind: event.kind,
      payload: canonicalJson(event),
      subject,
    });
    return instance;
  }
  if (instance.status !== "waiting_provider" && !recoveringCanceledMerge) {
    throw new Error(`pipeline instance ${input.instanceId} is not waiting for provider evidence`);
  }
  assertPublishedTaskBranch(store, instance);
  return coordinatePipelineEvent(store, event, undefined, providerGateReceipt(instance, attempt, stage, event));
}

const TERMINAL_INSTANCE_STATUSES = new Set<string>(PIPELINE_OUTCOMES);

export function drainDeferredProviderEvidence(store: PipelineStore, limit = 50): number {
  let processed = 0;
  for (const record of store.listPendingInboxEvents("provider_snapshot", limit)) {
    const instance = store.getInstance(record.pipeline_instance_id);
    if (!instance || TERMINAL_INSTANCE_STATUSES.has(instance.status)) {
      // A terminal or vanished instance can never return to waiting_provider,
      // and the pending query is a global oldest-first window: leaving these
      // rows pending would eventually starve every live deferred event.
      store.markInboxEventDead(record.id);
      continue;
    }
    // A live instance that is merely mid-stage keeps its row pending; the
    // evidence becomes coordinatable when it re-enters waiting_provider.
    if (instance.status !== "waiting_provider") continue;
    const event = JSON.parse(record.payload) as PipelineCoordinatorEvent;
    const attempt = store.getAttempt(event.attemptId);
    if (!attempt || attempt.pipeline_instance_id !== instance.id) {
      throw new Error(`deferred provider event ${event.id} lost its attempt binding`);
    }
    const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
    const stage = manifest.stages.find((candidate) => candidate.id === attempt.stage_id);
    if (!stage || stage.executor.kind !== "provider_wait" || stage.evaluator.kind !== "provider") {
      throw new Error(`deferred provider event ${event.id} does not target a provider stage`);
    }
    coordinatePipelineEvent(store, event, undefined, providerGateReceipt(instance, attempt, stage, event));
    processed += 1;
  }
  return processed;
}
