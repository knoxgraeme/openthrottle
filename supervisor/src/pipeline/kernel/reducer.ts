import {
  digestCanonicalJson,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type EffectIntent,
  type ExecutionRecord,
  type PipelineTerminalOutcome,
  type ResultRecord,
} from "@openthrottle/contracts";
import { authorizeEffectIntent } from "./effect-intent.js";
import {
  ATOMIC_TRANSITION_SCHEMA,
  type AtomicTransitionBundle,
  type AtomicTransitionBundleContent,
  type AttemptScope,
  type AttemptWrite,
  type DecisionAuthorization,
  type KernelCursor,
  type KernelFrontierMember,
  type KernelAttempt,
  type KernelCommand,
  type KernelRun,
  type ReducerInput,
  type ResultDiagnostic,
} from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const TERMINAL_ATTEMPT_STATES = new Set([
  "settled", "needs_human", "failed", "canceled", "superseded",
]);
const TERMINAL_RUN_STATES = new Set([
  "completed", "no_change", "needs_human", "failed", "canceled", "superseded",
]);

function sortedRecord<T>(input: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mapKeys(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort((left, right) => left.localeCompare(right));
}

function assertExactMap(
  map: ReadonlyMap<string, unknown>,
  expectedIds: readonly string[],
  name: string,
): void {
  const actual = mapKeys(map);
  const expected = sortedUnique(expectedIds);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${expected.join(", ") || "(none)"}`);
  }
}

function assertBaseInput(input: ReducerInput): void {
  const { manifest, run } = input;
  if (manifest.pipeline_id !== run.pipeline_id) {
    throw new Error("compiled manifest does not belong to the pipeline run");
  }
  if (manifest.definition_bundle_hash !== run.definition_bundle_hash) {
    throw new Error("compiled manifest definition bundle does not match the pipeline run");
  }
  if (run.version < 0 || run.cursor.version < 0) throw new Error("kernel versions must be non-negative");
  if (!DIGEST.test(run.definition_bundle_hash)) throw new Error("invalid definition bundle hash");
  if (!GIT_SUBJECT.test(run.current_subject)) throw new Error("invalid run subject");
  if (TERMINAL_RUN_STATES.has(run.status)) {
    throw new Error(`pipeline run ${run.id} is already terminal`);
  }
  if (run.terminal_outcome !== null) throw new Error("non-terminal run cannot have a terminal outcome");
  if (run.cursor.stage_id === null) throw new Error("non-terminal run must have an active cursor stage");
  const activeStage = stageFor(manifest, run.cursor.stage_id);
  assertCursorTopology(run, input.current_attempt);
  for (const [recordId, record] of input.records) {
    if (recordId !== record.id) throw new Error(`record map key ${recordId} does not match record identity`);
    if (record.pipeline_run_id !== run.id) throw new Error(`record ${recordId} belongs to another pipeline run`);
  }
  for (const [checkpointId, checkpoint] of input.checkpoints) {
    if (checkpointId !== checkpoint.id) {
      throw new Error(`checkpoint map key ${checkpointId} does not match checkpoint identity`);
    }
    if (checkpoint.pipeline_run_id !== run.id) {
      throw new Error(`checkpoint ${checkpointId} belongs to another pipeline run`);
    }
  }
  if (input.current_attempt) {
    assertActiveAttempt(input.run, input.current_attempt);
    if (input.current_attempt.repository_authority !== authorityForStage(activeStage)) {
      throw new Error(`attempt ${input.current_attempt.id} does not use the stage repository authority`);
    }
    if (input.current_attempt.input_subject !== run.current_subject) {
      throw new Error(`attempt ${input.current_attempt.id} does not use the current run subject`);
    }
  }
}

function assertCursorTopology(run: KernelRun, current: KernelAttempt | null): void {
  const cursor = run.cursor;
  if (!cursor.barrier || cursor.barrier.kind !== "all") {
    throw new Error("active kernel cursor requires an all-member barrier");
  }
  const frontierKeys = cursor.frontier.map((member) => member.scope_key);
  if (canonicalJsonValue(frontierKeys) !== canonicalJsonValue([...frontierKeys].sort())) {
    throw new Error("kernel cursor frontier is not in canonical order");
  }
  if (new Set(frontierKeys).size !== frontierKeys.length) {
    throw new Error("kernel cursor frontier contains duplicate scope keys");
  }
  const memberIds = cursor.frontier.map((member) => member.attempt_id);
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error("kernel cursor frontier contains duplicate attempt identities");
  }
  for (const member of cursor.frontier) {
    if (
      member.scope_key !== `${attemptScopeKey(member.scope)}@${member.attempt_id}` ||
      member.scope.stage_id !== cursor.stage_id
    ) {
      throw new Error(`kernel cursor frontier member ${member.attempt_id} is not canonical`);
    }
    for (const dependency of member.depends_on) {
      if (!frontierKeys.includes(dependency) && !cursor.completed_scope_keys.includes(dependency)) {
        throw new Error(`kernel cursor dependency ${dependency} is unavailable`);
      }
    }
    if (canonicalJsonValue(member.depends_on) !== canonicalJsonValue(sortedUnique(member.depends_on))) {
      throw new Error(`kernel cursor member ${member.attempt_id} dependencies are not canonical`);
    }
  }
  if (
    canonicalJsonValue(cursor.completed_scope_keys) !==
    canonicalJsonValue(sortedUnique(cursor.completed_scope_keys))
  ) {
    throw new Error("kernel cursor completed scope keys are not canonical");
  }
  const barrierMembers = sortedUnique(cursor.barrier.member_scope_keys);
  if (canonicalJsonValue(barrierMembers) !== canonicalJsonValue(sortedUnique(frontierKeys))) {
    throw new Error("kernel cursor barrier does not match its frontier");
  }
  const unsettledAttemptIds = cursor.frontier
    .filter((member) => !cursor.completed_scope_keys.includes(member.scope_key))
    .map((member) => member.attempt_id)
    .sort((left, right) => left.localeCompare(right));
  const activeAttemptIds = Object.keys(run.active_attempt_versions)
    .sort((left, right) => left.localeCompare(right));
  if (canonicalJsonValue(unsettledAttemptIds) !== canonicalJsonValue(activeAttemptIds)) {
    throw new Error("kernel run active attempts do not match its unsettled frontier");
  }
  if (current) {
    const member = cursor.frontier.find((candidate) => candidate.attempt_id === current.id);
    if (!member) throw new Error(`attempt ${current.id} is absent from the kernel cursor frontier`);
    const unmet = member.depends_on.filter(
      (dependency) => !cursor.completed_scope_keys.includes(dependency),
    );
    if (unmet.length > 0) {
      throw new Error(`attempt ${current.id} was selected before its dependencies completed`);
    }
  }
}

function canonicalJsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function stageFor(manifest: CompiledPipelineManifest, stageId: string): CompiledPipelineStage {
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`compiled manifest does not contain stage ${stageId}`);
  return stage;
}

function authorityForStage(stage: CompiledPipelineStage): "inspect" | "edit" {
  return stage.kind === "agent" ? stage.repository_authority : "inspect";
}

function assertActiveAttempt(run: KernelRun, attempt: KernelAttempt): void {
  if (attempt.pipeline_run_id !== run.id) throw new Error(`attempt ${attempt.id} belongs to another run`);
  if (attempt.definition_bundle_hash !== run.definition_bundle_hash) {
    throw new Error(`attempt ${attempt.id} has another definition bundle`);
  }
  if (run.active_attempt_versions[attempt.id] !== attempt.version) {
    throw new Error(`attempt ${attempt.id} is not active at version ${attempt.version}`);
  }
  if (attempt.scope.stage_id !== run.cursor.stage_id) {
    throw new Error(`attempt ${attempt.id} is outside the active pipeline cursor`);
  }
  if (TERMINAL_ATTEMPT_STATES.has(attempt.status)) {
    throw new Error(`attempt ${attempt.id} is already terminal`);
  }
}

function currentAttempt(input: ReducerInput, attemptId: string): KernelAttempt {
  const attempt = input.current_attempt;
  if (!attempt || attempt.id !== attemptId) {
    throw new Error(`command targets attempt ${attemptId} without its exact current aggregate`);
  }
  return attempt;
}

function assertAttemptCommandMapsEmpty(input: ReducerInput): void {
  assertExactMap(input.records, [], "record map");
  assertExactMap(input.checkpoints, [], "checkpoint map");
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
    append_records: [...(input.appendRecords ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    append_checkpoints: [...(input.appendCheckpoints ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id)),
    put_effects: [...(input.putEffects ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    cancel_effect_ids: sortedUnique(input.cancelEffectIds ?? []),
  };
}

function attemptWriteOrder(left: AttemptWrite, right: AttemptWrite): number {
  const leftId = left.kind === "replace" ? left.attempt.id : left.attempt_id;
  const rightId = right.kind === "replace" ? right.attempt.id : right.attempt_id;
  return leftId.localeCompare(rightId);
}

export function attemptScopeKey(scope: AttemptScope): string {
  if (scope.kind === "stage") return `0:${scope.stage_id}`;
  if (scope.kind === "loop_item") {
    return `1:${scope.stage_id}:${scope.loop_id}:${String(scope.item_index).padStart(10, "0")}:${scope.item_id}`;
  }
  return `2:${scope.stage_id}:${scope.fanout_id}:${String(scope.member_index).padStart(10, "0")}:${scope.member_id}`;
}

export function frontierMemberKey(attempt: Pick<KernelAttempt, "id" | "scope">): string {
  return `${attemptScopeKey(attempt.scope)}@${attempt.id}`;
}

export function compileKernelCursor(input: {
  stage_id: string;
  version: number;
  reentries?: Readonly<Record<string, number>>;
  attempts: readonly KernelAttempt[];
  dependencies?: Readonly<Record<string, readonly string[]>>;
  completed_scope_keys?: readonly string[];
}): KernelCursor {
  if (input.attempts.length === 0) throw new Error("kernel cursor frontier cannot be empty");
  const completed = sortedUnique(input.completed_scope_keys ?? []);
  const memberKeys = input.attempts.map(frontierMemberKey);
  if (new Set(memberKeys).size !== memberKeys.length) {
    throw new Error("kernel cursor frontier scope keys must be unique");
  }
  const logicalScopeKeys = input.attempts.map((attempt) => attemptScopeKey(attempt.scope));
  if (new Set(logicalScopeKeys).size !== logicalScopeKeys.length) {
    throw new Error("kernel cursor frontier logical scopes must be unique");
  }
  const dependencyKeys = Object.keys(input.dependencies ?? {});
  const unknownDependencyOwner = dependencyKeys.find((key) => !memberKeys.includes(key));
  if (unknownDependencyOwner) {
    throw new Error(`kernel cursor dependencies name unknown member ${unknownDependencyOwner}`);
  }
  const known = new Set([...memberKeys, ...completed]);
  const frontier: KernelFrontierMember[] = input.attempts.map((candidate) => {
    if (candidate.scope.stage_id !== input.stage_id) {
      throw new Error(`kernel cursor member ${candidate.id} targets another stage`);
    }
    const scopeKey = frontierMemberKey(candidate);
    const dependencies = sortedUnique(input.dependencies?.[scopeKey] ?? []);
    if (dependencies.includes(scopeKey)) {
      throw new Error(`kernel cursor member ${scopeKey} cannot depend on itself`);
    }
    const unknown = dependencies.find((dependency) => !known.has(dependency));
    if (unknown) throw new Error(`kernel cursor dependency ${unknown} is unavailable`);
    return {
      scope_key: scopeKey,
      attempt_id: candidate.id,
      scope: candidate.scope,
      depends_on: dependencies,
    };
  }).sort((left, right) => left.scope_key.localeCompare(right.scope_key));

  const dependenciesByKey = new Map(frontier.map((member) => [member.scope_key, member.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("kernel cursor dependencies contain a cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependenciesByKey.get(key) ?? []) {
      if (dependenciesByKey.has(dependency)) visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of memberKeys) visit(key);

  return {
    stage_id: input.stage_id,
    version: input.version,
    reentries: sortedRecord(input.reentries ?? {}),
    frontier,
    completed_scope_keys: completed,
    barrier: { kind: "all", member_scope_keys: sortedUnique(memberKeys) },
  };
}

function attemptOrder(left: KernelAttempt, right: KernelAttempt): number {
  return attemptScopeKey(left.scope).localeCompare(attemptScopeKey(right.scope)) ||
    left.id.localeCompare(right.id);
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

function assertCheckpointIdentity(checkpoint: AttemptCheckpoint, attempt: KernelAttempt): void {
  if (
    checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject
  ) {
    throw new Error(`checkpoint ${checkpoint.id} does not match the complete attempt identity`);
  }
  if (
    attempt.native_session_id !== null &&
    checkpoint.native_session_id !== attempt.native_session_id
  ) {
    throw new Error(`checkpoint ${checkpoint.id} changes the pinned native session`);
  }
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
    attempt.result_correction_count !== 0
  ) {
    throw new Error(`new attempt ${attempt.id} is not a pristine pending attempt`);
  }
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
  const expectedAttempts = sortedRecord(input.run.active_attempt_versions);
  return bundle(baseContent({
    command: input.command,
    expected: expectedFor(input.run, expectedAttempts),
    run: terminalRun(input.run, outcome),
    attemptWrites: terminalAttemptWrites(input.run, current, outcome),
    appendRecords: [authorization.decision],
    cancelEffectIds: Object.keys(input.run.active_effect_versions),
  }));
}

function lease(input: ReducerInput): AtomicTransitionBundle {
  const command = input.command;
  if (command.type !== "lease") throw new Error("unreachable lease command");
  assertAttemptCommandMapsEmpty(input);
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "pending" && attempt.status !== "result_pending") {
    throw new Error(`attempt ${attempt.id} cannot be leased from ${attempt.status}`);
  }
  if (attempt.lease) throw new Error(`attempt ${attempt.id} already has a lease`);
  const purpose = attempt.status === "result_pending" ? "result_correction" : "work";
  if (
    purpose === "result_correction" &&
    attempt.result_correction_count >= input.run.result_correction_limit
  ) {
    throw new Error(`attempt ${attempt.id} exhausted result correction`);
  }
  if (purpose === "result_correction" && attempt.native_session_id === null) {
    throw new Error(`attempt ${attempt.id} cannot correct a result without its native session`);
  }
  if (!command.lease_id || !command.expires_at) throw new Error("attempt lease identity and expiry are required");
  const next: KernelAttempt = {
    ...attempt,
    version: attempt.version + 1,
    result_correction_count: attempt.result_correction_count + (purpose === "result_correction" ? 1 : 0),
    lease: { id: command.lease_id, purpose, expires_at: command.expires_at, started: false },
  };
  return bundle(baseContent({
    command,
    expected: expectedFor(input.run, { [attempt.id]: attempt.version }),
    run: replaceAttempt(input.run, next),
    attemptWrites: [{ kind: "replace", attempt: next }],
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
  assertExactMap(input.records, [], "record map");
  const attempt = currentAttempt(input, command.attempt_id);
  if (attempt.status !== "running" || attempt.lease?.purpose !== "work" || !attempt.lease.started) {
    throw new Error(`attempt ${attempt.id} has not completed a started work lease`);
  }
  const checkpoint = exactCheckpoint(input, command.checkpoint_id);
  assertCheckpointIdentity(checkpoint, attempt);
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
  };
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
    left.path.localeCompare(right.path) || left.detail.localeCompare(right.detail));
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
  assertCheckpointIdentity(checkpoint, attempt);
  if (command.candidate_hash !== null && !DIGEST.test(command.candidate_hash)) {
    throw new Error("result_pending candidate hash is invalid");
  }
  const next: KernelAttempt = {
    ...attempt,
    status: "result_pending",
    version: attempt.version + 1,
    lease: null,
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
  const checkpoint = exactCheckpoint(input, attempt.checkpoint_id);
  assertCheckpointIdentity(checkpoint, attempt);
  const result = recordForAttempt(input, attempt, command.record_id);
  if (attempt.repository_authority === "edit" && result.output_subject === null) {
    throw new Error("edit ResultRecord must retain its verified output subject");
  }
  if (attempt.repository_authority === "inspect" && result.output_subject !== null) {
    throw new Error("inspect ResultRecord cannot advance the repository subject");
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
    appendRecords: [result],
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
    return {
      terminal: transition.on_exhausted === "needs_human" ? "needs_human" : "failed",
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
  assertExactMap(input.checkpoints, [], "checkpoint map");
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
  };
  const remainingAttempts = { ...input.run.active_attempt_versions };
  delete remainingAttempts[attempt.id];

  if (!barrierComplete) {
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

  const acceptedSubject = attempt.repository_authority === "edit" && attempt.scope.kind === "stage"
    ? attempt.output_subject
    : input.run.current_subject;
  if (acceptedSubject === null) throw new Error("accepted edit settlement has no verified output subject");
  const runAtAcceptedSubject: KernelRun = { ...input.run, current_subject: acceptedSubject };
  const transition = effectiveTransition({ run: runAtAcceptedSubject, stage, outcome: command.outcome });
  if (transition.terminal !== undefined) {
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
  } else {
    if (!transition.to) throw new Error("pipeline transition is missing its destination");
    if (command.next_attempts.length === 0) {
      throw new Error(`transition to ${transition.to} must schedule at least one attempt`);
    }
    assertUniqueNewAttempts(command.next_attempts, input.run);
    for (const nextAttempt of command.next_attempts) {
      assertPendingAttempt(nextAttempt, {
        manifest: input.manifest,
        run: runAtAcceptedSubject,
        expectedStageId: transition.to,
        expectedInputSubject: acceptedSubject,
      });
    }
  }

  const effects = (command.effect_intents ?? []).map((intent) =>
    authorizeEffectIntent(intent, authorization.decision, input.run.id),
  ).sort((left, right) => left.id.localeCompare(right.id));
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
    case "lease":
      return lease(input);
    case "start":
      return start(input);
    case "work_complete":
      return workComplete(input);
    case "result_pending":
      return resultPending(input);
    case "record":
      return record(input);
    case "settle":
      return settle(input);
    case "retry":
      return retry(input);
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
