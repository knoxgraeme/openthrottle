// GitHub feedback is committed as typed provider evidence for the generation-
// pinned pipeline. There is no automatic task-resume fallback.

import type { Config } from "../../app/config.js";
import type { SupervisorStore } from "../../persistence/store.js";
import {
  OPENTHROTTLE_COMMENT_MARKER_PREFIX,
  isOpenthrottleBranch,
  type GithubWebhookEvent,
} from "./client.js";
import type { ActivityPublicationPort } from "../../app/ports.js";
import type { PipelineStore } from "../../pipeline/store.js";
import { processProviderEvidence } from "../../pipeline/gates.js";
import { requestPipelineStop } from "../../pipeline/control.js";
import {
  pipelineIsTerminal,
  processPipelineFeedbackSnapshot,
  providerStageCanReceive,
  recordPipelineProviderEvent,
  type PipelineProviderOutcome,
} from "../../app/provider-feedback.js";

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
      provider: "github",
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

// Solo-operator feedback mode: the operator and the pipeline share one GitHub
// account, so authorship cannot distinguish human feedback from the pipeline's
// own output. Provenance comes from the supervisor's own records — the comment
// IDs its summary upsert persisted as github_summary external IDs. The marker
// prefix below is only a fallback for the narrow window where the comment
// webhook races the receipt acknowledgement, and it matches the full enforced
// summary marker so a human merely mentioning openthrottle markup is not
// silently dropped. An agent-authored unmarked comment could echo one repair
// cycle, bounded by the manifest's provider re-entry limit — a distinct
// machine identity (machine user or GitHub App) restores account-level
// filtering if this ever runs multi-user.
const SUMMARY_MARKER_PREFIX = `${OPENTHROTTLE_COMMENT_MARKER_PREFIX}pipeline-summary:`;

function looksLikeSupervisorSummary(body: string | undefined): boolean {
  return body?.startsWith(SUMMARY_MARKER_PREFIX) === true;
}

export async function handleGithubEvent(
  // Retained for signature stability at the composition/HTTP call sites; the
  // solo-mode feedback filter no longer needs a token-account lookup.
  _cfg: Config,
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
    // A review without an attested author cannot be trusted feedback. The
    // supervisor never authors pull-request reviews, so no machine-output
    // filtering applies here — every attested review is human.
    if (!author) return;
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
    if (!author) return;
    // Provenance first: comment IDs the supervisor's summary upsert persisted
    // are the machine's own output. The marker check only covers the window
    // where this webhook races the receipt acknowledgement.
    if (pipelines.isSupervisorGithubComment(String(event.comment.id))) return;
    if (looksLikeSupervisorSummary(event.comment.body)) return;
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
