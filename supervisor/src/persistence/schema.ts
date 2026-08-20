import type Database from "better-sqlite3";

export const SCHEMA_EPOCH = 1 as const;

/**
 * Schema epoch 1 is a fresh-database baseline, not an upgrade migration.
 * The migration runner proves the file has no pre-existing application schema
 * before executing this SQL.
 */
export const schema = `
CREATE TABLE schema_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_epoch INTEGER NOT NULL CHECK(schema_epoch = 1),
  baseline_checksum TEXT NOT NULL,
  application_sha TEXT NOT NULL,
  first_write_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- table: agent_sessions
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'current',
  provider_conversation_id TEXT,
  provider_activated_at TEXT,
  provider_activation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT, execution_mode TEXT CHECK(execution_mode IS NULL OR execution_mode IN ('legacy', 'pipeline')), pipeline_instance_id TEXT,
  UNIQUE(ticket_id, generation),
  FOREIGN KEY(ticket_id) REFERENCES tickets(ticket_id)
);

-- table: citation_gate_receipts
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

-- table: control_outbox
CREATE TABLE "control_outbox" (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  ticket_id TEXT,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,
  external_id TEXT,
  external_url TEXT,
  attachment_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

-- table: deployment_cutovers
CREATE TABLE deployment_cutovers (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'recovery_required')),
  old_runtime_release TEXT NOT NULL,
  old_snapshot TEXT NOT NULL,
  candidate_snapshot TEXT NOT NULL,
  pause_epoch INTEGER,
  phase TEXT NOT NULL CHECK(phase IN (
    'registered', 'paused', 'drain_clear', 'staged', 'deployed',
    'verified', 'restored', 'recovery_required', 'resumed'
  )),
  evidence TEXT NOT NULL DEFAULT '',
  recovery_command TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- table: execution_checkpoint_objects
CREATE TABLE execution_checkpoint_objects (
  action_id TEXT PRIMARY KEY REFERENCES execution_work_attempts(id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL UNIQUE,
  expected_old_sha TEXT NOT NULL CHECK(length(expected_old_sha) = 40 AND expected_old_sha NOT GLOB '*[^a-f0-9]*'),
  expected_new_sha TEXT NOT NULL CHECK(length(expected_new_sha) = 40 AND expected_new_sha NOT GLOB '*[^a-f0-9]*'),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 67108864),
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(expected_old_sha <> expected_new_sha),
  CHECK(length(payload) = payload_bytes)
);

-- table: execution_downstream_context
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

-- table: execution_gate_receipts
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

-- table: execution_graphs
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
  integration_subject TEXT,
  aggregate_artifact_hash TEXT,
  aggregate_emitted_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, unit_phases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unit_phases)), unit_phase_bindings TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unit_phase_bindings)), initial_subject TEXT, stop_outcome TEXT CHECK(
  stop_outcome IS NULL OR stop_outcome IN ('failure', 'needs_human', 'retryable_infrastructure_failure')
),
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT,
  UNIQUE(id, pipeline_instance_id, parent_attempt_id),
  UNIQUE(id, pipeline_instance_id, parent_attempt_id, parent_run_id)
);

-- table: execution_publication_events
CREATE TABLE execution_publication_events (
  id TEXT PRIMARY KEY,
  execution_graph_id TEXT NOT NULL,
  pipeline_instance_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  unit_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('unit_repair', 'unit_settled', 'graph_stopped', 'final_review', 'aggregate', 'steering_undelivered')),
  body TEXT NOT NULL,
  control_outbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(control_outbox_id) REFERENCES "control_outbox"(id) ON DELETE RESTRICT,
  UNIQUE(parent_attempt_id, sequence)
);

-- table: execution_review_subaction_dispatches
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

-- table: execution_units
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
  updated_at TEXT NOT NULL, command_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(command_names)),
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

-- table: execution_work_attempts
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
  last_error TEXT, request_payload TEXT CHECK(request_payload IS NULL OR json_valid(request_payload)), request_launch_state TEXT CHECK(
  request_launch_state IS NULL OR request_launch_state IN ('prepared', 'worktree_ready', 'launched')
), terminal_result_outcome TEXT CHECK(
  terminal_result_outcome IS NULL OR terminal_result_outcome IN (
    'failure',
    'needs_human',
    'retryable_infrastructure_failure'
  )
), observation_failure_count INTEGER NOT NULL DEFAULT 0 CHECK(observation_failure_count >= 0), observation_retry_at TEXT, observation_epoch INTEGER NOT NULL DEFAULT 0 CHECK(observation_epoch >= 0), checkpoint_expected_old_sha TEXT
  CHECK(checkpoint_expected_old_sha IS NULL OR (length(checkpoint_expected_old_sha) = 40 AND checkpoint_expected_old_sha NOT GLOB '*[^a-f0-9]*')), checkpoint_remote_sha TEXT
  CHECK(checkpoint_remote_sha IS NULL OR (length(checkpoint_remote_sha) = 40 AND checkpoint_remote_sha NOT GLOB '*[^a-f0-9]*')), checkpoint_status TEXT
  CHECK(checkpoint_status IS NULL OR checkpoint_status IN ('pending', 'acknowledged', 'failed')), checkpoint_effect_id TEXT, checkpoint_last_error TEXT
  CHECK(checkpoint_last_error IS NULL OR length(checkpoint_last_error) <= 2000), checkpoint_acknowledged_at TEXT,
  FOREIGN KEY(execution_graph_id, pipeline_instance_id, parent_attempt_id, parent_run_id)
    REFERENCES execution_graphs(id, pipeline_instance_id, parent_attempt_id, parent_run_id) ON DELETE RESTRICT,
  FOREIGN KEY(execution_unit_id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id)
    REFERENCES execution_units(id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id) ON DELETE RESTRICT,
  UNIQUE(execution_unit_id, attempt_ordinal, action_kind),
  UNIQUE(execution_graph_id, execution_unit_id, id, parent_attempt_id, unit_id),
  UNIQUE(id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id, unit_id)
);

-- table: execution_work_private_artifacts
CREATE TABLE execution_work_private_artifacts (
  action_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL CHECK(schema = 'openthrottle.execution-work-private-artifact/v1'),
  manifest TEXT NOT NULL CHECK(length(manifest) <= 131072),
  payload BLOB NOT NULL CHECK(length(payload) > 0 AND length(payload) <= 8388608),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes > 0 AND payload_bytes <= 8388608),
  created_at TEXT NOT NULL,
  FOREIGN KEY(action_id) REFERENCES execution_work_attempts(id) ON DELETE CASCADE
);

-- table: feedback_snapshot_events
CREATE TABLE feedback_snapshot_events (
  snapshot_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, provider, provider_event_id),
  FOREIGN KEY(snapshot_id) REFERENCES feedback_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider, provider_event_id)
    REFERENCES provider_events(provider, provider_event_id) ON DELETE RESTRICT
);

-- table: feedback_snapshots
CREATE TABLE feedback_snapshots (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  provider_watermark TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('collecting', 'claimed', 'consumed', 'stale')),
  repair_round INTEGER CHECK(repair_round IS NULL OR repair_round >= 1),
  work_item_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  consumed_at TEXT, observed_head_sha TEXT,
  UNIQUE(ticket_id, generation, head_sha, repair_round)
);

-- table: github_webhook_redelivery_requests
CREATE TABLE github_webhook_redelivery_requests (
  repository TEXT NOT NULL COLLATE NOCASE,
  webhook_id INTEGER NOT NULL,
  delivery_id INTEGER NOT NULL,
  delivery_guid TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed', 'accepted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  accepted_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repository, webhook_id, delivery_id)
);

-- table: orchestration_journal
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

-- table: pipeline_admission_projections
CREATE TABLE pipeline_admission_projections (
  pipeline_instance_id TEXT PRIMARY KEY REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  proposed_route TEXT CHECK(proposed_route IS NULL OR proposed_route IN ('simple', 'structured', 'needs_human')),
  final_route TEXT CHECK(final_route IS NULL OR final_route IN ('simple', 'structured')),
  semantic_repair_count INTEGER NOT NULL DEFAULT 0 CHECK(semantic_repair_count >= 0),
  infrastructure_retry_count INTEGER NOT NULL DEFAULT 0 CHECK(infrastructure_retry_count >= 0),
  terminal_state TEXT,
  questions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(questions) AND json_type(questions) = 'array'),
  reviewer_verdict TEXT CHECK(reviewer_verdict IS NULL OR reviewer_verdict IN ('approved', 'rejected', 'needs_human')),
  planner_skill_reference TEXT NOT NULL,
  planner_package_digest TEXT CHECK(planner_package_digest IS NULL OR (length(planner_package_digest) = 64 AND planner_package_digest NOT GLOB '*[^a-f0-9]*')),
  reviewer_skill_reference TEXT NOT NULL,
  reviewer_package_digest TEXT CHECK(reviewer_package_digest IS NULL OR (length(reviewer_package_digest) = 64 AND reviewer_package_digest NOT GLOB '*[^a-f0-9]*')),
  admission_basis_digest TEXT NOT NULL CHECK(length(admission_basis_digest) = 64 AND admission_basis_digest NOT GLOB '*[^a-f0-9]*'),
  effective_manifest_digest TEXT NOT NULL CHECK(length(effective_manifest_digest) = 64 AND effective_manifest_digest NOT GLOB '*[^a-f0-9]*'),
  generated_plan_digest TEXT CHECK(generated_plan_digest IS NULL OR (length(generated_plan_digest) = 64 AND generated_plan_digest NOT GLOB '*[^a-f0-9]*')),
  checkpoint_digest TEXT CHECK(checkpoint_digest IS NULL OR (length(checkpoint_digest) = 64 AND checkpoint_digest NOT GLOB '*[^a-f0-9]*')),
  accepted_plan_artifact_hash TEXT CHECK(accepted_plan_artifact_hash IS NULL OR (length(accepted_plan_artifact_hash) = 64 AND accepted_plan_artifact_hash NOT GLOB '*[^a-f0-9]*')),
  reviewer_receipt_artifact_hash TEXT CHECK(reviewer_receipt_artifact_hash IS NULL OR (length(reviewer_receipt_artifact_hash) = 64 AND reviewer_receipt_artifact_hash NOT GLOB '*[^a-f0-9]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- table: pipeline_artifacts
CREATE TABLE "pipeline_artifacts" (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'stage_result', 'execution_plan', 'execution_graph_result', 'review', 'command_result',
    'provider_check', 'human_approval', 'publish_subject', 'standard_receipt'
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

-- table: pipeline_catalog_aliases
CREATE TABLE pipeline_catalog_aliases (
  alias TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_id, version, digest)
    REFERENCES pipeline_catalog_entries(pipeline_id, version, digest) ON DELETE RESTRICT
);

-- table: pipeline_catalog_entries
CREATE TABLE pipeline_catalog_entries (
  pipeline_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  digest TEXT NOT NULL,
  normalized_manifest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(pipeline_id, version),
  UNIQUE(pipeline_id, version, digest)
);

-- table: pipeline_effect_intents
CREATE TABLE "pipeline_effect_intents" (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
  kind TEXT NOT NULL CHECK(kind IN (
    'create_task_branch', 'advance_task_branch',
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

-- table: pipeline_gate_receipts
CREATE TABLE "pipeline_gate_receipts" (
  id TEXT PRIMARY KEY,
  pipeline_instance_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  evaluator_kind TEXT NOT NULL CHECK(evaluator_kind IN (
    'result', 'semantic', 'command', 'provider', 'human', 'publish_subject',
    'citation', 'differential_ratchet'
  )),
  policy_digest TEXT NOT NULL,
  subject TEXT,
  result TEXT NOT NULL CHECK(result IN ('passed', 'failed', 'indeterminate', 'skipped', 'not_configured')),
  artifact_hashes TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id, pipeline_instance_id)
    REFERENCES pipeline_stage_attempts(id, pipeline_instance_id) ON DELETE RESTRICT
);

-- table: pipeline_inbox_events
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

-- table: pipeline_instance_stages
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

-- table: pipeline_instances
CREATE TABLE "pipeline_instances" (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
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
  branch TEXT,
  agent TEXT,
  task_type TEXT NOT NULL DEFAULT 'implement' CHECK(task_type IN ('implement', 'investigate', 'tune')),
  base_branch TEXT NOT NULL DEFAULT 'main',
  published_commit TEXT,
  runtime_provider TEXT,
  runtime_provider_resource_id TEXT,
  runtime_resource_status TEXT CHECK(runtime_resource_status IS NULL OR runtime_resource_status IN ('active', 'stopped', 'quarantined', 'cleaned')),
  runtime_resource_created_at TEXT,
  runtime_resource_updated_at TEXT,
  published_subject TEXT,
  FOREIGN KEY(ticket_id) REFERENCES tickets(ticket_id) ON DELETE RESTRICT,
  FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(session_id, ticket_id, generation)
    REFERENCES agent_sessions(id, ticket_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY(pipeline_id, pipeline_version, manifest_digest)
    REFERENCES pipeline_catalog_entries(pipeline_id, version, digest) ON DELETE RESTRICT,
  FOREIGN KEY(repository_config_snapshot_id, repository, base_commit, repository_config_digest)
    REFERENCES repository_config_snapshots(id, repository, base_commit, digest) ON DELETE RESTRICT,
  FOREIGN KEY(runtime_release, capability_digest)
    REFERENCES runtime_capability_descriptors(runtime_release, digest) ON DELETE RESTRICT,
  UNIQUE(session_id, generation),
  UNIQUE(id, generation),
  UNIQUE(id, session_id, ticket_id, generation)
);

-- table: pipeline_publication_receipts
CREATE TABLE "pipeline_publication_receipts" (
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

-- table: pipeline_stage_attempts
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
  updated_at TEXT NOT NULL, planned_run_id TEXT, expected_subject TEXT, native_session_id TEXT, request_payload TEXT,
  UNIQUE(pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal),
  UNIQUE(id, pipeline_instance_id),
  UNIQUE(id, run_id),
  FOREIGN KEY(pipeline_instance_id, stage_id)
    REFERENCES pipeline_instance_stages(pipeline_instance_id, stage_id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT
);

-- table: pipeline_stage_checkpoint_objects
CREATE TABLE pipeline_stage_checkpoint_objects (
  attempt_id TEXT PRIMARY KEY REFERENCES pipeline_stage_attempts(id) ON DELETE RESTRICT,
  effect_id TEXT NOT NULL UNIQUE,
  expected_tree_sha TEXT NOT NULL CHECK(length(expected_tree_sha) BETWEEN 40 AND 64 AND expected_tree_sha NOT GLOB '*[^a-f0-9]*'),
  expected_old_sha TEXT NOT NULL CHECK(length(expected_old_sha) = 40 AND expected_old_sha NOT GLOB '*[^a-f0-9]*'),
  expected_new_sha TEXT NOT NULL CHECK(length(expected_new_sha) = 40 AND expected_new_sha NOT GLOB '*[^a-f0-9]*'),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 67108864),
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(expected_old_sha <> expected_new_sha),
  CHECK(length(payload) = payload_bytes)
);

-- table: pipeline_task_branches
CREATE TABLE pipeline_task_branches (
  pipeline_instance_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^a-f0-9]*'),
  lineage TEXT NOT NULL UNIQUE CHECK(length(lineage) = 64 AND lineage NOT GLOB '*[^a-f0-9]*'),
  base_sha TEXT NOT NULL CHECK(length(base_sha) = 40 AND base_sha NOT GLOB '*[^a-f0-9]*'),
  accepted_integration_sha TEXT CHECK(accepted_integration_sha IS NULL OR (length(accepted_integration_sha) = 40 AND accepted_integration_sha NOT GLOB '*[^a-f0-9]*')),
  acknowledged_remote_sha TEXT CHECK(acknowledged_remote_sha IS NULL OR (length(acknowledged_remote_sha) = 40 AND acknowledged_remote_sha NOT GLOB '*[^a-f0-9]*')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'reserved', 'checkpointed', 'published', 'failed')),
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
  UNIQUE(repository, branch),
  UNIQUE(pipeline_instance_id, generation, lineage)
);

-- table: provider_events
CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
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

-- table: repository_config_snapshots
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

-- table: repository_registrations
CREATE TABLE repository_registrations (
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

-- table: run_outcomes
CREATE TABLE run_outcomes (
  pipeline_instance_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
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
  FOREIGN KEY(ticket_id) REFERENCES tickets(ticket_id) ON DELETE RESTRICT
);

-- table: runs
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  session_id TEXT,
  session_generation INTEGER,
  task_type TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  exit_code INTEGER,
  cost_usd REAL,
  pr_url TEXT,
  failure_tail TEXT,
  log_tail TEXT, actor_state TEXT CHECK(actor_state IS NULL OR actor_state IN ('running', 'reaping', 'quarantined', 'settled')), last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT, termination_confirmed_at TEXT, quarantine_reason TEXT, fault_attribution TEXT CHECK(
  fault_attribution IS NULL OR fault_attribution IN ('executor', 'agent', 'provider', 'unknown')
),
  FOREIGN KEY(ticket_id) REFERENCES tickets(ticket_id)
);

-- table: runtime_capability_descriptors
CREATE TABLE runtime_capability_descriptors (
  runtime_release TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  protocol TEXT NOT NULL,
  normalized_descriptor TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE(runtime_release, digest)
);

-- table: sandbox_events
CREATE TABLE sandbox_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,
  ingestion_diagnosed_at TEXT,
  schema_epoch INTEGER NOT NULL DEFAULT 1 CHECK(schema_epoch = 1),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

-- table: settings
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

-- table: steering_items
CREATE TABLE steering_items (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('human', 'operator')),
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'acknowledged', 'canceled')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  delivery_id TEXT UNIQUE,
  request_hash TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  native_session_id TEXT,
  lease_until TEXT,
  FOREIGN KEY(ticket_id) REFERENCES tickets(ticket_id) ON DELETE RESTRICT
);

-- table: supervisor_leases
CREATE TABLE supervisor_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- table: supervisor_maintenance
CREATE TABLE supervisor_maintenance (
  key TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- table: tickets
CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY,
  ticket_reference TEXT NOT NULL,
  session_id TEXT NOT NULL,
  control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github')),
  external_thread_id TEXT,
  external_thread_reference TEXT,
  sandbox_id TEXT,
  branch TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude',
  repo TEXT NOT NULL,
  pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  running_since TEXT,
  run_id TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  context TEXT,
  base_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- table: tune_state
CREATE TABLE tune_state (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_digest TEXT NOT NULL UNIQUE,
  citation_decision_digest TEXT NOT NULL,
  ratchet_decision_digest TEXT NOT NULL,
  edit_authorization_digest TEXT NOT NULL,
  release_descriptor_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'needs_human')),
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- table: webhook_deliveries
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  event_name TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'processed',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  processed_at TEXT,
  last_error TEXT,
  redelivered_at TEXT,
  schema_epoch INTEGER NOT NULL DEFAULT 1 CHECK(schema_epoch = 1),
  received_at TEXT NOT NULL
);

-- index: agent_sessions_current_issue_idx
CREATE UNIQUE INDEX agent_sessions_current_issue_idx
  ON agent_sessions(ticket_id)
  WHERE state = 'current';

-- index: agent_sessions_identity_idx
CREATE UNIQUE INDEX agent_sessions_identity_idx
  ON agent_sessions(id, ticket_id, generation);

-- index: agent_sessions_issue_generation_idx
CREATE INDEX agent_sessions_issue_generation_idx
  ON agent_sessions(ticket_id, generation);

-- index: agent_sessions_pipeline_instance_unique
CREATE UNIQUE INDEX agent_sessions_pipeline_instance_unique
        ON agent_sessions(pipeline_instance_id) WHERE pipeline_instance_id IS NOT NULL;

-- index: citation_gate_receipts_created_idx
CREATE INDEX citation_gate_receipts_created_idx
  ON citation_gate_receipts(created_at, proposal_id);

-- index: control_outbox_process_idx
CREATE INDEX control_outbox_process_idx
        ON control_outbox(status, next_attempt_at);

-- index: control_outbox_session_order_idx
CREATE INDEX control_outbox_session_order_idx
        ON control_outbox(session_id, sequence);

-- index: deployment_cutovers_open_idx
CREATE UNIQUE INDEX deployment_cutovers_open_idx
  ON deployment_cutovers((1))
  WHERE status IN ('active', 'recovery_required');

-- index: execution_downstream_context_target_idx
CREATE INDEX execution_downstream_context_target_idx
  ON execution_downstream_context(parent_attempt_id, to_unit_id, created_at);

-- index: execution_gate_receipts_parent_idx
CREATE INDEX execution_gate_receipts_parent_idx
  ON execution_gate_receipts(parent_attempt_id, unit_id, created_at);

-- index: execution_graphs_instance_idx
CREATE INDEX execution_graphs_instance_idx
  ON execution_graphs(pipeline_instance_id, updated_at DESC, created_at DESC, id DESC);

-- index: execution_units_graph_status_idx
CREATE INDEX execution_units_graph_status_idx
  ON execution_units(execution_graph_id, authored_order, unit_id);

-- index: execution_units_one_running_idx
CREATE UNIQUE INDEX execution_units_one_running_idx
  ON execution_units(parent_attempt_id) WHERE status = 'running';

-- index: execution_units_ready_idx
CREATE INDEX execution_units_ready_idx
  ON execution_units(parent_attempt_id, status, authored_order, unit_id);

-- index: execution_work_attempts_pipeline_instance_idx
CREATE INDEX execution_work_attempts_pipeline_instance_idx
  ON execution_work_attempts(pipeline_instance_id);

-- index: execution_work_checkpoint_effect_idx
CREATE UNIQUE INDEX execution_work_checkpoint_effect_idx
  ON execution_work_attempts(checkpoint_effect_id) WHERE checkpoint_effect_id IS NOT NULL;

-- index: execution_work_checkpoint_status_idx
CREATE INDEX execution_work_checkpoint_status_idx
  ON execution_work_attempts(parent_attempt_id, checkpoint_status, completed_at);

-- index: execution_work_claim_idx
CREATE INDEX execution_work_claim_idx
  ON execution_work_attempts(parent_attempt_id, status, lease_until, created_at);

-- index: execution_work_one_active_idx
CREATE UNIQUE INDEX execution_work_one_active_idx
  ON execution_work_attempts(parent_attempt_id)
  WHERE status IN ('leased', 'dispatched', 'running');

-- index: feedback_snapshots_collecting_unique
CREATE UNIQUE INDEX feedback_snapshots_collecting_unique
  ON feedback_snapshots(ticket_id, session_id, generation, head_sha)
  WHERE status = 'collecting';

-- index: feedback_snapshots_pending_session_idx
CREATE INDEX feedback_snapshots_pending_session_idx
  ON feedback_snapshots(session_id, created_at, id)
  WHERE status IN ('collecting', 'claimed');

-- index: feedback_snapshots_work_item_unique
CREATE UNIQUE INDEX feedback_snapshots_work_item_unique
  ON feedback_snapshots(work_item_id)
  WHERE work_item_id IS NOT NULL;

-- index: github_webhook_redelivery_process_idx
CREATE INDEX github_webhook_redelivery_process_idx
  ON github_webhook_redelivery_requests(status, next_attempt_at);

-- index: orchestration_journal_issue_lower_recorded_idx
CREATE INDEX orchestration_journal_issue_lower_recorded_idx
  ON orchestration_journal(lower(issue), recorded_at);

-- index: orchestration_journal_issue_recorded_idx
CREATE INDEX orchestration_journal_issue_recorded_idx
  ON orchestration_journal(issue, recorded_at);

-- index: orchestration_journal_repository_lower_recorded_idx
CREATE INDEX orchestration_journal_repository_lower_recorded_idx
  ON orchestration_journal(lower(repository), recorded_at);

-- index: orchestration_journal_repository_recorded_idx
CREATE INDEX orchestration_journal_repository_recorded_idx
  ON orchestration_journal(repository, recorded_at);

-- index: pipeline_artifacts_admission_detail_idx
CREATE INDEX pipeline_artifacts_admission_detail_idx
ON pipeline_artifacts(pipeline_instance_id, artifact_hash, kind, assurance);

-- index: pipeline_attempts_planned_run_unique
CREATE UNIQUE INDEX pipeline_attempts_planned_run_unique
  ON pipeline_stage_attempts(planned_run_id) WHERE planned_run_id IS NOT NULL;

-- index: pipeline_attempts_status_idx
CREATE INDEX pipeline_attempts_status_idx ON pipeline_stage_attempts(status, updated_at);

-- index: pipeline_effects_pending_idx
CREATE INDEX pipeline_effects_pending_idx
  ON pipeline_effect_intents(status, next_attempt_at);

-- index: pipeline_inbox_pending_idx
CREATE INDEX pipeline_inbox_pending_idx ON pipeline_inbox_events(pipeline_instance_id, status, created_at);

-- index: pipeline_instances_runtime_resource_unique
CREATE UNIQUE INDEX pipeline_instances_runtime_resource_unique
  ON pipeline_instances(runtime_provider_resource_id) WHERE runtime_provider_resource_id IS NOT NULL;

-- index: pipeline_instances_status_idx
CREATE INDEX pipeline_instances_status_idx ON pipeline_instances(status, updated_at);

-- index: pipeline_publications_process_idx
CREATE INDEX pipeline_publications_process_idx
  ON pipeline_publication_receipts(kind, status, next_attempt_at);

-- index: pipeline_task_branches_status_idx
CREATE INDEX pipeline_task_branches_status_idx
  ON pipeline_task_branches(status, updated_at);

-- index: provider_events_feedback_snapshot_order_idx
CREATE INDEX provider_events_feedback_snapshot_order_idx
  ON provider_events(snapshot_id, received_at, provider, provider_event_id);

-- index: provider_events_snapshot_idx
CREATE INDEX provider_events_snapshot_idx
  ON provider_events(ticket_id, generation, head_sha, snapshot_id, received_at);

-- index: repository_registrations_linear_team_id_idx
CREATE UNIQUE INDEX repository_registrations_linear_team_id_idx
        ON repository_registrations(linear_team_id)
        WHERE control_provider = 'linear' AND linear_team_id IS NOT NULL;

-- index: repository_registrations_linear_team_key_idx
CREATE UNIQUE INDEX repository_registrations_linear_team_key_idx
        ON repository_registrations(linear_team_key)
        WHERE control_provider = 'linear' AND linear_team_key IS NOT NULL;

-- index: run_outcomes_created_idx
CREATE INDEX run_outcomes_created_idx ON run_outcomes(created_at);

-- index: run_outcomes_ticket_idx
CREATE INDEX run_outcomes_ticket_idx
        ON run_outcomes(ticket_id, created_at DESC);

-- index: runs_actor_state_idx
CREATE INDEX runs_actor_state_idx ON runs(actor_state, last_heartbeat_at);

-- index: runs_expiry_idx
CREATE INDEX runs_expiry_idx ON runs(status, expires_at);

-- index: runs_linear_issue_idx
CREATE INDEX runs_linear_issue_idx ON runs(ticket_id, started_at);

-- index: runs_session_idx
CREATE INDEX runs_session_idx ON runs(session_id, session_generation);

-- index: sandbox_events_process_idx
CREATE INDEX sandbox_events_process_idx
  ON sandbox_events(status, next_attempt_at);

-- index: sandbox_events_run_liveness_idx
CREATE INDEX sandbox_events_run_liveness_idx
  ON sandbox_events(run_id, kind, created_at);

-- index: steering_items_delivery_idx
CREATE INDEX steering_items_delivery_idx
  ON steering_items(ticket_id, status, created_at, id);

-- index: steering_items_run_settlement_idx
CREATE INDEX steering_items_run_settlement_idx
  ON steering_items(run_id)
  WHERE status IN ('pending', 'dispatched');

-- index: tickets_repo_branch_idx
CREATE INDEX tickets_repo_branch_idx ON tickets(repo, branch);

-- index: tickets_sandbox_idx
CREATE INDEX tickets_sandbox_idx ON tickets(sandbox_id);

-- index: tune_state_intent_idx
CREATE INDEX tune_state_intent_idx ON tune_state(intent_digest, created_at);

-- index: webhook_deliveries_process_idx
CREATE INDEX webhook_deliveries_process_idx ON webhook_deliveries(status, next_attempt_at);

-- index: webhook_deliveries_received_idx
CREATE INDEX webhook_deliveries_received_idx
  ON webhook_deliveries(received_at);

-- trigger: execution_graphs_parent_attempt_run_insert_fence
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

-- trigger: execution_graphs_parent_attempt_run_update_fence
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
`;

export function applyBaseSchema(db: Database.Database): void {
  db.exec(schema);
}
