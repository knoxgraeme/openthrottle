import {
  GIT_SUBJECT,
  NATIVE_SESSION_ID,
  PRODUCER_SKILL_REFERENCE,
  SHA256,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import { RECEIPT_TYPES } from "./graph.js";
import {
  validateTuneAnalysisContract,
  validateTuneProposalContract,
  type TuneAnalysis,
  type TuneProposal,
} from "./tune-contract.js";

export const RECEIPT_SCHEMA = "openthrottle.receipt/v1" as const;
// Kept byte-identical with sandbox/runner/artifacts.mjs. A structured repair
// can carry up to sixteen command receipts inside a 48 KiB prior-evidence
// envelope, so each stream gets a deliberately small byte (not character)
// budget.
export const COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES = 512;
export const ASSURANCE_CLASSES = [
  "semantic_attested",
  "semantic_corroborated",
  "executor_verified",
  "provider_verified",
  "human_approved",
] as const;
export const TUNE_RECEIPT_TYPES = ["tune_analysis", "tune_proposal"] as const;
export const STANDARD_RECEIPT_TYPES = [...RECEIPT_TYPES, ...TUNE_RECEIPT_TYPES] as const;
export type StandardReceiptType = (typeof STANDARD_RECEIPT_TYPES)[number];
export const RECEIPT_RESULTS_BY_TYPE = {
  unit_completion: ["success", "failure", "needs_human", "exited"],
  unit_decision: ["accept", "revise", "context_update", "needs_human"],
  semantic_review: ["success", "no_change", "semantic_repair_required", "failure", "needs_human"],
  command_result: ["success", "failure", "not_configured"],
  candidate_evidence: ["success", "failure"],
  integration_evidence: ["success", "failure"],
  publish_subject: ["success", "failure"],
  provider_evidence: ["success", "semantic_repair_required", "failure"],
  human_approval: ["approved", "rejected", "needs_human"],
  tune_analysis: ["success", "failure", "needs_human"],
  tune_proposal: ["success", "no_change", "failure", "needs_human"],
} as const satisfies Record<StandardReceiptType, readonly string[]>;

export interface ReceiptProducer {
  worker_id: string;
  skill: string;
  capability_digest: string;
  // Exact package digest of the pinned repository skill this producer
  // invoked, separate from capability_digest (the runtime executor
  // capability, e.g. agent/repository-skill@1). Null for builtin skills,
  // which have no repository package to pin.
  skill_package_digest: string | null;
}

export interface ReceiptFence {
  pipeline_instance_id: string;
  graph_digest: string;
  unit_id: string;
  attempt_id: string;
  parent_run_id: string;
  action_attempt_id: string;
  generation: number;
  native_session_id: string | null;
  request_hash: string;
}

export type ReceiptAssurance = (typeof ASSURANCE_CLASSES)[number];

export interface UnitCompletionPayload {
  summary: string;
  assumptions: string[];
  decisions: string[];
  issues: string[];
  verification: string[];
  downstream_context: ContextRecord[];
  requested_human_input: string[];
}

export interface UnitDecisionPayload {
  rationale: string;
  revision_request?: string;
  context_updates: ContextRecord[];
  accepted_subject?: string;
}

export interface SemanticReviewPayload {
  summary: string;
  findings: ReviewFinding[];
}

export interface CommandResultPayload {
  command: string;
  exit_code: number;
  summary: string;
  stdout_digest?: string;
  stderr_digest?: string;
  stdout_tail?: string;
  stderr_tail?: string;
}

export interface SubjectEvidencePayload {
  tree: string;
  diff_digest: string;
  changed_paths: string[];
  clean: boolean;
}

export interface PublishSubjectPayload {
  commit: string;
  tree: string;
  pr_url: string;
}

export interface ProviderEvidencePayload {
  review_url?: string;
  check_run_url?: string;
  summary: string;
}

export interface HumanApprovalPayload {
  approver: string;
  rationale: string;
}

export interface TuneAnalysisReceiptPayload {
  summary: string;
  analysis: TuneAnalysis;
}

export interface TuneProposalReceiptPayload {
  summary: string;
  proposal: TuneProposal;
}

interface StandardReceiptBase<TType extends StandardReceiptType, TResult extends string, TPayload> {
  schema: typeof RECEIPT_SCHEMA;
  type: TType;
  assurance: ReceiptAssurance;
  result: TResult;
  producer: ReceiptProducer;
  subject: {
    base: string;
    pre: string;
    post: string;
  };
  fence: ReceiptFence;
  evidence: string[];
  payload: TPayload;
  issued_at: string;
}

export type UnitCompletionReceipt = StandardReceiptBase<
  "unit_completion",
  (typeof RECEIPT_RESULTS_BY_TYPE.unit_completion)[number],
  UnitCompletionPayload
>;
export type UnitDecisionReceipt = StandardReceiptBase<
  "unit_decision",
  (typeof RECEIPT_RESULTS_BY_TYPE.unit_decision)[number],
  UnitDecisionPayload
>;
export type SemanticReviewReceipt = StandardReceiptBase<
  "semantic_review",
  (typeof RECEIPT_RESULTS_BY_TYPE.semantic_review)[number],
  SemanticReviewPayload
>;
export type CommandResultReceipt = StandardReceiptBase<
  "command_result",
  (typeof RECEIPT_RESULTS_BY_TYPE.command_result)[number],
  CommandResultPayload
>;
export type CandidateEvidenceReceipt = StandardReceiptBase<
  "candidate_evidence",
  (typeof RECEIPT_RESULTS_BY_TYPE.candidate_evidence)[number],
  SubjectEvidencePayload
>;
export type IntegrationEvidenceReceipt = StandardReceiptBase<
  "integration_evidence",
  (typeof RECEIPT_RESULTS_BY_TYPE.integration_evidence)[number],
  SubjectEvidencePayload
>;
export type PublishSubjectReceipt = StandardReceiptBase<
  "publish_subject",
  (typeof RECEIPT_RESULTS_BY_TYPE.publish_subject)[number],
  PublishSubjectPayload
>;
export type ProviderEvidenceReceipt = StandardReceiptBase<
  "provider_evidence",
  (typeof RECEIPT_RESULTS_BY_TYPE.provider_evidence)[number],
  ProviderEvidencePayload
>;
export type HumanApprovalReceipt = StandardReceiptBase<
  "human_approval",
  (typeof RECEIPT_RESULTS_BY_TYPE.human_approval)[number],
  HumanApprovalPayload
>;
export type TuneAnalysisReceipt = StandardReceiptBase<
  "tune_analysis",
  (typeof RECEIPT_RESULTS_BY_TYPE.tune_analysis)[number],
  TuneAnalysisReceiptPayload
>;
export type TuneProposalReceipt = StandardReceiptBase<
  "tune_proposal",
  (typeof RECEIPT_RESULTS_BY_TYPE.tune_proposal)[number],
  TuneProposalReceiptPayload
>;

export type StandardReceipt =
  | UnitCompletionReceipt
  | UnitDecisionReceipt
  | SemanticReviewReceipt
  | CommandResultReceipt
  | CandidateEvidenceReceipt
  | IntegrationEvidenceReceipt
  | PublishSubjectReceipt
  | ProviderEvidenceReceipt
  | HumanApprovalReceipt
  | TuneAnalysisReceipt
  | TuneProposalReceipt;

const SEMANTIC_RECEIPTS = new Set<StandardReceiptType>([
  "unit_completion", "semantic_review", "unit_decision", "tune_analysis", "tune_proposal",
]);

function parseProducer(value: unknown, path: string): ReceiptProducer {
  const input = objectAt(value, path, ["worker_id", "skill", "capability_digest", "skill_package_digest"]);
  return {
    worker_id: stringAt(input.worker_id, `${path}.worker_id`, { max: 120 }),
    skill: stringAt(input.skill, `${path}.skill`, { max: 320, pattern: PRODUCER_SKILL_REFERENCE }),
    capability_digest: stringAt(input.capability_digest, `${path}.capability_digest`, { pattern: SHA256 }),
    skill_package_digest: nullable(input.skill_package_digest, (entry) =>
      stringAt(entry, `${path}.skill_package_digest`, { pattern: SHA256 })),
  };
}

function parseFence(value: unknown, path: string): ReceiptFence {
  const input = objectAt(value, path, [
    "pipeline_instance_id", "graph_digest", "unit_id", "attempt_id",
    "parent_run_id", "action_attempt_id", "generation", "native_session_id", "request_hash",
  ]);
  return {
    pipeline_instance_id: stringAt(input.pipeline_instance_id, `${path}.pipeline_instance_id`, { max: 160 }),
    graph_digest: stringAt(input.graph_digest, `${path}.graph_digest`, { pattern: SHA256 }),
    unit_id: stringAt(input.unit_id, `${path}.unit_id`, { max: 120 }),
    attempt_id: stringAt(input.attempt_id, `${path}.attempt_id`, { max: 160 }),
    parent_run_id: stringAt(input.parent_run_id, `${path}.parent_run_id`, { max: 160 }),
    action_attempt_id: stringAt(input.action_attempt_id, `${path}.action_attempt_id`, { max: 160 }),
    generation: integerAt(input.generation, `${path}.generation`, 1, 1_000_000),
    native_session_id: nullable(input.native_session_id, (entry) =>
      stringAt(entry, `${path}.native_session_id`, { max: 200, pattern: NATIVE_SESSION_ID })),
    request_hash: stringAt(input.request_hash, `${path}.request_hash`, { pattern: SHA256 }),
  };
}

function parseSubject(value: unknown, path: string): StandardReceipt["subject"] {
  const input = objectAt(value, path, ["base", "pre", "post"]);
  return {
    base: stringAt(input.base, `${path}.base`, { pattern: GIT_SUBJECT }),
    pre: stringAt(input.pre, `${path}.pre`, { pattern: GIT_SUBJECT }),
    post: stringAt(input.post, `${path}.post`, { pattern: GIT_SUBJECT }),
  };
}

function timestamp(value: unknown, path: string): string {
  const result = stringAt(value, path, { max: 64 });
  if (Number.isNaN(Date.parse(result))) fail(path, "must be an ISO timestamp");
  return result;
}

function stringList(value: unknown, path: string, max = 32): string[] {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { max: 1_000 }), { max });
}

function commandDiagnosticTail(value: unknown, path: string): string {
  const tail = stringAt(value, path, { max: COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES });
  if (Buffer.byteLength(tail, "utf8") > COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES) {
    fail(path, `must contain at most ${COMMAND_DIAGNOSTIC_TAIL_MAX_BYTES} UTF-8 bytes`);
  }
  return tail;
}

export interface ContextRecord {
  unit_id: string;
  summary: string;
}

export interface ReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  message: string;
  path?: string;
}

function parseContextRecords(value: unknown, path: string): ContextRecord[] {
  return arrayAt(value, path, (entry, entryPath) => {
    const input = objectAt(entry, entryPath, ["unit_id", "summary"]);
    return {
      unit_id: stringAt(input.unit_id, `${entryPath}.unit_id`, { max: 120 }),
      summary: stringAt(input.summary, `${entryPath}.summary`, { max: 2_000 }),
    };
  }, { max: 32 });
}

function parseFindings(value: unknown, path: string): ReviewFinding[] {
  return arrayAt(value, path, (entry, entryPath) => {
    const input = objectAt(entry, entryPath, ["severity", "message", "path"]);
    return {
      severity: enumAt(input.severity, `${entryPath}.severity`, ["P0", "P1", "P2", "P3"] as const),
      message: stringAt(input.message, `${entryPath}.message`, { max: 2_000 }),
      ...(input.path === undefined ? {} : { path: stringAt(input.path, `${entryPath}.path`, { max: 300 }) }),
    };
  }, { max: 64 });
}

function parseReceiptPayload(type: "unit_completion", value: unknown, path: string): UnitCompletionPayload;
function parseReceiptPayload(type: "unit_decision", value: unknown, path: string): UnitDecisionPayload;
function parseReceiptPayload(type: "semantic_review", value: unknown, path: string): SemanticReviewPayload;
function parseReceiptPayload(type: "command_result", value: unknown, path: string): CommandResultPayload;
function parseReceiptPayload(type: "candidate_evidence" | "integration_evidence", value: unknown, path: string): SubjectEvidencePayload;
function parseReceiptPayload(type: "publish_subject", value: unknown, path: string): PublishSubjectPayload;
function parseReceiptPayload(type: "provider_evidence", value: unknown, path: string): ProviderEvidencePayload;
function parseReceiptPayload(type: "human_approval", value: unknown, path: string): HumanApprovalPayload;
function parseReceiptPayload(type: "tune_analysis", value: unknown, path: string): TuneAnalysisReceiptPayload;
function parseReceiptPayload(type: "tune_proposal", value: unknown, path: string): TuneProposalReceiptPayload;
function parseReceiptPayload(type: StandardReceiptType, value: unknown, path: string): StandardReceipt["payload"] {
  if (type === "unit_completion") {
    const input = objectAt(value, path, [
      "summary", "assumptions", "decisions", "issues", "verification", "downstream_context", "requested_human_input",
    ]);
    return {
      summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
      assumptions: stringList(input.assumptions, `${path}.assumptions`),
      decisions: stringList(input.decisions, `${path}.decisions`),
      issues: stringList(input.issues, `${path}.issues`),
      verification: stringList(input.verification, `${path}.verification`),
      downstream_context: parseContextRecords(input.downstream_context, `${path}.downstream_context`),
      requested_human_input: stringList(input.requested_human_input, `${path}.requested_human_input`, 16),
    };
  }
  if (type === "unit_decision") {
    const input = objectAt(value, path, ["rationale", "revision_request", "context_updates", "accepted_subject"]);
    return {
      rationale: stringAt(input.rationale, `${path}.rationale`, { max: 4_000 }),
      ...(input.revision_request === undefined ? {} : {
        revision_request: stringAt(input.revision_request, `${path}.revision_request`, { max: 4_000 }),
      }),
      context_updates: parseContextRecords(input.context_updates, `${path}.context_updates`),
      ...(input.accepted_subject === undefined ? {} : {
        accepted_subject: stringAt(input.accepted_subject, `${path}.accepted_subject`, { pattern: GIT_SUBJECT }),
      }),
    };
  }
  if (type === "semantic_review") {
    const input = objectAt(value, path, ["summary", "findings"]);
    return {
      summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
      findings: parseFindings(input.findings, `${path}.findings`),
    };
  }
  if (type === "command_result") {
    const input = objectAt(value, path, [
      "command", "exit_code", "summary", "stdout_digest", "stderr_digest", "stdout_tail", "stderr_tail",
    ]);
    return {
      command: stringAt(input.command, `${path}.command`, { max: 80 }),
      exit_code: integerAt(input.exit_code, `${path}.exit_code`, 0, 255),
      summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
      ...(input.stdout_digest === undefined ? {} : { stdout_digest: stringAt(input.stdout_digest, `${path}.stdout_digest`, { pattern: SHA256 }) }),
      ...(input.stderr_digest === undefined ? {} : { stderr_digest: stringAt(input.stderr_digest, `${path}.stderr_digest`, { pattern: SHA256 }) }),
      ...(input.stdout_tail === undefined ? {} : { stdout_tail: commandDiagnosticTail(input.stdout_tail, `${path}.stdout_tail`) }),
      ...(input.stderr_tail === undefined ? {} : { stderr_tail: commandDiagnosticTail(input.stderr_tail, `${path}.stderr_tail`) }),
    };
  }
  if (type === "candidate_evidence" || type === "integration_evidence") {
    const input = objectAt(value, path, ["tree", "diff_digest", "changed_paths", "clean"]);
    return {
      tree: stringAt(input.tree, `${path}.tree`, { pattern: GIT_SUBJECT }),
      diff_digest: stringAt(input.diff_digest, `${path}.diff_digest`, { pattern: SHA256 }),
      changed_paths: stringList(input.changed_paths, `${path}.changed_paths`, 512),
      clean: booleanAt(input.clean, `${path}.clean`),
    };
  }
  if (type === "publish_subject") {
    const input = objectAt(value, path, ["commit", "tree", "pr_url"]);
    return {
      commit: stringAt(input.commit, `${path}.commit`, { pattern: GIT_SUBJECT }),
      tree: stringAt(input.tree, `${path}.tree`, { pattern: GIT_SUBJECT }),
      pr_url: stringAt(input.pr_url, `${path}.pr_url`, { max: 2_000 }),
    };
  }
  if (type === "provider_evidence") {
    const input = objectAt(value, path, ["review_url", "check_run_url", "summary"]);
    return {
      ...(input.review_url === undefined ? {} : { review_url: stringAt(input.review_url, `${path}.review_url`, { max: 2_000 }) }),
      ...(input.check_run_url === undefined ? {} : { check_run_url: stringAt(input.check_run_url, `${path}.check_run_url`, { max: 2_000 }) }),
      summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
    };
  }
  if (type === "human_approval") {
    const input = objectAt(value, path, ["approver", "rationale"]);
    return {
      approver: stringAt(input.approver, `${path}.approver`, { max: 160 }),
      rationale: stringAt(input.rationale, `${path}.rationale`, { max: 4_000 }),
    };
  }
  if (type === "tune_analysis") {
    const input = objectAt(value, path, ["summary", "analysis"]);
    return {
      summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
      analysis: validateTuneAnalysisContract(input.analysis, { source: `${path}.analysis` }).value,
    };
  }
  const input = objectAt(value, path, ["summary", "proposal"]);
  return {
    summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
    proposal: validateTuneProposalContract(input.proposal, { source: `${path}.proposal` }).value,
  };
}

export function validateStandardReceipt(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<StandardReceipt> {
  const source = options.source ?? "receipt";
  const input = objectAt(value, source, [
    "schema", "type", "assurance", "result", "producer", "subject", "fence", "evidence", "payload", "issued_at",
  ]);
  if (input.schema !== RECEIPT_SCHEMA) fail(`${source}.schema`, `must be ${RECEIPT_SCHEMA}`);
  const type = enumAt(input.type, `${source}.type`, STANDARD_RECEIPT_TYPES);
  const result = enumAt(input.result, `${source}.result`, RECEIPT_RESULTS_BY_TYPE[type]);
  const parsePayload = parseReceiptPayload as (
    receiptType: StandardReceiptType,
    payload: unknown,
    payloadPath: string
  ) => StandardReceipt["payload"];
  const receipt = {
    schema: RECEIPT_SCHEMA,
    type,
    assurance: enumAt(input.assurance, `${source}.assurance`, ASSURANCE_CLASSES),
    result,
    producer: parseProducer(input.producer, `${source}.producer`),
    subject: parseSubject(input.subject, `${source}.subject`),
    fence: parseFence(input.fence, `${source}.fence`),
    evidence: arrayAt(input.evidence, `${source}.evidence`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { max: 1_000 });
    }, { max: 32 }),
    payload: parsePayload(type, input.payload, `${source}.payload`),
    issued_at: timestamp(input.issued_at, `${source}.issued_at`),
  } as StandardReceipt;
  if (receipt.type === "command_result" && receipt.result !== "failure"
      && (receipt.payload.stdout_tail !== undefined || receipt.payload.stderr_tail !== undefined)) {
    fail(`${source}.payload`, "diagnostic tails are only valid for failed command receipts");
  }
  if (receipt.type === "tune_proposal" && receipt.result !== "failure") {
    const expectedOutcome = receipt.result === "success" ? "propose" : receipt.result;
    if (receipt.payload.proposal.outcome !== expectedOutcome) {
      fail(`${source}.result`, "must match the typed tune proposal outcome");
    }
  }
  if (SEMANTIC_RECEIPTS.has(type) && ["executor_verified", "provider_verified", "human_approved"].includes(receipt.assurance)) {
    fail(`${source}.assurance`, "semantic receipts cannot claim executor, provider, or human assurance");
  }
  integerAt(receipt.evidence.length, `${source}.evidence.length`, 1, 32);
  return normalizedContract(receipt);
}

export function parseStandardReceipt(raw: string, options: { source?: string } = {}): ValidatedContract<StandardReceipt> {
  const source = options.source ?? "receipt";
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > 768 * 1024) fail(source, "JSON exceeds 768 KiB");
  const value = JSON.parse(raw) as unknown;
  const type = typeof value === "object" && value !== null && "type" in value
    ? (value as { type?: unknown }).type
    : undefined;
  if (!TUNE_RECEIPT_TYPES.includes(type as (typeof TUNE_RECEIPT_TYPES)[number]) && bytes > 64 * 1024) {
    fail(source, "JSON exceeds 64 KiB");
  }
  return validateStandardReceipt(value, options);
}
