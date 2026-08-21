import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRESH_EPOCH_TABLES } from "../persistence/epoch-schema.js";
import { VolumeBlobStore } from "../persistence/blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
} from "../persistence/epoch-database.js";
import { openKernelEpoch } from "./kernel-bootstrap.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("openKernelEpoch", () => {
  it("reopens a nonempty bootstrap only through its exact pinned identity", () => {
    directory = mkdtempSync(join(tmpdir(), "openthrottle-production-kernel-"));
    const databasePath = join(directory, "epoch.sqlite");
    const blobStorePath = join(directory, "blobs");
    const blobs = VolumeBlobStore.initialize(blobStorePath, "blob-release");
    const bootstrap = createFreshEpochBootstrap({
      schema: "openthrottle.fresh-epoch-bootstrap/v1",
      settings: [
        { key: "operator.mode", value: "dogfood", value_type: "string", mutable: false },
      ],
      repository_registrations: [{
        id: "registration-github",
        control_provider: "github",
        route_key: "owner/repo",
        linear_team_id: null,
        linear_team_key: null,
        github_repo: "owner/repo",
        github_installation_id: 42,
        base_branch: "main",
        webhook_id: 7,
        runtime_snapshot: "snapshot-v1",
      }],
    });
    initializeFreshEpochDatabase({
      database_path: databasePath,
      blob_store: blobs,
      release_id: "kernel-release",
      runtime_capability_digest: "c".repeat(64),
      bootstrap,
      now: () => "2026-08-20T12:00:00.000Z",
    }).close();
    const input = {
      database_path: databasePath,
      blob_store_path: blobStorePath,
      blob_store_id: "blob-release",
      release_id: "kernel-release",
      runtime_capability_digest: "c".repeat(64),
      bootstrap_checksum: bootstrap.checksum,
    };
    const reopened = openKernelEpoch(input);
    expect(reopened.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => (row as { name: string }).name)).toEqual(
      [...FRESH_EPOCH_TABLES].sort(),
    );
    expect(reopened.db.prepare("SELECT value_json FROM settings WHERE key = 'operator.mode'").get())
      .toEqual({ value_json: '"dogfood"' });
    expect(reopened.db.prepare("SELECT github_repo FROM repository_registrations").get())
      .toEqual({ github_repo: "owner/repo" });
    expect(reopened.blobs.store_id).toBe("blob-release");
    reopened.db.close();

    expect(() => openKernelEpoch({
      ...input,
      bootstrap_checksum: "d".repeat(64),
    })).toThrow(/identity mismatch/);
  });

  it.each([
    ["runtime capability", { runtime_capability_digest: "NOT-A-DIGEST", bootstrap_checksum: "b".repeat(64) }],
    ["bootstrap", { runtime_capability_digest: "c".repeat(64), bootstrap_checksum: "NOT-A-DIGEST" }],
  ])("rejects an invalid %s digest before creating storage paths", (_name, digests) => {
    directory = mkdtempSync(join(tmpdir(), "openthrottle-production-kernel-"));
    const databasePath = join(directory, "state", "epoch.sqlite");
    const blobStorePath = join(directory, "state", "blobs");

    expect(() => openKernelEpoch({
      database_path: databasePath,
      blob_store_path: blobStorePath,
      blob_store_id: "blob-release",
      release_id: "kernel-release",
      ...digests,
    })).toThrow(/must be a lowercase SHA-256 digest/);

    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(blobStorePath)).toBe(false);
    expect(existsSync(join(directory, "state"))).toBe(false);
  });

  it("never creates missing production database or blob paths", () => {
    directory = mkdtempSync(join(tmpdir(), "openthrottle-production-kernel-"));
    const statePath = join(directory, "state");
    const databasePath = join(statePath, "epoch.sqlite");
    const blobStorePath = join(statePath, "blobs");
    const input = {
      database_path: databasePath,
      blob_store_path: blobStorePath,
      blob_store_id: "blob-release",
      release_id: "kernel-release",
      runtime_capability_digest: "c".repeat(64),
      bootstrap_checksum: "b".repeat(64),
    };

    expect(() => openKernelEpoch(input)).toThrow();
    expect(existsSync(statePath)).toBe(false);

    mkdirSync(statePath, { mode: 0o700 });
    VolumeBlobStore.initialize(blobStorePath, "blob-release");
    expect(() => openKernelEpoch(input)).toThrow();
    expect(existsSync(databasePath)).toBe(false);
  });
});
