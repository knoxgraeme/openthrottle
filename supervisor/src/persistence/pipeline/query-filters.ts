// Shared query validation for the persistence read surfaces
// (analysis-store.ts, journal-store.ts). These helpers were hand-copied into
// both stores and promptly diverged: journal-store's regex learned the
// ISO-8601 basic (colon-less) numeric offset while analysis-store's still
// required the colon, so `2026-07-27T01:00:00+0200` was accepted by
// /status/journal and rejected by /analysis/runs (PR #158 review). One
// module, one shape -- both endpoints must accept and reject identically.

const QUERY_LIMIT = 200;

// Deliberately narrow: requires the 'T' separator and a trailing 'Z' or
// numeric UTC offset so a loosely-formatted or ambiguous value (`0`,
// `08/08/2026`) is rejected by shape before Date.parse ever sees it --
// Date.parse's non-standard fallback parsing accepts both and would
// otherwise silently query an unintended time range instead of failing
// closed (PR #156 follow-up review). The offset's colon is optional so both
// extended (`+00:00`) and basic (`+0000`) ISO-8601 numeric offsets are
// accepted -- Date.parse itself already accepts both, and requiring the
// colon would silently reject a well-formed, unambiguous timestamp a caller
// previously relied on being accepted (PR #158 review).
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

export function queryTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_8601_TIMESTAMP.test(value)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

// Every other filter on these endpoints fails closed on a malformed value; a
// non-safe-integer limit (`abc`, `1.5`, `Infinity`) must too instead of
// silently falling back to the default (PR #156 follow-up review).
export function queryLimit(value: number | undefined): number {
  if (value === undefined) return QUERY_LIMIT;
  if (!Number.isSafeInteger(value)) throw new Error("limit must be a safe integer");
  return Math.max(1, Math.min(value, QUERY_LIMIT));
}
