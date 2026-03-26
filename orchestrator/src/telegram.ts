import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID ?? "";

async function sendMessage(text: string): Promise<void> {
  await fetch(
    `https://api.telegram.org/bot${TOKEN()}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID(), text }),
    },
  );
}

// Track the last update_id to detect new replies
let lastUpdateId = 0;

async function initOffset(): Promise<void> {
  if (lastUpdateId > 0) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN()}/getUpdates?offset=-1&limit=1`,
    );
    const data = (await res.json()) as any;
    if (data.ok && data.result?.length > 0) {
      lastUpdateId = data.result[data.result.length - 1].update_id + 1;
    }
  } catch {
    // Start from 0 if we can't reach Telegram
  }
}

async function pollForReply(timeoutMs: number): Promise<string | null> {
  await initOffset();
  const deadline = Date.now() + timeoutMs;
  const chatId = CHAT_ID();

  while (Date.now() < deadline) {
    const remaining = Math.min(60, Math.floor((deadline - Date.now()) / 1000));
    if (remaining <= 0) break;

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TOKEN()}/getUpdates?offset=${lastUpdateId}&timeout=${remaining}`,
      );
      const data = (await res.json()) as any;
      if (!data.ok) continue;

      for (const update of data.result ?? []) {
        lastUpdateId = update.update_id + 1;
        const msg = update.message;
        if (msg?.chat?.id?.toString() === chatId && msg.text) {
          return msg.text;
        }
      }
    } catch {
      // Network hiccup — wait a bit and retry
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  return null;
}

// Custom tool: agent calls this when stuck or needs to notify
const askHuman = tool(
  "ask_human",
  "Send a message to the user via Telegram and optionally wait for their reply. " +
    "Use when blocked, need a decision, or want to notify the user of something important.",
  {
    message: z.string().describe("The message to send to the user"),
    wait_for_reply: z
      .boolean()
      .default(false)
      .describe("Whether to wait for a reply (true) or fire-and-forget (false)"),
    timeout_minutes: z
      .number()
      .default(30)
      .describe("How long to wait for a reply in minutes"),
  },
  async (args) => {
    await sendMessage(args.message);
    if (!args.wait_for_reply) {
      return { content: [{ type: "text" as const, text: "Notification sent." }] };
    }
    const reply = await pollForReply(args.timeout_minutes * 60_000);
    return {
      content: [
        {
          type: "text" as const,
          text: reply ?? "No reply received within timeout. Proceed with best judgment and document assumptions.",
        },
      ],
    };
  },
);

export function createTelegramMcpServer() {
  return createSdkMcpServer({ name: "telegram-tools", tools: [askHuman] });
}

export { sendMessage };
