import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createFeedbackStore } from "./feedback-store.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

const base = {
  provider: "github" as const,
  issueId: "issue-1",
  sessionId: "session-1",
  generation: 2,
  repository: "owner/repo",
  pullNumber: 42,
  headSha: "head-a",
};

describe("provider feedback snapshots", () => {
  it("retains stable provider identities and freezes one bounded snapshot", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const review = store.record({
      ...base,
      providerEventId: "review:7",
      kind: "review",
      payload: "review body",
      workItemId: "gh-review-7",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const check = store.record({
      ...base,
      providerEventId: "check-suite:8",
      kind: "check_suite",
      payload: "failed",
      workItemId: "gh-check-8",
      receivedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(check.snapshot.id).toBe(review.snapshot.id);
    expect(store.listEvents(review.snapshot.id).map((event) => event.provider_event_id)).toEqual([
      "review:7",
      "check-suite:8",
    ]);
    expect(store.claimWithEvents(review.snapshot.id, 3)).toMatchObject({
      status: "claimed",
      snapshot: { repair_round: 1 },
    });

    const duringRepair = store.record({
      ...base,
      providerEventId: "comment:9",
      kind: "comment",
      payload: "one more thing",
      workItemId: "gh-comment-9",
      receivedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(duringRepair.snapshot.id).not.toBe(review.snapshot.id);
    expect(store.claimWithEvents(duringRepair.snapshot.id, 3)).toMatchObject({
      status: "claimed",
      snapshot: { repair_round: 2 },
    });
  });

  it("deduplicates exact delivery and fails closed if its payload changes", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const first = store.record({
      ...base,
      providerEventId: "workflow:1",
      kind: "workflow_run",
      payload: "failure",
      workItemId: "gh-workflow-1",
    });
    const duplicate = store.record({
      ...base,
      providerEventId: "workflow:1",
      kind: "workflow_run",
      payload: "failure",
      workItemId: "gh-workflow-1",
    });
    expect(duplicate).toMatchObject({ eventInserted: false, snapshotCreated: false });
    expect(duplicate.snapshot.id).toBe(first.snapshot.id);
    expect(() => store.record({
      ...base,
      providerEventId: "workflow:1",
      kind: "workflow_run",
      payload: "mutated",
      workItemId: "gh-workflow-1",
    })).toThrow(/changed payload/i);
  });

  it("bounds event materialization when claiming a large snapshot", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    let snapshotId = "";
    for (let index = 0; index < 21; index += 1) {
      snapshotId = store.record({
        ...base,
        providerEventId: `review:${index}`,
        kind: "review",
        payload: `review body ${index}`,
        workItemId: "gh-review-batch",
        receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }).snapshot.id;
    }

    const claim = store.claimWithEvents(snapshotId, 3, 20);
    expect(claim).toMatchObject({
      status: "claimed",
      eventsTruncated: true,
      events: expect.arrayContaining([
        expect.objectContaining({ provider_event_id: "review:0" }),
      ]),
    });
    expect(claim.status === "claimed" ? claim.events : []).toHaveLength(20);
  });

  it("does not truncate a snapshot at the exact event limit", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    let snapshotId = "";
    for (let index = 0; index < 20; index += 1) {
      snapshotId = store.record({
        ...base,
        providerEventId: `exact-review:${index}`,
        kind: "review",
        payload: `review body ${index}`,
        workItemId: "gh-exact-review-batch",
        receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }).snapshot.id;
    }

    const claim = store.claimWithEvents(snapshotId, 3, 20);
    expect(claim).toMatchObject({
      status: "claimed",
      eventsTruncated: false,
    });
    expect(claim.status === "claimed" ? claim.events : []).toHaveLength(20);
  });

  it("settles provider evidence and claim consumption in one transaction", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const recorded = store.record({
      ...base,
      providerEventId: "review:atomic",
      kind: "review",
      payload: "original",
      workItemId: "gh-review-atomic",
    });
    expect(store.claimWithEvents(recorded.snapshot.id, 3, 20).status).toBe("claimed");

    expect(() => store.settleClaim(recorded.snapshot.id, () => {
      db!.prepare(`
        UPDATE provider_events SET kind = 'mutated'
        WHERE provider = 'github' AND provider_event_id = 'review:atomic'
      `).run();
      throw new Error("interrupt settlement");
    })).toThrow(/interrupt settlement/);
    expect(db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?")
      .get(recorded.snapshot.id)).toEqual({ status: "claimed" });
    expect(db.prepare(`
      SELECT kind FROM provider_events
      WHERE provider = 'github' AND provider_event_id = 'review:atomic'
    `).get()).toEqual({ kind: "review" });

    expect(store.settleClaim(recorded.snapshot.id, () => undefined)).toBe(true);
    expect(db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?")
      .get(recorded.snapshot.id)).toEqual({ status: "consumed" });
    expect(store.claimWithEvents(recorded.snapshot.id, 3, 20)).toMatchObject({
      status: "consumed",
      snapshot: { id: recorded.snapshot.id },
    });
  });

  it("carries only a bounded overflow sentinel into an existing target snapshot", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    let sourceId = "";
    for (let index = 0; index < 30; index += 1) {
      sourceId = store.record({
        ...base,
        headSha: "head-old",
        providerEventId: `old-review:${index}`,
        kind: "review",
        payload: `old review ${index}`,
        workItemId: "gh-old-review-batch",
        receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }).snapshot.id;
    }
    const target = store.record({
      ...base,
      headSha: "head-new",
      providerEventId: "new-review:0",
      kind: "review",
      payload: "new review",
      workItemId: "gh-new-review",
      receivedAt: "2026-01-01T00:01:00.000Z",
    }).snapshot;

    expect(store.carryForward(sourceId, "head-new", "gh-current", 21)?.id).toBe(target.id);
    expect(store.listEvents(target.id)).toHaveLength(22);
    expect(store.listEvents(sourceId)).toHaveLength(9);
    expect(db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(sourceId))
      .toEqual({ status: "stale" });
  });

  it("keeps conversation comments separate from commit-scoped feedback on the same head", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const comment = store.record({
      ...base,
      providerEventId: "comment:1",
      kind: "issue_comment",
      payload: "please cover the empty case",
      workItemId: "gh-comment-1",
    });
    const check = store.record({
      ...base,
      providerEventId: "check:2",
      kind: "check_suite",
      payload: "failure",
      workItemId: "gh-check-2",
    });

    expect(check.snapshot.id).not.toBe(comment.snapshot.id);
    expect(comment.snapshot.head_sha).toBe("conversation:head-a");
    expect(check.snapshot.head_sha).toBe("head-a");
    expect(store.listEvents(comment.snapshot.id).map((event) => event.kind))
      .toEqual(["issue_comment"]);
    expect(store.listEvents(check.snapshot.id).map((event) => event.kind))
      .toEqual(["check_suite"]);
  });

  it("keeps old-head events separate and enforces the round bound atomically", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const first = store.record({
      ...base,
      providerEventId: "review:1",
      kind: "review",
      payload: "a",
      workItemId: "gh-review-1",
    });
    expect(store.claimWithEvents(first.snapshot.id, 1).status).toBe("claimed");
    const oldHead = store.record({
      ...base,
      headSha: "head-old",
      providerEventId: "comment:2",
      kind: "comment",
      payload: "old",
      workItemId: "gh-comment-2",
    });
    expect(store.claimWithEvents(oldHead.snapshot.id, 1)).toEqual({
      status: "exhausted",
      completedRounds: 1,
    });
  });

  it("gives a later same-head snapshot its own repair work identity", () => {
    db = openDb(":memory:");
    const store = createFeedbackStore(db);
    const first = store.record({
      ...base,
      providerEventId: "workflow:1",
      kind: "workflow_run",
      payload: "first failure",
      workItemId: "gh-ci-head-a",
    });
    expect(first.snapshot.work_item_id).toBe("gh-ci-head-a");
    expect(store.claimWithEvents(first.snapshot.id, 3).status).toBe("claimed");

    const next = store.record({
      ...base,
      providerEventId: "check:2",
      kind: "check_suite",
      payload: "later failure",
      workItemId: "gh-ci-head-a",
    });
    expect(next.snapshot.id).not.toBe(first.snapshot.id);
    expect(next.snapshot.work_item_id).toMatch(/^gh-ci-head-a:snapshot:/);
  });
});
