import { randomUUID } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { Ticket, TicketStore } from "./db.js";
import { deleteSandbox, stopSandbox } from "./daytona.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import { type LinearClient } from "./linear.js";
import {
  activityPayload,
  sessionUpdatePayload,
  tryPostError,
  type LinearOutboxProcessor,
} from "./linear-outbox.js";

export async function stopTicket(params: {
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient | undefined;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  reason: string;
}): Promise<void> {
  const { store, daytona, linearOutbox, ticket, reason } = params;
  if (ticket.run_id) {
    const owner = `stop-${randomUUID()}`;
    const settlement = await terminateAndSettleActor({
      daytona,
      store,
      runId: ticket.run_id,
      sandboxId: ticket.sandbox_id,
      owner,
      reason,
      status: "stopped",
      ticketState: "stopped",
    });
    if (settlement.kind === "quarantined") {
      await tryPostError(
        store,
        linearOutbox,
        ticket.linear_session_id,
        ticket.linear_issue_id,
        settlement.message
      );
      return;
    }
    if (settlement.kind !== "settled") return;
  } else {
    store.setState(ticket.linear_issue_id, "stopped", reason);
    if (ticket.sandbox_id) {
      try {
        await stopSandbox(daytona, ticket.sandbox_id);
      } catch (error) {
        console.error(`[stop] cleanup pending for ${ticket.linear_issue_identifier}:`, error);
      }
    }
  }
  store.markSessionState(ticket.linear_session_id, "stopped");
  store.cancelPendingSessionWork(ticket.linear_session_id);
  store.cancelPendingInbox(ticket.linear_issue_id);
  try {
    store.enqueueLinearOutbox({
      linearSessionId: ticket.linear_session_id,
      issueId: ticket.linear_issue_id,
      runId: ticket.run_id,
      kind: "activity",
      payload: activityPayload({
        sessionId: ticket.linear_session_id,
        type: "response",
        body: reason,
      }),
    });
  } catch (error) {
    console.error(`[stop] stopped ${ticket.linear_issue_identifier} but failed to enqueue activity:`, error);
  }
  void linearOutbox.drain(1).catch((error) =>
    console.error(`[stop] stopped ${ticket.linear_issue_identifier} but failed to dispatch activity:`, error)
  );
}

export async function closeTicketForPullRequest(params: {
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient | undefined;
  linearOutbox: LinearOutboxProcessor;
  ticket: Ticket;
  prUrl: string;
  merged: boolean;
}): Promise<void> {
  const { store, daytona, linearOutbox, ticket, prUrl, merged } = params;
  let deleteFailed = false;

  if (ticket.run_id) {
    const owner = `pr-close-${randomUUID()}`;
    const reason = "PR closed while the run was active.";
    const settlement = await terminateAndSettleActor({
      daytona,
      store,
      runId: ticket.run_id,
      sandboxId: ticket.sandbox_id,
      owner,
      reason,
      status: "stopped",
      ticketState: "closed",
      prUrl,
    });
    if (settlement.kind === "quarantined") {
      await tryPostError(
        store,
        linearOutbox,
        ticket.linear_session_id,
        ticket.linear_issue_id,
        settlement.message
      );
      return;
    }
    if (settlement.kind !== "settled") return;
  }
  if (ticket.sandbox_id) {
    try {
      await deleteSandbox(daytona, ticket.sandbox_id);
    } catch (error) {
      deleteFailed = true;
      console.error(`[webhooks/github] failed to delete sandbox ${ticket.sandbox_id}:`, error);
    }
  }
  store.setPrUrl(ticket.linear_issue_id, prUrl);
  store.setState(ticket.linear_issue_id, "closed");
  store.cancelPendingSessionWork(ticket.linear_session_id);
  store.cancelPendingInbox(ticket.linear_issue_id);

  if (params.linear) {
    const cleanup = deleteFailed
      ? " Workspace cleanup is pending and will be retried by the orphan sweep."
      : " Workspace cleaned up.";
    const activity = store.enqueueLinearOutbox({
      linearSessionId: ticket.linear_session_id,
      issueId: ticket.linear_issue_id,
      kind: "activity",
      payload: activityPayload({
        sessionId: ticket.linear_session_id,
        type: deleteFailed ? "error" : "response",
        body: `PR ${merged ? "merged" : "closed"}.${cleanup}${
          ticket.running_since ? " The active run was stopped." : ""
        }`,
      }),
    });
    await linearOutbox.process(activity.id);
    const update = store.enqueueLinearOutbox({
      linearSessionId: ticket.linear_session_id,
      issueId: ticket.linear_issue_id,
      kind: "session_update",
      payload: sessionUpdatePayload({
        sessionId: ticket.linear_session_id,
        addedExternalUrls: [{ label: "Pull Request", url: prUrl }],
      }),
    });
    await linearOutbox.process(update.id);
  }
}
