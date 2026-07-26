import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  backfillLegacySessionExecutions,
  backfillLegacyWork,
  backfillPipelineAttemptActors,
  backfillPipelineExecutionIdentity,
  backfillPipelinePublicationState,
  backfillRunLiveness,
  hasColumns,
  hasTable,
} from "./reconciliation.js";

interface DatabaseMigrationDefinition {
  version: number;
  name: string;
  source: string;
  up(db: Database.Database): void;
}

export interface DatabaseMigration extends DatabaseMigrationDefinition {
  checksum: string;
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

const definitions: DatabaseMigrationDefinition[] = [
  {
    version: 1,
    name: "durable-work-delivery",
    source: durableWorkMigrationSource,
    up(db) {
      db.exec(durableWorkSchema);
      backfillLegacyWork(db);
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
];

export const databaseMigrations: DatabaseMigration[] = definitions.map((migration) => ({
  ...migration,
  checksum: createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.source}`)
    .digest("hex"),
}));
