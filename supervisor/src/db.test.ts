import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTicketStore, openDb, type TicketStore } from "./db.js";

describe("ticket store", () => {
  let db: ReturnType<typeof openDb>;
  let store: TicketStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createTicketStore(db);
    store.upsertUnpinned({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  });

  afterEach(() => db.close());

  it("does not create the removed session-work projection", () => {
    expect(db.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_work'"
    ).pluck().get()).toBe(0);
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-1",
      generation: 1,
      state: "current",
    });
  });

  it("serializes stage actors per ticket", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-2",
      taskType: "implement",
      tokenHash: "b".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(false);
    expect(store.finishRun({ runId: "run-1", status: "completed" })).toMatchObject({
      id: "run-1",
      status: "completed",
    });
    expect(store.getByIssueId("issue-1")?.run_id).toBeNull();
  });

  it("keeps Linear publication ordered and steering in the fenced inbox", () => {
    const first = store.enqueueLinearOutbox({
      id: "linear-1",
      linearSessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"thought"}',
    });
    const second = store.enqueueLinearOutbox({
      id: "linear-2",
      linearSessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"response"}',
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);

    const steer = store.enqueueInbox({
      id: "steer-1",
      issueId: "issue-1",
      sessionId: "session-1",
      source: "human",
      body: "Please check the edge case.",
    });
    expect(steer).toMatchObject({ id: "steer-1", status: "pending" });
    expect(store.listPendingInbox("issue-1")).toHaveLength(1);
    expect(store.cancelPendingInbox("issue-1")).toBe(1);
    expect(store.listPendingInbox("issue-1")).toHaveLength(0);
  });

  it("routes only through durable repository registrations", () => {
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    expect(store.getRepositoryRegistration(undefined, "eng")).toMatchObject({
      github_repo: "acme/widget",
      base_branch: "develop",
    });
    expect(store.getRepositoryRegistration("team-1", "OTHER")?.linear_team_key).toBe("ENG");
    expect(store.getRepositoryRegistration(undefined, "missing")).toBeUndefined();
  });

  it("deduplicates accepted webhooks and persists operator settings", () => {
    const claim = { deliveryId: "delivery-1", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);
    expect(store.claimDelivery(claim)).toBe(false);
    store.setSetting("catalog-digest", "abc123");
    expect(store.getSetting("catalog-digest")).toBe("abc123");
  });

  it("supersedes session generations without carrying actor state forward", () => {
    store.upsertUnpinned({
      ...store.getByIssueId("issue-1")!,
      linear_session_id: "session-2",
      sandbox_id: null,
    });
    expect(store.getSession("session-1")?.state).toBe("superseded");
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-2",
      generation: 2,
      state: "current",
    });
  });
});
