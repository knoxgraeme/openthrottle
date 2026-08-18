import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import type { PipelineEffectIntent, PipelineInstance, PipelineStore, PipelineTaskBranch } from "../../pipeline/store.js";
import { claimLeasable, markQueueFailed } from "./helpers.js";
import { sanitizeText } from "../../shared/sanitize.js";

interface TaskBranchEffectControl {
  schema: "openthrottle.task-branch-effect/v1";
  pipelineInstanceId: string;
  ticketId: string;
  generation: number;
  repository: string;
  ref: string;
  planDigest: string;
  lineage: string;
  expectedOldSha: string | null;
  expectedNewSha: string;
}

function parseTaskBranchControl(effect: PipelineEffectIntent): TaskBranchEffectControl {
  const control = JSON.parse(effect.payload) as Partial<TaskBranchEffectControl>;
  if (
    control.schema !== "openthrottle.task-branch-effect/v1" ||
    typeof control.pipelineInstanceId !== "string" ||
    typeof control.ticketId !== "string" ||
    !Number.isSafeInteger(control.generation) ||
    typeof control.repository !== "string" ||
    typeof control.ref !== "string" ||
    typeof control.planDigest !== "string" ||
    typeof control.lineage !== "string" ||
    (control.expectedOldSha !== null && typeof control.expectedOldSha !== "string") ||
    typeof control.expectedNewSha !== "string"
  ) throw new Error(`pipeline task branch effect ${effect.id} has an invalid control payload`);
  return control as TaskBranchEffectControl;
}

function isTaskBranchEffect(effect: Pick<PipelineEffectIntent, "kind">): boolean {
  return effect.kind === "create_task_branch" || effect.kind === "advance_task_branch";
}

export function createEffectStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "getEffect" | "getTaskBranch" | "queueTaskBranchAdvance" | "claimEffects" |
  "recordEffectAcknowledgement" | "markEffectFailed" | "markStopEffectExhausted"
> {
  const getTaskBranch = (instanceId: string): PipelineTaskBranch | undefined =>
    db.prepare("SELECT * FROM pipeline_task_branches WHERE pipeline_instance_id = ?")
      .get(instanceId) as PipelineTaskBranch | undefined;

  const claimEffects = db.transaction((
    nowIso: string,
    leaseUntilIso: string,
    limit = 4
  ): PipelineEffectIntent[] => {
    const candidates = db.prepare(`
      SELECT current.id FROM pipeline_effect_intents current
      WHERE ((current.status IN ('pending', 'failed') AND current.next_attempt_at <= ?)
        OR (current.status = 'processing' AND current.next_attempt_at <= ?))
        AND (
          current.kind = 'advance_task_branch' OR NOT EXISTS (
            SELECT 1 FROM pipeline_effect_intents earlier
            WHERE earlier.pipeline_instance_id = current.pipeline_instance_id
              AND (
                earlier.status NOT IN ('acknowledged', 'dead') OR
                (earlier.status = 'dead' AND earlier.kind IN ('create_task_branch', 'advance_task_branch'))
              )
              AND (
                earlier.transition_version < current.transition_version OR
                (earlier.transition_version = current.transition_version AND earlier.created_at < current.created_at) OR
                (earlier.transition_version = current.transition_version AND earlier.created_at = current.created_at
                  AND earlier.id < current.id)
              )
          )
        )
        AND (
          current.kind IN (
            'create_task_branch', 'advance_task_branch', 'idle', 'stop', 'quarantine', 'cleanup'
          ) OR NOT EXISTS (
            SELECT 1 FROM pipeline_task_branches branch
            WHERE branch.pipeline_instance_id = current.pipeline_instance_id
              AND branch.accepted_integration_sha IS NOT NULL
              AND branch.accepted_integration_sha IS NOT branch.acknowledged_remote_sha
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
    if (isTaskBranchEffect(effect)) {
      const control = parseTaskBranchControl(effect);
      const result = JSON.parse(input.payload) as { sha?: unknown };
      if (result.sha !== control.expectedNewSha) {
        throw new Error(`pipeline task branch effect ${effect.id} acknowledged the wrong remote SHA`);
      }
      const branch = getTaskBranch(effect.pipeline_instance_id);
      if (
        !branch ||
        branch.ticket_id !== control.ticketId ||
        branch.generation !== control.generation ||
        branch.repository !== control.repository ||
        `refs/heads/${branch.branch}` !== control.ref ||
        branch.plan_digest !== control.planDigest ||
        branch.lineage !== control.lineage ||
        instance.id !== control.pipelineInstanceId ||
        instance.generation !== control.generation
      ) throw new Error(`pipeline task branch effect ${effect.id} lineage mismatch`);
      const branchUpdate = effect.kind === "create_task_branch"
        ? db.prepare(`
            UPDATE pipeline_task_branches
            SET acknowledged_remote_sha = ?, status = 'reserved', last_error = NULL, updated_at = ?
            WHERE pipeline_instance_id = ? AND status = 'pending'
              AND base_sha = ? AND acknowledged_remote_sha IS NULL
          `).run(control.expectedNewSha, timestamp, branch.pipeline_instance_id, control.expectedNewSha)
        : db.prepare(`
            UPDATE pipeline_task_branches
            SET acknowledged_remote_sha = ?, status = 'checkpointed', last_error = NULL, updated_at = ?
            WHERE pipeline_instance_id = ? AND status IN ('reserved', 'checkpointed', 'published')
              AND accepted_integration_sha = ? AND acknowledged_remote_sha = ?
          `).run(
            control.expectedNewSha,
            timestamp,
            branch.pipeline_instance_id,
            control.expectedNewSha,
            control.expectedOldSha
          );
      if (branchUpdate.changes !== 1) {
        throw new Error(`pipeline task branch effect ${effect.id} checkpoint changed before acknowledgement`);
      }
    }
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

  const queueTaskBranchAdvance = db.transaction((input: {
    instanceId: string;
    generation: number;
    lineage: string;
    expectedOldSha: string;
    expectedNewSha: string;
  }): PipelineEffectIntent => {
    if (!/^[a-f0-9]{40}$/.test(input.expectedOldSha) || !/^[a-f0-9]{40}$/.test(input.expectedNewSha)) {
      throw new Error("pipeline task branch advancement requires exact commit SHAs");
    }
    if (input.expectedOldSha === input.expectedNewSha) {
      throw new Error("pipeline task branch advancement must move to a new commit");
    }
    const instance = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?")
      .get(input.instanceId) as PipelineInstance | undefined;
    const branch = getTaskBranch(input.instanceId);
    if (!instance || !branch || instance.generation !== input.generation ||
        branch.generation !== input.generation || branch.lineage !== input.lineage) {
      throw new Error("pipeline task branch advancement has a stale lineage");
    }
    const idempotencyKey = `advance-task-branch:${branch.lineage}:${input.expectedOldSha}:${input.expectedNewSha}`;
    const existing = db.prepare("SELECT * FROM pipeline_effect_intents WHERE idempotency_key = ?")
      .get(idempotencyKey) as PipelineEffectIntent | undefined;
    if (existing) {
      if (branch.accepted_integration_sha !== input.expectedNewSha) {
        throw new Error("pipeline task branch advancement was accepted differently");
      }
      const expectedRemote = existing.status === "acknowledged"
        ? input.expectedNewSha
        : input.expectedOldSha;
      if (branch.acknowledged_remote_sha !== expectedRemote) {
        throw new Error("pipeline task branch advancement acknowledgement changed incompatibly");
      }
      return existing;
    }
    if (!["reserved", "checkpointed", "published"].includes(branch.status) ||
        branch.acknowledged_remote_sha !== input.expectedOldSha) {
      throw new Error("pipeline task branch advancement expected head mismatch");
    }
    if (branch.accepted_integration_sha !== null &&
        branch.accepted_integration_sha !== branch.acknowledged_remote_sha) {
      throw new Error("pipeline task branch already has an unacknowledged integration");
    }
    const timestamp = now();
    const accepted = db.prepare(`
      UPDATE pipeline_task_branches
      SET accepted_integration_sha = ?, status = 'reserved', last_error = NULL, updated_at = ?
      WHERE pipeline_instance_id = ? AND generation = ? AND lineage = ?
        AND acknowledged_remote_sha = ? AND status IN ('reserved', 'checkpointed', 'published')
    `).run(
      input.expectedNewSha,
      timestamp,
      input.instanceId,
      input.generation,
      input.lineage,
      input.expectedOldSha
    );
    if (accepted.changes !== 1) throw new Error("pipeline task branch changed before integration acceptance");
    const transitionVersion = (db.prepare(`
      SELECT COALESCE(MAX(transition_version), 0) + 1 AS version
      FROM pipeline_effect_intents WHERE pipeline_instance_id = ?
    `).get(input.instanceId) as { version: number }).version;
    const payload = canonicalJson({
      schema: "openthrottle.task-branch-effect/v1",
      pipelineInstanceId: input.instanceId,
      ticketId: branch.ticket_id,
      generation: input.generation,
      repository: branch.repository,
      ref: `refs/heads/${branch.branch}`,
      planDigest: branch.plan_digest,
      lineage: branch.lineage,
      expectedOldSha: input.expectedOldSha,
      expectedNewSha: input.expectedNewSha,
    });
    const id = `task-branch-${digestNormalized(payload).slice(0, 32)}`;
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, ?, 'advance_task_branch', ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      input.instanceId,
      transitionVersion,
      idempotencyKey,
      payload,
      digestNormalized(payload),
      timestamp,
      timestamp
    );
    return db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?").get(id) as PipelineEffectIntent;
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

  const markEffectFailed = db.transaction((
    effectId: string,
    error: string,
    retryAt: string | null
  ): void => {
    const timestamp = now();
    const effect = db.prepare(`
      SELECT kind, pipeline_instance_id FROM pipeline_effect_intents WHERE id = ?
    `).get(effectId) as Pick<PipelineEffectIntent, "kind" | "pipeline_instance_id"> | undefined;
    const boundedError = sanitizeText(error).slice(-2_000);
    const status = markQueueFailed({
      error: boundedError,
      retryAt,
      timestamp,
      update: (statusValue, nextAttemptAt, errorValue) => db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = ?, next_attempt_at = COALESCE(?, ?), last_error = ?
        WHERE id = ? AND status = 'processing'
      `).run(statusValue, nextAttemptAt, timestamp, errorValue, effectId).changes,
    });
    if (!status) throw new Error(`pipeline effect ${effectId} is not processing`);
    if (effect && isTaskBranchEffect(effect)) {
      db.prepare(`
        UPDATE pipeline_task_branches
        SET status = CASE WHEN ? = 'dead' THEN 'failed' ELSE status END,
            last_error = ?, updated_at = ?
        WHERE pipeline_instance_id = ?
      `).run(status, boundedError, timestamp, effect.pipeline_instance_id);
    }
  });

  return {
    getEffect(id) {
      return db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?")
        .get(id) as PipelineEffectIntent | undefined;
    },
    getTaskBranch,
    queueTaskBranchAdvance,
    claimEffects,
    recordEffectAcknowledgement,
    markStopEffectExhausted,
    markEffectFailed,
  };
}
