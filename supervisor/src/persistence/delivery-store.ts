import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  DeliveryClaim,
  LinearOutboxRecord,
  SandboxEventRecord,
  WebhookDelivery,
} from "./store.js";

export interface DeliveryStore {
  enqueueLinearOutbox(params: {
    id?: string;
    linearSessionId?: string | null;
    issueId?: string | null;
    runId?: string | null;
    kind: LinearOutboxRecord["kind"];
    payload: string;
  }): LinearOutboxRecord;
  claimLinearOutbox(nowIso: string, leaseUntilIso: string, limit: number): LinearOutboxRecord[];
  claimLinearOutboxForId(id: string, nowIso: string, leaseUntilIso: string, limit: number): LinearOutboxRecord[];
  markLinearOutboxProcessed(id: string, receipt?: {
    externalId?: string | null;
    externalUrl?: string | null;
    attachmentUrl?: string | null;
  }, expectedPayloadHash?: string): void;
  markLinearOutboxFailed(id: string, error: string, retryAt: string | null, expectedPayloadHash?: string): void;
  recordLinearOutboxAttachment(id: string, attachmentUrl: string): void;
  getLinearOutbox(id: string): LinearOutboxRecord | undefined;
  listLinearOutbox(): LinearOutboxRecord[];
  claimDelivery(claim: DeliveryClaim): boolean;
  claimDeliveryForProcessing(params: {
    deliveryId: string;
    nowIso: string;
    leaseUntilIso: string;
  }): WebhookDelivery | undefined;
  markDeliveryProcessed(deliveryId: string): void;
  markDeliveryFailed(deliveryId: string, error: string, retryAt: string | null): void;
  listProcessableDeliveries(nowIso: string, limit: number): WebhookDelivery[];
  pruneDeliveries(beforeIso: string): number;
  insertSandboxEvent(params: {
    eventId: string;
    runId: string;
    sandboxId: string;
    kind: "activity" | "plan" | "heartbeat" | "stage_result";
    payload: string;
  }): SandboxEventRecord;
  getSandboxEvent(eventId: string): SandboxEventRecord | undefined;
  claimSandboxEvent(eventId: string, nowIso: string, leaseUntilIso: string): SandboxEventRecord | undefined;
  markSandboxEventProcessed(eventId: string): void;
  markSandboxEventFailed(eventId: string, error: string, retryAt: string): void;
  markSandboxEventDiagnosed(eventId: string, diagnosedAt: string): boolean;
  pruneSandboxEvents(beforeIso: string): number;
  pruneEphemeralLinearOutbox(beforeIso: string): number;
}

export function createDeliveryStore(db: Database.Database): DeliveryStore {
  const now = () => new Date().toISOString();
  const hashPayload = (payload: string) => createHash("sha256").update(payload).digest("hex");
  const nextOutboxSequenceStmt = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM linear_outbox WHERE linear_session_id IS ?"
  );
  const insertLinearOutboxStmt = db.prepare(`
    INSERT INTO linear_outbox (
      id, linear_session_id, linear_issue_id, run_id, sequence, kind,
      payload, payload_hash, status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getLinearOutboxStmt = db.prepare("SELECT * FROM linear_outbox WHERE id = ?");
  const listLinearOutboxStmt = db.prepare("SELECT * FROM linear_outbox ORDER BY created_at, sequence");
  const claimDeliveryStmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries (
      delivery_id, source, session_id, action, activity_id, event_name,
      payload, status, attempts, next_attempt_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getDeliveryStmt = db.prepare(
    "SELECT delivery_id AS id, * FROM webhook_deliveries WHERE delivery_id = ?"
  );
  const listProcessableDeliveriesStmt = db.prepare(`
    SELECT delivery_id AS id, * FROM webhook_deliveries
    WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
      OR (status = 'processing' AND next_attempt_at <= ?))
    ORDER BY received_at
    LIMIT ?
  `);
  const pruneDeliveriesStmt = db.prepare(
    "DELETE FROM webhook_deliveries WHERE received_at < ?"
  );
  const insertSandboxEventStmt = db.prepare(`
    INSERT OR IGNORE INTO sandbox_events (
      event_id, run_id, sandbox_id, kind, payload, status,
      attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getSandboxEventStmt = db.prepare("SELECT * FROM sandbox_events WHERE event_id = ?");
  const pruneSandboxEventsStmt = db.prepare(`
    DELETE FROM sandbox_events
    WHERE status = 'processed' AND processed_at < ?
      AND (kind = 'heartbeat'
        OR (kind = 'activity' AND json_extract(payload, '$.ephemeral') IS 1))
  `);
  const pruneEphemeralLinearOutboxStmt = db.prepare(`
    DELETE FROM linear_outbox
    WHERE status = 'processed' AND processed_at < ?
      AND kind = 'activity'
      AND json_extract(payload, '$.activity.ephemeral') IS 1
  `);
  const listClaimableLinearOutboxRowsStmt = db.prepare(`
    SELECT * FROM linear_outbox candidate
    WHERE ((candidate.status IN ('pending', 'failed') AND candidate.next_attempt_at <= ?)
      OR (candidate.status = 'processing' AND candidate.next_attempt_at <= ?))
      AND NOT EXISTS (
        SELECT 1 FROM linear_outbox earlier
        WHERE earlier.linear_session_id IS candidate.linear_session_id
          AND earlier.sequence < candidate.sequence
          AND earlier.kind <> 'pipeline_status'
          AND earlier.status IN ('pending', 'processing', 'failed')
      )
    ORDER BY candidate.created_at, candidate.sequence
    LIMIT ?
  `);
  const claimLinearOutboxRowStmt = db.prepare(`
    UPDATE linear_outbox
    SET status = 'processing', attempts = attempts + 1,
        next_attempt_at = ?, last_error = NULL
    WHERE id = ?
      AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND next_attempt_at <= ?))
  `);
  const enqueueLinearOutboxTransaction = db.transaction(
    (params: {
      id?: string;
      linearSessionId?: string | null;
      issueId?: string | null;
      runId?: string | null;
      kind: LinearOutboxRecord["kind"];
      payload: string;
    }): LinearOutboxRecord => {
      const timestamp = now();
      const id = params.id ?? randomUUID();
      const existing = getLinearOutboxStmt.get(id) as LinearOutboxRecord | undefined;
      const payloadHash = hashPayload(params.payload);
      if (existing) {
        if (
          existing.linear_session_id !== (params.linearSessionId ?? null) ||
          existing.linear_issue_id !== (params.issueId ?? null) ||
          existing.run_id !== (params.runId ?? null) ||
          existing.kind !== params.kind ||
          existing.payload_hash !== payloadHash
        ) {
          throw new Error(`linear outbox id ${id} already exists with different intent`);
        }
        return existing;
      }
      const sequence = (nextOutboxSequenceStmt.get(params.linearSessionId ?? null) as {
        sequence: number;
      }).sequence;
      insertLinearOutboxStmt.run(
        id,
        params.linearSessionId ?? null,
        params.issueId ?? null,
        params.runId ?? null,
        sequence,
        params.kind,
        params.payload,
        payloadHash,
        timestamp,
        timestamp
      );
      return getLinearOutboxStmt.get(id) as LinearOutboxRecord;
    }
  );
  const claimDeliveryForProcessingTransaction = db.transaction(
    (params: {
      deliveryId: string;
      nowIso: string;
      leaseUntilIso: string;
    }): WebhookDelivery | undefined => {
      const update = db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE delivery_id = ?
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(params.leaseUntilIso, params.deliveryId, params.nowIso, params.nowIso);
      if (update.changes !== 1) return undefined;
      return getDeliveryStmt.get(params.deliveryId) as WebhookDelivery;
    }
  );
  const claimSandboxEventTransaction = db.transaction(
    (eventId: string, nowIso: string, leaseUntilIso: string): SandboxEventRecord | undefined => {
      const updated = db.prepare(`
        UPDATE sandbox_events
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE event_id = ?
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(leaseUntilIso, eventId, nowIso, nowIso);
      if (updated.changes !== 1) return undefined;
      return getSandboxEventStmt.get(eventId) as SandboxEventRecord;
    }
  );
  const listClaimableLinearOutboxRows = (nowIso: string, limit: number): LinearOutboxRecord[] =>
    listClaimableLinearOutboxRowsStmt.all(nowIso, nowIso, limit) as LinearOutboxRecord[];
  const claimLinearOutboxRows = (
    rows: LinearOutboxRecord[],
    nowIso: string,
    leaseUntilIso: string
  ): LinearOutboxRecord[] => {
    const claimed: LinearOutboxRecord[] = [];
    for (const row of rows) {
      const update = claimLinearOutboxRowStmt.run(leaseUntilIso, row.id, nowIso, nowIso);
      if (update.changes === 1) claimed.push(getLinearOutboxStmt.get(row.id) as LinearOutboxRecord);
    }
    return claimed;
  };
  return {
    enqueueLinearOutbox(params) {
      return enqueueLinearOutboxTransaction(params);
    },
    claimLinearOutbox(nowIso, leaseUntilIso, limit) {
      return claimLinearOutboxRows(listClaimableLinearOutboxRows(nowIso, limit), nowIso, leaseUntilIso);
    },
    claimLinearOutboxForId(id, nowIso, leaseUntilIso, limit) {
      const rows = listClaimableLinearOutboxRows(nowIso, limit);
      if (!rows.some((row) => row.id === id)) return [];
      return claimLinearOutboxRows(rows, nowIso, leaseUntilIso);
    },
    markLinearOutboxProcessed(id, receipt, expectedPayloadHash) {
      db.transaction(() => {
        const processedAt = now();
        const update = db.prepare(`
          UPDATE linear_outbox
          SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL,
              external_id = COALESCE(?, external_id),
              external_url = COALESCE(?, external_url),
              attachment_url = COALESCE(?, attachment_url)
          WHERE id = ?
            AND (? IS NULL OR payload_hash = ?)
        `).run(
          processedAt,
          processedAt,
          receipt?.externalId ?? null,
          receipt?.externalUrl ?? null,
          receipt?.attachmentUrl ?? null,
          id,
          expectedPayloadHash ?? null,
          expectedPayloadHash ?? null
        );
        if (update.changes !== 1) return;
        const publication = db.prepare(`
          SELECT * FROM pipeline_publication_receipts WHERE id = ?
        `).get(id) as {
          pipeline_instance_id: string;
          resume_status: string | null;
          status: string;
        } | undefined;
        if (!publication) return;
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = 'acknowledged', external_id = COALESCE(?, external_id),
              external_url = COALESCE(?, external_url),
              attachment_url = COALESCE(?, attachment_url), acknowledged_at = ?,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          receipt?.externalId ?? null,
          receipt?.externalUrl ?? null,
          receipt?.attachmentUrl ?? null,
          processedAt,
          processedAt,
          id
        );
        if (publication.resume_status) {
          db.prepare(`
            UPDATE pipeline_instances
            SET status = ?, state_version = state_version + 1,
                wait_reason = CASE WHEN ? = 'waiting_human' THEN wait_reason ELSE NULL END,
                updated_at = ?
            WHERE id = ? AND status = 'completion_pending_publication'
          `).run(
            publication.resume_status,
            publication.resume_status,
            processedAt,
            publication.pipeline_instance_id
          );
        }
      })();
    },
    markLinearOutboxFailed(id, error, retryAt, expectedPayloadHash) {
      db.transaction(() => {
        const timestamp = now();
        const status = retryAt ? "failed" : "dead";
        const update = db.prepare(`
          UPDATE linear_outbox
          SET status = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?
            AND (? IS NULL OR payload_hash = ?)
        `).run(status, retryAt ?? timestamp, error, id, expectedPayloadHash ?? null, expectedPayloadHash ?? null);
        if (update.changes !== 1) return;
        const publication = db.prepare(`
          SELECT pipeline_instance_id FROM pipeline_publication_receipts WHERE id = ?
        `).get(id) as { pipeline_instance_id: string } | undefined;
        if (!publication) return;
        const instanceStatus = db.prepare(
          "SELECT status FROM pipeline_instances WHERE id = ?"
        ).pluck().get(publication.pipeline_instance_id) as string | undefined;
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = ?, attempts = (
                SELECT attempts FROM linear_outbox WHERE linear_outbox.id = pipeline_publication_receipts.id
              ),
              next_attempt_at = ?, last_error = ?, updated_at = ?,
              blocked_from_status = CASE WHEN ? = 'dead' THEN COALESCE(
                blocked_from_status, ?
              ) ELSE blocked_from_status END
          WHERE id = ?
        `).run(status, retryAt ?? timestamp, error, timestamp, status, instanceStatus ?? null, id);
        if (status === "dead") {
          db.prepare(`
            UPDATE pipeline_instances
            SET status = 'publication_blocked', state_version = state_version + 1,
                wait_reason = 'permanent publication failure', updated_at = ?
            WHERE id = ? AND status NOT IN (
              'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed',
              'publication_blocked'
            )
          `).run(timestamp, publication.pipeline_instance_id);
        }
      })();
    },
    recordLinearOutboxAttachment(id, attachmentUrl) {
      const updated = db.prepare(`
        UPDATE linear_outbox SET attachment_url = ?
        WHERE id = ? AND status = 'processing'
      `).run(attachmentUrl, id);
      if (updated.changes !== 1) throw new Error(`linear outbox ${id} is not processing`);
    },
    getLinearOutbox(id) {
      return getLinearOutboxStmt.get(id) as LinearOutboxRecord | undefined;
    },
    listLinearOutbox() {
      return listLinearOutboxStmt.all() as LinearOutboxRecord[];
    },
    claimDelivery(claim) {
      const receivedAt = now();
      return (
        claimDeliveryStmt.run(
          claim.deliveryId,
          claim.source,
          claim.sessionId ?? null,
          claim.action,
          claim.activityId ?? null,
          claim.eventName ?? null,
          claim.payload ?? null,
          receivedAt,
          receivedAt
        ).changes === 1
      );
    },
    claimDeliveryForProcessing(params) {
      return claimDeliveryForProcessingTransaction(params);
    },
    markDeliveryProcessed(deliveryId) {
      const processedAt = now();
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processed', processed_at = ?, next_attempt_at = NULL, last_error = NULL
        WHERE delivery_id = ?
      `).run(processedAt, deliveryId);
    },
    markDeliveryFailed(deliveryId, error, retryAt) {
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE delivery_id = ?
      `).run(retryAt ? "failed" : "dead", retryAt, error, deliveryId);
    },
    listProcessableDeliveries(nowIso, limit) {
      return listProcessableDeliveriesStmt.all(nowIso, nowIso, limit) as WebhookDelivery[];
    },
    pruneDeliveries(beforeIso) {
      return pruneDeliveriesStmt.run(beforeIso).changes;
    },
    insertSandboxEvent(params) {
      const createdAt = now();
      insertSandboxEventStmt.run(
        params.eventId,
        params.runId,
        params.sandboxId,
        params.kind,
        params.payload,
        createdAt,
        createdAt
      );
      return getSandboxEventStmt.get(params.eventId) as SandboxEventRecord;
    },
    getSandboxEvent(eventId) {
      return getSandboxEventStmt.get(eventId) as SandboxEventRecord | undefined;
    },
    claimSandboxEvent(eventId, nowIso, leaseUntilIso) {
      return claimSandboxEventTransaction(eventId, nowIso, leaseUntilIso);
    },
    markSandboxEventProcessed(eventId) {
      const processedAt = now();
      db.prepare(`
        UPDATE sandbox_events
        SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE event_id = ?
      `).run(processedAt, processedAt, eventId);
    },
    markSandboxEventFailed(eventId, error, retryAt) {
      db.prepare(`
        UPDATE sandbox_events
        SET status = 'failed', next_attempt_at = ?, last_error = ?
        WHERE event_id = ?
      `).run(retryAt, error, eventId);
    },
    markSandboxEventDiagnosed(eventId, diagnosedAt) {
      return db.prepare(`
        UPDATE sandbox_events
        SET ingestion_diagnosed_at = ?
        WHERE event_id = ? AND ingestion_diagnosed_at IS NULL
      `).run(diagnosedAt, eventId).changes === 1;
    },
    pruneSandboxEvents(beforeIso) {
      return pruneSandboxEventsStmt.run(beforeIso).changes;
    },
    pruneEphemeralLinearOutbox(beforeIso) {
      return pruneEphemeralLinearOutboxStmt.run(beforeIso).changes;
    },
  };
}
