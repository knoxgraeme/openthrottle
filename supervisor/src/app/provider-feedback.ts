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
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PIPELINE_FEEDBACK_WORK_ITEM_PREFIX = "pipeline-feedback:";

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
const BLOCKING_PROVIDER_FINDING_SEVERITIES = new Set<Finding["severity"]>(["P0", "P1"]);

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

function pipelineFeedbackWorkItemId(instanceId: string, headSha: string): string {
  return `${PIPELINE_FEEDBACK_WORK_ITEM_PREFIX}${instanceId}:${headSha}`;
}

function pipelineFeedbackWorkItemBelongsToInstance(workItemId: string | null, instanceId: string): boolean {
  return workItemId?.startsWith(`${PIPELINE_FEEDBACK_WORK_ITEM_PREFIX}${instanceId}:`) === true;
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
    issueId: params.instance.ticket_id,
    sessionId: params.instance.session_id,
    generation: params.instance.generation,
    repository: params.instance.repository,
    pullNumber: pullNumber(params.ticket, params.pullRequestUrl),
    headSha: params.headSha,
    kind: "pipeline_provider_event",
    payload: stored,
    workItemId: pipelineFeedbackWorkItemId(params.instance.id, params.headSha),
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

function hasBlockingProviderFinding(findings: readonly ProviderFinding[]): boolean {
  return findings.some((finding) => BLOCKING_PROVIDER_FINDING_SEVERITIES.has(finding.severity));
}

function repairOutcomeForFindings(
  outcome: PipelineProviderOutcome,
  findings: readonly ProviderFinding[]
): PipelineProviderOutcome {
  return outcome === "semantic_repair_required" &&
    findings.length > 0 &&
    !hasBlockingProviderFinding(findings)
    ? "success"
    : outcome;
}

function snapshotProviderOutcome(input: {
  revisionMatches: boolean;
  events: ReadonlyArray<{
    outcome: PipelineProviderOutcome;
    findings: readonly ProviderFinding[];
  }>;
}): PipelineProviderOutcome {
  if (!input.revisionMatches) return "needs_human";
  const outcomes = new Set(input.events.map((event) =>
    repairOutcomeForFindings(event.outcome, event.findings)
  ));
  return PROVIDER_OUTCOME_PRIORITY.find((candidate) => outcomes.has(candidate)) ?? "success";
}

function isGithubSynchronizeHeadChange(event: FeedbackSnapshotEvent, parsed: StoredPipelineProviderEvent): boolean {
  if (event.provider !== "github" || parsed.outcome !== "needs_human") return false;
  try {
    const payload = JSON.parse(parsed.payload) as { kind?: unknown; action?: unknown };
    return payload.kind === "pull_request" && payload.action === "synchronize";
  } catch {
    return false;
  }
}

function commitString(value: unknown): string | undefined {
  return typeof value === "string" && GIT_COMMIT.test(value) ? value : undefined;
}

function providerRevisionsFromArtifacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [];
    const payload = (artifact as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const details = (payload as { details?: unknown }).details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return [];
    return [
      commitString((details as { published_commit?: unknown }).published_commit),
      commitString((details as { provider_revision?: unknown }).provider_revision),
    ].filter((subject): subject is string => subject !== undefined);
  });
}

function publicationProviderHeads(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as {
      artifact_inline?: unknown;
      attachment?: { content?: unknown };
    };
    const subjects = new Set<string>();
    for (const artifacts of [parsed.artifact_inline, parsed.attachment?.content]) {
      if (typeof artifacts !== "string") continue;
      try {
        for (const revision of providerRevisionsFromArtifacts(JSON.parse(artifacts) as unknown)) {
          subjects.add(revision);
        }
      } catch {
        // Older or malformed publication payloads simply cannot prove provider heads.
      }
    }
    return [...subjects];
  } catch {
    return [];
  }
}

export function acknowledgedPublicationHeadAt(
  pipelines: PipelineStore,
  instance: PipelineInstance,
  observedAt: string | undefined
): string | undefined {
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (Number.isNaN(observedAtMs)) return undefined;
  return pipelines.listPublications(instance.id)
    .filter((publication) => publication.status !== "dead")
    .map((publication) => ({
      atMs: Date.parse(publication.created_at),
      publication,
    }))
    .filter(({ atMs }) => !Number.isNaN(atMs) && atMs < observedAtMs)
    .sort((left, right) =>
      right.atMs - left.atMs || right.publication.id.localeCompare(left.publication.id)
    )
    .flatMap(({ publication }) => publicationProviderHeads(publication.payload))
    .at(0);
}

function snapshotBelongsToInstance(
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  return snapshot.ticket_id === instance.ticket_id &&
    snapshot.session_id === instance.session_id &&
    snapshot.generation === instance.generation &&
    pipelineFeedbackWorkItemBelongsToInstance(snapshot.work_item_id, instance.id);
}

function snapshotCouldCarryForward(
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  return snapshotBelongsToInstance(snapshot, instance) &&
    instance.published_commit !== null &&
    snapshot.head_sha !== instance.published_commit &&
    !snapshot.head_sha.startsWith("conversation:");
}

function snapshotCanCarryForward(
  acknowledgedPublicationSubjects: ReadonlySet<string>,
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  return snapshotCouldCarryForward(snapshot, instance) &&
    acknowledgedPublicationSubjects.has(snapshot.head_sha);
}

function acknowledgedPublicationSubjects(pipelines: PipelineStore, instanceId: string): ReadonlySet<string> {
  return new Set(pipelines.listPublications(instanceId)
    .filter((publication) => publication.status === "acknowledged")
    .flatMap((publication) => publicationProviderHeads(publication.payload)));
}

function currentPublicationAcknowledgedAt(pipelines: PipelineStore, instance: PipelineInstance): string | undefined {
  if (instance.published_commit === null) return undefined;
  return pipelines.listPublications(instance.id)
    .filter((publication) =>
      publication.status === "acknowledged" &&
      publicationProviderHeads(publication.payload).includes(instance.published_commit!)
    )
    .map((publication) => publication.acknowledged_at ?? publication.created_at)
    .sort()
    .at(-1);
}

function currentPublicationRecorded(pipelines: PipelineStore, instance: PipelineInstance): boolean {
  if (instance.published_commit === null) return false;
  return pipelines.listPublications(instance.id)
    .some((publication) =>
      publication.status !== "dead" &&
      publicationProviderHeads(publication.payload).includes(instance.published_commit!)
    );
}

function snapshotFeedbackPredatesCurrentPublication(
  pipelines: PipelineStore,
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  const acknowledgedAt = currentPublicationAcknowledgedAt(pipelines, instance);
  return acknowledgedAt !== undefined && snapshot.provider_watermark < acknowledgedAt;
}

function currentRepairReentryStartedAt(pipelines: PipelineStore, instance: PipelineInstance): string | undefined {
  if (instance.reentry_count <= 0) return undefined;
  return pipelines.listAttempts(instance.id)
    .filter((attempt) => attempt.reentry_ordinal === instance.reentry_count)
    .map((attempt) => attempt.created_at)
    .sort()
    .at(0);
}

function currentProviderRepairLineageStartedAt(
  pipelines: PipelineStore,
  instance: PipelineInstance
): string | undefined {
  if (instance.reentry_count <= 0) return undefined;
  const attempts = pipelines.listAttempts(instance.id);
  const currentProviderAttemptIndex = attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) =>
      attempt.stage_id === "provider" &&
      attempt.reentry_ordinal <= instance.reentry_count
    )
    .at(-1)?.index;
  if (currentProviderAttemptIndex === undefined) {
    return currentRepairReentryStartedAt(pipelines, instance);
  }
  // A command/test failure can create nested repair reentries before the
  // current provider wait. The stale-evidence cutoff is the first repair pass
  // after the previous provider wait, not the latest nested reentry.
  const previousProviderAttemptIndex = attempts
    .slice(0, currentProviderAttemptIndex)
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => attempt.stage_id === "provider")
    .at(-1)?.index ?? -1;
  const startedAt = attempts
    .slice(previousProviderAttemptIndex + 1, currentProviderAttemptIndex)
    .filter((attempt) =>
      attempt.stage_id === "repair_implementation" &&
      attempt.reentry_ordinal > 0 &&
      attempt.reentry_ordinal <= instance.reentry_count
    )
    .map((attempt) => attempt.created_at)
    .sort()
    .at(0);
  return startedAt ?? currentRepairReentryStartedAt(pipelines, instance);
}

function snapshotFeedbackPredatesCurrentProviderRepairLineage(
  pipelines: PipelineStore,
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  const repairStartedAt = currentProviderRepairLineageStartedAt(pipelines, instance);
  return repairStartedAt !== undefined && snapshot.provider_watermark < repairStartedAt;
}

function snapshotCompletedRepairBeforeCurrentPublication(
  pipelines: PipelineStore,
  acknowledgedPublicationSubjects: ReadonlySet<string>,
  snapshot: FeedbackSnapshot,
  instance: PipelineInstance
): boolean {
  const providerSnapshot = pipelines.getInboxEvent(`provider-feedback-snapshot:${snapshot.id}`);
  return snapshot.status === "claimed" &&
    snapshot.repair_round !== null &&
    instance.reentry_count >= snapshot.repair_round &&
    providerSnapshot?.pipeline_instance_id === instance.id &&
    providerSnapshot.generation === instance.generation &&
    providerSnapshot.kind === "provider_snapshot" &&
    providerSnapshot.status === "consumed" &&
    snapshotCanCarryForward(acknowledgedPublicationSubjects, snapshot, instance) &&
    snapshotFeedbackPredatesCurrentPublication(pipelines, snapshot, instance);
}

function staleFeedbackNotice(params: {
  sessionId: string;
  eventCount: number;
  eventIds: string[];
  reviewedHead: string;
  currentPublishedHead: string | null;
  classification: "superseded_head";
}): string {
  const count = Math.max(1, params.eventCount);
  const eventIds = params.eventIds.length > 0
    ? params.eventIds.slice(0, 3).map((eventId) => sanitizeText(eventId).slice(0, 120)).join(",")
    : "unknown";
  const reviewedHead = sanitizeText(params.reviewedHead).slice(0, 120);
  const currentHead = sanitizeText(params.currentPublishedHead ?? "unknown").slice(0, 120);
  return JSON.stringify({
    type: "activity",
    activity: {
      sessionId: params.sessionId,
      type: "error",
      body: `${count} feedback item(s) arrived against a superseded head and were not applied; classification=${params.classification}; event_ids=${eventIds}; reviewed_head=${reviewedHead}; current_published_head=${currentHead}; re-comment on the current PR head.`,
    },
  });
}

function markStaleFeedbackWithNotice(params: {
  store: SupervisorStore;
  instance: PipelineInstance;
  snapshot: FeedbackSnapshot;
  eventCount: number;
}): void {
  const events = params.store.listFeedbackSnapshotEvents(params.snapshot.id);
  params.store.markFeedbackSnapshotStaleWithNotice({
    snapshotId: params.snapshot.id,
    noticeId: `feedback-snapshot-stale:${params.snapshot.id}`,
    payload: staleFeedbackNotice({
      sessionId: params.instance.session_id,
      eventCount: params.eventCount,
      eventIds: events.map((event) => `${event.provider}:${event.provider_event_id}`),
      reviewedHead: params.snapshot.observed_head_sha ?? params.snapshot.head_sha,
      currentPublishedHead: params.instance.published_commit,
      classification: "superseded_head",
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
  const canCheckCarryForward = snapshotCouldCarryForward(params.snapshot, params.instance);
  const subjects = canCheckCarryForward
    ? params.acknowledgedPublicationSubjects ?? acknowledgedPublicationSubjects(params.pipelines, params.instance.id)
    : undefined;
  if (subjects && snapshotCompletedRepairBeforeCurrentPublication(
    params.pipelines,
    subjects,
    params.snapshot,
    params.instance
  )) {
    params.store.consumeFeedbackSnapshot(params.snapshot.id);
    return false;
  }
  // Feedback observed before the current repair reentry began may still be the
  // causal request for this republish. Later old-head feedback is not causal for
  // the repaired head even if publication acknowledgement has not happened yet.
  const canCarryPastFirstRepair = params.instance.reentry_count === 0 ||
    snapshotFeedbackPredatesCurrentProviderRepairLineage(params.pipelines, params.snapshot, params.instance);
  const currentSnapshot = subjects && snapshotCanCarryForward(subjects, params.snapshot, params.instance)
    && canCarryPastFirstRepair
    ? params.store.carryForwardFeedbackSnapshot(
      params.snapshot.id,
      params.instance.published_commit!,
      pipelineFeedbackWorkItemId(params.instance.id, params.instance.published_commit!)
    ) ?? params.snapshot
    : params.snapshot;
  if (!snapshotBelongsToInstance(currentSnapshot, params.instance)) {
    markStaleFeedbackWithNotice({
      store: params.store,
      instance: params.instance,
      snapshot: currentSnapshot,
      eventCount: 1,
    });
    return false;
  }
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
  const neutralSelfSynchronizeRace = revisionMatches &&
    currentPublicationRecorded(params.pipelines, params.instance);
  const eventsWithFindings = events.map(({ event, parsed }) => ({
    event,
    parsed,
    findings: parsed.findings.length > 0
      ? parsed.findings
      : providerFindings(parsed.payload),
  }));
  const decisionEvents = eventsWithFindings.filter(({ event, parsed }) =>
    !neutralSelfSynchronizeRace || !isGithubSynchronizeHeadChange(event, parsed)
  );
  const drainedAt = new Date().toISOString();
  params.store.setSetting(`feedback-snapshot-drained-at:${claim.snapshot.id}`, drainedAt);
  params.store.setSetting(
    `feedback-snapshot-drain-source:${claim.snapshot.id}`,
    params.drainSource ?? DEFAULT_FEEDBACK_SNAPSHOT_DRAIN_SOURCE
  );
  if (decisionEvents.length === 0) {
    params.store.consumeFeedbackSnapshot(claim.snapshot.id);
    return false;
  }
  const findings = eventsWithFindings.flatMap(({ findings }) =>
    findings
  );
  const outcome = snapshotProviderOutcome({
    revisionMatches,
    events: decisionEvents.map(({ parsed, findings }) => ({
      outcome: parsed.outcome,
      findings,
    })),
  });
  const artifactFindings = findings.slice(0, 50);
  processProviderEvidence(params.pipelines, {
    id: `provider-feedback-snapshot:${claim.snapshot.id}`,
    instanceId: params.instance.id,
    outcome,
    summary: revisionMatches
      ? `Immutable provider snapshot contains ${events.length} event(s) for the published commit.`
      : "The current provider head does not match the executor-verified published commit.",
    evidence: events.flatMap(({ parsed }) => parsed.evidence).slice(0, 50),
    findings: artifactFindings,
    providerPayload: {
      snapshot_id: claim.snapshot.id,
      repair_round: claim.snapshot.repair_round,
      expected_published_commit: params.instance.published_commit,
      // Seal against the head the evidence was actually observed against, not
      // the drainable head it was carried forward to; the latter would falsely
      // claim a superseded review was observed against the current subject.
      observed_head_sha: claim.snapshot.observed_head_sha ?? claim.snapshot.head_sha,
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
    const snapshots = store.listPendingFeedbackSnapshots(instance.session_id, limit);
    if (snapshots.length === 0) continue;
    const publicationSubjects = acknowledgedPublicationSubjects(pipelines, instance.id);
    for (const snapshot of snapshots) {
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
