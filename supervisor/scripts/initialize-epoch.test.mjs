import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshEpochBootstrap } from "../src/persistence/epoch-database.js";
import { FRESH_EPOCH_TABLES } from "../src/persistence/epoch-schema.js";
import { openKernelEpoch } from "../src/app/kernel-bootstrap.js";
import { VolumeBlobStore } from "../src/persistence/blob-store.js";

const supervisorRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = realpathSync(join(supervisorRoot, ".."));
const cliPath = join(supervisorRoot, "scripts/initialize-epoch.mjs");
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openthrottle-epoch-init-")));
  directories.push(root);
  return {
    root,
    databasePath: join(root, "kernel.sqlite"),
    blobPath: join(root, "kernel-blobs"),
  };
}

function environment(value, overrides = {}) {
  return {
    ...process.env,
    DATABASE_PATH: value.databasePath,
    OT_BLOB_STORE_PATH: value.blobPath,
    OT_BLOB_STORE_ID: "dogfood-kernel-v1",
    OT_EPOCH_RELEASE_ID: "dogfood-kernel/v1",
    OT_RELEASE_ROOT: repoRoot,
    OT_GENERATED_DEFINITION_ROOT: join(repoRoot, "contracts/generated"),
    ...overrides,
  };
}

function run(value, overrides = {}, args = []) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: supervisorRoot,
    encoding: "utf8",
    env: environment(value, overrides),
    timeout: 20_000,
  });
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("initialize-epoch process boundary", () => {
  it("prints bounded help without loading built supervisor modules", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openthrottle-epoch-help-")));
    directories.push(root);
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    const isolatedCli = join(scripts, "initialize-epoch.mjs");
    copyFileSync(cliPath, isolatedCli);

    const result = spawnSync(process.execPath, [isolatedCli, "--help"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: initialize-epoch.mjs");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_024);
  });

  it("initializes one exact empty epoch with ingress closed", () => {
    const value = fixture();
    const result = run(value);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout);
    const bootstrap = createFreshEpochBootstrap({
      schema: "openthrottle.fresh-epoch-bootstrap/v1",
      settings: [],
      repository_registrations: [],
    });
    expect(receipt).toEqual({
      schema: "openthrottle.fresh-epoch-initialization/v1",
      database_path: value.databasePath,
      blob_store_path: value.blobPath,
      blob_store_id: "dogfood-kernel-v1",
      blob_marker_checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      release_id: "dogfood-kernel/v1",
      runtime_capability_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      bootstrap_checksum: bootstrap.checksum,
      schema_version: expect.any(Number),
      schema_checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      maintenance_ingress_closed: true,
      integrity: "ok",
    });

    const db = new Database(value.databasePath, { readonly: true, fileMustExist: true });
    try {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual([...FRESH_EPOCH_TABLES].sort());
      expect(db.prepare("SELECT value_json, version FROM settings WHERE key = ?")
        .get("epoch.maintenance_ingress_closed")).toEqual({ value_json: "true", version: 0 });
      for (const table of [
        "work_items", "inbox_events", "definitions", "pipeline_runs", "attempts",
        "records", "effects", "checkpoints",
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      db.close();
    }

    const opened = openKernelEpoch({
      database_path: value.databasePath,
      blob_store_path: value.blobPath,
      blob_store_id: receipt.blob_store_id,
      release_id: receipt.release_id,
      runtime_capability_digest: receipt.runtime_capability_digest,
      bootstrap_checksum: receipt.bootstrap_checksum,
    });
    expect(opened.db.prepare("SELECT value_json FROM settings WHERE key = ?")
      .get("epoch.maintenance_ingress_closed")).toEqual({ value_json: "true" });
    opened.db.close();
  });

  it("re-emits the exact receipt from an initialized bootstrap-only pair", () => {
    const value = fixture();
    const first = run(value);
    expect(first.status, first.stderr).toBe(0);
    const databaseDigest = digest(value.databasePath);
    const markerPath = join(value.blobPath, ".openthrottle-blob-store.json");
    const markerDigest = digest(markerPath);

    const second = run(value);

    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    expect(digest(value.databasePath)).toBe(databaseDigest);
    expect(digest(markerPath)).toBe(markerDigest);

    VolumeBlobStore.open(value.blobPath, "dogfood-kernel-v1").put({
      bytes: "orphaned object",
      encoding: "utf-8",
      media_type: "text/plain",
      payload_schema: "test.orphan/v1",
    });
    const nonemptyPair = run(value);
    expect(nonemptyPair.status).not.toBe(0);
    expect(nonemptyPair.stderr).toContain("not empty");
  });

  it("resumes an exact empty blob-only partial", () => {
    const value = fixture();
    const blobs = VolumeBlobStore.initialize(value.blobPath, "dogfood-kernel-v1");

    const result = run(value);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      database_path: value.databasePath,
      blob_store_id: blobs.store_id,
      blob_marker_checksum: blobs.marker_checksum,
      maintenance_ingress_closed: true,
    });
  });

  it("refuses database-only, nonempty, and unknown partial storage", () => {
    const value = fixture();
    writeFileSync(value.databasePath, "existing data", { mode: 0o600 });
    const before = digest(value.databasePath);

    const databaseOnly = run(value);

    expect(databaseOnly.status).not.toBe(0);
    expect(databaseOnly.stderr).toContain("database path exists without the BlobStore path");
    expect(digest(value.databasePath)).toBe(before);
    expect(existsSync(value.blobPath)).toBe(false);

    const nonempty = fixture();
    const blobs = VolumeBlobStore.initialize(nonempty.blobPath, "dogfood-kernel-v1");
    blobs.put({
      bytes: "unexpected partial data",
      encoding: "utf-8",
      media_type: "text/plain",
      payload_schema: "test.partial/v1",
    });
    const nonemptyResult = run(nonempty);

    expect(nonemptyResult.status).not.toBe(0);
    expect(nonemptyResult.stderr).toContain("not empty");
    expect(existsSync(nonempty.databasePath)).toBe(false);

    const unknown = fixture();
    mkdirSync(unknown.blobPath);
    const unknownResult = run(unknown);

    expect(unknownResult.status).not.toBe(0);
    expect(unknownResult.stderr).toContain("blob root marker is missing");
    expect(existsSync(unknown.databasePath)).toBe(false);
  });

  it.each(["-journal", "-wal", "-shm"])("refuses dangling database %s before creating a BlobStore", (suffix) => {
    const value = fixture();
    writeFileSync(`${value.databasePath}${suffix}`, "dangling sidecar", { mode: 0o600 });

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("database sidecar exists");
    expect(existsSync(value.databasePath)).toBe(false);
    expect(existsSync(value.blobPath)).toBe(false);
  });

  it("validates identity and normalized absolute paths before creating storage", () => {
    const value = fixture();
    const invalidIdentity = run(value, { OT_EPOCH_RELEASE_ID: "unsafe value" });
    expect(invalidIdentity.status).not.toBe(0);
    expect(invalidIdentity.stderr).toContain("OT_EPOCH_RELEASE_ID has an invalid format");
    expect(existsSync(value.databasePath)).toBe(false);
    expect(existsSync(value.blobPath)).toBe(false);

    const relativePath = run(value, { DATABASE_PATH: "relative.sqlite" });
    expect(relativePath.status).not.toBe(0);
    expect(relativePath.stderr).toContain("DATABASE_PATH must be an absolute normalized non-root path");
    expect(existsSync(value.databasePath)).toBe(false);
    expect(existsSync(value.blobPath)).toBe(false);
  });

  it("treats a dangling symlink as an existing target and changes nothing", () => {
    const value = fixture();
    symlinkSync(join(value.root, "missing-target"), value.blobPath);

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("blob root must be a real directory");
    expect(existsSync(value.databasePath)).toBe(false);
    expect(lstatSync(value.blobPath).isSymbolicLink()).toBe(true);
  });
});
