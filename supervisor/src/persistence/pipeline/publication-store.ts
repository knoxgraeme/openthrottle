import type Database from "better-sqlite3";
import type {
  PipelinePublicationReceipt,
  PipelineStore,
} from "../../pipeline/store.js";
import {
  blockPublicationInstanceOnDead,
  claimLeasable,
  markQueueFailed,
} from "./helpers.js";

export function createPublicationStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  | "claimGithubPublications"
  | "bindGithubPublicationTarget"
  | "markGithubPublicationProcessed"
  | "requeueGithubPublicationAfterStaleWrite"
  | "markGithubPublicationSkipped"
  | "markGithubPublicationFailed"
  | "retryPublication"
  | "isSupervisorGithubComment"
> {
  const claimGithubPublications = db.transaction((
    nowIso: string,
    leaseUntilIso: string,
    limit = 50
  ): PipelinePublicationReceipt[] => {
    const candidates = db.prepare(`
      SELECT id FROM pipeline_publication_receipts
      WHERE kind = 'github_summary'
        AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'processing' AND next_attempt_at <= ?))
      ORDER BY next_attempt_at, created_at, id LIMIT ?
    `).all(nowIso, nowIso, limit) as Array<{ id: string }>;
    return claimLeasable({
      rows: candidates,
      nowIso,
      leaseUntilIso,
      update: (id, lease, nowValue) => db.prepare(`
        UPDATE pipeline_publication_receipts
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND kind = 'github_summary'
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(lease, nowValue, id, nowValue, nowValue).changes,
      get: (id) => db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
        .get(id) as PipelinePublicationReceipt,
    });
  });

  const bindGithubPublicationTarget = db.transaction((
    id: string,
    expectedPayloadHash: string,
    targetUrl: string
  ): PipelinePublicationReceipt | undefined => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication || publication.kind !== "github_summary" ||
        publication.status !== "processing" || publication.payload_hash !== expectedPayloadHash) {
      return undefined;
    }
    if (publication.target_url) {
      return publication.target_url === targetUrl ? publication : undefined;
    }
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET target_url = ?, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash = ? AND target_url IS NULL
        AND EXISTS (
          SELECT 1
          FROM pipeline_instances pi
          JOIN tickets t ON t.ticket_id = pi.ticket_id
          WHERE pi.id = pipeline_publication_receipts.pipeline_instance_id
            AND t.session_id = pi.session_id
            AND (
              t.pr_url = ?
              OR (
                t.control_provider = 'github'
                AND ? = 'https://github.com/' || replace(t.external_thread_id, '#', '/issues/')
              )
            )
        )
    `).run(targetUrl, now(), id, expectedPayloadHash, targetUrl, targetUrl);
    if (update.changes !== 1) return undefined;
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt;
  });

  const markGithubPublicationProcessed = db.transaction((
    id: string,
    expectedPayloadHash: string,
    externalId: string,
    externalUrl: string
  ): boolean => {
    const timestamp = now();
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'acknowledged', external_id = ?, external_url = ?,
          acknowledged_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash = ?
    `).run(externalId, externalUrl, timestamp, timestamp, id, expectedPayloadHash);
    return update.changes === 1;
  });

  const requeueGithubPublicationAfterStaleWrite = db.transaction((
    id: string,
    stalePayloadHash: string,
    externalId: string,
    externalUrl: string
  ): boolean => {
    const timestamp = now();
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'pending', next_attempt_at = ?, last_error = NULL,
          external_id = ?, external_url = ?, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash <> ?
    `).run(timestamp, externalId, externalUrl, timestamp, id, stalePayloadHash);
    return update.changes === 1;
  });

  const markGithubPublicationSkipped = db.transaction((
    id: string,
    expectedPayloadHash: string
  ): boolean => {
    const timestamp = now();
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'acknowledged', external_id = 'skipped:no-pull-request',
          external_url = NULL, acknowledged_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash = ? AND target_url IS NULL
    `).run(timestamp, timestamp, id, expectedPayloadHash);
    return update.changes === 1;
  });

  const markGithubPublicationFailed = db.transaction((
    id: string,
    expectedPayloadHash: string,
    error: string,
    retryAt: string | null
  ): boolean => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication || publication.kind !== "github_summary" ||
        publication.status !== "processing" || publication.payload_hash !== expectedPayloadHash) return false;
    const timestamp = now();
    const instance = db.prepare("SELECT status, state_version FROM pipeline_instances WHERE id = ?")
      .get(publication.pipeline_instance_id) as { status: string; state_version: number };
    const status = markQueueFailed({
      error,
      retryAt,
      timestamp,
      update: (statusValue, nextAttemptAt, errorValue) => db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?,
          blocked_from_status = CASE WHEN ? = 'dead' THEN COALESCE(blocked_from_status, ?) ELSE blocked_from_status END
      WHERE id = ?
    `).run(
        statusValue,
        nextAttemptAt,
        errorValue,
        timestamp,
        statusValue,
        instance.status,
        id
      ).changes,
    });
    if (!status) return false;
    blockPublicationInstanceOnDead({
      db,
      id,
      status,
      timestamp,
      instanceVersion: instance.state_version,
    });
    return true;
  });

  const retryPublication = db.transaction((id: string): PipelinePublicationReceipt => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication) throw new Error(`unknown pipeline publication ${id}`);
    if (publication.status !== "dead" && publication.status !== "failed") {
      throw new Error(`pipeline publication ${id} is not recoverable`);
    }
    const timestamp = now();
    db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, id);
    if (publication.kind === "control_ledger") {
      // Reset attempts along with status: MAX_LINEAR_OUTBOX_ATTEMPTS caps a
      // row's own automatic retries, but an operator-triggered retry through
      // this endpoint is a distinct, deliberate recovery action and must get
      // a fresh attempt budget -- otherwise a row already at the cap dies
      // again on its very next failure regardless of this reset.
      const update = db.prepare(`
        UPDATE control_outbox
        SET status = 'pending', next_attempt_at = ?, last_error = NULL, processed_at = NULL, attempts = 0
        WHERE id = ? AND status IN ('dead', 'failed')
      `).run(timestamp, id);
      if (update.changes !== 1) throw new Error(`pipeline publication ${id} has no recoverable outbox row`);
    }
    const remainingDead = db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ? AND status = 'dead'
    `).get(publication.pipeline_instance_id) as { count: number };
    if (remainingDead.count === 0) {
      db.prepare(`
        UPDATE pipeline_instances
        SET status = ?, wait_reason = NULL, state_version = state_version + 1, updated_at = ?
        WHERE id = ? AND status = 'publication_blocked'
      `).run(publication.blocked_from_status ?? "completion_pending_publication", timestamp, publication.pipeline_instance_id);
    }
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt;
  });

  // Provenance for the solo-operator feedback filter: the supervisor knows
  // exactly which GitHub comment IDs it has ever written, because the upsert
  // acknowledgement persists them as github_summary external IDs.
  const isSupervisorGithubCommentStmt = db.prepare(`
    SELECT 1 FROM pipeline_publication_receipts
    WHERE kind = 'github_summary' AND external_id = ? LIMIT 1
  `);

  return {
    claimGithubPublications,
    bindGithubPublicationTarget,
    markGithubPublicationProcessed,
    requeueGithubPublicationAfterStaleWrite,
    markGithubPublicationSkipped,
    markGithubPublicationFailed,
    retryPublication,
    isSupervisorGithubComment: (externalId: string) =>
      isSupervisorGithubCommentStmt.get(externalId) !== undefined,
  };
}
