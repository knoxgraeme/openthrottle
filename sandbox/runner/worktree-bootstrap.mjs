#!/usr/bin/env node

// Unit worktrees are created bare (`git worktree add --detach`) from the
// integration checkout, so they never inherit the ignored dependency state
// the bake-once post_bootstrap installed there (SPEC: Sandbox stage
// contract). Before the first repository command executes in a unit
// worktree, the executor re-runs the sealed config's post_bootstrap
// commands inside that worktree -- the repository's own declared way to make
// a fresh checkout runnable -- once per worktree under a root-owned marker
// the agent UID can neither read nor forge.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write.mjs";
import { sanitizeArtifactText } from "./artifacts.mjs";
import { pathInside } from "./filesystem-isolation.mjs";
import { REPOSITORY_COMMAND_TIMEOUT_MS } from "./execute-stage.mjs";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MARKER_ROOT = "/var/lib/openthrottle/worktree-bootstrap";
const MARKER_SCHEMA = "openthrottle.worktree-bootstrap/v1";
const ERROR_OUTPUT_TAIL = 500;

function safeHandle(value) {
  if (typeof value !== "string" || !HANDLE.test(value)) throw new Error("worktree bootstrap handle is invalid");
  return value;
}

export function worktreeBootstrapMarkerPath({ markerRootDir = DEFAULT_MARKER_ROOT, handle } = {}) {
  return pathInside(markerRootDir, `${safeHandle(handle)}.json`, "worktree bootstrap marker escapes its root");
}

export function removeWorktreeBootstrapMarker({ markerRootDir = DEFAULT_MARKER_ROOT, handle } = {}) {
  rmSync(worktreeBootstrapMarkerPath({ markerRootDir, handle }), { force: true });
}

function describeFailure(execution) {
  if (execution.timedOut) return "timed out";
  if (execution.signal) return `terminated by signal ${execution.signal}`;
  return `exited with ${execution.exitCode}`;
}

// Runs the sealed post_bootstrap once per worktree before the first
// repository command executes there. Every failure here throws so the child
// action classifies as retryable infrastructure (childActionFailureResult),
// never as a command receipt: a worktree without its dependency state is an
// executor provisioning defect, not agent work to repair. The started marker
// makes an interrupted arbitrary bootstrap observable: replay fails closed
// instead of repeating side effects in-place. Removing or freshly recreating
// the disposable worktree clears the marker and permits one new attempt.
export function ensureWorktreeBootstrap({
  worktreeDir,
  handle,
  config,
  configDigest,
  executeCommand,
  markerRootDir = DEFAULT_MARKER_ROOT,
  commandTimeoutMs = REPOSITORY_COMMAND_TIMEOUT_MS,
}) {
  const commands = config?.post_bootstrap ?? [];
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.length === 0)) {
    throw new Error("sealed repository config post_bootstrap is invalid");
  }
  if (commands.length === 0) return { bootstrapped: false, commands: 0 };
  const safeWorktree = safeHandle(handle);
  const markerPath = worktreeBootstrapMarkerPath({ markerRootDir, handle: safeWorktree });
  if (existsSync(markerPath)) {
    let marker;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      throw new Error("worktree bootstrap marker is unreadable");
    }
    if (marker?.schema !== MARKER_SCHEMA ||
        marker?.worktree !== safeWorktree ||
        marker?.repositoryConfigDigest !== configDigest) {
      throw new Error("worktree bootstrap marker does not match the sealed repository config");
    }
    if (marker.state === "started") {
      throw new Error("worktree bootstrap started but never completed; the worktree must be recreated");
    }
    if (marker.state !== "completed") {
      throw new Error("worktree bootstrap marker is unreadable");
    }
    return { bootstrapped: false, commands: commands.length };
  }
  writeJsonAtomic(markerPath, {
    schema: MARKER_SCHEMA,
    state: "started",
    worktree: safeWorktree,
    repositoryConfigDigest: configDigest,
    startedAt: new Date().toISOString(),
  });
  for (const command of commands) {
    const execution = executeCommand({ command, repoDir: worktreeDir, timeoutMs: commandTimeoutMs });
    if (execution.exitCode !== 0 || execution.timedOut || execution.signal) {
      const tail = sanitizeArtifactText(execution.stderr || execution.stdout || "").slice(-ERROR_OUTPUT_TAIL);
      throw new Error(
        `worktree bootstrap command ${describeFailure(execution)}: ${command}${tail ? `: ${tail}` : ""}`
      );
    }
  }
  writeJsonAtomic(markerPath, {
    schema: MARKER_SCHEMA,
    state: "completed",
    worktree: safeWorktree,
    repositoryConfigDigest: configDigest,
    completedAt: new Date().toISOString(),
  });
  return { bootstrapped: true, commands: commands.length };
}
