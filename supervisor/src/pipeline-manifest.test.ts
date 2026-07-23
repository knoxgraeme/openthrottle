import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPipelineCatalog,
  parsePipelineManifest,
  parseRepositoryConfig,
  resolvePipelineReference,
  validatePipelineManifest,
} from "./pipeline-manifest.js";
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

function transitions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: { terminal: "shipped" },
    no_change: { terminal: "no_change" },
    semantic_repair_required: { terminal: "needs_human" },
    retryable_infrastructure_failure: { terminal: "failed" },
    needs_human: { terminal: "needs_human" },
    canceled: { terminal: "canceled" },
    superseded: { terminal: "superseded" },
    failure: { terminal: "failed" },
    ...overrides,
  };
}

function manifest(): Record<string, unknown> {
  return {
    schema: "openthrottle.pipeline/v1",
    id: "fixture/test",
    version: 1,
    description: "A test pipeline.",
    entry_stage: "stage",
    max_attempts: 3,
    requires: { protocol: "stage-executor@1", capabilities: ["agent/semantic@1"] },
    stages: [{
      id: "stage",
      executor: { kind: "agent", capability: "agent/semantic@1" },
      evaluator: {
        kind: "semantic",
        assurance: "semantic_attested",
        required_artifacts: ["stage_result"],
      },
      context: "fresh",
      live_steering: true,
      credentials: ["model.invoke", "repo.read"],
      produces: ["stage_result"],
      transitions: transitions(),
    }],
  };
}

describe("pipeline manifest validation", () => {
  it("loads the shipped catalog deterministically against independent runtime evidence", () => {
    const path = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
    const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");
    const first = loadPipelineCatalog(path, runtime.descriptor);
    const second = loadPipelineCatalog(path, runtime.descriptor);

    expect(first.digest).toBe(second.digest);
    expect([...first.manifests.keys()]).toEqual([
      "ce/implement@2",
      "ce/investigate@2",
    ]);
    expect(resolvePipelineReference(first, "implement").manifest.id).toBe("ce/implement");
    expect(() => resolvePipelineReference(first, "ce/implement@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "ce/investigate@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture/command@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture-command"))
      .toThrow(/unknown pipeline selection/);
    expect(resolvePipelineReference(first, "implement").manifest.stages.map((stage) => stage.id)).toEqual([
      "planning",
      "implementation",
      "semantic_review",
      "simplification",
      "test",
      "lint",
      "build",
      "publish",
      "provider",
    ]);
    expect(resolvePipelineReference(first, "investigate").manifest.stages.map((stage) => stage.id)).toEqual([
      "investigate",
      "publish",
    ]);
  });

  it("keeps multi-version and provider-neutral manifests in a test-only catalog", () => {
    const path = fileURLToPath(new URL("./__fixtures__/pipelines/catalog.yaml", import.meta.url));
    const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");
    const catalog = loadPipelineCatalog(path, runtime.descriptor);

    expect([...catalog.manifests.keys()]).toEqual([
      "fixture/command@1",
      "fixture/command@2",
      "fixture/agent@1",
    ]);
    expect(resolvePipelineReference(catalog, "fixture/command@1").manifest.id).toBe("fixture/command");
    expect(resolvePipelineReference(catalog, "fixture-command").manifest.version).toBe(2);
  });

  it("normalizes key order and rejects unknown or duplicate YAML fields", () => {
    const value = manifest();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(validatePipelineManifest(value).digest).toBe(validatePipelineManifest(reordered).digest);
    expect(() => validatePipelineManifest({ ...value, surprise: true })).toThrow(/unknown field/);
    expect(() => parsePipelineManifest(`schema: openthrottle.pipeline/v1\nschema: duplicate\n`)).toThrow(/Map keys must be unique/);
  });

  it("fails closed on graph, executor, artifact, assurance, and capability defects", () => {
    const unbounded = manifest();
    (unbounded.stages as Array<Record<string, unknown>>)[0]!.transitions = transitions({
      semantic_repair_required: { to: "stage" },
    });
    expect(() => validatePipelineManifest(unbounded)).toThrow(/unbounded cycle/);

    const unreachable = manifest();
    (unreachable.stages as unknown[]).push({
      ...(unreachable.stages as Array<Record<string, unknown>>)[0],
      id: "orphan",
    });
    expect(() => validatePipelineManifest(unreachable)).toThrow(/unreachable/);

    for (const [path, update, expected] of [
      ["executor", (stage: Record<string, unknown>) => { stage.executor = { kind: "shell", capability: "agent/semantic@1" }; }, /must be one of/],
      ["retired publisher", (stage: Record<string, unknown>) => { stage.executor = { kind: "publish", capability: "agent/semantic@1" }; }, /must be one of/],
      ["artifact", (stage: Record<string, unknown>) => { stage.produces = ["mystery"]; }, /must be one of/],
      ["assurance", (stage: Record<string, unknown>) => { stage.evaluator = { kind: "semantic", assurance: "agent_says_pass", required_artifacts: ["stage_result"] }; }, /must be one of/],
    ] as const) {
      const invalid = manifest();
      update((invalid.stages as Array<Record<string, unknown>>)[0]!);
      expect(() => validatePipelineManifest(invalid), path).toThrow(expected);
    }

    const runtime = buildInstalledRuntimeDescriptor("limited/v1", {
      capabilities: ["command/run@1"],
    });
    expect(() => validatePipelineManifest(manifest(), { runtime: runtime.descriptor })).toThrow(
      /runtime capability mismatch.*agent\/semantic@1/
    );

    const undeclared = manifest();
    (undeclared.requires as { capabilities: string[] }).capabilities = ["command/run@1"];
    expect(() => validatePipelineManifest(undeclared)).toThrow(/not declared in requires.capabilities/);
  });

  it("accepts only bounded repository settings and canonical pipeline selections", () => {
    const parsed = parseRepositoryConfig(`
agent: codex
test: npm test --prefix supervisor
limits: { max_turns: 20, task_timeout: 300 }
pipelines: { implement: implement, investigate: ce/investigate@2 }
mcp_servers: {}
`);
    expect(parsed.config.pipelines).toEqual({
      implement: "implement",
      investigate: "ce/investigate@2",
    });
    expect(parseRepositoryConfig(parsed.normalized.replace(/^/, "")).digest).toBe(parsed.digest);
    expect(() => parseRepositoryConfig("pipeline_logic: !!js/function evil")).toThrow();
    expect(() => parseRepositoryConfig("limits: { task_timeout: 999999 }")).toThrow(/between 1 and 86400/);
    expect(() => parseRepositoryConfig("mcp_servers: { local: { command: node, surprise: true } }")).toThrow(/unknown field/);
  });
});
