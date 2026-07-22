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

describe('operator commands', () => {
  it('prints authenticated supervisor status as a table', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
        tickets: [
          {
            linear_issue_identifier: 'OT-1',
            branch: 'ot/ot-1',
            agent: 'codex',
            state: 'active',
            pr_url: null,
            updated_at: '2026-07-18T00:00:00.000Z',
          },
          {
            linear_issue_identifier: 'OT-PIPE',
            branch: 'ot/pipe',
            agent: 'codex',
            state: 'active',
            pr_url: 'https://github.com/o/r/pull/1',
            updated_at: '2026-07-18T00:01:00.000Z',
            execution_mode: 'pipeline',
            pipeline: {
              pipeline_id: 'ce/implement',
              pipeline_version: 1,
              status: 'publication_blocked',
              stage_id: 'review',
              attempt_ordinal: 3,
              retry_count: 1,
              reentry_count: 2,
              wait_reason: 'permanent publication failure',
              subject: 'abcdef0123456789',
              gate_result: 'passed',
              context_policy: 'fresh_review',
              publication_state: 'blocked',
            },
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/status',
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      })
    );
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer operator-token');
    expect(output.mock.calls.flat().join('\n')).toContain('OT-1');
    expect(output.mock.calls.flat().join('\n')).toContain('ce/implement@1');
    expect(output.mock.calls.flat().join('\n')).toContain('publication_blocked');
    expect(output.mock.calls.flat().join('\n')).toContain('fresh_review');
  });

  it('stops an encoded ticket with the operator endpoint', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true })
    );
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await stop('OT/1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/tickets/OT%2F1/stop',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    );
    expect(output).toHaveBeenCalledWith('Stopped OT/1.');
  });

  it('writes sanitized logs returned by the supervisor', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('last task line\n')
    );
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await logs('OT-2');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/tickets/OT-2/logs',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(output).toHaveBeenCalledWith('last task line\n');
  });
});
