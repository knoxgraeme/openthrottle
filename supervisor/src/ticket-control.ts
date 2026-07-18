import type { Daytona } from "@daytona/sdk";
import type { Ticket, TicketStore } from "./db.js";
import { deleteSandbox, stopSandbox } from "./daytona.js";
import { agentActivityCreate, agentSessionUpdate, type LinearClient } from "./linear.js";

export async function stopTicket(params: {
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient | undefined;
  ticket: Ticket;
  reason: string;
}): Promise<void> {
  const { store, daytona, linear, ticket, reason } = params;
  if (ticket.sandbox_id) await stopSandbox(daytona, ticket.sandbox_id);
  if (ticket.run_id) {
    store.finishRun({
      runId: ticket.run_id,
      status: "stopped",
      failureTail: reason,
      ticketState: "stopped",
    });
  } else {
    store.setState(ticket.linear_issue_id, "stopped", reason);
  }
  if (linear) {
    try {
      await agentActivityCreate(linear, {
        sessionId: ticket.linear_session_id,
        type: "response",
        body: reason,
      });
    } catch (error) {
      console.error(`[stop] stopped ${ticket.linear_issue_identifier} but failed to post activity:`, error);
    }
  }
}

export async function closeTicketForPullRequest(params: {
  store: TicketStore;
  daytona: Daytona;
  linear: LinearClient | undefined;
  ticket: Ticket;
  prUrl: string;
  merged: boolean;
}): Promise<void> {
  const { store, daytona, linear, ticket, prUrl, merged } = params;
  let stopFailed = false;
  let deleteFailed = false;

  if (ticket.run_id) {
    try {
      if (ticket.sandbox_id) await stopSandbox(daytona, ticket.sandbox_id);
    } catch (error) {
      stopFailed = true;
      console.error(`[webhooks/github] failed to stop sandbox ${ticket.sandbox_id}:`, error);
    } finally {
      store.finishRun({
        runId: ticket.run_id,
        status: "stopped",
        failureTail: "PR closed while the run was active.",
        prUrl,
        ticketState: "closed",
      });
    }
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

  if (linear) {
    const cleanup =
      stopFailed || deleteFailed
        ? " Workspace cleanup is pending and will be retried by the orphan sweep."
        : " Workspace cleaned up.";
    await agentActivityCreate(linear, {
      sessionId: ticket.linear_session_id,
      type: stopFailed || deleteFailed ? "error" : "response",
      body: `PR ${merged ? "merged" : "closed"}.${cleanup}${
        ticket.running_since ? " The active run was stopped." : ""
      }`,
    });
    await agentSessionUpdate(linear, {
      sessionId: ticket.linear_session_id,
      addedExternalUrls: [{ label: "Pull Request", url: prUrl }],
    });
  }
}
