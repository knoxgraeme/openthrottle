import { describe, expect, it } from "vitest";
import {
  KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES,
  validateKernelCheckpointAncestryChain,
  type KernelCheckpointAncestryEntry,
} from "./checkpoint-ancestry.js";

function edge(
  checkpointId: string,
  inputSubject: string,
  outputSubject: string,
): KernelCheckpointAncestryEntry {
  return {
    checkpoint_id: checkpointId,
    input_subject: inputSubject,
    output_subject: outputSubject,
  };
}

describe("checkpoint ancestry chain validation", () => {
  it("returns one canonical ordered linear chain", () => {
    const first = edge("checkpoint-1", "a", "b");
    const second = edge("checkpoint-2", "b", "c");

    expect(validateKernelCheckpointAncestryChain({
      entries: [second, first],
      start_subject: "a",
      end_subject: "c",
    })).toEqual([first, second]);
  });

  it("rejects a gap", () => {
    expect(() => validateKernelCheckpointAncestryChain({
      entries: [edge("checkpoint-1", "a", "b"), edge("checkpoint-2", "c", "d")],
      start_subject: "a",
      end_subject: "d",
    })).toThrow(/gap/i);
  });

  it("rejects a fork", () => {
    expect(() => validateKernelCheckpointAncestryChain({
      entries: [edge("checkpoint-1", "a", "b"), edge("checkpoint-2", "a", "c")],
      start_subject: "a",
      end_subject: "b",
    })).toThrow(/fork/i);
  });

  it("rejects a cycle", () => {
    expect(() => validateKernelCheckpointAncestryChain({
      entries: [edge("checkpoint-1", "a", "b"), edge("checkpoint-2", "b", "a")],
      start_subject: "a",
      end_subject: "c",
    })).toThrow(/cycle/i);
  });

  it("rejects disconnected checkpoints", () => {
    expect(() => validateKernelCheckpointAncestryChain({
      entries: [edge("checkpoint-1", "a", "b"), edge("checkpoint-2", "c", "d")],
      start_subject: "a",
      end_subject: "b",
    })).toThrow(/disconnected/i);
  });

  it("rejects a chain over the shared bound", () => {
    expect(() => validateKernelCheckpointAncestryChain({
      entries: Array.from(
        { length: KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES + 1 },
        (_, index) => edge(`checkpoint-${index}`, String(index), String(index + 1)),
      ),
      start_subject: "0",
      end_subject: String(KERNEL_CHECKPOINT_ANCESTRY_MAX_ENTRIES + 1),
    })).toThrow(/exceeds 64 checkpoints/i);
  });
});
