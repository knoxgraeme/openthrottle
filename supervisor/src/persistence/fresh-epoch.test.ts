import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolumeBlobStore } from "./blob-store.js";
import {
  acceptFreshEpochRelease,
  createFreshEpochBootstrap,
  FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA,
  FreshEpochRefusalError,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
  verifyFreshEpochBootstrapOnly,
  verifyFreshEpochDatabase,
  type FreshEpochBootstrap,
  type FreshEpochIdentity,
  type FreshEpochReleaseAcceptanceRequest,
} from "./epoch-database.js";
import {
  FRESH_EPOCH_SCHEMA_CHECKSUM,
  FRESH_EPOCH_TABLES,
  FRESH_EPOCH_VERSION,
} from "./epoch-schema.js";
import { SqliteKernelInboxStore } from "./kernel-inbox-store.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-20T12:00:00.000Z";
const RUNTIME_CAPABILITY = "c".repeat(64);
const NEXT_RUNTIME_CAPABILITY = "d".repeat(64);

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "openthrottle-fresh-epoch-"));
  temporaryDirectories.push(path);
  return path;
}

function bootstrap(): FreshEpochBootstrap {
  return createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [
      { key: "operator.poll_batch_size", value: 4, value_type: "number", mutable: true },
      { key: "operator.mode", value: "dogfood", value_type: "string", mutable: false },
    ],
    repository_registrations: [
      {
        id: "registration-linear",
        control_provider: "linear",
        route_key: "team-1",
        linear_team_id: "team-1",
        linear_team_key: "OPE",
        github_repo: "owner/repo",
        github_installation_id: 42,
        base_branch: "main",
        webhook_id: 7,
        runtime_snapshot: "snapshot-v1",
      },
    ],
  });
}

function initialized() {
  const directory = temporaryDirectory();
  const blob_store = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
  const database_path = join(directory, "epoch.sqlite");
  const manifest = bootstrap();
  const db = initializeFreshEpochDatabase({
    database_path,
    blob_store,
    release_id: "release-a",
    runtime_capability_digest: RUNTIME_CAPABILITY,
    bootstrap: manifest,
    now: () => NOW,
  });
  const expected_identity: FreshEpochIdentity = {
    release_id: "release-a",
    runtime_capability_digest: RUNTIME_CAPABILITY,
    blob_store_id: blob_store.store_id,
    blob_marker_checksum: blob_store.marker_checksum,
    bootstrap_checksum: manifest.checksum,
  };
  return { directory, blob_store, database_path, manifest, db, expected_identity };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function releaseRequest(
  value: ReturnType<typeof initialized>,
  overrides: Partial<FreshEpochReleaseAcceptanceRequest> = {},
): FreshEpochReleaseAcceptanceRequest {
  return {
    schema: FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA,
    transition_id: "release-b-transition",
    expected_maintenance_version: 0,
    expected_current_identity: value.expected_identity,
    candidate_identity: {
      ...value.expected_identity,
      release_id: "release-b",
      runtime_capability_digest: NEXT_RUNTIME_CAPABILITY,
    },
    candidate_schema_version: FRESH_EPOCH_VERSION,
    candidate_schema_checksum: FRESH_EPOCH_SCHEMA_CHECKSUM,
    ...overrides,
  };
}

function acceptRelease(
  value: ReturnType<typeof initialized>,
  request = releaseRequest(value),
) {
  if (value.db.open) value.db.close();
  return acceptFreshEpochRelease({
    database_path: value.database_path,
    blob_store: value.blob_store,
    request,
    now: () => "2026-08-21T12:00:00.000Z",
  });
}

function seedSettledEvidence(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO work_items (
        id, repository_registration_id, source_provider, source_id, source_reference,
        state, title, request_payload_schema, request_inline_json, version, created_at, updated_at
      ) VALUES ('work-history', 'registration-linear', 'linear', 'source-history', 'OPE-1',
        'completed', 'settled history', 'test.request/v1', '{}', 1, ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO pipeline_runs (
        id, work_item_id, pipeline_id, definition_bundle_algorithm, definition_bundle_hash,
        definition_bundle_bytes, definition_bundle_encoding, definition_bundle_media_type,
        definition_bundle_payload_schema, current_subject, status, terminal_outcome,
        cursor_stage_id, cursor_version, cursor_reentries_json, cursor_frontier_json,
        cursor_completed_scope_keys_json, cursor_barrier_json, version, work_retry_limit,
        result_correction_limit, created_at, updated_at
      ) VALUES ('run-history', 'work-history', 'core/history', 'sha256', ?, 2, 'utf-8',
        'application/json', 'openthrottle.definition-bundle/v1', ?, 'completed', 'completed',
        NULL, 1, '{}', '[]', '[]', NULL, 1, 2, 2, ?, ?)
    `).run("1".repeat(64), "2".repeat(40), NOW, NOW);
    db.prepare(`
      INSERT INTO attempts (
        id, pipeline_run_id, scope_kind, stage_id, repository_authority, request_hash,
        definition_bundle_hash, input_subject, context_record_ids_json,
        context_checkpoint_ids_json, output_subject, status, version, work_retry_ordinal,
        result_correction_count, unmet_dependency_count, checkpoint_id, result_record_id,
        decision_record_id, created_at, updated_at
      ) VALUES ('attempt-history', 'run-history', 'stage', 'history', 'edit', ?, ?, ?, '[]',
        '[]', ?, 'settled', 3, 0, 0, 0, 'checkpoint-history', 'result-history',
        'decision-history', ?, ?)
    `).run("3".repeat(64), "1".repeat(64), "2".repeat(40), "4".repeat(40), NOW, NOW);
    db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key, payload_schema,
        inline_payload, attempt_id, request_hash, definition_bundle_hash, input_subject,
        output_subject, original_candidate_hash, normalized_candidate_hash, created_at
      ) VALUES ('result-history', 'run-history', 1, ?, 'result', 'result:history',
        'test.result/v1', '{"value":"preserve-me"}', 'attempt-history', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "5".repeat(64), "3".repeat(64), "1".repeat(64), "2".repeat(40),
      "4".repeat(40), "6".repeat(64), "6".repeat(64), NOW,
    );
    db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key, payload_schema,
        inline_payload, reducer, input_record_ids_json, input_record_count, created_at
      ) VALUES ('decision-history', 'run-history', 2, ?, 'decision', 'decision:history',
        'test.decision/v1', '{"decision":"preserve-me"}', 'test/reducer@1',
        '["result-history"]', 1, ?)
    `).run("7".repeat(64), NOW);
    db.prepare(`
      INSERT INTO checkpoints (
        id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
        request_hash, definition_bundle_hash, input_subject, output_subject,
        payload_schema, inline_payload, captured_at
      ) VALUES ('checkpoint-history', 'run-history', 'attempt-history', 0, ?,
        'checkpoint:history', ?, ?, ?, ?, 'test.checkpoint/v1',
        '{"checkpoint":"preserve-me"}', ?)
    `).run(
      "8".repeat(64), "3".repeat(64), "1".repeat(64), "2".repeat(40),
      "4".repeat(40), NOW,
    );
  }).immediate();
}

function canonicalEvidence(db: Database.Database): string {
  return JSON.stringify({
    records: db.prepare("SELECT * FROM records ORDER BY id").all(),
    checkpoints: db.prepare("SELECT * FROM checkpoints ORDER BY id").all(),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("fresh epoch database", () => {
  it("publishes a checksummed bootstrap atomically into exactly twelve tables", () => {
    const { db, database_path, blob_store, expected_identity, manifest } = initialized();
    try {
      const tables = (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([...FRESH_EPOCH_TABLES].sort());
      expect(verifyFreshEpochDatabase(db, expected_identity)).toMatchObject({
        ...expected_identity,
        integrity: "ok",
      });
      expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(existsSync(`${database_path}-wal`)).toBe(false);
      expect(existsSync(`${database_path}-shm`)).toBe(false);
      expect(() => verifyFreshEpochBootstrapOnly(db, manifest)).not.toThrow();
      expect(db.prepare("SELECT key, mutable FROM settings ORDER BY key").all()).toEqual([
        { key: "epoch.blob_marker_checksum", mutable: 0 },
        { key: "epoch.blob_store_id", mutable: 0 },
        { key: "epoch.bootstrap_checksum", mutable: 0 },
        { key: "epoch.maintenance_ingress_closed", mutable: 1 },
        { key: "epoch.release_id", mutable: 0 },
        { key: "epoch.runtime_capability_digest", mutable: 0 },
        { key: "operator.mode", mutable: 0 },
        { key: "operator.poll_batch_size", mutable: 1 },
      ]);
      expect(() => db.prepare("UPDATE settings SET value_json = '\"changed\"' WHERE key = 'epoch.release_id'").run())
        .toThrow(/immutable setting/);
      expect(() => db.prepare(`
        UPDATE settings SET value_json = '"${"d".repeat(64)}"'
        WHERE key = 'epoch.runtime_capability_digest'
      `).run()).toThrow(/immutable setting/);
      expect(() => db.prepare("DELETE FROM settings WHERE key = 'operator.mode'").run())
        .toThrow(/immutable setting/);
      db.prepare(`
        UPDATE settings SET value_json = '5', version = version + 1, updated_at = ?
        WHERE key = 'operator.poll_batch_size'
      `).run(NOW);
      expect(db.prepare("SELECT value_json, version FROM settings WHERE key = 'operator.poll_batch_size'").get())
        .toEqual({ value_json: "5", version: 1 });
    } finally {
      db.close();
    }
    expect(() => blob_store.assertSameVolume(database_path)).not.toThrow();
  });

  it("starts fresh ingress closed and reopens through one exact maintenance transition", () => {
    const initializedEpoch = initialized();
    const inbox = new SqliteKernelInboxStore({
      db: initializedEpoch.db,
      blob_store: initializedEpoch.blob_store,
      now: () => NOW,
    });
    try {
      expect(inbox.getMaintenanceFence()).toEqual({
        closed: true,
        version: 0,
        updated_at: NOW,
      });
      expect(inbox.ingest({
        source_provider: "github",
        delivery_id: "fresh-epoch-closed",
        kind: "github/issues/opened@1",
        generation: 0,
        event_group_key: "github:issue:1",
        delivery_attempt: 1,
        payload_schema: "github.issue/v1",
        payload: { action: "opened" },
      })).toEqual({
        disposition: "maintenance_closed",
        retryable: true,
        acknowledge: false,
      });

      expect(inbox.setMaintenanceFence({ closed: false, expected_version: 0 })).toEqual({
        closed: false,
        version: 1,
        updated_at: NOW,
      });
      expect(() => inbox.setMaintenanceFence({ closed: false, expected_version: 0 }))
        .toThrow(/compare-and-set/);
      expect(inbox.ingest({
        source_provider: "github",
        delivery_id: "fresh-epoch-open",
        kind: "github/issues/opened@1",
        generation: 0,
        event_group_key: "github:issue:2",
        delivery_attempt: 1,
        payload_schema: "github.issue/v1",
        payload: { action: "opened" },
      })).toMatchObject({ disposition: "inserted", acknowledge: true });
    } finally {
      initializedEpoch.db.close();
    }
  });

  it("compares authored setting keys with the contract's case sensitivity", () => {
    const directory = temporaryDirectory();
    const blob_store = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
    const database_path = join(directory, "epoch.sqlite");
    const manifest = createFreshEpochBootstrap({
      schema: "openthrottle.fresh-epoch-bootstrap/v1",
      settings: [
        { key: "Epoch.operator_note", value: "visible", value_type: "string", mutable: false },
      ],
      repository_registrations: [],
    });
    const db = initializeFreshEpochDatabase({
      database_path,
      blob_store,
      release_id: "release-a",
      runtime_capability_digest: RUNTIME_CAPABILITY,
      bootstrap: manifest,
      now: () => NOW,
    });
    try {
      expect(() => verifyFreshEpochBootstrapOnly(db, manifest)).not.toThrow();
      expect(db.prepare("SELECT value_json FROM settings WHERE key = ?")
        .get("Epoch.operator_note")).toEqual({ value_json: '"visible"' });
    } finally {
      db.close();
    }
  });

  it("rejects bootstrap-only recovery once execution state exists", () => {
    const initializedEpoch = initialized();
    const inbox = new SqliteKernelInboxStore({
      db: initializedEpoch.db,
      blob_store: initializedEpoch.blob_store,
      now: () => NOW,
    });
    try {
      expect(() => verifyFreshEpochBootstrapOnly(initializedEpoch.db, initializedEpoch.manifest)).not.toThrow();
      expect(inbox.ingest({
        source_provider: "github",
        delivery_id: "bootstrap-only-rejection",
        kind: "github/issues/opened@1",
        generation: 0,
        event_group_key: "github:issue:bootstrap-only",
        delivery_attempt: 1,
        payload_schema: "github.issue/v1",
        payload: { action: "opened" },
      })).toMatchObject({ disposition: "maintenance_closed" });
      expect(() => verifyFreshEpochBootstrapOnly(initializedEpoch.db, initializedEpoch.manifest))
        .not.toThrow();
      expect(inbox.setMaintenanceFence({ closed: false, expected_version: 0 })).toMatchObject({ closed: false });
      expect(() => verifyFreshEpochBootstrapOnly(initializedEpoch.db, initializedEpoch.manifest))
        .toThrow(/maintenance ingress fence/);
    } finally {
      initializedEpoch.db.close();
    }
  });

  it("reopens only the recognized release/bootstrap/blob-root tuple", () => {
    const initializedEpoch = initialized();
    initializedEpoch.db.close();
    const reopened = openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: initializedEpoch.expected_identity,
    });
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
    reopened.close();

    const before = digest(initializedEpoch.database_path);
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: { ...initializedEpoch.expected_identity, release_id: "release-b" },
    })).toThrow(/identity mismatch/);
    expect(digest(initializedEpoch.database_path)).toBe(before);

    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: {
        ...initializedEpoch.expected_identity,
        runtime_capability_digest: "d".repeat(64),
      },
    })).toThrow(/identity mismatch/);
    expect(digest(initializedEpoch.database_path)).toBe(before);

    const otherStore = VolumeBlobStore.initialize(join(initializedEpoch.directory, "other-blobs"), "store-b");
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: otherStore,
      expected_identity: { ...initializedEpoch.expected_identity, blob_store_id: "store-b" },
    })).toThrow(/identity mismatch/);
    expect(digest(initializedEpoch.database_path)).toBe(before);
  });

  it("atomically accepts a new release while preserving settled evidence and replays its receipt", () => {
    const initializedEpoch = initialized();
    seedSettledEvidence(initializedEpoch.db);
    const beforeEvidence = canonicalEvidence(initializedEpoch.db);
    const request = releaseRequest(initializedEpoch);

    const receipt = acceptRelease(initializedEpoch, request);

    expect(receipt).toMatchObject({
      schema: "openthrottle.epoch-release-acceptance/v1",
      transition_id: request.transition_id,
      sequence: 1,
      maintenance_version: 0,
      schema_version: FRESH_EPOCH_VERSION,
      schema_checksum: FRESH_EPOCH_SCHEMA_CHECKSUM,
      from_identity: request.expected_current_identity,
      to_identity: request.candidate_identity,
    });
    expect(receipt.request_hash).toMatch(/^[a-f0-9]{64}$/);

    const accepted = openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: request.candidate_identity,
    });
    expect(canonicalEvidence(accepted)).toBe(beforeEvidence);
    expect(accepted.prepare(`
      SELECT value_json, value_type, mutable, version FROM settings
      WHERE key = ?
    `).get(`epoch.release_acceptance.${request.transition_id}`)).toMatchObject({
      value_type: "json",
      mutable: 0,
      version: 0,
    });
    accepted.close();

    expect(acceptRelease(initializedEpoch, request)).toEqual(receipt);
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: initializedEpoch.expected_identity,
    })).toThrow(/identity mismatch/);
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: {
        ...request.candidate_identity,
        runtime_capability_digest: "e".repeat(64),
      },
    })).toThrow(/identity mismatch/);
  });

  it("chains successive acceptances and opens only the latest durable identity", () => {
    const initializedEpoch = initialized();
    const firstRequest = releaseRequest(initializedEpoch);
    const firstReceipt = acceptRelease(initializedEpoch, firstRequest);
    const secondRequest: FreshEpochReleaseAcceptanceRequest = {
      ...firstRequest,
      transition_id: "release-c-transition",
      expected_current_identity: firstRequest.candidate_identity,
      candidate_identity: {
        ...firstRequest.candidate_identity,
        release_id: "release-c",
        runtime_capability_digest: "e".repeat(64),
      },
    };

    const secondReceipt = acceptRelease(initializedEpoch, secondRequest);

    expect(secondReceipt).toMatchObject({ sequence: 2, from_identity: firstRequest.candidate_identity });
    expect(acceptRelease(initializedEpoch, firstRequest)).toEqual(firstReceipt);
    const latest = openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: secondRequest.candidate_identity,
    });
    expect(latest.prepare(`
      SELECT COUNT(*) AS count FROM settings WHERE key GLOB 'epoch.release_acceptance.*'
    `).get()).toEqual({ count: 2 });
    latest.close();
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: firstRequest.candidate_identity,
    })).toThrow(/identity mismatch/);
  });

  it.each([
    ["open maintenance", (value: ReturnType<typeof initialized>) => {
      value.db.prepare(`
        UPDATE settings SET value_json = 'false', version = 1, updated_at = ?
        WHERE key = 'epoch.maintenance_ingress_closed'
      `).run(NOW);
    }, {}],
    ["stale maintenance version", () => {}, { expected_maintenance_version: 1 }],
    ["global lease", (value: ReturnType<typeof initialized>) => {
      value.db.prepare(`
        INSERT INTO leases (
          lease_key, purpose, owner_id, lease_id, expires_at, version, metadata_json, updated_at
        ) VALUES ('release-test', 'operator', 'owner', 'lease', ?, 0, '{}', ?)
      `).run("2026-08-20T12:05:00.000Z", NOW);
    }, {}],
    ["active work", (value: ReturnType<typeof initialized>) => {
      seedSettledEvidence(value.db);
      value.db.prepare(`
        UPDATE work_items SET state = 'active' WHERE id = 'work-history'
      `).run();
    }, {}],
  ] as const)("refuses %s without advancing either pin", (_name, arrange, overrides) => {
    const initializedEpoch = initialized();
    arrange(initializedEpoch);
    const request = releaseRequest(initializedEpoch, overrides);

    expect(() => acceptRelease(initializedEpoch, request)).toThrow(FreshEpochRefusalError);

    const old = openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: initializedEpoch.expected_identity,
    });
    expect(old.prepare(`
      SELECT COUNT(*) AS count FROM settings WHERE key GLOB 'epoch.release_acceptance.*'
    `).get()).toEqual({ count: 0 });
    old.close();
  });

  it("rejects pending and processing inbox state, then accepts after it is drained", () => {
    const initializedEpoch = initialized();
    const inbox = new SqliteKernelInboxStore({
      db: initializedEpoch.db,
      blob_store: initializedEpoch.blob_store,
      now: () => NOW,
    });
    inbox.setMaintenanceFence({ closed: false, expected_version: 0 });
    const ingested = inbox.ingest({
      source_provider: "github",
      delivery_id: "release-inbox",
      kind: "github/issues/opened@1",
      generation: 0,
      event_group_key: "github:release-inbox",
      delivery_attempt: 1,
      payload_schema: "github.issue/v1",
      payload: { action: "opened" },
    });
    if (ingested.disposition !== "inserted") throw new Error("release inbox fixture was not inserted");
    inbox.setMaintenanceFence({ closed: true, expected_version: 1 });
    const request = releaseRequest(initializedEpoch, { expected_maintenance_version: 2 });
    initializedEpoch.db.close();

    expect(() => acceptRelease(initializedEpoch, request)).toThrow(/inbox events remain/);
    const mutator = new Database(initializedEpoch.database_path, { fileMustExist: true });
    mutator.pragma("foreign_keys = ON");
    mutator.prepare(`
      UPDATE inbox_events SET status = 'processing', lease_id = 'inbox-lease',
        lease_owner_id = 'worker', lease_expires_at = ? WHERE id = ?
    `).run("2026-08-20T12:05:00.000Z", ingested.event.id);
    mutator.close();
    expect(() => acceptRelease(initializedEpoch, request)).toThrow(/inbox events remain/);

    const drainer = new Database(initializedEpoch.database_path, { fileMustExist: true });
    drainer.pragma("foreign_keys = ON");
    drainer.prepare(`
      UPDATE inbox_events SET status = 'consumed', lease_id = NULL, lease_owner_id = NULL,
        lease_expires_at = NULL, consumed_at = ? WHERE id = ?
    `).run(NOW, ingested.event.id);
    drainer.close();
    expect(acceptRelease(initializedEpoch, request)).toMatchObject({ sequence: 1 });
  });

  it.each(["pending", "running", "work_complete", "result_pending", "recorded"] as const)(
    "rejects nonterminal Attempt state %s",
    (status) => {
      const initializedEpoch = initialized();
      seedSettledEvidence(initializedEpoch.db);
      initializedEpoch.db.prepare(`
        UPDATE attempts SET status = ?, decision_record_id = NULL,
          result_record_id = CASE WHEN ? IN ('work_complete', 'recorded') THEN result_record_id ELSE NULL END,
          native_session_id = CASE WHEN ? = 'result_pending' THEN 'session-pending' ELSE NULL END,
          result_correction_deadline = CASE WHEN ? = 'result_pending' THEN ? ELSE NULL END,
          pending_candidate_hash = CASE WHEN ? = 'result_pending' THEN ? ELSE NULL END,
          pending_diagnostics_json = CASE WHEN ? = 'result_pending' THEN '[]' ELSE NULL END
        WHERE id = 'attempt-history'
      `).run(
        status, status, status, status, "2026-08-20T12:05:00.000Z",
        status, "9".repeat(64), status,
      );

      expect(() => acceptRelease(initializedEpoch)).toThrow(/nonterminal Attempts remain/);
    },
  );

  it.each(["pending", "processing", "unknown"] as const)(
    "rejects nonterminal Effect state %s",
    (status) => {
      const initializedEpoch = initialized();
      seedSettledEvidence(initializedEpoch.db);
      initializedEpoch.db.prepare(`
        INSERT INTO effects (
          id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
          payload_schema, inline_payload, intent_hash, status, version, attempt_count,
          available_at, lease_id, lease_worker_id, lease_expires_at, lease_execution_mode,
          unknown_detail, created_at, updated_at
        ) VALUES ('effect-active', 'run-history', 'decision-history', 'test/effect@1',
          'effect-active-key', 'target', 'test.effect/v1', '{}', ?, ?, 0, 0, ?,
          CASE WHEN ? = 'processing' THEN 'effect-lease' ELSE NULL END,
          CASE WHEN ? = 'processing' THEN 'worker' ELSE NULL END,
          CASE WHEN ? = 'processing' THEN ? ELSE NULL END,
          CASE WHEN ? = 'processing' THEN 'dispatch_or_reconcile' ELSE NULL END,
          CASE WHEN ? = 'unknown' THEN 'indeterminate' ELSE NULL END, ?, ?)
      `).run(
        "a".repeat(64), status, NOW, status, status, status,
        "2026-08-20T12:05:00.000Z", status, status, NOW, NOW,
      );

      expect(() => acceptRelease(initializedEpoch)).toThrow(/nonterminal Effects remain/);
    },
  );

  it("fails closed for schema or identity drift and for conflicting replay", () => {
    const initializedEpoch = initialized();
    const request = releaseRequest(initializedEpoch);
    expect(() => acceptRelease(initializedEpoch, {
      ...request,
      candidate_schema_checksum: "f".repeat(64),
    })).toThrow(/fresh epoch is required/);
    expect(() => acceptRelease(initializedEpoch, {
      ...request,
      candidate_identity: { ...request.candidate_identity, bootstrap_checksum: "f".repeat(64) },
    })).toThrow(/may change only/);

    const receipt = acceptRelease(initializedEpoch, request);
    expect(receipt.sequence).toBe(1);
    expect(() => acceptRelease(initializedEpoch, {
      ...request,
      candidate_identity: {
        ...request.candidate_identity,
        runtime_capability_digest: "e".repeat(64),
      },
    })).toThrow(/transition_id conflicts/);
  });

  it.each(["pins_advanced", "evidence_inserted"] as const)(
    "rolls back pins, evidence, and trigger state when %s fails",
    (step) => {
      const initializedEpoch = initialized();
      const request = releaseRequest(initializedEpoch);
      initializedEpoch.db.close();

      expect(() => acceptFreshEpochRelease({
        database_path: initializedEpoch.database_path,
        blob_store: initializedEpoch.blob_store,
        request,
        now: () => "2026-08-21T12:00:00.000Z",
        fault_injector: (observed) => {
          if (observed === step) throw new Error(`injected ${step} failure`);
        },
      })).toThrow(`injected ${step} failure`);

      const old = openFreshEpochDatabase({
        database_path: initializedEpoch.database_path,
        blob_store: initializedEpoch.blob_store,
        expected_identity: initializedEpoch.expected_identity,
      });
      expect(old.prepare(`
        SELECT COUNT(*) AS count FROM settings WHERE key GLOB 'epoch.release_acceptance.*'
      `).get()).toEqual({ count: 0 });
      expect(() => old.prepare(`
        UPDATE settings SET value_json = '"release-b"' WHERE key = 'epoch.release_id'
      `).run()).toThrow(/immutable setting/);
      old.close();
    },
  );

  it.each([
    ["empty", (path: string) => writeFileSync(path, "")],
    ["old", (path: string) => {
      const legacy = new Database(path);
      legacy.exec("CREATE TABLE tickets (id TEXT PRIMARY KEY)");
      legacy.close();
    }],
    ["partial", (path: string) => {
      const partial = new Database(path);
      partial.exec("CREATE TABLE settings (key TEXT PRIMARY KEY)");
      partial.close();
    }],
  ])("refuses a pre-existing %s target without changing one byte", (_name, create) => {
    const directory = temporaryDirectory();
    const path = join(directory, "epoch.sqlite");
    const blob_store = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
    create(path);
    const before = digest(path);
    expect(() => openFreshEpochDatabase({
      database_path: path,
      blob_store,
      expected_identity: {
        release_id: "release-a",
        runtime_capability_digest: RUNTIME_CAPABILITY,
        blob_store_id: blob_store.store_id,
        blob_marker_checksum: blob_store.marker_checksum,
        bootstrap_checksum: bootstrap().checksum,
      },
    })).toThrow(FreshEpochRefusalError);
    expect(digest(path)).toBe(before);
  });

  it("rejects schema drift and undeclared objects before opening a writer", () => {
    const initializedEpoch = initialized();
    initializedEpoch.db.close();
    const mutator = new Database(initializedEpoch.database_path);
    mutator.exec("CREATE TABLE undeclared (id TEXT PRIMARY KEY)");
    mutator.close();
    const before = digest(initializedEpoch.database_path);

    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: initializedEpoch.expected_identity,
    })).toThrow(/partial, drifted, or undeclared/);
    expect(digest(initializedEpoch.database_path)).toBe(before);
  });

  it("fails closed when foreign keys are disabled on a verification connection", () => {
    const initializedEpoch = initialized();
    initializedEpoch.db.close();
    const read = new Database(initializedEpoch.database_path, { readonly: true });
    try {
      read.pragma("foreign_keys = OFF");
      expect(read.pragma("foreign_keys", { simple: true })).toBe(0);
      expect(() => verifyFreshEpochDatabase(read, initializedEpoch.expected_identity))
        .toThrow(/foreign keys are disabled/);
    } finally {
      read.close();
    }
  });

  it("rejects invalid, oversized-shape, duplicate, and tampered bootstraps before a database exists", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "epoch.sqlite");
    const blob_store = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
    const valid = bootstrap();
    const tampered: FreshEpochBootstrap = {
      ...valid,
      settings: [...valid.settings, {
        key: "operator.extra",
        value: true,
        value_type: "boolean",
        mutable: true,
      }],
    };
    expect(() => initializeFreshEpochDatabase({
      database_path: path,
      blob_store,
      release_id: "release-a",
      runtime_capability_digest: RUNTIME_CAPABILITY,
      bootstrap: tampered,
    })).toThrow(/checksum mismatch/);
    expect(() => readFileSync(path)).toThrow();

    expect(() => initializeFreshEpochDatabase({
      database_path: path,
      blob_store,
      release_id: "release-a",
      runtime_capability_digest: "C".repeat(64),
      bootstrap: valid,
    })).toThrow(/lowercase SHA-256/);
    expect(() => readFileSync(path)).toThrow();

    expect(() => createFreshEpochBootstrap({
      schema: "openthrottle.fresh-epoch-bootstrap/v1",
      settings: [
        { key: "same", value: 1, value_type: "number", mutable: true },
        { key: "same", value: 2, value_type: "number", mutable: true },
      ],
      repository_registrations: [],
    })).toThrow(/duplicate setting key/);
    expect(() => readFileSync(path)).toThrow();
  });

  it.each(["-journal", "-wal", "-shm"])("refuses a dangling %s sidecar before database publication", (suffix) => {
    const directory = temporaryDirectory();
    const path = join(directory, "epoch.sqlite");
    const blob_store = VolumeBlobStore.initialize(join(directory, "blobs"), "store-a");
    writeFileSync(`${path}${suffix}`, "dangling sidecar");

    expect(() => initializeFreshEpochDatabase({
      database_path: path,
      blob_store,
      release_id: "release-a",
      runtime_capability_digest: RUNTIME_CAPABILITY,
      bootstrap: bootstrap(),
    })).toThrow(/sidecar/);
    expect(() => readFileSync(path)).toThrow();
  });
});
