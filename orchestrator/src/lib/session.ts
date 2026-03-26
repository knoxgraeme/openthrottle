import { readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "../types.js";
import { log } from "./logger.js";

export function resolveSession(
  sessionsDir: string,
  taskKey: string,
  fromPr?: string,
): SessionInfo {
  // Priority 1: FROM_PR env var (review-fix flow)
  if (fromPr) {
    log(`Resuming PR context with --from-pr ${fromPr}`);
    return { sessionId: `from-pr-${fromPr}`, isResume: true };
  }

  // Priority 2: Session file on volume (cross-sandbox resume)
  const sessionFile = join(sessionsDir, `${taskKey}.id`);
  if (existsSync(sessionFile)) {
    const existingId = readFileSync(sessionFile, "utf-8").trim();
    if (existingId) {
      // Refresh mtime to prevent 7-day pruning
      const now = new Date();
      utimesSync(sessionFile, now, now);
      log(`Resuming session from volume: ${existingId}`);
      return { sessionId: existingId, isResume: true };
    }
  }

  // Create new session
  const newId = randomUUID();
  writeFileSync(join(sessionsDir, `${taskKey}.id`), newId);
  log(`New session: ${newId}`);
  return { sessionId: newId, isResume: false };
}
