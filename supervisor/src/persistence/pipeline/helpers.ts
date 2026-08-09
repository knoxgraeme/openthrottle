import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestNormalized,
  type PipelineManifest,
} from "../../pipeline/manifest.js";
import {
  buildLifecyclePublication,
  buildSelectionPublication,
  deterministicPublicationId,
  issueStateSignalForPublication,
  parsePipelinePublication,
  type PipelinePublicationEnvelope,
  pipelinePublicationOutboxPayload,
  pipelineStatusOutboxPayload,
  publicationPayloadHash,
  shouldPostLinearEventComment,
} from "../../pipeline/publication.js";
import type {
  PipelineInstance,
  PipelineInstanceStatus,
  PipelinePublicationReceipt,
  PipelineStageAttempt,
  RepositoryConfigSnapshot,
} from "../../pipeline/store.js";
import { bounded, type ExecutionPublicationSnapshot } from "../../pipeline/execution-publication.js";

export const SAFE_BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

export function assertDigest(label: string, normalized: string, digest: string): void {
  if (digestNormalized(normalized) !== digest) throw new Error(`${label} digest mismatch`);
}

export function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}-${digestNormalized(canonicalJson(input)).slice(0, 32)}`;
}

export function claimLeasable<T>(input: {
  rows: Array<{ id: string }>;
  leaseUntilIso: string;
  nowIso: string;
  update: (id: string, leaseUntilIso: string, nowIso: string) => number;
  get: (id: string) => T;
}): T[] {
  const claimed: T[] = [];
  for (const row of input.rows) {
    if (input.update(row.id, input.leaseUntilIso, input.nowIso) === 1) {
      claimed.push(input.get(row.id));
    }
  }
  return claimed;
}

export function markQueueFailed(input: {
  update: (status: "failed" | "dead", nextAttemptAt: string | null, error: string) => number;
  error: string;
  retryAt: string | null;
  timestamp: string;
  deadNextAttemptAt?: string | null;
}): "failed" | "dead" | undefined {
  const status = input.retryAt ? "failed" : "dead";
  let nextAttemptAt: string | null = input.timestamp;
  if (input.retryAt) {
    nextAttemptAt = input.retryAt;
  } else if (Object.prototype.hasOwnProperty.call(input, "deadNextAttemptAt")) {
    nextAttemptAt = input.deadNextAttemptAt ?? null;
  }
  const updated = input.update(status, nextAttemptAt, input.error);
  return updated === 1 ? status : undefined;
}

export interface PublicationReceiptFields {
  externalId?: string | null;
  externalUrl?: string | null;
  attachmentUrl?: string | null;
}

const TERMINAL_OR_BLOCKED_STATUSES = [
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
  "publication_blocked",
] as const;

export function acknowledgePublicationReceipt(input: {
  db: Database.Database;
  id: string;
  timestamp: string;
  receipt?: PublicationReceiptFields;
}): void {
  const publication = input.db.prepare(`
    SELECT pipeline_instance_id, resume_status FROM pipeline_publication_receipts WHERE id = ?
  `).get(input.id) as {
    pipeline_instance_id: string;
    resume_status: PipelineInstanceStatus | null;
  } | undefined;
  if (!publication) return;
  input.db.prepare(`
    UPDATE pipeline_publication_receipts
    SET status = 'acknowledged', external_id = COALESCE(?, external_id),
        external_url = COALESCE(?, external_url),
        attachment_url = COALESCE(?, attachment_url), acknowledged_at = ?,
        last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(
    input.receipt?.externalId ?? null,
    input.receipt?.externalUrl ?? null,
    input.receipt?.attachmentUrl ?? null,
    input.timestamp,
    input.timestamp,
    input.id
  );
  if (publication.resume_status) {
    input.db.prepare(`
      UPDATE pipeline_instances
      SET status = ?, state_version = state_version + 1,
          wait_reason = CASE WHEN ? = 'waiting_human' THEN wait_reason ELSE NULL END,
          updated_at = ?
      WHERE id = ? AND status = 'completion_pending_publication'
    `).run(
      publication.resume_status,
      publication.resume_status,
      input.timestamp,
      publication.pipeline_instance_id
    );
  }
}

export function failPublicationReceipt(input: {
  db: Database.Database;
  id: string;
  status: "failed" | "dead";
  nextAttemptAt: string;
  error: string;
  timestamp: string;
  attempts?: number;
  instanceStatus?: PipelineInstanceStatus | string | null;
  instanceVersion?: number;
}): void {
  const publication = input.db.prepare(`
    SELECT pipeline_instance_id FROM pipeline_publication_receipts WHERE id = ?
  `).get(input.id) as { pipeline_instance_id: string } | undefined;
  if (!publication) return;
  const instance = input.db.prepare("SELECT status, state_version FROM pipeline_instances WHERE id = ?")
    .get(publication.pipeline_instance_id) as
    | { status: PipelineInstanceStatus; state_version: number }
    | undefined;
  const blockedFromStatus = input.instanceStatus ?? instance?.status ?? null;
  input.db.prepare(`
    UPDATE pipeline_publication_receipts
    SET status = ?,
        attempts = COALESCE(?, attempts),
        next_attempt_at = ?, last_error = ?, updated_at = ?,
        blocked_from_status = CASE WHEN ? = 'dead' THEN COALESCE(blocked_from_status, ?) ELSE blocked_from_status END
    WHERE id = ?
  `).run(
    input.status,
    input.attempts ?? null,
    input.nextAttemptAt,
    input.error,
    input.timestamp,
    input.status,
    blockedFromStatus,
    input.id
  );
  blockPublicationInstanceOnDead({
    db: input.db,
    id: input.id,
    status: input.status,
    timestamp: input.timestamp,
    instanceVersion: input.instanceVersion,
  });
}

export function blockPublicationInstanceOnDead(input: {
  db: Database.Database;
  id: string;
  status: "failed" | "dead";
  timestamp: string;
  instanceVersion?: number;
}): void {
  const publication = input.db.prepare(`
    SELECT pipeline_instance_id FROM pipeline_publication_receipts WHERE id = ?
  `).get(input.id) as { pipeline_instance_id: string } | undefined;
  if (!publication) return;
  const instance = input.db.prepare("SELECT status, state_version FROM pipeline_instances WHERE id = ?")
    .get(publication.pipeline_instance_id) as
    | { status: PipelineInstanceStatus; state_version: number }
    | undefined;
  if (
    input.status === "dead" &&
    instance &&
    !TERMINAL_OR_BLOCKED_STATUSES.includes(instance.status as typeof TERMINAL_OR_BLOCKED_STATUSES[number])
  ) {
    const versionPredicate = input.instanceVersion === undefined ? "" : " AND state_version = ?";
    const statement = input.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'publication_blocked', state_version = state_version + 1,
          wait_reason = 'permanent publication failure', updated_at = ?
      WHERE id = ? AND status NOT IN (
        'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed',
        'publication_blocked'
      )${versionPredicate}
    `);
    if (input.instanceVersion === undefined) {
      statement.run(input.timestamp, publication.pipeline_instance_id);
    } else {
      statement.run(input.timestamp, publication.pipeline_instance_id, input.instanceVersion);
    }
  }
}

export function validatePinnedInstance(
  db: Database.Database,
  instance: PipelineInstance
): PipelineManifest {
  if (!SAFE_BRANCH.test(instance.base_branch)) {
    throw new Error(`pipeline instance ${instance.id} has an invalid pinned base branch`);
  }
  assertDigest(`pipeline instance ${instance.id} manifest`, instance.normalized_manifest, instance.manifest_digest);
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  if (manifest.id !== instance.pipeline_id || manifest.version !== instance.pipeline_version) {
    throw new Error(`pipeline instance ${instance.id} manifest identity mismatch`);
  }
  const catalog = db.prepare(`
    SELECT normalized_manifest FROM pipeline_catalog_entries
    WHERE pipeline_id = ? AND version = ? AND digest = ?
  `).get(instance.pipeline_id, instance.pipeline_version, instance.manifest_digest) as
    | { normalized_manifest: string }
    | undefined;
  if (!catalog || catalog.normalized_manifest !== instance.normalized_manifest) {
    throw new Error(`pipeline instance ${instance.id} catalog binding mismatch`);
  }
  const config = db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?")
    .get(instance.repository_config_snapshot_id) as RepositoryConfigSnapshot | undefined;
  if (
    !config || config.repository !== instance.repository || config.base_commit !== instance.base_commit ||
    config.digest !== instance.repository_config_digest
  ) throw new Error(`pipeline instance ${instance.id} repository config binding mismatch`);
  assertDigest(`pipeline instance ${instance.id} repository config`, config.normalized_config, config.digest);
  const runtime = db.prepare(`
    SELECT protocol, normalized_descriptor FROM runtime_capability_descriptors
    WHERE runtime_release = ? AND digest = ?
  `).get(instance.runtime_release, instance.capability_digest) as
    | { protocol: string; normalized_descriptor: string }
    | undefined;
  if (!runtime || runtime.protocol !== instance.executor_protocol) {
    throw new Error(`pipeline instance ${instance.id} runtime binding mismatch`);
  }
  assertDigest(`pipeline instance ${instance.id} runtime`, runtime.normalized_descriptor, instance.capability_digest);
  const descriptor = JSON.parse(runtime.normalized_descriptor) as { capabilities?: unknown };
  const descriptorCapabilities = descriptor.capabilities;
  const authorized = JSON.parse(instance.authorized_capabilities) as unknown;
  if (!Array.isArray(authorized) || authorized.some((entry) => typeof entry !== "string")) {
    throw new Error(`pipeline instance ${instance.id} authorized capabilities are not canonical`);
  }
  const authorizedCapabilities = authorized as string[];
  if (canonicalJson([...authorizedCapabilities].sort()) !== instance.authorized_capabilities) {
    throw new Error(`pipeline instance ${instance.id} authorized capabilities are not canonical`);
  }
  if (!Array.isArray(descriptorCapabilities) ||
      authorizedCapabilities.some((entry) => !descriptorCapabilities.includes(entry))) {
    throw new Error(`pipeline instance ${instance.id} authorized capability binding mismatch`);
  }
  const requiredCapabilities = [...manifest.requires.capabilities].sort();
  if (canonicalJson(requiredCapabilities) !== instance.authorized_capabilities) {
    throw new Error(`pipeline instance ${instance.id} manifest capability authorization mismatch`);
  }
  return manifest;
}

function nextLinearOutboxSequence(db: Database.Database, linearSessionId: string): number {
  return (db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM linear_outbox WHERE linear_session_id IS ?
  `).get(linearSessionId) as { sequence: number }).sequence;
}

function insertPendingLinearOutbox(input: {
  db: Database.Database;
  id: string;
  linearSessionId: string;
  linearIssueId: string;
  kind: "pipeline_receipt" | "issue_state" | "activity";
  payload: string;
  timestamp: string;
}): void {
  input.db.prepare(`
    INSERT INTO linear_outbox (
      id, linear_session_id, linear_issue_id, run_id, sequence, kind,
      payload, payload_hash, status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(
    input.id,
    input.linearSessionId,
    input.linearIssueId,
    nextLinearOutboxSequence(input.db, input.linearSessionId),
    input.kind,
    input.payload,
    digestNormalized(input.payload),
    input.timestamp,
    input.timestamp
  );
}

export type ExecutionPublicationEventKind =
  | "unit_repair"
  | "unit_settled"
  | "graph_stopped"
  | "final_review"
  | "aggregate"
  | "aggregate_correction"
  // A composite (`for_each_unit`) run has no steerable child action fence
  // today (RU11 leaves this a documented gap rather than a silent one, see
  // docs/SPEC.md "Live steering"): a reply captured while this run is active
  // can never be bound to a live child, so capture records this event
  // instead of only canceling the reply at cleanup with no durable trace.
  | "steering_undelivered";

// Inserts one durable, ordered child-publication event (RR18) plus its
// correlated linear_outbox activity row in the caller's already-open SQL
// transaction, so a reportable child transition and its external projection
// become durable atomically. Sanitization runs before either insert, so a
// replayed/retried transaction can never re-derive or bypass it -- retrying
// this call with the same deterministic id is a pure no-op (ON CONFLICT DO
// NOTHING), never a re-sanitize-and-overwrite.
export function insertExecutionPublicationEvent(input: {
  db: Database.Database;
  id: string;
  graph: { id: string; pipeline_instance_id: string; parent_attempt_id: string };
  unitId: string | null;
  kind: ExecutionPublicationEventKind;
  body: string;
  timestamp: string;
}): void {
  const already = input.db.prepare(
    "SELECT 1 FROM execution_publication_events WHERE id = ?"
  ).get(input.id);
  if (already) return;
  const binding = input.db.prepare(
    "SELECT linear_session_id, linear_issue_id FROM pipeline_instances WHERE id = ?"
  ).get(input.graph.pipeline_instance_id) as { linear_session_id: string; linear_issue_id: string } | undefined;
  if (!binding) throw new Error(`pipeline instance ${input.graph.pipeline_instance_id} is missing`);
  const sanitizedBody = bounded(input.body) ?? "(no detail)";
  const outboxId = deterministicPublicationId(`${input.id}-outbox`);
  const activityPayload = canonicalJson({
    type: "activity",
    activity: {
      sessionId: binding.linear_session_id,
      type: "thought" as const,
      body: sanitizedBody,
      ephemeral: false,
    },
  });
  // The upfront `already` check above is transactionally atomic with this
  // insert (same already-open caller transaction), so a genuine retry never
  // reaches here twice -- reuse the canonical insert idiom rather than a
  // fourth divergent ON CONFLICT variant.
  insertPendingLinearOutbox({
    db: input.db,
    id: outboxId,
    linearSessionId: binding.linear_session_id,
    linearIssueId: binding.linear_issue_id,
    kind: "activity",
    payload: activityPayload,
    timestamp: input.timestamp,
  });
  const sequence = (input.db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM execution_publication_events WHERE parent_attempt_id = ?
  `).get(input.graph.parent_attempt_id) as { sequence: number }).sequence;
  input.db.prepare(`
    INSERT INTO execution_publication_events (
      id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
      sequence, kind, body, linear_outbox_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    input.id,
    input.graph.id,
    input.graph.pipeline_instance_id,
    input.graph.parent_attempt_id,
    input.unitId,
    sequence,
    input.kind,
    sanitizedBody,
    outboxId,
    input.timestamp
  );
}

function aggregateCorrectionBody(fromArtifactHash: string, toArtifactHash: string): string {
  return `Structured execution aggregate corrected: legacy aggregate ${fromArtifactHash} migrated to canonical aggregate ${toArtifactHash}.`;
}

function activityOutboxPayload(input: {
  sessionId: string;
  body: string;
}): string {
  return canonicalJson({
    type: "activity",
    activity: {
      sessionId: input.sessionId,
      type: "thought" as const,
      body: input.body,
      ephemeral: false,
    },
  });
}

function updateAggregateEventBody(input: {
  db: Database.Database;
  graphId: string;
  eventId: string;
  fromBody: string;
  toBody: string;
}): void {
  const eventUpdate = input.db.prepare(`
    UPDATE execution_publication_events
    SET body = ?
    WHERE id = ? AND body = ?
  `).run(input.toBody, input.eventId, input.fromBody);
  if (eventUpdate.changes !== 1) {
    throw new Error(`execution graph ${input.graphId} aggregate event compare-and-set failed`);
  }
}

export function migrateAggregatePublicationActivity(input: {
  db: Database.Database;
  graph: { id: string; pipeline_instance_id: string; parent_attempt_id: string };
  fromArtifactHash: string;
  toArtifactHash: string;
  timestamp: string;
}): "migrated" | "already_canonical" | "correction_recorded" {
  const aggregateEventId = deterministicId("execution-activity-aggregate", [input.graph.parent_attempt_id]);
  const correctionEventId = deterministicId("execution-activity-aggregate-correction", [
    input.graph.parent_attempt_id,
    input.fromArtifactHash,
    input.toArtifactHash,
  ]);
  const correction = input.db.prepare(
    "SELECT 1 FROM execution_publication_events WHERE id = ?"
  ).get(correctionEventId);
  const event = input.db.prepare(`
    SELECT e.id, e.body, e.linear_outbox_id, o.status AS outbox_status,
           o.payload AS outbox_payload, o.payload_hash AS outbox_payload_hash,
           p.linear_session_id
    FROM execution_publication_events e
    JOIN linear_outbox o ON o.id = e.linear_outbox_id
    JOIN pipeline_instances p ON p.id = e.pipeline_instance_id
    WHERE e.id = ? AND e.parent_attempt_id = ? AND e.kind = 'aggregate'
  `).get(aggregateEventId, input.graph.parent_attempt_id) as
    | {
      id: string;
      body: string;
      linear_outbox_id: string;
      outbox_status: string;
      outbox_payload: string;
      outbox_payload_hash: string;
      linear_session_id: string;
    }
    | undefined;
  if (!event) {
    if (correction) return "correction_recorded";
    throw new Error(`execution graph ${input.graph.id} aggregate publication event is missing`);
  }

  const bodyHasSource = event.body.includes(input.fromArtifactHash);
  const bodyHasTarget = event.body.includes(input.toArtifactHash);
  if (!bodyHasSource && bodyHasTarget) {
    if (event.outbox_status !== "pending" && event.outbox_status !== "failed") return "already_canonical";
    const canonicalOutboxPayload = activityOutboxPayload({
      sessionId: event.linear_session_id,
      body: event.body,
    });
    if (event.outbox_payload === canonicalOutboxPayload) return "already_canonical";
    const outboxUpdate = input.db.prepare(`
      UPDATE linear_outbox
      SET payload = ?, payload_hash = ?
      WHERE id = ? AND status IN ('pending', 'failed') AND payload_hash = ?
    `).run(
      canonicalOutboxPayload,
      digestNormalized(canonicalOutboxPayload),
      event.linear_outbox_id,
      event.outbox_payload_hash
    );
    if (outboxUpdate.changes !== 1) {
      throw new Error(`execution graph ${input.graph.id} aggregate activity outbox compare-and-set failed`);
    }
    return "already_canonical";
  }
  if (!bodyHasSource) {
    throw new Error(`execution graph ${input.graph.id} aggregate publication event does not match migration source`);
  }

  const migratedBody = bounded(event.body.replaceAll(input.fromArtifactHash, input.toArtifactHash)) ?? event.body;
  if (event.outbox_status === "pending" || event.outbox_status === "failed") {
    const migratedPayload = activityOutboxPayload({
      sessionId: event.linear_session_id,
      body: migratedBody,
    });
    updateAggregateEventBody({
      db: input.db,
      graphId: input.graph.id,
      eventId: event.id,
      fromBody: event.body,
      toBody: migratedBody,
    });
    const outboxUpdate = input.db.prepare(`
      UPDATE linear_outbox
      SET payload = ?, payload_hash = ?
      WHERE id = ? AND status IN ('pending', 'failed') AND payload_hash = ?
    `).run(
      migratedPayload,
      digestNormalized(migratedPayload),
      event.linear_outbox_id,
      event.outbox_payload_hash
    );
    if (outboxUpdate.changes !== 1) {
      throw new Error(`execution graph ${input.graph.id} aggregate activity outbox compare-and-set failed`);
    }
    return "migrated";
  }

  updateAggregateEventBody({
    db: input.db,
    graphId: input.graph.id,
    eventId: event.id,
    fromBody: event.body,
    toBody: migratedBody,
  });
  if (correction) return "correction_recorded";
  insertExecutionPublicationEvent({
    db: input.db,
    id: correctionEventId,
    graph: input.graph,
    unitId: null,
    kind: "aggregate_correction",
    body: aggregateCorrectionBody(input.fromArtifactHash, input.toArtifactHash),
    timestamp: input.timestamp,
  });
  return "correction_recorded";
}

export interface ExecutionPublicationEventRecord {
  id: string;
  execution_graph_id: string;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  unit_id: string | null;
  sequence: number;
  kind: ExecutionPublicationEventKind;
  body: string;
  linear_outbox_id: string;
  created_at: string;
}

// Bounds the rendered activity log the same way MAX_DOWNSTREAM_CONTEXT_RECORDS
// bounds downstream context: a long-running or repair-heavy graph must not
// let this history push the rest of the publication body (findings, links)
// past PUBLICATION_BODY_LIMIT's plain truncation.
export const MAX_ACTIVITY_LOG_EVENTS = 32;

// Restart-safe convergence source for the final structured ledger (RR18/RAE7):
// each event row is inserted in the same transaction as the child transition
// it reports, so reading it directly (rather than gating on its correlated
// linear_outbox activity's own delivery status) is what makes the ledger
// converge immediately from durable state -- including on the very same pass
// that emits the event, and after a crash-and-restart replay, with no
// dependency on the separate per-event Linear activity having been delivered
// yet. The correlated linear_outbox row still tracks that activity's own
// delivery independently; it is not a precondition for this projection.
export function listExecutionPublicationEvents(
  db: Database.Database,
  parentAttemptId: string
): ExecutionPublicationEventRecord[] {
  return db.prepare(`
    SELECT * FROM (
      SELECT e.*
      FROM execution_publication_events e
      WHERE e.parent_attempt_id = ?
      ORDER BY e.sequence DESC
      LIMIT ?
    )
    ORDER BY sequence ASC
  `).all(parentAttemptId, MAX_ACTIVITY_LOG_EVENTS) as ExecutionPublicationEventRecord[];
}

function persistIssueStateProjection(input: {
  db: Database.Database;
  instance: PipelineInstance;
  envelope: PipelinePublicationEnvelope;
  timestamp: string;
}): void {
  const signal = issueStateSignalForPublication(input.envelope);
  if (!signal) return;
  const id = deterministicPublicationId(`linear-issue-state:${input.instance.id}:${signal}`);
  const payload = JSON.stringify({
    type: "issue_state",
    issueId: input.instance.linear_issue_id,
    signal,
  });
  const payloadHash = digestNormalized(payload);
  const existing = input.db.prepare("SELECT payload_hash FROM linear_outbox WHERE id = ?").get(id) as
    | { payload_hash: string }
    | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new Error(`linear issue-state outbox ${id} already exists with different intent`);
    }
    return;
  }
  insertPendingLinearOutbox({
    db: input.db,
    id,
    linearSessionId: input.instance.linear_session_id,
    linearIssueId: input.instance.linear_issue_id,
    kind: "issue_state",
    payload,
    timestamp: input.timestamp,
  });
}

export function createPipelinePublicationWriter(db: Database.Database) {
  return (input: {
    instance: PipelineInstance;
    attemptId: string | null;
    kind: "linear_ledger" | "github_summary";
    idempotencyKey: string;
    payload: string;
    timestamp: string;
  }): PipelinePublicationReceipt => {
    const envelope = parsePipelinePublication(input.payload);
    if (envelope.pipeline.instance_id !== input.instance.id ||
        envelope.pipeline.linear_issue_id !== input.instance.linear_issue_id ||
        envelope.pipeline.generation !== input.instance.generation ||
        envelope.pipeline.manifest_digest !== input.instance.manifest_digest) {
      throw new Error("pipeline publication instance fence mismatch");
    }
    const payloadHash = publicationPayloadHash(envelope);
    if (input.kind === "linear_ledger") {
      const id = deterministicPublicationId(input.idempotencyKey);
      const existing = db.prepare(`
        SELECT * FROM pipeline_publication_receipts WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as PipelinePublicationReceipt | undefined;
      if (existing) {
        if (existing.id !== id || existing.pipeline_instance_id !== input.instance.id ||
            existing.attempt_id !== input.attemptId || existing.kind !== input.kind ||
            existing.payload_hash !== payloadHash || existing.payload !== input.payload) {
          throw new Error(`pipeline publication ${input.idempotencyKey} already exists with different intent`);
        }
        return existing;
      }
      db.prepare(`
        INSERT INTO pipeline_publication_receipts (
          id, pipeline_instance_id, attempt_id, kind, idempotency_key,
          payload, payload_hash, status, attempts, next_attempt_at,
          resume_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'linear_ledger', ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      `).run(
        id,
        input.instance.id,
        input.attemptId,
        input.idempotencyKey,
        input.payload,
        payloadHash,
        input.timestamp,
        envelope.resume_status,
        input.timestamp,
        input.timestamp
      );
      const statusId = deterministicPublicationId(`linear-status:${input.instance.id}`);
      const statusPayload = pipelineStatusOutboxPayload(envelope);
      db.prepare(`
        INSERT INTO linear_outbox (
          id, linear_session_id, linear_issue_id, run_id, sequence, kind,
          payload, payload_hash, status, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, NULL, ?, 'pipeline_status', ?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          payload_hash = excluded.payload_hash,
          status = 'pending',
          attempts = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          processed_at = NULL
      `).run(
        statusId,
        input.instance.linear_session_id,
        input.instance.linear_issue_id,
        nextLinearOutboxSequence(db, input.instance.linear_session_id),
        statusPayload,
        digestNormalized(statusPayload),
        input.timestamp,
        input.timestamp
      );
      if (shouldPostLinearEventComment(envelope)) {
        const outboxPayload = pipelinePublicationOutboxPayload(envelope);
        insertPendingLinearOutbox({
          db,
          id,
          linearSessionId: input.instance.linear_session_id,
          linearIssueId: input.instance.linear_issue_id,
          kind: "pipeline_receipt",
          payload: outboxPayload,
          timestamp: input.timestamp,
        });
      } else {
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?
          WHERE id = ?
        `).run(input.timestamp, input.timestamp, id);
      }
      persistIssueStateProjection({
        db,
        instance: input.instance,
        envelope,
        timestamp: input.timestamp,
      });
    } else {
      const stableKey = `github-summary:${input.instance.linear_issue_id}`;
      const stableId = deterministicPublicationId(stableKey);
      db.prepare(`
        INSERT INTO pipeline_publication_receipts (
          id, pipeline_instance_id, attempt_id, kind, idempotency_key,
          payload, payload_hash, status, attempts, next_attempt_at,
          resume_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'github_summary', ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          target_url = CASE
            WHEN pipeline_publication_receipts.pipeline_instance_id = excluded.pipeline_instance_id
              THEN pipeline_publication_receipts.target_url
            ELSE NULL
          END,
          pipeline_instance_id = excluded.pipeline_instance_id,
          attempt_id = excluded.attempt_id,
          payload = excluded.payload,
          payload_hash = excluded.payload_hash,
          status = 'pending',
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(
        stableId,
        input.instance.id,
        input.attemptId,
        stableKey,
        input.payload,
        payloadHash,
        input.timestamp,
        input.timestamp,
        input.timestamp
      );
      return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
        .get(stableId) as PipelinePublicationReceipt;
    }
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as PipelinePublicationReceipt;
  };
}

export function persistSelectionPublications(input: {
  db: Database.Database;
  instance: PipelineInstance;
  timestamp: string;
}): void {
  const persistPublication = createPipelinePublicationWriter(input.db);
  const selection = canonicalJson(buildSelectionPublication(input.instance));
  persistPublication({
    instance: input.instance,
    attemptId: null,
    kind: "linear_ledger",
    idempotencyKey: `linear-selection:${input.instance.id}`,
    payload: selection,
    timestamp: input.timestamp,
  });
  persistPublication({
    instance: input.instance,
    attemptId: null,
    kind: "github_summary",
    idempotencyKey: `github-summary:${input.instance.id}`,
    payload: selection,
    timestamp: input.timestamp,
  });
}

export function buildTerminalPublicationPayload(input: {
  instance: PipelineInstance;
  attempt: PipelineStageAttempt | undefined;
  outcome: "superseded";
  reason: string;
  structuredExecution?: ExecutionPublicationSnapshot;
}): string {
  return canonicalJson(buildLifecyclePublication(input));
}
