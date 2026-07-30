import { spawnSync } from "node:child_process";
import { sanitizeArtifactText } from "./artifacts.mjs";

function terminateAgentProcesses() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const result = spawnSync("pkill", ["-KILL", "-u", "agent"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error("agent process cleanup timed out");
  // pkill exits 1 when the agent has no remaining processes, which is the
  // expected steady state after a well-behaved CLI exits.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`agent process cleanup failed: ${sanitizeArtifactText(result.stderr ?? result.error?.message ?? "").slice(-800)}`);
  }
}

export function runWithAgentProcessFence(execute, terminate = terminateAgentProcesses) {
  try {
    return execute();
  } finally {
    // Executor-owned evidence must not be collected while escaped agent
    // processes can still mutate the repository or action-local state.
    terminate();
  }
}
