import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  parseExecutionPlanContract,
  parseGraphContract,
  validateExecutionPlanContract,
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
const UNIT_HEADING_PATTERN = /^###\s+(U[0-9]+[a-z]?)\.\s+(.+)$/gm;
const ID_PATTERN = /[A-Za-z][A-Za-z0-9_]*/g;

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "plan";
}

function sectionBody(markdown: string, heading: RegExp): string {
  const match = heading.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/\n##\s+/);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, start + next);
}

function extractLine(section: string, label: string): string | undefined {
  const match = section.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function idsFromText(value: string | undefined, prefix?: string): string[] {
  if (!value) return [];
  const matches = value.match(ID_PATTERN) ?? [];
  return [...new Set(matches.filter((entry) => !prefix || entry.startsWith(prefix)))];
}

function commandNamesFromText(value: string | undefined): string[] {
  const names = new Set<string>();
  for (const candidate of idsFromText(value)) {
    const lower = candidate.toLowerCase();
    if (["test", "lint", "build", "typecheck"].includes(lower)) names.add(lower);
  }
  return [...names];
}

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

export function prepareExecutionPlanBlock(markdown: string, graphId = "structured"): string {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "plan";
  const planId = slug(title);
  const implementationUnits = sectionBody(markdown, /^##\s+Implementation Units$/m);
  const matches = [...implementationUnits.matchAll(UNIT_HEADING_PATTERN)];
  if (matches.length === 0) {
    throw new Error("No Implementation Units with U-IDs were found.");
  }

  const instructions: Record<string, string> = {};
  const acceptance: Record<string, string> = {};
  const commands = new Set<string>();
  const units = matches.map((match, index) => {
    const id = match[1]!;
    const unitId = id.toLowerCase();
    const titleText = match[2]!.trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index ?? implementationUnits.length : implementationUnits.length;
    const body = implementationUnits.slice(start, end);
    const dependencies = idsFromText(extractLine(body, "Dependencies"), "U")
      .filter((dependency) => dependency !== id)
      .map((dependency) => dependency.toLowerCase());
    const goal = extractLine(body, "Goal") ?? titleText;
    const requirements = extractLine(body, "Requirements") ?? "";
    const verification = extractLine(body, "Verification") ?? "";
    const instructionId = `${unitId}_instructions`;
    const acceptanceId = `${unitId}_acceptance`;
    instructions[instructionId] = `${id}: ${goal}`;
    acceptance[acceptanceId] = [requirements, verification].filter(Boolean).join(" Verification: ");
    for (const command of commandNamesFromText(verification)) commands.add(command);
    return {
      id: unitId,
      title: `${id}. ${titleText}`,
      depends_on: dependencies,
      instructions: [instructionId],
      acceptance: [acceptanceId],
    };
  });

  const contract = validateExecutionPlanContract({
    schema: EXECUTION_PLAN_FENCE,
    graph_id: graphId,
    plan_id: planId,
    instructions,
    acceptance,
    units,
    commands: [...commands].sort().map((name) => ({ name })),
  }).value;
  return `\`\`\`json ${EXECUTION_PLAN_FENCE}\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}

export function upsertExecutionPlanBlock(markdown: string, block: string): string {
  const blocks = extractExecutionPlanBlocks(markdown);
  if (blocks.length > 1) {
    throw new Error(`expected at most one ${EXECUTION_PLAN_FENCE} block, found ${blocks.length}`);
  }
  if (blocks.length === 1) {
    const existing = blocks[0]!;
    return `${markdown.slice(0, existing.start)}${block}${markdown.slice(existing.end)}`;
  }
  const suffix = markdown.endsWith("\n") ? "" : "\n";
  return `${markdown}${suffix}\n## Execution Plan\n\n${block}\n`;
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
  const graph = parseGraphContract(readFileSync(graphPath, "utf8"), { source: source.ref });
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
    const content = readFileSync(parsed.file, "utf8");
    if (parsed.command === "prepare") {
      const block = prepareExecutionPlanBlock(content, parsed.graphId ?? "structured");
      const updated = upsertExecutionPlanBlock(content, block);
      const result = readExecutionPlanFromMarkdown(updated, parsed.file);
      if (parsed.write) {
        writeFileSync(parsed.file, updated);
      } else if (!parsed.json) {
        console.log(block);
      }
      if (parsed.json && !parsed.write) {
        console.log(JSON.stringify({
          ok: true,
          block,
          schema: result.plan.value.schema,
          digest: result.plan.digest,
          coverage: result.coverage,
        }, null, 2));
      } else {
        printValidation(result, parsed.json);
      }
      return;
    }
    const result = readExecutionPlanFromMarkdown(content, parsed.file);
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
