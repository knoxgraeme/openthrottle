import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";
import { canonicalJson, digestNormalized, parseExecutionPlanContract, parseGraphContract } from "@openthrottle/contracts";
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
import type { RepositorySkillPackage } from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import type { PipelineCoordinatorContext, SessionServicePorts } from "./session-service.js";

const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";
const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;
const BUILTIN_SIMPLE_GRAPH = fileURLToPath(new URL("../../graphs/simple-v1.json", import.meta.url));
const BUILTIN_STRUCTURED_GRAPH = fileURLToPath(new URL("../../graphs/structured-v1.json", import.meta.url));
const SIMPLE_IMPLEMENT_DESCRIPTION = "Staged CE implementation from a pre-approved plan with round-based repair budgeting, scoped repair re-entry, sealed repository gates, exact-tree publication, and bounded provider repair. The initial forward pass may simplify; repair passes re-run semantic review and command gates without re-running simplification.";
const REPOSITORY_SKILL_PACKAGE_SCHEMA = "openthrottle.repository-skill-package/v1";

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

function pickAgent(labels: string[], defaultAgent: Agent): Agent {
  if (labels.includes("agent:opencode")) return "opencode";
  if (labels.includes("agent:codex")) return "codex";
  if (labels.includes("agent:claude")) return "claude";
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

function extractJsonBlocks(markdown: string, schema: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(FENCE_PATTERN)) {
    const marker = match[1]?.trim().split(/\s+/) ?? [];
    if (!marker.includes(schema)) continue;
    blocks.push(match[2]?.trim() ?? "");
  }
  return blocks;
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

function extractExecutionPlanGraphId(context: string): string | undefined {
  const blocks = extractJsonBlocks(context, EXECUTION_PLAN_FENCE);
  if (blocks.length === 0) return undefined;
  if (blocks.length > 1) throw new Error(`expected at most one ${EXECUTION_PLAN_FENCE} block, found ${blocks.length}`);
  return parseExecutionPlanContract(blocks[0]!, { source: "issue.execution_plan" }).value.graph_id;
}

function extractRequestedGraph(context: string): {
  graphId?: string;
  hasExecutionPlan: boolean;
} {
  const selected = extractShipSelectionGraphId(context);
  const planned = extractExecutionPlanGraphId(context);
  if (selected && planned && selected !== planned) {
    throw new Error(`ship selection graph_id ${selected} does not match execution_plan.graph_id ${planned}`);
  }
  return { graphId: selected ?? planned, hasExecutionPlan: planned !== undefined };
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
  return name === invocation || name.replace(/-/g, "_") === invocation.replace(/-/g, "_");
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
  catalog: ValidatedPipelineCatalog
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
  let routingLabels = labels;
  let requestedBase = baseBranchFromLabels(labels);
  if (!requestedBase) {
    try {
      const resolved = await providers.labelResolver.fetchIssueLabels(issue.id);
      const resolvedMatchNames = labelMatchNames(resolved);
      requestedBase = baseBranchFromLabels(resolvedMatchNames);
      const baseChildren = new Set(
        resolved
          .filter(
            (label) =>
              label.parentName && baseBranchFromLabels([`${label.parentName} › ${label.name}`])
          )
          .map((label) => label.name)
      );
      if (baseChildren.size > 0) {
        routingLabels = labels.filter((name) => !baseChildren.has(name));
      }
      console.log(
        `[base-label] ${issue.identifier}: resolved=${JSON.stringify(
          resolvedMatchNames
        )} base=${requestedBase ?? "(route default)"}`
      );
    } catch (error) {
      console.warn(
        `[base-label] grouped-label lookup failed for ${issue.identifier}: ${String(error)}`
      );
    }
  }
  const selectedAgent = pickAgent(routingLabels, existing?.agent ?? cfg.defaultAgent);
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
        coordinator.catalog
      )
      : resolvePipelineReference(
        coordinator.catalog,
        repositoryConfig.config.pipelines?.[taskType] ?? taskType
      );
    const needsModel = manifest.manifest.stages.some((stage) =>
      stage.credentials.includes("model.invoke")
    );
    if (needsModel && !hasAgentSubscription(cfg, selectedAgent)) {
      throw new Error(`${agentDisplayName(selectedAgent)} subscription login is not configured for this pipeline`);
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
        taskContext: sanitizeText(initialContext).slice(0, 64_000),
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
