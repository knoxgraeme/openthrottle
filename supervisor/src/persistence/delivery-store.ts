import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  acknowledgePublicationReceipt,
  claimLeasable,
  failPublicationReceipt,
  markQueueFailed,
} from "./pipeline/helpers.js";

export interface DeliveryClaim {
  deliveryId: string;
  source: "linear" | "github";
  sessionId?: string;
  action: string;
  eventName?: string;
  payload?: string;
}

export interface WebhookDelivery {
  id: string;
  source: "linear" | "github";
  session_id: string | null;
  action: string;
  event_name: string | null;
  payload: string | null;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  redelivered_at: string | null;
  received_at: string;
}

export interface SandboxEventRecord {
  event_id: string;
  run_id: string;
  sandbox_id: string;
  kind: "activity" | "plan" | "heartbeat" | "stage_result";
  payload: string;
  status: "pending" | "processing" | "failed" | "processed";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  ingestion_diagnosed_at: string | null;
  created_at: string;
}

export interface LinearOutboxRecord {
  id: string;
  session_id: string | null;
  ticket_id: string | null;
  run_id: string | null;
  sequence: number;
  kind: "activity" | "session_update" | "pipeline_receipt" | "pipeline_status" | "issue_state";
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  external_id: string | null;
  external_url: string | null;
  attachment_url: string | null;
  created_at: string;
}

export interface DeliveryStore {
  enqueueLinearOutbox(params: {
    id?: string;
    sessionId?: string | null;
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
  claimDelivery(claim: DeliveryClaim): boolean;
  claimDeliveryForProcessing(params: {
    deliveryId: string;
    nowIso: string;
    leaseUntilIso: string;
  }): WebhookDelivery | undefined;
  markDeliveryProcessed(deliveryId: string): void;
  markDeliveryFailed(deliveryId: string, error: string, retryAt: string | null): void;
  githubIssueAdmissionInFlight(repository: string, issueNumber: number): boolean;
  requeueDeadDeliveriesForRedelivery(
    source: WebhookDelivery["source"],
    repository: string,
    nowIso: string,
    limit: number
  ): number;
  requeueDeliveryAfterProviderRedelivery(
    source: WebhookDelivery["source"],
    deliveryId: string,
    nowIso: string
  ): boolean;
  claimGithubWebhookRedelivery(input: {
    repository: string;
    webhookId: number;
    deliveryId: number;
    deliveryGuid: string;
    deliveredAt: string;
    nowIso: string;
    leaseUntilIso: string;
  }): boolean;
  markGithubWebhookRedeliveryAccepted(input: {
    repository: string;
    webhookId: number;
    deliveryId: number;
    nowIso: string;
  }): boolean;
  markGithubWebhookRedeliveryFailed(input: {
    repository: string;
    webhookId: number;
    deliveryId: number;
    error: string;
    retryAt: string;
  }): boolean;
  listProcessableDeliveries(nowIso: string, limit: number): WebhookDelivery[];
  pruneDeliveries(beforeIso: string): number;
  pruneAcceptedGithubWebhookRedeliveryRequests(beforeIso: string, limit: number): number;
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
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM control_outbox WHERE session_id IS ?"
  );
  const insertLinearOutboxStmt = db.prepare(`
    INSERT INTO control_outbox (
      id, session_id, ticket_id, run_id, sequence, kind,
      payload, payload_hash, status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getLinearOutboxStmt = db.prepare("SELECT * FROM control_outbox WHERE id = ?");
  const claimDeliveryStmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries (
      delivery_id, source, session_id, action, event_name,
      payload, status, attempts, next_attempt_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
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
  const githubIssueAdmissionInFlightStmt = db.prepare(`
    SELECT 1
    FROM webhook_deliveries
    WHERE source = 'github'
      AND event_name = 'issues'
      AND status IN ('pending', 'processing', 'failed')
      AND next_attempt_at IS NOT NULL
      AND json_valid(payload)
      AND lower(json_extract(payload, '$.repository.full_name')) = lower(?)
      AND json_extract(payload, '$.issue.number') = ?
      AND (
        (action = 'issues:labeled'
          AND json_extract(payload, '$.label.name') = 'openthrottle')
        OR
        (action IN ('issues:opened', 'issues:reopened')
          AND EXISTS (
            SELECT 1
            FROM json_each(json_extract(payload, '$.issue.labels')) AS label
            WHERE json_extract(label.value, '$.name') = 'openthrottle'
          ))
      )
    LIMIT 1
  `);
  const listRedeliverableDeliveriesStmt = db.prepare(`
    SELECT delivery_id
    FROM webhook_deliveries
    WHERE source = ?
      AND status = 'dead'
      AND redelivered_at IS NULL
      AND lower(json_extract(payload, '$.repository.full_name')) = lower(?)
    ORDER BY received_at
    LIMIT ?
  `);
  const requeueDeliveryForRedeliveryStmt = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'pending',
        next_attempt_at = ?,
        last_error = NULL,
        redelivered_at = ?
    WHERE delivery_id = ?
      AND source = ?
      AND status = 'dead'
      AND redelivered_at IS NULL
  `);
  const requeueExactDeliveryAfterProviderRedeliveryStmt = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'pending',
        next_attempt_at = ?,
        last_error = NULL,
        redelivered_at = ?
    WHERE delivery_id = ?
      AND source = ?
      AND status IN ('failed', 'dead')
      AND redelivered_at IS NULL
  `);
  const pruneDeliveriesStmt = db.prepare(
    "DELETE FROM webhook_deliveries WHERE received_at < ?"
  );
  const pruneAcceptedGithubWebhookRedeliveryRequestsStmt = db.prepare(`
    DELETE FROM github_webhook_redelivery_requests
    WHERE rowid IN (
      SELECT rowid
      FROM github_webhook_redelivery_requests
      WHERE status = 'accepted' AND accepted_at < ?
      ORDER BY accepted_at, repository, webhook_id, delivery_id
      LIMIT ?
    )
  `);
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
    DELETE FROM control_outbox
    WHERE status = 'processed' AND processed_at < ?
      AND kind = 'activity'
      AND json_extract(payload, '$.activity.ephemeral') IS 1
  `);
  const listClaimableLinearOutboxRowsStmt = db.prepare(`
    SELECT * FROM control_outbox candidate
    WHERE ((candidate.status IN ('pending', 'failed') AND candidate.next_attempt_at <= ?)
      OR (candidate.status = 'processing' AND candidate.next_attempt_at <= ?))
      AND (candidate.kind = 'issue_state' OR NOT EXISTS (
        SELECT 1 FROM control_outbox earlier
        WHERE earlier.session_id IS candidate.session_id
          AND earlier.sequence < candidate.sequence
          AND earlier.kind NOT IN ('pipeline_status', 'issue_state')
          AND earlier.status IN ('pending', 'processing', 'failed')
      ))
    ORDER BY candidate.created_at, candidate.sequence
    LIMIT ?
  `);
  const claimLinearOutboxRowStmt = db.prepare(`
    UPDATE control_outbox
    SET status = 'processing', attempts = attempts + 1,
        next_attempt_at = ?, last_error = NULL
    WHERE id = ?
      AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND next_attempt_at <= ?))
  `);
  const enqueueLinearOutboxTransaction = db.transaction(
    (params: {
      id?: string;
      sessionId?: string | null;
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
          existing.session_id !== (params.sessionId ?? null) ||
          existing.ticket_id !== (params.issueId ?? null) ||
          existing.run_id !== (params.runId ?? null) ||
          existing.kind !== params.kind ||
          existing.payload_hash !== payloadHash
        ) {
          throw new Error(`linear outbox id ${id} already exists with different intent`);
        }
        return existing;
      }
      const sequence = (nextOutboxSequenceStmt.get(params.sessionId ?? null) as {
        sequence: number;
      }).sequence;
      insertLinearOutboxStmt.run(
        id,
        params.sessionId ?? null,
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
  const requeueDeadDeliveriesForRedeliveryTransaction = db.transaction((
    source: WebhookDelivery["source"],
    repository: string,
    nowIso: string,
    limit: number
  ): number => {
    const rows = listRedeliverableDeliveriesStmt.all(source, repository, limit) as Array<{ delivery_id: string }>;
    return rows.reduce((count, row) => count + requeueDeliveryForRedeliveryStmt.run(
      nowIso,
      nowIso,
      row.delivery_id,
      source
    ).changes, 0);
  });
  const claimGithubWebhookRedeliveryTransaction = db.transaction((input: {
    repository: string;
    webhookId: number;
    deliveryId: number;
    deliveryGuid: string;
    deliveredAt: string;
    nowIso: string;
    leaseUntilIso: string;
  }): boolean => db.prepare(`
    INSERT INTO github_webhook_redelivery_requests (
      repository, webhook_id, delivery_id, delivery_guid, delivered_at,
      status, attempts, next_attempt_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'claimed', 1, ?, ?)
    ON CONFLICT(repository, webhook_id, delivery_id) DO UPDATE SET
      status = 'claimed',
      attempts = github_webhook_redelivery_requests.attempts + 1,
      next_attempt_at = excluded.next_attempt_at,
      last_error = NULL,
      updated_at = excluded.updated_at
    WHERE github_webhook_redelivery_requests.delivery_guid = excluded.delivery_guid
      AND github_webhook_redelivery_requests.delivered_at = excluded.delivered_at
      AND github_webhook_redelivery_requests.status IN ('claimed', 'failed')
      AND github_webhook_redelivery_requests.next_attempt_at <= ?
  `).run(
    input.repository,
    input.webhookId,
    input.deliveryId,
    input.deliveryGuid,
    input.deliveredAt,
    input.leaseUntilIso,
    input.nowIso,
    input.nowIso
  ).changes === 1);
  const listClaimableLinearOutboxRows = (nowIso: string, limit: number): LinearOutboxRecord[] =>
    listClaimableLinearOutboxRowsStmt.all(nowIso, nowIso, limit) as LinearOutboxRecord[];
  const claimLinearOutboxRows = (
    rows: LinearOutboxRecord[],
    nowIso: string,
    leaseUntilIso: string
  ): LinearOutboxRecord[] =>
    claimLeasable({
      rows,
      nowIso,
      leaseUntilIso,
      update: (id, lease, nowValue) =>
        claimLinearOutboxRowStmt.run(lease, id, nowValue, nowValue).changes,
      get: (id) => getLinearOutboxStmt.get(id) as LinearOutboxRecord,
    });
  return {
    enqueueLinearOutbox(params) {
      return enqueueLinearOutboxTransaction(params);
    },
    claimLinearOutbox(nowIso, leaseUntilIso, limit) {
      return claimLinearOutboxRows(listClaimableLinearOutboxRows(nowIso, limit), nowIso, leaseUntilIso);
    },
    claimLinearOutboxForId(id, nowIso, leaseUntilIso, limit) {
      const rows = listClaimableLinearOutboxRows(nowIso, limit);
      const target = rows.find((row) => row.id === id);
      if (!target) return [];
      return claimLinearOutboxRows(
        rows.filter((row) =>
          row.session_id === target.session_id && row.sequence <= target.sequence
        ),
        nowIso,
        leaseUntilIso
      );
    },
    markLinearOutboxProcessed(id, receipt, expectedPayloadHash) {
      db.transaction(() => {
        const processedAt = now();
        const update = db.prepare(`
          UPDATE control_outbox
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
        acknowledgePublicationReceipt({ db, id, timestamp: processedAt, receipt });
      })();
    },
    markLinearOutboxFailed(id, error, retryAt, expectedPayloadHash) {
      db.transaction(() => {
        const timestamp = now();
        const attempts = (db.prepare("SELECT attempts FROM control_outbox WHERE id = ?")
          .get(id) as { attempts: number } | undefined)?.attempts;
        const status = markQueueFailed({
          error,
          retryAt,
          timestamp,
          update: (statusValue, nextAttemptAt, errorValue) => db.prepare(`
          UPDATE control_outbox
          SET status = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?
            AND (? IS NULL OR payload_hash = ?)
        `).run(
            statusValue,
            nextAttemptAt,
            errorValue,
            id,
            expectedPayloadHash ?? null,
            expectedPayloadHash ?? null
          ).changes,
        });
        if (!status) return;
        failPublicationReceipt({
          db,
          id,
          status,
          nextAttemptAt: retryAt ?? timestamp,
          error,
          timestamp,
          attempts,
        });
      })();
    },
    recordLinearOutboxAttachment(id, attachmentUrl) {
      const updated = db.prepare(`
        UPDATE control_outbox SET attachment_url = ?
        WHERE id = ? AND status = 'processing'
      `).run(attachmentUrl, id);
      if (updated.changes !== 1) throw new Error(`linear outbox ${id} is not processing`);
    },
    claimDelivery(claim) {
      const receivedAt = now();
      return (
        claimDeliveryStmt.run(
          claim.deliveryId,
          claim.source,
          claim.sessionId ?? null,
          claim.action,
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
      // Only a claimed delivery may settle. Without the status fence a worker
      // finishing after its lease expired could resurrect a delivery another
      // worker already drove to 'dead' (or re-settle a requeued one) and erase
      // the operator-visible failure. Silent no-op matches
      // markLinearOutboxProcessed above: the caller's own claim is the fence.
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processed', processed_at = ?, next_attempt_at = NULL, last_error = NULL
        WHERE delivery_id = ?
          AND status = 'processing'
      `).run(processedAt, deliveryId);
    },
    markDeliveryFailed(deliveryId, error, retryAt) {
      const timestamp = now();
      markQueueFailed({
        error,
        retryAt,
        timestamp,
        deadNextAttemptAt: null,
        update: (status, nextAttemptAt, errorValue) => db.prepare(`
        UPDATE webhook_deliveries
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE delivery_id = ?
      `).run(status, nextAttemptAt, errorValue, deliveryId).changes,
      });
    },
    githubIssueAdmissionInFlight(repository, issueNumber) {
      return Boolean(githubIssueAdmissionInFlightStmt.get(repository, issueNumber));
    },
    requeueDeadDeliveriesForRedelivery(source, repository, nowIso, limit) {
      return requeueDeadDeliveriesForRedeliveryTransaction(source, repository, nowIso, limit);
    },
    requeueDeliveryAfterProviderRedelivery(source, deliveryId, nowIso) {
      return requeueExactDeliveryAfterProviderRedeliveryStmt.run(
        nowIso,
        nowIso,
        deliveryId,
        source
      ).changes === 1;
    },
    claimGithubWebhookRedelivery(input) {
      return claimGithubWebhookRedeliveryTransaction.immediate(input);
    },
    markGithubWebhookRedeliveryAccepted(input) {
      return db.prepare(`
        UPDATE github_webhook_redelivery_requests
        SET status = 'accepted', accepted_at = ?, next_attempt_at = ?,
            last_error = NULL, updated_at = ?
        WHERE repository = ? AND webhook_id = ? AND delivery_id = ?
          AND status = 'claimed'
      `).run(
        input.nowIso,
        input.nowIso,
        input.nowIso,
        input.repository,
        input.webhookId,
        input.deliveryId
      ).changes === 1;
    },
    markGithubWebhookRedeliveryFailed(input) {
      return db.prepare(`
        UPDATE github_webhook_redelivery_requests
        SET status = 'failed', next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE repository = ? AND webhook_id = ? AND delivery_id = ?
          AND status = 'claimed'
      `).run(
        input.retryAt,
        input.error,
        now(),
        input.repository,
        input.webhookId,
        input.deliveryId
      ).changes === 1;
    },
    listProcessableDeliveries(nowIso, limit) {
      return listProcessableDeliveriesStmt.all(nowIso, nowIso, limit) as WebhookDelivery[];
    },
    pruneDeliveries(beforeIso) {
      return pruneDeliveriesStmt.run(beforeIso).changes;
    },
    pruneAcceptedGithubWebhookRedeliveryRequests(beforeIso, limit) {
      return pruneAcceptedGithubWebhookRedeliveryRequestsStmt.run(beforeIso, limit).changes;
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
      // Same fence as markDeliveryProcessed: only the claim holder's
      // processing lease may settle the event; a late worker must not
      // overwrite a state another worker has since advanced.
      db.prepare(`
        UPDATE sandbox_events
        SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE event_id = ?
          AND status = 'processing'
      `).run(processedAt, processedAt, eventId);
    },
    markSandboxEventFailed(eventId, error, retryAt) {
      markQueueFailed({
        error,
        retryAt,
        timestamp: retryAt,
        update: (_status, nextAttemptAt, errorValue) => db.prepare(`
        UPDATE sandbox_events
        SET status = 'failed', next_attempt_at = ?, last_error = ?
        WHERE event_id = ?
      `).run(nextAttemptAt, errorValue, eventId).changes,
      });
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
