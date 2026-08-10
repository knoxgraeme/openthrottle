import {
  EXECUTION_PLAN_SCHEMA,
  digestCanonicalJson,
  parseExecutionPlanContract,
  parseStandardReceipt,
  RECEIPT_SCHEMA,
  type CandidateEvidenceReceipt,
  type CommandResultReceipt,
  type ExecutionPlanContract,
  type IntegrationEvidenceReceipt,
  type RatchetDecision,
  type RatchetDifferentialInput,
  type SemanticReviewReceipt,
  type StandardReceipt,
  type UnitCompletionReceipt,
  type UnitDecisionReceipt,
} from "@openthrottle/contracts";
import {
  canonicalJson,
  digestNormalized,
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
  MAX_LOOP_REQUEST_ENVELOPE_BYTES,
  loopActionPlanContext,
  loopActionTransitionContext,
} from "../pipeline/structured-loop-envelope.js";
import {
  MAX_PRIOR_EVIDENCE_BYTES,
  MAX_PRIOR_EVIDENCE_RECEIPTS,
} from "../pipeline/structured-loop-limits.js";
import {
  assertStandardReceiptFence,
  assertCandidateEvidenceFence,
  evaluateFinalReviewGate,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type ExpectedReceiptProducer,
  type IntegrationRatchetEvidence,
  type ReceiptProducerRole,
  type StandardReceiptFence,
} from "../pipeline/execution-gates.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type { ExecutionGateReceipt, ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ChildExecutorActionRequest, LoopActionRequest, RuntimeResource, SandboxRuntime } from "../runtime/contracts.js";
import { extractJsonBlocks } from "../pipeline/markdown.js";
import { sanitizeText } from "../shared/sanitize.js";
import { createUnitEffectProcessor } from "./unit-effects.js";

const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const GIT_SHA1_SUBJECT = /^[a-f0-9]{40}$/;
// Head slice for a non-success diagnostic stored as lastError -- fits inside
// the 2,000-char budget the store applies (unit-store.ts) with room to spare.
const DIAGNOSTIC_TEXT_HEAD_CHARS = 1_500;
const INTEGRATION_RATCHET_INPUT_SCHEMA = "openthrottle.integration-ratchet-input/v1";
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseIntegrationRatchetEvidence(receipt: IntegrationEvidenceReceipt): IntegrationRatchetEvidence | null {
  for (const entry of receipt.evidence) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry) as unknown;
    } catch {
      continue;
    }
    const input = recordValue(parsed);
    if (!input || input.schema !== INTEGRATION_RATCHET_INPUT_SCHEMA) continue;
    const citationGate = recordValue(input.citation_gate);
    const differentialRatchet = recordValue(input.differential_ratchet);
    if (!citationGate || !differentialRatchet) return null;
    return {
      citationGate: {
        hash: citationGate.hash as string,
        proposalHash: citationGate.proposal_hash as string,
        gradeHash: citationGate.grade_hash as string,
        result: citationGate.result as IntegrationRatchetEvidence["citationGate"]["result"],
        outcome: citationGate.outcome as IntegrationRatchetEvidence["citationGate"]["outcome"],
        reason: citationGate.reason as string,
        sourceDigests: citationGate.source_digests as string[],
      },
      differentialRatchet: {
        input: differentialRatchet.input as RatchetDifferentialInput,
        decision: differentialRatchet.decision as RatchetDecision,
      },
    };
  }
  return null;
}

function integrationRatchetPayload(action: ExecutionWorkAttempt): ChildExecutorActionRequest["integrationRatchet"] | undefined {
  if (action.action_kind !== "integrate") return undefined;
  const payload = recordValue(JSON.parse(action.payload) as unknown);
  const ratchet = payload?.integration_ratchet ?? payload?.integrationRatchet;
  const input = recordValue(ratchet);
  if (!input || input.schema !== INTEGRATION_RATCHET_INPUT_SCHEMA) return undefined;
  return input as ChildExecutorActionRequest["integrationRatchet"];
}

type StructuredChildRuntimeDeps = {
  store: PipelineStore & ExecutionUnitStore;
  runtime: SandboxRuntime;
  taskTimeoutSeconds: number;
  now: () => Date;
  completeParentStage?: (event: PipelineCoordinatorEvent) => PipelineInstance;
  // Persists a Codex OAuth blob rotated inside one action's own scoped
  // CODEX_HOME (see readCodexAuthSnapshot in execute-loop.mjs). Keyed to the
  // action that actually ran as a Codex worker -- never to the parent
  // ticket's engine -- and only ever invoked with the exact-fenced result of
  // that action's own sealed request (see collectChildAction). Best-effort:
  // malformed/stale/unchanged blobs are rejected by the callee.
  captureCodexAuth?: (blob: string) => void;
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
  if (/\bretryable_infrastructure_failure\b/i.test(stopReason ?? "")) {
    return "retryable_infrastructure_failure";
  }
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

function extractExecutionPlan(context: string): ExecutionPlanContract {
  const blocks = extractJsonBlocks(context, EXECUTION_PLAN_SCHEMA);
  if (blocks.length !== 1) {
    throw new Error(`structured composite stage requires exactly one ${EXECUTION_PLAN_SCHEMA} block`);
  }
  return parseExecutionPlanContract(blocks[0]!, { source: "sealed.execution_plan" }).value;
}

function configuredCommandNamesFor(instance: PipelineInstance, store: PipelineStore): Set<string> {
  const snapshot = store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
  if (!snapshot || snapshot.digest !== instance.repository_config_digest) {
    throw new Error(`pipeline instance ${instance.id} lost its sealed repository config`);
  }
  const config = JSON.parse(snapshot.normalized_config) as { commands?: Record<string, unknown> };
  return new Set(Object.keys(config.commands ?? {}));
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
  plan: ExecutionPlanContract;
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
  const requestHash = digestCanonicalJson(normalized);
  return {
    ...normalized,
    requestHash,
    idempotencyKey: `loop:${request.attemptId}:${request.actionId}:${requestHash}`,
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

function worktreeIdempotencyKey(action: ExecutionWorkAttempt): string {
  return `worktree:${action.parent_attempt_id}:${action.unit_id ?? "final"}:${action.cycle}`;
}

function worktreeHandleFor(action: ExecutionWorkAttempt, baseCommit: string): { id: string } {
  return {
    id: digestCanonicalJson({
      idempotencyKey: worktreeIdempotencyKey(action),
      attemptId: action.parent_attempt_id,
      baseCommit,
    }).slice(0, 32),
  };
}

function compareAttemptOrder(left: ExecutionWorkAttempt, right: ExecutionWorkAttempt): number {
  return ACTION_OUTPUT_ORDER[left.action_kind] - ACTION_OUTPUT_ORDER[right.action_kind] ||
    left.attempt_ordinal - right.attempt_ordinal ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);
}

function parentTaskContextFor(store: PipelineStore, parentAttemptId: string): string {
  const attempt = store.getAttempt(parentAttemptId);
  if (!attempt?.request_payload) return "";
  const payload = JSON.parse(attempt.request_payload) as { taskContext?: unknown };
  return typeof payload.taskContext === "string" ? payload.taskContext : "";
}

function assertLoopRequestEnvelopeBound(request: LoopActionRequest): void {
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_LOOP_REQUEST_ENVELOPE_BYTES) {
    throw new Error("sealed loop action request exceeds 262144 bytes");
  }
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

export function createStructuredChildRuntime(deps: StructuredChildRuntimeDeps): StructuredChildRuntime {
  const completeParentStage = deps.completeParentStage ?? ((event: PipelineCoordinatorEvent) =>
    coordinatePipelineEvent(deps.store, event));

  const worktreeBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
    const base = graph?.integration_subject ?? instance.immutable_subject ?? instance.base_commit;
    if (!GIT_SUBJECT.test(base)) throw new Error(`child action ${action.id} has no exact worktree base`);
    return base;
  };

  const receiptBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    if (action.action_kind !== "final_review") return worktreeBaseFor(instance, action);
    if (action.request_payload) {
      try {
        const request = JSON.parse(action.request_payload) as { protocol?: unknown; baseSubject?: unknown };
        if (request.protocol === "loop-action@2" &&
            typeof request.baseSubject === "string" &&
            GIT_SUBJECT.test(request.baseSubject)) {
          return request.baseSubject;
        }
      } catch {
        // The request-hash fence still rejects incompatible legacy receipts.
      }
    }
    return instance.base_commit;
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

  const verifiedAggregateTreeSubject = (input: {
    parentAttemptId: string;
    integrationSubject: string;
    attempts: readonly ExecutionWorkAttempt[];
    gates: readonly ExecutionGateReceipt[];
  }): string => {
    const accepted = input.gates.filter((gate) =>
      gate.gate_kind === "integration" &&
      gate.outcome === "success" &&
      gate.result === "passed" &&
      gate.subject === input.integrationSubject
    );
    if (accepted.length === 0) {
      throw new Error(`structured aggregate ${input.parentAttemptId} requires an accepted integration gate for the integrated commit`);
    }
    const trees = new Set<string>();
    for (const gate of accepted) {
      if (digestNormalized(gate.payload) !== gate.receipt_hash) {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration gate hash mismatch`);
      }
      const attempt = input.attempts.find((entry) => entry.id === gate.execution_work_attempt_id);
      if (!attempt || attempt.action_kind !== "integrate" || attempt.status !== "completed" || !attempt.receipt) {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration receipt is missing`);
      }
      if (!attempt.receipt_hash || digestNormalized(attempt.receipt) !== attempt.receipt_hash) {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration receipt hash mismatch`);
      }
      const gateArtifactHashes = JSON.parse(gate.artifact_hashes) as unknown;
      if (!Array.isArray(gateArtifactHashes) || !gateArtifactHashes.includes(attempt.receipt_hash)) {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration gate does not seal the receipt`);
      }
      if (attempt.output_subject !== input.integrationSubject) {
        throw new Error(`structured aggregate ${input.parentAttemptId} integration action subject disagrees with graph subject`);
      }
      const receipt = parseStandardReceipt(attempt.receipt, { source: `child_action.${attempt.id}.receipt` }).value;
      if (receipt.type !== "integration_evidence" || receipt.assurance !== "executor_verified") {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration receipt is not executor verified`);
      }
      if (
        receipt.result !== "success" ||
        receipt.subject.post !== input.integrationSubject ||
        receipt.payload.clean !== true ||
        !GIT_SUBJECT.test(receipt.payload.tree)
      ) {
        throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration receipt does not seal a clean tree`);
      }
      trees.add(receipt.payload.tree);
    }
    if (trees.size !== 1) {
      throw new Error(`structured aggregate ${input.parentAttemptId} accepted integration receipts disagree on the tree subject`);
    }
    return [...trees][0]!;
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

  // The lead decision that routed this unit back to `repair` (see
  // routeUnitAcceptanceDecision / unit-store.ts): the store bumps
  // current_cycle when it routes to repair, so the triggering lead ran one
  // cycle earlier than the repair action it produced.
  const triggeringLeadDecisionAttemptReceipt = (
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    unitId: string,
    triggeringCycle: number
  ): { attempt: ExecutionWorkAttempt; receipt: UnitDecisionReceipt } => {
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const entry = receipts[index]!;
      if (
        entry.receipt.type === "unit_decision" &&
        entry.attempt.action_kind === "lead" &&
        entry.attempt.unit_id === unitId &&
        entry.attempt.cycle === triggeringCycle
      ) {
        return { attempt: entry.attempt, receipt: entry.receipt as UnitDecisionReceipt };
      }
    }
    throw new Error(`missing triggering lead unit_decision receipt for ${unitId} cycle ${triggeringCycle}`);
  };

  // The most recent final_repair action's own unit_completion receipt for
  // this cycle, when a repair round ran between the prior final_review and
  // this one -- prior evidence for anti-churn (Q3), not required.
  const priorFinalRepairCompletionAttemptReceipt = (
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[],
    cycle: number
  ): { attempt: ExecutionWorkAttempt; receipt: UnitCompletionReceipt } | undefined => {
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const entry = receipts[index]!;
      if (
        entry.receipt.type === "unit_completion" &&
        entry.attempt.action_kind === "final_repair" &&
        entry.attempt.cycle === cycle
      ) {
        return { attempt: entry.attempt, receipt: entry.receipt as UnitCompletionReceipt };
      }
    }
    return undefined;
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

  const priorReceiptEntry = (
    role: "completion" | "candidate" | "command" | "final_command" | "final_review" | "lead" | "final_repair",
    entry: { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }
  ): NonNullable<LoopActionRequest["priorEvidence"]>["receipts"][number] => {
    const receipt = canonicalJson(entry.receipt);
    return {
      role,
      actionAttemptId: entry.attempt.id,
      receiptHash: digestNormalized(receipt),
      receipt,
    };
  };

  const assertPriorEvidenceEnvelopeBound = (
    evidence: NonNullable<LoopActionRequest["priorEvidence"]>,
    action: ExecutionWorkAttempt
  ): void => {
    if (evidence.receipts.length > MAX_PRIOR_EVIDENCE_RECEIPTS) {
      throw new Error(`child action ${action.id} prior evidence has too many receipts`);
    }
    if (Buffer.byteLength(canonicalJson(evidence), "utf8") > MAX_PRIOR_EVIDENCE_BYTES) {
      throw new Error(`child action ${action.id} prior evidence exceeds aggregate bound`);
    }
  };

  const priorEvidenceForAction = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts: readonly { attempt: ExecutionWorkAttempt; receipt: StandardReceipt }[]
  ): LoopActionRequest["priorEvidence"] | undefined => {
    if (action.action_kind === "lead") {
      let completion: { attempt: ExecutionWorkAttempt; receipt: UnitCompletionReceipt };
      let candidate: { attempt: ExecutionWorkAttempt; receipt: CandidateEvidenceReceipt };
      try {
        completion = unitCompletionAttemptReceipt(receipts, action.unit_id, action.cycle);
        candidate = latestAttemptReceipt<CandidateEvidenceReceipt>(receipts, "candidate_evidence", action.unit_id, action.cycle);
      } catch {
        return undefined;
      }
      const commands = commandAttemptReceipts(receipts, action.unit_id, action.cycle);
      const evidence = {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "lead",
        receipts: [
          priorReceiptEntry("completion", completion),
          priorReceiptEntry("candidate", candidate),
          ...commands.map((command) => priorReceiptEntry("command", command)),
        ],
      } satisfies NonNullable<LoopActionRequest["priorEvidence"]>;
      assertPriorEvidenceEnvelopeBound(evidence, action);
      return evidence;
    }
    if (action.action_kind === "repair") {
      if (action.unit_id === null) throw new Error(`child repair action ${action.id} has no unit id`);
      // The store bumps current_cycle in the same transaction that routes a
      // lead's non-accept decision to repair (unit-store.ts insertGateReceipt),
      // so the triggering lead ran at this repair's cycle minus one.
      const lead = triggeringLeadDecisionAttemptReceipt(receipts, action.unit_id, action.cycle - 1);
      if (lead.attempt.request_hash !== lead.receipt.fence.request_hash) {
        throw new Error(`child repair action ${action.id} triggering lead fence is invalid`);
      }
      const commands = commandAttemptReceipts(receipts, action.unit_id, action.cycle - 1);
      const evidence = {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "repair",
        receipts: [
          priorReceiptEntry("lead", lead),
          ...commands.map((command) => priorReceiptEntry("command", command)),
        ],
      } satisfies NonNullable<LoopActionRequest["priorEvidence"]>;
      assertPriorEvidenceEnvelopeBound(evidence, action);
      return evidence;
    }
    if (action.action_kind === "final_review") {
      const commands = commandAttemptReceipts(receipts, null, action.cycle);
      // Anti-churn (Q3): a re-review round can also see the previous round's
      // findings and, when one ran, the intervening final_repair's own
      // completion -- both settled at this review's cycle minus one, since
      // the final-phase cycle only bumps after the repair/candidate/integrate
      // sequence finishes and the next round's final_command begins.
      const priorReview = action.cycle > 0
        ? (() => {
            try {
              return latestAttemptReceipt<SemanticReviewReceipt>(receipts, "semantic_review", null, action.cycle - 1);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const priorRepair = priorReview ? priorFinalRepairCompletionAttemptReceipt(receipts, action.cycle - 1) : undefined;
      const evidence = {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "final_review",
        receipts: [
          ...commands.map((command) => priorReceiptEntry("final_command", command)),
          ...(priorReview ? [priorReceiptEntry("final_review", priorReview)] : []),
          ...(priorRepair ? [priorReceiptEntry("final_repair", priorRepair)] : []),
        ],
      } satisfies NonNullable<LoopActionRequest["priorEvidence"]>;
      assertPriorEvidenceEnvelopeBound(evidence, action);
      return evidence;
    }
    if (action.action_kind === "final_repair") {
      let review: { attempt: ExecutionWorkAttempt; receipt: SemanticReviewReceipt };
      try {
        review = latestAttemptReceipt<SemanticReviewReceipt>(receipts, "semantic_review", null, action.cycle);
      } catch {
        throw new Error(`child final repair action ${action.id} has no triggering final-review receipt`);
      }
      if (review.attempt.action_kind !== "final_review" || review.attempt.request_hash !== review.receipt.fence.request_hash) {
        throw new Error(`child final repair action ${action.id} triggering final-review fence is invalid`);
      }
      const expectedSubject = actionInputSubjectFor(instance, review.attempt);
      if (review.receipt.subject.post !== expectedSubject) {
        throw new Error(`child final repair action ${action.id} triggering final-review subject is stale`);
      }
      const evidence = {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "final_repair",
        receipts: [priorReceiptEntry("final_review", review)],
      } satisfies NonNullable<LoopActionRequest["priorEvidence"]>;
      assertPriorEvidenceEnvelopeBound(evidence, action);
      return evidence;
    }
    return undefined;
  };

  const dispatchChildAction = async (
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): Promise<{ requestHash: string; nativeSessionId?: string | null }> => {
    if (isChildExecutorActionKind(action.action_kind)) {
      if (action.request_payload && action.request_hash) {
        const replayRequest = JSON.parse(action.request_payload) as ChildExecutorActionRequest;
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
        ...(integrationRatchetPayload(action) ? { integrationRatchet: integrationRatchetPayload(action) } : {}),
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
    const loopRequest = buildLoopActionRequest({
      protocol: "loop-action@2",
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
      agent: workerBinding.worker.agent && workerBinding.worker.agent !== "inherit"
        ? workerBinding.worker.agent
        : instance.agent,
      ...(workerBinding.worker.model === undefined ? {} : { model: workerBinding.worker.model }),
      skill: workerBinding.repositorySkill?.invocation ?? adapterSkillFor(action.action_kind),
      worktree,
      baseSubject: action.action_kind === "final_review" ? instance.base_commit : worktreeBaseFor(instance, action),
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
        }),
        actionKind: action.action_kind,
        unitId: action.unit_id,
      }),
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
  } | {
    terminal: true;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
  } | null> => {
    if (!action.request_hash) return null;
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
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500);
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
    // Captured regardless of the action's eventual semantic outcome (success,
    // failure, or needs_human): a Codex worker that rotated its refresh token
    // and then failed a lead/review gate still spent the old token, so the
    // rotation must not be lost. Only ever set when this exact action (fenced
    // by attempt/action/request hash in parseCollectedLoopResult) ran as a
    // Codex worker; a Claude or OpenCode action never carries this field.
    if ("codexAuthJson" in result && typeof result.codexAuthJson === "string" && result.codexAuthJson) {
      deps.captureCodexAuth?.(result.codexAuthJson);
    }
    const nativeSessionId: string | null = "nativeSessionId" in result
      ? (result as { nativeSessionId: string | null }).nativeSessionId
      : null;
    const collected = (
      outputSubject: string,
      receipt: StandardReceipt,
      decision?: ReturnType<typeof evaluateUnitAcceptanceGate>
    ) => ({
      resultHash: digestCanonicalJson(result),
      outputSubject,
      receipt: canonicalJson(receipt),
      nativeSessionId,
      ...(decision ? { decision } : {}),
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
    const receiptIsDiagnosticText = isChildExecutorActionKind(action.action_kind)
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
        resultHash: digestCanonicalJson(result),
        outcome,
        lastError: `${result.outcome}: ${sanitizeText(result.receipt).slice(0, DIAGNOSTIC_TEXT_HEAD_CHARS)}`,
        nativeSessionId,
      };
    }
    let receipt: StandardReceipt;
    try {
      receipt = parseStandardReceipt(result.receipt, { source: `child_action.${action.id}.receipt` }).value;
    } catch (error) {
      return {
        terminal: true,
        resultHash: digestCanonicalJson(result),
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
          ratchet: parseIntegrationRatchetEvidence(receipt as IntegrationEvidenceReceipt),
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
        resultHash: digestCanonicalJson(result),
        outcome: "failure",
        lastError: `child action ${action.id} returned invalid ${result.outcome} receipt: ${
          sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)
        }`,
        nativeSessionId,
      };
    }
  };

  return {
    seedCompositeGraph(instance, request) {
      const stage = stageById(instance.normalized_manifest, instance.active_stage_id);
      if (!stage || stage.executor.capability !== FOR_EACH_UNIT_CAPABILITY) {
        throw new Error(`pipeline composite stage ${request.stageId} is not active`);
      }
      const plan = extractExecutionPlan(request.taskContext);
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
        units: commandPlan.units,
        commandNames: commandPlan.graphCommandNames,
        unitPhases: stage.unitPhases,
        unitPhaseBindings: stage.unitPhaseBindings,
        maxRepairRounds: authoredUnitRepairMaxRounds(stage.unitPhaseBindings),
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
      const units = deps.store.listUnits(parentAttemptId);
      const attempts = deps.store.listWorkAttempts(parentAttemptId);
      const gates = deps.store.listGateReceipts(parentAttemptId);
      const outcome = graph.stopped_at
        ? stoppedAggregateOutcome(graph.stop_reason, attempts)
        : aggregateOutcomeFor(units, gates);
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
