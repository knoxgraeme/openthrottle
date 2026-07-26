import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { drainDeferredProviderEvidence, evaluateStageGate, processStageEvidence } from "./gates.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  type PipelineManifest,
  type PipelineStage,
  type StageOutcome,
} from "./manifest.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent, type PipelineEventArtifact } from "./coordinator.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import type { PipelineInstance, PipelineStageAttempt, PipelineStore } from "./store.js";
import { buildInstalledRuntimeDescriptor } from "../runtime/contracts.js";
import { processPipelineInfrastructureFailure } from "./control.js";
import { drainPipelineFeedbackSnapshots, handleGithubEvent, routePipelineProviderEvent } from "../providers/github/events.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("gate-test/v1");
const SUBJECT = "c".repeat(40);

function completeStageAttemptActor(
  store: PipelineStore,
  tickets: SupervisorStore,
  event: PipelineCoordinatorEvent,
  options: { observedSubject?: string; faultAfterWrite?: (writeCount: number) => void } = {}
): PipelineInstance {
  const evaluated = evaluateStageGate(store, event, options);
  if (!event.runId) throw new Error(`pipeline stage event ${event.id} has no run binding`);
  return tickets.finishRunAndThen(
    {
      runId: event.runId,
      status: "completed",
      exitCode: 0,
      ticketState: "active",
    },
    () => coordinatePipelineEvent(store, evaluated.event, options.faultAfterWrite, evaluated.receipt)
  );
}

interface Fixture {
  db: Database.Database;
  tickets: SupervisorStore;
  pipelines: PipelineStore;
  manifest: PipelineManifest;
  stage: PipelineStage;
  instance: PipelineInstance;
  attempt: PipelineStageAttempt;
}

describe("deterministic supervisor stage gates", () => {
  let database: Database.Database | undefined;
  afterEach(() => database?.close());

  function setup(manifestKey = "ce/investigate@2"): Fixture {
    database = openDb(":memory:");
    const pipelines = createPipelineStore(database);
    const tickets = createSupervisorStore(database, pipelines);
    const catalog = loadPipelineCatalog(
      manifestKey.startsWith("fixture/") ? catalogPath : shippedCatalogPath,
      runtime.descriptor
    );
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { investigate: ce/investigate@2 }\ntest: npm test\n");
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
        taskType: manifestKey.startsWith("ce/investigate") ? "investigate" : "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: manifestKey.startsWith("ce/investigate") ? "investigate" : "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    const boundAttempt = pipelines.getAttempt(attempt.id)!;
    return {
      db: database,
      tickets,
      pipelines,
      manifest: manifest.manifest,
      stage: manifest.manifest.stages.find((candidate) => candidate.id === attempt.stage_id)!,
      instance,
      attempt: boundAttempt,
    };
  }

  function artifact(
    fixture: Fixture,
    kind: string,
    result: StageOutcome | "not_configured",
    options: {
      findings?: Array<{ severity: "P0" | "P1" | "P2" | "P3"; code: string; summary: string }>;
      details?: Record<string, unknown>;
      summary?: string;
      assurance?: "semantic_attested" | "executor_verified";
    } = {}
  ): PipelineEventArtifact {
    const assurance = options.assurance ?? fixture.stage.evaluator.assurance;
    const payload = canonicalJson({
      schema: `openthrottle.artifact/${kind}@1`,
      kind,
      producer: {
        capability: fixture.stage.executor.capability,
        runtime_release: fixture.instance.runtime_release,
        capability_digest: fixture.instance.capability_digest,
        version: 1,
      },
      pipeline: {
        instance_id: fixture.instance.id,
        manifest_digest: fixture.instance.manifest_digest,
      },
      stage: {
        id: fixture.stage.id,
        attempt_id: fixture.attempt.id,
        request_hash: fixture.attempt.request_hash,
        context_revision: fixture.attempt.context_revision,
        context_policy: fixture.attempt.native_context_policy,
      },
      run: {
        id: fixture.attempt.planned_run_id!,
        ticket_id: fixture.instance.linear_issue_id,
        session_id: fixture.instance.linear_session_id,
        generation: fixture.instance.generation,
        native_session_id: null,
      },
      repository: {
        name: fixture.instance.repository,
        base_commit: fixture.instance.base_commit,
        subject: SUBJECT,
        pre_subject: fixture.instance.base_commit,
        post_subject: SUBJECT,
      },
      assurance,
      result,
      summary: options.summary ?? "Bounded stage evidence",
      evidence: ["executor evidence"],
      findings: options.findings ?? [],
      actions: [],
      uncertainty: [],
      started_at: "2026-07-22T00:00:00.000Z",
      completed_at: "2026-07-22T00:00:01.000Z",
      details: options.details ?? { proposal_schema: "openthrottle.stage-proposal/v1" },
    });
    return { kind, schemaVersion: 1, assurance, subject: SUBJECT, payload, hash: digestNormalized(payload) };
  }

  function event(fixture: Fixture, result: StageOutcome | "not_configured" = "success", options: {
    findings?: Array<{ severity: "P0" | "P1" | "P2" | "P3"; code: string; summary: string }>;
    details?: Record<string, unknown>;
    summary?: string;
  } = {}): PipelineCoordinatorEvent {
    const kinds = ["stage_result", ...fixture.stage.evaluator.required_artifacts]
      .filter((kind, index, values) => values.indexOf(kind) === index);
    const artifacts = kinds.map((kind) => artifact(fixture, kind, result, options));
    return {
      id: `event-${digestNormalized(canonicalJson([result, options])).slice(0, 16)}`,
      kind: "stage_result",
      instanceId: fixture.instance.id,
      generation: fixture.instance.generation,
      runId: fixture.attempt.planned_run_id!,
      stageId: fixture.stage.id,
      attemptId: fixture.attempt.id,
      requestHash: fixture.attempt.request_hash,
      outcome: result === "not_configured" ? "no_change" : result,
      resultHash: artifacts.find((candidate) => candidate.kind === "stage_result")!.hash,
      subject: SUBJECT,
      artifacts,
    };
  }

  it("creates an identical canonical receipt for identical evidence", () => {
    const fixture = setup();
    const input = event(fixture);
    const first = evaluateStageGate(fixture.pipelines, input, { observedSubject: SUBJECT });
    const second = evaluateStageGate(fixture.pipelines, input, { observedSubject: SUBJECT });
    expect(first).toEqual(second);
    expect(first.receipt.hash).toBe(digestNormalized(first.receipt.payload));
    expect(first.receipt.result).toBe("passed");
    expect(first.event.outcome).toBe("success");
  });

  it("lets blocking P0/P1 evidence override success prose and the proposed result", () => {
    const fixture = setup();
    const evaluated = evaluateStageGate(fixture.pipelines, event(fixture, "success", {
      findings: [{ severity: "P1", code: "unsafe-change", summary: "The change is not safe." }],
      summary: "Everything passed successfully.",
    }));
    expect(evaluated.event.outcome).toBe("semantic_repair_required");
    expect(evaluated.receipt.result).toBe("failed");
    expect(JSON.parse(evaluated.receipt.payload)).toMatchObject({
      proposed_result: "success",
      outcome: "semantic_repair_required",
      reason: "blocking_findings",
    });
  });

  it("derives command decisions only from executor evidence", () => {
    const fixture = setup("fixture/command@1");
    const cases: Array<[Record<string, unknown>, StageOutcome | "not_configured", StageOutcome, string]> = [
      [{ not_configured: false, timed_out: false, exit_code: 0, signal: null }, "success", "success", "passed"],
      [{ not_configured: false, timed_out: false, exit_code: 2, signal: null }, "failure", "failure", "failed"],
      [{ not_configured: false, timed_out: false, exit_code: 137, signal: null }, "retryable_infrastructure_failure", "retryable_infrastructure_failure", "indeterminate"],
      [{ not_configured: false, timed_out: false, exit_code: null, signal: "SIGKILL" }, "retryable_infrastructure_failure", "retryable_infrastructure_failure", "indeterminate"],
      [{ not_configured: true, timed_out: false, exit_code: null, signal: null }, "not_configured", "no_change", "not_configured"],
    ];
    for (const [details, proposed, outcome, result] of cases) {
      const evaluated = evaluateStageGate(fixture.pipelines, event(fixture, proposed, { details }));
      expect(evaluated.event.outcome).toBe(outcome);
      expect(evaluated.receipt.result).toBe(result);
    }
  });

  it("rejects wrong request, run, generation, assurance, secret, and current-tree fences", () => {
    const fixture = setup();
    const input = event(fixture);
    expect(() => evaluateStageGate(fixture.pipelines, { ...input, requestHash: "0".repeat(64) })).toThrow(/attempt fence/);
    expect(() => evaluateStageGate(fixture.pipelines, { ...input, runId: "run-stale" })).toThrow(/run fence/);
    expect(() => evaluateStageGate(fixture.pipelines, { ...input, generation: 2 })).toThrow(/generation is stale/);
    expect(() => evaluateStageGate(fixture.pipelines, input, { observedSubject: "d".repeat(40) })).toThrow(/workspace changed/);
    expect(() => evaluateStageGate(fixture.pipelines, { ...input, artifacts: [] })).toThrow(/missing required/);

    const wrongSchema = event(fixture);
    wrongSchema.artifacts![0] = { ...wrongSchema.artifacts![0]!, schemaVersion: 2 };
    expect(() => evaluateStageGate(fixture.pipelines, wrongSchema)).toThrow(/schema version/);

    const wrongHash = event(fixture);
    wrongHash.artifacts![0] = { ...wrongHash.artifacts![0]!, hash: "0".repeat(64) };
    wrongHash.resultHash = "0".repeat(64);
    expect(() => evaluateStageGate(fixture.pipelines, wrongHash)).toThrow(/hash mismatch/);

    const wrongSession = event(fixture);
    const wrongSessionPayload = JSON.parse(wrongSession.artifacts![0]!.payload);
    wrongSessionPayload.run.session_id = "session-stale";
    wrongSession.artifacts![0]!.payload = canonicalJson(wrongSessionPayload);
    wrongSession.artifacts![0]!.hash = digestNormalized(wrongSession.artifacts![0]!.payload);
    wrongSession.resultHash = wrongSession.artifacts![0]!.hash;
    expect(() => evaluateStageGate(fixture.pipelines, wrongSession)).toThrow(/provenance fence/);

    const wrongAssurance = event(fixture);
    wrongAssurance.artifacts![0] = artifact(fixture, "stage_result", "success", { assurance: "executor_verified" });
    wrongAssurance.resultHash = wrongAssurance.artifacts![0]!.hash;
    expect(() => evaluateStageGate(fixture.pipelines, wrongAssurance)).toThrow(/assurance mismatch/);

    const leaked = event(fixture, "success", { summary: "Bearer secret-token-value" });
    expect(() => evaluateStageGate(fixture.pipelines, leaked)).toThrow(/secret-shaped/);

    const oversized = event(fixture, "success", { details: { output: "x".repeat(13 * 1024) } });
    expect(() => evaluateStageGate(fixture.pipelines, oversized)).toThrow(/size limit/);

    fixture.db.prepare("UPDATE pipeline_stage_attempts SET native_session_id = ? WHERE id = ?")
      .run("native-original", fixture.attempt.id);
    expect(() => evaluateStageGate(fixture.pipelines, input)).toThrow(/native session fence/);
  });

  it("commits the receipt, artifacts, transition, and effects atomically", () => {
    const fixture = setup();
    const input = event(fixture);
    expect(() => processStageEvidence(fixture.pipelines, input, {
      observedSubject: SUBJECT,
      faultAfterWrite: (count) => {
        if (count === 3) throw new Error("fault after receipt boundary");
      },
    })).toThrow(/fault after receipt boundary/);
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.state_version).toBe(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM pipeline_gate_receipts").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM pipeline_artifacts").get()).toEqual({ count: 0 });

    const completed = processStageEvidence(fixture.pipelines, input, { observedSubject: SUBJECT });
    expect(completed).toMatchObject({ status: "dispatchable", active_stage_id: "publish" });
    expect(fixture.db.prepare(
      "SELECT evaluator_kind, result, payload, receipt_hash FROM pipeline_gate_receipts"
    ).get()).toMatchObject({ evaluator_kind: "semantic", result: "passed" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM pipeline_artifacts").get()).toEqual({ count: 2 });
  });

  it("settles the actor and pipeline transition in one replayable transaction", () => {
    const fixture = setup();
    const input = event(fixture);
    expect(() => completeStageAttemptActor(fixture.pipelines, fixture.tickets, input, {
      observedSubject: SUBJECT,
      faultAfterWrite: (count) => {
        if (count === 3) throw new Error("fault after run settlement");
      },
    })).toThrow(/fault after run settlement/);
    expect(fixture.tickets.getRun(input.runId!)?.status).toBe("running");
    expect(fixture.tickets.getByIssueId("issue-1")?.run_id).toBe(input.runId);
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.state_version).toBe(0);

    const completed = completeStageAttemptActor(
      fixture.pipelines,
      fixture.tickets,
      input,
      { observedSubject: SUBJECT }
    );
    expect(completed).toMatchObject({ status: "dispatchable", active_stage_id: "publish" });
    expect(fixture.tickets.getRun(input.runId!)?.status).toBe("completed");
    expect(fixture.tickets.getByIssueId("issue-1")?.run_id).toBeNull();
  });

  it("accepts restored fresh-review evidence and enters the bounded semantic-repair transition", () => {
    const fixture = setup();
    const input = event(fixture, "semantic_repair_required", {
      findings: [{
        severity: "P1",
        code: "review-mutated-workspace",
        summary: "Read-only review changed the gated tree.",
      }],
    });

    const transitioned = completeStageAttemptActor(
      fixture.pipelines,
      fixture.tickets,
      input,
      { observedSubject: SUBJECT }
    );

    expect(transitioned).toMatchObject({ status: "dispatchable", immutable_subject: SUBJECT });
    expect(fixture.tickets.getRun(input.runId!)?.status).toBe("completed");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "investigate",
      expected_subject: SUBJECT,
      reentry_ordinal: 1,
    });
  });

  it("turns an executor lease expiry into a bounded coordinator retry without semantic artifacts", () => {
    const fixture = setup();
    const transitioned = processPipelineInfrastructureFailure({
      store: fixture.pipelines,
      runId: fixture.attempt.planned_run_id!,
    });

    expect(transitioned).toMatchObject({ status: "dispatchable", active_stage_id: "investigate" });
    expect(fixture.pipelines.getAttempt(fixture.attempt.id)).toMatchObject({
      status: "failed",
      outcome: "retryable_infrastructure_failure",
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "investigate",
      reentry_ordinal: 1,
    });
    expect(fixture.db.prepare(
      "SELECT kind, status FROM pipeline_inbox_events WHERE id = ?"
    ).get(`pipeline-run-failed:${fixture.attempt.planned_run_id}`)).toEqual({
      kind: "effect_failed",
      status: "consumed",
    });

    expect(processPipelineInfrastructureFailure({
      store: fixture.pipelines,
      runId: fixture.attempt.planned_run_id!,
    })).toMatchObject({ state_version: transitioned!.state_version });
  });

  it("pins the exact provider commit when the agent-backed publish gate passes", () => {
    const fixture = setup("ce/implement@2");
    const stage = fixture.manifest.stages.find((candidate) => candidate.id === "publish")!;
    const publishedCommit = "e".repeat(40);
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'publish', native_context_policy = 'resume_required'
      WHERE id = ?
    `).run(fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', active_stage_id = 'publish' WHERE id = ?
    `).run(fixture.instance.id);
    const publishFixture: Fixture = {
      ...fixture,
      stage,
      attempt: fixture.pipelines.getAttempt(fixture.attempt.id)!,
    };
    const input = event(publishFixture, "success", {
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: publishedCommit,
      },
    });

    expect(evaluateStageGate(fixture.pipelines, input).event.providerRevision).toBe(publishedCommit);
    expect(processStageEvidence(fixture.pipelines, input)).toMatchObject({
      status: "waiting_provider",
      published_commit: publishedCommit,
    });

    const missing = event(publishFixture, "success");
    expect(() => evaluateStageGate(fixture.pipelines, missing)).toThrow(/provider commit/);
  });

  it("keeps non-blocking publication diagnostics on the bounded publish retry", () => {
    const fixture = setup("ce/implement@2");
    const stage = fixture.manifest.stages.find((candidate) => candidate.id === "publish")!;
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'publish', native_context_policy = 'resume_required'
      WHERE id = ?
    `).run(fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', active_stage_id = 'publish' WHERE id = ?
    `).run(fixture.instance.id);
    const publishFixture: Fixture = {
      ...fixture,
      stage,
      attempt: fixture.pipelines.getAttempt(fixture.attempt.id)!,
    };
    const input = event(publishFixture, "retryable_infrastructure_failure", {
      findings: [{
        severity: "P2",
        code: "publish-reconciliation-incomplete",
        summary: "Publication needs a bounded reconciliation retry.",
      }],
    });

    const evaluated = evaluateStageGate(fixture.pipelines, input);
    expect(evaluated.event.outcome).toBe("retryable_infrastructure_failure");
    expect(evaluated.receipt.result).toBe("indeterminate");

    const transitioned = processStageEvidence(fixture.pipelines, input);
    expect(transitioned).toMatchObject({ status: "dispatchable", active_stage_id: "publish" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "publish",
      reentry_ordinal: 1,
    });
  });

  it("turns supervisor-owned provider evidence into a fenced terminal receipt", () => {
    const fixture = setup("ce/implement@2");
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?, native_session_id = 'native-1'
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'completion_pending_publication', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);

    const providerInput = {
      id: "provider-success-1",
      instanceId: fixture.instance.id,
      outcome: "success" as const,
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      providerPayload: { merged: true, head_sha: "d".repeat(40) },
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    expect(routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-synchronize-published-commit",
      outcome: "needs_human",
      summary: "The pull-request head synchronized.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { action: "synchronize" },
      headSha: SUBJECT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.status)
      .toBe("completion_pending_publication");
    expect(fixture.pipelines.getInboxEvent("provider-synchronize-published-commit")).toBeUndefined();
    expect(routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: providerInput.id,
      outcome: providerInput.outcome,
      summary: providerInput.summary,
      evidence: providerInput.evidence,
      payload: providerInput.providerPayload,
      headSha: SUBJECT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    const deferred = fixture.pipelines.getInstance(fixture.instance.id)!;

    expect(deferred.status).toBe("completion_pending_publication");
    expect(fixture.pipelines.getInboxEvent(providerInput.id)?.status).toBe("pending");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM pipeline_gate_receipts").pluck().get()).toBe(0);

    fixture.db.prepare("UPDATE pipeline_instances SET status = 'waiting_provider' WHERE id = ?")
      .run(fixture.instance.id);
    expect(drainDeferredProviderEvidence(fixture.pipelines)).toBe(1);
    const completed = fixture.pipelines.getInstance(fixture.instance.id)!;

    expect(completed).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    expect(routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: providerInput.id,
      outcome: providerInput.outcome,
      summary: providerInput.summary,
      evidence: providerInput.evidence,
      payload: providerInput.providerPayload,
      headSha: SUBJECT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.pipelines.getInstance(fixture.instance.id))
      .toMatchObject({ status: "completion_pending_publication", terminal_outcome: "shipped" });
    expect(fixture.db.prepare(
      "SELECT evaluator_kind, result FROM pipeline_gate_receipts WHERE attempt_id = ?"
    ).get(fixture.attempt.id)).toEqual({ evaluator_kind: "provider", result: "passed" });
  });

  it.each([
    { merged: true, terminalOutcome: "shipped" },
    { merged: false, terminalOutcome: "no_change" },
  ])("preserves deferred close evidence when merged=$merged during publication", async ({ merged, terminalOutcome }) => {
    const fixture = setup("ce/implement@2");
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'completion_pending_publication', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      {} as never,
      {
        kind: "pull_request",
        action: "closed",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged,
          head: { ref: "ot/issue-1", sha: SUBJECT },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );

    const providerEventId = `github-pull-closed:1:${SUBJECT}`;
    expect(fixture.pipelines.getInboxEvent(providerEventId)?.status).toBe("pending");
    expect(fixture.pipelines.getAttempt(fixture.attempt.id)?.status).toBe("pending");
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.terminal_outcome).toBeNull();

    fixture.db.prepare("UPDATE pipeline_instances SET status = 'waiting_provider' WHERE id = ?")
      .run(fixture.instance.id);
    expect(drainDeferredProviderEvidence(fixture.pipelines)).toBe(1);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: terminalOutcome,
    });
  });

  it("treats unmarked feedback as human and marker-bearing bodies as the pipeline's own, regardless of author", async () => {
    const fixture = setup("ce/implement@2");
    const publishActivity = vi.fn(async () => undefined);
    const activityPublisher = { publishActivity, publishError: vi.fn(async () => undefined) };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    const review = (id: number, body?: string) => handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          head: { ref: "ot/issue-1", sha: SUBJECT },
          base: { ref: "main" },
        },
        review: {
          id,
          state: "commented",
          body,
          html_url: `https://github.com/owner/repo/pull/1#pullrequestreview-${id}`,
          // The solo operator IS the token account; authorship no longer skips.
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );

    await review(11, "please rename the helper before merging");
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);

    // The supervisor's own gate summary carries the enforced marker prefix and
    // must never come back as feedback, even from the same shared account.
    await review(12, "<!-- openthrottle:pipeline-summary:pipeline-1 -->\nGate summary body");
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 31,
          body: "<!-- openthrottle:pipeline-summary:pipeline-1 -->\nGate summary body",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-31",
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);
    expect(publishActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "PR comment" }),
      expect.anything()
    );

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 32,
          body: "the retry loop still double-counts attempts",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-32",
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );
    // Events on the same PR head coalesce into one snapshot; the human comment
    // joins the human review as a second provider event inside it.
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM provider_events").get())
      .toEqual({ count: 2 });
  });

  it("publishes Linear activity for GitHub review and CI completion events through the injected port", async () => {
    const fixture = setup("ce/implement@2");
    const publishActivity = vi.fn(async () => undefined);
    const activityPublisher = {
      publishActivity,
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          head: { ref: "ot/issue-1", sha: SUBJECT },
          base: { ref: "main" },
        },
        review: {
          id: 10,
          state: "approved",
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-10",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "workflow_run",
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: {
          id: 20,
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_branch: "ot/issue-1",
          head_sha: SUBJECT,
          html_url: "https://github.com/owner/repo/actions/runs/20",
        },
      },
      fixture.pipelines
    );

    expect(publishActivity).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      type: "action",
      action: "PR review submitted",
      parameter: "reviewer: approved",
      result: "https://github.com/owner/repo/pull/1#pullrequestreview-10",
    }, "issue-1");
    expect(publishActivity).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      type: "action",
      action: "CI completed",
      parameter: "success",
      result: "https://github.com/owner/repo/actions/runs/20",
    }, "issue-1");
  });

  it("fails closed when GitHub's current head differs from the executor-verified commit", () => {
    const fixture = setup("ce/implement@2");
    const observedHead = "d".repeat(40);
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", observedHead);

    expect(routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-head-drift-1",
      outcome: "success",
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { merged: true },
      headSha: observedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "needs_human",
    });
    expect(fixture.db.prepare(
      "SELECT evaluator_kind, result FROM pipeline_gate_receipts WHERE attempt_id = ?"
    ).get(fixture.attempt.id)).toEqual({ evaluator_kind: "provider", result: "failed" });
  });

  it("coalesces feedback arriving during repair and replays a claimed snapshot at provider wait", () => {
    const fixture = setup("ce/implement@2");
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(SUBJECT, fixture.instance.id);
    const route = (id: string) => routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: id,
      outcome: "semantic_repair_required",
      summary: `Feedback ${id}`,
      evidence: [`https://github.com/owner/repo/pull/1#${id}`],
      payload: { kind: "review", id },
      headSha: SUBJECT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });

    expect(route("review-during-repair-1")).toBe(true);
    expect(route("ci-during-repair-2")).toBe(true);
    const snapshot = fixture.db.prepare("SELECT * FROM feedback_snapshots").get() as { id: string; work_item_id: string };
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(2);
    const claimed = fixture.tickets.claimFeedbackSnapshot(snapshot.id, Number.MAX_SAFE_INTEGER);
    expect(claimed).toMatchObject({
      status: "claimed",
      snapshot: { repair_round: 1 },
    });
    expect(claimed.status === "claimed" && claimed.events.map((event) => event.provider_event_id).sort())
      .toEqual(["ci-during-repair-2", "review-during-repair-1"]);

    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET status = 'passed'
      WHERE pipeline_instance_id = ? AND stage_id = 'implementation'
    `).run(fixture.instance.id);
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET status = 'waiting'
      WHERE pipeline_instance_id = ? AND stage_id = 'provider'
    `).run(fixture.instance.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider', immutable_subject = ?
      WHERE id = ?
    `).run(SUBJECT, fixture.instance.id);

    expect(drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "implementation",
      reentry_ordinal: 1,
    });
    expect(drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(0);
  });
});
