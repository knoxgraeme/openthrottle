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

// Push the activity straight to the supervisor. Throws on any network error
// or non-2xx response so the caller can fall back to the on-disk outbox.
// Uses the global `fetch` (Node 22+) rather than a dependency.
export async function postActivityEvent(event, supervisorUrl, token) {
  const response = await fetch(`${supervisorUrl}/runs/${event.run_id}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(`supervisor responded ${response.status}`);
  }
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

  // Prefer a direct push to the supervisor; only fall back to the atomic
  // outbox-file write if that fails (no SUPERVISOR_URL/token configured,
  // network error, or a non-2xx response).
  const supervisorUrl = process.env.SUPERVISOR_URL;
  const token = process.env.RUN_CALLBACK_TOKEN;
  if (supervisorUrl && token) {
    try {
      await postActivityEvent(event, supervisorUrl, token);
      return;
    } catch {
      // fall through to the outbox fallback below
    }
  }

  const outboxDir = resolve(process.env.OT_OUTBOX_DIR ?? "/home/agent/.ot/outbox");
  await writeActivityEvent(event, outboxDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ot-activity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
