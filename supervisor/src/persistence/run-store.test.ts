import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("run store", () => {
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
});
