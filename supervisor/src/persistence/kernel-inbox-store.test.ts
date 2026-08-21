import { afterEach, describe, expect, it } from "vitest";
import { VolumeBlobStore } from "./blob-store.js";
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
    expect(store.complete({
      event_id: leased!.id,
      owner_id: "worker-1",
      lease_id: "lease-1",
      outcome: "consumed",
    })).toMatchObject({ status: "consumed", consumed_at: KERNEL_FIXTURE_NOW });
    expect(store.leaseNext({
      owner_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:05:00.000Z",
    })).toBeNull();
  });

  it("closes ingress atomically and returns retryable non-acknowledgement", () => {
    const { fixture, store } = setup();
    expect(store.getMaintenanceFence()).toEqual({ closed: false, version: 0, updated_at: null });
    const closed = store.setMaintenanceFence({ closed: true, expected_version: 0 });
    expect(closed).toEqual({ closed: true, version: 1, updated_at: KERNEL_FIXTURE_NOW });
    expect(store.ingest(event("during-maintenance"))).toEqual({
      disposition: "maintenance_closed",
      retryable: true,
      acknowledge: false,
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM inbox_events").get())
      .toEqual({ count: 0 });
    expect(() => store.setMaintenanceFence({ closed: false, expected_version: 0 }))
      .toThrow(/compare-and-set/);
    store.setMaintenanceFence({ closed: false, expected_version: 1 });
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

    expect(store.retry({
      event_id: leased!.id,
      owner_id: "worker-1",
      lease_id: "lease-retry",
      available_at: "2026-08-20T12:00:01.000Z",
    })).toMatchObject({
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
