import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  DEFINITION_BUNDLE_SCHEMA,
  EVAL_DEFINITION_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  PIPELINE_DEFINITION_SCHEMA,
  RESULT_CANDIDATE_SCHEMA,
  RUNTIME_PROVISION_STAGE_ID,
  SEMANTIC_RESULT_SCHEMA,
  definitionEntryContentHash,
  expandCompiledRuntimeLifecycle,
  runtimeStopStageId,
  validateAndNormalizeResultCandidate,
  validateDefinitionBundle,
  canonicalJson,
  type BlobPointer,
  type CompiledPipelineManifest,
  type AttemptCheckpoint,
  type DefinitionBundleEntry,
  type DecisionRecord,
  type EvalDefinition,
  type ExecutionRecord,
  type ReviewFindingV1,
  type ResultCandidate,
  type SemanticResultSchemaContract,
  type TrustedPlatformDefinitionHashes,
} from "@openthrottle/contracts";
import { VerifiedKernelDefinitionBundleResolver } from "../../app/kernel-composition.js";
import { admitKernelPipeline } from "../../app/kernel-admission.js";
import { KernelRuntimeSessionService } from "../../app/kernel-runtime-session.js";
import { VolumeBlobStore } from "../../persistence/blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
} from "../../persistence/epoch-database.js";
import { SqliteKernelStore } from "../../persistence/kernel-store.js";
import type {
  KernelResultCorrectionRequest,
  KernelInvalidResultEvidence,
  KernelRuntimeLeaseCallbacks,
  KernelRuntimeOutcome,
  KernelRuntimePort,
  KernelRuntimeWorkCallbacks,
  KernelWorkActionRequest,
  StagedSemanticCandidate,
} from "../../runtime/kernel-contracts.js";
import {
  buildKernelWorkActionRequest,
  createPendingKernelAttempt,
  exactKernelContext,
  kernelAttemptRequestHash,
} from "./action-request.js";
import {
  createPipelineDecisionRecord,
  ordinaryKernelPayloadSchemas,
} from "./evaluator-registry.js";
import { createInvalidResultEvidenceRecord } from "./attempt-evidence.js";
import { OrdinaryKernelCoordinator } from "./ordinary-coordinator.js";
import { compileKernelCursor, frontierMemberKey } from "./reducer.js";
import { sandboxRecoveryAttemptId, sandboxRecoveryEvaluator } from "./sandbox-recovery.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type AtomicTransitionBundle,
  type KernelAttempt,
  type KernelRun,
} from "./types.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SOURCE = "1".repeat(40);
const IMPLEMENTED = "2".repeat(40);
const SIMPLIFIED = "3".repeat(40);
const CAPABILITY = "c".repeat(64);
const EXECUTION_POLICY = Object.freeze({ max_concurrent_attempts: 1 });
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function entry(
  definition_kind: DefinitionBundleEntry["definition_kind"],
  definition_id: string,
  normalized_payload: unknown,
  origin: "platform" | "repository" = "platform",
): DefinitionBundleEntry {
  const path = definition_kind === "config"
    ? ".openthrottle/config.yml"
    : definition_kind === "agent"
      ? `.openthrottle/agents/${definition_id}/instructions.md`
      : definition_kind === "pipeline"
        ? `.openthrottle/pipelines/${definition_id}/pipeline.yml`
        : definition_kind === "skill"
          ? `.openthrottle/skills/${definition_id}/SKILL.md`
          : `.openthrottle/evals/${definition_id}/eval.yml`;
  return {
    definition_kind,
    definition_id,
    origin: { kind: origin, source_commit: origin === "repository" ? SOURCE : null },
    path,
    content_hash: definitionEntryContentHash(normalized_payload),
    normalized_payload,
  };
}

function skill(id: string): unknown {
  const name = id.slice(id.lastIndexOf("/") + 1);
  return {
    frontmatter: { name, description: `${name} procedure` },
    instructions: `Follow the ${name} procedure.`,
    files: [],
  };
}

const actionSchema: SemanticResultSchemaContract = {
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "core/action-result",
  outcomes: [
    "success", "no_change", "semantic_repair_required", "needs_human",
    "retryable_infrastructure_failure", "failure",
  ],
  payload: {
    summary: {
      type: "string",
      max_length: 1_000,
      normalize: "string-array-to-newlines/v1",
    },
    evidence: { type: "string_list", max_length: 1_000, max_items: 50 },
    findings: {
      type: "string_list",
      max_length: 2_000,
      max_items: 50,
    },
    actions: { type: "string_list", max_length: 300, max_items: 50 },
    uncertainty: { type: "string_list", max_length: 300, max_items: 20 },
  },
};

const reviewSchema: SemanticResultSchemaContract = {
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "core/review-result",
  outcomes: ["success", "no_change", "semantic_repair_required", "needs_human", "failure"],
  payload: {
    summary: {
      type: "string",
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
    findings: { type: "review_finding_list_v1", max_items: 64 },
  },
};

function evaluation(
  id: string,
  evaluator: string,
  result: SemanticResultSchemaContract,
): EvalDefinition {
  return { schema: EVAL_DEFINITION_SCHEMA, id, evaluator, result };
}

function fixture(): {
  compilation: {
    bundle: ReturnType<typeof validateDefinitionBundle>;
    manifest: { value: CompiledPipelineManifest; normalized: string; digest: string };
  };
  manifest: CompiledPipelineManifest;
  trusted: TrustedPlatformDefinitionHashes;
} {
  const stages: CompiledPipelineManifest["stages"] = [
    {
      id: "implement", kind: "agent", engine: "codex", agent_id: "core/ordinary-worker",
      repository_authority: "edit", skills: ["core/implement-plan"],
      entry_skill: "core/implement-plan", eval: "core/action-result",
      on: { success: { to: "review" }, no_change: { terminal: "no_change" }, failure: { terminal: "failed" } },
    },
    {
      id: "review", kind: "agent", engine: "codex", agent_id: "core/reviewer",
      repository_authority: "inspect", skills: ["core/review-change"],
      entry_skill: "core/review-change", eval: "core/review-result",
      on: {
        success: { to: "simplify" }, no_change: { to: "simplify" },
        semantic_repair_required: { to: "repair", max_reentries: 2, on_exhausted: "needs_human" },
        failure: { terminal: "failed" },
      },
    },
    {
      id: "repair", kind: "agent", engine: "codex", agent_id: "core/ordinary-worker",
      repository_authority: "edit", skills: ["core/repair-unit"],
      entry_skill: "core/repair-unit", eval: "core/action-result",
      on: { success: { to: "review" }, failure: { terminal: "failed" } },
    },
    {
      id: "simplify", kind: "agent", engine: "codex", agent_id: "core/ordinary-worker",
      repository_authority: "edit", skills: ["core/simplify-change"],
      entry_skill: "core/simplify-change", eval: "core/action-result",
      on: { success: { to: "post_simplify_review" }, no_change: { to: "test" }, failure: { terminal: "failed" } },
    },
    {
      id: "post_simplify_review", kind: "agent", engine: "codex", agent_id: "core/reviewer",
      repository_authority: "inspect", skills: ["core/review-change"],
      entry_skill: "core/review-change", eval: "core/review-result",
      on: { success: { to: "test" }, no_change: { to: "test" }, failure: { terminal: "failed" } },
    },
    { id: "test", kind: "command", command: "test", on: { success: { to: "lint" }, failure: { to: "repair" } } },
    { id: "lint", kind: "command", command: "lint", on: { success: { to: "build" }, failure: { to: "repair" } } },
    { id: "build", kind: "command", command: "build", on: { success: { to: "publish" }, failure: { to: "repair" } } },
    { id: "publish", kind: "effect", effect: "core/publish@1", on: { success: { terminal: "completed" }, failure: { terminal: "failed" } } },
  ];
  const authoredStages = stages.map((stage) => stage.kind === "agent"
    ? Object.fromEntries(Object.entries(stage).filter(([key]) => key !== "engine"))
    : stage);
  const entries = [
    entry("config", "repository", {
      schema: "openthrottle.config/v2",
      pipeline: "core/implement",
      engine: "codex",
      commands: { test: "npm test", lint: "npm run lint", build: "npm run build" },
    }, "repository"),
    entry("pipeline", "core/implement", {
      schema: PIPELINE_DEFINITION_SCHEMA,
      id: "core/implement",
      version: 1,
      entry: "implement",
      stages: authoredStages,
    }),
    entry("agent", "core/ordinary-worker", "Implement or simplify only the sealed task."),
    entry("agent", "core/reviewer", "Inspect the sealed change boundary and report findings."),
    entry("skill", "core/implement-plan", skill("core/implement-plan")),
    entry("skill", "core/repair-unit", skill("core/repair-unit")),
    entry("skill", "core/review-change", skill("core/review-change")),
    entry("skill", "core/simplify-change", skill("core/simplify-change")),
    entry("eval", "core/action-result", evaluation(
      "core/action-result", "core/action-outcome@1", actionSchema,
    )),
    entry("eval", "core/review-result", evaluation(
      "core/review-result", "core/review-outcome@1", reviewSchema,
    )),
  ];
  const trusted = new Map(entries
    .filter(({ origin }) => origin.kind === "platform")
    .map(({ definition_kind, definition_id, content_hash }) => [
      `${definition_kind}:${definition_id}`, content_hash,
    ]));
  const bundle = validateDefinitionBundle({
    schema: DEFINITION_BUNDLE_SCHEMA,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: CAPABILITY,
    source_commit: SOURCE,
    pipeline_id: "core/implement",
    pipeline_selection: "explicit",
    entries,
  }, { trustedPlatformDefinitions: trusted });
  const manifest: CompiledPipelineManifest = {
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: "core/implement",
    pipeline_version: 1,
    entry_stage: "implement",
    definition_bundle_hash: bundle.digest,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: CAPABILITY,
    stages,
  };
  return {
    compilation: {
      bundle,
      manifest: { value: manifest, normalized: JSON.stringify(manifest), digest: "m".repeat(64) },
    },
    manifest,
    trusted,
  };
}

function candidateFor(
  schema: SemanticResultSchemaContract,
  original: ResultCandidate,
): StagedSemanticCandidate {
  const normalized = validateAndNormalizeResultCandidate(original, schema);
  return {
    schema: "openthrottle.staged-result-candidate/v1",
    semantic_schema_id: schema.id,
    original,
    original_hash: normalized.original_hash,
    candidate: normalized.value,
    normalized_hash: normalized.normalized_hash,
    transformations: normalized.transformations,
  };
}

function actionCandidate(summary: string | string[] = "done"): StagedSemanticCandidate {
  return candidateFor(actionSchema, {
    schema: RESULT_CANDIDATE_SCHEMA,
    outcome: "success",
    payload: { summary, evidence: ["verified"], findings: [], actions: [], uncertainty: [] },
  });
}

function reviewCandidate(findings: readonly ReviewFindingV1[] = []): StagedSemanticCandidate {
  return candidateFor(reviewSchema, {
    schema: RESULT_CANDIDATE_SCHEMA,
    outcome: "success",
    payload: { summary: "reviewed", findings },
  });
}

class RuntimeFixture implements KernelRuntimePort {
  readonly workRequests: KernelWorkActionRequest[] = [];
  readonly correctionRequests: KernelResultCorrectionRequest[] = [];
  pendingOnce = false;
  blockingReview = false;
  readonly identityOutputStages = new Set<string>();
  workOutcome: ((request: KernelWorkActionRequest) => Promise<KernelRuntimeOutcome>) | null = null;
  correctionOutcome: ((request: KernelResultCorrectionRequest) => Promise<KernelRuntimeOutcome>) | null = null;
  invalidResultEvidence: KernelInvalidResultEvidence = {
    blob: {
      algorithm: "sha256",
      digest: "e".repeat(64),
      bytes: 1,
      encoding: "utf-8",
      media_type: "application/json",
      payload_schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    },
    observed_at: NOW,
  };
  lastCheckpoint: AttemptCheckpoint | null = null;

  async executeWork(
    request: KernelWorkActionRequest,
    callbacks: KernelRuntimeWorkCallbacks,
  ): Promise<KernelRuntimeOutcome> {
    this.workRequests.push(request);
    await callbacks.on_heartbeat();
    const nativeSessionId = request.action.kind === "agent"
      ? `session-${request.attempt_id}`
      : null;
    if (nativeSessionId !== null) await callbacks.on_session(nativeSessionId);
    const output = request.repository_authority === "edit"
      ? this.identityOutputStages.has(request.stage_id)
        ? request.input_subject
        : request.stage_id === "implement" ? IMPLEMENTED : SIMPLIFIED
      : null;
    const checkpoint: AttemptCheckpoint = {
      schema: ATTEMPT_CHECKPOINT_SCHEMA,
      id: `checkpoint-${request.attempt_id}`,
      pipeline_run_id: request.pipeline_run_id,
      attempt_id: request.attempt_id,
      request_hash: request.request_hash,
      definition_bundle_hash: request.definition_bundle_hash,
      input_subject: request.input_subject,
      output_subject: output,
      native_session_id: nativeSessionId,
      payload_schema: "openthrottle.executor-checkpoint/v1",
      payload: {
        inline: {
          evidence: ["verified-diff"],
          input_subject: request.input_subject,
          output_subject: output,
        },
      },
      captured_at: NOW,
    };
    this.lastCheckpoint = checkpoint;
    if (this.workOutcome) return this.workOutcome(request);
    if (this.pendingOnce && request.stage_id === "implement") {
      this.pendingOnce = false;
      return {
        state: "result_pending",
        checkpoint,
        candidate_hash: "d".repeat(64),
        diagnostics: [{ path: "result_candidate.outcome", detail: "is not admitted" }],
        correction_deadline: "2026-08-20T13:00:00.000Z",
        invalid_result_evidence: this.invalidResultEvidence,
      };
    }
    if (request.action.kind === "command") {
      return {
        state: "work_complete",
        checkpoint,
        result: {
          kind: "command",
          command_id: request.action.command_id,
          outcome: "success",
          exit_code: 0,
          summary: `${request.action.command_id} passed`,
        },
      };
    }
    return {
      state: "work_complete",
      checkpoint,
      result: {
        kind: "semantic",
        candidate: request.stage_id.includes("review")
          ? reviewCandidate(this.blockingReview ? [{
            severity: "P1",
            path: "src/security.ts",
            anchor: "authorizeRequest",
            title: "Authorization can be bypassed",
            evidence: "The sealed review subject reaches the mutation without an authorization check.",
          }] : [])
          : actionCandidate(request.stage_id === "implement" ? ["implemented", "tested"] : "simplified"),
      },
    };
  }

  async correctResult(
    request: KernelResultCorrectionRequest,
    callbacks: KernelRuntimeLeaseCallbacks,
  ): Promise<KernelRuntimeOutcome> {
    this.correctionRequests.push(request);
    await callbacks.on_heartbeat();
    if (this.correctionOutcome) return this.correctionOutcome(request);
    return {
      state: "work_complete",
      checkpoint: {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: request.checkpoint_id,
        pipeline_run_id: request.pipeline_run_id,
        attempt_id: request.attempt_id,
        request_hash: request.request_hash,
        definition_bundle_hash: request.definition_bundle_hash,
        input_subject: request.input_subject,
        output_subject: request.locked_subject,
        native_session_id: request.native_session_id,
        payload_schema: "openthrottle.executor-checkpoint/v1",
        payload: {
          inline: {
            evidence: ["verified-diff"],
            input_subject: request.input_subject,
            output_subject: request.locked_subject,
          },
        },
        captured_at: NOW,
      },
      result: { kind: "semantic", candidate: actionCandidate("corrected result only") },
    };
  }
}

interface ActiveKernelFixture {
  db: Database.Database;
  blobs: VolumeBlobStore;
  store: SqliteKernelStore;
  coordinator: OrdinaryKernelCoordinator;
  runtime: RuntimeFixture;
  run_id: string;
  restart(): ActiveKernelFixture;
}

async function setup(runtime = new RuntimeFixture()): Promise<ActiveKernelFixture> {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-ordinary-kernel-"));
  temporaryDirectories.push(directory);
  const blobs = VolumeBlobStore.initialize(join(directory, "blobs"), "ordinary-test");
  const databasePath = join(directory, "epoch.sqlite");
  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [{
      id: "repo",
      control_provider: "linear",
      route_key: "team",
      linear_team_id: "team",
      linear_team_key: "OPE",
      github_repo: "owner/repo",
      github_installation_id: 1,
      base_branch: "main",
      webhook_id: 1,
      runtime_snapshot: "snapshot",
    }],
  });
  const db = initializeFreshEpochDatabase({
    database_path: databasePath,
    blob_store: blobs,
    release_id: "ordinary-release",
    runtime_capability_digest: CAPABILITY,
    bootstrap,
    now: () => NOW,
  });
  const fixed = fixture();
  const store = new SqliteKernelStore({
    db,
    blob_store: blobs,
    manifest_resolver: { resolve: () => fixed.manifest },
    payload_schemas: ordinaryKernelPayloadSchemas(),
    execution_policy: EXECUTION_POLICY,
    now: () => NOW,
  });
  await admitKernelPipeline({
    repository: "owner/repo",
    source_commit: SOURCE,
    expected_pipeline: "core/implement",
    source_reader: {} as never,
    platform: {} as never,
    compiler_environment: {} as never,
    compile: async () => fixed.compilation,
    runtime_compatibility: { assertCompatible: () => undefined },
    blob_store: blobs,
    store,
    work_item: {
      id: "work-1",
      repository_registration_id: "repo",
      source_provider: "linear",
      source_id: "issue-1",
      source_reference: "OPE-188",
      title: "Fix the implementation",
      task_prompt: "Implement the approved plan and preserve its verified behavior.",
    },
    identity: { pipeline_run_id: "run-1", initial_attempt_id: "attempt-initial" },
    work_retry_limit: 2,
    result_correction_limit: 2,
  });
  const admittedAttempt = (await store.loadExactReductionView({
    pipeline_run_id: "run-1",
    attempt_id: "attempt-initial",
    record_ids: [],
    checkpoint_ids: [],
  })).current_attempt!;
  runtime.invalidResultEvidence = {
    blob: putInvalidResultEvidence(blobs, admittedAttempt, "work", "d"),
    observed_at: NOW,
  };
  const bundles = new VerifiedKernelDefinitionBundleResolver({
    bytes: store,
    trusted_platform_definitions: fixed.trusted,
  });
  const activate = (database: Database.Database): ActiveKernelFixture => {
    const activeStore = database === db
      ? store
      : new SqliteKernelStore({
        db: database,
        blob_store: blobs,
        manifest_resolver: { resolve: () => fixed.manifest },
        payload_schemas: ordinaryKernelPayloadSchemas(),
        execution_policy: EXECUTION_POLICY,
        now: () => NOW,
      });
    const activeBundles = database === db
      ? bundles
      : new VerifiedKernelDefinitionBundleResolver({
        bytes: activeStore,
        trusted_platform_definitions: fixed.trusted,
      });
    return {
      db: database,
      blobs,
      store: activeStore,
      coordinator: new OrdinaryKernelCoordinator({
        store: activeStore,
        definition_bundles: activeBundles,
        runtime,
        runtime_sessions: new KernelRuntimeSessionService({
          transitions: activeStore,
          now: () => NOW,
        }),
        attempt_lease_duration_ms: 5 * 60 * 1_000,
        now: () => NOW,
      }),
      runtime,
      run_id: "run-1",
      restart: () => activate(openFreshEpochDatabase({
        database_path: databasePath,
        blob_store: blobs,
        expected_identity: {
          release_id: "ordinary-release",
          runtime_capability_digest: CAPABILITY,
          blob_store_id: blobs.store_id,
          blob_marker_checksum: blobs.marker_checksum,
          bootstrap_checksum: bootstrap.checksum,
        },
      })),
    };
  };
  return activate(db);
}

async function execute(coordinator: OrdinaryKernelCoordinator, ordinal: number) {
  return coordinator.leaseAndExecuteNext({
    worker_id: "worker-1",
    lease_id: `lease-${ordinal}`,
    expires_at: `2026-08-20T12:${String(ordinal).padStart(2, "0")}:00.000Z`,
  });
}

function putJsonEvidence(
  blobs: VolumeBlobStore,
  payload_schema: string,
  value: unknown,
): BlobPointer {
  return blobs.put({
    bytes: `${canonicalJson(value)}\n`,
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema,
  }).pointer;
}

function putInvalidResultEvidence(
  blobs: VolumeBlobStore,
  attempt: KernelAttempt,
  phase: "work" | "result_correction",
  marker: string,
): BlobPointer {
  return putJsonEvidence(blobs, INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA, {
    schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    phase,
    candidate_hash: marker.repeat(64),
    rejected_candidate: {
      raw: JSON.stringify({ schema: "openthrottle.result-candidate/v1", outcome: "bad" }),
    },
    diagnostics: [{ path: "result_candidate.outcome", detail: "is not admitted" }],
    runner_stdout_tail: "invalid candidate",
    runner_stderr_tail: "",
    observed_at: NOW,
  });
}

describe("ordinary kernel activation", () => {
  it("reports worker activity after a successful runtime lease heartbeat", async () => {
    const test = await setup();
    try {
      const leased = await test.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-activity",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      expect(leased).not.toBeNull();
      let activityCount = 0;

      await expect(test.coordinator.executeLeasedAttempt(
        leased!,
        () => { activityCount += 1; },
      )).resolves.toMatchObject({ disposition: "settled" });

      expect(activityCount).toBe(1);
    } finally {
      test.db.close();
    }
  });

  async function sandboxFailureTransition(
    error: Error | null,
    structuredSibling = false,
    repeatedForensicsSignature: string | null = null,
    correctionFailure = false,
    correctionBudget = false,
    options: {
      fresh_sandbox_recovery?: boolean;
      recovered_sandbox_fatal?: boolean;
      recovered_scope_mismatch?: boolean;
      correction_session_missing?: boolean;
    } = {},
  ) {
    const correctionMode = correctionFailure || correctionBudget;
    if (structuredSibling && correctionMode) throw new Error("unsupported combined failure fixture");
    const fixed = fixture();
    const stageId = correctionMode ? "implement" : "test";
    const expanded = expandCompiledRuntimeLifecycle({
      entry_stage: stageId,
      stages: fixed.manifest.stages,
    });
    const manifest: CompiledPipelineManifest = {
      ...fixed.manifest,
      entry_stage: expanded.entry_stage,
      stages: expanded.stages,
    };
    const runtimeDelivery = (
      id: string,
      effectKind: "daytona/create-sandbox@1" | "daytona/start-sandbox@1",
    ) => ({
      schema: EXECUTION_RECORD_SCHEMA,
      id,
      kind: "delivery" as const,
      pipeline_run_id: "run-sandbox-failure",
      effect_id: `effect-${id}`,
      idempotency_key: `key-${id}`,
      external_identity: "daytona:runtime",
      status: "confirmed" as const,
      payload_schema: "openthrottle.effect-delivery/v1",
      payload: { inline: {
        effect_kind: effectKind,
        provider: "daytona",
        result: { sandbox_id: "sandbox-poisoned", resource_state: "started" },
      } },
      created_at: NOW,
    });
    const deliveries = [
      runtimeDelivery("delivery-create", "daytona/create-sandbox@1"),
      runtimeDelivery("delivery-start", "daytona/start-sandbox@1"),
    ];
    const inputs = {
      task_prompt: "Run the exact command.",
      context: { records: deliveries, checkpoints: [] },
    };
    let currentAttempt = createPendingKernelAttempt({
      id: "attempt-command",
      pipeline_run_id: "run-sandbox-failure",
      scope: structuredSibling
        ? {
          kind: "loop_item",
          stage_id: "test",
          parent_attempt_id: "attempt-wave",
          loop_id: "units",
          item_id: "unit-a",
          item_index: 0,
        }
        : { kind: "stage", stage_id: stageId },
      input_subject: SOURCE,
      bundle: fixed.compilation.bundle.value,
      manifest,
      action_inputs: inputs,
    });
    const correctionCheckpoint: AttemptCheckpoint | null = correctionMode
      ? {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: "checkpoint-correction",
        pipeline_run_id: currentAttempt.pipeline_run_id,
        attempt_id: currentAttempt.id,
        request_hash: currentAttempt.request_hash,
        definition_bundle_hash: currentAttempt.definition_bundle_hash,
        input_subject: currentAttempt.input_subject,
        output_subject: IMPLEMENTED,
        native_session_id: "session-correction",
        payload_schema: "openthrottle.executor-checkpoint/v1",
        payload: { inline: { evidence: ["verified-diff"] } },
        captured_at: NOW,
      }
      : null;
    const pendingEvidencePointer: BlobPointer = {
      algorithm: "sha256",
      digest: "e".repeat(64),
      bytes: 100,
      encoding: "utf-8",
      media_type: "application/json",
      payload_schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    };
    currentAttempt = {
      ...currentAttempt,
      status: correctionMode ? "result_pending" : "running",
      version: 2,
      ...(correctionMode
        ? {
          output_subject: IMPLEMENTED,
          native_session_id: options.correction_session_missing ? null : "session-correction",
          result_correction_count: correctionBudget ? 2 : 1,
          result_correction_deadline: "2026-08-20T13:00:00.000Z",
          checkpoint_id: correctionCheckpoint!.id,
          pending_result: {
            candidate_hash: "d".repeat(64),
            diagnostics: [{ path: "/payload/summary", detail: "must be a string" }],
            invalid_result_evidence: pendingEvidencePointer,
          },
        }
        : {}),
      lease: {
        id: "lease-command",
        generation: 2,
        worker_id: "worker-command",
        purpose: correctionMode ? "result_correction" : "work",
        expires_at: "2026-08-20T12:10:00.000Z",
        started: true,
      },
    };
    const siblingAttempt = structuredSibling
      ? createPendingKernelAttempt({
        id: "attempt-command-sibling",
        pipeline_run_id: "run-sandbox-failure",
        scope: {
          kind: "loop_item",
          stage_id: "test",
          parent_attempt_id: "attempt-wave",
          loop_id: "units",
          item_id: "unit-b",
          item_index: 1,
        },
        input_subject: SIMPLIFIED,
        bundle: fixed.compilation.bundle.value,
        manifest,
        action_inputs: inputs,
      })
      : null;
    const frontierAttempts = [currentAttempt, ...(siblingAttempt === null ? [] : [siblingAttempt])];
    const dependencies = siblingAttempt === null ? undefined : {
      [frontierMemberKey(siblingAttempt)]: [frontierMemberKey(currentAttempt)],
    };
    let run: KernelRun = {
      schema: KERNEL_RUN_SCHEMA,
      id: "run-sandbox-failure",
      pipeline_id: manifest.pipeline_id,
      definition_bundle_hash: manifest.definition_bundle_hash,
      current_subject: SOURCE,
      status: "running",
      terminal_outcome: null,
      cursor: compileKernelCursor({
        stage_id: stageId,
        version: 2,
        attempts: frontierAttempts,
        dependencies,
      }),
      version: 2,
      work_retry_limit: 3,
      result_correction_limit: 2,
      active_attempt_versions: Object.fromEntries(frontierAttempts.map(({ id, version }) => [id, version])),
      active_effect_versions: {},
      checkpoint_ids: correctionCheckpoint === null
        ? {}
        : { [currentAttempt.id]: correctionCheckpoint.id },
    };
    const attempts = new Map(frontierAttempts.map((candidate) => [candidate.id, candidate]));
    const initialWorkAttempt = currentAttempt;
    const pendingEvidence = correctionMode
      ? createInvalidResultEvidenceRecord({
        attempt: currentAttempt,
        pointer: pendingEvidencePointer,
        created_at: NOW,
      })
      : null;
    const records = new Map<string, ExecutionRecord>([
      ...deliveries.map((record) => [record.id, record] as const),
      ...(pendingEvidence === null ? [] : [[pendingEvidence.id, pendingEvidence] as const]),
    ]);
    const checkpoints = new Map(
      correctionCheckpoint === null ? [] : [[correctionCheckpoint.id, correctionCheckpoint]],
    );
    let applied: AtomicTransitionBundle | null = null;
    const forensicsLookups: Array<{
      pipeline_run_id: string;
      attempt_id: string;
      work_retry_ordinal: number;
    }> = [];
    const store = {
      async loadExactReductionView(request: {
        attempt_id: string | null;
        record_ids: readonly string[];
        checkpoint_ids: readonly string[];
      }) {
        return {
          manifest,
          run,
          current_attempt: request.attempt_id === null ? null : attempts.get(request.attempt_id)!,
          records: new Map(request.record_ids.map((id) => [id, records.get(id)!])),
          checkpoints: new Map(request.checkpoint_ids.map((id) => [id, checkpoints.get(id)!])),
        };
      },
      async loadAttemptRequestInputs(request: { attempt_id: string }) {
        const requestedAttempt = attempts.get(request.attempt_id)!;
        return {
          task_prompt: inputs.task_prompt,
          context: {
            records: new Map(requestedAttempt.context_record_ids.map((id) => [id, records.get(id)!])),
            checkpoints: new Map(requestedAttempt.context_checkpoint_ids.map((id) => [
              id,
              checkpoints.get(id)!,
            ])),
          },
        };
      },
      async renewAttemptLease() { return currentAttempt.lease!; },
      async loadAttemptForensics(request: {
        pipeline_run_id: string;
        attempt_id: string;
        work_retry_ordinal: number;
      }) {
        forensicsLookups.push(request);
        if (repeatedForensicsSignature === null) return null;
        if (
          request.attempt_id !== initialWorkAttempt.id ||
          request.work_retry_ordinal !== initialWorkAttempt.work_retry_ordinal
        ) return null;
        const record = [...records.values()].find((candidate) =>
          candidate.kind === "decision" && candidate.reducer === "core/attempt-forensics@1");
        return record === undefined ? null : {
          record,
          payload: {
            schema: "openthrottle.attempt-forensics/v1",
            pipeline_run_id: run.id,
            attempt_id: initialWorkAttempt.id,
            request_hash: initialWorkAttempt.request_hash,
            definition_bundle_hash: initialWorkAttempt.definition_bundle_hash,
            lease_id: "lease-command",
            work_retry_ordinal: initialWorkAttempt.work_retry_ordinal,
            operational_signature: repeatedForensicsSignature,
            exit_code: 1,
            runner_stdout_tail: "",
            runner_stderr_tail: "silent exit",
            result_path_state: { state: "missing" },
            session_event_state: { state: "missing" },
            workspace_git_status: { state: "present", summary: "", detail: "" },
            observed_at: NOW,
          },
        };
      },
      async applyAtomicTransition(transition: AtomicTransitionBundle) {
        applied = transition;
        run = transition.run;
        for (const record of transition.append_records) {
          if (record.kind === "decision") {
            for (const inputId of record.input_record_ids) {
              if (!records.has(inputId)) {
                throw new Error(`DecisionRecord ${record.id} references unavailable input ${inputId}`);
              }
            }
          }
          records.set(record.id, record as never);
        }
        for (const write of transition.attempt_writes) {
          if (write.kind === "replace") {
            attempts.set(write.attempt.id, write.attempt);
            if (write.attempt.id === currentAttempt.id) currentAttempt = write.attempt;
          } else {
            const prior = attempts.get(write.attempt_id)!;
            attempts.set(write.attempt_id, {
              ...prior,
              status: write.status,
              version: write.next_version,
              lease: null,
            });
          }
        }
        return { disposition: "applied" as const, run_version: run.version };
      },
      async quarantineExhaustedAttemptRecovery() { return true; },
    };
    let workExecutionCount = 0;
    const runtime: KernelRuntimePort = {
      async executeWork() {
        workExecutionCount += 1;
        if (repeatedForensicsSignature !== null) {
          return {
            state: "work_failed",
            retryable: true,
            ...(options.recovered_sandbox_fatal && workExecutionCount === 2
              ? {
                sandbox_fatal: true,
                reason: "fresh sandbox exited with the same fatal signature",
              }
              : { reason: "action exited without a sealed result" }),
            forensics: {
              blob: {
                algorithm: "sha256",
                digest: "f".repeat(64),
                bytes: 100,
                encoding: "utf-8",
                media_type: "application/json",
                payload_schema: "openthrottle.attempt-forensics/v1",
              },
              operational_signature: repeatedForensicsSignature,
              observed_at: NOW,
            },
          };
        }
        return error === null
          ? { state: "work_failed", retryable: true, reason: "provider timeout" }
          : {
            state: "work_failed", retryable: true, sandbox_fatal: true,
            reason: error.message,
          };
      },
      async correctResult() {
        if (!correctionMode) throw new Error("not used");
        if (correctionBudget) {
          return {
            state: "result_pending",
            checkpoint: correctionCheckpoint!,
            candidate_hash: "a".repeat(64),
            diagnostics: [{ path: "/payload", detail: "still invalid" }],
            correction_deadline: "2026-08-20T13:00:00.000Z",
            invalid_result_evidence: {
              blob: {
                algorithm: "sha256",
                digest: "a".repeat(64),
                bytes: 101,
                encoding: "utf-8",
                media_type: "application/json",
                payload_schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
              },
              observed_at: NOW,
            },
          } as const;
        }
        return {
          state: "work_failed",
          retryable: false,
          sandbox_fatal: true,
          reason: "correction exited without a semantic result",
          forensics: {
            blob: {
              algorithm: "sha256",
              digest: "f".repeat(64),
              bytes: 100,
              encoding: "utf-8",
              media_type: "application/json",
              payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
            },
            operational_signature: "9".repeat(64),
            observed_at: NOW,
          },
        } as const;
      },
    };
    const coordinator = new OrdinaryKernelCoordinator({
      store: store as never,
      definition_bundles: { resolveExactDefinitionBundle: async () => fixed.compilation.bundle.value },
      runtime,
      runtime_sessions: {} as never,
      attempt_lease_duration_ms: 60_000,
      now: () => NOW,
    });
    const leased = {
      run_id: run.id,
      run_version: run.version,
      cursor_version: run.cursor.version,
      attempt: currentAttempt,
      lease: currentAttempt.lease!,
    };
    if (error?.message.includes(".part: create: open")) {
      await coordinator.terminalizeExhaustedRecovery(leased, error);
    } else {
      await coordinator.executeLeasedAttempt(leased);
    }
    if (repeatedForensicsSignature !== null) {
      if (options.fresh_sandbox_recovery) {
        const predecessorForensics = [...records.values()].find((candidate): candidate is DecisionRecord =>
          candidate.kind === "decision" && candidate.reducer === "core/attempt-forensics@1")!;
        const predecessor: KernelAttempt = {
          ...initialWorkAttempt,
          status: "failed",
          version: initialWorkAttempt.version + 1,
          lease: null,
        };
        const recovery = createPipelineDecisionRecord({
          attempt: predecessor,
          result: null,
          additional_input_records: [predecessorForensics],
          evaluated: {
            evaluator: sandboxRecoveryEvaluator(predecessor.id),
            outcome: "retryable_infrastructure_failure",
            reason: "sandbox_fatal_enospc: no space left on device",
          },
          created_at: NOW,
        });
        records.set(recovery.id, recovery);
        attempts.set(predecessor.id, predecessor);
        currentAttempt = createPendingKernelAttempt({
          id: "attempt-command-recovered",
          pipeline_run_id: predecessor.pipeline_run_id,
          scope: options.recovered_scope_mismatch
            ? {
              kind: "loop_item",
              stage_id: predecessor.scope.stage_id,
              parent_attempt_id: "attempt-wave",
              loop_id: "units",
              item_id: "unit-restored-sibling",
              item_index: 1,
            }
            : predecessor.scope,
          input_subject: predecessor.input_subject,
          bundle: fixed.compilation.bundle.value,
          manifest,
          action_inputs: {
            task_prompt: inputs.task_prompt,
            context: { records: [...deliveries, recovery], checkpoints: [] },
          },
        });
        currentAttempt = {
          ...currentAttempt,
          status: "running",
          version: 2,
          work_retry_ordinal: predecessor.work_retry_ordinal + 1,
          lease: {
            id: "lease-command-2",
            generation: 0,
            worker_id: "worker-command",
            purpose: "work",
            expires_at: "2026-08-20T12:11:00.000Z",
            started: true,
          },
        };
        run = {
          ...run,
          cursor: compileKernelCursor({
            stage_id: currentAttempt.scope.stage_id,
            version: run.cursor.version + 1,
            attempts: [currentAttempt],
          }),
          version: run.version + 1,
          active_attempt_versions: { [currentAttempt.id]: currentAttempt.version },
        };
      } else {
        currentAttempt = {
          ...currentAttempt,
          status: "running",
          lease: {
            id: "lease-command-2",
            generation: 0,
            worker_id: "worker-command",
            purpose: "work",
            expires_at: "2026-08-20T12:11:00.000Z",
            started: true,
          },
        };
      }
      attempts.set(currentAttempt.id, currentAttempt);
      await coordinator.executeLeasedAttempt({
        run_id: run.id,
        run_version: run.version,
        cursor_version: run.cursor.version,
        attempt: currentAttempt,
        lease: currentAttempt.lease!,
      });
    }
    return { transition: applied!, records, forensicsLookups };
  }

  it("routes command ENOSPC through runtime stop instead of same-sandbox retry", async () => {
    const { transition, records } = await sandboxFailureTransition(
      Object.assign(new Error("write failed: no space left on device"), { code: "ENOSPC" }),
    );
    expect(transition.run.cursor.stage_id).toBe(runtimeStopStageId("failed"));
    expect(transition.create_attempts).toEqual([
      expect.objectContaining({
        scope: { kind: "stage", stage_id: runtimeStopStageId("failed") },
        context_record_ids: expect.arrayContaining(["delivery-create", "delivery-start"]),
      }),
    ]);
    expect([...records.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "decision",
        reducer: expect.stringMatching(/^core\/sandbox-fatal-recovery@1:/),
      }),
    ]));
  });

  it("captures every active structured frontier member before sandbox recovery", async () => {
    const { transition } = await sandboxFailureTransition(
      Object.assign(new Error("write failed: no space left on device"), { code: "ENOSPC" }),
      true,
    );
    const frontierRecords = transition.append_records.filter((record) =>
      record.kind === "decision" && record.reducer.startsWith("core/sandbox-fatal-frontier@1:"));
    expect(frontierRecords).toHaveLength(2);
    expect(transition.attempt_writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "replace", attempt: expect.objectContaining({ status: "failed" }) }),
      expect.objectContaining({ kind: "terminal", attempt_id: "attempt-command-sibling", status: "failed" }),
    ]));
    expect(transition.create_attempts[0]?.context_record_ids).toEqual(expect.arrayContaining(
      frontierRecords.map(({ id }) => id),
    ));
  });

  it("keeps ordinary infrastructure failures on the same-sandbox retry ladder", async () => {
    const { transition } = await sandboxFailureTransition(null);
    expect(transition.transition_id).toMatch(/^retry-/);
    expect(transition.run.cursor.stage_id).toBe("test");
    expect(transition.attempt_writes).toEqual([
      expect.objectContaining({
        kind: "replace",
        attempt: expect.objectContaining({ work_retry_ordinal: 1, status: "pending" }),
      }),
    ]);
  });

  it("routes recovery-exhaustion fence ENOSPC through runtime stop instead of quarantine", async () => {
    const { transition } = await sandboxFailureTransition(
      new Error("lease-generation.part: create: open /var/lib/openthrottle/action-fences/lease-generation.part"),
    );
    expect(transition.run.cursor.stage_id).toBe(runtimeStopStageId("failed"));
    expect(transition.transition_id).toMatch(/^sandbox-fatal-recovery-/);
  });

  it("quarantines an exhausted recovery lease when terminal preparation is unreadable", async () => {
    const fixed = fixture();
    const manifest: CompiledPipelineManifest = {
      ...fixed.manifest,
      entry_stage: RUNTIME_PROVISION_STAGE_ID,
      stages: [{
        id: RUNTIME_PROVISION_STAGE_ID,
        kind: "effect",
        effect: "core/daytona-provision@1",
        on: { success: { terminal: "completed" } },
      }],
    };
    const attempt: KernelAttempt = {
      schema: KERNEL_ATTEMPT_SCHEMA,
      id: "attempt-poison",
      pipeline_run_id: "run-poison",
      scope: { kind: "stage", stage_id: RUNTIME_PROVISION_STAGE_ID },
      repository_authority: "inspect",
      request_hash: "a".repeat(64),
      definition_bundle_hash: manifest.definition_bundle_hash,
      input_subject: SOURCE,
      context_record_ids: [],
      context_checkpoint_ids: [],
      output_subject: null,
      native_session_id: null,
      status: "running",
      version: 4,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      result_correction_deadline: null,
      lease: {
        id: "lease-poison",
        generation: 2,
        worker_id: "worker-poison",
        purpose: "work",
        expires_at: "2026-08-20T12:05:00.000Z",
        started: true,
      },
      checkpoint_id: null,
      result_record_id: null,
      decision_record_id: null,
      pending_result: null,
    };
    let run: KernelRun = {
      schema: KERNEL_RUN_SCHEMA,
      id: "run-poison",
      pipeline_id: manifest.pipeline_id,
      definition_bundle_hash: manifest.definition_bundle_hash,
      current_subject: SOURCE,
      status: "running",
      terminal_outcome: null,
      cursor: compileKernelCursor({
        stage_id: RUNTIME_PROVISION_STAGE_ID,
        version: 4,
        attempts: [attempt],
      }),
      version: 4,
      work_retry_limit: 2,
      result_correction_limit: 2,
      active_attempt_versions: { [attempt.id]: attempt.version },
      active_effect_versions: {},
      checkpoint_ids: {},
    };
    let transition: AtomicTransitionBundle | null = null;
    let quarantineDiagnostic: unknown = null;
    let currentAttempt = attempt;
    const store = {
      async loadExactReductionView(input: { attempt_id: string | null }) {
        return {
          manifest,
          run,
          current_attempt: input.attempt_id === null ? null : currentAttempt,
          records: new Map(),
          checkpoints: new Map(),
        };
      },
      async loadAttemptRequestInputs() {
        throw new Error("sealed work request blob is unreadable");
      },
      async applyAtomicTransition(next: AtomicTransitionBundle) {
        transition = next;
        run = next.run;
        return { disposition: "applied" as const, run_version: run.version };
      },
      async quarantineExhaustedAttemptRecovery(input: { diagnostic: unknown }) {
        quarantineDiagnostic = input.diagnostic;
        return true;
      },
    };
    const coordinator = new OrdinaryKernelCoordinator({
      store: store as never,
      definition_bundles: {} as never,
      runtime: {} as never,
      runtime_sessions: {} as never,
      attempt_lease_duration_ms: 60_000,
      now: () => NOW,
    });
    const leased = {
      run_id: run.id,
      run_version: run.version,
      cursor_version: run.cursor.version,
      attempt,
      lease: attempt.lease!,
    };

    currentAttempt = {
      ...attempt,
      lease: { ...attempt.lease!, generation: 1 },
    };
    await expect(coordinator.terminalizeExhaustedRecovery({
      ...leased,
      attempt: currentAttempt,
      lease: currentAttempt.lease!,
    }, new Error("first recovery failed"))).resolves.toBeNull();
    expect(transition).toBeNull();
    currentAttempt = attempt;

    await expect(coordinator.terminalizeExhaustedRecovery(
      leased,
      new Error("runtime reconciliation failed"),
    )).resolves.toMatchObject({ disposition: "terminal", run_status: "needs_human" });
    expect(transition).toBeNull();
    expect(quarantineDiagnostic).toEqual(expect.objectContaining({
      kind: "decision",
      reducer: "core/executor-recovery-quarantine@1",
      payload: { inline: expect.objectContaining({
        outcome: "needs_human",
        reason: expect.stringContaining("terminal_preparation_failed: sealed work request blob is unreadable"),
      }) },
    }));
  });

  it.each([
    ["stop", "canceled"],
    ["supersede", "superseded"],
  ] as const)(
    "uses one deterministic active Attempt to %s an ordinary or structured run",
    async (action, terminalOutcome) => {
      const fixed = fixture();
      const manifest: CompiledPipelineManifest = {
        ...fixed.manifest,
        entry_stage: RUNTIME_PROVISION_STAGE_ID,
        stages: [{
          id: RUNTIME_PROVISION_STAGE_ID,
          kind: "effect",
          effect: "core/daytona-provision@1",
          on: { success: { to: "implement" } },
        }, ...fixed.manifest.stages],
      };
      const activeAttempt = (id: string, index: number): KernelAttempt => ({
        schema: KERNEL_ATTEMPT_SCHEMA,
        id,
        pipeline_run_id: "run-control",
        scope: {
          kind: "loop_item",
          stage_id: RUNTIME_PROVISION_STAGE_ID,
          parent_attempt_id: "parent",
          loop_id: "units",
          item_id: id,
          item_index: index,
        },
        repository_authority: "inspect",
        request_hash: id === "attempt-a" ? "a".repeat(64) : "b".repeat(64),
        definition_bundle_hash: manifest.definition_bundle_hash,
        input_subject: SOURCE,
        context_record_ids: [],
        context_checkpoint_ids: [],
        output_subject: null,
        native_session_id: null,
        status: "pending",
        version: 0,
        work_retry_ordinal: 0,
        result_correction_count: 0,
        result_correction_deadline: null,
        lease: null,
        checkpoint_id: null,
        result_record_id: null,
        decision_record_id: null,
        pending_result: null,
      });
      const attempts = new Map([
        ["attempt-z", activeAttempt("attempt-z", 1)],
        ["attempt-a", activeAttempt("attempt-a", 0)],
      ]);
      let run: KernelRun = {
        schema: KERNEL_RUN_SCHEMA,
        id: "run-control",
        pipeline_id: manifest.pipeline_id,
        definition_bundle_hash: manifest.definition_bundle_hash,
        current_subject: SOURCE,
        status: "pending",
        terminal_outcome: null,
        cursor: compileKernelCursor({
          stage_id: RUNTIME_PROVISION_STAGE_ID,
          version: 0,
          attempts: [...attempts.values()],
        }),
        version: 0,
        work_retry_limit: 2,
        result_correction_limit: 2,
        active_attempt_versions: { "attempt-z": 0, "attempt-a": 0 },
        active_effect_versions: {},
        checkpoint_ids: {},
      };
      let applied: AtomicTransitionBundle | null = null;
      const store = {
        async loadExactReductionView(input: { attempt_id: string | null }) {
          return {
            manifest,
            run,
            current_attempt: input.attempt_id === null ? null : attempts.get(input.attempt_id) ?? null,
            records: new Map(),
            checkpoints: new Map(),
          };
        },
        async loadAttemptRequestInputs() {
          return {
            task_prompt: "Stop the exact active run.",
            context: { records: new Map(), checkpoints: new Map() },
          };
        },
        async applyAtomicTransition(transition: AtomicTransitionBundle) {
          applied = transition;
          run = transition.run;
          return { disposition: "applied" as const, run_version: run.version };
        },
      };
      const coordinator = new OrdinaryKernelCoordinator({
        store: store as never,
        definition_bundles: {} as never,
        runtime: {} as never,
        runtime_sessions: {} as never,
        attempt_lease_duration_ms: 60_000,
        now: () => NOW,
      });

      await expect(coordinator.requestRunControl({
        pipeline_run_id: "run-control",
        action,
        reason: "operator request",
      })).resolves.toMatchObject({
        disposition: "consumed",
        run: { status: terminalOutcome, terminal_outcome: terminalOutcome },
      });
      expect(applied).not.toBeNull();
      expect(applied!.attempt_writes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "replace",
          attempt: expect.objectContaining({ id: "attempt-a", status: terminalOutcome }),
        }),
        expect.objectContaining({
          kind: "terminal",
          attempt_id: "attempt-z",
          status: terminalOutcome,
        }),
      ]));
      await expect(coordinator.requestRunControl({
        pipeline_run_id: "run-control",
        action,
        reason: "operator request",
      })).resolves.toMatchObject({ disposition: "stale", run: { status: terminalOutcome } });
    },
  );

  it("regenerates the exact prompt, context, bundle, and request hash after restart", async () => {
    const initial = await setup();
    let active = initial;
    try {
      expect((await execute(active.coordinator, 1)).disposition).toBe("settled");
      const scheduled = active.db.prepare(`
        SELECT id, request_hash, context_record_ids_json, context_checkpoint_ids_json
        FROM attempts WHERE pipeline_run_id = ? AND stage_id = 'review'
      `).get(active.run_id) as {
        id: string;
        request_hash: string;
        context_record_ids_json: string;
        context_checkpoint_ids_json: string;
      };
      expect(JSON.parse(scheduled.context_record_ids_json)).toHaveLength(2);
      expect(JSON.parse(scheduled.context_checkpoint_ids_json)).toEqual([
        "checkpoint-attempt-initial",
      ]);
      expect(() => active.db.prepare(`
        UPDATE work_items SET request_inline_json = ? WHERE id = 'work-1'
      `).run(JSON.stringify({
        schema: "openthrottle.kernel-work-request/v1",
        task_prompt: "tampered",
      }))).toThrow(/immutable work request/);

      active.db.close();
      active = active.restart();
      const view = await active.store.loadExactReductionView({
        pipeline_run_id: active.run_id,
        attempt_id: scheduled.id,
        record_ids: [],
        checkpoint_ids: [],
      });
      const attempt = view.current_attempt!;
      const persisted = await active.store.loadAttemptRequestInputs({
        pipeline_run_id: active.run_id,
        attempt_id: attempt.id,
      });
      const bundle = await new VerifiedKernelDefinitionBundleResolver({
        bytes: active.store,
        trusted_platform_definitions: fixture().trusted,
      }).resolveExactDefinitionBundle({
        pipeline_run_id: active.run_id,
        definition_bundle_hash: attempt.definition_bundle_hash,
      });
      const context = exactKernelContext(persisted.context);
      expect(persisted.task_prompt).toBe(
        "Implement the approved plan and preserve its verified behavior.",
      );
      expect(context.records.map(({ kind }) => kind).sort()).toEqual(["decision", "result"]);
      expect(context.checkpoints.map(({ id }) => id)).toEqual(["checkpoint-attempt-initial"]);
      expect(kernelAttemptRequestHash({
        pipeline_run_id: active.run_id,
        attempt_id: attempt.id,
        input_subject: attempt.input_subject,
        definition_bundle_hash: attempt.definition_bundle_hash,
        repository_authority: attempt.repository_authority,
        bundle,
        manifest: view.manifest,
        scope: attempt.scope,
        action_inputs: { task_prompt: persisted.task_prompt, context },
      })).toBe(scheduled.request_hash);
      expect(() => buildKernelWorkActionRequest({
        attempt: {
          ...attempt,
          status: "running",
          lease: {
            id: "lease-hash-proof",
            generation: 0,
            worker_id: "worker-hash-proof",
            purpose: "work",
            expires_at: "2026-08-20T13:00:00.000Z",
            started: true,
          },
        },
        bundle,
        manifest: view.manifest,
        action_inputs: { task_prompt: "changed after admission", context },
      })).toThrow(/request hash does not match/);

      expect((await execute(active.coordinator, 2)).disposition).toBe("settled");
      expect(active.runtime.workRequests[1]).toMatchObject({
        attempt_id: scheduled.id,
        request_hash: scheduled.request_hash,
      });
    } finally {
      if (active.db.open) active.db.close();
    }
  });

  it.each([
    ["work_complete", "work-complete-"],
    ["recorded", "record-"],
  ] as const)(
    "continues idempotently after a restart from %s without rerunning work",
    async (expectedStatus, transitionPrefix) => {
      const runtime = new RuntimeFixture();
      let active = await setup(runtime);
      try {
        const apply = active.store.applyAtomicTransition.bind(active.store);
        let crashPending = true;
        active.store.applyAtomicTransition = async (transition: AtomicTransitionBundle) => {
          const result = await apply(transition);
          if (crashPending && transition.transition_id.startsWith(transitionPrefix)) {
            crashPending = false;
            throw new Error(`injected crash after ${expectedStatus}`);
          }
          return result;
        };

        await expect(execute(active.coordinator, 1)).rejects.toThrow(
          `injected crash after ${expectedStatus}`,
        );
        expect(active.db.prepare(`
          SELECT status, lease_id, checkpoint_id, result_record_id
          FROM attempts WHERE id = 'attempt-initial'
        `).get()).toMatchObject({
          status: expectedStatus,
          lease_id: null,
          checkpoint_id: "checkpoint-attempt-initial",
          result_record_id: expect.stringMatching(/^result-/),
        });
        expect(runtime.workRequests).toHaveLength(1);

        active.db.close();
        active = active.restart();
        await expect(active.coordinator.resumeReadyAttempt()).resolves.toMatchObject({
          disposition: "settled",
          attempt_id: "attempt-initial",
          next_stage_id: "review",
        });
        expect(runtime.workRequests).toHaveLength(1);
        expect(active.db.prepare(`
          SELECT status, result_record_id, decision_record_id
          FROM attempts WHERE id = 'attempt-initial'
        `).get()).toMatchObject({
          status: "settled",
          result_record_id: expect.stringMatching(/^result-/),
          decision_record_id: expect.stringMatching(/^decision-/),
        });
      } finally {
        if (active.db.open) active.db.close();
      }
    },
  );

  it("paginates past 100 malformed continuations without rerunning completed ordinary work", async () => {
    const runtime = new RuntimeFixture();
    const active = await setup(runtime);
    try {
      const apply = active.store.applyAtomicTransition.bind(active.store);
      let crashPending = true;
      active.store.applyAtomicTransition = async (transition: AtomicTransitionBundle) => {
        const result = await apply(transition);
        if (crashPending && transition.transition_id.startsWith("work-complete-")) {
          crashPending = false;
          throw new Error("injected crash after ordinary work completion");
        }
        return result;
      };
      await expect(execute(active.coordinator, 1))
        .rejects.toThrow("injected crash after ordinary work completion");
      active.store.applyAtomicTransition = apply;

      const load = active.store.loadExactReductionView.bind(active.store);
      active.store.loadExactReductionView = async (request) => {
        if (request.pipeline_run_id.startsWith("run-corrupt-")) {
          throw new Error("corrupt ordinary continuation");
        }
        return load(request);
      };
      const list = active.store.listReadyOrdinaryAttempts.bind(active.store);
      const malformed = Array.from({ length: 125 }, (_, index) => ({
        updated_at: "2026-08-20T11:59:00.000Z",
        pipeline_run_id: `run-corrupt-${String(index).padStart(3, "0")}`,
        attempt_id: `attempt-corrupt-${String(index).padStart(3, "0")}`,
      }));
      active.store.listReadyOrdinaryAttempts = async (input: {
        limit: number;
        after?: { updated_at: string; pipeline_run_id: string; attempt_id: string };
      }) => {
        const start = input.after === undefined
          ? 0
          : malformed.findIndex((candidate) =>
            candidate.updated_at === input.after!.updated_at &&
            candidate.pipeline_run_id === input.after!.pipeline_run_id &&
            candidate.attempt_id === input.after!.attempt_id) + 1;
        if (input.after !== undefined && start === 0) return list(input);
        const page = malformed.slice(start, start + input.limit);
        if (page.length === input.limit) return page;
        const after = page.at(-1) ?? input.after;
        const durable = await list({
          limit: input.limit - page.length,
          ...(after === undefined ? {} : { after }),
        });
        return [...page, ...durable];
      };

      await expect(active.coordinator.resumeReadyAttempt()).resolves.toMatchObject({
        disposition: "settled",
        attempt_id: "attempt-initial",
        next_stage_id: "review",
      });
      expect(runtime.workRequests).toHaveLength(1);
    } finally {
      active.db.close();
    }
  });

  it("traverses core/implement to the publication boundary using only shared kernel primitives", async () => {
    const test = await setup();
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
        expect((await execute(test.coordinator, ordinal)).disposition).toBe("settled");
      }
      const aggregate = await test.store.loadExactReductionView({
        pipeline_run_id: test.run_id,
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      });
      expect(aggregate.run).toMatchObject({
        cursor: expect.objectContaining({ stage_id: "publish" }),
        current_subject: SIMPLIFIED,
        status: "running",
      });
      expect(Object.keys(aggregate.run.active_attempt_versions)).toHaveLength(1);
      expect(aggregate.run.active_effect_versions).toEqual({});
      expect(test.runtime.workRequests.map(({ stage_id, repository_authority }) => [
        stage_id, repository_authority,
      ])).toEqual([
        ["implement", "edit"],
        ["review", "inspect"],
        ["simplify", "edit"],
        ["post_simplify_review", "inspect"],
        ["test", "inspect"],
        ["lint", "inspect"],
        ["build", "inspect"],
      ]);

      const firstReview = test.runtime.workRequests.find(({ stage_id }) => stage_id === "review")!;
      expect(firstReview.change_boundary).toEqual({
        checkpoint_id: "checkpoint-attempt-initial",
        input_subject: SOURCE,
        output_subject: IMPLEMENTED,
      });
      expect(firstReview.context.checkpoints[0]).toMatchObject({
        input_subject: SOURCE,
        output_subject: IMPLEMENTED,
        payload: { inline: { evidence: ["verified-diff"] } },
      });
      expect(firstReview.action.kind).toBe("agent");
      if (firstReview.action.kind === "agent") {
        expect(firstReview.action.definition_entries.map(({ definition_id }) => definition_id))
          .toEqual(["core/reviewer", "core/review-change", "core/review-result"]);
        expect(firstReview.action.definition_entries.some(({ definition_id }) =>
          definition_id === "core/implement-plan")).toBe(false);
      }

      const results = test.db.prepare(`
        SELECT inline_payload FROM records WHERE kind = 'result' ORDER BY sequence
      `).all() as Array<{ inline_payload: string }>;
      expect(JSON.parse(results[0]!.inline_payload)).toMatchObject({
        outcome: "success",
        payload: { summary: "implemented\ntested" },
      });
      expect(test.db.prepare("SELECT COUNT(*) AS count FROM attempts").get()).toEqual({ count: 8 });
      expect(test.db.prepare("SELECT COUNT(*) AS count FROM effects").get()).toEqual({ count: 0 });
    } finally {
      test.db.close();
    }
  });

  it("atomically retains malformed-result evidence when same-session correction succeeds", async () => {
    const runtime = new RuntimeFixture();
    runtime.pendingOnce = true;
    const test = await setup(runtime);
    try {
      const transitions: AtomicTransitionBundle[] = [];
      const applyAtomicTransition = test.store.applyAtomicTransition.bind(test.store);
      test.store.applyAtomicTransition = async (transition) => {
        transitions.push(transition);
        return applyAtomicTransition(transition);
      };
      expect((await execute(test.coordinator, 1)).disposition).toBe("result_pending");
      expect((await execute(test.coordinator, 2)).disposition).toBe("settled");
      expect(runtime.workRequests).toHaveLength(1);
      expect(runtime.correctionRequests).toHaveLength(1);
      const work = runtime.workRequests[0]!;
      expect(runtime.correctionRequests[0]).toMatchObject({
        engine: "codex",
        pipeline_run_id: work.pipeline_run_id,
        attempt_id: work.attempt_id,
        request_hash: work.request_hash,
        definition_bundle_hash: work.definition_bundle_hash,
        input_subject: work.input_subject,
        checkpoint_id: "checkpoint-attempt-initial",
        native_session_id: `session-${work.attempt_id}`,
        locked_subject: IMPLEMENTED,
        completed_work_authority: "edit",
        repository_authority: "inspect",
        tools: ["ot-result"],
        mcp: false,
        provider_access: false,
      });
      const aggregate = await test.store.loadExactReductionView({
        pipeline_run_id: test.run_id,
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      });
      expect(aggregate.run.cursor.stage_id).toBe("review");
      expect(test.db.prepare(`
        SELECT COUNT(*) AS count FROM attempts WHERE stage_id = 'implement'
      `).get()).toEqual({ count: 1 });
      const pending = transitions.find(({ transition_id }) =>
        transition_id.startsWith("result-pending-"));
      const settlement = transitions.find(({ transition_id }) =>
        transition_id.startsWith("correct-and-settle-"));
      expect(pending).toBeDefined();
      expect(settlement).toBeDefined();
      const invalidEvidence = pending!.append_records.find((record): record is DecisionRecord =>
        record.kind === "decision" && record.reducer === "core/invalid-result-evidence@1")!;
      const correctedResult = settlement!.append_records.find((record) => record.kind === "result")!;
      const decision = settlement!.append_records.find((record): record is DecisionRecord =>
        record.kind === "decision")!;
      expect(pending!.append_records).toEqual([invalidEvidence]);
      expect(settlement!.append_records).toHaveLength(2);
      expect(settlement!.append_records).not.toContainEqual(invalidEvidence);
      expect(decision.input_record_ids).toEqual(expect.arrayContaining([
        invalidEvidence.id,
        correctedResult.id,
      ]));
      expect(test.db.prepare(`
        SELECT COUNT(*) AS count FROM records
        WHERE reducer = 'core/invalid-result-evidence@1'
      `).get()).toEqual({ count: 1 });
    } finally {
      test.db.close();
    }
  });

  it("preserves pending invalid-result evidence beside sandbox-fatal correction forensics", async () => {
    const { transition, records } = await sandboxFailureTransition(null, false, null, true);
    const invalidEvidence = [...records.values()].find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/invalid-result-evidence@1")!;
    const forensics = [...records.values()].find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/attempt-forensics@1")!;
    const decision = transition.append_records.find((record): record is DecisionRecord =>
      record.kind === "decision" && record.input_record_ids.includes(invalidEvidence.id) &&
      record.input_record_ids.includes(forensics.id))!;
    expect(transition.append_records).toHaveLength(2);
    expect(transition.append_records).not.toContainEqual(invalidEvidence);
    expect(invalidEvidence).toBeDefined();
    expect(forensics).toBeDefined();
    expect(decision.input_record_ids).toEqual(expect.arrayContaining([
      invalidEvidence.id,
      forensics.id,
    ]));
    expect(transition.transition_id).toMatch(/^needs_human-/);
    expect(transition.run.cursor.stage_id).toBe(runtimeStopStageId("needs_human"));
    expect(transition.create_attempts).toEqual([
      expect.objectContaining({
        scope: { kind: "stage", stage_id: runtimeStopStageId("needs_human") },
      }),
    ]);
    expect(decision.reducer).toBe("core/operational-outcome@1");
    expect([...records.values()].filter((record) => sandboxRecoveryAttemptId(record) !== null))
      .toEqual([]);
  });

  it("cites pending evidence when exact correction-session continuity is lost", async () => {
    const { transition, records } = await sandboxFailureTransition(
      null,
      false,
      null,
      true,
      false,
      { correction_session_missing: true },
    );
    const invalidEvidence = [...records.values()].find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/invalid-result-evidence@1")!;
    const decision = transition.append_records.find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/operational-outcome@1")!;

    expect(transition.transition_id).toMatch(/^needs_human-/);
    expect(transition.run.cursor.stage_id).toBe(runtimeStopStageId("needs_human"));
    expect(decision.input_record_ids).toContain(invalidEvidence.id);
    expect([...records.values()].filter((record) => sandboxRecoveryAttemptId(record) !== null))
      .toEqual([]);
  });

  it("persists silent-exit forensics and aborts an identical consecutive retry signature", async () => {
    const signature = "9".repeat(64);
    const { records } = await sandboxFailureTransition(
      null,
      false,
      signature,
    );
    const forensicRecords = [...records.values()].filter((record) =>
      record.kind === "decision" && record.reducer === "core/attempt-forensics@1");
    expect(forensicRecords).toHaveLength(2);
    expect(forensicRecords.every((record) =>
      record.payload_schema === "openthrottle.attempt-forensics/v1" && "blob" in record.payload
    )).toBe(true);
    const terminal = [...records.values()].find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/operational-outcome@1");
    expect(terminal).toBeDefined();
    expect(terminal?.input_record_ids).toEqual(expect.arrayContaining(
      forensicRecords.map(({ id }) => id),
    ));
    expect(terminal?.payload).toMatchObject({
      inline: {
        reason: expect.stringContaining("consecutive_identical_operational_failure"),
      },
    });
  });

  it("suppresses an identical signature across an exact fresh-sandbox Attempt replacement", async () => {
    const signature = "8".repeat(64);
    const { transition, records, forensicsLookups } = await sandboxFailureTransition(
      null,
      false,
      signature,
      false,
      false,
      { fresh_sandbox_recovery: true },
    );
    const terminal = [...records.values()].find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/operational-outcome@1");

    expect(forensicsLookups.at(-1)).toMatchObject({
      attempt_id: "attempt-command",
      work_retry_ordinal: 0,
    });
    expect(transition.transition_id).toMatch(/^failed-/);
    expect(terminal?.payload).toMatchObject({
      inline: {
        reason: expect.stringContaining("consecutive_identical_operational_failure"),
      },
    });
  });

  it("terminalizes an identical sandbox-fatal signature after fresh-sandbox replacement", async () => {
    const { transition, records } = await sandboxFailureTransition(
      null,
      false,
      "6".repeat(64),
      false,
      false,
      { fresh_sandbox_recovery: true, recovered_sandbox_fatal: true },
    );
    const forensics = [...records.values()].filter((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/attempt-forensics@1");
    const terminal = transition.append_records.find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/operational-outcome@1")!;

    expect(transition.transition_id).toMatch(/^failed-/);
    expect(transition.run.cursor.stage_id).toBe(runtimeStopStageId("failed"));
    expect(transition.append_records.filter((record) => sandboxRecoveryAttemptId(record) !== null))
      .toEqual([]);
    expect(forensics).toHaveLength(2);
    expect(terminal.input_record_ids).toEqual(expect.arrayContaining(
      forensics.map(({ id }) => id),
    ));
  });

  it("does not let a restored sibling consume the recovery trigger Attempt's forensics", async () => {
    const { transition, forensicsLookups } = await sandboxFailureTransition(
      null,
      false,
      "7".repeat(64),
      false,
      false,
      { fresh_sandbox_recovery: true, recovered_scope_mismatch: true },
    );

    expect(forensicsLookups.at(-1)).toMatchObject({
      attempt_id: "attempt-command-recovered",
      work_retry_ordinal: 0,
    });
    expect(transition.transition_id).toMatch(/^retry-/);
  });

  it("retains the latest correction evidence pointer in the pending JSON envelope", async () => {
    const runtime = new RuntimeFixture();
    runtime.pendingOnce = true;
    const test = await setup(runtime);
    const initialAttempt = (await test.store.loadExactReductionView({
      pipeline_run_id: test.run_id,
      attempt_id: "attempt-initial",
      record_ids: [],
      checkpoint_ids: [],
    })).current_attempt!;
    const invalidEvidence = (phase: "work" | "result_correction", marker: string) =>
      putInvalidResultEvidence(test.blobs, initialAttempt, phase, marker);
    runtime.invalidResultEvidence = { blob: invalidEvidence("work", "d"), observed_at: NOW };
    const correctionEvidence = invalidEvidence("result_correction", "e");
    runtime.correctionOutcome = async (request) => ({
      state: "result_pending",
      checkpoint: runtime.lastCheckpoint!,
      candidate_hash: "e".repeat(64),
      diagnostics: [{ path: "result_candidate.outcome", detail: "is not admitted" }],
      correction_deadline: request.correction_deadline,
      invalid_result_evidence: { blob: correctionEvidence, observed_at: NOW },
    });
    try {
      expect((await execute(test.coordinator, 1)).disposition).toBe("result_pending");
      expect((await execute(test.coordinator, 2)).disposition).toBe("result_pending");
      const persisted = test.db.prepare(`
        SELECT pending_diagnostics_json FROM attempts WHERE id = 'attempt-initial'
      `).get() as { pending_diagnostics_json: string };
      expect(JSON.parse(persisted.pending_diagnostics_json)).toEqual({
        schema: "openthrottle.pending-result-diagnostics/v1",
        diagnostics: [{ path: "result_candidate.outcome", detail: "is not admitted" }],
        invalid_result_evidence: correctionEvidence,
      });
      expect(test.db.prepare(`
        SELECT blob_digest FROM records
        WHERE reducer = 'core/invalid-result-evidence@1'
        ORDER BY sequence
      `).all()).toEqual([
        { blob_digest: runtime.invalidResultEvidence.blob.digest },
        { blob_digest: correctionEvidence.digest },
      ]);
    } finally {
      test.db.close();
    }
  });

  it("cites the direct invalid-result evidence that exhausts the correction budget", async () => {
    const { transition, records } = await sandboxFailureTransition(
      null,
      false,
      null,
      false,
      true,
    );
    const directEvidence = transition.append_records.find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/invalid-result-evidence@1")!;
    const decision = transition.append_records.find((record): record is DecisionRecord =>
      record.kind === "decision" && record.reducer === "core/operational-outcome@1")!;
    expect(directEvidence).toMatchObject({ payload: { blob: { digest: "a".repeat(64) } } });
    expect(decision.input_record_ids).toContain(directEvidence.id);
    expect(transition.create_attempts[0]!.context_record_ids).toContain(directEvidence.id);
    expect([...records.values()].filter((record) =>
      record.kind === "decision" && record.reducer === "core/invalid-result-evidence@1"))
      .toHaveLength(2);
  });

  it("rejects a stale work timeout after recovery and reconciles the same sealed request", async () => {
    const runtime = new RuntimeFixture();
    const test = await setup(runtime);
    let recovered: Awaited<ReturnType<SqliteKernelStore["recoverExpiredAttemptLeases"]>>[number] | undefined;
    runtime.workOutcome = async () => {
      [recovered] = await test.store.recoverExpiredAttemptLeases({
        observed_at: "2026-08-20T12:06:00.000Z",
        expires_at: "2026-08-20T12:11:00.000Z",
        limit: 1,
      });
      return { state: "work_failed", retryable: true, reason: "provider timeout" };
    };
    try {
      await expect(execute(test.coordinator, 1)).rejects.toThrow(/claim generation/);
      expect(recovered?.lease).toMatchObject({ generation: 1, id: "lease-1", started: true });
      expect(test.db.prepare(`
        SELECT status, work_retry_ordinal, lease_id, lease_generation, native_session_id
        FROM attempts WHERE id = 'attempt-initial'
      `).get()).toEqual({
        status: "running",
        work_retry_ordinal: 0,
        lease_id: "lease-1",
        lease_generation: 1,
        native_session_id: "session-attempt-initial",
      });

      runtime.workOutcome = null;
      await expect(test.coordinator.executeLeasedAttempt(recovered!))
        .resolves.toMatchObject({ disposition: "settled" });
      expect(runtime.workRequests).toHaveLength(2);
      expect(runtime.workRequests[1]).toEqual(runtime.workRequests[0]);
      expect(runtime.workRequests[0]).not.toHaveProperty("lease_generation");
    } finally {
      test.db.close();
    }
  });

  it("rejects a stale correction timeout after recovery instead of escalating needs-human", async () => {
    const runtime = new RuntimeFixture();
    runtime.pendingOnce = true;
    const test = await setup(runtime);
    let recovered: Awaited<ReturnType<SqliteKernelStore["recoverExpiredAttemptLeases"]>>[number] | undefined;
    try {
      expect((await execute(test.coordinator, 1)).disposition).toBe("result_pending");
      runtime.correctionOutcome = async () => {
        [recovered] = await test.store.recoverExpiredAttemptLeases({
          observed_at: "2026-08-20T12:06:00.000Z",
          expires_at: "2026-08-20T12:11:00.000Z",
          limit: 1,
        });
        return {
          state: "needs_human",
          reason: "correction timed out",
          checkpoint: null,
          candidate_hash: null,
          diagnostics: [],
        };
      };

      await expect(execute(test.coordinator, 2)).rejects.toThrow(/claim generation/);
      expect(test.db.prepare(`
        SELECT status, result_correction_count, lease_id, lease_generation
        FROM attempts WHERE id = 'attempt-initial'
      `).get()).toEqual({
        status: "result_pending",
        result_correction_count: 1,
        lease_id: "lease-2",
        lease_generation: 1,
      });

      runtime.correctionOutcome = null;
      await expect(test.coordinator.executeLeasedAttempt(recovered!))
        .resolves.toMatchObject({ disposition: "settled" });
      expect(runtime.correctionRequests).toHaveLength(2);
      expect(runtime.correctionRequests[1]).toEqual(runtime.correctionRequests[0]);
      expect(runtime.correctionRequests[0]).not.toHaveProperty("lease_generation");
    } finally {
      test.db.close();
    }
  });

  it("turns a blocking inspect-only review into one separately fenced edit repair", async () => {
    const runtime = new RuntimeFixture();
    runtime.blockingReview = true;
    const test = await setup(runtime);
    try {
      await execute(test.coordinator, 1);
      await execute(test.coordinator, 2);
      const aggregate = await test.store.loadExactReductionView({
        pipeline_run_id: test.run_id,
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      });
      expect(aggregate.run).toMatchObject({
        cursor: expect.objectContaining({ stage_id: "repair" }),
        current_subject: IMPLEMENTED,
      });
      const repair = test.db.prepare(`
        SELECT id, repository_authority, input_subject, native_session_id,
          context_record_ids_json, context_checkpoint_ids_json
        FROM attempts WHERE stage_id = 'repair'
      `).get() as {
        id: string;
        repository_authority: string;
        input_subject: string;
        native_session_id: string | null;
        context_record_ids_json: string;
        context_checkpoint_ids_json: string;
      };
      const reviewAttempt = test.db.prepare(`
        SELECT id, native_session_id, result_record_id, decision_record_id
        FROM attempts WHERE stage_id = 'review'
      `).get() as {
        id: string;
        native_session_id: string;
        result_record_id: string;
        decision_record_id: string;
      };
      expect(repair).toMatchObject({
        repository_authority: "edit",
        input_subject: IMPLEMENTED,
        native_session_id: null,
        context_checkpoint_ids_json: '["checkpoint-attempt-initial"]',
      });
      expect(repair.id).not.toBe(reviewAttempt.id);
      expect(JSON.parse(repair.context_record_ids_json)).toEqual([
        reviewAttempt.decision_record_id,
        reviewAttempt.result_record_id,
      ].sort());
      const review = test.runtime.workRequests[1]!;
      expect(review.repository_authority).toBe("inspect");
      expect(review.change_boundary?.output_subject).toBe(IMPLEMENTED);

      expect((await execute(test.coordinator, 3)).disposition).toBe("settled");
      const repairRequest = test.runtime.workRequests[2]!;
      expect(repairRequest).toMatchObject({
        attempt_id: repair.id,
        repository_authority: "edit",
        input_subject: IMPLEMENTED,
      });
      expect(repairRequest.action.kind).toBe("agent");
      if (repairRequest.action.kind === "agent") {
        expect(repairRequest.action).toMatchObject({
          skill_ids: ["core/repair-unit"],
          entry_skill: "core/repair-unit",
        });
        expect(repairRequest.action.definition_entries.map(({ definition_id }) => definition_id))
          .toEqual(["core/ordinary-worker", "core/repair-unit", "core/action-result"]);
      }
      expect(repairRequest.context.records.map(({ id }) => id)).toEqual([
        reviewAttempt.decision_record_id,
        reviewAttempt.result_record_id,
      ].sort());
      expect(repairRequest.context.checkpoints.map(({ id }) => id))
        .toEqual(["checkpoint-attempt-initial"]);
      const boundRepair = test.db.prepare(`
        SELECT native_session_id FROM attempts WHERE id = ?
      `).get(repair.id) as { native_session_id: string };
      expect(boundRepair.native_session_id).toBe(`session-${repair.id}`);
      expect(boundRepair.native_session_id).not.toBe(reviewAttempt.native_session_id);
    } finally {
      test.db.close();
    }
  });

  it("resumes a recorded no-op repair with its prior cumulative checkpoint", async () => {
    const runtime = new RuntimeFixture();
    runtime.blockingReview = true;
    runtime.identityOutputStages.add("repair");
    let active = await setup(runtime);
    try {
      await execute(active.coordinator, 1);
      await execute(active.coordinator, 2);
      const repair = active.db.prepare(`
        SELECT id FROM attempts WHERE stage_id = 'repair'
      `).get() as { id: string };

      const apply = active.store.applyAtomicTransition.bind(active.store);
      let crashPending = true;
      active.store.applyAtomicTransition = async (transition: AtomicTransitionBundle) => {
        const result = await apply(transition);
        if (crashPending && transition.transition_id.startsWith("record-")) {
          crashPending = false;
          throw new Error("injected crash after no-op repair record");
        }
        return result;
      };

      await expect(execute(active.coordinator, 3))
        .rejects.toThrow("injected crash after no-op repair record");
      expect(active.db.prepare(`
        SELECT status, input_subject, output_subject, checkpoint_id, result_record_id, lease_id
        FROM attempts WHERE id = ?
      `).get(repair.id)).toMatchObject({
        status: "recorded",
        input_subject: IMPLEMENTED,
        output_subject: IMPLEMENTED,
        checkpoint_id: `checkpoint-${repair.id}`,
        result_record_id: expect.stringMatching(/^result-/),
        lease_id: null,
      });

      active.db.close();
      active = active.restart();
      await expect(active.coordinator.resumeReadyAttempt()).resolves.toMatchObject({
        disposition: "settled",
        attempt_id: repair.id,
        next_stage_id: "review",
      });

      const successor = active.db.prepare(`
        SELECT id, context_checkpoint_ids_json
        FROM attempts WHERE stage_id = 'review' AND status = 'pending'
      `).get() as { id: string; context_checkpoint_ids_json: string };
      expect(JSON.parse(successor.context_checkpoint_ids_json)).toEqual([
        "checkpoint-attempt-initial",
      ]);
      const inputs = await active.store.loadAttemptRequestInputs({
        pipeline_run_id: active.run_id,
        attempt_id: successor.id,
      });
      expect([...inputs.context.checkpoints.values()]).toEqual([
        expect.objectContaining({
          id: "checkpoint-attempt-initial",
          attempt_id: "attempt-initial",
          input_subject: SOURCE,
          output_subject: IMPLEMENTED,
        }),
      ]);
    } finally {
      if (active.db.open) active.db.close();
    }
  });

  it("falls back to an exact identity checkpoint without an inherited boundary", async () => {
    const runtime = new RuntimeFixture();
    runtime.identityOutputStages.add("implement");
    const test = await setup(runtime);
    try {
      await expect(execute(test.coordinator, 1)).resolves.toMatchObject({
        disposition: "settled",
        attempt_id: "attempt-initial",
        next_stage_id: "review",
      });

      const review = test.db.prepare(`
        SELECT id, context_checkpoint_ids_json
        FROM attempts WHERE stage_id = 'review' AND status = 'pending'
      `).get() as { id: string; context_checkpoint_ids_json: string };
      expect(JSON.parse(review.context_checkpoint_ids_json)).toEqual([
        "checkpoint-attempt-initial",
      ]);
      const inputs = await test.store.loadAttemptRequestInputs({
        pipeline_run_id: test.run_id,
        attempt_id: review.id,
      });
      expect([...inputs.context.checkpoints.values()]).toEqual([
        expect.objectContaining({
          id: "checkpoint-attempt-initial",
          attempt_id: "attempt-initial",
          input_subject: SOURCE,
          output_subject: SOURCE,
        }),
      ]);
    } finally {
      test.db.close();
    }
  });
});
