import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const FRESH_EPOCH_VERSION = 1;
export const FRESH_EPOCH_APPLICATION_ID = 0x4f545632; // "OTV2"
export const FRESH_EPOCH_MIGRATION_NAME = "fresh execution kernel";

export const FRESH_EPOCH_TABLES = [
  "schema_migrations",
  "settings",
  "leases",
  "repository_registrations",
  "work_items",
  "inbox_events",
  "definitions",
  "pipeline_runs",
  "attempts",
  "records",
  "effects",
  "checkpoints",
] as const;

// Keep the baseline as one immutable artifact. The fresh epoch is replaced,
// never migrated from an older OpenThrottle schema.
export const FRESH_EPOCH_SCHEMA_SQL = String.raw`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
) STRICT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  mutable INTEGER NOT NULL CHECK (mutable IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    value_type = 'json' OR
    (value_type = 'string' AND json_type(value_json) = 'text') OR
    (value_type = 'number' AND json_type(value_json) IN ('integer', 'real')) OR
    (value_type = 'boolean' AND json_type(value_json) IN ('true', 'false'))
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE leases (
  lease_key TEXT PRIMARY KEY CHECK (length(lease_key) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 100),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  lease_id TEXT NOT NULL UNIQUE CHECK (length(lease_id) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL CHECK (length(expires_at) >= 20),
  version INTEGER NOT NULL CHECK (version >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT, WITHOUT ROWID;

CREATE TABLE repository_registrations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  control_provider TEXT NOT NULL CHECK (control_provider IN ('linear', 'github')),
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 1 AND 300),
  linear_team_id TEXT,
  linear_team_key TEXT,
  github_repo TEXT NOT NULL CHECK (length(github_repo) BETWEEN 3 AND 300),
  github_installation_id INTEGER CHECK (github_installation_id IS NULL OR github_installation_id > 0),
  base_branch TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 300),
  webhook_id INTEGER CHECK (webhook_id IS NULL OR webhook_id > 0),
  runtime_snapshot TEXT NOT NULL CHECK (length(runtime_snapshot) BETWEEN 1 AND 300),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (control_provider = 'linear' AND linear_team_id IS NOT NULL AND linear_team_key IS NOT NULL AND route_key = linear_team_id) OR
    (control_provider = 'github' AND linear_team_id IS NULL AND linear_team_key IS NULL AND route_key = github_repo)
  ),
  UNIQUE (control_provider, route_key),
  UNIQUE (github_repo)
) STRICT, WITHOUT ROWID;

CREATE TABLE work_items (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  repository_registration_id TEXT NOT NULL,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('linear', 'github', 'operator')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 300),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 300),
  state TEXT NOT NULL CHECK (state IN ('admitted', 'active', 'completed', 'needs_human', 'failed', 'canceled', 'superseded')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  request_payload_schema TEXT NOT NULL CHECK (length(request_payload_schema) BETWEEN 1 AND 200),
  request_inline_json TEXT CHECK (request_inline_json IS NULL OR (json_valid(request_inline_json) AND length(CAST(request_inline_json AS BLOB)) <= 65536)),
  request_blob_algorithm TEXT CHECK (request_blob_algorithm IS NULL OR request_blob_algorithm = 'sha256'),
  request_blob_digest TEXT CHECK (request_blob_digest IS NULL OR (length(request_blob_digest) = 64 AND request_blob_digest NOT GLOB '*[^0-9a-f]*')),
  request_blob_bytes INTEGER CHECK (request_blob_bytes IS NULL OR request_blob_bytes > 0),
  request_blob_encoding TEXT CHECK (request_blob_encoding IS NULL OR request_blob_encoding IN ('utf-8', 'binary')),
  request_blob_media_type TEXT,
  request_blob_payload_schema TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (request_inline_json IS NOT NULL AND request_blob_algorithm IS NULL AND request_blob_digest IS NULL AND request_blob_bytes IS NULL AND request_blob_encoding IS NULL AND request_blob_media_type IS NULL AND request_blob_payload_schema IS NULL) OR
    (request_inline_json IS NULL AND request_blob_algorithm = 'sha256' AND request_blob_digest IS NOT NULL AND request_blob_bytes > 0 AND request_blob_encoding IS NOT NULL AND request_blob_media_type IS NOT NULL AND request_blob_payload_schema = request_payload_schema)
  ),
  FOREIGN KEY (repository_registration_id) REFERENCES repository_registrations(id) ON DELETE RESTRICT,
  UNIQUE (source_provider, source_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  source_provider TEXT NOT NULL CHECK (length(source_provider) BETWEEN 1 AND 100),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
  work_item_id TEXT,
  pipeline_run_id TEXT,
  attempt_id TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  event_group_key TEXT NOT NULL CHECK (length(event_group_key) BETWEEN 1 AND 500),
  delivery_attempt INTEGER NOT NULL CHECK (delivery_attempt >= 1),
  subject TEXT,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_schema TEXT NOT NULL CHECK (length(payload_schema) BETWEEN 1 AND 200),
  inline_payload TEXT CHECK (inline_payload IS NULL OR (json_valid(inline_payload) AND length(CAST(inline_payload AS BLOB)) <= 65536)),
  blob_algorithm TEXT CHECK (blob_algorithm IS NULL OR blob_algorithm = 'sha256'),
  blob_digest TEXT CHECK (blob_digest IS NULL OR (length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*')),
  blob_bytes INTEGER CHECK (blob_bytes IS NULL OR blob_bytes > 0),
  blob_encoding TEXT CHECK (blob_encoding IS NULL OR blob_encoding IN ('utf-8', 'binary')),
  blob_media_type TEXT,
  blob_payload_schema TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'consumed', 'stale', 'dead')),
  available_at TEXT NOT NULL CHECK (length(available_at) >= 20),
  lease_id TEXT,
  lease_owner_id TEXT,
  lease_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  consumed_at TEXT,
  CHECK (
    (inline_payload IS NOT NULL AND blob_algorithm IS NULL AND blob_digest IS NULL AND blob_bytes IS NULL AND blob_encoding IS NULL AND blob_media_type IS NULL AND blob_payload_schema IS NULL) OR
    (inline_payload IS NULL AND blob_algorithm = 'sha256' AND blob_digest IS NOT NULL AND blob_bytes > 0 AND blob_encoding IS NOT NULL AND blob_media_type IS NOT NULL AND blob_payload_schema = payload_schema)
  ),
  CHECK (
    (lease_id IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL) OR
    (lease_id IS NOT NULL AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (attempt_id, pipeline_run_id) REFERENCES attempts(id, pipeline_run_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (source_provider, delivery_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE definitions (
  definition_kind TEXT NOT NULL CHECK (definition_kind IN ('agent', 'pipeline', 'skill', 'eval', 'config', 'loop')),
  definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 200),
  source_commit TEXT CHECK (source_commit IS NULL OR (length(source_commit) IN (40, 64) AND source_commit NOT GLOB '*[^0-9a-f]*')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  normalized_payload TEXT NOT NULL CHECK (json_valid(normalized_payload))
) STRICT;

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  work_item_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL CHECK (length(pipeline_id) BETWEEN 1 AND 200),
  definition_bundle_algorithm TEXT NOT NULL CHECK (definition_bundle_algorithm = 'sha256'),
  definition_bundle_hash TEXT NOT NULL CHECK (length(definition_bundle_hash) = 64 AND definition_bundle_hash NOT GLOB '*[^0-9a-f]*'),
  definition_bundle_bytes INTEGER NOT NULL CHECK (definition_bundle_bytes > 0),
  definition_bundle_encoding TEXT NOT NULL CHECK (definition_bundle_encoding = 'utf-8'),
  definition_bundle_media_type TEXT NOT NULL CHECK (definition_bundle_media_type = 'application/json'),
  definition_bundle_payload_schema TEXT NOT NULL CHECK (definition_bundle_payload_schema = 'openthrottle.definition-bundle/v1'),
  current_subject TEXT NOT NULL CHECK (length(current_subject) IN (40, 64) AND current_subject NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'no_change', 'needs_human', 'failed', 'canceled', 'superseded')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'no_change', 'needs_human', 'failed', 'canceled', 'superseded')),
  cursor_stage_id TEXT,
  cursor_version INTEGER NOT NULL CHECK (cursor_version >= 0),
  cursor_reentries_json TEXT NOT NULL CHECK (json_valid(cursor_reentries_json)),
  cursor_frontier_json TEXT NOT NULL CHECK (json_valid(cursor_frontier_json)),
  cursor_completed_scope_keys_json TEXT NOT NULL CHECK (json_valid(cursor_completed_scope_keys_json)),
  cursor_barrier_json TEXT CHECK (cursor_barrier_json IS NULL OR json_valid(cursor_barrier_json)),
  version INTEGER NOT NULL CHECK (version >= 0),
  work_retry_limit INTEGER NOT NULL CHECK (work_retry_limit >= 0),
  result_correction_limit INTEGER NOT NULL CHECK (result_correction_limit >= 0),
  last_transition_id TEXT,
  last_transition_hash TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK ((last_transition_id IS NULL) = (last_transition_hash IS NULL)),
  CHECK (last_transition_hash IS NULL OR (length(last_transition_hash) = 64 AND last_transition_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    (status IN ('pending', 'running') AND terminal_outcome IS NULL AND cursor_stage_id IS NOT NULL) OR
    (status NOT IN ('pending', 'running') AND terminal_outcome = status AND cursor_stage_id IS NULL)
  ),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  pipeline_run_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('stage', 'loop_item', 'fanout_member')),
  stage_id TEXT NOT NULL CHECK (length(stage_id) BETWEEN 1 AND 200),
  parent_attempt_id TEXT,
  scope_group_id TEXT,
  scope_item_id TEXT,
  scope_item_index INTEGER,
  repository_authority TEXT NOT NULL CHECK (repository_authority IN ('inspect', 'edit')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  definition_bundle_hash TEXT NOT NULL CHECK (length(definition_bundle_hash) = 64 AND definition_bundle_hash NOT GLOB '*[^0-9a-f]*'),
  input_subject TEXT NOT NULL CHECK (length(input_subject) IN (40, 64) AND input_subject NOT GLOB '*[^0-9a-f]*'),
  context_record_ids_json TEXT NOT NULL CHECK (json_valid(context_record_ids_json) AND json_type(context_record_ids_json) = 'array' AND json_array_length(context_record_ids_json) <= 256),
  context_checkpoint_ids_json TEXT NOT NULL CHECK (json_valid(context_checkpoint_ids_json) AND json_type(context_checkpoint_ids_json) = 'array' AND json_array_length(context_checkpoint_ids_json) <= 256),
  output_subject TEXT CHECK (output_subject IS NULL OR (length(output_subject) IN (40, 64) AND output_subject NOT GLOB '*[^0-9a-f]*')),
  native_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'work_complete', 'result_pending', 'recorded', 'settled', 'needs_human', 'failed', 'canceled', 'superseded')),
  version INTEGER NOT NULL CHECK (version >= 0),
  work_retry_ordinal INTEGER NOT NULL CHECK (work_retry_ordinal >= 0),
  result_correction_count INTEGER NOT NULL CHECK (result_correction_count >= 0),
  result_correction_deadline TEXT,
  unmet_dependency_count INTEGER NOT NULL DEFAULT 0 CHECK (unmet_dependency_count >= 0),
  lease_id TEXT,
  lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation >= 0),
  lease_worker_id TEXT,
  lease_purpose TEXT CHECK (lease_purpose IS NULL OR lease_purpose IN ('work', 'result_correction')),
  lease_expires_at TEXT,
  lease_started INTEGER CHECK (lease_started IS NULL OR lease_started IN (0, 1)),
  checkpoint_id TEXT,
  result_record_id TEXT,
  result_record_kind TEXT NOT NULL DEFAULT 'result' CHECK (result_record_kind = 'result'),
  decision_record_id TEXT,
  decision_record_kind TEXT NOT NULL DEFAULT 'decision' CHECK (decision_record_kind = 'decision'),
  pending_candidate_hash TEXT CHECK (pending_candidate_hash IS NULL OR (length(pending_candidate_hash) = 64 AND pending_candidate_hash NOT GLOB '*[^0-9a-f]*')),
  pending_diagnostics_json TEXT CHECK (pending_diagnostics_json IS NULL OR json_valid(pending_diagnostics_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (scope_kind = 'stage' AND parent_attempt_id IS NULL AND scope_group_id IS NULL AND scope_item_id IS NULL AND scope_item_index IS NULL) OR
    (scope_kind IN ('loop_item', 'fanout_member') AND parent_attempt_id IS NOT NULL AND scope_group_id IS NOT NULL AND scope_item_id IS NOT NULL AND scope_item_index >= 0)
  ),
  CHECK (
    (lease_id IS NULL AND lease_generation IS NULL AND lease_worker_id IS NULL AND lease_purpose IS NULL AND lease_expires_at IS NULL AND lease_started IS NULL) OR
    (lease_id IS NOT NULL AND lease_generation IS NOT NULL AND lease_worker_id IS NOT NULL AND lease_purpose IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_started IS NOT NULL)
  ),
  CHECK ((pending_diagnostics_json IS NULL) = (status <> 'result_pending')),
  CHECK (result_correction_deadline IS NULL OR native_session_id IS NOT NULL),
  CHECK (status <> 'result_pending' OR result_correction_deadline IS NOT NULL),
  CHECK (result_record_id IS NULL OR status IN ('recorded', 'settled')),
  CHECK ((decision_record_id IS NOT NULL) = (status = 'settled')),
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_attempt_id, pipeline_run_id) REFERENCES attempts(id, pipeline_run_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (checkpoint_id, pipeline_run_id, id) REFERENCES checkpoints(id, pipeline_run_id, attempt_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_record_id, pipeline_run_id, result_record_kind) REFERENCES records(id, pipeline_run_id, kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_record_id, pipeline_run_id, id) REFERENCES records(id, pipeline_run_id, attempt_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (decision_record_id, pipeline_run_id, decision_record_kind) REFERENCES records(id, pipeline_run_id, kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (id, pipeline_run_id),
  UNIQUE (id, pipeline_run_id, request_hash, definition_bundle_hash, input_subject)
) STRICT, WITHOUT ROWID;

CREATE TABLE records (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  pipeline_run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('result', 'decision', 'delivery')),
  semantic_key TEXT CHECK (semantic_key IS NULL OR length(semantic_key) BETWEEN 1 AND 500),
  payload_schema TEXT NOT NULL CHECK (length(payload_schema) BETWEEN 1 AND 200),
  inline_payload TEXT CHECK (inline_payload IS NULL OR (json_valid(inline_payload) AND length(CAST(inline_payload AS BLOB)) <= 65536)),
  blob_algorithm TEXT CHECK (blob_algorithm IS NULL OR blob_algorithm = 'sha256'),
  blob_digest TEXT CHECK (blob_digest IS NULL OR (length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*')),
  blob_bytes INTEGER CHECK (blob_bytes IS NULL OR blob_bytes > 0),
  blob_encoding TEXT CHECK (blob_encoding IS NULL OR blob_encoding IN ('utf-8', 'binary')),
  blob_media_type TEXT,
  blob_payload_schema TEXT,
  attempt_id TEXT,
  request_hash TEXT,
  definition_bundle_hash TEXT,
  input_subject TEXT,
  output_subject TEXT,
  original_candidate_hash TEXT,
  normalized_candidate_hash TEXT,
  reducer TEXT,
  input_record_ids_json TEXT,
  input_record_count INTEGER,
  effect_id TEXT,
  idempotency_key TEXT,
  external_identity TEXT,
  delivery_status TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  CHECK (
    (inline_payload IS NOT NULL AND blob_algorithm IS NULL AND blob_digest IS NULL AND blob_bytes IS NULL AND blob_encoding IS NULL AND blob_media_type IS NULL AND blob_payload_schema IS NULL) OR
    (inline_payload IS NULL AND blob_algorithm = 'sha256' AND blob_digest IS NOT NULL AND blob_bytes > 0 AND blob_encoding IS NOT NULL AND blob_media_type IS NOT NULL AND blob_payload_schema = payload_schema)
  ),
  CHECK (
    (kind = 'result' AND attempt_id IS NOT NULL AND request_hash IS NOT NULL AND definition_bundle_hash IS NOT NULL AND input_subject IS NOT NULL AND original_candidate_hash IS NOT NULL AND normalized_candidate_hash IS NOT NULL AND reducer IS NULL AND input_record_ids_json IS NULL AND input_record_count IS NULL AND effect_id IS NULL AND idempotency_key IS NULL AND external_identity IS NULL AND delivery_status IS NULL) OR
    (kind = 'decision' AND attempt_id IS NULL AND request_hash IS NULL AND definition_bundle_hash IS NULL AND input_subject IS NULL AND output_subject IS NULL AND original_candidate_hash IS NULL AND normalized_candidate_hash IS NULL AND reducer IS NOT NULL AND input_record_ids_json IS NOT NULL AND json_valid(input_record_ids_json) AND input_record_count >= 0 AND effect_id IS NULL AND idempotency_key IS NULL AND external_identity IS NULL AND delivery_status IS NULL) OR
    (kind = 'delivery' AND attempt_id IS NULL AND request_hash IS NULL AND definition_bundle_hash IS NULL AND input_subject IS NULL AND output_subject IS NULL AND original_candidate_hash IS NULL AND normalized_candidate_hash IS NULL AND reducer IS NULL AND input_record_ids_json IS NULL AND input_record_count IS NULL AND effect_id IS NOT NULL AND idempotency_key IS NOT NULL AND external_identity IS NOT NULL AND delivery_status IN ('confirmed', 'rejected'))
  ),
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, pipeline_run_id, request_hash, definition_bundle_hash, input_subject) REFERENCES attempts(id, pipeline_run_id, request_hash, definition_bundle_hash, input_subject) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (effect_id, pipeline_run_id, idempotency_key, external_identity) REFERENCES effects(id, pipeline_run_id, idempotency_key, target) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (id, pipeline_run_id),
  UNIQUE (id, pipeline_run_id, kind),
  UNIQUE (id, pipeline_run_id, attempt_id),
  UNIQUE (id, pipeline_run_id, effect_id),
  UNIQUE (pipeline_run_id, sequence)
) STRICT, WITHOUT ROWID;

CREATE TABLE effects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  pipeline_run_id TEXT NOT NULL,
  decision_record_id TEXT NOT NULL,
  decision_record_kind TEXT NOT NULL DEFAULT 'decision' CHECK (decision_record_kind = 'decision'),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 3 AND 200),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 500),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 1000),
  subject TEXT,
  payload_schema TEXT NOT NULL CHECK (length(payload_schema) BETWEEN 1 AND 200),
  inline_payload TEXT CHECK (inline_payload IS NULL OR (json_valid(inline_payload) AND length(CAST(inline_payload AS BLOB)) <= 65536)),
  blob_algorithm TEXT CHECK (blob_algorithm IS NULL OR blob_algorithm = 'sha256'),
  blob_digest TEXT CHECK (blob_digest IS NULL OR (length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*')),
  blob_bytes INTEGER CHECK (blob_bytes IS NULL OR blob_bytes > 0),
  blob_encoding TEXT CHECK (blob_encoding IS NULL OR blob_encoding IN ('utf-8', 'binary')),
  blob_media_type TEXT,
  blob_payload_schema TEXT,
  intent_hash TEXT NOT NULL CHECK (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'unknown', 'acknowledged', 'rejected', 'canceled', 'failed')),
  version INTEGER NOT NULL CHECK (version >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL CHECK (length(available_at) >= 20),
  lease_id TEXT,
  lease_worker_id TEXT,
  lease_expires_at TEXT,
  lease_execution_mode TEXT CHECK (lease_execution_mode IS NULL OR lease_execution_mode IN ('dispatch_or_reconcile', 'reconcile_only')),
  dispatch_lease_id TEXT,
  dispatch_worker_id TEXT,
  delivery_record_id TEXT,
  delivery_record_kind TEXT NOT NULL DEFAULT 'delivery' CHECK (delivery_record_kind = 'delivery'),
  unknown_detail TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  CHECK (
    (inline_payload IS NOT NULL AND blob_algorithm IS NULL AND blob_digest IS NULL AND blob_bytes IS NULL AND blob_encoding IS NULL AND blob_media_type IS NULL AND blob_payload_schema IS NULL) OR
    (inline_payload IS NULL AND blob_algorithm = 'sha256' AND blob_digest IS NOT NULL AND blob_bytes > 0 AND blob_encoding IS NOT NULL AND blob_media_type IS NOT NULL AND blob_payload_schema = payload_schema)
  ),
  CHECK (
    (lease_id IS NULL AND lease_worker_id IS NULL AND lease_expires_at IS NULL AND lease_execution_mode IS NULL) OR
    (lease_id IS NOT NULL AND lease_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_execution_mode IS NOT NULL)
  ),
  CHECK ((status = 'processing') = (lease_id IS NOT NULL)),
  CHECK ((dispatch_lease_id IS NULL) = (dispatch_worker_id IS NULL)),
  CHECK (dispatch_lease_id IS NULL OR lease_execution_mode = 'reconcile_only' OR status IN ('unknown', 'acknowledged', 'rejected', 'failed', 'canceled')),
  CHECK ((status IN ('acknowledged', 'rejected')) = (delivery_record_id IS NOT NULL)),
  CHECK ((status = 'unknown') = (unknown_detail IS NOT NULL)),
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_record_id, pipeline_run_id, decision_record_kind) REFERENCES records(id, pipeline_run_id, kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (delivery_record_id, pipeline_run_id, delivery_record_kind) REFERENCES records(id, pipeline_run_id, kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (delivery_record_id, pipeline_run_id, id) REFERENCES records(id, pipeline_run_id, effect_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (id, pipeline_run_id),
  UNIQUE (id, pipeline_run_id, idempotency_key, target)
) STRICT, WITHOUT ROWID;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  pipeline_run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  checkpoint_hash TEXT NOT NULL CHECK (length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'),
  semantic_key TEXT NOT NULL CHECK (length(semantic_key) BETWEEN 1 AND 500),
  request_hash TEXT NOT NULL,
  definition_bundle_hash TEXT NOT NULL,
  input_subject TEXT NOT NULL,
  output_subject TEXT,
  native_session_id TEXT,
  payload_schema TEXT NOT NULL CHECK (length(payload_schema) BETWEEN 1 AND 200),
  inline_payload TEXT CHECK (inline_payload IS NULL OR (json_valid(inline_payload) AND length(CAST(inline_payload AS BLOB)) <= 65536)),
  blob_algorithm TEXT CHECK (blob_algorithm IS NULL OR blob_algorithm = 'sha256'),
  blob_digest TEXT CHECK (blob_digest IS NULL OR (length(blob_digest) = 64 AND blob_digest NOT GLOB '*[^0-9a-f]*')),
  blob_bytes INTEGER CHECK (blob_bytes IS NULL OR blob_bytes > 0),
  blob_encoding TEXT CHECK (blob_encoding IS NULL OR blob_encoding IN ('utf-8', 'binary')),
  blob_media_type TEXT,
  blob_payload_schema TEXT,
  captured_at TEXT NOT NULL CHECK (length(captured_at) >= 20),
  CHECK (
    (inline_payload IS NOT NULL AND blob_algorithm IS NULL AND blob_digest IS NULL AND blob_bytes IS NULL AND blob_encoding IS NULL AND blob_media_type IS NULL AND blob_payload_schema IS NULL) OR
    (inline_payload IS NULL AND blob_algorithm = 'sha256' AND blob_digest IS NOT NULL AND blob_bytes > 0 AND blob_encoding IS NOT NULL AND blob_media_type IS NOT NULL AND blob_payload_schema = payload_schema)
  ),
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, pipeline_run_id, request_hash, definition_bundle_hash, input_subject) REFERENCES attempts(id, pipeline_run_id, request_hash, definition_bundle_hash, input_subject) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (id, pipeline_run_id),
  UNIQUE (id, pipeline_run_id, attempt_id),
  UNIQUE (attempt_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER settings_immutable_insert
BEFORE INSERT ON settings
WHEN EXISTS (SELECT 1 FROM settings WHERE key = NEW.key AND mutable = 0)
BEGIN
  SELECT RAISE(ABORT, 'immutable setting');
END;

CREATE TRIGGER settings_immutable_update
BEFORE UPDATE ON settings
WHEN OLD.mutable = 0
BEGIN
  SELECT RAISE(ABORT, 'immutable setting');
END;

CREATE TRIGGER settings_immutable_delete
BEFORE DELETE ON settings
WHEN OLD.mutable = 0
BEGIN
  SELECT RAISE(ABORT, 'immutable setting');
END;

CREATE TRIGGER work_items_request_immutable_update
BEFORE UPDATE OF
  repository_registration_id, source_provider, source_id, source_reference, title,
  request_payload_schema, request_inline_json, request_blob_algorithm,
  request_blob_digest, request_blob_bytes, request_blob_encoding,
  request_blob_media_type, request_blob_payload_schema
ON work_items
BEGIN
  SELECT RAISE(ABORT, 'immutable work request');
END;

CREATE INDEX leases_expiry_idx ON leases(expires_at, lease_key);
CREATE INDEX repository_registrations_route_idx ON repository_registrations(control_provider, route_key);
CREATE UNIQUE INDEX repository_registrations_linear_team_idx ON repository_registrations(linear_team_id) WHERE control_provider = 'linear';
CREATE INDEX work_items_state_idx ON work_items(state, updated_at, id);
CREATE INDEX inbox_events_available_idx ON inbox_events(status, available_at, id);
CREATE INDEX inbox_events_group_idx ON inbox_events(
  source_provider, event_group_key, delivery_attempt, created_at, id
);
CREATE INDEX inbox_events_work_idx ON inbox_events(work_item_id, created_at, id);
CREATE INDEX inbox_events_attempt_idx ON inbox_events(attempt_id, generation, event_group_key, delivery_attempt);
CREATE INDEX definitions_lookup_idx ON definitions(definition_kind, definition_id, source_commit);
CREATE INDEX definitions_content_idx ON definitions(content_hash);
CREATE UNIQUE INDEX definitions_identity_idx ON definitions(
  definition_kind, definition_id, ifnull(source_commit, ''), content_hash, normalized_payload
);
CREATE INDEX pipeline_runs_work_idx ON pipeline_runs(work_item_id, created_at, id);
CREATE INDEX pipeline_runs_status_idx ON pipeline_runs(status, updated_at, id);
CREATE INDEX pipeline_runs_bundle_idx ON pipeline_runs(definition_bundle_hash);
CREATE INDEX attempts_schedule_idx ON attempts(status, unmet_dependency_count, lease_expires_at, pipeline_run_id, id);
CREATE INDEX attempts_run_stage_idx ON attempts(pipeline_run_id, stage_id, status, id);
CREATE INDEX attempts_parent_idx ON attempts(parent_attempt_id, pipeline_run_id);
CREATE INDEX attempts_structured_planning_idx ON attempts(
  pipeline_run_id,
  definition_bundle_hash,
  scope_kind,
  parent_attempt_id,
  scope_group_id,
  stage_id,
  scope_item_id,
  status,
  id
);
CREATE INDEX attempts_request_idx ON attempts(request_hash);
CREATE UNIQUE INDEX attempts_active_lease_idx ON attempts(lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX records_run_idx ON records(pipeline_run_id, created_at, id);
CREATE INDEX records_attempt_idx ON records(attempt_id, kind, id);
CREATE INDEX records_effect_idx ON records(effect_id, kind, id);
CREATE UNIQUE INDEX records_result_owner_idx ON records(attempt_id) WHERE kind = 'result';
CREATE UNIQUE INDEX records_delivery_owner_idx ON records(effect_id) WHERE kind = 'delivery';
CREATE UNIQUE INDEX records_decision_semantic_key_idx ON records(pipeline_run_id, semantic_key) WHERE kind = 'decision' AND semantic_key IS NOT NULL;
CREATE INDEX effects_schedule_idx ON effects(status, lease_expires_at, pipeline_run_id, id);
CREATE INDEX effects_run_idx ON effects(pipeline_run_id, status, id);
CREATE INDEX effects_decision_idx ON effects(decision_record_id, pipeline_run_id);
CREATE UNIQUE INDEX effects_active_lease_idx ON effects(lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX checkpoints_attempt_idx ON checkpoints(attempt_id, ordinal, captured_at, id);
CREATE INDEX checkpoints_semantic_key_idx ON checkpoints(pipeline_run_id, semantic_key, captured_at, id);
CREATE INDEX checkpoints_blob_idx ON checkpoints(blob_digest) WHERE blob_digest IS NOT NULL;
`;

export const FRESH_EPOCH_SCHEMA_CHECKSUM = createHash("sha256")
  .update(FRESH_EPOCH_SCHEMA_SQL, "utf8")
  .digest("hex");

export function applyFreshEpochSchema(db: Database.Database, appliedAt: string): void {
  db.pragma(`application_id = ${FRESH_EPOCH_APPLICATION_ID}`);
  db.pragma(`user_version = ${FRESH_EPOCH_VERSION}`);
  db.exec(FRESH_EPOCH_SCHEMA_SQL);
  db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `).run(
    FRESH_EPOCH_VERSION,
    FRESH_EPOCH_MIGRATION_NAME,
    FRESH_EPOCH_SCHEMA_CHECKSUM,
    appliedAt,
  );
}
