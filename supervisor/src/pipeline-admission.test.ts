import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { createTicketStore, openDb } from "./db.js";
import { handleLinearEvent } from "./linear-events.js";
import type { LinearClient } from "./linear.js";
import { parseLinearWebhook } from "./linear.js";
import { loadPipelineCatalog } from "./pipeline-manifest.js";
import { createPipelineStore } from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));

function config(): Config {
  return {
    port: 8080,
    databasePath: ":memory:",
    supervisorUrl: "https://ot.test",
    statusToken: "status",
    installSecret: "install",
    linearWebhookSecret: "linear",
    linearClientId: "client",
    linearClientSecret: "secret",
    githubWebhookSecret: "github-webhook",
    githubToken: "github-token",
    githubRepo: "owner/repo",
    githubRepoMappings: {},
    githubRepoLabelMappings: {},
    daytonaApiKey: "daytona",
    daytonaSnapshot: "snapshot",
    defaultAgent: "codex",
    claudeCodeOauthToken: undefined,
    codexAuthJson: "{}",
    kimiCodeApiKey: undefined,
    baseBranch: "main",
    maxTurns: 20,
    taskTimeout: 300,
    callbackGraceSeconds: 10,
    devPort: 3000,
    sweepMaxAgeDays: 14,
    orphanGraceMinutes: 5,
    webhookMaxAgeSeconds: 60,
    reviewMaxRounds: 3,
    reviewNudgeComment: "",
    allowLinearMerge: false,
    sandboxEventPollIntervalMs: 5_000,
    stallTimeoutSeconds: 900,
    pipelineAdmissionEnabled: true,
    pipelineCatalogPath: catalogPath,
    sandboxRuntimeRelease: "admission-test/v1",
    sandboxRuntimeDescriptorPath: "pipelines/runtime-capabilities-v1.json",
  };
}

function payload(sessionId = "session-1") {
  return parseLinearWebhook(JSON.stringify({
    action: "created",
    type: "AgentSessionEvent",
    webhookId: "pipeline-admission",
    webhookTimestamp: Date.now(),
    organizationId: "org",
    agentSession: {
      id: sessionId,
      issue: {
        id: "issue-1",
        identifier: "OT-1",
        team: { id: "team-1", key: "OT" },
        labels: [],
      },
    },
  }));
}

describe("pipeline admission", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    vi.unstubAllGlobals();
    db?.close();
  });

  async function run(repositoryConfig: string, overrides: Partial<Config> = {}) {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const runtime = buildInstalledRuntimeDescriptor("admission-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    let currentRepositoryConfig = repositoryConfig;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/commits/main")) {
        return Response.json({ sha: "a".repeat(40) });
      }
      if (url.includes("/contents/.openthrottle.yml?ref=")) {
        return Response.json({
          type: "file",
          sha: "b".repeat(40),
          encoding: "base64",
          content: Buffer.from(currentRepositoryConfig).toString("base64"),
          size: Buffer.byteLength(currentRepositoryConfig),
        });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    });
    vi.stubGlobal("fetch", githubFetch);
    const linear: LinearClient = {
      accessToken: "linear-token",
      fetch: vi.fn(async () => Response.json({
        data: { issue: { labels: { nodes: [] } } },
      })) as unknown as typeof fetch,
    };
    const outbox = {
      process: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    };
    const sandbox = {
      stop: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const invoke = async (
      overrides: Partial<Config> = {},
      event = payload()
    ) => handleLinearEvent(
      { ...config(), ...overrides },
      tickets,
      daytona,
      async () => linear,
      outbox,
      event,
      { catalog, runtime, store: pipelines }
    );
    await invoke(overrides);
    return {
      tickets,
      pipelines,
      githubFetch,
      invoke,
      daytona,
      sandbox,
      setRepositoryConfig(value: string) {
        currentRepositoryConfig = value;
      },
    };
  }

  it("pins a new generation and creates no legacy run or sandbox", async () => {
    const { tickets, pipelines, githubFetch } = await run(`
agent: codex
pipelines: { implement: implement }
limits: { max_turns: 20, task_timeout: 300 }
mcp_servers: {}
`);
    const ticket = tickets.getByIssueId("issue-1")!;
    const instance = pipelines.getInstanceForSession("session-1")!;
    expect(ticket.sandbox_id).toBeNull();
    expect(ticket.run_id).toBeNull();
    expect(instance.pipeline_id).toBe("ce/implement");
    expect(instance.task_type).toBe("implement");
    expect(instance.base_commit).toBe("a".repeat(40));
    expect(instance.base_branch).toBe("main");
    expect(pipelines.getStageRequest(pipelines.getActiveAttempt(instance.id)!.id).baseBranch).toBe("main");
    expect(pipelines.getActiveAttempt(instance.id)?.stage_id).toBe("planning");
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("publishes a durable actionable failure and creates no stage for an unknown selection", async () => {
    const { tickets } = await run("pipelines: { implement: unknown/pipeline@9 }\n");
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_stage_attempts").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_executions").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("unknown pipeline selection"))).toBe(true);
  });

  it("admits a command-only fixture without requiring a model subscription", async () => {
    const { tickets, pipelines } = await run(
      "pipelines: { implement: fixture-command }\n",
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined }
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "active",
      sandbox_id: null,
      run_id: null,
    });
    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: "fixture/command",
      pipeline_version: 2,
    });
  });

  it("keeps an existing session pinned when the admission flag changes", async () => {
    const { pipelines, githubFetch, invoke } = await run("pipelines: { implement: implement }\n");
    const before = pipelines.getInstanceForSession("session-1")!;
    expect(pipelines.getSessionExecutionMode("session-1")).toBe("pipeline");

    await invoke({ pipelineAdmissionEnabled: false });

    expect(pipelines.getInstanceForSession("session-1")).toEqual(before);
    expect(githubFetch).toHaveBeenCalledTimes(2);
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("routes a prompted stop through the pinned pipeline without starting legacy work", async () => {
    const { tickets, pipelines, invoke } = await run("pipelines: { implement: implement }\n");
    const instance = pipelines.getInstanceForSession("session-1")!;
    const prompted = parseLinearWebhook(JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: "pipeline-stop",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: { id: "session-1" },
      agentActivity: { id: "activity-stop", content: { type: "prompt", body: "/stop" } },
    }));

    await invoke({}, prompted);

    expect(pipelines.getInstance(instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "canceled",
    });
    expect(pipelines.listEffects(instance.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "provision", status: "dead" }),
      expect.objectContaining({ kind: "stop", status: "pending" }),
    ]));
    expect(db!.prepare("SELECT COUNT(*) FROM session_work").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_inbox").pluck().get()).toBe(0);
    expect(tickets.getByIssueId("issue-1")?.run_id).toBeNull();
  });

  it("rejects an idle pipeline reply instead of falling back to a legacy resume", async () => {
    const { pipelines, invoke } = await run("pipelines: { implement: implement }\n");
    const instance = pipelines.getInstanceForSession("session-1")!;
    const prompted = parseLinearWebhook(JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: "pipeline-reply",
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: { id: "session-1" },
      agentActivity: { id: "activity-reply", content: { type: "prompt", body: "keep going" } },
    }));

    await invoke({}, prompted);

    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_work").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_inbox").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("does not accept live steering"))).toBe(true);
  });

  it("never reuses an earlier pipeline workspace through the legacy launcher on re-delegation", async () => {
    const { tickets, pipelines, invoke, sandbox } = await run("pipelines: { implement: implement }\n");
    const previous = pipelines.getInstanceForSession("session-1")!;
    tickets.setSandboxId("issue-1", "sandbox-old");

    await invoke({}, payload("session-2"));

    const current = pipelines.getInstanceForSession("session-2")!;
    expect(current.id).not.toBe(previous.id);
    expect(pipelines.getSessionExecutionMode("session-2")).toBe("pipeline");
    expect(pipelines.getInstance(previous.id)).toMatchObject({
      status: "superseded",
      terminal_outcome: "superseded",
    });
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      linear_session_id: "session-2",
      sandbox_id: null,
      run_id: null,
    });
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(tickets.db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("does not retire the current generation when re-delegation selects an invalid pipeline", async () => {
    const { tickets, pipelines, invoke, sandbox, setRepositoryConfig } =
      await run("pipelines: { implement: implement }\n");
    const previous = pipelines.getInstanceForSession("session-1")!;
    tickets.setSandboxId("issue-1", "sandbox-old");
    setRepositoryConfig("pipelines: { implement: unknown/pipeline@9 }\n");

    await invoke({}, payload("session-2"));

    expect(pipelines.getInstance(previous.id)).toMatchObject({
      status: "dispatchable",
      terminal_outcome: null,
    });
    expect(pipelines.getInstanceForSession("session-2")).toBeUndefined();
    expect(pipelines.getSessionExecutionMode("session-2")).toBeUndefined();
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      linear_session_id: "session-1",
      sandbox_id: "sandbox-old",
      run_id: null,
    });
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });
});
