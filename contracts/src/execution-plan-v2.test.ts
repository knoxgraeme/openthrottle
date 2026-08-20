import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import {
  EXECUTION_PLAN_V2_MAX_BYTES,
  validateExecutionPlanContractV2,
  type ExecutionPlanContractV2,
} from "./execution-plan-v2.js";

function planAtCanonicalSize(targetBytes: number): ExecutionPlanContractV2 {
  const plan: ExecutionPlanContractV2 = {
    schema: "openthrottle.execution-plan/v2",
    graph_id: "structured",
    plan_id: "boundary",
    units: Array.from({ length: 64 }, (_, index) => ({
      id: `unit_${index}`,
      title: `Unit ${index}`,
      depends_on: [],
      objective: "Implement it.",
      requirements: ["Keep the contract."],
      files: ["src/a.ts"],
      approach: ["Follow existing patterns."],
      tests: ["Cover success."],
      acceptance: ["It works."],
      verification: ["npm test"],
    })),
    commands: [{ name: "test" }],
  };

  let unit = 0;
  while (Buffer.byteLength(canonicalJson(plan), "utf8") < targetBytes) {
    const current = Buffer.byteLength(canonicalJson(plan), "utf8");
    const remaining = targetBytes - current;
    const requirements = plan.units[unit]!.requirements;
    if (requirements.length >= 32) {
      unit += 1;
      continue;
    }
    if (remaining < 4) {
      const paddingUnit = plan.units.find((candidate) =>
        candidate.requirements.some((requirement) => requirement.length === 2_000));
      const paddingIndex = paddingUnit!.requirements.findIndex((requirement) => requirement.length === 2_000);
      paddingUnit!.requirements[paddingIndex] = "x".repeat(2_000 - (4 - remaining));
      continue;
    }
    const itemLength = remaining <= 2_003 ? Math.max(1, remaining - 3) : 2_000;
    requirements.push("x".repeat(itemLength));
  }
  expect(Buffer.byteLength(canonicalJson(plan), "utf8")).toBe(targetBytes);
  return plan;
}

describe("execution plan v2 canonical size", () => {
  it("accepts the exact 256 KiB boundary and rejects one byte over", () => {
    const boundary = planAtCanonicalSize(EXECUTION_PLAN_V2_MAX_BYTES);
    expect(validateExecutionPlanContractV2(boundary).normalized).toHaveLength(EXECUTION_PLAN_V2_MAX_BYTES);

    const oversized = structuredClone(boundary);
    oversized.units.at(-1)!.requirements[0] += "x";
    expect(() => validateExecutionPlanContractV2(oversized)).toThrow(
      `canonical JSON must contain at most ${EXECUTION_PLAN_V2_MAX_BYTES} UTF-8 bytes`,
    );
  });
});
