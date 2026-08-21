import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelControlService } from "../app/kernel-control.js";
import {
  KernelHttpService,
  type KernelRepositorySetupPort,
} from "../app/kernel-http.js";
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
import { createServer } from "./server.js";

const fixtures: FreshKernelFixture[] = [];
const STATUS_HEADERS = { Authorization: "Bearer status-token" };
const DEPLOY_HEADERS = { Authorization: "Bearer deploy-token" };

afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
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
  const service = new KernelHttpService({
    registrations,
    projections,
    analysis: createKernelHistoricalAnalysisStore(fixture.db),
    control,
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
        task_timeout_seconds: 3_600,
      },
      service,
      repository_setup: repositorySetup,
    }),
  };
}

function githubSignature(raw: string): string {
  return `sha256=${createHmac("sha256", "github-secret").update(raw).digest("hex")}`;
}

function linearSignature(raw: string): string {
  return createHmac("sha256", "linear-secret").update(raw).digest("hex");
}

describe("kernel-native HTTP surface", () => {
  it("serves health plus authenticated status, logs, analysis, and run control", async () => {
    const { app } = setup();
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
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
      body: JSON.stringify({ expected_version: 0 }),
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

  it("verifies Linear signatures and freshness before durable ingestion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T13:00:00.000Z"));
    try {
      const { app } = setup();
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
      expect((await app.request("/webhooks/linear", {
        method: "POST", headers, body: raw,
      })).status).toBe(202);
    } finally {
      vi.useRealTimers();
    }
  });
});
