import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../persistence/database.js";
import { createSupervisorStore, type SupervisorStore } from "../../persistence/store.js";
import { createLinearOutboxProcessor } from "./outbox.js";
import type { LinearOutboxRecord } from "../../persistence/delivery-store.js";

describe("Linear outbox retry bounding", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  afterEach(() => db?.close());

  function setup() {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
    store.upsertUnpinned({
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  }

  const getLinearOutbox = (id: string): LinearOutboxRecord | undefined =>
    db.prepare("SELECT * FROM control_outbox WHERE id = ?").get(id) as LinearOutboxRecord | undefined;

  // Never expire the lease mid-test and always look claimable "now".
  const forceClaimable = (id: string) =>
    db.prepare("UPDATE control_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

  it("dead-letters a persistently failing activity after the attempt cap instead of retrying forever", async () => {
    setup();
    const row = store.enqueueLinearOutbox({
      id: "linear-malformed",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: JSON.stringify({ type: "activity", activity: { sessionId: "session-1", type: "thought", body: "hello" } }),
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ errors: [{ message: "Linear rejected the activity: schema violation" }] })
    ) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      forceClaimable(row.id);
      await processor.drain(50);
      const current = getLinearOutbox(row.id)!;
      expect(current.attempts).toBe(attempt);
      if (attempt < 10) {
        expect(current.status).toBe("failed");
      } else {
        expect(current.status).toBe("dead");
      }
    }
  });

  it("delivers a later same-session row via the real deliver()/drain() path once the blocking row goes dead", async () => {
    setup();
    const blocking = store.enqueueLinearOutbox({
      id: "linear-malformed",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "activity",
      payload: JSON.stringify({ type: "activity", activity: { sessionId: "session-1", type: "thought", body: "hello" } }),
    });
    const terminalReceipt = store.enqueueLinearOutbox({
      id: "control-terminal-receipt",
      sessionId: "session-1",
      issueId: "issue-1",
      kind: "pipeline_receipt",
      payload: JSON.stringify({
        type: "pipeline_receipt",
        publication: { body: "The job shipped." },
      }),
    });
    expect(blocking.sequence).toBeLessThan(terminalReceipt.sequence);

    const deliveredActivityIds: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { input?: { id?: string } };
      };
      if (request.variables?.input?.id === blocking.id) {
        return Response.json({ errors: [{ message: "Linear rejected the activity: schema violation" }] });
      }
      deliveredActivityIds.push(String(request.variables?.input?.id));
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "activity-delivered" } } },
      });
    }) as unknown as typeof fetch;
    const processor = createLinearOutboxProcessor({
      store,
      getLinearClient: async () => ({ accessToken: "oauth", fetch: fetchMock }),
    });

    // Drive the blocking row to attempts exhaustion (dead) via the real
    // deliver()/drain() path. Until it goes dead, the terminal receipt behind
    // it in the same session must never be claimed (head-of-line blocking).
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      forceClaimable(blocking.id);
      await processor.drain(50);
    }
    expect(getLinearOutbox(blocking.id)?.status).toBe("dead");
    expect(deliveredActivityIds).toHaveLength(0);
    expect(getLinearOutbox(terminalReceipt.id)?.status).toBe("pending");

    // Now that the blocking row is dead (not pending/processing/failed), the
    // terminal receipt is claimable and delivers normally.
    await processor.drain(50);
    expect(deliveredActivityIds).toEqual([terminalReceipt.id]);
    expect(getLinearOutbox(terminalReceipt.id)?.status).toBe("processed");
  });

  it("locally acknowledges a GitHub control receipt and releases its publication gate without Linear", async () => {
    setup();
    store.upsertUnpinned({
      ticket_id: "github:42",
      ticket_reference: "GH-42",
      session_id: "github-session-42",
      control_provider: "github",
      external_thread_id: "42",
      external_thread_reference: "GH-42",
      sandbox_id: null,
      branch: "ot/gh-42",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
    const payload = JSON.stringify({
      type: "pipeline_receipt",
      publication: { body: "The provider wait is ready." },
    });
    const row = store.enqueueLinearOutbox({
      id: "github-control-row",
      sessionId: "github-session-42",
      issueId: "github:42",
      kind: "pipeline_receipt",
      payload,
    });
    const timestamp = "2026-08-11T00:00:00.000Z";
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('github-config', 'owner/repo', ?, ?, ?, '{}', ?)
    `).run("a".repeat(40), "b".repeat(40), "c".repeat(64), timestamp);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('github-runtime', ?, 'stage-executor@1', '{}', ?)
    `).run("d".repeat(64), timestamp);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('github-test', 1, ?, '{}', ?)
    `).run("e".repeat(64), timestamp);
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch, agent,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        active_stage_id, state_version, attempt_count, created_at, updated_at
      ) VALUES (
        'github-instance', 'github:42', 'github-session-42', 1, 'github-test', 1,
        ?, '{}', 'owner/repo', ?, 'ot/gh-42', 'codex', 'github-config', ?,
        'github-runtime', ?, 'stage-executor@1', '[]',
        'completion_pending_publication', NULL, 1, 1, ?, ?
      )
    `).run(
      "e".repeat(64),
      "a".repeat(40),
      "c".repeat(64),
      "d".repeat(64),
      timestamp,
      timestamp
    );
    db.prepare(`
      INSERT INTO pipeline_publication_receipts (
        id, pipeline_instance_id, attempt_id, kind, idempotency_key, payload,
        payload_hash, status, attempts, next_attempt_at, resume_status,
        created_at, updated_at
      ) VALUES (
        ?, 'github-instance', NULL, 'control_ledger', 'github-control-gate', ?,
        ?, 'pending', 0, ?, 'waiting_provider', ?, ?
      )
    `).run(row.id, payload, row.payload_hash, timestamp, timestamp, timestamp);
    const getLinearClient = vi.fn(async () => undefined);
    const processor = createLinearOutboxProcessor({ store, getLinearClient });

    await processor.process(row.id);

    expect(getLinearClient).not.toHaveBeenCalled();
    expect(getLinearOutbox(row.id)).toMatchObject({
      status: "processed",
      attempts: 1,
      last_error: null,
    });
    expect(db.prepare(`
      SELECT status FROM pipeline_publication_receipts WHERE id = ?
    `).get(row.id)).toEqual({ status: "acknowledged" });
    expect(db.prepare(`
      SELECT status, terminal_outcome FROM pipeline_instances WHERE id = 'github-instance'
    `).get()).toEqual({ status: "waiting_provider", terminal_outcome: null });
  });
});
