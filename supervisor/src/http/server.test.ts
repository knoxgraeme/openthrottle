import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelControlService } from "../app/kernel-control.js";
import {
  KernelHttpService,
  type KernelRepositorySetupPort,
} from "../app/kernel-http.js";
import {
  KernelLinearSessionStartDispatcher,
  type KernelLinearSessionStartWakePort,
} from "../app/kernel-linear-session.js";
import {
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "../persistence/__fixtures__/kernel-epoch.js";
import { createKernelHistoricalAnalysisStore } from "../persistence/kernel-analysis-store.js";
import { SqliteKernelInboxStore } from "../persistence/kernel-inbox-store.js";
import { SqliteKernelProjectionStore } from "../persistence/kernel-projection-store.js";
import { SqliteKernelRegistrationStore } from "../persistence/kernel-registration-store.js";
import {
  KernelOperatorEffectRejectionConflictError,
} from "../pipeline/kernel/operator-effect-rejection.js";
import type {
  KernelOperatorEffectRejectionRequest,
  KernelOperatorEffectRejectionResult,
} from "../pipeline/kernel/ports.js";
import type { KernelWorkerHealthPort } from "../shared/kernel-worker-health.js";
import { createServer } from "./server.js";

const fixtures: FreshKernelFixture[] = [];
const STATUS_HEADERS = { Authorization: "Bearer status-token" };
const DEPLOY_HEADERS = { Authorization: "Bearer deploy-token" };

afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup(input: {
  linear_session_start?: KernelLinearSessionStartWakePort;
  worker_health?: KernelWorkerHealthPort;
} = {}) {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  seedKernelRun({ db: fixture.db, run_id: "run-active" });
  seedKernelAttempt({ db: fixture.db, run_id: "run-active", id: "attempt-active", status: "running" });
  seedKernelRun({ db: fixture.db, run_id: "run-settled", status: "completed" });
  const inbox = new SqliteKernelInboxStore({
    db: fixture.db,
    blob_store: fixture.blobs,
    now: () => "2026-08-20T13:00:00.000Z",
  });
  const registrations = new SqliteKernelRegistrationStore({ db: fixture.db });
  const projections = new SqliteKernelProjectionStore({ db: fixture.db });
  const control = new KernelControlService({
    inbox,
    maintenance: inbox,
    runtime_sessions: {
      bindRuntimeSession: async () => {
        throw new Error("not used");
      },
      loadCurrentRuntimeSession: async () => null,
    },
    active_work: projections,
    runtime_inventory: { listActiveRuntimeResources: async () => [] },
    now: () => "2026-08-20T13:00:00.000Z",
  });
  const effectRejections = {
    rejectDispatchFencedUnknownEffect: vi.fn(async (
      request: KernelOperatorEffectRejectionRequest,
    ): Promise<KernelOperatorEffectRejectionResult> => {
      const maintenance = control.maintenanceState();
      if (
        !maintenance.closed ||
        maintenance.version !== request.expected_maintenance_version
      ) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection requires the exact closed maintenance fence",
        );
      }
      return {
        disposition: "rejected",
        pipeline_run_id: request.pipeline_run_id,
        effect_id: request.effect_id,
        delivery_record_id: "delivery-operator-rejection",
        effect_version: 4,
        run_version: 8,
      };
    }),
  };
  const service = new KernelHttpService({
    registrations,
    projections,
    analysis: createKernelHistoricalAnalysisStore(fixture.db),
    control,
    effect_rejections: effectRejections,
  });
  const repositorySetup: KernelRepositorySetupPort = {
    prepare: vi.fn(async () => ({
      registration: {
        id: "repo-new",
        control_provider: "github" as const,
        linear_team_id: null,
        linear_team_key: null,
        github_repo: "new/repo",
        github_installation_id: 55,
        base_branch: "main",
        webhook_id: 77,
        runtime_snapshot: "snapshot",
      },
      readiness: {
        github: "ready" as const,
        webhook: "created" as const,
        snapshot: { name: "snapshot", state: "active" },
      },
    })),
  };
  return {
    fixture,
    effectRejections,
    repositorySetup,
    app: createServer({
      cfg: {
        statusToken: "status-token",
        deployToken: "deploy-token",
        linearWebhookSecret: "linear-secret",
        githubWebhookSecret: "github-secret",
        webhookMaxAgeSeconds: 60,
      },
      capabilities: {
        release: "release-1",
        capability_digest: "c".repeat(64),
        capabilities: ["kernel/v1"],
        execution_policy: Object.freeze({
          max_concurrent_attempts: 2,
          runtime_capability_digest: "c".repeat(64),
        }),
        task_timeout_seconds: 3_600,
      },
      service,
      repository_setup: repositorySetup,
      worker_health: input.worker_health ?? {
        snapshot: () => ({
          ok: true,
          worker: {
            status: "healthy",
            lastSuccessfulCycleAt: "2026-08-20T13:00:00.000Z",
            consecutiveFailures: 0,
            staleAfterSeconds: 120,
          },
        }),
      },
      ...(input.linear_session_start
        ? { linear_session_start: input.linear_session_start }
        : {}),
    }),
  };
}

function githubSignature(raw: string): string {
  return `sha256=${createHmac("sha256", "github-secret").update(raw).digest("hex")}`;
}

function linearSignature(raw: string): string {
  return createHmac("sha256", "linear-secret").update(raw).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("kernel-native HTTP surface", () => {
  it("serves health plus authenticated status, logs, analysis, and run control", async () => {
    const { app } = setup();
    expect(await (await app.request("/healthz")).json()).toMatchObject({
      ok: true,
      worker: { status: "healthy", consecutiveFailures: 0 },
    });
    expect(await (await app.request("/capabilities", { headers: STATUS_HEADERS })).json())
      .toMatchObject({ limits: { maxConcurrentAttempts: 2 } });
    expect((await app.request("/runs/run-active/status")).status).toBe(401);

    const status = await app.request("/runs/OPE-run-active/status", { headers: STATUS_HEADERS });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      run: { pipeline_run_id: "run-active", status: "running" },
    });
    const logs = await app.request("/runs/run-active/logs?limit=10", { headers: STATUS_HEADERS });
    expect(await logs.json()).toMatchObject({
      pipeline_run_id: "run-active",
      entries: expect.arrayContaining([expect.objectContaining({ kind: "attempt" })]),
    });
    const analysis = await app.request("/analysis/runs?terminal_outcome=completed", {
      headers: STATUS_HEADERS,
    });
    expect(await analysis.json()).toEqual({
      runs: [expect.objectContaining({ pipeline_run_id: "run-settled" })],
    });
    const records = await app.request("/runs/OPE-run-settled/analysis", { headers: STATUS_HEADERS });
    expect(await records.json()).toEqual({ pipeline_run_id: "run-settled", records: [] });

    const control = await app.request("/runs/OPE-run-active/control", {
      method: "POST",
      headers: { ...STATUS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop", reason: "operator request" }),
    });
    expect(control.status).toBe(202);
    expect(await control.json()).toMatchObject({
      accepted: true,
      action: "stop",
      pipeline_run_id: "run-active",
    });
  });

  it("returns a failing health check with an explicit disk-full condition", async () => {
    const { app } = setup({
      worker_health: {
        snapshot: () => ({
          ok: false,
          condition: "disk_full",
          message: "disk full",
          worker: {
            status: "unhealthy",
            lastSuccessfulCycleAt: "2026-08-20T12:58:00.000Z",
            consecutiveFailures: 120,
            staleAfterSeconds: 120,
          },
        }),
      },
    });

    const response = await app.request("/healthz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      condition: "disk_full",
      message: "disk full",
      worker: { status: "unhealthy", consecutiveFailures: 120 },
    });
  });

  it("registers repositories through a preparation port without legacy stores", async () => {
    const { app, repositorySetup } = setup();
    const response = await app.request("/repositories/register", {
      method: "POST",
      headers: { ...STATUS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "new/repo", controlProvider: "github" }),
    });
    expect(response.status).toBe(201);
    expect(repositorySetup.prepare).toHaveBeenCalledWith({
      repo: "new/repo",
      controlProvider: "github",
    });
    expect(await response.json()).toMatchObject({
      registration: { github_repo: "new/repo", base_branch: "main" },
      readiness: {
        github: "ready",
        webhook: "created",
        snapshot: { name: "snapshot", state: "active" },
      },
    });
    const listed = await app.request("/repositories", { headers: STATUS_HEADERS });
    expect(await listed.json()).toMatchObject({
      repositories: expect.arrayContaining([
        expect.objectContaining({ id: "repo" }),
        expect.objectContaining({ id: "repo-new" }),
      ]),
    });
  });

  it("returns retryable non-acknowledgement during maintenance, then deduplicates signed retries", async () => {
    const { app, fixture } = setup();
    const closed = await app.request("/maintenance/close", {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: 1 }),
    });
    expect(closed.status).toBe(200);
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      issue: { number: 7 },
    });
    const webhookHeaders = {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": "delivery-1",
      "X-GitHub-Event": "issues",
      "X-Hub-Signature-256": githubSignature(raw),
    };
    const blocked = await app.request("/webhooks/github", {
      method: "POST",
      headers: webhookHeaders,
      body: raw,
    });
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("Retry-After")).toBe("30");
    expect(await blocked.json()).toMatchObject({ acknowledge: false, retryable: true });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });

    await app.request("/maintenance/open", { method: "POST", headers: DEPLOY_HEADERS });
    const accepted = await app.request("/webhooks/github", {
      method: "POST", headers: webhookHeaders, body: raw,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, duplicate: false });
    const duplicate = await app.request("/webhooks/github", {
      method: "POST", headers: webhookHeaders, body: raw,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 1 });
  });

  it("rejects an exact unknown Effect through the deploy-only maintenance surface", async () => {
    const { app, effectRejections } = setup();
    const path = "/maintenance/runs/OPE-run-active/effects/effect-integration/reject";
    const body = {
      expected_maintenance_version: 2,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "sandbox rejected the sealed request before repository mutation",
    };

    expect((await app.request(path, {
      method: "POST",
      headers: { ...STATUS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).status).toBe(401);
    expect((await app.request(path, {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, expected_maintenance_version: 1 }),
    })).status).toBe(409);

    const closed = await app.request("/maintenance/close", {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: 1 }),
    });
    expect(closed.status).toBe(200);

    const response = await app.request(path, {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resolution: {
        disposition: "rejected",
        pipeline_run_id: "run-active",
        effect_id: "effect-integration",
        delivery_record_id: "delivery-operator-rejection",
        effect_version: 4,
        run_version: 8,
      },
    });
    expect(effectRejections.rejectDispatchFencedUnknownEffect).toHaveBeenCalledWith({
      pipeline_run_id: "run-active",
      effect_id: "effect-integration",
      ...body,
    });

    effectRejections.rejectDispatchFencedUnknownEffect.mockResolvedValueOnce({
      disposition: "unchanged",
      pipeline_run_id: "run-active",
      effect_id: "effect-integration",
      delivery_record_id: "delivery-operator-rejection",
      effect_version: 4,
      run_version: 8,
    });
    const replay = await app.request(path, {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      resolution: { disposition: "unchanged" },
    });
  });

  it("strictly validates operator Effect rejection and maps not-found and conflict", async () => {
    const { app, effectRejections } = setup();
    await app.request("/maintenance/close", {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: 1 }),
    });
    const path = "/maintenance/runs/OPE-run-active/effects/effect-integration/reject";
    const valid = {
      expected_maintenance_version: 2,
      resolution_id: "resolution-legacy-idempotency-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "sandbox rejected the sealed request before repository mutation",
    };
    const post = (body: unknown, target = path) => app.request(target, {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await post({ ...valid, unexpected: true })).status).toBe(400);
    expect((await post({
      expected_maintenance_version: 2,
      resolution_id: valid.resolution_id,
      reason_code: valid.reason_code,
    })).status).toBe(400);
    expect((await post({ ...valid, reason_code: "operator_guess" })).status).toBe(400);
    expect((await post({ ...valid, resolution_id: "bad id" })).status).toBe(400);
    expect((await post({ ...valid, reason: "x".repeat(1_501) })).status).toBe(400);
    expect((await post(valid,
      "/maintenance/runs/OPE-run-active/effects/bad%20effect/reject")).status).toBe(400);
    expect((await post(valid,
      "/maintenance/runs/missing/effects/effect-integration/reject")).status).toBe(404);
    expect((await post({ ...valid, expected_maintenance_version: 1 })).status).toBe(409);

    effectRejections.rejectDispatchFencedUnknownEffect.mockRejectedValueOnce(
      new KernelOperatorEffectRejectionConflictError("effect is currently leased"),
    );
    const conflict = await post(valid);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "effect is currently leased" });

    const oversized = await app.request(path, {
      method: "POST",
      headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ...valid, reason: "x".repeat(17_000) }),
    });
    expect(oversized.status).toBe(400);
    expect(effectRejections.rejectDispatchFencedUnknownEffect).toHaveBeenCalledTimes(2);
  });

  it("acknowledges valid Linear deliveries with exact HTTP 200", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T13:00:00.000Z"));
    try {
      const { app, fixture } = setup();
      const raw = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "linear-event-1",
        webhookTimestamp: Date.now(),
        agentSession: {
          id: "session-1",
          issue: { id: "issue-1", identifier: "OPE-1", team: { id: "team", key: "OPE" } },
        },
      });
      const headers = {
        "Content-Type": "application/json",
        "Linear-Delivery": "linear-delivery-1",
        "Linear-Signature": linearSignature(raw),
      };
      expect((await app.request("/webhooks/linear", {
        method: "POST", headers: { ...headers, "Linear-Signature": "bad" }, body: raw,
      })).status).toBe(401);

      const missingDelivery = await app.request("/webhooks/linear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Linear-Signature": linearSignature(raw),
        },
        body: raw,
      });
      expect(missingDelivery.status).toBe(400);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
        .toEqual({ count: 0 });

      await app.request("/maintenance/close", {
        method: "POST",
        headers: { ...DEPLOY_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ expected_version: 1 }),
      });
      const blocked = await app.request("/webhooks/linear", {
        method: "POST", headers, body: raw,
      });
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get("Retry-After")).toBe("30");
      expect(await blocked.json()).toMatchObject({ acknowledge: false, retryable: true });
      await app.request("/maintenance/open", { method: "POST", headers: DEPLOY_HEADERS });

      const inserted = await app.request("/webhooks/linear", {
        method: "POST", headers, body: raw,
      });
      expect(inserted.status).toBe(200);
      expect(await inserted.json()).toMatchObject({ accepted: true, duplicate: false });

      const duplicate = await app.request("/webhooks/linear", {
        method: "POST", headers, body: raw,
      });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

      const unregisteredRaw = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "linear-event-unregistered",
        webhookTimestamp: Date.now(),
        agentSession: {
          id: "session-unregistered",
          issue: {
            id: "issue-unregistered",
            identifier: "OTHER-1",
            team: { id: "unregistered-team", key: "OTHER" },
          },
        },
      });
      const ignored = await app.request("/webhooks/linear", {
        method: "POST",
        headers: {
          ...headers,
          "Linear-Delivery": "linear-delivery-unregistered",
          "Linear-Signature": linearSignature(unregisteredRaw),
        },
        body: unregisteredRaw,
      });
      expect(ignored.status).toBe(200);
      expect(await ignored.json()).toEqual({
        accepted: false,
        acknowledge: true,
        retryable: false,
        ignored: "unregistered_route",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a durable Linear session without blocking and preserves inbox retry", async () => {
    const gate = deferred();
    let persistedEventsAtStart = 0;
    let fixtureAtStart: FreshKernelFixture | undefined;
    const ensureStarted = vi.fn()
      .mockImplementationOnce(() => {
        const row = fixtureAtStart?.db.prepare(
          "SELECT COUNT(*) AS count FROM inbox_events",
        ).get() as { count: number } | undefined;
        persistedEventsAtStart = row?.count ?? 0;
        return gate.promise;
      })
      .mockResolvedValueOnce(undefined);
    const dispatcher = new KernelLinearSessionStartDispatcher({
      downstream: { ensureStarted },
      max_concurrency: 1,
    });
    const { app, fixture } = setup({ linear_session_start: dispatcher });
    fixtureAtStart = fixture;
    const raw = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "linear-event-fast-start",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-fast-start",
        issue: {
          id: "issue-fast-start",
          identifier: "OPE-2",
          team: { id: "team", key: "OPE" },
        },
      },
    });

    const response = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery": "linear-delivery-fast-start",
        "Linear-Signature": linearSignature(raw),
      },
      body: raw,
    });
    const body = await response.json() as { event_id: string };

    expect(response.status).toBe(200);
    expect(persistedEventsAtStart).toBe(1);
    expect(ensureStarted).toHaveBeenCalledWith({
      inbox_event_id: body.event_id,
      webhook_id: "linear-event-fast-start",
      session_id: "session-fast-start",
    });

    gate.reject(new Error("background provider failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.db.prepare(
      "SELECT status FROM inbox_events WHERE id = ?",
    ).get(body.event_id)).toEqual({ status: "pending" });
    await expect(dispatcher.ensureStarted({
      inbox_event_id: body.event_id,
      webhook_id: "linear-event-fast-start",
      session_id: "session-fast-start",
    })).resolves.toBeUndefined();
    expect(ensureStarted).toHaveBeenCalledTimes(2);

    const reordered = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery": "linear-delivery-fast-start-reordered",
        "Linear-Signature": linearSignature(raw),
      },
      body: raw,
    });
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(fixture.db.prepare(
      "SELECT status FROM inbox_events WHERE delivery_id = ?",
    ).get("linear-delivery-fast-start-reordered")).toEqual({ status: "stale" });
    expect(ensureStarted).toHaveBeenCalledTimes(2);

    const secondSessionRaw = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "linear-event-fast-start",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-second",
        issue: {
          id: "issue-second",
          identifier: "OPE-3",
          team: { id: "team", key: "OPE" },
        },
      },
    });
    const secondSession = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery": "linear-delivery-second-session",
        "Linear-Signature": linearSignature(secondSessionRaw),
      },
      body: secondSessionRaw,
    });

    expect(secondSession.status).toBe(200);
    expect(await secondSession.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(fixture.db.prepare(
      "SELECT status FROM inbox_events WHERE delivery_id = ?",
    ).get("linear-delivery-second-session")).toEqual({ status: "pending" });
    expect(fixture.db.prepare(
      "SELECT COUNT(DISTINCT event_group_key) AS count FROM inbox_events",
    ).get()).toEqual({ count: 2 });
    expect(ensureStarted).toHaveBeenCalledTimes(3);
  });
});
