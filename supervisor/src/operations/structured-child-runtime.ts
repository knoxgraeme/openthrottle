import {
  canonicalJson,
  digestNormalized,
  EXECUTION_PLAN_SCHEMA,
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_PLAN_SCHEMAS,
  digestCanonicalJson,
  parseAnyExecutionPlanContract,
  parseStandardReceipt,
  RECEIPT_SCHEMA,
  validateTuneDecisionContract,
  validateTuneEditAuthorizationContract,
  validateTuneProposalContract,
  type RepositoryConfigContract,
  type AnyExecutionPlanContract,
  type CandidateEvidenceReceipt,
  type CommandResultReceipt,
  type IntegrationEvidenceReceipt,
  type SemanticReviewReceipt,
  type StandardReceiptType,
  type StandardReceipt,
  type UnitCompletionReceipt,
  type UnitDecisionReceipt,
} from "@openthrottle/contracts";
import {
  stageById,
  type PipelineUnitPhaseBinding,
  type StageOutcome,
  unitPhaseBindingIds,
} from "../pipeline/manifest.js";
import { FOR_EACH_UNIT_CAPABILITY } from "../pipeline/capability-contracts.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "../pipeline/coordinator.js";
import {
  buildAggregateStageEvent,
  FINAL_REPAIR_MAX_ROUNDS,
  repairCyclePhaseSequence,
  type ExecutionUnitState,
  type UnitActionKind,
} from "../pipeline/unit-coordinator.js";
import {
  loopActionPlanContext,
  loopActionTransitionContext,
} from "../pipeline/structured-loop-envelope.js";
import {
  assertCandidateEvidenceFence,
  assertStandardReceiptFence,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type ExpectedReceiptProducer,
  type ReceiptProducerRole,
  type StandardReceiptFence,
} from "../pipeline/execution-gates.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type {
  ExecutionGateReceipt,
  ExecutionUnitGraph,
  ExecutionUnitStore,
  ExecutionWorkAttempt,
  ExecutionWorkPrivateArtifact,
  ExecutionCheckpointObject,
} from "../persistence/pipeline/unit-store.js";
import type {
  ChildExecutorActionRequest,
  LoopActionRequest,
  LoopActionResult,
  RuntimeResource,
  SandboxRuntime,
} from "../runtime/contracts.js";
import { serializeRuntimeObservationError } from "../runtime/observation-error.js";
import { extractJsonBlocksAny } from "../pipeline/markdown.js";
import { sanitizeText } from "../shared/sanitize.js";
import {
  actionResultHash,
  assertLoopRequestEnvelopeBound,
  buildLoopActionRequest,
  builtinProducer,
  DIAGNOSTIC_TEXT_HEAD_CHARS,
  privateArtifactForLoopResult,
  terminalPayloadForLoopResult,
} from "./structured-child-primitives.js";
import {
  commandAttemptReceipts,
  createPriorEvidenceAssembler,
  unitCompletionAttemptReceipt,
} from "./prior-evidence.js";
import {
  completedAttemptReceiptsFrom,
  createSubjectDerivation,
  finalRepairWorktreeHandleFor,
  GIT_SUBJECT,
  latestAttemptReceipt,
  sha1SubjectForGitOperation,
  verifiedAggregateTreeSubject,
  worktreeHandleFor,
  worktreeIdempotencyKey,
} from "./subject-derivation.js";
import { createReviewOrchestrator, type ReviewOrchestrator } from "./review-orchestration.js";
import { createUnitEffectProcessor } from "./unit-effects.js";

// Bounds the per-tick child-action walk in drainCompositeChildren so one
// graph with a deep chain of ready results cannot monopolize a drain tick.
const MAX_CHILD_DRAINS_PER_TICK = 64;

type StructuredChildRuntimeDeps = {
  store: PipelineStore & ExecutionUnitStore;
  runtime: SandboxRuntime;
  taskTimeoutSeconds: number;
  reviewFanoutConcurrency?: number;
  now: () => Date;
  completeParentStage?: (event: PipelineCoordinatorEvent) => PipelineInstance;
  // Per-tick bound on the drainCompositeChildren walk. Production always uses
  // the default; harnesses that must pause a run at an exact mid-flight state
  // (sandbox/tests/structured-walking-skeleton.mjs) set 1 to restore
  // one-action-per-drain granularity for their setup phase.
  maxChildDrainsPerTick?: number;
};

type LoopDispatchBinding = {
  kind: "agent" | "gate";
  loop: {
    id: string;
    skill: string;
    input_scope: "unit";
    receipt: string;
    max_parallel: number;
    max_rounds: number;
    timeout_seconds?: number;
  };
  worker: {
    id: string;
    agent?: "inherit" | "claude" | "codex" | "opencode";
    model?: string;
    allowed_mcp_servers: string[];
  };
  credentials: LoopActionRequest["credentialScopes"];
  context: LoopActionRequest["contextPolicy"] | "none";
  repositorySkill?: LoopActionRequest["repositorySkill"];
};

export interface StructuredChildRuntime {
  seedCompositeGraph(instance: PipelineInstance, request: StageRequestEnvelope, initialSubject: string): void;
  drainCompositeChildren(resource: RuntimeResource, instance: PipelineInstance, parentAttemptId: string): Promise<void>;
  compositeGraphNeedsDrain(parentAttemptId: string): boolean;
}

function terminalAttemptOutcomeFor(
  attempts: readonly ExecutionWorkAttempt[]
): "failure" | "needs_human" | "retryable_infrastructure_failure" | undefined {
  // failUnitAction persists both semantic failure and needs_human rows with
  // status='failed'. The exact terminal result is therefore authoritative;
  // preservation must win over every non-preserving cleanup outcome whenever
  // any action has recoverable work that requires a human.
  if (attempts.some((attempt) => attempt.terminal_result_outcome === "needs_human")) {
    return "needs_human";
  }
  // In the absence of preservation-required work, retain retryable provider /
  // runtime semantics ahead of ordinary semantic failure.
  if (attempts.some((attempt) => attempt.terminal_result_outcome === "retryable_infrastructure_failure")) {
    return "retryable_infrastructure_failure";
  }
  if (attempts.some((attempt) => attempt.terminal_result_outcome === "failure")) {
    return "failure";
  }
  return undefined;
}

export function aggregateOutcomeFor(
  units: readonly ExecutionUnitState[],
  gates: readonly ExecutionGateReceipt[] = [],
  attempts: readonly ExecutionWorkAttempt[] = []
): StageOutcome | undefined {
  if (units.length === 0 || units.some((unit) => unit.terminalLevel === null)) return undefined;
  const acceptedIntegrationSubjects = new Map<string, Set<string>>();
  for (const gate of gates) {
    if (
      gate.gate_kind !== "integration" ||
      gate.outcome !== "success" ||
      gate.result !== "passed" ||
      gate.unit_id === null ||
      gate.subject === null
    ) continue;
    const subjects = acceptedIntegrationSubjects.get(gate.unit_id) ?? new Set<string>();
    subjects.add(gate.subject);
    acceptedIntegrationSubjects.set(gate.unit_id, subjects);
  }
  const terminalAttemptOutcome = terminalAttemptOutcomeFor(attempts);
  if (terminalAttemptOutcome) return terminalAttemptOutcome;
  const allAcceptedIntegrated = units.every((unit) =>
    unit.terminalLevel === "completed" &&
    unit.integrationSubject !== null &&
    acceptedIntegrationSubjects.get(unit.unitId)?.has(unit.integrationSubject) === true
  );
  if (allAcceptedIntegrated) {
    return "success";
  }
  return units.some((unit) => unit.terminalLevel === "failed" || unit.alarm) ? "failure" : "needs_human";
}

function stoppedAggregateOutcome(
  stopOutcome: ExecutionUnitGraph["stop_outcome"],
  attempts: readonly ExecutionWorkAttempt[]
): StageOutcome {
  const terminalAttemptOutcome = terminalAttemptOutcomeFor(attempts);
  if (terminalAttemptOutcome === "needs_human") return "needs_human";
  // The typed stop_outcome is the only stop-side authority; stop_reason is
  // sanitized agent text and must never select the outcome. Graphs stopped
  // before the typed column existed (NULL) take the conservative
  // non-retryable path below.
  if (terminalAttemptOutcome === "retryable_infrastructure_failure" ||
      stopOutcome === "retryable_infrastructure_failure") {
    return "retryable_infrastructure_failure";
  }
  if (terminalAttemptOutcome === "failure" || stopOutcome === "failure" ||
      attempts.some((attempt) => attempt.status === "failed")) {
    return "failure";
  }
  return "needs_human";
}

function builtinLoopBinding(input: {
  kind: LoopDispatchBinding["kind"];
  workerId: string;
  skill: string;
  credentials: LoopActionRequest["credentialScopes"];
  context?: LoopDispatchBinding["context"];
  maxRounds?: number;
}): LoopDispatchBinding {
  return Object.freeze({
    kind: input.kind,
    worker: {
      id: input.workerId,
      agent: "inherit" as const,
      allowed_mcp_servers: [],
    },
    loop: {
      id: input.skill,
      skill: input.skill,
      input_scope: "unit" as const,
      receipt: input.kind === "gate" ? "unit_decision" : "unit_completion",
      max_parallel: 1,
      max_rounds: input.maxRounds ?? 1,
    },
    credentials: input.credentials,
    context: input.context ?? "fresh",
    repositorySkill: undefined,
  });
}

const FINAL_REVIEW_BINDING = builtinLoopBinding({
  kind: "gate",
  workerId: "reviewer",
  skill: "final-review",
  credentials: ["model.invoke", "repo.read"],
});
const FINAL_REPAIR_BINDING = builtinLoopBinding({
  kind: "agent",
  workerId: "final-repair",
  skill: "final-repair",
  credentials: ["model.invoke", "repo.read"],
  context: "resume_required",
  maxRounds: FINAL_REPAIR_MAX_ROUNDS,
});

function extractExecutionPlan(context: string): AnyExecutionPlanContract {
  const blocks = extractJsonBlocksAny(context, EXECUTION_PLAN_SCHEMAS);
  if (blocks.length !== 1) {
    throw new Error(`structured composite stage requires exactly one execution-plan block, found ${blocks.length}`);
  }
  return parseAnyExecutionPlanContract(blocks[0]!, { source: "sealed.execution_plan" }).value;
}

function configuredCommandNamesFor(instance: PipelineInstance, store: PipelineStore): Set<string> {
  const snapshot = store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
  if (!snapshot || snapshot.digest !== instance.repository_config_digest) {
    throw new Error(`pipeline instance ${instance.id} lost its sealed repository config`);
  }
  const config = JSON.parse(snapshot.normalized_config) as { commands?: Record<string, unknown> };
  return new Set(Object.keys(config.commands ?? {}));
}

function agentExecutionDefaultsFor(
  instance: PipelineInstance,
  store: PipelineStore,
  agent: LoopActionRequest["agent"],
  workerModel?: string,
): { model?: string; reasoningEffort?: LoopActionRequest["reasoningEffort"] } {
  if (!instance.repository_config_snapshot_id || !instance.repository_config_digest) {
    return workerModel === undefined ? {} : { model: workerModel };
  }
  const snapshot = store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
  if (!snapshot || snapshot.digest !== instance.repository_config_digest) {
    throw new Error(`pipeline instance ${instance.id} lost its sealed repository config`);
  }
  const config = JSON.parse(snapshot.normalized_config) as RepositoryConfigContract;
  const defaults = config.agent_defaults?.[agent];
  const legacyModel = config.agent === agent ? config.model : undefined;
  const effectiveModel = workerModel ?? defaults?.model ?? legacyModel;
  return {
    ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
    ...(defaults?.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: defaults.reasoning_effort }),
  };
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function authoredUnitRepairMaxRounds(bindings: readonly PipelineUnitPhaseBinding[] | undefined): number | undefined {
  if (!bindings) return undefined;
  const repeatedPhases = new Set(repairCyclePhaseSequence(unitPhaseBindingIds(bindings)));
  const repeatedLoopRounds = bindings.flatMap((binding) =>
    repeatedPhases.has(binding.id) && (binding.kind === "agent" || binding.kind === "gate")
      ? [binding.loop.max_rounds]
      : []
  );
  return repeatedLoopRounds.length > 0 ? Math.min(...repeatedLoopRounds) : undefined;
}

function commandPlanForUnits(input: {
  plan: AnyExecutionPlanContract;
  fallbackCommandNames: readonly string[];
  configuredCommandNames: ReadonlySet<string>;
}): {
  graphCommandNames: string[];
  units: Array<{ id: string; dependencies: readonly string[]; commandNames: string[] }>;
} {
  const planCommandNames = uniqueInOrder(input.plan.commands.map((command) => command.name));
  const graphCommandNames = planCommandNames.length > 0
    ? planCommandNames
    : [...input.fallbackCommandNames];
  for (const commandName of graphCommandNames) {
    if (!input.configuredCommandNames.has(commandName)) {
      throw new Error(`execution plan command ${commandName} is not configured in the sealed repository config`);
    }
  }
  const commandNamesByUnit = new Map(input.plan.units.map((unit) => [unit.id, [] as string[]]));
  for (const command of input.plan.commands) {
    if (command.unit === undefined) {
      for (const unitCommandNames of commandNamesByUnit.values()) unitCommandNames.push(command.name);
    } else {
      commandNamesByUnit.get(command.unit)?.push(command.name);
    }
  }
  return {
    graphCommandNames,
    units: input.plan.units.map((unit) => ({
      id: unit.id,
      dependencies: unit.depends_on,
      commandNames: input.plan.commands.length > 0
        ? uniqueInOrder(commandNamesByUnit.get(unit.id) ?? [])
        : [...input.fallbackCommandNames],
    })),
  };
}

function buildChildExecutorActionRequest(
  request: Omit<ChildExecutorActionRequest, "requestHash" | "idempotencyKey">
): ChildExecutorActionRequest {
  const requestHash = digestCanonicalJson(request);
  return {
    ...request,
    requestHash,
    idempotencyKey: `child-executor:${request.attemptId}:${request.actionId}:${requestHash}`,
  };
}

function isChildExecutorActionKind(actionKind: UnitActionKind): actionKind is ChildExecutorActionRequest["actionKind"] {
  return actionKind === "command" ||
    actionKind === "final_command" ||
    actionKind === "candidate" ||
    actionKind === "integrate";
}

function adapterSkillFor(actionKind: UnitActionKind): LoopActionRequest["skill"] {
  if (actionKind === "implement") return "implement-unit";
  if (actionKind === "repair") return "repair-unit";
  if (actionKind === "simplify") return "simplify-unit";
  if (actionKind === "lead") return "accept-unit";
  if (actionKind === "final_review") return "final-review";
  if (actionKind === "final_repair") return "final-repair";
  throw new Error(`child action kind ${actionKind} is executor-owned and cannot dispatch as a loop agent`);
}

function expectedSkillFor(binding: LoopDispatchBinding): string {
  if (binding.repositorySkill) return binding.repositorySkill.reference;
  if (binding.loop.skill.startsWith("builtin://")) return binding.loop.skill;
  return `builtin://${binding.loop.skill}@1`;
}

function loopKindFor(actionKind: UnitActionKind): LoopActionRequest["loop"] {
  if (actionKind === "repair" || actionKind === "final_repair") return "repair";
  if (actionKind === "final_review") return "review";
  if (actionKind === "lead") return "lead";
  if (actionKind === "implement" || actionKind === "simplify" || actionKind === "command") return actionKind;
  throw new Error(`child action kind ${actionKind} has no loop kind`);
}

function expectedReceiptTypeFor(actionKind: UnitActionKind): StandardReceiptType {
  if (actionKind === "lead") return "unit_decision";
  if (actionKind === "final_review") return "semantic_review";
  if (["implement", "repair", "simplify", "final_repair"].includes(actionKind)) return "unit_completion";
  throw new Error(`child action kind ${actionKind} has no agent receipt type`);
}

function receiptRoleFor(actionKind: UnitActionKind): ReceiptProducerRole {
  if (actionKind === "command" || actionKind === "final_command") return "command";
  if (actionKind === "candidate") return "candidate";
  if (actionKind === "lead") return "lead";
  if (actionKind === "integrate") return "integration";
  if (actionKind === "final_review") return "review";
  return "completion";
}

function roleFor(actionKind: UnitActionKind): LoopActionRequest["role"] {
  if (actionKind === "lead") return "lead";
  if (actionKind === "final_review") return "reviewer";
  return "worker";
}

function requestContextForStructuredPlan(payload: {
  taskContext?: unknown;
  inputArtifacts?: unknown;
}): string {
  if (Array.isArray(payload.inputArtifacts)) {
    for (const entry of payload.inputArtifacts) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const artifact = entry as { payload?: unknown; hash?: unknown };
      if (typeof artifact.payload !== "string") continue;
      if (typeof artifact.hash === "string" && digestNormalized(artifact.payload) !== artifact.hash) {
        throw new Error("structured execution-plan input artifact hash mismatch");
      }
      try {
        const parsed = JSON.parse(artifact.payload) as {
          schema?: unknown;
          execution_plan?: unknown;
          details?: { execution_plan?: unknown };
        };
        const executionPlan = parsed.schema === EXECUTION_PLAN_SCHEMA_V2
          ? parsed.execution_plan
          : parsed.details?.execution_plan;
        if (executionPlan !== undefined) {
          const schema = executionPlan && typeof executionPlan === "object" && !Array.isArray(executionPlan) &&
            typeof (executionPlan as { schema?: unknown }).schema === "string"
            ? (executionPlan as { schema: string }).schema
            : EXECUTION_PLAN_SCHEMA;
          return `\`\`\`json ${schema}\n${JSON.stringify(executionPlan)}\n\`\`\``;
        }
      } catch {
        // The stage gate validates artifact JSON. Ignore unrelated artifacts.
      }
    }
  }
  return typeof payload.taskContext === "string" ? payload.taskContext : "";
}

function parentTaskContextFor(store: PipelineStore, parentAttemptId: string): string {
  if (typeof (store as { getAttempt?: unknown }).getAttempt !== "function") return "";
  const attempt = store.getAttempt(parentAttemptId);
  if (!attempt?.request_payload) return "";
  const payload = JSON.parse(attempt.request_payload) as { taskContext?: unknown; inputArtifacts?: unknown };
  return requestContextForStructuredPlan(payload);
}

function tuneAuthorizationForParent(
  store: PipelineStore,
  parentAttemptId: string,
  baseSubject: string,
  now: Date
): ChildExecutorActionRequest["tuneAuthorization"] {
  const attempt = store.getAttempt(parentAttemptId);
  if (!attempt?.request_payload) throw new Error(`tune parent attempt ${parentAttemptId} has no sealed request`);
  const request = JSON.parse(attempt.request_payload) as {
    taskType?: unknown;
    inputArtifacts?: Array<{ kind?: unknown; payload?: unknown; hash?: unknown }>;
  };
  if (request.taskType !== "tune") return undefined;
  const artifact = request.inputArtifacts?.find((entry) => entry.kind === "stage_result");
  if (!artifact || typeof artifact.payload !== "string" || typeof artifact.hash !== "string" ||
      digestNormalized(artifact.payload) !== artifact.hash) {
    throw new Error("tune structured edit is missing its sealed supervisor authorization");
  }
  const wrapper = JSON.parse(artifact.payload) as {
    details?: { proposal?: unknown; decision?: unknown; edit_authorization?: unknown };
  };
  const proposal = validateTuneProposalContract(wrapper.details?.proposal, {
    source: "structured_edit.proposal",
  });
  const decision = validateTuneDecisionContract(wrapper.details?.decision, {
    source: "structured_edit.decision",
    proposal: proposal.value,
  });
  const authorization = validateTuneEditAuthorizationContract(wrapper.details?.edit_authorization, {
    source: "structured_edit.authorization",
    proposal: proposal.value,
    decision: decision.value,
  });
  if (authorization.value.expires_at < now.toISOString()) {
    throw new Error("tune structured edit authorization expired before executor verification");
  }
  return {
    schema: "openthrottle.tune-edit-verification/v1",
    proposalDigest: proposal.digest,
    decisionDigest: decision.digest,
    authorizationDigest: authorization.digest,
    baseSubject: sha1SubjectForGitOperation(baseSubject, "tune verification base subject"),
    expiresAt: authorization.value.expires_at,
    changes: proposal.value.changes,
  };
}

export function createStructuredChildRuntime(deps: StructuredChildRuntimeDeps): StructuredChildRuntime {
  const completeParentStage = deps.completeParentStage ?? ((event: PipelineCoordinatorEvent) =>
    coordinatePipelineEvent(deps.store, event));

  const actionBinding = (instance: PipelineInstance, action: ExecutionWorkAttempt): LoopDispatchBinding | undefined => {
    if (action.action_kind === "final_review") return FINAL_REVIEW_BINDING;
    if (action.action_kind === "final_repair") return FINAL_REPAIR_BINDING;
    const stage = stageById(instance.normalized_manifest, instance.active_stage_id);
    if (!stage?.unitPhaseBindings) throw new Error(`child action ${action.id} has no graph-declared phase bindings`);
    const phaseId = action.action_kind === "repair" ? "implement"
      : action.action_kind === "final_command"
        ? undefined
        : action.action_kind;
    const binding = phaseId ? stage.unitPhaseBindings.find((binding) => binding.id === phaseId) : undefined;
    return binding && (binding.kind === "agent" || binding.kind === "gate")
      ? { ...binding, credentials: binding.credentials as LoopActionRequest["credentialScopes"] }
      : undefined;
  };

  const agentProducerFor = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    role: ReceiptProducerRole
  ): ExpectedReceiptProducer => {
    const binding = actionBinding(instance, action);
    if (!binding || (binding.kind !== "agent" && binding.kind !== "gate")) {
      if (role === "review") {
        return {
          workerId: "reviewer",
          skill: "builtin://final-review@1",
          capabilityDigest: instance.capability_digest,
          skillPackageDigest: null,
          assurance: "semantic_attested",
        };
      }
      throw new Error(`child action ${action.id} has no ${role} producer binding`);
    }
    return {
      workerId: binding.worker.id,
      skill: expectedSkillFor(binding),
      capabilityDigest: instance.capability_digest,
      skillPackageDigest: binding.repositorySkill?.packageDigest ?? null,
      assurance: "semantic_attested",
    };
  };

  const expectedProducersFor = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Record<ReceiptProducerRole, ExpectedReceiptProducer> => {
    const completionProbe = action.action_kind === "simplify" || action.action_kind === "final_repair"
      ? action
      : { ...action, action_kind: action.cycle > 1 ? "repair" as const : "implement" as const };
    const leadProbe = { ...action, action_kind: "lead" as const };
    return {
      completion: agentProducerFor(instance, completionProbe, "completion"),
      candidate: builtinProducer("candidate_evidence", instance.capability_digest),
      command: builtinProducer("command_result", instance.capability_digest),
      lead: agentProducerFor(instance, leadProbe, "lead"),
      integration: builtinProducer("integration_evidence", instance.capability_digest),
      review: agentProducerFor(instance, { ...action, action_kind: "final_review" as const }, "review"),
    };
  };

  const expectedProducerForAction = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): ExpectedReceiptProducer => {
    const role = receiptRoleFor(action.action_kind);
    if (role === "candidate") return builtinProducer("candidate_evidence", instance.capability_digest);
    if (role === "command") return builtinProducer("command_result", instance.capability_digest);
    if (role === "integration") return builtinProducer("integration_evidence", instance.capability_digest);
    return agentProducerFor(instance, action, role);
  };

  // Owns every subject/worktree derivation this runtime dispatches against
  // (worktree base, action input subject, worktree handles, the rejected
  // candidate a repair rebuilds from), over the same sealed store and the
  // producer projection above.
  const {
    worktreeBaseFor,
    actionInputSubjectFor,
    receiptBaseFor,
    completedAttemptReceiptsFor,
    repairRejectedCandidateAttemptReceipt,
    assertPreparedUnitWorktreeRequestBound,
  } = createSubjectDerivation({
    store: deps.store,
    expectedProducerForAction,
  });

  const standardFenceFor = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    subject: string
  ): StandardReceiptFence => {
    const receiptNativeSessionId = action.receipt
      ? parseStandardReceipt(action.receipt, { source: `child_action.${action.id}.receipt` }).value.fence.native_session_id
      : action.native_session_id;
    return {
      pipelineInstanceId: instance.id,
      graphDigest: instance.manifest_digest,
      unitId: action.unit_id ?? "__final__",
      attemptId: action.parent_attempt_id,
      parentRunId: action.parent_run_id,
      actionAttemptId: action.id,
      generation: instance.generation,
      nativeSessionId: receiptNativeSessionId,
      requestHash: action.request_hash ?? "",
      baseSubject: receiptBaseFor(instance, action),
      preSubject: actionInputSubjectFor(instance, action),
      subject,
      producers: expectedProducersFor(instance, action),
    };
  };

  // Owns the sealed prior-evidence envelope every lead/repair/final action
  // carries, over the receipt selectors it shares with this runtime.
  const { priorEvidenceForAction } = createPriorEvidenceAssembler({
    latestAttemptReceipt,
    repairRejectedCandidateAttemptReceipt,
    actionInputSubjectFor,
  });

  // Owns every review subaction (selector, persona fanout, blocker validator)
  // behind the same sealed store and runtime this runtime already holds.
  const reviewOrchestrator: ReviewOrchestrator = createReviewOrchestrator({
    store: deps.store,
    runtime: deps.runtime,
    now: deps.now,
    executionPlanFor: (action) => extractExecutionPlan(parentTaskContextFor(deps.store, action.parent_attempt_id)),
    actionInputSubjectFor,
    expectedProducersFor,
    standardFenceFor,
    commandAttemptReceiptsFor: (action) =>
      commandAttemptReceipts(completedAttemptReceiptsFor(action.parent_attempt_id), null, action.cycle),
    maxParallel: deps.reviewFanoutConcurrency ?? 1,
  });

  const dispatchChildAction = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Promise<{ requestHash: string; nativeSessionId?: string | null }> => {
    if (isChildExecutorActionKind(action.action_kind)) {
      if (action.request_payload && action.request_hash) {
        const replayRequest = JSON.parse(action.request_payload) as ChildExecutorActionRequest;
        assertPreparedUnitWorktreeRequestBound(replayRequest, instance, action);
        await deps.runtime.dispatchChildExecutorAction(resource, replayRequest);
        return { requestHash: replayRequest.requestHash, nativeSessionId: null };
      }
      const baseSubject = sha1SubjectForGitOperation(worktreeBaseFor(instance, action), "child action base subject");
      const candidateSubject = action.action_kind === "integrate"
        ? action.unit_id === null
          ? latestAttemptReceipt<CandidateEvidenceReceipt>(
            completedAttemptReceiptsFor(action.parent_attempt_id),
            "candidate_evidence",
            null,
            action.cycle
          ).receipt.subject.post
          : deps.store.listUnits(action.parent_attempt_id).find((unit) => unit.unitId === action.unit_id)?.acceptedCandidateSubject ?? undefined
        : undefined;
      if (action.action_kind === "integrate" && !candidateSubject) {
        throw new Error(`child integration action ${action.id} has no accepted candidate subject`);
      }
      const integrationCandidateSubject = candidateSubject
        ? sha1SubjectForGitOperation(candidateSubject, "child integration candidate subject")
        : undefined;
      const tuneAuthorization = action.action_kind === "candidate" || action.action_kind === "integrate"
        ? tuneAuthorizationForParent(deps.store, action.parent_attempt_id, instance.base_commit, deps.now())
        : undefined;
      const request = buildChildExecutorActionRequest({
        protocol: "child-executor-action@1",
        actionId: action.id,
        attemptId: action.parent_attempt_id,
        graphId: action.execution_graph_id,
        pipelineInstanceId: instance.id,
        graphDigest: instance.manifest_digest,
        parentRunId: action.parent_run_id,
        generation: instance.generation,
        capabilityDigest: instance.capability_digest,
        unitId: action.unit_id,
        actionKind: action.action_kind,
        ...(action.command_name ? { commandName: action.command_name } : {}),
        ...(action.unit_id && (action.action_kind === "command" || action.action_kind === "candidate")
          ? { worktree: worktreeHandleFor(action, baseSubject) }
          : action.unit_id === null && action.action_kind === "candidate"
            ? { worktree: finalRepairWorktreeHandleFor(action, baseSubject, deps.store.listWorkAttempts(action.parent_attempt_id)) }
            : {}),
        baseSubject,
        inputSubject: actionInputSubjectFor(instance, action),
        ...(integrationCandidateSubject ? { candidateSubject: integrationCandidateSubject } : {}),
        ...(tuneAuthorization ? { tuneAuthorization } : {}),
      });
      deps.store.prepareActionDispatch?.({
        actionId: action.id,
        requestHash: request.requestHash,
        requestPayload: canonicalJson(request),
        nativeSessionId: null,
      });
      await deps.runtime.dispatchChildExecutorAction(resource, request);
      return { requestHash: request.requestHash, nativeSessionId: null };
    }
    if (action.request_payload && action.request_hash) {
      const replayRequest = JSON.parse(action.request_payload) as LoopActionRequest;
      if (action.action_kind === "final_review" && replayRequest.skill === "select-review-personas") {
        await reviewOrchestrator.ensureReviewSubactionLaunched({
          resource,
          action,
          request: replayRequest,
          label: "review selector action",
        });
        return { requestHash: replayRequest.requestHash, nativeSessionId: null };
      }
      if (action.action_kind === "repair") {
        assertPreparedUnitWorktreeRequestBound(replayRequest, instance, action);
        const rejectedCandidateSubject = sha1SubjectForGitOperation(
          worktreeBaseFor(instance, action),
          "child action base subject"
        );
        if (
          replayRequest.baseSubject !== rejectedCandidateSubject ||
          replayRequest.inputSubject !== rejectedCandidateSubject ||
          replayRequest.recoveryBaseSubject !== instance.base_commit
        ) {
          throw new Error(`child repair action ${action.id} prepared request is not bound to the rejected candidate`);
        }
      } else {
        assertPreparedUnitWorktreeRequestBound(replayRequest, instance, action);
      }
      const needsWorktree = replayRequest.worktree !== null &&
        (action.request_launch_state === "prepared" || action.request_launch_state == null) &&
        (action.action_kind === "implement" || action.action_kind === "repair" || action.action_kind === "final_repair");
      if (needsWorktree) {
        await deps.runtime.createWorktree(resource, {
          idempotencyKey: worktreeIdempotencyKey(action),
          attemptId: action.parent_attempt_id,
          baseCommit: sha1SubjectForGitOperation(worktreeBaseFor(instance, action), "child action base subject"),
        });
        deps.store.markActionWorktreeReady?.(action.id);
      }
      await deps.runtime.dispatchLoopAction(resource, replayRequest);
      return { requestHash: replayRequest.requestHash, nativeSessionId: replayRequest.nativeSessionId ?? null };
    }
    const binding = actionBinding(instance, action);
    const workerBinding = binding && (binding.kind === "agent" || binding.kind === "gate") ? binding : undefined;
    if (!workerBinding) {
      throw new Error(`child action kind ${action.action_kind} is executor-owned and cannot dispatch as a loop agent`);
    }
    const baseCommit = sha1SubjectForGitOperation(worktreeBaseFor(instance, action), "child action base subject");
    const parentTaskContext = parentTaskContextFor(deps.store, action.parent_attempt_id);
    const executionPlan = parentTaskContext
      ? extractExecutionPlan(parentTaskContext)
      : null;
    const inputSubject = actionInputSubjectFor(instance, action);
    const createNewWorktree = action.action_kind === "implement" ||
      action.action_kind === "repair" ||
      action.action_kind === "final_repair";
    const worktree = roleFor(action.action_kind) === "worker"
      ? worktreeHandleFor(action, baseCommit)
      : null;
    const needsPriorEvidence = action.action_kind === "lead" || action.action_kind === "repair" ||
      action.action_kind === "final_review" || action.action_kind === "final_repair";
    const receipts = needsPriorEvidence
      ? completedAttemptReceiptsFor(action.parent_attempt_id)
      : [];
    const priorEvidence = needsPriorEvidence
        ? priorEvidenceForAction(instance, action, receipts)
      : undefined;
    if (needsPriorEvidence && !priorEvidence) {
      throw new Error(`child action ${action.id} has no sealed prior evidence`);
    }
    const leadCandidateSubject = action.action_kind === "lead"
      ? deps.store.listUnits(action.parent_attempt_id)
        .find((unit) => unit.unitId === action.unit_id)?.acceptedCandidateSubject ??
        latestAttemptReceipt<CandidateEvidenceReceipt>(
          receipts,
          "candidate_evidence",
          action.unit_id,
          action.cycle
        ).receipt.subject.post
      : undefined;
    const downstreamContext = action.unit_id
      ? (typeof deps.store.listDownstreamContext === "function"
          ? deps.store.listDownstreamContext(action.parent_attempt_id, action.unit_id)
          : []
        ).map((record) => ({
          fromUnitId: record.from_unit_id,
          payloadHash: record.payload_hash,
          payload: JSON.parse(record.payload) as Record<string, unknown>,
        }))
      : [];
    const contextPolicy = workerBinding.context === "none"
      ? "fresh"
      : workerBinding.context === "resume_required" && !action.native_session_id
        ? "prefer_resume"
        : workerBinding.context;
    const tuneAuthorization = ["implement", "repair", "simplify", "final_repair"].includes(action.action_kind)
      ? tuneAuthorizationForParent(deps.store, action.parent_attempt_id, instance.base_commit, deps.now())
      : undefined;
    const reviewSubject = action.action_kind === "lead" ? leadCandidateSubject
      : action.action_kind === "final_review" ? inputSubject
        : undefined;
    const effectiveAgent = workerBinding.worker.agent && workerBinding.worker.agent !== "inherit"
      ? workerBinding.worker.agent
      : instance.agent;
    const executionDefaults = agentExecutionDefaultsFor(
      instance,
      deps.store,
      effectiveAgent,
      workerBinding.worker.model,
    );
    if (action.action_kind === "final_review") {
      if (!executionPlan || !reviewSubject) throw new Error(`child final review ${action.id} has no sealed execution plan`);
      return reviewOrchestrator.dispatchFinalReviewSelector({
        resource,
        instance,
        action,
        plan: executionPlan,
        inputSubject: reviewSubject,
        agent: effectiveAgent,
        ...executionDefaults,
        timeoutMs: (workerBinding.loop.timeout_seconds ?? deps.taskTimeoutSeconds) * 1_000,
        ...(priorEvidence ? { priorEvidence } : {}),
      });
    }
    const loopRequest = buildLoopActionRequest({
      protocol: "loop-action@3",
      actionId: action.id,
      attemptId: action.parent_attempt_id,
      graphId: action.execution_graph_id,
      pipelineInstanceId: instance.id,
      graphDigest: instance.manifest_digest,
      parentRunId: action.parent_run_id,
      unitId: action.unit_id,
      generation: instance.generation,
      role: roleFor(action.action_kind),
      loop: loopKindFor(action.action_kind),
      agent: effectiveAgent,
      ...executionDefaults,
      skill: workerBinding.repositorySkill?.invocation ?? adapterSkillFor(action.action_kind),
      worktree,
      baseSubject: baseCommit,
      recoveryBaseSubject: instance.base_commit,
      inputSubject,
      nativeSessionId: action.native_session_id,
      contextPolicy,
      timeoutMs: (workerBinding.loop.timeout_seconds ?? deps.taskTimeoutSeconds) * 1_000,
      transitionContext: loopActionTransitionContext({
        actionPayload: action.payload,
        planContext: loopActionPlanContext({
          plan: executionPlan,
          actionKind: action.action_kind,
          unitId: action.unit_id,
          reviewSubject,
        }),
        actionKind: action.action_kind,
        unitId: action.unit_id,
      }),
      ...(tuneAuthorization ? {
        tuneMaterial: {
          schema: "openthrottle.tune-change-material/v1" as const,
          proposalDigest: tuneAuthorization.proposalDigest,
          changes: tuneAuthorization.changes,
        },
      } : {}),
      ...(priorEvidence ? { priorEvidence } : {}),
      ...(downstreamContext.length > 0 ? { downstreamContext } : {}),
      ...(action.action_kind === "lead"
        ? {
            candidateSubject: leadCandidateSubject,
          }
        : {}),
      allowedMcpServers: workerBinding.worker.allowed_mcp_servers,
      credentialScopes: workerBinding.credentials as LoopActionRequest["credentialScopes"],
      receiptSchema: RECEIPT_SCHEMA,
      expectedReceiptType: expectedReceiptTypeFor(action.action_kind),
      expectedProducerSkill: expectedSkillFor(workerBinding),
      expectedProducer: expectedProducerForAction(instance, action),
      ...(workerBinding.repositorySkill ? { repositorySkill: workerBinding.repositorySkill } : {}),
    });
    assertLoopRequestEnvelopeBound(loopRequest);
    deps.store.prepareActionDispatch?.({
      actionId: action.id,
      requestHash: loopRequest.requestHash,
      requestPayload: canonicalJson(loopRequest),
      nativeSessionId: loopRequest.nativeSessionId,
    });
    if (createNewWorktree && worktree) {
      await deps.runtime.createWorktree(resource, {
        idempotencyKey: worktreeIdempotencyKey(action),
        attemptId: action.parent_attempt_id,
        baseCommit,
      });
      deps.store.markActionWorktreeReady?.(action.id);
    }
    await deps.runtime.dispatchLoopAction(resource, loopRequest);
    return { requestHash: loopRequest.requestHash, nativeSessionId: action.native_session_id ?? null };
  };

  const collectChildAction = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Promise<{
    terminal?: false;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    nativeSessionId?: string | null;
    decision?: ReturnType<typeof evaluateUnitAcceptanceGate>;
    checkpointObject?: ExecutionCheckpointObject;
  } | {
    terminal: true;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
    terminalPayload?: string;
    privateArtifact?: ExecutionWorkPrivateArtifact;
  } | null> => {
    if (!action.request_hash) return null;
    if (action.action_kind === "final_review") {
      let request: LoopActionRequest;
      try {
        if (!action.request_payload) throw new Error("missing persisted selector request");
        request = JSON.parse(action.request_payload) as LoopActionRequest;
        if (request.protocol !== "loop-action@3" || request.skill !== "select-review-personas") {
          throw new Error("final review request is not the sealed selector action");
        }
      } catch (error) {
        return {
          terminal: true,
          resultHash: digestCanonicalJson({ action_id: action.id, request_payload: action.request_payload }),
          outcome: "failure",
          lastError: `structured review request invalid: ${sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)}`,
          nativeSessionId: null,
        };
      }
      return reviewOrchestrator.collectOrchestratedFinalReview(resource, instance, action, request);
    }
    let result: Awaited<ReturnType<SandboxRuntime["collectChildExecutorActionResult"]>> |
      Awaited<ReturnType<SandboxRuntime["collectLoopActionResult"]>>;
    const collectionRequest = {
      attemptId: action.parent_attempt_id,
      actionId: action.id,
      requestHash: action.request_hash,
    };
    try {
      result = isChildExecutorActionKind(action.action_kind)
        ? await deps.runtime.collectChildExecutorActionResult(resource, collectionRequest)
        : await deps.runtime.collectLoopActionResult(resource, collectionRequest);
    } catch (error) {
      const observed = serializeRuntimeObservationError(
        `${action.action_kind} result collection`,
        error
      );
      if (observed.retryable) throw new Error(observed.text);
      const message = sanitizeText(observed.text).slice(-500);
      return {
        terminal: true,
        resultHash: digestCanonicalJson({
          schema: "openthrottle.child-action-collection-error/v1",
          action_id: action.id,
          request_hash: action.request_hash,
          message,
        }),
        outcome: "retryable_infrastructure_failure",
        lastError: `runtime result collection failed: ${message}`,
        nativeSessionId: null,
      };
    }
    if (!result) return null;
    const nativeSessionId: string | null = "nativeSessionId" in result
      ? (result as { nativeSessionId: string | null }).nativeSessionId
      : null;
    const collected = (
      outputSubject: string,
      receipt: StandardReceipt,
      decision?: ReturnType<typeof evaluateUnitAcceptanceGate>,
      checkpointObject?: ExecutionCheckpointObject
    ) => ({
      resultHash: actionResultHash(result),
      outputSubject,
      receipt: canonicalJson(receipt),
      nativeSessionId,
      ...(decision ? { decision } : {}),
      ...(checkpointObject ? { checkpointObject } : {}),
    });
    // `result.receipt` is dual-typed by contract, but the outcomes that carry
    // free text instead of receipt JSON differ by executor: a loop action
    // (execute-loop.mjs) only ever produces receipt JSON on a `success`
    // outcome -- every other outcome carries a classification head, e.g.
    // "loop action failed (reason=credential_rejected)". A child-executor
    // action (execute-child-action.mjs) runs a deterministic command/git
    // operation that still produces a valid, meaningful `command_result` or
    // `integration_evidence` receipt on a semantic `failure` (e.g. the test
    // command exited non-zero); only its own infrastructure faults
    // (`retryable_infrastructure_failure`) fall back to free text. Route the
    // free-text case straight into the graded/retryable handling without ever
    // running it through parseStandardReceipt -- that reliably fails and
    // reports every infrastructure fault as a tautological "malformed
    // receipt" that carries no information -- and preserve the diagnostic's
    // head (not tail): the tail is byte-identical padding across different
    // failure reasons, while the head is the one place the classification
    // signal actually lives.
    const actionIsChildExecutor = isChildExecutorActionKind(action.action_kind);
    const receiptIsDiagnosticText = actionIsChildExecutor
      ? result.outcome === "retryable_infrastructure_failure"
      : result.outcome !== "success";
    if (receiptIsDiagnosticText) {
      const outcome = result.outcome === "retryable_infrastructure_failure"
        ? "retryable_infrastructure_failure"
        : result.outcome === "needs_human"
          ? "needs_human"
          : "failure";
      return {
        terminal: true,
        resultHash: actionResultHash(result),
        outcome,
        lastError: `${result.outcome}: ${sanitizeText(result.receipt).slice(0, DIAGNOSTIC_TEXT_HEAD_CHARS)}`,
        nativeSessionId,
        terminalPayload: actionIsChildExecutor
          ? undefined
          : terminalPayloadForLoopResult(result as LoopActionResult),
        privateArtifact: actionIsChildExecutor
          ? undefined
          : privateArtifactForLoopResult(result as LoopActionResult),
      };
    }
    let receipt: StandardReceipt;
    try {
      receipt = parseStandardReceipt(result.receipt, { source: `child_action.${action.id}.receipt` }).value;
    } catch (error) {
      return {
        terminal: true,
        resultHash: actionResultHash(result),
        outcome: "failure",
        lastError: `child action ${action.id} returned malformed ${result.outcome} receipt: ${sanitizeText(result.receipt).slice(0, DIAGNOSTIC_TEXT_HEAD_CHARS)}`,
        nativeSessionId,
      };
    }
    try {
      if (result.subject !== null && result.subject !== undefined && result.subject !== receipt.subject.post) {
        throw new Error(`child action ${action.id} result subject does not match receipt subject`);
      }
      const resultSubject = receipt.subject.post;
      if (!GIT_SUBJECT.test(resultSubject)) {
        throw new Error(`child action ${action.id} completed without an exact subject`);
      }
      if (action.action_kind === "lead") {
        if (receipt.type !== "unit_decision") {
          throw new Error(`child action ${action.id} returned ${receipt.type}, expected unit_decision`);
        }
        const receiptEntries = completedAttemptReceiptsFor(action.parent_attempt_id);
        const completion = unitCompletionAttemptReceipt(receiptEntries, action.unit_id, action.cycle);
        const candidate = latestAttemptReceipt<CandidateEvidenceReceipt>(
          receiptEntries,
          "candidate_evidence",
          action.unit_id,
          action.cycle
        );
        const commands = commandAttemptReceipts(receiptEntries, action.unit_id, action.cycle);
        const acceptedSubject = candidate.receipt.subject.post;
        const decision = evaluateUnitAcceptanceGate({
          expected: standardFenceFor(instance, action, acceptedSubject),
          expectedReceipts: {
            completion: standardFenceFor(instance, completion.attempt, completion.receipt.subject.post),
            candidate: standardFenceFor(instance, candidate.attempt, candidate.receipt.subject.post),
            commands: commands.map((command) => standardFenceFor(instance, command.attempt, command.receipt.subject.post)),
            lead: standardFenceFor(instance, action, acceptedSubject),
          },
          completion: completion.receipt,
          candidate: candidate.receipt,
          commands: commands.map((command) => command.receipt),
          expectedCommandNames: (() => {
            const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
            const unit = deps.store.listUnits(action.parent_attempt_id)
              .find((unit) => unit.unitId === action.unit_id);
            return unit?.commandNames ? [...unit.commandNames] : graph ? JSON.parse(graph.command_names) as string[] : [];
          })(),
          lead: receipt as UnitDecisionReceipt,
        });
        return {
          resultHash: actionResultHash(result),
          outputSubject: acceptedSubject,
          receipt: canonicalJson(receipt),
          nativeSessionId,
          decision,
        };
      }
      if (action.action_kind === "integrate") {
        if (receipt.type !== "integration_evidence") {
          throw new Error(`child action ${action.id} returned ${receipt.type}, expected integration_evidence`);
        }
        const integrationSubject = receipt.subject.post;
        const checkpointObject = "checkpointObject" in result ? result.checkpointObject : undefined;
        if (checkpointObject &&
            (checkpointObject.expectedOldSha !== receipt.subject.pre ||
             checkpointObject.expectedNewSha !== integrationSubject)) {
          throw new Error(`child action ${action.id} checkpoint object does not match its integration receipt`);
        }
        const decision = evaluateIntegrationGate({
          expected: standardFenceFor(instance, action, integrationSubject),
          integration: receipt as IntegrationEvidenceReceipt,
        });
        return collected(integrationSubject, receipt, decision, checkpointObject);
      }
      // The triggering final-review receipt is bound deterministically via the
      // completion receipt's request_hash fence (asserted below), which was
      // computed over the dispatched request's priorEvidence at dispatch time
      // (see priorEvidenceForAction). This does not depend on agent-authored
      // `evidence[]` content, so a correct repair that follows the sandbox
      // instruction not to reuse prior-action evidence still validates.
      const expectedType = action.action_kind === "command" || action.action_kind === "final_command"
        ? "command_result"
        : action.action_kind === "candidate"
          ? "candidate_evidence"
          : "unit_completion";
      if (receipt.type !== expectedType) {
        throw new Error(`child action ${action.id} returned ${receipt.type}, expected ${expectedType}`);
      }
      if (action.action_kind === "candidate") {
        assertCandidateEvidenceFence({
          expected: standardFenceFor(instance, action, receipt.subject.post),
          candidate: receipt as CandidateEvidenceReceipt,
        });
      } else if (action.action_kind === "command" || action.action_kind === "final_command") {
        assertStandardReceiptFence({
          expected: standardFenceFor(instance, action, receipt.subject.post),
          receipt: receipt as CommandResultReceipt,
          role: "command",
        });
      } else {
        assertStandardReceiptFence({
          expected: standardFenceFor(instance, action, receipt.subject.post),
          receipt: receipt as UnitCompletionReceipt,
          role: "completion",
        });
      }
      return collected(resultSubject, receipt);
    } catch (error) {
      return {
        terminal: true,
        resultHash: actionResultHash(result),
        outcome: "failure",
        lastError: `child action ${action.id} returned invalid ${result.outcome} receipt: ${
          sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)
        }`,
        nativeSessionId,
      };
    }
  };

  return {
    seedCompositeGraph(instance, request, initialSubject) {
      if (!GIT_SUBJECT.test(initialSubject)) {
        throw new Error(`pipeline composite stage ${request.stageId} has an invalid prepared subject`);
      }
      const stage = stageById(instance.normalized_manifest, instance.active_stage_id);
      if (!stage || stage.executor.capability !== FOR_EACH_UNIT_CAPABILITY) {
        throw new Error(`pipeline composite stage ${request.stageId} is not active`);
      }
      const plan = extractExecutionPlan(requestContextForStructuredPlan(request));
      const commandPlan = commandPlanForUnits({
        plan,
        fallbackCommandNames: stage.unitCommandNames ?? [],
        configuredCommandNames: configuredCommandNamesFor(instance, deps.store),
      });
      deps.store.createGraph({
        pipelineInstanceId: instance.id,
        parentAttemptId: request.attemptId,
        parentStageId: request.stageId,
        parentRunId: request.runId,
        graphDigest: instance.manifest_digest,
        planDigest: digestCanonicalJson(plan),
        initialSubject,
        units: commandPlan.units,
        commandNames: commandPlan.graphCommandNames,
        unitPhases: stage.unitPhases,
        unitPhaseBindings: stage.unitPhaseBindings,
        maxRepairRounds: authoredUnitRepairMaxRounds(stage.unitPhaseBindings),
      });
    },

    async drainCompositeChildren(resource, instance, parentAttemptId) {
      // The processor settles at most one child action per drain() call, and
      // the only production driver is a periodic tick: walking the drain here
      // lets a chain of already-collectable results land in one tick instead
      // of one scheduler interval each. A drain that did not settle a fresh
      // result (a dispatch, an in-flight wait, or an observation backoff)
      // ends the walk -- polling the same child again in the same tick cannot
      // advance it -- and the settled-id fence keeps a store that failed to
      // advance a settled action from being collected forever.
      const settledActionIds = new Set<string>();
      let settledResultThisDrain = false;
      const processor = createUnitEffectProcessor({
        store: deps.store,
        runtime: {
          dispatchUnitAction: (action) => dispatchChildAction(resource, instance, action),
          collectUnitAction: async (action) => {
            if (settledActionIds.has(action.id)) return null;
            const result = await collectChildAction(resource, instance, action);
            if (result) {
              settledActionIds.add(action.id);
              settledResultThisDrain = true;
            }
            return result;
          },
        },
        leaseOwner: `pipeline-effects:${instance.id}`,
        now: deps.now,
      });
      const maxChildDrains = deps.maxChildDrainsPerTick ?? MAX_CHILD_DRAINS_PER_TICK;
      for (let drains = 1; ; drains += 1) {
        settledResultThisDrain = false;
        const action = await processor.drain(parentAttemptId);
        if (!action) {
          // A tick that processed child work leaves the aggregate for the
          // next tick, exactly as the single-drain behavior did.
          if (drains > 1) return;
          break;
        }
        if (!settledResultThisDrain || drains >= maxChildDrains) return;
      }
      const graph = deps.store.getGraphForAttempt(parentAttemptId);
      if (!graph) return;
      const parentAttempt = deps.store.getAttempt(parentAttemptId);
      if (!parentAttempt) throw new Error(`structured parent attempt ${parentAttemptId} is missing`);
      const units = deps.store.listUnits(parentAttemptId);
      const attempts = deps.store.listWorkAttempts(parentAttemptId);
      const gates = deps.store.listGateReceipts(parentAttemptId);
      const outcome = graph.stopped_at
        ? stoppedAggregateOutcome(graph.stop_outcome, attempts)
        : aggregateOutcomeFor(units, gates, attempts);
      if (!outcome) return;
      if (outcome === "success" && graph.final_phase !== "done") return;
      const integrationSubject = outcome === "success"
        ? graph.integration_subject
        : graph.integration_subject ?? parentAttempt.expected_subject ?? instance.immutable_subject ?? instance.base_commit;
      if (!integrationSubject || !GIT_SUBJECT.test(integrationSubject)) {
        throw new Error(`structured aggregate ${parentAttemptId} has no exact subject`);
      }
      let aggregateSubject = integrationSubject;
      if (outcome === "success") {
        aggregateSubject = verifiedAggregateTreeSubject({
          parentAttemptId,
          integrationSubject,
          attempts,
          gates,
        });
        const finalReviewSubject = latestAttemptReceipt<SemanticReviewReceipt>(
          completedAttemptReceiptsFrom(attempts),
          "semantic_review",
          null
        ).receipt.subject.post;
        if (finalReviewSubject !== integrationSubject) {
          throw new Error("structured aggregate success requires the fresh final review subject to match the integrated subject");
        }
      }
      const aggregateCompletedAt = graph.aggregate_emitted_at ?? deps.now().toISOString();
      const manifest = JSON.parse(instance.normalized_manifest);
      const event = buildAggregateStageEvent({
        id: `execution-aggregate:${parentAttemptId}:${aggregateSubject}:${outcome}`,
        manifest,
        instance,
        parentAttempt,
        outcome,
        subject: aggregateSubject,
        completedAt: aggregateCompletedAt,
        units,
      });
      const graphResult = event.artifacts?.find((artifact) => artifact.kind === "execution_graph_result");
      if (!graphResult) throw new Error(`structured aggregate ${event.id} did not include execution_graph_result`);
      if (graph.aggregate_emitted_at) {
        if (graph.aggregate_artifact_hash !== graphResult.hash) {
          throw new Error(`structured aggregate ${parentAttemptId} replay hash does not match durable graph marker`);
        }
        if (["completed", "canceled", "superseded", "failed"].includes(parentAttempt.status)) return;
        completeParentStage(event);
        return;
      }
      deps.store.emitAggregateOnce({
        parentAttemptId,
        artifactHash: graphResult.hash,
        integrationSubject: graph.integration_subject,
        emittedAt: aggregateCompletedAt,
        requireFinalReview: outcome === "success",
      });
      completeParentStage(event);
    },

    compositeGraphNeedsDrain(parentAttemptId) {
      const activeWork = deps.store.listWorkAttempts(parentAttemptId).some((action) =>
        action.status === "pending" ||
        action.status === "leased" ||
        action.status === "dispatched" ||
        action.status === "running");
      if (activeWork) return true;
      const graph = deps.store.getGraphForAttempt(parentAttemptId);
      if (!graph) return false;
      const parentAttempt = deps.store.getAttempt(parentAttemptId);
      if (!parentAttempt) return false;
      return !graph.aggregate_emitted_at ||
        !["completed", "canceled", "superseded", "failed"].includes(parentAttempt.status);
    },
  };
}
