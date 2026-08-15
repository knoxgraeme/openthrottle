import {
  IDENTIFIER,
  arrayAt,
  assertAcyclicDependencies,
  fail,
  normalizedContract,
  objectAt,
  parseIdentifierList,
  parsePlanCommand,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const EXECUTION_PLAN_SCHEMA = "openthrottle.execution-plan/v1" as const;

interface ExecutionPlanUnit {
  id: string;
  title: string;
  depends_on: string[];
  instructions: string[];
  acceptance: string[];
}

export interface ExecutionPlanCommand {
  name: string;
  unit?: string;
}

export interface ExecutionPlanContract {
  schema: typeof EXECUTION_PLAN_SCHEMA;
  graph_id: string;
  plan_id: string;
  units: ExecutionPlanUnit[];
  instructions: Record<string, string>;
  acceptance: Record<string, string>;
  commands: ExecutionPlanCommand[];
}

function parseReferenceMap(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const input = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  const entries = Object.entries(input);
  for (const [key, entry] of entries) {
    if (!IDENTIFIER.test(key)) fail(`${path}.${key}`, "has an invalid format");
    output[key] = stringAt(entry, `${path}.${key}`, { max: 2_000 });
  }
  if (entries.length > 128) fail(path, "must contain at most 128 entries");
  return output;
}

function parseUnit(value: unknown, path: string): ExecutionPlanUnit {
  const input = objectAt(value, path, ["id", "title", "depends_on", "instructions", "acceptance"]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    title: stringAt(input.title, `${path}.title`, { max: 160 }),
    depends_on: parseIdentifierList(input.depends_on, `${path}.depends_on`, { max: 32 }),
    instructions: parseIdentifierList(input.instructions, `${path}.instructions`, { min: 1, max: 64 }),
    acceptance: parseIdentifierList(input.acceptance, `${path}.acceptance`, { min: 1, max: 64 }),
  };
}

function validatePlan(plan: ExecutionPlanContract, source: string): void {
  const units = new Map(plan.units.map((unit) => [unit.id, unit]));
  if (units.size !== plan.units.length) fail(`${source}.units`, "must not contain duplicate IDs");
  for (const unit of plan.units) {
    for (const dependency of unit.depends_on) {
      if (!units.has(dependency)) fail(`${source}.units.${unit.id}.depends_on`, "references an unknown unit");
    }
    for (const instruction of unit.instructions) {
      if (!Object.hasOwn(plan.instructions, instruction)) {
        fail(`${source}.units.${unit.id}.instructions`, "references an unknown instruction");
      }
    }
    for (const acceptance of unit.acceptance) {
      if (!Object.hasOwn(plan.acceptance, acceptance)) {
        fail(`${source}.units.${unit.id}.acceptance`, "references an unknown acceptance item");
      }
    }
  }
  for (const command of plan.commands) {
    if (command.unit && !units.has(command.unit)) fail(`${source}.commands.${command.name}.unit`, "references an unknown unit");
  }
  assertAcyclicDependencies(plan.units, `${source}.units`);
}

function validateExecutionPlanContract(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<ExecutionPlanContract> {
  const source = options.source ?? "execution_plan";
  const input = objectAt(value, source, [
    "schema", "graph_id", "plan_id", "units", "instructions", "acceptance", "commands",
  ]);
  if (input.schema !== EXECUTION_PLAN_SCHEMA) fail(`${source}.schema`, `must be ${EXECUTION_PLAN_SCHEMA}`);
  const plan: ExecutionPlanContract = {
    schema: EXECUTION_PLAN_SCHEMA,
    graph_id: stringAt(input.graph_id, `${source}.graph_id`, { pattern: IDENTIFIER }),
    plan_id: stringAt(input.plan_id, `${source}.plan_id`, { pattern: IDENTIFIER }),
    units: arrayAt(input.units, `${source}.units`, parseUnit, { min: 1, max: 64 }),
    instructions: parseReferenceMap(input.instructions, `${source}.instructions`),
    acceptance: parseReferenceMap(input.acceptance, `${source}.acceptance`),
    commands: arrayAt(input.commands, `${source}.commands`, parsePlanCommand, { max: 16 }),
  };
  validatePlan(plan, source);
  return normalizedContract(plan);
}

export function parseExecutionPlanContract(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<ExecutionPlanContract> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "execution_plan", "JSON exceeds 256 KiB");
  return validateExecutionPlanContract(JSON.parse(raw) as unknown, options);
}
