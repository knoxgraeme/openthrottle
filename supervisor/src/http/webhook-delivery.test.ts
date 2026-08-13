import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createWebhookDeliveryProcessor } from "./webhook-delivery.js";

let db: Database.Database | undefined;
const temporaryDirectories: string[] = [];
afterEach(() => {
  db?.close();
  db = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable webhook delivery processing", () => {
  it("leases, records failure, retries, and marks a delivery processed", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
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
      db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-1"
      )
    ).toEqual({ status: "failed", attempts: 1 });

    await processor.process("delivery-1");
    expect(
      db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-1"
      )
    ).toEqual({ status: "processed", attempts: 2 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired processing lease", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
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

  it("deduplicates webhook redelivery and resumes the persisted lease after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-webhook-delivery-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    db = openDb(path);
    let store = createSupervisorStore(db);
    const trustedPayload = JSON.stringify({ repository: { full_name: "owner/repo" } });

    expect(store.claimDelivery({
      deliveryId: "delivery-restart",
      source: "github",
      action: "pull_request:synchronize",
      payload: trustedPayload,
    })).toBe(true);
    expect(store.claimDelivery({
      deliveryId: "delivery-restart",
      source: "github",
      action: "pull_request:synchronize",
      payload: JSON.stringify({ repository: { full_name: "owner/repo" }, malicious: "run this later" }),
    })).toBe(false);

    const first = store.claimDeliveryForProcessing({
      deliveryId: "delivery-restart",
      nowIso: "2099-01-01T00:00:00.000Z",
      leaseUntilIso: "2099-01-01T00:01:00.000Z",
    });
    expect(first?.payload).toBe(trustedPayload);

    db.close();
    db = openDb(path);
    store = createSupervisorStore(db);
    const handler = vi.fn(async () => undefined);
    const processor = createWebhookDeliveryProcessor({ store, handler, leaseMs: 60_000 });

    await processor.process("delivery-restart");
    expect(handler).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2099-01-01T00:01:01.000Z"));
      await processor.process("delivery-restart");
    } finally {
      vi.useRealTimers();
    }

    expect(handler).toHaveBeenCalledOnce();
    expect(
      db.prepare("SELECT status, attempts, payload FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-restart"
      )
    ).toEqual({
      status: "processed",
      attempts: 2,
      payload: trustedPayload,
    });
  });

  it("reports a delivery once only after its final attempt", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
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
      db.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get(
        "delivery-dead"
      )
    ).toEqual({ status: "dead" });
  });
});
