#!/usr/bin/env node

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const HELP = `Usage: initialize-epoch.mjs

Initializes or verifies one empty execution epoch from the exact packaged
release. Storage must be either both absent, an exact empty BlobStore-only
partial, or an exact bootstrap-only pair. Normal supervisor startup remains
open-only. The command prints the bootstrap checksum required by
OT_EPOCH_BOOTSTRAP_CHECKSUM.
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const BLOB_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DATABASE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"];

function fail(detail) {
  throw new Error(`fresh epoch initialization: ${detail}`);
}

function value(name, fallback) {
  const candidate = process.env[name];
  return candidate && candidate.trim() !== "" ? candidate : fallback;
}

function identifier(name, candidate, pattern = ID) {
  if (!pattern.test(candidate)) fail(`${name} has an invalid format`);
  return candidate;
}

function absolutePath(name, candidate) {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate || candidate === "/") {
    fail(`${name} must be an absolute normalized non-root path`);
  }
  const parent = dirname(candidate);
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) fail(`${name} parent must not traverse a symlink`);
  const metadata = lstatSync(canonicalParent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${name} parent must be a real directory`);
  }
  return join(canonicalParent, basename(candidate));
}

function isWithin(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function pathEntryExists(path) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function storageState(databasePath, blobStorePath) {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    if (pathEntryExists(`${databasePath}${suffix}`)) {
      fail(`database sidecar exists: ${databasePath}${suffix}`);
    }
  }
  const databaseExists = pathEntryExists(databasePath);
  const blobStoreExists = pathEntryExists(blobStorePath);
  if (!databaseExists && !blobStoreExists) return "absent";
  if (!databaseExists && blobStoreExists) return "blob_only";
  if (databaseExists && blobStoreExists) return "bootstrap_pair";
  fail("database path exists without the BlobStore path");
}

function configuration() {
  const databasePath = absolutePath(
    "DATABASE_PATH",
    value("DATABASE_PATH", "/data/openthrottle-kernel-v1.sqlite"),
  );
  const blobStorePath = absolutePath(
    "OT_BLOB_STORE_PATH",
    value("OT_BLOB_STORE_PATH", "/data/openthrottle-kernel-v1-blobs"),
  );
  if (isWithin(blobStorePath, databasePath) || isWithin(databasePath, blobStorePath)) {
    fail("database and blob paths must be distinct and non-nested");
  }
  if (
    statSync(dirname(databasePath), { bigint: true }).dev !==
    statSync(dirname(blobStorePath), { bigint: true }).dev
  ) {
    fail("database and blob paths must be on the same volume");
  }
  const releaseRoot = absolutePath(
    "OT_RELEASE_ROOT",
    value("OT_RELEASE_ROOT", process.cwd()),
  );
  const generatedRoot = absolutePath(
    "OT_GENERATED_DEFINITION_ROOT",
    value("OT_GENERATED_DEFINITION_ROOT", join(releaseRoot, "contracts/generated")),
  );
  return Object.freeze({
    databasePath,
    blobStorePath,
    blobStoreId: identifier(
      "OT_BLOB_STORE_ID",
      value("OT_BLOB_STORE_ID", "openthrottle-execution-kernel-v1"),
      BLOB_STORE_ID,
    ),
    releaseId: identifier(
      "OT_EPOCH_RELEASE_ID",
      value("OT_EPOCH_RELEASE_ID", "openthrottle-execution-kernel/v1"),
    ),
    releaseRoot,
    generatedRoot,
    storageState: storageState(databasePath, blobStorePath),
  });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.length !== 2) fail("usage: initialize-epoch.mjs");

  const config = configuration();
  const [releaseModule, databaseModule, blobModule] = await Promise.all([
    import("../dist/app/kernel-release.js"),
    import("../dist/persistence/epoch-database.js"),
    import("../dist/persistence/blob-store.js"),
  ]);
  const release = releaseModule.loadKernelReleaseDefinitions({
    release_root: config.releaseRoot,
    generated_root: config.generatedRoot,
  });
  const bootstrap = databaseModule.createFreshEpochBootstrap({
    schema: databaseModule.FRESH_EPOCH_BOOTSTRAP_SCHEMA,
    settings: [],
    repository_registrations: [],
  });
  const blobs = config.storageState === "absent"
    ? blobModule.VolumeBlobStore.initialize(config.blobStorePath, config.blobStoreId)
    : blobModule.VolumeBlobStore.open(config.blobStorePath, config.blobStoreId);
  blobs.assertEmpty();
  const expectedIdentity = {
    release_id: config.releaseId,
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
    blob_store_id: blobs.store_id,
    blob_marker_checksum: blobs.marker_checksum,
    bootstrap_checksum: bootstrap.checksum,
  };
  const db = config.storageState === "bootstrap_pair"
    ? databaseModule.inspectFreshEpochDatabase({
      database_path: config.databasePath,
      blob_store: blobs,
      expected_identity: expectedIdentity,
    })
    : databaseModule.initializeFreshEpochDatabase({
      database_path: config.databasePath,
      blob_store: blobs,
      release_id: config.releaseId,
      runtime_capability_digest: release.execution_policy.runtime_capability_digest,
      bootstrap,
    });
  let receipt;
  try {
    const verification = databaseModule.verifyFreshEpochDatabase(db, expectedIdentity);
    databaseModule.verifyFreshEpochBootstrapOnly(db, bootstrap);
    receipt = {
      schema: "openthrottle.fresh-epoch-initialization/v1",
      database_path: config.databasePath,
      blob_store_path: config.blobStorePath,
      blob_store_id: verification.blob_store_id,
      blob_marker_checksum: verification.blob_marker_checksum,
      release_id: verification.release_id,
      runtime_capability_digest: verification.runtime_capability_digest,
      bootstrap_checksum: verification.bootstrap_checksum,
      schema_version: verification.schema_version,
      schema_checksum: verification.schema_checksum,
      maintenance_ingress_closed: true,
      integrity: verification.integrity,
    };
  } finally {
    db.close();
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
