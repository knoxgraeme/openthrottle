import { describe, expect, it } from "vitest";
import type { ExecutionPlanContract, ExecutionPlanContractV2 } from "@openthrottle/contracts";
import { canonicalJson } from "./manifest.js";
import {
  MAX_VALID_DOWNSTREAM_CONTEXT,
  assertStructuredPlanLoopEnvelopeBound,
  loopActionPlanContext,
  structuredPlanLoopEnvelopeBytes,
} from "./structured-loop-envelope.js";
import {
  MAX_DOWNSTREAM_CONTEXT_BYTES,
  MAX_DOWNSTREAM_CONTEXT_RECORDS,
  MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES,
  MAX_LOOP_REQUEST_ENVELOPE_BYTES,
} from "./structured-loop-limits.js";

function unitPlan(unitCount: number): ExecutionPlanContract {
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "downstream-context-bound",
    instructions: { one: "Implement the unit." },
    acceptance: { done: "Unit is done." },
    units: Array.from({ length: unitCount }, (_, index) => ({
      id: `unit_${index}`,
      title: `Unit ${index}`,
      depends_on: [],
      instructions: ["one"],
      acceptance: ["done"],
    })),
    commands: [],
  };
}

function longIdentifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString().padStart(3, "0")}_${"segment_".repeat(18)}tail`;
}

function denseLegacyPlan(): ExecutionPlanContract {
  const instructionIds = Array.from({ length: 64 }, (_, index) => longIdentifier("instruction", index));
  const acceptanceIds = Array.from({ length: 64 }, (_, index) => longIdentifier("acceptance", index));
  const unitIds = Array.from({ length: 64 }, (_, index) => longIdentifier("unit", index));
  const instructions = Object.fromEntries(instructionIds.map((id, index) => [
    id,
    `Instruction ${index}: preserve behavior.`,
  ]));
  const acceptance = Object.fromEntries(acceptanceIds.map((id, index) => [
    id,
    `Acceptance ${index}: verify behavior.`,
  ]));
  const units = Array.from({ length: 64 }, (_, index) => {
    const id = unitIds[index]!;
    return {
      id,
      title: `Dense legacy unit ${index} ${"with a bounded but descriptive title ".repeat(3)}`,
      depends_on: unitsBefore(index).map((dependencyIndex) => unitIds[dependencyIndex]!),
      instructions: instructionIds,
      acceptance: acceptanceIds,
    };
  });
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "dense_legacy_final_review_context",
    instructions,
    acceptance,
    units,
    commands: [
      { name: "test" },
      { name: "lint" },
      { name: "build" },
      { name: "test", unit: units[63]!.id },
    ],
  };
}

function finalReviewPlanWithReferencedText(input: {
  planId: string;
  instructionText: string;
  acceptanceText: string;
}): ExecutionPlanContract {
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: input.planId,
    instructions: { instruction: input.instructionText },
    acceptance: { acceptance: input.acceptanceText },
    units: [
      {
        id: "unit",
        title: "Unit",
        depends_on: [],
        instructions: ["instruction"],
        acceptance: ["acceptance"],
      },
    ],
    commands: [],
  };
}

function compactableFinalReviewPlan(): ExecutionPlanContract {
  const instructionIds = Array.from({ length: 24 }, (_, index) => `instruction_${index}`);
  const acceptanceIds = Array.from({ length: 24 }, (_, index) => `acceptance_${index}`);
  const instructions = Object.fromEntries(instructionIds.map((id, index) => [
    id,
    `Instruction ${index} ${"preserve complete requirements before compacting ".repeat(35)}tail-${index}`,
  ]));
  const acceptance = Object.fromEntries(acceptanceIds.map((id, index) => [
    id,
    `Acceptance ${index} ${"verify complete criteria before compacting ".repeat(35)}tail-${index}`,
  ]));
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "compactable_final_review_context",
    instructions,
    acceptance,
    units: [
      {
        id: "unit",
        title: `${"Long final review unit title ".repeat(8)}tail`,
        depends_on: [],
        instructions: instructionIds,
        acceptance: acceptanceIds,
      },
    ],
    commands: [{ name: "test" }],
  };
}

function titleOnlyCompactFinalReviewPlan(): ExecutionPlanContract {
  const instructionIds = Array.from({ length: 16 }, (_, index) => `i${index}`);
  const acceptanceIds = Array.from({ length: 16 }, (_, index) => `a${index}`);
  const instructions = Object.fromEntries(instructionIds.map((id, index) => [
    id,
    `${"i".repeat(420)}instruction-tail-${index}`,
  ]));
  const acceptance = Object.fromEntries(acceptanceIds.map((id, index) => [
    id,
    `${"a".repeat(420)}acceptance-tail-${index}`,
  ]));
  return {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "title_only_compact_final_review_context",
    instructions,
    acceptance,
    units: Array.from({ length: 64 }, (_, index) => ({
      id: `u${index}`,
      title: `Unit ${index} ${"title context ".repeat(21)}tail`,
      depends_on: [],
      instructions: instructionIds,
      acceptance: acceptanceIds,
    })),
    commands: [],
  };
}

function unitsBefore(index: number): number[] {
  const first = Math.max(0, index - 32);
  return Array.from({ length: index - first }, (_, offset) => first + offset);
}

describe("downstream-context admission bound", () => {
  it("reserves exactly the shared canonical aggregate maximum, not a representative sample", () => {
    const bytes = Buffer.byteLength(canonicalJson(MAX_VALID_DOWNSTREAM_CONTEXT), "utf8");
    expect(bytes).toBe(MAX_DOWNSTREAM_CONTEXT_BYTES);
    expect(MAX_VALID_DOWNSTREAM_CONTEXT.length).toBeLessThanOrEqual(MAX_DOWNSTREAM_CONTEXT_RECORDS);
  });

  it("keeps every reserved record's payload within the sandbox's per-record cap", () => {
    for (const record of MAX_VALID_DOWNSTREAM_CONTEXT) {
      const payloadBytes = Buffer.byteLength(canonicalJson(record.payload), "utf8");
      expect(payloadBytes).toBeLessThanOrEqual(MAX_DOWNSTREAM_CONTEXT_RECORD_PAYLOAD_BYTES);
    }
  });

  it("dispatches a plan whose sealed envelope carries the true maximum downstream-context aggregate", () => {
    const bytes = structuredPlanLoopEnvelopeBytes(unitPlan(1));
    expect(bytes).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
  });

  it("reserves more than the ticket's reproduced 31,041-byte representative sample", () => {
    // Regression guard for the exact reproduction in the ticket: the old probe
    // (32 records of a fixed 760-character summary) serialized to 31,041
    // bytes, under-reserving the true 32,768-byte canonical maximum and
    // letting a boundary-admitted plan become oversized only after
    // provisioning. Today's reservation must exceed that under-sized sample.
    const oldRepresentativeSampleBytes = (() => {
      const records = Array.from({ length: 32 }, (_, index) => {
        const payload = {
          schema: "openthrottle.downstream-context/v1",
          from_unit_id: `upstream-${index.toString(16).padStart(2, "0")}`,
          summary: "x".repeat(760),
        };
        return { fromUnitId: payload.from_unit_id, payloadHash: "0".repeat(64), payload };
      });
      return Buffer.byteLength(canonicalJson(records), "utf8");
    })();
    expect(oldRepresentativeSampleBytes).toBe(31_041);
    const trueMaxBytes = Buffer.byteLength(canonicalJson(MAX_VALID_DOWNSTREAM_CONTEXT), "utf8");
    expect(trueMaxBytes).toBeGreaterThan(oldRepresentativeSampleBytes);
    expect(trueMaxBytes).toBe(MAX_DOWNSTREAM_CONTEXT_BYTES);
  });

  it("supplies bounded whole-plan intent and acceptance context to final review", () => {
    const plan: ExecutionPlanContract = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "final-review-context",
      instructions: {
        build_api: "Build the API behavior.",
        build_ui: "Build the UI behavior.",
      },
      acceptance: {
        api_done: "The API accepts the new input.",
        ui_done: "The UI renders the new state.",
      },
      units: [
        {
          id: "api",
          title: "API",
          depends_on: [],
          instructions: ["build_api"],
          acceptance: ["api_done"],
        },
        {
          id: "ui",
          title: "UI",
          depends_on: ["api"],
          instructions: ["build_ui"],
          acceptance: ["ui_done"],
        },
      ],
      commands: [{ name: "test" }],
    };

    const context = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null });

    expect(context).toMatchObject({
      schema: "openthrottle.loop-action-plan-context/v1",
      whole_plan: true,
      unit: null,
      instructions: {
        build_api: "Build the API behavior.",
        build_ui: "Build the UI behavior.",
      },
      acceptance: {
        api_done: "The API accepts the new input.",
        ui_done: "The UI renders the new state.",
      },
    });
    expect(Buffer.byteLength(canonicalJson(context), "utf8")).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
  });

  it("seals deterministic review fanout context into unit lead and final-review requests", () => {
    const plan: ExecutionPlanContract = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "unit-lead-review-fanout",
      instructions: {
        runtime: "Implement bounded fanout dispatch, receipt fences, exact roster rereview, and repair settlement.",
      },
      acceptance: {
        safe: "Validation controls the gate and the roster reruns exactly after repair.",
      },
      units: [{
        id: "fanout_runtime",
        title: "Implement deterministic persona fanout and validated repair",
        depends_on: [],
        instructions: ["runtime"],
        acceptance: ["safe"],
      }],
      commands: [{ name: "test" }, { name: "build" }],
    };

    const context = loopActionPlanContext({
      plan,
      actionKind: "lead",
      unitId: "fanout_runtime",
      reviewSubject: "1".repeat(40),
    }) as { review_fanout: { subject: string; personas: Array<{ id: string }>; max_parallel: number } };

    expect(context.review_fanout.subject).toBe("1".repeat(40));
    expect(context.review_fanout.personas.map((persona) => persona.id)).toEqual([
      "correctness-dataflow",
      "tests-contracts",
      "reliability-adversarial",
      "agent-native-contracts",
      "performance",
    ]);
    expect(context.review_fanout.max_parallel).toBe(1);

    const finalReviewContext = loopActionPlanContext({
      plan,
      actionKind: "final_review",
      unitId: null,
      reviewSubject: "2".repeat(40),
    }) as { review_fanout: { subject: string; roster_digest: string; personas: Array<{ id: string }> } };
    expect(finalReviewContext.review_fanout).toMatchObject({
      subject: "2".repeat(40),
      roster_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      personas: expect.arrayContaining([
        expect.objectContaining({ id: "correctness-dataflow" }),
        expect.objectContaining({ id: "tests-contracts" }),
      ]),
    });
  });

  it("preserves valid 1,001-2,000 character final-review criteria when the full context fits", () => {
    const instructionTail = "INSTRUCTION_TAIL_SENTINEL";
    const acceptanceTail = "ACCEPTANCE_TAIL_SENTINEL";
    const plan = finalReviewPlanWithReferencedText({
      planId: "small_complete_final_review_context",
      instructionText: `${"i".repeat(1_450)}${instructionTail}`,
      acceptanceText: `${"a".repeat(1_450)}${acceptanceTail}`,
    });

    const context = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null }) as {
      instructions: Record<string, string>;
      acceptance: Record<string, string>;
      truncated?: boolean;
      context_complete?: boolean;
    };

    expect(Buffer.byteLength(canonicalJson(context), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(context.truncated).toBeUndefined();
    expect(context.context_complete).toBeUndefined();
    expect(context.instructions.instruction).toBe(plan.instructions.instruction);
    expect(context.acceptance.acceptance).toBe(plan.acceptance.acceptance);
    expect(context.instructions.instruction).toContain(instructionTail);
    expect(context.acceptance.acceptance).toContain(acceptanceTail);
  });

  it("marks compact final-review context incomplete only after the full context exceeds the byte limit", () => {
    const plan = compactableFinalReviewPlan();
    const completeShape = {
      schema: "openthrottle.loop-action-plan-context/v1",
      graph_id: plan.graph_id,
      plan_id: plan.plan_id,
      action_kind: "final_review",
      unit: null,
      whole_plan: true,
      units: plan.units,
      instructions: plan.instructions,
      acceptance: plan.acceptance,
      commands: plan.commands,
    };
    expect(Buffer.byteLength(canonicalJson(completeShape), "utf8")).toBeGreaterThan(48 * 1024);

    const first = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null }) as {
      truncation: Record<string, unknown>;
      truncated: boolean;
      context_complete: boolean;
      instructions: Record<string, string>;
      acceptance: Record<string, string>;
      units: Array<{ title: string }>;
    };
    const second = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null });

    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(Buffer.byteLength(canonicalJson(first), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(first.context_complete).toBe(false);
    expect(first.truncated).toBe(true);
    expect(first.truncation).toMatchObject({
      reason: "final_review_plan_context_byte_limit",
      limit_bytes: 48 * 1024,
      unit_count: 1,
      referenced_instruction_count: 24,
      referenced_acceptance_count: 24,
      omitted_instruction_detail_count: 0,
      omitted_acceptance_detail_count: 0,
      truncated_unit_title_count: 1,
      truncated_instruction_detail_count: 24,
      truncated_acceptance_detail_count: 24,
    });
    expect(typeof first.truncation.full_detail_digest).toBe("string");
    expect(first.instructions.instruction_0).not.toContain("tail-0");
    expect(first.acceptance.acceptance_0).not.toContain("tail-0");
    expect(first.units[0]!.title).not.toContain("tail");
  });

  it("preserves criteria in compact final-review context when title compaction is enough", () => {
    const plan = titleOnlyCompactFinalReviewPlan();
    const completeShape = {
      schema: "openthrottle.loop-action-plan-context/v1",
      graph_id: plan.graph_id,
      plan_id: plan.plan_id,
      action_kind: "final_review",
      unit: null,
      whole_plan: true,
      units: plan.units,
      instructions: plan.instructions,
      acceptance: plan.acceptance,
      commands: plan.commands,
    };
    expect(Buffer.byteLength(canonicalJson(completeShape), "utf8")).toBeGreaterThan(48 * 1024);

    const context = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null }) as {
      truncation: Record<string, unknown>;
      truncated: boolean;
      instructions: Record<string, string>;
      acceptance: Record<string, string>;
      units: Array<{ title: string }>;
    };

    expect(Buffer.byteLength(canonicalJson(context), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(context.truncated).toBe(true);
    expect(context.truncation).toMatchObject({
      truncated_unit_title_count: 64,
      truncated_instruction_detail_count: 0,
      truncated_acceptance_detail_count: 0,
    });
    expect(context.instructions.i0).toBe(plan.instructions.i0);
    expect(context.acceptance.a0).toBe(plan.acceptance.a0);
    expect(context.instructions.i0).toContain("instruction-tail-0");
    expect(context.acceptance.a0).toContain("acceptance-tail-0");
    expect(context.units[0]!.title).not.toContain("tail");
  });

  it("uses canonical UTF-8 byte counts at the final-review completeness boundary", () => {
    const planFor = (entries: number): ExecutionPlanContract => {
      const instructionIds = Array.from({ length: entries }, (_, index) => `instruction_${index}`);
      const acceptanceIds = Array.from({ length: entries }, (_, index) => `acceptance_${index}`);
      return {
        schema: "openthrottle.execution-plan/v1",
        graph_id: "structured",
        plan_id: `utf8_boundary_${entries}`,
        instructions: Object.fromEntries(instructionIds.map((id) => [id, `${"界".repeat(1_000)}tail`])),
        acceptance: Object.fromEntries(acceptanceIds.map((id) => [id, `${"界".repeat(1_000)}tail`])),
        units: [
          {
            id: "unit",
            title: "Unit",
            depends_on: [],
            instructions: instructionIds,
            acceptance: acceptanceIds,
          },
        ],
        commands: [],
      };
    };
    let maxComplete = 0;
    for (let entries = 1; entries < 40; entries += 1) {
      const context = loopActionPlanContext({ plan: planFor(entries), actionKind: "final_review", unitId: null });
      if ((context as { truncated?: boolean }).truncated) break;
      maxComplete = entries;
    }

    const complete = loopActionPlanContext({ plan: planFor(maxComplete), actionKind: "final_review", unitId: null }) as {
      truncated?: boolean;
      instructions: Record<string, string>;
    };
    const compact = loopActionPlanContext({ plan: planFor(maxComplete + 1), actionKind: "final_review", unitId: null }) as {
      truncated: boolean;
      context_complete: boolean;
      truncation: Record<string, unknown>;
    };

    expect(maxComplete).toBeGreaterThan(0);
    expect(Buffer.byteLength(canonicalJson(complete), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(complete.truncated).toBeUndefined();
    expect(complete.instructions.instruction_0).toContain("tail");
    expect(Buffer.byteLength(canonicalJson(compact), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(compact.context_complete).toBe(false);
    expect(compact.truncated).toBe(true);
    expect(compact.truncation.reason).toBe("final_review_plan_context_byte_limit");
  });

  it("byte-bounds adversarial legacy final-review fallback context with explicit omission metadata", () => {
    const plan = denseLegacyPlan();
    const oldFallback = {
      schema: "openthrottle.loop-action-plan-context/v1",
      graph_id: plan.graph_id,
      plan_id: plan.plan_id,
      action_kind: "final_review",
      unit: null,
      whole_plan: true,
      truncated: true,
      units: plan.units.map((unit) => ({
        id: unit.id,
        title: unit.title.length <= 120 ? unit.title : `${unit.title.slice(0, 120)}...`,
        depends_on: unit.depends_on,
        instructions: unit.instructions,
        acceptance: unit.acceptance,
      })),
      commands: plan.commands.map((command) => ({ name: command.name, unit: command.unit })),
    };
    expect(Buffer.byteLength(canonicalJson(oldFallback), "utf8")).toBeGreaterThan(227 * 1024);

    const first = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null });
    const second = loopActionPlanContext({ plan, actionKind: "final_review", unitId: null });

    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(Buffer.byteLength(canonicalJson(first), "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(structuredPlanLoopEnvelopeBytes(plan)).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
    expect(first).toMatchObject({
      whole_plan: true,
      context_complete: false,
      truncated: true,
      truncation: {
        reason: "final_review_plan_context_byte_limit",
        unit_count: 64,
        dependency_reference_count: 1_520,
        instruction_reference_count: 4_096,
        acceptance_reference_count: 4_096,
        referenced_instruction_count: 64,
        referenced_acceptance_count: 64,
        command_count: 4,
        omitted_dependency_reference_count: 1_520,
        omitted_instruction_reference_count: 4_096,
        omitted_acceptance_reference_count: 4_096,
        omitted_instruction_detail_count: 64,
        omitted_acceptance_detail_count: 64,
      },
      unit_details: {
        format: "parallel_arrays",
      },
      instructions_summary: {
        referenced_count: 64,
      },
      acceptance_summary: {
        referenced_count: 64,
      },
    });
    const unitDetails = first?.unit_details as { ids: string[]; titles: string[]; detail_counts: number[][] };
    expect(unitDetails.ids).toHaveLength(64);
    expect(unitDetails.ids[0]).toBe(plan.units[0]!.id);
    expect(unitDetails.ids[63]).toBe(plan.units[63]!.id);
    expect(unitDetails.titles[0]).toContain("Dense legacy unit 0");
    expect(unitDetails.detail_counts[63]).toEqual([32, 64, 64]);
  });
});

function twoUnitPlanV2(): ExecutionPlanContractV2 {
  return {
    schema: "openthrottle.execution-plan/v2",
    graph_id: "structured",
    plan_id: "v2-dispatch-context",
    units: [
      {
        id: "api",
        title: "API",
        depends_on: [],
        objective: "Build the API behavior.",
        requirements: ["The API must accept the new input shape."],
        files: ["src/api.ts"],
        approach: ["Add the new field to the handler."],
        tests: ["A request with the new field is accepted."],
        acceptance: ["The API accepts the new input."],
        verification: ["Run the API test suite."],
      },
      {
        id: "ui",
        title: "UI",
        depends_on: ["api"],
        objective: "Build the UI behavior.",
        requirements: ["The UI must render the new state."],
        files: ["src/ui.ts"],
        approach: ["Render the new field."],
        tests: ["The new state renders correctly."],
        acceptance: ["The UI renders the new state."],
        verification: ["Run the UI test suite."],
      },
    ],
    commands: [{ name: "test" }],
  };
}

describe("v2 self-contained execution-plan dispatch context", () => {
  it("projects exactly the selected unit's complete typed context, excluding unrelated units and any full-plan text", () => {
    const plan = twoUnitPlanV2();

    const context = loopActionPlanContext({ plan, actionKind: "implement", unitId: "api" }) as {
      unit: Record<string, unknown>;
      commands: Array<{ name: string }>;
    };

    expect(context.unit).toEqual({
      id: "api",
      title: "API",
      depends_on: [],
      objective: "Build the API behavior.",
      requirements: ["The API must accept the new input shape."],
      files: ["src/api.ts"],
      approach: ["Add the new field to the handler."],
      tests: ["A request with the new field is accepted."],
      acceptance: ["The API accepts the new input."],
      verification: ["Run the API test suite."],
    });
    // No unrelated unit's detail, and no plan-level instructions/acceptance
    // map (v1's index-over-source-prose shape) leaks into the dispatched context.
    expect(context).not.toHaveProperty("instructions");
    expect(context).not.toHaveProperty("acceptance");
    expect(context).not.toHaveProperty("units");
    expect(JSON.stringify(context.unit)).not.toContain("\"ui\"");
    expect(JSON.stringify(context.unit)).not.toContain("UI");
  });

  it("keeps the final-review whole-plan context lightweight and bounded, still projecting a review-fanout roster", () => {
    const plan = twoUnitPlanV2();

    const context = loopActionPlanContext({
      plan,
      actionKind: "final_review",
      unitId: null,
      reviewSubject: "1".repeat(40),
    }) as {
      whole_plan: boolean;
      units: Array<{ id: string; title: string }>;
      review_fanout: { subject: string; personas: Array<{ id: string }> };
    };

    expect(context.whole_plan).toBe(true);
    expect(context.units).toEqual([
      { id: "api", title: "API", depends_on: [] },
      { id: "ui", title: "UI", depends_on: ["api"] },
    ]);
    expect(context.review_fanout.subject).toBe("1".repeat(40));
    expect(context.review_fanout.personas.map((persona) => persona.id)).toContain("correctness-dataflow");
    expect(Buffer.byteLength(canonicalJson(context), "utf8")).toBeLessThanOrEqual(48 * 1024);
  });

  it.each(["lead", "repair"] as const)(
    "projects selected-unit completeness and sibling exclusion into v2 %s review fanout",
    (actionKind) => {
      const plan = twoUnitPlanV2();

      const context = loopActionPlanContext({
        plan,
        actionKind,
        unitId: "api",
        reviewSubject: "2".repeat(40),
      }) as {
        unit: Record<string, unknown>;
        review_fanout: { subject: string; personas: Array<{ id: string }> };
      };

      expect(context.unit).toMatchObject({
        id: "api",
        requirements: ["The API must accept the new input shape."],
        acceptance: ["The API accepts the new input."],
        verification: ["Run the API test suite."],
      });
      expect(JSON.stringify(context)).not.toContain("The UI must render the new state.");
      expect(context.review_fanout.subject).toBe("2".repeat(40));
      expect(context.review_fanout.personas.map((persona) => persona.id)).toContain("tests-contracts");
    }
  );

  function unitAtFieldScale(id: string, scale: number): ExecutionPlanContractV2["units"][number] {
    return {
      id,
      title: `Unit ${id}`,
      depends_on: [],
      objective: "x".repeat(scale),
      requirements: Array.from({ length: 2 }, () => "x".repeat(scale)),
      files: Array.from({ length: 2 }, () => "x".repeat(Math.min(scale, 512))),
      approach: Array.from({ length: 2 }, () => "x".repeat(scale)),
      tests: Array.from({ length: 2 }, () => "x".repeat(scale)),
      acceptance: Array.from({ length: 2 }, () => "x".repeat(scale)),
      verification: Array.from({ length: 2 }, () => "x".repeat(scale)),
    };
  }

  it("admits a realistically-sized single-unit v2 plan comfortably under the envelope bound", () => {
    const plan: ExecutionPlanContractV2 = {
      schema: "openthrottle.execution-plan/v2",
      graph_id: "structured",
      plan_id: "v2-envelope-realistic",
      units: [unitAtFieldScale("solo", 500)],
      commands: [{ name: "test" }],
    };

    expect(() => assertStructuredPlanLoopEnvelopeBound(plan)).not.toThrow();
    expect(structuredPlanLoopEnvelopeBytes(plan)).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
  });

  it("rejects before provisioning a v2 plan whose projected envelope exceeds the limit (requirement: reject, never truncate)", () => {
    // Every field at the contract's own per-field/array bound, on a single
    // unit -- structurally valid per the v2 contract, but its dispatch
    // envelope is far larger than a worker request may carry.
    const plan: ExecutionPlanContractV2 = {
      schema: "openthrottle.execution-plan/v2",
      graph_id: "structured",
      plan_id: "v2-envelope-oversized",
      units: [{
        id: "oversized",
        title: "Oversized unit",
        depends_on: [],
        objective: "x".repeat(2_000),
        requirements: Array.from({ length: 32 }, () => "x".repeat(2_000)),
        files: Array.from({ length: 64 }, () => "x".repeat(512)),
        approach: Array.from({ length: 32 }, () => "x".repeat(2_000)),
        tests: Array.from({ length: 32 }, () => "x".repeat(2_000)),
        acceptance: Array.from({ length: 32 }, () => "x".repeat(2_000)),
        verification: Array.from({ length: 32 }, () => "x".repeat(2_000)),
      }],
      commands: [{ name: "test" }],
    };

    expect(structuredPlanLoopEnvelopeBytes(plan)).toBeGreaterThan(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
    expect(() => assertStructuredPlanLoopEnvelopeBound(plan)).toThrow(/No sandbox was provisioned/);
  });
});
