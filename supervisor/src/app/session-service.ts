// Linear admission and operator-thread control for the durable pipeline
// coordinator. Every delegated session is pinned to an immutable manifest;
// there is no direct task launcher fallback.

import type { Config } from "./config.js";
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import type { Agent, TaskType } from "../pipeline/types.js";
import type {
  ActivityPublicationPort,
  LinearAgentSessionEvent,
  LinearLabelPort,
  MergePort,
  RepositoryReadPort,
  RepositoryConfigSnapshot,
  ResolvedLinearLabel,
} from "./ports.js";
import {
  parseRepositoryConfig,
  resolvePipelineReference,
  type ValidatedPipelineCatalog,
} from "../pipeline/manifest.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "../runtime/contracts.js";
import { sanitizeText } from "../shared/sanitize.js";
import { parseCommand } from "./commands.js";
import { canSteerPipelineRun, requestPipelineStop } from "../pipeline/control.js";
import type { AdmissionPreflight } from "../admission-preflight.js";

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

export async function handleLinearEvent(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: LinearAgentSessionEvent,
  coordinator: PipelineCoordinatorContext,
  preflight?: AdmissionPreflight
): Promise<void> {
  if (payload.action === "created") {
    await handleCreated(cfg, store, providers, payload, coordinator, preflight);
  } else {
    await handlePrompted(cfg, store, providers, payload, coordinator);
  }
}

export interface SessionServicePorts {
  activityPublisher: ActivityPublicationPort;
  labelResolver: LinearLabelPort;
  repositoryReader: RepositoryReadPort;
  merger: MergePort;
}

export interface PipelineCoordinatorContext {
  catalog: ValidatedPipelineCatalog;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  store: PipelineStore;
  drainEffects?: () => Promise<void>;
}

async function handleCreated(
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
    store.setLinearContext(issue.id, initialContext);
    return;
  }
  // A `branch` label targets a per-task base branch for this ticket, overriding
  // the route's default. It is a flat `branch › <name>` label (matched straight
  // from the webhook, no extra call) or a Linear label group named `branch` whose
  // child is the branch name — the webhook carries only the child's leaf name, so
  // grouped labels are resolved with their parent group via GraphQL. A `branch`
  // label is a base-branch directive, not a routing label, so grouped `branch`
  // children (which arrive as bare leaves) are dropped from the label set that
  // drives repo/agent/task routing below; otherwise a child leaf could collide
  // with an agent/investigate label and
  // misroute the ticket. The branch itself is verified further down, once the
  // repository is resolved.
  let routingLabels = labels;
  let requestedBase = baseBranchFromLabels(labels);
  // The AgentSessionEvent webhook does not reliably embed the issue's labels
  // (grouped labels in particular), so whenever no flat `branch ›` label matched
  // we resolve the issue's labels from Linear rather than gating on the
  // webhook-provided list. Gating on `labels.length` silently missed a grouped
  // `branch` label whenever the webhook carried no labels, falling back to the
  // route default.
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
      // Diagnostic: record what Linear returned and the chosen base so a
      // mislabeled group (or an empty result) is visible in the supervisor logs.
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
  // Verify the resolved base branch now that the repository is known, so a typo
  // surfaces as a clean Linear message instead of a clone failure in the sandbox.
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
    // A failed admission must not supersede the currently pinned generation.
    if (!existing) {
      store.upsertUnpinned({ ...ticketCore, state: "error" });
      store.setState(issue.id, "error", message);
      store.setLinearContext(issue.id, initialContext);
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
    const reference = repositoryConfig.config.pipelines?.[taskType] ?? taskType;
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
  // Preflight after the selection is pinned but before any pipeline instance
  // or sandbox exists: a rejection here surfaces as a clean Linear error
  // instead of a silent in-sandbox clone failure or opaque provisioning churn.
  if (preflight) {
    const verdict = await preflight({
      repository: selectedRepository.repo,
      baseCommit: pinned.remote.baseCommit,
    });
    if (!verdict.ok) {
      await failAdmission(verdict.reason);
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
  store.setLinearContext(issue.id, initialContext);
  await providers.activityPublisher.publishActivity({
    sessionId,
    type: "thought",
    body: `Pinned pipeline ${pinned.manifest.manifest.id}@${pinned.manifest.manifest.version} (${pinned.manifest.digest.slice(0, 12)}) at base ${pinned.remote.baseCommit.slice(0, 12)}. The durable coordinator will dispatch its first stage.`,
  }, issue.id);
  await coordinator.drainEffects?.();
}

async function handlePrompted(
  cfg: Config,
  store: SupervisorStore,
  providers: SessionServicePorts,
  payload: LinearAgentSessionEvent,
  coordinator: PipelineCoordinatorContext
): Promise<void> {
  const sessionId = payload.agentSession.id;
  const issue = payload.agentSession.issue;
  const promptBody =
    payload.agentActivity?.content?.body ?? payload.agentActivity?.body ?? "";
  const ticket = issue
    ? store.getByIssueId(issue.id)
    : store.listAll().find((candidate) => candidate.linear_session_id === sessionId);
  if (!ticket) {
    await providers.activityPublisher.publishError(
      sessionId,
      issue?.id,
      "OpenThrottle couldn't find an existing workspace. Delegate the issue again to start one."
    );
    return;
  }

  const command = parseCommand(promptBody);
  const pipelineInstance = coordinator.store.getInstanceForSession(sessionId);
  // The native Linear `signal: "stop"` control signal is checked directly
  // here (it's not a chat command); a textual "/stop" is handled by
  // parseCommand alongside /merge.
  const isStop = payload.agentActivity?.signal?.toLowerCase() === "stop" || command.kind === "stop";
  if (isStop) {
    if (!pipelineInstance) {
      await providers.activityPublisher.publishError(
        sessionId,
        ticket.linear_issue_id,
        "OpenThrottle couldn't find a pipeline for this session. Delegate the issue again to start one."
      );
      return;
    }
    requestPipelineStop({
      store: coordinator.store,
      sessionId,
      eventId: `linear-stop:${pipelineInstance.id}:${payload.agentActivity?.id ?? "signal"}`,
      reason: "Stopped from the Linear thread.",
    });
    await coordinator.drainEffects?.();
    return;
  }

  if (command.kind === "merge") {
    await mergeFromLinear(cfg, providers, ticket);
    return;
  }

  const workId = payload.agentActivity?.id;
  if (
    pipelineInstance &&
    command.kind === "reply" &&
    workId &&
    canSteerPipelineRun({
      store: coordinator.store,
      sessionId,
      runId: ticket.run_id,
      agent: ticket.agent,
    })
  ) {
    store.enqueueInbox({
      id: workId,
      issueId: ticket.linear_issue_id,
      sessionId,
      runId: ticket.run_id,
      source: "human",
      body: sanitizeText(promptBody),
    });
    await providers.activityPublisher.publishActivity({
      sessionId,
      type: "thought",
      body: "Steering the current pipeline stage with your message…",
      ephemeral: true,
    }, ticket.linear_issue_id);
    return;
  }
  if (!pipelineInstance) {
    await providers.activityPublisher.publishError(
      sessionId,
      ticket.linear_issue_id,
      "OpenThrottle couldn't find a pipeline for this session. Delegate the issue again to start one."
    );
    return;
  }
  await providers.activityPublisher.publishError(
    sessionId,
    ticket.linear_issue_id,
    "The current pipeline stage does not accept live steering. Add feedback to the pull request, or re-delegate the issue to create a new generation."
  );
}

async function mergeFromLinear(
  cfg: Config,
  providers: SessionServicePorts,
  ticket: Ticket
): Promise<void> {
  if (!cfg.allowLinearMerge) {
    await providers.activityPublisher.publishActivity({
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "Linear merge is disabled. Merge from GitHub, or set ALLOW_LINEAR_MERGE=true.",
    }, ticket.linear_issue_id);
    return;
  }
  if (!ticket.pr_url) {
    await providers.activityPublisher.publishError(ticket.linear_session_id, ticket.linear_issue_id, "This ticket has no pull request to merge.");
    return;
  }
  const pull = providers.merger.parsePullRequestUrl(ticket.pr_url);
  const readiness = await providers.merger.getMergeReadiness(pull.repo, pull.number);
  if (readiness.draft || !readiness.mergeable || !readiness.checksPresent || !readiness.checksGreen) {
    await providers.activityPublisher.publishActivity({
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "The PR is not merge-ready: it must be non-draft, mergeable, and have terminal green checks.",
    }, ticket.linear_issue_id);
    return;
  }
  const result = await providers.merger.mergePullRequest(pull.repo, pull.number, readiness.headSha);
  await providers.activityPublisher.publishActivity({
    sessionId: ticket.linear_session_id,
    type: result.merged ? "response" : "error",
    body: result.merged ? `Merged ${ticket.pr_url}.` : `GitHub did not merge the PR: ${result.message}`,
  }, ticket.linear_issue_id);
}
