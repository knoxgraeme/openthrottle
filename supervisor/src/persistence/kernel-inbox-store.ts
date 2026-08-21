import { Buffer } from "node:buffer";
import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestCanonicalJson,
  jsonValueAt,
  validateBlobPointer,
  type BlobPointer,
  type JsonValue,
} from "@openthrottle/contracts";
import {
  BlobIntegrityError,
  VolumeBlobStore,
  type VerifiedBlobToken,
} from "./blob-store.js";
import { KERNEL_INGRESS_MAINTENANCE_SETTING } from "./epoch-schema.js";

export { KERNEL_INGRESS_MAINTENANCE_SETTING } from "./epoch-schema.js";
export const KERNEL_INBOX_INLINE_PAYLOAD_MAX_BYTES = 64 * 1024;
export const KERNEL_INBOX_MAX_PAYLOAD_BYTES = 1024 * 1024;
const KERNEL_INBOX_UNREADABLE_HEAD_LIMIT = 100;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PROVIDER = /^[a-z][a-z0-9._/-]{0,99}$/;
const KIND = /^[a-z][a-z0-9._/-]*(?:@[1-9][0-9]*)?$/;

export type KernelInboxStatus =
  | "pending"
  | "processing"
  | "consumed"
  | "stale"
  | "dead";

export interface KernelInboxEventInput {
  id?: string;
  source_provider: string;
  delivery_id: string;
  kind: string;
  work_item_id?: string | null;
  pipeline_run_id?: string | null;
  attempt_id?: string | null;
  generation: number;
  event_group_key: string;
  delivery_attempt: number;
  subject?: string | null;
  payload_schema: string;
  payload: JsonValue;
  available_at?: string;
}

export interface KernelInboxEvent {
  id: string;
  source_provider: string;
  delivery_id: string;
  kind: string;
  work_item_id: string | null;
  pipeline_run_id: string | null;
  attempt_id: string | null;
  generation: number;
  event_group_key: string;
  delivery_attempt: number;
  subject: string | null;
  payload_hash: string;
  payload_schema: string;
  payload: JsonValue;
  status: KernelInboxStatus;
  available_at: string;
  lease_id: string | null;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  version: number;
  created_at: string;
  consumed_at: string | null;
}

export type KernelInboxIngestResult =
  | { disposition: "maintenance_closed"; retryable: true; acknowledge: false }
  | {
    disposition: "inserted" | "duplicate" | "reordered";
    retryable: false;
    acknowledge: true;
    event: KernelInboxEvent;
  };

export interface KernelMaintenanceFence {
  closed: boolean;
  version: number;
  updated_at: string | null;
}

export interface KernelMaintenancePort {
  getMaintenanceFence(): KernelMaintenanceFence;
  setMaintenanceFence(input: {
    closed: boolean;
    expected_version?: number;
  }): KernelMaintenanceFence;
}

export interface KernelInboxIngressPort {
  ingest(input: KernelInboxEventInput): KernelInboxIngestResult;
}

export interface KernelInboxDeliveryPort {
  leaseNext(input: {
    owner_id: string;
    lease_id: string;
    expires_at: string;
  }): KernelInboxEvent | null;
  complete(input: {
    event_id: string;
    owner_id: string;
    lease_id: string;
    outcome: "consumed" | "stale" | "dead";
  }): void;
  retry(input: {
    event_id: string;
    owner_id: string;
    lease_id: string;
    available_at: string;
  }): void;
  get(eventId: string): KernelInboxEvent | undefined;
}

interface InboxRow {
  id: string;
  source_provider: string;
  delivery_id: string;
  kind: string;
  work_item_id: string | null;
  pipeline_run_id: string | null;
  attempt_id: string | null;
  generation: number;
  event_group_key: string;
  delivery_attempt: number;
  subject: string | null;
  payload_hash: string;
  payload_schema: string;
  inline_payload: string | null;
  blob_algorithm: "sha256" | null;
  blob_digest: string | null;
  blob_bytes: number | null;
  blob_encoding: "utf-8" | "binary" | null;
  blob_media_type: string | null;
  blob_payload_schema: string | null;
  status: KernelInboxStatus;
  available_at: string;
  lease_id: string | null;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  version: number;
  created_at: string;
  consumed_at: string | null;
}

interface PreparedPayload {
  canonical: string;
  hash: string;
  inline: string | null;
  token: VerifiedBlobToken | null;
}

class InboxPayloadCorruptionError extends Error {
  constructor(eventId: string, detail: string) {
    super(`inbox event ${eventId} is deterministically unreadable: ${detail}`);
    this.name = "InboxPayloadCorruptionError";
  }
}

function bounded(value: string, name: string, max: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > max ||
    value.includes("\0") || (pattern !== undefined && !pattern.test(value))
  ) throw new Error(`${name} is invalid`);
  return value;
}

function iso(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function pointer(row: InboxRow): BlobPointer | null {
  if (row.blob_digest === null) return null;
  if (
    row.blob_algorithm !== "sha256" || row.blob_bytes === null || row.blob_encoding === null ||
    row.blob_media_type === null || row.blob_payload_schema === null
  ) throw new Error(`inbox event ${row.id} has a partial blob pointer`);
  return validateBlobPointer({
    algorithm: row.blob_algorithm,
    digest: row.blob_digest,
    bytes: row.blob_bytes,
    encoding: row.blob_encoding,
    media_type: row.blob_media_type,
    payload_schema: row.blob_payload_schema,
  }, { source: `inbox_event.${row.id}.blob` }).value;
}

function immutableProjection(row: InboxRow): Record<string, unknown> {
  return {
    source_provider: row.source_provider,
    delivery_id: row.delivery_id,
    kind: row.kind,
    work_item_id: row.work_item_id,
    pipeline_run_id: row.pipeline_run_id,
    attempt_id: row.attempt_id,
    generation: row.generation,
    event_group_key: row.event_group_key,
    delivery_attempt: row.delivery_attempt,
    subject: row.subject,
    payload_hash: row.payload_hash,
    payload_schema: row.payload_schema,
  };
}

export class SqliteKernelInboxStore implements
  KernelMaintenancePort,
  KernelInboxIngressPort,
  KernelInboxDeliveryPort {
  readonly #db: Database.Database;
  readonly #blobs: VolumeBlobStore;
  readonly #now: () => string;

  constructor(input: {
    db: Database.Database;
    blob_store: VolumeBlobStore;
    now?: () => string;
  }) {
    this.#db = input.db;
    this.#blobs = input.blob_store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  getMaintenanceFence(): KernelMaintenanceFence {
    const row = this.#db.prepare(`
      SELECT value_json, value_type, mutable, version, updated_at
      FROM settings WHERE key = ?
    `).get(KERNEL_INGRESS_MAINTENANCE_SETTING) as {
      value_json: string;
      value_type: string;
      mutable: number;
      version: number;
      updated_at: string;
    } | undefined;
    if (!row) return { closed: false, version: 0, updated_at: null };
    if (row.value_type !== "boolean" || row.mutable !== 1) {
      throw new Error("kernel ingress maintenance setting has invalid ownership");
    }
    const value: unknown = JSON.parse(row.value_json);
    if (typeof value !== "boolean") throw new Error("kernel ingress maintenance setting is invalid");
    return { closed: value, version: row.version, updated_at: row.updated_at };
  }

  setMaintenanceFence(input: {
    closed: boolean;
    expected_version?: number;
  }): KernelMaintenanceFence {
    if (typeof input.closed !== "boolean") throw new Error("maintenance closed must be boolean");
    return this.#db.transaction(() => {
      const current = this.getMaintenanceFence();
      if (
        input.expected_version !== undefined && input.expected_version !== current.version
      ) throw new Error("kernel ingress maintenance compare-and-set failed");
      if (current.closed === input.closed && current.updated_at !== null) return current;
      const timestamp = iso(this.#now(), "maintenance timestamp");
      if (current.updated_at === null) {
        this.#db.prepare(`
          INSERT INTO settings (
            key, value_json, value_type, mutable, version, updated_at
          ) VALUES (?, ?, 'boolean', 1, 1, ?)
        `).run(KERNEL_INGRESS_MAINTENANCE_SETTING, input.closed ? "true" : "false", timestamp);
      } else {
        const changed = this.#db.prepare(`
          UPDATE settings SET value_json = ?, version = version + 1, updated_at = ?
          WHERE key = ? AND mutable = 1 AND version = ?
        `).run(
          input.closed ? "true" : "false",
          timestamp,
          KERNEL_INGRESS_MAINTENANCE_SETTING,
          current.version,
        );
        if (changed.changes !== 1) {
          throw new Error("kernel ingress maintenance compare-and-set failed");
        }
      }
      return this.getMaintenanceFence();
    }).immediate();
  }

  ingest(input: KernelInboxEventInput): KernelInboxIngestResult {
    if (this.getMaintenanceFence().closed) {
      return { disposition: "maintenance_closed", retryable: true, acknowledge: false };
    }
    const normalized = this.#normalizeInput(input);
    const prepared = this.#preparePayload(normalized.payload, normalized.payload_schema);
    return this.#db.transaction(() => {
      if (this.getMaintenanceFence().closed) {
        return { disposition: "maintenance_closed", retryable: true, acknowledge: false } as const;
      }
      const existing = this.#db.prepare(`
        SELECT * FROM inbox_events WHERE source_provider = ? AND delivery_id = ?
      `).get(normalized.source_provider, normalized.delivery_id) as InboxRow | undefined;
      const intended = {
        source_provider: normalized.source_provider,
        delivery_id: normalized.delivery_id,
        kind: normalized.kind,
        work_item_id: normalized.work_item_id,
        pipeline_run_id: normalized.pipeline_run_id,
        attempt_id: normalized.attempt_id,
        generation: normalized.generation,
        event_group_key: normalized.event_group_key,
        delivery_attempt: normalized.delivery_attempt,
        subject: normalized.subject,
        payload_hash: prepared.hash,
        payload_schema: normalized.payload_schema,
      };
      if (existing) {
        if (canonicalJson(immutableProjection(existing)) !== canonicalJson(intended)) {
          throw new Error(
            `inbox delivery ${normalized.source_provider}:${normalized.delivery_id} changed intent`,
          );
        }
        return {
          disposition: "duplicate",
          retryable: false,
          acknowledge: true,
          event: this.#event(existing),
        } as const;
      }

      const group = this.#db.prepare(`
        SELECT * FROM inbox_events
        WHERE source_provider = ? AND event_group_key = ?
        ORDER BY delivery_attempt, created_at, id LIMIT 1
      `).get(normalized.source_provider, normalized.event_group_key) as InboxRow | undefined;
      let status: KernelInboxStatus = "pending";
      if (group) {
        const sameSemanticEvent =
          group.kind === normalized.kind &&
          group.work_item_id === normalized.work_item_id &&
          group.pipeline_run_id === normalized.pipeline_run_id &&
          group.attempt_id === normalized.attempt_id &&
          group.generation === normalized.generation &&
          group.subject === normalized.subject &&
          group.payload_schema === normalized.payload_schema &&
          group.payload_hash === prepared.hash;
        if (!sameSemanticEvent) {
          throw new Error(
            `inbox group ${normalized.source_provider}:${normalized.event_group_key} changed intent`,
          );
        }
        status = "stale";
      }

      const payloadColumns = this.#payloadColumns(prepared);
      const timestamp = iso(this.#now(), "inbox created_at");
      this.#db.prepare(`
        INSERT INTO inbox_events (
          id, source_provider, delivery_id, kind, work_item_id, pipeline_run_id,
          attempt_id, generation, event_group_key, delivery_attempt, subject,
          payload_hash, payload_schema, inline_payload, blob_algorithm, blob_digest,
          blob_bytes, blob_encoding, blob_media_type, blob_payload_schema, status,
          available_at, version, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        normalized.id,
        normalized.source_provider,
        normalized.delivery_id,
        normalized.kind,
        normalized.work_item_id,
        normalized.pipeline_run_id,
        normalized.attempt_id,
        normalized.generation,
        normalized.event_group_key,
        normalized.delivery_attempt,
        normalized.subject,
        prepared.hash,
        normalized.payload_schema,
        payloadColumns.inline,
        payloadColumns.pointer?.algorithm ?? null,
        payloadColumns.pointer?.digest ?? null,
        payloadColumns.pointer?.bytes ?? null,
        payloadColumns.pointer?.encoding ?? null,
        payloadColumns.pointer?.media_type ?? null,
        payloadColumns.pointer?.payload_schema ?? null,
        status,
        normalized.available_at,
        timestamp,
        status === "stale" ? timestamp : null,
      );
      const inserted = this.#row(normalized.id)!;
      return {
        disposition: status === "stale" ? "reordered" : "inserted",
        retryable: false,
        acknowledge: true,
        event: this.#event(inserted),
      } as const;
    }).immediate();
  }

  leaseNext(input: {
    owner_id: string;
    lease_id: string;
    expires_at: string;
  }): KernelInboxEvent | null {
    bounded(input.owner_id, "inbox lease owner", 200, ID);
    bounded(input.lease_id, "inbox lease ID", 200, ID);
    iso(input.expires_at, "inbox lease expiry");
    return this.#db.transaction(() => {
      const now = iso(this.#now(), "inbox lease timestamp");
      this.#db.prepare(`
        UPDATE inbox_events
        SET status = 'pending', lease_id = NULL, lease_owner_id = NULL,
            lease_expires_at = NULL, version = version + 1
        WHERE status = 'processing' AND lease_expires_at <= ?
      `).run(now);
      for (let skipped = 0; skipped < KERNEL_INBOX_UNREADABLE_HEAD_LIMIT; skipped += 1) {
        const replay = this.#db.prepare(`
          SELECT * FROM inbox_events WHERE lease_id = ?
        `).get(input.lease_id) as InboxRow | undefined;
        if (replay) {
          if (
            replay.lease_owner_id !== input.owner_id || replay.lease_expires_at !== input.expires_at
          ) throw new Error(`inbox lease ${input.lease_id} conflicts with its replay`);
          try {
            return this.#event(replay);
          } catch (error) {
            if (!(error instanceof InboxPayloadCorruptionError)) throw error;
            this.#deadLetterUnreadable(replay, now);
            continue;
          }
        }
        const row = this.#db.prepare(`
          SELECT * FROM inbox_events
          WHERE status = 'pending' AND lease_id IS NULL AND available_at <= ?
          ORDER BY available_at, created_at, id LIMIT 1
        `).get(now) as InboxRow | undefined;
        if (!row) return null;
        const changed = this.#db.prepare(`
          UPDATE inbox_events
          SET status = 'processing', lease_id = ?, lease_owner_id = ?,
              lease_expires_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND status = 'pending' AND lease_id IS NULL
        `).run(input.lease_id, input.owner_id, input.expires_at, row.id, row.version);
        if (changed.changes !== 1) throw new Error(`inbox event ${row.id} lease race`);
        const leased = this.#row(row.id)!;
        try {
          return this.#event(leased);
        } catch (error) {
          if (!(error instanceof InboxPayloadCorruptionError)) throw error;
          this.#deadLetterUnreadable(leased, now);
        }
      }
      return null;
    }).immediate();
  }

  complete(input: {
    event_id: string;
    owner_id: string;
    lease_id: string;
    outcome: "consumed" | "stale" | "dead";
  }): void {
    bounded(input.event_id, "inbox event ID", 200, ID);
    bounded(input.owner_id, "inbox completion owner", 200, ID);
    bounded(input.lease_id, "inbox completion lease ID", 200, ID);
    const timestamp = iso(this.#now(), "inbox completion timestamp");
    const changed = this.#db.prepare(`
      UPDATE inbox_events
      SET status = ?, lease_id = NULL, lease_owner_id = NULL, lease_expires_at = NULL,
          version = version + 1, consumed_at = ?
      WHERE id = ? AND status = 'processing' AND lease_id = ? AND lease_owner_id = ?
    `).run(input.outcome, timestamp, input.event_id, input.lease_id, input.owner_id);
    if (changed.changes !== 1) throw new Error("inbox completion lease fence does not match");
  }

  retry(input: {
    event_id: string;
    owner_id: string;
    lease_id: string;
    available_at: string;
  }): void {
    bounded(input.event_id, "inbox event ID", 200, ID);
    bounded(input.owner_id, "inbox retry owner", 200, ID);
    bounded(input.lease_id, "inbox retry lease ID", 200, ID);
    const availableAt = iso(input.available_at, "inbox retry available_at");
    const now = iso(this.#now(), "inbox retry timestamp");
    if (Date.parse(availableAt) <= Date.parse(now)) {
      throw new Error("inbox retry available_at must be in the future");
    }
    const changed = this.#db.prepare(`
      UPDATE inbox_events
      SET status = 'pending', available_at = ?, lease_id = NULL,
          lease_owner_id = NULL, lease_expires_at = NULL,
          version = version + 1, consumed_at = NULL
      WHERE id = ? AND status = 'processing' AND lease_id = ? AND lease_owner_id = ?
    `).run(availableAt, input.event_id, input.lease_id, input.owner_id);
    if (changed.changes !== 1) throw new Error("inbox retry lease fence does not match");
  }

  get(eventId: string): KernelInboxEvent | undefined {
    bounded(eventId, "inbox event ID", 200, ID);
    const row = this.#row(eventId);
    return row ? this.#event(row) : undefined;
  }

  #normalizeInput(input: KernelInboxEventInput): Required<
    Omit<KernelInboxEventInput, "id" | "work_item_id" | "pipeline_run_id" | "attempt_id" | "subject" | "available_at">
  > & {
    id: string;
    work_item_id: string | null;
    pipeline_run_id: string | null;
    attempt_id: string | null;
    subject: string | null;
    available_at: string;
  } {
    bounded(input.source_provider, "inbox source_provider", 100, PROVIDER);
    bounded(input.delivery_id, "inbox delivery_id", 500);
    bounded(input.kind, "inbox kind", 200, KIND);
    bounded(input.event_group_key, "inbox event_group_key", 500);
    bounded(input.payload_schema, "inbox payload_schema", 200);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error("inbox generation must be a nonnegative integer");
    }
    if (!Number.isSafeInteger(input.delivery_attempt) || input.delivery_attempt < 1) {
      throw new Error("inbox delivery_attempt must be positive");
    }
    const pipelineRunId = input.pipeline_run_id ?? null;
    const attemptId = input.attempt_id ?? null;
    if (attemptId !== null && pipelineRunId === null) {
      throw new Error("attempt-bound inbox events require a pipeline run");
    }
    for (const [name, value] of [
      ["work_item_id", input.work_item_id],
      ["pipeline_run_id", pipelineRunId],
      ["attempt_id", attemptId],
    ] as const) {
      if (value !== undefined && value !== null) bounded(value, `inbox ${name}`, 200, ID);
    }
    const subject = input.subject ?? null;
    if (subject !== null) bounded(subject, "inbox subject", 500);
    const payload = jsonValueAt(input.payload, "inbox.payload");
    const id = input.id ?? `inbox-${digestCanonicalJson({
      source_provider: input.source_provider,
      delivery_id: input.delivery_id,
    }).slice(0, 48)}`;
    bounded(id, "inbox event ID", 200, ID);
    return {
      ...input,
      id,
      work_item_id: input.work_item_id ?? null,
      pipeline_run_id: pipelineRunId,
      attempt_id: attemptId,
      subject,
      payload,
      available_at: iso(input.available_at ?? this.#now(), "inbox available_at"),
    };
  }

  #preparePayload(payload: JsonValue, payloadSchema: string): PreparedPayload {
    const canonical = canonicalJson(payload);
    const bytes = Buffer.byteLength(canonical, "utf8");
    if (bytes > KERNEL_INBOX_MAX_PAYLOAD_BYTES) {
      throw new Error(`inbox payload exceeds ${KERNEL_INBOX_MAX_PAYLOAD_BYTES} bytes`);
    }
    const hash = digestCanonicalJson(payload);
    if (bytes <= KERNEL_INBOX_INLINE_PAYLOAD_MAX_BYTES) {
      return { canonical, hash, inline: canonical, token: null };
    }
    return {
      canonical,
      hash,
      inline: null,
      token: this.#blobs.put({
        bytes: canonical,
        encoding: "utf-8",
        media_type: "application/json",
        payload_schema: payloadSchema,
        expected_digest: hash,
      }),
    };
  }

  #payloadColumns(prepared: PreparedPayload): {
    inline: string | null;
    pointer: BlobPointer | null;
  } {
    if (prepared.token === null) return { inline: prepared.inline, pointer: null };
    return { inline: null, pointer: this.#blobs.assertToken(prepared.token) };
  }

  #row(id: string): InboxRow | undefined {
    return this.#db.prepare("SELECT * FROM inbox_events WHERE id = ?").get(id) as
      | InboxRow
      | undefined;
  }

  #deadLetterUnreadable(row: InboxRow, consumedAt: string): void {
    const changed = this.#db.prepare(`
      UPDATE inbox_events
      SET status = 'dead', lease_id = NULL, lease_owner_id = NULL,
          lease_expires_at = NULL, version = version + 1, consumed_at = ?
      WHERE id = ? AND version = ? AND status = 'processing'
    `).run(consumedAt, row.id, row.version);
    if (changed.changes !== 1) {
      throw new Error(`unreadable inbox event ${row.id} dead-letter compare-and-set failed`);
    }
  }

  #event(row: InboxRow): KernelInboxEvent {
    let blob: BlobPointer | null;
    try {
      blob = pointer(row);
    } catch (error) {
      throw new InboxPayloadCorruptionError(row.id, error instanceof Error ? error.message : String(error));
    }
    let raw: string | null;
    try {
      raw = blob === null ? row.inline_payload : this.#blobs.read(blob).toString("utf8");
    } catch (error) {
      if (error instanceof BlobIntegrityError) {
        throw new InboxPayloadCorruptionError(row.id, error.message);
      }
      throw error;
    }
    if (raw === null) throw new InboxPayloadCorruptionError(row.id, "payload is missing");
    let payload: JsonValue;
    try {
      payload = jsonValueAt(JSON.parse(raw), `inbox_event.${row.id}.payload`);
    } catch {
      throw new InboxPayloadCorruptionError(row.id, "payload is not valid JSON");
    }
    if (digestCanonicalJson(payload) !== row.payload_hash || canonicalJson(payload) !== raw) {
      throw new InboxPayloadCorruptionError(row.id, "payload hash or canonical bytes mismatch");
    }
    return {
      id: row.id,
      source_provider: row.source_provider,
      delivery_id: row.delivery_id,
      kind: row.kind,
      work_item_id: row.work_item_id,
      pipeline_run_id: row.pipeline_run_id,
      attempt_id: row.attempt_id,
      generation: row.generation,
      event_group_key: row.event_group_key,
      delivery_attempt: row.delivery_attempt,
      subject: row.subject,
      payload_hash: row.payload_hash,
      payload_schema: row.payload_schema,
      payload,
      status: row.status,
      available_at: row.available_at,
      lease_id: row.lease_id,
      lease_owner_id: row.lease_owner_id,
      lease_expires_at: row.lease_expires_at,
      version: row.version,
      created_at: row.created_at,
      consumed_at: row.consumed_at,
    };
  }
}
