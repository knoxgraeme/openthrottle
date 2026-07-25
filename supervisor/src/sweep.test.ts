import type { Daytona, Sandbox } from "@daytona/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./app/config.js";
import { createSupervisorStore } from "./persistence/store.js";
import { openDb } from "./persistence/database.js";
import { createLinearOutboxProcessor } from "./providers/linear/outbox.js";
import { createPipelineStore } from "./persistence/pipeline/create-store.js";
import { runSweep } from "./sweep.js";

describe("runSweep", () => {
  const db = openDb(":memory:");
  afterEach(() => db.close());

  it("deletes old orphan runtimes, protects active bindings, and prunes deliveries", async () => {
    const pipelines = createPipelineStore(db);
    const store = createSupervisorStore(db, pipelines);
    store.upsertUnpinned({
      linear_issue_id: "active",
      linear_issue_identifier: "ACTIVE",
      linear_session_id: "session-active",
      sandbox_id: "known-active",
      branch: "ot/active",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    store.claimDelivery({ deliveryId: "old-delivery", source: "linear", action: "created" });
    db.prepare("UPDATE webhook_deliveries SET received_at = ?")
      .run("2020-01-01T00:00:00.000Z");

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
    const knownActive = {
      id: "known-active",
      createdAt: "2020-01-01T00:00:00.000Z",
      labels: { ticket: "ACTIVE" },
    } as unknown as Sandbox;
    const remove = vi.fn(async () => undefined);
    const daytona = {
      delete: remove,
      list: async function* () {
        yield oldOrphan;
        yield newOrphan;
        yield knownActive;
      },
    } as unknown as Daytona;
    const outbox = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => undefined,
    });

    await runSweep(
      daytona,
      store,
      { orphanGraceMinutes: 5 } as Config,
      pipelines,
      outbox
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(oldOrphan, 60, false);
    expect(remove).not.toHaveBeenCalledWith(newOrphan, 60, false);
    expect(remove).not.toHaveBeenCalledWith(knownActive, 60, false);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
  });
});
