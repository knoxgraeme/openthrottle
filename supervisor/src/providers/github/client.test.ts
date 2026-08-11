import { createHmac } from "node:crypto";
import { parseExecutionPlanContract } from "@openthrottle/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../../persistence/store.js";
import { openDb } from "../../persistence/database.js";
import { createPipelineStore } from "../../persistence/pipeline/create-store.js";
import type { Config } from "../../app/config.js";
import {
  considerCiGithubHead,
  githubIssueAdmissionPreflight,
  githubIssueControlSessionId,
  handleGithubEvent,
} from "./events.js";
import { composeBoundedTaskContext } from "../../app/admission-context.js";
import { extractJsonBlocks } from "../../pipeline/markdown.js";
import {
  OPENTHROTTLE_WEBHOOK_EVENTS,
  branchExists,
  classifyGithubIssueComment,
  compareGithubIssueActivationAndComment,
  ensureRepositoryControlLabel,
  fetchGithubIssueControlEvents,
  fetchGithubIssueContext,
  getRepositoryConfigAtCommit,
  getRepositoryDirectoryAtCommit,
  getRepositoryFileAtCommit,
  getFailingGithubCheckDetails,
  getMergeReadiness,
  getRepositoryCollaboratorPermission,
  githubIssueControlEvent,
  githubIssuesEventCarriesExactControlLabel,
  isGithubPullRequestUrl,
  isOpenthrottleBranch,
  isAuthorizedGithubControlPermission,
  listFailedRepositoryWebhookDeliveries,
  parseGithubWebhook,
  parsePullRequestUrl,
  pinIssueComment,
  redeliverRepositoryWebhookDelivery,
  upsertIssueStatusComment,
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
        updated_at: "2026-08-11T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/12",
        labels: [{ name: "implement" }],
      },
    }));
    if (issueEvent.kind !== "issues") throw new Error("expected issues webhook");
    expect(githubIssueControlEvent(issueEvent)).toMatchObject({
      provider: "github",
      action: "created",
      providerActivatedAt: "2026-08-11T00:00:00Z",
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

  it("dispatches GitHub Issue admission only on the exact OpenThrottle label", () => {
    const labeled = parseGithubWebhook("issues", JSON.stringify({
      action: "labeled",
      repository: { full_name: "owner/repo" },
      label: { name: "openthrottle" },
      issue: {
        number: 12,
        title: "Add issue control",
        body: "Implement it.",
        html_url: "https://github.com/owner/repo/issues/12",
      },
    }));
    if (labeled.kind !== "issues") throw new Error("expected issues webhook");
    expect(githubIssuesEventCarriesExactControlLabel(labeled)).toBe(true);

    const fuzzy = parseGithubWebhook("issues", JSON.stringify({
      action: "labeled",
      repository: { full_name: "owner/repo" },
      label: { name: "OpenThrottle" },
      issue: {
        number: 12,
        title: "Add issue control",
        body: "Implement it.",
        html_url: "https://github.com/owner/repo/issues/12",
      },
    }));
    if (fuzzy.kind !== "issues") throw new Error("expected issues webhook");
    expect(githubIssuesEventCarriesExactControlLabel(fuzzy)).toBe(false);

    const opened = parseGithubWebhook("issues", JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      issue: {
        number: 13,
        title: "Add issue control",
        body: "Implement it.",
        html_url: "https://github.com/owner/repo/issues/13",
        labels: [{ name: "openthrottle" }],
      },
    }));
    if (opened.kind !== "issues") throw new Error("expected issues webhook");
    expect(githubIssuesEventCarriesExactControlLabel(opened)).toBe(true);
  });

  it("coalesces initial and active Issue label events while reopening terminal work into one deterministic new session", () => {
    const event = (action: "opened" | "labeled" | "reopened") => ({
      kind: "issues" as const,
      action,
      repository: { full_name: "owner/repo" },
      issue: {
        number: 12,
        title: "Ship it",
        html_url: "https://github.com/owner/repo/issues/12",
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-11T00:00:00.000Z",
      },
      ...(action === "labeled" ? { label: { name: "openthrottle" } } : {}),
    });
    const store = {
      getByExternalThread: vi.fn(() => undefined),
    } as never;
    const pipelines = { getInstanceForSession: vi.fn() } as never;

    expect(githubIssueControlSessionId({ store, pipelines, event: event("opened") }))
      .toBe("github:owner/repo#12:initial");
    expect(githubIssueControlSessionId({ store, pipelines, event: event("labeled") }))
      .toBe("github:owner/repo#12:initial");

    const ticket = { session_id: "github:owner/repo#12:initial" };
    (store as { getByExternalThread: ReturnType<typeof vi.fn> }).getByExternalThread
      .mockReturnValue(ticket);
    (pipelines as { getInstanceForSession: ReturnType<typeof vi.fn> }).getInstanceForSession
      .mockReturnValue({ status: "running", terminal_outcome: null });
    expect(githubIssueControlSessionId({ store, pipelines, event: event("labeled") }))
      .toBe(ticket.session_id);

    (pipelines as { getInstanceForSession: ReturnType<typeof vi.fn> }).getInstanceForSession
      .mockReturnValue({ status: "canceled", terminal_outcome: "canceled" });
    expect(githubIssueControlSessionId({
      store,
      pipelines,
      event: event("labeled"),
      providerActivationId: "event-101",
    })).toBe("github:owner/repo#12:label:event-101");
    expect(githubIssueControlSessionId({
      store,
      pipelines,
      event: event("labeled"),
      providerActivationId: "event-102",
    })).toBe("github:owner/repo#12:label:event-102");
    expect(githubIssueControlSessionId({
      store,
      pipelines,
      event: event("reopened"),
      providerActivationId: "event-103",
    })).toBe("github:owner/repo#12:reopened:event-103");
  });

  it("reconciles equal-second close and reopen conflicts from live provider state in either delivery order", async () => {
    const db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const pipelines = createPipelineStore(db);
    const observedAt = "2026-08-11T00:00:00Z";
    const providerStates = new Map<number, "open" | "closed">([
      [12, "open"],
      [13, "closed"],
      [14, "open"],
    ]);
    const eventHistory = (issueNumber: number) => issueNumber === 13
      ? [
          { id: 1300, event: "labeled", created_at: observedAt, label: { name: "openthrottle" }, actor: { login: "operator" } },
          { id: 1301, event: "reopened", created_at: observedAt, actor: { login: "operator" } },
          { id: 1302, event: "closed", created_at: observedAt, actor: { login: "operator" } },
        ]
      : [
          { id: issueNumber * 100, event: "labeled", created_at: observedAt, label: { name: "openthrottle" }, actor: { login: "operator" } },
          { id: issueNumber * 100 + 1, event: "closed", created_at: observedAt, actor: { login: "operator" } },
          { id: issueNumber * 100 + 2, event: "reopened", created_at: observedAt, actor: { login: "operator" } },
        ];
    let liveReads = 0;
    let eventReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (/\/repos\/owner\/repo\/issues\/(12|13|14)\/events\?per_page=100$/.test(url)) {
        eventReads += 1;
        const issueNumber = Number(url.match(/issues\/(\d+)\/events/)?.[1]);
        return Response.json(eventHistory(issueNumber));
      }
      if (/\/repos\/owner\/repo\/issues\/(12|13|14)$/.test(url)) {
        liveReads += 1;
        const issueNumber = Number(url.match(/issues\/(\d+)$/)?.[1]);
        const providerState = providerStates.get(issueNumber)!;
        return Response.json({
          number: issueNumber,
          title: "Ship it",
          html_url: `https://github.com/owner/repo/issues/${issueNumber}`,
          state: providerState,
          created_at: observedAt,
          updated_at: observedAt,
          labels: providerState === "open" ? [{ name: "openthrottle" }] : [],
        });
      }
      throw new Error(`unexpected GitHub request ${url}`);
    }));
    const cfg = { githubReadToken: "read-token" } as Config;
    const publisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    } as never;
    const issueEvent = (
      issueNumber: number,
      action: "closed" | "reopened"
    ) => ({
      kind: "issues" as const,
      action,
      repository: { full_name: "owner/repo" },
      sender: { login: "operator" },
      issue: {
        number: issueNumber,
        title: "Ship it",
        html_url: `https://github.com/owner/repo/issues/${issueNumber}`,
        state: action === "closed" ? "closed" as const : "open" as const,
        updated_at: observedAt,
        ...(action === "closed" ? { closed_at: observedAt } : {}),
        labels: action === "reopened" ? [{ name: "openthrottle" }] : [],
      },
    });
    const seedSession = (issueNumber: number, sessionId: string, activationId: string) => {
      store.upsertUnpinned({
        ticket_id: `github:owner/repo#${issueNumber}`,
        ticket_reference: `GH-${issueNumber}`,
        session_id: sessionId,
        control_provider: "github",
        external_thread_id: `owner/repo#${issueNumber}`,
        external_thread_reference: `GH-${issueNumber}`,
        provider_activated_at: observedAt,
        provider_activation_id: activationId,
        sandbox_id: null,
        branch: `ot/gh-${issueNumber}`,
        agent: "codex",
        repo: "owner/repo",
        base_branch: "main",
        pr_url: null,
        state: "active",
      });
    };

    try {
      // C→R with reverse webhook arrival: the provider sequence still stops A,
      // then a delayed close cannot stop successor R.
      seedSession(12, "session-12-a", "1200");
      await handleGithubEvent(cfg, store, publisher, issueEvent(12, "reopened"), pipelines);
      expect(store.getSession("session-12-a")?.state).toBe("stopped");
      seedSession(12, "session-12-r", "1202");
      await handleGithubEvent(cfg, store, publisher, issueEvent(12, "closed"), pipelines);
      expect(store.getCurrentSession("github:owner/repo#12")?.id).toBe("session-12-r");
      expect(store.getByIssueId("github:owner/repo#12")?.state).toBe("active");
      expect(JSON.parse(store.getSetting("github-issue-lifecycle:owner/repo#12")!))
        .toEqual({ state: "open", observedAt });

      // R→C with reverse webhook arrival: live closed plus provider sequence
      // prevents the reopen from preserving/admitting A.
      seedSession(13, "session-13-a", "1300");
      await handleGithubEvent(cfg, store, publisher, issueEvent(13, "reopened"), pipelines);
      expect(store.getSession("session-13-a")?.state).toBe("stopped");
      await handleGithubEvent(cfg, store, publisher, issueEvent(13, "closed"), pipelines);
      expect(store.getByIssueId("github:owner/repo#13")?.state).toBe("closed");
      expect(JSON.parse(store.getSetting("github-issue-lifecycle:owner/repo#13")!))
        .toEqual({ state: "closed", observedAt });

      // C→R in webhook order reaches the same result.
      seedSession(14, "session-14-a", "1400");
      await handleGithubEvent(cfg, store, publisher, issueEvent(14, "closed"), pipelines);
      expect(store.getSession("session-14-a")?.state).toBe("stopped");
      await handleGithubEvent(cfg, store, publisher, issueEvent(14, "reopened"), pipelines);
      seedSession(14, "session-14-r", "1402");
      expect(store.getCurrentSession("github:owner/repo#14")?.id).toBe("session-14-r");
      expect(liveReads).toBe(6);
      expect(eventReads).toBe(6);
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it("returns only body-free exact control events across bounded Issue Event pages", async () => {
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      event: "commented",
      created_at: "2026-08-11T00:00:30Z",
      actor: { login: "operator" },
      body: "untrusted body must not participate in activation proof",
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/events?per_page=100")) return Response.json(firstPage);
      if (url.endsWith("/events?per_page=100&page=2")) {
        return Response.json([
          {
            id: 101,
            event: "labeled",
            created_at: "2026-08-11T00:00:45Z",
            label: { name: "OpenThrottle" },
            actor: { login: "operator" },
          },
          {
            id: 102,
            event: "labeled",
            created_at: "2026-08-11T00:00:00Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          },
          {
            id: 103,
            event: "reopened",
            created_at: "2026-08-11T00:01:01Z",
            actor: { login: "operator" },
          },
          {
            id: 104,
            event: "labeled",
            created_at: "2026-08-11T00:00:45Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          },
          {
            id: 105,
            event: "unlabeled",
            created_at: "2026-08-11T00:02:00Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          },
        ]);
      }
      throw new Error(`unexpected GitHub request ${url}`);
    });

    await expect(fetchGithubIssueControlEvents(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      12
    )).resolves.toEqual([
      {
        id: "102",
        kind: "labeled",
        createdAt: "2026-08-11T00:00:00Z",
        actorLogin: "operator",
      },
      {
        id: "103",
        kind: "reopened",
        createdAt: "2026-08-11T00:01:01Z",
        actorLogin: "operator",
      },
      {
        id: "104",
        kind: "labeled",
        createdAt: "2026-08-11T00:00:45Z",
        actorLogin: "operator",
      },
      {
        id: "105",
        kind: "unlabeled",
        createdAt: "2026-08-11T00:02:00Z",
        actorLogin: "operator",
      },
    ]);
    expect(requests).toHaveLength(2);
  });

  it("orders equal-second activation and comments only by their bounded provider timeline sequence", async () => {
    const activation = {
      id: "905",
      event: "labeled",
      created_at: "2026-08-11T00:03:00Z",
      label: { name: "openthrottle" },
      actor: { login: "operator" },
    };
    const comment = {
      id: 112,
      event: "commented",
      created_at: "2026-08-11T00:03:00Z",
      actor: { login: "operator" },
      body: "untrusted body is discarded after the bounded response is parsed",
    };
    for (const [events, expected] of [
      [[activation, comment], "activation_before_comment"],
      [[comment, activation], "comment_before_activation"],
    ] as const) {
      const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(events));
      await expect(compareGithubIssueActivationAndComment(
        { token: "read-token", fetch: fetchMock },
        "owner/repo",
        12,
        {
          activation: { id: "905", createdAt: activation.created_at, actorLogin: "operator" },
          comment: { id: "112", createdAt: comment.created_at, actorLogin: "operator" },
        }
      )).resolves.toBe(expected);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/timeline?per_page=100");
    }
  });

  it("fails timeline ordering closed at the response-byte and page bounds", async () => {
    const oversizedFetch = vi.fn(async () => Response.json([{
      id: 1,
      event: "commented",
      created_at: "2026-08-11T00:03:00Z",
      actor: { login: "operator" },
      body: "x".repeat(600_000),
    }]));
    const comparison = {
      activation: { id: "905", createdAt: "2026-08-11T00:03:00Z" },
      comment: { id: "112", createdAt: "2026-08-11T00:03:00Z", actorLogin: "operator" },
    };
    await expect(compareGithubIssueActivationAndComment(
      { token: "read-token", fetch: oversizedFetch },
      "owner/repo",
      12,
      comparison
    )).resolves.toBe("unresolved");
    expect(oversizedFetch).toHaveBeenCalledTimes(1);

    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      event: "assigned",
      created_at: "2026-08-11T00:03:00Z",
      actor: { login: "operator" },
    }));
    const paginatedFetch = vi.fn(async () => Response.json(fullPage));
    await expect(compareGithubIssueActivationAndComment(
      { token: "read-token", fetch: paginatedFetch },
      "owner/repo",
      12,
      comparison
    )).resolves.toBe("unresolved");
    expect(paginatedFetch).toHaveBeenCalledTimes(10);
  });

  it("fails the final admission preflight when the control label was removed after activation", async () => {
    const db = openDb(":memory:");
    const store = createSupervisorStore(db);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      number: 12,
      state: "open",
      created_at: "2026-08-11T00:00:00Z",
      updated_at: "2026-08-11T00:01:00Z",
      labels: [],
    })));
    try {
      const preflight = githubIssueAdmissionPreflight({
        cfg: { githubReadToken: "read-token" } as Config,
        store,
        repository: "owner/repo",
        issueNumber: 12,
        expectedProviderActivation: { id: "905", actorLogin: "operator" },
      });
      await expect(preflight({ repository: "owner/repo", baseCommit: "abc123" }))
        .resolves.toEqual({
          ok: false,
          reason: expect.stringContaining("no longer has the exact openthrottle control label"),
        });
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it("fails the final admission preflight when selection outlives its exact activation epoch", async () => {
    const db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/12")) {
        return Response.json({
          number: 12,
          state: "open",
          created_at: "2026-08-11T00:00:00Z",
          updated_at: "2026-08-11T00:03:00Z",
          labels: [{ name: "openthrottle" }],
        });
      }
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/events?per_page=100")) {
        return Response.json([{
          id: 906,
          event: "labeled",
          created_at: "2026-08-11T00:03:00Z",
          label: { name: "openthrottle" },
          actor: { login: "operator" },
        }]);
      }
      throw new Error(`unexpected GitHub request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const preflight = githubIssueAdmissionPreflight({
        cfg: { githubReadToken: "read-token" } as Config,
        store,
        repository: "owner/repo",
        issueNumber: 12,
        expectedProviderActivation: { id: "905", actorLogin: "operator" },
      });
      await expect(preflight({ repository: "owner/repo", baseCommit: "abc123" }))
        .resolves.toEqual({
          ok: false,
          reason: expect.stringContaining("activation epoch changed"),
        });
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it("fails the final admission preflight when the exact label is removed after its live read", async () => {
    const db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/12")) {
        return Response.json({
          number: 12,
          state: "open",
          created_at: "2026-08-11T00:00:00Z",
          updated_at: "2026-08-11T00:03:00Z",
          labels: [{ name: "openthrottle" }],
        });
      }
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/events?per_page=100")) {
        return Response.json([
          {
            id: 905,
            event: "labeled",
            created_at: "2026-08-11T00:03:00Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          },
          {
            id: 906,
            event: "unlabeled",
            created_at: "2026-08-11T00:03:01Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          },
        ]);
      }
      throw new Error(`unexpected GitHub request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const preflight = githubIssueAdmissionPreflight({
        cfg: { githubReadToken: "read-token" } as Config,
        store,
        repository: "owner/repo",
        issueNumber: 12,
        expectedProviderActivation: { id: "905", actorLogin: "operator" },
      });
      await expect(preflight({ repository: "owner/repo", baseCommit: "abc123" }))
        .resolves.toEqual({
          ok: false,
          reason: expect.stringContaining("activation epoch changed"),
        });
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it("fails closed when the bounded Issue Event history cannot reach its newest page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      event: "assigned",
      created_at: "2026-08-11T00:00:00Z",
      actor: { login: "operator" },
    }));
    const fetchMock = vi.fn(async () => Response.json(fullPage));

    await expect(fetchGithubIssueControlEvents(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      12
    )).rejects.toThrow("exceeded the bounded scan");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("maps current GitHub collaborator permissions and authorizes triage or stronger", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json({ permission: "read", role_name: requests.length === 1 ? "triage" : "pull" });
    });
    await expect(getRepositoryCollaboratorPermission(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      "octocat"
    )).resolves.toBe("triage");
    await expect(getRepositoryCollaboratorPermission(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      "octocat"
    )).resolves.toBe("read");
    expect(isAuthorizedGithubControlPermission("triage")).toBe(true);
    expect(isAuthorizedGithubControlPermission("read")).toBe(false);
    expect(requests[0]).toBe("https://api.github.com/repos/owner/repo/collaborators/octocat/permission");
  });

  it("fetches deterministic bounded GitHub Issue context with pre-admission comments", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/12")) {
        return Response.json({
          number: 12,
          title: "Use <GitHub> control",
          body: "Implement & verify.",
          html_url: "https://github.com/owner/repo/issues/12",
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json(Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: `Pre-admission comment ${index + 1}.`,
          html_url: `https://github.com/owner/repo/issues/12#issuecomment-${index + 1}`,
          created_at: `2026-08-10T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          user: { login: `author-${index + 1}` },
        })));
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100&page=2")) {
        return Response.json(Array.from({ length: 5 }, (_, index) => ({
          id: index + 101,
          body: `Newest pre-admission comment ${index + 101}.`,
          html_url: `https://github.com/owner/repo/issues/12#issuecomment-${index + 101}`,
          created_at: `2026-08-11T00:0${index}:00.000Z`,
          user: { login: `new-author-${index + 101}` },
        })));
      }
      throw new Error(`unexpected request ${url}`);
    });

    const context = await fetchGithubIssueContext(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      12
    );

    expect(context.length).toBeLessThanOrEqual(64_000);
    expect(context).toContain(`<issue identifier="GH-12">`);
    expect(context).toContain("Use &lt;GitHub&gt; control");
    expect(context).toContain(`<primary-directive-thread comment-id="github-issue-body">`);
    expect(context).toContain(`<comment>Implement &amp; verify.</comment>`);
    expect(context).not.toContain("<description>");
    expect(context).toContain(`<other-thread comment-id="github-comment-101"`);
    expect(context).toContain(`author="new-author-101"`);
    expect(context).toContain(`url="https://github.com/owner/repo/issues/12#issuecomment-101"`);
    expect(context).toContain("Newest pre-admission comment 105.");
    expect(context.indexOf("comment 101.")).toBeLessThan(context.indexOf("comment 105."));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an Issue body selection authoritative exactly once through admission context", async () => {
    const instruction = "A & B < C > D";
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "github-context-round-trip",
      instructions: { compare: instruction },
      acceptance: { exact: "The instruction round-trips exactly." },
      units: [{
        id: "context",
        title: "Preserve context",
        depends_on: [],
        instructions: ["compare"],
        acceptance: ["exact"],
      }],
      commands: [],
    };
    const selection = {
      schema: "openthrottle.ship-selection/v1",
      graph_id: "structured",
    };
    const body = [
      "Implement the <approved> & reviewed plan.",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
      "```json openthrottle.ship-selection/v1",
      JSON.stringify(selection, null, 2),
      "```",
    ].join("\n");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/194")) {
        return Response.json({
          number: 194,
          title: "Ship the structured plan",
          body,
          html_url: "https://github.com/owner/repo/issues/194",
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/194/comments?per_page=100")) {
        return Response.json([]);
      }
      throw new Error(`unexpected request ${url}`);
    });

    const context = await fetchGithubIssueContext(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      194
    );
    const admission = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "GH-194",
    });
    const selections = extractJsonBlocks(
      admission.selectionContext,
      "openthrottle.ship-selection/v1"
    );
    const plans = extractJsonBlocks(
      admission.selectionContext,
      "openthrottle.execution-plan/v1"
    );

    expect(admission.selectionError).toBeUndefined();
    expect(admission.ordinaryLimitError).toBeUndefined();
    expect(context.match(/```json openthrottle\.ship-selection\/v1/g)).toHaveLength(1);
    expect(selections).toHaveLength(1);
    expect(plans).toHaveLength(1);
    expect(JSON.parse(selections[0]!)).toEqual(selection);
    expect(parseExecutionPlanContract(plans[0]!, { source: "github.issue" }).value)
      .toMatchObject({ instructions: { compare: instruction } });
    expect(admission.context).toContain("A &amp; B &lt; C &gt; D");
    expect(admission.selectionContext).toContain("Ship the structured plan");
    expect(admission.selectionContext).toContain("Implement the <approved> & reviewed plan.");
  });

  it.each([null, "", " \n\t"])(
    "uses the Issue title as the primary directive when the body is empty or whitespace-only",
    async (body) => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/repos/owner/repo/issues/195")) {
          return Response.json({
            number: 195,
            title: "Ship <empty> body & preserve direction",
            body,
            html_url: "https://github.com/owner/repo/issues/195",
          });
        }
        if (url.endsWith("/repos/owner/repo/issues/195/comments?per_page=100")) {
          return Response.json([]);
        }
        throw new Error(`unexpected request ${url}`);
      });

      const context = await fetchGithubIssueContext(
        { token: "read-token", fetch: fetchMock },
        "owner/repo",
        195
      );
      const admission = composeBoundedTaskContext(context, {
        requireLinearSections: true,
        expectedIssueIdentifier: "GH-195",
      });

      expect(admission.selectionError).toBeUndefined();
      expect(admission.ordinaryLimitError).toBeUndefined();
      expect(context).toContain(`<title>Ship &lt;empty&gt; body &amp; preserve direction</title>`);
      expect(context).toContain(`<comment>Ship &lt;empty&gt; body &amp; preserve direction</comment>`);
      expect(context).not.toContain("<description>");
      expect(admission.selectionContext).toContain("Ship <empty> body & preserve direction");
    }
  );

  it("redacts raw Issue fields before XML encoding", async () => {
    const secret = "A&B<C";
    const previousSecret = process.env.GITHUB_CONTEXT_TEST_SECRET;
    process.env.GITHUB_CONTEXT_TEST_SECRET = secret;
    try {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/repos/owner/repo/issues/196")) {
          return Response.json({
            number: 196,
            title: `Keep ${secret} out of context`,
            body: `Implement without ${secret}.`,
            html_url: "https://github.com/owner/repo/issues/196",
          });
        }
        if (url.endsWith("/repos/owner/repo/issues/196/comments?per_page=100")) {
          return Response.json([{
            id: 1,
            body: `Comment includes ${secret}.`,
            html_url: `https://github.com/owner/repo/issues/196#${secret}`,
            created_at: "2026-08-11T00:00:00.000Z",
            user: { login: `author-${secret}` },
          }]);
        }
        throw new Error(`unexpected request ${url}`);
      });

      const context = await fetchGithubIssueContext(
        { token: "read-token", fetch: fetchMock },
        "owner/repo",
        196
      );
      const admission = composeBoundedTaskContext(context, {
        requireLinearSections: true,
        expectedIssueIdentifier: "GH-196",
      });

      expect(context).toContain("[REDACTED]");
      expect(context).not.toContain(secret);
      expect(context).not.toContain("A&amp;B&lt;C");
      expect(admission.context).not.toContain(secret);
      expect(admission.context).not.toContain("A&amp;B&lt;C");
    } finally {
      if (previousSecret === undefined) delete process.env.GITHUB_CONTEXT_TEST_SECRET;
      else process.env.GITHUB_CONTEXT_TEST_SECRET = previousSecret;
    }
  });

  it("rejects entity-expanded required Issue context without truncating its tail selection", async () => {
    const selection = {
      schema: "openthrottle.ship-selection/v1",
      graph_id: "structured",
    };
    const body = [
      "&".repeat(13_000),
      "```json openthrottle.ship-selection/v1",
      JSON.stringify(selection),
      "```",
    ].join("\n");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/197")) {
        return Response.json({
          number: 197,
          title: "Bound entity expansion",
          body,
          html_url: "https://github.com/owner/repo/issues/197",
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/197/comments?per_page=100")) {
        return Response.json([{
          id: 1,
          body: "Optional history",
          html_url: "https://github.com/owner/repo/issues/197#issuecomment-1",
          created_at: "2026-08-11T00:00:00.000Z",
          user: { login: "operator" },
        }]);
      }
      throw new Error(`unexpected request ${url}`);
    });

    const context = await fetchGithubIssueContext(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      197
    );
    const admission = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "GH-197",
    });
    const selections = extractJsonBlocks(
      admission.selectionContext,
      "openthrottle.ship-selection/v1"
    );

    expect(Buffer.byteLength(context, "utf8")).toBeGreaterThan(64_000);
    expect(admission.selectionError).toBeUndefined();
    expect(admission.ordinaryLimitError).toContain("required content exceeds 64000 bytes");
    expect(context.match(/```json openthrottle\.ship-selection\/v1/g)).toHaveLength(1);
    expect(selections).toHaveLength(1);
    expect(JSON.parse(selections[0]!)).toEqual(selection);
    expect(admission.context).toContain('comment-id="github-comments-omitted"');
    expect(admission.context).not.toContain("Optional history");
  });

  it("fails closed when composition cannot retain the GitHub comment-omission marker", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/198")) {
        return Response.json({
          number: 198,
          title: "Preserve omission metadata",
          body: "&".repeat(12_725),
          html_url: "https://github.com/owner/repo/issues/198",
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/198/comments?per_page=100")) {
        return Response.json([{
          id: 1,
          body: "Optional history",
          html_url: "https://github.com/owner/repo/issues/198#issuecomment-1",
          created_at: "2026-08-11T00:00:00.000Z",
          user: { login: "operator" },
        }]);
      }
      throw new Error(`unexpected request ${url}`);
    });

    const context = await fetchGithubIssueContext(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      198
    );
    const admission = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "GH-198",
    });

    expect(Buffer.byteLength(context, "utf8")).toBeGreaterThan(64_000);
    expect(context).toContain('comment-id="github-comments-omitted"');
    expect(context).not.toContain("Optional history");
    expect(admission.selectionError).toBeUndefined();
    expect(admission.ordinaryLimitError).toContain("required content exceeds 64000 bytes");
    expect(admission.context).toBe(context);
    expect(admission.selectionContext).not.toContain("github-comments-omitted");
    expect(admission.context).not.toContain("Optional history");
  });

  it("retains the newest Issue comments that fit and emits a deterministic omission marker", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/44")) {
        return Response.json({
          number: 44,
          title: "Bound context",
          body: "Keep recent operator direction.",
          html_url: "https://github.com/owner/repo/issues/44",
        });
      }
      if (url.includes("/repos/owner/repo/issues/44/comments?")) {
        return Response.json(Array.from({ length: 100 }, (_, index) => {
          const page = Number(new URL(url).searchParams.get("page") ?? "1");
          const id = ((page - 1) * 100) + index + 1;
          return {
            id,
            body: `${id === 1 ? "oldest" : id === 1_000 ? "newest" : `comment-${id}`} ${"x".repeat(3_950)}`,
            html_url: `https://github.com/owner/repo/issues/44#issuecomment-${id}`,
            created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
            user: { login: "operator" },
          };
        }));
      }
      throw new Error(`unexpected request ${url}`);
    });

    const context = await fetchGithubIssueContext(
      { token: "read-token", fetch: fetchMock },
      "owner/repo",
      44
    );

    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(64_000);
    expect(context).toContain("newest");
    expect(context).not.toContain("oldest");
    expect(context).toContain("github-comments-omitted");
    expect(fetchMock).toHaveBeenCalledTimes(11);

    const admission = composeBoundedTaskContext(context, {
      requireLinearSections: true,
      expectedIssueIdentifier: "GH-44",
    });
    expect(admission.selectionError).toBeUndefined();
    expect(admission.ordinaryLimitError).toBeUndefined();
    expect(admission.context).toContain('comment-id="github-comments-omitted"');
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

  it("ensures the repository has the exact lowercase OpenThrottle control label", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/repos/acme/widget/labels?per_page=100")) {
        return Response.json([{ name: "OpenThrottle", color: "ffffff" }]);
      }
      if (url.endsWith("/repos/acme/widget/labels/OpenThrottle") && method === "PATCH") {
        return Response.json({ name: "openthrottle" });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    });

    await expect(ensureRepositoryControlLabel(
      { token: "github", fetch: fetchMock },
      "acme/widget"
    )).resolves.toBe("renamed");
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      body: { new_name: "openthrottle" },
    });
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

  it("creates then updates one stable marked Issue status comment", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    let existing = false;
    const marker = "<!-- openthrottle:pipeline-status:github:owner/repo#12 -->";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/issues/12/comments?per_page=100")) {
        return Response.json(existing ? [{
          id: 101,
          body: `${marker}\nold`,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-101",
        }] : []);
      }
      if (url.endsWith("/issues/12/comments") && method === "POST") {
        existing = true;
        return Response.json({ id: 101, html_url: "https://github.com/owner/repo/issues/12#issuecomment-101" });
      }
      if (url.endsWith("/issues/comments/101") && method === "PATCH") {
        return Response.json({ id: 101, html_url: "https://github.com/owner/repo/issues/12#issuecomment-101" });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    }) as unknown as typeof fetch;
    const client = { token: "github", fetch: fetchMock };

    const first = await upsertIssueStatusComment(client, "owner/repo", 12, marker, `${marker}\nfirst`);
    const second = await upsertIssueStatusComment(client, "owner/repo", 12, marker, `${marker}\nsecond`);

    expect(first.id).toBe(101);
    expect(second.id).toBe(101);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("matches stable comments only at the exact prefix and never adopts another user's marker", async () => {
    const marker = "<!-- openthrottle:pipeline-status:github:owner/repo#12 -->";
    const requests: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/issues/12/comments?per_page=100")) {
        return Response.json([
          {
            id: 1,
            body: `User quoted ${marker}\nnot supervisor output`,
            html_url: "https://github.com/owner/repo/issues/12#issuecomment-1",
            user: { login: "operator" },
          },
          {
            id: 2,
            body: `${marker}\nuser-authored collision`,
            html_url: "https://github.com/owner/repo/issues/12#issuecomment-2",
            user: { login: "operator" },
          },
          {
            id: 3,
            body: `${marker}\nsupervisor output`,
            html_url: "https://github.com/owner/repo/issues/12#issuecomment-3",
            user: { login: "openthrottle-bot" },
          },
        ]);
      }
      if (url.endsWith("/user")) return Response.json({ login: "openthrottle-bot" });
      if (url.endsWith("/issues/comments/3") && method === "PATCH") {
        return Response.json({ id: 3, html_url: "https://github.com/owner/repo/issues/12#issuecomment-3" });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    });

    await expect(upsertIssueStatusComment(
      { token: "github", fetch: fetchMock },
      "owner/repo",
      12,
      marker,
      `${marker}\nupdated`
    )).resolves.toMatchObject({ id: 3 });
    expect(requests.some((request) => request.url.endsWith("/issues/comments/2"))).toBe(false);
  });

  it("pins Issue comments and lists and redelivers failed repository webhook deliveries", async () => {
    const requests: Array<{ url: string; method: string; apiVersion?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method,
        ...(headers.get("X-GitHub-Api-Version")
          ? { apiVersion: headers.get("X-GitHub-Api-Version")! }
          : {}),
      });
      if (url.endsWith("/repos/owner/repo/hooks/9/deliveries?per_page=25")) {
        return Response.json([
          { id: 10, guid: "guid-ok", status_code: 204, redelivery: false, delivered_at: "2026-08-10T00:00:00Z" },
          { id: 11, guid: "guid-failed", status_code: 503, redelivery: true, delivered_at: "2026-08-10T00:01:00Z" },
        ]);
      }
      if (url.endsWith("/repos/owner/repo/issues/comments/77/pin") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/repos/owner/repo/hooks/9/deliveries/11/attempts") && method === "POST") {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    });
    const client = { token: "github", fetch: fetchMock };

    await expect(pinIssueComment(client, "owner/repo", 77)).resolves.toBeUndefined();
    await expect(listFailedRepositoryWebhookDeliveries(client, "owner/repo", 9, 25))
      .resolves.toEqual([{
        id: 11,
        guid: "guid-failed",
        status_code: 503,
        redelivery: true,
        delivered_at: "2026-08-10T00:01:00Z",
      }]);
    await expect(redeliverRepositoryWebhookDelivery(client, "owner/repo", 9, 11))
      .resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(["PUT", "GET", "POST"]);
    expect(requests[0]).toMatchObject({ apiVersion: "2026-03-10" });
    expect(requests[1]).toMatchObject({ apiVersion: "2022-11-28" });
  });
});
