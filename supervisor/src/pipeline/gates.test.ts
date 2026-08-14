import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import {
  deriveTuneCorpusDigest,
  deriveTuneCorpusRowDigest,
  parseRatchetDifferentialInput,
  validateCitationContractProposal,
  validateTuneAnalysisContract,
  validateTuneSealedIntentContract,
  validateTuneTaskContract,
  type RatchetDifferentialInput,
  type TuneCorpusRow,
  type TuneCorpusRowContent,
} from "@openthrottle/contracts";
import { openDb } from "../persistence/database.js";
import { drainDeferredProviderEvidence, evaluateStageGate, processProviderEvidence } from "./gates.js";
import { evaluateCitationGate, type CitationGateDecision } from "./citation-gate.js";
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
import { buildStageRequest, createStageRequestHash, type StageRequestEnvelope } from "./stage-request.js";
import {
  acknowledgedPublicationHeadAt,
  drainPipelineFeedbackSnapshots,
  processPipelineFeedbackSnapshot,
  recordPipelineProviderEvent,
} from "../app/provider-feedback.js";
import {
  considerCiGithubHead,
  handleGithubEvent,
  routePipelineProviderEvent,
} from "../providers/github/events.js";
import { beginGithubSupervisorCommentWrite } from "../providers/github/comment-provenance.js";
import { createLinearOutboxProcessor } from "../providers/linear/outbox.js";

const catalogPath = fileURLToPath(new URL("../__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("gate-test/v1");
const SUBJECT = "c".repeat(40);
const PUBLISHED_COMMIT = "9".repeat(40);
const TUNE_PROPOSAL_HASH = "d".repeat(64);
const CODEX_CONNECTOR_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE =
  "To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).";

function codexCleanReviewBody(
  reviewedCommit = PUBLISHED_COMMIT.slice(0, 10),
  encouragement = "Delightful!"
): string {
  return [
    `Codex Review: Didn't find any major issues. ${encouragement}`,
    "",
    `**Reviewed commit:** \`${reviewedCommit}\``,
    "",
    "<details> <summary>ℹ️ About Codex in GitHub</summary>",
    "<br/>",
    "",
    "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
    "- Open a pull request for review",
    "- Mark a draft as ready",
    "- Comment \"@codex review\".",
    "",
    "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
    "",
    "",
    "",
    "",
    "",
    "Codex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".",
    "            ",
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
    const taskType = manifestKey.startsWith("core/investigate")
      ? "investigate"
      : manifestKey.startsWith("core/tune")
        ? "tune"
        : "implement";
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
        taskType,
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType,
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
    fixture.tickets.setSetting("github-head-source:issue-1", "authoritative");
    fixture.tickets.setSetting("github-head-observed-at:issue-1", "2025-01-01T00:00:00.000Z");
  }

  function moveFixtureToStage(fixture: Fixture, stageId: string): Fixture {
    const stage = fixture.manifest.stages.find((candidate) => candidate.id === stageId)!;
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = ?, native_context_policy = ?, expected_subject = ?
      WHERE id = ?
    `).run(stage.id, stage.context, fixture.instance.base_commit, fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instance_stages SET status = 'waiting'
      WHERE pipeline_instance_id = ? AND stage_id = ?
    `).run(fixture.instance.id, stage.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances
      SET active_stage_id = ?
      WHERE id = ?
    `).run(stage.id, fixture.instance.id);
    return {
      ...fixture,
      stage,
      attempt: fixture.pipelines.getAttempt(fixture.attempt.id)!,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
    };
  }

  function tuneAnalysisFixture(): Record<string, unknown> {
    const task = {
      schema: "openthrottle.tune-task/v1",
      id: "task_one",
      target: {
        kind: "skill",
        id: "implement_unit",
        path: "skills/tasks/implement-unit/SKILL.md",
        digest: "1".repeat(64),
      },
      query: { outcome: "failed", reason: "failure", graph: "structured", limit: 1 },
      scope: "repository",
      window: {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
        limit: 1,
      },
      baseline: {
        base_ref: "main",
        base_digest: digestNormalized("a".repeat(40)),
        runtime_release: runtime.descriptor.release,
        capability_digest: runtime.digest,
      },
      policy: {
        allow_edit_paths: ["skills/tasks/implement-unit"],
        requires_citation_gate: true,
        requires_ratchet: true,
        max_changed_files: 1,
      },
    };
    const intent = {
      schema: "openthrottle.tune-sealed-intent/v1",
      id: "intent_one",
      task,
      task_digest: validateTuneTaskContract(task).digest,
      sealed_at: "2026-08-12T00:01:00.000Z",
      authority_digest: "2".repeat(64),
    };
    const rowContent: TuneCorpusRowContent = {
      id: "row_one",
      pipeline_instance_id: "pipeline-1",
      generation: 5,
      execution_graph_id: "structured",
      outcome: "failed",
      closed_reason: "failure",
      fault_attribution: "agent",
      created_at: "2026-08-11T00:00:00.000Z",
      source_digests: ["3".repeat(64)],
    };
    const rows: TuneCorpusRow[] = [{ ...rowContent, row_digest: deriveTuneCorpusRowDigest(rowContent) }];
    return {
      schema: "openthrottle.tune-analysis/v1",
      id: "analysis_one",
      intent,
      intent_digest: validateTuneSealedIntentContract(intent).digest,
      corpus_rows: rows,
      corpus_digest: deriveTuneCorpusDigest(rows),
      generated_at: "2026-08-12T00:02:00.000Z",
    };
  }

  function tuneProposalFixture(analysis: Record<string, unknown>): Record<string, unknown> {
    const task = ((analysis.intent as Record<string, unknown>).task as Record<string, unknown>);
    const row = (analysis.corpus_rows as Record<string, unknown>[])[0]!;
    const citationContract = {
      schema: "openthrottle.citation-contract/v1",
      id: "proposal_one",
      summary: "The proposed change is grounded in a sealed failed run.",
      claims: [{ id: "claim_one", text: "A failed structured run exists.", citation_ids: ["citation_one"] }],
      citations: [{
        id: "citation_one",
        query: { outcome: "failed", reason: "failure", graph: "structured", limit: 1 },
        expected_result: [{
          pipeline_instance_id: row.pipeline_instance_id,
          generation: row.generation,
          execution_graph_id: row.execution_graph_id,
          outcome: row.outcome,
          closed_reason: row.closed_reason,
          fault_attribution: row.fault_attribution,
          created_at: row.created_at,
        }],
        source_digests: structuredClone(row.source_digests),
      }],
      dispositions: [{
        claim_id: "claim_one",
        disposition: "supported",
        rationale: "The sealed corpus contains the cited run.",
        citation_ids: ["citation_one"],
      }],
      grades: [{
        id: "overall",
        value: "pass",
        disposition_claim_ids: ["claim_one"],
        rationale: "The claim is grounded.",
      }],
    };
    const ratchet = parseRatchetDifferentialInput(readFileSync(
      new URL("../../../contracts/fixtures/valid/ratchet-contract.json", import.meta.url),
      "utf8"
    )).value;
    ratchet.id = "proposal_one";
    ratchet.tuner_authority!.proposal_digest = validateCitationContractProposal(citationContract).digest;
    return {
      schema: "openthrottle.tune-proposal/v1",
      id: "proposal_one",
      analysis,
      analysis_digest: validateTuneAnalysisContract(analysis).digest,
      target: structuredClone(task.target),
      query: structuredClone(task.query),
      scope: task.scope,
      window: structuredClone(task.window),
      baseline: structuredClone(task.baseline),
      policy: structuredClone(task.policy),
      outcome: "propose",
      changes: [{
        path: "skills/tasks/implement-unit/SKILL.md",
        operation: "modify",
        before_digest: "4".repeat(64),
        after_digest: digestNormalized("tightened guidance\n"),
        after_content: "tightened guidance\n",
        rationale: "Tighten bounded receipt guidance.",
      }],
      citation_contract: citationContract,
      ratchet_input: ratchet,
    };
  }

  function tuneReceiptFor(
    fixture: Fixture,
    type: "tune_analysis" | "tune_proposal",
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      schema: "openthrottle.receipt/v1",
      type,
      assurance: "semantic_attested",
      result: "success",
      producer: {
        worker_id: "tuner",
        skill: "builtin://tune@1",
        capability_digest: fixture.instance.capability_digest,
        skill_package_digest: null,
      },
      subject: {
        base: fixture.instance.base_commit,
        pre: fixture.instance.base_commit,
        post: fixture.instance.base_commit,
      },
      fence: {
        pipeline_instance_id: fixture.instance.id,
        graph_digest: fixture.instance.manifest_digest,
        unit_id: "__tune__",
        attempt_id: fixture.attempt.id,
        parent_run_id: fixture.attempt.planned_run_id!,
        action_attempt_id: fixture.attempt.id,
        generation: fixture.instance.generation,
        native_session_id: null,
        request_hash: fixture.attempt.request_hash,
      },
      evidence: ["sealed tune contract"],
      payload,
      issued_at: "2026-08-12T00:03:00.000Z",
    };
  }

  function resealTuneStage(
    fixture: Fixture,
    taskContext: string,
    inputArtifacts?: StageRequestEnvelope["inputArtifacts"]
  ): Fixture {
    const request = buildStageRequest({
      instanceId: fixture.instance.id,
      manifestDigest: fixture.instance.manifest_digest,
      runtimeRelease: fixture.instance.runtime_release,
      capabilityDigest: fixture.instance.capability_digest,
      repositoryConfigDigest: fixture.instance.repository_config_digest,
      stage: fixture.stage,
      attemptId: fixture.attempt.id,
      runId: fixture.attempt.planned_run_id!,
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      taskType: "tune",
      taskContext,
      transitionContext: "sealed tune test",
      inputArtifacts,
      repository: fixture.instance.repository,
      baseCommit: fixture.instance.base_commit,
      baseBranch: fixture.instance.base_branch,
      branch: fixture.instance.branch,
      agent: fixture.instance.agent,
      contextRevision: fixture.attempt.context_revision,
      expectedSubject: fixture.instance.base_commit,
      nativeSessionId: null,
    });
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET request_payload = ?, request_hash = ?, idempotency_key = ?
      WHERE id = ?
    `).run(canonicalJson(request), request.requestHash, request.idempotencyKey, fixture.attempt.id);
    return currentStageFixture(fixture);
  }

  function tuneCitationDecision(passed = true): CitationGateDecision {
    const run = {
      pipeline_instance_id: "instance-1",
      generation: 1,
      execution_graph_id: "structured",
      outcome: "failed" as const,
      closed_reason: "failure" as const,
      fault_attribution: "agent" as const,
      created_at: "2026-08-08T00:00:00.000Z",
    };
    return evaluateCitationGate({
      proposalHash: TUNE_PROPOSAL_HASH,
      proposal: {
        schema: "openthrottle.citation-contract/v1",
        id: "proposal_one",
        summary: "Grounded tune proposal.",
        claims: [{ id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] }],
        citations: [{
          id: "citation_one",
          query: { outcome: "failed" },
          expected_result: [run],
          source_digests: ["a".repeat(64)],
        }],
        dispositions: [{
          claim_id: "claim_one",
          disposition: "supported",
          rationale: "Reproduced.",
          citation_ids: ["citation_one"],
        }],
        grades: [{ id: "overall", value: "pass", disposition_claim_ids: ["claim_one"], rationale: "Survives." }],
      },
      resolvedCitations: [{
        id: "citation_one",
        actual_result: passed ? [run] : [],
      }],
    });
  }

  function tuneCitationReceipt(decision = tuneCitationDecision()) {
    return {
      id: `citation-gate-${digestNormalized(canonicalJson([
        decision.proposal_hash,
        decision.hash,
      ])).slice(0, 32)}`,
      proposal_id: decision.proposal_id,
      proposal_hash: decision.proposal_hash,
      gate_result: decision.result,
      outcome: decision.outcome,
      reason: decision.reason,
      grade_hash: decision.grade_hash,
      payload: decision.payload,
      receipt_hash: decision.hash,
      created_at: "2026-08-08T00:00:00.000Z",
    };
  }

  function tuneRatchetInput(proposalDigest = TUNE_PROPOSAL_HASH): RatchetDifferentialInput {
    return {
      schema: "openthrottle.ratchet-contract/v1",
      id: "proposal_one",
      pinned: [{
        id: "skill_package",
        kind: "standard_receipt",
        artifact_digest: "a".repeat(64),
        provenance_digest: "b".repeat(64),
      }],
      proposed: [{
        id: "skill_package",
        kind: "standard_receipt",
        artifact_digest: "a".repeat(64),
        provenance_digest: "b".repeat(64),
      }],
      human_authority: {
        actor_id: "linear-user-1",
        approval_digest: "c".repeat(64),
      },
      tuner_authority: {
        tuner_id: "structured_tuner",
        proposal_digest: proposalDigest,
        model_digest: "e".repeat(64),
      },
    };
  }

  function recordedStageGate(fixture: Fixture) {
    return fixture.db.prepare(`
      SELECT evaluator_kind, result, payload FROM pipeline_gate_receipts
    `).get();
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

    const leaked = event(fixture, "success", { summary: "Bearer opaque-secret-token-value-1234567890" });
    expect(() => evaluateStageGate(fixture.pipelines, leaked)).toThrow(/secret-shaped/);

    const shortAuthorizationToken = event(fixture, "success", { summary: "Authorization: Bearer abc123" });
    expect(() => evaluateStageGate(fixture.pipelines, shortAuthorizationToken)).toThrow(/secret-shaped/);

    const wrappedAuthorizationToken = event(fixture, "success", { summary: "Authorization: Bearer\nabc123" });
    expect(() => evaluateStageGate(fixture.pipelines, wrappedAuthorizationToken)).toThrow(/secret-shaped/);

    const wrappedAuthorizationPrefix = event(fixture, "success", { summary: "Authorization:\nBearer token" });
    expect(() => evaluateStageGate(fixture.pipelines, wrappedAuthorizationPrefix)).toThrow(/secret-shaped/);

    const escapedAuthorizationPrefix = event(fixture, "success", {
      summary: "Authorization:\\nBearer credential-based...",
    });
    expect(() => evaluateStageGate(fixture.pipelines, escapedAuthorizationPrefix)).toThrow(/secret-shaped/);

    const nestedAuthorization = event(fixture, "success", {
      summary: JSON.stringify({ authorization: "Bearer\nabc123" }),
    });
    expect(() => evaluateStageGate(fixture.pipelines, nestedAuthorization)).toThrow(/secret-shaped/);

    const longAuthorization = event(fixture, "success", {
      summary: "Authorization:" + " ".repeat(60) + "Bearer token",
    });
    expect(() => evaluateStageGate(fixture.pipelines, longAuthorization)).toThrow(/secret-shaped/);

    const safeBearerProse = event(fixture, "success", {
      summary: "CODEX_AUTH_JSON bearer credentials. Supports bearer token-based authentication.",
    });
    expect(() => evaluateStageGate(fixture.pipelines, safeBearerProse)).not.toThrow();

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

  it("executes tune citation gates before structured mutation", () => {
    const failedFixture = moveFixtureToStage(setup("core/tune@1"), "citation_gate");
    const failed = processStageEvidence(failedFixture.pipelines, event(failedFixture, "success", {
      details: { citation_gate: tuneCitationDecision(false) },
    }), { observedSubject: SUBJECT });
    expect(failed).toMatchObject({ status: "completion_pending_publication", terminal_outcome: "failed" });
    expect(failed.active_stage_id).not.toBe("structured_edit");
    expect(recordedStageGate(failedFixture)).toMatchObject({ evaluator_kind: "citation", result: "failed" });

    const passedFixture = moveFixtureToStage(setup("core/tune@1"), "citation_gate");
    const passed = processStageEvidence(passedFixture.pipelines, event(passedFixture, "success", {
      details: { citation_gate: tuneCitationDecision(true) },
    }), { observedSubject: SUBJECT });
    expect(passed).toMatchObject({ status: "dispatchable", active_stage_id: "differential_ratchet" });
    const nextRequest = passedFixture.pipelines.getStageRequest(
      passedFixture.pipelines.getActiveAttempt(passed.id)!.id
    );
    expect(nextRequest.taskContext).toBe("Supervisor-sealed tune evidence is carried only by inputArtifacts.");
    expect(nextRequest.inputArtifacts?.map((artifact) => artifact.kind)).toContain("stage_result");
    expect(recordedStageGate(passedFixture)).toMatchObject({ evaluator_kind: "citation", result: "passed" });
  });

  it("binds tune analysis receipts to the supervisor-sealed corpus", () => {
    const analysis = tuneAnalysisFixture();
    const { generated_at: _generatedAt, ...analysisMaterial } = analysis;
    const analysisInput = {
      ...analysisMaterial,
      schema: "openthrottle.tune-analysis-input/v1",
    };
    const taskContext = [
      "```json openthrottle.tune-analysis-input/v1",
      canonicalJson(analysisInput),
      "```",
    ].join("\n");
    const accepted = resealTuneStage(setup("core/tune@1"), taskContext);
    const producedAnalysis = { ...analysis, generated_at: "2026-08-12T00:03:00.000Z" };
    const acceptedReceipt = tuneReceiptFor(accepted, "tune_analysis", {
      summary: "Sealed corpus packaged.",
      analysis: producedAnalysis,
    });
    expect(() => evaluateStageGate(accepted.pipelines, event(accepted, "success", {
      details: { receipt: acceptedReceipt },
    }))).not.toThrow();

    const forgedAnalysis = { ...producedAnalysis, id: "analysis_forged" };
    const rejected = resealTuneStage(setup("core/tune@1"), taskContext);
    const rejectedReceipt = tuneReceiptFor(rejected, "tune_analysis", {
      summary: "Attempted corpus replacement.",
      analysis: forgedAnalysis,
    });
    expect(() => evaluateStageGate(rejected.pipelines, event(rejected, "success", {
      details: { receipt: rejectedReceipt },
    }))).toThrow(/does not preserve the supervisor-sealed input/);
  });

  it("binds tune proposals to the immediately preceding analysis receipt", () => {
    const analysis = tuneAnalysisFixture();
    const createProposalFixture = () => {
      const fixture = moveFixtureToStage(setup("core/tune@1"), "proposal");
      const predecessorReceipt = tuneReceiptFor(fixture, "tune_analysis", {
        summary: "Sealed corpus packaged.",
        analysis,
      });
      const predecessor = artifact(fixture, "standard_receipt", "success", {
        details: { receipt: predecessorReceipt },
        subject: fixture.instance.base_commit,
        preSubject: fixture.instance.base_commit,
      });
      return resealTuneStage(fixture, "Supervisor-sealed tune evidence is carried only by inputArtifacts.", [{
        kind: "standard_receipt",
        schemaVersion: predecessor.schemaVersion,
        assurance: predecessor.assurance,
        subject: predecessor.subject ?? null,
        payload: predecessor.payload,
        hash: predecessor.hash,
      }]);
    };

    const accepted = createProposalFixture();
    const acceptedReceipt = tuneReceiptFor(accepted, "tune_proposal", {
      summary: "One bounded change proposed.",
      proposal: tuneProposalFixture(analysis),
    });
    expect(() => evaluateStageGate(accepted.pipelines, event(accepted, "success", {
      details: { receipt: acceptedReceipt },
      subject: accepted.instance.base_commit,
      preSubject: accepted.instance.base_commit,
    }))).not.toThrow();

    const forgedAnalysis = { ...analysis, id: "analysis_forged" };
    const rejected = createProposalFixture();
    const rejectedReceipt = tuneReceiptFor(rejected, "tune_proposal", {
      summary: "Attempted predecessor replacement.",
      proposal: tuneProposalFixture(forgedAnalysis),
    });
    expect(() => evaluateStageGate(rejected.pipelines, event(rejected, "success", {
      details: { receipt: rejectedReceipt },
      subject: rejected.instance.base_commit,
      preSubject: rejected.instance.base_commit,
    }))).toThrow(/not bound to its authorized analysis receipt/);
  });

  it("executes tune differential-ratchet gates before structured mutation", () => {
    const citation = tuneCitationDecision(true);
    const failedFixture = moveFixtureToStage(setup("core/tune@1"), "differential_ratchet");
    const failed = processStageEvidence(failedFixture.pipelines, event(failedFixture, "success", {
      details: {
        citation_gate: citation,
        citation_receipt: tuneCitationReceipt(citation),
        ratchet_input: tuneRatchetInput("f".repeat(64)),
      },
    }), { observedSubject: SUBJECT });
    expect(failed).toMatchObject({ status: "completion_pending_publication", terminal_outcome: "failed" });
    expect(failed.active_stage_id).not.toBe("structured_edit");
    expect(recordedStageGate(failedFixture)).toMatchObject({
      evaluator_kind: "differential_ratchet",
      result: "failed",
    });

    const passedFixture = moveFixtureToStage(setup("core/tune@1"), "differential_ratchet");
    const passed = processStageEvidence(passedFixture.pipelines, event(passedFixture, "success", {
      details: {
        citation_gate: citation,
        citation_receipt: tuneCitationReceipt(citation),
        ratchet_input: tuneRatchetInput(),
      },
    }), { observedSubject: SUBJECT });
    expect(passed).toMatchObject({ status: "dispatchable", active_stage_id: "structured_edit" });
    expect(recordedStageGate(passedFixture)).toMatchObject({
      evaluator_kind: "differential_ratchet",
      result: "passed",
    });
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

  it("marks deferred provider evidence dead once its instance is terminal while live rows survive", async () => {
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
    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "provider-deferred-terminal",
      outcome: "success",
      summary: "GitHub reports the pull request merged.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { merged: true, head_sha: publishedCommit },
      headSha: publishedCommit,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    expect(fixture.pipelines.getInboxEvent("provider-deferred-terminal")?.status).toBe("pending");

    // Live but mid-publication: the deferred row survives untouched so it can
    // coordinate when the instance returns to waiting_provider.
    expect(await drainDeferredProviderEvidence(fixture.pipelines)).toBe(0);
    expect(fixture.pipelines.getInboxEvent("provider-deferred-terminal")?.status).toBe("pending");

    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'failed', terminal_outcome = 'failed' WHERE id = ?
    `).run(fixture.instance.id);
    expect(await drainDeferredProviderEvidence(fixture.pipelines)).toBe(0);
    expect(fixture.pipelines.getInboxEvent("provider-deferred-terminal")?.status).toBe("dead");
    // The dead row no longer occupies the global oldest-first pending window.
    expect(fixture.pipelines.listPendingInboxEvents("provider_snapshot")).toEqual([]);
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

  it("recovers a canceled merge after an older concurrent reconciliation commits first", async () => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = PUBLISHED_COMMIT;
    moveFixtureToProviderWait(fixture, SUBJECT, headC);
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
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headA },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:00.000Z" },
      { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
    ]);

    let releaseOlderFetch!: (response: Response) => void;
    let releaseMergeFetch!: (response: Response) => void;
    let markOlderFetchStarted!: () => void;
    let markMergeFetchStarted!: () => void;
    const olderFetch = new Promise<Response>((resolve) => {
      releaseOlderFetch = resolve;
    });
    const mergeFetch = new Promise<Response>((resolve) => {
      releaseMergeFetch = resolve;
    });
    const olderFetchStarted = new Promise<void>((resolve) => {
      markOlderFetchStarted = resolve;
    });
    const mergeFetchStarted = new Promise<void>((resolve) => {
      markMergeFetchStarted = resolve;
    });
    const fetchMock = vi.fn((): Promise<Response> => {
      if (fetchMock.mock.calls.length === 1) {
        markOlderFetchStarted();
        return olderFetch;
      }
      if (fetchMock.mock.calls.length === 2) {
        markMergeFetchStarted();
        return mergeFetch;
      }
      return Promise.resolve(Response.json({ head: { sha: headC } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const olderSynchronize = handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      {} as never,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:05.000Z",
          head: { ref: "ot/issue-1", sha: headB },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    await olderFetchStarted;
    const mergedClose = handleGithubEvent(
      { githubReadToken: "read-token" } as never,
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
          updated_at: "2026-01-01T00:00:06.000Z",
          head: { ref: "ot/issue-1", sha: headC },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    await mergeFetchStarted;

    releaseOlderFetch(Response.json({ head: { sha: headB } }));
    await olderSynchronize;
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headB);
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "canceled",
      terminal_outcome: "canceled",
    });

    releaseMergeFetch(Response.json({ head: { sha: headC } }));
    await mergedClose;
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
    expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
      .toBe("live_reconciliation");
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "completion_pending_publication",
      terminal_outcome: "shipped",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
          commit_id: PUBLISHED_COMMIT,
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
      setSettings: vi.fn(),
      acquireSupervisorLease: vi.fn(() => true),
      releaseSupervisorLease: vi.fn(() => true),
      getSetting: vi.fn(() => SUBJECT),
      listSettings: vi.fn(() => []),
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
    fixture.tickets.setSetting("github-head-source:issue-1", "authoritative");
    fixture.tickets.setSetting("github-head-observed-at:issue-1", "2025-01-01T00:00:00.000Z");
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
          head: { ref: "ot/issue-1", sha: SUBJECT },
          base: { ref: "main" },
        },
        review: {
          id,
          state: "commented",
          commit_id: SUBJECT,
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
          created_at: "2099-01-01T00:00:00.000Z",
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
          commit_id: PUBLISHED_COMMIT,
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
          created_at: "2099-01-01T00:00:00.000Z",
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
          created_at: "2099-01-01T00:00:00.000Z",
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
          created_at: "2099-01-01T00:00:00.000Z",
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
          commit_id: PUBLISHED_COMMIT,
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
          commit_id: PUBLISHED_COMMIT,
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

  it.each([
    { encouragement: "Keep it up!", userType: "Bot" },
    { encouragement: "Delightful!", userType: "Bot" },
    { encouragement: "Keep it up!", userType: undefined },
  ])(
    "routes exact trusted Codex clean review completion with $encouragement and user type $userType as successful current-head evidence",
    async ({ encouragement, userType }) => {
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
      const body = codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10), encouragement);
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
            user: {
              login: CODEX_CONNECTOR_LOGIN,
              ...(userType === undefined ? {} : { type: userType }),
            },
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
    }
  );

  it("retries a trusted Codex review when the live PR head transition is not durable", async () => {
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
          id: 705,
          body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
          created_at: "2099-01-01T00:00:00.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-705",
          user: { login: CODEX_CONNECTOR_LOGIN, type: "Bot" },
        },
      },
      fixture.pipelines
    )).rejects.toThrow("GitHub pull-request head transition is not durable yet");

    expect(activityPublisher.publishActivity).not.toHaveBeenCalled();
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
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
    const setupNotice = (id: number, authorType?: string) => handleGithubEvent(
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
          created_at: "2099-01-01T00:00:00.000Z",
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: {
            login: CODEX_CONNECTOR_LOGIN,
            ...(authorType === undefined ? {} : { type: authorType }),
          },
        },
      },
      fixture.pipelines
    );

    await setupNotice(703, "Bot");
    await setupNotice(703, "Bot");
    await setupNotice(707);

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
    {
      label: "exact connector login with a non-Bot type copying setup notice",
      body: CODEX_CONNECTOR_SETUP_REQUIRED_NOTICE,
      user: { login: CODEX_CONNECTOR_LOGIN, type: "User" },
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
          created_at: "2099-01-01T00:00:00.000Z",
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
    {
      label: "exact connector login with a non-Bot type copying clean review text",
      body: codexCleanReviewBody(PUBLISHED_COMMIT.slice(0, 10)),
      user: { login: CODEX_CONNECTOR_LOGIN, type: "User" },
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
          created_at: "2099-01-01T00:00:00.000Z",
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
          commit_id: PUBLISHED_COMMIT,
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

  it("orders delayed feedback by durable webhook ingress rather than handler time", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const repairedSubject = "e".repeat(40);
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(
      fixture,
      SUBJECT,
      { publishedCommit: previousHead },
      "publication-before-delayed-ingress"
    );
    moveFixtureToProviderWait(fixture, SUBJECT, previousHead);
    fixture.tickets.finishRun({
      runId: fixture.attempt.planned_run_id!,
      status: "completed",
    });

    expect(await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:repair-driver-before-delayed-ingress",
      outcome: "semantic_repair_required",
      summary: "The first processed review starts repair.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-driver"],
      payload: { kind: "pull_request_review" },
      headSha: previousHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    })).toBe(true);
    const repairStartedAt = fixture.pipelines.listAttempts(fixture.instance.id)
      .filter((attempt) => attempt.stage_id === "repair_implementation")
      .map((attempt) => attempt.created_at)
      .sort()
      .at(0);
    expect(repairStartedAt).toBeDefined();
    const delayedIngressAt = new Date(Date.parse(repairStartedAt!) - 1_000).toISOString();

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
          updated_at: delayedIngressAt,
          head: { ref: "ot/issue-1", sha: previousHead },
          base: { ref: "main" },
        },
        review: {
          id: 4907097137,
          state: "commented",
          commit_id: previousHead,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-delayed",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines,
      {
        ports: {} as never,
        coordinator: {} as never,
        receivedAt: delayedIngressAt,
      }
    );
    const delayedSnapshot = fixture.db.prepare(`
      SELECT fs.* FROM feedback_snapshots fs
      JOIN provider_events pe ON pe.snapshot_id = fs.id
      WHERE pe.provider_event_id = ?
    `).get("github-review:4907097137") as FeedbackSnapshot;
    expect(fixture.db.prepare(`
      SELECT received_at FROM provider_events WHERE provider_event_id = ?
    `).get("github-review:4907097137"))
      .toEqual({ received_at: delayedIngressAt });
    expect(delayedSnapshot.provider_watermark < repairStartedAt!).toBe(true);

    expect(settleForwardChainToPublish(
      fixture,
      repairedSubject,
      SUBJECT,
      2
    ).active_stage_id).toBe("publish");
    recordAcknowledgedPublication(
      fixture,
      repairedSubject,
      { publishedCommit: repairedHead },
      "publication-after-delayed-ingress"
    );
    expect(settleCurrentStage(fixture, "success", {
      id: "publish-after-delayed-ingress",
      subject: repairedSubject,
      preSubject: repairedSubject,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: repairedHead,
        provider_revision: repairedHead,
      },
    })).toMatchObject({
      status: "waiting_provider",
      published_commit: repairedHead,
    });
    fixture.tickets.setSetting("github-head:issue-1", repairedHead);

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: fixture.db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?")
        .get(delayedSnapshot.id) as FeedbackSnapshot,
    })).toBe(true);
    expect(fixture.db.prepare(`
      SELECT status, head_sha FROM feedback_snapshots WHERE id = ?
    `).get(delayedSnapshot.id)).toEqual({ status: "consumed", head_sha: repairedHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 2,
    });
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

  it("records a delayed review against its reviewed commit instead of the newer PR head", async () => {
    const fixture = setup("core/implement@4");
    const reviewedHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: reviewedHead }, "publication-reviewed");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: repairedHead }, "publication-repaired");
    moveFixtureToProviderWait(fixture, SUBJECT, repairedHead);
    fixture.tickets.setSetting("github-head:issue-1", reviewedHead);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

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
          head: { ref: "ot/issue-1", sha: repairedHead },
          base: { ref: "main" },
        },
        review: {
          id: 4907097134,
          state: "commented",
          commit_id: reviewedHead,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907097134",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-review:4907097134")).toEqual({ head_sha: reviewedHead });
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(repairedHead);
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: reviewedHead });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get()).toBeDefined();

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:fresh-after-delayed-old-review",
      outcome: "semantic_repair_required",
      summary: "Fresh feedback against the repaired head.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-fresh"],
      payload: { kind: "pull_request_review", id: "fresh-after-delayed-old-review" },
      headSha: repairedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it.each(["pull_request", "pull_request_review", "approved_review"] as const)(
    "does not regress the persisted authoritative head for a delayed older-head %s webhook",
    async (eventKind) => {
      const fixture = setup("core/implement@4");
      const previousHead = "d".repeat(40);
      const currentHead = PUBLISHED_COMMIT;
      const currentObservedAt = "2026-01-01T00:00:10.000Z";
      const activityPublisher = {
        publishActivity: vi.fn(async () => undefined),
        publishError: vi.fn(async () => undefined),
      };
      fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
      recordAcknowledgedPublication(
        fixture,
        "b".repeat(40),
        { publishedCommit: previousHead },
        "publication-previous-for-delayed-webhook"
      );
      recordAcknowledgedPublication(
        fixture,
        SUBJECT,
        { publishedCommit: currentHead },
        "publication-current-for-delayed-webhook"
      );
      moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
      fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
        .run(fixture.instance.id);
      fixture.tickets.setSetting("github-head-source:issue-1", "authoritative");
      fixture.tickets.setSetting("github-head-observed-at:issue-1", currentObservedAt);

      const event = eventKind === "pull_request"
        ? {
            kind: "pull_request",
            action: "synchronize",
            repository: { full_name: "owner/repo" },
            pull_request: {
              number: 1,
              html_url: "https://github.com/owner/repo/pull/1",
              merged: false,
              updated_at: "2026-01-01T00:00:05.000Z",
              head: { ref: "ot/issue-1", sha: previousHead },
              base: { ref: "main" },
            },
          }
        : {
            kind: "pull_request_review",
            action: "submitted",
            repository: { full_name: "owner/repo" },
            pull_request: {
              number: 1,
              html_url: "https://github.com/owner/repo/pull/1",
              updated_at: "2026-01-01T00:00:05.000Z",
              head: { ref: "ot/issue-1", sha: previousHead },
              base: { ref: "main" },
            },
            review: {
              id: 4907097135,
              state: eventKind === "approved_review" ? "approved" : "commented",
              commit_id: previousHead,
              html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907097135",
              user: { login: "reviewer" },
            },
          };
      await handleGithubEvent(
        {} as never,
        fixture.tickets,
        activityPublisher,
        event as never,
        fixture.pipelines
      );

      expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(currentHead);
      expect(fixture.tickets.getSetting("github-head-source:issue-1")).toBe("authoritative");
      expect(fixture.tickets.getSetting("github-head-observed-at:issue-1")).toBe(currentObservedAt);
      expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
        status: "waiting_provider",
        published_commit: currentHead,
      });
      expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
        stage_id: "provider",
        reentry_ordinal: 0,
      });
    }
  );

  it.each([
    { label: "an equal provider timestamp", priorObservedAt: "2026-01-01T00:00:05.000Z" },
    { label: "a legacy projection with no observation timestamp", priorObservedAt: undefined },
  ])("reconciles a different authoritative head live for $label", async ({ priorObservedAt }) => {
    const fixture = setup("core/implement@4");
    const priorHead = "d".repeat(40);
    const liveHead = PUBLISHED_COMMIT;
    const eventObservedAt = "2026-01-01T00:00:05.000Z";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT, priorHead);
    fixture.tickets.setSetting("github-head:issue-1", priorHead);
    fixture.tickets.setSetting("github-head-source:issue-1", "authoritative");
    if (priorObservedAt) {
      fixture.tickets.setSetting("github-head-observed-at:issue-1", priorObservedAt);
    } else {
      fixture.db.prepare("DELETE FROM settings WHERE key = ?")
        .run("github-head-observed-at:issue-1");
    }
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/1");
      return Response.json({ head: { sha: liveHead } });
    }));

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "opened",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: eventObservedAt,
          head: { ref: "ot/issue-1", sha: liveHead },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );

    const reconciledObservedAt = fixture.tickets.getSetting(
      "github-head-observed-at:issue-1"
    );
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(liveHead);
    expect(fixture.tickets.getSetting("github-head-source:issue-1")).toBe("authoritative");
    expect(reconciledObservedAt).toBe(eventObservedAt);
    expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
      .toBe("provider_event");
    expect(fixture.tickets.listSettings("github-head-observation:issue-1:")
      .map(({ value }) => JSON.parse(value))).toEqual(expect.arrayContaining([
      expect.objectContaining({ headSha: liveHead, observedAt: eventObservedAt }),
    ]));
  });

  it("keeps the live current head when a delayed approved review carries a newer misleading timestamp", async () => {
    const fixture = setup("core/implement@4");
    const reviewedHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    const currentObservedAt = "2026-01-01T00:00:10.000Z";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
    fixture.tickets.setSetting("github-head-observed-at:issue-1", currentObservedAt);
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/1");
      return Response.json({ head: { sha: currentHead } });
    }));

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          updated_at: "2026-01-01T00:00:15.000Z",
          head: { ref: "ot/issue-1", sha: reviewedHead },
          base: { ref: "main" },
        },
        review: {
          id: 4907097136,
          state: "approved",
          commit_id: reviewedHead,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907097136",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(currentHead);
    expect(fixture.tickets.getSetting("github-head-observed-at:issue-1")).toBe(currentObservedAt);
    expect(fixture.db.prepare("SELECT COUNT(*) FROM provider_events").pluck().get()).toBe(0);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it.each(["reopened", "closed"] as const)(
    "uses a pull request %s timestamp only for the current projection",
    async (action) => {
      const fixture = setup("core/implement@4");
      const priorHead = "d".repeat(40);
      const projectedHead = PUBLISHED_COMMIT;
      const updatedAt = "2026-01-01T00:00:06.000Z";
      const activityPublisher = {
        publishActivity: vi.fn(async () => undefined),
        publishError: vi.fn(async () => undefined),
      };
      fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
      moveFixtureToProviderWait(fixture, SUBJECT, projectedHead);
      fixture.tickets.setSettings([
        { key: "github-head:issue-1", value: priorHead },
        { key: "github-head-source:issue-1", value: "authoritative" },
        { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:00.000Z" },
        { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
      ]);

      await handleGithubEvent(
        {} as never,
        fixture.tickets,
        activityPublisher,
        {
          kind: "pull_request",
          action,
          repository: { full_name: "owner/repo" },
          pull_request: {
            number: 1,
            html_url: "https://github.com/owner/repo/pull/1",
            merged: false,
            updated_at: updatedAt,
            head: { ref: "ot/issue-1", sha: projectedHead },
            base: { ref: "main" },
          },
        },
        fixture.pipelines
      );

      expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(projectedHead);
      expect(fixture.tickets.getSetting("github-head-observed-at:issue-1")).toBe(updatedAt);
      expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
        .toBe("provider_projection");
      expect(fixture.tickets.listSettings("github-head-observation:issue-1:")
        .map(({ value }) => JSON.parse(value)))
        .not.toContainEqual(expect.objectContaining({
          headSha: projectedHead,
          observedAt: updatedAt,
          provenance: "provider_event",
        }));
    }
  );

  it("rotates the projection generation only when CI fallback state advances", () => {
    const fixture = setup("core/implement@4");
    considerCiGithubHead(fixture.tickets, "issue-1", "workflow-head", "workflow_run", 100);
    const firstGeneration = fixture.tickets.getSetting(
      "github-head-projection-generation:issue-1"
    );
    expect(firstGeneration).toEqual(expect.any(String));

    considerCiGithubHead(fixture.tickets, "issue-1", "check-head", "check_suite", 1);
    const secondGeneration = fixture.tickets.getSetting(
      "github-head-projection-generation:issue-1"
    );
    expect(secondGeneration).toEqual(expect.any(String));
    expect(secondGeneration).not.toBe(firstGeneration);

    considerCiGithubHead(fixture.tickets, "issue-1", "stale-check-head", "check_suite", 1);
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe("check-head");
    expect(fixture.tickets.getSetting("github-head-projection-generation:issue-1"))
      .toBe(secondGeneration);
  });

  it("records a delayed top-level PR comment against the head published when it was created", async () => {
    const fixture = setup("core/implement@4");
    const commentedHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: commentedHead }, "publication-commented");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: repairedHead }, "publication-repaired");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-commented");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:10.000Z", "2026-01-01T00:00:10.000Z", "publication-repaired");
    moveFixtureToProviderWait(fixture, SUBJECT, repairedHead);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

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
          id: 4907098001,
          body: "Please repair the provider feedback handling.",
          created_at: "2026-01-01T00:00:05.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098001",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098001")).toEqual({ head_sha: commentedHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: commentedHead });
    expect(fixture.pipelines.getInstance(fixture.instance.id)).toMatchObject({
      status: "waiting_provider",
      terminal_outcome: null,
    });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
    const staleNotice = fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get() as { payload: string };
    expect(JSON.parse(staleNotice.payload).activity.body).toContain("github:github-comment:4907098001");
    expect(JSON.parse(staleNotice.payload).activity.body).toContain(`reviewed_head=${commentedHead}`);
    expect(JSON.parse(staleNotice.payload).activity.body).toContain(`current_published_head=${repairedHead}`);
  });

  it("ignores a moved GitHub summary when binding a delayed predecessor-head comment", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    const summaryCreatedAt = "2026-01-01T00:00:02.000Z";
    const commentCreatedAt = "2026-01-01T00:00:03.000Z";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    const originalSummary = fixture.pipelines.listPublications(fixture.instance.id)
      .find((publication) => publication.kind === "github_summary")!;
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, updated_at = ?
      WHERE id = ?
    `).run(summaryCreatedAt, summaryCreatedAt, originalSummary.id);
    fixture.tickets.finishRun({
      runId: fixture.attempt.planned_run_id!,
      status: "failed",
    });

    const catalog = loadPipelineCatalog(shippedCatalogPath, runtime.descriptor);
    const manifest = catalog.manifests.get("core/implement@4")!;
    const snapshot = fixture.pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config: parseRepositoryConfig("schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: core/implement@4 }\ntest: npm test\n"),
    });
    fixture.tickets.upsert({
      ticket_id: fixture.instance.ticket_id,
      ticket_reference: "ISSUE-1",
      session_id: "session-2",
      sandbox_id: null,
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/1",
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
    const replacement = fixture.pipelines.getInstanceForSession("session-2")!;
    expect(fixture.pipelines.listPublications(fixture.instance.id)
      .some((publication) => publication.kind === "github_summary")).toBe(false);
    expect(fixture.pipelines.listPublications(replacement.id)
      .find((publication) => publication.kind === "github_summary")).toMatchObject({
      id: originalSummary.id,
      created_at: summaryCreatedAt,
    });

    let replacementFixture: Fixture = {
      ...fixture,
      instance: replacement,
      attempt: fixture.pipelines.getActiveAttempt(replacement.id)!,
      stage: fixture.manifest.stages.find((stage) => stage.id === replacement.active_stage_id)!,
    };
    recordAcknowledgedPublication(
      replacementFixture,
      "b".repeat(40),
      { publishedCommit: previousHead },
      "successor-previous-publication"
    );
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET status = 'pending', acknowledged_at = NULL
      WHERE id = 'successor-previous-publication'
    `).run();
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'publish', native_context_policy = 'resume_required'
      WHERE id = ?
    `).run(replacementFixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', active_stage_id = 'publish' WHERE id = ?
    `).run(replacement.id);
    replacementFixture = {
      ...replacementFixture,
      instance: fixture.pipelines.getInstance(replacement.id)!,
      attempt: fixture.pipelines.getAttempt(replacementFixture.attempt.id)!,
      stage: fixture.manifest.stages.find((stage) => stage.id === "publish")!,
    };
    expect(settleCurrentStage(replacementFixture, "success", {
      id: "successor-current-publication",
      subject: SUBJECT,
      preSubject: SUBJECT,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: currentHead,
        provider_revision: currentHead,
      },
    })).toMatchObject({
      status: "waiting_provider",
      published_commit: currentHead,
    });
    const movedSummary = fixture.pipelines.listPublications(replacement.id)
      .find((publication) => publication.kind === "github_summary")!;
    expect(movedSummary).toMatchObject({
      id: originalSummary.id,
      created_at: summaryCreatedAt,
      pipeline_instance_id: replacement.id,
    });
    expect(movedSummary.payload).toContain(currentHead);
    fixture.tickets.setSetting("github-head:issue-1", currentHead);

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
          id: 4907098010,
          body: "Delayed feedback against the predecessor head.",
          created_at: commentCreatedAt,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098010",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098010")).toEqual({ head_sha: previousHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: previousHead });
    expect(fixture.pipelines.getActiveAttempt(replacement.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("binds a post-push comment to a provider-observed head before its receipt exists", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-before-push");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: currentHead }, "publication-after-push");
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);

    await handleGithubEvent(
      {} as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          head: { ref: "ot/issue-1", sha: currentHead },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    const observedAt = fixture.tickets.getSetting("github-head-observed-at:issue-1");
    expect(observedAt).toBeDefined();
    const priorReceiptAt = new Date(Date.parse(observedAt!) - 1_000).toISOString();
    const commentCreatedAt = new Date(Date.parse(observedAt!) + 1_000).toISOString();
    const currentReceiptAt = new Date(Date.parse(observedAt!) + 2_000).toISOString();
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run(priorReceiptAt, priorReceiptAt, "publication-before-push");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run(currentReceiptAt, currentReceiptAt, "publication-after-push");

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
          id: 4907098011,
          body: "Feedback after the provider-visible push.",
          created_at: commentCreatedAt,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098011",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098011")).toEqual({ head_sha: currentHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "consumed", head_sha: currentHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("fails closed when a delayed comment predates every immutable head observation", async () => {
    const fixture = setup("core/implement@4");
    const currentHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(
      fixture,
      SUBJECT,
      { publishedCommit: currentHead },
      "successor-first-publication"
    );
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run(
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:10.000Z",
      "successor-first-publication"
    );
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
    fixture.tickets.setSetting("github-head-source:issue-1", "unverified");

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
          id: 4907098012,
          body: "Delayed feedback without a provable historical head.",
          created_at: "2026-01-01T00:00:05.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098012",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098012")).toEqual({ head_sha: "unknown:ot/issue-1" });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: "unknown:ot/issue-1" });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("retries a post-push comment until the new head has a durable provider observation", async () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const pushedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    const commentEvent = {
      kind: "issue_comment" as const,
      action: "created",
      repository: { full_name: "owner/repo" },
      issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
      comment: {
        id: 4907098013,
        body: "Feedback submitted after the new head was pushed.",
        created_at: "2026-01-01T00:00:05.000Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098013",
        user: { login: "reviewer" },
      },
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(
      fixture,
      "b".repeat(40),
      { publishedCommit: previousHead },
      "publication-before-unobserved-push"
    );
    moveFixtureToProviderWait(fixture, "b".repeat(40), previousHead);
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET stage_id = 'publish', native_context_policy = 'resume_required'
      WHERE id = ?
    `).run(fixture.attempt.id);
    fixture.db.prepare(`
      UPDATE pipeline_instances SET status = 'running', active_stage_id = 'publish'
      WHERE id = ?
    `).run(fixture.instance.id);
    fixture.tickets.setSetting("github-head-source:issue-1", "authoritative");
    fixture.tickets.setSetting("github-head-observed-at:issue-1", "2026-01-01T00:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/1");
      return Response.json({ head: { sha: pushedHead } });
    }));

    await expect(handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      commentEvent,
      fixture.pipelines
    )).rejects.toThrow("GitHub pull-request head transition is not durable yet");
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM provider_events WHERE provider_event_id = ?
    `).pluck().get("github-comment:4907098013")).toBe(0);

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:04.000Z",
          head: { ref: "ot/issue-1", sha: pushedHead },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      commentEvent,
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098013")).toEqual({ head_sha: pushedHead });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM provider_events WHERE provider_event_id = ? AND head_sha = ?
    `).pluck().get("github-comment:4907098013", previousHead)).toBe(0);
  });

  it("uses delayed append-only head observations without carrying intermediate feedback into its successor", async () => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "d".repeat(40), { publishedCommit: headA }, "publication-head-a");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: headC }, "publication-head-c");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-head-a");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:10.000Z", "2026-01-01T00:00:10.000Z", "publication-head-c");
    moveFixtureToProviderWait(fixture, SUBJECT, headC);
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headC },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:10.000Z" },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:00.000Z:${headA}`,
        value: JSON.stringify({ headSha: headA, observedAt: "2026-01-01T00:00:00.000Z" }),
      },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:10.000Z:${headC}`,
        value: JSON.stringify({ headSha: headC, observedAt: "2026-01-01T00:00:10.000Z" }),
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ head: { sha: headC } })));

    // B's synchronize delivery is processed after C but retains its provider
    // timestamp without regressing the current projection.
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:05.000Z",
          head: { ref: "ot/issue-1", sha: headB },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 4907098014,
          body: "Feedback created while the PR was on intermediate head B.",
          created_at: "2026-01-01T00:00:07.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098014",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098014")).toEqual({ head_sha: headB });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: headB });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get()).toBeDefined();
  });

  it("fails closed visibly when intermediate-head feedback arrives before its delayed observation", async () => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "d".repeat(40), { publishedCommit: headA }, "publication-a-before-gap");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-a-before-gap");
    moveFixtureToProviderWait(fixture, SUBJECT, headC);
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headC },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:10.000Z" },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:00.000Z:${headA}`,
        value: JSON.stringify({ headSha: headA, observedAt: "2026-01-01T00:00:00.000Z" }),
      },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:10.000Z:${headC}`,
        value: JSON.stringify({ headSha: headC, observedAt: "2026-01-01T00:00:10.000Z" }),
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ head: { sha: headC } })));

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 4907098016,
          body: "Feedback from B arrived before B's synchronize delivery.",
          created_at: "2026-01-01T00:00:07.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098016",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098016")).toEqual({ head_sha: "unknown:ot/issue-1" });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: "unknown:ot/issue-1" });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get()).toBeDefined();

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:05.000Z",
          head: { ref: "ot/issue-1", sha: headB },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
    expect(fixture.tickets.listSettings("github-head-observation:issue-1:")
      .map(({ value }) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      headSha: headB,
      observedAt: "2026-01-01T00:00:05.000Z",
    }));
    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098016")).toEqual({ head_sha: "unknown:ot/issue-1" });
  });

  it("does not treat handler-time live reconciliation as proof that successor feedback reviewed its predecessor", async () => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = "c".repeat(40);
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT, headC);
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headA },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:00.000Z" },
      { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:00.000Z:${headA}:provider_event`,
        value: JSON.stringify({
          headSha: headA,
          observedAt: "2026-01-01T00:00:00.000Z",
          provenance: "provider_event",
        }),
      },
    ]);
    const fetchMock = vi.fn(async () => Response.json({
      head: { sha: headC },
      // The current PR resource says C is live, but this generic timestamp is
      // not a durable head-transition cursor and must not be treated as one.
      updated_at: "2026-01-01T00:00:06.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    // B@t5 is delivered after the provider has already moved to C@t6. The live
    // reconciliation runs at handler time, later than F's provider time t7.
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:05.000Z",
          head: { ref: "ot/issue-1", sha: headB },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
    expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
      .toBe("live_reconciliation");

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          updated_at: "2026-01-01T00:00:06.000Z",
          head: { ref: "ot/issue-1", sha: headC },
          base: { ref: "main" },
        },
        review: {
          id: 4907098017,
          state: "approved",
          commit_id: headC,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907098017",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );
    expect(fixture.tickets.listSettings("github-head-observation:issue-1:")
      .map(({ value }) => JSON.parse(value)))
      .not.toContainEqual(expect.objectContaining({
        headSha: headC,
        observedAt: "2026-01-01T00:00:06.000Z",
        provenance: "provider_event",
      }));
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 4907098017,
          body: "Feedback created on C after C became current at the provider.",
          created_at: "2026-01-01T00:00:07.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098017",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    const providerEvent = fixture.db.prepare(`
      SELECT head_sha, payload FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098017") as { head_sha: string; payload: string };
    expect(providerEvent.head_sha).toBe("unknown:ot/issue-1");
    expect(providerEvent.head_sha).not.toBe(headB);
    expect(providerEvent.head_sha).not.toBe(headC);
    expect(JSON.parse(JSON.parse(providerEvent.payload).payload)).toMatchObject({
      classification: "head_ordering_ambiguous",
    });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: "unknown:ot/issue-1" });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get()).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["newer_first", "older_first"] as const)(
    "reconciles concurrent live-head responses when %s completes",
    async (completionOrder) => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = "c".repeat(40);
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT, headC);
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headA },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: "2026-01-01T00:00:00.000Z" },
      { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
      {
        key: `github-head-observation:issue-1:2026-01-01T00:00:00.000Z:${headA}:provider_event`,
        value: JSON.stringify({
          headSha: headA,
          observedAt: "2026-01-01T00:00:00.000Z",
          provenance: "provider_event",
        }),
      },
    ]);
    let releaseOlderFetch!: (response: Response) => void;
    let releaseNewerFetch!: (response: Response) => void;
    let markOlderFetchStarted!: () => void;
    let markNewerFetchStarted!: () => void;
    const olderFetch = new Promise<Response>((resolve) => {
      releaseOlderFetch = resolve;
    });
    const newerFetch = new Promise<Response>((resolve) => {
      releaseNewerFetch = resolve;
    });
    const olderFetchStarted = new Promise<void>((resolve) => {
      markOlderFetchStarted = resolve;
    });
    const newerFetchStarted = new Promise<void>((resolve) => {
      markNewerFetchStarted = resolve;
    });
    const fetchMock = vi.fn((): Promise<Response> => {
      if (fetchMock.mock.calls.length === 1) {
        markOlderFetchStarted();
        return olderFetch;
      }
      if (fetchMock.mock.calls.length === 2) {
        markNewerFetchStarted();
        return newerFetch;
      }
      return Promise.resolve(Response.json({ head: { sha: headC } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const delayedSynchronize = handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request",
        action: "synchronize",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          merged: false,
          updated_at: "2026-01-01T00:00:05.000Z",
          head: { ref: "ot/issue-1", sha: headB },
          base: { ref: "main" },
        },
      },
      fixture.pipelines
    );
    await olderFetchStarted;

    const delayedReview = handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          updated_at: "2026-01-01T00:00:06.000Z",
          head: { ref: "ot/issue-1", sha: headC },
          base: { ref: "main" },
        },
        review: {
          id: 4907098020,
          state: "approved",
          commit_id: headC,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907098020",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );
    await newerFetchStarted;

    if (completionOrder === "newer_first") {
      releaseNewerFetch(Response.json({ head: { sha: headC } }));
      await delayedReview;
      expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
      releaseOlderFetch(Response.json({ head: { sha: headB } }));
      await delayedSynchronize;
    } else {
      releaseOlderFetch(Response.json({ head: { sha: headB } }));
      await delayedSynchronize;
      expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headB);
      releaseNewerFetch(Response.json({ head: { sha: headC } }));
      await delayedReview;
    }
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
    expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
      .toBe(completionOrder === "newer_first" ? "provider_projection" : "live_reconciliation");
    expect(fixture.tickets.listSettings("github-head-observation:issue-1:")
      .map(({ value }) => JSON.parse(value)))
      .not.toContainEqual(expect.objectContaining({
        headSha: headC,
        observedAt: "2026-01-01T00:00:06.000Z",
        provenance: "provider_event",
      }));
    if (completionOrder === "older_first") {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      return;
    }

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 4907098021,
          body: "Feedback after the concurrent review projection.",
          created_at: "2026-01-01T00:00:07.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098021",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    const providerEvent = fixture.db.prepare(`
      SELECT head_sha, payload FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098021") as { head_sha: string; payload: string };
    expect(providerEvent.head_sha).toBe("unknown:ot/issue-1");
    expect(JSON.parse(JSON.parse(providerEvent.payload).payload)).toMatchObject({
      classification: "head_ordering_ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("detects an A-to-B-to-A projection ABA while C reconciliation is pending", async () => {
    const fixture = setup("core/implement@4");
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const headC = "c".repeat(40);
    const observedAtA = "2026-01-01T00:00:00.000Z";
    const observedAtB = "2026-01-01T00:00:01.000Z";
    const initialGeneration = "projection-a-initial";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    const projectionTuple = () => [
      fixture.tickets.getSetting("github-head:issue-1"),
      fixture.tickets.getSetting("github-head-source:issue-1"),
      fixture.tickets.getSetting("github-head-observed-at:issue-1"),
      fixture.tickets.getSetting("github-head-observed-provenance:issue-1"),
    ];
    const synchronizeEvent = (headSha: string, updatedAt: string) => ({
      kind: "pull_request" as const,
      action: "synchronize",
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 1,
        html_url: "https://github.com/owner/repo/pull/1",
        merged: false,
        updated_at: updatedAt,
        head: { ref: "ot/issue-1", sha: headSha },
        base: { ref: "main" },
      },
    });
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: headA },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: observedAtA },
      { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
      { key: "github-head-projection-generation:issue-1", value: initialGeneration },
    ]);
    const initialTuple = projectionTuple();

    let releasePendingCFetch!: (response: Response) => void;
    let markPendingCFetchStarted!: () => void;
    const pendingCFetch = new Promise<Response>((resolve) => {
      releasePendingCFetch = resolve;
    });
    const pendingCFetchStarted = new Promise<void>((resolve) => {
      markPendingCFetchStarted = resolve;
    });
    const fetchMock = vi.fn((): Promise<Response> => {
      const call = fetchMock.mock.calls.length;
      if (call === 1) {
        markPendingCFetchStarted();
        return pendingCFetch;
      }
      if (call === 2) return Promise.resolve(Response.json({ head: { sha: headB } }));
      if (call === 3) return Promise.resolve(Response.json({ head: { sha: headA } }));
      return Promise.resolve(Response.json({ head: { sha: headC } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const pendingC = handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "pull_request_review",
        action: "submitted",
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 1,
          html_url: "https://github.com/owner/repo/pull/1",
          updated_at: "2026-01-01T00:00:02.000Z",
          head: { ref: "ot/issue-1", sha: headC },
          base: { ref: "main" },
        },
        review: {
          id: 4907098022,
          state: "approved",
          commit_id: headC,
          html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-4907098022",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );
    await pendingCFetchStarted;

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      synchronizeEvent(headB, observedAtB),
      fixture.pipelines
    );
    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      synchronizeEvent(headA, observedAtA),
      fixture.pipelines
    );
    expect(projectionTuple()).toEqual(initialTuple);
    expect(fixture.tickets.getSetting("github-head-projection-generation:issue-1"))
      .not.toBe(initialGeneration);

    releasePendingCFetch(Response.json({ head: { sha: headC } }));
    await pendingC;
    expect(fixture.tickets.getSetting("github-head:issue-1")).toBe(headC);
    expect(fixture.tickets.getSetting("github-head-observed-provenance:issue-1"))
      .toBe("live_reconciliation");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    { label: "the live head sorts before its competitor", currentHead: "a".repeat(40), otherHead: "f".repeat(40), id: 4907098018 },
    { label: "the live head sorts after its competitor", currentHead: "f".repeat(40), otherHead: "a".repeat(40), id: 4907098019 },
  ])("does not SHA-tie-break equal provider timestamps when $label", async ({
    currentHead,
    otherHead,
    id,
  }) => {
    const fixture = setup("core/implement@4");
    const observedAt = "2026-01-01T00:00:05.000Z";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
    fixture.tickets.setSettings([
      { key: "github-head:issue-1", value: currentHead },
      { key: "github-head-source:issue-1", value: "authoritative" },
      { key: "github-head-observed-at:issue-1", value: observedAt },
      { key: "github-head-observed-provenance:issue-1", value: "provider_event" },
      ...[currentHead, otherHead].map((headSha) => ({
        key: `github-head-observation:issue-1:${observedAt}:${headSha}:provider_event`,
        value: JSON.stringify({ headSha, observedAt, provenance: "provider_event" }),
      })),
    ]);
    const fetchMock = vi.fn(async () => Response.json({ head: { sha: currentHead } }));
    vi.stubGlobal("fetch", fetchMock);

    await handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id,
          body: "Feedback after two different heads received the same provider timestamp.",
          created_at: "2026-01-01T00:00:07.000Z",
          html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    const providerEvent = fixture.db.prepare(`
      SELECT head_sha, payload FROM provider_events WHERE provider_event_id = ?
    `).get(`github-comment:${id}`) as { head_sha: string; payload: string };
    expect(providerEvent.head_sha).toBe("unknown:ot/issue-1");
    expect(JSON.parse(JSON.parse(providerEvent.payload).payload)).toMatchObject({
      classification: "head_ordering_ambiguous",
    });
    expect(fixture.db.prepare("SELECT status FROM feedback_snapshots").get())
      .toEqual({ status: "stale" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an equal authoritative observation", observedAt: "2026-01-01T00:00:10.000Z" },
    { label: "a legacy authoritative projection without an observation time", observedAt: undefined },
  ])("settles $label as visible ambiguous stale feedback", async ({ observedAt }) => {
    const fixture = setup("core/implement@4");
    const priorHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    const equalTimestamp = "2026-01-01T00:00:10.000Z";
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: priorHead }, "publication-before-equal");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-before-equal");
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
    if (observedAt) {
      fixture.tickets.setSetting("github-head-observed-at:issue-1", observedAt);
    } else {
      fixture.db.prepare("DELETE FROM settings WHERE key = ?")
        .run("github-head-observed-at:issue-1");
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ head: { sha: currentHead } })));

    await expect(handleGithubEvent(
      { githubReadToken: "read-token" } as never,
      fixture.tickets,
      activityPublisher,
      {
        kind: "issue_comment",
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
        comment: {
          id: 4907098015,
          body: "Feedback at the same provider timestamp as the new head.",
          created_at: equalTimestamp,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098015",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    )).resolves.toBeUndefined();

    const providerEvent = fixture.db.prepare(`
      SELECT head_sha, payload FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098015") as { head_sha: string; payload: string };
    expect(providerEvent.head_sha).toBe("unknown:ot/issue-1");
    expect(JSON.parse(JSON.parse(providerEvent.payload).payload)).toMatchObject({
      classification: "head_ordering_ambiguous",
    });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: "unknown:ot/issue-1" });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .get()).toBeDefined();
  });

  it("prefers a newer immutable publication over an older provider head observation", () => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-before-observation");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: currentHead }, "publication-after-observation");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "publication-before-observation");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ? WHERE id = ?
    `).run("2026-01-01T00:00:02.000Z", "publication-after-observation");

    expect(acknowledgedPublicationHeadAt(
      fixture.pipelines,
      fixture.instance,
      "2026-01-01T00:00:03.000Z",
      { headSha: previousHead, observedAt: "2026-01-01T00:00:01.000Z" }
    )).toBe(currentHead);
  });

  it.each([
    {
      label: "before the repaired publication timestamp is acknowledged",
      commentCreatedAt: "2026-01-01T00:00:07.000Z",
      repairedCreatedAt: "2026-01-01T00:00:05.000Z",
      repairedAcknowledgedAt: "2026-01-01T00:00:10.000Z",
      repairedStatus: "acknowledged",
    },
    {
      label: "while the repaired publication receipt is still pending",
      commentCreatedAt: "2026-01-01T00:00:07.000Z",
      repairedCreatedAt: "2026-01-01T00:00:05.000Z",
      repairedAcknowledgedAt: null,
      repairedStatus: "pending",
    },
    {
      label: "in the same second as the repaired publication acknowledgement",
      commentCreatedAt: "2026-01-01T00:00:10.000Z",
      repairedCreatedAt: "2026-01-01T00:00:05.000Z",
      repairedAcknowledgedAt: "2026-01-01T00:00:10.000Z",
      repairedStatus: "acknowledged",
    },
  ])("keeps a fresh top-level PR comment on the repaired head $label", async ({
    commentCreatedAt,
    repairedCreatedAt,
    repairedAcknowledgedAt,
    repairedStatus,
  }) => {
    const fixture = setup("core/implement@4");
    const previousHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: previousHead }, "publication-previous");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: repairedHead }, "publication-repaired");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-previous");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET status = ?, created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run(repairedStatus, repairedCreatedAt, repairedAcknowledgedAt, "publication-repaired");
    moveFixtureToProviderWait(fixture, SUBJECT, repairedHead);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

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
          id: 4907098002,
          body: "Please repair the current provider feedback handling.",
          created_at: commentCreatedAt,
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098002",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098002")).toEqual({ head_sha: repairedHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "consumed", head_sha: repairedHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) FROM control_outbox WHERE id LIKE 'feedback-snapshot-stale:%'")
      .pluck().get()).toBe(0);
  });

  it("keeps a same-second old PR comment stale when the repaired publication is later within that second", async () => {
    const fixture = setup("core/implement@4");
    const commentedHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: commentedHead }, "publication-commented");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: repairedHead }, "publication-repaired");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-commented");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:10.500Z", "2026-01-01T00:00:12.000Z", "publication-repaired");
    moveFixtureToProviderWait(fixture, SUBJECT, repairedHead);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

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
          id: 4907098003,
          body: "Please repair the previous provider feedback handling.",
          created_at: "2026-01-01T00:00:10Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098003",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098003")).toEqual({ head_sha: commentedHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: commentedHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("fails closed for PR comments in the same second as repaired publication creation", async () => {
    const fixture = setup("core/implement@4");
    const commentedHead = "d".repeat(40);
    const repairedHead = PUBLISHED_COMMIT;
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: commentedHead }, "publication-commented");
    recordAcknowledgedPublication(fixture, SUBJECT, { publishedCommit: repairedHead }, "publication-repaired");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-commented");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:10.000Z", "2026-01-01T00:00:12.000Z", "publication-repaired");
    moveFixtureToProviderWait(fixture, SUBJECT, repairedHead);
    fixture.db.prepare("UPDATE pipeline_instances SET reentry_count = 1 WHERE id = ?")
      .run(fixture.instance.id);

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
          id: 4907098005,
          body: "Please repair the previous provider feedback handling.",
          created_at: "2026-01-01T00:00:10Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098005",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098005")).toEqual({ head_sha: commentedHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "stale", head_sha: commentedHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
      reentry_ordinal: 0,
    });
  });

  it("does not bind PR comments to acknowledged non-publish decision subjects", async () => {
    const fixture = setup("core/implement@4");
    const publishedHead = "d".repeat(40);
    const unpublishedSubject = "e".repeat(40);
    const activityPublisher = {
      publishActivity: vi.fn(async () => undefined),
      publishError: vi.fn(async () => undefined),
    };
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    recordAcknowledgedPublication(fixture, "b".repeat(40), { publishedCommit: publishedHead }, "publication-published");
    recordAcknowledgedPublication(fixture, unpublishedSubject, {}, "publication-nonpublish");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "publication-published");
    fixture.db.prepare(`
      UPDATE pipeline_publication_receipts SET created_at = ?, acknowledged_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:05.000Z", "2026-01-01T00:00:05.000Z", "publication-nonpublish");
    moveFixtureToProviderWait(fixture, "b".repeat(40), publishedHead);

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
          id: 4907098004,
          body: "Please repair the published provider feedback handling.",
          created_at: "2026-01-01T00:00:06.000Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-4907098004",
          user: { login: "reviewer" },
        },
      },
      fixture.pipelines
    );

    expect(fixture.db.prepare(`
      SELECT head_sha FROM provider_events WHERE provider_event_id = ?
    `).get("github-comment:4907098004")).toEqual({ head_sha: publishedHead });
    expect(fixture.db.prepare("SELECT status, head_sha FROM feedback_snapshots").get())
      .toEqual({ status: "consumed", head_sha: publishedHead });
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
  });

  it("keeps post-repair-start old-head feedback stale after the repaired head publishes", async () => {
    const fixture = setup("core/implement@4");
    const oldSubject = "1".repeat(40);
    const oldHead = "a".repeat(40);
    const repairedSubject = "2".repeat(40);
    const repairedHead = "b".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    await settleRepairRoundPublishes(fixture, 1);

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:causal-old-head",
      outcome: "semantic_repair_required",
      summary: "Old-head feedback that starts the repair.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-causal"],
      payload: { kind: "pull_request_review", id: "causal-old-head" },
      headSha: oldHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    const repairStartedAt = fixture.pipelines.listAttempts(fixture.instance.id)
      .filter((attempt) => attempt.reentry_ordinal === 1)
      .map((attempt) => attempt.created_at)
      .sort()
      .at(0);
    expect(repairStartedAt).toBeDefined();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });
    const laterOldHeadFeedbackAt = new Date(Date.parse(repairStartedAt!) + 1000).toISOString();
    const stalePayload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "Later old-head feedback after repair already started.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-later-old"],
      payload: canonicalJson({ kind: "pull_request_review", id: "later-old-head" }),
    });
    const laterOldHeadSnapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:later-old-head",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: oldHead,
      kind: "pipeline_provider_event",
      payload: stalePayload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${oldHead}`,
      receivedAt: laterOldHeadFeedbackAt,
    }).snapshot;

    const publishing = settleForwardChainToPublish(fixture, repairedSubject, oldSubject, 2);
    expect(publishing.active_stage_id).toBe("publish");
    settleCurrentStage(fixture, "success", {
      id: "publish-repaired-head",
      subject: repairedSubject,
      preSubject: repairedSubject,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: repairedHead,
        provider_revision: repairedHead,
      },
    });
    fixture.tickets.setSetting("github-head:issue-1", repairedHead);

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-synchronize:owner/repo:1:${repairedHead}`,
      outcome: "needs_human",
      summary: "GitHub reported the repaired head synchronize.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "synchronize" },
      headSha: repairedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(0);
    expect(fixture.db.prepare("SELECT status, head_sha, observed_head_sha FROM feedback_snapshots WHERE id = ?")
      .get(laterOldHeadSnapshot.id)).toEqual({
      status: "stale",
      head_sha: oldHead,
      observed_head_sha: oldHead,
    });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${laterOldHeadSnapshot.id}`)).toBeDefined();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
    });
    const repairsBeforeRepeat = fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).pluck().get(fixture.instance.id) as number;

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:repeat-on-repaired-head",
      outcome: "semantic_repair_required",
      summary: "Explicit repeat against the repaired head.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-repeat"],
      payload: { kind: "pull_request_review", id: "repeat-on-repaired-head" },
      headSha: repairedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    const repairsAfterRepeat = fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).pluck().get(fixture.instance.id) as number;
    expect(repairsAfterRepeat).toBe(repairsBeforeRepeat + 1);
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
    });
  });

  it("keeps old-head feedback stale across nested command repair reentries", async () => {
    const fixture = setup("core/implement@4");
    const oldSubject = "1".repeat(40);
    const oldHead = "a".repeat(40);
    const firstRepairSubject = "2".repeat(40);
    const repairedSubject = "3".repeat(40);
    const repairedHead = "b".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    await settleRepairRoundPublishes(fixture, 1);

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: "github-review:f1-provider-repair",
      outcome: "semantic_repair_required",
      summary: "F1 starts the provider repair from old head A.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-f1"],
      payload: { kind: "pull_request_review", id: "f1-provider-repair" },
      headSha: oldHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    const providerRepairStartedAt = fixture.pipelines.listAttempts(fixture.instance.id)
      .filter((attempt) => attempt.stage_id === "repair_implementation" && attempt.reentry_ordinal === 1)
      .map((attempt) => attempt.created_at)
      .sort()
      .at(0);
    expect(providerRepairStartedAt).toBeDefined();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 1,
    });

    const f2ReceivedAt = new Date(Date.parse(providerRepairStartedAt!) + 1000).toISOString();
    const f2Payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "F2 is old-head feedback delivered after the provider repair started.",
      evidence: ["https://github.com/owner/repo/pull/1#pullrequestreview-f2"],
      payload: canonicalJson({ kind: "pull_request_review", id: "f2-old-head" }),
    });
    const f2Snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:f2-old-head",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: oldHead,
      kind: "pipeline_provider_event",
      payload: f2Payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${oldHead}`,
      receivedAt: f2ReceivedAt,
    }).snapshot;

    let instance = settleCurrentStage(fixture, "success", {
      id: "repair-implementation-f1",
      subject: firstRepairSubject,
      preSubject: oldSubject,
    });
    instance = settleCurrentStage(fixture, "success", {
      id: "repair-semantic-review-f1",
      subject: firstRepairSubject,
      preSubject: firstRepairSubject,
    });
    expect(instance.active_stage_id).toBe("test");
    instance = settleCurrentStage(fixture, "failure", {
      id: "test-failure-f1",
      subject: firstRepairSubject,
      preSubject: firstRepairSubject,
      details: { not_configured: false, timed_out: false, exit_code: 1, signal: null },
    });
    expect(instance.active_stage_id).toBe("repair_implementation");
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "repair_implementation",
      reentry_ordinal: 2,
    });

    const publishing = settleForwardChainToPublish(fixture, repairedSubject, firstRepairSubject, 3);
    expect(publishing.active_stage_id).toBe("publish");
    settleCurrentStage(fixture, "success", {
      id: "publish-repaired-head-after-command-repair",
      subject: repairedSubject,
      preSubject: repairedSubject,
      details: {
        proposal_schema: "openthrottle.stage-proposal/v1",
        published_commit: repairedHead,
        provider_revision: repairedHead,
      },
    });
    fixture.tickets.setSetting("github-head:issue-1", repairedHead);

    await routePipelineProviderEvent({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      ticket: fixture.tickets.getByIssueId("issue-1")!,
      eventId: `github-pull-synchronize:owner/repo:1:${repairedHead}`,
      outcome: "needs_human",
      summary: "GitHub reported the repaired head synchronize.",
      evidence: ["https://github.com/owner/repo/pull/1"],
      payload: { kind: "pull_request", action: "synchronize" },
      headSha: repairedHead,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
    });
    const repairsBeforeDrain = fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).pluck().get(fixture.instance.id) as number;

    expect(await drainPipelineFeedbackSnapshots(fixture.pipelines, fixture.tickets)).toBe(0);

    expect(fixture.db.prepare("SELECT status, head_sha, observed_head_sha FROM feedback_snapshots WHERE id = ?")
      .get(f2Snapshot.id)).toEqual({
      status: "stale",
      head_sha: oldHead,
      observed_head_sha: oldHead,
    });
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${f2Snapshot.id}`)).toBeDefined();
    expect(fixture.pipelines.getActiveAttempt(fixture.instance.id)).toMatchObject({
      stage_id: "provider",
    });
    expect(fixture.db.prepare(`
      SELECT COUNT(*) FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND stage_id = 'repair_implementation'
    `).pluck().get(fixture.instance.id)).toBe(repairsBeforeDrain);
  });

  it("replays an already-stale feedback snapshot without regenerating its notice", async () => {
    const fixture = setup("core/implement@4");
    const oldHead = "d".repeat(40);
    const currentHead = PUBLISHED_COMMIT;
    const laterHead = "f".repeat(40);
    fixture.tickets.setPrUrl("issue-1", "https://github.com/owner/repo/pull/1");
    fixture.tickets.setSetting("github-head:issue-1", currentHead);
    moveFixtureToProviderWait(fixture, SUBJECT, currentHead);
    const payload = canonicalJson({
      outcome: "semantic_repair_required",
      summary: "stale feedback",
      evidence: ["stale feedback"],
      payload: "{}",
    });
    const snapshot = fixture.tickets.recordProviderFeedback({
      provider: "github",
      providerEventId: "github-review:stale-replay",
      issueId: fixture.instance.ticket_id,
      sessionId: fixture.instance.session_id,
      generation: fixture.instance.generation,
      repository: fixture.instance.repository,
      pullNumber: 1,
      headSha: oldHead,
      kind: "pipeline_provider_event",
      payload,
      workItemId: `pipeline-feedback:${fixture.instance.id}:${oldHead}`,
    }).snapshot;

    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot,
    })).toBe(false);
    const originalNotice = fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${snapshot.id}`) as { payload: string };
    expect(originalNotice.payload).toContain(`current_published_head=${currentHead}`);

    fixture.db.prepare("UPDATE pipeline_instances SET published_commit = ? WHERE id = ?")
      .run(laterHead, fixture.instance.id);
    fixture.tickets.setSetting("github-head:issue-1", laterHead);
    expect(await processPipelineFeedbackSnapshot({
      pipelines: fixture.pipelines,
      store: fixture.tickets,
      instance: fixture.pipelines.getInstance(fixture.instance.id)!,
      snapshot: fixture.db.prepare("SELECT * FROM feedback_snapshots WHERE id = ?").get(snapshot.id) as FeedbackSnapshot,
    })).toBe(false);
    expect(fixture.db.prepare("SELECT payload FROM control_outbox WHERE id = ?")
      .get(`feedback-snapshot-stale:${snapshot.id}`)).toEqual(originalNotice);
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
    fixture.db.prepare(`
      UPDATE pipeline_stage_attempts
      SET reentry_ordinal = 1, created_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:00.000Z", fixture.attempt.id);
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
        body: expect.stringContaining("classification=superseded_head"),
      },
    });
    expect(JSON.parse(staleNotice.payload).activity.body).toContain("github:github-review:stale");
    expect(JSON.parse(staleNotice.payload).activity.body).toContain(`reviewed_head=${staleHead}`);
    expect(JSON.parse(staleNotice.payload).activity.body).toContain(`current_published_head=${SUBJECT}`);
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
