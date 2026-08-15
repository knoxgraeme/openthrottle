import {
  canonicalJson,
  digestNormalized,
  type CandidateEvidenceReceipt,
  type CommandResultReceipt,
  type SemanticReviewReceipt,
  type StandardReceipt,
  type UnitCompletionReceipt,
  type UnitDecisionReceipt,
} from "@openthrottle/contracts";
import {
  MAX_PRIOR_EVIDENCE_BYTES,
  MAX_PRIOR_EVIDENCE_RECEIPTS,
} from "../pipeline/structured-loop-limits.js";
import type { PipelineInstance } from "../pipeline/store.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { LoopActionRequest } from "../runtime/contracts.js";

// One completed child action paired with the standard receipt it sealed. The
// prior-evidence selectors below only ever read this projection, never the
// store, so they stay pure and directly testable.
export type AttemptReceiptEntry<T extends StandardReceipt = StandardReceipt> = {
  attempt: ExecutionWorkAttempt;
  receipt: T;
};

export type PriorEvidenceEnvelope = NonNullable<LoopActionRequest["priorEvidence"]>;

export type PriorEvidenceRole = PriorEvidenceEnvelope["receipts"][number]["role"];

export function unitCompletionAttemptReceipt(
  receipts: readonly AttemptReceiptEntry[],
  unitId: string | null,
  cycle: number
): AttemptReceiptEntry<UnitCompletionReceipt> {
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
}

// The lead decision that routed this unit back to `repair` (see
// routeUnitAcceptanceDecision / unit-store.ts): the store bumps
// current_cycle when it routes to repair, so the triggering lead ran one
// cycle earlier than the repair action it produced.
export function triggeringLeadDecisionAttemptReceipt(
  receipts: readonly AttemptReceiptEntry[],
  unitId: string,
  triggeringCycle: number
): AttemptReceiptEntry<UnitDecisionReceipt> {
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
}

// The most recent final_repair action's own unit_completion receipt for
// this cycle, when a repair round ran between the prior final_review and
// this one -- prior evidence for anti-churn (Q3), not required.
export function priorFinalRepairCompletionAttemptReceipt(
  receipts: readonly AttemptReceiptEntry[],
  cycle: number
): AttemptReceiptEntry<UnitCompletionReceipt> | undefined {
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
}

export function commandAttemptReceipts(
  receipts: readonly AttemptReceiptEntry[],
  unitId: string | null,
  cycle?: number
): Array<AttemptReceiptEntry<CommandResultReceipt>> {
  return receipts
    .filter((entry): entry is AttemptReceiptEntry<CommandResultReceipt> =>
      entry.receipt.type === "command_result" &&
      entry.receipt.fence.unit_id === (unitId ?? "__final__") &&
      (cycle === undefined || entry.attempt.cycle === cycle));
}

export function priorReceiptEntry(
  role: PriorEvidenceRole,
  entry: AttemptReceiptEntry
): PriorEvidenceEnvelope["receipts"][number] {
  const receipt = canonicalJson(entry.receipt);
  return {
    role,
    actionAttemptId: entry.attempt.id,
    receiptHash: digestNormalized(receipt),
    receipt,
  };
}

export function assertPriorEvidenceEnvelopeBound(
  evidence: PriorEvidenceEnvelope,
  action: ExecutionWorkAttempt
): void {
  if (evidence.receipts.length > MAX_PRIOR_EVIDENCE_RECEIPTS) {
    throw new Error(`child action ${action.id} prior evidence has too many receipts`);
  }
  if (Buffer.byteLength(canonicalJson(evidence), "utf8") > MAX_PRIOR_EVIDENCE_BYTES) {
    throw new Error(`child action ${action.id} prior evidence exceeds aggregate bound`);
  }
}

// Every assembled envelope leaves through here, so no role branch can seal
// prior evidence without first clearing both bounds.
function sealPriorEvidence(
  role: PriorEvidenceEnvelope["role"],
  action: ExecutionWorkAttempt,
  receipts: PriorEvidenceEnvelope["receipts"]
): PriorEvidenceEnvelope {
  const evidence = {
    schema: "openthrottle.loop-prior-evidence/v1",
    role,
    receipts,
  } satisfies PriorEvidenceEnvelope;
  assertPriorEvidenceEnvelopeBound(evidence, action);
  return evidence;
}

// Host-owned projections the assembler cannot derive from the receipt list
// alone: they read the sealed instance and the parent attempt's ledger, so
// they stay with the structured child runtime and are injected here.
export type PriorEvidenceDeps = {
  latestAttemptReceipt: <T extends StandardReceipt>(
    receipts: readonly AttemptReceiptEntry[],
    type: T["type"],
    unitId: string | null,
    cycle?: number
  ) => AttemptReceiptEntry<T>;
  repairRejectedCandidateAttemptReceipt: (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts?: readonly AttemptReceiptEntry[]
  ) => AttemptReceiptEntry<CandidateEvidenceReceipt>;
  actionInputSubjectFor: (instance: PipelineInstance, action: ExecutionWorkAttempt) => string;
};

export interface PriorEvidenceAssembler {
  priorEvidenceForAction(
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts: readonly AttemptReceiptEntry[]
  ): PriorEvidenceEnvelope | undefined;
}

export function createPriorEvidenceAssembler(deps: PriorEvidenceDeps): PriorEvidenceAssembler {
  const priorEvidenceForAction = (
    instance: PipelineInstance,
    action: ExecutionWorkAttempt,
    receipts: readonly AttemptReceiptEntry[]
  ): PriorEvidenceEnvelope | undefined => {
    if (action.action_kind === "lead") {
      let completion: AttemptReceiptEntry<UnitCompletionReceipt>;
      let candidate: AttemptReceiptEntry<CandidateEvidenceReceipt>;
      try {
        completion = unitCompletionAttemptReceipt(receipts, action.unit_id, action.cycle);
        candidate = deps.latestAttemptReceipt<CandidateEvidenceReceipt>(receipts, "candidate_evidence", action.unit_id, action.cycle);
      } catch {
        return undefined;
      }
      const commands = commandAttemptReceipts(receipts, action.unit_id, action.cycle);
      return sealPriorEvidence("lead", action, [
        priorReceiptEntry("completion", completion),
        priorReceiptEntry("candidate", candidate),
        ...commands.map((command) => priorReceiptEntry("command", command)),
      ]);
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
      const candidate = deps.repairRejectedCandidateAttemptReceipt(instance, action, receipts);
      return sealPriorEvidence("repair", action, [
        priorReceiptEntry("candidate", candidate),
        priorReceiptEntry("lead", lead),
        ...commands.map((command) => priorReceiptEntry("command", command)),
      ]);
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
              return deps.latestAttemptReceipt<SemanticReviewReceipt>(receipts, "semantic_review", null, action.cycle - 1);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const priorRepair = priorReview ? priorFinalRepairCompletionAttemptReceipt(receipts, action.cycle - 1) : undefined;
      return sealPriorEvidence("final_review", action, [
        ...commands.map((command) => priorReceiptEntry("final_command", command)),
        ...(priorReview ? [priorReceiptEntry("final_review", priorReview)] : []),
        ...(priorRepair ? [priorReceiptEntry("final_repair", priorRepair)] : []),
      ]);
    }
    if (action.action_kind === "final_repair") {
      let review: AttemptReceiptEntry<SemanticReviewReceipt>;
      try {
        review = deps.latestAttemptReceipt<SemanticReviewReceipt>(receipts, "semantic_review", null, action.cycle);
      } catch {
        throw new Error(`child final repair action ${action.id} has no triggering final-review receipt`);
      }
      if (review.attempt.action_kind !== "final_review" || review.attempt.request_hash !== review.receipt.fence.request_hash) {
        throw new Error(`child final repair action ${action.id} triggering final-review fence is invalid`);
      }
      const expectedSubject = deps.actionInputSubjectFor(instance, review.attempt);
      if (review.receipt.subject.post !== expectedSubject) {
        throw new Error(`child final repair action ${action.id} triggering final-review subject is stale`);
      }
      return sealPriorEvidence("final_repair", action, [priorReceiptEntry("final_review", review)]);
    }
    return undefined;
  };

  return { priorEvidenceForAction };
}
