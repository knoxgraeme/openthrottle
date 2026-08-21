import type Database from "better-sqlite3";
import type { PipelineTerminalOutcome } from "@openthrottle/contracts";

const TERMINAL_OUTCOMES: readonly PipelineTerminalOutcome[] = [
  "completed", "no_change", "needs_human", "failed", "canceled", "superseded",
];
const RECORD_KINDS = ["result", "decision", "delivery"] as const;

export interface KernelHistoricalRunQuery {
  pipeline_id?: string;
  terminal_outcome?: PipelineTerminalOutcome;
  record_kind?: (typeof RECORD_KINDS)[number];
  from?: string;
  to?: string;
  limit?: number;
}

export interface KernelHistoricalRun {
  pipeline_run_id: string;
  work_item_id: string;
  source_reference: string;
  pipeline_id: string;
  definition_bundle_hash: string;
  terminal_outcome: PipelineTerminalOutcome;
  current_subject: string;
  attempt_count: number;
  result_count: number;
  decision_count: number;
  delivery_count: number;
  normalized_result_count: number;
  checkpoint_count: number;
  effect_count: number;
  created_at: string;
  settled_at: string;
}

export interface KernelHistoricalRecordMetadata {
  id: string;
  sequence: number;
  kind: (typeof RECORD_KINDS)[number];
  payload_schema: string;
  attempt_id: string | null;
  effect_id: string | null;
  created_at: string;
}

/** Capability intentionally kept out of the live kernel store and ports. */
export interface KernelHistoricalAnalysisPort {
  listSettledRuns(query?: KernelHistoricalRunQuery): readonly KernelHistoricalRun[];
  listSettledRecordMetadata(input: {
    pipeline_run_id: string;
    kind?: (typeof RECORD_KINDS)[number];
    limit?: number;
  }): readonly KernelHistoricalRecordMetadata[];
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("historical analysis limit must be between 1 and 500");
  }
  return limit;
}

function timestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function recordKind(value: string | undefined): (typeof RECORD_KINDS)[number] | undefined {
  if (value === undefined) return undefined;
  if (!RECORD_KINDS.includes(value as (typeof RECORD_KINDS)[number])) {
    throw new Error(`record_kind must be one of: ${RECORD_KINDS.join(", ")}`);
  }
  return value as (typeof RECORD_KINDS)[number];
}

export function createKernelHistoricalAnalysisStore(
  db: Database.Database,
): KernelHistoricalAnalysisPort {
  return {
    listSettledRuns(query = {}) {
      if (
        query.terminal_outcome !== undefined &&
        !TERMINAL_OUTCOMES.includes(query.terminal_outcome)
      ) throw new Error("historical terminal_outcome is invalid");
      const filters = ["r.status NOT IN ('pending', 'running')"];
      const args: unknown[] = [];
      if (query.pipeline_id !== undefined) {
        filters.push("r.pipeline_id = ?");
        args.push(query.pipeline_id);
      }
      if (query.terminal_outcome !== undefined) {
        filters.push("r.terminal_outcome = ?");
        args.push(query.terminal_outcome);
      }
      const kind = recordKind(query.record_kind);
      if (kind !== undefined) {
        filters.push("EXISTS (SELECT 1 FROM records filter_record WHERE filter_record.pipeline_run_id = r.id AND filter_record.kind = ?)");
        args.push(kind);
      }
      const from = timestamp(query.from, "historical from");
      const to = timestamp(query.to, "historical to");
      if (from !== undefined && to !== undefined && from > to) {
        throw new Error("historical from must not be after to");
      }
      if (from !== undefined) {
        filters.push("r.updated_at >= ?");
        args.push(from);
      }
      if (to !== undefined) {
        filters.push("r.updated_at <= ?");
        args.push(to);
      }
      return db.prepare(`
        SELECT r.id AS pipeline_run_id, r.work_item_id, w.source_reference,
          r.pipeline_id, r.definition_bundle_hash, r.terminal_outcome,
          r.current_subject,
          (SELECT COUNT(*) FROM attempts a WHERE a.pipeline_run_id = r.id) AS attempt_count,
          (SELECT COUNT(*) FROM records rec WHERE rec.pipeline_run_id = r.id AND rec.kind = 'result') AS result_count,
          (SELECT COUNT(*) FROM records rec WHERE rec.pipeline_run_id = r.id AND rec.kind = 'decision') AS decision_count,
          (SELECT COUNT(*) FROM records rec WHERE rec.pipeline_run_id = r.id AND rec.kind = 'delivery') AS delivery_count,
          (SELECT COUNT(*) FROM records rec WHERE rec.pipeline_run_id = r.id AND rec.kind = 'result'
            AND rec.original_candidate_hash <> rec.normalized_candidate_hash) AS normalized_result_count,
          (SELECT COUNT(*) FROM checkpoints c WHERE c.pipeline_run_id = r.id) AS checkpoint_count,
          (SELECT COUNT(*) FROM effects e WHERE e.pipeline_run_id = r.id) AS effect_count,
          r.created_at, r.updated_at AS settled_at
        FROM pipeline_runs r JOIN work_items w ON w.id = r.work_item_id
        WHERE ${filters.join(" AND ")}
        ORDER BY r.updated_at DESC, r.id
        LIMIT ?
      `).all(...args, boundedLimit(query.limit)) as KernelHistoricalRun[];
    },

    listSettledRecordMetadata(input) {
      const kind = recordKind(input.kind);
      const run = db.prepare(`
        SELECT status FROM pipeline_runs WHERE id = ?
      `).get(input.pipeline_run_id) as { status: string } | undefined;
      if (!run || run.status === "pending" || run.status === "running") {
        throw new Error("historical analysis may read only a settled pipeline run");
      }
      return db.prepare(`
        SELECT id, sequence, kind, payload_schema, attempt_id, effect_id, created_at
        FROM records
        WHERE pipeline_run_id = ? AND (? IS NULL OR kind = ?)
        ORDER BY sequence, id LIMIT ?
      `).all(
        input.pipeline_run_id,
        kind ?? null,
        kind ?? null,
        boundedLimit(input.limit),
      ) as KernelHistoricalRecordMetadata[];
    },
  };
}
