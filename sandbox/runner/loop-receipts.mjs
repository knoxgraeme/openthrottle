import {
  STANDARD_RECEIPT_RESULTS,
  isStandardReceiptShaped,
  parseAgentJson,
  sanitizeArtifactText,
  validateStandardReceipt,
} from "./artifacts.mjs";

const CODEX_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STANDARD_RECEIPT_TYPES = new Set(Object.keys(STANDARD_RECEIPT_RESULTS));

function receiptCandidatesFromJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (value.type === "item.completed") {
    const codexAgentMessage = codexAgentMessageText(value);
    return codexAgentMessage === null ? [] : [codexAgentMessage];
  }
  const candidates = [];
  for (const key of ["receipt", "output", "content", "message"]) {
    if (value[key] !== undefined) candidates.push(value[key]);
  }
  if (value.type === "result" && value.result !== undefined) candidates.push(value.result);
  return candidates;
}

function codexAgentMessageText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.type !== "item.completed" || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "type") || !Object.hasOwn(value, "item")) return null;
  const item = value.item;
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      item.type !== "agent_message" || !Object.hasOwn(item, "type") ||
      !Object.hasOwn(item, "text") || typeof item.text !== "string" ||
      Object.keys(item).some((key) => !["id", "text", "type"].includes(key)) ||
      (Object.hasOwn(item, "id") && (typeof item.id !== "string" || !CODEX_ITEM_ID.test(item.id)))) return null;
  return item.text;
}

function validateStandardReceiptForLoop(value, env, expectedReceiptType) {
  if (expectedReceiptType !== undefined && isStandardReceiptShaped(value)) {
    if (!Object.hasOwn(value, "type")) throw new Error("standard receipt is missing field type");
    if (!STANDARD_RECEIPT_TYPES.has(value.type)) throw new Error("standard receipt has an invalid type");
    if (value.type !== expectedReceiptType) {
      throw new Error(`loop receipt type mismatch: expected ${expectedReceiptType}, received ${value.type}`);
    }
  }
  return validateStandardReceipt(value, env);
}

function ambiguousCodexReceiptError(jsonl, asReceipt) {
  let receiptLikeMessages = 0;
  for (const line of jsonl.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text = codexAgentMessageText(event);
    if (text === null) continue;
    try {
      if (isStandardReceiptShaped(parseAgentJson(text, asReceipt))) receiptLikeMessages += 1;
    } catch (error) {
      if (error?.ambiguousAgentJson) return error;
    }
  }
  if (receiptLikeMessages <= 1) return null;
  const error = new Error(
    `${receiptLikeMessages} receipt-like Codex agent messages found; refusing to guess which one is the receipt`,
  );
  error.ambiguousAgentJson = true;
  return error;
}

export function parseLoopReceipt(raw, env = process.env, expectedReceiptType = undefined) {
  const sanitized = sanitizeArtifactText(raw, env).trim();
  if (!sanitized) throw new Error("loop action did not emit a receipt");
  const candidates = [sanitized, ...sanitized.split("\n").map((line) => line.trim()).filter(Boolean).reverse()];
  let ambiguityError = null;
  let nestedError = null;
  let nestedCandidate = null;
  let topError = null;
  let topCandidate = null;
  const asReceipt = { qualifies: isStandardReceiptShaped, label: "receipt" };
  const codexAmbiguity = ambiguousCodexReceiptError(sanitized, asReceipt);
  if (codexAmbiguity) {
    throw new Error(`loop action emitted invalid standard receipt: ${codexAmbiguity.message}`);
  }
  for (const candidate of candidates) {
    try {
      const parsed = typeof candidate === "string" ? parseAgentJson(candidate, asReceipt) : candidate;
      try {
        return validateStandardReceiptForLoop(parsed, env, expectedReceiptType);
      } catch (error) {
        topError ??= error;
        topCandidate ??= parsed;
        for (const nested of receiptCandidatesFromJson(parsed)) {
          try {
            const normalized = typeof nested === "string" ? parseAgentJson(nested, asReceipt) : nested;
            return validateStandardReceiptForLoop(normalized, env, expectedReceiptType);
          } catch (error) {
            if (error?.ambiguousAgentJson) ambiguityError ??= error;
            else {
              nestedError ??= error;
              try {
                nestedCandidate ??= typeof nested === "string" ? parseAgentJson(nested, asReceipt) : nested;
              } catch {
                // Keep the validator message as the primary diagnostic.
              }
            }
          }
        }
      }
    } catch (error) {
      if (error?.ambiguousAgentJson) ambiguityError ??= error;
    }
  }
  const cause = ambiguityError ?? nestedError ?? topError;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const error = new Error(`loop action emitted invalid standard receipt${detail ? `: ${detail}` : ""}`);
  error.invalidReceiptCandidate = nestedCandidate ?? topCandidate;
  throw error;
}
