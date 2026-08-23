import {
  compareCodeUnits,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
} from "@openthrottle/contracts";
import {
  canonicalAttemptContextIds,
  type AttemptScope,
  type KernelAttempt,
  type KernelCursor,
  type KernelFrontierMember,
  type KernelRun,
  type ReducerInput,
} from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const TERMINAL_ATTEMPT_STATES = new Set([
  "settled", "needs_human", "failed", "canceled", "superseded",
]);
const TERMINAL_RUN_STATES = new Set([
  "completed", "no_change", "needs_human", "failed", "canceled", "superseded",
]);

export function sortedRecord<T>(input: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function assertExactMap(
  map: ReadonlyMap<string, unknown>,
  expectedIds: readonly string[],
  name: string,
): void {
  const actual = [...map.keys()].sort(compareCodeUnits);
  const expected = sortedUnique(expectedIds);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${expected.join(", ") || "(none)"}`);
  }
}

export function stageFor(
  manifest: CompiledPipelineManifest,
  stageId: string,
): CompiledPipelineStage {
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`compiled manifest does not contain stage ${stageId}`);
  return stage;
}

export function authorityForStage(stage: CompiledPipelineStage): "inspect" | "edit" {
  return stage.kind === "agent" ? stage.repository_authority : "inspect";
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
  canonicalAttemptContextIds(attempt.context_record_ids, `attempt ${attempt.id} context_record_ids`);
  canonicalAttemptContextIds(
    attempt.context_checkpoint_ids,
    `attempt ${attempt.id} context_checkpoint_ids`,
  );
}

function assertCursorTopology(run: KernelRun, current: KernelAttempt | null): void {
  const cursor = run.cursor;
  if (!cursor.barrier || cursor.barrier.kind !== "all") {
    throw new Error("active kernel cursor requires an all-member barrier");
  }
  const frontierKeys = cursor.frontier.map((member) => member.scope_key);
  if (JSON.stringify(frontierKeys) !== JSON.stringify([...frontierKeys].sort())) {
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
    ) throw new Error(`kernel cursor frontier member ${member.attempt_id} is not canonical`);
    for (const dependency of member.depends_on) {
      if (!frontierKeys.includes(dependency) && !cursor.completed_scope_keys.includes(dependency)) {
        throw new Error(`kernel cursor dependency ${dependency} is unavailable`);
      }
    }
    if (JSON.stringify(member.depends_on) !== JSON.stringify(sortedUnique(member.depends_on))) {
      throw new Error(`kernel cursor member ${member.attempt_id} dependencies are not canonical`);
    }
  }
  if (JSON.stringify(cursor.completed_scope_keys) !== JSON.stringify(sortedUnique(cursor.completed_scope_keys))) {
    throw new Error("kernel cursor completed scope keys are not canonical");
  }
  if (JSON.stringify(sortedUnique(cursor.barrier.member_scope_keys)) !== JSON.stringify(sortedUnique(frontierKeys))) {
    throw new Error("kernel cursor barrier does not match its frontier");
  }
  const unsettledAttemptIds = cursor.frontier
    .filter((member) => !cursor.completed_scope_keys.includes(member.scope_key))
    .map((member) => member.attempt_id)
    .sort(compareCodeUnits);
  const activeAttemptIds = Object.keys(run.active_attempt_versions).sort(compareCodeUnits);
  if (JSON.stringify(unsettledAttemptIds) !== JSON.stringify(activeAttemptIds)) {
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

export function assertBaseInput(input: ReducerInput): void {
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
  if (TERMINAL_RUN_STATES.has(run.status)) throw new Error(`pipeline run ${run.id} is already terminal`);
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
    assertActiveAttempt(run, input.current_attempt);
    if (input.current_attempt.repository_authority !== authorityForStage(activeStage)) {
      throw new Error(`attempt ${input.current_attempt.id} does not use the stage repository authority`);
    }
    const scopedSubject = input.current_attempt.scope.kind !== "stage" &&
      activeStage.kind !== "effect" && activeStage.kind !== "wait";
    const promotedPublication = activeStage.kind === "effect" &&
      activeStage.effect === "core/publish@1" &&
      input.current_attempt.output_subject !== null &&
      input.current_attempt.output_subject === run.current_subject;
    if (
      !scopedSubject && !promotedPublication &&
      input.current_attempt.input_subject !== run.current_subject
    ) {
      throw new Error(`attempt ${input.current_attempt.id} does not use the current run subject`);
    }
  }
}

export function currentAttempt(input: ReducerInput, attemptId: string): KernelAttempt {
  const attempt = input.current_attempt;
  if (!attempt || attempt.id !== attemptId) {
    throw new Error(`command targets attempt ${attemptId} without its exact current aggregate`);
  }
  return attempt;
}

export function assertAttemptCommandMapsEmpty(input: ReducerInput): void {
  assertExactMap(input.records, [], "record map");
  assertExactMap(input.checkpoints, [], "checkpoint map");
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
  }).sort((left, right) => compareCodeUnits(left.scope_key, right.scope_key));

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
