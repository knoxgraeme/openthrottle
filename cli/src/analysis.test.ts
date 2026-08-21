import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import analysis from './analysis.js';

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

describe('kernel historical analysis', () => {
  it('queries settled runs through result, decision, and delivery metadata', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      runs: [{
        pipeline_run_id: 'run-7',
        source_reference: 'OPE-7',
        pipeline_id: 'core/implement',
        terminal_outcome: 'needs_human',
        attempt_count: 2,
        result_count: 2,
        decision_count: 2,
        delivery_count: 1,
        normalized_result_count: 1,
        checkpoint_count: 2,
        effect_count: 1,
        settled_at: '2026-08-20T12:00:00.000Z',
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analysis(['--outcome', 'needs_human', '--record-kind', 'result']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/analysis/runs?terminal_outcome=needs_human&record_kind=result',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('run-7');
    expect(printed).toContain('OPE-7');
    expect(printed).toContain('needs_human');
    expect(printed).not.toMatch(/graph|receipt/i);
  });

  it('queries record metadata by run or source reference', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      pipeline_run_id: 'run-7',
      records: [{
        sequence: 1,
        kind: 'decision',
        payload_schema: 'decision/v1',
        attempt_id: null,
        effect_id: null,
        created_at: '2026-08-20T12:00:00.000Z',
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analysis(['--run', 'OPE-7', '--record-kind', 'decision', '--limit', '20']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/runs/OPE-7/analysis?kind=decision&limit=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(output.mock.calls.flat().join('\n')).toContain('decision/v1');
  });

  it('rejects removed and invalid filters locally', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = process.exit;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    try {
      await expect(analysis(['--graph', 'old'])).rejects.toThrow(/exit 1/);
      await expect(analysis(['--outcome', 'shipped'])).rejects.toThrow(/exit 1/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.exit = exit;
    }
  });
});
