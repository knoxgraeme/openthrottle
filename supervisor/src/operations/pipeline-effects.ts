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
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import type { ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import { canonicalJson, type PipelineStage } from "../pipeline/manifest.js";
import { digestNormalized } from "../pipeline/manifest.js";
import { FOR_EACH_UNIT_CAPABILITY } from "../pipeline/capability-contracts.js";
import { coordinatePipelineEvent } from "../pipeline/coordinator.js";
import {
  buildAggregateStageEvent,
  type UnitActionKind,
} from "../pipeline/unit-coordinator.js";
import {
  evaluateFinalReviewGate,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type ExpectedReceiptProducer,
  type ReceiptProducerRole,
  type StandardReceiptFence,
} from "../pipeline/execution-gates.js";
import type {
  PipelineEffectIntent,
  PipelineInstance,
  PipelineRuntimeResource,
  PipelineStore,
} from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type { ChildExecutorActionRequest, LoopActionRequest, RuntimeResource, SandboxAutostopRuntime, SandboxRuntime } from "../runtime/contracts.js";
import { sanitizeText } from "../shared/sanitize.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import { createUnitEffectProcessor } from "./unit-effects.js";

const EFFECT_LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const MAX_EFFECT_ATTEMPTS = 8;
const CAPACITY_RETRY_MS = 5 * 60_000;

// Deterministic provider failures must not burn the whole retry budget on hot
// exponential backoff. Auth failures never self-heal, so they exhaust on the
// first attempt carrying the real sanitized message. Capacity failures clear
// only when unrelated resources are released, so they retry on a fixed patient
// interval while still counting against MAX_EFFECT_ATTEMPTS.
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bunauthorized\b/,
  /\bforbidden\b/,
  /\b40[13]\b/,
  /write access to repository not granted/,
  /resource not accessible/,
  /bad credentials/,
  /\b(?:invalid|expired|revoked)\b[^\n]{0,40}\btoken\b/,
  /\btoken\b[^\n]{0,40}\b(?:invalid|expired|revoked)\b/,
];

const CAPACITY_ERROR_PATTERNS: RegExp[] = [
  /total (?:memory|disk|cpu) limit exceeded/,
  /quota exceeded/,
  /insufficient (?:memory|disk|capacity)/,
];

type EffectErrorClass = "auth" | "capacity" | "transient";
type RuntimeEffectHandlerResult = "acknowledge" | "skip_acknowledgement";

function classifyEffectError(message: string): EffectErrorClass {
  const text = message.toLowerCase();
  // Capacity wins over auth: a provider may wrap a quota rejection in an HTTP
  // 403, and the broad 401/403 auth patterns would otherwise fast-fail an
  // error that clears once resources free up.
  if (CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "capacity";
  if (AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "auth";
  return "transient";
}

export interface PipelineEffectProcessor {
  drain(): Promise<void>;
}

interface PipelineEffectProcessorDeps {
  store: PipelineStore & ExecutionUnitStore;
  tickets: SupervisorStore;
  runtime: SandboxRuntime & SandboxAutostopRuntime;
  taskTimeoutSeconds: number;
  now?: () => Date;
}

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;

function extractExecutionPlan(context: string): ExecutionPlanContract {
  const blocks: string[] = [];
  for (const match of context.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (marker.includes(EXECUTION_PLAN_SCHEMA)) blocks.push(match[2]?.trim() ?? "");
  }
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

interface StopEffectControl {
  runId: string | null | undefined;
  ticketState: unknown;
}

interface EffectRuntimeBinding {
  resource: RuntimeResource | undefined;
  status: PipelineRuntimeResource["status"] | undefined;
}

interface IdleEffectControl {
  stageId: string;
  attemptId: string;
  reason: "provider wait" | "human wait";
}

function parseStopEffectControl(effect: PipelineEffectIntent): StopEffectControl {
  const parsed = JSON.parse(effect.payload) as Record<string, unknown>;
  const hasRunId = Object.prototype.hasOwnProperty.call(parsed, "runId");
  if (hasRunId && parsed.runId !== null && typeof parsed.runId !== "string") {
    throw new Error(`pipeline stop effect ${effect.id} has an invalid run binding`);
  }
  return {
    // Undefined denotes an intent written by an earlier release. Those intents
    // recover a candidate from the durable ticket projection and validate it
    // against the original instance. Newly authored intents always seal either
    // the original run id or an explicit null.
    runId: hasRunId ? (parsed.runId as string | null) : undefined,
    ticketState: parsed.ticketState,
  };
}

function parseIdleEffectControl(effect: PipelineEffectIntent): IdleEffectControl {
  const parsed = JSON.parse(effect.payload) as Record<string, unknown>;
  if (typeof parsed.stageId !== "string" || typeof parsed.attemptId !== "string") {
    throw new Error(`pipeline idle effect ${effect.id} has no wait fence`);
  }
  if (parsed.reason !== "provider wait" && parsed.reason !== "human wait") {
    throw new Error(`pipeline idle effect ${effect.id} has an invalid wait reason`);
  }
  return {
    stageId: parsed.stageId,
    attemptId: parsed.attemptId,
    reason: parsed.reason,
  };
}

function parseRequest(effect: PipelineEffectIntent, store: PipelineStore): StageRequestEnvelope {
  const request = JSON.parse(effect.payload) as StageRequestEnvelope;
  const active = store.getActiveAttempt(effect.pipeline_instance_id);
  if (!active || active.id !== request.attemptId) {
    throw new Error(`pipeline effect ${effect.id} does not target the active attempt`);
  }
  const sealed = store.getStageRequest(active.id);
  if (canonicalJson(request) !== canonicalJson(sealed)) {
    throw new Error(`pipeline effect ${effect.id} stage request does not match its sealed attempt`);
  }
  return sealed;
}

function parseProvisionRequest(effect: PipelineEffectIntent, store: PipelineStore): StageRequestEnvelope {
  const control = JSON.parse(effect.payload) as { attemptId?: unknown; requestHash?: unknown };
  if (typeof control.attemptId !== "string" || typeof control.requestHash !== "string") {
    throw new Error(`pipeline provision effect ${effect.id} has no sealed attempt fence`);
  }
  const attempt = store.getAttempt(control.attemptId);
  if (!attempt || attempt.pipeline_instance_id !== effect.pipeline_instance_id ||
      attempt.request_hash !== control.requestHash) {
    throw new Error(`pipeline provision effect ${effect.id} attempt fence mismatch`);
  }
  const request = store.getStageRequest(attempt.id);
  if (request.pipelineInstanceId !== effect.pipeline_instance_id ||
      request.requestHash !== control.requestHash) {
    throw new Error(`pipeline provision effect ${effect.id} sealed request mismatch`);
  }
  return request;
}

export function createPipelineEffectProcessor(deps: PipelineEffectProcessorDeps): PipelineEffectProcessor {
  const now = deps.now ?? (() => new Date());
  let draining = false;

  const runMatchesInstance = (runId: string, instance: PipelineInstance): boolean => {
    const run = deps.tickets.getRun(runId);
    const attempt = deps.store.getAttemptForRun(runId);
    return attempt?.pipeline_instance_id === instance.id &&
      (!run || (
        run.linear_issue_id === instance.linear_issue_id &&
        run.linear_session_id === instance.linear_session_id
      ));
  };

  const resolveStopRunId = (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    ticket: Ticket | undefined,
    control: StopEffectControl,
    rejectInvalidBinding: boolean
  ): string | null => {
    const candidate = control.runId === undefined ? ticket?.run_id ?? null : control.runId;
    if (!candidate) return null;
    if (!runMatchesInstance(candidate, instance)) {
      if (rejectInvalidBinding && control.runId !== undefined) {
        throw new Error(`pipeline stop effect ${effect.id} run binding mismatch`);
      }
      const fallback = ticket?.run_id ?? null;
      return fallback && runMatchesInstance(fallback, instance) ? fallback : null;
    }
    return candidate;
  };

  const assertActiveAttempt = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
    const current = deps.store.getInstance(instance.id);
    const attempt = deps.store.getActiveAttempt(instance.id);
    if (!current || !["pending", "dispatchable", "running"].includes(current.status) ||
        !attempt || attempt.id !== request.attemptId) {
      throw new Error(`pipeline stage request ${request.attemptId} is no longer active`);
    }
  };

  const activeStageFor = (instance: PipelineInstance) => {
    const manifest = JSON.parse(instance.normalized_manifest) as { stages?: unknown };
    const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
    return stages.find((stage) =>
      typeof stage === "object" && stage !== null &&
      (stage as { id?: unknown }).id === instance.active_stage_id
    ) as PipelineStage | undefined;
  };

  const bindCompositeParentRun = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (!ticket || ticket.linear_session_id !== instance.linear_session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    if (ticket.run_id && ticket.run_id !== request.runId) {
      throw new Error(`ticket ${ticket.linear_issue_identifier} already has active actor ${ticket.run_id}`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.linear_issue_id,
        runId: request.runId,
        taskType: instance.task_type,
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline composite stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    deps.store.markStageDispatched(request.attemptId);
  };

  const seedCompositeGraph = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
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
  };

  const worktreeBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
    const finalIntegratedSubject = !action.unit_id && (
      action.action_kind === "final_command" ||
      action.action_kind === "final_review" ||
      action.action_kind === "final_repair"
    )
      ? (() => {
          const units = deps.store.listUnits(action.parent_attempt_id);
          const subjects = [...new Set(units
            .filter((unit) => unit.terminalLevel === "completed" && unit.integrationSubject)
            .map((unit) => unit.integrationSubject!))];
          return subjects.length === 1 && units.every((unit) => unit.terminalLevel === "completed")
            ? subjects[0]
            : undefined;
        })()
      : undefined;
    const base = graph?.integration_subject ?? finalIntegratedSubject ?? instance.immutable_subject ?? instance.base_commit;
    if (!GIT_SUBJECT.test(base)) throw new Error(`child action ${action.id} has no exact worktree base`);
    return base;
  };

  const latestPriorOutputSubject = (
    action: ExecutionWorkAttempt,
    kinds: readonly UnitActionKind[]
  ): string | undefined =>
    [...deps.store.listWorkAttempts(action.parent_attempt_id)]
      .filter((attempt) =>
        attempt.status === "completed" &&
        attempt.output_subject &&
        attempt.unit_id === action.unit_id &&
        attempt.cycle === action.cycle &&
        kinds.includes(attempt.action_kind)
      )
      .reverse()[0]?.output_subject ?? undefined;

  const actionInputSubjectFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const base = worktreeBaseFor(instance, action);
    if (action.action_kind === "command") {
      return latestPriorOutputSubject(action, ["implement", "repair", "simplify", "command"]) ?? base;
    }
    if (action.action_kind === "candidate") {
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

  const actionBinding = (instance: PipelineInstance, action: ExecutionWorkAttempt) => {
    const stage = activeStageFor(instance);
    if (!stage?.unitPhaseBindings) throw new Error(`child action ${action.id} has no graph-declared phase bindings`);
    const phaseId = action.action_kind === "repair" ? "implement"
      : action.action_kind === "final_review" || action.action_kind === "final_repair" || action.action_kind === "final_command"
        ? undefined
        : action.action_kind;
    return phaseId ? stage.unitPhaseBindings.find((binding) => binding.id === phaseId) : undefined;
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
      skill: binding.repositorySkill?.reference ?? `builtin://${binding.loop.skill}@1`,
      capabilityDigest: instance.capability_digest,
      skillPackageDigest: binding.repositorySkill?.packageDigest ?? null,
      assurance: binding.kind === "gate" ? "semantic_attested" : "semantic_attested",
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
  }> =>
    deps.store.listWorkAttempts(parentAttemptId)
      .filter((attempt) => attempt.status === "completed" && attempt.receipt)
      .map((attempt) => ({
        attempt,
        receipt: parseStandardReceipt(attempt.receipt!, { source: `child_action.${attempt.id}.receipt` }).value,
      }));

  const latestAttemptReceipt = <T extends StandardReceipt>(
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    type: T["type"],
    unitId: string | null
  ): { attempt: ExecutionWorkAttempt; receipt: T } => {
    const match = [...receipts].reverse().find((entry) =>
      entry.receipt.type === type && entry.receipt.fence.unit_id === (unitId ?? "__final__")
    );
    if (!match) throw new Error(`missing ${type} receipt for ${unitId ?? "final"}`);
    return { attempt: match.attempt, receipt: match.receipt as T };
  };

  const commandAttemptReceipts = (
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    unitId: string | null
  ): Array<{ attempt: ExecutionWorkAttempt; receipt: CommandResultReceipt }> =>
    receipts
      .filter((entry): entry is { attempt: ExecutionWorkAttempt; receipt: CommandResultReceipt } =>
        entry.receipt.type === "command_result" && entry.receipt.fence.unit_id === (unitId ?? "__final__"));

  const dispatchChildAction = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Promise<{ requestHash: string; nativeSessionId?: string | null }> => {
    if (isChildExecutorActionKind(action.action_kind)) {
      const baseSubject = worktreeBaseFor(instance, action).slice(0, 40);
      const candidateSubject = action.action_kind === "integrate"
        ? deps.store.listUnits(action.parent_attempt_id).find((unit) => unit.unitId === action.unit_id)?.acceptedCandidateSubject ?? undefined
        : undefined;
      if (action.action_kind === "integrate" && !candidateSubject) {
        throw new Error(`child integration action ${action.id} has no accepted candidate subject`);
      }
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
          : {}),
        baseSubject,
        inputSubject: actionInputSubjectFor(instance, action),
        ...(candidateSubject ? { candidateSubject } : {}),
      });
      await deps.runtime.dispatchChildExecutorAction(resource, request);
      return { requestHash: request.requestHash, nativeSessionId: null };
    }
    const binding = actionBinding(instance, action);
    const workerBinding = binding && (binding.kind === "agent" || binding.kind === "gate") ? binding : undefined;
    if (!workerBinding) {
      throw new Error(`child action kind ${action.action_kind} is executor-owned and cannot dispatch as a loop agent`);
    }
    const baseCommit = worktreeBaseFor(instance, action).slice(0, 40);
    const createNewWorktree = action.action_kind === "implement" ||
      action.action_kind === "repair" ||
      action.action_kind === "final_repair";
    const worktree = roleFor(action.action_kind) === "worker"
      ? createNewWorktree
        ? await deps.runtime.createWorktree(resource, {
          idempotencyKey: worktreeIdempotencyKey(action),
          attemptId: action.parent_attempt_id,
          baseCommit,
        })
        : worktreeHandleFor(action, baseCommit)
      : null;
    const loopRequest = buildLoopActionRequest({
      protocol: "loop-action@2",
      actionId: action.id,
      attemptId: action.parent_attempt_id,
      graphId: action.execution_graph_id,
      unitId: action.unit_id,
      role: roleFor(action.action_kind),
      loop: loopKindFor(action.action_kind),
      agent: workerBinding?.worker.agent && workerBinding.worker.agent !== "inherit"
        ? workerBinding.worker.agent
        : instance.agent,
      skill: adapterSkillFor(action.action_kind),
      worktree,
      nativeSessionId: action.native_session_id,
      contextPolicy: workerBinding.context === "none"
        ? "fresh"
        : workerBinding.context,
      timeoutMs: (workerBinding?.loop.timeout_seconds ?? deps.taskTimeoutSeconds) * 1_000,
      transitionContext: action.payload,
      ...(action.action_kind === "lead"
        ? {
            candidateSubject: deps.store.listUnits(action.parent_attempt_id)
              .find((unit) => unit.unitId === action.unit_id)?.acceptedCandidateSubject ??
              latestAttemptReceipt<CandidateEvidenceReceipt>(
                completedAttemptReceiptsFor(action.parent_attempt_id),
                "candidate_evidence",
                action.unit_id
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
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    decision?: ReturnType<typeof evaluateUnitAcceptanceGate>;
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
    const receipt = parseStandardReceipt(result.receipt, { source: `child_action.${action.id}.receipt` }).value;
    const resultSubject = result.subject ?? receipt.subject.post;
    if (!GIT_SUBJECT.test(resultSubject)) {
      throw new Error(`child action ${action.id} completed without an exact subject`);
    }
    if (action.action_kind === "lead") {
      if (receipt.type !== "unit_decision") {
        throw new Error(`child action ${action.id} returned ${receipt.type}, expected unit_decision`);
      }
      const receiptEntries = completedAttemptReceiptsFor(action.parent_attempt_id);
      const completion = latestAttemptReceipt<UnitCompletionReceipt>(receiptEntries, "unit_completion", action.unit_id);
      const candidate = latestAttemptReceipt<CandidateEvidenceReceipt>(receiptEntries, "candidate_evidence", action.unit_id);
      const commands = commandAttemptReceipts(receiptEntries, action.unit_id);
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
      return {
        resultHash: digestNormalized(canonicalJson(result)),
        outputSubject: acceptedSubject,
        receipt: canonicalJson(receipt),
        decision,
      };
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
      return {
        resultHash: digestNormalized(canonicalJson(result)),
        outputSubject: integrationSubject,
        receipt: canonicalJson(receipt),
        decision,
      };
    }
    if (action.action_kind === "final_review") {
      if (receipt.type !== "semantic_review") {
        throw new Error(`child action ${action.id} returned ${receipt.type}, expected semantic_review`);
      }
      const receipts = completedAttemptReceiptsFor(action.parent_attempt_id);
      const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
      const commands = commandAttemptReceipts(receipts, null);
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
      return {
        resultHash: digestNormalized(canonicalJson(result)),
        outputSubject: reviewSubject,
        receipt: canonicalJson(receipt),
        decision,
      };
    }
    const expectedType = action.action_kind === "command" || action.action_kind === "final_command"
      ? "command_result"
      : action.action_kind === "candidate"
        ? "candidate_evidence"
        : "unit_completion";
    if (receipt.type !== expectedType) {
      throw new Error(`child action ${action.id} returned ${receipt.type}, expected ${expectedType}`);
    }
    return {
      resultHash: digestNormalized(canonicalJson(result)),
      outputSubject: resultSubject,
      receipt: canonicalJson(receipt),
    };
  };

  const drainCompositeChildren = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    parentAttemptId: string
  ): Promise<void> => {
    const action = await createUnitEffectProcessor({
      store: deps.store,
      runtime: {
        dispatchUnitAction: (action) => dispatchChildAction(resource, instance, action),
        collectUnitAction: (action) => collectChildAction(resource, instance, action),
      },
      leaseOwner: `pipeline-effects:${instance.id}`,
      now,
    }).drain(parentAttemptId);
    if (action) return;
    const graph = deps.store.getGraphForAttempt(parentAttemptId);
    if (!graph || graph.aggregate_emitted_at || graph.stopped_at || graph.final_phase !== "done") return;
    const units = deps.store.listUnits(parentAttemptId);
    const integratedSubjects = [...new Set(units
      .filter((unit) => unit.terminalLevel === "completed" && unit.integrationSubject)
      .map((unit) => unit.integrationSubject!))];
    if (integratedSubjects.length !== 1 || units.some((unit) => unit.terminalLevel !== "completed")) return;
    const parentAttempt = deps.store.getAttempt(parentAttemptId);
    if (!parentAttempt) throw new Error(`structured parent attempt ${parentAttemptId} is missing`);
    const event = buildAggregateStageEvent({
      id: `execution-aggregate:${parentAttemptId}:${integratedSubjects[0]}`,
      manifest: JSON.parse(instance.normalized_manifest),
      instance,
      parentAttempt,
      subject: integratedSubjects[0]!,
      units,
      completedAt: now().toISOString(),
    });
    const graphResult = event.artifacts?.find((artifact) => artifact.kind === "execution_graph_result");
    if (!graphResult) throw new Error(`structured aggregate ${event.id} did not include execution_graph_result`);
    if (deps.store.emitAggregateOnce({
      parentAttemptId,
      artifactHash: graphResult.hash,
      integrationSubject: integratedSubjects[0]!,
    }) === "emitted") {
      coordinatePipelineEvent(deps.store, event);
    }
  };

  const resourceFor = async (instance: PipelineInstance): Promise<RuntimeResource> => {
    const existing = deps.store.getRuntimeResource(instance.id);
    if (existing) {
      if (existing.status !== "active") {
        throw new Error(`pipeline runtime ${existing.provider_resource_id} is ${existing.status} and cannot dispatch`);
      }
      await deps.runtime.setActive(existing.provider_resource_id);
      return { providerResourceId: existing.provider_resource_id };
    }
    const resource = await deps.runtime.provision({
      idempotencyKey: `provision:${instance.id}`,
      repository: instance.repository,
      baseCommit: instance.base_commit,
      runtimeRelease: instance.runtime_release,
    });
    deps.store.bindRuntimeResource(instance.id, "daytona", resource.providerResourceId);
    deps.tickets.setSandboxId(instance.linear_issue_id, resource.providerResourceId);
    return resource;
  };

  const bootstrap = async (instance: PipelineInstance, resource: RuntimeResource): Promise<void> => {
    const config = deps.store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
    if (!config || config.digest !== instance.repository_config_digest) {
      throw new Error(`pipeline instance ${instance.id} lost its sealed repository config`);
    }
    await deps.runtime.bootstrap(resource, {
      sealedRepositoryConfig: config.normalized_config,
      configDigest: config.digest,
      normalizedManifest: instance.normalized_manifest,
      manifestDigest: instance.manifest_digest,
    });
  };

  const dispatch = async (
    instance: PipelineInstance,
    resource: RuntimeResource,
    request: StageRequestEnvelope
  ): Promise<{ providerDispatchId: string }> => {
    if (request.pipelineInstanceId !== instance.id || request.generation !== instance.generation) {
      throw new Error(`pipeline stage request ${request.attemptId} has a stale instance fence`);
    }
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (!ticket || ticket.linear_session_id !== instance.linear_session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    await deps.runtime.materializeCredentials(resource, request.credentialScopes);
    assertActiveAttempt(instance, request);
    if (ticket.run_id && ticket.run_id !== request.runId) {
      throw new Error(`ticket ${ticket.linear_issue_identifier} already has active actor ${ticket.run_id}`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.linear_issue_id,
        runId: request.runId,
        taskType: instance.task_type,
        // `runs.token_hash` predates the sealed stage protocol. Store the
        // immutable request hash until the column is contracted in a schema-
        // only migration; no bearer callback credential exists.
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    const recovered = await deps.runtime.collectStageResult(resource, request.attemptId);
    if (recovered) return { providerDispatchId: `recovered:${request.attemptId}` };
    assertActiveAttempt(instance, request);
    const dispatched = await deps.runtime.dispatchStage(resource, request);
    deps.store.markStageDispatched(request.attemptId);
    return dispatched;
  };

  const acknowledgeEffect = (effect: PipelineEffectIntent, eventId: string, payload: unknown): void => {
    deps.store.recordEffectAcknowledgement({
      effectId: effect.id,
      eventId,
      payload: canonicalJson(payload),
    });
  };

  const runtimeBindingFor = (instance: PipelineInstance): EffectRuntimeBinding => {
    const binding = deps.store.getRuntimeResource(instance.id);
    return {
      resource: binding ? { providerResourceId: binding.provider_resource_id } : undefined,
      status: binding?.status,
    };
  };

  const isCurrentIdleWait = (instanceId: string, control: IdleEffectControl): boolean => {
    const current = deps.store.getInstance(instanceId);
    const activeAttempt = deps.store.getActiveAttempt(instanceId);
    if (!current || current.active_stage_id !== control.stageId || activeAttempt?.id !== control.attemptId) {
      return false;
    }
    if (control.reason === "provider wait") return current.status === "waiting_provider";
    return current.status === "waiting_human" || current.status === "completion_pending_publication";
  };

  const idleAcknowledgementResult = (effectId: string): RuntimeEffectHandlerResult =>
    deps.store.getEffect(effectId)?.status === "dead" ? "skip_acknowledgement" : "acknowledge";

  const handleStageDispatchEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    eventId: string
  ): Promise<void> => {
    const resource = await resourceFor(instance);
    await bootstrap(instance, resource);
    const request = effect.kind === "dispatch_stage"
      ? parseRequest(effect, deps.store)
      : parseProvisionRequest(effect, deps.store);
    if (request.capability === FOR_EACH_UNIT_CAPABILITY) {
      if (request.pipelineInstanceId !== instance.id || request.generation !== instance.generation) {
        throw new Error(`pipeline composite request ${request.attemptId} has a stale instance fence`);
      }
      bindCompositeParentRun(instance, request);
      seedCompositeGraph(instance, request);
      await drainCompositeChildren(resource, instance, request.attemptId);
      acknowledgeEffect(effect, eventId, {
        providerResourceId: resource.providerResourceId,
        compositeGraphId: deps.store.getGraphForAttempt(request.attemptId)?.id ?? null,
      });
      return;
    }
    const requestedAttempt = deps.store.getAttempt(request.attemptId);
    if (effect.kind === "provision" && requestedAttempt &&
        ["completed", "canceled", "superseded", "failed"].includes(requestedAttempt.status)) {
      acknowledgeEffect(effect, eventId, {
        providerResourceId: resource.providerResourceId,
        providerDispatchId: `already-transitioned:${request.attemptId}`,
      });
      return;
    }
    const dispatched = await dispatch(instance, resource, request);
    acknowledgeEffect(effect, eventId, { providerResourceId: resource.providerResourceId, ...dispatched });
  };

  const handleStopEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    const control = parseStopEffectControl(effect);
    const ticketState = control.ticketState === "closed"
      ? "closed"
      : control.ticketState === "error"
        ? "error"
        : "stopped";
    const settlementReason = ticketState === "closed"
      ? "Pull request closed."
      : ticketState === "error"
        ? "Pipeline infrastructure failed."
        : "Pipeline stopped.";
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    const owner = `pipeline-stop:${effect.id}`;
    const currentSession = ticket?.linear_session_id === instance.linear_session_id;
    const activeRunId = resolveStopRunId(effect, instance, ticket, control, true);
    const boundRun = activeRunId ? deps.tickets.getRun(activeRunId) : undefined;
    if (!binding.resource && (boundRun?.status === "running" || boundRun?.status === "reaping")) {
      throw new Error(`pipeline instance ${instance.id} has an active actor without a runtime resource`);
    }
    if (activeRunId && (boundRun?.status === "running" || boundRun?.status === "reaping")) {
      const settlement = await terminateAndSettleActor({
        runtime: {
          async stopResource(sandboxId, reason) {
            const termination = await deps.runtime.stop({ providerResourceId: sandboxId }, reason);
            if (!termination.confirmed) {
              throw new Error(`pipeline runtime ${sandboxId} did not confirm termination`);
            }
          },
        },
        store: deps.tickets,
        runId: activeRunId,
        sandboxId: binding.resource && binding.status !== "stopped" && binding.status !== "cleaned"
          ? binding.resource.providerResourceId
          : null,
        owner,
        reason: "pipeline stop",
        status: "stopped",
        ticketState: currentSession ? ticketState : undefined,
        failureTail: settlementReason,
        ticketFailureTail: settlementReason,
        prUrl: currentSession ? ticket?.pr_url ?? undefined : undefined,
        quarantineOnStopFailure: false,
        onTerminated: () => {
          deps.store.setRuntimeResourceStatus(instance.id, "stopped");
        },
      });
      const refreshedRun = deps.tickets.getRun(activeRunId);
      if (settlement.kind === "lost" && (refreshedRun?.status === "running" || refreshedRun?.status === "reaping")) {
        throw new Error(`pipeline actor ${activeRunId} lost its stop settlement claim`);
      }
    } else if (binding.resource && binding.status !== "stopped" && binding.status !== "cleaned") {
      const termination = await deps.runtime.stop(binding.resource, "pipeline stop");
      if (!termination.confirmed) {
        throw new Error(`pipeline runtime ${binding.resource.providerResourceId} did not confirm termination`);
      }
      deps.store.setRuntimeResourceStatus(instance.id, "stopped");
    }
    const projectionTicket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (projectionTicket?.linear_session_id === instance.linear_session_id) {
      // The sealed run may already have completed before this terminal stop
      // drains. Project the terminal ticket state independently from actor
      // settlement so completed actors cannot leave a failed pipeline active.
      // Refresh after the provider call so a concurrent replacement session
      // cannot receive its predecessor's terminal projection.
      deps.tickets.setState(
        projectionTicket.linear_issue_id,
        ticketState,
        settlementReason
      );
      deps.tickets.markSessionState(instance.linear_session_id, "stopped");
      deps.tickets.cancelPendingInbox(instance.linear_issue_id);
    }
    if (binding.resource && binding.status !== "cleaned") {
      await deps.runtime.cleanup(binding.resource);
      deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
    }
    const cleanupTicket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (cleanupTicket?.linear_session_id === instance.linear_session_id &&
        (!binding.resource || cleanupTicket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.linear_issue_id, null);
    }
  };

  const handleQuarantineEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    const control = JSON.parse(effect.payload) as { runId?: unknown; owner?: unknown; reason?: unknown };
    const runId = typeof control.runId === "string" ? control.runId : null;
    const owner = typeof control.owner === "string" ? control.owner : `pipeline-quarantine:${effect.id}`;
    const reason = typeof control.reason === "string" ? control.reason : "pipeline stop attempts exhausted";
    if (runId && !runMatchesInstance(runId, instance)) {
      throw new Error(`pipeline quarantine effect ${effect.id} run binding mismatch`);
    }
    if (binding.resource && binding.status !== "cleaned" && binding.status !== "stopped") {
      await deps.runtime.quarantine(binding.resource, reason);
      deps.store.setRuntimeResourceStatus(instance.id, "quarantined");
    }
    if (runId) {
      const quarantined = deps.tickets.quarantineRun(runId, owner, reason);
      const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
      if (!quarantined && refreshed?.run_id === runId) {
        throw new Error(`pipeline actor ${runId} could not be quarantined by ${owner}`);
      }
    } else {
      const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
      if (refreshed?.linear_session_id === instance.linear_session_id) {
        // A stage actor can complete before its terminal runtime stop. If
        // provider termination then exhausts there is no live run to
        // quarantine, but the current ticket must still expose the
        // infrastructure failure.
        deps.tickets.setState(instance.linear_issue_id, "error", reason);
      }
    }
  };

  const handleCleanupEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    // preserve stops the sandbox instead of deleting it: memory is released
    // while the workspace (and any unpushed work) survives for the human a
    // needs_human terminal is waiting on. The ticket keeps its sandbox link
    // so the workspace stays findable and the orphan sweep retains it.
    const preserve = (JSON.parse(effect.payload) as { preserve?: boolean }).preserve === true;
    if (binding.resource && binding.status !== "cleaned") {
      if (preserve) {
        await deps.runtime.stop(binding.resource, "pipeline needs a human decision; the workspace is preserved");
        deps.store.setRuntimeResourceStatus(instance.id, "stopped");
      } else {
        await deps.runtime.cleanup(binding.resource);
        deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
      }
    }
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (!preserve && ticket?.linear_session_id === instance.linear_session_id &&
        (!binding.resource || ticket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.linear_issue_id, null);
    }
  };

  const handleIdleEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<RuntimeEffectHandlerResult> => {
    const control = parseIdleEffectControl(effect);
    if (!binding.resource || binding.status !== "active" || !isCurrentIdleWait(instance.id, control)) return "acknowledge";
    try {
      await deps.runtime.setIdle(binding.resource.providerResourceId);
    } catch (error) {
      console.error("[pipeline-effects] failed to idle sandbox:",
        sanitizeText(String(error)).slice(-500));
      return idleAcknowledgementResult(effect.id);
    }
    if (!isCurrentIdleWait(instance.id, control) &&
        deps.store.getRuntimeResource(instance.id)?.status === "active") {
      try {
        await deps.runtime.setActive(binding.resource.providerResourceId);
      } catch (error) {
        console.error("[pipeline-effects] failed to restore active sandbox:",
          sanitizeText(String(error)).slice(-500));
      }
    }
    return idleAcknowledgementResult(effect.id);
  };

  const runtimeHandlers: Partial<Record<PipelineEffectIntent["kind"], (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ) => Promise<RuntimeEffectHandlerResult>>> = {
    idle: handleIdleEffect,
    stop: async (...args) => {
      await handleStopEffect(...args);
      return "acknowledge";
    },
    quarantine: async (...args) => {
      await handleQuarantineEffect(...args);
      return "acknowledge";
    },
    cleanup: async (...args) => {
      await handleCleanupEffect(...args);
      return "acknowledge";
    },
  };

  const handle = async (effect: PipelineEffectIntent): Promise<void> => {
    const instance = deps.store.getInstance(effect.pipeline_instance_id);
    if (!instance) throw new Error(`pipeline effect ${effect.id} has no instance`);
    const eventId = `effect-ack-${effect.id}`;
    if (effect.kind === "provision" || effect.kind === "dispatch_stage") {
      await handleStageDispatchEffect(effect, instance, eventId);
      return;
    }
    const handler = runtimeHandlers[effect.kind];
    if (!handler) throw new Error(`pipeline effect kind ${effect.kind} has no runtime handler`);
    const binding = runtimeBindingFor(instance);
    const result = await handler(effect, instance, binding);
    if (result === "skip_acknowledgement") return;
    acknowledgeEffect(effect, eventId, {
      providerResourceId: binding.resource?.providerResourceId ?? null,
      confirmed: true,
    });
  };

  const enqueueCapacityWaitActivity = (effect: PipelineEffectIntent, message: string): void => {
    try {
      const id = `capacity-wait:${effect.id}`;
      const instance = deps.store.getInstance(effect.pipeline_instance_id);
      if (!instance) return;
      const holding = sanitizeText(message).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      deps.tickets.enqueueLinearOutbox({
        id,
        linearSessionId: instance.linear_session_id,
        issueId: instance.linear_issue_id,
        kind: "activity",
        payload: JSON.stringify({
          type: "activity",
          activity: {
            sessionId: instance.linear_session_id,
            type: "response",
            body: `This run is waiting on sandbox capacity. Daytona is holding it because ${holding || "capacity is not available"}. OpenThrottle will retry automatically.`,
          },
        }),
      });
    } catch (activityError) {
      console.error("[pipeline-effects] failed to enqueue capacity wait activity:",
        sanitizeText(String(activityError)).slice(-500));
    }
  };

  const processClaimed = async (effect: PipelineEffectIntent): Promise<void> => {
    try {
      await handle(effect);
    } catch (error) {
      const message = sanitizeText(String(error)).slice(-2_000);
      const errorClass = classifyEffectError(message);
      // Stop settlement keeps its full retry budget: exhausting it early would
      // reroute live actors into quarantine on the first provider auth blip.
      const exhausted = (errorClass === "auth" && effect.kind !== "stop") ||
        effect.attempts >= MAX_EFFECT_ATTEMPTS;
      const retryAt = exhausted
        ? null
        : errorClass === "capacity"
          ? new Date(now().getTime() + CAPACITY_RETRY_MS).toISOString()
          : new Date(now().getTime() + RETRY_BASE_MS * 2 ** Math.min(effect.attempts - 1, 6)).toISOString();
      if (!exhausted && errorClass === "capacity") enqueueCapacityWaitActivity(effect, message);
      if (exhausted && (effect.kind === "provision" || effect.kind === "dispatch_stage")) {
        const instance = deps.store.getInstance(effect.pipeline_instance_id);
        const attempt = instance ? deps.store.getActiveAttempt(instance.id) : undefined;
        if (instance && attempt) {
          const payload = canonicalJson({
            schema: "openthrottle.pipeline-effect-failure/v1",
            effect_id: effect.id,
            effect_kind: effect.kind,
            error: message,
          });
          coordinatePipelineEvent(deps.store, {
            id: `pipeline-effect-exhausted:${effect.id}`,
            kind: "effect_failed",
            instanceId: instance.id,
            generation: instance.generation,
            ...(attempt.run_id ? { runId: attempt.run_id } : {}),
            stageId: attempt.stage_id,
            attemptId: attempt.id,
            requestHash: attempt.request_hash,
            outcome: "retryable_infrastructure_failure",
            resultHash: digestNormalized(payload),
            subject: attempt.expected_subject ?? instance.immutable_subject,
            nativeSessionId: attempt.native_session_id,
            exhaustedEffectId: effect.id,
            exhaustedEffectError: message,
          });
          return;
        }
      }
      if (exhausted && effect.kind === "stop") {
        const instance = deps.store.getInstance(effect.pipeline_instance_id);
        const ticket = instance ? deps.tickets.getByIssueId(instance.linear_issue_id) : undefined;
        let control: StopEffectControl;
        try {
          control = parseStopEffectControl(effect);
        } catch {
          // Deterministically malformed durable intents must still leave the
          // processing state on their final attempt. Recover only the current
          // ticket candidate, which is independently fenced below.
          control = { runId: undefined, ticketState: undefined };
        }
        let runId = instance
          ? resolveStopRunId(effect, instance, ticket, control, false)
          : null;
        const owner = `pipeline-stop:${effect.id}`;
        if (runId && !deps.tickets.claimRunForReaping(runId, owner, "pipeline stop exhausted")) {
          runId = null;
        }
        deps.store.markStopEffectExhausted({
          effectId: effect.id,
          error: message,
          runId,
          owner,
        });
        return;
      }
      deps.store.markEffectFailed(effect.id, message, retryAt);
    }
  };

  return {
    async drain() {
      if (draining) return;
      draining = true;
      try {
        const current = now();
        const effects = deps.store.claimEffects(
          current.toISOString(),
          new Date(current.getTime() + EFFECT_LEASE_MS).toISOString()
        );
        await Promise.all(effects.map(processClaimed));
      } finally {
        draining = false;
      }
    },
  };
}
