import {
  EXECUTION_PLAN_SCHEMA,
  parseExecutionPlanContract,
  parseStandardReceipt,
  RECEIPT_SCHEMA,
  type CandidateEvidenceReceipt,
  type CommandResultReceipt,
  type ExecutionPlanContract,
  type IntegrationEvidenceReceipt,
  type SemanticReviewReceipt,
  type StandardReceipt,
  type UnitCompletionReceipt,
  type UnitDecisionReceipt,
} from "@openthrottle/contracts";
import { canonicalJson, digestNormalized, type PipelineStage, type StageOutcome } from "../pipeline/manifest.js";
import { FOR_EACH_UNIT_CAPABILITY } from "../pipeline/capability-contracts.js";
import { coordinatePipelineEvent } from "../pipeline/coordinator.js";
import {
  buildAggregateStageEvent,
  type ExecutionUnitState,
  type UnitActionKind,
} from "../pipeline/unit-coordinator.js";
import {
  assertCandidateEvidenceFence,
  evaluateFinalReviewGate,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type ExpectedReceiptProducer,
  type ReceiptProducerRole,
  type StandardReceiptFence,
} from "../pipeline/execution-gates.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type { ExecutionGateReceipt, ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ChildExecutorActionRequest, LoopActionRequest, RuntimeResource, SandboxRuntime } from "../runtime/contracts.js";
import { extractJsonBlocks } from "../shared/markdown.js";
import { sanitizeText } from "../shared/sanitize.js";
import { createUnitEffectProcessor } from "./unit-effects.js";

const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const GIT_SHA1_SUBJECT = /^[a-f0-9]{40}$/;
const ACTION_OUTPUT_ORDER: Record<UnitActionKind, number> = {
  implement: 10,
  repair: 10,
  simplify: 20,
  command: 30,
  candidate: 40,
  lead: 50,
  integrate: 60,
  final_repair: 10,
  final_command: 20,
  final_review: 30,
  aggregate: 40,
  stop: 40,
  cleanup: 40,
};

type StructuredChildRuntimeDeps = {
  store: PipelineStore & ExecutionUnitStore;
  runtime: SandboxRuntime;
  taskTimeoutSeconds: number;
  now: () => Date;
};

type LoopDispatchBinding = {
  kind: "agent" | "gate";
  loop: { skill: string; timeout_seconds?: number };
  worker: {
    id: string;
    agent?: "inherit" | "claude" | "codex" | "opencode";
    allowed_mcp_servers: string[];
  };
  credentials: LoopActionRequest["credentialScopes"];
  context: LoopActionRequest["contextPolicy"] | "none";
  repositorySkill?: LoopActionRequest["repositorySkill"];
};

export interface StructuredChildRuntime {
  seedCompositeGraph(instance: PipelineInstance, request: StageRequestEnvelope): void;
  drainCompositeChildren(resource: RuntimeResource, instance: PipelineInstance, parentAttemptId: string): Promise<void>;
  compositeGraphNeedsDrain(parentAttemptId: string): boolean;
}

export function aggregateOutcomeFor(
  units: readonly ExecutionUnitState[],
  gates: readonly ExecutionGateReceipt[] = []
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

function stoppedAggregateOutcome(stopReason: string | null, attempts: readonly ExecutionWorkAttempt[]): StageOutcome {
  if (attempts.some((attempt) => attempt.status === "failed") ||
      /\b(fail(?:ed|ure)?|error|timed out|missed heartbeat)\b/i.test(stopReason ?? "")) {
    return "failure";
  }
  return "needs_human";
}

function builtinLoopBinding(input: {
  kind: LoopDispatchBinding["kind"];
  workerId: string;
  skill: string;
  credentials: LoopActionRequest["credentialScopes"];
}): LoopDispatchBinding {
  return Object.freeze({
    kind: input.kind,
    worker: {
      id: input.workerId,
      agent: "inherit" as const,
      allowed_mcp_servers: [],
    },
    loop: {
      skill: input.skill,
      timeout_seconds: undefined,
    },
    credentials: input.credentials,
    context: "fresh",
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
  credentials: ["model.invoke", "repo.read", "repo.write"],
});

function extractExecutionPlan(context: string): ExecutionPlanContract {
  const blocks = extractJsonBlocks(context, EXECUTION_PLAN_SCHEMA);
  if (blocks.length !== 1) {
    throw new Error(`structured composite stage requires exactly one ${EXECUTION_PLAN_SCHEMA} block`);
  }
  return parseExecutionPlanContract(blocks[0]!, { source: "sealed.execution_plan" }).value;
}

function normalizedLoopRequestForHash(
  request: Omit<LoopActionRequest, "requestHash" | "idempotencyKey">
): Omit<LoopActionRequest, "requestHash" | "idempotencyKey"> {
  const { candidateSubject, ...withoutCandidate } = request;
  return candidateSubject === null || candidateSubject === undefined
    ? withoutCandidate
    : { ...withoutCandidate, candidateSubject };
}

function buildLoopActionRequest(
  request: Omit<LoopActionRequest, "requestHash" | "idempotencyKey">
): LoopActionRequest {
  const normalized = normalizedLoopRequestForHash(request);
  const requestHash = digestNormalized(canonicalJson(normalized));
  return {
    ...normalized,
    requestHash,
    idempotencyKey: `loop:${request.attemptId}:${request.actionId}:${requestHash}`,
  };
}

function buildChildExecutorActionRequest(
  request: Omit<ChildExecutorActionRequest, "requestHash" | "idempotencyKey">
): ChildExecutorActionRequest {
  const requestHash = digestNormalized(canonicalJson(request));
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
  return binding.repositorySkill?.reference ?? binding.loop.skill;
}

function builtinProducer(
  skill: "command_result" | "candidate_evidence" | "integration_evidence" | "final-review",
  capabilityDigest: string,
  assurance: ExpectedReceiptProducer["assurance"] = "executor_verified"
): ExpectedReceiptProducer {
  return {
    workerId: "executor",
    skill: `builtin://${skill}@1`,
    capabilityDigest,
    skillPackageDigest: null,
    assurance,
  };
}

function loopKindFor(actionKind: UnitActionKind): LoopActionRequest["loop"] {
  if (actionKind === "repair" || actionKind === "final_repair") return "repair";
  if (actionKind === "final_review") return "review";
  if (actionKind === "lead") return "lead";
  if (actionKind === "implement" || actionKind === "simplify" || actionKind === "command") return actionKind;
  throw new Error(`child action kind ${actionKind} has no loop kind`);
}

function roleFor(actionKind: UnitActionKind): LoopActionRequest["role"] {
  if (actionKind === "lead") return "lead";
  if (actionKind === "final_review") return "reviewer";
  return "worker";
}

function worktreeIdempotencyKey(action: ExecutionWorkAttempt): string {
  return `worktree:${action.parent_attempt_id}:${action.unit_id ?? "final"}:${action.cycle}`;
}

function worktreeHandleFor(action: ExecutionWorkAttempt, baseCommit: string): { id: string } {
  return {
    id: digestNormalized(canonicalJson({
      idempotencyKey: worktreeIdempotencyKey(action),
      attemptId: action.parent_attempt_id,
      baseCommit,
    })).slice(0, 32),
  };
}

function compareAttemptOrder(left: ExecutionWorkAttempt, right: ExecutionWorkAttempt): number {
  return ACTION_OUTPUT_ORDER[left.action_kind] - ACTION_OUTPUT_ORDER[right.action_kind] ||
    left.attempt_ordinal - right.attempt_ordinal ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);
}

function sha1SubjectForGitOperation(subject: string, label: string): string {
  if (!GIT_SHA1_SUBJECT.test(subject)) {
    throw new Error(`${label} must be a 40-character Git object ID for child Git operations`);
  }
  return subject;
}

function finalRepairWorktreeHandleFor(
  action: ExecutionWorkAttempt,
  baseCommit: string,
  attempts: readonly ExecutionWorkAttempt[]
): { id: string } {
  const finalRepair = attempts.find((attempt) =>
    attempt.unit_id === null &&
    attempt.action_kind === "final_repair" &&
    attempt.cycle === action.cycle &&
    attempt.status === "completed"
  );
  if (!finalRepair) throw new Error(`child final candidate action ${action.id} has no completed final repair worktree`);
  return worktreeHandleFor(finalRepair, baseCommit);
}

function activeStageFor(instance: PipelineInstance): PipelineStage | undefined {
  const manifest = JSON.parse(instance.normalized_manifest) as { stages?: unknown };
  const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
  return stages.find((stage) =>
    typeof stage === "object" && stage !== null &&
    (stage as { id?: unknown }).id === instance.active_stage_id
  ) as PipelineStage | undefined;
}

export function createStructuredChildRuntime(deps: StructuredChildRuntimeDeps): StructuredChildRuntime {
  const worktreeBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
    const base = graph?.integration_subject ?? instance.immutable_subject ?? instance.base_commit;
    if (!GIT_SUBJECT.test(base)) throw new Error(`child action ${action.id} has no exact worktree base`);
    return base;
  };

  const latestPriorOutputSubject = (
    action: ExecutionWorkAttempt,
    kinds: readonly UnitActionKind[]
  ): string | undefined => {
    const attempts = deps.store.listWorkAttempts(action.parent_attempt_id);
    let latest: ExecutionWorkAttempt | undefined;
    for (const attempt of attempts) {
      if (
        attempt.status === "completed" &&
        attempt.output_subject &&
        attempt.unit_id === action.unit_id &&
        attempt.cycle === action.cycle &&
        kinds.includes(attempt.action_kind)
      ) {
        latest = latest && compareAttemptOrder(latest, attempt) > 0 ? latest : attempt;
      }
    }
    return latest?.output_subject ?? undefined;
  };

  const actionInputSubjectFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const base = worktreeBaseFor(instance, action);
    if (action.action_kind === "command") {
      return latestPriorOutputSubject(action, ["implement", "repair", "simplify", "command"]) ?? base;
    }
    if (action.action_kind === "candidate") {
      if (action.unit_id === null) {
        return latestPriorOutputSubject(action, ["final_repair"]) ?? base;
      }
      return latestPriorOutputSubject(action, ["implement", "repair", "simplify", "command"]) ?? base;
    }
    if (action.action_kind === "lead") {
      return latestPriorOutputSubject(action, ["candidate"]) ?? base;
    }
    if (action.action_kind === "final_command") {
      return latestPriorOutputSubject({ ...action, unit_id: null }, ["final_command"]) ??
        deps.store.getGraphForAttempt(action.parent_attempt_id)?.integration_subject ?? base;
    }
    if (action.action_kind === "final_review") {
      return latestPriorOutputSubject({ ...action, unit_id: null }, ["final_command", "final_repair"]) ??
        deps.store.getGraphForAttempt(action.parent_attempt_id)?.integration_subject ?? base;
    }
    if (action.action_kind === "integrate") {
      return deps.store.getGraphForAttempt(action.parent_attempt_id)?.integration_subject ?? base;
    }
    if (action.action_kind === "simplify") {
      return latestPriorOutputSubject(action, ["implement", "repair"]) ?? base;
    }
    return base;
  };

  const actionBinding = (instance: PipelineInstance, action: ExecutionWorkAttempt): LoopDispatchBinding | undefined => {
    if (action.action_kind === "final_review") return FINAL_REVIEW_BINDING;
    if (action.action_kind === "final_repair") return FINAL_REPAIR_BINDING;
    const stage = activeStageFor(instance);
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
    const implementationProbe = { ...action, action_kind: action.cycle > 1 ? "repair" as const : "implement" as const };
    const leadProbe = { ...action, action_kind: "lead" as const };
    return {
      completion: agentProducerFor(instance, implementationProbe, "completion"),
      candidate: builtinProducer("candidate_evidence", instance.capability_digest),
      command: builtinProducer("command_result", instance.capability_digest),
      lead: agentProducerFor(instance, leadProbe, "lead"),
      integration: builtinProducer("integration_evidence", instance.capability_digest),
      review: agentProducerFor(instance, { ...action, action_kind: "final_review" as const }, "review"),
    };
  };

  const standardFenceFor = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    subject: string
  ): StandardReceiptFence => ({
    pipelineInstanceId: instance.id,
    graphDigest: instance.manifest_digest,
    unitId: action.unit_id ?? "__final__",
    attemptId: action.parent_attempt_id,
    parentRunId: action.parent_run_id,
    actionAttemptId: action.id,
    generation: instance.generation,
    nativeSessionId: action.native_session_id,
    requestHash: action.request_hash ?? "",
    baseSubject: worktreeBaseFor(instance, action),
    preSubject: actionInputSubjectFor(instance, action),
    subject,
    producers: expectedProducersFor(instance, action),
  });

  const completedAttemptReceiptsFor = (parentAttemptId: string): Array<{
    attempt: ExecutionWorkAttempt;
    receipt: StandardReceipt;
  }> => completedAttemptReceiptsFrom(deps.store.listWorkAttempts(parentAttemptId));

  const completedAttemptReceiptsFrom = (attempts: readonly ExecutionWorkAttempt[]): Array<{
    attempt: ExecutionWorkAttempt;
    receipt: StandardReceipt;
  }> =>
    attempts
      .filter((attempt) => attempt.status === "completed" && attempt.receipt)
      .map((attempt) => ({
        attempt,
        receipt: parseStandardReceipt(attempt.receipt!, { source: `child_action.${attempt.id}.receipt` }).value,
      }));

  const latestAttemptReceipt = <T extends StandardReceipt>(
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    type: T["type"],
    unitId: string | null,
    cycle?: number
  ): { attempt: ExecutionWorkAttempt; receipt: T } => {
    let latest: { attempt: ExecutionWorkAttempt; receipt: StandardReceipt } | undefined;
    for (const entry of receipts) {
      if (
        entry.receipt.type === type &&
        entry.receipt.fence.unit_id === (unitId ?? "__final__") &&
        (cycle === undefined || entry.attempt.cycle === cycle)
      ) {
        latest = latest && compareAttemptOrder(latest.attempt, entry.attempt) > 0 ? latest : entry;
      }
    }
    if (latest) return { attempt: latest.attempt, receipt: latest.receipt as T };
    throw new Error(`missing ${type} receipt for ${unitId ?? "final"}`);
  };

  const unitCompletionAttemptReceipt = (
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    unitId: string | null,
    cycle: number
  ): { attempt: ExecutionWorkAttempt; receipt: UnitCompletionReceipt } => {
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const entry = receipts[index]!;
      if (
        entry.receipt.type === "unit_completion" &&
        entry.receipt.fence.unit_id === (unitId ?? "__final__") &&
        entry.attempt.cycle === cycle &&
        (entry.attempt.action_kind === "implement" || entry.attempt.action_kind === "repair")
      ) {
        return { attempt: entry.attempt, receipt: entry.receipt as UnitCompletionReceipt };
      }
    }
    throw new Error(`missing implement/repair unit_completion receipt for ${unitId ?? "final"}`);
  };

  const commandAttemptReceipts = (
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    unitId: string | null,
    cycle?: number
  ): Array<{ attempt: ExecutionWorkAttempt; receipt: CommandResultReceipt }> =>
    receipts
      .filter((entry): entry is { attempt: ExecutionWorkAttempt; receipt: CommandResultReceipt } =>
        entry.receipt.type === "command_result" &&
        entry.receipt.fence.unit_id === (unitId ?? "__final__") &&
        (cycle === undefined || entry.attempt.cycle === cycle));

  const dispatchChildAction = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Promise<{ requestHash: string; nativeSessionId?: string | null }> => {
    if (isChildExecutorActionKind(action.action_kind)) {
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
      });
      await deps.runtime.dispatchChildExecutorAction(resource, request);
      return { requestHash: request.requestHash, nativeSessionId: null };
    }
    const binding = actionBinding(instance, action);
    const workerBinding = binding && (binding.kind === "agent" || binding.kind === "gate") ? binding : undefined;
    if (!workerBinding) {
      throw new Error(`child action kind ${action.action_kind} is executor-owned and cannot dispatch as a loop agent`);
    }
    const baseCommit = sha1SubjectForGitOperation(worktreeBaseFor(instance, action), "child action base subject");
    const createNewWorktree = action.action_kind === "implement" ||
      action.action_kind === "repair" ||
      action.action_kind === "final_repair";
    const worktree = await (async (): Promise<LoopActionRequest["worktree"]> => {
      if (roleFor(action.action_kind) !== "worker") return null;
      if (!createNewWorktree || action.status === "dispatched") return worktreeHandleFor(action, baseCommit);
      return deps.runtime.createWorktree(resource, {
        idempotencyKey: worktreeIdempotencyKey(action),
        attemptId: action.parent_attempt_id,
        baseCommit,
      });
    })();
    const contextPolicy = workerBinding.context === "none"
      ? "fresh"
      : workerBinding.context === "resume_required" && !action.native_session_id
        ? "prefer_resume"
        : workerBinding.context;
    const loopRequest = buildLoopActionRequest({
      protocol: "loop-action@2",
      actionId: action.id,
      attemptId: action.parent_attempt_id,
      graphId: action.execution_graph_id,
      parentRunId: action.parent_run_id,
      unitId: action.unit_id,
      role: roleFor(action.action_kind),
      loop: loopKindFor(action.action_kind),
      agent: workerBinding?.worker.agent && workerBinding.worker.agent !== "inherit"
        ? workerBinding.worker.agent
        : instance.agent,
      skill: workerBinding.repositorySkill?.invocation ?? adapterSkillFor(action.action_kind),
      worktree,
      nativeSessionId: action.native_session_id,
      contextPolicy,
      timeoutMs: (workerBinding?.loop.timeout_seconds ?? deps.taskTimeoutSeconds) * 1_000,
      transitionContext: action.payload,
      ...(action.action_kind === "lead"
        ? {
            candidateSubject: deps.store.listUnits(action.parent_attempt_id)
              .find((unit) => unit.unitId === action.unit_id)?.acceptedCandidateSubject ??
              latestAttemptReceipt<CandidateEvidenceReceipt>(
                completedAttemptReceiptsFor(action.parent_attempt_id),
                "candidate_evidence",
                action.unit_id,
                action.cycle
              ).receipt.subject.post,
          }
        : {}),
      allowedMcpServers: workerBinding?.worker.allowed_mcp_servers ?? [],
      credentialScopes: workerBinding.credentials as LoopActionRequest["credentialScopes"],
      receiptSchema: RECEIPT_SCHEMA,
      ...(workerBinding?.repositorySkill ? { repositorySkill: workerBinding.repositorySkill } : {}),
    });
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
  } | {
    terminal: true;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
  } | null> => {
    if (!action.request_hash) return null;
    const result = isChildExecutorActionKind(action.action_kind)
      ? await deps.runtime.collectChildExecutorActionResult(resource, {
          attemptId: action.parent_attempt_id,
          actionId: action.id,
          requestHash: action.request_hash,
        })
      : await deps.runtime.collectLoopActionResult(resource, {
          attemptId: action.parent_attempt_id,
          actionId: action.id,
          requestHash: action.request_hash,
    });
    if (!result) return null;
    const nativeSessionId: string | null = "nativeSessionId" in result
      ? (result as { nativeSessionId: string | null }).nativeSessionId
      : null;
    const collected = (
      outputSubject: string,
      receipt: StandardReceipt,
      decision?: ReturnType<typeof evaluateUnitAcceptanceGate>
    ) => ({
      resultHash: digestNormalized(canonicalJson(result)),
      outputSubject,
      receipt: canonicalJson(receipt),
      nativeSessionId,
      ...(decision ? { decision } : {}),
    });
    let receipt: StandardReceipt;
    try {
      receipt = parseStandardReceipt(result.receipt, { source: `child_action.${action.id}.receipt` }).value;
    } catch (error) {
      if (result.outcome === "failure" || result.outcome === "needs_human" ||
          result.outcome === "retryable_infrastructure_failure") {
        return {
          terminal: true,
          resultHash: digestNormalized(canonicalJson(result)),
          outcome: result.outcome,
          lastError: `child action ${action.id} returned ${result.outcome}: ${sanitizeText(result.receipt).slice(-500)}`,
          nativeSessionId,
        };
      }
      throw error;
    }
    const resultSubject = result.subject ?? receipt.subject.post;
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
          return graph ? JSON.parse(graph.command_names) as string[] : [];
        })(),
        lead: receipt as UnitDecisionReceipt,
      });
      return collected(acceptedSubject, receipt, decision);
    }
    if (action.action_kind === "integrate") {
      if (receipt.type !== "integration_evidence") {
        throw new Error(`child action ${action.id} returned ${receipt.type}, expected integration_evidence`);
      }
      const integrationSubject = receipt.subject.post;
      const decision = evaluateIntegrationGate({
        expected: standardFenceFor(instance, action, integrationSubject),
        integration: receipt as IntegrationEvidenceReceipt,
      });
      return collected(integrationSubject, receipt, decision);
    }
    if (action.action_kind === "final_review") {
      if (receipt.type !== "semantic_review") {
        throw new Error(`child action ${action.id} returned ${receipt.type}, expected semantic_review`);
      }
      const receipts = completedAttemptReceiptsFor(action.parent_attempt_id);
      const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
      const commands = commandAttemptReceipts(receipts, null, action.cycle);
      const reviewSubject = actionInputSubjectFor(instance, action);
      const decision = evaluateFinalReviewGate({
        expected: standardFenceFor(instance, action, reviewSubject),
        expectedReceipts: {
          commands: commands.map((command) => standardFenceFor(instance, command.attempt, command.receipt.subject.post)),
          review: standardFenceFor(instance, action, reviewSubject),
        },
        commands: commands.map((command) => command.receipt),
        expectedCommandNames: graph ? JSON.parse(graph.command_names) as string[] : [],
        review: receipt as SemanticReviewReceipt,
      });
      return collected(reviewSubject, receipt, decision);
    }
    const expectedType = action.action_kind === "command" || action.action_kind === "final_command"
      ? "command_result"
      : action.action_kind === "candidate"
        ? "candidate_evidence"
        : "unit_completion";
    if (receipt.type !== expectedType) {
      throw new Error(`child action ${action.id} returned ${receipt.type}, expected ${expectedType}`);
    }
    if (action.action_kind === "candidate" && action.unit_id === null) {
      assertCandidateEvidenceFence({
        expected: standardFenceFor(instance, action, receipt.subject.post),
        candidate: receipt as CandidateEvidenceReceipt,
      });
    }
    return collected(resultSubject, receipt);
  };

  return {
    seedCompositeGraph(instance, request) {
      const stage = activeStageFor(instance);
      if (!stage || stage.executor.capability !== FOR_EACH_UNIT_CAPABILITY) {
        throw new Error(`pipeline composite stage ${request.stageId} is not active`);
      }
      const plan = extractExecutionPlan(request.taskContext);
      deps.store.createGraph({
        pipelineInstanceId: instance.id,
        parentAttemptId: request.attemptId,
        parentStageId: request.stageId,
        parentRunId: request.runId,
        graphDigest: instance.manifest_digest,
        planDigest: digestNormalized(canonicalJson(plan)),
        units: plan.units.map((unit) => ({ id: unit.id, dependencies: unit.depends_on })),
        commandNames: stage.unitCommandNames ?? [],
        unitPhases: stage.unitPhases,
        unitPhaseBindings: stage.unitPhaseBindings,
      });
    },

    async drainCompositeChildren(resource, instance, parentAttemptId) {
      const action = await createUnitEffectProcessor({
        store: deps.store,
        runtime: {
          dispatchUnitAction: (action) => dispatchChildAction(resource, instance, action),
          collectUnitAction: (action) => collectChildAction(resource, instance, action),
        },
        leaseOwner: `pipeline-effects:${instance.id}`,
        now: deps.now,
      }).drain(parentAttemptId);
      if (action) return;
      const graph = deps.store.getGraphForAttempt(parentAttemptId);
      if (!graph) return;
      const parentAttempt = deps.store.getAttempt(parentAttemptId);
      if (!parentAttempt) throw new Error(`structured parent attempt ${parentAttemptId} is missing`);
      if (
        graph.aggregate_emitted_at &&
        ["completed", "canceled", "superseded", "failed"].includes(parentAttempt.status)
      ) return;
      const units = deps.store.listUnits(parentAttemptId);
      const attempts = deps.store.listWorkAttempts(parentAttemptId);
      const gates = deps.store.listGateReceipts(parentAttemptId);
      const outcome = graph.stopped_at
        ? stoppedAggregateOutcome(graph.stop_reason, attempts)
        : aggregateOutcomeFor(units, gates);
      if (!outcome) return;
      if (outcome === "success" && graph.final_phase !== "done") return;
      const aggregateSubject = graph.integration_subject ?? parentAttempt.expected_subject ?? instance.immutable_subject ?? instance.base_commit;
      if (!aggregateSubject || !GIT_SUBJECT.test(aggregateSubject)) {
        throw new Error(`structured aggregate ${parentAttemptId} has no exact subject`);
      }
      if (outcome === "success") {
        const finalReviewSubject = latestAttemptReceipt<SemanticReviewReceipt>(
          completedAttemptReceiptsFrom(attempts),
          "semantic_review",
          null
        ).receipt.subject.post;
        if (finalReviewSubject !== aggregateSubject) {
          throw new Error("structured aggregate success requires the fresh final review subject to match the integrated subject");
        }
      }
      const event = buildAggregateStageEvent({
        id: `execution-aggregate:${parentAttemptId}:${aggregateSubject}:${outcome}`,
        manifest: JSON.parse(instance.normalized_manifest),
        instance,
        parentAttempt,
        outcome,
        subject: aggregateSubject,
        units,
      });
      const graphResult = event.artifacts?.find((artifact) => artifact.kind === "execution_graph_result");
      if (!graphResult) throw new Error(`structured aggregate ${event.id} did not include execution_graph_result`);
      if (graph.aggregate_emitted_at) {
        if (graph.aggregate_artifact_hash !== graphResult.hash) {
          throw new Error(`structured aggregate ${parentAttemptId} replay hash does not match durable graph marker`);
        }
        coordinatePipelineEvent(deps.store, event);
        return;
      }
      deps.store.emitAggregateOnce({
        parentAttemptId,
        artifactHash: graphResult.hash,
        integrationSubject: graph.integration_subject,
        requireFinalReview: outcome === "success",
      });
      coordinatePipelineEvent(deps.store, event);
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
