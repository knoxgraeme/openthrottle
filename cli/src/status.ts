import { getErrorMessage, supervisorRequest } from './util.js';

interface TicketRow {
  id: string;
  reference: string;
  current_session_id: string;
  control_provider: string;
  external_thread: {
    provider: string;
    id: string;
    reference: string;
  };
  branch: string;
  agent: string;
  state: string;
  pr_url: string | null;
  updated_at: string;
  pipeline?: {
    pipeline_id: string;
    pipeline_version: number;
    generation: number;
    status: string;
    terminal_outcome: string | null;
    stage_id: string | null;
    attempt_ordinal: number | null;
    reentry_ordinal: number | null;
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
    effect_error: string | null;
    sandbox_ingestion_error: string | null;
    structured_active_unit_id?: string | null;
    structured_active_action?: string | null;
    structured_active_action_status?: string | null;
    structured_heartbeat_at?: string | null;
    structured_checkpoint_status?: string | null;
    sandbox_disk_minimum_gib?: number;
    sandbox_capacity_warning?: string | null;
    admission?: {
      generated_content: true;
      proposed_route: 'simple' | 'structured' | 'needs_human' | null;
      final_route: 'simple' | 'structured' | null;
      semantic_repair_count: number;
      infrastructure_retry_count: number;
      terminal_state: string | null;
      questions: string[];
      reviewer_verdict: 'approved' | 'rejected' | 'needs_human' | null;
      planner: { reference: string; package_digest: string | null };
      reviewer: { reference: string; package_digest: string | null };
      admission_basis_digest: string;
      effective_manifest_digest: string;
      generated_plan_digest: string | null;
      checkpoint_digest: string | null;
      task_branch: { branch: string; state: string; lineage: string | null };
      publication_state: string;
    } | null;
    structured_units?: Array<{
      unit_id: string;
      status: string;
      terminal_level: string | null;
      alarm: boolean;
      integration_subject: string | null;
    }>;
  } | null;
}

interface StatusResponse {
  tickets?: TicketRow[];
}

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TERMINAL_OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
const TERMINAL_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE = /\u001b[@-_]/g;

function terminalSafe(input: unknown): string {
  return String(input)
    .replace(TERMINAL_OSC, '')
    .replace(TERMINAL_CSI, '')
    .replace(TERMINAL_ESCAPE, '')
    .replace(TERMINAL_CONTROL, ' ')
    .replace(BIDI_CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function value(input: string | number | null | undefined): string {
  return input === null || input === undefined || input === '' ? '-' : terminalSafe(input);
}

function shortSha(input: string | null | undefined): string {
  return input ? terminalSafe(input).slice(0, 12) : '-';
}

function renderTicket(ticket: TicketRow): void {
  const externalThread = ticket.external_thread;
  console.log(ticket.reference);
  console.log(`  id: ${ticket.id}`);
  console.log(`  session: ${ticket.current_session_id}`);
  console.log(`  control: ${ticket.control_provider}`);
  console.log(`  external thread: ${externalThread.reference} (${externalThread.provider}:${externalThread.id})`);
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
  if (p.structured_active_action) {
    console.log(`  active unit/action: ${value(p.structured_active_unit_id)}/${p.structured_active_action} ` +
      `${value(p.structured_active_action_status)} heartbeat ${value(p.structured_heartbeat_at)}`);
  }
  if (p.structured_checkpoint_status) {
    console.log(`  checkpoint: ${p.structured_checkpoint_status}`);
  }
  if (p.sandbox_capacity_warning) console.log(`  capacity warning: ${p.sandbox_capacity_warning}`);
  if (p.admission) {
    const admission = p.admission;
    console.log('  automatic admission: generated content, verify before relying on it');
    console.log(`    route: proposed ${value(admission.proposed_route)} final ${value(admission.final_route)}`);
    console.log(`    terminal: ${value(admission.terminal_state)} reviewer: ${value(admission.reviewer_verdict)}`);
    console.log(`    retries: semantic ${admission.semantic_repair_count} infrastructure ${admission.infrastructure_retry_count}`);
    console.log(`    planner: ${terminalSafe(admission.planner.reference)} (${shortSha(admission.planner.package_digest)})`);
    console.log(`    reviewer: ${terminalSafe(admission.reviewer.reference)} (${shortSha(admission.reviewer.package_digest)})`);
    console.log(`    digests: admission ${shortSha(admission.admission_basis_digest)} manifest ${shortSha(admission.effective_manifest_digest)} plan ${shortSha(admission.generated_plan_digest)} checkpoint ${shortSha(admission.checkpoint_digest)}`);
    console.log(`    task branch: ${terminalSafe(admission.task_branch.branch)} ${terminalSafe(admission.task_branch.state)} ${shortSha(admission.task_branch.lineage)}`);
    console.log(`    publication: ${terminalSafe(admission.publication_state)}`);
    for (const question of admission.questions) console.log(`    question: ${terminalSafe(question)}`);
  }
  if (p.structured_units && p.structured_units.length > 0) {
    console.log('  units:');
    for (const unit of p.structured_units) {
      const level = unit.terminal_level ?? 'active';
      const alarm = unit.alarm ? 'alarm' : 'no alarm';
      console.log(`    ${unit.unit_id}: ${level} (${alarm}) ${unit.status} ${shortSha(unit.integration_subject)}`);
    }
  }
  console.log(`  recovery: ${value(p.recovery_action)}`);
  console.log(`  last state change: ${p.last_state_change_at}`);
}

export default async function status(input?: string | string[]): Promise<void> {
  const args = Array.isArray(input) ? input : input ? [input] : [];
  const admissionDetail = args.includes('--admission');
  const ticketFilter = args.find((argument) => argument !== '--admission');
  if (admissionDetail) {
    if (!ticketFilter) {
      console.error('Usage: openthrottle status <ticket> --admission');
      process.exit(1);
      return;
    }
    let detailResponse: Response;
    try {
      detailResponse = await supervisorRequest(`/tickets/${encodeURIComponent(ticketFilter)}/admission`);
    } catch (err: unknown) {
      console.error(`Could not reach the supervisor: ${getErrorMessage(err)}`);
      process.exit(1);
      return;
    }
    if (!detailResponse.ok) {
      console.error(`GET /tickets/:id/admission → HTTP ${detailResponse.status}`);
      process.exit(1);
      return;
    }
    try {
      console.log(JSON.stringify(await detailResponse.json(), (_key, candidate) =>
        typeof candidate === 'string' ? terminalSafe(candidate) : candidate, 2));
    } catch (err: unknown) {
      console.error(`Could not parse response as JSON: ${getErrorMessage(err)}`);
      process.exit(1);
    }
    return;
  }
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
    ? (data.tickets ?? []).filter((ticket) => ticket.id === ticketFilter)
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
