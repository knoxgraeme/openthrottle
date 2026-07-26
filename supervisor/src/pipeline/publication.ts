import { createHash } from "node:crypto";
import {
  canonicalJson,
  digestNormalized,
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
    uncertainty: string[];
  };
  links: Array<{ label: string; url: string }>;
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
  uncertainty?: unknown;
}

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

function safeEvidence(raw: string): {
  summary?: string;
  evidence: string[];
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
      uncertainty: Array.isArray(value.uncertainty)
        ? value.uncertainty.filter((entry): entry is string => typeof entry === "string")
            .slice(0, 10).map((entry) => boundedPublicationLine(entry, 500))
        : [],
    };
  } catch {
    return { evidence: [], uncertainty: [] };
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
  stageIndex: number;
  transition: PipelineManifest["stages"][number]["transitions"][StageOutcome] | undefined;
}

interface RenderExtras {
  scheduledReentryOrdinal?: number;
}

function renderContext(envelope: PipelinePublicationBodyInput, normalizedManifest: string): RenderContext {
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

function stagePosition(envelope: PipelinePublicationBodyInput, context: RenderContext): {
  ordinal: number;
  total: number;
  stage: string;
} {
  const manifest = context.manifest;
  if (!envelope.stage) {
    return { ordinal: 0, total: manifest.stages.length, stage: envelope.template.name.replaceAll("_", " ") };
  }
  return {
    ordinal: context.stageIndex >= 0 ? context.stageIndex + 1 : envelope.stage.attempt_ordinal,
    total: manifest.stages.length,
    stage: envelope.stage.id,
  };
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
      return terminalSentence(envelope);
    case "provider_wait":
      return "The run is waiting for GitHub provider evidence.";
    case "terminal":
      return terminalSentence(envelope);
  }
}

function terminalSentence(envelope: PipelinePublicationBodyInput): string {
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
      return sentenceForOutcome(envelope.decision.outcome);
  }
}

function progressLine(envelope: PipelinePublicationBodyInput, context: RenderContext): string {
  const position = stagePosition(envelope, context);
  return `Stage ${position.ordinal} of ${position.total}: ${position.stage} — ${sentenceForOutcome(envelope.decision.outcome)}`;
}

function whoseMoveLine(envelope: PipelinePublicationBodyInput, context: RenderContext): string {
  const waitReason = envelope.decision.wait_reason
    ? boundedPublicationLine(envelope.decision.wait_reason, 1_000)
    : "the published receipt in this Linear session";
  if (envelope.decision.next_status === "waiting_human" || envelope.template.name === "needs_human") {
    return `Waiting on you: ${waitReason}.`;
  }
  if (envelope.decision.next_status === "waiting_provider" || envelope.template.name === "provider_wait") {
    return `Waiting on GitHub: ${waitReason}.`;
  }
  if (envelope.template.name === "terminal" ||
      envelope.decision.next_status === envelope.decision.outcome &&
      ["shipped", "no_change", "needs_human", "failed", "canceled", "superseded"].includes(envelope.decision.next_status)) {
    return `This run is finished: ${terminalSentence(envelope)}`;
  }
  return `Working — next receipt expected from the ${nextStageName(envelope, context)} stage.`;
}

function dedupeAdjacentLines(lines: string[]): string[] {
  return lines.filter((line, index) => line === "" || line !== lines[index - 1]);
}

function renderBody(
  envelope: PipelinePublicationBodyInput,
  normalizedManifest: string,
  extras?: RenderExtras
): string {
  const context = renderContext(envelope, normalizedManifest);
  const lines = [
    eventSentence(envelope, context, extras),
    progressLine(envelope, context),
  ];
  envelope.evidence.summaries.forEach((summary) => lines.push(summary));
  envelope.evidence.details.forEach((detail) => lines.push(detail));
  envelope.evidence.uncertainty.forEach((item) => lines.push(`Still uncertain: ${item}`));
  if (envelope.links.length > 0) {
    envelope.links.forEach((link) => lines.push(`- [${link.label}](${link.url})`));
  }
  lines.push(whoseMoveLine(envelope, context));
  return boundedSanitized(dedupeAdjacentLines(lines).join("\n"), PUBLICATION_BODY_LIMIT);
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
      uncertainty: [],
    },
    links: githubLinks(input.instance, input.instance.immutable_subject),
    resume_status: null,
  };
  return { ...partial, body: renderBody(partial, input.instance.normalized_manifest) };
}

export function buildStagePublication(input: {
  instance: PipelineInstance;
  attempt: PipelineStageAttempt;
  event: PipelineCoordinatorEvent;
  write: CoordinatorTransitionWrite;
  gateReceipt?: CoordinatorGateReceiptWrite;
  resumeStatus?: PipelineInstanceStatus | null;
}): PipelinePublicationEnvelope {
  const resumeStatus = input.resumeStatus ?? null;
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
  const partial: PipelinePublicationBodyInput = {
    schema: PIPELINE_PUBLICATION_SCHEMA,
    template: { name: chooseTemplate(input.write, resumeStatus), version: PIPELINE_PUBLICATION_TEMPLATE_VERSION },
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
      outcome: input.write.terminalOutcome ?? input.write.outcome,
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
      uncertainty: evidence.flatMap((item) => item.uncertainty).slice(0, 20),
    },
    links: githubLinks(input.instance, subject ?? null),
    resume_status: resumeStatus,
  };
  const body = renderBody(partial, input.instance.normalized_manifest, {
    scheduledReentryOrdinal: input.write.nextAttempt?.reentryOrdinal,
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

export function publicationPayloadHash(envelope: PipelinePublicationEnvelope): string {
  return digestNormalized(canonicalJson(envelope));
}

export function renderGithubPipelineSummary(envelope: PipelinePublicationEnvelope): string {
  return boundedSanitized([
    `<!-- openthrottle:pipeline-summary:${envelope.pipeline.linear_issue_id} -->`,
    "## OpenThrottle pipeline summary",
    "",
    envelope.body.replace(/^### /, "### Latest decision: "),
    "",
    "_This is a neutral supervisor evidence summary. It is not a code-review approval._",
  ].join("\n"), 60_000);
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
