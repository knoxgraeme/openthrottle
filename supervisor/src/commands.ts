// Phase 2 item 2: centralize the chat commands a Linear reply can carry
// (/stop, /merge, /implement) plus the legacy "investigate" + free-text
// promotion heuristic, so callers stop hand-rolling regexes inline.
//
// The native Linear `signal: "stop"` control signal is not a chat command —
// it stays a direct check in the Linear webhook handler, alongside this
// parser's textual "/stop".

export type Command =
  | { kind: "stop" }
  | { kind: "merge" }
  | { kind: "implement"; legacy?: boolean }
  | { kind: "reply" };

const MERGE_PATTERN = /^(?:\/merge|merge it)$/i;
const LEGACY_PROMOTION_PATTERN = /\b(fix it|implement|go ahead)\b/i;

export function parseCommand(message: string, opts: { investigateLabel: boolean }): Command {
  const trimmed = message.trim();
  if (trimmed === "/stop") return { kind: "stop" };
  if (MERGE_PATTERN.test(trimmed)) return { kind: "merge" };
  if (trimmed === "/implement") return { kind: "implement" };
  if (opts.investigateLabel && LEGACY_PROMOTION_PATTERN.test(message)) {
    return { kind: "implement", legacy: true };
  }
  return { kind: "reply" };
}
