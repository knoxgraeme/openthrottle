import { digestCanonicalJson } from "./canonical.js";
import {
  GIT_SUBJECT,
  IDENTIFIER,
  SHA256,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  nullable,
  normalizedContract,
  objectAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const REVIEW_POLICY_SCHEMA = "openthrottle.review-policy/v1" as const;
export const REVIEW_ROSTER_SCHEMA = "openthrottle.review-roster/v1" as const;
export const REVIEW_SELECTION_SCHEMA = "openthrottle.review-selection/v1" as const;
export const REVIEW_FINDING_SCHEMA = "openthrottle.review-finding/v1" as const;
export const REVIEW_SYNTHESIS_SCHEMA = "openthrottle.review-synthesis/v1" as const;
export const REVIEW_VALIDATION_SCHEMA = "openthrottle.review-validation/v1" as const;
export const REVIEW_REPAIR_DISPOSITION_SCHEMA = "openthrottle.review-repair-disposition/v1" as const;
export const REVIEW_JOURNAL_SCHEMA = "openthrottle.review-journal/v1" as const;

export const REVIEW_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const REVIEW_OUTCOMES = ["success", "semantic_repair_required", "failure", "needs_human"] as const;
export const REPAIR_DISPOSITIONS = ["accepted", "fixed", "deferred", "rejected", "superseded"] as const;
export const REVIEW_VALIDATOR_RESULTS = ["accepted", "rejected", "not_validated"] as const;
export const REVIEW_RESOLUTION_STATES = ["resolved", "unresolved"] as const;
export const FINDING_ID_PREFIX = "finding_" as const;
const FINDING_ID_PATTERN = /^finding_[a-f0-9]{32}$/;
export const SEMANTIC_GROUP_ID_PREFIX = "semantic_group_" as const;
const SEMANTIC_GROUP_ID_PATTERN = /^semantic_group_[a-f0-9]{32}$/;
export const REVIEW_SUBACTION_SEPARATOR = ".review." as const;
const LOOP_ACTION_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERIC_SEMANTIC_ANCHOR = /^(?:the\s+)?(?:file|module|change|code|logic|implementation|behavior|review|function|method|class|contract|test|tests)$/i;
const STABLE_CLAIM_DISCRIMINATOR = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const REVIEW_JOURNAL_ENTRY_KINDS = [
  "selection",
  "persona_receipts",
  "synthesis",
  "validation",
  "repair_disposition",
  "finding_resolutions",
  "timing_evidence",
  "measurements",
] as const;

type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
type RepairDisposition = (typeof REPAIR_DISPOSITIONS)[number];
type ReviewValidatorResult = (typeof REVIEW_VALIDATOR_RESULTS)[number];
type ReviewResolutionState = (typeof REVIEW_RESOLUTION_STATES)[number];
type ReviewJournalEntryKind = (typeof REVIEW_JOURNAL_ENTRY_KINDS)[number];

export function deriveReviewSubactionActionId(parentActionId: string, subactionId: string): string {
  const actionId = `${parentActionId}${REVIEW_SUBACTION_SEPARATOR}${subactionId}`;
  if (!LOOP_ACTION_PATH_ID.test(actionId)) {
    throw new Error(`review subaction action id is not path-safe: ${actionId}`);
  }
  return actionId;
}

export interface ReviewPersonaPolicy {
  persona_id: string;
  title: string;
  focus: string;
  invariants: string[];
  max_findings: number;
}

export interface ReviewPolicyContract {
  schema: typeof REVIEW_POLICY_SCHEMA;
  policy_id: string;
  personas: ReviewPersonaPolicy[];
  max_personas_per_selection: number;
  max_findings_per_journal: number;
}

export interface ReviewPersonaSnapshot {
  persona_id: string;
  title: string;
  focus: string;
  invariants: string[];
  max_findings: number;
}

export interface SealedReviewRosterContract {
  schema: typeof REVIEW_ROSTER_SCHEMA;
  roster_id: string;
  policy_digest: string;
  personas: ReviewPersonaSnapshot[];
  sealed_at: string;
}

export interface ReviewPersonaSelection {
  persona_id: string;
  rationale: string;
}

export interface ReviewSelectionContract {
  schema: typeof REVIEW_SELECTION_SCHEMA;
  selection_id: string;
  roster_digest: string;
  personas: ReviewPersonaSelection[];
}

export interface ReviewFindingIdentity {
  path: string;
  semantic_anchor: string;
  claim_discriminator: string;
  violated_invariant: string;
}

export interface ReviewFindingContract extends ReviewFindingIdentity {
  schema: typeof REVIEW_FINDING_SCHEMA;
  finding_id: string;
  persona_id: string;
  severity: ReviewSeverity;
  message: string;
  evidence: string[];
}

export interface ReviewSynthesisContract {
  schema: typeof REVIEW_SYNTHESIS_SCHEMA;
  selection_id: string;
  roster_digest: string;
  outcome: ReviewOutcome;
  summary: string;
  findings: ReviewFindingContract[];
}

export interface ReviewValidationContract {
  schema: typeof REVIEW_VALIDATION_SCHEMA;
  synthesis_digest: string;
  valid: boolean;
  errors: string[];
}

export interface ReviewRepairDispositionContract {
  schema: typeof REVIEW_REPAIR_DISPOSITION_SCHEMA;
  synthesis_digest: string;
  dispositions: Array<{
    finding_id: string;
    disposition: RepairDisposition;
    rationale: string;
  }>;
}

export interface ReviewJournalEntry {
  at: string;
  kind: ReviewJournalEntryKind;
  digest: string;
}

export interface ReviewPersonaReceiptEvidence {
  persona_id: string;
  receipt_digest: string;
  subject: string;
  finding_ids: string[];
  finding_count: number;
  latency_ms: number;
  cost_microusd: number | null;
}

export interface ReviewFindingResolution {
  finding_id: string;
  semantic_group_id: string;
  exact_dedup_personas: string[];
  semantic_dedup_finding_ids: string[];
  validator_result: ReviewValidatorResult;
  corroboration_count: number;
  repair_disposition: RepairDisposition;
  convergence_cycle: number;
  state: ReviewResolutionState;
}

export interface ReviewSubactionTimingEvidence {
  action_id: string;
  dispatched_at: string;
  completed_at: string;
  dispatch_time_source: "acknowledged" | "prepared_fallback";
  latency_ms: number;
}

export interface ReviewTimingEvidence {
  selector: ReviewSubactionTimingEvidence;
  personas: Array<ReviewSubactionTimingEvidence & { persona_id: string }>;
  validator: ReviewSubactionTimingEvidence | null;
}

export interface ReviewMeasurements {
  persona_count: number;
  finding_count: number;
  accepted_finding_count: number;
  rejected_finding_count: number;
  resolved_finding_count: number;
  unresolved_finding_count: number;
  total_latency_ms: number;
  critical_path_latency_ms: number;
  total_cost_microusd: number | null;
}

export interface ReviewJournalContract {
  schema: typeof REVIEW_JOURNAL_SCHEMA;
  subject: {
    base: string;
    pre: string;
    post: string;
  };
  policy: ReviewPolicyContract;
  roster: SealedReviewRosterContract;
  selection: ReviewSelectionContract;
  persona_receipts: ReviewPersonaReceiptEvidence[];
  synthesis: ReviewSynthesisContract;
  validation: ReviewValidationContract;
  repair_disposition: ReviewRepairDispositionContract;
  finding_resolutions: ReviewFindingResolution[];
  timing_evidence: ReviewTimingEvidence;
  measurements: ReviewMeasurements;
  entries: ReviewJournalEntry[];
}

function timestamp(value: unknown, path: string): string {
  const result = stringAt(value, path, { max: 64 });
  if (Number.isNaN(Date.parse(result))) fail(path, "must be an ISO timestamp");
  return result;
}

function boundedTextList(value: unknown, path: string, max: number): string[] {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { max: 1_000 }), { max });
}

function stablePath(value: unknown, path: string): string {
  const result = stringAt(value, path, { max: 300 });
  if (result.startsWith("/") || result.split("/").includes("..")) fail(path, "must be repository-relative");
  if (/(^|:)\d+(?::\d+)?$/.test(result)) fail(path, "must not encode line numbers");
  return result;
}

export function deriveReviewFindingId(identity: ReviewFindingIdentity): string {
  return `${FINDING_ID_PREFIX}${digestCanonicalJson({
    path: identity.path,
    semantic_anchor: identity.semantic_anchor,
    claim_discriminator: identity.claim_discriminator,
    violated_invariant: identity.violated_invariant,
  }).slice(0, 32)}`;
}

export function isSpecificReviewSemanticAnchor(value: string): boolean {
  return value === value.trim() && value.length >= 3 && value.length <= 400 && !GENERIC_SEMANTIC_ANCHOR.test(value);
}

export function isStableReviewClaimDiscriminator(value: string): boolean {
  return value.length <= 160 && STABLE_CLAIM_DISCRIMINATOR.test(value);
}

export function deriveReviewSemanticGroupId(
  input: Pick<ReviewFindingContract, "path" | "semantic_anchor" | "claim_discriminator">
): string {
  return `${SEMANTIC_GROUP_ID_PREFIX}${digestCanonicalJson({
    path: input.path,
    semantic_anchor: input.semantic_anchor,
    claim_discriminator: input.claim_discriminator,
  }).slice(0, 32)}`;
}

function parsePersonaPolicy(value: unknown, path: string): ReviewPersonaPolicy {
  const input = objectAt(value, path, ["persona_id", "title", "focus", "invariants", "max_findings"]);
  return {
    persona_id: stringAt(input.persona_id, `${path}.persona_id`, { pattern: IDENTIFIER }),
    title: stringAt(input.title, `${path}.title`, { max: 160 }),
    focus: stringAt(input.focus, `${path}.focus`, { max: 1_000 }),
    invariants: unique(boundedTextList(input.invariants, `${path}.invariants`, 32), `${path}.invariants`),
    max_findings: integerAt(input.max_findings, `${path}.max_findings`, 1, 64),
  };
}

function parsePolicy(value: unknown, path: string): ReviewPolicyContract {
  const input = objectAt(value, path, [
    "schema", "policy_id", "personas", "max_personas_per_selection", "max_findings_per_journal",
  ]);
  if (input.schema !== REVIEW_POLICY_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_POLICY_SCHEMA}`);
  const policy: ReviewPolicyContract = {
    schema: REVIEW_POLICY_SCHEMA,
    policy_id: stringAt(input.policy_id, `${path}.policy_id`, { pattern: IDENTIFIER }),
    personas: arrayAt(input.personas, `${path}.personas`, parsePersonaPolicy, { min: 1, max: 32 }),
    max_personas_per_selection: integerAt(input.max_personas_per_selection, `${path}.max_personas_per_selection`, 1, 32),
    max_findings_per_journal: integerAt(input.max_findings_per_journal, `${path}.max_findings_per_journal`, 1, 64),
  };
  unique(policy.personas.map((persona) => persona.persona_id), `${path}.personas.persona_id`);
  if (policy.max_personas_per_selection > policy.personas.length) {
    fail(`${path}.max_personas_per_selection`, "must not exceed the persona roster size");
  }
  return policy;
}

function parseRoster(value: unknown, path: string): SealedReviewRosterContract {
  const input = objectAt(value, path, ["schema", "roster_id", "policy_digest", "personas", "sealed_at"]);
  if (input.schema !== REVIEW_ROSTER_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_ROSTER_SCHEMA}`);
  const roster: SealedReviewRosterContract = {
    schema: REVIEW_ROSTER_SCHEMA,
    roster_id: stringAt(input.roster_id, `${path}.roster_id`, { pattern: IDENTIFIER }),
    policy_digest: stringAt(input.policy_digest, `${path}.policy_digest`, { pattern: SHA256 }),
    personas: arrayAt(input.personas, `${path}.personas`, parsePersonaPolicy, { min: 1, max: 32 }),
    sealed_at: timestamp(input.sealed_at, `${path}.sealed_at`),
  };
  unique(roster.personas.map((persona) => persona.persona_id), `${path}.personas.persona_id`);
  return roster;
}

function parseSelection(value: unknown, path: string): ReviewSelectionContract {
  const input = objectAt(value, path, ["schema", "selection_id", "roster_digest", "personas"]);
  if (input.schema !== REVIEW_SELECTION_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_SELECTION_SCHEMA}`);
  const selection: ReviewSelectionContract = {
    schema: REVIEW_SELECTION_SCHEMA,
    selection_id: stringAt(input.selection_id, `${path}.selection_id`, { pattern: IDENTIFIER }),
    roster_digest: stringAt(input.roster_digest, `${path}.roster_digest`, { pattern: SHA256 }),
    personas: arrayAt(input.personas, `${path}.personas`, (entry, entryPath) => {
      const persona = objectAt(entry, entryPath, ["persona_id", "rationale"]);
      return {
        persona_id: stringAt(persona.persona_id, `${entryPath}.persona_id`, { pattern: IDENTIFIER }),
        rationale: stringAt(persona.rationale, `${entryPath}.rationale`, { max: 1_000 }),
      };
    }, { min: 1, max: 32 }),
  };
  unique(selection.personas.map((persona) => persona.persona_id), `${path}.personas.persona_id`);
  return selection;
}

function parseFinding(value: unknown, path: string): ReviewFindingContract {
  const input = objectAt(value, path, [
    "schema", "finding_id", "persona_id", "severity", "path", "semantic_anchor", "claim_discriminator",
    "violated_invariant", "message", "evidence",
  ]);
  if (input.schema !== REVIEW_FINDING_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_FINDING_SCHEMA}`);
  const semanticAnchor = stringAt(input.semantic_anchor, `${path}.semantic_anchor`, { max: 400 });
  if (!isSpecificReviewSemanticAnchor(semanticAnchor)) {
    fail(`${path}.semantic_anchor`, "must name a sufficiently specific stable symbol, contract, or state transition");
  }
  const claimDiscriminator = stringAt(input.claim_discriminator, `${path}.claim_discriminator`, { max: 160 });
  if (!isStableReviewClaimDiscriminator(claimDiscriminator)) {
    fail(`${path}.claim_discriminator`, "must be a stable lowercase kebab-case defect claim with at least two tokens");
  }
  const finding: ReviewFindingContract = {
    schema: REVIEW_FINDING_SCHEMA,
    finding_id: stringAt(input.finding_id, `${path}.finding_id`, { max: 40, pattern: FINDING_ID_PATTERN }),
    persona_id: stringAt(input.persona_id, `${path}.persona_id`, { pattern: IDENTIFIER }),
    severity: enumAt(input.severity, `${path}.severity`, REVIEW_SEVERITIES),
    path: stablePath(input.path, `${path}.path`),
    semantic_anchor: semanticAnchor,
    claim_discriminator: claimDiscriminator,
    violated_invariant: stringAt(input.violated_invariant, `${path}.violated_invariant`, { max: 400 }),
    message: stringAt(input.message, `${path}.message`, { max: 2_000 }),
    evidence: boundedTextList(input.evidence, `${path}.evidence`, 16),
  };
  const expected = deriveReviewFindingId(finding);
  if (finding.finding_id !== expected) {
    fail(`${path}.finding_id`, "must be derived from path, semantic_anchor, claim_discriminator, and violated_invariant");
  }
  return finding;
}

function parseSynthesis(value: unknown, path: string): ReviewSynthesisContract {
  const input = objectAt(value, path, ["schema", "selection_id", "roster_digest", "outcome", "summary", "findings"]);
  if (input.schema !== REVIEW_SYNTHESIS_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_SYNTHESIS_SCHEMA}`);
  const synthesis: ReviewSynthesisContract = {
    schema: REVIEW_SYNTHESIS_SCHEMA,
    selection_id: stringAt(input.selection_id, `${path}.selection_id`, { pattern: IDENTIFIER }),
    roster_digest: stringAt(input.roster_digest, `${path}.roster_digest`, { pattern: SHA256 }),
    outcome: enumAt(input.outcome, `${path}.outcome`, REVIEW_OUTCOMES),
    summary: stringAt(input.summary, `${path}.summary`, { max: 4_000 }),
    findings: arrayAt(input.findings, `${path}.findings`, parseFinding, { max: 64 }),
  };
  unique(synthesis.findings.map((finding) => finding.finding_id), `${path}.findings.finding_id`);
  return synthesis;
}

function parseValidation(value: unknown, path: string): ReviewValidationContract {
  const input = objectAt(value, path, ["schema", "synthesis_digest", "valid", "errors"]);
  if (input.schema !== REVIEW_VALIDATION_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_VALIDATION_SCHEMA}`);
  return {
    schema: REVIEW_VALIDATION_SCHEMA,
    synthesis_digest: stringAt(input.synthesis_digest, `${path}.synthesis_digest`, { pattern: SHA256 }),
    valid: booleanAt(input.valid, `${path}.valid`),
    errors: boundedTextList(input.errors, `${path}.errors`, 32),
  };
}

function parseRepairDisposition(value: unknown, path: string): ReviewRepairDispositionContract {
  const input = objectAt(value, path, ["schema", "synthesis_digest", "dispositions"]);
  if (input.schema !== REVIEW_REPAIR_DISPOSITION_SCHEMA) {
    fail(`${path}.schema`, `must be ${REVIEW_REPAIR_DISPOSITION_SCHEMA}`);
  }
  const repair: ReviewRepairDispositionContract = {
    schema: REVIEW_REPAIR_DISPOSITION_SCHEMA,
    synthesis_digest: stringAt(input.synthesis_digest, `${path}.synthesis_digest`, { pattern: SHA256 }),
    dispositions: arrayAt(input.dispositions, `${path}.dispositions`, (entry, entryPath) => {
      const disposition = objectAt(entry, entryPath, ["finding_id", "disposition", "rationale"]);
      return {
        finding_id: stringAt(disposition.finding_id, `${entryPath}.finding_id`, { max: 40, pattern: FINDING_ID_PATTERN }),
        disposition: enumAt(disposition.disposition, `${entryPath}.disposition`, REPAIR_DISPOSITIONS),
        rationale: stringAt(disposition.rationale, `${entryPath}.rationale`, { max: 1_000 }),
      };
    }, { max: 64 }),
  };
  unique(repair.dispositions.map((disposition) => disposition.finding_id), `${path}.dispositions.finding_id`);
  return repair;
}

function parsePersonaReceipt(value: unknown, path: string): ReviewPersonaReceiptEvidence {
  const input = objectAt(value, path, [
    "persona_id", "receipt_digest", "subject", "finding_ids", "finding_count", "latency_ms", "cost_microusd",
  ]);
  const findingIds = unique(arrayAt(
    input.finding_ids,
    `${path}.finding_ids`,
    (entry, entryPath) => stringAt(entry, entryPath, { max: 40, pattern: FINDING_ID_PATTERN }),
    { max: 64 }
  ), `${path}.finding_ids`);
  return {
    persona_id: stringAt(input.persona_id, `${path}.persona_id`, { pattern: IDENTIFIER }),
    receipt_digest: stringAt(input.receipt_digest, `${path}.receipt_digest`, { pattern: SHA256 }),
    subject: stringAt(input.subject, `${path}.subject`, { pattern: GIT_SUBJECT }),
    finding_ids: findingIds,
    finding_count: integerAt(input.finding_count, `${path}.finding_count`, 0, 64),
    latency_ms: integerAt(input.latency_ms, `${path}.latency_ms`, 0, 604_800_000),
    cost_microusd: nullable(input.cost_microusd, (entry) =>
      integerAt(entry, `${path}.cost_microusd`, 0, 1_000_000_000_000)),
  };
}

function parseFindingResolution(value: unknown, path: string): ReviewFindingResolution {
  const input = objectAt(value, path, [
    "finding_id",
    "semantic_group_id",
    "exact_dedup_personas",
    "semantic_dedup_finding_ids",
    "validator_result",
    "corroboration_count",
    "repair_disposition",
    "convergence_cycle",
    "state",
  ]);
  return {
    finding_id: stringAt(input.finding_id, `${path}.finding_id`, { max: 40, pattern: FINDING_ID_PATTERN }),
    semantic_group_id: stringAt(input.semantic_group_id, `${path}.semantic_group_id`, { max: 47, pattern: SEMANTIC_GROUP_ID_PATTERN }),
    exact_dedup_personas: unique(arrayAt(
      input.exact_dedup_personas,
      `${path}.exact_dedup_personas`,
      (entry, entryPath) => stringAt(entry, entryPath, { pattern: IDENTIFIER }),
      { max: 32 }
    ), `${path}.exact_dedup_personas`),
    semantic_dedup_finding_ids: unique(arrayAt(
      input.semantic_dedup_finding_ids,
      `${path}.semantic_dedup_finding_ids`,
      (entry, entryPath) => stringAt(entry, entryPath, { max: 40, pattern: FINDING_ID_PATTERN }),
      { min: 1, max: 64 }
    ), `${path}.semantic_dedup_finding_ids`),
    validator_result: enumAt(input.validator_result, `${path}.validator_result`, REVIEW_VALIDATOR_RESULTS),
    corroboration_count: integerAt(input.corroboration_count, `${path}.corroboration_count`, 0, 32),
    repair_disposition: enumAt(input.repair_disposition, `${path}.repair_disposition`, REPAIR_DISPOSITIONS),
    convergence_cycle: integerAt(input.convergence_cycle, `${path}.convergence_cycle`, 1, 64),
    state: enumAt(input.state, `${path}.state`, REVIEW_RESOLUTION_STATES),
  };
}

function parseSubactionTiming(value: unknown, path: string): ReviewSubactionTimingEvidence {
  const input = objectAt(value, path, [
    "action_id", "dispatched_at", "completed_at", "dispatch_time_source", "latency_ms",
  ]);
  const dispatchedAt = timestamp(input.dispatched_at, `${path}.dispatched_at`);
  const completedAt = timestamp(input.completed_at, `${path}.completed_at`);
  const latencyMs = integerAt(input.latency_ms, `${path}.latency_ms`, 0, 604_800_000);
  const expectedLatencyMs = Date.parse(completedAt) - Date.parse(dispatchedAt);
  if (expectedLatencyMs < 0) fail(`${path}.completed_at`, "must not precede dispatched_at");
  if (latencyMs !== expectedLatencyMs) fail(`${path}.latency_ms`, "does not match dispatch-to-completion evidence");
  return {
    action_id: stringAt(input.action_id, `${path}.action_id`, { max: 512 }),
    dispatched_at: dispatchedAt,
    completed_at: completedAt,
    dispatch_time_source: enumAt(
      input.dispatch_time_source,
      `${path}.dispatch_time_source`,
      ["acknowledged", "prepared_fallback"] as const
    ),
    latency_ms: latencyMs,
  };
}

function parseTimingEvidence(value: unknown, path: string): ReviewTimingEvidence {
  const input = objectAt(value, path, ["selector", "personas", "validator"]);
  const personas = arrayAt(input.personas, `${path}.personas`, (entry, entryPath) => {
    const persona = objectAt(entry, entryPath, [
      "persona_id", "action_id", "dispatched_at", "completed_at", "dispatch_time_source", "latency_ms",
    ]);
    const timing = parseSubactionTiming({
      action_id: persona.action_id,
      dispatched_at: persona.dispatched_at,
      completed_at: persona.completed_at,
      dispatch_time_source: persona.dispatch_time_source,
      latency_ms: persona.latency_ms,
    }, entryPath);
    return {
      persona_id: stringAt(persona.persona_id, `${entryPath}.persona_id`, { pattern: IDENTIFIER }),
      ...timing,
    };
  }, { min: 1, max: 32 });
  unique(personas.map((entry) => entry.persona_id), `${path}.personas.persona_id`);
  unique(personas.map((entry) => entry.action_id), `${path}.personas.action_id`);
  return {
    selector: parseSubactionTiming(input.selector, `${path}.selector`),
    personas,
    validator: nullable(input.validator, (entry) => parseSubactionTiming(entry, `${path}.validator`)),
  };
}

function parseMeasurements(value: unknown, path: string): ReviewMeasurements {
  const input = objectAt(value, path, [
    "persona_count",
    "finding_count",
    "accepted_finding_count",
    "rejected_finding_count",
    "resolved_finding_count",
    "unresolved_finding_count",
    "total_latency_ms",
    "critical_path_latency_ms",
    "total_cost_microusd",
  ]);
  return {
    persona_count: integerAt(input.persona_count, `${path}.persona_count`, 1, 32),
    finding_count: integerAt(input.finding_count, `${path}.finding_count`, 0, 64),
    accepted_finding_count: integerAt(input.accepted_finding_count, `${path}.accepted_finding_count`, 0, 64),
    rejected_finding_count: integerAt(input.rejected_finding_count, `${path}.rejected_finding_count`, 0, 64),
    resolved_finding_count: integerAt(input.resolved_finding_count, `${path}.resolved_finding_count`, 0, 64),
    unresolved_finding_count: integerAt(input.unresolved_finding_count, `${path}.unresolved_finding_count`, 0, 64),
    total_latency_ms: integerAt(input.total_latency_ms, `${path}.total_latency_ms`, 0, Number.MAX_SAFE_INTEGER),
    critical_path_latency_ms: integerAt(input.critical_path_latency_ms, `${path}.critical_path_latency_ms`, 0, 604_800_000),
    total_cost_microusd: nullable(input.total_cost_microusd, (entry) =>
      integerAt(entry, `${path}.total_cost_microusd`, 0, Number.MAX_SAFE_INTEGER)),
  };
}

function parseJournalEntry(value: unknown, path: string): ReviewJournalEntry {
  const input = objectAt(value, path, ["at", "kind", "digest"]);
  return {
    at: timestamp(input.at, `${path}.at`),
    kind: enumAt(input.kind, `${path}.kind`, REVIEW_JOURNAL_ENTRY_KINDS),
    digest: stringAt(input.digest, `${path}.digest`, { pattern: SHA256 }),
  };
}

function validateCrossReferences(journal: ReviewJournalContract, source: string): void {
  const policyDigest = digestCanonicalJson(journal.policy);
  if (journal.roster.policy_digest !== policyDigest) fail(`${source}.roster.policy_digest`, "does not match policy digest");
  const policyPersonas = new Map(journal.policy.personas.map((persona) => [persona.persona_id, persona]));
  for (const rosterPersona of journal.roster.personas) {
    const policyPersona = policyPersonas.get(rosterPersona.persona_id);
    if (!policyPersona) fail(`${source}.roster.personas.${rosterPersona.persona_id}`, "references an unknown policy persona");
    if (digestCanonicalJson(rosterPersona) !== digestCanonicalJson(policyPersona)) {
      fail(`${source}.roster.personas.${rosterPersona.persona_id}`, "must match the policy persona snapshot");
    }
  }
  const rosterDigest = digestCanonicalJson(journal.roster);
  if (journal.selection.roster_digest !== rosterDigest) fail(`${source}.selection.roster_digest`, "does not match sealed roster digest");
  if (journal.synthesis.roster_digest !== rosterDigest) fail(`${source}.synthesis.roster_digest`, "does not match sealed roster digest");
  const rosterPersonas = new Map(journal.roster.personas.map((persona) => [persona.persona_id, persona]));
  if (journal.selection.personas.length > journal.policy.max_personas_per_selection) {
    fail(`${source}.selection.personas`, "exceeds policy selection bound");
  }
  const selectedPersonaIds = new Set(journal.selection.personas.map((persona) => persona.persona_id));
  for (const persona of journal.selection.personas) {
    if (!rosterPersonas.has(persona.persona_id)) fail(`${source}.selection.personas.${persona.persona_id}`, "references an unknown roster persona");
  }
  unique(journal.persona_receipts.map((receipt) => receipt.persona_id), `${source}.persona_receipts.persona_id`);
  unique(journal.persona_receipts.map((receipt) => receipt.receipt_digest), `${source}.persona_receipts.receipt_digest`);
  const receiptPersonaIds = new Set(journal.persona_receipts.map((receipt) => receipt.persona_id));
  for (const personaId of selectedPersonaIds) {
    if (!receiptPersonaIds.has(personaId)) {
      fail(`${source}.persona_receipts`, `missing selected persona ${personaId}`);
    }
  }
  for (const receipt of journal.persona_receipts) {
    if (!selectedPersonaIds.has(receipt.persona_id)) {
      fail(`${source}.persona_receipts.${receipt.persona_id}`, "references an unselected persona");
    }
    if (receipt.subject !== journal.subject.pre) {
      fail(`${source}.persona_receipts.${receipt.persona_id}.subject`, "does not match the reviewed subject");
    }
    if (receipt.finding_count !== receipt.finding_ids.length) {
      fail(`${source}.persona_receipts.${receipt.persona_id}.finding_count`, "does not match finding_ids length");
    }
  }
  const personaTimings = new Map(journal.timing_evidence.personas.map((entry) => [entry.persona_id, entry]));
  unique([
    journal.timing_evidence.selector.action_id,
    ...journal.timing_evidence.personas.map((entry) => entry.action_id),
    ...(journal.timing_evidence.validator ? [journal.timing_evidence.validator.action_id] : []),
  ], `${source}.timing_evidence.action_id`);
  const selectorSuffix = `${REVIEW_SUBACTION_SEPARATOR}selector`;
  if (!journal.timing_evidence.selector.action_id.endsWith(selectorSuffix)) {
    fail(`${source}.timing_evidence.selector.action_id`, `must end with ${selectorSuffix}`);
  }
  const reviewActionPrefix = journal.timing_evidence.selector.action_id.slice(0, -selectorSuffix.length);
  if (reviewActionPrefix.length === 0) {
    fail(`${source}.timing_evidence.selector.action_id`, "must include the parent review action prefix");
  }
  for (const timing of journal.timing_evidence.personas) {
    const expectedActionId = deriveReviewSubactionActionId(reviewActionPrefix, timing.persona_id);
    if (timing.action_id !== expectedActionId) {
      fail(`${source}.timing_evidence.personas.${timing.persona_id}.action_id`, `must be ${expectedActionId}`);
    }
  }
  if (journal.timing_evidence.validator &&
      journal.timing_evidence.validator.action_id !== deriveReviewSubactionActionId(reviewActionPrefix, "validator")) {
    fail(
      `${source}.timing_evidence.validator.action_id`,
      `must be ${deriveReviewSubactionActionId(reviewActionPrefix, "validator")}`
    );
  }
  if (personaTimings.size !== journal.persona_receipts.length) {
    fail(`${source}.timing_evidence.personas`, "must match the exact persona receipt roster");
  }
  const selectorCompletedAt = Date.parse(journal.timing_evidence.selector.completed_at);
  for (const receipt of journal.persona_receipts) {
    const timing = personaTimings.get(receipt.persona_id);
    if (!timing) fail(`${source}.timing_evidence.personas`, `missing persona ${receipt.persona_id}`);
    if (Date.parse(timing.dispatched_at) < selectorCompletedAt) {
      fail(`${source}.timing_evidence.personas.${receipt.persona_id}.dispatched_at`, "must not precede selector completion");
    }
    if (receipt.latency_ms !== timing.latency_ms) {
      fail(`${source}.persona_receipts.${receipt.persona_id}.latency_ms`, "does not match timing evidence");
    }
  }
  const independentlyValidated = journal.finding_resolutions.some((resolution) =>
    resolution.validator_result === "accepted" || resolution.validator_result === "rejected"
  );
  if (independentlyValidated !== (journal.timing_evidence.validator !== null)) {
    fail(`${source}.timing_evidence.validator`, "must be present exactly when blocking findings were independently validated");
  }
  if (journal.timing_evidence.validator) {
    const finalPersonaCompletion = Math.max(
      ...journal.timing_evidence.personas.map((timing) => Date.parse(timing.completed_at))
    );
    if (Date.parse(journal.timing_evidence.validator.dispatched_at) < finalPersonaCompletion) {
      fail(`${source}.timing_evidence.validator.dispatched_at`, "must not precede persona completion");
    }
  }
  if (journal.synthesis.selection_id !== journal.selection.selection_id) {
    fail(`${source}.synthesis.selection_id`, "does not match selection_id");
  }
  if (journal.synthesis.findings.length > journal.policy.max_findings_per_journal) {
    fail(`${source}.synthesis.findings`, "exceeds policy finding bound");
  }
  const findings = new Map(journal.synthesis.findings.map((finding) => [finding.finding_id, finding]));
  const countByPersona = new Map<string, number>();
  for (const finding of journal.synthesis.findings) {
    if (!selectedPersonaIds.has(finding.persona_id)) {
      fail(`${source}.synthesis.findings.${finding.finding_id}.persona_id`, "references an unselected persona");
    }
    const persona = rosterPersonas.get(finding.persona_id);
    if (!persona) fail(`${source}.synthesis.findings.${finding.finding_id}.persona_id`, "references an unknown roster persona");
    if (!persona.invariants.includes(finding.violated_invariant)) {
      fail(`${source}.synthesis.findings.${finding.finding_id}.violated_invariant`, "is not declared by the persona");
    }
    countByPersona.set(finding.persona_id, (countByPersona.get(finding.persona_id) ?? 0) + 1);
    if (countByPersona.get(finding.persona_id)! > persona.max_findings) {
      fail(`${source}.synthesis.findings.${finding.persona_id}`, "exceeds persona finding bound");
    }
  }
  const synthesisDigest = digestCanonicalJson(journal.synthesis);
  if (journal.validation.synthesis_digest !== synthesisDigest) {
    fail(`${source}.validation.synthesis_digest`, "does not match synthesis digest");
  }
  if (journal.validation.valid && journal.validation.errors.length > 0) {
    fail(`${source}.validation.errors`, "must be empty when valid is true");
  }
  if (!journal.validation.valid && journal.validation.errors.length === 0) {
    fail(`${source}.validation.errors`, "must explain invalid synthesis");
  }
  if (journal.repair_disposition.synthesis_digest !== synthesisDigest) {
    fail(`${source}.repair_disposition.synthesis_digest`, "does not match synthesis digest");
  }
  for (const disposition of journal.repair_disposition.dispositions) {
    if (!findings.has(disposition.finding_id)) {
      fail(`${source}.repair_disposition.dispositions.${disposition.finding_id}`, "references an unknown finding");
    }
  }
  unique(journal.finding_resolutions.map((resolution) => resolution.finding_id), `${source}.finding_resolutions.finding_id`);
  unique(journal.finding_resolutions.map((resolution) => resolution.semantic_group_id), `${source}.finding_resolutions.semantic_group_id`);
  const dispositions = new Map(journal.repair_disposition.dispositions.map((entry) => [entry.finding_id, entry]));
  const resolutions = new Map(journal.finding_resolutions.map((resolution) => [resolution.finding_id, resolution]));
  const semanticMembership = new Map<string, string>();
  for (const findingId of findings.keys()) {
    if (!resolutions.has(findingId)) fail(`${source}.finding_resolutions`, `missing synthesized finding ${findingId}`);
  }
  for (const resolution of journal.finding_resolutions) {
    if (!findings.has(resolution.finding_id)) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}`, "references an unknown synthesized finding");
    }
    const canonicalFinding = findings.get(resolution.finding_id)!;
    if (resolution.semantic_group_id !== deriveReviewSemanticGroupId(canonicalFinding)) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.semantic_group_id`, "must be derived from the canonical finding semantics");
    }
    if (!resolution.semantic_dedup_finding_ids.includes(resolution.finding_id)) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.semantic_dedup_finding_ids`, "must include its canonical finding_id");
    }
    for (const personaId of resolution.exact_dedup_personas) {
      const receipt = journal.persona_receipts.find((entry) => entry.persona_id === personaId);
      if (!receipt) {
        fail(`${source}.finding_resolutions.${resolution.finding_id}.exact_dedup_personas`, `references unknown persona ${personaId}`);
      }
      if (!receipt.finding_ids.some((findingId) => resolution.semantic_dedup_finding_ids.includes(findingId))) {
        fail(`${source}.finding_resolutions.${resolution.finding_id}.exact_dedup_personas`, `${personaId} did not report a member of the semantic finding group`);
      }
    }
    const semanticMembers = new Set(resolution.semantic_dedup_finding_ids);
    const expectedExactPersonas = journal.persona_receipts
      .filter((receipt) => receipt.finding_ids.some((findingId) => semanticMembers.has(findingId)))
      .map((receipt) => receipt.persona_id)
      .sort();
    const actualExactPersonas = [...resolution.exact_dedup_personas].sort();
    if (digestCanonicalJson(actualExactPersonas) !== digestCanonicalJson(expectedExactPersonas)) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.exact_dedup_personas`, "does not match exact persona membership");
    }
    if (resolution.corroboration_count !== resolution.exact_dedup_personas.length) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.corroboration_count`, "does not match exact_dedup_personas length");
    }
    const disposition = dispositions.get(resolution.finding_id);
    if (!disposition) {
      fail(`${source}.repair_disposition.dispositions`, `missing synthesized finding ${resolution.finding_id}`);
    }
    if (resolution.repair_disposition !== disposition.disposition) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.repair_disposition`, "does not match repair disposition");
    }
    const expectedValidatorResult = disposition.disposition === "accepted"
      ? "accepted"
      : disposition.disposition === "rejected"
        ? "rejected"
        : "not_validated";
    if (resolution.validator_result !== expectedValidatorResult) {
      fail(
        `${source}.finding_resolutions.${resolution.finding_id}.validator_result`,
        `must be ${expectedValidatorResult} for repair disposition ${disposition.disposition}`
      );
    }
    const canonicalIsBlocking = canonicalFinding.severity === "P0" || canonicalFinding.severity === "P1";
    if (!canonicalIsBlocking && resolution.validator_result !== "not_validated") {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.validator_result`, "advisory findings are not independently validated");
    }
    if (resolution.exact_dedup_personas.length === 0 &&
        !(resolution.state === "resolved" && (resolution.repair_disposition === "fixed" || resolution.repair_disposition === "superseded"))) {
      fail(`${source}.finding_resolutions.${resolution.finding_id}.exact_dedup_personas`, "may be empty only for a fixed or superseded resolved finding");
    }
    for (const memberId of resolution.semantic_dedup_finding_ids) {
      const prior = semanticMembership.get(memberId);
      if (prior) {
        fail(`${source}.finding_resolutions.${resolution.finding_id}.semantic_dedup_finding_ids`, `finding ${memberId} is already assigned to ${prior}`);
      }
      semanticMembership.set(memberId, resolution.finding_id);
    }
  }
  for (const receipt of journal.persona_receipts) {
    for (const findingId of receipt.finding_ids) {
      if (!semanticMembership.has(findingId)) {
        fail(`${source}.persona_receipts.${receipt.persona_id}.finding_ids`, `finding ${findingId} has no semantic dedup membership`);
      }
    }
  }
  const acceptedFindingCount = journal.finding_resolutions
    .filter((resolution) => resolution.validator_result === "accepted").length;
  const rejectedFindingCount = journal.finding_resolutions
    .filter((resolution) => resolution.validator_result === "rejected").length;
  const resolvedFindingCount = journal.finding_resolutions
    .filter((resolution) => resolution.state === "resolved").length;
  const unresolvedFindingCount = journal.finding_resolutions.length - resolvedFindingCount;
  const timingSamples = [
    journal.timing_evidence.selector,
    ...journal.timing_evidence.personas,
    ...(journal.timing_evidence.validator ? [journal.timing_evidence.validator] : []),
  ];
  const totalLatencyMs = timingSamples.reduce((total, timing) => total + timing.latency_ms, 0);
  const finalCompletionMs = Math.max(...timingSamples.map((timing) => Date.parse(timing.completed_at)));
  const criticalPathLatencyMs = Math.max(0, finalCompletionMs - Date.parse(journal.timing_evidence.selector.dispatched_at));
  const measuredCosts = journal.persona_receipts.map((receipt) => receipt.cost_microusd);
  const totalCostMicrousd = measuredCosts.some((cost) => cost === null)
    ? null
    : measuredCosts.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  const expectedMeasurements: ReviewMeasurements = {
    persona_count: journal.persona_receipts.length,
    finding_count: journal.synthesis.findings.length,
    accepted_finding_count: acceptedFindingCount,
    rejected_finding_count: rejectedFindingCount,
    resolved_finding_count: resolvedFindingCount,
    unresolved_finding_count: unresolvedFindingCount,
    total_latency_ms: totalLatencyMs,
    critical_path_latency_ms: criticalPathLatencyMs,
    total_cost_microusd: totalCostMicrousd,
  };
  if (digestCanonicalJson(journal.measurements) !== digestCanonicalJson(expectedMeasurements)) {
    fail(`${source}.measurements`, "does not match persona and finding evidence");
  }
  const expectedEntries = [
    { kind: "selection", digest: digestCanonicalJson(journal.selection) },
    { kind: "persona_receipts", digest: digestCanonicalJson(journal.persona_receipts) },
    { kind: "synthesis", digest: synthesisDigest },
    { kind: "validation", digest: digestCanonicalJson(journal.validation) },
    { kind: "repair_disposition", digest: digestCanonicalJson(journal.repair_disposition) },
    { kind: "finding_resolutions", digest: digestCanonicalJson(journal.finding_resolutions) },
    { kind: "timing_evidence", digest: digestCanonicalJson(journal.timing_evidence) },
    { kind: "measurements", digest: digestCanonicalJson(journal.measurements) },
  ] as const;
  if (journal.entries.length !== expectedEntries.length) fail(`${source}.entries`, "must contain one digest for each journal artifact");
  for (const [index, expected] of expectedEntries.entries()) {
    const entry = journal.entries[index]!;
    if (entry.kind !== expected.kind) fail(`${source}.entries[${index}].kind`, `must be ${expected.kind}`);
    if (entry.digest !== expected.digest) fail(`${source}.entries[${index}].digest`, `does not match ${expected.kind} digest`);
  }
}

export function validateReviewJournalContract(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<ReviewJournalContract> {
  const source = options.source ?? "review_journal";
  const input = objectAt(value, source, [
    "schema",
    "subject",
    "policy",
    "roster",
    "selection",
    "persona_receipts",
    "synthesis",
    "validation",
    "repair_disposition",
    "finding_resolutions",
    "timing_evidence",
    "measurements",
    "entries",
  ]);
  if (input.schema !== REVIEW_JOURNAL_SCHEMA) fail(`${source}.schema`, `must be ${REVIEW_JOURNAL_SCHEMA}`);
  const subject = objectAt(input.subject, `${source}.subject`, ["base", "pre", "post"]);
  const journal: ReviewJournalContract = {
    schema: REVIEW_JOURNAL_SCHEMA,
    subject: {
      base: stringAt(subject.base, `${source}.subject.base`, { pattern: GIT_SUBJECT }),
      pre: stringAt(subject.pre, `${source}.subject.pre`, { pattern: GIT_SUBJECT }),
      post: stringAt(subject.post, `${source}.subject.post`, { pattern: GIT_SUBJECT }),
    },
    policy: parsePolicy(input.policy, `${source}.policy`),
    roster: parseRoster(input.roster, `${source}.roster`),
    selection: parseSelection(input.selection, `${source}.selection`),
    persona_receipts: arrayAt(input.persona_receipts, `${source}.persona_receipts`, parsePersonaReceipt, { min: 1, max: 32 }),
    synthesis: parseSynthesis(input.synthesis, `${source}.synthesis`),
    validation: parseValidation(input.validation, `${source}.validation`),
    repair_disposition: parseRepairDisposition(input.repair_disposition, `${source}.repair_disposition`),
    finding_resolutions: arrayAt(input.finding_resolutions, `${source}.finding_resolutions`, parseFindingResolution, { max: 64 }),
    timing_evidence: parseTimingEvidence(input.timing_evidence, `${source}.timing_evidence`),
    measurements: parseMeasurements(input.measurements, `${source}.measurements`),
    entries: arrayAt(input.entries, `${source}.entries`, parseJournalEntry, { max: 16 }),
  };
  validateCrossReferences(journal, source);
  return normalizedContract(journal);
}

export function parseReviewJournalContract(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<ReviewJournalContract> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "review_journal", "JSON exceeds 256 KiB");
  return validateReviewJournalContract(JSON.parse(raw) as unknown, options);
}
