import type { Daytona, Sandbox } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createTicketStore, openDb } from "./db.js";
import { parseSandboxEvent, pollSandboxEvents } from "./sandbox-events.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

function seedRunningTicket() {
  db = openDb(":memory:");
  const store = createTicketStore(db);
  store.upsert({
    linear_issue_id: "issue-1",
    linear_issue_identifier: "OT-1",
    linear_session_id: "session-1",
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
    tokenHash: createHash("sha256").update("callback-token-123").digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return store;
}

describe("sandbox event contracts", () => {
  it("accepts bounded activity and completion records and rejects unsafe input", () => {
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
    } as unknown as Sandbox;
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const postSessionUpdate = vi.fn(async () => undefined);

    await pollSandboxEvents({
      daytona,
      store,
      postActivity: vi.fn(async () => undefined),
      finishCompletion: vi.fn(async () => ({ status: 200 })),
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

  it("posts activities once, finalizes completion once, and removes processed files", async () => {
    const store = seedRunningTicket();
    const activity = JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "11111111-1111-4111-8111-111111111111",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "elicitation",
      body: "Please add a plan",
    });
    const completion = JSON.stringify({
      version: 1,
      kind: "completion",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
      token: "callback-token-123",
      exit_code: 0,
      pr_url: "https://github.com/owner/repo/pull/1",
      final_response: "Finished the implementation.",
    });
    const files = new Map([
      ["/home/agent/.ot/outbox/001.json", Buffer.from(activity)],
      ["/home/agent/.ot/outbox/002.json", Buffer.from(completion)],
    ]);
    let failDeleteOnce = true;
    const setAutostopInterval = vi.fn(async (minutes: number) => {
      sandbox.autoStopInterval = minutes;
    });
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval,
      process: {
        executeCommand: vi.fn(async () => ({
          exitCode: 0,
          result: "safe ghp_abcdefghijklmnop callback-token-123",
        })),
      },
      fs: {
        listFiles: vi.fn(async () =>
          [...files.entries()].map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))
        ),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => {
          if (path.endsWith("001.json") && failDeleteOnce) {
            failDeleteOnce = false;
            throw new Error("temporary delete failure");
          }
          files.delete(path);
        }),
      },
    } as unknown as Sandbox;
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const postActivity = vi.fn(async () => undefined);
    const finishCompletion = vi.fn(async () => ({ status: 200 }));

    await pollSandboxEvents({ daytona, store, postActivity, finishCompletion });
    await pollSandboxEvents({ daytona, store, postActivity, finishCompletion });

    expect(postActivity).toHaveBeenCalledOnce();
    expect(postActivity).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", type: "elicitation", body: "Please add a plan" }),
      expect.objectContaining({ issueId: "issue-1", event_id: "11111111-1111-4111-8111-111111111111" })
    );
    expect(finishCompletion).toHaveBeenCalledOnce();
    expect(finishCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        token: "callback-token-123",
        exitCode: 0,
        finalResponse: "Finished the implementation.",
        logTail: "safe [REDACTED] [REDACTED]",
      })
    );
    expect(setAutostopInterval).toHaveBeenCalledOnce();
    expect(setAutostopInterval).toHaveBeenCalledWith(60);
    expect(files.size).toBe(0);
    expect(store.getSandboxEvent("11111111-1111-4111-8111-111111111111")?.status)
      .toBe("processed");
  });

  it("captures rotated agent auth before finishing the run", async () => {
    const store = seedRunningTicket();
    const completion = Buffer.from(JSON.stringify({
      version: 1,
      kind: "completion",
      event_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
      token: "callback-token-123",
      exit_code: 0,
    }));
    const files = new Map([["/home/agent/.ot/outbox/001.json", completion]]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: "" })) },
      fs: {
        listFiles: vi.fn(async () =>
          [...files.entries()].map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))
        ),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } as unknown as Sandbox;
    const order: string[] = [];
    const captureAgentAuth = vi.fn(async () => {
      order.push("capture");
    });
    const finishCompletion = vi.fn(async () => {
      order.push("finish");
      return { status: 200 };
    });

    await pollSandboxEvents({
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      store,
      postActivity: vi.fn(async () => undefined),
      finishCompletion,
      captureAgentAuth,
    });

    expect(captureAgentAuth).toHaveBeenCalledOnce();
    expect(captureAgentAuth).toHaveBeenCalledWith(sandbox, expect.objectContaining({ agent: "codex" }));
    expect(order).toEqual(["capture", "finish"]);
  });

  it("retries a failed activity before processing the completion behind it", async () => {
    const store = seedRunningTicket();
    const activityId = "55555555-5555-4555-8555-555555555555";
    const activity = Buffer.from(JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: activityId,
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "response",
      body: "Implementation is ready",
    }));
    const completion = Buffer.from(JSON.stringify({
      version: 1,
      kind: "completion",
      event_id: "66666666-6666-4666-8666-666666666666",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
      token: "callback-token-123",
      exit_code: 0,
    }));
    const files = new Map([
      ["/home/agent/.ot/outbox/001.json", activity],
      ["/home/agent/.ot/outbox/002.json", completion],
    ]);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 60,
      fs: {
        listFiles: vi.fn(async () =>
          [...files.entries()].map(([path, value]) => ({
            name: path.split("/").at(-1), path, size: value.length, isDir: false,
          }))
        ),
        downloadFile: vi.fn(async (path: string) => files.get(path)!),
        deleteFile: vi.fn(async (path: string) => files.delete(path)),
      },
    } as unknown as Sandbox;
    const postActivity = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Linear unavailable"))
      .mockResolvedValue(undefined);
    const finishCompletion = vi.fn(async () => ({ status: 200 }));
    const params = {
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      store,
      postActivity,
      finishCompletion,
    };

    await pollSandboxEvents(params);

    expect(postActivity).toHaveBeenCalledOnce();
    expect(finishCompletion).not.toHaveBeenCalled();
    expect(store.getSandboxEvent(activityId)).toMatchObject({
      status: "failed",
      payload: expect.not.stringContaining("callback-token-123"),
    });

    db!.prepare("UPDATE sandbox_events SET next_attempt_at = ? WHERE event_id = ?")
      .run("2000-01-01T00:00:00.000Z", activityId);
    await pollSandboxEvents(params);

    expect(postActivity).toHaveBeenCalledTimes(2);
    expect(finishCompletion).toHaveBeenCalledOnce();
    expect(store.getSandboxEvent(activityId)?.status).toBe("processed");
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
    const autostopIntervals: number[] = [];
    const listFiles = vi.fn(async () => []);
    const sandbox = {
      id: "sandbox-1",
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval: vi.fn(async (minutes: number) => {
        autostopIntervals.push(minutes);
        if (minutes === 60) {
          markActiveStarted();
          await activeReleased;
        }
        sandbox.autoStopInterval = minutes;
      }),
      fs: { listFiles },
    } as unknown as Sandbox;
    const polling = pollSandboxEvents({
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      store,
      postActivity: vi.fn(),
      finishCompletion: vi.fn(),
    });

    await activeStarted;
    store.finishRun({ runId: "run-1", status: "completed", ticketState: "active" });
    releaseActive();
    await polling;

    expect(autostopIntervals).toEqual([60, 5]);
    expect(sandbox.autoStopInterval).toBe(5);
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
        downloadFile: vi.fn(async () => stale),
        deleteFile,
      },
    } as unknown as Sandbox;
    const postActivity = vi.fn();

    await pollSandboxEvents({
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      store,
      postActivity,
      finishCompletion: vi.fn(),
    });

    expect(postActivity).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it("does not publish late activity from a superseded session into the new session", async () => {
    const store = seedRunningTicket();
    store.upsert({
      ...store.getByIssueId("issue-1")!,
      linear_session_id: "session-2",
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
        downloadFile: vi.fn(async () => late),
        deleteFile,
      },
    } as unknown as Sandbox;
    const postActivity = vi.fn();

    await pollSandboxEvents({
      daytona: { get: vi.fn(async () => sandbox) } as unknown as Daytona,
      store,
      postActivity,
      finishCompletion: vi.fn(),
    });

    expect(postActivity).not.toHaveBeenCalled();
    expect(store.getSandboxEvent("77777777-7777-4777-8777-777777777777")?.status)
      .toBe("processed");
    expect(deleteFile).toHaveBeenCalledOnce();
  });
});
