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
      ticket_id: "active",
      ticket_reference: "ACTIVE",
      session_id: "session-active",
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
    db.prepare(`
      INSERT INTO github_webhook_redelivery_requests (
        repository, webhook_id, delivery_id, delivery_guid, delivered_at,
        status, attempts, next_attempt_at, accepted_at, last_error, updated_at
      ) VALUES
        ('acme/widget', 42, 1, 'accepted-guid', '2020-01-01T00:00:00.000Z',
          'accepted', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL,
          '2020-01-01T00:00:00.000Z'),
        ('acme/widget', 42, 2, 'claimed-guid', '2020-01-01T00:00:00.000Z',
          'claimed', 1, '2020-01-01T00:00:00.000Z', NULL, NULL,
          '2020-01-01T00:00:00.000Z'),
        ('acme/widget', 42, 3, 'failed-guid', '2020-01-01T00:00:00.000Z',
          'failed', 1, '2020-01-01T00:00:00.000Z', NULL, 'retry later',
          '2020-01-01T00:00:00.000Z')
    `).run();

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
    expect(db.prepare(`
      SELECT delivery_id, status
      FROM github_webhook_redelivery_requests
      ORDER BY delivery_id
    `).all()).toEqual([
      { delivery_id: 2, status: "claimed" },
      { delivery_id: 3, status: "failed" },
    ]);
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
      ticket_id: "issue-old",
      ticket_reference: "OLD",
      session_id: "session-old",
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
      sessionId: "session-old",
      issueId: "issue-old",
      kind: "activity",
      payload: JSON.stringify({ activity: { ephemeral: true } }),
    });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    db.prepare("UPDATE sandbox_events SET status = 'processed', processed_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    db.prepare("UPDATE control_outbox SET status = 'processed', processed_at = ?")
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
    expect(db.prepare("SELECT COUNT(*) FROM control_outbox").pluck().get()).toBe(0);
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
    tickets.setSandboxId(instance.ticket_id, "sandbox-needs-human-old");
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
    expect(tickets.getByIssueId(instance.ticket_id)?.sandbox_id).toBeNull();
  });

  it("protects a still pipeline-bound sandbox from the orphan path once a newer generation reassigns tickets.sandbox_id", async () => {
    // Reproduces the PR #159 review finding: a needs_human terminal
    // instance's resource is stopped but still within its retention window
    // (not yet eligible for reclaimEligibleRuntimeResources), and the ticket
    // has since been re-delegated -- tickets.sandbox_id now points at a
    // newer generation's sandbox, so store.getBySandboxId(old resource id)
    // returns undefined and the old resource looks orphaned by ticket
    // linkage alone. It must not be deleted by ORPHAN_GRACE_MINUTES; only
    // the retention-aware reconciler may reclaim it, and only once eligible.
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("session-old-generation"),
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
    const instance = pipelines.getInstanceForSession("session-old-generation")!;
    pipelines.bindRuntimeResource(instance.id, "daytona", "sandbox-old-generation");
    pipelines.setRuntimeResourceStatus(instance.id, "stopped");
    db.prepare(`
      UPDATE pipeline_effect_intents SET status = 'acknowledged'
      WHERE pipeline_instance_id = ? AND status = 'pending'
    `).run(instance.id);
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human', active_stage_id = NULL,
          runtime_resource_updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), instance.id);
    // The re-delegation that moved the ticket on to a new generation's
    // sandbox -- the old resource's id no longer appears anywhere on the
    // ticket, only on the (still terminal, still 'stopped') pipeline instance.
    tickets.setSandboxId(instance.ticket_id, "sandbox-new-generation");

    const deleteResource = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const runtime = {
      deleteResource,
      stopResource: vi.fn(async () => undefined),
      cleanup,
      listLabeledResources: async () => [{
        id: "sandbox-old-generation",
        createdAt: "2020-01-01T00:00:00.000Z",
        labels: { ticket: instance.ticket_id },
      }],
    };

    await runSweep(
      runtime,
      tickets,
      { orphanGraceMinutes: 5, runtimeResourceRetentionMinutes: 60, runOutcomeRetentionDays: 180 } as Config,
      pipelines,
      activityPublisherFor(tickets)
    );

    expect(deleteResource).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("stopped");
  });
});
