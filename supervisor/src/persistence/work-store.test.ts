import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./database.js";
import { createWorkStore } from "./work-store.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const binding = {
  issueId: "issue-1",
  sessionId: "session-1",
  generation: 2,
  contextRevision: 7,
  runId: "run-1",
  nativeSessionId: "native-1",
};

describe("durable work delivery", () => {
  it("requires dispatch then acknowledgement before consumption", () => {
    db = openDb(":memory:");
    const store = createWorkStore(db);
    const item = store.enqueue({
      id: "work-1",
      ...binding,
      source: "human",
      body: "please check the retry path",
    });
    const delivery = store.lease({
      workItemId: item.id,
      ...binding,
      leaseUntil: "2099-01-01T00:00:00.000Z",
    });

    expect(() => store.acknowledge(delivery.id, binding)).toThrow(/dispatched/i);
    store.markDispatched(delivery.id, binding);
    expect(store.getDelivery(delivery.id)?.status).toBe("dispatched");
    store.acknowledge(delivery.id, binding);
    expect(store.getDelivery(delivery.id)?.status).toBe("acknowledged");
    store.consume(delivery.id, { ...binding, attemptId: "attempt-1" });
    expect(store.get(delivery.work_item_id)).toMatchObject({
      status: "consumed",
      consumed_by_attempt_id: "attempt-1",
    });
    expect(() =>
      store.consume(delivery.id, { ...binding, attemptId: "attempt-2" })
    ).toThrow(/already consumed/i);
  });

  it("rejects stale run, native-session, generation, and context bindings", () => {
    db = openDb(":memory:");
    const store = createWorkStore(db);
    const item = store.enqueue({ id: "work-2", ...binding, source: "human", body: "steer" });
    const delivery = store.lease({
      workItemId: item.id,
      ...binding,
      leaseUntil: "2099-01-01T00:00:00.000Z",
    });

    for (const stale of [
      { ...binding, runId: "run-2" },
      { ...binding, nativeSessionId: "native-2" },
      { ...binding, generation: 3 },
      { ...binding, contextRevision: 8 },
    ]) {
      expect(() => store.markDispatched(delivery.id, stale)).toThrow(/binding mismatch/i);
    }

    const another = store.enqueue({
      id: "work-stale-lease",
      ...binding,
      source: "human",
      body: "bound before dispatch",
    });
    expect(() => store.lease({
      workItemId: another.id,
      ...binding,
      nativeSessionId: "native-2",
      leaseUntil: "2099-01-01T00:00:00.000Z",
    })).toThrow(/binding mismatch/i);
    expect(() => store.lease({
      workItemId: another.id,
      ...binding,
      runId: "run-2",
      leaseUntil: "2099-01-01T00:00:00.000Z",
    })).toThrow(/binding mismatch/i);
  });

  it("reclaims an expired unacknowledged delivery but never redelivers an acknowledged one", () => {
    db = openDb(":memory:");
    const store = createWorkStore(db);
    const item = store.enqueue({ id: "work-3", ...binding, source: "human", body: "steer" });
    const first = store.lease({
      workItemId: item.id,
      ...binding,
      leaseUntil: "2026-01-01T00:00:00.000Z",
    });
    store.markDispatched(first.id, binding);

    const second = store.lease({
      workItemId: item.id,
      ...binding,
      now: "2026-01-01T00:00:01.000Z",
      leaseUntil: "2099-01-01T00:00:00.000Z",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.attempt_ordinal).toBe(2);
    store.markDispatched(second.id, binding);
    store.acknowledge(second.id, binding);
    expect(() =>
      store.lease({
        workItemId: item.id,
        ...binding,
        now: "2100-01-01T00:00:00.000Z",
        leaseUntil: "2100-01-01T00:01:00.000Z",
      })
    ).toThrow(/acknowledged/i);
  });

  it("returns every unacknowledged delivery to pending when its actor ends", () => {
    db = openDb(":memory:");
    const store = createWorkStore(db);
    const item = store.enqueue({ id: "work-release", ...binding, source: "human", body: "steer" });
    const delivery = store.lease({
      workItemId: item.id,
      ...binding,
      leaseUntil: "2099-01-01T00:00:00.000Z",
    });
    store.markDispatched(delivery.id, binding);

    expect(store.releaseUnacknowledgedForRun("run-1", "actor ended")).toEqual([item.id]);
    expect(store.get(item.id)).toMatchObject({ status: "pending", active_delivery_id: null });
    expect(store.getDelivery(delivery.id)).toMatchObject({
      status: "expired",
      last_error: "actor ended",
    });
  });
});
