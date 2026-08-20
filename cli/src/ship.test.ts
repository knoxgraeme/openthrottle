import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DefinitionCompilation } from "@openthrottle/contracts";
import ship, {
  delegateIssue,
  parseMarkdown,
  parseShipArgs,
  validatePipelineSelectionForShip,
} from "./ship.js";
import type { LocalPipelineCompiler } from "./plan.js";

const directories: string[] = [];
const originalExit = process.exit;
const originalEnv = {
  LINEAR_API_KEY: process.env.LINEAR_API_KEY,
  LINEAR_TEAM_ID: process.env.LINEAR_TEAM_ID,
  OT_AGENT_APP_ID: process.env.OT_AGENT_APP_ID,
  OT_SUPERVISOR_URL: process.env.OT_SUPERVISOR_URL,
  OT_STATUS_TOKEN: process.env.OT_STATUS_TOKEN,
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.exit = originalExit;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-ship-test-"));
  directories.push(directory);
  return directory;
}

function definitionCompilation(
  pipelineId: string,
  consumesUnits: boolean,
): DefinitionCompilation {
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
          normalized_payload: {
            schema: "openthrottle.config/v2",
            pipeline: pipelineId,
            engine: "codex",
            commands: { test: "npm test" },
          },
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
        stages: [{
          id: "work",
          kind: "command",
          command: "test",
          ...(consumesUnits ? {
            loop: {
              over: "execution_plan.units",
              max_parallel: 2,
              max_rounds: 2,
              body: ["work"],
            },
          } : {}),
          on: { success: { terminal: "completed" } },
        }],
      },
      normalized: "{}",
      digest: "e".repeat(64),
    },
  } as unknown as DefinitionCompilation;
}

function compilerFor(pipelineId: string, consumesUnits: boolean): LocalPipelineCompiler {
  return vi.fn(() => definitionCompilation(pipelineId, consumesUnits));
}

function executionPlanBlock(pipelineId = "core/structured"): string {
  const contract = JSON.parse(
    readFileSync(new URL("../../contracts/fixtures/valid/execution-plan-v2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  contract.pipeline_id = pipelineId;
  return `\`\`\`json openthrottle.execution-plan/v2\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

function throwingExit(): void {
  process.exit = ((code?: string | number | null) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit;
}

describe("ship input", () => {
  it("uses the first level-one heading as title", () => {
    expect(parseMarkdown("preface\n# Ship it\n\nPlan body\n")).toEqual({
      title: "Ship it",
      body: "Plan body",
    });
    expect(() => parseMarkdown("## Not enough")).toThrow(/Heading/);
  });

  it("supports a pipeline assertion and removes graph-era arguments", () => {
    expect(parseShipArgs(["plan.md", "--pipeline", "core/structured"]))
      .toEqual({ file: "plan.md", pipelineId: "core/structured" });
    expect(parseShipArgs(["plan.md"])).toEqual({ file: "plan.md" });
    expect(() => parseShipArgs(["plan.md", "--pipeline"])).toThrow(/requires/);
    expect(() => parseShipArgs(["plan.md", "--graph", "structured"]))
      .toThrow(/Unexpected argument: --graph/);
  });

  it("passes pipeline assertions to the committed-definition compiler without overriding config", () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, "# Ship it\n\nPlan body\n");
    const compiler = compilerFor("core/implement", false);

    validatePipelineSelectionForShip(file, {
      directory,
      pipelineId: "core/implement",
      compiler,
    });
    expect(compiler).toHaveBeenCalledWith({
      repositoryRoot: directory,
      expectedPipeline: "core/implement",
    });
  });

  it("requires a matching plan only when the compiled manifest consumes execution units", () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, "# Ship it\n\nPlan body\n");
    expect(() => validatePipelineSelectionForShip(file, {
      directory,
      compiler: compilerFor("core/structured", true),
    })).toThrow(/expected exactly one execution-plan block/);

    writeFileSync(file, `# Ship it\n\n${executionPlanBlock("repo/other")}`);
    expect(() => validatePipelineSelectionForShip(file, {
      directory,
      compiler: compilerFor("core/structured", true),
    })).toThrow(/pipeline_id must match/);

    writeFileSync(file, `# Ship it\n\n${executionPlanBlock()}`);
    expect(validatePipelineSelectionForShip(file, {
      directory,
      compiler: compilerFor("core/structured", true),
    }).plan?.plan.value).toMatchObject({ pipeline_id: "core/structured" });
  });
});

describe("ship mutation ordering", () => {
  it("does not access Linear when definition compilation fails", async () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, "# Ship it\n\nPlan body\n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    throwingExit();
    delete process.env.LINEAR_API_KEY;

    await expect(ship([file], {
      directory,
      compiler: vi.fn(() => { throw new Error("commit definitions first"); }),
    })).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not access Linear when a structured plan is missing or mismatched", async () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, `# Ship it\n\n${executionPlanBlock("repo/other")}`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    throwingExit();
    process.env.LINEAR_API_KEY = "linear-key";

    await expect(ship([file], {
      directory,
      compiler: compilerFor("core/structured", true),
    })).rejects.toThrow("exit 1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates an issue with the original body and no selection metadata or capability preflight", async () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, "# Ship it\n\nPlan body\n");
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.LINEAR_TEAM_ID = "team-1";
    delete process.env.OT_AGENT_APP_ID;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (!request.query.includes("IssueCreate")) throw new Error("unexpected request");
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "issue-1", identifier: "OPE-1", url: "https://linear.test/OPE-1" },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ship([file, "--pipeline", "core/implement"], {
      directory,
      compiler: compilerFor("core/implement", false),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("/capabilities");
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      variables: { input: { description: string } };
    };
    expect(request.variables.input.description).toBe("Plan body");
    expect(request.variables.input.description).not.toContain("ship-selection");
  });

  it("ships a matching structured plan without a supervisor capability request", async () => {
    const directory = temporaryProject();
    const file = join(directory, "plan.md");
    writeFileSync(file, `# Ship it\n\nPrepared body\n\n${executionPlanBlock()}`);
    process.env.LINEAR_API_KEY = "linear-key";
    process.env.LINEAR_TEAM_ID = "team-1";
    delete process.env.OT_AGENT_APP_ID;
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-1", identifier: "OPE-2", url: "https://linear.test/OPE-2" },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await ship([file], {
      directory,
      compiler: compilerFor("core/structured", true),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("/capabilities");
  });
});

describe("delegation", () => {
  it("uses IssueUpdateInput.delegateId", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: { issueUpdate: { success: true } } }));
    vi.stubGlobal("fetch", fetchMock);
    await delegateIssue("linear-key", "issue-1", "app-actor-1");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      variables: { id: "issue-1", input: { delegateId: "app-actor-1" } },
    });
  });

  it("rejects a false update result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: { issueUpdate: { success: false } },
    })));
    await expect(delegateIssue("linear-key", "issue-1", "app-actor-1"))
      .rejects.toThrow("success: false");
  });
});
