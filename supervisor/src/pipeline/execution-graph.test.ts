import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPipelineCatalog, resolvePipelineReference, type PipelineManifest, type PipelineStage } from "./manifest.js";
import {
  REPOSITORY_SKILL_CAPABILITY,
  parseAndCompileExecutionGraph,
  validateAndCompileExecutionGraph,
} from "./execution-graph.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";

const catalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const simpleGraphPath = fileURLToPath(new URL("../../graphs/simple-v1.json", import.meta.url));
const investigateGraphPath = fileURLToPath(new URL("../../graphs/investigate-v1.json", import.meta.url));
const structuredV1GraphPath = fileURLToPath(new URL("../../graphs/structured-v1.json", import.meta.url));
const structuredV2GraphPath = fileURLToPath(new URL("../../graphs/structured-v2.json", import.meta.url));
const structuredV3GraphPath = fileURLToPath(new URL("../../graphs/structured-v3.json", import.meta.url));
const SIMPLE_GRAPH_DIGEST = "2f25ae9b891405d0e73e5f3c0f103354183c8cb27ca923cbd06baa6c470b76d1";
const SIMPLE_MANIFEST_DIGEST = "f49011080d9f377bf4b9507eb1b47243e7a87f0918acfcc10e80b5940b505c0d";
const INVESTIGATE_GRAPH_DIGEST = "a76d3e1360d92f41bc7aa9ed2372e294555478d5854808bf0c2a5ed7febaf317";
const INVESTIGATE_MANIFEST_DIGEST = "80bb12f5b10d771d65d7235e308c2489b33ff6878a452069cf8c23621dec9329";
const STRUCTURED_AGGREGATE_PUBLISH_OPTIONS = {
  aggregatePublishContext: "prefer_resume",
} as const;

function shippedManifest(reference: string): PipelineManifest {
  const catalog = loadPipelineCatalog(catalogPath, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor);
  return resolvePipelineReference(catalog, reference).manifest;
}

function compiledGraph(path: string, options: Parameters<typeof parseAndCompileExecutionGraph>[1]): PipelineManifest {
  return parseAndCompileExecutionGraph(readFileSync(path, "utf8"), { source: path, ...options }).manifest.manifest;
}

function stageBehavior(stage: PipelineStage): unknown {
  return {
    id: stage.id,
    executor: stage.executor,
    commandName: stage.commandName,
    evaluator: stage.evaluator,
    context: stage.context,
    live_steering: stage.live_steering,
    credentials: stage.credentials,
    produces: stage.produces,
    transitions: stage.transitions,
  };
}

function behavior(manifest: PipelineManifest): unknown {
  return {
    entry_stage: manifest.entry_stage,
    max_attempts: manifest.max_attempts,
    max_repair_rounds: manifest.max_repair_rounds,
    requires: manifest.requires,
    stages: manifest.stages.map(stageBehavior),
  };
}

function minimalGraph(overrides: {
  worker?: Record<string, unknown>;
  loop?: Record<string, unknown>;
  node?: Record<string, unknown>;
  extraNodes?: Record<string, unknown>[];
} = {}): Record<string, unknown> {
  return {
    schema: "openthrottle.graph/v1",
    id: "fixture/graph",
    version: 1,
    entry_node: "stage",
    workers: [{
      id: "worker",
      engine: "agent",
      skills: ["builtin://ce/implement@1"],
      session_scope: "fresh",
      credentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
      ...overrides.worker,
    }],
    loops: [{
      id: "loop",
      worker: "worker",
      skill: "builtin://ce/implement@1",
      input_scope: "graph",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
      ...overrides.loop,
    }],
    nodes: [{
      id: "stage",
      kind: "run",
      loop: "loop",
      depends_on: [],
      transitions: { success: { terminal: "completed" } },
      ...overrides.node,
    }, ...(overrides.extraNodes ?? [])],
  };
}

function repositorySkillPackage() {
  return {
    schema: "openthrottle.repository-skill-package/v1" as const,
    reference: `repo://owner/repo@${"a".repeat(40)}#.openthrottle/skills/implement_unit`,
    invocation: "implement_unit",
    directory: ".openthrottle/skills/implement_unit",
    commit: "a".repeat(40),
    packageDigest: "d".repeat(64),
    files: [{
      path: ".openthrottle/skills/implement_unit/SKILL.md",
      blobSha: "b".repeat(40),
      digest: "c".repeat(64),
    }],
  };
}

function minimalUnitGraph(overrides: {
  worker?: Record<string, unknown>;
  loop?: Record<string, unknown>;
  leadWorker?: Record<string, unknown>;
  leadLoop?: Record<string, unknown>;
  phases?: unknown[];
} = {}): Record<string, unknown> {
  return {
    schema: "openthrottle.graph/v1",
    id: "fixture/units",
    version: 1,
    entry_node: "units",
    workers: [{
      id: "worker",
      engine: "agent",
      skills: ["builtin://ce/implement@1"],
      allowed_mcp_servers: [],
      session_scope: "fresh",
      credentials: ["model.invoke", "provider.read", "repo.read"],
      ...overrides.worker,
    }, {
      id: "lead-worker",
      engine: "agent",
      skills: ["builtin://accept-unit@1"],
      allowed_mcp_servers: [],
      session_scope: "fresh",
      credentials: ["model.invoke", "repo.read"],
      ...overrides.leadWorker,
    }],
    loops: [{
      id: "loop",
      worker: "worker",
      skill: "builtin://ce/implement@1",
      input_scope: "unit",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
      ...overrides.loop,
    }, {
      id: "lead-loop",
      worker: "lead-worker",
      skill: "builtin://accept-unit@1",
      input_scope: "unit",
      receipt: "unit_decision",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
      ...overrides.leadLoop,
    }],
    nodes: [{
      id: "units",
      kind: "for_each_unit",
      phases: overrides.phases ?? [
        { id: "implement", kind: "agent", loop: "loop" },
        { id: "candidate", kind: "evidence" },
        { id: "lead", kind: "gate", loop: "lead-loop" },
        { id: "integrate", kind: "integrate" },
      ],
      depends_on: [],
      transitions: { success: { terminal: "completed" } },
    }],
  };
}

describe("execution graph compiler", () => {
  it("keeps the built-in simple parity compile byte-identical to core/implement@4", () => {
    const deployed = resolvePipelineReference(
      loadPipelineCatalog(catalogPath, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor),
      "core/implement@4"
    );
    const compiled = parseAndCompileExecutionGraph(readFileSync(simpleGraphPath, "utf8"), {
      source: simpleGraphPath,
      id: deployed.manifest.id,
      version: deployed.manifest.version,
      description: deployed.manifest.description,
      maxAttempts: 200,
      maxRepairRounds: 5,
      includeOrdinaryLoopBinding: false,
    });

    expect(behavior(compiled.manifest.manifest)).toEqual(behavior(deployed.manifest));
    expect(compiled.manifest.manifest.id).toBe("core/implement");
    expect(compiled.graphDigest).toBe(SIMPLE_GRAPH_DIGEST);
    expect(compiled.manifest.digest).toBe(SIMPLE_MANIFEST_DIGEST);
    expect(compiled.manifest.digest).toBe(deployed.digest);
  });

  it("compiles the built-in investigate graph behaviorally equivalent to core/investigate@1", () => {
    const compiled = compiledGraph(investigateGraphPath, {
      id: "builtin/investigate",
      version: 1,
      description: "Built-in investigation graph compiled to the CE investigation manifest.",
      maxAttempts: 8,
    });

    expect(behavior(compiled)).toEqual(behavior(shippedManifest("core/investigate@1")));
    expect(parseAndCompileExecutionGraph(readFileSync(investigateGraphPath, "utf8"), {
      source: investigateGraphPath,
      id: "builtin/investigate",
      version: 1,
      description: "Built-in investigation graph compiled to the CE investigation manifest.",
      maxAttempts: 8,
    })).toMatchObject({
      graphDigest: INVESTIGATE_GRAPH_DIGEST,
      manifest: { digest: INVESTIGATE_MANIFEST_DIGEST },
    });
  });

  it("keeps the shipped default catalog on core/implement@4", () => {
    const catalog = loadPipelineCatalog(catalogPath, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor);

    expect(resolvePipelineReference(catalog, "implement").manifest).toMatchObject({
      id: "core/implement",
      version: 4,
    });
  });

  it("keeps built-in structured v1 on the legacy aggregate terminal behavior", () => {
    const runtime = buildInstalledRuntimeDescriptor("structured-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("base-test/v1").descriptor.capabilities,
        "accept-unit@1",
        "ce/simplify@1",
        "graph/for-each-unit@1",
      ],
    });
    const compiled = parseAndCompileExecutionGraph(readFileSync(structuredV1GraphPath, "utf8"), {
      source: structuredV1GraphPath,
      runtime: runtime.descriptor,
    });

    expect(compiled.manifest.manifest).toMatchObject({
      id: "builtin/structured",
      version: 1,
      entry_stage: "units",
      requires: {
        capabilities: [
          "ce/implement@1",
          "ce/simplify@1",
          "graph/for-each-unit@1",
          "accept-unit@1",
        ],
      },
    });
    expect(compiled.manifest.manifest.stages.map((stage) => stage.id)).toEqual(["units"]);
    expect(compiled.manifest.manifest.stages[0]?.transitions.success).toEqual({ terminal: "shipped" });
  });

  it("compiles structured v2 to the repaired aggregate publish provider tail", () => {
    const runtime = buildInstalledRuntimeDescriptor("structured-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("base-test/v1").descriptor.capabilities,
        "accept-unit@1",
        "ce/simplify@1",
        "graph/for-each-unit@1",
      ],
    });
    const compiled = parseAndCompileExecutionGraph(readFileSync(structuredV2GraphPath, "utf8"), {
      source: structuredV2GraphPath,
      runtime: runtime.descriptor,
      ...STRUCTURED_AGGREGATE_PUBLISH_OPTIONS,
    });

    expect(compiled.manifest.manifest).toMatchObject({
      id: "builtin/structured",
      version: 2,
      entry_stage: "units",
      requires: {
        capabilities: [
          "ce/implement@1",
          "ce/simplify@1",
          "ce/publish@1",
          "graph/for-each-unit@1",
          "provider/wait@1",
          "accept-unit@1",
        ],
      },
    });
    expect(compiled.manifest.manifest.stages[0]).toMatchObject({
      id: "units",
      executor: { kind: "loop_action", capability: "graph/for-each-unit@1" },
      evaluator: { kind: "semantic", assurance: "executor_verified", required_artifacts: ["execution_graph_result"] },
      context: "none",
      live_steering: false,
      credentials: ["provider.read", "repo.read"],
      produces: ["stage_result", "execution_graph_result"],
      unitPhases: ["implement", "simplify", "command", "candidate", "lead", "integrate"],
      unitCommandNames: ["test", "lint", "build"],
    });
    const phaseAction = (phase: NonNullable<PipelineStage["unitPhaseBindings"]>[number]): string => {
      if (phase.kind === "command") return "command";
      if (phase.kind === "agent" || phase.kind === "gate") return phase.executor.capability;
      return phase.kind;
    };
    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.map((phase) => ({
      id: phase.id,
      kind: phase.kind,
      action: phaseAction(phase),
      receipt: phase.kind === "agent" || phase.kind === "gate" ? phase.loop.receipt : undefined,
    }))).toEqual([
      { id: "implement", kind: "agent", action: "ce/implement@1", receipt: "unit_completion" },
      { id: "simplify", kind: "agent", action: "ce/simplify@1", receipt: "unit_completion" },
      { id: "command", kind: "command", action: "command", receipt: undefined },
      { id: "candidate", kind: "evidence", action: "evidence", receipt: undefined },
      { id: "lead", kind: "gate", action: "accept-unit@1", receipt: "unit_decision" },
      { id: "integrate", kind: "integrate", action: "integrate", receipt: undefined },
    ]);
    expect(compiled.manifest.manifest.stages.map((stage) => stage.id)).toEqual(["units", "publish", "provider"]);
    expect(compiled.manifest.manifest.stages[0]?.transitions.success).toEqual({ to: "publish" });
    expect(compiled.manifest.manifest.stages[1]).toMatchObject({
      id: "publish",
      executor: { kind: "agent", capability: "ce/publish@1" },
      context: "prefer_resume",
      transitions: {
        success: { to: "provider" },
        semantic_repair_required: { terminal: "needs_human" },
      },
    });
    expect(compiled.manifest.manifest.stages[2]).toMatchObject({
      id: "provider",
      executor: { kind: "provider_wait", capability: "provider/wait@1" },
      transitions: {
        success: { terminal: "shipped" },
        semantic_repair_required: { terminal: "needs_human" },
      },
    });
    expect(compiled.unitPhases).toEqual(["implement", "simplify", "command", "candidate", "lead", "integrate"]);
    expect(compiled.unitCommandNames).toEqual(["test", "lint", "build"]);
    expect(compiled.manifest.manifest.stages[0]?.transitions.no_change).toEqual({ terminal: "no_change" });
  });

  it("compiles the structured graph against the shipped production runtime descriptor", () => {
    const compiled = parseAndCompileExecutionGraph(readFileSync(structuredV3GraphPath, "utf8"), {
      source: structuredV3GraphPath,
      runtime: buildInstalledRuntimeDescriptor("production-like/v1").descriptor,
      ...STRUCTURED_AGGREGATE_PUBLISH_OPTIONS,
    });
    expect(compiled.manifest.manifest.requires.capabilities).toContain("graph/for-each-unit@1");
    expect(compiled.manifest.manifest.version).toBe(3);
    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.find((binding) => binding.id === "lead"))
      .toMatchObject({
        kind: "gate",
        context: "prefer_resume",
        worker: { id: "lead-worker", session_scope: "graph" },
      });
  });

  it("preserves repository graph output for direct aggregate publish unless explicitly opted in", () => {
    const graph = minimalUnitGraph({
      worker: { session_scope: "attempt" },
    });
    const units = (graph.nodes as Record<string, unknown>[])[0]!;
    units.transitions = {
      success: { to: "publish" },
      repair_required: { terminal: "needs_human" },
      retryable_failure: { terminal: "failed" },
      failure: { terminal: "failed" },
    };
    (graph.nodes as Record<string, unknown>[]).push({
      id: "publish",
      kind: "publish",
      depends_on: [],
      transitions: {
        success: { terminal: "completed" },
        repair_required: { terminal: "needs_human" },
        retryable_failure: { terminal: "failed" },
        failure: { terminal: "failed" },
      },
    });

    const compiled = validateAndCompileExecutionGraph(graph, {
      id: "repository/a",
      version: 7,
    });
    const publish = compiled.manifest.manifest.stages.find((stage) => stage.id === "publish")!;

    expect(publish.context).toBe("resume_required");
    expect(compiled.manifest.digest).toBe("db5b8eaccee24a465f7a123438798a944793f08f25bf85c61603734a3b7c101b");
  });

  it("opts aggregate publish into prefer_resume only through the explicit compiler option", () => {
    const graph = minimalUnitGraph();
    const units = (graph.nodes as Record<string, unknown>[])[0]!;
    units.transitions = {
      success: { to: "publish" },
      repair_required: { terminal: "needs_human" },
      retryable_failure: { terminal: "failed" },
      failure: { terminal: "failed" },
    };
    (graph.nodes as Record<string, unknown>[]).push({
      id: "publish",
      kind: "publish",
      depends_on: [],
      transitions: {
        success: { terminal: "completed" },
        repair_required: { terminal: "needs_human" },
        retryable_failure: { terminal: "failed" },
        failure: { terminal: "failed" },
      },
    });

    const compiled = validateAndCompileExecutionGraph(graph, {
      aggregatePublishContext: "prefer_resume",
    });
    const publish = compiled.manifest.manifest.stages.find((stage) => stage.id === "publish")!;

    expect(publish.context).toBe("prefer_resume");
    expect(() => validateAndCompileExecutionGraph(graph, {
      aggregatePublishContext: "fresh" as unknown as "prefer_resume",
    })).toThrow(/compile\.aggregatePublishContext: must be prefer_resume when provided/);
  });

  it("changes the pinned manifest digest when only a unit phase worker binding changes", () => {
    const base = validateAndCompileExecutionGraph(minimalUnitGraph({
      worker: { model: "gpt-5" },
    }));
    const changed = validateAndCompileExecutionGraph(minimalUnitGraph({
      worker: { model: "gpt-5-mini" },
    }));

    expect(base.manifest.manifest.stages[0]?.unitPhases).toEqual(changed.manifest.manifest.stages[0]?.unitPhases);
    expect(base.manifest.manifest.stages[0]?.unitCommandNames).toEqual(changed.manifest.manifest.stages[0]?.unitCommandNames);
    expect(base.manifest.manifest.stages[0]?.unitPhaseBindings?.[0]).toMatchObject({
      id: "implement",
      worker: { model: "gpt-5" },
    });
    expect(changed.manifest.manifest.stages[0]?.unitPhaseBindings?.[0]).toMatchObject({
      id: "implement",
      worker: { model: "gpt-5-mini" },
    });
    expect(base.manifest.digest).not.toEqual(changed.manifest.digest);
  });

  it("pins repository skill package identity inside unit phase bindings", () => {
    const pkg = repositorySkillPackage();
    const compiled = validateAndCompileExecutionGraph(minimalUnitGraph({
      worker: {
        skills: ["repo://implement_unit"],
        credentials: ["model.invoke", "provider.read", "repo.read"],
      },
      loop: { skill: "repo://implement_unit" },
    }), {
      repositorySkills: new Map([["implement_unit", pkg]]),
    });

    expect(compiled.manifest.manifest.requires.capabilities).toEqual([
      "graph/for-each-unit@1",
      REPOSITORY_SKILL_CAPABILITY,
      "accept-unit@1",
    ]);
    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.[0]).toMatchObject({
      id: "implement",
      kind: "agent",
      executor: { kind: "agent", capability: REPOSITORY_SKILL_CAPABILITY },
      repositorySkill: pkg,
    });
    expect(compiled.unitPhaseBindings[0]).toMatchObject({
      id: "implement",
      repositorySkill: pkg,
    });
  });

  it("preserves authored ordinary run loop execution settings on compiled stages", () => {
    const compiled = validateAndCompileExecutionGraph(minimalGraph({
      worker: {
        skills: ["builtin://ce/review@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      loop: {
        skill: "builtin://ce/review@1",
        input_scope: "diff",
        receipt: "semantic_review",
        max_rounds: 7,
        timeout_seconds: 123,
      },
    }), { ordinaryStageTimeoutSeconds: 123 });

    expect(compiled.manifest.manifest.stages[0]?.loop).toEqual({
      id: "loop",
      skill: "builtin://ce/review@1",
      input_scope: "diff",
      receipt: "semantic_review",
      max_parallel: 1,
      max_rounds: 7,
      timeout_seconds: 123,
    });
  });

  it.each([
    { capability: "ce/implement@1", scope: "diff", expected: "graph" },
    { capability: "ce/implement@1", scope: "review", expected: "graph" },
    { capability: "ce/review@1", scope: "graph", expected: "diff" },
    { capability: "ce/review@1", scope: "review", expected: "diff" },
    { capability: "ce/simplify@1", scope: "graph", expected: "diff" },
    { capability: "ce/simplify@1", scope: "review", expected: "diff" },
  ] as const)("rejects $capability ordinary input scope $scope", ({ capability, scope, expected }) => {
    const credentials = capability === "ce/implement@1"
      ? ["model.invoke", "provider.read", "repo.read", "repo.write"]
      : ["model.invoke", "repo.read"];
    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      worker: { skills: [`builtin://${capability}`], credentials },
      loop: { skill: `builtin://${capability}`, input_scope: scope },
    }))).toThrow(new RegExp(
      `graph\\.loops\\.loop\\.input_scope: must be ${expected} for ${capability.replace("/", "\\/")}`
    ));
  });

  it.each([123, 600])("rejects ordinary run loop timeout %s when the enforced stage timeout is 300", (timeoutSeconds) => {
    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      loop: { timeout_seconds: timeoutSeconds },
    }), {
      ordinaryStageTimeoutSeconds: 300,
    })).toThrow(/graph\.loops\.loop\.timeout_seconds: must equal the enforced ordinary stage timeout 300/);
  });

  it("preserves authored structured loop execution settings in unit phase bindings", () => {
    const compiled = validateAndCompileExecutionGraph(minimalUnitGraph({
      loop: { max_rounds: 7, timeout_seconds: 123 },
      leadLoop: { max_rounds: 2, timeout_seconds: 45 },
    }));

    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.[0]).toMatchObject({
      id: "implement",
      loop: {
        input_scope: "unit",
        max_parallel: 1,
        max_rounds: 7,
        timeout_seconds: 123,
      },
    });
    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.[2]).toMatchObject({
      id: "lead",
      loop: {
        input_scope: "unit",
        max_parallel: 1,
        max_rounds: 2,
        timeout_seconds: 45,
      },
    });
  });

  it("rejects gate phases whose worker requests write credentials", () => {
    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: { credentials: ["model.invoke", "repo.read", "repo.write"] },
    }))).toThrow(/graph\.nodes\.units\.phases\[2\]\.worker\.credentials: gate phases cannot request repo\.write/);
  });

  it("rejects gate phases whose capability requires write credentials", () => {
    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://ce/implement@1"],
        credentials: ["model.invoke", "provider.read", "repo.read", "repo.write"],
      },
      leadLoop: { skill: "builtin://ce/implement@1" },
    }))).toThrow(/graph\.nodes\.units\.phases\[2\]\.worker\.credentials: gate phases cannot request repo\.write/);

    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://ce/implement@1"],
        credentials: ["model.invoke", "provider.read", "repo.read"],
      },
      leadLoop: { skill: "builtin://ce/implement@1" },
    }))).toThrow(/graph\.nodes\.units\.phases\.2\.skill: ce\/implement@1 is not runnable for the lead phase; expected accept-unit@1/);
  });

  it("allows implement unit workers to request declared MCP access", () => {
    const compiled = validateAndCompileExecutionGraph(minimalUnitGraph({
      worker: {
        allowed_mcp_servers: ["github"],
        credentials: ["model.invoke", "mcp", "provider.read", "repo.read"],
      },
    }));

    expect(compiled.manifest.manifest.stages[0]?.unitPhaseBindings?.[0]).toMatchObject({
      id: "implement",
      credentials: ["model.invoke", "mcp", "provider.read", "repo.read"],
      worker: { allowed_mcp_servers: ["github"] },
    });
  });

  it("rejects accept-unit gate phases that violate the shared credential contract", () => {
    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://accept-unit@1"],
        credentials: ["repo.read"],
      },
      leadLoop: { skill: "builtin://accept-unit@1" },
    }))).toThrow(/unitPhaseBindings\[2\]\.credentials: accept-unit@1 requires credential scope model\.invoke/);

    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://accept-unit@1"],
        credentials: ["model.invoke", "repo.read", "provider.read"],
      },
      leadLoop: { skill: "builtin://accept-unit@1" },
    }))).toThrow(/unitPhaseBindings\[2\]\.credentials: accept-unit@1 is not authorized for credential scope provider\.read/);
  });

  it("compiles repository skills to the platform repository-skill capability with pinned package identity", () => {
    const runtime = buildInstalledRuntimeDescriptor("repository-skill-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("base-test/v1").descriptor.capabilities,
        REPOSITORY_SKILL_CAPABILITY,
      ],
    });
    const pkg = repositorySkillPackage();
    const compiled = validateAndCompileExecutionGraph(minimalGraph({
      worker: {
        skills: ["repo://implement_unit"],
        credentials: ["model.invoke", "repo.read", "repo.write"],
      },
      loop: {
        skill: "repo://implement_unit",
      },
    }), {
      runtime: runtime.descriptor,
      repositorySkills: new Map([["implement_unit", pkg]]),
    }).manifest.manifest;

    expect(compiled.requires.capabilities).toEqual([REPOSITORY_SKILL_CAPABILITY]);
    expect(compiled.stages[0]).toMatchObject({
      executor: { kind: "agent", capability: REPOSITORY_SKILL_CAPABILITY },
      repositorySkill: pkg,
      credentials: ["model.invoke", "repo.read", "repo.write"],
    });

    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      worker: {
        skills: ["repo://implement_unit"],
        credentials: ["model.invoke", "repo.read", "repo.write"],
      },
      loop: {
        skill: "repo://implement_unit",
        input_scope: "diff",
      },
    }), {
      runtime: runtime.descriptor,
      repositorySkills: new Map([["implement_unit", pkg]]),
    })).toThrow(/graph\.loops\.loop\.input_scope: must be graph for agent\/repository-skill@1/);
  });

  it("compiles repository-defined command names from the pinned command inventory", () => {
    const compiled = validateAndCompileExecutionGraph(minimalGraph({
      node: {
        kind: "command",
        loop: undefined,
        command: "docs-check",
      },
    }), {
      config: {
        schema: "openthrottle.config/v1",
        default_graph: "docs",
        graphs: [{ id: "docs", kind: "repository", ref: ".openthrottle/graphs/docs.json" }],
        commands: { "docs-check": "npm run docs:check" },
      },
    }).manifest.manifest;

    expect(compiled.stages[0]).toMatchObject({
      id: "stage",
      executor: { kind: "command", capability: "command/run@1" },
      commandName: "docs-check",
    });
  });

  it("fails closed for unpinned repository skills and production runtimes without the repository-skill capability", () => {
    const graph = minimalGraph({
      worker: {
        skills: ["repo://implement_unit"],
        credentials: ["model.invoke", "repo.read"],
      },
      loop: {
        skill: "repo://implement_unit",
      },
    });
    expect(() => validateAndCompileExecutionGraph(graph))
      .toThrow(/repository skill implement_unit was not pinned by admission/);
    expect(() => validateAndCompileExecutionGraph(graph, {
      runtime: buildInstalledRuntimeDescriptor("production-like/v1").descriptor,
      repositorySkills: new Map([["implement_unit", repositorySkillPackage()]]),
    })).toThrow(/runtime capability mismatch: capability:agent\/repository-skill@1/);
  });

  it("rejects syntactically valid but unsupported builtin loop skills during compilation", () => {
    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      worker: {
        skills: ["builtin://ce/imaginary@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      loop: { skill: "builtin://ce/imaginary@1" },
    }))).toThrow(/graph\.loops\.loop\.skill: unsupported builtin capability ce\/imaginary@1/);
  });

  it("rejects syntactically valid but unsupported builtin unit phase skills during compilation", () => {
    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://accept-imaginary@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      leadLoop: { skill: "builtin://accept-imaginary@1" },
    }))).toThrow(/graph\.loops\.lead-loop\.skill: unsupported builtin capability accept-imaginary@1/);
  });

  it("rejects known builtin capabilities that have no ordinary stage dispatch adapter", () => {
    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      worker: {
        skills: ["builtin://accept-unit@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      loop: { skill: "builtin://accept-unit@1" },
    }))).toThrow(/graph\.loops\.loop\.skill: accept-unit@1 has no ordinary stage dispatch adapter/);
  });

  it("rejects builtin capabilities that do not match the structured phase adapter", () => {
    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      worker: {
        skills: ["builtin://ce/review@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      loop: { skill: "builtin://ce/review@1" },
    }))).toThrow(/graph\.nodes\.units\.phases\.0\.skill: ce\/review@1 is not runnable for the implement phase/);

    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      phases: [
        { id: "implement", kind: "agent", loop: "loop" },
        { id: "simplify", kind: "agent", loop: "loop" },
        { id: "candidate", kind: "evidence" },
        { id: "lead", kind: "gate", loop: "lead-loop" },
        { id: "integrate", kind: "integrate" },
      ],
    }))).toThrow(/graph\.nodes\.units\.phases\.1\.skill: ce\/implement@1 is not runnable for the simplify phase/);

    expect(() => validateAndCompileExecutionGraph(minimalUnitGraph({
      leadWorker: {
        skills: ["builtin://ce/review@1"],
        credentials: ["model.invoke", "repo.read"],
      },
      leadLoop: { skill: "builtin://ce/review@1" },
    }))).toThrow(/graph\.nodes\.units\.phases\.2\.skill: ce\/review@1 is not runnable for the lead phase/);
  });

  it.each([
    [
      "for_each_unit nodes",
      minimalGraph({
        worker: {
          credentials: ["model.invoke", "repo.read"],
        },
        node: {
          kind: "for_each_unit",
          loop: undefined,
          phases: [
            { id: "implement", kind: "agent", loop: "loop" },
            { id: "candidate", kind: "evidence" },
            { id: "lead", kind: "gate", loop: "loop" },
            { id: "integrate", kind: "integrate" },
          ],
        },
      }),
      /graph\.loops\.loop\.input_scope: for_each_unit phases require unit input scope/,
    ],
    [
      "parallel for_each_unit loops",
      minimalUnitGraph({ loop: { max_parallel: 2 } }),
      /graph\.loops\[0\]\.max_parallel: must be an integer between 1 and 1/,
    ],
    [
      "human nodes",
      minimalGraph({
        node: {
          kind: "human",
          loop: undefined,
          transitions: { success: { terminal: "completed" } },
        },
      }),
      /graph\.nodes\.stage\.kind: cannot compile human nodes yet/,
    ],
    [
      "dependency edges",
      minimalGraph({
        node: {
          transitions: { success: { to: "next" } },
          depends_on: ["next"],
        },
        extraNodes: [{
          id: "next",
          kind: "run",
          loop: "loop",
          depends_on: [],
          transitions: { success: { terminal: "completed" } },
        }],
      }),
      /graph\.nodes\.stage\.depends_on: cannot compile to PipelineManifest transitions yet/,
    ],
    [
      "non-agent loop workers",
      minimalGraph({ worker: { engine: "command" } }),
      /graph\.workers\.worker\.engine: cannot compile non-agent loop workers yet/,
    ],
    [
      "unsupported loop receipts",
      minimalGraph({ loop: { receipt: "command_result" } }),
      /graph\.loops\.loop\.receipt: cannot compile this loop receipt yet/,
    ],
    [
      "unauthorized loop credentials",
      minimalGraph({
        worker: {
          skills: ["builtin://ce/review@1"],
          credentials: ["repo.read"],
        },
        loop: {
          skill: "builtin://ce/review@1",
          input_scope: "diff",
          receipt: "semantic_review",
        },
      }),
      /graph\.loops\.loop: ce\/review@1 requires credential scope model\.invoke/,
    ],
    [
      "unsupported loop artifacts",
      minimalGraph({
        worker: {
          skills: ["builtin://ce/plan@1"],
          credentials: ["model.invoke", "repo.read"],
        },
        loop: {
          skill: "builtin://ce/plan@1",
          receipt: "semantic_review",
        },
      }),
      /graph\.loops\.loop: ce\/plan@1 cannot produce required artifact review/,
    ],
    [
      "unknown command inventory names",
      minimalGraph({
        node: {
          kind: "command",
          loop: undefined,
          command: "deploy",
        },
      }),
      /graph\.nodes\.stage\.command: must be one of: test, lint, build, format/,
    ],
  ])("fails closed for unsupported %s", (_label, graph, error) => {
    expect(() => validateAndCompileExecutionGraph(graph)).toThrow(error);
  });

  it("rejects repository command nodes absent from the pinned command inventory", () => {
    expect(() => validateAndCompileExecutionGraph(minimalGraph({
      node: {
        kind: "command",
        loop: undefined,
        command: "docs-check",
      },
    }), {
      config: {
        schema: "openthrottle.config/v1",
        default_graph: "docs",
        graphs: [{ id: "docs", kind: "repository", ref: ".openthrottle/graphs/docs.json" }],
        commands: { test: "npm test" },
      },
    })).toThrow(/graph\.nodes\.stage\.command: references an unknown repository command/);
  });
});
