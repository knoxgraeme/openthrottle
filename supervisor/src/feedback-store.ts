import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface FeedbackSnapshot {
  id: string;
  linear_issue_id: string;
  linear_session_id: string;
  generation: number;
  head_sha: string;
  provider_watermark: string;
  status: "collecting" | "claimed" | "consumed" | "stale";
  repair_round: number | null;
  work_item_id: string | null;
  created_at: string;
  claimed_at: string | null;
  consumed_at: string | null;
}

export interface FeedbackSnapshotEvent {
  provider: string;
  provider_event_id: string;
  kind: string;
  payload: string;
}

export interface FeedbackRecordParams {
  provider: "github";
  providerEventId: string;
  issueId: string;
  sessionId: string;
  generation: number;
  repository: string;
  pullNumber: number;
  headSha: string;
  kind: string;
  payload: string;
  workItemId: string;
  workBody?: string;
  receivedAt?: string;
}

export interface FeedbackStore {
  record(params: FeedbackRecordParams): {
    snapshot: FeedbackSnapshot;
    eventInserted: boolean;
    snapshotCreated: boolean;
  };
  claim(snapshotId: string, maxRounds: number):
    | { status: "claimed"; snapshot: FeedbackSnapshot }
    | { status: "exhausted"; completedRounds: number }
    | { status: "stale" };
  consume(snapshotId: string): boolean;
  get(snapshotId: string): FeedbackSnapshot | undefined;
  listEvents(snapshotId: string): FeedbackSnapshotEvent[];
}

export function createFeedbackStore(db: Database.Database): FeedbackStore {
  const getSnapshot = db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?");
  const recordTransaction = db.transaction((params: Parameters<FeedbackStore["record"]>[0]) => {
    const receivedAt = params.receivedAt ?? new Date().toISOString();
    const payloadHash = createHash("sha256").update(params.payload).digest("hex");
    const existingEvent = db.prepare(`
      SELECT payload_hash, snapshot_id FROM provider_events
      WHERE provider = ? AND provider_event_id = ?
    `).get(params.provider, params.providerEventId) as
      | { payload_hash: string; snapshot_id: string | null }
      | undefined;
    if (existingEvent) {
      if (existingEvent.payload_hash !== payloadHash) {
        throw new Error(`provider event ${params.provider}:${params.providerEventId} changed payload`);
      }
      if (!existingEvent.snapshot_id) {
        throw new Error(`provider event ${params.provider}:${params.providerEventId} is unassigned`);
      }
      return {
        snapshot: getSnapshot.get(existingEvent.snapshot_id) as FeedbackSnapshot,
        eventInserted: false,
        snapshotCreated: false,
      };
    }

    // Conversation comments survive head changes and must never share the
    // unique commit-scoped snapshot key with reviews/checks. Provider events
    // retain the actual head SHA; only the snapshot grouping key is namespaced.
    const snapshotHeadSha = params.kind === "issue_comment"
      ? `conversation:${params.headSha}`
      : params.headSha;
    let snapshot = db.prepare(`
      SELECT * FROM feedback_snapshots
      WHERE linear_issue_id = ? AND linear_session_id = ? AND generation = ?
        AND head_sha = ? AND status = 'collecting'
        AND (
          (? = 'issue_comment' AND NOT EXISTS (
            SELECT 1 FROM feedback_snapshot_events fse
            JOIN provider_events pe
              ON pe.provider = fse.provider AND pe.provider_event_id = fse.provider_event_id
            WHERE fse.snapshot_id = feedback_snapshots.id AND pe.kind <> 'issue_comment'
          ))
          OR
          (? <> 'issue_comment' AND NOT EXISTS (
            SELECT 1 FROM feedback_snapshot_events fse
            JOIN provider_events pe
              ON pe.provider = fse.provider AND pe.provider_event_id = fse.provider_event_id
            WHERE fse.snapshot_id = feedback_snapshots.id AND pe.kind = 'issue_comment'
          ))
        )
      ORDER BY created_at, id LIMIT 1
    `).get(
      params.issueId,
      params.sessionId,
      params.generation,
      snapshotHeadSha,
      params.kind,
      params.kind
    ) as
      | FeedbackSnapshot
      | undefined;
    let snapshotCreated = false;
    if (!snapshot) {
      const id = randomUUID();
      const workItemExists = db.prepare(
        "SELECT 1 FROM feedback_snapshots WHERE work_item_id = ?"
      ).get(params.workItemId);
      const workItemId = workItemExists
        ? `${params.workItemId}:snapshot:${id}`
        : params.workItemId;
      db.prepare(`
        INSERT INTO feedback_snapshots (
          id, linear_issue_id, linear_session_id, generation, head_sha,
          provider_watermark, status, work_item_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'collecting', ?, ?)
      `).run(
        id,
        params.issueId,
        params.sessionId,
        params.generation,
        snapshotHeadSha,
        `${receivedAt}:${params.provider}:${params.providerEventId}`,
        workItemId,
        receivedAt
      );
      snapshot = getSnapshot.get(id) as FeedbackSnapshot;
      snapshotCreated = true;
    }

    db.prepare(`
      INSERT INTO provider_events (
        provider, provider_event_id, linear_issue_id, linear_session_id,
        generation, repository, pull_number, head_sha, kind, payload,
        payload_hash, received_at, snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.provider,
      params.providerEventId,
      params.issueId,
      params.sessionId,
      params.generation,
      params.repository,
      params.pullNumber,
      params.headSha,
      params.kind,
      params.payload,
      payloadHash,
      receivedAt,
      snapshot.id
    );
    db.prepare(`
      INSERT INTO feedback_snapshot_events(snapshot_id, provider, provider_event_id)
      VALUES (?, ?, ?)
    `).run(snapshot.id, params.provider, params.providerEventId);
    const watermark = `${receivedAt}:${params.provider}:${params.providerEventId}`;
    db.prepare(`
      UPDATE feedback_snapshots
      SET provider_watermark = CASE WHEN provider_watermark < ? THEN ? ELSE provider_watermark END
      WHERE id = ? AND status = 'collecting'
    `).run(watermark, watermark, snapshot.id);
    return {
      snapshot: getSnapshot.get(snapshot.id) as FeedbackSnapshot,
      eventInserted: true,
      snapshotCreated,
    };
  });

  const claimTransaction = db.transaction((snapshotId: string, maxRounds: number) => {
    const snapshot = getSnapshot.get(snapshotId) as FeedbackSnapshot | undefined;
    if (!snapshot || snapshot.status === "stale") return { status: "stale" as const };
    if (snapshot.status === "claimed" || snapshot.status === "consumed") {
      return { status: "claimed" as const, snapshot };
    }
    const completedRounds = (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM feedback_snapshots fs
          WHERE fs.linear_issue_id = ? AND fs.linear_session_id = ?
            AND fs.generation = ? AND fs.repair_round IS NOT NULL)
        +
        (SELECT COUNT(*) FROM session_work sw
          WHERE sw.linear_issue_id = ? AND sw.linear_session_id = ?
            AND sw.source = 'automatic' AND sw.status = 'consumed'
            AND NOT EXISTS (
              SELECT 1 FROM feedback_snapshots linked WHERE linked.work_item_id = sw.id
            )) AS count
    `).get(
      snapshot.linear_issue_id,
      snapshot.linear_session_id,
      snapshot.generation,
      snapshot.linear_issue_id,
      snapshot.linear_session_id
    ) as {
      count: number;
    }).count;
    if (completedRounds >= maxRounds) {
      return { status: "exhausted" as const, completedRounds };
    }
    const claimedAt = new Date().toISOString();
    const update = db.prepare(`
      UPDATE feedback_snapshots
      SET status = 'claimed', repair_round = ?, claimed_at = ?
      WHERE id = ? AND status = 'collecting'
    `).run(completedRounds + 1, claimedAt, snapshotId);
    if (update.changes !== 1) return { status: "stale" as const };
    return {
      status: "claimed" as const,
      snapshot: getSnapshot.get(snapshotId) as FeedbackSnapshot,
    };
  });

  return {
    record(params) {
      return recordTransaction.immediate(params);
    },
    claim(snapshotId, maxRounds) {
      return claimTransaction.immediate(snapshotId, maxRounds);
    },
    consume(snapshotId) {
      const timestamp = new Date().toISOString();
      return db.prepare(`
        UPDATE feedback_snapshots
        SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'claimed'
      `).run(timestamp, snapshotId).changes === 1;
    },
    get(snapshotId) {
      return getSnapshot.get(snapshotId) as FeedbackSnapshot | undefined;
    },
    listEvents(snapshotId) {
      return db.prepare(`
        SELECT pe.provider, pe.provider_event_id, pe.kind, pe.payload
        FROM feedback_snapshot_events fse
        JOIN provider_events pe
          ON pe.provider = fse.provider AND pe.provider_event_id = fse.provider_event_id
        WHERE fse.snapshot_id = ?
        ORDER BY pe.received_at, pe.provider, pe.provider_event_id
      `).all(snapshotId) as FeedbackSnapshotEvent[];
    },
  };
}
