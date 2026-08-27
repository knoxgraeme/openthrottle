import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  EFFECT_INTENT_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  RUNTIME_PROVISION_STAGE_ID,
  canonicalJson,
  digestNormalized,
  expandCompiledRuntimeLifecycle,
  runtimeStopStageId,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type AttemptForensicsPayload,
  type BlobPointer,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecordPayloadContract,
  type ExecutionRecordPayloadRegistry,
  type InvalidResultEvidencePayload,
  type JsonValue,
  type ResultRecord,
} from "@openthrottle/contracts";
import { reduceKernelCommand, compileKernelCursor } from "../pipeline/kernel/reducer.js";
import {
  KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
  captureAttemptLeaseClaim,
  type KernelOperatorEffectRejectionRequest,
} from "../pipeline/kernel/ports.js";
import {
  KernelOperatorEffectRejectionConflictError,
  KernelOperatorEffectRejectionNotFoundError,
  OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
} from "../pipeline/kernel/operator-effect-rejection.js";
import { effectIntentContentHash } from "../pipeline/kernel/effect-intent.js";
import {
  createPipelineDecisionRecord,
  ordinaryKernelPayloadSchemas,
} from "../pipeline/kernel/evaluator-registry.js";
import {
  createAttemptForensicsRecord,
  createInvalidResultEvidenceRecord,
} from "../pipeline/kernel/attempt-evidence.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type AtomicTransitionBundle,
  type AtomicTransitionBundleContent,
  type KernelAttempt,
  type KernelRun,
} from "../pipeline/kernel/types.js";
import { VolumeBlobStore } from "./blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
  type FreshEpochIdentity,
} from "./epoch-database.js";
import {
  SqliteKernelStore,
  type KernelStoreFaultPoint,
  type PipelineAdmissionInput,
} from "./kernel-store.js";
import { SqliteKernelInboxStore } from "./kernel-inbox-store.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-20T12:00:00.000Z";
const EXECUTION_POLICY = Object.freeze({ max_concurrent_attempts: 1 });
const EXECUTION_POLICY_TWO = Object.freeze({ max_concurrent_attempts: 2 });
const sha = (character: string): string => character.repeat(64);
const subject = (character: string): string => character.repeat(40);

const payloadSchemas: ExecutionRecordPayloadRegistry = new Map<string, ExecutionRecordPayloadContract>([
  ...ordinaryKernelPayloadSchemas(),
  ["result/v1", { kind: "result", parseInline: (value: unknown): unknown => value }],
  ["decision/v1", { kind: "decision", parseInline: (value: unknown): unknown => value }],
  ["delivery/v1", { kind: "delivery", parseInline: (value: unknown): unknown => value }],
  ["openthrottle.effect-delivery/v1", { kind: "delivery", parseInline: (value: unknown): unknown => value }],
  ["openthrottle.invalid-result-evidence/v1", {
    kind: "decision", parseInline: (value: unknown): unknown => value,
  }],
]);

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "openthrottle-kernel-store-"));
  temporaryDirectories.push(path);
  return path;
}

function manifest(bundleHash: string): CompiledPipelineManifest {
  return {
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: "core/test",
    pipeline_version: 1,
    entry_stage: "work",
    definition_bundle_hash: bundleHash,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: sha("c"),
    stages: [
      {
        id: "work",
        kind: "agent",
        engine: "codex",
        agent_id: "worker",
        repository_authority: "edit",
        skills: ["work"],
        entry_skill: "work",
        eval: "result",
        on: {
          success: { to: "verify" },
          no_change: { terminal: "no_change" },
          failure: { terminal: "failed" },
        },
      },
      {
        id: "verify",
        kind: "agent",
        engine: "codex",
        agent_id: "reviewer",
        repository_authority: "inspect",
        skills: ["review"],
        entry_skill: "review",
        eval: "result",
        on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
      },
    ],
  };
}

function attempt(input: Partial<KernelAttempt> = {}): KernelAttempt {
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: input.id ?? "attempt-1",
    pipeline_run_id: input.pipeline_run_id ?? "run-1",
    scope: input.scope ?? { kind: "stage", stage_id: "work" },
    repository_authority: input.repository_authority ?? "edit",
    request_hash: input.request_hash ?? sha("a"),
    definition_bundle_hash: input.definition_bundle_hash ?? sha("b"),
    input_subject: input.input_subject ?? subject("1"),
    context_record_ids: input.context_record_ids ?? [],
    context_checkpoint_ids: input.context_checkpoint_ids ?? [],
    output_subject: input.output_subject ?? null,
    native_session_id: input.native_session_id ?? null,
    status: input.status ?? "pending",
    version: input.version ?? 0,
    work_retry_ordinal: input.work_retry_ordinal ?? 0,
    result_correction_count: input.result_correction_count ?? 0,
    result_correction_deadline: input.result_correction_deadline ?? null,
    lease: input.lease ?? null,
    checkpoint_id: input.checkpoint_id ?? null,
    result_record_id: input.result_record_id ?? null,
    decision_record_id: input.decision_record_id ?? null,
    pending_result: input.pending_result ?? null,
  };
}

function run(
  initial: readonly KernelAttempt[],
  bundleHash: string,
  stageId = "work",
): KernelRun {
  return {
    schema: KERNEL_RUN_SCHEMA,
    id: "run-1",
    pipeline_id: "core/test",
    definition_bundle_hash: bundleHash,
    current_subject: subject("1"),
    status: "pending",
    terminal_outcome: null,
    cursor: compileKernelCursor({ stage_id: stageId, version: 0, attempts: initial }),
    version: 0,
    work_retry_limit: 2,
    result_correction_limit: 2,
    active_attempt_versions: Object.fromEntries(initial.map((candidate) => [candidate.id, candidate.version])),
    active_effect_versions: {},
    checkpoint_ids: {},
  };
}

function setup(
  faultInjector?: (point: KernelStoreFaultPoint) => void,
  now: () => string = () => NOW,
  withRuntimeLifecycle = false,
  executionWidth = 1,
  transformManifest: (manifest: CompiledPipelineManifest) => CompiledPipelineManifest =
    (candidate) => candidate,
  executionPolicy: { readonly max_concurrent_attempts: number } = EXECUTION_POLICY,
): {
  db: Database.Database;
  database_path: string;
  blobs: VolumeBlobStore;
  expected_identity: FreshEpochIdentity;
  store: SqliteKernelStore;
  admission: PipelineAdmissionInput;
  pipelineManifest: CompiledPipelineManifest;
} {
  const directory = temporaryDirectory();
  const blobs = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
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
      runtime_snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
    }],
  });
  const databasePath = join(directory, "epoch.sqlite");
  const expectedIdentity: FreshEpochIdentity = {
    release_id: "release-a",
    runtime_capability_digest: "c".repeat(64),
    blob_store_id: blobs.store_id,
    blob_marker_checksum: blobs.marker_checksum,
    bootstrap_checksum: bootstrap.checksum,
  };
  const db = initializeFreshEpochDatabase({
    database_path: databasePath,
    blob_store: blobs,
    release_id: expectedIdentity.release_id,
    runtime_capability_digest: expectedIdentity.runtime_capability_digest,
    bootstrap,
    now,
  });
  const definitionBundle = blobs.put({
    bytes: '{"bundle":"test"}',
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "openthrottle.definition-bundle/v1",
  });
  const authoredManifest = manifest(definitionBundle.pointer.digest);
  const expandedManifest = withRuntimeLifecycle
    ? {
      ...authoredManifest,
      stages: expandCompiledRuntimeLifecycle({
        entry_stage: authoredManifest.entry_stage,
        stages: authoredManifest.stages,
      }).stages,
    }
    : authoredManifest;
  const pipelineManifest = transformManifest(expandedManifest);
  const initialAttempt = attempt({ definition_bundle_hash: definitionBundle.pointer.digest });
  const initialRun = run([initialAttempt], definitionBundle.pointer.digest);
  const store = new SqliteKernelStore({
    db,
    blob_store: blobs,
    manifest_resolver: { resolve: () => pipelineManifest },
    payload_schemas: payloadSchemas,
    execution_policy: executionPolicy,
    execution_width: executionWidth,
    now,
    fault_injector: faultInjector,
  });
  return {
    db,
    database_path: databasePath,
    blobs,
    expected_identity: expectedIdentity,
    store,
    pipelineManifest,
    admission: {
      work_item: {
        id: "work-1",
        repository_registration_id: "repo",
        source_provider: "linear",
        source_id: "issue-1",
        source_reference: "OPE-1",
        state: "active",
        title: "Test work",
        payload_schema: KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
        payload: {
          inline: {
            schema: KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
            task_prompt: "Do the exact sealed work.",
          },
        },
      },
      definitions: [
        {
          definition_kind: "skill",
          definition_id: "core/work",
          source_commit: null,
          content_hash: sha("d"),
          normalized_payload: { name: "platform work" },
        },
        {
          definition_kind: "pipeline",
          definition_id: "core/test",
          source_commit: subject("9"),
          content_hash: sha("e"),
          normalized_payload: { id: "core/test" },
        },
      ],
      run: initialRun,
      definition_bundle: definitionBundle,
      initial_attempts: [initialAttempt],
    },
  };
}

function reopenStore(context: ReturnType<typeof setup>): {
  db: Database.Database;
  store: SqliteKernelStore;
} {
  const blobs = VolumeBlobStore.open(context.blobs.root, context.blobs.store_id);
  const db = openFreshEpochDatabase({
    database_path: context.database_path,
    blob_store: blobs,
    expected_identity: context.expected_identity,
  });
  return {
    db,
    store: new SqliteKernelStore({
      db,
      blob_store: blobs,
      manifest_resolver: { resolve: () => context.pipelineManifest },
      payload_schemas: payloadSchemas,
      execution_policy: EXECUTION_POLICY,
      now: () => NOW,
    }),
  };
}

function admitAdditionalRun(
  context: ReturnType<typeof setup>,
  runId: string,
  ordinal: number,
  initialAttempts: readonly KernelAttempt[],
): void {
  const bundleHash = context.admission.run.definition_bundle_hash;
  context.store.admitPipelineRun({
    ...context.admission,
    work_item: {
      ...context.admission.work_item,
      id: `work-${ordinal}`,
      source_id: `issue-${ordinal}`,
      source_reference: `OPE-${ordinal}`,
    },
    run: {
      ...run(initialAttempts, bundleHash),
      id: runId,
      active_attempt_versions: Object.fromEntries(
        initialAttempts.map((candidate) => [candidate.id, candidate.version]),
      ),
    },
    initial_attempts: [...initialAttempts],
  });
}

function seedConfirmedRuntimeEffect(
  context: ReturnType<typeof setup>,
  input: {
    run_id: string;
    kind: "daytona/create-sandbox@1" | "daytona/cleanup-sandbox@1";
    sequence: number;
    marker?: string;
    target?: string;
  },
): void {
  const marker = input.marker ?? (input.kind.includes("cleanup") ? "cleanup" : "create");
  const suffix = `${input.run_id}-${marker}`;
  const decisionId = `decision-${suffix}`;
  const effectId = `effect-${suffix}`;
  const deliveryId = `delivery-${suffix}`;
  const idempotencyKey = input.marker === undefined
    ? `${input.run_id}:${input.kind}`
    : `${input.run_id}:${input.kind}:${marker}`;
  const target = input.target ?? `daytona:sandbox-${input.run_id}`;
  const deliveryPayload = {
    effect_kind: input.kind,
    provider: "daytona",
    result: {
      identity: digestCanonicalJson({ run_id: input.run_id, marker }),
      sandbox_id: `sandbox-${input.run_id}`,
    },
  };
  context.db.transaction(() => {
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, reducer, input_record_ids_json, input_record_count, created_at
      ) VALUES (?, ?, ?, ?, 'decision', 'decision/v1', '{}',
        'core/runtime-lifecycle-test@1', '[]', 0, ?)
    `).run(decisionId, input.run_id, input.sequence, sha("6"), NOW);
    context.db.prepare(`
      INSERT INTO effects (
        id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
        payload_schema, inline_payload, intent_hash, status, version, attempt_count,
        available_at, delivery_record_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, 'acknowledged', 1, 1, ?, ?, ?, ?)
    `).run(
      effectId,
      input.run_id,
      decisionId,
      input.kind,
      idempotencyKey,
      target,
      input.kind,
      sha("7"),
      NOW,
      deliveryId,
      NOW,
      NOW,
    );
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, effect_id, idempotency_key, external_identity,
        delivery_status, created_at
      ) VALUES (?, ?, ?, ?, 'delivery', 'openthrottle.effect-delivery/v1',
        ?, ?, ?, ?, 'confirmed', ?)
    `).run(
      deliveryId,
      input.run_id,
      input.sequence + 1,
      sha("8"),
      JSON.stringify(deliveryPayload),
      effectId,
      idempotencyKey,
      target,
      NOW,
    );
  }).immediate();
}

function exactMap<T extends { id: string }>(...values: T[]): ReadonlyMap<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

const OPERATOR_REJECTION_REASON_CODE =
  "legacy_integration_idempotency_key_rejected_before_mutation" as const;
const UNKNOWN_INTEGRATION_DETAIL =
  "sandbox request exited before it could author an integration result";
const LEGACY_LONG_INTEGRATION_IDEMPOTENCY_KEY = `run-1:integration:${"a".repeat(201)}`;
const RUNTIME_IDENTITY = "f".repeat(64);

function operatorEffectRejectionRequest(
  overrides: Partial<KernelOperatorEffectRejectionRequest> = {},
): KernelOperatorEffectRejectionRequest {
  return {
    pipeline_run_id: "run-1",
    effect_id: "effect-operator-rejection",
    expected_maintenance_version: 0,
    resolution_id: "resolution-sandbox-rejection",
    reason_code: OPERATOR_REJECTION_REASON_CODE,
    reason: "The sealed sandbox request failed validation before repository mutation.",
    ...overrides,
  };
}

function seedDispatchFencedUnknownIntegration(
  context: ReturnType<typeof setup>,
  input: {
    kind?: string;
    dispatch_fence?: { lease_id: string; worker_id: string } | null;
    idempotency_key?: string;
    runtime_snapshot?: string;
  } = {},
): EffectIntent {
  context.store.admitPipelineRun(context.admission);
  const runtimeDecision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-runtime-create",
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "core/external-schedule@1",
    input_record_ids: [],
    payload_schema: "decision/v1",
    payload: { inline: { phase: "create", attempt_id: "attempt-runtime" } },
    created_at: NOW,
  };
  const runtimeEffect: EffectIntent = {
    schema: EFFECT_INTENT_SCHEMA,
    id: "effect-runtime-create",
    pipeline_run_id: "run-1",
    decision_record_id: runtimeDecision.id,
    kind: "daytona/create-sandbox@1",
    idempotency_key: `run-1:daytona/create-sandbox@1:${RUNTIME_IDENTITY}`,
    target: `daytona:${RUNTIME_IDENTITY}`,
    subject: null,
    payload: {
      schema: "openthrottle.daytona-create/v1",
      identity: RUNTIME_IDENTITY,
      pipeline_run_id: "run-1",
      repository: "owner/repo",
      base_branch: "main",
      base_commit: subject("1"),
      snapshot: input.runtime_snapshot ?? OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
    },
  };
  const runtimeDelivery: DeliveryRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "delivery-runtime-create",
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: runtimeEffect.id,
    idempotency_key: runtimeEffect.idempotency_key,
    external_identity: runtimeEffect.target,
    status: "confirmed",
    payload_schema: "delivery/v1",
    payload: { inline: { sandbox_id: "sandbox-operator-rejection", identity: RUNTIME_IDENTITY } },
    created_at: NOW,
  };
  const semanticKey = "external-schedule:attempt-1:integrate-checkpoint";
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-operator-rejection",
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "core/external-schedule@1",
    input_record_ids: [],
    payload_schema: "decision/v1",
    payload: {
      inline: {
        accepted: true,
        semantic_key: semanticKey,
        attempt_id: "attempt-1",
        phase: "integrate-checkpoint",
      },
    },
    created_at: NOW,
  };
  const effect: EffectIntent = {
    schema: EFFECT_INTENT_SCHEMA,
    id: "effect-operator-rejection",
    pipeline_run_id: "run-1",
    decision_record_id: decision.id,
    kind: input.kind ?? "daytona/integrate-checkpoint@1",
    idempotency_key: input.idempotency_key ?? LEGACY_LONG_INTEGRATION_IDEMPOTENCY_KEY,
    target: `daytona:${RUNTIME_IDENTITY}:publication:checkpoint-204`,
    subject: subject("1"),
    payload: {
      schema: "openthrottle.daytona-integration/v1",
      identity: RUNTIME_IDENTITY,
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      definition_bundle_hash: context.admission.run.definition_bundle_hash,
      checkpoint_base_subject: subject("1"),
      current_subject: subject("1"),
      candidate_checkpoint_id: "checkpoint-204",
      candidate_input_subject: subject("1"),
      candidate_output_subject: subject("1"),
      candidate_blob: { digest: sha("5") },
      candidate_artifact: { commit: subject("1") },
      current_ancestry: [],
    },
  };
  const dispatchFence = input.dispatch_fence === undefined
    ? { lease_id: "effect-dispatch-204", worker_id: "effect-worker-204" }
    : input.dispatch_fence;
  if (!("inline" in decision.payload)) throw new Error("test DecisionRecord must be inline");
  const decisionPayload = decision.payload.inline;
  if (!("inline" in runtimeDecision.payload) || !("inline" in runtimeDelivery.payload)) {
    throw new Error("test runtime evidence must be inline");
  }
  const runtimeDecisionPayload = runtimeDecision.payload.inline;
  const runtimeDeliveryPayload = runtimeDelivery.payload.inline;
  context.db.transaction(() => {
    context.db.prepare(`
      INSERT INTO checkpoints (
        id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
        request_hash, definition_bundle_hash, input_subject, output_subject,
        native_session_id, payload_schema, inline_payload, captured_at
      ) VALUES ('checkpoint-operator-rejection', 'run-1', 'attempt-1', 0, ?, ?,
        ?, ?, ?, ?, NULL, 'openthrottle.git-checkpoint-bundle/v1', '{}', ?)
    `).run(
      sha("4"),
      "attempt:attempt-1:checkpoint:0",
      sha("a"),
      context.admission.run.definition_bundle_hash,
      subject("1"),
      subject("1"),
      NOW,
    );
    context.db.prepare(`
      UPDATE attempts SET status = 'work_complete',
        output_subject = ?, checkpoint_id = 'checkpoint-operator-rejection', updated_at = ?
      WHERE id = 'attempt-1' AND pipeline_run_id = 'run-1'
    `).run(subject("1"), NOW);
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, reducer, input_record_ids_json, input_record_count, created_at
      ) VALUES (?, ?, 1, ?, 'decision', ?, ?, ?, '[]', 0, ?)
    `).run(
      runtimeDecision.id,
      runtimeDecision.pipeline_run_id,
      digestCanonicalJson(runtimeDecision),
      runtimeDecision.payload_schema,
      canonicalJson(runtimeDecisionPayload),
      runtimeDecision.reducer,
      runtimeDecision.created_at,
    );
    context.db.prepare(`
      INSERT INTO effects (
        id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
        subject, payload_schema, inline_payload, intent_hash, status, version,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 0, 1, ?, ?, ?)
    `).run(
      runtimeEffect.id,
      runtimeEffect.pipeline_run_id,
      runtimeEffect.decision_record_id,
      runtimeEffect.kind,
      runtimeEffect.idempotency_key,
      runtimeEffect.target,
      runtimeEffect.kind,
      canonicalJson(runtimeEffect.payload),
      effectIntentContentHash(runtimeEffect),
      NOW,
      NOW,
      NOW,
    );
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, effect_id, idempotency_key, external_identity,
        delivery_status, created_at
      ) VALUES (?, ?, 2, ?, 'delivery', ?, ?, ?, ?, ?, 'confirmed', ?)
    `).run(
      runtimeDelivery.id,
      runtimeDelivery.pipeline_run_id,
      digestCanonicalJson(runtimeDelivery),
      runtimeDelivery.payload_schema,
      canonicalJson(runtimeDeliveryPayload),
      runtimeDelivery.effect_id,
      runtimeDelivery.idempotency_key,
      runtimeDelivery.external_identity,
      runtimeDelivery.created_at,
    );
    context.db.prepare(`
      UPDATE effects SET status = 'acknowledged', delivery_record_id = ?, version = 1
      WHERE id = ? AND pipeline_run_id = ?
    `).run(runtimeDelivery.id, runtimeEffect.id, runtimeEffect.pipeline_run_id);
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
        payload_schema, inline_payload, reducer, input_record_ids_json,
        input_record_count, created_at
      ) VALUES (?, ?, 3, ?, 'decision', ?, ?, ?, ?, '[]', 0, ?)
    `).run(
      decision.id,
      decision.pipeline_run_id,
      digestCanonicalJson(decision),
      semanticKey,
      decision.payload_schema,
      canonicalJson(decisionPayload),
      decision.reducer,
      decision.created_at,
    );
    context.db.prepare(`
      INSERT INTO effects (
        id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
        subject, payload_schema, inline_payload, intent_hash, status, version,
        attempt_count, available_at, dispatch_lease_id, dispatch_worker_id,
        unknown_detail, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 7, 4, ?, ?, ?, ?, ?, ?)
    `).run(
      effect.id,
      effect.pipeline_run_id,
      effect.decision_record_id,
      effect.kind,
      effect.idempotency_key,
      effect.target,
      effect.subject,
      effect.kind,
      canonicalJson(effect.payload),
      effectIntentContentHash(effect),
      NOW,
      dispatchFence?.lease_id ?? null,
      dispatchFence?.worker_id ?? null,
      UNKNOWN_INTEGRATION_DETAIL,
      NOW,
      NOW,
    );
  }).immediate();
  return effect;
}

function seedAdditionalConfirmedRuntimeCreate(
  context: ReturnType<typeof setup>,
  runtimeIdentity: string,
): EffectIntent {
  const decision: DecisionRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "decision-runtime-create-pool-member",
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "core/external-schedule@1",
    input_record_ids: [],
    payload_schema: "decision/v1",
    payload: { inline: { phase: "create", attempt_id: "attempt-runtime" } },
    created_at: NOW,
  };
  const effect: EffectIntent = {
    schema: EFFECT_INTENT_SCHEMA,
    id: "effect-runtime-create-pool-member",
    pipeline_run_id: "run-1",
    decision_record_id: decision.id,
    kind: "daytona/create-sandbox@1",
    idempotency_key: `run-1:daytona/create-sandbox@1:${runtimeIdentity}`,
    target: `daytona:${runtimeIdentity}`,
    subject: null,
    payload: {
      schema: "openthrottle.daytona-create/v1",
      identity: runtimeIdentity,
      pipeline_run_id: "run-1",
      repository: "owner/repo",
      base_branch: "main",
      base_commit: subject("1"),
      snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
    },
  };
  const delivery: DeliveryRecord = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "delivery-runtime-create-pool-member",
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: effect.id,
    idempotency_key: effect.idempotency_key,
    external_identity: effect.target,
    status: "confirmed",
    payload_schema: "delivery/v1",
    payload: { inline: {
      sandbox_id: "sandbox-operator-rejection-pool-member",
      identity: runtimeIdentity,
    } },
    created_at: NOW,
  };
  context.db.transaction(() => {
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, reducer, input_record_ids_json, input_record_count, created_at
      ) VALUES (?, ?, 4, ?, 'decision', ?, ?, ?, '[]', 0, ?)
    `).run(
      decision.id,
      decision.pipeline_run_id,
      digestCanonicalJson(decision),
      decision.payload_schema,
      canonicalJson((decision.payload as { inline: JsonValue }).inline),
      decision.reducer,
      decision.created_at,
    );
    context.db.prepare(`
      INSERT INTO effects (
        id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
        subject, payload_schema, inline_payload, intent_hash, status, version,
        attempt_count, available_at, delivery_record_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'acknowledged', 1, 1, ?, ?, ?, ?)
    `).run(
      effect.id,
      effect.pipeline_run_id,
      effect.decision_record_id,
      effect.kind,
      effect.idempotency_key,
      effect.target,
      effect.kind,
      canonicalJson(effect.payload),
      effectIntentContentHash(effect),
      NOW,
      delivery.id,
      NOW,
      NOW,
    );
    context.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
        inline_payload, effect_id, idempotency_key, external_identity,
        delivery_status, created_at
      ) VALUES (?, ?, 5, ?, 'delivery', ?, ?, ?, ?, ?, 'confirmed', ?)
    `).run(
      delivery.id,
      delivery.pipeline_run_id,
      digestCanonicalJson(delivery),
      delivery.payload_schema,
      canonicalJson((delivery.payload as { inline: JsonValue }).inline),
      delivery.effect_id,
      delivery.idempotency_key,
      delivery.external_identity,
      delivery.created_at,
    );
  }).immediate();
  return effect;
}

function conflictingReplay(bundle: AtomicTransitionBundle): AtomicTransitionBundle {
  const { content_hash: _contentHash, ...content } = bundle;
  const changed: AtomicTransitionBundleContent = {
    ...content,
    run: { ...content.run, work_retry_limit: content.run.work_retry_limit + 1 },
  };
  return { ...changed, content_hash: digestCanonicalJson(changed) };
}

async function claimAndStart(setupResult: ReturnType<typeof setup>): Promise<{
  attempt: KernelAttempt;
  run: KernelRun;
}> {
  const claimed = await setupResult.store.leaseNextEligibleAttempt({
    worker_id: "worker-1",
    lease_id: "lease-1",
    expires_at: "2026-08-20T12:05:00.000Z",
  });
  if (!claimed) throw new Error("expected attempt lease");
  const view = await setupResult.store.loadExactReductionView({
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    record_ids: [],
    checkpoint_ids: [],
  });
  const transition = reduceKernelCommand({
    ...view,
    command: { type: "start", command_id: "start-1", attempt_id: "attempt-1", lease_id: "lease-1" },
  });
  await setupResult.store.applyAtomicTransition(transition);
  const started = await setupResult.store.loadExactReductionView({
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    record_ids: [],
    checkpoint_ids: [],
  });
  const startedAttempt = started.current_attempt!;
  const lease = startedAttempt.lease;
  if (!lease) throw new Error("expected started attempt lease");
  const bound = reduceKernelCommand({
    ...started,
    command: {
      type: "bind_runtime_session",
      command_id: "bind-session-1",
      attempt_id: startedAttempt.id,
      expected_run_version: started.run.version,
      expected_cursor_version: started.run.cursor.version,
      expected_attempt_version: startedAttempt.version,
      request_hash: startedAttempt.request_hash,
      definition_bundle_hash: startedAttempt.definition_bundle_hash,
      input_subject: startedAttempt.input_subject,
      lease_id: lease.id,
      worker_id: lease.worker_id,
      lease_purpose: lease.purpose,
      expected_lease_expires_at: lease.expires_at,
      expected_work_retry_ordinal: startedAttempt.work_retry_ordinal,
      expected_result_correction_count: startedAttempt.result_correction_count,
      native_session_id: "session-1",
    },
  });
  await setupResult.store.applyAtomicTransition(bound);
  const sessionBound = await setupResult.store.loadExactReductionView({
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    record_ids: [],
    checkpoint_ids: [],
  });
  return { attempt: sessionBound.current_attempt!, run: sessionBound.run };
}

function putInvalidResultEvidence(
  blobs: VolumeBlobStore,
  overrides: Partial<InvalidResultEvidencePayload> = {},
): BlobPointer {
  const payload: InvalidResultEvidencePayload = {
    schema: "openthrottle.invalid-result-evidence/v1",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: sha("a"),
    definition_bundle_hash: digestNormalized('{"bundle":"test"}'),
    phase: "work",
    candidate_hash: sha("e"),
    rejected_candidate: { raw: "{\"outcome\":\"invalid\"}" },
    diagnostics: [{ path: "/payload", detail: "invalid" }],
    runner_stdout_tail: "",
    runner_stderr_tail: "",
    observed_at: NOW,
    ...overrides,
  };
  return blobs.put({
    bytes: canonicalJson(payload),
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "openthrottle.invalid-result-evidence/v1",
  }).pointer;
}

function putAttemptForensics(
  blobs: VolumeBlobStore,
  attempt: KernelAttempt,
  overrides: Partial<AttemptForensicsPayload> = {},
): {
  blob: BlobPointer;
  operational_signature: string;
  observed_at: string;
} {
  if (!attempt.lease?.started) throw new Error("forensics fixture requires a started lease");
  const payload: AttemptForensicsPayload = {
    schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    lease_id: attempt.lease.id,
    work_retry_ordinal: attempt.work_retry_ordinal,
    operational_signature: sha("f"),
    exit_code: 1,
    runner_stdout_tail: "",
    runner_stderr_tail: "silent exit",
    result_path_state: { state: "missing" },
    session_event_state: { state: "missing" },
    workspace_git_status: { state: "present", summary: "", detail: "" },
    observed_at: NOW,
    ...overrides,
  };
  return {
    blob: blobs.put({
      bytes: canonicalJson(payload),
      encoding: "utf-8",
      media_type: "application/json",
      payload_schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    }).pointer,
    operational_signature: payload.operational_signature,
    observed_at: payload.observed_at,
  };
}

async function prepareResultPendingTransition(
  context: ReturnType<typeof setup>,
  invalidResultEvidence: BlobPointer,
): Promise<AtomicTransitionBundle> {
  const started = await claimAndStart(context);
  const checkpoint: AttemptCheckpoint = {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: "checkpoint-result-pending",
    pipeline_run_id: started.attempt.pipeline_run_id,
    attempt_id: started.attempt.id,
    request_hash: started.attempt.request_hash,
    definition_bundle_hash: started.attempt.definition_bundle_hash,
    input_subject: started.attempt.input_subject,
    output_subject: subject("2"),
    native_session_id: started.attempt.native_session_id,
    payload_schema: "checkpoint/v1",
    payload: { inline: { complete: true } },
    captured_at: NOW,
  };
  await context.store.applyAtomicTransition(reduceKernelCommand({
    manifest: context.pipelineManifest,
    run: started.run,
    current_attempt: started.attempt,
    records: new Map(),
    checkpoints: exactMap(checkpoint),
    command: {
      type: "work_complete",
      command_id: "work-complete-result-pending",
      attempt_id: started.attempt.id,
      checkpoint_id: checkpoint.id,
      verified_output_subject: subject("2"),
      result_record_id: null,
    },
  }));
  const completed = await context.store.loadExactReductionView({
    pipeline_run_id: started.attempt.pipeline_run_id,
    attempt_id: started.attempt.id,
    record_ids: [],
    checkpoint_ids: [checkpoint.id],
  });
  const evidence = createInvalidResultEvidenceRecord({
    attempt: completed.current_attempt!,
    pointer: invalidResultEvidence,
    created_at: NOW,
  });
  return reduceKernelCommand({
    ...completed,
    records: exactMap(evidence),
    command: {
      type: "result_pending",
      command_id: "result-pending-with-evidence",
      attempt_id: started.attempt.id,
      candidate_hash: sha("e"),
      diagnostics: [{ path: "/payload", detail: "invalid" }],
      correction_deadline: "2026-08-20T12:15:00.000Z",
      invalid_result_evidence: invalidResultEvidence,
      invalid_result_evidence_record_id: evidence.id,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteKernelStore", () => {
  it("admits definitions, work, bundle, run, and attempts in one transaction", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM definitions").get()).toEqual({ count: 2 });
      expect(context.db.prepare("SELECT source_commit FROM definitions ORDER BY definition_id").all())
        .toEqual([{ source_commit: subject("9") }, { source_commit: null }]);
      const admitted = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1",
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      });
      expect(admitted.run.status).toBe("pending");
      expect(Object.keys(admitted.run.active_attempt_versions)).toHaveLength(1);
    } finally {
      context.db.close();
    }
  });

  it("atomically consumes the originating inbox event and stays settled across reopen", () => {
    const context = setup();
    let reopened: Database.Database | undefined;
    try {
      const inbox = new SqliteKernelInboxStore({
        db: context.db,
        blob_store: context.blobs,
        now: () => NOW,
      });
      inbox.setMaintenanceFence({ closed: false });
      const providerEvent = {
        source_provider: "linear",
        delivery_id: "delivery-admission",
        kind: "linear/agent-session-event/prompted@1",
        generation: 0,
        event_group_key: "linear:admission:issue-1",
        delivery_attempt: 1,
        subject: subject("1"),
        payload_schema: "openthrottle.provider-event/linear/v1",
        payload: { issue: "OPE-1", prompt: "Execute the plan." },
      } as const;
      expect(inbox.ingest(providerEvent)).toMatchObject({ disposition: "inserted" });
      const leased = inbox.leaseNext({
        owner_id: "worker-admission",
        lease_id: "lease-admission",
        expires_at: "2026-08-20T12:05:00.000Z",
      })!;

      context.store.admitPipelineRun({
        ...context.admission,
        originating_inbox: {
          event_id: leased.id,
          source_provider: leased.source_provider,
          delivery_id: leased.delivery_id,
          kind: leased.kind,
          payload_hash: leased.payload_hash,
          lease_id: leased.lease_id!,
          lease_owner_id: leased.lease_owner_id!,
          version: leased.version,
        },
      });
      expect(inbox.get(leased.id)).toMatchObject({
        status: "consumed",
        work_item_id: null,
        pipeline_run_id: null,
        attempt_id: null,
        lease_id: null,
        consumed_at: NOW,
        version: leased.version + 1,
      });
      expect(context.db.prepare(`
        SELECT w.created_at AS admitted_at, r.created_at AS run_created_at,
          i.consumed_at AS origin_consumed_at
        FROM work_items w
        JOIN pipeline_runs r ON r.work_item_id = w.id
        JOIN inbox_events i ON i.id = ?
        WHERE w.id = ? AND r.id = ?
      `).get(leased.id, context.admission.work_item.id, context.admission.run.id)).toEqual({
        admitted_at: NOW,
        run_created_at: NOW,
        origin_consumed_at: NOW,
      });
      expect(() => inbox.complete({
        event_id: leased.id,
        owner_id: "worker-admission",
        lease_id: "lease-admission",
        outcome: "consumed",
      })).not.toThrow();
      expect(() => inbox.complete({
        event_id: leased.id,
        owner_id: "worker-admission",
        lease_id: "lease-admission",
        outcome: "stale",
      })).toThrow(/completion lease fence/);
      expect(inbox.ingest(providerEvent)).toMatchObject({
        disposition: "duplicate",
        event: { status: "consumed" },
      });
      expect(inbox.ingest({
        ...providerEvent,
        delivery_id: "delivery-admission-redelivery",
        delivery_attempt: 2,
      })).toMatchObject({ disposition: "reordered", event: { status: "stale" } });

      context.db.close();
      const reopenedBlobs = VolumeBlobStore.open(context.blobs.root, context.blobs.store_id);
      reopened = openFreshEpochDatabase({
        database_path: context.database_path,
        blob_store: reopenedBlobs,
        expected_identity: context.expected_identity,
      });
      const replayInbox = new SqliteKernelInboxStore({
        db: reopened,
        blob_store: reopenedBlobs,
        now: () => "2026-08-20T12:01:00.000Z",
      });
      expect(replayInbox.get(leased.id)).toMatchObject({
        status: "consumed",
        work_item_id: null,
        pipeline_run_id: null,
        attempt_id: null,
      });
      expect(replayInbox.leaseNext({
        owner_id: "worker-replay",
        lease_id: "lease-replay",
        expires_at: "2026-08-20T12:06:00.000Z",
      })).toBeNull();
    } finally {
      if (reopened) reopened.close();
      else context.db.close();
    }
  });

  it("rolls back inbox consumption and admission after a post-consume fault", () => {
    const context = setup((point) => {
      if (point === "admission_inbox_consumed") throw new Error("fault after inbox consumption");
    });
    try {
      const inbox = new SqliteKernelInboxStore({
        db: context.db,
        blob_store: context.blobs,
        now: () => NOW,
      });
      inbox.setMaintenanceFence({ closed: false });
      const inserted = inbox.ingest({
        source_provider: "linear",
        delivery_id: "delivery-atomic-rollback",
        kind: "linear/agent-session-event/created@1",
        generation: 0,
        event_group_key: "linear:atomic-rollback",
        delivery_attempt: 1,
        payload_schema: "openthrottle.provider-event/linear/v1",
        payload: { issue: "OPE-1" },
      });
      if (!("event" in inserted)) throw new Error("expected inserted inbox event");
      const leased = inbox.leaseNext({
        owner_id: "worker-admission",
        lease_id: "lease-admission",
        expires_at: "2026-08-20T12:05:00.000Z",
      })!;

      expect(() => context.store.admitPipelineRun({
        ...context.admission,
        originating_inbox: {
          event_id: leased.id,
          source_provider: leased.source_provider,
          delivery_id: leased.delivery_id,
          kind: leased.kind,
          payload_hash: leased.payload_hash,
          lease_id: leased.lease_id!,
          lease_owner_id: leased.lease_owner_id!,
          version: leased.version,
        },
      })).toThrow(/fault after inbox consumption/);
      for (const table of ["definitions", "work_items", "pipeline_runs", "attempts"]) {
        expect(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
          .toEqual({ count: 0 });
      }
      expect(inbox.get(inserted.event.id)).toMatchObject({
        status: "processing",
        work_item_id: null,
        pipeline_run_id: null,
        attempt_id: null,
      });
    } finally {
      context.db.close();
    }
  });

  it("rejects admission after the originating inbox event is re-leased", () => {
    const context = setup();
    try {
      const inbox = new SqliteKernelInboxStore({
        db: context.db,
        blob_store: context.blobs,
        now: () => NOW,
      });
      inbox.setMaintenanceFence({ closed: false });
      inbox.ingest({
        source_provider: "linear",
        delivery_id: "delivery-released-admission",
        kind: "linear/agent-session-event/prompted@1",
        generation: 0,
        event_group_key: "linear:re-leased-admission",
        delivery_attempt: 1,
        payload_schema: "openthrottle.provider-event/linear/v1",
        payload: { issue: "OPE-1", prompt: "Execute the plan." },
      });
      const oldLease = inbox.leaseNext({
        owner_id: "worker-old",
        lease_id: "lease-old",
        expires_at: "2026-08-20T12:05:00.000Z",
      })!;
      inbox.retry({
        event_id: oldLease.id,
        owner_id: "worker-old",
        lease_id: "lease-old",
        available_at: "2026-08-20T12:00:01.000Z",
      });
      const laterInbox = new SqliteKernelInboxStore({
        db: context.db,
        blob_store: context.blobs,
        now: () => "2026-08-20T12:01:00.000Z",
      });
      const currentLease = laterInbox.leaseNext({
        owner_id: "worker-current",
        lease_id: "lease-current",
        expires_at: "2026-08-20T12:06:00.000Z",
      })!;

      expect(() => context.store.admitPipelineRun({
        ...context.admission,
        originating_inbox: {
          event_id: oldLease.id,
          source_provider: oldLease.source_provider,
          delivery_id: oldLease.delivery_id,
          kind: oldLease.kind,
          payload_hash: oldLease.payload_hash,
          lease_id: oldLease.lease_id!,
          lease_owner_id: oldLease.lease_owner_id!,
          version: oldLease.version,
        },
      })).toThrow(/originating inbox admission fence/);
      expect(laterInbox.get(currentLease.id)).toMatchObject({
        status: "processing",
        lease_id: "lease-current",
        lease_owner_id: "worker-current",
        version: currentLease.version,
      });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs").get())
        .toEqual({ count: 0 });
    } finally {
      context.db.close();
    }
  });

  it("rejects missing invalid-result evidence before initial Attempt admission", () => {
    const context = setup();
    try {
      const invalidResultEvidence = putInvalidResultEvidence(context.blobs);
      const initialAttempt = attempt({
        ...context.admission.initial_attempts[0],
        status: "result_pending",
        native_session_id: "session-initial-pending",
        result_correction_deadline: "2026-08-20T12:15:00.000Z",
        pending_result: {
          candidate_hash: sha("e"),
          diagnostics: [{ path: "/payload", detail: "invalid" }],
          invalid_result_evidence: invalidResultEvidence,
        },
      });
      const admission = {
        ...context.admission,
        initial_attempts: [initialAttempt],
        run: run([initialAttempt], context.admission.run.definition_bundle_hash),
      };
      rmSync(context.blobs.objectPath(invalidResultEvidence.digest));

      expect(() => context.store.admitPipelineRun(admission)).toThrow(/object is missing/);
      for (const table of ["definitions", "work_items", "pipeline_runs", "attempts"]) {
        expect(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      context.db.close();
    }
  });

  it.each([
    ["pipeline run", { pipeline_run_id: "run-other" }],
    ["Attempt", { attempt_id: "attempt-other" }],
    ["request", { request_hash: sha("f") }],
    ["DefinitionBundle", { definition_bundle_hash: sha("f") }],
    ["candidate", { candidate_hash: sha("f") }],
  ] as const)("rejects invalid-result evidence with another %s identity", (_label, overrides) => {
    const context = setup();
    try {
      const invalidResultEvidence = putInvalidResultEvidence(context.blobs, overrides);
      const initialAttempt = attempt({
        ...context.admission.initial_attempts[0],
        status: "result_pending",
        native_session_id: "session-initial-pending",
        result_correction_deadline: "2026-08-20T12:15:00.000Z",
        pending_result: {
          candidate_hash: sha("e"),
          diagnostics: [{ path: "/payload", detail: "invalid" }],
          invalid_result_evidence: invalidResultEvidence,
        },
      });
      const admission = {
        ...context.admission,
        initial_attempts: [initialAttempt],
        run: run([initialAttempt], context.admission.run.definition_bundle_hash),
      };

      expect(() => context.store.admitPipelineRun(admission))
        .toThrow(/invalid-result evidence changed its sealed identity/);
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs").get())
        .toEqual({ count: 0 });
    } finally {
      context.db.close();
    }
  });

  it("persists retry forensics under the stable pre-retry Attempt identity", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const started = await claimAndStart(context);
      const evidence = putAttemptForensics(context.blobs, started.attempt);
      const record = createAttemptForensicsRecord({ attempt: started.attempt, evidence });
      const transition = reduceKernelCommand({
        manifest: context.pipelineManifest,
        run: started.run,
        current_attempt: started.attempt,
        records: exactMap(record),
        checkpoints: new Map(),
        command: {
          type: "retry",
          command_id: "retry-with-forensics",
          attempt_id: started.attempt.id,
          forensics_record_id: record.id,
        },
      });

      await expect(context.store.applyAtomicTransition(transition)).resolves.toEqual({
        disposition: "applied",
        run_version: started.run.version + 1,
      });
      await expect(context.store.loadAttemptForensics({
        pipeline_run_id: started.run.id,
        attempt_id: started.attempt.id,
        work_retry_ordinal: 0,
      })).resolves.toEqual(expect.objectContaining({
        record,
        payload: expect.objectContaining({
          lease_id: started.attempt.lease!.id,
          work_retry_ordinal: 0,
          observed_at: NOW,
        }),
      }));
    } finally {
      context.db.close();
    }
  });

  it.each([
    ["lease", { lease_id: "lease-other" }],
    ["retry ordinal", { work_retry_ordinal: 1 }],
    ["request", { request_hash: sha("f") }],
  ] as const)("rejects retry forensics with another stable %s identity", async (_label, overrides) => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const started = await claimAndStart(context);
      const evidence = putAttemptForensics(context.blobs, started.attempt, overrides);
      const record = createAttemptForensicsRecord({ attempt: started.attempt, evidence });
      const transition = reduceKernelCommand({
        manifest: context.pipelineManifest,
        run: started.run,
        current_attempt: started.attempt,
        records: exactMap(record),
        checkpoints: new Map(),
        command: {
          type: "retry",
          command_id: `retry-with-invalid-forensics-${_label}`,
          attempt_id: started.attempt.id,
          forensics_record_id: record.id,
        },
      });

      await expect(context.store.applyAtomicTransition(transition))
        .rejects.toThrow(/changed its live Attempt forensics identity/);
      expect(context.db.prepare("SELECT work_retry_ordinal FROM attempts WHERE id = 'attempt-1'").get())
        .toEqual({ work_retry_ordinal: 0 });
    } finally {
      context.db.close();
    }
  });

  it("classifies promoted and recorded external continuations by their durable schedule identity", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const externalSemanticKey = "external-schedule:attempt-1:integrate-checkpoint";
      context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO checkpoints (
            id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
            request_hash, definition_bundle_hash, input_subject, output_subject,
            native_session_id, payload_schema, inline_payload, captured_at
          ) VALUES (?, 'run-1', 'attempt-1', 0, ?, ?, ?, ?, ?, ?, NULL,
            'openthrottle.git-checkpoint-bundle/v1', '{}', ?)
        `).run(
          "checkpoint-promoted",
          sha("4"),
          "attempt:attempt-1:checkpoint:0",
          sha("a"),
          context.admission.run.definition_bundle_hash,
          subject("1"),
          subject("2"),
          NOW,
        );
        context.db.prepare(`
          INSERT INTO records (
            id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
            payload_schema, inline_payload, reducer, input_record_ids_json,
            input_record_count, created_at
          ) VALUES ('decision-external', 'run-1', 1, ?, 'decision', ?,
            'decision/v1', ?, 'core/external-schedule@1', '[]', 0, ?)
        `).run(
          sha("5"),
          externalSemanticKey,
          JSON.stringify({ semantic_key: externalSemanticKey }),
          NOW,
        );
        context.db.prepare(`
          UPDATE attempts SET status = 'work_complete', output_subject = ?,
            checkpoint_id = 'checkpoint-promoted', version = version + 1
          WHERE id = 'attempt-1'
        `).run(subject("2"));
      }).immediate();

      await expect(context.store.listReadyExternalAttempts({ limit: 10 })).resolves.toEqual([
        { updated_at: NOW, pipeline_run_id: "run-1", attempt_id: "attempt-1" },
      ]);
      await expect(context.store.listReadyExternalAttempts({
        limit: 10,
        after: { updated_at: NOW, pipeline_run_id: "run-1", attempt_id: "attempt-1" },
      })).resolves.toEqual([]);
      await expect(context.store.listReadyOrdinaryAttempts({ limit: 10 })).resolves.toEqual([]);

      context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO records (
            id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
            inline_payload, attempt_id, request_hash, definition_bundle_hash,
            input_subject, output_subject, original_candidate_hash,
            normalized_candidate_hash, created_at
          ) VALUES ('result-external', 'run-1', 2, ?, 'result', 'result/v1', '{}',
            'attempt-1', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sha("6"),
          sha("a"),
          context.admission.run.definition_bundle_hash,
          subject("1"),
          subject("2"),
          sha("7"),
          sha("7"),
          NOW,
        );
        context.db.prepare(`
          UPDATE attempts SET status = 'recorded', result_record_id = 'result-external',
            version = version + 1 WHERE id = 'attempt-1'
        `).run();
      }).immediate();

      await expect(context.store.listReadyExternalAttempts({ limit: 10 })).resolves.toEqual([
        { updated_at: NOW, pipeline_run_id: "run-1", attempt_id: "attempt-1" },
      ]);
      await expect(context.store.listReadyOrdinaryAttempts({ limit: 10 })).resolves.toEqual([]);
    } finally {
      context.db.close();
    }
  });

  it("re-reads exact bundle bytes for manifest reconstruction after a store restart", async () => {
    const initialized = setup();
    initialized.store.admitPipelineRun(initialized.admission);
    const observations: Array<{ pipeline_id: string; hash: string; bytes: string }> = [];
    const restarted = new SqliteKernelStore({
      db: initialized.db,
      blob_store: initialized.blobs,
      manifest_resolver: {
        resolve: (input) => {
          observations.push({
            pipeline_id: input.pipeline_id,
            hash: input.definition_bundle_hash,
            bytes: new TextDecoder().decode(input.definition_bundle_bytes),
          });
          return initialized.pipelineManifest;
        },
      },
      payload_schemas: payloadSchemas,
      execution_policy: EXECUTION_POLICY,
      now: () => NOW,
    });

    await restarted.loadExactReductionView({
      pipeline_run_id: initialized.admission.run.id,
      attempt_id: initialized.admission.initial_attempts[0]!.id,
      record_ids: [],
      checkpoint_ids: [],
    });

    expect(observations).toEqual([{
      pipeline_id: "core/test",
      hash: initialized.admission.run.definition_bundle_hash,
      bytes: '{"bundle":"test"}',
    }]);
  });

  it("reuses an exact immutable definition snapshot across admissions", () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const secondAttempt: KernelAttempt = {
        ...context.admission.initial_attempts[0]!,
        id: "attempt-2",
        pipeline_run_id: "run-2",
      };
      const secondRun: KernelRun = {
        ...run([secondAttempt], context.admission.run.definition_bundle_hash),
        id: "run-2",
        active_attempt_versions: { "attempt-2": 0 },
      };
      context.store.admitPipelineRun({
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-2",
          source_id: "issue-2",
          source_reference: "OPE-2",
        },
        run: secondRun,
        initial_attempts: [secondAttempt],
      });

      expect(context.db.prepare("SELECT COUNT(*) AS count FROM definitions").get()).toEqual({ count: 2 });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs").get()).toEqual({ count: 2 });
    } finally {
      context.db.close();
    }
  });

  it("atomically attaches a promoted run to the same work item with one executor decision", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const promotion: DecisionRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "decision-promotion",
        kind: "decision",
        pipeline_run_id: "run-target",
        reducer: "kernel/promote-admission@1",
        input_record_ids: [],
        payload_schema: "decision/v1",
        payload: { inline: { selected_pipeline: "core/test" } },
        created_at: NOW,
      };
      const targetAttempt = attempt({
        id: "attempt-target",
        pipeline_run_id: "run-target",
        definition_bundle_hash: context.admission.run.definition_bundle_hash,
        context_record_ids: [promotion.id],
      });
      const targetRun: KernelRun = {
        ...run([targetAttempt], context.admission.run.definition_bundle_hash),
        id: "run-target",
        active_attempt_versions: { [targetAttempt.id]: targetAttempt.version },
      };

      context.store.attachPipelineRun({
        work_item_id: context.admission.work_item.id,
        source_pipeline_run_id: context.admission.run.id,
        definitions: context.admission.definitions,
        run: targetRun,
        definition_bundle: context.admission.definition_bundle,
        initial_records: [promotion],
        initial_attempts: [targetAttempt],
      });

      expect(context.store.findAttachedPipelineRun(targetRun.id)).toEqual({
        id: targetRun.id,
        work_item_id: context.admission.work_item.id,
        pipeline_id: targetRun.pipeline_id,
        definition_bundle_hash: targetRun.definition_bundle_hash,
        current_subject: targetRun.current_subject,
      });
      const request = await context.store.loadAttemptRequestInputs({
        pipeline_run_id: targetRun.id,
        attempt_id: targetAttempt.id,
      });
      expect(request.task_prompt).toBe("Do the exact sealed work.");
      expect([...request.context.records.values()]).toEqual([promotion]);
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({ count: 1 });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs").get()).toEqual({ count: 2 });
    } finally {
      context.db.close();
    }
  });

  it.each<KernelStoreFaultPoint>([
    "admission_definitions_written",
    "admission_work_item_written",
    "admission_run_written",
    "admission_attempts_written",
  ])("rolls the complete admission back when %s faults", (faultPoint) => {
    const context = setup((point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    });
    try {
      expect(() => context.store.admitPipelineRun(context.admission)).toThrow(`fault:${faultPoint}`);
      for (const table of ["definitions", "work_items", "pipeline_runs", "attempts", "records", "effects", "checkpoints"]) {
        expect(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(context.blobs.read(context.admission.definition_bundle.pointer).length).toBeGreaterThan(0);
    } finally {
      context.db.close();
    }
  });

  it("leases through one indexed CAS authority with exact replay, worker fencing, and renewal", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const request = {
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      };
      const first = await context.store.leaseNextEligibleAttempt(request);
      const replay = await context.store.leaseNextEligibleAttempt(request);
      expect(first?.attempt).toEqual(replay?.attempt);
      expect(first?.attempt.lease).toMatchObject({ generation: 0, worker_id: "worker-1" });
      await expect(context.store.leaseNextEligibleAttempt({ ...request, worker_id: "worker-2" }))
        .rejects.toThrow(/immutable replay/);
      await expect(context.store.renewAttemptLease({
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        lease_generation: 0,
        worker_id: "worker-2",
        expires_at: "2026-08-20T12:06:00.000Z",
      })).rejects.toThrow(/fence/);
      expect(await context.store.renewAttemptLease({
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        lease_generation: 0,
        worker_id: "worker-1",
        expires_at: "2026-08-20T12:06:00.000Z",
      })).toMatchObject({ worker_id: "worker-1", expires_at: "2026-08-20T12:06:00.000Z" });
    } finally {
      context.db.close();
    }
  });

  it("snapshots one frozen bounded execution-policy value at the persistence boundary", async () => {
    const context = setup();
    const base = {
      db: context.db,
      blob_store: context.blobs,
      manifest_resolver: { resolve: () => context.pipelineManifest },
      payload_schemas: payloadSchemas,
      now: () => NOW,
    };
    try {
      const forcedWidthTwo = Object.freeze({ max_concurrent_attempts: 2 });
      expect(() => new SqliteKernelStore({
        ...base,
        execution_policy: forcedWidthTwo,
      })).not.toThrow();
      expect(() => new SqliteKernelStore({
        ...base,
        execution_policy: Object.freeze({ max_concurrent_attempts: 17 }),
      })).toThrow(/frozen between 1 and 16/);
      expect(() => new SqliteKernelStore({
        ...base,
        execution_policy: { max_concurrent_attempts: 1 },
      })).toThrow(/frozen between 1 and 16/);

      let reads = 0;
      const statefulGetter = Object.freeze({
        get max_concurrent_attempts() {
          reads += 1;
          return reads === 1 ? 2 : 3;
        },
      });
      const store = new SqliteKernelStore({
        ...base,
        execution_policy: statefulGetter,
      });
      expect(reads).toBe(1);
      store.admitPipelineRun(context.admission);
      await expect(store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.not.toBeNull();
      expect(reads).toBe(1);
    } finally {
      context.db.close();
    }
  });

  it("skips a deterministically invalid manifest while leasing an unrelated run", async () => {
    const context = setup();
    try {
      const goodHash = context.admission.run.definition_bundle_hash;
      const goodAttempt = attempt({
        id: "attempt-z-good",
        pipeline_run_id: "run-good",
        definition_bundle_hash: goodHash,
      });
      context.store.admitPipelineRun({
        ...context.admission,
        run: {
          ...run([goodAttempt], goodHash),
          id: "run-good",
          active_attempt_versions: { [goodAttempt.id]: goodAttempt.version },
        },
        initial_attempts: [goodAttempt],
      });

      const invalidBundle = context.blobs.put({
        bytes: '{"bundle":"invalid"}',
        encoding: "utf-8",
        media_type: "application/json",
        payload_schema: "openthrottle.definition-bundle/v1",
      });
      const invalidHash = invalidBundle.pointer.digest;
      const invalidAttempt = attempt({
        id: "attempt-a-invalid",
        pipeline_run_id: "run-invalid",
        definition_bundle_hash: invalidHash,
      });
      context.store.admitPipelineRun({
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-invalid",
          source_id: "issue-invalid",
          source_reference: "OPE-INVALID",
        },
        run: {
          ...run([invalidAttempt], invalidHash),
          id: "run-invalid",
          active_attempt_versions: { [invalidAttempt.id]: invalidAttempt.version },
        },
        definition_bundle: invalidBundle,
        initial_attempts: [invalidAttempt],
      });

      const scheduler = new SqliteKernelStore({
        db: context.db,
        blob_store: context.blobs,
        manifest_resolver: {
          resolve: (input) => {
            if (input.definition_bundle_hash === invalidHash) {
              throw new Error("invalid exact compiled manifest");
            }
            return context.pipelineManifest;
          },
        },
        payload_schemas: payloadSchemas,
        execution_policy: EXECUTION_POLICY,
        now: () => NOW,
      });
      await expect(scheduler.leaseNextEligibleAttempt({
        worker_id: "worker-good",
        lease_id: "lease-good",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({
        run_id: "run-good",
        attempt: { id: "attempt-z-good" },
      });
      expect(context.db.prepare(
        "SELECT lease_id FROM attempts WHERE id = 'attempt-a-invalid'",
      ).get()).toEqual({ lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("refreshes a stale manifest snapshot when a new bundle is admitted before the lease transaction", async () => {
    const context = setup();
    try {
      const firstHash = context.admission.run.definition_bundle_hash;
      const firstAttempt = attempt({
        id: "attempt-first",
        pipeline_run_id: "run-first",
        definition_bundle_hash: firstHash,
      });
      const firstAdmission: PipelineAdmissionInput = {
        ...context.admission,
        run: {
          ...run([firstAttempt], firstHash),
          id: "run-first",
          active_attempt_versions: { [firstAttempt.id]: firstAttempt.version },
        },
        initial_attempts: [firstAttempt],
      };
      const secondBundle = context.blobs.put({
        bytes: '{"bundle":"second"}',
        encoding: "utf-8",
        media_type: "application/json",
        payload_schema: "openthrottle.definition-bundle/v1",
      });
      const secondHash = secondBundle.pointer.digest;
      const secondAttempt = attempt({
        id: "attempt-second",
        pipeline_run_id: "run-second",
        definition_bundle_hash: secondHash,
      });
      const secondAdmission: PipelineAdmissionInput = {
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-second",
          source_id: "issue-second",
          source_reference: "OPE-SECOND",
        },
        run: {
          ...run([secondAttempt], secondHash),
          id: "run-second",
          active_attempt_versions: { [secondAttempt.id]: secondAttempt.version },
        },
        definition_bundle: secondBundle,
        initial_attempts: [secondAttempt],
      };
      let admittedSecond = false;
      const resolvedHashes: string[] = [];
      let scheduler: SqliteKernelStore;
      scheduler = new SqliteKernelStore({
        db: context.db,
        blob_store: context.blobs,
        manifest_resolver: {
          resolve: (input) => {
            resolvedHashes.push(input.definition_bundle_hash);
            if (!admittedSecond && input.definition_bundle_hash === firstHash) {
              admittedSecond = true;
              scheduler.admitPipelineRun(secondAdmission);
            }
            return {
              ...context.pipelineManifest,
              definition_bundle_hash: input.definition_bundle_hash,
            };
          },
        },
        payload_schemas: payloadSchemas,
        execution_policy: EXECUTION_POLICY,
        now: () => NOW,
      });
      scheduler.admitPipelineRun(firstAdmission);

      await expect(scheduler.leaseNextEligibleAttempt({
        worker_id: "worker-first",
        lease_id: "lease-first",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-first" } });
      expect(admittedSecond).toBe(true);
      expect(resolvedHashes.sort()).toEqual([firstHash, secondHash].sort());
    } finally {
      context.db.close();
    }
  });

  it("permits only one live Attempt lease across competing stores in one epoch", async () => {
    const context = setup();
    let competingDb: Database.Database | undefined;
    try {
      context.store.admitPipelineRun(context.admission);
      const secondAttempt = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: context.admission.run.definition_bundle_hash,
      });
      context.store.admitPipelineRun({
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-2",
          source_id: "issue-2",
          source_reference: "OPE-2",
        },
        run: {
          ...run([secondAttempt], context.admission.run.definition_bundle_hash),
          id: "run-2",
          active_attempt_versions: { [secondAttempt.id]: secondAttempt.version },
        },
        initial_attempts: [secondAttempt],
      });
      competingDb = new Database(context.db.name, { fileMustExist: true });
      competingDb.pragma("foreign_keys = ON");
      competingDb.pragma("journal_mode = WAL");
      competingDb.pragma("busy_timeout = 5000");
      const competingStore = new SqliteKernelStore({
        db: competingDb,
        blob_store: context.blobs,
        manifest_resolver: { resolve: () => context.pipelineManifest },
        payload_schemas: payloadSchemas,
        execution_policy: EXECUTION_POLICY,
        now: () => NOW,
      });

      const firstRequest = {
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      };
      const secondRequest = {
        worker_id: "worker-2",
        lease_id: "lease-2",
        expires_at: "2026-08-20T12:05:00.000Z",
      };
      const leases = await Promise.all([
        context.store.leaseNextEligibleAttempt(firstRequest),
        competingStore.leaseNextEligibleAttempt(secondRequest),
      ]);

      expect(leases.filter((lease) => lease !== null)).toHaveLength(1);
      expect(leases.filter((lease) => lease === null)).toHaveLength(1);
      const winner = leases.find((lease) => lease !== null)!;
      const winningRequest = winner.lease.id === firstRequest.lease_id
        ? firstRequest
        : secondRequest;
      expect(await competingStore.leaseNextEligibleAttempt(winningRequest)).toEqual(winner);
      await expect(competingStore.leaseNextEligibleAttempt({
        ...winningRequest,
        worker_id: "conflicting-worker",
      })).rejects.toThrow(/immutable replay/);
      expect(await competingStore.leaseNextEligibleAttempt({
        worker_id: "worker-3",
        lease_id: "lease-3",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).toBeNull();
    } finally {
      competingDb?.close();
      context.db.close();
    }
  });

  it("co-leases compatible same-run inspect members on distinct runtime slots", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const first = attempt({
        id: "attempt-1a",
        pipeline_run_id: "run-1",
        repository_authority: "inspect",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-1a",
          fanout_id: "selection.personas",
          member_id: "persona-a",
          member_index: 0,
        },
        definition_bundle_hash: bundleHash,
      });
      const sameRun = attempt({
        id: "attempt-1b",
        pipeline_run_id: "run-1",
        repository_authority: "inspect",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-1a",
          fanout_id: "selection.personas",
          member_id: "persona-b",
          member_index: 1,
        },
        definition_bundle_hash: bundleHash,
      });
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([first, sameRun], bundleHash, "verify"),
        initial_attempts: [first, sameRun],
      });
      const otherRun = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [otherRun]);

      const firstLease = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      const secondLease = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-2",
        expires_at: "2026-08-20T12:05:00.000Z",
      });

      expect([firstLease?.run_id, secondLease?.run_id]).toEqual(["run-1", "run-1"]);
      expect(firstLease?.attempt.id).toBe("attempt-1a");
      expect(secondLease?.attempt.id).toBe("attempt-1b");
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-3",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
      expect(context.db.prepare(
        "SELECT lease_id FROM attempts WHERE id = 'attempt-2'",
      ).get()).toEqual({ lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("serializes sparse modulo collisions while a distinct runtime slot still progresses", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const candidates = [0, 2, 1].map((memberIndex) => attempt({
        id: `attempt-slot-${memberIndex}`,
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-slot-0",
          fanout_id: "selection.personas",
          member_id: `persona-${memberIndex}`,
          member_index: memberIndex,
        },
      }));
      context.store.admitPipelineRun({
        ...context.admission,
        run: run(candidates, bundleHash, "verify"),
        initial_attempts: candidates,
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-slot-0",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-slot-0" } });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-slot-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-slot-1" } });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-slot-2",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
      expect(context.db.prepare(
        "SELECT lease_id FROM attempts WHERE id = 'attempt-slot-2'",
      ).get()).toEqual({ lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("keeps stage and edit Attempts serial even when another runtime slot is free", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const stageAttempt = attempt({
        id: "attempt-stage",
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: { kind: "stage", stage_id: "verify" },
      });
      const editAttempt = attempt({
        id: "attempt-edit",
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "edit",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-stage",
          fanout_id: "selection.personas",
          member_id: "persona-1",
          member_index: 1,
        },
      });
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([stageAttempt, editAttempt], bundleHash, "verify"),
        initial_attempts: [stageAttempt, editAttempt],
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-stage",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-edit" } });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-edit",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
    } finally {
      context.db.close();
    }
  });

  it("does not parallelize an inspect stage merely because another stage enlarged the pool", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "work"
        ? {
          ...stage,
          loop: {
            over: "execution_plan.units",
            max_parallel: 2,
            max_rounds: 1,
            body: ["work"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const candidates = [0, 1].map((memberIndex) => attempt({
        id: `attempt-serial-inspect-${memberIndex}`,
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-serial-inspect-0",
          fanout_id: "selection.personas",
          member_id: `persona-${memberIndex}`,
          member_index: memberIndex,
        },
      }));
      context.store.admitPipelineRun({
        ...context.admission,
        run: run(candidates, bundleHash, "verify"),
        initial_attempts: candidates,
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-serial-inspect-0",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-serial-inspect-0" } });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-serial-inspect-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
    } finally {
      context.db.close();
    }
  });

  it("enforces the inspect stage's own width when another stage creates a larger pool", async () => {
    const context = setup(undefined, () => NOW, false, 4, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "work"
        ? {
          ...stage,
          loop: {
            over: "execution_plan.units",
            max_parallel: 4,
            max_rounds: 1,
            body: ["work"],
          },
        }
        : stage.id === "verify"
          ? {
            ...stage,
            loop: {
              over: "selection.personas",
              max_parallel: 2,
              max_rounds: 1,
              body: ["verify"],
            },
          }
          : stage),
    }), Object.freeze({ max_concurrent_attempts: 4 }));
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const candidates = [0, 1, 2].map((memberIndex) => attempt({
        id: `attempt-width-${memberIndex}`,
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: {
          kind: "fanout_member",
          stage_id: "verify",
          parent_attempt_id: "attempt-width-0",
          fanout_id: "selection.personas",
          member_id: `persona-${memberIndex}`,
          member_index: memberIndex,
        },
      }));
      context.store.admitPipelineRun({
        ...context.admission,
        run: run(candidates, bundleHash, "verify"),
        initial_attempts: candidates,
      });

      for (const memberIndex of [0, 1]) {
        await expect(context.store.leaseNextEligibleAttempt({
          worker_id: "worker-1",
          lease_id: `lease-width-${memberIndex}`,
          expires_at: "2026-08-20T12:05:00.000Z",
        })).resolves.toMatchObject({ attempt: { id: `attempt-width-${memberIndex}` } });
      }
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-width-2",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
    } finally {
      context.db.close();
    }
  });

  it("lets result correction reclaim only its own held slot while another slot remains usable", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const structured = (id: string, memberIndex: number, extra: Partial<KernelAttempt> = {}) =>
        attempt({
          id,
          pipeline_run_id: "run-1",
          definition_bundle_hash: bundleHash,
          repository_authority: "inspect",
          scope: {
            kind: "fanout_member",
            stage_id: "verify",
            parent_attempt_id: "attempt-correction",
            fanout_id: "selection.personas",
            member_id: `persona-${memberIndex}`,
            member_index: memberIndex,
          },
          ...extra,
        });
      const correction = structured("attempt-correction", 0, {
        status: "result_pending",
        native_session_id: "session-correction",
        result_correction_deadline: "2026-08-20T12:10:00.000Z",
        pending_result: {
          candidate_hash: null,
          diagnostics: [{ path: "payload.summary", detail: "must be a string" }],
          invalid_result_evidence: null,
        },
      });
      const distinct = structured("attempt-distinct-slot", 1);
      const colliding = structured("attempt-same-slot", 2);
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([correction, distinct, colliding], bundleHash, "verify"),
        initial_attempts: [correction, distinct, colliding],
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-correction",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({
        attempt: { id: "attempt-correction" },
        lease: { purpose: "result_correction" },
      });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-distinct-slot",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-distinct-slot" } });
      expect(context.db.prepare(
        "SELECT lease_id FROM attempts WHERE id = 'attempt-same-slot'",
      ).get()).toEqual({ lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("keeps a work-complete slot claimed until its follow-up transition is durable", async () => {
    const context = setup(undefined, () => NOW, false, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const structured = (id: string, memberIndex: number, status: KernelAttempt["status"] = "pending") =>
        attempt({
          id,
          pipeline_run_id: "run-1",
          definition_bundle_hash: bundleHash,
          repository_authority: "inspect",
          status,
          scope: {
            kind: "loop_item",
            stage_id: "verify",
            parent_attempt_id: "attempt-complete",
            loop_id: "selection.personas",
            item_id: `persona-${memberIndex}`,
            item_index: memberIndex,
          },
        });
      const complete = structured("attempt-complete", 0, "work_complete");
      const colliding = structured("attempt-colliding", 2);
      const distinct = structured("attempt-distinct", 1);
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([complete, colliding, distinct], bundleHash, "verify"),
        initial_attempts: [complete, colliding, distinct],
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-distinct",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-distinct" } });
      expect(context.db.prepare(
        "SELECT lease_id FROM attempts WHERE id = 'attempt-colliding'",
      ).get()).toEqual({ lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("reserves every runtime-pool slot before a provision Attempt schedules create effects", async () => {
    const context = setup(undefined, () => NOW, true, 2, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const provision = (id: string, runId: string) => attempt({
        id,
        pipeline_run_id: runId,
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: { kind: "stage", stage_id: RUNTIME_PROVISION_STAGE_ID },
      });
      const first = provision("attempt-provision-1", "run-1");
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([first], bundleHash, RUNTIME_PROVISION_STAGE_ID),
        initial_attempts: [first],
      });
      const second = provision("attempt-provision-2", "run-2");
      context.store.admitPipelineRun({
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-2",
          source_id: "issue-2",
          source_reference: "OPE-2",
        },
        run: {
          ...run([second], bundleHash, RUNTIME_PROVISION_STAGE_ID),
          id: "run-2",
          active_attempt_versions: { [second.id]: second.version },
        },
        initial_attempts: [second],
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-provision-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ run_id: "run-1" });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-provision-2",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
    } finally {
      context.db.close();
    }
  });

  it("leases an authenticated pool wider than the mutable execution width", async () => {
    const context = setup(undefined, () => NOW, true, 1, (candidate) => ({
      ...candidate,
      stages: candidate.stages.map((stage) => stage.id === "verify"
        ? {
          ...stage,
          loop: {
            over: "selection.personas",
            max_parallel: 2,
            max_rounds: 1,
            body: ["verify"],
          },
        }
        : stage),
    }), EXECUTION_POLICY_TWO);
    try {
      const bundleHash = context.admission.run.definition_bundle_hash;
      const provision = attempt({
        id: "attempt-provision",
        pipeline_run_id: "run-1",
        definition_bundle_hash: bundleHash,
        repository_authority: "inspect",
        scope: { kind: "stage", stage_id: RUNTIME_PROVISION_STAGE_ID },
      });
      context.store.admitPipelineRun({
        ...context.admission,
        run: run([provision], bundleHash, RUNTIME_PROVISION_STAGE_ID),
        initial_attempts: [provision],
      });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-provision",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ attempt: { id: "attempt-provision" } });
    } finally {
      context.db.close();
    }
  });

  it("counts each active uncleaned create target instead of one reservation per run", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      const second = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [second]);
      context.db.prepare(
        "UPDATE attempts SET unmet_dependency_count = 1 WHERE id = 'attempt-1'",
      ).run();
      for (const [marker, target] of [["create-a", "daytona:resource-a"], ["create-b", "daytona:resource-b"]]) {
        seedConfirmedRuntimeEffect(context, {
          run_id: "run-1",
          kind: "daytona/create-sandbox@1",
          sequence: marker === "create-a" ? 1 : 3,
          marker,
          target,
        });
      }

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-over-target-budget",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
    } finally {
      context.db.close();
    }
  });

  it("keeps confirmed sandboxes inside the width budget until cleanup is confirmed", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      const second = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      const third = attempt({
        id: "attempt-3",
        pipeline_run_id: "run-3",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [second]);
      admitAdditionalRun(context, "run-3", 3, [third]);
      seedConfirmedRuntimeEffect(context, {
        run_id: "run-1",
        kind: "daytona/create-sandbox@1",
        sequence: 1,
      });
      seedConfirmedRuntimeEffect(context, {
        run_id: "run-2",
        kind: "daytona/create-sandbox@1",
        sequence: 1,
      });

      const reservedRunLease = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-reserved-run",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      expect(reservedRunLease).toMatchObject({ run_id: "run-1" });
      context.db.prepare(`
        UPDATE attempts SET status = 'failed', version = version + 1,
          lease_id = NULL, lease_generation = NULL, lease_worker_id = NULL,
          lease_purpose = NULL, lease_expires_at = NULL, lease_started = NULL,
          updated_at = ?
        WHERE id = 'attempt-1'
      `).run(NOW);
      context.db.prepare(
        "UPDATE attempts SET unmet_dependency_count = 1 WHERE id = 'attempt-2'",
      ).run();

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-over-sandbox-budget",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
      expect(context.db.prepare(
        "SELECT status, lease_id FROM attempts WHERE id = 'attempt-3'",
      ).get()).toEqual({ status: "pending", lease_id: null });

      seedConfirmedRuntimeEffect(context, {
        run_id: "run-1",
        kind: "daytona/cleanup-sandbox@1",
        sequence: 3,
      });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-after-cleanup",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ run_id: "run-3", attempt: { id: "attempt-3" } });
    } finally {
      context.db.close();
    }
  });

  it("excludes terminal sandbox reservations from width while live reservations still count", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      for (const ordinal of [2, 3, 4, 5]) {
        const candidate = attempt({
          id: `attempt-${ordinal}`,
          pipeline_run_id: `run-${ordinal}`,
          definition_bundle_hash: bundleHash,
        });
        admitAdditionalRun(context, `run-${ordinal}`, ordinal, [candidate]);
      }
      for (const runId of ["run-1", "run-2", "run-3"]) {
        seedConfirmedRuntimeEffect(context, {
          run_id: runId,
          kind: "daytona/create-sandbox@1",
          sequence: 1,
        });
      }
      context.db.prepare(`
        UPDATE pipeline_runs SET status = 'needs_human', terminal_outcome = 'needs_human',
          cursor_stage_id = NULL, updated_at = ?
        WHERE id IN ('run-1', 'run-2')
      `).run(NOW);
      context.db.prepare(`
        UPDATE attempts SET status = 'needs_human', version = version + 1, updated_at = ?
        WHERE pipeline_run_id IN ('run-1', 'run-2')
      `).run(NOW);
      context.db.prepare(
        "UPDATE attempts SET unmet_dependency_count = 1 WHERE id = 'attempt-3'",
      ).run();

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-with-terminal-reservations",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ run_id: "run-4", attempt: { id: "attempt-4" } });

      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-over-live-reservation-budget",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
      expect(context.db.prepare(
        "SELECT status, lease_id FROM attempts WHERE id = 'attempt-5'",
      ).get()).toEqual({ status: "pending", lease_id: null });
    } finally {
      context.db.close();
    }
  });

  it("leaves a newly ready Attempt queued while width is saturated and leases it after a slot settles", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      const second = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      const third = attempt({
        id: "attempt-3",
        pipeline_run_id: "run-3",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [second]);
      admitAdditionalRun(context, "run-3", 3, [third]);
      context.db.prepare(
        "UPDATE attempts SET unmet_dependency_count = 1 WHERE id = 'attempt-3'",
      ).run();

      for (const ordinal of [1, 2]) {
        await expect(context.store.leaseNextEligibleAttempt({
          worker_id: "worker-1",
          lease_id: `lease-${ordinal}`,
          expires_at: "2026-08-20T12:05:00.000Z",
        })).resolves.not.toBeNull();
      }
      context.db.prepare(
        "UPDATE attempts SET unmet_dependency_count = 0 WHERE id = 'attempt-3'",
      ).run();
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-saturated",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toBeNull();
      expect(context.db.prepare(
        "SELECT status, lease_id FROM attempts WHERE id = 'attempt-3'",
      ).get()).toEqual({ status: "pending", lease_id: null });

      context.db.prepare(`
        UPDATE attempts SET status = 'failed', version = version + 1,
          lease_id = NULL, lease_generation = NULL, lease_worker_id = NULL,
          lease_purpose = NULL, lease_expires_at = NULL, lease_started = NULL,
          updated_at = ?
        WHERE id = 'attempt-1'
      `).run(NOW);
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-next-cycle",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).resolves.toMatchObject({ run_id: "run-3", attempt: { id: "attempt-3" } });
    } finally {
      context.db.close();
    }
  });

  it("settles two cross-run leases through real persistence in reverse completion order", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      const second = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [second]);
      const leases = await Promise.all([
        context.store.leaseNextEligibleAttempt({
          worker_id: "worker-1",
          lease_id: "lease-1",
          expires_at: "2026-08-20T12:05:00.000Z",
        }),
        context.store.leaseNextEligibleAttempt({
          worker_id: "worker-1",
          lease_id: "lease-2",
          expires_at: "2026-08-20T12:05:00.000Z",
        }),
      ]);
      if (!leases[0] || !leases[1]) throw new Error("expected two cross-run leases");

      const prepareSettlement = async (
        leased: NonNullable<(typeof leases)[number]>,
        ordinal: number,
      ): Promise<AtomicTransitionBundle> => {
        let view = await context.store.loadExactReductionView({
          pipeline_run_id: leased.run_id,
          attempt_id: leased.attempt.id,
          record_ids: [],
          checkpoint_ids: [],
        });
        await context.store.applyAtomicTransition(reduceKernelCommand({
          ...view,
          command: {
            type: "start",
            command_id: `start-${ordinal}`,
            attempt_id: leased.attempt.id,
            lease_id: leased.lease.id,
          },
        }));
        view = await context.store.loadExactReductionView({
          pipeline_run_id: leased.run_id,
          attempt_id: leased.attempt.id,
          record_ids: [],
          checkpoint_ids: [],
        });
        const running = view.current_attempt!;
        const lease = running.lease!;
        await context.store.applyAtomicTransition(reduceKernelCommand({
          ...view,
          command: {
            type: "bind_runtime_session",
            command_id: `bind-${ordinal}`,
            attempt_id: running.id,
            expected_run_version: view.run.version,
            expected_cursor_version: view.run.cursor.version,
            expected_attempt_version: running.version,
            request_hash: running.request_hash,
            definition_bundle_hash: running.definition_bundle_hash,
            input_subject: running.input_subject,
            lease_id: lease.id,
            worker_id: lease.worker_id,
            lease_purpose: lease.purpose,
            expected_lease_expires_at: lease.expires_at,
            expected_work_retry_ordinal: running.work_retry_ordinal,
            expected_result_correction_count: running.result_correction_count,
            native_session_id: `session-${ordinal}`,
          },
        }));
        view = await context.store.loadExactReductionView({
          pipeline_run_id: leased.run_id,
          attempt_id: leased.attempt.id,
          record_ids: [],
          checkpoint_ids: [],
        });
        const bound = view.current_attempt!;
        const outputSubject = subject(String(ordinal + 1));
        const checkpoint: AttemptCheckpoint = {
          schema: ATTEMPT_CHECKPOINT_SCHEMA,
          id: `checkpoint-${ordinal}`,
          pipeline_run_id: leased.run_id,
          attempt_id: bound.id,
          request_hash: bound.request_hash,
          definition_bundle_hash: bound.definition_bundle_hash,
          input_subject: bound.input_subject,
          output_subject: outputSubject,
          native_session_id: `session-${ordinal}`,
          payload_schema: "checkpoint/v1",
          payload: { inline: { complete: true } },
          captured_at: NOW,
        };
        await context.store.applyAtomicTransition(reduceKernelCommand({
          ...view,
          checkpoints: exactMap(checkpoint),
          command: {
            type: "work_complete",
            command_id: `work-complete-${ordinal}`,
            attempt_id: bound.id,
            checkpoint_id: checkpoint.id,
            verified_output_subject: outputSubject,
            result_record_id: null,
          },
        }));
        view = await context.store.loadExactReductionView({
          pipeline_run_id: leased.run_id,
          attempt_id: leased.attempt.id,
          record_ids: [],
          checkpoint_ids: [checkpoint.id],
        });
        const completed = view.current_attempt!;
        const result: ResultRecord = {
          schema: EXECUTION_RECORD_SCHEMA,
          id: `result-${ordinal}`,
          kind: "result",
          pipeline_run_id: leased.run_id,
          attempt_id: completed.id,
          request_hash: completed.request_hash,
          definition_bundle_hash: completed.definition_bundle_hash,
          input_subject: completed.input_subject,
          output_subject: outputSubject,
          original_candidate_hash: sha(String(ordinal + 2)),
          normalized_candidate_hash: sha(String(ordinal + 3)),
          payload_schema: "result/v1",
          payload: { inline: { outcome: "success" } },
          created_at: NOW,
        };
        await context.store.applyAtomicTransition(reduceKernelCommand({
          ...view,
          records: exactMap(result),
          command: {
            type: "record",
            command_id: `record-${ordinal}`,
            attempt_id: completed.id,
            record_id: result.id,
          },
        }));
        const recorded = await context.store.loadExactReductionView({
          pipeline_run_id: leased.run_id,
          attempt_id: leased.attempt.id,
          record_ids: [result.id],
          checkpoint_ids: [],
        });
        const decision: DecisionRecord = {
          schema: EXECUTION_RECORD_SCHEMA,
          id: `decision-${ordinal}`,
          kind: "decision",
          pipeline_run_id: leased.run_id,
          reducer: "core/advance@1",
          input_record_ids: [result.id],
          payload_schema: "decision/v1",
          payload: { inline: { outcome: "success" } },
          created_at: NOW,
        };
        const next = attempt({
          id: `attempt-${ordinal}-verify`,
          pipeline_run_id: leased.run_id,
          scope: { kind: "stage", stage_id: "verify" },
          repository_authority: "inspect",
          request_hash: sha(String(ordinal + 4)),
          definition_bundle_hash: bundleHash,
          input_subject: outputSubject,
        });
        return reduceKernelCommand({
          ...recorded,
          records: exactMap<ResultRecord | DecisionRecord>(result, decision),
          command: {
            type: "settle",
            command_id: `settle-${ordinal}`,
            attempt_id: recorded.current_attempt!.id,
            decision_record_id: decision.id,
            outcome: "success",
            next_attempts: [next],
          },
        });
      };

      const [firstSettlement, secondSettlement] = await Promise.all([
        prepareSettlement(leases[0], 1),
        prepareSettlement(leases[1], 2),
      ]);
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const commitOrder: string[] = [];
      const firstCommit = firstMayCommit.then(async () => {
        const applied = await context.store.applyAtomicTransition(firstSettlement);
        commitOrder.push("run-1");
        return applied;
      });
      const secondCommit = context.store.applyAtomicTransition(secondSettlement).then((applied) => {
        commitOrder.push("run-2");
        return applied;
      });
      await expect(secondCommit).resolves.toMatchObject({ disposition: "applied" });
      releaseFirst();
      await expect(firstCommit).resolves.toMatchObject({ disposition: "applied" });

      expect(commitOrder).toEqual(["run-2", "run-1"]);
      expect(context.db.prepare(`
        SELECT pipeline_run_id, status, lease_id FROM attempts
        WHERE id IN ('attempt-1', 'attempt-2') ORDER BY pipeline_run_id
      `).all()).toEqual([
        { pipeline_run_id: "run-1", status: "settled", lease_id: null },
        { pipeline_run_id: "run-2", status: "settled", lease_id: null },
      ]);
    } finally {
      context.db.close();
    }
  });

  it("keeps lease-generation fences isolated during concurrent cross-run settlement", async () => {
    const context = setup(undefined, () => NOW, false, 2);
    try {
      context.store.admitPipelineRun(context.admission);
      const bundleHash = context.admission.run.definition_bundle_hash;
      const second = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: bundleHash,
      });
      admitAdditionalRun(context, "run-2", 2, [second]);
      const firstLease = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:01:00.000Z",
      });
      const secondLease = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-2",
        expires_at: "2026-08-20T12:01:00.000Z",
      });
      if (!firstLease || !secondLease) throw new Error("expected two cross-run leases");
      const firstView = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1", attempt_id: "attempt-1", record_ids: [], checkpoint_ids: [],
      });
      const secondView = await context.store.loadExactReductionView({
        pipeline_run_id: "run-2", attempt_id: "attempt-2", record_ids: [], checkpoint_ids: [],
      });
      const firstStart = reduceKernelCommand({
        ...firstView,
        command: { type: "start", command_id: "start-1", attempt_id: "attempt-1", lease_id: "lease-1" },
      });
      const secondStart = reduceKernelCommand({
        ...secondView,
        command: { type: "start", command_id: "start-2", attempt_id: "attempt-2", lease_id: "lease-2" },
      });

      await context.store.recoverExpiredAttemptLeases({
        observed_at: "2026-08-20T12:01:00.000Z",
        expires_at: "2026-08-20T12:02:00.000Z",
        limit: 1,
      });
      const settlements = await Promise.allSettled([
        context.store.applyAtomicTransition(firstStart),
        context.store.applyAtomicTransition(secondStart),
      ]);

      expect(settlements[0]).toMatchObject({ status: "rejected" });
      expect(settlements[1]).toMatchObject({ status: "fulfilled", value: { disposition: "applied" } });
      expect(context.db.prepare(`
        SELECT id, lease_id, lease_generation, lease_started FROM attempts
        WHERE id IN ('attempt-1', 'attempt-2') ORDER BY id
      `).all()).toEqual([
        { id: "attempt-1", lease_id: "lease-1", lease_generation: 1, lease_started: 0 },
        { id: "attempt-2", lease_id: "lease-2", lease_generation: 0, lease_started: 1 },
      ]);
    } finally {
      context.db.close();
    }
  });

  it("atomically quarantines an exhausted unreadable run and releases the global Attempt slot", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const secondAttempt = attempt({
        id: "attempt-2",
        pipeline_run_id: "run-2",
        definition_bundle_hash: context.admission.run.definition_bundle_hash,
      });
      context.store.admitPipelineRun({
        ...context.admission,
        work_item: {
          ...context.admission.work_item,
          id: "work-2",
          source_id: "issue-2",
          source_reference: "OPE-2",
        },
        run: {
          ...run([secondAttempt], context.admission.run.definition_bundle_hash),
          id: "run-2",
          active_attempt_versions: { [secondAttempt.id]: secondAttempt.version },
        },
        initial_attempts: [secondAttempt],
      });
      const leased = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-poison",
        expires_at: "2026-08-20T12:01:00.000Z",
      });
      expect(leased?.attempt.id).toBe("attempt-1");
      await context.store.recoverExpiredAttemptLeases({
        observed_at: "2026-08-20T12:01:00.000Z",
        expires_at: "2026-08-20T12:02:00.000Z",
        limit: 1,
      });
      const [exhausted] = await context.store.recoverExpiredAttemptLeases({
        observed_at: "2026-08-20T12:02:00.000Z",
        expires_at: "2026-08-20T12:03:00.000Z",
        limit: 1,
      });
      if (!exhausted) throw new Error("expected exhausted recovery lease");
      writeFileSync(
        context.blobs.objectPath(context.admission.run.definition_bundle_hash),
        "corrupt definition bundle",
        "utf8",
      );
      const reason = "attempt_recovery_exhausted: runtime failed; terminal_preparation_failed: bundle unreadable";
      const diagnostic = createPipelineDecisionRecord({
        attempt: exhausted.attempt,
        result: null,
        evaluated: {
          evaluator: "core/executor-recovery-quarantine@1",
          outcome: "needs_human",
          reason,
        },
        created_at: NOW,
      });

      await expect(context.store.quarantineExhaustedAttemptRecovery({
        claim: captureAttemptLeaseClaim(exhausted),
        diagnostic,
        reason,
      })).resolves.toBe(true);
      expect(context.db.prepare("SELECT status, terminal_outcome FROM pipeline_runs WHERE id = 'run-1'").get())
        .toEqual({ status: "needs_human", terminal_outcome: "needs_human" });
      expect(context.db.prepare("SELECT status, lease_id FROM attempts WHERE id = 'attempt-1'").get())
        .toEqual({ status: "needs_human", lease_id: null });
      expect(context.db.prepare("SELECT kind, reducer FROM records WHERE id = ?").get(diagnostic.id))
        .toEqual({ kind: "decision", reducer: "core/executor-recovery-quarantine@1" });
      await expect(context.store.leaseNextEligibleAttempt({
        worker_id: "worker-2",
        lease_id: "lease-next",
        expires_at: "2026-08-20T12:04:00.000Z",
      })).resolves.toMatchObject({ run_id: "run-2", attempt: { id: "attempt-2" } });
    } finally {
      context.db.close();
    }
  });

  it("applies a reducer bundle atomically and distinguishes replay, conflict, and stale commands", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const claimed = await context.store.leaseNextEligibleAttempt({
        worker_id: "worker-1",
        lease_id: "lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      if (!claimed) throw new Error("expected claim");
      const view = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1", attempt_id: "attempt-1", record_ids: [], checkpoint_ids: [],
      });
      const start = reduceKernelCommand({
        ...view,
        command: { type: "start", command_id: "start-1", attempt_id: "attempt-1", lease_id: "lease-1" },
      });
      const delayed = reduceKernelCommand({
        ...view,
        command: { type: "start", command_id: "start-delayed", attempt_id: "attempt-1", lease_id: "lease-1" },
      });
      const startWrite = start.attempt_writes[0];
      if (!startWrite || startWrite.kind !== "replace" || !startWrite.attempt.lease) {
        throw new Error("expected the start transition to preserve its live lease");
      }
      const { content_hash: _contentHash, ...startContent } = start;
      const forgedContent: AtomicTransitionBundleContent = {
        ...startContent,
        attempt_writes: [{
          kind: "replace",
          attempt: {
            ...startWrite.attempt,
            lease: { ...startWrite.attempt.lease, generation: 1 },
          },
        }],
      };
      await expect(context.store.applyAtomicTransition({
        ...forgedContent,
        content_hash: digestCanonicalJson(forgedContent),
      })).rejects.toThrow(/lease claim cannot change/);
      expect(await context.store.applyAtomicTransition(start)).toEqual({ disposition: "applied", run_version: 2 });
      expect(await context.store.applyAtomicTransition(start)).toEqual({ disposition: "replayed", run_version: 2 });
      await expect(context.store.applyAtomicTransition(conflictingReplay(start))).rejects.toThrow(/conflicts/);
      await expect(context.store.applyAtomicTransition(delayed)).rejects.toThrow(/stale/);
    } finally {
      context.db.close();
    }
  });

  it("persists a core/publish promotion whose sealed parent differs from its Attempt input", async () => {
    const context = setup();
    try {
      const privateCandidate = subject("1");
      const publicationParent = subject("8");
      const publishedSubject = subject("2");
      Object.assign(context.pipelineManifest, {
        entry_stage: "publish",
        stages: [{
          id: "publish",
          kind: "effect",
          effect: "core/publish@1",
          on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
        }],
      } satisfies Partial<CompiledPipelineManifest>);
      const publicationAttempt = attempt({
        ...context.admission.initial_attempts[0],
        scope: { kind: "stage", stage_id: "publish" },
        repository_authority: "inspect",
        input_subject: privateCandidate,
      });
      context.admission.initial_attempts = [publicationAttempt];
      context.admission.run = {
        ...context.admission.run,
        current_subject: privateCandidate,
        cursor: compileKernelCursor({
          stage_id: "publish",
          version: 0,
          attempts: [publicationAttempt],
        }),
        active_attempt_versions: { [publicationAttempt.id]: publicationAttempt.version },
      };
      context.store.admitPipelineRun(context.admission);

      const planningCheckpoint: AttemptCheckpoint = {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: "checkpoint-publication-plan",
        pipeline_run_id: publicationAttempt.pipeline_run_id,
        attempt_id: publicationAttempt.id,
        request_hash: publicationAttempt.request_hash,
        definition_bundle_hash: publicationAttempt.definition_bundle_hash,
        input_subject: privateCandidate,
        output_subject: null,
        native_session_id: null,
        payload_schema: "openthrottle.external-boundary-checkpoint/v1",
        payload: { inline: {
          schema: "openthrottle.external-boundary-checkpoint/v1",
          external_kind: "core/publish@1",
          subject_policy: "advance",
          plan_digest: sha("9"),
          evidence: { publication_parent_subject: publicationParent },
        } },
        captured_at: NOW,
      };
      context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO checkpoints (
            id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
            request_hash, definition_bundle_hash, input_subject, output_subject,
            native_session_id, payload_schema, inline_payload, captured_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        `).run(
          planningCheckpoint.id,
          planningCheckpoint.pipeline_run_id,
          planningCheckpoint.attempt_id,
          digestCanonicalJson(planningCheckpoint),
          planningCheckpoint.payload_schema,
          planningCheckpoint.request_hash,
          planningCheckpoint.definition_bundle_hash,
          planningCheckpoint.input_subject,
          planningCheckpoint.payload_schema,
          canonicalJson((planningCheckpoint.payload as { inline: unknown }).inline),
          planningCheckpoint.captured_at,
        );
        context.db.prepare(`
          UPDATE attempts SET status = 'work_complete', version = 1,
            checkpoint_id = ?, output_subject = NULL, updated_at = ?
          WHERE id = ?
        `).run(planningCheckpoint.id, NOW, publicationAttempt.id);
        context.db.prepare(`
          UPDATE pipeline_runs SET status = 'running', version = 1, updated_at = ?
          WHERE id = ?
        `).run(NOW, publicationAttempt.pipeline_run_id);
      }).immediate();

      const promotedBlob = context.blobs.put({
        bytes: new TextEncoder().encode("sealed publication bundle"),
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      }).pointer;
      const promotedCheckpoint: AttemptCheckpoint = {
        ...planningCheckpoint,
        id: "checkpoint-publication-output",
        input_subject: privateCandidate,
        output_subject: publishedSubject,
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        payload: { blob: promotedBlob },
      };
      const integrationEffect: EffectIntent = {
        schema: EFFECT_INTENT_SCHEMA,
        id: "effect-publication-integrate",
        pipeline_run_id: publicationAttempt.pipeline_run_id,
        decision_record_id: "decision-publication-integrate",
        kind: "daytona/integrate-checkpoint@1",
        idempotency_key: "run-1:publication-integrate",
        target: "daytona:publication",
        subject: null,
        payload: { schema: "openthrottle.daytona-integration/v1" },
      };
      const delivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "delivery-publication-integrate",
        kind: "delivery",
        pipeline_run_id: publicationAttempt.pipeline_run_id,
        effect_id: integrationEffect.id,
        idempotency_key: integrationEffect.idempotency_key,
        external_identity: integrationEffect.target,
        status: "confirmed",
        payload_schema: "openthrottle.effect-delivery/v1",
        payload: { inline: {
          effect_kind: "daytona/integrate-checkpoint@1",
          provider: "daytona",
          result: {
            schema: "openthrottle.daytona-integration-delivery/v1",
            state: "integrated",
            pipeline_run_id: publicationAttempt.pipeline_run_id,
            attempt_id: publicationAttempt.id,
            effect_id: integrationEffect.id,
            idempotency_key: integrationEffect.idempotency_key,
            input_subject: publicationParent,
            output_subject: publishedSubject,
            checkpoint_id: promotedCheckpoint.id,
            checkpoint_payload_schema: promotedCheckpoint.payload_schema,
            checkpoint_blob: promotedBlob as unknown as JsonValue,
          },
        } },
        created_at: NOW,
      };
      const view = await context.store.loadExactReductionView({
        pipeline_run_id: publicationAttempt.pipeline_run_id,
        attempt_id: publicationAttempt.id,
        record_ids: [],
        checkpoint_ids: [planningCheckpoint.id],
      });
      const transition = reduceKernelCommand({
        ...view,
        records: exactMap(delivery),
        checkpoints: exactMap(planningCheckpoint, promotedCheckpoint),
        command: {
          type: "advance_external_subject",
          command_id: "advance-publication-subject",
          attempt_id: publicationAttempt.id,
          prior_checkpoint_id: planningCheckpoint.id,
          checkpoint_id: promotedCheckpoint.id,
          delivery_record_id: delivery.id,
          verified_output_subject: publishedSubject,
        },
      });

      await expect(context.store.applyAtomicTransition(transition)).resolves.toEqual({
        disposition: "applied",
        run_version: view.run.version + 1,
      });
      expect(context.db.prepare(`
        SELECT ordinal, input_subject, output_subject FROM checkpoints WHERE id = ?
      `).get(promotedCheckpoint.id)).toEqual({
        ordinal: 1,
        input_subject: privateCandidate,
        output_subject: publishedSubject,
      });
    } finally {
      context.db.close();
    }
  });

  it.each(["missing", "corrupt"] as const)(
    "rejects %s invalid-result evidence before the result_pending transition commits",
    async (damage) => {
      const context = setup();
      try {
        context.store.admitPipelineRun(context.admission);
        const invalidResultEvidence = putInvalidResultEvidence(context.blobs);
        const transition = await prepareResultPendingTransition(context, invalidResultEvidence);
        if (damage === "missing") {
          rmSync(context.blobs.objectPath(invalidResultEvidence.digest));
        } else {
          writeFileSync(
            context.blobs.objectPath(invalidResultEvidence.digest),
            Buffer.alloc(invalidResultEvidence.bytes, 0x78),
          );
        }

        await expect(context.store.applyAtomicTransition(transition))
          .rejects.toThrow(/failed integrity verification/);
        expect(context.db.prepare(`
          SELECT status, version, pending_candidate_hash, pending_diagnostics_json
          FROM attempts WHERE id = 'attempt-1'
        `).get()).toEqual({
          status: "work_complete",
          version: transition.expected.attempt_versions["attempt-1"],
          pending_candidate_hash: null,
          pending_diagnostics_json: null,
        });
        expect(context.db.prepare("SELECT version FROM pipeline_runs WHERE id = 'run-1'").get())
          .toEqual({ version: transition.expected.run_version });
      } finally {
        context.db.close();
      }
    },
  );

  it.each([
    ["encoding", { encoding: "binary" }],
    ["media type", { media_type: "application/octet-stream" }],
    ["payload schema", { payload_schema: "openthrottle.attempt-forensics/v1" }],
  ] as const)("rejects invalid-result evidence with noncanonical pointer %s", async (_label, override) => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const validPointer = putInvalidResultEvidence(context.blobs);
      const invalidPointer: BlobPointer = { ...validPointer, ...override };
      const transition = await prepareResultPendingTransition(context, validPointer);
      const { content_hash: _contentHash, ...content } = transition;
      const invalidContent: AtomicTransitionBundleContent = {
        ...content,
        attempt_writes: content.attempt_writes.map((write) => write.kind === "terminal"
          ? write
          : {
            ...write,
            attempt: {
              ...write.attempt,
              pending_result: {
                ...write.attempt.pending_result!,
                invalid_result_evidence: invalidPointer,
              },
            },
          }),
      };
      const invalidTransition: AtomicTransitionBundle = {
        ...invalidContent,
        content_hash: digestCanonicalJson(invalidContent),
      };

      await expect(context.store.applyAtomicTransition(invalidTransition))
        .rejects.toThrow(/invalid-result evidence pointer is not canonical JSON/);
      expect(context.db.prepare(`
        SELECT status, pending_candidate_hash, pending_diagnostics_json
        FROM attempts WHERE id = 'attempt-1'
      `).get()).toEqual({
        status: "work_complete",
        pending_candidate_hash: null,
        pending_diagnostics_json: null,
      });
    } finally {
      context.db.close();
    }
  });

  it("blocks active Attempt loads after restart when invalid-result evidence becomes corrupt", async () => {
    const context = setup();
    let originalClosed = false;
    let reopenedDb: Database.Database | undefined;
    try {
      context.store.admitPipelineRun(context.admission);
      const invalidResultEvidence = putInvalidResultEvidence(context.blobs);
      const transition = await prepareResultPendingTransition(context, invalidResultEvidence);
      await context.store.applyAtomicTransition(transition);
      writeFileSync(
        context.blobs.objectPath(invalidResultEvidence.digest),
        Buffer.alloc(invalidResultEvidence.bytes, 0x78),
      );
      context.db.close();
      originalClosed = true;
      const reopened = reopenStore(context);
      reopenedDb = reopened.db;

      await expect(reopened.store.loadExactReductionView({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        record_ids: [],
        checkpoint_ids: [],
      })).rejects.toMatchObject({
        name: "KernelIntegrityError",
        code: "KERNEL_BLOB_INTEGRITY",
        evidence: {
          pipeline_run_id: "run-1",
          owner_kind: "attempt",
          owner_id: "attempt-1",
          digest: invalidResultEvidence.digest,
          classification: "active_blocking",
          operator_action: "restore_verified_blob_or_abandon_active_run",
          detail: "sha256 digest mismatch",
        },
      });
    } finally {
      reopenedDb?.close();
      if (!originalClosed) context.db.close();
    }
  });

  it("does not let an immutable Attempt lease replay after restart bypass evidence verification", async () => {
    const context = setup();
    let originalClosed = false;
    let reopenedDb: Database.Database | undefined;
    try {
      context.store.admitPipelineRun(context.admission);
      const invalidResultEvidence = putInvalidResultEvidence(context.blobs);
      const transition = await prepareResultPendingTransition(context, invalidResultEvidence);
      await context.store.applyAtomicTransition(transition);
      const request = {
        worker_id: "worker-result-correction",
        lease_id: "lease-result-correction",
        expires_at: "2026-08-20T12:20:00.000Z",
      };
      await expect(context.store.leaseNextEligibleAttempt(request)).resolves.toMatchObject({
        attempt: { status: "result_pending" },
        lease: { id: request.lease_id, purpose: "result_correction" },
      });
      writeFileSync(
        context.blobs.objectPath(invalidResultEvidence.digest),
        Buffer.alloc(invalidResultEvidence.bytes, 0x78),
      );
      context.db.close();
      originalClosed = true;
      const reopened = reopenStore(context);
      reopenedDb = reopened.db;

      await expect(reopened.store.leaseNextEligibleAttempt(request)).rejects.toMatchObject({
        name: "KernelIntegrityError",
        code: "KERNEL_BLOB_INTEGRITY",
        evidence: {
          owner_kind: "attempt",
          owner_id: "attempt-1",
          digest: invalidResultEvidence.digest,
          classification: "active_blocking",
        },
      });
    } finally {
      reopenedDb?.close();
      if (!originalClosed) context.db.close();
    }
  });

  it("atomically persists result_pending terminal cleanup without discarding completed-work evidence", async () => {
    const context = setup(undefined, () => NOW, true);
    try {
      context.store.admitPipelineRun(context.admission);
      const deliveryPayload = {
        effect_kind: "daytona/create-sandbox@1",
        provider: "daytona",
        observed_via: "reconciliation",
        result: { identity: sha("9"), sandbox_id: "sandbox-1" },
      };
      const delivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "delivery-runtime-create",
        kind: "delivery",
        pipeline_run_id: "run-1",
        effect_id: "effect-runtime-create",
        idempotency_key: "run-1:runtime:create",
        external_identity: "daytona:sandbox-1",
        status: "confirmed",
        payload_schema: "openthrottle.effect-delivery/v1",
        payload: { inline: deliveryPayload },
        created_at: NOW,
      };
      const invalidEvidence = putInvalidResultEvidence(context.blobs, {
        phase: "result_correction",
        candidate_hash: sha("5"),
      });
      context.db.transaction(() => {
        context.db.prepare(`
          INSERT INTO checkpoints (
            id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
            request_hash, definition_bundle_hash, input_subject, output_subject,
            native_session_id, payload_schema, inline_payload, captured_at
          ) VALUES ('checkpoint-1', 'run-1', 'attempt-1', 0, ?, 'checkpoint/v1',
            ?, ?, ?, ?, 'session-1', 'checkpoint/v1', '{}', ?)
        `).run(sha("4"), sha("a"), context.admission.run.definition_bundle_hash, subject("1"), subject("2"), NOW);
        context.db.prepare(`
          UPDATE attempts SET status = 'result_pending', version = 1, output_subject = ?,
            native_session_id = 'session-1', checkpoint_id = 'checkpoint-1',
            result_correction_count = 2, result_correction_deadline = ?,
            pending_candidate_hash = ?, pending_diagnostics_json = ?
          WHERE id = 'attempt-1'
        `).run(subject("2"), "2026-08-20T12:15:00.000Z", sha("5"), canonicalJson({
          schema: "openthrottle.pending-result-diagnostics/v1",
          diagnostics: [{ path: "/payload", detail: "invalid" }],
          invalid_result_evidence: invalidEvidence,
        }));
        context.db.prepare("UPDATE pipeline_runs SET status = 'running' WHERE id = 'run-1'").run();
        context.db.prepare(`
          INSERT INTO records (
            id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
            inline_payload, reducer, input_record_ids_json, input_record_count, created_at
          ) VALUES ('decision-runtime-create', 'run-1', 1, ?, 'decision',
            'decision/v1', '{}', 'core/runtime-create@1', '[]', 0, ?)
        `).run(sha("6"), NOW);
        context.db.prepare(`
          INSERT INTO effects (
            id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
            payload_schema, inline_payload, intent_hash, status, version, attempt_count,
            available_at, delivery_record_id, created_at, updated_at
          ) VALUES ('effect-runtime-create', 'run-1', 'decision-runtime-create',
            'daytona/create-sandbox@1', ?, ?, 'daytona/create-sandbox@1', '{}', ?,
            'acknowledged', 1, 1, ?, ?, ?, ?)
        `).run(delivery.idempotency_key, delivery.external_identity, sha("7"), NOW, delivery.id, NOW, NOW);
        context.db.prepare(`
          INSERT INTO records (
            id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
            inline_payload, effect_id, idempotency_key, external_identity,
            delivery_status, created_at
          ) VALUES (?, 'run-1', 2, ?, 'delivery', ?, ?, ?, ?, ?, 'confirmed', ?)
        `).run(
          delivery.id,
          digestCanonicalJson(delivery),
          delivery.payload_schema,
          JSON.stringify(deliveryPayload),
          delivery.effect_id,
          delivery.idempotency_key,
          delivery.external_identity,
          NOW,
        );
      }).immediate();

      const pending = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        record_ids: [delivery.id],
        checkpoint_ids: [],
      });
      expect(pending.current_attempt?.pending_result?.invalid_result_evidence)
        .toEqual(invalidEvidence);
      const evidenceRecord = createInvalidResultEvidenceRecord({
        attempt: pending.current_attempt!,
        pointer: invalidEvidence,
        created_at: NOW,
      });
      const decision: DecisionRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "decision-result-correction-exhausted",
        kind: "decision",
        pipeline_run_id: "run-1",
        reducer: "core/result-correction-terminal@1",
        input_record_ids: [delivery.id, evidenceRecord.id].sort(),
        payload_schema: "decision/v1",
        payload: { inline: { outcome: "needs_human" } },
        created_at: NOW,
      };
      const cleanupAttempt = attempt({
        id: "attempt-cleanup-needs-human",
        scope: { kind: "stage", stage_id: runtimeStopStageId("needs_human") },
        repository_authority: "inspect",
        request_hash: sha("8"),
        definition_bundle_hash: pending.run.definition_bundle_hash,
        input_subject: pending.run.current_subject,
        context_record_ids: [decision.id, delivery.id, evidenceRecord.id].sort(),
      });
      const transition = reduceKernelCommand({
        ...pending,
        records: new Map<string, DecisionRecord | DeliveryRecord>([
          [decision.id, decision],
          [delivery.id, delivery],
          [evidenceRecord.id, evidenceRecord],
        ]),
        command: {
          type: "needs_human",
          command_id: "terminal-result-correction",
          attempt_id: "attempt-1",
          decision_record_id: decision.id,
          reason: "result_correction_budget_exhausted",
          resource_disposition: {
            kind: "cleanup",
            runtime_delivery_record_ids: [delivery.id],
            diagnostic_record_ids: [evidenceRecord.id],
            new_diagnostic_record_ids: [evidenceRecord.id],
            cleanup_attempt: cleanupAttempt,
          },
        },
      });

      await expect(context.store.applyAtomicTransition(transition)).resolves.toEqual({
        disposition: "applied",
        run_version: pending.run.version + 1,
      });
      expect(context.db.prepare(`
        SELECT status, output_subject, native_session_id, checkpoint_id,
          result_correction_count, result_correction_deadline, lease_id,
          result_record_id, decision_record_id, pending_candidate_hash,
          pending_diagnostics_json
        FROM attempts WHERE id = 'attempt-1'
      `).get()).toEqual({
        status: "needs_human",
        output_subject: subject("2"),
        native_session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        result_correction_count: 2,
        result_correction_deadline: null,
        lease_id: null,
        result_record_id: null,
        decision_record_id: null,
        pending_candidate_hash: null,
        pending_diagnostics_json: null,
      });
      expect(context.db.prepare("SELECT status FROM attempts WHERE id = ?").get(cleanupAttempt.id))
        .toEqual({ status: "pending" });
      expect(context.db.prepare(`
        SELECT reducer, payload_schema, blob_digest FROM records WHERE id = ?
      `).get(evidenceRecord.id)).toEqual({
        reducer: "core/invalid-result-evidence@1",
        payload_schema: "openthrottle.invalid-result-evidence/v1",
        blob_digest: invalidEvidence.digest,
      });
      expect(context.db.prepare("SELECT status, cursor_stage_id FROM pipeline_runs WHERE id = 'run-1'").get())
        .toEqual({ status: "running", cursor_stage_id: runtimeStopStageId("needs_human") });
    } finally {
      context.db.close();
    }
  });

  it.each([
    ["stop", "canceled"],
    ["supersede", "superseded"],
  ] as const)(
    "%s durably records selected and sibling result_pending evidence across replay and restart",
    async (type, terminalStatus) => {
      const context = setup(undefined, () => NOW, true);
      let originalClosed = false;
      let reopenedDb: Database.Database | undefined;
      try {
        const selectedPointer = putInvalidResultEvidence(context.blobs);
        const siblingPointer = putInvalidResultEvidence(context.blobs, {
          attempt_id: "attempt-2",
          candidate_hash: sha("f"),
          diagnostics: [{ path: "/payload/summary", detail: "sibling result is invalid" }],
        });
        const selected = attempt({
          ...context.admission.initial_attempts[0],
          id: "attempt-1",
          scope: {
            kind: "loop_item",
            stage_id: "work",
            parent_attempt_id: "attempt-1",
            loop_id: "execution_plan.units",
            item_id: "unit-a",
            item_index: 0,
          },
          status: "result_pending",
          output_subject: subject("2"),
          native_session_id: "session-selected",
          result_correction_count: 1,
          result_correction_deadline: "2026-08-20T12:15:00.000Z",
          pending_result: {
            candidate_hash: sha("e"),
            diagnostics: [{ path: "/payload", detail: "invalid" }],
            invalid_result_evidence: selectedPointer,
          },
        });
        const sibling = attempt({
          ...context.admission.initial_attempts[0],
          id: "attempt-2",
          scope: {
            kind: "loop_item",
            stage_id: "work",
            parent_attempt_id: "attempt-1",
            loop_id: "execution_plan.units",
            item_id: "unit-b",
            item_index: 1,
          },
          status: "result_pending",
          output_subject: subject("3"),
          native_session_id: "session-sibling",
          result_correction_count: 1,
          result_correction_deadline: "2026-08-20T12:15:00.000Z",
          pending_result: {
            candidate_hash: sha("f"),
            diagnostics: [{ path: "/payload/summary", detail: "sibling result is invalid" }],
            invalid_result_evidence: siblingPointer,
          },
        });
        context.admission.initial_attempts = [selected, sibling];
        context.admission.run = run(
          [selected, sibling],
          context.admission.run.definition_bundle_hash,
        );
        context.store.admitPipelineRun(context.admission);
        seedConfirmedRuntimeEffect(context, {
          run_id: "run-1",
          kind: "daytona/create-sandbox@1",
          sequence: 1,
        });

        const deliveryId = "delivery-run-1-create";
        const selectedView = await context.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: selected.id,
          record_ids: [deliveryId],
          checkpoint_ids: [],
        });
        const siblingView = await context.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: sibling.id,
          record_ids: [],
          checkpoint_ids: [],
        });
        const persistedSelected = selectedView.current_attempt!;
        const persistedSibling = siblingView.current_attempt!;
        const delivery = selectedView.records.get(deliveryId);
        if (!delivery || delivery.kind !== "delivery") {
          throw new Error("terminal evidence fixture requires its create DeliveryRecord");
        }
        const selectedEvidence = createInvalidResultEvidenceRecord({
          attempt: persistedSelected,
          pointer: selectedPointer,
          created_at: NOW,
        });
        const siblingEvidence = createInvalidResultEvidenceRecord({
          attempt: persistedSibling,
          pointer: siblingPointer,
          created_at: NOW,
        });
        const decision: DecisionRecord = {
          schema: EXECUTION_RECORD_SCHEMA,
          id: `decision-${type}-pending-evidence`,
          kind: "decision",
          pipeline_run_id: "run-1",
          reducer: `core/${type}@1`,
          input_record_ids: [delivery.id, selectedEvidence.id, siblingEvidence.id].sort(),
          payload_schema: "decision/v1",
          payload: { inline: { reason: type === "stop" ? "operator stop" : "new generation" } },
          created_at: NOW,
        };
        const cleanupAttempt = attempt({
          id: `attempt-cleanup-${type}`,
          scope: { kind: "stage", stage_id: runtimeStopStageId(terminalStatus) },
          repository_authority: "inspect",
          definition_bundle_hash: selectedView.run.definition_bundle_hash,
          input_subject: selectedView.run.current_subject,
          context_record_ids: [decision.id, ...decision.input_record_ids].sort(),
        });
        const diagnosticIds = [selectedEvidence.id, siblingEvidence.id].sort();
        const resourceDisposition = {
          kind: "cleanup" as const,
          runtime_delivery_record_ids: [delivery.id],
          diagnostic_record_ids: diagnosticIds,
          new_diagnostic_record_ids: diagnosticIds,
          cleanup_attempt: cleanupAttempt,
        };
        const command = type === "stop"
          ? {
            type,
            command_id: `terminal-${type}-pending-evidence`,
            decision_record_id: decision.id,
            reason: "operator stop",
            resource_disposition: resourceDisposition,
          } as const
          : {
            type,
            command_id: `terminal-${type}-pending-evidence`,
            decision_record_id: decision.id,
            reason: "new generation",
            resource_disposition: resourceDisposition,
          } as const;
        const records = new Map<string, DecisionRecord | DeliveryRecord>([
          [decision.id, decision],
          [delivery.id, delivery],
          [selectedEvidence.id, selectedEvidence],
          [siblingEvidence.id, siblingEvidence],
        ]);
        const transition = reduceKernelCommand({
          ...selectedView,
          records,
          command,
        });

        await expect(context.store.applyAtomicTransition(transition)).resolves.toEqual({
          disposition: "applied",
          run_version: selectedView.run.version + 1,
        });
        expect(context.db.prepare(`
          SELECT id, status, pending_candidate_hash, pending_diagnostics_json
          FROM attempts WHERE id IN ('attempt-1', 'attempt-2') ORDER BY id
        `).all()).toEqual([
          {
            id: "attempt-1",
            status: terminalStatus,
            pending_candidate_hash: null,
            pending_diagnostics_json: null,
          },
          {
            id: "attempt-2",
            status: terminalStatus,
            pending_candidate_hash: null,
            pending_diagnostics_json: null,
          },
        ]);
        expect(context.db.prepare(`
          SELECT id, reducer, blob_digest FROM records
          WHERE id IN (?, ?) ORDER BY id
        `).all(selectedEvidence.id, siblingEvidence.id)).toEqual([
          { id: selectedEvidence.id, pointer: selectedPointer },
          { id: siblingEvidence.id, pointer: siblingPointer },
        ].sort((left, right) => left.id.localeCompare(right.id)).map(({ id, pointer }) => ({
          id,
          reducer: "core/invalid-result-evidence@1",
          blob_digest: pointer.digest,
        })));
        await expect(context.store.applyAtomicTransition(transition)).resolves.toEqual({
          disposition: "replayed",
          run_version: selectedView.run.version + 1,
        });

        context.db.close();
        originalClosed = true;
        const reopened = reopenStore(context);
        reopenedDb = reopened.db;
        await expect(reopened.store.applyAtomicTransition(transition)).resolves.toEqual({
          disposition: "replayed",
          run_version: selectedView.run.version + 1,
        });
        const restartedSelected = await reopened.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: selected.id,
          record_ids: [decision.id, delivery.id, selectedEvidence.id, siblingEvidence.id],
          checkpoint_ids: [],
        });
        const restartedSibling = await reopened.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: sibling.id,
          record_ids: [],
          checkpoint_ids: [],
        });
        expect(restartedSelected.current_attempt).toMatchObject({
          id: selected.id,
          status: terminalStatus,
          pending_result: null,
        });
        expect(restartedSibling.current_attempt).toMatchObject({
          id: sibling.id,
          status: terminalStatus,
          pending_result: null,
        });
        expect(restartedSelected.records.get(selectedEvidence.id)).toEqual(selectedEvidence);
        expect(restartedSelected.records.get(siblingEvidence.id)).toEqual(siblingEvidence);
      } finally {
        reopenedDb?.close();
        if (!originalClosed) context.db.close();
      }
    },
  );

  it("restores structured planning correction evidence and fails closed on a missing decision input", async () => {
    const context = setup();
    let originalClosed = false;
    let reopenedDb: Database.Database | undefined;
    try {
      const structuredInitial = attempt({
        ...context.admission.initial_attempts[0],
        scope: {
          kind: "loop_item",
          stage_id: "work",
          parent_attempt_id: "attempt-1",
          loop_id: "execution_plan.units",
          item_id: "unit-a",
          item_index: 0,
        },
      });
      context.admission.initial_attempts = [structuredInitial];
      context.admission.run = run(
        [structuredInitial],
        context.admission.run.definition_bundle_hash,
      );
      context.store.admitPipelineRun(context.admission);

      const firstPointer = putInvalidResultEvidence(context.blobs);
      const firstPending = await prepareResultPendingTransition(context, firstPointer);
      await context.store.applyAtomicTransition(firstPending);

      const startCorrection = async (leaseId: string, commandId: string) => {
        await expect(context.store.leaseNextEligibleAttempt({
          worker_id: "worker-correction",
          lease_id: leaseId,
          expires_at: "2026-08-20T12:10:00.000Z",
        })).resolves.toMatchObject({
          attempt: { id: "attempt-1", status: "result_pending" },
          lease: { id: leaseId, purpose: "result_correction" },
        });
        const leased = await context.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: "attempt-1",
          record_ids: [],
          checkpoint_ids: [],
        });
        await context.store.applyAtomicTransition(reduceKernelCommand({
          ...leased,
          command: {
            type: "start",
            command_id: commandId,
            attempt_id: "attempt-1",
            lease_id: leaseId,
          },
        }));
        return context.store.loadExactReductionView({
          pipeline_run_id: "run-1",
          attempt_id: "attempt-1",
          record_ids: [],
          checkpoint_ids: ["checkpoint-result-pending"],
        });
      };

      const firstCorrection = await startCorrection(
        "lease-correction-1",
        "start-correction-1",
      );
      const correctionPointer = putInvalidResultEvidence(context.blobs, {
        phase: "result_correction",
        candidate_hash: sha("f"),
        diagnostics: [{ path: "/payload/summary", detail: "corrected summary is still invalid" }],
      });
      const correctionEvidence = createInvalidResultEvidenceRecord({
        attempt: firstCorrection.current_attempt!,
        pointer: correctionPointer,
        created_at: NOW,
      });
      await context.store.applyAtomicTransition(reduceKernelCommand({
        ...firstCorrection,
        records: exactMap(correctionEvidence),
        command: {
          type: "result_pending",
          command_id: "result-pending-correction-evidence",
          attempt_id: "attempt-1",
          candidate_hash: sha("f"),
          diagnostics: [{ path: "/payload/summary", detail: "corrected summary is still invalid" }],
          correction_deadline: "2026-08-20T12:15:00.000Z",
          invalid_result_evidence: correctionPointer,
          invalid_result_evidence_record_id: correctionEvidence.id,
        },
      }));

      const secondCorrection = await startCorrection(
        "lease-correction-2",
        "start-correction-2",
      );
      const correctedAttempt = secondCorrection.current_attempt!;
      const result: ResultRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "result-corrected-structured",
        kind: "result",
        pipeline_run_id: "run-1",
        attempt_id: correctedAttempt.id,
        request_hash: correctedAttempt.request_hash,
        definition_bundle_hash: correctedAttempt.definition_bundle_hash,
        input_subject: correctedAttempt.input_subject,
        output_subject: correctedAttempt.output_subject,
        original_candidate_hash: sha("7"),
        normalized_candidate_hash: sha("7"),
        payload_schema: "result/v1",
        payload: { inline: { outcome: "success" } },
        created_at: NOW,
      };
      const decision: DecisionRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "decision-corrected-structured",
        kind: "decision",
        pipeline_run_id: "run-1",
        reducer: "core/advance@1",
        input_record_ids: [result.id, correctionEvidence.id].sort(),
        payload_schema: "decision/v1",
        payload: { inline: { accepted: true } },
        created_at: NOW,
      };
      const next = attempt({
        id: "attempt-verify-corrected-structured",
        scope: {
          kind: "loop_item",
          stage_id: "verify",
          parent_attempt_id: "attempt-1",
          loop_id: "execution_plan.units",
          item_id: "unit-a",
          item_index: 0,
        },
        repository_authority: "inspect",
        definition_bundle_hash: secondCorrection.run.definition_bundle_hash,
        input_subject: subject("2"),
      });
      await context.store.applyAtomicTransition(reduceKernelCommand({
        ...secondCorrection,
        records: new Map<string, ResultRecord | DecisionRecord>([
          [result.id, result],
          [correctionEvidence.id, correctionEvidence],
          [decision.id, decision],
        ]),
        command: {
          type: "correct_and_settle",
          command_id: "correct-and-settle-structured",
          attempt_id: correctedAttempt.id,
          result_record_id: result.id,
          invalid_result_evidence_record_id: correctionEvidence.id,
          decision_record_id: decision.id,
          outcome: "success",
          next_attempts: [next],
        },
      }));

      const planningRequest = {
        pipeline_run_id: "run-1",
        definition_bundle_hash: secondCorrection.run.definition_bundle_hash,
        scope_kind: "loop_item" as const,
        parent_attempt_id: "attempt-1",
        scope_group_id: "execution_plan.units",
        stage_ids: ["work"],
        member_ids: ["unit-a"],
      };
      const settled = await context.store.listSettledStructuredPlanningAttempts(planningRequest);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.decision_input_records).toEqual([
        correctionEvidence,
        result,
      ].sort((left, right) => left.id.localeCompare(right.id)));

      context.db.close();
      originalClosed = true;
      const reopened = reopenStore(context);
      reopenedDb = reopened.db;
      expect(await reopened.store.listSettledStructuredPlanningAttempts(planningRequest))
        .toEqual(settled);
      reopened.db.prepare("DELETE FROM records WHERE id = ?").run(correctionEvidence.id);
      await expect(reopened.store.listSettledStructuredPlanningAttempts(planningRequest))
        .rejects.toThrow(/exact record context is missing an authorized record/);
    } finally {
      reopenedDb?.close();
      if (!originalClosed) context.db.close();
    }
  });

  it("persists result/decision/effect primitives and fences effect lease reconciliation", async () => {
    let currentTime = NOW;
    const context = setup(undefined, () => currentTime);
    try {
      const structuredInitial = attempt({
        ...context.admission.initial_attempts[0],
        scope: {
          kind: "loop_item",
          stage_id: "work",
          parent_attempt_id: "attempt-1",
          loop_id: "execution_plan.units",
          item_id: "unit-a",
          item_index: 0,
        },
      });
      context.admission.initial_attempts = [structuredInitial];
      context.admission.run = run(
        [structuredInitial],
        context.admission.run.definition_bundle_hash,
      );
      context.store.admitPipelineRun(context.admission);
      const started = await claimAndStart(context);
      const checkpoint: AttemptCheckpoint = {
        schema: ATTEMPT_CHECKPOINT_SCHEMA,
        id: "checkpoint-1",
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        request_hash: started.attempt.request_hash,
        definition_bundle_hash: started.attempt.definition_bundle_hash,
        input_subject: started.attempt.input_subject,
        output_subject: subject("2"),
        native_session_id: "session-1",
        payload_schema: "checkpoint/v1",
        payload: { inline: { complete: true } },
        captured_at: NOW,
      };
      await context.store.applyAtomicTransition(reduceKernelCommand({
        manifest: context.pipelineManifest,
        run: started.run,
        current_attempt: started.attempt,
        records: new Map(),
        checkpoints: exactMap(checkpoint),
        command: {
          type: "work_complete", command_id: "work-complete-1", attempt_id: "attempt-1",
          checkpoint_id: "checkpoint-1", verified_output_subject: subject("2"),
          result_record_id: null,
        },
      }));
      const completed = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1", attempt_id: "attempt-1", record_ids: [], checkpoint_ids: ["checkpoint-1"],
      });
      const result: ResultRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "result-1",
        kind: "result",
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        request_hash: completed.current_attempt!.request_hash,
        definition_bundle_hash: completed.current_attempt!.definition_bundle_hash,
        input_subject: completed.current_attempt!.input_subject,
        output_subject: subject("2"),
        original_candidate_hash: sha("5"),
        normalized_candidate_hash: sha("6"),
        payload_schema: "result/v1",
        payload: { inline: { outcome: "success" } },
        created_at: NOW,
      };
      await context.store.applyAtomicTransition(reduceKernelCommand({
        ...completed,
        records: exactMap(result),
        command: { type: "record", command_id: "record-1", attempt_id: "attempt-1", record_id: "result-1" },
      }));
      const recorded = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1", attempt_id: "attempt-1", record_ids: ["result-1"],
        checkpoint_ids: ["checkpoint-1"],
      });
      const decision: DecisionRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "decision-1",
        kind: "decision",
        pipeline_run_id: "run-1",
        reducer: "core/advance@1",
        input_record_ids: ["result-1"],
        payload_schema: "decision/v1",
        payload: {
          inline: {
            accepted: true,
            semantic_key: "external-schedule:attempt-1:publish",
            attempt_id: "attempt-1",
            phase: "publish",
          },
        },
        created_at: NOW,
      };
      const effect: EffectIntent = {
        schema: EFFECT_INTENT_SCHEMA,
        id: "effect-1",
        pipeline_run_id: "run-1",
        decision_record_id: "decision-1",
        kind: "github/publish-branch@1",
        idempotency_key: "run-1:publish",
        target: "github:owner/repo:refs/heads/ot/work",
        subject: recorded.run.current_subject,
        payload: { branch: "ot/work" },
      };
      const next = attempt({
        id: "attempt-2",
        scope: {
          kind: "loop_item",
          stage_id: "verify",
          parent_attempt_id: "attempt-1",
          loop_id: "execution_plan.units",
          item_id: "unit-a",
          item_index: 0,
        },
        repository_authority: "inspect",
        definition_bundle_hash: recorded.run.definition_bundle_hash,
        input_subject: subject("2"),
      });
      await context.store.applyAtomicTransition(reduceKernelCommand({
        ...recorded,
        records: exactMap<ResultRecord | DecisionRecord>(result, decision),
        command: {
          type: "settle",
          command_id: "settle-1",
          attempt_id: "attempt-1",
          decision_record_id: "decision-1",
          outcome: "success",
          next_attempts: [next],
          effect_intents: [effect],
        },
      }));
      expect(await context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "publish",
      })).toEqual({
        semantic_key: "external-schedule:attempt-1:publish",
        decision,
        effects: [{ intent: effect, delivery: null }],
      });
      const planningRequest = {
        pipeline_run_id: "run-1",
        definition_bundle_hash: recorded.run.definition_bundle_hash,
        scope_kind: "loop_item" as const,
        parent_attempt_id: "attempt-1",
        scope_group_id: "execution_plan.units",
        stage_ids: ["work"],
        member_ids: ["unit-a"],
      };
      const settled = await context.store.listSettledStructuredPlanningAttempts(planningRequest);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        attempt: { id: "attempt-1", decision_record_id: "decision-1" },
        result: { id: "result-1" },
        decision: { id: "decision-1" },
        checkpoint: { id: "checkpoint-1" },
        request_inputs: { task_prompt: "Do the exact sealed work." },
      });
      const restarted = new SqliteKernelStore({
        db: context.db,
        blob_store: context.blobs,
        manifest_resolver: { resolve: () => context.pipelineManifest },
        payload_schemas: payloadSchemas,
        execution_policy: EXECUTION_POLICY,
        now: () => currentTime,
      });
      expect(await restarted.listSettledStructuredPlanningAttempts(planningRequest)).toEqual(settled);
      await expect(restarted.listSettledStructuredPlanningAttempts({
        ...planningRequest,
        definition_bundle_hash: sha("f"),
      })).rejects.toThrow(/pinned definition bundle/);
      expect(await restarted.listSettledStructuredPlanningAttempts({
        ...planningRequest,
        scope_group_id: "execution_plan.other",
      })).toEqual([]);
      expect(await restarted.listSettledStructuredPlanningAttempts({
        ...planningRequest,
        member_ids: ["unit-b"],
      })).toEqual([]);
      await expect(restarted.listSettledStructuredPlanningAttempts({
        ...planningRequest,
        pipeline_run_id: "run-other",
      })).rejects.toThrow(/unknown pipeline run/);
      const effectLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      expect(effectLease?.intent).toEqual(effect);
      expect(effectLease?.execution_mode).toBe("dispatch_or_reconcile");
      expect(await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      })).toEqual(effectLease);

      const effectTemplate = context.db.prepare("SELECT * FROM effects WHERE id = 'effect-1'")
        .get() as Record<string, unknown>;
      const effectColumns = Object.keys(effectTemplate);
      const insertExpired = context.db.prepare(`
        INSERT INTO effects (${effectColumns.join(", ")})
        VALUES (${effectColumns.map(() => "?").join(", ")})
      `);
      for (let index = 0; index < 101; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const expired: Record<string, unknown> = {
          ...effectTemplate,
          id: `zz-expired-${suffix}`,
          idempotency_key: `expired:${suffix}`,
          target: `github:owner/repo:expired:${suffix}`,
          intent_hash: sha(index % 10 === 0 ? "a" : String(index % 10)),
          status: "processing",
          version: 0,
          attempt_count: 1,
          available_at: "2026-08-21T00:00:00.000Z",
          lease_id: `expired-lease-${suffix}`,
          lease_worker_id: "expired-worker",
          lease_expires_at: NOW,
          lease_execution_mode: "dispatch_or_reconcile",
          dispatch_lease_id: null,
          dispatch_worker_id: null,
          delivery_record_id: null,
        };
        insertExpired.run(...effectColumns.map((column) => expired[column]));
      }
      expect(context.db.prepare(`
        SELECT COUNT(*) AS count FROM effects WHERE id LIKE 'zz-expired-%' AND status = 'processing'
      `).get()).toEqual({ count: 101 });
      await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      expect(context.db.prepare(`
        SELECT COUNT(*) AS count FROM effects WHERE id LIKE 'zz-expired-%' AND status = 'processing'
      `).get()).toEqual({ count: 1 });
      await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-1",
        expires_at: "2026-08-20T12:05:00.000Z",
      });
      expect(context.db.prepare(`
        SELECT COUNT(*) AS count FROM effects WHERE id LIKE 'zz-expired-%' AND status = 'processing'
      `).get()).toEqual({ count: 0 });
      context.db.prepare("DELETE FROM effects WHERE id LIKE 'zz-expired-%'").run();

      currentTime = "2026-08-20T12:05:01.000Z";
      const recoveredUnsentLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-2",
        expires_at: "2026-08-20T12:10:00.000Z",
      });
      expect(context.db.prepare(`
        SELECT e.status, e.lease_id, e.lease_execution_mode, e.available_at,
          r.status AS run_status
        FROM effects e JOIN pipeline_runs r ON r.id = e.pipeline_run_id
        WHERE e.id = 'effect-1'
      `).get()).toEqual({
        status: "processing",
        lease_id: "effect-lease-2",
        lease_execution_mode: "dispatch_or_reconcile",
        available_at: NOW,
        run_status: "running",
      });
      expect(recoveredUnsentLease?.execution_mode).toBe("dispatch_or_reconcile");
      await context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-2",
        worker_id: "effect-worker",
        reconciliation: {
          kind: "hold_unknown",
          effect_id: "effect-1",
          external_identity: effect.target,
          detail: "provider lookup failed before dispatch",
          retry_at: "2026-08-20T12:05:02.000Z",
        },
      });
      currentTime = "2026-08-20T12:05:02.000Z";
      const redispatchLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-redispatch",
        expires_at: "2026-08-20T12:10:00.000Z",
      });
      expect(redispatchLease).toMatchObject({
        execution_mode: "dispatch_or_reconcile",
        prior_unknown_detail: "provider lookup failed before dispatch",
        dispatch_fence: null,
      });
      await expect(context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-redispatch",
        worker_id: "wrong-worker",
      })).rejects.toThrow(/fence/);
      const dispatchStarted = await context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-redispatch",
        worker_id: "effect-worker",
      });
      expect(dispatchStarted.execution_mode).toBe("reconcile_only");
      expect(dispatchStarted.prior_unknown_detail).toBe("provider lookup failed before dispatch");
      expect(await context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-redispatch",
        worker_id: "effect-worker",
      })).toEqual(dispatchStarted);
      expect(await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-redispatch",
        expires_at: "2026-08-20T12:10:00.000Z",
      })).toEqual(dispatchStarted);
      await expect(context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-redispatch",
        worker_id: "wrong-worker",
        reconciliation: {
          kind: "hold_unknown",
          effect_id: "effect-1",
          external_identity: effect.target,
          detail: "provider timed out",
          retry_at: "2026-08-20T12:05:06.000Z",
        },
      })).rejects.toThrow(/fence/);
      currentTime = "2026-08-20T12:10:01.000Z";
      const reconciliationLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-3",
        expires_at: "2026-08-20T12:15:00.000Z",
      });
      expect(reconciliationLease).toMatchObject({
        execution_mode: "reconcile_only",
        prior_unknown_detail: "provider lookup failed before dispatch",
      });
      await context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-3",
        worker_id: "effect-worker",
        reconciliation: {
          kind: "hold_unknown",
          effect_id: "effect-1",
          external_identity: effect.target,
          detail: "provider timed out",
          retry_at: "2026-08-20T12:10:06.000Z",
        },
      });
      expect(context.db.prepare("SELECT available_at FROM effects WHERE id = 'effect-1'").get())
        .toEqual({ available_at: "2026-08-20T12:10:06.000Z" });
      expect(await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-too-early",
        expires_at: "2026-08-20T12:20:00.000Z",
      })).toBeNull();
      currentTime = "2026-08-20T12:10:06.000Z";
      const heldUnknownLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-4",
        expires_at: "2026-08-20T12:20:00.000Z",
      });
      expect(heldUnknownLease).toMatchObject({
        execution_mode: "reconcile_only",
        prior_unknown_detail: "provider timed out",
      });
      const delivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "delivery-1",
        kind: "delivery",
        pipeline_run_id: "run-1",
        effect_id: "effect-1",
        idempotency_key: effect.idempotency_key,
        external_identity: effect.target,
        status: "confirmed",
        payload_schema: "delivery/v1",
        payload: { inline: { accepted: true } },
        created_at: NOW,
      };
      await context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-4",
        worker_id: "effect-worker",
        reconciliation: { kind: "append_delivery", delivery },
      });
      expect(context.db.prepare("SELECT status, delivery_record_id FROM effects WHERE id = 'effect-1'").get())
        .toEqual({ status: "acknowledged", delivery_record_id: "delivery-1" });
      expect((await context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "publish",
      }))?.effects).toEqual([{ intent: effect, delivery }]);
      const finalView = await context.store.loadExactReductionView({
        pipeline_run_id: "run-1",
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      });
      expect(finalView.run.active_effect_versions).toEqual({});

      // Reads still fail closed if an externally copied or corrupted database
      // violates the foreign keys that normal writes enforce.
      context.db.pragma("foreign_keys = OFF");
      context.db.prepare("UPDATE effects SET delivery_record_id = 'missing-delivery' WHERE id = 'effect-1'").run();
      await expect(context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "publish",
      })).rejects.toThrow(/missing delivery record/);
      context.db.prepare("UPDATE effects SET delivery_record_id = 'delivery-1' WHERE id = 'effect-1'").run();
      context.db.prepare("UPDATE records SET external_identity = 'github:owner/repo:refs/heads/wrong' WHERE id = 'delivery-1'").run();
      await expect(context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "publish",
      })).rejects.toThrow(/invalid delivery record/);
    } finally {
      context.db.close();
    }
  });

  it("retains an integration retry continuation across expired reconciliation lease recovery", async () => {
    let currentTime = NOW;
    const context = setup(undefined, () => currentTime);
    try {
      const effect = seedDispatchFencedUnknownIntegration(context);
      const continuationDetail = canonicalJson({
        schema: "openthrottle.effect-retry-continuation/v1",
        detail: "integration runtime sandbox is absent; confirming authoritative absence",
        continuation: {
          schema: "openthrottle.daytona-integration-absence-continuation/v1",
          consecutive_absences: 1,
        },
      });
      context.db.prepare("UPDATE effects SET unknown_detail = ? WHERE id = ?")
        .run(continuationDetail, effect.id);

      const interrupted = await context.store.leaseNextEffect({
        worker_id: "integration-worker-1",
        lease_id: "integration-reconciliation-1",
        expires_at: "2026-08-20T12:00:01.000Z",
      });
      expect(interrupted).toMatchObject({
        intent: { id: effect.id, kind: "daytona/integrate-checkpoint@1" },
        execution_mode: "reconcile_only",
        prior_unknown_detail: continuationDetail,
      });

      currentTime = "2026-08-20T12:00:02.000Z";
      const recovered = await context.store.leaseNextEffect({
        worker_id: "integration-worker-2",
        lease_id: "integration-reconciliation-2",
        expires_at: "2026-08-20T12:01:00.000Z",
      });
      expect(recovered).toMatchObject({
        intent: { id: effect.id, kind: "daytona/integrate-checkpoint@1" },
        execution_mode: "reconcile_only",
        prior_unknown_detail: continuationDetail,
      });
    } finally {
      context.db.close();
    }
  });

  it("atomically rejects one exact dispatch-fenced unknown integration and replays unchanged", async () => {
    const context = setup();
    try {
      const effect = seedDispatchFencedUnknownIntegration(context);
      const request = operatorEffectRejectionRequest();

      const first = await context.store.rejectDispatchFencedUnknownEffect(request);
      expect(first).toMatchObject({
        disposition: "rejected",
        pipeline_run_id: "run-1",
        effect_id: effect.id,
        effect_version: 8,
        run_version: 1,
      });
      expect(context.db.prepare(`
        SELECT status, version, lease_id, dispatch_lease_id, dispatch_worker_id,
          delivery_record_id, unknown_detail
        FROM effects WHERE id = ?
      `).get(effect.id)).toEqual({
        status: "rejected",
        version: 8,
        lease_id: null,
        dispatch_lease_id: "effect-dispatch-204",
        dispatch_worker_id: "effect-worker-204",
        delivery_record_id: first.delivery_record_id,
        unknown_detail: null,
      });
      expect(context.db.prepare(`
        SELECT kind, delivery_status, idempotency_key, external_identity
        FROM records WHERE id = ?
      `).get(first.delivery_record_id)).toEqual({
        kind: "delivery",
        delivery_status: "rejected",
        idempotency_key: effect.idempotency_key,
        external_identity: effect.target,
      });
      const schedule = await context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "integrate-checkpoint",
      });
      const delivery = schedule?.effects[0]?.delivery;
      expect(delivery).toMatchObject({
        id: first.delivery_record_id,
        status: "rejected",
        payload_schema: "openthrottle.effect-delivery/v1",
        payload: {
          inline: {
            effect_kind: "daytona/integrate-checkpoint@1",
            provider: "operator",
            observed_via: "operator_resolution",
            result: {
              schema: "openthrottle.operator-effect-rejection/v1",
              resolution_id: request.resolution_id,
              reason_code: request.reason_code,
              reason: request.reason,
              authorized_via: "deploy_token",
              maintenance_version: 0,
              captured_run_version: 0,
              captured_effect_version: 7,
              intent_hash: effectIntentContentHash(effect),
              dispatch_fence: {
                lease_id: "effect-dispatch-204",
                worker_id: "effect-worker-204",
              },
              reconciliation_ordinal: 4,
              prior_unknown_detail: UNKNOWN_INTEGRATION_DETAIL,
              prior_unknown_detail_hash: digestCanonicalJson(UNKNOWN_INTEGRATION_DETAIL),
              runtime_snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
              runtime_identity: RUNTIME_IDENTITY,
              runtime_create_effect_id: "effect-runtime-create",
              idempotency_key_length: LEGACY_LONG_INTEGRATION_IDEMPOTENCY_KEY.length,
              resolution_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        },
      });
      expect((await context.store.loadExactReductionView({
        pipeline_run_id: "run-1",
        attempt_id: null,
        record_ids: [],
        checkpoint_ids: [],
      })).run.active_effect_versions).toEqual({});

      const restarted = new SqliteKernelStore({
        db: context.db,
        blob_store: context.blobs,
        manifest_resolver: { resolve: () => context.pipelineManifest },
        payload_schemas: payloadSchemas,
        execution_policy: EXECUTION_POLICY,
        now: () => NOW,
      });
      expect(await restarted.rejectDispatchFencedUnknownEffect(request)).toEqual({
        ...first,
        disposition: "unchanged",
      });
      expect(context.db.prepare("SELECT version FROM pipeline_runs WHERE id = 'run-1'").get())
        .toEqual({ version: 1 });
      context.db.prepare(`
        UPDATE pipeline_runs SET version = 5, updated_at = ? WHERE id = 'run-1'
      `).run(NOW);
      expect(await restarted.rejectDispatchFencedUnknownEffect(request)).toEqual({
        ...first,
        disposition: "unchanged",
        run_version: 5,
      });
      expect(context.db.prepare("SELECT version FROM pipeline_runs WHERE id = 'run-1'").get())
        .toEqual({ version: 5 });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM records WHERE effect_id = 'effect-operator-rejection'").get())
        .toEqual({ count: 1 });
      await expect(context.store.rejectDispatchFencedUnknownEffect({
        ...request,
        reason: "A different operator claim must not reuse the settled Effect.",
      })).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);
      await expect(context.store.rejectDispatchFencedUnknownEffect({
        ...request,
        resolution_id: "different-resolution",
      })).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);
    } finally {
      context.db.close();
    }
  });

  it("selects the exact runtime creation behind an unknown integration from a confirmed pool", async () => {
    const context = setup();
    try {
      seedDispatchFencedUnknownIntegration(context);
      seedAdditionalConfirmedRuntimeCreate(context, "e".repeat(64));

      const rejected = await context.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      );
      expect(rejected).toMatchObject({
        disposition: "rejected",
        pipeline_run_id: "run-1",
        effect_id: "effect-operator-rejection",
      });
      const schedule = await context.store.findExternalSchedule({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        phase: "integrate-checkpoint",
      });
      expect(schedule?.effects[0]?.delivery).toMatchObject({
        payload: { inline: { result: {
          runtime_identity: RUNTIME_IDENTITY,
          runtime_create_effect_id: "effect-runtime-create",
        } } },
      });
    } finally {
      context.db.close();
    }
  });

  it("fails closed unless maintenance and the exact Effect fence authorize rejection", async () => {
    const staleMaintenance = setup();
    const missingDispatch = setup();
    const wrongKind = setup();
    const activeLease = setup();
    const leasedScheduleOwner = setup();
    const checkpointlessScheduleOwner = setup();
    const unsupportedSnapshot = setup();
    const shortIdempotencyKey = setup();
    const corruptedRuntimeIntent = setup();
    try {
      seedDispatchFencedUnknownIntegration(staleMaintenance);
      await expect(staleMaintenance.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest({ expected_maintenance_version: 1 }),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(missingDispatch, { dispatch_fence: null });
      await expect(missingDispatch.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(wrongKind, { kind: "github/push-checkpoint@1" });
      await expect(wrongKind.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(activeLease);
      await expect(activeLease.store.leaseNextEffect({
        worker_id: "effect-worker-active",
        lease_id: "effect-lease-active",
        expires_at: "2026-08-23T08:05:00.000Z",
      })).resolves.toMatchObject({ intent: { id: "effect-operator-rejection" } });
      await expect(activeLease.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(leasedScheduleOwner);
      leasedScheduleOwner.db.prepare(`
        UPDATE attempts SET lease_id = 'attempt-lease', lease_generation = 1,
          lease_worker_id = 'attempt-worker', lease_purpose = 'work',
          lease_expires_at = '2026-08-23T08:05:00.000Z', lease_started = 1
        WHERE id = 'attempt-1' AND pipeline_run_id = 'run-1'
      `).run();
      await expect(leasedScheduleOwner.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(checkpointlessScheduleOwner);
      checkpointlessScheduleOwner.db.prepare(`
        UPDATE attempts SET checkpoint_id = NULL
        WHERE id = 'attempt-1' AND pipeline_run_id = 'run-1'
      `).run();
      await expect(checkpointlessScheduleOwner.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(unsupportedSnapshot, {
        runtime_snapshot: "openthrottle-newer-snapshot",
      });
      await expect(unsupportedSnapshot.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(shortIdempotencyKey, {
        idempotency_key: "run-1:integration:short",
      });
      await expect(shortIdempotencyKey.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(corruptedRuntimeIntent);
      corruptedRuntimeIntent.db.prepare(`
        UPDATE effects SET intent_hash = ?
        WHERE id = 'effect-runtime-create' AND pipeline_run_id = 'run-1'
      `).run(sha("0"));
      await expect(corruptedRuntimeIntent.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      for (const context of [
        staleMaintenance,
        missingDispatch,
        wrongKind,
        activeLease,
        leasedScheduleOwner,
        checkpointlessScheduleOwner,
        unsupportedSnapshot,
        shortIdempotencyKey,
        corruptedRuntimeIntent,
      ]) {
        expect(context.db.prepare("SELECT COUNT(*) AS count FROM records WHERE effect_id = 'effect-operator-rejection'").get())
          .toEqual({ count: 0 });
      }
    } finally {
      for (const context of [
        staleMaintenance,
        missingDispatch,
        wrongKind,
        activeLease,
        leasedScheduleOwner,
        checkpointlessScheduleOwner,
        unsupportedSnapshot,
        shortIdempotencyKey,
        corruptedRuntimeIntent,
      ]) {
        context.db.close();
      }
    }
  });

  it("returns not found when the exact run and Effect identity do not exist", async () => {
    const context = setup();
    try {
      seedDispatchFencedUnknownIntegration(context);
      await expect(context.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest({ effect_id: "missing-effect" }),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionNotFoundError);
      await expect(context.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest({ pipeline_run_id: "another-run" }),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionNotFoundError);
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM records WHERE effect_id = 'effect-operator-rejection'").get())
        .toEqual({ count: 0 });
    } finally {
      context.db.close();
    }
  });

  it("rejects a historical external schedule that is not at the active run cursor", async () => {
    const context = setup();
    try {
      seedDispatchFencedUnknownIntegration(context);
      context.db.prepare(`
        UPDATE pipeline_runs SET cursor_stage_id = 'verify', updated_at = ?
        WHERE id = 'run-1'
      `).run(NOW);

      await expect(context.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);
      expect(context.db.prepare("SELECT status, version FROM effects WHERE id = ?")
        .get("effect-operator-rejection")).toEqual({ status: "unknown", version: 7 });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM records WHERE effect_id = 'effect-operator-rejection'").get())
        .toEqual({ count: 0 });
    } finally {
      context.db.close();
    }
  });

  it("rejects open maintenance, an inactive run, or any pre-existing delivery", async () => {
    const openMaintenance = setup();
    const inactiveRun = setup();
    const existingDelivery = setup();
    try {
      seedDispatchFencedUnknownIntegration(openMaintenance);
      openMaintenance.db.prepare(`
        UPDATE settings SET value_json = 'false', version = 1, updated_at = ?
        WHERE key = 'epoch.maintenance_ingress_closed'
      `).run(NOW);
      await expect(openMaintenance.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest({ expected_maintenance_version: 1 }),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      seedDispatchFencedUnknownIntegration(inactiveRun);
      inactiveRun.db.prepare(`
        UPDATE pipeline_runs
        SET status = 'failed', terminal_outcome = 'failed', cursor_stage_id = NULL,
          updated_at = ?
        WHERE id = 'run-1'
      `).run(NOW);
      await expect(inactiveRun.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      const effect = seedDispatchFencedUnknownIntegration(existingDelivery);
      const orphanDelivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "delivery-already-present",
        kind: "delivery",
        pipeline_run_id: effect.pipeline_run_id,
        effect_id: effect.id,
        idempotency_key: effect.idempotency_key,
        external_identity: effect.target,
        status: "rejected",
        payload_schema: "delivery/v1",
        payload: { inline: { reason: "pre-existing outcome" } },
        created_at: NOW,
      };
      if (!("inline" in orphanDelivery.payload)) throw new Error("test DeliveryRecord must be inline");
      const orphanDeliveryPayload = orphanDelivery.payload.inline;
      existingDelivery.db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
          inline_payload, effect_id, idempotency_key, external_identity,
          delivery_status, created_at
        ) VALUES (?, ?, 4, ?, 'delivery', ?, ?, ?, ?, ?, 'rejected', ?)
      `).run(
        orphanDelivery.id,
        orphanDelivery.pipeline_run_id,
        digestCanonicalJson(orphanDelivery),
        orphanDelivery.payload_schema,
        canonicalJson(orphanDeliveryPayload),
        orphanDelivery.effect_id,
        orphanDelivery.idempotency_key,
        orphanDelivery.external_identity,
        orphanDelivery.created_at,
      );
      await expect(existingDelivery.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toBeInstanceOf(KernelOperatorEffectRejectionConflictError);

      for (const context of [openMaintenance, inactiveRun, existingDelivery]) {
        expect(context.db.prepare(`
          SELECT status, version, delivery_record_id FROM effects
          WHERE id = 'effect-operator-rejection'
        `).get()).toEqual({ status: "unknown", version: 7, delivery_record_id: null });
      }
    } finally {
      for (const context of [openMaintenance, inactiveRun, existingDelivery]) {
        context.db.close();
      }
    }
  });

  it("rolls the operator DeliveryRecord back when the Effect settlement CAS aborts", async () => {
    const context = setup();
    try {
      seedDispatchFencedUnknownIntegration(context);
      context.db.exec(`
        CREATE TRIGGER reject_operator_effect_settlement
        BEFORE UPDATE OF status ON effects
        WHEN NEW.status = 'rejected'
        BEGIN
          SELECT RAISE(ABORT, 'injected effect settlement fault');
        END;
      `);

      await expect(context.store.rejectDispatchFencedUnknownEffect(
        operatorEffectRejectionRequest(),
      )).rejects.toThrow(/injected effect settlement fault/);
      expect(context.db.prepare("SELECT status, version FROM effects WHERE id = ?")
        .get("effect-operator-rejection")).toEqual({ status: "unknown", version: 7 });
      expect(context.db.prepare("SELECT COUNT(*) AS count FROM records WHERE effect_id = 'effect-operator-rejection'").get())
        .toEqual({ count: 0 });
      expect(context.db.prepare("SELECT version FROM pipeline_runs WHERE id = 'run-1'").get())
        .toEqual({ version: 0 });
    } finally {
      context.db.close();
    }
  });
});
