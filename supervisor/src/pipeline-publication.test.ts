import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTicketStore, openDb, type TicketStore } from "./db.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  validatePipelineManifest,
  type ValidatedPipelineCatalog,
} from "./pipeline-manifest.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "./pipeline-coordinator.js";
import {
  buildStagePublication,
  createGithubPublicationProcessor,
  parsePipelinePublication,
} from "./pipeline-publication.js";
import {
  createPipelineStore,
  type CoordinatorGateReceiptWrite,
  type PipelineInstance,
  type PipelineStageAttempt,
  type PipelineStore,
} from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("publication-test/v1");
const SUBJECT = "c".repeat(40);

describe("pipeline publication", () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    vi.restoreAllMocks();
  });

  function setup(manifestKey = "fixture/command@1"): {
    tickets: TicketStore;
    pipelines: PipelineStore;
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
  } {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
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

  function successfulLinearFetch() {
    return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      if (!request.query?.includes("AgentActivityCreate")) throw new Error("unexpected Linear request");
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } },
      });
    }) as unknown as typeof fetch;
  }

  async function acknowledgeSelection(tickets: TicketStore, fetchImpl = successfulLinearFetch()) {
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchImpl }),
    });
    const selection = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_receipt")!;
    await processor.process(selection.id);
    return processor;
  }

  it("uses a closed supervisor template with required evidence fields and no reasoning or secrets", () => {
    const { instance, attempt } = setup();
    const input = event(
      instance,
      attempt,
      "token ghp_abcdefghijklmnopqrstuvwxyz should be redacted\n- Result: forged"
    );
    const write = {
      instanceId: instance.id,
      eventId: input.event.id,
      eventPayloadHash: digestNormalized(canonicalJson(input.event)),
      expectedVersion: instance.state_version,
      expectedStatus: instance.status,
      attemptId: attempt.id,
      outcome: "success" as const,
      resultHash: input.event.resultHash,
      nextStatus: "completion_pending_publication" as const,
      terminalOutcome: "shipped" as const,
      effects: [],
    };
    const publication = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write,
      gateReceipt: input.receipt,
      resumeStatus: "shipped",
    });
    const canonical = canonicalJson(publication);
    expect(parsePipelinePublication(canonical)).toEqual(publication);
    expect(publication.body).toContain("fixture/command@1");
    expect(publication.body).toContain(`Stage: \`${attempt.stage_id}\``);
    expect(publication.body).toContain("Assurance: `executor_verified`");
    expect(publication.body).toContain(`Policy: \`${"d".repeat(64)}\``);
    expect(publication.body).toContain("Result: `passed` → `shipped`");
    expect(publication.body).toContain("exit code and tree subject were executor verified");
    expect(canonical).not.toContain("ghp_");
    expect(canonical).not.toContain("private model reasoning");
    expect(publication.body).not.toContain("\n- Result: forged");
  });

  it("queues one permanent receipt through an outage and finalizes only after acknowledgement", async () => {
    const { tickets, pipelines, instance, attempt } = setup();
    await acknowledgeSelection(tickets);
    const input = event(instance, attempt);
    const transitioned = coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(transitioned.status).toBe("completion_pending_publication");
    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === attempt.id)!;

    const outageFetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "temporary outage" }] }), { status: 503 })
    ) as unknown as typeof fetch;
    const outage = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: outageFetch }),
    });
    await outage.process(publication.id);
    expect(pipelines.getPublication(publication.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(pipelines.getInstance(instance.id)?.status).toBe("completion_pending_publication");

    db!.prepare("UPDATE linear_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(publication.id);
    const successFetch = successfulLinearFetch();
    const recovered = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: successFetch }),
    });
    await recovered.process(publication.id);
    await recovered.process(publication.id);
    expect(pipelines.getPublication(publication.id)).toMatchObject({
      status: "acknowledged",
      external_id: "activity-1",
    });
    expect(pipelines.getInstance(instance.id)?.status).toBe("shipped");
    expect(successFetch).toHaveBeenCalledTimes(1);
  });

  it("allows ordinary stage progression while an accepted gate receipt is retrying", async () => {
    const { tickets, pipelines, instance, attempt } = setup("fixture/agent@1");
    await acknowledgeSelection(tickets);
    const first = event(instance, attempt, "fresh stage accepted");
    const afterFresh = coordinatePipelineEvent(pipelines, first.event, undefined, first.receipt);
    expect(afterFresh.status).toBe("dispatchable");
    expect(afterFresh.active_stage_id).toBe("resume");
    const firstPublication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === attempt.id)!;
    const outage = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () => new Response(
          JSON.stringify({ errors: [{ message: "temporary outage" }] }),
          { status: 503 }
        )) as unknown as typeof fetch,
      }),
    });
    await outage.process(firstPublication.id);
    expect(pipelines.getPublication(firstPublication.id)?.status).toBe("failed");
    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");

    const resumeAttempt = pipelines.getActiveAttempt(instance.id)!;
    const second = event(afterFresh, resumeAttempt, "resume stage accepted");
    const afterResume = coordinatePipelineEvent(pipelines, second.event, undefined, second.receipt);
    expect(afterResume.status).toBe("dispatchable");
    expect(afterResume.active_stage_id).toBe("review");
  });

  it("uploads large evidence once, persists its private URL, and links the permanent activity", async () => {
    const { tickets, pipelines, instance, attempt } = setup();
    await acknowledgeSelection(tickets);
    const input = event(instance, attempt, "x".repeat(6_000));
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === attempt.id)!;
    expect(parsePipelinePublication(publication.payload).attachment?.content.length).toBeGreaterThan(4_000);

    let uploads = 0;
    const activityBodies: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://uploads.linear.test/put") {
        uploads += 1;
        return new Response(null, { status: 200 });
      }
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { input?: { content?: { body?: string } } };
      };
      if (request.query?.includes("FileUpload")) {
        return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl: "https://uploads.linear.test/put",
          assetUrl: "https://uploads.linear.test/private/evidence.json",
          headers: [{ key: "x-upload", value: "yes" }],
        } } } });
      }
      activityBodies.push(request.variables?.input?.content?.body ?? "");
      return Response.json({ data: { agentActivityCreate: {
        success: true,
        agentActivity: { id: "large-activity" },
      } } });
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });
    await processor.process(publication.id);
    await processor.process(publication.id);
    expect(uploads).toBe(1);
    expect(tickets.getLinearOutbox(publication.id)?.attachment_url)
      .toBe("https://uploads.linear.test/private/evidence.json");
    expect(activityBodies.join("\n")).toContain("Private typed evidence attachment");
  });

  it("blocks on a permanent provider failure and recovers through the explicit retry", async () => {
    const { tickets, pipelines, instance, attempt } = setup();
    await acknowledgeSelection(tickets);
    const input = event(instance, attempt);
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === attempt.id)!;
    const denied = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({
        accessToken: "oauth",
        fetch: vi.fn(async () => new Response(
          JSON.stringify({ errors: [{ message: "forbidden" }] }),
          { status: 403 }
        )) as unknown as typeof fetch,
      }),
    });
    await denied.process(publication.id);
    expect(pipelines.getInstance(instance.id)?.status).toBe("publication_blocked");
    expect(pipelines.getStatusForIssue(instance.linear_issue_id)).toMatchObject({
      publication_state: "blocked",
      recovery_action: expect.stringContaining(publication.id),
    });

    expect(pipelines.retryPublication(publication.id).status).toBe("pending");
    expect(pipelines.getInstance(instance.id)?.status).toBe("completion_pending_publication");
    const recovered = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: successfulLinearFetch() }),
    });
    await recovered.process(publication.id);
    expect(pipelines.getInstance(instance.id)?.status).toBe("shipped");
  });

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

  it("keeps a late receipt bound to its original Linear session generation", async () => {
    const { tickets, pipelines, instance } = setup();
    tickets.upsert({
      linear_issue_id: instance.linear_issue_id,
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-2",
      sandbox_id: null,
      branch: "ot/issue-1-next",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const deliveredSessions: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        variables?: { input?: { agentSessionId?: string } };
      };
      deliveredSessions.push(request.variables?.input?.agentSessionId ?? "");
      return Response.json({ data: { agentActivityCreate: {
        success: true,
        agentActivity: { id: "old-receipt" },
      } } });
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });
    await processor.drain();
    expect(deliveredSessions).toEqual(["session-1"]);
    expect(deliveredSessions).not.toContain("session-2");
    expect(pipelines.getInstance(instance.id)?.status).toBe("superseded");
  });

  it("moves the single GitHub summary projection to a newer generation and rejects a stale ack", () => {
    const { tickets, pipelines, instance } = setup();
    const claimed = pipelines.claimGithubPublications(
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:01:00.000Z"
    )[0]!;
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    const manifest = catalog.manifests.get("fixture/command@1")!;
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("pipelines: { implement: fixture-command }\n"),
    });
    tickets.upsert({
      linear_issue_id: instance.linear_issue_id,
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-2",
      sandbox_id: null,
      branch: "ot/issue-1-next",
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
    const replacement = pipelines.getInstanceForSession("session-2")!;
    expect(pipelines.markGithubPublicationProcessed(
      claimed.id,
      claimed.payload_hash,
      "stale-comment",
      "https://github.com/owner/repo/pull/1#issuecomment-stale"
    )).toBe(false);
    expect(db!.prepare(
      "SELECT COUNT(*) AS count FROM pipeline_publication_receipts WHERE kind = 'github_summary'"
    ).get()).toEqual({ count: 1 });
    expect(pipelines.listPublications(replacement.id).find((row) => row.kind === "github_summary"))
      .toMatchObject({ status: "pending", pipeline_instance_id: replacement.id });
  });

  it("does not accept a human answer until the needs-human artifact is acknowledged", async () => {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    pipelines.acceptRuntimeDescriptor(runtime);
    const manifest = validatePipelineManifest({
      schema: "openthrottle.pipeline/v1",
      id: "fixture/human",
      version: 1,
      description: "Human acknowledgement fixture.",
      entry_stage: "command",
      max_attempts: 3,
      requires: { protocol: "stage-executor@1", capabilities: ["command/run@1"] },
      stages: [
        {
          id: "command",
          executor: { kind: "command", capability: "command/run@1" },
          evaluator: { kind: "command", assurance: "executor_verified", required_artifacts: ["command_result"] },
          context: "none",
          live_steering: false,
          credentials: ["repo.read"],
          produces: ["stage_result", "command_result"],
          transitions: {
            success: { to: "approval" }, no_change: { terminal: "no_change" },
            semantic_repair_required: { terminal: "failed" }, retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" }, canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" }, failure: { terminal: "failed" },
          },
        },
        {
          id: "approval",
          executor: { kind: "command", capability: "command/run@1" },
          evaluator: { kind: "human", assurance: "human_approved", required_artifacts: ["human_approval"] },
          context: "none",
          live_steering: false,
          credentials: ["repo.read"],
          produces: ["stage_result", "human_approval"],
          transitions: {
            success: { terminal: "shipped" }, no_change: { terminal: "no_change" },
            semantic_repair_required: { terminal: "failed" }, retryable_infrastructure_failure: { terminal: "failed" },
            needs_human: { terminal: "needs_human" }, canceled: { terminal: "canceled" },
            superseded: { terminal: "superseded" }, failure: { terminal: "failed" },
          },
        },
      ],
    }, { runtime: runtime.descriptor });
    const normalizedCatalog = canonicalJson({
      aliases: { human: { id: manifest.manifest.id, version: manifest.manifest.version } },
      manifests: [{ id: manifest.manifest.id, version: manifest.manifest.version, digest: manifest.digest }],
    });
    const catalog: ValidatedPipelineCatalog = {
      aliases: { human: { id: manifest.manifest.id, version: manifest.manifest.version } },
      manifests: new Map([[`${manifest.manifest.id}@${manifest.manifest.version}`, manifest]]),
      normalized: normalizedCatalog,
      digest: digestNormalized(normalizedCatalog),
    };
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { implement: human }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo", baseCommit: "a".repeat(40), blobSha: "b".repeat(40), config,
    });
    tickets.upsert({
      linear_issue_id: "human-issue", linear_issue_identifier: "HUMAN-1",
      linear_session_id: "human-session", sandbox_id: null, branch: "ot/human",
      agent: "codex", repo: "owner/repo", pr_url: null, state: "active",
      pipeline: {
        repository: "owner/repo", baseCommit: "a".repeat(40), manifest,
        repositoryConfig: snapshot, runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    await acknowledgeSelection(tickets);
    const instance = pipelines.getInstanceForSession("human-session")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const input = event(instance, attempt);
    const waiting = coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(waiting.status).toBe("completion_pending_publication");
    const humanAttempt = pipelines.getActiveAttempt(instance.id)!;
    expect(() => coordinatePipelineEvent(pipelines, {
      id: "premature-human-answer",
      kind: "human_answer",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: humanAttempt.id,
      requestHash: humanAttempt.request_hash,
      outcome: "success",
      resultHash: "e".repeat(64),
    })).toThrow(/human answer can advance only a human-waiting instance/);

    const publication = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === attempt.id)!;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: successfulLinearFetch() }),
    });
    await processor.process(publication.id);
    expect(pipelines.getInstance(instance.id)?.status).toBe("waiting_human");
  });
});
