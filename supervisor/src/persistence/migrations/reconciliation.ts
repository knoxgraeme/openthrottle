import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export function backfillPipelinePublicationState(db: Database.Database): void {
  if (!hasTable(db, "pipeline_publication_receipts")) return;
  const timestamp = new Date().toISOString();
  db.prepare(`
    UPDATE pipeline_publication_receipts
    SET payload = COALESCE(payload, '{}'),
        next_attempt_at = COALESCE(next_attempt_at, created_at, ?),
        updated_at = COALESCE(updated_at, created_at, ?)
  `).run(timestamp, timestamp);
}

export function backfillPipelineExecutionIdentity(db: Database.Database): void {
  if (!hasColumns(db, "tickets", ["linear_issue_id", "branch", "agent"])) return;
  db.exec(`
    UPDATE pipeline_instances
    SET branch = (SELECT branch FROM tickets WHERE tickets.linear_issue_id = pipeline_instances.linear_issue_id),
        agent = (SELECT agent FROM tickets WHERE tickets.linear_issue_id = pipeline_instances.linear_issue_id)
  `);
}

export function backfillLegacySessionExecutions(db: Database.Database): void {
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

export function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

export function hasColumns(db: Database.Database, table: string, columns: string[]): boolean {
  if (!hasTable(db, table)) return false;
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  return columns.every((column) => present.has(column));
}

export function backfillRunLiveness(db: Database.Database): void {
  if (!hasColumns(db, "runs", ["id", "status", "started_at"])) return;
  db.prepare(`
    INSERT OR IGNORE INTO run_liveness(run_id, actor_state, updated_at)
    SELECT id, 'running', started_at FROM runs WHERE status = 'running'
  `).run();
}

export function backfillPipelineAttemptActors(db: Database.Database): void {
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

export function backfillLegacyWork(db: Database.Database): void {
  if (!hasTable(db, "session_work")) return;
  const timestamp = new Date().toISOString();
  const legacyRows = db.prepare(`
    SELECT sw.*, COALESCE(s.generation, r.session_generation, 1) AS resolved_generation
    FROM session_work sw
    LEFT JOIN agent_sessions s ON s.id = sw.linear_session_id
    LEFT JOIN runs r ON r.id = sw.claimed_run_id
  `).all() as Array<{
    id: string;
    linear_issue_id: string;
    linear_session_id: string;
    claimed_run_id: string | null;
    source: string;
    priority: number;
    body: string;
    status: string;
    available_at: string;
    created_at: string;
    consumed_at: string | null;
    canceled_at: string | null;
    resolved_generation: number;
  }>;
  const insertWork = db.prepare(`
    INSERT OR IGNORE INTO work_items (
      id, linear_issue_id, linear_session_id, run_id, generation,
      context_revision, source, priority, body, request_hash, status,
      available_at, created_at, updated_at, consumed_at, canceled_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of legacyRows) {
    let status = "reconciliation";
    if (row.status === "pending") status = "pending";
    else if (row.status === "consumed" && row.claimed_run_id) status = "consumed";
    else if (row.status === "canceled") status = "canceled";
    const hash = createHash("sha256")
      .update(JSON.stringify([row.id, row.linear_session_id, row.body]))
      .digest("hex");
    insertWork.run(
      row.id,
      row.linear_issue_id,
      row.linear_session_id,
      row.claimed_run_id,
      row.resolved_generation,
      row.source,
      row.priority,
      row.body,
      hash,
      status,
      row.available_at,
      row.created_at,
      timestamp,
      row.consumed_at,
      row.canceled_at
    );
    if (status === "consumed") {
      db.prepare(
        "UPDATE work_items SET consumed_by_attempt_id = ? WHERE id = ? AND status = 'consumed'"
      ).run(row.claimed_run_id, row.id);
    }
  }
  db.prepare(`
    INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id)
    SELECT 'session_work', id, id FROM session_work
  `).run();

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_work) AS source_count,
      (SELECT COUNT(*) FROM work_item_sources WHERE source_table = 'session_work') AS mapped_count
  `).get() as { source_count: number; mapped_count: number };
  const insert = db.prepare(`
    INSERT OR REPLACE INTO migration_reconciliation
      (migration_version, category, row_count, recorded_at)
    VALUES (1, ?, ?, ?)
  `);
  insert.run("legacy_session_work", counts.source_count, timestamp);
  insert.run("mapped_session_work", counts.mapped_count, timestamp);
  if (counts.source_count !== counts.mapped_count) {
    throw new Error("legacy work reconciliation failed: not every source row was mapped");
  }

  const recordFinalCounts = () => {
    const final = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_items) AS authoritative_count,
        (SELECT COUNT(*) FROM work_deliveries) AS delivery_count,
        (SELECT COUNT(*) FROM work_items WHERE status IN ('consumed', 'canceled', 'dead')) AS terminal_count,
        (SELECT COUNT(*) FROM work_items WHERE status = 'reconciliation') AS reconciliation_count
    `).get() as {
      authoritative_count: number;
      delivery_count: number;
      terminal_count: number;
      reconciliation_count: number;
    };
    insert.run("authoritative_work_items", final.authoritative_count, timestamp);
    insert.run("legacy_work_deliveries", final.delivery_count, timestamp);
    insert.run("legacy_terminal_work", final.terminal_count, timestamp);
    insert.run("operator_reconciliation", final.reconciliation_count, timestamp);
  };

  if (!hasTable(db, "session_inbox")) {
    recordFinalCounts();
    return;
  }
  const inboxRows = db.prepare(`
    SELECT si.*, COALESCE(s.generation, r.session_generation, 1) AS resolved_generation,
      s.provider_conversation_id
    FROM session_inbox si
    LEFT JOIN agent_sessions s ON s.id = si.linear_session_id
    LEFT JOIN runs r ON r.id = si.run_id
  `).all() as Array<{
    id: string;
    linear_issue_id: string;
    linear_session_id: string;
    run_id: string | null;
    source: string;
    body: string;
    status: string;
    created_at: string;
    delivered_at: string | null;
    resolved_generation: number;
    provider_conversation_id: string | null;
  }>;
  for (const row of inboxRows) {
    let item = db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id) as
      | {
          id: string;
          linear_issue_id: string;
          linear_session_id: string;
          run_id: string | null;
          body: string;
          request_hash: string;
          status: string;
        }
      | undefined;
    if (!item) {
      const hash = createHash("sha256")
        .update(JSON.stringify([row.id, row.linear_session_id, row.body]))
        .digest("hex");
      insertWork.run(
        row.id,
        row.linear_issue_id,
        row.linear_session_id,
        row.run_id,
        row.resolved_generation,
        row.source,
        row.source === "human" ? 0 : 10,
        row.body,
        hash,
        row.status === "canceled" ? "canceled" : row.status === "delivered" ? "dispatched" : "pending",
        row.created_at,
        row.created_at,
        timestamp,
        null,
        row.status === "canceled" ? timestamp : null
      );
      item = db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id) as {
        id: string;
        linear_issue_id: string;
        linear_session_id: string;
        run_id: string | null;
        body: string;
        request_hash: string;
        status: string;
      };
    }
    db.prepare(
      "INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id) VALUES ('session_inbox', ?, ?)"
    ).run(row.id, row.id);
    if (
      item.linear_issue_id !== row.linear_issue_id ||
      item.linear_session_id !== row.linear_session_id ||
      item.body !== row.body
    ) {
      db.prepare(`
        UPDATE work_items
        SET status = 'reconciliation', active_delivery_id = NULL,
            consumed_by_attempt_id = NULL, consumed_at = NULL, canceled_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, row.id);
      continue;
    }
    const corroboratedLegacyClaim =
      item.status === "reconciliation" &&
      row.status === "delivered" &&
      row.run_id !== null &&
      item.run_id === row.run_id;
    if (
      ["consumed", "canceled", "dead"].includes(item.status) ||
      (item.status === "reconciliation" && !corroboratedLegacyClaim)
    ) {
      continue;
    }
    if (row.status !== "delivered") continue;
    if (!row.run_id) {
      db.prepare(
        "UPDATE work_items SET status = 'reconciliation', updated_at = ? WHERE id = ? AND status NOT IN ('consumed', 'canceled')"
      ).run(timestamp, row.id);
      continue;
    }
    const deliveryId = `legacy-inbox-${row.id}`;
    db.prepare(`
      INSERT OR IGNORE INTO work_deliveries (
        id, work_item_id, attempt_ordinal, idempotency_key,
        linear_issue_id, linear_session_id, run_id, native_session_id,
        generation, context_revision, request_hash, status, lease_until,
        created_at, dispatched_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 'dispatched', ?, ?, ?)
    `).run(
      deliveryId,
      row.id,
      createHash("sha256").update(`legacy\0${row.id}`).digest("hex"),
      row.linear_issue_id,
      row.linear_session_id,
      row.run_id,
      row.provider_conversation_id,
      row.resolved_generation,
      item.request_hash,
      row.delivered_at ?? row.created_at,
      row.created_at,
      row.delivered_at ?? row.created_at
    );
    db.prepare(
      "UPDATE work_items SET status = 'dispatched', active_delivery_id = ?, updated_at = ? WHERE id = ? AND status NOT IN ('consumed', 'canceled')"
    ).run(deliveryId, timestamp, row.id);
    db.prepare("UPDATE session_inbox SET status = 'dispatched' WHERE id = ?").run(row.id);
  }
  const inboxCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_inbox) AS source_count,
      (SELECT COUNT(*) FROM work_item_sources WHERE source_table = 'session_inbox') AS mapped_count
  `).get() as { source_count: number; mapped_count: number };
  insert.run("legacy_session_inbox", inboxCounts.source_count, timestamp);
  insert.run("mapped_session_inbox", inboxCounts.mapped_count, timestamp);
  if (inboxCounts.source_count !== inboxCounts.mapped_count) {
    throw new Error("legacy inbox reconciliation failed: not every source row was mapped");
  }
  recordFinalCounts();
}
