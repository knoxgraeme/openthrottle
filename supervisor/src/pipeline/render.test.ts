import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG_PATH, DOCS_PIPELINES_DIR, pipelineDocPages } from "./doc-pages.js";
import {
  loadPipelineCatalog,
  resolvePipelineReference,
  validatePipelineManifest,
  type PipelineManifest,
} from "./manifest.js";
import { pipelineDocFilename, renderManifestMermaid } from "./render.js";

const CATALOG = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));

function shippedManifest(reference: string): PipelineManifest {
  return resolvePipelineReference(loadPipelineCatalog(CATALOG), reference).manifest;
}

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

function stage(
  id: string,
  kind: "agent" | "command" | "provider_wait",
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const capability = kind === "agent" ? "agent/semantic@1" : kind === "command" ? "command/run@1" : "provider/wait@1";
  const evaluator = kind === "agent"
    ? { kind: "semantic", assurance: "semantic_attested", required_artifacts: ["stage_result"] }
    : kind === "command"
      ? { kind: "command", assurance: "executor_verified", required_artifacts: ["command_result"] }
      : { kind: "provider", assurance: "provider_verified", required_artifacts: ["provider_check"] };
  const produces = kind === "agent"
    ? ["stage_result"]
    : kind === "command"
      ? ["stage_result", "command_result"]
      : ["stage_result", "provider_check"];
  return {
    id,
    executor: { kind, capability },
    ...(kind === "command" ? { commandName: "test" } : {}),
    evaluator,
    context: "none",
    live_steering: false,
    credentials: [],
    produces,
    transitions: transitions(),
    ...overrides,
  };
}

function fixture(stages: Record<string, unknown>[]): PipelineManifest {
  return validatePipelineManifest({
    schema: "openthrottle.pipeline/v1",
    id: "fixture/render",
    version: 1,
    description: "A render fixture.",
    entry_stage: stages[0]!.id,
    max_attempts: 3,
    requires: {
      protocol: "stage-executor@1",
      capabilities: ["agent/semantic@1", "command/run@1", "provider/wait@1"],
    },
    stages,
  }).manifest;
}

describe("renderManifestMermaid node shapes", () => {
  it("gives each executor kind its own mermaid shape and label suffix", () => {
    const manifest = fixture([
      stage("alpha", "agent", { transitions: transitions({ success: { to: "bravo" } }) }),
      stage("bravo", "command", { transitions: transitions({ success: { to: "charlie" } }) }),
      stage("charlie", "provider_wait"),
    ]);
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    expect(output).toContain('alpha["alpha<br/>agent"]');
    expect(output).toContain('bravo[/"bravo<br/>command gate"/]');
    expect(output).toContain('charlie{{"charlie<br/>provider wait"}}');
  });

  it("starts with a flowchart header and the pipeline identity comment", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"));
    expect(output.split("\n")[0]).toBe("flowchart TD");
    expect(output.split("\n")[1]).toBe("    %% core/implement@4");
  });

  it("renames stage IDs that collide with mermaid keywords", () => {
    const manifest = fixture([
      stage("end", "agent", { transitions: transitions({ success: { to: "graph" } }) }),
      stage("graph", "agent"),
    ]);
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    expect(output).toContain('end_node["end<br/>agent"]');
    expect(output).toContain('graph_node["graph<br/>agent"]');
    expect(output).toContain('end_node -->|"success"| graph_node');
  });
});

describe("renderManifestMermaid edge classification", () => {
  it("uses a solid arrow only for forward transitions", () => {
    const manifest = fixture([
      stage("alpha", "agent", { transitions: transitions({ success: { to: "bravo" } }) }),
      stage("bravo", "agent"),
    ]);
    expect(renderManifestMermaid(manifest, { collapseUniform: false }))
      .toContain('alpha -->|"success"| bravo');
  });

  it("dashes a self-loop", () => {
    const manifest = fixture([
      stage("alpha", "agent", {
        transitions: transitions({
          success: { to: "bravo" },
          retryable_infrastructure_failure: { to: "alpha", max_reentries: 2, on_exhausted: "failed" },
        }),
      }),
      stage("bravo", "agent"),
    ]);
    expect(renderManifestMermaid(manifest, { collapseUniform: false }))
      .toContain('alpha -.->|"retryable_infrastructure_failure (≤2 → failed)"| alpha');
  });

  it("dashes a backwards transition to an earlier stage", () => {
    const manifest = fixture([
      stage("alpha", "agent", { transitions: transitions({ success: { to: "bravo" } }) }),
      stage("bravo", "agent", {
        transitions: transitions({
          failure: { to: "alpha", max_reentries: 3, on_exhausted: "needs_human" },
        }),
      }),
    ]);
    expect(renderManifestMermaid(manifest, { collapseUniform: false }))
      .toContain('bravo -.->|"failure (≤3 → needs_human)"| alpha');
  });

  it("classifies re-entry exactly as the coordinator does across the shipped manifest", () => {
    // Coordinator rule (coordinator.ts:355-357): target === stage, or the
    // target's index is <= the stage's index in manifest.stages.
    const manifest = shippedManifest("core/implement@4");
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    const index = (id: string) => manifest.stages.findIndex((entry) => entry.id === id);
    for (const entry of manifest.stages) {
      for (const [outcome, transition] of Object.entries(entry.transitions)) {
        if (!transition.to) continue;
        const reentry = transition.to === entry.id || index(transition.to) <= index(entry.id);
        const arrow = reentry ? "-.->" : "-->";
        const wrong = reentry ? "-->" : "-.->";
        const line = output.split("\n").find((candidate) =>
          candidate.includes(`${entry.id} ${arrow}`) && candidate.includes(`|"${outcome}`));
        expect(line, `${entry.id}.${outcome} should use ${arrow}`).toBeTruthy();
        expect(output).not.toContain(`    ${entry.id} ${wrong}|"${outcome}"| ${transition.to}`);
      }
    }
  });

  it("sends every terminal transition to a distinct thick-edged terminal node", () => {
    const manifest = fixture([
      stage("alpha", "agent", { transitions: transitions({ success: { to: "bravo" } }) }),
      stage("bravo", "agent"),
    ]);
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    expect(output).toContain('terminal_shipped(["shipped"])');
    expect(output).toContain('terminal_no_change(["no_change"])');
    expect(output).toContain('terminal_needs_human(["needs_human"])');
    expect(output).toContain('terminal_canceled(["canceled"])');
    expect(output).toContain('terminal_superseded(["superseded"])');
    expect(output).toContain('terminal_failed(["failed"])');
    expect(output).toContain('bravo ==>|"success"| terminal_shipped');
    expect(output).toContain('alpha ==>|"canceled"| terminal_canceled');
  });

  it("omits terminal nodes that no rendered edge reaches", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"));
    expect(output).toContain('terminal_shipped(["shipped"])');
    expect(output).not.toContain('terminal_canceled(["canceled"])');
  });
});

describe("renderManifestMermaid uniform-outcome collapse", () => {
  it("collapses exactly needs_human, canceled and superseded on core/implement@4", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"));
    expect(output).toContain("%% every stage also: needs_human (11), canceled (11), superseded (11)");
    for (const outcome of ["needs_human", "canceled", "superseded"]) {
      expect(output).not.toContain(`|"${outcome}"|`);
    }
    for (const outcome of ["success", "no_change", "semantic_repair_required", "retryable_infrastructure_failure", "failure"]) {
      expect(output).toContain(`|"${outcome}`);
    }
  });

  it("names the collapsed destination in the trailing comment", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"));
    expect(output).toContain("%%   needs_human -> terminal needs_human");
    expect(output).toContain("%%   canceled -> terminal canceled");
    expect(output).toContain("%%   superseded -> terminal superseded");
  });

  it("collapses only outcomes whose transition body is identical everywhere", () => {
    // canceled is uniform; needs_human differs by one stage, so it survives.
    const manifest = fixture([
      stage("alpha", "agent", {
        transitions: transitions({
          success: { to: "bravo" },
          needs_human: { to: "bravo", max_reentries: 2, on_exhausted: "needs_human" },
        }),
      }),
      stage("bravo", "agent"),
    ]);
    const output = renderManifestMermaid(manifest);
    expect(output).toContain("%% every stage also:");
    expect(output).toContain("canceled (2)");
    expect(output).not.toContain("needs_human (2)");
    expect(output).toContain('alpha -->|"needs_human (≤2 → needs_human)"| bravo');
    expect(output).toContain('bravo ==>|"needs_human"| terminal_needs_human');
  });

  it("collapses nothing when every outcome varies", () => {
    const manifest = fixture([
      stage("alpha", "agent", {
        transitions: transitions({
          success: { to: "bravo" },
          no_change: { to: "bravo" },
          semantic_repair_required: { to: "bravo" },
          retryable_infrastructure_failure: { to: "bravo" },
          needs_human: { to: "bravo" },
          canceled: { to: "bravo" },
          superseded: { to: "bravo" },
          failure: { to: "bravo" },
        }),
      }),
      stage("bravo", "agent"),
    ]);
    expect(renderManifestMermaid(manifest)).not.toContain("%% every stage also:");
  });

  it("collapseUniform:false emits every declared transition", () => {
    const manifest = shippedManifest("core/implement@4");
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    expect(output).not.toContain("%% every stage also:");
    const edges = output.split("\n").filter((line) => /\|"/.test(line));
    expect(edges).toHaveLength(manifest.stages.length * 8);
    for (const entry of manifest.stages) {
      expect(output).toContain(`${entry.id} ==>|"canceled"| terminal_canceled`);
    }
  });
});

describe("renderManifestMermaid position highlighting", () => {
  it("emits a classDef and class line for the active stage", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"), {
      position: { activeStageId: "simplification" },
    });
    expect(output).toContain("classDef otActive fill:#fff3bf,stroke:#f08c00,stroke-width:3px;");
    expect(output).toContain("class simplification otActive;");
  });

  it("appends re-entry usage for nonzero counts only", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"), {
      position: { activeStageId: "implementation", reentryCounts: { implementation: 4, publish: 0 } },
    });
    expect(output).toContain('implementation["implementation<br/>agent<br/>re-entries: 4"]');
    expect(output).toContain('publish["publish<br/>agent"]');
  });

  it("omits highlighting entirely when no position is supplied", () => {
    const output = renderManifestMermaid(shippedManifest("core/implement@4"));
    expect(output).not.toContain("classDef");
    expect(output).not.toContain("re-entries");
  });

  it("rejects an active stage that is not in the manifest", () => {
    expect(() => renderManifestMermaid(shippedManifest("core/implement@4"), {
      position: { activeStageId: "nope" },
    })).toThrow(/not a stage of core\/implement/);
  });
});

describe("renderManifestMermaid determinism", () => {
  it("is byte-identical across calls", () => {
    const manifest = shippedManifest("core/implement@4");
    expect(renderManifestMermaid(manifest)).toBe(renderManifestMermaid(manifest));
    expect(renderManifestMermaid(manifest, { collapseUniform: false }))
      .toBe(renderManifestMermaid(manifest, { collapseUniform: false }));
  });

  it("orders stages as declared and outcomes in STAGE_OUTCOMES order", () => {
    const manifest = shippedManifest("core/implement@4");
    const output = renderManifestMermaid(manifest, { collapseUniform: false });
    const lines = output.split("\n");
    const nodeOrder = manifest.stages.map((entry) =>
      lines.findIndex((line) => line.trimStart().startsWith(`${entry.id}[`) || line.trimStart().startsWith(`${entry.id}{{`)));
    expect(nodeOrder).toEqual([...nodeOrder].sort((left, right) => left - right));
    const implementationEdges = lines
      .filter((line) => line.trimStart().startsWith("implementation "))
      .map((line) => line.split('|"')[1]!.split(/["( ]/)[0]);
    expect(implementationEdges).toEqual([
      "success",
      "no_change",
      "semantic_repair_required",
      "retryable_infrastructure_failure",
      "needs_human",
      "canceled",
      "superseded",
      "failure",
    ]);
  });

  it("renders every manifest in the shipped catalog without throwing", () => {
    const catalog = loadPipelineCatalog(CATALOG);
    expect(catalog.manifests.size).toBeGreaterThan(0);
    for (const { manifest } of catalog.manifests.values()) {
      for (const collapseUniform of [true, false]) {
        const output = renderManifestMermaid(manifest, {
          collapseUniform,
          position: { activeStageId: manifest.entry_stage, reentryCounts: { [manifest.entry_stage]: 1 } },
        });
        expect(output.startsWith("flowchart TD\n")).toBe(true);
        expect(output).toContain(`%% ${manifest.id}@${manifest.version}`);
      }
    }
  });
});

describe("generated pipeline docs", () => {
  it("derives one page filename per manifest identity", () => {
    const catalog = loadPipelineCatalog(CATALOG);
    const names = [...catalog.manifests.values()].map(({ manifest }) => pipelineDocFilename(manifest));
    expect(names).toContain("core-implement-v4.md");
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches what is committed under docs/pipelines (run `npm run docs:pipelines`)", () => {
    const pages = pipelineDocPages(DEFAULT_CATALOG_PATH);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const path = join(DOCS_PIPELINES_DIR, page.filename);
      let onDisk: string;
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        throw new Error(`docs/pipelines/${page.filename} is missing; run npm run docs:pipelines --prefix supervisor`);
      }
      expect(onDisk, `docs/pipelines/${page.filename} is stale`).toBe(page.content);
    }
    const onDiskPages = readdirSync(DOCS_PIPELINES_DIR).filter((entry) => entry.endsWith(".md")).sort();
    expect(onDiskPages).toEqual(pages.map((page) => page.filename).sort());
  });
});
