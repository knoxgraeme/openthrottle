import type { ReviewFinding, SemanticReviewReceipt } from "@openthrottle/contracts";
import { digestCanonicalJson } from "@openthrottle/contracts";
import { canonicalJson, digestNormalized, type StageOutcome } from "./manifest.js";

export const REVIEW_FANOUT_PLAN_SCHEMA = "openthrottle.review-fanout-plan/v1" as const;
export const REVIEW_FANOUT_SYNTHESIS_SCHEMA = "openthrottle.review-fanout-synthesis/v1" as const;

export const REVIEW_PERSONA_CATALOG = [
  {
    id: "correctness-dataflow",
    mandatory: true,
    focus: "Changed behavior preserves the intended dataflow and state transitions.",
    triggers: [] as string[],
  },
  {
    id: "tests-contracts",
    mandatory: true,
    focus: "Changed behavior is covered by executable tests and stable contracts.",
    triggers: [] as string[],
  },
  {
    id: "reliability-adversarial",
    mandatory: false,
    focus: "Retries, ordering, idempotency, and settlement cannot silently pass.",
    triggers: ["retry", "lease", "queue", "drain", "dispatch", "idempot", "settle", "repair", "rerun"],
  },
  {
    id: "agent-native-contracts",
    mandatory: false,
    focus: "Agent receipts, native sessions, context policy, and skill fences remain bound.",
    triggers: ["receipt", "native session", "context policy", "skill", "agent", "mcp", "fence"],
  },
  {
    id: "security",
    mandatory: false,
    focus: "Authority, untrusted input, credentials, and provider boundaries remain closed.",
    triggers: ["auth", "token", "credential", "secret", "permission", "provider", "untrusted"],
  },
  {
    id: "data-migration",
    mandatory: false,
    focus: "Persisted schema, versioned JSON, and compatibility contracts remain readable.",
    triggers: ["sqlite", "migration", "schema", "contract", "fixture", "json"],
  },
  {
    id: "performance",
    mandatory: false,
    focus: "Bounded work stays bounded as repository, history, or unit count grows.",
    triggers: ["bounded", "limit", "parallel", "fanout", "max", "budget", "hot path"],
  },
  {
    id: "project-standards",
    mandatory: false,
    focus: "Pipeline manifests, task skills, and repository conventions stay aligned.",
    triggers: ["manifest", "graph", "pipeline", "skill", "standards", "docs"],
  },
] as const;

type ReviewPersonaId = (typeof REVIEW_PERSONA_CATALOG)[number]["id"];
type ReviewFanoutReason = "mandatory_baseline" | "risk_triggered";

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
  max_parallel: number;
  personas: Array<{
    id: ReviewPersonaId;
    mandatory: boolean;
    focus: string;
    reason: ReviewFanoutReason;
  }>;
}

export interface ReviewFanoutSynthesis {
  schema: typeof REVIEW_FANOUT_SYNTHESIS_SCHEMA;
  roster_digest: string;
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
  const instructionText = unit?.instructions.map((id) => input.instructions?.[id] ?? id) ?? [];
  const acceptanceText = unit?.acceptance.map((id) => input.acceptance?.[id] ?? id) ?? [];
  return [
    unit?.id,
    unit?.title,
    ...instructionText,
    ...acceptanceText,
    ...(input.commandNames ?? []),
  ].join("\n").toLowerCase();
}

export function buildReviewFanoutPlan(input: {
  subject: string;
  unit?: ReviewFanoutUnitContext | null;
  instructions?: Record<string, string>;
  acceptance?: Record<string, string>;
  commandNames?: readonly string[];
  maxPersonas?: number;
}): ReviewFanoutPlan {
  const maxPersonas = input.maxPersonas ?? 8;
  if (maxPersonas < 1) throw new Error("review fanout maxPersonas must be at least one");
  const search = normalizedSearchText(input);
  const selected: ReviewFanoutPlan["personas"] = [];
  const selectedPersonaIds = new Set<ReviewPersonaId>();
  for (const persona of REVIEW_PERSONA_CATALOG) {
    const triggered = persona.mandatory || persona.triggers.some((trigger) => search.includes(trigger));
    if (!triggered || selectedPersonaIds.has(persona.id)) continue;
    selectedPersonaIds.add(persona.id);
    selected.push({
      id: persona.id,
      mandatory: persona.mandatory,
      focus: persona.focus,
      reason: persona.mandatory ? "mandatory_baseline" : "risk_triggered",
    });
    if (selected.length === maxPersonas) break;
  }
  const roster = {
    personas: selected.map((persona) => ({
      id: persona.id,
      mandatory: persona.mandatory,
      focus: persona.focus,
      reason: persona.reason,
    })),
  };
  const rosterDigest = digestCanonicalJson(roster);
  return {
    schema: REVIEW_FANOUT_PLAN_SCHEMA,
    roster_id: `review_roster_${rosterDigest.slice(0, 32)}`,
    roster_digest: rosterDigest,
    subject: input.subject,
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
    subject: input.plan.subject,
    outcome,
    summary: outcome === "success"
      ? "All review personas completed without findings."
      : "Review personas completed and synthesis requires follow-up.",
    findings: [...findings.values()],
    receipt_hashes: expectedIds.map((personaId) => receiptHash(receiptsByPersona.get(personaId)!)),
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
