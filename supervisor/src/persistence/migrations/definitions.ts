import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { PipelineInstance } from "../../pipeline/store.js";
import { persistSelectionPublications } from "../pipeline/helpers.js";

interface DatabaseMigrationDefinition {
  version: number;
  name: string;
  source: string;
  up(db: Database.Database): void;
}

export interface DatabaseMigration extends DatabaseMigrationDefinition {
  checksum: string;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function hasColumns(db: Database.Database, table: string, columns: string[]): boolean {
  if (!hasTable(db, table)) return false;
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  return columns.every((column) => present.has(column));
}

function hasIndex(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
  );
}

function renameColumnIfPresent(
  db: Database.Database,
  table: string,
  from: string,
  to: string
): void {
  if (hasColumns(db, table, [from]) && !hasColumns(db, table, [to])) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}

function renameTableIfPresent(
  db: Database.Database,
  from: string,
  to: string
): void {
  if (hasTable(db, from) && !hasTable(db, to)) {
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  }
}

function backfillPipelinePublicationState(db: Database.Database): void {
  if (!hasTable(db, "pipeline_publication_receipts")) return;
  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE pipeline_publication_receipts
    SET payload = COALESCE(payload, '{}'),
        next_attempt_at = COALESCE(next_attempt_at, created_at, ?),
        updated_at = COALESCE(updated_at, created_at, ?)
  `).run(timestamp, timestamp);
}

function backfillPipelineExecutionIdentity(db: Database.Database): void {
  if (!hasColumns(db, "tickets", ["linear_issue_id", "branch", "agent"])) return;
  db.exec(`
    UPDATE pipeline_instances
    SET branch = (SELECT branch FROM tickets WHERE tickets.linear_issue_id = pipeline_instances.linear_issue_id),
        agent = (SELECT agent FROM tickets WHERE tickets.linear_issue_id = pipeline_instances.linear_issue_id)
  `);
}

function backfillLegacySessionExecutions(db: Database.Database): void {
  if (!hasColumns(db, "agent_sessions", ["id", "linear_issue_id", "generation"])) return;
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO session_executions (
      linear_session_id, linear_issue_id, generation, execution_mode,
      pipeline_instance_id, pinned_at
    )
    SELECT id, linear_issue_id, generation, 'legacy', NULL, ?
    FROM agent_sessions
  `).run(timestamp);
}

function backfillRunLiveness(db: Database.Database): void {
  if (!hasColumns(db, "runs", ["id", "status", "started_at"])) return;
  db.prepare(`
    INSERT OR IGNORE INTO run_liveness(run_id, actor_state, updated_at)
    SELECT id, 'running', started_at FROM runs WHERE status = 'running'
  `).run();
}

function backfillPipelineAttemptActors(db: Database.Database): void {
  if (
    !hasColumns(db, "pipeline_stage_attempts", ["id", "run_id", "planned_run_id", "created_at", "updated_at"]) ||
    !hasColumns(db, "runs", ["id", "status", "started_at"])
  ) return;
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO pipeline_attempt_actors (
      attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
      settlement_reason, termination_confirmed_at, quarantine_reason, created_at, updated_at
    )
    SELECT
      psa.id,
      r.id,
      CASE
        WHEN l.actor_state IN ('running', 'reaping', 'quarantined', 'settled') THEN l.actor_state
        WHEN r.status IN ('running', 'reaping', 'quarantined') THEN r.status
        ELSE 'settled'
      END,
      l.last_heartbeat_at,
      l.settlement_owner,
      l.settlement_reason,
      l.termination_confirmed_at,
      l.quarantine_reason,
      COALESCE(r.started_at, psa.created_at, ?),
      COALESCE(l.updated_at, r.started_at, psa.updated_at, ?)
    FROM pipeline_stage_attempts psa
    JOIN runs r ON r.id = COALESCE(psa.run_id, psa.planned_run_id)
    LEFT JOIN run_liveness l ON l.run_id = r.id
  `).run(timestamp, timestamp);
}

const durableWorkSchema = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  pipeline_instance_id TEXT,
  run_id TEXT,
  native_session_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  source TEXT NOT NULL,
  priority INTEGER NOT NULL,
  body TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'leased', 'dispatched', 'acknowledged', 'consumed',
    'canceled', 'dead', 'reconciliation'
  )),
  active_delivery_id TEXT,
  consumed_by_attempt_id TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT,
  canceled_at TEXT
);
CREATE INDEX work_items_claim_idx
  ON work_items(linear_session_id, status, priority, available_at, created_at);

CREATE TABLE work_item_sources (
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  PRIMARY KEY(source_table, source_id),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
);

CREATE TABLE work_deliveries (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  idempotency_key TEXT NOT NULL UNIQUE,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  pipeline_instance_id TEXT,
  run_id TEXT NOT NULL,
  native_session_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'leased', 'dispatched', 'acknowledged', 'consumed',
    'canceled', 'dead', 'expired'
  )),
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  acknowledged_at TEXT,
  consumed_at TEXT,
  last_error TEXT,
  UNIQUE(work_item_id, attempt_ordinal),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
);
CREATE INDEX work_deliveries_lease_idx ON work_deliveries(status, lease_until);

CREATE TABLE migration_reconciliation (
  migration_version INTEGER NOT NULL,
  category TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(migration_version, category)
);
`;

const lifecycleSchema = `
CREATE TABLE run_liveness (
  run_id TEXT PRIMARY KEY,
  actor_state TEXT NOT NULL DEFAULT 'running'
    CHECK(actor_state IN ('running', 'reaping', 'quarantined', 'settled')),
  last_heartbeat_at TEXT,
  settlement_owner TEXT,
  settlement_reason TEXT,
  termination_confirmed_at TEXT,
  quarantine_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT
);
CREATE INDEX run_liveness_state_idx ON run_liveness(actor_state, last_heartbeat_at);

CREATE TABLE supervisor_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  snapshot_id TEXT,
  PRIMARY KEY(provider, provider_event_id)
);
CREATE INDEX provider_events_snapshot_idx
  ON provider_events(linear_issue_id, generation, head_sha, snapshot_id, received_at);

CREATE TABLE feedback_snapshots (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  provider_watermark TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('collecting', 'claimed', 'consumed', 'stale')),
  repair_round INTEGER CHECK(repair_round IS NULL OR repair_round >= 1),
  work_item_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  consumed_at TEXT,
  UNIQUE(linear_issue_id, generation, head_sha, repair_round)
);

CREATE TABLE feedback_snapshot_events (
  snapshot_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, provider, provider_event_id),
  FOREIGN KEY(snapshot_id) REFERENCES feedback_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider, provider_event_id)
    REFERENCES provider_events(provider, provider_event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX feedback_snapshots_collecting_unique
  ON feedback_snapshots(linear_issue_id, linear_session_id, generation, head_sha)
  WHERE status = 'collecting';
CREATE UNIQUE INDEX feedback_snapshots_work_item_unique
  ON feedback_snapshots(work_item_id)
  WHERE work_item_id IS NOT NULL;
`;

const lifecycleEventIndex = `
CREATE INDEX sandbox_events_run_liveness_idx
  ON sandbox_events(run_id, kind, created_at);
`;

const pipelineCoordinatorSchema = `
CREATE TABLE pipeline_catalog_entries (
  pipeline_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  digest TEXT NOT NULL,
  normalized_manifest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(pipeline_id, version),
  UNIQUE(pipeline_id, version, digest)
);

CREATE TABLE pipeline_catalog_aliases (
  alias TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_id, version, digest)
    REFERENCES pipeline_catalog_entries(pipeline_id, version, digest) ON DELETE RESTRICT
);

CREATE TABLE runtime_capability_descriptors (
  runtime_release TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  protocol TEXT NOT NULL,
  normalized_descriptor TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE(runtime_release, digest)
);

CREATE TABLE repository_config_snapshots (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  digest TEXT NOT NULL,
  normalized_config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(repository, base_commit, blob_sha, digest),
  UNIQUE(id, repository, base_commit, digest)
);

CREATE TABLE pipeline_instances (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  pipeline_id TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  normalized_manifest TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  repository_config_snapshot_id TEXT NOT NULL,
  repository_config_digest TEXT NOT NULL,
  runtime_release TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  executor_protocol TEXT NOT NULL,
  authorized_capabilities TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'dispatchable', 'running', 'waiting_provider', 'waiting_human',
    'completion_pending_publication', 'shipped', 'no_change', 'needs_human',
    'canceled', 'superseded', 'failed', 'publication_blocked'
  )),
  active_stage_id TEXT,
  wait_reason TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  reentry_count INTEGER NOT NULL DEFAULT 0 CHECK(reentry_count >= 0),
  immutable_subject TEXT,
  terminal_outcome TEXT CHECK(terminal_outcome IS NULL OR terminal_outcome IN (
    'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id) ON DELETE RESTRICT,
  FOREIGN KEY(linear_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(linear_session_id, linear_issue_id, generation)
    REFERENCES agent_sessions(id, linear_issue_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_id, pipeline_version, manifest_digest)
    REFERENCES pipeline_catalog_entries(pipeline_id, version, digest) ON DELETE RESTRICT,
  FOREIGN KEY(repository_config_snapshot_id, repository, base_commit, repository_config_digest)
    REFERENCES repository_config_snapshots(id, repository, base_commit, digest) ON DELETE RESTRICT,
  FOREIGN KEY(runtime_release, capability_digest)
    REFERENCES runtime_capability_descriptors(runtime_release, digest) ON DELETE RESTRICT,
  UNIQUE(linear_session_id, generation),
  UNIQUE(id, generation),
  UNIQUE(id, linear_session_id, linear_issue_id, generation)
);
CREATE INDEX pipeline_instances_status_idx ON pipeline_instances(status, updated_at);

CREATE TABLE session_executions (
  linear_session_id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('legacy', 'pipeline')),
  pipeline_instance_id TEXT UNIQUE,
  pinned_at TEXT NOT NULL,
  FOREIGN KEY(linear_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(linear_session_id, linear_issue_id, generation)
    REFERENCES agent_sessions(id, linear_issue_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_instance_id, linear_session_id, linear_issue_id, generation)
    REFERENCES pipeline_instances(id, linear_session_id, linear_issue_id, generation) ON DELETE RESTRICT,
  CHECK((execution_mode = 'legacy' AND pipeline_instance_id IS NULL)
    OR (execution_mode = 'pipeline' AND pipeline_instance_id IS NOT NULL))
);

CREATE TABLE pipeline_instance_stages (
  pipeline_instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'dispatchable', 'running', 'passed', 'skipped', 'waiting',
    'failed', 'canceled', 'superseded'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  reentry_count INTEGER NOT NULL DEFAULT 0 CHECK(reentry_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(pipeline_instance_id, stage_id),
  UNIQUE(pipeline_instance_id, ordinal),
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  reentry_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(reentry_ordinal >= 0),
  run_id TEXT UNIQUE,
  request_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  native_context_policy TEXT NOT NULL CHECK(native_context_policy IN (
    'none', 'fresh', 'resume_required', 'prefer_resume', 'fresh_review'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'leased', 'dispatched', 'acknowledged', 'running',
    'completed', 'canceled', 'superseded', 'failed'
  )),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN (
    'success', 'no_change', 'semantic_repair_required',
    'retryable_infrastructure_failure', 'needs_human', 'canceled',
    'superseded', 'failure'
  )),
  result_hash TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal),
  UNIQUE(id, pipeline_instance_id),
  UNIQUE(id, run_id),
  FOREIGN KEY(pipeline_instance_id, stage_id)
    REFERENCES pipeline_instance_stages(pipeline_instance_id, stage_id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT
);
CREATE INDEX pipeline_attempts_status_idx ON pipeline_stage_attempts(status, updated_at);

CREATE UNIQUE INDEX work_items_pipeline_binding_identity_idx
  ON work_items(id, pipeline_instance_id);

CREATE TABLE run_stage_bindings (
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  bound_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, run_id)
    REFERENCES pipeline_stage_attempts(id, run_id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_work_bindings (
  work_item_id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  FOREIGN KEY(work_item_id, pipeline_instance_id)
    REFERENCES work_items(id, pipeline_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_inbox_events (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  kind TEXT NOT NULL CHECK(kind IN (
    'stage_acknowledged', 'stage_result', 'provider_snapshot', 'human_answer',
    'stop', 'supersede', 'effect_acknowledged', 'effect_failed'
  )),
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'consumed', 'stale', 'dead')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT
);
CREATE INDEX pipeline_inbox_pending_idx ON pipeline_inbox_events(pipeline_instance_id, status, created_at);

CREATE TABLE pipeline_artifacts (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'stage_result', 'review', 'command_result', 'provider_check',
    'human_approval', 'publish_subject'
  )),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  assurance TEXT NOT NULL CHECK(assurance IN (
    'semantic_attested', 'semantic_corroborated', 'executor_verified',
    'provider_verified', 'human_approved'
  )),
  subject TEXT,
  payload TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_gate_receipts (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN (
    'result', 'semantic', 'command', 'provider', 'human', 'publish_subject'
  )),
  policy_digest TEXT NOT NULL,
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'skipped', 'not_configured')),
  artifact_hashes TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_publication_receipts (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('linear_ledger', 'github_summary', 'pull_request')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
  external_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_effect_intents (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
  kind TEXT NOT NULL CHECK(kind IN (
    'provision', 'bootstrap', 'dispatch_stage', 'stop', 'quarantine', 'cleanup',
    'publish_linear', 'publish_github', 'publish_pr'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  last_error TEXT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  UNIQUE(pipeline_instance_id, transition_version, kind, idempotency_key)
);
CREATE INDEX pipeline_effects_pending_idx ON pipeline_effect_intents(status, next_attempt_at);
`;

// Checksums must be identical in the source (tsx/vitest) and compiled Node
// runtimes. Function#toString is transpiler-dependent, so each migration owns a
// stable source manifest alongside its executable implementation. Never edit a
// shipped manifest; append a new migration instead.
const durableWorkMigrationSource = `${durableWorkSchema}
backfill-contract:legacy-session-work-and-inbox/v1
legacy claimed and unowned consumed rows -> reconciliation
legacy delivered inbox with a current run -> dispatched-unverified
source identity or body mismatch -> reconciliation
record source, mapped, delivery, terminal, and reconciliation counts`;
const lifecycleMigrationSource = `${lifecycleSchema}
backfill-contract:active-run-liveness/v1
running legacy run -> running liveness rooted at started_at`;
const lifecycleEventIndexMigrationSource = `${lifecycleEventIndex}
index-contract:create-only-when-sandbox-events-exists/v1`;
const pipelineCoordinatorMigrationSource = `${pipelineCoordinatorSchema}
backfill-contract:every-existing-agent-session-is-legacy/v1
audit-bearing pipeline records use restricted foreign keys and immutable identities`;

const canonicalGateReceiptSchema = `
ALTER TABLE pipeline_gate_receipts ADD COLUMN payload TEXT;
ALTER TABLE pipeline_instances ADD COLUMN branch TEXT;
ALTER TABLE pipeline_instances ADD COLUMN agent TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN planned_run_id TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN expected_subject TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN native_session_id TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN request_payload TEXT;
CREATE UNIQUE INDEX pipeline_attempts_planned_run_unique
  ON pipeline_stage_attempts(planned_run_id) WHERE planned_run_id IS NOT NULL;
`;

const canonicalGateReceiptMigrationSource = `${canonicalGateReceiptSchema}
gate receipts persist the canonical evaluator input and decision payload/v1
backfill-contract:pipeline branch and agent from ticket when the legacy table exists`;

const linearOutboxPublicationSchema = `
ALTER TABLE linear_outbox ADD COLUMN external_id TEXT;
ALTER TABLE linear_outbox ADD COLUMN external_url TEXT;
ALTER TABLE linear_outbox ADD COLUMN attachment_url TEXT;
`;

const pipelinePublicationStateSchema = `
ALTER TABLE pipeline_publication_receipts ADD COLUMN payload TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN external_url TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN target_url TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN attachment_url TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN last_error TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN next_attempt_at TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN resume_status TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN blocked_from_status TEXT;
ALTER TABLE pipeline_publication_receipts ADD COLUMN updated_at TEXT;
CREATE INDEX pipeline_publications_process_idx
  ON pipeline_publication_receipts(kind, status, next_attempt_at);
`;

const durablePipelinePublicationSchema = `${linearOutboxPublicationSchema}
${pipelinePublicationStateSchema}`;

const durablePipelinePublicationMigrationSource = `${durablePipelinePublicationSchema}
publication-contract:linear receipt id is the ordered outbox id/v1
publication-contract:github summary is a single mutable projection per pipeline instance/v1
base-schema-or-migration ensures every Linear outbox receipt column exists
terminal and human-wait states advance only after their Linear receipt acknowledgement`;

const pipelineRuntimeResourceSchema = `
CREATE TABLE pipeline_runtime_resources (
  pipeline_instance_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'quarantined', 'cleaned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT
);
CREATE INDEX pipeline_runtime_resources_status_idx
  ON pipeline_runtime_resources(status, updated_at);
`;

const pipelineRuntimeResourceMigrationSource = `${pipelineRuntimeResourceSchema}
runtime-resource-contract:one opaque provider resource per pinned pipeline instance/v1
activation, legacy cleanup, and schema contraction remain separate releases`;

const pipelineIntentSchema = `
ALTER TABLE pipeline_instances ADD COLUMN task_type TEXT NOT NULL DEFAULT 'implement'
  CHECK(task_type IN ('implement', 'investigate'));
ALTER TABLE pipeline_instances ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE pipeline_instances ADD COLUMN published_commit TEXT;
UPDATE pipeline_instances SET task_type = 'investigate'
  WHERE pipeline_id = 'ce/investigate';
`;

const pipelineIntentMigrationSource = `${pipelineIntentSchema}
pipeline-intent-contract:execution intent is pinned independently of manifest identity/v1
existing ce/investigate rows retain their historical investigate classification
base-branch-contract:review and publication receive the immutable selected branch rather than a commit-shaped substitute/v1
backfill-contract:existing pipeline instances inherit the selected branch from their bound ticket when available
provider-revision-contract:executor-verified published commit is pinned separately from the gated tree/v1`;

const pipelinePublishedSubjectSchema = `
ALTER TABLE pipeline_instances ADD COLUMN published_subject TEXT;
`;

const pipelinePublishedSubjectMigrationSource = `${pipelinePublishedSubjectSchema}
publication-binding-contract:published commit evidence is bound to the exact workspace tree subject it covered/v1
rolling-upgrade-contract:existing published commits are not backfilled from mutable immutable_subject and fail closed until republished/v1`;

const pipelineAttemptActorSchema = `
CREATE TABLE pipeline_attempt_actors (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  actor_state TEXT NOT NULL DEFAULT 'running'
    CHECK(actor_state IN ('running', 'reaping', 'quarantined', 'settled')),
  last_heartbeat_at TEXT,
  settlement_owner TEXT,
  settlement_reason TEXT,
  termination_confirmed_at TEXT,
  quarantine_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT
);
CREATE INDEX pipeline_attempt_actors_state_idx
  ON pipeline_attempt_actors(actor_state, last_heartbeat_at);
`;

const pipelineAttemptActorMigrationSource = `${pipelineAttemptActorSchema}
actor-contract:pipeline stage attempts own sandbox actor liveness and settlement/v1
legacy runs and run_liveness remain retained history
backfill-contract:bound or planned pipeline run maps to one attempt actor without losing heartbeat, reaping, or quarantine state`;

const sandboxEventDiagnosticsSchema = `
ALTER TABLE sandbox_events ADD COLUMN ingestion_diagnosed_at TEXT;
`;

const sandboxEventDiagnosticsMigrationSource = `${sandboxEventDiagnosticsSchema}
sandbox-event-diagnostics:repeated ingestion failures retain a one-time surfaced diagnostic/v1`;

const pipelineIdleEffectSchema = `
    CREATE TABLE pipeline_effect_intents_next (
      id TEXT PRIMARY KEY,
      pipeline_instance_id TEXT NOT NULL,
      transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
      kind TEXT NOT NULL CHECK(kind IN (
        'provision', 'bootstrap', 'dispatch_stage', 'idle', 'stop', 'quarantine', 'cleanup',
        'publish_linear', 'publish_github', 'publish_pr'
      )),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      last_error TEXT,
      FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
      UNIQUE(pipeline_instance_id, transition_version, kind, idempotency_key)
    );
    INSERT INTO pipeline_effect_intents_next (
      id, pipeline_instance_id, transition_version, kind, idempotency_key,
      payload, payload_hash, status, attempts, next_attempt_at, created_at,
      acknowledged_at, last_error
    )
    SELECT
      id, pipeline_instance_id, transition_version, kind, idempotency_key,
      payload, payload_hash, status, attempts, next_attempt_at, created_at,
      acknowledged_at, last_error
    FROM pipeline_effect_intents;
    DROP TABLE pipeline_effect_intents;
    ALTER TABLE pipeline_effect_intents_next RENAME TO pipeline_effect_intents;
    CREATE INDEX pipeline_effects_pending_idx ON pipeline_effect_intents(status, next_attempt_at);
`;

const pipelineIdleEffectMigrationSource = `${pipelineIdleEffectSchema}
effect-kind-contract:provider wait can idle an active sandbox without changing coordinator authority/v1`;

function widenPipelineEffectIntentsForIdle(db: Database.Database): void {
  if (!hasTable(db, "pipeline_effect_intents")) return;
  db.exec(pipelineIdleEffectSchema);
}

const feedbackObservedHeadSchema = `
ALTER TABLE feedback_snapshots ADD COLUMN observed_head_sha TEXT;
UPDATE feedback_snapshots SET observed_head_sha = head_sha WHERE observed_head_sha IS NULL;
`;

const feedbackObservedHeadMigrationSource = `${feedbackObservedHeadSchema}
observed-head-provenance:carried feedback keeps the head each provider event was observed against, distinct from the drainable head, for the exact-subject audit seal/v1`;

function addFeedbackObservedHeadProvenance(db: Database.Database): void {
  if (!hasTable(db, "feedback_snapshots")) return;
  if (hasColumns(db, "feedback_snapshots", ["observed_head_sha"])) return;
  db.exec(feedbackObservedHeadSchema);
}

const selectionPublicationBackfillSource = `
backfill-contract:active pipeline instances carry selection ledger and github summary publications/v1
seed missing linear_ledger and github_summary selection receipts once, using the normal publication writer identity and payload rules`;

function backfillSelectionPublications(db: Database.Database): void {
  if (
    !hasTable(db, "pipeline_instances") ||
    !hasTable(db, "pipeline_publication_receipts") ||
    !hasTable(db, "control_outbox")
  ) return;
  const timestamp = new Date().toISOString();
  const instances = db.prepare(`
    SELECT * FROM pipeline_instances pi
    WHERE pi.status NOT IN (
      'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed',
      'publication_blocked'
    )
      AND json_valid(pi.normalized_manifest)
      AND json_type(pi.normalized_manifest, '$.stages') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_publication_receipts ppr
        WHERE ppr.pipeline_instance_id = pi.id AND ppr.kind = 'control_ledger'
      )
  `).all() as PipelineInstance[];
  for (const instance of instances) {
    persistSelectionPublications({ db, instance, timestamp });
  }
}

const satelliteTableContractionSchema = `
ALTER TABLE agent_sessions ADD COLUMN execution_mode TEXT CHECK(execution_mode IS NULL OR execution_mode IN ('legacy', 'pipeline'));
ALTER TABLE agent_sessions ADD COLUMN pipeline_instance_id TEXT;
CREATE UNIQUE INDEX agent_sessions_pipeline_instance_unique
  ON agent_sessions(pipeline_instance_id) WHERE pipeline_instance_id IS NOT NULL;
ALTER TABLE pipeline_instances ADD COLUMN runtime_provider TEXT;
ALTER TABLE pipeline_instances ADD COLUMN runtime_provider_resource_id TEXT;
ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_status TEXT
  CHECK(runtime_resource_status IS NULL OR runtime_resource_status IN ('active', 'stopped', 'quarantined', 'cleaned'));
ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_created_at TEXT;
ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_updated_at TEXT;
CREATE UNIQUE INDEX pipeline_instances_runtime_resource_unique
  ON pipeline_instances(runtime_provider_resource_id) WHERE runtime_provider_resource_id IS NOT NULL;
ALTER TABLE runs ADD COLUMN actor_state TEXT
  CHECK(actor_state IS NULL OR actor_state IN ('running', 'reaping', 'quarantined', 'settled'));
ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN settlement_owner TEXT;
ALTER TABLE runs ADD COLUMN settlement_reason TEXT;
ALTER TABLE runs ADD COLUMN termination_confirmed_at TEXT;
ALTER TABLE runs ADD COLUMN quarantine_reason TEXT;
ALTER TABLE runs ADD COLUMN actor_created_at TEXT;
ALTER TABLE runs ADD COLUMN actor_updated_at TEXT;
CREATE INDEX runs_actor_state_idx ON runs(actor_state, last_heartbeat_at);
ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_state TEXT
  CHECK(actor_state IS NULL OR actor_state IN ('running', 'reaping', 'quarantined', 'settled'));
ALTER TABLE pipeline_stage_attempts ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN settlement_owner TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN settlement_reason TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN termination_confirmed_at TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN quarantine_reason TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_created_at TEXT;
ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_updated_at TEXT;
CREATE INDEX pipeline_stage_attempts_actor_state_idx
  ON pipeline_stage_attempts(actor_state, last_heartbeat_at);
`;

const satelliteTableContractionSource = `${satelliteTableContractionSchema}
contraction-contract:session execution identity lives on agent_sessions/v1
contraction-contract:runtime resource identity lives on pipeline_instances/v1
contraction-contract:run actor liveness lives on runs and pipeline_stage_attempts/v1
historical session_executions and pipeline_runtime_resources tables remain retained history`;

const orchestrationJournalSchema = `
CREATE TABLE orchestration_journal (
  id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  team TEXT NOT NULL,
  repository TEXT NOT NULL,
  issue TEXT NOT NULL,
  instance_id TEXT,
  run_id TEXT,
  actor TEXT NOT NULL CHECK(actor IN ('supervisor', 'stage_agent', 'orchestrator', 'human')),
  kind TEXT NOT NULL CHECK(kind IN (
    'delegated', 'published', 'merged', 'relayed_finding', 'dispatched_fix',
    'detected_stall', 'capacity_refused', 'escalated_human',
    'terminal_observed', 'run_note'
  )),
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT,
  refs TEXT NOT NULL,
  note TEXT,
  structured TEXT,
  CHECK(json_valid(refs)),
  CHECK(structured IS NULL OR json_valid(structured)),
  CHECK(note IS NULL OR length(note) <= 8000)
);
CREATE INDEX orchestration_journal_issue_recorded_idx
  ON orchestration_journal(issue, recorded_at);
CREATE INDEX orchestration_journal_repository_recorded_idx
  ON orchestration_journal(repository, recorded_at);
CREATE INDEX orchestration_journal_issue_lower_recorded_idx
  ON orchestration_journal(lower(issue), recorded_at);
CREATE INDEX orchestration_journal_repository_lower_recorded_idx
  ON orchestration_journal(lower(repository), recorded_at);
`;

const orchestrationJournalMigrationSource = `${orchestrationJournalSchema}
journal-contract:append-only cross-run orchestration decisions and stage-agent notes keyed by team, repository, and issue/v1
actor-contract:supervisor deterministic events are objective facts; stage_agent run_notes are sanitized evidence only
read-contract:query by issue or repository over recorded_at without feeding coordinator control flow/v1
read-index-contract:case-insensitive read filters use lower-expression indexes while preserving pinned plain indexes/v1`;

const pipelineArtifactsExecutionGraphResultSchema = `
CREATE TABLE pipeline_artifacts_next (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'stage_result', 'execution_graph_result', 'review', 'command_result',
    'provider_check', 'human_approval', 'publish_subject'
  )),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  assurance TEXT NOT NULL CHECK(assurance IN (
    'semantic_attested', 'semantic_corroborated', 'executor_verified',
    'provider_verified', 'human_approved'
  )),
  subject TEXT,
  payload TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);
INSERT INTO pipeline_artifacts_next (
  id, pipeline_instance_id, attempt_id, kind, schema_version,
  assurance, subject, payload, artifact_hash, created_at
)
SELECT
  id, pipeline_instance_id, attempt_id, kind, schema_version,
  assurance, subject, payload, artifact_hash, created_at
FROM pipeline_artifacts;
DROP TABLE pipeline_artifacts;
ALTER TABLE pipeline_artifacts_next RENAME TO pipeline_artifacts;
`;

const executionUnitSchema = `
CREATE TABLE execution_graphs (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL UNIQUE,
  parent_stage_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  integration_subject TEXT,
  aggregate_artifact_hash TEXT,
  aggregate_emitted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT
);
CREATE INDEX execution_graphs_instance_idx ON execution_graphs(pipeline_instance_id, created_at);

CREATE TABLE execution_units (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  authored_order INTEGER NOT NULL CHECK(authored_order >= 0),
  dependency_unit_ids TEXT NOT NULL CHECK(json_valid(dependency_unit_ids)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'integrated', 'completed', 'exited', 'failed')),
  active_work_attempt_id TEXT,
  accepted_candidate_subject TEXT,
  integration_subject TEXT,
  terminal_level TEXT CHECK(terminal_level IS NULL OR terminal_level IN ('completed', 'exited', 'failed')),
  alarm INTEGER NOT NULL DEFAULT 0 CHECK(alarm IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id) REFERENCES execution_graphs(id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, unit_id),
  UNIQUE(active_work_attempt_id)
);
CREATE UNIQUE INDEX execution_units_one_running_idx
  ON execution_units(parent_attempt_id) WHERE status = 'running';
CREATE INDEX execution_units_ready_idx
  ON execution_units(parent_attempt_id, status, authored_order, unit_id);

CREATE TABLE execution_work_attempts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  action_kind TEXT NOT NULL CHECK(action_kind IN (
    'implement', 'simplify', 'command', 'candidate', 'integrate', 'aggregate', 'stop', 'cleanup'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT,
  result_hash TEXT,
  native_session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'dispatched', 'running', 'completed', 'failed', 'dead')),
  lease_owner TEXT,
  lease_until TEXT,
  output_subject TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT,
  FOREIGN KEY(execution_graph_id) REFERENCES execution_graphs(id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_unit_id) REFERENCES execution_units(id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  UNIQUE(execution_unit_id, attempt_ordinal, action_kind)
);
CREATE UNIQUE INDEX execution_work_one_active_idx
  ON execution_work_attempts(parent_attempt_id)
  WHERE status IN ('leased', 'dispatched', 'running');
CREATE INDEX execution_work_claim_idx
  ON execution_work_attempts(parent_attempt_id, status, lease_until, created_at);
`;

const executionUnitMigrationSource = `${executionUnitSchema}
${pipelineArtifactsExecutionGraphResultSchema}
unit-reducer-contract:serial child state is owned by execution graph and unit records/v1
binding-contract:parent attempt and run fences live on execution_units and execution_work_attempts/v1
lease-contract:one active child action per parent attempt is enforced transactionally/v1
aggregate-contract:one execution_graph_result hash settles the parent composite stage once/v1`;

const executionGraphStopFenceSchema = `
ALTER TABLE execution_graphs ADD COLUMN stopped_at TEXT;
ALTER TABLE execution_graphs ADD COLUMN stop_reason TEXT;
`;

const executionChildGateSchema = `
CREATE TABLE IF NOT EXISTS execution_gate_receipts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT NOT NULL,
  execution_work_attempt_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  gate_kind TEXT NOT NULL CHECK(gate_kind IN (
    'unit_completion', 'unit_command', 'unit_acceptance', 'final_semantic'
  )),
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN ('semantic', 'command', 'human', 'publish_subject')),
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'not_configured')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'success', 'no_change', 'semantic_repair_required', 'retryable_infrastructure_failure',
    'needs_human', 'canceled', 'superseded', 'failure'
  )),
  reason TEXT NOT NULL,
  artifact_hashes TEXT NOT NULL CHECK(json_valid(artifact_hashes)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id) REFERENCES execution_graphs(id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_unit_id) REFERENCES execution_units(id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_work_attempt_id) REFERENCES execution_work_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  UNIQUE(execution_work_attempt_id, gate_kind)
);
CREATE INDEX IF NOT EXISTS execution_gate_receipts_parent_idx
  ON execution_gate_receipts(parent_attempt_id, unit_id, created_at);

CREATE TABLE IF NOT EXISTS execution_downstream_context (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  from_execution_unit_id TEXT NOT NULL,
  to_execution_unit_id TEXT NOT NULL,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id) REFERENCES execution_graphs(id) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id) REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY(from_execution_unit_id) REFERENCES execution_units(id) ON DELETE RESTRICT,
  FOREIGN KEY(to_execution_unit_id) REFERENCES execution_units(id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, from_unit_id, to_unit_id, payload_hash)
);
CREATE INDEX IF NOT EXISTS execution_downstream_context_target_idx
  ON execution_downstream_context(parent_attempt_id, to_unit_id, created_at);
`;

const executionChildGateMigrationSource = `${executionGraphStopFenceSchema}
${executionChildGateSchema}
child-gate-contract:deterministic gate receipts and downstream context live on child execution records/v1
stop-contract:stopped child graphs remain durable and are not eligible for redispatch/v1`;

const executionCompositeIdentitySchema = `
ALTER TABLE execution_gate_receipts RENAME TO execution_gate_receipts_old;
ALTER TABLE execution_downstream_context RENAME TO execution_downstream_context_old;
ALTER TABLE execution_work_attempts RENAME TO execution_work_attempts_old;
ALTER TABLE execution_units RENAME TO execution_units_old;
ALTER TABLE execution_graphs RENAME TO execution_graphs_old;

DROP INDEX IF EXISTS execution_graphs_instance_idx;
DROP INDEX IF EXISTS execution_units_one_running_idx;
DROP INDEX IF EXISTS execution_units_ready_idx;
DROP INDEX IF EXISTS execution_units_graph_status_idx;
DROP INDEX IF EXISTS execution_work_one_active_idx;
DROP INDEX IF EXISTS execution_work_claim_idx;
DROP INDEX IF EXISTS execution_gate_receipts_parent_idx;
DROP INDEX IF EXISTS execution_downstream_context_target_idx;
DROP TRIGGER IF EXISTS execution_graphs_parent_attempt_run_insert_fence;
DROP TRIGGER IF EXISTS execution_graphs_parent_attempt_run_update_fence;

CREATE TABLE execution_graphs (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL UNIQUE,
  parent_stage_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  integration_subject TEXT,
  aggregate_artifact_hash TEXT,
  aggregate_emitted_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT,
  UNIQUE(id, pipeline_instance_id, parent_attempt_id),
  UNIQUE(id, pipeline_instance_id, parent_attempt_id, parent_run_id)
);
CREATE INDEX execution_graphs_instance_idx
  ON execution_graphs(pipeline_instance_id, updated_at DESC, created_at DESC, id DESC);
CREATE TRIGGER execution_graphs_parent_attempt_run_insert_fence
BEFORE INSERT ON execution_graphs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pipeline_stage_attempts
  WHERE id = NEW.parent_attempt_id
    AND pipeline_instance_id = NEW.pipeline_instance_id
    AND planned_run_id = NEW.parent_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution graph parent attempt run fence mismatch');
END;
CREATE TRIGGER execution_graphs_parent_attempt_run_update_fence
BEFORE UPDATE OF pipeline_instance_id, parent_attempt_id, parent_run_id ON execution_graphs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pipeline_stage_attempts
  WHERE id = NEW.parent_attempt_id
    AND pipeline_instance_id = NEW.pipeline_instance_id
    AND planned_run_id = NEW.parent_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution graph parent attempt run fence mismatch');
END;

CREATE TABLE execution_units (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  authored_order INTEGER NOT NULL CHECK(authored_order >= 0),
  dependency_unit_ids TEXT NOT NULL CHECK(json_valid(dependency_unit_ids)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'integrated', 'completed', 'exited', 'failed')),
  active_work_attempt_id TEXT,
  accepted_candidate_subject TEXT,
  integration_subject TEXT,
  terminal_level TEXT CHECK(terminal_level IS NULL OR terminal_level IN ('completed', 'exited', 'failed')),
  alarm INTEGER NOT NULL DEFAULT 0 CHECK(alarm IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(active_work_attempt_id, execution_graph_id, id, pipeline_instance_id, parent_attempt_id, unit_id)
    REFERENCES execution_work_attempts(id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id, unit_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(parent_attempt_id, unit_id),
  UNIQUE(active_work_attempt_id),
  UNIQUE(id, execution_graph_id, pipeline_instance_id, parent_attempt_id),
  UNIQUE(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id)
);
CREATE UNIQUE INDEX execution_units_one_running_idx
  ON execution_units(parent_attempt_id) WHERE status = 'running';
CREATE INDEX execution_units_ready_idx
  ON execution_units(parent_attempt_id, status, authored_order, unit_id);
CREATE INDEX execution_units_graph_status_idx
  ON execution_units(execution_graph_id, authored_order, unit_id);

CREATE TABLE execution_work_attempts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  action_kind TEXT NOT NULL CHECK(action_kind IN (
    'implement', 'simplify', 'command', 'candidate', 'integrate', 'aggregate', 'stop', 'cleanup'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT,
  result_hash TEXT,
  native_session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'dispatched', 'running', 'completed', 'failed', 'dead')),
  lease_owner TEXT,
  lease_until TEXT,
  output_subject TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id, parent_run_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id, parent_run_id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_unit_id, attempt_ordinal, action_kind),
  UNIQUE(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id),
  UNIQUE(id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id, unit_id)
);
CREATE UNIQUE INDEX execution_work_one_active_idx
  ON execution_work_attempts(parent_attempt_id)
  WHERE status IN ('leased', 'dispatched', 'running');
CREATE INDEX execution_work_claim_idx
  ON execution_work_attempts(parent_attempt_id, status, lease_until, created_at);

CREATE TABLE execution_gate_receipts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT NOT NULL,
  execution_work_attempt_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  gate_kind TEXT NOT NULL CHECK(gate_kind IN (
    'unit_completion', 'unit_command', 'unit_acceptance', 'final_semantic'
  )),
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN ('semantic', 'command', 'human', 'publish_subject')),
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'not_configured')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'success', 'no_change', 'semantic_repair_required', 'retryable_infrastructure_failure',
    'needs_human', 'canceled', 'superseded', 'failure'
  )),
  reason TEXT NOT NULL,
  artifact_hashes TEXT NOT NULL CHECK(json_valid(artifact_hashes)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, execution_unit_id, execution_work_attempt_id, parent_attempt_id, unit_id)
    REFERENCES execution_work_attempts(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_work_attempt_id, gate_kind)
);
CREATE INDEX execution_gate_receipts_parent_idx
  ON execution_gate_receipts(parent_attempt_id, unit_id, created_at);

CREATE TABLE execution_downstream_context (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  from_execution_unit_id TEXT NOT NULL,
  to_execution_unit_id TEXT NOT NULL,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(from_execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, from_unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  FOREIGN KEY(to_execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, to_unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, from_unit_id, to_unit_id, payload_hash)
);
CREATE INDEX execution_downstream_context_target_idx
  ON execution_downstream_context(parent_attempt_id, to_unit_id, created_at);

INSERT INTO execution_graphs
SELECT
  id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
  graph_digest, plan_digest, integration_subject, aggregate_artifact_hash,
  aggregate_emitted_at, stopped_at, stop_reason, created_at, updated_at
FROM execution_graphs_old;

INSERT INTO execution_units
SELECT
  id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
  authored_order, dependency_unit_ids, status, NULL,
  accepted_candidate_subject, integration_subject, terminal_level, alarm,
  created_at, updated_at
FROM execution_units_old;

INSERT INTO execution_work_attempts
SELECT
  id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
  parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
  request_hash, result_hash, native_session_id, status, lease_owner, lease_until,
  output_subject, payload, created_at, updated_at, completed_at, last_error
FROM execution_work_attempts_old;

UPDATE execution_units
SET active_work_attempt_id = (
  SELECT old.active_work_attempt_id
  FROM execution_units_old old
  WHERE old.id = execution_units.id
)
WHERE EXISTS (
  SELECT 1
  FROM execution_units_old old
  WHERE old.id = execution_units.id
    AND old.active_work_attempt_id IS NOT NULL
);

INSERT INTO execution_gate_receipts
SELECT
  id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
  parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
  outcome, reason, artifact_hashes, payload, receipt_hash, created_at
FROM execution_gate_receipts_old;

INSERT INTO execution_downstream_context
SELECT
  id, execution_graph_id, pipeline_instance_id, parent_attempt_id,
  from_execution_unit_id, to_execution_unit_id, from_unit_id, to_unit_id,
  payload, payload_hash, created_at
FROM execution_downstream_context_old;

DROP TABLE execution_gate_receipts_old;
DROP TABLE execution_downstream_context_old;
DROP TABLE execution_work_attempts_old;
DROP TABLE execution_units_old;
DROP TABLE execution_graphs_old;
`;

const executionCompositeIdentityMigrationSource = `${executionCompositeIdentitySchema}
identity-contract:graph unit and work attempts carry composite parent instance attempt run and unit fences/v1
status-contract:structured status lookup uses execution_graph_id leading unit index/v1`;

const executionUnitPhaseMachineSchema = `
ALTER TABLE execution_downstream_context RENAME TO execution_downstream_context_old3;
ALTER TABLE execution_gate_receipts RENAME TO execution_gate_receipts_old3;
ALTER TABLE execution_work_attempts RENAME TO execution_work_attempts_old3;
ALTER TABLE execution_units RENAME TO execution_units_old3;
ALTER TABLE execution_graphs RENAME TO execution_graphs_old3;

DROP INDEX IF EXISTS execution_graphs_instance_idx;
DROP INDEX IF EXISTS execution_units_one_running_idx;
DROP INDEX IF EXISTS execution_units_ready_idx;
DROP INDEX IF EXISTS execution_units_graph_status_idx;
DROP INDEX IF EXISTS execution_work_one_active_idx;
DROP INDEX IF EXISTS execution_work_claim_idx;
DROP INDEX IF EXISTS execution_gate_receipts_parent_idx;
DROP INDEX IF EXISTS execution_downstream_context_target_idx;
DROP TRIGGER IF EXISTS execution_graphs_parent_attempt_run_insert_fence;
DROP TRIGGER IF EXISTS execution_graphs_parent_attempt_run_update_fence;

CREATE TABLE execution_graphs (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL UNIQUE,
  parent_stage_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  command_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(command_names)),
  max_repair_rounds INTEGER NOT NULL DEFAULT 3 CHECK(max_repair_rounds >= 0),
  final_phase TEXT CHECK(final_phase IS NULL OR final_phase IN ('command', 'review', 'repair', 'done')),
  final_command_index INTEGER NOT NULL DEFAULT 0 CHECK(final_command_index >= 0),
  final_cycle INTEGER NOT NULL DEFAULT 1 CHECK(final_cycle >= 1),
  final_repair_rounds INTEGER NOT NULL DEFAULT 0 CHECK(final_repair_rounds >= 0),
  final_review_passed_at TEXT,
  integration_subject TEXT,
  aggregate_artifact_hash TEXT,
  aggregate_emitted_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT,
  UNIQUE(id, pipeline_instance_id, parent_attempt_id),
  UNIQUE(id, pipeline_instance_id, parent_attempt_id, parent_run_id)
);
CREATE INDEX execution_graphs_instance_idx
  ON execution_graphs(pipeline_instance_id, updated_at DESC, created_at DESC, id DESC);
CREATE TRIGGER execution_graphs_parent_attempt_run_insert_fence
BEFORE INSERT ON execution_graphs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pipeline_stage_attempts
  WHERE id = NEW.parent_attempt_id
    AND pipeline_instance_id = NEW.pipeline_instance_id
    AND planned_run_id = NEW.parent_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution graph parent attempt run fence mismatch');
END;
CREATE TRIGGER execution_graphs_parent_attempt_run_update_fence
BEFORE UPDATE OF pipeline_instance_id, parent_attempt_id, parent_run_id ON execution_graphs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pipeline_stage_attempts
  WHERE id = NEW.parent_attempt_id
    AND pipeline_instance_id = NEW.pipeline_instance_id
    AND planned_run_id = NEW.parent_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'execution graph parent attempt run fence mismatch');
END;

CREATE TABLE execution_units (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  authored_order INTEGER NOT NULL CHECK(authored_order >= 0),
  dependency_unit_ids TEXT NOT NULL CHECK(json_valid(dependency_unit_ids)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'integrated', 'completed', 'exited', 'failed')),
  phase TEXT NOT NULL DEFAULT 'implement' CHECK(phase IN ('implement', 'simplify', 'command', 'candidate', 'lead', 'integrate')),
  current_cycle INTEGER NOT NULL DEFAULT 1 CHECK(current_cycle >= 1),
  repair_rounds INTEGER NOT NULL DEFAULT 0 CHECK(repair_rounds >= 0),
  command_index INTEGER NOT NULL DEFAULT 0 CHECK(command_index >= 0),
  active_work_attempt_id TEXT,
  accepted_candidate_subject TEXT,
  integration_subject TEXT,
  terminal_level TEXT CHECK(terminal_level IS NULL OR terminal_level IN ('completed', 'exited', 'failed')),
  alarm INTEGER NOT NULL DEFAULT 0 CHECK(alarm IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(active_work_attempt_id, execution_graph_id, id, pipeline_instance_id, parent_attempt_id, unit_id)
    REFERENCES execution_work_attempts(id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id, unit_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(parent_attempt_id, unit_id),
  UNIQUE(active_work_attempt_id),
  UNIQUE(id, execution_graph_id, pipeline_instance_id, parent_attempt_id),
  UNIQUE(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id)
);
CREATE UNIQUE INDEX execution_units_one_running_idx
  ON execution_units(parent_attempt_id) WHERE status = 'running';
CREATE INDEX execution_units_ready_idx
  ON execution_units(parent_attempt_id, status, authored_order, unit_id);
CREATE INDEX execution_units_graph_status_idx
  ON execution_units(execution_graph_id, authored_order, unit_id);

CREATE TABLE execution_work_attempts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  unit_id TEXT,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  action_kind TEXT NOT NULL CHECK(action_kind IN (
    'implement', 'repair', 'simplify', 'command', 'candidate', 'lead', 'integrate',
    'final_command', 'final_review', 'final_repair', 'aggregate', 'stop', 'cleanup'
  )),
  cycle INTEGER NOT NULL DEFAULT 1 CHECK(cycle >= 1),
  command_name TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT,
  result_hash TEXT,
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
  receipt_hash TEXT,
  native_session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'dispatched', 'running', 'completed', 'failed', 'dead')),
  lease_owner TEXT,
  lease_until TEXT,
  output_subject TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id, parent_run_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id, parent_run_id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_unit_id, attempt_ordinal, action_kind),
  UNIQUE(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id),
  UNIQUE(id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id, unit_id)
);
CREATE UNIQUE INDEX execution_work_one_active_idx
  ON execution_work_attempts(parent_attempt_id)
  WHERE status IN ('leased', 'dispatched', 'running');
CREATE INDEX execution_work_claim_idx
  ON execution_work_attempts(parent_attempt_id, status, lease_until, created_at);

CREATE TABLE execution_gate_receipts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT,
  execution_work_attempt_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT,
  gate_kind TEXT NOT NULL CHECK(gate_kind IN (
    'unit_completion', 'unit_command', 'unit_acceptance', 'final_semantic', 'integration', 'final_review'
  )),
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN ('semantic', 'command', 'human', 'publish_subject')),
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'not_configured')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'success', 'no_change', 'semantic_repair_required', 'retryable_infrastructure_failure',
    'needs_human', 'canceled', 'superseded', 'failure'
  )),
  reason TEXT NOT NULL,
  artifact_hashes TEXT NOT NULL CHECK(json_valid(artifact_hashes)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, execution_unit_id, execution_work_attempt_id, parent_attempt_id, unit_id)
    REFERENCES execution_work_attempts(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_work_attempt_id, gate_kind)
);
CREATE INDEX execution_gate_receipts_parent_idx
  ON execution_gate_receipts(parent_attempt_id, unit_id, created_at);

CREATE TABLE execution_downstream_context (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  from_execution_unit_id TEXT NOT NULL,
  to_execution_unit_id TEXT NOT NULL,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(from_execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, from_unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  FOREIGN KEY(to_execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, to_unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, from_unit_id, to_unit_id, payload_hash)
);
CREATE INDEX execution_downstream_context_target_idx
  ON execution_downstream_context(parent_attempt_id, to_unit_id, created_at);

INSERT INTO execution_graphs (
  id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
  graph_digest, plan_digest, integration_subject, aggregate_artifact_hash,
  aggregate_emitted_at, stopped_at, stop_reason, created_at, updated_at
)
SELECT
  id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
  graph_digest, plan_digest, integration_subject, aggregate_artifact_hash,
  aggregate_emitted_at, stopped_at, stop_reason, created_at, updated_at
FROM execution_graphs_old3;

INSERT INTO execution_units (
  id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
  authored_order, dependency_unit_ids, status, phase, active_work_attempt_id,
  accepted_candidate_subject, integration_subject, terminal_level, alarm,
  created_at, updated_at
)
SELECT
  id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
  authored_order, dependency_unit_ids, status,
  CASE WHEN status IN ('integrated', 'completed', 'exited', 'failed') THEN 'integrate' ELSE 'implement' END,
  NULL, accepted_candidate_subject, integration_subject, terminal_level, alarm,
  created_at, updated_at
FROM execution_units_old3;

INSERT INTO execution_work_attempts (
  id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
  parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
  request_hash, result_hash, native_session_id, status, lease_owner, lease_until,
  output_subject, payload, created_at, updated_at, completed_at, last_error
)
SELECT
  id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
  parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
  request_hash, result_hash, native_session_id, status, lease_owner, lease_until,
  output_subject, payload, created_at, updated_at, completed_at, last_error
FROM execution_work_attempts_old3;

UPDATE execution_units
SET active_work_attempt_id = (
  SELECT old.active_work_attempt_id
  FROM execution_units_old3 old
  WHERE old.id = execution_units.id
)
WHERE EXISTS (
  SELECT 1
  FROM execution_units_old3 old
  WHERE old.id = execution_units.id
    AND old.active_work_attempt_id IS NOT NULL
);

INSERT INTO execution_gate_receipts (
  id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
  parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
  outcome, reason, artifact_hashes, payload, receipt_hash, created_at
)
SELECT
  id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
  parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
  outcome, reason, artifact_hashes, payload, receipt_hash, created_at
FROM execution_gate_receipts_old3;

INSERT INTO execution_downstream_context
SELECT
  id, execution_graph_id, pipeline_instance_id, parent_attempt_id,
  from_execution_unit_id, to_execution_unit_id, from_unit_id, to_unit_id,
  payload, payload_hash, created_at
FROM execution_downstream_context_old3;

DROP TABLE execution_downstream_context_old3;
DROP TABLE execution_gate_receipts_old3;
UPDATE execution_units_old3 SET active_work_attempt_id = NULL WHERE active_work_attempt_id IS NOT NULL;
DROP TABLE execution_work_attempts_old3;
DROP TABLE execution_units_old3;
DROP TABLE execution_graphs_old3;
`;

const executionUnitPhaseMachineMigrationSource = `${executionUnitPhaseMachineSchema}
phase-contract:each execution unit persists implement, simplify, command, candidate, lead, and integrate as fenced sequential phases/v1
final-phase-contract:the whole-change final command, final review, and final repair phases persist on the execution graph and gate the aggregate/v1`;

const executionGraphDeclaredUnitPhasesSchema = `
ALTER TABLE execution_graphs ADD COLUMN unit_phases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unit_phases));
`;

const executionGraphDeclaredUnitPhasesMigrationSource = `${executionGraphDeclaredUnitPhasesSchema}
unit-phase-sequence-contract:execution graphs persist their graph-declared ordered unit phase sequence independently of configured commands/v1`;

const executionGraphUnitPhaseBindingsSchema = `
ALTER TABLE execution_graphs ADD COLUMN unit_phase_bindings TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unit_phase_bindings));
`;

const executionGraphUnitPhaseBindingsMigrationSource = `${executionGraphUnitPhaseBindingsSchema}
unit-phase-binding-contract:execution graphs persist the full compiled ordered unit phase binding without rereading mutable graph data/v1`;

const executionUnitPlanCommandNamesSchema = `
ALTER TABLE execution_units ADD COLUMN command_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(command_names));
UPDATE execution_units
SET command_names = COALESCE((
  SELECT execution_graphs.command_names
  FROM execution_graphs
  WHERE execution_graphs.id = execution_units.execution_graph_id
), '[]')
WHERE command_names = '[]';
`;

const executionUnitPlanCommandNamesMigrationSource = `${executionUnitPlanCommandNamesSchema}
unit-command-contract:execution units persist their canonical execution-plan command sequence and do not substitute graph defaults/v1`;

const executionWorkPreparedRequestsSchema = `
ALTER TABLE execution_work_attempts ADD COLUMN request_payload TEXT CHECK(request_payload IS NULL OR json_valid(request_payload));
ALTER TABLE execution_work_attempts ADD COLUMN request_launch_state TEXT CHECK(
  request_launch_state IS NULL OR request_launch_state IN ('prepared', 'worktree_ready', 'launched')
);
UPDATE execution_work_attempts
SET request_launch_state = 'launched'
WHERE request_hash IS NOT NULL AND request_launch_state IS NULL;
`;

const executionWorkPreparedRequestsMigrationSource = `${executionWorkPreparedRequestsSchema}
prepared-child-request-contract:child action sealed request payloads and launch state are durable before provider launch/v1`;

const executionWorkTerminalOutcomeSchema = `
ALTER TABLE execution_work_attempts ADD COLUMN terminal_result_outcome TEXT CHECK(
  terminal_result_outcome IS NULL OR terminal_result_outcome IN (
    'failure',
    'needs_human',
    'retryable_infrastructure_failure'
  )
);
UPDATE execution_work_attempts
SET terminal_result_outcome = CASE
  WHEN status = 'dead' THEN 'retryable_infrastructure_failure'
  WHEN status = 'failed' AND last_error LIKE 'retryable_infrastructure_failure:%' THEN 'retryable_infrastructure_failure'
  WHEN status = 'failed' THEN 'failure'
  ELSE NULL
END
WHERE terminal_result_outcome IS NULL;
`;

const executionWorkTerminalOutcomeMigrationSource = `${executionWorkTerminalOutcomeSchema}
terminal-child-result-contract:child action terminal replay compares exact failure needs-human and retryable outcomes/v1`;

const executionPublicationEventsSchema = `
CREATE TABLE execution_publication_events (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('unit_repair', 'unit_settled', 'graph_stopped', 'final_review', 'aggregate', 'steering_undelivered')),
  body TEXT NOT NULL,
  linear_outbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(linear_outbox_id) REFERENCES linear_outbox(id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, sequence)
);
`;

const executionPublicationEventsMigrationSource = `${executionPublicationEventsSchema}
child-publication-event-contract:each reportable child transition durably inserts one ordered publication event and its correlated linear_outbox activity in the same transaction, so restart converges without duplication/v1`;

// The reason vocabulary is closed and grown bottom-up per incident, mirroring
// LAUNCH_FAILURE_REASONS (sandbox/runner/launch-failure.mjs): every value
// below is a literal already produced by supervisor/src/pipeline/gates.ts or
// execution-gates.ts (see GATE_RECEIPT_REASONS in gates.ts). A new reason
// requires both a code change there and a follow-up migration here.
const executionGateReceiptReasonEnumSchema = `
ALTER TABLE execution_gate_receipts RENAME TO execution_gate_receipts_old4;
DROP INDEX IF EXISTS execution_gate_receipts_parent_idx;

CREATE TABLE execution_gate_receipts (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  execution_unit_id TEXT,
  execution_work_attempt_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT,
  gate_kind TEXT NOT NULL CHECK(gate_kind IN (
    'unit_completion', 'unit_command', 'unit_acceptance', 'final_semantic', 'integration', 'final_review'
  )),
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN ('semantic', 'command', 'human', 'publish_subject')),
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'not_configured')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'success', 'no_change', 'semantic_repair_required', 'retryable_infrastructure_failure',
    'needs_human', 'canceled', 'superseded', 'failure'
  )),
  reason TEXT NOT NULL CHECK(reason IN (
    'blocking_findings', 'no_change_contradicted_by_tree_delta', 'typed_semantic_result',
    'command_not_configured', 'command_terminated', 'command_exit_zero', 'command_exit_nonzero',
    'command_receipts_missing_or_unexpected', 'required_command_not_configured', 'command_receipt_failed',
    'all_commands_current', 'candidate_evidence_failed', 'worker_completion_not_success',
    'lead_scope_match_accept', 'lead_requested_revision', 'lead_needs_human', 'lead_context_update',
    'executor_integrated_candidate', 'integration_evidence_failed'
  )),
  artifact_hashes TEXT NOT NULL CHECK(json_valid(artifact_hashes)),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, execution_unit_id, execution_work_attempt_id, parent_attempt_id, unit_id)
    REFERENCES execution_work_attempts(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_work_attempt_id, gate_kind)
);
CREATE INDEX execution_gate_receipts_parent_idx
  ON execution_gate_receipts(parent_attempt_id, unit_id, created_at);

INSERT INTO execution_gate_receipts (
  id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
  parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
  outcome, reason, artifact_hashes, payload, receipt_hash, created_at
)
SELECT
  id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
  parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
  outcome, reason, artifact_hashes, payload, receipt_hash, created_at
FROM execution_gate_receipts_old4;

DROP TABLE execution_gate_receipts_old4;
`;

const executionGateReceiptReasonEnumMigrationSource = `${executionGateReceiptReasonEnumSchema}
reason-vocabulary-contract:execution_gate_receipts.reason is a closed enum grown bottom-up per incident, mirroring LAUNCH_FAILURE_REASONS/v1`;

// escalated_human was declared in the v15 orchestration_journal.kind enum but
// never had a producer: the decision corpus (including needs_human/escalation
// outcomes) lives in the receipt/gate tables -- execution_gate_receipts above
// already has composite join keys and CHECK-enforced enums for exactly this --
// so orchestration_journal must not grow a parallel, duplicate decision kind.
const orchestrationJournalCloseEscalatedHumanSchema = `
ALTER TABLE orchestration_journal RENAME TO orchestration_journal_old;
DROP INDEX IF EXISTS orchestration_journal_issue_recorded_idx;
DROP INDEX IF EXISTS orchestration_journal_repository_recorded_idx;
DROP INDEX IF EXISTS orchestration_journal_issue_lower_recorded_idx;
DROP INDEX IF EXISTS orchestration_journal_repository_lower_recorded_idx;

CREATE TABLE orchestration_journal (
  id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  team TEXT NOT NULL,
  repository TEXT NOT NULL,
  issue TEXT NOT NULL,
  instance_id TEXT,
  run_id TEXT,
  actor TEXT NOT NULL CHECK(actor IN ('supervisor', 'stage_agent', 'orchestrator', 'human')),
  kind TEXT NOT NULL CHECK(kind IN (
    'delegated', 'published', 'merged', 'relayed_finding', 'dispatched_fix',
    'detected_stall', 'capacity_refused',
    'terminal_observed', 'run_note'
  )),
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT,
  refs TEXT NOT NULL,
  note TEXT,
  structured TEXT,
  CHECK(json_valid(refs)),
  CHECK(structured IS NULL OR json_valid(structured)),
  CHECK(note IS NULL OR length(note) <= 8000)
);
CREATE INDEX orchestration_journal_issue_recorded_idx
  ON orchestration_journal(issue, recorded_at);
CREATE INDEX orchestration_journal_repository_recorded_idx
  ON orchestration_journal(repository, recorded_at);
CREATE INDEX orchestration_journal_issue_lower_recorded_idx
  ON orchestration_journal(lower(issue), recorded_at);
CREATE INDEX orchestration_journal_repository_lower_recorded_idx
  ON orchestration_journal(lower(repository), recorded_at);

INSERT INTO orchestration_journal
SELECT id, recorded_at, team, repository, issue, instance_id, run_id, actor, kind,
  trigger, action, outcome, refs, note, structured
FROM orchestration_journal_old;

DROP TABLE orchestration_journal_old;
`;

const orchestrationJournalCloseEscalatedHumanMigrationSource = `${orchestrationJournalCloseEscalatedHumanSchema}
journal-kind-contract:orchestration_journal.kind never carries a declared value with zero producers; the decision corpus stays in the receipt/gate tables/v1`;

// Additive: existing rows stay NULL (pre-attribution era). Stamped at every
// site that writes runs.settlement_reason (run-store.ts finishRunTransaction,
// claimRunForReapingTransaction) so a run's fault domain -- executor, agent,
// provider, or the first-class unknown -- travels with its terminal outcome
// instead of being inferred from prose after the fact.
const runFaultAttributionSchema = `
ALTER TABLE runs ADD COLUMN fault_attribution TEXT CHECK(
  fault_attribution IS NULL OR fault_attribution IN ('executor', 'agent', 'provider', 'unknown')
);
`;

const runFaultAttributionMigrationSource = `${runFaultAttributionSchema}
fault-attribution-contract:runs.fault_attribution is stamped at settlement alongside settlement_reason, closed to executor/agent/provider/unknown, NULL only for pre-attribution rows/v1`;

// One deterministic row per pipeline instance, written exactly once at the
// terminal transition -- either persistence/pipeline/transition-store.ts
// applyTransition's normal settlement, or persistence/pipeline/
// instance-store.ts supersedeOtherInstances' fencing of a superseded
// generation (both write pipeline_instances.terminal_outcome). Supervisor-
// derived facts only -- no agent-authored free text -- so this is safe to
// retain far longer than operational tables and to read for skill-tuning
// measurement.
const runOutcomesSchema = `
CREATE TABLE run_outcomes (
  pipeline_instance_id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  execution_graph_id TEXT,
  plan_digest TEXT,
  base_commit TEXT NOT NULL,
  engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex', 'opencode')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed'
  )),
  closed_reason TEXT NOT NULL CHECK(closed_reason IN (
    'success', 'no_change', 'semantic_repair_required', 'retryable_infrastructure_failure',
    'needs_human', 'canceled', 'superseded', 'failure'
  )),
  fault_attribution TEXT CHECK(
    fault_attribution IS NULL OR fault_attribution IN ('executor', 'agent', 'provider', 'unknown')
  ),
  -- Currently always equal to generation: generation numbers are minted as
  -- a strictly monotonic per-ticket delegation-cycle counter (one new
  -- session/generation = one new pipeline_instances row = one run_outcomes
  -- row), so "generations consumed as of this settlement" and "this row's
  -- generation ordinal" are the same fact by construction. Kept as a distinct
  -- column because the source ticket names both explicitly; revisit if a
  -- within-run retry/reentry consumption metric is ever wanted here instead.
  generations_consumed INTEGER NOT NULL CHECK(generations_consumed >= 1),
  repair_rounds_by_unit TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(repair_rounds_by_unit)),
  phase_durations_ms TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(phase_durations_ms)),
  -- No production path stamps a token cost yet; NULL means unmeasured,
  -- never a fabricated 0.
  token_cost_usd REAL CHECK(token_cost_usd IS NULL OR token_cost_usd >= 0),
  skill_digests TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skill_digests)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id) ON DELETE RESTRICT
);
CREATE INDEX run_outcomes_issue_idx ON run_outcomes(linear_issue_id, created_at DESC);
CREATE INDEX run_outcomes_created_idx ON run_outcomes(created_at);
`;

// execution_work_attempts has no index with pipeline_instance_id as a leading
// column (its only pipeline_instance_id-bearing constraint buries it as the
// 4th column of a composite UNIQUE), so recordSettlement's per-instance
// receipt scan (persistence/pipeline/run-outcome-store.ts) would otherwise do
// a full table scan of every work attempt ever recorded, system-wide, on
// every single pipeline terminal transition.
const runOutcomesReceiptIndexSchema = `
CREATE INDEX execution_work_attempts_pipeline_instance_idx
  ON execution_work_attempts(pipeline_instance_id);
`;

const runOutcomesMigrationSource = `${runOutcomesSchema}${runOutcomesReceiptIndexSchema}
run-outcomes-contract:run_outcomes is written exactly once per pipeline instance terminal transition, supervisor-derived facts only, closed_reason/outcome/fault_attribution reuse the existing StageOutcome/PipelineOutcome/FaultAttribution vocabularies/v1`;

const citationGateReceiptSchema = `
CREATE TABLE citation_gate_receipts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL UNIQUE,
  gate_result TEXT NOT NULL CHECK(gate_result IN ('passed', 'failed')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
  reason TEXT NOT NULL CHECK(reason IN (
    'all_citations_reproduced', 'partial_claim_survival', 'no_claims_survived',
    'stale_evidence'
  )),
  grade_hash TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  receipt_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX citation_gate_receipts_created_idx
  ON citation_gate_receipts(created_at, proposal_id);
`;

const citationGateReceiptMigrationSource = `${citationGateReceiptSchema}
citation-gate-contract:proposal citation gates persist canonical provider-neutral decisions and reject conflicting replay/v1
analysis-boundary-contract:resolved analysis rows are gate inputs supplied by the caller, never imported by scheduler transition or effect code/v1`;

const reviewSubactionDispatchSchema = `
CREATE TABLE execution_review_subaction_dispatches (
  parent_action_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
  ),
  idempotency_key TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  dispatched_at TEXT,
  dispatch_time_source TEXT CHECK(dispatch_time_source IN ('acknowledged', 'prepared_fallback')),
  CHECK(
    (dispatched_at IS NULL AND dispatch_time_source IS NULL) OR
    (dispatched_at IS NOT NULL AND dispatch_time_source IS NOT NULL)
  ),
  PRIMARY KEY(parent_action_id, action_id),
  UNIQUE(action_id),
  UNIQUE(parent_action_id, idempotency_key),
  FOREIGN KEY(parent_action_id) REFERENCES execution_work_attempts(id) ON DELETE CASCADE
);
`;

const reviewSubactionDispatchMigrationSource = `${reviewSubactionDispatchSchema}
structured-review-dispatch-contract:selector fanout and validator subactions persist exact request dispatch intent plus acknowledged or conservative-fallback launch timing under their parent final-review action so crash replay remains heartbeat-mapped without rematerializing credentials or repeating launched provider work/v4`;

const controlProviderRegistrationSchema = `
CREATE TABLE repository_registrations_control_v33 (
  github_repo TEXT PRIMARY KEY COLLATE NOCASE,
  control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github')),
  linear_team_key TEXT COLLATE NOCASE,
  linear_team_id TEXT,
  base_branch TEXT NOT NULL,
  webhook_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(control_provider <> 'linear' OR linear_team_key IS NOT NULL)
);
INSERT INTO repository_registrations_control_v33 (
  github_repo, control_provider, linear_team_key, linear_team_id,
  base_branch, webhook_id, snapshot, created_at, updated_at
)
SELECT
  github_repo, 'linear', linear_team_key, linear_team_id,
  base_branch, webhook_id, snapshot, created_at, updated_at
FROM (
  SELECT repository_registrations.*,
    ROW_NUMBER() OVER (
      PARTITION BY lower(github_repo)
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    ) AS repository_rank
  FROM repository_registrations
)
WHERE repository_rank = 1;
DROP TABLE repository_registrations;
ALTER TABLE repository_registrations_control_v33 RENAME TO repository_registrations;
CREATE UNIQUE INDEX repository_registrations_linear_team_key_idx
  ON repository_registrations(linear_team_key)
  WHERE control_provider = 'linear' AND linear_team_key IS NOT NULL;
CREATE UNIQUE INDEX repository_registrations_linear_team_id_idx
  ON repository_registrations(linear_team_id)
  WHERE control_provider = 'linear' AND linear_team_id IS NOT NULL;
`;

const controlProviderRegistrationMigrationSource = `${controlProviderRegistrationSchema}
registration authority is keyed by canonical github_repo with immutable control_provider/v1
backfill-provider:existing route rows are linear/v1`;

const controlPublicationVocabularySchema = `
PRAGMA foreign_keys = OFF;
CREATE TABLE pipeline_publication_receipts_control_v34 (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('control_ledger', 'github_summary', 'pull_request')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
  external_id TEXT,
  external_url TEXT,
  target_url TEXT,
  attachment_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  resume_status TEXT,
  blocked_from_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);
INSERT INTO pipeline_publication_receipts_control_v34 (
  id, pipeline_instance_id, attempt_id, kind, idempotency_key,
  payload, payload_hash, status, external_id, external_url, target_url,
  attachment_url, attempts, next_attempt_at, resume_status, blocked_from_status,
  created_at, updated_at, acknowledged_at, last_error
)
SELECT
  id, pipeline_instance_id, attempt_id,
  CASE kind WHEN 'linear_ledger' THEN 'control_ledger' ELSE kind END,
  idempotency_key, payload, payload_hash, status, external_id, external_url, target_url,
  attachment_url, attempts, next_attempt_at, resume_status, blocked_from_status,
  created_at, updated_at, acknowledged_at, last_error
FROM pipeline_publication_receipts;
DROP TABLE pipeline_publication_receipts;
ALTER TABLE pipeline_publication_receipts_control_v34 RENAME TO pipeline_publication_receipts;
CREATE INDEX pipeline_publications_process_idx
  ON pipeline_publication_receipts(kind, status, next_attempt_at);

CREATE TABLE pipeline_effect_intents_control_v34 (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
  kind TEXT NOT NULL CHECK(kind IN (
    'provision', 'bootstrap', 'dispatch_stage', 'idle', 'stop', 'quarantine', 'cleanup',
    'publish_control', 'publish_github', 'publish_pr'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  last_error TEXT,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  UNIQUE(pipeline_instance_id, transition_version, kind, idempotency_key)
);
INSERT INTO pipeline_effect_intents_control_v34 (
  id, pipeline_instance_id, transition_version, kind, idempotency_key,
  payload, payload_hash, status, attempts, next_attempt_at, created_at,
  acknowledged_at, last_error
)
SELECT
  id, pipeline_instance_id, transition_version,
  CASE kind WHEN 'publish_linear' THEN 'publish_control' ELSE kind END,
  idempotency_key, payload, payload_hash, status, attempts, next_attempt_at,
  created_at, acknowledged_at, last_error
FROM pipeline_effect_intents;
DROP TABLE pipeline_effect_intents;
ALTER TABLE pipeline_effect_intents_control_v34 RENAME TO pipeline_effect_intents;
CREATE INDEX pipeline_effects_pending_idx
  ON pipeline_effect_intents(status, next_attempt_at);
PRAGMA foreign_keys = ON;
`;

const controlPublicationVocabularyMigrationSource = `${controlPublicationVocabularySchema}
control-publication-contract:pipeline control publication effects and receipts use provider-neutral vocabulary while GitHub summary remains evidence publication/v1
backfill-contract:legacy publish_linear effects and linear_ledger receipts are renamed in place without changing idempotency or payload fences/v1`;

const neutralControlIdentifierMigrationSource = `
rename live control-plane ticket/session/context identifiers from Linear-shaped storage names to provider-neutral storage names
tables: tickets,runs,agent_sessions,control_outbox,session_inbox,pipeline_instances,work_items,work_deliveries,provider_events,feedback_snapshots,session_executions,run_outcomes,execution_publication_events
backfill-contract:existing rows are retained in place, provider identity remains linear, external thread ids retain the old Linear issue id, internal ticket ids become linear-prefixed, and foreign keys must remain valid/v2`;

function migrateNeutralControlIdentifiers(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA defer_foreign_keys = ON");
  renameTableIfPresent(db, "linear_outbox", "control_outbox");

  renameColumnIfPresent(db, "tickets", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "tickets", "linear_issue_identifier", "ticket_reference");
  renameColumnIfPresent(db, "tickets", "linear_session_id", "session_id");
  renameColumnIfPresent(db, "tickets", "linear_context", "context");

  renameColumnIfPresent(db, "runs", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "runs", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "agent_sessions", "linear_issue_id", "ticket_id");

  renameColumnIfPresent(db, "control_outbox", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "control_outbox", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "session_inbox", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "session_inbox", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "pipeline_instances", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "pipeline_instances", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "work_items", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "work_items", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "work_deliveries", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "work_deliveries", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "provider_events", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "provider_events", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "feedback_snapshots", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "feedback_snapshots", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "session_executions", "linear_issue_id", "ticket_id");
  renameColumnIfPresent(db, "session_executions", "linear_session_id", "session_id");

  renameColumnIfPresent(db, "run_outcomes", "linear_issue_id", "ticket_id");

  renameColumnIfPresent(db, "execution_publication_events", "linear_outbox_id", "control_outbox_id");

  if (hasTable(db, "tickets")) {
    for (const [column, sql] of [
      ["control_provider", "ALTER TABLE tickets ADD COLUMN control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github'))"],
      ["external_thread_id", "ALTER TABLE tickets ADD COLUMN external_thread_id TEXT"],
      ["external_thread_reference", "ALTER TABLE tickets ADD COLUMN external_thread_reference TEXT"],
    ] as const) {
      if (!hasColumns(db, "tickets", [column])) db.exec(sql);
    }
    db.exec(`
      UPDATE tickets
      SET control_provider = COALESCE(control_provider, 'linear'),
          external_thread_id = COALESCE(NULLIF(external_thread_id, ''), ticket_id),
          external_thread_reference = COALESCE(NULLIF(external_thread_reference, ''), ticket_reference)
    `);
    for (const table of [
      "runs",
      "agent_sessions",
      "control_outbox",
      "session_inbox",
      "pipeline_instances",
      "work_items",
      "work_deliveries",
      "provider_events",
      "feedback_snapshots",
      "session_executions",
      "run_outcomes",
    ]) {
      if (!hasColumns(db, table, ["ticket_id"])) continue;
      db.exec(`
        UPDATE ${table}
        SET ticket_id = 'linear:' || ticket_id
        WHERE ticket_id IN (
          SELECT ticket_id FROM tickets
          WHERE control_provider = 'linear' AND ticket_id NOT LIKE 'linear:%'
        )
      `);
    }
    if (hasTable(db, "settings")) {
      db.exec(`
        UPDATE settings
        SET key = 'github-head:linear:' || substr(key, length('github-head:') + 1)
        WHERE key LIKE 'github-head:%'
          AND substr(key, length('github-head:') + 1) NOT LIKE 'linear:%'
      `);
    }
    db.exec(`
      UPDATE tickets
      SET ticket_id = 'linear:' || ticket_id
      WHERE control_provider = 'linear' AND ticket_id NOT LIKE 'linear:%'
    `);
  }

  db.exec(`
    DROP INDEX IF EXISTS linear_outbox_process_idx;
    DROP INDEX IF EXISTS linear_outbox_session_order_idx;
    DROP INDEX IF EXISTS run_outcomes_issue_idx;
  `);
  if (hasTable(db, "control_outbox")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS control_outbox_process_idx
        ON control_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS control_outbox_session_order_idx
        ON control_outbox(session_id, sequence);
    `);
  }
  if (hasTable(db, "run_outcomes")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS run_outcomes_ticket_idx
        ON run_outcomes(ticket_id, created_at DESC);
    `);
  }
  db.exec("PRAGMA foreign_keys = ON");
}

function addExecutionGraphStopFence(db: Database.Database): void {
  if (!hasColumns(db, "execution_graphs", ["stopped_at"])) {
    db.exec("ALTER TABLE execution_graphs ADD COLUMN stopped_at TEXT");
  }
  if (!hasColumns(db, "execution_graphs", ["stop_reason"])) {
    db.exec("ALTER TABLE execution_graphs ADD COLUMN stop_reason TEXT");
  }
}

function assertExecutionCompositeIdentityPrerequisites(db: Database.Database): void {
  const requiredTables = [
    "pipeline_instances",
    "pipeline_stage_attempts",
    "execution_graphs",
    "execution_units",
    "execution_work_attempts",
    "execution_gate_receipts",
    "execution_downstream_context",
  ];
  const missingTable = requiredTables.find((table) => !hasTable(db, table));
  if (missingTable) {
    throw new Error(`cannot apply execution composite identity migration: missing ${missingTable}`);
  }
  const requiredAttemptColumns = ["id", "pipeline_instance_id", "planned_run_id"];
  const missingAttemptColumns = requiredAttemptColumns.filter(
    (column) => !hasColumns(db, "pipeline_stage_attempts", [column])
  );
  if (missingAttemptColumns.length > 0) {
    throw new Error(
      `cannot apply execution composite identity migration: missing pipeline_stage_attempts.${missingAttemptColumns.join(",")}`
    );
  }
  const stageIndexes = db.prepare("PRAGMA index_list('pipeline_stage_attempts')").all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasCompositeAttemptIdentity = stageIndexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = db.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>;
    return columns.map((column) => column.name).join(",") === "id,pipeline_instance_id";
  });
  if (!hasCompositeAttemptIdentity) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stage_attempts_attempt_instance_unique
        ON pipeline_stage_attempts(id, pipeline_instance_id)
    `);
  }
}

function widenPipelineArtifactKindsForExecutionGraphResult(db: Database.Database): void {
  if (!hasTable(db, "pipeline_artifacts")) return;
  const table = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_artifacts'
  `).get() as { sql: string } | undefined;
  if (table?.sql.includes("'execution_graph_result'")) return;
  db.exec(pipelineArtifactsExecutionGraphResultSchema);
}

function contractSatelliteTables(db: Database.Database): void {
  if (hasTable(db, "agent_sessions")) {
    if (!hasColumns(db, "agent_sessions", ["execution_mode"])) {
      db.exec("ALTER TABLE agent_sessions ADD COLUMN execution_mode TEXT CHECK(execution_mode IS NULL OR execution_mode IN ('legacy', 'pipeline'))");
    }
    if (!hasColumns(db, "agent_sessions", ["pipeline_instance_id"])) {
      db.exec("ALTER TABLE agent_sessions ADD COLUMN pipeline_instance_id TEXT");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_pipeline_instance_unique
        ON agent_sessions(pipeline_instance_id) WHERE pipeline_instance_id IS NOT NULL
    `);
    if (hasTable(db, "session_executions")) {
      const sessionExecutionSessionColumn = hasColumns(db, "session_executions", ["linear_session_id"])
        ? "linear_session_id"
        : "session_id";
      db.exec(`
        UPDATE agent_sessions
        SET execution_mode = (
              SELECT execution_mode FROM session_executions
              WHERE session_executions.${sessionExecutionSessionColumn} = agent_sessions.id
            ),
            pipeline_instance_id = (
              SELECT pipeline_instance_id FROM session_executions
              WHERE session_executions.${sessionExecutionSessionColumn} = agent_sessions.id
            )
        WHERE EXISTS (
          SELECT 1 FROM session_executions
          WHERE session_executions.${sessionExecutionSessionColumn} = agent_sessions.id
        )
      `);
    }
  }
  if (hasTable(db, "pipeline_instances")) {
    for (const [column, sql] of [
      ["runtime_provider", "ALTER TABLE pipeline_instances ADD COLUMN runtime_provider TEXT"],
      ["runtime_provider_resource_id", "ALTER TABLE pipeline_instances ADD COLUMN runtime_provider_resource_id TEXT"],
      [
        "runtime_resource_status",
        "ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_status TEXT CHECK(runtime_resource_status IS NULL OR runtime_resource_status IN ('active', 'stopped', 'quarantined', 'cleaned'))",
      ],
      ["runtime_resource_created_at", "ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_created_at TEXT"],
      ["runtime_resource_updated_at", "ALTER TABLE pipeline_instances ADD COLUMN runtime_resource_updated_at TEXT"],
    ] as const) {
      if (!hasColumns(db, "pipeline_instances", [column])) db.exec(sql);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS pipeline_instances_runtime_resource_unique
        ON pipeline_instances(runtime_provider_resource_id) WHERE runtime_provider_resource_id IS NOT NULL
    `);
    if (hasTable(db, "pipeline_runtime_resources")) {
      db.exec(`
        UPDATE pipeline_instances
        SET runtime_provider = (
              SELECT provider FROM pipeline_runtime_resources
              WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
            ),
            runtime_provider_resource_id = (
              SELECT provider_resource_id FROM pipeline_runtime_resources
              WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
            ),
            runtime_resource_status = (
              SELECT status FROM pipeline_runtime_resources
              WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
            ),
            runtime_resource_created_at = (
              SELECT created_at FROM pipeline_runtime_resources
              WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
            ),
            runtime_resource_updated_at = (
              SELECT updated_at FROM pipeline_runtime_resources
              WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
            )
        WHERE EXISTS (
          SELECT 1 FROM pipeline_runtime_resources
          WHERE pipeline_runtime_resources.pipeline_instance_id = pipeline_instances.id
        )
      `);
    }
  }
  if (hasTable(db, "runs")) {
    for (const [column, sql] of [
      ["actor_state", "ALTER TABLE runs ADD COLUMN actor_state TEXT CHECK(actor_state IS NULL OR actor_state IN ('running', 'reaping', 'quarantined', 'settled'))"],
      ["last_heartbeat_at", "ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT"],
      ["settlement_owner", "ALTER TABLE runs ADD COLUMN settlement_owner TEXT"],
      ["settlement_reason", "ALTER TABLE runs ADD COLUMN settlement_reason TEXT"],
      ["termination_confirmed_at", "ALTER TABLE runs ADD COLUMN termination_confirmed_at TEXT"],
      ["quarantine_reason", "ALTER TABLE runs ADD COLUMN quarantine_reason TEXT"],
      ["actor_created_at", "ALTER TABLE runs ADD COLUMN actor_created_at TEXT"],
      ["actor_updated_at", "ALTER TABLE runs ADD COLUMN actor_updated_at TEXT"],
    ] as const) {
      if (!hasColumns(db, "runs", [column])) db.exec(sql);
    }
    db.exec("CREATE INDEX IF NOT EXISTS runs_actor_state_idx ON runs(actor_state, last_heartbeat_at)");
    const runUpdatedFallback = hasColumns(db, "runs", ["completed_at"])
      ? "COALESCE(actor_updated_at, completed_at, started_at)"
      : "COALESCE(actor_updated_at, started_at)";
    db.exec(`
      UPDATE runs
      SET actor_state = CASE
            WHEN status IN ('running', 'reaping', 'quarantined') THEN status
            WHEN status IN ('completed', 'failed', 'timed_out', 'stopped') THEN 'settled'
            ELSE actor_state
          END,
          actor_created_at = COALESCE(actor_created_at, started_at),
          actor_updated_at = ${runUpdatedFallback}
      WHERE actor_state IS NULL
    `);
    // Prefer the authoritative attempt actor over stale run_liveness. Once a
    // pipeline_attempt_actors row exists for a pipeline-backed run, the previous
    // run store wrote every lifecycle transition (reaping/quarantine/settlement)
    // there and left run_liveness lagging. Folding run_liveness for such a run
    // would overwrite the current status/attempt-derived owner state with a
    // stale value, leaving runs.actor_state inconsistent with the
    // pipeline_stage_attempts owner row folded below (which reads the same
    // authoritative pipeline_attempt_actors row) and causing conditional
    // settlement updates on runs.actor_state to miss. Fold from
    // pipeline_attempt_actors when it owns the run, and fall back to run_liveness
    // only for legacy runs that never gained an attempt actor.
    if (hasTable(db, "pipeline_attempt_actors")) {
      db.exec(`
        UPDATE runs
        SET actor_state = COALESCE((
              SELECT actor_state FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ), actor_state),
            last_heartbeat_at = (
              SELECT last_heartbeat_at FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ),
            settlement_owner = (
              SELECT settlement_owner FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ),
            settlement_reason = (
              SELECT settlement_reason FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ),
            termination_confirmed_at = (
              SELECT termination_confirmed_at FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ),
            quarantine_reason = (
              SELECT quarantine_reason FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ),
            actor_created_at = COALESCE((
              SELECT created_at FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ), actor_created_at, started_at),
            actor_updated_at = COALESCE((
              SELECT updated_at FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
            ), actor_updated_at)
        WHERE EXISTS (
          SELECT 1 FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id
        )
      `);
    }
    if (hasTable(db, "run_liveness")) {
      const legacyRunsOnly = hasTable(db, "pipeline_attempt_actors")
        ? "AND NOT EXISTS (SELECT 1 FROM pipeline_attempt_actors WHERE pipeline_attempt_actors.run_id = runs.id)"
        : "";
      db.exec(`
        UPDATE runs
        SET actor_state = COALESCE((
              SELECT actor_state FROM run_liveness WHERE run_liveness.run_id = runs.id
            ), actor_state),
            last_heartbeat_at = (
              SELECT last_heartbeat_at FROM run_liveness WHERE run_liveness.run_id = runs.id
            ),
            settlement_owner = (
              SELECT settlement_owner FROM run_liveness WHERE run_liveness.run_id = runs.id
            ),
            settlement_reason = (
              SELECT settlement_reason FROM run_liveness WHERE run_liveness.run_id = runs.id
            ),
            termination_confirmed_at = (
              SELECT termination_confirmed_at FROM run_liveness WHERE run_liveness.run_id = runs.id
            ),
            quarantine_reason = (
              SELECT quarantine_reason FROM run_liveness WHERE run_liveness.run_id = runs.id
            ),
            actor_created_at = COALESCE(actor_created_at, started_at),
            actor_updated_at = COALESCE((
              SELECT updated_at FROM run_liveness WHERE run_liveness.run_id = runs.id
            ), actor_updated_at)
        WHERE EXISTS (SELECT 1 FROM run_liveness WHERE run_liveness.run_id = runs.id)
          ${legacyRunsOnly}
      `);
    }
  }
  if (hasTable(db, "pipeline_stage_attempts")) {
    for (const [column, sql] of [
      ["actor_state", "ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_state TEXT CHECK(actor_state IS NULL OR actor_state IN ('running', 'reaping', 'quarantined', 'settled'))"],
      ["last_heartbeat_at", "ALTER TABLE pipeline_stage_attempts ADD COLUMN last_heartbeat_at TEXT"],
      ["settlement_owner", "ALTER TABLE pipeline_stage_attempts ADD COLUMN settlement_owner TEXT"],
      ["settlement_reason", "ALTER TABLE pipeline_stage_attempts ADD COLUMN settlement_reason TEXT"],
      ["termination_confirmed_at", "ALTER TABLE pipeline_stage_attempts ADD COLUMN termination_confirmed_at TEXT"],
      ["quarantine_reason", "ALTER TABLE pipeline_stage_attempts ADD COLUMN quarantine_reason TEXT"],
      ["actor_created_at", "ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_created_at TEXT"],
      ["actor_updated_at", "ALTER TABLE pipeline_stage_attempts ADD COLUMN actor_updated_at TEXT"],
    ] as const) {
      if (!hasColumns(db, "pipeline_stage_attempts", [column])) db.exec(sql);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS pipeline_stage_attempts_actor_state_idx
        ON pipeline_stage_attempts(actor_state, last_heartbeat_at)
    `);
    if (hasTable(db, "pipeline_attempt_actors")) {
      db.exec(`
        UPDATE pipeline_stage_attempts
        SET actor_state = (
              SELECT actor_state FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            last_heartbeat_at = (
              SELECT last_heartbeat_at FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            settlement_owner = (
              SELECT settlement_owner FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            settlement_reason = (
              SELECT settlement_reason FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            termination_confirmed_at = (
              SELECT termination_confirmed_at FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            quarantine_reason = (
              SELECT quarantine_reason FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            actor_created_at = (
              SELECT created_at FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            ),
            actor_updated_at = (
              SELECT updated_at FROM pipeline_attempt_actors
              WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
            )
        WHERE EXISTS (
          SELECT 1 FROM pipeline_attempt_actors
          WHERE pipeline_attempt_actors.attempt_id = pipeline_stage_attempts.id
        )
      `);
    }
  }
}

const definitions: DatabaseMigrationDefinition[] = [
  {
    version: 1,
    name: "durable-work-delivery",
    source: durableWorkMigrationSource,
    up(db) {
      db.exec(durableWorkSchema);
    },
  },
  {
    version: 2,
    name: "exclusive-actor-lifecycle-and-feedback",
    source: lifecycleMigrationSource,
    up(db) {
      db.exec(lifecycleSchema);
      backfillRunLiveness(db);
    },
  },
  {
    version: 3,
    name: "sandbox-liveness-event-index",
    source: lifecycleEventIndexMigrationSource,
    up(db) {
      if (hasTable(db, "sandbox_events")) db.exec(lifecycleEventIndex);
    },
  },
  {
    version: 4,
    name: "dormant-pipeline-coordinator",
    source: pipelineCoordinatorMigrationSource,
    up(db) {
      db.exec(pipelineCoordinatorSchema);
      backfillLegacySessionExecutions(db);
    },
  },
  {
    version: 5,
    name: "canonical-gate-receipt-payload",
    source: canonicalGateReceiptMigrationSource,
    up(db) {
      db.exec(canonicalGateReceiptSchema);
      backfillPipelineExecutionIdentity(db);
    },
  },
  {
    version: 6,
    name: "durable-pipeline-publication",
    source: durablePipelinePublicationMigrationSource,
    up(db) {
      if (hasTable(db, "linear_outbox")) {
        for (const [column, sql] of [
          ["external_id", "ALTER TABLE linear_outbox ADD COLUMN external_id TEXT"],
          ["external_url", "ALTER TABLE linear_outbox ADD COLUMN external_url TEXT"],
          ["attachment_url", "ALTER TABLE linear_outbox ADD COLUMN attachment_url TEXT"],
        ] as const) {
          if (!hasColumns(db, "linear_outbox", [column])) db.exec(sql);
        }
      }
      db.exec(pipelinePublicationStateSchema);
      backfillPipelinePublicationState(db);
    },
  },
  {
    version: 7,
    name: "pipeline-runtime-resources",
    source: pipelineRuntimeResourceMigrationSource,
    up(db) {
      db.exec(pipelineRuntimeResourceSchema);
    },
  },
  {
    version: 8,
    name: "pipeline-execution-intent-and-provider-revision",
    source: pipelineIntentMigrationSource,
    up(db) {
      db.exec(pipelineIntentSchema);
      if (hasTable(db, "tickets")) {
        db.exec(`
          UPDATE pipeline_instances
          SET base_branch = COALESCE((
            SELECT tickets.base_branch FROM tickets
            WHERE tickets.linear_issue_id = pipeline_instances.linear_issue_id
          ), base_branch)
        `);
      }
    },
  },
  {
    version: 9,
    name: "pipeline-attempt-actors",
    source: pipelineAttemptActorMigrationSource,
    up(db) {
      db.exec(pipelineAttemptActorSchema);
      backfillPipelineAttemptActors(db);
    },
  },
  {
    version: 10,
    name: "sandbox-event-ingestion-diagnostics",
    source: sandboxEventDiagnosticsMigrationSource,
    up(db) {
      if (hasTable(db, "sandbox_events") && !hasColumns(db, "sandbox_events", ["ingestion_diagnosed_at"])) {
        db.exec(sandboxEventDiagnosticsSchema);
      }
    },
  },
  {
    version: 11,
    name: "pipeline-idle-runtime-effect",
    source: pipelineIdleEffectMigrationSource,
    up(db) {
      widenPipelineEffectIntentsForIdle(db);
    },
  },
  {
    version: 12,
    name: "feedback-observed-head-provenance",
    source: feedbackObservedHeadMigrationSource,
    up(db) {
      addFeedbackObservedHeadProvenance(db);
    },
  },
  {
    version: 13,
    name: "selection-publication-backfill",
    source: selectionPublicationBackfillSource,
    up(db) {
      backfillSelectionPublications(db);
    },
  },
  {
    version: 14,
    name: "satellite-table-contraction",
    source: satelliteTableContractionSource,
    up(db) {
      contractSatelliteTables(db);
    },
  },
  {
    version: 15,
    name: "orchestration-journal",
    source: orchestrationJournalMigrationSource,
    up(db) {
      if (!hasTable(db, "orchestration_journal")) db.exec(orchestrationJournalSchema);
    },
  },
  {
    version: 16,
    name: "execution-unit-child-reducer",
    source: executionUnitMigrationSource,
    up(db) {
      if (!hasTable(db, "execution_graphs")) db.exec(executionUnitSchema);
      widenPipelineArtifactKindsForExecutionGraphResult(db);
    },
  },
  {
    version: 17,
    name: "execution-child-gates-and-context",
    source: executionChildGateMigrationSource,
    up(db) {
      addExecutionGraphStopFence(db);
      db.exec(executionChildGateSchema);
    },
  },
  {
    version: 18,
    name: "execution-composite-child-identity",
    source: executionCompositeIdentityMigrationSource,
    up(db) {
      assertExecutionCompositeIdentityPrerequisites(db);
      db.exec(executionCompositeIdentitySchema);
    },
  },
  {
    version: 19,
    name: "execution-unit-phase-machine",
    source: executionUnitPhaseMachineMigrationSource,
    up(db) {
      db.exec(executionUnitPhaseMachineSchema);
    },
  },
  {
    version: 20,
    name: "execution-graph-declared-unit-phases",
    source: executionGraphDeclaredUnitPhasesMigrationSource,
    up(db) {
      if (hasTable(db, "execution_graphs") && !hasColumns(db, "execution_graphs", ["unit_phases"])) {
        db.exec(executionGraphDeclaredUnitPhasesSchema);
      }
    },
  },
  {
    version: 21,
    name: "execution-graph-unit-phase-bindings",
    source: executionGraphUnitPhaseBindingsMigrationSource,
    up(db) {
      if (hasTable(db, "execution_graphs") && !hasColumns(db, "execution_graphs", ["unit_phase_bindings"])) {
        db.exec(executionGraphUnitPhaseBindingsSchema);
      }
    },
  },
  {
    version: 22,
    name: "execution-unit-plan-command-names",
    source: executionUnitPlanCommandNamesMigrationSource,
    up(db) {
      if (hasTable(db, "execution_units") && !hasColumns(db, "execution_units", ["command_names"])) {
        db.exec(executionUnitPlanCommandNamesSchema);
      }
    },
  },
  {
    version: 23,
    name: "execution-work-prepared-requests",
    source: executionWorkPreparedRequestsMigrationSource,
    up(db) {
      if (hasTable(db, "execution_work_attempts") && !hasColumns(db, "execution_work_attempts", ["request_payload"])) {
        db.exec(executionWorkPreparedRequestsSchema);
      }
    },
  },
  {
    version: 24,
    name: "execution-work-terminal-outcome",
    source: executionWorkTerminalOutcomeMigrationSource,
    up(db) {
      if (hasTable(db, "execution_work_attempts") && !hasColumns(db, "execution_work_attempts", ["terminal_result_outcome"])) {
        db.exec(executionWorkTerminalOutcomeSchema);
      }
    },
  },
  {
    version: 25,
    name: "execution-publication-events",
    source: executionPublicationEventsMigrationSource,
    up(db) {
      if (hasTable(db, "execution_graphs") && !hasTable(db, "execution_publication_events")) {
        db.exec(executionPublicationEventsSchema);
      }
    },
  },
  {
    version: 26,
    name: "execution-gate-receipt-reason-enum",
    source: executionGateReceiptReasonEnumMigrationSource,
    up(db) {
      if (hasTable(db, "execution_gate_receipts")) {
        db.exec(executionGateReceiptReasonEnumSchema);
      }
    },
  },
  {
    version: 27,
    name: "orchestration-journal-close-escalated-human",
    source: orchestrationJournalCloseEscalatedHumanMigrationSource,
    up(db) {
      if (hasTable(db, "orchestration_journal")) {
        db.exec(orchestrationJournalCloseEscalatedHumanSchema);
      }
    },
  },
  {
    version: 28,
    name: "run-fault-attribution",
    source: runFaultAttributionMigrationSource,
    up(db) {
      if (hasTable(db, "runs") && !hasColumns(db, "runs", ["fault_attribution"])) {
        db.exec(runFaultAttributionSchema);
      }
    },
  },
  {
    version: 29,
    name: "run-outcomes-settlement-rollup",
    source: runOutcomesMigrationSource,
    up(db) {
      if (hasTable(db, "pipeline_instances") && !hasTable(db, "run_outcomes")) {
        db.exec(runOutcomesSchema);
      }
      if (
        hasTable(db, "execution_work_attempts") &&
        !hasIndex(db, "execution_work_attempts_pipeline_instance_idx")
      ) {
        db.exec(runOutcomesReceiptIndexSchema);
      }
    },
  },
  {
    version: 30,
    name: "pipeline-published-subject-binding",
    source: pipelinePublishedSubjectMigrationSource,
    up(db) {
      if (hasTable(db, "pipeline_instances") && !hasColumns(db, "pipeline_instances", ["published_subject"])) {
        db.exec(pipelinePublishedSubjectSchema);
      }
    },
  },
  {
    version: 31,
    name: "citation-gate-receipts",
    source: citationGateReceiptMigrationSource,
    up(db) {
      if (!hasTable(db, "citation_gate_receipts")) {
        db.exec(citationGateReceiptSchema);
      }
    },
  },
  {
    version: 32,
    name: "execution-review-subaction-dispatches",
    source: reviewSubactionDispatchMigrationSource,
    up(db) {
      if (hasTable(db, "execution_work_attempts") && !hasTable(db, "execution_review_subaction_dispatches")) {
        db.exec(reviewSubactionDispatchSchema);
      }
    },
  },
  {
    version: 33,
    name: "control-provider-repository-registration",
    source: controlProviderRegistrationMigrationSource,
    up(db) {
      if (hasTable(db, "repository_registrations") && !hasColumns(db, "repository_registrations", ["control_provider"])) {
        db.exec(controlProviderRegistrationSchema);
      }
    },
  },
  {
    version: 34,
    name: "control-publication-vocabulary",
    source: controlPublicationVocabularyMigrationSource,
    up(db) {
      if (hasTable(db, "pipeline_publication_receipts") && hasTable(db, "pipeline_effect_intents")) {
        db.exec(controlPublicationVocabularySchema);
      }
    },
  },
  {
    version: 35,
    name: "neutral-control-identifiers",
    source: neutralControlIdentifierMigrationSource,
    up(db) {
      migrateNeutralControlIdentifiers(db);
      // V13 cannot use the neutral writer on a legacy schema. Reconcile after
      // the identifier/vocabulary migration so direct upgrades still receive
      // every missing selection publication exactly once.
      backfillSelectionPublications(db);
    },
  },
];

export const databaseMigrations: DatabaseMigration[] = definitions.map((migration) => ({
  ...migration,
  checksum: createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.source}`)
    .digest("hex"),
}));
