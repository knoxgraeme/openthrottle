import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { WorkBinding, WorkStore } from "./work-store.js";
import type { AgentSession, Run, Ticket } from "./store.js";

export interface SteerInboxRecord {
  id: string;
  linear_issue_id: string;
  linear_session_id: string;
  run_id: string | null;
  source: "human" | "operator";
  body: string;
  status: "pending" | "dispatched" | "acknowledged" | "canceled";
  created_at: string | null;
  delivered_at: string | null;
  delivery_id: string | null;
  request_hash: string | null;
  generation: number | null;
  context_revision: number | null;
  native_session_id: string | null;
  lease_until: string | null;
}

export interface SteeringStore {
  enqueueInbox(params: {
    id?: string;
    issueId: string;
    sessionId: string;
    runId?: string | null;
    source: "human" | "operator";
    body: string;
  }): SteerInboxRecord;
  listPendingInbox(issueId: string): SteerInboxRecord[];
  markInboxDispatched(id: string): void;
  acknowledgeInboxDelivery(deliveryId: string, binding: WorkBinding & { requestHash: string }): void;
  cancelPendingInbox(issueId: string): number;
  getInbox(id: string): SteerInboxRecord | undefined;
}

export function createSteeringStore(db: Database.Database, workStore: WorkStore): SteeringStore {
  const now = () => new Date().toISOString();
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE linear_issue_id = ?");
  const getSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  const getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  const insertInboxStmt = db.prepare(`
    INSERT OR IGNORE INTO session_inbox (
      id, linear_issue_id, linear_session_id, run_id, source, body, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const listPendingInboxStmt = db.prepare(`
    SELECT si.*, wi.active_delivery_id AS delivery_id, wi.request_hash,
      wi.generation, wi.context_revision, wi.native_session_id,
      wd.lease_until
    FROM session_inbox si
    LEFT JOIN work_items wi ON wi.id = si.id
    LEFT JOIN work_deliveries wd ON wd.id = wi.active_delivery_id
    WHERE si.linear_issue_id = ?
      AND (si.status = 'pending'
        OR (si.status = 'dispatched' AND (
          wd.lease_until <= ? OR wd.run_id IS NOT (
            SELECT t.run_id FROM tickets t WHERE t.linear_issue_id = si.linear_issue_id
          )
        )))
    ORDER BY si.created_at ASC, si.id ASC
  `);
  const markInboxDispatchedStmt = db.prepare(
    "UPDATE session_inbox SET status = 'dispatched', delivered_at = ? WHERE id = ? AND status IN ('pending', 'dispatched')"
  );
  const cancelPendingInboxStmt = db.prepare(
    "UPDATE session_inbox SET status = 'canceled' WHERE linear_issue_id = ? AND status IN ('pending', 'dispatched')"
  );
  const cancelInboxStmt = db.prepare(
    "UPDATE session_inbox SET status = 'canceled' WHERE id = ? AND status IN ('pending', 'dispatched')"
  );
  const getInboxStmt = db.prepare(`
    SELECT si.*, wi.active_delivery_id AS delivery_id, wi.request_hash,
      wi.generation, wi.context_revision, wi.native_session_id,
      wd.lease_until
    FROM session_inbox si
    LEFT JOIN work_items wi ON wi.id = si.id
    LEFT JOIN work_deliveries wd ON wd.id = wi.active_delivery_id
    WHERE si.id = ?
  `);
  return {
    enqueueInbox(params) {
      const id = params.id ?? randomUUID();
      db.transaction(() => {
        const timestamp = now();
        insertInboxStmt.run(
          id,
          params.issueId,
          params.sessionId,
          params.runId ?? null,
          params.source,
          params.body,
          timestamp
        );
        const session = getSessionStmt.get(params.sessionId) as AgentSession | undefined;
        const ticket = getByIssueIdStmt.get(params.issueId) as Ticket | undefined;
        const runId = params.runId ?? ticket?.run_id;
        let item = workStore.get(id);
        if (!item) {
          item = workStore.enqueue({
            id,
            issueId: params.issueId,
            sessionId: params.sessionId,
            generation: session?.generation ?? 1,
            contextRevision: 0,
            nativeSessionId: session?.provider_conversation_id ?? null,
            source: params.source,
            body: params.body,
          });
        }
        db.prepare(
          "INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id) VALUES ('session_inbox', ?, ?)"
        ).run(id, id);
        if (
          runId &&
          ticket?.run_id === runId &&
          ticket.agent !== "opencode" &&
          (getRunStmt.get(runId) as Run | undefined)?.status === "running"
        ) {
          workStore.lease({
            workItemId: id,
            issueId: params.issueId,
            sessionId: params.sessionId,
            runId,
            nativeSessionId: item.native_session_id,
            generation: item.generation,
            contextRevision: item.context_revision,
            leaseUntil: new Date(Date.now() + 30_000).toISOString(),
          });
        }
      })();
      return getInboxStmt.get(id) as SteerInboxRecord;
    },
    listPendingInbox(issueId) {
      const timestamp = now();
      const records = listPendingInboxStmt.all(issueId, timestamp) as SteerInboxRecord[];
      const deliverable: SteerInboxRecord[] = [];
      for (const record of records) {
        const item = workStore.get(record.id);
        const activeRunId =
          (getByIssueIdStmt.get(record.linear_issue_id) as Ticket | undefined)?.run_id;
        if (!item || !activeRunId) continue;
        const activeDelivery = record.delivery_id
          ? workStore.getDelivery(record.delivery_id)
          : undefined;
        if (record.run_id !== activeRunId || (activeDelivery && activeDelivery.run_id !== activeRunId)) {
          db.transaction(() => {
            if (activeDelivery) {
              workStore.expireUnacknowledged(
                activeDelivery.id,
                activeDelivery.run_id,
                `owning run ${activeDelivery.run_id} ended before acknowledgement`
              );
            }
            cancelInboxStmt.run(record.id);
            workStore.cancel(record.id, `steering was fenced to ended run ${record.run_id ?? "unknown"}`);
          })();
          continue;
        }
        if (record.status === "pending" && record.delivery_id) {
          deliverable.push(getInboxStmt.get(record.id) as SteerInboxRecord);
          continue;
        }
        workStore.lease({
          workItemId: record.id,
          issueId: record.linear_issue_id,
          sessionId: record.linear_session_id,
          runId: activeRunId,
          nativeSessionId: item.native_session_id,
          generation: item.generation,
          contextRevision: item.context_revision,
          now: timestamp,
          leaseUntil: new Date(Date.now() + 30_000).toISOString(),
        });
        deliverable.push(getInboxStmt.get(record.id) as SteerInboxRecord);
      }
      return deliverable;
    },
    markInboxDispatched(id) {
      const record = getInboxStmt.get(id) as SteerInboxRecord | undefined;
      if (!record?.delivery_id || !record.run_id || record.generation === null || record.context_revision === null) {
        throw new Error(`inbox work ${id} has no leased delivery`);
      }
      const binding = {
        issueId: record.linear_issue_id,
        sessionId: record.linear_session_id,
        runId: record.run_id,
        nativeSessionId: record.native_session_id,
        generation: record.generation,
        contextRevision: record.context_revision,
      };
      db.transaction(() => {
        workStore.markDispatched(record.delivery_id!, binding);
        markInboxDispatchedStmt.run(now(), id);
      })();
    },
    acknowledgeInboxDelivery(deliveryId, binding) {
      const delivery = workStore.getDelivery(deliveryId);
      if (!delivery || delivery.request_hash !== binding.requestHash) {
        throw new Error(`inbox acknowledgement ${deliveryId} request hash mismatch`);
      }
      db.transaction(() => {
        workStore.acknowledge(deliveryId, binding);
        db.prepare(
          "UPDATE session_inbox SET status = 'acknowledged' WHERE id = ? AND status = 'dispatched'"
        ).run(delivery.work_item_id);
      })();
    },
    cancelPendingInbox(issueId) {
      return db.transaction(() => {
        const ids = db.prepare(
          "SELECT id FROM session_inbox WHERE linear_issue_id = ? AND status IN ('pending', 'dispatched')"
        ).all(issueId) as Array<{ id: string }>;
        const changes = cancelPendingInboxStmt.run(issueId).changes;
        for (const { id } of ids) workStore.cancel(id, "inbox canceled");
        return changes;
      })();
    },
    getInbox(id) {
      return getInboxStmt.get(id) as SteerInboxRecord | undefined;
    },
  };
}
