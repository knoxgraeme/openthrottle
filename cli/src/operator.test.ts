import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import analysis from './analysis.js';
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
            id: 'linear:issue-1',
            reference: 'OT-1',
            current_session_id: 'session-1',
            control_provider: 'linear',
            external_thread: {
              provider: 'linear',
              id: 'issue-1',
              reference: 'OT-1',
            },
            branch: 'ot/ot-1',
            agent: 'codex',
            state: 'active',
            pr_url: null,
            updated_at: '2026-07-18T00:00:00.000Z',
          },
          {
            id: 'github:discussion-2',
            reference: 'GH-2',
            current_session_id: 'session-2',
            control_provider: 'github',
            external_thread: {
              provider: 'github',
              id: 'discussion-2',
              reference: 'owner/repo#2',
            },
            branch: 'ot/pipe',
            agent: 'codex',
            state: 'active',
            pr_url: 'https://github.com/o/r/pull/1',
            updated_at: '2026-07-18T00:01:00.000Z',
            pipeline: {
              pipeline_id: 'ce/implement',
              pipeline_version: 1,
              generation: 4,
              task_type: 'implement',
              status: 'publication_blocked',
              terminal_outcome: null,
              stage_id: 'review',
              attempt_ordinal: 3,
              reentry_ordinal: 1,
              retry_count: 1,
              reentry_count: 2,
              wait_reason: 'permanent publication failure',
              whose_move: 'waiting on you',
              last_error: 'termination was not confirmed',
              last_state_change_at: '2026-07-18T00:01:30.000Z',
              subject: 'abcdef0123456789',
              published_commit: '0123456789abcdef',
              published_pr_url: 'https://github.com/o/r/pull/1',
              gate_result: 'passed',
              context_policy: 'fresh',
              publication_state: 'blocked',
              publication_id: 'publication-1',
              publication_error: 'GitHub denied the update',
              recovery_action: 'POST /tickets/:identifier/publications/publication-1/retry',
              effect_state: 'blocked',
              effect_kind: 'stop',
              effect_status: 'dead',
              effect_attempts: 8,
              effect_error: 'termination was not confirmed',
              admission: {
                generated_content: true,
                proposed_route: 'structured',
                final_route: 'structured',
                semantic_repair_count: 1,
                infrastructure_retry_count: 2,
                terminal_state: 'accepted',
                questions: [],
                reviewer_verdict: 'approved',
                planner: { reference: 'builtin://admission-plan@1', package_digest: null },
                reviewer: { reference: 'repo://reviewer', package_digest: '1'.repeat(64) },
                admission_basis_digest: '2'.repeat(64),
                effective_manifest_digest: '3'.repeat(64),
                generated_plan_digest: '4'.repeat(64),
                checkpoint_digest: '5'.repeat(64),
                task_branch: { branch: 'ot/pipe', state: 'checkpointed', lineage: '6'.repeat(64) },
                publication_state: 'blocked',
              },
              structured_units: [{
                unit_id: 'U1',
                status: 'completed',
                terminal_level: 'completed',
                alarm: false,
                integration_subject: 'fedcba9876543210',
              }],
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
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('OT-1');
    expect(printed).toContain('id: linear:issue-1');
    expect(printed).toContain('session: session-1');
    expect(printed).toContain('control: linear');
    expect(printed).toContain('external thread: OT-1 (linear:issue-1)');
    expect(printed).toContain('GH-2');
    expect(printed).toContain('external thread: owner/repo#2 (github:discussion-2)');
    expect(printed).toContain('ce/implement@1');
    expect(printed).toContain('publication_blocked');
    expect(printed).toContain('whose move: waiting on you');
    expect(printed).toContain('fresh');
    expect(printed).toContain('implement');
    expect(printed).toContain('0123456789ab');
    expect(printed).toContain('U1: completed (no alarm) completed fedcba987654');
    expect(printed).toContain('stop:dead');
    expect(printed).toContain('termination was not confirmed');
    expect(printed).toContain('automatic admission: generated content, verify before relying on it');
    expect(printed).toContain('route: proposed structured final structured');
    expect(printed).toContain('retries: semantic 1 infrastructure 2');
    expect(printed).toContain('builtin://admission-plan@1');
    expect(printed).not.toContain('legacy=');
  });

  it('prints exact automatic-admission detail from the authenticated provider-neutral surface', async () => {
    const detail = {
      generated_content: true,
      warning: 'Automatically generated content. Verify before relying on it.',
      accepted_plan: { schema: 'openthrottle.execution-plan/v2', plan_id: 'accepted' },
      reviewer_receipt: { type: 'admission_review', result: 'approved', evidence: ['complete'] },
    };
    const fetchMock = vi.fn(async () => Response.json(detail));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status(['linear:issue-1', '--admission']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/tickets/linear%3Aissue-1/admission',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(output.mock.calls.flat().join('\n')).toContain('"plan_id": "accepted"');
    expect(output.mock.calls.flat().join('\n')).toContain('"result": "approved"');
  });

  it('neutralizes terminal controls and bidi overrides in automatic-admission status and detail', async () => {
    const malicious = '\u001b[2J\u001b]0;owned\u0007hidden\u202Etxt';
    const statusResponse = {
      tickets: [{
        id: 'linear:issue-1',
        reference: 'OT-1',
        current_session_id: 'session-1',
        control_provider: 'linear',
        external_thread: { provider: 'linear', id: 'issue-1', reference: 'OT-1' },
        branch: 'ot/issue-1',
        agent: 'codex',
        state: 'active',
        pr_url: null,
        updated_at: '2026-08-18T00:00:00.000Z',
        pipeline: {
          pipeline_id: 'core/automatic/identity',
          pipeline_version: 1,
          generation: 1,
          status: 'waiting_human',
          terminal_outcome: null,
          stage_id: 'admission_planner',
          attempt_ordinal: 1,
          reentry_ordinal: 0,
          wait_reason: null,
          whose_move: 'waiting on you',
          last_error: null,
          last_state_change_at: '2026-08-18T00:00:00.000Z',
          subject: 'a'.repeat(40),
          published_commit: null,
          published_pr_url: null,
          gate_result: null,
          context_policy: 'fresh',
          publication_state: 'pending',
          publication_id: null,
          publication_error: null,
          recovery_action: null,
          effect_state: 'idle',
          effect_kind: null,
          effect_status: null,
          effect_error: null,
          sandbox_ingestion_error: null,
          admission: {
            generated_content: true,
            proposed_route: 'needs_human',
            final_route: null,
            semantic_repair_count: 0,
            infrastructure_retry_count: 0,
            terminal_state: malicious,
            questions: [malicious],
            reviewer_verdict: null,
            planner: { reference: malicious, package_digest: malicious },
            reviewer: { reference: malicious, package_digest: malicious },
            admission_basis_digest: malicious,
            effective_manifest_digest: malicious,
            generated_plan_digest: malicious,
            checkpoint_digest: malicious,
            task_branch: { branch: malicious, state: malicious, lineage: malicious },
            publication_state: malicious,
          },
          structured_units: [],
        },
      }],
    };
    const detailResponse = {
      generated_content: true,
      warning: malicious,
      accepted_plan: { rationale: malicious },
      reviewer_receipt: { summary: malicious },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      Response.json(String(input).endsWith('/admission') ? detailResponse : statusResponse));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('linear:issue-1');
    await status(['linear:issue-1', '--admission']);

    const printed = output.mock.calls.flat().join('\n');
    expect(printed).not.toContain('\u001b');
    expect(printed).not.toContain('\u0007');
    expect(printed).not.toContain('\u202E');
    expect(printed).not.toContain('[2J');
    expect(printed).not.toContain(']0;owned');
    expect(printed).toContain('hidden');
  });

  it('filters status output to one ticket', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      tickets: [
        {
          id: 'linear:issue-1',
          reference: 'OT-1',
          current_session_id: 'session-1',
          control_provider: 'linear',
          external_thread: { provider: 'linear', id: 'issue-1', reference: 'OT-1' },
          branch: 'ot/ot-1',
          agent: 'codex',
          state: 'active',
          pr_url: null,
          updated_at: '2026-07-18T00:00:00.000Z',
          pipeline: null,
        },
        {
          id: 'linear:issue-2',
          reference: 'OT-2',
          current_session_id: 'session-2',
          control_provider: 'linear',
          external_thread: { provider: 'linear', id: 'issue-2', reference: 'OT-2' },
          branch: 'ot/ot-2',
          agent: 'codex',
          state: 'active',
          pr_url: null,
          updated_at: '2026-07-18T00:01:00.000Z',
          pipeline: null,
        },
      ],
    })));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('linear:issue-2');

    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('OT-2');
    expect(printed).not.toContain('OT-1');
  });

  it('does not treat a display reference as a status command identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      tickets: [{
        id: 'linear:issue-2',
        reference: 'OT-2',
        current_session_id: 'session-2',
        control_provider: 'linear',
        external_thread: { provider: 'linear', id: 'issue-2', reference: 'OT-2' },
        branch: 'ot/ot-2',
        agent: 'codex',
        state: 'active',
        pr_url: null,
        updated_at: '2026-07-18T00:01:00.000Z',
        pipeline: null,
      }],
    })));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('OT-2');

    expect(output).toHaveBeenCalledWith('(no ticket OT-2)');
  });

  it('prints an empty filtered status result clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tickets: [] })));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await status('OT-MISSING');

    expect(output).toHaveBeenCalledWith('(no ticket OT-MISSING)');
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

  it('reports an accepted stop that is still draining without claiming completion', async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { ok: true, status: 'stop_requested' },
      { status: 202 }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await stop('OT-2');

    expect(output).toHaveBeenCalledWith('Stop requested for OT-2.');
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

  it('queries the read-only analysis surface with the given filters and prints a table', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
        runs: [
          {
            pipeline_instance_id: 'instance-1',
            ticket_id: 'github:discussion-1',
            generation: 1,
            execution_graph_id: 'graph-1',
            plan_digest: 'plan-digest',
            base_commit: 'a'.repeat(40),
            engine: 'codex',
            outcome: 'shipped',
            closed_reason: 'success',
            fault_attribution: null,
            generations_consumed: 1,
            token_cost_usd: null,
            created_at: '2026-08-08T00:00:00.000Z',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analysis(['--outcome', 'shipped', '--skill-digest', 'builtin://ce/implement@1']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supervisor.test/analysis/runs?outcome=shipped&skill_digest=builtin%3A%2F%2Fce%2Fimplement%401',
      expect.objectContaining({ headers: expect.any(Headers), signal: expect.any(AbortSignal) })
    );
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toMatch(/^instance\s+ticket\s+outcome/m);
    expect(printed).toContain('instance-1');
    expect(printed).toContain('github:discussion-1');
    expect(printed).toContain('shipped');
    expect(printed).toContain('graph-1');
  });

  it('exits on an unrecognized analysis flag without calling the supervisor', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = process.exit;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;

    try {
      await expect(analysis(['--not-a-real-flag', 'x'])).rejects.toThrow(/exit 1/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.exit = exit;
    }
  });
});
