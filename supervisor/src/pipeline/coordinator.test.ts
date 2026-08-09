import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import {
  coordinatePipelineEvent,
  reducePipelineEvent,
  type PipelineCoordinatorEvent,
} from "./coordinator.js";
import {
  STAGE_OUTCOMES,
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  type PipelineManifest,
  type PipelineUnitPhaseBinding,
} from "./manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { createRunOutcomeStore } from "../persistence/pipeline/run-outcome-store.js";
import type { PipelineInstance, PipelineInstanceStage, PipelineStageAttempt } from "./store.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";
import type { ExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import type { ExecutionGateDecision } from "./execution-gates.js";
import type { GateReceiptReason } from "./gates.js";
import { createLinearOutboxProcessor } from "../providers/linear/outbox.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("coordinator-test/v1");

function unitPhaseBindings(): PipelineUnitPhaseBinding[] {
  const worker = {
    id: "worker",
    engine: "agent" as const,
    allowed_mcp_servers: [],
    session_scope: "fresh" as const,
    credentials: ["model.invoke", "repo.read", "repo.write"],
  };
  return [
    {
      id: "implement",
      kind: "agent",
      loop: {
        id: "loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "candidate", kind: "evidence" },
    {
      id: "lead",
      kind: "gate",
      loop: {
        id: "lead-loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "integrate", kind: "integrate" },
  ];
}

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
    const config = parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n");
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

  function stageResultEvent(input: {
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
    outcome?: PipelineCoordinatorEvent["outcome"];
    id: string;
    summary: string;
    evidence?: string[];
    uncertainty?: string[];
  }): PipelineCoordinatorEvent {
    const payload = JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: input.outcome ?? "success",
      summary: input.summary,
      evidence: input.evidence ?? [],
      findings: [],
      actions: [],
      uncertainty: input.uncertainty ?? [],
    });
    return {
      id: input.id,
      kind: "stage_result",
      instanceId: input.instance.id,
      generation: input.instance.generation,
      attemptId: input.attempt.id,
      requestHash: input.attempt.request_hash,
      outcome: input.outcome ?? "success",
      resultHash: digestNormalized(payload),
      artifacts: [{
        kind: "stage_result",
        schemaVersion: 1,
        assurance: "semantic_attested",
        payload,
        hash: digestNormalized(payload),
      }],
    };
  }

  function providerFeedbackEvent(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    outcome: PipelineCoordinatorEvent["outcome"],
    id: string,
    options: { providerRevision?: string } = {}
  ): PipelineCoordinatorEvent {
    const stageResultPayload = JSON.stringify({ id, outcome });
    const providerCheckPayload = JSON.stringify({ id: `${id}-provider-check`, outcome });
    const subject = instance.immutable_subject ?? "f".repeat(40);
    return {
      id,
      kind: "provider_snapshot",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: attempt.id,
      requestHash: attempt.request_hash,
      outcome,
      resultHash: digestNormalized(stageResultPayload),
      subject,
      ...(options.providerRevision ? { providerRevision: options.providerRevision } : {}),
      artifacts: [
        {
          kind: "stage_result",
          schemaVersion: 1,
          assurance: "provider_verified",
          subject,
          payload: stageResultPayload,
          hash: digestNormalized(stageResultPayload),
        },
        {
          kind: "provider_check",
          schemaVersion: 1,
          assurance: "provider_verified",
          subject,
          payload: providerCheckPayload,
          hash: digestNormalized(providerCheckPayload),
        },
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

  function providerWaitStages(
    stages: PipelineInstanceStage[],
    repairReentryCount: number
  ): PipelineInstanceStage[] {
    return stages.map((stage) => stage.stage_id === "repair_implementation"
      ? { ...stage, reentry_count: repairReentryCount }
      : stage.stage_id === "provider"
        ? { ...stage, status: "waiting" }
        : stage);
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

  it("clears persisted publication evidence when a stage advances the subject after publishing", () => {
    const { pipelines, instance, attempt } = setup();
    const publishedSubject = "b".repeat(40);
    const unpublishedSubject = "c".repeat(40);
    const publishedCommit = "d".repeat(40);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(publishedSubject, publishedCommit, publishedSubject, instance.id);
    const input = event(
      {
        ...instance,
        immutable_subject: publishedSubject,
        published_commit: publishedCommit,
        published_subject: publishedSubject,
      },
      attempt,
      "retryable_infrastructure_failure",
      "post-publication-subject-advance"
    );
    const subjectAdvancingEvent: PipelineCoordinatorEvent = {
      ...input,
      subject: unpublishedSubject,
      artifacts: input.artifacts?.map((artifact) => ({ ...artifact, subject: unpublishedSubject })),
    };

    const next = coordinatePipelineEvent(pipelines, subjectAdvancingEvent);

    expect(next.immutable_subject).toBe(unpublishedSubject);
    expect(next.published_commit).toBeNull();
    expect(next.published_subject).toBeNull();
  });

  it("writes one run_outcomes settlement row when the pipeline reaches a terminal outcome", () => {
    const { pipelines, instance, attempt } = setup();
    const completed = coordinatePipelineEvent(pipelines, event(instance, attempt));
    expect(completed.terminal_outcome).toBe("shipped");

    // getRunOutcome is deliberately absent from PipelineStore (see
    // pipeline/store.ts) so gate/transition/scheduler/effect-drain code has
    // no read path into the corpus; this assertion goes straight to
    // RunOutcomeStore, the same way run-outcome-store.test.ts does.
    const outcome = createRunOutcomeStore(db!).getRunOutcome(instance.id);
    expect(outcome).toMatchObject({
      pipeline_instance_id: instance.id,
      linear_issue_id: instance.linear_issue_id,
      generation: instance.generation,
      generations_consumed: instance.generation,
      execution_graph_id: null,
      plan_digest: null,
      base_commit: instance.base_commit,
      engine: instance.agent,
      outcome: "shipped",
      closed_reason: "success",
      fault_attribution: null,
      // No production path stamps runs.cost_usd -- NULL means unmeasured,
      // never a fabricated 0.
      token_cost_usd: null,
    });
    expect(JSON.parse(outcome!.repair_rounds_by_unit)).toEqual({});
    expect(JSON.parse(outcome!.phase_durations_ms)).toEqual({});
    expect(JSON.parse(outcome!.skill_digests)).toEqual([]);

    expect(pipelines.pruneRunOutcomes("2099-01-01T00:00:00.000Z")).toBe(1);
    expect(createRunOutcomeStore(db!).getRunOutcome(instance.id)).toBeUndefined();
  });

  it("does not write a run_outcomes row for a non-terminal transition", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
    const completed = coordinatePipelineEvent(pipelines, event(instance, attempt, "semantic_repair_required"));
    expect(completed.terminal_outcome).toBeNull();
    expect(createRunOutcomeStore(db!).getRunOutcome(instance.id)).toBeUndefined();
  });

  it("refuses to settle a publishing manifest as shipped without exact provider publication evidence", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const subject = "f".repeat(40);
    const publishedCommit = "d".repeat(40);
    const providerAttempt = {
      ...attempt,
      id: "provider-attempt",
      stage_id: "provider",
      request_hash: digestNormalized("provider-request"),
      native_context_policy: "none" as const,
      expected_subject: subject,
    };
    const providerInstance = {
      ...instance,
      status: "waiting_provider" as const,
      active_stage_id: "provider",
      immutable_subject: subject,
      published_commit: publishedCommit,
      published_subject: subject,
    };
    const providerStages = providerWaitStages(stages, 0);
    const providerEvent = providerFeedbackEvent(providerInstance, providerAttempt, "success", "provider-success", {
      providerRevision: publishedCommit,
    });
    expect(providerEvent.subject).toBe(subject);
    expect(providerEvent.providerRevision).toBe(publishedCommit);
    expect(providerEvent.subject).not.toBe(providerEvent.providerRevision);

    expect(reducePipelineEvent({
      manifest,
      instance: providerInstance,
      attempt: providerAttempt,
      stages: providerStages,
      event: providerEvent,
    })).toMatchObject({
      terminalOutcome: "shipped",
      publishedCommit: null,
    });

    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...providerInstance, published_commit: null },
      attempt: providerAttempt,
      stages: providerStages,
      event: providerEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...providerInstance, published_subject: null },
      attempt: providerAttempt,
      stages: providerStages,
      event: providerEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...providerInstance, published_subject: "c".repeat(40) },
      attempt: providerAttempt,
      stages: providerStages,
      event: providerEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest,
      instance: providerInstance,
      attempt: providerAttempt,
      stages: providerStages,
      event: { ...providerEvent, providerRevision: "e".repeat(40) },
    })).toThrow(/cannot settle terminal without exact published provider evidence/);
  });

  it("allows a direct publish terminal to ship with exact publish-stage evidence", () => {
    const { manifest, instance, attempt, stages } = setup("core/investigate@1");
    const subject = "f".repeat(40);
    const publishedCommit = "e".repeat(40);
    const publishAttempt = {
      ...attempt,
      id: "publish-attempt",
      stage_id: "publish",
      request_hash: digestNormalized("publish-request"),
      native_context_policy: "resume_required" as const,
      expected_subject: subject,
    };
    const publishPayload = JSON.stringify({ details: { published_commit: publishedCommit } });
    const stageResultPayload = JSON.stringify({ outcome: "success" });
    const publishEvent: PipelineCoordinatorEvent = {
      id: "direct-publish-terminal",
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: publishAttempt.id,
      requestHash: publishAttempt.request_hash,
      outcome: "success",
      resultHash: digestNormalized(stageResultPayload),
      subject,
      providerRevision: publishedCommit,
      artifacts: [
        {
          kind: "stage_result",
          schemaVersion: 1,
          assurance: "semantic_attested",
          subject,
          payload: stageResultPayload,
          hash: digestNormalized(stageResultPayload),
        },
        {
          kind: "publish_subject",
          schemaVersion: 1,
          assurance: "semantic_attested",
          subject,
          payload: publishPayload,
          hash: digestNormalized(publishPayload),
        },
      ],
    };
    const publishStages = stages.map((stage) => stage.stage_id === "publish" ? { ...stage, status: "running" } : stage);

    expect(reducePipelineEvent({
      manifest,
      instance: { ...instance, active_stage_id: "publish", status: "running" },
      attempt: publishAttempt,
      stages: publishStages,
      event: publishEvent,
    })).toMatchObject({
      terminalOutcome: "shipped",
      publishedCommit,
      publishedSubject: subject,
    });

    expect(() => reducePipelineEvent({
      manifest,
      instance: { ...instance, active_stage_id: "publish", status: "running" },
      attempt: publishAttempt,
      stages: publishStages,
      event: {
        ...publishEvent,
        subject: "e".repeat(40),
        artifacts: publishEvent.artifacts?.map((artifact) => ({ ...artifact, subject: "e".repeat(40) })),
        providerRevision: undefined,
      },
    })).toThrow(/cannot settle terminal without exact published provider evidence/);
  });

  it.each([
    ["command", {
      executor: { kind: "command" as const, capability: "command/run@1" },
      evaluator: { kind: "command" as const, assurance: "executor_verified" as const, required_artifacts: ["command_result" as const] },
      credentials: ["repo.read"],
      produces: ["stage_result" as const, "command_result" as const],
      artifacts: ["stage_result", "command_result"] as const,
      assurance: "executor_verified" as const,
    }],
    ["run", {
      executor: { kind: "agent" as const, capability: "ce/implement@1" },
      evaluator: { kind: "semantic" as const, assurance: "semantic_attested" as const, required_artifacts: ["stage_result" as const] },
      credentials: ["model.invoke", "repo.read", "repo.write"],
      produces: ["stage_result" as const],
      artifacts: ["stage_result"] as const,
      assurance: "semantic_attested" as const,
    }],
  ])("settles a post-publication terminal %s stage from persisted exact publication evidence", (stageId, postStage) => {
    const { manifest, instance, attempt, stages } = setup("core/investigate@1");
    const subject = "f".repeat(40);
    const publishedCommit = "a".repeat(40);
    const stalePublishedCommit = "c".repeat(40);
    const stalePublishedSubject = "d".repeat(40);
    const payload = JSON.stringify({ outcome: "success" });
    const resultHash = digestNormalized(payload);
    const postPublicationManifest: PipelineManifest = {
      ...manifest,
      stages: [
        ...manifest.stages.map((stage) => stage.id === "publish"
          ? { ...stage, transitions: { ...stage.transitions, success: { to: stageId } } }
          : stage),
        {
          id: stageId,
          executor: postStage.executor,
          evaluator: postStage.evaluator,
          context: "none",
          live_steering: false,
          credentials: postStage.credentials,
          produces: postStage.produces,
          transitions: {
            success: { terminal: "shipped" },
            no_change: { terminal: "no_change" },
            semantic_repair_required: { terminal: "failed" },
            retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" },
            canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" },
            failure: { terminal: "failed" },
          },
        },
      ],
    };
    const postAttempt = {
      ...attempt,
      id: `${stageId}-attempt`,
      stage_id: stageId,
      request_hash: digestNormalized(`${stageId}-request`),
      native_context_policy: "none" as const,
      expected_subject: subject,
    };
    const exactEvent: PipelineCoordinatorEvent = {
      id: `${stageId}-post-publication-terminal`,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: postAttempt.id,
      requestHash: postAttempt.request_hash,
      outcome: "success",
      resultHash,
      subject,
      artifacts: postStage.artifacts.map((kind) => ({
        kind,
        schemaVersion: 1,
        assurance: postStage.assurance,
        subject,
        payload,
        hash: resultHash,
      })),
    };
    const postInstance = {
      ...instance,
      active_stage_id: stageId,
      status: "running" as const,
      immutable_subject: subject,
      published_commit: publishedCommit,
      published_subject: subject,
      manifest_digest: digestNormalized(canonicalJson(postPublicationManifest)),
      normalized_manifest: canonicalJson(postPublicationManifest),
    };
    const postPublicationStages = stages.map((state) => state.stage_id === "publish"
      ? { ...state, status: "passed" }
      : state.stage_id === stageId
        ? { ...state, status: "running" }
        : state);

    expect(reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: postInstance,
      attempt: postAttempt,
      stages: postPublicationStages,
      event: exactEvent,
    })).toMatchObject({
      terminalOutcome: "shipped",
      publishedCommit: null,
    });

    const noChangePayload = JSON.stringify({ outcome: "no_change" });
    const noChangeHash = digestNormalized(noChangePayload);
    const noChangeEvent: PipelineCoordinatorEvent = {
      ...exactEvent,
      id: `${stageId}-post-publication-no-change-terminal`,
      outcome: "no_change",
      resultHash: noChangeHash,
      artifacts: postStage.artifacts.map((kind) => ({
        kind,
        schemaVersion: 1,
        assurance: postStage.assurance,
        subject,
        payload: noChangePayload,
        hash: noChangeHash,
      })),
    };

    expect(reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: postInstance,
      attempt: postAttempt,
      stages: postPublicationStages,
      event: noChangeEvent,
    })).toMatchObject({
      terminalOutcome: "no_change",
      publishedCommit: null,
    });

    expect(() => reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: { ...postInstance, published_commit: null },
      attempt: postAttempt,
      stages: postPublicationStages,
      event: exactEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: { ...postInstance, published_commit: stalePublishedCommit, published_subject: null },
      attempt: postAttempt,
      stages: postPublicationStages,
      event: exactEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: { ...postInstance, published_subject: stalePublishedSubject },
      attempt: postAttempt,
      stages: postPublicationStages,
      event: exactEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: { ...postInstance, published_subject: null },
      attempt: postAttempt,
      stages: postPublicationStages,
      event: noChangeEvent,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    expect(() => reducePipelineEvent({
      manifest: postPublicationManifest,
      instance: postInstance,
      attempt: postAttempt,
      stages: postPublicationStages,
      event: {
        ...exactEvent,
        id: `${stageId}-changed-subject-terminal`,
        subject: "d".repeat(40),
        artifacts: exactEvent.artifacts?.map((artifact) => ({ ...artifact, subject: "d".repeat(40) })),
      },
    })).toThrow(/cannot settle terminal without exact published provider evidence/);
  });

  function branchingPublicationManifest(base: PipelineManifest): PipelineManifest {
    const commandStage = base.stages.find((stage) => stage.id === "command")!;
    return {
      ...base,
      requires: {
        ...base.requires,
        capabilities: ["command/run@1", "ce/publish@1"],
      },
      entry_stage: "entry",
      stages: [
        {
          ...commandStage,
          id: "entry",
          transitions: {
            success: { terminal: "shipped" },
            no_change: { terminal: "no_change" },
            semantic_repair_required: { to: "publish" },
            retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" },
            canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" },
            failure: { terminal: "failed" },
          },
        },
        {
          id: "publish",
          executor: { kind: "agent", capability: "ce/publish@1" },
          evaluator: { kind: "publish_subject", assurance: "semantic_attested", required_artifacts: ["publish_subject"] },
          context: "resume_required",
          live_steering: false,
          credentials: ["model.invoke", "repo.read", "repo.write", "provider.read"],
          produces: ["stage_result", "publish_subject"],
          transitions: {
            success: { to: "command" },
            no_change: { terminal: "no_change" },
            semantic_repair_required: { terminal: "needs_human" },
            retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" },
            canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" },
            failure: { terminal: "failed" },
          },
        },
        {
          ...commandStage,
          id: "command",
          transitions: {
            success: { terminal: "shipped" },
            no_change: { terminal: "no_change" },
            semantic_repair_required: { terminal: "failed" },
            retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" },
            canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" },
            failure: { terminal: "failed" },
          },
        },
      ],
    };
  }

  function branchingStages(
    stages: PipelineInstanceStage[],
    publishStatus: "pending" | "passed"
  ): PipelineInstanceStage[] {
    const template = stages[0]!;
    return [
      { ...template, stage_id: "entry", ordinal: 0, status: "passed" },
      { ...template, stage_id: "publish", ordinal: 1, status: publishStatus },
      { ...template, stage_id: "command", ordinal: 2, status: "running" },
    ];
  }

  function commandTerminalEvent(input: {
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
    id: string;
    subject?: string;
  }): PipelineCoordinatorEvent {
    const next = event(input.instance, input.attempt, "success", input.id);
    if (!input.subject) return next;
    return {
      ...next,
      subject: input.subject,
      artifacts: next.artifacts?.map((artifact) => ({ ...artifact, subject: input.subject })),
    };
  }

  it("fences shipped terminals by the actually executed publication branch, not the entry success path", () => {
    const { manifest, instance, attempt, stages } = setup();
    const branching = branchingPublicationManifest(manifest);
    const normalizedManifest = canonicalJson(branching);
    const subject = "f".repeat(40);
    const publishedCommit = "a".repeat(40);
    const commandAttempt = {
      ...attempt,
      id: "command-attempt",
      stage_id: "command",
      request_hash: digestNormalized("command-request"),
      native_context_policy: "none" as const,
      expected_subject: subject,
    };
    const commandInstance = {
      ...instance,
      active_stage_id: "command",
      status: "running" as const,
      immutable_subject: subject,
      published_commit: publishedCommit,
      published_subject: subject,
      manifest_digest: digestNormalized(normalizedManifest),
      normalized_manifest: normalizedManifest,
    };
    const passedPublicationStages = branchingStages(stages, "passed");
    const terminal = commandTerminalEvent({
      instance: commandInstance,
      attempt: commandAttempt,
      id: "actual-published-branch-terminal",
      subject,
    });

    expect(reducePipelineEvent({
      manifest: branching,
      instance: commandInstance,
      attempt: commandAttempt,
      stages: passedPublicationStages,
      event: terminal,
    })).toMatchObject({
      terminalOutcome: "shipped",
      publishedCommit: null,
    });

    expect(() => reducePipelineEvent({
      manifest: branching,
      instance: { ...commandInstance, published_commit: null },
      attempt: commandAttempt,
      stages: passedPublicationStages,
      event: terminal,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);

    const advancedSubject = "b".repeat(40);
    expect(() => reducePipelineEvent({
      manifest: branching,
      instance: commandInstance,
      attempt: commandAttempt,
      stages: passedPublicationStages,
      event: commandTerminalEvent({
        instance: commandInstance,
        attempt: commandAttempt,
        id: "actual-published-branch-advanced-terminal",
        subject: advancedSubject,
      }),
    })).toThrow(/cannot settle terminal without exact published provider evidence/);
  });

  it("does not require publication evidence when the actual branch bypassed publication", () => {
    const { manifest, instance, attempt, stages } = setup();
    const branching = branchingPublicationManifest(manifest);
    const normalizedManifest = canonicalJson(branching);
    const commandAttempt = {
      ...attempt,
      id: "command-attempt",
      stage_id: "command",
      request_hash: digestNormalized("command-request"),
      native_context_policy: "none" as const,
    };
    const commandInstance = {
      ...instance,
      active_stage_id: "command",
      status: "running" as const,
      manifest_digest: digestNormalized(normalizedManifest),
      normalized_manifest: normalizedManifest,
    };

    expect(reducePipelineEvent({
      manifest: branching,
      instance: commandInstance,
      attempt: commandAttempt,
      stages: branchingStages(stages, "pending"),
      event: commandTerminalEvent({
        instance: commandInstance,
        attempt: commandAttempt,
        id: "actual-publication-bypass-terminal",
      }),
    })).toMatchObject({
      terminalOutcome: "shipped",
    });
  });

  it("projects notable repair stages into run notes without changing transitions", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'running', active_stage_id = 'repair_implementation'
      WHERE id = ?
    `).run(instance.id);
    db!.prepare(`
      UPDATE pipeline_instance_stages
      SET status = CASE WHEN stage_id = 'repair_implementation' THEN 'running' ELSE status END
      WHERE pipeline_instance_id = ?
    `).run(instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'repair_implementation', status = 'running'
      WHERE id = ?
    `).run(attempt.id);
    const active = pipelines.getAttempt(attempt.id)!;
    const result = coordinatePipelineEvent(pipelines, stageResultEvent({
      instance: { ...instance, status: "running", active_stage_id: "repair_implementation" },
      attempt: active,
      id: "repair-result",
      summary: "Fixed the provider feedback and left no remaining code changes.",
      evidence: ["Provider response included Bearer provider-token-123."],
      uncertainty: ["Provider checks have not rerun yet. sk-test-123456"],
    }));

    expect(result.active_stage_id).not.toBe("repair_implementation");
    const notes = pipelines.listJournalEntries({ issueId: instance.linear_issue_id })
      .filter((entry) => entry.kind === "run_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      actor: "stage_agent",
      issue: "ISSUE-1",
      repository: "owner/repo",
      instance_id: instance.id,
      outcome: "success",
    });
    expect(notes[0].note).toContain("Fixed the provider feedback");
    expect(notes[0].note).not.toContain("sk-test-123456");
    expect(notes[0].structured).not.toContain("provider-token-123");
    expect(notes[0].structured).not.toContain("sk-test-123456");
    expect(JSON.parse(notes[0].structured!)).toMatchObject({
      suggested_outcome: "success",
      uncertainty: ["Provider checks have not rerun yet. [REDACTED]"],
      evidence_refs: ["Provider response included [REDACTED]"],
    });
  });

  it("does not write run notes for clean forward agent stages", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
    const result = coordinatePipelineEvent(pipelines, stageResultEvent({
      instance,
      attempt,
      id: "clean-implementation",
      summary: "Implemented the planned change.",
    }));

    expect(result.active_stage_id).toBe("semantic_review");
    expect(pipelines.listJournalEntries({ issueId: instance.linear_issue_id })
      .filter((entry) => entry.kind === "run_note")).toEqual([]);
  });

  it("attributes structured ledger publication projections to the supervisor", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
    if (!attempt.planned_run_id) {
      throw new Error("expected active attempt to have a planned run id");
    }
    const unitStore = pipelines as typeof pipelines & ExecutionUnitStore;
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: attempt.id,
      parentStageId: attempt.stage_id,
      parentRunId: attempt.planned_run_id,
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "U1" }],
      unitPhaseBindings: unitPhaseBindings(),
    });

    coordinatePipelineEvent(pipelines, stageResultEvent({
      instance,
      attempt,
      id: "structured-ledger-result",
      summary: "Implemented the planned change.",
    }));

    const notes = pipelines.listJournalEntries({ issueId: instance.linear_issue_id })
      .filter((entry) => entry.trigger === `${attempt.stage_id} structured publication`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      actor: "supervisor",
      kind: "run_note",
      outcome: "success",
    });
    expect(JSON.parse(notes[0].structured!)).toMatchObject({
      unit_count: 1,
      aggregate_artifact_hash: null,
    });
  });

  it("projects Codex model credential failures into run notes", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
    const result = coordinatePipelineEvent(pipelines, stageResultEvent({
      instance,
      attempt,
      id: "codex-model-auth-expired",
      outcome: "retryable_infrastructure_failure",
      summary: "Model credential expired - refresh CODEX_AUTH_JSON. Agent stage failed (exit=1).",
    }));

    expect(result.active_stage_id).toBe("implementation");
    const notes = pipelines.listJournalEntries({ issueId: instance.linear_issue_id })
      .filter((entry) => entry.kind === "run_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      actor: "stage_agent",
      outcome: "retryable_infrastructure_failure",
    });
    expect(notes[0].note).toContain("Model credential expired - refresh CODEX_AUTH_JSON");
    expect(JSON.parse(notes[0].structured!)).toMatchObject({
      suggested_outcome: "retryable_infrastructure_failure",
    });
  });

  it.each([
    ["fixture/agent@1", "success", "resume", "resume_required", "native-session-before-transition", "native-session-before-transition"],
    ["core/investigate@1", "retryable_infrastructure_failure", "investigate", "prefer_resume", "native-session-before-transition", "native-session-before-transition"],
    ["core/implement@4", "retryable_infrastructure_failure", "implementation", "fresh", null, null],
    ["fixture/command@1", "retryable_infrastructure_failure", "command", "none", "native-session-before-transition", null],
  ] as const)(
    "applies the target context policy for %s when carrying a native session",
    (manifestKey, outcome, expectedStageId, expectedPolicy, expectedLineageId, expectedRequestSessionId) => {
      const { manifest, instance, attempt, stages } = setup(manifestKey);
      const currentAttempt = expectedPolicy === "none"
        ? { ...attempt, native_session_id: "native-session-before-transition" }
        : attempt;
      const write = reducePipelineEvent({
        manifest,
        instance,
        attempt: currentAttempt,
        stages,
        event: {
          ...event(
            instance,
            currentAttempt,
            outcome,
            `session-policy-${expectedPolicy}`,
            manifestKey === "core/investigate@1" ? ["stage_result", "review"] : ["stage_result"]
          ),
          nativeSessionId: expectedPolicy === "none" ? null : "native-session-before-transition",
        },
      });

      expect(write.nextAttempt).toMatchObject({
        stageId: expectedStageId,
        contextPolicy: expectedPolicy,
        nativeSessionId: expectedLineageId,
      });
      expect(JSON.parse(write.nextAttempt!.requestPayload)).toMatchObject({
        contextPolicy: expectedPolicy,
        nativeSessionId: expectedRequestSessionId,
      });
    }
  );

  it("preserves agent session lineage through command stages into resume-required publish", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const nativeSessionId = "native-session-before-commands";
    let currentInstance: PipelineInstance = {
      ...instance,
      status: "running",
      active_stage_id: "post_simplify_review",
    };
    let currentAttempt: PipelineStageAttempt = {
      ...attempt,
      stage_id: "post_simplify_review",
      native_context_policy: "resume_required",
      native_session_id: nativeSessionId,
      request_hash: digestNormalized("post-simplify-review-request"),
    };

    for (const expectedStageId of ["test", "lint", "build", "publish"]) {
      const currentStage = manifest.stages.find((stage) => stage.id === currentAttempt.stage_id)!;
      const artifactKinds = [...new Set(["stage_result", ...currentStage.evaluator.required_artifacts])];
      const artifacts = artifactKinds.map((kind) => {
        const payload = JSON.stringify({ stage: currentStage.id, kind, outcome: "success" });
        return {
          kind,
          schemaVersion: 1,
          assurance: currentStage.evaluator.assurance,
          payload,
          hash: digestNormalized(payload),
        };
      });
      const stageResult = artifacts.find((artifact) => artifact.kind === "stage_result")!;
      const write = reducePipelineEvent({
        manifest,
        instance: currentInstance,
        attempt: currentAttempt,
        stages,
        event: {
          id: `session-lineage-${currentStage.id}`,
          kind: "stage_result",
          instanceId: currentInstance.id,
          generation: currentInstance.generation,
          attemptId: currentAttempt.id,
          requestHash: currentAttempt.request_hash,
          outcome: "success",
          resultHash: stageResult.hash,
          nativeSessionId: currentStage.context === "none" ? null : nativeSessionId,
          artifacts,
        },
      });
      const nextAttempt = write.nextAttempt!;
      const request = JSON.parse(nextAttempt.requestPayload);

      expect(nextAttempt).toMatchObject({
        stageId: expectedStageId,
        nativeSessionId,
      });
      expect(request).toMatchObject({
        contextPolicy: expectedStageId === "publish" ? "resume_required" : "none",
        nativeSessionId: expectedStageId === "publish" ? nativeSessionId : null,
      });

      currentInstance = {
        ...currentInstance,
        active_stage_id: nextAttempt.stageId,
        attempt_count: currentInstance.attempt_count + 1,
        state_version: currentInstance.state_version + 1,
      };
      currentAttempt = {
        ...currentAttempt,
        id: nextAttempt.id!,
        stage_id: nextAttempt.stageId,
        attempt_ordinal: nextAttempt.attemptOrdinal,
        reentry_ordinal: nextAttempt.reentryOrdinal,
        run_id: nextAttempt.plannedRunId,
        planned_run_id: nextAttempt.plannedRunId,
        expected_subject: nextAttempt.expectedSubject,
        native_session_id: nextAttempt.nativeSessionId,
        request_payload: nextAttempt.requestPayload,
        request_hash: nextAttempt.requestHash,
        idempotency_key: nextAttempt.idempotencyKey,
        context_revision: nextAttempt.contextRevision,
        native_context_policy: nextAttempt.contextPolicy,
        status: "running",
        outcome: null,
        result_hash: null,
      };
    }
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
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const repair = event(instance, attempt, "semantic_repair_required", "repair-event");
    const allowed = reducePipelineEvent({
      manifest,
      instance: { ...instance, reentry_count: 2 },
      attempt,
      stages: stages.map((stage) => ({ ...stage, reentry_count: stage.stage_id === "implementation" ? 2 : stage.reentry_count })),
      event: repair,
    });
    expect(allowed.nextStageId).toBe("implementation");
    expect(allowed.nextAttempt?.reentryOrdinal).toBe(3);

    const exhausted = reducePipelineEvent({
      manifest,
      instance: { ...instance, reentry_count: 8 },
      attempt,
      stages: stages.map((stage) => ({ ...stage, reentry_count: stage.stage_id === "implementation" ? 8 : stage.reentry_count })),
      event: repair,
    });
    expect(exhausted.nextStatus).toBe("completion_pending_publication");
    expect(exhausted.terminalOutcome).toBe("failed");
    expect(exhausted.nextAttempt).toBeUndefined();
    expect(exhausted.effects.map((effect) => effect.kind)).toEqual(["publish_linear", "stop", "cleanup"]);
    expect(exhausted.effects[2]).toMatchObject({
      idempotencyKey: `cleanup:${instance.id}:failed`,
    });
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

  it("fences no_change terminals produced by re-entry exhaustion", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const noChangeExhaustionManifest: PipelineManifest = {
      ...manifest,
      stages: manifest.stages.map((stage) => stage.id === "implementation"
        ? {
            ...stage,
            transitions: {
              ...stage.transitions,
              semantic_repair_required: { to: "implementation", max_reentries: 1, on_exhausted: "no_change" },
            },
          }
        : stage),
    };
    const normalizedManifest = canonicalJson(noChangeExhaustionManifest);
    const publishedSubject = "b".repeat(40);
    const unpublishedSubject = "e".repeat(40);
    const publishedCommit = "d".repeat(40);
    const exhaustedStages = stages.map((stage) => stage.stage_id === "implementation"
      ? { ...stage, reentry_count: 1 }
      : stage);
    const exhaustedInstance = {
      ...instance,
      manifest_digest: digestNormalized(normalizedManifest),
      normalized_manifest: normalizedManifest,
      immutable_subject: publishedSubject,
      published_commit: publishedCommit,
      published_subject: publishedSubject,
    };
    const repair = event(exhaustedInstance, attempt, "semantic_repair_required", "repair-exhausted-no-change");
    const subjectAdvance = {
      ...repair,
      subject: unpublishedSubject,
      artifacts: repair.artifacts?.map((artifact) => ({ ...artifact, subject: unpublishedSubject })),
    };

    expect(reducePipelineEvent({
      manifest: noChangeExhaustionManifest,
      instance: exhaustedInstance,
      attempt,
      stages: exhaustedStages,
      event: subjectAdvance,
    })).toMatchObject({
      terminalOutcome: "no_change",
      clearPublishedCommit: true,
      immutableSubject: unpublishedSubject,
    });

    const sameSubject = {
      ...repair,
      id: "repair-exhausted-no-change-unbound",
      subject: publishedSubject,
      artifacts: repair.artifacts?.map((artifact) => ({ ...artifact, subject: publishedSubject })),
    };
    expect(() => reducePipelineEvent({
      manifest: noChangeExhaustionManifest,
      instance: { ...exhaustedInstance, published_subject: null },
      attempt,
      stages: exhaustedStages,
      event: sameSubject,
    })).toThrow(/cannot settle terminal without exact published provider evidence/);
  });

  it("does not exhaust the raw attempt budget in the middle of a forward repair round", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
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
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
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
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
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

    expect(repair.nextStageId).toBe("repair_implementation");
    expect(repair.reentryIncrement).toBe(1);
    expect(repair.nextAttempt).toMatchObject({
      stageId: "repair_implementation",
      reentryOrdinal: 1,
    });
  });

  it("routes core/implement@4 repair re-entry around simplification and back through command gates", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const providerAttempt = activeAgentAttempt(attempt, "provider");
    const providerInstance = {
      ...instance,
      status: "waiting_provider" as const,
      active_stage_id: "provider",
      reentry_count: 3,
      immutable_subject: "f".repeat(40),
    };
    const providerRepair = reducePipelineEvent({
      manifest,
      instance: providerInstance,
      attempt: providerAttempt,
      stages: providerWaitStages(stages, 3),
      event: providerFeedbackEvent(providerInstance, providerAttempt, "semantic_repair_required", "provider-repair"),
    });

    expect(providerRepair.nextStageId).toBe("repair_implementation");
    expect(providerRepair.nextAttempt).toMatchObject({
      stageId: "repair_implementation",
      reentryOrdinal: 4,
      contextPolicy: "resume_required",
    });

    const implementedRepair = reduceActiveAgentStage({
      manifest,
      instance,
      attempt,
      stages,
      stageId: "repair_implementation",
      outcome: "success",
      id: "repair-implemented",
    });
    expect(implementedRepair.nextStageId).toBe("repair_semantic_review");

    const reviewedRepair = reduceActiveAgentStage({
      manifest,
      instance,
      attempt,
      stages,
      stageId: "repair_semantic_review",
      outcome: "success",
      id: "repair-reviewed",
      artifacts: ["stage_result", "review"],
    });
    expect(reviewedRepair.nextStageId).toBe("test");
    expect(reviewedRepair.nextAttempt).toMatchObject({
      stageId: "test",
      reentryOrdinal: 0,
    });
  });

  it("exhausts core/implement@4 on repair rounds before the raw attempt safety net", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const providerAttempt = activeAgentAttempt(attempt, "provider");
    const providerInstance = {
      ...instance,
      status: "waiting_provider" as const,
      active_stage_id: "provider",
      reentry_count: manifest.max_repair_rounds!,
      attempt_count: 25,
      immutable_subject: "f".repeat(40),
    };

    const exhausted = reducePipelineEvent({
      manifest,
      instance: providerInstance,
      attempt: providerAttempt,
      stages: providerWaitStages(stages, manifest.max_repair_rounds!),
      event: providerFeedbackEvent(providerInstance, providerAttempt, "semantic_repair_required", "round-limit"),
    });

    expect(exhausted.nextStatus).toBe("completion_pending_publication");
    expect(exhausted.terminalOutcome).toBe("failed");
    expect(exhausted.waitReason).toBe("pipeline repair round limit 5 exhausted");
    expect(exhausted.nextAttempt).toBeUndefined();
    expect(exhausted.effects.map((effect) => effect.kind)).toEqual(["publish_linear", "stop", "cleanup"]);
  });

  it("persists a complete immutable request for a repair attempt", () => {
    const { pipelines, instance, attempt } = setup("core/implement@4");
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
      stageId: "implementation",
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
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
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

  it("idles the sandbox when a publish transition enters provider wait", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const nativeSessionId = "native-session-before-provider-wait";
    const publishAttempt = {
      ...attempt,
      id: "publish-attempt",
      stage_id: "publish",
      request_hash: "f".repeat(64),
      native_context_policy: "resume_required",
      native_session_id: nativeSessionId,
    };
    const subject = "c".repeat(40);
    const payload = JSON.stringify({ outcome: "success" });
    const publishPayload = JSON.stringify({
      details: { published_commit: subject },
    });
    const write = reducePipelineEvent({
      manifest,
      instance: { ...instance, active_stage_id: "publish", status: "running" },
      attempt: publishAttempt,
      stages: stages.map((stage) => stage.stage_id === "publish" ? { ...stage, status: "running" } : stage),
      event: {
        id: "publish-with-subject",
        kind: "stage_result",
        instanceId: instance.id,
        generation: instance.generation,
        attemptId: publishAttempt.id,
        requestHash: publishAttempt.request_hash,
        outcome: "success",
        resultHash: digestNormalized(payload),
        subject,
        providerRevision: subject,
        nativeSessionId,
        artifacts: [
          {
            kind: "stage_result",
            schemaVersion: 1,
            assurance: "semantic_attested",
            payload,
            hash: digestNormalized(payload),
            subject,
          },
          {
            kind: "publish_subject",
            schemaVersion: 1,
            assurance: "semantic_attested",
            payload: publishPayload,
            hash: digestNormalized(publishPayload),
            subject,
          },
        ],
      },
    });

    expect(write.nextStatus).toBe("waiting_provider");
    expect(write.nextStageId).toBe("provider");
    expect(write.nextAttempt).toMatchObject({
      nativeSessionId,
    });
    expect(JSON.parse(write.nextAttempt!.requestPayload)).toMatchObject({
      contextPolicy: "none",
      nativeSessionId: null,
    });
    expect(write.effects.map((effect) => effect.kind)).toEqual(["publish_linear", "idle"]);
    expect(write.effects.find((effect) => effect.kind === "idle")).toMatchObject({
      idempotencyKey: `idle:${instance.id}:provider:${write.nextAttempt!.id}`,
    });
  });

  it("turns a current-head provider snapshot into a bounded typed repair re-entry", () => {
    const { manifest, instance, attempt, stages } = setup("core/implement@4");
    const nativeSessionId = "native-session-before-provider-repair";
    const providerAttempt = {
      ...attempt,
      id: "provider-attempt",
      stage_id: "provider",
      request_hash: "e".repeat(64),
      native_context_policy: "none",
      native_session_id: nativeSessionId,
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
        nativeSessionId: null,
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
    expect(write.nextStageId).toBe("repair_implementation");
    expect(write.nextStatus).toBe("dispatchable");
    expect(write.reentryIncrement).toBe(1);
    expect(write.nextAttempt).toMatchObject({
      contextPolicy: "resume_required",
      nativeSessionId,
    });
    expect(JSON.parse(write.nextAttempt!.requestPayload)).toMatchObject({
      contextPolicy: "resume_required",
      nativeSessionId,
    });
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
      const idlePayload = JSON.stringify({
        pipelineInstanceId: instance.id,
        stageId: attempt.stage_id,
        attemptId: attempt.id,
        reason: "provider wait",
      });
      db!.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at
        ) VALUES (?, ?, ?, 'idle', ?, ?, ?, 'pending', ?, ?)
      `).run(
        `idle-before-${kind}`,
        instance.id,
        1,
        `idle-before-${kind}`,
        idlePayload,
        digestNormalized(idlePayload),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
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
      expect(effects.find((effect) => effect.id === `idle-before-${kind}`)).toMatchObject({
        status: "dead",
        last_error: "canceled by a terminal pipeline control event",
      });
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

  describe("structured execution ledger convergence", () => {
    const temporaryDirectories: string[] = [];
    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function gateDecision(overrides: {
      gateKind: ExecutionGateDecision["gateKind"];
      outcome?: PipelineCoordinatorEvent["outcome"];
      result?: ExecutionGateDecision["result"];
      reason?: GateReceiptReason;
      subject: string;
    }): ExecutionGateDecision {
      const base = {
        gateKind: overrides.gateKind,
        outcome: overrides.outcome ?? "success",
        result: overrides.result ?? "passed",
        reason: overrides.reason ?? "typed_semantic_result",
        subject: overrides.subject,
        artifactHashes: ["a".repeat(64)],
      };
      const payload = canonicalJson({ schema: "test.gate-decision/v1", ...base });
      return { ...base, payload, hash: digestNormalized(payload) };
    }

    // Drives one unit through implement/candidate/lead/integrate plus the
    // whole-change final review and emits the aggregate, all attached to the
    // given parent attempt -- mirroring what structured-child-runtime.ts does
    // to the real "implementation" stage attempt in production.
    function driveSingleUnitToAggregate(input: {
      unitStore: ExecutionUnitStore;
      instanceId: string;
      parentAttemptId: string;
      plannedRunId: string;
      subject: string;
    }): void {
      const { unitStore, instanceId, parentAttemptId, plannedRunId, subject } = input;
      unitStore.createGraph({
        pipelineInstanceId: instanceId,
        parentAttemptId,
        parentStageId: "implementation",
        parentRunId: plannedRunId,
        graphDigest: "graph-digest",
        planDigest: "plan-digest",
        units: [{ id: "U1" }],
        unitPhaseBindings: unitPhaseBindings(),
      });
      const lease = () => unitStore.leaseNextUnitAction({
        parentAttemptId,
        leaseOwner: "worker-1",
        nowIso: "2026-07-29T00:00:00.000Z",
        leaseUntilIso: "2026-07-29T00:01:00.000Z",
      })!;
      const implement = lease();
      unitStore.completeUnitAction({
        actionId: implement.id, resultHash: "r-implement", outputSubject: subject,
        receipt: JSON.stringify({ type: "unit_completion", payload: {} }),
      });
      const candidate = lease();
      unitStore.completeUnitAction({
        actionId: candidate.id, resultHash: "r-candidate", outputSubject: subject,
        receipt: JSON.stringify({ type: "candidate_evidence", payload: {} }),
      });
      const lead = lease();
      unitStore.completeGatedAction({
        actionId: lead.id, resultHash: "r-lead", outputSubject: subject,
        receipt: JSON.stringify({ type: "unit_decision", payload: {} }),
        decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
      });
      const integrate = lease();
      unitStore.completeGatedAction({
        actionId: integrate.id, resultHash: "r-integrate", outputSubject: subject,
        decision: gateDecision({ gateKind: "integration", outcome: "success", subject }),
      });
      const finalReview = lease();
      unitStore.completeGatedAction({
        actionId: finalReview.id, resultHash: "r-final-review", outputSubject: subject,
        decision: gateDecision({ gateKind: "final_review", outcome: "success", subject }),
      });
      expect(unitStore.emitAggregateOnce({
        parentAttemptId,
        artifactHash: "aggregate-hash",
        integrationSubject: subject,
      })).toBe("emitted");
    }

    function githubSummaryEnvelope(database: Database.Database, instanceId: string): {
      attempt_id: string | null;
      payload: string;
    } {
      return database.prepare(`
        SELECT attempt_id, payload FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ? AND kind = 'github_summary'
      `).get(instanceId) as { attempt_id: string | null; payload: string };
    }

    function activityLogKinds(payload: string): string[] {
      const envelope = JSON.parse(payload) as {
        structured_execution?: { activity_log?: Array<{ kind: string }> };
      };
      return (envelope.structured_execution?.activity_log ?? []).map((entry) => entry.kind);
    }

    it("renders the structured ledger on a later attempt that does not own the execution graph", () => {
      const { pipelines, instance, attempt } = setup("core/implement@4");
      if (!attempt.planned_run_id) {
        throw new Error("expected active attempt to have a planned run id");
      }
      const unitStore = pipelines as typeof pipelines & ExecutionUnitStore;
      const subject = "1".repeat(40);

      driveSingleUnitToAggregate({
        unitStore,
        instanceId: instance.id,
        parentAttemptId: attempt.id,
        plannedRunId: attempt.planned_run_id,
        subject,
      });

      // The composite attempt's own transition -- structuredExecution is
      // available here because attempt.id equals the graph's owning attempt.
      coordinatePipelineEvent(pipelines, stageResultEvent({
        instance,
        attempt,
        id: "implementation-success",
        summary: "Implemented and integrated unit U1.",
      }));
      expect(activityLogKinds(githubSummaryEnvelope(db!, instance.id).payload))
        .toEqual(["unit_settled", "final_review", "aggregate"]);

      const afterImplementation = pipelines.getInstance(instance.id)!;
      expect(afterImplementation.active_stage_id).toBe("semantic_review");
      const reviewAttempt = pipelines.getActiveAttempt(instance.id)!;
      expect(reviewAttempt.id).not.toBe(attempt.id);

      // A later stage's attempt does not own the execution graph at all, yet
      // its own publication must still carry the same converged ledger.
      coordinatePipelineEvent(pipelines, event(
        afterImplementation,
        reviewAttempt,
        "no_change",
        "semantic-review-no-change",
        ["stage_result", "review"]
      ));

      const latest = githubSummaryEnvelope(db!, instance.id);
      expect(latest.attempt_id).toBe(reviewAttempt.id);
      expect(latest.attempt_id).not.toBe(attempt.id);
      expect(activityLogKinds(latest.payload)).toEqual(["unit_settled", "final_review", "aggregate"]);
    });

    it("renders the aggregate in the terminal receipt on the same pass and survives real Linear delivery plus a crash-and-restart replay", async () => {
      const directory = mkdtempSync(join(tmpdir(), "openthrottle-coordinator-structured-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "supervisor.db");
      db = openDb(path);
      let pipelines = createPipelineStore(db);
      const tickets = createSupervisorStore(db, pipelines);
      const catalog = loadPipelineCatalog(shippedCatalogPath, runtime.descriptor);
      pipelines.acceptRuntimeDescriptor(runtime);
      pipelines.acceptCatalog(catalog);
      const config = parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n");
      const snapshot = pipelines.saveRepositoryConfigSnapshot({
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        blobSha: "b".repeat(40),
        config,
      });
      const manifest = catalog.manifests.get("core/implement@4")!;
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
        },
      });
      const instance = pipelines.getInstanceForSession("session-1")!;
      const attempt = pipelines.getActiveAttempt(instance.id)!;
      if (!attempt.planned_run_id) {
        throw new Error("expected active attempt to have a planned run id");
      }
      const unitStore = pipelines as typeof pipelines & ExecutionUnitStore;
      const subject = "1".repeat(40);

      driveSingleUnitToAggregate({
        unitStore,
        instanceId: instance.id,
        parentAttemptId: attempt.id,
        plannedRunId: attempt.planned_run_id,
        subject,
      });

      // "implementation" no_change goes straight to terminal in the SAME
      // coordinatePipelineEvent call that just emitted the aggregate --
      // exactly the same-pass path structured-child-runtime.ts drives.
      coordinatePipelineEvent(pipelines, stageResultEvent({
        instance,
        attempt,
        id: "implementation-no-change",
        outcome: "no_change",
        summary: "Integrated the only unit; no further change needed.",
      }));

      // Before any outbox delivery at all, the persisted terminal receipts
      // already carry the full activity log.
      const expectedKinds = ["unit_settled", "final_review", "aggregate"];
      expect(activityLogKinds(githubSummaryEnvelope(db, instance.id).payload)).toEqual(expectedKinds);
      const terminalLedgerId = db.prepare(`
        SELECT id FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ? AND kind = 'linear_ledger'
          AND idempotency_key = ?
      `).get(instance.id, `linear-terminal:${instance.id}:no_change`) as { id: string } | undefined;
      expect(terminalLedgerId).toBeDefined();
      const terminalLedgerPayload = (db.prepare(
        "SELECT payload FROM pipeline_publication_receipts WHERE id = ?"
      ).get(terminalLedgerId!.id) as { payload: string }).payload;
      expect(activityLogKinds(terminalLedgerPayload)).toEqual(expectedKinds);

      const pendingBeforeDelivery = db.prepare(
        "SELECT COUNT(*) AS count FROM linear_outbox WHERE status = 'processed'"
      ).get() as { count: number };
      expect(pendingBeforeDelivery.count).toBe(0);

      const deliveredActivityBodies: string[] = [];
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          query?: string;
          variables?: { id?: string; input?: { content?: { body?: string } } };
        };
        if (request.query?.includes("query Comment")) {
          return Response.json({ data: { comment: null } });
        }
        if (request.query?.includes("IssueComments")) {
          return Response.json({ data: { issue: { comments: { nodes: [] } } } });
        }
        if (request.query?.includes("IssueWorkflowState")) {
          return Response.json({
            data: { issue: { id: "issue-1", state: { id: "backlog", name: "Backlog", type: "backlog" }, team: { id: "team-1" } } },
          });
        }
        if (request.query?.includes("TeamWorkflowStates")) {
          return Response.json({
            data: { team: { states: { nodes: [
              { id: "backlog", name: "Backlog", type: "backlog" },
              { id: "progress", name: "In Progress", type: "started" },
              { id: "done", name: "Done", type: "completed" },
            ] } } },
          });
        }
        if (request.query?.includes("IssueStateUpdate")) {
          return Response.json({
            data: { issueUpdate: { success: true, issue: { id: "issue-1", state: { id: "progress", name: "In Progress" } } } },
          });
        }
        if (request.query?.includes("CommentCreate")) {
          return Response.json({
            data: { commentCreate: {
              success: true,
              comment: { id: "status-comment", url: "https://linear.test/comment/status" },
            } },
          });
        }
        if (request.query?.includes("AgentActivityCreate")) {
          const body = request.variables?.input?.content?.body ?? "";
          deliveredActivityBodies.push(body);
          return Response.json({
            data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } },
          });
        }
        throw new Error(`unexpected Linear request: ${request.query}`);
      }) as unknown as typeof fetch;

      const processor = createLinearOutboxProcessor({
        store: tickets,
        getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
      });
      // Same-session rows deliver strictly in sequence (head-of-line), so
      // draining the whole queue takes one pass per row -- exactly the real
      // background sweep loop's behavior, not a single drain() call.
      for (let pass = 0; pass < 10; pass += 1) {
        await processor.drain(50);
      }

      const stillPending = db.prepare(
        "SELECT COUNT(*) AS count FROM linear_outbox WHERE status != 'processed'"
      ).get() as { count: number };
      expect(stillPending.count).toBe(0);
      const deliveredTerminalReceipt = deliveredActivityBodies.find((body) =>
        body.includes("Structured Activity Log"));
      expect(deliveredTerminalReceipt).toBeDefined();
      expect(deliveredTerminalReceipt).toContain("unit_settled: Unit U1");
      expect(deliveredTerminalReceipt).toContain("final_review: Whole-change final review passed");
      expect(deliveredTerminalReceipt).toContain("aggregate: Structured execution complete");

      // Crash and restart: reopen a fresh handle and store from the same
      // file, and confirm the already-persisted receipts still converge --
      // nothing here depends on in-memory processor or delivery state.
      db.close();
      db = openDb(path);
      pipelines = createPipelineStore(db);
      const recoveredPayload = (db.prepare(
        "SELECT payload FROM pipeline_publication_receipts WHERE id = ?"
      ).get(terminalLedgerId!.id) as { payload: string }).payload;
      expect(activityLogKinds(recoveredPayload)).toEqual(expectedKinds);

      // Replaying the same terminal event post-restart is a pure no-op.
      const receiptCountBefore = (db.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_publication_receipts WHERE pipeline_instance_id = ?"
      ).get(instance.id) as { count: number }).count;
      coordinatePipelineEvent(pipelines, stageResultEvent({
        instance,
        attempt,
        id: "implementation-no-change",
        outcome: "no_change",
        summary: "Integrated the only unit; no further change needed.",
      }));
      const receiptCountAfter = (db.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_publication_receipts WHERE pipeline_instance_id = ?"
      ).get(instance.id) as { count: number }).count;
      expect(receiptCountAfter).toBe(receiptCountBefore);
    });
  });
});
