import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { ActivityPublicationInput } from "./ports.js";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { handleLinearEvent } from "./session-service.js";
import type { LinearClient } from "../providers/linear/client.js";
import { fetchIssueLabels, parseLinearWebhook } from "../providers/linear/events.js";
import { routePipelineProviderEvent } from "../providers/github/events.js";
import {
  branchExists,
  getMergeReadiness,
  getRepositoryConfigAtCommit,
  getRepositoryDirectoryAtCommit,
  getRepositoryFileAtCommit,
  mergePullRequest,
  parsePullRequestUrl,
} from "../providers/github/client.js";
import { enqueueActivity, tryPostError } from "../providers/linear/outbox.js";
import { canonicalJson, digestNormalized, loadPipelineCatalog } from "../pipeline/manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";
import { coordinatePipelineEvent } from "../pipeline/coordinator.js";

const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const fixtureCatalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const executionPlanFixturePath = fileURLToPath(new URL("../../../contracts/fixtures/valid/execution-plan.json", import.meta.url));

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
    githubReadToken: "github-read-token",
    daytonaApiKey: "daytona",
    daytonaSnapshot: "snapshot",
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
    sandboxRuntimeRelease: "admission-test/v1",
    sandboxRuntimeDescriptorPath: "pipelines/runtime-capabilities-v1.json",
  };
}

function payload(
  sessionId = "session-1",
  issueId = "issue-1",
  identifier = "OT-1",
  promptContext?: string,
  labels: string[] = []
) {
  return parseLinearWebhook(JSON.stringify({
    action: "created",
    type: "AgentSessionEvent",
    webhookId: "pipeline-admission",
    webhookTimestamp: Date.now(),
    organizationId: "org",
    agentSession: {
      id: sessionId,
      issue: {
        id: issueId,
        identifier,
        team: { id: "team-1", key: "OT" },
        labels: labels.map((name) => ({ name })),
      },
    },
    ...(promptContext === undefined ? {} : { promptContext }),
  }));
}

function repositoryConfigYaml(pipelines: string, extra = ""): string {
  return `schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
pipelines: ${pipelines}
${extra}`;
}

describe("pipeline admission", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    vi.unstubAllGlobals();
    db?.close();
  });

  function promptedReply(body: string, activityId = "activity-reply", sessionId = "session-1") {
    return parseLinearWebhook(JSON.stringify({
      action: "prompted",
      type: "AgentSessionEvent",
      webhookId: `pipeline-reply-${activityId}`,
      webhookTimestamp: Date.now(),
      organizationId: "org",
      agentSession: { id: sessionId },
      agentActivity: { id: activityId, content: { type: "prompt", body } },
    }));
  }

  function moveToProviderWait(
    pipelines: ReturnType<typeof createPipelineStore>,
    head = "c".repeat(40),
    sessionId = "session-1"
  ) {
    const instance = pipelines.getInstanceForSession(sessionId)!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    db!.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(head, attempt.id);
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(head, head, instance.id);
    db!.prepare(`
      UPDATE pipeline_instance_stages SET status = 'passed'
      WHERE pipeline_instance_id = ? AND stage_id = 'implementation'
    `).run(instance.id);
    db!.prepare(`
      UPDATE pipeline_instance_stages SET status = 'waiting'
      WHERE pipeline_instance_id = ? AND stage_id = 'provider'
    `).run(instance.id);
    return pipelines.getInstance(instance.id)!;
  }

  function providerEvents() {
    return db!.prepare(`
      SELECT provider, provider_event_id, kind, payload FROM provider_events
      ORDER BY received_at, provider, provider_event_id
    `).all() as Array<{
      provider: string;
      provider_event_id: string;
      kind: string;
      payload: string;
    }>;
  }

  function completeActiveStage(
    pipelines: ReturnType<typeof createPipelineStore>,
    summary = "Implementation completed."
  ) {
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const payload = JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: "success",
      summary,
      evidence: [],
      findings: [],
      actions: [],
      uncertainty: [],
    });
    return coordinatePipelineEvent(pipelines, {
      id: `stage-result:${attempt.id}`,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: attempt.id,
      requestHash: attempt.request_hash,
      outcome: "success",
      resultHash: digestNormalized(payload),
      artifacts: [{
        kind: "stage_result",
        schemaVersion: 1,
        assurance: "semantic_attested",
        payload,
        hash: digestNormalized(payload),
      }],
    });
  }

  async function run(
    repositoryConfig: string,
    overrides: Partial<Config> = {},
    catalogPath = shippedCatalogPath,
    event = payload(),
    repositoryFiles: Record<string, string> = {},
    runtimeOverrides: Parameters<typeof buildInstalledRuntimeDescriptor>[1] = {}
  ) {
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
    const runtime = buildInstalledRuntimeDescriptor("admission-test/v1", runtimeOverrides);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    let currentRepositoryConfig = repositoryConfig;
    const githubFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/commits/main")) {
        return Response.json({ sha: "a".repeat(40) });
      }
      if (url.endsWith(`/repos/owner/repo/git/commits/${"a".repeat(40)}`)) {
        return Response.json({ tree: { sha: "e".repeat(40) } });
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
      if (url.includes(`/git/trees/${"e".repeat(40)}?recursive=1`)) {
        return Response.json({
          truncated: false,
          tree: Object.keys(repositoryFiles).sort().map((path) => ({
            path,
            mode: "100644",
            type: "blob",
            sha: "c".repeat(40),
            size: Buffer.byteLength(repositoryFiles[path]!),
          })),
        });
      }
      if (url.includes(`/git/blobs/${"c".repeat(40)}`)) {
        const skillEntry = Object.entries(repositoryFiles).find(([path]) => path.endsWith("/SKILL.md"));
        const content = skillEntry?.[1];
        if (content !== undefined) {
          return Response.json({
            sha: "c".repeat(40),
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            size: Buffer.byteLength(content),
          });
        }
      }
      const fileMatch = url.match(/\/contents\/([^?]+)\?ref=/);
      if (fileMatch) {
        const path = fileMatch[1]!.split("/").map(decodeURIComponent).join("/");
        const content = repositoryFiles[path];
        if (content !== undefined) {
          return Response.json({
            type: "file",
            sha: "c".repeat(40),
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            size: Buffer.byteLength(content),
          });
        }
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
      activityPublisher: {
        publishActivity: (activity: ActivityPublicationInput, issueId?: string, runId?: string) =>
          enqueueActivity(tickets, outbox, activity, issueId, runId),
        publishError: (sessionId: string | undefined, issueId: string | undefined, message: string) =>
          tryPostError(tickets, outbox, sessionId, issueId, message),
      },
      labelResolver: {
        fetchIssueLabels: (issueId: string) => fetchIssueLabels(linear, issueId),
      },
      repositoryReader: {
        branchExists: (repository: string, branch: string) =>
          branchExists({ token: "github-token" }, repository, branch),
        getRepositoryConfigAtCommit: (repository: string, branch: string) =>
          getRepositoryConfigAtCommit({ token: "github-token" }, repository, branch),
        getRepositoryFileAtCommit: (repository: string, commit: string, path: string) =>
          getRepositoryFileAtCommit({ token: "github-token" }, repository, commit, path),
        getRepositoryDirectoryAtCommit: (repository: string, commit: string, path: string) =>
          getRepositoryDirectoryAtCommit({ token: "github-token" }, repository, commit, path),
      },
      merger: {
        parsePullRequestUrl,
        getMergeReadiness: (repo: string, pullNumber: number) =>
          getMergeReadiness({ token: "github-token" }, repo, pullNumber),
        mergePullRequest: (repo: string, pullNumber: number, expectedHeadSha: string) =>
          mergePullRequest({ token: "github-token" }, repo, pullNumber, expectedHeadSha),
      },
    };
    const invoke = async (
      overrides: Partial<Config> = {},
      event = payload()
    ) => handleLinearEvent(
      { ...config(), ...overrides },
      tickets,
      providers,
      event,
      { catalog, runtime, store: pipelines }
    );
    await invoke(overrides, event);
    return {
      tickets,
      pipelines,
      githubFetch,
      invoke,
      setRepositoryConfig(value: string) {
        currentRepositoryConfig = value;
      },
    };
  }

  it("pins a new generation without a direct task run or sandbox", async () => {
    const { tickets, pipelines, githubFetch } = await run(`
schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
agent: codex
pipelines: { implement: implement }
limits: { max_turns: 20, task_timeout: 300 }
mcp_servers: {}
`);
    const ticket = tickets.getByIssueId("issue-1")!;
    const instance = pipelines.getInstanceForSession("session-1")!;
    expect(ticket.sandbox_id).toBeNull();
    expect(ticket.run_id).toBeNull();
    expect(instance.pipeline_id).toBe("core/implement");
    expect(instance.task_type).toBe("implement");
    expect(instance.base_commit).toBe("a".repeat(40));
    expect(instance.base_branch).toBe("main");
    expect(pipelines.getStageRequest(pipelines.getActiveAttempt(instance.id)!.id).baseBranch).toBe("main");
    expect(pipelines.getActiveAttempt(instance.id)?.stage_id).toBe("implementation");
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores legacy implement pipeline overrides when the simple graph is selected", async () => {
    const { tickets, pipelines } = await run(repositoryConfigYaml("{ implement: unknown/pipeline@9 }"));
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "active",
      sandbox_id: null,
      run_id: null,
    });
    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: "core/implement",
      pipeline_version: 4,
      active_stage_id: "implementation",
    });
    expect(db!.prepare("SELECT execution_mode FROM agent_sessions WHERE id = 'session-1'").pluck().get()).toBe("pipeline");
  });

  it("rejects a graph-specific pipeline override for a unit-consuming selection", async () => {
    const executionPlan = JSON.parse(readFileSync(executionPlanFixturePath, "utf8")) as Record<string, unknown>;
    executionPlan.graph_id = "structured";
    const context = [
      "# Structured work",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
      "",
      "```json openthrottle.ship-selection/v1",
      JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }, null, 2),
      "```",
    ].join("\n");

    await expectSelectionFailure(
      context,
      "graph structured requires unavailable runtime capability graph/for-each-unit@1"
    );
  });

  it("rejects the configured unit-consuming default even with a canonical plan", async () => {
    const executionPlan = JSON.parse(readFileSync(executionPlanFixturePath, "utf8")) as Record<string, unknown>;
    executionPlan.graph_id = "structured";
    const context = [
      "# Structured work",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
    ].join("\n");
    const { tickets } = await run(
      `schema: openthrottle.config/v1
default_graph: structured
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
  - id: structured
    kind: builtin
    ref: core/structured@1
pipelines: { implement: implement, structured: fixture-command }
intents:
  implement:
    default_graph: structured
    allowed_graphs: [simple, structured]
`,
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath,
      payload("session-1", "issue-1", "OT-1", context)
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_stage_attempts").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(
      payloads.some((entry) =>
        entry.includes("graph structured requires unavailable runtime capability graph/for-each-unit@1")
      )
    ).toBe(true);
  });

  async function expectSelectionFailure(context: string, expectedMessage: string) {
    const { tickets } = await run(
      `schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
  - id: structured
    kind: builtin
    ref: core/structured@1
pipelines: { implement: implement, structured: fixture-command }
intents:
  implement:
    default_graph: simple
    allowed_graphs: [simple, structured]
`,
      {},
      fixtureCatalogPath,
      payload("session-1", "issue-1", "OT-1", context)
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_stage_attempts").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes(expectedMessage))).toBe(true);
  }

  it("preserves the generated simple investigate intent when no graph is explicitly requested", async () => {
    const { pipelines } = await run(
      repositoryConfigYaml(
        "{ implement: implement, investigate: fixture-command }",
        "intents:\n  investigate:\n    default_graph: simple\n    allowed_graphs: [simple]\n"
      ),
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath,
      payload("session-1", "issue-1", "OT-1", undefined, ["investigate"])
    );

    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: "fixture/command",
      pipeline_version: 2,
    });
  });

  it("compiles and pins a structured graph before provisioning when the runtime advertises the composite capability", async () => {
    const executionPlan = JSON.parse(readFileSync(executionPlanFixturePath, "utf8")) as Record<string, unknown>;
    executionPlan.graph_id = "structured";
    const context = [
      "# Structured work",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
      "",
      "```json openthrottle.ship-selection/v1",
      JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }, null, 2),
      "```",
    ].join("\n");

    const { tickets, pipelines } = await run(
      `schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
  - id: structured
    kind: builtin
    ref: core/structured@1
pipelines: { implement: implement }
intents:
  implement:
    default_graph: simple
    allowed_graphs: [simple, structured]
`,
      {},
      shippedCatalogPath,
      payload("session-1", "issue-1", "OT-1", context),
      {},
      {
        capabilities: [
          ...buildInstalledRuntimeDescriptor("base-structured-test/v1").descriptor.capabilities,
          "graph/for-each-unit@1",
        ],
      }
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "active",
      sandbox_id: null,
      run_id: null,
    });
    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: "builtin/structured",
      pipeline_version: 1,
      active_stage_id: "units",
    });
    const attempt = pipelines.getActiveAttempt(pipelines.getInstanceForSession("session-1")!.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(request.capability).toBe("graph/for-each-unit@1");
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });
  it("rejects graph selections on investigate tickets before provisioning", async () => {
    const context = [
      "# Investigate structured behavior",
      "",
      "```json openthrottle.ship-selection/v1",
      JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "simple" }),
      "```",
    ].join("\n");
    const { tickets } = await run(
      repositoryConfigYaml("{ implement: implement, investigate: fixture-command }"),
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath,
      payload("session-1", "issue-1", "OT-1", context, ["investigate"])
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("graph selection is not supported for investigate tickets"))).toBe(true);
  });
  it("admits a pinned custom command-only graph without an execution plan", async () => {
    const graphPath = ".openthrottle/graphs/docs.json";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "raw-docs",
      version: 1,
      entry_node: "verify",
      workers: [
        {
          id: "commands",
          engine: "command",
          session_scope: "attempt",
          credentials: ["repo.read"],
          skills: ["builtin://commands@1"],
        },
      ],
      loops: [
        {
          id: "command_loop",
          worker: "commands",
          input_scope: "command",
          receipt: "command_result",
          max_parallel: 1,
          max_rounds: 1,
          skill: "builtin://commands@1",
          timeout_seconds: 60,
        },
      ],
      nodes: [
        {
          id: "verify",
          kind: "command",
          command: "docs-check",
          depends_on: [],
          transitions: {
            success: { terminal: "completed" },
            failure: { terminal: "failed" },
          },
        },
      ],
    });
    const { pipelines } = await run(
      `schema: openthrottle.config/v1
default_graph: docs
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
  - id: docs
    kind: repository
    ref: ${graphPath}
intents:
  implement:
    default_graph: docs
    allowed_graphs: [simple, docs]
commands:
  docs-check: "npm run docs:check"
`,
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath,
      payload(),
      { [graphPath]: graph }
    );

    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      pipeline_id: `repository/${digestNormalized(canonicalJson({
        graphId: "docs",
        blobSha: "c".repeat(40),
        path: graphPath,
      }))}`,
      pipeline_version: 1,
      active_stage_id: "verify",
    });
    const request = pipelines.getStageRequest(pipelines.getActiveAttempt(pipelines.getInstanceForSession("session-1")!.id)!.id);
    expect(request.commandName).toBe("docs-check");
  });

  it("binds repository graph manifest identity to the pinned source path", async () => {
    const graphA = ".openthrottle/graphs/docs-a.json";
    const graphB = ".openthrottle/graphs/docs-b.json";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "raw-docs",
      version: 1,
      entry_node: "verify",
      workers: [{
        id: "commands",
        engine: "command",
        session_scope: "attempt",
        credentials: ["repo.read"],
        skills: ["builtin://commands@1"],
      }],
      loops: [{
        id: "command_loop",
        worker: "commands",
        input_scope: "command",
        receipt: "command_result",
        max_parallel: 1,
        max_rounds: 1,
        skill: "builtin://commands@1",
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "verify",
        kind: "command",
        command: "docs-check",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          failure: { terminal: "failed" },
        },
      }],
    });
    const configFor = (graphId: string, graphPath: string) => `schema: openthrottle.config/v1
default_graph: ${graphId}
graphs:
  - id: ${graphId}
    kind: repository
    ref: ${graphPath}
intents:
  implement:
    default_graph: ${graphId}
    allowed_graphs: [${graphId}]
commands:
  docs-check: "npm run docs:check"
`;
    const { pipelines, invoke, setRepositoryConfig } = await run(
      configFor("docs_a", graphA),
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath,
      payload(),
      { [graphA]: graph, [graphB]: graph }
    );
    const first = pipelines.getInstanceForSession("session-1")!;
    setRepositoryConfig(configFor("docs_b", graphB));
    await invoke(
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      payload("session-2", "issue-2", "OT-2")
    );
    const second = pipelines.getInstanceForSession("session-2")!;

    expect(first.pipeline_id).toBe(`repository/${digestNormalized(canonicalJson({
      graphId: "docs_a",
      blobSha: "c".repeat(40),
      path: graphA,
    }))}`);
    expect(second.pipeline_id).toBe(`repository/${digestNormalized(canonicalJson({
      graphId: "docs_b",
      blobSha: "c".repeat(40),
      path: graphB,
    }))}`);
    expect(second.pipeline_id).not.toBe(first.pipeline_id);
  });

  it("pins repository skill packages and carries skill identity in the compiled request", async () => {
    const graphPath = ".openthrottle/graphs/repo-skill.json";
    const skillPath = ".agents/skills/implement-unit/SKILL.md";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "repo-skill-graph",
      version: 1,
      entry_node: "implementation",
      workers: [{
        id: "implementer",
        engine: "agent",
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read", "repo.write"],
        skills: ["repo://implement_unit"],
      }],
      loops: [{
        id: "implement_loop",
        worker: "implementer",
        input_scope: "graph",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        skill: "repo://implement_unit",
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "implementation",
        kind: "run",
        loop: "implement_loop",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          failure: { terminal: "failed" },
        },
      }],
    });
    const { pipelines, githubFetch } = await run(
      `schema: openthrottle.config/v1
default_graph: repo_skill
graphs:
  - id: repo_skill
    kind: repository
    ref: ${graphPath}
skills:
  - id: implement_unit
    path: .agents/skills/implement-unit
pipelines: { implement: implement }
intents:
  implement:
    default_graph: repo_skill
    allowed_graphs: [repo_skill]
`,
      {},
      shippedCatalogPath,
      payload(),
      {
        [graphPath]: graph,
        [skillPath]: "---\nname: implement-unit\n---\n# Implement Unit\n",
      },
      {
        capabilities: [
          ...buildInstalledRuntimeDescriptor("base-repository-skill-test/v1").descriptor.capabilities,
          "agent/repository-skill@1",
        ],
      }
    );

    const instance = pipelines.getInstanceForSession("session-1")!;
    expect(instance).toMatchObject({
      pipeline_id: `repository/${digestNormalized(canonicalJson({
        graphId: "repo_skill",
        blobSha: "c".repeat(40),
        path: graphPath,
      }))}`,
      active_stage_id: "implementation",
    });
    const request = pipelines.getStageRequest(pipelines.getActiveAttempt(instance.id)!.id);
    expect(request).toMatchObject({
      capability: "agent/repository-skill@1",
      repositorySkill: {
        reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
        invocation: "implement_unit",
        directory: ".agents/skills/implement-unit",
        commit: "a".repeat(40),
        files: [{
          path: skillPath,
          blobSha: "c".repeat(40),
        }],
      },
    });
    expect(request.repositorySkill?.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(githubFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/git/trees/${"e".repeat(40)}?recursive=1`),
      expect.anything()
    );
    expect(githubFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/git/blobs/${"c".repeat(40)}`),
      expect.anything()
    );
  });

  it("rejects repository skill graphs until production advertises agent/repository-skill@1", async () => {
    const graphPath = ".openthrottle/graphs/repo-skill.json";
    const skillPath = ".agents/skills/implement-unit/SKILL.md";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "repo-skill-graph",
      version: 1,
      entry_node: "implementation",
      workers: [{
        id: "implementer",
        engine: "agent",
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read"],
        skills: ["repo://implement_unit"],
      }],
      loops: [{
        id: "implement_loop",
        worker: "implementer",
        input_scope: "graph",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        skill: "repo://implement_unit",
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "implementation",
        kind: "run",
        loop: "implement_loop",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          failure: { terminal: "failed" },
        },
      }],
    });
    const { tickets } = await run(
      `schema: openthrottle.config/v1
default_graph: repo_skill
graphs:
  - id: repo_skill
    kind: repository
    ref: ${graphPath}
skills:
  - id: implement_unit
    path: .agents/skills/implement-unit
pipelines: { implement: implement }
intents:
  implement:
    default_graph: repo_skill
    allowed_graphs: [repo_skill]
`,
      {},
      shippedCatalogPath,
      payload(),
      {
        [graphPath]: graph,
        [skillPath]: "---\nname: implement-unit\n---\n# Implement Unit\n",
      }
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("runtime capability mismatch: capability:agent/repository-skill@1"))).toBe(true);
  });

  it("rejects repository skill packages whose SKILL.md name does not match the configured invocation", async () => {
    const graphPath = ".openthrottle/graphs/repo-skill.json";
    const skillPath = ".agents/skills/implement-unit/SKILL.md";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "repo-skill-graph",
      version: 1,
      entry_node: "implementation",
      workers: [{
        id: "implementer",
        engine: "agent",
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read", "repo.write"],
        skills: ["repo://implement_unit"],
      }],
      loops: [{
        id: "implement_loop",
        worker: "implementer",
        input_scope: "graph",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        skill: "repo://implement_unit",
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "implementation",
        kind: "run",
        loop: "implement_loop",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          failure: { terminal: "failed" },
        },
      }],
    });

    await run(
      `schema: openthrottle.config/v1
default_graph: repo_skill
graphs:
  - id: repo_skill
    kind: repository
    ref: ${graphPath}
skills:
  - id: implement_unit
    path: .agents/skills/implement-unit
pipelines: { implement: implement }
intents:
  implement:
    default_graph: repo_skill
    allowed_graphs: [repo_skill]
`,
      {},
      shippedCatalogPath,
      payload(),
      {
        [graphPath]: graph,
        [skillPath]: "---\nname: other_skill\n---\n# Implement Unit\n",
      },
      {
        capabilities: [
          ...buildInstalledRuntimeDescriptor("base-repository-skill-test/v1").descriptor.capabilities,
          "agent/repository-skill@1",
        ],
      }
    );

    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes(
      "repository skill implement_unit SKILL.md name does not match the configured invocation"
    ))).toBe(true);
  });

  it("rejects repository skill references that are not declared in repository config", async () => {
    const graphPath = ".openthrottle/graphs/repo-skill.json";
    const graph = JSON.stringify({
      schema: "openthrottle.graph/v1",
      id: "repo-skill-graph",
      version: 1,
      entry_node: "implementation",
      workers: [{
        id: "implementer",
        engine: "agent",
        session_scope: "fresh",
        credentials: ["model.invoke", "repo.read"],
        skills: ["repo://missing"],
      }],
      loops: [{
        id: "implement_loop",
        worker: "implementer",
        input_scope: "graph",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        skill: "repo://missing",
        timeout_seconds: 60,
      }],
      nodes: [{
        id: "implementation",
        kind: "run",
        loop: "implement_loop",
        depends_on: [],
        transitions: {
          success: { terminal: "completed" },
          failure: { terminal: "failed" },
        },
      }],
    });
    const { tickets } = await run(
      `schema: openthrottle.config/v1
default_graph: repo_skill
graphs:
  - id: repo_skill
    kind: repository
    ref: ${graphPath}
pipelines: { implement: implement }
intents:
  implement:
    default_graph: repo_skill
    allowed_graphs: [repo_skill]
`,
      {},
      shippedCatalogPath,
      payload(),
      { [graphPath]: graph }
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({ state: "error" });
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("workers.implementer.skills: references an undeclared repository skill"))).toBe(true);
  });
  it("fails closed before provisioning when a structured selection omits its execution plan", async () => {
    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }),
        "```",
      ].join("\n"),
      "graph structured requires a canonical openthrottle.execution-plan/v1 block"
    );
  });
  it("fails closed before provisioning for malformed shipped graph selections", async () => {
    const executionPlan = JSON.parse(readFileSync(executionPlanFixturePath, "utf8")) as Record<string, unknown>;
    executionPlan.graph_id = "structured";
    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ graph_id: "structured" }),
        "```",
      ].join("\n"),
      "openthrottle.ship-selection/v1.schema: must be openthrottle.ship-selection/v1"
    );

    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.ship-selection/v1",
        "{\"schema\":\"openthrottle.ship-selection/v1\",",
        "```",
      ].join("\n"),
      "SyntaxError"
    );

    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }),
        "```",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }),
        "```",
      ].join("\n"),
      "expected at most one openthrottle.ship-selection/v1 block"
    );

    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.execution-plan/v1",
        JSON.stringify(executionPlan, null, 2),
        "```",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "simple" }),
        "```",
      ].join("\n"),
      "ship selection graph_id simple does not match execution_plan.graph_id structured"
    );

    await expectSelectionFailure(
      [
        "# Structured work",
        "",
        "```json openthrottle.ship-selection/v1",
        JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "unknown" }),
        "```",
      ].join("\n"),
      "graph unknown is not allowed for implement"
    );
  });

  it("fails closed before provisioning when a shipped graph selection cannot resolve", async () => {
    const executionPlan = JSON.parse(readFileSync(executionPlanFixturePath, "utf8")) as Record<string, unknown>;
    executionPlan.graph_id = "structured";
    const context = [
      "# Structured work",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
      "```json openthrottle.ship-selection/v1",
      JSON.stringify({ schema: "openthrottle.ship-selection/v1", graph_id: "structured" }, null, 2),
      "```",
    ].join("\n");
    const { tickets } = await run(
      `schema: openthrottle.config/v1
default_graph: simple
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
  - id: structured
    kind: builtin
    ref: core/structured@1
pipelines: { implement: implement }
intents:
  implement:
    default_graph: simple
    allowed_graphs: [simple, structured]
`,
      {},
      shippedCatalogPath,
      payload("session-1", "issue-1", "OT-1", context)
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_stage_attempts").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(
      payloads.some((entry) =>
        entry.includes("graph structured requires unavailable runtime capability graph/for-each-unit@1")
      )
    ).toBe(true);
  });

  it("requires a model subscription for the simple graph despite legacy command pipeline overrides", async () => {
    const { tickets } = await run(
      repositoryConfigYaml("{ implement: fixture-command }"),
      { codexAuthJson: undefined, claudeCodeOauthToken: undefined, kimiCodeApiKey: undefined },
      fixtureCatalogPath
    );

    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      state: "error",
      sandbox_id: null,
      run_id: null,
    });
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
  });

  it("keeps an existing coordinator session pinned on a duplicate delegation", async () => {
    const { pipelines, githubFetch, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const before = pipelines.getInstanceForSession("session-1")!;
    expect(pipelines.getInstanceForSession("session-1")).toEqual(before);

    await invoke();

    expect(pipelines.getInstanceForSession("session-1")).toEqual(before);
    expect(githubFetch).toHaveBeenCalledTimes(2);
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("routes a prompted stop through the pinned pipeline", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
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
    expect(db!.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_work'").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_inbox").pluck().get()).toBe(0);
    expect(tickets.getByIssueId("issue-1")?.run_id).toBeNull();
  });

  it("rejects an idle pipeline reply instead of starting another task", async () => {
    const { pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const instance = pipelines.getInstanceForSession("session-1")!;
    const prompted = promptedReply("keep going");

    await invoke({}, prompted);

    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_work'").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM session_inbox").pluck().get()).toBe(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("does not accept live steering"))).toBe(true);
  });

  it("records a waiting-provider Linear reply as feedback and acknowledges the wakeup", async () => {
    const { pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const head = "c".repeat(40);
    moveToProviderWait(pipelines, head);

    await invoke({}, promptedReply("please fix the retry summary"));

    const events = providerEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "linear",
      provider_event_id: "linear-reply:activity-reply",
      kind: "pipeline_provider_event",
    });
    const stored = JSON.parse(events[0]!.payload) as { summary: string; evidence: string[]; payload: string };
    expect(stored.summary).toBe("Linear reply requires another implementation pass.");
    expect(stored.evidence).toEqual(["please fix the retry summary"]);
    expect(JSON.parse(stored.payload)).toMatchObject({
      kind: "linear_reply",
      activity_id: "activity-reply",
      body: "please fix the retry summary",
    });
    expect(pipelines.getInstanceForSession("session-1")).toMatchObject({
      status: "dispatchable",
      active_stage_id: "repair_implementation",
    });
    expect(db!.prepare("SELECT COUNT(*) FROM feedback_snapshots WHERE status = 'consumed'").pluck().get()).toBe(1);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("Waking the run to address your message in the honest ledger."))).toBe(true);
    expect(payloads.some((entry) => entry.includes("does not accept live steering"))).toBe(false);
  });

  it("sanitizes and bounds waiting-provider Linear reply feedback", async () => {
    const { pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    moveToProviderWait(pipelines);
    const body = `please inspect sk-${"a".repeat(24)} ${"x".repeat(2_500)}`;

    await invoke({}, promptedReply(body, "activity-long"));

    const [event] = providerEvents();
    const stored = JSON.parse(event!.payload) as { evidence: string[]; payload: string };
    const payloadBody = (JSON.parse(stored.payload) as { body: string }).body;
    expect(stored.evidence[0]).toHaveLength(1_000);
    expect(payloadBody).toHaveLength(2_000);
    expect(stored.evidence[0]).toContain("[REDACTED]");
    expect(payloadBody).toContain("[REDACTED]");
    expect(stored.evidence[0]).not.toContain("sk-");
    expect(payloadBody).not.toContain("sk-");
  });

  it("processes the Linear reply snapshot even when another provider-ready instance is older", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    const oldInstance = moveToProviderWait(pipelines, oldHead);
    const oldSnapshot = tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:older",
      issueId: oldInstance.linear_issue_id,
      sessionId: oldInstance.linear_session_id,
      generation: oldInstance.generation,
      repository: oldInstance.repository,
      pullNumber: 1,
      headSha: oldHead,
      kind: "pipeline_provider_event",
      payload: canonicalJson({
        outcome: "semantic_repair_required",
        summary: "Older feedback",
        evidence: ["older feedback"],
        payload: "{}",
      }),
      workItemId: `pipeline-feedback:${oldInstance.id}:${oldHead}`,
    }).snapshot;

    await invoke({}, payload("session-2", "issue-2", "OT-2"));
    const currentInstance = moveToProviderWait(pipelines, newHead, "session-2");

    await invoke({}, promptedReply("wake this specific run", "activity-specific", "session-2"));

    expect(db!.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(oldSnapshot.id))
      .toEqual({ status: "collecting" });
    expect(pipelines.getInstance(currentInstance.id)).toMatchObject({
      status: "dispatchable",
      active_stage_id: "repair_implementation",
    });
    expect(providerEvents().map((event) => `${event.provider}:${event.provider_event_id}`).sort()).toEqual([
      "github:github-review:older",
      "linear:linear-reply:activity-specific",
    ]);
  });

  it("deduplicates a redelivered waiting-provider Linear reply by activity id", async () => {
    const { pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    moveToProviderWait(pipelines);
    const prompted = promptedReply("same delivery", "activity-redelivered");

    await invoke({}, prompted);
    moveToProviderWait(pipelines);
    await invoke({}, prompted);

    expect(providerEvents()).toHaveLength(1);
    expect(db!.prepare("SELECT COUNT(*) FROM feedback_snapshots").pluck().get()).toBe(1);
  });

  it("coalesces pending GitHub feedback and a waiting-provider Linear reply into one repair snapshot", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const head = "d".repeat(40);
    const instance = pipelines.getInstanceForSession("session-1")!;
    tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    tickets.setSetting("github-head:issue-1", head);
    db!.prepare("UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?")
      .run(head, instance.id);

    expect(routePipelineProviderEvent({
      pipelines,
      store: tickets,
      ticket: tickets.getByIssueId("issue-1")!,
      eventId: "github-review:77",
      outcome: "semantic_repair_required",
      summary: "GitHub review requires another implementation pass.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-77"],
      payload: { kind: "pull_request_review", id: 77 },
      headSha: head,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);

    moveToProviderWait(pipelines, head);
    await invoke({}, promptedReply("also fix the Linear note", "activity-linear-join"));

    const events = providerEvents();
    expect(events.map((event) => `${event.provider}:${event.provider_event_id}`).sort()).toEqual([
      "github:github-review:77",
      "linear:linear-reply:activity-linear-join",
    ]);
    expect(db!.prepare("SELECT COUNT(*) FROM feedback_snapshots").pluck().get()).toBe(1);
    expect(db!.prepare("SELECT COUNT(*) FROM feedback_snapshots WHERE status = 'consumed'").pluck().get()).toBe(1);
    expect(pipelines.getActiveAttempt(instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("keeps a steerable running stage on the live-steer inbox path", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    pipelines.markStageDispatched(attempt.id);

    await invoke({}, promptedReply("please adjust the current stage", "activity-steer"));

    expect(providerEvents()).toHaveLength(0);
    expect(db!.prepare("SELECT id, body FROM session_inbox").get()).toEqual({
      id: "activity-steer",
      body: "please adjust the current stage",
    });
  });

  it("buffers a reply during a non-steerable running stage instead of rejecting it", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    completeActiveStage(pipelines);
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    expect(attempt.stage_id).toBe("semantic_review");
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    pipelines.markStageDispatched(attempt.id);

    await invoke({}, promptedReply("please carry this into the repair", "activity-buffered"));

    expect(providerEvents()).toHaveLength(0);
    expect(db!.prepare("SELECT id, run_id, body FROM session_inbox").get()).toEqual({
      id: "activity-buffered",
      run_id: null,
      body: "please carry this into the repair",
    });
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("Captured your message"))).toBe(true);
    expect(payloads.some((entry) => entry.includes("does not accept live steering"))).toBe(false);
  });

  it("rejects a waiting-provider reply for a just-terminal instance without feedback", async () => {
    const { pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const instance = moveToProviderWait(pipelines);
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human'
      WHERE id = ?
    `).run(instance.id);

    await invoke({}, promptedReply("can you still fix this?", "activity-terminal"));

    expect(providerEvents()).toHaveLength(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("does not accept live steering"))).toBe(true);
  });

  it("rejects a superseded-session reply without feedback", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const previous = moveToProviderWait(pipelines);
    tickets.setSandboxId("issue-1", "sandbox-old");
    await invoke({}, payload("session-2"));

    await invoke({}, promptedReply("old generation reply", "activity-superseded", "session-1"));

    expect(pipelines.getInstance(previous.id)).toMatchObject({
      status: "superseded",
      terminal_outcome: "superseded",
    });
    expect(providerEvents()).toHaveLength(0);
    const payloads = db!.prepare("SELECT payload FROM linear_outbox ORDER BY sequence").pluck().all() as string[];
    expect(payloads.some((entry) => entry.includes("couldn't find an existing workspace"))).toBe(true);
  });

  it("supersedes an earlier pipeline generation on re-delegation", async () => {
    const { tickets, pipelines, invoke } = await run(repositoryConfigYaml("{ implement: implement }"));
    const previous = pipelines.getInstanceForSession("session-1")!;
    tickets.setSandboxId("issue-1", "sandbox-old");

    await invoke({}, payload("session-2"));

    const current = pipelines.getInstanceForSession("session-2")!;
    expect(current.id).not.toBe(previous.id);
    expect(pipelines.getInstance(previous.id)).toMatchObject({
      status: "superseded",
      terminal_outcome: "superseded",
    });
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      linear_session_id: "session-2",
      sandbox_id: null,
      run_id: null,
    });
    expect(pipelines.listEffects(previous.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stop", status: "pending" }),
    ]));
    expect(db!.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("does not retire the current generation when re-delegation selects an invalid graph", async () => {
    const { tickets, pipelines, invoke, setRepositoryConfig } =
      await run(repositoryConfigYaml("{ implement: implement }"));
    const previous = pipelines.getInstanceForSession("session-1")!;
    tickets.setSandboxId("issue-1", "sandbox-old");
    setRepositoryConfig(`schema: openthrottle.config/v1
default_graph: missing
graphs:
  - id: simple
    kind: builtin
    ref: core/simple@1
pipelines: { implement: implement }
`);

    await invoke({}, payload("session-2"));

    expect(pipelines.getInstance(previous.id)).toMatchObject({
      status: "dispatchable",
      terminal_outcome: null,
    });
    expect(pipelines.getInstanceForSession("session-2")).toBeUndefined();
    expect(tickets.getByIssueId("issue-1")).toMatchObject({
      linear_session_id: "session-1",
      sandbox_id: "sandbox-old",
      run_id: null,
    });
    expect(pipelines.listEffects(previous.id).some((effect) => effect.kind === "stop")).toBe(false);
  });
});
