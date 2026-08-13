import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmissionDrainStore } from "../persistence/admission-drain-store.js";
import { createExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import { canonicalJson, digestNormalized, type PipelineUnitPhaseBinding } from "../pipeline/manifest.js";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import { buildAdmissionDrainReport } from "./admission-drain-report.js";

let db: Database.Database | undefined;

const nowIso = "2026-08-13T00:00:00.000Z";
const epochStartedAtIso = "2026-08-13T00:00:00.000Z";

afterEach(() => {
  db?.close();
  db = undefined;
});

function unitPhaseBindings(): PipelineUnitPhaseBinding[] {
  const worker = {
    id: "worker",
    engine: "agent" as const,
    model: "gpt-5",
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

function setup() {
  const fixture = setupPipelineStore();
  db = fixture.db;
  const manifest = fixture.catalog.manifests.get("fixture/command@1")!;
  const seed = (sessionId: string) => {
    fixture.tickets.upsert({
      ...ticket(sessionId),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: fixture.snapshot,
        runtime: fixture.runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    return fixture.pipelines.getInstanceForSession(sessionId)!;
  };
  return { ...fixture, seed };
}

async function report(options: {
  runtime?: { listLabeledResources: (limit?: number) => Promise<Array<{ id: string; state?: string; createdAt?: string; memory?: number }>> };
  limit?: number;
} = {}) {
  if (!db) throw new Error("missing db");
  return buildAdmissionDrainReport({
    store: createAdmissionDrainStore(db),
    runtime: options.runtime ?? { listLabeledResources: async () => [] },
    admissionPaused: true,
    epochStartedAtIso,
    nowIso,
    limit: options.limit,
  });
}

describe("admission drain report", () => {
  it("cannot report clear before the admission pause is active", async () => {
    setup();
    const verdict = await buildAdmissionDrainReport({
      store: createAdmissionDrainStore(db!),
      runtime: { listLabeledResources: async () => [] },
      admissionPaused: false,
      epochStartedAtIso,
      nowIso,
    });

    expect(verdict).toEqual({
      clear: false,
      blockers: [{
        kind: "admission_not_paused",
        id: "admission",
        detail: "admission maintenance pause is not active",
      }],
      truncated: false,
    });
  });

  it("clears only after successful provider inventory and no durable blockers", async () => {
    setup();

    await expect(report()).resolves.toEqual({ clear: true, blockers: [], truncated: false });
  });

  it("treats provider inventory errors as fail-closed blockers", async () => {
    setup();

    const verdict = await report({
      runtime: {
        listLabeledResources: async () => {
          throw new Error("Daytona inventory unavailable");
        },
      },
    });

    expect(verdict.clear).toBe(false);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({
        kind: "runtime_inventory_error",
        id: "runtime-inventory",
        detail: "Error: Daytona inventory unavailable",
      }),
    ]);
  });

  it("reports every durable blocker category with deterministic bounded output", async () => {
    const { seed, pipelines } = setup();
    const instance = seed("session-active");
    const activeAttempt = pipelines.getActiveAttempt(instance.id)!;
    db!.prepare(`
      INSERT INTO webhook_deliveries (
        delivery_id, source, session_id, action, status, attempts, next_attempt_at, received_at
      ) VALUES ('delivery-pre-epoch', 'github', 'session-active', 'issues:labeled', 'processing', 1, ?, ?)
    `).run("2026-08-13T00:05:00.000Z", "2026-08-12T23:59:59.000Z");
    pipelines.bindRuntimeResource(instance.id, "daytona", "sandbox-bound");
    const effect = pipelines.listEffects(instance.id)[0]!;
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'failed', next_attempt_at = ?
      WHERE id = ?
    `).run("2026-08-12T23:00:00.000Z", effect.id);
    const unitStore = createExecutionUnitStore(db!, () => nowIso);
    unitStore.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: activeAttempt.id,
      parentStageId: activeAttempt.stage_id,
      parentRunId: activeAttempt.planned_run_id!,
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "u1" }],
      unitPhaseBindings: unitPhaseBindings(),
    });
    const leased = unitStore.leaseNextUnitAction({
      parentAttemptId: activeAttempt.id,
      leaseOwner: "worker",
      nowIso,
      leaseUntilIso: "2026-08-13T00:05:00.000Z",
    });
    expect(leased).toMatchObject({ status: "leased" });

    const verdict = await report({ limit: 10 });

    expect(verdict.clear).toBe(false);
    expect(verdict.truncated).toBe(false);
    expect(verdict.blockers.map((blocker) => blocker.kind)).toEqual([
      "pre_epoch_webhook_delivery_lease",
      "nonterminal_pipeline_instance",
      "runnable_pipeline_effect",
      "leased_child_action",
      "bound_active_runtime_resource",
    ]);
    expect(verdict.blockers.map((blocker) => blocker.id)).toEqual([
      "delivery-pre-epoch",
      instance.id,
      effect.id,
      leased!.id,
      "sandbox-bound",
    ]);
  });

  it("blocks an active webhook lease even when it began after the maintenance epoch", async () => {
    setup();
    db!.prepare(`
      INSERT INTO webhook_deliveries (
        delivery_id, source, action, status, attempts, next_attempt_at, received_at
      ) VALUES ('delivery-post-epoch', 'github', 'issues:labeled', 'processing', 1, ?, ?)
    `).run("2026-08-13T00:06:00.000Z", "2026-08-13T00:05:00.000Z");

    const verdict = await report();

    expect(verdict.clear).toBe(false);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({
        kind: "active_webhook_delivery_lease",
        id: "delivery-post-epoch",
      }),
    ]);
  });

  it("reports orphan, destroying, and unavailable provider inventory while excluding destroyed resources", async () => {
    setup();

    const verdict = await report({
      runtime: {
        listLabeledResources: async () => [
          { id: "sandbox-destroyed", state: "destroyed", memory: 8 },
          { id: "sandbox-destroying", state: "destroying", memory: 8 },
          { id: "sandbox-orphan", state: "stopped", createdAt: "2026-08-12T00:00:00.000Z", memory: 8 },
        ],
      },
    });

    expect(verdict.clear).toBe(false);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({
        kind: "unknown_runtime_inventory_resource",
        id: "sandbox-destroying",
      }),
      expect.objectContaining({
        kind: "unknown_runtime_inventory_resource",
        id: "sandbox-orphan",
      }),
    ]);
  });

  it("reports runnable github publication receipts after terminal pipeline settlement", async () => {
    const { seed } = setup();
    const terminal = seed("session-publication");
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'shipped', terminal_outcome = 'shipped'
      WHERE id = ?
    `).run(terminal.id);
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE pipeline_instance_id = ?
    `).run(nowIso, terminal.id);
    const payload = canonicalJson({ pipeline_instance_id: terminal.id, status: "shipped" });
    db!.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, attempt_id, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (
        'pub-terminal', ?, NULL, 'github_summary', 'github-summary:terminal',
        ?, ?, 'pending', 0, ?, ?, ?
      )
    `).run(terminal.id, payload, digestNormalized(payload), nowIso, nowIso, nowIso);

    const verdict = await report();

    expect(verdict.clear).toBe(false);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({
        kind: "runnable_publication_receipt",
        id: "pub-terminal",
      }),
    ]);
  });

  it("does not let terminal rows or destroyed resources block a clear report", async () => {
    const { seed, pipelines } = setup();
    const terminal = seed("session-terminal");
    pipelines.bindRuntimeResource(terminal.id, "daytona", "sandbox-terminal");
    db!.prepare(`
      UPDATE pipeline_instances
      SET status = 'needs_human', terminal_outcome = 'needs_human'
      WHERE id = ?
    `).run(terminal.id);
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE pipeline_instance_id = ?
    `).run(nowIso, terminal.id);

    const verdict = await report({
      runtime: {
        listLabeledResources: async () => [
          { id: "sandbox-terminal", state: "destroyed", createdAt: "2026-08-12T00:00:00.000Z", memory: 8 },
        ],
      },
    });

    expect(verdict).toEqual({ clear: true, blockers: [], truncated: false });
  });

  it("bounds the report deterministically", async () => {
    setup();
    for (const id of ["b", "a", "c"]) {
      db!.prepare(`
        INSERT INTO webhook_deliveries (
          delivery_id, source, action, status, attempts, next_attempt_at, received_at
        ) VALUES (?, 'github', 'issues:labeled', 'processing', 1, ?, ?)
      `).run(`delivery-${id}`, "2026-08-13T00:05:00.000Z", `2026-08-12T23:59:5${id === "a" ? 7 : id === "b" ? 8 : 9}.000Z`);
    }

    const verdict = await report({ limit: 2 });

    expect(verdict.clear).toBe(false);
    expect(verdict.truncated).toBe(true);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({ id: "delivery-a" }),
      expect.objectContaining({ id: "delivery-b" }),
    ]);
  });

  it("normalizes nonpositive limits and remains fail closed when output is truncated", async () => {
    setup();
    for (const id of ["a", "b"]) {
      db!.prepare(`
        INSERT INTO webhook_deliveries (
          delivery_id, source, action, status, attempts, next_attempt_at, received_at
        ) VALUES (?, 'github', 'issues:labeled', 'processing', 1, ?, ?)
      `).run(`delivery-${id}`, "2026-08-13T00:05:00.000Z", `2026-08-12T23:59:5${id === "a" ? 7 : 8}.000Z`);
    }

    const verdict = await report({ limit: 0 });

    expect(verdict.clear).toBe(false);
    expect(verdict.truncated).toBe(true);
    expect(verdict.blockers).toEqual([
      expect.objectContaining({ id: "delivery-a" }),
    ]);
  });

  it("caps provider inventory reads before sorting inventory blockers", async () => {
    setup();
    let observedLimit: number | undefined;

    const verdict = await report({
      limit: 2,
      runtime: {
        listLabeledResources: async (limit?: number) => {
          observedLimit = limit;
          return [
            { id: "sandbox-c", state: "started", memory: 8 },
            { id: "sandbox-a", state: "started", memory: 8 },
            { id: "sandbox-b", state: "started", memory: 8 },
          ];
        },
      },
    });

    expect(observedLimit).toBe(3);
    expect(verdict.clear).toBe(false);
    expect(verdict.truncated).toBe(true);
    expect(verdict.blockers.map((blocker) => blocker.id)).toEqual(["sandbox-a", "sandbox-b"]);
  });

  it("canonicalizes known provider resources independently of terminal rows", async () => {
    const { seed, pipelines } = setup();
    const instance = seed("session-bound");
    pipelines.bindRuntimeResource(instance.id, "daytona", "sandbox-bound");
    db!.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE pipeline_instance_id = ?
    `).run(nowIso, instance.id);

    const verdict = await report({
      runtime: {
        listLabeledResources: async () => [
          { id: "sandbox-bound", state: "started", createdAt: "2026-08-12T00:00:00.000Z", memory: 8 },
        ],
      },
      limit: 10,
    });

    expect(canonicalJson(verdict.blockers.map((blocker) => [blocker.kind, blocker.id]))).toBe(
      canonicalJson([
        ["nonterminal_pipeline_instance", instance.id],
        ["bound_active_runtime_resource", "sandbox-bound"],
        ["runtime_inventory_resource", "sandbox-bound"],
      ])
    );
    expect(digestNormalized(JSON.stringify(verdict))).toHaveLength(64);
  });
});
