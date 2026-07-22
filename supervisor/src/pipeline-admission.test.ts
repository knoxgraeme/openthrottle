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

function payload() {
  return parseLinearWebhook(JSON.stringify({
    action: "created",
    type: "AgentSessionEvent",
    webhookId: "pipeline-admission",
    webhookTimestamp: Date.now(),
    organizationId: "org",
    agentSession: {
      id: "session-1",
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

  async function run(repositoryConfig: string) {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const runtime = buildInstalledRuntimeDescriptor("admission-test/v1");
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
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
          content: Buffer.from(repositoryConfig).toString("base64"),
          size: Buffer.byteLength(repositoryConfig),
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
    const invoke = async (overrides: Partial<Config> = {}) => handleLinearEvent(
      { ...config(), ...overrides },
      tickets,
      {} as Daytona,
      async () => linear,
      outbox,
      payload(),
      { catalog, runtime, store: pipelines }
    );
    await invoke();
    return { tickets, pipelines, githubFetch, invoke };
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
    expect(instance.base_commit).toBe("a".repeat(40));
    expect(pipelines.getActiveAttempt(instance.id)?.stage_id).toBe("implement");
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
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("unknown pipeline selection"))).toBe(true);
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
});
