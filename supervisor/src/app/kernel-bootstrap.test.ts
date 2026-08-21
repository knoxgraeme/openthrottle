import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRESH_EPOCH_TABLES } from "../persistence/epoch-schema.js";
import { openKernelEpoch } from "./kernel-bootstrap.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("openKernelEpoch", () => {
  it("initializes and reopens only the fresh schema and paired blob identity", () => {
    directory = mkdtempSync(join(tmpdir(), "openthrottle-production-kernel-"));
    const input = {
      database_path: join(directory, "state", "epoch.sqlite"),
      blob_store_path: join(directory, "state", "blobs"),
      blob_store_id: "blob-release",
      release_id: "kernel-release",
      runtime_capability_digest: "c".repeat(64),
      now: () => "2026-08-20T12:00:00.000Z",
    };
    const first = openKernelEpoch(input);
    expect(first.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => (row as { name: string }).name)).toEqual(
      [...FRESH_EPOCH_TABLES].sort(),
    );
    first.db.close();

    const reopened = openKernelEpoch(input);
    expect(reopened.blobs.store_id).toBe("blob-release");
    reopened.db.close();
  });

  it("rejects an invalid runtime capability digest before creating storage paths", () => {
    directory = mkdtempSync(join(tmpdir(), "openthrottle-production-kernel-"));
    const databasePath = join(directory, "state", "epoch.sqlite");
    const blobStorePath = join(directory, "state", "blobs");

    expect(() => openKernelEpoch({
      database_path: databasePath,
      blob_store_path: blobStorePath,
      blob_store_id: "blob-release",
      release_id: "kernel-release",
      runtime_capability_digest: "NOT-A-DIGEST",
    })).toThrow(/runtime_capability_digest must be a lowercase SHA-256 digest/);

    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(blobStorePath)).toBe(false);
    expect(existsSync(join(directory, "state"))).toBe(false);
  });
});
