import {
  ANALYSIS_QUERY_ATTRIBUTIONS,
  ANALYSIS_QUERY_OUTCOMES,
  ANALYSIS_QUERY_REASONS,
  type AnalysisRunQuery,
  type AnalysisRunResult,
} from '@openthrottle/contracts';
import { getErrorMessage, printTable, supervisorRequest } from './util.js';

/**
 * A /analysis/runs row: the contract's read shape plus the three operator-facing
 * columns the supervisor also returns but the read contract does not model.
 */
type AnalysisRunRow = AnalysisRunResult & {
  ticket_id: string;
  engine: string;
  token_cost_usd: number | null;
};

interface AnalysisRunsResponse {
  runs?: AnalysisRunRow[];
}

/**
 * Allowed values per query field, keyed by the contract's own query shape —
 * `satisfies` makes this table fail typecheck if @openthrottle/contracts adds or
 * drops a filter. `null` means "any string"; the supervisor validates the value.
 */
const QUERY_FIELDS = {
  outcome: ANALYSIS_QUERY_OUTCOMES,
  reason: ANALYSIS_QUERY_REASONS,
  attribution: ANALYSIS_QUERY_ATTRIBUTIONS,
  graph: null,
  skill_digest: null,
  from: null,
  to: null,
  limit: null,
} satisfies Record<keyof AnalysisRunQuery, readonly string[] | null>;

type QueryField = keyof typeof QUERY_FIELDS;

/** `skill_digest` is spelled `--skill-digest` on the command line. */
const FIELD_BY_FLAG = new Map<string, QueryField>(
  (Object.keys(QUERY_FIELDS) as QueryField[]).map((field) => [`--${field.replace(/_/g, '-')}`, field])
);

function parseFilters(args: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    const field = FIELD_BY_FLAG.get(flag);
    if (!field) {
      console.error(`Unknown flag: ${flag}\n`);
      console.error(`Supported flags: ${[...FIELD_BY_FLAG.keys()].join(', ')}`);
      process.exit(1);
    }
    const value = args[i + 1];
    if (value === undefined) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    // Vocabulary-backed filters are checked here so a typo fails locally rather
    // than as an HTTP 400 from the supervisor.
    const allowed: readonly string[] | null = QUERY_FIELDS[field];
    if (allowed && !allowed.includes(value)) {
      console.error(`Invalid value for ${flag}: ${value}\n`);
      console.error(`Allowed values: ${allowed.join(', ')}`);
      process.exit(1);
    }
    params.set(field, value);
    i += 1;
  }
  return params;
}

export default async function analysis(args: string[]): Promise<void> {
  const params = parseFilters(args);
  const query = params.toString();

  let res: Response;
  try {
    res = await supervisorRequest(`/analysis/runs${query ? `?${query}` : ''}`);
  } catch (err: unknown) {
    console.error(`Could not reach the supervisor: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`GET /analysis/runs → HTTP ${res.status}`);
    try {
      console.error(await res.text());
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let data: AnalysisRunsResponse;
  try {
    data = (await res.json()) as AnalysisRunsResponse;
  } catch (err: unknown) {
    console.error(`Could not parse response as JSON: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  const runs = data.runs ?? [];
  printTable(
    runs.map((run) => ({
      instance: run.pipeline_instance_id,
      ticket: run.ticket_id,
      outcome: run.outcome,
      reason: run.closed_reason,
      attribution: run.fault_attribution,
      graph: run.execution_graph_id,
      engine: run.engine,
      cost_usd: run.token_cost_usd,
      created_at: run.created_at,
    })),
    ['instance', 'ticket', 'outcome', 'reason', 'attribution', 'graph', 'engine', 'cost_usd', 'created_at']
  );
}
