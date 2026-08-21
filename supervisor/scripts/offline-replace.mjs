#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_ARGS = 64;
const MAX_INHERITED_ENV = 64;
const MAX_ARGUMENT_BYTES = 4_000;
const MAX_ENV_NAME_BYTES = 128;
const DEFAULT_HOOK_TIMEOUT_MS = 7_200_000;
const MIN_HOOK_TIMEOUT_MS = 100;
const MAX_HOOK_TIMEOUT_MS = 86_400_000;
const PROCESS_GROUP_QUIESCENCE_POLL_MS = 25;
const HELP = `Usage: offline-replace.mjs /absolute/path/to/manifest.json

Runs one authenticated, offline fresh-epoch replacement. Use --help to show this text.
OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS sets the executor-owned per-hook deadline.
`;
const COMMAND_NAMES = [
  "verify_preconditions",
  "start_candidate",
  "smoke_ordinary",
  "smoke_structured",
  "reopen_ingress",
  "stop_candidate",
  "restore_old",
];
const RESERVED_ENV = new Set([
  "OT_OFFLINE_REPLACEMENT_OPERATION",
  "OT_OFFLINE_REPLACEMENT_REASON",
  "OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS",
]);

function fail(detail) {
  throw new Error(`offline replacement manifest: ${detail}`);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function exactKeys(value, expected, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${source} must be an object`);
  if (!hasExactKeys(value, expected)) fail(`${source} has unknown or missing fields`);
}

function boundedString(value, source, max) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > max ||
    value.includes("\0")
  ) {
    fail(`${source} must be a non-empty bounded string`);
  }
  return value;
}

function command(value, source) {
  exactKeys(value, ["executable", "sha256", "args", "inherit_env"], source);
  const executable = boundedString(value.executable, `${source}.executable`, MAX_ARGUMENT_BYTES);
  if (!isAbsolute(executable) || resolve(executable) !== executable || executable === "/") {
    fail(`${source}.executable must be an absolute normalized non-root path`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    fail(`${source}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!Array.isArray(value.args) || value.args.length > MAX_COMMAND_ARGS) {
    fail(`${source}.args must be a bounded array`);
  }
  const args = value.args.map((entry, index) =>
    boundedString(entry, `${source}.args[${index}]`, MAX_ARGUMENT_BYTES));
  if (!Array.isArray(value.inherit_env) || value.inherit_env.length > MAX_INHERITED_ENV) {
    fail(`${source}.inherit_env must be a bounded environment-name allowlist`);
  }
  const inherited = new Set();
  const inheritEnv = value.inherit_env.map((entry, index) => {
    const name = boundedString(entry, `${source}.inherit_env[${index}]`, MAX_ENV_NAME_BYTES);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`${source}.inherit_env[${index}] is not a valid environment name`);
    }
    if (RESERVED_ENV.has(name)) {
      fail(`${source}.inherit_env may not claim executor-owned ${name}`);
    }
    if (inherited.has(name)) fail(`${source}.inherit_env contains duplicate ${name}`);
    inherited.add(name);
    return name;
  });
  return Object.freeze({
    executable,
    sha256: value.sha256,
    args: Object.freeze(args),
    inherit_env: Object.freeze(inheritEnv),
  });
}

function manifestPath() {
  const argument = process.argv[2];
  if (process.argv.length !== 3 || !argument || !isAbsolute(argument) || resolve(argument) !== argument) {
    fail("usage: offline-replace.mjs /absolute/path/to/manifest.json");
  }
  const stats = lstatSync(argument);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_MANIFEST_BYTES) {
    fail("input must be a regular bounded JSON file");
  }
  return realpathSync(argument);
}

function executableSnapshot(stats) {
  return Object.freeze([
    stats.dev,
    stats.ino,
    stats.mode,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ]);
}

function sameSnapshot(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function inspectExecutable(commandValue, source, expectedSnapshot) {
  let before;
  try {
    before = lstatSync(commandValue.executable, { bigint: true });
  } catch (error) {
    fail(`${source}.executable is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${source}.executable must be a regular non-symlink file`);
  }
  if (before.size < 1n || before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    fail(`${source}.executable must be a non-empty bounded file`);
  }
  if ((before.mode & 0o111n) === 0n) {
    fail(`${source}.executable is not executable`);
  }
  let resolved;
  try {
    resolved = realpathSync(commandValue.executable);
    accessSync(commandValue.executable, constants.X_OK);
  } catch (error) {
    fail(`${source}.executable is not executable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolved !== commandValue.executable) {
    fail(`${source}.executable must equal its real path`);
  }
  const digest = createHash("sha256").update(readFileSync(commandValue.executable)).digest("hex");
  const after = lstatSync(commandValue.executable, { bigint: true });
  const beforeSnapshot = executableSnapshot(before);
  const afterSnapshot = executableSnapshot(after);
  if (!sameSnapshot(beforeSnapshot, afterSnapshot)) {
    fail(`${source}.executable changed while it was authenticated`);
  }
  if (digest !== commandValue.sha256) {
    fail(expectedSnapshot === undefined
      ? `${source}.sha256 does not match its executable`
      : `${source}.executable changed after preflight`);
  }
  if (expectedSnapshot !== undefined && !sameSnapshot(afterSnapshot, expectedSnapshot)) {
    fail(`${source}.executable identity changed after preflight`);
  }
  return afterSnapshot;
}

function preflightCommands(commands) {
  return Object.freeze(Object.fromEntries(COMMAND_NAMES.map((name) => [
    name,
    inspectExecutable(commands[name], `commands.${name}`),
  ])));
}

function revalidateCommands(commands, identities) {
  for (const name of COMMAND_NAMES) {
    inspectExecutable(commands[name], `commands.${name}`, identities[name]);
  }
}

function childEnvironment(commandValue, label, reason) {
  const environment = Object.create(null);
  for (const name of commandValue.inherit_env) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.OT_OFFLINE_REPLACEMENT_OPERATION = label;
  if (reason !== undefined) environment.OT_OFFLINE_REPLACEMENT_REASON = reason;
  return environment;
}

function hookTimeoutMs() {
  const raw = process.env.OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOOK_TIMEOUT_MS;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < MIN_HOOK_TIMEOUT_MS ||
    value > MAX_HOOK_TIMEOUT_MS
  ) {
    throw new Error(
      `OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS must be an integer between ${MIN_HOOK_TIMEOUT_MS} and ${MAX_HOOK_TIMEOUT_MS}`,
    );
  }
  return value;
}

function signalProcessGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError?.code !== "ESRCH") throw fallbackError;
    }
  }
}

function processGroupIsQuiescent(child) {
  if (!Number.isSafeInteger(child.pid)) return true;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function readManifest() {
  const parsed = JSON.parse(readFileSync(manifestPath(), "utf8"));
  exactKeys(parsed, ["replacement", "commands"], "root");
  exactKeys(parsed.commands, COMMAND_NAMES, "commands");
  return {
    replacement: parsed.replacement,
    commands: Object.fromEntries(COMMAND_NAMES.map((name) => [
      name,
      command(parsed.commands[name], `commands.${name}`),
    ])),
  };
}

function run(commandValue, identity, label, timeoutMs, reason) {
  return new Promise((resolvePromise, reject) => {
    const environment = childEnvironment(commandValue, label, reason);
    inspectExecutable(commandValue, `commands.${label}`, identity);
    const child = spawn(commandValue.executable, commandValue.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let terminalError;
    let forceKillTimer;
    let quiescenceTimer;
    let leaderExited = false;
    let killPhaseComplete = false;
    const terminationGraceMs = Math.min(5_000, Math.max(100, Math.floor(timeoutMs / 10)));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (quiescenceTimer !== undefined) clearTimeout(quiescenceTimer);
      if (error) reject(error);
      else resolvePromise(result);
    };
    const maybeFinishTermination = () => {
      if (terminalError === undefined || !leaderExited || !killPhaseComplete) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(terminalError);
    };
    const awaitGroupQuiescence = () => {
      try {
        if (processGroupIsQuiescent(child)) {
          killPhaseComplete = true;
          maybeFinishTermination();
          return;
        }
        signalProcessGroup(child, "SIGKILL");
      } catch (signalError) {
        terminalError = new Error(
          `${terminalError.message}; failed to verify ${label} process-group quiescence: ${signalError instanceof Error ? signalError.message : String(signalError)}`,
        );
      }
      quiescenceTimer = setTimeout(awaitGroupQuiescence, PROCESS_GROUP_QUIESCENCE_POLL_MS);
    };
    const terminate = (error) => {
      if (terminalError !== undefined) return;
      terminalError = error;
      try {
        signalProcessGroup(child, "SIGTERM");
      } catch (signalError) {
        terminalError = new Error(
          `${error.message}; failed to terminate ${label}: ${signalError instanceof Error ? signalError.message : String(signalError)}`,
        );
      }
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch (signalError) {
          terminalError = new Error(
            `${terminalError.message}; failed to kill ${label}: ${signalError instanceof Error ? signalError.message : String(signalError)}`,
          );
        }
        awaitGroupQuiescence();
      }, terminationGraceMs);
    };
    const timeoutTimer = setTimeout(() => {
      terminate(new Error(`${label} exceeded executor-owned timeout of ${timeoutMs}ms`));
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      if (terminalError !== undefined) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminate(new Error(`${label} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (child.pid === undefined) finish(error);
      else terminate(error);
    });
    child.once("exit", () => {
      leaderExited = true;
      maybeFinishTermination();
    });
    child.once("close", (status, signal) => {
      if (terminalError !== undefined) {
        maybeFinishTermination();
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (status !== 0) {
        finish(new Error(`${label} failed (${signal ?? status}): ${errorText.slice(0, 1_000)}`));
        return;
      }
      let result;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        finish(new Error(`${label} did not return one JSON object`));
        return;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        finish(new Error(`${label} did not return one JSON object`));
        return;
      }
      finish(undefined, result);
    });
  });
}

async function main() {
  const timeoutMs = hookTimeoutMs();
  const manifest = readManifest();
  const identities = preflightCommands(manifest.commands);
  const { runOfflineReplacement } = await import("../dist/persistence/offline-replacement.js");
  const invoke = async (name, reason) => {
    const result = await run(manifest.commands[name], identities[name], name, timeoutMs, reason);
    revalidateCommands(manifest.commands, identities);
    return result;
  };
  const generic = async (name, reason) => {
    const result = await invoke(name, reason);
    if (!hasExactKeys(result, ["evidence"]) || typeof result.evidence !== "string") {
      throw new Error(`${name} output must contain only evidence`);
    }
    return result.evidence;
  };

  const observePreconditions = async () => {
    const result = await invoke("verify_preconditions");
    const expectedKeys = [
      "active_work_clear",
      "blob_root",
      "database_path",
      "evidence",
      "ingress_closed",
      "old_release_id",
      "old_runtime_capability_digest",
      "supervisors_stopped",
      "workers_stopped",
    ];
    if (
      !hasExactKeys(result, expectedKeys) ||
      typeof result.old_release_id !== "string" ||
      typeof result.old_runtime_capability_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.old_runtime_capability_digest) ||
      typeof result.database_path !== "string" ||
      typeof result.blob_root !== "string" ||
      typeof result.evidence !== "string" ||
      result.ingress_closed !== true ||
      result.active_work_clear !== true ||
      result.supervisors_stopped !== true ||
      result.workers_stopped !== true
    ) {
      throw new Error(
        "verify_preconditions output must bind the exact old tuple and prove closed ingress, clear active work, and stopped writers",
      );
    }
    return result;
  };

  const restoreOld = async (reason) => {
    const result = await invoke("restore_old", reason);
    const expectedKeys = [
      "archive_manifest_digest",
      "blob_root",
      "database_path",
      "evidence",
      "old_release_id",
      "old_runtime_capability_digest",
    ];
    if (
      !hasExactKeys(result, expectedKeys) ||
      typeof result.old_release_id !== "string" ||
      typeof result.old_runtime_capability_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.old_runtime_capability_digest) ||
      typeof result.database_path !== "string" ||
      typeof result.blob_root !== "string" ||
      typeof result.archive_manifest_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.archive_manifest_digest) ||
      typeof result.evidence !== "string"
    ) {
      throw new Error("restore_old output must bind the exact old tuple and archive manifest");
    }
    return result;
  };

  const report = await runOfflineReplacement(manifest.replacement, {
    observePreconditions,
    startCandidate: async () => generic("start_candidate"),
    runSmoke: async (kind) => {
      const result = await invoke(`smoke_${kind}`);
      if (
        !hasExactKeys(result, ["evidence", "id", "status"]) ||
        typeof result.id !== "string" || result.status !== "passed" ||
        typeof result.evidence !== "string"
      ) throw new Error(`smoke_${kind} output must be {id,status:"passed",evidence}`);
      return result;
    },
    reopenIngress: async () => generic("reopen_ingress"),
    stopCandidate: async (reason) => generic("stop_candidate", reason),
    restoreOld,
  });

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    report_path: manifest.replacement.report_path,
    report_digest: report.report_digest,
  })}\n`);
}

if (process.argv.length === 3 && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  process.stdout.write(HELP);
} else {
  await main();
}
