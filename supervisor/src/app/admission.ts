import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";
import {
  canonicalJson,
  digestNormalized,
  parseExecutionPlanContract,
  parseGraphContract,
  type ExecutionPlanContract,
} from "@openthrottle/contracts";
import type {
  LinearAgentSessionEvent,
  RepositoryDirectorySnapshot,
  RepositoryFileSnapshot,
  RepositoryConfigSnapshot,
  ResolvedLinearLabel,
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
import { extractJsonBlocks } from "../pipeline/markdown.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import type { PipelineCoordinatorContext, SessionServicePorts } from "./session-service.js";

const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";
const BUILTIN_SIMPLE_GRAPH = fileURLToPath(new URL("../../graphs/simple-v1.json", import.meta.url));
const BUILTIN_STRUCTURED_GRAPH = fileURLToPath(new URL("../../graphs/structured-v1.json", import.meta.url));
const SIMPLE_IMPLEMENT_DESCRIPTION = "Staged CE implementation from a pre-approved plan with round-based repair budgeting, scoped repair re-entry, sealed repository gates, exact-tree publication, and bounded provider repair. The initial forward pass may simplify; repair passes re-run semantic review and command gates without re-running simplification.";
const REPOSITORY_SKILL_PACKAGE_SCHEMA = "openthrottle.repository-skill-package/v1";
const ORDINARY_STAGE_TASK_CONTEXT_LIMIT = 64_000;

function linearContext(
  payload: LinearAgentSessionEvent,
  fallback: string
): string {
  return payload.promptContext?.trim() || fallback;
}

function extractLabelNames(payload: LinearAgentSessionEvent): string[] {
  const labels = payload.agentSession.issue?.labels;
  if (Array.isArray(labels)) return labels.map((label) => label.name);
  return labels?.nodes?.map((label) => label.name) ?? [];
}

function labelMatchNames(labels: ResolvedLinearLabel[]): string[] {
  const names: string[] = [];
  for (const label of labels) {
    names.push(label.name);
    if (label.parentName) names.push(`${label.parentName} › ${label.name}`);
  }
  return names;
}

function branchFor(issueIdentifier: string): string {
  return `ot/${issueIdentifier.toLowerCase()}`;
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

function manifestUsesCompositeRuntime(manifest: ValidatedPipelineManifest): boolean {
  return manifest.manifest.stages.some((stage) => stage.executor.kind === "loop_action");
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

function extractExecutionPlan(context: string): ExecutionPlanContract | undefined {
  const blocks = extractJsonBlocks(context, EXECUTION_PLAN_FENCE);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) throw new Error(`expected at most one ${EXECUTION_PLAN_FENCE} block, found ${blocks.length}`);
  return parseExecutionPlanContract(blocks[0]!, { source: "issue.execution_plan" }).value;
}

function extractRequestedGraph(context: string): {
  graphId?: string;
  hasExecutionPlan: boolean;
  executionPlan?: ExecutionPlanContract;
} {
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
  selectedAgent: Agent
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
    }))}`;
  } else if (source.ref === "core/simple@1") {
    rawGraph = readFileSync(BUILTIN_SIMPLE_GRAPH, "utf8");
    compileSource = "builtin:core/simple@1";
    blobDescription = "builtin core/simple@1";
  } else if (source.ref === "core/structured@1") {
    rawGraph = readFileSync(BUILTIN_STRUCTURED_GRAPH, "utf8");
    compileSource = "builtin:core/structured@1";
    blobDescription = "builtin core/structured@1";
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
  const compileOptions = {
    source: compileSource,
    ...(source.kind === "repository" ? { config: repositoryConfig.config } : {}),
    ...(repositorySkills === undefined ? {} : { repositorySkills }),
    ...(source.ref === "core/simple@1" ? {
      id: "core/implement",
      version: 4,
      description: SIMPLE_IMPLEMENT_DESCRIPTION,
      maxAttempts: 200,
      maxRepairRounds: 5,
    } : {
      id: source.kind === "builtin" ? `builtin/${graphId}` : manifestId,
      description: `Compiled execution graph ${graphId} from ${blobDescription}.`,
      maxAttempts: 200,
    }),
  };
  const compiled = parseAndCompileExecutionGraph(rawGraph, compileOptions);
  if (compiled.manifest.manifest.requires.capabilities.includes(FOR_EACH_UNIT_CAPABILITY) && !requested.hasExecutionPlan) {
    throw new Error(`graph ${graphId} requires a canonical ${EXECUTION_PLAN_FENCE} block`);
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
  issue: { team?: { id?: string; key?: string } }
): { repo: string; baseBranch: string } | undefined {
  const registered = store.getRepositoryRegistration(issue.team?.id, issue.team?.key);
  return registered
    ? { repo: registered.github_repo, baseBranch: registered.base_branch }
    : undefined;
}

export async function handleCreated(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: LinearAgentSessionEvent,
  coordinator: PipelineCoordinatorContext,
  preflight?: AdmissionPreflight
): Promise<void> {
  const issue = payload.agentSession.issue;
  const sessionId = payload.agentSession.id;
  if (!issue) {
    await providers.activityPublisher.publishError(sessionId, undefined, "OpenThrottle could not find an issue on this agent session.");
    return;
  }
  const initialContext = linearContext(
    payload,
    `# ${issue.identifier}\n\nNo Linear prompt context was supplied for this delegation.`
  );
  await providers.activityPublisher.publishActivity({
    sessionId,
    type: "thought",
    body: "Spinning up a workspace…",
    ephemeral: true,
  });

  const labels = extractLabelNames(payload);
  const existing = store.getByIssueId(issue.id);
  const existingSessionInstance = coordinator.store.getInstanceForSession(sessionId);
  if (existingSessionInstance) {
    if (existingSessionInstance.linear_issue_id !== issue.id) {
      throw new Error(`pipeline session ${sessionId} has an invalid issue binding`);
    }
    return;
  }
  // Engine selection must derive from the issue's labels as they stand right
  // now, not from the delegation event payload's label snapshot: a label
  // applied after (or even shortly before) the event fires can otherwise be
  // silently ignored (OPE-82/OPE-119). Fail closed -- never fall back to the
  // default engine while a label might exist unseen.
  let resolvedLabels: ResolvedLinearLabel[];
  try {
    resolvedLabels = await providers.labelResolver.fetchIssueLabels(issue.id);
  } catch (error) {
    await providers.activityPublisher.publishError(
      sessionId,
      issue.id,
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
  const selectedAgent = pickAgent(resolvedMatchNames, existing?.agent ?? cfg.defaultAgent);
  const selectedRepository = repositoryFor(store, issue);
  if (!selectedRepository) {
    await providers.activityPublisher.publishError(
      sessionId,
      issue.id,
      `No repository is registered for Linear team ${issue.team?.key ?? issue.team?.id ?? "unknown"}. Run \`openthrottle init\` in the target repository first.`
    );
    return;
  }
  if (requestedBase) {
    if (!isSafeBranchName(requestedBase)) {
      await providers.activityPublisher.publishError(
        sessionId,
        issue.id,
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
        issue.id,
        `OpenThrottle could not verify base branch \`${requestedBase}\` on ${selectedRepository.repo}: ${String(error)}`
      );
      return;
    }
    if (!baseExists) {
      await providers.activityPublisher.publishError(
        sessionId,
        issue.id,
        `Base branch \`${requestedBase}\` does not exist on ${selectedRepository.repo}.`
      );
      return;
    }
    selectedRepository.baseBranch = requestedBase;
  }
  const taskType: TaskType = routingLabels.includes("investigate") ? "investigate" : "implement";
  const ticketCore = {
    linear_issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
    linear_session_id: sessionId,
    sandbox_id: null,
    branch: branchFor(issue.identifier),
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
      store.setState(issue.id, "error", message);
    }
    await providers.activityPublisher.publishError(sessionId, issue.id, message);
  };
  const failSelection = (error: unknown) =>
    failAdmission(`Pipeline selection failed before sandbox provisioning: ${String(error)}`);
  let pinned: {
    remote: RepositoryConfigSnapshot;
    manifest: ValidatedPipelineManifest;
    snapshot: ReturnType<PipelineStore["saveRepositoryConfigSnapshot"]>;
  };
  try {
    const remote = await providers.repositoryReader.getRepositoryConfigAtCommit(
      selectedRepository.repo,
      selectedRepository.baseBranch
    );
    const repositoryConfig = parseRepositoryConfig(
      remote.content,
      `${selectedRepository.repo}@${remote.baseCommit}:.openthrottle.yml`
    );
    const requested = extractRequestedGraph(initialContext);
    if (taskType !== "implement" && requested.graphId) {
      throw new Error(`graph selection is not supported for ${taskType} tickets`);
    }
    const manifest = taskType === "implement"
      ? await resolvePipelineSelection(
        repositoryConfig,
        initialContext,
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
        selectedAgent
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
    if (!manifestUsesCompositeRuntime(manifest) &&
        Buffer.byteLength(sanitizeText(initialContext), "utf8") > ORDINARY_STAGE_TASK_CONTEXT_LIMIT) {
      throw new Error(
        `Task context exceeds ${ORDINARY_STAGE_TASK_CONTEXT_LIMIT} bytes for an ordinary stage pipeline. ` +
        "No sandbox was provisioned."
      );
    }
    const snapshot = coordinator.store.saveRepositoryConfigSnapshot({
      repository: selectedRepository.repo,
      baseCommit: remote.baseCommit,
      blobSha: remote.blobSha,
      config: repositoryConfig,
    });
    coordinator.store.acceptManifest(manifest);
    pinned = { remote, manifest, snapshot };
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
          issueId: issue.id,
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
        repository: selectedRepository.repo,
        baseCommit: pinned.remote.baseCommit,
        baseBranch: selectedRepository.baseBranch,
        manifest: pinned.manifest,
        repositoryConfig: pinned.snapshot,
        runtime: coordinator.runtime,
        authorizedCapabilities: pinned.manifest.manifest.requires.capabilities,
        taskType,
        taskContext: sanitizeText(initialContext),
      },
    });
  } catch (error) {
    await failSelection(error);
    return;
  }
  await providers.activityPublisher.publishActivity({
    sessionId,
    type: "thought",
    body: `Pinned pipeline ${pinned.manifest.manifest.id}@${pinned.manifest.manifest.version} (${pinned.manifest.digest.slice(0, 12)}) at base ${pinned.remote.baseCommit.slice(0, 12)}. The durable coordinator will dispatch its first stage.`,
  }, issue.id);
  await coordinator.drainEffects?.();
}
