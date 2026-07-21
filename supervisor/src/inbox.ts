// inbox.ts — mid-run steering delivery poller. The inbound mirror of
// linear-outbox: durable steering messages queued by a human/operator (see the
// session_inbox store in db.ts) are written into a running sandbox's
// ~/.ot/inbox as per-message files, where the baked ot-inbox-drain.sh hook
// injects them into the agent at the next tool/stop boundary — steering the run
// without killing it. The message body is UNTRUSTED data: it is only ever
// written as file contents here (never executed), and the sandbox hook frames
// it as data on injection. Not wired into index.ts here — the integrator wires
// the poll interval.

import type { Daytona } from "@daytona/sdk";
import type { TicketStore } from "./db.js";

const INBOX_DIR = "/home/agent/.ot/inbox";

export async function deliverPendingInbox(params: {
  daytona: Daytona;
  store: TicketStore;
}): Promise<void> {
  for (const ticket of params.store.listRunning()) {
    if (!ticket.sandbox_id) continue;
    const pending = params.store.listPendingInbox(ticket.linear_issue_id);
    if (pending.length === 0) continue;
    try {
      const sandbox = await params.daytona.get(ticket.sandbox_id);
      if (sandbox.state !== "started") await sandbox.start(60);
      // Best-effort dir creation; the entrypoint also mkdir's this on startup,
      // so an "already exists" here must not block delivery.
      await sandbox.fs.createFolder(INBOX_DIR, "700").catch(() => undefined);
      for (const message of pending) {
        const remotePath = `${INBOX_DIR}/${message.id}.md`;
        // The body is untrusted human/operator data — written verbatim as file
        // contents only, never interpreted here.
        await sandbox.fs.uploadFile(Buffer.from(message.body), remotePath);
        await sandbox.fs.setFilePermissions(remotePath, {
          owner: "agent",
          group: "agent",
          mode: "600",
        });
        // Mark delivered ONLY after a successful write, so a failed upload is
        // retried on the next sweep instead of being silently dropped.
        params.store.markInboxDelivered(message.id);
      }
    } catch (error) {
      // Never throw: one unreachable sandbox must not stall delivery for the
      // rest. Undelivered rows stay pending and retry next sweep.
      console.error(
        `[inbox] could not deliver steering to ${ticket.linear_issue_identifier}:`,
        error
      );
    }
  }
}
