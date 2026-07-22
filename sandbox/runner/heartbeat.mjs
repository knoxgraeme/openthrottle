#!/usr/bin/env node
// Root-launched executor heartbeat. This pulse is independent of agent output,
// so quiet commands and bootstrap work renew liveness without manufacturing a
// semantic Linear activity.

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const runId = process.env.RUN_ID;
const heartbeatFile = process.env.OT_HEARTBEAT_FILE ||
  "/var/lib/openthrottle/heartbeat/heartbeat.json";
const parsedInterval = Number(process.env.OT_EXECUTOR_HEARTBEAT_INTERVAL_MS);
const intervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 1_000
  ? parsedInterval
  : 15_000;

export function buildExecutorHeartbeat(id, createdAt, targetRunId = runId) {
  if (!targetRunId) throw new Error("RUN_ID is required for executor heartbeat");
  return {
    version: 1,
    kind: "heartbeat",
    event_id: id,
    run_id: targetRunId,
    created_at: createdAt,
  };
}

export function emitExecutorHeartbeat() {
  const createdAt = new Date().toISOString();
  const event = buildExecutorHeartbeat(randomUUID(), createdAt);
  mkdirSync(dirname(heartbeatFile), { recursive: true, mode: 0o700 });
  const temporary = `${heartbeatFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  renameSync(temporary, heartbeatFile);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!runId) throw new Error("RUN_ID is required for executor heartbeat");
  emitExecutorHeartbeat();
  const timer = setInterval(emitExecutorHeartbeat, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
