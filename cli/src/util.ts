// Small shared helpers used by the init/ship/status subcommands.
// Kept dependency-free (no framework) per SPEC "CLI contract".

const HTTP_TIMEOUT_MS = 15_000;

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Reads an env var, or prints a hint and returns undefined. Callers decide whether to exit. */
export function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function requireEnv(name: string, hint?: string): string {
  const v = readEnv(name);
  if (!v) {
    console.error(`Missing required env var: ${name}${hint ? ` — ${hint}` : ''}`);
    process.exit(1);
  }
  return v;
}

export function supervisorRequest(path: string, init?: RequestInit): Promise<Response> {
  const supervisorUrl = requireEnv(
    'OT_SUPERVISOR_URL',
    'the base URL of your deployed supervisor, e.g. https://openthrottle.fly.dev'
  );
  const statusToken = requireEnv(
    'OT_STATUS_TOKEN',
    'the operator bearer token configured on the supervisor'
  );
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${statusToken}`);
  return fetch(`${supervisorUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/**
 * Prints a plain-text table (no color/box-drawing deps). Columns are sized to the
 * widest cell in each column; missing values render as "-".
 */
export function printTable(rows: Array<Record<string, string | number | null | undefined>>, columns: string[]): void {
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }

  const cellText = (row: Record<string, string | number | null | undefined>, col: string): string => {
    const v = row[col];
    return v === null || v === undefined || v === '' ? '-' : String(v);
  };

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cellText(row, col).length))
  );

  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ');

  console.log(renderRow(columns));
  console.log(renderRow(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) {
    console.log(renderRow(columns.map((col) => cellText(row, col))));
  }
}

/** Minimal raw GraphQL fetch helper against the Linear API. */
export async function linearGraphQL<T = unknown>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Linear accepts either a plain API key or "Bearer <oauth token>" here.
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Linear API error: ${msg}`);
  }
  return json.data as T;
}
