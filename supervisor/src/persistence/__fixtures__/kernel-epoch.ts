import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptState, PipelineTerminalOutcome } from "@openthrottle/contracts";
import { VolumeBlobStore } from "../blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
} from "../epoch-database.js";
import { KERNEL_INGRESS_MAINTENANCE_SETTING } from "../epoch-schema.js";

export const KERNEL_FIXTURE_NOW = "2026-08-20T12:00:00.000Z";
export const KERNEL_FIXTURE_SUBJECT = "1".repeat(40);
export const KERNEL_FIXTURE_REQUEST_HASH = "a".repeat(64);
export const KERNEL_FIXTURE_BUNDLE_HASH = "b".repeat(64);

export interface FreshKernelFixture {
  directory: string;
  db: Database.Database;
  blobs: VolumeBlobStore;
  cleanup(): void;
}

export function freshKernelFixture(): FreshKernelFixture {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-kernel-u11-"));
  const blobs = VolumeBlobStore.initialize(join(directory, "blobs"), "kernel-u11-test");
  const db = initializeFreshEpochDatabase({
    database_path: join(directory, "epoch.sqlite"),
    blob_store: blobs,
    release_id: "kernel-u11-release",
    runtime_capability_digest: "c".repeat(64),
    bootstrap: createFreshEpochBootstrap({
      schema: "openthrottle.fresh-epoch-bootstrap/v1",
      settings: [],
      repository_registrations: [{
        id: "repo",
        control_provider: "linear",
        route_key: "team",
        linear_team_id: "team",
        linear_team_key: "OPE",
        github_repo: "owner/repo",
        github_installation_id: 1,
        base_branch: "main",
        webhook_id: 1,
        runtime_snapshot: "snapshot",
      }],
    }),
    now: () => KERNEL_FIXTURE_NOW,
  });
  const opened = db.prepare(`
    UPDATE settings
    SET value_json = 'false', version = version + 1, updated_at = ?
    WHERE key = ? AND value_json = 'true' AND mutable = 1 AND version = 0
  `).run(KERNEL_FIXTURE_NOW, KERNEL_INGRESS_MAINTENANCE_SETTING);
  if (opened.changes !== 1) throw new Error("fresh kernel fixture could not open ingress");
  return {
    directory,
    db,
    blobs,
    cleanup() {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function seedKernelRun(input: {
  db: Database.Database;
  run_id?: string;
  work_item_id?: string;
  status?: "pending" | "running" | PipelineTerminalOutcome;
  terminal_outcome?: PipelineTerminalOutcome | null;
}): { run_id: string; work_item_id: string } {
  const runId = input.run_id ?? "run-1";
  const workItemId = input.work_item_id ?? `work-${runId}`;
  const status = input.status ?? "running";
  const terminalOutcome = input.terminal_outcome ?? (
    status === "pending" || status === "running" ? null : status
  );
  const workItemState = terminalOutcome === null
    ? "active"
    : terminalOutcome === "completed" || terminalOutcome === "no_change"
      ? "completed"
      : terminalOutcome;
  input.db.prepare(`
    INSERT INTO work_items (
      id, repository_registration_id, source_provider, source_id, source_reference,
      state, title, request_payload_schema, request_inline_json, version, created_at, updated_at
    ) VALUES (?, 'repo', 'linear', ?, ?, ?, ?, 'openthrottle.kernel-work-request/v1',
      ?, 0, ?, ?)
  `).run(
    workItemId,
    `source-${runId}`,
    `OPE-${runId}`,
    workItemState,
    `Work for ${runId}`,
    JSON.stringify({
      schema: "openthrottle.kernel-work-request/v1",
      task_prompt: `Task for ${runId}`,
    }),
    KERNEL_FIXTURE_NOW,
    KERNEL_FIXTURE_NOW,
  );
  input.db.prepare(`
    INSERT INTO pipeline_runs (
      id, work_item_id, pipeline_id, definition_bundle_algorithm,
      definition_bundle_hash, definition_bundle_bytes, definition_bundle_encoding,
      definition_bundle_media_type, definition_bundle_payload_schema, current_subject,
      status, terminal_outcome, cursor_stage_id, cursor_version, cursor_reentries_json,
      cursor_frontier_json, cursor_completed_scope_keys_json, cursor_barrier_json,
      version, work_retry_limit, result_correction_limit, created_at, updated_at
    ) VALUES (?, ?, 'core/implement', 'sha256', ?, 2, 'utf-8', 'application/json',
      'openthrottle.definition-bundle/v1', ?, ?, ?, ?, 0, '{}', '[]', '[]', NULL,
      0, 2, 2, ?, ?)
  `).run(
    runId,
    workItemId,
    KERNEL_FIXTURE_BUNDLE_HASH,
    KERNEL_FIXTURE_SUBJECT,
    status,
    terminalOutcome,
    terminalOutcome === null ? "implement" : null,
    KERNEL_FIXTURE_NOW,
    KERNEL_FIXTURE_NOW,
  );
  return { run_id: runId, work_item_id: workItemId };
}

export function seedKernelAttempt(input: {
  db: Database.Database;
  run_id?: string;
  id: string;
  status: AttemptState;
  stage_id?: string;
  version?: number;
  native_session_id?: string | null;
  lease?: {
    id: string;
    generation?: number;
    worker_id: string;
    purpose: "work" | "result_correction";
    expires_at: string;
    started: boolean;
  } | null;
}): void {
  const resultPending = input.status === "result_pending";
  const nativeSessionId = input.native_session_id ?? (resultPending ? `session-${input.id}` : null);
  const lease = input.lease ?? null;
  const runId = input.run_id ?? "run-1";
  const decisionRecordId = input.status === "settled" ? `decision-${input.id}` : null;
  if (decisionRecordId !== null) {
    const sequence = input.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM records WHERE pipeline_run_id = ?
    `).get(runId) as { sequence: number };
    input.db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
        payload_schema, inline_payload, reducer, input_record_ids_json,
        input_record_count, created_at
      ) VALUES (?, ?, ?, ?, 'decision', ?, 'fixture/decision@1', '{}',
        'fixture/settled@1', '[]', 0, ?)
    `).run(
      decisionRecordId,
      runId,
      sequence.sequence,
      "f".repeat(64),
      `fixture:settled:${input.id}`,
      KERNEL_FIXTURE_NOW,
    );
  }
  input.db.prepare(`
    INSERT INTO attempts (
      id, pipeline_run_id, scope_kind, stage_id, repository_authority, request_hash,
      definition_bundle_hash, input_subject, context_record_ids_json,
      context_checkpoint_ids_json, native_session_id, status, version,
      work_retry_ordinal, result_correction_count, result_correction_deadline,
      unmet_dependency_count, lease_id, lease_generation, lease_worker_id, lease_purpose,
      lease_expires_at, lease_started, pending_candidate_hash,
      pending_diagnostics_json, decision_record_id, created_at, updated_at
    ) VALUES (?, ?, 'stage', ?, 'inspect', ?, ?, ?, '[]', '[]', ?, ?, ?, 0, ?, ?,
      0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    runId,
    input.stage_id ?? input.id,
    KERNEL_FIXTURE_REQUEST_HASH,
    KERNEL_FIXTURE_BUNDLE_HASH,
    KERNEL_FIXTURE_SUBJECT,
    nativeSessionId,
    input.status,
    input.version ?? 0,
    resultPending ? 1 : 0,
    resultPending ? "2026-08-20T13:00:00.000Z" : null,
    lease?.id ?? null,
    lease ? (lease.generation ?? 0) : null,
    lease?.worker_id ?? null,
    lease?.purpose ?? null,
    lease?.expires_at ?? null,
    lease ? (lease.started ? 1 : 0) : null,
    resultPending ? "d".repeat(64) : null,
    resultPending ? JSON.stringify([{ path: "/payload/summary", detail: "invalid" }]) : null,
    decisionRecordId,
    KERNEL_FIXTURE_NOW,
    KERNEL_FIXTURE_NOW,
  );
}
