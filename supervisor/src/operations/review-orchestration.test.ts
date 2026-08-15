import { describe, expect, it, vi } from "vitest";
import { canonicalJson, deriveReviewSubactionActionId, RECEIPT_SCHEMA } from "@openthrottle/contracts";
import type { AnyExecutionPlanContract } from "@openthrottle/contracts";
import { buildReviewSelectorAuthority, type ReviewFanoutPlan, type ReviewFanoutSynthesis } from "../pipeline/review-fanout.js";
import type { ExpectedReceiptProducer, ReceiptProducerRole, StandardReceiptFence } from "../pipeline/execution-gates.js";
import type { PipelineInstance } from "../pipeline/store.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import {
  buildReviewFanoutRequests,
  buildReviewSelectorRequest,
  buildReviewValidatorRequest,
  createReviewOrchestrator,
  fanoutActionId,
  RetryableReviewRuntimeError,
  selectorActionId,
  synthesizeFinalReviewReceipt,
  validatorActionId,
  type ReviewOrchestrationDeps,
} from "./review-orchestration.js";

const SUBJECT = "b".repeat(40);
const BASE = "a".repeat(40);

function instance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "instance-1",
    ticket_id: "ticket-1",
    generation: 1,
    base_commit: BASE,
    manifest_digest: "c".repeat(64),
    capability_digest: "d".repeat(64),
    ...overrides,
  } as PipelineInstance;
}

function reviewAction(overrides: Partial<ExecutionWorkAttempt> = {}): ExecutionWorkAttempt {
  return {
    id: "action-final-review",
    execution_graph_id: "graph-1",
    parent_attempt_id: "parent-attempt",
    parent_run_id: "run-1",
    unit_id: null,
    action_kind: "final_review",
    cycle: 1,
    created_at: "2099-07-22T11:00:00.000Z",
    ...overrides,
  } as ExecutionWorkAttempt;
}

const executionPlan = {
  schema: "openthrottle.execution-plan/v1",
  graph_id: "structured",
  plan_id: "plan-1",
  instructions: { one: "Implement one." },
  acceptance: { done: "Done." },
  units: [{ id: "unit_a", title: "Unit A", depends_on: [], instructions: ["one"], acceptance: ["done"] }],
  commands: [{ name: "test" }],
} as unknown as AnyExecutionPlanContract;

const fanoutPlan = {
  schema: "openthrottle.review-fanout-plan/v1",
  roster_id: "roster-1",
  roster_digest: "e".repeat(64),
  subject: SUBJECT,
  policy_digest: "f".repeat(64),
  selection_id: "selection-1",
  selector_receipt_hash: "1".repeat(64),
  max_parallel: 1,
  personas: [
    {
      id: "security",
      mandatory: true,
      focus: "auth",
      invariant: "no secret leaks",
      max_findings: 5,
      reason: "mandatory",
      rationale: "always runs",
    },
    {
      id: "performance",
      mandatory: false,
      focus: "hot paths",
      invariant: "no regressions",
      max_findings: 5,
      reason: "selected",
      rationale: "touches a hot path",
    },
  ],
} as unknown as ReviewFanoutPlan;

function producer(workerId: string): ExpectedReceiptProducer {
  return {
    workerId,
    skill: `builtin://${workerId}@1`,
    capabilityDigest: "d".repeat(64),
    skillPackageDigest: null,
    assurance: "semantic_attested",
  };
}

function producers(): Record<ReceiptProducerRole, ExpectedReceiptProducer> {
  return {
    completion: producer("unit-worker"),
    candidate: producer("executor"),
    command: producer("executor"),
    lead: producer("lead-worker"),
    integration: producer("executor"),
    review: producer("review-orchestrator"),
  };
}

function fence(overrides: Partial<StandardReceiptFence> = {}): StandardReceiptFence {
  return {
    pipelineInstanceId: "instance-1",
    graphDigest: "c".repeat(64),
    unitId: "__final__",
    attemptId: "parent-attempt",
    parentRunId: "run-1",
    actionAttemptId: "action-final-review",
    generation: 1,
    nativeSessionId: null,
    requestHash: "9".repeat(64),
    baseSubject: BASE,
    preSubject: SUBJECT,
    subject: SUBJECT,
    producers: producers(),
    ...overrides,
  };
}

function synthesis(overrides: Partial<ReviewFanoutSynthesis> = {}): ReviewFanoutSynthesis {
  return {
    schema: "openthrottle.review-fanout-synthesis/v1",
    roster_digest: "e".repeat(64),
    persona_ids: ["security"],
    subject: SUBJECT,
    outcome: "success",
    summary: "No blocking findings.",
    findings: [],
    receipt_hashes: ["2".repeat(64)],
    ...overrides,
  } as ReviewFanoutSynthesis;
}

// The doubles above are deliberately partial rows, so reach them through the
// loose mock type rather than vi.mocked()'s exact store signatures.
function mockFn(target: unknown): ReturnType<typeof vi.fn> {
  return target as ReturnType<typeof vi.fn>;
}

function orchestratorDeps(overrides: Partial<ReviewOrchestrationDeps> = {}): ReviewOrchestrationDeps {
  return {
    store: {
      getReviewSubactionDispatch: vi.fn(() => undefined),
      prepareReviewSubactionDispatch: vi.fn(() => "recorded" as const),
      markReviewSubactionDispatched: vi.fn(),
      listGateReceipts: vi.fn(() => []),
      listJournalEntries: vi.fn(() => []),
      recordJournalEntry: vi.fn(),
      getGraphForAttempt: vi.fn(() => undefined),
      prepareActionDispatch: vi.fn(),
    } as unknown as ReviewOrchestrationDeps["store"],
    runtime: {
      dispatchLoopAction: vi.fn(async () => undefined),
      collectLoopActionResult: vi.fn(async () => null),
    } as unknown as ReviewOrchestrationDeps["runtime"],
    now: () => new Date("2099-07-22T12:00:00.000Z"),
    executionPlanFor: () => executionPlan,
    actionInputSubjectFor: () => SUBJECT,
    expectedProducersFor: () => producers(),
    standardFenceFor: (_instance, _action, subject) => fence({ subject }),
    commandAttemptReceiptsFor: () => [],
    ...overrides,
  };
}

describe("review subaction identifiers", () => {
  it("derives one deterministic action id per review role", () => {
    const action = reviewAction();
    expect(selectorActionId(action)).toBe(deriveReviewSubactionActionId(action.id, "selector"));
    expect(validatorActionId(action)).toBe(deriveReviewSubactionActionId(action.id, "validator"));
    expect(fanoutActionId(action, "security")).toBe(deriveReviewSubactionActionId(action.id, "security"));
    expect(new Set([
      selectorActionId(action),
      validatorActionId(action),
      fanoutActionId(action, "security"),
      fanoutActionId(action, "performance"),
    ]).size).toBe(4);
  });
});

describe("review subaction requests", () => {
  const requestInput = {
    instance: instance(),
    action: reviewAction(),
    plan: executionPlan,
    inputSubject: SUBJECT,
    baseSubject: BASE,
    agent: "codex" as const,
    timeoutMs: 300_000,
  };

  it("seals the selector request to the selector action id, skill, and producer", () => {
    const request = buildReviewSelectorRequest({
      ...requestInput,
      authority: buildReviewSelectorAuthority({ subject: SUBJECT }),
    });
    expect(request.actionId).toBe(selectorActionId(requestInput.action));
    expect(request.skill).toBe("select-review-personas");
    expect(request.expectedReceiptType).toBe("semantic_review");
    expect(request.expectedProducer?.workerId).toBe("review-selector");
    expect(request.idempotencyKey).toBe(`loop:parent-attempt:${request.actionId}:${request.requestHash}`);
    expect(request.priorEvidence).toBeUndefined();
    // The sealed hash is derived from the request body, so an identical build replays it.
    expect(buildReviewSelectorRequest({
      ...requestInput,
      authority: buildReviewSelectorAuthority({ subject: SUBJECT }),
    }).requestHash).toBe(request.requestHash);
  });

  it("builds one fanout request per persona, each fenced to that persona", () => {
    const requests = buildReviewFanoutRequests({ ...requestInput, fanout: fanoutPlan });
    expect(requests.map((request) => request.skill)).toEqual(["security", "performance"]);
    expect(requests.map((request) => request.actionId)).toEqual([
      fanoutActionId(requestInput.action, "security"),
      fanoutActionId(requestInput.action, "performance"),
    ]);
    expect(requests.map((request) => request.expectedProducer?.workerId)).toEqual(["security", "performance"]);
    expect(requests.map((request) => request.expectedProducerSkill)).toEqual([
      "builtin://security@1",
      "builtin://performance@1",
    ]);
    for (const request of requests) {
      expect(request.worktree).toBeNull();
      expect(request.credentialScopes).toEqual(["model.invoke", "repo.read"]);
      expect(request.inputSubject).toBe(SUBJECT);
      expect(request.baseSubject).toBe(BASE);
    }
  });

  it("seals the validator request to the fanout synthesis it must adjudicate", () => {
    const request = buildReviewValidatorRequest({
      ...requestInput,
      fanout: fanoutPlan,
      synthesis: synthesis({ outcome: "semantic_repair_required" }),
    });
    expect(request.actionId).toBe(validatorActionId(requestInput.action));
    expect(request.skill).toBe("validate-review-findings");
    expect(request.expectedProducer?.workerId).toBe("review-validator");
    expect(request.transitionContext).toContain("review_synthesis");
  });

  it("carries prior evidence into the selector request only when the caller supplies it", () => {
    const priorEvidence = {
      schema: "openthrottle.loop-prior-evidence/v1" as const,
      role: "final_review" as const,
      receipts: [],
    };
    const request = buildReviewSelectorRequest({
      ...requestInput,
      authority: buildReviewSelectorAuthority({ subject: SUBJECT }),
      priorEvidence,
    });
    expect(request.priorEvidence).toEqual(priorEvidence);
  });
});

describe("synthesizeFinalReviewReceipt", () => {
  it("carries the expected fence, producer, and subject onto the orchestrator receipt", () => {
    const receipt = synthesizeFinalReviewReceipt({
      expected: fence(),
      synthesis: synthesis(),
      commandHashes: ["3".repeat(64)],
      issuedAt: "2099-07-22T11:59:00.000Z",
    });
    expect(receipt.schema).toBe(RECEIPT_SCHEMA);
    expect(receipt.type).toBe("semantic_review");
    expect(receipt.result).toBe("success");
    expect(receipt.producer.worker_id).toBe("review-orchestrator");
    expect(receipt.subject).toEqual({ base: BASE, pre: SUBJECT, post: SUBJECT });
    expect(receipt.fence.unit_id).toBe("__final__");
    expect(receipt.fence.request_hash).toBe("9".repeat(64));
    expect(receipt.payload.summary).toBe("No blocking findings.");
    expect(receipt.issued_at).toBe("2099-07-22T11:59:00.000Z");
    // Command hashes lead, then persona receipt hashes, then the synthesis digest.
    expect(receipt.evidence.slice(0, 2)).toEqual(["3".repeat(64), "2".repeat(64)]);
    expect(receipt.evidence).toHaveLength(3);
  });

  it.each([
    ["success", "success"],
    ["needs_human", "needs_human"],
    ["failure", "failure"],
    ["semantic_repair_required", "semantic_repair_required"],
    ["no_change", "semantic_repair_required"],
  ] as const)("maps synthesis outcome %s to receipt result %s", (outcome, result) => {
    expect(synthesizeFinalReviewReceipt({
      expected: fence(),
      synthesis: synthesis({ outcome }),
      commandHashes: [],
      issuedAt: "2099-07-22T11:59:00.000Z",
    }).result).toBe(result);
  });
});

describe("createReviewOrchestrator", () => {
  const launchInput = () => ({
    resource: {} as never,
    action: reviewAction(),
    request: buildReviewSelectorRequest({
      instance: instance(),
      action: reviewAction(),
      plan: executionPlan,
      authority: buildReviewSelectorAuthority({ subject: SUBJECT }),
      inputSubject: SUBJECT,
      baseSubject: BASE,
      agent: "codex" as const,
      timeoutMs: 300_000,
    }),
    label: "review selector action",
  });

  it("dispatches an unlaunched subaction and records the acknowledged dispatch", async () => {
    const deps = orchestratorDeps();
    const launched = await createReviewOrchestrator(deps).ensureReviewSubactionLaunched(launchInput());
    expect(launched).toBe(true);
    expect(deps.store.prepareReviewSubactionDispatch).toHaveBeenCalledTimes(1);
    expect(deps.runtime.dispatchLoopAction).toHaveBeenCalledTimes(1);
    expect(deps.store.markReviewSubactionDispatched).toHaveBeenCalledWith(
      "action-final-review",
      selectorActionId(reviewAction()),
      "acknowledged"
    );
  });

  it("never redispatches a subaction the sealed ledger already launched", async () => {
    const deps = orchestratorDeps();
    mockFn(deps.store.getReviewSubactionDispatch).mockReturnValue({
      dispatched_at: "2099-07-22T11:30:00.000Z",
      dispatch_time_source: "acknowledged",
    });
    const launched = await createReviewOrchestrator(deps).ensureReviewSubactionLaunched(launchInput());
    expect(launched).toBe(false);
    expect(deps.runtime.dispatchLoopAction).not.toHaveBeenCalled();
    expect(deps.store.markReviewSubactionDispatched).not.toHaveBeenCalled();
  });

  it("seals the selector request into the parent action before launching it", async () => {
    const deps = orchestratorDeps();
    const action = reviewAction();
    const dispatched = await createReviewOrchestrator(deps).dispatchFinalReviewSelector({
      resource: {} as never,
      instance: instance(),
      action,
      plan: executionPlan,
      inputSubject: SUBJECT,
      agent: "codex",
      timeoutMs: 300_000,
    });
    const prepared = mockFn(deps.store.prepareActionDispatch).mock.calls[0]![0];
    expect(prepared.actionId).toBe(action.id);
    expect(prepared.requestHash).toBe(dispatched.requestHash);
    expect(dispatched.nativeSessionId).toBeNull();
    const sealed = JSON.parse(prepared.requestPayload) as { actionId: string; skill: string; baseSubject: string };
    expect(sealed.actionId).toBe(selectorActionId(action));
    expect(sealed.skill).toBe("select-review-personas");
    // The selector is always fenced to the immutable run base, never to the review subject.
    expect(sealed.baseSubject).toBe(BASE);
    expect(deps.runtime.dispatchLoopAction).toHaveBeenCalledTimes(1);
  });

  it("holds the parent action open while the selector result is still pending", async () => {
    const deps = orchestratorDeps();
    const selectorRequest = launchInput().request;
    const collected = await createReviewOrchestrator(deps).collectOrchestratedFinalReview(
      {} as never,
      instance(),
      reviewAction(),
      selectorRequest
    );
    expect(collected).toBeNull();
    expect(deps.store.recordJournalEntry).not.toHaveBeenCalled();
  });

  it("fails terminally when the persisted selector request is not bound to the current subject", async () => {
    const deps = orchestratorDeps({ actionInputSubjectFor: () => "9".repeat(40) });
    const collected = await createReviewOrchestrator(deps).collectOrchestratedFinalReview(
      {} as never,
      instance(),
      reviewAction(),
      launchInput().request
    );
    expect(collected).toMatchObject({ terminal: true, outcome: "failure", nativeSessionId: null });
    expect((collected as { lastError: string }).lastError).toContain("not bound to the current final subject");
    expect(deps.runtime.collectLoopActionResult).not.toHaveBeenCalled();
  });

  it("propagates a statusless provider fault as a retryable review runtime error", async () => {
    const deps = orchestratorDeps();
    mockFn(deps.runtime.collectLoopActionResult).mockRejectedValue(new Error("socket hang up"));
    await expect(createReviewOrchestrator(deps).collectOrchestratedFinalReview(
      {} as never,
      instance(),
      reviewAction(),
      launchInput().request
    )).rejects.toBeInstanceOf(RetryableReviewRuntimeError);
  });

  it("replays the previous cycle's persona roster from the sealed final-review gate", async () => {
    const deps = orchestratorDeps();
    mockFn(deps.store.listGateReceipts).mockReturnValue([{
      id: "gate-1",
      created_at: "2099-07-22T10:00:00.000Z",
      gate_kind: "final_review",
      unit_id: null,
      execution_work_attempt_id: "action-earlier-review",
      payload: canonicalJson({ review_fanout_synthesis: synthesis({ persona_ids: ["security", "performance"] }) }),
    }]);
    const action = reviewAction({ id: "action-final-review-2", cycle: 2 });
    await createReviewOrchestrator(deps).dispatchFinalReviewSelector({
      resource: {} as never,
      instance: instance(),
      action,
      plan: executionPlan,
      inputSubject: SUBJECT,
      agent: "codex",
      timeoutMs: 300_000,
    });
    const sealed = JSON.parse(
      mockFn(deps.store.prepareActionDispatch).mock.calls[0]![0].requestPayload
    ) as { transitionContext: string };
    expect(sealed.transitionContext).toContain("\"required_persona_ids\":[\"security\",\"performance\"]");
  });
});
