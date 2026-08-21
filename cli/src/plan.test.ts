import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DefinitionCompilation } from "@openthrottle/contracts";
import {
  EXECUTION_PLAN_FENCE,
  extractExecutionPlanBlocks,
  parsePlanArgs,
  prepareExecutionPlanFile,
  readExecutionPlanFromMarkdown,
  validateLocalPipelineSelection,
  validatePlanFileForPipeline,
  type LocalPipelineCompiler,
  type PrepareRunner,
} from "./plan.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-plan-test-"));
  directories.push(directory);
  return directory;
}

function definitionCompilation(options: {
  pipelineId?: string;
  consumesUnits?: boolean;
  engine?: "claude" | "codex" | "opencode";
  model?: string;
} = {}): DefinitionCompilation {
  const pipelineId = options.pipelineId ?? "core/structured";
  const config = {
    schema: "openthrottle.config/v2",
    pipeline: pipelineId,
    engine: options.engine ?? "codex",
    ...(options.model === undefined ? {} : { model: options.model }),
    commands: { test: "npm test", lint: "npm run lint", build: "npm run build" },
  };
  return {
    bundle: {
      value: {
        schema: "openthrottle.definition-bundle/v1",
        compiler_version: "definition-compiler/v1",
        runtime_capability_digest: "a".repeat(64),
        source_commit: "b".repeat(40),
        pipeline_id: pipelineId,
        entries: [{
          definition_kind: "config",
          definition_id: "repository",
          origin: { kind: "repository", source_commit: "b".repeat(40) },
          path: ".openthrottle/config.yml",
          content_hash: "c".repeat(64),
          normalized_payload: config,
        }],
      },
      normalized: "{}",
      digest: "d".repeat(64),
    },
    manifest: {
      value: {
        schema: "openthrottle.compiled-pipeline-manifest/v1",
        pipeline_id: pipelineId,
        pipeline_version: 1,
        entry_stage: "work",
        definition_bundle_hash: "d".repeat(64),
        compiler_version: "definition-compiler/v1",
        runtime_capability_digest: "a".repeat(64),
        stages: options.consumesUnits === false ? [{
          id: "work",
          kind: "command",
          command: "test",
          on: { success: { terminal: "completed" } },
        }] : [{
          id: "work",
          kind: "command",
          command: "test",
          loop: {
            over: "execution_plan.units",
            max_parallel: 4,
            max_rounds: 2,
            body: ["work"],
          },
          on: { success: { terminal: "completed" } },
        }],
      },
      normalized: "{}",
      digest: "e".repeat(64),
    },
  } as unknown as DefinitionCompilation;
}

function compilerFor(compilation: DefinitionCompilation): LocalPipelineCompiler {
  return vi.fn(() => compilation);
}

function executionPlanBlock(pipelineId = "core/structured"): string {
  const contract = JSON.parse(
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan-v2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  contract.pipeline_id = pipelineId;
  return `\`\`\`json ${EXECUTION_PLAN_FENCE}\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function legacyExecutionPlanBlock(): string {
  const contract = JSON.stringify({ schema: "openthrottle.execution-plan/v1" });
  return `\`\`\`json openthrottle.execution-plan/v1\n${contract}\n\`\`\``;
}

const prose = `# Stage C Contracts

## Goal

Compile and execute the approved work.
`;

describe("execution-plan parsing", () => {
  it("accepts one self-contained v2 block and reports coverage", () => {
    const markdown = `${prose}\n${executionPlanBlock()}\n`;
    const result = readExecutionPlanFromMarkdown(markdown, "plan.md");

    expect(extractExecutionPlanBlocks(markdown)).toHaveLength(1);
    expect(result.plan.value).toMatchObject({
      schema: EXECUTION_PLAN_FENCE,
      pipeline_id: "core/structured",
    });
    expect(result.coverage).toMatchObject({
      units: 2,
      requirement_count: 3,
      acceptance_count: 3,
    });
  });

  it("rejects removed v1, multiple, missing, malformed, and mismatched fences", () => {
    expect(() => readExecutionPlanFromMarkdown(`${prose}\n${legacyExecutionPlanBlock()}`, "v1.md"))
      .toThrow(/found 0/);
    expect(() => readExecutionPlanFromMarkdown(prose, "missing.md")).toThrow(/found 0/);
    const block = executionPlanBlock();
    expect(() => readExecutionPlanFromMarkdown(`${block}\n${block}`, "duplicate.md")).toThrow(/found 2/);
    expect(() => extractExecutionPlanBlocks(
      `\`\`\`json ${EXECUTION_PLAN_FENCE}\nnot-json\n\`\`\``,
    )).toThrow(/valid JSON/);
    expect(() => extractExecutionPlanBlocks(
      `\`\`\`json ${EXECUTION_PLAN_FENCE}\n{"schema":"openthrottle.execution-plan/v1"}\n\`\`\``,
    )).toThrow(/payload schema/);
  });
});

describe("compiled pipeline selection", () => {
  it("passes --pipeline through only as an assertion and derives unit consumption from the manifest", () => {
    const compiler = compilerFor(definitionCompilation());
    const selection = validateLocalPipelineSelection({
      directory: "/repo",
      pipelineId: "core/structured",
      compiler,
    });

    expect(compiler).toHaveBeenCalledWith({
      repositoryRoot: "/repo",
      expectedPipeline: "core/structured",
    });
    expect(selection.pipelineId).toBe("core/structured");
    expect(selection.consumesUnits).toBe(true);
  });

  it("does not infer structured behavior from the pipeline name", () => {
    const ordinaryNamedStructured = validateLocalPipelineSelection({
      compiler: compilerFor(definitionCompilation({
        pipelineId: "repo/structured-looking",
        consumesUnits: false,
      })),
    });
    const loopingNamedOrdinary = validateLocalPipelineSelection({
      compiler: compilerFor(definitionCompilation({
        pipelineId: "repo/ordinary-looking",
        consumesUnits: true,
      })),
    });

    expect(ordinaryNamedStructured.consumesUnits).toBe(false);
    expect(loopingNamedOrdinary.consumesUnits).toBe(true);
  });

  it("requires matching v2 units only when the compiled manifest consumes them", () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, prose);

    const ordinary = validatePlanFileForPipeline(file, {
      directory,
      compiler: compilerFor(definitionCompilation({
        pipelineId: "core/implement",
        consumesUnits: false,
      })),
    });
    expect(ordinary.plan).toBeUndefined();

    expect(() => validatePlanFileForPipeline(file, {
      directory,
      compiler: compilerFor(definitionCompilation()),
    })).toThrow(/expected exactly one execution-plan block/);

    writeFileSync(file, `${prose}\n${executionPlanBlock("repo/other")}\n`);
    expect(() => validatePlanFileForPipeline(file, {
      directory,
      compiler: compilerFor(definitionCompilation()),
    })).toThrow(/pipeline_id must match configured pipeline core\/structured/);

    writeFileSync(file, `${prose}\n${executionPlanBlock()}\n`);
    expect(validatePlanFileForPipeline(file, {
      directory,
      compiler: compilerFor(definitionCompilation()),
    }).plan?.plan.value).toMatchObject({ pipeline_id: "core/structured" });
  });

  it("rejects unused execution units for a non-looping pipeline", () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, `${prose}\n${executionPlanBlock("core/implement")}\n`);

    expect(() => validatePlanFileForPipeline(file, {
      directory,
      compiler: compilerFor(definitionCompilation({
        pipelineId: "core/implement",
        consumesUnits: false,
      })),
    })).toThrow(/does not consume execution_plan\.units/);
  });
});

describe("plan preparation", () => {
  it("uses the compiled config engine/model and configured pipeline", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, prose);
    const runner: PrepareRunner = vi.fn((input) => {
      expect(input.engine).toBe("codex");
      expect(input.model).toBe("gpt-test");
      expect(input.prompt).toContain("Configured pipeline: core/structured");
      expect(input.prompt).not.toContain("Selected graph");
      writeFileSync(input.targetFile!, `${prose}\n## Execution Plan\n\n${executionPlanBlock()}\n`);
      return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });

    const result = prepareExecutionPlanFile(file, {
      directory,
      pipelineId: "core/structured",
      compiler: compilerFor(definitionCompilation({ model: "gpt-test" })),
      runner,
    });

    expect(result.plan.value).toMatchObject({ pipeline_id: "core/structured" });
    expect(readFileSync(file, "utf8")).toContain(EXECUTION_PLAN_FENCE);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("does not invoke an engine when the configured pipeline does not consume units", () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, prose);
    const runner = vi.fn();

    expect(() => prepareExecutionPlanFile(file, {
      directory,
      compiler: compilerFor(definitionCompilation({
        pipelineId: "core/implement",
        consumesUnits: false,
      })),
      runner,
    })).toThrow(/configure a structured pipeline/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects prose edits and a plan emitted for another pipeline without changing the source file", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, prose);
    const changedProse: PrepareRunner = (input) => {
      writeFileSync(input.targetFile!, `# Changed\n\n${executionPlanBlock()}`);
      return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    expect(() => prepareExecutionPlanFile(file, {
      directory,
      compiler: compilerFor(definitionCompilation()),
      runner: changedProse,
    })).toThrow(/modified content outside/);
    expect(readFileSync(file, "utf8")).toBe(prose);

    const wrongPipeline: PrepareRunner = (input) => {
      writeFileSync(input.targetFile!, `${prose}\n## Execution Plan\n\n${executionPlanBlock("repo/other")}`);
      return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    expect(() => prepareExecutionPlanFile(file, {
      directory,
      compiler: compilerFor(definitionCompilation()),
      runner: wrongPipeline,
    })).toThrow(/pipeline_id must match/);
    expect(readFileSync(file, "utf8")).toBe(prose);
  });
});

describe("plan arguments", () => {
  it("accepts pipeline assertions and rejects graph-era flags", () => {
    expect(parsePlanArgs(["validate", "plan.md", "--pipeline", "core/structured", "--json"]))
      .toEqual({
        command: "validate",
        file: "plan.md",
        pipelineId: "core/structured",
        json: true,
      });
    expect(() => parsePlanArgs(["validate", "plan.md", "--pipeline"])).toThrow(/requires/);
    expect(() => parsePlanArgs(["validate", "plan.md", "--graph", "structured"]))
      .toThrow(/unexpected argument/);
  });
});
