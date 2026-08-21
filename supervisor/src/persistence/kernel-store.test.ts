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
import { KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA } from "../pipeline/kernel/ports.js";
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
});
