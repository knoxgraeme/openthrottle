import type Database from "better-sqlite3";
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
import { createPipelineStore } from "../../persistence/pipeline/create-store.js";
import type {
  CoordinatorGateReceiptWrite,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "../../pipeline/store.js";
import { buildInstalledRuntimeDescriptor } from "../../sandbox-runtime.js";

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

  function setup(manifestKey = "fixture/command@1"): {
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
    const config = parseRepositoryConfig("pipelines: { implement: fixture-command }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get(manifestKey)!;
    tickets.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-1",
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
    const instance = pipelines.getInstanceForSession("session-1")!;
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
    tickets.setPrUrl(instance.linear_issue_id, "https://github.com/owner/repo/pull/9");
    let commentExists = false;
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.endsWith("/issues/9/comments?per_page=100")) {
        return Response.json(commentExists ? [{
          id: 77,
          body: `<!-- openthrottle:pipeline-summary:${instance.linear_issue_id} -->\nold`,
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

  it("surfaces a permanent GitHub summary failure as publication-blocked", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.setPrUrl(instance.linear_issue_id, "https://github.com/owner/repo/pull/9");
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
    expect(pipelines.getStatusForIssue(instance.linear_issue_id)).toMatchObject({
      publication_state: "blocked",
      publication_id: publication.id,
    });
    db!.prepare(`
      UPDATE pipeline_publication_receipts
      SET updated_at = '2999-01-01T00:00:00.000Z'
      WHERE pipeline_instance_id = ? AND id <> ?
    `).run(instance.id, publication.id);
    expect(pipelines.getStatusForIssue(instance.linear_issue_id)).toMatchObject({
      publication_state: "blocked",
      publication_id: publication.id,
      recovery_action: expect.stringContaining(publication.id),
    });
    pipelines.retryPublication(publication.id);
    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");
  });

  it("never sends an unbound summary to a replacement session's pull request", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.setPrUrl(instance.linear_issue_id, "https://github.com/owner/repo/pull/9");
    tickets.upsert({
      linear_issue_id: instance.linear_issue_id,
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-2",
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
