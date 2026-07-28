import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  extractExecutionPlanBlocks,
  prepareExecutionPlanBlock,
  readExecutionPlanFromMarkdown,
  upsertExecutionPlanBlock,
  validateLocalGraphSelection,
  validatePlanFileForGraph,
} from "./plan.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-plan-test-"));
  directories.push(directory);
  return directory;
}

const cePlan = `# Stage C Contracts

## Product Contract

- R7. OpenThrottle must ship an agent-neutral preparation skill.
- R8. The skill must emit one execution-plan block.
- R9. The validator must reject invalid plans.

## Implementation Units

### U1. Freeze contracts

**Goal:** Freeze closed public schemas.
**Requirements:** R7, R8.
**Dependencies:** None.
**Verification:** npm test --prefix contracts

### U2. Add CLI validation

**Goal:** Validate execution plans locally.
**Requirements:** R9.
**Dependencies:** U1.
**Verification:** npm test --prefix cli
`;

describe("plan validation", () => {
  it("prepares one valid execution-plan block from CE implementation units", () => {
    const block = prepareExecutionPlanBlock(cePlan);
    const updated = upsertExecutionPlanBlock(cePlan, block);
    const result = readExecutionPlanFromMarkdown(updated, "sample.md");

    expect(extractExecutionPlanBlocks(updated)).toHaveLength(1);
    expect(result.plan.value.units.map((unit) => unit.id)).toEqual(["u1", "u2"]);
    expect(result.plan.value.units[1]!.depends_on).toEqual(["u1"]);
    expect(result.coverage).toMatchObject({ units: 2, instruction_refs: 2, acceptance_refs: 2 });
  });

  it("updates the existing block instead of duplicating it", () => {
    const first = upsertExecutionPlanBlock(cePlan, prepareExecutionPlanBlock(cePlan));
    const second = upsertExecutionPlanBlock(first, prepareExecutionPlanBlock(cePlan));

    expect(extractExecutionPlanBlocks(second)).toHaveLength(1);
    expect(readExecutionPlanFromMarkdown(second).plan.value.units).toHaveLength(2);
  });

  it("rejects missing, duplicated, and invalid execution-plan blocks", () => {
    expect(() => readExecutionPlanFromMarkdown(cePlan, "missing.md")).toThrow(/expected exactly one/);
    const block = prepareExecutionPlanBlock(cePlan);
    expect(() => readExecutionPlanFromMarkdown(`${cePlan}\n${block}\n${block}`, "duplicate.md")).toThrow(/found 2/);
    expect(() =>
      readExecutionPlanFromMarkdown(
        `# Invalid\n\n\`\`\`json openthrottle.execution-plan/v1\n{"schema":"openthrottle.execution-plan/v1","units":[]}\n\`\`\``,
        "invalid.md"
      )
    ).toThrow(/graph_id/);
  });

  it("rejects malformed prepare arguments", async () => {
    const exit = process.exit;
    const error = console.error;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    console.error = () => undefined;
    try {
      const { plan } = await import("./plan.js");
      await expect(plan(["prepare", "plan.md", "--graph"])).rejects.toThrow(/exit 1/);
    } finally {
      process.exit = exit;
      console.error = error;
    }
  });

  it("validates local graph selection and detects unit-consuming graphs", () => {
    const directory = temporaryProject();
    mkdirSync(join(directory, ".openthrottle", "graphs"), { recursive: true });
    writeFileSync(
      join(directory, ".openthrottle.yml"),
      stringify({
        schema: "openthrottle.config/v1",
        default_graph: "simple",
        graphs: [
          { id: "simple", kind: "builtin", ref: "core/simple@1" },
          { id: "structured", kind: "repository", ref: ".openthrottle/graphs/structured.json" },
        ],
        intents: {
          implement: { default_graph: "simple", allowed_graphs: ["simple", "structured"] },
          investigate: { default_graph: "simple", allowed_graphs: ["simple"] },
        },
      })
    );
    writeFileSync(
      join(directory, ".openthrottle", "graphs", "structured.json"),
      readFileSync(new URL("../../contracts/fixtures/valid/graph-structured.json", import.meta.url), "utf8")
    );

    expect(validateLocalGraphSelection({ directory }).consumesUnits).toBe(false);
    expect(validateLocalGraphSelection({ directory, graphId: "structured" }).consumesUnits).toBe(true);
    expect(() => validateLocalGraphSelection({ directory, graphId: "missing" })).toThrow(/not allowed/);
  });

  it("requires the execution block to match the selected graph", () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeFileSync(
      join(directory, ".openthrottle.yml"),
      stringify({
        schema: "openthrottle.config/v1",
        default_graph: "simple",
        graphs: [
          { id: "simple", kind: "builtin", ref: "core/simple@1" },
          { id: "structured", kind: "builtin", ref: "core/structured@1" },
        ],
        intents: {
          implement: { default_graph: "simple", allowed_graphs: ["simple", "structured"] },
        },
      })
    );
    writeFileSync(planPath, upsertExecutionPlanBlock(cePlan, prepareExecutionPlanBlock(cePlan, "other")));

    expect(() => validatePlanFileForGraph(planPath, { directory, graphId: "structured" })).toThrow(
      /graph_id must match/
    );
  });
});
