// GitHub feedback is committed as typed provider evidence for the generation-
// pinned pipeline. There is no automatic task-resume fallback.

import type { Config } from "../../app/config.js";
import type { SupervisorStore } from "../../persistence/store.js";
import {
  getFailingGithubCheckDetails,
  OPENTHROTTLE_COMMENT_MARKER_PREFIX,
  fetchGithubIssueContext,
  getRepositoryCollaboratorPermission,
  githubIssueControlEvent,
  githubIssuesEventCarriesExactControlLabel,
  classifyGithubIssueComment,
  isAuthorizedGithubControlPermission,
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
import { sanitizeText } from "../../shared/sanitize.js";
import { handleControlEvent, type PipelineCoordinatorContext, type SessionServicePorts } from "../../app/session-service.js";
import type { AdmissionPreflight } from "../../app/admission-preflight.js";

type ProviderFinding = {
  severity: "P0" | "P1" | "P2" | "P3";
  code: string;
  summary: string;
};

export function routePipelineProviderEvent(params: {
  pipelines: PipelineStore;
  store: SupervisorStore;
  ticket: NonNullable<ReturnType<SupervisorStore["getByIssueId"]>>;
  eventId: string;
  outcome: PipelineProviderOutcome;
  summary: string;
  evidence: string[];
  findings?: ProviderFinding[];
  payload: Record<string, unknown>;
  headSha: string | undefined;
  pullRequestUrl?: string;
}): boolean {
  const instance = params.pipelines.getInstanceForSession(params.ticket.session_id);
  if (!instance) return false;
  if (params.pullRequestUrl && params.ticket.pr_url && params.pullRequestUrl !== params.ticket.pr_url) {
    return true;
  }
  if (pipelineIsTerminal(instance)) return true;
  const authoritativeHead = params.store.getSetting(`github-head:${params.ticket.ticket_id}`);
  if (params.headSha === undefined) return true;
  const canReceive = providerStageCanReceive(params.pipelines, instance);
  const revisionMatches = instance.published_commit !== null && params.headSha === instance.published_commit;
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
      findings: params.findings,
      payload: params.payload,
      headSha: params.headSha,
      pullRequestUrl: params.pullRequestUrl,
    });
    if (canReceive) {
      processPipelineFeedbackSnapshot({
        pipelines: params.pipelines,
        store: params.store,
        instance,
        snapshot,
        drainSource: "github-webhook",
      });
    }
    return true;
  }
  if (params.headSha !== authoritativeHead) return true;
  if (canReceive && !revisionMatches) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: "needs_human",
      summary: "GitHub's current pull-request head does not match the executor-verified published commit.",
      evidence: params.evidence,
      findings: params.findings,
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
  if (canReceive) {
    processProviderEvidence(params.pipelines, {
      id: params.eventId,
      instanceId: instance.id,
      outcome: params.outcome,
      summary: params.summary,
      evidence: params.evidence,
      findings: params.findings,
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

function githubPullEventId(
  action: "closed" | "closed-stop" | "synchronize",
  repository: string,
  pullNumber: number,
  headSha: string
): string {
  return `github-pull-${action}:${repository}:${pullNumber}:${headSha}`;
}

async function authorizedGithubControlActor(
  cfg: Config,
  repository: string,
  author: string | undefined
): Promise<boolean> {
  if (!author) return false;
  try {
    const permission = await getRepositoryCollaboratorPermission(
      { token: cfg.githubReadToken },
      repository,
      author
    );
    return isAuthorizedGithubControlPermission(permission);
  } catch {
    return false;
  }
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
const SUPERVISOR_COMMENT_MARKER_PREFIXES = [
  `${OPENTHROTTLE_COMMENT_MARKER_PREFIX}pipeline-summary:`,
  `${OPENTHROTTLE_COMMENT_MARKER_PREFIX}pipeline-status:`,
] as const;

function looksLikeSupervisorComment(body: string | undefined): boolean {
  return SUPERVISOR_COMMENT_MARKER_PREFIXES.some((prefix) => body?.startsWith(prefix) === true);
}

// Known Linear↔GitHub bridge identities whose PR comments are linkage
// artifacts, never human repair requests.
const LINEAR_BRIDGE_BOT_LOGINS = new Set(["linear-code[bot]", "linear[bot]"]);

// Unambiguous machine linkback marker for bridge deployments that comment
// under a different app identity. Comment bodies are untrusted data, so the
// filter accepts only this exact self-identifying prefix — never keyword
// heuristics, which would silently drop substantive automated review feedback
// (e.g. an app comment that merely says "linear issue" in prose) before it is
// recorded as provider evidence.
const LINEAR_LINKBACK_MARKER = "<!-- linear-linkback -->";

function isGithubBotLinkback(author: string, body: string | undefined): boolean {
  const normalizedAuthor = author.toLowerCase();
  if (LINEAR_BRIDGE_BOT_LOGINS.has(normalizedAuthor)) return true;
  if (!normalizedAuthor.endsWith("[bot]")) return false;
  return (body ?? "").startsWith(LINEAR_LINKBACK_MARKER);
}

function boundedSanitized(value: string, maxChars: number): string {
  return sanitizeText(value).slice(0, maxChars);
}

async function enrichCiFailure(input: {
  cfg: Config;
  repository: string;
  headSha: string;
  workflowRunId?: number;
  workflowName: string;
}): Promise<{
  failures: Array<{
    workflow_name: string;
    job_name: string;
    step_names: string[];
    log_tail: string | null;
    html_url: string | null;
  }>;
  findings: ProviderFinding[];
  note: string | null;
}> {
  try {
    const details = await getFailingGithubCheckDetails(
      { token: input.cfg.githubReadToken },
      input.repository,
      {
        headSha: input.headSha,
        workflowRunId: input.workflowRunId,
        workflowName: input.workflowName,
      }
    );
    const failures = details.map((detail) => {
      const stepNames = detail.stepNames.map((name) => boundedSanitized(name, 200));
      return {
        workflow_name: boundedSanitized(detail.workflowName, 200),
        job_name: boundedSanitized(detail.jobName, 200),
        step_names: stepNames,
        log_tail: detail.logTail === null ? null : sanitizeText(detail.logTail).slice(-2_000),
        html_url: detail.htmlUrl === null ? null : boundedSanitized(detail.htmlUrl, 1_000),
      };
    }).slice(0, 3);
    return {
      failures,
      findings: failures.map((failure) => {
        const step = failure.step_names.length > 0 ? failure.step_names.join(", ") : "unknown failing step";
        return {
          severity: "P1",
          code: "ci-check-failed",
          summary: `${failure.workflow_name} / ${failure.job_name} failed at ${step}.`,
        };
      }),
      note: null,
    };
  } catch (error) {
    // Enrichment stays non-fatal, but its absence must be legible: a 403 here
    // almost always means GITHUB_READ_TOKEN lacks the Actions read permission
    // that the jobs/job-log endpoints require on fine-grained PATs.
    const message = error instanceof Error ? error.message : String(error);
    const note = message.includes("(403)")
      ? "CI failure details are unavailable: GitHub returned 403 for the Actions jobs/logs lookup. " +
        "Grant the fine-grained GITHUB_READ_TOKEN Actions read permission to restore failing-job and log-tail enrichment."
      : `CI failure details are unavailable: ${boundedSanitized(message, 300)}`;
    return { failures: [], findings: [], note };
  }
}

export async function handleGithubEvent(
  // Retained for signature stability at the composition/HTTP call sites; the
  // solo-mode feedback filter no longer needs a token-account lookup.
  _cfg: Config,
  store: SupervisorStore,
  activityPublisher: ActivityPublicationPort,
  event: GithubWebhookEvent,
  pipelines: PipelineStore,
  control?: {
    ports: SessionServicePorts;
    coordinator: PipelineCoordinatorContext;
    preflight?: AdmissionPreflight;
    deliveryId?: string;
  }
): Promise<void> {
  if (event.kind === "pull_request") {
    const branch = event.pull_request.head.ref;
    if (!isOpenthrottleBranch(branch)) return;
    const ticket = store.getByBranch(event.repository.full_name, branch);
    if (!ticket) return;
    const pipelineInstance = pipelines.getInstanceForSession(ticket.session_id);
    if (!pipelineInstance) return;
    if (ticket.pr_url && ticket.pr_url !== event.pull_request.html_url) return;
    if (event.action === "opened" || event.action === "reopened" || event.action === "synchronize") {
      store.setPrUrl(ticket.ticket_id, event.pull_request.html_url);
      if (event.pull_request.head.sha) {
        setAuthoritativeGithubHead(store, ticket.ticket_id, event.pull_request.head.sha);
      }
    }
    if (event.action === "synchronize" && event.pull_request.head.sha) {
      routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: githubPullEventId(
          "synchronize",
          event.repository.full_name,
          event.pull_request.number,
          event.pull_request.head.sha
        ),
        outcome: "needs_human",
        summary: "The pull-request head changed after the pipeline entered provider wait.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "synchronize" },
        headSha: event.pull_request.head.sha,
        pullRequestUrl: event.pull_request.html_url,
      });
    }
    if (event.action === "closed") {
      const providerEventId = githubPullEventId(
        "closed",
        event.repository.full_name,
        event.pull_request.number,
        event.pull_request.head.sha ?? "unknown"
      );
      if (event.pull_request.head.sha) {
        setAuthoritativeGithubHead(store, ticket.ticket_id, event.pull_request.head.sha);
      }
      store.setPrUrl(ticket.ticket_id, event.pull_request.html_url);
      const routedPipeline = routePipelineProviderEvent({
        pipelines,
        store,
        ticket,
        eventId: providerEventId,
        outcome: event.pull_request.merged ? "success" : "no_change",
        summary: event.pull_request.merged ? "GitHub reports the pull request merged." : "GitHub reports the pull request closed without merge.",
        evidence: [event.pull_request.html_url],
        payload: { kind: "pull_request", action: "closed", merged: event.pull_request.merged },
        headSha: event.pull_request.head.sha ?? store.getSetting(`github-head:${ticket.ticket_id}`),
        pullRequestUrl: event.pull_request.html_url,
      });
      const currentPipeline = routedPipeline
        ? pipelines.getInstanceForSession(ticket.session_id)
        : undefined;
      const providerEvidenceDeferred =
        pipelines.getInboxEvent(providerEventId)?.status === "pending";
      if (currentPipeline && !pipelineIsTerminal(currentPipeline) && !providerEvidenceDeferred) {
        requestPipelineStop({
          store: pipelines,
          sessionId: ticket.session_id,
          eventId: githubPullEventId(
            "closed-stop",
            event.repository.full_name,
            event.pull_request.number,
            event.pull_request.head.sha ?? "unknown"
          ),
          reason: event.pull_request.merged
            ? "Pull request merged while a pipeline stage was active."
            : "Pull request closed while a pipeline stage was active.",
          ticketState: "closed",
        });
      }
      if (event.pull_request.merged) {
        const observed = currentPipeline ?? pipelineInstance;
        pipelines.recordJournalEntry({
          id: `journal-github-merged-${observed.repository}-${event.pull_request.number}-${event.pull_request.head.sha ?? "unknown"}`,
          issueId: ticket.ticket_id,
          instanceId: observed.id,
          actor: "supervisor",
          kind: "merged",
          trigger: "GitHub pull_request closed webhook",
          action: "Observed the pull request merged.",
          outcome: "merged",
          refs: {
            pr: event.pull_request.html_url,
            commit: event.pull_request.head.sha ?? null,
            pull_number: event.pull_request.number,
          },
        });
      }
      // GitHub close is authoritative even when a stage already settled and
      // has no live attempt left for a stop event to cancel.
      store.setState(ticket.ticket_id, "closed");
      store.markSessionState(ticket.session_id, "stopped");
      store.cancelPendingInbox(ticket.ticket_id);
    }
    return;
  }

  if (event.kind === "pull_request_review") {
    const ticket = store.getByBranch(event.repository.full_name, event.pull_request.head.ref);
    if (!ticket || event.action !== "submitted") return;
    await activityPublisher.publishActivity({
      sessionId: ticket.session_id,
      type: "action",
      action: "PR review submitted",
      parameter: `${event.review.user?.login ?? "reviewer"}: ${event.review.state}`,
      result: event.review.html_url,
    }, ticket.ticket_id);
    const reviewState = event.review.state.toLowerCase();
    if (reviewState !== "changes_requested" && reviewState !== "commented") return;
    const author = event.review.user?.login;
    // A review without an attested author cannot be trusted feedback. The
    // supervisor never authors pull-request reviews, so no machine-output
    // filtering applies here — every attested review is human.
    if (!author) return;
    const headSha = event.pull_request.head.sha ??
      store.getSetting(`github-head:${ticket.ticket_id}`) ??
      `unknown:${event.pull_request.head.ref}`;
    if (event.pull_request.head.sha) {
      setAuthoritativeGithubHead(store, ticket.ticket_id, headSha);
    } else if (!store.getSetting(`github-head:${ticket.ticket_id}`)) {
      store.setSetting(`github-head:${ticket.ticket_id}`, headSha);
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
    if (pipelines.isSupervisorGithubComment(String(event.comment.id))) return;
    if (looksLikeSupervisorComment(event.comment.body)) return;
    if (classifyGithubIssueComment(event) === "plain_issue_comment") {
      if (!control || event.action !== "created") return;
      const author = event.comment.user?.login;
      if (!await authorizedGithubControlActor(_cfg, event.repository.full_name, author)) return;
      await handleControlEvent(
        _cfg,
        store,
        control.ports,
        githubIssueControlEvent(event),
        control.coordinator,
        control.preflight
      );
      await control.coordinator.drainEffects?.();
      return;
    }
    if (event.action !== "created") return;
    const ticket = store.getByPrUrl(
      event.repository.full_name,
      `https://github.com/${event.repository.full_name}/pull/${event.issue.number}`
    );
    if (!ticket) return;
    const author = event.comment.user?.login;
    if (!author) return;
    // Provenance first: comment IDs the supervisor's summary upsert persisted
    // are the machine's own output. The marker check only covers the window
    // where this webhook races the receipt acknowledgement.
    if (isGithubBotLinkback(author, event.comment.body)) return;
    await activityPublisher.publishActivity({
      sessionId: ticket.session_id,
      type: "action",
      action: "PR comment",
      parameter: author,
      result: event.comment.html_url,
    }, ticket.ticket_id);
    const headSha = store.getSetting(`github-head:${ticket.ticket_id}`) ??
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

  if (event.kind === "issues") {
    if (event.action === "closed") {
      const ticket = store.getByExternalThread(
        "github",
        `${event.repository.full_name}#${event.issue.number}`
      );
      if (!ticket) return;
      const pipelineInstance = pipelines.getInstanceForSession(ticket.session_id);
      if (pipelineInstance && !pipelineIsTerminal(pipelineInstance)) {
        requestPipelineStop({
          store: pipelines,
          sessionId: ticket.session_id,
          eventId: `github-issue-closed:${pipelineInstance.id}:${event.repository.full_name}:${event.issue.number}`,
          reason: "GitHub Issue closed while a pipeline stage was active.",
          ticketState: "closed",
        });
      }
      store.setState(ticket.ticket_id, "closed");
      store.markSessionState(ticket.session_id, "stopped");
      store.cancelPendingInbox(ticket.ticket_id);
      await control?.coordinator.drainEffects?.();
      return;
    }
    if (!control || !githubIssuesEventCarriesExactControlLabel(event)) return;
    const author = event.sender?.login ?? event.issue.user?.login;
    if (!await authorizedGithubControlActor(_cfg, event.repository.full_name, author)) return;
    const promptContext = await fetchGithubIssueContext(
      { token: _cfg.githubReadToken },
      event.repository.full_name,
      event.issue.number
    );
    const sessionSuffix = event.action === "labeled"
      ? `label:${event.issue.updated_at ?? control.deliveryId ?? "current"}`
      : `opened:${event.issue.created_at ?? control.deliveryId ?? "current"}`;
    await handleControlEvent(
      _cfg,
      store,
      control.ports,
      githubIssueControlEvent(event, {
        promptContext,
        sessionId: `github:${event.repository.full_name}#${event.issue.number}:${sessionSuffix}`,
      }),
      control.coordinator,
      control.preflight
    );
    await control.coordinator.drainEffects?.();
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
        workflowRunId: event.workflow_run.id,
      }
    : {
        branch: event.check_suite.head_branch,
        conclusion: event.check_suite.conclusion,
        url: event.check_suite.url,
        headSha: event.check_suite.head_sha,
        sequence: event.check_suite.id,
        eventId: `github-check-suite:${event.check_suite.id}`,
        name: "GitHub check suite",
        workflowRunId: undefined,
      };
  if (!isOpenthrottleBranch(ci.branch) || event.action !== "completed") return;
  const ticket = store.getByBranch(event.repository.full_name, ci.branch);
  if (!ticket) return;
  await activityPublisher.publishActivity({
    sessionId: ticket.session_id,
    type: "action",
    action: "CI completed",
    parameter: ci.conclusion ?? "unknown",
    result: ci.url,
  }, ticket.ticket_id);
  considerCiGithubHead(
    store,
    ticket.ticket_id,
    ci.headSha,
    event.kind,
    ci.sequence
  );

  // A single green workflow/check is not proof that the provider wait has
  // settled: another required check may still be pending. GitHub's merged PR
  // event is the authoritative success boundary. Red checks can immediately
  // re-enter the bounded repair path, while every pipeline CI completion stays
  // out of the deterministic coordinator.
  if (!pipelines.getInstanceForSession(ticket.session_id)) return;
  if (ci.conclusion === "failure" || ci.conclusion === "timed_out") {
    const enrichment = await enrichCiFailure({
      cfg: _cfg,
      repository: event.repository.full_name,
      headSha: ci.headSha,
      workflowRunId: ci.workflowRunId,
      workflowName: ci.name,
    });
    routePipelineProviderEvent({
      pipelines,
      store,
      ticket,
      eventId: ci.eventId,
      outcome: "semantic_repair_required",
      summary: enrichment.note === null
        ? `${ci.name} concluded ${ci.conclusion}.`
        : `${ci.name} concluded ${ci.conclusion}. ${enrichment.note}`,
      evidence: [
        ci.url,
        ...enrichment.failures
          .map((failure) => failure.html_url)
          .filter((url): url is string => typeof url === "string" && url.length > 0),
      ],
      findings: enrichment.findings,
      payload: {
        kind: event.kind,
        conclusion: ci.conclusion,
        head_sha: ci.headSha,
        url: ci.url,
        failures: enrichment.failures,
        findings: enrichment.findings,
        ...(enrichment.note === null ? {} : { enrichment_note: enrichment.note }),
      },
      headSha: ci.headSha,
    });
  }
}
