import type {
  CandidateEvidenceReceipt,
  CommandResultReceipt,
  IntegrationEvidenceReceipt,
  SemanticReviewReceipt,
  UnitCompletionReceipt,
  UnitDecisionReceipt,
} from "@openthrottle/contracts";
import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import {
  type StageOutcome,
} from "./manifest.js";
import {
  commandDecisionForEvidence,
  semanticDecisionForEvidence,
  type GateReceiptReason,
  type GateResult,
} from "./gates.js";
import type { ReviewFanoutSynthesis } from "./review-fanout.js";

const SEMANTIC_REVIEW_SKILL = /(?:^|\/)ce-code-review(?:@|$)/;

export type ReceiptProducerRole = "completion" | "candidate" | "command" | "lead" | "integration" | "review";

export interface ExpectedReceiptProducer {
  workerId: string;
  skill: string;
  capabilityDigest: string;
  // Exact repository skill package digest this producer must have invoked,
  // separate from capabilityDigest (the runtime executor capability).
  // Must be set explicitly: null asserts a builtin (no-package) producer.
  // There is no opt-out — every role's producer binding is checked.
  skillPackageDigest: string | null;
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
  producers: Record<ReceiptProducerRole, ExpectedReceiptProducer>;
}

export interface ExecutionGateDecision {
  gateKind: "unit_acceptance" | "integration" | "final_review";
  outcome: StageOutcome;
  result: GateResult;
  reason: GateReceiptReason;
  subject: string;
  artifactHashes: string[];
  payload: string;
  hash: string;
}

export interface UnitAcceptanceReceiptFences {
  completion: StandardReceiptFence;
  candidate: StandardReceiptFence;
  commands: readonly StandardReceiptFence[];
  lead: StandardReceiptFence;
}

export interface FinalReviewReceiptFences {
  commands: readonly StandardReceiptFence[];
  review: StandardReceiptFence;
}

function assertReceiptFence(
  receipt: UnitCompletionReceipt | UnitDecisionReceipt | CommandResultReceipt | CandidateEvidenceReceipt | IntegrationEvidenceReceipt | SemanticReviewReceipt,
  expected: StandardReceiptFence,
  label: ReceiptProducerRole
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
  const producer = expected.producers[label];
  if (
    receipt.producer.worker_id !== producer.workerId ||
    receipt.producer.skill !== producer.skill ||
    receipt.producer.capability_digest !== producer.capabilityDigest ||
    receipt.assurance !== producer.assurance ||
    receipt.producer.skill_package_digest !== producer.skillPackageDigest
  ) throw new Error(`${label} receipt producer mismatch`);
}

export function assertStandardReceiptFence(input: {
  expected: StandardReceiptFence;
  receipt: UnitCompletionReceipt | UnitDecisionReceipt | CommandResultReceipt | CandidateEvidenceReceipt | IntegrationEvidenceReceipt | SemanticReviewReceipt;
  role: ReceiptProducerRole;
}): void {
  assertReceiptFence(input.receipt, input.expected, input.role);
}

// A lead or final-review receipt attests to a decision made from exact prior
// evidence. Binding its `evidence` field to the receipt hashes of that prior
// evidence stops an attestation with a correct identity/subject envelope but
// empty or unrelated evidence from being paired with receipts it was never
// actually based on.
function assertEvidenceBinding(
  receipt: { evidence: readonly string[] },
  requiredHashes: readonly string[],
  label: string
): void {
  const evidenceSet = new Set(receipt.evidence);
  for (const hash of requiredHashes) {
    if (!evidenceSet.has(hash)) throw new Error(`${label} receipt evidence missing required artifact hash`);
  }
}

function commandOutcome(
  receipts: readonly CommandResultReceipt[],
  expectedCommandNames: readonly string[]
): { outcome: StageOutcome; result: GateResult; reason: GateReceiptReason } {
  const expectedNames = [...new Set(expectedCommandNames)].sort();
  const actualNames = receipts.map((receipt) => receipt.payload.command).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    return { outcome: "failure", result: "failed", reason: "command_receipts_missing_or_unexpected" };
  }
  for (const receipt of receipts) {
    if (receipt.result === "not_configured") {
      return { outcome: "failure", result: "failed", reason: "required_command_not_configured" };
    }
    const decision = commandDecisionForEvidence({
      not_configured: false,
      timed_out: false,
      exit_code: receipt.payload.exit_code,
      signal: null,
    });
    if (receipt.result !== "success" && (decision.outcome === "success" || decision.outcome === "no_change")) {
      return { outcome: "failure", result: "failed", reason: "command_receipt_failed" };
    }
    if (decision.outcome !== "success" && decision.outcome !== "no_change") return decision;
  }
  return { outcome: "success", result: "passed", reason: "all_commands_current" };
}

function seal(kind: ExecutionGateDecision["gateKind"], input: {
  expected: StandardReceiptFence;
  outcome: StageOutcome;
  result: GateResult;
  reason: GateReceiptReason;
  artifactHashes: string[];
  reviewFanout?: ReviewFanoutSynthesis;
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
    ...(input.reviewFanout ? { review_fanout_synthesis: input.reviewFanout } : {}),
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
  expectedReceipts?: UnitAcceptanceReceiptFences;
  completion: UnitCompletionReceipt;
  candidate: CandidateEvidenceReceipt;
  commands: readonly CommandResultReceipt[];
  expectedCommandNames: readonly string[];
  lead: UnitDecisionReceipt;
  reviewFanout?: ReviewFanoutSynthesis;
}): ExecutionGateDecision {
  if (SEMANTIC_REVIEW_SKILL.test(input.lead.producer.skill)) {
    throw new Error("unit acceptance must not be produced by ce-code-review");
  }
  const fences = input.expectedReceipts ?? {
    completion: input.expected,
    candidate: input.expected,
    commands: input.commands.map(() => input.expected),
    lead: input.expected,
  };
  assertReceiptFence(input.completion, fences.completion, "completion");
  assertReceiptFence(input.candidate, fences.candidate, "candidate");
  assertReceiptFence(input.lead, fences.lead, "lead");
  input.commands.forEach((command, index) => assertReceiptFence(command, fences.commands[index] ?? input.expected, "command"));
  const completionHash = receiptHash(input.completion);
  const candidateHash = receiptHash(input.candidate);
  const commandHashes = input.commands.map(receiptHash);
  assertEvidenceBinding(input.lead, [completionHash, candidateHash, ...commandHashes], "lead");
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
      reviewFanout: input.reviewFanout,
    });
  }
  if (input.completion.result !== "success") {
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: input.completion.result === "needs_human" ? "needs_human" : "failure",
      result: input.completion.result === "needs_human" ? "indeterminate" : "failed",
      reason: "worker_completion_not_success",
      artifactHashes,
      reviewFanout: input.reviewFanout,
    });
  }
  const commands = commandOutcome(input.commands, input.expectedCommandNames);
  if (commands.outcome !== "success" && commands.outcome !== "no_change") {
    return seal("unit_acceptance", { expected: input.expected, ...commands, artifactHashes, reviewFanout: input.reviewFanout });
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
      reviewFanout: input.reviewFanout,
    });
  }
  if (input.lead.result === "revise") {
    return seal("unit_acceptance", {
      expected: input.expected,
      outcome: "semantic_repair_required",
      result: "failed",
      reason: "lead_requested_revision",
      artifactHashes,
      reviewFanout: input.reviewFanout,
    });
  }
  return seal("unit_acceptance", {
    expected: input.expected,
    outcome: input.lead.result === "needs_human" ? "needs_human" : "no_change",
    result: input.lead.result === "needs_human" ? "indeterminate" : "passed",
    reason: input.lead.result === "needs_human" ? "lead_needs_human" : "lead_context_update",
    artifactHashes,
    reviewFanout: input.reviewFanout,
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

export function assertCandidateEvidenceFence(input: {
  expected: StandardReceiptFence;
  candidate: CandidateEvidenceReceipt;
}): void {
  assertReceiptFence(input.candidate, input.expected, "candidate");
}

export function evaluateFinalReviewGate(input: {
  expected: StandardReceiptFence;
  expectedReceipts?: FinalReviewReceiptFences;
  commands: readonly CommandResultReceipt[];
  expectedCommandNames: readonly string[];
  review: SemanticReviewReceipt;
  reviewFanout?: ReviewFanoutSynthesis;
}): ExecutionGateDecision {
  const fences = input.expectedReceipts ?? {
    commands: input.commands.map(() => input.expected),
    review: input.expected,
  };
  input.commands.forEach((command, index) => assertReceiptFence(command, fences.commands[index] ?? input.expected, "command"));
  assertReceiptFence(input.review, fences.review, "review");
  const reviewIssuedAt = issuedAt(input.review, "review");
  for (const command of input.commands) {
    if (issuedAt(command, "command") > reviewIssuedAt) {
      throw new Error("final review receipt predates whole-change command evidence");
    }
  }
  const commandHashes = input.commands.map(receiptHash);
  assertEvidenceBinding(input.review, commandHashes, "review");
  const commands = commandOutcome(input.commands, input.expectedCommandNames);
  const artifactHashes = [...input.commands, input.review].map(receiptHash);
  if (commands.outcome !== "success" && commands.outcome !== "no_change") {
    return seal("final_review", { expected: input.expected, ...commands, artifactHashes, reviewFanout: input.reviewFanout });
  }
  const review = semanticDecisionForEvidence({
    result: input.review.result,
    findings: input.review.payload.findings,
    repository: {
      pre_subject: input.review.subject.pre,
      post_subject: input.review.subject.post,
    },
  });
  return seal("final_review", { expected: input.expected, ...review, artifactHashes, reviewFanout: input.reviewFanout });
}
