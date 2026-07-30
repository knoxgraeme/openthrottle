import type { Config } from "./config.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";
import { parseExecutionPlanContract, parseGraphContract } from "@openthrottle/contracts";
import type {
  LinearAgentSessionEvent,
  RepositoryConfigSnapshot,
  ResolvedLinearLabel,
} from "./ports.js";
import {
  parseRepositoryConfig,
  resolvePipelineReference,
} from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import { sanitizeText } from "../shared/sanitize.js";
import type { AdmissionPreflight } from "./admission-preflight.js";
import type { PipelineCoordinatorContext, SessionServicePorts } from "./session-service.js";

const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const SHIP_SELECTION_FENCE = "openthrottle.ship-selection/v1";
const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g;

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

async function resolvePipelineSelection(
  repositoryConfig: ReturnType<typeof parseRepositoryConfig>,
  taskType: TaskType,
  context: string,
  readPinnedFile: (path: string) => Promise<string>
): Promise<string> {
  if (taskType !== "implement") {
    const requested = extractRequestedGraph(context);
    if (requested.graphId) {
      throw new Error(`graph selection is not supported for ${taskType} tickets`);
    }
    return repositoryConfig.config.pipelines?.[taskType] ?? taskType;
  }
  const intent = repositoryConfig.config.intents?.implement;
  const requested = extractRequestedGraph(context);
  const graphId = requested.graphId ?? intent?.default_graph ?? repositoryConfig.config.default_graph;
  const allowedGraphs = intent?.allowed_graphs ?? [repositoryConfig.config.default_graph];
  if (!allowedGraphs.includes(graphId)) {
    throw new Error(`graph ${graphId} is not allowed for implement; allowed: ${allowedGraphs.join(", ")}`);
  }
  const source = repositoryConfig.config.graphs.find((entry) => entry.id === graphId);
  if (!source) throw new Error(`graph ${graphId} is not declared in repository config`);
  const isBuiltinSimple = source.kind === "builtin" && source.ref === "core/simple@1";
  let consumesUnits = !isBuiltinSimple;
  if (source.kind === "repository") {
    const raw = await readPinnedFile(source.ref);
    const graph = parseGraphContract(raw, {
      source: `repository graph ${source.ref}`,
      config: repositoryConfig.config,
    });
    consumesUnits =
      graph.value.nodes.some((node) => node.kind === "for_each_unit") ||
      graph.value.loops.some((loop) => loop.input_scope === "unit");
  }
  if (consumesUnits && !requested.hasExecutionPlan) {
    throw new Error(`graph ${graphId} requires a canonical ${EXECUTION_PLAN_FENCE} block`);
  }
  const graphOverride = repositoryConfig.config.pipelines?.[graphId];
  if (graphOverride) return graphOverride;
  if (isBuiltinSimple) {
    return repositoryConfig.config.pipelines?.[taskType] ?? taskType;
  }
  return source.ref;
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
    manifest: ReturnType<typeof resolvePipelineReference>;
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
    const reference = await resolvePipelineSelection(
      repositoryConfig,
      taskType,
      initialContext,
      async (path) =>
        (
          await providers.repositoryReader.getRepositoryFileAtCommit(
            selectedRepository.repo,
            remote.baseCommit,
            path
          )
        ).content
    );
    const manifest = resolvePipelineReference(coordinator.catalog, reference);
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
