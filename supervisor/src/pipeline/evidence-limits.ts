// One transport budget covers a maximum valid tune proposal plus the
// supervisor-owned citation/ratchet/authorization evidence derived from it.
// Ordinary stages remain subject to their stricter coordinator and gate caps.
export const TUNE_ARTIFACT_PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

// The outer JSON event escapes artifact JSON strings, so it needs bounded
// headroom above a single tune artifact without widening agent activities.
export const SEALED_STAGE_RESULT_LIMIT_BYTES = 4 * 1024 * 1024;
