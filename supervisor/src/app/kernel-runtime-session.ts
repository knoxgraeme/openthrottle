import { NATIVE_SESSION_ID, digestCanonicalJson } from "@openthrottle/contracts";
import type { KernelReductionPort, ReductionView } from "../pipeline/kernel/ports.js";
import { reduceKernelCommand } from "../pipeline/kernel/reducer.js";
import {
  deriveKernelSteeringGeneration,
  type KernelRuntimeSessionBinding,
  type KernelRuntimeSessionBindingPort,
  type KernelRuntimeSessionBindRequest,
} from "../pipeline/kernel/steering.js";
import type {
  AtomicTransitionBundle,
  KernelAttempt,
  KernelCommand,
  KernelRun,
} from "../pipeline/kernel/types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function validId(value: string, name: string): void {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`runtime session ${name} is invalid`);
  }
}

function validOrdinal(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`runtime session ${name} is invalid`);
  }
}

function canonicalTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`runtime session ${name} is invalid`);
  }
  return parsed;
}

function assertRequestShape(request: KernelRuntimeSessionBindRequest): void {
  validId(request.pipeline_run_id, "pipeline_run_id");
  validId(request.attempt_id, "attempt_id");
  validId(request.lease_id, "lease_id");
  validId(request.worker_id, "worker_id");
  validOrdinal(request.lease_generation, "lease generation");
  if (!NATIVE_SESSION_ID.test(request.native_session_id)) {
    throw new Error("runtime session native_session_id is invalid");
  }
  if (!DIGEST.test(request.request_hash) || !DIGEST.test(request.definition_bundle_hash)) {
    throw new Error("runtime session request or definition-bundle identity is invalid");
  }
  if (!GIT_SUBJECT.test(request.input_subject)) {
    throw new Error("runtime session input subject is invalid");
  }
  if (request.lease_purpose !== "work" && request.lease_purpose !== "result_correction") {
    throw new Error("runtime session lease purpose is invalid");
  }
  validOrdinal(request.work_retry_ordinal, "work retry ordinal");
  validOrdinal(request.result_correction_count, "result correction count");
}

function exactAttempt(view: ReductionView, attemptId: string): KernelAttempt {
  const attempt = view.current_attempt;
  if (!attempt || attempt.id !== attemptId || attempt.pipeline_run_id !== view.run.id) {
    throw new Error("runtime session attempt fence does not match its exact run aggregate");
  }
  return attempt;
}

function assertBindFences(input: {
  view: ReductionView;
  request: KernelRuntimeSessionBindRequest;
  now: string;
}): KernelAttempt {
  const { view, request } = input;
  const attempt = exactAttempt(view, request.attempt_id);
  if (view.run.id !== request.pipeline_run_id) {
    throw new Error("runtime session run fence does not match");
  }
  if (
    view.run.definition_bundle_hash !== request.definition_bundle_hash ||
    attempt.request_hash !== request.request_hash ||
    attempt.definition_bundle_hash !== request.definition_bundle_hash ||
    attempt.input_subject !== request.input_subject
  ) throw new Error("runtime session immutable action identity fence does not match");
  if (
    attempt.work_retry_ordinal !== request.work_retry_ordinal ||
    attempt.result_correction_count !== request.result_correction_count
  ) throw new Error("runtime session retry ordinal fence does not match");

  const lease = attempt.lease;
  if (
    !lease || lease.id !== request.lease_id || lease.generation !== request.lease_generation ||
    lease.worker_id !== request.worker_id ||
    lease.purpose !== request.lease_purpose
  ) throw new Error("runtime session lease fence does not match");
  if (!lease.started) throw new Error("runtime session requires a started lease");
  if (canonicalTimestamp(lease.expires_at, "lease expiry") <= canonicalTimestamp(input.now, "clock")) {
    throw new Error("runtime session lease is expired");
  }
  if (
    (lease.purpose === "work" && attempt.status !== "running") ||
    (lease.purpose === "result_correction" && attempt.status !== "result_pending")
  ) throw new Error("runtime session attempt is not in its bound live phase");
  if (lease.purpose === "result_correction" && attempt.native_session_id === null) {
    throw new Error("result correction cannot create the attempt's first native session binding");
  }
  return attempt;
}

function liveBinding(input: {
  run: KernelRun;
  attempt: KernelAttempt;
  now: string;
}): KernelRuntimeSessionBinding | null {
  const { run, attempt } = input;
  const lease = attempt.lease;
  if (
    attempt.native_session_id === null || lease === null || !lease.started ||
    ((lease.purpose === "work" && attempt.status !== "running") ||
      (lease.purpose === "result_correction" && attempt.status !== "result_pending"))
  ) return null;
  if (
    attempt.pipeline_run_id !== run.id ||
    attempt.definition_bundle_hash !== run.definition_bundle_hash
  ) throw new Error("persisted runtime session binding changed its run identity");
  if (canonicalTimestamp(lease.expires_at, "lease expiry") <= canonicalTimestamp(input.now, "clock")) {
    return null;
  }
  return {
    pipeline_run_id: run.id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    input_subject: attempt.input_subject,
    native_session_id: attempt.native_session_id,
    scope: attempt.scope,
    generation: deriveKernelSteeringGeneration({
      attempt_version: attempt.version,
      work_retry_ordinal: attempt.work_retry_ordinal,
      result_correction_count: attempt.result_correction_count,
      lease_purpose: lease.purpose,
    }),
    attempt_status: attempt.status,
    repository_authority: attempt.repository_authority,
    lease_id: lease.id,
    lease_generation: lease.generation,
    lease_worker_id: lease.worker_id,
    lease_purpose: lease.purpose,
    lease_expires_at: lease.expires_at,
    lease_started: true,
  };
}

function bindCommand(input: {
  view: ReductionView;
  attempt: KernelAttempt;
  request: KernelRuntimeSessionBindRequest;
}): KernelCommand {
  const lease = input.attempt.lease!;
  // The reducer command carries the versions and renewable lease expiry read
  // from one aggregate view. They are CAS fences, not caller-visible session
  // generations. A concurrent heartbeat is retried against a fresh view.
  return {
    type: "bind_runtime_session",
    command_id: `bind-runtime-session:${digestCanonicalJson({
      schema: "openthrottle.bind-runtime-session/v1",
      ...input.request,
    })}`,
    attempt_id: input.attempt.id,
    expected_run_version: input.view.run.version,
    expected_cursor_version: input.view.run.cursor.version,
    expected_attempt_version: input.attempt.version,
    request_hash: input.request.request_hash,
    definition_bundle_hash: input.request.definition_bundle_hash,
    input_subject: input.request.input_subject,
    lease_id: input.request.lease_id,
    worker_id: input.request.worker_id,
    lease_purpose: input.request.lease_purpose,
    expected_lease_expires_at: lease.expires_at,
    expected_work_retry_ordinal: input.request.work_retry_ordinal,
    expected_result_correction_count: input.request.result_correction_count,
    native_session_id: input.request.native_session_id,
  };
}

function boundAttempt(bundle: AtomicTransitionBundle, attemptId: string): KernelAttempt {
  const matches = bundle.attempt_writes.filter(
    (write): write is Extract<typeof write, { kind: "replace" }> =>
      write.kind === "replace" && write.attempt.id === attemptId,
  );
  if (matches.length !== 1 || bundle.attempt_writes.length !== 1) {
    throw new Error("runtime session transition did not replace exactly one attempt");
  }
  return matches[0]!.attempt;
}

function staleTransition(error: unknown): boolean {
  return error instanceof Error && /stale (?:run|cursor|attempt)|compare-and-set/.test(error.message);
}

/**
 * Binds a provider-native session through the same atomic reducer/store CAS as
 * every other attempt transition. The caller reports immutable launch identity;
 * renewable versions and expiry are loaded here so heartbeats do not invalidate
 * a live launch. A genuine retry or replacement lease still fails closed.
 */
export class KernelRuntimeSessionService implements KernelRuntimeSessionBindingPort {
  readonly #transitions: KernelReductionPort;
  readonly #now: () => string;

  constructor(input: {
    transitions: KernelReductionPort;
    now?: () => string;
  }) {
    this.#transitions = input.transitions;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async bindRuntimeSession(
    request: KernelRuntimeSessionBindRequest,
  ): Promise<KernelRuntimeSessionBinding> {
    assertRequestShape(request);
    let view = await this.#load(request.pipeline_run_id, request.attempt_id);
    while (true) {
      const attempt = assertBindFences({ view, request, now: this.#now() });
      if (attempt.native_session_id !== null) {
        if (attempt.native_session_id !== request.native_session_id) {
          throw new Error(`attempt ${attempt.id} has a conflicting native session binding`);
        }
        const replay = liveBinding({ run: view.run, attempt, now: this.#now() });
        if (!replay) throw new Error("runtime session replay is no longer live");
        return replay;
      }

      const bundle = reduceKernelCommand({
        manifest: view.manifest,
        run: view.run,
        current_attempt: attempt,
        records: view.records,
        checkpoints: view.checkpoints,
        command: bindCommand({ view, attempt, request }),
      });
      try {
        await this.#transitions.applyAtomicTransition(bundle);
      } catch (error) {
        if (!staleTransition(error)) throw error;
        const refreshed = await this.#load(request.pipeline_run_id, request.attempt_id);
        if (refreshed.run.version <= view.run.version) throw error;
        view = refreshed;
        continue;
      }
      const binding = liveBinding({
        run: bundle.run,
        attempt: boundAttempt(bundle, attempt.id),
        now: this.#now(),
      });
      if (!binding) throw new Error("runtime session transition did not produce a live binding");
      return binding;
    }
  }

  async loadCurrentRuntimeSession(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelRuntimeSessionBinding | null> {
    validId(input.pipeline_run_id, "pipeline_run_id");
    validId(input.attempt_id, "attempt_id");
    const view = await this.#load(input.pipeline_run_id, input.attempt_id);
    const attempt = exactAttempt(view, input.attempt_id);
    return liveBinding({ run: view.run, attempt, now: this.#now() });
  }

  #load(pipelineRunId: string, attemptId: string): Promise<ReductionView> {
    return this.#transitions.loadExactReductionView({
      pipeline_run_id: pipelineRunId,
      attempt_id: attemptId,
      record_ids: [],
      checkpoint_ids: [],
    });
  }
}
