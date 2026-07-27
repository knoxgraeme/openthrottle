import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("steering store", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
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

  it("keeps steering in the fenced inbox", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-steer",
      taskType: "implement",
      tokenHash: "steering-token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    const steer = store.enqueueInbox({
      id: "steer-1",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: "run-steer",
      source: "human",
      body: "Please check the edge case.",
    });
    expect(steer).toMatchObject({ id: "steer-1", status: "pending" });
    expect(store.listPendingInbox("issue-1")).toHaveLength(1);
    expect(store.cancelPendingInbox("issue-1")).toBe(1);
    expect(store.listPendingInbox("issue-1")).toHaveLength(0);
  });

  it("binds buffered steering to the active run when it becomes deliverable", () => {
    const steer = store.enqueueInbox({
      id: "steer-buffered",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: null,
      source: "human",
      body: "Please apply this in the next implementation stage.",
    });
    expect(steer).toMatchObject({ id: "steer-buffered", run_id: null, status: "pending" });
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-next",
      taskType: "implement",
      tokenHash: "steering-token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);

    const [pending] = store.listPendingInbox("issue-1");

    expect(pending).toMatchObject({
      id: "steer-buffered",
      run_id: "run-next",
      status: "pending",
    });
    expect(pending?.delivery_id).toEqual(expect.any(String));
  });

  it("does not lease explicitly buffered steering to the current non-steerable run", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-non-steerable",
      taskType: "implement",
      tokenHash: "steering-token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);

    const steer = store.enqueueInbox({
      id: "steer-during-review",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: null,
      source: "human",
      body: "Please apply this in the next implementation stage.",
    });

    expect(steer).toMatchObject({
      id: "steer-during-review",
      run_id: null,
      status: "pending",
      delivery_id: null,
    });
  });
});
