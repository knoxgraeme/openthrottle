import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdmissionPreflight,
  runAdmissionPreflight,
  type AdmissionPreflight,
} from "./admission-preflight.js";
import type { Config } from "./config.js";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { handleLinearEvent } from "./session-service.js";
import type { LinearClient } from "../providers/linear/client.js";
import { fetchIssueLabels, parseLinearWebhook } from "../providers/linear/events.js";
import {
  branchExists,
  getMergeReadiness,
  getRepositoryConfigAtCommit,
  mergePullRequest,
  parsePullRequestUrl,
} from "../providers/github/client.js";
import { createLinearActivityPublisher } from "../providers/linear/outbox.js";
import { loadPipelineCatalog } from "../pipeline/manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor } from "../runtime/contracts.js";

const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));

const target = { repository: "owner/repo", baseCommit: "a".repeat(40) };

function readCheckDeps(overrides: Partial<Parameters<typeof runAdmissionPreflight>[0]> = {}) {
  return { githubReadToken: "read-token", ...overrides };
}

describe("runAdmissionPreflight", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects with an actionable message when the read token cannot read the repo", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const verdict = await runAdmissionPreflight(readCheckDeps({ fetch: fetchMock }), target);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected rejection");
    expect(verdict.reason).toContain("GITHUB_READ_TOKEN cannot read owner/repo (HTTP 403)");
    expect(verdict.reason).toContain("Contents: Read");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/owner/repo/git/trees/${"a".repeat(40)}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer read-token");
  });

  it("names the token env var for invalid (401) and invisible (404) repos", async () => {
    for (const [status, hint] of [
      [401, "invalid or expired"],
      [404, "cannot see the repository"],
    ] as const) {
      const verdict = await runAdmissionPreflight(
        readCheckDeps({ fetch: async () => new Response("nope", { status }) }),
        target
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("expected rejection");
      expect(verdict.reason).toContain(`GITHUB_READ_TOKEN cannot read owner/repo (HTTP ${status})`);
      expect(verdict.reason).toContain(hint);
    }
  });

  it("proceeds when the read token can read the pinned tree", async () => {
    const verdict = await runAdmissionPreflight(
      readCheckDeps({ fetch: async () => Response.json({ sha: target.baseCommit, tree: [] }) }),
      target
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("does not block admission on an indeterminate read check (network error, 5xx)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const fetchImpl of [
      async () => {
        throw new Error("socket hang up");
      },
      async () => new Response("oops", { status: 500 }),
    ]) {
      const verdict = await runAdmissionPreflight(
        readCheckDeps({ fetch: fetchImpl as unknown as typeof fetch }),
        target
      );
      expect(verdict).toEqual({ ok: true });
    }
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("rejects when one more sandbox would exceed the org memory quota", async () => {
    const verdict = await runAdmissionPreflight(
      readCheckDeps({
        fetch: async () => Response.json({ tree: [] }),
        listSandboxes: async () => [
          { state: "started", memory: 8 },
          { state: "destroyed", memory: 8 }, // deleted: must not count
        ],
        totalMemoryGib: 10,
        sandboxMemoryGib: 8,
      }),
      target
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected rejection");
    expect(verdict.reason).toContain("Daytona capacity: 8 GiB of 10 GiB");
    expect(verdict.reason).toContain("org memory quota");
  });

  it("admits while the quota still fits another sandbox", async () => {
    const verdict = await runAdmissionPreflight(
      readCheckDeps({
        fetch: async () => Response.json({ tree: [] }),
        listSandboxes: async () => [{ state: "stopped", memory: 2 }],
        totalMemoryGib: 10,
        sandboxMemoryGib: 8,
      }),
      target
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("proceeds when the capacity listing itself fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const verdict = await runAdmissionPreflight(
      readCheckDeps({
        fetch: async () => Response.json({ tree: [] }),
        listSandboxes: async () => {
          throw new Error("runtime API is down");
        },
        totalMemoryGib: 10,
        sandboxMemoryGib: 8,
      }),
      target
    );
    expect(verdict).toEqual({ ok: true });
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe("admission preflight wired into Linear admission", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    db?.close();
  });

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
      githubToken: "github-write-token",
      githubReadToken: "github-read-token",
      daytonaApiKey: "runtime",
      daytonaSnapshot: "snapshot",
      daytonaTotalMemoryGib: 10,
      daytonaSandboxMemoryGib: 8,
      defaultAgent: "codex",
      claudeCodeOauthToken: undefined,
      codexAuthJson: "{}",
      kimiCodeApiKey: undefined,
      taskTimeout: 300,
      orphanGraceMinutes: 5,
      webhookMaxAgeSeconds: 60,
      allowLinearMerge: false,
      sandboxEventPollIntervalMs: 5_000,
      stallTimeoutSeconds: 900,
      pipelineCatalogPath: shippedCatalogPath,
      sandboxRuntimeRelease: "preflight-test/v1",
      sandboxRuntimeDescriptorPath: "pipelines/runtime-capabilities-v1.json",
    };
  }

  function payload(sessionId = "session-1") {
    return parseLinearWebhook(JSON.stringify({
      action: "created",
      type: "AgentSessionEvent",
      webhookId: "admission-preflight",
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

  async function admit(options: {
    preflight?: AdmissionPreflight;
    treesStatus?: number;
  }) {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    tickets.registerRepository({
      linearTeamKey: "OT",
      linearTeamId: "team-1",
      githubRepo: "owner/repo",
      baseBranch: "main",
      webhookId: 1,
      snapshot: "snapshot",
    });
    const runtime = buildInstalledRuntimeDescriptor("preflight-test/v1");
    const catalog = loadPipelineCatalog(shippedCatalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const repositoryConfig = "pipelines: { implement: implement }\n";
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
      if (url.includes(`/repos/owner/repo/git/trees/${"a".repeat(40)}`)) {
        const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (token !== "Bearer github-read-token") {
          throw new Error(`trees preflight used the wrong token: ${String(token)}`);
        }
        return new Response("{}", { status: options.treesStatus ?? 200 });
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
    const providers = {
      activityPublisher: createLinearActivityPublisher(tickets, outbox),
      labelResolver: {
        fetchIssueLabels: (issueId: string) => fetchIssueLabels(linear, issueId),
      },
      repositoryReader: {
        branchExists: (repository: string, branch: string) =>
          branchExists({ token: "github-token" }, repository, branch),
        getRepositoryConfigAtCommit: (repository: string, branch: string) =>
          getRepositoryConfigAtCommit({ token: "github-token" }, repository, branch),
      },
      merger: {
        parsePullRequestUrl,
        getMergeReadiness: (repo: string, pullNumber: number) =>
          getMergeReadiness({ token: "github-token" }, repo, pullNumber),
        mergePullRequest: (repo: string, pullNumber: number, expectedHeadSha: string) =>
          mergePullRequest({ token: "github-token" }, repo, pullNumber, expectedHeadSha),
      },
    };
    await handleLinearEvent(
      config(),
      tickets,
      providers,
      payload(),
      { catalog, runtime, store: pipelines },
      options.preflight
    );
    return { tickets, pipelines, githubFetch };
  }

  const cfgPreflight = (runtime: Parameters<typeof createAdmissionPreflight>[1]) =>
    createAdmissionPreflight(config(), runtime);
  const emptyDaytona = {
    listLabeledResources: async () => [],
  };

  it("rejects admission before any pipeline instance when the read token 403s", async () => {
    const { tickets, githubFetch } = await admit({
      preflight: cfgPreflight(emptyDaytona),
      treesStatus: 403,
    });

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_stage_attempts").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) =>
      entry.includes("GITHUB_READ_TOKEN cannot read owner/repo (HTTP 403)") &&
      entry.includes("Contents: Read")
    )).toBe(true);
    // Selection used the write token; the preflight probed with the read token.
    expect(githubFetch).toHaveBeenCalledTimes(3);
  });

  it("pins the pipeline when the read token can read and capacity fits", async () => {
    const { tickets, pipelines } = await admit({ preflight: cfgPreflight(emptyDaytona) });

    expect(tickets.getByIssueId("issue-1")).toMatchObject({ state: "active" });
    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: "core/implement",
      base_commit: "a".repeat(40),
    });
  });

  it("rejects admission when the org memory quota is exhausted", async () => {
    const fullDaytona = {
      listLabeledResources: async () => [{ id: "sb-1", state: "started", memory: 8 }],
      deleteResource: vi.fn(async () => undefined),
    };

    const { tickets } = await admit({ preflight: cfgPreflight(fullDaytona) });

    expect(tickets.getByIssueId("issue-1")).toMatchObject({ state: "error" });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("Daytona capacity: 8 GiB of 10 GiB"))).toBe(true);
  });

  it("admits when the capacity probe is broken instead of blocking delegation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const brokenDaytona = {
      listLabeledResources: () => {
        throw new Error("runtime listing exploded");
      },
      deleteResource: vi.fn(async () => undefined),
    };

    const { pipelines } = await admit({ preflight: cfgPreflight(brokenDaytona) });

    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({ pipeline_id: "core/implement" });
  });
});
