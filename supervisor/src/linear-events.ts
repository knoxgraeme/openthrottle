// Phase 2 item 3: Linear event handling — creating a ticket/sandbox for a new
// agent session and continuing an existing one from a human reply. Split out
// of server.ts.

import { randomBytes } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { TaskType, Ticket, TicketStore } from "./db.js";
import {
  extractLabelNames,
  fetchIssueLabels,
  labelMatchNames,
  parseLinearWebhook,
  type LinearClient,
} from "./linear.js";
import {
  branchExists,
  getRepositoryConfigAtCommit,
  getMergeReadiness,
  mergePullRequest,
  parsePullRequestUrl,
  type GithubClient,
} from "./github.js";
import {
  parseRepositoryConfig,
  resolvePipelineReference,
  type ValidatedPipelineCatalog,
} from "./pipeline-manifest.js";
import type { PipelineStore } from "./pipeline-store.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "./sandbox-runtime.js";
import {
  createForTicket,
  deleteSandbox,
  findSandboxForTicket,
  startTask,
  stopSandbox,
} from "./daytona.js";
import {
  agentDisplayName,
  baseSandboxEnv,
  beginRun,
  hasAgentSubscription,
  launchExistingTask,
  pickAgent,
  scheduleSandboxSettlement,
  tokenHash,
} from "./run-lifecycle.js";
import {
  enqueueActivity,
  enqueueSessionUpdate,
  tryPostError,
  type LinearOutboxProcessor,
} from "./linear-outbox.js";
import { getCodexAuthForSeed } from "./codex-auth.js";
import { sanitizeText } from "./sanitize.js";
import { parseCommand } from "./commands.js";
import { stopTicket } from "./ticket-control.js";
import { selectExecutionMode } from "./scheduler.js";
import { canSteerPipelineRun, requestPipelineStop } from "./pipeline-control.js";

function linearContext(
  payload: ReturnType<typeof parseLinearWebhook>,
  fallback: string
): string {
  return payload.promptContext?.trim() || fallback;
}

function branchFor(issueIdentifier: string): string {
  return `ot/${issueIdentifier.toLowerCase()}`;
}

function repoLabelKeys(label: string): string[] {
  const trimmed = label.trim();
  const withoutPrefix = trimmed.replace(/^Repo\s*(?:›|>|:|\/)\s*/i, "").trim();
  return [...new Set([trimmed, withoutPrefix].filter(Boolean))];
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
  cfg: Config,
  store: TicketStore,
  issue: { team?: { id?: string; key?: string } },
  labels: string[] = []
): { repo: string; baseBranch: string } | undefined {
  for (const label of labels) {
    for (const key of repoLabelKeys(label)) {
      const byLabel = cfg.githubRepoLabelMappings[key];
      if (byLabel) return { repo: byLabel, baseBranch: cfg.baseBranch };
    }
  }
  const registered = store.getRepositoryRegistration(issue.team?.id, issue.team?.key);
  if (registered) {
    return { repo: registered.github_repo, baseBranch: registered.base_branch };
  }
  const byId = issue.team?.id ? cfg.githubRepoMappings[issue.team.id] : undefined;
  const byKey = issue.team?.key ? cfg.githubRepoMappings[issue.team.key] : undefined;
  const legacyMapped = byId ?? byKey;
  if (legacyMapped) return { repo: legacyMapped, baseBranch: cfg.baseBranch };
  if (store.hasRepositoryRegistrations()) return undefined;
  return { repo: cfg.githubRepo, baseBranch: cfg.baseBranch };
}

export async function handleLinearEvent(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  getLinearClient: () => Promise<LinearClient | undefined>,
  linearOutbox: LinearOutboxProcessor,
  payload: ReturnType<typeof parseLinearWebhook>,
  pipelineAdmission?: PipelineAdmissionContext
): Promise<void> {
  const linear = await getLinearClient();
  if (!linear) {
    throw new Error("No valid Linear OAuth token is stored");
  }
  if (payload.action === "created") {
    await handleCreated(cfg, store, daytona, linear, linearOutbox, payload, pipelineAdmission);
  } else {
    await handlePrompted(cfg, store, daytona, linear, linearOutbox, payload, pipelineAdmission);
  }
}

export interface PipelineAdmissionContext {
  catalog: ValidatedPipelineCatalog;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  store: PipelineStore;
  drainEffects?: () => Promise<void>;
}

async function handleCreated(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  linearOutbox: LinearOutboxProcessor,
  payload: ReturnType<typeof parseLinearWebhook>,
  pipelineAdmission?: PipelineAdmissionContext
): Promise<void> {
  const issue = payload.agentSession.issue;
  const sessionId = payload.agentSession.id;
  if (!issue) {
    await tryPostError(store, linearOutbox, sessionId, undefined, "OpenThrottle could not find an issue on this agent session.");
    return;
  }
  const initialContext = linearContext(
    payload,
    `# ${issue.identifier}\n\nNo Linear prompt context was supplied for this delegation.`
  );
  await enqueueActivity(store, linearOutbox, {
    sessionId,
    type: "thought",
    body: "Spinning up a workspace…",
    ephemeral: true,
  });

  const labels = extractLabelNames(payload);
  const existing = store.getByIssueId(issue.id);
  const pinnedMode = pipelineAdmission?.store.getSessionExecutionMode(sessionId);
  if (pinnedMode === "pipeline") {
    const pinned = pipelineAdmission?.store.getInstanceForSession(sessionId);
    if (!pinned || pinned.linear_issue_id !== issue.id) {
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
  // with a `GITHUB_REPO_LABEL_MAPPINGS` key or an agent/investigate label and
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
      const resolved = await fetchIssueLabels(linear, issue.id);
      requestedBase = baseBranchFromLabels(labelMatchNames(resolved));
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
          labelMatchNames(resolved)
        )} base=${requestedBase ?? "(route default)"}`
      );
    } catch (error) {
      console.warn(
        `[base-label] grouped-label lookup failed for ${issue.identifier}: ${String(error)}`
      );
    }
  }
  const selectedAgent = pickAgent(routingLabels, existing?.agent ?? cfg.defaultAgent);
  const selectedRepository = repositoryFor(cfg, store, issue, routingLabels);
  if (!selectedRepository) {
    await tryPostError(
      store,
      linearOutbox,
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
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        issue.id,
        `The \`branch\` label value \`${requestedBase}\` is not a valid Git branch name.`
      );
      return;
    }
    let baseExists: boolean;
    try {
      baseExists = await branchExists(
        { token: cfg.githubToken },
        selectedRepository.repo,
        requestedBase
      );
    } catch (error) {
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        issue.id,
        `OpenThrottle could not verify base branch \`${requestedBase}\` on ${selectedRepository.repo}: ${String(error)}`
      );
      return;
    }
    if (!baseExists) {
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        issue.id,
        `Base branch \`${requestedBase}\` does not exist on ${selectedRepository.repo}.`
      );
      return;
    }
    selectedRepository.baseBranch = requestedBase;
  }
  // The shipped supervisor always supplies the coordinator context. Keeping
  // the context-free path here lets embedded/unit callers finish their
  // historical fixtures without reintroducing a deploy-time admission flag.
  const executionMode = pipelineAdmission
    ? selectExecutionMode({ pinnedMode })
    : pinnedMode ?? "legacy";
  const existingMode = existing
    ? pipelineAdmission?.store.getSessionExecutionMode(existing.linear_session_id)
    : undefined;
  if (executionMode === "legacy" && !hasAgentSubscription(cfg, selectedAgent)) {
    await tryPostError(
      store,
      linearOutbox,
      sessionId,
      issue.id,
      `${agentDisplayName(selectedAgent)} subscription login is not configured for OpenThrottle.`
    );
    return;
  }
  const retireExistingWorkspace = async (): Promise<boolean> => {
    if (!existing?.sandbox_id || existing.state === "closed" || existing.state === "expired") {
      return true;
    }
    const priorPipeline = pipelineAdmission?.store.getInstanceForSession(existing.linear_session_id);
    await stopTicket({
      store,
      daytona,
      linear,
      linearOutbox,
      ticket: existing,
      reason: "Stopped because a new execution generation was delegated.",
    });
    const stopped = store.getByIssueId(issue.id);
    if (stopped?.run_id) {
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        issue.id,
        "The prior workspace could not be stopped safely. It remains quarantined; resolve it before re-delegating."
      );
      return false;
    }
    try {
      await deleteSandbox(daytona, existing.sandbox_id);
      store.setSandboxId(issue.id, null);
      if (priorPipeline && pipelineAdmission?.store.getRuntimeResource(priorPipeline.id)) {
        pipelineAdmission.store.setRuntimeResourceStatus(priorPipeline.id, "cleaned");
      }
    } catch (error) {
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        issue.id,
        sanitizeText(`The prior workspace stopped but could not be deleted before new-generation admission: ${String(error)}`)
      );
      return false;
    }
    return true;
  };
  if (executionMode === "legacy" && existingMode === "pipeline") {
    if (!(await retireExistingWorkspace())) return;
  }
  if (
    executionMode === "legacy" &&
    existingMode !== "pipeline" &&
    existing?.sandbox_id &&
    existing.state !== "closed" &&
    existing.state !== "expired"
  ) {
    const agentChanged = existing.agent !== selectedAgent;
    const repoChanged =
      existing.repo !== selectedRepository.repo ||
      existing.base_branch !== selectedRepository.baseBranch;
    if (repoChanged) {
      if (existing.run_id) {
        store.finishRun({
          runId: existing.run_id,
          status: "stopped",
          failureTail: `Repository route changed from ${existing.repo} to ${selectedRepository.repo}; starting a fresh workspace.`,
          ticketState: "active",
        });
      }
      try {
        await stopSandbox(daytona, existing.sandbox_id);
        await deleteSandbox(daytona, existing.sandbox_id);
      } catch (error) {
        const message = sanitizeText(
          `OpenThrottle resolved this ticket to ${selectedRepository.repo}, but could not delete the existing ${existing.repo} workspace: ${String(error)}`
        );
        await tryPostError(store, linearOutbox, sessionId, issue.id, message);
        return;
      }
    } else {
      store.upsert({
        ...existing,
        linear_session_id: sessionId,
        agent: selectedAgent,
        state: "active",
      });
      store.setLinearContext(issue.id, initialContext);
      const current = store.getByIssueId(issue.id)!;
      await launchExistingTask({
        cfg,
        store,
        daytona,
        linear,
        linearOutbox,
        ticket: current,
        taskType: routingLabels.includes("investigate")
          ? "investigate"
          : agentChanged
            ? "implement"
            : "resume",
        resumeMessage: agentChanged
          ? undefined
          : "This ticket was re-delegated. Re-read it and continue from the existing branch.",
        linearContext: initialContext,
      });
      return;
    }
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
  if (executionMode === "pipeline") {
    if (!pipelineAdmission) throw new Error("pipeline admission is enabled without a catalog/runtime context");
    const failSelection = async (error: unknown) => {
      const message = sanitizeText(`Pipeline selection failed before sandbox provisioning: ${String(error)}`);
      // Selection has not earned the right to supersede or detach a prior
      // generation. Keep that workspace/session binding intact so a corrected
      // replay can retire it safely after validation succeeds.
      if (!existing) {
        store.upsertUnpinned({ ...ticketCore, state: "error" });
      }
      store.setState(issue.id, "error", message);
      store.setLinearContext(issue.id, initialContext);
      await tryPostError(store, linearOutbox, sessionId, issue.id, message);
    };
    let pinned: {
      remote: Awaited<ReturnType<typeof getRepositoryConfigAtCommit>>;
      manifest: ReturnType<typeof resolvePipelineReference>;
      snapshot: ReturnType<PipelineStore["saveRepositoryConfigSnapshot"]>;
    };
    try {
      const remote = await getRepositoryConfigAtCommit(
        { token: cfg.githubToken },
        selectedRepository.repo,
        selectedRepository.baseBranch
      );
      const repositoryConfig = parseRepositoryConfig(
        remote.content,
        `${selectedRepository.repo}@${remote.baseCommit}:.openthrottle.yml`
      );
      const intent = taskType === "investigate" ? "investigate" : "implement";
      const reference = repositoryConfig.config.pipelines?.[intent] ?? intent;
      const manifest = resolvePipelineReference(pipelineAdmission.catalog, reference);
      const needsModel = manifest.manifest.stages.some((stage) => stage.credentials.includes("model.invoke"));
      if (needsModel && !hasAgentSubscription(cfg, selectedAgent)) {
        throw new Error(`${agentDisplayName(selectedAgent)} subscription login is not configured for this pipeline`);
      }
      const snapshot = pipelineAdmission.store.saveRepositoryConfigSnapshot({
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
    if (!(await retireExistingWorkspace())) return;
    try {
      store.upsert({
        ...ticketCore,
        pipeline: {
          repository: selectedRepository.repo,
          baseCommit: pinned.remote.baseCommit,
          baseBranch: selectedRepository.baseBranch,
          manifest: pinned.manifest,
          repositoryConfig: pinned.snapshot,
          runtime: pipelineAdmission.runtime,
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
    await enqueueActivity(store, linearOutbox, {
      sessionId,
      type: "thought",
      body: `Pinned pipeline ${pinned.manifest.manifest.id}@${pinned.manifest.manifest.version} (${pinned.manifest.digest.slice(0, 12)}) at base ${pinned.remote.baseCommit.slice(0, 12)}. The durable coordinator will dispatch its first stage.`,
    }, issue.id);
    await pipelineAdmission.drainEffects?.();
    return;
  }
  store.upsert(ticketCore);
  store.setLinearContext(issue.id, initialContext);
  const recovered = await findSandboxForTicket(daytona, issue.identifier);
  if (recovered) {
    store.setSandboxId(issue.id, recovered.id);
    const recoveredTicket = store.getByIssueId(issue.id)!;
    if (recoveredTicket.run_id) {
      await reportCreatedWorkspace(cfg, store, linearOutbox, recoveredTicket, recovered.id);
      return;
    }
    await launchExistingTask({
      cfg,
      store,
      daytona,
      linear,
      linearOutbox,
      ticket: recoveredTicket,
      taskType,
      resumeMessage: "Recovered the existing workspace. Re-read the ticket and continue.",
      linearContext: initialContext,
    });
    return;
  }

  const staleRunId = store.getByIssueId(issue.id)?.run_id;
  if (staleRunId) {
    store.finishRun({
      runId: staleRunId,
      status: "failed",
      failureTail: "Provisioning was interrupted before a workspace was created; retrying.",
      ticketState: "error",
    });
  }
  const run = beginRun(store, cfg, issue.id, taskType);
  if (!run) {
    await enqueueActivity(store, linearOutbox, {
      sessionId,
      type: "thought",
      body: "Still working on this ticket — no second workspace was created.",
    }, issue.id);
    return;
  }

  const ticket = store.getByIssueId(issue.id)!;
  const env = baseSandboxEnv(cfg, {
    ticket,
    taskType,
    run,
    codexAuthJson:
      ticket.agent === "codex" ? await getCodexAuthForSeed(cfg, store) : undefined,
  });
  let sandbox;
  try {
    sandbox = await createForTicket(daytona, cfg, {
      issueIdentifier: issue.identifier,
      env,
    });
    store.setSandboxId(issue.id, sandbox.id);
  } catch (error) {
    const partiallyCreated = await findSandboxForTicket(daytona, issue.identifier).catch(
      () => undefined
    );
    if (partiallyCreated) {
      store.setSandboxId(issue.id, partiallyCreated.id);
      await reportCreatedWorkspace(
        cfg,
        store,
        linearOutbox,
        store.getByIssueId(issue.id)!,
        partiallyCreated.id
      );
      return;
    }
    const message = sanitizeText(`Failed to create a workspace: ${String(error)}`);
    store.finishRun({
      runId: run.id,
      status: "failed",
      failureTail: message,
      ticketState: "error",
    });
    // Surface the failure in the Linear session and return, matching every other
    // provisioning-failure branch above. Re-throwing here left the session stuck
    // on the ephemeral "Spinning up a workspace…" thought while the webhook layer
    // retried silently — e.g. a Daytona "Total disk limit exceeded" quota error
    // was invisible in Linear and only showed up in the supervisor logs.
    await tryPostError(store, linearOutbox, sessionId, issue.id, message);
    return;
  }
  const provisionedTicket = store.getByIssueId(issue.id)!;

  try {
    await startTask(sandbox, {
      env,
      linearContext: initialContext,
      taskTimeoutSeconds: cfg.taskTimeout,
    });
  } catch (error) {
    const message = sanitizeText(`Failed to start ${taskType}: ${String(error)}`);
    store.finishRun({
      runId: run.id,
      status: "failed",
      failureTail: message,
      ticketState: "error",
    });
    await tryPostError(store, linearOutbox, sessionId, issue.id, message);
    scheduleSandboxSettlement({ daytona, store, ticket: provisionedTicket, taskType });
    return;
  }

  await reportCreatedWorkspace(cfg, store, linearOutbox, provisionedTicket, sandbox.id);
  try {
    await enqueueActivity(store, linearOutbox, {
      sessionId,
      type: "action",
      action: "Started",
      parameter: `${taskType} run on ${provisionedTicket.branch}`,
    }, issue.id, run.id);
  } catch (error) {
    console.error(`[linear] ${taskType} started but its activity could not be posted:`, error);
  }
}

async function reportCreatedWorkspace(
  cfg: Config,
  store: TicketStore,
  linearOutbox: LinearOutboxProcessor,
  ticket: Ticket,
  sandboxId: string
): Promise<void> {
  const previewToken = randomBytes(24).toString("base64url");
  store.setPreviewTokenHash(ticket.linear_issue_id, tokenHash(previewToken));
  const previewUrl = `${cfg.supervisorUrl}/preview/${encodeURIComponent(
    ticket.linear_issue_identifier
  )}?token=${encodeURIComponent(previewToken)}`;
  try {
    await enqueueActivity(store, linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "action",
      action: "Created workspace",
      parameter: `${sandboxId} on ${ticket.repo}:${ticket.branch}`,
      result: `Wake-on-click preview: ${previewUrl}`,
    }, ticket.linear_issue_id);
  } catch (error) {
    console.error("[linear] failed to enqueue workspace activity:", error);
  }
  try {
    await enqueueSessionUpdate(store, linearOutbox, {
      sessionId: ticket.linear_session_id,
      issueId: ticket.linear_issue_id,
      addedExternalUrls: [{ label: "Workspace Preview", url: previewUrl }],
    });
  } catch (error) {
    console.error("[linear] failed to enqueue workspace preview:", error);
  }
}

async function handlePrompted(
  cfg: Config,
  store: TicketStore,
  daytona: Daytona,
  linear: LinearClient,
  linearOutbox: LinearOutboxProcessor,
  payload: ReturnType<typeof parseLinearWebhook>,
  pipelineAdmission?: PipelineAdmissionContext
): Promise<void> {
  const sessionId = payload.agentSession.id;
  const issue = payload.agentSession.issue;
  const resumeMessage =
    payload.agentActivity?.content?.body ?? payload.agentActivity?.body ?? "";
  const ticket = issue
    ? store.getByIssueId(issue.id)
    : store.listAll().find((candidate) => candidate.linear_session_id === sessionId);
  if (!ticket) {
    await tryPostError(
      store,
      linearOutbox,
      sessionId,
      issue?.id,
      "OpenThrottle couldn't find an existing workspace. Delegate the issue again to start one."
    );
    return;
  }

  const labels = extractLabelNames(payload);
  const command = parseCommand(resumeMessage, { investigateLabel: labels.includes("investigate") });
  const pipelineInstance = pipelineAdmission?.store.getInstanceForSession(sessionId);
  // The native Linear `signal: "stop"` control signal is checked directly
  // here (it's not a chat command); a textual "/stop" is handled by
  // parseCommand alongside /merge and /implement.
  const isStop = payload.agentActivity?.signal?.toLowerCase() === "stop" || command.kind === "stop";
  if (isStop) {
    if (pipelineInstance && pipelineAdmission) {
      requestPipelineStop({
        store: pipelineAdmission.store,
        sessionId,
        eventId: `linear-stop:${pipelineInstance.id}:${payload.agentActivity?.id ?? "signal"}`,
        reason: "Stopped from the Linear thread.",
      });
      await pipelineAdmission.drainEffects?.();
      return;
    }
    if (!ticket.sandbox_id) {
      await tryPostError(
        store,
        linearOutbox,
        sessionId,
        ticket.linear_issue_id,
        "OpenThrottle couldn't find an existing workspace. Delegate the issue again to start one."
      );
      return;
    }
    await stopTicket({
      store,
      daytona,
      linear,
      linearOutbox,
      ticket,
      reason: "Stopped from the Linear thread.",
    });
    return;
  }

  if (command.kind === "merge") {
    await mergeFromLinear(cfg, store, linearOutbox, ticket);
    return;
  }

  if (pipelineInstance && pipelineAdmission) {
    const workId = payload.agentActivity?.id;
    if (
      command.kind === "reply" &&
      workId &&
      canSteerPipelineRun({
        store: pipelineAdmission.store,
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
        body: sanitizeText(resumeMessage),
      });
      await enqueueActivity(store, linearOutbox, {
        sessionId,
        type: "thought",
        body: "Steering the current pipeline stage with your message…",
        ephemeral: true,
      }, ticket.linear_issue_id);
      return;
    }
    await tryPostError(
      store,
      linearOutbox,
      sessionId,
      ticket.linear_issue_id,
      command.kind === "implement"
        ? "This session is pinned to the pipeline coordinator and cannot start a legacy implementation run. Re-delegate the issue to create a new generation."
        : "The current pipeline stage does not accept live steering. Add feedback to the pull request, or re-delegate the issue to create a new generation."
    );
    return;
  }

  if (!ticket.sandbox_id) {
    await tryPostError(
      store,
      linearOutbox,
      sessionId,
      ticket.linear_issue_id,
      "OpenThrottle couldn't find an existing workspace. Delegate the issue again to start one."
    );
    return;
  }

  const workId = payload.agentActivity?.id;
  if (workId) {
    const inserted = store.enqueueSessionWork({
      id: workId,
      linearSessionId: sessionId,
      issueId: ticket.linear_issue_id,
      source: "human",
      body: sanitizeText(resumeMessage),
    });
    if (!inserted) return;
  }

  await enqueueActivity(store, linearOutbox, {
    sessionId,
    type: "thought",
    body: "Picking this back up…",
    ephemeral: true,
  }, ticket.linear_issue_id);

  const nextContext = linearContext(
    payload,
    `${ticket.linear_context ?? `# ${ticket.linear_issue_identifier}`}\n\n## Latest human reply\n\n${resumeMessage}`
  );
  store.setLinearContext(ticket.linear_issue_id, nextContext);
  const currentTicket = store.getByIssueId(ticket.linear_issue_id) ?? ticket;

  if (command.kind === "implement" && command.legacy) {
    console.warn(
      `[commands] legacy "fix it/implement/go ahead" phrase promoted ${currentTicket.linear_issue_identifier} to implement — use /implement instead`
    );
  }
  const taskType: TaskType = command.kind === "implement" ? "implement" : "resume";

  // Interrupt-on-send: a plain reply that arrives while a run is active on a
  // steering-capable agent (Claude/Codex) is delivered into the running sandbox
  // now via the steering inbox — using the SAME id as the session_work row above
  // so completeRun's drain dedups (cancels the after-run resume once the steer
  // was delivered). The session_work row stays as the durable fallback: if the
  // steer never reaches a live sandbox before the run ends, it drains as a normal
  // resume. launchExistingTask would fail here anyway (a run is already active),
  // so skip it and leave the item pending.
  if (
    taskType === "resume" &&
    workId &&
    currentTicket.run_id &&
    (currentTicket.agent === "claude" || currentTicket.agent === "codex")
  ) {
    store.enqueueInbox({
      id: workId,
      issueId: currentTicket.linear_issue_id,
      sessionId,
      runId: currentTicket.run_id,
      source: "human",
      body: sanitizeText(resumeMessage),
    });
    await enqueueActivity(store, linearOutbox, {
      sessionId,
      type: "thought",
      body: "Steering the current run with your message…",
      ephemeral: true,
    }, currentTicket.linear_issue_id);
    return;
  }

  const launched = await launchExistingTask({
    cfg,
    store,
    daytona,
    linear,
    linearOutbox,
    ticket: currentTicket,
    taskType,
    resumeMessage: taskType === "resume" ? resumeMessage : undefined,
    linearContext: nextContext,
  });
  const runId = store.getByIssueId(ticket.linear_issue_id)?.run_id;
  if (launched && workId && runId) {
    store.markSessionWorkConsumed(workId, runId);
  }
}

async function mergeFromLinear(
  cfg: Config,
  store: TicketStore,
  linearOutbox: LinearOutboxProcessor,
  ticket: Ticket
): Promise<void> {
  if (!cfg.allowLinearMerge) {
    await enqueueActivity(store, linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "Linear merge is disabled. Merge from GitHub, or set ALLOW_LINEAR_MERGE=true.",
    }, ticket.linear_issue_id);
    return;
  }
  if (!ticket.pr_url) {
    await tryPostError(store, linearOutbox, ticket.linear_session_id, ticket.linear_issue_id, "This ticket has no pull request to merge.");
    return;
  }
  const pull = parsePullRequestUrl(ticket.pr_url);
  const github: GithubClient = { token: cfg.githubToken };
  const readiness = await getMergeReadiness(github, pull.repo, pull.number);
  if (readiness.draft || !readiness.mergeable || !readiness.checksPresent || !readiness.checksGreen) {
    await enqueueActivity(store, linearOutbox, {
      sessionId: ticket.linear_session_id,
      type: "error",
      body: "The PR is not merge-ready: it must be non-draft, mergeable, and have terminal green checks.",
    }, ticket.linear_issue_id);
    return;
  }
  const result = await mergePullRequest(github, pull.repo, pull.number, readiness.headSha);
  await enqueueActivity(store, linearOutbox, {
    sessionId: ticket.linear_session_id,
    type: result.merged ? "response" : "error",
    body: result.merged ? `Merged ${ticket.pr_url}.` : `GitHub did not merge the PR: ${result.message}`,
  }, ticket.linear_issue_id);
}
