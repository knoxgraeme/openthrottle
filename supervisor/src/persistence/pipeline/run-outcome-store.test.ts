import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import type { PipelineInstance, PipelineStageAttempt } from "../../pipeline/store.js";
import { openDb } from "../database.js";
import { createRunOutcomeStore } from "./run-outcome-store.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const TS = "2026-08-08T00:00:00.000Z";

function seedInstance(database: Database.Database, id = "instance-1", agent: string | null = "claude"): PipelineInstance {
  const issueId = `issue-${id}`;
  const sessionId = `session-${id}`;
  database.prepare(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent, repo,
      state, created_at, updated_at
    ) VALUES (?, ?, ?, 'ot/branch', 'claude', 'owner/repo', 'active', ?, ?)
  `).run(issueId, issueId.toUpperCase(), sessionId, TS, TS);
  database.prepare(`
    INSERT INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    ) VALUES (?, ?, 1, 'current', ?, ?)
  `).run(sessionId, issueId, TS, TS);
  database.prepare(`
    INSERT INTO repository_config_snapshots (
      id, repository, base_commit, blob_sha, digest, normalized_config, created_at
    ) VALUES (?, 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', ?)
  `).run(`config-${id}`, TS);
  database.prepare(`
    INSERT INTO runtime_capability_descriptors (
      runtime_release, digest, protocol, normalized_descriptor, accepted_at
    ) VALUES (?, '${"d".repeat(64)}', 'stage-executor@1', '{}', ?)
  `).run(`runtime-${id}`, TS);
  database.prepare(`
    INSERT INTO pipeline_catalog_entries (
      pipeline_id, version, digest, normalized_manifest, accepted_at
    ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', ?)
  `).run(TS);
  database.prepare(`
    INSERT INTO pipeline_instances (
      id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
      manifest_digest, normalized_manifest, repository, base_commit, branch, agent,
      repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
      executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
      attempt_count, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 1, 'structured', 1, '${"e".repeat(64)}',
      '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/branch', ?, ?, '${"c".repeat(64)}',
      ?, '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
      'units', 1, 1, ?, ?
    )
  `).run(id, issueId, sessionId, agent, `config-${id}`, `runtime-${id}`, TS, TS);
  database.prepare(`
    INSERT INTO pipeline_instance_stages (
      pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
    ) VALUES (?, 'units', 1, 'running', 1, ?, ?)
  `).run(id, TS, TS);
  return database.prepare("SELECT * FROM pipeline_instances WHERE id = ?").get(id) as PipelineInstance;
}

function seedAttempt(
  database: Database.Database,
  instanceId: string,
  params: {
    id: string;
    stageId: string;
    reentryOrdinal?: number;
    runId?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }
): PipelineStageAttempt {
  const plannedRunId = params.runId ?? `planned-${params.id}`;
  database.prepare(`
    INSERT INTO pipeline_stage_attempts (
      id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
      request_hash, idempotency_key, context_revision, native_context_policy,
      planned_run_id, run_id, status, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 0, 'none', ?, ?, 'completed', ?, ?, ?, ?)
  `).run(
    params.id, instanceId, params.stageId, params.reentryOrdinal ?? 0,
    digestNormalized(`request-hash-${params.id}`), `key-${params.id}`, plannedRunId, params.runId ?? null,
    params.startedAt ?? null, params.completedAt ?? null, TS, TS
  );
  return database.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?").get(params.id) as PipelineStageAttempt;
}

function seedRun(database: Database.Database, id: string, instance: PipelineInstance, overrides: {
  faultAttribution?: string | null;
  costUsd?: number | null;
} = {}): void {
  database.prepare(`
    INSERT INTO runs (
      id, linear_issue_id, linear_session_id, session_generation, task_type,
      token_hash, status, started_at, expires_at, completed_at, cost_usd, fault_attribution
    ) VALUES (?, ?, ?, 1, 'implement', ?, 'completed', ?, ?, ?, ?, ?)
  `).run(
    id, instance.linear_issue_id, instance.linear_session_id, digestNormalized(`token-${id}`),
    TS, "2099-01-01T00:00:00.000Z", TS, overrides.costUsd ?? null, overrides.faultAttribution ?? null
  );
}

function seedGraph(
  database: Database.Database,
  params: { id: string; instanceId: string; parentAttemptId: string; parentRunId: string; planDigest?: string }
): void {
  database.prepare(`
    INSERT INTO execution_graphs (
      id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
      graph_digest, plan_digest, created_at, updated_at
    ) VALUES (?, ?, ?, 'units', ?, 'graph-digest', ?, ?, ?)
  `).run(params.id, params.instanceId, params.parentAttemptId, params.parentRunId, params.planDigest ?? "plan-digest-xyz", TS, TS);
}

function seedUnit(
  database: Database.Database,
  params: { id: string; graphId: string; instanceId: string; parentAttemptId: string; unitId: string; repairRounds?: number }
): void {
  database.prepare(`
    INSERT INTO execution_units (
      id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
      authored_order, dependency_unit_ids, status, repair_rounds, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, '[]', 'completed', ?, ?, ?)
  `).run(params.id, params.graphId, params.instanceId, params.parentAttemptId, params.unitId, params.repairRounds ?? 0, TS, TS);
}

function seedWorkAttempt(
  database: Database.Database,
  params: {
    id: string;
    graphId: string;
    instanceId: string;
    parentAttemptId: string;
    parentRunId: string;
    unitTableId?: string | null;
    unitId?: string | null;
    actionKind?: string;
    receipt?: string | null;
  }
): void {
  database.prepare(`
    INSERT INTO execution_work_attempts (
      id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
      parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
      status, payload, receipt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'completed', '{}', ?, ?, ?)
  `).run(
    params.id, params.graphId, params.unitTableId ?? null, params.instanceId, params.parentAttemptId,
    params.parentRunId, params.unitId ?? null, params.actionKind ?? (params.unitId ? "lead" : "aggregate"),
    `work-key-${params.id}`, params.receipt ?? null, TS, TS
  );
}

function receipt(overrides: {
  type: string;
  result: string;
  skill: string;
  skillPackageDigest: string | null;
  unitId: string;
  attemptTableId: string;
  payload: Record<string, unknown>;
}): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: overrides.type,
    assurance: "semantic_attested",
    result: overrides.result,
    producer: {
      worker_id: "worker-1",
      skill: overrides.skill,
      capability_digest: "d".repeat(64),
      skill_package_digest: overrides.skillPackageDigest,
    },
    subject: { base: "a".repeat(40), pre: "a".repeat(40), post: "a".repeat(40) },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: overrides.unitId,
      attempt_id: "attempt-parent",
      parent_run_id: "run-parent",
      action_attempt_id: overrides.attemptTableId,
      generation: 1,
      native_session_id: null,
      request_hash: "b".repeat(64),
    },
    evidence: ["evidence"],
    payload: overrides.payload,
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function unitCompletionReceipt(skill: string, skillPackageDigest: string | null, unitId: string, attemptTableId: string): string {
  return receipt({
    type: "unit_completion",
    result: "success",
    skill,
    skillPackageDigest,
    unitId,
    attemptTableId,
    payload: {
      summary: "Implemented.",
      assumptions: [],
      decisions: [],
      issues: [],
      verification: [],
      downstream_context: [],
      requested_human_input: [],
    },
  });
}

function unitDecisionReceipt(skill: string, skillPackageDigest: string | null, unitId: string, attemptTableId: string): string {
  return receipt({
    type: "unit_decision",
    result: "accept",
    skill,
    skillPackageDigest,
    unitId,
    attemptTableId,
    payload: { rationale: "Looks right.", context_updates: [], accepted_subject: "a".repeat(40) },
  });
}

function semanticReviewReceipt(skill: string, skillPackageDigest: string | null, unitId: string, attemptTableId: string): string {
  return receipt({
    type: "semantic_review",
    result: "success",
    skill,
    skillPackageDigest,
    unitId,
    attemptTableId,
    payload: { summary: "Clean.", findings: [] },
  });
}

describe("run outcome store", () => {
  it("aggregates the latest graph's repair rounds, accumulated phase durations, and deduped skill digests", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db);
    db.prepare(`
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES (?, 'review', 2, 'pending', 0, ?, ?)
    `).run(instance.id, TS, TS);

    seedRun(db, "run-1", instance, { faultAttribution: "provider", costUsd: null });

    // Two attempts on the same stage (a repair reentry) must accumulate,
    // not overwrite, that stage's duration; a third attempt on a different
    // stage stays a separate bucket.
    const entryAttempt = seedAttempt(db, instance.id, {
      id: "attempt-1", stageId: "units", reentryOrdinal: 0, runId: "run-1",
      startedAt: "2026-08-08T00:00:00.000Z", completedAt: "2026-08-08T00:00:01.000Z",
    });
    seedAttempt(db, instance.id, {
      id: "attempt-2", stageId: "units", reentryOrdinal: 1,
      startedAt: "2026-08-08T00:05:00.000Z", completedAt: "2026-08-08T00:05:02.000Z",
    });
    seedAttempt(db, instance.id, {
      id: "attempt-3", stageId: "review", reentryOrdinal: 0,
      startedAt: "2026-08-08T00:10:00.000Z", completedAt: "2026-08-08T00:10:00.500Z",
    });

    seedGraph(db, { id: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1" });
    seedUnit(db, { id: "unit-a", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", unitId: "a", repairRounds: 2 });
    seedUnit(db, { id: "unit-b", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", unitId: "b" });

    // Two receipts from the same producer (skill + digest) must dedupe to
    // one skill_digests entry; a third, distinct producer stays separate.
    seedWorkAttempt(db, {
      id: "work-1a", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1",
      unitTableId: "unit-a", unitId: "a", actionKind: "implement",
      receipt: unitCompletionReceipt("builtin://ce/implement@1", null, "a", "work-1a"),
    });
    seedWorkAttempt(db, {
      id: "work-1b", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1",
      unitTableId: "unit-a", unitId: "a", actionKind: "lead",
      receipt: unitDecisionReceipt("builtin://ce/implement@1", null, "a", "work-1b"),
    });
    seedWorkAttempt(db, {
      id: "work-2", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1",
      unitTableId: "unit-b", unitId: "b", actionKind: "lead",
      receipt: semanticReviewReceipt("builtin://final-review@1", "e".repeat(64), "b", "work-2"),
    });

    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, entryAttempt, { terminalOutcome: "shipped", outcome: "success" }, TS);

    const outcome = runOutcomes.getRunOutcome(instance.id)!;
    expect(outcome).toMatchObject({
      execution_graph_id: "graph-1",
      plan_digest: "plan-digest-xyz",
      outcome: "shipped",
      closed_reason: "success",
      fault_attribution: "provider",
      token_cost_usd: null,
    });
    expect(JSON.parse(outcome.repair_rounds_by_unit)).toEqual({ a: 2, b: 0 });
    expect(JSON.parse(outcome.phase_durations_ms)).toEqual({ units: 3_000, review: 500 });
    expect(JSON.parse(outcome.skill_digests)).toEqual(
      expect.arrayContaining([
        { skill: "builtin://ce/implement@1", skill_package_digest: null },
        { skill: "builtin://final-review@1", skill_package_digest: "e".repeat(64) },
      ])
    );
    expect(JSON.parse(outcome.skill_digests)).toHaveLength(2);
  });

  it("sums a real token cost when a bound run reports one", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db);
    seedRun(db, "run-1", instance, { costUsd: 3.5 });
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });

    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "shipped", outcome: "success" }, TS);

    expect(runOutcomes.getRunOutcome(instance.id)?.token_cost_usd).toBe(3.5);
  });

  it("skips and warns on an unparseable receipt instead of aborting settlement", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db);
    seedRun(db, "run-1", instance);
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });
    seedGraph(db, { id: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1" });
    seedWorkAttempt(db, {
      id: "work-bad", graphId: "graph-1", instanceId: instance.id, parentAttemptId: "attempt-1", parentRunId: "run-1",
      // Valid JSON (satisfies the execution_work_attempts.receipt CHECK) but
      // not a valid openthrottle.receipt/v1 -- exercises parseStandardReceipt's
      // failure path, not the DB's own JSON-syntax guard.
      receipt: canonicalJson({ schema: "not-a-real-schema/v1" }),
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "shipped", outcome: "success" }, TS);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("skipped an unparseable receipt");
    warn.mockRestore();
    const outcome = runOutcomes.getRunOutcome(instance.id)!;
    expect(JSON.parse(outcome.skill_digests)).toEqual([]);
  });

  it("skips and warns instead of inserting a row for an unrecognized vocabulary value", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db);
    seedRun(db, "run-1", instance);
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(
      instance,
      attempt,
      // A cast simulates a future producer bypassing the TS closed enum --
      // the same drift insertGateReceipt's GATE_RECEIPT_REASONS check guards.
      { terminalOutcome: "shipped", outcome: "not_a_real_outcome" as never },
      TS
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("unrecognized closed_reason");
    warn.mockRestore();
    expect(runOutcomes.getRunOutcome(instance.id)).toBeUndefined();
  });

  it("skips and warns instead of inserting a row for an unrecognized engine value", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db, "instance-1", "gpt5" as never);
    seedRun(db, "run-1", instance);
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "shipped", outcome: "success" }, TS);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("unrecognized engine");
    warn.mockRestore();
    expect(runOutcomes.getRunOutcome(instance.id)).toBeUndefined();
  });

  it("skips and warns instead of inserting a row when the instance's agent is NULL", () => {
    db = openDb(":memory:");
    // Simulates a legacy pipeline_instances row left with a NULL agent by
    // migrations/definitions.ts's backfillPipelineExecutionIdentity, whose
    // correlated subquery yields NULL for an issue with no matching ticket.
    const instance = seedInstance(db, "instance-1", null);
    seedRun(db, "run-1", instance);
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "shipped", outcome: "success" }, TS);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("missing engine");
    warn.mockRestore();
    expect(runOutcomes.getRunOutcome(instance.id)).toBeUndefined();
  });

  it("is idempotent: a replayed call for an already-recorded instance is a no-op", () => {
    db = openDb(":memory:");
    const instance = seedInstance(db);
    seedRun(db, "run-1", instance);
    const attempt = seedAttempt(db, instance.id, { id: "attempt-1", stageId: "units", runId: "run-1" });

    const runOutcomes = createRunOutcomeStore(db);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "shipped", outcome: "success" }, TS);
    runOutcomes.recordSettlement(instance, attempt, { terminalOutcome: "failed", outcome: "failure" }, "2026-08-08T01:00:00.000Z");

    const outcome = runOutcomes.getRunOutcome(instance.id)!;
    expect(outcome.outcome).toBe("shipped");
    expect(outcome.created_at).toBe(TS);
  });
});
