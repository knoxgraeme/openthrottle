import { describe, expect, it } from "vitest";
import {
  feedbackMessage,
  isAutomaticWorkBounded,
  isResolvableFeedbackWorkId,
  shouldNudgeAfterRun,
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
