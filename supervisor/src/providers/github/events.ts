// GitHub feedback is committed as typed provider evidence for the generation-
// pinned pipeline. There is no automatic task-resume fallback.

import type { Config } from "../../app/config.js";
import type { SupervisorStore } from "../../persistence/store.js";
import {
  getAuthenticatedLogin,
  isOpenthrottleBranch,
  type GithubWebhookEvent,
} from "./client.js";
import type { ActivityPublicationPort } from "../../app/ports.js";
import { sanitizeText } from "../../shared/sanitize.js";
import type { FeedbackSnapshot, FeedbackSnapshotEvent } from "../../persistence/feedback-store.js";
import type { PipelineInstance, PipelineStore } from "../../pipeline/store.js";
import { processProviderEvidence } from "../../pipeline/gates.js";
import { canonicalJson, type PipelineManifest } from "../../pipeline/manifest.js";
import { requestPipelineStop } from "../../pipeline/control.js";

const githubLoginCache = new Map<string, string>();
const UNBOUNDED_SNAPSHOT_CLAIM = Number.MAX_SAFE_INTEGER;
const TERMINAL_PIPELINE_STATUSES = new Set([
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
]);
const PROVIDER_OUTCOME_PRIORITY: readonly PipelineProviderOutcome[] = [
  "success",
  "no_change",
  "failure",
  "needs_human",
  "semantic_repair_required",
];

type PipelineProviderOutcome =
  | "success"
  | "no_change"
  | "semantic_repair_required"
  | "needs_human"
  | "failure";

interface StoredPipelineProviderEvent {
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  payload: string;
}

function providerStageCanReceive(pipelines: PipelineStore, instance: PipelineInstance): boolean {
  if (!["completion_pending_publication", "publication_blocked", "waiting_provider"].includes(instance.status)) {
    return false;
  }
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const activeStage = manifest.stages.find((stage) => stage.id === instance.active_stage_id);
  const activeAttempt = pipelines.getActiveAttempt(instance.id);
  return activeStage?.executor.kind === "provider_wait" && activeAttempt?.stage_id === activeStage.id;
}

function pipelineIsTerminal(instance: PipelineInstance): boolean {
  return instance.terminal_outcome != null || TERMINAL_PIPELINE_STATUSES.has(instance.status);
}

function pullNumber(ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>, url?: string): number {
  return Number((url ?? ticket.pr_url)?.match(/\/pull\/(\d+)$/)?.[1] ?? 0);
}

function recordPipelineProviderEvent(params: {
  store: SupervisorStore;
  instance: PipelineInstance;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
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
    provider: "github",
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
  const parsed = JSON.parse(event.payload) as StoredPipelineProviderEvent;
  if (!["success", "no_change", "semantic_repair_required", "needs_human", "failure"].includes(parsed.outcome) ||
      typeof parsed.summary !== "string" || !Array.isArray(parsed.evidence) ||
      parsed.evidence.some((item) => typeof item !== "string") || typeof parsed.payload !== "string") {
    throw new Error(`pipeline provider event ${event.provider}:${event.provider_event_id} is malformed`);
  }
  return parsed;
}

function processPipelineFeedbackSnapshot(params: {
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
    id: `github-feedback-snapshot:${claim.snapshot.id}`,
    instanceId: params.instance.id,
    outcome,
    summary: revisionMatches
      ? `Immutable GitHub provider snapshot contains ${events.length} event(s) for the published commit.`
      : "GitHub's current pull-request head does not match the executor-verified published commit.",
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
    const [snapshot] = store.listPendingFeedbackSnapshots(instance.linear_session_id, 1);
    if (!snapshot) continue;
    if (processPipelineFeedbackSnapshot({ pipelines, store, instance, snapshot })) processed += 1;
  }
  return processed;
}

export function routePipelineProviderEvent(params: {
  pipelines: PipelineStore;
  store: SupervisorStore;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
  eventId: string;
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  payload: Record<string, unknown>;
  headSha: string | undefined;
  pullRequestUrl?: string;
}): boolean {
  const instance = params.pipelines.getInstanceForSession(params.ticket.linear_session_id);
  if (!instance) return false;
  if (params.pullRequestUrl && params.ticket.pr_url && params.pullRequestUrl !== params.ticket.pr_url) {
    return true;
  }
  if (pipelineIsTerminal(instance)) return true;
  const authoritativeHead = params.store.getSetting(`github-head:${params.ticket.linear_issue_id}`);
  if (params.headSha === undefined || params.headSha !== authoritativeHead) return true;
  const canReceive = providerStageCanReceive(params.pipelines, instance);
  const revisionMatches = instance.published_commit !== null && params.headSha === instance.published_commit;
  if (canReceive && !revisionMatches) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: "needs_human",
      summary: "GitHub's current pull-request head does not match the executor-verified published commit.",
      evidence: params.evidence,
      providerPayload: {
        ...params.payload,
        expected_published_commit: instance.published_commit,
        observed_head_sha: params.headSha,
      },
    });
    return true;
  }
  // A synchronize webhook for the exact commit sealed by the publish stage is
  // expected and carries no gate decision. Only drift from that revision (the
  // branch above) is a human-required safety event.
  if (params.outcome === "needs_human") return true;
  if (params.outcome === "semantic_repair_required" || !canReceive) {
    const snapshot = recordPipelineProviderEvent({
      store: params.store,
      instance,
      ticket: params.ticket,
      eventId: params.eventId,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      payload: params.payload,
      headSha: params.headSha,
      pullRequestUrl: params.pullRequestUrl,
    });
    if (canReceive) {
      processPipelineFeedbackSnapshot({ pipelines: params.pipelines, store: params.store, instance, snapshot });
    }
    return true;
  }
  if (canReceive) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      providerPayload: {
        ...params.payload,
        expected_published_commit: instance.published_commit,
        observed_head_sha: params.headSha,
      },
    });
  }
  return true;
}

function setAuthoritativeGithubHead(store: SupervisorStore, issueId: string, headSha: string): void {
  store.setSetting(`github-head:${issueId}`, headSha);
  store.setSetting(`github-head-source:${issueId}`, "authoritative");
}

export function considerCiGithubHead(
  store: SupervisorStore,
  issueId: string,
  headSha: string,
  source: "workflow_run" | "check_suite",
  sequence: number
): void {
  const headKey = `github-head:${issueId}`;
  const sourceKey = `github-head-source:${issueId}`;
  const watermarkKey = `github-head-watermark:${issueId}:${source}`;
  const currentHead = store.getSetting(headKey);
  const rawSource = store.getSetting(sourceKey);
  const priorSequence = Number(store.getSetting(watermarkKey));
  if (rawSource === "authoritative" ||
      (Number.isSafeInteger(priorSequence) && sequence <= priorSequence)) return;
  const canAdvance =
    !currentHead ||
    currentHead.startsWith("unknown:") ||
    currentHead === headSha ||
    rawSource !== "authoritative";
  if (!canAdvance) return;
  store.setSetting(watermarkKey, String(sequence));
  store.setSetting(headKey, headSha);
  store.setSetting(sourceKey, JSON.stringify({ source, sequence }));
}

async function selfGithubLogin(cfg: Config): Promise<string | undefined> {
  const cached = githubLoginCache.get(cfg.githubToken);
  if (cached) return cached;
  try {
    const login = await getAuthenticatedLogin({ token: cfg.githubToken });
    githubLoginCache.set(cfg.githubToken, login);
    return login;
  } catch (error) {
    console.error("[github] could not resolve the token account for self-feedback filtering:", error);
    return undefined;
  }
}

export async function handleGithubEvent(
  cfg: Config,
  store: SupervisorStore,
  activityPublisher: ActivityPublicationPort,
  event: GithubWebhookEvent,
  pipelines: PipelineStore
): Promise<void> {
  if (event.kind === "pull_request") {
    const branch = event.pull_request.head.ref;
    if (!isOpenthrottleBranch(branch)) return;
    const ticket = store.getByBranch(event.repository.full_name, branch);
    if (!ticket) return;
    const pipelineInstance = pipelines.getInstanceForSession(ticket.linear_session_id);
    if (!pipelineInstance) return;
    if (ticket.pr_url && ticket.pr_url !== event.pull_request.html_url) return;
    if (event.action === "opened" || event.action === "reopened" || event.action === "synchronize") {
      store.setPrUrl(ticket.linear_issue_id, event.pull_request.html_url);
      if (event.pull_request.head.sha) {
        setAuthoritativeGithubHead(store, ticket.linear_issue_id, event.pull_request.head.sha);
      }
    }
    if (event.action === "synchronize" && event.pull_request.head.sha) {
      routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: `github-pull-synchronize:${event.pull_request.number}:${event.pull_request.head.sha}`,
        outcome: "needs_human",
        summary: "The pull-request head changed after the pipeline entered provider wait.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "synchronize" },
        headSha: event.pull_request.head.sha,
        pullRequestUrl: event.pull_request.html_url,
      });
    }
    if (event.action === "closed") {
      const providerEventId =
        `github-pull-closed:${event.pull_request.number}:${event.pull_request.head.sha ?? "unknown"}`;
      if (event.pull_request.head.sha) {
        setAuthoritativeGithubHead(store, ticket.linear_issue_id, event.pull_request.head.sha);
      }
      store.setPrUrl(ticket.linear_issue_id, event.pull_request.html_url);
      const routedPipeline = routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: providerEventId,
        outcome: event.pull_request.merged ? "success" : "no_change",
        summary: event.pull_request.merged ? "GitHub reports the pull request merged." : "GitHub reports the pull request closed without merge.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "closed", merged: event.pull_request.merged },
        headSha: event.pull_request.head.sha ?? store.getSetting(`github-head:${ticket.linear_issue_id}`),
        pullRequestUrl: event.pull_request.html_url,
      });
      const currentPipeline = routedPipeline
        ? pipelines.getInstanceForSession(ticket.linear_session_id)
        : undefined;
      const providerEvidenceDeferred =
        pipelines.getInboxEvent(providerEventId)?.status === "pending";
      if (currentPipeline && !pipelineIsTerminal(currentPipeline) && !providerEvidenceDeferred) {
        requestPipelineStop({
          store: pipelines,
          sessionId: ticket.linear_session_id,
          eventId: `github-pull-closed-stop:${event.pull_request.number}:${event.pull_request.head.sha ?? "unknown"}`,
          reason: event.pull_request.merged
            ? "Pull request merged while a pipeline stage was active."
            : "Pull request closed while a pipeline stage was active.",
          ticketState: "closed",
        });
      }
      // GitHub close is authoritative even when a stage already settled and
      // has no live attempt left for a stop event to cancel.
      store.setState(ticket.linear_issue_id, "closed");
      store.markSessionState(ticket.linear_session_id, "stopped");
      store.cancelPendingInbox(ticket.linear_issue_id);
    }
    return;
  }

  if (event.kind === "pull_request_review") {
    const ticket = store.getByBranch(event.repository.full_name, event.pull_request.head.ref);
    if (!ticket || event.action !== "submitted") return;
    await activityPublisher.publishActivity({
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "PR review submitted",
      parameter: `${event.review.user?.login ?? "reviewer"}: ${event.review.state}`,
      result: event.review.html_url,
    }, ticket.linear_issue_id);
    const reviewState = event.review.state.toLowerCase();
    if (reviewState !== "changes_requested" && reviewState !== "commented") return;
    if (ticket.state !== "active") return;
    const author = event.review.user?.login;
    const self = await selfGithubLogin(cfg);
    if (reviewState === "commented") {
      // A bot's commented review is only actionable when provably not the
      // agent's own account; fail closed (skip) when either side of that
      // comparison is unknown, since we can't otherwise rule out self-feedback.
      if (!author || !self || author === self) return;
    } else if (author && self && author === self) {
      // changes_requested: skip ONLY when the author is positively known to
      // be the token account. A transient self-lookup failure (or missing
      // author) must not silently drop a genuine human CHANGES_REQUESTED —
      // that would fail closed on exactly the review that matters most.
      return;
    }
    const headSha = event.pull_request.head.sha ??
      store.getSetting(`github-head:${ticket.linear_issue_id}`) ??
      `unknown:${event.pull_request.head.ref}`;
    if (event.pull_request.head.sha) {
      setAuthoritativeGithubHead(store, ticket.linear_issue_id, headSha);
    } else if (!store.getSetting(`github-head:${ticket.linear_issue_id}`)) {
      store.setSetting(`github-head:${ticket.linear_issue_id}`, headSha);
    }
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: `github-review:${event.review.id}`,
      outcome: "semantic_repair_required",
      summary: `GitHub review from ${author ?? "reviewer"} requires another implementation pass.`,
      evidence: [event.review.html_url],
      payload: { kind: "pull_request_review", state: event.review.state, head_sha: headSha },
      headSha,
      pullRequestUrl: event.pull_request.html_url,
    });
    return;
  }

  if (event.kind === "issue_comment") {
    if (event.action !== "created" || !event.issue.pull_request) return;
    const ticket = store.getByPrUrl(
      event.repository.full_name,
      `https://github.com/${event.repository.full_name}/pull/${event.issue.number}`
    );
    if (!ticket || ticket.state !== "active") return;
    const author = event.comment.user?.login;
    const self = await selfGithubLogin(cfg);
    if (!author || !self || author === self) return;
    await activityPublisher.publishActivity({
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "PR comment",
      parameter: author,
      result: event.comment.html_url,
    }, ticket.linear_issue_id);
    const headSha = store.getSetting(`github-head:${ticket.linear_issue_id}`) ??
      `unknown:${ticket.branch}`;
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: `github-comment:${event.comment.id}`,
      outcome: "semantic_repair_required",
      summary: `GitHub comment from ${author} requires another implementation pass.`,
      evidence: [event.comment.html_url],
      payload: { kind: "issue_comment", head_sha: headSha },
      headSha,
    });
    return;
  }

  // workflow_run / check_suite: mirror every completion to Linear (success and
  // failure alike); a failed/timed-out completion on an active, PR-backed
  // ticket additionally becomes queued feedback work (Phase 1 item 1, new).
  const ci = event.kind === "workflow_run"
    ? {
        branch: event.workflow_run.head_branch,
        conclusion: event.workflow_run.conclusion,
        url: event.workflow_run.html_url,
        headSha: event.workflow_run.head_sha,
        sequence: event.workflow_run.id,
        eventId: `github-workflow:${event.workflow_run.id}`,
        name: event.workflow_run.name,
      }
    : {
        branch: event.check_suite.head_branch,
        conclusion: event.check_suite.conclusion,
        url: event.check_suite.url,
        headSha: event.check_suite.head_sha,
        sequence: event.check_suite.id,
        eventId: `github-check-suite:${event.check_suite.id}`,
        name: "GitHub check suite",
      };
  if (!isOpenthrottleBranch(ci.branch) || event.action !== "completed") return;
  const ticket = store.getByBranch(event.repository.full_name, ci.branch);
  if (!ticket) return;
  await activityPublisher.publishActivity({
    sessionId: ticket.linear_session_id,
    type: "action",
    action: "CI completed",
    parameter: ci.conclusion ?? "unknown",
    result: ci.url,
  }, ticket.linear_issue_id);
  considerCiGithubHead(
    store,
    ticket.linear_issue_id,
    ci.headSha,
    event.kind,
    ci.sequence
  );

  // A single green workflow/check is not proof that the provider wait has
  // settled: another required check may still be pending. GitHub's merged PR
  // event is the authoritative success boundary. Red checks can immediately
  // re-enter the bounded repair path, while every pipeline CI completion stays
  // out of the deterministic coordinator.
  if (!pipelines.getInstanceForSession(ticket.linear_session_id)) return;
  if (ci.conclusion === "failure" || ci.conclusion === "timed_out") {
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: ci.eventId,
      outcome: "semantic_repair_required",
      summary: `${ci.name} concluded ${ci.conclusion}.`,
      evidence: [ci.url],
      payload: { kind: event.kind, conclusion: ci.conclusion, head_sha: ci.headSha, url: ci.url },
      headSha: ci.headSha,
    });
  }
}
