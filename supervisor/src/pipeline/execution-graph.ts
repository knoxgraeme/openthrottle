import {
  COMMAND_NAME_PATTERN,
  parseGraphContract,
  validateGraphContract,
  type GraphContract,
  type GraphNode,
  type GraphUnitPhase,
  type GraphUnitPhaseId,
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
  type PipelineStageLoopBinding,
  type PipelineTransition,
  type PipelineUnitPhaseBinding,
  type RepositorySkillPackage,
  type RuntimeCapabilityInventory,
  type StageOutcome,
  type ValidatedPipelineManifest,
  unitPhaseBindingCommandNames,
  unitPhaseBindingIds,
} from "./manifest.js";
import {
  FOR_EACH_UNIT_CAPABILITY,
  ORDINARY_STAGE_BUILTIN_CAPABILITIES,
  REPOSITORY_SKILL_CAPABILITY,
  STRUCTURED_PHASE_BUILTIN_CAPABILITIES,
  capabilityCredentialContract,
  capabilityCredentialContractViolations,
  capabilityRequiresCredential,
} from "./capability-contracts.js";

export { FOR_EACH_UNIT_CAPABILITY, REPOSITORY_SKILL_CAPABILITY } from "./capability-contracts.js";

export interface CompileExecutionGraphOptions {
  id?: string;
  version?: number;
  description?: string;
  maxAttempts?: number;
  maxRepairRounds?: number;
  aggregatePublishContext?: "prefer_resume";
  ordinaryStageTimeoutSeconds?: number;
  runtime?: RuntimeCapabilityInventory;
  config?: RepositoryConfigContract;
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>;
}

export interface CompiledExecutionGraph {
  graph: GraphContract;
  graphDigest: string;
  unitPhases: readonly GraphUnitPhaseId[];
  unitCommandNames: readonly CommandName[];
  unitPhaseBindings: readonly PipelineUnitPhaseBinding[];
  manifest: ValidatedPipelineManifest;
}

type StageTemplate = {
  executor: { kind: ExecutorKind; capability: string };
  loop?: PipelineStageLoopBinding;
  repositorySkill?: RepositorySkillPackage;
  evaluator: { kind: EvaluatorKind; assurance: AssuranceClass; required_artifacts: ArtifactKind[] };
  context: ContextPolicy;
  live_steering: boolean;
  credentials: string[];
  produces: ArtifactKind[];
  requiredCapabilities?: readonly string[];
  commandName?: CommandName;
  unitPhases?: readonly GraphUnitPhaseId[];
  unitCommandNames?: readonly CommandName[];
  unitPhaseBindings?: readonly PipelineUnitPhaseBinding[];
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

// These are the builtin capabilities that sandbox/runner/execute-stage.mjs
// maps to installed whole-stage task adapters. A broader credential contract
// is not sufficient: accepting a capability with no dispatch mapping would run
// the generic fallback instead of the graph's declared skill.
const ORDINARY_RUN_BUILTIN_CAPABILITIES = new Set<string>(ORDINARY_STAGE_BUILTIN_CAPABILITIES);

const DEFAULT_TERMINALS: Pick<Record<StageOutcome, PipelineTransition>, "needs_human" | "canceled" | "superseded"> = {
  needs_human: { terminal: "needs_human" },
  canceled: { terminal: "canceled" },
  superseded: { terminal: "superseded" },
};

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function repoSkillId(skill: string): string | undefined {
  return skill.startsWith("repo://") ? skill.slice("repo://".length) : undefined;
}

function assertSupportedBuiltinCapability(capability: string, path: string): void {
  if (!capabilityCredentialContract(capability)) {
    fail(path, `unsupported builtin capability ${capability}`);
  }
}

function capabilityFromSkill(
  skill: string,
  path: string,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): { capability: string; repositorySkill?: RepositorySkillPackage } {
  if (skill.startsWith("builtin://")) {
    const capability = skill.slice("builtin://".length);
    assertSupportedBuiltinCapability(capability, path);
    return { capability };
  }
  const id = repoSkillId(skill);
  if (!id) fail(path, "must be a builtin or repository skill reference");
  const repositorySkill = repositorySkills?.get(id);
  if (!repositorySkill) {
    fail(path, `repository skill ${id} was not pinned by admission`);
  }
  return { capability: REPOSITORY_SKILL_CAPABILITY, repositorySkill };
}

function commandNameFromGraph(command: string, path: string, config?: RepositoryConfigContract): CommandName {
  if (!COMMAND_NAME_PATTERN.test(command)) {
    fail(path, "has an invalid command name");
  }
  if (config?.commands) {
    if (!Object.hasOwn(config.commands, command)) {
      fail(path, `must name a configured repository command`);
    }
    return command;
  }
  if (!COMMAND_NAMES.includes(command as (typeof COMMAND_NAMES)[number])) {
    fail(path, `must be one of: ${COMMAND_NAMES.join(", ")}`);
  }
  return command;
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
  for (const violation of capabilityCredentialContractViolations({
    capability: template.executor.capability,
    context: template.context,
    credentials: template.credentials,
    requiredArtifacts: template.evaluator.required_artifacts,
  })) {
    fail(path, violation.message);
  }
}

function assertGateReadOnly(
  phase: GraphUnitPhase,
  worker: GraphWorker,
  capability: string,
  path: string
): void {
  if (phase.kind !== "gate") return;
  if (worker.credentials.includes("repo.write")) {
    fail(`${path}.worker.credentials`, "gate phases cannot request repo.write");
  }
  if (capabilityRequiresCredential(capability, "repo.write")) {
    fail(`${path}.skill`, `${capability} requires repo.write and cannot be used for gate phases`);
  }
}

function assertStructuredChildReadOnly(worker: GraphWorker, path: string): void {
  if (worker.credentials.includes("repo.write")) {
    fail(`${path}.worker.credentials`, "structured child phases cannot request repo.write");
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
  ordinaryStageTimeoutSeconds?: number,
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
  if (loop.input_scope !== "graph" && loop.input_scope !== "diff" && loop.input_scope !== "review") {
    fail(`graph.loops.${loop.id}.input_scope`, "cannot compile this loop input scope for run nodes yet");
  }
  if (ordinaryStageTimeoutSeconds !== undefined && loop.timeout_seconds !== ordinaryStageTimeoutSeconds) {
    fail(
      `graph.loops.${loop.id}.timeout_seconds`,
      `must equal the enforced ordinary stage timeout ${ordinaryStageTimeoutSeconds}`
    );
  }
  const { capability, repositorySkill } = capabilityFromSkill(
    loop.skill,
    `graph.loops.${loop.id}.skill`,
    repositorySkills
  );
  if (repositorySkill === undefined && !ORDINARY_RUN_BUILTIN_CAPABILITIES.has(capability)) {
    fail(`graph.loops.${loop.id}.skill`, `${capability} has no ordinary stage dispatch adapter`);
  }
  const isReview = loop.receipt === "semantic_review";
  const liveSteering = capability === "ce/implement@1" || capability === "ce/investigate@1";
  const template: StageTemplate = {
    executor: { kind: "agent", capability },
    loop: {
      id: loop.id,
      skill: loop.skill,
      input_scope: loop.input_scope,
      receipt: loop.receipt,
      max_parallel: loop.max_parallel,
      max_rounds: loop.max_rounds,
      timeout_seconds: loop.timeout_seconds,
    },
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

function unitPhaseLoop(
  graph: GraphContract,
  node: GraphNode,
  phase: GraphUnitPhase,
  index: number,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): PipelineUnitPhaseBinding {
  const loop = graph.loops.find((candidate) => candidate.id === phase.loop);
  if (!loop) fail(`graph.nodes.${node.id}.phases.${index}.loop`, "references an unknown loop");
  if (loop.input_scope !== "unit") {
    fail(`graph.loops.${loop.id}.input_scope`, "for_each_unit phases require unit input scope");
  }
  if (loop.max_parallel !== 1) {
    fail(`graph.loops.${loop.id}.max_parallel`, "for_each_unit phases do not support parallel loop actions yet");
  }
  if (phase.kind === "agent" && loop.receipt !== "unit_completion") {
    fail(`graph.loops.${loop.id}.receipt`, "for_each_unit agent phases require unit_completion receipts");
  }
  if (phase.kind === "gate" && loop.receipt !== "unit_decision") {
    fail(`graph.loops.${loop.id}.receipt`, "for_each_unit gate phases require unit_decision receipts");
  }
  const worker = graph.workers.find((candidate) => candidate.id === loop.worker);
  if (!worker) fail(`graph.loops.${loop.id}.worker`, "references an unknown worker");
  if (worker.engine !== "agent") fail(`graph.workers.${worker.id}.engine`, "for_each_unit phases require an agent worker");
  const { capability, repositorySkill } = capabilityFromSkill(loop.skill, `graph.loops.${loop.id}.skill`, repositorySkills);
  const expectedBuiltinCapability = STRUCTURED_PHASE_BUILTIN_CAPABILITIES[
    phase.id as keyof typeof STRUCTURED_PHASE_BUILTIN_CAPABILITIES
  ];
  if (repositorySkill === undefined && capability !== expectedBuiltinCapability) {
    fail(
      `graph.nodes.${node.id}.phases.${index}.skill`,
      `${capability} is not runnable for the ${phase.id} phase; expected ${expectedBuiltinCapability}`
    );
  }
  const context = contextFromSessionScope(worker);
  const kind = phase.kind as "agent" | "gate";
  assertGateReadOnly(phase, worker, capability, `graph.nodes.${node.id}.phases.${index}`);
  assertStructuredChildReadOnly(worker, `graph.nodes.${node.id}.phases.${index}`);
  // Structured child agents mutate only executor-owned local worktrees. Remote
  // write credentials are intentionally unavailable, so the simple-stage
  // capability minimum for repo.write does not apply to this child dispatch
  // boundary.
  return {
    id: phase.id,
    kind,
    loop: {
      id: loop.id,
      skill: loop.skill,
      input_scope: "unit",
      receipt: loop.receipt,
      max_parallel: loop.max_parallel,
      max_rounds: loop.max_rounds,
      timeout_seconds: loop.timeout_seconds,
    },
    worker: {
      id: worker.id,
      engine: "agent",
      ...(worker.agent === undefined ? {} : { agent: worker.agent }),
      ...(worker.model === undefined ? {} : { model: worker.model }),
      allowed_mcp_servers: [...worker.allowed_mcp_servers],
      session_scope: worker.session_scope,
      credentials: [...worker.credentials],
    },
    executor: { kind: "agent", capability },
    context,
    credentials: [...worker.credentials],
    ...(repositorySkill === undefined ? {} : { repositorySkill }),
  };
}

function forEachUnitTemplate(
  graph: GraphContract,
  node: GraphNode,
  config?: RepositoryConfigContract,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): StageTemplate {
  if (!node.phases) fail(`graph.nodes.${node.id}.phases`, "is required for for_each_unit nodes");
  const unitPhaseBindings = node.phases.map((phase, index): PipelineUnitPhaseBinding => {
    if (phase.kind === "agent" || phase.kind === "gate") return unitPhaseLoop(graph, node, phase, index, repositorySkills);
    if (phase.kind === "command") {
      return {
        id: phase.id,
        kind: phase.kind,
        commands: (phase.commands ?? []).map((command) =>
          commandNameFromGraph(command, `graph.nodes.${node.id}.phases.${index}.commands`, config)),
      };
    }
    return { id: phase.id, kind: phase.kind };
  });
  const credentialScopes = unitPhaseBindings.flatMap((binding) =>
    binding.kind === "agent" || binding.kind === "gate" ? binding.worker.credentials : []);
  const allowedCredentials = new Set(capabilityCredentialContract(FOR_EACH_UNIT_CAPABILITY)!.allowed);
  const unitCommandNames = unitPhaseBindingCommandNames(unitPhaseBindings);
  const template: StageTemplate = {
    executor: { kind: "loop_action", capability: FOR_EACH_UNIT_CAPABILITY },
    evaluator: {
      kind: "semantic",
      assurance: "executor_verified",
      required_artifacts: ["execution_graph_result"],
    },
    context: "none",
    live_steering: false,
    credentials: [...new Set(credentialScopes.filter((scope) => allowedCredentials.has(scope)))],
    produces: ["stage_result", "execution_graph_result"],
    requiredCapabilities: [
      FOR_EACH_UNIT_CAPABILITY,
      ...unitPhaseBindings.flatMap((binding) =>
        binding.kind === "agent" || binding.kind === "gate" ? [binding.executor.capability] : []),
    ],
    unitPhases: unitPhaseBindingIds(unitPhaseBindings),
    unitCommandNames,
    unitPhaseBindings,
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

function publishContextFor(
  graph: GraphContract,
  node: GraphNode,
  aggregatePublishContext?: CompileExecutionGraphOptions["aggregatePublishContext"]
): ContextPolicy {
  if (aggregatePublishContext !== undefined && aggregatePublishContext !== "prefer_resume") {
    fail("compile.aggregatePublishContext", "must be prefer_resume when provided");
  }
  const followsStructuredAggregate = graph.nodes.some((candidate) =>
    candidate.kind === "for_each_unit" &&
    Object.values(candidate.transitions).some((transition) => transition.to === node.id)
  );
  return followsStructuredAggregate && aggregatePublishContext === "prefer_resume" ? "prefer_resume" : "resume_required";
}

function nodeTemplate(
  graph: GraphContract,
  node: GraphNode,
  options: Pick<CompileExecutionGraphOptions, "aggregatePublishContext" | "ordinaryStageTimeoutSeconds"> = {},
  config?: RepositoryConfigContract,
  repositorySkills?: ReadonlyMap<string, RepositorySkillPackage>
): StageTemplate {
  assertNoDependencies(node);
  if (node.kind === "run") {
    return loopTemplate(graph, node, options.ordinaryStageTimeoutSeconds, repositorySkills);
  }
  if (node.kind === "for_each_unit") return forEachUnitTemplate(graph, node, config, repositorySkills);
  if (node.kind === "command") {
    return {
      executor: { kind: "command", capability: "command/run@1" },
      commandName: commandNameFromGraph(node.command!, `graph.nodes.${node.id}.command`, config),
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
      context: publishContextFor(graph, node, options.aggregatePublishContext),
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

function compileStage(node: GraphNode, template: StageTemplate): PipelineStage {
  return {
    id: node.id,
    executor: template.executor,
    ...(template.loop === undefined ? {} : { loop: template.loop }),
    ...(template.commandName === undefined ? {} : { commandName: template.commandName }),
    ...(template.unitPhases === undefined ? {} : { unitPhases: [...template.unitPhases] }),
    ...(template.unitCommandNames === undefined ? {} : { unitCommandNames: [...template.unitCommandNames] }),
    ...(template.unitPhaseBindings === undefined ? {} : { unitPhaseBindings: [...template.unitPhaseBindings] }),
    ...(template.repositorySkill === undefined ? {} : { repositorySkill: template.repositorySkill }),
    evaluator: template.evaluator,
    context: template.context,
    live_steering: template.live_steering,
    credentials: template.credentials,
    produces: template.produces,
    transitions: compileTransitions(node),
  };
}

function unitPhaseProjectionFromManifest(manifest: PipelineManifest): Pick<
  CompiledExecutionGraph,
  "unitPhases" | "unitCommandNames" | "unitPhaseBindings"
> {
  const unitStage = manifest.stages.find((stage) =>
    stage.executor.kind === "loop_action" && stage.executor.capability === FOR_EACH_UNIT_CAPABILITY
  );
  const unitPhaseBindings = unitStage?.unitPhaseBindings ?? [];
  return {
    unitPhases: unitPhaseBindingIds(unitPhaseBindings),
    unitCommandNames: unitPhaseBindingCommandNames(unitPhaseBindings),
    unitPhaseBindings,
  };
}

export function compileExecutionGraph(
  graph: GraphContract,
  options: CompileExecutionGraphOptions = {}
): ValidatedPipelineManifest {
  const templates = graph.nodes.map((node) =>
    nodeTemplate(graph, node, options, options.config, options.repositorySkills));
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
      capabilities: [...new Set(templates.flatMap((template) =>
        template.requiredCapabilities ?? [template.executor.capability]))]
        .sort((left, right) => {
          const leftOrder = capabilityOrder(left);
          const rightOrder = capabilityOrder(right);
          if (leftOrder === -1 && rightOrder === -1) return left.localeCompare(right);
          if (leftOrder === -1) return 1;
          if (rightOrder === -1) return -1;
          return leftOrder - rightOrder;
        }),
    },
    stages: graph.nodes.map((node, index) => compileStage(node, templates[index]!)),
  };
  return validatePipelineManifest(manifest, { runtime: options.runtime });
}

export function parseAndCompileExecutionGraph(
  raw: string,
  options: CompileExecutionGraphOptions & { source?: string } = {}
): CompiledExecutionGraph {
  const graph = parseGraphContract(raw, { source: options.source ?? "graph", config: options.config });
  const compiledManifest = compileExecutionGraph(graph.value, options);
  const unitPhaseProjection = unitPhaseProjectionFromManifest(compiledManifest.manifest);
  return {
    graph: graph.value,
    graphDigest: graph.digest,
    ...unitPhaseProjection,
    manifest: compiledManifest,
  };
}

export function validateAndCompileExecutionGraph(
  value: unknown,
  options: CompileExecutionGraphOptions & { source?: string } = {}
): CompiledExecutionGraph {
  const graph = validateGraphContract(value, { source: options.source ?? "graph", config: options.config });
  const compiledManifest = compileExecutionGraph(graph.value, options);
  const unitPhaseProjection = unitPhaseProjectionFromManifest(compiledManifest.manifest);
  return {
    graph: graph.value,
    graphDigest: graph.digest,
    ...unitPhaseProjection,
    manifest: compiledManifest,
  };
}
