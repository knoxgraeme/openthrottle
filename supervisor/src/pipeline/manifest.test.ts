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
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";

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

function firstStage(value: Record<string, unknown>): Record<string, unknown> {
  return (value.stages as Array<Record<string, unknown>>)[0]!;
}

const CORE_IMPLEMENT_V4_STAGE_IDS = [
  "implementation",
  "repair_implementation",
  "repair_semantic_review",
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
      "core/implement@4",
      "core/investigate@1",
    ]);
    const implementManifest = resolvePipelineReference(first, "implement").manifest;
    expect(implementManifest.id).toBe("core/implement");
    expect(implementManifest.version).toBe(4);
    expect(() => resolvePipelineReference(first, "core/implement@3"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "core/implement@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture/command@1"))
      .toThrow(/unknown pipeline selection/);
    expect(() => resolvePipelineReference(first, "fixture-command"))
      .toThrow(/unknown pipeline selection/);
    expect(implementManifest.stages.map((stage) => stage.id)).toEqual(CORE_IMPLEMENT_V4_STAGE_IDS);
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

  it("accepts manifest-set raw attempt and repair round budgets", () => {
    const value = manifest();
    value.max_attempts = 200;
    value.max_repair_rounds = 5;

    expect(validatePipelineManifest(value).manifest).toMatchObject({
      max_attempts: 200,
      max_repair_rounds: 5,
    });

    expect(() => validatePipelineManifest({ ...value, max_attempts: 201 }))
      .toThrow(/pipeline\.max_attempts: must be an integer between 1 and 200/);
    expect(() => validatePipelineManifest({ ...value, max_repair_rounds: 21 }))
      .toThrow(/pipeline\.max_repair_rounds: must be an integer between 1 and 20/);
  });

  it("accepts repository command names while preserving command executor validation", () => {
    const value = manifest();
    value.requires = { protocol: "stage-executor@1", capabilities: ["command/run@1"] };
    Object.assign(firstStage(value), {
      executor: { kind: "command", capability: "command/run@1" },
      commandName: "docs-check",
      evaluator: {
        kind: "command",
        assurance: "executor_verified",
        required_artifacts: ["command_result"],
      },
      context: "none",
      live_steering: false,
      credentials: ["repo.read"],
      produces: ["stage_result", "command_result"],
    });

    expect(validatePipelineManifest(value).manifest.stages[0]?.commandName).toBe("docs-check");

    firstStage(value).commandName = "Docs Check!";
    expect(() => validatePipelineManifest(value))
      .toThrow(/pipeline\.stages\[0\]\.commandName: has an invalid format/);
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

  it("ships core/implement@4 with round-based repair budget and scoped repair re-entry", () => {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    const catalog = loadPipelineCatalog(path, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor);
    const v4 = resolvePipelineReference(catalog, "core/implement@4").manifest;

    expect(v4.version).toBe(4);
    expect(v4.max_attempts).toBe(200);
    expect(v4.max_repair_rounds).toBe(5);
    expect(v4.stages.map((stage) => stage.id)).toEqual(CORE_IMPLEMENT_V4_STAGE_IDS);

    const implementation = v4.stages.find((stage) => stage.id === "implementation")!;
    const repairImplementation = v4.stages.find((stage) => stage.id === "repair_implementation")!;
    const semanticReview = v4.stages.find((stage) => stage.id === "semantic_review")!;
    const repairSemanticReview = v4.stages.find((stage) => stage.id === "repair_semantic_review")!;

    expect(implementation.transitions.success).toEqual({ to: "semantic_review" });
    expect(semanticReview.transitions.success).toEqual({ to: "simplification" });
    expect(semanticReview.transitions.no_change).toEqual({ to: "simplification" });
    expect(semanticReview.transitions.semantic_repair_required).toEqual({
      to: "repair_implementation",
      max_reentries: 5,
      on_exhausted: "needs_human",
    });

    expect(repairImplementation.executor).toEqual(implementation.executor);
    expect(repairImplementation.context).toBe("resume_required");
    expect(repairImplementation.transitions.success).toEqual({ to: "repair_semantic_review" });
    expect(repairImplementation.transitions.no_change).toEqual({ to: "repair_semantic_review" });
    expect(repairSemanticReview.executor).toEqual(semanticReview.executor);
    expect(repairSemanticReview.transitions.success).toEqual({ to: "test" });
    expect(repairSemanticReview.transitions.no_change).toEqual({ to: "test" });
  });

  it("keeps multi-version and provider-neutral manifests in a test-only catalog", () => {
    const path = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
    const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");
    const catalog = loadPipelineCatalog(path, runtime.descriptor);

    expect([...catalog.manifests.keys()]).toEqual([
      "fixture/command@1",
      "fixture/command@2",
      "fixture/agent@1",
      "fixture/dual-review@1",
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
    expect(() => validatePipelineManifest(unbounded)).toThrow(/re-entering transitions must declare max_reentries/);

    const boundedForwardOnly = manifest();
    const later = structuredClone(firstStage(boundedForwardOnly));
    later.id = "later";
    firstStage(boundedForwardOnly).transitions = transitions({
      success: { to: "later", max_reentries: 1, on_exhausted: "failed" },
    });
    later.transitions = transitions({
      success: { to: "stage" },
    });
    (boundedForwardOnly.stages as Array<Record<string, unknown>>).push(later);
    expect(() => validatePipelineManifest(boundedForwardOnly))
      .toThrow(/pipeline\.stages\.later\.transitions\.success: re-entering transitions must declare max_reentries/);

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

  it("requires command executors to declare a valid repository command name", () => {
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
    expect(validatePipelineManifest(command).manifest.stages[0]).toMatchObject({ commandName: "deploy" });

    stage.commandName = "Deploy!";
    expect(() => validatePipelineManifest(command)).toThrow(/commandName: has an invalid format/);

    const agent = manifest();
    firstStage(agent).commandName = "test";
    expect(() => validatePipelineManifest(agent)).toThrow(/commandName: is allowed only for command executors/);
  });

  it("pins unit phase metadata only on graph for-each-unit stages", () => {
    const value = manifest();
    value.requires = { protocol: "stage-executor@1", capabilities: ["graph/for-each-unit@1"] };
    Object.assign(firstStage(value), {
      executor: { kind: "loop_action", capability: "graph/for-each-unit@1" },
      evaluator: { kind: "semantic", assurance: "executor_verified", required_artifacts: ["execution_graph_result"] },
      context: "none",
      live_steering: false,
      credentials: ["repo.read", "repo.write"],
      produces: ["stage_result", "execution_graph_result"],
      unitPhases: ["implement", "candidate", "lead", "integrate"],
      unitCommandNames: [],
    });

    expect(validatePipelineManifest(value).manifest.stages[0]).toMatchObject({
      unitPhases: ["implement", "candidate", "lead", "integrate"],
      unitCommandNames: [],
    });

    const missingPhases = structuredClone(value) as Record<string, unknown>;
    delete firstStage(missingPhases).unitPhases;
    expect(() => validatePipelineManifest(missingPhases))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: is required for graph\/for-each-unit@1 stages/);

    const duplicatePhases = structuredClone(value) as Record<string, unknown>;
    firstStage(duplicatePhases).unitPhases = ["implement", "implement", "candidate", "lead", "integrate"];
    expect(() => validatePipelineManifest(duplicatePhases))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: must not contain duplicates/);

    const missingRequired = structuredClone(value) as Record<string, unknown>;
    firstStage(missingRequired).unitPhases = ["integrate"];
    expect(() => validatePipelineManifest(missingRequired))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: must include implement/);

    const outOfOrder = structuredClone(value) as Record<string, unknown>;
    firstStage(outOfOrder).unitPhases = ["implement", "candidate", "integrate", "lead"];
    expect(() => validatePipelineManifest(outOfOrder))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: integrate must be last/);

    const commandAfterCandidate = structuredClone(value) as Record<string, unknown>;
    firstStage(commandAfterCandidate).unitPhases = ["implement", "candidate", "command", "lead", "integrate"];
    expect(() => validatePipelineManifest(commandAfterCandidate))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: candidate must immediately precede lead/);

    const agent = manifest();
    Object.assign(firstStage(agent), {
      unitPhases: ["implement", "candidate", "lead", "integrate"],
      unitCommandNames: [],
    });
    expect(() => validatePipelineManifest(agent))
      .toThrow(/pipeline\.stages\[0\]\.unitPhases: unit phase metadata is allowed only for graph\/for-each-unit@1 stages/);
  });

  it("bounds repository skill package identity inside its declared directory", () => {
    const value = manifest();
    value.requires = { protocol: "stage-executor@1", capabilities: ["agent/repository-skill@1"] };
    const stage = firstStage(value);
    stage.executor = { kind: "agent", capability: "agent/repository-skill@1" };
    stage.repositorySkill = {
      schema: "openthrottle.repository-skill-package/v1",
      reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
      invocation: "implement_unit",
      directory: ".agents/skills/implement-unit",
      commit: "a".repeat(40),
      packageDigest: "b".repeat(64),
      files: [{
        path: ".agents/skills/implement-unit/SKILL.md",
        blobSha: "c".repeat(40),
        digest: "d".repeat(64),
      }],
    };

    expect(validatePipelineManifest(value).manifest.stages[0]).toMatchObject({
      repositorySkill: {
        reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
        invocation: "implement_unit",
      },
    });

    const escaped = structuredClone(value) as Record<string, unknown>;
    ((firstStage(escaped).repositorySkill as Record<string, unknown>).files as Array<Record<string, unknown>>)[0]!.path =
      ".agents/skills/other/SKILL.md";
    expect(() => validatePipelineManifest(escaped))
      .toThrow(/repositorySkill\.files\[0\]\.path: must stay inside/);

    const missingSkill = structuredClone(value) as Record<string, unknown>;
    ((firstStage(missingSkill).repositorySkill as Record<string, unknown>).files as Array<Record<string, unknown>>)[0]!.path =
      ".agents/skills/implement-unit/helper.md";
    expect(() => validatePipelineManifest(missingSkill))
      .toThrow(/repositorySkill\.files: must include SKILL\.md/);

    const oversizedPath = structuredClone(value) as Record<string, unknown>;
    ((firstStage(oversizedPath).repositorySkill as Record<string, unknown>).files as Array<Record<string, unknown>>)[0]!.path =
      `.agents/skills/implement-unit/${"a".repeat(300)}/SKILL.md`;
    expect(() => validatePipelineManifest(oversizedPath))
      .toThrow(/repositorySkill\.files\[0\]\.path: must be at most 320 characters/);

    const mismatchedReference = structuredClone(value) as Record<string, unknown>;
    (firstStage(mismatchedReference).repositorySkill as Record<string, unknown>).reference =
      `repo://owner/repo@${"a".repeat(40)}#.agents/skills/other`;
    expect(() => validatePipelineManifest(mismatchedReference))
      .toThrow(/repositorySkill\.reference: must name the same/);
  });

  it("accepts only bounded repository settings and canonical pipeline selections", () => {
    const parsed = parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
agent: codex
commands:
  test: npm test --prefix supervisor
test: npm test --prefix supervisor
limits: { max_turns: 20, task_timeout: 300 }
pipelines: { implement: implement, investigate: core/investigate@2 }
mcp_servers: {}
intents:
  implement: { default_graph: simple, allowed_graphs: [simple] }
  investigate: { default_graph: simple, allowed_graphs: [simple] }
`);
    expect(parsed.config.pipelines).toEqual({
      implement: "implement",
      investigate: "core/investigate@2",
    });
    expect(parseRepositoryConfig(parsed.normalized.replace(/^/, "")).digest).toBe(parsed.digest);
    expect(() => parseRepositoryConfig("pipelines: { implement: implement }\n"))
      .toThrow(/schema: must be openthrottle\.config\/v1/);
    expect(() => parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
pipeline_logic: !!js/function evil
`)).toThrow();
    expect(() => parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
limits: { task_timeout: 999999 }
`)).toThrow(/between 1 and 86400/);
    expect(() => parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
mcp_servers: { local: { command: node, surprise: true } }
`)).toThrow(/unknown field/);
  });

  it("keeps canonical commands and sandbox compatibility aliases in sync", () => {
    const commandsOnly = parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
commands:
  test: npm test
intents:
  implement: { default_graph: simple, allowed_graphs: [simple] }
  investigate: { default_graph: simple, allowed_graphs: [simple] }
`);
    expect(commandsOnly.config.commands).toEqual({ test: "npm test" });
    expect(commandsOnly.config.test).toBe("npm test");

    const legacyOnly = parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
test: npm test
intents:
  implement: { default_graph: simple, allowed_graphs: [simple] }
  investigate: { default_graph: simple, allowed_graphs: [simple] }
`);
    expect(legacyOnly.config.commands).toEqual({ test: "npm test" });
    expect(legacyOnly.config.test).toBe("npm test");

    expect(() => parseRepositoryConfig(`
schema: openthrottle.config/v1
default_graph: simple
graphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]
commands:
  test: npm test
test: npm run different
intents:
  implement: { default_graph: simple, allowed_graphs: [simple] }
  investigate: { default_graph: simple, allowed_graphs: [simple] }
`)).toThrow(/test: must match commands\.test/);
  });
});
