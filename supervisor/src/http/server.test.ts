import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import type { PipelineStore } from "../pipeline/store.js";
import { loadPipelineCatalog, parseRepositoryConfig } from "../pipeline/manifest.js";
import { buildInstalledRuntimeDescriptor, type RuntimeInventory, type RuntimeLogs, type RuntimeSnapshotReadiness } from "../runtime/contracts.js";
import { createServer, createServerWebhookDeliveryProcessor } from "./server.js";

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
  webhookMaxAgeSeconds: 300,
  sandboxEventPollIntervalMs: 5000,
  allowLinearMerge: false,
  pipelineCatalogPath: "pipelines",
  sandboxRuntimeRelease: "release",
  sandboxRuntimeDescriptorPath: "runtime.json",
};

type ServerRuntime = RuntimeInventory & RuntimeLogs & RuntimeSnapshotReadiness;

describe("coordinator-only server", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;
  let pipelines: PipelineStore;

  beforeEach(() => {
    db = openDb(":memory:");
    pipelines = createPipelineStore(db);
    store = createSupervisorStore(db, pipelines);
  });

  afterEach(() => db.close());

  function app(overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
    return createServer({
      cfg,
      store,
      runtime: {} as ServerRuntime,
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
      config: parseRepositoryConfig("pipelines: { implement: fixture-command }\n"),
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

  it("has no task completion callback route", async () => {
    const response = await app().request("/runs/run-1/complete", { method: "POST" });
    expect(response.status).toBe(404);
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

  it("includes repeated sandbox ingestion failures in pipeline status", async () => {
    seedPipelineTicket();
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-ingestion",
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    store.insertSandboxEvent({
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      runId: "run-ingestion",
      sandboxId: "sandbox-1",
      kind: "stage_result",
      payload: JSON.stringify({ kind: "stage_result" }),
    });
    db.prepare(`
      UPDATE sandbox_events
      SET status = 'failed', attempts = 5, last_error = 'stage result attempt fence mismatch'
      WHERE event_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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
      ["/repositories", "GET"],
      ["/repositories/register", "POST"],
      ["/tickets/OT-1/stop", "POST"],
      ["/tickets/OT-1/steer", "POST"],
      ["/tickets/OT-1/logs", "GET"],
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
