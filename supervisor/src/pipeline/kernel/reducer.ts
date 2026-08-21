import {
  RUNTIME_PROVISION_STAGE_ID,
  NATIVE_SESSION_ID,
  compareCodeUnits,
  digestCanonicalJson,
  runtimeStopStageId,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type DecisionRecord,
  type EffectIntent,
  type ExecutionRecord,
  type PipelineTerminalOutcome,
  type ResultRecord,
} from "@openthrottle/contracts";
import { authorizeEffectIntent } from "./effect-intent.js";
import { PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA } from "./evaluator-registry.js";
import {
  exactKernelRuntimeAbsenceDelivery,
  exactKernelRuntimeCleanupDeliveries,
} from "./runtime-resource.js";
import {
  runtimeCleanupOutcome,
  runtimeExhaustionDestination,
} from "./runtime-lifecycle.js";
import {
  assertAttemptCommandMapsEmpty,
  assertBaseInput,
  assertExactMap,
  attemptScopeKey,
  authorityForStage,
  compileKernelCursor,
  currentAttempt,
  sortedRecord,
  sortedUnique,
  stageFor,
} from "./reducer-support.js";
export {
  attemptScopeKey,
  compileKernelCursor,
  frontierMemberKey,
} from "./reducer-support.js";
import {
  ATOMIC_TRANSITION_SCHEMA,
  type AtomicTransitionBundle,
  type AtomicTransitionBundleContent,
  type AttemptScope,
  type AttemptWrite,
  type DecisionAuthorization,
  type KernelAttempt,
  type KernelCommand,
  type QuarantineAttemptRecoveryCommand,
  type KernelRun,
  type ReducerInput,
  type ResultDiagnostic,
  EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA,
  EXTERNAL_SCHEDULE_REDUCER,
  MAX_EXTERNAL_EFFECTS_PER_PHASE,
  canonicalAttemptContextIds,
} from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXTERNAL_PHASE = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;

function canonicalJsonValue(value: unknown): string {
  return JSON.stringify(value);
}
function expectedFor(
  run: KernelRun,
  attemptVersions: Readonly<Record<string, number>>,
): AtomicTransitionBundleContent["expected"] {
  return {
    run_id: run.id,
    run_version: run.version,
    cursor_version: run.cursor.version,
    attempt_versions: sortedRecord(attemptVersions),
  };
}

function bundle(content: AtomicTransitionBundleContent): AtomicTransitionBundle {
  return { ...content, content_hash: digestCanonicalJson(content) };
}

function baseContent(input: {
  command: KernelCommand;
  expected: AtomicTransitionBundleContent["expected"];
  run: KernelRun;
  attemptWrites?: readonly AttemptWrite[];
  createAttempts?: readonly KernelAttempt[];
  appendRecords?: readonly ExecutionRecord[];
  appendCheckpoints?: readonly AttemptCheckpoint[];
  putEffects?: readonly EffectIntent[];
  cancelEffectIds?: readonly string[];
}): AtomicTransitionBundleContent {
  return {
    schema: ATOMIC_TRANSITION_SCHEMA,
    transition_id: input.command.command_id,
    expected: input.expected,
    run: input.run,
    attempt_writes: [...(input.attemptWrites ?? [])].sort(attemptWriteOrder),
    create_attempts: [...(input.createAttempts ?? [])].sort(attemptOrder),
    append_records: [...(input.appendRecords ?? [])].sort((left, right) => compareCodeUnits(left.id, right.id)),
    append_checkpoints: [...(input.appendCheckpoints ?? [])]
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
    put_effects: [...(input.putEffects ?? [])].sort((left, right) => compareCodeUnits(left.id, right.id)),
    cancel_effect_ids: sortedUnique(input.cancelEffectIds ?? []),
  };
}

function attemptWriteOrder(left: AttemptWrite, right: AttemptWrite): number {
  const leftId = left.kind === "replace" ? left.attempt.id : left.attempt_id;
  const rightId = right.kind === "replace" ? right.attempt.id : right.attempt_id;
  return compareCodeUnits(leftId, rightId);
}

function attemptOrder(left: KernelAttempt, right: KernelAttempt): number {
  return compareCodeUnits(attemptScopeKey(left.scope), attemptScopeKey(right.scope)) ||
    compareCodeUnits(left.id, right.id);
}

function replaceAttempt(run: KernelRun, attempt: KernelAttempt): KernelRun {
  return {
    ...run,
    version: run.version + 1,
    status: run.status === "pending" ? "running" : run.status,
    active_attempt_versions: sortedRecord({
      ...run.active_attempt_versions,
      [attempt.id]: attempt.version,
    }),
  };
}

function assertCheckpointIdentity(
  checkpoint: AttemptCheckpoint,
  attempt: KernelAttempt,
  stage: CompiledPipelineStage,
): void {
  if (
    checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject
  ) {
    throw new Error(`checkpoint ${checkpoint.id} does not match the complete attempt identity`);
  }
  if (stage.kind === "agent") {
    if (attempt.native_session_id === null) {
      throw new Error(`agent attempt ${attempt.id} must bind its native session before checkpointing`);
    }
    if (checkpoint.native_session_id !== attempt.native_session_id) {
      throw new Error(`checkpoint ${checkpoint.id} changes the pinned native session`);
    }
  } else if (attempt.native_session_id !== null || checkpoint.native_session_id !== null) {
    throw new Error(`${stage.kind} checkpoints cannot bind an agent native session`);
  }
}

function assertSessionBindVersion(value: number, expected: number, name: string): void {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new Error(`runtime session ${name} version fence does not match`);
  }
}

function bindRuntimeSession(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "bind_runtime_session") {
    throw new Error("unreachable bind_runtime_session command");
  }
  assertAttemptCommandMapsEmpty(input);
  const attempt = currentAttempt(input, command.attempt_id);
  assertSessionBindVersion(command.expected_run_version, input.run.version, "run");
  assertSessionBindVersion(command.expected_cursor_version, input.run.cursor.version, "cursor");
  assertSessionBindVersion(command.expected_attempt_version, attempt.version, "attempt");
  if (
    command.request_hash !== attempt.request_hash ||
    command.definition_bundle_hash !== attempt.definition_bundle_hash ||
    command.definition_bundle_hash !== input.run.definition_bundle_hash ||
    command.input_subject !== attempt.input_subject
  ) throw new Error("runtime session immutable action identity fence does not match");
  if (
    command.expected_work_retry_ordinal !== attempt.work_retry_ordinal ||
    command.expected_result_correction_count !== attempt.result_correction_count
  ) throw new Error("runtime session retry ordinal fence does not match");
  const lease = attempt.lease;
  if (
    !lease || lease.id !== command.lease_id || lease.worker_id !== command.worker_id ||
    lease.purpose !== command.lease_purpose ||
    lease.expires_at !== command.expected_lease_expires_at
  ) throw new Error("runtime session lease fence does not match");
  if (!lease.started || lease.purpose !== "work" || attempt.status !== "running") {
    throw new Error("runtime session binding requires a started work lease");
  }
  if (attempt.native_session_id !== null) {
    throw new Error(`attempt ${attempt.id} already has a native session binding`);
  }
  if (!NATIVE_SESSION_ID.test(command.native_session_id)) {
    throw new Error("runtime native session identity is invalid");
  }
  const next: KernelAttempt = {
    ...attempt,
    native_session_id: command.native_session_id,
    version: attempt.version + 1,
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, next),
    attemptWrites: [{ kind: "replace", attempt: next }],
  }));
}

function exactCheckpoint(input: ReducerInput, checkpointId: string): AttemptCheckpoint {
  assertExactMap(input.checkpoints, [checkpointId], "checkpoint map");
  const checkpoint = input.checkpoints.get(checkpointId);
  if (!checkpoint) throw new Error(`missing exact checkpoint ${checkpointId}`);
  return checkpoint;
}

function exactDecision(input: ReducerInput, decisionId: string): DecisionAuthorization {
  const candidate = input.records.get(decisionId);
  if (!candidate || candidate.kind !== "decision") {
    throw new Error(`record ${decisionId} is not a DecisionRecord`);
  }
  if (candidate.input_record_ids.includes(candidate.id)) {
    throw new Error(`DecisionRecord ${decisionId} cannot cite itself`);
  }
  const expectedIds = [decisionId, ...candidate.input_record_ids];
  assertExactMap(input.records, expectedIds, "record map");
  const exactRecords = expectedIds.map((recordId) => {
    const record = input.records.get(recordId);
    if (!record) throw new Error(`DecisionRecord ${decisionId} references unavailable record ${recordId}`);
    return record;
  });
  return { decision: candidate, exact_records: exactRecords };
}

function assertPendingAttempt(
  attempt: KernelAttempt,
  input: {
    manifest: CompiledPipelineManifest;
    run: KernelRun;
    expectedStageId: string;
    expectedInputSubject: string;
  },
): void {
  if (attempt.pipeline_run_id !== input.run.id) throw new Error(`new attempt ${attempt.id} belongs to another run`);
  if (attempt.definition_bundle_hash !== input.run.definition_bundle_hash) {
    throw new Error(`new attempt ${attempt.id} has another definition bundle`);
  }
  if (attempt.scope.stage_id !== input.expectedStageId) {
    throw new Error(`new attempt ${attempt.id} does not target stage ${input.expectedStageId}`);
  }
  if (attempt.input_subject !== input.expectedInputSubject) {
    throw new Error(`new attempt ${attempt.id} does not use the run's verified subject`);
  }
  if (!DIGEST.test(attempt.request_hash)) throw new Error(`new attempt ${attempt.id} has an invalid request hash`);
  if (
    attempt.status !== "pending" || attempt.version !== 0 || attempt.lease !== null ||
    attempt.output_subject !== null || attempt.checkpoint_id !== null ||
    attempt.result_record_id !== null || attempt.pending_result !== null ||
    attempt.decision_record_id !== null ||
    attempt.result_correction_count !== 0 || attempt.result_correction_deadline !== null
  ) {
    throw new Error(`new attempt ${attempt.id} is not a pristine pending attempt`);
  }
  canonicalAttemptContextIds(attempt.context_record_ids, `attempt ${attempt.id} context_record_ids`);
  canonicalAttemptContextIds(
    attempt.context_checkpoint_ids,
    `attempt ${attempt.id} context_checkpoint_ids`,
  );
  if (attempt.scope.kind !== "stage") {
    if (
      !Number.isSafeInteger(
        attempt.scope.kind === "loop_item" ? attempt.scope.item_index : attempt.scope.member_index,
      ) ||
      (attempt.scope.kind === "loop_item" ? attempt.scope.item_index : attempt.scope.member_index) < 0
    ) {
      throw new Error(`new attempt ${attempt.id} has an invalid sibling index`);
    }
  }
  const stage = stageFor(input.manifest, input.expectedStageId);
  if (attempt.repository_authority !== authorityForStage(stage)) {
    throw new Error(`new attempt ${attempt.id} does not use the stage repository authority`);
  }
}

function sameStructuredLineage(left: AttemptScope, right: AttemptScope): boolean {
  if (left.kind === "stage" || right.kind === "stage" || left.kind !== right.kind) return false;
  if (left.kind === "loop_item" && right.kind === "loop_item") {
    return left.parent_attempt_id === right.parent_attempt_id &&
      left.loop_id === right.loop_id &&
      left.item_id === right.item_id &&
      left.item_index === right.item_index;
  }
  if (left.kind === "fanout_member" && right.kind === "fanout_member") {
    return left.parent_attempt_id === right.parent_attempt_id &&
      left.fanout_id === right.fanout_id &&
      left.member_id === right.member_id &&
      left.member_index === right.member_index;
  }
  return false;
}

function structuredSuccessorSubjects(input: {
  reducer: ReducerInput;
  sourceStage: CompiledPipelineStage;
  targetStage: CompiledPipelineStage;
  acceptedSubject: string;
  nextAttempts: readonly KernelAttempt[];
}): {
  subjects: ReadonlyMap<string, string>;
  checkpointIds: readonly string[];
} {
  const subjects = new Map<string, string>();
  const checkpointIds: string[] = [];
  for (const nextAttempt of input.nextAttempts) {
    let expectedSubject = input.acceptedSubject;
    const canContinueScopedSubject = nextAttempt.scope.kind !== "stage" &&
      input.sourceStage.kind !== "effect" && input.sourceStage.kind !== "wait" &&
      input.targetStage.kind !== "effect" && input.targetStage.kind !== "wait";
    const predecessor = canContinueScopedSubject
      ? input.reducer.run.cursor.frontier.find((member) =>
        sameStructuredLineage(member.scope, nextAttempt.scope))
      : undefined;
    if (predecessor) {
      const checkpointId = input.reducer.run.checkpoint_ids[predecessor.attempt_id];
      if (!checkpointId) {
        throw new Error(
          `structured predecessor ${predecessor.attempt_id} has no verified checkpoint`,
        );
      }
      const checkpoint = input.reducer.checkpoints.get(checkpointId);
      if (!checkpoint) {
        throw new Error(`missing exact structured predecessor checkpoint ${checkpointId}`);
      }
      if (
        checkpoint.pipeline_run_id !== input.reducer.run.id ||
        checkpoint.definition_bundle_hash !== input.reducer.run.definition_bundle_hash ||
        checkpoint.attempt_id !== predecessor.attempt_id
      ) {
        throw new Error(
          `structured predecessor checkpoint ${checkpointId} does not match item ${predecessor.scope_key}`,
        );
      }
      expectedSubject = checkpoint.output_subject ?? checkpoint.input_subject;
      checkpointIds.push(checkpointId);
    }
    subjects.set(nextAttempt.id, expectedSubject);
  }
  return { subjects, checkpointIds: sortedUnique(checkpointIds) };
}

function assertUniqueNewAttempts(
  attempts: readonly KernelAttempt[],
  run: KernelRun,
): void {
  const ids = attempts.map((attempt) => attempt.id);
  if (new Set(ids).size !== ids.length) throw new Error("new attempt identities must be unique");
  for (const id of ids) {
    if (run.active_attempt_versions[id] !== undefined) {
      throw new Error(`new attempt ${id} is already active`);
    }
  }
  const scopes = attempts.map((attempt) => attemptScopeKey(attempt.scope));
  if (new Set(scopes).size !== scopes.length) throw new Error("new sibling attempt scopes must be unique");
}

function recordForAttempt(input: ReducerInput, attempt: KernelAttempt, recordId: string): ResultRecord {
  assertExactMap(input.records, [recordId], "record map");
  const candidate = input.records.get(recordId);
  if (!candidate || candidate.kind !== "result") throw new Error(`record ${recordId} is not a ResultRecord`);
  if (
    candidate.attempt_id !== attempt.id ||
    candidate.request_hash !== attempt.request_hash ||
    candidate.definition_bundle_hash !== attempt.definition_bundle_hash ||
    candidate.input_subject !== attempt.input_subject ||
    candidate.output_subject !== attempt.output_subject
  ) {
    throw new Error(`ResultRecord ${recordId} does not match the complete attempt identity`);
  }
  return candidate;
}

function terminalAttemptWrites(
  run: KernelRun,
  current: KernelAttempt | null,
  status: "needs_human" | "failed" | "canceled" | "superseded",
): AttemptWrite[] {
  return Object.entries(run.active_attempt_versions).map(([attemptId, version]) => {
    if (current?.id === attemptId) {
      return {
        kind: "replace" as const,
        attempt: {
          ...current,
          status,
          version: current.version + 1,
          lease: null,
        },
      };
    }
    return {
      kind: "terminal" as const,
      attempt_id: attemptId,
      expected_version: version,
      next_version: version + 1,
      status,
    };
  }).sort(attemptWriteOrder);
}

function terminalRun(
  run: KernelRun,
  outcome: PipelineTerminalOutcome,
): KernelRun {
  return {
    ...run,
    status: outcome,
    terminal_outcome: outcome,
    version: run.version + 1,
    cursor: {
      ...run.cursor,
      stage_id: null,
      version: run.cursor.version + 1,
      frontier: [],
      barrier: null,
    },
    active_attempt_versions: {},
    active_effect_versions: {},
  };
}

export function reduceKernelRecoveryQuarantine(input: {
  run: KernelRun;
  current_attempt: KernelAttempt;
  diagnostic: DecisionRecord;
  command: QuarantineAttemptRecoveryCommand;
}): AtomicTransitionBundle {
  const { run, current_attempt: attempt, diagnostic, command } = input;
  const lease = attempt.lease;
  if (
    (run.status !== "pending" && run.status !== "running") || run.terminal_outcome !== null ||
    run.cursor.stage_id === null || run.active_attempt_versions[attempt.id] !== attempt.version ||
    attempt.pipeline_run_id !== run.id || attempt.scope.stage_id !== run.cursor.stage_id ||
    (attempt.status !== "pending" && attempt.status !== "running" && attempt.status !== "result_pending") ||
    !lease || lease.id !== command.lease_id || lease.generation !== command.lease_generation ||
    lease.worker_id !== command.worker_id || lease.purpose !== command.lease_purpose ||
    command.attempt_id !== attempt.id
  ) throw new Error("recovery quarantine does not own the exact active Attempt lease");
  if (lease.generation < run.work_retry_limit) {
    throw new Error(`attempt ${attempt.id} has not exhausted recovery retries`);
  }
  if (
    command.reason.length < 1 || command.reason.length > 1_500 || command.reason.includes("\0") ||
    command.decision_record_id !== diagnostic.id || diagnostic.kind !== "decision" ||
    diagnostic.pipeline_run_id !== run.id || diagnostic.reducer !== "core/executor-recovery-quarantine@1" ||
    diagnostic.input_record_ids.length !== 0 ||
    diagnostic.payload_schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in diagnostic.payload) || !diagnostic.payload.inline ||
    typeof diagnostic.payload.inline !== "object" || Array.isArray(diagnostic.payload.inline)
  ) throw new Error("recovery quarantine diagnostic is invalid");
  const payload = diagnostic.payload.inline as Record<string, unknown>;
  if (
    canonicalJsonValue(Object.keys(payload).sort()) !==
      canonicalJsonValue(["evaluator", "outcome", "reason", "schema", "stage_id"]) ||
    payload.schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    payload.stage_id !== attempt.scope.stage_id ||
    payload.evaluator !== diagnostic.reducer || payload.outcome !== "needs_human" ||
    payload.reason !== command.reason
  ) throw new Error("recovery quarantine diagnostic changed its executor evidence");

  const nextRun: KernelRun = {
    ...run,
    status: "needs_human",
    terminal_outcome: "needs_human",
    version: run.version + 1,
    cursor: {
      ...run.cursor,
      stage_id: null,
      version: run.cursor.version + 1,
      frontier: [],
      barrier: null,
    },
    active_attempt_versions: {},
    // A quarantine is not cleanup evidence. Keep unresolved Effect versions
    // visible and non-dispatchable under the terminal run for operator repair.
    active_effect_versions: run.active_effect_versions,
  };
  const attemptWrites = Object.entries(run.active_attempt_versions).map(([attemptId, version]) => ({
    kind: "terminal" as const,
    attempt_id: attemptId,
    expected_version: version,
    next_version: version + 1,
    status: "needs_human" as const,
  })).sort(attemptWriteOrder);
  return bundle(baseContent({
    command,
    expected: expectedFor(run, run.active_attempt_versions),
    run: nextRun,
    attemptWrites,
    appendRecords: [diagnostic],
  }));
}

function terminalCommand(
  input: ReducerInput,
  outcome: "needs_human" | "failed" | "canceled" | "superseded",
  decisionRecordId: string,
  commandAttemptId: string | null | undefined,
): AtomicTransitionBundle {
  assertExactMap(input.checkpoints, [], "checkpoint map");
  const authorization = exactDecision(input, decisionRecordId);
  const current = input.current_attempt;
  if (commandAttemptId !== undefined) {
    if ((current?.id ?? null) !== commandAttemptId) {
      throw new Error("terminal command does not match its exact current attempt");
    }
  }
  if (outcome === "failed" && current && current.status !== "pending" && current.status !== "running") {
    throw new Error("completed work cannot be discarded as a generic failure");
  }
  const disposition = input.command.type === "needs_human" || input.command.type === "fail" ||
      input.command.type === "stop" || input.command.type === "supersede"
    ? input.command.resource_disposition
    : null;
  if (disposition == null) throw new Error("terminal command has no runtime resource disposition");
  const expectedAttempts = sortedRecord(input.run.active_attempt_versions);
  if (disposition.kind === "pre_provision") {
    const stage = current === null ? null : stageFor(input.manifest, current.scope.stage_id);
    if (
      current === null || stage?.id !== RUNTIME_PROVISION_STAGE_ID || stage.kind !== "effect" ||
      stage.effect !== "core/daytona-provision@1" || current.checkpoint_id !== null ||
      current.output_subject !== null || Object.keys(input.run.active_effect_versions).length !== 0 ||
      authorization.decision.input_record_ids.length !== 0
    ) {
      throw new Error("pre-provision terminalization requires exact proof that no create schedule committed");
    }
    return bundle(baseContent({
      command: input.command,
      expected: expectedFor(input.run, expectedAttempts),
      run: terminalRun(input.run, outcome),
      attemptWrites: terminalAttemptWrites(input.run, current, outcome),
      appendRecords: [authorization.decision],
    }));
  }
  if (Object.keys(input.run.active_effect_versions).length !== 0) {
    throw new Error("runtime cleanup cannot begin while an external outcome is unresolved");
  }
  const evidenceIds = sortedUnique(disposition.runtime_delivery_record_ids);
  if (
    evidenceIds.length !== disposition.runtime_delivery_record_ids.length ||
    canonicalJsonValue(evidenceIds) !==
      canonicalJsonValue([...authorization.decision.input_record_ids].sort())
  ) throw new Error("runtime cleanup decision must cite exactly its declared DeliveryRecords");
  const evidence = authorization.exact_records.filter(
    (record) => record.id !== authorization.decision.id,
  );
  const cleanupDeliveries = exactKernelRuntimeCleanupDeliveries(evidence);
  if (
    cleanupDeliveries === null ||
    canonicalJsonValue(cleanupDeliveries.map(({ id }) => id).sort()) !== canonicalJsonValue(evidenceIds)
  ) throw new Error("runtime cleanup requires exact confirmed Daytona create evidence");
  const cleanupStageId = runtimeStopStageId(outcome);
  const cleanupStage = stageFor(input.manifest, cleanupStageId);
  if (cleanupStage.kind !== "effect" || cleanupStage.effect !== "core/daytona-stop@1") {
    throw new Error(`compiled manifest has no exact runtime stop stage for ${outcome}`);
  }
  assertUniqueNewAttempts([disposition.cleanup_attempt], input.run);
  assertPendingAttempt(disposition.cleanup_attempt, {
    manifest: input.manifest,
    run: input.run,
    expectedStageId: cleanupStageId,
    expectedInputSubject: input.run.current_subject,
  });
  const expectedContextIds = sortedUnique([authorization.decision.id, ...evidenceIds]);
  if (
    canonicalJsonValue(disposition.cleanup_attempt.context_record_ids) !==
    canonicalJsonValue(expectedContextIds) ||
    disposition.cleanup_attempt.context_checkpoint_ids.length !== 0
  ) throw new Error("runtime cleanup Attempt must seal exactly its decision and resource evidence");
  const nextRun: KernelRun = {
    ...input.run,
    status: "running",
    terminal_outcome: null,
    version: input.run.version + 1,
    cursor: compileKernelCursor({
      stage_id: cleanupStageId,
      version: input.run.cursor.version + 1,
      reentries: input.run.cursor.reentries,
      attempts: [disposition.cleanup_attempt],
      completed_scope_keys: input.run.cursor.completed_scope_keys,
    }),
    active_attempt_versions: { [disposition.cleanup_attempt.id]: 0 },
    active_effect_versions: {},
  };
  return bundle(baseContent({
    command: input.command,
    expected: expectedFor(input.run, expectedAttempts),
    run: nextRun,
    attemptWrites: terminalAttemptWrites(input.run, current, outcome),
    createAttempts: [disposition.cleanup_attempt],
    appendRecords: [authorization.decision],
  }));
}

function start(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "start") throw new Error("unreachable start command");
  assertAttemptCommandMapsEmpty(input);
  const attempt = currentAttempt(input, command.attempt_id);
  if (!attempt.lease || attempt.lease.id !== command.lease_id) {
    throw new Error(`attempt ${attempt.id} lease fence does not match`);
  }
  if (attempt.lease.started) throw new Error(`attempt ${attempt.id} lease already started`);
  if (attempt.status !== "pending" && attempt.status !== "result_pending") {
    throw new Error(`attempt ${attempt.id} cannot start from ${attempt.status}`);
  }
  const next: KernelAttempt = {
    ...attempt,
    status: attempt.lease.purpose === "work" ? "running" : "result_pending",
    version: attempt.version + 1,
    lease: { ...attempt.lease, started: true },
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, next),
    attemptWrites: [{ kind: "replace", attempt: next }],
  }));
}

function workComplete(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "work_complete") throw new Error("unreachable work_complete command");
  const resultRecordId = command.result_record_id;
  assertExactMap(input.records, resultRecordId === null ? [] : [resultRecordId], "record map");
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "running" || attempt.lease?.purpose !== "work" || !attempt.lease.started) {
    throw new Error(`attempt ${attempt.id} has not completed a started work lease`);
  }
  const stage = stageFor(input.manifest, attempt.scope.stage_id);
  const checkpoint = exactCheckpoint(input, command.checkpoint_id);
  assertCheckpointIdentity(checkpoint, attempt, stage);
  const checkpointOwner = Object.entries(input.run.checkpoint_ids)
    .find(([attemptId, checkpointId]) => checkpointId === checkpoint.id && attemptId !== attempt.id);
  if (checkpointOwner) {
    throw new Error(`checkpoint ${checkpoint.id} is already owned by attempt ${checkpointOwner[0]}`);
  }
  if (attempt.repository_authority === "edit") {
    if (
      command.verified_output_subject === null ||
      checkpoint.output_subject !== command.verified_output_subject
    ) {
      throw new Error("edit completion requires one matching verified output subject");
    }
  } else if (command.verified_output_subject !== null || checkpoint.output_subject !== null) {
    throw new Error("inspect completion cannot advance the repository subject");
  }
  const next: KernelAttempt = {
    ...attempt,
    status: "work_complete",
    version: attempt.version + 1,
    lease: null,
    output_subject: command.verified_output_subject,
    native_session_id: checkpoint.native_session_id,
    checkpoint_id: checkpoint.id,
    result_record_id: resultRecordId,
  };
  const result = resultRecordId === null ? null : recordForAttempt(input, next, resultRecordId);
  const nextRun = replaceAttempt(input.run, next);
  const withCheckpoint: KernelRun = {
    ...nextRun,
    checkpoint_ids: sortedRecord({
      ...input.run.checkpoint_ids,
      [attempt.id]: checkpoint.id,
    }),
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: withCheckpoint,
    attemptWrites: [{ kind: "replace", attempt: next }],
    appendRecords: result === null ? [] : [result],
    appendCheckpoints: [checkpoint],
  }));
}

function externalScheduleSemanticKey(attemptId: string, phase: string): string {
  return `external-schedule:${attemptId}:${phase}`;
}

function assertExternalScheduleDecision(input: {
  decision: DecisionAuthorization;
  attempt: KernelAttempt;
  phase: string;
  first_phase: boolean;
}): void {
  const { decision } = input.decision;
  if (
    !EXTERNAL_PHASE.test(input.phase) || input.phase.length > 100 ||
    decision.reducer !== EXTERNAL_SCHEDULE_REDUCER ||
    decision.payload_schema !== EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA ||
    !("inline" in decision.payload) || !decision.payload.inline ||
    typeof decision.payload.inline !== "object" || Array.isArray(decision.payload.inline)
  ) {
    throw new Error("external scheduling DecisionRecord has an invalid phase identity");
  }
  const payload = decision.payload.inline as Record<string, unknown>;
  const expectedSemanticKey = externalScheduleSemanticKey(input.attempt.id, input.phase);
  if (
    payload.schema !== EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA ||
    payload.semantic_key !== expectedSemanticKey ||
    payload.attempt_id !== input.attempt.id ||
    payload.phase !== input.phase
  ) {
    throw new Error(`external scheduling DecisionRecord must use semantic key ${expectedSemanticKey}`);
  }
  const cited = input.decision.exact_records.filter((record) => record.id !== decision.id);
  if (input.first_phase) {
    if (cited.length !== 0) {
      throw new Error("the first external phase cannot cite prior deliveries");
    }
    return;
  }
  if (
    cited.length === 0 ||
    cited.some((record) => record.kind !== "delivery" || record.status !== "confirmed")
  ) {
    throw new Error("a later external phase must cite confirmed DeliveryRecords");
  }
}

function scheduleExternal(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "schedule_external") throw new Error("unreachable schedule_external command");
  const attempt = currentAttempt(input, command.attempt_id);
  const stage = stageFor(input.manifest, attempt.scope.stage_id);
  if (stage.kind !== "effect" && stage.kind !== "wait") {
    throw new Error(`attempt ${attempt.id} is not an effect or wait stage`);
  }
  const firstPhase = attempt.status === "running";
  if (firstPhase) {
    if (attempt.lease?.purpose !== "work" || !attempt.lease.started || attempt.checkpoint_id !== null) {
      throw new Error(`external attempt ${attempt.id} has not started its work lease`);
    }
  } else if (
    attempt.status !== "work_complete" || attempt.lease !== null ||
    attempt.checkpoint_id !== command.checkpoint_id
  ) {
    throw new Error(`external attempt ${attempt.id} cannot schedule from ${attempt.status}`);
  }

  const checkpoint = exactCheckpoint(input, command.checkpoint_id);
  assertCheckpointIdentity(checkpoint, attempt, stage);
  if (stage.kind === "wait" && command.verified_output_subject !== null) {
    throw new Error("wait stages must preserve the repository subject");
  }
  if (checkpoint.output_subject !== command.verified_output_subject) {
    throw new Error("external checkpoint does not match its verified output subject");
  }
  if (!firstPhase && attempt.output_subject !== command.verified_output_subject) {
    throw new Error("later external phases cannot change the verified output subject");
  }
  const checkpointOwner = Object.entries(input.run.checkpoint_ids)
    .find(([attemptId, checkpointId]) => checkpointId === checkpoint.id && attemptId !== attempt.id);
  if (checkpointOwner) {
    throw new Error(`checkpoint ${checkpoint.id} is already owned by attempt ${checkpointOwner[0]}`);
  }

  const authorization = exactDecision(input, command.decision_record_id);
  assertExternalScheduleDecision({
    decision: authorization,
    attempt,
    phase: command.phase,
    first_phase: firstPhase,
  });
  if (
    command.effect_intents.length === 0 ||
    command.effect_intents.length > MAX_EXTERNAL_EFFECTS_PER_PHASE
  ) {
    throw new Error(`an external phase must contain between 1 and ${MAX_EXTERNAL_EFFECTS_PER_PHASE} effects`);
  }
  const effects = command.effect_intents.map((intent) =>
    authorizeEffectIntent(intent, authorization.decision, input.run.id),
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(effects.map((effect) => effect.id)).size !== effects.length) {
    throw new Error("effect intent identities must be unique within an external phase");
  }
  if (new Set(effects.map((effect) => effect.idempotency_key)).size !== effects.length) {
    throw new Error("effect intent idempotency keys must be unique within an external phase");
  }
  const acceptedSubject = command.verified_output_subject ?? input.run.current_subject;
  for (const effect of effects) {
    if (input.run.active_effect_versions[effect.id] !== undefined) {
      throw new Error(`effect intent ${effect.id} is already active`);
    }
    if (effect.subject !== null && effect.subject !== acceptedSubject) {
      throw new Error(`effect intent ${effect.id} does not use the executor-verified subject`);
    }
  }

  const next: KernelAttempt = {
    ...attempt,
    status: "work_complete",
    version: attempt.version + 1,
    lease: null,
    output_subject: command.verified_output_subject,
    native_session_id: null,
    checkpoint_id: checkpoint.id,
  };
  const activeEffects: Record<string, number> = { ...input.run.active_effect_versions };
  for (const effect of effects) activeEffects[effect.id] = 0;
  const nextRun = replaceAttempt(input.run, next);
  const withExternalBoundary: KernelRun = {
    ...nextRun,
    active_effect_versions: sortedRecord(activeEffects),
    checkpoint_ids: sortedRecord({
      ...input.run.checkpoint_ids,
      [attempt.id]: checkpoint.id,
    }),
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: withExternalBoundary,
    attemptWrites: [{ kind: "replace", attempt: next }],
    appendRecords: [authorization.decision],
    appendCheckpoints: firstPhase ? [checkpoint] : [],
    putEffects: effects,
  }));
}

function advanceExternalIntegration(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "advance_external_integration") {
    throw new Error("unreachable advance_external_integration command");
  }
  const attempt = currentAttempt(input, command.attempt_id);
  const stage = stageFor(input.manifest, attempt.scope.stage_id);
  if (
    stage.kind !== "effect" || stage.effect !== "core/integrate-unit@1" ||
    attempt.status !== "work_complete" || attempt.lease !== null ||
    attempt.output_subject !== null || attempt.checkpoint_id !== command.prior_checkpoint_id ||
    Object.keys(input.run.active_effect_versions).length !== 0
  ) throw new Error("external integration is not ready for its verified subject advance");
  assertExactMap(
    input.checkpoints,
    [command.prior_checkpoint_id, command.checkpoint_id],
    "checkpoint map",
  );
  const prior = input.checkpoints.get(command.prior_checkpoint_id)!;
  const checkpoint = input.checkpoints.get(command.checkpoint_id)!;
  assertCheckpointIdentity(prior, attempt, stage);
  assertCheckpointIdentity(checkpoint, attempt, stage);
  if (
    prior.output_subject !== null || checkpoint.output_subject !== command.verified_output_subject ||
    !GIT_SUBJECT.test(command.verified_output_subject) ||
    checkpoint.id === prior.id || !("blob" in checkpoint.payload) ||
    checkpoint.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" ||
    checkpoint.payload.blob.encoding !== "binary" ||
    checkpoint.payload.blob.media_type !== "application/x-git-bundle"
  ) throw new Error("external integration checkpoint does not prove one exact Git subject advance");

  assertExactMap(input.records, [command.delivery_record_id], "record map");
  const delivery = input.records.get(command.delivery_record_id);
  if (
    !delivery || delivery.kind !== "delivery" || delivery.status !== "confirmed" ||
    delivery.pipeline_run_id !== input.run.id ||
    delivery.payload_schema !== "openthrottle.effect-delivery/v1" ||
    !("inline" in delivery.payload) || !delivery.payload.inline ||
    typeof delivery.payload.inline !== "object" || Array.isArray(delivery.payload.inline)
  ) throw new Error("external integration requires one exact confirmed DeliveryRecord");
  const envelope = delivery.payload.inline as Record<string, unknown>;
  const result = envelope.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("external integration DeliveryRecord has no materialized result");
  }
  const evidence = result as Record<string, unknown>;
  if (
    envelope.effect_kind !== "daytona/integrate-checkpoint@1" || envelope.provider !== "daytona" ||
    evidence.schema !== "openthrottle.daytona-integration-delivery/v1" ||
    evidence.state !== "integrated" || evidence.pipeline_run_id !== input.run.id ||
    evidence.attempt_id !== attempt.id || evidence.effect_id !== delivery.effect_id ||
    evidence.idempotency_key !== delivery.idempotency_key ||
    evidence.input_subject !== attempt.input_subject ||
    evidence.output_subject !== command.verified_output_subject ||
    evidence.checkpoint_id !== checkpoint.id ||
    evidence.checkpoint_payload_schema !== checkpoint.payload_schema ||
    canonicalJsonValue(evidence.checkpoint_blob) !== canonicalJsonValue(checkpoint.payload.blob)
  ) throw new Error("external integration DeliveryRecord changed its exact attempt or blob identity");

  const next: KernelAttempt = {
    ...attempt,
    version: attempt.version + 1,
    output_subject: command.verified_output_subject,
    checkpoint_id: checkpoint.id,
  };
  const nextRun = replaceAttempt(input.run, next);
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: {
      ...nextRun,
      checkpoint_ids: sortedRecord({
        ...input.run.checkpoint_ids,
        [attempt.id]: checkpoint.id,
      }),
    },
    attemptWrites: [{ kind: "replace", attempt: next }],
    appendCheckpoints: [checkpoint],
  }));
}

function normalizedDiagnostics(diagnostics: readonly ResultDiagnostic[]): ResultDiagnostic[] {
  if (diagnostics.length === 0) throw new Error("result_pending requires at least one diagnostic");
  return diagnostics.map((diagnostic) => {
    if (!diagnostic.path || !diagnostic.detail) {
      throw new Error("result_pending diagnostics require a path and detail");
    }
    return { path: diagnostic.path, detail: diagnostic.detail };
  }).sort((left, right) =>
    compareCodeUnits(left.path, right.path) || compareCodeUnits(left.detail, right.detail));
}

function resultPending(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "result_pending") throw new Error("unreachable result_pending command");
  assertExactMap(input.records, [], "record map");
  const attempt = currentAttempt(input, command.attempt_id);
  const retryingCorrection = attempt.status === "result_pending" &&
    attempt.lease?.purpose === "result_correction" && attempt.lease.started;
  if ((attempt.status !== "work_complete" && !retryingCorrection) || !attempt.checkpoint_id) {
    throw new Error(`attempt ${attempt.id} cannot enter result_pending before work completion`);
  }
  const checkpoint = exactCheckpoint(input, attempt.checkpoint_id);
  assertCheckpointIdentity(
    checkpoint,
    attempt,
    stageFor(input.manifest, attempt.scope.stage_id),
  );
  if (command.candidate_hash !== null && !DIGEST.test(command.candidate_hash)) {
    throw new Error("result_pending candidate hash is invalid");
  }
  if (!attempt.native_session_id) {
    throw new Error(`attempt ${attempt.id} cannot correct a result without its native session`);
  }
  if (
    !ISO_TIMESTAMP.test(command.correction_deadline) ||
    !Number.isFinite(Date.parse(command.correction_deadline)) ||
    new Date(command.correction_deadline).toISOString() !== command.correction_deadline
  ) {
    throw new Error("result_pending correction deadline is invalid");
  }
  if (
    attempt.result_correction_deadline !== null &&
    attempt.result_correction_deadline !== command.correction_deadline
  ) {
    throw new Error("result_pending cannot change its correction deadline");
  }
  const next: KernelAttempt = {
    ...attempt,
    status: "result_pending",
    version: attempt.version + 1,
    lease: null,
    result_correction_deadline: command.correction_deadline,
    pending_result: {
      candidate_hash: command.candidate_hash,
      diagnostics: normalizedDiagnostics(command.diagnostics),
    },
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, next),
    attemptWrites: [{ kind: "replace", attempt: next }],
  }));
}

function record(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "record") throw new Error("unreachable record command");
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "work_complete" && attempt.status !== "result_pending") {
    throw new Error(`attempt ${attempt.id} cannot record a result from ${attempt.status}`);
  }
  if (!attempt.checkpoint_id) throw new Error(`attempt ${attempt.id} has no verified checkpoint`);
  const stage = stageFor(input.manifest, attempt.scope.stage_id);
  const checkpoint = exactCheckpoint(input, attempt.checkpoint_id);
  assertCheckpointIdentity(checkpoint, attempt, stage);
  const result = recordForAttempt(input, attempt, command.record_id);
  if (attempt.result_record_id !== null && attempt.result_record_id !== result.id) {
    throw new Error(`attempt ${attempt.id} already persists another authoritative result`);
  }
  if (attempt.repository_authority === "edit" && result.output_subject === null) {
    throw new Error("edit ResultRecord must retain its verified output subject");
  }
  if (
    attempt.repository_authority === "inspect" && stage.kind !== "effect" &&
    result.output_subject !== null
  ) {
    throw new Error("inspect ResultRecord cannot advance the repository subject");
  }
  if (stage.kind === "wait" && result.output_subject !== null) {
    throw new Error("wait ResultRecord cannot advance the repository subject");
  }
  const next: KernelAttempt = {
    ...attempt,
    status: "recorded",
    version: attempt.version + 1,
    lease: null,
    result_record_id: result.id,
    pending_result: null,
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, next),
    attemptWrites: [{ kind: "replace", attempt: next }],
    appendRecords: attempt.result_record_id === null ? [result] : [],
  }));
}

function effectiveTransition(input: {
  run: KernelRun;
  stage: CompiledPipelineStage;
  outcome: string;
}): {
  to?: string;
  terminal?: PipelineTerminalOutcome;
  reentries: Readonly<Record<string, number>>;
} {
  const transition = input.stage.on[input.outcome];
  if (!transition) throw new Error(`stage ${input.stage.id} has no transition for ${input.outcome}`);
  if (transition.max_reentries === undefined || transition.to === undefined) {
    return { ...transition, reentries: input.run.cursor.reentries };
  }
  const edge = `${input.stage.id}:${input.outcome}:${transition.to}`;
  const used = input.run.cursor.reentries[edge] ?? 0;
  if (used >= transition.max_reentries) {
    const cleanupOutcome = runtimeCleanupOutcome(input.stage);
    if (cleanupOutcome !== null) {
      return {
        terminal: transition.on_exhausted === "needs_human" ? "needs_human" : "failed",
        reentries: input.run.cursor.reentries,
      };
    }
    const runtimeDestination = runtimeExhaustionDestination(input.stage);
    return {
      to: runtimeDestination ?? runtimeStopStageId(transition.on_exhausted!),
      reentries: input.run.cursor.reentries,
    };
  }
  return {
    to: transition.to,
    reentries: sortedRecord({ ...input.run.cursor.reentries, [edge]: used + 1 }),
  };
}

function settle(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "settle") throw new Error("unreachable settle command");
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "recorded" || !attempt.result_record_id) {
    throw new Error(`attempt ${attempt.id} cannot settle before its ResultRecord`);
  }
  const authorization = exactDecision(input, command.decision_record_id);
  if (!authorization.decision.input_record_ids.includes(attempt.result_record_id)) {
    throw new Error("settlement DecisionRecord must cite the current ResultRecord");
  }
  const stage = stageFor(input.manifest, attempt.scope.stage_id);
  if (!stage.on[command.outcome]) {
    throw new Error(`stage ${stage.id} has no transition for ${command.outcome}`);
  }
  const cursorMember = input.run.cursor.frontier.find((member) => member.attempt_id === attempt.id);
  if (!cursorMember || !input.run.cursor.barrier) {
    throw new Error(`attempt ${attempt.id} is outside the active cursor barrier`);
  }
  const completedScopeKeys = sortedUnique([
    ...input.run.cursor.completed_scope_keys,
    cursorMember.scope_key,
  ]);
  const barrierComplete = input.run.cursor.barrier.member_scope_keys.every(
    (scopeKey) => completedScopeKeys.includes(scopeKey),
  );
  const settledAttempt: KernelAttempt = {
    ...attempt,
    status: "settled",
    version: attempt.version + 1,
    lease: null,
    decision_record_id: authorization.decision.id,
  };
  const remainingAttempts = { ...input.run.active_attempt_versions };
  delete remainingAttempts[attempt.id];

  if (!barrierComplete) {
    assertExactMap(input.checkpoints, [], "checkpoint map");
    if (
      command.next_attempts.length > 0 ||
      (command.effect_intents?.length ?? 0) > 0 ||
      Object.keys(command.next_dependencies ?? {}).length > 0
    ) {
      throw new Error("a sibling cannot advance the pipeline cursor before the fan-in is complete");
    }
    const nextRun: KernelRun = {
      ...input.run,
      version: input.run.version + 1,
      cursor: {
        ...input.run.cursor,
        version: input.run.cursor.version + 1,
        completed_scope_keys: completedScopeKeys,
      },
      active_attempt_versions: sortedRecord(remainingAttempts),
    };
    return bundle(baseContent({
      command,
      expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
      run: nextRun,
      attemptWrites: [{ kind: "replace", attempt: settledAttempt }],
      appendRecords: [authorization.decision],
    }));
  }

  const acceptedSubject = stage.kind === "effect" && attempt.output_subject !== null
    ? attempt.output_subject
    : attempt.repository_authority === "edit" && attempt.scope.kind === "stage"
      ? attempt.output_subject
      : input.run.current_subject;
  if (acceptedSubject === null) throw new Error("accepted edit settlement has no verified output subject");
  const runAtAcceptedSubject: KernelRun = { ...input.run, current_subject: acceptedSubject };
  const transition = effectiveTransition({ run: runAtAcceptedSubject, stage, outcome: command.outcome });
  if (transition.terminal !== undefined) {
    assertExactMap(input.checkpoints, [], "checkpoint map");
    if (command.next_attempts.length > 0) throw new Error("terminal transition cannot schedule attempts");
    if ((command.effect_intents?.length ?? 0) > 0) {
      throw new Error("terminal transition cannot leave unobserved effects");
    }
    if (Object.keys(command.next_dependencies ?? {}).length > 0) {
      throw new Error("terminal transition cannot declare a dependency frontier");
    }
    if (Object.keys(input.run.active_effect_versions).length > 0) {
      throw new Error("terminal transition cannot strand active effects");
    }
    const cleanupOutcome = runtimeCleanupOutcome(stage);
    const isCleanupTerminal = cleanupOutcome !== null;
    const isProvenAbsent =
      stage.id === RUNTIME_PROVISION_STAGE_ID && stage.kind === "effect" &&
      stage.effect === "core/daytona-provision@1" && command.outcome === "no_resource" &&
      transition.terminal === "failed";
    if (!isCleanupTerminal && !isProvenAbsent) {
      throw new Error("terminal transition bypasses the compiled runtime cleanup protocol");
    }
    if (isCleanupTerminal) {
      const cited = authorization.exact_records.filter(
        (record) => record.id !== authorization.decision.id && record.id !== attempt.result_record_id,
      );
      const cleanupDelivery = cited.find((record) => {
        if (record.kind !== "delivery" || !("inline" in record.payload)) return false;
        const payload = record.payload.inline;
        return record.payload_schema === "openthrottle.effect-delivery/v1" &&
          payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
          payload.effect_kind === "daytona/cleanup-sandbox@1" && payload.provider === "daytona";
      });
      if (!cleanupDelivery) {
        throw new Error("runtime cleanup terminal transition requires its exact DeliveryRecord");
      }
    } else {
      const cited = authorization.exact_records.filter(
        (record) => record.id !== authorization.decision.id && record.id !== attempt.result_record_id,
      );
      if (exactKernelRuntimeAbsenceDelivery(cited) === null) {
        throw new Error("no-resource terminal transition requires exact rejected-create absence proof");
      }
    }
  } else {
    if (!transition.to) throw new Error("pipeline transition is missing its destination");
    if (command.next_attempts.length === 0) {
      throw new Error(`transition to ${transition.to} must schedule at least one attempt`);
    }
    const targetStage = stageFor(input.manifest, transition.to);
    const structuredSubjects = structuredSuccessorSubjects({
      reducer: input,
      sourceStage: stage,
      targetStage,
      acceptedSubject,
      nextAttempts: command.next_attempts,
    });
    assertExactMap(input.checkpoints, structuredSubjects.checkpointIds, "checkpoint map");
    assertUniqueNewAttempts(command.next_attempts, input.run);
    for (const nextAttempt of command.next_attempts) {
      assertPendingAttempt(nextAttempt, {
        manifest: input.manifest,
        run: runAtAcceptedSubject,
        expectedStageId: transition.to,
        expectedInputSubject: structuredSubjects.subjects.get(nextAttempt.id)!,
      });
    }
  }

  const effects = (command.effect_intents ?? []).map((intent) =>
    authorizeEffectIntent(intent, authorization.decision, input.run.id),
  ).sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(effects.map((effect) => effect.id)).size !== effects.length) {
    throw new Error("effect intent identities must be unique within a transition");
  }
  if (new Set(effects.map((effect) => effect.idempotency_key)).size !== effects.length) {
    throw new Error("effect intent idempotency keys must be unique within a transition");
  }
  for (const effect of effects) {
    if (input.run.active_effect_versions[effect.id] !== undefined) {
      throw new Error(`effect intent ${effect.id} is already active`);
    }
    if (effect.subject !== null && effect.subject !== acceptedSubject) {
      throw new Error(`effect intent ${effect.id} does not use the accepted repository subject`);
    }
  }
  const activeAttempts: Record<string, number> = {};
  for (const nextAttempt of [...command.next_attempts].sort(attemptOrder)) {
    activeAttempts[nextAttempt.id] = nextAttempt.version;
  }
  const activeEffects: Record<string, number> = { ...input.run.active_effect_versions };
  for (const effect of effects) activeEffects[effect.id] = 0;
  const nextRun: KernelRun = transition.terminal !== undefined
    ? terminalRun({
      ...runAtAcceptedSubject,
      cursor: {
        ...runAtAcceptedSubject.cursor,
        completed_scope_keys: completedScopeKeys,
      },
    }, transition.terminal)
    : {
      ...runAtAcceptedSubject,
      status: "running",
      version: input.run.version + 1,
      cursor: compileKernelCursor({
        stage_id: transition.to!,
        version: input.run.cursor.version + 1,
        reentries: transition.reentries,
        attempts: command.next_attempts,
        dependencies: command.next_dependencies,
        completed_scope_keys: completedScopeKeys,
      }),
      active_attempt_versions: sortedRecord(activeAttempts),
      active_effect_versions: sortedRecord(activeEffects),
    };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: nextRun,
    attemptWrites: [{ kind: "replace", attempt: settledAttempt }],
    createAttempts: command.next_attempts,
    appendRecords: [authorization.decision],
    putEffects: effects,
  }));
}

function retry(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "retry") throw new Error("unreachable retry command");
  assertAttemptCommandMapsEmpty(input);
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "pending" && attempt.status !== "running") {
    throw new Error(`attempt ${attempt.id} cannot consume a work retry from ${attempt.status}`);
  }
  if (attempt.work_retry_ordinal >= input.run.work_retry_limit) {
    throw new Error(`attempt ${attempt.id} exhausted work retries`);
  }
  const retriedAttempt: KernelAttempt = {
    ...attempt,
    status: "pending",
    version: attempt.version + 1,
    work_retry_ordinal: attempt.work_retry_ordinal + 1,
    native_session_id: null,
    lease: null,
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, retriedAttempt),
    attemptWrites: [{ kind: "replace", attempt: retriedAttempt }],
  }));
}

export function reduceKernelCommand(input: ReducerInput): AtomicTransitionBundle {
  assertBaseInput(input);
  switch (input.command.type) {
    case "start":
      return start(input);
    case "bind_runtime_session":
      return bindRuntimeSession(input);
    case "work_complete":
      return workComplete(input);
    case "schedule_external":
      return scheduleExternal(input);
    case "advance_external_integration":
      return advanceExternalIntegration(input);
    case "result_pending":
      return resultPending(input);
    case "record":
      return record(input);
    case "settle":
      return settle(input);
    case "retry":
      return retry(input);
    case "quarantine_attempt_recovery": {
      assertExactMap(input.records, [input.command.decision_record_id], "record map");
      assertExactMap(input.checkpoints, [], "checkpoint map");
      const diagnostic = input.records.get(input.command.decision_record_id);
      if (!diagnostic || diagnostic.kind !== "decision") {
        throw new Error("recovery quarantine requires its exact DecisionRecord");
      }
      return reduceKernelRecoveryQuarantine({
        run: input.run,
        current_attempt: currentAttempt(input, input.command.attempt_id),
        diagnostic,
        command: input.command,
      });
    }
    case "needs_human":
      return terminalCommand(
        input,
        "needs_human",
        input.command.decision_record_id,
        input.command.attempt_id,
      );
    case "fail":
      return terminalCommand(
        input,
        "failed",
        input.command.decision_record_id,
        input.command.attempt_id,
      );
    case "stop":
      return terminalCommand(input, "canceled", input.command.decision_record_id, undefined);
    case "supersede":
      return terminalCommand(input, "superseded", input.command.decision_record_id, undefined);
  }
}
