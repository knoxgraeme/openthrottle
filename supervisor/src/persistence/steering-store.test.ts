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
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
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
    expect(db.prepare("SELECT COUNT(*) FROM session_inbox").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM work_items").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM work_deliveries").pluck().get()).toBe(0);
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

  it("cancels buffered steering from a superseded session before binding", () => {
    store.enqueueInbox({
      id: "steer-old-session",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: null,
      source: "human",
      body: "Do not inject this into the replacement session.",
    });
    store.upsertUnpinned({
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-2",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-replacement",
      taskType: "implement",
      tokenHash: "steering-token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);

    expect(store.listPendingInbox("issue-1")).toHaveLength(0);
    expect(store.getInbox("steer-old-session")).toMatchObject({
      status: "canceled",
      run_id: null,
    });
    expect(db.prepare("SELECT status FROM steering_items WHERE id = ?").pluck().get("steer-old-session"))
      .toBe("canceled");
  });

  it("delivers buffered steering only to the generation that produced it", () => {
    // A message is buffered during generation 1 (the beforeEach session-1) while
    // the run is mid-flight on a non-steerable stage, so run_id stays NULL.
    store.enqueueInbox({
      id: "steer-gen-1",
      issueId: "issue-1",
      sessionId: "session-1",
      runId: null,
      source: "human",
      body: "Guidance meant only for generation 1.",
    });

    // The issue is re-delegated: a fresh session (generation 2) supersedes the
    // old one and a replacement run begins for the successor pipeline.
    store.upsertUnpinned({
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-2",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-gen-2",
      taskType: "implement",
      tokenHash: "steering-token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);

    // The generation-1 buffer must never cross into the generation-2 run/sandbox:
    // it is cancelled instead of bound. Without the session/generation fence it
    // would instead be leased to run-gen-2 and returned here (cross-generation
    // cross-talk), so this assertion fails without the fix.
    expect(store.listPendingInbox("issue-1")).toHaveLength(0);
    expect(store.getInbox("steer-gen-1")).toMatchObject({ status: "canceled", run_id: null });

    // A message buffered under generation 2 IS still delivered to generation 2 —
    // proving the fence targets only the superseded generation, not every buffer.
    store.enqueueInbox({
      id: "steer-gen-2",
      issueId: "issue-1",
      sessionId: "session-2",
      runId: null,
      source: "human",
      body: "Guidance for generation 2.",
    });
    const deliverable = store.listPendingInbox("issue-1");
    expect(deliverable.map((message) => message.id)).toEqual(["steer-gen-2"]);
    expect(deliverable[0]).toMatchObject({ id: "steer-gen-2", run_id: "run-gen-2" });
    expect(deliverable[0]?.delivery_id).toEqual(expect.any(String));

    // The superseded generation-1 buffer stays cancelled and is never resurrected.
    expect(store.getInbox("steer-gen-1")?.status).toBe("canceled");
  });
});
