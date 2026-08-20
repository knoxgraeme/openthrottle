import { digestCanonicalJson } from "./canonical.js";
import {
  SHA256,
  arrayAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";

export const COMPILER_ENVIRONMENT_SCHEMA = "openthrottle.compiler-environment/v1" as const;
export const COMPILER_ENVIRONMENT_VERSION = 1 as const;
export const DEFINITION_COMPILER_VERSION = "definition-compiler/v1" as const;
export const CORE_EVALUATOR_PRIMITIVES = Object.freeze([
  "core/action-outcome@1",
  "core/review-outcome@1",
  "core/unit-outcome@1",
] as const);

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const EVALUATOR_PRIMITIVE = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*@\d+$/;
const trustedCompilerEnvironment = Symbol("openthrottle.trusted-compiler-environment");
const trustedCompilerEnvironments = new WeakMap<object, CompilerEnvironmentDescriptor>();

export interface RuntimeCapabilityInputs {
  runtime_manifest_digest: string;
  validator_artifact_set_digest: string;
}

export interface RuntimeCapabilityIdentity extends RuntimeCapabilityInputs {
  evaluator_primitives: string[];
}

export interface CompilerEnvironmentDescriptor {
  schema: typeof COMPILER_ENVIRONMENT_SCHEMA;
  version: typeof COMPILER_ENVIRONMENT_VERSION;
  compiler_version: string;
  runtime_capability_inputs: RuntimeCapabilityInputs;
  runtime_capability_digest: string;
  evaluator_primitives: string[];
  environment_digest: string;
}

export interface TrustedCompilerEnvironment {
  readonly descriptor: CompilerEnvironmentDescriptor;
  readonly [trustedCompilerEnvironment]: true;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function runtimeCapabilityDigest(identity: RuntimeCapabilityIdentity): string {
  return digestCanonicalJson(identity);
}

export function validateCompilerEnvironmentDescriptor(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<CompilerEnvironmentDescriptor> {
  const source = options.source ?? "compiler_environment";
  const input = objectAt(value, source, [
    "schema",
    "version",
    "compiler_version",
    "runtime_capability_inputs",
    "runtime_capability_digest",
    "evaluator_primitives",
    "environment_digest",
  ]);
  if (input.schema !== COMPILER_ENVIRONMENT_SCHEMA) {
    fail(`${source}.schema`, `must be ${COMPILER_ENVIRONMENT_SCHEMA}`);
  }
  const version = integerAt(
    input.version,
    `${source}.version`,
    COMPILER_ENVIRONMENT_VERSION,
    COMPILER_ENVIRONMENT_VERSION,
  ) as typeof COMPILER_ENVIRONMENT_VERSION;
  const capabilityInput = objectAt(
    input.runtime_capability_inputs,
    `${source}.runtime_capability_inputs`,
    ["runtime_manifest_digest", "validator_artifact_set_digest"],
  );
  const runtimeCapabilityInputs = {
    runtime_manifest_digest: stringAt(
      capabilityInput.runtime_manifest_digest,
      `${source}.runtime_capability_inputs.runtime_manifest_digest`,
      { pattern: SHA256 },
    ),
    validator_artifact_set_digest: stringAt(
      capabilityInput.validator_artifact_set_digest,
      `${source}.runtime_capability_inputs.validator_artifact_set_digest`,
      { pattern: SHA256 },
    ),
  };
  const evaluatorPrimitives = arrayAt(
    input.evaluator_primitives,
    `${source}.evaluator_primitives`,
    (entry, path) => stringAt(entry, path, { max: 160, pattern: EVALUATOR_PRIMITIVE }),
    { min: 1, max: 64 },
  );
  for (let index = 1; index < evaluatorPrimitives.length; index += 1) {
    if (compareCodeUnits(evaluatorPrimitives[index - 1]!, evaluatorPrimitives[index]!) >= 0) {
      fail(`${source}.evaluator_primitives`, "must be strictly code-unit sorted without duplicates");
    }
  }
  const capabilityDigest = stringAt(
    input.runtime_capability_digest,
    `${source}.runtime_capability_digest`,
    { pattern: SHA256 },
  );
  if (capabilityDigest !== runtimeCapabilityDigest({
    ...runtimeCapabilityInputs,
    evaluator_primitives: evaluatorPrimitives,
  })) {
    fail(`${source}.runtime_capability_digest`, "does not match the canonical capability identity");
  }
  const content = {
    schema: COMPILER_ENVIRONMENT_SCHEMA,
    version,
    compiler_version: stringAt(input.compiler_version, `${source}.compiler_version`, {
      max: 160,
      pattern: VERSION,
    }),
    runtime_capability_inputs: runtimeCapabilityInputs,
    runtime_capability_digest: capabilityDigest,
    evaluator_primitives: evaluatorPrimitives,
  };
  const environmentDigest = stringAt(input.environment_digest, `${source}.environment_digest`, {
    pattern: SHA256,
  });
  if (environmentDigest !== digestCanonicalJson(content)) {
    fail(`${source}.environment_digest`, "does not match the canonical compiler environment");
  }
  return normalizedContract({ ...content, environment_digest: environmentDigest });
}

function freezeDescriptor(descriptor: CompilerEnvironmentDescriptor): CompilerEnvironmentDescriptor {
  Object.freeze(descriptor.runtime_capability_inputs);
  Object.freeze(descriptor.evaluator_primitives);
  return Object.freeze(descriptor);
}

function descriptorSnapshot(descriptor: CompilerEnvironmentDescriptor): CompilerEnvironmentDescriptor {
  return {
    ...descriptor,
    runtime_capability_inputs: { ...descriptor.runtime_capability_inputs },
    evaluator_primitives: [...descriptor.evaluator_primitives],
  };
}

export function verifyCompilerEnvironment(
  value: unknown,
  expectedEnvironmentDigest: string,
): TrustedCompilerEnvironment {
  const expected = stringAt(expectedEnvironmentDigest, "expected_environment_digest", {
    pattern: SHA256,
  });
  const validated = validateCompilerEnvironmentDescriptor(value).value;
  if (validated.environment_digest !== expected) {
    fail("compiler_environment.environment_digest", "does not match the pinned release digest");
  }
  const internal = freezeDescriptor(descriptorSnapshot(validated));
  const trusted = Object.freeze({
    descriptor: freezeDescriptor(descriptorSnapshot(validated)),
    [trustedCompilerEnvironment]: true as const,
  });
  trustedCompilerEnvironments.set(trusted, internal);
  return trusted;
}

export function reverifyCompilerEnvironment(
  environment: TrustedCompilerEnvironment,
): CompilerEnvironmentDescriptor {
  if (!environment || typeof environment !== "object") {
    fail("compiler_environment", "must be a verified compiler environment");
  }
  const descriptor = trustedCompilerEnvironments.get(environment);
  if (descriptor === undefined) {
    fail("compiler_environment", "must be produced by verifyCompilerEnvironment");
  }
  return freezeDescriptor(descriptorSnapshot(descriptor));
}
