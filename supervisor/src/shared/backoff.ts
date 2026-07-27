import { sanitizeText } from "./sanitize.js";

const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_BASE_RETRY_DELAY_MS = 5_000;

export function exponentialBackoffDelayMs(
  attempts: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  return Math.min(maxDelayMs, 2 ** Math.max(0, attempts - 1) * baseDelayMs);
}

export function classifyPermanentFailure(
  error: unknown,
  permanentPattern: RegExp,
  maxMessageChars = 2_000
): { retry: boolean; message: string } {
  const message = sanitizeText(String(error)).slice(-maxMessageChars);
  return { retry: !permanentPattern.test(message), message };
}
