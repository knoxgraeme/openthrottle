import { terminalSafe } from './status.js';
import { getErrorMessage, supervisorRequest } from './util.js';

interface LogResponse {
  pipeline_run_id: string;
  entries: Array<{
    occurred_at: string;
    kind: string;
    id: string;
    summary: string;
  }>;
  truncated: boolean;
}

export default async function logs(reference: string | undefined): Promise<void> {
  if (!reference) {
    console.error('Usage: openthrottle logs <run-or-source-reference>');
    process.exit(1);
    return;
  }
  try {
    const response = await supervisorRequest(
      `/runs/${encodeURIComponent(reference)}/logs?limit=500`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${terminalSafe(await response.text())}`);
    const body = await response.json() as LogResponse;
    for (const entry of body.entries ?? []) {
      process.stdout.write(
        `[${terminalSafe(entry.occurred_at)}] ${terminalSafe(entry.kind)}/${terminalSafe(entry.id)} ` +
        `${terminalSafe(entry.summary)}\n`,
      );
    }
    if (body.truncated) {
      process.stdout.write('(log page truncated; continue through the HTTP cursor)\n');
    }
  } catch (error) {
    console.error(`Could not fetch logs for ${reference}: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}
