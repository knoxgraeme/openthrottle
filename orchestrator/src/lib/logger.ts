import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logDir = "";
let runnerName = "orchestrator";

export function initLogger(dir: string, name: string): void {
  logDir = dir;
  runnerName = name;
  mkdirSync(logDir, { recursive: true });
}

export function log(message: string): void {
  const timestamp = new Date().toTimeString().slice(0, 8);
  const line = `[${runnerName} ${timestamp}] ${message}`;
  console.log(line);
  if (logDir) {
    appendFileSync(join(logDir, `${runnerName}.log`), line + "\n");
  }
}

export async function notify(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      },
    );
    if (!res.ok && !notifyWarned) {
      log(`WARNING: Telegram notification failed (HTTP ${res.status}).`);
      notifyWarned = true;
    }
  } catch {
    if (!notifyWarned) {
      log("WARNING: Telegram notification failed (network error).");
      notifyWarned = true;
    }
  }
}

let notifyWarned = false;
