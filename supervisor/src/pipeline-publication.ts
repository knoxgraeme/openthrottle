import { createHash } from "node:crypto";
import {
  canonicalJson,
  digestNormalized,
  type PipelineOutcome,
  type StageOutcome,
} from "./pipeline-manifest.js";
import type {
  CoordinatorGateReceiptWrite,
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineInstanceStatus,
  PipelinePublicationReceipt,
  PipelineStageAttempt,
  PipelineStore,
} from "./pipeline-store.js";
import type { PipelineCoordinatorEvent } from "./pipeline-coordinator.js";
import type { TicketStore } from "./db.js";
import type { GithubClient } from "./github.js";
import { parsePullRequestUrl, upsertPullRequestComment } from "./github.js";
import { sanitizeText } from "./sanitize.js";

export const PIPELINE_PUBLICATION_SCHEMA = "openthrottle.pipeline-publication/v1";
export const PIPELINE_PUBLICATION_TEMPLATE_VERSION = 1;
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
    ? [{ label: "Gated commit", url: `https://github.com/${instance.repository}/commit/${subject}` }]
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

function renderBody(envelope: PipelinePublicationBodyInput): string {
  const stage = envelope.stage;
  const lines = [
    `### OpenThrottle pipeline ${envelope.template.name.replaceAll("_", " ")}`,
    "",
    `- Pipeline: \`${envelope.pipeline.id}@${envelope.pipeline.version}\``,
    `- Instance: \`${envelope.pipeline.instance_id}\` (generation ${envelope.pipeline.generation})`,
    ...(stage ? [
      `- Stage: \`${stage.id}\``,
      `- Attempt: ${stage.attempt_ordinal} (re-entry ${stage.reentry_ordinal})`,
      `- Context policy: \`${stage.context_policy}\``,
    ] : []),
    `- Subject: ${envelope.decision.subject ? `\`${envelope.decision.subject}\`` : "not established"}`,
    `- Assurance: \`${envelope.decision.assurance}\``,
    `- Policy: ${envelope.decision.policy_digest ? `\`${envelope.decision.policy_digest}\`` : "not evaluated"}`,
    `- Result: \`${envelope.decision.gate_result}\` → \`${envelope.decision.outcome}\``,
    `- Coordinator state: \`${envelope.decision.next_status}\``,
  ];
  if (envelope.decision.wait_reason) lines.push(`- Wait reason: ${envelope.decision.wait_reason}`);
  lines.push("", "Evidence:");
  if (envelope.evidence.summaries.length === 0) lines.push("- No human-authored summary was accepted; hashes are retained below.");
  else envelope.evidence.summaries.forEach((summary) => lines.push(`- ${summary}`));
  envelope.evidence.details.forEach((detail) => lines.push(`- ${detail}`));
  envelope.evidence.artifact_hashes.forEach((hash) => lines.push(`- Artifact \`${hash}\``));
  lines.push("", "Residual uncertainty:");
  if (envelope.evidence.uncertainty.length === 0) lines.push("- None declared by the typed evidence.");
  else envelope.evidence.uncertainty.forEach((item) => lines.push(`- ${item}`));
  if (envelope.links.length > 0) {
    lines.push("", "Provider evidence:");
    envelope.links.forEach((link) => lines.push(`- [${link.label}](${link.url})`));
  }
  return boundedSanitized(lines.join("\n"), PUBLICATION_BODY_LIMIT);
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
  return { ...partial, body: renderBody(partial) };
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
  return { ...partial, body: renderBody(partial) };
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
  const body = renderBody(partial);
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
  if (value.schema !== PIPELINE_PUBLICATION_SCHEMA || value.template?.version !== PIPELINE_PUBLICATION_TEMPLATE_VERSION) {
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
  status: string;
  stage_id: string | null;
  attempt_ordinal: number | null;
  reentry_count: number;
  wait_reason: string | null;
  subject: string | null;
  gate_result: string | null;
  context_policy: string | null;
  publication_state: string;
}): string {
  return boundedSanitized([
    `[pipeline] ${status.pipeline_id}@${status.pipeline_version} state=${status.status}`,
    `[pipeline] stage=${status.stage_id ?? "-"} attempt=${status.attempt_ordinal ?? "-"} reentry=${status.reentry_count}`,
    `[pipeline] subject=${status.subject ?? "-"} gate=${status.gate_result ?? "-"} context=${status.context_policy ?? "-"}`,
    `[pipeline] publication=${status.publication_state} wait=${status.wait_reason ?? "-"}`,
  ].join("\n"), 4_000);
}

export interface GithubPublicationProcessor {
  process(id: string): Promise<void>;
  drain(limit?: number): Promise<void>;
}

function githubRetry(error: unknown): { retry: boolean; message: string } {
  const message = sanitizeText(String(error)).slice(-2_000);
  return {
    retry: !/unauthorized|forbidden|invalid|API error \((?:400|401|403|404|422)\)/i.test(message),
    message,
  };
}

function publicationRetryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 2 ** Math.max(0, attempts - 1) * 5_000);
}

export function createGithubPublicationProcessor(params: {
  store: PipelineStore;
  tickets: TicketStore;
  client: GithubClient;
  leaseMs?: number;
}): GithubPublicationProcessor {
  const leaseMs = params.leaseMs ?? 30_000;

  async function deliver(publication: PipelinePublicationReceipt): Promise<void> {
    const instance = params.store.getInstance(publication.pipeline_instance_id);
    if (!instance) throw new Error(`unknown pipeline instance ${publication.pipeline_instance_id}`);
    const ticket = params.tickets.getByIssueId(instance.linear_issue_id);
    if (!ticket?.pr_url) throw new Error("pipeline pull request is not available yet");
    const pull = parsePullRequestUrl(ticket.pr_url);
    if (pull.host !== "github.com" || pull.repo.toLowerCase() !== instance.repository.toLowerCase()) {
      throw new Error("invalid pipeline pull request binding for the pinned instance");
    }
    const envelope = parsePipelinePublication(publication.payload);
    const result = await upsertPullRequestComment(
      params.client,
      instance.repository,
      pull.number,
      instance.linear_issue_id,
      renderGithubPipelineSummary(envelope)
    );
    params.store.markGithubPublicationProcessed(
      publication.id,
      publication.payload_hash,
      String(result.id),
      result.html_url
    );
  }

  async function processRows(rows: PipelinePublicationReceipt[]): Promise<void> {
    for (const publication of rows) {
      try {
        await deliver(publication);
      } catch (error) {
        const classified = githubRetry(error);
        params.store.markGithubPublicationFailed(
          publication.id,
          publication.payload_hash,
          classified.message,
          classified.retry
            ? new Date(Date.now() + publicationRetryDelay(publication.attempts)).toISOString()
            : null
        );
      }
    }
  }

  return {
    async process(id) {
      const now = new Date();
      const rows = params.store.claimGithubPublications(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        50
      );
      if (!rows.some((row) => row.id === id)) return;
      await processRows(rows);
    },
    async drain(limit = 50) {
      const now = new Date();
      await processRows(params.store.claimGithubPublications(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        limit
      ));
    },
  };
}
