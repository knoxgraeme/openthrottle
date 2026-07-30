import {
  parseGraphContract,
  validateGraphContract,
  type GraphContract,
  type GraphLoop,
  type GraphNode,
  type GraphTransition,
  type GraphWorker,
  type RepositoryConfigContract,
} from "@openthrottle/contracts";
import {
  COMMAND_NAMES,
  validatePipelineManifest,
  type ArtifactKind,
  type AssuranceClass,
  type CommandName,
  type ContextPolicy,
  type EvaluatorKind,
  type ExecutorKind,
  type PipelineManifest,
  type PipelineStage,
  type PipelineTransition,
  type RepositorySkillPackage,
  type RuntimeCapabilityInventory,
  type StageOutcome,
  type ValidatedPipelineManifest,
} from "./manifest.js";

export interface CompileExecutionGraphOptions {
  id?: string;
  version?: number;
  description?: string;
  maxAttempts?: number;
  maxRepairRounds?: number;
  runtime?: RuntimeCapabilityInventory;
  config?: RepositoryConfigContract;
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>;
}

export interface CompiledExecutionGraph {
  graph: GraphContract;
  graphDigest: string;
  manifest: ValidatedPipelineManifest;
}

export const FOR_EACH_UNIT_CAPABILITY = "graph/for-each-unit@1";
export const REPOSITORY_SKILL_CAPABILITY = "agent/repository-skill@1";

interface ResolvedUnitLoop {
  loop: GraphLoop;
  worker: GraphWorker;
}

type StageTemplate = {
  executor: { kind: ExecutorKind; capability: string };
  repositorySkill?: RepositorySkillPackage;
  evaluator: { kind: EvaluatorKind; assurance: AssuranceClass; required_artifacts: ArtifactKind[] };
  context: ContextPolicy;
  live_steering: boolean;
  credentials: string[];
  produces: ArtifactKind[];
  commandName?: CommandName;
};

type PublicGraphOutcome = "success" | "no_change" | "repair_required" | "needs_human" | "retryable_failure" | "failure";

const GRAPH_TO_STAGE_OUTCOME: Record<PublicGraphOutcome, StageOutcome> = {
  success: "success",
  no_change: "no_change",
  repair_required: "semantic_repair_required",
  needs_human: "needs_human",
  retryable_failure: "retryable_infrastructure_failure",
  failure: "failure",
};

const DEFAULT_TERMINALS: Pick<Record<StageOutcome, PipelineTransition>, "needs_human" | "canceled" | "superseded"> = {
  needs_human: { terminal: "needs_human" },
  canceled: { terminal: "canceled" },
  superseded: { terminal: "superseded" },
};

const CAPABILITY_CREDENTIALS: Record<string, {
  minimum: readonly string[];
  allowed: readonly string[];
  contexts: readonly ContextPolicy[];
  artifacts: readonly ArtifactKind[];
}> = {
  "ce/implement@1": {
    minimum: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/investigate@1": {
    minimum: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/review@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
  "ce/simplify@1": {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "repo.read", "repo.write"],
    contexts: ["resume_required", "prefer_resume"],
    artifacts: ["stage_result"],
  },
  [FOR_EACH_UNIT_CAPABILITY]: {
    minimum: ["repo.read", "repo.write"],
    allowed: ["repo.read", "repo.write", "provider.read"],
    contexts: ["none"],
    artifacts: ["stage_result", "execution_graph_result"],
  },
  [REPOSITORY_SKILL_CAPABILITY]: {
    minimum: ["model.invoke", "repo.read"],
    allowed: ["model.invoke", "provider.read", "repo.read", "repo.write", "mcp"],
    contexts: ["fresh", "resume_required", "prefer_resume"],
    artifacts: ["stage_result", "review"],
  },
};

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function repoSkillId(skill: string): string | undefined {
  return skill.startsWith("repo://") ? skill.slice("repo://".length) : undefined;
}

function capabilityFromSkill(
  skill: string,
  path: string,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): { capability: string; repositorySkill?: RepositorySkillPackage } {
  if (skill.startsWith("builtin://")) {
    return { capability: skill.slice("builtin://".length) };
  }
  const id = repoSkillId(skill);
  if (!id) fail(path, "must be a builtin or repository skill reference");
  const repositorySkill = repositorySkills?.get(id);
  if (!repositorySkill) {
    fail(path, `repository skill ${id} was not pinned by admission`);
  }
  return { capability: REPOSITORY_SKILL_CAPABILITY, repositorySkill };
}

function commandNameFromGraph(command: string, path: string): CommandName {
  if (!COMMAND_NAMES.includes(command as CommandName)) {
    fail(path, `must be one of: ${COMMAND_NAMES.join(", ")}`);
  }
  return command as CommandName;
}

function contextFromSessionScope(worker: GraphWorker): ContextPolicy {
  if (worker.session_scope === "fresh") return "fresh";
  if (worker.session_scope === "graph") return "prefer_resume";
  return "resume_required";
}

function terminalOutcome(terminal: NonNullable<GraphTransition["terminal"]>): PipelineTransition {
  if (terminal === "completed") return { terminal: "shipped" };
  return { terminal };
}

function compileTransition(transition: GraphTransition): PipelineTransition {
  const target = transition.to === undefined ? terminalOutcome(transition.terminal!) : { to: transition.to };
  return {
    ...target,
    ...(transition.max_reentries === undefined
      ? {}
      : {
          max_reentries: transition.max_reentries,
          on_exhausted: transition.on_exhausted === "failed" ? "failed" : "needs_human",
        }),
  };
}

function assertNoDependencies(node: GraphNode): void {
  if (node.depends_on.length > 0) {
    fail(`graph.nodes.${node.id}.depends_on`, "cannot compile to PipelineManifest transitions yet");
  }
}

function assertCapabilityAuthorized(template: StageTemplate, path: string): void {
  const contract = CAPABILITY_CREDENTIALS[template.executor.capability];
  if (!contract) return;
  if (!contract.contexts.includes(template.context)) {
    fail(path, `${template.executor.capability} does not support context policy ${template.context}`);
  }
  for (const credential of contract.minimum) {
    if (!template.credentials.includes(credential)) {
      fail(path, `${template.executor.capability} requires credential scope ${credential}`);
    }
  }
  for (const credential of template.credentials) {
    if (!contract.allowed.includes(credential)) {
      fail(path, `${template.executor.capability} is not authorized for credential scope ${credential}`);
    }
  }
  for (const artifact of template.evaluator.required_artifacts) {
    if (!contract.artifacts.includes(artifact)) {
      fail(path, `${template.executor.capability} cannot produce required artifact ${artifact}`);
    }
  }
}

function compileTransitions(node: GraphNode): Record<StageOutcome, PipelineTransition> {
  const transitions: Partial<Record<StageOutcome, PipelineTransition>> = {
    ...DEFAULT_TERMINALS,
    no_change: { terminal: "no_change" },
    semantic_repair_required: { terminal: "needs_human" },
    retryable_infrastructure_failure: { terminal: "failed" },
    failure: { terminal: "failed" },
  };
  for (const [outcome, transition] of Object.entries(node.transitions)) {
    const graphOutcome = outcome as PublicGraphOutcome;
    transitions[GRAPH_TO_STAGE_OUTCOME[graphOutcome]] = compileTransition(transition);
  }
  for (const outcome of [
    "success",
    "no_change",
    "semantic_repair_required",
    "retryable_infrastructure_failure",
    "needs_human",
    "canceled",
    "superseded",
    "failure",
  ] as const) {
    if (transitions[outcome] === undefined) fail(`graph.nodes.${node.id}.transitions.${outcome}`, "is required");
  }
  return transitions as Record<StageOutcome, PipelineTransition>;
}

function loopTemplate(
  graph: GraphContract,
  node: GraphNode,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): StageTemplate {
  const loop = graph.loops.find((candidate) => candidate.id === node.loop);
  if (!loop) fail(`graph.nodes.${node.id}.loop`, "references an unknown loop");
  const worker = graph.workers.find((candidate) => candidate.id === loop.worker);
  if (!worker) fail(`graph.loops.${loop.id}.worker`, "references an unknown worker");
  if (worker.engine !== "agent") fail(`graph.workers.${worker.id}.engine`, "cannot compile non-agent loop workers yet");
  if (loop.receipt !== "unit_completion" && loop.receipt !== "semantic_review") {
    fail(`graph.loops.${loop.id}.receipt`, "cannot compile this loop receipt yet");
  }
  const { capability, repositorySkill } = capabilityFromSkill(
    loop.skill,
    `graph.loops.${loop.id}.skill`,
    repositorySkills
  );
  const isReview = loop.receipt === "semantic_review";
  const liveSteering = capability === "ce/implement@1" || capability === "ce/investigate@1";
  const template: StageTemplate = {
    executor: { kind: "agent", capability },
    ...(repositorySkill === undefined ? {} : { repositorySkill }),
    evaluator: {
      kind: "semantic",
      assurance: "semantic_attested",
      required_artifacts: isReview ? ["stage_result", "review"] : ["stage_result"],
    },
    context: contextFromSessionScope(worker),
    live_steering: liveSteering,
    credentials: worker.credentials,
    produces: isReview ? ["stage_result", "review"] : ["stage_result"],
  };
  assertCapabilityAuthorized(template, `graph.loops.${loop.id}`);
  return template;
}

function unitLoop(graph: GraphContract, node: GraphNode): ResolvedUnitLoop {
  const loop = graph.loops.find((candidate) => candidate.id === node.loop);
  if (!loop) fail(`graph.nodes.${node.id}.loop`, "references an unknown loop");
  if (loop.input_scope !== "unit") {
    fail(`graph.loops.${loop.id}.input_scope`, "for_each_unit requires unit input scope");
  }
  if (loop.receipt !== "unit_completion") {
    fail(`graph.loops.${loop.id}.receipt`, "for_each_unit requires unit_completion receipts");
  }
  const worker = graph.workers.find((candidate) => candidate.id === loop.worker);
  if (!worker) fail(`graph.loops.${loop.id}.worker`, "references an unknown worker");
  if (worker.engine !== "agent") fail(`graph.workers.${worker.id}.engine`, "for_each_unit requires an agent worker");
  if (loop.skill !== "builtin://ce/implement@1") {
    fail(`graph.loops.${loop.id}.skill`, "for_each_unit requires builtin://ce/implement@1");
  }
  return { loop, worker };
}

function forEachUnitTemplate(graph: GraphContract, node: GraphNode): StageTemplate {
  const { worker } = unitLoop(graph, node);
  const allowedCredentials = new Set(CAPABILITY_CREDENTIALS[FOR_EACH_UNIT_CAPABILITY].allowed);
  const template: StageTemplate = {
    executor: { kind: "loop_action", capability: FOR_EACH_UNIT_CAPABILITY },
    evaluator: {
      kind: "semantic",
      assurance: "executor_verified",
      required_artifacts: ["execution_graph_result"],
    },
    context: "none",
    live_steering: false,
    credentials: [...new Set(worker.credentials.filter((scope) => allowedCredentials.has(scope)))],
    produces: ["stage_result", "execution_graph_result"],
  };
  assertCapabilityAuthorized(template, `graph.nodes.${node.id}`);
  return template;
}

function capabilityOrder(capability: string): number {
  return [
    "ce/implement@1",
    "ce/investigate@1",
    "ce/review@1",
    "ce/simplify@1",
    "ce/publish@1",
    FOR_EACH_UNIT_CAPABILITY,
    REPOSITORY_SKILL_CAPABILITY,
    "command/run@1",
    "provider/wait@1",
    "agent/semantic@1",
  ].indexOf(capability);
}

function nodeTemplate(
  graph: GraphContract,
  node: GraphNode,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): StageTemplate {
  assertNoDependencies(node);
  if (node.kind === "run") return loopTemplate(graph, node, repositorySkills);
  if (node.kind === "for_each_unit") return forEachUnitTemplate(graph, node);
  if (node.kind === "command") {
    return {
      executor: { kind: "command", capability: "command/run@1" },
      commandName: commandNameFromGraph(node.command!, `graph.nodes.${node.id}.command`),
      evaluator: { kind: "command", assurance: "executor_verified", required_artifacts: ["command_result"] },
      context: "none",
      live_steering: false,
      credentials: ["repo.read"],
      produces: ["stage_result", "command_result"],
    };
  }
  if (node.kind === "publish") {
    return {
      executor: { kind: "agent", capability: "ce/publish@1" },
      evaluator: { kind: "publish_subject", assurance: "semantic_attested", required_artifacts: ["publish_subject"] },
      context: "resume_required",
      live_steering: false,
      credentials: ["model.invoke", "repo.read", "repo.write", "provider.read"],
      produces: ["stage_result", "publish_subject"],
    };
  }
  if (node.kind === "wait_for_provider") {
    return {
      executor: { kind: "provider_wait", capability: "provider/wait@1" },
      evaluator: { kind: "provider", assurance: "provider_verified", required_artifacts: ["provider_check"] },
      context: "none",
      live_steering: false,
      credentials: ["provider.read"],
      produces: ["stage_result", "provider_check"],
    };
  }
  if (node.kind === "human") fail(`graph.nodes.${node.id}.kind`, "cannot compile human nodes yet");
  const exhaustive: never = node.kind;
  return exhaustive;
}

function compileStage(
  graph: GraphContract,
  node: GraphNode,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): PipelineStage {
  const template = nodeTemplate(graph, node, repositorySkills);
  return {
    id: node.id,
    executor: template.executor,
    ...(template.commandName === undefined ? {} : { commandName: template.commandName }),
    ...(template.repositorySkill === undefined ? {} : { repositorySkill: template.repositorySkill }),
    evaluator: template.evaluator,
    context: template.context,
    live_steering: template.live_steering,
    credentials: template.credentials,
    produces: template.produces,
    transitions: compileTransitions(node),
  };
}

export function compileExecutionGraph(
  graph: GraphContract,
  options: CompileExecutionGraphOptions = {}
): ValidatedPipelineManifest {
  const manifest: PipelineManifest = {
    schema: "openthrottle.pipeline/v1",
    id: options.id ?? graph.id,
    version: options.version ?? graph.version,
    description: options.description ?? `Compiled execution graph ${graph.id}@${graph.version}.`,
    entry_stage: graph.entry_node,
    max_attempts: options.maxAttempts ?? 200,
    ...(options.maxRepairRounds === undefined ? {} : { max_repair_rounds: options.maxRepairRounds }),
    requires: {
      protocol: "stage-executor@1",
      capabilities: [...new Set(graph.nodes.map((node) => nodeTemplate(graph, node, options.repositorySkills).executor.capability))]
        .sort((left, right) => {
          const leftOrder = capabilityOrder(left);
          const rightOrder = capabilityOrder(right);
          if (leftOrder === -1 && rightOrder === -1) return left.localeCompare(right);
          if (leftOrder === -1) return 1;
          if (rightOrder === -1) return -1;
          return leftOrder - rightOrder;
        }),
    },
    stages: graph.nodes.map((node) => compileStage(graph, node, options.repositorySkills)),
  };
  return validatePipelineManifest(manifest, { runtime: options.runtime });
}

export function parseAndCompileExecutionGraph(
  raw: string,
  options: CompileExecutionGraphOptions & { source?: string } = {}
): CompiledExecutionGraph {
  const graph = parseGraphContract(raw, { source: options.source ?? "graph", config: options.config });
  return {
    graph: graph.value,
    graphDigest: graph.digest,
    manifest: compileExecutionGraph(graph.value, options),
  };
}

export function validateAndCompileExecutionGraph(
  value: unknown,
  options: CompileExecutionGraphOptions & { source?: string } = {}
): CompiledExecutionGraph {
  const graph = validateGraphContract(value, { source: options.source ?? "graph", config: options.config });
  return {
    graph: graph.value,
    graphDigest: graph.digest,
    manifest: compileExecutionGraph(graph.value, options),
  };
}
