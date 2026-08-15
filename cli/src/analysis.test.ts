import {
  ANALYSIS_QUERY_ATTRIBUTIONS,
  ANALYSIS_QUERY_OUTCOMES,
  ANALYSIS_QUERY_REASONS,
} from '@openthrottle/contracts';
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

/** The vocabulary-backed flags, paired with the contract vocabulary each one accepts. */
const VOCABULARY_FLAGS: Array<[string, readonly string[]]> = [
  ['--outcome', ANALYSIS_QUERY_OUTCOMES],
  ['--reason', ANALYSIS_QUERY_REASONS],
  ['--attribution', ANALYSIS_QUERY_ATTRIBUTIONS],
];

describe('analysis vocabulary filters', () => {
  it('queries the supervisor and prints a table for a fully filtered valid query', async () => {
    const fetchMock = vi.fn(
      async () => Response.json({
        runs: [
          {
            pipeline_instance_id: 'instance-7',
            ticket_id: 'github:discussion-7',
            generation: 2,
            execution_graph_id: 'graph-7',
            plan_digest: 'plan-digest',
            base_commit: 'b'.repeat(40),
            engine: 'codex',
            outcome: 'needs_human',
            closed_reason: 'needs_human',
            fault_attribution: 'agent',
            generations_consumed: 2,
            token_cost_usd: 1.25,
            created_at: '2026-08-09T00:00:00.000Z',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analysis(['--outcome', 'needs_human', '--reason', 'needs_human', '--attribution', 'agent']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/analysis/runs?outcome=needs_human&reason=needs_human&attribution=agent',
      expect.objectContaining({ headers: expect.any(Headers), signal: expect.any(AbortSignal) })
    );
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toMatch(/^instance\s+ticket\s+outcome\s+reason\s+attribution/m);
    expect(printed).toContain('instance-7');
    expect(printed).toContain('github:discussion-7');
    expect(printed).toContain('needs_human');
    expect(printed).toContain('agent');
    expect(printed).toContain('graph-7');
    expect(printed).toContain('1.25');
  });

  it.each(VOCABULARY_FLAGS)(
    'rejects an invalid %s value locally without calling the supervisor',
    async (flag, allowed) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = process.exit;
      process.exit = ((code?: string | number | null) => {
        throw new Error(`exit ${code}`);
      }) as typeof process.exit;

      try {
        await expect(analysis([flag, 'not-a-real-value'])).rejects.toThrow(/exit 1/);
        const printed = errors.mock.calls.flat().join('\n');
        expect(printed).toContain(`Invalid value for ${flag}: not-a-real-value`);
        expect(printed).toContain(`Allowed values: ${allowed.join(', ')}`);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        process.exit = exit;
      }
    }
  );
});
