import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("delivery store", () => {
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

  it("keeps Linear publication ordered", () => {
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
  });

  it("deduplicates accepted webhooks", () => {
    const claim = { deliveryId: "delivery-1", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);
    expect(store.claimDelivery(claim)).toBe(false);
  });
});
