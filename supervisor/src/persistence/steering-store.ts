import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession, Run, Ticket } from "./store.js";

interface InboxDeliveryBinding {
  issueId: string;
  sessionId: string;
  runId: string;
  nativeSessionId?: string | null;
  generation: number;
  contextRevision: number;
}

export interface SteerInboxRecord {
  id: string;
  ticket_id: string;
  session_id: string;
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
  acknowledgeInboxDelivery(
    deliveryId: string,
    binding: InboxDeliveryBinding & { requestHash: string }
  ): void;
  cancelPendingInbox(issueId: string): number;
  getInbox(id: string): SteerInboxRecord | undefined;
}

function requestHash(params: {
  id: string;
  issueId: string;
  sessionId: string;
  nativeSessionId: string | null;
  generation: number;
  source: "human" | "operator";
  body: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      params.id,
      params.issueId,
      params.sessionId,
      null,
      null,
      params.nativeSessionId,
      params.generation,
      0,
      params.source,
      params.body,
    ]))
    .digest("hex");
}

function historicalRequestHash(params: {
  id: string;
  sessionId: string;
  body: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([params.id, params.sessionId, params.body]))
    .digest("hex");
}

function assertExactReplay(
  record: SteerInboxRecord,
  params: {
    id: string;
    issueId: string;
    sessionId: string;
    source: "human" | "operator";
    body: string;
  }
): void {
  const semanticMatch =
    record.ticket_id === params.issueId &&
    record.session_id === params.sessionId &&
    record.source === params.source &&
    record.body === params.body;
  const modernHash = record.generation === null
    ? null
    : requestHash({
        id: record.id,
        issueId: record.ticket_id,
        sessionId: record.session_id,
        nativeSessionId: record.native_session_id,
        generation: record.generation,
        source: record.source,
        body: record.body,
      });
  const v1Hash = historicalRequestHash({
    id: record.id,
    sessionId: record.session_id,
    body: record.body,
  });
  if (!semanticMatch || (record.request_hash !== modernHash && record.request_hash !== v1Hash)) {
    throw new Error(`inbox work ${record.id} already exists with different intent`);
  }
}

export function createSteeringStore(db: Database.Database): SteeringStore {
  const now = () => new Date().toISOString();
  const getTicket = db.prepare("SELECT * FROM tickets WHERE ticket_id = ?");
  const getSession = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");
  const getInbox = db.prepare("SELECT * FROM steering_items WHERE id = ?");
  const getDelivery = db.prepare("SELECT * FROM steering_items WHERE delivery_id = ?");
  const insertInbox = db.prepare(`
    INSERT OR IGNORE INTO steering_items (
      id, ticket_id, session_id, run_id, source, body, status, created_at,
      request_hash, generation, context_revision, native_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?)
  `);
  const listPending = db.prepare(`
    SELECT * FROM steering_items
    WHERE ticket_id = ? AND (
      status = 'pending' OR
      (status = 'dispatched' AND (lease_until IS NULL OR lease_until <= ? OR run_id IS NOT ?))
    )
    ORDER BY created_at, id
  `);
  const lease = db.prepare(`
    UPDATE steering_items SET run_id = ?, delivery_id = ?, lease_until = ?
    WHERE id = ? AND status IN ('pending', 'dispatched')
  `);
  const markDispatched = db.prepare(`
    UPDATE steering_items SET status = 'dispatched', delivered_at = ?
    WHERE id = ? AND status IN ('pending', 'dispatched')
  `);
  const acknowledge = db.prepare(`
    UPDATE steering_items SET status = 'acknowledged'
    WHERE delivery_id = ? AND status = 'dispatched'
  `);
  const cancel = db.prepare(`
    UPDATE steering_items SET status = 'canceled'
    WHERE id = ? AND status IN ('pending', 'dispatched')
  `);
  const cancelAll = db.prepare(`
    UPDATE steering_items SET status = 'canceled'
    WHERE ticket_id = ? AND status IN ('pending', 'dispatched')
  `);

  const leaseRecord = (record: SteerInboxRecord, runId: string, timestamp: string): SteerInboxRecord => {
    if (record.delivery_id && record.run_id === runId && record.lease_until && record.lease_until > timestamp) {
      return record;
    }
    const deliveryId = randomUUID();
    if (lease.run(runId, deliveryId, new Date(Date.now() + 30_000).toISOString(), record.id).changes !== 1) {
      throw new Error(`inbox work ${record.id} lease race`);
    }
    return getInbox.get(record.id) as SteerInboxRecord;
  };

  return {
    enqueueInbox(params) {
      const id = params.id ?? randomUUID();
      return db.transaction(() => {
        const timestamp = now();
        const session = getSession.get(params.sessionId) as AgentSession | undefined;
        const generation = session?.generation ?? 1;
        const nativeSessionId = session?.provider_conversation_id ?? null;
        const hash = requestHash({
          id,
          issueId: params.issueId,
          sessionId: params.sessionId,
          generation,
          nativeSessionId,
          source: params.source,
          body: params.body,
        });
        const inserted = insertInbox.run(
          id, params.issueId, params.sessionId, params.runId ?? null, params.source,
          params.body, timestamp, hash, generation, nativeSessionId
        );
        let record = getInbox.get(id) as SteerInboxRecord;
        if (inserted.changes === 0) {
          assertExactReplay(record, {
            id,
            issueId: params.issueId,
            sessionId: params.sessionId,
            source: params.source,
            body: params.body,
          });
        } else if (record.request_hash !== hash) {
          throw new Error(`inbox work ${id} was inserted with an invalid request hash`);
        }
        const ticket = params.runId === null ? undefined : getTicket.get(params.issueId) as Ticket | undefined;
        const runId = params.runId !== undefined ? params.runId : ticket?.run_id;
        if (
          runId && ticket?.run_id === runId && ticket.agent !== "opencode" &&
          (getRun.get(runId) as Run | undefined)?.status === "running"
        ) {
          record = leaseRecord(record, runId, timestamp);
        }
        return record;
      })();
    },
    listPendingInbox(issueId) {
      return db.transaction(() => {
        const timestamp = now();
        const ticket = getTicket.get(issueId) as Ticket | undefined;
        const runId = ticket?.run_id;
        const session = ticket ? getSession.get(ticket.session_id) as AgentSession | undefined : undefined;
        const records = listPending.all(issueId, timestamp, runId ?? null) as SteerInboxRecord[];
        if (!ticket || !runId || !session) return [];
        const deliverable: SteerInboxRecord[] = [];
        for (const record of records) {
          if (
            record.session_id !== ticket.session_id || record.generation !== session.generation ||
            (record.run_id !== null && record.run_id !== runId)
          ) {
            cancel.run(record.id);
            continue;
          }
          deliverable.push(leaseRecord(record, runId, timestamp));
        }
        return deliverable;
      })();
    },
    markInboxDispatched(id) {
      const record = getInbox.get(id) as SteerInboxRecord | undefined;
      if (!record?.delivery_id || !record.run_id || record.generation === null || record.context_revision === null) {
        throw new Error(`inbox work ${id} has no leased delivery`);
      }
      markDispatched.run(now(), id);
    },
    acknowledgeInboxDelivery(deliveryId, binding) {
      const record = getDelivery.get(deliveryId) as SteerInboxRecord | undefined;
      if (!record || record.request_hash !== binding.requestHash) {
        throw new Error(`inbox acknowledgement ${deliveryId} request hash mismatch`);
      }
      if (
        record.ticket_id !== binding.issueId || record.session_id !== binding.sessionId ||
        record.run_id !== binding.runId || record.native_session_id !== (binding.nativeSessionId ?? null) ||
        record.generation !== binding.generation || record.context_revision !== binding.contextRevision
      ) {
        throw new Error(`inbox delivery ${deliveryId} binding mismatch`);
      }
      if (record.status === "acknowledged") return;
      if (record.status !== "dispatched") {
        throw new Error(`inbox delivery ${deliveryId} must be dispatched before acknowledgement`);
      }
      if (acknowledge.run(deliveryId).changes !== 1) throw new Error(`inbox delivery ${deliveryId} acknowledgement race`);
    },
    cancelPendingInbox(issueId) {
      return cancelAll.run(issueId).changes;
    },
    getInbox(id) {
      return getInbox.get(id) as SteerInboxRecord | undefined;
    },
  };
}
