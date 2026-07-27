import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import type { PipelineEffectIntent, PipelineInstance, PipelineStore } from "../../pipeline/store.js";
import { claimLeasable, markQueueFailed } from "./helpers.js";

export function createEffectStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "getEffect" | "claimEffects" | "recordEffectAcknowledgement" | "markEffectFailed" | "markStopEffectExhausted"
> {
  const claimEffects = db.transaction((
    nowIso: string,
    leaseUntilIso: string,
    limit = 4
  ): PipelineEffectIntent[] => {
    const candidates = db.prepare(`
      SELECT current.id FROM pipeline_effect_intents current
      WHERE ((current.status IN ('pending', 'failed') AND current.next_attempt_at <= ?)
        OR (current.status = 'processing' AND current.next_attempt_at <= ?))
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_effect_intents earlier
          WHERE earlier.pipeline_instance_id = current.pipeline_instance_id
            AND earlier.status NOT IN ('acknowledged', 'dead')
            AND (
              earlier.transition_version < current.transition_version OR
              (earlier.transition_version = current.transition_version AND earlier.created_at < current.created_at) OR
              (earlier.transition_version = current.transition_version AND earlier.created_at = current.created_at
                AND earlier.id < current.id)
            )
        )
      ORDER BY current.next_attempt_at, current.created_at, current.id LIMIT ?
    `).all(nowIso, nowIso, limit) as Array<{ id: string }>;
    return claimLeasable({
      rows: candidates,
      nowIso,
      leaseUntilIso,
      update: (id, lease, nowValue) => db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE id = ? AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(lease, id, nowValue, nowValue).changes,
      get: (id) => db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?")
        .get(id) as PipelineEffectIntent,
    });
  });

  const recordEffectAcknowledgement = db.transaction((input: {
    effectId: string;
    eventId: string;
    payload: string;
  }): void => {
    const effect = db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?").get(input.effectId) as PipelineEffectIntent | undefined;
    if (!effect) throw new Error(`unknown pipeline effect ${input.effectId}`);
    const instance = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?")
      .get(effect.pipeline_instance_id) as PipelineInstance;
    const eventPayload = canonicalJson({
      effectId: effect.id,
      idempotencyKey: effect.idempotency_key,
      kind: effect.kind,
      result: JSON.parse(input.payload) as unknown,
    });
    const payloadHash = digestNormalized(eventPayload);
    const existing = db.prepare("SELECT payload_hash, status FROM pipeline_inbox_events WHERE id = ?")
      .get(input.eventId) as { payload_hash: string; status: string } | undefined;
    if (effect.status === "acknowledged") {
      if (!existing || existing.payload_hash !== payloadHash) {
        throw new Error(`acknowledged effect ${effect.id} is missing its exact inbox event`);
      }
      return;
    }
    if (effect.status !== "processing") throw new Error(`pipeline effect ${effect.id} is not processing`);
    const timestamp = now();
    db.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = ?, last_error = NULL
      WHERE id = ? AND status = 'processing'
    `).run(timestamp, effect.id);
    db.prepare(`
      INSERT INTO pipeline_inbox_events (
        id, pipeline_instance_id, generation, kind, payload, payload_hash, status, created_at
      ) VALUES (?, ?, ?, 'effect_acknowledged', ?, ?, 'pending', ?)
    `).run(input.eventId, instance.id, instance.generation, eventPayload, payloadHash, timestamp);
  });

  const markStopEffectExhausted = db.transaction((input: {
    effectId: string;
    error: string;
    runId: string | null;
    owner: string;
  }): void => {
    const effect = db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?")
      .get(input.effectId) as PipelineEffectIntent | undefined;
    if (!effect || effect.kind !== "stop" || effect.status !== "processing") {
      throw new Error(`pipeline stop effect ${input.effectId} is not processing`);
    }
    const timestamp = now();
    const dead = db.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'dead', next_attempt_at = ?, last_error = ?
      WHERE id = ? AND status = 'processing'
    `).run(timestamp, input.error, effect.id);
    if (dead.changes !== 1) throw new Error(`pipeline stop effect ${input.effectId} changed during exhaustion`);
    const payload = canonicalJson({
      runId: input.runId,
      owner: input.owner,
      reason: input.error,
    });
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, ?, 'quarantine', ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      `quarantine-${effect.id}`,
      effect.pipeline_instance_id,
      effect.transition_version,
      `quarantine:${effect.id}`,
      payload,
      digestNormalized(payload),
      timestamp,
      timestamp
    );
  });

  return {
    getEffect(id) {
      return db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?")
        .get(id) as PipelineEffectIntent | undefined;
    },
    claimEffects,
    recordEffectAcknowledgement,
    markStopEffectExhausted,
    markEffectFailed(effectId, error, retryAt) {
      const timestamp = now();
      const status = markQueueFailed({
        error,
        retryAt,
        timestamp,
        update: (statusValue, nextAttemptAt, errorValue) => db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = ?, next_attempt_at = COALESCE(?, ?), last_error = ?
        WHERE id = ? AND status = 'processing'
      `).run(statusValue, nextAttemptAt, timestamp, errorValue, effectId).changes,
      });
      if (!status) throw new Error(`pipeline effect ${effectId} is not processing`);
    },
  };
}
