import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTicketStore, openDb } from "./db.js";
import { evaluateStageGate, processStageEvidence } from "./gate-evaluators.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  type PipelineManifest,
  type PipelineStage,
  type StageOutcome,
} from "./pipeline-manifest.js";
import type { PipelineCoordinatorEvent, PipelineEventArtifact } from "./pipeline-coordinator.js";
import { createPipelineStore, type PipelineInstance, type PipelineStageAttempt, type PipelineStore } from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("gate-test/v1");
const SUBJECT = "c".repeat(40);

interface Fixture {
  db: Database.Database;
  pipelines: PipelineStore;
  manifest: PipelineManifest;
  stage: PipelineStage;
  instance: PipelineInstance;
  attempt: PipelineStageAttempt;
}

describe("deterministic supervisor stage gates", () => {
  let database: Database.Database | undefined;
  afterEach(() => database?.close());

  function setup(manifestKey = "ce/investigate@1"): Fixture {
    database = openDb(":memory:");
    const tickets = createTicketStore(database);
    const pipelines = createPipelineStore(database);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { investigate: ce/investigate@1 }\ntest: npm test\n");
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
      },
    });
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    const request = pipelines.getStageRequest(attempt.id);
    expect(tickets.beginRun({
      issueId: "issue-1",
      runId: request.runId,
      taskType: manifestKey === "fixture/command@1" ? "implement" : "investigate",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    pipelines.bindStageRun(attempt.id, request.runId);
    const boundAttempt = pipelines.getAttempt(attempt.id)!;
    return {
      db: database,
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
    expect(completed.status).toBe("completion_pending_publication");
    expect(fixture.db.prepare(
      "SELECT evaluator_kind, result, payload, receipt_hash FROM pipeline_gate_receipts"
    ).get()).toMatchObject({ evaluator_kind: "semantic", result: "passed" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM pipeline_artifacts").get()).toEqual({ count: 1 });
  });
});
