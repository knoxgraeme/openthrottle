import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized, type StageOutcome } from "../../pipeline/manifest.js";
import type { PipelineUnitPhaseBinding } from "../../pipeline/manifest.js";
import type { ExecutionGateDecision } from "../../pipeline/execution-gates.js";
import { openDb } from "../database.js";
import { createExecutionUnitStore, type ExecutionUnitStore } from "./unit-store.js";

let db: Database.Database | undefined;
let timestamp = "2026-07-29T00:00:00.000Z";

function gateDecision(overrides: {
  gateKind: ExecutionGateDecision["gateKind"];
  outcome?: StageOutcome;
  result?: ExecutionGateDecision["result"];
  reason?: string;
  subject: string;
}): ExecutionGateDecision {
  const base = {
    gateKind: overrides.gateKind,
    outcome: overrides.outcome ?? "success",
    result: overrides.result ?? "passed",
    reason: overrides.reason ?? "test_reason",
    subject: overrides.subject,
    artifactHashes: ["a".repeat(64)],
  };
  const payload = canonicalJson({ schema: "test.gate-decision/v1", ...base });
  return { ...base, payload, hash: digestNormalized(payload) };
}

function receiptJson(type: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, payload: {}, ...overrides });
}

function unitPhaseBindings(model = "gpt-5"): PipelineUnitPhaseBinding[] {
  const worker = {
    id: "worker",
    engine: "agent" as const,
    model,
    allowed_mcp_servers: [],
    session_scope: "fresh" as const,
    credentials: ["model.invoke", "repo.read", "repo.write"],
  };
  return [
    {
      id: "implement",
      kind: "agent",
      loop: {
        id: "loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_completion",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: ["model.invoke", "repo.read", "repo.write"],
    },
    { id: "candidate", kind: "evidence" },
    {
      id: "lead",
      kind: "gate",
      loop: {
        id: "lead-loop",
        skill: "builtin://ce/implement@1",
        input_scope: "unit",
        receipt: "unit_decision",
        max_parallel: 1,
        max_rounds: 1,
        timeout_seconds: 60,
      },
      worker,
      executor: { kind: "agent", capability: "ce/implement@1" },
      context: "fresh",
      credentials: ["model.invoke", "repo.read", "repo.write"],
    },
    { id: "integrate", kind: "integrate" },
  ];
}

function commandFirstUnitPhaseBindings(commands: string[]): PipelineUnitPhaseBinding[] {
  return [
    { id: "command", kind: "command", commands },
    ...unitPhaseBindings(),
  ];
}

function commandFirstWithSimplifyUnitPhaseBindings(commands: string[]): PipelineUnitPhaseBinding[] {
  const [command, implement, candidate, lead, integrate] = commandFirstUnitPhaseBindings(commands);
  if (!implement || implement.kind !== "agent") throw new Error("expected implement agent binding");
  const simplify: PipelineUnitPhaseBinding = {
    id: "simplify",
    kind: "agent",
    loop: {
      id: "simplify-loop",
      skill: "builtin://ce/simplify@1",
      input_scope: "unit",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
    },
    worker: implement.worker,
    executor: { kind: "agent", capability: "ce/simplify@1" },
    context: "fresh",
    credentials: implement.credentials,
  };
  return [command!, implement, simplify, candidate!, lead!, integrate!];
}

function commandBeforeSimplifyUnitPhaseBindings(commands: string[]): PipelineUnitPhaseBinding[] {
  const [implement, candidate, lead, integrate] = unitPhaseBindings();
  if (!implement || implement.kind !== "agent") throw new Error("expected implement agent binding");
  const simplify: PipelineUnitPhaseBinding = {
    id: "simplify",
    kind: "agent",
    loop: {
      id: "simplify-loop",
      skill: "builtin://ce/simplify@1",
      input_scope: "unit",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
    },
    worker: implement.worker,
    executor: { kind: "agent", capability: "ce/simplify@1" },
    context: "fresh",
    credentials: implement.credentials,
  };
  return [
    implement,
    { id: "command", kind: "command", commands },
    simplify,
    candidate!,
    lead!,
    integrate!,
  ];
}

function builtinUnitPhaseBindings(commands: string[]): PipelineUnitPhaseBinding[] {
  const [implement, candidate, lead, integrate] = unitPhaseBindings();
  if (implement?.kind !== "agent") throw new Error("expected implement agent binding");
  const simplify: PipelineUnitPhaseBinding = {
    id: "simplify",
    kind: "agent",
    loop: {
      id: "simplify-loop",
      skill: "builtin://ce/simplify@1",
      input_scope: "unit",
      receipt: "unit_completion",
      max_parallel: 1,
      max_rounds: 1,
      timeout_seconds: 60,
    },
    worker: implement.worker,
    executor: { kind: "agent", capability: "ce/simplify@1" },
    context: "fresh",
    credentials: implement.credentials,
  };
  return [
    implement,
    simplify,
    { id: "command", kind: "command", commands },
    candidate!,
    lead!,
    integrate!,
  ];
}

function lease(store: ExecutionUnitStore, leaseOwner = "worker-1", leaseUntilIso = "2026-07-29T00:01:00.000Z") {
  return store.leaseNextUnitAction({
    parentAttemptId: "attempt-parent",
    leaseOwner,
    nowIso: timestamp,
    leaseUntilIso,
  })!;
}

// Drives the current unit through implement, simplify, every configured
// command, candidate, lead, and integrate so it reaches 'completed'.
function completeUnitToTerminal(store: ExecutionUnitStore, subject: string, commandNames: readonly string[] = []): void {
  const implement = lease(store);
  store.completeUnitAction({ actionId: implement.id, resultHash: "r-implement", outputSubject: subject, receipt: receiptJson("unit_completion") });
  const simplify = lease(store);
  store.completeUnitAction({ actionId: simplify.id, resultHash: "r-simplify", outputSubject: subject });
  for (const commandName of commandNames) {
    const command = lease(store);
    store.completeUnitAction({
      actionId: command.id, resultHash: `r-command-${commandName}`, outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: commandName } }),
    });
  }
  const candidate = lease(store);
  store.completeUnitAction({ actionId: candidate.id, resultHash: "r-candidate", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
  const leadAction = lease(store);
  store.completeGatedAction({
    actionId: leadAction.id, resultHash: "r-lead", outputSubject: subject, receipt: receiptJson("unit_decision"),
    decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
  });
  const integrate = lease(store);
  store.completeGatedAction({
    actionId: integrate.id, resultHash: "r-integrate", outputSubject: subject,
    decision: gateDecision({ gateKind: "integration", outcome: "success", subject }),
  });
}

function setup(): ReturnType<typeof createExecutionUnitStore> {
  db = openDb(":memory:");
  db.exec(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
      repo, base_branch, created_at, updated_at
    ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${timestamp}', '${timestamp}');
    INSERT INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    ) VALUES ('session-1', 'issue-1', 1, 'current', '${timestamp}', '${timestamp}');
    INSERT INTO runs (
      id, linear_issue_id, linear_session_id, session_generation, task_type,
      token_hash, status, started_at, expires_at
    ) VALUES (
      'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
      'running', '${timestamp}', '2026-07-29T01:00:00.000Z'
    );
    INSERT INTO repository_config_snapshots (
      id, repository, base_commit, blob_sha, digest, normalized_config, created_at
    ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${timestamp}');
    INSERT INTO runtime_capability_descriptors (
      runtime_release, digest, protocol, normalized_descriptor, accepted_at
    ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${timestamp}');
    INSERT INTO pipeline_catalog_entries (
      pipeline_id, version, digest, normalized_manifest, accepted_at
    ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${timestamp}');
    INSERT INTO pipeline_instances (
      id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
      manifest_digest, normalized_manifest, repository, base_commit, branch,
      repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
      executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
      attempt_count, created_at, updated_at
    ) VALUES (
      'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
      '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
      'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
      'units', 1, 1, '${timestamp}', '${timestamp}'
    );
    INSERT INTO pipeline_instance_stages (
      pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
    ) VALUES ('instance-1', 'units', 1, 'running', 1, '${timestamp}', '${timestamp}');
    INSERT INTO pipeline_stage_attempts (
      id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
      request_hash, idempotency_key, context_revision, native_context_policy,
      planned_run_id, run_id, status, created_at, updated_at
    ) VALUES (
      'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
      'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${timestamp}', '${timestamp}'
    );
  `);
  return createExecutionUnitStore(db, () => timestamp);
}

afterEach(() => {
  db?.close();
  db = undefined;
  timestamp = "2026-07-29T00:00:00.000Z";
});

describe("execution unit store", () => {
  it("creates child state idempotently for a parent attempt", () => {
    const store = setup();
    const input = {
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      unitPhases: ["implement", "candidate", "lead", "integrate"] as const,
      unitPhaseBindings: unitPhaseBindings(),
    };

    expect(store.createGraph(input)).toMatchObject({
      parent_attempt_id: "attempt-parent",
      unit_phase_bindings: canonicalJson(unitPhaseBindings()),
    });
    expect(store.createGraph(input)).toMatchObject({ parent_attempt_id: "attempt-parent" });
    expect(store.listUnits("attempt-parent").map((unit) => [unit.unitId, unit.dependencies])).toEqual([
      ["a", []],
      ["b", ["a"]],
    ]);
    expect(() => store.createGraph({
      ...input,
      graphDigest: "changed-graph-digest",
    })).toThrow(/replay fence mismatch/);
    expect(() => store.createGraph({
      ...input,
      unitPhases: ["command", "implement", "candidate", "lead", "integrate"],
    })).toThrow(/unitPhaseBindings must match unitPhases/);
    expect(() => store.createGraph({
      ...input,
      unitPhaseBindings: unitPhaseBindings("gpt-5-mini"),
    })).toThrow(/replay fence mismatch/);
    expect(store.createGraph({
      ...input,
      unitPhases: ["implement", "candidate", "lead", "integrate"],
      unitPhaseBindings: unitPhaseBindings(),
    })).toMatchObject({ parent_attempt_id: "attempt-parent" });
    expect(() => store.createGraph({
      ...input,
      units: [{ id: "a" }, { id: "c", dependencies: ["a"] }],
    })).toThrow(/replay unit set mismatch/);
  });

  it("rejects current-schema unbound phase replay even when durable projections match", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const migration = db!.prepare("SELECT applied_at FROM schema_migrations WHERE version = 21").get() as { applied_at: string };
    const currentSchemaCreatedAt = new Date(Date.parse(migration.applied_at) + 1000).toISOString();
    db!.prepare(`
      UPDATE execution_graphs
      SET unit_phases = ?, command_names = ?, unit_phase_bindings = ?, created_at = ?
      WHERE parent_attempt_id = ?
    `).run(
      canonicalJson(["implement", "candidate", "lead", "integrate"]),
      canonicalJson([]),
      canonicalJson([]),
      currentSchemaCreatedAt,
      "attempt-parent"
    );

    expect(() => store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: unitPhaseBindings(),
    })).toThrow(/replay fence mismatch/);

    expect(() => store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: commandFirstUnitPhaseBindings(["test"]),
    })).toThrow(/replay fence mismatch/);
  });

  it("requires canonical unit phase bindings for new execution graphs", () => {
    const store = setup();
    expect(() => store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
    })).toThrow(/unitPhaseBindings are required/);
  });

  it("rejects cross-instance and mixed-attempt child identity inserts", () => {
    const store = setup();
    const graph = store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    db!.exec(`
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-2', 'OPE-2', 'session-2', 'ot/ope-2', 'codex', 'owner/repo', 'main', '${timestamp}', '${timestamp}');
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES ('session-2', 'issue-2', 1, 'current', '${timestamp}', '${timestamp}');
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-other', 'issue-2', 'session-2', 1, 'implement', 'request-hash',
        'running', '${timestamp}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-2', 'issue-2', 'session-2', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-2', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${timestamp}', '${timestamp}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-2', 'units', 1, 'running', 1, '${timestamp}', '${timestamp}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-other', 'instance-2', 'units', 1, 0, '${"1".repeat(64)}',
        'attempt-key-other', 0, 'none', 'run-other', 'run-other', 'running', '${timestamp}', '${timestamp}'
      );
    `);

    expect(() => db!.prepare(`
      INSERT INTO execution_units (
        id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
        authored_order, dependency_unit_ids, status, created_at, updated_at
      ) VALUES (
        'mixed-unit', ?, 'instance-2', 'attempt-other',
        'a', 0, '[]', 'pending', ?, ?
      )
    `).run(graph.id, timestamp, timestamp)).toThrow(/FOREIGN KEY/);

    const unit = db!.prepare("SELECT * FROM execution_units WHERE unit_id = 'a'")
      .get() as { id: string; execution_graph_id: string };
    expect(() => db!.prepare(`
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
        parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
        status, payload, created_at, updated_at
      ) VALUES (
        'mixed-work', ?, ?, 'instance-2', 'attempt-other',
        'run-other', 'a', 1, 'implement', 'mixed-key',
        'leased', '{}', ?, ?
      )
    `).run(unit.execution_graph_id, unit.id, timestamp, timestamp)).toThrow(/FOREIGN KEY/);
  });

  it("rejects active action pointers from sibling units and parent attempts", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;
    expect(db!.prepare(`
      SELECT active_work_attempt_id FROM execution_units
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
    `).get()).toEqual({ active_work_attempt_id: first.id });

    db!.prepare(`
      UPDATE execution_units
      SET active_work_attempt_id = NULL
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
    `).run();
    expect(() => db!.prepare(`
      UPDATE execution_units
      SET active_work_attempt_id = ?
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'b'
    `).run(first.id)).toThrow(/FOREIGN KEY/);

    db!.exec(`
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-other', 'issue-1', 'session-1', 1, 'implement', 'request-hash-other',
        'running', '${timestamp}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-other', 'instance-1', 'units', 2, 0, '${"1".repeat(64)}',
        'attempt-key-other', 0, 'none', 'run-other', 'run-other', 'running', '${timestamp}', '${timestamp}'
      );
    `);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-other",
      parentStageId: "units",
      parentRunId: "run-other",
      graphDigest: "graph-digest-other",
      planDigest: "plan-digest-other",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const other = store.leaseNextUnitAction({
      parentAttemptId: "attempt-other",
      leaseOwner: "worker-2",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;
    db!.prepare(`
      UPDATE execution_units
      SET active_work_attempt_id = NULL
      WHERE parent_attempt_id = 'attempt-other' AND unit_id = 'a'
    `).run();
    expect(() => db!.prepare(`
      UPDATE execution_units
      SET active_work_attempt_id = ?
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
    `).run(other.id)).toThrow(/FOREIGN KEY/);
  });

  it("rejects caller-provided unit phase bindings that disagree with projected execution data", () => {
    const store = setup();
    const input = {
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhases: ["implement", "candidate", "lead", "integrate"] as const,
      unitPhaseBindings: unitPhaseBindings(),
    };

    expect(() => store.createGraph({
      ...input,
      unitPhases: ["command", "implement", "candidate", "lead", "integrate"],
    })).toThrow(/unitPhaseBindings must match unitPhases/);

    expect(() => store.createGraph({
      ...input,
      commandNames: ["test"],
    })).toThrow(/unitPhaseBindings command phases must match commandNames/);
  });

  it("leases exactly one active child action at a time", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const first = lease(store);
    const raced = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(first?.unit_id).toBe("a");
    expect(first?.action_kind).toBe("implement");
    expect(raced).toBeUndefined();
  });

  it("traverses every required phase for a unit success, then starts the next unit", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings(["test", "lint"]),
    });

    const implement = lease(store);
    expect(implement).toMatchObject({ unit_id: "a", action_kind: "implement", cycle: 1 });
    store.markActionDispatched(implement.id, "request-hash", "native-session");
    store.completeUnitAction({
      actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion"),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "simplify", status: "running" });

    const simplify = lease(store);
    expect(simplify.action_kind).toBe("simplify");
    store.completeUnitAction({ actionId: simplify.id, resultHash: "r2", outputSubject: subject });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "command", commandIndex: 0 });

    const command1 = lease(store);
    expect(command1).toMatchObject({ action_kind: "command", command_name: "test" });
    store.completeUnitAction({
      actionId: command1.id, resultHash: "r3", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "command", commandIndex: 1 });

    const command2 = lease(store);
    expect(command2).toMatchObject({ action_kind: "command", command_name: "lint" });
    store.completeUnitAction({
      actionId: command2.id, resultHash: "r4", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "lint" } }),
    });

    const candidate = lease(store);
    expect(candidate.action_kind).toBe("candidate");
    store.completeUnitAction({
      actionId: candidate.id, resultHash: "r5", outputSubject: subject, receipt: receiptJson("candidate_evidence"),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "lead" });

    const lead = lease(store);
    expect(lead.action_kind).toBe("lead");
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r6",
      outputSubject: subject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "integrate", acceptedCandidateSubject: subject });

    const integrate = lease(store);
    expect(integrate.action_kind).toBe("integrate");
    store.completeGatedAction({
      actionId: integrate.id,
      resultHash: "r7",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "integration", outcome: "success", subject }),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      status: "completed", terminalLevel: "completed", integrationSubject: subject,
    });

    // The second unit only starts once the first has fully settled.
    const second = lease(store);
    expect(second).toMatchObject({ unit_id: "b", action_kind: "implement" });
  });

  it("traverses a graph-declared unit phase order", () => {
    const store = setup();
    const preflightSubject = "1".repeat(40);
    const implementedSubject = "2".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: commandFirstUnitPhaseBindings(["test"]),
    });

    const command = lease(store);
    expect(command).toMatchObject({ unit_id: "a", action_kind: "command", command_name: "test" });
    store.completeUnitAction({
      actionId: command.id, resultHash: "r-command", outputSubject: preflightSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const implement = lease(store);
    expect(implement).toMatchObject({ action_kind: "implement", cycle: 1 });
    store.completeUnitAction({
      actionId: implement.id, resultHash: "r-implement", outputSubject: implementedSubject, receipt: receiptJson("unit_completion"),
    });

    const freshCommand = lease(store);
    expect(freshCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: freshCommand.id, resultHash: "r-command-fresh", outputSubject: implementedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const candidate = lease(store);
    expect(candidate.action_kind).toBe("candidate");
    store.completeUnitAction({
      actionId: candidate.id, resultHash: "r-candidate", outputSubject: implementedSubject, receipt: receiptJson("candidate_evidence"),
    });
    const lead = lease(store);
    expect(lead.action_kind).toBe("lead");
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r-lead",
      outputSubject: implementedSubject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject: implementedSubject }),
    });
    const integrate = lease(store);
    expect(integrate.action_kind).toBe("integrate");
    const attempts = db!.prepare(`
      SELECT action_kind, cycle, command_name, output_subject FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id = ?
      ORDER BY rowid
    `).all("attempt-parent", "a");
    expect(attempts).toEqual([
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: preflightSubject }),
      expect.objectContaining({ action_kind: "implement", cycle: 1, command_name: null, output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "candidate", cycle: 1, command_name: null, output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "lead", cycle: 1, command_name: null, output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "integrate", cycle: 1, command_name: null, output_subject: null }),
    ]);
  });

  it("repairs command-first graphs back to implement without evaluating stale command evidence", () => {
    const store = setup();
    const preflightSubject = "1".repeat(40);
    const implementedSubject = "2".repeat(40);
    const repairedSubject = "3".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: commandFirstUnitPhaseBindings(["test"]),
    });

    const firstCommand = lease(store);
    store.completeUnitAction({
      actionId: firstCommand.id, resultHash: "r-command", outputSubject: preflightSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    const implement = lease(store);
    store.completeUnitAction({
      actionId: implement.id, resultHash: "r-implement", outputSubject: implementedSubject, receipt: receiptJson("unit_completion"),
    });
    const implementedCommand = lease(store);
    expect(implementedCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: implementedCommand.id, resultHash: "r-command-implemented", outputSubject: implementedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    const candidate = lease(store);
    store.completeUnitAction({
      actionId: candidate.id, resultHash: "r-candidate", outputSubject: implementedSubject, receipt: receiptJson("candidate_evidence"),
    });
    const lead = lease(store);
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r-lead",
      outputSubject: implementedSubject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "semantic_repair_required", subject: implementedSubject }),
    });

    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "implement", currentCycle: 2, repairRounds: 1, commandIndex: 0,
    });
    const repair = lease(store);
    expect(repair).toMatchObject({ action_kind: "repair", command_name: null, cycle: 2 });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "implement", currentCycle: 2, repairRounds: 1, commandIndex: 0,
    });
    store.completeUnitAction({
      actionId: repair.id, resultHash: "r-repair", outputSubject: repairedSubject, receipt: receiptJson("unit_completion"),
    });

    const freshCommand = lease(store);
    expect(freshCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 2 });
    store.completeUnitAction({
      actionId: freshCommand.id, resultHash: "r-command-2", outputSubject: repairedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const freshCandidate = lease(store);
    expect(freshCandidate).toMatchObject({ action_kind: "candidate", command_name: null, cycle: 2 });
    store.completeUnitAction({
      actionId: freshCandidate.id, resultHash: "r-candidate-2", outputSubject: repairedSubject,
      receipt: receiptJson("candidate_evidence"),
    });
    const freshLead = lease(store);
    expect(freshLead).toMatchObject({ action_kind: "lead", cycle: 2 });
    store.completeGatedAction({
      actionId: freshLead.id,
      resultHash: "r-lead-2",
      outputSubject: repairedSubject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject: repairedSubject }),
    });

    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "integrate",
      acceptedCandidateSubject: repairedSubject,
      commandIndex: 1,
    });
    const attempts = db!.prepare(`
      SELECT action_kind, cycle, command_name, output_subject FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id = ?
      ORDER BY created_at, id
    `).all("attempt-parent", "a");
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: preflightSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 2, command_name: "test", output_subject: repairedSubject }),
      expect.objectContaining({ action_kind: "candidate", cycle: 2, output_subject: repairedSubject }),
    ]));
  });

  it("reruns command-first verification after the final simplify mutation", () => {
    const store = setup();
    const preflightSubject = "1".repeat(40);
    const implementedSubject = "2".repeat(40);
    const simplifiedSubject = "3".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: commandFirstWithSimplifyUnitPhaseBindings(["test"]),
    });

    const preflightCommand = lease(store);
    expect(preflightCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: preflightCommand.id,
      resultHash: "r-command-preflight",
      outputSubject: preflightSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const implement = lease(store);
    expect(implement).toMatchObject({ action_kind: "implement", cycle: 1 });
    store.completeUnitAction({
      actionId: implement.id,
      resultHash: "r-implement",
      outputSubject: implementedSubject,
      receipt: receiptJson("unit_completion"),
    });

    const simplify = lease(store);
    expect(simplify).toMatchObject({ action_kind: "simplify", cycle: 1 });
    store.completeUnitAction({
      actionId: simplify.id,
      resultHash: "r-simplify",
      outputSubject: simplifiedSubject,
    });

    const freshCommand = lease(store);
    expect(freshCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: freshCommand.id,
      resultHash: "r-command-fresh",
      outputSubject: simplifiedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const candidate = lease(store);
    expect(candidate).toMatchObject({ action_kind: "candidate", cycle: 1 });
    store.completeUnitAction({
      actionId: candidate.id,
      resultHash: "r-candidate",
      outputSubject: simplifiedSubject,
      receipt: receiptJson("candidate_evidence"),
    });
    const lead = lease(store);
    expect(lead).toMatchObject({ action_kind: "lead", cycle: 1 });

    const attempts = db!.prepare(`
      SELECT action_kind, cycle, command_name, output_subject FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id = ?
      ORDER BY rowid
    `).all("attempt-parent", "a");
    expect(attempts).toEqual([
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: preflightSubject }),
      expect.objectContaining({ action_kind: "implement", cycle: 1, command_name: null, output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "simplify", cycle: 1, command_name: null, output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "candidate", cycle: 1, command_name: null, output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "lead", cycle: 1, command_name: null, output_subject: null }),
    ]);
  });

  it("reruns commands declared between implement and simplify before candidate and repair acceptance", () => {
    const store = setup();
    const implementedSubject = "1".repeat(40);
    const staleCommandSubject = "2".repeat(40);
    const simplifiedSubject = "3".repeat(40);
    const repairedSubject = "4".repeat(40);
    const repairedSimplifiedSubject = "5".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: commandBeforeSimplifyUnitPhaseBindings(["test"]),
    });

    const implement = lease(store);
    expect(implement).toMatchObject({ action_kind: "implement", cycle: 1 });
    store.completeUnitAction({
      actionId: implement.id,
      resultHash: "r-implement",
      outputSubject: implementedSubject,
      receipt: receiptJson("unit_completion"),
    });

    const staleCommand = lease(store);
    expect(staleCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: staleCommand.id,
      resultHash: "r-command-stale",
      outputSubject: staleCommandSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const simplify = lease(store);
    expect(simplify).toMatchObject({ action_kind: "simplify", cycle: 1 });
    store.completeUnitAction({
      actionId: simplify.id,
      resultHash: "r-simplify",
      outputSubject: simplifiedSubject,
    });

    const freshCommand = lease(store);
    expect(freshCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: freshCommand.id,
      resultHash: "r-command-fresh",
      outputSubject: simplifiedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const candidate = lease(store);
    expect(candidate).toMatchObject({ action_kind: "candidate", cycle: 1 });
    store.completeUnitAction({
      actionId: candidate.id,
      resultHash: "r-candidate",
      outputSubject: simplifiedSubject,
      receipt: receiptJson("candidate_evidence"),
    });
    const lead = lease(store);
    expect(lead).toMatchObject({ action_kind: "lead", cycle: 1 });
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r-lead",
      outputSubject: simplifiedSubject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({
        gateKind: "unit_acceptance",
        outcome: "semantic_repair_required",
        subject: simplifiedSubject,
      }),
    });

    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "implement",
      currentCycle: 2,
      repairRounds: 1,
      commandIndex: 0,
    });
    const repair = lease(store);
    expect(repair).toMatchObject({ action_kind: "repair", cycle: 2 });
    store.completeUnitAction({
      actionId: repair.id,
      resultHash: "r-repair",
      outputSubject: repairedSubject,
      receipt: receiptJson("unit_completion"),
    });

    const repairSimplify = lease(store);
    expect(repairSimplify).toMatchObject({ action_kind: "simplify", cycle: 2 });
    store.completeUnitAction({
      actionId: repairSimplify.id,
      resultHash: "r-simplify-repair",
      outputSubject: repairedSimplifiedSubject,
    });

    const repairCommand = lease(store);
    expect(repairCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 2 });
    store.completeUnitAction({
      actionId: repairCommand.id,
      resultHash: "r-command-repair",
      outputSubject: repairedSimplifiedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });

    const repairCandidate = lease(store);
    expect(repairCandidate).toMatchObject({ action_kind: "candidate", cycle: 2 });
    store.completeUnitAction({
      actionId: repairCandidate.id,
      resultHash: "r-candidate-repair",
      outputSubject: repairedSimplifiedSubject,
      receipt: receiptJson("candidate_evidence"),
    });
    const repairLead = lease(store);
    expect(repairLead).toMatchObject({ action_kind: "lead", cycle: 2 });
    store.completeGatedAction({
      actionId: repairLead.id,
      resultHash: "r-lead-repair",
      outputSubject: repairedSimplifiedSubject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({
        gateKind: "unit_acceptance",
        outcome: "success",
        subject: repairedSimplifiedSubject,
      }),
    });

    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "integrate",
      acceptedCandidateSubject: repairedSimplifiedSubject,
      commandIndex: 1,
    });
    const attempts = db!.prepare(`
      SELECT action_kind, cycle, command_name, output_subject FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id = ?
      ORDER BY rowid
    `).all("attempt-parent", "a");
    expect(attempts).toEqual([
      expect.objectContaining({ action_kind: "implement", cycle: 1, command_name: null, output_subject: implementedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: staleCommandSubject }),
      expect.objectContaining({ action_kind: "simplify", cycle: 1, command_name: null, output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 1, command_name: "test", output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "candidate", cycle: 1, command_name: null, output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "lead", cycle: 1, command_name: null, output_subject: simplifiedSubject }),
      expect.objectContaining({ action_kind: "repair", cycle: 2, command_name: null, output_subject: repairedSubject }),
      expect.objectContaining({ action_kind: "simplify", cycle: 2, command_name: null, output_subject: repairedSimplifiedSubject }),
      expect.objectContaining({ action_kind: "command", cycle: 2, command_name: "test", output_subject: repairedSimplifiedSubject }),
      expect.objectContaining({ action_kind: "candidate", cycle: 2, command_name: null, output_subject: repairedSimplifiedSubject }),
      expect.objectContaining({ action_kind: "lead", cycle: 2, command_name: null, output_subject: repairedSimplifiedSubject }),
    ]);
  });

  it("fails closed on malformed persisted unit phase sequences", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: unitPhaseBindings(),
    });
    db!.prepare("UPDATE execution_graphs SET unit_phases = ? WHERE parent_attempt_id = ?")
      .run(JSON.stringify(["implement", "unknown", "candidate", "lead", "integrate"]), "attempt-parent");

    expect(() => lease(store)).toThrow(/unit phase unknown is not recognized/);
  });

  it("fails closed when persisted unit phases put simplify before implement", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: unitPhaseBindings(),
    });
    db!.prepare("UPDATE execution_graphs SET unit_phases = ? WHERE parent_attempt_id = ?")
      .run(JSON.stringify(["simplify", "implement", "candidate", "lead", "integrate"]), "attempt-parent");

    expect(() => lease(store)).toThrow(/simplify phase must not precede implement/);
  });

  it("rejects caller-provided unit phase sequences that would bypass required gates", () => {
    const store = setup();
    expect(() => store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: [{ id: "integrate", kind: "integrate" }],
    })).toThrow(/unit phases must include implement/);
  });

  it("expires stale leased work and returns the unit to the serial queue", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;

    const recovered = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(recovered?.unit_id).toBe("a");
    expect(recovered?.id).not.toBe(first.id);
    expect(db!.prepare(`
      SELECT status, last_error FROM execution_work_attempts WHERE id = ?
    `).get(first.id)).toEqual({
      status: "failed",
      last_error: "lease expired before acknowledgement",
    });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "running", activeActionId: recovered!.id }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("returns an expired dispatched action for reconciliation instead of healing in the lease transaction", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const first = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(first.id, "request-hash", "native-session");

    const next = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });

    expect(next?.id).toBe(first.id);
    expect(next?.unit_id).toBe("a");
    expect(db!.prepare(`
      SELECT status, completed_at, last_error FROM execution_work_attempts WHERE id = ?
    `).get(first.id)).toEqual({
      status: "dispatched",
      completed_at: null,
      last_error: null,
    });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "running",
        activeActionId: first.id,
        terminalLevel: null,
        alarm: false,
      }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("heals the expired current dispatched child action after confirmed no-result collection", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const stale = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(stale.id, "request-hash", "native-session");

    const healed = store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: stale.id,
      nowIso: "2026-07-29T00:00:02.000Z",
      reason: "child action missed heartbeat fence",
    });
    expect(healed).toBe("healed");
    expect(db!.prepare(`
      SELECT status, completed_at, last_error FROM execution_work_attempts WHERE id = ?
    `).get(stale.id)).toEqual({
      status: "dead",
      completed_at: "2026-07-29T00:00:02.000Z",
      last_error: "child action missed heartbeat fence",
    });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
        alarm: false,
      }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);

    const next = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    });
    expect(next?.unit_id).toBe("b");
  });

  it("completes a recovered result through the current action pointer before any heal", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const expired = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(expired.id, "request-hash", "native-session");

    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })?.id).toBe(expired.id);

    store.completeUnitAction({
      actionId: expired.id,
      resultHash: "result-hash",
      outputSubject: "1".repeat(40),
      receipt: receiptJson("unit_completion"),
    });
    expect(store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: expired.id,
      nowIso: "2026-07-29T00:00:02.000Z",
      reason: "child action missed heartbeat fence",
    })).toBe("not_current");
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "running",
        phase: "simplify",
        activeActionId: null,
        terminalLevel: null,
      }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("rejects a late recovered result after the current action was healed", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const expired = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(expired.id, "request-hash", "native-session");

    expect(store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: expired.id,
      nowIso: "2026-07-29T00:00:02.000Z",
      reason: "child action missed heartbeat fence",
    })).toBe("healed");
    expect(() => store.completeUnitAction({
      actionId: expired.id,
      resultHash: "result-hash",
      outputSubject: "1".repeat(40),
    })).toThrow(/not active/);
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
      }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
  });

  it("heals the expired current running child action after confirmed no-result collection", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const stale = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(stale.id, "request-hash", "native-session");
    db!.prepare("UPDATE execution_work_attempts SET status = 'running' WHERE id = ?").run(stale.id);

    expect(store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: stale.id,
      nowIso: "2026-07-29T00:00:02.000Z",
      reason: "child action missed heartbeat fence",
    })).toBe("healed");
    expect(db!.prepare(`
      SELECT status, completed_at, last_error FROM execution_work_attempts WHERE id = ?
    `).get(stale.id)).toEqual({
      status: "dead",
      completed_at: "2026-07-29T00:00:02.000Z",
      last_error: "child action missed heartbeat fence",
    });
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
        alarm: false,
      }),
      expect.objectContaining({ unitId: "b", status: "pending", activeActionId: null }),
    ]);
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })?.unit_id).toBe("b");
  });

  it("does not renew child action liveness from dispatcher polling", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const active = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;
    store.markActionDispatched(active.id, "request-hash", "native-session");

    const polled = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:30.000Z",
      leaseUntilIso: "2026-07-29T00:02:00.000Z",
    });
    expect(polled?.id).toBe(active.id);
    expect(db!.prepare("SELECT lease_owner, lease_until FROM execution_work_attempts WHERE id = ?").get(active.id)).toEqual({
      lease_owner: "worker-1",
      lease_until: "2026-07-29T00:01:00.000Z",
    });

    const next = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:01:01.000Z",
      leaseUntilIso: "2026-07-29T00:02:00.000Z",
    });
    expect(next?.id).toBe(active.id);
    expect(next?.unit_id).toBe("a");
    expect(db!.prepare("SELECT status FROM execution_work_attempts WHERE id = ?").get(active.id)).toEqual({
      status: "dispatched",
    });
  });

  it("cascades structural exit to dependents blocked by a healed prerequisite", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const stale = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:01.000Z",
    })!;
    store.markActionDispatched(stale.id, "request-hash", "native-session");

    expect(store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: stale.id,
      nowIso: "2026-07-29T00:00:02.000Z",
      reason: "child action missed heartbeat fence",
    })).toBe("healed");
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "exited", terminalLevel: "exited", alarm: false }),
      expect.objectContaining({ unitId: "b", status: "exited", terminalLevel: "exited", alarm: false }),
    ]);
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: "2026-07-29T00:00:02.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBeUndefined();
  });

  it("does not heal a slow alive current child action", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const active = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;
    store.markActionDispatched(active.id, "request-hash", "native-session");

    expect(store.healExpiredCurrentChildAction({
      parentAttemptId: "attempt-parent",
      actionId: active.id,
      nowIso: "2026-07-29T00:00:30.000Z",
      reason: "child action missed heartbeat fence",
    })).toBe("not_current");
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "running",
        activeActionId: active.id,
        terminalLevel: null,
        alarm: false,
      }),
    ]);
  });

  it("renews child action liveness only under its parent run fence", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const active = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      leaseUntilIso: "2026-07-29T00:00:10.000Z",
    })!;
    store.markActionDispatched(active.id, "request-hash", "native-session");

    expect(store.renewChildActionLiveness({
      parentRunId: "wrong-run",
      actionId: active.id,
      heartbeatAtIso: "2026-07-29T00:00:05.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBe(false);
    expect(store.renewChildActionLiveness({
      parentRunId: "run-parent",
      actionId: active.id,
      heartbeatAtIso: "2026-07-29T00:00:05.000Z",
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBe(true);
    expect(db!.prepare("SELECT lease_until FROM execution_work_attempts WHERE id = ?").get(active.id)).toEqual({
      lease_until: "2026-07-29T00:01:00.000Z",
    });
    expect(store.renewChildActionLiveness({
      parentRunId: "run-parent",
      actionId: active.id,
      heartbeatAtIso: "2026-07-29T00:00:06.000Z",
      leaseUntilIso: "2026-07-29T00:00:30.000Z",
    })).toBe(true);
    expect(db!.prepare("SELECT lease_until FROM execution_work_attempts WHERE id = ?").get(active.id)).toEqual({
      lease_until: "2026-07-29T00:01:00.000Z",
    });
  });

  it("levels failed unit terminals with the operator alarm set", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    expect(store.settleUnitTerminal({
      parentAttemptId: "attempt-parent",
      unitId: "a",
      reason: "defect",
    })).toBe("settled");
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "failed",
        terminalLevel: "failed",
        alarm: true,
      }),
    ]);
  });

  it("emits one aggregate only after every unit integrated and the whole-change final review has passed", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    expect(() => store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: "111",
    })).toThrow(/unfinished units/);

    const action = lease(store);
    store.completeUnitAction({
      actionId: action.id, resultHash: "result-hash", outputSubject: subject, receipt: receiptJson("unit_completion"),
    });

    store.settleUnitTerminal({
      parentAttemptId: "attempt-parent",
      unitId: "a",
      reason: "acceptance_passed",
    });

    expect(() => store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: subject,
    })).toThrow(/final review has not passed/);

    const finalReview = lease(store);
    expect(finalReview).toMatchObject({ action_kind: "final_review", unit_id: null });
    store.completeGatedAction({
      actionId: finalReview.id,
      resultHash: "fr-hash",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "final_review", outcome: "success", subject }),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "done" });

    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: subject,
    })).toBe("emitted");
    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-1",
      integrationSubject: subject,
    })).toBe("already_emitted");
    expect(() => store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-2",
      integrationSubject: "222",
    })).toThrow(/different aggregate/);
    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "superseded",
    })).toBe("already_stopped");
  });

  it("advances the graph integration head after each serial integration", () => {
    const store = setup();
    const firstSubject = "1".repeat(40);
    const secondSubject = "2".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    completeUnitToTerminal(store, firstSubject);
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ integration_subject: firstSubject });
    completeUnitToTerminal(store, secondSubject);
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ integration_subject: secondSubject });

    const finalReview = lease(store);
    expect(finalReview).toMatchObject({ action_kind: "final_review", unit_id: null });
    store.completeGatedAction({
      actionId: finalReview.id,
      resultHash: "fr-hash",
      outputSubject: secondSubject,
      decision: gateDecision({ gateKind: "final_review", outcome: "success", subject: secondSubject }),
    });

    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-serial",
      integrationSubject: secondSubject,
    })).toBe("emitted");
  });

  it("emits a non-success aggregate for a terminal unintegrated graph without final review", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    store.settleUnitTerminal({
      parentAttemptId: "attempt-parent",
      unitId: "a",
      reason: "structural_exit",
    });

    expect(store.emitAggregateOnce({
      parentAttemptId: "attempt-parent",
      artifactHash: "hash-unintegrated",
      integrationSubject: null,
      requireFinalReview: false,
    })).toBe("emitted");
  });

  it("records child gate receipts idempotently and rejects conflicting replay", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;

    const payload = "{\"ok\":true}";
    const receipt = {
      actionId: action.id,
      gateKind: "unit_acceptance" as const,
      evaluatorKind: "semantic" as const,
      subject: "1".repeat(40),
      result: "passed" as const,
      outcome: "success" as const,
      reason: "typed_semantic_result",
      artifactHashes: ["a".repeat(64)],
      payload,
      hash: digestNormalized(payload),
    };

    expect(store.recordGateReceipt(receipt)).toBe("recorded");
    expect(store.recordGateReceipt(receipt)).toBe("already_recorded");
    const conflictingPayload = "{\"ok\":false}";
    expect(() => store.recordGateReceipt({
      ...receipt,
      payload: conflictingPayload,
      hash: digestNormalized(conflictingPayload),
    }))
      .toThrow(/already recorded a different gate receipt/);
    expect(store.listGateReceipts("attempt-parent")).toEqual([
      expect.objectContaining({
        gate_kind: "unit_acceptance",
        unit_id: "a",
        result: "passed",
        outcome: "success",
      }),
    ]);
  });

  it("appends downstream context immutably for pending units only", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "b", payload: { summary: "not sealed yet" } }],
    })).toThrow(/source a is not integrated/);
    completeUnitToTerminal(store, "1".repeat(40));

    const records = store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "b", payload: { summary: "use parser shape from unit a" } }],
    });

    expect(records).toEqual([
      expect.objectContaining({
        from_unit_id: "a",
        to_unit_id: "b",
        payload: "{\"summary\":\"use parser shape from unit a\"}",
      }),
    ]);
    expect(store.listDownstreamContext("attempt-parent", "b")).toEqual(records);
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "missing", payload: { summary: "not in graph" } }],
    })).toThrow(/unknown downstream context target/);
    expect(() => store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "a", payload: { summary: "already integrated" } }],
    })).toThrow(/is not pending/);
  });

  it("builds a structured publication snapshot from durable child state", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const subject = "1".repeat(40);
    const implement = lease(store);
    store.markActionDispatched(implement.id, "request-hash", "native-session");
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    const simplify = lease(store);
    store.completeUnitAction({ actionId: simplify.id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const leadAction = lease(store);
    store.completeGatedAction({
      actionId: leadAction.id,
      resultHash: "r4",
      outputSubject: subject,
      receipt: receiptJson("unit_decision"),
      decision: {
        ...gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject, reason: "Lead accepted the scoped unit." }),
      },
    });
    const integrate = lease(store);
    store.completeGatedAction({
      actionId: integrate.id,
      resultHash: "r5",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "integration", outcome: "success", subject }),
    });
    store.appendDownstreamContext({
      parentAttemptId: "attempt-parent",
      fromUnitId: "a",
      records: [{ toUnitId: "b", payload: { summary: "Use the accepted parser." } }],
    });

    expect(store.getStructuredExecutionPublication("attempt-parent")).toMatchObject({
      graph: { parent_attempt_id: "attempt-parent", parent_stage_id: "units" },
      units: [
        {
          unit_id: "a",
          terminal_level: "completed",
          alarm: false,
          gates: expect.arrayContaining([expect.objectContaining({
            kind: "unit_acceptance",
            evaluator: "human",
            reason: "Lead accepted the scoped unit.",
          })]),
          downstream_context: [expect.objectContaining({
            to_unit_id: "b",
            summary: "Use the accepted parser.",
          })],
        },
        expect.objectContaining({ unit_id: "b", dependencies: ["a"] }),
      ],
    });
  });

  it("retains the newest child attempts when capping publication snapshots", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      timestamp = `2026-07-29T00:0${ordinal}:00.000Z`;
      const action = store.leaseNextUnitAction({
        parentAttemptId: "attempt-parent",
        leaseOwner: "worker-1",
        nowIso: timestamp,
        leaseUntilIso: `2026-07-29T00:0${ordinal}:30.000Z`,
      })!;
      store.markActionDispatched(action.id, `request-${ordinal}`);
      if (ordinal < 4) {
        db!.prepare(`
          UPDATE execution_work_attempts
          SET status = 'failed', completed_at = ?, updated_at = ?, last_error = ?
          WHERE id = ?
        `).run(timestamp, timestamp, `failed attempt ${ordinal}`, action.id);
        db!.prepare(`
          UPDATE execution_units
          SET status = 'pending', active_work_attempt_id = NULL, updated_at = ?
          WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
        `).run(timestamp);
      } else {
        store.completeUnitAction({
          actionId: action.id,
          resultHash: "result-hash",
          outputSubject: "1".repeat(40),
          receipt: receiptJson("unit_completion"),
        });
      }
    }

    const attempts = store.getStructuredExecutionPublication("attempt-parent")?.units[0]?.attempts ?? [];
    expect(attempts.map((attempt) => attempt.attempt_ordinal)).toEqual([2, 3, 4]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "completed"]);
    expect(attempts.map((attempt) => attempt.request_hash)).not.toContain("request-1");
  });

  it("stops active unit work without deleting child graph state", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const action = store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })!;

    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "needs_human",
    })).toBe("stopped");
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-2",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBeUndefined();
    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "needs_human",
    })).toBe("already_stopped");
    const payload = "{\"ok\":true}";
    expect(() => store.recordGateReceipt({
      actionId: action.id,
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      subject: "1".repeat(40),
      result: "passed",
      outcome: "success",
      reason: "typed_semantic_result",
      artifactHashes: ["a".repeat(64)],
      payload,
      hash: digestNormalized(payload),
    })).toThrow(/is not receivable/);
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
        alarm: false,
      }),
      expect.objectContaining({
        unitId: "b",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
        alarm: false,
      }),
    ]);
    expect(db!.prepare("SELECT status, last_error FROM execution_work_attempts WHERE id = ?").get(action.id)).toEqual({
      status: "dead",
      last_error: "needs_human",
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({
      parent_attempt_id: "attempt-parent",
      stopped_at: timestamp,
      stop_reason: "needs_human",
    });
  });

  it("records a graph stop fence before any child action is active", () => {
    const store = setup();
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    expect(store.stopActiveWork({
      parentAttemptId: "attempt-parent",
      reason: "superseded",
    })).toBe("stopped");
    expect(store.leaseNextUnitAction({
      parentAttemptId: "attempt-parent",
      leaseOwner: "worker-1",
      nowIso: timestamp,
      leaseUntilIso: "2026-07-29T00:01:00.000Z",
    })).toBeUndefined();
    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({
        unitId: "a",
        status: "exited",
        activeActionId: null,
        terminalLevel: "exited",
        alarm: false,
      }),
    ]);
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({
      stopped_at: timestamp,
      stop_reason: "superseded",
    });
  });

  it("repairs on command failure, then re-simplifies and reruns every configured command", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings(["test"]),
    });

    const implement = lease(store);
    expect(implement).toMatchObject({ action_kind: "implement", cycle: 1 });
    store.markActionDispatched(implement.id, "request-hash", "native-session-a");
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const command = lease(store);
    store.completeUnitAction({
      actionId: command.id, resultHash: "r3", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "test", exit_code: 1 } }),
    });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r4", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r5",
      outputSubject: subject,
      receipt: receiptJson("unit_decision"),
      decision: gateDecision({
        gateKind: "unit_acceptance", outcome: "semantic_repair_required", subject, reason: "command_exit_nonzero",
      }),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({
      phase: "implement", currentCycle: 2, repairRounds: 1, commandIndex: 0,
    });

    const repair = lease(store);
    expect(repair).toMatchObject({ action_kind: "repair", cycle: 2 });
    expect(JSON.parse(repair.payload)).toMatchObject({ resume_native_session_id: "native-session-a" });
    store.completeUnitAction({ actionId: repair.id, resultHash: "r6", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r7", outputSubject: subject });
    const rerunCommand = lease(store);
    expect(rerunCommand).toMatchObject({ action_kind: "command", command_name: "test", cycle: 2 });
  });

  it("cannot lease a lead action before candidate evidence exists, or an integrate action before lead acceptance", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    // Phase is now 'candidate'; no lead action can be leased yet.
    const beforeLead = lease(store);
    expect(beforeLead.action_kind).toBe("candidate");
    store.completeUnitAction({ actionId: beforeLead.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });

    const lead = lease(store);
    expect(lead.action_kind).toBe("lead");
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    });
    // Only now can the integrate action be leased.
    const integrate = lease(store);
    expect(integrate.action_kind).toBe("integrate");
  });

  it("replays a gated action decision idempotently without double-applying repair routing", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);
    const decision = gateDecision({ gateKind: "unit_acceptance", outcome: "semantic_repair_required", subject, reason: "command_exit_nonzero" });

    store.completeGatedAction({ actionId: lead.id, resultHash: "r4", outputSubject: subject, decision });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ repairRounds: 1, currentCycle: 2 });

    // Replaying the exact same decision for the same (already-completed) action must be a no-op.
    store.completeGatedAction({ actionId: lead.id, resultHash: "r4", outputSubject: subject, decision });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ repairRounds: 1, currentCycle: 2 });

    // A conflicting replay for the same action is rejected outright.
    expect(() => store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject, reason: "lead_scope_match_accept" }),
    })).toThrow(/already recorded a different gate receipt/);
  });

  it("settles a unit as failed once its repair round bound is exhausted", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      maxRepairRounds: 1,
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    function repairOnce() {
      const implement = lease(store);
      store.completeUnitAction({ actionId: implement.id, resultHash: "ri", outputSubject: subject, receipt: receiptJson("unit_completion") });
      store.completeUnitAction({ actionId: lease(store).id, resultHash: "rs", outputSubject: subject });
      const candidate = lease(store);
      store.completeUnitAction({ actionId: candidate.id, resultHash: "rc", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
      const lead = lease(store);
      store.completeGatedAction({
        actionId: lead.id,
        resultHash: "rl",
        outputSubject: subject,
        decision: gateDecision({ gateKind: "unit_acceptance", outcome: "semantic_repair_required", subject, reason: "command_exit_nonzero" }),
      });
    }

    repairOnce();
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "implement", repairRounds: 1, terminalLevel: null });
    repairOnce();
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ status: "failed", terminalLevel: "failed", alarm: true });
  });

  it("structurally exits pending dependents of a unit that fails out of repair, instead of deadlocking the graph", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
      maxRepairRounds: 0,
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "ri", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "rs", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "rc", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "rl",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "semantic_repair_required", subject, reason: "command_exit_nonzero" }),
    });

    expect(store.listUnits("attempt-parent")).toEqual([
      expect.objectContaining({ unitId: "a", status: "failed", terminalLevel: "failed", alarm: true }),
      expect.objectContaining({ unitId: "b", status: "exited", terminalLevel: "exited", alarm: false }),
    ]);
    // The graph is not stuck: it can now reach allSettled and lease returns undefined
    // (both units are terminal) rather than hanging forever on unit b's unmet dependency.
    expect(lease(store)).toBeUndefined();
  });

  it("reruns full commands and forces a fresh final review after a final repair", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings(["test"]),
    });
    completeUnitToTerminal(store, subject, ["test"]);

    const finalCommand1 = lease(store);
    expect(finalCommand1).toMatchObject({ action_kind: "final_command", command_name: "test", cycle: 1 });
    store.completeUnitAction({
      actionId: finalCommand1.id, resultHash: "fc1", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    const finalReview1 = lease(store);
    expect(finalReview1).toMatchObject({ action_kind: "final_review", cycle: 1 });
    store.completeGatedAction({
      actionId: finalReview1.id,
      resultHash: "fr1",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "final_review", outcome: "semantic_repair_required", subject, reason: "unresolved_review_finding" }),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "repair", final_repair_rounds: 1 });

    const finalRepair = lease(store);
    expect(finalRepair.action_kind).toBe("final_repair");
    store.markActionDispatched(finalRepair.id, "request-hash", "native-session-final-repair-1");
    const repairedSubject = "2".repeat(40);
    const repairedCandidate = "3".repeat(40);
    const repairedIntegratedSubject = "4".repeat(40);
    store.completeUnitAction({ actionId: finalRepair.id, resultHash: "frp", outputSubject: repairedSubject });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "repair", final_cycle: 1 });

    const finalCandidate = lease(store);
    expect(finalCandidate).toMatchObject({ action_kind: "candidate", unit_id: null, cycle: 1 });
    store.completeUnitAction({
      actionId: finalCandidate.id, resultHash: "fcandidate", outputSubject: repairedCandidate,
      receipt: receiptJson("candidate_evidence"),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "repair", final_cycle: 1 });

    const finalIntegrate = lease(store);
    expect(finalIntegrate).toMatchObject({ action_kind: "integrate", unit_id: null, cycle: 1 });
    store.completeGatedAction({
      actionId: finalIntegrate.id,
      resultHash: "fintegrate",
      outputSubject: repairedIntegratedSubject,
      receipt: receiptJson("integration_evidence"),
      decision: gateDecision({ gateKind: "integration", subject: repairedIntegratedSubject }),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({
      final_phase: "command",
      final_command_index: 0,
      final_cycle: 2,
      integration_subject: repairedIntegratedSubject,
    });

    const finalCommand2 = lease(store);
    expect(finalCommand2).toMatchObject({ action_kind: "final_command", command_name: "test", cycle: 2 });
    store.completeUnitAction({
      actionId: finalCommand2.id, resultHash: "fc2", outputSubject: repairedIntegratedSubject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    const finalReview2 = lease(store);
    expect(finalReview2).toMatchObject({ action_kind: "final_review", cycle: 2 });
    store.completeGatedAction({
      actionId: finalReview2.id,
      resultHash: "fr2",
      outputSubject: repairedIntegratedSubject,
      decision: gateDecision({
        gateKind: "final_review",
        outcome: "semantic_repair_required",
        subject: repairedIntegratedSubject,
        reason: "unresolved_review_finding",
      }),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "repair", final_repair_rounds: 2 });

    const finalRepair2 = lease(store);
    expect(finalRepair2.action_kind).toBe("final_repair");
    expect(JSON.parse(finalRepair2.payload)).toMatchObject({ resume_native_session_id: "native-session-final-repair-1" });
    store.completeUnitAction({ actionId: finalRepair2.id, resultHash: "frp2", outputSubject: repairedIntegratedSubject });

    const finalCandidate2 = lease(store);
    expect(finalCandidate2).toMatchObject({ action_kind: "candidate", unit_id: null, cycle: 2 });
    store.completeUnitAction({
      actionId: finalCandidate2.id, resultHash: "fcandidate2", outputSubject: repairedIntegratedSubject,
      receipt: receiptJson("candidate_evidence"),
    });

    const finalIntegrate2 = lease(store);
    expect(finalIntegrate2).toMatchObject({ action_kind: "integrate", unit_id: null, cycle: 2 });
    store.completeGatedAction({
      actionId: finalIntegrate2.id,
      resultHash: "fintegrate2",
      outputSubject: repairedIntegratedSubject,
      receipt: receiptJson("integration_evidence"),
      decision: gateDecision({ gateKind: "integration", subject: repairedIntegratedSubject }),
    });

    const finalCommand3 = lease(store);
    expect(finalCommand3).toMatchObject({ action_kind: "final_command", command_name: "test", cycle: 3 });
    store.completeUnitAction({
      actionId: finalCommand3.id, resultHash: "fc3", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "test" } }),
    });
    const finalReview3 = lease(store);
    expect(finalReview3).toMatchObject({ action_kind: "final_review", cycle: 3 });
    store.completeGatedAction({
      actionId: finalReview3.id,
      resultHash: "fr3",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "final_review", outcome: "success", subject }),
    });
    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ final_phase: "done" });
  });

  it("rejects completing a gated phase through the non-gated method and vice versa", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });
    const implement = lease(store);
    expect(() => store.completeGatedAction({
      actionId: implement.id,
      resultHash: "r1",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    })).toThrow(/is not a gated action/);

    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);
    expect(() => store.completeUnitAction({
      actionId: lead.id, resultHash: "r4", outputSubject: subject,
    })).toThrow(/requires a gate decision to complete/);
    expect(() => store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "integration", outcome: "success", subject }),
    })).toThrow(/action lead cannot complete integration gate/);

    // A non-gated action that already reached 'completed' via completeUnitAction
    // (e.g. the earlier implement action) must still be rejected by
    // completeGatedAction -- the gated-kind check must not be skippable just
    // because the action happens to already be completed.
    expect(() => store.completeGatedAction({
      actionId: implement.id,
      resultHash: "r1",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    })).toThrow(/is not a gated action/);
  });

  it("rejects completing a gated action whose unit's active pointer no longer matches, then succeeds once retargeted", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);

    // Force the unit's active-action pointer to diverge from `lead` before completing it.
    db!.prepare(`
      UPDATE execution_units SET active_work_attempt_id = NULL
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
    `).run();

    expect(() => store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    })).toThrow(/is not the current active action/);

    // The throw rolls back the whole transaction (markActionCompleted's write and
    // the gate-receipt insert included), so a correctly-retargeted retry against
    // the same action id succeeds cleanly rather than being stranded.
    db!.prepare(`
      UPDATE execution_units SET active_work_attempt_id = ?
      WHERE parent_attempt_id = 'attempt-parent' AND unit_id = 'a'
    `).run(lead.id);
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    });
    expect(store.listUnits("attempt-parent")[0]).toMatchObject({ phase: "integrate", acceptedCandidateSubject: subject });
  });

  it("rejects a receipt-requiring action completed without a receipt, or with a mismatched receipt shape", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings(["test"]),
    });

    const implement = lease(store);
    expect(() => store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject }))
      .toThrow(/requires a unit_completion receipt/);
    expect(() => store.completeUnitAction({
      actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("candidate_evidence"),
    })).toThrow(/receipt type mismatch/);

    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const command = lease(store);
    expect(() => store.completeUnitAction({
      actionId: command.id, resultHash: "r3", outputSubject: subject,
      receipt: receiptJson("command_result", { payload: { command: "not-the-configured-command" } }),
    })).toThrow(/receipt command name mismatch/);
  });

  it("stops the whole graph when a unit's gate decision escalates as needs_human", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }, { id: "b" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const lead = lease(store);
    store.completeGatedAction({
      actionId: lead.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "needs_human", subject, reason: "lead_needs_human" }),
    });

    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ stopped_at: timestamp, stop_reason: "lead_needs_human" });
    expect(lease(store)).toBeUndefined();
  });

  it("stops the whole graph when an integration gate decision escalates", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    const implement = lease(store);
    store.completeUnitAction({ actionId: implement.id, resultHash: "r1", outputSubject: subject, receipt: receiptJson("unit_completion") });
    store.completeUnitAction({ actionId: lease(store).id, resultHash: "r2", outputSubject: subject });
    const candidate = lease(store);
    store.completeUnitAction({ actionId: candidate.id, resultHash: "r3", outputSubject: subject, receipt: receiptJson("candidate_evidence") });
    const leadAction = lease(store);
    store.completeGatedAction({
      actionId: leadAction.id,
      resultHash: "r4",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "unit_acceptance", outcome: "success", subject }),
    });
    const integrate = lease(store);
    store.completeGatedAction({
      actionId: integrate.id,
      resultHash: "r5",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "integration", outcome: "needs_human", subject, reason: "integration_publish_failed" }),
    });

    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ stopped_at: timestamp, stop_reason: "integration_publish_failed" });
    expect(lease(store)).toBeUndefined();
  });

  it("stops the whole graph when a final review gate decision escalates", () => {
    const store = setup();
    const subject = "1".repeat(40);
    store.createGraph({
      pipelineInstanceId: "instance-1",
      parentAttemptId: "attempt-parent",
      parentStageId: "units",
      parentRunId: "run-parent",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "a" }],
      unitPhaseBindings: builtinUnitPhaseBindings([]),
    });

    completeUnitToTerminal(store, subject);

    const finalReview = lease(store);
    expect(finalReview).toMatchObject({ action_kind: "final_review", unit_id: null });
    store.completeGatedAction({
      actionId: finalReview.id,
      resultHash: "fr-hash",
      outputSubject: subject,
      decision: gateDecision({ gateKind: "final_review", outcome: "needs_human", subject, reason: "final_review_needs_human" }),
    });

    expect(store.getGraphForAttempt("attempt-parent")).toMatchObject({ stopped_at: timestamp, stop_reason: "final_review_needs_human" });
    expect(lease(store)).toBeUndefined();
  });
});
