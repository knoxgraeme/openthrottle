import { afterEach, describe, expect, it } from "vitest";
import type { AttemptState } from "@openthrottle/contracts";
import { SqliteKernelInboxStore } from "./kernel-inbox-store.js";
import { SqliteKernelProjectionStore } from "./kernel-projection-store.js";
import {
  KERNEL_FIXTURE_BUNDLE_HASH,
  KERNEL_FIXTURE_NOW,
  KERNEL_FIXTURE_REQUEST_HASH,
  KERNEL_FIXTURE_SUBJECT,
  freshKernelFixture,
  seedKernelAttempt,
  seedKernelRun,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  seedKernelRun({ db: fixture.db });
  return {
    fixture,
    projection: new SqliteKernelProjectionStore({ db: fixture.db }),
  };
}

function insertDecision(fixture: FreshKernelFixture, id = "decision-1", sequence = 1): void {
  fixture.db.prepare(`
    INSERT INTO records (
      id, pipeline_run_id, sequence, record_hash, kind, semantic_key,
      payload_schema, inline_payload, reducer, input_record_ids_json,
      input_record_count, created_at
    ) VALUES (?, 'run-1', ?, ?, 'decision', ?, 'decision/v1', '{}',
      'test-reducer@1', '[]', 0, ?)
  `).run(id, sequence, "c".repeat(64), `decision:${id}`, KERNEL_FIXTURE_NOW);
}

function insertEffect(
  fixture: FreshKernelFixture,
  input: {
    id?: string;
    kind?: string;
    target?: string;
    sequence?: number;
  } = {},
): void {
  const id = input.id ?? "effect-1";
  const kind = input.kind ?? "daytona/create-sandbox@1";
  const target = input.target ?? "workspace-1";
  const sequence = input.sequence ?? (fixture.db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM records WHERE pipeline_run_id = 'run-1'
  `).get() as { sequence: number }).sequence;
  const decisionId = `decision-${id}`;
  insertDecision(fixture, decisionId, sequence);
  fixture.db.prepare(`
    INSERT INTO effects (
      id, pipeline_run_id, decision_record_id, decision_record_kind, kind,
      idempotency_key, target, subject, payload_schema, inline_payload,
      intent_hash, status, version, attempt_count, available_at, created_at, updated_at
    ) VALUES (
      ?, 'run-1', ?, 'decision', ?,
      ?, ?, ?, ?, '{}',
      ?, 'pending', 0, 0, ?, ?, ?
    )
  `).run(
    id,
    decisionId,
    kind,
    `effect-key-${id}`,
    target,
    KERNEL_FIXTURE_SUBJECT,
    kind,
    "e".repeat(64),
    KERNEL_FIXTURE_NOW,
    KERNEL_FIXTURE_NOW,
    KERNEL_FIXTURE_NOW,
  );
}

describe("SqliteKernelProjectionStore", () => {
  it("distinguishes every shared Attempt status without mode-specific tables", () => {
    const { fixture, projection } = setup();
    const statuses: AttemptState[] = [
      "pending", "running", "work_complete", "result_pending", "recorded", "settled",
      "needs_human", "failed", "canceled", "superseded",
    ];
    for (const [index, status] of statuses.entries()) {
      seedKernelAttempt({
        db: fixture.db,
        id: `attempt-${String(index).padStart(2, "0")}`,
        status,
        stage_id: `stage-${status}`,
      });
    }
    insertEffect(fixture);
    const status = projection.getStatus("run-1", 20)!;
    expect(status.status).toBe("running");
    expect(status.whose_move).toBe("working");
    expect(status.truncated).toBe(false);
    for (const attemptStatus of statuses) {
      expect(status.attempt_status_counts[attemptStatus]).toBe(1);
    }
    expect(status.attempts.find(({ status: value }) => value === "result_pending"))
      .toMatchObject({
        result_correction_count: 1,
        pending_diagnostic_count: 1,
        native_session_bound: true,
      });
    expect(status.effects).toEqual([
      expect.objectContaining({
        id: "effect-1",
        kind: "daytona/create-sandbox@1",
        status: "pending",
      }),
    ]);
  });

  it("returns bounded cross-primitive logs with stable cursors", () => {
    const { fixture, projection } = setup();
    seedKernelAttempt({ db: fixture.db, id: "attempt-log", status: "running" });
    insertEffect(fixture);
    const inbox = new SqliteKernelInboxStore({
      db: fixture.db,
      blob_store: fixture.blobs,
      now: () => KERNEL_FIXTURE_NOW,
    });
    inbox.ingest({
      source_provider: "runtime",
      delivery_id: "event-log",
      kind: "runtime/observation@1",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-log",
      generation: 0,
      event_group_key: "runtime:event-log",
      delivery_attempt: 1,
      subject: KERNEL_FIXTURE_SUBJECT,
      payload_schema: "runtime.observation/v1",
      payload: { state: "running" },
    });

    const first = projection.listLog({ pipeline_run_id: "run-1", limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    const second = projection.listLog({
      pipeline_run_id: "run-1",
      after: first.next_cursor!,
      limit: 20,
    });
    const combined = [...first.entries, ...second.entries];
    expect(new Set(combined.map(({ kind }) => kind))).toEqual(
      new Set(["run", "attempt", "record", "effect", "inbox"]),
    );
    expect(new Set(combined.map(({ id }) => id)).size).toBe(combined.length);
  });

  it("surfaces a repeatedly indeterminate effect as waiting on the operator", () => {
    const { fixture, projection } = setup();
    seedKernelAttempt({ db: fixture.db, id: "attempt-waiting", status: "work_complete" });
    insertEffect(fixture);
    fixture.db.prepare(`
      UPDATE effects
      SET status = 'unknown', attempt_count = 24,
        unknown_detail = 'provider outcome remains indeterminate'
      WHERE id = 'effect-1'
    `).run();

    const status = projection.getStatus("run-1")!;
    expect(status.status).toBe("running");
    expect(status.whose_move).toBe("waiting_on_operator");
    expect(status.effects[0]).toMatchObject({
      id: "effect-1",
      status: "unknown",
      attempt_count: 24,
      detail: "provider outcome remains indeterminate",
    });
  });

  it("names every durable live lifecycle for operator diagnosis", () => {
    const { fixture, projection } = setup();
    seedKernelAttempt({
      db: fixture.db,
      id: "attempt-running",
      status: "running",
      version: 2,
      native_session_id: "session-running",
      lease: {
        id: "attempt-lease",
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "2026-08-20T12:05:00.000Z",
        started: true,
      },
    });
    seedKernelAttempt({ db: fixture.db, id: "attempt-correction", status: "result_pending" });
    insertEffect(fixture);
    fixture.db.prepare(`
      INSERT INTO leases (
        lease_key, purpose, owner_id, lease_id, expires_at, version, metadata_json, updated_at
      ) VALUES ('maintenance-test', 'operator', 'owner-1', 'global-lease',
        '2026-08-20T12:05:00.000Z', 0, '{}', ?)
    `).run(KERNEL_FIXTURE_NOW);

    const snapshot = projection.collectActiveWork();
    expect(snapshot.truncated).toBe(false);
    expect(new Set(snapshot.items.map(({ key }) => key))).toEqual(new Set([
      "run:run-1",
      "attempt:attempt-running",
      "attempt:attempt-correction",
      "correction:attempt-correction",
      "effect:effect-1",
      "lease:attempt-lease",
      "lease:global-lease",
      "runtime_resource:effect-1",
    ]));
  });

  it("projects only exact Daytona lifecycle effects as runtime resources", () => {
    const { fixture, projection } = setup();
    const kinds = [
      "daytona/create-sandbox@1",
      "daytona/start-sandbox@1",
      "daytona/stop-sandbox@1",
      "daytona/cleanup-sandbox@1",
    ];
    for (const [index, kind] of kinds.entries()) {
      insertEffect(fixture, {
        id: `daytona-${index}`,
        kind,
        target: "workspace-1",
        sequence: index + 1,
      });
    }
    insertEffect(fixture, {
      id: "runtime-substring",
      kind: "example/runtime-observation@1",
      sequence: 5,
    });
    insertEffect(fixture, {
      id: "workspace-substring",
      kind: "example/workspace-note@1",
      sequence: 6,
    });

    expect(projection.collectActiveWork().items
      .filter(({ kind }) => kind === "runtime_resource")
      .map(({ id }) => id))
      .toEqual(["daytona-0", "daytona-1", "daytona-2", "daytona-3"]);
  });

  it("does not expose raw request, result, or inbox payloads through projections", () => {
    const { fixture, projection } = setup();
    seedKernelAttempt({ db: fixture.db, id: "attempt-private", status: "pending" });
    const serialized = JSON.stringify(projection.getStatus("run-1"));
    expect(serialized).not.toContain("Task for run-1");
    expect(serialized).not.toContain(KERNEL_FIXTURE_REQUEST_HASH);
    expect(serialized).toContain(KERNEL_FIXTURE_BUNDLE_HASH);
  });
});
