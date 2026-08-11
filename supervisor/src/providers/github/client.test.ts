import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../../persistence/store.js";
import { openDb } from "../../persistence/database.js";
import { considerCiGithubHead } from "./events.js";
import {
  OPENTHROTTLE_WEBHOOK_EVENTS,
  branchExists,
  classifyGithubIssueComment,
  getRepositoryConfigAtCommit,
  getRepositoryDirectoryAtCommit,
  getRepositoryFileAtCommit,
  getFailingGithubCheckDetails,
  getMergeReadiness,
  githubIssueControlEvent,
  isGithubPullRequestUrl,
  isOpenthrottleBranch,
  parseGithubWebhook,
  parsePullRequestUrl,
  prepareRepository,
  reconcileRepositoryWebhook,
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
    const review = JSON.stringify({
      action: "submitted",
      repository: { full_name: "o/r" },
      pull_request: {
        number: 1,
        html_url: "https://github.com/o/r/pull/1",
        merged_at: null,
        head: { ref: "ot/test" },
        base: { ref: "main" },
      },
      review: {
        id: 9,
        state: "commented",
        html_url: "https://github.com/o/r/pull/1#pullrequestreview-9",
        user: { login: "reviewer" },
      },
    });
    expect(parseGithubWebhook("pull_request_review", review)).toMatchObject({
      kind: "pull_request_review",
      review: { id: 9 },
    });
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
    const plainIssue = JSON.stringify({
      action: "opened",
      repository: { full_name: "o/r" },
      issue: {
        number: 3,
        title: "Ship GitHub control",
        body: "Use the issue as the control thread.",
        html_url: "https://github.com/o/r/issues/3",
        user: { login: "operator" },
        labels: [{ name: "agent:codex" }],
      },
    });
    expect(parseGithubWebhook("issues", plainIssue)).toMatchObject({
      kind: "issues",
      issue: { number: 3, title: "Ship GitHub control" },
    });
    expect(OPENTHROTTLE_WEBHOOK_EVENTS).toContain("issues");
    expect(() =>
      parseGithubWebhook(
        "issue_comment",
        JSON.stringify({ action: "created", repository: { full_name: "o/r" }, issue: { number: 1 } })
      )
    ).toThrow(/comment/);
    expect(() =>
      parseGithubWebhook(
        "issues",
        JSON.stringify({
          action: "opened",
          repository: { full_name: "o/r" },
          issue: {
            number: 1,
            title: "PR-shaped issue",
            html_url: "https://github.com/o/r/pull/1",
            pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" },
          },
        })
      )
    ).toThrow(/pull request/);
    expect(() => parseGithubWebhook("pull_request", "[]")).toThrow(/object/);
    expect(() =>
      parseGithubWebhook("pull_request", JSON.stringify({ action: "closed", repository: { full_name: "o/r" } }))
    ).toThrow(/pull_request/);
  });

  it("classifies plain Issues separately from PR comments and derives provider-qualified control identity", () => {
    const issueEvent = parseGithubWebhook("issues", JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      issue: {
        number: 12,
        title: "Add issue control",
        body: "Implement the provider contract.",
        html_url: "https://github.com/owner/repo/issues/12",
        labels: [{ name: "implement" }],
      },
    }));
    if (issueEvent.kind !== "issues") throw new Error("expected issues webhook");
    expect(githubIssueControlEvent(issueEvent)).toMatchObject({
      provider: "github",
      action: "created",
      promptContext: "Implement the provider contract.",
      agentSession: {
        id: "github:owner/repo#12",
        threadId: "owner/repo#12",
        thread: {
          id: "owner/repo#12",
          identifier: "GH-12",
          provider: "github",
          route: { key: "owner/repo" },
        },
      },
    });

    const plainComment = parseGithubWebhook("issue_comment", JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: {
        id: 99,
        body: "Please continue.",
        html_url: "https://github.com/owner/repo/issues/12#issuecomment-99",
      },
    }));
    if (plainComment.kind !== "issue_comment") throw new Error("expected issue_comment webhook");
    expect(classifyGithubIssueComment(plainComment)).toBe("plain_issue_comment");
    expect(githubIssueControlEvent(plainComment)).toMatchObject({
      provider: "github",
      action: "prompted",
      activity: {
        id: "github-comment:99",
        body: "Please continue.",
      },
    });

    const pullComment = parseGithubWebhook("issue_comment", JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" } },
      comment: {
        id: 100,
        body: "Repair the PR.",
        html_url: "https://github.com/owner/repo/pull/7#issuecomment-100",
      },
    }));
    if (pullComment.kind !== "issue_comment") throw new Error("expected issue_comment webhook");
    expect(classifyGithubIssueComment(pullComment)).toBe("pull_request_comment");
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

  it("reads a bounded repository file only from a pinned commit and safe path", async () => {
    const content = "{\"schema\":\"openthrottle.graph/v1\"}\n";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain(`/contents/.openthrottle/graphs/docs.json?ref=${"a".repeat(40)}`);
      return Response.json({
        type: "file",
        sha: "c".repeat(40),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }) as unknown as typeof fetch;
    const client = { token: "github", fetch: fetchMock };

    await expect(
      getRepositoryFileAtCommit(
        client,
        "owner/repo",
        "a".repeat(40),
        ".openthrottle/graphs/docs.json"
      )
    ).resolves.toEqual({
      repository: "owner/repo",
      commit: "a".repeat(40),
      path: ".openthrottle/graphs/docs.json",
      blobSha: "c".repeat(40),
      content,
    });
    await expect(
      getRepositoryFileAtCommit(client, "owner/repo", "a".repeat(40), "../secret")
    ).rejects.toThrow(/safe relative path/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects repository file snapshots that are symlinks, oversized, or blob-inconsistent", async () => {
    const content = "{}\n";
    for (const [response, error] of [
      [{
        type: "symlink",
        sha: "c".repeat(40),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      }, /invalid repository file blob/],
      [{
        type: "file",
        sha: "c".repeat(40),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: 256 * 1024 + 1,
      }, /exceeds the 256 KiB snapshot limit/],
      [{
        type: "file",
        sha: "c".repeat(40),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content) + 1,
      }, /content size does not match GitHub metadata/],
    ] as const) {
      const client = {
        token: "github",
        fetch: vi.fn(async () => Response.json(response)) as unknown as typeof fetch,
      };
      await expect(
        getRepositoryFileAtCommit(
          client,
          "owner/repo",
          "a".repeat(40),
          ".openthrottle/graphs/docs.json"
        )
      ).rejects.toThrow(error);
    }
  });

  it("reads a bounded repository directory package from a pinned commit", async () => {
    const skill = "---\nname: implement-unit\n---\n# Implement Unit\n";
    const helper = "extra: true\n";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return Response.json({ tree: { sha: "e".repeat(40) } });
      }
      if (url.endsWith(`/git/trees/${"e".repeat(40)}?recursive=1`)) {
        return Response.json({
          truncated: false,
          tree: [
            { path: ".openthrottle/skills/implement_unit", mode: "040000", type: "tree", sha: "1".repeat(40) },
            { path: ".openthrottle/skills/implement_unit/SKILL.md", mode: "100644", type: "blob", sha: "d".repeat(40), size: Buffer.byteLength(skill) },
            { path: ".openthrottle/skills/implement_unit/references/helper.md", mode: "100644", type: "blob", sha: "f".repeat(40), size: Buffer.byteLength(helper) },
            { path: ".openthrottle/skills/other/SKILL.md", mode: "100644", type: "blob", sha: "f".repeat(40), size: 1 },
          ],
        });
      }
      if (url.endsWith(`/git/blobs/${"d".repeat(40)}`)) {
        return Response.json({
          sha: "d".repeat(40),
          encoding: "base64",
          content: Buffer.from(skill).toString("base64"),
          size: Buffer.byteLength(skill),
        });
      }
      if (url.endsWith(`/git/blobs/${"f".repeat(40)}`)) {
        return Response.json({
          sha: "f".repeat(40),
          encoding: "base64",
          content: Buffer.from(helper).toString("base64"),
          size: Buffer.byteLength(helper),
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;

    await expect(getRepositoryDirectoryAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      "a".repeat(40),
      ".openthrottle/skills/implement_unit"
    )).resolves.toMatchObject({
      repository: "owner/repo",
      commit: "a".repeat(40),
      directory: ".openthrottle/skills/implement_unit",
      files: [
        { path: ".openthrottle/skills/implement_unit/references/helper.md", blobSha: "f".repeat(40), content: helper },
        { path: ".openthrottle/skills/implement_unit/SKILL.md", blobSha: "d".repeat(40), content: skill },
      ],
    });
  });

  it("rejects repository directory packages with symlinks or traversal", async () => {
    await expect(
      getRepositoryDirectoryAtCommit(
        { token: "github", fetch: vi.fn() as unknown as typeof fetch },
        "owner/repo",
        "a".repeat(40),
        "../skills"
      )
    ).rejects.toThrow(/safe relative path/);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return Response.json({ tree: { sha: "e".repeat(40) } });
      }
      if (url.endsWith(`/git/trees/${"e".repeat(40)}?recursive=1`)) {
        return Response.json({
          truncated: false,
          tree: [
            { path: ".openthrottle/skills/implement_unit/SKILL.md", mode: "120000", type: "blob", sha: "d".repeat(40), size: 10 },
          ],
        });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    await expect(getRepositoryDirectoryAtCommit(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      "a".repeat(40),
      ".openthrottle/skills/implement_unit"
    )).rejects.toThrow(/not a regular file/);
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
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
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

  it("reconciles a persisted webhook whose subscribed event list drifted", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget/hooks/7") && !init?.method) {
        return Response.json({
          id: 7,
          active: true,
          events: ["pull_request", "pull_request_review", "workflow_run", "check_suite"],
          config: { url: "https://ot.test/webhooks/github" },
        });
      }
      if (url.endsWith("/repos/acme/widget/hooks/7") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          active: true,
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
          config: { url: "https://ot.test/webhooks/github" },
        });
        return Response.json({ id: 7 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(reconcileRepositoryWebhook(
      { token: "github", fetch: fetchMock },
      {
        repo: "acme/widget",
        webhookId: 7,
        webhookUrl: "https://ot.test/webhooks/github",
        webhookSecret: "webhook-secret",
      }
    )).resolves.toEqual({
      repo: "acme/widget",
      webhookId: 7,
      webhookAction: "updated",
      missingEvents: ["issues", "issue_comment"],
    });
  });

  it("reconciles a deleted persisted webhook by adopting an existing hook with the configured URL", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget/hooks/7") && !init?.method) {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/repos/acme/widget/hooks?per_page=100")) {
        return Response.json([{
          id: 8,
          active: true,
          events: ["pull_request"],
          config: { url: "https://ot.test/webhooks/github" },
        }]);
      }
      if (url.endsWith("/repos/acme/widget/hooks/8") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          active: true,
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
        });
        return Response.json({ id: 8 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(reconcileRepositoryWebhook(
      { token: "github", fetch: fetchMock },
      {
        repo: "acme/widget",
        webhookId: 7,
        webhookUrl: "https://ot.test/webhooks/github",
        webhookSecret: "webhook-secret",
      }
    )).resolves.toEqual({
      repo: "acme/widget",
      webhookId: 8,
      webhookAction: "updated",
      missingEvents: ["issues", "pull_request_review", "issue_comment", "workflow_run", "check_suite"],
    });
  });

  it("recreates a deleted persisted webhook when no matching URL remains", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget/hooks/7") && !init?.method) {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/repos/acme/widget/hooks?per_page=100")) {
        return Response.json([{ id: 2, active: true, events: [], config: { url: "https://other.test/hook" } }]);
      }
      if (url.endsWith("/repos/acme/widget/hooks") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          name: "web",
          active: true,
          events: OPENTHROTTLE_WEBHOOK_EVENTS,
          config: { url: "https://ot.test/webhooks/github" },
        });
        return Response.json({ id: 9 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(reconcileRepositoryWebhook(
      { token: "github", fetch: fetchMock },
      {
        repo: "acme/widget",
        webhookId: 7,
        webhookUrl: "https://ot.test/webhooks/github",
        webhookSecret: "webhook-secret",
      }
    )).resolves.toEqual({
      repo: "acme/widget",
      webhookId: 9,
      webhookAction: "created",
      missingEvents: [
        ...OPENTHROTTLE_WEBHOOK_EVENTS,
      ],
    });
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
