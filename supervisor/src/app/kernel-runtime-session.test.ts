import { describe, expect, it } from "vitest";
import {
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  type CompiledPipelineManifest,
} from "@openthrottle/contracts";
import type {
  KernelReductionPort,
  ReductionReadRequest,
  ReductionView,
} from "../pipeline/kernel/ports.js";
import {
  authorizeKernelSteeringDelivery,
  createKernelSteeringEnvelope,
  type KernelRuntimeSessionBindRequest,
} from "../pipeline/kernel/steering.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type AtomicTransitionBundle,
  type KernelAttempt,
  type KernelRun,
} from "../pipeline/kernel/types.js";
import {
  transitionApplicationDisposition,
  type AtomicTransitionApplyResult,
  type StoredTransitionIdentity,
} from "../pipeline/kernel/store.js";
import { KernelRuntimeSessionService } from "./kernel-runtime-session.js";

const REQUEST_HASH = "a".repeat(64);
const BUNDLE_HASH = "b".repeat(64);
const SUBJECT = "1".repeat(40);
const NOW = "2026-08-20T12:00:00.000Z";
const LEASE_EXPIRY = "2026-08-20T12:05:00.000Z";

function manifest(): CompiledPipelineManifest {
  return {
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: "core/test",
    pipeline_version: 1,
    entry_stage: "work",
    definition_bundle_hash: BUNDLE_HASH,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    stages: [{
      id: "work",
      kind: "agent",
      engine: "codex",
      agent_id: "worker",
      repository_authority: "edit",
      skills: ["core/work"],
      entry_skill: "core/work",
      eval: "core/result",
      on: { success: { terminal: "completed" } },
    }],
  };
}

function attempt(overrides: Partial<KernelAttempt> = {}): KernelAttempt {
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: "attempt-1",
    pipeline_run_id: "run-1",
    scope: { kind: "stage", stage_id: "work" },
    repository_authority: "edit",
    request_hash: REQUEST_HASH,
    definition_bundle_hash: BUNDLE_HASH,
    input_subject: SUBJECT,
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
      id: "lease-1",
      generation: 0,
      worker_id: "worker-1",
      purpose: "work",
      expires_at: LEASE_EXPIRY,
      started: true,
    },
    checkpoint_id: null,
    result_record_id: null,
    pending_result: null,
    ...overrides,
    decision_record_id: overrides.decision_record_id ?? null,
  };
}

function run(current: KernelAttempt, overrides: Partial<KernelRun> = {}): KernelRun {
  return {
    schema: KERNEL_RUN_SCHEMA,
    id: current.pipeline_run_id,
    pipeline_id: "core/test",
    definition_bundle_hash: BUNDLE_HASH,
    current_subject: SUBJECT,
    status: "running",
    terminal_outcome: null,
    cursor: {
      stage_id: "work",
      version: 2,
      reentries: {},
      frontier: [{
        scope_key: "0:work@attempt-1",
        attempt_id: current.id,
        scope: current.scope,
        depends_on: [],
      }],
      completed_scope_keys: [],
      barrier: { kind: "all", member_scope_keys: ["0:work@attempt-1"] },
    },
    version: 8,
    work_retry_limit: 2,
    result_correction_limit: 2,
    active_attempt_versions: { [current.id]: current.version },
    active_effect_versions: {},
    checkpoint_ids: {},
    ...overrides,
  };
}

class MemoryReductionPort implements KernelReductionPort {
  view: ReductionView;
  apply_count = 0;
  before_apply: (() => void) | null = null;
  #lastTransition: StoredTransitionIdentity | undefined;

  constructor(current = attempt()) {
    this.view = {
      manifest: manifest(),
      run: run(current),
      current_attempt: current,
      records: new Map(),
      checkpoints: new Map(),
    };
  }

  async loadExactReductionView(request: ReductionReadRequest): Promise<ReductionView> {
    if (
      request.pipeline_run_id !== this.view.run.id ||
      request.attempt_id !== this.view.current_attempt?.id ||
      request.record_ids.length !== 0 || request.checkpoint_ids.length !== 0
    ) throw new Error("test received a widened reduction read");
    return this.view;
  }

  async applyAtomicTransition(bundle: AtomicTransitionBundle): Promise<AtomicTransitionApplyResult> {
    this.apply_count += 1;
    const race = this.before_apply;
    this.before_apply = null;
    race?.();
    const current = this.view.current_attempt;
    const disposition = transitionApplicationDisposition({
      bundle,
      observed: {
        run_id: this.view.run.id,
        run_version: this.view.run.version,
        cursor_version: this.view.run.cursor.version,
        attempt_versions: current ? { [current.id]: current.version } : {},
      },
      existing: this.#lastTransition?.transition_id === bundle.transition_id
        ? this.#lastTransition
        : undefined,
    });
    if (disposition === "replay") {
      return { disposition: "replayed", run_version: this.view.run.version };
    }
    const write = bundle.attempt_writes[0];
    if (!write || write.kind !== "replace") throw new Error("test expected one replacement");
    this.view = {
      ...this.view,
      run: bundle.run,
      current_attempt: write.attempt,
    };
    this.#lastTransition = {
      transition_id: bundle.transition_id,
      content_hash: bundle.content_hash,
    };
    return { disposition: "applied", run_version: bundle.run.version };
  }

  heartbeat(expiresAt = "2026-08-20T12:06:00.000Z"): void {
    const current = this.view.current_attempt!;
    const next = {
      ...current,
      version: current.version + 1,
      lease: current.lease && { ...current.lease, expires_at: expiresAt },
    };
    this.view = {
      ...this.view,
      run: {
        ...this.view.run,
        version: this.view.run.version + 1,
        active_attempt_versions: { [next.id]: next.version },
      },
      current_attempt: next,
    };
    this.#lastTransition = undefined;
  }

  recover(expiresAt = "2026-08-20T12:10:00.000Z"): void {
    const current = this.view.current_attempt!;
    const next = {
      ...current,
      version: current.version + 1,
      lease: current.lease && {
        ...current.lease,
        generation: current.lease.generation + 1,
        expires_at: expiresAt,
      },
    };
    this.view = {
      ...this.view,
      run: {
        ...this.view.run,
        version: this.view.run.version + 1,
        active_attempt_versions: { [next.id]: next.version },
      },
      current_attempt: next,
    };
    this.#lastTransition = undefined;
  }
}

function bindRequest(
  port: MemoryReductionPort,
  overrides: Partial<KernelRuntimeSessionBindRequest> = {},
): KernelRuntimeSessionBindRequest {
  const current = port.view.current_attempt!;
  return {
    pipeline_run_id: port.view.run.id,
    attempt_id: current.id,
    request_hash: current.request_hash,
    definition_bundle_hash: current.definition_bundle_hash,
    input_subject: current.input_subject,
    lease_id: current.lease!.id,
    lease_generation: current.lease!.generation,
    worker_id: current.lease!.worker_id,
    lease_purpose: current.lease!.purpose,
    work_retry_ordinal: current.work_retry_ordinal,
    result_correction_count: current.result_correction_count,
    native_session_id: "session-1",
    ...overrides,
  };
}

function service(port: KernelReductionPort): KernelRuntimeSessionService {
  return new KernelRuntimeSessionService({
    transitions: port,
    now: () => NOW,
  });
}

describe("KernelRuntimeSessionService", () => {
  it("atomically binds one started work session and makes exact replay idempotent", async () => {
    const port = new MemoryReductionPort();
    const sessions = service(port);
    const request = bindRequest(port);

    const bound = await sessions.bindRuntimeSession(request);
    expect(bound).toMatchObject({
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      native_session_id: "session-1",
      generation: 0,
      lease_generation: 0,
      attempt_status: "running",
      lease_id: "lease-1",
      lease_worker_id: "worker-1",
      lease_purpose: "work",
      lease_expires_at: LEASE_EXPIRY,
    });
    expect(port.view.current_attempt).toMatchObject({
      native_session_id: "session-1",
      version: 5,
    });
    expect(port.view.run).toMatchObject({ version: 9 });

    await expect(sessions.bindRuntimeSession(request)).resolves.toEqual(bound);
    expect(port.apply_count).toBe(1);
    await expect(sessions.bindRuntimeSession({
      ...request,
      native_session_id: "session-conflict",
    })).rejects.toThrow(/conflicting native session/);
  });

  it("rejects every stale launch fence before binding", async () => {
    const cases: Array<[string, Partial<KernelRuntimeSessionBindRequest>]> = [
      ["lease", { lease_id: "lease-stale" }],
      ["lease generation", { lease_generation: 1 }],
      ["worker", { worker_id: "worker-stale" }],
      ["purpose", { lease_purpose: "result_correction" }],
      ["work retry", { work_retry_ordinal: 1 }],
      ["result correction", { result_correction_count: 1 }],
      ["request", { request_hash: "d".repeat(64) }],
      ["bundle", { definition_bundle_hash: "e".repeat(64) }],
      ["input", { input_subject: "2".repeat(40) }],
    ];
    for (const [name, overrides] of cases) {
      const port = new MemoryReductionPort();
      await expect(service(port).bindRuntimeSession(bindRequest(port, overrides)), name)
        .rejects.toThrow(/fence|version|lease|identity|phase/);
      expect(port.view.current_attempt?.native_session_id, name).toBeNull();
      expect(port.apply_count, name).toBe(0);
    }
  });

  it("rejects provider session IDs that cannot become sandbox path components", async () => {
    const port = new MemoryReductionPort();

    await expect(service(port).bindRuntimeSession(bindRequest(port, {
      native_session_id: "provider/session",
    }))).rejects.toThrow("native_session_id is invalid");
    expect(port.apply_count).toBe(0);
  });

  it("accepts same-lease heartbeat movement and keeps steering valid after renewal", async () => {
    const port = new MemoryReductionPort();
    const sessions = service(port);
    const liveLaunch = bindRequest(port);
    port.heartbeat();
    const bound = await sessions.bindRuntimeSession(liveLaunch);
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-1",
      source: "operator",
      body: "continue",
      binding: bound,
    });
    port.heartbeat("2026-08-20T12:07:00.000Z");
    const renewed = await sessions.loadCurrentRuntimeSession({
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
    });
    expect(renewed).toMatchObject({
      native_session_id: "session-1",
      generation: bound.generation,
      lease_generation: bound.lease_generation,
      lease_expires_at: "2026-08-20T12:07:00.000Z",
    });
    expect(() => authorizeKernelSteeringDelivery({
      envelope,
      current_binding: renewed,
    })).not.toThrow();
  });

  it("invalidates pre-recovery steering without changing its phase generation", async () => {
    const port = new MemoryReductionPort();
    const sessions = service(port);
    const bound = await sessions.bindRuntimeSession(bindRequest(port));
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-before-recovery",
      source: "operator",
      body: "Only the current lease owner may receive this.",
      binding: bound,
    });

    port.recover();
    const recovered = await sessions.loadCurrentRuntimeSession({
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
    });
    expect(recovered).toMatchObject({
      generation: bound.generation,
      lease_generation: bound.lease_generation + 1,
      native_session_id: bound.native_session_id,
    });
    expect(() => authorizeKernelSteeringDelivery({
      envelope,
      current_binding: recovered,
    })).toThrow(/lease_generation.*stale or mismatched/);
  });

  it("verifies and retains the work session for result correction", async () => {
    const correction = attempt({
      native_session_id: "session-1",
      status: "result_pending",
      version: 10,
      work_retry_ordinal: 1,
      result_correction_count: 2,
      result_correction_deadline: "2026-08-20T12:10:00.000Z",
      checkpoint_id: "checkpoint-1",
      pending_result: {
        candidate_hash: "f".repeat(64),
        diagnostics: [{ path: "/payload/summary", detail: "expected string" }],
        invalid_result_evidence: null,
      },
      lease: {
        id: "correction-lease",
        generation: 0,
        worker_id: "correction-worker",
        purpose: "result_correction",
        expires_at: LEASE_EXPIRY,
        started: true,
      },
    });
    const port = new MemoryReductionPort(correction);
    const sessions = service(port);
    const request = bindRequest(port);

    await expect(sessions.bindRuntimeSession(request)).resolves.toMatchObject({
      native_session_id: "session-1",
      generation: 2,
      attempt_status: "result_pending",
      lease_purpose: "result_correction",
    });
    expect(port.apply_count).toBe(0);
    await expect(sessions.bindRuntimeSession({
      ...request,
      native_session_id: "session-conflict",
    })).rejects.toThrow(/conflicting native session/);
  });

  it("fails closed for an unstarted, expired, replaced, or retried lease", async () => {
    const unstartedPort = new MemoryReductionPort(attempt({
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: LEASE_EXPIRY,
        started: false,
      },
    }));
    await expect(service(unstartedPort).bindRuntimeSession(bindRequest(unstartedPort)))
      .rejects.toThrow(/started lease/);

    const expiredPort = new MemoryReductionPort(attempt({
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "2026-08-20T11:59:00.000Z",
        started: true,
      },
    }));
    await expect(service(expiredPort).loadCurrentRuntimeSession({
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
    })).resolves.toBeNull();
    await expect(service(expiredPort).bindRuntimeSession(bindRequest(expiredPort)))
      .rejects.toThrow(/expired/);

    const replacedPort = new MemoryReductionPort();
    const replacedRequest = bindRequest(replacedPort);
    const replaced = replacedPort.view.current_attempt!;
    replacedPort.view = {
      ...replacedPort.view,
      run: {
        ...replacedPort.view.run,
        version: replacedPort.view.run.version + 1,
        active_attempt_versions: { [replaced.id]: replaced.version + 1 },
      },
      current_attempt: {
        ...replaced,
        version: replaced.version + 1,
        lease: { ...replaced.lease!, id: "lease-replacement" },
      },
    };
    await expect(service(replacedPort).bindRuntimeSession(replacedRequest))
      .rejects.toThrow(/lease fence/);

    const retriedPort = new MemoryReductionPort();
    const retriedRequest = bindRequest(retriedPort);
    const retried = retriedPort.view.current_attempt!;
    retriedPort.view = {
      ...retriedPort.view,
      run: {
        ...retriedPort.view.run,
        version: retriedPort.view.run.version + 1,
        active_attempt_versions: { [retried.id]: retried.version + 1 },
      },
      current_attempt: {
        ...retried,
        status: "pending",
        version: retried.version + 1,
        work_retry_ordinal: retried.work_retry_ordinal + 1,
        native_session_id: null,
        lease: null,
      },
    };
    await expect(service(retriedPort).bindRuntimeSession(retriedRequest))
      .rejects.toThrow(/lease|retry ordinal|live phase/);

    const racedPort = new MemoryReductionPort();
    racedPort.before_apply = () => racedPort.heartbeat();
    await expect(service(racedPort).bindRuntimeSession(bindRequest(racedPort)))
      .resolves.toMatchObject({ native_session_id: "session-1" });
    expect(racedPort.apply_count).toBe(2);

    const recoveredPort = new MemoryReductionPort();
    const staleLaunch = bindRequest(recoveredPort);
    recoveredPort.before_apply = () => recoveredPort.recover();
    await expect(service(recoveredPort).bindRuntimeSession(staleLaunch))
      .rejects.toThrow(/lease fence/);
    expect(recoveredPort.apply_count).toBe(1);
    expect(recoveredPort.view.current_attempt).toMatchObject({
      native_session_id: null,
      lease: { id: "lease-1", generation: 1 },
    });
  });
});
