import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { parseSandboxEvent } from "./events.js";
import { pollSandboxEvents } from "./event-poller.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

function seedRunningTicket() {
  db = openDb(":memory:");
  const store = createSupervisorStore(db);
  store.upsert({
    ticket_id: "issue-1",
    ticket_reference: "OT-1",
    session_id: "session-1",
    sandbox_id: "sandbox-1",
    branch: "ot/ot-1",
    agent: "codex",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });
  store.beginRun({
    issueId: "issue-1",
    runId: "run-1",
    taskType: "implement",
    tokenHash: createHash("sha256").update("sealed-request-hash").digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return store;
}

describe("sandbox event contracts", () => {
  function stageResultEvent() {
    return JSON.stringify({
      version: 1,
      kind: "stage_result",
      event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      run_id: "run-1",
      created_at: "2026-07-22T00:00:01.000Z",
      pipeline_instance_id: "pipeline-1",
      generation: 1,
      stage_id: "review",
      attempt_id: "attempt-1",
      request_hash: "1".repeat(64),
      outcome: "success",
      result_hash: "2".repeat(64),
      native_session_id: "native-1",
      subject: "c".repeat(40),
      artifacts: [{
        kind: "stage_result",
        schema_version: 1,
        assurance: "semantic_attested",
        subject: "c".repeat(40),
        payload: JSON.stringify({ summary: "Bearer private-stage-token" }),
        hash: "2".repeat(64),
      }],
    });
  }

  it("accepts bounded activity records and rejects unsafe input", () => {
    const parsed = parseSandboxEvent(JSON.stringify({
        version: 1,
        kind: "activity",
        event_id: "11111111-1111-4111-8111-111111111111",
        run_id: "run-1",
        created_at: "2026-07-18T00:00:00.000Z",
        type: "elicitation",
        body: "Please add a plan",
        unexpected_secret: "raw-secret",
      }));
    expect(parsed).toMatchObject({ type: "elicitation", body: "Please add a plan" });
    expect(parsed).not.toHaveProperty("unexpected_secret");

    expect(() => parseSandboxEvent("{}" )).toThrow();
    expect(() =>
      parseSandboxEvent(JSON.stringify({
        version: 1,
        kind: "activity",
        event_id: "../bad",
        run_id: "run-1",
        created_at: "now",
        type: "response",
        body: "ok",
      }))
    ).toThrow();
  });

  it("parses ephemeral activities and plan events, and rejects malformed plans", () => {
    const ephemeral = parseSandboxEvent(
      JSON.stringify({
        version: 1,
        kind: "activity",
        event_id: "33333333-3333-4333-8333-333333333333",
        run_id: "run-1",
        created_at: "2026-07-18T00:00:00.000Z",
        type: "thought",
        body: "running: pnpm test",
        ephemeral: true,
      })
    );
    expect(ephemeral).toMatchObject({ type: "thought", ephemeral: true });

    expect(parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
      injected_agent_text: "must be dropped",
    }))).toEqual({
      version: 1,
      kind: "heartbeat",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
    });

    const plan = parseSandboxEvent(
      JSON.stringify({
        version: 1,
        kind: "plan",
        event_id: "44444444-4444-4444-8444-444444444444",
        run_id: "run-1",
        created_at: "2026-07-18T00:00:00.000Z",
        plan: [
          { content: "Tests", status: "completed" },
          { content: "Build", status: "inProgress" },
        ],
      })
    );
    expect(plan).toMatchObject({
      kind: "plan",
      plan: [
        { content: "Tests", status: "completed" },
        { content: "Build", status: "inProgress" },
      ],
    });

    // Unknown status, empty plan, and a non-boolean ephemeral are all rejected.
    for (const bad of [
      { kind: "plan", plan: [{ content: "x", status: "bogus" }] },
      { kind: "plan", plan: [] },
      { kind: "activity", type: "thought", body: "x", ephemeral: "yes" },
    ]) {
      expect(() =>
        parseSandboxEvent(
          JSON.stringify({
            version: 1,
            event_id: "55555555-5555-4555-8555-555555555555",
            run_id: "run-1",
            created_at: "2026-07-18T00:00:00.000Z",
            ...bad,
          })
        )
      ).toThrow();
    }
  });

  it("renews liveness from a sealed heartbeat without publishing semantic activity", async () => {
    const store = seedRunningTicket();
    const heartbeatAt = "2026-07-22T16:00:00.000Z";
    const heartbeat = Buffer.from(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "77777777-7777-4777-8777-777777777777",
      run_id: "run-1",
      created_at: heartbeatAt,
    }));
    const files = new Map([["/var/lib/openthrottle/heartbeat/heartbeat.json", heartbeat]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } ;
    const postActivity = vi.fn(async () => undefined);

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity,
    });

    expect(postActivity).not.toHaveBeenCalled();
    expect(db!.prepare(
      "SELECT actor_state, last_heartbeat_at FROM runs WHERE id = 'run-1'"
    ).get()).toEqual({ actor_state: "running", last_heartbeat_at: expect.any(String) });
    expect(store.getSandboxEvent("77777777-7777-4777-8777-777777777777")?.status)
      .toBe("processed");
    expect(files.size).toBe(0);
  });

  it("renews child action liveness from a sealed parent heartbeat", async () => {
    const store = seedRunningTicket();
    const heartbeat = Buffer.from(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "88888888-8888-4888-8888-888888888888",
      run_id: "run-1",
      created_at: "2026-07-22T16:00:00.000Z",
      child_action_id: "action-1",
    }));
    const files = new Map([["/var/lib/openthrottle/heartbeat/heartbeat.json", heartbeat]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    };
    const childActions = { renewChildActionLiveness: vi.fn(() => true) };

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) },
      store,
      childActions,
      postActivity: vi.fn(async () => undefined),
    });

    expect(childActions.renewChildActionLiveness).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "run-1",
      actionId: "action-1",
      heartbeatAtIso: expect.any(String),
      leaseUntilIso: expect.any(String),
    }));
    expect(store.getSandboxEvent("88888888-8888-4888-8888-888888888888")?.status)
      .toBe("processed");
  });

  it("does not poll child heartbeats for inactive parent runs", async () => {
    const store = seedRunningTicket();
    db!.prepare("UPDATE runs SET status = 'failed', actor_state = 'settled' WHERE id = 'run-1'").run();
    const heartbeat = Buffer.from(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "99999999-9999-4999-8999-999999999999",
      run_id: "run-1",
      created_at: "2026-07-22T16:00:00.000Z",
      child_action_id: "action-1",
    }));
    const files = new Map([["/var/lib/openthrottle/heartbeat/heartbeat.json", heartbeat]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async () => undefined),
      },
    };
    const childActions = { renewChildActionLiveness: vi.fn(() => true) };

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) },
      store,
      childActions,
      postActivity: vi.fn(async () => undefined),
    });

    expect(childActions.renewChildActionLiveness).not.toHaveBeenCalled();
    expect(store.getSandboxEvent("99999999-9999-4999-8999-999999999999")).toBeUndefined();
  });

  it("rejects an agent-writable outbox event that impersonates the executor heartbeat", async () => {
    const store = seedRunningTicket();
    const forged = Buffer.from(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "66666666-6666-4666-8666-666666666666",
      run_id: "run-1",
      created_at: "2999-01-01T00:00:00.000Z",
    }));
    const files = new Map([["/home/agent/.ot/outbox/forged.json", forged]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async () => [{
          name: "forged.json", path: "/home/agent/.ot/outbox/forged.json",
          size: forged.length, isDir: false,
        }]),
        downloadFile: vi.fn(async (path: string) => files.get(path)),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } ;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity: vi.fn(async () => undefined),
    });

    expect(store.getSandboxEvent("66666666-6666-4666-8666-666666666666")).toBeUndefined();
    expect(db!.prepare(
      "SELECT last_heartbeat_at FROM runs WHERE id = 'run-1'"
    ).get()).toEqual({ last_heartbeat_at: null });
    expect(files.size).toBe(0);
    error.mockRestore();
  });

  it("accepts stage evidence only from the sealed executor path and persists only its fence", async () => {
    const store = seedRunningTicket();
    const raw = Buffer.from(stageResultEvent());
    expect(parseSandboxEvent(raw.toString())).toMatchObject({
      kind: "stage_result",
      pipeline_instance_id: "pipeline-1",
      attempt_id: "attempt-1",
    });
    const sealedPath = "/var/lib/openthrottle/stage-results/attempt-1.json";
    const files = new Map([[sealedPath, raw]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: `${"c".repeat(40)}\n` })),
      },
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } ;
    const postStageResult = vi.fn(async () => undefined);
    const captureAgentAuth = vi.fn(async () => {
      throw new Error("Bearer private-stage-token");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity: vi.fn(async () => undefined),
      postStageResult,
      captureAgentAuth,
    });

    expect(postStageResult).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stage_result", attempt_id: "attempt-1" }),
      "c".repeat(40)
    );
    expect(captureAgentAuth).toHaveBeenCalledWith(
      sandbox,
      expect.objectContaining({ ticket_id: "issue-1" })
    );
    expect(warn).toHaveBeenCalledWith(
      "[sandbox-events] agent auth capture failed:",
      expect.stringContaining("[REDACTED]")
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private-stage-token");
    const stored = store.getSandboxEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!;
    expect(stored.status).toBe("processed");
    expect(JSON.parse(stored.payload)).toEqual({
      version: 1,
      kind: "stage_result",
      event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      run_id: "run-1",
      pipeline_instance_id: "pipeline-1",
      attempt_id: "attempt-1",
      request_hash: "1".repeat(64),
      result_hash: "2".repeat(64),
    });
    expect(stored.payload).not.toContain("artifacts");
    expect(stored.payload).not.toContain("native_session_id");
    expect(stored.payload).not.toContain("private-stage-token");
    expect(files.size).toBe(0);
    warn.mockRestore();
  });

  it("surfaces a repeated sealed stage-result ingestion failure once and keeps retrying", async () => {
    const store = seedRunningTicket();
    const raw = Buffer.from(stageResultEvent().replace(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    ));
    const sealedPath = "/var/lib/openthrottle/stage-results/attempt-1.json";
    const files = new Map([[sealedPath, raw]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: `${"c".repeat(40)}\n` })),
      },
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } ;
    const postActivity = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await pollSandboxEvents({
        runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
        store,
        postActivity,
        postStageResult: vi.fn(async () => {
          throw new Error("Bearer private-stage-token cannot settle");
        }),
      });
      db!.prepare(`
        UPDATE sandbox_events SET next_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE event_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      `).run();
    }

    const stored = store.getSandboxEvent("cccccccc-cccc-4ccc-8ccc-cccccccccccc")!;
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 6,
      last_error: expect.stringContaining("[REDACTED]"),
      ingestion_diagnosed_at: expect.any(String),
    });
    expect(stored.last_error).not.toContain("private-stage-token");
    expect(postActivity).toHaveBeenCalledTimes(1);
    expect(postActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        body: expect.stringContaining("The supervisor cannot ingest the stage result:"),
      }),
      expect.objectContaining({ issueId: "issue-1" })
    );
    expect(files.has(sealedPath)).toBe(true);
    error.mockRestore();
  });

  it("keeps retrying diagnostic publication when the first diagnostic activity fails", async () => {
    const store = seedRunningTicket();
    const raw = Buffer.from(stageResultEvent().replace(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    ));
    const sealedPath = "/var/lib/openthrottle/stage-results/attempt-1.json";
    const files = new Map([[sealedPath, raw]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: `${"d".repeat(40)}\n` })),
      },
      fs: {
        listFiles: vi.fn(async (directory: string) => [...files.entries()]
          .filter(([path]) => path.startsWith(`${directory}/`))
          .map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } ;
    const postActivity = vi.fn()
      .mockRejectedValueOnce(new Error("Linear GraphQL error: Bearer private-stage-token"))
      .mockResolvedValue(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await pollSandboxEvents({
        runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
        store,
        postActivity,
        postStageResult: vi.fn(async () => {
          throw new Error("stage result attempt fence mismatch");
        }),
      });
      db!.prepare(`
        UPDATE sandbox_events SET next_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE event_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      `).run();
    }

    expect(store.getSandboxEvent("dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toMatchObject({
      status: "failed",
      attempts: 5,
      ingestion_diagnosed_at: null,
      last_error: "Error: stage result attempt fence mismatch",
    });

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity,
      postStageResult: vi.fn(async () => {
        throw new Error("stage result attempt fence mismatch");
      }),
    });

    const stored = store.getSandboxEvent("dddddddd-dddd-4ddd-8ddd-dddddddddddd")!;
    expect(stored).toMatchObject({
      status: "failed",
      attempts: 6,
      ingestion_diagnosed_at: expect.any(String),
    });
    expect(postActivity).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("failed to publish ingestion diagnostic"),
      expect.stringContaining("[REDACTED]")
    );
    expect(error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("private-stage-token")
    );
    expect(files.has(sealedPath)).toBe(true);
    error.mockRestore();
  });

  it("deletes an agent-writable outbox event that impersonates a stage result", async () => {
    const store = seedRunningTicket();
    const raw = Buffer.from(stageResultEvent().replace(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ));
    const path = "/home/agent/.ot/outbox/forged-stage.json";
    const files = new Map([[path, raw]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async (directory: string) => directory === "/home/agent/.ot/outbox"
          ? [{ name: "forged-stage.json", path, size: raw.length, isDir: false }]
          : []),
        downloadFile: vi.fn(async (remotePath: string) => files.get(remotePath)!),
        deleteFile: vi.fn(async (remotePath: string) => files.delete(remotePath)),
      },
    } ;
    const postStageResult = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity: vi.fn(async () => undefined),
      postStageResult,
    });

    expect(postStageResult).not.toHaveBeenCalled();
    expect(store.getSandboxEvent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeUndefined();
    expect(files.size).toBe(0);
    error.mockRestore();
  });

  it("forwards structured action verb/parameter/result to Linear", async () => {
    const store = seedRunningTicket();
    const action = JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "99999999-9999-4999-8999-999999999999",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:03.000Z",
      type: "action",
      action: "Ran",
      parameter: "pnpm test",
      result: "583 passed",
      body: "Ran: pnpm test → 583 passed",
    });
    const files = new Map([["/home/agent/.ot/outbox/004.json", Buffer.from(action)]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        listFiles: vi.fn(async () =>
          [...files.entries()].map(([path, value]) => ({
            name: path.split("/").at(-1),
            path,
            size: value.length,
            isDir: false,
          }))
        ),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => {
          files.delete(path);
        }),
      },
    } ;
    const runtime = { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ;
    const postActivity = vi.fn(async () => undefined);

    await pollSandboxEvents({
      runtime,
      store,
      postActivity,
    });

    expect(postActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "action",
        action: "Ran",
        parameter: "pnpm test",
        result: "583 passed",
      }),
      expect.anything()
    );
  });

  it("forwards activity from action-scoped loop outboxes", async () => {
    const store = seedRunningTicket();
    const action = JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "55555555-5555-4555-8555-555555555555",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:04.000Z",
      type: "thought",
      body: "loop action progress",
    });
    const eventPath = "/var/lib/openthrottle/loop-actions/attempt-child/action-1/outbox/001.json";
    const files = new Map([[eventPath, Buffer.from(action)]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        listFiles: vi.fn(async (path: string) => {
          if (path === "/var/lib/openthrottle/loop-actions") {
            return [{ name: "attempt-child", path: "/var/lib/openthrottle/loop-actions/attempt-child", size: 0, isDir: true }];
          }
          if (path === "/var/lib/openthrottle/loop-actions/attempt-child") {
            return [{ name: "action-1", path: "/var/lib/openthrottle/loop-actions/attempt-child/action-1", size: 0, isDir: true }];
          }
          if (path === "/var/lib/openthrottle/loop-actions/attempt-child/action-1/outbox") {
            return [{ name: "001.json", path: eventPath, size: action.length, isDir: false }];
          }
          return [];
        }),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => {
          files.delete(path);
        }),
      },
    } ;
    const runtime = { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ;
    const postActivity = vi.fn(async () => undefined);

    await pollSandboxEvents({
      runtime,
      store,
      postActivity,
    });

    expect(postActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thought", body: "loop action progress" }),
      expect.anything()
    );
    expect(files.size).toBe(0);
  });

  it("skips unsafe action-scoped loop outbox names", async () => {
    const store = seedRunningTicket();
    const action = JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "66666666-6666-4666-8666-666666666666",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:05.000Z",
      type: "thought",
      body: "valid loop action progress",
    });
    const eventPath = "/var/lib/openthrottle/loop-actions/attempt-child/action-1/outbox/001.json";
    const files = new Map([[eventPath, Buffer.from(action)]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        listFiles: vi.fn(async (path: string) => {
          if (path === "/var/lib/openthrottle/loop-actions") {
            return [
              { name: "../escape", path: "/var/lib/openthrottle/loop-actions/../escape", size: 0, isDir: true },
              { name: "attempt-child", path: "/var/lib/openthrottle/loop-actions/attempt-child", size: 0, isDir: true },
            ];
          }
          if (path === "/var/lib/openthrottle/loop-actions/attempt-child") {
            return [
              { name: "action/escape", path: "/var/lib/openthrottle/loop-actions/attempt-child/action/escape", size: 0, isDir: true },
              { name: "action-1", path: "/var/lib/openthrottle/loop-actions/attempt-child/action-1", size: 0, isDir: true },
            ];
          }
          if (path === "/var/lib/openthrottle/loop-actions/attempt-child/action-1/outbox") {
            return [{ name: "001.json", path: eventPath, size: action.length, isDir: false }];
          }
          return [];
        }),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => {
          files.delete(path);
        }),
      },
    } ;
    const runtime = { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ;
    const postActivity = vi.fn(async () => undefined);

    await pollSandboxEvents({
      runtime,
      store,
      postActivity,
    });

    expect(sandbox.fs.listFiles).not.toHaveBeenCalledWith("/var/lib/openthrottle/loop-actions/../escape");
    expect(sandbox.fs.listFiles).not.toHaveBeenCalledWith("/var/lib/openthrottle/loop-actions/attempt-child/action/escape/outbox");
    expect(postActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thought", body: "valid loop action progress" }),
      expect.anything()
    );
    expect(files.size).toBe(0);
  });

  it("forwards a plan event to the session-update handler", async () => {
    const store = seedRunningTicket();
    const planEvent = JSON.stringify({
      version: 1,
      kind: "plan",
      event_id: "88888888-8888-4888-8888-888888888888",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:02.000Z",
      plan: [
        { content: "Run tests", status: "completed" },
        { content: "Build", status: "inProgress" },
      ],
    });
    const files = new Map([["/home/agent/.ot/outbox/003.json", Buffer.from(planEvent)]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        listFiles: vi.fn(async () =>
          [...files.entries()].map(([path, value]) => ({
            name: path.split("/").at(-1),
            path,
            size: value.length,
            isDir: false,
          }))
        ),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => {
          files.delete(path);
        }),
      },
    } ;
    const runtime = { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ;
    const postSessionUpdate = vi.fn(async () => undefined);

    await pollSandboxEvents({
      runtime,
      store,
      postActivity: vi.fn(async () => undefined),
      postSessionUpdate,
    });

    expect(postSessionUpdate).toHaveBeenCalledOnce();
    expect(postSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        issueId: "issue-1",
        plan: [
          { content: "Run tests", status: "completed" },
          { content: "Build", status: "inProgress" },
        ],
      })
    );
    expect(files.size).toBe(0);
  });

  it("returns a sandbox to idle when a stale poll reactivates it after completion", async () => {
    const store = seedRunningTicket();
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const listFiles = vi.fn(async () => []);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      fs: { listFiles },
    } ;
    const setActive = vi.fn(async () => {
      markActiveStarted();
      await activeReleased;
    });
    const setIdle = vi.fn(async () => undefined);
    const polling = pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive, setIdle } ,
      store,
      postActivity: vi.fn(),
    });

    await activeStarted;
    store.finishRun({ runId: "run-1", status: "completed", ticketState: "active" });
    releaseActive();
    await polling;

    expect(setActive).toHaveBeenCalledWith("sandbox-1");
    expect(setIdle).toHaveBeenCalledWith("sandbox-1");
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("discards a stale event without posting it into the current run", async () => {
    const store = seedRunningTicket();
    const stale = Buffer.from(JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "33333333-3333-4333-8333-333333333333",
      run_id: "old-run",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "response",
      body: "stale",
    }));
    const deleteFile = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async () => [{
          name: "stale.json", path: "/home/agent/.ot/outbox/stale.json", size: stale.length, isDir: false,
        }]),
        downloadFile: vi.fn(async (path: string) => {
          if (path === "/var/lib/openthrottle/heartbeat/heartbeat.json") {
            throw new Error("not found");
          }
          return stale;
        }),
        deleteFile,
      },
    } ;
    const postActivity = vi.fn();

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity,
    });

    expect(postActivity).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it("does not publish late activity from a superseded session into the new session", async () => {
    const store = seedRunningTicket();
    store.upsert({
      ...store.getByIssueId("issue-1")!,
      session_id: "session-2",
      sandbox_id: "sandbox-1",
      state: "active",
    });
    const late = Buffer.from(JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "77777777-7777-4777-8777-777777777777",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "response",
      body: "late old-session response",
    }));
    const deleteFile = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        listFiles: vi.fn(async () => [{
          name: "late.json", path: "/home/agent/.ot/outbox/late.json", size: late.length, isDir: false,
        }]),
        downloadFile: vi.fn(async (path: string) => {
          if (path === "/var/lib/openthrottle/heartbeat/heartbeat.json") {
            throw new Error("not found");
          }
          return late;
        }),
        deleteFile,
      },
    } ;
    const postActivity = vi.fn();

    await pollSandboxEvents({
      runtime: { getWorkspace: vi.fn(async () => sandbox), setActive: vi.fn(async () => undefined), setIdle: vi.fn(async () => undefined) } ,
      store,
      postActivity,
    });

    expect(postActivity).not.toHaveBeenCalled();
    expect(store.getSandboxEvent("77777777-7777-4777-8777-777777777777")?.status)
      .toBe("processed");
    expect(deleteFile).toHaveBeenCalledOnce();
  });
});
