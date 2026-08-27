import { describe, expect, it } from "vitest";
import {
  EXECUTION_PLAN_SCHEMA_V2,
  type ExecutionPlanContractV2,
} from "@openthrottle/contracts";
import {
  parseStructuredExecutionPlan,
  restoreExecutionPlanFenceMarkers,
} from "./structured-plan.js";

const PLAN: ExecutionPlanContractV2 = {
  schema: EXECUTION_PLAN_SCHEMA_V2,
  pipeline_id: "core/structured",
  plan_id: "plan-1",
  units: [{
    id: "unit-a",
    title: "Unit A",
    depends_on: [],
    objective: "Implement A",
    requirements: ["A is durable"],
    files: ["a.ts"],
    approach: ["Implement the bounded change"],
    tests: ["Test A"],
    acceptance: ["A works"],
    verification: ["npm test"],
  }],
  commands: [],
};

function fence(body: string, marker = "json"): string {
  return `\`\`\`${marker}\n${body}\n\`\`\``;
}

function planFence(marker = "json"): string {
  return fence(JSON.stringify(PLAN), marker);
}

describe("restoreExecutionPlanFenceMarkers", () => {
  it("restores a bare valid Linear execution-plan marker", () => {
    const restored = restoreExecutionPlanFenceMarkers(planFence());

    expect(restored).toContain(`\`\`\`json ${EXECUTION_PLAN_SCHEMA_V2}\n`);
    expect(parseStructuredExecutionPlan(restored, "core/structured")).toEqual(PLAN);
  });

  it("keeps a malformed same-schema rival visible so selection fails closed", () => {
    const malformed = fence(
      `{\"schema\":\"${EXECUTION_PLAN_SCHEMA_V2}\",\"pipeline_id\":`,
    );
    const restored = restoreExecutionPlanFenceMarkers(`${planFence()}\n${malformed}`);

    expect(restored.match(/```json openthrottle\.execution-plan\/v2/g)).toHaveLength(2);
    expect(() => parseStructuredExecutionPlan(restored, "core/structured"))
      .toThrow(/valid JSON/);
  });

  it("keeps an invalid-shape same-schema rival visible as ambiguity", () => {
    const invalidShape = fence(JSON.stringify({
      schema: EXECUTION_PLAN_SCHEMA_V2,
      pipeline_id: "core/structured",
    }));
    const restored = restoreExecutionPlanFenceMarkers(`${planFence()}\n${invalidShape}`);

    expect(() => parseStructuredExecutionPlan(restored, "core/structured"))
      .toThrow(/exactly one/);
  });

  it("keeps two valid bare plans ambiguous", () => {
    const restored = restoreExecutionPlanFenceMarkers(`${planFence()}\n${planFence()}`);

    expect(() => parseStructuredExecutionPlan(restored, "core/structured"))
      .toThrow(/exactly one/);
  });

  it("keeps a tagged plan plus a bare plan ambiguous without rewriting the tagged block", () => {
    const tagged = planFence(`json ${EXECUTION_PLAN_SCHEMA_V2}`);
    const restored = restoreExecutionPlanFenceMarkers(`${tagged}\n${planFence()}`);

    expect(restored.startsWith(tagged)).toBe(true);
    expect(() => parseStructuredExecutionPlan(restored, "core/structured"))
      .toThrow(/exactly one/);
  });

  it.each([
    ["unrelated malformed JSON", fence("{not-json}")],
    ["a scalar schema value", fence(JSON.stringify(EXECUTION_PLAN_SCHEMA_V2))],
    ["another schema", fence(JSON.stringify({ schema: "example.execution-plan/v1" }))],
    ["an unrelated scalar", fence("42")],
    ["an existing tagged marker", planFence(`json ${EXECUTION_PLAN_SCHEMA_V2}`)],
    ["a multi-token marker", planFence("json unrelated-marker")],
  ])("does not rewrite %s", (_label, markdown) => {
    expect(restoreExecutionPlanFenceMarkers(markdown)).toBe(markdown);
  });
});
