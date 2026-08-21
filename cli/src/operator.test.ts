import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logs from './logs.js';
import status from './status.js';
import stop from './stop.js';

const originalSupervisorUrl = process.env.OT_SUPERVISOR_URL;
const originalStatusToken = process.env.OT_STATUS_TOKEN;

beforeEach(() => {
  process.env.OT_SUPERVISOR_URL = 'https://supervisor.test/';
  process.env.OT_STATUS_TOKEN = 'operator-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalSupervisorUrl === undefined) delete process.env.OT_SUPERVISOR_URL;
  else process.env.OT_SUPERVISOR_URL = originalSupervisorUrl;
  if (originalStatusToken === undefined) delete process.env.OT_STATUS_TOKEN;
  else process.env.OT_STATUS_TOKEN = originalStatusToken;
});

function runProjection(overrides: Record<string, unknown> = {}) {
  return {
    pipeline_run_id: 'run-1',
    work_item_id: 'work-1',
    source_provider: 'linear',
    source_reference: 'OPE-1',
    title: 'Implement the kernel',
    pipeline_id: 'core/implement',
    status: 'running',
    terminal_outcome: null,
    stage_id: 'review',
    cursor_version: 3,
    current_subject: 'a'.repeat(40),
    definition_bundle_hash: 'b'.repeat(64),
    whose_move: 'working',
    attempt_status_counts: {
      pending: 0,
      running: 1,
      work_complete: 0,
      result_pending: 1,
      recorded: 0,
      settled: 2,
      needs_human: 0,
      failed: 0,
      canceled: 0,
      superseded: 0,
    },
    effect_status_counts: { pending: 1, acknowledged: 2 },
    attempts: [{
      id: 'attempt-review',
      scope_kind: 'stage',
      stage_id: 'review',
      status: 'result_pending',
      repository_authority: 'inspect',
      input_subject: 'a'.repeat(40),
      output_subject: null,
      native_session_bound: true,
      work_retry_ordinal: 0,
      result_correction_count: 1,
      result_correction_deadline: '2026-08-20T13:00:00.000Z',
      pending_diagnostic_count: 1,
      lease_purpose: 'result_correction',
      lease_expires_at: '2026-08-20T12:05:00.000Z',
      updated_at: '2026-08-20T12:00:00.000Z',
    }],
    effects: [{
      id: 'effect-publish',
      kind: 'github/publish-pr@1',
      status: 'pending',
      target: 'owner/repo',
      subject: 'a'.repeat(40),
      attempt_count: 1,
      available_at: '2026-08-20T12:00:00.000Z',
      lease_expires_at: null,
      detail: null,
      updated_at: '2026-08-20T12:00:00.000Z',
    }],
    truncated: false,
    updated_at: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('kernel operator commands', () => {
  it('prints one authenticated run projection by run or source reference', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ run: runProjection() }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('OPE-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/runs/OPE-1/status',
      expect.objectContaining({ headers: expect.any(Headers), signal: expect.any(AbortSignal) }),
    );
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer operator-token');
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('OPE-1 — Implement the kernel');
    expect(printed).toContain('run: run-1');
    expect(printed).toContain('pipeline: core/implement');
    expect(printed).toContain('result_pending=1');
    expect(printed).toContain('authority=inspect');
    expect(printed).toContain('github/publish-pr@1 pending');
    expect(printed).not.toMatch(/graph|receipt/i);
  });

  it('neutralizes terminal controls in status projections', async () => {
    const malicious = '\u001b[2J\u001b]0;owned\u0007hidden\u202Etxt';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      run: runProjection({ title: malicious }),
    })));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('run-1');

    const printed = output.mock.calls.flat().join('\n');
    expect(printed).not.toContain('\u001b');
    expect(printed).not.toContain('\u0007');
    expect(printed).not.toContain('\u202E');
    expect(printed).toContain('hidden');
  });

  it('renders bounded kernel log entries from JSON', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      pipeline_run_id: 'run-1',
      entries: [{
        occurred_at: '2026-08-20T12:00:00.000Z',
        kind: 'attempt',
        id: 'attempt-1',
        summary: 'stage=review status=running authority=inspect',
      }],
      next_cursor: null,
      truncated: false,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await logs('OPE-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/runs/OPE-1/logs?limit=500',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(output).toHaveBeenCalledWith(
      '[2026-08-20T12:00:00.000Z] attempt/attempt-1 stage=review status=running authority=inspect\n',
    );
  });

  it('requests an idempotent stop through the run control inbox', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      accepted: true,
      duplicate: false,
      pipeline_run_id: 'run-1',
    }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await stop('OPE/1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/runs/OPE%2F1/control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'stop', reason: 'operator CLI request' }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(output).toHaveBeenCalledWith('Stop requested for OPE/1.');
  });
});
