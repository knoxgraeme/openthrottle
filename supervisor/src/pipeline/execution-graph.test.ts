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
const structuredGraphPath = fileURLToPath(new URL("../../graphs/structured-v1.json", import.meta.url));
const SIMPLE_GRAPH_DIGEST = "2f25ae9b891405d0e73e5f3c0f103354183c8cb27ca923cbd06baa6c470b76d1";
const SIMPLE_MANIFEST_DIGEST = "9b705c003313187cb2f7e219c99e1cbf795d966be0e1d257015462219833ac6a";
const INVESTIGATE_GRAPH_DIGEST = "a76d3e1360d92f41bc7aa9ed2372e294555478d5854808bf0c2a5ed7febaf317";
const INVESTIGATE_MANIFEST_DIGEST = "d159ef720f5dbc7216b8dd502e3961ac30ffb2c4d4ea44a5afdc71a78f84da4e";

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
    reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
    invocation: "implement_unit",
    directory: ".agents/skills/implement-unit",
    commit: "a".repeat(40),
    packageDigest: "d".repeat(64),
    files: [{
      path: ".agents/skills/implement-unit/SKILL.md",
      blobSha: "b".repeat(40),
      digest: "c".repeat(64),
    }],
  };
}

describe("execution graph compiler", () => {
  it("compiles the built-in simple graph behaviorally equivalent to core/implement@4 with a new digest", () => {
    const compiled = parseAndCompileExecutionGraph(readFileSync(simpleGraphPath, "utf8"), {
      source: simpleGraphPath,
      id: "builtin/simple",
      version: 1,
      description: "Built-in simple implementation graph compiled to the staged CE manifest.",
      maxAttempts: 200,
      maxRepairRounds: 5,
    });
    const deployed = resolvePipelineReference(
      loadPipelineCatalog(catalogPath, buildInstalledRuntimeDescriptor("test-runtime/v1").descriptor),
      "core/implement@4"
    );

    expect(behavior(compiled.manifest.manifest)).toEqual(behavior(deployed.manifest));
    expect(compiled.manifest.manifest.id).toBe("builtin/simple");
    expect(compiled.graphDigest).toBe(SIMPLE_GRAPH_DIGEST);
    expect(compiled.manifest.digest).toBe(SIMPLE_MANIFEST_DIGEST);
    expect(compiled.manifest.digest).not.toBe(deployed.digest);
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

  it("compiles for_each_unit to the structured graph runtime capability with test descriptors", () => {
    const runtime = buildInstalledRuntimeDescriptor("structured-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("base-test/v1").descriptor.capabilities,
        "graph/for-each-unit@1",
      ],
    });
    const compiled = parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      source: structuredGraphPath,
      runtime: runtime.descriptor,
    });

    expect(compiled.manifest.manifest).toMatchObject({
      id: "builtin/structured",
      version: 1,
      entry_stage: "units",
      requires: { capabilities: ["graph/for-each-unit@1"] },
      stages: [{
        id: "units",
        executor: { kind: "loop_action", capability: "graph/for-each-unit@1" },
        evaluator: { kind: "semantic", assurance: "executor_verified", required_artifacts: ["execution_graph_result"] },
        context: "none",
        live_steering: false,
        credentials: ["provider.read", "repo.read", "repo.write"],
        produces: ["stage_result", "execution_graph_result"],
      }],
    });
    expect(compiled.manifest.manifest.stages[0]?.transitions.no_change).toEqual({ terminal: "no_change" });
  });

  it("rejects the structured graph against the shipped production runtime descriptor until the composite runtime lands", () => {
    expect(() => parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      source: structuredGraphPath,
      runtime: buildInstalledRuntimeDescriptor("production-like/v1").descriptor,
    })).toThrow(/runtime capability mismatch: capability:graph\/for-each-unit@1/);
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

  it.each([
    [
      "for_each_unit nodes",
      minimalGraph({ node: { kind: "for_each_unit" } }),
      /graph\.loops\.loop\.input_scope: for_each_unit requires unit input scope/,
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
          receipt: "semantic_review",
        },
      }),
      /graph\.loops\.loop: ce\/review@1 requires credential scope model\.invoke/,
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
