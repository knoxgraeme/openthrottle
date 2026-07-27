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
  kind: "pipeline_receipt" | "issue_state";
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
  enteredStageIds?: readonly string[];
}): string {
  return canonicalJson(buildLifecyclePublication(input));
}
