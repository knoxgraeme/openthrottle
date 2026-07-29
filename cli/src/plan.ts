import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const FENCE_PATTERN = /```[^\n`]*\n([\s\S]*?)```/g;
const PREPARE_UNAVAILABLE =
  "openthrottle plan prepare requires an agent-backed prepare-execution-plan runner; " +
  "run the packaged prepare-execution-plan skill, then validate the resulting block with openthrottle plan validate <file.md>.";
const CURRENT_COMPILER_COMMANDS = new Set(["test", "lint", "build", "format"]);

export function extractExecutionPlanBlocks(markdown: string): ExecutionPlanBlock[] {
  const blocks: ExecutionPlanBlock[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const json = match[1]?.trim();
    if (!json?.includes(`"schema"`) || !json.includes(EXECUTION_PLAN_FENCE)) continue;
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

function parseArgs(args: string[]): { command?: string; file?: string; graphId?: string; json: boolean; write: boolean } {
  const parsed: { command?: string; file?: string; graphId?: string; json: boolean; write: boolean } = {
    command: args[0],
    json: false,
    write: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--write") parsed.write = true;
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
    if (parsed.command === "prepare") {
      throw new Error(PREPARE_UNAVAILABLE);
    }
    const content = readFileSync(parsed.file, "utf8");
    const result = readExecutionPlanFromMarkdown(content, parsed.file);
    if (parsed.graphId) validateSelectedGraph(result, parsed.graphId);
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
