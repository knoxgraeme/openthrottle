const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const OPENCODE_EVENTS = new Set(["message", "step_start", "step_finish"]);

function eventSessionId(event, engine) {
  if (engine === "claude" && event.type === "system") return event.session_id ?? event.sessionId;
  if (engine === "codex" && event.type === "thread.started") return event.thread_id ?? event.threadId ?? event.id;
  if (engine === "opencode" && OPENCODE_EVENTS.has(event.type)) return event.sessionID ?? event.sessionId;
  return null;
}

export function extractNativeSessionId(output, engine) {
  if (!["claude", "codex", "opencode"].includes(engine)) throw new Error("native session engine is invalid");
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const candidate = eventSessionId(JSON.parse(line), engine);
      if (typeof candidate === "string" && SESSION_ID.test(candidate)) return candidate;
    } catch {
      // Provider diagnostics and partial stream fragments carry no identity.
    }
  }
  return null;
}
