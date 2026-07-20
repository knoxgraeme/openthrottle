#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACTIVITY_TYPES = new Set(["thought", "action", "elicitation", "response", "error"]);
const MAX_BODY_LENGTH = 8_000;
const MAX_PLAN_ITEMS = 50;
const MAX_PLAN_CONTENT = 500;

// Friendly aliases → Linear's four canonical plan statuses, so an agent can
// write `done`/`running`/`skip` and still produce a valid plan.
const PLAN_STATUS_ALIASES = {
  pending: "pending", todo: "pending", queued: "pending", waiting: "pending", blocked: "pending",
  inprogress: "inProgress", "in-progress": "inProgress", active: "inProgress",
  running: "inProgress", doing: "inProgress", wip: "inProgress",
  completed: "completed", complete: "completed", done: "completed", passed: "completed", ok: "completed",
  canceled: "canceled", cancelled: "canceled", skip: "canceled", skipped: "canceled",
  gap: "canceled", na: "canceled", "n/a": "canceled",
};

export function buildActivityEvent({ runId, type, message, action, parameter, result }) {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error("RUN_ID is missing or unsafe");
  }
  if (!ACTIVITY_TYPES.has(type)) {
    throw new Error(`Unsupported activity type: ${type}`);
  }

  // An `action` renders in Linear as verb + parameter, optionally with a
  // result once the step completes ("Ran · pnpm test · 583 passed") — much
  // more legible than the flat "Progress: <text>" every action used to carry.
  // A bare 1-arg action stays backward-compatible as a Progress note.
  if (type === "action") {
    const verb = String(action ?? "Progress").trim();
    const param = String(parameter ?? message ?? "").trim();
    if (!param) throw new Error("Action activity requires a parameter");
    if (verb.length > 200) throw new Error("Action verb must be at most 200 characters");
    const res = result === undefined || result === null ? undefined : String(result).trim();
    if (verb.length + param.length + (res?.length ?? 0) > MAX_BODY_LENGTH) {
      throw new Error(`Action fields must be at most ${MAX_BODY_LENGTH.toLocaleString()} characters`);
    }
    return {
      version: 1,
      kind: "activity",
      event_id: randomUUID(),
      run_id: runId,
      created_at: new Date().toISOString(),
      type: "action",
      action: verb,
      parameter: param,
      ...(res ? { result: res } : {}),
      // A human summary for the private log and the DB dedup payload.
      body: res ? `${verb}: ${param} → ${res}` : `${verb}: ${param}`,
    };
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

export function normalizePlanStatus(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  const mapped = PLAN_STATUS_ALIASES[key];
  if (!mapped) {
    throw new Error(`Unsupported plan status: ${raw} (use pending|inProgress|completed|canceled)`);
  }
  return mapped;
}

// Parse one `Content=status` CLI token into a plan item. Splits on the LAST
// `=` so plan content may itself contain `=`.
export function parsePlanItem(arg) {
  const text = String(arg);
  const idx = text.lastIndexOf("=");
  if (idx < 0) {
    throw new Error(`Plan item must be "content=status": ${arg}`);
  }
  const content = text.slice(0, idx).trim();
  if (!content) throw new Error(`Plan item is missing content: ${arg}`);
  if (content.length > MAX_PLAN_CONTENT) {
    throw new Error(`Plan item content must be at most ${MAX_PLAN_CONTENT} characters`);
  }
  return { content, status: normalizePlanStatus(text.slice(idx + 1)) };
}

export function buildPlanEvent({ runId, items }) {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error("RUN_ID is missing or unsafe");
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_PLAN_ITEMS) {
    throw new Error(`Plan must have between 1 and ${MAX_PLAN_ITEMS} items`);
  }
  return {
    version: 1,
    kind: "plan",
    event_id: randomUUID(),
    run_id: runId,
    created_at: new Date().toISOString(),
    plan: items,
  };
}

// Writes any outbox event (activity or plan). The filename carries the kind so
// the supervisor can tell them apart; ordering is by the timestamp prefix.
export async function writeActivityEvent(event, outboxDir) {
  await mkdir(outboxDir, { recursive: true, mode: 0o700 });
  const prefix = String(Date.parse(event.created_at)).padStart(13, "0");
  const finalPath = join(outboxDir, `${prefix}-${event.kind}-${event.event_id}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function main() {
  const [type, ...rest] = process.argv.slice(2);
  const outboxDir = resolve(process.env.OT_OUTBOX_DIR ?? "/home/agent/.ot/outbox");

  if (type === "plan") {
    if (rest.length === 0) {
      throw new Error('Usage: ot-activity plan "<content>=<status>" ["<content>=<status>" ...]');
    }
    const event = buildPlanEvent({ runId: process.env.RUN_ID, items: rest.map(parsePlanItem) });
    await writeActivityEvent(event, outboxDir);
    return;
  }

  if (!type || rest.length === 0) {
    throw new Error(
      "Usage: ot-activity <thought|elicitation|response|error> <message>\n" +
        '       ot-activity action <verb> <parameter> [<result>]   (or a single progress note)\n' +
        '       ot-activity plan "<content>=<status>" ...'
    );
  }

  let event;
  if (type === "action" && rest.length >= 2) {
    // action <verb> <parameter> [<result...>]
    const [actionVerb, parameter, ...resultParts] = rest;
    event = buildActivityEvent({
      runId: process.env.RUN_ID,
      type: "action",
      action: actionVerb,
      parameter,
      result: resultParts.length ? resultParts.join(" ") : undefined,
    });
  } else {
    // Any single-argument form (incl. a bare `action <note>`) is a plain message.
    event = buildActivityEvent({
      runId: process.env.RUN_ID,
      type,
      message: rest.join(" "),
    });
  }
  await writeActivityEvent(event, outboxDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`ot-activity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
