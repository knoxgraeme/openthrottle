import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROCESS_HELPER = fileURLToPath(new URL("./bounded-process-helper.mjs", import.meta.url));
const DEFAULT_KILL_AFTER_MS = 5_000;
const EXIT_DRAIN_MS = 250;
const HELPER_DEADLINE_SLACK_MS = 1_000;
const MAX_PID_FILE_BYTES = 32;

function readCapturedWindow(path, maxBytes) {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return "";
    if (size <= maxBytes) {
      const output = Buffer.alloc(size);
      readSync(descriptor, output, 0, size, 0);
      return output.toString("utf8");
    }
    const headSize = Math.floor(maxBytes / 2);
    const tailSize = maxBytes - headSize;
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    readSync(descriptor, head, 0, headSize, 0);
    readSync(descriptor, tail, 0, tailSize, size - tailSize);
    return `${head.toString("utf8")}\n...[${size - maxBytes} output bytes omitted]...\n${tail.toString("utf8")}`;
  } finally {
    closeSync(descriptor);
  }
}

function readRecordedChildPid(path) {
  const descriptor = openSync(path, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_PID_FILE_BYTES) {
      throw new Error("bounded process helper recorded an invalid child PID");
    }
    if (metadata.size === 0) return null;
    const contents = Buffer.alloc(metadata.size);
    readSync(descriptor, contents, 0, metadata.size, 0);
    const value = contents.toString("utf8");
    if (!/^[1-9][0-9]{0,9}\n?$/.test(value)) {
      throw new Error("bounded process helper recorded an invalid child PID");
    }
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2_147_483_647) {
      throw new Error("bounded process helper recorded an invalid child PID");
    }
    return pid;
  } finally {
    closeSync(descriptor);
  }
}

function killRecordedChildGroup(path) {
  const pid = readRecordedChildPid(path);
  if (pid === null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function helperFailure(helper, helperDeadlineMs, cleanupError) {
  const diagnostics = [];
  if (helper.error?.code === "ETIMEDOUT" && helperDeadlineMs !== undefined) {
    diagnostics.push(`timed out after ${helperDeadlineMs}ms`);
  }
  if (helper.error?.message) diagnostics.push(helper.error.message);
  if (helper.signal) diagnostics.push(`terminated by ${helper.signal}`);
  if (helper.status !== null && helper.status !== 0) diagnostics.push(`exited with status ${helper.status}`);
  if (helper.stderr?.trim()) diagnostics.push(helper.stderr.trim());
  if (cleanupError) diagnostics.push(`command process-group cleanup failed: ${cleanupError.message}`);
  const failure = new Error(`bounded process helper failed: ${diagnostics.join("; ") || "unknown error"}`);
  if (helper.error?.code) failure.code = helper.error.code;
  return failure;
}

// A trusted async helper owns a detached process group and escalates
// SIGTERM -> SIGKILL. A private PID handoff lets the synchronous caller reap
// that group if its defense-in-depth helper deadline fires.
export function runCapturedProcess(command, args, {
  cwd,
  env,
  input,
  timeout,
  killAfterMs = DEFAULT_KILL_AFTER_MS,
  captureBytes = 2 * 1024 * 1024,
} = {}) {
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : null;
  const boundedKillAfterMs = Number.isFinite(killAfterMs) && killAfterMs >= 0
    ? killAfterMs
    : DEFAULT_KILL_AFTER_MS;
  const helperDeadlineMs = timeoutMs === null
    ? undefined
    : Math.ceil(timeoutMs + boundedKillAfterMs + EXIT_DRAIN_MS + HELPER_DEADLINE_SLACK_MS);
  const captureDir = mkdtempSync(join(tmpdir(), "ot-stage-output-"));
  const stdoutPath = join(captureDir, "stdout.log");
  const stderrPath = join(captureDir, "stderr.log");
  const childPidPath = join(captureDir, "child.pid");
  closeSync(openSync(stdoutPath, "w", 0o600));
  closeSync(openSync(stderrPath, "w", 0o600));
  closeSync(openSync(childPidPath, "w", 0o600));
  try {
    const helper = spawnSync(process.execPath, [PROCESS_HELPER], {
      input: JSON.stringify({
        command,
        args,
        cwd: cwd ?? null,
        env: env ?? null,
        input: input ?? null,
        timeoutMs,
        killAfterMs: boundedKillAfterMs,
        exitDrainMs: EXIT_DRAIN_MS,
        captureBytes,
        stdoutPath,
        stderrPath,
        childPidPath,
      }),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: helperDeadlineMs,
      killSignal: "SIGKILL",
    });
    if (helper.error || helper.status !== 0) {
      let cleanupError;
      try {
        killRecordedChildGroup(childPidPath);
      } catch (error) {
        cleanupError = error;
      }
      throw helperFailure(helper, helperDeadlineMs, cleanupError);
    }
    const metadata = JSON.parse(helper.stdout);
    return {
      status: metadata.status,
      signal: metadata.signal,
      timedOut: metadata.timedOut,
      error: metadata.error
        ? Object.assign(new Error(metadata.error.message), { code: metadata.error.code })
        : metadata.timedOut
          ? Object.assign(new Error("process timed out"), { code: "ETIMEDOUT" })
          : undefined,
      stdout: readCapturedWindow(stdoutPath, captureBytes),
      stderr: readCapturedWindow(stderrPath, captureBytes),
    };
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
}
