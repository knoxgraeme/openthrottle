import { compareCodeUnits } from "./canonical.js";
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

export interface GithubCheckRunObservationRequirement {
  kind: "check_run";
  name: string;
  app_slug: string;
}

export interface GithubCommitStatusObservationRequirement {
  kind: "commit_status";
  context: string;
  creator_login: string;
}

export type GithubObservationRequirement =
  | GithubCheckRunObservationRequirement
  | GithubCommitStatusObservationRequirement;

export interface GithubProviderEvidencePolicy {
  required_observations: GithubObservationRequirement[];
}

export interface ProviderEvidencePolicy {
  github: GithubProviderEvidencePolicy;
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
  provider_evidence?: ProviderEvidencePolicy;
}

const PROVIDER_EVIDENCE_TEXT_MAX = 200;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function providerEvidenceText(value: unknown, path: string): string {
  const parsed = stringAt(value, path, { max: PROVIDER_EVIDENCE_TEXT_MAX });
  if (parsed.trim().length === 0) fail(path, "must contain a non-whitespace value");
  if (CONTROL_CHARACTER.test(parsed)) fail(path, "must not contain control characters");
  return parsed;
}

function parseGithubObservation(value: unknown, path: string): GithubObservationRequirement {
  const candidate = objectAt(value, path, [
    "kind", "name", "app_slug", "context", "creator_login",
  ]);
  if (candidate.kind === "check_run") {
    const input = objectAt(value, path, ["kind", "name", "app_slug"]);
    return {
      kind: "check_run",
      name: providerEvidenceText(input.name, `${path}.name`),
      app_slug: providerEvidenceText(input.app_slug, `${path}.app_slug`),
    };
  }
  if (candidate.kind === "commit_status") {
    const input = objectAt(value, path, ["kind", "context", "creator_login"]);
    return {
      kind: "commit_status",
      context: providerEvidenceText(input.context, `${path}.context`),
      creator_login: providerEvidenceText(input.creator_login, `${path}.creator_login`),
    };
  }
  fail(`${path}.kind`, "must be one of: check_run, commit_status");
}

function githubObservationKey(observation: GithubObservationRequirement): string {
  return observation.kind === "check_run"
    ? `${observation.kind}\0${observation.name}\0${observation.app_slug}`
    : `${observation.kind}\0${observation.context}\0${observation.creator_login}`;
}

function parseGithubProviderEvidence(value: unknown, path: string): GithubProviderEvidencePolicy {
  const input = objectAt(value, path, ["required_observations"]);
  const observations = arrayAt(
    input.required_observations,
    `${path}.required_observations`,
    parseGithubObservation,
    { min: 1, max: 32 },
  );
  const keys = observations.map(githubObservationKey);
  if (new Set(keys).size !== keys.length) {
    fail(`${path}.required_observations`, "must not contain duplicate exact observations");
  }
  return {
    required_observations: [...observations].sort((left, right) => {
      const leftKey = githubObservationKey(left);
      const rightKey = githubObservationKey(right);
      return compareCodeUnits(leftKey, rightKey);
    }),
  };
}

export function validateGithubProviderEvidencePolicy(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<GithubProviderEvidencePolicy> {
  return normalizedContract(parseGithubProviderEvidence(
    value,
    options.source ?? "github_provider_evidence",
  ));
}

function parseProviderEvidence(value: unknown, path: string): ProviderEvidencePolicy {
  const input = objectAt(value, path, ["github"]);
  return {
    github: validateGithubProviderEvidencePolicy(input.github, {
      source: `${path}.github`,
    }).value,
  };
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
    "post_bootstrap", "limits", "provider_evidence",
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
  const limits = input.limits === undefined
    ? undefined
    : parseLimits(input.limits, `${source}.limits`);
  if (limits?.max_turns !== undefined && engine !== "claude") {
    fail(
      `${source}.limits.max_turns`,
      `is not enforceable by the pinned ${engine} runtime; only Claude supports a native turn cap`,
    );
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
    ...(limits === undefined ? {} : { limits }),
    ...(input.provider_evidence === undefined ? {} : {
      provider_evidence: parseProviderEvidence(input.provider_evidence, `${source}.provider_evidence`),
    }),
  });
}
