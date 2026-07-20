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

const githubLoginCache = new Map<string, string>();

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
    // Both a human CHANGES_REQUESTED and a bot's commented review are
    // actionable only when provably not the agent's own account; fail closed
    // otherwise. A CHANGES_REQUESTED from the token account is equally
    // self-feedback as a commented one.
    const author = event.review.user?.login;
    const self = await selfGithubLogin(cfg);
    if (!author || !self || author === self) return;
    await enqueueFeedbackWork({
      cfg,
      store,
      daytona,
      linear,
      linearOutbox,
      ticket,
      workId: `gh-review-${event.review.id}`,
      body: feedbackMessage({
        kind: "review",
        author,
        pullNumber: event.pull_request.number,
        url: event.review.html_url,
        body: event.review.body,
      }),
      launch: launchExistingTask,
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
    await enqueueFeedbackWork({
      cfg,
      store,
      daytona,
      linear,
      linearOutbox,
      ticket,
      workId: `gh-comment-${event.comment.id}`,
      body: feedbackMessage({
        kind: "comment",
        author,
        pullNumber: event.issue.number,
        url: event.comment.html_url,
        body: event.comment.body,
      }),
      launch: launchExistingTask,
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
  await enqueueActivity(store, linearOutbox, {
    sessionId: ticket.linear_session_id,
    type: "action",
    action: "CI completed",
    parameter: conclusion ?? "unknown",
    result: url,
  }, ticket.linear_issue_id);

  if (
    (conclusion !== "failure" && conclusion !== "timed_out") ||
    ticket.state !== "active" ||
    !ticket.pr_url
  ) {
    return;
  }
  const name = event.kind === "workflow_run" ? event.workflow_run.name : "CI check suite";
  const workId = `gh-ci-${event.kind === "workflow_run" ? event.workflow_run.id : event.check_suite.id}`;
  await enqueueFeedbackWork({
    cfg,
    store,
    daytona,
    linear,
    linearOutbox,
    ticket,
    workId,
    body: feedbackMessage({ kind: "ci", name, conclusion, url }),
    launch: launchExistingTask,
  });
}
