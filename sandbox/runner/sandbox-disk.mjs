#!/usr/bin/env node

import { lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TEMPORARY_PREFIXES = [
  "ot-kernel-checkpoint-",
  "ot-kernel-action-index-",
  "ot-provider-result-",
  "ot-stage-output-",
  "ot-kernel-integration-",
];
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const MAX_DF_OUTPUT_BYTES = 16 * 1024;
const MAX_FAILURES = 32;
const MAX_FAILURE_CHARS = 240;
const DISK_PATHS = ["/var/lib/openthrottle", "/home/agent", "/tmp"];

export const SANDBOX_SCRATCH_ROOTS = Object.freeze({
  actions: "/var/lib/openthrottle/actions",
  actionInput: "/var/lib/openthrottle/action-input",
  actionResults: "/var/lib/openthrottle/action-results",
  actionFences: "/var/lib/openthrottle/action-fences",
  integrationInput: "/var/lib/openthrottle/integration-input",
  integrationResults: "/var/lib/openthrottle/integration-results",
  temporary: "/tmp",
  legacyNpmCache: "/home/agent/.npm",
});

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} is unsafe for sandbox scratch reclamation`);
  }
  return value;
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("lease generation is unsafe for sandbox scratch reclamation");
  }
  return value;
}

function directoryEntries(path, failure) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    failure(`inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    failure(`refused non-directory or symlinked scratch root ${path}`);
    return [];
  }
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    failure(`read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function defaultRemove(path, timeoutMs) {
  const execution = spawnSync("/bin/rm", ["-rf", "--", path], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (execution.error?.code === "ETIMEDOUT") {
    return { ok: false, timedOut: true, detail: `deletion timed out for ${path}` };
  }
  if (execution.error || execution.status !== 0) {
    const detail = execution.error?.message || execution.stderr?.trim() ||
      `deletion exited ${execution.status ?? "without status"}`;
    return { ok: false, timedOut: false, detail };
  }
  return { ok: true, timedOut: false, detail: null };
}

function defaultDf(paths, timeoutMs) {
  const execution = spawnSync("/bin/df", ["-Pk", ...paths], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_DF_OUTPUT_BYTES,
  });
  if (execution.error?.code === "ETIMEDOUT") {
    throw new Error("sandbox disk inspection timed out");
  }
  if (execution.error || execution.status !== 0) {
    const detail = execution.error?.message || execution.stderr?.trim() ||
      `df exited ${execution.status ?? "without status"}`;
    throw new Error(`sandbox disk inspection failed: ${detail}`);
  }
  return execution.stdout;
}

/**
 * Inspects the fixed runtime paths with POSIX df output and reports each
 * distinct backing filesystem once. The injected runner is solely a test seam;
 * callers cannot select additional filesystem paths through the CLI.
 */
export function inspectSandboxDisk({
  requiredKiB,
  paths = DISK_PATHS,
  timeoutMs = DEFAULT_INSPECTION_TIMEOUT_MS,
  runDf = defaultDf,
} = {}) {
  if (!Number.isSafeInteger(requiredKiB) || requiredKiB < 1) {
    throw new Error("sandbox disk required KiB is invalid");
  }
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16 ||
      paths.some((path) => typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path)) {
    throw new Error("sandbox disk inspection paths are invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("sandbox disk inspection timeout is invalid");
  }
  const raw = runDf(paths, timeoutMs);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_DF_OUTPUT_BYTES) {
    throw new Error("sandbox disk inspection output is invalid or oversized");
  }
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length !== paths.length + 1 || !/^Filesystem\s+1024-blocks\s+Used\s+Available\s+Capacity\s+Mounted on\s*$/.test(lines[0] ?? "")) {
    throw new Error("sandbox disk inspection output has an invalid POSIX header or row count");
  }
  const filesystems = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
    if (!match) throw new Error("sandbox disk inspection output has an invalid filesystem row");
    const availableKiB = Number(match[4]);
    if (!Number.isSafeInteger(availableKiB)) {
      throw new Error("sandbox disk inspection available capacity is invalid");
    }
    const key = `${match[1]}\0${match[6]}`;
    const existing = filesystems.get(key);
    if (existing) {
      existing.paths.push(paths[index]);
    } else {
      filesystems.set(key, {
        filesystem: match[1],
        mount: match[6],
        available_kib: availableKiB,
        paths: [paths[index]],
        low: availableKiB < requiredKiB,
      });
    }
  }
  const observations = [...filesystems.values()];
  return {
    schema: "openthrottle.sandbox-disk-inspection/v1",
    required_kib: requiredKiB,
    low: observations.some((filesystem) => filesystem.low),
    filesystems: observations,
  };
}

/**
 * Reclaims only reconstructible scratch beneath fixed runtime roots. The caller
 * names the sole live launch; all roots and identifiers are validated before a
 * deletion is attempted, and symlink targets are never followed or removed.
 */
export function reclaimSandboxScratch({
  current,
  roots = SANDBOX_SCRATCH_ROOTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  remove = defaultRemove,
  requireRoot = true,
} = {}) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("current sandbox launch is required for scratch reclamation");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("sandbox scratch reclamation timeout is invalid");
  }
  let normalized;
  if (current.kind === "action") {
    const phase = current.phase === "work" ? "work" : current.phase === "correction" ? "correction" : null;
    if (phase === null) throw new Error("action phase is unsafe for sandbox scratch reclamation");
    normalized = {
      kind: "action",
      attempt: safeId(current.attempt, "attempt ID"),
      lease: safeId(current.lease, "lease ID"),
      phase,
      generation: safeGeneration(current.generation),
    };
  } else if (current.kind === "integration") {
    normalized = {
      kind: "integration",
      effect: safeId(current.effect, "effect ID"),
      lease: safeId(current.lease, "dispatch lease ID"),
    };
  } else {
    throw new Error("sandbox launch kind is unsafe for scratch reclamation");
  }
  if (requireRoot && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
    throw new Error("sandbox scratch reclamation must run as root");
  }
  for (const [label, path] of Object.entries(roots)) {
    if (typeof path !== "string" || !path.startsWith("/") || resolve(path) !== path || path === "/") {
      throw new Error(`${label} scratch root is unsafe`);
    }
  }

  const startedAt = now();
  const removedClasses = new Set();
  const failures = [];
  let timedOut = false;
  const failure = (detail) => {
    if (failures.length < MAX_FAILURES) failures.push(String(detail).slice(0, MAX_FAILURE_CHARS));
  };
  const remaining = () => Math.max(0, timeoutMs - (now() - startedAt));
  const removeEntry = (root, entry, storageClass, { directoryOnly = true } = {}) => {
    if (timedOut) return;
    const budget = remaining();
    if (budget < 1) {
      timedOut = true;
      failure("sandbox scratch reclamation timed out");
      return;
    }
    if (entry.isSymbolicLink() || (directoryOnly && !entry.isDirectory())) {
      failure(`refused unsafe ${storageClass} entry ${entry.name}`);
      return;
    }
    const outcome = remove(resolve(root, entry.name), budget);
    if (outcome?.ok) {
      removedClasses.add(storageClass);
      return;
    }
    if (outcome?.timedOut) timedOut = true;
    failure(`${storageClass}: ${outcome?.detail ?? "deletion failed"}`);
  };
  const cleanIdentities = (root, storageClass, preserveIdentity = null, cleanPreserved = null) => {
    if (timedOut) return;
    for (const entry of directoryEntries(root, failure)) {
      if (timedOut) break;
      if (!SAFE_ID.test(entry.name)) {
        failure(`refused unsafe ${storageClass} entry ${entry.name}`);
        continue;
      }
      if (entry.name !== preserveIdentity) {
        removeEntry(root, entry, storageClass);
      } else if (cleanPreserved !== null) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          failure(`refused unsafe active ${storageClass} entry ${entry.name}`);
        } else {
          cleanPreserved(resolve(root, entry.name));
        }
      }
    }
  };
  const cleanLaunchChildren = (
    root,
    storageClass,
    preservedNames,
    managed,
    { directoryOnly = true } = {},
  ) => {
    if (timedOut) return;
    for (const entry of directoryEntries(root, failure)) {
      if (timedOut) break;
      if (preservedNames.has(entry.name)) continue;
      if (!managed(entry)) continue;
      removeEntry(root, entry, storageClass, { directoryOnly });
    }
  };
  const anySafeEntryName = (entry) => SAFE_ID.test(entry.name);

  if (normalized.kind === "action") {
    const launch = `${normalized.phase}-${normalized.lease}`;
    cleanIdentities(roots.actions, "action_materializations", normalized.attempt);
    cleanIdentities(roots.actionInput, "action_input", normalized.attempt, (active) => {
      cleanLaunchChildren(active, "action_input", new Set([launch]), anySafeEntryName);
    });
    cleanIdentities(roots.actionResults, "action_results", normalized.attempt, (active) => {
      cleanLaunchChildren(active, "action_results", new Set([launch, "dispatch.lock"]), anySafeEntryName);
    });
    cleanIdentities(roots.actionFences, "action_fences", normalized.attempt, (active) => {
      const stage = `lease-generation-${normalized.lease}-${normalized.generation}.part`;
      cleanLaunchChildren(
        active,
        "action_fences",
        new Set(["lease-generation.json", "lease-generation.lock", stage]),
        (entry) => /^lease-generation-[A-Za-z0-9][A-Za-z0-9._-]{0,159}-[0-9]+\.part$/.test(entry.name),
        { directoryOnly: false },
      );
    });
    cleanIdentities(roots.integrationInput, "integration_input");
    cleanIdentities(roots.integrationResults, "integration_results");
  } else {
    cleanIdentities(roots.actions, "action_materializations");
    cleanIdentities(roots.actionInput, "action_input");
    cleanIdentities(roots.actionResults, "action_results");
    cleanIdentities(roots.actionFences, "action_fences");
    cleanIdentities(roots.integrationInput, "integration_input", normalized.effect, (active) => {
      cleanLaunchChildren(active, "integration_input", new Set([normalized.lease]), anySafeEntryName);
    });
    cleanIdentities(roots.integrationResults, "integration_results", normalized.effect, (active) => {
      cleanLaunchChildren(active, "integration_results", new Set([normalized.lease]), anySafeEntryName);
    });
  }

  if (!timedOut) {
    for (const entry of directoryEntries(roots.temporary, failure)) {
      if (timedOut) break;
      if (!TEMPORARY_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
      removeEntry(roots.temporary, entry, "runner_temporary");
    }
  }
  if (!timedOut) {
    for (const entry of directoryEntries(roots.legacyNpmCache, failure)) {
      if (timedOut) break;
      removeEntry(roots.legacyNpmCache, entry, "legacy_npm_cache", { directoryOnly: false });
    }
  }

  return {
    schema: "openthrottle.sandbox-scratch-reclamation/v1",
    removed_classes: [...removedClasses].sort(),
    failures,
    timed_out: timedOut,
  };
}

function parseCli(argv) {
  const kind = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
      throw new Error("sandbox scratch reclamation arguments are invalid");
    }
    values.set(flag, value);
  }
  if (kind === "action" && values.size === 4) {
    return {
      kind,
      attempt: values.get("--attempt"),
      lease: values.get("--lease"),
      phase: values.get("--phase"),
      generation: Number(values.get("--generation")),
    };
  }
  if (kind === "integration" && values.size === 2) {
    return { kind, effect: values.get("--effect"), lease: values.get("--lease") };
  }
  throw new Error("sandbox scratch reclamation arguments are invalid");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const result = argv[0] === "check" && argv.length === 3 && argv[1] === "--required-kib"
      ? inspectSandboxDisk({ requiredKiB: Number(argv[2]) })
      : reclaimSandboxScratch({ current: parseCli(argv) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 64;
  }
}
