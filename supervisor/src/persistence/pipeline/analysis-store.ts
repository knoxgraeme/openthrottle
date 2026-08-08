import type Database from "better-sqlite3";
import { FAULT_ATTRIBUTIONS } from "../../pipeline/fault-attribution.js";
import { PIPELINE_OUTCOMES, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import type { RunOutcome } from "../../pipeline/store.js";

// Read-only evidence for improvement proposals, never a decision input --
// see docs/SPEC.md "Analysis read-contract". supervisor/src/__tests__/
// architecture.test.ts forbids every gate, transition, scheduler, and
// effect-drain module from importing this file, so wire it into the HTTP
// layer only from a plain `db` handle (persistence/analysis-store.ts, not
// PipelineStore) -- never add these methods to PipelineStore itself.

const QUERY_LIMIT = 200;

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
        filters.push(`EXISTS (
          SELECT 1 FROM json_each(run_outcomes.skill_digests) skill_digest
          WHERE json_extract(skill_digest.value, '$.skill') = ?
        )`);
        args.push(query.skillDigest);
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
