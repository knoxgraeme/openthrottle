import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobAvailabilityError, VolumeBlobStore } from "./blob-store.js";
import {
  KERNEL_INBOX_MAX_PAYLOAD_BYTES,
  SqliteKernelInboxStore,
} from "./kernel-inbox-store.js";
import {
  KERNEL_FIXTURE_NOW,
  freshKernelFixture,
  type FreshKernelFixture,
} from "./__fixtures__/kernel-epoch.js";

const fixtures: FreshKernelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
  const fixture = freshKernelFixture();
  fixtures.push(fixture);
  const store = new SqliteKernelInboxStore({
    db: fixture.db,
    blob_store: fixture.blobs,
    now: () => KERNEL_FIXTURE_NOW,
  });
  return { fixture, store };
}

function event(deliveryId: string, deliveryAttempt = 1) {
  return {
    source_provider: "github",
    delivery_id: deliveryId,
    kind: "webhook/pull-request@1",
    generation: 0,
    event_group_key: "pull-request:42:opened",
    delivery_attempt: deliveryAttempt,
    payload_schema: "github.pull-request/v1",
    payload: { action: "opened", number: 42 },
  } as const;
}

describe("SqliteKernelInboxStore", () => {
  it("deduplicates provider replay and settles reordered redelivery only once", () => {
    const { fixture, store } = setup();
    const first = store.ingest(event("delivery-1"));
    expect(first).toMatchObject({ disposition: "inserted", acknowledge: true });
    expect(store.ingest(event("delivery-1"))).toMatchObject({
      disposition: "duplicate",
      acknowledge: true,
    });
    expect(store.ingest(event("delivery-2", 2))).toMatchObject({
      disposition: "reordered",
      event: { status: "stale", consumed_at: KERNEL_FIXTURE_NOW },
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 2 });

    const leased = store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:05:00.000Z",
    });
    expect(leased).toMatchObject({
      delivery_id: "delivery-1",
      status: "processing",
      lease_id: "lease-1",
    });
    expect(store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toEqual(leased);
    store.complete({
      event_id: leased!.id,
      owner_id: "worker-1",
      lease_id: "lease-1",
      outcome: "consumed",
    });
    expect(store.get(leased!.id)).toMatchObject({
      status: "consumed",
      consumed_at: KERNEL_FIXTURE_NOW,
    });
    expect(store.leaseNext({
      owner_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toBeNull();
  });

  it("closes ingress atomically and returns retryable non-acknowledgement", () => {
    const { fixture, store } = setup();
    expect(store.getMaintenanceFence()).toEqual({
      closed: false,
      version: 1,
      updated_at: KERNEL_FIXTURE_NOW,
    });
    const closed = store.setMaintenanceFence({ closed: true, expected_version: 1 });
    expect(closed).toEqual({ closed: true, version: 2, updated_at: KERNEL_FIXTURE_NOW });
    expect(store.ingest(event("during-maintenance"))).toEqual({
      disposition: "maintenance_closed",
      retryable: true,
      acknowledge: false,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });
    expect(() => store.setMaintenanceFence({ closed: false, expected_version: 1 }))
      .toThrow(/compare-and-set/);
    store.setMaintenanceFence({ closed: false, expected_version: 2 });
    expect(store.ingest(event("during-maintenance"))).toMatchObject({ disposition: "inserted" });
  });

  it("requeues a leased event behind a future availability fence", () => {
    const { store } = setup();
    const ingested = store.ingest({
      ...event("retryable"),
      event_group_key: "retryable-event",
    });
    if (ingested.disposition !== "inserted") throw new Error("fixture event was not inserted");
    const leased = store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-retry",
      expires_at: "2026-08-20T12:05:00.000Z",
    });
    expect(leased).toMatchObject({ id: ingested.event.id, status: "processing", version: 1 });

    store.retry({
      event_id: leased!.id,
      owner_id: "worker-1",
      lease_id: "lease-retry",
      available_at: "2026-08-20T12:00:01.000Z",
    });
    expect(store.get(leased!.id)).toMatchObject({
      status: "pending",
      available_at: "2026-08-20T12:00:01.000Z",
      lease_id: null,
      consumed_at: null,
      version: 2,
    });
    expect(store.leaseNext({
      owner_id: "worker-2",
      lease_id: "lease-too-early",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toBeNull();
    expect(() => store.retry({
      event_id: leased!.id,
      owner_id: "worker-1",
      lease_id: "lease-retry",
      available_at: "2026-08-20T12:00:02.000Z",
    })).toThrow(/lease fence/);
  });

  it("bounds exact consumed-origin observation by provider, kind, status, and timestamp", () => {
    const { store } = setup();
    const first = store.ingest({
      ...event("admission-1"),
      id: "inbox-admission-1",
      kind: "github/issues/labeled@1",
      event_group_key: "issue:188:labeled",
      payload: {
        repository: { full_name: "owner/repo" },
        issue: { number: 188, labels: [{ name: "openthrottle" }] },
      },
    });
    const second = store.ingest({
      ...event("admission-2"),
      id: "inbox-admission-2",
      kind: "github/issues/edited@1",
      event_group_key: "issue:189:edited",
      payload: {
        repository: { full_name: "owner/repo" },
        issue: { number: 189, labels: [{ name: "openthrottle" }] },
      },
    });
    if (first.disposition !== "inserted" || second.disposition !== "inserted") {
      throw new Error("fixture events were not inserted");
    }

    for (const [index, expectedId] of [first.event.id, second.event.id].entries()) {
      const leaseId = `lease-observed-${index}`;
      const leased = store.leaseNext({
        owner_id: "worker-1",
        lease_id: leaseId,
        expires_at: "2026-08-20T12:05:00.000Z",
      })!;
      expect(leased.id).toBe(expectedId);
      store.complete({
        event_id: leased.id,
        owner_id: "worker-1",
        lease_id: leaseId,
        outcome: "consumed",
      });
    }
    store.ingest({
      ...event("still-pending"),
      id: "inbox-admission-pending",
      kind: "github/issues/labeled@1",
      event_group_key: "issue:190:labeled",
    });

    expect(store.listConsumedAt({
      source_provider: "github",
      kinds: ["github/issues/labeled@1", "github/issues/edited@1"],
      consumed_at: KERNEL_FIXTURE_NOW,
      limit: 1,
    })).toMatchObject({
      events: [{ id: "inbox-admission-2", status: "consumed", consumed_at: KERNEL_FIXTURE_NOW }],
      truncated: true,
      corrupt: false,
    });
    expect(store.listConsumedAt({
      source_provider: "github",
      kinds: ["github/issues/labeled@1", "github/issues/edited@1"],
      consumed_at: KERNEL_FIXTURE_NOW,
      limit: 10,
    })).toMatchObject({
      events: [{ id: "inbox-admission-2" }, { id: "inbox-admission-1" }],
      truncated: false,
      corrupt: false,
    });
    expect(store.listConsumedAt({
      source_provider: "github",
      kinds: ["github/issues/labeled@1", "github/issues/edited@1"],
      consumed_at: "2026-08-20T12:00:00.001Z",
      limit: 10,
    })).toEqual({ events: [], truncated: false, corrupt: false });
  });

  it("reports deterministically corrupt exact-origin candidates", () => {
    const { fixture, store } = setup();
    const corrupt = store.ingest({
      ...event("corrupt-admission"),
      kind: "github/issues/labeled@1",
      event_group_key: "issue:corrupt:labeled",
      payload: {
        repository: { full_name: "owner/repo" },
        issue: {
          number: 188,
          body: "x".repeat(70_000),
          labels: [{ name: "openthrottle" }],
        },
      },
    });
    if (corrupt.disposition !== "inserted") throw new Error("fixture event was not inserted");
    const leased = store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-corrupt-origin",
      expires_at: "2026-08-20T12:05:00.000Z",
    })!;
    store.complete({
      event_id: leased.id,
      owner_id: "worker-1",
      lease_id: "lease-corrupt-origin",
      outcome: "consumed",
    });
    fixture.db.prepare("UPDATE inbox_events SET blob_algorithm = NULL WHERE id = ?")
      .run(corrupt.event.id);

    expect(store.listConsumedAt({
      source_provider: "github",
      kinds: ["github/issues/labeled@1"],
      consumed_at: KERNEL_FIXTURE_NOW,
      limit: 10,
    })).toEqual({ events: [], truncated: false, corrupt: true });
  });

  it("propagates transient blob failures while verifying an exact origin", () => {
    const { fixture, store } = setup();
    const origin = store.ingest({
      ...event("transient-origin"),
      kind: "github/issues/labeled@1",
      event_group_key: "issue:transient-origin:labeled",
      payload: {
        repository: { full_name: "owner/repo" },
        issue: {
          number: 188,
          body: "x".repeat(70_000),
          labels: [{ name: "openthrottle" }],
        },
      },
    });
    if (origin.disposition !== "inserted") throw new Error("fixture event was not inserted");
    const leased = store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-transient-origin",
      expires_at: "2026-08-20T12:05:00.000Z",
    })!;
    store.complete({
      event_id: leased.id,
      owner_id: "worker-1",
      lease_id: "lease-transient-origin",
      outcome: "consumed",
    });
    const pointer = fixture.db.prepare("SELECT blob_digest FROM inbox_events WHERE id = ?")
      .get(origin.event.id) as { blob_digest: string };
    vi.spyOn(fixture.blobs, "read").mockImplementationOnce(() => {
      throw new BlobAvailabilityError(pointer.blob_digest, "EIO");
    });

    expect(() => store.listConsumedAt({
      source_provider: "github",
      kinds: ["github/issues/labeled@1"],
      consumed_at: KERNEL_FIXTURE_NOW,
      limit: 10,
    })).toThrow(BlobAvailabilityError);
  });

  it("prewrites large payloads before committing a verified pointer", () => {
    const { fixture, store } = setup();
    const payload = { evidence: "x".repeat(70_000) };
    const result = store.ingest({
      ...event("large"),
      event_group_key: "large-event",
      payload_schema: "evidence/v1",
      payload,
    });
    expect(result).toMatchObject({ disposition: "inserted", event: { payload } });
    const row = fixture.db.prepare(`
      SELECT inline_payload, blob_digest, payload_hash, blob_bytes
      FROM inbox_events WHERE delivery_id = 'large'
    `).get() as {
      inline_payload: string | null;
      blob_digest: string;
      payload_hash: string;
      blob_bytes: number;
    };
    expect(row.inline_payload).toBeNull();
    expect(row.blob_digest).toBe(row.payload_hash);
    expect(row.blob_bytes).toBeGreaterThan(64 * 1024);
    expect(store.get(result.disposition === "inserted" ? result.event.id : "missing")?.payload)
      .toEqual(payload);
  });

  it("dead-letters an unreadable head and leases the next valid event", () => {
    const { fixture, store } = setup();
    const poison = store.ingest({
      ...event("poison"),
      event_group_key: "poison-event",
      payload: { evidence: "x".repeat(70_000) },
    });
    const valid = store.ingest({
      ...event("valid"),
      event_group_key: "valid-event",
    });
    if (poison.disposition !== "inserted" || valid.disposition !== "inserted") {
      throw new Error("fixture events were not inserted");
    }
    fixture.db.prepare(`
      UPDATE inbox_events SET available_at = '2026-08-20T11:59:59.000Z', blob_algorithm = NULL
      WHERE id = ?
    `).run(poison.event.id);

    expect(store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-valid",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toMatchObject({ id: valid.event.id, status: "processing" });
    expect(fixture.db.prepare("SELECT status, consumed_at FROM inbox_events WHERE id = ?")
      .get(poison.event.id)).toEqual({ status: "dead", consumed_at: KERNEL_FIXTURE_NOW });
  });

  it("dead-letters a complete but contract-invalid blob pointer before leasing the next event", () => {
    const { fixture, store } = setup();
    const poison = store.ingest({
      ...event("invalid-pointer"),
      event_group_key: "invalid-pointer-event",
      payload: { evidence: "x".repeat(70_000) },
    });
    const valid = store.ingest({
      ...event("valid-after-invalid-pointer"),
      event_group_key: "valid-after-invalid-pointer-event",
    });
    if (poison.disposition !== "inserted" || valid.disposition !== "inserted") {
      throw new Error("fixture events were not inserted");
    }
    fixture.db.prepare(`
      UPDATE inbox_events
      SET available_at = '2026-08-20T11:59:59.000Z', blob_media_type = 'invalid'
      WHERE id = ?
    `).run(poison.event.id);

    expect(store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-valid-after-invalid-pointer",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toMatchObject({ id: valid.event.id, status: "processing" });
    expect(fixture.db.prepare("SELECT status, consumed_at FROM inbox_events WHERE id = ?")
      .get(poison.event.id)).toEqual({ status: "dead", consumed_at: KERNEL_FIXTURE_NOW });
  });

  it("rolls back a transient blob read failure and leases the same event after recovery", () => {
    const { fixture, store } = setup();
    const result = store.ingest({
      ...event("transient-read"),
      event_group_key: "transient-read-event",
      payload: { evidence: "x".repeat(70_000) },
    });
    if (result.disposition !== "inserted") throw new Error("fixture event was not inserted");
    const pointer = fixture.db.prepare(`
      SELECT blob_digest FROM inbox_events WHERE id = ?
    `).get(result.event.id) as { blob_digest: string };
    vi.spyOn(fixture.blobs, "read").mockImplementationOnce(() => {
      throw new BlobAvailabilityError(pointer.blob_digest, "EIO");
    });

    expect(() => store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-transient",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toThrow(BlobAvailabilityError);
    expect(fixture.db.prepare("SELECT status, lease_id, version FROM inbox_events WHERE id = ?")
      .get(result.event.id)).toEqual({ status: "pending", lease_id: null, version: 0 });

    expect(store.leaseNext({
      owner_id: "worker-2",
      lease_id: "lease-recovered",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toMatchObject({ id: result.event.id, status: "processing", payload: result.event.payload });
  });

  it("completes bookkeeping without re-reading a payload that was already handled", () => {
    const { fixture, store } = setup();
    const result = store.ingest({
      ...event("handled-large"),
      event_group_key: "handled-large-event",
      payload: { evidence: "x".repeat(70_000) },
    });
    if (result.disposition !== "inserted") throw new Error("fixture event was not inserted");
    const leased = store.leaseNext({
      owner_id: "worker-1",
      lease_id: "lease-handled",
      expires_at: "2026-08-20T12:05:00.000Z",
    })!;
    fixture.db.prepare("UPDATE inbox_events SET blob_algorithm = NULL WHERE id = ?")
      .run(leased.id);

    expect(() => store.complete({
      event_id: leased.id,
      owner_id: "worker-1",
      lease_id: "lease-handled",
      outcome: "consumed",
    })).not.toThrow();
    expect(fixture.db.prepare("SELECT status, consumed_at FROM inbox_events WHERE id = ?")
      .get(leased.id)).toEqual({ status: "consumed", consumed_at: KERNEL_FIXTURE_NOW });
  });

  it("never commits a blob pointer when durable publication fails", () => {
    const { fixture } = setup();
    const faultedBlobs = VolumeBlobStore.open(fixture.blobs.root, fixture.blobs.store_id, {
      fault_injector(step) {
        if (step === "temporary_written") throw new Error("injected inbox blob failure");
      },
    });
    const store = new SqliteKernelInboxStore({
      db: fixture.db,
      blob_store: faultedBlobs,
      now: () => KERNEL_FIXTURE_NOW,
    });
    expect(() => store.ingest({
      ...event("faulted"),
      event_group_key: "faulted-event",
      payload: { evidence: "x".repeat(70_000) },
    })).toThrow(/injected inbox blob failure/);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });
  });

  it("rejects conflicting replay, changed group intent, and oversized input", () => {
    const { store } = setup();
    store.ingest(event("delivery-1"));
    expect(() => store.ingest({ ...event("delivery-1"), payload: { changed: true } }))
      .toThrow(/changed intent/);
    expect(() => store.ingest({
      ...event("delivery-2", 2),
      payload: { action: "closed", number: 42 },
    })).toThrow(/group.*changed intent/);
    expect(() => store.ingest({
      ...event("too-large"),
      event_group_key: "too-large",
      payload: { body: "x".repeat(KERNEL_INBOX_MAX_PAYLOAD_BYTES + 1) },
    })).toThrow(/exceeds/);
  });
});
