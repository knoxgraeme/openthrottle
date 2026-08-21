import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyFreshEpochSchema, FRESH_EPOCH_TABLES } from "./epoch-schema.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const OTHER_HASH = "c".repeat(64);

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyFreshEpochSchema(db, NOW);
  return db;
}

function seedRun(db: Database.Database): void {
  db.prepare(`
    INSERT INTO repository_registrations (
      id, control_provider, route_key, linear_team_id, linear_team_key,
      github_repo, github_installation_id, base_branch, webhook_id,
      runtime_snapshot, version, created_at, updated_at
    ) VALUES ('repo', 'linear', 'team', 'team', 'OPE', 'owner/repo', 1, 'main', 1, 'snapshot', 0, ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO work_items (
      id, repository_registration_id, source_provider, source_id, source_reference,
      state, title, request_payload_schema, request_inline_json, version, created_at, updated_at
    ) VALUES ('work', 'repo', 'linear', 'issue', 'OPE-1', 'active', 'Work', 'work/v1', '{}', 0, ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO pipeline_runs (
      id, work_item_id, pipeline_id,
      definition_bundle_algorithm, definition_bundle_hash, definition_bundle_bytes,
      definition_bundle_encoding, definition_bundle_media_type, definition_bundle_payload_schema,
      current_subject, status, terminal_outcome, cursor_stage_id, cursor_version,
      cursor_reentries_json, cursor_frontier_json, cursor_completed_scope_keys_json,
      cursor_barrier_json, version, work_retry_limit, result_correction_limit,
      created_at, updated_at
    ) VALUES (
      'run', 'work', 'core/structured', 'sha256', ?, 10, 'utf-8', 'application/json',
      'openthrottle.definition-bundle/v1', ?, 'running', NULL, 'implement', 0,
      '{}', '[]', '[]', NULL, 0, 2, 2, ?, ?
    )
  `).run(HASH, SHA, NOW, NOW);
  db.prepare(`
    INSERT INTO attempts (
      id, pipeline_run_id, scope_kind, stage_id, repository_authority,
      request_hash, definition_bundle_hash, input_subject,
      context_record_ids_json, context_checkpoint_ids_json, status, version,
      work_retry_ordinal, result_correction_count, unmet_dependency_count,
      created_at, updated_at
    ) VALUES ('attempt-1', 'run', 'stage', 'implement', 'edit', ?, ?, ?, '[]', '[]', 'work_complete', 0, 0, 0, 0, ?, ?)
  `).run(OTHER_HASH, HASH, SHA, NOW, NOW);
}

function insertResult(db: Database.Database, id = "result-1", attemptId = "attempt-1"): void {
  db.prepare(`
    INSERT INTO records (
      id, pipeline_run_id, sequence, record_hash, kind, payload_schema, inline_payload,
      attempt_id, request_hash, definition_bundle_hash, input_subject, output_subject,
      original_candidate_hash, normalized_candidate_hash, created_at
    ) VALUES (?, 'run', 1, ?, 'result', 'result/v1', '{}', ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(id, HASH, attemptId, OTHER_HASH, HASH, SHA, HASH, HASH, NOW);
}

describe("fresh epoch schema ownership", () => {
  it("does not let INSERT OR REPLACE bypass immutable settings", () => {
    const db = database();
    try {
      const insert = db.prepare(`
        INSERT INTO settings (key, value_json, value_type, mutable, version, updated_at)
        VALUES (?, ?, 'string', ?, 0, ?)
      `);
      insert.run("immutable", '"original"', 0, NOW);
      insert.run("mutable", '"original"', 1, NOW);

      expect(() => db.prepare(`
        INSERT OR REPLACE INTO settings (key, value_json, value_type, mutable, version, updated_at)
        VALUES ('immutable', '"replaced"', 'string', 0, 1, ?)
      `).run(NOW)).toThrow(/immutable setting/);
      expect(db.prepare("SELECT value_json FROM settings WHERE key = 'immutable'").get())
        .toEqual({ value_json: '"original"' });

      db.prepare(`
        INSERT OR REPLACE INTO settings (key, value_json, value_type, mutable, version, updated_at)
        VALUES ('mutable', '"replaced"', 'string', 1, 1, ?)
      `).run(NOW);
      expect(db.prepare("SELECT value_json FROM settings WHERE key = 'mutable'").get())
        .toEqual({ value_json: '"replaced"' });
    } finally {
      db.close();
    }
  });

  it("owns exactly twelve tables and keeps definitions to the five-field composite identity", () => {
    const db = database();
    try {
      const tables = (db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([...FRESH_EPOCH_TABLES].sort());
      const definitionColumns = db.pragma("table_info(definitions)") as Array<{
        name: string;
        pk: number;
      }>;
      expect(definitionColumns.map((column) => column.name)).toEqual([
        "definition_kind", "definition_id", "source_commit", "content_hash", "normalized_payload",
      ]);
      expect(definitionColumns.map((column) => column.pk)).toEqual([0, 0, 0, 0, 0]);
      const identityIndex = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'definitions_identity_idx'
      `).get() as { sql: string };
      expect(identityIndex.sql).toContain("ifnull(source_commit, '')");
      const inboxGroupIndex = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'inbox_events_group_idx'
      `).get() as { sql: string };
      expect(inboxGroupIndex.sql.replace(/\s+/g, " ")).toContain(
        "source_provider, event_group_key, delivery_attempt, created_at, id",
      );

      const insert = db.prepare(`
        INSERT INTO definitions (
          definition_kind, definition_id, source_commit, content_hash, normalized_payload
        ) VALUES ('skill', ?, ?, ?, ?)
      `);
      insert.run("review", SHA, HASH, "{}");
      insert.run("other", SHA, HASH, "{}");
      insert.run("review", "c".repeat(40), HASH, "{}");
      insert.run("review", SHA, HASH, '{"changed":true}');
      insert.run("platform", null, HASH, "{}");
      insert.run("platform", SHA, HASH, "{}");
      expect(() => insert.run("platform", null, HASH, "{}")).toThrow(/UNIQUE constraint/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM definitions").get()).toEqual({ count: 6 });
    } finally {
      db.close();
    }
  });

  it("enforces relational attempt-scope, correction, dependency, and lease unions", () => {
    const db = database();
    try {
      seedRun(db);
      expect(() => db.prepare(`
        INSERT INTO attempts (
          id, pipeline_run_id, scope_kind, stage_id, parent_attempt_id,
          repository_authority, request_hash, definition_bundle_hash, input_subject,
          context_record_ids_json, context_checkpoint_ids_json,
          status, version, work_retry_ordinal, result_correction_count,
          unmet_dependency_count, created_at, updated_at
        ) VALUES ('bad-scope', 'run', 'stage', 'implement', 'attempt-1', 'inspect', ?, ?, ?, '[]', '[]',
          'pending', 0, 0, 0, 0, ?, ?)
      `).run(OTHER_HASH, HASH, SHA, NOW, NOW)).toThrow(/CHECK constraint/);
      expect(() => db.prepare(`
        INSERT INTO attempts (
          id, pipeline_run_id, scope_kind, stage_id, repository_authority,
          request_hash, definition_bundle_hash, input_subject, native_session_id,
          context_record_ids_json, context_checkpoint_ids_json,
          status, version, work_retry_ordinal, result_correction_count,
          result_correction_deadline, unmet_dependency_count,
          lease_id, lease_generation, lease_worker_id, lease_purpose, lease_expires_at, lease_started,
          created_at, updated_at
        ) VALUES ('bad-lease', 'run', 'stage', 'implement', 'inspect', ?, ?, ?, NULL, '[]', '[]',
          'pending', 0, 0, 0, ?, 0, 'lease', 0, NULL, 'work', ?, 0, ?, ?)
      `).run(OTHER_HASH, HASH, SHA, NOW, NOW, NOW, NOW)).toThrow(/CHECK constraint/);
    } finally {
      db.close();
    }
  });

  it("enforces payload XOR and unique typed Result and Delivery owners", () => {
    const db = database();
    try {
      seedRun(db);
      insertResult(db);
      expect(() => insertResult(db, "result-2")).toThrow(/UNIQUE constraint/);
      expect(() => db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
          inline_payload, blob_algorithm, blob_digest, blob_bytes, blob_encoding,
          blob_media_type, blob_payload_schema, reducer, input_record_ids_json,
          input_record_count, created_at
        ) VALUES (
          'bad-xor', 'run', 2, ?, 'decision', 'decision/v1', '{}', 'sha256', ?, 2,
          'utf-8', 'application/json', 'decision/v1', 'kernel', '[]', 0, ?
        )
      `).run(HASH, HASH, NOW)).toThrow(/CHECK constraint/);

      db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
          payload_schema, inline_payload, reducer, input_record_ids_json,
          input_record_count, created_at
        ) VALUES ('decision-1', 'run', 2, ?, 'decision', 'skill:review',
          'decision/v1', '{}', 'kernel', '["result-1"]', 1, ?)
      `).run(OTHER_HASH, NOW);
      db.prepare(`
        INSERT INTO effects (
          id, pipeline_run_id, decision_record_id, kind, idempotency_key,
          target, payload_schema, inline_payload, intent_hash,
          status, version, available_at, created_at, updated_at
        ) VALUES ('effect-1', 'run', 'decision-1', 'github.publish@1', 'idem-1',
          'owner/repo#1', 'effect/v1', '{}', ?, 'pending', 0, ?, ?, ?)
      `).run(HASH, NOW, NOW, NOW);
      db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, payload_schema, inline_payload,
          effect_id, idempotency_key, external_identity, delivery_status, created_at
        ) VALUES ('delivery-1', 'run', 3, ?, 'delivery', 'delivery/v1', '{}',
          'effect-1', 'idem-1', 'owner/repo#1', 'confirmed', ?)
      `).run(HASH, NOW);
      expect(() => db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, payload_schema, inline_payload,
          effect_id, idempotency_key, external_identity, delivery_status, created_at
        ) VALUES ('delivery-2', 'run', 4, ?, 'delivery', 'delivery/v1', '{}',
          'effect-1', 'idem-1', 'owner/repo#1', 'confirmed', ?)
      `).run(OTHER_HASH, NOW)).toThrow(/UNIQUE constraint/);
    } finally {
      db.close();
    }
  });

  it("allows ordinal checkpoints to reuse a semantic key without collapsing history", () => {
    const db = database();
    try {
      seedRun(db);
      db.prepare(`
        INSERT INTO attempts (
          id, pipeline_run_id, scope_kind, stage_id, repository_authority,
          request_hash, definition_bundle_hash, input_subject,
          context_record_ids_json, context_checkpoint_ids_json, status, version,
          work_retry_ordinal, result_correction_count, unmet_dependency_count,
          created_at, updated_at
        ) VALUES ('attempt-2', 'run', 'stage', 'implement', 'inspect', ?, ?, ?, '[]', '[]',
          'work_complete', 0, 0, 0, 0, ?, ?)
      `).run(HASH, HASH, SHA, NOW, NOW);
      const insert = db.prepare(`
        INSERT INTO checkpoints (
          id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
          request_hash, definition_bundle_hash, input_subject, payload_schema,
          inline_payload, captured_at
        ) VALUES (?, 'run', ?, 0, ?, 'native-session', ?, ?, ?, 'checkpoint/v1', '{}', ?)
      `);
      insert.run("checkpoint-1", "attempt-1", HASH, OTHER_HASH, HASH, SHA, NOW);
      insert.run("checkpoint-2", "attempt-2", OTHER_HASH, HASH, HASH, SHA, NOW);
      expect(db.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE semantic_key = 'native-session'").get())
        .toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("binds attempt and effect pointers to the exact record kind and owner", () => {
    const db = database();
    try {
      seedRun(db);
      db.prepare(`
        INSERT INTO attempts (
          id, pipeline_run_id, scope_kind, stage_id, repository_authority,
          request_hash, definition_bundle_hash, input_subject,
          context_record_ids_json, context_checkpoint_ids_json, status, version,
          work_retry_ordinal, result_correction_count, unmet_dependency_count,
          created_at, updated_at
        ) VALUES ('attempt-2', 'run', 'stage', 'verify', 'inspect', ?, ?, ?, '[]', '[]',
          'work_complete', 0, 0, 0, 0, ?, ?)
      `).run(OTHER_HASH, HASH, SHA, NOW, NOW);
      insertResult(db, "result-2", "attempt-2");
      db.prepare(`
        INSERT INTO records (
          id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
          inline_payload, reducer, input_record_ids_json, input_record_count, created_at
        ) VALUES ('decision-1', 'run', 2, ?, 'decision', 'decision/v1', '{}',
          'kernel', '["result-2"]', 1, ?)
      `).run(OTHER_HASH, NOW);
      db.prepare(`
        INSERT INTO checkpoints (
          id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
          request_hash, definition_bundle_hash, input_subject, payload_schema,
          inline_payload, captured_at
        ) VALUES ('checkpoint-2', 'run', 'attempt-2', 0, ?, 'attempt-2:0', ?, ?, ?,
          'checkpoint/v1', '{}', ?)
      `).run(HASH, OTHER_HASH, HASH, SHA, NOW);
      db.prepare(`
        INSERT INTO effects (
          id, pipeline_run_id, decision_record_id, kind, idempotency_key,
          target, payload_schema, inline_payload, intent_hash,
          status, version, available_at, created_at, updated_at
        ) VALUES ('effect-1', 'run', 'decision-1', 'github.publish@1', 'idem-1',
          'owner/repo#1', 'effect/v1', '{}', ?, 'pending', 0, ?, ?, ?)
      `).run(HASH, NOW, NOW, NOW);

      expect(() => db.prepare(`
        UPDATE attempts SET status = 'recorded', result_record_id = 'result-2'
        WHERE id = 'attempt-1'
      `).run()).toThrow(/FOREIGN KEY constraint/);
      expect(() => db.prepare(`
        UPDATE attempts SET status = 'settled', decision_record_id = 'result-2'
        WHERE id = 'attempt-1'
      `).run()).toThrow(/FOREIGN KEY constraint/);
      expect(() => db.prepare(`
        UPDATE attempts SET checkpoint_id = 'checkpoint-2' WHERE id = 'attempt-1'
      `).run()).toThrow(/FOREIGN KEY constraint/);
      expect(() => db.prepare(`
        UPDATE effects SET status = 'acknowledged', delivery_record_id = 'result-2'
        WHERE id = 'effect-1'
      `).run()).toThrow(/FOREIGN KEY constraint/);
    } finally {
      db.close();
    }
  });
});
