import { getErrorMessage, supervisorRequest } from './util.js';

type AttemptStatus =
  | 'pending'
  | 'running'
  | 'work_complete'
  | 'result_pending'
  | 'recorded'
  | 'settled'
  | 'needs_human'
  | 'failed'
  | 'canceled'
  | 'superseded';

interface AttemptProjection {
  id: string;
  scope_kind: 'stage' | 'loop_item' | 'fanout_member';
  stage_id: string;
  status: AttemptStatus;
  repository_authority: 'inspect' | 'edit';
  input_subject: string;
  output_subject: string | null;
  native_session_bound: boolean;
  work_retry_ordinal: number;
  result_correction_count: number;
  result_correction_deadline: string | null;
  pending_diagnostic_count: number;
  lease_purpose: 'work' | 'result_correction' | null;
  lease_expires_at: string | null;
  updated_at: string;
}

interface EffectProjection {
  id: string;
  kind: string;
  status: string;
  target: string;
  subject: string | null;
  attempt_count: number;
  available_at: string;
  lease_expires_at: string | null;
  detail: string | null;
  updated_at: string;
}

interface RunProjection {
  pipeline_run_id: string;
  work_item_id: string;
  source_provider: string;
  source_reference: string;
  title: string;
  pipeline_id: string;
  status: string;
  terminal_outcome: string | null;
  stage_id: string | null;
  cursor_version: number;
  current_subject: string;
  definition_bundle_hash: string;
  whose_move: 'working' | 'waiting_on_operator' | 'finished';
  attempt_status_counts: Record<AttemptStatus, number>;
  effect_status_counts: Record<string, number>;
  attempts: AttemptProjection[];
  effects: EffectProjection[];
  truncated: boolean;
  updated_at: string;
}

interface StatusResponse {
  run?: RunProjection;
}

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TERMINAL_OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
const TERMINAL_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE = /\u001b[@-_]/g;

export function terminalSafe(input: unknown): string {
  return String(input)
    .replace(TERMINAL_OSC, '')
    .replace(TERMINAL_CSI, '')
    .replace(TERMINAL_ESCAPE, '')
    .replace(TERMINAL_CONTROL, ' ')
    .replace(BIDI_CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortHash(input: string | null | undefined): string {
  return input ? terminalSafe(input).slice(0, 12) : '-';
}

function activeCounts(counts: Record<string, number>): string {
  const values = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${terminalSafe(name)}=${count}`);
  return values.length > 0 ? values.join(' ') : '-';
}

function render(run: RunProjection): void {
  console.log(`${terminalSafe(run.source_reference)} — ${terminalSafe(run.title)}`);
  console.log(`  run: ${terminalSafe(run.pipeline_run_id)}`);
  console.log(`  pipeline: ${terminalSafe(run.pipeline_id)}`);
  console.log(`  status: ${terminalSafe(run.status)}`);
  console.log(`  terminal outcome: ${terminalSafe(run.terminal_outcome ?? '-')}`);
  console.log(`  whose move: ${terminalSafe(run.whose_move.replaceAll('_', ' '))}`);
  console.log(`  stage: ${terminalSafe(run.stage_id ?? '-')}`);
  console.log(`  subject: ${shortHash(run.current_subject)}`);
  console.log(`  definition bundle: ${shortHash(run.definition_bundle_hash)}`);
  console.log(`  attempts: ${activeCounts(run.attempt_status_counts)}`);
  console.log(`  effects: ${activeCounts(run.effect_status_counts)}`);
  if (run.attempts.length > 0) {
    console.log('  attempt detail:');
    for (const attempt of run.attempts) {
      const correction = attempt.status === 'result_pending'
        ? ` diagnostics=${attempt.pending_diagnostic_count} correction=${attempt.result_correction_count}`
        : '';
      const lease = attempt.lease_purpose
        ? ` lease=${attempt.lease_purpose}@${attempt.lease_expires_at ?? '-'}`
        : '';
      console.log(
        `    ${terminalSafe(attempt.id)} ${terminalSafe(attempt.stage_id)} ` +
        `${terminalSafe(attempt.status)} authority=${attempt.repository_authority}` +
        `${correction}${lease}`,
      );
    }
  }
  if (run.effects.length > 0) {
    console.log('  effect detail:');
    for (const effect of run.effects) {
      console.log(
        `    ${terminalSafe(effect.id)} ${terminalSafe(effect.kind)} ` +
        `${terminalSafe(effect.status)} attempts=${effect.attempt_count}` +
        `${effect.detail ? ` detail=${terminalSafe(effect.detail)}` : ''}`,
      );
    }
  }
  if (run.truncated) console.log('  detail: truncated; use the API with a larger bounded limit');
  console.log(`  updated: ${terminalSafe(run.updated_at)}`);
}

export default async function status(input?: string | string[]): Promise<void> {
  const args = Array.isArray(input) ? input : input ? [input] : [];
  const json = args.includes('--json');
  const reference = args.find((argument) => argument !== '--json');
  if (!reference || args.some((argument) => argument !== '--json' && argument !== reference)) {
    console.error('Usage: openthrottle status <run-or-source-reference> [--json]');
    process.exit(1);
    return;
  }
  let response: Response;
  try {
    response = await supervisorRequest(`/runs/${encodeURIComponent(reference)}/status`);
  } catch (error) {
    console.error(`Could not reach the supervisor: ${getErrorMessage(error)}`);
    process.exit(1);
    return;
  }
  if (!response.ok) {
    console.error(`GET /runs/:reference/status → HTTP ${response.status}`);
    try {
      console.error(terminalSafe(await response.text()));
    } catch {
      // Ignore a secondary response-body failure.
    }
    process.exit(1);
    return;
  }
  let body: StatusResponse;
  try {
    body = await response.json() as StatusResponse;
  } catch (error) {
    console.error(`Could not parse response as JSON: ${getErrorMessage(error)}`);
    process.exit(1);
    return;
  }
  if (!body.run) {
    console.error('Supervisor returned no run projection.');
    process.exit(1);
    return;
  }
  if (json) {
    console.log(JSON.stringify(body.run, (_key, value) =>
      typeof value === 'string' ? terminalSafe(value) : value, 2));
    return;
  }
  render(body.run);
}
