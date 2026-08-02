import type {
  CandidateEvidenceReceipt,
  CommandResultReceipt,
  IntegrationEvidenceReceipt,
  SemanticReviewReceipt,
  UnitCompletionReceipt,
  UnitDecisionReceipt,
} from "@openthrottle/contracts";
import {
  canonicalJson,
  digestNormalized,
  type StageOutcome,
} from "./manifest.js";
import {
  commandDecisionForEvidence,
  semanticDecisionForEvidence,
  type GateResult,
} from "./gates.js";

const SEMANTIC_REVIEW_SKILL = /(?:^|\/)ce-code-review(?:@|$)/;

export interface ExpectedReceiptProducer {
  workerId: string;
  skill: string;
  capabilityDigest: string;
  // Exact repository skill package digest this producer must have invoked,
  // separate from capabilityDigest (the runtime executor capability).
  // Undefined skips the check; null asserts a builtin (no-package) producer.
  skillPackageDigest?: string | null;
  assurance: UnitCompletionReceipt["assurance"];
}

export interface StandardReceiptFence {
  pipelineInstanceId: string;
  graphDigest: string;
  unitId: string;
  attemptId: string;
  parentRunId: string;
  actionAttemptId: string;
  generation: number;
  nativeSessionId: string | null;
  requestHash: string;
  baseSubject: string;
  preSubject: string;
  subject: string;
  producers?: Partial<Record<"completion" | "candidate" | "command" | "lead" | "integration" | "review", ExpectedReceiptProducer>>;
}

export interface ExecutionGateDecision {
  gateKind: "unit_acceptance" | "integration" | "final_review";
  outcome: StageOutcome;
  result: GateResult;
  reason: string;
  subject: string;
  artifactHashes: string[];
  payload: string;
  hash: string;
}

function assertReceiptFence(
  receipt: UnitCompletionReceipt | UnitDecisionReceipt | CommandResultReceipt | CandidateEvidenceReceipt | IntegrationEvidenceReceipt | SemanticReviewReceipt,
  expected: StandardReceiptFence,
  label: string
): void {
  if (
    receipt.fence.pipeline_instance_id !== expected.pipelineInstanceId ||
    receipt.fence.graph_digest !== expected.graphDigest ||
    receipt.fence.unit_id !== expected.unitId ||
    receipt.fence.attempt_id !== expected.attemptId ||
    receipt.fence.parent_run_id !== expected.parentRunId ||
    receipt.fence.action_attempt_id !== expected.actionAttemptId ||
    receipt.fence.generation !== expected.generation ||
    receipt.fence.native_session_id !== expected.nativeSessionId ||
    receipt.fence.request_hash !== expected.requestHash
  ) throw new Error(`${label} receipt fence mismatch`);
  if (receipt.subject.base !== expected.baseSubject || receipt.subject.pre !== expected.preSubject) {
    throw new Error(`${label} receipt input subject mismatch`);
  }
  if (receipt.subject.post !== expected.subject) throw new Error(`${label} receipt subject mismatch`);
  const producer = expected.producers?.[label as keyof NonNullable<StandardReceiptFence["producers"]>];
  if (!producer) return;
  if (
    receipt.producer.worker_id !== producer.workerId ||
    receipt.producer.skill !== producer.skill ||
    receipt.producer.capability_digest !== producer.capabilityDigest ||
    receipt.assurance !== producer.assurance ||
    (producer.skillPackageDigest !== undefined && receipt.producer.skill_package_digest !== producer.skillPackageDigest)
  ) throw new Error(`${label} receipt producer mismatch`);
}

function commandOutcome(
  receipts: readonly CommandResultReceipt[],
  expectedCommandNames: readonly string[]
): { outcome: StageOutcome; result: GateResult; reason: string } {
  const expectedNames = [...new Set(expectedCommandNames)].sort();
  const actualNames = receipts.map((receipt) => receipt.payload.command).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    return { outcome: "failure", result: "failed", reason: "command_receipts_missing_or_unexpected" };
  }
  for (const receipt of receipts) {
    const decision = commandDecisionForEvidence({
      not_configured: receipt.result === "not_configured",
      timed_out: false,
      exit_code: receipt.payload.exit_code,
      signal: null,
    });
    if (decision.outcome !== "success" && decision.outcome !== "no_change") return decision;
  }
  return { outcome: "success", result: "passed", reason: "all_commands_current" };
}

function seal(kind: ExecutionGateDecision["gateKind"], input: {
  expected: StandardReceiptFence;
  outcome: StageOutcome;
  result: GateResult;
  reason: string;
  artifactHashes: string[];
}): ExecutionGateDecision {
  const artifactHashes = [...input.artifactHashes].sort();
  const payload = canonicalJson({
    schema: "openthrottle.execution-gate-receipt/v1",
    gate_kind: kind,
    pipeline_instance_id: input.expected.pipelineInstanceId,
    graph_digest: input.expected.graphDigest,
    unit_id: input.expected.unitId,
    attempt_id: input.expected.attemptId,
    parent_run_id: input.expected.parentRunId,
    action_attempt_id: input.expected.actionAttemptId,
    generation: input.expected.generation,
    native_session_id: input.expected.nativeSessionId,
    request_hash: input.expected.requestHash,
    subject: input.expected.subject,
    outcome: input.outcome,
    result: input.result,
    reason: input.reason,
    artifact_hashes: artifactHashes,
  });
  return {
    gateKind: kind,
    outcome: input.outcome,
    result: input.result,
    reason: input.reason,
    subject: input.expected.subject,
    artifactHashes,
    payload,
    hash: digestNormalized(payload),
  };
}

function receiptHash(receipt: object): string {
  return digestNormalized(canonicalJson(receipt));
}

function issuedAt(receipt: { issued_at: string }, label: string): number {
  const timestamp = Date.parse(receipt.issued_at);
  if (Number.isNaN(timestamp)) throw new Error(`${label} receipt issued_at is invalid`);
  return timestamp;
}

export function evaluateUnitAcceptanceGate(input: {
  expected: StandardReceiptFence;
  completion: UnitCompletionReceipt;
  candidate: CandidateEvidenceReceipt;
  commands: readonly CommandResultReceipt[];
  expectedCommandNames: readonly string[];
  lead: UnitDecisionReceipt;
}): ExecutionGateDecision {
  assertReceiptFence(input.completion, input.expected, "completion");
  assertReceiptFence(input.candidate, input.expected, "candidate");
  assertReceiptFence(input.lead, input.expected, "lead");
  for (const command of input.commands) assertReceiptFence(command, input.expected, "command");
  if (SEMANTIC_REVIEW_SKILL.test(input.lead.producer.skill)) {
    throw new Error("unit acceptance must not be produced by ce-code-review");
  }
  const artifactHashes = [
    input.completion,
    input.candidate,
    input.lead,
    ...input.commands,
  ].map(receiptHash);
  if (input.candidate.result !== "success") {
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: "failure",
      result: "failed",
      reason: "candidate_evidence_failed",
      artifactHashes,
    });
  }
  if (input.completion.result !== "success") {
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: input.completion.result === "needs_human" ? "needs_human" : "failure",
      result: input.completion.result === "needs_human" ? "indeterminate" : "failed",
      reason: "worker_completion_not_success",
      artifactHashes,
    });
  }
  const commands = commandOutcome(input.commands, input.expectedCommandNames);
  if (commands.outcome !== "success" && commands.outcome !== "no_change") {
    return seal("unit_acceptance", { expected: input.expected, ...commands, artifactHashes });
  }
  if (input.lead.result === "accept") {
    if (input.lead.payload.accepted_subject !== input.expected.subject) {
      throw new Error("lead accepted_subject fence mismatch");
    }
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: "success",
      result: "passed",
      reason: "lead_scope_match_accept",
      artifactHashes,
    });
  }
  if (input.lead.result === "revise") {
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: "semantic_repair_required",
      result: "failed",
      reason: "lead_requested_revision",
      artifactHashes,
    });
  }
  return seal("unit_acceptance", {
    expected: input.expected,
    outcome: input.lead.result === "needs_human" ? "needs_human" : "no_change",
    result: input.lead.result === "needs_human" ? "indeterminate" : "passed",
    reason: input.lead.result === "needs_human" ? "lead_needs_human" : "lead_context_update",
    artifactHashes,
  });
}

export function evaluateIntegrationGate(input: {
  expected: StandardReceiptFence;
  integration: IntegrationEvidenceReceipt;
}): ExecutionGateDecision {
  assertReceiptFence(input.integration, input.expected, "integration");
  return seal("integration", {
    expected: input.expected,
    outcome: input.integration.result === "success" ? "success" : "failure",
    result: input.integration.result === "success" ? "passed" : "failed",
    reason: input.integration.result === "success" ? "executor_integrated_candidate" : "integration_evidence_failed",
    artifactHashes: [receiptHash(input.integration)],
  });
}

export function evaluateFinalReviewGate(input: {
  expected: StandardReceiptFence;
  commands: readonly CommandResultReceipt[];
  expectedCommandNames: readonly string[];
  review: SemanticReviewReceipt;
}): ExecutionGateDecision {
  for (const command of input.commands) assertReceiptFence(command, input.expected, "command");
  assertReceiptFence(input.review, input.expected, "review");
  const reviewIssuedAt = issuedAt(input.review, "review");
  for (const command of input.commands) {
    if (issuedAt(command, "command") > reviewIssuedAt) {
      throw new Error("final review receipt predates whole-change command evidence");
    }
  }
  const commands = commandOutcome(input.commands, input.expectedCommandNames);
  const artifactHashes = [...input.commands, input.review].map(receiptHash);
  if (commands.outcome !== "success" && commands.outcome !== "no_change") {
    return seal("final_review", { expected: input.expected, ...commands, artifactHashes });
  }
  const review = semanticDecisionForEvidence({
    result: input.review.result,
    findings: input.review.payload.findings,
    repository: {
      pre_subject: input.review.subject.pre,
      post_subject: input.review.subject.post,
    },
  });
  return seal("final_review", { expected: input.expected, ...review, artifactHashes });
}
