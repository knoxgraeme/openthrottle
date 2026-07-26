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
  parsePipelinePublication,
  pipelinePublicationOutboxPayload,
  pipelineStatusOutboxPayload,
  publicationPayloadHash,
  shouldPostLinearEventComment,
} from "../../pipeline/publication.js";
import type {
  PipelineInstance,
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
      const sequence = (db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM linear_outbox WHERE linear_session_id IS ?
      `).get(input.instance.linear_session_id) as { sequence: number }).sequence;
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
        sequence,
        statusPayload,
        digestNormalized(statusPayload),
        input.timestamp,
        input.timestamp
      );
      if (shouldPostLinearEventComment(envelope)) {
        const outboxPayload = pipelinePublicationOutboxPayload(envelope);
        const receiptSequence = (db.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM linear_outbox WHERE linear_session_id IS ?
        `).get(input.instance.linear_session_id) as { sequence: number }).sequence;
        db.prepare(`
          INSERT INTO linear_outbox (
            id, linear_session_id, linear_issue_id, run_id, sequence, kind,
            payload, payload_hash, status, attempts, next_attempt_at, created_at
          ) VALUES (?, ?, ?, NULL, ?, 'pipeline_receipt', ?, ?, 'pending', 0, ?, ?)
        `).run(
          id,
          input.instance.linear_session_id,
          input.instance.linear_issue_id,
          receiptSequence,
          outboxPayload,
          digestNormalized(outboxPayload),
          input.timestamp,
          input.timestamp
        );
      } else {
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?
          WHERE id = ?
        `).run(input.timestamp, input.timestamp, id);
      }
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
}): string {
  return canonicalJson(buildLifecyclePublication(input));
}
