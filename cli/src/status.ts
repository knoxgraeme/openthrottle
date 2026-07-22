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
  execution_mode?: 'legacy' | 'pipeline';
  pipeline?: {
    pipeline_id: string;
    pipeline_version: number;
    task_type: 'implement' | 'investigate';
    status: string;
    stage_id: string | null;
    attempt_ordinal: number | null;
    retry_count: number;
    reentry_count: number;
    wait_reason: string | null;
    subject: string | null;
    published_commit: string | null;
    gate_result: string | null;
    context_policy: string | null;
    publication_state: string;
  } | null;
}

interface StatusResponse {
  tickets?: TicketRow[];
  execution_summary?: {
    legacy: number;
    pipeline: number;
    waiting: number;
    publication_blocked: number;
  };
  legacy_drain?: {
    drained: boolean;
    total_obligations: number;
  };
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
  if (data.execution_summary) {
    const summary = data.execution_summary;
    console.log(
      `Execution: legacy=${summary.legacy} pipeline=${summary.pipeline} ` +
      `waiting=${summary.waiting} publication-blocked=${summary.publication_blocked}`
    );
  }
  if (data.legacy_drain) {
    console.log(
      `Legacy drain: ${data.legacy_drain.drained ? 'clear' : 'blocked'} ` +
      `(${data.legacy_drain.total_obligations} obligations)`
    );
  }
  printTable(
    tickets.map((t) => ({
      issue: t.linear_issue_identifier,
      branch: t.branch,
      agent: t.agent,
      mode: t.execution_mode ?? 'legacy',
      pipeline: t.pipeline ? `${t.pipeline.pipeline_id}@${t.pipeline.pipeline_version}` : null,
      task: t.pipeline?.task_type,
      state: t.pipeline?.status ?? t.state,
      stage: t.pipeline?.stage_id,
      attempt: t.pipeline?.attempt_ordinal,
      retry: t.pipeline?.retry_count,
      reentry: t.pipeline?.reentry_count,
      subject: t.pipeline?.subject ? t.pipeline.subject.slice(0, 12) : null,
      provider: t.pipeline?.published_commit ? t.pipeline.published_commit.slice(0, 12) : null,
      gate: t.pipeline?.gate_result,
      context: t.pipeline?.context_policy,
      publication: t.pipeline?.publication_state,
      wait: t.pipeline?.wait_reason,
      pr: t.pr_url,
      updated: t.updated_at,
    })),
    [
      'issue', 'branch', 'agent', 'mode', 'pipeline', 'task', 'state', 'stage', 'attempt',
      'retry', 'reentry', 'subject', 'provider', 'gate', 'context', 'publication', 'wait', 'pr', 'updated',
    ]
  );
}
