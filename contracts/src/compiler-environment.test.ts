import { describe, expect, it } from "vitest";
import {
  COMPILER_ENVIRONMENT_SCHEMA,
  COMPILER_ENVIRONMENT_VERSION,
  digestCanonicalJson,
  runtimeCapabilityDigest,
  validateCompilerEnvironmentDescriptor,
  verifyCompilerEnvironment,
  type CompilerEnvironmentDescriptor,
} from "./index.js";

function descriptor(overrides: Partial<CompilerEnvironmentDescriptor> = {}): CompilerEnvironmentDescriptor {
  const evaluatorPrimitives = overrides.evaluator_primitives ?? [
    "core/action-outcome@1",
    "core/review-outcome@1",
  ];
  const runtimeCapabilityInputs = overrides.runtime_capability_inputs ?? {
    runtime_manifest_digest: "a".repeat(64),
    validator_artifact_set_digest: "b".repeat(64),
  };
  const content = {
    schema: COMPILER_ENVIRONMENT_SCHEMA,
    version: COMPILER_ENVIRONMENT_VERSION,
    compiler_version: overrides.compiler_version ?? "definition-compiler/v1",
    runtime_capability_inputs: runtimeCapabilityInputs,
    runtime_capability_digest: overrides.runtime_capability_digest ?? runtimeCapabilityDigest({
      ...runtimeCapabilityInputs,
      evaluator_primitives: evaluatorPrimitives,
    }),
    evaluator_primitives: evaluatorPrimitives,
  };
  return {
    ...content,
    environment_digest: overrides.environment_digest ?? digestCanonicalJson(content),
  };
}

describe("compiler environment", () => {
  it("seals the compiler, runtime manifest, validator artifacts, and evaluator registry", () => {
    const value = descriptor();
    expect(validateCompilerEnvironmentDescriptor(value).value).toEqual(value);
    expect(verifyCompilerEnvironment(value, value.environment_digest).descriptor).toEqual(value);

    const changedEvaluator = descriptor({ evaluator_primitives: [
      "core/action-outcome@1",
      "core/review-outcome@1",
      "core/unit-outcome@1",
    ] });
    expect(changedEvaluator.runtime_capability_digest).not.toBe(value.runtime_capability_digest);
    expect(changedEvaluator.environment_digest).not.toBe(value.environment_digest);
  });

  it("rejects stale composite/environment digests, unordered evaluators, and unknown inputs", () => {
    const value = descriptor();
    expect(() => validateCompilerEnvironmentDescriptor({
      ...value,
      runtime_capability_digest: "c".repeat(64),
    })).toThrow(/runtime_capability_digest.*capability identity/);
    expect(() => validateCompilerEnvironmentDescriptor({
      ...value,
      environment_digest: "c".repeat(64),
    })).toThrow(/environment_digest.*canonical compiler environment/);
    expect(() => validateCompilerEnvironmentDescriptor(descriptor({
      evaluator_primitives: [...value.evaluator_primitives].reverse(),
    }))).toThrow(/strictly code-unit sorted/);
    expect(() => validateCompilerEnvironmentDescriptor({ ...value, ambient_default: true }))
      .toThrow(/ambient_default: unknown field/);
  });

  it("requires the pinned release digest and exposes an immutable snapshot", () => {
    const value = descriptor();
    expect(() => verifyCompilerEnvironment(value, "f".repeat(64)))
      .toThrow(/pinned release digest/);
    const trusted = verifyCompilerEnvironment(value, value.environment_digest);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.descriptor)).toBe(true);
    expect(Object.isFrozen(trusted.descriptor.evaluator_primitives)).toBe(true);
  });
});
