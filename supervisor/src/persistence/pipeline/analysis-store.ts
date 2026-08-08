import type Database from "better-sqlite3";
import { FAULT_ATTRIBUTIONS } from "../../pipeline/fault-attribution.js";
import { PIPELINE_OUTCOMES, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import type { RunOutcome } from "../../pipeline/store.js";

// Read-only evidence for improvement proposals, never a decision input --
// see docs/SPEC.md "Analysis read-contract". supervisor/src/__tests__/
// architecture.test.ts forbids every gate, transition, scheduler, and
// effect-drain module from importing this file *and* from writing a raw
// run_outcomes SQL literal of their own, so wire it into the HTTP layer only
// from a plain `db` handle (persistence/analysis-store.ts, not PipelineStore)
// -- never add a run_outcomes read method to PipelineStore itself (that is
// exactly the leak PR #156's review closed: PipelineStore.getRunOutcome was
// reachable by any code already holding the store gate/transition/scheduler/
// effect-drain modules depend on, with no import of this file required).

const QUERY_LIMIT = 200;

// Deliberately narrow: requires the 'T' separator and a trailing 'Z' or
// numeric UTC offset so a loosely-formatted or ambiguous value (`0`,
// `08/08/2026`) is rejected by shape before Date.parse ever sees it --
// Date.parse's non-standard fallback parsing accepts both and would
// otherwise silently query an unintended time range instead of failing closed.
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface AnalysisRunOutcomeQuery {
  outcome?: string;
  reason?: string;
  attribution?: string;
  graph?: string;
  skillDigest?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface AnalysisStore {
  listRunOutcomes(query: AnalysisRunOutcomeQuery): RunOutcome[];
}

function queryTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_8601_TIMESTAMP.test(value)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

function enumFilter(value: string | undefined, label: string, vocab: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (!vocab.includes(value)) throw new Error(`${label} must be one of: ${vocab.join(", ")}`);
  return value;
}

export function createAnalysisStore(db: Database.Database): AnalysisStore {
  return {
    listRunOutcomes(query) {
      const outcome = enumFilter(query.outcome, "outcome", PIPELINE_OUTCOMES);
      const reason = enumFilter(query.reason, "reason", STAGE_OUTCOMES);
      const attribution = enumFilter(query.attribution, "attribution", FAULT_ATTRIBUTIONS);
      const from = queryTimestamp(query.from, "from");
      const to = queryTimestamp(query.to, "to");
      const requestedLimit = Number.isSafeInteger(query.limit) ? query.limit! : QUERY_LIMIT;
      const limit = Math.max(1, Math.min(requestedLimit, QUERY_LIMIT));

      const filters: string[] = [];
      const args: unknown[] = [];
      if (outcome) {
        filters.push("outcome = ?");
        args.push(outcome);
      }
      if (reason) {
        filters.push("closed_reason = ?");
        args.push(reason);
      }
      if (attribution) {
        filters.push("fault_attribution = ?");
        args.push(attribution);
      }
      if (query.graph) {
        filters.push("execution_graph_id = ?");
        args.push(query.graph);
      }
      if (query.skillDigest) {
        // skill_digests is a JSON array of {skill, skill_package_digest}
        // (deduped receipt producers -- see run-outcome-store.ts); no side
        // table exists for it, so membership is a json_each predicate.
        // Matches either property: a caller distinguishing repository skill
        // versions passes the 64-char skill_package_digest, while a caller
        // filtering by which skill ran at all (digest-less builtin skills
        // included) passes the skill identifier -- both are "the skill
        // digest" for this one filter dimension.
        filters.push(`EXISTS (
          SELECT 1 FROM json_each(run_outcomes.skill_digests) skill_digest
          WHERE json_extract(skill_digest.value, '$.skill') = ?
             OR json_extract(skill_digest.value, '$.skill_package_digest') = ?
        )`);
        args.push(query.skillDigest, query.skillDigest);
      }
      if (from) {
        filters.push("created_at >= ?");
        args.push(from);
      }
      if (to) {
        filters.push("created_at <= ?");
        args.push(to);
      }

      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      return db.prepare(`
        SELECT * FROM run_outcomes
        ${where}
        ORDER BY created_at DESC, pipeline_instance_id
        LIMIT ?
      `).all(...args, limit) as RunOutcome[];
    },
  };
}
