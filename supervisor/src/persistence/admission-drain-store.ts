import type Database from "better-sqlite3";

export type AdmissionDrainBlockerKind =
  | "pre_epoch_webhook_delivery_lease"
  | "active_webhook_delivery_lease"
  | "nonterminal_pipeline_instance"
  | "runnable_pipeline_effect"
  | "runnable_publication_receipt"
  | "leased_child_action"
  | "bound_active_runtime_resource";

export interface AdmissionDrainBlocker {
  kind: AdmissionDrainBlockerKind;
  id: string;
  detail: string;
}

export interface DurableAdmissionDrainReport {
  blockers: AdmissionDrainBlocker[];
  truncated: boolean;
  knownRuntimeResourceIds: string[];
}

export interface AdmissionDrainStore {
  collectAdmissionDrainBlockers(input: {
    epochStartedAtIso: string;
    nowIso: string;
    limit: number;
  }): DurableAdmissionDrainReport;
}

const TERMINAL_PIPELINE_STATUSES = [
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
] as const;

function boundedRows<T>(
  db: Database.Database,
  listSql: string,
  params: readonly unknown[],
  limit: number
): { rows: T[]; truncated: boolean } {
  const rows = db.prepare(listSql).all(...params, limit + 1) as T[];
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export function createAdmissionDrainStore(db: Database.Database): AdmissionDrainStore {
  return {
    collectAdmissionDrainBlockers({ epochStartedAtIso, nowIso, limit }) {
      const effectiveLimit = Math.max(1, Math.floor(limit));
      const blockers: AdmissionDrainBlocker[] = [];
      let truncated = false;
      const remaining = () => Math.max(0, effectiveLimit - blockers.length);

      const append = <T>(
        query: { rows: T[]; truncated: boolean },
        format: (row: T) => AdmissionDrainBlocker
      ) => {
        blockers.push(...query.rows.map(format));
        truncated = truncated || query.truncated;
      };

      if (remaining() > 0) {
        append(
          boundedRows<{
            delivery_id: string;
            source: string;
            action: string;
            received_at: string;
            next_attempt_at: string | null;
          }>(
            db,
            `
              SELECT delivery_id, source, action, received_at, next_attempt_at
              FROM webhook_deliveries
              WHERE status = 'processing'
              ORDER BY received_at, delivery_id
              LIMIT ?
            `,
            [],
            remaining()
          ),
          (row) => ({
            kind: row.received_at < epochStartedAtIso
              ? "pre_epoch_webhook_delivery_lease"
              : "active_webhook_delivery_lease",
            id: row.delivery_id,
            detail: `${row.source}:${row.action} received_at=${row.received_at} epoch_started_at=${epochStartedAtIso} lease_until=${row.next_attempt_at ?? "unknown"}`,
          })
        );
      }

      if (remaining() > 0) {
        const terminalPlaceholders = TERMINAL_PIPELINE_STATUSES.map(() => "?").join(", ");
        append(
          boundedRows<{
            id: string;
            status: string;
            terminal_outcome: string | null;
            updated_at: string;
          }>(
            db,
            `
              SELECT id, status, terminal_outcome, updated_at
              FROM pipeline_instances
              WHERE terminal_outcome IS NULL AND status NOT IN (${terminalPlaceholders})
              ORDER BY updated_at, id
              LIMIT ?
            `,
            TERMINAL_PIPELINE_STATUSES,
            remaining()
          ),
          (row) => ({
            kind: "nonterminal_pipeline_instance",
            id: row.id,
            detail: `status=${row.status} terminal_outcome=${row.terminal_outcome ?? "null"} updated_at=${row.updated_at}`,
          })
        );
      }

      if (remaining() > 0) {
        append(
          boundedRows<{
            id: string;
            pipeline_instance_id: string;
            kind: string;
            status: string;
            next_attempt_at: string;
          }>(
            db,
            `
              SELECT id, pipeline_instance_id, kind, status, next_attempt_at
              FROM pipeline_effect_intents
              WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
                OR (status = 'processing' AND next_attempt_at <= ?))
              ORDER BY next_attempt_at, created_at, id
              LIMIT ?
            `,
            [nowIso, nowIso],
            remaining()
          ),
          (row) => ({
            kind: "runnable_pipeline_effect",
            id: row.id,
            detail: `instance=${row.pipeline_instance_id} kind=${row.kind} status=${row.status} next_attempt_at=${row.next_attempt_at}`,
          })
        );
      }

      if (remaining() > 0) {
        append(
          boundedRows<{
            id: string;
            pipeline_instance_id: string;
            kind: string;
            status: string;
            next_attempt_at: string | null;
          }>(
            db,
            `
              SELECT id, pipeline_instance_id, kind, status, next_attempt_at
              FROM pipeline_publication_receipts
              WHERE kind = 'github_summary'
                AND ((status IN ('pending', 'failed') AND COALESCE(next_attempt_at, created_at) <= ?)
                  OR (status = 'processing' AND COALESCE(next_attempt_at, created_at) <= ?))
              ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
              LIMIT ?
            `,
            [nowIso, nowIso],
            remaining()
          ),
          (row) => ({
            kind: "runnable_publication_receipt",
            id: row.id,
            detail: `instance=${row.pipeline_instance_id} kind=${row.kind} status=${row.status} next_attempt_at=${row.next_attempt_at ?? "none"}`,
          })
        );
      }

      if (remaining() > 0) {
        append(
          boundedRows<{
            id: string;
            parent_run_id: string;
            unit_id: string | null;
            action_kind: string;
            status: string;
            lease_until: string | null;
          }>(
            db,
            `
              SELECT id, parent_run_id, unit_id, action_kind, status, lease_until
              FROM execution_work_attempts
              WHERE status IN ('leased', 'dispatched', 'running')
              ORDER BY created_at, id
              LIMIT ?
            `,
            [],
            remaining()
          ),
          (row) => ({
            kind: "leased_child_action",
            id: row.id,
            detail: `parent_run=${row.parent_run_id} unit=${row.unit_id ?? "final"} action=${row.action_kind} status=${row.status} lease_until=${row.lease_until ?? "none"}`,
          })
        );
      }

      if (remaining() > 0) {
        append(
          boundedRows<{
            id: string;
            runtime_provider: string;
            runtime_provider_resource_id: string;
            runtime_resource_status: string;
          }>(
            db,
            `
              SELECT id, runtime_provider, runtime_provider_resource_id, runtime_resource_status
              FROM pipeline_instances
              WHERE terminal_outcome IS NULL
                AND runtime_provider_resource_id IS NOT NULL
                AND runtime_resource_status IN ('active', 'stopped', 'quarantined')
              ORDER BY runtime_resource_updated_at, id
              LIMIT ?
            `,
            [],
            remaining()
          ),
          (row) => ({
            kind: "bound_active_runtime_resource",
            id: row.runtime_provider_resource_id,
            detail: `instance=${row.id} provider=${row.runtime_provider} status=${row.runtime_resource_status}`,
          })
        );
      }

      const knownRuntimeResourceIds = db.prepare(`
        SELECT runtime_provider_resource_id
        FROM pipeline_instances
        WHERE runtime_provider_resource_id IS NOT NULL
          AND runtime_resource_status IS NOT 'cleaned'
        ORDER BY runtime_provider_resource_id
        LIMIT ?
      `).pluck().all(effectiveLimit + 1) as string[];

      return { blockers, truncated, knownRuntimeResourceIds };
    },
  };
}
