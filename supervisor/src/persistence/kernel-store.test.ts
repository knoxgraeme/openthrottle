import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  EFFECT_INTENT_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecordPayloadContract,
  type ExecutionRecordPayloadRegistry,
  type ResultRecord,
} from "@openthrottle/contracts";
import { reduceKernelCommand, compileKernelCursor } from "../pipeline/kernel/reducer.js";
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
} from "./epoch-database.js";
import {
  KernelIntegrityError,
  SqliteKernelStore,
  type KernelStoreFaultPoint,
  type PipelineAdmissionInput,
} from "./kernel-store.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-20T12:00:00.000Z";
const sha = (character: string): string => character.repeat(64);
const subject = (character: string): string => character.repeat(40);

const payloadSchemas: ExecutionRecordPayloadRegistry = new Map<string, ExecutionRecordPayloadContract>([
  ["result/v1", { kind: "result", parseInline: (value: unknown): unknown => value }],
  ["decision/v1", { kind: "decision", parseInline: (value: unknown): unknown => value }],
  ["delivery/v1", { kind: "delivery", parseInline: (value: unknown): unknown => value }],
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
    pipeline_run_id: "run-1",
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
    pending_result: input.pending_result ?? null,
  };
}

function run(initial: readonly KernelAttempt[], bundleHash: string): KernelRun {
  return {
    schema: KERNEL_RUN_SCHEMA,
    id: "run-1",
    pipeline_id: "core/test",
    definition_bundle_hash: bundleHash,
    current_subject: subject("1"),
    status: "pending",
    terminal_outcome: null,
    cursor: compileKernelCursor({ stage_id: "work", version: 0, attempts: initial }),
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
): {
  db: Database.Database;
  blobs: VolumeBlobStore;
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
      runtime_snapshot: "snapshot",
    }],
  });
  const db = initializeFreshEpochDatabase({
    database_path: join(directory, "epoch.sqlite"),
    blob_store: blobs,
    release_id: "release-a",
    bootstrap,
    now,
  });
  const definitionBundle = blobs.put({
    bytes: '{"bundle":"test"}',
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "openthrottle.definition-bundle/v1",
  });
  const pipelineManifest = manifest(definitionBundle.pointer.digest);
  const initialAttempt = attempt({ definition_bundle_hash: definitionBundle.pointer.digest });
  const initialRun = run([initialAttempt], definitionBundle.pointer.digest);
  const store = new SqliteKernelStore({
    db,
    blob_store: blobs,
    manifest_resolver: { resolve: () => pipelineManifest },
    payload_schemas: payloadSchemas,
    now,
    fault_injector: faultInjector,
  });
  return {
    db,
    blobs,
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
        payload_schema: "work/v1",
        payload: { inline: { prompt: "do it" } },
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

function exactMap<T extends { id: string }>(...values: T[]): ReadonlyMap<string, T> {
  return new Map(values.map((value) => [value.id, value]));
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
  return { attempt: started.current_attempt!, run: started.run };
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
      expect(await context.store.getRunProjection("run-1")).toMatchObject({
        status: "pending",
        active_attempt_count: 1,
      });
    } finally {
      context.db.close();
    }
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
      expect(first?.attempt.lease?.worker_id).toBe("worker-1");
      await expect(context.store.leaseNextEligibleAttempt({ ...request, worker_id: "worker-2" }))
        .rejects.toThrow(/immutable replay/);
      await expect(context.store.renewAttemptLease({
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        worker_id: "worker-2",
        expires_at: "2026-08-20T12:06:00.000Z",
      })).rejects.toThrow(/fence/);
      expect(await context.store.renewAttemptLease({
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        worker_id: "worker-1",
        expires_at: "2026-08-20T12:06:00.000Z",
      })).toMatchObject({ worker_id: "worker-1", expires_at: "2026-08-20T12:06:00.000Z" });
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
      expect(await context.store.applyAtomicTransition(start)).toEqual({ disposition: "applied", run_version: 2 });
      expect(await context.store.applyAtomicTransition(start)).toEqual({ disposition: "replayed", run_version: 2 });
      await expect(context.store.applyAtomicTransition(conflictingReplay(start))).rejects.toThrow(/conflicts/);
      await expect(context.store.applyAtomicTransition(delayed)).rejects.toThrow(/stale/);
    } finally {
      context.db.close();
    }
  });

  it("commits a blob checkpoint only after verification and blocks active corruption with evidence", async () => {
    const context = setup();
    try {
      context.store.admitPipelineRun(context.admission);
      const started = await claimAndStart(context);
      const token = context.blobs.put({
        bytes: '{"tree":"verified"}',
        encoding: "utf-8",
        media_type: "application/json",
        payload_schema: "checkpoint/v1",
      });
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
        payload: { blob: token.pointer },
        captured_at: NOW,
      };
      const transition = reduceKernelCommand({
        manifest: context.pipelineManifest,
        run: started.run,
        current_attempt: started.attempt,
        records: new Map(),
        checkpoints: exactMap(checkpoint),
        command: {
          type: "work_complete",
          command_id: "work-complete-1",
          attempt_id: "attempt-1",
          checkpoint_id: "checkpoint-1",
          verified_output_subject: subject("2"),
        },
      });
      await context.store.applyAtomicTransition(transition);
      expect(context.db.prepare("SELECT blob_digest FROM checkpoints WHERE id = 'checkpoint-1'").get())
        .toEqual({ blob_digest: token.pointer.digest });

      writeFileSync(context.blobs.objectPath(token.pointer.digest), "corrupt", "utf8");
      let activeFailure: unknown;
      try {
        await context.store.resolveExactContext({
          pipeline_run_id: "run-1",
          attempt_id: "attempt-1",
          allowed_record_ids: [],
          allowed_checkpoint_ids: ["checkpoint-1"],
        });
      } catch (error) {
        activeFailure = error;
      }
      expect(activeFailure).toBeInstanceOf(KernelIntegrityError);
      expect((activeFailure as KernelIntegrityError).evidence.classification).toBe("active_blocking");
      expect(context.db.prepare("SELECT status FROM attempts WHERE id = 'attempt-1'").get())
        .toEqual({ status: "work_complete" });

      context.db.prepare(`
        UPDATE pipeline_runs SET status = 'failed', terminal_outcome = 'failed', cursor_stage_id = NULL
        WHERE id = 'run-1'
      `).run();
      await expect(context.store.resolveExactContext({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        allowed_record_ids: [],
        allowed_checkpoint_ids: ["checkpoint-1"],
      })).rejects.toMatchObject({ evidence: { classification: "settled_history_incident" } });
    } finally {
      context.db.close();
    }
  });

  it("persists result/decision/effect primitives and fences effect lease reconciliation", async () => {
    let currentTime = NOW;
    const context = setup(undefined, () => currentTime);
    try {
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
        pipeline_run_id: "run-1", attempt_id: "attempt-1", record_ids: ["result-1"], checkpoint_ids: [],
      });
      const decision: DecisionRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: "decision-1",
        kind: "decision",
        pipeline_run_id: "run-1",
        reducer: "core/advance@1",
        input_record_ids: ["result-1"],
        payload_schema: "decision/v1",
        payload: { inline: { accepted: true, semantic_key: "skill:review" } },
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
        subject: subject("2"),
        payload: { branch: "ot/work" },
      };
      const next = attempt({
        id: "attempt-2",
        scope: { kind: "stage", stage_id: "verify" },
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
      await expect(context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-2",
        worker_id: "wrong-worker",
      })).rejects.toThrow(/fence/);
      const dispatchStarted = await context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-2",
        worker_id: "effect-worker",
      });
      expect(dispatchStarted.execution_mode).toBe("reconcile_only");
      expect(await context.store.markLeasedEffectDispatchStarted({
        effect_id: "effect-1",
        lease_id: "effect-lease-2",
        worker_id: "effect-worker",
      })).toEqual(dispatchStarted);
      expect(await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-2",
        expires_at: "2026-08-20T12:10:00.000Z",
      })).toEqual(dispatchStarted);
      await expect(context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-2",
        worker_id: "wrong-worker",
        reconciliation: {
          kind: "hold_unknown",
          effect_id: "effect-1",
          external_identity: effect.target,
          detail: "provider timed out",
        },
      })).rejects.toThrow(/fence/);
      currentTime = "2026-08-20T12:10:01.000Z";
      const reconciliationLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-3",
        expires_at: "2026-08-20T12:15:00.000Z",
      });
      expect(reconciliationLease?.execution_mode).toBe("reconcile_only");
      await context.store.completeLeasedEffect({
        effect_id: "effect-1",
        lease_id: "effect-lease-3",
        worker_id: "effect-worker",
        reconciliation: {
          kind: "hold_unknown",
          effect_id: "effect-1",
          external_identity: effect.target,
          detail: "provider timed out",
        },
      });
      const heldUnknownLease = await context.store.leaseNextEffect({
        worker_id: "effect-worker",
        lease_id: "effect-lease-4",
        expires_at: "2026-08-20T12:20:00.000Z",
      });
      expect(heldUnknownLease?.execution_mode).toBe("reconcile_only");
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
      expect(await context.store.getRunProjection("run-1")).toMatchObject({ active_effect_count: 0 });
    } finally {
      context.db.close();
    }
  });
});
