import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  defaultPrepareRunner,
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
        { id: "structured", kind: "builtin", ref: "core/structured@3" },
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
    const nonCanonical = block.replace("json openthrottle.execution-plan/v1", "json");
    expect(() => readExecutionPlanFromMarkdown(`${cePlan}\n${nonCanonical}`, "non-canonical.md")).toThrow(/found 0/);
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
    const calls: Array<{ agent: string; prompt: string; directory: string; targetFile?: string }> = [];
    const runner: PrepareRunner = (input) => {
      calls.push({
        agent: input.agent,
        prompt: input.prompt,
        directory: input.directory,
        targetFile: input.targetFile,
      });
      writeFileSync(input.targetFile!, planWithBlock("structured"));
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
      expect(calls[0]!.prompt).toContain(cePlan);
      expect(calls[0]!.targetFile).not.toBe(planPath);
      expect(calls[0]!.directory).not.toBe(directory);
      expect(calls[0]!.prompt).toContain(`Target plan file: ${calls[0]!.targetFile}`);
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
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_HOME;
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
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("honors CODEX_HOME when checking local Codex auth", () => {
    const directory = temporaryProject();
    const codexHome = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexAuth = process.env.CODEX_AUTH_JSON;
    const previousCodexHome = process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_AUTH_JSON;
    process.env.CODEX_HOME = codexHome;
    const runner: PrepareRunner = (input) => {
      writeFileSync(input.targetFile!, planWithBlock("structured"));
      return { status: 0, signal: null, output: [], pid: 123, stdout: Buffer.from(""), stderr: Buffer.from("") };
    };
    try {
      expect(prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner }).plan.value.graph_id).toBe(
        "structured"
      );
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexAuth === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = previousCodexAuth;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
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

  it("keeps the planning skill independent of Compound Engineering", () => {
    const planningSkillRoot = new URL("../../skills/planning/prepare-execution-plan/", import.meta.url);
    const bundle = [
      "SKILL.md",
      "agents/openai.yaml",
      "references/execution-plan.md",
    ].map((path) => readFileSync(new URL(path, planningSkillRoot), "utf8")).join("\n");

    expect(bundle).not.toMatch(/compound[- ]engineering|\bCE\b|\bce-[a-z]/i);
  });

  it("rejects a failed prepare runner even if it wrote a valid block", () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    writeConfig(directory);
    writeFileSync(planPath, cePlan);
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const runner: PrepareRunner = (input) => {
      writeFileSync(input.targetFile!, planWithBlock("structured"));
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
      expect(readFileSync(planPath, "utf8")).toBe(cePlan);
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("restores the plan when prepare rewrites prose outside the execution-plan block", () => {
    const directory = temporaryProject();
    const planPath = join(directory, "plan.md");
    const original = planWithBlock("structured");
    writeConfig(directory);
    writeFileSync(planPath, original);
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const runner: PrepareRunner = (input) => {
      writeFileSync(input.targetFile!, `# Rewritten requirements\n\n${executionPlanBlock("structured")}\n`);
      return { status: 0, signal: null, output: [], pid: 123, stdout: Buffer.from(""), stderr: Buffer.from("") };
    };
    try {
      expect(() => prepareExecutionPlanFile(planPath, { directory, graphId: "structured", runner })).toThrow(
        /modified content outside/
      );
      expect(readFileSync(planPath, "utf8")).toBe(original);
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });
  it("allows only automatic Read/Edit tools for noninteractive Claude preparation", () => {
    const directory = temporaryProject();
    const bin = join(directory, "bin");
    const argsPath = join(directory, "claude-args.json");
    const fakeClaude = join(bin, "claude");
    mkdirSync(bin);
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n")
    );
    chmodSync(fakeClaude, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      defaultPrepareRunner({ agent: "claude", prompt: "prepare", directory });
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      const permissionIndex = args.indexOf("--permission-mode");
      const toolsIndex = args.indexOf("--tools");
      expect(args.slice(permissionIndex, permissionIndex + 2)).toEqual(["--permission-mode", "acceptEdits"]);
      expect(args.slice(toolsIndex, toolsIndex + 2)).toEqual(["--tools", "Edit"]);
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--allow-dangerously-skip-permissions");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("passes only safe settings and the selected engine auth to prepare subprocesses", () => {
    const directory = temporaryProject();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const command of ["codex", "claude", "opencode"]) {
      const executable = join(bin, command);
      writeFileSync(
        executable,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const name = path.basename(process.argv[1]);",
          "fs.writeFileSync(path.join(process.cwd(), `${name}-env.json`), JSON.stringify(process.env));",
          "if (name === 'opencode') fs.writeFileSync(path.join(process.cwd(), 'opencode-config.json'), fs.readFileSync(path.join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json')));",
        ].join("\n")
      );
      chmodSync(executable, 0o755);
    }

    const keys = [
      "PATH",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "KIMI_CODE_API_KEY",
      "OPENCODE_CONFIG_DIR",
      "LINEAR_API_KEY",
      "DAYTONA_API_KEY",
      "OT_STATUS_TOKEN",
      "GITHUB_TOKEN",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    process.env.OPENAI_API_KEY = "openai-auth";
    process.env.CODEX_HOME = join(directory, "codex-home");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-auth";
    process.env.KIMI_CODE_API_KEY = "kimi-auth";
    process.env.OPENCODE_CONFIG_DIR = join(directory, "untrusted-opencode-config");
    process.env.LINEAR_API_KEY = "linear-secret";
    process.env.DAYTONA_API_KEY = "daytona-secret";
    process.env.OT_STATUS_TOKEN = "status-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    try {
      defaultPrepareRunner({ agent: "codex", prompt: "prepare", directory });
      defaultPrepareRunner({ agent: "claude", prompt: "prepare", directory });
      defaultPrepareRunner({ agent: "opencode", model: "kimi-code/kimi-for-coding", prompt: "prepare", directory });
      const codex = JSON.parse(readFileSync(join(directory, "codex-env.json"), "utf8")) as Record<string, string>;
      const claude = JSON.parse(readFileSync(join(directory, "claude-env.json"), "utf8")) as Record<string, string>;
      const opencode = JSON.parse(readFileSync(join(directory, "opencode-env.json"), "utf8")) as Record<string, string>;
      expect(codex.OPENAI_API_KEY).toBe("openai-auth");
      expect(codex.CODEX_HOME).toMatch(/openthrottle-engine-home-/);
      expect(codex.CODEX_HOME).not.toBe(join(directory, "codex-home"));
      expect(codex.HOME).toMatch(/openthrottle-engine-home-/);
      expect(claude.HOME).toMatch(/openthrottle-engine-home-/);
      expect(opencode.HOME).toMatch(/openthrottle-engine-home-/);
      expect(claude).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "claude-auth" });
      expect(opencode).toMatchObject({ KIMI_CODE_API_KEY: "kimi-auth" });
      expect(opencode.OPENCODE_CONFIG_DIR).toMatch(/openthrottle-opencode-/);
      expect(opencode.OPENCODE_CONFIG_DIR).not.toBe(join(directory, "untrusted-opencode-config"));
      const openCodeConfig = JSON.parse(readFileSync(join(directory, "opencode-config.json"), "utf8"));
      expect(openCodeConfig).toMatchObject({
        autoupdate: false,
        share: "disabled",
        permission: { "*": "deny", edit: "allow" },
        provider: {
          "kimi-code": {
            options: {
              baseURL: "https://api.kimi.com/coding/v1",
              apiKey: "{env:KIMI_CODE_API_KEY}",
            },
          },
        },
      });
      expect(JSON.stringify(openCodeConfig)).not.toContain("kimi-auth");
      expect(codex).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(codex).not.toHaveProperty("KIMI_CODE_API_KEY");
      expect(claude).not.toHaveProperty("OPENAI_API_KEY");
      expect(claude).not.toHaveProperty("KIMI_CODE_API_KEY");
      expect(opencode).not.toHaveProperty("OPENAI_API_KEY");
      expect(opencode).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      for (const env of [codex, claude, opencode]) {
        expect(env).not.toHaveProperty("LINEAR_API_KEY");
        expect(env).not.toHaveProperty("DAYTONA_API_KEY");
        expect(env).not.toHaveProperty("OT_STATUS_TOKEN");
        expect(env).not.toHaveProperty("GITHUB_TOKEN");
      }
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
        "const path = require('node:path');",
        "if (process.env.CODEX_AUTH_JSON) process.exit(6);",
        "if (process.env.LINEAR_API_KEY || process.env.DAYTONA_API_KEY || process.env.OT_STATUS_TOKEN) process.exit(8);",
        "const args = process.argv.slice(2);",
        "const sandboxIndex = args.indexOf('--sandbox');",
        "if (sandboxIndex < 0 || args[sandboxIndex + 1] !== 'workspace-write') process.exit(7);",
        "for (const feature of ['shell_tool', 'unified_exec', 'shell_snapshot']) {",
        "  const index = args.indexOf(feature);",
        "  if (index < 1 || args[index - 1] !== '--disable') process.exit(9);",
        "}",
        "if (!args.includes('--ignore-user-config') || !args.includes('--ignore-rules') || !args.includes('--ephemeral')) process.exit(10);",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        `  fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify("plan.md")}), ${JSON.stringify(preparedPlan)});`,
        "  process.stdout.write('x'.repeat(2 * 1024 * 1024));",
        "});",
      ].join("\n")
    );
    chmodSync(fakeCodex, 0o755);

    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexAuth = process.env.CODEX_AUTH_JSON;
    const log = console.log;
    const output: string[] = [];
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CODEX_AUTH_JSON = '{"tokens":{"access_token":"must-not-reach-child"}}';
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
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_HOME;
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
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
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
        commands: { test: "npm test" },
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

    baseConfig.commands = { test: "npm test", deploy: "npm run deploy" };
    graph.nodes[2]!.command = "deploy";
    graph.workers[0]!.credentials = ["repo.read", "model.invoke"];
    graph.workers[0]!.allowed_mcp_servers = [];
    writeFileSync(join(directory, ".openthrottle.yml"), stringify(baseConfig));
    writeFileSync(join(directory, ".openthrottle", "graphs", "structured.json"), JSON.stringify(graph));
    expect(() => validateLocalGraphSelection({ directory })).toThrow(/must be one of: test, lint, build, format/);

    baseConfig.commands = { test: "npm test" };
    graph.nodes[2]!.command = "test";
    graph.workers[1]!.credentials = ["repo.read", "repo.write", "model.invoke"];
    writeFileSync(join(directory, ".openthrottle.yml"), stringify(baseConfig));
    writeFileSync(join(directory, ".openthrottle", "graphs", "structured.json"), JSON.stringify(graph));
    expect(() => validateLocalGraphSelection({ directory })).toThrow(/gate phases cannot request repo\.write/);
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
