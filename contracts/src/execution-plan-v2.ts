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
import type { ExecutionPlanCommand } from "./execution-plan.js";

// Successor to openthrottle.execution-plan/v1. A v1 unit only carries IDs
// that index into a plan-level instructions/acceptance map, which the
// planning guidance described as an index over human-authoritative source
// prose -- so a planning agent could legally emit a pointer like "follow the
// requirements above" that resolves to nothing once the source prose is
// unavailable to a dispatched unit worker (OPE-166). A v2 unit instead
// carries every applicable value directly: it is the complete runtime
// authority for that unit, with no indirection through source prose a
// worker never sees.
export const EXECUTION_PLAN_SCHEMA_V2 = "openthrottle.execution-plan/v2" as const;

export interface ExecutionPlanUnitV2 {
  id: string;
  title: string;
  depends_on: string[];
  objective: string;
  requirements: string[];
  files: string[];
  approach: string[];
  tests: string[];
  acceptance: string[];
  verification: string[];
}

export interface ExecutionPlanContractV2 {
  schema: typeof EXECUTION_PLAN_SCHEMA_V2;
  graph_id: string;
  plan_id: string;
  units: ExecutionPlanUnitV2[];
  commands: ExecutionPlanCommand[];
}

function parseTextList(
  value: unknown,
  path: string,
  options: { min?: number; max: number; itemMax: number }
): string[] {
  return arrayAt(value, path, (entry, entryPath) => {
    return stringAt(entry, entryPath, { max: options.itemMax });
  }, options);
}

function parseUnitV2(value: unknown, path: string): ExecutionPlanUnitV2 {
  const input = objectAt(value, path, [
    "id", "title", "depends_on", "objective", "requirements", "files",
    "approach", "tests", "acceptance", "verification",
  ]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    title: stringAt(input.title, `${path}.title`, { max: 160 }),
    depends_on: parseIdentifierList(input.depends_on, `${path}.depends_on`, { max: 32 }),
    objective: stringAt(input.objective, `${path}.objective`, { max: 2_000 }),
    requirements: parseTextList(input.requirements, `${path}.requirements`, { min: 1, max: 32, itemMax: 2_000 }),
    files: parseTextList(input.files, `${path}.files`, { min: 1, max: 64, itemMax: 512 }),
    approach: parseTextList(input.approach, `${path}.approach`, { min: 1, max: 32, itemMax: 2_000 }),
    tests: parseTextList(input.tests, `${path}.tests`, { min: 1, max: 32, itemMax: 2_000 }),
    acceptance: parseTextList(input.acceptance, `${path}.acceptance`, { min: 1, max: 32, itemMax: 2_000 }),
    verification: parseTextList(input.verification, `${path}.verification`, { min: 1, max: 32, itemMax: 2_000 }),
  };
}

function validatePlanV2(plan: ExecutionPlanContractV2, source: string): void {
  const units = new Map(plan.units.map((unit) => [unit.id, unit]));
  if (units.size !== plan.units.length) fail(`${source}.units`, "must not contain duplicate IDs");
  for (const unit of plan.units) {
    for (const dependency of unit.depends_on) {
      if (!units.has(dependency)) fail(`${source}.units.${unit.id}.depends_on`, "references an unknown unit");
    }
  }
  for (const command of plan.commands) {
    if (command.unit && !units.has(command.unit)) fail(`${source}.commands.${command.name}.unit`, "references an unknown unit");
  }
  assertAcyclicDependencies(plan.units, `${source}.units`);
}

export function validateExecutionPlanContractV2(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<ExecutionPlanContractV2> {
  const source = options.source ?? "execution_plan";
  const input = objectAt(value, source, ["schema", "graph_id", "plan_id", "units", "commands"]);
  if (input.schema !== EXECUTION_PLAN_SCHEMA_V2) fail(`${source}.schema`, `must be ${EXECUTION_PLAN_SCHEMA_V2}`);
  const plan: ExecutionPlanContractV2 = {
    schema: EXECUTION_PLAN_SCHEMA_V2,
    graph_id: stringAt(input.graph_id, `${source}.graph_id`, { pattern: IDENTIFIER }),
    plan_id: stringAt(input.plan_id, `${source}.plan_id`, { pattern: IDENTIFIER }),
    units: arrayAt(input.units, `${source}.units`, parseUnitV2, { min: 1, max: 64 }),
    commands: arrayAt(input.commands, `${source}.commands`, parsePlanCommand, { max: 16 }),
  };
  validatePlanV2(plan, source);
  return normalizedContract(plan);
}

export function parseExecutionPlanContractV2(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<ExecutionPlanContractV2> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "execution_plan", "JSON exceeds 256 KiB");
  return validateExecutionPlanContractV2(JSON.parse(raw) as unknown, options);
}
