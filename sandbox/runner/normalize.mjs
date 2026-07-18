#!/usr/bin/env node
// runner/normalize.mjs
//
// Line-buffered stdin JSONL processor sitting between the coding agent
// (claude or codex) and the sandbox task log. See docs/SPEC.md
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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// Output helpers
// ---------------------------------------------------------------------------

const TRUNCATE_LEN = 2000;

export function truncate(str, len = TRUNCATE_LEN) {
  const s = String(str);
  if (s.length <= len) return s;
  return `${s.slice(0, len)}… [truncated ${s.length - len} chars]`;
}

function emit(line) {
  process.stdout.write(sanitize(line) + "\n");
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
        } else if (block?.type === "tool_use") {
          emit(
            `[claude] tool_use: ${block.name}(${truncate(JSON.stringify(block.input ?? {}), 300)})`,
          );
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
      if (obj.result) emit(`[claude] ${truncate(String(obj.result))}`);
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
