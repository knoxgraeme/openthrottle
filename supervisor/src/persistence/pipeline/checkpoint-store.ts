import type Database from "better-sqlite3";
import { GIT_CHECKPOINT_OBJECT_SCHEMA } from "../../pipeline/checkpoint-object.js";
import type {
  DurableExecutionCheckpointObject,
  ExecutionUnitStore,
} from "./unit-store.js";

interface CheckpointRow {
  action_id: string;
  effect_id: string;
  expected_old_sha: string;
  expected_new_sha: string;
  payload_sha256: string;
  payload_bytes: number;
  payload: Buffer;
}

function checkpointObject(row: CheckpointRow | undefined): DurableExecutionCheckpointObject | undefined {
  return row ? {
    schema: GIT_CHECKPOINT_OBJECT_SCHEMA,
    actionId: row.action_id,
    effectId: row.effect_id,
    expectedOldSha: row.expected_old_sha,
    expectedNewSha: row.expected_new_sha,
    payloadSha256: row.payload_sha256,
    payloadBytes: row.payload_bytes,
    payload: row.payload,
  } : undefined;
}

export function createCheckpointStore(db: Database.Database): Pick<ExecutionUnitStore, "getCheckpointObject"> {
  return {
    getCheckpointObject(effectId) {
      const structured = db.prepare(`
        SELECT action_id, effect_id, expected_old_sha, expected_new_sha,
               payload_sha256, payload_bytes, payload
        FROM execution_checkpoint_objects
        WHERE effect_id = ?
      `).get(effectId) as CheckpointRow | undefined;
      if (structured) return checkpointObject(structured);
      const ordinary = db.prepare(`
        SELECT attempt_id AS action_id, effect_id, expected_old_sha, expected_new_sha,
               payload_sha256, payload_bytes, payload
        FROM pipeline_stage_checkpoint_objects
        WHERE effect_id = ?
      `).get(effectId) as CheckpointRow | undefined;
      return checkpointObject(ordinary);
    },
  };
}
