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
import { createPipelinePublicationWriter } from "../persistence/pipeline/helpers.js";
import type { LinearOutboxRecord } from "../persistence/delivery-store.js";
import type {
  CoordinatorGateReceiptWrite,
  PipelineInstance,
  PipelineStageAttempt,
  PipelineStore,
} from "./store.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";

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

  const getLinearOutbox = (id: string): LinearOutboxRecord | undefined =>
    db!.prepare("SELECT * FROM linear_outbox WHERE id = ?").get(id) as LinearOutboxRecord | undefined;

  const listLinearOutbox = (): LinearOutboxRecord[] =>
    db!.prepare("SELECT * FROM linear_outbox ORDER BY created_at, sequence").all() as LinearOutboxRecord[];

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

  function coreImplementManifest() {
    const path = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
    return loadPipelineCatalog(path, runtime.descriptor).manifests.get("core/implement@4")!;
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

  function semanticEvent(input: {
    instance: PipelineInstance;
    attempt: PipelineStageAttempt;
    outcome: PipelineCoordinatorEvent["outcome"];
    summary: string;
    findings?: Array<{ severity: string; code: string; summary: string }>;
    actions?: string[];
    withReviewArtifact?: boolean;
  }): { event: PipelineCoordinatorEvent; receipt: CoordinatorGateReceiptWrite } {
    const artifactBody = {
      summary: input.summary,
      evidence: [`${input.attempt.stage_id} stage evidence for ${input.summary}`],
      findings: input.findings ?? [],
      actions: input.actions ?? [],
      uncertainty: [],
    };
    const stagePayload = canonicalJson({ kind: "stage_result", ...artifactBody });
    const artifacts = [{
      kind: "stage_result",
      schemaVersion: 1,
      assurance: "semantic_attested" as const,
      subject: SUBJECT,
      payload: stagePayload,
      hash: digestNormalized(stagePayload),
    }];
    if (input.withReviewArtifact) {
      const reviewPayload = canonicalJson({ kind: "review", ...artifactBody });
      artifacts.push({
        kind: "review",
        schemaVersion: 1,
        assurance: "semantic_attested" as const,
        subject: SUBJECT,
        payload: reviewPayload,
        hash: digestNormalized(reviewPayload),
      });
    }
    const receiptPayload = canonicalJson({
      attempt_id: input.attempt.id,
      decision: "passed",
      subject: SUBJECT,
    });
    return {
      event: {
        id: `event-${digestNormalized(canonicalJson([input.attempt.id, stagePayload])).slice(0, 12)}`,
        kind: "stage_result",
        instanceId: input.instance.id,
        generation: input.instance.generation,
        attemptId: input.attempt.id,
        requestHash: input.attempt.request_hash,
        outcome: input.outcome,
        resultHash: artifacts[0]!.hash,
        subject: SUBJECT,
        artifacts,
      },
      receipt: {
        evaluatorKind: "semantic",
        policyDigest: "d".repeat(64),
        subject: SUBJECT,
        result: "passed",
        artifactHashes: artifacts.map((artifact) => artifact.hash).sort(),
        payload: receiptPayload,
        hash: digestNormalized(receiptPayload),
      },
    };
  }

  function replaceStagePayload(
    input: { event: PipelineCoordinatorEvent; receipt: CoordinatorGateReceiptWrite },
    payload: Record<string, unknown>
  ) {
    const stagePayload = canonicalJson(payload);
    input.event.artifacts = [{
      kind: "stage_result",
      schemaVersion: 1,
      assurance: "semantic_attested",
      subject: SUBJECT,
      payload: stagePayload,
      hash: digestNormalized(stagePayload),
    }];
    input.event.resultHash = input.event.artifacts[0]!.hash;
    input.receipt.artifactHashes = [input.event.artifacts[0]!.hash];
  }

  function successfulLinearFetch() {
    return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string; variables?: { id?: string; stateId?: string } };
      if (request.query?.includes("query Comment")) {
        return Response.json({ data: { comment: null } });
      }
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
      if (request.query?.includes("IssueWorkflowState")) {
        return Response.json({
          data: {
            issue: {
              id: request.variables?.id ?? "issue-1",
              state: { id: "backlog", name: "Backlog", type: "backlog" },
              team: { id: "team-1" },
            },
          },
        });
      }
      if (request.query?.includes("TeamWorkflowStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "backlog", name: "Backlog", type: "backlog" },
                  { id: "progress", name: "In Progress", type: "started" },
                  { id: "review", name: "In Review", type: "started" },
                  { id: "done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        });
      }
      if (request.query?.includes("IssueStateUpdate")) {
        return Response.json({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: request.variables?.id ?? "issue-1",
                state: { id: request.variables?.stateId ?? "progress", name: "target" },
              },
            },
          },
        });
      }
      if (!request.query?.includes("AgentActivityCreate")) throw new Error("unexpected Linear request");
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-1" } } },
      });
    }) as unknown as typeof fetch;
  }

  function failingIssueStateUpdateFetch() {
    const fallback = successfulLinearFetch() as typeof fetch;
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string };
      if (request.query?.includes("IssueStateUpdate")) {
        return new Response(JSON.stringify({ errors: [{ message: "temporary outage" }] }), { status: 503 });
      }
      return fallback(input, init);
    }) as unknown as typeof fetch;
  }

  async function acknowledgeSelection(tickets: SupervisorStore, fetchImpl = successfulLinearFetch()) {
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchImpl }),
    });
    const selection = listLinearOutbox().find((row) => row.kind === "pipeline_receipt")!;
    await processor.process(selection.id);
    return processor;
  }

  function issueStateRows() {
    const order = new Map([["started", 0], ["review", 1], ["completed", 2]]);
    return listLinearOutbox()
      .filter((row) => row.kind === "issue_state")
      .map((row) => {
        const payload = JSON.parse(row.payload) as { signal: string; issueId: string };
        return { issueId: payload.issueId, signal: payload.signal };
      })
      .sort((a, b) => (order.get(a.signal) ?? 99) - (order.get(b.signal) ?? 99));
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

  function collidingReviewLabelsManifest(): string {
    const baseTerminalTransitions = {
      no_change: { terminal: "no_change" },
      semantic_repair_required: { terminal: "needs_human" },
      retryable_infrastructure_failure: { terminal: "failed" },
      needs_human: { terminal: "needs_human" },
      canceled: { terminal: "canceled" },
      superseded: { terminal: "superseded" },
      failure: { terminal: "failed" },
    };
    const reviewStage = (id: "semantic_review" | "review", success: { to: string } | { terminal: "shipped" }) => ({
      id,
      executor: { kind: "agent", capability: "agent/semantic@1" },
      evaluator: { kind: "semantic", assurance: "semantic_attested", required_artifacts: ["review"] },
      context: "fresh",
      live_steering: false,
      credentials: ["model.invoke", "repo.read"],
      produces: ["review", "stage_result"],
      transitions: { success, ...baseTerminalTransitions },
    });
    return canonicalJson({
      schema: "openthrottle.pipeline/v1",
      id: "fixture/colliding-review-labels",
      version: 1,
      description: "Fixture with two review stages sharing the same display label.",
      entry_stage: "implementation",
      max_attempts: 4,
      requires: {
        protocol: "stage-executor@1",
        capabilities: ["agent/semantic@1"],
      },
      stages: [
        {
          id: "implementation",
          executor: { kind: "agent", capability: "agent/semantic@1" },
          evaluator: { kind: "semantic", assurance: "semantic_attested", required_artifacts: ["stage_result"] },
          context: "fresh",
          live_steering: true,
          credentials: ["model.invoke", "repo.read", "repo.write"],
          produces: ["stage_result"],
          transitions: { success: { to: "semantic_review" }, ...baseTerminalTransitions },
        },
        reviewStage("semantic_review", { to: "review" }),
        reviewStage("review", { terminal: "shipped" }),
      ],
    });
  }

  function expectReceiptShape(body: string, turnLine: RegExp | string) {
    expect(body).not.toContain("coordinator_pinned");
    expect(body).not.toContain("not_evaluated");
    expect(body).not.toContain("semantic_attested");
    expect(body).not.toContain("Residual uncertainty: None declared");
    expect((body.match(/^Stage \d+ of \d+:/gm) ?? [])).toHaveLength(0);
    expect((body.match(/^\*\*Your move:/gm) ?? [])).toHaveLength(1);
    const arrowRows = body.match(/^→ /gm) ?? [];
    expect(arrowRows.length).toBeLessThanOrEqual(1);
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
      /^\*\*Your move: nothing — this run is finished\. The job shipped\./m
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

    const legacyEvidence = { ...persistedV1.evidence };
    delete legacyEvidence.findings;
    delete legacyEvidence.actions;
    const legacyV1 = { ...persistedV1, evidence: legacyEvidence };
    expect(parsePipelinePublication(canonicalJson(legacyV1))).toEqual(legacyV1);
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
      "- Alpha uncertainty.",
      "- Beta uncertainty.",
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
        "**Your move: nothing — waiting on GitHub: GitHub checks are still running (stage 2 of 3).**",
        "- [x] fresh",
        "→ **resume** — in progress — GitHub checks are still running",
        "- [ ] code review",
        "**Assumptions & decisions**",
      ]);
    expect(renderGithubPipelineSummary(publication, "https://github.com/owner/repo/pull/10").split("\n").slice(0, 8))
      .toEqual([
        "<!-- openthrottle:pipeline-summary:issue-1 -->",
        "## OpenThrottle pipeline summary",
        "",
        "**Your move: nothing — waiting on GitHub: GitHub checks are still running (stage 2 of 3).**",
        "- [x] fresh",
        "→ **resume** — in progress — GitHub checks are still running",
        "- [ ] code review",
        "**Assumptions & decisions**",
      ]);
  });

  it("renders fixed provider feedback as an addressed block in the GitHub summary", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt, "Repair review passed.");
    replaceStagePayload(input, {
      summary: "Repair review passed.",
      evidence: ["Focused provider-feedback regression passed."],
      findings: [],
      actions: ["Fixed stale-review-feedback by ignoring superseded PR review comments after a repair round."],
      uncertainty: [],
    });
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
      priorFindings: [{
        severity: "P2",
        code: "stale-review-feedback",
        summary: "Superseded PR review comments trigger another repair.",
        disposition: "carried to repair",
      }, {
        severity: "P2",
        code: "older-feedback",
        summary: "A finding fixed by an earlier repair.",
        disposition: "fixed in-stage",
      }],
    });

    const summary = renderGithubPipelineSummary(publication, "https://github.com/owner/repo/pull/10");
    expect(summary).toMatch(/^<!-- openthrottle:pipeline-summary:issue-1 -->/);
    expect(summary).toContain([
      "Addressed in `cccccccccccc`:",
      "- [P2] stale-review-feedback: Superseded PR review comments trigger another repair.",
    ].join("\n"));
    expect(summary).not.toContain("- [P2] older-feedback: A finding fixed by an earlier repair.");
  });

  it("renders artifact findings with severity, code, summary, and fixed or remaining dispositions", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Semantic review completed.",
      evidence: ["Reviewed publication rendering."],
      findings: [
        { severity: "P1", code: "provider-snapshot-bounding", summary: "snapshot payload unbounded" },
        { severity: "P3", code: "status-copy", summary: "receipt copy needs clarity" },
      ],
      actions: ["Applied verified in-scope fixes for valid provider snapshot payload bounding."],
      uncertainty: [],
    });
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

    expect(publication.body).toContain("**Findings**");
    expect(publication.body).toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → fixed in-stage");
    expect(publication.body).toContain("[P3] status-copy — receipt copy needs clarity → remaining/accepted");
    expect(renderLinearStatusComment(publication)).toContain("[P1] provider-snapshot-bounding");
    expect(renderGithubPipelineSummary(publication)).toContain("[P3] status-copy");
  });

  it("renders assumptions under one header and strips duplicated leading labels", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Implementation completed.",
      evidence: ["Verified the status renderer."],
      findings: [],
      actions: [],
      uncertainty: [
        "Assumptions & decisions: Treated the status change as display-only.",
        "Assumptions \\& decisions: Kept manifest stage IDs stable.",
      ],
    });
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

    expect(publication.body.match(/^\*\*Assumptions & decisions\*\*$/gm)).toHaveLength(1);
    expect(publication.body).toContain("- Treated the status change as display-only.");
    expect(publication.body).toContain("- Kept manifest stage IDs stable.");
    expect(publication.body).not.toContain("- Assumptions & decisions:");
  });

  it("renders repair reentry findings as carried into the scheduled repair round", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Semantic review found blocking issues.",
      evidence: ["Review found a provider snapshot issue."],
      findings: [
        { severity: "P0", code: "provider-snapshot-bounding", summary: "snapshot payload unbounded" },
      ],
      actions: [],
      uncertainty: [],
    });
    const publication = buildStagePublication({
      instance,
      attempt: { ...attempt, stage_id: "review" },
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "semantic_repair_required",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("resume", 2),
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.body).toContain("scheduled repair round 2 of 2 at the resume stage");
    expect(publication.body)
      .toContain("[P0] provider-snapshot-bounding — snapshot payload unbounded → carried to repair");
  });

  it("names the current repair-triggering finding in the repair banner when older findings are carried forward", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Semantic review found a new blocking issue after an earlier repair.",
      evidence: ["Review found a checklist rendering issue."],
      findings: [
        { severity: "P2", code: "review-label-checklist", summary: "second review checklist row hidden" },
      ],
      actions: [],
      uncertainty: [],
    });
    const publication = buildStagePublication({
      instance,
      attempt: { ...attempt, stage_id: "review" },
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "semantic_repair_required",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("resume", 2),
        effects: [],
      },
      gateReceipt: input.receipt,
      priorFindings: [{
        severity: "P1",
        code: "provider-snapshot-bounding",
        summary: "snapshot payload unbounded",
        disposition: "fixed in-stage",
      }],
    });

    expect(publication.body).toContain(
      "Repair round 2 of 2 — [P2] review-label-checklist: second review checklist row hidden"
    );
    expect(publication.body).not.toContain(
      "Repair round 2 of 2 — [P1] provider-snapshot-bounding: snapshot payload unbounded"
    );
    expect(renderLinearStatusComment(publication)).toContain(
      "Repair round 2 of 2 — [P2] review-label-checklist: second review checklist row hidden"
    );
    expect(renderLinearStatusComment(publication)).not.toContain(
      "Repair round 2 of 2 — [P1] provider-snapshot-bounding: snapshot payload unbounded"
    );
    expect(renderGithubPipelineSummary(publication)).toContain(
      "Repair round 2 of 2 — [P2] review-label-checklist: second review checklist row hidden"
    );
    expect(renderGithubPipelineSummary(publication)).not.toContain(
      "Repair round 2 of 2 — [P1] provider-snapshot-bounding: snapshot payload unbounded"
    );
  });

  it("renders both semantic review rows for a two-review-stage manifest", () => {
    const { instance, attempt } = setup("fixture/dual-review@1");
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
        nextStatus: "dispatchable",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.body.split("\n").slice(1, 6)).toEqual([
      "- [x] implementing",
      "→ **code review** — in progress",
      "- [ ] simplifying",
      "- [ ] re-review",
      "- [ ] publishing",
    ]);
  });

  it("renders the core implementation checklist in happy-path execution order without unentered repair rows", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const manifest = coreImplementManifest();
    const input = event(instance, attempt);
    const publication = buildStagePublication({
      instance: {
        ...instance,
        pipeline_id: manifest.manifest.id,
        pipeline_version: manifest.manifest.version,
        normalized_manifest: manifest.normalized,
        manifest_digest: manifest.digest,
      },
      attempt: { ...attempt, stage_id: "publish" },
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

    expect(publication.body.split("\n").slice(1, 10)).toEqual([
      "- [x] implementing",
      "- [x] code review",
      "- [x] simplifying",
      "- [x] re-review",
      "- [x] testing",
      "- [x] linting",
      "- [x] building",
      "- [x] publishing",
      "→ **waiting on GitHub** — in progress — GitHub checks are still running",
    ]);
    expect(publication.body).not.toContain("repair implementing");
    expect(publication.body).not.toContain("repair code review");
    expect(publication.body).not.toContain("semantic review");
  });

  it("inserts entered core repair stages before their command-gate rejoin", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const manifest = coreImplementManifest();
    const input = event(instance, attempt);
    const publication = buildStagePublication({
      instance: {
        ...instance,
        pipeline_id: manifest.manifest.id,
        pipeline_version: manifest.manifest.version,
        normalized_manifest: manifest.normalized,
        manifest_digest: manifest.digest,
      },
      attempt: { ...attempt, stage_id: "semantic_review" },
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "semantic_repair_required",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("repair_implementation", 1),
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.body.split("\n").slice(1, 10)).toEqual([
      "- [x] implementing",
      "- [x] code review",
      "→ **repair implementing** — in progress",
      "- [ ] repair code review",
      "- [ ] testing",
      "- [ ] linting",
      "- [ ] building",
      "- [ ] publishing",
      "- [ ] waiting on GitHub",
    ]);
    expect(publication.body).not.toContain("repair semantic review");
    expect(publication.body).not.toContain("semantic review");
  });

  it("keeps core repair implementation before repair code review while the repair path is active", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const manifest = coreImplementManifest();
    const input = event(instance, attempt);
    const publication = buildStagePublication({
      instance: {
        ...instance,
        pipeline_id: manifest.manifest.id,
        pipeline_version: manifest.manifest.version,
        normalized_manifest: manifest.normalized,
        manifest_digest: manifest.digest,
      },
      attempt: { ...attempt, stage_id: "repair_implementation", reentry_ordinal: 1 },
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

    expect(publication.body.split("\n").slice(1, 10)).toEqual([
      "- [x] implementing",
      "- [x] code review",
      "- [x] repair implementing",
      "→ **repair code review** — in progress",
      "- [ ] testing",
      "- [ ] linting",
      "- [ ] building",
      "- [ ] publishing",
      "- [ ] waiting on GitHub",
    ]);
  });

  it("does not infer core repair rows from implementation self-reentry", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const manifest = coreImplementManifest();
    const input = event(instance, attempt);
    const publication = buildStagePublication({
      instance: {
        ...instance,
        pipeline_id: manifest.manifest.id,
        pipeline_version: manifest.manifest.version,
        normalized_manifest: manifest.normalized,
        manifest_digest: manifest.digest,
      },
      attempt: { ...attempt, stage_id: "implementation", reentry_ordinal: 1 },
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: attempt.id,
        outcome: "semantic_repair_required",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        reentryIncrement: 1,
        nextAttempt: nextAttemptStub("implementation", 2),
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.body.split("\n").slice(1, 10)).toEqual([
      "→ **implementing** — in progress",
      "- [ ] code review",
      "- [ ] simplifying",
      "- [ ] re-review",
      "- [ ] testing",
      "- [ ] linting",
      "- [ ] building",
      "- [ ] publishing",
      "- [ ] waiting on GitHub",
    ]);
    expect(publication.body).not.toContain("repair implementing");
    expect(publication.body).not.toContain("repair code review");
  });

  it("does not deduplicate distinct checklist rows with the same display label", () => {
    const { instance } = setup("fixture/agent@1");
    const normalizedManifest = collidingReviewLabelsManifest();
    const publication = buildSelectionPublication({
      ...instance,
      pipeline_id: "fixture/colliding-review-labels",
      pipeline_version: 1,
      normalized_manifest: normalizedManifest,
      manifest_digest: digestNormalized(normalizedManifest),
    });

    expect(publication.body.match(/^- \[ \] code review$/gm)).toHaveLength(2);
    expect(renderLinearStatusComment(publication).match(/^- \[ \] code review$/gm)).toHaveLength(2);
    expect(renderGithubPipelineSummary(publication).match(/^- \[ \] code review$/gm)).toHaveLength(2);
  });

  it("renders post-repair findings with per-item resolution status", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Repair completed.",
      evidence: ["Rechecked the findings that triggered repair."],
      findings: [
        { severity: "P1", code: "provider-snapshot-bounding", summary: "snapshot payload unbounded" },
        { severity: "P2", code: "status-copy", summary: "receipt copy needs clarity" },
      ],
      actions: ["Fixed provider snapshot bounding and verified coverage."],
      uncertainty: [],
    });
    const publication = buildStagePublication({
      instance,
      attempt: { ...attempt, stage_id: "resume", reentry_ordinal: 1 },
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

    expect(publication.body)
      .toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → fixed in-stage");
    expect(publication.body)
      .toContain("[P2] status-copy — receipt copy needs clarity → remaining/accepted");
  });

  it("omits findings scaffolding when artifacts have no findings", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Semantic review completed cleanly.",
      evidence: ["No issues found."],
      findings: [],
      actions: [],
      uncertainty: [],
    });
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

    expect(publication.body).not.toContain("**Findings**");
    expect(renderGithubPipelineSummary(publication)).not.toContain("**Findings**");
  });

  it("truncates long finding lists with an explicit remainder marker", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const input = event(instance, attempt);
    replaceStagePayload(input, {
      summary: "Semantic review completed with many findings.",
      evidence: ["Review emitted bounded findings."],
      findings: Array.from({ length: 12 }, (_, index) => ({
        severity: (index % 4 === 0 ? "P0" : index % 4 === 1 ? "P1" : index % 4 === 2 ? "P2" : "P3"),
        code: `finding-${index + 1}`,
        summary: `finding summary ${index + 1}`,
      })),
      actions: [],
      uncertainty: [],
    });
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

    expect(publication.body).toContain("[P1] finding-10 — finding summary 10 → remaining/accepted");
    expect(publication.body).not.toContain("finding-11");
    expect(publication.body).toContain("+2 more");
  });

  it("deduplicates findings shared by stage_result and review artifacts before truncating", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const reviewAttempt = { ...attempt, stage_id: "review" };
    const input = semanticEvent({
      instance,
      attempt: reviewAttempt,
      outcome: "success",
      summary: "Semantic review emitted duplicate finding copies.",
      findings: Array.from({ length: 12 }, (_, index) => ({
        severity: "P1",
        code: `finding-${index + 1}`,
        summary: `finding summary ${index + 1}`,
      })),
      withReviewArtifact: true,
    });
    const publication = buildStagePublication({
      instance,
      attempt: reviewAttempt,
      event: input.event,
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: reviewAttempt.id,
        outcome: "success",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    // Each unique finding is recorded once even though both artifacts carry it.
    expect(publication.evidence.findings).toHaveLength(12);
    expect(publication.body.match(/^\[P1\] finding-1 — finding summary 1 → remaining\/accepted$/gm))
      .toHaveLength(1);
    expect(publication.body.match(/^\[P1\] finding-10 — finding summary 10 → remaining\/accepted$/gm))
      .toHaveLength(1);
    expect(publication.body).not.toContain("finding-11");
    // The omitted count reflects unique findings (12 - 10), not raw copies (24 - 10).
    expect(publication.body).toContain("+2 more");
  });

  it("does not report omitted findings when the duplicated findings all fit the rendered list", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const reviewAttempt = { ...attempt, stage_id: "review" };
    const input = semanticEvent({
      instance,
      attempt: reviewAttempt,
      outcome: "success",
      summary: "Semantic review emitted six duplicated findings.",
      findings: Array.from({ length: 6 }, (_, index) => ({
        severity: "P1",
        code: `finding-${index + 1}`,
        summary: `finding summary ${index + 1}`,
      })),
      withReviewArtifact: true,
    });
    const publication = buildStagePublication({
      instance,
      attempt: reviewAttempt,
      event: input.event,
      write: {
        instanceId: instance.id,
        eventId: input.event.id,
        eventPayloadHash: digestNormalized(canonicalJson(input.event)),
        expectedVersion: instance.state_version,
        expectedStatus: instance.status,
        attemptId: reviewAttempt.id,
        outcome: "success",
        resultHash: input.event.resultHash,
        nextStatus: "dispatchable",
        effects: [],
      },
      gateReceipt: input.receipt,
    });

    expect(publication.evidence.findings).toHaveLength(6);
    for (let index = 1; index <= 6; index += 1) {
      expect(publication.body.match(new RegExp(
        `^\\[P1\\] finding-${index} — finding summary ${index} → remaining/accepted$`, "gm"
      ))).toHaveLength(1);
    }
    expect(publication.body).not.toMatch(/^\+\d+ more$/m);
  });

  it("carries review findings and dispositions into later publications and the final summary", () => {
    const { pipelines, instance, attempt } = setup("fixture/agent@1");

    const fresh = semanticEvent({
      instance,
      attempt,
      outcome: "success",
      summary: "fresh implementation completed",
    });
    const afterFresh = coordinatePipelineEvent(pipelines, fresh.event, undefined, fresh.receipt);
    expect(afterFresh.active_stage_id).toBe("resume");

    const resumeAttempt = pipelines.getActiveAttempt(instance.id)!;
    const resume = semanticEvent({
      instance: afterFresh,
      attempt: resumeAttempt,
      outcome: "success",
      summary: "resume implementation completed",
    });
    const afterResume = coordinatePipelineEvent(pipelines, resume.event, undefined, resume.receipt);
    expect(afterResume.active_stage_id).toBe("review");

    const reviewAttempt = pipelines.getActiveAttempt(instance.id)!;
    const review = semanticEvent({
      instance: afterResume,
      attempt: reviewAttempt,
      outcome: "semantic_repair_required",
      summary: "review found blocking issues",
      findings: [
        { severity: "P1", code: "provider-snapshot-bounding", summary: "snapshot payload unbounded" },
        { severity: "P2", code: "status-copy", summary: "receipt copy needs clarity" },
      ],
      withReviewArtifact: true,
    });
    const afterReview = coordinatePipelineEvent(pipelines, review.event, undefined, review.receipt);
    expect(afterReview.active_stage_id).toBe("resume");
    const reviewPublication = parsePipelinePublication(pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === reviewAttempt.id)!.payload);
    // Findings duplicated across stage_result and review artifacts render once
    // in the dispositions list; the repair banner may repeat the lead finding.
    expect(reviewPublication.body.match(/^\[P1\] provider-snapshot-bounding/gm)).toHaveLength(1);
    expect(reviewPublication.body)
      .toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → carried to repair");
    expect(reviewPublication.body)
      .toContain("[P2] status-copy — receipt copy needs clarity → carried to repair");

    const repairAttempt = pipelines.getActiveAttempt(instance.id)!;
    expect(repairAttempt.stage_id).toBe("resume");
    const repair = semanticEvent({
      instance: afterReview,
      attempt: repairAttempt,
      outcome: "success",
      summary: "repair round applied the requested fix",
      actions: ["Fixed provider snapshot bounding and verified coverage."],
    });
    coordinatePipelineEvent(pipelines, repair.event, undefined, repair.receipt);
    const repairPublication = parsePipelinePublication(pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === repairAttempt.id)!.payload);
    // The repair stage emitted no findings of its own, yet the earlier review
    // findings stay visible with their updated dispositions.
    expect(repairPublication.body)
      .toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → fixed in-stage");
    expect(repairPublication.body)
      .toContain("[P2] status-copy — receipt copy needs clarity → carried to repair");

    const finalAttempt = pipelines.getActiveAttempt(instance.id)!;
    expect(finalAttempt.stage_id).toBe("review");
    const finalReview = semanticEvent({
      instance: pipelines.getInstance(instance.id)!,
      attempt: finalAttempt,
      outcome: "success",
      summary: "review accepted the remaining finding",
      findings: [
        { severity: "P2", code: "status-copy", summary: "receipt copy needs clarity" },
      ],
      withReviewArtifact: true,
    });
    const terminal = coordinatePipelineEvent(pipelines, finalReview.event, undefined, finalReview.receipt);
    expect(terminal.terminal_outcome).toBe("shipped");
    const finalPublication = parsePipelinePublication(pipelines.listPublications(instance.id)
      .find((row) => row.kind === "linear_ledger" && row.attempt_id === finalAttempt.id)!.payload);
    // The terminal publication and the GitHub summary show the whole run's
    // findings with their ultimate dispositions.
    expect(finalPublication.body)
      .toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → fixed in-stage");
    expect(finalPublication.body)
      .toContain("[P2] status-copy — receipt copy needs clarity → remaining/accepted");
    const githubSummary = renderGithubPipelineSummary(finalPublication, "https://github.com/owner/repo/pull/10");
    expect(githubSummary)
      .toContain("[P1] provider-snapshot-bounding — snapshot payload unbounded → fixed in-stage");
    expect(githubSummary)
      .toContain("[P2] status-copy — receipt copy needs clarity → remaining/accepted");
    const githubReceipt = pipelines.listPublications(instance.id)
      .find((row) => row.kind === "github_summary")!;
    expect(parsePipelinePublication(githubReceipt.payload).evidence.findings).toHaveLength(2);
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
    const repairReentry = buildStagePublication({
      instance,
      attempt,
      event: { ...input.event, outcome: "semantic_repair_required" },
      write: {
        ...baseWrite,
        outcome: "semantic_repair_required",
        nextStatus: "dispatchable",
        nextStageId: "fresh",
        reentryIncrement: 1,
      },
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
    expect(shouldPostLinearEventComment(repairReentry)).toBe(true);
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
        variables?: { id?: string; input?: { id?: string; content?: { body?: string }; body?: string } };
      };
      if (request.query?.includes("IssueComments")) {
        calls.push("list");
        return Response.json({ data: { issue: { comments: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } });
      }
      if (request.query?.includes("CommentCreate")) {
        calls.push(`create:${request.variables?.input?.id ?? ""}:${request.variables?.input?.body ?? ""}`);
        return Response.json({ data: { commentCreate: {
          success: true,
          comment: { id: "status-comment", url: "https://linear.test/comment/status" },
        } } });
      }
      if (request.query?.includes("query Comment")) {
        calls.push(`get:${request.variables?.id}`);
        if (request.variables?.id !== "status-comment") {
          return Response.json({ data: { comment: null } });
        }
        return Response.json({ data: { comment: {
          id: request.variables?.id,
          body: "stale status body",
          url: "https://linear.test/comment/status",
          user: { id: "app-user", app: true, isMe: true },
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
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;

    await processor.process(status.id);
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(calls.find((call) => call.startsWith("create:"))).toContain(`create:${status.id}:`);
    expect(calls.find((call) => call.startsWith("create:"))).not.toContain("<!-- openthrottle:pipeline-status:issue-1 -->");
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status",
    });

    const input = event(instance, attempt, "fresh stage accepted");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(listLinearOutbox().filter((row) => row.kind === "pipeline_status")).toHaveLength(1);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "pending",
      external_id: "status-comment",
    });

    await processor.process(status.id);
    const updates = calls.filter((call) => call.startsWith("update:"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("update:status-comment:");
    expect(updates[0]).toContain("**Your move: nothing — resume (stage 2 of 3).**");
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status-updated",
    });
  });

  it("queues Linear issue-state projections for selection, provider wait, and shipped only", () => {
    const { instance, attempt } = setup("fixture/agent@1");
    const persistPublication = createPipelinePublicationWriter(db!);
    expect(issueStateRows()).toEqual([{ issueId: "issue-1", signal: "started" }]);
    const baseWrite = {
      instanceId: instance.id,
      eventId: "event-id",
      eventPayloadHash: "e".repeat(64),
      expectedVersion: instance.state_version,
      expectedStatus: instance.status,
      attemptId: attempt.id,
      resultHash: "f".repeat(64),
      effects: [],
    };
    const input = event(instance, attempt, "publish opened a pull request");
    const providerWait = canonicalJson(buildStagePublication({
      instance,
      attempt,
      event: input.event,
      write: {
        ...baseWrite,
        outcome: "success",
        nextStatus: "waiting_provider",
        waitReason: "provider evidence required at provider",
      },
      gateReceipt: input.receipt,
    }));
    persistPublication({
      instance,
      attemptId: attempt.id,
      kind: "linear_ledger",
      idempotencyKey: "linear-provider-wait-test",
      payload: providerWait,
      timestamp: "2026-07-27T00:00:00.000Z",
    });
    const shipped = canonicalJson(buildLifecyclePublication({
      instance: { ...instance, status: "shipped", terminal_outcome: "shipped", immutable_subject: SUBJECT },
      attempt,
      outcome: "shipped",
      reason: "The pull request merged.",
    }));
    persistPublication({
      instance,
      attemptId: attempt.id,
      kind: "linear_ledger",
      idempotencyKey: "linear-shipped-test",
      payload: shipped,
      timestamp: "2026-07-27T00:00:01.000Z",
    });
    for (const outcome of ["failed", "needs_human"] as const) {
      const payload = canonicalJson(buildLifecyclePublication({
        instance: { ...instance, status: outcome, terminal_outcome: outcome },
        attempt,
        outcome,
        reason: "terminal reason",
      }));
      persistPublication({
        instance,
        attemptId: attempt.id,
        kind: "linear_ledger",
        idempotencyKey: `linear-${outcome}-test`,
        payload,
        timestamp: "2026-07-27T00:00:02.000Z",
      });
    }

    expect(issueStateRows()).toEqual([
      { issueId: "issue-1", signal: "started" },
      { issueId: "issue-1", signal: "review" },
      { issueId: "issue-1", signal: "completed" },
    ]);
  });

  it("keeps issue-state update failures from blocking Linear receipt completion", async () => {
    const { tickets, pipelines, instance } = setup("fixture/agent@1");
    const stateRow = listLinearOutbox().find((row) => row.kind === "issue_state")!;
    const selection = listLinearOutbox().find((row) => row.kind === "pipeline_receipt")!;
    const failedState = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: failingIssueStateUpdateFetch() }),
    });
    await failedState.process(stateRow.id);
    expect(getLinearOutbox(stateRow.id)).toMatchObject({ status: "failed" });

    expect(pipelines.getPublication(selection.id)).toMatchObject({
      status: "acknowledged",
      external_id: "activity-1",
    });
    expect(pipelines.getInstance(instance.id)?.status).toBe("dispatchable");
    expect(getLinearOutbox(stateRow.id)).toMatchObject({ status: "failed" });
  });

  it("rediscovers a markerless Linear status comment by deterministic outbox id", async () => {
    const { tickets } = setup("fixture/agent@1");
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;
    const body = (JSON.parse(status.payload) as { publication: { body: string } }).publication.body;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string; input?: { body?: string } };
      };
      if (request.query?.includes("query Comment")) {
        calls.push(`get:${request.variables?.id}`);
        return Response.json({ data: { comment: {
          id: status.id,
          body: "stale markerless status body",
          url: "https://linear.test/comment/status",
          user: { id: "app-user", app: true, isMe: true },
        } } });
      }
      if (request.query?.includes("CommentUpdate")) {
        calls.push(`update:${request.variables?.id}:${request.variables?.input?.body ?? ""}`);
        return Response.json({ data: { commentUpdate: {
          success: true,
          comment: { id: status.id, url: "https://linear.test/comment/status-updated" },
        } } });
      }
      if (request.query?.includes("IssueComments")) calls.push("list");
      if (request.query?.includes("CommentCreate")) calls.push("create");
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    await processor.process(status.id);

    expect(calls).toEqual([
      `get:${status.id}`,
      `update:${status.id}:${body}`,
    ]);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: status.id,
      external_url: "https://linear.test/comment/status-updated",
    });
  });

  it("reuses an already-current Linear status comment without another write", async () => {
    const { tickets } = setup("fixture/agent@1");
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;
    const body = (JSON.parse(status.payload) as { publication: { body: string } }).publication.body;
    db!.prepare("UPDATE linear_outbox SET external_id = ?, external_url = ? WHERE id = ?")
      .run("status-comment", "https://linear.test/comment/status", status.id);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string; variables?: { id?: string } };
      if (request.query?.includes("query Comment")) {
        calls.push("get");
        return Response.json({ data: { comment: {
            id: "status-comment",
            body,
            url: "https://linear.test/comment/status",
            user: { id: "app-user", app: true, isMe: true },
        } } });
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

    expect(calls).toEqual(["get"]);
    expect(getLinearOutbox(status.id)).toMatchObject({
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
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;

    await initialProcessor.process(status.id);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
    });

    const input = event(instance, attempt, "fresh stage accepted");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "pending",
      external_id: "status-comment",
    });

    const calls: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string; input?: { body?: string } };
      };
      if (request.query?.includes("query Comment")) {
        calls.push(`get:${request.variables?.id}`);
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

    expect(calls[0]).toBe("get:status-comment");
    expect(calls[1]).toContain("create:");
    expect(calls[1]).not.toContain("<!-- openthrottle:pipeline-status:issue-1 -->");
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "replacement-status-comment",
      external_url: "https://linear.test/comment/replacement",
    });
  });

  it("keeps transient status update failures on the retry path without recreating", async () => {
    const { tickets, pipelines, instance, attempt } = setup("fixture/agent@1");
    const initialProcessor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: successfulLinearFetch() }),
    });
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;

    await initialProcessor.process(status.id);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
    });

    const input = event(instance, attempt, "fresh stage accepted");
    coordinatePipelineEvent(pipelines, input.event, undefined, input.receipt);

    const calls: string[] = [];
    let outage = true;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { id?: string };
      };
      if (request.query?.includes("query Comment")) {
        calls.push(`get:${request.variables?.id}`);
        return Response.json({ data: { comment: {
          id: request.variables?.id,
          body: "stale status body",
          url: "https://linear.test/comment/status",
          user: { id: "app-user", app: true, isMe: true },
        } } });
      }
      if (request.query?.includes("CommentUpdate")) {
        calls.push(`update:${request.variables?.id}`);
        if (outage) {
          // A transient provider failure is not a deleted comment: it must
          // stay on the retry path and never trigger recreation.
          return new Response(
            JSON.stringify({ errors: [{ message: "temporary outage" }] }),
            { status: 503 }
          );
        }
        return Response.json({ data: { commentUpdate: {
          success: true,
          comment: { id: request.variables?.id, url: "https://linear.test/comment/status-updated" },
        } } });
      }
      if (request.query?.includes("CommentCreate") || request.query?.includes("IssueComments")) {
        calls.push("recreate-path");
      }
      throw new Error("unexpected Linear request");
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store: tickets,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    await processor.process(status.id);
    const failed = getLinearOutbox(status.id)!;
    expect(failed).toMatchObject({ status: "failed", external_id: "status-comment" });
    expect(failed.last_error).toContain("temporary outage");
    expect(failed.next_attempt_at).toBeTruthy();
    expect(calls).toEqual(["get:status-comment", "update:status-comment"]);

    outage = false;
    db!.prepare("UPDATE linear_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(status.id);
    await processor.process(status.id);
    expect(calls).toEqual([
      "get:status-comment",
      "update:status-comment",
      "get:status-comment",
      "update:status-comment",
    ]);
    expect(getLinearOutbox(status.id)).toMatchObject({
      status: "processed",
      external_id: "status-comment",
      external_url: "https://linear.test/comment/status-updated",
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
      "**Your move: nothing — fresh (stage 1 of 3).**"
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
      "**Your move: nothing — resume (stage 2 of 3).**"
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
      "**Your move: nothing — fresh (stage 1 of 3).**"
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
      "**Your move: nothing — resume (stage 2 of 3).**"
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
      "**Your move: nothing — fresh (stage 1 of 3).**"
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
      "**Your move: decision required — Choose whether to continue in the Linear session. (stage 1 of 3).**"
    );
    expect(needsHuman.body).toContain("**Why:** Choose whether to continue in the Linear session.");
    expect(needsHuman.body).toContain("**Asked:** Choose whether to continue in the Linear session.");

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
      "**Your move: nothing — waiting on GitHub: GitHub checks are still running (stage 2 of 3).**"
    );
  });

  it.each([
    [
      "shipped",
      "The job shipped.",
      /^\*\*Your move: nothing — this run is finished\. The job shipped\./m,
    ],
    [
      "no_change",
      "The job finished because no code change was needed; no pull request was created.",
      "**Your move: nothing — this run is finished. The job finished because no code change was needed; no pull request was created.**",
    ],
    [
      "needs_human",
      "The job needs a human decision before it can finish: Pick a deployment target. The workspace is preserved.",
      "**Your move: decision required — Pick a deployment target (stage 1 of 1).**",
    ],
    [
      "failed",
      "The job failed: Daytona could not provision the sandbox.",
      "**Your move: nothing — this run is finished. The job failed: Daytona could not provision the sandbox.**",
    ],
    [
      "canceled",
      "The job was canceled before it could finish.",
      "**Your move: nothing — this run is finished. The job was canceled before it could finish.**",
    ],
    [
      "superseded",
      "The job was superseded by a newer run.",
      "**Your move: nothing — this run is finished. The job was superseded by a newer run.**",
    ],
  ] as const)("renders the %s terminal job outcome honestly", (outcome, sentence, turnLine) => {
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
    expectReceiptShape(publication.body, turnLine);
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
    expect(getLinearOutbox(firstPublication.id)).toBeUndefined();
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
    expect(getLinearOutbox(publication.id)?.attachment_url)
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
    const status = listLinearOutbox().find((row) => row.kind === "pipeline_status")!;
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
    expect(getLinearOutbox(status.id)).toMatchObject({
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
          commandName: "test",
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
          commandName: "test",
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
