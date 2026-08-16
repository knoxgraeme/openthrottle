import { spawnSync } from "node:child_process";
import { sanitizeArtifactText } from "./artifacts.mjs";

const AGENT_PROCESS_FENCE_TIMEOUT_MS = 10_000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function userUid(user) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const result = spawnSync("id", ["-u", user], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.status !== 0 || !/^\d+\n?$/.test(result.stdout)) {
    throw new Error(`action process fence could not resolve the installed ${user} uid`);
  }
  return result.stdout.trim();
}

export function liveAgentPidsFromPs(stdout) {
  return String(stdout ?? "").split("\n").flatMap((line) => {
    const match = line.trim().match(/^([1-9][0-9]*)\s+(\S+)/);
    if (!match) return [];
    // Zombies are already dead and cannot mutate executor-owned state. They
    // may remain until their parent reaps them, and SIGKILL cannot remove them.
    return match[2].includes("Z") ? [] : [match[1]];
  });
}

function agentPids(uid) {
  const result = spawnSync("ps", ["-o", "pid=,stat=", "-u", uid], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error("agent process enumeration timed out");
  if (result.status === 1) return [];
  if (result.error || result.status !== 0) {
    throw new Error(`agent process enumeration failed: ${sanitizeArtifactText(result.stderr ?? result.error?.message ?? "").slice(-800)}`);
  }
  return liveAgentPidsFromPs(result.stdout);
}

function convergeUserProcessesToEmpty(user) {
  const uid = userUid(user);
  if (!uid) return;
  const deadline = Date.now() + AGENT_PROCESS_FENCE_TIMEOUT_MS;
  let signaled = false;
  while (Date.now() <= deadline) {
    const pids = agentPids(uid);
    if (pids.length === 0) return;
    if (!signaled) {
      const result = spawnSync("pkill", ["-KILL", "-u", uid], {
        encoding: "utf8",
        timeout: 2_000,
      });
      if (result.error?.code === "ETIMEDOUT") throw new Error("agent process cleanup timed out");
      if (result.error || (result.status !== 0 && result.status !== 1)) {
        throw new Error(`agent process cleanup failed: ${sanitizeArtifactText(result.stderr ?? result.error?.message ?? "").slice(-800)}`);
      }
      signaled = true;
    }
    sleepMs(100);
  }
  throw new Error("agent process cleanup did not converge to empty");
}

function unconfirmedTerminationError(error) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.retryableInfrastructureFailure = true;
  wrapped.processTerminationUnconfirmed = true;
  return wrapped;
}

export function runWithUserProcessFence(user, execute, terminate = convergeUserProcessesToEmpty) {
  const converge = () => terminate(user);
  try {
    converge();
  } catch (error) {
    throw unconfirmedTerminationError(error);
  }
  try {
    return execute();
  } finally {
    // Executor-owned evidence must not be collected while escaped agent
    // processes can still mutate the repository or action-local state.
    try {
      converge();
    } catch (error) {
      throw unconfirmedTerminationError(error);
    }
  }
}

export function runWithAgentProcessFence(execute, terminate) {
  return runWithUserProcessFence(
    "agent",
    execute,
    terminate ? () => terminate() : convergeUserProcessesToEmpty,
  );
}
