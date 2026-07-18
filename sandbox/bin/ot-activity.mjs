#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACTIVITY_TYPES = new Set(["thought", "action", "elicitation", "response", "error"]);
const MAX_BODY_LENGTH = 8_000;

export function buildActivityEvent({ runId, type, message }) {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error("RUN_ID is missing or unsafe");
  }
  if (!ACTIVITY_TYPES.has(type)) {
    throw new Error(`Unsupported activity type: ${type}`);
  }
  const body = String(message ?? "").trim();
  if (!body) throw new Error("Activity message must not be empty");
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`Activity message must be at most ${MAX_BODY_LENGTH.toLocaleString()} characters`);
  }
  return {
    version: 1,
    kind: "activity",
    event_id: randomUUID(),
    run_id: runId,
    created_at: new Date().toISOString(),
    type,
    body,
  };
}

export async function writeActivityEvent(event, outboxDir) {
  await mkdir(outboxDir, { recursive: true, mode: 0o700 });
  const prefix = String(Date.parse(event.created_at)).padStart(13, "0");
  const finalPath = join(outboxDir, `${prefix}-activity-${event.event_id}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function main() {
  const [type, ...messageParts] = process.argv.slice(2);
  if (!type || messageParts.length === 0) {
    throw new Error("Usage: ot-activity <thought|action|elicitation|response|error> <message>");
  }
  const event = buildActivityEvent({
    runId: process.env.RUN_ID,
    type,
    message: messageParts.join(" "),
  });
  const outboxDir = resolve(process.env.OT_OUTBOX_DIR ?? "/home/agent/.ot/outbox");
  await writeActivityEvent(event, outboxDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ot-activity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
