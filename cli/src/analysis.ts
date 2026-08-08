import { getErrorMessage, printTable, supervisorRequest } from './util.js';

interface RunOutcomeRow {
  pipeline_instance_id: string;
  linear_issue_id: string;
  generation: number;
  execution_graph_id: string | null;
  plan_digest: string | null;
  base_commit: string;
  engine: string;
  outcome: string;
  closed_reason: string;
  fault_attribution: string | null;
  generations_consumed: number;
  token_cost_usd: number | null;
  created_at: string;
}

interface AnalysisRunsResponse {
  runs?: RunOutcomeRow[];
}

const FILTER_FLAGS: Record<string, string> = {
  '--outcome': 'outcome',
  '--reason': 'reason',
  '--attribution': 'attribution',
  '--graph': 'graph',
  '--skill-digest': 'skill_digest',
  '--from': 'from',
  '--to': 'to',
  '--limit': 'limit',
};

function parseFilters(args: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    const key = FILTER_FLAGS[flag];
    if (!key) {
      console.error(`Unknown flag: ${flag}\n`);
      console.error(`Supported flags: ${Object.keys(FILTER_FLAGS).join(', ')}`);
      process.exit(1);
    }
    const value = args[i + 1];
    if (value === undefined) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    params.set(key, value);
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
      issue: run.linear_issue_id,
      outcome: run.outcome,
      reason: run.closed_reason,
      attribution: run.fault_attribution,
      graph: run.execution_graph_id,
      engine: run.engine,
      cost_usd: run.token_cost_usd,
      created_at: run.created_at,
    })),
    ['instance', 'issue', 'outcome', 'reason', 'attribution', 'graph', 'engine', 'cost_usd', 'created_at']
  );
}
