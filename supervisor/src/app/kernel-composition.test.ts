import { describe, expect, it, vi } from "vitest";
import {
  COMPILER_ENVIRONMENT_SCHEMA,
  COMPILER_ENVIRONMENT_VERSION,
  digestCanonicalJson,
  runtimeCapabilityDigest,
  verifyCompilerEnvironment,
  type CompilerEnvironmentDescriptor,
  type TrustedCompilerEnvironment,
} from "@openthrottle/contracts";
import {
  PolicyEnforcedKernelRuntimeCompatibility,
  authenticateKernelRuntimeCapabilities,
} from "./kernel-composition.js";

function runtimeSource(maxConcurrentAttempts: unknown = 1): Record<string, unknown> {
  return {
    schema: "openthrottle.runtime-capability-source/v1",
    release: "openthrottle-execution-kernel/v1",
    protocol: "attempt-executor@1",
    engines: ["claude", "codex", "opencode"],
    repository_authorities: ["edit", "inspect"],
    stage_kinds: ["agent", "command", "effect", "wait"],
    record_kinds: ["decision", "delivery", "result"],
    result_candidate_schema: "openthrottle.result-candidate/v1",
    checkpoint_protocol: "git-bundle@1",
    executor_primitives: ["core/daytona-provision@1"],
    max_concurrent_attempts: maxConcurrentAttempts,
  };
}

function compilerEnvironment(source: unknown): TrustedCompilerEnvironment {
  const runtimeCapabilityInputs = {
    runtime_manifest_digest: digestCanonicalJson(source),
    validator_artifact_set_digest: "b".repeat(64),
  };
  const evaluatorPrimitives = ["core/action-outcome@1"];
  const content = {
    schema: COMPILER_ENVIRONMENT_SCHEMA,
    version: COMPILER_ENVIRONMENT_VERSION,
    compiler_version: "definition-compiler/v1",
    runtime_capability_inputs: runtimeCapabilityInputs,
    runtime_capability_digest: runtimeCapabilityDigest({
      ...runtimeCapabilityInputs,
      evaluator_primitives: evaluatorPrimitives,
    }),
    evaluator_primitives: evaluatorPrimitives,
  };
  const descriptor: CompilerEnvironmentDescriptor = {
    ...content,
    environment_digest: digestCanonicalJson(content),
  };
  return verifyCompilerEnvironment(descriptor, descriptor.environment_digest);
}

describe("kernel release execution policy", () => {
  it("authenticates one frozen serial policy against the trusted compiler environment", () => {
    const source = runtimeSource();
    const authenticated = authenticateKernelRuntimeCapabilities({
      source,
      compiler_environment: compilerEnvironment(source),
    });

    expect(authenticated.execution_policy).toEqual({
      max_concurrent_attempts: 1,
      runtime_capability_digest: authenticated.execution_policy.runtime_capability_digest,
    });
    expect(Object.isFrozen(authenticated.execution_policy)).toBe(true);
    expect(() => authenticateKernelRuntimeCapabilities({
      source: runtimeSource(2),
      compiler_environment: compilerEnvironment(source),
    })).toThrow(/runtime manifest digest/);
  });

  it.each([0, -1, 1.5, "1"])("rejects invalid max_concurrent_attempts %j", (value) => {
    const source = runtimeSource(value);
    expect(() => authenticateKernelRuntimeCapabilities({
      source,
      compiler_environment: compilerEnvironment(source),
    })).toThrow(/max_concurrent_attempts.*positive integer/);
  });

  it("rejects a release width other than one even when its digest is authentic", () => {
    const source = runtimeSource(2);
    expect(() => authenticateKernelRuntimeCapabilities({
      source,
      compiler_environment: compilerEnvironment(source),
    })).toThrow(/max_concurrent_attempts.*supported release value 1/);
  });

  it("rejects a wide loop before delegating runtime compatibility", async () => {
    const source = runtimeSource();
    const authenticated = authenticateKernelRuntimeCapabilities({
      source,
      compiler_environment: compilerEnvironment(source),
    });
    const downstream = { assertCompatible: vi.fn() };
    const compatibility = new PolicyEnforcedKernelRuntimeCompatibility({
      execution_policy: authenticated.execution_policy,
      downstream,
    });

    await expect(compatibility.assertCompatible({
      manifest_runtime_capability_digest: authenticated.execution_policy.runtime_capability_digest,
      stages: [{
        id: "persona_review",
        kind: "agent",
        loop: { over: "selection.personas", max_parallel: 2 },
      }] as never,
      definition_entries: [{
        definition_kind: "pipeline",
        definition_id: "core/structured",
      }] as never,
    })).rejects.toThrow(
      /pipeline core\/structured.*loop persona_review.*offered width 2.*supported limit 1/,
    );
    expect(downstream.assertCompatible).not.toHaveBeenCalled();
  });

  it("admits serial loops only under the same release capability digest", async () => {
    const source = runtimeSource();
    const authenticated = authenticateKernelRuntimeCapabilities({
      source,
      compiler_environment: compilerEnvironment(source),
    });
    const downstream = { assertCompatible: vi.fn() };
    const compatibility = new PolicyEnforcedKernelRuntimeCompatibility({
      execution_policy: authenticated.execution_policy,
      downstream,
    });
    const input = {
      manifest_runtime_capability_digest: authenticated.execution_policy.runtime_capability_digest,
      stages: [
        { id: "implement_unit", loop: { over: "execution_plan.units", max_parallel: 1 } },
        { id: "persona_review", loop: { over: "selection.personas", max_parallel: 1 } },
      ] as never,
      definition_entries: [{
        definition_kind: "pipeline",
        definition_id: "core/structured",
      }] as never,
    };

    await expect(compatibility.assertCompatible(input)).resolves.toBeUndefined();
    expect(downstream.assertCompatible).toHaveBeenCalledOnce();
    await expect(compatibility.assertCompatible({
      ...input,
      manifest_runtime_capability_digest: "f".repeat(64),
    })).rejects.toThrow(/runtime capability digest.*release execution policy/);
    expect(downstream.assertCompatible).toHaveBeenCalledOnce();
  });
});
