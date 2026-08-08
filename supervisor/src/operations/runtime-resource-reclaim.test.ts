import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import {
  createRuntimeResourceReconciler,
  reclaimEligibleRuntimeResources,
} from "./runtime-resource-reclaim.js";

const FUTURE_CUTOFF = "2999-01-01T00:00:00.000Z";

describe("reclaimEligibleRuntimeResources", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  // Builds a dispatchable pipeline instance, binds+stops a runtime resource
  // on it, then forces it into a terminal needs_human state the way the
  // needs_human cleanup effect (preserve: true) leaves one in production:
  // resource stopped, ticket.sandbox_id still pointing at it, provision
  // effect settled. `runtime_resource_updated_at` is backdated so the
  // default (very-future) cutoff sees it as past its retention window.
  function seedStoppedTerminalInstance(params: {
    sessionId: string;
    resourceId: string;
    updatedAt?: string;
    settleProvisionEffect?: boolean;
  }, setup = setupPipelineStore()) {
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket(params.sessionId),
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
    const instance = pipelines.getInstanceForSession(params.sessionId)!;
    pipelines.bindRuntimeResource(instance.id, "daytona", params.resourceId);
    pipelines.setRuntimeResourceStatus(instance.id, "stopped");
    tickets.setSandboxId(instance.linear_issue_id, params.resourceId);
    if (params.settleProvisionEffect !== false) {
      db.prepare(`
        UPDATE pipeline_effect_intents SET status = 'acknowledged'
        WHERE pipeline_instance_id = ? AND status = 'pending'
      `).run(instance.id);
    }
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human', active_stage_id = NULL,
          runtime_resource_updated_at = ?
      WHERE id = ?
    `).run(params.updatedAt ?? "2020-01-01T00:00:00.000Z", instance.id);
    return { ...setup, instance };
  }

  it("deletes an eligible stopped terminal resource, records the outcome, and journals it", async () => {
    const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
      sessionId: "session-reclaim",
      resourceId: "sandbox-reclaim",
    });
    const cleanup = vi.fn(async () => undefined);

    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test sweep",
    });

    expect(result).toEqual({ reclaimed: 1, candidates: 1 });
    expect(cleanup).toHaveBeenCalledWith({ providerResourceId: "sandbox-reclaim" });
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
    expect(tickets.getByIssueId(instance.linear_issue_id)?.sandbox_id).toBeNull();
    const entries = pipelines.listJournalEntries({ issueId: instance.linear_issue_id });
    expect(entries).toContainEqual(expect.objectContaining({
      kind: "run_note",
      trigger: "test sweep",
      instance_id: instance.id,
    }));
  });

  it("does not reclaim a resource whose retention window has not elapsed", async () => {
    const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
      sessionId: "session-fresh",
      resourceId: "sandbox-fresh",
      updatedAt: new Date().toISOString(),
    });
    const cleanup = vi.fn(async () => undefined);

    // A cutoff far in the past means "only reclaim things stopped before
    // then" -- this freshly-stopped resource is not eligible yet.
    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: "2000-01-01T00:00:00.000Z",
      trigger: "test sweep",
    });

    expect(result).toEqual({ reclaimed: 0, candidates: 0 });
    expect(cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("stopped");
  });

  it("re-checks the retention cutoff when a concurrent stop refreshes a listed candidate", async () => {
    const { pipelines, tickets, instance, db: database } = seedStoppedTerminalInstance({
      sessionId: "session-refreshed-after-list",
      resourceId: "sandbox-refreshed-after-list",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const getInstance = pipelines.getInstance.bind(pipelines);
    vi.spyOn(pipelines, "getInstance").mockImplementationOnce((instanceId) => {
      database.prepare(`
        UPDATE pipeline_instances SET runtime_resource_updated_at = ? WHERE id = ?
      `).run("2030-01-01T00:00:00.000Z", instanceId);
      return getInstance(instanceId);
    });
    const cleanup = vi.fn(async () => undefined);

    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: "2025-01-01T00:00:00.000Z",
      trigger: "test concurrent refresh",
    });

    expect(result).toEqual({ reclaimed: 0, candidates: 1 });
    expect(cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)).toMatchObject({
      status: "stopped",
      updated_at: "2030-01-01T00:00:00.000Z",
    });
  });

  it("never reclaims a resource with an active stage attempt, even if listed as terminal+stopped", async () => {
    const { pipelines, tickets, instance, db: database } = seedStoppedTerminalInstance({
      sessionId: "session-active-attempt",
      resourceId: "sandbox-active-attempt",
    });
    // Force the instance back to pointing at a stage with a live attempt --
    // a state the coordinator should never produce for a terminal instance,
    // but the reclaim path must refuse to touch regardless.
    const attempt = database.prepare(
      "SELECT id, stage_id FROM pipeline_stage_attempts WHERE pipeline_instance_id = ? LIMIT 1"
    ).get(instance.id) as { id: string; stage_id: string };
    database.prepare("UPDATE pipeline_stage_attempts SET status = 'running' WHERE id = ?").run(attempt.id);
    database.prepare("UPDATE pipeline_instances SET active_stage_id = ? WHERE id = ?")
      .run(attempt.stage_id, instance.id);
    const cleanup = vi.fn(async () => undefined);

    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test sweep",
    });

    expect(result.reclaimed).toBe(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("stopped");
  });

  it.each(["pending", "processing", "failed"] as const)(
    "never reclaims a resource with an unsettled %s effect intent",
    async (effectStatus) => {
      const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
        sessionId: `session-${effectStatus}-effect`,
        resourceId: `sandbox-${effectStatus}-effect`,
        settleProvisionEffect: false,
      });
      db!.prepare(`
        UPDATE pipeline_effect_intents SET status = ? WHERE pipeline_instance_id = ?
      `).run(effectStatus, instance.id);
      const cleanup = vi.fn(async () => undefined);

      const result = await reclaimEligibleRuntimeResources({
        store: pipelines,
        tickets,
        runtime: { cleanup },
        cutoffIso: FUTURE_CUTOFF,
        trigger: "test sweep",
      });

      expect(result.reclaimed).toBe(0);
      expect(cleanup).not.toHaveBeenCalled();
      expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("stopped");
    }
  );

  it("leaves the resource stopped (not cleaned) and does not throw when provider deletion fails", async () => {
    const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
      sessionId: "session-cleanup-fails",
      resourceId: "sandbox-cleanup-fails",
    });
    const cleanup = vi.fn(async () => {
      throw new Error("Daytona is unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test sweep",
    });

    expect(result.reclaimed).toBe(0);
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("stopped");
    expect(tickets.getByIssueId(instance.linear_issue_id)?.sandbox_id).toBe("sandbox-cleanup-fails");
    error.mockRestore();
  });

  it("converges idempotently on a repeated pass: already-cleaned resources are never touched again", async () => {
    const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
      sessionId: "session-idempotent",
      resourceId: "sandbox-idempotent",
    });
    const cleanup = vi.fn(async () => undefined);
    const params = {
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test sweep",
    };

    const first = await reclaimEligibleRuntimeResources(params);
    const second = await reclaimEligibleRuntimeResources(params);

    expect(first.reclaimed).toBe(1);
    expect(second).toEqual({ reclaimed: 0, candidates: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
  });

  it("does not disturb a replacement ticket binding while cleaning an older generation", async () => {
    const { pipelines, tickets, instance } = seedStoppedTerminalInstance({
      sessionId: "session-old-binding",
      resourceId: "sandbox-old-binding",
    });
    tickets.upsertUnpinned({
      ...ticket("session-replacement-binding", instance.linear_issue_id),
      sandbox_id: "sandbox-replacement-binding",
    });
    const cleanup = vi.fn(async () => undefined);

    await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test replacement binding",
    });

    expect(cleanup).toHaveBeenCalledWith({ providerResourceId: "sandbox-old-binding" });
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
    expect(tickets.getByIssueId(instance.linear_issue_id)).toMatchObject({
      linear_session_id: "session-replacement-binding",
      sandbox_id: "sandbox-replacement-binding",
    });
  });

  it("bounds hot-path waiting, coalesces overlap, and leaves the rest for a bulk sweep", async () => {
    vi.useFakeTimers();
    const setup = setupPipelineStore();
    const firstInstance = seedStoppedTerminalInstance({
      sessionId: "session-slow-first",
      resourceId: "sandbox-slow-first",
    }, setup).instance;
    const secondInstance = seedStoppedTerminalInstance({
      sessionId: "session-slow-second",
      resourceId: "sandbox-slow-second",
    }, setup).instance;
    const { pipelines, tickets } = setup;
    let releaseFirst!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeCleanups = 0;
    let maxActiveCleanups = 0;
    const cleanup = vi.fn(async () => {
      activeCleanups++;
      maxActiveCleanups = Math.max(maxActiveCleanups, activeCleanups);
      try {
        if (cleanup.mock.calls.length === 1) await firstCleanup;
      } finally {
        activeCleanups--;
      }
    });
    const reconcile = createRuntimeResourceReconciler({
      store: pipelines,
      tickets,
      runtime: { cleanup },
    });
    const hotRequest = {
      cutoffIso: FUTURE_CUTOFF,
      limit: 1,
      trigger: "test hot path",
      waitTimeoutMs: 5_000,
    };

    const firstHot = reconcile(hotRequest);
    const overlappingHot = reconcile(hotRequest);
    const bulk = reconcile({
      cutoffIso: FUTURE_CUTOFF,
      limit: 50,
      trigger: "test periodic sweep",
    });

    expect(cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(firstHot).resolves.toEqual({ reclaimed: 0, candidates: 0 });
    await expect(overlappingHot).resolves.toEqual({ reclaimed: 0, candidates: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(pipelines.getRuntimeResource(firstInstance.id)?.status).toBe("stopped");
    expect(pipelines.getRuntimeResource(secondInstance.id)?.status).toBe("stopped");

    releaseFirst();
    await expect(bulk).resolves.toEqual({ reclaimed: 1, candidates: 1 });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(maxActiveCleanups).toBe(1);
    expect(pipelines.getRuntimeResource(firstInstance.id)?.status).toBe("cleaned");
    expect(pipelines.getRuntimeResource(secondInstance.id)?.status).toBe("cleaned");
  });

  it("never reclaims an active or quarantined resource regardless of terminal status", async () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("session-quarantined"),
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
    const instance = pipelines.getInstanceForSession("session-quarantined")!;
    pipelines.bindRuntimeResource(instance.id, "daytona", "sandbox-quarantined");
    pipelines.setRuntimeResourceStatus(instance.id, "quarantined");
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human', active_stage_id = NULL,
          runtime_resource_updated_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(instance.id);
    const cleanup = vi.fn(async () => undefined);

    const result = await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets,
      runtime: { cleanup },
      cutoffIso: FUTURE_CUTOFF,
      trigger: "test sweep",
    });

    expect(result).toEqual({ reclaimed: 0, candidates: 0 });
    expect(cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("quarantined");
  });
});
