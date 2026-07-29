import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  parseExecutionPlanContract,
  parseGraphContract,
  validateRepositoryConfigContract,
  type ExecutionPlanContract,
  type GraphContract,
  type RepositoryConfigContract,
  type ValidatedContract,
} from "@openthrottle/contracts";
import { getErrorMessage } from "./util.js";

export const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";

export interface ExecutionPlanBlock {
  json: string;
  start: number;
  end: number;
}

export interface ValidationResult {
  plan: ValidatedContract<ExecutionPlanContract>;
  coverage: {
    units: number;
    instruction_refs: number;
    acceptance_refs: number;
    commands: string[];
  };
}

export interface LocalGraphSelection {
  config: ValidatedContract<RepositoryConfigContract>;
  graphId: string;
  graph?: ValidatedContract<GraphContract>;
  consumesUnits: boolean;
}

export interface PrepareRunnerInput {
  agent: "claude" | "codex" | "opencode";
  model?: string;
  prompt: string;
  directory: string;
}

export type PrepareRunner = (input: PrepareRunnerInput) => SpawnSyncReturns<Buffer>;

const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const CURRENT_COMPILER_COMMANDS = new Set(["test", "lint", "build", "format"]);
const PREPARE_RUNNER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function resolvePrepareSkillPath(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const packaged = join(moduleDirectory, "skills", "planning", "prepare-execution-plan", "SKILL.md");
  if (existsSync(packaged)) return packaged;
  return resolve(moduleDirectory, "..", "..", "skills", "planning", "prepare-execution-plan", "SKILL.md");
}

function prepareSkillReferencePath(skillPath: string): string {
  return join(dirname(skillPath), "references", "execution-plan.md");
}

function redactCommand(command: string, args: string[], prompt?: string): string {
  return [command, ...args]
    .map((part) => (prompt && part === prompt ? "<prompt>" : part))
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function extractExecutionPlanBlocks(markdown: string): ExecutionPlanBlock[] {
  const blocks: ExecutionPlanBlock[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (!marker.includes(EXECUTION_PLAN_FENCE)) continue;
    const json = match[2]?.trim() ?? "";
    blocks.push({ json, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return blocks;
}

export function readExecutionPlanFromMarkdown(
  markdown: string,
  source = "plan"
): ValidationResult {
  const blocks = extractExecutionPlanBlocks(markdown);
  if (blocks.length !== 1) {
    throw new Error(`${source}: expected exactly one ${EXECUTION_PLAN_FENCE} block, found ${blocks.length}`);
  }
  const plan = parseExecutionPlanContract(blocks[0]!.json, { source: `${source}.execution_plan` });
  return {
    plan,
    coverage: {
      units: plan.value.units.length,
      instruction_refs: Object.keys(plan.value.instructions).length,
      acceptance_refs: Object.keys(plan.value.acceptance).length,
      commands: plan.value.commands.map((command) => command.name),
    },
  };
}

export function validateLocalGraphSelection(
  options: { graphId?: string; directory?: string } = {}
): LocalGraphSelection {
  const directory = options.directory ?? process.cwd();
  const configPath = join(directory, ".openthrottle.yml");
  if (!existsSync(configPath)) throw new Error(".openthrottle.yml not found; run openthrottle init first");
  const parsed = parseYaml(readFileSync(configPath, "utf8")) as unknown;
  const config = validateRepositoryConfigContract(parsed, { source: ".openthrottle.yml" });
  const intent = config.value.intents?.implement;
  const graphId = options.graphId ?? intent?.default_graph ?? config.value.default_graph;
  const allowed = intent?.allowed_graphs ?? [config.value.default_graph];
  if (!allowed.includes(graphId)) {
    throw new Error(`graph ${graphId} is not allowed for implement; allowed: ${allowed.join(", ")}`);
  }
  const source = config.value.graphs.find((graph) => graph.id === graphId);
  if (!source) throw new Error(`graph ${graphId} is not declared in .openthrottle.yml`);
  if (source.kind === "builtin") {
    return { config, graphId, consumesUnits: graphId === "structured" || source.ref.includes("structured") };
  }
  const graphPath = join(directory, source.ref);
  const graph = parseGraphContract(readFileSync(graphPath, "utf8"), { source: source.ref, config: config.value });
  for (const node of graph.value.nodes) {
    if (node.command && !CURRENT_COMPILER_COMMANDS.has(node.command)) {
      throw new Error(`${source.ref}.nodes.${node.id}.command must be one of: ${[...CURRENT_COMPILER_COMMANDS].join(", ")}`);
    }
  }
  const consumesUnits =
    graph.value.nodes.some((node) => node.kind === "for_each_unit") ||
    graph.value.loops.some((loop) => loop.input_scope === "unit");
  return { config, graphId, graph, consumesUnits };
}

export function validatePlanFileForGraph(
  file: string,
  options: { graphId?: string; directory?: string } = {}
): { graph: LocalGraphSelection; plan?: ValidationResult } {
  const graph = validateLocalGraphSelection(options);
  if (!graph.consumesUnits) return { graph };
  const plan = readExecutionPlanFromMarkdown(readFileSync(file, "utf8"), file);
  if (plan.plan.value.graph_id !== graph.graphId) {
    throw new Error(`${file}: execution_plan.graph_id must match selected graph ${graph.graphId}`);
  }
  return { graph, plan };
}

function readPrepareSkillBundle(): string {
  const path = resolvePrepareSkillPath();
  if (!existsSync(path)) {
    throw new Error("prepare-execution-plan skill is missing from the CLI package; reinstall or rebuild openthrottle.");
  }
  const referencePath = prepareSkillReferencePath(path);
  if (!existsSync(referencePath)) {
    throw new Error("prepare-execution-plan reference material is missing from the CLI package; reinstall or rebuild openthrottle.");
  }
  return [
    readFileSync(path, "utf8"),
    "",
    "## Canonical reference: references/execution-plan.md",
    "",
    readFileSync(referencePath, "utf8"),
  ].join("\n");
}

function buildPreparePrompt(file: string, graphId: string, skillBody: string): string {
  return [
    "$prepare-execution-plan",
    "",
    "Use the canonical OpenThrottle planning skill below to update the target plan file.",
    "Do not edit any other file. Preserve the human-authored prose.",
    `Target plan file: ${file}`,
    `Selected graph: ${graphId}`,
    "",
    skillBody,
  ].join("\n");
}

function authFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function codexAuthFilePath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "auth.json") : join(homedir(), ".codex", "auth.json");
}

function assertPrepareEngineUsable(agent: PrepareRunnerInput["agent"], model?: string): void {
  if (agent === "codex") {
    if (!process.env.OPENAI_API_KEY && !authFileExists(codexAuthFilePath())) {
      throw new Error(
        "openthrottle plan prepare is configured for codex, but no Codex/OpenAI auth was found. " +
          "Run `codex login` or set OPENAI_API_KEY."
      );
    }
  } else if (agent === "claude") {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !authFileExists(join(homedir(), ".claude.json"))) {
      throw new Error(
        "openthrottle plan prepare is configured for claude, but no Claude auth was found. " +
          "Run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN."
      );
    }
  } else if (agent === "opencode") {
    if (!model) throw new Error("openthrottle plan prepare is configured for opencode, but .openthrottle.yml has no model.");
    if (!process.env.KIMI_CODE_API_KEY) {
      throw new Error("openthrottle plan prepare is configured for opencode, but KIMI_CODE_API_KEY is not set.");
    }
  }
}

function assertPrepareRunnerSucceeded(result: SpawnSyncReturns<Buffer>): void {
  if (result.error) {
    throw new Error(`prepare-execution-plan failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8").trim();
    const stdout = result.stdout?.toString("utf8").trim();
    throw new Error(`prepare-execution-plan failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`);
  }
}

export const defaultPrepareRunner: PrepareRunner = ({ agent, model, prompt, directory }) => {
  let command: string;
  let args: string[];
  let input: string | undefined;
  if (agent === "codex") {
    command = "codex";
    args = ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", directory, ...(model ? ["-m", model] : []), "-"];
    input = prompt;
  } else if (agent === "claude") {
    command = "claude";
    args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--tools", "Read,Edit", ...(model ? ["--model", model] : [])];
  } else {
    command = "opencode";
    args = ["run", "--format", "json", "--model", model ?? "", "--dir", directory, "--auto", prompt];
  }
  const env = agent === "codex" ? { ...process.env } : undefined;
  if (env) delete env.CODEX_AUTH_JSON;
  const result = spawnSync(command, args, {
    cwd: directory,
    env,
    input,
    maxBuffer: PREPARE_RUNNER_MAX_BUFFER_BYTES,
    timeout: 30 * 60 * 1000,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(`openthrottle plan prepare could not find ${command} on PATH; install the configured local engine or change agent in .openthrottle.yml.`);
  }
  try {
    assertPrepareRunnerSucceeded(result);
  } catch {
    const stderr = result.stderr?.toString("utf8").trim();
    const stdout = result.stdout?.toString("utf8").trim();
    throw new Error(
      `prepare-execution-plan failed via ${redactCommand(command, args, prompt)}${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`
    );
  }
  return result;
};

export function prepareExecutionPlanFile(
  file: string,
  options: { graphId?: string; directory?: string; runner?: PrepareRunner } = {}
): ValidationResult {
  const directory = options.directory ?? process.cwd();
  const graph = validateLocalGraphSelection({ graphId: options.graphId, directory });
  if (!graph.consumesUnits) {
    throw new Error(`graph ${graph.graphId} does not consume execution units; select a structured graph with --graph.`);
  }
  const agent = graph.config.value.agent;
  if (agent !== "claude" && agent !== "codex" && agent !== "opencode") {
    throw new Error(".openthrottle.yml must set agent to codex, claude, or opencode for plan prepare.");
  }
  assertPrepareEngineUsable(agent, graph.config.value.model);
  const runner = options.runner ?? defaultPrepareRunner;
  const before = extractExecutionPlanBlocks(readFileSync(file, "utf8"));
  if (before.length > 1) {
    throw new Error(`${file}: expected at most one ${EXECUTION_PLAN_FENCE} block before prepare, found ${before.length}`);
  }
  const prompt = buildPreparePrompt(file, graph.graphId, readPrepareSkillBundle());
  assertPrepareRunnerSucceeded(runner({ agent, model: graph.config.value.model, prompt, directory }));
  const result = readExecutionPlanFromMarkdown(readFileSync(file, "utf8"), file);
  if (result.plan.value.graph_id !== graph.graphId) {
    throw new Error(`${file}: execution_plan.graph_id must match selected graph ${graph.graphId}`);
  }
  return result;
}

function validateSelectedGraph(result: ValidationResult, graphId: string): void {
  const graph = validateLocalGraphSelection({ graphId });
  if (graph.consumesUnits && result.plan.value.graph_id !== graph.graphId) {
    throw new Error(`execution_plan.graph_id must match selected graph ${graph.graphId}`);
  }
}

function printValidation(result: ValidationResult, json: boolean): void {
  const body = {
    ok: true,
    schema: result.plan.value.schema,
    digest: result.plan.digest,
    coverage: result.coverage,
  };
  if (json) console.log(JSON.stringify(body, null, 2));
  else {
    console.log(`ok ${body.schema}`);
    console.log(`digest ${body.digest}`);
    console.log(`coverage units=${body.coverage.units} instructions=${body.coverage.instruction_refs} acceptance=${body.coverage.acceptance_refs}`);
  }
}

function exitWithError(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(1);
}

function parseArgs(args: string[]): { command?: string; file?: string; graphId?: string; json: boolean } {
  const parsed: { command?: string; file?: string; graphId?: string; json: boolean } = {
    command: args[0],
    json: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--write") continue;
    else if (arg === "--graph") {
      parsed.graphId = args[++index];
      if (!parsed.graphId) throw new Error("--graph requires a graph ID");
    }
    else if (!parsed.file) parsed.file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return parsed;
}

export async function plan(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
    if (!parsed.command || !["prepare", "validate"].includes(parsed.command) || !parsed.file) {
      throw new Error("Usage: openthrottle plan <prepare|validate> <file.md> [--graph <id>] [--json] [--write]");
    }
    const result = parsed.command === "prepare"
      ? prepareExecutionPlanFile(parsed.file, { graphId: parsed.graphId })
      : readExecutionPlanFromMarkdown(readFileSync(parsed.file, "utf8"), parsed.file);
    if (parsed.command === "validate" && parsed.graphId) validateSelectedGraph(result, parsed.graphId);
    printValidation(result, parsed.json);
  } catch (error) {
    exitWithError(getErrorMessage(error), args.includes("--json"));
  }
}

export async function validate(args: string[]): Promise<void> {
  const file = args.find((arg) => !arg.startsWith("-"));
  const json = args.includes("--json");
  if (!file) {
    exitWithError("Usage: openthrottle validate <file.md> [--json]", json);
  }
  try {
    const result = readExecutionPlanFromMarkdown(readFileSync(file, "utf8"), file);
    printValidation(result, json);
  } catch (error) {
    exitWithError(getErrorMessage(error), json);
  }
}
