import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import type {
  OrchestrationJournalEntry,
  OrchestrationJournalQuery,
  OrchestrationJournalWrite,
  PipelineStore,
} from "../../pipeline/store.js";
import { sanitizeText } from "../../shared/sanitize.js";

const NOTE_LIMIT = 8_000;
const TEXT_LIMIT = 2_000;
const QUERY_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bounded(value: string, max = TEXT_LIMIT): string {
  return sanitizeText(value).slice(0, max);
}

function sanitizedJsonValue(value: unknown): unknown {
  if (typeof value === "string") return bounded(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizedJsonValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, sanitizedJsonValue(entry)])
    );
  }
  return value ?? null;
}

function jsonObject(value: Record<string, unknown> | undefined): string {
  return canonicalJson(sanitizedJsonValue(value ?? {}));
}

function nullableJsonObject(value: Record<string, unknown> | null | undefined): string | null {
  return value == null ? null : canonicalJson(sanitizedJsonValue(value));
}

function journalId(input: OrchestrationJournalWrite, refs: string, structured: string | null): string {
  if (input.id && UUID.test(input.id)) return input.id.toLowerCase();
  const digest = digestNormalized(canonicalJson(input.id ?? [
    input.issueId,
    input.instanceId ?? null,
    input.runId ?? null,
    input.actor,
    input.kind,
    input.trigger,
    input.action,
    input.outcome ?? null,
    refs,
    input.note ?? null,
    structured,
  ]));
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function issueTeamKey(issue: string | undefined): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(issue ?? "");
  return match?.[1]?.toUpperCase();
}

function metadataForIssue(db: Database.Database, issueId: string): {
  team: string;
  repository: string;
  issue: string;
} {
  const ticket = db.prepare(`
    SELECT linear_issue_identifier, repo FROM tickets WHERE linear_issue_id = ?
  `).get(issueId) as { linear_issue_identifier: string; repo: string } | undefined;
  const repository = ticket?.repo ?? "unknown";
  const teamKey = issueTeamKey(ticket?.linear_issue_identifier);
  const matchingRegistration = teamKey
    ? db.prepare(`
      SELECT linear_team_key FROM repository_registrations
      WHERE lower(github_repo) = lower(?) AND lower(linear_team_key) = lower(?)
      LIMIT 1
    `).get(repository, teamKey) as { linear_team_key: string } | undefined
    : undefined;
  const fallbackRegistration = matchingRegistration ? undefined : db.prepare(`
    SELECT linear_team_key FROM repository_registrations
    WHERE lower(github_repo) = lower(?)
    ORDER BY updated_at DESC LIMIT 1
  `).get(repository) as { linear_team_key: string } | undefined;
  return {
    team: matchingRegistration?.linear_team_key ?? teamKey ?? fallbackRegistration?.linear_team_key ?? "unknown",
    repository,
    issue: ticket?.linear_issue_identifier ?? issueId,
  };
}

function queryTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

export function createJournalStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  "recordJournalEntry" | "listJournalEntries"
> {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO orchestration_journal (
      id, recorded_at, team, repository, issue, instance_id, run_id, actor,
      kind, trigger, action, outcome, refs, note, structured
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    recordJournalEntry(input: OrchestrationJournalWrite): void {
      const metadata = metadataForIssue(db, input.issueId);
      const refs = jsonObject(input.refs);
      const structured = nullableJsonObject(input.structured);
      const recordedAt = queryTimestamp(now(), "recorded_at")!;
      insert.run(
        journalId(input, refs, structured),
        recordedAt,
        metadata.team,
        metadata.repository,
        metadata.issue,
        input.instanceId ?? null,
        input.runId ?? null,
        input.actor,
        input.kind,
        bounded(input.trigger),
        bounded(input.action),
        input.outcome == null ? null : bounded(input.outcome, 500),
        refs,
        input.note == null ? null : bounded(input.note, NOTE_LIMIT),
        structured
      );
    },
    listJournalEntries(query: OrchestrationJournalQuery): OrchestrationJournalEntry[] {
      const from = queryTimestamp(query.from, "from");
      const to = queryTimestamp(query.to, "to");
      const requestedLimit = Number.isSafeInteger(query.limit) ? query.limit! : QUERY_LIMIT;
      const limit = Math.max(1, Math.min(requestedLimit, QUERY_LIMIT));
      const filters: string[] = [];
      const args: unknown[] = [];
      if (query.issueId) {
        const metadata = metadataForIssue(db, query.issueId);
        filters.push("issue = ?");
        args.push(metadata.issue);
      } else if (query.issue) {
        filters.push("lower(issue) = lower(?)");
        args.push(query.issue);
      }
      if (query.repository) {
        filters.push("lower(repository) = lower(?)");
        args.push(query.repository);
      }
      if (from) {
        filters.push("recorded_at >= ?");
        args.push(from);
      }
      if (to) {
        filters.push("recorded_at <= ?");
        args.push(to);
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      return db.prepare(`
        SELECT * FROM orchestration_journal
        ${where}
        ORDER BY recorded_at, id
        LIMIT ?
      `).all(...args, limit) as OrchestrationJournalEntry[];
    },
  };
}
