import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { createAnalysisStore, type AnalysisStore } from "../persistence/pipeline/analysis-store.js";
import { createCitationGateStore, type CitationGateStore } from "../persistence/pipeline/citation-gate-store.js";
import { createAdmissionDrainStore } from "../persistence/admission-drain-store.js";
import { STRUCTURED_STATUS_UNITS_SQL } from "../persistence/pipeline/status-store.js";
import type { ExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import type { PipelineStore } from "../pipeline/store.js";
import { loadPipelineCatalog, parseRepositoryConfig, stageById, type PipelineUnitPhaseBinding } from "../pipeline/manifest.js";
import { parseAndCompileExecutionGraph } from "../pipeline/execution-graph.js";
import { buildInstalledRuntimeDescriptor, type RuntimeInventory, type RuntimeLogs, type RuntimeSnapshotReadiness } from "../__fixtures__/runtime.js";
import { beginGithubSupervisorCommentWrite } from "../providers/github/comment-provenance.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./server.js";
import { CITATION_GRADE_SCHEMA } from "./citation-executor.js";

const structuredGraphPath = fileURLToPath(new URL("../../graphs/structured-v3.json", import.meta.url));

const cfg: Config = {
  port: 3000,
  databasePath: ":memory:",
  supervisorUrl: "https://supervisor.test",
  statusToken: "status-token",
  deployToken: "deploy-token",
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
  let citationGateStore: CitationGateStore;

  beforeEach(() => {
    db = openDb(":memory:");
    pipelines = createPipelineStore(db);
    store = createSupervisorStore(db, pipelines);
    analysisStore = createAnalysisStore(db);
    citationGateStore = createCitationGateStore(db, () => "2026-08-08T00:00:00.000Z");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  function app(overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
    return createServer({
      cfg,
      store,
      runtime: {} as ServerRuntime,
      analysisStore,
      citationGateStore,
      admissionDrainStore: createAdmissionDrainStore(db),
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

  // markDeliveryProcessed settles only a claimed ('processing') delivery, so
  // tests settle through the same claim -> mark path production uses.
  function settleDelivery(deliveryId: string): void {
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = ?
    `).run(deliveryId);
    store.claimDeliveryForProcessing({
      deliveryId,
      nowIso: new Date().toISOString(),
      leaseUntilIso: new Date(Date.now() + 60_000).toISOString(),
    });
    store.markDeliveryProcessed(deliveryId);
  }

  function seedTicket(): void {
    store.upsertUnpinned({
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  }

  function seedPipelineTicket(
    sessionId = "session-1",
    ticketId = "issue-1",
    ticketReference = "OT-1"
  ): void {
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
      ticket_id: ticketId,
      ticket_reference: ticketReference,
      session_id: sessionId,
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
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }, { id: structured, kind: builtin, ref: core/structured@3 }]\npipelines: { implement: structured }\n"),
    });
    store.upsert({
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
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
    const body = await response.json() as {
      release: string;
      capabilityDigest: string;
      capabilities: string[];
      limits: { taskTimeoutSeconds: number };
    };
    expect(body).toEqual({
      release: runtime.descriptor.release,
      capabilityDigest: runtime.digest,
      capabilities: runtime.descriptor.capabilities,
      limits: { taskTimeoutSeconds: 7200 },
    });
  });

  it("reserves maintenance mutation and fail-closed cutover evidence for the deployment token", async () => {
    const descriptor = buildInstalledRuntimeDescriptor("deploy-evidence-test/v1");
    const runtime = {
      listLabeledResources: vi.fn(async () => []),
    } as unknown as ServerRuntime;
    const server = app({
      runtime,
      pipelineCoordinator: { catalog: {} as never, runtime: descriptor, store: pipelines },
    });

    const statusTokenPause = await server.request("/maintenance/admission/pause", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(statusTokenPause.status).toBe(401);

    const unpausedEvidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(await unpausedEvidence.json()).toMatchObject({
      admission: { paused: 0 },
      drain: {
        clear: false,
        blockers: [{ kind: "admission_not_paused", id: "admission" }],
      },
    });

    const paused = await server.request("/maintenance/admission/pause", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({ reason: "v12 cutover drain" }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      admission: { paused: 1, epoch: 1, reason: "v12 cutover drain" },
    });

    const statusTokenEvidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(statusTokenEvidence.status).toBe(401);

    const evidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({
      admission: { paused: 1, reason: "v12 cutover drain" },
      runtime: { release: descriptor.descriptor.release, capabilityDigest: descriptor.digest },
      snapshot: "snapshot",
      cutover: null,
      database: {
        migrationRollbackCompatibility: {
          contract: "schema-migrations-name-additive-rollback-compatible/v1",
          markerField: "schema_migrations.name",
          markerSuffix: " [rollback-compatible:additive/v1]",
        },
      },
      drain: { clear: true, blockers: [], truncated: false },
    });
    expect(runtime.listLabeledResources).toHaveBeenCalledWith(51);

    runtime.listLabeledResources = vi.fn(async () => [{
      id: "orphan-runtime",
      state: "started",
      createdAt: "2026-08-13T00:00:00.000Z",
      memory: 8,
    }]);
    const orphanEvidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(await orphanEvidence.json()).toMatchObject({
      drain: {
        clear: false,
        blockers: [{ kind: "unknown_runtime_inventory_resource", id: "orphan-runtime" }],
      },
    });

    runtime.listLabeledResources = vi.fn(async () => {
      throw new Error("provider inventory unavailable");
    });
    const failedInventoryEvidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(await failedInventoryEvidence.json()).toMatchObject({
      drain: {
        clear: false,
        blockers: [{ kind: "runtime_inventory_error", id: "runtime-inventory" }],
      },
    });

    const resumed = await server.request("/maintenance/admission/resume", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      admission: { paused: 0, epoch: 2, reason: null },
    });
  });

  it("persists deployment cutover transactions behind the deploy token", async () => {
    const descriptor = buildInstalledRuntimeDescriptor("deploy-evidence-test/v1");
    const runtime = { listLabeledResources: vi.fn(async () => []) } as unknown as ServerRuntime;
    const server = app({
      runtime,
      pipelineCoordinator: { catalog: {} as never, runtime: descriptor, store: pipelines },
    });

    const unauthorized = await server.request("/deployment/cutover/begin", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unauthorized.status).toBe(401);

    const begin = await server.request("/deployment/cutover/begin", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        oldRuntimeRelease: descriptor.descriptor.release,
        oldSnapshot: "snapshot",
        candidateSnapshot: "openthrottle-ce-new",
        evidence: "initial proof",
      }),
    });
    expect(begin.status).toBe(200);
    const beginBody = await begin.json() as { cutover: { id: string } };
    expect(beginBody.cutover).toMatchObject({
      status: "active",
      phase: "registered",
      old_runtime_release: descriptor.descriptor.release,
      old_snapshot: "snapshot",
      candidate_snapshot: "openthrottle-ce-new",
    });

    const duplicate = await server.request("/deployment/cutover/begin", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        oldRuntimeRelease: descriptor.descriptor.release,
        oldSnapshot: "snapshot",
        candidateSnapshot: "openthrottle-ce-new",
      }),
    });
    expect(await duplicate.json()).toMatchObject({ cutover: { id: beginBody.cutover.id } });

    const ambiguous = await server.request("/deployment/cutover/begin", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        oldRuntimeRelease: descriptor.descriptor.release,
        oldSnapshot: "snapshot",
        candidateSnapshot: "openthrottle-ce-other",
      }),
    });
    expect(ambiguous.status).toBe(409);

    const paused = await server.request("/deployment/cutover/advance", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: beginBody.cutover.id,
        phase: "paused",
        pauseEpoch: 1,
        evidence: "pause evidence",
      }),
    });
    expect(await paused.json()).toMatchObject({
      cutover: { phase: "paused", pause_epoch: 1, evidence: "pause evidence" },
    });

    const evidence = await server.request("/deployment/cutover-evidence", {
      headers: { Authorization: "Bearer deploy-token" },
    });
    expect(await evidence.json()).toMatchObject({
      cutover: { id: beginBody.cutover.id, phase: "paused", pause_epoch: 1 },
    });
  });

  it("keeps compact sealed cutover evidence recoverable through the 4000-character HTTP bound", async () => {
    const descriptor = buildInstalledRuntimeDescriptor("deploy-evidence-test/v1");
    const runtime = { listLabeledResources: vi.fn(async () => []) } as unknown as ServerRuntime;
    const server = app({
      runtime,
      pipelineCoordinator: { catalog: {} as never, runtime: descriptor, store: pipelines },
    });
    const blockers = Array.from({ length: 50 }, (_, index) => ({
      id: `session-${index}`,
      reason: "drain blocker ".repeat(80),
    }));
    const oversizedInitialEvidence = JSON.stringify({
      admission: { paused: 0, epoch: 7 },
      runtime: { release: descriptor.descriptor.release, capabilityDigest: descriptor.digest },
      snapshot: "snapshot",
      drain: { clear: false, blockers },
    });
    expect(oversizedInitialEvidence.length).toBeGreaterThan(4_000);
    const compactSeal = JSON.stringify({
      schema: "openthrottle.cutover-evidence/v1",
      event: "begin",
      source_sha256: `sha256:${"a".repeat(64)}`,
      summary: {
        admission: { paused: 0, epoch: 7 },
        runtime: { release: descriptor.descriptor.release, capabilityDigest: descriptor.digest },
        snapshot: "snapshot",
        drain: { clear: false, blocker_count: 50 },
      },
      sealed_old_runtime: {
        old_runtime_capability_digest: descriptor.digest,
        old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
      },
    });
    expect(compactSeal.length).toBeLessThan(4_000);

    const begin = await server.request("/deployment/cutover/begin", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        oldRuntimeRelease: descriptor.descriptor.release,
        oldSnapshot: "snapshot",
        candidateSnapshot: "openthrottle-ce-new",
        evidence: compactSeal,
      }),
    });
    const beginBody = await begin.json() as { cutover: { id: string; evidence: string } };
    expect(JSON.parse(beginBody.cutover.evidence).sealed_old_runtime).toEqual({
      old_runtime_capability_digest: descriptor.digest,
      old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
    });

    const paused = await server.request("/deployment/cutover/advance", {
      method: "POST",
      headers: { Authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: beginBody.cutover.id,
        phase: "paused",
        pauseEpoch: 8,
        evidence: JSON.stringify({ ...JSON.parse(compactSeal), event: "paused" }),
      }),
    });
    const pausedBody = await paused.json() as { cutover: { evidence: string } };
    expect(JSON.parse(pausedBody.cutover.evidence).sealed_old_runtime).toEqual({
      old_runtime_capability_digest: descriptor.digest,
      old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
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
    expect(body.tickets[0]).not.toHaveProperty("ticket_reference");
    expect(body.tickets[0]).toMatchObject({
      id: "issue-1",
      reference: "OT-1",
      current_session_id: "session-1",
      control_provider: "linear",
      external_thread: {
        provider: "linear",
        id: "issue-1",
        reference: "OT-1",
      },
      pipeline: null,
    });
  });

  it("serves filterable run_outcomes evidence through the read-only analysis surface", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    db.prepare(`
      INSERT INTO run_outcomes (
        pipeline_instance_id, ticket_id, generation, execution_graph_id, plan_digest,
        base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
        repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
      ) VALUES (?, ?, 1, NULL, NULL, ?, 'codex', 'shipped', 'success', NULL, 1, '{}', '{}', NULL, ?, ?)
    `).run(
      instance.id,
      instance.ticket_id,
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

  it("grades citation proposals by re-executing expected analysis queries server-side", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    db.prepare(`
      INSERT INTO run_outcomes (
        pipeline_instance_id, ticket_id, generation, execution_graph_id, plan_digest,
        base_commit, engine, outcome, closed_reason, fault_attribution, generations_consumed,
        repair_rounds_by_unit, phase_durations_ms, token_cost_usd, skill_digests, created_at
      ) VALUES (?, ?, 1, 'structured', NULL, ?, 'codex', 'failed', 'failure', 'agent', 1, '{}', '{}', NULL, ?, ?)
    `).run(
      instance.id,
      instance.ticket_id,
      instance.base_commit,
      JSON.stringify([{ skill: "builtin://ce/implement@1", skill_package_digest: null }]),
      "2026-08-08T00:00:00.000Z"
    );

    const proposal = {
      schema: "openthrottle.citation-contract/v1",
      id: "proposal_one",
      summary: "Claim grounded in analysis.",
      claims: [{ id: "claim_one", text: "The agent failed.", citation_ids: ["citation_one"] }],
      citations: [{
        id: "citation_one",
        query: {
          outcome: "failed",
          reason: "failure",
          attribution: "agent",
          graph: "structured",
          skill_digest: "builtin://ce/implement@1",
          from: "2026-08-08T02:00:00+0200",
          limit: 1,
        },
        expected_result: [{
          pipeline_instance_id: instance.id,
          generation: 1,
          execution_graph_id: "structured",
          outcome: "failed",
          closed_reason: "failure",
          fault_attribution: "agent",
          created_at: "2026-08-08T02:00:00+02:00",
        }],
        source_digests: ["a".repeat(64)],
      }],
      dispositions: [{
        claim_id: "claim_one",
        disposition: "supported",
        rationale: "The analysis read reproduced.",
        citation_ids: ["citation_one"],
      }],
      grades: [{
        id: "overall",
        value: "pass",
        disposition_claim_ids: ["claim_one"],
        rationale: "All cited claims reproduced.",
      }],
    };

    const response = await app().request("/analysis/citations/grade", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify(proposal),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: CITATION_GRADE_SCHEMA,
      proposal_id: "proposal_one",
      result: "pass",
      surviving_claim_ids: ["claim_one"],
      dropped_claim_ids: [],
      citations: [{ id: "citation_one", result: "reproduced" }],
      claims: [{ id: "claim_one", result: "survived" }],
      gate: { result: "passed", outcome: "success", reason: "all_citations_reproduced" },
    });
  });

  it("rejects invalid, oversized, reversed-window, and unreferenced citation contracts before grading", async () => {
    const proposal = {
      schema: "openthrottle.citation-contract/v1",
      id: "proposal_invalid",
      summary: "Invalid evidence graph.",
      claims: [{ id: "claim_one", text: "A claim.", citation_ids: ["citation_one"] }],
      citations: [{
        id: "citation_one",
        query: { outcome: "failed", from: "2026-02-30T00:00:00Z" },
        expected_result: [],
        source_digests: ["a".repeat(64)],
      }],
      dispositions: [{
        claim_id: "claim_one",
        disposition: "supported",
        rationale: "Purported support.",
        citation_ids: ["citation_one"],
      }],
      grades: [{
        id: "overall",
        value: "pass",
        disposition_claim_ids: ["claim_one"],
        rationale: "Purported pass.",
      }],
    };

    const grade = (body: unknown) => app().request("/analysis/citations/grade", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await grade(proposal)).status).toBe(400);
    const invalidQuery = proposal.citations[0]!.query as { outcome: string; from: string; to?: string };
    invalidQuery.from = "2026-08-08T00:00:00.000Z";
    const oversized = await app().request("/analysis/citations/grade", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: `${JSON.stringify(proposal)}${" ".repeat(256 * 1024)}`,
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: expect.stringContaining("JSON exceeds 256 KiB") });

    const compact = JSON.stringify(proposal);
    const maxSizedJson = `${compact}${" ".repeat((256 * 1024) - Buffer.byteLength(compact))}`;
    const bomPrefixed = await app().request("/analysis/citations/grade", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), maxSizedJson]),
    });
    expect(bomPrefixed.status).toBe(400);
    expect(await bomPrefixed.json()).toMatchObject({ error: expect.stringContaining("JSON exceeds 256 KiB") });

    invalidQuery.to = "2026-08-07T23:59:59.999Z";
    expect((await grade(proposal)).status).toBe(400);
    delete invalidQuery.to;
    proposal.citations.push({
      id: "orphan_citation",
      query: { outcome: "failed", from: "2026-08-08T00:00:00.000Z" },
      expected_result: [],
      source_digests: ["b".repeat(64)],
    });
    expect((await grade(proposal)).status).toBe(400);
  });

  it("grades ordinary citation mismatches without throwing and fails closed when no claims survive", async () => {
    seedPipelineTicket();
    const instance = pipelines.getInstanceForSession("session-1")!;
    const proposal = {
      schema: "openthrottle.citation-contract/v1",
      id: "proposal_mismatch",
      summary: "Claim with stale evidence.",
      claims: [{ id: "claim_one", text: "The run shipped.", citation_ids: ["citation_one"] }],
      citations: [{
        id: "citation_one",
        query: { outcome: "shipped", limit: 1 },
        expected_result: [{
          pipeline_instance_id: instance.id,
          generation: 1,
          execution_graph_id: null,
          outcome: "shipped",
          closed_reason: "success",
          fault_attribution: null,
          created_at: "2026-08-08T00:00:00.000Z",
        }],
        source_digests: ["b".repeat(64)],
      }],
      dispositions: [{
        claim_id: "claim_one",
        disposition: "supported",
        rationale: "The stale expected row should not survive.",
        citation_ids: ["citation_one"],
      }],
      grades: [{
        id: "overall",
        value: "pass",
        disposition_claim_ids: ["claim_one"],
        rationale: "Input grade is rechecked server-side.",
      }],
    };

    const response = await app().request("/analysis/citations/grade", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify(proposal),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      schema: CITATION_GRADE_SCHEMA,
      proposal_id: "proposal_mismatch",
      result: "fail",
      surviving_claim_ids: [],
      dropped_claim_ids: ["claim_one"],
      citations: [{ id: "citation_one", result: "mismatch", actual_result: [] }],
      claims: [{ id: "claim_one", result: "dropped" }],
      gate: { result: "failed", outcome: "failure", reason: "stale_evidence" },
    });
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
      INSERT INTO runs (id, ticket_id, task_type, token_hash, status, started_at, expires_at)
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
        id, ticket_id, session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-latest', ?, 'session-1', 1, 'implement', 'request-hash',
        'completed', '2026-07-26T00:12:00.000Z', '2026-07-26T01:12:00.000Z'
      )
    `).run(instance.ticket_id);
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
      published_commit: null,
      published_pr_url: "https://github.com/owner/repo/pull/11",
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
      published_commit: "c".repeat(40),
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
      published_commit: null,
      published_pr_url: "https://github.com/owner/repo/pull/11",
    });

    db.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, published_commit = ?, published_subject = ?,
          updated_at = '2026-07-26T00:21:30.000Z'
      WHERE id = ?
    `).run("e".repeat(40), "c".repeat(40), "d".repeat(40), instance.id);
    const advancedSubjectResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const advancedSubjectBody = await advancedSubjectResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(advancedSubjectBody.tickets[0]?.pipeline).toMatchObject({
      published_commit: null,
      published_pr_url: "https://github.com/owner/repo/pull/11",
    });

    db.prepare(`
      UPDATE tickets
      SET pr_url = NULL
      WHERE ticket_id = 'issue-1'
    `).run();
    db.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, kind, idempotency_key, payload, payload_hash,
        status, external_url, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        'pending-pr', ?, 'pull_request', 'pending-pr', '{}',
        '44136fa355b3678a1146ad16f7e8649e94fb4f35495fb8a8e07a41149dc82ca4',
        'pending', 'https://github.com/owner/repo/pull/pending', 1,
        '2026-07-26T00:21:30.000Z', '2026-07-26T00:21:30.000Z',
        '2026-07-26T00:21:30.000Z'
      )
    `).run(instance.id);
    const unknownUrlResponse = await app().request("/status", {
      headers: { Authorization: "Bearer status-token" },
    });
    const unknownUrlBody = await unknownUrlResponse.json() as {
      tickets: Array<{ pipeline: Record<string, unknown> | null }>;
    };
    expect(unknownUrlBody.tickets[0]?.pipeline).toMatchObject({
      published_commit: null,
      published_pr_url: null,
    });
    db.prepare(`
      UPDATE pipeline_instances
      SET immutable_subject = ?, published_commit = ?, published_subject = ?,
          updated_at = '2026-07-26T00:22:00.000Z'
      WHERE id = ?
    `).run("d".repeat(40), "c".repeat(40), "d".repeat(40), instance.id);
    store.setPrUrl("issue-1", "https://github.com/owner/repo/pull/11");

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
      published_pr_url: "https://github.com/owner/repo/pull/11",
    });
  });

  it("does not fall back to direct stop or steering for an unpinned ticket", async () => {
    seedTicket();
    const referenceStop = await app().request("/tickets/OT-1/stop", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(referenceStop.status).toBe(404);
    expect(await referenceStop.json()).toEqual({ error: "ticket not found" });

    const stop = await app().request("/tickets/issue-1/stop", {
      method: "POST",
      headers: { Authorization: "Bearer status-token" },
    });
    expect(stop.status).toBe(409);
    expect(await stop.json()).toEqual({ error: "pipeline not found" });

    const steer = await app().request("/tickets/issue-1/steer", {
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

    const response = await app().request("/tickets/issue-1/steer", {
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
    expect(db.prepare("SELECT run_id, source, body FROM steering_items").get()).toEqual({
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

    const response = await app().request("/tickets/issue-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "carry this forward" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "captured" });
    expect(db.prepare("SELECT run_id, source, body FROM steering_items").get()).toEqual({
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
    const second = await app().request("/tickets/issue-1/steer", {
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
    }).request("/tickets/issue-1/steer", {
      method: "POST",
      headers: {
        Authorization: "Bearer status-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "carry this forward despite the ledger write failing" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "captured" });
    expect(db.prepare("SELECT run_id, source, body FROM steering_items").get()).toEqual({
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
    const pending = await app().request("/tickets/issue-1/stop", {
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
    }).request("/tickets/issue-1/stop", {
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
      ["/capabilities", "GET"],
      ["/deployment/cutover-evidence", "GET"],
      ["/maintenance/admission/pause", "POST"],
      ["/maintenance/admission/resume", "POST"],
      ["/analysis/runs", "GET"],
      ["/repositories", "GET"],
      ["/repositories/register", "POST"],
      ["/tickets/issue-1/stop", "POST"],
      ["/tickets/issue-1/steer", "POST"],
      ["/tickets/issue-1/logs", "GET"],
      ["/tickets/issue-1/publications/missing/retry", "POST"],
    ] as const) {
      const response = await app().request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("registers GitHub-controlled repositories without Linear fields or configuration and creates the exact control label", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/repos/owner/repo")) {
        return Response.json({ full_name: "owner/repo", default_branch: "main" });
      }
      if (url.endsWith("/repos/owner/repo/branches/main")) return Response.json({ name: "main" });
      if (url.endsWith("/repos/owner/repo/hooks?per_page=100")) return Response.json([]);
      if (url.endsWith("/repos/owner/repo/hooks") && method === "POST") return Response.json({ id: 8 });
      if (url.endsWith("/repos/owner/repo/labels?per_page=100")) return Response.json([]);
      if (url.endsWith("/repos/owner/repo/labels") && method === "POST") {
        return Response.json({ name: "openthrottle" });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const server = app({
      cfg: {
        ...cfg,
        linearWebhookSecret: undefined,
        linearClientId: undefined,
        linearClientSecret: undefined,
      },
      runtime: {
        getSnapshot: async () => ({ name: "snapshot", state: "active" }),
      } as unknown as ServerRuntime,
    });

    const response = await server.request("/repositories/register", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo", controlProvider: "github" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registration: {
        control_provider: "github",
        linear_team_key: null,
        linear_team_id: null,
      },
      readiness: { github: "ready", controlLabel: "created" },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      body: { name: "openthrottle" },
    });
  });

  it("requires Linear routing fields and credentials only for Linear-controlled registration", async () => {
    const missingFields = await app().request("/repositories/register", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo", controlProvider: "linear" }),
    });
    expect(missingFields.status).toBe(400);
    expect(await missingFields.json()).toMatchObject({ error: expect.stringContaining("linearTeamKey") });

    const unavailable = await app({
      cfg: { ...cfg, linearWebhookSecret: undefined },
    }).request("/repositories/register", {
      method: "POST",
      headers: { Authorization: "Bearer status-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo", controlProvider: "linear", linearTeamKey: "OT" }),
    });
    expect(unavailable.status).toBe(503);
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
    const signature = createHmac("sha256", cfg.linearWebhookSecret!).update(payload).digest("hex");
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
    const staleSignature = createHmac("sha256", cfg.linearWebhookSecret!)
      .update(stalePayload).digest("hex");
    const stale = await server.request("/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": staleSignature },
      body: stalePayload,
    });
    expect(stale.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(1);
  });

  it("fails Linear webhooks precisely when the Linear adapter is unavailable", async () => {
    const server = app({
      cfg: {
        ...cfg,
        linearWebhookSecret: undefined,
        linearClientId: undefined,
        linearClientSecret: undefined,
      },
    });

    const response = await server.request("/webhooks/linear", {
      method: "POST",
      headers: { "Linear-Signature": "0".repeat(64) },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("LINEAR_WEBHOOK_SECRET");
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

  it("drops unauthorized GitHub Issue comments before durable delivery", async () => {
    const process = vi.fn(async () => undefined);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground: (task) => void task,
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ permission: "read", role_name: "pull" })
    ));
    const payload = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: {
        id: 101,
        body: "unauthorized steering body",
        created_at: "2026-08-11T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/12#issuecomment-101",
        user: { login: "reader" },
      },
    });
    const signature = createHmac("sha256", cfg.githubWebhookSecret).update(payload).digest("hex");

    try {
      const response = await server.request("/webhooks/github", {
        method: "POST",
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-Hub-Signature-256": `sha256=${signature}`,
          "X-GitHub-Delivery": "github-unauthorized-comment",
        },
        body: payload,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
      expect(process).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns retryable 503 and retains no body when GitHub permission lookup is transiently unavailable", async () => {
    const process = vi.fn(async () => undefined);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground: (task) => void task,
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("GitHub permission API unavailable");
    }));
    const payload = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: {
        id: 102,
        body: "retry this authorized command later",
        created_at: "2026-08-11T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/12#issuecomment-102",
        user: { login: "operator" },
      },
    });
    const signature = createHmac("sha256", cfg.githubWebhookSecret).update(payload).digest("hex");

    const response = await server.request("/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": `sha256=${signature}`,
        "X-GitHub-Delivery": "github-transient-permission",
      },
      body: payload,
    });

    expect(response.status).toBe(503);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
    expect(process).not.toHaveBeenCalled();
  });

  it("fences delayed GitHub deliveries against provider activation instead of local admission time", async () => {
    store.upsertUnpinned({
      ticket_id: "github:owner/repo#12",
      ticket_reference: "GH-12",
      session_id: "github:owner/repo#12:reopened:2026-08-11T00:00:00.000Z",
      control_provider: "github",
      external_thread_id: "owner/repo#12",
      external_thread_reference: "GH-12",
      provider_activated_at: "2026-08-11T00:00:00Z",
      sandbox_id: null,
      branch: "ot/gh-12",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    db.prepare("UPDATE agent_sessions SET created_at = ? WHERE id = ?").run(
      "2026-08-11T00:05:00.987Z",
      "github:owner/repo#12:reopened:2026-08-11T00:00:00.000Z"
    );
    const process = vi.fn(async () => undefined);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground: (task) => void task,
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ permission: "triage", role_name: "triage" })
    ));
    const requests = [
      {
        eventName: "issues",
        delivery: "github-stale-close",
        payload: {
          action: "closed",
          repository: { full_name: "owner/repo" },
          sender: { login: "operator" },
          issue: {
            number: 12,
            title: "Ship it",
            html_url: "https://github.com/owner/repo/issues/12",
            updated_at: "2026-08-10T00:00:00.000Z",
          },
        },
      },
      {
        eventName: "issue_comment",
        delivery: "github-stale-comment",
        payload: {
          action: "created",
          repository: { full_name: "owner/repo" },
          issue: { number: 12 },
          comment: {
            id: 104,
            body: "old generation feedback",
            created_at: "2026-08-10T00:00:00.000Z",
            html_url: "https://github.com/owner/repo/issues/12#issuecomment-104",
            user: { login: "operator" },
          },
        },
      },
    ];

    for (const request of requests) {
      const raw = JSON.stringify(request.payload);
      const signature = createHmac("sha256", cfg.githubWebhookSecret).update(raw).digest("hex");
      const response = await server.request("/webhooks/github", {
        method: "POST",
        headers: {
          "X-GitHub-Event": request.eventName,
          "X-Hub-Signature-256": `sha256=${signature}`,
          "X-GitHub-Delivery": request.delivery,
        },
        body: raw,
      });
      expect(response.status).toBe(200);
    }

    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
    expect(process).not.toHaveBeenCalled();
    expect(store.getByIssueId("github:owner/repo#12")?.state).toBe("active");

    const delayedPayload = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: {
        id: 105,
        body: "feedback sent after activation while admission was delayed",
        created_at: "2026-08-11T00:00:01Z",
        html_url: "https://github.com/owner/repo/issues/12#issuecomment-105",
        user: { login: "operator" },
      },
    });
    const delayedSignature = createHmac("sha256", cfg.githubWebhookSecret)
      .update(delayedPayload)
      .digest("hex");
    const delayed = await server.request("/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": `sha256=${delayedSignature}`,
        "X-GitHub-Delivery": "github-delayed-valid-comment",
      },
      body: delayedPayload,
    });

    expect(delayed.status).toBe(200);
    expect(db.prepare(
      "SELECT status FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-delayed-valid-comment")).toEqual({ status: "pending" });
    expect(process).toHaveBeenCalledWith("github-delayed-valid-comment");
  });

  it("keeps same-second GitHub comments when activation and provider timestamps have second precision", async () => {
    store.upsertUnpinned({
      ticket_id: "github:owner/repo#12",
      ticket_reference: "GH-12",
      session_id: "github:owner/repo#12:initial",
      control_provider: "github",
      external_thread_id: "owner/repo#12",
      external_thread_reference: "GH-12",
      provider_activated_at: "2026-08-11T00:00:00Z",
      sandbox_id: null,
      branch: "ot/gh-12",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    db.prepare("UPDATE agent_sessions SET created_at = ? WHERE id = ?").run(
      "2026-08-11T00:00:00.987Z",
      "github:owner/repo#12:initial"
    );
    const process = vi.fn(async () => undefined);
    const server = app({
      deliveryProcessor: { process, drain: vi.fn(async () => undefined) },
      runBackground: (task) => void task,
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ permission: "triage", role_name: "triage" })
    ));
    const payload = JSON.stringify({
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 12 },
      comment: {
        id: 106,
        body: "same-second feedback",
        created_at: "2026-08-11T00:00:00Z",
        html_url: "https://github.com/owner/repo/issues/12#issuecomment-106",
        user: { login: "operator" },
      },
    });
    const signature = createHmac("sha256", cfg.githubWebhookSecret).update(payload).digest("hex");

    const response = await server.request("/webhooks/github", {
      method: "POST",
      headers: {
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": `sha256=${signature}`,
        "X-GitHub-Delivery": "github-same-second-comment",
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(db.prepare(
      "SELECT status FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-same-second-comment")).toEqual({ status: "pending" });
    expect(process).toHaveBeenCalledWith("github-same-second-comment");
  });

  it("retries a durable GitHub control delivery when its permission recheck fails transiently", async () => {
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
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    store.claimDelivery({
      deliveryId: "github-durable-transient-permission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 103,
          body: "authorized command",
          created_at: "2026-08-11T00:00:00Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-103",
          user: { login: "operator" },
        },
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("temporary permission failure");
    }));

    await expect(processor.process("github-durable-transient-permission"))
      .rejects.toThrow("temporary permission failure");
    expect(db.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-durable-transient-permission")).toEqual({ status: "failed", attempts: 1 });
  });

  it("retries an authorized same-thread comment until its Issue admission is durable", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const postedBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        postedBodies.push(body);
        return Response.json({
          id: 801,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-801",
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    store.claimDelivery({
      deliveryId: "github-issue-admission-in-flight",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        label: { name: "openthrottle" },
        issue: { number: 12 },
      }),
    });
    store.claimDelivery({
      deliveryId: "github-comment-during-admission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 107,
          body: "retain this comment across admission",
          created_at: "2026-08-11T00:00:01Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-107",
          user: { login: "operator" },
        },
      }),
    });

    await expect(processor.process("github-comment-during-admission"))
      .rejects.toThrow("Issue admission is still in flight");
    expect(postedBodies).toEqual([]);
    expect(db.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-comment-during-admission")).toEqual({ status: "failed", attempts: 1 });

    seedPipelineTicket();
    db.prepare(`
      UPDATE tickets
      SET control_provider = 'github', external_thread_id = 'owner/repo#12',
          external_thread_reference = 'GH-12'
      WHERE ticket_id = 'issue-1'
    `).run();
    db.prepare(`
      UPDATE agent_sessions SET provider_activated_at = ? WHERE id = 'session-1'
    `).run("2026-08-11T00:00:00Z");
    settleDelivery("github-issue-admission-in-flight");
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = 'github-comment-during-admission'
    `).run();

    await expect(processor.process("github-comment-during-admission")).resolves.toBeUndefined();
    expect(store.getInbox("github-comment:107")).toMatchObject({
      ticket_id: "issue-1",
      session_id: "session-1",
      run_id: null,
      body: "retain this comment across admission",
      status: "pending",
    });
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("Captured your message");
    expect(postedBodies[0]).not.toContain("couldn't find an existing workspace");
  });

  it("queues a comment for a durable current session despite a failed matching admission delivery", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const postedBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        postedBodies.push(body);
        return Response.json({
          id: 803,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-803",
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    seedPipelineTicket();
    db.prepare(`
      UPDATE tickets
      SET control_provider = 'github', external_thread_id = 'owner/repo#12',
          external_thread_reference = 'GH-12'
      WHERE ticket_id = 'issue-1'
    `).run();
    db.prepare(`
      UPDATE agent_sessions SET provider_activated_at = ? WHERE id = 'session-1'
    `).run("2026-08-11T00:00:00Z");
    store.claimDelivery({
      deliveryId: "github-failed-issue-admission",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        label: { name: "openthrottle" },
        issue: { number: 12 },
      }),
    });
    store.markDeliveryFailed(
      "github-failed-issue-admission",
      "effect failed after admission committed",
      "2099-01-01T00:00:00.000Z"
    );
    store.claimDelivery({
      deliveryId: "github-comment-after-durable-admission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 109,
          body: "queue this despite the stale failed admission",
          created_at: "2026-08-11T00:00:01Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-109",
          user: { login: "operator" },
        },
      }),
    });

    await expect(processor.process("github-comment-after-durable-admission"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:109")).toMatchObject({
      ticket_id: "issue-1",
      session_id: "session-1",
      run_id: null,
      body: "queue this despite the stale failed admission",
      status: "pending",
    });
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("Captured your message");
    expect(db.prepare(
      "SELECT status FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-comment-after-durable-admission")).toEqual({ status: "processed" });
  });

  it("uses the Issue Event cursor to advance an active session and defer only a newer terminal relabel", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const postedBodies: string[] = [];
    let liveUpdatedAt = "2026-08-11T00:01:00Z";
    let advanceEpochDuringNextSelection = false;
    let timelineResponseMode: "normal" | "oversized" | "full-pages" = "normal";
    let failOutsiderPermission = false;
    const permissionLookups: string[] = [];
    const repositoryConfigContent = "schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n";
    const timelineEvents: Array<Record<string, unknown>> = [{
      id: 900,
      event: "labeled",
      created_at: "2026-08-11T00:00:00Z",
      label: { name: "openthrottle" },
      actor: { login: "operator" },
    }];
    const issueTimeline: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/collaborators/operator/permission")) {
        permissionLookups.push("operator");
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/collaborators/outsider/permission")) {
        permissionLookups.push("outsider");
        if (failOutsiderPermission) throw new Error("historical permission failure");
        return Response.json({ permission: "read", role_name: "read" });
      }
      const attackerPermission = url.match(/\/collaborators\/(attacker-\d+)\/permission$/);
      if (attackerPermission) {
        permissionLookups.push(attackerPermission[1]!);
        return Response.json({ permission: "read", role_name: "read" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12") && method === "GET") {
        return Response.json({
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          created_at: "2026-08-11T00:00:00Z",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/events?per_page=100")) {
        return Response.json(timelineEvents);
      }
      if (url.includes("/repos/owner/repo/issues/12/timeline?per_page=100")) {
        if (timelineResponseMode === "oversized") {
          return Response.json([{
            id: 999,
            event: "commented",
            created_at: "2026-08-11T00:03:00Z",
            actor: { login: "operator" },
            body: "x".repeat(600_000),
          }]);
        }
        if (timelineResponseMode === "full-pages") {
          return Response.json(Array.from({ length: 100 }, (_, index) => ({
            id: 10_000 + index,
            event: "assigned",
            created_at: "2026-08-11T00:04:00Z",
            actor: { login: "operator" },
          })));
        }
        return Response.json(issueTimeline);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/commits/main")) {
        return Response.json({ sha: "a".repeat(40) });
      }
      if (url.endsWith(`/repos/owner/repo/contents/.openthrottle.yml?ref=${"a".repeat(40)}`)) {
        if (advanceEpochDuringNextSelection) {
          const event = {
            id: 906,
            event: "labeled",
            created_at: "2026-08-11T00:03:00Z",
            label: { name: "openthrottle" },
            actor: { login: "operator" },
          };
          timelineEvents.push(event);
          issueTimeline.push(event);
          liveUpdatedAt = "2026-08-11T00:03:00Z";
          advanceEpochDuringNextSelection = false;
        }
        return Response.json({
          type: "file",
          sha: "b".repeat(40),
          encoding: "base64",
          content: Buffer.from(repositoryConfigContent).toString("base64"),
          size: Buffer.byteLength(repositoryConfigContent),
        });
      }
      if ((url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") ||
          (url.includes("/repos/owner/repo/issues/comments/") && method === "PATCH")) {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        postedBodies.push(body);
        return Response.json({
          id: 804,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-804",
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    const activeSessionId = "github:owner/repo#12:initial";
    seedPipelineTicket(activeSessionId, "github:owner/repo#12", "GH-12");
    db.prepare(`
      UPDATE tickets
      SET control_provider = 'github', external_thread_id = 'owner/repo#12',
          external_thread_reference = 'GH-12'
      WHERE ticket_id = 'github:owner/repo#12'
    `).run();
    store.registerRepository({
      controlProvider: "github",
      githubRepo: "owner/repo",
      baseBranch: "main",
      webhookId: 7,
      snapshot: "snapshot",
    });
    db.prepare(`
      UPDATE agent_sessions
      SET provider_activated_at = ?, provider_activation_id = ?
      WHERE id = ?
    `).run("2026-08-11T00:00:00Z", "900", activeSessionId);
    timelineEvents.push({
      id: 901,
      event: "labeled",
      created_at: "2026-08-11T00:01:00Z",
      label: { name: "openthrottle" },
      actor: { login: "operator" },
    });
    store.claimDelivery({
      deliveryId: "github-active-session-relabel",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        label: { name: "openthrottle" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: "2026-08-11T00:01:00Z",
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-active-session-relabel")).resolves.toBeUndefined();
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: activeSessionId,
      provider_activated_at: "2026-08-11T00:01:00Z",
      provider_activation_id: "901",
    });

    store.claimDelivery({
      deliveryId: "github-close-before-provider-history",
      source: "github",
      action: "issues:closed",
      eventName: "issues",
      payload: JSON.stringify({
        action: "closed",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "closed",
          updated_at: "2026-08-11T00:01:15Z",
          closed_at: "2026-08-11T00:01:15Z",
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-close-before-provider-history"))
      .rejects.toThrow("close is not yet durable in provider event history");
    expect(store.getCurrentSession("github:owner/repo#12")?.id).toBe(activeSessionId);
    expect(pipelines.getInstanceForSession(activeSessionId)).toMatchObject({
      status: "dispatchable",
    });

    const excessiveHistoryStart = timelineEvents.length;
    timelineEvents.push(
      ...Array.from({ length: 33 }, (_, index) => ({
        id: `excessive-close-${index}`,
        event: "closed",
        created_at: "2026-08-11T00:01:20Z",
        actor: { login: `attacker-${index}` },
      })),
      {
        id: "excessive-history-reopen",
        event: "reopened",
        created_at: "2026-08-11T00:01:20Z",
        actor: { login: "operator" },
      }
    );
    liveUpdatedAt = "2026-08-11T00:01:20Z";
    const permissionLookupCountBeforeExcessiveHistory = permissionLookups.length;
    store.claimDelivery({
      deliveryId: "github-excessive-historical-close-actors",
      source: "github",
      action: "issues:reopened",
      eventName: "issues",
      payload: JSON.stringify({
        action: "reopened",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-excessive-historical-close-actors"))
      .rejects.toThrow("exceeded the bounded actor lookup limit");
    expect(permissionLookups.slice(permissionLookupCountBeforeExcessiveHistory))
      .toHaveLength(33);
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: activeSessionId,
      provider_activation_id: "901",
    });
    settleDelivery("github-excessive-historical-close-actors");
    timelineEvents.splice(excessiveHistoryStart);
    liveUpdatedAt = "2026-08-11T00:01:00Z";

    timelineEvents.push({
      id: 902,
      event: "labeled",
      created_at: "2026-08-11T00:01:00Z",
      label: { name: "openthrottle" },
      actor: { login: "outsider" },
    });
    store.claimDelivery({
      deliveryId: "github-old-authorized-before-unauthorized-epoch",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        label: { name: "openthrottle" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: "2026-08-11T00:01:00Z",
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-old-authorized-before-unauthorized-epoch"))
      .resolves.toBeUndefined();
    expect(store.getCurrentSession("github:owner/repo#12")?.provider_activation_id).toBe("901");

    timelineEvents.push(
      {
        id: 9021,
        event: "closed",
        created_at: "2026-08-11T00:01:30Z",
        actor: { login: "outsider" },
      },
      {
        id: 9022,
        event: "reopened",
        created_at: "2026-08-11T00:01:30Z",
        actor: { login: "operator" },
      }
    );
    liveUpdatedAt = "2026-08-11T00:01:30Z";
    store.claimDelivery({
      deliveryId: "github-authorized-reopen-after-unauthorized-close",
      source: "github",
      action: "issues:reopened",
      eventName: "issues",
      payload: JSON.stringify({
        action: "reopened",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    failOutsiderPermission = true;
    await expect(processor.process("github-authorized-reopen-after-unauthorized-close"))
      .rejects.toThrow("historical permission failure");
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: activeSessionId,
      provider_activation_id: "901",
    });
    expect(pipelines.getInstanceForSession(activeSessionId)).toMatchObject({
      status: "dispatchable",
    });
    failOutsiderPermission = false;
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = 'github-authorized-reopen-after-unauthorized-close'
    `).run();
    await expect(processor.process("github-authorized-reopen-after-unauthorized-close"))
      .resolves.toBeUndefined();
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: activeSessionId,
      state: "current",
      generation: 1,
      provider_activation_id: "9022",
    });
    expect(pipelines.getInstanceForSession(activeSessionId)).toMatchObject({
      status: "dispatchable",
    });
    expect(store.getSession("github:owner/repo#12:reopened:9022")).toBeUndefined();

    timelineEvents.push(
      {
        id: 903,
        event: "closed",
        created_at: "2026-08-11T00:02:00Z",
        actor: { login: "operator" },
      },
      {
        id: 904,
        event: "reopened",
        created_at: "2026-08-11T00:02:00Z",
        actor: { login: "operator" },
      },
      {
        id: 9041,
        event: "closed",
        created_at: "2026-08-11T00:02:30Z",
        actor: { login: "outsider" },
      },
      {
        id: 9042,
        event: "reopened",
        created_at: "2026-08-11T00:02:30Z",
        actor: { login: "operator" },
      }
    );
    liveUpdatedAt = "2026-08-11T00:02:30Z";
    const permissionLookupCountBeforeCoalescedHistory = permissionLookups.length;
    store.claimDelivery({
      deliveryId: "github-coalesced-authorized-and-unauthorized-close-history",
      source: "github",
      action: "issues:reopened",
      eventName: "issues",
      payload: JSON.stringify({
        action: "reopened",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-coalesced-authorized-and-unauthorized-close-history"))
      .resolves.toBeUndefined();
    const reopenedSessionId = "github:owner/repo#12:reopened:9042";
    expect(store.getSession(activeSessionId)?.state).toBe("stopped");
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: reopenedSessionId,
      generation: 2,
      provider_activation_id: "9042",
    });
    expect(pipelines.getInstanceForSession(reopenedSessionId)).toMatchObject({
      status: "dispatchable",
    });
    // The sender authorization is reused while scanning historical closes;
    // the final admission preflight deliberately rechecks the activation actor.
    expect(permissionLookups.slice(permissionLookupCountBeforeCoalescedHistory))
      .toEqual(["operator", "outsider", "operator"]);

    store.claimDelivery({
      deliveryId: "github-delayed-close-after-reopen",
      source: "github",
      action: "issues:closed",
      eventName: "issues",
      payload: JSON.stringify({
        action: "closed",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "closed",
          updated_at: "2026-08-11T00:02:00Z",
          closed_at: "2026-08-11T00:02:00Z",
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-delayed-close-after-reopen"))
      .resolves.toBeUndefined();
    expect(store.getCurrentSession("github:owner/repo#12")?.id).toBe(reopenedSessionId);
    expect(store.getByIssueId("github:owner/repo#12")?.state).toBe("active");

    const successor = pipelines.getInstanceForSession(reopenedSessionId)!;
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'shipped', terminal_outcome = 'shipped'
      WHERE id = ?
    `).run(successor.id);

    store.claimDelivery({
      deliveryId: "github-ordinary-post-terminal-comment",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 110,
          body: "ordinary post-terminal comment",
          created_at: "2026-08-11T00:02:31Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-110",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-ordinary-post-terminal-comment"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:110")).toBeUndefined();
    expect(postedBodies.at(-1)).toContain("does not accept live steering");

    timelineEvents.push({
      id: 905,
      event: "labeled",
      created_at: "2026-08-11T00:03:00Z",
      label: { name: "openthrottle" },
      actor: { login: "operator" },
    });
    issueTimeline.push(
      {
        id: 112,
        event: "commented",
        created_at: "2026-08-11T00:03:00Z",
        actor: { login: "operator" },
        body: "untrusted comment body must be discarded",
      },
      {
        id: 905,
        event: "labeled",
        created_at: "2026-08-11T00:03:00Z",
        label: { name: "openthrottle" },
        actor: { login: "operator" },
      }
    );
    store.claimDelivery({
      deliveryId: "github-ambiguous-same-second-terminal-comment",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 112,
          body: "this comment may predate the same-second relabel",
          created_at: "2026-08-11T00:03:00Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-112",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-ambiguous-same-second-terminal-comment"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:112")).toBeUndefined();
    expect(postedBodies.at(-1)).toContain("does not accept live steering");
    const postsBeforeSuccessorRetry = postedBodies.length;

    store.claimDelivery({
      deliveryId: "github-comment-before-successor-admission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 111,
          body: "carry this into the successor generation",
          created_at: "2026-08-11T00:03:01Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-111",
          user: { login: "operator" },
        },
      }),
    });

    await expect(processor.process("github-comment-before-successor-admission"))
      .rejects.toThrow("Issue activation is not durable yet");
    expect(store.getInbox("github-comment:111")).toBeUndefined();
    expect(postedBodies).toHaveLength(postsBeforeSuccessorRetry);

    liveUpdatedAt = "2026-08-11T00:03:00Z";
    issueTimeline.push({
      id: 113,
      event: "commented",
      created_at: "2026-08-11T00:03:00Z",
      actor: { login: "operator" },
      body: "another untrusted body that must not affect ordering",
    });
    store.claimDelivery({
      deliveryId: "github-newer-label-admission",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        label: { name: "openthrottle" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    advanceEpochDuringNextSelection = true;
    await expect(processor.process("github-newer-label-admission")).resolves.toBeUndefined();
    expect(store.getCurrentSession("github:owner/repo#12")?.id).toBe(reopenedSessionId);
    expect(store.getSession("github:owner/repo#12:label:905")).toBeUndefined();

    store.claimDelivery({
      deliveryId: "github-current-label-admission",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        label: { name: "openthrottle" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-current-label-admission")).resolves.toBeUndefined();
    const relabeledSessionId = "github:owner/repo#12:label:906";
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: relabeledSessionId,
      generation: 3,
      provider_activation_id: "906",
    });
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = 'github-comment-before-successor-admission'
    `).run();

    await expect(processor.process("github-comment-before-successor-admission"))
      .resolves.toBeUndefined();
    expect(store.getByExternalThread("github", "owner/repo#12")?.session_id)
      .toBe(relabeledSessionId);
    expect(store.getInbox("github-comment:111")).toMatchObject({
      ticket_id: "github:owner/repo#12",
      session_id: relabeledSessionId,
      run_id: null,
      body: "carry this into the successor generation",
      status: "pending",
    });
    expect(postedBodies.at(-1)).toContain("Captured your message");

    const postsBeforeAmbiguousLateDelivery = postedBodies.length;
    store.claimDelivery({
      deliveryId: "github-ambiguous-comment-delivered-after-admission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 113,
          body: "do not route this ambiguous delayed comment",
          created_at: "2026-08-11T00:03:00Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-113",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-ambiguous-comment-delivered-after-admission"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:113")).toBeUndefined();
    expect(postedBodies).toHaveLength(postsBeforeAmbiguousLateDelivery);

    issueTimeline.push({
      id: 114,
      event: "commented",
      created_at: "2026-08-11T00:03:00Z",
      actor: { login: "operator" },
      body: "provider body is irrelevant to exact ordering",
    });
    store.claimDelivery({
      deliveryId: "github-same-second-comment-after-admission",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 114,
          body: "route this provider-ordered same-second comment",
          created_at: "2026-08-11T00:03:00Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-114",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-same-second-comment-after-admission"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:114")).toMatchObject({
      ticket_id: "github:owner/repo#12",
      session_id: relabeledSessionId,
      body: "route this provider-ordered same-second comment",
      status: "pending",
    });

    timelineResponseMode = "oversized";
    store.claimDelivery({
      deliveryId: "github-unresolved-same-second-comment",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 115,
          body: "ask me to resend if provider ordering cannot be bounded",
          created_at: "2026-08-11T00:03:00Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-115",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-unresolved-same-second-comment"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:115")).toBeUndefined();
    expect(postedBodies.at(-1)).toContain("Please resend the comment");

    const relabeled = pipelines.getInstanceForSession(relabeledSessionId)!;
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'shipped', terminal_outcome = 'shipped'
      WHERE id = ?
    `).run(relabeled.id);
    liveUpdatedAt = "2026-08-11T00:04:00Z";
    const finalActivation = {
      id: 907,
      event: "labeled",
      created_at: liveUpdatedAt,
      label: { name: "openthrottle" },
      actor: { login: "operator" },
    };
    timelineEvents.push(finalActivation);
    for (const [mode, commentId] of [
      ["oversized", 116],
      ["full-pages", 118],
    ] as const) {
      timelineResponseMode = mode;
      store.claimDelivery({
        deliveryId: `github-terminal-unresolved-${mode}-comment`,
        source: "github",
        action: "issue_comment:created",
        eventName: "issue_comment",
        payload: JSON.stringify({
          action: "created",
          repository: { full_name: "owner/repo" },
          issue: { number: 12 },
          comment: {
            id: commentId,
            body: "give me explicit resend guidance when ordering cannot be bounded",
            created_at: liveUpdatedAt,
            html_url: `https://github.com/owner/repo/issues/12#issuecomment-${commentId}`,
            user: { login: "operator" },
          },
        }),
      });
      await expect(processor.process(`github-terminal-unresolved-${mode}-comment`))
        .resolves.toBeUndefined();
      expect(store.getInbox(`github-comment:${commentId}`)).toBeUndefined();
      expect(postedBodies.at(-1)).toContain("Please resend the comment");
    }

    timelineResponseMode = "normal";
    issueTimeline.push(finalActivation, {
      id: 117,
      event: "commented",
      created_at: liveUpdatedAt,
      actor: { login: "operator" },
      body: "timeline body must not enter the terminal successor proof",
    });
    store.claimDelivery({
      deliveryId: "github-provider-ordered-terminal-comment",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 117,
          body: "carry this exact-order comment into the next generation",
          created_at: liveUpdatedAt,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-117",
          user: { login: "operator" },
        },
      }),
    });
    await expect(processor.process("github-provider-ordered-terminal-comment"))
      .rejects.toThrow("Issue activation is not durable yet");

    store.claimDelivery({
      deliveryId: "github-final-label-admission",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        label: { name: "openthrottle" },
        issue: {
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          updated_at: liveUpdatedAt,
          labels: [{ name: "openthrottle" }],
        },
      }),
    });
    await expect(processor.process("github-final-label-admission")).resolves.toBeUndefined();
    const finalSessionId = "github:owner/repo#12:label:907";
    expect(store.getCurrentSession("github:owner/repo#12")).toMatchObject({
      id: finalSessionId,
      generation: 4,
      provider_activation_id: "907",
    });
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = 'github-provider-ordered-terminal-comment'
    `).run();
    await expect(processor.process("github-provider-ordered-terminal-comment"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:117")).toMatchObject({
      ticket_id: "github:owner/repo#12",
      session_id: finalSessionId,
      body: "carry this exact-order comment into the next generation",
      status: "pending",
    });
  });

  it("retries a ticketless comment when the live Issue is labeled before its admission delivery is stored", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const postedBodies: string[] = [];
    let liveIssueReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12") && method === "GET") {
        liveIssueReads += 1;
        return Response.json({
          number: 12,
          title: "Ship it",
          html_url: "https://github.com/owner/repo/issues/12",
          state: "open",
          created_at: "2026-08-11T00:00:00Z",
          updated_at: "2026-08-11T00:00:00Z",
          labels: [{ name: "openthrottle" }],
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100") && method === "GET") {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        postedBodies.push(body);
        return Response.json({
          id: 802,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-802",
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    store.claimDelivery({
      deliveryId: "github-comment-before-admission-delivery",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 108,
          body: "retain this reversed delivery too",
          created_at: "2026-08-11T00:00:01Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-108",
          user: { login: "operator" },
        },
      }),
    });

    await expect(processor.process("github-comment-before-admission-delivery"))
      .rejects.toThrow("Issue activation is not durable yet");
    expect(liveIssueReads).toBe(1);
    expect(postedBodies).toEqual([]);
    expect(db.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = ?"
    ).get("github-comment-before-admission-delivery")).toEqual({ status: "failed", attempts: 1 });

    store.claimDelivery({
      deliveryId: "github-late-issue-admission",
      source: "github",
      action: "issues:labeled",
      eventName: "issues",
      payload: JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        label: { name: "openthrottle" },
        issue: { number: 12 },
      }),
    });
    seedPipelineTicket();
    db.prepare(`
      UPDATE tickets
      SET control_provider = 'github', external_thread_id = 'owner/repo#12',
          external_thread_reference = 'GH-12'
      WHERE ticket_id = 'issue-1'
    `).run();
    db.prepare(`
      UPDATE agent_sessions SET provider_activated_at = ? WHERE id = 'session-1'
    `).run("2026-08-11T00:00:00Z");
    settleDelivery("github-late-issue-admission");
    db.prepare(`
      UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE delivery_id = 'github-comment-before-admission-delivery'
    `).run();

    await expect(processor.process("github-comment-before-admission-delivery"))
      .resolves.toBeUndefined();
    expect(store.getInbox("github-comment:108")).toMatchObject({
      ticket_id: "issue-1",
      session_id: "session-1",
      run_id: null,
      body: "retain this reversed delivery too",
      status: "pending",
    });
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("Captured your message");
    expect(postedBodies[0]).not.toContain("couldn't find an existing workspace");
  });

  it("publishes GitHub admission errors on the Issue without entering the Linear outbox", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const postedBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/collaborators/operator/permission")) {
        return Response.json({ permission: "triage", role_name: "triage" });
      }
      if (url.endsWith("/repos/owner/repo/issues/12")) {
        return Response.json({
          number: 12,
          title: "Ship it",
          body: "Run the plan.",
          state: "open",
          created_at: "2026-08-11T00:00:00.000Z",
          updated_at: "2026-08-11T00:00:00.000Z",
          html_url: "https://github.com/owner/repo/issues/12",
          labels: [{ name: "openthrottle" }],
        });
      }
      if (url.endsWith("/repos/owner/repo/issues/12/events?per_page=100")) {
        return Response.json([{
          id: 700,
          event: "labeled",
          created_at: "2026-08-11T00:00:00.000Z",
          label: { name: "openthrottle" },
          actor: { login: "operator" },
        }]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") {
        postedBodies.push((JSON.parse(String(init?.body)) as { body: string }).body);
        return Response.json({
          id: 700 + postedBodies.length,
          html_url: `https://github.com/owner/repo/issues/12#issuecomment-${700 + postedBodies.length}`,
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    store.claimDelivery({
      deliveryId: "github-admission-error",
      source: "github",
      action: "issues:opened",
      eventName: "issues",
      payload: JSON.stringify({
        action: "opened",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 12,
          title: "Ship it",
          body: "Run the plan.",
          state: "open",
          created_at: "2026-08-11T00:00:00.000Z",
          updated_at: "2026-08-11T00:00:00.000Z",
          html_url: "https://github.com/owner/repo/issues/12",
          labels: [{ name: "openthrottle" }],
          user: { login: "operator" },
        },
      }),
    });

    await expect(processor.process("github-admission-error")).resolves.toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) FROM control_outbox").pluck().get()).toBe(0);
    expect(postedBodies.some((body) => body.includes("No repository is registered"))).toBe(true);
    expect(postedBodies.every((body) => body.startsWith("<!-- openthrottle:control-session:"))).toBe(true);
  });

  it("surfaces a dead GitHub delivery on the ticket's Issue thread and in the durable journal", async () => {
    const runtime = buildInstalledRuntimeDescriptor("server-test/v1");
    const catalog = loadPipelineCatalog(
      fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url)),
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    seedPipelineTicket();
    db.prepare(`
      UPDATE tickets
      SET control_provider = 'github', external_thread_id = 'owner/repo#12',
          external_thread_reference = 'GH-12'
      WHERE ticket_id = 'issue-1'
    `).run();
    const postedBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/repos/owner/repo/issues/12/comments?per_page=100")) {
        return Response.json([]);
      }
      if (url.endsWith("/repos/owner/repo/issues/12/comments") && method === "POST") {
        postedBodies.push((JSON.parse(String(init?.body)) as { body: string }).body);
        return Response.json({
          id: 900,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-900",
        });
      }
      throw new Error(`unexpected GitHub request ${method} ${url}`);
    }));
    const processor = createServerWebhookDeliveryProcessor({
      cfg,
      store,
      runtime: {
        listLabeledResources: async () => [],
        deleteResource: async () => undefined,
      },
      getLinearClient: async () => undefined,
      pipelineCoordinator: { catalog, runtime, store: pipelines },
    });
    // A pending supervisor comment write intent makes handling throw
    // deterministically ("publication is still in flight") without provider
    // reads; the delivery is on its final attempt, so this failure is dead.
    const marker = "<!-- openthrottle:in-flight-test -->";
    beginGithubSupervisorCommentWrite(store, "owner/repo", 12, marker);
    store.claimDelivery({
      deliveryId: "github-dead-delivery",
      source: "github",
      action: "issue_comment:created",
      eventName: "issue_comment",
      payload: JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 12 },
        comment: {
          id: 110,
          body: `${marker}\nnot actually supervisor output`,
          created_at: "2026-08-11T00:00:01Z",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-110",
          user: { login: "operator" },
        },
      }),
    });
    db.prepare(`
      UPDATE webhook_deliveries SET attempts = 7 WHERE delivery_id = 'github-dead-delivery'
    `).run();
    const outboxRowsBeforeDeath = db.prepare("SELECT COUNT(*) FROM control_outbox").pluck().get();

    await expect(processor.process("github-dead-delivery"))
      .rejects.toThrow("publication is still in flight");

    expect(db.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE delivery_id = 'github-dead-delivery'"
    ).get()).toEqual({ status: "dead", attempts: 8 });
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toContain("could not process this event after 8 attempts");
    expect(postedBodies[0]).toContain("publication is still in flight");
    // The GitHub route never enters the Linear outbox.
    expect(db.prepare("SELECT COUNT(*) FROM control_outbox").pluck().get())
      .toBe(outboxRowsBeforeDeath);
    const journal = pipelines.listJournalEntries({ issueId: "issue-1", limit: 50 });
    expect(journal).toContainEqual(expect.objectContaining({
      kind: "run_note",
      actor: "supervisor",
      outcome: "dead",
      trigger: "GitHub webhook delivery processing",
      action: "Abandoned GitHub delivery github-dead-delivery (issue_comment:created) after 8 attempts.",
    }));
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

    const response = await app().request("/tickets/issue-1/logs", {
      headers: { Authorization: "Bearer status-token" },
    });
    expect(response.status).toBe(200);
    const logs = await response.text();
    expect(logs).toContain("finished with [REDACTED]");
    expect(logs).not.toContain("github_pat_");
  });
});
