import { EXECUTION_PLAN_SCHEMA, parseExecutionPlanContract, type ExecutionPlanContract } from "./execution-plan.js";
import { EXECUTION_PLAN_SCHEMA_V2, parseExecutionPlanContractV2, type ExecutionPlanContractV2 } from "./execution-plan-v2.js";
import { fail, type ValidatedContract } from "./validation.js";

// A structured plan's runtime consumers (admission projection and dispatch)
// must apply the exact same version-dispatch rule everywhere a sealed plan
// is read back, or the two could silently disagree on which schema a block
// is. This is that one rule.
export type AnyExecutionPlanContract = ExecutionPlanContract | ExecutionPlanContractV2;

export const EXECUTION_PLAN_SCHEMAS = [EXECUTION_PLAN_SCHEMA, EXECUTION_PLAN_SCHEMA_V2] as const;

export function parseAnyExecutionPlanContract(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<AnyExecutionPlanContract> {
  const source = options.source ?? "execution_plan";
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(source, "JSON exceeds 256 KiB");
  let parsedSchema: unknown;
  try {
    const parsed = JSON.parse(raw) as unknown;
    parsedSchema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).schema
      : undefined;
  } catch {
    fail(source, "must be valid JSON");
  }
  if (parsedSchema === EXECUTION_PLAN_SCHEMA_V2) return parseExecutionPlanContractV2(raw, options);
  if (parsedSchema === EXECUTION_PLAN_SCHEMA) return parseExecutionPlanContract(raw, options);
  fail(`${source}.schema`, `must be ${EXECUTION_PLAN_SCHEMA} or ${EXECUTION_PLAN_SCHEMA_V2}`);
}
