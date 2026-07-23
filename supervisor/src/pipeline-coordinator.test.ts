import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTicketStore, openDb } from "./db.js";
import {
  coordinatePipelineEvent,
  reducePipelineEvent,
  type PipelineCoordinatorEvent,
} from "./pipeline-coordinator.js";
import {
  STAGE_OUTCOMES,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
} from "./pipeline-manifest.js";
import { createPipelineStore, type PipelineInstance, type PipelineStageAttempt } from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("coordinator-test/v1");

describe("pipeline coordinator", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  function setup(manifestKey = "fixture/command@1") {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { implement: fixture-command }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get(manifestKey)!;
    tickets.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
        taskContext: "Approved ticket plan",
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const stages = pipelines.listStages(instance.id);
    return { pipelines, manifest: manifest.manifest, instance, attempt, stages };
  }

  function event(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    outcome: PipelineCoordinatorEvent["outcome"] = "success",
    id = `event-${outcome}`
  ): PipelineCoordinatorEvent {
    const stageResultPayload = JSON.stringify({ id, outcome });
    const resultHash = digestNormalized(stageResultPayload);
    const command = attempt.stage_id === "command";
    return {
      id,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: attempt.id,
      requestHash: attempt.request_hash,
      outcome,
      resultHash,
      artifacts: [
        {
          kind: "stage_result",
          schemaVersion: 1,
          assurance: command ? "executor_verified" : "semantic_attested",
          payload: stageResultPayload,
          hash: resultHash,
        },
        ...(command ? [{
          kind: "command_result",
          schemaVersion: 1,
          assurance: "executor_verified" as const,
          payload: JSON.stringify({ exitCode: outcome === "success" ? 0 : 1 }),
          hash: digestNormalized(JSON.stringify({ exitCode: outcome === "success" ? 0 : 1 })),
        }] : []),
      ],
    };
  }

  it("has one deterministic policy for every declared stage outcome", () => {
    const { manifest, instance, attempt, stages } = setup();
    for (const outcome of STAGE_OUTCOMES) {
      const write = reducePipelineEvent({
        manifest,
        instance: { ...instance },
        attempt: { ...attempt },
        stages,
        event: event(instance, attempt, outcome),
      });
      expect(write.instanceId).toBe(instance.id);
      expect(write.outcome).toBe(outcome);
      expect(write.effects).toHaveLength(
        write.terminalOutcome === "shipped" || write.terminalOutcome === "no_change" ||
          write.terminalOutcome === "failed" ? 2 : 1
      );
    }
  });

  it("commits a transition and all effects once, including after commit-before-retry", () => {
    const { pipelines, instance, attempt } = setup();
    const input = event(instance, attempt);
    const completed = coordinatePipelineEvent(pipelines, input);
    expect(completed.state_version).toBe(1);
    expect(completed.status).toBe("completion_pending_publication");
    expect(completed.terminal_outcome).toBe("shipped");
    expect(pipelines.listEffects(instance.id).map((effect) => effect.kind)).toEqual([
      "provision",
      "publish_linear",
      "cleanup",
      "publish_github",
    ]);

    const replay = coordinatePipelineEvent(pipelines, input);
    expect(replay.state_version).toBe(1);
    expect(pipelines.listEffects(instance.id)).toHaveLength(4);
  });

  it("rolls back every transition write boundary and recovers one complete intent set", () => {
    const { pipelines, instance, attempt } = setup();
    const input = event(instance, attempt, "success", "fault-event");
    for (let failAt = 1; failAt <= 10; failAt += 1) {
      expect(() => coordinatePipelineEvent(pipelines, input, (writes) => {
        if (writes === failAt) throw new Error(`fault after write ${writes}`);
      })).toThrow(`fault after write ${failAt}`);
      expect(pipelines.getInstance(instance.id)?.state_version).toBe(0);
      expect(pipelines.getAttempt(attempt.id)?.status).toBe("pending");
      expect(pipelines.listEffects(instance.id)).toHaveLength(1);
    }

    const completed = coordinatePipelineEvent(pipelines, input);
    expect(completed.state_version).toBe(1);
    expect(pipelines.listEffects(instance.id)).toHaveLength(4);
  });

  it("enforces bounded repair and uses explicit on_exhausted policy", () => {
    const { manifest, instance, attempt, stages } = setup("ce/implement@2");
    const repair = event(instance, attempt, "semantic_repair_required", "repair-event");
    const allowed = reducePipelineEvent({
      manifest,
      instance: { ...instance, reentry_count: 2 },
      attempt,
      stages: stages.map((stage) => ({ ...stage, reentry_count: stage.stage_id === "planning" ? 2 : stage.reentry_count })),
      event: repair,
    });
    expect(allowed.nextStageId).toBe("planning");
    expect(allowed.nextAttempt?.reentryOrdinal).toBe(3);

    const exhausted = reducePipelineEvent({
      manifest,
      instance: { ...instance, reentry_count: 3 },
      attempt,
      stages: stages.map((stage) => ({ ...stage, reentry_count: stage.stage_id === "planning" ? 3 : stage.reentry_count })),
      event: repair,
    });
    expect(exhausted.nextStatus).toBe("completion_pending_publication");
    expect(exhausted.terminalOutcome).toBe("needs_human");
    expect(exhausted.nextAttempt).toBeUndefined();

    const attemptsExhausted = reducePipelineEvent({
      manifest,
      instance: { ...instance, attempt_count: manifest.max_attempts },
      attempt,
      stages,
      event: event(instance, attempt, "retryable_infrastructure_failure", "attempt-limit"),
    });
    expect(attemptsExhausted.nextStatus).toBe("completion_pending_publication");
    expect(attemptsExhausted.waitReason).toMatch(/attempt limit/);
    expect(attemptsExhausted.nextAttempt).toBeUndefined();
  });

  it("persists a complete immutable request for a repair attempt", () => {
    const { pipelines, instance, attempt } = setup("ce/implement@2");
    const repaired = coordinatePipelineEvent(
      pipelines,
      event(instance, attempt, "semantic_repair_required", "repair-request")
    );
    const next = pipelines.getActiveAttempt(repaired.id)!;
    const request = pipelines.getStageRequest(next.id);
    expect(request).toMatchObject({
      pipelineInstanceId: instance.id,
      stageId: "planning",
      attemptId: next.id,
      runId: next.planned_run_id,
      requestHash: next.request_hash,
      idempotencyKey: next.idempotency_key,
      agent: "codex",
      contextRevision: 1,
      taskContext: "Approved ticket plan",
    });
    expect(request.transitionContext).toContain("semantic_repair_required");
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "dispatch_stage")).toMatchObject({
      kind: "dispatch_stage",
      payload: next.request_payload,
    });
  });

  it("cannot enter provider wait until the publishing stage establishes an exact subject", () => {
    const { manifest, instance, attempt, stages } = setup("ce/implement@2");
    const publishAttempt = {
      ...attempt,
      id: "publish-attempt",
      stage_id: "publish",
      request_hash: "f".repeat(64),
      native_context_policy: "resume_required",
    };
    const payload = JSON.stringify({ outcome: "success" });
    const publishPayload = JSON.stringify({ published: true });
    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...instance, active_stage_id: "publish", status: "running" },
      attempt: publishAttempt,
      stages,
      event: {
        id: "publish-without-subject",
        kind: "stage_result",
        instanceId: instance.id,
        generation: instance.generation,
        attemptId: publishAttempt.id,
        requestHash: publishAttempt.request_hash,
        outcome: "success",
        resultHash: digestNormalized(payload),
        artifacts: [
          {
            kind: "stage_result",
            schemaVersion: 1,
            assurance: "semantic_attested",
            payload,
            hash: digestNormalized(payload),
          },
          {
            kind: "publish_subject",
            schemaVersion: 1,
            assurance: "semantic_attested",
            payload: publishPayload,
            hash: digestNormalized(publishPayload),
          },
        ],
      },
    })).toThrow(/provider wait without an exact subject/);
  });

  it("turns a current-head provider snapshot into a bounded typed repair re-entry", () => {
    const { manifest, instance, attempt, stages } = setup("ce/implement@2");
    const providerAttempt = {
      ...attempt,
      id: "provider-attempt",
      stage_id: "provider",
      request_hash: "e".repeat(64),
      native_context_policy: "none",
    };
    const stageResult = JSON.stringify({ outcome: "semantic_repair_required" });
    const providerCheck = JSON.stringify({ head: "head-current", conclusion: "failure" });
    const resultHash = digestNormalized(stageResult);
    const write = reducePipelineEvent({
      manifest,
      instance: {
        ...instance,
        status: "waiting_provider",
        active_stage_id: "provider",
        immutable_subject: "head-current",
      },
      attempt: providerAttempt,
      stages: stages.map((stage) => stage.stage_id === "provider" ? { ...stage, status: "waiting" } : stage),
      event: {
        id: "provider-snapshot",
        kind: "provider_snapshot",
        instanceId: instance.id,
        generation: instance.generation,
        attemptId: providerAttempt.id,
        requestHash: providerAttempt.request_hash,
        outcome: "semantic_repair_required",
        resultHash,
        subject: "head-current",
        artifacts: [
          {
            kind: "stage_result",
            schemaVersion: 1,
            assurance: "provider_verified",
            payload: stageResult,
            hash: resultHash,
            subject: "head-current",
          },
          {
            kind: "provider_check",
            schemaVersion: 1,
            assurance: "provider_verified",
            payload: providerCheck,
            hash: digestNormalized(providerCheck),
            subject: "head-current",
          },
        ],
      },
    });
    expect(write.nextStageId).toBe("implementation");
    expect(write.nextStatus).toBe("dispatchable");
    expect(write.reentryIncrement).toBe(1);
  });

  it("rejects stale generation, request, subject, and provider-state re-entry", () => {
    const { pipelines, manifest, instance, attempt, stages } = setup();
    expect(pipelines.enqueueInboxEvent({
      id: "wrong-generation",
      instanceId: instance.id,
      generation: instance.generation + 1,
      kind: "stage_result",
      payload: "{}",
    })).toBe("stale");
    expect(() => reducePipelineEvent({
      manifest,
      instance,
      attempt,
      stages,
      event: { ...event(instance, attempt), generation: instance.generation - 1 },
    })).toThrow(/generation is stale/);
    expect(() => reducePipelineEvent({
      manifest,
      instance,
      attempt,
      stages,
      event: { ...event(instance, attempt), requestHash: "wrong" },
    })).toThrow(/attempt fence mismatch/);

    db!.prepare("UPDATE pipeline_instances SET immutable_subject = ? WHERE id = ?")
      .run("head-current", instance.id);
    expect(pipelines.enqueueInboxEvent({
      id: "old-head",
      instanceId: instance.id,
      generation: instance.generation,
      kind: "provider_snapshot",
      payload: "{}",
      subject: "head-old",
    })).toBe("stale");
    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...instance, immutable_subject: "head-current" },
      attempt,
      stages,
      event: {
        ...event(instance, attempt),
        id: "provider-event",
        kind: "provider_snapshot",
        subject: "head-current",
      },
    })).toThrow(/provider-waiting/);
  });

  it("fails closed when a success omits typed evidence or claims unsupported assurance", () => {
    const { manifest, instance, attempt, stages } = setup();
    expect(() => reducePipelineEvent({
      manifest,
      instance,
      attempt,
      stages,
      event: { ...event(instance, attempt), artifacts: [] },
    })).toThrow(/missing required stage_result/);
    const unsupported = event(instance, attempt);
    unsupported.artifacts = unsupported.artifacts?.map((artifact) => ({
      ...artifact,
      assurance: "semantic_attested",
    }));
    expect(() => reducePipelineEvent({ manifest, instance, attempt, stages, event: unsupported }))
      .toThrow(/unsupported assurance/);

    const staleSubject = event(instance, attempt);
    staleSubject.subject = "head-current";
    staleSubject.artifacts = staleSubject.artifacts?.map((artifact) => ({
      ...artifact,
      subject: "head-old",
    }));
    expect(() => reducePipelineEvent({ manifest, instance, attempt, stages, event: staleSubject }))
      .toThrow(/subject does not match/);
  });

  it("requires stop and supersede events to use their exact terminal outcomes", () => {
    const { manifest, instance, attempt, stages } = setup();
    expect(() => reducePipelineEvent({
      manifest,
      instance,
      attempt,
      stages,
      event: { ...event(instance, attempt, "superseded"), kind: "stop" },
    })).toThrow(/stop must use outcome canceled/);
    expect(() => reducePipelineEvent({
      manifest,
      instance,
      attempt,
      stages,
      event: { ...event(instance, attempt, "canceled"), kind: "supersede" },
    })).toThrow(/supersede must use outcome superseded/);
  });

  it("contains no CE-specific coordinator branch", () => {
    const source = readFileSync(fileURLToPath(new URL("./pipeline-coordinator.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/ce\//i);
    expect(source).not.toMatch(/ce-work|ce-code-review|ce-debug/i);
  });
});
