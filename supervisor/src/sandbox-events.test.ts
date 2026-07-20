import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { LinearClient } from "./linear.js";
import type { SpritesClient } from "./sprites.js";
import { createTicketStore, openDb } from "./db.js";
import { createServer } from "./server.js";
import { parseSandboxEvent } from "./sandbox-events.js";

const cfg: Config = {
  port: 8080,
  databasePath: ":memory:",
  supervisorUrl: "https://ot.test",
  statusToken: "status-secret",
  installSecret: "install-secret",
  linearWebhookSecret: "linear-secret",
  linearClientId: "client",
  linearClientSecret: "client-secret",
  githubWebhookSecret: "github-secret",
  githubToken: "github-token",
  githubRepo: "owner/repo",
  githubRepoMappings: {},
  githubRepoLabelMappings: {},
  spriteToken: "sprite-token",
  spritesApiUrl: "https://api.sprites.dev",
  payloadTarPath: "/app/payload.tar.gz",
  defaultAgent: "codex",
  claudeCodeOauthToken: "claude-token",
  codexAuthJson: "{}",
  kimiCodeApiKey: "kimi-token",
  baseBranch: "main",
  maxTurns: 200,
  taskTimeout: 7200,
  callbackGraceSeconds: 120,
  devPort: 3000,
  sweepMaxAgeDays: 14,
  orphanGraceMinutes: 5,
  webhookMaxAgeSeconds: 60,
  reviewMaxRounds: 3,
  allowLinearMerge: false,
};

const CALLBACK_TOKEN = "callback-token-1234567890";
const ACTIVITY_EVENT_ID = "11111111-1111-4111-8111-111111111111";

let db: Database.Database | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
});

function seedRunningTicket() {
  db = openDb(":memory:");
  const store = createTicketStore(db);
  store.upsert({
    linear_issue_id: "issue-1",
    linear_issue_identifier: "OT-1",
    linear_session_id: "session-1",
    sandbox_id: "ot-ot-1",
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
    tokenHash: createHash("sha256").update(CALLBACK_TOKEN).digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return store;
}

function activityBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: "activity",
    event_id: ACTIVITY_EVENT_ID,
    run_id: "run-1",
    created_at: "2026-07-18T00:00:00.000Z",
    type: "response",
    body: "Implementation is ready",
    ...overrides,
  });
}

describe("sandbox event contracts", () => {
  it("accepts bounded activity and completion records and rejects unsafe input", () => {
    const parsed = parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: ACTIVITY_EVENT_ID,
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "elicitation",
      body: "Please add a plan",
      unexpected_secret: "raw-secret",
    }));
    expect(parsed).toMatchObject({ type: "elicitation", body: "Please add a plan" });
    expect(parsed).not.toHaveProperty("unexpected_secret");

    expect(() => parseSandboxEvent("{}")).toThrow();
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
});

describe("POST /runs/:id/events", () => {
  function makeApp(store: ReturnType<typeof createTicketStore>) {
    const linearRequests: string[] = [];
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      linearRequests.push(String(init?.body));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } },
      });
    }) as unknown as typeof fetch;
    const linear: LinearClient = { accessToken: "oauth", fetch: linearFetch };
    const app = createServer({
      cfg,
      store,
      sprites: {} as unknown as SpritesClient,
      getLinearClient: async () => linear,
    });
    return { app, linearRequests, linearFetch };
  }

  function post(app: ReturnType<typeof createServer>, body: string, token = CALLBACK_TOKEN) {
    return app.request("/runs/run-1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
  }

  it("rejects a bad callback token with 401 and does not store the event", async () => {
    const store = seedRunningTicket();
    const { app, linearFetch } = makeApp(store);

    const response = await post(app, activityBody(), "wrong-token");

    expect(response.status).toBe(401);
    expect(linearFetch).not.toHaveBeenCalled();
    expect(store.getSandboxEvent(ACTIVITY_EVENT_ID)).toBeUndefined();
  });

  it("returns 404 for an unknown run", async () => {
    const store = seedRunningTicket();
    const { app } = makeApp(store);
    const response = await app.request("/runs/does-not-exist/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CALLBACK_TOKEN}` },
      body: activityBody(),
    });
    expect(response.status).toBe(404);
  });

  it("projects a valid activity into Linear exactly once and dedupes by event_id", async () => {
    const store = seedRunningTicket();
    const { app, linearRequests } = makeApp(store);

    const first = await post(app, activityBody());
    expect(first.status).toBe(200);

    // Replaying the same event_id must not project a second time.
    const second = await post(app, activityBody());
    expect(second.status).toBe(200);

    const activityPosts = linearRequests.filter((body) => body.includes("AgentActivityCreate"));
    expect(activityPosts).toHaveLength(1);
    expect(activityPosts[0]).toContain("Implementation is ready");
    expect(store.getSandboxEvent(ACTIVITY_EVENT_ID)?.status).toBe("processed");
  });

  it("rejects a completion event (completions go to /complete) with 400", async () => {
    const store = seedRunningTicket();
    const { app } = makeApp(store);
    const completion = JSON.stringify({
      version: 1,
      kind: "completion",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:01.000Z",
      token: CALLBACK_TOKEN,
      exit_code: 0,
    });
    const response = await post(app, completion);
    expect(response.status).toBe(400);
  });

  it("rejects an event whose run_id does not match the run with 400", async () => {
    const store = seedRunningTicket();
    const { app } = makeApp(store);
    const response = await post(app, activityBody({ run_id: "other-run" }));
    expect(response.status).toBe(400);
  });

  it("refuses activity once the run is no longer running with 409", async () => {
    const store = seedRunningTicket();
    store.finishRun({ runId: "run-1", status: "completed", ticketState: "active" });
    const { app, linearFetch } = makeApp(store);
    const response = await post(app, activityBody());
    expect(response.status).toBe(409);
    expect(linearFetch).not.toHaveBeenCalled();
  });
});
