import { getErrorMessage, supervisorRequest } from './util.js';

interface TicketRow {
  linear_issue_identifier: string;
  branch: string;
  agent: string;
  state: string;
  pr_url: string | null;
  updated_at: string;
  pipeline?: {
    pipeline_id: string;
    pipeline_version: number;
    generation: number;
    task_type: 'implement' | 'investigate';
    status: string;
    terminal_outcome: string | null;
    stage_id: string | null;
    attempt_ordinal: number | null;
    reentry_ordinal: number | null;
    retry_count: number;
    reentry_count: number;
    wait_reason: string | null;
    whose_move: 'waiting on you' | 'waiting on GitHub' | 'working' | 'finished';
    last_error: string | null;
    last_state_change_at: string;
    subject: string | null;
    published_commit: string | null;
    published_pr_url: string | null;
    gate_result: string | null;
    context_policy: string | null;
    publication_state: string;
    publication_id: string | null;
    publication_error: string | null;
    recovery_action: string | null;
    effect_state: string;
    effect_kind: string | null;
    effect_status: string | null;
    effect_attempts: number | null;
    effect_error: string | null;
    sandbox_event_id: string | null;
    sandbox_event_attempts: number | null;
    sandbox_ingestion_error: string | null;
  } | null;
}

interface StatusResponse {
  tickets?: TicketRow[];
}

function value(input: string | number | null | undefined): string {
  return input === null || input === undefined || input === '' ? '-' : String(input);
}

function shortSha(input: string | null | undefined): string {
  return input ? input.slice(0, 12) : '-';
}

function renderTicket(ticket: TicketRow): void {
  console.log(`${ticket.linear_issue_identifier}`);
  console.log(`  whose move: ${ticket.pipeline?.whose_move ?? (ticket.state === 'closed' ? 'finished' : 'working')}`);
  console.log(`  branch: ${ticket.branch}`);
  console.log(`  agent: ${ticket.agent}`);
  console.log(`  state: ${ticket.state}`);
  console.log(`  pr: ${value(ticket.pipeline?.published_pr_url ?? ticket.pr_url)}`);
  if (!ticket.pipeline) {
    console.log(`  pipeline: -`);
    console.log(`  updated: ${ticket.updated_at}`);
    return;
  }
  const p = ticket.pipeline;
  console.log(`  pipeline: ${p.pipeline_id}@${p.pipeline_version} generation ${p.generation}`);
  console.log(`  status: ${p.status}`);
  console.log(`  terminal outcome: ${value(p.terminal_outcome)}`);
  console.log(`  stage: ${value(p.stage_id)}`);
  console.log(`  attempt: ${value(p.attempt_ordinal)} re-entry: ${value(p.reentry_ordinal)}`);
  console.log(`  wait reason: ${value(p.wait_reason)}`);
  console.log(`  last error: ${value(p.last_error ?? p.sandbox_ingestion_error ?? p.effect_error ?? p.publication_error)}`);
  console.log(`  subject: ${shortSha(p.subject)} published: ${shortSha(p.published_commit)}`);
  console.log(`  gate: ${value(p.gate_result)} context: ${value(p.context_policy)}`);
  console.log(`  publication: ${p.publication_state}${p.publication_id ? ` (${p.publication_id})` : ''}`);
  console.log(`  effect: ${p.effect_kind ? `${p.effect_kind}:${p.effect_status ?? p.effect_state}` : p.effect_state}`);
  console.log(`  recovery: ${value(p.recovery_action)}`);
  console.log(`  last state change: ${p.last_state_change_at}`);
}

export default async function status(ticketFilter?: string): Promise<void> {
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

  const tickets = ticketFilter
    ? (data.tickets ?? []).filter((ticket) => ticket.linear_issue_identifier === ticketFilter)
    : data.tickets ?? [];
  if (tickets.length === 0) {
    console.log(ticketFilter ? `(no ticket ${ticketFilter})` : '(no tickets)');
    return;
  }
  tickets.forEach((ticket, index) => {
    if (index > 0) console.log('');
    renderTicket(ticket);
  });
}
