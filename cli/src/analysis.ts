import { EXECUTION_RECORD_KINDS, PIPELINE_TERMINAL_OUTCOMES } from '@openthrottle/contracts';
import { terminalSafe } from './status.js';
import { getErrorMessage, printTable, supervisorRequest } from './util.js';

type QueryField =
  | 'run'
  | 'pipeline_id'
  | 'terminal_outcome'
  | 'record_kind'
  | 'from'
  | 'to'
  | 'limit';

const FIELD_BY_FLAG = new Map<string, QueryField>([
  ['--run', 'run'],
  ['--pipeline', 'pipeline_id'],
  ['--outcome', 'terminal_outcome'],
  ['--record-kind', 'record_kind'],
  ['--from', 'from'],
  ['--to', 'to'],
  ['--limit', 'limit'],
]);

interface ParsedFilters {
  run?: string;
  params: URLSearchParams;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

function parseFilters(args: string[]): ParsedFilters {
  const params = new URLSearchParams();
  let run: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const field = FIELD_BY_FLAG.get(flag);
    if (!field) fail(`Unknown flag: ${flag}\n\nSupported flags: ${[...FIELD_BY_FLAG.keys()].join(', ')}`);
    const value = args[index + 1];
    if (value === undefined) fail(`${flag} requires a value`);
    if (field === 'terminal_outcome' && !PIPELINE_TERMINAL_OUTCOMES.includes(value as typeof PIPELINE_TERMINAL_OUTCOMES[number])) {
      fail(`Invalid value for ${flag}: ${value}\n\nAllowed values: ${PIPELINE_TERMINAL_OUTCOMES.join(', ')}`);
    }
    if (field === 'record_kind' && !EXECUTION_RECORD_KINDS.includes(value as typeof EXECUTION_RECORD_KINDS[number])) {
      fail(`Invalid value for ${flag}: ${value}\n\nAllowed values: ${EXECUTION_RECORD_KINDS.join(', ')}`);
    }
    if (field === 'limit' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500)) {
      fail('--limit must be an integer between 1 and 500');
    }
    if (field === 'run') {
      if (run !== undefined) fail('--run may be supplied only once');
      run = value;
    } else {
      params.set(field, value);
    }
  }
  if (run !== undefined) {
    for (const field of ['pipeline_id', 'terminal_outcome', 'from', 'to'] as const) {
      if (params.has(field)) fail(`--run cannot be combined with --${field.replaceAll('_', '-')}`);
    }
  }
  return { ...(run === undefined ? {} : { run }), params };
}

function safeRows(rows: Array<Record<string, string | number | null | undefined>>) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'string' ? terminalSafe(value) : value,
    ]),
  ));
}

export default async function analysis(args: string[]): Promise<void> {
  const filters = parseFilters(args);
  const params = filters.run === undefined
    ? new URLSearchParams(filters.params)
    : new URLSearchParams([
      ...(filters.params.has('record_kind')
        ? [['kind', filters.params.get('record_kind')!] as [string, string]]
        : []),
      ...(filters.params.has('limit')
        ? [['limit', filters.params.get('limit')!] as [string, string]]
        : []),
    ]);
  const query = params.toString();
  const path = filters.run === undefined
    ? `/analysis/runs${query ? `?${query}` : ''}`
    : `/runs/${encodeURIComponent(filters.run)}/analysis${query ? `?${query}` : ''}`;

  let response: Response;
  try {
    response = await supervisorRequest(path);
  } catch (error) {
    console.error(`Could not reach the supervisor: ${getErrorMessage(error)}`);
    process.exit(1);
    return;
  }
  if (!response.ok) {
    console.error(`GET ${filters.run === undefined ? '/analysis/runs' : '/runs/:reference/analysis'} → HTTP ${response.status}`);
    try {
      console.error(terminalSafe(await response.text()));
    } catch {
      // Ignore a secondary response-body failure.
    }
    process.exit(1);
    return;
  }
  let body: {
    runs?: Array<Record<string, string | number | null>>;
    pipeline_run_id?: string;
    records?: Array<Record<string, string | number | null>>;
  };
  try {
    body = await response.json() as typeof body;
  } catch (error) {
    console.error(`Could not parse response as JSON: ${getErrorMessage(error)}`);
    process.exit(1);
    return;
  }

  if (filters.run !== undefined) {
    printTable(safeRows((body.records ?? []).map((record) => ({
      sequence: record.sequence,
      kind: record.kind,
      schema: record.payload_schema,
      attempt: record.attempt_id,
      effect: record.effect_id,
      created_at: record.created_at,
    }))), ['sequence', 'kind', 'schema', 'attempt', 'effect', 'created_at']);
    return;
  }
  printTable(safeRows((body.runs ?? []).map((run) => ({
    run: run.pipeline_run_id,
    source: run.source_reference,
    pipeline: run.pipeline_id,
    outcome: run.terminal_outcome,
    attempts: run.attempt_count,
    results: run.result_count,
    decisions: run.decision_count,
    deliveries: run.delivery_count,
    normalized: run.normalized_result_count,
    checkpoints: run.checkpoint_count,
    effects: run.effect_count,
    settled_at: run.settled_at,
  }))), [
    'run', 'source', 'pipeline', 'outcome', 'attempts', 'results', 'decisions',
    'deliveries', 'normalized', 'checkpoints', 'effects', 'settled_at',
  ]);
}
