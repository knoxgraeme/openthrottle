import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  extractExecutionPlanBlocks,
  prepareExecutionPlanFile,
  readExecutionPlanFromMarkdown,
  resolvePrepareSkillPath,
  validateLocalGraphSelection,
  validatePlanFileForGraph,
  type PrepareRunner,
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

function writeConfig(directory: string, allowedGraphs = ["simple", "structured"]): void {
  writeFileSync(
    join(directory, ".openthrottle.yml"),
    stringify({
      schema: "openthrottle.config/v1",
      default_graph: "simple",
      graphs: [
        { id: "simple", kind: "builtin", ref: "core/simple@1" },
        { id: "structured", kind: "builtin", ref: "core/structured@1" },
      ],
      agent: "codex",
      intents: {
        implement: { default_graph: "simple", allowed_graphs: allowedGraphs },
      },
    })
  );
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

  it("prepares a plan by invoking the configured local engine with the canonical skill", () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, `${cePlan}\n## Execution Plan\n\n${executionPlanBlock("structured")}\n`);
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const calls: Array<{ agent: string; prompt: string }> = [];
    const runner: PrepareRunner = (input) => {
      calls.push({ agent: input.agent, prompt: input.prompt });
      writeFileSync(planPath, planWithBlock("structured"));
      return { status: 0, signal: null, output: [], pid: 123, stdout: Buffer.from(""), stderr: Buffer.from("") };
    };
    try {
      const result = prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner });
      expect(result.plan.value.graph_id).toBe("structured");
      expect(extractExecutionPlanBlocks(readFileSync(planPath, "utf8"))).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ agent: "codex" });
      expect(calls[0]!.prompt).toContain("name: prepare-execution-plan");
      expect(calls[0]!.prompt).toContain("Execution Plan Reference");
      expect(calls[0]!.prompt).toContain("Dependencies may reference only known units");
      expect(calls[0]!.prompt).toContain(`Target plan file: ${planPath}`);
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("reports missing local engine auth before invoking prepare", () => {
    const directory = temporaryProject();
    const home = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    const previousHome = process.env.HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexAuth = process.env.CODEX_AUTH_JSON;
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_AUTH_JSON;
    const runner: PrepareRunner = () => {
      throw new Error("runner should not be invoked");
    };
    try {
      expect(() => prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner })).toThrow(
        /codex.*auth/i
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexAuth === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = previousCodexAuth;
    }
  });

  it("resolves the packaged prepare skill next to the built plan module", () => {
    const directory = temporaryProject();
    const dist = join(directory, "dist");
    const skill = join(dist, "skills", "planning", "prepare-execution-plan", "SKILL.md");
    mkdirSync(join(dist, "skills", "planning", "prepare-execution-plan"), { recursive: true });
    writeFileSync(skill, "---\nname: prepare-execution-plan\n---\n");

    expect(resolvePrepareSkillPath(pathToFileURL(join(dist, "plan.js")).href)).toBe(skill);
  });

  it("rejects a failed prepare runner even if it wrote a valid block", () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const runner: PrepareRunner = () => {
      writeFileSync(planPath, planWithBlock("structured"));
      return {
        status: 1,
        signal: null,
        output: [],
        pid: 123,
        stdout: Buffer.from(""),
        stderr: Buffer.from("engine failed"),
      };
    };
    try {
      expect(() => prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner })).toThrow(
        /engine failed/
      );
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
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

  it("prepares through the CLI and strips CODEX_AUTH_JSON from the local engine", async () => {
    const directory = temporaryProject();
    const bin = join(directory, "bin");
    const planPath = join(directory, "plan.md");
    const preparedPlan = planWithBlock("structured");
    mkdirSync(bin);
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    const fakeCodex = join(bin, "codex");
    writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "if (process.env.CODEX_AUTH_JSON) process.exit(6);",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.env.OT_TEST_PLAN_PATH, process.env.OT_TEST_PLAN_BODY);",
        "  process.stdout.write('x'.repeat(2 * 1024 * 1024));",
        "});",
      ].join("\n")
    );
    chmodSync(fakeCodex, 0o755);

    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexAuth = process.env.CODEX_AUTH_JSON;
    const previousPlanPath = process.env.OT_TEST_PLAN_PATH;
    const previousPlanBody = process.env.OT_TEST_PLAN_BODY;
    const log = console.log;
    const output: string[] = [];
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CODEX_AUTH_JSON = '{"tokens":{"access_token":"must-not-reach-child"}}';
    process.env.OT_TEST_PLAN_PATH = planPath;
    process.env.OT_TEST_PLAN_BODY = preparedPlan;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      process.chdir(directory);
      const { plan } = await import("./plan.js");
      await plan(["prepare", planPath, "--graph", "structured", "--json"]);
      expect(JSON.parse(output[0]!)).toMatchObject({
        ok: true,
        coverage: { units: 2, instruction_refs: 2, acceptance_refs: 2 },
      });
      expect(readExecutionPlanFromMarkdown(readFileSync(planPath, "utf8"), planPath).plan.value.graph_id).toBe(
        "structured"
      );
    } finally {
      process.chdir(previousCwd);
      console.log = log;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexAuth === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = previousCodexAuth;
      if (previousPlanPath === undefined) delete process.env.OT_TEST_PLAN_PATH;
      else process.env.OT_TEST_PLAN_PATH = previousPlanPath;
      if (previousPlanBody === undefined) delete process.env.OT_TEST_PLAN_BODY;
      else process.env.OT_TEST_PLAN_BODY = previousPlanBody;
    }
  });

  it("does not treat CODEX_AUTH_JSON alone as local Codex auth", () => {
    const directory = temporaryProject();
    const home = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    const previousHome = process.env.HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexAuth = process.env.CODEX_AUTH_JSON;
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
    process.env.CODEX_AUTH_JSON = '{"tokens":{"access_token":"test"}}';
    const runner: PrepareRunner = () => {
      throw new Error("runner should not be invoked");
    };
    try {
      expect(() => prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner })).toThrow(
        /codex.*auth/i
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexAuth === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = previousCodexAuth;
    }
  });

  it("checks graph selection when validating through the CLI", async () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
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
    writeConfig(directory);
    writeFileSync(planPath, planWithBlock("other"));

    expect(() => validatePlanFileForGraph(planPath, { directory, graphId: "structured" })).toThrow(
      /graph_id must match/
    );
  });
});
