import { sanitizeText } from "../shared/sanitize.js";

const MAX_FIELD_CHARS = 500;
const MAX_SERIALIZED_CHARS = 1_500;
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
const RETRYABLE_MESSAGE_PATTERNS = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\bconnection reset\b/i,
  /\bsocket hang up\b/i,
];

export interface SerializedRuntimeObservationError {
  operation: string;
  retryable: boolean;
  statusCode: number | null;
  message: string;
  cause: string | null;
  text: string;
}

function boundedText(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value instanceof Error) text = value.message;
  else if (Array.isArray(value)) text = "array error";
  else if (value && typeof value === "object") text = "object error";
  else text = String(value);
  const sanitized = sanitizeText(text || "unknown error");
  return sanitized.slice(0, MAX_FIELD_CHARS);
}

function candidateStatus(value: unknown, seen = new Set<unknown>()): number | null {
  if (value instanceof Error) {
    const match = /\bstatus=([1-5][0-9][0-9])\b/.exec(value.message);
    return match ? Number(match[1]) : null;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode", "status_code", "code"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
    if (typeof raw === "string" && /^[1-5][0-9][0-9]$/.test(raw)) return Number(raw);
  }
  for (const nested of [record.response, record.cause, record.error]) {
    const status = candidateStatus(nested, seen);
    if (status !== null) return status;
  }
  return null;
}

function candidateMessage(value: unknown): string {
  if (value instanceof Error) return boundedText(value.message || value.name);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "text", "name"]) {
      if (typeof record[key] === "string" && record[key].trim()) return boundedText(record[key]);
    }
  }
  return boundedText(value);
}

function candidateCause(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cause = (value as Record<string, unknown>).cause;
  if (cause === undefined || cause === null) return null;
  return candidateMessage(cause);
}

function hasRetryableCode(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && RETRYABLE_ERROR_CODES.has(record.code)) return true;
  return hasRetryableCode(record.cause, seen) || hasRetryableCode(record.error, seen);
}

export function serializeRuntimeObservationError(
  operation: string,
  error: unknown
): SerializedRuntimeObservationError {
  const statusCode = candidateStatus(error);
  const message = candidateMessage(error);
  const cause = candidateCause(error);
  const retryable = statusCode !== null
    ? statusCode >= 500
    : (error instanceof Error && /\bretryable=true\b/.test(error.message)) ||
      hasRetryableCode(error) ||
      RETRYABLE_MESSAGE_PATTERNS.some((pattern) =>
        pattern.test(message) || pattern.test(cause ?? "")
    );
  const parts = [
    `operation=${sanitizeText(operation).slice(0, 120)}`,
    `retryable=${retryable ? "true" : "false"}`,
    `status=${statusCode ?? "unknown"}`,
    `message=${message}`,
    ...(cause ? [`cause=${cause}`] : []),
  ];
  return {
    operation,
    retryable,
    statusCode,
    message,
    cause,
    text: parts.join(" ").slice(0, MAX_SERIALIZED_CHARS),
  };
}
