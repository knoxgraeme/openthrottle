import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { drainDeferredProviderEvidence, evaluateStageGate, processProviderEvidence } from "./gates.js";
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
import { completeStageAttemptActor } from "./settlement.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import type { PipelineInstance, PipelineStageAttempt, PipelineStore } from "./store.js";
import type { FeedbackSnapshot } from "../persistence/feedback-store.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";
import { processPipelineInfrastructureFailure } from "./control.js";
import { createStageRequestHash, type StageRequestEnvelope } from "./stage-request.js";
import {
  drainPipelineFeedbackSnapshots,
  processPipelineFeedbackSnapshot,
  recordPipelineProviderEvent,
} from "../app/provider-feedback.js";
import { handleGithubEvent, routePipelineProviderEvent } from "../providers/github/events.js";
import { beginGithubSupervisorCommentWrite } from "../providers/github/comment-provenance.js";
import { createLinearOutboxProcessor } from "../providers/linear/outbox.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("gate-test/v1");
const SUBJECT = "c".repeat(40);
const PUBLISHED_COMMIT = "9".repeat(40);
const CODEX_CONNECTOR_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE =
  "To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).";

function codexCleanReviewBody(
  reviewedCommit = PUBLISHED_COMMIT.slice(0, 10),
  encouragement = "Delightful!"
): string {
  return [
    "Codex Review: Didn't find any major issues.",
    "",
    encouragement,
    "",
    `**Reviewed commit:** \`${reviewedCommit}\``,
    "",
    "<details>",
    "<summary>About Codex in GitHub</summary>",
    "",
    "Codex can help review pull requests from GitHub.",
    "</details>",
  ].join("\n");
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
  afterEach(() => {
    vi.unstubAllGlobals();
    database?.close();
  });

  function processStageEvidence(
    store: PipelineStore,
    event: PipelineCoordinatorEvent,
    options: { observedSubject?: string; faultAfterWrite?: (writeCount: number) => void } = {}
  ): PipelineInstance {
    const evaluated = evaluateStageGate(store, event, options);
    return coordinatePipelineEvent(store, evaluated.event, options.faultAfterWrite, evaluated.receipt);
  }

  function overrideManifest(
    catalog: ReturnType<typeof loadPipelineCatalog>,
    manifestKey: string,
    overrides: Partial<Pick<PipelineManifest, "max_attempts">>
  ): void {
    if (Object.keys(overrides).length === 0) return;
    const selected = catalog.manifests.get(manifestKey)!;
    const manifest = { ...selected.manifest, ...overrides };
    const normalized = canonicalJson(manifest);
    (catalog.manifests as Map<string, typeof selected>).set(manifestKey, {
      manifest,
      normalized,
      digest: digestNormalized(normalized),
    });
    const catalogNormalized = canonicalJson({
      aliases: catalog.aliases,
      manifests: [...catalog.manifests.values()].map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        digest: entry.digest,
      })).sort((left, right) =>
        `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)
      ),
    });
    (catalog as {
      normalized: string;
      digest: string;
    }).normalized = catalogNormalized;
    (catalog as {
      normalized: string;
      digest: string;
    }).digest = digestNormalized(catalogNormalized);
  }

  function setup(
    manifestKey = "core/investigate@1",
    options: { maxAttempts?: number } = {}
  ): Fixture {
    database = openDb(":memory:");
    const pipelines = createPipelineStore(database);
    const tickets = createSupervisorStore(database, pipelines);
    const catalog = loadPipelineCatalog(
      manifestKey.startsWith("fixture/") ? catalogPath : shippedCatalogPath,
      runtime.descriptor
    );
    overrideManifest(catalog, manifestKey, {
      ...(options.maxAttempts === undefined ? {} : { max_attempts: options.maxAttempts }),
    });
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { investigate: core/investigate@1 }\ntest: npm test\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get(manifestKey)!;
    tickets.upsert({
      ticket_id: "issue-1",
      ticket_reference: "ISSUE-1",
      session_id: "session-1",
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
        taskType: manifestKey.startsWith("core/investigate") ? "investigate" : "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: manifestKey.startsWith("core/investigate") ? "investigate" : "implement",
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

  function moveFixtureToProviderWait(
    fixture: Fixture,
    subject = SUBJECT,
    publishedCommit = PUBLISHED_COMMIT
  ): void {
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(subject, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET status = 'waiting'
      WHERE pipeline_instance_id = ? AND stage_id = 'provider'
    `).run(fixture.instance.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(subject, publishedCommit, subject, fixture.instance.id);
    fixture.tickets.setSetting("github-head:issue-1", publishedCommit);
  }

  async function acknowledgeGithubControlGate(
    fixture: Fixture,
    resumeStatus: "canceled" | "shipped"
  ): Promise<void> {
    const row = fixture.db.prepare(`
      SELECT outbox.id
      FROM control_outbox outbox
      JOIN pipeline_publication_receipts receipt ON receipt.id = outbox.id
      WHERE receipt.pipeline_instance_id = ? AND receipt.resume_status = ?
      ORDER BY receipt.created_at DESC, receipt.id DESC
      LIMIT 1
    `).get(fixture.instance.id, resumeStatus) as { id: string } | undefined;
    expect(row).toBeDefined();
    const getLinearClient = vi.fn(async () => undefined);
    const processor = createLinearOutboxProcessor({
      store: fixture.tickets,
      getLinearClient,
    });
    for (let pass = 0; pass < 10; pass += 1) {
      await processor.drain(50);
      if (fixture.pipelines.getInstance(fixture.instance.id)?.status === resumeStatus) break;
    }
    expect(getLinearClient).not.toHaveBeenCalled();
    expect(fixture.db.prepare(`
      SELECT status FROM pipeline_publication_receipts WHERE id = ?
    `).pluck().get(row!.id)).toBe("acknowledged");
  }

  async function closeGithubIssue(fixture: Fixture): Promise<void> {
    const closedAt = "2098-01-01T00:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/repo/issues/1/events?per_page=100")) {
        return Response.json([{
          id: 101,
          event: "closed",
          created_at: closedAt,
          actor: { login: "operator" },
        }]);
      }
      if (url.endsWith("/repos/owner/repo/issues/1")) {
        return Response.json({
          state: "closed",
          updated_at: closedAt,
          labels: [],
        });
      }
      return Response.json({ permission: "write" });
    }));
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      {} as never,
      {
        kind: "issues",
        action: "closed",
        repository: { full_name: "owner/repo" },
        sender: { login: "operator" },
        issue: {
          number: 1,
          title: "Ship the provider path",
          html_url: "https://github.com/owner/repo/issues/1",
          state: "closed",
          closed_at: closedAt,
          updated_at: closedAt,
        },
      },
      fixture.pipelines
    );
  }

  function recordAcknowledgedPublication(
    fixture: Fixture,
    subject: string,
    options: {
      publishedCommit?: string;
      providerRevision?: string;
    } = {},
    id = `publication-${subject.slice(0, 8)}`
  ): void {
    const details = {
      ...(options.publishedCommit ? { published_commit: options.publishedCommit } : {}),
      ...(options.providerRevision ? { provider_revision: options.providerRevision } : {}),
    };
    const payload = canonicalJson({
      decision: { subject },
      ...(Object.keys(details).length > 0 ? {
        artifact_inline: canonicalJson([{
          kind: "stage_result",
          assurance: "executor_verified",
          subject,
          hash: digestNormalized(canonicalJson(details)),
          payload: {
            result: "success",
            details,
          },
        }]),
      } : {}),
    });
    fixture.db.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, attempt_id, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at,
        created_at, updated_at, acknowledged_at
      ) VALUES (?, ?, ?, 'control_ledger', ?, ?, ?, 'acknowledged', 0, ?, ?, ?, ?)
    `).run(
      id,
      fixture.instance.id,
      fixture.attempt.id,
      `publication:${id}`,
      payload,
      digestNormalized(payload),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
  }

  function firstProviderStagePayload(fixture: Fixture): string | undefined {
    const payloads = fixture.db.prepare("SELECT payload FROM pipeline_artifacts WHERE kind = 'stage_result'")
      .all() as Array<{ payload: string }>;
    return payloads.map((row) => JSON.parse(row.payload) as { details?: { events?: Array<{ payload: string }> } })
      .find((payload) => payload.details?.events)?.details?.events?.[0]?.payload;
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
      subject?: string;
      preSubject?: string;
    } = {}
  ): PipelineEventArtifact {
    const assurance = options.assurance ?? fixture.stage.evaluator.assurance;
    const subject = options.subject ?? SUBJECT;
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
        ticket_id: fixture.instance.ticket_id,
        session_id: fixture.instance.session_id,
        generation: fixture.instance.generation,
        native_session_id: null,
      },
      repository: {
        name: fixture.instance.repository,
        base_commit: fixture.instance.base_commit,
        subject,
        pre_subject: options.preSubject ?? fixture.attempt.expected_subject ?? fixture.instance.base_commit,
        post_subject: subject,
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
    return { kind, schemaVersion: 1, assurance, subject, payload, hash: digestNormalized(payload) };
  }

  function event(fixture: Fixture, result: StageOutcome | "not_configured" = "success", options: {
    findings?: Array<{ severity: "P0" | "P1" | "P2" | "P3"; code: string; summary: string }>;
    details?: Record<string, unknown>;
    summary?: string;
    subject?: string;
    preSubject?: string;
    id?: string;
  } = {}): PipelineCoordinatorEvent {
    const kinds = ["stage_result", ...fixture.stage.evaluator.required_artifacts]
      .filter((kind, index, values) => values.indexOf(kind) === index);
    const artifacts = kinds.map((kind) => artifact(fixture, kind, result, options));
    return {
      id: options.id ?? `event-${digestNormalized(canonicalJson([result, options])).slice(0, 16)}`,
      kind: "stage_result",
      instanceId: fixture.instance.id,
      generation: fixture.instance.generation,
      runId: fixture.attempt.planned_run_id!,
      stageId: fixture.stage.id,
      attemptId: fixture.attempt.id,
      requestHash: fixture.attempt.request_hash,
      outcome: result === "not_configured" ? "no_change" : result,
      resultHash: artifacts.find((candidate) => candidate.kind === "stage_result")!.hash,
      subject: options.subject ?? SUBJECT,
      artifacts,
    };
  }

  function withNativeSession(
    input: PipelineCoordinatorEvent,
    nativeSessionId: string
  ): PipelineCoordinatorEvent {
    const artifacts = input.artifacts!.map((artifact) => {
      const payload = JSON.parse(artifact.payload) as { run: { native_session_id: string | null } };
      payload.run.native_session_id = nativeSessionId;
      const serialized = canonicalJson(payload);
      return { ...artifact, payload: serialized, hash: digestNormalized(serialized) };
    });
    return {
      ...input,
      nativeSessionId,
      artifacts,
      resultHash: artifacts.find((artifact) => artifact.kind === "stage_result")!.hash,
    };
  }

  function sealLegacyContextlessRequest(fixture: Fixture, nativeSessionId: string): Fixture {
    const request = fixture.pipelines.getStageRequest(fixture.attempt.id);
    const {
      requestHash: _requestHash,
      idempotencyKey: _idempotencyKey,
      ...withoutFence
    } = request;
    const legacyWithoutFence = { ...withoutFence, nativeSessionId };
    const legacyRequest: StageRequestEnvelope = {
      ...legacyWithoutFence,
      ...createStageRequestHash(legacyWithoutFence),
    };
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET native_session_id = ?, request_payload = ?, request_hash = ?, idempotency_key = ?
      WHERE id = ?
    `).run(
      nativeSessionId,
      canonicalJson(legacyRequest),
      legacyRequest.requestHash,
      legacyRequest.idempotencyKey,
      fixture.attempt.id
    );
    return currentStageFixture(fixture);
  }

  function currentStageFixture(fixture: Fixture): Fixture {
    const instance = fixture.pipelines.getInstance(fixture.instance.id)!;
    const attempt = fixture.pipelines.getActiveAttempt(instance.id)!;
    return {
      ...fixture,
      instance,
      attempt,
      stage: fixture.manifest.stages.find((candidate) => candidate.id === attempt.stage_id)!,
    };
  }

  function startAttempt(fixture: Fixture): Fixture {
    const current = currentStageFixture(fixture);
    const request = current.pipelines.getStageRequest(current.attempt.id);
    const ticket = current.tickets.getByIssueId(current.instance.ticket_id)!;
    if (ticket.run_id !== request.runId) {
      expect(current.tickets.beginRun({
        issueId: current.instance.ticket_id,
        runId: request.runId,
        taskType: current.instance.task_type,
        tokenHash: `token-${request.runId}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      })).toBe(true);
    }
    if (!current.pipelines.getAttempt(current.attempt.id)!.run_id) {
      current.pipelines.bindStageRun(current.attempt.id, request.runId);
    }
    current.pipelines.markStageDispatched(current.attempt.id);
    return currentStageFixture(current);
  }

  function settleCurrentStage(
    fixture: Fixture,
    result: StageOutcome | "not_configured",
    options: Parameters<typeof event>[2] = {}
  ): PipelineInstance {
    const running = startAttempt(fixture);
    const input = event(running, result, {
      ...options,
      details: options.details ?? (running.stage.evaluator.kind === "command"
        ? { not_configured: false, timed_out: false, exit_code: 0, signal: null }
        : undefined),
    });
    return completeStageAttemptActor(
      running.pipelines,
      running.tickets,
      input,
      { observedSubject: options.subject ?? SUBJECT }
    );
  }

  function settleForwardChainToPublish(
    fixture: Fixture,
    subject: string,
    previousSubject: string,
    round: number
  ): PipelineInstance {
    let instance = fixture.pipelines.getInstance(fixture.instance.id)!;
    while (!["implementation", "repair_implementation"].includes(instance.active_stage_id!)) {
      const stageId = instance.active_stage_id!;
      instance = settleCurrentStage(fixture, "success", {
        id: `${stageId}-${round}`,
        subject: previousSubject,
        preSubject: previousSubject,
      });
    }
    const implementationStage = instance.active_stage_id!;
    instance = settleCurrentStage(fixture, "success", {
      id: `${implementationStage}-${round}`,
      subject,
      preSubject: previousSubject,
    });
    while (instance.active_stage_id !== "publish") {
      const stageId = instance.active_stage_id!;
      instance = settleCurrentStage(fixture, "success", {
        id: `${stageId}-${round}`,
        subject,
        preSubject: subject,
      });
    }
    return instance;
  }

  async function settleRepairRoundPublishes(fixture: Fixture, rounds: number): Promise<PipelineInstance> {
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    let instance = fixture.instance;
    let previousSubject = fixture.instance.base_commit;
    for (let round = 1; round <= rounds; round += 1) {
      const subject = `${round}`.repeat(40);
      const commit = `${String.fromCharCode(96 + round)}`.repeat(40);
      instance = settleForwardChainToPublish(fixture, subject, previousSubject, round);
      expect(instance).toMatchObject({ status: "dispatchable", active_stage_id: "publish" });

      instance = settleCurrentStage(fixture, "success", {
        id: `publish-${round}`,
        subject,
        preSubject: subject,
        details: {
          proposal_schema: "openthrottle.stage-proposal/v1",
          published_commit: commit,
          provider_revision: commit,
        },
      });
      expect(instance).toMatchObject({
        status: "waiting_provider",
        active_stage_id: "provider",
        immutable_subject: subject,
        published_commit: commit,
      });
      fixture.tickets.setSetting("github-head:issue-1", commit);

      if (round === rounds) break;

      expect(await routePipelineProviderEvent({
        pipelines: fixture.pipelines,
        store: fixture.tickets,
        ticket: fixture.tickets.getByIssueId("issue-1")!,
        eventId: `provider-repair-${round}`,
        outcome: "semantic_repair_required",
        summary: `Provider feedback for round ${round}`,
        evidence: [`https://github.com/owner/repo/pull/1#round-${round}`],
        payload: { round, head_sha: commit },
        headSha: commit,
        pullRequestUrl: "https://github.com/owner/repo/pull/1",
      })).toBe(true);

      instance = fixture.pipelines.getInstance(fixture.instance.id)!;
      expect(instance).toMatchObject({
        status: "dispatchable",
        active_stage_id: "repair_implementation",
        immutable_subject: subject,
        published_commit: commit,
      });
      expect(fixture.pipelines.getActiveAttempt(instance.id)).toMatchObject({
        stage_id: "repair_implementation",
        expected_subject: subject,
      });
      previousSubject = subject;
    }
    return instance;
  }

  it("creates an identical canonical receipt for identical evidence", async () => {
    const fixture = setup();
    const input = event(fixture);
    const first = evaluateStageGate(fixture.pipelines, input, { observedSubject: SUBJECT });
    const second = evaluateStageGate(fixture.pipelines, input, { observedSubject: SUBJECT });
    expect(first).toEqual(second);
    expect(first.receipt.hash).toBe(digestNormalized(first.receipt.payload));
    expect(first.receipt.result).toBe("passed");
    expect(first.event.outcome).toBe("success");
  });

  it("settles the sealed tree subject and rejects the integrated commit as workspace drift", async () => {
    const fixture = setup();
    const integratedCommit = "e".repeat(40);
    const canonicalTree = "9".repeat(40);
    const input = event(fixture, "success", { subject: canonicalTree });

    expect(evaluateStageGate(fixture.pipelines, input, { observedSubject: canonicalTree }).event.subject)
      .toBe(canonicalTree);
    expect(() => evaluateStageGate(fixture.pipelines, input, { observedSubject: integratedCommit }))
      .toThrow(/workspace changed after stage evidence was sealed/);
  });

  it("lets blocking P0/P1 evidence override success prose and the proposed result", async () => {
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

  it("derives command decisions only from executor evidence", async () => {
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

  it("rejects wrong request, run, generation, assurance, secret, and current-tree fences", async () => {
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

  it("accepts only the sealed legacy Linear ticket identity after v35 qualifies the durable instance", () => {
    const fixture = setup();
    const input = event(fixture);
    fixture.db.pragma("foreign_keys = OFF");
    fixture.db.prepare("UPDATE pipeline_instances SET ticket_id = 'linear:issue-1' WHERE id = ?")
      .run(fixture.instance.id);
    fixture.db.pragma("foreign_keys = ON");

    expect(() => evaluateStageGate(fixture.pipelines, input)).not.toThrow();

    const forged = event(fixture);
    const forgedPayload = JSON.parse(forged.artifacts![0]!.payload);
    forgedPayload.run.ticket_id = "other-issue";
    forged.artifacts![0]!.payload = canonicalJson(forgedPayload);
    forged.artifacts![0]!.hash = digestNormalized(forged.artifacts![0]!.payload);
    forged.resultHash = forged.artifacts![0]!.hash;
    expect(() => evaluateStageGate(fixture.pipelines, forged)).toThrow(/provenance fence/);
  });

  it("commits the receipt, artifacts, transition, and effects atomically", async () => {
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

  it("settles the actor and pipeline transition in one replayable transaction", async () => {
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

  it.each([
    { outcome: "success", faultReason: undefined, expected: null },
    { outcome: "failure", faultReason: undefined, expected: "agent" },
    // A stale "engine_crash" fallback reason (classifyLaunchFailure's generic
    // default) must not override a failure outcome into "provider" -- see
    // fault-attribution.ts's outcome-scoped lookup.
    { outcome: "failure", faultReason: "engine_crash", expected: "agent" },
    { outcome: "retryable_infrastructure_failure", faultReason: undefined, expected: "executor" },
    { outcome: "retryable_infrastructure_failure", faultReason: "credential_missing", expected: "provider" },
  ] as const)(
    "stamps the run's fault_attribution as $expected for outcome=$outcome faultReason=$faultReason",
    ({ outcome, faultReason, expected }) => {
      const fixture = setup();
      const input = faultReason ? { ...event(fixture, outcome), faultReason } : event(fixture, outcome);
      completeStageAttemptActor(fixture.pipelines, fixture.tickets, input, { observedSubject: SUBJECT });
      expect(fixture.tickets.getRun(fixture.attempt.planned_run_id!)?.fault_attribution).toBe(expected);
    }
  );

  it("accepts restored fresh-review evidence and enters the bounded semantic-repair transition", async () => {
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

  it("turns an executor lease expiry into a bounded coordinator retry without semantic artifacts", async () => {
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

  it("accepts contextless stage evidence while retaining durable native session lineage", async () => {
    const fixture = setup("fixture/command@1");
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts SET native_session_id = ? WHERE id = ?
    `).run("native-session-lineage", fixture.attempt.id);
    const contextlessFixture = currentStageFixture(fixture);
    const input = event(contextlessFixture, "success", {
      details: { not_configured: false, timed_out: false, exit_code: 0, signal: null },
    });

    const evaluated = evaluateStageGate(contextlessFixture.pipelines, input);
    expect(evaluated.event).toMatchObject({ attemptId: contextlessFixture.attempt.id });
    expect(evaluated.event.nativeSessionId).toBeUndefined();
    expect(() => evaluateStageGate(
      contextlessFixture.pipelines,
      withNativeSession(input, "native-session-lineage")
    )).toThrow(/native session fence/);
  });

  it("accepts a matching native session from a legacy contextless sealed request", async () => {
    const fixture = sealLegacyContextlessRequest(
      setup("fixture/command@1"),
      "legacy-native-session"
    );
    const input = withNativeSession(event(fixture, "success", {
      details: { not_configured: false, timed_out: false, exit_code: 0, signal: null },
    }), "legacy-native-session");

    const evaluated = evaluateStageGate(fixture.pipelines, input);
    expect(evaluated.event).toMatchObject({
      attemptId: fixture.attempt.id,
      nativeSessionId: "legacy-native-session",
    });
  });

  it("rejects a mismatching native session from a legacy contextless sealed request", async () => {
    const fixture = sealLegacyContextlessRequest(
      setup("fixture/command@1"),
      "legacy-native-session"
    );
    const input = withNativeSession(event(fixture, "success", {
      details: { not_configured: false, timed_out: false, exit_code: 0, signal: null },
    }), "wrong-native-session");

    expect(() => evaluateStageGate(fixture.pipelines, input)).toThrow(/native session fence/);
  });

  it("does not carry a prior native session into a fresh-stage infrastructure retry", async () => {
    const fixture = setup("core/implement@4");
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts SET native_session_id = ? WHERE id = ?
    `).run("native-session-before-retry", fixture.attempt.id);

    const transitioned = processPipelineInfrastructureFailure({
      store: fixture.pipelines,
      runId: fixture.attempt.planned_run_id!,
    });

    expect(transitioned).toMatchObject({ status: "dispatchable", active_stage_id: "implementation" });
    const nextAttempt = fixture.pipelines.getActiveAttempt(fixture.instance.id)!;
    expect(nextAttempt).toMatchObject({
      stage_id: "implementation",
      native_context_policy: "fresh",
      native_session_id: null,
      reentry_ordinal: 1,
    });
    expect(fixture.pipelines.getStageRequest(nextAttempt.id)).toMatchObject({
      contextPolicy: "fresh",
      nativeSessionId: null,
    });
  });

  it("pins the exact provider commit when the agent-backed publish gate passes", async () => {
    const fixture = setup("core/implement@4");
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

  it("settles a second publish after provider feedback repair re-entry", async () => {
    const fixture = setup("core/implement@4");

    const completed = await settleRepairRoundPublishes(fixture, 2);

    expect(completed).toMatchObject({
      status: "waiting_provider",
      active_stage_id: "provider",
      immutable_subject: "2".repeat(40),
      published_commit: "b".repeat(40),
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      expected_subject: "2".repeat(40),
    });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_inbox_events
      WHERE id = 'publish-2' AND status = 'consumed'
    `).get()).toEqual({ count: 1 });
    expect(fixture.db.prepare(`
      SELECT evaluator_kind, subject, result FROM pipeline_gate_receipts
      WHERE attempt_id = (
        SELECT id FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ? AND stage_id = 'publish'
        ORDER BY attempt_ordinal DESC LIMIT 1
      )
    `).get(fixture.instance.id)).toEqual({
      evaluator_kind: "publish_subject",
      subject: "2".repeat(40),
      result: "passed",
    });
    expect(fixture.db.prepare(`
      SELECT attempt_id FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ? AND kind = 'github_summary'
    `).get(fixture.instance.id)).toEqual({
      attempt_id: (fixture.db.prepare(`
        SELECT id FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ? AND stage_id = 'publish'
        ORDER BY attempt_ordinal DESC LIMIT 1
      `).pluck().get(fixture.instance.id) as string),
    });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ? AND kind = 'control_ledger'
        AND idempotency_key LIKE 'linear-wait:%:provider:%'
    `).get(fixture.instance.id)).toEqual({ count: 2 });
  });

  it("consumes the pipeline's own repair synchronize webhook when publish delivery is retrying", async () => {
    const fixture = setup("core/implement@4");
    const oldPublishedCommit = "a".repeat(40);
    const repairedSubject = "2".repeat(40);
    const repairedPublishedCommit = "b".repeat(40);
    await settleRepairRoundPublishes(fixture, 1);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-repair-before-race",
      outcome: "semantic_repair_required",
      summary: "Provider feedback for the first published head.",
      evidence: ["https://github.com/owner/repo/pull/1#repair"],
      payload: { kind: "pull_request_review", head_sha: oldPublishedCommit },
      headSha: oldPublishedCommit,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "dispatchable",
      active_stage_id: "repair_implementation",
    });

    const publishing = settleForwardChainToPublish(fixture, repairedSubject, "1".repeat(40), 2);
    expect(publishing).toMatchObject({ status: "dispatchable", active_stage_id: "publish" });
    fixture.tickets.setSetting("github-head:issue-1", repairedPublishedCommit);
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-synchronize:owner/repo:1:${repairedPublishedCommit}`,
      outcome: "needs_human",
      summary: "The pull-request head changed after the pipeline entered provider wait.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "synchronize" },
      headSha: repairedPublishedCommit,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    const snapshot = fixture.db.prepare("SELECT id FROM feedback_snapshots WHERE status = 'collecting'")
      .get() as { id: string };

    const settled = settleCurrentStage(fixture, "success", {
      id: "publish-race-settles",
      subject: repairedSubject,
      preSubject: repairedSubject,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: repairedPublishedCommit,
        provider_revision: repairedPublishedCommit,
      },
    });
    expect(settled).toMatchObject({
      status: "waiting_provider",
      active_stage_id: "provider",
      published_commit: repairedPublishedCommit,
    });
    expect(fixture.db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'failed', next_attempt_at = '2099-01-01T00:00:00.000Z',
          last_error = 'transient publication failure'
      WHERE pipeline_instance_id = ? AND payload LIKE ?
    `).run(fixture.instance.id, `%${repairedPublishedCommit}%`).changes).toBeGreaterThan(0);

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(0);
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed" });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      active_stage_id: "provider",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      expected_subject: repairedSubject,
    });
  });

  it("fails closed when a queued synchronize head differs from the settled publish subject", async () => {
    const fixture = setup("core/implement@4");
    const oldPublishedCommit = "a".repeat(40);
    const repairedSubject = "2".repeat(40);
    const repairedPublishedCommit = "b".repeat(40);
    const externalHead = "f".repeat(40);
    await settleRepairRoundPublishes(fixture, 1);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-repair-before-external-race",
      outcome: "semantic_repair_required",
      summary: "Provider feedback for the first published head.",
      evidence: ["https://github.com/owner/repo/pull/1#repair"],
      payload: { kind: "pull_request_review", head_sha: oldPublishedCommit },
      headSha: oldPublishedCommit,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    settleForwardChainToPublish(fixture, repairedSubject, "1".repeat(40), 2);
    fixture.tickets.setSetting("github-head:issue-1", externalHead);
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-synchronize:owner/repo:1:${externalHead}`,
      outcome: "needs_human",
      summary: "The pull-request head changed after the pipeline entered provider wait.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "synchronize" },
      headSha: externalHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    settleCurrentStage(fixture, "success", {
      id: "publish-external-race-settles",
      subject: repairedSubject,
      preSubject: repairedSubject,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: repairedPublishedCommit,
        provider_revision: repairedPublishedCommit,
      },
    });

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "needs_human",
      published_commit: repairedPublishedCommit,
    });
  });

  it("settles a third publish under the raw 20-attempt budget after two provider feedback repair rounds", async () => {
    const fixture = setup("core/implement@4", { maxAttempts: 20 });

    const completed = await settleRepairRoundPublishes(fixture, 3);

    expect(completed).toMatchObject({
      status: "waiting_provider",
      active_stage_id: "provider",
      immutable_subject: "3".repeat(40),
      published_commit: "c".repeat(40),
    });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_inbox_events
      WHERE id IN ('publish-1', 'publish-2', 'publish-3') AND status = 'consumed'
    `).get()).toEqual({ count: 3 });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_gate_receipts
      WHERE pipeline_instance_id = ? AND evaluator_kind = 'publish_subject'
    `).get(fixture.instance.id)).toEqual({ count: 3 });
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.attempt_count).toBeGreaterThan(20);
  });

  it("exhausts the whole-run attempt budget only at a provider repair round boundary", async () => {
    const fixture = setup("core/implement@4", { maxAttempts: 20 });

    const thirdPublishedRound = await settleRepairRoundPublishes(fixture, 3);

    expect(thirdPublishedRound).toMatchObject({
      status: "waiting_provider",
      active_stage_id: "provider",
      immutable_subject: "3".repeat(40),
      published_commit: "c".repeat(40),
    });
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.attempt_count).toBeGreaterThan(20);
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ? AND kind = 'github_summary'
    `).pluck().get(fixture.instance.id)).toBe(1);
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_gate_receipts
      WHERE pipeline_instance_id = ? AND evaluator_kind = 'publish_subject'
    `).pluck().get(fixture.instance.id)).toBe(3);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-repair-exhausted",
      outcome: "semantic_repair_required",
      summary: "Provider feedback after the final allowed repair publish.",
      evidence: ["https://github.com/owner/repo/pull/1#round-exhausted"],
      payload: { round: "exhausted", head_sha: "c".repeat(40) },
      headSha: "c".repeat(40),
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    const exhausted = fixture.pipelines.getInstance(fixture.instance.id)!;
    expect(exhausted).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "failed",
      immutable_subject: "3".repeat(40),
      published_commit: "c".repeat(40),
      wait_reason: "pipeline attempt limit 20 exhausted",
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toBeUndefined();
    expect(fixture.pipelines.listEffects(fixture.instance.id).map((effect) => effect.kind))
      .toEqual(expect.arrayContaining(["stop", "cleanup"]));
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_inbox_events
      WHERE id IN ('publish-1', 'publish-2', 'publish-3') AND status = 'consumed'
    `).pluck().get()).toBe(3);
  });

  it("keeps non-blocking publication diagnostics on the bounded publish retry", async () => {
    const fixture = setup("core/implement@4");
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

  it("turns supervisor-owned provider evidence into a fenced terminal receipt", async () => {
    const fixture = setup("core/implement@4");
    const publishedCommit = "d".repeat(40);
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?, native_session_id = 'native-1'
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'completion_pending_publication', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(SUBJECT, publishedCommit, SUBJECT, fixture.instance.id);

    const providerInput = {
      id: "provider-success-1",
      instanceId: fixture.instance.id,
      outcome: "success" as const,
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      providerPayload: { merged: true, head_sha: publishedCommit },
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", publishedCommit);
    expect(await routePipelineProviderEvent({
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
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: providerInput.id,
      outcome: providerInput.outcome,
      summary: providerInput.summary,
      evidence: providerInput.evidence,
      payload: providerInput.providerPayload,
      headSha: publishedCommit,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    const deferred = fixture.pipelines.getInstance(fixture.instance.id)!;

    expect(deferred.status).toBe("completion_pending_publication");
    expect(fixture.pipelines.getInboxEvent(providerInput.id)?.status).toBe("pending");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM pipeline_gate_receipts").pluck().get()).toBe(0);

    fixture.db.prepare("UPDATE pipeline_instances SET status = 'waiting_provider' WHERE id = ?")
      .run(fixture.instance.id);
    expect(await drainDeferredProviderEvidence(fixture.pipelines)).toBe(1);
    const completed = fixture.pipelines.getInstance(fixture.instance.id)!;

    expect(completed).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: providerInput.id,
      outcome: providerInput.outcome,
      summary: providerInput.summary,
      evidence: providerInput.evidence,
      payload: providerInput.providerPayload,
      headSha: publishedCommit,
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
    const fixture = setup("core/implement@4");
    const publishedCommit = "d".repeat(40);
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'provider', native_context_policy = 'none', expected_subject = ?
      WHERE id = ?
    `).run(SUBJECT, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'completion_pending_publication', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(SUBJECT, publishedCommit, SUBJECT, fixture.instance.id);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", publishedCommit);

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
          head: { ref: "ot/issue-1", sha: publishedCommit },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );

    const providerEventId = `github-pull-closed:owner/repo:1:${publishedCommit}`;
    expect(fixture.pipelines.getInboxEvent(providerEventId)?.status).toBe("pending");
    expect(fixture.pipelines.getAttempt(fixture.attempt.id)?.status).toBe("pending");
    expect(fixture.pipelines.getInstance(fixture.instance.id)?.terminal_outcome).toBeNull();

    fixture.db.prepare("UPDATE pipeline_instances SET status = 'waiting_provider' WHERE id = ?")
      .run(fixture.instance.id);
    expect(await drainDeferredProviderEvidence(fixture.pipelines)).toBe(1);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: terminalOutcome,
    });
  });

  it("promotes an Issue-canceled provider wait to shipped only for its exact merged head", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.db.prepare(`
      UPDATE tickets
      SET control_provider = 'github',
          external_thread_id = 'owner/repo#1',
          external_thread_reference = 'GH-1'
      WHERE ticket_id = 'issue-1'
    `).run();

    await closeGithubIssue(fixture);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "canceled",
    });
    await acknowledgeGithubControlGate(fixture, "canceled");
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "canceled",
      terminal_outcome: "canceled",
    });

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
          merged: true,
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    await acknowledgeGithubControlGate(fixture, "shipped");
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "shipped",
      terminal_outcome: "shipped",
    });
    expect(fixture.db.prepare(`
      SELECT outcome, closed_reason FROM run_outcomes WHERE pipeline_instance_id = ?
    `).get(fixture.instance.id)).toEqual({ outcome: "shipped", closed_reason: "success" });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM orchestration_journal
      WHERE instance_id = ? AND kind = 'merged'
    `).pluck().get(fixture.instance.id)).toBe(1);
  });

  it.each([
    {
      label: "a non-merged pull request close",
      event: {
        kind: "pull_request",
        action: "closed",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
      },
    },
    {
      label: "a merged pull request with the wrong head",
      event: {
        kind: "pull_request",
        action: "closed",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: true,
          head: { ref: "ot/issue-1", sha: "f".repeat(40) },
          base: { ref: "main" },
        },
      },
    },
    {
      label: "a non-provider review event",
      event: {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
        review: {
          id: 9,
          state: "commented",
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-9",
          user: { login: "reviewer" },
        },
      },
    },
  ] as const)("keeps an Issue-canceled run terminal after $label", async ({ event }) => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.db.prepare(`
      UPDATE tickets
      SET control_provider = 'github',
          external_thread_id = 'owner/repo#1',
          external_thread_reference = 'GH-1'
      WHERE ticket_id = 'issue-1'
    `).run();
    await closeGithubIssue(fixture);
    await acknowledgeGithubControlGate(fixture, "canceled");

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      {
        publishActivity: vi.fn(async () => undefined),
        publishError: vi.fn(async () => undefined),
      },
      event,
      fixture.pipelines
    );

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "canceled",
      terminal_outcome: "canceled",
    });
    expect(fixture.db.prepare(`
      SELECT outcome, closed_reason FROM run_outcomes WHERE pipeline_instance_id = ?
    `).get(fixture.instance.id)).toEqual({ outcome: "canceled", closed_reason: "canceled" });
  });

  it("scopes merged pull request journal idempotency keys by repository", async () => {
    const recordJournalEntry = vi.fn();
    const ticket = {
      ticket_id: "issue-1",
      ticket_reference: "ISSUE-1",
      session_id: "session-1",
      branch: "ot/issue-1",
      repo: "owner/repo",
      pr_url: null,
    };
    const instance = {
      id: "instance-1",
      repository: "owner/repo",
      status: "shipped",
      terminal_outcome: "shipped",
    } as PipelineInstance;
    const store = {
      getByBranch: vi.fn(() => ticket),
      setPrUrl: vi.fn(),
      setSetting: vi.fn(),
      getSetting: vi.fn(() => SUBJECT),
      setState: vi.fn(),
      markSessionState: vi.fn(),
      cancelPendingInbox: vi.fn(),
    } as unknown as SupervisorStore;
    const pipelines = {
      getInstanceForSession: vi.fn(() => instance),
      getInboxEvent: vi.fn(() => undefined),
      recordJournalEntry,
    } as unknown as PipelineStore;

    await handleGithubEvent(
      {} as never,
      store,
      {} as never,
      {
        kind: "pull_request",
        action: "closed",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: true,
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
      },
      pipelines
    );

    expect(recordJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      id: `journal-github-merged-owner/repo-1-${PUBLISHED_COMMIT}`,
    }));
    expect(pipelines.getInboxEvent).toHaveBeenCalledWith(
      `github-pull-closed:owner/repo:1:${PUBLISHED_COMMIT}`
    );
  });

  it("filters supervisor comments only by exact persisted comment-id provenance", async () => {
    const fixture = setup("core/implement@4");
    const publishActivity = vi.fn(async () => undefined);
    const activityPublisher = { publishActivity, publishError: vi.fn(async () => undefined) };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    const review = (id: number) => handleGithubEvent(
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
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
        review: {
          id,
          state: "commented",
          html_url: `https://github.com/owner/repo/pull/1#pullrequestreview-${id}`,
          // The solo operator IS the token account; authorship no longer skips.
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );

    const comment = (id: number, body: string, authorType = "User") => handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id,
          body,
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: { login: authorType === "Bot" ? "openthrottle[bot]" : "knoxgraeme", type: authorType },
        },
      },
      fixture.pipelines
    );
    const providerEventCount = () =>
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM provider_events").get() as { count: number }).count;

    await review(11);
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);
    expect(providerEventCount()).toBe(1);

    // The supervisor never authors reviews, so each attested review is human
    // feedback; marker filtering belongs to PR comments.
    await review(12);
    expect(providerEventCount()).toBe(2);

    // A comment whose ID the supervisor's summary upsert persisted is the
    // machine's own output — provenance by record, not by body content.
    fixture.db.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, kind, idempotency_key, payload_hash,
        status, external_id, created_at
      ) VALUES (?, ?, 'github_summary', ?, ?, 'acknowledged', ?, ?)
    `).run("pub-1", fixture.instance.id, "github-summary:test", "h".repeat(64), "31", "2026-07-25T00:00:00.000Z");
    await comment(31, "any body at all — the persisted ID decides");
    expect(providerEventCount()).toBe(2);
    expect(publishActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "PR comment" }),
      expect.anything()
    );

    // The publisher persists this exact ID immediately after the API upsert,
    // before pinning and receipt acknowledgement, closing that race without
    // trusting machine-looking body text or a caller-controlled author type.
    fixture.tickets.setSetting("github-supervisor-comment:33", "pipeline-status");
    await comment(33, "<!-- openthrottle:pipeline-summary:pipeline-1 -->\nGate summary body", "Bot");
    expect(providerEventCount()).toBe(2);

    // A webhook can arrive after GitHub creates a comment but before the API
    // response lets publication persist its exact id. The pre-network intent
    // defers that delivery; it does not trust or permanently discard marker
    // text, and the exact id remains the final provenance decision.
    const pendingMarker = "<!-- openthrottle:pipeline-summary:issue-1 -->";
    beginGithubSupervisorCommentWrite(
      fixture.tickets,
      "owner/repo",
      1,
      pendingMarker
    );
    await expect(comment(36, `${pendingMarker}\nIn-flight summary`))
      .rejects.toThrow("publication is still in flight");
    expect(providerEventCount()).toBe(2);
    fixture.tickets.setSetting("github-supervisor-comment:36", "pipeline-summary");
    await comment(36, `${pendingMarker}\nIn-flight summary`);
    expect(providerEventCount()).toBe(2);

    // Marker text and a Bot author type alone are untrusted input.
    await comment(34, "<!-- openthrottle:pipeline-status:github:owner/repo#12 -->\nStatus body", "Bot");
    expect(providerEventCount()).toBe(3);

    // An operator can type the same marker; authorship prevents that body from
    // colliding with supervisor output and silently dropping real feedback.
    await comment(35, "<!-- openthrottle:pipeline-summary:pipeline-1 -->\nOperator-authored feedback");
    expect(providerEventCount()).toBe(4);

    await comment(32, "the retry loop still double-counts attempts");
    // Events on the same PR head coalesce into one snapshot; the human comment
    // joins the human reviews as another provider event inside it.
    expect(fixture.tickets.listPendingFeedbackSnapshots("session-1")).toHaveLength(1);
    expect(providerEventCount()).toBe(5);
  });

  it("publishes Linear activity for GitHub review and CI completion events through the injected port", async () => {
    const fixture = setup("core/implement@4");
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
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
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

  it("accepts GitHub feedback from the live provider-wait instance even when the ticket projection says error", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    fixture.tickets.setState("issue-1", "error");

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
          id: 404,
          body: "This review feedback still belongs to the live provider wait.",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-404",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    const snapshot = fixture.db.prepare("SELECT id, status FROM feedback_snapshots").get() as {
      id: string;
      status: string;
    };
    expect(snapshot.status).toBe("consumed");
    expect(fixture.tickets.getSetting(`feedback-snapshot-drained-at:${snapshot.id}`))
      .toEqual(expect.any(String));
    expect(fixture.tickets.getSetting(`feedback-snapshot-drain-source:${snapshot.id}`))
      .toBe("github-webhook");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("ignores the Linear bot PR linkback comment that caused phantom repair feedback", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);

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
          id: 406,
          body: "Linked Linear issue OPE-19 to this pull request.",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-406",
          user: { login: "linear-code[bot]" },
        },
      },
      fixture.pipelines
    );

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("records an app comment that merely mentions a linear issue in prose as repair feedback", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);

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
          id: 407,
          body: "Automated review: the retry loop never terminates; the linked linear issue mentioned a bounded budget. Please fix.",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-407",
          user: { login: "review-helper[bot]" },
        },
      },
      fixture.pipelines
    );

    // Substantive automated feedback must be recorded as provider evidence and
    // start a repair round — never silently dropped by keyword heuristics.
    expect(activityPublisher.publishActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "action",
      action: "PR comment",
      parameter: "review-helper[bot]",
      result: "https://github.com/owner/repo/pull/1#issuecomment-407",
    }, "issue-1");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("ignores only the exact Codex review trigger command before repair admission", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);

    const comment = (id: number, body: string) => handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id,
          body,
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );

    await comment(501, "@codex review");

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.db.prepare("SELECT outcome FROM orchestration_journal WHERE outcome = ?").get("exact_codex_review_command"))
      .toEqual({ outcome: "exact_codex_review_command" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });

    await comment(502, "@codex review\nPlease also check the retry loop.");

    expect(activityPublisher.publishActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "action",
      action: "PR comment",
      parameter: "knoxgraeme",
      result: "https://github.com/owner/repo/pull/1#issuecomment-502",
    }, "issue-1");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("ignores empty PR-author reviews only when every attached comment is a reply", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1/reviews/601/comments?per_page=100")) {
        return Response.json([{ id: 71, in_reply_to_id: 11 }]);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
          user: { login: "knoxgraeme" },
        },
        review: {
          id: 601,
          state: "commented",
          body: "",
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-601",
          user: { login: "knoxgraeme" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.db.prepare("SELECT outcome FROM orchestration_journal WHERE outcome = ?").get("author_empty_reply_only_review"))
      .toEqual({ outcome: "author_empty_reply_only_review" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it.each([
    {
      label: "an author-created top-level inline finding",
      review: { id: 602, state: "commented", body: "" },
      comments: [{ id: 72 }],
      author: "knoxgraeme",
      pullAuthor: "knoxgraeme",
    },
    {
      label: "an author-created top-level inline finding on a later bounded page",
      review: { id: 605, state: "commented", body: "" },
      comments: [
        ...Array.from({ length: 100 }, (_, index) => ({ id: 800 + index, in_reply_to_id: 700 + index })),
        { id: 901 },
      ],
      author: "knoxgraeme",
      pullAuthor: "knoxgraeme",
    },
    {
      label: "a non-empty author review",
      review: { id: 603, state: "commented", body: "The provider event needs a structural guard." },
      comments: undefined,
      author: "knoxgraeme",
      pullAuthor: "knoxgraeme",
    },
    {
      label: "reply-only feedback from another identity",
      review: { id: 604, state: "commented", body: "" },
      comments: undefined,
      author: "reviewer",
      pullAuthor: "knoxgraeme",
    },
  ])("admits $label as review feedback", async ({ review, comments, author, pullAuthor }) => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    if (comments) {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/pulls/1/reviews/${review.id}/comments?per_page=100`)) {
          return Response.json(comments.slice(0, 100));
        }
        if (url.endsWith(`/pulls/1/reviews/${review.id}/comments?per_page=100&page=2`)) {
          return Response.json(comments.slice(100));
        }
        throw new Error(`Unexpected GitHub request: ${url}`);
      }) as unknown as typeof fetch);
    }

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
          user: { login: pullAuthor },
        },
        review: {
          ...review,
          html_url: `https://github.com/owner/repo/pull/1#pullrequestreview-${review.id}`,
          user: { login: author },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("routes exact trusted Codex clean review completion as successful current-head evidence", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        return Response.json({ head: { sha: PUBLISHED_COMMIT } });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch);
    const body = codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10), "Keep it up!");
    const cleanReview = (id: number) => handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id,
          body,
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
        },
      },
      fixture.pipelines
    );

    await cleanReview(701);
    await cleanReview(701);

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toBeUndefined();
  });

  it("admits a trusted Codex clean review when the live PR head differs from the reviewed commit", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        return Response.json({ head: { sha: "8".repeat(40) } });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch);

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 705,
          body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-705",
          user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
        },
      },
      fixture.pipelines
    );

    expect(activityPublisher.publishActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "action",
      action: "PR comment",
      parameter: CODEX_CONNECTOR_LOGIN,
      result: "https://github.com/owner/repo/pull/1#issuecomment-705",
    }, "issue-1");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("leaves trusted Codex clean review lookup failures retryable", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        return new Response("unavailable", { status: 503 });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch);

    await expect(handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 706,
          body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-706",
          user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
        },
      },
      fixture.pipelines
    )).rejects.toThrow("GitHub API error (503)");

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("ignores exact trusted Codex connector setup-required notices before repair admission", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    const setupNotice = (id: number) => handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id,
          body: CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE,
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
        },
      },
      fixture.pipelines
    );

    await setupNotice(703);
    await setupNotice(703);

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.db.prepare("SELECT outcome FROM orchestration_journal WHERE outcome = ?").get("codex_connector_setup_required_notice"))
      .toEqual({ outcome: "codex_connector_setup_required_notice" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it.each([
    {
      label: "near-match setup notice with extra feedback",
      body: `${CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE}\n\nPlease also fix the adapter.`,
      user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
    },
    {
      label: "untrusted author copying setup notice",
      body: CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE,
      user: { login: "reviewer", type: "User" },
    },
    {
      label: "lookalike connector bot copying setup notice",
      body: CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE,
      user: { login: "untrusted-codex-connector[bot]", type: "Bot" },
    },
  ])("admits $label as substantive PR comment feedback", async ({ body, user }) => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);

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
          id: 704,
          body,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-704",
          user,
        },
      },
      fixture.pipelines
    );

    expect(activityPublisher.publishActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "action",
      action: "PR comment",
      parameter: user.login,
      result: "https://github.com/owner/repo/pull/1#issuecomment-704",
    }, "issue-1");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it.each([
    {
      label: "near-match clean review text",
      body: `${codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10))}\n\nPlease fix naming.`,
      user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
    },
    {
      label: "untrusted author copying clean review text",
      body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
      user: { login: "reviewer", type: "User" },
    },
    {
      label: "mismatched reviewed commit",
      body: codexCleanReviewBody("f".repeat(10)),
      user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
    },
    {
      label: "lookalike connector bot copying clean review text",
      body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
      user: { login: "untrusted-codex-connector[bot]", type: "Bot" },
    },
  ])("admits $label as substantive PR comment feedback", async ({ body, user }) => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        return Response.json({ head: { sha: PUBLISHED_COMMIT } });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch);

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 702,
          body,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-702",
          user,
        },
      },
      fixture.pipelines
    );

    expect(activityPublisher.publishActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      type: "action",
      action: "PR comment",
      parameter: user.login,
      result: "https://github.com/owner/repo/pull/1#issuecomment-702",
    }, "issue-1");
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("ignores a bridge linkback comment self-identified by the linear-linkback marker", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);

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
          id: 408,
          body: "<!-- linear-linkback -->\nLinked Linear issue OPE-19 to this pull request.",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-408",
          user: { login: "acme-linear-bridge[bot]" },
        },
      },
      fixture.pipelines
    );

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("accepts GitHub review feedback from the live provider-wait instance even when the ticket projection says error", async () => {
    const fixture = setup("core/implement@4");
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture);
    fixture.tickets.setState("issue-1", "error");

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
          head: { ref: "ot/issue-1", sha: PUBLISHED_COMMIT },
          base: { ref: "main" },
        },
        review: {
          id: 405,
          state: "commented",
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-405",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    const snapshot = fixture.db.prepare("SELECT id, status FROM feedback_snapshots").get() as {
      id: string;
      status: string;
    };
    expect(snapshot.status).toBe("consumed");
    expect(fixture.tickets.getSetting(`feedback-snapshot-drained-at:${snapshot.id}`))
      .toEqual(expect.any(String));
    expect(fixture.tickets.getSetting(`feedback-snapshot-drain-source:${snapshot.id}`))
      .toBe("github-webhook");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("enriches failed GitHub workflow feedback into sealed repair findings", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/actions/runs/20/jobs?filter=latest&per_page=100")) {
        return Response.json({
          jobs: [{
            id: 101,
            name: "test",
            workflow_name: "CI",
            html_url: "https://github.com/owner/repo/actions/runs/20/job/101",
            conclusion: "failure",
            steps: [{ name: "unit tests", conclusion: "failure" }],
          }],
        });
      }
      if (url.endsWith("/actions/jobs/101/logs")) {
        return new Response(`tail\nBearer ghp_secretvalue\nexpected failure\n`);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      { publishActivity: vi.fn(async () => undefined), publishError: vi.fn(async () => undefined) },
      {
        kind: "workflow_run",
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: {
          id: 20,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          head_branch: "ot/issue-1",
          head_sha: PUBLISHED_COMMIT,
          html_url: "https://github.com/owner/repo/actions/runs/20",
        },
      },
      fixture.pipelines
    );

    const next = fixture.pipelines.getActiveAttempt(fixture.instance.id)!;
    const request = fixture.pipelines.getStageRequest(next.id);
    const transition = JSON.parse(request.transitionContext) as {
      findings: Array<{ severity: string; code: string; summary: string }>;
    };
    expect(transition.findings).toEqual([{
      severity: "P1",
      code: "ci-check-failed",
      summary: "CI / test failed at unit tests.",
    }]);
    const providerPayload = firstProviderStagePayload(fixture);
    expect(providerPayload).toContain("expected failure");
    expect(providerPayload).toContain("[REDACTED]");
    expect(providerPayload).not.toContain("ghp_secretvalue");
  });

  it("enriches failed GitHub check-suite feedback into sealed repair findings", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/commits/${PUBLISHED_COMMIT}/check-runs?per_page=100`)) {
        return Response.json({
          check_runs: [{
            id: 501,
            name: "build",
            conclusion: "failure",
            details_url: "https://github.com/owner/repo/actions/runs/20/job/101",
            html_url: "https://github.com/owner/repo/runs/501",
          }],
        });
      }
      if (url.endsWith("/actions/jobs/101")) {
        return Response.json({
          id: 101,
          name: "build",
          workflow_name: "CI",
          html_url: "https://github.com/owner/repo/actions/runs/20/job/101",
          conclusion: "failure",
          steps: [{ name: "compile", conclusion: "failure" }],
        });
      }
      if (url.endsWith("/actions/jobs/101/logs")) {
        return new Response("compile failed with sk-secretvalue");
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      { publishActivity: vi.fn(async () => undefined), publishError: vi.fn(async () => undefined) },
      {
        kind: "check_suite",
        action: "completed",
        repository: { full_name: "owner/repo" },
        check_suite: {
          id: 30,
          status: "completed",
          conclusion: "failure",
          head_branch: "ot/issue-1",
          head_sha: PUBLISHED_COMMIT,
          url: "https://api.github.com/repos/owner/repo/check-suites/30",
        },
      },
      fixture.pipelines
    );

    const next = fixture.pipelines.getActiveAttempt(fixture.instance.id)!;
    const transition = JSON.parse(fixture.pipelines.getStageRequest(next.id).transitionContext) as {
      findings: Array<{ severity: string; code: string; summary: string }>;
    };
    expect(transition.findings).toEqual([{
      severity: "P1",
      code: "ci-check-failed",
      summary: "CI / build failed at compile.",
    }]);
    const providerPayload = firstProviderStagePayload(fixture);
    expect(providerPayload).toContain("compile failed");
    expect(providerPayload).toContain("[REDACTED]");
    expect(providerPayload).not.toContain("sk-secretvalue");
  });

  it("records failed GitHub workflow feedback when enrichment fails", async () => {
    const fixture = setup("core/implement@4");
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'running', immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      { publishActivity: vi.fn(async () => undefined), publishError: vi.fn(async () => undefined) },
      {
        kind: "workflow_run",
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: {
          id: 21,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          head_branch: "ot/issue-1",
          head_sha: SUBJECT,
          html_url: "https://github.com/owner/repo/actions/runs/21",
        },
      },
      fixture.pipelines
    );

    const events = fixture.db.prepare("SELECT payload FROM provider_events").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const stored = JSON.parse(events[0]!.payload) as { evidence: string[]; payload: string };
    expect(stored.evidence).toEqual(["https://github.com/owner/repo/actions/runs/21"]);
    expect(JSON.parse(stored.payload)).toMatchObject({ failures: [], findings: [] });
  });

  it("names the missing Actions read permission when enrichment is rejected with 403", async () => {
    const fixture = setup("core/implement@4");
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'running', immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Resource not accessible", { status: 403 })));

    await handleGithubEvent(
      { githubReadToken: "github-read-token" } as never,
      fixture.tickets,
      { publishActivity: vi.fn(async () => undefined), publishError: vi.fn(async () => undefined) },
      {
        kind: "workflow_run",
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: {
          id: 22,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          head_branch: "ot/issue-1",
          head_sha: SUBJECT,
          html_url: "https://github.com/owner/repo/actions/runs/22",
        },
      },
      fixture.pipelines
    );

    const events = fixture.db.prepare("SELECT payload FROM provider_events").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const stored = JSON.parse(events[0]!.payload) as { summary: string; payload: string };
    expect(stored.summary).toContain("CI concluded failure.");
    expect(stored.summary).toContain("Actions read permission");
    expect(JSON.parse(stored.payload)).toMatchObject({
      failures: [],
      findings: [],
      enrichment_note: expect.stringContaining("Actions read permission") as unknown as string,
    });
  });

  it("keeps oversized enriched provider snapshot payloads valid JSON", async () => {
    const fixture = setup("core/implement@4");
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET status = 'running', immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    const largeFailure = {
      workflow_name: "CI",
      job_name: "test",
      step_names: Array.from({ length: 10 }, (_, index) => `step-${index}-${"s".repeat(200)}`),
      log_tail: "x".repeat(2_000),
      html_url: "https://github.com/owner/repo/actions/runs/20/job/101",
    };

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "large-ci-feedback",
      outcome: "semantic_repair_required",
      summary: "CI concluded failure.",
      evidence: ["https://github.com/owner/repo/actions/runs/20"],
      findings: [{ severity: "P1", code: "ci-check-failed", summary: "CI / test failed at step." }],
      payload: {
        kind: "workflow_run",
        failures: [largeFailure, largeFailure, largeFailure],
        findings: [{ severity: "P1", code: "ci-check-failed", summary: "CI / test failed at step." }],
      },
      headSha: SUBJECT,
    })).toBe(true);

    const stored = fixture.db.prepare("SELECT payload FROM provider_events WHERE provider_event_id = ?")
      .get("large-ci-feedback") as { payload: string };
    const wrapper = JSON.parse(stored.payload) as { payload: string; findings: unknown[] };
    expect(wrapper.findings).toHaveLength(1);
    expect(Buffer.byteLength(wrapper.payload, "utf8")).toBeLessThanOrEqual(8_000);
    expect(() => JSON.parse(wrapper.payload)).not.toThrow();
  });

  it("fails closed when GitHub's current head differs from the executor-verified commit", async () => {
    const fixture = setup("core/implement@4");
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

    expect(await routePipelineProviderEvent({
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

  it("fails closed for an external synchronize while already waiting on provider evidence", async () => {
    const fixture = setup("core/implement@4");
    const observedHead = "d".repeat(40);
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", observedHead);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-synchronize:owner/repo:1:${observedHead}`,
      outcome: "needs_human",
      summary: "The pull-request head changed after the pipeline entered provider wait.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "synchronize" },
      headSha: observedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "needs_human",
      published_commit: PUBLISHED_COMMIT,
    });
  });

  it("coalesces feedback arriving during repair and replays a claimed snapshot at provider wait", async () => {
    const fixture = setup("core/implement@4");
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", PUBLISHED_COMMIT);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(PUBLISHED_COMMIT, fixture.instance.id);
    const route = (id: string) => routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: id,
      outcome: "semantic_repair_required",
      summary: `Feedback ${id}`,
      evidence: [`https://github.com/owner/repo/pull/1#${id}`],
      payload: { kind: "review", id },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });

    expect(await route("review-during-repair-1")).toBe(true);
    expect(await route("ci-during-repair-2")).toBe(true);
    const snapshot = fixture.db.prepare("SELECT * FROM feedback_snapshots").get() as { id: string; work_item_id: string };
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(2);
    const claimed = fixture.tickets.claimFeedbackSnapshot(snapshot.id, Number.MAX_SAFE_INTEGER);
    expect(claimed).toMatchObject({
      status: "claimed",
      snapshot: { repair_round: 1 },
    });
    expect(claimed.status === "claimed" && claimed.events.map((event) => event.provider_event_id).sort())
      .toEqual(["ci-during-repair-2", "review-during-repair-1"]);
    expect(fixture.tickets.getSetting(`feedback-snapshot-drained-at:${snapshot.id}`)).toBeUndefined();
    expect(fixture.tickets.getSetting(`feedback-snapshot-drain-source:${snapshot.id}`)).toBeUndefined();

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
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(SUBJECT, PUBLISHED_COMMIT, SUBJECT, fixture.instance.id);

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed" });
    expect(fixture.tickets.getSetting(`feedback-snapshot-drained-at:${snapshot.id}`))
      .toEqual(expect.any(String));
    expect(fixture.tickets.getSetting(`feedback-snapshot-drain-source:${snapshot.id}`))
      .toBe("periodic-feedback-drain");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(0);
  });

  it("routes a mixed same-head snapshot to repair re-entry, not the successful outcome", async () => {
    const fixture = setup("core/implement@4");
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", PUBLISHED_COMMIT);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(PUBLISHED_COMMIT, fixture.instance.id);

    // GitHub reports success for the published head before the provider-wait
    // stage can receive, so the event is collected into the pending snapshot.
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-closed:owner/repo:1:${PUBLISHED_COMMIT}`,
      outcome: "success",
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "closed", merged: true },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots").pluck().get()).toBe("collecting");

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
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?, published_subject = ?
      WHERE id = ?
    `).run(SUBJECT, PUBLISHED_COMMIT, SUBJECT, fixture.instance.id);

    // A Linear reply for the same head joins that snapshot as a repair request.
    const instance = fixture.pipelines.getInstance(fixture.instance.id)!;
    const snapshot = recordPipelineProviderEvent({
      store: fixture.tickets,
      instance,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      provider: "linear",
      eventId: "linear-reply:activity-1",
      outcome: "semantic_repair_required",
      summary: "Linear reply requires another implementation pass.",
      evidence: ["Please rename the flag before shipping."],
      payload: { kind: "linear_reply", activity_id: "activity-1" },
      headSha: PUBLISHED_COMMIT,
    });
    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance,
      snapshot,
    })).toBe(true);

    // The repair request must outrank the successful evidence: the pipeline
    // re-enters implementation instead of passing the provider gate.
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed" });
    expect(fixture.pipelines.getInstance(fixture.instance.id)!.terminal_outcome).toBeNull();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("ships provider feedback with only live P2 findings after repair budget is exhausted", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET reentry_count = 5
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).run(fixture.instance.id);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:p2-after-repair",
      outcome: "semantic_repair_required",
      summary: "Provider found a non-blocking publication diagnostic.",
      evidence: ["https://github.com/owner/repo/pull/1#discussion_r2"],
      findings: [{
        severity: "P2",
        code: "publication-copy",
        summary: "The status copy could be clearer.",
      }],
      payload: {
        kind: "pull_request_review",
      },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    expect(fixture.db.prepare(
      "SELECT result FROM pipeline_gate_receipts WHERE evaluator_kind = 'provider'"
    ).get()).toEqual({ result: "passed" });
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots").get())
      .toEqual({ status: "consumed" });
  });

  it("preserves an unstructured repair request mixed with non-blocking diagnostics", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture, SUBJECT);
    const workItemId = `pipeline-feedback:${fixture.instance.id}:${PUBLISHED_COMMIT}`;
    const eventPayload = (
      summary: string,
      findings?: Array<{ severity: "P2"; code: string; summary: string }>
    ) => canonicalJson({
      outcome: "semantic_repair_required",
      summary,
      evidence: [summary],
      ...(findings ? { findings } : {}),
      payload: "{}",
    });
    fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:p2-mixed",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: PUBLISHED_COMMIT,
      kind: "pipeline_provider_event",
      payload: eventPayload("p2 mixed", [{
        severity: "P2",
        code: "publication-copy",
        summary: "The status copy could be clearer.",
      }]),
      workItemId,
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "linear",
      providerEventId: "linear-reply:mixed-unstructured",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: PUBLISHED_COMMIT,
      kind: "pipeline_provider_event",
      payload: eventPayload("unstructured human feedback"),
      workItemId,
      receivedAt: "2026-01-01T00:00:01.000Z",
    }).snapshot;

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toBe(true);

    expect(fixture.pipelines.getInstance(fixture.instance.id)!.terminal_outcome).toBeNull();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("checks blocking findings before applying the provider artifact cap", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    const workItemId = `pipeline-feedback:${fixture.instance.id}:${PUBLISHED_COMMIT}`;
    const payload = (
      providerEventId: string,
      findings: Array<{ severity: "P1" | "P2"; code: string; summary: string }>
    ) => canonicalJson({
      outcome: "semantic_repair_required",
      summary: providerEventId,
      evidence: [providerEventId],
      findings,
      payload: "{}",
    });
    let snapshot: FeedbackSnapshot | undefined;
    for (let batch = 0; batch < 3; batch += 1) {
      snapshot = fixture.tickets.recordProviderFeedback({
        provider: "github",
        providerEventId: `github-review:p2-batch-${batch}`,
        issueId: fixture.instance.ticket_id,
        sessionId: fixture.instance.session_id,
        generation: fixture.instance.generation,
        repository: fixture.instance.repository,
        pullNumber: 1,
        headSha: PUBLISHED_COMMIT,
        kind: "pipeline_provider_event",
        payload: payload(`p2 batch ${batch}`, Array.from({ length: 20 }, (_, index) => ({
          severity: "P2",
          code: `p2-${batch}-${index}`,
          summary: `non-blocking diagnostic ${batch}-${index}`,
        }))),
        workItemId,
        receivedAt: `2026-01-01T00:00:0${batch}.000Z`,
      }).snapshot;
    }
    snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:z-p1-after-cap",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: PUBLISHED_COMMIT,
      kind: "pipeline_provider_event",
      payload: payload("p1 after cap", [{
        severity: "P1",
        code: "blocking-after-cap",
        summary: "blocking diagnostic after artifact cap",
      }]),
      workItemId,
      receivedAt: "2026-01-01T00:00:03.000Z",
    }).snapshot;

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toBe(true);

    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
    const sealed = fixture.db.prepare("SELECT payload FROM pipeline_artifacts WHERE kind = 'stage_result'")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as { findings?: unknown[] })
      .find((artifact) => Array.isArray(artifact.findings) && artifact.findings.length === 50);
    expect(sealed?.findings?.some((finding) =>
      typeof finding === "object" &&
      finding !== null &&
      (finding as { code?: unknown }).code === "blocking-after-cap"
    )).toBe(false);
  });

  it("still escalates live P1 provider feedback when repair re-entry is exhausted", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET reentry_count = 5
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).run(fixture.instance.id);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:p1-after-repair",
      outcome: "semantic_repair_required",
      summary: "Provider found a blocking defect on the published head.",
      evidence: ["https://github.com/owner/repo/pull/1#discussion_r1"],
      findings: [{
        severity: "P1",
        code: "unsafe-publication",
        summary: "The published change can corrupt pipeline state.",
      }],
      payload: {
        kind: "pull_request_review",
      },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "needs_human",
      wait_reason: "re-entry exhausted at provider",
    });
    expect(fixture.db.prepare(
      "SELECT result FROM pipeline_gate_receipts WHERE evaluator_kind = 'provider'"
    ).get()).toEqual({ result: "failed" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toBeUndefined();
  });

  it("keeps provider head drift human-required even when drift evidence has only P2 findings", async () => {
    const fixture = setup("core/implement@4");
    moveFixtureToProviderWait(fixture, SUBJECT);
    const driftHead = "d".repeat(40);

    processProviderEvidence(fixture.pipelines, {
      id: "provider-head-drift-with-p2",
      instanceId: fixture.instance.id,
      outcome: "needs_human",
      summary: "The current provider head does not match the executor-verified published commit.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      findings: [{
        severity: "P2",
        code: "publication-copy",
        summary: "The status copy could be clearer.",
      }],
      providerPayload: {
        expected_published_commit: PUBLISHED_COMMIT,
        observed_head_sha: driftHead,
      },
    });

    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "needs_human",
    });
    expect(fixture.db.prepare(
      "SELECT result FROM pipeline_gate_receipts WHERE evaluator_kind = 'provider'"
    ).get()).toEqual({ result: "failed" });
  });

  it.each([
    ["published commit", { publishedCommit: "d".repeat(40) }],
    ["provider revision", { providerRevision: "e".repeat(40) }],
  ])("carries same-run feedback from a superseded %s into the current provider wait", async (_label, publicationOptions) => {
    const fixture = setup("core/implement@4");
    const oldHead = Object.values(publicationOptions)[0];
    const currentPublishedCommit = "f".repeat(40);
    const localSubject = "b".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", PUBLISHED_COMMIT);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(oldHead, fixture.instance.id);
    recordAcknowledgedPublication(fixture, localSubject, publicationOptions);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:superseded-same-run",
      outcome: "semantic_repair_required",
      summary: "Feedback against the previous same-run head.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-1"],
      payload: { kind: "review", id: "superseded-same-run" },
      headSha: oldHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.db.prepare("SELECT head_sha FROM provider_events WHERE provider_event_id = ?")
      .get("github-review:superseded-same-run")).toEqual({ head_sha: oldHead });

    const snapshot = fixture.db.prepare("SELECT * FROM feedback_snapshots").get() as { id: string };
    moveFixtureToProviderWait(fixture, SUBJECT, currentPublishedCommit);

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed", head_sha: currentPublishedCommit });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .pluck().get()).toBe(0);
  });

  it("discounts superseded-head review feedback after a repair round and lets fresh success ship", async () => {
    const fixture = setup("core/implement@4");
    const staleHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: staleHead });
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: PUBLISHED_COMMIT }, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:stale-after-repair",
      outcome: "semantic_repair_required",
      summary: "Stale review feedback from the previous head.",
      evidence: ["https://github.com/owner/repo/pull/1#discussion_r1"],
      payload: { kind: "pull_request_review", id: "stale-after-repair" },
      headSha: staleHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: staleHead });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-closed:owner/repo:1:${PUBLISHED_COMMIT}`,
      outcome: "success",
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "closed", merged: true },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
  });

  it("still carries later-round feedback that predates the current publication", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", PUBLISHED_COMMIT);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-previous");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: PUBLISHED_COMMIT }, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);
    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "Feedback captured before the republish completed.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-2"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:prepublish-later-round",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: previousHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${previousHead}`,
      receivedAt: "2025-12-31T23:59:59.000Z",
    }).snapshot;

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toBe(true);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed", head_sha: PUBLISHED_COMMIT });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("resolves the claimed repair-driving snapshot after a repaired republish", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", previousHead);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(previousHead, fixture.instance.id);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-previous");

    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "Feedback that already drove the completed repair.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-3"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:repair-driving-snapshot",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: previousHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${previousHead}`,
      receivedAt: "2025-12-31T23:59:59.000Z",
    }).snapshot;
    expect(fixture.tickets.claimFeedbackSnapshot(snapshot.id, Number.MAX_SAFE_INTEGER))
      .toMatchObject({ status: "claimed", snapshot: { repair_round: 1 } });
    const providerEventPayload = canonicalJson({ snapshot_id: snapshot.id });
    fixture.db.prepare(`
      INSERT INTO pipeline_inbox_events (
        id, pipeline_instance_id, generation, kind, payload, payload_hash,
        status, created_at, consumed_at
      ) VALUES (?, ?, ?, 'provider_snapshot', ?, ?, 'consumed', ?, ?)
    `).run(
      `provider-feedback-snapshot:${snapshot.id}`,
      fixture.instance.id,
      fixture.instance.generation,
      providerEventPayload,
      digestNormalized(providerEventPayload),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: PUBLISHED_COMMIT }, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: fixture.db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?").get(snapshot.id) as FeedbackSnapshot,
    })).toBe(false);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "consumed", head_sha: previousHead });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("does not resolve a claimed superseded snapshot without durable provider proof", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", previousHead);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(previousHead, fixture.instance.id);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-previous");

    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "Feedback claimed before provider evidence was committed.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-4"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:claimed-without-provider-proof",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: previousHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${previousHead}`,
      receivedAt: "2025-12-31T23:59:59.000Z",
    }).snapshot;
    expect(fixture.tickets.claimFeedbackSnapshot(snapshot.id, Number.MAX_SAFE_INTEGER))
      .toMatchObject({ status: "claimed", snapshot: { repair_round: 1 } });

    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: PUBLISHED_COMMIT }, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: fixture.db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?").get(snapshot.id) as FeedbackSnapshot,
    })).toBe(false);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "stale", head_sha: previousHead });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${snapshot.id}`)).toBeDefined();
  });

  it("still acts on new provider findings anchored to the repaired head", async () => {
    const fixture = setup("core/implement@4");
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", PUBLISHED_COMMIT);
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: PUBLISHED_COMMIT }, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:new-current-head-finding",
      outcome: "semantic_repair_required",
      summary: "New review feedback against the repaired head.",
      evidence: ["https://github.com/owner/repo/pull/1#discussion_r4"],
      payload: { kind: "pull_request_review", id: "new-current-head-finding" },
      headSha: PUBLISHED_COMMIT,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "consumed", head_sha: PUBLISHED_COMMIT });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "dispatchable",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("does not carry an old snapshot after a post-publication event joins it", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-previous");
    recordAcknowledgedPublication(fixture, SUBJECT, {}, "publication-current");
    moveFixtureToProviderWait(fixture, SUBJECT);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);
    const eventPayload = (summary: string) => canonicalJson({
      outcome: "semantic_repair_required",
      summary,
      evidence: [summary],
      payload: "{}",
    });
    const first = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:prepublish-in-mixed-snapshot",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: previousHead,
      kind: "pipeline_provider_event",
      payload: eventPayload("Feedback captured before the republish completed."),
      workItemId: `pipeline-feedback:${fixture.instance.id}:${previousHead}`,
      receivedAt: "2025-12-31T23:59:59.000Z",
    }).snapshot;
    const second = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:postpublish-in-mixed-snapshot",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: previousHead,
      kind: "pipeline_provider_event",
      payload: eventPayload("Stale feedback re-observed after the republish completed."),
      workItemId: `pipeline-feedback:${fixture.instance.id}:${previousHead}`,
      receivedAt: "2026-01-01T00:00:01.000Z",
    }).snapshot;
    expect(second.id).toBe(first.id);

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: second,
    })).toBe(false);

    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(first.id))
      .toEqual({ status: "stale", head_sha: previousHead });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      terminal_outcome: null,
    });
  });

  it("seals carried feedback under the head it was observed against, not the drainable head", async () => {
    const fixture = setup("core/implement@4");
    const observedHead = "d".repeat(40);
    const currentPublishedCommit = "f".repeat(40);
    const localSubject = "b".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(observedHead, fixture.instance.id);
    recordAcknowledgedPublication(fixture, localSubject, { publishedCommit: observedHead });

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:observed-head-provenance",
      outcome: "semantic_repair_required",
      summary: "Feedback observed against the superseded head.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-9"],
      payload: { kind: "review", id: "observed-head-provenance" },
      headSha: observedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);

    const snapshot = fixture.db.prepare("SELECT * FROM feedback_snapshots").get() as FeedbackSnapshot;
    expect(snapshot.head_sha).toBe(observedHead);
    expect(snapshot.observed_head_sha).toBe(observedHead);

    moveFixtureToProviderWait(fixture, SUBJECT, currentPublishedCommit);
    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);

    // OPE-27 drainability is preserved: the snapshot is retargeted to the
    // current published commit and re-enters implementation, while its
    // provenance head stays pinned to the commit the review was observed against.
    expect(fixture.db.prepare(
      "SELECT status, head_sha, observed_head_sha FROM feedback_snapshots WHERE id = ?"
    ).get(snapshot.id)).toEqual({
      status: "consumed",
      head_sha: currentPublishedCommit,
      observed_head_sha: observedHead,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });

    // The underlying provider event still identifies the superseded commit...
    expect(fixture.db.prepare("SELECT head_sha FROM provider_events WHERE provider_event_id = ?")
      .get("github-review:observed-head-provenance")).toEqual({ head_sha: observedHead });

    // ...and the sealed provider-verified artifact reports the observed head as
    // provenance, not the current subject it was carried to (audit contract).
    const sealed = fixture.db.prepare("SELECT payload FROM pipeline_artifacts WHERE kind = 'stage_result'")
      .all()
      .map((row) => (JSON.parse((row as { payload: string }).payload) as {
        repository?: { subject?: string };
        details?: { snapshot_id?: string; observed_head_sha?: string; expected_published_commit?: string };
      }))
      .find((artifact) => artifact.details?.snapshot_id === snapshot.id);
    expect(sealed?.repository?.subject).toBe(SUBJECT);
    expect(sealed?.details?.observed_head_sha).toBe(observedHead);
    expect(sealed?.details?.expected_published_commit).toBe(currentPublishedCommit);
  });

  it("continues draining when the oldest same-session feedback snapshot is stale", async () => {
    const fixture = setup("core/implement@4");
    const staleHead = "d".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    const eventPayload = (summary: string) => canonicalJson({
      outcome: "semantic_repair_required",
      summary,
      evidence: [summary],
      payload: "{}",
    });
    const stale = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:stale",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: staleHead,
      kind: "pipeline_provider_event",
      payload: eventPayload("stale feedback"),
      workItemId: `pipeline-feedback:${fixture.instance.id}:${staleHead}`,
      receivedAt: "2026-01-01T00:00:00.000Z",
    }).snapshot;
    const fresh = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:fresh",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: SUBJECT,
      kind: "pipeline_provider_event",
      payload: eventPayload("fresh feedback"),
      workItemId: `pipeline-feedback:${fixture.instance.id}:${SUBJECT}`,
      receivedAt: "2026-01-01T00:00:01.000Z",
    }).snapshot;

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
      SET status = 'waiting_provider', active_stage_id = 'provider',
          immutable_subject = ?, published_commit = ?
      WHERE id = ?
    `).run(SUBJECT, SUBJECT, fixture.instance.id);

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(1);
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(stale.id))
      .toEqual({ status: "stale" });
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots WHERE id = ?").get(fresh.id))
      .toEqual({ status: "consumed" });
    const staleNotice = fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${stale.id}`) as { payload: string };
    expect(JSON.parse(staleNotice.payload)).toMatchObject({
      type: "activity",
      activity: {
        sessionId: "session-1",
        type: "error",
        body: "1 feedback item(s) arrived against a superseded head and were not applied; re-comment on the current PR head.",
      },
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("keeps generation and instance fences when same-head feedback reaches the current provider wait", async () => {
    const fixture = setup("core/implement@4");
    const cases = [
      { id: "other-generation", generation: fixture.instance.generation + 1, workItemId: `pipeline-feedback:${fixture.instance.id}:${SUBJECT}` },
      { id: "other-instance", generation: fixture.instance.generation, workItemId: `pipeline-feedback:other-instance:${SUBJECT}` },
    ];
    fixture.tickets.setSetting("github-head:issue-1", SUBJECT);
    recordAcknowledgedPublication(fixture, SUBJECT);
    moveFixtureToProviderWait(fixture, SUBJECT);
    const eventPayload = (summary: string) => canonicalJson({
      outcome: "semantic_repair_required",
      summary,
      evidence: [summary],
      payload: "{}",
    });

    for (const item of cases) {
      const snapshot = fixture.tickets.recordProviderFeedback({
        provider: "github",
        providerEventId: `github-review:${item.id}`,
        issueId: fixture.instance.ticket_id,
        sessionId: fixture.instance.session_id,
        generation: item.generation,
        repository: fixture.instance.repository,
        pullNumber: 1,
        headSha: SUBJECT,
        kind: "pipeline_provider_event",
        payload: eventPayload(item.id),
        workItemId: item.workItemId,
      }).snapshot;

      expect(await processPipelineFeedbackSnapshot({
        pipelines: fixture.pipelines,
        store: fixture.tickets,
        instance: fixture.pipelines.getInstance(fixture.instance.id)!,
        snapshot,
      })).toBe(false);
      expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
        .toEqual({ status: "stale", head_sha: SUBJECT });
      expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
        .get(`feedback-snapshot-stale:${snapshot.id}`)).toBeDefined();
    }
  });

  it("keeps unrelated heads stale even when the snapshot matches the current instance", async () => {
    const fixture = setup("core/implement@4");
    const unrelatedHead = "f".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT);
    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "unrelated head feedback",
      evidence: ["unrelated head feedback"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:unrelated-head",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: unrelatedHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${unrelatedHead}`,
    }).snapshot;

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toBe(false);
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "stale", head_sha: unrelatedHead });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${snapshot.id}`)).toBeDefined();
  });

  it("does not carry forward a snapshot that was already claimed under an older head", async () => {
    const fixture = setup("core/implement@4");
    const oldHead = "2".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", oldHead);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', published_commit = ? WHERE id = ?
    `).run(oldHead, fixture.instance.id);
    recordAcknowledgedPublication(fixture, "b".repeat(40), { providerRevision: oldHead });
    const snapshot = await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:claimed-before-republish",
      outcome: "semantic_repair_required",
      summary: "Feedback claimed before a later publication.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-2"],
      payload: { kind: "review", id: "claimed-before-republish" },
      headSha: oldHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(snapshot).toBe(true);
    const stored = fixture.db.prepare("SELECT * FROM feedback_snapshots").get() as { id: string };
    expect(fixture.tickets.claimFeedbackSnapshot(stored.id, Number.MAX_SAFE_INTEGER))
      .toMatchObject({ status: "claimed" });

    moveFixtureToProviderWait(fixture, SUBJECT);

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: fixture.db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?").get(stored.id) as FeedbackSnapshot,
    })).toBe(false);
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(stored.id))
      .toEqual({ status: "stale", head_sha: oldHead });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${stored.id}`)).toBeDefined();
  });

  it("does not stale a feedback snapshot when its stale notice cannot be enqueued", async () => {
    const fixture = setup("core/implement@4");
    const staleHead = "1".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT);
    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "stale feedback",
      evidence: ["stale feedback"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:notice-failure",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: staleHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${staleHead}`,
    }).snapshot;
    fixture.tickets.enqueueLinearOutbox({
      id: `feedback-snapshot-stale:${snapshot.id}`,
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: canonicalJson({ incompatible: true }),
    });

    expect(() => processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toThrow(/different intent/);
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots WHERE id = ?").get(snapshot.id))
      .toEqual({ status: "collecting", head_sha: staleHead });
  });

  function driveCoreImplementToSimplification(fixture: Fixture, priorSubject: string): void {
    // implementation writes the tree; the read-only review leaves it untouched,
    // parking the run at the conditional simplification stage.
    let instance = settleCurrentStage(fixture, "success", {
      id: "impl-1",
      subject: priorSubject,
      preSubject: fixture.instance.base_commit,
    });
    expect(instance.active_stage_id).toBe("semantic_review");
    instance = settleCurrentStage(fixture, "success", {
      id: "review-1",
      subject: priorSubject,
      preSubject: priorSubject,
    });
    expect(instance).toMatchObject({ status: "dispatchable", active_stage_id: "simplification" });
  }

  it("reclassifies a self-reported simplification no_change into a reviewed success when the sealed tree changed", async () => {
    const fixture = setup("core/implement@4");
    const priorSubject = "d".repeat(40);
    const simplifiedSubject = "e".repeat(40);
    driveCoreImplementToSimplification(fixture, priorSubject);

    // The simplify agent self-reports no_change, but the sealed post_subject
    // differs from pre_subject: the tree actually moved. The gate must trust the
    // sealed subjects over the agent's claim and route the changed tree through
    // post_simplify_review rather than skipping straight to the command gates.
    const running = startAttempt(fixture);
    const contradicted = event(running, "no_change", {
      id: "simplify-changed-tree",
      subject: simplifiedSubject,
      preSubject: priorSubject,
    });
    const evaluated = evaluateStageGate(running.pipelines, contradicted, {
      observedSubject: simplifiedSubject,
    });
    expect(evaluated.event.outcome).toBe("success");
    expect(evaluated.receipt.result).toBe("passed");
    expect(JSON.parse(evaluated.receipt.payload)).toMatchObject({
      proposed_result: "no_change",
      outcome: "success",
      reason: "no_change_contradicted_by_tree_delta",
    });

    const advanced = completeStageAttemptActor(running.pipelines, running.tickets, contradicted, {
      observedSubject: simplifiedSubject,
    });
    expect(advanced).toMatchObject({
      status: "dispatchable",
      active_stage_id: "post_simplify_review",
      immutable_subject: simplifiedSubject,
    });
  });

  it("keeps a genuine simplification no_change on the fast path to test when the sealed tree is unchanged", async () => {
    const fixture = setup("core/implement@4");
    const priorSubject = "d".repeat(40);
    driveCoreImplementToSimplification(fixture, priorSubject);

    // pre_subject == post_subject: the simplify agent genuinely changed nothing,
    // so honoring no_change and skipping post_simplify_review is correct.
    const running = startAttempt(fixture);
    const genuine = event(running, "no_change", {
      id: "simplify-no-change",
      subject: priorSubject,
      preSubject: priorSubject,
    });
    const evaluated = evaluateStageGate(running.pipelines, genuine, { observedSubject: priorSubject });
    expect(evaluated.event.outcome).toBe("no_change");
    expect(JSON.parse(evaluated.receipt.payload)).toMatchObject({
      proposed_result: "no_change",
      outcome: "no_change",
      reason: "typed_semantic_result",
    });

    const advanced = completeStageAttemptActor(running.pipelines, running.tickets, genuine, {
      observedSubject: priorSubject,
    });
    expect(advanced).toMatchObject({
      status: "dispatchable",
      active_stage_id: "test",
    });
  });
});
