import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { digestNormalized } from "../../pipeline/manifest.js";
import { runtime, setupPipelineStore, ticket } from "../../__fixtures__/pipeline-store.js";

describe("pipeline effect store", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("leases effect intents at least once and journals acknowledgement atomically", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("effect-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("effect-session")!;
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES ('later-cleanup', ?, 2, 'cleanup', 'later-cleanup', '{}', ?,
        'pending', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `).run(instance.id, digestNormalized("{}"));
    const first = pipelines.claimEffects(
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:01:00.000Z"
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "provision", status: "processing", attempts: 1 });
    expect(pipelines.claimEffects(
      "2099-01-01T00:00:30.000Z",
      "2099-01-01T00:02:00.000Z"
    )).toEqual([]);
    const reclaimed = pipelines.claimEffects(
      "2099-01-01T00:01:00.000Z",
      "2099-01-01T00:02:00.000Z"
    );
    expect(reclaimed[0]).toMatchObject({ id: first[0]!.id, attempts: 2 });

    pipelines.recordEffectAcknowledgement({
      effectId: first[0]!.id,
      eventId: "effect-ack-1",
      payload: JSON.stringify({ providerResourceId: "opaque-1" }),
    });
    pipelines.recordEffectAcknowledgement({
      effectId: first[0]!.id,
      eventId: "effect-ack-1",
      payload: JSON.stringify({ providerResourceId: "opaque-1" }),
    });
    expect(pipelines.listEffects(instance.id)[0]?.status).toBe("acknowledged");
    expect(db.prepare("SELECT kind, status FROM pipeline_inbox_events WHERE id = ?")
      .get("effect-ack-1")).toEqual({ kind: "effect_acknowledged", status: "pending" });
    const later = pipelines.claimEffects(
      "2099-01-01T01:00:00.000Z",
      "2099-01-01T01:01:00.000Z"
    );
    expect(later).toEqual([expect.objectContaining({ id: "later-cleanup", attempts: 1 })]);
    pipelines.recordEffectAcknowledgement({
      effectId: "later-cleanup",
      eventId: "effect-ack-2",
      payload: "{}",
    });
    expect(pipelines.claimEffects(
      "2099-01-01T02:00:00.000Z",
      "2099-01-01T02:01:00.000Z"
    )).toEqual([]);
  });
});
