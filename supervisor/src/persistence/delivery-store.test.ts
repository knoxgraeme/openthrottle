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

  it("requeues dead webhook deliveries once within the reconciled repository", () => {
    expect(store.claimDelivery({
      deliveryId: "github-dead",
      source: "github",
      action: "closed",
      eventName: "pull_request",
      payload: JSON.stringify({ repository: { full_name: "acme/widget" } }),
    })).toBe(true);
    expect(store.claimDelivery({
      deliveryId: "github-other-dead",
      source: "github",
      action: "closed",
      eventName: "pull_request",
      payload: JSON.stringify({ repository: { full_name: "acme/other" } }),
    })).toBe(true);
    expect(store.claimDelivery({
      deliveryId: "github-processed",
      source: "github",
      action: "opened",
      eventName: "pull_request",
      payload: "{}",
    })).toBe(true);
    expect(store.claimDelivery({
      deliveryId: "linear-dead",
      source: "linear",
      action: "created",
      payload: "{}",
    })).toBe(true);
    store.markDeliveryFailed("github-dead", "permanent GitHub failure", null);
    store.markDeliveryFailed("github-other-dead", "other repository failure", null);
    store.markDeliveryProcessed("github-processed");
    store.markDeliveryFailed("linear-dead", "permanent Linear failure", null);

    expect(store.requeueDeadDeliveriesForRedelivery(
      "github",
      "ACME/WIDGET",
      "2099-01-01T00:00:00.000Z",
      50
    )).toBe(1);
    expect(db.prepare(`
      SELECT status, next_attempt_at, last_error, redelivered_at
      FROM webhook_deliveries
      WHERE delivery_id = ?
    `).get("github-dead")).toEqual({
      status: "pending",
      next_attempt_at: "2099-01-01T00:00:00.000Z",
      last_error: null,
      redelivered_at: "2099-01-01T00:00:00.000Z",
    });
    expect(store.requeueDeadDeliveriesForRedelivery(
      "github",
      "acme/widget",
      "2099-01-01T00:01:00.000Z",
      50
    )).toBe(0);
    expect(db.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get("github-processed"))
      .toEqual({ status: "processed" });
    expect(db.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get("github-other-dead"))
      .toEqual({ status: "dead" });
    expect(db.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get("linear-dead"))
      .toEqual({ status: "dead" });
  });

  it("prunes accepted GitHub redelivery requests in bounded batches", () => {
    const insert = db.prepare(`
      INSERT INTO github_webhook_redelivery_requests (
        repository, webhook_id, delivery_id, delivery_guid, delivered_at,
        status, attempts, next_attempt_at, accepted_at, last_error, updated_at
      ) VALUES (?, 42, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    const old = "2020-01-01T00:00:00.000Z";
    const future = "2100-01-01T00:00:00.000Z";
    insert.run("acme/widget", 1, "guid-1", old, "accepted", old, old, null, old);
    insert.run("acme/widget", 2, "guid-2", old, "accepted", old, old, null, old);
    insert.run("acme/widget", 3, "guid-3", old, "claimed", future, null, null, old);
    insert.run("acme/widget", 4, "guid-4", old, "failed", future, null, "retry", old);
    insert.run("acme/widget", 5, "guid-5", future, "accepted", future, future, null, future);

    expect(store.pruneAcceptedGithubWebhookRedeliveryRequests(
      "2021-01-01T00:00:00.000Z",
      1
    )).toBe(1);
    expect(db.prepare(`
      SELECT delivery_id, status
      FROM github_webhook_redelivery_requests
      ORDER BY delivery_id
    `).all()).toEqual([
      { delivery_id: 2, status: "accepted" },
      { delivery_id: 3, status: "claimed" },
      { delivery_id: 4, status: "failed" },
      { delivery_id: 5, status: "accepted" },
    ]);

    expect(store.pruneAcceptedGithubWebhookRedeliveryRequests(
      "2021-01-01T00:00:00.000Z",
      10
    )).toBe(1);
    expect(db.prepare(`
      SELECT delivery_id, status
      FROM github_webhook_redelivery_requests
      ORDER BY delivery_id
    `).all()).toEqual([
      { delivery_id: 3, status: "claimed" },
      { delivery_id: 4, status: "failed" },
      { delivery_id: 5, status: "accepted" },
    ]);
  });
});
