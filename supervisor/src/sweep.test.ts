import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { SpriteInfo, SpritesClient } from "./sprites.js";
import { createTicketStore, openDb } from "./db.js";
import { runSweep } from "./sweep.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

const cfg = {
  sweepMaxAgeDays: 14,
  orphanGraceMinutes: 5,
} as Config;

describe("runSweep", () => {
  it("expires dead runs/stale tickets, deletes old orphans, and protects provisioning", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const addTicket = (id: string, sandboxId: string | null) =>
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
    addTicket("stale", "sandbox-stale");
    addTicket("timed", "sandbox-timed");
    addTicket("stopped", "known-stopped");
    addTicket("errored", "known-errored");
    addTicket("closed", "known-closed");
    store.setState("stopped", "stopped");
    store.setState("errored", "error");
    store.setState("closed", "closed");
    db.prepare("UPDATE tickets SET created_at = ? WHERE linear_issue_id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "stale"
    );
    store.beginRun({
      issueId: "timed",
      runId: "run-timed",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    store.claimDelivery({ deliveryId: "old-delivery", source: "linear", action: "created" });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?").run("2020-01-01T00:00:00.000Z");

    // Sprites are name-addressed; list() returns handles labeled `ot-*` plus the
    // reused workspaces still owned by stopped/errored/closed tickets.
    const labeled: SpriteInfo[] = [
      { name: "ot-old-1", updated_at: "2020-01-01T00:00:00.000Z" },
      { name: "ot-new-1", updated_at: new Date().toISOString() },
      { name: "known-stopped", updated_at: "2020-01-01T00:00:00.000Z" },
      { name: "known-errored", updated_at: "2020-01-01T00:00:00.000Z" },
      { name: "known-closed", updated_at: "2020-01-01T00:00:00.000Z" },
    ];
    const deleteSprite = vi.fn(async () => undefined);
    const sprites = {
      // readSpooledEvents drains the timed-out sandbox before it is expired.
      exec: vi.fn(async () => ({ exitCode: 0, output: "" })),
      listSprites: vi.fn(async () => labeled),
      deleteSprite,
    } as unknown as SpritesClient;

    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const data = body.query.includes("CommentCreate")
        ? { commentCreate: { success: true } }
        : { agentActivityCreate: { success: true } };
      return Response.json({ data });
    }) as unknown as typeof fetch;

    await runSweep(sprites, store, { accessToken: "oauth", fetch: linearFetch }, cfg);

    expect(store.getRun("run-timed")?.status).toBe("timed_out");
    expect(store.getByIssueId("timed")?.state).toBe("error");
    expect(store.getByIssueId("stale")?.state).toBe("expired");

    const deleted = deleteSprite.mock.calls.map(([name]) => name);
    expect(deleted).toContain("sandbox-stale"); // stale ticket cleanup
    expect(deleted).toContain("ot-old-1"); // aged orphan with no DB row
    expect(deleted).toContain("known-closed"); // closed ticket's workspace
    expect(deleted).not.toContain("ot-new-1"); // inside provisioning grace window
    expect(deleted).not.toContain("known-stopped"); // reusable
    expect(deleted).not.toContain("known-errored"); // reusable

    expect(
      db.prepare("SELECT count(*) AS count FROM webhook_deliveries").get()
    ).toMatchObject({ count: 0 });
  });
});
