import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parsePipelineManifest,
  parseRepositoryConfig,
  resolvePipelineReference,
  validatePipelineManifest,
} from "./manifest.js";
import { buildInstalledRuntimeDescriptor } from "../runtime/contracts.js";

function transitions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = {
    success: { terminal: "shipped" },
    no_change: { terminal: "no_change" },
    semantic_repair_required: { terminal: "needs_human" },
    retryable_infrastructure_failure: { terminal: "failed" },
    needs_human: { terminal: "needs_human" },
    canceled: { terminal: "canceled" },
    superseded: { terminal: "superseded" },
    failure: { terminal: "failed" },
  };
  for (const [outcome, transition] of Object.entries(overrides)) {
    if (transition === undefined) delete output[outcome];
    else output[outcome] = transition;
  }
  return output;
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

function withoutIdentity(value: unknown): unknown {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.id;
  delete copy.version;
  return copy;
}

function firstStage(value: Record<string, unknown>): Record<string, unknown> {
  return (value.stages as Array<Record<string, unknown>>)[0]!;
}

const CORE_IMPLEMENT_V3_STAGE_IDS = [
  "implementation",
  "semantic_review",
  "simplification",
  "post_simplify_review",
  "test",
  "lint",
  "build",
  "publish",
  "provider",
];

describe("pipeline manifest validation", () => {
  it("loads the shipped catalog deterministically against independent runtime evidence", () => {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");
    const first = loadPipelineCatalog(path, runtime.descriptor);
    const second = loadPipelineCatalog(path, runtime.descriptor);

    expect(first.digest).toBe(second.digest);
    expect([...first.manifests.keys()]).toEqual([
      "core/implement@1",
      "core/implement@2",
      "core/implement@3",
      "core/investigate@1",
      "ce/implement@2",
      "ce/implement@3",
      "ce/implement@4",
      "ce/investigate@2",
    ]);
    const implementManifest = resolvePipelineReference(first, "implement").manifest;
    expect(implementManifest.id).toBe("core/implement");
    expect(implementManifest.version).toBe(3);
    expect(resolvePipelineReference(first, "ce/implement@4").manifest.id).toBe("ce/implement");
    expect(() => resolvePipelineReference(first, "ce/implement@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "ce/investigate@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture/command@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture-command"))
      .toThrow(/unknown pipeline selection/);
    expect(implementManifest.stages.map((stage) => stage.id)).toEqual(CORE_IMPLEMENT_V3_STAGE_IDS);
    expect(resolvePipelineReference(first, "investigate").manifest.stages.map((stage) => stage.id)).toEqual([
      "investigate",
      "publish",
    ]);
  });

  it("normalizes defaults and retry shorthand to the same JSON and digest as explicit transitions", () => {
    const explicit = manifest();
    firstStage(explicit).transitions = transitions({
      retryable_infrastructure_failure: { to: "stage", max_reentries: 2, on_exhausted: "failed" },
    });
    const shorthand = structuredClone(explicit) as Record<string, unknown>;
    shorthand.defaults = {
      transitions: transitions({ retryable_infrastructure_failure: undefined }),
      retry: { max_reentries: 2, on_exhausted: "failed" },
    };
    delete firstStage(shorthand).transitions;

    const explicitValidated = validatePipelineManifest(explicit);
    const shorthandValidated = validatePipelineManifest(shorthand);
    expect(shorthandValidated.normalized).toBe(explicitValidated.normalized);
    expect(shorthandValidated.digest).toBe(explicitValidated.digest);
    expect(digestNormalized(canonicalJson(shorthandValidated.manifest))).toBe(shorthandValidated.digest);
  });

  it("lets stage transitions and stage retry override manifest defaults", () => {
    const value = manifest();
    value.defaults = {
      transitions: transitions({ success: { terminal: "failed" } }),
      retry: { max_reentries: 2, on_exhausted: "failed" },
    };
    firstStage(value).transitions = {
      success: { terminal: "no_change" },
    };
    firstStage(value).retry = {
      max_reentries: 4,
      on_exhausted: "needs_human",
    };

    const stage = validatePipelineManifest(value).manifest.stages[0]!;
    expect(stage.transitions.success).toEqual({ terminal: "no_change" });
    expect(stage.transitions.retryable_infrastructure_failure).toEqual({
      to: "stage",
      max_reentries: 4,
      on_exhausted: "needs_human",
    });
  });

  it("applies retry shorthand after same-scope explicit retryable transitions", () => {
    const value = manifest();
    value.defaults = {
      transitions: transitions({
        retryable_infrastructure_failure: { terminal: "failed" },
      }),
      retry: { max_reentries: 2, on_exhausted: "failed" },
    };
    firstStage(value).transitions = {
      retryable_infrastructure_failure: { terminal: "needs_human" },
    };
    firstStage(value).retry = {
      max_reentries: 4,
      on_exhausted: "needs_human",
    };

    expect(validatePipelineManifest(value).manifest.stages[0]!.transitions.retryable_infrastructure_failure)
      .toEqual({ to: "stage", max_reentries: 4, on_exhausted: "needs_human" });
  });

  it("expands stage retry shorthand without manifest retry defaults", () => {
    const value = manifest();
    firstStage(value).transitions = transitions({
      retryable_infrastructure_failure: undefined,
    });
    firstStage(value).retry = {
      max_reentries: 5,
      on_exhausted: "failed",
    };

    expect(validatePipelineManifest(value).manifest.stages[0]!.transitions.retryable_infrastructure_failure)
      .toEqual({ to: "stage", max_reentries: 5, on_exhausted: "failed" });
  });

  it("rejects invalid defaults before reducers can observe them", () => {
    expect(() => validatePipelineManifest({
      ...manifest(),
      defaults: { transitions: { mystery: { terminal: "failed" } } },
    })).toThrow(/pipeline\.defaults\.transitions\.mystery: unknown outcome/);

    expect(() => validatePipelineManifest({
      ...manifest(),
      defaults: { transitions: { same_as: { terminal: "failed" } } },
    })).toThrow(/pipeline\.defaults\.transitions\.same_as: is reserved but not implemented/);

    const unknownTarget = manifest();
    unknownTarget.defaults = { transitions: { success: { to: "missing" } } };
    firstStage(unknownTarget).transitions = transitions({
      success: undefined,
    });
    expect(() => validatePipelineManifest(unknownTarget))
      .toThrow(/pipeline\.stages\.stage\.transitions\.success\.to: references an unknown stage/);
  });

  it("rejects retry shorthand targets because self-loop targets are implied", () => {
    expect(() => validatePipelineManifest({
      ...manifest(),
      defaults: { retry: { to: "stage", max_reentries: 2, on_exhausted: "failed" } },
    })).toThrow(/pipeline\.defaults\.retry\.to: unknown field/);

    const value = manifest();
    firstStage(value).retry = {
      to: "stage",
      max_reentries: 2,
      on_exhausted: "failed",
    };
    expect(() => validatePipelineManifest(value))
      .toThrow(/pipeline\.stages\[0\]\.retry\.to: unknown field/);
  });

  it("keeps neutral core manifests topology-equivalent to their immutable ce twins", () => {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    const catalog = loadPipelineCatalog(path, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor);

    expect(withoutIdentity(resolvePipelineReference(catalog, "core/implement@1").manifest))
      .toEqual(withoutIdentity(resolvePipelineReference(catalog, "ce/implement@3").manifest));
    expect(withoutIdentity(resolvePipelineReference(catalog, "core/implement@2").manifest))
      .toEqual(withoutIdentity(resolvePipelineReference(catalog, "ce/implement@4").manifest));
    expect(withoutIdentity(resolvePipelineReference(catalog, "core/investigate@1").manifest))
      .toEqual(withoutIdentity(resolvePipelineReference(catalog, "ce/investigate@2").manifest));
  });

  it("ships core/implement@3 with conditional post-simplification review", () => {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    const catalog = loadPipelineCatalog(path, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor);
    const v2 = resolvePipelineReference(catalog, "core/implement@2").manifest;
    const v3 = resolvePipelineReference(catalog, "core/implement@3").manifest;

    expect(v2.stages.some((stage) => stage.id === "post_simplify_review")).toBe(false);
    expect(v3.version).toBe(3);
    expect(v3.stages.map((stage) => stage.id)).toEqual(CORE_IMPLEMENT_V3_STAGE_IDS);

    const semanticReview = v3.stages.find((stage) => stage.id === "semantic_review")!;
    const postSimplifyReview = v3.stages.find((stage) => stage.id === "post_simplify_review")!;
    expect(postSimplifyReview.executor).toEqual(semanticReview.executor);
    expect(postSimplifyReview.evaluator).toEqual(semanticReview.evaluator);
    expect(postSimplifyReview.context).toBe(semanticReview.context);
    expect(postSimplifyReview.credentials).toEqual(semanticReview.credentials);
    expect(postSimplifyReview.produces).toEqual(semanticReview.produces);

    const simplification = v3.stages.find((stage) => stage.id === "simplification")!;
    expect(simplification.transitions.success).toEqual({ to: "post_simplify_review" });
    expect(simplification.transitions.no_change).toEqual({ to: "test" });
    expect(postSimplifyReview.transitions.success).toEqual({ to: "test" });
    expect(postSimplifyReview.transitions.no_change).toEqual({ to: "test" });
    expect(postSimplifyReview.transitions.semantic_repair_required).toEqual({
      to: "implementation",
      max_reentries: 3,
      on_exhausted: "needs_human",
    });
  });

  it("ships ce/implement@4 as an explicit-command plan-in pipeline while keeping legacy pinned instances immutable", () => {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");
    const catalog = loadPipelineCatalog(path, runtime.descriptor);

    // v2 stays registered so pinned instances keep resolving to an identical manifest.
    const v2 = resolvePipelineReference(catalog, "ce/implement@2").manifest;
    expect(v2.version).toBe(2);
    expect(v2.entry_stage).toBe("planning");
    expect(v2.requires.capabilities).toContain("ce/plan@1");
    expect(v2.stages.filter((stage) => stage.executor.kind === "command").map((stage) => stage.commandName))
      .toEqual([undefined, undefined, undefined]);

    // v3 removes planning: the shipped plan is already approved, implementation enters directly.
    const v3 = resolvePipelineReference(catalog, "ce/implement@3").manifest;
    expect(v3.version).toBe(3);
    expect(v3.entry_stage).toBe("implementation");
    expect(v3.stages.some((stage) => stage.id === "planning")).toBe(false);
    expect(v3.requires.capabilities).not.toContain("ce/plan@1");
    expect(v3.stages.filter((stage) => stage.executor.kind === "command").map((stage) => stage.commandName))
      .toEqual([undefined, undefined, undefined]);

    const v4 = resolvePipelineReference(catalog, "ce/implement@4").manifest;
    expect(v4.version).toBe(4);
    expect(v4.entry_stage).toBe("implementation");
    expect(v4.stages.filter((stage) => stage.executor.kind === "command").map((stage) => stage.commandName))
      .toEqual(["test", "lint", "build"]);

    // With no prior native session, the entry stage must start fresh, not resume.
    const implementation = v4.stages.find((stage) => stage.id === "implementation")!;
    expect(implementation.context).toBe("fresh");
    expect(implementation.live_steering).toBe(true);

    // Downstream stages still resume implementation's session, and nothing references planning.
    for (const id of ["semantic_review", "simplification", "publish"]) {
      expect(v4.stages.find((stage) => stage.id === id)?.context).toBe("resume_required");
    }
    for (const stage of v4.stages) {
      for (const transition of Object.values(stage.transitions)) {
        expect(transition.to).not.toBe("planning");
      }
    }
  });

  it("keeps multi-version and provider-neutral manifests in a test-only catalog", () => {
    const path = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
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

  it("requires command executors to declare an allowlisted repository command", () => {
    const command = manifest();
    command.requires = { protocol: "stage-executor@1", capabilities: ["command/run@1"] };
    const stage = firstStage(command);
    stage.executor = { kind: "command", capability: "command/run@1" };
    stage.commandName = "test";
    stage.evaluator = { kind: "command", assurance: "executor_verified", required_artifacts: ["command_result"] };
    stage.live_steering = false;
    stage.credentials = ["repo.read"];
    stage.produces = ["stage_result", "command_result"];

    expect(validatePipelineManifest(command).manifest.stages[0]).toMatchObject({ commandName: "test" });

    delete stage.commandName;
    expect(() => validatePipelineManifest(command)).toThrow(/commandName: is required for command executors/);

    stage.commandName = "deploy";
    expect(() => validatePipelineManifest(command)).toThrow(/commandName: must be one of/);

    const agent = manifest();
    firstStage(agent).commandName = "test";
    expect(() => validatePipelineManifest(agent)).toThrow(/commandName: is allowed only for command executors/);
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
