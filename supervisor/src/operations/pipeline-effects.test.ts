import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createPipelineEffectProcessor } from "./pipeline-effects.js";
import { coordinatePipelineEvent } from "../pipeline/coordinator.js";
import { requestPipelineStop } from "../pipeline/control.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
} from "../pipeline/manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor, type SandboxRuntime } from "../sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));

describe("pipeline effect processor", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  function harness(issueId: string, sessionId: string) {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
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

  function rewriteEffectPayload(
    effectId: string,
    transform: (payload: Record<string, unknown>) => Record<string, unknown>
  ): void {
    const effect = db!.prepare("SELECT payload FROM pipeline_effect_intents WHERE id = ?")
      .get(effectId) as { payload: string };
    const payload = canonicalJson(transform(JSON.parse(effect.payload) as Record<string, unknown>));
    setEffectPayload(effectId, payload);
  }

  function setEffectPayload(effectId: string, payload: string): void {
    db!.prepare(`
      UPDATE pipeline_effect_intents SET payload = ?, payload_hash = ? WHERE id = ?
    `).run(payload, digestNormalized(payload), effectId);
  }

  it("provisions, seals, credentials, and dispatches the first stage exactly through the durable intent", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
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
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
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

  it("settles a superseded actor from its original run binding without touching the replacement session", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-superseded", "session-superseded");
    await processor.drain();
    const runId = attempt.planned_run_id!;

    tickets.upsertUnpinned({
      linear_issue_id: "issue-superseded",
      linear_issue_identifier: "ISSUE-SUPERSEDED",
      linear_session_id: "session-replacement",
      sandbox_id: "sandbox-replacement",
      branch: "ot/issue-superseded",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });

    expect(pipelines.getInstance(instance.id)).toMatchObject({
      status: "superseded",
      terminal_outcome: "superseded",
    });
    expect(tickets.getByIssueId("issue-superseded")).toMatchObject({
      linear_session_id: "session-replacement",
      sandbox_id: "sandbox-replacement",
      run_id: runId,
      state: "active",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    expect(JSON.parse(stop.payload)).toMatchObject({ runId });

    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-issue-superseded" },
      "pipeline stop"
    );
    expect(tickets.getRun(runId)).toMatchObject({ status: "stopped" });
    expect(db!.prepare(
      "SELECT actor_state FROM run_liveness WHERE run_id = ?"
    ).pluck().get(runId)).toBe("settled");
    expect(tickets.getByIssueId("issue-superseded")).toMatchObject({
      linear_session_id: "session-replacement",
      sandbox_id: "sandbox-replacement",
      run_id: null,
      state: "active",
    });
    expect(tickets.getSession("session-superseded")?.state).toBe("superseded");
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "acknowledged" });
  });

  it("settles the planned actor after a crash between beginRun and bindStageRun", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-planned-run-stop", "session-planned-run-stop");
    await processor.drain();
    const runId = attempt.planned_run_id!;

    db!.transaction(() => {
      db!.prepare("DELETE FROM run_stage_bindings WHERE run_id = ?").run(runId);
      db!.prepare("UPDATE pipeline_stage_attempts SET run_id = NULL WHERE id = ?").run(attempt.id);
    })();
    expect(tickets.getByIssueId("issue-planned-run-stop")?.run_id).toBe(runId);
    expect(pipelines.getAttempt(attempt.id)?.run_id).toBeNull();
    expect(pipelines.getAttemptForRun(runId)?.id).toBe(attempt.id);

    requestPipelineStop({
      store: pipelines,
      sessionId: "session-planned-run-stop",
      eventId: "operator-stop:planned-run-crash-window",
      reason: "Stopped after recovered dispatch.",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    expect(JSON.parse(stop.payload)).toMatchObject({ runId });

    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-issue-planned-run-stop" },
      "pipeline stop"
    );
    expect(tickets.getRun(runId)).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId("issue-planned-run-stop")).toMatchObject({
      state: "stopped",
      run_id: null,
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "acknowledged" });
  });

  it("settles a superseded planned actor after a crash before bindStageRun", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-planned-run-superseded", "session-planned-run-superseded");
    await processor.drain();
    const runId = attempt.planned_run_id!;

    db!.transaction(() => {
      db!.prepare("DELETE FROM run_stage_bindings WHERE run_id = ?").run(runId);
      db!.prepare("UPDATE pipeline_stage_attempts SET run_id = NULL WHERE id = ?").run(attempt.id);
    })();
    tickets.upsertUnpinned({
      linear_issue_id: "issue-planned-run-superseded",
      linear_issue_identifier: "ISSUE-PLANNED-RUN-SUPERSEDED",
      linear_session_id: "session-planned-run-replacement",
      sandbox_id: "sandbox-planned-run-replacement",
      branch: "ot/issue-planned-run-superseded",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    expect(JSON.parse(stop.payload)).toMatchObject({ runId });

    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-issue-planned-run-superseded" },
      "pipeline stop"
    );
    expect(tickets.getRun(runId)).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId("issue-planned-run-superseded")).toMatchObject({
      linear_session_id: "session-planned-run-replacement",
      sandbox_id: "sandbox-planned-run-replacement",
      state: "active",
      run_id: null,
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "acknowledged" });
  });

  it("recovers an original run binding from a legacy supersede stop intent", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-legacy-superseded", "session-legacy-superseded");
    await processor.drain();
    const runId = attempt.planned_run_id!;

    tickets.upsertUnpinned({
      linear_issue_id: "issue-legacy-superseded",
      linear_issue_identifier: "ISSUE-LEGACY-SUPERSEDED",
      linear_session_id: "session-legacy-replacement",
      sandbox_id: "sandbox-legacy-replacement",
      branch: "ot/issue-legacy-superseded",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    rewriteEffectPayload(stop.id, (payload) => {
      const { runId: _runId, ...legacyPayload } = payload;
      return legacyPayload;
    });

    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(tickets.getRun(runId)).toMatchObject({ status: "stopped" });
    expect(db!.prepare(
      "SELECT actor_state FROM run_liveness WHERE run_id = ?"
    ).pluck().get(runId)).toBe("settled");
    expect(tickets.getByIssueId("issue-legacy-superseded")).toMatchObject({
      linear_session_id: "session-legacy-replacement",
      sandbox_id: "sandbox-legacy-replacement",
      run_id: null,
      state: "active",
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "acknowledged" });
  });

  it("does not project a stop across replacement admission during provider termination", async () => {
    const { tickets, pipelines, runtime, processor } =
      harness("issue-concurrent-replacement", "session-concurrent-replacement");
    await processor.drain();
    requestPipelineStop({
      store: pipelines,
      sessionId: "session-concurrent-replacement",
      eventId: "operator-stop:concurrent-replacement",
      reason: "Stopped by test.",
    });
    let confirmTermination!: () => void;
    let reportStopStarted!: () => void;
    const termination = new Promise<void>((resolve) => { confirmTermination = resolve; });
    const stopStarted = new Promise<void>((resolve) => { reportStopStarted = resolve; });
    runtime.stop.mockImplementation(async () => {
      reportStopStarted();
      await termination;
      return { confirmed: true };
    });

    const draining = processor.drain();
    await stopStarted;
    tickets.upsertUnpinned({
      linear_issue_id: "issue-concurrent-replacement",
      linear_issue_identifier: "ISSUE-CONCURRENT-REPLACEMENT",
      linear_session_id: "session-concurrent-successor",
      sandbox_id: "sandbox-concurrent-successor",
      branch: "ot/issue-concurrent-replacement",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    confirmTermination();
    await draining;

    expect(tickets.getByIssueId("issue-concurrent-replacement")).toMatchObject({
      linear_session_id: "session-concurrent-successor",
      sandbox_id: "sandbox-concurrent-successor",
      run_id: null,
      state: "active",
      last_error: null,
    });
    expect(tickets.getSession("session-concurrent-replacement")?.state).toBe("superseded");
  });

  it("projects a terminal error after the sealed run has already completed", async () => {
    const { tickets, pipelines, processor, instance, attempt } =
      harness("issue-completed-terminal", "session-completed-terminal");
    await processor.drain();
    const runId = attempt.planned_run_id!;
    tickets.finishRun({ runId, status: "completed", ticketState: "active" });
    requestPipelineStop({
      store: pipelines,
      sessionId: "session-completed-terminal",
      eventId: "terminal-error-after-completion",
      reason: "Terminal pipeline failure.",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    rewriteEffectPayload(stop.id, (payload) => ({ ...payload, ticketState: "error" }));

    await processor.drain();

    expect(tickets.getRun(runId)).toMatchObject({ status: "completed" });
    expect(tickets.getByIssueId("issue-completed-terminal")).toMatchObject({
      state: "error",
      run_id: null,
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "acknowledged" });
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

  it("exhausts a 403 dispatch on its first failure with the sanitized cause in the failure event", async () => {
    const { pipelines, runtime, processor, instance } = harness("issue-auth-403", "session-auth-403");
    runtime.dispatchStage.mockRejectedValue(
      new Error("GitHub API 403: Write access to repository not granted")
    );
    const provision = pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision")!;

    await processor.drain();

    expect(runtime.dispatchStage).toHaveBeenCalledTimes(1);
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === provision.id))
      .toMatchObject({
        status: "dead",
        attempts: 1,
        last_error: expect.stringContaining("Write access to repository not granted"),
      });
    expect(pipelines.getInboxEvent(`pipeline-effect-exhausted:${provision.id}`)?.payload)
      .toContain("Write access to repository not granted");
  });

  it("retries a capacity-exhausted provision on a patient fixed interval", async () => {
    const { pipelines, runtime, processor, instance } = harness("issue-capacity", "session-capacity");
    runtime.provision.mockRejectedValue(new Error("Total memory limit exceeded"));

    await processor.drain();

    expect(runtime.provision).toHaveBeenCalledTimes(1);
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({
        status: "failed",
        attempts: 1,
        next_attempt_at: "2099-07-22T12:05:00.000Z",
        last_error: expect.stringContaining("Total memory limit exceeded"),
      });
    expect(pipelines.getInstance(instance.id)).toMatchObject({ terminal_outcome: null });
  });

  it("classifies an HTTP-403-wrapped quota error as capacity, not auth", async () => {
    const { pipelines, runtime, processor, instance } =
      harness("issue-capacity-403", "session-capacity-403");
    runtime.provision.mockRejectedValue(new Error("HTTP 403: Total memory limit exceeded"));

    await processor.drain();

    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({
        status: "failed",
        attempts: 1,
        next_attempt_at: "2099-07-22T12:05:00.000Z",
      });
    expect(pipelines.getInstance(instance.id)).toMatchObject({ terminal_outcome: null });
  });

  it("keeps exponential backoff for transient provision failures", async () => {
    const { pipelines, runtime, processor, instance } = harness("issue-transient", "session-transient");
    runtime.provision.mockRejectedValue(new Error("connect ETIMEDOUT 10.20.30.40:8443"));

    await processor.drain();

    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({
        status: "failed",
        attempts: 1,
        next_attempt_at: "2099-07-22T12:00:05.000Z",
        last_error: expect.stringContaining("ETIMEDOUT"),
      });
  });

  it("preserves the stopped workspace on a needs_human terminal", async () => {
    const { tickets, pipelines, runtime, processor, instance } =
      harness("issue-needs-human-preserve", "session-needs-human-preserve");
    await processor.drain();
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const payload = JSON.stringify({ id: "needs-human-preserve", outcome: "needs_human" });
    coordinatePipelineEvent(pipelines, {
      id: "needs-human-preserve",
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: attempt.id,
      requestHash: attempt.request_hash,
      outcome: "needs_human",
      resultHash: digestNormalized(payload),
      artifacts: [{
        kind: "stage_result",
        schemaVersion: 1,
        assurance: "executor_verified",
        payload,
        hash: digestNormalized(payload),
      }, {
        kind: "command_result",
        schemaVersion: 1,
        assurance: "executor_verified",
        payload: JSON.stringify({ exitCode: 1 }),
        hash: digestNormalized(JSON.stringify({ exitCode: 1 })),
      }],
    });
    const cleanup = pipelines.listEffects(instance.id).find((effect) => effect.kind === "cleanup")!;
    expect(JSON.parse(cleanup.payload)).toMatchObject({ preserve: true });

    await processor.drain();

    expect(runtime.stop).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-issue-needs-human-preserve" },
      expect.stringContaining("preserved")
    );
    expect(runtime.cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId("issue-needs-human-preserve"))
      .toMatchObject({ sandbox_id: "sandbox-issue-needs-human-preserve" });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === cleanup.id))
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

  it("never forwards an invalid sealed stop binding into quarantine", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-invalid-stop-binding", "session-invalid-stop-binding");
    await processor.drain();
    const runId = attempt.planned_run_id!;
    requestPipelineStop({
      store: pipelines,
      sessionId: "session-invalid-stop-binding",
      eventId: "operator-stop:invalid-binding",
      reason: "Stopped by test.",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    rewriteEffectPayload(stop.id, (payload) => ({ ...payload, runId: "unrelated-run" }));
    db!.prepare("UPDATE pipeline_effect_intents SET attempts = 7 WHERE id = ?").run(stop.id);

    await processor.drain();
    await processor.drain();

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.quarantine).toHaveBeenCalledOnce();
    expect(tickets.getRun("unrelated-run")).toBeUndefined();
    expect(tickets.getRun(runId)).toMatchObject({ status: "quarantined" });
    const quarantine = pipelines.listEffects(instance.id)
      .find((effect) => effect.kind === "quarantine")!;
    expect(JSON.parse(quarantine.payload)).toMatchObject({ runId });
    expect(quarantine).toMatchObject({ status: "acknowledged" });
  });

  it.each([
    ["malformed JSON", "{"],
    ["an invalid run binding type", canonicalJson({ runId: 42, ticketState: "stopped" })],
  ])("exhausts a stop intent with %s instead of leaving it processing", async (_case, payload) => {
    const { tickets, pipelines, processor, instance, attempt } =
      harness(`issue-poison-stop-${_case.replaceAll(" ", "-")}`, `session-poison-stop-${_case.replaceAll(" ", "-")}`);
    await processor.drain();
    const runId = attempt.planned_run_id!;
    requestPipelineStop({
      store: pipelines,
      sessionId: instance.linear_session_id,
      eventId: `operator-stop:poison:${_case}`,
      reason: "Stopped by test.",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    setEffectPayload(stop.id, payload);
    db!.prepare("UPDATE pipeline_effect_intents SET attempts = 7 WHERE id = ?").run(stop.id);

    await expect(processor.drain()).resolves.toBeUndefined();
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === stop.id))
      .toMatchObject({ status: "dead", attempts: 8 });

    await processor.drain();
    expect(tickets.getRun(runId)).toMatchObject({ status: "quarantined" });
  });

  it("projects an exhausted terminal stop after its sealed run already completed", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-completed-stop-exhaustion", "session-completed-stop-exhaustion");
    await processor.drain();
    const runId = attempt.planned_run_id!;
    tickets.finishRun({ runId, status: "completed", ticketState: "active" });
    requestPipelineStop({
      store: pipelines,
      sessionId: instance.linear_session_id,
      eventId: "terminal-error-stop-exhaustion",
      reason: "Terminal pipeline failure.",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    rewriteEffectPayload(stop.id, (payload) => ({ ...payload, ticketState: "error" }));
    db!.prepare("UPDATE pipeline_effect_intents SET attempts = 7 WHERE id = ?").run(stop.id);
    runtime.stop.mockResolvedValue({ confirmed: false });

    await processor.drain();
    await processor.drain();

    expect(tickets.getRun(runId)).toMatchObject({ status: "completed" });
    expect(runtime.quarantine).toHaveBeenCalledOnce();
    expect(tickets.getByIssueId("issue-completed-stop-exhaustion")).toMatchObject({
      state: "error",
      run_id: null,
      last_error: expect.stringContaining("did not confirm termination"),
    });
  });

  it("quarantines and settles a legacy superseded stop without poisoning its replacement", async () => {
    const { tickets, pipelines, runtime, processor, instance, attempt } =
      harness("issue-superseded-quarantine", "session-superseded-quarantine");
    await processor.drain();
    const runId = attempt.planned_run_id!;
    tickets.upsertUnpinned({
      linear_issue_id: "issue-superseded-quarantine",
      linear_issue_identifier: "ISSUE-SUPERSEDED-QUARANTINE",
      linear_session_id: "session-quarantine-replacement",
      sandbox_id: "sandbox-quarantine-replacement",
      branch: "ot/issue-superseded-quarantine",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const stop = pipelines.listEffects(instance.id).find((effect) => effect.kind === "stop")!;
    rewriteEffectPayload(stop.id, (payload) => {
      const { runId: _runId, ...legacyPayload } = payload;
      return legacyPayload;
    });
    db!.prepare("UPDATE pipeline_effect_intents SET attempts = 7 WHERE id = ?").run(stop.id);
    runtime.stop.mockResolvedValue({ confirmed: false });

    await processor.drain();
    await processor.drain();

    expect(runtime.quarantine).toHaveBeenCalledOnce();
    expect(tickets.getRun(runId)).toMatchObject({ status: "quarantined" });
    expect(tickets.getByIssueId("issue-superseded-quarantine")).toMatchObject({
      linear_session_id: "session-quarantine-replacement",
      sandbox_id: "sandbox-quarantine-replacement",
      run_id: runId,
      state: "active",
      last_error: null,
    });

    expect(tickets.settleQuarantinedRun({
      runId,
      status: "stopped",
      ticketState: "error",
      failureTail: "old runtime termination confirmed",
    })).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId("issue-superseded-quarantine")).toMatchObject({
      linear_session_id: "session-quarantine-replacement",
      sandbox_id: "sandbox-quarantine-replacement",
      run_id: null,
      state: "active",
      last_error: null,
    });
  });
});
