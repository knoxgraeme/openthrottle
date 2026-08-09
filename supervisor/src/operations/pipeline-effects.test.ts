import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
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
import { parseAndCompileExecutionGraph } from "../pipeline/execution-graph.js";
import { buildAggregateStageEvent } from "../pipeline/unit-coordinator.js";
import { executionLedgerLines } from "../pipeline/execution-publication.js";
import { createStageRequestHash, type StageRequestEnvelope } from "../pipeline/stage-request.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor, type SandboxAutostopRuntime, type SandboxRuntime } from "../__fixtures__/runtime.js";
import type { ExecutionGateDecision } from "../pipeline/execution-gates.js";
import type { GateReceiptReason } from "../pipeline/gates.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { PipelineInstance, PipelineStageAttempt } from "../pipeline/store.js";
import type { LinearOutboxRecord } from "../persistence/delivery-store.js";
import type { RuntimeResourceReconciler } from "./runtime-resource-reclaim.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const structuredGraphPath = fileURLToPath(new URL("../../graphs/structured-v2.json", import.meta.url));

describe("pipeline effect processor", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  const listLinearOutbox = (): LinearOutboxRecord[] =>
    db!.prepare("SELECT * FROM linear_outbox ORDER BY created_at, sequence").all() as LinearOutboxRecord[];

  function repositoryStructuredGraphWithPublishStage(
    publishStageId: string,
    intermediateStageId?: string
  ): string {
    const graph = JSON.parse(readFileSync(structuredGraphPath, "utf8")) as {
      id: string;
      nodes: Array<{
        id: string;
        kind?: string;
        command?: string;
        depends_on?: string[];
        transitions: Record<string, { to?: string; terminal?: string }>;
      }>;
    };
    graph.id = `repository/structured-${publishStageId}`;
    for (const node of graph.nodes) {
      if (node.id === "units") node.transitions.success = { to: intermediateStageId ?? publishStageId };
      if (node.id === "publish") {
        node.id = publishStageId;
        node.transitions.retryable_failure = { ...node.transitions.retryable_failure, to: publishStageId };
      }
    }
    if (intermediateStageId) {
      graph.nodes.splice(1, 0, {
        id: intermediateStageId,
        kind: "command",
        command: "test",
        depends_on: [],
        transitions: {
          success: { to: publishStageId },
          repair_required: { to: publishStageId },
          retryable_failure: { terminal: "failed" },
          failure: { to: publishStageId },
        },
      });
    }
    return JSON.stringify(graph);
  }

  function sandboxRuntimeMock(ids: { issueId?: string; providerDispatchId?: string } = {}) {
    const issueId = ids.issueId ?? "1";
    return {
      provision: vi.fn(async () => ({ providerResourceId: `sandbox-${issueId}` })),
      bootstrap: vi.fn(async () => undefined),
      prepareCompositeWorkspace: vi.fn(async () => undefined),
      materializeCredentials: vi.fn(async () => undefined),
      dispatchStage: vi.fn(async () => ({ providerDispatchId: ids.providerDispatchId ?? `dispatch-${issueId}` })),
      collectStageResult: vi.fn(async () => null),
      createWorktree: vi.fn(async () => ({ id: `worktree-${issueId}` })),
      dispatchLoopAction: vi.fn(async () => ({ providerDispatchId: `loop-${issueId}` })),
      collectLoopActionResult: vi.fn<SandboxRuntime["collectLoopActionResult"]>(async () => null),
      dispatchChildExecutorAction: vi.fn(async () => ({ providerDispatchId: `child-executor-${issueId}` })),
      collectChildExecutorActionResult: vi.fn<SandboxRuntime["collectChildExecutorActionResult"]>(async () => null),
      cleanupWorktree: vi.fn(async () => undefined),
      renewLiveness: vi.fn(async () => ({ observedAt: new Date().toISOString() })),
      stop: vi.fn(async () => ({ confirmed: true })),
      quarantine: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      setActive: vi.fn(async () => undefined),
      setIdle: vi.fn(async () => undefined),
    } satisfies SandboxRuntime & SandboxAutostopRuntime;
  }

  function harness(
    issueId: string,
    sessionId: string,
    options: { reconcileRuntimeResources?: RuntimeResourceReconciler } = {}
  ) {
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
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\ntest: npm test\n"),
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
    const runtime = sandboxRuntimeMock({ issueId });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      ...(options.reconcileRuntimeResources
        ? { reconcileRuntimeResources: options.reconcileRuntimeResources }
        : {}),
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });
    const instance = pipelines.getInstanceForSession(sessionId)!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    return { tickets, pipelines, runtime, processor, instance, attempt, catalog, config, runtimeDescriptor };
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

  function enqueueIdleEffect(input: {
    id: string;
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
    reason?: "provider wait" | "human wait";
    transitionVersion?: number;
  }): void {
    const reason = input.reason ?? "provider wait";
    const timestamp = "2099-07-22T12:00:00.000Z";
    const payload = canonicalJson({
      pipelineInstanceId: input.instance.id,
      stageId: input.attempt.stage_id,
      attemptId: input.attempt.id,
      reason,
    });
    db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, ?, 'idle', ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.id,
      input.instance.id,
      input.transitionVersion ?? 2,
      `idle:${input.instance.id}:${input.attempt.stage_id}:${input.attempt.id}`,
      payload,
      digestNormalized(payload),
      timestamp,
      timestamp
    );
  }

  function gateDecision(input: {
    gateKind: ExecutionGateDecision["gateKind"];
    subject: string;
    outcome?: ExecutionGateDecision["outcome"];
    result?: ExecutionGateDecision["result"];
    reason?: GateReceiptReason;
    artifactHashes?: string[];
  }): ExecutionGateDecision {
    const base = {
      gateKind: input.gateKind,
      outcome: input.outcome ?? "success",
      result: input.result ?? "passed",
      reason: input.reason ?? "typed_semantic_result",
      subject: input.subject,
      artifactHashes: input.artifactHashes ?? ["a".repeat(64)],
    };
    const payload = canonicalJson({ schema: "test.gate-decision/v1", ...base });
    return { ...base, payload, hash: digestNormalized(payload) };
  }

  function receiptJson(input: {
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    type: "unit_completion" | "command_result" | "candidate_evidence" | "unit_decision" | "integration_evidence" | "semantic_review";
    subject: string;
    baseSubject?: string;
    preSubject?: string;
    result?: string;
    commandName?: string | null;
    nativeSessionId?: string | null;
    evidence?: string[];
    treeSubject?: string;
    clean?: boolean;
  }): string {
    const executorVerified = input.type === "command_result" || input.type.endsWith("_evidence");
    const producer = (() => {
      if (executorVerified) {
        return {
          worker_id: "executor",
          skill: `builtin://${input.type}@1`,
          capability_digest: input.instance.capability_digest,
          skill_package_digest: null,
        };
      }
      if (input.action.action_kind === "implement" || input.action.action_kind === "repair") {
        return {
          worker_id: "unit-worker",
          skill: "builtin://ce/implement@1",
          capability_digest: input.instance.capability_digest,
          skill_package_digest: null,
        };
      }
      if (input.action.action_kind === "simplify") {
        return {
          worker_id: "simplify-worker",
          skill: "builtin://ce/simplify@1",
          capability_digest: input.instance.capability_digest,
          skill_package_digest: null,
        };
      }
      if (input.action.action_kind === "lead") {
        return {
          worker_id: "lead-worker",
          skill: "builtin://accept-unit@1",
          capability_digest: input.instance.capability_digest,
          skill_package_digest: null,
        };
      }
      if (input.action.action_kind === "final_review") {
        return {
          worker_id: "reviewer",
          skill: "builtin://final-review@1",
          capability_digest: input.instance.capability_digest,
          skill_package_digest: null,
        };
      }
      return {
        worker_id: "worker",
        skill: `builtin://${input.type}@1`,
        capability_digest: input.instance.capability_digest,
        skill_package_digest: null,
      };
    })();
    const payload = input.type === "unit_completion"
      ? {
          summary: "done",
          assumptions: [],
          decisions: [],
          issues: [],
          verification: [],
          downstream_context: [],
          requested_human_input: [],
        }
      : input.type === "command_result"
        ? { command: input.commandName ?? "test", exit_code: 0, summary: "command passed" }
        : input.type === "semantic_review"
          ? { summary: "no findings", findings: [] }
        : input.type === "unit_decision"
          ? { rationale: "candidate matches the unit scope", context_updates: [], accepted_subject: input.subject }
        : {
            tree: input.treeSubject ?? input.subject,
            diff_digest: "d".repeat(64),
            changed_paths: [],
            clean: input.clean ?? true,
          };
    return canonicalJson({
      schema: "openthrottle.receipt/v1",
      type: input.type,
      assurance: executorVerified ? "executor_verified" : "semantic_attested",
      result: input.result ?? (input.type === "unit_decision" ? "accept" : "success"),
      producer,
      subject: {
        base: input.baseSubject ?? input.instance.base_commit,
        pre: input.preSubject ?? input.instance.base_commit,
        post: input.subject,
      },
      fence: {
        pipeline_instance_id: input.instance.id,
        graph_digest: input.instance.manifest_digest,
        unit_id: input.action.unit_id ?? "__final__",
        attempt_id: input.action.parent_attempt_id,
        parent_run_id: input.action.parent_run_id,
        action_attempt_id: input.action.id,
        generation: input.instance.generation,
        native_session_id: input.nativeSessionId ?? input.action.native_session_id,
        request_hash: input.action.request_hash ?? "b".repeat(64),
      },
      evidence: input.evidence ?? ["e".repeat(64)],
      payload,
      issued_at: "2099-07-22T12:00:00.000Z",
    });
  }

  function repositorySkillPackage() {
    return {
      schema: "openthrottle.repository-skill-package/v1" as const,
      reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
      invocation: "implement_unit",
      directory: ".agents/skills/implement-unit",
      commit: "a".repeat(40),
      packageDigest: "d".repeat(64),
      files: [{
        path: ".agents/skills/implement-unit/SKILL.md",
        blobSha: "b".repeat(40),
        digest: "c".repeat(64),
      }],
    };
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
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\ntest: npm test\n"),
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
    const runtime = sandboxRuntimeMock({ providerDispatchId: "command-1" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
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
    expect(db.prepare(`
      SELECT COUNT(*) FROM pipeline_instances
      WHERE terminal_outcome IS NOT NULL
        AND runtime_resource_status IN ('active', 'quarantined')
    `).pluck().get()).toBe(0);
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

  it("seeds and drains a structured composite host without dispatching a sandbox stage", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-effect-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const publishStageId = "release";
    const manifest = parseAndCompileExecutionGraph(repositoryStructuredGraphWithPublishStage(publishStageId), {
      id: `repository/structured-${publishStageId}`,
      runtime: runtimeDescriptor.descriptor,
      config: repositoryConfig.config,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-effect",
      instructions: { implement_a: "Implement unit A." },
      acceptance: { unit_a_done: "Unit A is complete." },
      units: [{
        id: "unit_a",
        title: "Unit A",
        depends_on: [],
        instructions: ["implement_a"],
        acceptance: ["unit_a_done"],
      }],
      commands: [],
    };
    const taskContext = [
      "Approved structured plan.",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
    ].join("\n");
    tickets.upsert({
      linear_issue_id: "issue-structured",
      linear_issue_identifier: "OT-STRUCTURED",
      linear_session_id: "session-structured",
      sandbox_id: null,
      branch: "ot/structured",
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
        taskContext,
      },
    });
    const instance = pipelines.getInstanceForSession("session-structured")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "structured" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    await processor.drain();

    expect(runtime.dispatchStage).not.toHaveBeenCalled();
    expect(runtime.prepareCompositeWorkspace).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-structured" },
      expect.objectContaining({
        attemptId: attempt.id,
        capability: "graph/for-each-unit@1",
      })
    );
    expect(runtime.prepareCompositeWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.createWorktree.mock.invocationCallOrder[0]);
    expect(runtime.createWorktree).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-structured" },
      expect.objectContaining({
        attemptId: attempt.id,
        baseCommit: "a".repeat(40),
      })
    );
    expect(runtime.dispatchLoopAction).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-structured" },
      expect.objectContaining({
        protocol: "loop-action@2",
        attemptId: attempt.id,
        unitId: "unit_a",
        role: "worker",
        loop: "implement",
        skill: "implement-unit",
        expectedProducerSkill: "builtin://ce/implement@1",
      })
    );
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      parent_attempt_id: attempt.id,
      parent_run_id: attempt.planned_run_id,
    });
    expect(pipelines.listUnits(attempt.id)).toEqual([
      expect.objectContaining({ unitId: "unit_a", status: "running" }),
    ]);

    const dispatchedAction = pipelines.listWorkAttempts(attempt.id)[0]!;
    db!.prepare(`
      UPDATE execution_work_attempts
      SET request_hash = NULL, native_session_id = NULL
      WHERE id = ?
    `).run(dispatchedAction.id);
    runtime.createWorktree.mockClear();
    runtime.dispatchLoopAction.mockClear();

    await processor.drain();

    expect(runtime.createWorktree).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-structured" },
      expect.objectContaining({
        attemptId: attempt.id,
        baseCommit: "a".repeat(40),
      })
    );
    expect(runtime.dispatchLoopAction).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-structured" },
      expect.objectContaining({
        actionId: dispatchedAction.id,
        worktree: { id: expect.any(String) },
      })
    );
  });

  it("dispatches repository-skill unit phases with the pinned invocation name", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const baseRuntimeDescriptor = buildInstalledRuntimeDescriptor("structured-repo-skill-base/v1");
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-repo-skill-test/v1", {
      capabilities: [
        ...baseRuntimeDescriptor.descriptor.capabilities,
        "agent/repository-skill@1",
      ],
    });
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const repoSkill = repositorySkillPackage();
    const graph = {
      schema: "openthrottle.graph/v1",
      id: "fixture/repo-skill-units",
      version: 1,
      entry_node: "units",
      workers: [{
        id: "repo-worker",
        engine: "agent",
        skills: ["repo://implement_unit"],
        allowed_mcp_servers: [],
        session_scope: "fresh",
        credentials: ["model.invoke", "provider.read", "repo.read"],
      }, {
        id: "lead-worker",
        engine: "agent",
        skills: ["builtin://accept-unit@1"],
        allowed_mcp_servers: [],
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read"],
      }],
      loops: [{
        id: "repo-loop",
        worker: "repo-worker",
        skill: "repo://implement_unit",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      }, {
        id: "lead-loop",
        worker: "lead-worker",
        skill: "builtin://accept-unit@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "units",
        kind: "for_each_unit",
        phases: [
          { id: "implement", kind: "agent", loop: "repo-loop" },
          { id: "candidate", kind: "evidence" },
          { id: "lead", kind: "gate", loop: "lead-loop" },
          { id: "integrate", kind: "integrate" },
        ],
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          repair_required: { terminal: "needs_human" },
          retryable_failure: { terminal: "failed" },
          failure: { terminal: "failed" },
        },
      }],
    };
    const manifest = parseAndCompileExecutionGraph(JSON.stringify(graph), {
      id: "fixture/repo-skill-units",
      runtime: runtimeDescriptor.descriptor,
      repositorySkills: new Map([["implement_unit", repoSkill]]),
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-repo-skill",
      instructions: { implement_a: "Implement unit A." },
      acceptance: { unit_a_done: "Unit A is complete." },
      units: [{
        id: "unit_a",
        title: "Unit A",
        depends_on: [],
        instructions: ["implement_a"],
        acceptance: ["unit_a_done"],
      }],
      commands: [],
    };
    tickets.upsert({
      linear_issue_id: "issue-repo-skill",
      linear_issue_identifier: "OT-REPO-SKILL",
      linear_session_id: "session-repo-skill",
      sandbox_id: null,
      branch: "ot/repo-skill",
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
        taskContext: [
          "Approved structured plan.",
          "",
          "```json openthrottle.execution-plan/v1",
          JSON.stringify(executionPlan, null, 2),
          "```",
        ].join("\n"),
      },
    });
    const instance = pipelines.getInstanceForSession("session-repo-skill")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "repo-skill" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    await processor.drain();

    expect(runtime.dispatchLoopAction).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-repo-skill" },
      expect.objectContaining({
        protocol: "loop-action@2",
        attemptId: attempt.id,
        skill: "implement_unit",
        expectedProducerSkill: repoSkill.reference,
        repositorySkill: repoSkill,
      })
    );
  });

  it("drains graph-declared child executor actions and lead candidate receipts through the composite host", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-child-drain-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const publishStageId = "release";
    const intermediateStageId = "verify_release";
    const manifest = parseAndCompileExecutionGraph(repositoryStructuredGraphWithPublishStage(
      publishStageId,
      intermediateStageId
    ), {
      id: `repository/structured-${publishStageId}`,
      runtime: runtimeDescriptor.descriptor,
      config: repositoryConfig.config,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-child-drain",
      instructions: {
        implement_a: "Implement unit A.",
        implement_b: "Implement unit B.",
      },
      acceptance: {
        unit_a_done: "Unit A is complete.",
        unit_b_done: "Unit B is complete.",
      },
      units: [
        {
          id: "unit_a",
          title: "Unit A",
          depends_on: [],
          instructions: ["implement_a"],
          acceptance: ["unit_a_done"],
        },
        {
          id: "unit_b",
          title: "Unit B",
          depends_on: ["unit_a"],
          instructions: ["implement_b"],
          acceptance: ["unit_b_done"],
        },
      ],
      commands: [],
    };
    const taskContext = [
      "Approved structured plan.",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
    ].join("\n");
    tickets.upsert({
      linear_issue_id: "issue-child-drain",
      linear_issue_identifier: "OT-CHILD-DRAIN",
      linear_session_id: "session-child-drain",
      sandbox_id: null,
      branch: "ot/child-drain",
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
        taskContext,
      },
    });
    const instance = pipelines.getInstanceForSession("session-child-drain")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "child-drain" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });
    const completedSubject = "1".repeat(40);
    const simplifiedSubject = "7".repeat(40);
    const candidateSubject = "2".repeat(40);
    const integratedSubject = "3".repeat(40);
    const completedSubjectB = "4".repeat(40);
    const simplifiedSubjectB = "8".repeat(40);
    const candidateSubjectB = "5".repeat(40);
    const integratedSubjectB = "6".repeat(40);
    const latestAction = (kind: ExecutionWorkAttempt["action_kind"]) => {
      const action = [...pipelines.listWorkAttempts(attempt.id)].reverse()
        .find((attempt) => attempt.status !== "completed");
      expect(action).toMatchObject({ action_kind: kind });
      return action!;
    };
    const completeUnitAction = (
      kind: ExecutionWorkAttempt["action_kind"],
      subject: string,
      receiptType?: Parameters<typeof receiptJson>[0]["type"],
      receiptFence: Pick<Parameters<typeof receiptJson>[0], "baseSubject" | "preSubject" | "nativeSessionId"> = {}
    ) => {
      const action = latestAction(kind);
      pipelines.completeUnitAction({
        actionId: action.id,
        resultHash: `result-${kind}`,
        outputSubject: subject,
        ...(receiptType
          ? { receipt: receiptJson({ instance, action, type: receiptType, subject, commandName: action.command_name, ...receiptFence }) }
          : {}),
      });
      return action;
    };
    const drainCommandActions = async (actionKind: "command" | "final_command", subject: string, baseSubject = subject) => {
      for (const commandName of ["test", "lint", "build"]) {
        await processor.drain();
        expect(runtime.dispatchChildExecutorAction).toHaveBeenLastCalledWith(
          { providerResourceId: "sandbox-child-drain" },
          expect.objectContaining({
            protocol: "child-executor-action@1",
            actionKind,
            commandName,
            inputSubject: subject,
          })
        );
        completeUnitAction(actionKind, subject, "command_result", { baseSubject, preSubject: subject });
      }
    };

    const drainUnit = async (input: {
      unitId: string;
      baseSubject: string;
      completed: string;
      simplified: string;
      candidate: string;
      integrated: string;
    }) => {
      await processor.drain();
      expect(runtime.createWorktree).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({ baseCommit: input.baseSubject })
      );
      expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({
          protocol: "loop-action@2",
          contextPolicy: "prefer_resume",
          nativeSessionId: null,
          role: "worker",
          skill: "implement-unit",
          unitId: input.unitId,
        })
      );
      const implement = latestAction("implement");
      runtime.collectLoopActionResult.mockResolvedValueOnce({
        actionId: implement.id,
        attemptId: implement.parent_attempt_id,
        requestHash: implement.request_hash!,
        outcome: "success",
        nativeSessionId: `thread-${input.unitId}`,
        subject: input.completed,
        receipt: receiptJson({
          instance,
          action: implement,
          type: "unit_completion",
          subject: input.completed,
          baseSubject: input.baseSubject,
          preSubject: input.baseSubject,
          nativeSessionId: null,
        }),
        completedAt: "2099-07-22T12:00:00.000Z",
      });
      await processor.drain();
      expect(pipelines.listWorkAttempts(attempt.id).find((attempt) => attempt.id === implement.id))
        .toMatchObject({ status: "completed", native_session_id: `thread-${input.unitId}` });

      await processor.drain();
      expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({
          protocol: "loop-action@2",
          contextPolicy: "resume_required",
          nativeSessionId: `thread-${input.unitId}`,
          role: "worker",
          skill: "simplify-unit",
          unitId: input.unitId,
        })
      );
      const simplify = completeUnitAction("simplify", input.simplified, "unit_completion", {
        baseSubject: input.baseSubject,
        preSubject: input.completed,
        nativeSessionId: `thread-${input.unitId}`,
      });
      db!.prepare(`
        UPDATE execution_work_attempts
        SET created_at = CASE id
          WHEN ? THEN '2100-01-01T00:00:00.000Z'
          WHEN ? THEN '2099-01-01T00:00:00.000Z'
          ELSE created_at
        END
        WHERE id IN (?, ?)
      `).run(implement.id, simplify.id, implement.id, simplify.id);

      await drainCommandActions("command", input.simplified, input.baseSubject);

      await processor.drain();
      expect(runtime.dispatchChildExecutorAction).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({
          protocol: "child-executor-action@1",
          actionKind: "candidate",
          inputSubject: input.simplified,
          unitId: input.unitId,
        })
      );
      completeUnitAction("candidate", input.candidate, "candidate_evidence", {
        baseSubject: input.baseSubject,
        preSubject: input.simplified,
      });

      await processor.drain();
      expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({
          protocol: "loop-action@2",
          role: "lead",
          skill: "accept-unit",
          candidateSubject: input.candidate,
          unitId: input.unitId,
        })
      );
      const lead = latestAction("lead");
      const leadEvidence = pipelines.listWorkAttempts(attempt.id)
        .filter((attempt) =>
          attempt.unit_id === input.unitId &&
          attempt.cycle === lead.cycle &&
          (attempt.action_kind === "implement" || attempt.action_kind === "candidate" || attempt.action_kind === "command") &&
          attempt.receipt)
        .map((attempt) => digestNormalized(attempt.receipt!));
      runtime.collectLoopActionResult.mockResolvedValueOnce({
        actionId: lead.id,
        attemptId: lead.parent_attempt_id,
        requestHash: lead.request_hash!,
        outcome: "success",
        nativeSessionId: null,
        subject: input.candidate,
        receipt: receiptJson({
          instance,
          action: lead,
          type: "unit_decision",
          subject: input.candidate,
          baseSubject: input.baseSubject,
          preSubject: input.candidate,
          evidence: leadEvidence,
        }),
        completedAt: "2099-07-22T12:00:00.000Z",
      });
      await processor.drain();
      expect(pipelines.listWorkAttempts(attempt.id).find((attempt) => attempt.id === lead.id))
        .toMatchObject({ status: "completed", output_subject: input.candidate });

      await processor.drain();
      expect(runtime.dispatchChildExecutorAction).toHaveBeenLastCalledWith(
        { providerResourceId: "sandbox-child-drain" },
        expect.objectContaining({
          protocol: "child-executor-action@1",
          actionKind: "integrate",
          candidateSubject: input.candidate,
          inputSubject: input.baseSubject,
          unitId: input.unitId,
        })
      );
      const integrate = latestAction("integrate");
      pipelines.completeGatedAction({
        actionId: integrate.id,
        resultHash: `result-integrate-${input.unitId}`,
        outputSubject: input.integrated,
        receipt: receiptJson({ instance, action: integrate, type: "integration_evidence", subject: input.integrated }),
        decision: gateDecision({ gateKind: "integration", subject: input.integrated }),
      });
      expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({ integration_subject: input.integrated });
    };

    await drainUnit({
      unitId: "unit_a",
      baseSubject: "a".repeat(40),
      completed: completedSubject,
      simplified: simplifiedSubject,
      candidate: candidateSubject,
      integrated: integratedSubject,
    });
    await drainUnit({
      unitId: "unit_b",
      baseSubject: integratedSubject,
      completed: completedSubjectB,
      simplified: simplifiedSubjectB,
      candidate: candidateSubjectB,
      integrated: integratedSubjectB,
    });

    await drainCommandActions("final_command", integratedSubjectB);

    await processor.drain();
    expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        protocol: "loop-action@2",
        role: "reviewer",
        skill: "final-review",
        expectedProducerSkill: "builtin://final-review@1",
        baseSubject: instance.base_commit,
        inputSubject: integratedSubjectB,
        worktree: null,
      })
    );
    const review = latestAction("final_review");
    pipelines.completeGatedAction({
      actionId: review.id,
      resultHash: "result-review",
      outputSubject: integratedSubjectB,
      receipt: receiptJson({ instance, action: review, type: "semantic_review", subject: integratedSubjectB }),
      decision: gateDecision({
        gateKind: "final_review",
        subject: integratedSubjectB,
        outcome: "semantic_repair_required",
        result: "failed",
        reason: "blocking_findings",
      }),
    });

    await processor.drain();
    expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        protocol: "loop-action@2",
        role: "worker",
        skill: "final-repair",
      })
    );
    const repairedSubject = "c".repeat(40);
    const finalCandidateSubject = "d".repeat(40);
    const finalIntegratedSubject = "e".repeat(40);
    const finalIntegratedTreeSubject = "9".repeat(40);
    completeUnitAction("final_repair", repairedSubject, "unit_completion");

    await processor.drain();
    expect(runtime.dispatchChildExecutorAction).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        protocol: "child-executor-action@1",
        actionKind: "candidate",
        inputSubject: repairedSubject,
        unitId: null,
        worktree: expect.any(Object),
      })
    );
    const finalCandidate = latestAction("candidate");
    runtime.collectChildExecutorActionResult.mockResolvedValueOnce({
      actionId: finalCandidate.id,
      attemptId: finalCandidate.parent_attempt_id,
      requestHash: finalCandidate.request_hash!,
      outcome: "success",
      subject: finalCandidateSubject,
      receipt: receiptJson({
        instance,
        action: finalCandidate,
        type: "candidate_evidence",
        subject: finalCandidateSubject,
        baseSubject: integratedSubjectB,
        preSubject: repairedSubject,
      }),
      completedAt: "2099-07-22T12:00:00.000Z",
    });
    await processor.drain();

    await processor.drain();
    expect(runtime.dispatchChildExecutorAction).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        protocol: "child-executor-action@1",
        actionKind: "integrate",
        candidateSubject: finalCandidateSubject,
        inputSubject: integratedSubjectB,
        unitId: null,
      })
    );
    const finalIntegrate = latestAction("integrate");
    const finalIntegrationReceipt = receiptJson({
      instance,
      action: finalIntegrate,
      type: "integration_evidence",
      subject: finalIntegratedSubject,
      treeSubject: finalIntegratedTreeSubject,
    });
    pipelines.completeGatedAction({
      actionId: finalIntegrate.id,
      resultHash: "result-final-integrate",
      outputSubject: finalIntegratedSubject,
      receipt: finalIntegrationReceipt,
      decision: gateDecision({
        gateKind: "integration",
        subject: finalIntegratedSubject,
        artifactHashes: [digestNormalized(finalIntegrationReceipt)],
      }),
    });
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({ integration_subject: finalIntegratedSubject });

    await drainCommandActions("final_command", finalIntegratedSubject);

    await processor.drain();
    const freshReview = latestAction("final_review");
    expect(runtime.dispatchLoopAction).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        protocol: "loop-action@2",
        role: "reviewer",
        skill: "final-review",
        baseSubject: instance.base_commit,
        inputSubject: finalIntegratedSubject,
      })
    );
    pipelines.completeGatedAction({
      actionId: freshReview.id,
      resultHash: "result-review-fresh",
      outputSubject: finalIntegratedSubject,
      receipt: receiptJson({ instance, action: freshReview, type: "semantic_review", subject: finalIntegratedSubject }),
      decision: gateDecision({ gateKind: "final_review", subject: finalIntegratedSubject }),
    });

    const mismatchedReviewSubject = "f".repeat(40);
    db!.prepare(`
      UPDATE execution_work_attempts
      SET output_subject = ?, receipt = ?, updated_at = ?
      WHERE id = ?
    `).run(
      mismatchedReviewSubject,
      receiptJson({ instance, action: freshReview, type: "semantic_review", subject: mismatchedReviewSubject }),
      "2099-07-22T12:00:00.000Z",
      freshReview.id
    );
    await expect(processor.drain()).rejects.toThrow(/final review subject to match the integrated subject/);
    db!.prepare(`
      UPDATE execution_work_attempts
      SET output_subject = ?, receipt = ?, result_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      receiptJson({ instance, action: freshReview, type: "semantic_review", subject: finalIntegratedSubject }),
      "result-review-fresh-restored",
      "2099-07-22T12:00:00.000Z",
      freshReview.id
    );

    db!.prepare(`
      UPDATE execution_graphs
      SET integration_subject = NULL, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run("2099-07-22T12:00:00.000Z", attempt.id);
    await expect(processor.drain()).rejects.toThrow(/has no exact subject/);
    db!.prepare(`
      UPDATE execution_graphs
      SET integration_subject = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", attempt.id);

    const rewriteFinalIntegrationReceipt = (receipt: string) => {
      const receiptHash = digestNormalized(receipt);
      const gate = gateDecision({
        gateKind: "integration",
        subject: finalIntegratedSubject,
        artifactHashes: [receiptHash],
      });
      db!.prepare(`
        UPDATE execution_work_attempts
        SET receipt = ?, receipt_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(receipt, receiptHash, "2099-07-22T12:00:00.000Z", finalIntegrate.id);
      db!.prepare(`
        UPDATE execution_gate_receipts
        SET artifact_hashes = ?, payload = ?, receipt_hash = ?
        WHERE execution_work_attempt_id = ? AND gate_kind = 'integration'
      `).run(canonicalJson(gate.artifactHashes), gate.payload, gate.hash, finalIntegrate.id);
    };
    rewriteFinalIntegrationReceipt(receiptJson({
      instance,
      action: finalIntegrate,
      type: "integration_evidence",
      subject: finalIntegratedSubject,
      treeSubject: finalIntegratedTreeSubject,
      clean: false,
    }));
    await expect(processor.drain()).rejects.toThrow(/accepted integration receipt does not seal a clean tree/);
    rewriteFinalIntegrationReceipt(receiptJson({
      instance,
      action: finalIntegrate,
      type: "integration_evidence",
      subject: finalIntegratedSubject,
      treeSubject: finalIntegratedTreeSubject,
    }));

    const beforeAggregateStatus = pipelines.getInstance(instance.id)!.status;
    db!.prepare("UPDATE pipeline_instances SET status = 'publication_blocked' WHERE id = ?").run(instance.id);
    await expect(processor.drain()).rejects.toThrow(/pipeline publication is blocked/);
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      aggregate_emitted_at: expect.any(String),
      aggregate_artifact_hash: expect.any(String),
    });
    let canonicalGraphResultHash = pipelines.getGraphForAttempt(attempt.id)!.aggregate_artifact_hash!;
    const expectedCanonicalGraphResultHash = canonicalGraphResultHash;
    expect(pipelines.getAttempt(attempt.id)).toMatchObject({ status: "running" });

    const legacyCommitSubjectAggregate = buildAggregateStageEvent({
      id: `execution-aggregate:${attempt.id}:${finalIntegratedSubject}:success`,
      manifest: manifest.manifest,
      instance,
      parentAttempt: pipelines.getAttempt(attempt.id)!,
      outcome: "success",
      subject: finalIntegratedSubject,
      completedAt: pipelines.getGraphForAttempt(attempt.id)!.aggregate_emitted_at ?? undefined,
      units: pipelines.listUnits(attempt.id),
    });
    const legacyGraphResult = legacyCommitSubjectAggregate.artifacts
      ?.find((artifact) => artifact.kind === "execution_graph_result");
    expect(legacyGraphResult).toBeDefined();
    const persistLegacyGraphResult = () => {
      db!.prepare(`
        INSERT INTO pipeline_artifacts (
          id, pipeline_instance_id, attempt_id, kind, schema_version,
          assurance, subject, payload, artifact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          pipeline_instance_id = excluded.pipeline_instance_id,
          attempt_id = excluded.attempt_id,
          kind = excluded.kind,
          schema_version = excluded.schema_version,
          assurance = excluded.assurance,
          subject = excluded.subject,
          payload = excluded.payload,
          artifact_hash = excluded.artifact_hash
      `).run(
        `legacy-artifact-${attempt.id}`,
        instance.id,
        attempt.id,
        legacyGraphResult!.kind,
        legacyGraphResult!.schemaVersion,
        legacyGraphResult!.assurance,
        legacyGraphResult!.subject ?? null,
        legacyGraphResult!.payload,
        legacyGraphResult!.hash,
        "2099-07-22T12:00:00.000Z"
      );
    };
    db!.prepare("UPDATE pipeline_instances SET status = ? WHERE id = ?").run(beforeAggregateStatus, instance.id);
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run("0".repeat(64), "2099-07-22T12:00:00.000Z", attempt.id);
    await expect(processor.drain()).rejects.toThrow(/marker-only legacy replay hash does not match/);

    const aggregatePublication = db!.prepare(`
      SELECT e.id, e.body, e.linear_outbox_id, o.payload
      FROM execution_publication_events e
      JOIN linear_outbox o ON o.id = e.linear_outbox_id
      WHERE e.parent_attempt_id = ? AND e.kind = 'aggregate'
      ORDER BY e.sequence ASC
      LIMIT 1
    `).get(attempt.id) as { id: string; body: string; linear_outbox_id: string; payload: string };
    const legacyAggregateBody = aggregatePublication.body.replaceAll(canonicalGraphResultHash, legacyGraphResult!.hash);
    const aggregateOutboxPayload = JSON.parse(aggregatePublication.payload) as {
      activity: Record<string, unknown>;
    } & Record<string, unknown>;
    const legacyAggregateOutboxPayload = canonicalJson({
      ...aggregateOutboxPayload,
      activity: {
        ...aggregateOutboxPayload.activity,
        body: legacyAggregateBody,
      },
    });
    const rewriteAggregatePublicationToLegacyHash = () => {
      db!.prepare("UPDATE execution_publication_events SET body = ? WHERE id = ?")
        .run(legacyAggregateBody, aggregatePublication.id);
      db!.prepare("UPDATE linear_outbox SET payload = ?, payload_hash = ? WHERE id = ?")
        .run(
          legacyAggregateOutboxPayload,
          digestNormalized(legacyAggregateOutboxPayload),
          aggregatePublication.linear_outbox_id
        );
    };
    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare("UPDATE pipeline_instances SET status = 'publication_blocked' WHERE id = ?").run(instance.id);
    await expect(processor.drain()).rejects.toThrow(/pipeline publication is blocked/);
    canonicalGraphResultHash = pipelines.getGraphForAttempt(attempt.id)!.aggregate_artifact_hash!;
    expect(canonicalGraphResultHash).toBe(expectedCanonicalGraphResultHash);
    expect(canonicalGraphResultHash).not.toBe(legacyGraphResult!.hash);
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      aggregate_artifact_hash: canonicalGraphResultHash,
    });
    const structuredPublication = pipelines.getStructuredExecutionPublicationForInstance(instance.id)!;
    expect(structuredPublication.graph.aggregate_artifact_hash).toBe(canonicalGraphResultHash);
    expect(executionLedgerLines(structuredPublication))
      .toEqual(expect.arrayContaining([
        expect.stringContaining(`aggregate=${canonicalGraphResultHash}`),
      ]));
    rewriteAggregatePublicationToLegacyHash();
    await expect(processor.drain()).rejects.toThrow(/pipeline publication is blocked/);
    const reconciledPublication = pipelines.getStructuredExecutionPublicationForInstance(instance.id)!;
    expect(reconciledPublication.graph.aggregate_artifact_hash).toBe(canonicalGraphResultHash);
    expect(executionLedgerLines(reconciledPublication))
      .toEqual(expect.arrayContaining([
        expect.stringContaining(`aggregate=${canonicalGraphResultHash}`),
      ]));
    expect(executionLedgerLines(reconciledPublication))
      .not.toEqual(expect.arrayContaining([
        expect.stringContaining(`aggregate=${legacyGraphResult!.hash}`),
      ]));
    db!.prepare("UPDATE pipeline_instances SET status = ? WHERE id = ?").run(beforeAggregateStatus, instance.id);

    await processor.drain();
    const aggregate = pipelines.getGraphForAttempt(attempt.id);
    expect(aggregate).toMatchObject({
      aggregate_emitted_at: expect.any(String),
      aggregate_artifact_hash: canonicalGraphResultHash,
      integration_subject: finalIntegratedSubject,
    });
    expect(pipelines.getInstance(instance.id)).toMatchObject({
      active_stage_id: intermediateStageId,
      status: "dispatchable",
      immutable_subject: finalIntegratedTreeSubject,
    });
    const queuedIntermediateAttempt = pipelines.getActiveAttempt(instance.id)!;
    const queuedIntermediateRequest = JSON.parse(queuedIntermediateAttempt.request_payload!) as StageRequestEnvelope;
    const queuedIntermediateWithoutFence = (({ requestHash, idempotencyKey, ...rest }: StageRequestEnvelope) => {
      void requestHash;
      void idempotencyKey;
      return rest;
    })(queuedIntermediateRequest);
    const legacyIntermediateWithoutFence = {
      ...queuedIntermediateWithoutFence,
      expectedSubject: finalIntegratedSubject,
    };
    const legacyIntermediateFence = createStageRequestHash(legacyIntermediateWithoutFence);
    const legacyIntermediateRequest = canonicalJson({ ...legacyIntermediateWithoutFence, ...legacyIntermediateFence });
    const intermediateEffect = pipelines.listEffects(instance.id).find((effect) =>
      effect.kind === "dispatch_stage" &&
      effect.status === "pending" &&
      effect.idempotency_key === queuedIntermediateRequest.idempotencyKey
    )!;
    persistLegacyGraphResult();
    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, updated_at = ?
      WHERE id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
          request_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      legacyIntermediateFence.requestHash,
      legacyIntermediateFence.idempotencyKey,
      legacyIntermediateRequest,
      "2099-07-22T12:00:00.000Z",
      queuedIntermediateAttempt.id
    );
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET idempotency_key = ?, payload = ?, payload_hash = ?
      WHERE id = ?
    `).run(
      legacyIntermediateFence.idempotencyKey,
      legacyIntermediateRequest,
      digestNormalized(legacyIntermediateRequest),
      intermediateEffect.id
    );
    await processor.drain();
    const intermediateAttempt = pipelines.getActiveAttempt(instance.id)!;
    expect(intermediateAttempt).toMatchObject({
      stage_id: intermediateStageId,
      status: "running",
      expected_subject: finalIntegratedTreeSubject,
    });
    expect(runtime.dispatchStage).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        stageId: intermediateStageId,
        expectedSubject: finalIntegratedTreeSubject,
      })
    );
    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, status = 'running', updated_at = ?
      WHERE id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
          planned_run_id = ?, run_id = ?, request_payload = ?, status = 'running',
          updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      legacyIntermediateFence.requestHash,
      legacyIntermediateFence.idempotencyKey,
      legacyIntermediateWithoutFence.runId,
      legacyIntermediateWithoutFence.runId,
      legacyIntermediateRequest,
      "2099-07-22T12:00:00.000Z",
      intermediateAttempt.id
    );
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET idempotency_key = ?, payload = ?, payload_hash = ?, status = 'acknowledged'
      WHERE id = ?
    `).run(
      legacyIntermediateFence.idempotencyKey,
      legacyIntermediateRequest,
      digestNormalized(legacyIntermediateRequest),
      intermediateEffect.id
    );

    const stopCallsBeforeIntermediateRecovery = runtime.stop.mock.calls.length;
    await processor.drain();
    expect(runtime.stop).toHaveBeenCalledTimes(stopCallsBeforeIntermediateRecovery + 1);
    expect(tickets.getRun(legacyIntermediateWithoutFence.runId)).toMatchObject({ status: "stopped" });
    const restartedIntermediateAttempt = pipelines.getActiveAttempt(instance.id)!;
    const restartedIntermediateRequest = JSON.parse(restartedIntermediateAttempt.request_payload!) as StageRequestEnvelope;
    expect(restartedIntermediateAttempt).toMatchObject({
      stage_id: intermediateStageId,
      status: "pending",
      run_id: null,
      expected_subject: finalIntegratedTreeSubject,
    });
    expect(restartedIntermediateRequest).toMatchObject({
      stageId: intermediateStageId,
      expectedSubject: finalIntegratedTreeSubject,
    });
    expect(restartedIntermediateRequest.runId).not.toBe(legacyIntermediateWithoutFence.runId);
    expect(pipelines.listEffects(instance.id).filter((effect) =>
      effect.kind === "dispatch_stage" &&
      effect.status === "pending" &&
      effect.idempotency_key === restartedIntermediateRequest.idempotencyKey
    )).toHaveLength(1);

    const dispatchCallsBeforeIntermediateRestart = runtime.dispatchStage.mock.calls.length;
    await processor.drain();
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(dispatchCallsBeforeIntermediateRestart + 1);
    expect(runtime.dispatchStage).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        stageId: intermediateStageId,
        expectedSubject: finalIntegratedTreeSubject,
        runId: restartedIntermediateRequest.runId,
      })
    );
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBe(restartedIntermediateRequest.runId);
    const intermediateStagePayload = JSON.stringify({ id: "intermediate-release-check", outcome: "semantic_repair_required" });
    const intermediateCommandPayload = JSON.stringify({ command: "test", exit_code: 1, summary: "command requested repair" });
    tickets.finishRunAndThen({
      runId: restartedIntermediateRequest.runId,
      status: "completed",
      ticketState: "active",
      faultAttribution: null,
    }, () => coordinatePipelineEvent(pipelines, {
      id: "intermediate-release-check",
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: restartedIntermediateAttempt.id,
      requestHash: restartedIntermediateRequest.requestHash,
      outcome: "semantic_repair_required",
      resultHash: digestNormalized(intermediateStagePayload),
      subject: finalIntegratedTreeSubject,
      nativeSessionId: "publish-native-session",
      artifacts: [{
        kind: "stage_result",
        schemaVersion: 1,
        assurance: "executor_verified",
        subject: finalIntegratedTreeSubject,
        payload: intermediateStagePayload,
        hash: digestNormalized(intermediateStagePayload),
      }, {
        kind: "command_result",
        schemaVersion: 1,
        assurance: "executor_verified",
        subject: finalIntegratedTreeSubject,
        payload: intermediateCommandPayload,
        hash: digestNormalized(intermediateCommandPayload),
      }],
    }));
    expect(pipelines.getInstance(instance.id)).toMatchObject({
      active_stage_id: publishStageId,
      status: "dispatchable",
      immutable_subject: finalIntegratedTreeSubject,
    });
    const effects = pipelines.listEffects(instance.id);
    expect(effects.find((effect) => effect.kind === "dispatch_stage" && effect.status === "pending"))
      .toMatchObject({
        kind: "dispatch_stage",
        idempotency_key: expect.stringContaining(publishStageId),
      });
    const publishRequest = JSON.parse(
      effects.find((effect) => effect.kind === "dispatch_stage" && effect.status === "pending")!.payload
    ) as {
      stageId: string;
      capability: string;
      expectedSubject: string;
      runId: string;
      contextPolicy: string;
      nativeSessionId: string | null;
    };
    expect(publishRequest).toMatchObject({
      stageId: publishStageId,
      capability: "ce/publish@1",
      expectedSubject: finalIntegratedTreeSubject,
      contextPolicy: "resume_required",
      nativeSessionId: null,
    });
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBeNull();

    const publishAttempt = pipelines.getActiveAttempt(instance.id)!;
    const canonicalRequest = JSON.parse(publishAttempt.request_payload!) as StageRequestEnvelope;
    const canonicalWithoutFence = (({ requestHash, idempotencyKey, ...rest }: StageRequestEnvelope) => {
      void requestHash;
      void idempotencyKey;
      return rest;
    })(canonicalRequest);
    const legacyWithoutFence = {
      ...canonicalWithoutFence,
      expectedSubject: finalIntegratedSubject,
      nativeSessionId: "publish-native-session",
    };
    const legacyFence = createStageRequestHash(legacyWithoutFence);
    const legacyRequest = canonicalJson({ ...legacyWithoutFence, ...legacyFence });
    const dispatchEffect = effects.find((effect) => effect.kind === "dispatch_stage" && effect.status === "pending")!;
    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, updated_at = ?
      WHERE id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
          native_session_id = ?, request_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      legacyFence.requestHash,
      legacyFence.idempotencyKey,
      "publish-native-session",
      legacyRequest,
      "2099-07-22T12:00:00.000Z",
      publishAttempt.id
    );
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET idempotency_key = ?, payload = ?, payload_hash = ?
      WHERE id = ?
    `).run(legacyFence.idempotencyKey, legacyRequest, digestNormalized(legacyRequest), dispatchEffect.id);
    db!.prepare(`
      DELETE FROM pipeline_artifacts
      WHERE attempt_id = ? AND kind = 'execution_graph_result' AND artifact_hash = ?
    `).run(attempt.id, canonicalGraphResultHash);
    expect(db!.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_artifacts
      WHERE attempt_id = ? AND kind = 'execution_graph_result' AND artifact_hash = ?
    `).get(attempt.id, canonicalGraphResultHash)).toEqual({ count: 0 });

    const dispatchCallsBeforePublish = runtime.dispatchStage.mock.calls.length;
    await processor.drain();
    expect(db!.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_artifacts
      WHERE attempt_id = ? AND kind = 'execution_graph_result' AND artifact_hash = ?
    `).get(attempt.id, canonicalGraphResultHash)).toEqual({ count: 1 });
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(dispatchCallsBeforePublish + 1);
    expect(runtime.dispatchStage).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        stageId: publishStageId,
        capability: "ce/publish@1",
        expectedSubject: finalIntegratedTreeSubject,
        contextPolicy: publishRequest.contextPolicy,
        nativeSessionId: "publish-native-session",
      })
    );
    expect(pipelines.getInstance(instance.id)).toMatchObject({ immutable_subject: finalIntegratedTreeSubject });
    expect(pipelines.getActiveAttempt(instance.id)).toMatchObject({
      stage_id: publishStageId,
      expected_subject: finalIntegratedTreeSubject,
    });
    expect(JSON.parse(pipelines.getEffect(dispatchEffect.id)!.payload)).toMatchObject({
      expectedSubject: finalIntegratedTreeSubject,
    });
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBe(publishRequest.runId);

    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, status = 'running', updated_at = ?
      WHERE id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
          planned_run_id = ?, run_id = ?, request_payload = ?, status = 'running',
          native_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      legacyFence.requestHash,
      legacyFence.idempotencyKey,
      legacyWithoutFence.runId,
      legacyWithoutFence.runId,
      legacyRequest,
      "publish-native-session",
      "2099-07-22T12:00:00.000Z",
      publishAttempt.id
    );
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET idempotency_key = ?, payload = ?, payload_hash = ?, status = 'acknowledged'
      WHERE id = ?
    `).run(legacyFence.idempotencyKey, legacyRequest, digestNormalized(legacyRequest), dispatchEffect.id);

    const stopCallsBeforeRecovery = runtime.stop.mock.calls.length;
    await processor.drain();
    expect(runtime.stop).toHaveBeenCalledTimes(stopCallsBeforeRecovery + 1);
    expect(tickets.getRun(legacyWithoutFence.runId)).toMatchObject({ status: "stopped" });
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBeNull();
    expect(pipelines.getInstance(instance.id)).toMatchObject({
      active_stage_id: publishStageId,
      status: "dispatchable",
      immutable_subject: finalIntegratedTreeSubject,
    });
    const restartedAttempt = pipelines.getActiveAttempt(instance.id)!;
    const restartedRequest = JSON.parse(restartedAttempt.request_payload!) as StageRequestEnvelope;
    expect(restartedAttempt).toMatchObject({
      stage_id: publishStageId,
      status: "pending",
      run_id: null,
      native_session_id: "publish-native-session",
      expected_subject: finalIntegratedTreeSubject,
    });
    expect(restartedRequest).toMatchObject({
      stageId: publishStageId,
      expectedSubject: finalIntegratedTreeSubject,
      nativeSessionId: "publish-native-session",
    });
    expect(restartedRequest.runId).not.toBe(legacyWithoutFence.runId);
    const restartedEffect = pipelines.listEffects(instance.id).find((effect) =>
      effect.kind === "dispatch_stage" &&
      effect.status === "pending" &&
      effect.id !== dispatchEffect.id
    );
    expect(restartedEffect).toMatchObject({
      idempotency_key: restartedRequest.idempotencyKey,
      payload: canonicalJson(restartedRequest),
    });

    const dispatchCallsBeforeRestart = runtime.dispatchStage.mock.calls.length;
    await processor.drain();
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(dispatchCallsBeforeRestart + 1);
    expect(runtime.dispatchStage).toHaveBeenLastCalledWith(
      { providerResourceId: "sandbox-child-drain" },
      expect.objectContaining({
        stageId: publishStageId,
        expectedSubject: finalIntegratedTreeSubject,
        runId: restartedRequest.runId,
        nativeSessionId: "publish-native-session",
      })
    );
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBe(restartedRequest.runId);

    const postRestartAttempt = pipelines.getActiveAttempt(instance.id)!;
    const postRestartCanonicalRequest = JSON.parse(postRestartAttempt.request_payload!) as StageRequestEnvelope;
    const postRestartCanonicalWithoutFence = (({ requestHash, idempotencyKey, ...rest }: StageRequestEnvelope) => {
      void requestHash;
      void idempotencyKey;
      return rest;
    })(postRestartCanonicalRequest);
    const postRestartLegacyWithoutFence = {
      ...postRestartCanonicalWithoutFence,
      expectedSubject: finalIntegratedSubject,
    };
    const postRestartLegacyFence = createStageRequestHash(postRestartLegacyWithoutFence);
    const postRestartLegacyRequest = canonicalJson({ ...postRestartLegacyWithoutFence, ...postRestartLegacyFence });
    const postRestartEffect = pipelines.listEffects(instance.id).find((effect) =>
      effect.kind === "dispatch_stage" &&
      effect.idempotency_key === postRestartCanonicalRequest.idempotencyKey
    )!;

    rewriteAggregatePublicationToLegacyHash();
    db!.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
    `).run(legacyGraphResult!.hash, "2099-07-22T12:00:00.000Z", attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, status = 'running', updated_at = ?
      WHERE id = ?
    `).run(finalIntegratedSubject, "2099-07-22T12:00:00.000Z", instance.id);
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
          planned_run_id = ?, run_id = ?, request_payload = ?, status = 'running',
          native_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      finalIntegratedSubject,
      postRestartLegacyFence.requestHash,
      postRestartLegacyFence.idempotencyKey,
      postRestartLegacyWithoutFence.runId,
      postRestartLegacyWithoutFence.runId,
      postRestartLegacyRequest,
      "publish-native-session",
      "2099-07-22T12:00:00.000Z",
      postRestartAttempt.id
    );
    db!.prepare("DELETE FROM pipeline_effect_intents WHERE id = ?").run(postRestartEffect.id);
    db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at, acknowledged_at
      ) VALUES (
        'effect-crash-legacy-publish', ?, 500, 'dispatch_stage', ?, ?, ?,
        'acknowledged', 1, ?, ?, ?
      )
    `).run(
      instance.id,
      postRestartLegacyFence.idempotencyKey,
      postRestartLegacyRequest,
      digestNormalized(postRestartLegacyRequest),
      "2099-07-22T12:00:00.000Z",
      "2099-07-22T12:00:00.000Z",
      "2099-07-22T12:00:00.000Z"
    );
    tickets.finishRun({
      runId: postRestartLegacyWithoutFence.runId,
      status: "stopped",
      ticketState: "active",
      faultAttribution: null,
    });
    expect(tickets.getByIssueId(instance.linear_issue_id)?.run_id).toBeNull();

    const restartedProcessor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });
    const stopCallsBeforeSettledRunReplay = runtime.stop.mock.calls.length;
    await restartedProcessor.drain();
    expect(runtime.stop).toHaveBeenCalledTimes(stopCallsBeforeSettledRunReplay);
    const settledRunReplayAttempt = pipelines.getActiveAttempt(instance.id)!;
    const settledRunReplayRequest = JSON.parse(settledRunReplayAttempt.request_payload!) as StageRequestEnvelope;
    expect(settledRunReplayAttempt).toMatchObject({
      stage_id: publishStageId,
      status: "pending",
      run_id: null,
      native_session_id: "publish-native-session",
      expected_subject: finalIntegratedTreeSubject,
    });
    expect(settledRunReplayRequest).toMatchObject({
      stageId: publishStageId,
      expectedSubject: finalIntegratedTreeSubject,
      nativeSessionId: "publish-native-session",
    });
    expect(pipelines.listEffects(instance.id).filter((effect) =>
      effect.kind === "dispatch_stage" &&
      effect.status === "pending" &&
      effect.idempotency_key === settledRunReplayRequest.idempotencyKey
    )).toHaveLength(1);
  });

  it("leaves retryable child loop errors active for effect retry instead of parsing them as receipts", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-retryable-loop-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const manifest = parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      id: "builtin/structured",
      runtime: runtimeDescriptor.descriptor,
      config: repositoryConfig.config,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-retryable-loop",
      instructions: { implement_a: "Implement unit A." },
      acceptance: { unit_a_done: "Unit A is complete." },
      units: [{
        id: "unit_a",
        title: "Unit A",
        depends_on: [],
        instructions: ["implement_a"],
        acceptance: ["unit_a_done"],
      }],
      commands: [],
    };
    tickets.upsert({
      linear_issue_id: "issue-retryable-loop",
      linear_issue_identifier: "OT-RETRYABLE-LOOP",
      linear_session_id: "session-retryable-loop",
      sandbox_id: null,
      branch: "ot/retryable-loop",
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
        taskContext: [
          "Approved structured plan.",
          "",
          "```json openthrottle.execution-plan/v1",
          JSON.stringify(executionPlan, null, 2),
          "```",
        ].join("\n"),
      },
    });
    const instance = pipelines.getInstanceForSession("session-retryable-loop")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "retryable-loop" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    await processor.drain();
    const action = pipelines.listWorkAttempts(attempt.id)[0]!;
    runtime.collectLoopActionResult.mockResolvedValueOnce({
      actionId: action.id,
      attemptId: attempt.id,
      requestHash: action.request_hash!,
      outcome: "retryable_infrastructure_failure",
      nativeSessionId: null,
      subject: null,
      receipt: "model credential unavailable",
      completedAt: "2099-07-22T12:00:00.000Z",
    });

    await processor.drain();
    expect(pipelines.listWorkAttempts(attempt.id)[0]).toMatchObject({
      status: "dead",
      result_hash: expect.any(String),
      last_error: expect.stringContaining("retryable_infrastructure_failure"),
    });
    expect(pipelines.listUnits(attempt.id)).toEqual([
      expect.objectContaining({
        unitId: "unit_a",
        status: "exited",
        terminalLevel: "exited",
        alarm: false,
      }),
    ]);
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      stopped_at: expect.any(String),
      stop_reason: expect.stringContaining("retryable_infrastructure_failure"),
      aggregate_emitted_at: null,
    });

    await processor.drain();
    expect(pipelines.getAttempt(attempt.id)).toMatchObject({
      status: "failed",
      outcome: "retryable_infrastructure_failure",
    });
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      aggregate_emitted_at: expect.any(String),
    });
    const aggregateEmittedAt = pipelines.getGraphForAttempt(attempt.id)!.aggregate_emitted_at;
    const collectionCalls = runtime.collectLoopActionResult.mock.calls.length;

    await processor.drain();
    expect(runtime.collectLoopActionResult).toHaveBeenCalledTimes(collectionCalls);
    expect(pipelines.getGraphForAttempt(attempt.id)!.aggregate_emitted_at).toBe(aggregateEmittedAt);
  });

  it("settles active composite drain exceptions as retryable instead of wedging the action", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-active-drain-throw-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const manifest = parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      id: "builtin/structured",
      runtime: runtimeDescriptor.descriptor,
      config: repositoryConfig.config,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-active-drain-throw",
      instructions: { implement_a: "Implement unit A." },
      acceptance: { unit_a_done: "Unit A is complete." },
      units: [{
        id: "unit_a",
        title: "Unit A",
        depends_on: [],
        instructions: ["implement_a"],
        acceptance: ["unit_a_done"],
      }],
      commands: [],
    };
    tickets.upsert({
      linear_issue_id: "issue-active-drain-throw",
      linear_issue_identifier: "OT-ACTIVE-DRAIN-THROW",
      linear_session_id: "session-active-drain-throw",
      sandbox_id: null,
      branch: "ot/active-drain-throw",
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
        taskContext: [
          "Approved structured plan.",
          "",
          "```json openthrottle.execution-plan/v1",
          JSON.stringify(executionPlan, null, 2),
          "```",
        ].join("\n"),
      },
    });
    const instance = pipelines.getInstanceForSession("session-active-drain-throw")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "active-drain-throw" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });

    await processor.drain();
    runtime.collectLoopActionResult.mockRejectedValueOnce(new Error("Daytona collection timeout"));

    await expect(processor.drain()).resolves.toBeUndefined();
    expect(pipelines.listWorkAttempts(attempt.id)[0]).toMatchObject({
      status: "dead",
      last_error: expect.stringContaining("Daytona collection timeout"),
    });
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      stopped_at: expect.any(String),
      stop_reason: expect.stringContaining("retryable_infrastructure_failure"),
      aggregate_emitted_at: null,
    });

    await processor.drain();
    expect(pipelines.getAttempt(attempt.id)).toMatchObject({
      status: "failed",
      outcome: "retryable_infrastructure_failure",
    });
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({
      aggregate_emitted_at: expect.any(String),
    });
  });

  it("preserves valid failed command receipts for reducer handling", async () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const runtimeDescriptor = buildInstalledRuntimeDescriptor("structured-command-failure-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtimeDescriptor.descriptor);
    pipelines.acceptRuntimeDescriptor(runtimeDescriptor);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = parseRepositoryConfig([
      "schema: openthrottle.config/v1",
      "default_graph: simple",
      "graphs:",
      "  - id: simple",
      "    kind: builtin",
      "    ref: core/simple@1",
      "  - id: structured",
      "    kind: builtin",
      "    ref: core/structured@2",
      "commands: { test: npm test, lint: npm run lint, build: npm run build }",
      "pipelines: { implement: implement }",
    ].join("\n"));
    const config = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: repositoryConfig,
    });
    const manifest = parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      id: "builtin/structured",
      runtime: runtimeDescriptor.descriptor,
      config: repositoryConfig.config,
      aggregatePublishContext: "prefer_resume",
    }).manifest;
    pipelines.acceptManifest(manifest);
    const executionPlan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "structured-command-failure",
      instructions: { implement_a: "Implement unit A." },
      acceptance: { unit_a_done: "Unit A is complete." },
      units: [{
        id: "unit_a",
        title: "Unit A",
        depends_on: [],
        instructions: ["implement_a"],
        acceptance: ["unit_a_done"],
      }],
      commands: [],
    };
    tickets.upsert({
      linear_issue_id: "issue-command-failure",
      linear_issue_identifier: "OT-COMMAND-FAILURE",
      linear_session_id: "session-command-failure",
      sandbox_id: null,
      branch: "ot/command-failure",
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
        taskContext: [
          "Approved structured plan.",
          "",
          "```json openthrottle.execution-plan/v1",
          JSON.stringify(executionPlan, null, 2),
          "```",
        ].join("\n"),
      },
    });
    const instance = pipelines.getInstanceForSession("session-command-failure")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runtime = sandboxRuntimeMock({ issueId: "command-failure" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
      now: () => new Date("2099-07-22T12:00:00.000Z"),
    });
    const latestAction = () => [...pipelines.listWorkAttempts(attempt.id)].reverse()
      .find((workAttempt) => workAttempt.status !== "completed")!;
    const completedSubject = "1".repeat(40);

    await processor.drain();
    const implement = latestAction();
    runtime.collectLoopActionResult.mockResolvedValueOnce({
      actionId: implement.id,
      attemptId: attempt.id,
      requestHash: implement.request_hash!,
      outcome: "success",
      nativeSessionId: "thread-unit-a",
      subject: completedSubject,
      receipt: receiptJson({
        instance,
        action: implement,
        type: "unit_completion",
        subject: completedSubject,
        baseSubject: instance.base_commit,
        preSubject: instance.base_commit,
        nativeSessionId: null,
      }),
      completedAt: "2099-07-22T12:00:00.000Z",
    });
    await processor.drain();

    await processor.drain();
    const simplify = latestAction();
    runtime.collectLoopActionResult.mockResolvedValueOnce({
      actionId: simplify.id,
      attemptId: attempt.id,
      requestHash: simplify.request_hash!,
      outcome: "success",
      nativeSessionId: "thread-unit-a",
      subject: completedSubject,
      receipt: receiptJson({
        instance,
        action: simplify,
        type: "unit_completion",
        subject: completedSubject,
        baseSubject: instance.base_commit,
        preSubject: completedSubject,
        nativeSessionId: "thread-unit-a",
      }),
      completedAt: "2099-07-22T12:00:00.000Z",
    });
    await processor.drain();

    await processor.drain();
    const command = latestAction();
    expect(command).toMatchObject({ action_kind: "command", command_name: "test" });
    runtime.collectChildExecutorActionResult.mockResolvedValueOnce({
      actionId: command.id,
      attemptId: attempt.id,
      requestHash: command.request_hash!,
      outcome: "failure",
      subject: completedSubject,
      receipt: receiptJson({
        instance,
        action: command,
        type: "command_result",
        subject: completedSubject,
        baseSubject: instance.base_commit,
        preSubject: completedSubject,
        result: "failure",
        commandName: "test",
      }),
      completedAt: "2099-07-22T12:00:00.000Z",
    });

    await processor.drain();

    expect(pipelines.listWorkAttempts(attempt.id).find((workAttempt) => workAttempt.id === command.id))
      .toMatchObject({ status: "completed", last_error: null, output_subject: completedSubject });
    expect(pipelines.getGraphForAttempt(attempt.id)).toMatchObject({ stopped_at: null });
    expect(pipelines.listUnits(attempt.id)).toEqual([
      expect.objectContaining({ unitId: "unit_a", terminalLevel: null, alarm: false }),
    ]);
  });

  it("idles an active bound sandbox through a best-effort runtime effect", async () => {
    const { pipelines, runtime, processor, instance, attempt } = harness("issue-idle", "session-idle");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.setIdle.mockRejectedValueOnce(new Error("provider timeout"));

    await processor.drain();
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = ?
      WHERE id = ?
    `).run(attempt.stage_id, instance.id);
    enqueueIdleEffect({ id: "idle-provider-wait", instance, attempt });

    await processor.drain();

    expect(runtime.setIdle).toHaveBeenCalledWith("sandbox-issue-idle");
    expect(consoleError).toHaveBeenCalledWith(
      "[pipeline-effects] failed to idle sandbox:",
      expect.stringContaining("provider timeout")
    );
    expect(runtime.cleanup).not.toHaveBeenCalled();
    expect(pipelines.getRuntimeResource(instance.id)).toMatchObject({
      provider_resource_id: "sandbox-issue-idle",
      status: "active",
    });
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === "idle-provider-wait"))
      .toMatchObject({ status: "acknowledged", attempts: 1 });
  });

  it("does not let a stale idle completion undo a repair dispatch reactivation", async () => {
    const { pipelines, runtime, processor, instance, attempt } = harness("issue-stale-idle", "session-stale-idle");

    await processor.drain();
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = ?
      WHERE id = ?
    `).run(attempt.stage_id, instance.id);
    enqueueIdleEffect({ id: "idle-provider-wait-stale-after-call", instance, attempt });
    runtime.setIdle.mockImplementationOnce(async () => {
      db!.prepare("UPDATE pipeline_instances SET status = 'dispatchable' WHERE id = ?")
        .run(instance.id);
    });

    await processor.drain();

    expect(runtime.setIdle).toHaveBeenCalledWith("sandbox-issue-stale-idle");
    expect(runtime.setActive).toHaveBeenCalledWith("sandbox-issue-stale-idle");
    expect(pipelines.listEffects(instance.id).find((effect) => effect.id === "idle-provider-wait-stale-after-call"))
      .toMatchObject({ status: "acknowledged", attempts: 1 });
  });

  it.each([
    ["waiting_human"],
    ["completion_pending_publication"],
  ] as const)("idles an active bound sandbox during %s", async (status) => {
    const { pipelines, runtime, processor, instance, attempt } = harness(
      `issue-${status}`,
      `session-${status}`
    );

    await processor.drain();
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = ?, active_stage_id = ?
      WHERE id = ?
    `).run(status, attempt.stage_id, instance.id);
    enqueueIdleEffect({
      id: `idle-${status}`,
      instance,
      attempt,
      reason: "human wait",
    });

    await processor.drain();

    expect(runtime.setIdle).toHaveBeenCalledWith(`sandbox-issue-${status}`);
    expect(pipelines.getEffect(`idle-${status}`))
      .toMatchObject({ status: "acknowledged", attempts: 1 });
  });

  it("restores active autostop before dispatching after an idled wait", async () => {
    const { pipelines, runtime, processor, instance, attempt } = harness(
      "issue-repair-reactivate",
      "session-repair-reactivate"
    );

    await processor.drain();
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = ?
      WHERE id = ?
    `).run(attempt.stage_id, instance.id);
    enqueueIdleEffect({ id: "idle-before-repair-dispatch", instance, attempt });
    await processor.drain();
    expect(runtime.setIdle).toHaveBeenCalledWith("sandbox-issue-repair-reactivate");

    runtime.setActive.mockClear();
    runtime.dispatchStage.mockClear();
    const payload = canonicalJson(pipelines.getStageRequest(attempt.id));
    db!.prepare("UPDATE pipeline_instances SET status = 'dispatchable' WHERE id = ?")
      .run(instance.id);
    db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, 3, 'dispatch_stage', ?, ?, ?, 'pending', ?, ?)
    `).run(
      "dispatch-after-idle",
      instance.id,
      "dispatch-after-idle",
      payload,
      digestNormalized(payload),
      "2099-07-22T12:00:00.000Z",
      "2099-07-22T12:00:00.000Z"
    );

    await processor.drain();

    expect(runtime.setActive).toHaveBeenCalledWith("sandbox-issue-repair-reactivate");
    expect(runtime.dispatchStage).toHaveBeenCalledTimes(1);
    expect(runtime.setActive.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.dispatchStage.mock.invocationCallOrder[0]);
    expect(pipelines.getEffect("dispatch-after-idle"))
      .toMatchObject({ status: "acknowledged", attempts: 1 });
  });

  it("does not acknowledge a failed idle effect canceled by terminal control", async () => {
    const { pipelines, runtime, processor, instance, attempt } = harness("issue-failed-dead-idle", "session-failed-dead-idle");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processor.drain();
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = ?
      WHERE id = ?
    `).run(attempt.stage_id, instance.id);
    enqueueIdleEffect({ id: "idle-provider-wait-failed-after-dead", instance, attempt });
    runtime.setIdle.mockImplementationOnce(async () => {
      db!.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'dead', last_error = 'canceled by terminal control'
        WHERE id = ?
      `).run("idle-provider-wait-failed-after-dead");
      throw new Error("provider timeout");
    });

    await processor.drain();

    expect(runtime.setIdle).toHaveBeenCalledWith("sandbox-issue-failed-dead-idle");
    expect(consoleError).toHaveBeenCalledWith(
      "[pipeline-effects] failed to idle sandbox:",
      expect.stringContaining("provider timeout")
    );
    expect(pipelines.getEffect("idle-provider-wait-failed-after-dead"))
      .toMatchObject({ status: "dead", attempts: 1, last_error: "canceled by terminal control" });
    expect(pipelines.listEffects(instance.id).filter((effect) => effect.kind === "stop")).toHaveLength(0);
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
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\ntest: npm test\n"),
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
    const runtime = sandboxRuntimeMock({ issueId: "unexpected", providerDispatchId: "unexpected" });
    const processor = createPipelineEffectProcessor({
      store: pipelines,
      tickets,
      runtime,
      taskTimeoutSeconds: 300,
      runtimeResourceRetentionMinutes: 60,
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
      "SELECT actor_state FROM pipeline_stage_attempts WHERE run_id = ?"
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
      "SELECT actor_state FROM pipeline_stage_attempts WHERE run_id = ?"
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
    const provision = pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision")!;
    const makeRetryEligible = () => {
      db!.prepare("UPDATE pipeline_effect_intents SET next_attempt_at = ? WHERE id = ?")
        .run("2099-07-22T12:00:00.000Z", provision.id);
    };

    await processor.drain();
    for (let retry = 0; retry < 2; retry += 1) {
      makeRetryEligible();
      await processor.drain();
    }

    expect(runtime.provision).toHaveBeenCalledTimes(3);
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({
        status: "failed",
        attempts: 3,
        next_attempt_at: "2099-07-22T12:05:00.000Z",
        last_error: expect.stringContaining("Total memory limit exceeded"),
      });
    expect(pipelines.getInstance(instance.id)).toMatchObject({ terminal_outcome: null });
    const activities = listLinearOutbox().filter((row) => row.id === `capacity-wait:${provision.id}`);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "activity",
      linear_session_id: "session-capacity",
      linear_issue_id: "issue-capacity",
    });
    const payload = JSON.parse(activities[0]!.payload) as { type: string; activity: { type: string; body: string } };
    expect(payload).toMatchObject({ type: "activity", activity: { type: "response" } });
    expect(payload.activity.body).toContain("waiting on sandbox capacity");
    expect(payload.activity.body).toContain("Total memory limit exceeded");
    expect(payload.activity.body).toContain("retry automatically");
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

  it("reconciles eligible terminal stopped runtime resources once on a capacity error", async () => {
    const { pipelines, tickets, runtime, processor, instance, catalog, config, runtimeDescriptor } =
      harness("issue-capacity-reconcile", "session-capacity-reconcile");
    // A second, unrelated terminal instance whose resource was stopped-but-
    // preserved (the needs_human cleanup effect) and is well past its
    // retention window -- exactly what the capacity-triggered reconciler
    // should be able to free up before the provision retry is scheduled.
    const manifest = catalog.manifests.get("fixture/command@2")!;
    tickets.upsert({
      linear_issue_id: "issue-stale-needs-human",
      linear_issue_identifier: "ISSUE-STALE-NEEDS-HUMAN",
      linear_session_id: "session-stale-needs-human",
      sandbox_id: null,
      branch: "ot/issue-stale-needs-human",
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
    const staleInstance = pipelines.getInstanceForSession("session-stale-needs-human")!;
    pipelines.bindRuntimeResource(staleInstance.id, "daytona", "sandbox-stale-needs-human");
    pipelines.setRuntimeResourceStatus(staleInstance.id, "stopped");
    tickets.setSandboxId("issue-stale-needs-human", "sandbox-stale-needs-human");
    db!.prepare(`
      UPDATE pipeline_effect_intents SET status = 'acknowledged'
      WHERE pipeline_instance_id = ? AND status = 'pending'
    `).run(staleInstance.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human', active_stage_id = NULL,
          runtime_resource_updated_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(staleInstance.id);

    runtime.provision.mockRejectedValue(new Error("Total memory limit exceeded"));
    await processor.drain();

    expect(runtime.cleanup).toHaveBeenCalledWith({ providerResourceId: "sandbox-stale-needs-human" });
    expect(pipelines.getRuntimeResource(staleInstance.id)?.status).toBe("cleaned");
    expect(pipelines.getInstance(instance.id)).toMatchObject({ terminal_outcome: null });
  });

  it("bounds capacity-triggered reconciliation below the effect lease", async () => {
    const reconcileRuntimeResources = vi.fn<RuntimeResourceReconciler>(async () => ({
      reclaimed: 0,
      candidates: 1,
    }));
    const { pipelines, runtime, processor, instance } = harness(
      "issue-capacity-bounded",
      "session-capacity-bounded",
      { reconcileRuntimeResources }
    );
    runtime.provision.mockRejectedValue(new Error("Total memory limit exceeded"));

    await processor.drain();

    expect(reconcileRuntimeResources).toHaveBeenCalledWith({
      cutoffIso: "2099-07-22T11:00:00.000Z",
      limit: 1,
      trigger: "capacity-constrained effect drain",
      waitTimeoutMs: 5_000,
    });
    expect(pipelines.getInstance(instance.id)).toMatchObject({ terminal_outcome: null });
  });

  it("keeps the capacity retry when the wait activity cannot be enqueued", async () => {
    const { tickets, pipelines, runtime, processor, instance } =
      harness("issue-capacity-activity-fail", "session-capacity-activity-fail");
    runtime.provision.mockRejectedValue(new Error("Total memory limit exceeded"));
    const enqueueLinearOutbox = tickets.enqueueLinearOutbox.bind(tickets);
    vi.spyOn(tickets, "enqueueLinearOutbox").mockImplementation((params) => {
      if (params.id?.startsWith("capacity-wait:")) throw new Error("outbox unavailable");
      return enqueueLinearOutbox(params);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processor.drain();

    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({
        status: "failed",
        attempts: 1,
        next_attempt_at: "2099-07-22T12:05:00.000Z",
        last_error: expect.stringContaining("Total memory limit exceeded"),
      });
    expect(listLinearOutbox().filter((row) => row.id.startsWith("capacity-wait:"))).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "[pipeline-effects] failed to enqueue capacity wait activity:",
      expect.stringContaining("outbox unavailable")
    );
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
    expect(listLinearOutbox().filter((row) => row.id.startsWith("capacity-wait:"))).toEqual([]);
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
