// Phase 2 item 1: the scheduler owns "what runs next" — the loop registry,
// session-work draining/priority, the review-round bound, the resolved-thread
// skip, and the external-reviewer nudge decision. completeRun and the GitHub
// webhook handler reduce to normalization plus calls into this module.
//
// This module intentionally does not import run-lifecycle.ts. `launch` is
// passed in by the caller (typed structurally below) so run-lifecycle.ts can
// depend on the scheduler for draining after a completed run without the
// scheduler depending back on run-lifecycle.ts for launching a task.

import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Ticket, TicketStore } from "./db.js";
import type { LinearClient } from "./linear.js";
import { parseCommand } from "./commands.js";
import { enqueueActivity, type LinearOutboxProcessor } from "./linear-outbox.js";
import { areAllReviewThreadsResolved, commentOnPullRequest, parsePullRequestUrl } from "./github.js";
import { sanitizeText } from "./sanitize.js";

// A loop is a skill plus a CE pipeline declaration behind a task name. `resume`
// is the continuation mechanism shared by both loops, not a registry entry —
// it has no entry skill or pipeline of its own, only whatever session it
// resumes.
export interface LoopRegistryEntry {
  entrySkill: string;
  cePipeline: string[];
  triggers: string[];
}

export const LOOP_REGISTRY: Record<"implement" | "investigate", LoopRegistryEntry> = {
  implement: {
    entrySkill: "implement-plan",
    cePipeline: ["ce-work", "ce-code-review", "ce-commit-push-pr"],
    triggers: ["linear.created", "linear.prompted.reDelegated", "linear.prompted.command"],
  },
  investigate: {
    entrySkill: "investigate",
    cePipeline: ["ce-debug", "ce-commit-push-pr"],
    triggers: ["linear.created.investigateLabel"],
  },
};

const TRIAGE_INSTRUCTIONS =
  "Triage this feedback the review-fix way: apply the clear fixes, reply on the " +
  "thread with your reasoning where no change is needed, and batch " +
  "decision-required items into one elicitation. Leave nothing unaddressed, and " +
  "end with your assumptions and decisions.";

export type FeedbackInput =
  | { kind: "review" | "comment"; author: string | undefined; pullNumber: number; url: string; body?: string }
  | { kind: "ci"; name: string; conclusion: string; url: string };

// Generalizes the former `prFeedbackMessage` into the single builder used for
// reviews, comments, and (new) CI failures — all resume as feedback-triage
// work on the original session.
export function feedbackMessage(input: FeedbackInput): string {
  if (input.kind === "ci") {
    // Feedback work is deduplicated per head SHA, so one item may stand in for
    // several distinct failing workflows on the same push — the message sends
    // the agent to the full check list rather than only the triggering check.
    return (
      `CI failed on this PR. Check "${input.name}" concluded ${input.conclusion}: ${input.url}\n\n` +
      "Other checks may have failed on the same commit — run `gh pr checks` and " +
      "triage every failing check, not just the one named above.\n\n" +
      TRIAGE_INSTRUCTIONS
    );
  }
  const excerpt = input.body?.trim() ? `\n\n${sanitizeText(input.body).slice(0, 2_000)}` : "";
  return (
    `New PR feedback from ${input.author ?? "a reviewer"} on PR #${input.pullNumber}: ${input.url}${excerpt}\n\n` +
    TRIAGE_INSTRUCTIONS
  );
}

// Only a review creates a GraphQL reviewThread; a plain PR conversation
// comment never does, so checking it against thread-resolution state would
// measure something unrelated and could cancel a fresh comment. The same
// holds for a body-only review (summary text, no inline comments): its
// feedback lives outside any thread, so the enqueue path gives it the
// `gh-rvbody-` prefix and it is never skipped on thread resolution.
export function isResolvableFeedbackWorkId(workId: string): boolean {
  return workId.startsWith("gh-review-");
}

// Rounds bound (Phase 1 item 3): a single counter — automatic session-work
// items already launched (consumed) for the ticket — bounded by
// cfg.reviewMaxRounds. Human-source items are never bounded. Exported as a
// pure predicate so it is table-testable without a store.
export function isAutomaticWorkBounded(params: {
  source: "human" | "automatic";
  consumedAutomaticCount: number;
  maxRounds: number;
}): boolean {
  return params.source === "automatic" && params.consumedAutomaticCount >= params.maxRounds;
}

// External re-review nudge (Phase 1 item 6 / Phase 2 item 1): posted only
// after a feedback-triggered (automatic) resume completes cleanly with a PR
// and a configured nudge comment. Never nudges for human-triggered resumes.
export function shouldNudgeAfterRun(params: {
  exitCode: number;
  pausedOnElicitation: boolean;
  consumedAutomaticWork: boolean;
  hasPrUrl: boolean;
  nudgeComment: string;
}): boolean {
  return (
    params.exitCode === 0 &&
    !params.pausedOnElicitation &&
    params.consumedAutomaticWork &&
    params.hasPrUrl &&
    params.nudgeComment.trim() !== ""
  );
}

export type LaunchExistingTask = (params: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  taskType: "resume" | "implement";
  resumeMessage?: string;
  linearContext?: string;
}) => Promise<boolean>;

async function postRoundsExhausted(params: {
  cfg: Config;
  store: TicketStore;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  consumed: number;
}): Promise<void> {
  const message = `Review rounds exhausted (${params.consumed}/${params.cfg.reviewMaxRounds}) — needs a human decision.`;
  await enqueueActivity(params.store, params.linearOutbox, {
    sessionId: params.ticket.linear_session_id,
    type: "error",
    body: message,
  }, params.ticket.linear_issue_id);
  if (params.ticket.pr_url) {
    try {
      const pull = parsePullRequestUrl(params.ticket.pr_url);
      await commentOnPullRequest({ token: params.cfg.githubToken }, params.ticket.repo, pull.number, message);
    } catch (error) {
      console.error(
        `[scheduler] rounds exhausted but the PR comment could not be posted for ${params.ticket.linear_issue_identifier}:`,
        error
      );
    }
  }
}

export interface DrainParams {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  launch: LaunchExistingTask;
}

// Claims and launches the next queued session-work item for the ticket's
// session as a `resume`, applying the rounds bound and the resolved-thread
// skip to automatic (GitHub-feedback) items before launching. Returns true
// only if a run was actually launched.
export async function drainNextSessionWork(params: DrainParams): Promise<boolean> {
  for (;;) {
    const work = params.store.claimNextSessionWork(
      params.ticket.linear_session_id,
      new Date().toISOString()
    );
    if (!work) return false;

    if (work.source === "automatic") {
      const consumed = params.store.countConsumedAutomaticSessionWork(params.ticket.linear_issue_id);
      if (isAutomaticWorkBounded({ source: work.source, consumedAutomaticCount: consumed, maxRounds: params.cfg.reviewMaxRounds })) {
        await postRoundsExhausted({
          cfg: params.cfg,
          store: params.store,
          linearOutbox: params.linearOutbox,
          ticket: params.ticket,
          consumed,
        });
        params.store.cancelSessionWork(work.id);
        return false;
      }
      if (isResolvableFeedbackWorkId(work.id) && params.ticket.pr_url) {
        const pull = parsePullRequestUrl(params.ticket.pr_url);
        const resolved = await areAllReviewThreadsResolved(
          { token: params.cfg.githubToken },
          params.ticket.repo,
          pull.number
        ).catch((error) => {
          console.warn(
            `[scheduler] could not check review-thread resolution for ${params.ticket.linear_issue_identifier}, launching anyway:`,
            error
          );
          return false;
        });
        if (resolved) {
          params.store.cancelSessionWork(work.id);
          continue;
        }
      }
    }

    const current = params.store.getByIssueId(params.ticket.linear_issue_id) ?? params.ticket;
    const heading = work.source === "human" ? "Latest human reply" : "New PR feedback";
    // A human `/implement` queued while a run was active must keep its
    // command meaning when drained — launching it as a resume would silently
    // downgrade the explicit promotion. The legacy regex promotion is not
    // re-parsed here (it needs the investigate label, which the drain does
    // not have); only the explicit command survives queueing.
    const queuedCommand =
      work.source === "human"
        ? parseCommand(work.body, { investigateLabel: false })
        : undefined;
    const taskType = queuedCommand?.kind === "implement" ? ("implement" as const) : ("resume" as const);
    const launched = await params.launch({
      cfg: params.cfg,
      store: params.store,
      daytona: params.daytona,
      linear: params.linear,
      linearOutbox: params.linearOutbox,
      ticket: current,
      taskType,
      resumeMessage: taskType === "resume" ? work.body : undefined,
      linearContext: `${current.linear_context ?? `# ${current.linear_issue_identifier}`}\n\n## ${heading}\n\n${work.body}`,
    });
    const runId = params.store.getByIssueId(params.ticket.linear_issue_id)?.run_id;
    if (launched && runId) {
      params.store.markSessionWorkConsumed(work.id, runId);
      return true;
    }
    params.store.releaseSessionWork(work.id);
    return false;
  }
}

// GitHub feedback becomes deduplicated `automatic` session work (Phase 1 item
// 1). An idle ticket (no active run) drains immediately so the resume
// launches now; an active run picks the item up on completion.
export async function enqueueFeedbackWork(params: {
  cfg: Config;
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  workId: string;
  body: string;
  launch: LaunchExistingTask;
}): Promise<void> {
  const inserted = params.store.enqueueSessionWork({
    id: params.workId,
    linearSessionId: params.ticket.linear_session_id,
    issueId: params.ticket.linear_issue_id,
    source: "automatic",
    body: params.body,
  });
  if (!inserted) return;
  if (params.ticket.run_id) return;
  await drainNextSessionWork(params);
}
