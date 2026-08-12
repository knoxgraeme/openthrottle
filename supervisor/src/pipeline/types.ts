export type Agent = "claude" | "codex" | "opencode";

// The pipeline intent is selected at delegation. Continuation happens inside
// stage attempts through pinned native-session policy, not as a task type.
export type TaskType = "implement" | "investigate" | "tune";
