import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTicketStore, openDb } from "./db.js";
import { createWebhookDeliveryProcessor } from "./webhook-delivery.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("durable webhook delivery processing", () => {
  it("leases, records failure, retries, and marks a delivery processed", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.claimDelivery({
      deliveryId: "delivery-1",
      source: "linear",
      action: "created",
      eventName: "AgentSessionEvent",
      payload: "{}",
    });
    const handler = vi
      .fn<(delivery: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const processor = createWebhookDeliveryProcessor({
      store,
      handler,
      baseDelayMs: 0,
      leaseMs: 1,
    });

    await expect(processor.process("delivery-1")).rejects.toThrow("temporary");
    expect(
      store.db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-1"
      )
    ).toEqual({ status: "failed", attempts: 1 });

    await processor.process("delivery-1");
    expect(
      store.db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-1"
      )
    ).toEqual({ status: "processed", attempts: 2 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired processing lease", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.claimDelivery({ deliveryId: "delivery-lease", source: "github", action: "closed", payload: "{}" });
    const first = store.claimDeliveryForProcessing({
      deliveryId: "delivery-lease",
      nowIso: "2099-01-01T00:00:00.000Z",
      leaseUntilIso: "2099-01-01T00:01:00.000Z",
    });
    expect(first?.attempts).toBe(1);
    expect(
      store.claimDeliveryForProcessing({
        deliveryId: "delivery-lease",
        nowIso: "2099-01-01T00:00:30.000Z",
        leaseUntilIso: "2099-01-01T00:01:30.000Z",
      })
    ).toBeUndefined();
    expect(
      store.claimDeliveryForProcessing({
        deliveryId: "delivery-lease",
        nowIso: "2099-01-01T00:01:01.000Z",
        leaseUntilIso: "2099-01-01T00:02:01.000Z",
      })?.attempts
    ).toBe(2);
  });

  it("reports a delivery once only after its final attempt", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.claimDelivery({
      deliveryId: "delivery-dead",
      source: "linear",
      sessionId: "session-1",
      action: "prompted",
      payload: "{}",
    });
    const error = new Error("permanent");
    const onDead = vi.fn<(delivery: unknown, failure: unknown) => Promise<void>>();
    const processor = createWebhookDeliveryProcessor({
      store,
      handler: async () => {
        throw error;
      },
      onDead,
      maxAttempts: 2,
      baseDelayMs: 0,
    });

    await expect(processor.process("delivery-dead")).rejects.toThrow("permanent");
    expect(onDead).not.toHaveBeenCalled();
    await expect(processor.process("delivery-dead")).rejects.toThrow("permanent");
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2 }), error);
    expect(
      store.db.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-dead"
      )
    ).toEqual({ status: "dead" });
  });
});
