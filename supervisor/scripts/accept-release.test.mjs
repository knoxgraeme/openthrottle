import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadKernelReleaseDefinitions } from "../src/app/kernel-release.js";
import { VolumeBlobStore } from "../src/persistence/blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
} from "../src/persistence/epoch-database.js";

const supervisorRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = realpathSync(join(supervisorRoot, ".."));
const temporaryRoot = realpathSync(tmpdir());
const cliPath = join(supervisorRoot, "scripts/accept-release.mjs");
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openthrottle-accept-release-")));
  directories.push(root);
  const databasePath = join(root, "kernel.sqlite");
  const blobPath = join(root, "kernel-blobs");
  const blobs = VolumeBlobStore.initialize(blobPath, "dogfood-kernel-v1");
  const release = loadKernelReleaseDefinitions({
    release_root: repoRoot,
    generated_root: join(repoRoot, "contracts/generated"),
  });
  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [],
  });
  initializeFreshEpochDatabase({
    database_path: databasePath,
    blob_store: blobs,
    release_id: "dogfood-kernel/v1",
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
    bootstrap,
  }).close();
  return { root, databasePath, blobPath, blobs, bootstrap, release };
}

function run(value, overrides = {}, args = []) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: supervisorRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_PATH: value.databasePath,
      OT_BLOB_STORE_PATH: value.blobPath,
      OT_BLOB_STORE_ID: "dogfood-kernel-v1",
      OT_EPOCH_RELEASE_ID: "dogfood-kernel/v2",
      OT_RELEASE_ROOT: repoRoot,
      OT_GENERATED_DEFINITION_ROOT: join(repoRoot, "contracts/generated"),
      ...overrides,
    },
    timeout: 20_000,
  });
}

describe("accept-release process boundary", () => {
  it("prints bounded help without loading built supervisor modules", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openthrottle-accept-help-")));
    directories.push(root);
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    const isolatedCli = join(scripts, "accept-release.mjs");
    copyFileSync(cliPath, isolatedCli);

    const result = spawnSync(process.execPath, [isolatedCli, "--help"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: accept-release.mjs");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_024);
  });

  it("prints the packaged candidate identity without opening storage", () => {
    const value = {
      databasePath: join(temporaryRoot, "missing-accept-release.sqlite"),
      blobPath: join(temporaryRoot, "missing-accept-release-blobs"),
    };
    const result = run(value, { OT_EPOCH_RELEASE_ID: `sha256:${"a".repeat(64)}` }, [
      "--print-identity",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "openthrottle.epoch-release-candidate/v1",
      release_id: `sha256:${"a".repeat(64)}`,
      runtime_capability_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      schema_checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("accepts the packaged identity once and leaves old boot identity refused", () => {
    const value = fixture();
    const result = run(value);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({
      schema: "openthrottle.epoch-release-acceptance/v1",
      previous_identity: { release_id: "dogfood-kernel/v1" },
      accepted_identity: {
        release_id: "dogfood-kernel/v2",
        runtime_capability_digest: value.release.execution_policy.runtime_capability_digest,
      },
      maintenance_ingress_closed: true,
    });
    const db = new Database(value.databasePath, { readonly: true });
    expect(JSON.parse(db.prepare(`
      SELECT value_json FROM settings WHERE key = 'epoch.release_acceptance_evidence'
    `).get().value_json)).toEqual(receipt);
    db.close();

    expect(() => openFreshEpochDatabase({
      database_path: value.databasePath,
      blob_store: value.blobs,
      expected_identity: {
        release_id: "dogfood-kernel/v1",
        runtime_capability_digest: value.release.execution_policy.runtime_capability_digest,
        blob_store_id: value.blobs.store_id,
        blob_marker_checksum: value.blobs.marker_checksum,
        bootstrap_checksum: value.bootstrap.checksum,
      },
    })).toThrow(/identity mismatch/);

    const repeated = run(value);
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("already pinned");
  });
});
