import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { createLinearOutboxProcessor } from "../providers/linear/outbox.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  validatePipelineManifest,
  type ValidatedPipelineCatalog,
} from "./manifest.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "./coordinator.js";
import {
  buildLifecyclePublication,
  buildSelectionPublication,
  buildStagePublication,
  parsePipelinePublication,
  PIPELINE_PUBLICATION_TEMPLATE_VERSION,
  renderLinearStatusComment,
  renderGithubPipelineSummary,
  shouldPostLinearEventComment,
} from "./publication.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import type {
  CoordinatorGateReceiptWrite,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "./store.js";
import { buildInstalledRuntimeDescriptor } from "../runtime/contracts.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
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

  function successfulLinearFetch() {
    return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      if (request.query?.includes("IssueComments")) {
        return Response.json({ data: { issue: { comments: { nodes: [] } } } });
      }
      if (request.query?.includes("CommentCreate")) {
        return Response.json({
          data: { commentCreate: {
            success: true,
            comment: { id: "status-comment", url: "https://linear.test/comment/status" },
          } },
        });
      }
      if (!request.query?.includes("AgentActivityCreate")) throw new Error("unexpected Linear request");
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } },
      });
    }) as unknown as typeof fetch;
  }

  async function acknowledgeSelection(tickets: SupervisorStore, fetchImpl = successfulLinearFetch()) {
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchImpl }),
    });
    const selection = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_receipt")!;
    await processor.process(selection.id);
    return processor;
  }

  function nextAttemptStub(stageId: string, reentryOrdinal: number) {
    return {
      stageId,
      attemptOrdinal: 2,
      reentryOrdinal,
      requestHash: "f".repeat(64),
      idempotencyKey: `dispatch:${stageId}:${reentryOrdinal}`,
      contextRevision: 1,
      contextPolicy: "fresh",
      plannedRunId: "run-next",
      expectedSubject: null,
      nativeSessionId: null,
      requestPayload: "{}",
    };
  }

  function expectReceiptShape(body: string, stageLine: string, turnLine: RegExp | string) {
    expect(body).toContain(stageLine);
    expect(body).not.toContain("coordinator_pinned");
    expect(body).not.toContain("not_evaluated");
    expect(body).not.toContain("semantic_attested");
    expect(body).not.toContain("Residual uncertainty: None declared");
    expect((body.match(/^Stage \d+ of \d+:/gm) ?? [])).toHaveLength(1);
    expect((body.match(/^Your move:/gm) ?? []))
      .toHaveLength(1);
    if (typeof turnLine === "string") expect(body).toContain(turnLine);
    else expect(body).toMatch(turnLine);
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
    expectReceiptShape(
      publication.body,
      "Stage 1 of 1: command — the job shipped.",
      /^Your move: nothing - this run is finished\. The job shipped\./m
    );
    expect(publication.body).toContain("exit code and tree subject were executor verified");
    expect(canonical).not.toContain("ghp_");
    expect(canonical).not.toContain("private model reasoning");
    expect(publication.body).not.toContain("\n- Result: forged");
  });

  it("keeps persisted v1 publication envelopes parseable after the template bump", () => {
    const { instance } = setup();
    const publication = buildSelectionPublication(instance);
    expect(publication.template.version).toBe(PIPELINE_PUBLICATION_TEMPLATE_VERSION);
    const persistedV1 = {
      ...publication,
      template: { ...publication.template, version: 1 },
    };

    expect(parsePipelinePublication(canonicalJson(persistedV1))).toEqual(persistedV1);
  });

  it("deduplicates adjacent rendered evidence lines without changing recorded evidence", () => {
    const { instance, attempt } = setup();
    const input = event(instance, attempt, "Repeated evidence line.");
    const repeatedPayload = canonicalJson({
      summary: "Repeated evidence line.",
      evidence: ["Repeated evidence line.", "Unique follow-up evidence."],
      uncertainty: [],
    });
    input.event.artifacts = [{
      kind: "stage_result",
      schemaVersion: 1,
      assurance: "executor_verified",
      subject: SUBJECT,
      payload: repeatedPayload,
      hash: digestNormalized(repeatedPayload),
    }];
    input.event.resultHash = input.event.artifacts[0]!.hash;
    input.receipt.artifactHashes = [input.event.artifacts[0]!.hash];
    const publication = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "success",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.evidence.summaries).toEqual(["Repeated evidence line."]);
    expect(publication.evidence.details).toEqual(["Repeated evidence line.", "Unique follow-up evidence."]);
    expect(publication.body.match(/^Repeated evidence line\.$/gm)).toHaveLength(1);
    expect(publication.body).toContain("Unique follow-up evidence.");
    expect(renderGithubPipelineSummary(publication).match(/^Repeated evidence line\.$/gm)).toHaveLength(1);
  });

  it("deduplicates non-adjacent and interleaved rendered lines in first occurrence order", () => {
    const { instance, attempt } = setup();
    const input = event(instance, attempt, "OPE-12 repeated summary.");
    const repeatedPayload = canonicalJson({
      summary: "OPE-12 repeated summary.",
      evidence: [
        "First repeated block line.",
        "Second repeated block line.",
        "Third repeated block line.",
        "Fourth repeated block line.",
        "Fifth repeated block line.",
        "Sixth repeated block line.",
        "Intervening line one.",
        "Intervening line two.",
        "Intervening line three.",
        "Intervening line four.",
        "Intervening line five.",
        "Intervening line six.",
        "First repeated block line.",
        "Second repeated block line.",
        "Third repeated block line.",
        "Fourth repeated block line.",
        "Fifth repeated block line.",
        "Sixth repeated block line.",
      ],
      uncertainty: ["Alpha uncertainty.", "Beta uncertainty.", "Alpha uncertainty.", "Beta uncertainty."],
    });
    input.event.artifacts = [{
      kind: "stage_result",
      schemaVersion: 1,
      assurance: "executor_verified",
      subject: SUBJECT,
      payload: repeatedPayload,
      hash: digestNormalized(repeatedPayload),
    }];
    input.event.resultHash = input.event.artifacts[0]!.hash;
    input.receipt.artifactHashes = [input.event.artifacts[0]!.hash];

    const publication = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "success",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    for (const line of [
      "OPE-12 repeated summary.",
      "First repeated block line.",
      "Second repeated block line.",
      "Third repeated block line.",
      "Fourth repeated block line.",
      "Fifth repeated block line.",
      "Sixth repeated block line.",
      "Still uncertain: Alpha uncertainty.",
      "Still uncertain: Beta uncertainty.",
    ]) {
      expect(publication.body.match(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm")))
        .toHaveLength(1);
    }
    expect(publication.evidence.details.filter((line) => line === "First repeated block line.")).toHaveLength(2);
  });

  it("renders status comments and GitHub summaries with the checklist first", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    const publication = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "success",
        resultHash: input.event.resultHash,
        nextStatus: "waiting_provider",
        waitReason: "GitHub checks are still running",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(renderLinearStatusComment(publication, "https://github.com/owner/repo/pull/10").split("\n").slice(0, 5))
      .toEqual([
        "<!-- openthrottle:pipeline-status:issue-1 -->",
        "### Run status",
        "- [x] fresh",
        "- [...] resume - GitHub checks are still running",
        "- [ ] review",
      ]);
    expect(renderGithubPipelineSummary(publication, "https://github.com/owner/repo/pull/10").split("\n").slice(0, 8))
      .toEqual([
        "<!-- openthrottle:pipeline-summary:issue-1 -->",
        "## OpenThrottle pipeline summary",
        "",
        "### Run status",
        "- [x] fresh",
        "- [...] resume - GitHub checks are still running",
        "- [ ] review",
        "Your move: nothing - merge when CI is green. Waiting on GitHub: GitHub checks are still running.",
      ]);
  });

  it("posts new Linear comments only for run events and keeps routine receipts status-only", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    const baseWrite = {
      instanceId: instance.id,
      eventId: input.event.id,
      eventPayloadHash: digestNormalized(canonicalJson(input.event)),
      expectedVersion: instance.state_version,
      expectedStatus: instance.status,
      attemptId: attempt.id,
      outcome: "success" as const,
      resultHash: input.event.resultHash,
      effects: [],
    };
    const routine = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: { ...baseWrite, nextStatus: "dispatchable" },
      gateReceipt: input.receipt,
    });
    const prPublished = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: { ...baseWrite, nextStatus: "waiting_provider", waitReason: "provider evidence required at provider_wait" },
      gateReceipt: input.receipt,
    });
    const needsHuman = buildStagePublication({
      instance,
      attempt,
      event: { ...input.event, outcome: "needs_human" },
      write: {
        ...baseWrite,
        outcome: "needs_human",
        nextStatus: "waiting_human",
        terminalOutcome: "needs_human",
        waitReason: "pick a target",
      },
    });

    expect(shouldPostLinearEventComment(buildSelectionPublication(instance))).toBe(true);
    expect(shouldPostLinearEventComment(routine)).toBe(false);
    expect(shouldPostLinearEventComment(prPublished)).toBe(true);
    expect(shouldPostLinearEventComment(needsHuman)).toBe(true);
    expect(shouldPostLinearEventComment(buildLifecyclePublication({
      instance: { ...instance, status: "failed", terminal_outcome: "failed" },
      attempt,
      outcome: "failed",
      reason: "sandbox failed",
    }))).toBe(true);
  });

  it("creates then updates the single Linear status comment for one run", async () => {
    const { tickets, pipelines, instance, attempt } = setup("fixture/agent@1");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string; input?: { content?: { body?: string }; body?: string } };
      };
      if (request.query?.includes("IssueComments")) {
        calls.push("list");
        return Response.json({ data: { issue: { comments: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } });
      }
      if (request.query?.includes("CommentCreate")) {
        calls.push(`create:${request.variables?.input?.body ?? ""}`);
        return Response.json({ data: { commentCreate: {
          success: true,
          comment: { id: "status-comment", url: "https://linear.test/comment/status" },
        } } });
      }
      if (request.query?.includes("CommentUpdate")) {
        calls.push(`update:${request.variables?.id}:${request.variables?.input?.body ?? ""}`);
        return Response.json({ data: { commentUpdate: {
          success: true,
          comment: { id: "status-comment", url: "https://linear.test/comment/status-updated" },
        } } });
      }
      if (request.query?.includes("AgentActivityCreate")) {
        calls.push(`activity:${request.variables?.input?.content?.body ?? ""}`);
        return Response.json({ data: { agentActivityCreate: {
          success: true,
          agentActivity: { id: "activity-1" },
        } } });
      }
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });
    const status = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_status")!;

    await processor.process(status.id);
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(calls.find((call) => call.startsWith("create:"))).toContain("<!-- openthrottle:pipeline-status:issue-1 -->");
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status",
    });

    const input = event(instance, attempt, "fresh stage accepted");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(tickets.listLinearOutbox().filter((row) => row.kind === "pipeline_status")).toHaveLength(1);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "pending",
      external_id: "status-comment",
    });

    await processor.process(status.id);
    const updates = calls.filter((call) => call.startsWith("update:"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("update:status-comment:");
    expect(updates[0]).toContain("Your move: nothing - OpenThrottle is working on resume.");
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status-updated",
    });
  });

  it("reuses an already-current Linear status comment without another write", async () => {
    const { tickets } = setup("fixture/agent@1");
    const status = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_status")!;
    const body = (JSON.parse(status.payload) as { publication: { body: string } }).publication.body;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      if (request.query?.includes("IssueComments")) {
        calls.push("list");
        return Response.json({ data: { issue: { comments: {
          nodes: [{
            id: "status-comment",
            body,
            url: "https://linear.test/comment/status",
            user: { id: "app-user", app: true, isMe: true },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } });
      }
      if (request.query?.includes("CommentUpdate")) calls.push("update");
      if (request.query?.includes("CommentCreate")) calls.push("create");
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    await processor.process(status.id);

    expect(calls).toEqual(["list"]);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status",
    });
  });

  it("recreates the Linear status comment when the persisted comment was deleted", async () => {
    const { tickets, pipelines, instance, attempt } = setup("fixture/agent@1");
    const initialFetch = successfulLinearFetch();
    const initialProcessor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: initialFetch }),
    });
    const status = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_status")!;

    await initialProcessor.process(status.id);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
    });

    const input = event(instance, attempt, "fresh stage accepted");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "pending",
      external_id: "status-comment",
    });

    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string; input?: { body?: string } };
      };
      if (request.query?.includes("CommentUpdate")) {
        calls.push(`update:${request.variables?.id}`);
        return Response.json(
          { errors: [{ message: "Comment not found", extensions: { code: "NOT_FOUND" } }] },
          { status: 200 }
        );
      }
      if (request.query?.includes("CommentCreate")) {
        calls.push(`create:${request.variables?.input?.body ?? ""}`);
        return Response.json({ data: { commentCreate: {
          success: true,
          comment: { id: "replacement-status-comment", url: "https://linear.test/comment/replacement" },
        } } });
      }
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const recovered = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    await recovered.process(status.id);

    expect(calls[0]).toBe("update:status-comment");
    expect(calls[1]).toContain("create:<!-- openthrottle:pipeline-status:issue-1 -->");
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "replacement-status-comment",
      external_url: "https://linear.test/comment/replacement",
    });
  });

  it("renders every pipeline receipt template as plain progress and turn sentences", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    const baseWrite = {
      instanceId: instance.id,
      eventId: input.event.id,
      eventPayloadHash: digestNormalized(canonicalJson(input.event)),
      expectedVersion: instance.state_version,
      expectedStatus: instance.status,
      attemptId: attempt.id,
      resultHash: input.event.resultHash,
      effects: [],
    };

    const selection = buildSelectionPublication(instance);
    expectReceiptShape(
      selection.body,
      "Stage 0 of 3: selection — the supervisor selected the pinned pipeline for this ticket.",
      "Your move: nothing - OpenThrottle is working on fresh."
    );

    const gate = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        ...baseWrite,
        outcome: "success" as const,
        nextStatus: "dispatchable" as const,
      },
      gateReceipt: input.receipt,
    });
    expectReceiptShape(
      gate.body,
      "Stage 1 of 3: fresh — the stage completed successfully.",
      "Your move: nothing - OpenThrottle is working on resume."
    );

    const repair = buildStagePublication({
      instance,
      attempt,
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        ...baseWrite,
        outcome: "semantic_repair_required" as const,
        nextStatus: "dispatchable" as const,
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("fresh", 1),
      },
      gateReceipt: input.receipt,
    });
    expect(repair.body).toContain("scheduled repair round 1 of 1 at the fresh stage");
    expectReceiptShape(
      repair.body,
      "Stage 1 of 3: fresh — the stage completed and asked for a repair pass.",
      "Your move: nothing - OpenThrottle is working on fresh."
    );

    // A backward repair edge (review -> resume) at the final allowed round:
    // the round comes from the scheduled target attempt's re-entry ordinal and
    // the bound from the pinned transition's max_reentries, so the numerator
    // never exceeds the denominator.
    const finalRepair = buildStagePublication({
      instance,
      attempt: { ...attempt, stage_id: "review" },
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        ...baseWrite,
        outcome: "semantic_repair_required" as const,
        nextStatus: "dispatchable" as const,
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("resume", 2),
      },
      gateReceipt: input.receipt,
    });
    expect(finalRepair.body).toContain("scheduled repair round 2 of 2 at the resume stage");
    for (const [, round, bound] of finalRepair.body.matchAll(/repair round (\d+) of (\d+)/g)) {
      expect(Number(round)).toBeLessThanOrEqual(Number(bound));
    }
    expectReceiptShape(
      finalRepair.body,
      "Stage 3 of 3: review — the stage completed and asked for a repair pass.",
      "Your move: nothing - OpenThrottle is working on resume."
    );

    // An infrastructure self-retry is not a semantic repair pass and must not
    // be described as one.
    const infraRetry = buildStagePublication({
      instance,
      attempt,
      event: { ...input.event, outcome: "retryable_infrastructure_failure" },
      write: {
        ...baseWrite,
        outcome: "retryable_infrastructure_failure" as const,
        nextStatus: "dispatchable" as const,
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("fresh", 1),
      },
      gateReceipt: input.receipt,
    });
    expect(infraRetry.body)
      .toContain("retrying the fresh stage after an infrastructure failure (attempt 1 of 1)");
    expect(infraRetry.body).not.toMatch(/repair/i);
    expectReceiptShape(
      infraRetry.body,
      "Stage 1 of 3: fresh — the stage could not complete because infrastructure failed.",
      "Your move: nothing - OpenThrottle is working on fresh."
    );

    const needsHuman = buildStagePublication({
      instance,
      attempt,
      event: { ...input.event, outcome: "needs_human" },
      write: {
        ...baseWrite,
        outcome: "needs_human" as const,
        nextStatus: "waiting_human" as const,
        terminalOutcome: "needs_human" as const,
        waitReason: "Choose whether to continue in the Linear session.",
      },
      resumeStatus: "waiting_human",
    });
    expectReceiptShape(
      needsHuman.body,
      "Stage 1 of 3: fresh — the run needs a human decision before it can continue.",
      "Your move: decision required: Choose whether to continue in the Linear session."
    );

    const providerWait = buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        ...baseWrite,
        outcome: "success" as const,
        nextStatus: "waiting_provider" as const,
        waitReason: "GitHub checks are still running",
      },
      gateReceipt: input.receipt,
    });
    expectReceiptShape(
      providerWait.body,
      "Stage 1 of 3: fresh — the stage completed successfully.",
      "Your move: nothing - merge when CI is green. Waiting on GitHub: GitHub checks are still running."
    );
  });

  it.each([
    [
      "shipped",
      "The job shipped.",
      "Stage 1 of 1: command — the job shipped.",
      "Your move: nothing - this run is finished. The job shipped.",
    ],
    [
      "no_change",
      "The job finished because no code change was needed; no pull request was created.",
      "Stage 1 of 1: command — the stage completed and reported that no change was needed.",
      "Your move: nothing - this run is finished. The job finished because no code change was needed; no pull request was created.",
    ],
    [
      "needs_human",
      "The job needs a human decision before it can finish: Pick a deployment target. The workspace is preserved.",
      "Stage 1 of 1: command — the run needs a human decision before it can continue.",
      "Your move: decision required: Pick a deployment target.",
    ],
    [
      "failed",
      "The job failed: Daytona could not provision the sandbox.",
      "Stage 1 of 1: command — the run failed.",
      "Your move: nothing - this run is finished. The job failed: Daytona could not provision the sandbox.",
    ],
    [
      "canceled",
      "The job was canceled before it could finish.",
      "Stage 1 of 1: command — the run was canceled.",
      "Your move: nothing - this run is finished. The job was canceled before it could finish.",
    ],
    [
      "superseded",
      "The job was superseded by a newer run.",
      "Stage 1 of 1: command — the run was replaced by a newer session.",
      "Your move: nothing - this run is finished. The job was superseded by a newer run.",
    ],
  ] as const)("renders the %s terminal job outcome honestly", (outcome, sentence, stageLine, turnLine) => {
    const { instance, attempt } = setup();
    const publication = buildLifecyclePublication({
      instance: {
        ...instance,
        status: outcome,
        terminal_outcome: outcome,
        immutable_subject: outcome === "shipped" ? SUBJECT : instance.immutable_subject,
      },
      attempt,
      outcome,
      reason: outcome === "needs_human"
        ? "Pick a deployment target"
        : outcome === "failed"
          ? "Daytona could not provision the sandbox"
          : sentence,
    });
    expectReceiptShape(publication.body, stageLine, turnLine);
    expect(publication.body).toContain(sentence);
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

  it("keeps ordinary stage progression receipts out of new Linear comments", async () => {
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
    expect(pipelines.getPublication(firstPublication.id)?.status).toBe("acknowledged");
    expect(tickets.getLinearOutbox(firstPublication.id)).toBeUndefined();
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
        query?: string;
        variables?: { input?: { agentSessionId?: string } };
      };
      if (request.query?.includes("AgentActivityCreate")) {
        deliveredSessions.push(request.variables?.input?.agentSessionId ?? "");
      }
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

  it("does not let a late status row update a newer Linear session generation", async () => {
    const { tickets, instance } = setup("fixture/agent@1");
    const status = tickets.listLinearOutbox().find((row) => row.kind === "pipeline_status")!;
    tickets.upsert({
      linear_issue_id: instance.linear_issue_id,
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-2",
      sandbox_id: null,
      branch: "ot/issue-1-next",
      agent: "codex",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/2",
      state: "active",
    });
    const commentCalls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      if (request.query?.includes("IssueComments")) commentCalls.push("list");
      if (request.query?.includes("CommentUpdate")) commentCalls.push("update");
      if (request.query?.includes("CommentCreate")) commentCalls.push("create");
      if (commentCalls.length > 0) throw new Error("stale status row should not touch Linear comments");
      return Response.json({ data: { agentActivityCreate: {
        success: true,
        agentActivity: { id: "old-receipt" },
      } } });
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    await processor.process(status.id);

    expect(commentCalls).toEqual([]);
    expect(tickets.getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: null,
    });
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
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
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
