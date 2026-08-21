import { mkdtempSync, rmSync } from "node:fs";
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
});
