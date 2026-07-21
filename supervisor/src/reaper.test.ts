import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { createTicketStore, openDb } from "./db.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";
import { reapStalledRuns } from "./reaper.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

const cfg = { stallTimeoutSeconds: 900 } as Config;

// Sandbox settlement is fire-and-forget (scheduleSandboxSettlement without a
// scheduler). A single macrotask turn drains its microtask chain so the idle
// reconciliation has run before we assert on the fake sandbox.
const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// Minimal Daytona: settlement only touches daytona.get(...).setAutostopInterval
// (reconcileSandboxAutostop idles the sandbox once its run_id is cleared). Mirrors
// sweep.test.ts's `timedSandbox`.
function makeDaytona() {
  const sandbox = {
    id: "sandbox-1",
    autoStopInterval: 60,
    setAutostopInterval: vi.fn(async (minutes: number) => {
      sandbox.autoStopInterval = minutes;
    }),
  };
  const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
  return { daytona, sandbox };
}

// No Linear client: enqueue succeeds, delivery throws and is swallowed by
// tryPostError, so the enqueued error row stays visible in listLinearOutbox().
const makeOutbox = (store: TicketStore) =>
  createLinearOutboxProcessor({ store, getLinearClient: async () => undefined });

const addTicket = (store: TicketStore, id: string, sandboxId: string | null) =>
  store.upsert({
    linear_issue_id: id,
    linear_issue_identifier: id.toUpperCase(),
    linear_session_id: `session-${id}`,
    sandbox_id: sandboxId,
    branch: `ot/${id}`,
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });

describe("reapStalledRuns", () => {
  it("reaps a silent run, settles its sandbox, and leaves fresh runs alone", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const { daytona, sandbox } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    addTicket(store, "stalled", "sandbox-1");
    addTicket(store, "fresh", "sandbox-2");
    store.beginRun({
      issueId: "stalled",
      runId: "run-stalled",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    store.beginRun({
      issueId: "fresh",
      runId: "run-fresh",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // No events for the stalled run → started_at governs; drag it before the cutoff.
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-stalled"
    );

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });
    await flushMicrotasks();

    // The stalled run is reaped: run terminal, ticket errored, run_id cleared.
    expect(store.getRun("run-stalled")?.status).toBe("timed_out");
    const stalledTicket = store.getByIssueId("stalled");
    expect(stalledTicket?.state).toBe("error");
    expect(stalledTicket?.run_id).toBeNull();

    // An error activity was enqueued for the reaped run.
    const rows = store.listLinearOutbox();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as {
      type: string;
      activity: { type: string; body: string };
    };
    expect(payload.type).toBe("activity");
    expect(payload.activity.type).toBe("error");
    expect(payload.activity.body).toContain("reaped");

    // Settlement idled the sandbox (active 60 → idle 5).
    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(5);

    // The freshly-started run is untouched.
    expect(store.getRun("run-fresh")?.status).toBe("running");
    expect(store.getByIssueId("fresh")?.run_id).toBe("run-fresh");
  });

  it("does not reap a run kept alive by a recent sandbox event", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const { daytona } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    addTicket(store, "beating", "sandbox-1");
    store.beginRun({
      issueId: "beating",
      runId: "run-beating",
      taskType: "investigate",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // Started long ago, but a heartbeat landed just now → MAX(event) > cutoff.
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-beating"
    );
    store.insertSandboxEvent({
      eventId: "evt-1",
      runId: "run-beating",
      sandboxId: "sandbox-1",
      kind: "activity",
      payload: JSON.stringify({ type: "thought", ephemeral: true }),
    });

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    expect(store.getRun("run-beating")?.status).toBe("running");
    expect(store.getByIssueId("beating")?.run_id).toBe("run-beating");
    expect(store.listLinearOutbox()).toHaveLength(0);
  });

  it("is a no-op when there are no stalled runs", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const { daytona } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    await expect(
      reapStalledRuns({ daytona, store, linearOutbox, cfg })
    ).resolves.toBeUndefined();
    expect(store.listLinearOutbox()).toHaveLength(0);
  });
});
