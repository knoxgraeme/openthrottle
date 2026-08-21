#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runOfflineReplacement } from "../dist/persistence/offline-replacement.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_ARGS = 64;
const COMMAND_NAMES = [
  "verify_preconditions",
  "start_candidate",
  "smoke_ordinary",
  "smoke_structured",
  "reopen_ingress",
  "stop_candidate",
  "restore_old",
];

function fail(detail) {
  throw new Error(`offline replacement manifest: ${detail}`);
}

function exactKeys(value, expected, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${source} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(`${source} has unknown or missing fields`);
  }
}

function command(value, source) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMAND_ARGS) {
    fail(`${source} must be a non-empty bounded argv array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 4_000 || entry.includes("\0")) {
      fail(`${source}[${index}] is not a bounded argument`);
    }
    return entry;
  });
}

function manifestPath() {
  const argument = process.argv[2];
  if (!argument || !isAbsolute(argument) || resolve(argument) !== argument) {
    fail("usage: offline-replace.mjs /absolute/path/to/manifest.json");
  }
  const stats = lstatSync(argument);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_MANIFEST_BYTES) {
    fail("input must be a regular bounded JSON file");
  }
  return realpathSync(argument);
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

function run(argv, label, reason) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OT_OFFLINE_REPLACEMENT_OPERATION: label,
        ...(reason === undefined ? {} : { OT_OFFLINE_REPLACEMENT_REASON: reason }),
      },
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error(`${label} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (status !== 0) {
        reject(new Error(`${label} failed (${signal ?? status}): ${errorText.slice(0, 1_000)}`));
        return;
      }
      let result;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new Error(`${label} did not return one JSON object`));
        return;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        reject(new Error(`${label} did not return one JSON object`));
        return;
      }
      resolvePromise(result);
    });
  });
}

const manifest = readManifest();
const generic = async (name, reason) => {
  const result = await run(manifest.commands[name], name, reason);
  if (Object.keys(result).sort().join(",") !== "evidence" || typeof result.evidence !== "string") {
    throw new Error(`${name} output must contain only evidence`);
  }
  return result.evidence;
};

const observePreconditions = async () => {
  const result = await run(
    manifest.commands.verify_preconditions,
    "verify_preconditions",
  );
  const expectedKeys = [
    "active_work_clear",
    "blob_root",
    "database_path",
    "evidence",
    "ingress_closed",
    "old_release_id",
    "supervisors_stopped",
    "workers_stopped",
  ];
  if (
    Object.keys(result).sort().join(",") !== expectedKeys.sort().join(",") ||
    typeof result.old_release_id !== "string" ||
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

const report = await runOfflineReplacement(manifest.replacement, {
  observePreconditions,
  startCandidate: async () => generic("start_candidate"),
  runSmoke: async (kind) => {
    const result = await run(manifest.commands[`smoke_${kind}`], `smoke_${kind}`);
    if (
      Object.keys(result).sort().join(",") !== "evidence,id,status" ||
      typeof result.id !== "string" || result.status !== "passed" ||
      typeof result.evidence !== "string"
    ) throw new Error(`smoke_${kind} output must be {id,status:"passed",evidence}`);
    return result;
  },
  reopenIngress: async () => generic("reopen_ingress"),
  stopCandidate: async (reason) => generic("stop_candidate", reason),
  restoreOld: async (reason) => generic("restore_old", reason),
});

process.stdout.write(`${JSON.stringify({
  status: report.status,
  report_path: manifest.replacement.report_path,
  report_digest: report.report_digest,
})}\n`);
