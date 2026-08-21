import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  DEFINITION_BUNDLE_SCHEMA,
  EVAL_DEFINITION_SCHEMA,
  PIPELINE_DEFINITION_SCHEMA,
  RESULT_CANDIDATE_SCHEMA,
  RUNTIME_PROVISION_STAGE_ID,
  SEMANTIC_RESULT_SCHEMA,
  definitionEntryContentHash,
  validateAndNormalizeResultCandidate,
  validateDefinitionBundle,
  type CompiledPipelineManifest,
  type AttemptCheckpoint,
  type DefinitionBundleEntry,
  type EvalDefinition,
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
  openOrInitializeFreshEpochDatabase,
} from "../../persistence/epoch-database.js";
import { SqliteKernelStore } from "../../persistence/kernel-store.js";
import type {
  KernelResultCorrectionRequest,
  KernelRuntimeLeaseCallbacks,
  KernelRuntimeOutcome,
  KernelRuntimePort,
  KernelRuntimeWorkCallbacks,
  KernelWorkActionRequest,
  StagedSemanticCandidate,
} from "../../runtime/kernel-contracts.js";
import {
  buildKernelWorkActionRequest,
  exactKernelContext,
  kernelAttemptRequestHash,
} from "./action-request.js";
import {
  ordinaryKernelPayloadSchemas,
} from "./evaluator-registry.js";
import { OrdinaryKernelCoordinator } from "./ordinary-coordinator.js";
import { compileKernelCursor } from "./reducer.js";
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
      required: true,
      max_length: 1_000,
      normalize: "string-array-to-newlines/v1",
    },
    evidence: { type: "string_list", required: true, max_length: 1_000, max_items: 50 },
    findings: { type: "json", required: true },
    actions: { type: "string_list", required: true, max_length: 300, max_items: 50 },
    uncertainty: { type: "string_list", required: true, max_length: 300, max_items: 20 },
  },
};

const reviewSchema: SemanticResultSchemaContract = {
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "core/review-result",
  outcomes: ["success", "no_change", "semantic_repair_required", "needs_human", "failure"],
  payload: {
    summary: {
      type: "string",
      required: true,
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
    findings: { type: "json", required: true },
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
      repository_authority: "edit", skills: ["core/implement-plan"],
      entry_skill: "core/implement-plan", eval: "core/action-result",
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

function reviewCandidate(findings: unknown = []): StagedSemanticCandidate {
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
  workOutcome: (() => Promise<KernelRuntimeOutcome>) | null = null;
  correctionOutcome: (() => Promise<KernelRuntimeOutcome>) | null = null;

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
      ? request.stage_id === "implement" ? IMPLEMENTED : SIMPLIFIED
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
    if (this.workOutcome) return this.workOutcome();
    if (this.pendingOnce && request.stage_id === "implement") {
      this.pendingOnce = false;
      return {
        state: "result_pending",
        checkpoint,
        candidate_hash: "d".repeat(64),
        diagnostics: [{ path: "/payload/summary", detail: "must be a string" }],
        correction_deadline: "2026-08-20T13:00:00.000Z",
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
          ? reviewCandidate(this.blockingReview ? [{ severity: "blocker", summary: "repair" }] : [])
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
    if (this.correctionOutcome) return this.correctionOutcome();
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
      restart: () => activate(openOrInitializeFreshEpochDatabase({
        database_path: databasePath,
        blob_store: blobs,
        release_id: "ordinary-release",
        runtime_capability_digest: CAPABILITY,
        bootstrap,
        now: () => NOW,
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

describe("ordinary kernel activation", () => {
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

  it("repairs only the malformed result in the same native session and locked subject", async () => {
    const runtime = new RuntimeFixture();
    runtime.pendingOnce = true;
    const test = await setup(runtime);
    try {
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
    } finally {
      test.db.close();
    }
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
});
