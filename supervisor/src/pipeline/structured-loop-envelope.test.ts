import { describe, expect, it } from "vitest";
import type { ExecutionPlanContract } from "@openthrottle/contracts";
import { canonicalJson } from "./manifest.js";
import {
  MAX_VALID_DOWNSTREAM_CONTEXT,
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
