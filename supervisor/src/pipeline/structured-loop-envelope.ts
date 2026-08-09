import type { ExecutionPlanContract } from "@openthrottle/contracts";
import { digestCanonicalJson, digestNormalized } from "@openthrottle/contracts";
import { canonicalJson } from "./manifest.js";
import type {
  PipelineUnitAgentPhaseBinding,
  RepositorySkillPackage,
  ValidatedPipelineManifest,
} from "./manifest.js";
import {
  MAX_DOWNSTREAM_CONTEXT_BYTES,
  MAX_DOWNSTREAM_CONTEXT_RECORDS,
  MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES,
  MAX_LOOP_REQUEST_ENVELOPE_BYTES,
  MAX_PRIOR_EVIDENCE_BYTES,
} from "./structured-loop-limits.js";
import type { UnitActionKind } from "./unit-coordinator.js";

export { MAX_LOOP_REQUEST_ENVELOPE_BYTES } from "./structured-loop-limits.js";

const MAX_NATIVE_SESSION_ID = "n" + "s".repeat(199);

type LoopActionPlanContextInput = {
  plan: ExecutionPlanContract | null;
  actionKind: UnitActionKind;
  unitId: string | null;
};

const FINAL_REVIEW_PLAN_CONTEXT_LIMIT_BYTES = 48 * 1024;

function boundedText(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function finalReviewPlanContext(plan: ExecutionPlanContract, actionKind: UnitActionKind): Record<string, unknown> {
  const instructionIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  for (const unit of plan.units) {
    for (const id of unit.instructions) instructionIds.add(id);
    for (const id of unit.acceptance) acceptanceIds.add(id);
  }
  const context = {
    schema: "openthrottle.loop-action-plan-context/v1",
    graph_id: plan.graph_id,
    plan_id: plan.plan_id,
    action_kind: actionKind,
    unit: null,
    whole_plan: true,
    units: plan.units.map((unit) => ({
      id: unit.id,
      title: boundedText(unit.title, 240),
      depends_on: unit.depends_on,
      instructions: unit.instructions,
      acceptance: unit.acceptance,
    })),
    instructions: Object.fromEntries([...instructionIds].map((id) => [id, boundedText(plan.instructions[id], 1_000)])),
    acceptance: Object.fromEntries([...acceptanceIds].map((id) => [id, boundedText(plan.acceptance[id], 1_000)])),
    commands: plan.commands,
  };
  if (Buffer.byteLength(canonicalJson(context), "utf8") <= FINAL_REVIEW_PLAN_CONTEXT_LIMIT_BYTES) return context;

  const compact = {
    ...context,
    units: context.units.map((unit) => ({
      ...unit,
      title: boundedText(unit.title, 120),
    })),
    instructions: Object.fromEntries([...instructionIds].map((id) => [id, boundedText(plan.instructions[id], 320)])),
    acceptance: Object.fromEntries([...acceptanceIds].map((id) => [id, boundedText(plan.acceptance[id], 320)])),
  };
  if (Buffer.byteLength(canonicalJson(compact), "utf8") <= FINAL_REVIEW_PLAN_CONTEXT_LIMIT_BYTES) return compact;

  return {
    schema: "openthrottle.loop-action-plan-context/v1",
    graph_id: plan.graph_id,
    plan_id: plan.plan_id,
    action_kind: actionKind,
    unit: null,
    whole_plan: true,
    truncated: true,
    units: plan.units.map((unit) => ({
      id: unit.id,
      title: boundedText(unit.title, 120),
      depends_on: unit.depends_on,
      instructions: unit.instructions,
      acceptance: unit.acceptance,
    })),
    commands: plan.commands.map((command) => ({ name: command.name, unit: command.unit })),
  };
}

export function loopActionPlanContext(input: LoopActionPlanContextInput): Record<string, unknown> | null {
  const plan = input.plan;
  if (!plan) return null;
  if (input.unitId === null && input.actionKind === "final_review") {
    return finalReviewPlanContext(plan, input.actionKind);
  }
  const unit = input.unitId
    ? plan.units.find((unit) => unit.id === input.unitId)
    : undefined;
  return {
    schema: "openthrottle.loop-action-plan-context/v1",
    graph_id: plan.graph_id,
    plan_id: plan.plan_id,
    action_kind: input.actionKind,
    unit: unit ?? null,
    instructions: Object.fromEntries((unit?.instructions ?? []).map((id) => [id, plan.instructions[id]])),
    acceptance: Object.fromEntries((unit?.acceptance ?? []).map((id) => [id, plan.acceptance[id]])),
    commands: input.unitId
      ? plan.commands.filter((command) => command.unit === undefined || command.unit === input.unitId)
      : plan.commands,
  };
}

export function loopActionTransitionContext(input: {
  actionPayload: string;
  planContext: Record<string, unknown> | null;
  actionKind: UnitActionKind;
  unitId: string | null;
}): string {
  return [
    "## Unit Action Context",
    input.actionPayload,
    "",
    "## Execution Plan Context",
    canonicalJson(input.planContext ?? {
      schema: "openthrottle.loop-action-plan-context/v1",
      action_kind: input.actionKind,
      unit_id: input.unitId,
      unavailable: true,
    }),
  ].join("\n");
}

function loopKindFor(actionKind: UnitActionKind): string {
  if (actionKind === "repair" || actionKind === "final_repair") return "repair";
  if (actionKind === "final_review") return "review";
  if (actionKind === "lead") return "lead";
  if (actionKind === "implement" || actionKind === "simplify" || actionKind === "command") return actionKind;
  throw new Error(`child action kind ${actionKind} has no loop kind`);
}

function roleFor(actionKind: UnitActionKind): string {
  if (actionKind === "lead") return "lead";
  if (actionKind === "final_review") return "reviewer";
  return "worker";
}

function skillFor(actionKind: UnitActionKind): string {
  if (actionKind === "implement") return "implement-unit";
  if (actionKind === "repair") return "repair-unit";
  if (actionKind === "simplify") return "simplify-unit";
  if (actionKind === "lead") return "accept-unit";
  if (actionKind === "final_review") return "final-review";
  if (actionKind === "final_repair") return "final-repair";
  throw new Error(`child action kind ${actionKind} does not dispatch as a loop agent`);
}

function actionPayloadProbe(input: {
  unitId: string | null;
  actionKind: UnitActionKind;
}): string {
  const resumesNativeSession = input.actionKind === "repair" ||
    input.actionKind === "simplify" ||
    input.actionKind === "final_repair";
  return canonicalJson({
    parent_attempt_id: "attempt-" + "a".repeat(32),
    parent_run_id: "run-" + "b".repeat(32),
    unit_id: input.unitId,
    action_kind: input.actionKind,
    cycle: 999_999,
    ...(resumesNativeSession ? { resume_native_session_id: MAX_NATIVE_SESSION_ID } : {}),
  });
}

function priorReceiptProbe(input: {
  role: "completion" | "candidate" | "command" | "final_command" | "final_review" | "lead" | "final_repair";
  actionAttemptId: string;
  receiptType: "unit_completion" | "candidate_evidence" | "command_result" | "semantic_review" | "unit_decision";
  subject?: string;
}): {
  role: "completion" | "candidate" | "command" | "final_command" | "final_review" | "lead" | "final_repair";
  actionAttemptId: string;
  receiptHash: string;
  receipt: string;
} {
  const subject = input.subject ?? "2".repeat(40);
  const receipt = canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: input.receiptType,
    assurance: input.receiptType === "command_result" ? "executor_verified" : "semantic_attested",
    result: "success",
    producer: {
      worker_id: "worker-" + "w".repeat(32),
      skill: input.receiptType === "command_result"
        ? "builtin://command@1"
        : input.receiptType === "semantic_review"
          ? "builtin://final-review@1"
          : input.receiptType === "unit_decision"
            ? "builtin://accept-unit@1"
            : "builtin://implement-unit@1",
      capability_digest: "3".repeat(64),
      skill_package_digest: null,
    },
    subject: { base: "1".repeat(40), pre: "1".repeat(40), post: subject },
    fence: {
      pipeline_instance_id: "instance-" + "i".repeat(32),
      graph_digest: "4".repeat(64),
      unit_id: input.role === "final_command" || input.role === "final_review" || input.role === "final_repair"
        ? "__final__"
        : "unit-" + "u".repeat(32),
      attempt_id: "attempt-" + "a".repeat(32),
      parent_run_id: "run-" + "b".repeat(32),
      action_attempt_id: input.actionAttemptId,
      generation: 999_999,
      native_session_id: null,
      request_hash: "5".repeat(64),
    },
    evidence: ["prior evidence"],
    payload: input.receiptType === "command_result"
      ? { command: "test", exit_code: 0, summary: "passed" }
      : input.receiptType === "candidate_evidence"
        ? { tree: subject, diff_digest: "6".repeat(64), changed_paths: [], clean: true }
        : input.receiptType === "semantic_review"
          ? { summary: "review requires repair", findings: [{ severity: "P1", message: "repair required" }] }
          : input.receiptType === "unit_decision"
            ? { rationale: "scope mismatch", revision_request: "repair required", context_updates: [] }
            : {
              summary: "completed",
              assumptions: [],
              decisions: [],
              issues: [],
              verification: [],
              downstream_context: [],
              requested_human_input: [],
            },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
  return {
    role: input.role,
    actionAttemptId: input.actionAttemptId,
    receiptHash: digestNormalized(receipt),
    receipt,
  };
}

type LoopEnvelopeBinding = {
  kind: "agent" | "gate";
  workerId: string;
  workerAgent?: "inherit" | "claude" | "codex" | "opencode";
  workerModel?: string;
  loopSkill: string;
  allowedMcpServers: readonly string[];
  credentialScopes: readonly string[];
  contextPolicy: "fresh" | "resume_required" | "prefer_resume";
  repositorySkill?: RepositorySkillPackage;
};

function builtinLoopEnvelopeBinding(input: {
  kind: LoopEnvelopeBinding["kind"];
  workerId: string;
  loopSkill: string;
  credentialScopes: readonly string[];
  contextPolicy?: LoopEnvelopeBinding["contextPolicy"];
}): LoopEnvelopeBinding {
  return {
    kind: input.kind,
    workerId: input.workerId,
    workerAgent: "inherit",
    loopSkill: input.loopSkill,
    allowedMcpServers: [],
    credentialScopes: input.credentialScopes,
    contextPolicy: input.contextPolicy ?? "fresh",
  };
}

const DEFAULT_LOOP_BINDINGS: Record<"implement" | "simplify" | "lead", LoopEnvelopeBinding> = {
  implement: builtinLoopEnvelopeBinding({
    kind: "agent",
    workerId: "unit-worker",
    loopSkill: "builtin://ce/implement@1",
    credentialScopes: ["model.invoke", "provider.read", "repo.read"],
    contextPolicy: "resume_required",
  }),
  simplify: builtinLoopEnvelopeBinding({
    kind: "agent",
    workerId: "simplify-worker",
    loopSkill: "builtin://ce/simplify@1",
    credentialScopes: ["model.invoke", "repo.read"],
    contextPolicy: "resume_required",
  }),
  lead: builtinLoopEnvelopeBinding({
    kind: "gate",
    workerId: "lead-worker",
    loopSkill: "builtin://accept-unit@1",
    credentialScopes: ["model.invoke", "repo.read"],
  }),
};

const FINAL_REPAIR_ENVELOPE_BINDING = builtinLoopEnvelopeBinding({
  kind: "agent",
  workerId: "final-repair",
  loopSkill: "final-repair",
  credentialScopes: ["model.invoke", "repo.read"],
  contextPolicy: "resume_required",
});

const FINAL_REVIEW_ENVELOPE_BINDING = builtinLoopEnvelopeBinding({
  kind: "gate",
  workerId: "reviewer",
  loopSkill: "final-review",
  credentialScopes: ["model.invoke", "repo.read"],
});

function envelopeBindingForPhase(
  binding: PipelineUnitAgentPhaseBinding,
): LoopEnvelopeBinding {
  return {
    kind: binding.kind,
    workerId: binding.worker.id,
    workerAgent: binding.worker.agent,
    ...(binding.worker.model === undefined ? {} : { workerModel: binding.worker.model }),
    loopSkill: binding.loop.skill,
    allowedMcpServers: binding.worker.allowed_mcp_servers,
    credentialScopes: binding.credentials,
    contextPolicy: binding.context === "none" ? "fresh" : binding.context,
    ...(binding.repositorySkill === undefined ? {} : { repositorySkill: binding.repositorySkill }),
  };
}

function expectedSkillFor(binding: LoopEnvelopeBinding): string {
  if (binding.repositorySkill) return binding.repositorySkill.reference;
  if (binding.loopSkill.startsWith("builtin://")) return binding.loopSkill;
  return `builtin://${binding.loopSkill}@1`;
}

function requestSkillFor(actionKind: UnitActionKind, binding: LoopEnvelopeBinding): string {
  return binding.repositorySkill?.invocation ?? skillFor(actionKind);
}

const DOWNSTREAM_CONTEXT_SCHEMA = "openthrottle.downstream-context/v1";

function downstreamContextPayloadFor(index: number, summaryLength: number): Record<string, unknown> {
  return {
    schema: DOWNSTREAM_CONTEXT_SCHEMA,
    from_unit_id: `upstream-${index.toString(16).padStart(2, "0")}`,
    summary: "x".repeat(Math.max(0, summaryLength)),
  };
}

function downstreamContextRecordFor(index: number, summaryLength: number): {
  fromUnitId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
} {
  const payload = downstreamContextPayloadFor(index, summaryLength);
  return {
    fromUnitId: payload.from_unit_id as string,
    payloadHash: digestCanonicalJson(payload),
    payload,
  };
}

// The longest summary whose payload still canonicalizes within the sandbox's
// per-record cap (`boundedRecordPayload` in sandbox/runner/execute-loop.mjs).
const MAX_DOWNSTREAM_CONTEXT_RECORD_SUMMARY_LENGTH = (() => {
  let length = MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES;
  while (
    length > 0 &&
    Buffer.byteLength(canonicalJson(downstreamContextPayloadFor(0, length)), "utf8") >
      MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES
  ) {
    length -= 1;
  }
  return length;
})();

// The true maximum valid downstream-context aggregate: as many
// per-record-capped records as fit under the shared aggregate byte cap
// (MAX_DOWNSTREAM_CONTEXT_BYTES), with the final record's summary padded to
// consume the exact remaining budget. This reserves the complete canonical
// maximum admission, persistence, and the sandbox boundary all enforce,
// rather than a representative under-sized sample.
export const MAX_VALID_DOWNSTREAM_CONTEXT: Array<{
  fromUnitId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}> = (() => {
  const records: ReturnType<typeof downstreamContextRecordFor>[] = [];
  for (let index = 0; index < MAX_DOWNSTREAM_CONTEXT_RECORDS; index++) {
    let summaryLength = MAX_DOWNSTREAM_CONTEXT_RECORD_SUMMARY_LENGTH;
    let candidate = downstreamContextRecordFor(index, summaryLength);
    let projected = Buffer.byteLength(canonicalJson([...records, candidate]), "utf8");
    if (projected <= MAX_DOWNSTREAM_CONTEXT_BYTES) {
      records.push(candidate);
      continue;
    }
    // This record no longer fits at the per-record cap: shrink it until it
    // exactly consumes the remaining aggregate budget, then stop.
    while (summaryLength > 0 && projected > MAX_DOWNSTREAM_CONTEXT_BYTES) {
      summaryLength -= 1;
      candidate = downstreamContextRecordFor(index, summaryLength);
      projected = Buffer.byteLength(canonicalJson([...records, candidate]), "utf8");
    }
    if (projected <= MAX_DOWNSTREAM_CONTEXT_BYTES) records.push(candidate);
    break;
  }
  return records;
})();

function loopRequestProbe(input: {
  actionKind: UnitActionKind;
  unitId: string | null;
  transitionContext: string;
  binding: LoopEnvelopeBinding;
  selectedAgent: "claude" | "codex" | "opencode";
}): Record<string, unknown> {
  const expectedProducerSkill = expectedSkillFor(input.binding);
  const requestWithoutFence = {
    protocol: "loop-action@2",
    actionId: "execution-work-" + "c".repeat(32),
    attemptId: "attempt-" + "a".repeat(32),
    graphId: "execution-graph-" + "d".repeat(32),
    pipelineInstanceId: "pipeline-instance-" + "e".repeat(32),
    graphDigest: "f".repeat(64),
    parentRunId: "run-" + "b".repeat(32),
    unitId: input.unitId,
    generation: 999_999,
    role: roleFor(input.actionKind),
    loop: loopKindFor(input.actionKind),
    agent: input.binding.workerAgent && input.binding.workerAgent !== "inherit"
      ? input.binding.workerAgent
      : input.selectedAgent,
    ...(input.binding.workerModel === undefined ? {} : { model: input.binding.workerModel }),
    skill: requestSkillFor(input.actionKind, input.binding),
    worktree: roleFor(input.actionKind) === "worker" ? { id: "0".repeat(64) } : null,
    baseSubject: "1".repeat(40),
    inputSubject: "2".repeat(40),
    ...(input.actionKind === "lead" ? { candidateSubject: "5".repeat(40) } : {}),
    nativeSessionId: MAX_NATIVE_SESSION_ID,
    contextPolicy: input.binding.contextPolicy,
    timeoutMs: 86_400_000,
    transitionContext: input.transitionContext,
    allowedMcpServers: input.binding.allowedMcpServers,
    credentialScopes: input.binding.credentialScopes,
    receiptSchema: "openthrottle.receipt/v1",
    expectedProducerSkill,
    expectedProducer: {
      workerId: roleFor(input.actionKind) === "reviewer" ? "reviewer" : input.binding.workerId,
      skill: expectedProducerSkill,
      capabilityDigest: "4".repeat(64),
      skillPackageDigest: input.binding.repositorySkill?.packageDigest ?? null,
      assurance: "semantic_attested",
    },
    ...(input.actionKind === "lead"
      ? {
          priorEvidence: {
            schema: "openthrottle.loop-prior-evidence/v1",
            role: "lead",
            receipts: [
              priorReceiptProbe({
                role: "completion",
                actionAttemptId: "execution-work-" + "a".repeat(32),
                receiptType: "unit_completion",
              }),
              priorReceiptProbe({
                role: "candidate",
                actionAttemptId: "execution-work-" + "b".repeat(32),
                receiptType: "candidate_evidence",
              }),
              ...Array.from({ length: 16 }, (_, index) => ({
                ...priorReceiptProbe({
                  role: "command",
                  actionAttemptId: `execution-work-${index.toString(16).padStart(32, "0")}`,
                  receiptType: "command_result",
                }),
              })),
            ],
          },
        }
      : {}),
    ...(input.actionKind === "repair"
      ? {
          priorEvidence: {
            schema: "openthrottle.loop-prior-evidence/v1",
            role: "repair",
            receipts: [
              priorReceiptProbe({
                role: "lead",
                actionAttemptId: "execution-work-" + "l".repeat(32),
                receiptType: "unit_decision",
              }),
              ...Array.from({ length: 16 }, (_, index) => ({
                ...priorReceiptProbe({
                  role: "command",
                  actionAttemptId: `execution-work-${index.toString(16).padStart(32, "0")}`,
                  receiptType: "command_result",
                }),
              })),
            ],
          },
        }
      : {}),
    ...(input.actionKind === "final_review"
      ? {
          priorEvidence: {
            schema: "openthrottle.loop-prior-evidence/v1",
            role: "final_review",
            receipts: [
              ...Array.from({ length: 16 }, (_, index) => ({
                ...priorReceiptProbe({
                  role: "final_command",
                  actionAttemptId: `execution-work-${index.toString(16).padStart(32, "0")}`,
                  receiptType: "command_result",
                }),
              })),
              // A re-review round's own worst-case bundle: the previous
              // round's review plus its intervening repair completion (Q3).
              priorReceiptProbe({
                role: "final_review",
                actionAttemptId: "execution-work-" + "r".repeat(32),
                receiptType: "semantic_review",
              }),
              priorReceiptProbe({
                role: "final_repair",
                actionAttemptId: "execution-work-" + "p".repeat(32),
                receiptType: "unit_completion",
              }),
            ],
          },
        }
      : {}),
    ...(input.actionKind === "final_repair"
      ? {
          priorEvidence: {
            schema: "openthrottle.loop-prior-evidence/v1",
            role: "final_repair",
            receipts: [priorReceiptProbe({
              role: "final_review",
              actionAttemptId: "execution-work-" + "r".repeat(32),
              receiptType: "semantic_review",
            })],
          },
        }
      : {}),
    ...(input.unitId
      ? {
          downstreamContext: MAX_VALID_DOWNSTREAM_CONTEXT,
        }
      : {}),
    ...(input.binding.repositorySkill === undefined ? {} : { repositorySkill: input.binding.repositorySkill }),
  };
  const requestHash = digestCanonicalJson(requestWithoutFence);
  return {
    ...requestWithoutFence,
    requestHash,
    idempotencyKey: `loop:${requestWithoutFence.attemptId}:${requestWithoutFence.actionId}:${requestHash}`,
  };
}

function withAggregatePriorEvidenceBudget(request: Record<string, unknown>): Record<string, unknown> {
  if (!request.priorEvidence || typeof request.priorEvidence !== "object" || Array.isArray(request.priorEvidence)) {
    return request;
  }
  const priorEvidence = request.priorEvidence as {
    schema: string;
    role: string;
    receipts: Array<{ receipt: string }>;
  };
  if (priorEvidence.receipts.length === 0) return request;
  const evidenceBytes = Buffer.byteLength(canonicalJson(priorEvidence), "utf8");
  if (evidenceBytes >= MAX_PRIOR_EVIDENCE_BYTES) return request;
  const last = priorEvidence.receipts[priorEvidence.receipts.length - 1]!;
  const fillerBytes = MAX_PRIOR_EVIDENCE_BYTES - evidenceBytes;
  const paddedReceipt = `${last.receipt}${"x".repeat(fillerBytes)}`;
  return {
    ...request,
    priorEvidence: {
      ...priorEvidence,
      receipts: [
        ...priorEvidence.receipts.slice(0, -1),
        {
          ...last,
          // This intentionally makes the probe reserve the aggregate transport
          // budget for prior evidence. Runtime validation owns semantic receipt
          // validity; admission sizing must reserve bytes, not revalidate the
          // synthetic probe receipt.
          receiptHash: digestNormalized(paddedReceipt),
          receipt: paddedReceipt,
        },
      ],
    },
  };
}

function loopActionEnvelopeBytes(input: {
  plan: ExecutionPlanContract;
  actionKind: UnitActionKind;
  unitId: string | null;
  binding: LoopEnvelopeBinding;
  selectedAgent: "claude" | "codex" | "opencode";
}): number {
  const actionPayload = actionPayloadProbe({ unitId: input.unitId, actionKind: input.actionKind });
  const transitionContext = loopActionTransitionContext({
    actionPayload,
    planContext: loopActionPlanContext(input),
    actionKind: input.actionKind,
    unitId: input.unitId,
  });
  return Buffer.byteLength(canonicalJson(withAggregatePriorEvidenceBudget(loopRequestProbe({
    actionKind: input.actionKind,
    unitId: input.unitId,
    transitionContext,
    binding: input.binding,
    selectedAgent: input.selectedAgent,
  }))), "utf8");
}

function unitEnvelopeActionsForManifest(input: {
  plan: ExecutionPlanContract;
  manifest?: ValidatedPipelineManifest;
}): Array<{
  actionKind: UnitActionKind;
  unitId: string;
  binding: LoopEnvelopeBinding;
}> {
  const stage = input.manifest?.manifest.stages.find((stage) =>
    stage.executor.kind === "loop_action" &&
    stage.executor.capability === "graph/for-each-unit@1"
  );
  if (!stage?.unitPhaseBindings) {
    return input.plan.units.flatMap((unit) => [
      { actionKind: "implement" as const, unitId: unit.id, binding: DEFAULT_LOOP_BINDINGS.implement },
      { actionKind: "repair" as const, unitId: unit.id, binding: DEFAULT_LOOP_BINDINGS.implement },
      { actionKind: "simplify" as const, unitId: unit.id, binding: DEFAULT_LOOP_BINDINGS.simplify },
      { actionKind: "lead" as const, unitId: unit.id, binding: DEFAULT_LOOP_BINDINGS.lead },
    ]);
  }
  const phaseBindings = new Map(stage.unitPhaseBindings
    .filter((binding): binding is PipelineUnitAgentPhaseBinding => binding.kind === "agent" || binding.kind === "gate")
    .map((binding) => [binding.id, envelopeBindingForPhase(binding)]));
  return input.plan.units.flatMap((unit) => {
    const actions: Array<{ actionKind: UnitActionKind; unitId: string; binding: LoopEnvelopeBinding }> = [];
    const implement = phaseBindings.get("implement");
    if (implement) {
      actions.push({ actionKind: "implement", unitId: unit.id, binding: implement });
      actions.push({ actionKind: "repair", unitId: unit.id, binding: implement });
    }
    const simplify = phaseBindings.get("simplify");
    if (simplify) actions.push({ actionKind: "simplify", unitId: unit.id, binding: simplify });
    const lead = phaseBindings.get("lead");
    if (lead) actions.push({ actionKind: "lead", unitId: unit.id, binding: lead });
    return actions;
  });
}

export function structuredPlanLoopEnvelopeBytes(
  plan: ExecutionPlanContract,
  options: {
    manifest?: ValidatedPipelineManifest;
    selectedAgent?: "claude" | "codex" | "opencode";
  } = {}
): number {
  const selectedAgent = options.selectedAgent ?? "claude";
  const unitActions = unitEnvelopeActionsForManifest({
    plan,
    manifest: options.manifest,
  });
  const graphActions: Array<{ actionKind: UnitActionKind; unitId: null; binding: LoopEnvelopeBinding }> = [
    { actionKind: "final_repair", unitId: null, binding: FINAL_REPAIR_ENVELOPE_BINDING },
    { actionKind: "final_review", unitId: null, binding: FINAL_REVIEW_ENVELOPE_BINDING },
  ];
  return Math.max(
    ...[...unitActions, ...graphActions].map((action) => loopActionEnvelopeBytes({
      plan,
      actionKind: action.actionKind,
      unitId: action.unitId,
      binding: action.binding,
      selectedAgent,
    }))
  );
}

export function assertStructuredPlanLoopEnvelopeBound(
  plan: ExecutionPlanContract,
  options: {
    manifest?: ValidatedPipelineManifest;
    selectedAgent?: "claude" | "codex" | "opencode";
  } = {}
): void {
  const bytes = structuredPlanLoopEnvelopeBytes(plan, options);
  if (bytes > MAX_LOOP_REQUEST_ENVELOPE_BYTES) {
    throw new Error(
      `structured execution plan would seal a ${bytes}-byte child loop request, exceeding ${MAX_LOOP_REQUEST_ENVELOPE_BYTES} bytes. ` +
      "Reduce per-unit instruction, acceptance, or command context before delegation. No sandbox was provisioned."
    );
  }
}
