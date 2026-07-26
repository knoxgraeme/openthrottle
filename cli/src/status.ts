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
      publication_id: t.pipeline?.publication_id,
      effect: t.pipeline?.effect_kind
        ? `${t.pipeline.effect_kind}:${t.pipeline.effect_status ?? t.pipeline.effect_state}`
        : t.pipeline?.effect_state,
      effect_attempts: t.pipeline?.effect_attempts,
      sandbox_event: t.pipeline?.sandbox_event_id,
      sandbox_attempts: t.pipeline?.sandbox_event_attempts,
      error: t.pipeline?.sandbox_ingestion_error ?? t.pipeline?.effect_error ?? t.pipeline?.publication_error,
      recovery: t.pipeline?.recovery_action,
      wait: t.pipeline?.wait_reason,
      pr: t.pr_url,
      updated: t.updated_at,
    })),
    [
      'issue', 'branch', 'agent', 'pipeline', 'task', 'state', 'stage', 'attempt',
      'retry', 'reentry', 'subject', 'provider', 'gate', 'context', 'publication', 'publication_id',
      'effect', 'effect_attempts', 'sandbox_event', 'sandbox_attempts', 'error', 'recovery', 'wait', 'pr', 'updated',
    ]
  );
}
