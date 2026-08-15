import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized, type StandardReceipt } from "@openthrottle/contracts";
import { MAX_PRIOR_EVIDENCE_RECEIPTS } from "../pipeline/structured-loop-limits.js";
import type { PipelineInstance } from "../pipeline/store.js";
import type { ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import {
  assertPriorEvidenceEnvelopeBound,
  commandAttemptReceipts,
  createPriorEvidenceAssembler,
  priorFinalRepairCompletionAttemptReceipt,
  priorReceiptEntry,
  triggeringLeadDecisionAttemptReceipt,
  unitCompletionAttemptReceipt,
  type AttemptReceiptEntry,
  type PriorEvidenceDeps,
} from "./prior-evidence.js";

const SUBJECT = "b".repeat(40);
const REQUEST_HASH = "9".repeat(64);

function instance(overrides: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "instance-1",
    generation: 1,
    base_commit: "a".repeat(40),
    manifest_digest: "c".repeat(64),
    capability_digest: "d".repeat(64),
    ...overrides,
  } as PipelineInstance;
}

function attempt(overrides: Partial<ExecutionWorkAttempt> = {}): ExecutionWorkAttempt {
  return {
    id: "action-1",
    execution_graph_id: "graph-1",
    parent_attempt_id: "parent-attempt",
    parent_run_id: "run-1",
    unit_id: "unit_a",
    action_kind: "implement",
    cycle: 1,
    request_hash: REQUEST_HASH,
    ...overrides,
  } as ExecutionWorkAttempt;
}

// Only the fields the selectors and the envelope assembler actually read --
// receipt type, fence unit/request hash, and the sealed subject.
function receipt(input: {
  type: StandardReceipt["type"];
  unitId?: string | null;
  requestHash?: string;
  subject?: string;
  note?: string;
}): StandardReceipt {
  return {
    schema: "openthrottle.receipt/v1",
    type: input.type,
    assurance: "semantic_attested",
    result: "success",
    subject: { base: "a".repeat(40), pre: "a".repeat(40), post: input.subject ?? SUBJECT },
    fence: {
      unit_id: input.unitId === undefined ? "unit_a" : input.unitId ?? "__final__",
      request_hash: input.requestHash ?? REQUEST_HASH,
    },
    payload: { summary: input.note ?? "sealed" },
  } as unknown as StandardReceipt;
}

function entry(
  attemptOverrides: Partial<ExecutionWorkAttempt>,
  receiptInput: Parameters<typeof receipt>[0]
): AttemptReceiptEntry {
  return { attempt: attempt(attemptOverrides), receipt: receipt(receiptInput) };
}

function assemblerDeps(overrides: Partial<PriorEvidenceDeps> = {}): PriorEvidenceDeps {
  return {
    latestAttemptReceipt: (receipts, type, unitId, cycle) => {
      for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const candidate = receipts[index]!;
        if (
          candidate.receipt.type === type &&
          candidate.receipt.fence.unit_id === (unitId ?? "__final__") &&
          (cycle === undefined || candidate.attempt.cycle === cycle)
        ) {
          return candidate as never;
        }
      }
      throw new Error(`missing ${type} receipt for ${unitId ?? "final"}`);
    },
    repairRejectedCandidateAttemptReceipt: () =>
      entry(
        { id: "action-candidate", action_kind: "candidate", cycle: 1 },
        { type: "candidate_evidence" }
      ) as never,
    actionInputSubjectFor: () => SUBJECT,
    ...overrides,
  };
}

describe("prior evidence receipt selectors", () => {
  it("returns the last implement/repair unit_completion for the unit and cycle", () => {
    const receipts = [
      entry({ id: "action-implement", action_kind: "implement", cycle: 1 }, { type: "unit_completion" }),
      entry({ id: "action-other-cycle", action_kind: "repair", cycle: 2 }, { type: "unit_completion" }),
      entry({ id: "action-simplify", action_kind: "simplify", cycle: 1 }, { type: "unit_completion" }),
    ];
    expect(unitCompletionAttemptReceipt(receipts, "unit_a", 1).attempt.id).toBe("action-implement");
    expect(unitCompletionAttemptReceipt(receipts, "unit_a", 2).attempt.id).toBe("action-other-cycle");
  });

  it("rejects a unit_completion lookup with no implement or repair receipt", () => {
    const receipts = [
      entry({ id: "action-simplify", action_kind: "simplify", cycle: 1 }, { type: "unit_completion" }),
    ];
    expect(() => unitCompletionAttemptReceipt(receipts, "unit_a", 1))
      .toThrow("missing implement/repair unit_completion receipt for unit_a");
  });

  it("resolves the lead decision that triggered a repair at the prior cycle", () => {
    const receipts = [
      entry({ id: "action-lead-1", action_kind: "lead", cycle: 1 }, { type: "unit_decision" }),
      entry({ id: "action-lead-other-unit", action_kind: "lead", cycle: 1, unit_id: "unit_b" }, { type: "unit_decision" }),
    ];
    expect(triggeringLeadDecisionAttemptReceipt(receipts, "unit_a", 1).attempt.id).toBe("action-lead-1");
    expect(() => triggeringLeadDecisionAttemptReceipt(receipts, "unit_a", 2))
      .toThrow("missing triggering lead unit_decision receipt for unit_a cycle 2");
  });

  it("treats a prior final_repair completion as optional", () => {
    const receipts = [
      entry({ id: "action-final-repair", action_kind: "final_repair", cycle: 1, unit_id: null }, { type: "unit_completion", unitId: null }),
    ];
    expect(priorFinalRepairCompletionAttemptReceipt(receipts, 1)?.attempt.id).toBe("action-final-repair");
    expect(priorFinalRepairCompletionAttemptReceipt(receipts, 2)).toBeUndefined();
    expect(priorFinalRepairCompletionAttemptReceipt([], 1)).toBeUndefined();
  });

  it("filters command receipts by fenced unit and optional cycle", () => {
    const receipts = [
      entry({ id: "action-command-1", action_kind: "command", cycle: 1 }, { type: "command_result" }),
      entry({ id: "action-command-2", action_kind: "command", cycle: 2 }, { type: "command_result" }),
      entry({ id: "action-final-command", action_kind: "final_command", cycle: 1, unit_id: null }, { type: "command_result", unitId: null }),
    ];
    expect(commandAttemptReceipts(receipts, "unit_a").map((command) => command.attempt.id))
      .toEqual(["action-command-1", "action-command-2"]);
    expect(commandAttemptReceipts(receipts, "unit_a", 2).map((command) => command.attempt.id))
      .toEqual(["action-command-2"]);
    expect(commandAttemptReceipts(receipts, null, 1).map((command) => command.attempt.id))
      .toEqual(["action-final-command"]);
  });

  it("seals a prior receipt entry to the canonical receipt and its hash", () => {
    const source = entry({ id: "action-lead-1", action_kind: "lead", cycle: 1 }, { type: "unit_decision" });
    const sealed = priorReceiptEntry("lead", source);
    expect(sealed.role).toBe("lead");
    expect(sealed.actionAttemptId).toBe("action-lead-1");
    expect(sealed.receipt).toBe(canonicalJson(source.receipt));
    expect(sealed.receiptHash).toBe(digestNormalized(sealed.receipt));
  });
});

describe("prior evidence envelope bound", () => {
  const action = attempt({ id: "action-lead-1", action_kind: "lead" });

  function envelope(count: number, note = "sealed") {
    return {
      schema: "openthrottle.loop-prior-evidence/v1" as const,
      role: "lead" as const,
      receipts: Array.from({ length: count }, (_unused, index) =>
        priorReceiptEntry("command", entry({ id: `action-command-${index}` }, { type: "command_result", note }))),
    };
  }

  it("accepts an envelope inside both bounds", () => {
    expect(() => assertPriorEvidenceEnvelopeBound(envelope(MAX_PRIOR_EVIDENCE_RECEIPTS), action)).not.toThrow();
  });

  it("rejects an envelope with too many receipts", () => {
    expect(() => assertPriorEvidenceEnvelopeBound(envelope(MAX_PRIOR_EVIDENCE_RECEIPTS + 1), action))
      .toThrow("child action action-lead-1 prior evidence has too many receipts");
  });

  it("rejects an envelope over the aggregate byte bound", () => {
    expect(() => assertPriorEvidenceEnvelopeBound(envelope(4, "x".repeat(16_384)), action))
      .toThrow("child action action-lead-1 prior evidence exceeds aggregate bound");
  });
});

describe("prior evidence assembly", () => {
  const { priorEvidenceForAction } = createPriorEvidenceAssembler(assemblerDeps());

  it("assembles lead evidence as completion, candidate, then commands", () => {
    const receipts = [
      entry({ id: "action-implement", action_kind: "implement", cycle: 1 }, { type: "unit_completion" }),
      entry({ id: "action-candidate", action_kind: "candidate", cycle: 1 }, { type: "candidate_evidence" }),
      entry({ id: "action-command", action_kind: "command", cycle: 1 }, { type: "command_result" }),
    ];
    const evidence = priorEvidenceForAction(
      instance(),
      attempt({ id: "action-lead", action_kind: "lead", cycle: 1 }),
      receipts
    );
    expect(evidence?.role).toBe("lead");
    expect(evidence?.receipts.map((sealed) => sealed.role)).toEqual(["completion", "candidate", "command"]);
    expect(evidence?.receipts.map((sealed) => sealed.actionAttemptId))
      .toEqual(["action-implement", "action-candidate", "action-command"]);
  });

  it("returns no lead evidence until the completion and candidate are both sealed", () => {
    const receipts = [
      entry({ id: "action-implement", action_kind: "implement", cycle: 1 }, { type: "unit_completion" }),
    ];
    expect(priorEvidenceForAction(
      instance(),
      attempt({ id: "action-lead", action_kind: "lead", cycle: 1 }),
      receipts
    )).toBeUndefined();
  });

  it("assembles repair evidence from the rejected candidate and the triggering lead", () => {
    const receipts = [
      entry({ id: "action-lead-1", action_kind: "lead", cycle: 1 }, { type: "unit_decision" }),
      entry({ id: "action-command-1", action_kind: "command", cycle: 1 }, { type: "command_result" }),
      entry({ id: "action-command-2", action_kind: "command", cycle: 2 }, { type: "command_result" }),
    ];
    const evidence = priorEvidenceForAction(
      instance(),
      attempt({ id: "action-repair", action_kind: "repair", cycle: 2 }),
      receipts
    );
    expect(evidence?.role).toBe("repair");
    expect(evidence?.receipts.map((sealed) => sealed.actionAttemptId))
      .toEqual(["action-candidate", "action-lead-1", "action-command-1"]);
  });

  it("rejects repair evidence whose triggering lead receipt is off its own request hash", () => {
    const receipts = [
      entry(
        { id: "action-lead-1", action_kind: "lead", cycle: 1, request_hash: "1".repeat(64) },
        { type: "unit_decision" }
      ),
    ];
    expect(() => priorEvidenceForAction(
      instance(),
      attempt({ id: "action-repair", action_kind: "repair", cycle: 2 }),
      receipts
    )).toThrow("child repair action action-repair triggering lead fence is invalid");
  });

  it("carries the prior round's review and intervening final repair into a re-review", () => {
    const receipts = [
      entry({ id: "action-review-1", action_kind: "final_review", cycle: 1, unit_id: null }, { type: "semantic_review", unitId: null }),
      entry({ id: "action-final-repair", action_kind: "final_repair", cycle: 1, unit_id: null }, { type: "unit_completion", unitId: null }),
      entry({ id: "action-final-command", action_kind: "final_command", cycle: 2, unit_id: null }, { type: "command_result", unitId: null }),
    ];
    const evidence = priorEvidenceForAction(
      instance(),
      attempt({ id: "action-review-2", action_kind: "final_review", cycle: 2, unit_id: null }),
      receipts
    );
    expect(evidence?.role).toBe("final_review");
    expect(evidence?.receipts.map((sealed) => sealed.role)).toEqual(["final_command", "final_review", "final_repair"]);
  });

  it("omits the prior final repair from a first-round review", () => {
    const receipts = [
      entry({ id: "action-final-command", action_kind: "final_command", cycle: 1, unit_id: null }, { type: "command_result", unitId: null }),
    ];
    const evidence = priorEvidenceForAction(
      instance(),
      attempt({ id: "action-review-1", action_kind: "final_review", cycle: 1, unit_id: null }),
      receipts
    );
    expect(evidence?.receipts.map((sealed) => sealed.role)).toEqual(["final_command"]);
  });

  it("binds final repair evidence to the triggering review", () => {
    const receipts = [
      entry({ id: "action-review-1", action_kind: "final_review", cycle: 1, unit_id: null }, { type: "semantic_review", unitId: null }),
    ];
    const evidence = priorEvidenceForAction(
      instance(),
      attempt({ id: "action-final-repair", action_kind: "final_repair", cycle: 1, unit_id: null }),
      receipts
    );
    expect(evidence?.role).toBe("final_repair");
    expect(evidence?.receipts.map((sealed) => sealed.role)).toEqual(["final_review"]);
  });

  it("rejects final repair evidence whose triggering review subject is stale", () => {
    const receipts = [
      entry(
        { id: "action-review-1", action_kind: "final_review", cycle: 1, unit_id: null },
        { type: "semantic_review", unitId: null, subject: "e".repeat(40) }
      ),
    ];
    expect(() => priorEvidenceForAction(
      instance(),
      attempt({ id: "action-final-repair", action_kind: "final_repair", cycle: 1, unit_id: null }),
      receipts
    )).toThrow("child final repair action action-final-repair triggering final-review subject is stale");
  });

  it("rejects final repair evidence with no triggering review at all", () => {
    expect(() => priorEvidenceForAction(
      instance(),
      attempt({ id: "action-final-repair", action_kind: "final_repair", cycle: 1, unit_id: null }),
      []
    )).toThrow("child final repair action action-final-repair has no triggering final-review receipt");
  });

  it("seals no evidence for action kinds that do not carry any", () => {
    expect(priorEvidenceForAction(
      instance(),
      attempt({ id: "action-implement", action_kind: "implement", cycle: 1 }),
      []
    )).toBeUndefined();
  });
});
