#!/usr/bin/env node

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const HELP = `Usage: accept-release.mjs [--print-identity]

Advances an existing closed, quiesced execution epoch to the exact packaged
release identity. The database schema must be unchanged. The command updates
both identity pins atomically, persists a receipt, and prints that receipt.
--print-identity prints the packaged candidate identity without opening storage.
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const BLOB_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function fail(detail) {
  throw new Error(`epoch release acceptance: ${detail}`);
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

function configuration() {
  const releaseRoot = absolutePath(
    "OT_RELEASE_ROOT",
    value("OT_RELEASE_ROOT", process.cwd()),
  );
  return Object.freeze({
    databasePath: absolutePath(
      "DATABASE_PATH",
      value("DATABASE_PATH", "/data/openthrottle-kernel-v1.sqlite"),
    ),
    blobStorePath: absolutePath(
      "OT_BLOB_STORE_PATH",
      value("OT_BLOB_STORE_PATH", "/data/openthrottle-kernel-v1-blobs"),
    ),
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
    generatedRoot: absolutePath(
      "OT_GENERATED_DEFINITION_ROOT",
      value("OT_GENERATED_DEFINITION_ROOT", join(releaseRoot, "contracts/generated")),
    ),
  });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const printIdentity = process.argv.length === 3 && process.argv[2] === "--print-identity";
  if (process.argv.length !== 2 && !printIdentity) fail("usage: accept-release.mjs [--print-identity]");

  const config = configuration();
  const [releaseModule, databaseModule, blobModule, schemaModule] = await Promise.all([
    import("../dist/app/kernel-release.js"),
    import("../dist/persistence/epoch-database.js"),
    import("../dist/persistence/blob-store.js"),
    import("../dist/persistence/epoch-schema.js"),
  ]);
  const release = releaseModule.loadKernelReleaseDefinitions({
    release_root: config.releaseRoot,
    generated_root: config.generatedRoot,
  });
  const packagedIdentity = {
    schema: "openthrottle.epoch-release-candidate/v1",
    release_id: config.releaseId,
    runtime_capability_digest: release.execution_policy.runtime_capability_digest,
    schema_checksum: schemaModule.FRESH_EPOCH_SCHEMA_CHECKSUM,
  };
  if (printIdentity) {
    process.stdout.write(`${JSON.stringify(packagedIdentity)}\n`);
    return;
  }
  const blobs = blobModule.VolumeBlobStore.open(config.blobStorePath, config.blobStoreId);
  const receipt = databaseModule.acceptFreshEpochRelease({
    database_path: config.databasePath,
    blob_store: blobs,
    release_id: identifier(
      "OT_ACCEPT_RELEASE_ID",
      value("OT_ACCEPT_RELEASE_ID", packagedIdentity.release_id),
    ),
    runtime_capability_digest: value(
      "OT_ACCEPT_RUNTIME_CAPABILITY_DIGEST",
      packagedIdentity.runtime_capability_digest,
    ),
    schema_checksum: value(
      "OT_ACCEPT_SCHEMA_CHECKSUM",
      packagedIdentity.schema_checksum,
    ),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
