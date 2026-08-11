import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type WorkItemStatus =
  | "pending"
  | "leased"
  | "dispatched"
  | "acknowledged"
  | "consumed"
  | "canceled"
  | "dead"
  | "reconciliation";

export interface WorkItem {
  id: string;
  ticket_id: string;
  session_id: string;
  pipeline_instance_id: string | null;
  run_id: string | null;
  native_session_id: string | null;
  generation: number;
  context_revision: number;
  source: "human" | "automatic" | "fallback" | "control" | "operator";
  priority: number;
  body: string;
  request_hash: string;
  status: WorkItemStatus;
  active_delivery_id: string | null;
  consumed_by_attempt_id: string | null;
  available_at: string;
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
  canceled_at: string | null;
}

export type WorkDeliveryStatus =
  | "leased"
  | "dispatched"
  | "acknowledged"
  | "consumed"
  | "canceled"
  | "dead"
  | "expired";

export interface WorkDelivery {
  id: string;
  work_item_id: string;
  attempt_ordinal: number;
  idempotency_key: string;
  ticket_id: string;
  session_id: string;
  pipeline_instance_id: string | null;
  run_id: string;
  native_session_id: string | null;
  generation: number;
  context_revision: number;
  request_hash: string;
  status: WorkDeliveryStatus;
  lease_until: string;
  created_at: string;
  dispatched_at: string | null;
  acknowledged_at: string | null;
  consumed_at: string | null;
  last_error: string | null;
}

export interface WorkBinding {
  issueId: string;
  sessionId: string;
  pipelineInstanceId?: string | null;
  runId: string;
  nativeSessionId?: string | null;
  generation: number;
  contextRevision: number;
}

function requestHash(params: {
  id: string;
  issueId: string;
  sessionId: string;
  pipelineInstanceId?: string | null;
  runId?: string | null;
  nativeSessionId?: string | null;
  generation: number;
  contextRevision: number;
  source: string;
  body: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      params.id,
      params.issueId,
      params.sessionId,
      params.pipelineInstanceId ?? null,
      params.runId ?? null,
      params.nativeSessionId ?? null,
      params.generation,
      params.contextRevision,
      params.source,
      params.body,
    ]))
    .digest("hex");
}

function assertBinding(delivery: WorkDelivery, binding: WorkBinding): void {
  if (
    delivery.ticket_id !== binding.issueId ||
    delivery.session_id !== binding.sessionId ||
    delivery.pipeline_instance_id !== (binding.pipelineInstanceId ?? null) ||
    delivery.run_id !== binding.runId ||
    delivery.native_session_id !== (binding.nativeSessionId ?? null) ||
    delivery.generation !== binding.generation ||
    delivery.context_revision !== binding.contextRevision
  ) {
    throw new Error(`work delivery ${delivery.id} binding mismatch`);
  }
}

export interface WorkStore {
  enqueue(params: {
    id: string;
    issueId: string;
    sessionId: string;
    pipelineInstanceId?: string | null;
    runId?: string | null;
    nativeSessionId?: string | null;
    generation: number;
    contextRevision: number;
    source: "human" | "operator";
    body: string;
    priority?: number;
    availableAt?: string;
  }): WorkItem;
  get(id: string): WorkItem | undefined;
  getDelivery(id: string): WorkDelivery | undefined;
  lease(params: WorkBinding & {
    workItemId: string;
    now?: string;
    leaseUntil: string;
  }): WorkDelivery;
  markDispatched(deliveryId: string, binding: WorkBinding): WorkDelivery;
  acknowledge(deliveryId: string, binding: WorkBinding): WorkDelivery;
  consume(deliveryId: string, binding: WorkBinding & { attemptId: string }): WorkDelivery;
  consumeFallback(workItemId: string, attemptId: string): WorkItem;
  expireUnacknowledged(deliveryId: string, expectedRunId: string, reason: string): boolean;
  releaseUnacknowledgedForRun(runId: string, reason: string): string[];
  consumeAcknowledgedForRun(runId: string, attemptId: string): string[];
  cancel(workItemId: string, reason?: string): boolean;
}

export function createWorkStore(db: Database.Database): WorkStore {
  const getItemStmt = db.prepare("SELECT * FROM work_items WHERE id = ?");
  const getDeliveryStmt = db.prepare("SELECT * FROM work_deliveries WHERE id = ?");
  const now = () => new Date().toISOString();

  const enqueueTransaction = db.transaction(
    (params: Parameters<WorkStore["enqueue"]>[0]): WorkItem => {
      const timestamp = now();
      const hash = requestHash(params);
      const existing = getItemStmt.get(params.id) as WorkItem | undefined;
      if (existing) {
        if (existing.request_hash !== hash) {
          throw new Error(`work item ${params.id} already exists with different intent`);
        }
        return existing;
      }
      db.prepare(`
        INSERT INTO work_items (
          id, ticket_id, session_id, pipeline_instance_id, run_id,
          native_session_id, generation, context_revision, source, priority,
          body, request_hash, status, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        params.id,
        params.issueId,
        params.sessionId,
        params.pipelineInstanceId ?? null,
        params.runId ?? null,
        params.nativeSessionId ?? null,
        params.generation,
        params.contextRevision,
        params.source,
        params.priority ?? (params.source === "human" ? 0 : 10),
        params.body,
        hash,
        params.availableAt ?? timestamp,
        timestamp,
        timestamp
      );
      return getItemStmt.get(params.id) as WorkItem;
    }
  );

  const leaseTransaction = db.transaction(
    (params: WorkBinding & { workItemId: string; now?: string; leaseUntil: string }): WorkDelivery => {
      const timestamp = params.now ?? now();
      const item = getItemStmt.get(params.workItemId) as WorkItem | undefined;
      if (!item) throw new Error(`work item ${params.workItemId} not found`);
      if (["consumed", "canceled", "dead", "reconciliation"].includes(item.status)) {
        throw new Error(`work item ${item.id} is ${item.status}`);
      }
      const active = item.active_delivery_id
        ? (getDeliveryStmt.get(item.active_delivery_id) as WorkDelivery | undefined)
        : undefined;
      if (active?.status === "acknowledged") {
        throw new Error(`work item ${item.id} is already acknowledged`);
      }
      if (
        active &&
        ["leased", "dispatched"].includes(active.status) &&
        active.lease_until > timestamp
      ) {
        assertBinding(active, params);
        return active;
      }
      if (active && ["leased", "dispatched"].includes(active.status)) {
        db.prepare(
          "UPDATE work_deliveries SET status = 'expired', last_error = 'lease expired' WHERE id = ? AND status IN ('leased', 'dispatched')"
        ).run(active.id);
      }
      if (
        item.ticket_id !== params.issueId ||
        item.session_id !== params.sessionId ||
        item.pipeline_instance_id !== (params.pipelineInstanceId ?? null) ||
        (item.run_id !== null && item.run_id !== params.runId) ||
        item.native_session_id !== (params.nativeSessionId ?? null) ||
        item.generation !== params.generation ||
        item.context_revision !== params.contextRevision
      ) {
        throw new Error(`work item ${item.id} binding mismatch`);
      }
      const ordinal = ((db.prepare(
        "SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal FROM work_deliveries WHERE work_item_id = ?"
      ).get(item.id) as { ordinal: number }).ordinal);
      const deliveryId = randomUUID();
      const idempotencyKey = createHash("sha256")
        .update(`${item.id}\0${ordinal}\0${item.request_hash}`)
        .digest("hex");
      db.prepare(`
        INSERT INTO work_deliveries (
          id, work_item_id, attempt_ordinal, idempotency_key,
          ticket_id, session_id, pipeline_instance_id, run_id,
          native_session_id, generation, context_revision, request_hash,
          status, lease_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', ?, ?)
      `).run(
        deliveryId,
        item.id,
        ordinal,
        idempotencyKey,
        params.issueId,
        params.sessionId,
        params.pipelineInstanceId ?? null,
        params.runId,
        params.nativeSessionId ?? null,
        params.generation,
        params.contextRevision,
        item.request_hash,
        params.leaseUntil,
        timestamp
      );
      db.prepare(
        "UPDATE work_items SET status = 'leased', active_delivery_id = ?, updated_at = ? WHERE id = ?"
      ).run(deliveryId, timestamp, item.id);
      return getDeliveryStmt.get(deliveryId) as WorkDelivery;
    }
  );

  return {
    enqueue(params) {
      return enqueueTransaction.immediate(params);
    },
    get(id) {
      return getItemStmt.get(id) as WorkItem | undefined;
    },
    getDelivery(id) {
      return getDeliveryStmt.get(id) as WorkDelivery | undefined;
    },
    lease(params) {
      return leaseTransaction.immediate(params);
    },
    markDispatched(deliveryId, binding) {
      const delivery = getDeliveryStmt.get(deliveryId) as WorkDelivery | undefined;
      if (!delivery) throw new Error(`work delivery ${deliveryId} not found`);
      assertBinding(delivery, binding);
      if (["dispatched", "acknowledged", "consumed"].includes(delivery.status)) return delivery;
      if (delivery.status !== "leased") {
        throw new Error(`work delivery ${deliveryId} is not leased`);
      }
      const timestamp = now();
      db.transaction(() => {
        db.prepare(
          "UPDATE work_deliveries SET status = 'dispatched', dispatched_at = ? WHERE id = ? AND status = 'leased'"
        ).run(timestamp, deliveryId);
        db.prepare(
          "UPDATE work_items SET status = 'dispatched', updated_at = ? WHERE id = ? AND active_delivery_id = ?"
        ).run(timestamp, delivery.work_item_id, deliveryId);
      }).immediate();
      return getDeliveryStmt.get(deliveryId) as WorkDelivery;
    },
    acknowledge(deliveryId, binding) {
      const delivery = getDeliveryStmt.get(deliveryId) as WorkDelivery | undefined;
      if (!delivery) throw new Error(`work delivery ${deliveryId} not found`);
      assertBinding(delivery, binding);
      if (["acknowledged", "consumed"].includes(delivery.status)) return delivery;
      if (delivery.status !== "dispatched") {
        throw new Error(`work delivery ${deliveryId} must be dispatched before acknowledgement`);
      }
      const timestamp = now();
      db.transaction(() => {
        db.prepare(
          "UPDATE work_deliveries SET status = 'acknowledged', acknowledged_at = ? WHERE id = ? AND status = 'dispatched'"
        ).run(timestamp, deliveryId);
        db.prepare(
          "UPDATE work_items SET status = 'acknowledged', updated_at = ? WHERE id = ? AND active_delivery_id = ?"
        ).run(timestamp, delivery.work_item_id, deliveryId);
      }).immediate();
      return getDeliveryStmt.get(deliveryId) as WorkDelivery;
    },
    consume(deliveryId, binding) {
      const delivery = getDeliveryStmt.get(deliveryId) as WorkDelivery | undefined;
      if (!delivery) throw new Error(`work delivery ${deliveryId} not found`);
      assertBinding(delivery, binding);
      const item = getItemStmt.get(delivery.work_item_id) as WorkItem;
      if (item.status === "consumed") {
        if (item.consumed_by_attempt_id === binding.attemptId) return delivery;
        throw new Error(`work item ${item.id} already consumed by ${item.consumed_by_attempt_id}`);
      }
      if (delivery.status !== "acknowledged") {
        throw new Error(`work delivery ${deliveryId} must be acknowledged before consumption`);
      }
      const timestamp = now();
      db.transaction(() => {
        db.prepare(
          "UPDATE work_deliveries SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'acknowledged'"
        ).run(timestamp, deliveryId);
        const result = db.prepare(`
          UPDATE work_items
          SET status = 'consumed', consumed_by_attempt_id = ?, consumed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'acknowledged' AND active_delivery_id = ?
        `).run(binding.attemptId, timestamp, timestamp, delivery.work_item_id, deliveryId);
        if (result.changes !== 1) throw new Error(`work item ${item.id} consumption race`);
      }).immediate();
      return getDeliveryStmt.get(deliveryId) as WorkDelivery;
    },
    consumeFallback(workItemId, attemptId) {
      const timestamp = now();
      return db.transaction(() => {
        const item = getItemStmt.get(workItemId) as WorkItem | undefined;
        if (!item) throw new Error(`work item ${workItemId} not found`);
        if (item.status === "consumed") {
          if (item.consumed_by_attempt_id === attemptId) return item;
          throw new Error(`work item ${item.id} already consumed by ${item.consumed_by_attempt_id}`);
        }
        if (["acknowledged", "canceled", "dead", "reconciliation"].includes(item.status)) {
          throw new Error(`work item ${item.id} cannot be fallback-consumed from ${item.status}`);
        }
        if (item.active_delivery_id) {
          db.prepare(`
            UPDATE work_deliveries
            SET status = 'expired', last_error = 'superseded by durable fallback'
            WHERE id = ? AND status IN ('leased', 'dispatched')
          `).run(item.active_delivery_id);
        }
        const result = db.prepare(`
          UPDATE work_items
          SET status = 'consumed', consumed_by_attempt_id = ?, consumed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'leased', 'dispatched')
        `).run(attemptId, timestamp, timestamp, workItemId);
        if (result.changes !== 1) throw new Error(`work item ${item.id} fallback consumption race`);
        return getItemStmt.get(workItemId) as WorkItem;
      }).immediate();
    },
    expireUnacknowledged(deliveryId, expectedRunId, reason) {
      return db.transaction(() => {
        const delivery = getDeliveryStmt.get(deliveryId) as WorkDelivery | undefined;
        if (
          !delivery ||
          delivery.run_id !== expectedRunId ||
          !["leased", "dispatched"].includes(delivery.status)
        ) {
          return false;
        }
        const expired = db.prepare(`
          UPDATE work_deliveries SET status = 'expired', last_error = ?
          WHERE id = ? AND run_id = ? AND status IN ('leased', 'dispatched')
        `).run(reason, deliveryId, expectedRunId);
        if (expired.changes !== 1) return false;
        db.prepare(`
          UPDATE work_items SET status = 'pending', active_delivery_id = NULL, updated_at = ?
          WHERE id = ? AND active_delivery_id = ? AND status IN ('leased', 'dispatched')
        `).run(now(), delivery.work_item_id, deliveryId);
        return true;
      }).immediate();
    },
    releaseUnacknowledgedForRun(runId, reason) {
      return db.transaction(() => {
        const deliveries = db.prepare(
          "SELECT * FROM work_deliveries WHERE run_id = ? AND status IN ('leased', 'dispatched') ORDER BY created_at, id"
        ).all(runId) as WorkDelivery[];
        const released: string[] = [];
        for (const delivery of deliveries) {
          const expired = db.prepare(`
            UPDATE work_deliveries SET status = 'expired', last_error = ?
            WHERE id = ? AND run_id = ? AND status IN ('leased', 'dispatched')
          `).run(reason, delivery.id, runId);
          if (expired.changes !== 1) continue;
          db.prepare(`
            UPDATE work_items SET status = 'pending', active_delivery_id = NULL, updated_at = ?
            WHERE id = ? AND active_delivery_id = ? AND status IN ('leased', 'dispatched')
          `).run(now(), delivery.work_item_id, delivery.id);
          released.push(delivery.work_item_id);
        }
        return released;
      }).immediate();
    },
    consumeAcknowledgedForRun(runId, attemptId) {
      const deliveries = db.prepare(
        "SELECT * FROM work_deliveries WHERE run_id = ? AND status = 'acknowledged' ORDER BY created_at, id"
      ).all(runId) as WorkDelivery[];
      const consumed: string[] = [];
      for (const delivery of deliveries) {
        this.consume(delivery.id, {
          issueId: delivery.ticket_id,
          sessionId: delivery.session_id,
          pipelineInstanceId: delivery.pipeline_instance_id,
          runId: delivery.run_id,
          nativeSessionId: delivery.native_session_id,
          generation: delivery.generation,
          contextRevision: delivery.context_revision,
          attemptId,
        });
        consumed.push(delivery.work_item_id);
      }
      return consumed;
    },
    cancel(workItemId, reason) {
      const timestamp = now();
      return db.transaction(() => {
        const item = getItemStmt.get(workItemId) as WorkItem | undefined;
        if (!item || ["acknowledged", "consumed", "canceled", "dead"].includes(item.status)) {
          return false;
        }
        if (item.active_delivery_id) {
          db.prepare(
            "UPDATE work_deliveries SET status = 'canceled', last_error = ? WHERE id = ? AND status IN ('leased', 'dispatched')"
          ).run(reason ?? null, item.active_delivery_id);
        }
        db.prepare(
          "UPDATE work_items SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?"
        ).run(timestamp, timestamp, workItemId);
        return true;
      }).immediate();
    },
  };
}
