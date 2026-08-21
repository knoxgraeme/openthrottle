import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
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
  createFreshEpochBootstrap,
  FreshEpochRefusalError,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
  openOrInitializeFreshEpochDatabase,
  verifyFreshEpochDatabase,
  type FreshEpochBootstrap,
  type FreshEpochIdentity,
} from "./epoch-database.js";
import { FRESH_EPOCH_TABLES } from "./epoch-schema.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-20T12:00:00.000Z";

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
    bootstrap: manifest,
    now: () => NOW,
  });
  const expected_identity: FreshEpochIdentity = {
    release_id: "release-a",
    blob_store_id: blob_store.store_id,
    blob_marker_checksum: blob_store.marker_checksum,
    bootstrap_checksum: manifest.checksum,
  };
  return { directory, blob_store, database_path, manifest, db, expected_identity };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("fresh epoch database", () => {
  it("publishes a checksummed bootstrap atomically into exactly twelve tables", () => {
    const { db, database_path, blob_store, expected_identity } = initialized();
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
      expect(db.prepare("SELECT key, mutable FROM settings ORDER BY key").all()).toEqual([
        { key: "epoch.blob_marker_checksum", mutable: 0 },
        { key: "epoch.blob_store_id", mutable: 0 },
        { key: "epoch.bootstrap_checksum", mutable: 0 },
        { key: "epoch.release_id", mutable: 0 },
        { key: "operator.mode", mutable: 0 },
        { key: "operator.poll_batch_size", mutable: 1 },
      ]);
      expect(() => db.prepare("UPDATE settings SET value_json = '\"changed\"' WHERE key = 'epoch.release_id'").run())
        .toThrow(/immutable setting/);
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

  it("reopens only the recognized release/bootstrap/blob-root tuple", () => {
    const initializedEpoch = initialized();
    initializedEpoch.db.close();
    const reopened = openOrInitializeFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      release_id: "release-a",
      bootstrap: initializedEpoch.manifest,
    });
    reopened.close();

    const before = digest(initializedEpoch.database_path);
    expect(() => openFreshEpochDatabase({
      database_path: initializedEpoch.database_path,
      blob_store: initializedEpoch.blob_store,
      expected_identity: { ...initializedEpoch.expected_identity, release_id: "release-b" },
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
    expect(() => openOrInitializeFreshEpochDatabase({
      database_path: path,
      blob_store,
      release_id: "release-a",
      bootstrap: bootstrap(),
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
      bootstrap: tampered,
    })).toThrow(/checksum mismatch/);
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
});
