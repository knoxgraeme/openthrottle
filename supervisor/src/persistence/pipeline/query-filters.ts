import { normalizeIso8601Timestamp } from "@openthrottle/contracts";

// Shared query validation for the persistence read surfaces
// (analysis-store.ts, journal-store.ts). These helpers were hand-copied into
// both stores and promptly diverged: journal-store's regex learned the
// ISO-8601 basic (colon-less) numeric offset while analysis-store's still
// required the colon, so `2026-07-27T01:00:00+0200` was accepted by
// /status/journal and rejected by /analysis/runs (PR #158 review). One
// module, one shape -- both endpoints must accept and reject identically.

const QUERY_LIMIT = 200;

export function queryTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeIso8601Timestamp(value);
  if (!normalized) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return normalized;
}

// Every other filter on these endpoints fails closed on a malformed value; a
// non-safe-integer limit (`abc`, `1.5`, `Infinity`) must too instead of
// silently falling back to the default (PR #156 follow-up review).
export function queryLimit(value: number | undefined): number {
  if (value === undefined) return QUERY_LIMIT;
  if (!Number.isSafeInteger(value)) throw new Error("limit must be a safe integer");
  return Math.max(1, Math.min(value, QUERY_LIMIT));
}
