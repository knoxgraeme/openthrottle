import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_ATTEMPT_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SCRATCH_ROOT_NAMES = new Set(["actions", "action-input", "action-results", "action-fences"]);

function childPath(parent, entry) {
  return Buffer.concat([
    Buffer.isBuffer(parent) ? parent : Buffer.from(parent),
    Buffer.from(sep),
    entry,
  ]);
}

function safeAttemptEntry(entry) {
  const name = Buffer.isBuffer(entry) ? entry.toString("latin1") : entry;
  return SAFE_ATTEMPT_DIRECTORY.test(name);
}

function allocatedBytes(path) {
  let total = 0n;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = lstatSync(current, { bigint: true });
    total += typeof metadata.blocks === "bigint"
      ? metadata.blocks * 512n
      : metadata.size;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    for (const entry of readdirSync(current, { encoding: "buffer" })) {
      pending.push(childPath(current, entry));
    }
  }
  return total;
}

function immediateAttemptRoot(path, expectedAttemptDirectory) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const attemptDirectory = dirname(dirname(resolve(path)));
  if (basename(attemptDirectory) !== expectedAttemptDirectory) return null;
  const root = dirname(attemptDirectory);
  return root === "/" ? null : root;
}

function immediateFenceRoot(path, expectedAttemptDirectory) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const attemptDirectory = dirname(resolve(path));
  if (basename(attemptDirectory) !== expectedAttemptDirectory) return null;
  const root = dirname(attemptDirectory);
  return root === "/" ? null : root;
}

function immediateActionRoot(actionRoot, actionDirectory) {
  const root = resolve(actionRoot);
  return root !== "/" && dirname(actionDirectory) === root ? root : null;
}

function containsPath(parent, candidate) {
  const child = relative(parent, candidate);
  return child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function pathsOverlap(left, right) {
  return containsPath(left, right) || containsPath(right, left);
}

function allowedScratchRoot(root, stateRoot, sourceRepoDir) {
  if (root === null || dirname(root) !== stateRoot || !SCRATCH_ROOT_NAMES.has(basename(root))) return null;
  return pathsOverlap(root, resolve(sourceRepoDir)) ? null : root;
}

function scratchRoots({
  attemptId,
  sourceRepoDir,
  actionRoot,
  actionDirectory,
  requestPath,
  resultPath,
  leaseGenerationFencePath,
}) {
  const stateRoot = dirname(resolve(actionRoot));
  const actionEntry = basename(actionDirectory);
  const candidates = [
    [immediateActionRoot(actionRoot, actionDirectory), actionEntry],
    [immediateAttemptRoot(requestPath, attemptId), attemptId],
    [immediateAttemptRoot(resultPath, attemptId), attemptId],
    [immediateFenceRoot(leaseGenerationFencePath, attemptId), attemptId],
  ];
  const roots = new Map();
  const conflictedRoots = new Set();
  for (const [candidate, preservedEntry] of candidates) {
    const root = allowedScratchRoot(candidate, stateRoot, sourceRepoDir);
    if (root === null || conflictedRoots.has(root) || !safeAttemptEntry(preservedEntry)) continue;
    const previous = roots.get(root);
    if (previous !== undefined && previous !== preservedEntry) {
      // Overlapping configured roots with different live entries are unsafe to
      // interpret. Preserve the entire root instead of choosing an allowlist.
      roots.delete(root);
      conflictedRoots.add(root);
      continue;
    }
    roots.set(root, preservedEntry);
  }
  return roots;
}

export function reclaimSettledAttemptScratch({
  attemptId,
  sourceRepoDir,
  actionRoot,
  actionDirectory,
  requestPath = null,
  resultPath,
  leaseGenerationFencePath = null,
  log = null,
}) {
  let reclaimedBytes = 0n;
  let reclaimedDirectories = 0;
  for (const [root, preservedEntry] of scratchRoots({
    attemptId,
    sourceRepoDir,
    actionRoot,
    actionDirectory,
    requestPath,
    resultPath,
    leaseGenerationFencePath,
  })) {
    if (!existsSync(root)) continue;
    const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) continue;
    const preservedEntryBytes = Buffer.from(preservedEntry);
    for (const entry of readdirSync(root, { encoding: "buffer" })) {
      if (entry.equals(preservedEntryBytes) || !safeAttemptEntry(entry)) continue;
      const path = childPath(root, entry);
      const metadata = lstatSync(path);
      // Scratch roots are executor-owned. Only physical attempt directories are
      // eligible; unexpected files and links survive for explicit inspection.
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      reclaimedBytes += allocatedBytes(path);
      rmSync(path, { recursive: true, force: true });
      reclaimedDirectories += 1;
    }
  }
  const summary = `sandbox scratch: reclaimed ${reclaimedBytes} bytes from ${reclaimedDirectories} settled-attempt directories`;
  if (log) log(summary);
  return { reclaimed_bytes: reclaimedBytes, reclaimed_directories: reclaimedDirectories, summary };
}
