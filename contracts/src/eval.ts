import {
  fail,
  normalizedContract,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import {
  validateSemanticResultSchema,
  type SemanticResultSchemaContract,
} from "./result-candidate.js";

export const EVAL_DEFINITION_SCHEMA = "openthrottle.eval-definition/v1" as const;
export const EVALUATOR_PRIMITIVE_REFERENCE = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*@\d+$/;

export interface EvalDefinition {
  schema: typeof EVAL_DEFINITION_SCHEMA;
  id: string;
  evaluator: string;
  result: SemanticResultSchemaContract;
}

export function validateEvalDefinition(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<EvalDefinition> {
  const source = options.source ?? "eval";
  const input = objectAt(value, source, ["schema", "id", "evaluator", "result"]);
  if (input.schema !== EVAL_DEFINITION_SCHEMA) {
    fail(`${source}.schema`, `must be ${EVAL_DEFINITION_SCHEMA}`);
  }
  const result = validateSemanticResultSchema(input.result, { source: `${source}.result` }).value;
  const id = stringAt(input.id, `${source}.id`, {
    max: 160,
    pattern: /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/,
  });
  if (result.id !== id) {
    fail(`${source}.result.id`, "must match the eval definition id");
  }
  return normalizedContract({
    schema: EVAL_DEFINITION_SCHEMA,
    id,
    evaluator: stringAt(input.evaluator, `${source}.evaluator`, {
      max: 200,
      pattern: EVALUATOR_PRIMITIVE_REFERENCE,
    }),
    result,
  });
}
