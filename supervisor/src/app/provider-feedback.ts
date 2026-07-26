import type { SupervisorStore } from "../persistence/store.js";
import type { FeedbackSnapshot, FeedbackSnapshotEvent } from "../persistence/feedback-store.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import { processProviderEvidence } from "../pipeline/gates.js";
import { canonicalJson, type PipelineManifest } from "../pipeline/manifest.js";

const UNBOUNDED_SNAPSHOT_CLAIM = Number.MAX_SAFE_INTEGER;
const TERMINAL_PIPELINE_STATUSES = new Set([
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
]);
const PROVIDER_OUTCOMES = [
  "success",
  "no_change",
  "semantic_repair_required",
  "needs_human",
  "failure",
] as const;
const PROVIDER_OUTCOME_SET = new Set<string>(PROVIDER_OUTCOMES);
const PROVIDER_OUTCOME_PRIORITY: readonly PipelineProviderOutcome[] = [
  "success",
  "no_change",
  "failure",
  "needs_human",
  "semantic_repair_required",
];

export type PipelineProvider = "github" | "linear";

export type PipelineProviderOutcome = typeof PROVIDER_OUTCOMES[number];

interface StoredPipelineProviderEvent {
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  payload: string;
}

export function providerStageCanReceive(
  pipelines: PipelineStore,
  instance: PipelineInstance
): boolean {
  if (!["completion_pending_publication", "publication_blocked", "waiting_provider"].includes(instance.status)) {
    return false;
  }
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const activeStage = manifest.stages.find((stage) => stage.id === instance.active_stage_id);
  const activeAttempt = pipelines.getActiveAttempt(instance.id);
  return activeStage?.executor.kind === "provider_wait" && activeAttempt?.stage_id === activeStage.id;
}

export function pipelineIsTerminal(instance: PipelineInstance): boolean {
  return instance.terminal_outcome != null || TERMINAL_PIPELINE_STATUSES.has(instance.status);
}

function pullNumber(
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>,
  url?: string
): number {
  return Number((url ?? ticket.pr_url)?.match(/\/pull\/(\d+)$/)?.[1] ?? 0);
}

export function recordPipelineProviderEvent(params: {
  store: SupervisorStore;
  instance: PipelineInstance;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
  provider: PipelineProvider;
  eventId: string;
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  payload: Record<string, unknown>;
  headSha: string;
  pullRequestUrl?: string;
}): FeedbackSnapshot {
  const stored = canonicalJson({
    outcome: params.outcome,
    summary: sanitizeText(params.summary).slice(0, 2_000),
    evidence: params.evidence.slice(0, 20).map((item) => sanitizeText(item).slice(0, 1_000)),
    payload: sanitizeText(canonicalJson(params.payload)).slice(0, 8_000),
  } satisfies StoredPipelineProviderEvent);
  return params.store.recordProviderFeedback({
    provider: params.provider,
    providerEventId: params.eventId,
    issueId: params.instance.linear_issue_id,
    sessionId: params.instance.linear_session_id,
    generation: params.instance.generation,
    repository: params.instance.repository,
    pullNumber: pullNumber(params.ticket, params.pullRequestUrl),
    headSha: params.headSha,
    kind: "pipeline_provider_event",
    payload: stored,
    workItemId: `pipeline-feedback:${params.instance.id}:${params.headSha}`,
  }).snapshot;
}

function parseStoredPipelineEvent(event: FeedbackSnapshotEvent): StoredPipelineProviderEvent {
  const parsed = JSON.parse(event.payload) as {
    outcome?: unknown;
    summary?: unknown;
    evidence?: unknown;
    payload?: unknown;
  };
  if (typeof parsed.outcome !== "string" || !PROVIDER_OUTCOME_SET.has(parsed.outcome) ||
      typeof parsed.summary !== "string" || !Array.isArray(parsed.evidence) ||
      parsed.evidence.some((item) => typeof item !== "string") || typeof parsed.payload !== "string") {
    throw new Error(`pipeline provider event ${event.provider}:${event.provider_event_id} is malformed`);
  }
  return parsed as StoredPipelineProviderEvent;
}

export function processPipelineFeedbackSnapshot(params: {
  pipelines: PipelineStore;
  store: SupervisorStore;
  instance: PipelineInstance;
  snapshot: FeedbackSnapshot;
}): boolean {
  const claim = params.store.claimFeedbackSnapshot(params.snapshot.id, UNBOUNDED_SNAPSHOT_CLAIM);
  if (claim.status !== "claimed") return false;
  const events = claim.events.map((event) => ({ event, parsed: parseStoredPipelineEvent(event) }));
  const revisionMatches = params.instance.published_commit !== null &&
    claim.snapshot.head_sha === params.instance.published_commit;
  const outcomes = new Set(events.map(({ parsed }) => parsed.outcome));
  const outcome: PipelineProviderOutcome = revisionMatches
    ? PROVIDER_OUTCOME_PRIORITY.find((candidate) => outcomes.has(candidate))!
    : "needs_human";
  processProviderEvidence(params.pipelines, {
    id: `provider-feedback-snapshot:${claim.snapshot.id}`,
    instanceId: params.instance.id,
    outcome,
    summary: revisionMatches
      ? `Immutable provider snapshot contains ${events.length} event(s) for the published commit.`
      : "The current provider head does not match the executor-verified published commit.",
    evidence: events.flatMap(({ parsed }) => parsed.evidence).slice(0, 50),
    providerPayload: {
      snapshot_id: claim.snapshot.id,
      repair_round: claim.snapshot.repair_round,
      expected_published_commit: params.instance.published_commit,
      observed_head_sha: claim.snapshot.head_sha,
      events: events.map(({ event, parsed }) => ({
        provider: event.provider,
        provider_event_id: event.provider_event_id,
        summary: parsed.summary,
        payload: parsed.payload,
      })),
    },
  });
  params.store.consumeFeedbackSnapshot(claim.snapshot.id);
  return true;
}

export function drainPipelineFeedbackSnapshots(
  pipelines: PipelineStore,
  store: SupervisorStore,
  limit = 50
): number {
  let processed = 0;
  for (const instance of pipelines.listProviderReadyInstances(limit)) {
    if (!providerStageCanReceive(pipelines, instance)) continue;
    for (const snapshot of store.listPendingFeedbackSnapshots(instance.linear_session_id, limit)) {
      if (processPipelineFeedbackSnapshot({ pipelines, store, instance, snapshot })) {
        processed += 1;
        break;
      }
    }
  }
  return processed;
}
