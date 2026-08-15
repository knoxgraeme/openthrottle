import { describe, expect, it, vi } from "vitest";
import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import type { PipelineInstance } from "../pipeline/store.js";
import type {
  ExecutionGateReceipt,
  ExecutionUnitStore,
  ExecutionWorkAttempt,
} from "../persistence/pipeline/unit-store.js";
import type { ExpectedReceiptProducer } from "../pipeline/execution-gates.js";
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
  type SubjectDerivationDeps,
} from "./subject-derivation.js";

const BASE = "a".repeat(40);
const INTEGRATED = "1".repeat(40);
const CANDIDATE_SUBJECT = "2".repeat(40);
const TREE = "e".repeat(40);
const REQUEST_HASH = "b".repeat(64);

function instance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "instance-1",
    generation: 1,
    base_commit: BASE,
    immutable_subject: null,
    manifest_digest: "c".repeat(64),
    capability_digest: "d".repeat(64),
    ...overrides,
  } as PipelineInstance;
}

function action(overrides: Partial<ExecutionWorkAttempt> & {
  id: string;
  action_kind: ExecutionWorkAttempt["action_kind"];
  cycle: number;
  status: ExecutionWorkAttempt["status"];
}): ExecutionWorkAttempt {
  return {
    execution_graph_id: "graph-1",
    execution_unit_id: "unit-row-a",
    pipeline_instance_id: "instance-1",
    parent_attempt_id: "parent-attempt",
    parent_run_id: "run-1",
    unit_id: "unit_a",
    attempt_ordinal: overrides.cycle,
    command_name: null,
    idempotency_key: `idem-${overrides.id}`,
    request_hash: null,
    result_hash: null,
    terminal_result_outcome: null,
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    lease_owner: null,
    lease_until: null,
    observation_failure_count: 0,
    observation_retry_at: null,
    observation_epoch: 0,
    output_subject: null,
    payload: "",
    request_payload: null,
    created_at: `2099-07-22T12:00:0${overrides.cycle}.000Z`,
    updated_at: "2099-07-22T12:00:00.000Z",
    completed_at: null,
    last_error: null,
    ...overrides,
  } as ExecutionWorkAttempt;
}

function subjectEvidenceReceipt(input: {
  type: "candidate_evidence" | "integration_evidence";
  attempt: ExecutionWorkAttempt;
  subject: string;
  preSubject?: string;
  baseSubject?: string;
  tree?: string;
  clean?: boolean;
}): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: input.type,
    assurance: "executor_verified",
    result: "success",
    producer: {
      worker_id: "executor",
      skill: `builtin://${input.type}@1`,
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: input.baseSubject ?? BASE,
      pre: input.preSubject ?? BASE,
      post: input.subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: input.attempt.unit_id ?? "__final__",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: input.attempt.id,
      generation: 1,
      native_session_id: null,
      request_hash: input.attempt.request_hash ?? REQUEST_HASH,
    },
    evidence: [digestNormalized(`${input.attempt.id}:${input.subject}`)],
    payload: {
      tree: input.tree ?? TREE,
      diff_digest: digestNormalized(input.subject),
      changed_paths: [],
      clean: input.clean ?? true,
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function completedCandidate(input: {
  id: string;
  subject: string;
  cycle?: number;
  attemptOrdinal?: number;
  outputSubject?: string;
  preSubject?: string;
  baseSubject?: string;
}): ExecutionWorkAttempt {
  const candidate = action({
    id: input.id,
    action_kind: "candidate",
    cycle: input.cycle ?? 1,
    status: "completed",
    attempt_ordinal: input.attemptOrdinal ?? 2,
    request_hash: REQUEST_HASH,
    output_subject: input.outputSubject ?? input.subject,
  });
  candidate.receipt = subjectEvidenceReceipt({
    type: "candidate_evidence",
    attempt: candidate,
    subject: input.subject,
    ...(input.preSubject ? { preSubject: input.preSubject } : {}),
    ...(input.baseSubject ? { baseSubject: input.baseSubject } : {}),
  });
  candidate.receipt_hash = digestNormalized(candidate.receipt);
  return candidate;
}

const CANDIDATE_PRODUCER: ExpectedReceiptProducer = {
  workerId: "executor",
  skill: "builtin://candidate_evidence@1",
  capabilityDigest: "d".repeat(64),
  skillPackageDigest: null,
  assurance: "executor_verified",
};

function derivation(input: {
  attempts?: readonly ExecutionWorkAttempt[];
  integrationSubject?: string | null;
  expectedProducerForAction?: SubjectDerivationDeps["expectedProducerForAction"];
} = {}) {
  const store = {
    listWorkAttempts: vi.fn(() => [...(input.attempts ?? [])]),
    getGraphForAttempt: vi.fn(() => ({ integration_subject: input.integrationSubject ?? null })),
  } as unknown as ExecutionUnitStore;
  return createSubjectDerivation({
    store,
    expectedProducerForAction: input.expectedProducerForAction ?? (() => CANDIDATE_PRODUCER),
  });
}

describe("worktree identity helpers", () => {
  it("keys a worktree by parent attempt, unit, and cycle", () => {
    const unitAction = action({ id: "action-1", action_kind: "implement", cycle: 2, status: "pending" });
    expect(worktreeIdempotencyKey(unitAction)).toBe("worktree:parent-attempt:unit_a:2");
    expect(worktreeIdempotencyKey({ ...unitAction, unit_id: null })).toBe("worktree:parent-attempt:final:2");
  });

  it("derives a stable 32-character handle that moves with the key and the base commit", () => {
    const unitAction = action({ id: "action-1", action_kind: "implement", cycle: 1, status: "pending" });
    const handle = worktreeHandleFor(unitAction, BASE);
    expect(handle.id).toHaveLength(32);
    expect(worktreeHandleFor(unitAction, BASE)).toEqual(handle);
    expect(worktreeHandleFor(unitAction, INTEGRATED).id).not.toBe(handle.id);
    expect(worktreeHandleFor({ ...unitAction, cycle: 2 }, BASE).id).not.toBe(handle.id);
    expect(worktreeHandleFor({ ...unitAction, unit_id: "unit_b" }, BASE).id).not.toBe(handle.id);
    expect(handle.id).toBe(digestNormalized(canonicalJson({
      idempotencyKey: "worktree:parent-attempt:unit_a:1",
      attemptId: "parent-attempt",
      baseCommit: BASE,
    })).slice(0, 32));
  });

  it("only lets 40-character sha1 subjects reach a child Git operation", () => {
    expect(sha1SubjectForGitOperation(BASE, "child action base subject")).toBe(BASE);
    expect(() => sha1SubjectForGitOperation("f".repeat(64), "child action base subject"))
      .toThrow(/child action base subject must be a 40-character Git object ID/);
    expect(() => sha1SubjectForGitOperation("nope", "tune verification base subject"))
      .toThrow(/tune verification base subject must be a 40-character Git object ID/);
    // The wider subject shape still admits the 64-character tree ids the
    // aggregate path compares -- only Git operations are narrowed to sha1.
    expect(GIT_SUBJECT.test("f".repeat(64))).toBe(true);
    expect(GIT_SUBJECT.test("nope")).toBe(false);
  });

  it("reuses the completed final-repair worktree for the final candidate of the same cycle", () => {
    const finalRepair = action({
      id: "final-repair-1",
      action_kind: "final_repair",
      cycle: 3,
      status: "completed",
      unit_id: null,
    });
    const finalCandidate = action({
      id: "final-candidate-1",
      action_kind: "candidate",
      cycle: 3,
      status: "pending",
      unit_id: null,
    });
    expect(finalRepairWorktreeHandleFor(finalCandidate, BASE, [finalRepair]))
      .toEqual(worktreeHandleFor(finalRepair, BASE));
    expect(() => finalRepairWorktreeHandleFor(finalCandidate, BASE, [{ ...finalRepair, cycle: 2 }]))
      .toThrow(/has no completed final repair worktree/);
    expect(() => finalRepairWorktreeHandleFor(finalCandidate, BASE, [{ ...finalRepair, status: "running" }]))
      .toThrow(/has no completed final repair worktree/);
    expect(() => finalRepairWorktreeHandleFor(finalCandidate, BASE, [])).toThrow(/has no completed final repair worktree/);
  });
});

describe("attempt receipt selectors", () => {
  it("projects only completed attempts that sealed a receipt", () => {
    const candidate = completedCandidate({ id: "candidate-1", subject: CANDIDATE_SUBJECT });
    const running = action({ id: "candidate-2", action_kind: "candidate", cycle: 1, status: "running" });
    const completedWithoutReceipt = action({ id: "command-1", action_kind: "command", cycle: 1, status: "completed" });
    const projected = completedAttemptReceiptsFrom([candidate, running, completedWithoutReceipt]);
    expect(projected.map((entry) => entry.attempt.id)).toEqual(["candidate-1"]);
    expect(completedAttemptReceiptsFrom([])).toEqual([]);
  });

  it("selects the last receipt of a type in phase order and rejects a missing one", () => {
    const first = completedCandidate({ id: "candidate-1", subject: CANDIDATE_SUBJECT, attemptOrdinal: 1 });
    const second = completedCandidate({ id: "candidate-2", subject: INTEGRATED, attemptOrdinal: 4 });
    // Deliberately out of order: the selector orders by phase/ordinal, never
    // by the order the store happened to return the rows in.
    const receipts = completedAttemptReceiptsFrom([second, first]);
    expect(latestAttemptReceipt(receipts, "candidate_evidence", "unit_a").attempt.id).toBe("candidate-2");
    expect(latestAttemptReceipt(receipts, "candidate_evidence", "unit_a", 1).receipt.subject.post).toBe(INTEGRATED);
    expect(() => latestAttemptReceipt(receipts, "candidate_evidence", "unit_b"))
      .toThrow(/missing candidate_evidence receipt for unit_b/);
    expect(() => latestAttemptReceipt(receipts, "candidate_evidence", null))
      .toThrow(/missing candidate_evidence receipt for final/);
    expect(() => latestAttemptReceipt(receipts, "candidate_evidence", "unit_a", 2))
      .toThrow(/missing candidate_evidence receipt for unit_a/);
  });
});

describe("verifiedAggregateTreeSubject", () => {
  function integrateAttempt(subject: string, tree = TREE, id = "integrate-1"): ExecutionWorkAttempt {
    const attempt = action({
      id,
      action_kind: "integrate",
      cycle: 1,
      status: "completed",
      unit_id: null,
      request_hash: REQUEST_HASH,
      output_subject: subject,
    });
    attempt.receipt = subjectEvidenceReceipt({
      type: "integration_evidence",
      attempt,
      subject,
      tree,
    });
    attempt.receipt_hash = digestNormalized(attempt.receipt);
    return attempt;
  }

  function integrationGate(attempt: ExecutionWorkAttempt, subject: string): ExecutionGateReceipt {
    const payload = "{}";
    return {
      id: `gate-${attempt.id}`,
      execution_graph_id: "graph-1",
      execution_unit_id: "unit-row-a",
      execution_work_attempt_id: attempt.id,
      parent_attempt_id: "parent-attempt",
      unit_id: null,
      gate_kind: "integration",
      evaluator_kind: "publish_subject",
      subject,
      result: "passed",
      outcome: "success",
      reason: "executor_integrated_candidate",
      artifact_hashes: JSON.stringify([attempt.receipt_hash]),
      payload,
      receipt_hash: digestNormalized(payload),
      created_at: "2099-07-22T12:00:00.000Z",
    } as ExecutionGateReceipt;
  }

  function aggregateTreeFor(
    attempts: readonly ExecutionWorkAttempt[],
    gates: readonly ExecutionGateReceipt[]
  ): string {
    return verifiedAggregateTreeSubject({
      parentAttemptId: "parent-attempt",
      integrationSubject: INTEGRATED,
      attempts,
      gates,
    });
  }

  it("returns the tree the accepted integration receipt sealed", () => {
    const attempt = integrateAttempt(INTEGRATED);
    expect(aggregateTreeFor([attempt], [integrationGate(attempt, INTEGRATED)])).toBe(TREE);
  });

  it("refuses an aggregate whose integrated commit has no accepted gate", () => {
    const attempt = integrateAttempt(INTEGRATED);
    const rejected = { ...integrationGate(attempt, INTEGRATED), result: "failed" } as ExecutionGateReceipt;
    expect(() => aggregateTreeFor([attempt], [rejected])).toThrow(/requires an accepted integration gate/);
    expect(() => aggregateTreeFor([attempt], [])).toThrow(/requires an accepted integration gate/);
  });

  it("refuses a gate that does not seal its own integration receipt", () => {
    const attempt = integrateAttempt(INTEGRATED);
    const gate = integrationGate(attempt, INTEGRATED);
    expect(() => aggregateTreeFor([attempt], [{ ...gate, artifact_hashes: "[]" } as ExecutionGateReceipt]))
      .toThrow(/does not seal the receipt/);
    expect(() => aggregateTreeFor([attempt], [{ ...gate, receipt_hash: "0".repeat(64) } as ExecutionGateReceipt]))
      .toThrow(/integration gate hash mismatch/);
    expect(() => aggregateTreeFor([{ ...attempt, output_subject: CANDIDATE_SUBJECT }], [gate]))
      .toThrow(/integration action subject disagrees with graph subject/);
  });

  it("refuses accepted integration receipts that disagree on the tree", () => {
    const attempt = integrateAttempt(INTEGRATED);
    const other = integrateAttempt(INTEGRATED, "f".repeat(40), "integrate-2");
    expect(() => aggregateTreeFor(
      [attempt, other],
      [integrationGate(attempt, INTEGRATED), integrationGate(other, INTEGRATED)]
    )).toThrow(/disagree on the tree subject/);
  });
});

describe("createSubjectDerivation", () => {
  it("cuts a first-cycle worktree from the graph's integration subject, then the sealed instance base", () => {
    const implement = action({ id: "action-1", action_kind: "implement", cycle: 1, status: "pending" });
    expect(derivation({ integrationSubject: INTEGRATED }).worktreeBaseFor(instance(), implement)).toBe(INTEGRATED);
    expect(derivation().worktreeBaseFor(instance(), implement)).toBe(BASE);
    expect(derivation().worktreeBaseFor(instance({ immutable_subject: INTEGRATED }), implement)).toBe(INTEGRATED);
  });

  it("refuses a worktree base that is not an exact subject", () => {
    const implement = action({ id: "action-1", action_kind: "implement", cycle: 1, status: "pending" });
    expect(() => derivation().worktreeBaseFor(instance({ base_commit: "main" }), implement))
      .toThrow(/child action action-1 has no exact worktree base/);
  });

  it("reads the predecessor output subject for each phase and falls back to the base", () => {
    const implement = action({
      id: "action-1",
      action_kind: "implement",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      output_subject: CANDIDATE_SUBJECT,
    });
    const command = action({
      id: "action-2",
      action_kind: "command",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      output_subject: CANDIDATE_SUBJECT,
    });
    const candidate = action({ id: "action-3", action_kind: "candidate", cycle: 1, status: "pending" });
    const derive = derivation({ attempts: [implement, command] });
    expect(derive.actionInputSubjectFor(instance(), candidate)).toBe(CANDIDATE_SUBJECT);
    expect(derive.actionInputSubjectFor(instance(), command)).toBe(CANDIDATE_SUBJECT);
    // No completed predecessor for this unit cycle -- the worktree base is the
    // only exact subject left to read.
    expect(derivation().actionInputSubjectFor(instance(), candidate)).toBe(BASE);
    expect(derivation({ integrationSubject: INTEGRATED }).actionInputSubjectFor(
      instance(),
      action({ id: "action-4", action_kind: "integrate", cycle: 1, status: "pending", unit_id: null })
    )).toBe(INTEGRATED);
  });

  it("takes a final review's receipt base from its own sealed request, not the current worktree base", () => {
    const review = action({
      id: "final-review-1",
      action_kind: "final_review",
      cycle: 1,
      status: "completed",
      unit_id: null,
      request_payload: JSON.stringify({ protocol: "loop-action@3", baseSubject: INTEGRATED }),
    });
    expect(derivation().receiptBaseFor(instance(), review)).toBe(INTEGRATED);
    expect(derivation().receiptBaseFor(instance(), { ...review, request_payload: "not json" })).toBe(BASE);
    expect(derivation().receiptBaseFor(instance(), { ...review, request_payload: null })).toBe(BASE);
    // Every other phase keeps reading the worktree base.
    expect(derivation({ integrationSubject: INTEGRATED }).receiptBaseFor(
      instance(),
      action({ id: "action-1", action_kind: "implement", cycle: 1, status: "pending" })
    )).toBe(INTEGRATED);
  });

  it("rebuilds a repair from the one executor-verified rejected candidate of the prior cycle", () => {
    const candidate = completedCandidate({ id: "candidate-1", subject: CANDIDATE_SUBJECT, cycle: 1 });
    const repair = action({ id: "repair-1", action_kind: "repair", cycle: 2, status: "pending" });
    const derive = derivation({ attempts: [candidate] });
    expect(derive.repairRejectedCandidateAttemptReceipt(instance(), repair).attempt.id).toBe("candidate-1");
    expect(derive.worktreeBaseFor(instance(), repair)).toBe(CANDIDATE_SUBJECT);
    expect(derive.actionInputSubjectFor(instance(), repair)).toBe(CANDIDATE_SUBJECT);
  });

  it("refuses a repair whose rejected candidate is missing, doubled, or unbound", () => {
    const candidate = completedCandidate({ id: "candidate-1", subject: CANDIDATE_SUBJECT, cycle: 1 });
    const repair = action({ id: "repair-1", action_kind: "repair", cycle: 2, status: "pending" });
    expect(() => derivation().repairRejectedCandidateAttemptReceipt(instance(), repair))
      .toThrow(/requires exactly one rejected candidate evidence receipt for cycle 1/);
    const duplicate = completedCandidate({ id: "candidate-2", subject: CANDIDATE_SUBJECT, cycle: 1 });
    expect(() => derivation({ attempts: [candidate, duplicate] })
      .repairRejectedCandidateAttemptReceipt(instance(), repair))
      .toThrow(/requires exactly one rejected candidate evidence receipt for cycle 1/);
    const drifted = completedCandidate({
      id: "candidate-1",
      subject: CANDIDATE_SUBJECT,
      cycle: 1,
      outputSubject: INTEGRATED,
    });
    expect(() => derivation({ attempts: [drifted] }).repairRejectedCandidateAttemptReceipt(instance(), repair))
      .toThrow(/rejected candidate subject disagrees with its action output/);
    expect(() => derivation({ attempts: [candidate], expectedProducerForAction: () => ({
      ...CANDIDATE_PRODUCER,
      workerId: "someone-else",
    }) }).repairRejectedCandidateAttemptReceipt(instance(), repair))
      .toThrow(/candidate receipt producer mismatch/);
    expect(() => derivation({ attempts: [candidate] })
      .repairRejectedCandidateAttemptReceipt(instance(), { ...repair, action_kind: "implement" }))
      .toThrow(/is not a unit repair/);
    expect(() => derivation({ attempts: [candidate] })
      .repairRejectedCandidateAttemptReceipt(instance(), { ...repair, unit_id: null }))
      .toThrow(/has no unit id/);
  });

  it("binds a prepared unit request to the worktree the current derivation would cut", () => {
    const candidate = action({ id: "candidate-1", action_kind: "candidate", cycle: 1, status: "pending" });
    const derive = derivation();
    const bound = {
      baseSubject: BASE,
      inputSubject: BASE,
      worktree: worktreeHandleFor(candidate, BASE),
    };
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(bound, instance(), candidate)).not.toThrow();
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(
      { ...bound, worktree: { id: "0".repeat(32) } },
      instance(),
      candidate
    )).toThrow(/is not bound to the current unit worktree/);
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(
      { ...bound, baseSubject: INTEGRATED },
      instance(),
      candidate
    )).toThrow(/is not bound to the current unit worktree/);
    // A lead never gets a worktree of its own.
    const lead = action({ id: "lead-1", action_kind: "lead", cycle: 1, status: "pending" });
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(
      { baseSubject: BASE, inputSubject: BASE, worktree: null },
      instance(),
      lead
    )).not.toThrow();
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(
      { baseSubject: BASE, inputSubject: BASE, worktree: worktreeHandleFor(lead, BASE) },
      instance(),
      lead
    )).toThrow(/is not bound to the current unit worktree/);
  });

  it("leaves final-phase and non-worktree unit actions unbound", () => {
    const derive = derivation();
    const unbound = { baseSubject: "whatever", inputSubject: "whatever", worktree: null };
    const finalCandidate = action({
      id: "final-candidate-1",
      action_kind: "candidate",
      cycle: 1,
      status: "pending",
      unit_id: null,
    });
    const implement = action({ id: "action-1", action_kind: "implement", cycle: 1, status: "pending" });
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(unbound, instance(), finalCandidate)).not.toThrow();
    expect(() => derive.assertPreparedUnitWorktreeRequestBound(unbound, instance(), implement)).not.toThrow();
  });

  it("projects the parent attempt's completed receipts through the store", () => {
    const candidate = completedCandidate({ id: "candidate-1", subject: CANDIDATE_SUBJECT });
    const pending = action({ id: "candidate-2", action_kind: "candidate", cycle: 2, status: "pending" });
    const receipts = derivation({ attempts: [candidate, pending] }).completedAttemptReceiptsFor("parent-attempt");
    expect(receipts.map((entry) => entry.attempt.id)).toEqual(["candidate-1"]);
    expect(receipts[0]!.receipt.subject.post).toBe(CANDIDATE_SUBJECT);
  });
});
