import { afterEach, describe, expect, it } from "vitest";
import { createTicketStore, openDb, type Ticket, type TicketStore } from "./db.js";
import {
  drainNextSessionWork,
  feedbackMessage,
  isAutomaticWorkBounded,
  isResolvableFeedbackWorkId,
  shouldNudgeAfterRun,
  type DrainParams,
  type LaunchExistingTask,
} from "./scheduler.js";

describe("isAutomaticWorkBounded", () => {
  it("bounds only automatic work, at or past the configured max rounds", () => {
    expect(
      isAutomaticWorkBounded({ source: "automatic", consumedAutomaticCount: 2, maxRounds: 3 })
    ).toBe(false);
    expect(
      isAutomaticWorkBounded({ source: "automatic", consumedAutomaticCount: 3, maxRounds: 3 })
    ).toBe(true);
    expect(
      isAutomaticWorkBounded({ source: "automatic", consumedAutomaticCount: 10, maxRounds: 3 })
    ).toBe(true);
    // Human-source items are never bounded, no matter the count.
    expect(
      isAutomaticWorkBounded({ source: "human", consumedAutomaticCount: 99, maxRounds: 3 })
    ).toBe(false);
  });
});

describe("isResolvableFeedbackWorkId", () => {
  it("flags only gh-review- ids for the resolved-thread check — a plain PR comment never creates a review thread to resolve", () => {
    expect(isResolvableFeedbackWorkId("gh-review-42")).toBe(true);
    expect(isResolvableFeedbackWorkId("gh-comment-7")).toBe(false);
    expect(isResolvableFeedbackWorkId("gh-ci-99")).toBe(false);
    expect(isResolvableFeedbackWorkId("human-reply-1")).toBe(false);
  });
});

describe("shouldNudgeAfterRun", () => {
  const base = {
    exitCode: 0,
    pausedOnElicitation: false,
    consumedAutomaticWork: true,
    hasPrUrl: true,
    nudgeComment: "@codex review",
  };

  it("nudges only on a clean, non-paused, automatic-consuming, PR-backed run with a configured comment", () => {
    expect(shouldNudgeAfterRun(base)).toBe(true);
    expect(shouldNudgeAfterRun({ ...base, exitCode: 1 })).toBe(false);
    expect(shouldNudgeAfterRun({ ...base, pausedOnElicitation: true })).toBe(false);
    expect(shouldNudgeAfterRun({ ...base, consumedAutomaticWork: false })).toBe(false);
    expect(shouldNudgeAfterRun({ ...base, hasPrUrl: false })).toBe(false);
    expect(shouldNudgeAfterRun({ ...base, nudgeComment: "" })).toBe(false);
    expect(shouldNudgeAfterRun({ ...base, nudgeComment: "   " })).toBe(false);
  });
});

describe("feedbackMessage", () => {
  it("builds a review/comment message naming the author, PR, and an excerpt, with triage instructions", () => {
    const message = feedbackMessage({
      kind: "review",
      author: "codex-review-bot",
      pullNumber: 12,
      url: "https://github.com/o/r/pull/12#pullrequestreview-1",
      body: "The retry loop swallows the original error.",
    });
    expect(message).toContain("New PR feedback from codex-review-bot on PR #12");
    expect(message).toContain("https://github.com/o/r/pull/12#pullrequestreview-1");
    expect(message).toContain("The retry loop swallows the original error.");
    expect(message).toContain("Triage this feedback");
    // The triage contract: wait for CI, reply on every thread, refresh the
    // gate checklist. Lock those so the delivered message can't quietly drop
    // back to fire-and-forget triage.
    expect(message).toContain("gh pr checks --watch");
    expect(message).toContain("reply visibly on EVERY item");
    expect(message).toContain("## OpenThrottle gates");
  });

  it("falls back to 'a reviewer' when no author is known", () => {
    expect(feedbackMessage({ kind: "comment", author: undefined, pullNumber: 3, url: "https://x" })).toContain(
      "from a reviewer on PR #3"
    );
  });

  it("builds a CI message naming the workflow/check, its conclusion, and the html_url", () => {
    const message = feedbackMessage({
      kind: "ci",
      name: "CI",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/9",
    });
    expect(message).toContain('Check "CI" concluded failure');
    expect(message).toContain("https://github.com/o/r/actions/runs/9");
    // Feedback is deduplicated per head SHA, so the message must send the
    // agent to the full check list — other workflows may have failed too.
    expect(message).toContain("run `gh pr checks` and triage every failing check");
    expect(message).toContain("Triage this feedback");
  });
});

// Exercises the drain loop against a real in-memory store (the same harness
// db.test.ts uses) with a fake `launch`, focusing on the terminal-state guard.
describe("drainNextSessionWork terminal-state guard", () => {
  const stores: TicketStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.db.close();
  });

  function makeStore(): TicketStore {
    const store = createTicketStore(openDb(":memory:"));
    stores.push(store);
    store.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    return store;
  }

  // The heavy collaborators (cfg/daytona/linear/linearOutbox) are never touched
  // on the paths under test: the guard short-circuits before them, and the happy
  // path uses human work that skips the automatic rounds/thread checks.
  function makeParams(store: TicketStore, ticket: Ticket, launch: LaunchExistingTask): DrainParams {
    return {
      cfg: { reviewMaxRounds: 3, githubToken: "gh-token" },
      store,
      daytona: {},
      linear: {},
      linearOutbox: {},
      ticket,
      launch,
    } as unknown as DrainParams;
  }

  it.each(["closed", "stopped", "expired"] as const)(
    "cancels queued work and never launches when the ticket is %s (terminal-for-dispatch)",
    async (state) => {
      const store = makeStore();
      store.enqueueSessionWork({
        id: "gh-review-1",
        linearSessionId: "session-1",
        issueId: "issue-1",
        source: "automatic",
        body: "please fix",
      });
      // params.ticket is the stale, still-active reference the drain was handed;
      // the store is what got moved to a terminal state under it.
      const staleTicket = store.getByIssueId("issue-1")!;
      store.setState("issue-1", state);

      let launched = 0;
      const launch: LaunchExistingTask = async () => {
        launched += 1;
        return true;
      };

      const result = await drainNextSessionWork(makeParams(store, staleTicket, launch));

      expect(result).toBe(false);
      expect(launched).toBe(0);
      // Cancelled, not released back to pending — nothing left to re-claim.
      expect(store.claimNextSessionWork("session-1", new Date().toISOString())).toBeUndefined();
    }
  );

  it("cancels ALL queued items and launches none when the ticket is terminal", async () => {
    const store = makeStore();
    store.enqueueSessionWork({
      id: "gh-review-1",
      linearSessionId: "session-1",
      issueId: "issue-1",
      source: "automatic",
      body: "feedback",
    });
    store.enqueueSessionWork({
      id: "human-1",
      linearSessionId: "session-1",
      issueId: "issue-1",
      source: "human",
      body: "another reply",
    });
    const staleTicket = store.getByIssueId("issue-1")!;
    store.setState("issue-1", "closed");

    let launched = 0;
    const launch: LaunchExistingTask = async () => {
      launched += 1;
      return true;
    };

    const result = await drainNextSessionWork(makeParams(store, staleTicket, launch));

    expect(result).toBe(false);
    expect(launched).toBe(0);
    // The loop kept claiming until empty, cancelling each — neither survives.
    expect(store.claimNextSessionWork("session-1", new Date().toISOString())).toBeUndefined();
  });

  it("still drains and launches normally when the ticket is active (guard does not over-fire)", async () => {
    const store = makeStore();
    store.enqueueSessionWork({
      id: "human-1",
      linearSessionId: "session-1",
      issueId: "issue-1",
      source: "human",
      body: "please take another look",
    });
    const ticket = store.getByIssueId("issue-1")!; // still active

    const launchCalls: Array<{ taskType: string; issueId: string }> = [];
    const launch: LaunchExistingTask = async (p) => {
      launchCalls.push({ taskType: p.taskType, issueId: p.ticket.linear_issue_id });
      // Simulate a run starting so the drain can mark the work consumed and
      // observe a run_id, mirroring the real launchExistingTask.
      store.beginRun({
        issueId: p.ticket.linear_issue_id,
        runId: "run-1",
        taskType: p.taskType,
        tokenHash: "hash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return true;
    };

    const result = await drainNextSessionWork(makeParams(store, ticket, launch));

    expect(result).toBe(true);
    expect(launchCalls).toEqual([{ taskType: "resume", issueId: "issue-1" }]);
  });
});
