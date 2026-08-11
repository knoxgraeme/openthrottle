import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";
import type { LinearOutboxRecord } from "./delivery-store.js";

describe("delivery store", () => {
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

  const getLinearOutbox = (id: string): LinearOutboxRecord | undefined =>
    db.prepare("SELECT * FROM control_outbox WHERE id = ?").get(id) as LinearOutboxRecord | undefined;

  it("keeps Linear publication ordered", () => {
    const first = store.enqueueLinearOutbox({
      id: "linear-1",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"thought"}',
    });
    const second = store.enqueueLinearOutbox({
      id: "linear-2",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"response"}',
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
  });

  it("does not acknowledge a Linear outbox row after its payload changed", () => {
    const row = store.enqueueLinearOutbox({
      id: "control-status",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "pipeline_status",
      payload: '{"type":"pipeline_status","publication":{"body":"old"}}',
    });
    db.prepare(`
      UPDATE control_outbox
      SET payload = ?, payload_hash = 'new-hash'
      WHERE id = ?
    `).run('{"type":"pipeline_status","publication":{"body":"new"}}', row.id);

    store.markLinearOutboxProcessed(row.id, { externalId: "stale-comment" }, row.payload_hash);
    expect(getLinearOutbox(row.id)).toMatchObject({
      status: "pending",
      payload_hash: "new-hash",
      external_id: null,
    });

    store.markLinearOutboxFailed(row.id, "stale failure", null, row.payload_hash);
    expect(getLinearOutbox(row.id)).toMatchObject({
      status: "pending",
      last_error: null,
    });
  });

  it("does not lease unrelated Linear outbox rows when a requested id is not claimable", () => {
    const first = store.enqueueLinearOutbox({
      id: "linear-1",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"activity","activity":{"sessionId":"session-1","type":"response","body":"first"}}',
    });
    const second = store.enqueueLinearOutbox({
      id: "linear-2",
      sessionId: "session-2",
      issueId: "issue-2",
      kind: "activity",
      payload: '{"type":"activity","activity":{"sessionId":"session-2","type":"response","body":"second"}}',
    });

    expect(store.claimLinearOutboxForId(
      "missing",
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:01:00.000Z",
      50
    )).toEqual([]);
    expect(getLinearOutbox(first.id)?.status).toBe("pending");
    expect(getLinearOutbox(second.id)?.status).toBe("pending");
  });

  it("does not let issue-state projections block later Linear outbox rows", () => {
    const state = store.enqueueLinearOutbox({
      id: "issue-state",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "issue_state",
      payload: '{"type":"issue_state","issueId":"issue-1","signal":"started"}',
    });
    const activity = store.enqueueLinearOutbox({
      id: "linear-activity",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: '{"type":"activity","activity":{"sessionId":"session-1","type":"response","body":"after projection"}}',
    });
    db.prepare(`
      UPDATE control_outbox
      SET status = 'failed', next_attempt_at = '2101-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(state.id);

    const claimed = store.claimLinearOutbox(
      "2100-01-01T00:00:00.000Z",
      "2100-01-01T00:01:00.000Z",
      50
    );

    expect(claimed.map((row) => row.id)).toEqual([activity.id]);
    expect(getLinearOutbox(state.id)?.status).toBe("failed");
    expect(getLinearOutbox(activity.id)?.status).toBe("processing");
  });

  it("deduplicates accepted webhooks", () => {
    const claim = { deliveryId: "delivery-1", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);
    expect(store.claimDelivery(claim)).toBe(false);
  });

  it("keeps dead webhook deliveries off the retry clock", () => {
    const claim = { deliveryId: "delivery-1", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);

    store.markDeliveryFailed("delivery-1", "permanent failure", null);

    const delivery = db.prepare(`
      SELECT status, next_attempt_at, last_error
      FROM webhook_deliveries
      WHERE delivery_id = ?
    `).get("delivery-1");
    expect(delivery).toEqual({
      status: "dead",
      next_attempt_at: null,
      last_error: "permanent failure",
    });
  });
});
