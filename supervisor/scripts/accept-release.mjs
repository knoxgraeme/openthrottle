#!/usr/bin/env node

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const HELP = `Usage: accept-release.mjs [--candidate-identity|--verify-current]

Advances one quiesced execution epoch to this exact packaged release. The
epoch must be maintenance-closed at OT_ACCEPT_RELEASE_MAINTENANCE_VERSION and
must contain no live coordination state. Candidate digests are authenticated
from the packaged release; callers provide only the exact expected-current
identity and transition fence. One durable JSON receipt is printed.

--candidate-identity authenticates the packaged release without opening the
epoch and prints its bounded release/runtime/schema identity.

--verify-current opens an offline epoch read-only and proves its current pins,
schema, bootstrap, and BlobStore identities match the packaged candidate.
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const BLOB_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(detail) {
  throw new Error(`epoch release acceptance: ${detail}`);
}

function required(name) {
  const candidate = process.env[name];
  if (!candidate || candidate.trim() === "") fail(`${name} is required`);
  return candidate;
}

function value(name, fallback) {
  const candidate = process.env[name];
  return candidate && candidate.trim() !== "" ? candidate : fallback;
}

function identifier(name, candidate, pattern = ID) {
  if (!pattern.test(candidate)) fail(`${name} has an invalid format`);
  return candidate;
}

function digest(name, candidate) {
  if (!SHA256.test(candidate)) fail(`${name} must be a lowercase SHA-256 digest`);
  return candidate;
}

function nonnegativeInteger(name, candidate) {
  if (!/^(0|[1-9][0-9]*)$/.test(candidate)) fail(`${name} must be a nonnegative integer`);
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range`);
  return parsed;
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

function candidateConfiguration() {
  const releaseRoot = absolutePath("OT_RELEASE_ROOT", value("OT_RELEASE_ROOT", process.cwd()));
  return Object.freeze({
    candidateReleaseId: identifier("OT_EPOCH_RELEASE_ID", required("OT_EPOCH_RELEASE_ID")),
    releaseRoot,
    generatedRoot: absolutePath(
      "OT_GENERATED_DEFINITION_ROOT",
      value("OT_GENERATED_DEFINITION_ROOT", join(releaseRoot, "contracts/generated")),
    ),
  });
}

function storageConfiguration(candidate) {
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
  return Object.freeze({
    databasePath,
    blobStorePath,
    blobStoreId: identifier("OT_BLOB_STORE_ID", required("OT_BLOB_STORE_ID"), BLOB_STORE_ID),
    candidateReleaseId: candidate.candidateReleaseId,
    bootstrapChecksum: digest("OT_EPOCH_BOOTSTRAP_CHECKSUM", required("OT_EPOCH_BOOTSTRAP_CHECKSUM")),
    releaseRoot: candidate.releaseRoot,
    generatedRoot: candidate.generatedRoot,
  });
}

function configuration(storage) {
  return Object.freeze({
    ...storage,
    expectedReleaseId: identifier(
      "OT_ACCEPT_RELEASE_EXPECTED_RELEASE_ID",
      required("OT_ACCEPT_RELEASE_EXPECTED_RELEASE_ID"),
    ),
    expectedRuntimeCapabilityDigest: digest(
      "OT_ACCEPT_RELEASE_EXPECTED_RUNTIME_CAPABILITY_DIGEST",
      required("OT_ACCEPT_RELEASE_EXPECTED_RUNTIME_CAPABILITY_DIGEST"),
    ),
    maintenanceVersion: nonnegativeInteger(
      "OT_ACCEPT_RELEASE_MAINTENANCE_VERSION",
      required("OT_ACCEPT_RELEASE_MAINTENANCE_VERSION"),
    ),
    transitionId: identifier("OT_ACCEPT_RELEASE_TRANSITION_ID", required("OT_ACCEPT_RELEASE_TRANSITION_ID")),
  });
}

async function authenticatedCandidate() {
  const config = candidateConfiguration();
  const [releaseModule, schemaModule] = await Promise.all([
    import("../dist/app/kernel-release.js"),
    import("../dist/persistence/epoch-schema.js"),
  ]);
  const release = releaseModule.loadKernelReleaseDefinitions({
    release_root: config.releaseRoot,
    generated_root: config.generatedRoot,
  });
  return {
    config,
    identity: {
      schema: "openthrottle.accept-release-candidate/v1",
      release_id: config.candidateReleaseId,
      runtime_capability_digest: release.execution_policy.runtime_capability_digest,
      schema_version: schemaModule.FRESH_EPOCH_VERSION,
      schema_checksum: schemaModule.FRESH_EPOCH_SCHEMA_CHECKSUM,
    },
  };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--candidate-identity") {
    const candidate = await authenticatedCandidate();
    process.stdout.write(`${JSON.stringify(candidate.identity)}\n`);
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--verify-current") {
    const candidate = await authenticatedCandidate();
    const config = storageConfiguration(candidate.config);
    const [databaseModule, blobModule] = await Promise.all([
      import("../dist/persistence/epoch-database.js"),
      import("../dist/persistence/blob-store.js"),
    ]);
    const blobs = blobModule.VolumeBlobStore.open(config.blobStorePath, config.blobStoreId);
    const expectedIdentity = {
      release_id: config.candidateReleaseId,
      runtime_capability_digest: candidate.identity.runtime_capability_digest,
      blob_store_id: blobs.store_id,
      blob_marker_checksum: blobs.marker_checksum,
      bootstrap_checksum: config.bootstrapChecksum,
    };
    const db = databaseModule.inspectFreshEpochDatabase({
      database_path: config.databasePath,
      blob_store: blobs,
      expected_identity: expectedIdentity,
    });
    try {
      const verification = databaseModule.verifyFreshEpochDatabase(db, expectedIdentity);
      process.stdout.write(`${JSON.stringify({
        schema: "openthrottle.accept-release-current/v1",
        identity: expectedIdentity,
        schema_version: verification.schema_version,
        schema_checksum: verification.schema_checksum,
        integrity: verification.integrity,
      })}\n`);
    } finally {
      db.close();
    }
    return;
  }
  if (process.argv.length !== 2) fail("usage: accept-release.mjs");

  const candidate = await authenticatedCandidate();
  const config = configuration(storageConfiguration(candidate.config));
  const [databaseModule, blobModule] = await Promise.all([
    import("../dist/persistence/epoch-database.js"),
    import("../dist/persistence/blob-store.js"),
  ]);
  const blobs = blobModule.VolumeBlobStore.open(config.blobStorePath, config.blobStoreId);
  const commonIdentity = {
    blob_store_id: blobs.store_id,
    blob_marker_checksum: blobs.marker_checksum,
    bootstrap_checksum: config.bootstrapChecksum,
  };
  const receipt = databaseModule.acceptFreshEpochRelease({
    database_path: config.databasePath,
    blob_store: blobs,
    request: {
      schema: databaseModule.FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA,
      transition_id: config.transitionId,
      expected_maintenance_version: config.maintenanceVersion,
      expected_current_identity: {
        release_id: config.expectedReleaseId,
        runtime_capability_digest: config.expectedRuntimeCapabilityDigest,
        ...commonIdentity,
      },
      candidate_identity: {
        release_id: config.candidateReleaseId,
        runtime_capability_digest: candidate.identity.runtime_capability_digest,
        ...commonIdentity,
      },
      candidate_schema_version: candidate.identity.schema_version,
      candidate_schema_checksum: candidate.identity.schema_checksum,
    },
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
