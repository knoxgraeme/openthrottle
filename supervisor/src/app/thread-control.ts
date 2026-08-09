import type { Config } from "./config.js";
import type { Ticket, SupervisorStore } from "../persistence/store.js";
import type { LinearAgentSessionEvent } from "./ports.js";
import { sanitizeText } from "../shared/sanitize.js";
import { parseCommand } from "./commands.js";
import { canSteerPipelineRun, requestPipelineStop } from "../pipeline/control.js";
import {
  pipelineIsTerminal,
  processPipelineFeedbackSnapshot,
  providerStageCanReceive,
  recordPipelineProviderEvent,
} from "./provider-feedback.js";
import type { PipelineCoordinatorContext, SessionServicePorts } from "./session-service.js";

async function publishMissingPipeline(
  providers: SessionServicePorts,
  sessionId: string,
  issueId: string
): Promise<void> {
  await providers.activityPublisher.publishError(
    sessionId,
    issueId,
    "OpenThrottle couldn't find a pipeline for this session. @-mention the agent in a new comment on the issue to start one."
  );
}

export async function handlePrompted(
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
      "OpenThrottle couldn't find an existing workspace. @-mention the agent in a new comment on the issue to start one."
    );
    return;
  }

  const command = parseCommand(promptBody);
  const pipelineInstance = coordinator.store.getInstanceForSession(sessionId);
  const isStop = payload.agentActivity?.signal?.toLowerCase() === "stop" || command.kind === "stop";
  if (isStop) {
    if (!pipelineInstance) {
      await publishMissingPipeline(providers, sessionId, ticket.linear_issue_id);
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
    await publishMissingPipeline(providers, sessionId, ticket.linear_issue_id);
    return;
  }
  if (command.kind === "reply" && workId && pipelineInstance.status === "running" && ticket.run_id) {
    store.enqueueInbox({
      id: workId,
      issueId: ticket.linear_issue_id,
      sessionId,
      runId: null,
      source: "human",
      body: sanitizeText(promptBody),
    });
    await providers.activityPublisher.publishActivity({
      sessionId,
      type: "thought",
      body: "Captured your message — it is retained for the next implementation or repair stage.",
      ephemeral: true,
    }, ticket.linear_issue_id);
    return;
  }
  if (command.kind === "reply" && workId && pipelineInstance.status === "waiting_provider") {
    const sanitizedReply = sanitizeText(promptBody).slice(0, 2_000);
    if (
      !pipelineIsTerminal(pipelineInstance) &&
      providerStageCanReceive(coordinator.store, pipelineInstance) &&
      pipelineInstance.published_commit
    ) {
      const snapshot = recordPipelineProviderEvent({
        store,
        instance: pipelineInstance,
        ticket,
        provider: "linear",
        eventId: `linear-reply:${workId}`,
        outcome: "semantic_repair_required",
        summary: "Linear reply requires another implementation pass.",
        evidence: [sanitizedReply],
        payload: {
          kind: "linear_reply",
          activity_id: workId,
          body: sanitizedReply,
        },
        headSha: pipelineInstance.published_commit,
      });
      processPipelineFeedbackSnapshot({
        pipelines: coordinator.store,
        store,
        instance: pipelineInstance,
        snapshot,
      });
      await coordinator.drainEffects?.();
      await providers.activityPublisher.publishActivity({
        sessionId,
        type: "thought",
        body: "Waking the run to address your message in the honest ledger.",
      }, ticket.linear_issue_id);
      return;
    }
  }
  await providers.activityPublisher.publishError(
    sessionId,
    ticket.linear_issue_id,
    "The current pipeline stage does not accept live steering. Add feedback to the pull request, or @-mention the agent in a new comment to start a new generation."
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
