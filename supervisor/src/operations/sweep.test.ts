import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createLinearActivityPublisher, createLinearOutboxProcessor } from "../providers/linear/outbox.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { runSweep } from "./sweep.js";

describe("runSweep", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  it("deletes old orphan runtimes, protects active bindings, and prunes deliveries", async () => {
    const pipelines = createPipelineStore(db);
    const store = createSupervisorStore(db, pipelines);
    store.upsertUnpinned({
      linear_issue_id: "active",
      linear_issue_identifier: "ACTIVE",
      linear_session_id: "session-active",
      sandbox_id: "known-active",
      branch: "ot/active",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.claimDelivery({ deliveryId: "old-delivery", source: "linear", action: "created" });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?")
      .run("2020-01-01T00:00:00.000Z");

    const oldOrphan = {
      id: "old-orphan",
      createdAt: "2020-01-01T00:00:00.000Z",
      labels: { ticket: "OLD-1" },
    };
    const newOrphan = {
      id: "new-orphan",
      createdAt: new Date().toISOString(),
      labels: { ticket: "NEW-1" },
    };
    const knownActive = {
      id: "known-active",
      createdAt: "2020-01-01T00:00:00.000Z",
      labels: { ticket: "ACTIVE" },
    };
    const remove = vi.fn(async () => undefined);
    const runtime = {
      deleteResource: remove,
      stopResource: vi.fn(async () => undefined),
      listLabeledResources: async () => [oldOrphan, newOrphan, knownActive],
    };
    const outbox = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => undefined,
    });
    const activityPublisher = createLinearActivityPublisher(store, outbox);
    const reconcileWebhooks = vi.fn(async () => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5 } as Config,
      pipelines,
      activityPublisher,
      reconcileWebhooks
    );

    expect(reconcileWebhooks).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("old-orphan");
    expect(remove).not.toHaveBeenCalledWith("new-orphan");
    expect(remove).not.toHaveBeenCalledWith("known-active");
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
  });

  it("continues orphan cleanup and retention pruning when webhook reconciliation rejects", async () => {
    const pipelines = createPipelineStore(db);
    const store = createSupervisorStore(db, pipelines);
    store.claimDelivery({ deliveryId: "old-delivery", source: "linear", action: "created" });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    const remove = vi.fn(async () => undefined);
    const runtime = {
      deleteResource: remove,
      stopResource: vi.fn(async () => undefined),
      listLabeledResources: async () => [{
        id: "old-orphan",
        createdAt: "2020-01-01T00:00:00.000Z",
        labels: { ticket: "OLD-1" },
      }],
    };
    const outbox = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => undefined,
    });
    const activityPublisher = createLinearActivityPublisher(store, outbox);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5 } as Config,
      pipelines,
      activityPublisher,
      vi.fn(async () => {
        throw new Error("webhook unavailable");
      })
    );

    expect(remove).toHaveBeenCalledWith("old-orphan");
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
    expect(error).toHaveBeenCalledWith(
      "[sweep] webhook reconciliation failed:",
      expect.any(Error)
    );
    error.mockRestore();
  });
});
