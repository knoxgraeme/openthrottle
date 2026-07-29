import {
  canonicalJson,
  isPipelineReentry,
  PIPELINE_OUTCOMES,
  STAGE_OUTCOMES,
  type ExecutorKind,
  type PipelineManifest,
  type PipelineOutcome,
  type PipelineTransition,
  type StageOutcome,
} from "./manifest.js";

export interface RenderOptions {
  /** Suppress outcomes whose transition is byte-identical across ALL stages,
      summarizing them in a trailing mermaid comment. Default true. */
  collapseUniform?: boolean;
  /** Highlight current position. */
  position?: { activeStageId: string; reentryCounts?: Record<string, number> };
}

const INDENT = "    ";
const ACTIVE_CLASS = "otActive";
const MERMAID_RESERVED = new Set([
  "end", "graph", "flowchart", "subgraph", "class", "classDef", "click",
  "style", "linkStyle", "direction", "default", "o", "x",
]);

/**
 * Mermaid treats `"` and `#` as markup inside a quoted label, so both are
 * emitted as entities. Stage IDs are validated identifiers and outcome names
 * come from closed unions, so this never fires today — it exists so a future
 * schema relaxation cannot produce a broken diagram.
 */
function escapeLabel(text: string): string {
  return text.replace(/#/g, "#35;").replace(/"/g, "#quot;");
}

function joinLabel(lines: readonly string[]): string {
  return lines.map(escapeLabel).join("<br/>");
}

interface ExecutorShape {
  /** Human-readable executor kind shown on the second label line. */
  readonly display: string;
  readonly node: (nodeId: string, label: string) => string;
}

/**
 * Exhaustive over `ExecutorKind`. The `never` binding makes a newly added
 * executor kind a compile error here rather than a silently mis-shaped node.
 */
function executorShape(kind: ExecutorKind): ExecutorShape {
  switch (kind) {
    case "agent":
      return { display: "agent", node: (id, label) => `${id}["${label}"]` };
    case "command":
      return { display: "command gate", node: (id, label) => `${id}[/"${label}"/]` };
    case "loop_action":
      return { display: "loop action", node: (id, label) => `${id}[("${label}")]` };
    case "provider_wait":
      return { display: "provider wait", node: (id, label) => `${id}{{"${label}"}}` };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled executor kind: ${String(unhandled)}`);
    }
  }
}

/**
 * Stage IDs may legally contain `.`, `/` and `-`, none of which are safe in a
 * mermaid node ID, so node IDs are sanitized and de-duplicated while the label
 * keeps the verbatim stage ID.
 */
function allocateNodeIds(manifest: PipelineManifest): {
  stage: ReadonlyMap<string, string>;
  terminal: ReadonlyMap<PipelineOutcome, string>;
} {
  const used = new Set<string>();
  const take = (base: string): string => {
    const cleaned = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "n") || "n";
    // `end`, `graph`, `o`, `x` and friends are mermaid keywords that break a
    // flowchart when used bare as a node ID; a stage may legally be named any
    // of them.
    const sanitized = MERMAID_RESERVED.has(cleaned) ? `${cleaned}_node` : cleaned;
    let candidate = sanitized;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${sanitized}_${suffix}`;
    used.add(candidate);
    return candidate;
  };
  const stage = new Map<string, string>();
  for (const entry of manifest.stages) stage.set(entry.id, take(entry.id));
  const terminal = new Map<PipelineOutcome, string>();
  for (const outcome of PIPELINE_OUTCOMES) terminal.set(outcome, take(`terminal_${outcome}`));
  return { stage, terminal };
}

/**
 * An outcome collapses only when every stage declares it and every declaration
 * is byte-identical under the manifest's own canonical JSON. Nothing here is
 * keyed on outcome names, so a manifest that varies `canceled` per stage keeps
 * its `canceled` edges.
 */
function uniformOutcomes(manifest: PipelineManifest): ReadonlyMap<StageOutcome, number> {
  const collapsed = new Map<StageOutcome, number>();
  for (const outcome of STAGE_OUTCOMES) {
    const bodies = manifest.stages.map((stage) => stage.transitions[outcome]);
    if (bodies.length === 0 || bodies.some((body) => body === undefined)) continue;
    const reference = canonicalJson(bodies[0]);
    if (bodies.every((body) => canonicalJson(body) === reference)) collapsed.set(outcome, bodies.length);
  }
  return collapsed;
}

function transitionSummary(transition: PipelineTransition): string {
  if (transition.terminal) return `-> terminal ${transition.terminal}`;
  const bound = transition.max_reentries === undefined
    ? ""
    : ` (max ${transition.max_reentries}, then ${transition.on_exhausted})`;
  return `-> ${transition.to}${bound}`;
}

function edgeLabel(outcome: StageOutcome, transition: PipelineTransition): string {
  const bound = transition.max_reentries === undefined
    ? ""
    : ` (≤${transition.max_reentries} → ${transition.on_exhausted})`;
  return escapeLabel(`${outcome}${bound}`);
}

export function renderManifestMermaid(manifest: PipelineManifest, options: RenderOptions = {}): string {
  const collapseUniform = options.collapseUniform ?? true;
  const position = options.position;
  if (position && !manifest.stages.some((stage) => stage.id === position.activeStageId)) {
    throw new Error(`position.activeStageId ${position.activeStageId} is not a stage of ${manifest.id}`);
  }

  const ids = allocateNodeIds(manifest);
  const collapsed = collapseUniform ? uniformOutcomes(manifest) : new Map<StageOutcome, number>();
  const reentryCounts = position?.reentryCounts ?? {};

  const nodeLines: string[] = [];
  for (const stage of manifest.stages) {
    const shape = executorShape(stage.executor.kind);
    const count = reentryCounts[stage.id] ?? 0;
    const label = joinLabel([
      stage.id,
      shape.display,
      ...(position && count > 0 ? [`re-entries: ${count}`] : []),
    ]);
    nodeLines.push(`${INDENT}${shape.node(ids.stage.get(stage.id)!, label)}`);
  }

  // Edges are emitted stage-by-stage in declared order, and within a stage in
  // STAGE_OUTCOMES order, so the rendered text is stable for docs snapshots.
  const edgeLines: string[] = [];
  const usedTerminals = new Set<PipelineOutcome>();
  for (const stage of manifest.stages) {
    const from = ids.stage.get(stage.id)!;
    for (const outcome of STAGE_OUTCOMES) {
      if (collapsed.has(outcome)) continue;
      const transition = stage.transitions[outcome];
      if (!transition) continue;
      const label = edgeLabel(outcome, transition);
      if (transition.terminal) {
        usedTerminals.add(transition.terminal);
        edgeLines.push(`${INDENT}${from} ==>|"${label}"| ${ids.terminal.get(transition.terminal)!}`);
        continue;
      }
      const target = manifest.stages.find((candidate) => candidate.id === transition.to);
      if (!target) throw new Error(`stage ${stage.id} transitions to unknown stage ${String(transition.to)}`);
      const arrow = isPipelineReentry(manifest, stage.id, target.id) ? "-.->" : "-->";
      edgeLines.push(`${INDENT}${from} ${arrow}|"${label}"| ${ids.stage.get(target.id)!}`);
    }
  }

  const terminalLines: string[] = [];
  for (const outcome of PIPELINE_OUTCOMES) {
    if (!usedTerminals.has(outcome)) continue;
    terminalLines.push(`${INDENT}${ids.terminal.get(outcome)!}(["${escapeLabel(outcome)}"])`);
  }

  const lines: string[] = [
    "flowchart TD",
    `${INDENT}%% ${escapeLabel(`${manifest.id}@${manifest.version}`)}`,
    ...nodeLines,
    ...terminalLines,
    ...edgeLines,
  ];

  if (position) {
    lines.push(`${INDENT}classDef ${ACTIVE_CLASS} fill:#fff3bf,stroke:#f08c00,stroke-width:3px;`);
    lines.push(`${INDENT}class ${ids.stage.get(position.activeStageId)!} ${ACTIVE_CLASS};`);
  }

  if (collapsed.size > 0) {
    const summary = [...collapsed.entries()].map(([outcome, count]) => `${outcome} (${count})`).join(", ");
    lines.push(`${INDENT}%% every stage also: ${summary}`);
    for (const outcome of collapsed.keys()) {
      lines.push(`${INDENT}%%   ${outcome} ${transitionSummary(manifest.stages[0]!.transitions[outcome]!)}`);
    }
  }

  return lines.join("\n");
}

/** `ce/implement` v3 -> `ce-implement-v3.md`. */
export function pipelineDocFilename(manifest: PipelineManifest): string {
  const slug = manifest.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}-v${manifest.version}.md`;
}

/** The full generated markdown page. Pure — the writer lives in scripts/. */
export function renderPipelineDocPage(manifest: PipelineManifest): string {
  const identity = `${manifest.id}@${manifest.version}`;
  return [
    `# Pipeline ${identity}`,
    "",
    "<!-- Generated by `npm run docs:pipelines --prefix supervisor` from supervisor/pipelines/.",
    "     Do not edit by hand; edit the manifest and regenerate. CI fails the",
    "     \"Verify pipeline docs are regenerated\" step when this page drifts. -->",
    "",
    `- **Pipeline:** \`${identity}\``,
    `- **Entry stage:** \`${manifest.entry_stage}\``,
    `- **Max attempts:** ${manifest.max_attempts}`,
    ...(manifest.max_repair_rounds === undefined ? [] : [`- **Max repair rounds:** ${manifest.max_repair_rounds}`]),
    "",
    manifest.description,
    "",
    "## Flow",
    "",
    "```mermaid",
    renderManifestMermaid(manifest),
    "```",
    "",
    "### Legend",
    "",
    "- Rectangle = agent stage, parallelogram = command gate, hexagon = provider wait.",
    "- Solid arrow = forward transition; dashed arrow = re-entry (the target is the",
    "  stage itself or sits at/before it in the declared stage order, matching the",
    "  shared `isPipelineReentry` manifest helper); thick arrow = terminal outcome.",
    "- `(≤N → outcome)` on an edge is `max_reentries` and its `on_exhausted` terminal.",
    "- Outcomes identical across every stage are suppressed and listed in the",
    "  trailing `%%` comment inside the diagram.",
    "",
  ].join("\n");
}
