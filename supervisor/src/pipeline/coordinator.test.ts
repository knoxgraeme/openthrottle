import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import {
  coordinatePipelineEvent,
  reducePipelineEvent,
  type PipelineCoordinatorEvent,
} from "./coordinator.js";
import {
  STAGE_OUTCOMES,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  type PipelineManifest,
} from "./manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import type { PipelineInstance, PipelineInstanceStage, PipelineStageAttempt } from "./store.js";
import { buildInstalledRuntimeDescriptor } from "../runtime/contracts.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("coordinator-test/v1");

describe("pipeline coordinator", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  function setup(manifestKey = "fixture/command@1") {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const catalog = loadPipelineCatalog(
      manifestKey.startsWith("fixture/") ? catalogPath : shippedCatalogPath,
      runtime.descriptor
    );
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
    id = `event-${outcome}`,
    artifacts: Array<"stage_result" | "review"> = ["stage_result"]
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
        ...artifacts.map((kind) => {
          const payload = kind === "stage_result"
            ? stageResultPayload
            : JSON.stringify({ id: `${id}-review`, findings: [] });
          return {
            kind,
            schemaVersion: 1,
            assurance: command ? "executor_verified" as const : "semantic_attested" as const,
            payload,
            hash: kind === "stage_result" ? resultHash : digestNormalized(payload),
          };
        }),
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

  function activeAgentAttempt(
    attempt: PipelineStageAttempt,
    stageId: string
  ): PipelineStageAttempt {
    return {
      ...attempt,
      id: `${stageId}-attempt`,
      stage_id: stageId,
      request_hash: digestNormalized(`${stageId}-request`),
      native_context_policy: "resume_required",
    };
  }

  function reduceActiveAgentStage(input: {
    manifest: PipelineManifest;
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
    stages: PipelineInstanceStage[];
    stageId: string;
    outcome: PipelineCoordinatorEvent["outcome"];
    id: string;
    artifacts?: Array<"stage_result" | "review">;
  }) {
    const attempt = activeAgentAttempt(input.attempt, input.stageId);
    return reducePipelineEvent({
      manifest: input.manifest,
      instance: {
        ...input.instance,
        status: "running",
        active_stage_id: input.stageId,
      },
      attempt,
      stages: input.stages.map((stage) => stage.stage_id === input.stageId
        ? { ...stage, status: "running" }
        : stage),
      event: event(input.instance, attempt, input.outcome, input.id, input.artifacts),
    });
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
        write.terminalOutcome === "failed" ? 3 : write.terminalOutcome ? 2 : 1
      );
    }
  });

  it("releases the runtime with a cleanup effect on every terminal outcome", () => {
    const { manifest, instance, attempt, stages } = setup();
    const terminals = [
      { outcome: "needs_human", terminal: "needs_human", kinds: ["publish_linear", "cleanup"] },
      { outcome: "canceled", terminal: "canceled", kinds: ["publish_linear", "cleanup"] },
      { outcome: "superseded", terminal: "superseded", kinds: ["publish_linear", "cleanup"] },
      { outcome: "failure", terminal: "failed", kinds: ["publish_linear", "stop", "cleanup"] },
    ] as const;
    for (const { outcome, terminal, kinds } of terminals) {
      const write = reducePipelineEvent({
        manifest,
        instance: { ...instance },
        attempt: { ...attempt },
        stages,
        event: event(instance, attempt, outcome),
      });
      expect(write.terminalOutcome).toBe(terminal);
      expect(write.effects.map((effect) => effect.kind)).toEqual([...kinds]);
      const cleanup = write.effects[write.effects.length - 1];
      expect(cleanup).toMatchObject({
        kind: "cleanup",
        idempotencyKey: `cleanup:${instance.id}:${terminal}`,
      });
      // Only needs_human preserves the workspace; every other terminal deletes.
      expect(JSON.parse(cleanup.payload).preserve).toBe(
        terminal === "needs_human" ? true : undefined
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
      "publish_github",
      "cleanup",
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
    expect(exhausted.effects.map((effect) => effect.kind)).toEqual(["publish_linear", "cleanup"]);
    expect(exhausted.effects[1]).toMatchObject({
      idempotencyKey: `cleanup:${instance.id}:needs_human`,
    });
    expect(JSON.parse(exhausted.effects[1].payload).preserve).toBe(true);

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
    expect(attemptsExhausted.effects.map((effect) => effect.kind))
      .toEqual(["publish_linear", "stop", "cleanup"]);
  });

  it("does not exhaust the raw attempt budget in the middle of a forward repair round", () => {
    const { manifest, instance, attempt, stages } = setup("ce/implement@2");
    const repairedImplementation = reducePipelineEvent({
      manifest,
      instance: {
        ...instance,
        status: "running",
        active_stage_id: "implementation",
        attempt_count: manifest.max_attempts,
      },
      attempt: {
        ...attempt,
        stage_id: "implementation",
        request_hash: "d".repeat(64),
        native_context_policy: "resume_required",
        reentry_ordinal: 2,
      },
      stages: stages.map((stage) => stage.stage_id === "implementation"
        ? { ...stage, status: "running", reentry_count: 2 }
        : stage),
      event: {
        ...event(instance, attempt, "success", "repair-forward"),
        attemptId: attempt.id,
        requestHash: "d".repeat(64),
      },
    });

    expect(repairedImplementation.nextStageId).toBe("semantic_review");
    expect(repairedImplementation.nextAttempt).toMatchObject({
      stageId: "semantic_review",
      reentryOrdinal: 0,
    });
    expect(repairedImplementation.terminalOutcome).toBeUndefined();
  });

  it("skips post-simplify review when simplification reports no change", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@3");
    const write = reduceActiveAgentStage({
      manifest,
      instance,
      attempt,
      stages,
      stageId: "simplification",
      outcome: "no_change",
      id: "simplify-no-change",
    });

    expect(write.nextStageId).toBe("test");
    expect(write.nextAttempt).toMatchObject({
      stageId: "test",
      reentryOrdinal: 0,
    });
    expect(write.effects).toHaveLength(1);
    expect(write.effects[0]).toMatchObject({ kind: "dispatch_stage" });
  });

  it("runs post-simplify review after simplification changes and routes repairs to implementation", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@3");
    const afterSimplify = reduceActiveAgentStage({
      manifest,
      instance,
      attempt,
      stages,
      stageId: "simplification",
      outcome: "success",
      id: "simplify-changed",
    });

    expect(afterSimplify.nextStageId).toBe("post_simplify_review");
    expect(afterSimplify.nextAttempt).toMatchObject({
      stageId: "post_simplify_review",
      reentryOrdinal: 0,
      contextPolicy: "resume_required",
    });

    const repair = reduceActiveAgentStage({
      manifest,
      instance,
      attempt,
      stages,
      stageId: "post_simplify_review",
      outcome: "semantic_repair_required",
      id: "post-simplify-repair",
      artifacts: ["stage_result", "review"],
    });

    expect(repair.nextStageId).toBe("implementation");
    expect(repair.reentryIncrement).toBe(1);
    expect(repair.nextAttempt).toMatchObject({
      stageId: "implementation",
      reentryOrdinal: 1,
    });
  });

  it("persists a complete immutable request for a repair attempt", () => {
    const { pipelines, instance, attempt } = setup("ce/implement@2");
    const input = event(instance, attempt, "semantic_repair_required", "repair-request");
    const payload = JSON.stringify({
      id: "repair-request",
      outcome: "semantic_repair_required",
      summary: "A blocking defect must be repaired.",
      findings: [{ severity: "P1", code: "review-blocking", summary: "The gate found a blocking defect." }],
    });
    input.resultHash = digestNormalized(payload);
    input.artifacts = [{
      kind: "stage_result",
      schemaVersion: 1,
      assurance: "semantic_attested",
      payload,
      hash: digestNormalized(payload),
    }];
    const repaired = coordinatePipelineEvent(pipelines, input);
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
    // The structured findings must ride the sealed request: the resumed
    // session's memory of them is best-effort, the request is the guarantee.
    expect(JSON.parse(request.transitionContext).findings).toEqual([
      { severity: "P1", code: "review-blocking", summary: "The gate found a blocking defect." },
    ]);
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

  it("publishes control stop and supersede terminals without racing cleanup", () => {
    for (const [kind, outcome, terminal] of [
      ["stop", "canceled", "canceled"],
      ["supersede", "superseded", "superseded"],
    ] as const) {
      const { pipelines, manifest, instance, attempt, stages } = setup();
      const input = { ...event(instance, attempt, outcome, `${kind}-event`), kind };
      const write = reducePipelineEvent({ manifest, instance, attempt, stages, event: input });

      expect(write).toMatchObject({
        terminalOutcome: terminal,
        resumeStatus: terminal,
        nextStatus: "completion_pending_publication",
      });
      expect(write.effects.map((effect) => effect.kind)).toEqual(["publish_linear", "stop"]);
      expect(write.effects.find((effect) => effect.kind === "cleanup")).toBeUndefined();
      expect(write.effects.find((effect) => effect.kind === "publish_linear")?.payload)
        .toBe(JSON.stringify({ publication: "deferred_to_coordinator" }));

      coordinatePipelineEvent(pipelines, input);

      const effects = pipelines.listEffects(instance.id);
      expect(effects.filter((effect) => effect.kind === "publish_linear")).toHaveLength(1);
      expect(effects.filter((effect) => effect.kind === "publish_github")).toHaveLength(1);
      expect(effects.filter((effect) => effect.kind === "stop")).toHaveLength(1);
      expect(effects.find((effect) => effect.kind === "cleanup")).toBeUndefined();
      expect(effects.find((effect) => effect.kind === "publish_linear")?.payload)
        .toContain("\"schema\":\"openthrottle.pipeline-publication/v1\"");
    }
  });

  it("contains no CE-specific coordinator branch", () => {
    const source = readFileSync(fileURLToPath(new URL("./coordinator.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/ce\//i);
    expect(source).not.toMatch(/ce-work|ce-code-review|ce-debug/i);
  });
});
