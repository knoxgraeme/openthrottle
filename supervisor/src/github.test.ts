import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  countChangesRequestedReviews,
  getMergeReadiness,
  isGithubPullRequestUrl,
  isOpenthrottleBranch,
  parseGithubWebhook,
  parsePullRequestUrl,
  verifyGithubSignature,
} from "./github.js";

describe("GitHub contracts", () => {
  it("verifies sha256 signatures", () => {
    const raw = '{"action":"closed"}';
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(verifyGithubSignature(raw, signature, "secret")).toBe(true);
    expect(verifyGithubSignature(`${raw}x`, signature, "secret")).toBe(false);
  });

  it("parses supported webhooks and rejects malformed/unsupported ones", () => {
    const raw = JSON.stringify({
      action: "closed",
      repository: { full_name: "o/r" },
      pull_request: {
        number: 1,
        html_url: "https://github.com/o/r/pull/1",
        merged: false,
        head: { ref: "ot/test" },
        base: { ref: "main" },
      },
    });
    expect(parseGithubWebhook("pull_request", raw).kind).toBe("pull_request");
    expect(() => parseGithubWebhook("issues", raw)).toThrow(/Unsupported/);
    expect(() => parseGithubWebhook("pull_request", "[]")).toThrow(/object/);
    expect(() =>
      parseGithubWebhook("pull_request", JSON.stringify({ action: "closed", repository: { full_name: "o/r" } }))
    ).toThrow(/pull_request/);
  });

  it("recognizes managed branches and strict PR URLs", () => {
    expect(isOpenthrottleBranch("ot/ot-123")).toBe(true);
    expect(isOpenthrottleBranch("feature/a")).toBe(false);
    expect(parsePullRequestUrl("https://github.com/owner/repo/pull/42")).toEqual({
      host: "github.com",
      repo: "owner/repo",
      number: 42,
    });
    expect(isGithubPullRequestUrl("https://github.com/owner/repo/pull/42")).toBe(true);
    expect(isGithubPullRequestUrl("https://example.com/owner/repo/pull/42")).toBe(false);
    expect(isGithubPullRequestUrl("https://github.com/owner/repo/pull/42/")).toBe(false);
    expect(() => parsePullRequestUrl("https://example.com/not-a-pr")).toThrow(/Invalid/);
  });

  it("counts blocking reviews and requires terminal green checks", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      const url = String(input);
      if (url.includes("/reviews")) {
        return Response.json([{ state: "CHANGES_REQUESTED" }, { state: "APPROVED" }]);
      }
      if (url.includes("/check-runs")) {
        return Response.json({
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
          ],
        });
      }
      return Response.json({ mergeable: true, draft: false, head: { sha: "abc123" } });
    }) as unknown as typeof fetch;
    const client = { token: "github", fetch: fetchMock };
    expect(await countChangesRequestedReviews(client, "o/r", 1)).toBe(1);
    expect(await getMergeReadiness(client, "o/r", 1)).toEqual({
      mergeable: true,
      draft: false,
      checksPresent: true,
      checksGreen: true,
      headSha: "abc123",
    });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
