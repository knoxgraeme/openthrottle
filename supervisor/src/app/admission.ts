import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";
import {
  canonicalJson,
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_PLAN_SCHEMAS,
  TUNE_ANALYSIS_INPUT_SCHEMA,
  TUNE_SEALED_INTENT_SCHEMA,
  TUNE_TASK_SCHEMA,
  deriveTuneCorpusDigest,
  deriveTuneCorpusRowDigest,
  digestCanonicalJson,
  digestNormalized,
  parseAnyExecutionPlanContract,
  parseGraphContract,
  parseTuneTaskContract,
  validateTuneAnalysisInputContract,
  validateTuneSealedIntentContract,
  type ExecutionPlanContractV2,
  type TuneCorpusRow,
} from "@openthrottle/contracts";
import type {
  ControlThreadEvent,
  RepositoryDirectorySnapshot,
  RepositoryFileSnapshot,
  RepositoryConfigSnapshot,
  ResolvedControlLabel,
} from "./ports.js";
import {
  parseRepositoryConfig,
  resolvePipelineReference,
  validatePipelineManifest,
  type ValidatedPipelineCatalog,
  type ValidatedPipelineManifest,
  type ValidatedRepositoryConfig,
} from "../pipeline/manifest.js";
import { FOR_EACH_UNIT_CAPABILITY, parseAndCompileExecutionGraph } from "../pipeline/execution-graph.js";
import { assertStructuredPlanLoopEnvelopeBound } from "../pipeline/structured-loop-envelope.js";
import type { RepositorySkillPackage } from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import { extractJsonBlocks, extractJsonBlocksAny } from "../pipeline/markdown.js";
import type { StageRequestInputArtifact } from "../pipeline/stage-request.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import { admissionMaintenanceError } from "../persistence/maintenance-store.js";
import {
  composeBoundedTaskContext,
  ORDINARY_STAGE_TASK_CONTEXT_LIMIT,
} from "./admission-context.js";
import type { PipelineCoordinatorContext, SessionServicePorts } from "./session-service.js";

const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const EXECUTION_PLAN_FENCES = EXECUTION_PLAN_SCHEMAS;
const EXECUTION_PLAN_ARTIFACT_SCHEMA_VERSION = 2;
const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";
const TUNE_TASK_FENCE = TUNE_TASK_SCHEMA;
const BUILTIN_SIMPLE_GRAPH = fileURLToPath(new URL("../../graphs/simple-v1.json", import.meta.url));
const BUILTIN_GRAPHS = {
  "core/structured@1": {
    path: fileURLToPath(new URL("../../graphs/structured-v1.json", import.meta.url)),
    id: "builtin/structured",
    version: 1,
    description: "Compiled execution graph structured from builtin core/structured@1.",
    aggregatePublishContext: undefined,
  },
  "core/structured@2": {
    path: fileURLToPath(new URL("../../graphs/structured-v2.json", import.meta.url)),
    id: "builtin/structured",
    version: 2,
    description: "Compiled execution graph structured from builtin core/structured@2.",
    aggregatePublishContext: "prefer_resume",
  },
  "core/structured@3": {
    path: fileURLToPath(new URL("../../graphs/structured-v3.json", import.meta.url)),
    id: "builtin/structured",
    version: 3,
    description: "Compiled execution graph structured from builtin core/structured@3.",
    aggregatePublishContext: "prefer_resume",
  },
} as const;
const SIMPLE_IMPLEMENT_DESCRIPTION = "Staged CE implementation from a pre-approved plan with round-based repair budgeting, scoped repair re-entry, sealed repository gates, exact-tree publication, and bounded provider repair. The initial forward pass may simplify; repair passes re-run semantic review and command gates without re-running simplification.";
const REPOSITORY_SKILL_PACKAGE_SCHEMA = "openthrottle.repository-skill-package/v1";
// Repository graph blobs are immutable inputs, but compiler changes can alter
// their normalized manifest bytes. Bump this identity version whenever that
// happens so an already-accepted manifest identity is never silently reused.
const REPOSITORY_GRAPH_COMPILER_IDENTITY_VERSION = 2;
const DEFAULT_REPOSITORY_TASK_TIMEOUT_SECONDS = 7_200;
type BuiltinGraphReference = keyof typeof BUILTIN_GRAPHS;

function linearContext(
  payload: ControlThreadEvent,
  fallback: string
): string {
  return payload.promptContext?.trim() || fallback;
}

function builtinGraphFor(ref: string): typeof BUILTIN_GRAPHS[BuiltinGraphReference] | undefined {
  return Object.hasOwn(BUILTIN_GRAPHS, ref)
    ? BUILTIN_GRAPHS[ref as BuiltinGraphReference]
    : undefined;
}

function extractLabelNames(payload: ControlThreadEvent): string[] {
  const labels = payload.agentSession.thread?.labels;
  if (Array.isArray(labels)) return labels.map((label) => label.name);
  return labels?.nodes?.map((label) => label.name) ?? [];
}

function labelMatchNames(labels: ResolvedControlLabel[]): string[] {
  const names: string[] = [];
  for (const label of labels) {
    names.push(label.name);
    if (label.parentName) names.push(`${label.parentName} › ${label.name}`);
  }
  return names;
}

function branchFor(issueIdentifier: string, sessionId: string): string {
  return `ot/${issueIdentifier.toLowerCase()}-${digestNormalized(sessionId).slice(0, 10)}`;
}

function controlTicketId(provider: ControlThreadEvent["provider"], externalThreadId: string): string {
  return `${provider}:${externalThreadId}`;
}

// An `agent › <engine>` label (also `agent >`, `agent:`, `agent/`) selects the
// delegation engine -- flat (a label literally named `agent:codex`) or
// group-child (a label group named `agent` with a child label named
// `codex`), same convention as the `branch` label. Matching happens against
// labels re-fetched fresh from Linear at admission (see handleCreated); the
// event payload's label snapshot can be stale by the time admission runs.
// Multiple/conflicting agent labels resolve deterministically: opencode
// outranks codex outranks claude.
const AGENT_LABEL_PATTERN = /^agent\s*(?:›|>|:|\/)\s*(claude|codex|opencode)\s*$/i;

function pickAgent(labels: string[], defaultAgent: Agent): Agent {
  const selected = new Set<Agent>();
  for (const label of labels) {
    const match = label.trim().match(AGENT_LABEL_PATTERN);
    if (match) selected.add(match[1]!.toLowerCase() as Agent);
  }
  if (selected.has("opencode")) return "opencode";
  if (selected.has("codex")) return "codex";
  if (selected.has("claude")) return "claude";
  return defaultAgent;
}

function hasAgentSubscription(cfg: Config, agent: Agent): boolean {
  if (agent === "codex") return Boolean(cfg.codexAuthJson);
  if (agent === "claude") return Boolean(cfg.claudeCodeOauthToken);
  return Boolean(cfg.kimiCodeApiKey);
}

function agentDisplayName(agent: Agent): string {
  if (agent === "codex") return "Codex";
  if (agent === "claude") return "Claude";
  return "OpenCode";
}

// The configuration NAME only. A credential value must never reach a Linear-
// visible admission error.
function agentCredentialVariable(agent: Agent): string {
  if (agent === "codex") return "CODEX_AUTH_JSON";
  if (agent === "claude") return "CLAUDE_CODE_OAUTH_TOKEN";
  return "KIMI_CODE_API_KEY";
}

// A stage that hosts loop actions (`for_each_unit`) never carries
// `model.invoke` itself: the scope is materialized per child action instead.
// Reading only the stage scopes therefore made every structured graph -- whose
// single compiled stage is that loop host -- look like it needed no model at
// all, so a pipeline with no engine credential was admitted, provisioned a
// Daytona sandbox, and only failed once the engine died inside it (OPE-59).
function pipelineInvokesModel(manifest: ValidatedPipelineManifest): boolean {
  return manifest.manifest.stages.some((stage) =>
    stage.credentials.includes("model.invoke") || stage.executor.kind === "loop_action"
  );
}

function pipelineUsesOpenCodeLoopActions(manifest: ValidatedPipelineManifest, selectedAgent: Agent): boolean {
  return manifest.manifest.stages.some((stage) =>
    stage.executor.kind === "loop_action" &&
    (
      selectedAgent === "opencode" ||
      (stage.unitPhaseBindings ?? []).some((binding) =>
        (binding.kind === "agent" || binding.kind === "gate") &&
        binding.worker.agent === "opencode"
      )
    )
  );
}

function effectiveStructuredWorkerAgents(manifest: ValidatedPipelineManifest, selectedAgent: Agent): Set<Agent> {
  const agents = new Set<Agent>();
  for (const stage of manifest.manifest.stages) {
    if (stage.credentials.includes("model.invoke")) agents.add(selectedAgent);
    if (stage.executor.kind !== "loop_action") continue;
    // Built-in final review/final repair workers inherit the ticket-selected
    // engine even when every unit phase overrides it.
    agents.add(selectedAgent);
    for (const binding of stage.unitPhaseBindings ?? []) {
      if (binding.kind !== "agent" && binding.kind !== "gate") continue;
      const workerAgent = binding.worker.agent === undefined || binding.worker.agent === "inherit"
        ? selectedAgent
        : binding.worker.agent;
      agents.add(workerAgent);
    }
  }
  return agents;
}

function extractShipSelectionGraphId(context: string): string | undefined {
  const blocks = extractJsonBlocks(context, SHIP_SELECTION_FENCE);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) throw new Error(`expected at most one ${SHIP_SELECTION_FENCE} block, found ${blocks.length}`);
  const parsed = JSON.parse(blocks[0]!) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SHIP_SELECTION_FENCE}: must be an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SHIP_SELECTION_FENCE) {
    throw new Error(`${SHIP_SELECTION_FENCE}.schema: must be ${SHIP_SELECTION_FENCE}`);
  }
  if (typeof record.graph_id !== "string" || record.graph_id.length === 0) {
    throw new Error(`${SHIP_SELECTION_FENCE}.graph_id: must be a non-empty string`);
  }
  return record.graph_id;
}

function assertNoUnfencedControlJson(context: string): void {
  for (const schema of [SHIP_SELECTION_FENCE, ...EXECUTION_PLAN_FENCES]) {
    const outsideCanonicalFence = context.replace(
      /```([^\n`]*)\n[\s\S]*?```/g,
      (block, marker: string) => marker.trim().split(/\s+/).includes(schema) ? "" : block
    );
    const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`"schema"\\s*:\\s*"${escaped}"`).test(outsideCanonicalFence)) {
      throw new Error(
        `found ${schema} control JSON outside its canonical \`\`\`json ${schema} fenced block`
      );
    }
  }
}

// At structured admission, the plan is parsed and (via
// assertStructuredPlanLoopEnvelopeBound below) projected through the exact
// same production function dispatch uses (loopActionPlanContext) before any
// sandbox is provisioned. A v2 plan's per-unit structural completeness --
// missing required fields, unresolved dependency references, values over
// bound -- is therefore rejected here, naming the offending unit and field,
// never inside a provisioned sandbox (OPE-166).
function extractExecutionPlan(context: string): ExecutionPlanContractV2 | undefined {
  const blocks = extractJsonBlocksAny(context, EXECUTION_PLAN_FENCES);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) {
    throw new Error(`expected at most one execution-plan block, found ${blocks.length}`);
  }
  const plan = parseAnyExecutionPlanContract(blocks[0]!, { source: "issue.execution_plan" }).value;
  if (plan.schema !== EXECUTION_PLAN_SCHEMA_V2) {
    throw new Error(`fresh structured admission requires ${EXECUTION_PLAN_SCHEMA_V2}; ${EXECUTION_PLAN_FENCE} is replay-only`);
  }
  return plan;
}

function executionPlanInputArtifact(plan: ExecutionPlanContractV2 | undefined): StageRequestInputArtifact[] | undefined {
  if (!plan) return undefined;
  const payload = canonicalJson({
    schema: EXECUTION_PLAN_SCHEMA_V2,
    execution_plan: plan,
  });
  return [{
    kind: "stage_result",
    schemaVersion: EXECUTION_PLAN_ARTIFACT_SCHEMA_VERSION,
    assurance: "executor_verified",
    subject: null,
    payload,
    hash: digestNormalized(payload),
  }];
}

async function sealTuneTaskContext(input: {
  context: string;
  ticketId: string;
  sessionId: string;
  repository: string;
  baseCommit: string;
  baseBranch: string;
  runtime: PipelineCoordinatorContext["runtime"];
  corpus: NonNullable<PipelineCoordinatorContext["tuneCorpus"]>;
  readPinnedFile: (path: string) => Promise<RepositoryFileSnapshot>;
  now?: () => Date;
}): Promise<string> {
  const blocks = extractJsonBlocks(input.context, TUNE_TASK_FENCE);
  if (blocks.length !== 1) {
    throw new Error(`tune tickets require exactly one canonical ${TUNE_TASK_FENCE} block`);
  }
  const taskContract = parseTuneTaskContract(blocks[0]!, { source: "issue.tune_task" });
  const task = taskContract.value;
  if (task.baseline.base_ref !== input.baseCommit && task.baseline.base_ref !== input.baseBranch) {
    throw new Error("tune task baseline.base_ref does not match the pinned repository base");
  }
  if (task.baseline.base_digest !== digestNormalized(input.baseCommit)) {
    throw new Error("tune task baseline.base_digest does not match the pinned repository base");
  }
  if (
    task.baseline.runtime_release !== input.runtime.descriptor.release ||
    task.baseline.capability_digest !== input.runtime.digest
  ) {
    throw new Error("tune task baseline runtime identity is stale");
  }
  if (task.target.path) {
    const target = await input.readPinnedFile(task.target.path);
    if (target.commit !== input.baseCommit || digestNormalized(target.content) !== task.target.digest) {
      throw new Error("tune task target digest does not match the pinned repository file");
    }
  }
  const limit = Math.min(task.query.limit, task.window.limit);
  const outcomes = input.corpus.listRunOutcomes({
    outcome: task.query.outcome,
    reason: task.query.reason,
    graph: task.query.graph,
    skillDigest: task.query.skill,
    from: task.window.from,
    to: task.window.to,
    limit,
  });
  const rows: TuneCorpusRow[] = outcomes.map((outcome) => {
    const source = {
      pipeline_instance_id: outcome.pipeline_instance_id,
      generation: outcome.generation,
      execution_graph_id: outcome.execution_graph_id,
      outcome: outcome.outcome,
      closed_reason: outcome.closed_reason,
      fault_attribution: outcome.fault_attribution,
      created_at: outcome.created_at,
    };
    const sourceDigest = digestCanonicalJson(source);
    const rowWithoutDigest = {
      id: `run-${sourceDigest.slice(0, 32)}`,
      ...source,
      source_digests: [sourceDigest],
    };
    return { ...rowWithoutDigest, row_digest: deriveTuneCorpusRowDigest(rowWithoutDigest) };
  });
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const sealedIntentContract = validateTuneSealedIntentContract({
    schema: TUNE_SEALED_INTENT_SCHEMA,
    id: `intent-${task.id}`,
    task,
    task_digest: taskContract.digest,
    sealed_at: timestamp,
    authority_digest: digestCanonicalJson({
      ticket_id: input.ticketId,
      session_id: input.sessionId,
      repository: input.repository,
      base_commit: input.baseCommit,
      task_digest: taskContract.digest,
      runtime_release: input.runtime.descriptor.release,
      capability_digest: input.runtime.digest,
    }),
  });
  const { value: sealedIntent, digest: intentDigest } = sealedIntentContract;
  const analysisInput = validateTuneAnalysisInputContract({
    schema: TUNE_ANALYSIS_INPUT_SCHEMA,
    id: `analysis-${task.id}`,
    intent: sealedIntent,
    intent_digest: intentDigest,
    corpus_rows: rows,
    corpus_digest: deriveTuneCorpusDigest(rows),
  }).value;
  return [
    "The following contracts were produced by the supervisor from the authenticated run-outcome store. No ticket, comment, review, finding, or prompt prose is authorized input.",
    `\`\`\`json ${TUNE_SEALED_INTENT_SCHEMA}\n${canonicalJson(sealedIntent)}\n\`\`\``,
    `\`\`\`json ${TUNE_ANALYSIS_INPUT_SCHEMA}\n${canonicalJson(analysisInput)}\n\`\`\``,
  ].join("\n\n");
}

function extractRequestedGraph(context: string): {
  graphId?: string;
  hasExecutionPlan: boolean;
  executionPlan?: ExecutionPlanContractV2;
} {
  assertNoUnfencedControlJson(context);
  const selected = extractShipSelectionGraphId(context);
  const executionPlan = extractExecutionPlan(context);
  const planned = executionPlan?.graph_id;
  if (selected && planned && selected !== planned) {
    throw new Error(`ship selection graph_id ${selected} does not match execution_plan.graph_id ${planned}`);
  }
  return { graphId: selected ?? planned, hasExecutionPlan: planned !== undefined, executionPlan };
}

function repositorySkillIds(rawGraph: string, source: string, config: ValidatedRepositoryConfig["config"]): string[] {
  const graph = parseGraphContract(rawGraph, { source, config }).value;
  return [...new Set(graph.loops.flatMap((loop) => (
    loop.skill.startsWith("repo://") ? [loop.skill.slice("repo://".length)] : []
  )))].sort();
}

function repositorySkillFrontmatterName(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("repository skill SKILL.md is missing frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("repository skill SKILL.md frontmatter is unterminated");
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^name:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,127})["']?\s*$/);
    if (match) return match[1];
  }
  throw new Error("repository skill SKILL.md frontmatter is missing name");
}

function repositorySkillNameMatchesInvocation(name: string, invocation: string): boolean {
  return name === invocation;
}

async function resolveRepositorySkillPackages(input: {
  rawGraph: string;
  source: string;
  repositoryConfig: ValidatedRepositoryConfig;
  readPinnedDirectory: (path: string) => Promise<RepositoryDirectorySnapshot>;
}): Promise<ReadonlyMap<string, RepositorySkillPackage>> {
  const ids = repositorySkillIds(input.rawGraph, input.source, input.repositoryConfig.config);
  const configured = new Map((input.repositoryConfig.config.skills ?? []).map((skill) => [skill.id, skill]));
  const packages = new Map<string, RepositorySkillPackage>();
  for (const id of ids) {
    const declaration = configured.get(id);
    if (!declaration) throw new Error(`graph skill repo://${id} is not declared in repository config skills`);
    const snapshot = await input.readPinnedDirectory(declaration.path);
    if (snapshot.directory !== declaration.path) {
      throw new Error(`repository skill ${id} resolved to unexpected directory ${snapshot.directory}`);
    }
    if (!snapshot.files.some((file) => file.path === `${declaration.path}/SKILL.md`)) {
      throw new Error(`repository skill ${id} package is missing SKILL.md`);
    }
    const skillFile = snapshot.files.find((file) => file.path === `${declaration.path}/SKILL.md`)!;
    const frontmatterName = repositorySkillFrontmatterName(skillFile.content);
    if (!repositorySkillNameMatchesInvocation(frontmatterName, id)) {
      throw new Error(`repository skill ${id} SKILL.md name does not match the configured invocation`);
    }
    const files = snapshot.files.map((file) => ({
      path: file.path,
      blobSha: file.blobSha,
      digest: digestNormalized(file.content),
    }));
    const unsigned = {
      schema: REPOSITORY_SKILL_PACKAGE_SCHEMA as "openthrottle.repository-skill-package/v1",
      reference: `repo://${snapshot.repository}@${snapshot.commit}#${declaration.path}`,
      invocation: id,
      directory: declaration.path,
      commit: snapshot.commit,
      files,
    };
    packages.set(id, {
      ...unsigned,
      packageDigest: digestNormalized(canonicalJson(unsigned)),
    });
  }
  return packages;
}

async function resolvePipelineSelection(
  repositoryConfig: ValidatedRepositoryConfig,
  context: string,
  readPinnedFile: (path: string) => Promise<RepositoryFileSnapshot>,
  readPinnedDirectory: (path: string) => Promise<RepositoryDirectorySnapshot>,
  runtime: PipelineCoordinatorContext["runtime"],
  catalog: ValidatedPipelineCatalog,
  selectedAgent: Agent,
  taskTimeoutSeconds: number,
  acceptedManifestDigest?: (pipelineId: string, version: number) => string | undefined
): Promise<ValidatedPipelineManifest> {
  const intent = repositoryConfig.config.intents?.implement;
  const requested = extractRequestedGraph(context);
  const graphId = requested.graphId ?? intent?.default_graph ?? repositoryConfig.config.default_graph;
  const allowedGraphs = intent?.allowed_graphs ?? [repositoryConfig.config.default_graph];
  if (!allowedGraphs.includes(graphId)) {
    throw new Error(`graph ${graphId} is not allowed for implement; allowed: ${allowedGraphs.join(", ")}`);
  }
  const source = repositoryConfig.config.graphs.find((entry) => entry.id === graphId);
  if (!source) throw new Error(`graph ${graphId} is not declared in repository config`);
  const builtinGraph = source.kind === "builtin" ? builtinGraphFor(source.ref) : undefined;
  let rawGraph: string;
  let compileSource: string;
  let blobDescription: string;
  let manifestId: string | undefined;
  if (source.kind === "repository") {
    const snapshot = await readPinnedFile(source.ref);
    rawGraph = snapshot.content;
    compileSource = `${snapshot.repository}@${snapshot.commit}:${snapshot.path}`;
    blobDescription = `${snapshot.path}@${snapshot.blobSha}`;
    manifestId = `repository/${digestNormalized(canonicalJson({
      graphId,
      blobSha: snapshot.blobSha,
      path: snapshot.path,
      compilerVersion: REPOSITORY_GRAPH_COMPILER_IDENTITY_VERSION,
    }))}`;
  } else if (source.ref === "core/simple@1") {
    rawGraph = readFileSync(BUILTIN_SIMPLE_GRAPH, "utf8");
    compileSource = "builtin:core/simple@1";
    blobDescription = "builtin core/simple@1";
  } else if (builtinGraph) {
    rawGraph = readFileSync(builtinGraph.path, "utf8");
    compileSource = `builtin:${source.ref}`;
    blobDescription = `builtin ${source.ref}`;
  } else {
    throw new Error(`unknown built-in graph reference ${source.ref}`);
  }
  const repositorySkills = source.kind === "repository"
    ? await resolveRepositorySkillPackages({
      rawGraph,
      source: compileSource,
      repositoryConfig,
      readPinnedDirectory,
    })
    : undefined;
  const repositoryTaskTimeoutSeconds = repositoryConfig.config.limits?.task_timeout ??
    DEFAULT_REPOSITORY_TASK_TIMEOUT_SECONDS;
  const ordinaryStageTimeoutSeconds = Math.min(taskTimeoutSeconds, repositoryTaskTimeoutSeconds);
  const compileOptions = {
    source: compileSource,
    includeOrdinaryLoopBinding: source.kind === "repository",
    ...(source.kind === "repository" ? {
      config: repositoryConfig.config,
      ordinaryStageTimeoutSeconds,
    } : {}),
    ...(repositorySkills === undefined ? {} : { repositorySkills }),
    ...(source.ref === "core/simple@1" ? {
      id: "core/implement",
      version: 4,
      description: SIMPLE_IMPLEMENT_DESCRIPTION,
      maxAttempts: 200,
      maxRepairRounds: 5,
    } : source.ref === "core/structured@1" ? {
      id: `builtin/${graphId}`,
      version: 1,
      description: `Compiled execution graph ${graphId} from ${blobDescription}.`,
      maxAttempts: 200,
    } : builtinGraph ? {
      id: builtinGraph.id,
      version: builtinGraph.version,
      description: builtinGraph.description,
      maxAttempts: 200,
      ...(builtinGraph.aggregatePublishContext
        ? { aggregatePublishContext: builtinGraph.aggregatePublishContext }
        : {}),
    } : {
      id: manifestId,
      description: `Compiled execution graph ${graphId} from ${blobDescription}.`,
      maxAttempts: 200,
    }),
  };
  let compiled = parseAndCompileExecutionGraph(rawGraph, compileOptions);
  if (source.kind === "repository") {
    const aggregatePublishCompiled = parseAndCompileExecutionGraph(rawGraph, {
      ...compileOptions,
      aggregatePublishContext: "prefer_resume" as const,
    });
    const existingDigest = acceptedManifestDigest?.(
      compiled.manifest.manifest.id,
      compiled.manifest.manifest.version
    );
    if (existingDigest === aggregatePublishCompiled.manifest.digest) {
      compiled = aggregatePublishCompiled;
    } else if (!existingDigest) {
      compiled = aggregatePublishCompiled;
    }
  }
  if (compiled.manifest.manifest.requires.capabilities.includes(FOR_EACH_UNIT_CAPABILITY) && !requested.hasExecutionPlan) {
    throw new Error(`graph ${graphId} requires a canonical ${EXECUTION_PLAN_SCHEMA_V2} block`);
  }
  if (compiled.manifest.manifest.requires.capabilities.includes(FOR_EACH_UNIT_CAPABILITY) && requested.executionPlan) {
    assertStructuredPlanLoopEnvelopeBound(requested.executionPlan, {
      manifest: compiled.manifest,
      selectedAgent,
    });
  }
  try {
    validatePipelineManifest(compiled.manifest.manifest, {
      source: compileSource,
      runtime: runtime.descriptor,
    });
  } catch (error) {
    if (compiled.manifest.manifest.requires.capabilities.includes(FOR_EACH_UNIT_CAPABILITY)) {
      throw new Error(`graph ${graphId} requires unavailable runtime capability ${FOR_EACH_UNIT_CAPABILITY}`);
    }
    throw error;
  }
  if (source.ref === "core/simple@1") {
    return resolvePipelineReference(catalog, "core/implement@4");
  }
  return compiled.manifest;
}
// A `branch › <name>` label (also `branch >`, `branch:`, `branch/`) targets a
// per-task base branch, overriding the route's default. The branch itself may
// contain slashes, so everything after the first separator is the branch name.
function baseBranchFromLabels(labels: string[]): string | undefined {
  for (const label of labels) {
    const match = label.trim().match(/^branch\s*(?:›|>|:|\/)\s*(.+)$/i);
    const branch = match?.[1]?.trim();
    if (branch) return branch;
  }
  return undefined;
}

function isSafeBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@") return false;
  if (/^[./-]|[/.]$/.test(value)) return false;
  if (/\.\.|@\{|\/\/|[~^:?*\[\\\s]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function repositoryFor(
  store: SupervisorStore,
  thread: { provider: ControlThreadEvent["provider"]; route?: { id?: string; key?: string } }
): { repo: string; baseBranch: string } | undefined {
  const registered = store.getRepositoryRegistration(
    thread.route?.id,
    thread.route?.key,
    thread.provider
  );
  return registered
    ? { repo: registered.github_repo, baseBranch: registered.base_branch }
    : undefined;
}

export async function handleCreated(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: ControlThreadEvent,
  coordinator: PipelineCoordinatorContext,
  preflight?: AdmissionPreflight
): Promise<void> {
  const issue = payload.agentSession.thread;
  const sessionId = payload.agentSession.id;
  if (!issue) {
    await providers.activityPublisher.publishError(sessionId, undefined, "OpenThrottle could not find an issue on this agent session.");
    return;
  }
  const initialContext = linearContext(
    payload,
    `# ${issue.identifier}\n\nNo Linear prompt context was supplied for this delegation.`
  );
  const hasSuppliedPromptContext = Boolean(payload.promptContext?.trim());
  const labels = extractLabelNames(payload);
  const ticketId = controlTicketId(issue.provider, issue.id);
  const existing = store.getByExternalThread(issue.provider, issue.id) ?? store.getByIssueId(ticketId);
  const admissionMaintenance = store.getAdmissionMaintenanceState();
  if (admissionMaintenance.paused) {
    throw admissionMaintenanceError(
      `admission maintenance is paused${admissionMaintenance.reason ? `: ${admissionMaintenance.reason}` : ""}`
    );
  }
  await providers.activityPublisher.publishActivity({
    sessionId,
    type: "thought",
    body: "Spinning up a workspace…",
    ephemeral: true,
  });
  const existingSessionInstance = coordinator.store.getInstanceForSession(sessionId);
  if (existingSessionInstance) {
    if (existingSessionInstance.ticket_id !== ticketId) {
      throw new Error(`pipeline session ${sessionId} has an invalid issue binding`);
    }
    if (payload.providerActivationAdvances && payload.providerActivationId &&
        payload.providerActivatedAt) {
      const advanced = store.advanceSessionProviderActivation(
        sessionId,
        payload.providerActivationPreviousId ?? null,
        payload.providerActivatedAt,
        payload.providerActivationId
      );
      if (!advanced) {
        throw new Error("provider activation cursor changed before it could advance atomically");
      }
    }
    return;
  }
  // Engine selection must derive from the issue's labels as they stand right
  // now, not from the delegation event payload's label snapshot: a label
  // applied after (or even shortly before) the event fires can otherwise be
  // silently ignored (OPE-82/OPE-119). Fail closed -- never fall back to the
  // default engine while a label might exist unseen.
  let resolvedLabels: ResolvedControlLabel[];
  try {
    resolvedLabels = await providers.labelResolver.fetchThreadLabels(issue.id);
  } catch (error) {
    await providers.activityPublisher.publishError(
      sessionId,
      ticketId,
      `OpenThrottle could not read ${issue.identifier}'s current Linear labels: ${String(error)}. ` +
      "Engine selection requires a fresh label read, so no sandbox was provisioned. Try again."
    );
    return;
  }
  const resolvedMatchNames = labelMatchNames(resolvedLabels);
  const baseChildren = new Set(
    resolvedLabels
      .filter(
        (label) =>
          label.parentName && baseBranchFromLabels([`${label.parentName} › ${label.name}`])
      )
      .map((label) => label.name)
  );
  const routingLabels = baseChildren.size > 0 ? labels.filter((name) => !baseChildren.has(name)) : labels;
  const requestedBase = baseBranchFromLabels(labels) ?? baseBranchFromLabels(resolvedMatchNames);
  console.log(
    `[base-label] ${issue.identifier}: resolved=${JSON.stringify(
      resolvedMatchNames
    )} base=${requestedBase ?? "(route default)"}`
  );
  // DEFAULT_AGENT applies whenever the issue carries no agent label (see
  // supervisor/README.md), including on regeneration -- an engine pinned by
  // a label that has since been removed must not stick around as a fallback.
  const selectedAgent = pickAgent(resolvedMatchNames, cfg.defaultAgent);
  const selectedRepository = repositoryFor(store, issue);
  if (!selectedRepository) {
    await providers.activityPublisher.publishError(
      sessionId,
      ticketId,
      `No repository is registered for ${issue.provider} route ${issue.route?.key ?? issue.route?.id ?? "unknown"}. Run \`openthrottle init\` in the target repository first.`
    );
    return;
  }
  if (requestedBase) {
    if (!isSafeBranchName(requestedBase)) {
      await providers.activityPublisher.publishError(
        sessionId,
        ticketId,
        `The \`branch\` label value \`${requestedBase}\` is not a valid Git branch name.`
      );
      return;
    }
    let baseExists: boolean;
    try {
      baseExists = await providers.repositoryReader.branchExists(
        selectedRepository.repo,
        requestedBase
      );
    } catch (error) {
      await providers.activityPublisher.publishError(
        sessionId,
        ticketId,
        `OpenThrottle could not verify base branch \`${requestedBase}\` on ${selectedRepository.repo}: ${String(error)}`
      );
      return;
    }
    if (!baseExists) {
      await providers.activityPublisher.publishError(
        sessionId,
        ticketId,
        `Base branch \`${requestedBase}\` does not exist on ${selectedRepository.repo}.`
      );
      return;
    }
    selectedRepository.baseBranch = requestedBase;
  }
  const normalizedRoutingLabels = new Set(routingLabels.map((label) => label.trim().toLowerCase()));
  const taskType: TaskType = normalizedRoutingLabels.has("tune")
    ? "tune"
    : normalizedRoutingLabels.has("investigate")
      ? "investigate"
      : "implement";
  const ticketCore = {
    ticket_id: ticketId,
    ticket_reference: issue.identifier,
    session_id: sessionId,
    control_provider: issue.provider,
    external_thread_id: issue.id,
    external_thread_reference: issue.identifier,
    provider_activated_at: payload.providerActivatedAt,
    provider_activation_id: payload.providerActivationId,
    sandbox_id: null,
    branch: branchFor(issue.identifier, sessionId),
    agent: selectedAgent,
    repo: selectedRepository.repo,
    base_branch: selectedRepository.baseBranch,
    pr_url: null,
    state: "active" as const,
  };
  const failAdmission = async (rawMessage: string) => {
    const message = sanitizeText(rawMessage);
    if (!existing) {
      store.upsertUnpinned({ ...ticketCore, state: "error" });
      store.setState(ticketCore.ticket_id, "error", message);
    }
    await providers.activityPublisher.publishError(sessionId, ticketCore.ticket_id, message);
  };
  const failSelection = (error: unknown) =>
    failAdmission(`Pipeline selection failed before sandbox provisioning: ${String(error)}`);
  let pinned: {
    remote: RepositoryConfigSnapshot;
    manifest: ValidatedPipelineManifest;
    snapshot: ReturnType<PipelineStore["saveRepositoryConfigSnapshot"]>;
    taskContext: string;
    planDigest: string;
    inputArtifacts?: StageRequestInputArtifact[];
  };
  const boundedTaskContext = composeBoundedTaskContext(initialContext, {
    requireLinearSections: hasSuppliedPromptContext,
    expectedIssueIdentifier: issue.identifier,
  });
  try {
    if (boundedTaskContext.selectionError) {
      throw new Error(boundedTaskContext.selectionError);
    }
    const remote = await providers.repositoryReader.getRepositoryConfigAtCommit(
      selectedRepository.repo,
      selectedRepository.baseBranch
    );
    const repositoryConfig = parseRepositoryConfig(
      remote.content,
      `${selectedRepository.repo}@${remote.baseCommit}:.openthrottle.yml`
    );
    const requested = extractRequestedGraph(boundedTaskContext.selectionContext);
    if (taskType !== "implement" && requested.graphId) {
      throw new Error(`graph selection is not supported for ${taskType} tickets`);
    }
    const manifest = taskType === "implement"
      ? await resolvePipelineSelection(
        repositoryConfig,
        boundedTaskContext.selectionContext,
        (path) =>
          providers.repositoryReader.getRepositoryFileAtCommit(
            selectedRepository.repo,
            remote.baseCommit,
            path
        ),
        (path) =>
          providers.repositoryReader.getRepositoryDirectoryAtCommit(
            selectedRepository.repo,
            remote.baseCommit,
            path
        ),
        coordinator.runtime,
        coordinator.catalog,
        selectedAgent,
        cfg.taskTimeout,
        (pipelineId, version) => coordinator.store.getAcceptedManifestDigest(pipelineId, version)
      )
      : resolvePipelineReference(
        coordinator.catalog,
        repositoryConfig.config.pipelines?.[taskType] ?? taskType
      );
    // Fail closed here, before the repository snapshot, the capacity preflight,
    // the ticket row, and any Daytona provisioning: a generation whose engine
    // has no credential can only end as an opaque in-sandbox launch failure.
    const requiredAgents = pipelineInvokesModel(manifest)
      ? effectiveStructuredWorkerAgents(manifest, selectedAgent)
      : new Set<Agent>();
    const missingAgent = [...requiredAgents].find((agent) => !hasAgentSubscription(cfg, agent));
    if (missingAgent) {
      throw new Error(
        `${agentDisplayName(missingAgent)} is selected for this pipeline but its credential is not configured on the supervisor ` +
        `(set ${agentCredentialVariable(missingAgent)}). No sandbox was provisioned.`
      );
    }
    if (pipelineUsesOpenCodeLoopActions(manifest, selectedAgent)) {
      throw new Error("OpenCode structured loop actions are not supported yet. No sandbox was provisioned.");
    }
    if (boundedTaskContext.ordinaryLimitError) {
      throw new Error(boundedTaskContext.ordinaryLimitError);
    }
    const inputArtifacts = taskType === "implement"
      ? executionPlanInputArtifact(requested.executionPlan)
      : undefined;
    const taskContext = taskType === "tune"
      ? await sealTuneTaskContext({
        context: boundedTaskContext.selectionContext,
        ticketId,
        sessionId,
        repository: selectedRepository.repo,
        baseCommit: remote.baseCommit,
        baseBranch: selectedRepository.baseBranch,
        runtime: coordinator.runtime,
        corpus: coordinator.tuneCorpus ?? (() => {
          throw new Error("tune corpus sealing is not configured");
        })(),
        readPinnedFile: (path) => providers.repositoryReader.getRepositoryFileAtCommit(
          selectedRepository.repo,
          remote.baseCommit,
          path
        ),
      })
      : boundedTaskContext.context;
    const planDigest = requested.executionPlan
      ? digestCanonicalJson(requested.executionPlan)
      : digestNormalized(taskContext);
    const snapshot = coordinator.store.saveRepositoryConfigSnapshot({
      repository: selectedRepository.repo,
      baseCommit: remote.baseCommit,
      blobSha: remote.blobSha,
      config: repositoryConfig,
    });
    coordinator.store.acceptManifest(manifest);
    pinned = { remote, manifest, snapshot, taskContext, planDigest, inputArtifacts };
  } catch (error) {
    await failSelection(error);
    return;
  }
  if (preflight) {
    const verdict = await preflight({
      repository: selectedRepository.repo,
      baseCommit: pinned.remote.baseCommit,
    });
    if (!verdict.ok) {
      await failAdmission(verdict.reason);
      if (verdict.reason.startsWith("Daytona capacity:")) {
        coordinator.store.recordJournalEntry({
          issueId: ticketCore.ticket_id,
          actor: "supervisor",
          kind: "capacity_refused",
          trigger: "Admission preflight",
          action: "Refused delegation before sandbox provisioning because capacity was unavailable.",
          outcome: "refused",
          refs: {
            repository: selectedRepository.repo,
            base_commit: pinned.remote.baseCommit,
            reason: sanitizeText(verdict.reason).slice(0, 1_000),
          },
        });
      }
      return;
    }
  }
  try {
    store.upsert({
      ...ticketCore,
      pipeline: {
        admissionEpoch: admissionMaintenance.epoch,
        repository: selectedRepository.repo,
        baseCommit: pinned.remote.baseCommit,
        baseBranch: selectedRepository.baseBranch,
        manifest: pinned.manifest,
        repositoryConfig: pinned.snapshot,
        runtime: coordinator.runtime,
        authorizedCapabilities: pinned.manifest.manifest.requires.capabilities,
        planDigest: pinned.planDigest,
        taskType,
        taskContext: pinned.taskContext,
        inputArtifacts: pinned.inputArtifacts,
      },
    });
  } catch (error) {
    await failSelection(error);
    return;
  }
  if (boundedTaskContext.pruning) {
    coordinator.store.recordJournalEntry({
      issueId: ticketCore.ticket_id,
      actor: "supervisor",
      kind: "run_note",
      trigger: "Linear delegation admitted",
      action: "Pruned nonessential Linear prompt context before sealing the ordinary stage request.",
      outcome: "context_bounded",
      refs: {
        original_bytes: boundedTaskContext.pruning.originalBytes,
        bounded_bytes: boundedTaskContext.pruning.boundedBytes,
        limit_bytes: ORDINARY_STAGE_TASK_CONTEXT_LIMIT,
        dropped_other_threads: boundedTaskContext.pruning.droppedOtherThreads,
        dropped_parent_sections: boundedTaskContext.pruning.droppedParentSections,
        summarized_parent_sections: boundedTaskContext.pruning.summarizedParentSections,
      },
    });
  }
  await providers.activityPublisher.publishActivity({
    sessionId,
    type: "thought",
    body: `Pinned pipeline ${pinned.manifest.manifest.id}@${pinned.manifest.manifest.version} (${pinned.manifest.digest.slice(0, 12)}) at base ${pinned.remote.baseCommit.slice(0, 12)}. The durable coordinator will dispatch its first stage.`,
  }, ticketCore.ticket_id);
  await coordinator.drainEffects?.();
}
