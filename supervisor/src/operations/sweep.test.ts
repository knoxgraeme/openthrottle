import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createLinearActivityPublisher, createLinearOutboxProcessor } from "../providers/linear/outbox.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import { runSweep } from "./sweep.js";

describe("runSweep", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  function activityPublisherFor(store: ReturnType<typeof createSupervisorStore>) {
    const outbox = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => undefined,
    });
    return createLinearActivityPublisher(store, outbox);
  }

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
      cleanup: vi.fn(async () => undefined),
      listLabeledResources: async () => [oldOrphan, newOrphan, knownActive],
    };
    const reconcileWebhooks = vi.fn(async () => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(store),
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
      cleanup: vi.fn(async () => undefined),
      listLabeledResources: async () => [{
        id: "old-orphan",
        createdAt: "2020-01-01T00:00:00.000Z",
        labels: { ticket: "OLD-1" },
      }],
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(store),
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

  it("continues retention pruning when listing labeled runtimes fails", async () => {
    const pipelines = createPipelineStore(db);
    const store = createSupervisorStore(db, pipelines);
    store.upsertUnpinned({
      linear_issue_id: "issue-old",
      linear_issue_identifier: "OLD",
      linear_session_id: "session-old",
      sandbox_id: "sandbox-old",
      branch: "ot/old",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-old",
      runId: "run-old",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    store.claimDelivery({ deliveryId: "old-delivery", source: "linear", action: "created" });
    store.insertSandboxEvent({
      eventId: "old-ephemeral-event",
      runId: "run-old",
      sandboxId: "sandbox-old",
      kind: "activity",
      payload: JSON.stringify({ ephemeral: true }),
    });
    store.enqueueLinearOutbox({
      id: "old-ephemeral-outbox",
      linearSessionId: "session-old",
      issueId: "issue-old",
      kind: "activity",
      payload: JSON.stringify({ activity: { ephemeral: true } }),
    });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    db.prepare("UPDATE sandbox_events SET status = 'processed', processed_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    db.prepare("UPDATE linear_outbox SET status = 'processed', processed_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    const runtime = {
      deleteResource: vi.fn(async () => undefined),
      stopResource: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      listLabeledResources: vi.fn(async () => {
        throw new Error("inventory unavailable");
      }),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(store)
    );

    expect(runtime.deleteResource).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM sandbox_events").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM linear_outbox").pluck().get()).toBe(0);
    expect(error).toHaveBeenCalledWith(
      "[sweep] failed to list Daytona sandboxes:",
      expect.any(Error)
    );
    error.mockRestore();
  });

  it("continues deleting later orphan runtimes when one delete fails", async () => {
    const pipelines = createPipelineStore(db);
    const store = createSupervisorStore(db, pipelines);
    const remove = vi.fn(async (id: string) => {
      if (id === "old-orphan-a") throw new Error("delete timeout");
    });
    const runtime = {
      deleteResource: remove,
      stopResource: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      listLabeledResources: async () => [
        {
          id: "old-orphan-a",
          createdAt: "2020-01-01T00:00:00.000Z",
          labels: { ticket: "OLD-A" },
        },
        {
          id: "old-orphan-b",
          createdAt: "2020-01-01T00:00:00.000Z",
          labels: { ticket: "OLD-B" },
        },
      ],
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runSweep(
      runtime,
      store,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(store)
    );

    expect(remove).toHaveBeenCalledWith("old-orphan-a");
    expect(remove).toHaveBeenCalledWith("old-orphan-b");
    expect(error).toHaveBeenCalledWith(
      "[sweep] failed to delete orphan sandbox old-orphan-a:",
      expect.any(Error)
    );
    error.mockRestore();
  });

  it("reclaims a terminal instance's stopped runtime resource once its retention window elapses", async () => {
    // A needs_human terminal instance whose resource the cleanup effect
    // stopped-but-preserved (coordinator.ts terminalCleanupEffect,
    // preserve: true) -- exactly the OPE-75 dogfood state: no active stage,
    // resource `stopped`, stopped well past any retention window.
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("session-needs-human-old"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime: setup.runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("session-needs-human-old")!;
    pipelines.bindRuntimeResource(instance.id, "daytona", "sandbox-needs-human-old");
    pipelines.setRuntimeResourceStatus(instance.id, "stopped");
    tickets.setSandboxId(instance.linear_issue_id, "sandbox-needs-human-old");
    db.prepare(`
      UPDATE pipeline_effect_intents SET status = 'acknowledged'
      WHERE pipeline_instance_id = ? AND status = 'pending'
    `).run(instance.id);
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human', active_stage_id = NULL,
          runtime_resource_updated_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(instance.id);

    const cleanup = vi.fn(async () => undefined);
    const runtime = {
      deleteResource: vi.fn(async () => undefined),
      stopResource: vi.fn(async () => undefined),
      cleanup,
      listLabeledResources: async () => [],
    };

    await runSweep(
      runtime,
      tickets,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(tickets)
    );

    expect(cleanup).toHaveBeenCalledWith({ providerResourceId: "sandbox-needs-human-old" });
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
    expect(tickets.getByIssueId(instance.linear_issue_id)?.sandbox_id).toBeNull();
  });
});
