import type {
  ReviewFinding,
  ReviewPolicyContract,
  SemanticReviewReceipt,
} from "@openthrottle/contracts";
import {
  REVIEW_POLICY_SCHEMA,
  digestCanonicalJson,
} from "@openthrottle/contracts";
import { canonicalJson, digestNormalized, type StageOutcome } from "./manifest.js";

export const REVIEW_FANOUT_PLAN_SCHEMA = "openthrottle.review-fanout-plan/v1" as const;
export const REVIEW_FANOUT_SYNTHESIS_SCHEMA = "openthrottle.review-fanout-synthesis/v1" as const;
export const REVIEW_SELECTOR_AUTHORITY_SCHEMA = "openthrottle.review-selector-authority/v1" as const;
export const REVIEW_SELECTOR_RECOMMENDATION_SCHEMA = "openthrottle.review-selector-recommendation/v1" as const;

export const REVIEW_PERSONA_CATALOG = [
  {
    id: "correctness-dataflow",
    title: "Correctness and data flow",
    mandatory: true,
    focus: "Changed behavior preserves the intended dataflow and state transitions.",
    invariant: "changed control and data flow preserves declared behavior",
    triggers: [] as string[],
  },
  {
    id: "tests-contracts",
    title: "Tests and contracts",
    mandatory: true,
    focus: "Changed behavior is covered by executable tests and stable contracts.",
    invariant: "changed behavior has executable contract proof",
    triggers: [] as string[],
  },
  {
    id: "reliability-adversarial",
    title: "Reliability and adversarial orderings",
    mandatory: false,
    focus: "Retries, ordering, idempotency, and settlement cannot silently pass.",
    invariant: "retries ordering and settlement fail closed",
    triggers: ["retry", "lease", "queue", "drain", "dispatch", "idempot", "settle", "repair", "rerun"],
  },
  {
    id: "agent-native-contracts",
    title: "Agent-native contracts",
    mandatory: false,
    focus: "Agent receipts, native sessions, context policy, and skill fences remain bound.",
    invariant: "agent requests receipts and sessions remain exactly fenced",
    triggers: ["receipt", "native session", "context policy", "skill", "agent", "mcp", "fence"],
  },
  {
    id: "security",
    title: "Security boundaries",
    mandatory: false,
    focus: "Authority, untrusted input, credentials, and provider boundaries remain closed.",
    invariant: "untrusted input and credentials cannot exceed sealed authority",
    triggers: ["auth", "token", "credential", "secret", "permission", "provider", "untrusted"],
  },
  {
    id: "data-migration",
    title: "Data and migration safety",
    mandatory: false,
    focus: "Persisted schema, versioned JSON, and compatibility contracts remain readable.",
    invariant: "persisted and versioned data transitions remain safe",
    triggers: ["sqlite", "migration", "schema", "contract", "fixture", "json"],
  },
  {
    id: "performance",
    title: "Performance and bounded work",
    mandatory: false,
    focus: "Bounded work stays bounded as repository, history, or unit count grows.",
    invariant: "changed hot paths remain bounded at production scale",
    triggers: ["bounded", "limit", "parallel", "fanout", "max", "budget", "hot path"],
  },
  {
    id: "project-standards",
    title: "Project standards",
    mandatory: false,
    focus: "Pipeline manifests, task skills, and repository conventions stay aligned.",
    invariant: "changed code follows the repository's normative contracts",
    triggers: ["manifest", "graph", "pipeline", "skill", "standards", "docs"],
  },
] as const;

export type ReviewPersonaId = (typeof REVIEW_PERSONA_CATALOG)[number]["id"];
type ReviewFanoutReason = "mandatory_baseline" | "agent_selected" | "risk_triggered";

const OUTCOME_RANKS: Partial<Record<StageOutcome, number>> = {
  success: 0,
  no_change: 0,
  semantic_repair_required: 1,
  needs_human: 2,
  failure: 3,
  retryable_infrastructure_failure: 3,
};

export interface ReviewFanoutUnitContext {
  id: string;
  title: string;
  instructions: readonly string[];
  acceptance: readonly string[];
}

export interface ReviewFanoutPlan {
  schema: typeof REVIEW_FANOUT_PLAN_SCHEMA;
  roster_id: string;
  roster_digest: string;
  subject: string;
  policy_digest: string;
  selection_id: string;
  selector_receipt_hash: string | null;
  max_parallel: number;
  personas: Array<{
    id: ReviewPersonaId;
    mandatory: boolean;
    focus: string;
    invariant: string;
    reason: ReviewFanoutReason;
    rationale: string;
  }>;
}

export interface ReviewSelectorAuthority {
  schema: typeof REVIEW_SELECTOR_AUTHORITY_SCHEMA;
  subject: string;
  policy_digest: string;
  max_personas: number;
  required_persona_ids: ReviewPersonaId[] | null;
  personas: Array<{
    id: ReviewPersonaId;
    title: string;
    mandatory: boolean;
    focus: string;
    invariant: string;
  }>;
}

export interface ReviewSelectorRecommendation {
  schema: typeof REVIEW_SELECTOR_RECOMMENDATION_SCHEMA;
  subject: string;
  policy_digest: string;
  personas: Array<{ persona_id: ReviewPersonaId; rationale: string }>;
}

export interface ValidatedReviewFanout {
  synthesis: ReviewFanoutSynthesis;
  accepted_blocking_finding_keys: string[];
  rejected_blocking_finding_keys: string[];
  validator_receipt_hash: string | null;
}

export interface ReviewFanoutSynthesis {
  schema: typeof REVIEW_FANOUT_SYNTHESIS_SCHEMA;
  roster_digest: string;
  persona_ids: ReviewPersonaId[];
  subject: string;
  outcome: StageOutcome;
  summary: string;
  findings: ReviewFinding[];
  receipt_hashes: string[];
}

function normalizedSearchText(input: {
  unit?: ReviewFanoutUnitContext | null;
  instructions?: Record<string, string>;
  acceptance?: Record<string, string>;
  commandNames?: readonly string[];
}): string {
  const unit = input.unit;
  const instructionText = unit
    ? unit.instructions.map((id) => input.instructions?.[id] ?? id)
    : Object.values(input.instructions ?? {});
  const acceptanceText = unit
    ? unit.acceptance.map((id) => input.acceptance?.[id] ?? id)
    : Object.values(input.acceptance ?? {});
  return [
    unit?.id,
    unit?.title,
    ...instructionText,
    ...acceptanceText,
    ...(input.commandNames ?? []),
  ].join("\n").toLowerCase();
}

export function reviewPolicyContract(): ReviewPolicyContract {
  return {
    schema: REVIEW_POLICY_SCHEMA,
    policy_id: "structured_review_personas_v1",
    personas: REVIEW_PERSONA_CATALOG.map((persona) => ({
      persona_id: persona.id,
      title: persona.title,
      focus: persona.focus,
      invariants: [persona.invariant],
      max_findings: 8,
    })),
    max_personas_per_selection: REVIEW_PERSONA_CATALOG.length,
    max_findings_per_journal: 64,
  };
}

export function buildReviewSelectorAuthority(input: {
  subject: string;
  maxPersonas?: number;
  requiredPersonaIds?: readonly ReviewPersonaId[];
}): ReviewSelectorAuthority {
  const maxPersonas = input.maxPersonas ?? REVIEW_PERSONA_CATALOG.length;
  if (!Number.isInteger(maxPersonas) || maxPersonas < 2 || maxPersonas > REVIEW_PERSONA_CATALOG.length) {
    throw new Error(`review selector maxPersonas must be between 2 and ${REVIEW_PERSONA_CATALOG.length}`);
  }
  const policy = reviewPolicyContract();
  const requiredPersonaIds = input.requiredPersonaIds ? [...input.requiredPersonaIds] : null;
  if (requiredPersonaIds && (
    new Set(requiredPersonaIds).size !== requiredPersonaIds.length ||
    requiredPersonaIds.some((personaId) => !REVIEW_PERSONA_CATALOG.some((persona) => persona.id === personaId)) ||
    requiredPersonaIds.length > maxPersonas
  )) {
    throw new Error("review selector required roster is invalid");
  }
  return {
    schema: REVIEW_SELECTOR_AUTHORITY_SCHEMA,
    subject: input.subject,
    policy_digest: digestCanonicalJson(policy),
    max_personas: maxPersonas,
    required_persona_ids: requiredPersonaIds,
    personas: REVIEW_PERSONA_CATALOG.map((persona) => ({
      id: persona.id,
      title: persona.title,
      mandatory: persona.mandatory,
      focus: persona.focus,
      invariant: persona.invariant,
    })),
  };
}

export function parseReviewSelectorRecommendation(
  summary: string,
  authority: ReviewSelectorAuthority
): ReviewSelectorRecommendation {
  let value: unknown;
  try {
    value = JSON.parse(summary);
  } catch {
    throw new Error("review selector summary must be one JSON recommendation object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review selector recommendation must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["schema", "subject", "policy_digest", "personas"]);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`review selector recommendation has unknown field ${unknown}`);
  if (input.schema !== REVIEW_SELECTOR_RECOMMENDATION_SCHEMA) {
    throw new Error(`review selector recommendation schema must be ${REVIEW_SELECTOR_RECOMMENDATION_SCHEMA}`);
  }
  if (input.subject !== authority.subject) throw new Error("review selector recommendation subject is stale");
  if (input.policy_digest !== authority.policy_digest) throw new Error("review selector recommendation policy digest is stale");
  if (!Array.isArray(input.personas)) throw new Error("review selector recommendation personas must be an array");
  if (input.personas.length > authority.max_personas) throw new Error("review selector recommendation exceeds the fanout limit");
  const allowed = new Set(authority.personas.map((persona) => persona.id));
  const seen = new Set<string>();
  const personas = input.personas.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`review selector recommendation personas[${index}] must be an object`);
    }
    const persona = entry as Record<string, unknown>;
    if (Object.keys(persona).some((key) => key !== "persona_id" && key !== "rationale")) {
      throw new Error(`review selector recommendation personas[${index}] has unknown fields`);
    }
    if (typeof persona.persona_id !== "string" || !allowed.has(persona.persona_id as ReviewPersonaId)) {
      throw new Error(`review selector recommendation contains unknown persona ${String(persona.persona_id)}`);
    }
    if (seen.has(persona.persona_id)) throw new Error(`review selector recommendation duplicates ${persona.persona_id}`);
    seen.add(persona.persona_id);
    if (typeof persona.rationale !== "string" || persona.rationale.trim().length < 3 || persona.rationale.length > 1_000) {
      throw new Error(`review selector recommendation ${persona.persona_id} needs a bounded evidence rationale`);
    }
    return { persona_id: persona.persona_id as ReviewPersonaId, rationale: persona.rationale.trim() };
  });
  if (authority.required_persona_ids &&
      canonicalJson(personas.map((persona) => persona.persona_id)) !== canonicalJson(authority.required_persona_ids)) {
    throw new Error("review selector recommendation must preserve the exact prior-cycle roster");
  }
  return {
    schema: REVIEW_SELECTOR_RECOMMENDATION_SCHEMA,
    subject: authority.subject,
    policy_digest: authority.policy_digest,
    personas,
  };
}

export function buildReviewFanoutPlan(input: {
  subject: string;
  unit?: ReviewFanoutUnitContext | null;
  instructions?: Record<string, string>;
  acceptance?: Record<string, string>;
  commandNames?: readonly string[];
  maxPersonas?: number;
  recommendation?: ReviewSelectorRecommendation;
  selectorReceiptHash?: string;
  requiredPersonaIds?: readonly ReviewPersonaId[];
}): ReviewFanoutPlan {
  const maxPersonas = input.maxPersonas ?? 8;
  if (maxPersonas < 1) throw new Error("review fanout maxPersonas must be at least one");
  const authority = buildReviewSelectorAuthority({
    subject: input.subject,
    maxPersonas,
    ...(input.requiredPersonaIds ? { requiredPersonaIds: input.requiredPersonaIds } : {}),
  });
  if (input.recommendation && (
    input.recommendation.subject !== authority.subject ||
    input.recommendation.policy_digest !== authority.policy_digest
  )) {
    throw new Error("review selector recommendation does not match the current authority");
  }
  const search = normalizedSearchText(input);
  const selected: ReviewFanoutPlan["personas"] = [];
  const selectedPersonaIds = new Set<ReviewPersonaId>();
  const recommended = new Map(
    (input.recommendation?.personas ?? []).map((persona) => [persona.persona_id, persona.rationale])
  );
  for (const persona of REVIEW_PERSONA_CATALOG) {
    const matchedTrigger = persona.triggers.find((trigger) => search.includes(trigger));
    const triggered = authority.required_persona_ids
      ? authority.required_persona_ids.includes(persona.id)
      : persona.mandatory || recommended.has(persona.id) || matchedTrigger !== undefined;
    if (!triggered || selectedPersonaIds.has(persona.id)) continue;
    selectedPersonaIds.add(persona.id);
    const reason: ReviewFanoutReason = persona.mandatory
      ? "mandatory_baseline"
      : recommended.has(persona.id)
        ? "agent_selected"
        : "risk_triggered";
    selected.push({
      id: persona.id,
      mandatory: persona.mandatory,
      focus: persona.focus,
      invariant: persona.invariant,
      reason,
      rationale: reason === "mandatory_baseline"
        ? recommended.has(persona.id)
          ? `Mandatory structured-review baseline. Selector evidence: ${recommended.get(persona.id)!}`
          : "Mandatory structured-review baseline."
        : reason === "agent_selected"
          ? recommended.get(persona.id)!
          : `Deterministic risk trigger matched: ${matchedTrigger}.`,
    });
    if (selected.length === maxPersonas) break;
  }
  const missingRecommended = [...recommended.keys()].filter((personaId) => !selectedPersonaIds.has(personaId));
  if (missingRecommended.length > 0) {
    throw new Error(`review selector recommendation exceeds the sealed fanout budget: ${missingRecommended.join(", ")}`);
  }
  const roster = {
    policy_digest: authority.policy_digest,
    persona_ids: selected.map((persona) => persona.id),
  };
  const rosterDigest = digestCanonicalJson(roster);
  const selectionId = `review_selection_${digestCanonicalJson({
    subject: input.subject,
    policy_digest: authority.policy_digest,
    personas: selected.map((persona) => ({ id: persona.id, reason: persona.reason, rationale: persona.rationale })),
  }).slice(0, 32)}`;
  return {
    schema: REVIEW_FANOUT_PLAN_SCHEMA,
    roster_id: `review_roster_${rosterDigest.slice(0, 32)}`,
    roster_digest: rosterDigest,
    subject: input.subject,
    policy_digest: authority.policy_digest,
    selection_id: selectionId,
    selector_receipt_hash: input.selectorReceiptHash ?? null,
    max_parallel: selected.length,
    personas: selected,
  };
}

function receiptHash(receipt: SemanticReviewReceipt): string {
  return digestNormalized(canonicalJson(receipt));
}

function findingKey(finding: ReviewFinding): string {
  return digestCanonicalJson({
    severity: finding.severity,
    message: finding.message,
    path: finding.path ?? null,
  });
}

export function reviewFindingKey(finding: ReviewFinding): string {
  return findingKey(finding);
}

function outcomeRank(outcome: StageOutcome): number {
  return OUTCOME_RANKS[outcome] ?? 3;
}

function receiptOutcome(receipt: SemanticReviewReceipt): StageOutcome {
  if (receipt.result === "semantic_repair_required") return "semantic_repair_required";
  if (receipt.result === "needs_human") return "needs_human";
  if (receipt.result === "failure") return "failure";
  return "success";
}

export function synthesizeReviewFanout(input: {
  plan: ReviewFanoutPlan;
  receipts: readonly SemanticReviewReceipt[];
}): ReviewFanoutSynthesis {
  const expectedIds = input.plan.personas.map((persona) => persona.id);
  const receiptsByPersona = new Map<string, SemanticReviewReceipt>();
  for (const receipt of input.receipts) {
    const personaId = receipt.producer.worker_id;
    if (!expectedIds.includes(personaId as ReviewPersonaId)) {
      throw new Error(`review fanout receipt from unexpected persona ${personaId}`);
    }
    if (receipt.subject.post !== input.plan.subject || receipt.subject.pre !== input.plan.subject) {
      throw new Error(`review fanout receipt ${personaId} is not bound to the exact subject`);
    }
    if (receiptsByPersona.has(personaId)) {
      throw new Error(`review fanout receipt for persona ${personaId} is duplicated`);
    }
    receiptsByPersona.set(personaId, receipt);
  }
  const missing = expectedIds.filter((personaId) => !receiptsByPersona.has(personaId));
  if (missing.length > 0) throw new Error(`review fanout missing personas: ${missing.join(", ")}`);

  const findings = new Map<string, ReviewFinding>();
  let outcome: StageOutcome = "success";
  for (const personaId of expectedIds) {
    const receipt = receiptsByPersona.get(personaId)!;
    const nextOutcome = receiptOutcome(receipt);
    if (outcomeRank(nextOutcome) > outcomeRank(outcome)) outcome = nextOutcome;
    for (const finding of receipt.payload.findings) {
      const key = findingKey(finding);
      if (!findings.has(key)) findings.set(key, finding);
    }
  }
  if (outcome === "success" && findings.size > 0) outcome = "semantic_repair_required";
  return {
    schema: REVIEW_FANOUT_SYNTHESIS_SCHEMA,
    roster_digest: input.plan.roster_digest,
    persona_ids: [...expectedIds],
    subject: input.plan.subject,
    outcome,
    summary: outcome === "success"
      ? "All review personas completed without findings."
      : "Review personas completed and synthesis requires follow-up.",
    findings: [...findings.values()],
    receipt_hashes: expectedIds.map((personaId) => receiptHash(receiptsByPersona.get(personaId)!)),
  };
}

export function validateReviewFanoutBlockers(input: {
  synthesis: ReviewFanoutSynthesis;
  validator: SemanticReviewReceipt | null;
}): ValidatedReviewFanout {
  const blocking = input.synthesis.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1");
  if (blocking.length === 0) {
    if (input.validator) throw new Error("review validator must not run when synthesis has no blocking findings");
    return {
      synthesis: {
        ...input.synthesis,
        outcome: input.synthesis.outcome === "semantic_repair_required" ? "success" : input.synthesis.outcome,
        summary: input.synthesis.outcome === "semantic_repair_required"
          ? "Review completed with advisory findings only."
          : input.synthesis.summary,
      },
      accepted_blocking_finding_keys: [],
      rejected_blocking_finding_keys: [],
      validator_receipt_hash: null,
    };
  }
  if (!input.validator) throw new Error("blocking review findings require independent validation");
  const blockingByKey = new Map(blocking.map((finding) => [findingKey(finding), finding]));
  const acceptedKeys = input.validator.payload.findings.map((finding) => findingKey(finding));
  if (new Set(acceptedKeys).size !== acceptedKeys.length) throw new Error("review validator duplicated a blocking finding");
  for (const finding of input.validator.payload.findings) {
    if (finding.severity !== "P0" && finding.severity !== "P1") {
      throw new Error("review validator may return only accepted blocking findings");
    }
    const original = blockingByKey.get(findingKey(finding));
    if (!original || canonicalJson(original) !== canonicalJson(finding)) {
      throw new Error("review validator invented or changed a blocking finding");
    }
  }
  const accepted = new Set(acceptedKeys);
  if (accepted.size > 0 && input.validator.result !== "semantic_repair_required") {
    throw new Error("review validator accepted blockers without returning semantic_repair_required");
  }
  if (accepted.size === 0 && input.validator.result !== "success") {
    throw new Error("review validator rejected every blocker without returning success");
  }
  const rejectedKeys = [...blockingByKey.keys()].filter((key) => !accepted.has(key));
  const findings = input.synthesis.findings.filter((finding) =>
    finding.severity === "P2" || finding.severity === "P3" || accepted.has(findingKey(finding))
  );
  const outcome: StageOutcome = accepted.size > 0
    ? "semantic_repair_required"
    : input.synthesis.outcome === "failure" || input.synthesis.outcome === "needs_human"
      ? input.synthesis.outcome
      : "success";
  return {
    synthesis: {
      ...input.synthesis,
      outcome,
      summary: accepted.size > 0
        ? `${accepted.size} blocking review finding(s) survived independent validation.`
        : "Independent validation rejected every blocking review finding.",
      findings,
      receipt_hashes: [...input.synthesis.receipt_hashes, receiptHash(input.validator)],
    },
    accepted_blocking_finding_keys: [...accepted],
    rejected_blocking_finding_keys: rejectedKeys,
    validator_receipt_hash: receiptHash(input.validator),
  };
}

export function validateReviewFanoutRepair(input: {
  previous: ReviewFanoutSynthesis;
  nextPlan: ReviewFanoutPlan;
}): void {
  if (input.nextPlan.roster_digest !== input.previous.roster_digest) {
    throw new Error("review fanout repair must rerun the exact prior roster");
  }
  if (input.nextPlan.subject === input.previous.subject) {
    throw new Error("review fanout repair must validate a new repaired subject");
  }
}
