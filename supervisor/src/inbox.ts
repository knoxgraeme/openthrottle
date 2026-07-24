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
import type { SupervisorStore } from "./persistence/store.js";

const INBOX_DIR = "/home/agent/.ot/inbox";
const INBOX_ACK_DIR = "/home/agent/.ot/inbox-processed";

interface InboxAcknowledgement {
  version: 1;
  delivery_id: string;
  request_hash: string;
  issue_id: string;
  session_id: string;
  run_id: string;
  native_session_id: string | null;
  generation: number;
  context_revision: number;
}

function parseAcknowledgement(raw: string): InboxAcknowledgement {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inbox acknowledgement must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.delivery_id !== "string" ||
    typeof record.request_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.request_hash) ||
    typeof record.issue_id !== "string" ||
    typeof record.session_id !== "string" ||
    typeof record.run_id !== "string" ||
    (record.native_session_id !== null && typeof record.native_session_id !== "string") ||
    !Number.isInteger(record.generation) ||
    !Number.isInteger(record.context_revision)
  ) {
    throw new Error("inbox acknowledgement is malformed");
  }
  return record as unknown as InboxAcknowledgement;
}

async function collectAcknowledgements(
  sandbox: Awaited<ReturnType<Daytona["get"]>>,
  store: SupervisorStore
): Promise<void> {
  const files = await sandbox.fs.listFiles(INBOX_ACK_DIR).catch(() => []);
  for (const file of files) {
    if (file.isDir || !/^[A-Za-z0-9._-]+\.json$/.test(file.name)) {
      continue;
    }
    const remotePath = `${INBOX_ACK_DIR}/${file.name}`;
    if (file.size > 16 * 1024) {
      console.error(`[inbox] deleting oversized acknowledgement ${file.name}`);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }
    let acknowledgement: InboxAcknowledgement;
    try {
      acknowledgement = parseAcknowledgement(
        (await sandbox.fs.downloadFile(remotePath)).toString("utf8")
      );
    } catch (error) {
      console.error(`[inbox] rejected malformed acknowledgement ${file.name}:`, error);
      await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      continue;
    }
    try {
      store.acknowledgeInboxDelivery(acknowledgement.delivery_id, {
        requestHash: acknowledgement.request_hash,
        issueId: acknowledgement.issue_id,
        sessionId: acknowledgement.session_id,
        runId: acknowledgement.run_id,
        nativeSessionId: acknowledgement.native_session_id,
        generation: acknowledgement.generation,
        contextRevision: acknowledgement.context_revision,
      });
      await sandbox.fs.deleteFile(remotePath);
    } catch (error) {
      // Retain a well-formed journal when storage is unavailable so the exact
      // acknowledgement can be retried without redelivering semantic work.
      console.error(`[inbox] could not persist acknowledgement ${file.name}:`, error);
      if (/not found|mismatch|must be dispatched/i.test(String(error))) {
        await sandbox.fs.deleteFile(remotePath).catch(() => undefined);
      }
    }
  }
}

export async function deliverPendingInbox(params: {
  daytona: Daytona;
  store: SupervisorStore;
}): Promise<void> {
  for (const ticket of params.store.listRunning()) {
    if (!ticket.sandbox_id) continue;
    // Only agents with a wired drain hook can consume steering (entrypoint.sh:
    // Claude via ~/.claude/settings.json, Codex via ~/.codex/hooks.json).
    // OpenCode has no hook yet, so dispatching would leave the steer permanently
    // unacknowledged — keep it pending until an OpenCode hook is wired.
    if (ticket.agent !== "claude" && ticket.agent !== "codex") continue;
    try {
      const sandbox = await params.daytona.get(ticket.sandbox_id);
      if (sandbox.state !== "started") await sandbox.start(60);
      await collectAcknowledgements(sandbox, params.store);
      const pending = params.store.listPendingInbox(ticket.linear_issue_id);
      if (pending.length === 0) continue;
      // Best-effort dir creation; the entrypoint also mkdir's this on startup,
      // so an "already exists" here must not block delivery.
      await sandbox.fs.createFolder(INBOX_DIR, "700").catch(() => undefined);
      for (const message of pending) {
        if (
          !message.delivery_id ||
          !message.request_hash ||
          message.generation === null ||
          message.context_revision === null ||
          !message.run_id
        ) {
          throw new Error(`inbox work ${message.id} has no fenced delivery`);
        }
        // Delivery IDs are supervisor-generated UUIDs. Do not put provider-
        // supplied semantic work IDs into a remote path.
        const remotePath = `${INBOX_DIR}/${message.delivery_id}.json`;
        // The body is untrusted human/operator data — written verbatim as file
        // contents only, never interpreted here.
        await sandbox.fs.uploadFile(
          Buffer.from(JSON.stringify({
            version: 1,
            delivery_id: message.delivery_id,
            request_hash: message.request_hash,
            issue_id: message.linear_issue_id,
            session_id: message.linear_session_id,
            run_id: message.run_id,
            native_session_id: message.native_session_id,
            generation: message.generation,
            context_revision: message.context_revision,
            body: message.body,
          })),
          remotePath
        );
        await sandbox.fs.setFilePermissions(remotePath, {
          owner: "agent",
          group: "agent",
          mode: "600",
        });
        // Upload is only dispatch. The sandbox hook writes a processed journal
        // after injection; a later poll observes that receipt and acknowledges
        // the exact fenced delivery.
        params.store.markInboxDispatched(message.id);
      }
    } catch (error) {
      // Never throw: one unreachable sandbox must not stall delivery for the
      // rest. Undispatched rows stay pending and retry next sweep.
      console.error(
        `[inbox] could not deliver steering to ${ticket.linear_issue_identifier}:`,
        error
      );
    }
  }
}
