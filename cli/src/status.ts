// =============================================================================
// openthrottle status
//
// GET {OT_SUPERVISOR_URL}/status and print a plain table. `/status` is a
// read-only endpoint the supervisor must add per SPEC.md "CLI contract"
// (returns the `tickets` DB rows).
// =============================================================================

import { getErrorMessage, printTable, supervisorRequest } from './util.js';

interface TicketRow {
  linear_issue_identifier: string;
  branch: string;
  agent: string;
  state: string;
  pr_url: string | null;
  updated_at: string;
}

interface StatusResponse {
  tickets?: TicketRow[];
}

export default async function status(): Promise<void> {
  let res: Response;
  try {
    res = await supervisorRequest('/status');
  } catch (err: unknown) {
    console.error(`Could not reach the supervisor: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`GET /status → HTTP ${res.status}`);
    try {
      console.error(await res.text());
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let data: StatusResponse;
  try {
    data = (await res.json()) as StatusResponse;
  } catch (err: unknown) {
    console.error(`Could not parse response as JSON: ${getErrorMessage(err)}`);
    process.exit(1);
  }

  const tickets = data.tickets ?? [];
  printTable(
    tickets.map((t) => ({
      issue: t.linear_issue_identifier,
      branch: t.branch,
      agent: t.agent,
      state: t.state,
      pr: t.pr_url,
      updated: t.updated_at,
    })),
    ['issue', 'branch', 'agent', 'state', 'pr', 'updated']
  );
}
