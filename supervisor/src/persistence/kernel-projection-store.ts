import type Database from "better-sqlite3";
import type { AttemptState, PipelineTerminalOutcome } from "@openthrottle/contracts";
import { sanitizeText } from "../shared/sanitize.js";
import {
  ACTIVE_ATTEMPT_STATUSES,
  ACTIVE_EFFECT_STATUSES,
  ACTIVE_RUN_STATUSES,
} from "./kernel-active-statuses.js";

const ATTEMPT_STATUSES: readonly AttemptState[] = [
  "pending", "running", "work_complete", "result_pending", "recorded", "settled",
  "needs_human", "failed", "canceled", "superseded",
];
const EFFECT_STATUSES = [
  "pending", "processing", "unknown", "acknowledged", "rejected", "canceled", "failed",
] as const;
const RUNTIME_RESOURCE_EFFECT_KINDS = [
  "daytona/create-sandbox@1",
  "daytona/start-sandbox@1",
  "daytona/stop-sandbox@1",
  "daytona/cleanup-sandbox@1",
] as const;
const EFFECT_OPERATOR_ATTENTION_THRESHOLD = 24;

export type KernelProjectionWhoseMove = "working" | "waiting_on_operator" | "finished";

export interface KernelAttemptStatusProjection {
  id: string;
  scope_kind: "stage" | "loop_item" | "fanout_member";
  stage_id: string;
  status: AttemptState;
  repository_authority: "inspect" | "edit";
  input_subject: string;
  output_subject: string | null;
  native_session_bound: boolean;
  work_retry_ordinal: number;
  result_correction_count: number;
  result_correction_deadline: string | null;
  pending_diagnostic_count: number;
  lease_purpose: "work" | "result_correction" | null;
  lease_expires_at: string | null;
  updated_at: string;
}

export interface KernelEffectStatusProjection {
  id: string;
  kind: string;
  status: (typeof EFFECT_STATUSES)[number];
  target: string;
  subject: string | null;
  attempt_count: number;
  available_at: string;
  lease_expires_at: string | null;
  detail: string | null;
  updated_at: string;
}

export interface KernelStatusProjection {
  pipeline_run_id: string;
  work_item_id: string;
  source_provider: string;
  source_reference: string;
  title: string;
  pipeline_id: string;
  status: "pending" | "running" | PipelineTerminalOutcome;
  terminal_outcome: PipelineTerminalOutcome | null;
  stage_id: string | null;
  cursor_version: number;
  current_subject: string;
  definition_bundle_hash: string;
  whose_move: KernelProjectionWhoseMove;
  attempt_status_counts: Readonly<Record<AttemptState, number>>;
  effect_status_counts: Readonly<Record<(typeof EFFECT_STATUSES)[number], number>>;
  attempts: readonly KernelAttemptStatusProjection[];
  effects: readonly KernelEffectStatusProjection[];
  truncated: boolean;
  updated_at: string;
}

export type KernelLogKind =
  | "run"
  | "attempt"
  | "record"
  | "effect"
  | "checkpoint"
  | "inbox";

export interface KernelLogCursor {
  occurred_at: string;
  kind: KernelLogKind;
  id: string;
}

export interface KernelLogEntry extends KernelLogCursor {
  summary: string;
}

export interface KernelLogPage {
  entries: readonly KernelLogEntry[];
  next_cursor: KernelLogCursor | null;
  truncated: boolean;
}

export type KernelActiveWorkKind =
  | "run"
  | "attempt"
  | "correction"
  | "effect"
  | "lease"
  | "runtime_resource";

export interface KernelActiveWorkItem {
  key: string;
  kind: KernelActiveWorkKind;
  id: string;
  pipeline_run_id: string | null;
  status: string;
  detail: string;
  observed_at: string;
}

export interface KernelActiveWorkSnapshot {
  items: readonly KernelActiveWorkItem[];
  truncated: boolean;
}

export interface KernelProjectionPort {
  getStatus(pipelineRunId: string, detailLimit?: number): KernelStatusProjection | undefined;
  listLog(input: {
    pipeline_run_id: string;
    after?: KernelLogCursor;
    limit?: number;
  }): KernelLogPage;
}

export interface KernelActiveWorkProjectionPort {
  collectActiveWork(limit?: number): KernelActiveWorkSnapshot;
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`projection limit must be between 1 and ${maximum}`);
  }
  return candidate;
}

function counts<T extends string>(values: readonly T[], rows: Array<{ status: T; count: number }>): Record<T, number> {
  const result = Object.fromEntries(values.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) {
    if (!(row.status in result)) throw new Error(`persisted projection status ${row.status} is unknown`);
    result[row.status] = row.count;
  }
  return result;
}

function whoseMove(
  status: KernelStatusProjection["status"],
  effects: readonly Pick<KernelEffectStatusProjection, "status" | "attempt_count">[],
): KernelProjectionWhoseMove {
  if (status === "needs_human") return "waiting_on_operator";
  if (status !== "pending" && status !== "running") return "finished";
  // An indeterminate mutation must remain reconcile-only, but it must not be
  // silent forever. Keep automatic reconciliation active while making the
  // operator-visible projection change after a bounded number of observations.
  if (effects.some((effect) =>
    effect.status === "unknown" &&
    effect.attempt_count >= EFFECT_OPERATOR_ATTENTION_THRESHOLD
  )) return "waiting_on_operator";
  return "working";
}

function boundedDetail(value: string | null): string | null {
  return value === null ? null : sanitizeText(value).slice(0, 1_000);
}

export class SqliteKernelProjectionStore implements
  KernelProjectionPort,
  KernelActiveWorkProjectionPort {
  readonly #db: Database.Database;

  constructor(input: { db: Database.Database }) {
    this.#db = input.db;
  }

  getStatus(pipelineRunId: string, detailLimit = 50): KernelStatusProjection | undefined {
    const boundedLimit = limit(detailLimit, 50, 200);
    const run = this.#db.prepare(`
      SELECT r.*, w.id AS joined_work_item_id, w.source_provider, w.source_reference, w.title
      FROM pipeline_runs r JOIN work_items w ON w.id = r.work_item_id
      WHERE r.id = ?
    `).get(pipelineRunId) as {
      id: string;
      work_item_id: string;
      joined_work_item_id: string;
      source_provider: string;
      source_reference: string;
      title: string;
      pipeline_id: string;
      status: KernelStatusProjection["status"];
      terminal_outcome: PipelineTerminalOutcome | null;
      cursor_stage_id: string | null;
      cursor_version: number;
      current_subject: string;
      definition_bundle_hash: string;
      updated_at: string;
    } | undefined;
    if (!run) return undefined;
    if (run.work_item_id !== run.joined_work_item_id) {
      throw new Error(`pipeline run ${run.id} work-item projection is inconsistent`);
    }
    const attemptCounts = counts(ATTEMPT_STATUSES, this.#db.prepare(`
      SELECT status, COUNT(*) AS count FROM attempts
      WHERE pipeline_run_id = ? GROUP BY status
    `).all(run.id) as Array<{ status: AttemptState; count: number }>);
    const effectCounts = counts(EFFECT_STATUSES, this.#db.prepare(`
      SELECT status, COUNT(*) AS count FROM effects
      WHERE pipeline_run_id = ? GROUP BY status
    `).all(run.id) as Array<{
      status: (typeof EFFECT_STATUSES)[number];
      count: number;
    }>);
    const attemptRows = this.#db.prepare(`
      SELECT id, scope_kind, stage_id, status, repository_authority, input_subject,
        output_subject, native_session_id, work_retry_ordinal, result_correction_count,
        result_correction_deadline, pending_diagnostics_json, lease_purpose,
        lease_expires_at, updated_at
      FROM attempts WHERE pipeline_run_id = ?
      ORDER BY updated_at DESC, id LIMIT ?
    `).all(run.id, boundedLimit + 1) as Array<{
      id: string;
      scope_kind: KernelAttemptStatusProjection["scope_kind"];
      stage_id: string;
      status: AttemptState;
      repository_authority: "inspect" | "edit";
      input_subject: string;
      output_subject: string | null;
      native_session_id: string | null;
      work_retry_ordinal: number;
      result_correction_count: number;
      result_correction_deadline: string | null;
      pending_diagnostics_json: string | null;
      lease_purpose: "work" | "result_correction" | null;
      lease_expires_at: string | null;
      updated_at: string;
    }>;
    const effectRows = this.#db.prepare(`
      SELECT id, kind, status, target, subject, attempt_count, available_at,
        lease_expires_at, COALESCE(unknown_detail, last_error) AS detail, updated_at
      FROM effects WHERE pipeline_run_id = ?
      ORDER BY updated_at DESC, id LIMIT ?
    `).all(run.id, boundedLimit + 1) as Array<{
      id: string;
      kind: string;
      status: KernelEffectStatusProjection["status"];
      target: string;
      subject: string | null;
      attempt_count: number;
      available_at: string;
      lease_expires_at: string | null;
      detail: string | null;
      updated_at: string;
    }>;
    return {
      pipeline_run_id: run.id,
      work_item_id: run.work_item_id,
      source_provider: run.source_provider,
      source_reference: run.source_reference,
      title: run.title,
      pipeline_id: run.pipeline_id,
      status: run.status,
      terminal_outcome: run.terminal_outcome,
      stage_id: run.cursor_stage_id,
      cursor_version: run.cursor_version,
      current_subject: run.current_subject,
      definition_bundle_hash: run.definition_bundle_hash,
      whose_move: whoseMove(run.status, effectRows),
      attempt_status_counts: attemptCounts,
      effect_status_counts: effectCounts,
      attempts: attemptRows.slice(0, boundedLimit).map((row) => ({
        id: row.id,
        scope_kind: row.scope_kind,
        stage_id: row.stage_id,
        status: row.status,
        repository_authority: row.repository_authority,
        input_subject: row.input_subject,
        output_subject: row.output_subject,
        native_session_bound: row.native_session_id !== null,
        work_retry_ordinal: row.work_retry_ordinal,
        result_correction_count: row.result_correction_count,
        result_correction_deadline: row.result_correction_deadline,
        pending_diagnostic_count: row.pending_diagnostics_json === null
          ? 0
          : (() => {
            const parsed: unknown = JSON.parse(row.pending_diagnostics_json);
            const pending = Array.isArray(parsed) ? { diagnostics: parsed } : parsed;
            if (!pending || typeof pending !== "object" || Array.isArray(pending) ||
                !Array.isArray((pending as { diagnostics?: unknown }).diagnostics)) {
              throw new Error(`attempt ${row.id} pending diagnostics are not an array`);
            }
            return (pending as { diagnostics: unknown[] }).diagnostics.length;
          })(),
        lease_purpose: row.lease_purpose,
        lease_expires_at: row.lease_expires_at,
        updated_at: row.updated_at,
      })),
      effects: effectRows.slice(0, boundedLimit).map((row) => ({
        ...row,
        detail: boundedDetail(row.detail),
      })),
      truncated: attemptRows.length > boundedLimit || effectRows.length > boundedLimit,
      updated_at: run.updated_at,
    };
  }

  listLog(input: {
    pipeline_run_id: string;
    after?: KernelLogCursor;
    limit?: number;
  }): KernelLogPage {
    const boundedLimit = limit(input.limit, 100, 500);
    const after = input.after ?? {
      occurred_at: "0000-01-01T00:00:00.000Z",
      kind: "run" as const,
      id: "",
    };
    const rows = this.#db.prepare(`
      SELECT * FROM (
        SELECT updated_at AS occurred_at, 'run' AS kind, id,
          'status=' || status || ' stage=' || COALESCE(cursor_stage_id, 'terminal') AS summary
        FROM pipeline_runs WHERE id = ?
        UNION ALL
        SELECT updated_at, 'attempt', id,
          'stage=' || stage_id || ' status=' || status || ' authority=' || repository_authority
        FROM attempts WHERE pipeline_run_id = ?
        UNION ALL
        SELECT created_at, 'record', id,
          'kind=' || kind || ' schema=' || payload_schema
        FROM records WHERE pipeline_run_id = ?
        UNION ALL
        SELECT updated_at, 'effect', id,
          'kind=' || kind || ' status=' || status
        FROM effects WHERE pipeline_run_id = ?
        UNION ALL
        SELECT captured_at, 'checkpoint', id,
          'schema=' || payload_schema
        FROM checkpoints WHERE pipeline_run_id = ?
        UNION ALL
        SELECT created_at, 'inbox', id,
          'kind=' || kind || ' status=' || status
        FROM inbox_events WHERE pipeline_run_id = ?
      ) event
      WHERE occurred_at > ?
         OR (occurred_at = ? AND kind > ?)
         OR (occurred_at = ? AND kind = ? AND id > ?)
      ORDER BY occurred_at, kind, id
      LIMIT ?
    `).all(
      input.pipeline_run_id,
      input.pipeline_run_id,
      input.pipeline_run_id,
      input.pipeline_run_id,
      input.pipeline_run_id,
      input.pipeline_run_id,
      after.occurred_at,
      after.occurred_at,
      after.kind,
      after.occurred_at,
      after.kind,
      after.id,
      boundedLimit + 1,
    ) as KernelLogEntry[];
    const entries = rows.slice(0, boundedLimit).map((row) => ({
      ...row,
      summary: sanitizeText(row.summary).slice(0, 1_000),
    }));
    const last = entries.at(-1);
    return {
      entries,
      next_cursor: rows.length > boundedLimit && last
        ? { occurred_at: last.occurred_at, kind: last.kind, id: last.id }
        : null,
      truncated: rows.length > boundedLimit,
    };
  }

  collectActiveWork(requestedLimit = 500): KernelActiveWorkSnapshot {
    const boundedLimit = limit(requestedLimit, 500, 2_000);
    const runPlaceholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const attemptPlaceholders = ACTIVE_ATTEMPT_STATUSES.map(() => "?").join(", ");
    const effectPlaceholders = ACTIVE_EFFECT_STATUSES.map(() => "?").join(", ");
    const runtimeResourceEffectPlaceholders = RUNTIME_RESOURCE_EFFECT_KINDS
      .map(() => "?").join(", ");
    const rows = this.#db.prepare(`
      SELECT * FROM (
        SELECT 'run' AS kind, id, id AS pipeline_run_id, status,
          'pipeline=' || pipeline_id || ' stage=' || COALESCE(cursor_stage_id, 'none') AS detail,
          updated_at AS observed_at
        FROM pipeline_runs WHERE status IN (${runPlaceholders})
        UNION ALL
        SELECT 'attempt', id, pipeline_run_id, status,
          'stage=' || stage_id || ' scope=' || scope_kind || ' authority=' || repository_authority,
          updated_at
        FROM attempts WHERE status IN (${attemptPlaceholders})
        UNION ALL
        SELECT 'correction', id, pipeline_run_id, status,
          'deadline=' || COALESCE(result_correction_deadline, 'none') ||
            ' count=' || result_correction_count,
          updated_at
        FROM attempts WHERE status = 'result_pending'
        UNION ALL
        SELECT 'effect', id, pipeline_run_id, status,
          'kind=' || kind || ' target=' || target,
          updated_at
        FROM effects WHERE status IN (${effectPlaceholders})
        UNION ALL
        SELECT 'lease', lease_id, pipeline_run_id, status,
          'owner=attempt:' || id || ' purpose=' || lease_purpose ||
            ' expires_at=' || lease_expires_at,
          updated_at
        FROM attempts WHERE lease_id IS NOT NULL
        UNION ALL
        SELECT 'lease', lease_id, pipeline_run_id, status,
          'owner=effect:' || id || ' mode=' || lease_execution_mode ||
            ' expires_at=' || lease_expires_at,
          updated_at
        FROM effects WHERE lease_id IS NOT NULL
        UNION ALL
        SELECT 'lease', lease_id, NULL, 'leased',
          'owner=' || owner_id || ' purpose=' || purpose || ' expires_at=' || expires_at,
          updated_at
        FROM leases
        UNION ALL
        SELECT 'runtime_resource', id, pipeline_run_id, status,
          'kind=' || kind || ' resource=' || target,
          updated_at
        FROM effects
        WHERE status IN (${effectPlaceholders})
          AND kind IN (${runtimeResourceEffectPlaceholders})
      ) active
      ORDER BY observed_at, kind, id
      LIMIT ?
    `).all(
      ...ACTIVE_RUN_STATUSES,
      ...ACTIVE_ATTEMPT_STATUSES,
      ...ACTIVE_EFFECT_STATUSES,
      ...ACTIVE_EFFECT_STATUSES,
      ...RUNTIME_RESOURCE_EFFECT_KINDS,
      boundedLimit + 1,
    ) as Array<Omit<KernelActiveWorkItem, "key">>;
    return {
      items: rows.slice(0, boundedLimit).map((row) => ({
        ...row,
        key: `${row.kind}:${row.id}`,
        detail: sanitizeText(row.detail).slice(0, 1_500),
      })),
      truncated: rows.length > boundedLimit,
    };
  }
}
