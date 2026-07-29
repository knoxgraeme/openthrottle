import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  extractExecutionPlanBlocks,
  readExecutionPlanFromMarkdown,
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

function executionPlanBlock(graphId = "structured"): string {
  const contract = JSON.parse(
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  contract.graph_id = graphId;
  return `\`\`\`json openthrottle.execution-plan/v1\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function planWithBlock(graphId = "structured"): string {
  return `${cePlan}\n## Execution Plan\n\n${executionPlanBlock(graphId)}\n`;
}

describe("plan validation", () => {
  it("validates one execution-plan block prepared by the planning skill", () => {
    const updated = planWithBlock();
    const result = readExecutionPlanFromMarkdown(updated, "sample.md");

    expect(extractExecutionPlanBlocks(updated)).toHaveLength(1);
    expect(result.plan.value.units.map((unit) => unit.id)).toEqual(["contracts", "corpora"]);
    expect(result.plan.value.units[1]!.depends_on).toEqual(["contracts"]);
    expect(result.coverage).toMatchObject({ units: 2, instruction_refs: 2, acceptance_refs: 2 });
  });

  it("rejects missing, duplicated, and invalid execution-plan blocks", () => {
    expect(() => readExecutionPlanFromMarkdown(cePlan, "missing.md")).toThrow(/expected exactly one/);
    const block = executionPlanBlock();
    expect(() => readExecutionPlanFromMarkdown(`${cePlan}\n${block}\n${block}`, "duplicate.md")).toThrow(/found 2/);
    expect(() =>
      readExecutionPlanFromMarkdown(
        `# Invalid\n\n\`\`\`json openthrottle.execution-plan/v1\n{"schema":"openthrottle.execution-plan/v1","units":[]}\n\`\`\``,
        "invalid.md"
      )
    ).toThrow(/graph_id/);
  });

  it("does not guess an execution plan without an agent-backed preparation runner", async () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeFileSync(planPath, cePlan);
    const exit = process.exit;
    const log = console.log;
    const output: string[] = [];
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      const { plan } = await import("./plan.js");
      await expect(plan(["prepare", planPath, "--json"])).rejects.toThrow(/exit 1/);
      expect(JSON.parse(output[0]!)).toMatchObject({
        ok: false,
        error: expect.stringContaining("agent-backed prepare-execution-plan runner"),
      });
      expect(readFileSync(planPath, "utf8")).toBe(cePlan);
    } finally {
      process.exit = exit;
      console.log = log;
    }
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

  it("checks graph selection when validating through the CLI", async () => {
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
    writeFileSync(planPath, planWithBlock("other"));
    const exit = process.exit;
    const log = console.log;
    const output: string[] = [];
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    const previousCwd = process.cwd();
    try {
      process.chdir(directory);
      const { plan } = await import("./plan.js");
      await expect(plan(["validate", planPath, "--graph", "structured", "--json"])).rejects.toThrow(/exit 1/);
      expect(JSON.parse(output[0]!)).toMatchObject({
        ok: false,
        error: expect.stringContaining("graph_id must match selected graph structured"),
      });
    } finally {
      process.chdir(previousCwd);
      process.exit = exit;
      console.log = log;
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

  it("rejects repository graphs that reference missing configured commands or MCP servers", () => {
    const directory = temporaryProject();
    mkdirSync(join(directory, ".openthrottle", "graphs"), { recursive: true });
    const baseConfig: {
      schema: string;
      default_graph: string;
      graphs: Array<{ id: string; kind: string; ref: string }>;
      intents: Record<string, { default_graph: string; allowed_graphs: string[] }>;
      commands: Record<string, string>;
      mcp_servers: Record<string, unknown>;
    } = {
      schema: "openthrottle.config/v1",
      default_graph: "structured",
      graphs: [
        { id: "structured", kind: "repository", ref: ".openthrottle/graphs/structured.json" },
      ],
      intents: {
        implement: { default_graph: "structured", allowed_graphs: ["structured"] },
      },
      commands: { test: "npm test" },
      mcp_servers: {},
    };
    writeFileSync(join(directory, ".openthrottle.yml"), stringify(baseConfig));
    const graph = JSON.parse(
      readFileSync(new URL("../../contracts/fixtures/valid/graph-structured.json", import.meta.url), "utf8")
    ) as {
      workers: Array<Record<string, unknown>>;
      nodes: Array<Record<string, unknown>>;
    };
    graph.nodes.push({
      id: "missing_command",
      kind: "command",
      command: "lint",
      depends_on: [],
      transitions: { success: { terminal: "completed" } },
    });
    graph.nodes[0]!.transitions = {
      ...(graph.nodes[0]!.transitions as Record<string, unknown>),
      no_change: { to: "missing_command" },
    };
    writeFileSync(join(directory, ".openthrottle", "graphs", "structured.json"), JSON.stringify(graph));
    expect(() => validateLocalGraphSelection({ directory })).toThrow(/unknown repository command/);

    graph.nodes[2]!.command = "test";
    graph.workers[0]!.credentials = ["repo.read", "model.invoke", "mcp"];
    graph.workers[0]!.allowed_mcp_servers = ["missing"];
    writeFileSync(join(directory, ".openthrottle", "graphs", "structured.json"), JSON.stringify(graph));
    expect(() => validateLocalGraphSelection({ directory })).toThrow(/unknown MCP server/);

    baseConfig.commands = { deploy: "npm run deploy" };
    graph.nodes[2]!.command = "deploy";
    graph.workers[0]!.credentials = ["repo.read", "model.invoke"];
    graph.workers[0]!.allowed_mcp_servers = [];
    writeFileSync(join(directory, ".openthrottle.yml"), stringify(baseConfig));
    writeFileSync(join(directory, ".openthrottle", "graphs", "structured.json"), JSON.stringify(graph));
    expect(() => validateLocalGraphSelection({ directory })).toThrow(/must be one of: test, lint, build, format/);
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
    writeFileSync(planPath, planWithBlock("other"));

    expect(() => validatePlanFileForGraph(planPath, { directory, graphId: "structured" })).toThrow(
      /graph_id must match/
    );
  });
});
