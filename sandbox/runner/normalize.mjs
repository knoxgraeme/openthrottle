#!/usr/bin/env node
// runner/normalize.mjs
//
// Line-buffered stdin JSONL processor sitting between the coding agent
// (claude, codex, or opencode) and the sandbox task log. See docs/SPEC.md
// "runner/normalize.mjs" for the contract. Pure Node, zero dependencies —
// only node: builtins, so it needs no npm install step in the image.
//
// Responsibilities:
//   - claude `--output-format stream-json`: capture `session_id` (from the
//     "system"/"init" event, and opportunistically from any later line that
//     carries one) and write it to ~/.ot/agent-session-id so a future
//     `TASK_TYPE=resume` run can `claude -p --resume <id>`.
//   - codex `exec --json`: capture the thread id from a `thread.started`
//     event and write it to the same file for `codex exec resume <id>`.
//   - Pretty-print assistant text / tool-use lines (claude) and
//     item.completed summaries (codex) into short human-readable lines.
//   - Unknown lines (valid JSON we don't recognize, or non-JSON output) are
//     passed through, truncated.
//   - Every line written to stdout is run through the sanitizer first.
//
// This process runs as the `agent` user (entrypoint.sh gosu's into it), so
// os.homedir() resolves to /home/agent and ~/.ot/agent-session-id lands in
// the right place.

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Sanitization — SPEC: redact values of all env vars whose names match
// (TOKEN|KEY|SECRET|PASSWORD), plus a fixed set of token-shape regexes.
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON)/i;

const SECRET_REGEXES = [
  /gh[opsu]_\w+/g,
  /github_pat_\w+/g,
  /sk-[\w-]+/g,
  /lin_(?:api|oauth)_\w+/g,
  /Bearer \S+/g,
];

function collectNestedSecretValues(value) {
  try {
    const parsed = JSON.parse(value);
    const nested = [];
    const visit = (item) => {
      if (typeof item === "string") {
        if (item.length >= 8) nested.push(item);
      } else if (Array.isArray(item)) {
        for (const child of item) visit(child);
      } else if (item && typeof item === "object") {
        for (const child of Object.values(item)) visit(child);
      }
    };
    visit(parsed);
    return nested;
  } catch {
    return [];
  }
}

export function collectEnvSecretValues(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && ENV_NAME_PATTERN.test(name)) {
      values.push(value);
      values.push(...collectNestedSecretValues(value));
    }
  }
  // Longest first so a value that happens to be a prefix/substring of
  // another secret value doesn't leave a partial leftover after replacing.
  return values.sort((a, b) => b.length - a.length);
}

const ENV_SECRET_VALUES = collectEnvSecretValues();

export function sanitize(text, secretValues = ENV_SECRET_VALUES) {
  let out = text;
  for (const value of secretValues) {
    if (!value) continue;
    out = out.split(value).join("[REDACTED]");
  }
  for (const re of SECRET_REGEXES) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session/thread id capture
// ---------------------------------------------------------------------------

const OT_DIR = join(homedir(), ".ot");
const SESSION_ID_FILE = join(OT_DIR, "agent-session-id");
let sessionIdWritten = false;

function writeSessionId(id) {
  if (sessionIdWritten || !id) return;
  const value = String(id).trim();
  if (!value) return;
  try {
    mkdirSync(OT_DIR, { recursive: true });
    writeFileSync(SESSION_ID_FILE, value + "\n", { mode: 0o600 });
    sessionIdWritten = true;
  } catch (err) {
    process.stderr.write(
      `[normalize] failed to write session id: ${err.message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Live progress heartbeat
//
// Every meaningful step the agent takes (a tool call, a shell command, a file
// edit) already flows through here on its way to the private task.log. We also
// mirror a *throttled, ephemeral* slice of it into the run's activity outbox as
// a `thought`, which the supervisor forwards to the Linear session. Ephemeral
// thoughts self-replace, so the session shows a live "currently: running
// `pnpm test`" pulse — the thing that answers "is it stuck or working?" —
// without cluttering the permanent timeline. Best-effort: a failure here must
// never disturb the log pipeline, so every write is guarded.
// ---------------------------------------------------------------------------

const HEARTBEAT_OUTBOX_DIR = process.env.OT_OUTBOX_DIR || join(OT_DIR, "outbox");
const HEARTBEAT_INTERVAL_MS = (() => {
  const raw = Number(process.env.OT_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
})();
const HEARTBEAT_BODY_LEN = 200;
let lastHeartbeatMs = 0;

// Pure throttle decision, exported so the cadence is table-testable without
// touching the clock or the filesystem.
export function shouldEmitHeartbeat(lastMs, nowMs, intervalMs = HEARTBEAT_INTERVAL_MS) {
  return nowMs - lastMs >= intervalMs;
}

// Pure builder for the outbox event, in the exact shape parseSandboxEvent
// accepts (kind:"activity", type:"thought", ephemeral:true).
export function buildHeartbeatEvent({ runId, summary, nowIso }) {
  return {
    version: 1,
    kind: "activity",
    event_id: randomUUID(),
    run_id: runId,
    created_at: nowIso,
    type: "thought",
    body: sanitize(String(summary)).trim().slice(0, HEARTBEAT_BODY_LEN),
    ephemeral: true,
  };
}

function maybeHeartbeat(summary) {
  const runId = process.env.RUN_ID;
  if (!runId || !summary) return;
  const body = String(summary).trim();
  if (!body) return;
  const now = Date.now();
  if (!shouldEmitHeartbeat(lastHeartbeatMs, now)) return;
  lastHeartbeatMs = now;
  try {
    const event = buildHeartbeatEvent({ runId, summary: body, nowIso: new Date().toISOString() });
    if (!event.body) return;
    mkdirSync(HEARTBEAT_OUTBOX_DIR, { recursive: true, mode: 0o700 });
    const finalPath = join(
      HEARTBEAT_OUTBOX_DIR,
      `${String(Date.parse(event.created_at)).padStart(13, "0")}-activity-${event.event_id}.json`,
    );
    const temporaryPath = `${finalPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, finalPath);
  } catch (err) {
    process.stderr.write(`[normalize] heartbeat emit failed: ${err.message}\n`);
  }
}

// Short, human "currently doing X" line for a Claude tool_use block.
export function summarizeToolUse(name, input) {
  const tool = String(name ?? "tool");
  const args = input ?? {};
  if (tool === "Bash" && typeof args.command === "string") {
    return `running: ${args.command}`;
  }
  if (typeof args.file_path === "string") {
    return `${tool} ${basename(args.file_path)}`;
  }
  return `running ${tool}`;
}

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0];
}

// `ot-activity` invocations already write their own semantic activity; a
// heartbeat for them is pure noise, and heartbeating a *terminal* ot-activity
// (elicitation/response/error) command would emit an ephemeral thought after
// the terminal event. Skip them.
export function isOtActivityCommand(command) {
  return /\bot-activity\b/.test(String(command ?? ""));
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const TRUNCATE_LEN = 2000;
const FINAL_RESPONSE_LEN = 8000;

export function truncate(str, len = TRUNCATE_LEN) {
  const s = String(str);
  if (s.length <= len) return s;
  return `${s.slice(0, len)}… [truncated ${s.length - len} chars]`;
}

function emit(line) {
  process.stdout.write(sanitize(line) + "\n");
}

function captureFinalResponse(text) {
  const body = sanitize(String(text ?? "")).trim();
  if (!body) return;
  runResult.final_response =
    body.length <= FINAL_RESPONSE_LEN ? body : body.slice(0, FINAL_RESPONSE_LEN);
}

// ---------------------------------------------------------------------------
// claude --output-format stream-json line handling
//
// Line shapes (per Claude Code stream-json output): {type: "system",
// subtype: "init", session_id, model, ...}, {type: "assistant", message:
// {content: [{type:"text",text} | {type:"tool_use",name,input}]}},
// {type: "user", message: {content: [{type:"tool_result", content}]}},
// {type: "result", subtype, is_error, num_turns, total_cost_usd, result}.
// ---------------------------------------------------------------------------

function handleClaudeLine(obj) {
  const looksLikeClaude =
    obj.type === "system" ||
    obj.type === "assistant" ||
    obj.type === "user" ||
    obj.type === "result";
  if (!looksLikeClaude) return false;

  if (typeof obj.session_id === "string") {
    writeSessionId(obj.session_id);
  }

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init") {
        emit(
          `[claude] session started (session_id=${obj.session_id ?? "unknown"}, model=${obj.model ?? "unknown"})`,
        );
      } else {
        emit(`[claude] system(${obj.subtype ?? "?"}): ${truncate(JSON.stringify(obj), 300)}`);
      }
      return true;
    }
    case "assistant": {
      const blocks = obj.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === "text" && block.text) {
          emit(`[claude] ${truncate(block.text)}`);
          maybeHeartbeat(firstLine(block.text));
        } else if (block?.type === "tool_use") {
          emit(
            `[claude] tool_use: ${block.name}(${truncate(JSON.stringify(block.input ?? {}), 300)})`,
          );
          if (!(block.name === "Bash" && isOtActivityCommand(block.input?.command))) {
            maybeHeartbeat(summarizeToolUse(block.name, block.input));
          }
        }
      }
      return true;
    }
    case "user": {
      const blocks = obj.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          emit(`[claude] tool_result: ${truncate(content, 300)}`);
        }
      }
      return true;
    }
    case "result": {
      if (typeof obj.total_cost_usd === "number" && Number.isFinite(obj.total_cost_usd)) {
        runResult.cost_usd = obj.total_cost_usd;
      }
      emit(
        `[claude] result: ${obj.subtype ?? "?"} is_error=${obj.is_error ?? false} turns=${obj.num_turns ?? "?"} cost_usd=${obj.total_cost_usd ?? "?"}`,
      );
      if (obj.result) {
        captureFinalResponse(obj.result);
        emit(`[claude] ${truncate(String(obj.result))}`);
      }
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// codex exec --json line handling
//
// Event names and paths below match the current `codex exec --json` JSONL
// protocol: thread.started.thread_id, turn.*, and item.completed.item.
// ---------------------------------------------------------------------------

function handleCodexLine(obj) {
  const type = obj.type;
  if (typeof type !== "string") return false;
  const looksLikeCodex =
    type.startsWith("thread.") ||
    type.startsWith("turn.") ||
    type.startsWith("item.") ||
    type === "error";
  if (!looksLikeCodex) return false;

  switch (type) {
    case "thread.started": {
      const threadId = obj.thread_id ?? obj.threadId ?? obj.id;
      if (threadId) writeSessionId(threadId);
      emit(`[codex] thread started (id=${threadId ?? "unknown"})`);
      return true;
    }
    case "turn.started":
      emit("[codex] turn started");
      return true;
    case "turn.completed":
      emit(
        `[codex] turn completed${obj.usage ? ` (usage=${truncate(JSON.stringify(obj.usage), 200)})` : ""}`,
      );
      return true;
    case "item.started":
    case "item.updated":
      // Progress noise — the terminal item.completed line carries the
      // summary, so skip these but still mark the line as handled.
      return true;
    case "item.completed": {
      const item = obj.item ?? {};
      emit(`[codex] ${summarizeCodexItem(item)}`);
      if (item.type === "command_execution" && item.command && !isOtActivityCommand(item.command)) {
        maybeHeartbeat(`running: ${item.command}`);
      } else if (item.type === "file_change") {
        maybeHeartbeat(`editing: ${truncate(JSON.stringify(item.changes ?? item), 160)}`);
      } else if (item.type === "agent_message" && item.text) {
        maybeHeartbeat(firstLine(item.text));
      }
      return true;
    }
    case "error":
      emit(`[codex] error: ${truncate(JSON.stringify(obj), 500)}`);
      return true;
    default:
      emit(`[codex] ${type}: ${truncate(JSON.stringify(obj), 300)}`);
      return true;
  }
}

export function summarizeCodexItem(item) {
  switch (item.type) {
    case "agent_message":
      if (item.text) captureFinalResponse(item.text);
      return `agent_message: ${truncate(String(item.text ?? ""), 500)}`;
    case "reasoning":
      return `reasoning: ${truncate(String(item.text ?? ""), 300)}`;
    case "command_execution":
      return `command: ${truncate(String(item.command ?? ""), 300)} (status=${item.status ?? "?"})`;
    case "file_change":
      return `file_change: ${truncate(JSON.stringify(item.changes ?? item), 300)}`;
    case "mcp_tool_call":
      return `mcp_tool_call: ${item.server ?? "?"}.${item.tool ?? "?"}`;
    default:
      return `item(${item.type ?? "unknown"}): ${truncate(JSON.stringify(item), 300)}`;
  }
}

// ---------------------------------------------------------------------------
// opencode run --format json line handling
// ---------------------------------------------------------------------------

let openCodeCostUsd = 0;

function looksLikeOpenCode(obj) {
  if (typeof obj.sessionID === "string") return true;
  if (typeof obj.type !== "string") return false;
  if (obj.type.startsWith("step_")) return true;
  if (obj.type === "message" && obj.part) return true;
  if (obj.type === "error" && typeof obj.sessionID === "string") return true;
  return false;
}

function openCodePart(obj) {
  return obj.part ?? obj.message?.part ?? obj;
}

export function summarizeOpenCodeEvent(obj) {
  const type = obj.type ?? "event";
  const part = openCodePart(obj);
  switch (type) {
    case "message":
    case "part": {
      if (part?.type === "text" && part.text) return truncate(part.text);
      if (part?.type === "tool" || part?.tool) {
        return `tool: ${part.tool ?? part.name ?? "unknown"}${part.state ? ` (${part.state})` : ""}`;
      }
      if (part?.type === "error" || part?.error) {
        return `error: ${truncate(JSON.stringify(part.error ?? part), 500)}`;
      }
      if (part?.type === "reasoning") return "";
      return truncate(JSON.stringify(obj), 300);
    }
    case "step_start":
      return "step started";
    case "step_finish": {
      const cost = part?.cost ?? obj.cost;
      return `step finished${typeof cost === "number" ? ` (cost_usd=${cost})` : ""}`;
    }
    case "error":
      return `error: ${truncate(JSON.stringify(obj.error ?? obj), 500)}`;
    default:
      return `${type}: ${truncate(JSON.stringify(obj), 300)}`;
  }
}

function handleOpenCodeLine(obj) {
  if (!looksLikeOpenCode(obj)) return false;

  if (typeof obj.sessionID === "string") writeSessionId(obj.sessionID);

  const type = obj.type ?? "event";
  const part = openCodePart(obj);
  switch (type) {
    case "message":
    case "part": {
      const summary = summarizeOpenCodeEvent(obj);
      if (summary) {
        emit(`[opencode] ${summary}`);
        maybeHeartbeat(firstLine(summary));
      }
      return true;
    }
    case "step_start":
      emit(`[opencode] ${summarizeOpenCodeEvent(obj)}`);
      return true;
    case "step_finish": {
      const cost = part?.cost ?? obj.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        openCodeCostUsd += cost;
        runResult.cost_usd = openCodeCostUsd;
      }
      emit(`[opencode] ${summarizeOpenCodeEvent(obj)}`);
      return true;
    }
    case "error":
      emit(`[opencode] ${summarizeOpenCodeEvent(obj)}`);
      return true;
    default:
      emit(`[opencode] ${summarizeOpenCodeEvent(obj)}`);
      return true;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const runResult = {};

export function processLine(raw) {
  const line = raw.trim();
  if (!line) return;

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    // Not JSON — pass through truncated (e.g. stray stderr text, shell
    // banners, warnings printed before the agent starts emitting JSONL).
    emit(truncate(line));
    return;
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    emit(truncate(line));
    return;
  }

  if (handleClaudeLine(obj)) return;
  if (handleOpenCodeLine(obj)) return;
  if (handleCodexLine(obj)) return;

  // Recognized JSON but an unknown shape — pass through, truncated.
  emit(truncate(JSON.stringify(obj)));
}

export function writeRunResult() {
  try {
    mkdirSync(OT_DIR, { recursive: true });
    writeFileSync(join(OT_DIR, "run-result.json"), JSON.stringify(runResult) + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(`[normalize] failed to write run result: ${err.message}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", processLine);
  rl.on("close", writeRunResult);
}
