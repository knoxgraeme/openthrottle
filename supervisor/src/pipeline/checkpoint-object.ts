export const GIT_CHECKPOINT_OBJECT_SCHEMA = "openthrottle.git-checkpoint-object/v1" as const;
export const GIT_CHECKPOINT_OBJECT_FILE = "checkpoint.bundle";
export const MAX_GIT_CHECKPOINT_OBJECT_BYTES = 64 * 1024 * 1024;

export interface GitCheckpointObject {
  schema: typeof GIT_CHECKPOINT_OBJECT_SCHEMA;
  expectedOldSha: string;
  expectedNewSha: string;
  payloadSha256: string;
  payloadBytes: number;
  payload: Uint8Array;
}

export type GitCheckpointPayload = Pick<
  GitCheckpointObject,
  "payload" | "payloadBytes" | "payloadSha256"
>;
