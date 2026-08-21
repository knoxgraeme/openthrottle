import {
  COMMAND_NAME_PATTERN,
  IDENTIFIER,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  recordAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import { ENGINES, type Engine } from "./pipeline.js";

export const FILESYSTEM_CONFIG_SCHEMA = "openthrottle.config/v2" as const;

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface ConfigLimits {
  max_turns?: number;
  task_timeout?: number;
}

export interface FilesystemConfigContract {
  schema: typeof FILESYSTEM_CONFIG_SCHEMA;
  pipeline: string;
  engine: Engine;
  model?: string;
  reasoning_effort?: (typeof REASONING_EFFORTS)[number];
  commands?: Record<string, string>;
  post_bootstrap?: string[];
  limits?: ConfigLimits;
}

function parseStringList(value: unknown, path: string, max: number, entryMax = 1_000): string[] {
  return arrayAt(
    value,
    path,
    (entry, entryPath) => stringAt(entry, entryPath, { max: entryMax }),
    { max },
  );
}

function parseLimits(value: unknown, path: string): ConfigLimits {
  const input = objectAt(value, path, ["max_turns", "task_timeout"]);
  return {
    ...(input.max_turns === undefined ? {} : {
      max_turns: integerAt(input.max_turns, `${path}.max_turns`, 1, 10_000),
    }),
    ...(input.task_timeout === undefined ? {} : {
      task_timeout: integerAt(input.task_timeout, `${path}.task_timeout`, 1, 86_400),
    }),
  };
}

function parseCommandMap(value: unknown, path: string): Record<string, string> {
  return recordAt(
    value,
    path,
    (entry, entryPath) => stringAt(entry, entryPath, { max: 4_000 }),
    { max: 32, keyMax: 80, keyPattern: COMMAND_NAME_PATTERN },
  );
}

export function validateFilesystemConfigContract(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<FilesystemConfigContract> {
  const source = options.source ?? "config";
  const input = objectAt(value, source, [
    "schema", "pipeline", "engine", "model", "reasoning_effort", "commands",
    "post_bootstrap", "limits",
  ]);
  if (input.schema !== FILESYSTEM_CONFIG_SCHEMA) {
    fail(`${source}.schema`, `must be ${FILESYSTEM_CONFIG_SCHEMA}`);
  }
  const engine = enumAt(input.engine, `${source}.engine`, ENGINES);
  if (engine === "opencode" && input.reasoning_effort !== undefined) {
    fail(`${source}.reasoning_effort`, "is not supported for OpenCode");
  }
  if (engine === "opencode" && input.model === undefined) {
    fail(`${source}.model`, "is required for OpenCode because no ambient model default is allowed");
  }

  return normalizedContract({
    schema: FILESYSTEM_CONFIG_SCHEMA,
    pipeline: stringAt(input.pipeline, `${source}.pipeline`, { pattern: IDENTIFIER }),
    engine,
    ...(input.model === undefined ? {} : {
      model: stringAt(input.model, `${source}.model`, { max: 240, pattern: MODEL_REFERENCE }),
    }),
    ...(input.reasoning_effort === undefined ? {} : {
      reasoning_effort: enumAt(
        input.reasoning_effort,
        `${source}.reasoning_effort`,
        REASONING_EFFORTS,
      ),
    }),
    ...(input.commands === undefined ? {} : {
      commands: parseCommandMap(input.commands, `${source}.commands`),
    }),
    ...(input.post_bootstrap === undefined ? {} : {
      post_bootstrap: parseStringList(input.post_bootstrap, `${source}.post_bootstrap`, 32),
    }),
    ...(input.limits === undefined ? {} : {
      limits: parseLimits(input.limits, `${source}.limits`),
    }),
  });
}
