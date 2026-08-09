import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { createAnalysisStore, type AnalysisStore } from "../persistence/pipeline/analysis-store.js";
import { STRUCTURED_STATUS_UNITS_SQL } from "../persistence/pipeline/status-store.js";
import type { ExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import type { PipelineStore } from "../pipeline/store.js";
import { loadPipelineCatalog, parseRepositoryConfig, stageById, type PipelineUnitPhaseBinding } from "../pipeline/manifest.js";
import { parseAndCompileExecutionGraph } from "../pipeline/execution-graph.js";
import { buildInstalledRuntimeDescriptor, type RuntimeInventory, type RuntimeLogs, type RuntimeSnapshotReadiness } from "../__fixtures__/runtime.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./server.js";

const structuredGraphPath = fileURLToPath(new URL("../../graphs/structured-v2.json", import.meta.url));

const cfg: Config = {
  port: 3000,
  databasePath: ":memory:",
  supervisorUrl: "https://supervisor.test",
  statusToken: "status-token",
  installSecret: "install-secret",
  linearWebhookSecret: "linear-secret",
  linearClientId: "linear-client",
  linearClientSecret: "linear-client-secret",
  githubWebhookSecret: "github-secret",
  githubToken: "github-token",
  githubReadToken: "github-read-token",
  daytonaApiKey: "runtime-key",
  daytonaSnapshot: "snapshot",
  defaultAgent: "codex",
  claudeCodeOauthToken: undefined,
  codexAuthJson: "{}",
  kimiCodeApiKey: undefined,
  taskTimeout: 7200,
  stallTimeoutSeconds: 900,
  orphanGraceMinutes: 15,
  runtimeResourceRetentionMinutes: 60,
  runOutcomeRetentionDays: 180,
  webhookMaxAgeSeconds: 300,
  sandboxEventPollIntervalMs: 5000,
  allowLinearMerge: false,
  pipelineCatalogPath: "pipelines",
  sandboxRuntimeRelease: "release",
  sandboxRuntimeDescriptorPath: "runtime.json",
};

type ServerRuntime = RuntimeInventory & RuntimeLogs & RuntimeSnapshotReadiness;

function unitPhaseBindings(): PipelineUnitPhaseBinding[] {
  const worker = {
    id: "worker",
    engine: "agent" as const,
    allowed_mcp_servers: [],
    session_scope: "fresh" as const,
    credentials: ["model.invoke", "repo.read", "repo.write"],
  };
  return [
    {
      id: "implement",
      kind: "agent",
      loop: {
        id: "loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "candidate", kind: "evidence" },
    {
      id: "lead",
      kind: "gate",
      loop: {
        id: "lead-loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: worker.credentials,
    },
    { id: "integrate", kind: "integrate" },
  ];
}

describe("coordinator-only server", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;
  let pipelines: PipelineStore;
  let analysisStore: AnalysisStore;

  beforeEach(() => {
    db = openDb(":memory:");
    pipelines = createPipelineStore(db);
    store = createSupervisorStore(db, pipelines);
    analysisStore = createAnalysisStore(db);
  });

  afterEach(() => db.close());

  function app(overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
    return createServer({
      cfg,
      store,
      runtime: {} as ServerRuntime,
      analysisStore,
      getLinearClient: async () => undefined,
      pipelineCoordinator: {
        catalog: {} as never,
        runtime: {} as never,
        store: pipelines,
        drainEffects: async () => undefined,
      },
      ...overrides,
    });
  }

  function seedTicket(): void {
    store.upsertUnpinned({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  }

  function seedPipelineTicket(): void {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n"),
    });
    const manifest = catalog.manifests.get("fixture/command@1")!;
    store.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
  }

  function seedStructuredPipelineTicket(): void {
    const runtime = buildInstalledRuntimeDescriptor("server-structured-test/v1", {
      capabilities: [
        ...buildInstalledRuntimeDescriptor("server-structured-base/v1").descriptor.capabilities,
        "accept-unit@1",
        "ce/simplify@1",
        "graph/for-each-unit@1",
      ],
    });
    const compiled = parseAndCompileExecutionGraph(readFileSync(structuredGraphPath, "utf8"), {
      source: structuredGraphPath,
      runtime: runtime.descriptor,
      aggregatePublishContext: "prefer_resume",
    });
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptManifest(compiled.manifest);
    const repositoryConfig = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }, { id: structured, kind: builtin, ref: core/structured@2 }]\npipelines: { implement: structured }\n"),
    });
    store.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest: compiled.manifest,
        repositoryConfig,
        runtime,
        authorizedCapabilities: compiled.manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
  }

  it("has no task completion callback route", async () => {
    const response = await app().request("/runs/run-1/complete", { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("exposes authenticated bounded capability evidence for the CLI pre-mutation gate", async () => {
    const runtime = buildInstalledRuntimeDescriptor("capabilities-endpoint-test/v1");
    const unauthorized = await app({ pipelineCoordinator: { catalog: {} as never, runtime, store: pipelines } })
      .request("/capabilities");
    expect(unauthorized.status).toBe(401);

    const response = await app({ pipelineCoordinator: { catalog: {} as never, runtime, store: pipelines } })
      .request("/capabilities", { headers: { Authorization: "Bearer status-token" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { release: string; capabilityDigest: string; capabilities: string[] };
    expect(body).toEqual({
      release: runtime.descriptor.release,
      capabilityDigest: runtime.digest,
      capabilities: runtime.descriptor.capabilities,
    });
  });

  it("reports coordinator status without execution-mode compatibility fields", async () => {
    seedTicket();
    const response = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown> & {
      tickets: Array<Record<string, unknown>>;
    };
    expect(body).not.toHaveProperty("execution_summary");
    expect(body.tickets[0]).not.toHaveProperty("execution_mode");
    expect(body.tickets[0]).toMatchObject({
      linear_issue_identifier: "OT-1",
      pipeline: null,
    });
  });

  it("serves the orchestration journal through an explicit read path", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    pipelines.recordJournalEntry({
      id: "journal-test-row",
      issueId: "issue-1",
      instanceId: instance.id,
      actor: "supervisor",
      kind: "terminal_observed",
      trigger: "test",
      action: "Observed a terminal outcome.",
      outcome: "no_change",
      refs: { stage: "command" },
    });

    const response = await app().request("/tickets/OT-1/journal", {
      headers: { Authorization: "Bearer status-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      journal: Array<{ id: string; issue: string; repository: string; kind: string }>;
    };
    const row = body.journal.find((entry) => entry.kind === "terminal_observed");
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row).toMatchObject({
      issue: "OT-1",
      repository: "owner/repo",
      kind: "terminal_observed",
    });
  });

  it("serves filterable run_outcomes evidence through the read-only analysis surface", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    db.prepare(`
      INSERT INTO run_outcomes (
        pipeline_instance_id, linear_issue_id, generation, execution_graph_id, plan_digest,
        base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
        repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
      ) VALUES (?, ?, 1, NULL, NULL, ?, 'codex', 'shipped', 'success', NULL, 1, '{}', '{}', NULL, ?, ?)
    `).run(
      instance.id,
      instance.linear_issue_id,
      instance.base_commit,
      JSON.stringify([{ skill: "builtin://ce/implement@1", skill_package_digest: null }]),
      "2026-08-08T00:00:00.000Z"
    );

    const matching = await app().request(
      "/analysis/runs?outcome=shipped&skill_digest=builtin%3A%2F%2Fce%2Fimplement%401",
      { headers: { Authorization: "Bearer status-token" } }
    );
    expect(matching.status).toBe(200);
    const matchingBody = await matching.json() as { runs: Array<{ pipeline_instance_id: string; outcome: string }> };
    expect(matchingBody.runs).toHaveLength(1);
    expect(matchingBody.runs[0]).toMatchObject({ pipeline_instance_id: instance.id, outcome: "shipped" });

    const nonMatching = await app().request("/analysis/runs?outcome=failed", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect((await nonMatching.json() as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it("rejects an unrecognized analysis filter value instead of silently returning no evidence", async () => {
    const response = await app().request("/analysis/runs?outcome=not_a_real_outcome", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a non-safe-integer limit instead of silently applying the default", async () => {
    // Every other filter on this endpoint fails closed on a malformed value;
    // `?limit=abc` (also `1.5`, `Infinity`) previously coerced to the 200-row
    // default silently instead (PR #156 follow-up review).
    for (const limit of ["abc", "1.5", "Infinity"]) {
      const response = await app().request(`/analysis/runs?limit=${limit}`, {
        headers: { Authorization: "Bearer status-token" },
      });
      expect(response.status, `limit=${limit}`).toBe(400);
    }
  });

  it("includes repeated sandbox ingestion failures in pipeline status", async () => {
    seedPipelineTicket();
    // Diagnostics are instance-scoped through the run/attempt binding, so the
    // failing event must belong to the pinned attempt's planned run.
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const runId = attempt.planned_run_id!;
    expect(store.beginRun({
      issueId: "issue-1",
      runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    store.insertSandboxEvent({
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      runId,
      sandboxId: "sandbox-1",
      kind: "stage_result",
      payload: JSON.stringify({ kind: "stage_result" }),
    });
    db.prepare(`
      UPDATE sandbox_events
      SET status = 'failed', attempts = 5, last_error = 'stage result attempt fence mismatch'
      WHERE event_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    `).run();
    // A superseded generation's failed event on the same ticket — diagnosed,
    // MORE attempts — must neither surface on nor mask the current instance.
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-old-generation",
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(false);
    db.prepare(`
      INSERT INTO runs (id, linear_issue_id, task_type, token_hash, status, started_at, expires_at)
      VALUES ('run-old-generation', 'issue-1', 'implement', 'token-hash', 'timed_out', '2026-07-25T00:00:00.000Z', '2026-07-25T02:00:00.000Z')
    `).run();
    store.insertSandboxEvent({
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      runId: "run-old-generation",
      sandboxId: "sandbox-0",
      kind: "stage_result",
      payload: JSON.stringify({ kind: "stage_result" }),
    });
    db.prepare(`
      UPDATE sandbox_events
      SET status = 'failed', attempts = 9, last_error = 'stale generation error',
          ingestion_diagnosed_at = '2026-07-25T00:00:00.000Z'
      WHERE event_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    `).run();

    const transientResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(transientResponse.status).toBe(200);
    const transientBody = await transientResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(transientBody.tickets[0]?.pipeline).toMatchObject({
      sandbox_event_id: null,
      sandbox_event_attempts: null,
      sandbox_ingestion_error: null,
    });

    db.prepare(`
      UPDATE sandbox_events
      SET ingestion_diagnosed_at = '2026-07-26T00:00:00.000Z'
      WHERE event_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    `).run();

    const response = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };

    expect(body.tickets[0]?.pipeline).toMatchObject({
      sandbox_event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sandbox_event_attempts: 5,
      sandbox_ingestion_error: "stage result attempt fence mismatch",
    });
  });

  it("exposes deep pipeline status fields for active repair and provider wait", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    db.prepare(`
      UPDATE pipeline_stage_attempts
      SET attempt_ordinal = 2, reentry_ordinal = 1
      WHERE id = ?
    `).run(attempt.id);
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'running', active_stage_id = 'command', wait_reason = NULL,
          updated_at = '2026-07-26T00:10:00.000Z'
      WHERE id = ?
    `).run(instance.id);
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at, last_error
      ) VALUES (
        'failed-dispatch', ?, 2, 'dispatch_stage', 'failed-dispatch',
        '{}', '44136fa355b3678a1146ad16f7e8649e94fb4f35495fb8a8e07a41149dc82ca4',
        'failed', 3, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z',
        'sandbox failed with Bearer ghp_secretvalue'
      )
    `).run(instance.id);
    const unitStore = pipelines as PipelineStore & ExecutionUnitStore;
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: attempt.id,
      parentStageId: "units",
      parentRunId: attempt.run_id ?? attempt.planned_run_id!,
      graphDigest: "graph-old",
      planDigest: "plan-old",
      units: [{ id: "old-unit" }],
      unitPhaseBindings: unitPhaseBindings(),
    });
    db.prepare(`
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count,
        created_at, updated_at
      ) VALUES (?, 'units', 99, 'passed', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z')
      ON CONFLICT(pipeline_instance_id, stage_id) DO NOTHING
    `).run(instance.id);
    db.prepare(`
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-latest', ?, 'session-1', 1, 'implement', 'request-hash',
        'completed', '2026-07-26T00:12:00.000Z', '2026-07-26T01:12:00.000Z'
      )
    `).run(instance.linear_issue_id);
    db.prepare(`
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-latest-units', ?, 'units', 1, 0, ?, 'attempt-latest-units',
        0, 'fresh', 'run-latest', 'run-latest', 'completed',
        '2026-07-26T00:12:00.000Z', '2026-07-26T00:12:00.000Z'
      )
    `).run(instance.id, "f".repeat(64));
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: "attempt-latest-units",
      parentStageId: "units",
      parentRunId: "run-latest",
      graphDigest: "graph-latest",
      planDigest: "plan-latest",
      units: [{ id: "latest-unit-z" }, { id: "latest-unit-a" }],
      unitPhaseBindings: unitPhaseBindings(),
    });
    db.prepare(`
      UPDATE execution_graphs
      SET updated_at = '2026-07-26T00:30:00.000Z'
      WHERE graph_digest = 'graph-old'
    `).run();

    const repairResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(repairResponse.status).toBe(200);
    const repairBody = await repairResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(repairBody.tickets[0]?.pipeline).toMatchObject({
      pipeline_id: "fixture/command",
      pipeline_version: 1,
      generation: 1,
      status: "running",
      terminal_outcome: null,
      stage_id: "command",
      attempt_ordinal: 2,
      reentry_ordinal: 1,
      wait_reason: null,
      whose_move: "working",
      last_error: "sandbox failed with [REDACTED]",
      last_state_change_at: "2026-07-26T00:10:00.000Z",
      structured_units: [
        expect.objectContaining({ unit_id: "latest-unit-z" }),
        expect.objectContaining({ unit_id: "latest-unit-a" }),
      ],
    });
    expect(JSON.stringify(repairBody.tickets[0]?.pipeline)).not.toContain("old-unit");
    const latestGraph = db.prepare(`
      SELECT id FROM execution_graphs
      WHERE pipeline_instance_id = ?
        AND parent_attempt_id = 'attempt-latest-units'
      LIMIT 1
    `).get(instance.id) as { id: string };
    const statusPlan = db.prepare(`EXPLAIN QUERY PLAN ${STRUCTURED_STATUS_UNITS_SQL}`)
      .all(latestGraph.id) as Array<{ detail: string }>;
    expect(statusPlan.some((row) => row.detail.includes("execution_units_graph_status_idx"))).toBe(true);

    db.prepare(`
      INSERT INTO pipeline_gate_receipts (
        id, pipeline_instance_id, attempt_id, evaluator_kind, policy_digest,
        subject, result, artifact_hashes, receipt_hash, payload, created_at
      ) VALUES (
        'failed-gate', ?, ?, 'semantic',
        'a000000000000000000000000000000000000000000000000000000000000000',
        NULL, 'failed', '[]',
        'b000000000000000000000000000000000000000000000000000000000000000',
        '{"summary":"newer gate failure"}', '2026-07-26T00:11:00.000Z'
      )
    `).run(instance.id, attempt.id);
    const gateResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const gateBody = await gateResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(gateBody.tickets[0]?.pipeline).toMatchObject({
      last_error: "newer gate failure",
    });

    db.prepare(`
      UPDATE pipeline_effect_intents
      SET next_attempt_at = '2026-07-26T00:12:00.000Z',
          last_error = 'newer effect failure'
      WHERE id = 'failed-dispatch'
    `).run();
    const newerEffectResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const newerEffectBody = await newerEffectResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(newerEffectBody.tickets[0]?.pipeline).toMatchObject({
      last_error: "newer effect failure",
    });

    db.prepare(`
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, reentry_count, created_at, updated_at
      ) VALUES (?, 'provider', 2, 'waiting', 1, 0, '2026-07-26T00:20:00.000Z', '2026-07-26T00:20:00.000Z')
    `).run(instance.id);
    db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider'
      WHERE id = ?
    `).run(attempt.id);
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = NULL,
          updated_at = '2026-07-26T00:20:00.000Z'
      WHERE id = ?
    `).run("d".repeat(40), "c".repeat(40), instance.id);
    // Production transitions never persist a pull_request receipt, so the
    // ticket projection (populated by the pull-request webhook) must back
    // published_pr_url on its own.
    store.setPrUrl("issue-1", "https://github.com/owner/repo/pull/11");
    const ticketFallbackResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(ticketFallbackResponse.status).toBe(200);
    const ticketFallbackBody = await ticketFallbackResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(ticketFallbackBody.tickets[0]?.pipeline).toMatchObject({
      published_pr_url: null,
    });

    db.prepare(`
      UPDATE pipeline_instances
      SET published_subject = ?, updated_at = '2026-07-26T00:20:30.000Z'
      WHERE id = ?
    `).run("d".repeat(40), instance.id);
    const boundTicketFallbackResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const boundTicketFallbackBody = await boundTicketFallbackResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(boundTicketFallbackBody.tickets[0]?.pipeline).toMatchObject({
      published_pr_url: "https://github.com/owner/repo/pull/11",
    });

    db.prepare(`
      UPDATE pipeline_instances
      SET published_commit = NULL, published_subject = NULL,
          updated_at = '2026-07-26T00:21:00.000Z'
      WHERE id = ?
    `).run(instance.id);
    const stalePublicationResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const stalePublicationBody = await stalePublicationResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(stalePublicationBody.tickets[0]?.pipeline).toMatchObject({
      published_pr_url: null,
    });
    db.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, published_commit = ?, published_subject = ?,
          updated_at = '2026-07-26T00:22:00.000Z'
      WHERE id = ?
    `).run("d".repeat(40), "c".repeat(40), "d".repeat(40), instance.id);

    db.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, kind, idempotency_key, payload, payload_hash,
        status, external_url, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        'published-pr', ?, 'pull_request', 'published-pr', '{}',
        '44136fa355b3678a1146ad16f7e8649e94fb4f35495fb8a8e07a41149dc82ca4',
        'acknowledged', 'https://github.com/owner/repo/pull/12', 1,
        '2026-07-26T00:20:00.000Z', '2026-07-26T00:20:00.000Z',
        '2026-07-26T00:20:00.000Z'
      )
    `).run(instance.id);

    const providerResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(providerResponse.status).toBe(200);
    const providerBody = await providerResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(providerBody.tickets[0]?.pipeline).toMatchObject({
      status: "waiting_provider",
      whose_move: "waiting on GitHub",
      published_pr_url: "https://github.com/owner/repo/pull/12",
    });
  });

  it("does not fall back to direct stop or steering for an unpinned ticket", async () => {
    seedTicket();
    const stop = await app().request("/tickets/OT-1/stop", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(stop.status).toBe(409);
    expect(await stop.json()).toEqual({ error: "pipeline not found" });

    const steer = await app().request("/tickets/OT-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "continue" }),
    });
    expect(steer.status).toBe(409);
    expect(await steer.json()).toEqual({ error: "pipeline not found" });
  });

  it("captures operator steering during a non-steerable running stage", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(store.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    pipelines.markStageDispatched(attempt.id);

    const response = await app().request("/tickets/OT-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "carry this forward" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "captured",
      message: "captured — retained for the next implementation or repair stage",
    });
    expect(db.prepare("SELECT run_id, source, body FROM session_inbox").get()).toEqual({
      run_id: null,
      source: "operator",
      body: "carry this forward",
    });
  });

  it("records a durable, visible note when steering is captured during a structured composite run", async () => {
    seedStructuredPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    expect(attempt.stage_id).toBe("units");
    const request = pipelines.getStageRequest(attempt.id);
    expect(request.liveSteering).toBe(false);
    expect(store.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    pipelines.markStageDispatched(attempt.id);
    const unitStore = pipelines as PipelineStore & ExecutionUnitStore;
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: attempt.id,
      parentStageId: attempt.stage_id,
      parentRunId: attempt.run_id ?? attempt.planned_run_id!,
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "U1" }],
      unitPhaseBindings: stageById(instance.normalized_manifest, "units")?.unitPhaseBindings,
    });

    const response = await app().request("/tickets/OT-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "carry this forward" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "captured" });
    expect(db.prepare("SELECT run_id, source, body FROM session_inbox").get()).toEqual({
      run_id: null,
      source: "operator",
      body: "carry this forward",
    });

    const events = db.prepare(
      "SELECT kind, unit_id, body FROM execution_publication_events WHERE parent_attempt_id = ?"
    ).all(attempt.id) as Array<{ kind: string; unit_id: string | null; body: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "steering_undelivered",
      unit_id: null,
    });
    expect(events[0]?.body).toContain("structured multi-unit stage");

    // A second capture during the same composite run records a second,
    // distinct event rather than silently deduping or overwriting the first.
    const second = await app().request("/tickets/OT-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "and this too" }),
    });
    expect(second.status).toBe(200);
    const eventsAfterSecond = db.prepare(
      "SELECT kind FROM execution_publication_events WHERE parent_attempt_id = ?"
    ).all(attempt.id);
    expect(eventsAfterSecond).toHaveLength(2);
  });

  it("still captures steering and returns 200 when recording the undelivered ledger note fails", async () => {
    seedStructuredPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(store.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    pipelines.markStageDispatched(attempt.id);
    const unitStore = pipelines as PipelineStore & ExecutionUnitStore;
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: attempt.id,
      parentStageId: attempt.stage_id,
      parentRunId: attempt.run_id ?? attempt.planned_run_id!,
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "U1" }],
      unitPhaseBindings: stageById(instance.normalized_manifest, "units")?.unitPhaseBindings,
    });
    const failingStore = new Proxy(pipelines, {
      get(target, prop, receiver) {
        if (prop === "recordSteeringCaptured") {
          return () => {
            throw new Error("simulated durable-ledger write failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await app({
      pipelineCoordinator: {
        catalog: {} as never,
        runtime: {} as never,
        store: failingStore,
        drainEffects: async () => undefined,
      },
    }).request("/tickets/OT-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "carry this forward despite the ledger write failing" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "captured" });
    expect(db.prepare("SELECT run_id, source, body FROM session_inbox").get()).toEqual({
      run_id: null,
      source: "operator",
      body: "carry this forward despite the ledger write failing",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_publication_events").get()).toEqual({ count: 0 });
    expect(consoleError).toHaveBeenCalledWith(
      "[steer] failed to record steering_undelivered ledger note:",
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it("distinguishes an accepted stop request from confirmed durable settlement", async () => {
    seedPipelineTicket();
    const pending = await app().request("/tickets/OT-1/stop", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ ok: true, status: "stop_requested" });

    const settled = await app({
      pipelineCoordinator: {
        catalog: {} as never,
        runtime: {} as never,
        store: pipelines,
        drainEffects: async () => {
          const stopEffect = pipelines.claimEffects(
            "2999-01-01T00:00:00.000Z",
            "2999-01-01T00:01:00.000Z"
          ).find((effect) => effect.kind === "stop")!;
          pipelines.recordEffectAcknowledgement({
            effectId: stopEffect.id,
            eventId: `effect-ack-${stopEffect.id}`,
            payload: "{}",
          });
        },
      },
    }).request("/tickets/OT-1/stop", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ ok: true, status: "stopped" });
  });

  it("requires the operator bearer on every operator surface", async () => {
    seedTicket();
    for (const [path, method] of [
      ["/status", "GET"],
      ["/status/journal", "GET"],
      ["/capabilities", "GET"],
      ["/analysis/runs", "GET"],
      ["/repositories", "GET"],
      ["/repositories/register", "POST"],
      ["/tickets/OT-1/stop", "POST"],
      ["/tickets/OT-1/steer", "POST"],
      ["/tickets/OT-1/logs", "GET"],
      ["/tickets/OT-1/journal", "GET"],
      ["/tickets/OT-1/publications/missing/retry", "POST"],
    ] as const) {
      const response = await app().request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("authenticates, freshness-checks, durably deduplicates, and schedules Linear webhooks", async () => {
    const process = vi.fn(async () => undefined);
    const runBackground = vi.fn((task: Promise<void>) => void task);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground,
    });
    const payload = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-webhook-1",
      webhookTimestamp: Date.now(),
      organizationId: "org-1",
      agentSession: {
        id: "session-1",
        issue: {
          id: "issue-1",
          identifier: "OT-1",
          team: { id: "team-1", key: "OT" },
          labels: [],
        },
      },
    });
    const signature = createHmac("sha256", cfg.linearWebhookSecret).update(payload).digest("hex");
    const request = () => server.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": signature,
        "Linear-Delivery": "linear-delivery-1",
      },
      body: payload,
    });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(1);
    expect(process).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenNthCalledWith(1, "linear-delivery-1");

    const invalid = await server.request("/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": "0".repeat(64) },
      body: payload,
    });
    expect(invalid.status).toBe(401);

    const stalePayload = JSON.stringify({
      ...JSON.parse(payload),
      webhookId: "linear-webhook-stale",
      webhookTimestamp: 0,
    });
    const staleSignature = createHmac("sha256", cfg.linearWebhookSecret)
      .update(stalePayload).digest("hex");
    const stale = await server.request("/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": staleSignature },
      body: stalePayload,
    });
    expect(stale.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(1);
  });

  it("fails Linear deliveries before admission when OAuth is unavailable", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: vi.fn(async () => undefined),
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: {
        catalog,
        runtime,
        store: pipelines,
        drainEffects: async () => undefined,
      },
    });
    store.claimDelivery({
      deliveryId: "linear-no-oauth",
      source: "linear",
      action: "created",
      eventName: "AgentSessionEvent",
      payload: JSON.stringify({
        action: "created",
        type: "AgentSessionEvent",
        webhookId: "linear-no-oauth",
        webhookTimestamp: Date.now(),
        organizationId: "org-1",
        agentSession: {
          id: "session-1",
          issue: {
            id: "issue-1",
            identifier: "OT-1",
            team: { id: "team-1", key: "OT" },
            labels: [{ name: "branch \u203a main" }],
          },
        },
      }),
    });

    await expect(processor.process("linear-no-oauth")).rejects.toThrow(
      "No valid Linear OAuth token is stored"
    );
    expect(store.getByIssueId("issue-1")).toBeUndefined();
    expect(
      db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?").get(
        "linear-no-oauth"
      )
    ).toEqual({ status: "failed", attempts: 1 });
  });

  it("rejects bad GitHub signatures and ignores signed unsupported events without persistence", async () => {
    const process = vi.fn(async () => undefined);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground: (task) => void task,
    });
    const payload = JSON.stringify({ action: "created" });
    const invalid = await server.request("/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: payload,
    });
    expect(invalid.status).toBe(401);

    const signature = createHmac("sha256", cfg.githubWebhookSecret).update(payload).digest("hex");
    const ignored = await server.request("/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: payload,
    });
    expect(ignored.status).toBe(200);
    expect(await ignored.text()).toBe("ignored");
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
    expect(process).not.toHaveBeenCalled();
  });

  it("serves a sanitized bounded durable run tail after cleanup", async () => {
    seedTicket();
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    store.finishRun({
      runId: "run-1",
      status: "completed",
      logTail: "finished with github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    });

    const response = await app().request("/tickets/OT-1/logs", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(response.status).toBe(200);
    const logs = await response.text();
    expect(logs).toContain("finished with [REDACTED]");
    expect(logs).not.toContain("github_pat_");
  });
});
