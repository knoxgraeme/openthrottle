import {
  canonicalJson,
  digestNormalized,
  validateHarnessReportEnvelope,
  type HarnessReportEnvelope,
  type HarnessReportingMode,
} from "@openthrottle/contracts";
import type Database from "better-sqlite3";
import type { StageOutcome } from "../pipeline/manifest.js";
import type { GateReceiptReason } from "../pipeline/gates.js";
import { claimLeasable, markQueueFailed } from "./pipeline/helpers.js";

const HARNESS_REPORTING_MODE_KEY = "harness-reporting:mode";
const HARNESS_REPORTING_ENABLED_SINCE_KEY = "harness-reporting:enabled-since";

export interface HarnessReportOutboxRecord {
  id: string;
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarnessReportRecoveryCandidate {
  instance_id: string;
  runtime_release: string;
  action_id: string;
  cycle: number;
  receipt: string;
  outcome: StageOutcome;
  reason: GateReceiptReason;
  completed_at: string;
}

export interface HarnessReportStore {
  configureMode(mode: HarnessReportingMode, nowIso: string): string | null;
  enqueue(envelope: HarnessReportEnvelope, nowIso: string): HarnessReportOutboxRecord;
  listRecoveryCandidates(sinceIso: string): HarnessReportRecoveryCandidate[];
  claim(nowIso: string, leaseUntilIso: string, limit: number): HarnessReportOutboxRecord[];
  markProcessed(id: string, payloadHash: string, nowIso: string): void;
  markFailed(
    id: string,
    payloadHash: string,
    error: string,
    retryAt: string | null,
    nowIso: string
  ): void;
  discardDisallowed(mode: HarnessReportingMode, nowIso: string): number;
  prune(beforeIso: string, limit: number): number;
}

export function createHarnessReportStore(db: Database.Database): HarnessReportStore {
  const get = db.prepare("SELECT * FROM harness_report_outbox WHERE id = ?");
  const insert = db.prepare(`
    INSERT INTO harness_report_outbox (
      id, payload, payload_hash, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
  `);
  const claimable = db.prepare(`
    SELECT id FROM harness_report_outbox
    WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
       OR (status = 'processing' AND next_attempt_at <= ?)
    ORDER BY created_at, id
    LIMIT ?
  `);
  const markClaimed = db.prepare(`
    UPDATE harness_report_outbox
    SET status = 'processing', attempts = attempts + 1,
        next_attempt_at = ?, updated_at = ?
    WHERE id = ?
      AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND next_attempt_at <= ?))
  `);
  const markProcessed = db.prepare(`
    UPDATE harness_report_outbox
    SET status = 'processed', processed_at = ?, next_attempt_at = NULL,
        last_error = NULL, updated_at = ?
    WHERE id = ? AND payload_hash = ? AND status = 'processing'
  `);
  const markFailed = db.prepare(`
    UPDATE harness_report_outbox
    SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND payload_hash = ? AND status = 'processing'
  `);
  const prune = db.prepare(`
    DELETE FROM harness_report_outbox
    WHERE rowid IN (
      SELECT rowid FROM harness_report_outbox
      WHERE status IN ('processed', 'dead') AND updated_at < ?
      ORDER BY updated_at, id
      LIMIT ?
    )
  `);
  const discardDisallowed = db.prepare(`
    UPDATE harness_report_outbox
    SET status = 'dead', next_attempt_at = NULL,
        last_error = 'reporting mode no longer permits queued envelope', updated_at = ?
    WHERE status IN ('pending', 'processing', 'failed')
      AND (
        ? = 'off'
        OR (? = 'deterministic' AND json_extract(payload, '$.mode') = 'on')
      )
  `);
  const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSetting = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const deleteSetting = db.prepare("DELETE FROM settings WHERE key = ?");
  const listRecoveryCandidates = db.prepare(`
    SELECT
      instances.id AS instance_id,
      instances.runtime_release,
      actions.id AS action_id,
      actions.cycle,
      actions.receipt,
      gates.outcome,
      gates.reason,
      actions.completed_at
    FROM execution_work_attempts AS actions
    JOIN pipeline_instances AS instances
      ON instances.id = actions.pipeline_instance_id
    JOIN execution_gate_receipts AS gates
      ON gates.execution_work_attempt_id = actions.id
      AND gates.gate_kind = 'unit_acceptance'
    WHERE actions.action_kind = 'lead'
      AND actions.status = 'completed'
      AND actions.receipt IS NOT NULL
      AND actions.completed_at IS NOT NULL
      AND actions.completed_at >= ?
      AND (
        gates.outcome = 'needs_human'
        OR json_type(actions.receipt, '$.payload.harness_report') = 'object'
      )
    ORDER BY actions.completed_at, actions.id
  `);

  const configureMode = db.transaction((mode: HarnessReportingMode, nowIso: string): string | null => {
    const previousMode = (getSetting.get(HARNESS_REPORTING_MODE_KEY) as { value: string } | undefined)?.value;
    const previousSince = (getSetting.get(HARNESS_REPORTING_ENABLED_SINCE_KEY) as {
      value: string;
    } | undefined)?.value;
    setSetting.run(HARNESS_REPORTING_MODE_KEY, mode, nowIso);
    if (mode === "off") {
      deleteSetting.run(HARNESS_REPORTING_ENABLED_SINCE_KEY);
      return null;
    }
    if (previousMode !== mode || !previousSince) {
      setSetting.run(HARNESS_REPORTING_ENABLED_SINCE_KEY, nowIso, nowIso);
      return nowIso;
    }
    return previousSince;
  });

  const claimTransaction = db.transaction(
    (nowIso: string, leaseUntilIso: string, limit: number): HarnessReportOutboxRecord[] => {
      const ids = claimable.all(nowIso, nowIso, limit) as Array<{ id: string }>;
      return claimLeasable({
        rows: ids,
        leaseUntilIso,
        nowIso,
        update: (id, leaseUntil, claimedAt) =>
          markClaimed.run(leaseUntil, claimedAt, id, claimedAt, claimedAt).changes,
        get: (id) => get.get(id) as HarnessReportOutboxRecord,
      });
    }
  );

  return {
    configureMode(mode, nowIso) {
      return configureMode.immediate(mode, nowIso);
    },

    enqueue(envelope, nowIso) {
      const normalized = validateHarnessReportEnvelope(envelope).value;
      const payload = canonicalJson(normalized);
      const payloadHash = digestNormalized(payload);
      const existing = get.get(normalized.report_id) as HarnessReportOutboxRecord | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.payload !== payload) {
          throw new Error(`harness report ${normalized.report_id} conflicts with its existing payload`);
        }
        return existing;
      }
      insert.run(normalized.report_id, payload, payloadHash, nowIso, nowIso, nowIso);
      return get.get(normalized.report_id) as HarnessReportOutboxRecord;
    },

    listRecoveryCandidates(sinceIso) {
      return listRecoveryCandidates.all(sinceIso) as HarnessReportRecoveryCandidate[];
    },

    claim(nowIso, leaseUntilIso, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("harness report claim limit must be between 1 and 100");
      }
      return claimTransaction(nowIso, leaseUntilIso, limit);
    },

    markProcessed(id, payloadHash, nowIso) {
      markProcessed.run(nowIso, nowIso, id, payloadHash);
    },

    markFailed(id, payloadHash, error, retryAt, nowIso) {
      markQueueFailed({
        retryAt,
        timestamp: nowIso,
        deadNextAttemptAt: null,
        error: error.slice(0, 1_000),
        update: (status, nextAttemptAt, failure) =>
          markFailed.run(status, nextAttemptAt, failure, nowIso, id, payloadHash).changes,
      });
    },

    discardDisallowed(mode, nowIso) {
      return discardDisallowed.run(nowIso, mode, mode).changes;
    },

    prune(beforeIso, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("harness report prune limit must be between 1 and 10000");
      }
      return prune.run(beforeIso, limit).changes;
    },
  };
}
