import {
  canonicalJson,
  digestCanonicalJson,
  digestNormalized,
  deriveReviewSubactionActionId,
  parseStandardReceipt,
  RECEIPT_SCHEMA,
  validateReviewJournalContract,
  type AnyExecutionPlanContract,
  type CommandResultReceipt,
  type ReviewJournalContract,
  type SemanticReviewReceipt,
  type StandardReceipt,
} from "@openthrottle/contracts";
import { reviewFanoutSearchMapsFor, loopActionTransitionContext } from "../pipeline/structured-loop-envelope.js";
import {
  buildReviewFanoutPlan,
  buildReviewSelectorAuthority,
  parseReviewSelectorRecommendation,
  synthesizeReviewFanout,
  validateReviewFanoutBlockers,
  validateReviewFanoutRepair,
  type ReviewFanoutPlan,
  type ReviewFanoutSynthesis,
  type ReviewSelectorAuthority,
} from "../pipeline/review-fanout.js";
import { buildReviewJournal } from "../pipeline/review-journal.js";
import {
  assertStandardReceiptFence,
  evaluateFinalReviewGate,
  type ExpectedReceiptProducer,
  type ReceiptProducerRole,
  type StandardReceiptFence,
} from "../pipeline/execution-gates.js";
import type { PipelineInstance, PipelineStore } from "../pipeline/store.js";
import type {
  ExecutionUnitStore,
  ExecutionWorkAttempt,
  ExecutionWorkPrivateArtifact,
} from "../persistence/pipeline/unit-store.js";
import type {
  LoopActionRequest,
  LoopActionResult,
  RuntimeResource,
  SandboxRuntime,
} from "../runtime/contracts.js";
import { serializeRuntimeObservationError } from "../runtime/observation-error.js";
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

export class RetryableReviewRuntimeError extends Error {
  constructor(operation: string, cause: unknown) {
    const observed = serializeRuntimeObservationError(operation, cause);
    // Provider wrappers do not always preserve a transport status when an
    // acknowledgement is lost. This typed boundary is itself the proof that
    // an unknown exception came from provider I/O, so make that retryability
    // explicit for the durable outer observation budget.
    super(observed.text.replace(/\bretryable=false\b/, "retryable=true"));
    this.name = "RetryableReviewRuntimeError";
  }
}

export function fanoutActionId(action: ExecutionWorkAttempt, personaId: string): string {
  return deriveReviewSubactionActionId(action.id, personaId);
}

export function selectorActionId(action: ExecutionWorkAttempt): string {
  return deriveReviewSubactionActionId(action.id, "selector");
}

export function validatorActionId(action: ExecutionWorkAttempt): string {
  return deriveReviewSubactionActionId(action.id, "validator");
}

// Every review subaction receipt is semantically attested by the worker that
// ran it, under the instance's sealed capability digest and no skill package.
function reviewProducer(
  instance: PipelineInstance,
  workerId: string,
  skill: string
): ExpectedReceiptProducer {
  return {
    workerId,
    skill,
    capabilityDigest: instance.capability_digest,
    skillPackageDigest: null,
    assurance: "semantic_attested",
  };
}

function fanoutProducerFor(instance: PipelineInstance, personaId: string): ExpectedReceiptProducer {
  return reviewProducer(instance, personaId, `builtin://${personaId}@1`);
}

export function buildReviewFanoutRequests(input: {
  instance: PipelineInstance;
  action: ExecutionWorkAttempt;
  plan: AnyExecutionPlanContract;
  fanout: ReviewFanoutPlan;
  inputSubject: string;
  baseSubject: string;
  agent: LoopActionRequest["agent"];
  model?: string;
  reasoningEffort?: LoopActionRequest["reasoningEffort"];
  timeoutMs: number;
}): LoopActionRequest[] {
  return input.fanout.personas.map((persona) => buildLoopActionRequest({
    protocol: "loop-action@3",
    actionId: fanoutActionId(input.action, persona.id),
    attemptId: input.action.parent_attempt_id,
    graphId: input.action.execution_graph_id,
    pipelineInstanceId: input.instance.id,
    graphDigest: input.instance.manifest_digest,
    parentRunId: input.action.parent_run_id,
    unitId: input.action.unit_id,
    generation: input.instance.generation,
    role: "reviewer",
    loop: "review",
    agent: input.agent,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    skill: persona.id,
    worktree: null,
    baseSubject: input.baseSubject,
    inputSubject: input.inputSubject,
    nativeSessionId: null,
    contextPolicy: "fresh",
    timeoutMs: input.timeoutMs,
    transitionContext: loopActionTransitionContext({
      actionPayload: canonicalJson({
        parent_attempt_id: input.action.parent_attempt_id,
        parent_run_id: input.action.parent_run_id,
        unit_id: input.action.unit_id,
        action_kind: input.action.action_kind,
        cycle: input.action.cycle,
        review_persona_id: persona.id,
      }),
      planContext: {
        schema: "openthrottle.loop-action-plan-context/v1",
        action_kind: input.action.action_kind,
        graph_id: input.plan.graph_id,
        plan_id: input.plan.plan_id,
        unit: input.action.unit_id ? input.plan.units.find((unit) => unit.id === input.action.unit_id) ?? null : null,
        review_fanout: input.fanout,
        review_persona: persona,
      },
      actionKind: input.action.action_kind,
      unitId: input.action.unit_id,
    }),
    allowedMcpServers: [],
    credentialScopes: ["model.invoke", "repo.read"],
    receiptSchema: RECEIPT_SCHEMA,
    expectedReceiptType: "semantic_review",
    expectedProducerSkill: `builtin://${persona.id}@1`,
    expectedProducer: fanoutProducerFor(input.instance, persona.id),
  }));
}

export function buildReviewSelectorRequest(input: {
  instance: PipelineInstance;
  action: ExecutionWorkAttempt;
  plan: AnyExecutionPlanContract;
  authority: ReviewSelectorAuthority;
  inputSubject: string;
  baseSubject: string;
  agent: LoopActionRequest["agent"];
  model?: string;
  reasoningEffort?: LoopActionRequest["reasoningEffort"];
  timeoutMs: number;
  priorEvidence?: LoopActionRequest["priorEvidence"];
}): LoopActionRequest {
  return buildLoopActionRequest({
    protocol: "loop-action@3",
    actionId: selectorActionId(input.action),
    attemptId: input.action.parent_attempt_id,
    graphId: input.action.execution_graph_id,
    pipelineInstanceId: input.instance.id,
    graphDigest: input.instance.manifest_digest,
    parentRunId: input.action.parent_run_id,
    unitId: input.action.unit_id,
    generation: input.instance.generation,
    role: "reviewer",
    loop: "review",
    agent: input.agent,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    skill: "select-review-personas",
    worktree: null,
    baseSubject: input.baseSubject,
    inputSubject: input.inputSubject,
    nativeSessionId: null,
    contextPolicy: "fresh",
    timeoutMs: input.timeoutMs,
    transitionContext: loopActionTransitionContext({
      actionPayload: canonicalJson({
        parent_attempt_id: input.action.parent_attempt_id,
        parent_run_id: input.action.parent_run_id,
        action_kind: input.action.action_kind,
        cycle: input.action.cycle,
        review_selector: true,
      }),
      planContext: {
        schema: "openthrottle.loop-action-plan-context/v1",
        action_kind: input.action.action_kind,
        graph_id: input.plan.graph_id,
        plan_id: input.plan.plan_id,
        unit: null,
        review_selector_authority: input.authority,
      },
      actionKind: input.action.action_kind,
      unitId: input.action.unit_id,
    }),
    ...(input.priorEvidence ? { priorEvidence: input.priorEvidence } : {}),
    allowedMcpServers: [],
    credentialScopes: ["model.invoke", "repo.read"],
    receiptSchema: RECEIPT_SCHEMA,
    expectedReceiptType: "semantic_review",
    expectedProducerSkill: "builtin://select-review-personas@1",
    expectedProducer: reviewProducer(input.instance, "review-selector", "builtin://select-review-personas@1"),
  });
}

export function buildReviewValidatorRequest(input: {
  instance: PipelineInstance;
  action: ExecutionWorkAttempt;
  plan: AnyExecutionPlanContract;
  fanout: ReviewFanoutPlan;
  synthesis: ReviewFanoutSynthesis;
  inputSubject: string;
  baseSubject: string;
  agent: LoopActionRequest["agent"];
  model?: string;
  reasoningEffort?: LoopActionRequest["reasoningEffort"];
  timeoutMs: number;
}): LoopActionRequest {
  return buildLoopActionRequest({
    protocol: "loop-action@3",
    actionId: validatorActionId(input.action),
    attemptId: input.action.parent_attempt_id,
    graphId: input.action.execution_graph_id,
    pipelineInstanceId: input.instance.id,
    graphDigest: input.instance.manifest_digest,
    parentRunId: input.action.parent_run_id,
    unitId: input.action.unit_id,
    generation: input.instance.generation,
    role: "reviewer",
    loop: "review",
    agent: input.agent,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    skill: "validate-review-findings",
    worktree: null,
    baseSubject: input.baseSubject,
    inputSubject: input.inputSubject,
    nativeSessionId: null,
    contextPolicy: "fresh",
    timeoutMs: input.timeoutMs,
    transitionContext: loopActionTransitionContext({
      actionPayload: canonicalJson({
        parent_attempt_id: input.action.parent_attempt_id,
        parent_run_id: input.action.parent_run_id,
        action_kind: input.action.action_kind,
        cycle: input.action.cycle,
        review_validator: true,
      }),
      planContext: {
        schema: "openthrottle.loop-action-plan-context/v1",
        action_kind: input.action.action_kind,
        graph_id: input.plan.graph_id,
        plan_id: input.plan.plan_id,
        unit: null,
        review_fanout: input.fanout,
        review_synthesis: input.synthesis,
      },
      actionKind: input.action.action_kind,
      unitId: input.action.unit_id,
    }),
    allowedMcpServers: [],
    credentialScopes: ["model.invoke", "repo.read"],
    receiptSchema: RECEIPT_SCHEMA,
    expectedReceiptType: "semantic_review",
    expectedProducerSkill: "builtin://validate-review-findings@1",
    expectedProducer: reviewProducer(input.instance, "review-validator", "builtin://validate-review-findings@1"),
  });
}

export function synthesizeFinalReviewReceipt(input: {
  expected: StandardReceiptFence;
  synthesis: ReviewFanoutSynthesis;
  commandHashes: readonly string[];
  issuedAt: string;
}): SemanticReviewReceipt {
  const producer = input.expected.producers.review;
  const result = input.synthesis.outcome === "needs_human" || input.synthesis.outcome === "failure"
    ? input.synthesis.outcome
    : input.synthesis.outcome === "success"
      ? "success"
      : "semantic_repair_required";
  return {
    schema: RECEIPT_SCHEMA,
    type: "semantic_review",
    assurance: producer.assurance,
    result,
    producer: {
      worker_id: producer.workerId,
      skill: producer.skill,
      capability_digest: producer.capabilityDigest,
      skill_package_digest: producer.skillPackageDigest,
    },
    subject: {
      base: input.expected.baseSubject,
      pre: input.expected.preSubject,
      post: input.expected.subject,
    },
    fence: {
      pipeline_instance_id: input.expected.pipelineInstanceId,
      graph_digest: input.expected.graphDigest,
      unit_id: input.expected.unitId,
      attempt_id: input.expected.attemptId,
      parent_run_id: input.expected.parentRunId,
      action_attempt_id: input.expected.actionAttemptId,
      generation: input.expected.generation,
      native_session_id: input.expected.nativeSessionId,
      request_hash: input.expected.requestHash,
    },
    evidence: [...input.commandHashes, ...input.synthesis.receipt_hashes, digestCanonicalJson(input.synthesis)],
    payload: {
      summary: input.synthesis.summary,
      findings: input.synthesis.findings,
    },
    issued_at: input.issuedAt,
  };
}

// The store surface the orchestrator owns: the sealed per-subaction dispatch
// ledger plus the gate/journal rows the fanout replays from. Narrow on purpose
// so a unit test can stand the orchestrator up without a full pipeline store.
export type ReviewOrchestrationStore =
  & Pick<
    ExecutionUnitStore,
    | "getGraphForAttempt"
    | "listGateReceipts"
    | "getReviewSubactionDispatch"
    | "prepareReviewSubactionDispatch"
    | "markReviewSubactionDispatched"
  >
  & Pick<PipelineStore, "listJournalEntries" | "recordJournalEntry">
  & { prepareActionDispatch?: ExecutionUnitStore["prepareActionDispatch"] };

export type ReviewOrchestrationDeps = {
  store: ReviewOrchestrationStore;
  runtime: Pick<SandboxRuntime, "dispatchLoopAction" | "collectLoopActionResult">;
  now: () => Date;
  // See StructuredChildRuntimeDeps.captureCodexAuth -- the orchestrator only
  // ever forwards the blob of a subaction it fenced itself.
  captureCodexAuth?: (blob: string) => void;
  // Host-owned projections of the sealed parent attempt. They stay with the
  // structured child runtime because non-review actions share them.
  executionPlanFor: (action: ExecutionWorkAttempt) => AnyExecutionPlanContract;
  actionInputSubjectFor: (instance: PipelineInstance, action: ExecutionWorkAttempt) => string;
  expectedProducersFor: (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ) => Record<ReceiptProducerRole, ExpectedReceiptProducer>;
  standardFenceFor: (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    subject: string
  ) => StandardReceiptFence;
  commandAttemptReceiptsFor: (
    action: ExecutionWorkAttempt
  ) => Array<{ attempt: ExecutionWorkAttempt; receipt: CommandResultReceipt }>;
};

// The sealed dispatch/completion window the review journal records per
// subaction. `prepared_fallback` marks a result recovered before this drain
// ever dispatched, so the dispatch instant is the prepared row's own stamp.
type ReviewSubactionTiming = {
  actionId: string;
  dispatchedAt: string;
  dispatchTimeSource: "acknowledged" | "prepared_fallback";
  completedAt: string;
};

type ReviewFanoutReceiptResult = ReviewSubactionTiming & { receipt: SemanticReviewReceipt };

type ReviewSubactionTerminal = {
  terminal: true;
  resultHash: string;
  outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
  lastError: string;
  terminalPayload?: string;
  privateArtifact?: ExecutionWorkPrivateArtifact;
};

export interface ReviewOrchestrator {
  ensureReviewSubactionLaunched(input: {
    resource: RuntimeResource;
    action: ExecutionWorkAttempt;
    request: LoopActionRequest;
    label: string;
  }): Promise<boolean>;
  dispatchFinalReviewSelector(input: {
    resource: RuntimeResource;
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    plan: AnyExecutionPlanContract;
    inputSubject: string;
    agent: LoopActionRequest["agent"];
    model?: string;
    reasoningEffort?: LoopActionRequest["reasoningEffort"];
    timeoutMs: number;
    priorEvidence?: LoopActionRequest["priorEvidence"];
  }): Promise<{ requestHash: string; nativeSessionId: null }>;
  collectOrchestratedFinalReview(
    resource: RuntimeResource,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    selectorRequest: LoopActionRequest
  ): Promise<{
    resultHash: string;
    outputSubject: string;
    receipt: string;
    nativeSessionId: null;
    decision: ReturnType<typeof evaluateFinalReviewGate>;
  } | {
    terminal: true;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId: null;
  } | null>;
}

export function createReviewOrchestrator(deps: ReviewOrchestrationDeps): ReviewOrchestrator {
  const fanoutFenceFor = (input: {
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    request: LoopActionRequest;
    personaId: string;
    subject: string;
    baseSubject: string;
    expectedProducer?: ExpectedReceiptProducer;
  }): StandardReceiptFence => ({
    pipelineInstanceId: input.instance.id,
    graphDigest: input.instance.manifest_digest,
    unitId: input.action.unit_id ?? "__final__",
    attemptId: input.action.parent_attempt_id,
    parentRunId: input.action.parent_run_id,
    actionAttemptId: input.request.actionId,
    generation: input.instance.generation,
    nativeSessionId: null,
    requestHash: input.request.requestHash,
    baseSubject: input.baseSubject,
    preSubject: input.subject,
    subject: input.subject,
    producers: {
      ...deps.expectedProducersFor(input.instance, input.action),
      review: input.expectedProducer ?? fanoutProducerFor(input.instance, input.personaId),
    },
  });

  const reviewRuntimeCall = async <T>(operation: string, execute: () => Promise<T>): Promise<T> => {
    try {
      return await execute();
    } catch (error) {
      const observed = serializeRuntimeObservationError(operation, error);
      // A known non-retryable provider response (notably 400/401/403) is a
      // deterministic terminal. Statusless provider exceptions remain
      // uncertain and must consume the bounded observation retry budget.
      if (!observed.retryable && observed.statusCode !== null) throw new Error(observed.text);
      throw new RetryableReviewRuntimeError(operation, error);
    }
  };

  const captureLatestReviewCodexAuth = (
    results: ReadonlyArray<{ request: LoopActionRequest; result: LoopActionResult | null }>
  ): void => {
    const latest = results
      .filter((entry): entry is { request: LoopActionRequest; result: LoopActionResult & { codexAuthJson: string } } =>
        typeof entry.result?.codexAuthJson === "string" && entry.result.codexAuthJson.length > 0)
      .sort((left, right) =>
        left.result.completedAt.localeCompare(right.result.completedAt) ||
        left.request.actionId.localeCompare(right.request.actionId))
      .at(-1);
    if (latest) deps.captureCodexAuth?.(latest.result.codexAuthJson);
  };

  const ensureReviewSubactionLaunched = async (input: {
    resource: RuntimeResource;
    action: ExecutionWorkAttempt;
    request: LoopActionRequest;
    label: string;
  }): Promise<boolean> => {
    const persisted = deps.store.getReviewSubactionDispatch(input.action.id, input.request.actionId);
    deps.store.prepareReviewSubactionDispatch({
      parentActionId: input.action.id,
      actionId: input.request.actionId,
      requestHash: input.request.requestHash,
      idempotencyKey: input.request.idempotencyKey,
    });
    if (persisted?.dispatched_at != null) return false;
    await reviewRuntimeCall(
      `${input.label} ${input.request.actionId} dispatch failed`,
      () => deps.runtime.dispatchLoopAction(input.resource, input.request)
    );
    deps.store.markReviewSubactionDispatched(input.action.id, input.request.actionId, "acknowledged");
    return true;
  };

  const prepareReviewSubaction = async (input: {
    resource: RuntimeResource;
    action: ExecutionWorkAttempt;
    request: LoopActionRequest;
    label: string;
  }): Promise<{
    result: LoopActionResult | null;
    newlyDispatched: boolean;
  }> => {
    const persisted = deps.store.getReviewSubactionDispatch(input.action.id, input.request.actionId);
    if (persisted) {
      if (
        persisted.request_hash !== input.request.requestHash ||
        persisted.idempotency_key !== input.request.idempotencyKey
      ) {
        throw new Error(`persisted review subaction ${input.request.actionId} has a different request fence`);
      }
      if (persisted.dispatched_at !== null) return { result: null, newlyDispatched: false };
    }
    const recovered = await reviewRuntimeCall(
      `${input.label} ${input.request.actionId} pre-dispatch collection failed`,
      () => deps.runtime.collectLoopActionResult(input.resource, {
        attemptId: input.request.attemptId,
        actionId: input.request.actionId,
        requestHash: input.request.requestHash,
      })
    );
    if (!persisted) {
      deps.store.prepareReviewSubactionDispatch({
        parentActionId: input.action.id,
        actionId: input.request.actionId,
        requestHash: input.request.requestHash,
        idempotencyKey: input.request.idempotencyKey,
      });
    }
    const newlyDispatched = !recovered;
    if (newlyDispatched) {
      await ensureReviewSubactionLaunched(input);
    } else {
      deps.store.markReviewSubactionDispatched(input.action.id, input.request.actionId, "prepared_fallback");
    }
    return { result: recovered, newlyDispatched };
  };

  const prepareReviewFanout = async (input: {
    resource: RuntimeResource;
    action: ExecutionWorkAttempt;
    requests: readonly LoopActionRequest[];
  }): Promise<Map<string, LoopActionResult>> => {
    const precollected = new Map<string, LoopActionResult>();
    for (const request of input.requests) {
      const prepared = await prepareReviewSubaction({
        resource: input.resource,
        action: input.action,
        request,
        label: "review fanout action",
      });
      let result = prepared.result;
      if (!result && !prepared.newlyDispatched) {
        result = await reviewRuntimeCall(
          `review fanout action ${request.actionId} serialized result collection failed`,
          () => deps.runtime.collectLoopActionResult(input.resource, {
            attemptId: request.attemptId,
            actionId: request.actionId,
            requestHash: request.requestHash,
          })
        );
      }
      if (result) {
        precollected.set(request.actionId, result);
        captureLatestReviewCodexAuth([{ request, result }]);
      }
      if (prepared.newlyDispatched || !result || result.outcome !== "success") {
        break;
      }
    }
    return precollected;
  };

  const collectReviewFanout = async (input: {
    resource: RuntimeResource;
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    plan: ReviewFanoutPlan;
    requests: readonly LoopActionRequest[];
    baseSubject: string;
    precollected?: ReadonlyMap<string, LoopActionResult>;
  }): Promise<{
    synthesis: ReviewFanoutSynthesis;
    receiptResults: ReviewFanoutReceiptResult[];
  } | {
    pending: true;
  } | ReviewSubactionTerminal> => {
    const receipts: SemanticReviewReceipt[] = [];
    const receiptResults: ReviewFanoutReceiptResult[] = [];
    const collected: Array<{ request: LoopActionRequest; result: LoopActionResult | null }> = [];
    for (const request of input.requests) {
      const result = input.precollected?.get(request.actionId) ?? await reviewRuntimeCall(
        `review fanout action ${request.actionId} result collection failed`,
        () => deps.runtime.collectLoopActionResult(input.resource, {
          attemptId: request.attemptId,
          actionId: request.actionId,
          requestHash: request.requestHash,
        })
      );
      collected.push({ request, result });
    }
    captureLatestReviewCodexAuth(collected);
    for (const { request, result } of collected) {
      if (!result) return { pending: true };
      if (result.outcome !== "success") {
        return {
          terminal: true,
          resultHash: actionResultHash(result),
          outcome: result.outcome === "retryable_infrastructure_failure"
            ? "retryable_infrastructure_failure"
            : result.outcome === "needs_human"
              ? "needs_human"
              : "failure",
          lastError: `${result.outcome}: ${sanitizeText(result.receipt).slice(0, DIAGNOSTIC_TEXT_HEAD_CHARS)}`,
          terminalPayload: terminalPayloadForLoopResult(result),
          privateArtifact: privateArtifactForLoopResult(result),
        };
      }
      let receipt: StandardReceipt;
      try {
        receipt = parseStandardReceipt(result.receipt, { source: `review_fanout.${request.actionId}.receipt` }).value;
      } catch {
        return {
          terminal: true,
          resultHash: actionResultHash(result),
          outcome: "failure",
          lastError: `review fanout action ${request.actionId} returned malformed success receipt`,
        };
      }
      if (receipt.type !== "semantic_review") {
        return {
          terminal: true,
          resultHash: actionResultHash(result),
          outcome: "failure",
          lastError: `review fanout action ${request.actionId} returned ${receipt.type}, expected semantic_review`,
        };
      }
      const personaId = receipt.producer.worker_id;
      try {
        assertStandardReceiptFence({
          expected: fanoutFenceFor({
            instance: input.instance,
            action: input.action,
            request,
            personaId,
            subject: input.plan.subject,
            baseSubject: input.baseSubject,
          }),
          receipt,
          role: "review",
        });
      } catch (error) {
        return {
          terminal: true,
          resultHash: actionResultHash(result),
          outcome: "failure",
          lastError: `review fanout action ${request.actionId} returned invalid receipt: ${
            sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)
          }`,
        };
      }
      const dispatch = deps.store.getReviewSubactionDispatch(input.action.id, request.actionId);
      if (!dispatch?.dispatched_at || !dispatch.dispatch_time_source) {
        return {
          terminal: true,
          resultHash: actionResultHash(result),
          outcome: "failure",
          lastError: `review fanout action ${request.actionId} has no persisted dispatch timing`,
        };
      }
      receipts.push(receipt as SemanticReviewReceipt);
      receiptResults.push({
        receipt: receipt as SemanticReviewReceipt,
        actionId: request.actionId,
        dispatchedAt: dispatch.dispatched_at,
        dispatchTimeSource: dispatch.dispatch_time_source,
        completedAt: result.completedAt,
      });
    }
    try {
      return { synthesis: synthesizeReviewFanout({ plan: input.plan, receipts }), receiptResults };
    } catch (error) {
      return {
        terminal: true,
        resultHash: digestCanonicalJson({ plan: input.plan, receipts }),
        outcome: "failure",
        lastError: `review fanout synthesis failed: ${
          sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)
        }`,
      };
    }
  };

  const collectReviewSubaction = async (input: {
    resource: RuntimeResource;
    instance: PipelineInstance;
    action: ExecutionWorkAttempt;
    request: LoopActionRequest;
    workerId: string;
    skill: string;
    subject: string;
    baseSubject: string;
    precollected?: LoopActionResult;
  }): Promise<{
    receipt: SemanticReviewReceipt;
    completedAt: string;
  } | { pending: true } | ReviewSubactionTerminal> => {
    const result = input.precollected ?? await reviewRuntimeCall(
      `review subaction ${input.request.actionId} result collection failed`,
      () => deps.runtime.collectLoopActionResult(input.resource, {
        attemptId: input.request.attemptId,
        actionId: input.request.actionId,
        requestHash: input.request.requestHash,
      })
    );
    if (!result) return { pending: true };
    if (typeof result.codexAuthJson === "string" && result.codexAuthJson) deps.captureCodexAuth?.(result.codexAuthJson);
    if (result.outcome !== "success") {
      return {
        terminal: true,
        resultHash: actionResultHash(result),
        outcome: result.outcome === "retryable_infrastructure_failure"
          ? "retryable_infrastructure_failure"
          : result.outcome === "needs_human" ? "needs_human" : "failure",
        lastError: `${result.outcome}: ${sanitizeText(result.receipt).slice(0, DIAGNOSTIC_TEXT_HEAD_CHARS)}`,
        terminalPayload: terminalPayloadForLoopResult(result),
        privateArtifact: privateArtifactForLoopResult(result),
      };
    }
    let receipt: StandardReceipt;
    try {
      receipt = parseStandardReceipt(result.receipt, { source: `review_subaction.${input.request.actionId}.receipt` }).value;
      if (receipt.type !== "semantic_review") throw new Error(`expected semantic_review, received ${receipt.type}`);
      assertStandardReceiptFence({
        expected: fanoutFenceFor({
          instance: input.instance,
          action: input.action,
          request: input.request,
          personaId: input.workerId,
          subject: input.subject,
          baseSubject: input.baseSubject,
          expectedProducer: reviewProducer(input.instance, input.workerId, input.skill),
        }),
        receipt,
        role: "review",
      });
    } catch (error) {
      return {
        terminal: true,
        resultHash: actionResultHash(result),
        outcome: "failure",
        lastError: `review subaction ${input.request.actionId} returned invalid receipt: ${
          sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)
        }`,
      };
    }
    return { receipt: receipt as SemanticReviewReceipt, completedAt: result.completedAt };
  };

  const previousReviewFanoutSynthesis = (
    action: ExecutionWorkAttempt
  ): ReviewFanoutSynthesis | undefined => {
    if (action.cycle < 2) return undefined;
    const gates = deps.store.listGateReceipts(action.parent_attempt_id)
      .filter((gate) =>
        gate.gate_kind === "final_review" &&
        gate.unit_id === action.unit_id &&
        gate.execution_work_attempt_id !== action.id)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    for (const gate of gates) {
      try {
        const payload = JSON.parse(gate.payload) as { review_fanout_synthesis?: ReviewFanoutSynthesis };
        if (payload.review_fanout_synthesis) return payload.review_fanout_synthesis;
      } catch {
        continue;
      }
    }
    return undefined;
  };

  const previousReviewJournal = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): { journal?: ReviewJournalContract; auditError?: string } => {
    if (action.cycle < 2) return {};
    const entries = deps.store.listJournalEntries({ issueId: instance.ticket_id, limit: 1_000, order: "newest" })
      .filter((entry) =>
        entry.instance_id === instance.id &&
        entry.run_id === action.parent_run_id &&
        entry.trigger === "structured_review_fanout" &&
        entry.structured !== null);
    let invalidEntries = 0;
    for (const entry of entries) {
      try {
        const journal = validateReviewJournalContract(JSON.parse(entry.structured!), {
          source: `orchestration_journal.${entry.id}.structured`,
        }).value;
        if (journal.finding_resolutions.some((resolution) => resolution.convergence_cycle === action.cycle - 1)) {
          return {
            journal,
            ...(invalidEntries > 0
              ? { auditError: `ignored ${invalidEntries} invalid prior review journal candidate row(s)` }
              : {}),
          };
        }
      } catch {
        invalidEntries += 1;
      }
    }
    return {
      auditError: `final review cycle ${action.cycle} has no valid prior review journal (${invalidEntries} invalid candidate row(s))`,
    };
  };

  const dispatchFinalReviewSelector: ReviewOrchestrator["dispatchFinalReviewSelector"] = async (input) => {
    const previousFanout = previousReviewFanoutSynthesis(input.action);
    const authority = buildReviewSelectorAuthority({
      subject: input.inputSubject,
      ...(previousFanout ? { requiredPersonaIds: previousFanout.persona_ids } : {}),
    });
    const selectorRequest = buildReviewSelectorRequest({
      instance: input.instance,
      action: input.action,
      plan: input.plan,
      authority,
      inputSubject: input.inputSubject,
      baseSubject: input.instance.base_commit,
      agent: input.agent,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      timeoutMs: input.timeoutMs,
      ...(input.priorEvidence ? { priorEvidence: input.priorEvidence } : {}),
    });
    assertLoopRequestEnvelopeBound(selectorRequest);
    deps.store.prepareActionDispatch?.({
      actionId: input.action.id,
      requestHash: selectorRequest.requestHash,
      requestPayload: canonicalJson(selectorRequest),
      nativeSessionId: null,
    });
    await ensureReviewSubactionLaunched({
      resource: input.resource,
      action: input.action,
      request: selectorRequest,
      label: "review selector action",
    });
    return { requestHash: selectorRequest.requestHash, nativeSessionId: null };
  };

  const collectOrchestratedFinalReview: ReviewOrchestrator["collectOrchestratedFinalReview"] = async (
    resource,
    instance,
    action,
    selectorRequest
  ) => {
    const terminalFailure = (error: unknown, evidence: unknown = null) => ({
      terminal: true as const,
      resultHash: digestCanonicalJson({ action_id: action.id, evidence, error: error instanceof Error ? error.message : String(error) }),
      outcome: "failure" as const,
      lastError: `structured review orchestration failed: ${sanitizeText(error instanceof Error ? error.message : String(error)).slice(-500)}`,
      nativeSessionId: null,
    });
    try {
      const executionPlan = deps.executionPlanFor(action);
      const reviewSubject = deps.actionInputSubjectFor(instance, action);
      if (selectorRequest.inputSubject !== reviewSubject || selectorRequest.baseSubject !== instance.base_commit) {
        throw new Error("persisted review selector request is not bound to the current final subject");
      }
      const previousFanout = previousReviewFanoutSynthesis(action);
      const authority = buildReviewSelectorAuthority({
        subject: reviewSubject,
        ...(previousFanout ? { requiredPersonaIds: previousFanout.persona_ids } : {}),
      });
      const selector = await collectReviewSubaction({
        resource,
        instance,
        action,
        request: selectorRequest,
        workerId: "review-selector",
        skill: "builtin://select-review-personas@1",
        subject: reviewSubject,
        baseSubject: instance.base_commit,
      });
      if ("pending" in selector) return null;
      if ("terminal" in selector) return { ...selector, nativeSessionId: null };
      if (selector.receipt.result !== "success" || selector.receipt.payload.findings.length > 0) {
        throw new Error("review selector must return success with no review findings");
      }
      const selectorDispatch = deps.store.getReviewSubactionDispatch(action.id, selectorRequest.actionId);
      if (!selectorDispatch?.dispatched_at || !selectorDispatch.dispatch_time_source) {
        throw new Error("review selector has no persisted dispatch timing");
      }
      const recommendation = parseReviewSelectorRecommendation(selector.receipt.payload.summary, authority);
      const fanoutPlan = buildReviewFanoutPlan({
        subject: reviewSubject,
        ...reviewFanoutSearchMapsFor(executionPlan),
        commandNames: executionPlan.commands.map((command) => command.name),
        recommendation,
        selectorReceiptHash: digestNormalized(canonicalJson(selector.receipt)),
        ...(previousFanout ? { requiredPersonaIds: previousFanout.persona_ids } : {}),
      });
      if (previousFanout) validateReviewFanoutRepair({ previous: previousFanout, nextPlan: fanoutPlan });
      const fanoutRequests = buildReviewFanoutRequests({
        instance,
        action,
        plan: executionPlan,
        fanout: fanoutPlan,
        inputSubject: reviewSubject,
        baseSubject: instance.base_commit,
        agent: selectorRequest.agent,
        ...(selectorRequest.model === undefined ? {} : { model: selectorRequest.model }),
        ...(selectorRequest.reasoningEffort === undefined ? {} : { reasoningEffort: selectorRequest.reasoningEffort }),
        timeoutMs: selectorRequest.timeoutMs,
      });
      for (const request of fanoutRequests) assertLoopRequestEnvelopeBound(request);
      // Review subactions share one sandbox. The sandbox seals every action by
      // locking sibling action directories, so overlapping persona processes
      // would lock one another's active engine homes. Run the deterministic
      // roster one action at a time; for Codex this also preserves the rotating
      // auth handoff before action N+1 materializes its credentials.
      const precollectedFanout = await prepareReviewFanout({
        resource,
        action,
        requests: fanoutRequests,
      });
      const fanout = await collectReviewFanout({
        resource,
        instance,
        action,
        plan: fanoutPlan,
        requests: fanoutRequests,
        baseSubject: instance.base_commit,
        precollected: precollectedFanout,
      });
      if ("pending" in fanout) return null;
      if ("terminal" in fanout) return { ...fanout, nativeSessionId: null };
      const blocking = fanout.synthesis.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1");
      let validatorReceipt: SemanticReviewReceipt | null = null;
      let validatorTiming: ReviewSubactionTiming | null = null;
      if (blocking) {
        const validatorRequest = buildReviewValidatorRequest({
          instance,
          action,
          plan: executionPlan,
          fanout: fanoutPlan,
          synthesis: fanout.synthesis,
          inputSubject: reviewSubject,
          baseSubject: instance.base_commit,
          agent: selectorRequest.agent,
          ...(selectorRequest.model === undefined ? {} : { model: selectorRequest.model }),
          ...(selectorRequest.reasoningEffort === undefined ? {} : { reasoningEffort: selectorRequest.reasoningEffort }),
          timeoutMs: selectorRequest.timeoutMs,
        });
        assertLoopRequestEnvelopeBound(validatorRequest);
        const precollectedValidator = await prepareReviewSubaction({
          resource,
          action,
          request: validatorRequest,
          label: "review validator action",
        });
        const validator = await collectReviewSubaction({
          resource,
          instance,
          action,
          request: validatorRequest,
          workerId: "review-validator",
          skill: "builtin://validate-review-findings@1",
          subject: reviewSubject,
          baseSubject: instance.base_commit,
          ...(precollectedValidator.result ? { precollected: precollectedValidator.result } : {}),
        });
        if ("pending" in validator) return null;
        if ("terminal" in validator) return { ...validator, nativeSessionId: null };
        validatorReceipt = validator.receipt;
        const validatorDispatch = deps.store.getReviewSubactionDispatch(action.id, validatorRequest.actionId);
        if (!validatorDispatch?.dispatched_at || !validatorDispatch.dispatch_time_source) {
          throw new Error("review validator has no persisted dispatch timing");
        }
        validatorTiming = {
          actionId: validatorRequest.actionId,
          dispatchedAt: validatorDispatch.dispatched_at,
          dispatchTimeSource: validatorDispatch.dispatch_time_source,
          completedAt: validator.completedAt,
        };
      }
      const validated = validateReviewFanoutBlockers({ synthesis: fanout.synthesis, validator: validatorReceipt });
      const commands = deps.commandAttemptReceiptsFor(action);
      const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
      const expectedBase = deps.standardFenceFor(instance, action, reviewSubject);
      const expected: StandardReceiptFence = {
        ...expectedBase,
        producers: {
          ...expectedBase.producers,
          review: builtinProducer("review-orchestrator", instance.capability_digest, "semantic_attested"),
        },
      };
      const completedTimes = [
        selector.completedAt,
        ...fanout.receiptResults.map((entry) => entry.completedAt),
        validatorTiming?.completedAt ?? null,
      ]
        .filter((value): value is string => value !== null)
        .sort();
      const issuedAt = completedTimes.at(-1) ?? deps.now().toISOString();
      const repairAuthoritativeSynthesis: ReviewFanoutSynthesis = {
        ...validated.synthesis,
        findings: validated.synthesis.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1"),
      };
      const reviewReceipt = synthesizeFinalReviewReceipt({
        expected,
        synthesis: repairAuthoritativeSynthesis,
        commandHashes: commands.map((command) => digestNormalized(canonicalJson(command.receipt))),
        issuedAt,
      });
      const priorJournal = previousReviewJournal(instance, action);
      if (priorJournal.auditError) {
        deps.store.recordJournalEntry({
          issueId: instance.ticket_id,
          instanceId: instance.id,
          runId: action.parent_run_id,
          actor: "supervisor",
          kind: "run_note",
          trigger: "structured_review_journal_gap",
          action: priorJournal.auditError,
          outcome: "failure",
          refs: {
            pipeline_instance_id: instance.id,
            action_attempt_id: action.id,
            cycle: action.cycle,
            subject: reviewSubject,
          },
        });
      }
      const journal = buildReviewJournal({
        plan: fanoutPlan,
        baseSubject: instance.base_commit,
        receipts: fanout.receiptResults,
        selectorTiming: {
          actionId: selectorRequest.actionId,
          dispatchedAt: selectorDispatch.dispatched_at,
          dispatchTimeSource: selectorDispatch.dispatch_time_source,
          completedAt: selector.completedAt,
        },
        validatorTiming,
        validation: validated,
        cycle: action.cycle,
        actionCreatedAt: action.created_at,
        recordedAt: issuedAt,
        ...(priorJournal.journal ? { previousJournal: priorJournal.journal } : {}),
      });
      deps.store.recordJournalEntry({
        issueId: instance.ticket_id,
        instanceId: instance.id,
        runId: action.parent_run_id,
        actor: "supervisor",
        kind: "run_note",
        trigger: "structured_review_fanout",
        action: `Persisted sealed review selection, persona evidence, blocker validation, and cycle ${action.cycle} resolution state.`,
        outcome: validated.synthesis.outcome,
        refs: {
          pipeline_instance_id: instance.id,
          generation: instance.generation,
          parent_attempt_id: action.parent_attempt_id,
          action_attempt_id: action.id,
          subject: reviewSubject,
          selector_receipt_hash: fanoutPlan.selector_receipt_hash,
          validator_receipt_hash: validated.validator_receipt_hash,
        },
        structured: { ...journal },
      });
      const decision = evaluateFinalReviewGate({
        expected,
        expectedReceipts: {
          commands: commands.map((command) => deps.standardFenceFor(instance, command.attempt, command.receipt.subject.post)),
          review: expected,
        },
        commands: commands.map((command) => command.receipt),
        expectedCommandNames: graph ? JSON.parse(graph.command_names) as string[] : [],
        review: reviewReceipt,
        reviewFanout: validated.synthesis,
      });
      return {
        resultHash: digestCanonicalJson({
          selector: selector.receipt,
          fanout: fanout.synthesis,
          validation: validated,
          journal,
        }),
        outputSubject: reviewSubject,
        receipt: canonicalJson(reviewReceipt),
        nativeSessionId: null,
        decision,
      };
    } catch (error) {
      // Provider dispatch/collection failures are not semantic review
      // decisions. Leave the fenced parent action active so the next drain
      // can replay the same deterministic subaction ids idempotently.
      if (error instanceof RetryableReviewRuntimeError) throw error;
      return terminalFailure(error);
    }
  };

  return {
    ensureReviewSubactionLaunched,
    dispatchFinalReviewSelector,
    collectOrchestratedFinalReview,
  };
}
