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
export const FINDING_ID_PREFIX = "finding_" as const;
const FINDING_ID_PATTERN = /^finding_[a-f0-9]{32}$/;
const REVIEW_JOURNAL_ENTRY_KINDS = ["selection", "synthesis", "validation", "repair_disposition"] as const;

type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
type RepairDisposition = (typeof REPAIR_DISPOSITIONS)[number];
type ReviewJournalEntryKind = (typeof REVIEW_JOURNAL_ENTRY_KINDS)[number];

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
  synthesis: ReviewSynthesisContract;
  validation: ReviewValidationContract;
  repair_disposition: ReviewRepairDispositionContract;
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
    violated_invariant: identity.violated_invariant,
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
    "schema", "finding_id", "persona_id", "severity", "path", "semantic_anchor", "violated_invariant", "message", "evidence",
  ]);
  if (input.schema !== REVIEW_FINDING_SCHEMA) fail(`${path}.schema`, `must be ${REVIEW_FINDING_SCHEMA}`);
  const finding: ReviewFindingContract = {
    schema: REVIEW_FINDING_SCHEMA,
    finding_id: stringAt(input.finding_id, `${path}.finding_id`, { max: 40, pattern: FINDING_ID_PATTERN }),
    persona_id: stringAt(input.persona_id, `${path}.persona_id`, { pattern: IDENTIFIER }),
    severity: enumAt(input.severity, `${path}.severity`, REVIEW_SEVERITIES),
    path: stablePath(input.path, `${path}.path`),
    semantic_anchor: stringAt(input.semantic_anchor, `${path}.semantic_anchor`, { max: 400 }),
    violated_invariant: stringAt(input.violated_invariant, `${path}.violated_invariant`, { max: 400 }),
    message: stringAt(input.message, `${path}.message`, { max: 2_000 }),
    evidence: boundedTextList(input.evidence, `${path}.evidence`, 16),
  };
  const expected = deriveReviewFindingId(finding);
  if (finding.finding_id !== expected) {
    fail(`${path}.finding_id`, "must be derived from path, semantic_anchor, and violated_invariant");
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
  const expectedEntries = [
    { kind: "selection", digest: digestCanonicalJson(journal.selection) },
    { kind: "synthesis", digest: synthesisDigest },
    { kind: "validation", digest: digestCanonicalJson(journal.validation) },
    { kind: "repair_disposition", digest: digestCanonicalJson(journal.repair_disposition) },
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
    "schema", "subject", "policy", "roster", "selection", "synthesis", "validation", "repair_disposition", "entries",
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
    synthesis: parseSynthesis(input.synthesis, `${source}.synthesis`),
    validation: parseValidation(input.validation, `${source}.validation`),
    repair_disposition: parseRepairDisposition(input.repair_disposition, `${source}.repair_disposition`),
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
