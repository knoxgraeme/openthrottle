import type { SupervisorStore } from "../persistence/store.js";
import type { FeedbackSnapshot, FeedbackSnapshotEvent } from "../persistence/feedback-store.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import { processProviderEvidence, type Finding } from "../pipeline/gates.js";
import { canonicalJson, type PipelineManifest } from "../pipeline/manifest.js";

const UNBOUNDED_SNAPSHOT_CLAIM = Number.MAX_SAFE_INTEGER;
const DEFAULT_FEEDBACK_SNAPSHOT_DRAIN_SOURCE = "direct";
export type FeedbackSnapshotDrainSource =
  | typeof DEFAULT_FEEDBACK_SNAPSHOT_DRAIN_SOURCE
  | "periodic-feedback-drain"
  | "github-webhook";
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
// A mixed same-head snapshot must fail closed: evidence that demands action
// (a repair request, a failure, or a human-required event) outranks successful
// evidence, so a Linear reply or review cannot be silently dropped because a
// merge/close event joined the same snapshot first.
const PROVIDER_OUTCOME_PRIORITY: readonly PipelineProviderOutcome[] = [
  "failure",
  "needs_human",
  "semantic_repair_required",
  "success",
  "no_change",
];

export type PipelineProvider = "github" | "linear";

export type PipelineProviderOutcome = typeof PROVIDER_OUTCOMES[number];

interface StoredPipelineProviderEvent {
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  findings: ProviderFinding[];
  payload: string;
}

type ProviderFinding = Pick<Finding, "severity" | "code" | "summary">;
const PROVIDER_FINDING_SEVERITIES = new Set<Finding["severity"]>(["P0", "P1", "P2", "P3"]);

function boundedProviderPayload(payload: Record<string, unknown>): string {
  const serialized = sanitizeText(canonicalJson(payload));
  if (Buffer.byteLength(serialized, "utf8") <= 8_000) return serialized;
  try {
    const parsed = JSON.parse(serialized) as { failures?: unknown };
    if (Array.isArray(parsed.failures)) {
      parsed.failures = parsed.failures.slice(0, 3).map((failure) => {
        if (!failure || typeof failure !== "object" || Array.isArray(failure)) return failure;
        const record = failure as Record<string, unknown>;
        return {
          ...record,
          step_names: Array.isArray(record.step_names)
            ? record.step_names.filter((item) => typeof item === "string").slice(0, 3)
            : record.step_names,
          log_tail: typeof record.log_tail === "string" ? record.log_tail.slice(-1_000) : record.log_tail,
        };
      });
      const bounded = canonicalJson(parsed);
      if (Buffer.byteLength(bounded, "utf8") <= 8_000) return bounded;
    }
  } catch {
    // Fall back to the compact marker below.
  }
  return canonicalJson({ truncated: true });
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
  findings?: ProviderFinding[];
  payload: Record<string, unknown>;
  headSha: string;
  pullRequestUrl?: string;
}): FeedbackSnapshot {
  const stored = canonicalJson({
    outcome: params.outcome,
    summary: sanitizeText(params.summary).slice(0, 2_000),
    evidence: params.evidence.slice(0, 20).map((item) => sanitizeText(item).slice(0, 1_000)),
    findings: (params.findings ?? []).slice(0, 20).map((finding) => ({
      severity: finding.severity,
      code: sanitizeText(finding.code).slice(0, 80),
      summary: sanitizeText(finding.summary).slice(0, 1_000),
    })),
    payload: boundedProviderPayload(params.payload),
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
    findings?: unknown;
    payload?: unknown;
  };
  if (typeof parsed.outcome !== "string" || !PROVIDER_OUTCOME_SET.has(parsed.outcome) ||
      typeof parsed.summary !== "string" || !Array.isArray(parsed.evidence) ||
      parsed.evidence.some((item) => typeof item !== "string") ||
      !validProviderFindings(parsed.findings) || typeof parsed.payload !== "string") {
    throw new Error(`pipeline provider event ${event.provider}:${event.provider_event_id} is malformed`);
  }
  return { ...parsed, findings: parsed.findings ?? [] } as StoredPipelineProviderEvent;
}

function isProviderFinding(item: unknown): item is Record<"severity" | "code" | "summary", string> {
  return typeof item === "object" && item !== null &&
    PROVIDER_FINDING_SEVERITIES.has((item as Record<string, unknown>).severity as Finding["severity"]) &&
    typeof (item as Record<string, unknown>).code === "string" &&
    typeof (item as Record<string, unknown>).summary === "string";
}

function validProviderFindings(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isProviderFinding));
}

function providerFindings(payload: string): ProviderFinding[] {
  try {
    const parsed = JSON.parse(payload) as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) return [];
    return parsed.findings
      .filter(isProviderFinding)
      .slice(0, 20)
      .map((item) => ({
        severity: item.severity as Finding["severity"],
        code: item.code.slice(0, 80),
        summary: item.summary.slice(0, 1_000),
      }));
  } catch {
    return [];
  }
}

function publicationSubject(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { decision?: { subject?: unknown } };
    return typeof parsed.decision?.subject === "string" ? parsed.decision.subject : undefined;
  } catch {
    return undefined;
  }
}

function snapshotCanCarryForward(
  acknowledgedPublicationSubjects: ReadonlySet<string>,
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  return snapshot.linear_issue_id === instance.linear_issue_id &&
    snapshot.linear_session_id === instance.linear_session_id &&
    snapshot.generation === instance.generation &&
    snapshot.work_item_id?.startsWith(`pipeline-feedback:${instance.id}:`) === true &&
    instance.published_commit !== null &&
    snapshot.head_sha !== instance.published_commit &&
    !snapshot.head_sha.startsWith("conversation:") &&
    acknowledgedPublicationSubjects.has(snapshot.head_sha);
}

function acknowledgedPublicationSubjects(pipelines: PipelineStore, instanceId: string): ReadonlySet<string> {
  return new Set(pipelines.listPublications(instanceId)
    .filter((publication) => publication.status === "acknowledged")
    .map((publication) => publicationSubject(publication.payload))
    .filter((subject): subject is string => subject !== undefined));
}

function staleFeedbackNotice(params: {
  sessionId: string;
  eventCount: number;
}): string {
  const count = Math.max(1, params.eventCount);
  return JSON.stringify({
    type: "activity",
    activity: {
      sessionId: params.sessionId,
      type: "error",
      body: `${count} feedback item(s) arrived against a superseded head and were not applied; re-comment on the current PR head.`,
    },
  });
}

function markStaleFeedbackWithNotice(params: {
  store: SupervisorStore;
  instance: PipelineInstance;
  snapshot: FeedbackSnapshot;
  eventCount: number;
}): void {
  params.store.markFeedbackSnapshotStaleWithNotice({
    snapshotId: params.snapshot.id,
    noticeId: `feedback-snapshot-stale:${params.snapshot.id}`,
    payload: staleFeedbackNotice({
      sessionId: params.instance.linear_session_id,
      eventCount: params.eventCount,
    }),
  });
}

export function processPipelineFeedbackSnapshot(params: {
  pipelines: PipelineStore;
  store: SupervisorStore;
  instance: PipelineInstance;
  snapshot: FeedbackSnapshot;
  acknowledgedPublicationSubjects?: ReadonlySet<string>;
  drainSource?: FeedbackSnapshotDrainSource;
}): boolean {
  const subjects = params.acknowledgedPublicationSubjects ??
    acknowledgedPublicationSubjects(params.pipelines, params.instance.id);
  const currentSnapshot = snapshotCanCarryForward(subjects, params.snapshot, params.instance)
    ? params.store.carryForwardFeedbackSnapshot(
      params.snapshot.id,
      params.instance.published_commit!,
      `pipeline-feedback:${params.instance.id}:${params.instance.published_commit}`
    ) ?? params.snapshot
    : params.snapshot;
  const claim = params.store.claimFeedbackSnapshot(currentSnapshot.id, UNBOUNDED_SNAPSHOT_CLAIM);
  if (claim.status !== "claimed") {
    if (claim.status === "stale") {
      markStaleFeedbackWithNotice({
        store: params.store,
        instance: params.instance,
        snapshot: claim.snapshot ?? currentSnapshot,
        eventCount: claim.eventCount ?? 0,
      });
    }
    return false;
  }
  const events = claim.events.map((event) => ({ event, parsed: parseStoredPipelineEvent(event) }));
  const revisionMatches = params.instance.published_commit !== null &&
    claim.snapshot.head_sha === params.instance.published_commit;
  const outcomes = new Set(events.map(({ parsed }) => parsed.outcome));
  const outcome: PipelineProviderOutcome = revisionMatches
    ? PROVIDER_OUTCOME_PRIORITY.find((candidate) => outcomes.has(candidate))!
    : "needs_human";
  const drainedAt = new Date().toISOString();
  params.store.setSetting(`feedback-snapshot-drained-at:${claim.snapshot.id}`, drainedAt);
  params.store.setSetting(
    `feedback-snapshot-drain-source:${claim.snapshot.id}`,
    params.drainSource ?? DEFAULT_FEEDBACK_SNAPSHOT_DRAIN_SOURCE
  );
  processProviderEvidence(params.pipelines, {
    id: `provider-feedback-snapshot:${claim.snapshot.id}`,
    instanceId: params.instance.id,
    outcome,
    summary: revisionMatches
      ? `Immutable provider snapshot contains ${events.length} event(s) for the published commit.`
      : "The current provider head does not match the executor-verified published commit.",
    evidence: events.flatMap(({ parsed }) => parsed.evidence).slice(0, 50),
    findings: events.flatMap(({ parsed }) => parsed.findings.length > 0
      ? parsed.findings
      : providerFindings(parsed.payload)
    ).slice(0, 50),
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
    const publicationSubjects = acknowledgedPublicationSubjects(pipelines, instance.id);
    for (const snapshot of store.listPendingFeedbackSnapshots(instance.linear_session_id, limit)) {
      if (processPipelineFeedbackSnapshot({
        pipelines,
        store,
        instance,
        snapshot,
        acknowledgedPublicationSubjects: publicationSubjects,
        drainSource: "periodic-feedback-drain",
      })) {
        processed += 1;
        break;
      }
    }
  }
  return processed;
}
