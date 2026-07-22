// Phase 2 item 3 / Phase 1 items 1-2: GitHub event handling. Every kind of PR
// feedback (reviews, comments, and now CI failures) becomes deduplicated
// `automatic` session work that resumes the original session; there is no
// more separate `review`/`review-fix` choreography. Split out of server.ts.

import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { type LinearClient } from "./linear.js";
import {
  getAuthenticatedLogin,
  isOpenthrottleBranch,
  type GithubWebhookEvent,
} from "./github.js";
import { enqueueActivity, type LinearOutboxProcessor } from "./linear-outbox.js";
import { launchExistingTask } from "./run-lifecycle.js";
import { enqueueFeedbackWork, feedbackMessage } from "./scheduler.js";
import { closeTicketForPullRequest } from "./ticket-control.js";
import { sanitizeText } from "./sanitize.js";

const githubLoginCache = new Map<string, string>();

function setAuthoritativeGithubHead(store: TicketStore, issueId: string, headSha: string): void {
  store.setSetting(`github-head:${issueId}`, headSha);
  store.setSetting(`github-head-source:${issueId}`, "authoritative");
}

function considerCiGithubHead(
  store: TicketStore,
  issueId: string,
  headSha: string,
  source: "workflow_run" | "check_suite",
  sequence: number
): void {
  const headKey = `github-head:${issueId}`;
  const sourceKey = `github-head-source:${issueId}`;
  const currentHead = store.getSetting(headKey);
  const rawSource = store.getSetting(sourceKey);
  let currentSource: { source: string; sequence: number } | undefined;
  try {
    currentSource = rawSource && rawSource !== "authoritative"
      ? JSON.parse(rawSource) as { source: string; sequence: number }
      : undefined;
  } catch {
    currentSource = undefined;
  }
  const canAdvance =
    !currentHead ||
    currentHead.startsWith("unknown:") ||
    currentHead === headSha ||
    (currentSource?.source === source && sequence > currentSource.sequence);
  if (!canAdvance || rawSource === "authoritative") return;
  store.setSetting(headKey, headSha);
  store.setSetting(sourceKey, JSON.stringify({ source, sequence }));
}

async function enqueueProviderFeedback(params: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  linearOutbox: LinearOutboxProcessor;
  ticket: NonNullable<ReturnType<TicketStore["getByIssueId"]>>;
  providerEventId: string;
  pullNumber: number;
  headSha: string;
  kind: string;
  payload: unknown;
  workId: string;
  body: string;
}): Promise<void> {
  const session = params.store.getCurrentSession(params.ticket.linear_issue_id);
  const recorded = params.store.recordProviderFeedback({
    provider: "github",
    providerEventId: params.providerEventId,
    issueId: params.ticket.linear_issue_id,
    sessionId: params.ticket.linear_session_id,
    generation: session?.generation ?? 1,
    repository: params.ticket.repo,
    pullNumber: params.pullNumber,
    headSha: params.headSha,
    kind: params.kind,
    payload: sanitizeText(JSON.stringify(params.payload)).slice(0, 16_000),
    workItemId: params.workId,
    workBody: params.body,
  });
  await enqueueFeedbackWork({
    cfg: params.cfg,
    store: params.store,
    daytona: params.daytona,
    linear: params.linear,
    linearOutbox: params.linearOutbox,
    ticket: params.ticket,
    workId: recorded.snapshot.work_item_id!,
    body: params.body,
    launch: launchExistingTask,
  });
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
  store: TicketStore,
  daytona: Daytona,
  getLinearClient: () => Promise<LinearClient | undefined>,
  linearOutbox: LinearOutboxProcessor,
  event: GithubWebhookEvent
): Promise<void> {
  const linear = await getLinearClient();

  if (event.kind === "pull_request") {
    const branch = event.pull_request.head.ref;
    if (!isOpenthrottleBranch(branch)) return;
    const ticket = store.getByBranch(event.repository.full_name, branch);
    if (!ticket) return;
    if (event.pull_request.head.sha) {
      setAuthoritativeGithubHead(store, ticket.linear_issue_id, event.pull_request.head.sha);
    }
    if (event.action === "closed") {
      await closeTicketForPullRequest({
        store,
        daytona,
        linear,
        linearOutbox,
        ticket,
        prUrl: event.pull_request.html_url,
        merged: event.pull_request.merged,
      });
    }
    return;
  }

  if (event.kind === "pull_request_review") {
    const ticket = store.getByBranch(event.repository.full_name, event.pull_request.head.ref);
    if (!ticket || !linear || event.action !== "submitted") return;
    await enqueueActivity(store, linearOutbox, {
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
    await enqueueProviderFeedback({
      cfg,
      store,
      daytona,
      linear,
      linearOutbox,
      ticket,
      // A review with only a summary body creates no inline review threads,
      // so the resolved-thread skip would measure unrelated (older) threads
      // and could cancel it. `gh-rvbody-` marks it exempt from that skip;
      // only reviews whose feedback lives in inline threads are `gh-review-`.
      providerEventId: `review:${event.review.id}`,
      pullNumber: event.pull_request.number,
      headSha,
      kind: "pull_request_review",
      payload: { state: event.review.state, url: event.review.html_url, body: event.review.body },
      workId: event.review.body?.trim()
        ? `gh-rvbody-${event.review.id}`
        : `gh-review-${event.review.id}`,
      body: feedbackMessage({
        kind: "review",
        author,
        pullNumber: event.pull_request.number,
        url: event.review.html_url,
        body: event.review.body,
      }),
    });
    return;
  }

  if (event.kind === "issue_comment") {
    if (event.action !== "created" || !event.issue.pull_request) return;
    const ticket = store.getByPrUrl(
      event.repository.full_name,
      `https://github.com/${event.repository.full_name}/pull/${event.issue.number}`
    );
    if (!ticket || !linear || ticket.state !== "active") return;
    const author = event.comment.user?.login;
    const self = await selfGithubLogin(cfg);
    if (!author || !self || author === self) return;
    await enqueueActivity(store, linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "PR comment",
      parameter: author,
      result: event.comment.html_url,
    }, ticket.linear_issue_id);
    const headSha = store.getSetting(`github-head:${ticket.linear_issue_id}`) ??
      `unknown:${ticket.branch}`;
    await enqueueProviderFeedback({
      cfg,
      store,
      daytona,
      linear,
      linearOutbox,
      ticket,
      providerEventId: `comment:${event.comment.id}`,
      pullNumber: event.issue.number,
      headSha,
      kind: "issue_comment",
      payload: { url: event.comment.html_url, body: event.comment.body },
      workId: `gh-comment-${event.comment.id}`,
      body: feedbackMessage({
        kind: "comment",
        author,
        pullNumber: event.issue.number,
        url: event.comment.html_url,
        body: event.comment.body,
      }),
    });
    return;
  }

  // workflow_run / check_suite: mirror every completion to Linear (success and
  // failure alike); a failed/timed-out completion on an active, PR-backed
  // ticket additionally becomes queued feedback work (Phase 1 item 1, new).
  const branch =
    event.kind === "workflow_run" ? event.workflow_run.head_branch : event.check_suite.head_branch;
  if (!isOpenthrottleBranch(branch) || !linear || event.action !== "completed") return;
  const ticket = store.getByBranch(event.repository.full_name, branch);
  if (!ticket) return;
  const conclusion =
    event.kind === "workflow_run" ? event.workflow_run.conclusion : event.check_suite.conclusion;
  const url = event.kind === "workflow_run" ? event.workflow_run.html_url : event.check_suite.url;
  const headSha =
    event.kind === "workflow_run" ? event.workflow_run.head_sha : event.check_suite.head_sha;
  await enqueueActivity(store, linearOutbox, {
    sessionId: ticket.linear_session_id,
    type: "action",
    action: "CI completed",
    parameter: conclusion ?? "unknown",
    result: url,
  }, ticket.linear_issue_id);
  considerCiGithubHead(
    store,
    ticket.linear_issue_id,
    headSha,
    event.kind,
    event.kind === "workflow_run" ? event.workflow_run.id : event.check_suite.id
  );

  if (
    (conclusion !== "failure" && conclusion !== "timed_out") ||
    ticket.state !== "active" ||
    !ticket.pr_url
  ) {
    return;
  }
  const name = event.kind === "workflow_run" ? event.workflow_run.name : "CI check suite";
  // Keyed by head_sha so failures from one push coalesce into one collecting
  // snapshot. Each provider event still retains its stable identity and payload.
  const workId = `gh-ci-${headSha}`;
  await enqueueProviderFeedback({
    cfg,
    store,
    daytona,
    linear,
    linearOutbox,
    ticket,
    providerEventId: event.kind === "workflow_run"
      ? `workflow-run:${event.workflow_run.id}`
      : `check-suite:${event.check_suite.id}`,
    pullNumber: Number(ticket.pr_url.match(/\/pull\/(\d+)$/)?.[1] ?? 0),
    headSha,
    kind: event.kind,
    payload: { name, conclusion, url },
    workId,
    body: feedbackMessage({ kind: "ci", name, conclusion, url }),
  });
}
