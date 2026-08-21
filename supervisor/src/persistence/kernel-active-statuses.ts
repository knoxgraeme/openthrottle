export const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
export const ACTIVE_ATTEMPT_STATUSES = [
  "pending", "running", "work_complete", "result_pending", "recorded",
] as const;
export const ACTIVE_EFFECT_STATUSES = ["pending", "processing", "unknown"] as const;

export const ACTIVE_RUN_STATUS_SET: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);
