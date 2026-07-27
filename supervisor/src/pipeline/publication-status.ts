import {
  PIPELINE_OUTCOMES,
  type PipelineManifest,
  type PipelineOutcome,
  type StageOutcome,
} from "./manifest.js";
import type { PipelineInstanceStatus } from "./store.js";
import { sanitizeText } from "../shared/sanitize.js";

const TERMINAL_STATUSES = new Set<string>(PIPELINE_OUTCOMES);

export interface PipelinePublicationStatusInput {
  template: {
    name: string;
  };
  stage: null | {
    id: string;
    attempt_ordinal: number;
    reentry_ordinal: number;
  };
  decision: {
    outcome: StageOutcome | PipelineOutcome | "selected";
    next_status: PipelineInstanceStatus;
    wait_reason: string | null;
  };
  resume_status: PipelineInstanceStatus | null;
}

export interface RenderExtras {
  scheduledReentryOrdinal?: number;
  hasRepairHistory?: boolean;
  enteredStageIds?: readonly string[];
}

interface RenderContext {
  manifest: PipelineManifest;
  stageIndex: number;
  transition: PipelineManifest["stages"][number]["transitions"][StageOutcome] | undefined;
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
  repair_semantic_review: { display: "repair code review", action: "reviewing repair changes" },
  review: { display: "code review", action: "reviewing changes" },
  semantic_review: { display: "code review", action: "reviewing changes" },
  simplification: { display: "simplifying", action: "simplifying changes" },
  test: { display: "testing" },
};

function boundedPublicationLine(value: string, max: number): string {
  return sanitizeText(value).slice(0, max)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/([\\`\[\]()<>])/g, "\\$1")
    .trim();
}

export function stageDisplayName(stageId: string): string {
  return STAGE_LABELS[stageId]?.display ?? stageId.replaceAll("_", " ");
}

function stageActionName(stageId: string): string {
  const label = STAGE_LABELS[stageId];
  return label?.action ?? label?.display ?? stageDisplayName(stageId);
}

export function displayStatusText(value: string, max: number): string {
  let line = boundedPublicationLine(value, max);
  for (const [stageId, label] of Object.entries(STAGE_LABELS)
    .filter(([stageId]) => stageId.includes("_"))
    .sort(([left], [right]) => right.length - left.length)) {
    line = line.replaceAll(stageId, label.display);
  }
  return line
    .replace(/\brepair semantic review\b/gi, "repair code review")
    .replace(/\bsemantic review\b/gi, "code review");
}

function stageById(manifest: PipelineManifest): Map<string, PipelineManifest["stages"][number]> {
  return new Map(manifest.stages.map((stage) => [stage.id, stage]));
}

function successPathStages(manifest: PipelineManifest): PipelineManifest["stages"] {
  const byId = stageById(manifest);
  const path: PipelineManifest["stages"] = [];
  const seen = new Set<string>();
  let stage = byId.get(manifest.entry_stage);
  while (stage && !seen.has(stage.id)) {
    path.push(stage);
    seen.add(stage.id);
    const next = stage.transitions.success?.to;
    stage = next ? byId.get(next) : undefined;
  }
  return path.length > 0 ? path : manifest.stages;
}

export function isRepairStage(stageId: string): boolean {
  return stageId.startsWith("repair_");
}

function shouldShowRepairStages(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  extras?: RenderExtras
): boolean {
  return Boolean(
    extras?.hasRepairHistory ||
    (envelope.stage && isRepairStage(envelope.stage.id)) ||
    (context.transition?.to && isRepairStage(context.transition.to))
  );
}

function isTerminalEnvelope(envelope: PipelinePublicationStatusInput): boolean {
  return envelope.template.name === "terminal" ||
    envelope.template.name === "needs_human" && envelope.decision.outcome === "needs_human" ||
    Boolean(envelope.resume_status && TERMINAL_STATUSES.has(envelope.resume_status));
}

function displayStages(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  extras?: RenderExtras
): PipelineManifest["stages"] {
  const path = successPathStages(context.manifest);
  if (!shouldShowRepairStages(envelope, context, extras)) return path;

  const pathIds = new Set(path.map((stage) => stage.id));
  const enteredStageIds = new Set(extras?.enteredStageIds ?? []);
  const allRepairStages = context.manifest.stages
    .filter((stage) => isRepairStage(stage.id) && !pathIds.has(stage.id));
  const repairStages = isTerminalEnvelope(envelope) && extras?.enteredStageIds
    ? allRepairStages.filter((stage) => enteredStageIds.has(stage.id))
    : allRepairStages;
  if (repairStages.length === 0) return path;

  const transitionTarget = context.transition?.to;
  const currentPathIndex = envelope.stage
    ? path.findIndex((stage) => stage.id === envelope.stage?.id)
    : -1;
  const enteredPathIndexes = [...enteredStageIds]
    .map((stageId) => path.findIndex((stage) => stage.id === stageId))
    .filter((index) => index >= 0);
  const latestEnteredPathIndex = Math.max(-1, ...enteredPathIndexes);
  const lastRepair = repairStages.at(-1)!;
  const rejoin = lastRepair.transitions.success?.to ?? lastRepair.transitions.no_change?.to;
  const rejoinIndex = rejoin ? path.findIndex((stage) => stage.id === rejoin) : -1;
  const insertAt = transitionTarget && isRepairStage(transitionTarget) && currentPathIndex >= 0
    ? currentPathIndex + 1
    : rejoinIndex >= 0
      ? rejoinIndex
      : latestEnteredPathIndex >= 0
        ? latestEnteredPathIndex + 1
        : path.length;
  return [
    ...path.slice(0, insertAt),
    ...repairStages,
    ...path.slice(insertAt),
  ];
}

function renderContext(envelope: PipelinePublicationStatusInput, normalizedManifest: string): RenderContext {
  const manifest = JSON.parse(normalizedManifest) as PipelineManifest;
  const stageIndex = envelope.stage
    ? manifest.stages.findIndex((stage) => stage.id === envelope.stage?.id)
    : -1;
  const stage = stageIndex >= 0 ? manifest.stages[stageIndex] : undefined;
  return {
    manifest,
    stageIndex,
    transition: stage?.transitions[envelope.decision.outcome as StageOutcome],
  };
}

function stagePosition(envelope: PipelinePublicationStatusInput, stages: PipelineManifest["stages"]): {
  ordinal: number;
  total: number;
  stage: string;
} {
  if (!envelope.stage) {
    return { ordinal: 0, total: stages.length, stage: envelope.template.name.replaceAll("_", " ") };
  }
  const displayIndex = stages.findIndex((stage) => stage.id === envelope.stage?.id);
  return {
    ordinal: displayIndex >= 0 ? displayIndex + 1 : envelope.stage.attempt_ordinal,
    total: stages.length,
    stage: envelope.stage.id,
  };
}

function nextStageName(envelope: PipelinePublicationStatusInput, context: RenderContext): string {
  if (context.transition?.to) return context.transition.to;
  if (envelope.stage) return envelope.stage.id;
  return context.manifest.entry_stage;
}

function activeChecklistIndex(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  stages: PipelineManifest["stages"]
): number {
  if (isTerminalEnvelope(envelope)) {
    return stages.length;
  }
  const next = nextStageName(envelope, context);
  const nextIndex = stages.findIndex((stage) => stage.id === next);
  if (nextIndex >= 0 && next !== envelope.stage?.id) return nextIndex;
  const currentIndex = envelope.stage ? stages.findIndex((stage) => stage.id === envelope.stage?.id) : -1;
  return currentIndex >= 0 ? currentIndex : 0;
}

function activeStagePosition(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  stages: PipelineManifest["stages"]
): {
  ordinal: number;
  total: number;
  stageId: string;
} {
  const activeIndex = activeChecklistIndex(envelope, context, stages);
  const total = stages.length;
  if (activeIndex >= 0 && activeIndex < total) {
    return { ordinal: activeIndex + 1, total, stageId: stages[activeIndex]!.id };
  }
  if (activeIndex >= total && total > 0) {
    return { ordinal: total, total, stageId: stages[total - 1]!.id };
  }
  const position = stagePosition(envelope, stages);
  return { ordinal: Math.min(position.ordinal, total), total, stageId: position.stage };
}

function terminalSentence(envelope: PipelinePublicationStatusInput): string {
  const reason = envelope.decision.wait_reason
    ? displayStatusText(envelope.decision.wait_reason, 1_000)
    : null;
  switch (envelope.decision.outcome) {
    case "shipped":
      return "The job shipped.";
    case "no_change":
      return "The job finished because no code change was needed; no pull request was created.";
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
      return "the run is finished.";
  }
}

function whoseMoveLine(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  stages: PipelineManifest["stages"]
): string {
  const waitReason = envelope.decision.wait_reason
    ? displayStatusText(envelope.decision.wait_reason, 1_000)
    : "the published receipt in this Linear session";
  const active = activeStagePosition(envelope, context, stages);
  const suffix = `(stage ${active.ordinal} of ${active.total}).`;
  if (envelope.decision.next_status === "waiting_human" || envelope.template.name === "needs_human") {
    return `**Your move: decision required — ${waitReason} ${suffix}**`;
  }
  if (envelope.decision.next_status === "waiting_provider" || envelope.template.name === "provider_wait") {
    return `**Your move: nothing — waiting on GitHub: ${waitReason} ${suffix}**`;
  }
  if (envelope.template.name === "terminal" ||
      envelope.decision.next_status === envelope.decision.outcome &&
      TERMINAL_STATUSES.has(envelope.decision.next_status)) {
    return `**Your move: nothing — this run is finished. ${terminalSentence(envelope)}**`;
  }
  return `**Your move: nothing — ${stageActionName(active.stageId)} ${suffix}**`;
}

function stageChecklistLines(
  envelope: PipelinePublicationStatusInput,
  context: RenderContext,
  stages: PipelineManifest["stages"]
): string[] {
  const activeIndex = activeChecklistIndex(envelope, context, stages);
  return stages.map((stage, index) => {
    if (index < activeIndex || activeIndex >= stages.length) {
      return `- [x] ${stageDisplayName(stage.id)}`;
    }
    if (index === activeIndex) {
      const wait = envelope.decision.wait_reason
        ? ` — ${displayStatusText(envelope.decision.wait_reason, 500)}`
        : "";
      return `→ **${stageDisplayName(stage.id)}** — in progress${wait}`;
    }
    return `- [ ] ${stageDisplayName(stage.id)}`;
  });
}

function terminalContextLines(envelope: PipelinePublicationStatusInput): string[] {
  if (!isTerminalEnvelope(envelope) || envelope.decision.outcome === "shipped") return [];
  const reason = envelope.decision.wait_reason
    ? displayStatusText(envelope.decision.wait_reason, 1_000)
    : terminalSentence(envelope);
  const ask = envelope.decision.outcome === "needs_human"
    ? "provide the requested decision or repair direction before the pipeline can continue"
    : "no decision is pending; inspect the terminal evidence before starting a new run";
  return [
    `why: ${reason}`,
    `ask: ${ask}`,
  ];
}

export function renderStatusHeaderLines(
  envelope: PipelinePublicationStatusInput,
  normalizedManifest: string,
  extras?: RenderExtras
): string[] {
  const context = renderContext(envelope, normalizedManifest);
  const stages = displayStages(envelope, context, extras);
  return [
    whoseMoveLine(envelope, context, stages),
    ...terminalContextLines(envelope),
    ...stageChecklistLines(envelope, context, stages),
  ];
}
