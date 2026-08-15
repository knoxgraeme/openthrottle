import {
  digestCanonicalJson,
  digestNormalized,
  parseStandardReceipt,
  type CandidateEvidenceReceipt,
  type StandardReceipt,
} from "@openthrottle/contracts";
import { assertCandidateEvidenceFence, type ExpectedReceiptProducer } from "../pipeline/execution-gates.js";
import type { UnitActionKind } from "../pipeline/unit-coordinator.js";
import type { PipelineInstance } from "../pipeline/store.js";
import type {
  ExecutionGateReceipt,
  ExecutionUnitStore,
  ExecutionWorkAttempt,
} from "../persistence/pipeline/unit-store.js";
import type { ChildExecutorActionRequest, LoopActionRequest } from "../runtime/contracts.js";
import type { AttemptReceiptEntry } from "./prior-evidence.js";

export const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const GIT_SHA1_SUBJECT = /^[a-f0-9]{40}$/;

// Total order over the actions of one unit cycle: the phase sequence first,
// then the store's own attempt ordinal / creation order. Every "latest prior
// output" selector below reads it, so a unit's implement -> command ->
// candidate -> lead chain always resolves to the same subject regardless of
// the row order the store hands back.
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

function compareAttemptOrder(left: ExecutionWorkAttempt, right: ExecutionWorkAttempt): number {
  return ACTION_OUTPUT_ORDER[left.action_kind] - ACTION_OUTPUT_ORDER[right.action_kind] ||
    left.attempt_ordinal - right.attempt_ordinal ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);
}

export function worktreeIdempotencyKey(action: ExecutionWorkAttempt): string {
  return `worktree:${action.parent_attempt_id}:${action.unit_id ?? "final"}:${action.cycle}`;
}

export function worktreeHandleFor(action: ExecutionWorkAttempt, baseCommit: string): { id: string } {
  return {
    id: digestCanonicalJson({
      idempotencyKey: worktreeIdempotencyKey(action),
      attemptId: action.parent_attempt_id,
      baseCommit,
    }).slice(0, 32),
  };
}

export function sha1SubjectForGitOperation(subject: string, label: string): string {
  if (!GIT_SHA1_SUBJECT.test(subject)) {
    throw new Error(`${label} must be a 40-character Git object ID for child Git operations`);
  }
  return subject;
}

export function finalRepairWorktreeHandleFor(
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

export function completedAttemptReceiptsFrom(
  attempts: readonly ExecutionWorkAttempt[]
): AttemptReceiptEntry[] {
  return attempts
    .filter((attempt) => attempt.status === "completed" && attempt.receipt)
    .map((attempt) => ({
      attempt,
      receipt: parseStandardReceipt(attempt.receipt!, { source: `child_action.${attempt.id}.receipt` }).value,
    }));
}

export function latestAttemptReceipt<T extends StandardReceipt>(
  receipts: readonly AttemptReceiptEntry[],
  type: T["type"],
  unitId: string | null,
  cycle?: number
): AttemptReceiptEntry<T> {
  let latest: AttemptReceiptEntry | undefined;
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
}

export function verifiedAggregateTreeSubject(input: {
  parentAttemptId: string;
  integrationSubject: string;
  attempts: readonly ExecutionWorkAttempt[];
  gates: readonly ExecutionGateReceipt[];
}): string {
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
}

// The one host-owned projection the derivation below cannot compute from the
// attempt ledger alone: the rejected-candidate fence check needs the producer
// the sealed manifest binding declared for that action, which the structured
// child runtime owns.
export type SubjectDerivationDeps = {
  store: ExecutionUnitStore;
  expectedProducerForAction: (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ) => ExpectedReceiptProducer;
};

export interface SubjectDerivation {
  // The exact commit a child action's worktree is cut from.
  worktreeBaseFor(instance: PipelineInstance, action: ExecutionWorkAttempt): string;
  // The base subject the action's receipt fence must carry.
  receiptBaseFor(instance: PipelineInstance, action: ExecutionWorkAttempt): string;
  // The subject the action actually reads (its predecessor's output).
  actionInputSubjectFor(instance: PipelineInstance, action: ExecutionWorkAttempt): string;
  completedAttemptReceiptsFor(parentAttemptId: string): AttemptReceiptEntry[];
  repairRejectedCandidateAttemptReceipt(
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts?: readonly AttemptReceiptEntry[]
  ): AttemptReceiptEntry<CandidateEvidenceReceipt>;
  assertPreparedUnitWorktreeRequestBound(
    request: Pick<LoopActionRequest | ChildExecutorActionRequest, "baseSubject" | "inputSubject" | "worktree">,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): void;
}

export function createSubjectDerivation(deps: SubjectDerivationDeps): SubjectDerivation {
  // The base every action that does not rebuild on a rejected candidate is cut
  // from: the graph's own integrated commit once one exists, else the sealed
  // instance subject.
  const graphWorktreeBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    const graph = deps.store.getGraphForAttempt(action.parent_attempt_id);
    const base = graph?.integration_subject ?? instance.immutable_subject ?? instance.base_commit;
    if (!GIT_SUBJECT.test(base)) throw new Error(`child action ${action.id} has no exact worktree base`);
    return base;
  };

  const worktreeBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    if (action.action_kind === "repair") return repairRejectedCandidateSubjectFor(instance, action);
    if (
      action.unit_id !== null &&
      action.cycle > 1 &&
      (
        action.action_kind === "simplify" ||
        action.action_kind === "command" ||
        action.action_kind === "candidate" ||
        action.action_kind === "lead"
      )
    ) {
      const unitCycleAttempts = deps.store.listWorkAttempts(action.parent_attempt_id).filter((attempt) =>
        attempt.unit_id === action.unit_id &&
        attempt.cycle === action.cycle
      );
      const hasRepairCycleWork = unitCycleAttempts.some((attempt) => attempt.action_kind === "repair");
      if (!hasRepairCycleWork) return graphWorktreeBaseFor(instance, action);
      const repairs = unitCycleAttempts.filter((attempt) =>
        attempt.action_kind === "repair" &&
        attempt.status === "completed");
      if (repairs.length !== 1) {
        throw new Error(`child action ${action.id} requires exactly one completed repair worktree for cycle ${action.cycle}`);
      }
      return repairRejectedCandidateSubjectFor(instance, repairs[0]!);
    }
    return graphWorktreeBaseFor(instance, action);
  };

  const receiptBaseFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string => {
    if (action.action_kind !== "final_review") return worktreeBaseFor(instance, action);
    if (action.request_payload) {
      try {
        const request = JSON.parse(action.request_payload) as { protocol?: unknown; baseSubject?: unknown };
        if (request.protocol === "loop-action@3" &&
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
    if (action.action_kind === "repair") return base;
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

  const completedAttemptReceiptsFor = (parentAttemptId: string): AttemptReceiptEntry[] =>
    completedAttemptReceiptsFrom(deps.store.listWorkAttempts(parentAttemptId));

  const repairRejectedCandidateAttemptReceipt = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts: readonly AttemptReceiptEntry[] = completedAttemptReceiptsFor(action.parent_attempt_id)
  ): AttemptReceiptEntry<CandidateEvidenceReceipt> => {
    if (action.action_kind !== "repair") throw new Error(`child action ${action.id} is not a unit repair`);
    if (action.unit_id === null) throw new Error(`child repair action ${action.id} has no unit id`);
    const rejectedCycle = action.cycle - 1;
    const candidates = receipts.filter((entry): entry is AttemptReceiptEntry<CandidateEvidenceReceipt> =>
      entry.attempt.action_kind === "candidate" &&
      entry.attempt.unit_id === action.unit_id &&
      entry.attempt.cycle === rejectedCycle &&
      entry.receipt.type === "candidate_evidence");
    if (candidates.length !== 1) {
      throw new Error(`child repair action ${action.id} requires exactly one rejected candidate evidence receipt for cycle ${rejectedCycle}`);
    }
    const candidate = candidates[0]!;
    if (
      candidate.receipt.assurance !== "executor_verified" ||
      candidate.receipt.result !== "success" ||
      !GIT_SUBJECT.test(candidate.receipt.subject.post)
    ) {
      throw new Error(`child repair action ${action.id} rejected candidate evidence is not executor verified`);
    }
    if (candidate.attempt.output_subject !== candidate.receipt.subject.post) {
      throw new Error(`child repair action ${action.id} rejected candidate subject disagrees with its action output`);
    }
    const candidateProducer = deps.expectedProducerForAction(instance, candidate.attempt);
    assertCandidateEvidenceFence({
      expected: {
        pipelineInstanceId: instance.id,
        graphDigest: instance.manifest_digest,
        unitId: candidate.attempt.unit_id ?? "__final__",
        attemptId: candidate.attempt.parent_attempt_id,
        parentRunId: candidate.attempt.parent_run_id,
        actionAttemptId: candidate.attempt.id,
        generation: instance.generation,
        nativeSessionId: candidate.receipt.fence.native_session_id,
        requestHash: candidate.attempt.request_hash ?? "",
        baseSubject: receiptBaseFor(instance, candidate.attempt),
        preSubject: actionInputSubjectFor(instance, candidate.attempt),
        subject: candidate.receipt.subject.post,
        producers: {
          completion: candidateProducer,
          candidate: candidateProducer,
          command: candidateProducer,
          lead: candidateProducer,
          integration: candidateProducer,
          review: candidateProducer,
        },
      },
      candidate: candidate.receipt,
    });
    return candidate;
  };

  const repairRejectedCandidateSubjectFor = (instance: PipelineInstance, action: ExecutionWorkAttempt): string =>
    repairRejectedCandidateAttemptReceipt(instance, action).receipt.subject.post;

  const assertPreparedUnitWorktreeRequestBound = (
    request: Pick<LoopActionRequest | ChildExecutorActionRequest, "baseSubject" | "inputSubject" | "worktree">,
    instance: PipelineInstance,
    action: ExecutionWorkAttempt
  ): void => {
    if (action.unit_id === null) return;
    if (
      action.action_kind !== "repair" &&
      action.action_kind !== "simplify" &&
      action.action_kind !== "command" &&
      action.action_kind !== "candidate" &&
      action.action_kind !== "lead"
    ) return;
    const expectedBase = sha1SubjectForGitOperation(worktreeBaseFor(instance, action), "child action base subject");
    const expectedInput = actionInputSubjectFor(instance, action);
    const expectedWorktree = action.action_kind === "lead" ? null : worktreeHandleFor(action, expectedBase).id;
    if (
      request.baseSubject !== expectedBase ||
      request.inputSubject !== expectedInput ||
      (expectedWorktree === null ? request.worktree !== null : request.worktree?.id !== expectedWorktree)
    ) {
      throw new Error(`child action ${action.id} prepared request is not bound to the current unit worktree`);
    }
  };

  return {
    worktreeBaseFor,
    receiptBaseFor,
    actionInputSubjectFor,
    completedAttemptReceiptsFor,
    repairRejectedCandidateAttemptReceipt,
    assertPreparedUnitWorktreeRequestBound,
  };
}
