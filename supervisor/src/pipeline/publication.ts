import { createHash } from "node:crypto";
import {
  canonicalJson,
  digestNormalized,
  PIPELINE_OUTCOMES,
  type PipelineManifest,
  type PipelineOutcome,
  type StageOutcome,
} from "./manifest.js";
import type {
  CoordinatorGateReceiptWrite,
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineInstanceStatus,
  PipelineStageAttempt,
} from "./store.js";
import type { ExecutionPublicationSnapshot } from "./execution-publication.js";
import { executionLedgerLines } from "./execution-publication.js";
import type { PipelineCoordinatorEvent } from "./coordinator.js";
import { sanitizeText } from "../shared/sanitize.js";

export const PIPELINE_PUBLICATION_SCHEMA = "openthrottle.pipeline-publication/v1";
export const PIPELINE_PUBLICATION_TEMPLATE_VERSION = 2;
const SUPPORTED_PIPELINE_PUBLICATION_TEMPLATE_VERSIONS = new Set<number>([
  1,
  PIPELINE_PUBLICATION_TEMPLATE_VERSION,
]);
const INLINE_ARTIFACT_LIMIT_BYTES = 4 * 1024;
const PUBLICATION_BODY_LIMIT = 12_000;
const ATTACHMENT_LIMIT_BYTES = 256 * 1024;
const MAX_RENDERED_FINDINGS = 10;
const TERMINAL_STATUSES = new Set<string>(PIPELINE_OUTCOMES);

export type PipelinePublicationTemplate =
  | "selection"
  | "gate"
  | "repair_reentry"
  | "needs_human"
  | "provider_wait"
  | "terminal";

export interface PipelinePublicationAttachment {
  filename: string;
  contentType: "application/json";
  content: string;
}

export interface PipelinePublicationEnvelope {
  schema: typeof PIPELINE_PUBLICATION_SCHEMA;
  template: {
    name: PipelinePublicationTemplate;
    version: typeof PIPELINE_PUBLICATION_TEMPLATE_VERSION;
  };
  pipeline: {
    instance_id: string;
    linear_issue_id: string;
    id: string;
    version: number;
    manifest_digest: string;
    generation: number;
  };
  stage: null | {
    id: string;
    attempt_id: string;
    attempt_ordinal: number;
    reentry_ordinal: number;
    context_policy: string;
  };
  decision: {
    outcome: StageOutcome | PipelineOutcome | "selected";
    gate_result: CoordinatorGateReceiptWrite["result"] | "not_evaluated";
    assurance: string;
    policy_digest: string | null;
    subject: string | null;
    next_status: PipelineInstanceStatus;
    wait_reason: string | null;
  };
  evidence: {
    artifact_hashes: string[];
    summaries: string[];
    details: string[];
    findings?: PublicationFinding[];
    actions?: string[];
    uncertainty: string[];
  };
  links: Array<{ label: string; url: string }>;
  structured_execution?: ExecutionPublicationSnapshot;
  resume_status: PipelineInstanceStatus | null;
  body: string;
  artifact_inline?: string;
  attachment?: PipelinePublicationAttachment;
}

type PipelinePublicationBodyInput = Omit<
  PipelinePublicationEnvelope,
  "body" | "artifact_inline" | "attachment"
>;

interface EvidenceSummary {
  summary?: unknown;
  evidence?: unknown;
  findings?: unknown;
  actions?: unknown;
  uncertainty?: unknown;
}

interface PublicationFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  code: string;
  summary: string;
  /** The latest run-level disposition, persisted so later publications keep it. */
  disposition?: FindingDisposition;
}

type FindingDisposition = "fixed in-stage" | "carried to repair" | "remaining/accepted" | `repaired-at-${string}`;

const FINDING_DISPOSITIONS: readonly FindingDisposition[] =
  ["fixed in-stage", "carried to repair", "remaining/accepted"];

const OMITTED_EVIDENCE_KEY = /(?:reasoning|chain[_-]?of[_-]?thought|thoughts?|analysis|prompt|token|secret|password|auth)/i;

function scrubArtifactForPublication(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubArtifactForPublication);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? boundedSanitized(value, 8_000) : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !OMITTED_EVIDENCE_KEY.test(key))
    .map(([key, item]) => [key, scrubArtifactForPublication(item)]));
}

function boundedSanitized(value: string, max: number): string {
  return sanitizeText(value).slice(0, max);
}

function boundedPublicationLine(value: string, max: number): string {
  return boundedSanitized(value, max)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/([\\`\[\]()<>])/g, "\\$1")
    .trim();
}

function safeFinding(value: unknown): PublicationFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const finding = value as Record<string, unknown>;
  if (!["P0", "P1", "P2", "P3"].includes(String(finding.severity)) ||
      typeof finding.code !== "string" || typeof finding.summary !== "string") {
    return null;
  }
  return {
    severity: finding.severity as PublicationFinding["severity"],
    code: boundedPublicationLine(finding.code, 80),
    summary: boundedPublicationLine(finding.summary, 300),
  };
}

function safeEvidence(raw: string): {
  summary?: string;
  evidence: string[];
  findings: PublicationFinding[];
  actions: string[];
  uncertainty: string[];
} {
  try {
    const value = JSON.parse(raw) as EvidenceSummary;
    return {
      summary: typeof value.summary === "string" ? boundedPublicationLine(value.summary, 1_000) : undefined,
      evidence: Array.isArray(value.evidence)
        ? value.evidence.filter((entry): entry is string => typeof entry === "string")
            .slice(0, 20).map((entry) => boundedPublicationLine(entry, 500))
        : [],
      findings: Array.isArray(value.findings)
        ? value.findings.slice(0, 50)
            .map(safeFinding).filter((finding): finding is PublicationFinding => finding !== null)
        : [],
      actions: Array.isArray(value.actions)
        ? value.actions.filter((entry): entry is string => typeof entry === "string")
            .slice(0, 50).map((entry) => boundedPublicationLine(entry, 500))
        : [],
      uncertainty: Array.isArray(value.uncertainty)
        ? value.uncertainty.filter((entry): entry is string => typeof entry === "string")
            .slice(0, 10).map((entry) => boundedPublicationLine(entry, 500))
        : [],
    };
  } catch {
    return { evidence: [], findings: [], actions: [], uncertainty: [] };
  }
}

function githubLinks(instance: PipelineInstance, subject: string | null): Array<{ label: string; url: string }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(instance.repository)) return [];
  return subject && /^[a-f0-9]{40,64}$/.test(subject)
    ? [{ label: "Gated tree", url: `https://github.com/${instance.repository}/tree/${subject}` }]
    : [];
}

function chooseTemplate(
  write: CoordinatorTransitionWrite,
  resumeStatus: PipelineInstanceStatus | null
): PipelinePublicationTemplate {
  if (write.terminalOutcome === "needs_human" || resumeStatus === "waiting_human") return "needs_human";
  if (write.terminalOutcome) return "terminal";
  if (write.nextStatus === "waiting_provider") return "provider_wait";
  if ((write.reentryIncrement ?? 0) > 0) return "repair_reentry";
  return "gate";
}

interface RenderContext {
  manifest: PipelineManifest;
  stagesById: Map<string, PipelineManifest["stages"][number]>;
  stageIndex: number;
  transition: PipelineManifest["stages"][number]["transitions"][StageOutcome] | undefined;
  repairSourceStageId?: string;
  publishedCommit: string | null;
}

interface RenderExtras {
  scheduledReentryOrdinal?: number;
  repairBannerFinding?: PublicationFinding;
  repairSourceStageId?: string;
  publishedCommit?: string | null;
}

const STAGE_LABELS: Readonly<Record<string, { display: string; action?: string }>> = {
  build: { display: "building" },
  command: { display: "running command" },
  implementation: { display: "implementing" },
  lint: { display: "linting" },
  planning: { display: "planning" },
  provider: { display: "waiting on GitHub" },
  publish: { display: "publishing" },
  post_simplify_review: { display: "re-review", action: "reviewing simplified changes" },
  repair_implementation: { display: "repair implementing", action: "repairing changes" },
  repair_semantic_review: { display: "repair code review", action: "reviewing repaired changes" },
  review: { display: "code review", action: "reviewing changes" },
  semantic_review: { display: "code review", action: "reviewing changes" },
  simplification: { display: "simplifying", action: "simplifying changes" },
  test: { display: "testing" },
};

function stageDisplayName(stageId: string): string {
  return STAGE_LABELS[stageId]?.display ?? stageId.replaceAll("_", " ");
}

function stageActionName(stageId: string): string {
  const label = STAGE_LABELS[stageId];
  return label?.action ?? label?.display ?? stageDisplayName(stageId);
}

function stageById(manifest: PipelineManifest): Map<string, PipelineManifest["stages"][number]> {
  return new Map(manifest.stages.map((stage) => [stage.id, stage]));
}

function followSuccessPath(stages: ReadonlyMap<string, PipelineManifest["stages"][number]>, start: string): string[] {
  const visited = new Set<string>();
  const path: string[] = [];
  let current: string | undefined = start;
  while (current && !visited.has(current)) {
    const stage = stages.get(current);
    if (!stage) break;
    visited.add(current);
    path.push(current);
    current = stage.transitions.success?.to;
  }
  return path;
}

interface RepairBranch {
  source: string;
  start: string;
}

function repairBranchFromSource(
  source: string | undefined,
  context: RenderContext,
  current: string | undefined,
  next: string
): RepairBranch | undefined {
  if (!source || source.startsWith("repair_")) return undefined;
  const stage = context.stagesById.get(source);
  const start = stage?.transitions.semantic_repair_required?.to;
  if (start?.startsWith("repair_")) {
    const path = followSuccessPath(context.stagesById, start);
    if (path.includes(next) || Boolean(current && path.includes(current))) {
      return { source, start };
    }
  }
  return undefined;
}

function repairBranch(envelope: PipelinePublicationBodyInput, context: RenderContext): RepairBranch | undefined {
  const current = envelope.stage?.id;
  const next = nextStageName(envelope, context);
  const currentRepairSource = repairBranchFromSource(
    context.transition?.to?.startsWith("repair_") ? current : undefined,
    context,
    current,
    next
  );
  if (currentRepairSource) return currentRepairSource;
  const persistedRepairSource = repairBranchFromSource(context.repairSourceStageId, context, current, next);
  if (persistedRepairSource) return persistedRepairSource;
  for (const stage of context.manifest.stages) {
    if (stage.id.startsWith("repair_")) continue;
    const start = stage.transitions.semantic_repair_required?.to;
    if (!start?.startsWith("repair_")) continue;
    const path = followSuccessPath(context.stagesById, start);
    if (path.includes(next) || Boolean(current && path.includes(current))) {
      return { source: stage.id, start };
    }
  }
  return undefined;
}

function hasRepairStageEvidence(envelope: PipelinePublicationBodyInput, context: RenderContext): boolean {
  const current = envelope.stage?.id;
  const next = nextStageName(envelope, context);
  return Boolean(
    current?.startsWith("repair_") ||
      next.startsWith("repair_")
  );
}

function checklistStageIds(envelope: PipelinePublicationBodyInput, context: RenderContext): string[] {
  const happyPath = followSuccessPath(context.stagesById, context.manifest.entry_stage);
  const current = envelope.stage?.id;
  if (!hasRepairStageEvidence(envelope, context)) {
    return current && !happyPath.includes(current) ? [...happyPath, current] : happyPath;
  }
  const repair = repairBranch(envelope, context);
  if (!repair) {
    return current && !happyPath.includes(current) ? [...happyPath, current] : happyPath;
  }
  const repairPath = followSuccessPath(context.stagesById, repair.start);
  const sourceIndex = happyPath.indexOf(repair.source);
  const prefix = sourceIndex >= 0 ? happyPath.slice(0, sourceIndex + 1) : [];
  const path = [...prefix, ...repairPath];
  return current && !path.includes(current) ? [...path, current] : path;
}

function renderContext(
  envelope: PipelinePublicationBodyInput,
  normalizedManifest: string,
  extras?: RenderExtras
): RenderContext {
  const manifest = JSON.parse(normalizedManifest) as PipelineManifest;
  const stagesById = stageById(manifest);
  const stageIndex = envelope.stage
    ? manifest.stages.findIndex((stage) => stage.id === envelope.stage?.id)
    : -1;
  const stage = stageIndex >= 0 ? manifest.stages[stageIndex] : undefined;
  return {
    manifest,
    stagesById,
    stageIndex,
    transition: stage?.transitions[envelope.decision.outcome as StageOutcome],
    repairSourceStageId: extras?.repairSourceStageId,
    publishedCommit: extras?.publishedCommit ?? null,
  };
}

function repairSourceStageIdFromRequestPayload(payload: string | null): string | undefined {
  if (!payload) return undefined;
  try {
    const request = JSON.parse(payload) as { transitionContext?: unknown };
    if (typeof request.transitionContext !== "string") return undefined;
    const context = JSON.parse(request.transitionContext) as { from_stage?: unknown };
    return typeof context.from_stage === "string" ? context.from_stage : undefined;
  } catch {
    return undefined;
  }
}

function nextStageName(envelope: PipelinePublicationBodyInput, context: RenderContext): string {
  if (context.transition?.to) return context.transition.to;
  if (envelope.stage) return envelope.stage.id;
  return context.manifest.entry_stage;
}

function reentryRound(
  envelope: PipelinePublicationBodyInput,
  context: RenderContext,
  extras?: RenderExtras
): string {
  // The scheduled target attempt's re-entry ordinal is the round number; the
  // pinned transition's max_reentries is already the number of permitted
  // rounds, so the final allowed round renders as k of k.
  const round = extras?.scheduledReentryOrdinal ?? (envelope.stage?.reentry_ordinal ?? 0) + 1;
  const max = context.transition?.max_reentries;
  return max === undefined ? `${round}` : `${round} of ${max}`;
}

function reentrySentence(
  envelope: PipelinePublicationBodyInput,
  context: RenderContext,
  extras?: RenderExtras
): string {
  const round = reentryRound(envelope, context, extras);
  const target = nextStageName(envelope, context);
  return envelope.decision.outcome === "retryable_infrastructure_failure"
    ? `The supervisor is retrying the ${target} stage after an infrastructure failure (attempt ${round}).`
    : `The supervisor accepted the stage result and scheduled repair round ${round} at the ${target} stage.`;
}

function sentenceForOutcome(outcome: StageOutcome | PipelineOutcome | "selected"): string {
  switch (outcome) {
    case "selected":
      return "the supervisor selected the pinned pipeline for this ticket.";
    case "success":
      return "the stage completed successfully.";
    case "no_change":
      return "the stage completed and reported that no change was needed.";
    case "semantic_repair_required":
      return "the stage completed and asked for a repair pass.";
    case "retryable_infrastructure_failure":
      return "the stage could not complete because infrastructure failed.";
    case "needs_human":
      return "the run needs a human decision before it can continue.";
    case "canceled":
      return "the run was canceled.";
    case "superseded":
      return "the run was replaced by a newer session.";
    case "failure":
    case "failed":
      return "the run failed.";
    case "shipped":
      return "the job shipped.";
  }
}

function eventSentence(
  envelope: PipelinePublicationBodyInput,
  context: RenderContext,
  extras?: RenderExtras
): string {
  switch (envelope.template.name) {
    case "selection":
      return "OpenThrottle selected the pinned pipeline and recorded the starting receipt.";
    case "gate":
      return envelope.decision.gate_result === "passed"
        ? "The supervisor accepted the stage result and verified the required fences."
        : `The supervisor recorded the stage result: ${sentenceForOutcome(envelope.decision.outcome)}`;
    case "repair_reentry":
      return reentrySentence(envelope, context, extras);
    case "needs_human":
      return terminalSentence(envelope, context);
    case "provider_wait":
      return "The run is waiting for GitHub provider evidence.";
    case "terminal":
      return terminalSentence(envelope, context);
  }
}

function terminalSentence(envelope: PipelinePublicationBodyInput, context: RenderContext): string {
  const reason = envelope.decision.wait_reason
    ? boundedPublicationLine(envelope.decision.wait_reason, 1_000)
    : null;
  const providerLink = envelope.links[0]
    ? ` Provider link: [${boundedPublicationLine(envelope.links[0].label, 100)}](${envelope.links[0].url}).`
    : "";
  switch (envelope.decision.outcome) {
    case "shipped":
      return `The job shipped.${providerLink}`;
    case "no_change":
      // A no_change terminal can still follow an earlier publish in the same
      // generation (e.g. a later repair round found nothing further to
      // change). published_commit is set only once a publish_subject stage
      // actually succeeds (see gates.ts); envelope.links/immutable_subject is
      // sealed on every stage result regardless of publication and would
      // misreport an ordinary first-stage no_change (which never published
      // anything) as an already-published run.
      return context.publishedCommit
        ? `The job finished with no further code change needed; the already-published tree remains current.${providerLink}`
        : "The job finished because no code change was needed; no pull request was created.";
    case "needs_human":
      return `The job needs a human decision before it can finish${reason ? `: ${reason}` : ""}. The workspace is preserved.`;
    case "failed":
    case "failure":
      return `The job failed${reason ? `: ${reason}.` : "."}`;
    case "canceled":
      return "The job was canceled before it could finish.";
    case "superseded":
      return "The job was superseded by a newer run.";
    default:
      return sentenceForOutcome(envelope.decision.outcome);
  }
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (/^(?:- \[[ x]\]|→ )/.test(line)) return true;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function activeChecklistIndex(
  envelope: PipelinePublicationBodyInput,
  context: RenderContext,
  checklist: readonly string[]
): number {
  if (envelope.template.name === "terminal" ||
      TERMINAL_STATUSES.has(envelope.decision.next_status) ||
      (envelope.resume_status && TERMINAL_STATUSES.has(envelope.resume_status))) {
    return checklist.length;
  }
  const next = nextStageName(envelope, context);
  const currentIndex = envelope.stage ? checklist.indexOf(envelope.stage.id) : -1;
  const nextIndex = checklist.indexOf(next, currentIndex >= 0 ? currentIndex + 1 : 0);
  if (nextIndex >= 0 && next !== envelope.stage?.id) return nextIndex;
  const fallbackNextIndex = checklist.indexOf(next);
  if (fallbackNextIndex >= 0 && next !== envelope.stage?.id) return fallbackNextIndex;
  return currentIndex >= 0 ? currentIndex : 0;
}

interface ChecklistProjection {
  stageIds: string[];
  activeIndex: number;
  ordinal: number;
  total: number;
  stageId: string;
}

function checklistProjection(envelope: PipelinePublicationBodyInput, context: RenderContext): ChecklistProjection {
  const stageIds = checklistStageIds(envelope, context);
  const activeIndex = activeChecklistIndex(envelope, context, stageIds);
  const total = stageIds.length;
  if (activeIndex >= 0 && activeIndex < total) {
    return { stageIds, activeIndex, ordinal: activeIndex + 1, total, stageId: stageIds[activeIndex]! };
  }
  const ordinal = envelope.stage
    ? context.stageIndex >= 0 ? context.stageIndex + 1 : envelope.stage.attempt_ordinal
    : 0;
  const stageId = envelope.stage?.id ?? envelope.template.name.replaceAll("_", " ");
  return { stageIds, activeIndex, ordinal: Math.min(ordinal, total), total, stageId };
}

function whoseMoveLine(
  envelope: PipelinePublicationBodyInput,
  checklist: ChecklistProjection,
  context: RenderContext
): string {
  const waitReason = envelope.decision.wait_reason
    ? boundedPublicationLine(envelope.decision.wait_reason, 1_000)
    : "the published receipt in this Linear session";
  const suffix = `(stage ${checklist.ordinal} of ${checklist.total}).`;
  if (envelope.decision.next_status === "waiting_human" || envelope.template.name === "needs_human") {
    return `**Your move: decision required — ${waitReason} ${suffix}**`;
  }
  if (envelope.decision.next_status === "waiting_provider" || envelope.template.name === "provider_wait") {
    return `**Your move: nothing — waiting on GitHub: ${waitReason} ${suffix}**`;
  }
  if (envelope.template.name === "terminal" ||
      envelope.decision.next_status === envelope.decision.outcome &&
      TERMINAL_STATUSES.has(envelope.decision.next_status)) {
    return `**Your move: nothing — this run is finished. ${terminalSentence(envelope, context)}**`;
  }
  return `**Your move: nothing — ${stageActionName(checklist.stageId)} ${suffix}**`;
}

function stageChecklistLines(envelope: PipelinePublicationBodyInput, checklist: ChecklistProjection): string[] {
  return checklist.stageIds.map((stageId, index) => {
    if (index < checklist.activeIndex || checklist.activeIndex >= checklist.stageIds.length) {
      return `- [x] ${stageDisplayName(stageId)}`;
    }
    if (index === checklist.activeIndex) {
      const wait = envelope.decision.wait_reason
        ? ` — ${boundedPublicationLine(envelope.decision.wait_reason, 500)}`
        : "";
      return `→ **${stageDisplayName(stageId)}** — in progress${wait}`;
    }
    return `- [ ] ${stageDisplayName(stageId)}`;
  });
}

function summaryHeaderLines(envelope: PipelinePublicationBodyInput, context: RenderContext): string[] {
  const checklist = checklistProjection(envelope, context);
  return [
    whoseMoveLine(envelope, checklist, context),
    ...stageChecklistLines(envelope, checklist),
    ...terminalDecisionContextLines(envelope, context),
  ];
}

function terminalDecisionContextLines(envelope: PipelinePublicationBodyInput, context: RenderContext): string[] {
  if (envelope.decision.outcome === "shipped" ||
      envelope.template.name !== "terminal" && envelope.template.name !== "needs_human" &&
        envelope.decision.next_status !== "waiting_human") {
    return [];
  }
  const reason = envelope.decision.wait_reason
    ? boundedPublicationLine(envelope.decision.wait_reason, 1_000)
    : terminalSentence(envelope, context);
  const asked = envelope.decision.outcome === "needs_human"
    ? reason
    : "No decision is required; review the terminal outcome.";
  return [
    `**Why:** ${reason}`,
    `**Asked:** ${asked}`,
  ];
}

function normalizedFindingToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function findingCodeTokens(value: string): string[] {
  return normalizedFindingToken(value).split(" ").filter((token) => token.length > 1);
}

function actionAddressesFinding(action: string, finding: PublicationFinding): boolean {
  const normalizedAction = normalizedFindingToken(action);
  const normalizedCode = normalizedFindingToken(finding.code);
  const normalizedSummary = normalizedFindingToken(finding.summary);
  const codeTokens = findingCodeTokens(finding.code);
  return (normalizedCode.length > 0 && normalizedAction.includes(normalizedCode)) ||
    (codeTokens.length > 1 && codeTokens.every((token) => normalizedAction.includes(token))) ||
    (normalizedSummary.length > 0 && normalizedAction.includes(normalizedSummary));
}

interface FindingDispositionContext {
  outcome: StageOutcome | PipelineOutcome | "selected";
  template: PipelinePublicationTemplate;
}

function dispositionForFinding(
  finding: PublicationFinding,
  actions: readonly string[],
  context: FindingDispositionContext
): FindingDisposition {
  if (actions.some((action) => actionAddressesFinding(action, finding))) return "fixed in-stage";
  if (context.outcome === "semantic_repair_required" && context.template === "repair_reentry") {
    return "carried to repair";
  }
  return "remaining/accepted";
}

function findingIdentity(finding: PublicationFinding): string {
  return `${finding.severity}|${finding.code}|${finding.summary}`;
}

function dedupeFindings(findings: readonly PublicationFinding[]): PublicationFinding[] {
  const unique = new Map<string, PublicationFinding>();
  for (const finding of findings) {
    const identity = findingIdentity(finding);
    if (!unique.has(identity)) unique.set(identity, finding);
  }
  return [...unique.values()];
}

function findingsWithDisposition(
  findings: readonly PublicationFinding[],
  actions: readonly string[],
  context: FindingDispositionContext
): PublicationFinding[] {
  return dedupeFindings(findings).map((finding) => ({
    ...finding,
    disposition: dispositionForFinding(finding, actions, context),
  }));
}

/**
 * Accumulates the run's finding state: prior findings keep their persisted
 * disposition unless this stage's recorded actions resolve them or the repair
 * branch produces a new subject; current findings take a fresh disposition.
 */
function mergeRunFindings(
  prior: readonly PublicationFinding[],
  currentWithDisposition: readonly PublicationFinding[],
  actions: readonly string[],
  repairedAtSubject?: string
): PublicationFinding[] {
  const merged = new Map<string, PublicationFinding>();
  for (const finding of dedupeFindings(prior)) {
    const resolved = finding.disposition !== "fixed in-stage" &&
      actions.some((action) => actionAddressesFinding(action, finding));
    const repaired = !resolved &&
      finding.disposition === "carried to repair" &&
      repairedAtSubject !== undefined;
    let nextFinding = finding;
    if (resolved) {
      nextFinding = { ...finding, disposition: "fixed in-stage" };
    } else if (repaired) {
      nextFinding = { ...finding, disposition: `repaired-at-${repairedAtSubject}` };
    }
    merged.set(findingIdentity(finding), nextFinding);
  }
  for (const finding of currentWithDisposition) {
    merged.set(findingIdentity(finding), finding);
  }
  return [...merged.values()].slice(0, 50);
}

function storedFindingDisposition(value: unknown): FindingDisposition | undefined {
  if (typeof value !== "string") return undefined;
  const staticDisposition = FINDING_DISPOSITIONS.find((disposition) => disposition === value);
  if (staticDisposition) return staticDisposition;
  return /^repaired-at-[a-f0-9]{7,12}$/.test(value) ? value as FindingDisposition : undefined;
}

function repairedAtSubject(input: {
  normalizedManifest: string;
  repairSourceStageId: string | undefined;
  currentStageId: string;
  outcome: StageOutcome | PipelineOutcome;
  expectedSubject: string | null | undefined;
  subject: string | null | undefined;
}): string | undefined {
  if (!input.repairSourceStageId ||
      !input.subject ||
      input.outcome !== "success" ||
      input.subject === input.expectedSubject) {
    return undefined;
  }
  const manifest = JSON.parse(input.normalizedManifest) as PipelineManifest;
  const stagesById = stageById(manifest);
  const start = stagesById.get(input.repairSourceStageId)?.transitions.semantic_repair_required?.to;
  if (!start) return undefined;
  return followSuccessPath(stagesById, start).includes(input.currentStageId)
    ? input.subject.slice(0, 12)
    : undefined;
}

/**
 * Reads a finding from a persisted publication envelope. The values were
 * bounded and markdown-escaped when the envelope was built, so this only
 * re-sanitizes without re-escaping (which would corrupt prior escapes and
 * break finding identity across stages).
 */
function safeStoredFinding(value: unknown): PublicationFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const finding = value as Record<string, unknown>;
  if (!["P0", "P1", "P2", "P3"].includes(String(finding.severity)) ||
      typeof finding.code !== "string" || typeof finding.summary !== "string") {
    return null;
  }
  const disposition = storedFindingDisposition(finding.disposition);
  return {
    severity: finding.severity as PublicationFinding["severity"],
    code: boundedSanitized(finding.code, 160).replace(/[\r\n\t]+/g, " ").trim(),
    summary: boundedSanitized(finding.summary, 600).replace(/[\r\n\t]+/g, " ").trim(),
    ...(disposition ? { disposition } : {}),
  };
}

/**
 * Extracts the accumulated finding state from persisted publication payloads,
 * later payloads overriding earlier dispositions for the same finding.
 */
export function accumulatedPublicationFindings(payloads: readonly string[]): PublicationFinding[] {
  const merged = new Map<string, PublicationFinding>();
  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const envelope = parsed as { schema?: unknown; evidence?: { findings?: unknown } };
    if (envelope.schema !== PIPELINE_PUBLICATION_SCHEMA ||
        !Array.isArray(envelope.evidence?.findings)) {
      continue;
    }
    for (const value of envelope.evidence.findings.slice(0, 50)) {
      const finding = safeStoredFinding(value);
      if (finding) merged.set(findingIdentity(finding), finding);
    }
  }
  return [...merged.values()].slice(0, 50);
}

/**
 * Reads the latest non-repair stage that scheduled a repair branch from prior
 * publication envelopes, so later repair-stage summaries keep the original
 * branch anchor even after the sealed attempt context has advanced.
 */
export function accumulatedPublicationRepairSource(payloads: readonly string[]): string | undefined {
  let source: string | undefined;
  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const envelope = parsed as {
      schema?: unknown;
      template?: { name?: unknown };
      decision?: { outcome?: unknown };
      stage?: { id?: unknown } | null;
    };
    const stageId = envelope.stage?.id;
    if (envelope.schema === PIPELINE_PUBLICATION_SCHEMA &&
        envelope.template?.name === "repair_reentry" &&
        envelope.decision?.outcome === "semantic_repair_required" &&
        typeof stageId === "string" &&
        !stageId.startsWith("repair_")) {
      source = stageId;
    }
  }
  return source;
}

function findingsSectionLines(envelope: PipelinePublicationBodyInput): string[] {
  const findings = dedupeFindings(envelope.evidence.findings ?? []);
  if (findings.length === 0) return [];
  const actions = envelope.evidence.actions ?? [];
  const context: FindingDispositionContext = {
    outcome: envelope.decision.outcome,
    template: envelope.template.name,
  };
  const visible = findings.slice(0, MAX_RENDERED_FINDINGS);
  const lines = [
    "**Findings**",
    ...visible.map((finding) => {
      const disposition = finding.disposition ?? dispositionForFinding(finding, actions, context);
      return `[${finding.severity}] ${finding.code} — ${finding.summary} → ${disposition}`;
    }),
  ];
  const omitted = findings.length - visible.length;
  if (omitted > 0) lines.push(`+${omitted} more`);
  return lines;
}

function assumptionsSectionLines(envelope: PipelinePublicationBodyInput): string[] {
  const items = envelope.evidence.uncertainty
    .map((item) => item.replace(/^Assumptions\s+\\*&\s+decisions:? */i, "").trim())
    .filter(Boolean);
  if (items.length === 0) return [];
  return [
    "**Assumptions & decisions**",
    ...items.map((item) => `- ${item}`),
  ];
}

function addressedFindingsLines(envelope: PipelinePublicationBodyInput): string[] {
  if (envelope.template.name !== "provider_wait" || !envelope.decision.subject) return [];
  const actions = envelope.evidence.actions ?? [];
  const addressed = dedupeFindings(envelope.evidence.findings ?? [])
    .filter((finding) =>
      finding.disposition === "fixed in-stage" &&
      actions.some((action) => actionAddressesFinding(action, finding))
    )
    .slice(0, MAX_RENDERED_FINDINGS);
  if (addressed.length === 0) return [];
  const shortSubject = envelope.decision.subject.slice(0, 12);
  return [
    `Addressed in \`${shortSubject}\`:`,
    ...addressed.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.summary}`),
  ];
}

function repairBannerLines(
  envelope: PipelinePublicationBodyInput,
  context: RenderContext,
  extras?: RenderExtras
): string[] {
  if (envelope.template.name !== "repair_reentry" ||
      envelope.decision.outcome !== "semantic_repair_required") {
    return [];
  }
  const findings = dedupeFindings(envelope.evidence.findings ?? []);
  const finding = extras?.repairBannerFinding ??
    findings.find((item) => item.disposition === "carried to repair") ??
    findings[0];
  const suffix = finding
    ? `[${finding.severity}] ${finding.code}: ${finding.summary}`
    : `scheduled at ${stageDisplayName(nextStageName(envelope, context))}`;
  return [`🔁 Repair round ${reentryRound(envelope, context, extras)} — ${suffix}`];
}

function renderBody(
  envelope: PipelinePublicationBodyInput,
  normalizedManifest: string,
  extras?: RenderExtras
): string {
  const context = renderContext(envelope, normalizedManifest, extras);
  const lines = [
    ...summaryHeaderLines(envelope, context),
    ...repairBannerLines(envelope, context, extras),
    ...executionLedgerLines(envelope.structured_execution),
    ...findingsSectionLines(envelope),
    ...assumptionsSectionLines(envelope),
    "",
    eventSentence(envelope, context, extras),
  ];
  envelope.evidence.summaries.forEach((summary) => lines.push(summary));
  envelope.evidence.details.forEach((detail) => lines.push(detail));
  if (envelope.links.length > 0) {
    envelope.links.forEach((link) => lines.push(`- [${link.label}](${link.url})`));
  }
  return boundedSanitized(dedupeLines(lines).join("\n"), PUBLICATION_BODY_LIMIT);
}

export function shouldPostLinearEventComment(envelope: PipelinePublicationEnvelope): boolean {
  return envelope.template.name === "selection" ||
    envelope.template.name === "repair_reentry" ||
    envelope.template.name === "provider_wait" ||
    envelope.template.name === "needs_human" ||
    envelope.template.name === "terminal";
}

export function deterministicPublicationId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildSelectionPublication(instance: PipelineInstance): PipelinePublicationEnvelope {
  const partial: PipelinePublicationBodyInput = {
    schema: PIPELINE_PUBLICATION_SCHEMA,
    template: { name: "selection" as const, version: PIPELINE_PUBLICATION_TEMPLATE_VERSION },
    pipeline: {
      instance_id: instance.id,
      linear_issue_id: instance.linear_issue_id,
      id: instance.pipeline_id,
      version: instance.pipeline_version,
      manifest_digest: instance.manifest_digest,
      generation: instance.generation,
    },
    stage: null,
    decision: {
      outcome: "selected" as const,
      gate_result: "not_evaluated" as const,
      assurance: "coordinator_pinned",
      policy_digest: null,
      subject: null,
      next_status: instance.status,
      wait_reason: null,
    },
    evidence: {
      artifact_hashes: [],
      summaries: ["The supervisor pinned the manifest, repository configuration, runtime release, and capability digest."],
      details: [],
      findings: [],
      actions: [],
      uncertainty: [],
    },
    links: githubLinks(instance, null),
    resume_status: null,
  };
  return { ...partial, body: renderBody(partial, instance.normalized_manifest) };
}

export function buildLifecyclePublication(input: {
  instance: PipelineInstance;
  attempt?: PipelineStageAttempt;
  outcome: PipelineOutcome;
  reason: string;
  structuredExecution?: ExecutionPublicationSnapshot;
}): PipelinePublicationEnvelope {
  const partial: PipelinePublicationBodyInput = {
    schema: PIPELINE_PUBLICATION_SCHEMA,
    template: {
      name: input.outcome === "needs_human" ? "needs_human" : "terminal",
      version: PIPELINE_PUBLICATION_TEMPLATE_VERSION,
    },
    pipeline: {
      instance_id: input.instance.id,
      linear_issue_id: input.instance.linear_issue_id,
      id: input.instance.pipeline_id,
      version: input.instance.pipeline_version,
      manifest_digest: input.instance.manifest_digest,
      generation: input.instance.generation,
    },
    stage: input.attempt ? {
      id: input.attempt.stage_id,
      attempt_id: input.attempt.id,
      attempt_ordinal: input.attempt.attempt_ordinal,
      reentry_ordinal: input.attempt.reentry_ordinal,
      context_policy: input.attempt.native_context_policy,
    } : null,
    decision: {
      outcome: input.outcome,
      gate_result: "not_evaluated",
      assurance: "coordinator_verified",
      policy_digest: null,
      subject: input.instance.immutable_subject,
      next_status: input.outcome,
      wait_reason: boundedPublicationLine(input.reason, 1_000),
    },
    evidence: {
      artifact_hashes: [],
      summaries: [boundedPublicationLine(input.reason, 1_000)],
      details: [],
      findings: [],
      actions: [],
      uncertainty: [],
    },
    links: githubLinks(input.instance, input.instance.immutable_subject),
    ...(input.structuredExecution ? { structured_execution: input.structuredExecution } : {}),
    resume_status: null,
  };
  return {
    ...partial,
    body: renderBody(partial, input.instance.normalized_manifest, {
      publishedCommit: input.instance.published_commit,
    }),
  };
}

export function buildStagePublication(input: {
  instance: PipelineInstance;
  attempt: PipelineStageAttempt;
  event: PipelineCoordinatorEvent;
  write: CoordinatorTransitionWrite;
  gateReceipt?: CoordinatorGateReceiptWrite;
  resumeStatus?: PipelineInstanceStatus | null;
  /** Findings accumulated from the run's earlier publications. */
  priorFindings?: readonly PublicationFinding[];
  /** Latest non-repair stage that scheduled the active repair branch. */
  priorRepairSourceStageId?: string;
  structuredExecution?: ExecutionPublicationSnapshot;
}): PipelinePublicationEnvelope {
  const resumeStatus = input.resumeStatus ?? input.write.resumeStatus ?? null;
  const evidence = (input.event.artifacts ?? []).map((artifact) => safeEvidence(artifact.payload));
  const artifactPayload = canonicalJson((input.event.artifacts ?? []).map((artifact) => ({
    kind: artifact.kind,
    assurance: artifact.assurance,
    subject: artifact.subject ?? null,
    hash: artifact.hash,
    payload: scrubArtifactForPublication(JSON.parse(artifact.payload) as unknown),
  })));
  const artifactBytes = Buffer.byteLength(artifactPayload, "utf8");
  if (artifactBytes > ATTACHMENT_LIMIT_BYTES) throw new Error("publication evidence exceeds the private attachment limit");
  const subject = input.gateReceipt?.subject ?? input.event.subject ?? input.instance.immutable_subject;
  const assurance = input.event.artifacts?.[0]?.assurance ?? "coordinator_verified";
  const template = chooseTemplate(input.write, resumeStatus);
  const outcome = input.write.terminalOutcome ?? input.write.outcome;
  const actions = evidence.flatMap((item) => item.actions).slice(0, 50);
  const currentFindings = evidence.flatMap((item) => item.findings);
  const requestRepairSource = repairSourceStageIdFromRequestPayload(input.attempt.request_payload);
  const repairSourceStageId = requestRepairSource?.startsWith("repair_")
    ? input.priorRepairSourceStageId
    : requestRepairSource ?? input.priorRepairSourceStageId;
  const currentFindingsWithDisposition = findingsWithDisposition(
    currentFindings,
    actions,
    { outcome, template }
  );
  const findings = mergeRunFindings(
    input.priorFindings ?? [],
    currentFindingsWithDisposition,
    actions,
    repairedAtSubject({
      normalizedManifest: input.instance.normalized_manifest,
      repairSourceStageId,
      currentStageId: input.attempt.stage_id,
      outcome,
      expectedSubject: input.attempt.expected_subject,
      subject,
    })
  );
  const partial: PipelinePublicationBodyInput = {
    schema: PIPELINE_PUBLICATION_SCHEMA,
    template: { name: template, version: PIPELINE_PUBLICATION_TEMPLATE_VERSION },
    pipeline: {
      instance_id: input.instance.id,
      linear_issue_id: input.instance.linear_issue_id,
      id: input.instance.pipeline_id,
      version: input.instance.pipeline_version,
      manifest_digest: input.instance.manifest_digest,
      generation: input.instance.generation,
    },
    stage: {
      id: input.attempt.stage_id,
      attempt_id: input.attempt.id,
      attempt_ordinal: input.attempt.attempt_ordinal,
      reentry_ordinal: input.attempt.reentry_ordinal,
      context_policy: input.attempt.native_context_policy,
    },
    decision: {
      outcome,
      gate_result: input.gateReceipt?.result ?? "not_evaluated" as const,
      assurance,
      policy_digest: input.gateReceipt?.policyDigest ?? null,
      subject: subject ?? null,
      next_status: input.write.nextStatus,
      wait_reason: input.write.waitReason ?? null,
    },
    evidence: {
      artifact_hashes: (input.event.artifacts ?? []).map((artifact) => artifact.hash).sort(),
      summaries: evidence.flatMap((item) => item.summary ? [item.summary] : []).slice(0, 20),
      details: evidence.flatMap((item) => item.evidence).slice(0, 50),
      findings,
      actions,
      uncertainty: evidence.flatMap((item) => item.uncertainty).slice(0, 20),
    },
    links: githubLinks(input.instance, subject ?? null),
    ...(input.structuredExecution ? { structured_execution: input.structuredExecution } : {}),
    resume_status: resumeStatus,
  };
  const body = renderBody(partial, input.instance.normalized_manifest, {
    scheduledReentryOrdinal: input.write.nextAttempt?.reentryOrdinal,
    repairBannerFinding: currentFindingsWithDisposition
      .find((finding) => finding.disposition === "carried to repair"),
    repairSourceStageId,
    publishedCommit: input.instance.published_commit,
  });
  return artifactBytes <= INLINE_ARTIFACT_LIMIT_BYTES
    ? {
        ...partial,
        body,
        artifact_inline: boundedSanitized(artifactPayload, INLINE_ARTIFACT_LIMIT_BYTES)
          .replaceAll("`", "\\u0060"),
      }
    : {
        ...partial,
        body,
        attachment: {
          filename: `openthrottle-${input.instance.id}-${input.attempt.id}.json`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 180),
          contentType: "application/json",
          content: boundedSanitized(artifactPayload, ATTACHMENT_LIMIT_BYTES),
        },
      };
}

export function parsePipelinePublication(payload: string): PipelinePublicationEnvelope {
  const value = JSON.parse(payload) as PipelinePublicationEnvelope;
  if (value.schema !== PIPELINE_PUBLICATION_SCHEMA ||
      !SUPPORTED_PIPELINE_PUBLICATION_TEMPLATE_VERSIONS.has(value.template?.version)) {
    throw new Error("pipeline publication schema is unsupported");
  }
  if (!value.pipeline?.instance_id || !value.pipeline.linear_issue_id ||
      !value.body || !Array.isArray(value.evidence?.artifact_hashes) ||
      !Array.isArray(value.evidence?.summaries) || !Array.isArray(value.evidence?.details) ||
      !Array.isArray(value.evidence?.uncertainty)) {
    throw new Error("pipeline publication is incomplete");
  }
  if ((value.evidence.findings !== undefined && !Array.isArray(value.evidence.findings)) ||
      (value.evidence.actions !== undefined && !Array.isArray(value.evidence.actions))) {
    throw new Error("pipeline publication is incomplete");
  }
  if (canonicalJson(value) !== payload) throw new Error("pipeline publication is not canonical");
  if (sanitizeText(value.body) !== value.body || value.body.length > PUBLICATION_BODY_LIMIT) {
    throw new Error("pipeline publication body is unsafe");
  }
  if (value.attachment && (value.attachment.contentType !== "application/json" ||
      Buffer.byteLength(value.attachment.content, "utf8") > ATTACHMENT_LIMIT_BYTES ||
      sanitizeText(value.attachment.content) !== value.attachment.content)) {
    throw new Error("pipeline publication attachment is unsafe");
  }
  return value;
}

export function pipelinePublicationOutboxPayload(envelope: PipelinePublicationEnvelope): string {
  return JSON.stringify({
    type: "pipeline_receipt",
    publication: {
      body: envelope.body,
      artifactInline: envelope.artifact_inline,
      attachment: envelope.attachment,
    },
  });
}

export function pipelineStatusCommentMarker(linearIssueId: string): string {
  return `<!-- openthrottle:pipeline-status:${linearIssueId} -->`;
}

function statusBodyParts(envelope: PipelinePublicationEnvelope): {
  statusLines: string[];
  detailLines: string[];
} {
  const bodyLines = envelope.body.split("\n");
  const headerEnd = bodyLines.indexOf("");
  return {
    statusLines: bodyLines.slice(0, headerEnd < 0 ? undefined : headerEnd),
    detailLines: headerEnd < 0 ? [] : bodyLines.slice(headerEnd + 1),
  };
}

function linearStatusCommentLines(envelope: PipelinePublicationEnvelope, prUrl?: string | null): string[] {
  const { statusLines } = statusBodyParts(envelope);
  const rendered = [
    ...statusLines,
    ...(prUrl ? ["", `Pull request: ${prUrl}`] : []),
  ];
  return boundedSanitized(dedupeLines(rendered).join("\n"), PUBLICATION_BODY_LIMIT).split("\n");
}

export function renderLinearStatusComment(envelope: PipelinePublicationEnvelope, prUrl?: string | null): string {
  return linearStatusCommentLines(envelope, prUrl).join("\n");
}

export function pipelineStatusOutboxPayload(envelope: PipelinePublicationEnvelope): string {
  return JSON.stringify({
    type: "pipeline_status",
    publication: {
      body: renderLinearStatusComment(envelope),
    },
  });
}

export type PipelineIssueStateSignal = "started" | "review" | "completed";

export function issueStateSignalForPublication(
  envelope: PipelinePublicationEnvelope
): PipelineIssueStateSignal | undefined {
  if (envelope.template.name === "selection") return "started";
  if (envelope.template.name === "provider_wait") return "review";
  if (envelope.template.name === "terminal" && envelope.decision.outcome === "shipped") {
    return "completed";
  }
  return undefined;
}

export function publicationPayloadHash(envelope: PipelinePublicationEnvelope): string {
  return digestNormalized(canonicalJson(envelope));
}

export function renderGithubPipelineSummary(envelope: PipelinePublicationEnvelope, prUrl?: string | null): string {
  const { detailLines } = statusBodyParts(envelope);
  const lines = [
    `<!-- openthrottle:pipeline-summary:${envelope.pipeline.linear_issue_id} -->`,
    "## OpenThrottle pipeline summary",
    "",
    ...linearStatusCommentLines(envelope, prUrl),
    "",
    ...addressedFindingsLines(envelope),
    "",
    ...detailLines,
    "",
    "_This is a neutral supervisor evidence summary. It is not a code-review approval._",
  ];
  return boundedSanitized(dedupeLines(lines).join("\n"), 60_000);
}

export function renderPipelineLogHeader(status: {
  pipeline_id: string;
  pipeline_version: number;
  task_type: string;
  status: string;
  stage_id: string | null;
  attempt_ordinal: number | null;
  reentry_count: number;
  wait_reason: string | null;
  subject: string | null;
  published_commit: string | null;
  gate_result: string | null;
  context_policy: string | null;
  publication_state: string;
  publication_error: string | null;
  recovery_action: string | null;
  effect_state: string;
  effect_kind: string | null;
  effect_status: string | null;
  effect_attempts: number | null;
  effect_error: string | null;
}): string {
  return boundedSanitized([
    `[pipeline] ${status.pipeline_id}@${status.pipeline_version} task=${status.task_type} state=${status.status}`,
    `[pipeline] stage=${status.stage_id ?? "-"} attempt=${status.attempt_ordinal ?? "-"} reentry=${status.reentry_count}`,
    `[pipeline] subject=${status.subject ?? "-"} provider=${status.published_commit ?? "-"} gate=${status.gate_result ?? "-"} context=${status.context_policy ?? "-"}`,
    `[pipeline] publication=${status.publication_state} publication_error=${status.publication_error ?? "-"} recovery=${status.recovery_action ?? "-"}`,
    `[pipeline] effect=${status.effect_kind ?? "-"}:${status.effect_status ?? status.effect_state} attempts=${status.effect_attempts ?? "-"} effect_error=${status.effect_error ?? "-"} wait=${status.wait_reason ?? "-"}`,
  ].join("\n"), 4_000);
}
