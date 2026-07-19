import { createHash, createHmac } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createTicketStore, openDb } from "./db.js";
import type { LinearClient } from "./linear.js";
import { createServer } from "./server.js";

const cfg: Config = {
  port: 8080,
  databasePath: ":memory:",
  supervisorUrl: "https://ot.test",
  statusToken: "status-secret",
  installSecret: "install-secret",
  linearWebhookSecret: "linear-secret",
  linearClientId: "client",
  linearClientSecret: "client-secret",
  githubWebhookSecret: "github-secret",
  githubToken: "github-token",
  githubRepo: "owner/repo",
  githubRepoMappings: {},
  githubRepoLabelMappings: {},
  daytonaApiKey: "daytona-key",
  daytonaSnapshot: "openthrottle",
  defaultAgent: "codex",
  claudeCodeOauthToken: "claude-token",
  codexAuthJson: "{}",
  kimiCodeApiKey: "kimi-token",
  baseBranch: "main",
  maxTurns: 200,
  taskTimeout: 7200,
  callbackGraceSeconds: 120,
  devPort: 3000,
  sweepMaxAgeDays: 14,
  orphanGraceMinutes: 5,
  webhookMaxAgeSeconds: 60,
  reviewMaxRounds: 3,
  allowLinearMerge: false,
  sandboxEventPollIntervalMs: 5_000,
};

let db: Database.Database | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
});

function signedLinear(raw: string, delivery: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Linear-Delivery": delivery,
    "Linear-Signature": createHmac("sha256", cfg.linearWebhookSecret).update(raw).digest("hex"),
  };
}

function signedGithub(raw: string, delivery: string, event: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-GitHub-Delivery": delivery,
    "X-GitHub-Event": event,
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", cfg.githubWebhookSecret)
      .update(raw)
      .digest("hex")}`,
  };
}

describe("createServer lifecycle", () => {
  it("acks, deduplicates, serializes, completes once, and cleans up on PR close", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/target",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    const linearRequests: Array<Record<string, unknown>> = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      linearRequests.push(request);
      const query = String(request.query);
      const data = query.includes("AgentSessionUpdate")
        ? { agentSessionUpdate: { success: true } }
        : { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } };
      return Response.json({ data });
    }) as unknown as typeof fetch;
    const linear: LinearClient = { accessToken: "oauth", fetch: linearFetch };

    let createParams:
      | { envVars?: Record<string, string>; autoStopInterval?: number }
      | undefined;
    const executeSessionCommand = vi.fn(async () => undefined);
    const setAutostopInterval = vi.fn(async (_minutes: number) => undefined);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval,
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand,
      },
      stop: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const daytona = {
      list: vi.fn(() => (async function* () {})()),
      create: vi.fn(async (params: { envVars?: Record<string, string> }) => {
        createParams = params;
        return sandbox;
      }),
      get: vi.fn(async () => sandbox),
    } as unknown as Daytona;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => linear,
      runBackground: (task) => background.push(task),
    });

    expect((await app.request("/status")).status).toBe(401);
    expect(
      (
        await app.request("/status", {
          headers: { Authorization: `Bearer ${cfg.statusToken}` },
        })
      ).status
    ).toBe(200);
    expect((await app.request("/oauth/install")).status).toBe(401);

    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-1",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      promptContext: "# OT-1\n\nApproved implementation plan",
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
    const createdResponse = await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-1"),
      body: created,
    });
    expect(createdResponse.status).toBe(200);
    await Promise.all(background.splice(0));
    expect(daytona.create).toHaveBeenCalledTimes(1);
    expect(executeSessionCommand).toHaveBeenCalledOnce();
    expect(createParams?.autoStopInterval).toBe(60);
    expect(createParams?.envVars).not.toHaveProperty("LINEAR_ACCESS_TOKEN");
    expect(createParams?.envVars).not.toHaveProperty("LINEAR_MCP_API_KEY");
    expect(createParams?.envVars).not.toHaveProperty("LINEAR_SESSION_ID");
    expect(createParams?.envVars).not.toHaveProperty("SUPERVISOR_URL");
    expect(createParams?.envVars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(createParams?.envVars).toHaveProperty("CODEX_AUTH_JSON", "{}");
    expect(createParams?.envVars).toMatchObject({
      GITHUB_REPO: "owner/target",
      BASE_BRANCH: "develop",
    });
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from("# OT-1\n\nApproved implementation plan"),
      "/home/agent/.ot/linear-context.md"
    );
    expect(store.getByIssueId("issue-1")).toMatchObject({
      agent: "codex",
      repo: "owner/target",
      base_branch: "develop",
      sandbox_id: "sandbox-1",
      run_id: expect.any(String),
      linear_context: "# OT-1\n\nApproved implementation plan",
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-1"),
      body: created,
    });
    await Promise.all(background.splice(0));
    expect(daytona.create).toHaveBeenCalledTimes(1);

    const prompted = JSON.stringify({
      ...JSON.parse(created),
      action: "prompted",
      webhookId: "linear-2",
      agentActivity: { id: "prompt-1", content: { type: "prompt", body: "one more change" } },
    });
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(prompted, "linear-2"),
      body: prompted,
    });
    await Promise.all(background.splice(0));
    expect(
      linearRequests.some((request) => JSON.stringify(request).includes("Still working on the last message"))
    ).toBe(true);

    const runId = createParams?.envVars?.RUN_ID;
    const callbackToken = createParams?.envVars?.RUN_CALLBACK_TOKEN;
    expect(runId).toBeTruthy();
    expect(callbackToken).toBeTruthy();
    const callback = await app.request(`/runs/${runId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({
        exit_code: 0,
        cost_usd: 0.75,
        pr_url: "https://github.com/owner/target/pull/7",
      }),
    });
    await Promise.all(background.splice(0));
    expect(callback.status).toBe(200);
    await Promise.all(background.splice(0));
    const resumedRunId = store.getByIssueId("issue-1")?.run_id;
    expect(setAutostopInterval.mock.calls.map(([minutes]) => minutes)).toEqual([5]);
    expect(store.getByIssueId("issue-1")).toMatchObject({
      run_id: expect.any(String),
      total_cost_usd: 0.75,
      pr_url: "https://github.com/owner/target/pull/7",
    });
    expect(resumedRunId).not.toBe(runId);
    expect(store.getRun(resumedRunId!)?.task_type).toBe("resume");
    expect(
      db!.prepare("SELECT status, claimed_run_id FROM session_work WHERE id = ?")
        .get("prompt-1")
    ).toEqual({ status: "consumed", claimed_run_id: resumedRunId });
    expect(
      (
        await app.request(`/runs/${runId}/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${callbackToken}`,
          },
          body: JSON.stringify({ exit_code: 0 }),
        })
      ).status
    ).toBe(409);

    const closed = JSON.stringify({
      action: "closed",
      repository: { full_name: "owner/target" },
      pull_request: {
        number: 7,
        html_url: "https://github.com/owner/target/pull/7",
        merged: true,
        head: { ref: "ot/ot-1", sha: "abc" },
        base: { ref: "develop" },
      },
    });
    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(closed, "github-1", "pull_request"),
      body: closed,
    });
    await Promise.all(background.splice(0));
    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(store.getByIssueId("issue-1")?.state).toBe("closed");
  });

  it("consumes an idle prompted activity when it launches immediately", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-idle",
      linear_issue_identifier: "OT-IDLE",
      linear_session_id: "session-idle",
      sandbox_id: "sandbox-idle",
      branch: "ot/ot-idle",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const executeSessionCommand = vi.fn(async () => undefined);
    const sandbox = {
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand,
      },
    };
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () =>
          Response.json({
            data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
          })
        ) as unknown as typeof fetch,
      }),
      runBackground: (task) => background.push(task),
    });
    const prompted = JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: "linear-idle-1",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: { id: "session-idle" },
      agentActivity: { id: "prompt-idle", content: { type: "prompt", body: "continue" } },
    });

    expect(
      (
        await app.request("/webhooks/linear", {
          method: "POST",
          headers: signedLinear(prompted, "linear-idle-1"),
          body: prompted,
        })
      ).status
    ).toBe(200);
    await Promise.all(background.splice(0));
    const runId = store.getByIssueId("issue-idle")?.run_id;
    expect(runId).toBeTruthy();
    expect(
      db.prepare("SELECT status, claimed_run_id FROM session_work WHERE id = ?")
        .get("prompt-idle")
    ).toEqual({ status: "consumed", claimed_run_id: runId });

    expect(
      (
        await app.request("/webhooks/linear", {
          method: "POST",
          headers: signedLinear(prompted, "linear-idle-2"),
          body: prompted,
        })
      ).status
    ).toBe(200);
    await Promise.all(background.splice(0));
    expect(executeSessionCommand).toHaveBeenCalledOnce();
  });

  it("settles a newly created sandbox when its first task fails to start", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/repo",
      baseBranch: "main",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    const setAutostopInterval = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-start-failure",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval,
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => {
          throw new Error("entrypoint unavailable");
        }),
      },
    };
    const daytona = {
      list: vi.fn(() => (async function* () {})()),
      create: vi.fn(async () => sandbox),
      get: vi.fn(async () => sandbox),
    } as unknown as Daytona;
    const linearFetch = vi.fn(async () =>
      Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-start-failure",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-start-failure",
        issue: {
          id: "issue-start-failure",
          identifier: "OT-START-FAILURE",
          team: { id: "team-1", key: "OT" },
          labels: [],
        },
      },
    });

    const response = await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-start-failure"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(store.getByIssueId("issue-start-failure")).toMatchObject({
      sandbox_id: "sandbox-start-failure",
      run_id: null,
      state: "error",
    });
    expect(daytona.get).toHaveBeenCalledWith("sandbox-start-failure");
    expect(setAutostopInterval).toHaveBeenCalledWith(5);
  });

  it("authenticates repository registration and verifies GitHub plus Daytona readiness", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widget")) {
        return Response.json({ full_name: "acme/widget", default_branch: "main" });
      }
      if (url.endsWith("/branches/develop")) return Response.json({ name: "develop" });
      if (url.endsWith("/hooks?per_page=100")) return Response.json([]);
      if (url.endsWith("/hooks") && init?.method === "POST") return Response.json({ id: 99 });
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const daytona = {
      snapshot: { get: vi.fn(async () => ({ name: "openthrottle", state: "active" })) },
    } as unknown as Daytona;
    const app = createServer({ cfg, store, daytona, getLinearClient: async () => undefined });

    expect((await app.request("/repositories")).status).toBe(401);
    expect(
      (
        await app.request("/repositories/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: "acme/widget",
            baseBranch: "develop",
            linearTeamKey: "eng",
            linearTeamId: "team-eng",
          }),
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request("/repositories/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.statusToken}`,
          },
          body: JSON.stringify({
            repo: "acme/widget",
            baseBranch: "../main",
            linearTeamKey: "ENG",
          }),
        })
      ).status
    ).toBe(400);

    const response = await app.request("/repositories/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.statusToken}`,
      },
      body: JSON.stringify({
        repo: "acme/widget",
        baseBranch: "develop",
        linearTeamKey: "eng",
        linearTeamId: "team-eng",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registration: {
        linear_team_key: "ENG",
        linear_team_id: "team-eng",
        github_repo: "acme/widget",
        base_branch: "develop",
        webhook_id: 99,
      },
      readiness: {
        github: "ready",
        webhook: "created",
        snapshot: { name: "openthrottle", state: "active" },
      },
    });
    const list = await app.request("/repositories", {
      headers: { Authorization: `Bearer ${cfg.statusToken}` },
    });
    expect(await list.json()).toMatchObject({
      repositories: [expect.objectContaining({ github_repo: "acme/widget" })],
    });

    githubFetch.mockClear();
    const inactiveApp = createServer({
      cfg,
      store,
      daytona: {
        snapshot: { get: vi.fn(async () => ({ name: "openthrottle", state: "error" })) },
      } as unknown as Daytona,
      getLinearClient: async () => undefined,
    });
    const inactiveResponse = await inactiveApp.request("/repositories/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.statusToken}`,
      },
      body: JSON.stringify({ repo: "acme/other", linearTeamKey: "OTHER" }),
    });
    expect(inactiveResponse.status).toBe(502);
    expect(githubFetch).not.toHaveBeenCalled();
    expect(store.getRepositoryRegistration(undefined, "OTHER")).toBeUndefined();
  });

  it("fails closed for an unregistered Linear team once durable routing is enabled", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-eng",
      githubRepo: "acme/widget",
      baseBranch: "main",
      webhookId: 9,
      snapshot: "openthrottle",
    });
    const linearRequests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      linearRequests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const daytona = {
      list: vi.fn(() => (async function* () {})()),
      create: vi.fn(),
    } as unknown as Daytona;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-unregistered",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-unregistered",
        issue: {
          id: "issue-unregistered",
          identifier: "OPS-1",
          team: { id: "team-ops", key: "OPS" },
          labels: [],
        },
      },
    });
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-unregistered"),
      body: created,
    });
    await Promise.all(background);

    expect(daytona.create).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-unregistered")).toBeUndefined();
    expect(linearRequests.some((request) => request.includes("No repository is registered"))).toBe(true);
    expect(store.listLinearOutbox()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linear_session_id: "session-unregistered",
          status: "processed",
          kind: "activity",
        }),
      ])
    );
  });

  it("rejects invalid, stale, and unsupported webhook input before side effects", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const daytona = { create: vi.fn() } as unknown as Daytona;
    const app = createServer({ cfg, store, daytona, getLinearClient: async () => undefined });
    const payload = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "id",
      webhookTimestamp: Date.now() - 120_000,
      organizationId: "org",
      agentSession: { id: "session" },
    });
    expect(
      (
        await app.request("/webhooks/linear", {
          method: "POST",
          headers: signedLinear(payload, "stale"),
          body: payload,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await app.request("/webhooks/github", {
          method: "POST",
          headers: signedGithub('{"action":"opened","repository":{}}', "unsupported", "issues"),
          body: '{"action":"opened","repository":{}}',
        })
      ).status
    ).toBe(200);
    expect(daytona.create).not.toHaveBeenCalled();
  });

  it("rejects a selected agent without a subscription login before provisioning", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const daytona = { list: vi.fn(), create: vi.fn() } as unknown as Daytona;
    const linearRequests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      linearRequests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg: { ...cfg, claudeCodeOauthToken: undefined },
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-missing-claude",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-missing-claude",
        issue: {
          id: "issue-missing-claude",
          identifier: "OT-NO-CLAUDE",
          labels: [{ name: "agent:claude" }],
        },
      },
    });

    const response = await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-missing-claude"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(daytona.list).not.toHaveBeenCalled();
    expect(daytona.create).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-missing-claude")).toBeUndefined();
    expect(linearRequests.some((request) => request.includes("subscription login is not configured")))
      .toBe(true);
    expect(store.listLinearOutbox()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linear_session_id: "session-missing-claude",
          status: "processed",
          kind: "activity",
        }),
      ])
    );
  });

  it("reattaches a labeled workspace after provisioning was interrupted", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-recover",
      linear_issue_identifier: "OT-RECOVER",
      linear_session_id: "session-recover",
      sandbox_id: null,
      branch: "ot/ot-recover",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-recover",
      runId: "run-recover",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const recovered = { id: "sandbox-recovered" };
    const daytona = {
      list: vi.fn(() =>
        (async function* () {
          yield recovered;
        })()
      ),
      create: vi.fn(),
    } as unknown as Daytona;
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const query = String(JSON.parse(String(init?.body)).query);
      return Response.json({
        data: query.includes("AgentSessionUpdate")
          ? { agentSessionUpdate: { success: true } }
          : { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-recover",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-recover",
        issue: {
          id: "issue-recover",
          identifier: "OT-RECOVER",
          team: { id: "team-1", key: "OT" },
          labels: [],
        },
      },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-recover"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(daytona.create).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-recover")).toMatchObject({
      sandbox_id: "sandbox-recovered",
      run_id: "run-recover",
    });
    expect(store.getRun("run-recover")?.status).toBe("running");
  });

  it("keeps a successfully started run active when its Linear activity fails", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-notify",
      linear_issue_identifier: "OT-NOTIFY",
      linear_session_id: "session-notify",
      sandbox_id: "sandbox-notify",
      branch: "ot/ot-notify",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const executeSessionCommand = vi.fn(async () => undefined);
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      id: "sandbox-notify",
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand,
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    let linearCall = 0;
    const linearFetch = vi.fn(async () => {
      linearCall += 1;
      if (linearCall === 2) throw new Error("Linear unavailable");
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-notify",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-notify",
        issue: {
          id: "issue-notify",
          identifier: "OT-NOTIFY",
          team: { id: "team-1", key: "OT" },
          labels: [],
        },
      },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-notify"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(executeSessionCommand).toHaveBeenCalledOnce();
    const ticket = store.getByIssueId("issue-notify")!;
    expect(ticket.agent).toBe("claude");
    expect(ticket.run_id).toEqual(expect.any(String));
    expect(store.getRun(ticket.run_id!)?.status).toBe("running");
    expect(envUpdates.at(-1)).toMatchObject({ AGENT: "claude", TASK_TYPE: "resume" });
  });

  it("starts fresh instead of cross-resuming when a re-delegation switches agents", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-switch",
      linear_issue_identifier: "OT-SWITCH",
      linear_session_id: "session-old",
      sandbox_id: "sandbox-switch",
      branch: "ot/ot-switch",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      id: "sandbox-switch",
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const linearFetch = vi.fn(async () => Response.json({
      data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
    })) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: {
        get: vi.fn(async () => sandbox),
        list: vi.fn(() => (async function* () {})()),
        create: vi.fn(async () => sandbox),
      } as unknown as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-switch",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-switch",
        issue: {
          id: "issue-switch",
          identifier: "OT-SWITCH",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "agent:codex" }],
        },
      },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-switch"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(store.getByIssueId("issue-switch")?.agent).toBe("codex");
    expect(envUpdates.at(-1)).toMatchObject({
      AGENT: "codex",
      TASK_TYPE: "implement",
      CODEX_AUTH_JSON: "{}",
    });
    expect(envUpdates.at(-1)).not.toHaveProperty("RESUME_MESSAGE");

    const opencode = JSON.stringify({
      ...JSON.parse(created),
      webhookId: "linear-switch-opencode",
      agentSession: {
        id: "session-switch-opencode",
        issue: {
          id: "issue-switch-opencode",
          identifier: "OT-SWITCH-OPENCODE",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "agent:opencode" }],
        },
      },
    });
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(opencode, "linear-switch-opencode"),
      body: opencode,
    });
    await Promise.all(background.splice(0));

    expect(store.getByIssueId("issue-switch-opencode")?.agent).toBe("opencode");
    expect(envUpdates.at(-1)).toMatchObject({
      AGENT: "opencode",
      TASK_TYPE: "implement",
      KIMI_CODE_API_KEY: "kimi-token",
    });
    expect(envUpdates.at(-1)).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envUpdates.at(-1)).not.toHaveProperty("CODEX_AUTH_JSON");
  });

  it("persists stopped state even when Daytona cannot stop immediately", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-stop",
      linear_issue_identifier: "OT-STOP",
      linear_session_id: "session-stop",
      sandbox_id: "sandbox-stop",
      branch: "ot/ot-stop",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-stop",
      runId: "run-stop",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const calls: string[] = [];
    const sandbox = { stop: vi.fn(async () => {
      calls.push("stop");
      return Promise.reject(new Error("Daytona unavailable"));
    }) };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () =>
          Response.json({
            data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
          })
        ) as unknown as typeof fetch,
      }),
      linearOutboxProcessor: {
        process: vi.fn(async () => undefined),
        drain: vi.fn(async () => {
          calls.push("drain");
        }),
      },
    });
    const prompted = JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: "linear-stop",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: { id: "session-stop" },
      agentActivity: { id: "activity-stop", content: { type: "prompt", body: "/stop" } },
    });

    const response = await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(prompted, "linear-stop"),
      body: prompted,
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getByIssueId("issue-stop")).toMatchObject({
      run_id: null,
      state: "stopped",
    });
    expect(store.getRun("run-stop")?.status).toBe("stopped");
    expect(store.listLinearOutbox()).toEqual([
      expect.objectContaining({ kind: "activity", status: "pending" }),
    ]);
    expect(calls).toEqual(["stop", "drain"]);
  });

  it("routes new delegations from repo labels before registered team routes", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/team-default",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    const routedCfg: Config = {
      ...cfg,
      githubRepoLabelMappings: { "Repo/web-app": "owner/web-app" },
    };
    let createParams: { envVars?: Record<string, string> } | undefined;
    const sandbox = {
      id: "sandbox-repo-label",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg: routedCfg,
      store,
      daytona: {
        get: vi.fn(async () => sandbox),
        list: vi.fn(() => (async function* () {})()),
        create: vi.fn(async (params: { envVars?: Record<string, string> }) => {
          createParams = params;
          return sandbox;
        }),
      } as unknown as Daytona,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () =>
          Response.json({
            data: {
              agentActivityCreate: { success: true, agentActivity: { id: "activity" } },
              agentSessionUpdate: { success: true },
            },
          })
        ) as unknown as typeof fetch,
      }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-repo-label",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-repo-label",
        issue: {
          id: "issue-repo-label",
          identifier: "OT-REPO",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "Repo › Repo/web-app" }],
        },
      },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-repo-label"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(createParams?.envVars).toHaveProperty("GITHUB_REPO", "owner/web-app");
    expect(createParams?.envVars).toHaveProperty("BASE_BRANCH", "main");
    expect(store.getByIssueId("issue-repo-label")).toMatchObject({
      repo: "owner/web-app",
      base_branch: "main",
      sandbox_id: "sandbox-repo-label",
      state: "active",
      run_id: expect.any(String),
    });
  });

  function baseLabelHarness() {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/team-default",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    let createParams: { envVars?: Record<string, string> } | undefined;
    const sandbox = {
      id: "sandbox-base-label",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn(async (params: { envVars?: Record<string, string> }) => {
      createParams = params;
      return sandbox;
    });
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: {
        get: vi.fn(async () => sandbox),
        list: vi.fn(() => (async function* () {})()),
        create,
      } as unknown as Daytona,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () =>
          Response.json({
            data: {
              agentActivityCreate: { success: true, agentActivity: { id: "activity" } },
              agentSessionUpdate: { success: true },
            },
          })
        ) as unknown as typeof fetch,
      }),
      runBackground: (task) => background.push(task),
    });
    const createdEvent = (issueId: string, base: string) =>
      JSON.stringify({
        action: "created",
        type: "AgentSessionEvent",
        webhookId: `linear-${issueId}`,
        webhookTimestamp: Date.now(),
        organizationId: "org",
        agentSession: {
          id: `session-${issueId}`,
          issue: {
            id: issueId,
            identifier: "OT-BASE",
            team: { id: "team-1", key: "OT" },
            labels: [{ name: `Base › ${base}` }],
          },
        },
      });
    return { store, create, background, app, createdEvent, getCreateParams: () => createParams };
  }

  it("overrides the route base branch from a Base label when the branch exists", async () => {
    const { store, create, background, app, createdEvent, getCreateParams } = baseLabelHarness();
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/team-default/branches/feature%2Fx")) {
        return Response.json({ name: "feature/x" });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);

    const created = createdEvent("issue-base-label", "feature/x");
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-issue-base-label"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(githubFetch).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(getCreateParams()?.envVars).toMatchObject({
      GITHUB_REPO: "owner/team-default",
      BASE_BRANCH: "feature/x",
    });
    expect(store.getByIssueId("issue-base-label")).toMatchObject({
      repo: "owner/team-default",
      base_branch: "feature/x",
      state: "active",
    });
  });

  it("fails closed when the Base label branch does not exist", async () => {
    const { store, create, background, app, createdEvent } = baseLabelHarness();
    const githubFetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", githubFetch);

    const created = createdEvent("issue-base-missing", "ghost");
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-issue-base-missing"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(githubFetch).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-base-missing")).toBeUndefined();
    expect(
      store
        .listLinearOutbox()
        .some(
          (row) => typeof row.payload === "string" && row.payload.includes("does not exist")
        )
    ).toBe(true);
  });

  it("fails closed on an unsafe Base label without calling GitHub", async () => {
    const { store, create, background, app, createdEvent } = baseLabelHarness();
    const githubFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", githubFetch);

    const created = createdEvent("issue-base-unsafe", "../evil");
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-issue-base-unsafe"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(githubFetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-base-unsafe")).toBeUndefined();
  });

  it("overrides the base branch from a Linear label group resolved via GraphQL", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/team-default",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    let createParams: { envVars?: Record<string, string> } | undefined;
    const sandbox = {
      id: "sandbox-group-label",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn(async (params: { envVars?: Record<string, string> }) => {
      createParams = params;
      return sandbox;
    });
    // The webhook carries only the leaf label name, so no flat `Base ›` match
    // exists; the supervisor must resolve the parent group via the IssueLabels
    // GraphQL query to discover this is a `Base` group label.
    let issueLabelsQueried = false;
    const linearFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = String((JSON.parse(String(init?.body)) as { query?: string }).query);
      if (query.includes("IssueLabels")) {
        issueLabelsQueried = true;
        return Response.json({
          data: {
            issue: { labels: { nodes: [{ name: "release/2.0", parent: { name: "Base" } }] } },
          },
        });
      }
      return Response.json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "activity" } },
          agentSessionUpdate: { success: true },
        },
      });
    }) as unknown as typeof fetch;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/team-default/branches/release%2F2.0")) {
        return Response.json({ name: "release/2.0" });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: {
        get: vi.fn(async () => sandbox),
        list: vi.fn(() => (async function* () {})()),
        create,
      } as unknown as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-group-label",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-group-label",
        issue: {
          id: "issue-group-label",
          identifier: "OT-GROUP",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "release/2.0" }],
        },
      },
    });
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-group-label"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(issueLabelsQueried).toBe(true);
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(createParams?.envVars).toMatchObject({
      GITHUB_REPO: "owner/team-default",
      BASE_BRANCH: "release/2.0",
    });
    expect(store.getByIssueId("issue-group-label")).toMatchObject({
      repo: "owner/team-default",
      base_branch: "release/2.0",
      state: "active",
    });
  });

  it("keeps a grouped Base child out of repo-label routing", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/team-default",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    // A repo-label mapping whose key collides with the Base-group child leaf.
    const routedCfg: Config = {
      ...cfg,
      githubRepoLabelMappings: { "web-app": "owner/web-app" },
    };
    let createParams: { envVars?: Record<string, string> } | undefined;
    const sandbox = {
      id: "sandbox-collision",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const create = vi.fn(async (params: { envVars?: Record<string, string> }) => {
      createParams = params;
      return sandbox;
    });
    const linearFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = String((JSON.parse(String(init?.body)) as { query?: string }).query);
      if (query.includes("IssueLabels")) {
        return Response.json({
          data: {
            issue: { labels: { nodes: [{ name: "web-app", parent: { name: "Base" } }] } },
          },
        });
      }
      return Response.json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "activity" } },
          agentSessionUpdate: { success: true },
        },
      });
    }) as unknown as typeof fetch;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/team-default/branches/web-app")) {
        return Response.json({ name: "web-app" });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg: routedCfg,
      store,
      daytona: {
        get: vi.fn(async () => sandbox),
        list: vi.fn(() => (async function* () {})()),
        create,
      } as unknown as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-collision",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-collision",
        issue: {
          id: "issue-collision",
          identifier: "OT-COLLIDE",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "web-app" }],
        },
      },
    });
    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-collision"),
      body: created,
    });
    await Promise.all(background.splice(0));

    // The `web-app` leaf is a Base-group child, so it must not route to the
    // mapped `owner/web-app`; the team repo wins with only the base overridden,
    // and the branch is verified on that team repo (not the mapped one).
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(createParams?.envVars).toMatchObject({
      GITHUB_REPO: "owner/team-default",
      BASE_BRANCH: "web-app",
    });
    expect(store.getByIssueId("issue-collision")).toMatchObject({
      repo: "owner/team-default",
      base_branch: "web-app",
      state: "active",
    });
  });

  it("starts a fresh workspace when re-delegation changes the routed repo", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-repo-switch",
      linear_issue_identifier: "OT-REPO-SWITCH",
      linear_session_id: "session-old",
      sandbox_id: "sandbox-old-repo",
      branch: "ot/ot-repo-switch",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-repo-switch",
      runId: "run-old-repo",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const routedCfg: Config = {
      ...cfg,
      githubRepoLabelMappings: { "Repo/web-app": "owner/web-app" },
    };
    let createParams: { envVars?: Record<string, string> } | undefined;
    const oldSandbox = {
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const newSandbox = {
      id: "sandbox-new-repo",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg: routedCfg,
      store,
      daytona: {
        get: vi.fn(async () => oldSandbox),
        list: vi.fn(() => (async function* () {})()),
        create: vi.fn(async (params: { envVars?: Record<string, string> }) => {
          createParams = params;
          return newSandbox;
        }),
      } as unknown as Daytona,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () =>
          Response.json({
            data: {
              agentActivityCreate: { success: true, agentActivity: { id: "activity" } },
              agentSessionUpdate: { success: true },
            },
          })
        ) as unknown as typeof fetch,
      }),
      runBackground: (task) => background.push(task),
    });
    const created = JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "linear-repo-switch",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-repo-switch",
        issue: {
          id: "issue-repo-switch",
          identifier: "OT-REPO-SWITCH",
          team: { id: "team-1", key: "OT" },
          labels: [{ name: "Repo › Repo/web-app" }],
        },
      },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(created, "linear-repo-switch"),
      body: created,
    });
    await Promise.all(background.splice(0));

    expect(oldSandbox.stop).toHaveBeenCalledWith(60, true);
    expect(oldSandbox.delete).toHaveBeenCalledWith(60, false);
    expect(store.getRun("run-old-repo")?.status).toBe("stopped");
    expect(createParams?.envVars).toHaveProperty("GITHUB_REPO", "owner/web-app");
    expect(store.getByIssueId("issue-repo-switch")).toMatchObject({
      repo: "owner/web-app",
      sandbox_id: "sandbox-new-repo",
      state: "active",
    });
  });

  it("persists operator stop state even when Daytona cannot stop immediately", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-stop",
      linear_issue_identifier: "OT-STOP",
      linear_session_id: "session-stop",
      sandbox_id: "sandbox-stop",
      branch: "ot/ot-stop",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-stop",
      runId: "run-stop",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const calls: string[] = [];
    const sandbox = { stop: vi.fn(async () => {
      calls.push("stop");
      return Promise.reject(new Error("Daytona unavailable"));
    }) };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => undefined,
      linearOutboxProcessor: {
        process: vi.fn(async () => undefined),
        drain: vi.fn(async () => {
          calls.push("drain");
        }),
      },
    });

    const response = await app.request("/tickets/OT-STOP/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.statusToken}` },
    });

    expect(response.status).toBe(200);
    expect(store.getRun("run-stop")?.status).toBe("stopped");
    expect(store.getByIssueId("issue-stop")).toMatchObject({
      state: "stopped",
      run_id: null,
    });
    expect(calls).toEqual(["stop", "drain"]);
    expect(store.listLinearOutbox()).toEqual([
      expect.objectContaining({
        linear_session_id: "session-stop",
        status: "pending",
        kind: "activity",
      }),
    ]);
  });

  it("finishes PR-close state even when immediate sandbox cleanup fails", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-close",
      linear_issue_identifier: "OT-CLOSE",
      linear_session_id: "session-close",
      sandbox_id: "sandbox-close",
      branch: "ot/ot-close",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.beginRun({
      issueId: "issue-close",
      runId: "run-close",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const sandbox = {
      stop: vi.fn(async () => Promise.reject(new Error("stop unavailable"))),
      delete: vi.fn(async () => Promise.reject(new Error("delete unavailable"))),
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const linearFetch = vi.fn(async () =>
      Response.json({ data: { agentActivityCreate: { success: true }, agentSessionUpdate: { success: true } } })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const closed = JSON.stringify({
      action: "closed",
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 9,
        html_url: "https://github.com/owner/repo/pull/9",
        merged: false,
        head: { ref: "ot/ot-close", sha: "abc" },
        base: { ref: "main" },
      },
    });

    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(closed, "github-close", "pull_request"),
      body: closed,
    });
    await Promise.all(background.splice(0));

    expect(store.getRun("run-close")?.status).toBe("stopped");
    expect(store.getByIssueId("issue-close")?.state).toBe("closed");
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it("starts review and review-fix tasks and mirrors completed CI", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-review",
      linear_issue_identifier: "OT-REVIEW",
      linear_session_id: "session-review",
      sandbox_id: "sandbox-review",
      branch: "ot/ot-review",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/12",
      state: "active",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      id: "sandbox-review",
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/reviews")) {
        return Response.json([{ state: "CHANGES_REQUESTED" }]);
      }
      throw new Error(`Unexpected GitHub request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linearRequests: Array<string> = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
      linearRequests.push(JSON.stringify(request));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const pullRequest = {
      number: 12,
      html_url: "https://github.com/owner/repo/pull/12",
      merged: false,
      head: { ref: "ot/ot-review", sha: "abc" },
      base: { ref: "main" },
    };
    const labeled = JSON.stringify({
      action: "labeled",
      label: { name: "needs-review" },
      repository: { full_name: "owner/repo" },
      pull_request: pullRequest,
    });

    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(labeled, "github-review", "pull_request"),
      body: labeled,
    });
    await Promise.all(background.splice(0));
    expect(envUpdates.at(-1)).toMatchObject({ TASK_TYPE: "review", PR_NUMBER: "12" });

    const reviewRunId = store.getByIssueId("issue-review")!.run_id!;
    store.finishRun({ runId: reviewRunId, status: "completed", ticketState: "active" });
    const changesRequested = JSON.stringify({
      action: "submitted",
      repository: { full_name: "owner/repo" },
      pull_request: pullRequest,
      review: {
        id: 42,
        state: "CHANGES_REQUESTED",
        html_url: "https://github.com/owner/repo/pull/12#pullrequestreview-42",
        user: { login: "reviewer" },
      },
    });
    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(changesRequested, "github-review-fix", "pull_request_review"),
      body: changesRequested,
    });
    await Promise.all(background.splice(0));
    expect(envUpdates.at(-1)).toMatchObject({ TASK_TYPE: "review-fix", PR_NUMBER: "12" });

    const workflowRun = JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      workflow_run: {
        id: 9,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_branch: "ot/ot-review",
        html_url: "https://github.com/owner/repo/actions/runs/9",
      },
    });
    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(workflowRun, "github-ci", "workflow_run"),
      body: workflowRun,
    });
    await Promise.all(background.splice(0));
    expect(linearRequests.some((request) => request.includes("CI completed"))).toBe(true);
  });

  it("stops automated review work at the configured round cap", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-cap",
      linear_issue_identifier: "OT-CAP",
      linear_session_id: "session-cap",
      sandbox_id: "sandbox-cap",
      branch: "ot/ot-cap",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/13",
      state: "active",
    });
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/reviews")) {
        return Response.json(Array.from({ length: 3 }, () => ({ state: "CHANGES_REQUESTED" })));
      }
      if (String(input).includes("/issues/13/comments")) {
        return Response.json({ html_url: "https://github.com/owner/repo/pull/13#comment" });
      }
      throw new Error(`Unexpected GitHub request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linearFetch = vi.fn(async () =>
      Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const daytona = { get: vi.fn() } as unknown as Daytona;
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const labeled = JSON.stringify({
      action: "labeled",
      label: { name: "needs-review" },
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 13,
        html_url: "https://github.com/owner/repo/pull/13",
        merged: false,
        head: { ref: "ot/ot-cap", sha: "abc" },
        base: { ref: "main" },
      },
    });

    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(labeled, "github-cap", "pull_request"),
      body: labeled,
    });
    await Promise.all(background.splice(0));

    expect(daytona.get).not.toHaveBeenCalled();
    expect(store.getByIssueId("issue-cap")?.run_id).toBeNull();
    expect(githubFetch.mock.calls.some(([input]) => String(input).includes("/comments"))).toBe(true);
  });

  it("serves sanitized logs and a signed workspace preview to authorized operators", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-operator",
      linear_issue_identifier: "OT-OPERATOR",
      linear_session_id: "session-operator",
      sandbox_id: "sandbox-operator",
      branch: "ot/ot-operator",
      agent: "claude",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const previewToken = "preview-token";
    store.setPreviewTokenHash(
      "issue-operator",
      createHash("sha256").update(previewToken).digest("hex")
    );
    const sandbox = {
      state: "started",
      process: {
        getEntrypointLogs: vi.fn(async () => ({ output: "safe ghp_abcdefghijklmnop" })),
      },
      getSignedPreviewUrl: vi.fn(async () => ({ url: "https://preview.test/signed" })),
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const app = createServer({ cfg, store, daytona, getLinearClient: async () => undefined });

    const logsResponse = await app.request("/tickets/OT-OPERATOR/logs", {
      headers: { Authorization: `Bearer ${cfg.statusToken}` },
    });
    expect(logsResponse.status).toBe(200);
    expect(await logsResponse.text()).toBe("safe [REDACTED]");

    const previewResponse = await app.request(`/preview/OT-OPERATOR?token=${previewToken}`);
    expect(previewResponse.status).toBe(302);
    expect(previewResponse.headers.get("location")).toBe("https://preview.test/signed");

    store.beginRun({
      issueId: "issue-operator",
      runId: "run-operator",
      taskType: "implement",
      tokenHash: "unused",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.finishRun({
      runId: "run-operator",
      status: "completed",
      logTail: "durable ghp_abcdefghijklmnop",
    });
    store.setSandboxId("issue-operator", null);

    const durableLogsResponse = await app.request("/tickets/OT-OPERATOR/logs", {
      headers: { Authorization: `Bearer ${cfg.statusToken}` },
    });
    expect(durableLogsResponse.status).toBe(200);
    expect(await durableLogsResponse.text()).toBe("durable [REDACTED]");
  });

  it("merges from Linear only after GitHub reports terminal green checks", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-merge",
      linear_issue_identifier: "OT-MERGE",
      linear_session_id: "session-merge",
      sandbox_id: "sandbox-merge",
      branch: "ot/ot-merge",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/14",
      state: "active",
    });
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/14")) {
        return Response.json({ mergeable: true, draft: false, head: { sha: "head-sha" } });
      }
      if (url.includes("/check-runs")) {
        return Response.json({
          check_runs: [{ status: "completed", conclusion: "success" }],
        });
      }
      if (url.endsWith("/pulls/14/merge") && init?.method === "PUT") {
        return Response.json({ merged: true, message: "merged" });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linearRequests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      linearRequests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg: { ...cfg, allowLinearMerge: true },
      store,
      daytona: {} as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const prompted = JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: "linear-merge",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: {
        id: "session-merge",
        issue: {
          id: "issue-merge",
          identifier: "OT-MERGE",
          team: { id: "team-1", key: "OT" },
          labels: [],
        },
      },
      agentActivity: { id: "prompt-merge", content: { type: "prompt", body: "/merge" } },
    });

    await app.request("/webhooks/linear", {
      method: "POST",
      headers: signedLinear(prompted, "linear-merge"),
      body: prompted,
    });
    await Promise.all(background.splice(0));

    expect(
      githubFetch.mock.calls.some(
        ([input, init]) => String(input).endsWith("/pulls/14/merge") && init?.method === "PUT"
      )
    ).toBe(true);
    expect(linearRequests.some((request) => request.includes("Merged"))).toBe(true);
  });

  it("restores active mode when a new run starts during the prior run's idle transition", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-idle-race",
      linear_issue_identifier: "OT-IDLE-RACE",
      linear_session_id: "session-idle-race",
      sandbox_id: "sandbox-idle-race",
      branch: "ot/ot-idle-race",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const callbackToken = "callback-idle-race";
    store.beginRun({
      issueId: "issue-idle-race",
      runId: "run-idle-race",
      taskType: "implement",
      tokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    let releaseIdle!: () => void;
    const idleReleased = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    let markIdleStarted!: () => void;
    const idleStarted = new Promise<void>((resolve) => {
      markIdleStarted = resolve;
    });
    const autostopIntervals: number[] = [];
    const sandbox = {
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async (minutes: number) => {
        autostopIntervals.push(minutes);
        if (minutes === 5) {
          markIdleStarted();
          await idleReleased;
        }
        sandbox.autoStopInterval = minutes;
      }),
    };
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      getLinearClient: async () => undefined,
      runBackground: (task) => background.push(task),
    });

    const completion = app.request("/runs/run-idle-race/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({ exit_code: 0 }),
    });
    await idleStarted;
    store.beginRun({
      issueId: "issue-idle-race",
      runId: "run-after-idle-race",
      taskType: "resume",
      tokenHash: createHash("sha256").update("next-token").digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    releaseIdle();

    expect((await completion).status).toBe(200);
    await Promise.all(background.splice(0));
    expect(autostopIntervals).toEqual([5, 60]);
    expect(sandbox.autoStopInterval).toBe(60);
  });

  it("preserves a failed run completion when Daytona cannot mark its sandbox idle", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-idle-failure",
      linear_issue_identifier: "OT-IDLE-FAILURE",
      linear_session_id: "session-idle-failure",
      sandbox_id: "sandbox-idle-failure",
      branch: "ot/ot-idle-failure",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const callbackToken = "callback-idle-failure";
    store.beginRun({
      issueId: "issue-idle-failure",
      runId: "run-idle-failure",
      taskType: "implement",
      tokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const setAutostopInterval = vi.fn(async () => {
      throw new Error("Daytona unavailable");
    });
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: {
        get: vi.fn(async () => ({ autoStopInterval: 60, setAutostopInterval })),
      } as unknown as Daytona,
      getLinearClient: async () => undefined,
      runBackground: (task) => background.push(task),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await app.request("/runs/run-idle-failure/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({ exit_code: 1 }),
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(setAutostopInterval).toHaveBeenCalledWith(5);
    expect(store.getRun("run-idle-failure")?.status).toBe("failed");
    expect(store.getByIssueId("issue-idle-failure")).toMatchObject({
      run_id: null,
      state: "error",
    });
  });

  it("starts a fresh review after a successful review-fix callback despite a Linear notification outage", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-rereview",
      linear_issue_identifier: "OT-REREVIEW",
      linear_session_id: "session-rereview",
      sandbox_id: "sandbox-rereview",
      branch: "ot/ot-rereview",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/15",
      state: "active",
    });
    const callbackToken = "callback-rereview";
    store.beginRun({
      issueId: "issue-rereview",
      runId: "run-rereview",
      taskType: "review-fix",
      tokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const setAutostopInterval = vi.fn(async (_minutes: number) => undefined);
    const sandbox = {
      state: "started",
      setAutostopInterval,
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ state: "CHANGES_REQUESTED" }]))
    );
    let activityAttempts = 0;
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const query = String(JSON.parse(String(init?.body)).query);
      if (query.includes("AgentActivityCreate") && activityAttempts++ === 0) {
        return Response.json({ errors: [{ message: "Linear unavailable" }] });
      }
      return Response.json({
        data: query.includes("AgentSessionUpdate")
          ? { agentSessionUpdate: { success: true } }
          : { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });

    const response = await app.request("/runs/run-rereview/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({
        exit_code: 0,
        pr_url: "https://github.com/owner/repo/pull/15",
      }),
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(activityAttempts).toBe(1);
    expect(store.listLinearOutbox()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", kind: "activity" }),
        expect.objectContaining({ status: "pending", kind: "session_update" }),
      ])
    );
    expect(setAutostopInterval.mock.calls.map(([minutes]) => minutes)).toEqual([5, 60]);
    expect(envUpdates.at(-1)).toMatchObject({ TASK_TYPE: "review", PR_NUMBER: "15" });
    const ticket = store.getByIssueId("issue-rereview")!;
    expect(ticket.run_id).not.toBe("run-rereview");
    expect(store.getRun(ticket.run_id!)?.task_type).toBe("review");
  });

  it("publishes captured final assistant output instead of a generic success response", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-final",
      linear_issue_identifier: "OT-FINAL",
      linear_session_id: "session-final",
      sandbox_id: "sandbox-final",
      branch: "ot/ot-final",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const token = "callback-final";
    store.beginRun({
      issueId: "issue-final",
      runId: "run-final",
      taskType: "implement",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const requests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const app = createServer({
      cfg,
      store,
      daytona: {} as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
    });

    const response = await app.request("/runs/run-final/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ exit_code: 0, final_response: "Implemented the requested fix." }),
    });

    expect(response.status).toBe(200);
    expect(requests.some((request) => request.includes("Implemented the requested fix."))).toBe(true);
    expect(requests.some((request) => request.includes("finished successfully"))).toBe(false);
  });

  it("does not overwrite an agent elicitation with a generic success response", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-elicitation",
      linear_issue_identifier: "OT-ELICIT",
      linear_session_id: "session-elicitation",
      sandbox_id: "sandbox-elicitation",
      branch: "ot/ot-elicit",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const token = "callback-elicitation";
    store.beginRun({
      issueId: "issue-elicitation",
      runId: "run-elicitation",
      taskType: "implement",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const eventId = "44444444-4444-4444-8444-444444444444";
    store.insertSandboxEvent({
      eventId,
      runId: "run-elicitation",
      sandboxId: "sandbox-elicitation",
      kind: "activity",
      payload: JSON.stringify({ type: "elicitation" }),
    });
    store.claimSandboxEvent(eventId, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    store.markSandboxEventProcessed(eventId);

    const requests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const app = createServer({
      cfg,
      store,
      daytona: {
        get: vi.fn(async () => ({
          setAutostopInterval: vi.fn(async () => undefined),
        })),
      } as unknown as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
    });

    const response = await app.request("/runs/run-elicitation/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ exit_code: 0 }),
    });

    expect(response.status).toBe(200);
    expect(requests.some((request) => request.includes("finished successfully"))).toBe(false);
  });

  it("defers the fresh re-review while a review-fix run ends paused on a decision elicitation", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-paused",
      linear_issue_identifier: "OT-PAUSED",
      linear_session_id: "session-paused",
      sandbox_id: "sandbox-paused",
      branch: "ot/ot-paused",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/21",
      state: "active",
    });
    const callbackToken = "callback-paused";
    store.beginRun({
      issueId: "issue-paused",
      runId: "run-paused",
      taskType: "review-fix",
      tokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const eventId = "55555555-5555-4555-8555-555555555555";
    store.insertSandboxEvent({
      eventId,
      runId: "run-paused",
      sandboxId: "sandbox-paused",
      kind: "activity",
      payload: JSON.stringify({ type: "elicitation", body: "Decision needed on the schema change." }),
    });
    store.claimSandboxEvent(eventId, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    store.markSandboxEventProcessed(eventId);
    store.enqueueSessionWork({
      id: "gh-comment-777",
      linearSessionId: "session-paused",
      issueId: "issue-paused",
      source: "automatic",
      body: "New PR feedback queued while the review-fix was running.",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const linearFetch = vi.fn(async () =>
      Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });

    const response = await app.request("/runs/run-paused/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({
        exit_code: 0,
        pr_url: "https://github.com/owner/repo/pull/21",
      }),
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(envUpdates).toEqual([]);
    const ticket = store.getByIssueId("issue-paused")!;
    expect(ticket.run_id).toBeNull();
    expect(ticket.pending_re_review).toBe(1);
    expect(
      store.claimNextSessionWork("session-paused", new Date().toISOString())
    ).toMatchObject({ id: "gh-comment-777", status: "claimed" });
  });

  it("starts the deferred re-review after the resumed session answers the decisions", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-deferred",
      linear_issue_identifier: "OT-DEFERRED",
      linear_session_id: "session-deferred",
      sandbox_id: "sandbox-deferred",
      branch: "ot/ot-deferred",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/22",
      state: "active",
    });
    store.setPendingReReview("issue-deferred", true);
    const callbackToken = "callback-deferred";
    store.beginRun({
      issueId: "issue-deferred",
      runId: "run-deferred",
      taskType: "resume",
      tokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ state: "CHANGES_REQUESTED" }]))
    );
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const query = String(JSON.parse(String(init?.body)).query);
      return Response.json({
        data: query.includes("AgentSessionUpdate")
          ? { agentSessionUpdate: { success: true } }
          : { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });

    const response = await app.request("/runs/run-deferred/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackToken}`,
      },
      body: JSON.stringify({ exit_code: 0 }),
    });
    await Promise.all(background.splice(0));

    expect(response.status).toBe(200);
    expect(envUpdates.at(-1)).toMatchObject({ TASK_TYPE: "review", PR_NUMBER: "22" });
    const ticket = store.getByIssueId("issue-deferred")!;
    expect(ticket.pending_re_review).toBe(0);
    expect(ticket.run_id).not.toBe("run-deferred");
    expect(store.getRun(ticket.run_id!)?.task_type).toBe("review");
  });

  it("actions a commented review from another account by starting review-fix", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-commented",
      linear_issue_identifier: "OT-COMMENTED",
      linear_session_id: "session-commented",
      sandbox_id: "sandbox-commented",
      branch: "ot/ot-commented",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/31",
      state: "active",
    });
    const envUpdates: Array<Record<string, string>> = [];
    const sandbox = {
      state: "started",
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async (env: Record<string, string>) => {
        envUpdates.push(env);
      }),
      fs: {
        uploadFile: vi.fn(async () => undefined),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => undefined),
      },
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "openthrottle-bot" });
      if (url.includes("/reviews")) return Response.json([]);
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linearFetch = vi.fn(async () =>
      Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const commented = JSON.stringify({
      action: "submitted",
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 31,
        html_url: "https://github.com/owner/repo/pull/31",
        merged: false,
        head: { ref: "ot/ot-commented", sha: "abc" },
        base: { ref: "main" },
      },
      review: {
        id: 77,
        state: "commented",
        body: "The retry loop swallows the original error.",
        html_url: "https://github.com/owner/repo/pull/31#pullrequestreview-77",
        user: { login: "codex-review-bot" },
      },
    });

    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(commented, "github-commented-review", "pull_request_review"),
      body: commented,
    });
    await Promise.all(background.splice(0));

    expect(envUpdates.at(-1)).toMatchObject({ TASK_TYPE: "review-fix", PR_NUMBER: "31" });
    const ticket = store.getByIssueId("issue-commented")!;
    expect(store.getRun(ticket.run_id!)?.task_type).toBe("review-fix");
  });

  it("queues PR comment feedback while a run is active and ignores the agent's own comments", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    store.upsert({
      linear_issue_id: "issue-comment",
      linear_issue_identifier: "OT-COMMENT",
      linear_session_id: "session-comment",
      sandbox_id: "sandbox-comment",
      branch: "ot/ot-comment",
      agent: "claude",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/32",
      state: "active",
    });
    store.beginRun({
      issueId: "issue-comment",
      runId: "run-busy",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "openthrottle-bot" });
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linearFetch = vi.fn(async () =>
      Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      })
    ) as unknown as typeof fetch;
    const background: Array<Promise<void>> = [];
    const app = createServer({
      cfg,
      store,
      daytona: {} as Daytona,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: linearFetch }),
      runBackground: (task) => background.push(task),
    });
    const commentEvent = (id: number, login: string, body: string) =>
      JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 32, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/32" } },
        comment: {
          id,
          body,
          html_url: `https://github.com/owner/repo/pull/32#issuecomment-${id}`,
          user: { login },
        },
      });

    const human = commentEvent(901, "human-dev", "Can we also cover the empty-cart case?");
    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(human, "github-pr-comment", "issue_comment"),
      body: human,
    });
    const own = commentEvent(902, "openthrottle-bot", "Review verdict: merge-ready.");
    await app.request("/webhooks/github", {
      method: "POST",
      headers: signedGithub(own, "github-own-comment", "issue_comment"),
      body: own,
    });
    await Promise.all(background.splice(0));

    const queued = store.claimNextSessionWork("session-comment", new Date().toISOString());
    expect(queued).toMatchObject({ id: "gh-comment-901", source: "automatic" });
    expect(queued?.body).toContain("empty-cart");
    expect(queued?.body).toContain("https://github.com/owner/repo/pull/32#issuecomment-901");
    expect(store.claimNextSessionWork("session-comment", new Date().toISOString())).toBeUndefined();
  });
});
