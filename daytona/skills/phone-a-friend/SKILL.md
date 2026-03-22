---
name: phone-a-friend
user-invocable: true
description: >
  Send a message to the user via Telegram and optionally wait for a reply.
  Use when you're blocked, need a decision, have a question, or want to
  notify the user of something important. Designed for headless sandbox
  sessions. Use for: "ask the user", "notify", "I'm stuck",
  "need a decision", "phone a friend", or any situation where you need
  human input.
---

# Phone a Friend

Send a Telegram message to the user. Optionally wait for their reply.

## When to Use

- You're **blocked** and can't make a reasonable assumption
- You need a **decision** that could go either way
- You want to **notify** the user of something (PR ready, error, milestone)
- You're about to do something **irreversible** and want confirmation

When NOT to use: routine decisions, style preferences, things you can
reasonably assume. Prefer doing over asking.

## Setup

Requires the Telegram MCP server configured in `~/.claude/settings.json`
(installed automatically during `/openthrottle-setup`).

If the MCP tools aren't available, tell the user to run `/openthrottle-setup`
or configure the Telegram MCP manually.

## Send a Message (no reply needed)

For notifications — fire and forget. Use the MCP tool:

```
send_telegram_message: "<your message>"
```

That's it. No polling, no waiting.

## Send and Wait for Reply

For blocking questions — send, then poll for a response:

1. Send the question:
```
send_telegram_message: "<your question — include 'Reply here and I'll continue.'>"
```

2. Poll for their reply (max 2 hours, check every 30 seconds).
   Use the Bash tool to sleep between polls — `sleep 30` pauses without
   consuming tokens:
```
get_telegram_messages
```

Check the returned messages for a reply to your question. If no reply yet,
run `sleep 30` via Bash, then check again. After 240 polls (2 hours), give up.

3. Read the reply text and act on it.

### Poll loop pseudocode:

```
for poll in 1..240:
  messages = get_telegram_messages
  if messages contains a reply after your sent message:
    process the reply
    break
  Bash: sleep 30

if no reply after 240 polls:
  post a comment on the issue noting the timeout, then continue
  with a reasonable default assumption (document it in the PR)
```

## Message Guidelines

Keep messages short and actionable:

**Notification:**
```
PR ready: https://github.com/owner/repo/pull/123
```

**Blocking question:**
```
Need a decision on auth.md prompt:

The codebase has two auth patterns and the prompt doesn't specify which.
Which should I use for the new login flow?

Reply here and I'll continue.
```

**Error escalation:**
```
Blocked on task T2: login endpoint tests failing.
Error: "SUPABASE_URL not set"

Reply with:
- A fix hint
- "skip" to move on
- "abort" to stop
```

## Timeout Behavior

After 2 hours with no reply, the poll exits. Default behavior:
1. Post a comment on the relevant GitHub issue noting the timeout
2. Continue with the most reasonable default assumption
3. Document the assumption in the PR description so the user can review it

This prevents work from stalling indefinitely while keeping the user informed.
