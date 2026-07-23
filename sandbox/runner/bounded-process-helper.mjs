#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";

const input = JSON.parse(readFileSync(0, "utf8"));
const captureBytes = Number.isSafeInteger(input.captureBytes) && input.captureBytes >= 1024
  ? Math.min(input.captureBytes, 16 * 1024 * 1024)
  : 2 * 1024 * 1024;
let timedOut = false;
let terminationTimer;
let killTimer;
let settled = false;

class BoundedOutput extends Writable {
  constructor(limit) {
    super();
    this.limit = limit;
    this.head = Buffer.alloc(Math.floor(limit / 2));
    this.tail = Buffer.alloc(limit - this.head.length);
    this.headLength = 0;
    this.tailLength = 0;
    this.tailOffset = 0;
    this.total = 0;
  }

  _write(value, _encoding, callback) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.total += chunk.length;
    let offset = 0;
    if (this.headLength < this.head.length) {
      const copied = Math.min(chunk.length, this.head.length - this.headLength);
      chunk.copy(this.head, this.headLength, 0, copied);
      this.headLength += copied;
      offset = copied;
    }
    const remainder = chunk.subarray(offset);
    if (remainder.length >= this.tail.length) {
      remainder.copy(this.tail, 0, remainder.length - this.tail.length);
      this.tailLength = this.tail.length;
      this.tailOffset = 0;
    } else if (remainder.length > 0) {
      const first = Math.min(remainder.length, this.tail.length - this.tailOffset);
      remainder.copy(this.tail, this.tailOffset, 0, first);
      if (first < remainder.length) remainder.copy(this.tail, 0, first);
      this.tailOffset = (this.tailOffset + remainder.length) % this.tail.length;
      this.tailLength = Math.min(this.tail.length, this.tailLength + remainder.length);
    }
    callback();
  }

  orderedTail() {
    if (this.tailLength < this.tail.length) return this.tail.subarray(0, this.tailLength);
    return Buffer.concat([this.tail.subarray(this.tailOffset), this.tail.subarray(0, this.tailOffset)]);
  }

  value() {
    const head = this.head.subarray(0, this.headLength);
    const tail = this.orderedTail();
    if (this.total <= this.limit) return Buffer.concat([head, tail]);
    const marker = Buffer.from(`\n...[${this.total - this.limit} output bytes omitted]...\n`);
    const retained = Math.max(0, this.limit - marker.length);
    const headLength = Math.min(head.length, Math.floor(retained / 2));
    const tailLength = Math.min(tail.length, retained - headLength);
    return Buffer.concat([
      head.subarray(0, headLength),
      marker,
      tail.subarray(tail.length - tailLength),
    ]);
  }
}

const stdout = new BoundedOutput(captureBytes);
const stderr = new BoundedOutput(captureBytes);

const child = spawn(input.command, input.args, {
  cwd: input.cwd ?? undefined,
  env: input.env ?? process.env,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);

function signalGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function finish(result) {
  if (settled) return;
  settled = true;
  if (terminationTimer) clearTimeout(terminationTimer);
  if (killTimer) clearTimeout(killTimer);
  writeFileSync(input.stdoutPath, stdout.value());
  writeFileSync(input.stderrPath, stderr.value());
  process.stdout.write(JSON.stringify({ ...result, timedOut }));
}

child.once("error", (error) => {
  finish({ status: null, signal: null, error: { code: error.code ?? null, message: error.message } });
});
child.once("exit", () => {
  // Do not let a background descendant keep the capture pipes open or outlive
  // the direct command. The outer agent-user fence remains a second boundary.
  signalGroup("SIGKILL");
});
child.once("close", (status, signal) => {
  finish({ status, signal, error: null });
});
child.stdin.on("error", () => {});
child.stdin.end(input.input ?? undefined);

if (Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
  terminationTimer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), input.killAfterMs ?? 5_000);
  }, input.timeoutMs);
}
