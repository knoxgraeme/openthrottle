import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VolumeBlobStore } from "../src/persistence/blob-store.js";
import {
  createFreshEpochBootstrap,
  initializeFreshEpochDatabase,
  openFreshEpochDatabase,
} from "../src/persistence/epoch-database.js";

const supervisorRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = realpathSync(join(supervisorRoot, ".."));
const cliPath = join(supervisorRoot, "scripts/accept-release.mjs");
const directories = [];
const OLD_RUNTIME = "f".repeat(64);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openthrottle-accept-release-")));
  directories.push(root);
  const databasePath = join(root, "kernel.sqlite");
  const blobPath = join(root, "kernel-blobs");
  const blobs = VolumeBlobStore.initialize(blobPath, "accept-release-test");
  const bootstrap = createFreshEpochBootstrap({
    schema: "openthrottle.fresh-epoch-bootstrap/v1",
    settings: [],
    repository_registrations: [],
  });
  const db = initializeFreshEpochDatabase({
    database_path: databasePath,
    blob_store: blobs,
    release_id: "release-old",
    runtime_capability_digest: OLD_RUNTIME,
    bootstrap,
    now: () => "2026-08-20T12:00:00.000Z",
  });
  db.close();
  return { root, databasePath, blobPath, blobs, bootstrap };
}

function environment(value, overrides = {}) {
  return {
    ...process.env,
    DATABASE_PATH: value.databasePath,
    OT_BLOB_STORE_PATH: value.blobPath,
    OT_BLOB_STORE_ID: value.blobs.store_id,
    OT_EPOCH_RELEASE_ID: "release-candidate",
    OT_EPOCH_BOOTSTRAP_CHECKSUM: value.bootstrap.checksum,
    OT_ACCEPT_RELEASE_EXPECTED_RELEASE_ID: "release-old",
    OT_ACCEPT_RELEASE_EXPECTED_RUNTIME_CAPABILITY_DIGEST: OLD_RUNTIME,
    OT_ACCEPT_RELEASE_MAINTENANCE_VERSION: "0",
    OT_ACCEPT_RELEASE_TRANSITION_ID: "candidate-transition",
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

describe("accept-release process boundary", () => {
  it("prints bounded help without loading built modules", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: supervisorRoot,
      encoding: "utf8",
      env: {},
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: accept-release.mjs");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_024);
  });

  it("authenticates the packaged candidate, accepts it once, and replays the receipt", () => {
    const value = fixture();
    const first = run(value);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toBe("");
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({
      schema: "openthrottle.epoch-release-acceptance/v1",
      transition_id: "candidate-transition",
      sequence: 1,
      from_identity: {
        release_id: "release-old",
        runtime_capability_digest: OLD_RUNTIME,
      },
      to_identity: { release_id: "release-candidate" },
    });
    expect(receipt.to_identity.runtime_capability_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.to_identity.runtime_capability_digest).not.toBe(OLD_RUNTIME);

    const second = run(value);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(receipt);

    const opened = openFreshEpochDatabase({
      database_path: value.databasePath,
      blob_store: value.blobs,
      expected_identity: receipt.to_identity,
    });
    opened.close();
  });

  it("refuses stale fences and unauthenticated candidate artifacts without changing the pins", () => {
    const stale = fixture();
    const staleResult = run(stale, { OT_ACCEPT_RELEASE_MAINTENANCE_VERSION: "1" });
    expect(staleResult.status).not.toBe(0);
    expect(staleResult.stderr).toContain("maintenance version is stale");

    const generated = join(stale.root, "generated");
    cpSync(join(repoRoot, "contracts/generated"), generated, { recursive: true });
    const environmentPath = join(generated, "compiler-environment.json");
    const before = readFileSync(environmentPath, "utf8");
    writeFileSync(environmentPath, `${before.slice(0, -2)},"unexpected":true}\n`);
    const unauthenticated = run(stale, { OT_GENERATED_DEFINITION_ROOT: generated });
    expect(unauthenticated.status).not.toBe(0);
    expect(unauthenticated.stderr).toMatch(/compiler.environment|unknown|missing/i);

    const old = openFreshEpochDatabase({
      database_path: stale.databasePath,
      blob_store: stale.blobs,
      expected_identity: {
        release_id: "release-old",
        runtime_capability_digest: OLD_RUNTIME,
        blob_store_id: stale.blobs.store_id,
        blob_marker_checksum: stale.blobs.marker_checksum,
        bootstrap_checksum: stale.bootstrap.checksum,
      },
    });
    expect(old.prepare(`
      SELECT COUNT(*) AS count FROM settings WHERE key GLOB 'epoch.release_acceptance.*'
    `).get()).toEqual({ count: 0 });
    old.close();
  });

  it("rejects malformed caller-authored identity before opening the database", () => {
    const value = fixture();
    const before = readFileSync(value.databasePath);
    const result = run(value, { OT_ACCEPT_RELEASE_EXPECTED_RUNTIME_CAPABILITY_DIGEST: "BAD" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lowercase SHA-256 digest");
    expect(readFileSync(value.databasePath)).toEqual(before);
  });
});
