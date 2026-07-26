import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../../persistence/store.js";
import { openDb } from "../../persistence/database.js";
import { considerCiGithubHead } from "./events.js";
import {
  branchExists,
  getRepositoryConfigAtCommit,
  getFailingGithubCheckDetails,
  getMergeReadiness,
  isGithubPullRequestUrl,
  isOpenthrottleBranch,
  parseGithubWebhook,
  parsePullRequestUrl,
  prepareRepository,
  upsertPullRequestComment,
  verifyGithubSignature,
} from "./client.js";

describe("GitHub contracts", () => {
  it("advances CI head watermarks across workflow-run and check-suite sources", () => {
    const db = openDb(":memory:");
    try {
      const store = createSupervisorStore(db);
      considerCiGithubHead(store, "issue-1", "head-workflow", "workflow_run", 100);
      // IDs from different webhook object types are not a shared sequence.
      considerCiGithubHead(store, "issue-1", "head-check", "check_suite", 1);
      expect(store.getSetting("github-head:issue-1")).toBe("head-check");
      expect(store.getSetting("github-head-source:issue-1")).toBe(
        JSON.stringify({ source: "check_suite", sequence: 1 })
      );

      // A delayed older event cannot move the watermark backwards.
      considerCiGithubHead(store, "issue-1", "head-old", "workflow_run", 99);
      expect(store.getSetting("github-head:issue-1")).toBe("head-check");
    } finally {
      db.close();
    }
  });

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
    const comment = JSON.stringify({
      action: "created",
      repository: { full_name: "o/r" },
      issue: { number: 1, pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" } },
      comment: {
        id: 7,
        body: "Please double-check the retry logic.",
        html_url: "https://github.com/o/r/pull/1#issuecomment-7",
        user: { login: "reviewer" },
      },
    });
    expect(parseGithubWebhook("issue_comment", comment).kind).toBe("issue_comment");
    expect(() =>
      parseGithubWebhook(
        "issue_comment",
        JSON.stringify({ action: "created", repository: { full_name: "o/r" }, issue: { number: 1 } })
      )
    ).toThrow(/comment/);
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

  it("requires terminal green checks for merge readiness", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      const url = String(input);
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
    expect(await getMergeReadiness(client, "o/r", 1)).toEqual({
      mergeable: true,
      draft: false,
      checksPresent: true,
      checksGreen: true,
      headSha: "abc123",
    });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("fetches bounded failed workflow job details and log tails", async () => {
    const longLog = `${"x".repeat(2_100)}\n[REDACTED-ME]`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/actions/runs/20/jobs?filter=latest&per_page=100")) {
        return Response.json({
          jobs: [
            {
              id: 101,
              name: "test",
              workflow_name: "CI",
              html_url: "https://github.com/o/r/actions/runs/20/job/101",
              conclusion: "failure",
              steps: [
                { name: "install", conclusion: "success" },
                { name: "unit tests", conclusion: "failure" },
              ],
            },
            { id: 102, name: "lint", conclusion: "success", steps: [] },
          ],
        });
      }
      if (url.endsWith("/actions/jobs/101/logs")) return new Response(longLog);
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    const details = await getFailingGithubCheckDetails(
      { token: "github", fetch: fetchMock },
      "o/r",
      { headSha: "c".repeat(40), workflowRunId: 20, workflowName: "CI" }
    );

    expect(details).toEqual([{
      workflowName: "CI",
      jobName: "test",
      stepNames: ["unit tests"],
      logTail: expect.stringContaining("[REDACTED-ME]"),
      htmlUrl: "https://github.com/o/r/actions/runs/20/job/101",
    }]);
    expect(details[0]!.logTail).toHaveLength(2_000);
  });

  it("streams failed job logs while keeping only the bounded tail", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/actions/runs/20/jobs?filter=latest&per_page=100")) {
        return Response.json({
          jobs: [{ id: 101, name: "test", workflow_name: "CI", conclusion: "failure", steps: [] }],
        });
      }
      if (url.endsWith("/actions/jobs/101/logs")) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("a".repeat(100_000)));
            controller.enqueue(encoder.encode("final failure"));
            controller.close();
          },
        }));
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    const details = await getFailingGithubCheckDetails(
      { token: "github", fetch: fetchMock },
      "o/r",
      { headSha: "c".repeat(40), workflowRunId: 20, workflowName: "CI" }
    );

    expect(details[0]!.logTail).toHaveLength(2_000);
    expect(details[0]!.logTail).toContain("final failure");
  });

  it("fetches failed check-suite jobs from commit check runs", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/commits/${"c".repeat(40)}/check-runs?per_page=100`)) {
        return Response.json({
          check_runs: [{
            id: 501,
            name: "build",
            conclusion: "failure",
            details_url: "https://github.com/o/r/actions/runs/20/job/101",
            html_url: "https://github.com/o/r/runs/501",
          }],
        });
      }
      if (url.endsWith("/actions/jobs/101")) {
        return Response.json({
          id: 101,
          name: "build",
          workflow_name: "CI",
          html_url: "https://github.com/o/r/actions/runs/20/job/101",
          conclusion: "failure",
          steps: [{ name: "compile", conclusion: "failure" }],
        });
      }
      if (url.endsWith("/actions/jobs/101/logs")) return new Response("compile failed");
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(getFailingGithubCheckDetails(
      { token: "github", fetch: fetchMock },
      "o/r",
      { headSha: "c".repeat(40), workflowName: "GitHub check suite" }
    )).resolves.toEqual([{
      workflowName: "CI",
      jobName: "build",
      stepNames: ["compile"],
      logTail: "compile failed",
      htmlUrl: "https://github.com/o/r/actions/runs/20/job/101",
    }]);
  });

  it("resolves branch existence and distinguishes 404 from other errors", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/branches/feature%2Fx")) return Response.json({ name: "feature/x" });
      if (url.endsWith("/branches/missing")) return new Response("Not Found", { status: 404 });
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const client = { token: "github", fetch: fetchMock };
    expect(await branchExists(client, "o/r", "feature/x")).toBe(true);
    expect(await branchExists(client, "o/r", "missing")).toBe(false);
    await expect(branchExists(client, "o/r", "boom")).rejects.toThrow(/GitHub API error \(500\)/);
  });

  it("pins repository config to the exact resolved commit and blob", async () => {
    const content = "pipelines:\n  implement: implement\n";
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/commits/feature%2Fpipeline")) {
        return Response.json({ sha: "a".repeat(40) });
      }
      if (url.endsWith(`/contents/.openthrottle.yml?ref=${"a".repeat(40)}`)) {
        return Response.json({
          type: "file",
          sha: "b".repeat(40),
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          size: Buffer.byteLength(content),
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(getRepositoryConfigAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      "feature/pipeline"
    )).resolves.toEqual({
      repository: "owner/repo",
      branch: "feature/pipeline",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      content,
    });
    expect(requested[1]).toContain(`ref=${"a".repeat(40)}`);
  });

  it("verifies a repository and creates its OpenThrottle webhook", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) {
        return Response.json({ full_name: "Acme/Widget", default_branch: "trunk" });
      }
      if (url.endsWith("/branches/develop")) return Response.json({ name: "develop" });
      if (url.endsWith("/hooks?per_page=100")) return Response.json([]);
      if (url.endsWith("/hooks") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          name: "web",
          active: true,
          events: [
            "pull_request",
            "pull_request_review",
            "issue_comment",
            "workflow_run",
            "check_suite",
          ],
          config: {
            url: "https://ot.test/webhooks/github",
            content_type: "json",
            secret: "webhook-secret",
            insecure_ssl: "0",
          },
        });
        return Response.json({ id: 42 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      prepareRepository(
        { token: "github", fetch: fetchMock },
        {
          repo: "acme/widget",
          requestedBaseBranch: "develop",
          webhookUrl: "https://ot.test/webhooks/github",
          webhookSecret: "webhook-secret",
        }
      )
    ).resolves.toEqual({
      repo: "Acme/Widget",
      baseBranch: "develop",
      webhookId: 42,
      webhookAction: "created",
    });
  });

  it("updates an existing OpenThrottle webhook", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) {
        return Response.json({ full_name: "acme/widget", default_branch: "main" });
      }
      if (url.endsWith("/branches/main")) return Response.json({ name: "main" });
      if (url.endsWith("/hooks?per_page=100")) {
        return Response.json([{ id: 7, config: { url: "https://ot.test/webhooks/github" } }]);
      }
      if (url.endsWith("/hooks/7") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).not.toHaveProperty("name");
        return Response.json({ id: 7 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await prepareRepository(
      { token: "github", fetch: fetchMock },
      {
        repo: "acme/widget",
        webhookUrl: "https://ot.test/webhooks/github",
        webhookSecret: "webhook-secret",
      }
    );
    expect(result).toMatchObject({ webhookId: 7, webhookAction: "updated" });
  });

  it("creates then updates one stable neutral PR summary without using the reviews API", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    let existing = false;
    const marker = "<!-- openthrottle:pipeline-summary:pipeline-1 -->";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/issues/7/comments?per_page=100")) {
        return Response.json(existing ? [{
          id: 99,
          body: `${marker}\nold`,
          html_url: "https://github.com/o/r/pull/7#issuecomment-99",
        }] : []);
      }
      if (url.endsWith("/issues/7/comments") && method === "POST") {
        existing = true;
        return Response.json({ id: 99, html_url: "https://github.com/o/r/pull/7#issuecomment-99" });
      }
      if (url.endsWith("/issues/comments/99") && method === "PATCH") {
        return Response.json({ id: 99, html_url: "https://github.com/o/r/pull/7#issuecomment-99" });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    }) as unknown as typeof fetch;
    const client = { token: "github", fetch: fetchMock };
    const first = await upsertPullRequestComment(client, "o/r", 7, "pipeline-1", `${marker}\nfirst`);
    const second = await upsertPullRequestComment(client, "o/r", 7, "pipeline-1", `${marker}\nsecond`);
    expect(first.id).toBe(99);
    expect(second.id).toBe(99);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(requests.some((request) => request.url.includes("/reviews"))).toBe(false);
  });
});
