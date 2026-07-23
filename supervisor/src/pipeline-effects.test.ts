import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTicketStore, openDb } from "./db.js";
import { createPipelineEffectProcessor } from "./pipeline-effects.js";
import { requestPipelineStop } from "./pipeline-control.js";
import { loadPipelineCatalog, parseRepositoryConfig } from "./pipeline-manifest.js";
import { createPipelineStore } from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor, type SandboxRuntime } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("./__fixtures__/pipelines/catalog.yaml", import.meta.url));

describe("pipeline effect processor", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  function harness(issueId: string, sessionId: string) {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("effect-exhaustion-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("pipelines: { implement: fixture-command }\ntest: npm test\n"),
    });
    const manifest = catalog.manifests.get("fixture/command@2")!;
    tickets.upsert({
      linear_issue_id: issueId,
      linear_issue_identifier: issueId.toUpperCase(),
      linear_session_id: sessionId,
      sandbox_id: null,
      branch: `ot/${issueId}`,
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: config,
        runtime: runtimeDescriptor,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "investigate",
      },
    });
    const runtime = {
      provision: vi.fn(async () => ({ providerResourceId: `sandbox-${issueId}` })),
      bootstrap: vi.fn(async () => undefined),
      materializeCredentials: vi.fn(async () => undefined),
      dispatchStage: vi.fn(async () => ({ providerDispatchId: `dispatch-${issueId}` })),
      collectStageResult: vi.fn(async () => null),
      renewLiveness: vi.fn(async () => ({ observedAt: new Date().toISOString() })),
      stop: vi.fn(async () => ({ confirmed: true })),
      quarantine: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    } satisfies SandboxRuntime;
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });
    const instance = pipelines.getInstanceForSession(sessionId)!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    return { tickets, pipelines, runtime, processor, instance, attempt };
  }

  it("provisions, seals, credentials, and dispatches the first stage exactly through the durable intent", async () => {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("effect-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("pipelines: { implement: fixture-command }\ntest: npm test\n"),
    });
    const manifest = catalog.manifests.get("fixture/command@2")!;
    tickets.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: config,
        runtime: runtimeDescriptor,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "investigate",
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = {
      provision: vi.fn(async () => ({ providerResourceId: "sandbox-1" })),
      bootstrap: vi.fn(async () => undefined),
      materializeCredentials: vi.fn(async () => undefined),
      dispatchStage: vi.fn(async () => ({ providerDispatchId: "command-1" })),
      collectStageResult: vi.fn(async () => null),
      renewLiveness: vi.fn(async () => ({ observedAt: new Date().toISOString() })),
      stop: vi.fn(async () => ({ confirmed: true })),
      quarantine: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    } satisfies SandboxRuntime;
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    await processor.drain();
    await processor.drain();

    expect(runtime.provision).toHaveBeenCalledTimes(1);
    expect(runtime.bootstrap).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-1" },
      expect.objectContaining({ configDigest: config.digest, manifestDigest: instance.manifest_digest })
    );
    expect(runtime.materializeCredentials).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-1" },
      ["repo.read"]
    );
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(1);
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      sandbox_id: "sandbox-1",
      run_id: attempt.planned_run_id,
    });
    expect(tickets.getRun(attempt.planned_run_id!)).toMatchObject({
      task_type: "investigate",
    });
    expect(pipelines.getRuntimeResource(instance.id)).toMatchObject({
      provider_resource_id: "sandbox-1",
      status: "active",
    });
    expect(pipelines.getAttempt(attempt.id)).toMatchObject({
      run_id: attempt.planned_run_id,
      status: "running",
    });
    expect(pipelines.getInstance(instance.id)?.status).toBe("running");
    expect(pipelines.listEffects(instance.id)[0]).toMatchObject({
      status: "acknowledged",
      attempts: 1,
    });

    // Simulate a crash after dispatch/result settlement but before the
    // provision acknowledgement committed. Retrying must remain tied to the
    // original attempt and must not dispatch whichever attempt is active now.
    const provision = pipelines.listEffects(instance.id)[0]!;
    db.prepare("DELETE FROM pipeline_inbox_events WHERE id = ?")
      .run(`effect-ack-${provision.id}`);
    db.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'processing', acknowledged_at = NULL,
          next_attempt_at = '2099-07-22T12:00:00.000Z'
      WHERE id = ?
    `).run(provision.id);
    db.prepare(`
      UPDATE pipeline_stage_attempts SET status = 'completed' WHERE id = ?
    `).run(attempt.id);
    await processor.drain();
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(1);
    expect(pipelines.listEffects(instance.id)[0]).toMatchObject({
      status: "acknowledged",
      attempts: 2,
    });
    db.prepare("UPDATE pipeline_stage_attempts SET status = 'running' WHERE id = ?")
      .run(attempt.id);

    requestPipelineStop({
      store: pipelines,
      sessionId: "session-1",
      eventId: "operator-stop:pipeline-1",
      reason: "Stopped by test.",
    });
    runtime.stop.mockResolvedValueOnce({ confirmed: false });
    await processor.drain();

    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("active");
    // A failed remote stop retains the actor claim and ticket exclusivity
    // until the same idempotent effect confirms termination.
    expect(tickets.getRun(attempt.planned_run_id!)).toMatchObject({ status: "reaping" });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop"))
      .toMatchObject({ status: "failed", attempts: 1 });

    db.prepare(`
      UPDATE pipeline_effect_intents SET next_attempt_at = ?
      WHERE pipeline_instance_id = ? AND kind = 'stop'
    `).run("2099-07-22T12:00:00.000Z", instance.id);
    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, "pipeline stop");
    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(pipelines.getInstance(instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "canceled",
    });
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
    expect(tickets.getRun(attempt.planned_run_id!)).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "stopped",
      run_id: null,
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop"))
      .toMatchObject({ status: "acknowledged", attempts: 2 });

    const enqueueCleanup = (id: string, transitionVersion: number) => {
      db!.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at
        ) VALUES (?, ?, ?, 'cleanup', ?, '{}', ?, 'pending', ?, ?)
      `).run(
        id,
        instance.id,
        transitionVersion,
        id,
        `hash-${id}`,
        "2099-07-22T12:00:00.000Z",
        "2099-07-22T12:00:00.000Z"
      );
    };
    enqueueCleanup("cleanup-after-terminal", 2);
    await processor.drain();

    expect(runtime.cleanup).toHaveBeenCalledOnce();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("cleaned");
    expect(tickets.getByIssueId("issue-1")?.sandbox_id).toBeNull();

    tickets.setSandboxId("issue-1", "sandbox-new-generation");
    enqueueCleanup("cleanup-replay-after-redelegation", 3);
    await processor.drain();

    expect(runtime.cleanup).toHaveBeenCalledOnce();
    expect(tickets.getByIssueId("issue-1")?.sandbox_id).toBe("sandbox-new-generation");
  });

  it("settles a pre-provision PR-close stop without creating a runtime resource", async () => {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("effect-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("pipelines: { implement: fixture-command }\ntest: npm test\n"),
    });
    const manifest = catalog.manifests.get("fixture/command@2")!;
    tickets.upsert({
      linear_issue_id: "issue-2",
      linear_issue_identifier: "OT-2",
      linear_session_id: "session-2",
      sandbox_id: null,
      branch: "ot/ot-2",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: config,
        runtime: runtimeDescriptor,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("session-2")!;
    const runtime = {
      provision: vi.fn(async () => ({ providerResourceId: "unexpected" })),
      bootstrap: vi.fn(async () => undefined),
      materializeCredentials: vi.fn(async () => undefined),
      dispatchStage: vi.fn(async () => ({ providerDispatchId: "unexpected" })),
      collectStageResult: vi.fn(async () => null),
      renewLiveness: vi.fn(async () => ({ observedAt: new Date().toISOString() })),
      stop: vi.fn(async () => ({ confirmed: true })),
      quarantine: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    } satisfies SandboxRuntime;
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    requestPipelineStop({
      store: pipelines,
      sessionId: "session-2",
      eventId: "github-pull-closed-stop:pipeline-2",
      reason: "Pull request closed before provision.",
      ticketState: "closed",
    });
    await processor.drain();

    expect(runtime.provision).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)).toBeUndefined();
    expect(tickets.getByIssueId("issue-2")).toMatchObject({ state: "closed", run_id: null });
    expect(tickets.getSession("session-2")?.state).toBe("stopped");
    expect(pipelines.listEffects(instance.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "provision", status: "dead" }),
      expect.objectContaining({ kind: "stop", status: "acknowledged" }),
    ]));
  });

  it("atomically converts exhausted provisioning into a typed failed terminal and stop cleanup", async () => {
    const { tickets, pipelines, runtime, processor, instance } = harness("issue-3", "session-3");
    runtime.provision.mockRejectedValue(new Error("provider unavailable"));
    db!.prepare(`
      UPDATE pipeline_effect_intents SET attempts = 7
      WHERE pipeline_instance_id = ? AND kind = 'provision'
    `).run(instance.id);
    db!.prepare(`
      UPDATE pipeline_instance_stages SET reentry_count = 2
      WHERE pipeline_instance_id = ? AND stage_id = 'test'
    `).run(instance.id);

    await processor.drain();

    expect(pipelines.getInstance(instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "failed",
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({ status: "dead", attempts: 8, last_error: expect.stringContaining("provider unavailable") });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop"))
      .toMatchObject({ status: "pending" });

    await processor.drain();

    expect(tickets.getByIssueId("issue-3")).toMatchObject({ state: "error", run_id: null });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop"))
      .toMatchObject({ status: "acknowledged" });
  });

  it("quarantines the runtime and retains exclusivity when stop attempts exhaust", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } = harness("issue-4", "session-4");
    await processor.drain();
    requestPipelineStop({
      store: pipelines,
      sessionId: "session-4",
      eventId: "operator-stop:exhaustion",
      reason: "Stopped by test.",
    });
    db!.prepare(`
      UPDATE pipeline_effect_intents SET attempts = 7
      WHERE pipeline_instance_id = ? AND kind = 'stop'
    `).run(instance.id);
    runtime.stop.mockResolvedValue({ confirmed: false });

    await processor.drain();

    expect(tickets.getRun(attempt.planned_run_id!)).toMatchObject({ status: "reaping" });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop"))
      .toMatchObject({ status: "dead", attempts: 8 });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "quarantine"))
      .toMatchObject({ status: "pending" });

    await processor.drain();

    expect(runtime.quarantine).toHaveBeenCalledOnce();
    expect(pipelines.getRuntimeResource(instance.id)?.status).toBe("quarantined");
    expect(tickets.getRun(attempt.planned_run_id!)).toMatchObject({ status: "quarantined" });
    expect(tickets.getByIssueId("issue-4")).toMatchObject({ state: "error", run_id: attempt.planned_run_id });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "quarantine"))
      .toMatchObject({ status: "acknowledged" });
  });
});
