import type { Daytona, Sandbox } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
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
    addTicket("timed", null);
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

    const staleSandbox = { id: "sandbox-stale", delete: vi.fn(async () => undefined) };
    const oldOrphan = {
      id: "old-orphan",
      createdAt: "2020-01-01T00:00:00.000Z",
      labels: { ticket: "OLD-1" },
    } as unknown as Sandbox;
    const newOrphan = {
      id: "new-orphan",
      createdAt: new Date().toISOString(),
      labels: { ticket: "NEW-1" },
    } as unknown as Sandbox;
    const deleteOrphan = vi.fn(async () => undefined);
    const daytona = {
      get: vi.fn(async () => staleSandbox),
      delete: deleteOrphan,
      list: async function* () {
        yield oldOrphan;
        yield newOrphan;
      },
    } as unknown as Daytona;
    const linearFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const data = body.query.includes("CommentCreate")
        ? { commentCreate: { success: true } }
        : { agentActivityCreate: { success: true } };
      return Response.json({ data });
    }) as unknown as typeof fetch;

    await runSweep(daytona, store, { accessToken: "oauth", fetch: linearFetch }, cfg);

    expect(store.getRun("run-timed")?.status).toBe("timed_out");
    expect(store.getByIssueId("timed")?.state).toBe("error");
    expect(store.getByIssueId("stale")?.state).toBe("expired");
    expect(staleSandbox.delete).toHaveBeenCalledOnce();
    expect(deleteOrphan).toHaveBeenCalledOnce();
    expect(deleteOrphan).toHaveBeenCalledWith(oldOrphan, 60, false);
    expect(
      db.prepare("SELECT count(*) AS count FROM webhook_deliveries").get()
    ).toMatchObject({ count: 0 });
  });
});
