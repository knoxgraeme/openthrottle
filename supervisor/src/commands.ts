// Exact control commands accepted from a Linear reply.
//
// The native Linear `signal: "stop"` control signal is not a chat command —
// it stays a direct check in the Linear webhook handler, alongside this
// parser's textual "/stop".

export type Command =
  | { kind: "stop" }
  | { kind: "merge" }
  | { kind: "reply" };

const MERGE_PATTERN = /^(?:\/merge|merge it)$/i;

export function parseCommand(message: string): Command {
  const trimmed = message.trim();
  if (trimmed === "/stop") return { kind: "stop" };
  if (MERGE_PATTERN.test(trimmed)) return { kind: "merge" };
  return { kind: "reply" };
}
