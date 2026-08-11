import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../../persistence/store.js";
import { openDb } from "../../persistence/database.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
} from "../../pipeline/manifest.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "../../pipeline/coordinator.js";
import { createGithubPublicationProcessor } from "./pipeline-publication.js";
import { githubSupervisorCommentWriteIsPending } from "./comment-provenance.js";
import { createPipelineStore } from "../../persistence/pipeline/create-store.js";
import type {
  CoordinatorGateReceiptWrite,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "../../pipeline/store.js";
import { buildInstalledRuntimeDescriptor } from "../../__fixtures__/runtime.js";

const catalogPath = fileURLToPath(new URL("../../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("publication-test/v1");
const SUBJECT = "c".repeat(40);

describe("github publication delivery", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    vi.restoreAllMocks();
  });

  function setup(manifestKey = "fixture/command@1", ticket?: Partial<{
    ticket_id: string;
    ticket_reference: string;
    session_id: string;
    control_provider: "linear" | "github";
    external_thread_id: string;
    external_thread_reference: string;
  }>): {
    tickets: SupervisorStore;
    pipelines: PipelineStore;
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
  } {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get(manifestKey)!;
    tickets.upsert({
      ticket_id: ticket?.ticket_id ?? "issue-1",
      ticket_reference: ticket?.ticket_reference ?? "ISSUE-1",
      session_id: ticket?.session_id ?? "session-1",
      control_provider: ticket?.control_provider,
      external_thread_id: ticket?.external_thread_id,
      external_thread_reference: ticket?.external_thread_reference,
      sandbox_id: null,
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession(ticket?.session_id ?? "session-1")!;
    return { tickets, pipelines, instance, attempt: pipelines.getActiveAttempt(instance.id)! };
  }

  function event(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    summary = "Command evidence accepted."
  ): { event: PipelineCoordinatorEvent; receipt: CoordinatorGateReceiptWrite } {
    const isCommand = attempt.stage_id === "command";
    const assurance = isCommand ? "executor_verified" as const : "semantic_attested" as const;
    const stagePayload = canonicalJson({
      summary,
      evidence: ["exit code and tree subject were executor verified"],
      uncertainty: ["provider checks have not run"],
      reasoning: "private model reasoning must never be published",
    });
    const commandPayload = canonicalJson({ summary: "Command exited zero.", evidence: [], uncertainty: [] });
    const artifacts = [
      {
        kind: "stage_result",
        schemaVersion: 1,
        assurance,
        subject: SUBJECT,
        payload: stagePayload,
        hash: digestNormalized(stagePayload),
      },
      ...(isCommand ? [{
        kind: "command_result",
        schemaVersion: 1,
        assurance: "executor_verified" as const,
        subject: SUBJECT,
        payload: commandPayload,
        hash: digestNormalized(commandPayload),
      }] : []),
    ];
    const receiptPayload = canonicalJson({
      attempt_id: attempt.id,
      decision: "passed",
      subject: SUBJECT,
    });
    return {
      event: {
        id: `event-${digestNormalized(stagePayload).slice(0, 12)}`,
        kind: "stage_result",
        instanceId: instance.id,
        generation: instance.generation,
        attemptId: attempt.id,
        requestHash: attempt.request_hash,
        outcome: "success",
        resultHash: artifacts[0]!.hash,
        subject: SUBJECT,
        artifacts,
      },
      receipt: {
        evaluatorKind: isCommand ? "command" : "semantic",
        policyDigest: "d".repeat(64),
        subject: SUBJECT,
        result: "passed",
        artifactHashes: artifacts.map((artifact) => artifact.hash).sort(),
        payload: receiptPayload,
        hash: digestNormalized(receiptPayload),
      },
    };
  }

  it("reconciles every update into one durable neutral GitHub summary", async () => {
    const { tickets, pipelines, instance, attempt } = setup();
    tickets.setPrUrl(instance.ticket_id, "https://github.com/owner/repo/pull/9");
    let commentExists = false;
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.endsWith("/issues/9/comments?per_page=100")) {
        return Response.json(commentExists ? [{
          id: 77,
          body: `<!-- openthrottle:pipeline-summary:${instance.ticket_id} -->\nold`,
          html_url: "https://github.com/owner/repo/pull/9#issuecomment-77",
        }] : []);
      }
      if (method === "POST") commentExists = true;
      return Response.json({ id: 77, html_url: "https://github.com/owner/repo/pull/9#issuecomment-77" });
    }) as unknown as typeof fetch;
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: { token: "github", fetch: fetchMock },
    });
    await processor.drain();
    const summaryId = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "github_summary")!.id;
    expect(pipelines.getPublication(summaryId)).toMatchObject({
      status: "acknowledged",
      external_id: "77",
      target_url: "https://github.com/owner/repo/pull/9",
    });

    const input = event(instance, attempt);
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(pipelines.listPublications(instance.id).filter((row) => row.kind === "github_summary"))
      .toHaveLength(1);
    expect(pipelines.getPublication(summaryId)?.status).toBe("pending");
    await processor.drain();
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    expect(methods.filter((method) => method === "PATCH")).toHaveLength(1);
  });

  it("publishes one durable marked GitHub Issue status comment across restart and re-dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ot-github-status-"));
    const path = join(dir, "supervisor.sqlite");
    let restarted: Database.Database | undefined;
    try {
      db = openDb(path);
      let pipelines = createPipelineStore(db);
      const tickets = createSupervisorStore(db, pipelines);
      const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
      pipelines.acceptRuntimeDescriptor(runtime);
      pipelines.acceptCatalog(catalog);
      const config = parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n");
      const snapshot = pipelines.saveRepositoryConfigSnapshot({
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        blobSha: "b".repeat(40),
        config,
      });
      const manifest = catalog.manifests.get("fixture/command@1")!;
      tickets.upsert({
        ticket_id: "github:owner/repo#12",
        ticket_reference: "GH-12",
        session_id: "github:owner/repo#12",
        control_provider: "github",
        external_thread_id: "owner/repo#12",
        external_thread_reference: "GH-12",
        sandbox_id: null,
        branch: "ot/gh-12",
        agent: "codex",
        repo: "owner/repo",
        pr_url: null,
        state: "active",
        pipeline: {
          repository: "owner/repo",
          baseCommit: "a".repeat(40),
          manifest,
          repositoryConfig: snapshot,
          runtime,
          authorizedCapabilities: manifest.manifest.requires.capabilities,
          taskType: "implement",
        },
      });
      const instance = pipelines.getInstanceForSession("github:owner/repo#12")!;
      db.close();
      db = undefined;

      restarted = openDb(path);
      pipelines = createPipelineStore(restarted);
      const restartedTickets = createSupervisorStore(restarted, pipelines);
      let commentExists = false;
      const methods: string[] = [];
      const bodies: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        methods.push(method);
        if (url.endsWith("/issues/12/comments?per_page=100")) {
          return Response.json(commentExists ? [{
            id: 808,
            body: "<!-- openthrottle:pipeline-status:github:owner/repo#12 -->\nold",
            html_url: "https://github.com/owner/repo/issues/12#issuecomment-808",
          }] : []);
        }
        if (method === "POST") commentExists = true;
        if (init?.body) bodies.push(String(init.body));
        return Response.json({ id: 808, html_url: "https://github.com/owner/repo/issues/12#issuecomment-808" });
      }) as unknown as typeof fetch;
      const processor = createGithubPublicationProcessor({
        store: pipelines,
        tickets: restartedTickets,
        client: { token: "github", fetch: fetchMock },
      });

      await processor.drain();
      await processor.drain();

      const publication = pipelines.listPublications(instance.id)
        .find((row) => row.kind === "github_summary")!;
      expect(publication).toMatchObject({
        status: "acknowledged",
        external_id: "808",
        target_url: "https://github.com/owner/repo/issues/12",
      });
      expect(methods.filter((method) => method === "POST")).toHaveLength(1);
      expect(methods.filter((method) => method === "PATCH")).toHaveLength(0);
      expect(bodies[0]).toContain("<!-- openthrottle:pipeline-status:github:owner/repo#12 -->");
    } finally {
      restarted?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists an in-flight intent before GitHub can deliver the created-comment webhook", async () => {
    const { tickets, pipelines } = setup("fixture/command@1", {
      ticket_id: "github:owner/repo#12",
      ticket_reference: "GH-12",
      session_id: "github:owner/repo#12",
      control_provider: "github",
      external_thread_id: "owner/repo#12",
      external_thread_reference: "GH-12",
    });
    let releasePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/issues/12/comments?per_page=100")) return Response.json([]);
      if (method === "POST") return postResponse;
      if (method === "PUT") return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${method} ${url}`);
    }) as unknown as typeof fetch;
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: { token: "github", fetch: fetchMock },
    });

    const drain = processor.drain();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/issues/12/comments"),
        expect.objectContaining({ method: "POST" })
      );
    });
    const marker = "<!-- openthrottle:pipeline-status:github:owner/repo#12 -->";
    expect(githubSupervisorCommentWriteIsPending(
      tickets,
      "owner/repo",
      12,
      `${marker}\nstatus`
    )).toBe(true);

    releasePost(Response.json({
      id: 809,
      html_url: "https://github.com/owner/repo/issues/12#issuecomment-809",
    }));
    await drain;
    expect(tickets.getSetting("github-supervisor-comment:809")).toBe("pipeline-status");
    expect(githubSupervisorCommentWriteIsPending(
      tickets,
      "owner/repo",
      12,
      `${marker}\nstatus`
    )).toBe(false);
  });

  it("does not let a stale GitHub Issue status delivery acknowledge a newer revision", async () => {
    const { pipelines, instance, attempt } = setup("fixture/command@1", {
      ticket_id: "github:owner/repo#12",
      ticket_reference: "GH-12",
      session_id: "github:owner/repo#12",
      control_provider: "github",
      external_thread_id: "owner/repo#12",
      external_thread_reference: "GH-12",
    });
    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "github_summary")!;
    const claimed = pipelines.claimGithubPublications(
      "2999-01-01T00:00:00.000Z",
      "2999-01-01T00:01:00.000Z"
    )[0]!;
    expect(claimed.id).toBe(publication.id);
    const input = event(instance, attempt, "A newer revision superseded the claimed status.");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    const newer = pipelines.getPublication(claimed.id)!;

    expect(pipelines.markGithubPublicationProcessed(
      claimed.id,
      claimed.payload_hash,
      "1",
      "https://github.com/owner/repo/issues/12#issuecomment-1"
    )).toBe(false);

    expect(pipelines.getPublication(claimed.id)).toMatchObject({
      status: "processing",
      payload_hash: newer.payload_hash,
      external_id: null,
    });
    expect(pipelines.requeueGithubPublicationAfterStaleWrite(
      claimed.id,
      claimed.payload_hash,
      "1",
      "https://github.com/owner/repo/issues/12#issuecomment-1"
    )).toBe(true);
    expect(pipelines.getPublication(claimed.id)).toMatchObject({
      status: "pending",
      payload_hash: newer.payload_hash,
      external_id: "1",
    });
  });

  it("surfaces a permanent GitHub summary failure as publication-blocked", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.setPrUrl(instance.ticket_id, "https://github.com/owner/repo/pull/9");
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: {
        token: "github",
        fetch: vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
      },
    });
    await processor.drain();
    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "github_summary")!;
    expect(publication.status).toBe("dead");
    expect(pipelines.getInstance(instance.id)?.status).toBe("publication_blocked");
    expect(pipelines.getStatusForIssue(instance.ticket_id)).toMatchObject({
      publication_state: "blocked",
      publication_id: publication.id,
    });
    db!.prepare(`
      UPDATE pipeline_publication_receipts
      SET updated_at = '2999-01-01T00:00:00.000Z'
      WHERE pipeline_instance_id = ? AND id <> ?
    `).run(instance.id, publication.id);
    expect(pipelines.getStatusForIssue(instance.ticket_id)).toMatchObject({
      publication_state: "blocked",
      publication_id: publication.id,
      recovery_action: expect.stringContaining(publication.id),
    });
    pipelines.retryPublication(publication.id);
    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");
  });

  it("does not leave a GitHub summary receipt reclaimable when the processed CAS returns false", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.setPrUrl(instance.ticket_id, "https://github.com/owner/repo/pull/9");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/issues/9/comments?per_page=100")) return Response.json([]);
      if (method === "POST") {
        return Response.json({
          id: 77,
          html_url: "https://github.com/owner/repo/pull/9#issuecomment-77",
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    vi.spyOn(pipelines, "markGithubPublicationProcessed").mockReturnValue(false);
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: { token: "github", fetch: fetchMock },
    });

    await processor.drain();

    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "github_summary")!;
    expect(publication.status).toBe("dead");
    expect(publication.last_error).toContain("CAS failed");
    expect(pipelines.claimGithubPublications(
      "2999-01-01T00:00:00.000Z",
      "2999-01-01T00:01:00.000Z"
    )).toHaveLength(0);
  });

  it("never sends an unbound summary to a replacement session's pull request", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.setPrUrl(instance.ticket_id, "https://github.com/owner/repo/pull/9");
    tickets.upsert({
      ticket_id: instance.ticket_id,
      ticket_reference: "ISSUE-1",
      session_id: "session-2",
      sandbox_id: null,
      branch: "ot/issue-1-next",
      agent: "codex",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/10",
      state: "active",
    });
    const fetchMock = vi.fn(async () => Response.json({ id: 1 })) as unknown as typeof fetch;
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: { token: "github", fetch: fetchMock },
    });

    await processor.drain();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pipelines.listPublications(instance.id).find((row) => row.kind === "github_summary"))
      .toMatchObject({ status: "failed", target_url: null });
  });

  it("acknowledges terminal GitHub summaries when no pull request was created", async () => {
    const { tickets, pipelines, instance, attempt } = setup();
    const input = event(instance, attempt, "Investigation completed without a repository change.");
    input.event.outcome = "no_change";
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    const fetchImpl = vi.fn();
    const processor = createGithubPublicationProcessor({
      store: pipelines,
      tickets,
      client: { token: "github", fetch: fetchImpl as unknown as typeof fetch },
    });

    await processor.drain();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pipelines.listPublications(instance.id)
      .filter((row) => row.kind === "github_summary"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "acknowledged", external_id: "skipped:no-pull-request" }),
      ]));
  });
});
