/**
 * @deprecated Legacy graph authoring contract. New definitions use the public
 * pipeline contract in pipeline.ts. This module is retained only until the
 * clean offline epoch replacement removes the old runtime in U8.
 */
import {
  COMMAND_NAME_PATTERN,
  IDENTIFIER,
  SKILL_REFERENCE,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  optional,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";
import type { RepositoryConfigContract } from "./config.js";

const GRAPH_SCHEMA = "openthrottle.graph/v1" as const;
const SESSION_SCOPES = ["graph", "attempt", "fresh"] as const;
const INPUT_SCOPES = ["graph", "unit", "diff", "command", "review"] as const;
export const RECEIPT_TYPES = [
  "unit_completion",
  "unit_decision",
  "semantic_review",
  "command_result",
  "candidate_evidence",
  "integration_evidence",
  "publish_subject",
  "provider_evidence",
  "human_approval",
] as const;
const WORKER_ENGINES = ["agent", "command", "provider", "human"] as const;
const NODE_KINDS = ["run", "for_each_unit", "command", "publish", "wait_for_provider", "human"] as const;
const LOOP_BACKED_NODE_KINDS = new Set<NodeKind>(["run"]);
export const UNIT_PHASE_IDS = ["implement", "simplify", "command", "candidate", "lead", "integrate"] as const;
const UNIT_PHASE_KINDS = ["agent", "command", "evidence", "integrate", "gate"] as const;
const GRAPH_OUTCOMES = [
  "success",
  "no_change",
  "repair_required",
  "needs_human",
  "retryable_failure",
  "failure",
] as const;
export const LOGICAL_CREDENTIALS = ["model.invoke", "provider.read", "repo.read", "repo.write", "mcp"] as const;
const AGENT_INHERITANCE = ["inherit", "claude", "codex", "opencode"] as const;
const MODEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type SessionScope = (typeof SESSION_SCOPES)[number];
export type InputScope = (typeof INPUT_SCOPES)[number];
export type ReceiptType = (typeof RECEIPT_TYPES)[number];
export type WorkerEngine = (typeof WORKER_ENGINES)[number];
type AgentInheritance = (typeof AGENT_INHERITANCE)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type GraphUnitPhaseId = (typeof UNIT_PHASE_IDS)[number];
type GraphUnitPhaseKind = (typeof UNIT_PHASE_KINDS)[number];
export type GraphOutcome = (typeof GRAPH_OUTCOMES)[number];
export type LogicalCredential = (typeof LOGICAL_CREDENTIALS)[number];

export interface GraphWorker {
  id: string;
  engine: WorkerEngine;
  agent?: AgentInheritance;
  model?: string;
  skills: string[];
  allowed_mcp_servers: string[];
  session_scope: SessionScope;
  credentials: LogicalCredential[];
}

interface GraphLoop {
  id: string;
  worker: string;
  skill: string;
  input_scope: InputScope;
  receipt: ReceiptType;
  max_parallel: number;
  max_rounds: number;
  timeout_seconds: number;
}

export interface GraphTransition {
  to?: string;
  terminal?: "completed" | "needs_human" | "failed";
  max_reentries?: number;
  on_exhausted?: "needs_human" | "failed";
}

export interface GraphUnitPhase {
  id: GraphUnitPhaseId;
  kind: GraphUnitPhaseKind;
  loop?: string;
  commands?: string[];
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  loop?: string;
  command?: string;
  phases?: GraphUnitPhase[];
  depends_on: string[];
  transitions: Partial<Record<GraphOutcome, GraphTransition>>;
}

/** @deprecated Use PipelineDefinition and CompiledPipelineManifest. */
export interface GraphContract {
  schema: typeof GRAPH_SCHEMA;
  id: string;
  version: number;
  entry_node: string;
  workers: GraphWorker[];
  loops: GraphLoop[];
  nodes: GraphNode[];
}

function parseWorker(value: unknown, path: string): GraphWorker {
  const input = objectAt(value, path, [
    "id", "engine", "agent", "model", "skills", "allowed_mcp_servers", "session_scope", "credentials",
  ]);
  const worker: GraphWorker = {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    engine: enumAt(input.engine, `${path}.engine`, WORKER_ENGINES),
    ...(input.agent === undefined ? {} : { agent: enumAt(input.agent, `${path}.agent`, AGENT_INHERITANCE) }),
    ...(input.model === undefined ? {} : { model: stringAt(input.model, `${path}.model`, { max: 240, pattern: MODEL_REFERENCE }) }),
    skills: unique(arrayAt(input.skills, `${path}.skills`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { max: 240, pattern: SKILL_REFERENCE });
    }, { min: 1, max: 16 }), `${path}.skills`),
    allowed_mcp_servers: input.allowed_mcp_servers === undefined ? [] : unique(arrayAt(
      input.allowed_mcp_servers,
      `${path}.allowed_mcp_servers`,
      (entry, entryPath) => stringAt(entry, entryPath, { pattern: IDENTIFIER }),
      { max: 16 }
    ), `${path}.allowed_mcp_servers`),
    session_scope: enumAt(input.session_scope, `${path}.session_scope`, SESSION_SCOPES),
    credentials: unique(arrayAt(input.credentials, `${path}.credentials`, (entry, entryPath) => {
      return enumAt(entry, entryPath, LOGICAL_CREDENTIALS);
    }, { max: 8 }), `${path}.credentials`),
  };
  if (worker.engine !== "agent" && (worker.agent !== undefined || worker.model !== undefined)) {
    fail(path, "agent and model inheritance are allowed only for agent workers");
  }
  return worker;
}

function parseLoop(value: unknown, path: string): GraphLoop {
  const input = objectAt(value, path, [
    "id", "worker", "skill", "input_scope", "receipt", "max_parallel", "max_rounds", "timeout_seconds",
  ]);
  return {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    worker: stringAt(input.worker, `${path}.worker`, { pattern: IDENTIFIER }),
    skill: stringAt(input.skill, `${path}.skill`, { max: 240, pattern: SKILL_REFERENCE }),
    input_scope: enumAt(input.input_scope, `${path}.input_scope`, INPUT_SCOPES),
    receipt: enumAt(input.receipt, `${path}.receipt`, RECEIPT_TYPES),
    max_parallel: integerAt(input.max_parallel, `${path}.max_parallel`, 1, 1),
    max_rounds: integerAt(input.max_rounds, `${path}.max_rounds`, 1, 20),
    timeout_seconds: integerAt(input.timeout_seconds, `${path}.timeout_seconds`, 1, 86_400),
  };
}

function parseTransition(value: unknown, path: string): GraphTransition {
  const input = objectAt(value, path, ["to", "terminal", "max_reentries", "on_exhausted"]);
  const to = optional(input.to, (entry) => stringAt(entry, `${path}.to`, { pattern: IDENTIFIER }));
  const terminal = optional(input.terminal, (entry) => enumAt(entry, `${path}.terminal`, ["completed", "needs_human", "failed"] as const));
  if (Boolean(to) === Boolean(terminal)) fail(path, "must set exactly one of to or terminal");
  const maxReentries = optional(input.max_reentries, (entry) => integerAt(entry, `${path}.max_reentries`, 1, 20));
  const onExhausted = optional(input.on_exhausted, (entry) => enumAt(entry, `${path}.on_exhausted`, ["needs_human", "failed"] as const));
  if (Boolean(maxReentries) !== Boolean(onExhausted)) fail(path, "max_reentries and on_exhausted must be declared together");
  if (terminal && maxReentries) fail(path, "terminal transitions cannot re-enter");
  return {
    ...(to ? { to } : {}),
    ...(terminal ? { terminal } : {}),
    ...(maxReentries ? { max_reentries: maxReentries, on_exhausted: onExhausted } : {}),
  };
}

function parseTransitionMap(value: unknown, path: string): Partial<Record<GraphOutcome, GraphTransition>> {
  const input = objectAt(value, path, GRAPH_OUTCOMES);
  const transitions: Partial<Record<GraphOutcome, GraphTransition>> = {};
  for (const [outcome, transition] of Object.entries(input)) {
    transitions[outcome as GraphOutcome] = parseTransition(transition, `${path}.${outcome}`);
  }
  return transitions;
}

function parseUnitPhase(value: unknown, path: string): GraphUnitPhase {
  const input = objectAt(value, path, ["id", "kind", "loop", "commands"]);
  const kind = enumAt(input.kind, `${path}.kind`, UNIT_PHASE_KINDS);
  const phase: GraphUnitPhase = {
    id: enumAt(input.id, `${path}.id`, UNIT_PHASE_IDS),
    kind,
    ...(input.loop === undefined ? {} : { loop: stringAt(input.loop, `${path}.loop`, { pattern: IDENTIFIER }) }),
    ...(input.commands === undefined ? {} : {
      commands: unique(arrayAt(input.commands, `${path}.commands`, (entry, entryPath) => {
        return stringAt(entry, entryPath, { max: 80, pattern: COMMAND_NAME_PATTERN });
      }, { min: 1, max: 16 }), `${path}.commands`),
    }),
  };
  if ((kind === "agent" || kind === "gate") && !phase.loop) {
    fail(`${path}.loop`, "is required for agent and gate phases");
  }
  if (kind !== "agent" && kind !== "gate" && phase.loop) {
    fail(`${path}.loop`, "is allowed only for agent and gate phases");
  }
  if (kind === "command" && !phase.commands) {
    fail(`${path}.commands`, "is required for command phases");
  }
  if (kind !== "command" && phase.commands) {
    fail(`${path}.commands`, "is allowed only for command phases");
  }
  const expectedKindById: Record<GraphUnitPhaseId, GraphUnitPhaseKind> = {
    implement: "agent",
    simplify: "agent",
    command: "command",
    candidate: "evidence",
    lead: "gate",
    integrate: "integrate",
  };
  if (kind !== expectedKindById[phase.id]) {
    fail(`${path}.kind`, `must be ${expectedKindById[phase.id]} for ${phase.id}`);
  }
  return phase;
}

function parseNode(value: unknown, path: string): GraphNode {
  const input = objectAt(value, path, ["id", "kind", "loop", "command", "phases", "depends_on", "transitions"]);
  const kind = enumAt(input.kind, `${path}.kind`, NODE_KINDS);
  const node: GraphNode = {
    id: stringAt(input.id, `${path}.id`, { pattern: IDENTIFIER }),
    kind,
    ...(input.loop === undefined ? {} : { loop: stringAt(input.loop, `${path}.loop`, { pattern: IDENTIFIER }) }),
    ...(input.command === undefined ? {} : { command: stringAt(input.command, `${path}.command`, { max: 80, pattern: COMMAND_NAME_PATTERN }) }),
    ...(input.phases === undefined ? {} : {
      phases: arrayAt(input.phases, `${path}.phases`, parseUnitPhase, { min: 1, max: 16 }),
    }),
    depends_on: unique(arrayAt(input.depends_on, `${path}.depends_on`, (entry, entryPath) => {
      return stringAt(entry, entryPath, { pattern: IDENTIFIER });
    }, { max: 16 }), `${path}.depends_on`),
    transitions: parseTransitionMap(input.transitions, `${path}.transitions`),
  };
  if (LOOP_BACKED_NODE_KINDS.has(kind) && !node.loop) fail(`${path}.loop`, "is required for this node kind");
  if (kind === "command" && !node.command) fail(`${path}.command`, "is required for command nodes");
  if (kind !== "command" && node.command) fail(`${path}.command`, "is only allowed for command nodes");
  if (!LOOP_BACKED_NODE_KINDS.has(kind) && node.loop) fail(`${path}.loop`, "is allowed only for loop-backed nodes");
  if (kind === "for_each_unit" && !node.phases) fail(`${path}.phases`, "is required for for_each_unit nodes");
  if (kind !== "for_each_unit" && node.phases) fail(`${path}.phases`, "is allowed only for for_each_unit nodes");
  return node;
}

function validateGraph(graph: GraphContract, source: string, config?: RepositoryConfigContract): void {
  const workers = new Map(graph.workers.map((worker) => [worker.id, worker]));
  const loops = new Map(graph.loops.map((loop) => [loop.id, loop]));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const configuredSkills = new Set((config?.skills ?? []).map((skill) => skill.id));
  const configuredCommands = config ? new Set(Object.keys(config.commands ?? {})) : undefined;
  if (workers.size !== graph.workers.length) fail(`${source}.workers`, "must not contain duplicate IDs");
  if (loops.size !== graph.loops.length) fail(`${source}.loops`, "must not contain duplicate IDs");
  if (nodes.size !== graph.nodes.length) fail(`${source}.nodes`, "must not contain duplicate IDs");
  if (!nodes.has(graph.entry_node)) fail(`${source}.entry_node`, "references an unknown node");
  for (const worker of graph.workers) {
    for (const skill of worker.skills) {
      if (skill.startsWith("repo://") && config && !configuredSkills.has(skill.slice("repo://".length))) {
        fail(`${source}.workers.${worker.id}.skills`, "references an undeclared repository skill");
      }
    }
  }
  for (const loop of graph.loops) {
    const worker = workers.get(loop.worker);
    if (!worker) fail(`${source}.loops.${loop.id}.worker`, "references an unknown worker");
    if (!worker.skills.includes(loop.skill)) {
      fail(`${source}.loops.${loop.id}.skill`, "is not allowed by the worker");
    }
    if (loop.skill.startsWith("repo://") && config && !configuredSkills.has(loop.skill.slice("repo://".length))) {
      fail(`${source}.loops.${loop.id}.skill`, "references an undeclared repository skill");
    }
  }
  for (const node of graph.nodes) {
    if (node.loop && !loops.has(node.loop)) fail(`${source}.nodes.${node.id}.loop`, "references an unknown loop");
    if (node.command && configuredCommands) {
      if (!configuredCommands.has(node.command)) {
        fail(`${source}.nodes.${node.id}.command`, "references an unknown repository command");
      }
    }
    if (node.phases) {
      const phaseIds = new Set<string>();
      let integrateIndex = -1;
      let leadIndex = -1;
      let candidateIndex = -1;
      let implementIndex = -1;
      let simplifyIndex = -1;
      for (const [index, phase] of node.phases.entries()) {
        if (phaseIds.has(phase.id)) fail(`${source}.nodes.${node.id}.phases`, "must not contain duplicate phase IDs");
        phaseIds.add(phase.id);
        if (phase.id === "implement") implementIndex = index;
        if (phase.id === "simplify") simplifyIndex = index;
        if (phase.id === "integrate") integrateIndex = index;
        if (phase.id === "lead") leadIndex = index;
        if (phase.id === "candidate") candidateIndex = index;
        if ((phase.kind === "agent" || phase.kind === "gate") && phase.loop && !loops.has(phase.loop)) {
          fail(`${source}.nodes.${node.id}.phases[${index}].loop`, "references an unknown loop");
        }
        if (phase.kind === "gate" && phase.loop) {
          const loop = loops.get(phase.loop);
          const worker = loop ? workers.get(loop.worker) : undefined;
          if (worker?.credentials.includes("repo.write")) {
            fail(`${source}.nodes.${node.id}.phases[${index}].worker.credentials`, "gate phases cannot request repo.write");
          }
        }
        if ((phase.kind === "agent" || phase.kind === "gate") && phase.loop) {
          const loop = loops.get(phase.loop);
          const worker = loop ? workers.get(loop.worker) : undefined;
          if (worker?.credentials.includes("repo.write")) {
            fail(`${source}.nodes.${node.id}.phases[${index}].worker.credentials`, "structured child phases cannot request repo.write");
          }
        }
        if (phase.kind === "command" && phase.commands && configuredCommands) {
          for (const command of phase.commands) {
            if (!configuredCommands.has(command)) {
              fail(`${source}.nodes.${node.id}.phases[${index}].commands`, "references an unknown repository command");
            }
          }
        }
      }
      for (const required of ["implement", "candidate", "lead"] as const) {
        if (!phaseIds.has(required)) fail(`${source}.nodes.${node.id}.phases`, `must include the ${required} phase`);
      }
      if (integrateIndex === -1) fail(`${source}.nodes.${node.id}.phases`, "must include exactly one integrate phase");
      if (integrateIndex !== node.phases.length - 1) {
        fail(`${source}.nodes.${node.id}.phases[${integrateIndex}]`, "integrate must be the last unit phase");
      }
      if (simplifyIndex !== -1 && simplifyIndex < implementIndex) {
        fail(`${source}.nodes.${node.id}.phases[${simplifyIndex}]`, "simplify must not precede implement");
      }
      if (leadIndex !== integrateIndex - 1) fail(`${source}.nodes.${node.id}.phases`, "lead must immediately precede integrate");
      if (candidateIndex !== leadIndex - 1) fail(`${source}.nodes.${node.id}.phases`, "candidate must immediately precede lead");
    }
    for (const dependency of node.depends_on) {
      if (!nodes.has(dependency)) fail(`${source}.nodes.${node.id}.depends_on`, "references an unknown node");
    }
    for (const [outcome, transition] of Object.entries(node.transitions)) {
      if (transition.to && !nodes.has(transition.to)) fail(`${source}.nodes.${node.id}.transitions.${outcome}.to`, "references an unknown node");
    }
  }
  const reachable = new Set<string>();
  const markReachable = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const node = nodes.get(id);
    if (!node) fail(`${source}.nodes.${id}`, "references an unknown node");
    for (const dependency of node.depends_on) markReachable(dependency);
    for (const transition of Object.values(node.transitions)) {
      if (transition.to) markReachable(transition.to);
    }
  };
  markReachable(graph.entry_node);
  const unreachable = graph.nodes.find((node) => !reachable.has(node.id));
  if (unreachable) fail(`${source}.nodes.${unreachable.id}`, "is unreachable from entry_node");

  const dependencyVisiting = new Set<string>();
  const dependencyVisited = new Set<string>();
  const visitDependency = (id: string): void => {
    if (dependencyVisited.has(id)) return;
    if (dependencyVisiting.has(id)) fail(`${source}.nodes.${id}.depends_on`, "creates a cycle");
    dependencyVisiting.add(id);
    const node = nodes.get(id);
    if (!node) fail(`${source}.nodes.${id}`, "references an unknown node");
    for (const dependency of node.depends_on) visitDependency(dependency);
    dependencyVisiting.delete(id);
    dependencyVisited.add(id);
  };
  for (const node of graph.nodes) visitDependency(node.id);

  const visiting = new Set<string>();
  const stack: Array<{ id: string; bounded: boolean }> = [];
  const visited = new Set<string>();
  const visit = (id: string, bounded = false): void => {
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push({ id, bounded });
    const node = nodes.get(id);
    if (!node) fail(`${source}.nodes.${id}`, "references an unknown node");
    for (const [outcome, transition] of Object.entries(node.transitions)) {
      if (!transition.to) continue;
      if (visiting.has(transition.to)) {
        const targetIndex = stack.findIndex((entry) => entry.id === transition.to);
        let earlierBound = false;
        for (let index = targetIndex + 1; index < stack.length; index += 1) {
          if (stack[index]!.bounded) {
            earlierBound = true;
            break;
          }
        }
        if (!transition.max_reentries && !earlierBound) {
          fail(`${source}.nodes.${id}.transitions.${outcome}`, "creates an unbounded cycle");
        }
      }
      if (!visiting.has(transition.to)) visit(transition.to, transition.max_reentries !== undefined);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.nodes) visit(node.id);

  if (config) {
    const mcpServers = new Set(Object.keys(config.mcp_servers ?? {}));
    for (const worker of graph.workers) {
      if (worker.allowed_mcp_servers.length > 0 && !worker.credentials.includes("mcp")) {
        fail(`${source}.workers.${worker.id}.allowed_mcp_servers`, "requires the mcp credential scope");
      }
      for (const server of worker.allowed_mcp_servers) {
        if (!mcpServers.has(server)) {
          fail(`${source}.workers.${worker.id}.allowed_mcp_servers`, "references an unknown MCP server");
        }
      }
    }
  }
}

/** @deprecated Use validatePipelineDefinition or validateCompiledPipelineManifest. */
export function validateGraphContract(
  value: unknown,
  options: { source?: string; config?: RepositoryConfigContract } = {}
): ValidatedContract<GraphContract> {
  const source = options.source ?? "graph";
  const input = objectAt(value, source, ["schema", "id", "version", "entry_node", "workers", "loops", "nodes"]);
  if (input.schema !== GRAPH_SCHEMA) fail(`${source}.schema`, `must be ${GRAPH_SCHEMA}`);
  const graph: GraphContract = {
    schema: GRAPH_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { max: 120, pattern: IDENTIFIER }),
    version: integerAt(input.version, `${source}.version`, 1, 1_000_000),
    entry_node: stringAt(input.entry_node, `${source}.entry_node`, { pattern: IDENTIFIER }),
    workers: arrayAt(input.workers, `${source}.workers`, parseWorker, { min: 1, max: 32 }),
    loops: arrayAt(input.loops, `${source}.loops`, parseLoop, { min: 1, max: 32 }),
    nodes: arrayAt(input.nodes, `${source}.nodes`, parseNode, { min: 1, max: 64 }),
  };
  validateGraph(graph, source, options.config);
  return normalizedContract(graph);
}

/** @deprecated Graph authoring is removed in the fresh execution epoch. */
export function parseGraphContract(
  raw: string,
  options: { source?: string; config?: RepositoryConfigContract } = {}
): ValidatedContract<GraphContract> {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) fail(options.source ?? "graph", "JSON exceeds 256 KiB");
  return validateGraphContract(JSON.parse(raw) as unknown, options);
}
