#!/usr/bin/env node

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 32 * 1024;

function fail(detail) {
  throw new Error(`accept-release receipt validation: ${detail}`);
}

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") fail(`${name} is required`);
  return value;
}

function integer(name) {
  const value = required(name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail(`${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} exceeds the safe integer range`);
  return parsed;
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${path} has unknown or missing fields`);
}

function digest(value, path) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${path} must be a lowercase SHA-256 digest`);
}

async function input() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) fail(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("input is not valid JSON");
  }
}

const candidates = await input();
if (!Array.isArray(candidates) || candidates.length !== 1) {
  fail("expected exactly one accept-release receipt");
}
const receipt = candidates[0];
exactKeys(receipt, [
  "schema", "transition_id", "request_hash", "sequence", "accepted_at",
  "maintenance_version", "schema_version", "schema_checksum", "from_identity", "to_identity",
], "receipt");
for (const path of ["from_identity", "to_identity"]) {
  exactKeys(receipt[path], [
    "release_id", "runtime_capability_digest", "blob_store_id",
    "blob_marker_checksum", "bootstrap_checksum",
  ], path);
}

const expected = {
  transition_id: required("OT_ACCEPT_RECEIPT_TRANSITION_ID"),
  from_release: required("OT_ACCEPT_RECEIPT_FROM_RELEASE_ID"),
  from_runtime: required("OT_ACCEPT_RECEIPT_FROM_RUNTIME_CAPABILITY_DIGEST"),
  to_release: required("OT_ACCEPT_RECEIPT_TO_RELEASE_ID"),
  to_runtime: required("OT_ACCEPT_RECEIPT_TO_RUNTIME_CAPABILITY_DIGEST"),
  maintenance_version: integer("OT_ACCEPT_RECEIPT_MAINTENANCE_VERSION"),
  schema_version: integer("OT_ACCEPT_RECEIPT_SCHEMA_VERSION"),
  schema_checksum: required("OT_ACCEPT_RECEIPT_SCHEMA_CHECKSUM"),
};
digest(expected.from_runtime, "expected from runtime capability digest");
digest(expected.to_runtime, "expected to runtime capability digest");
digest(expected.schema_checksum, "expected schema checksum");
for (const [value, path] of [
  [receipt.request_hash, "request_hash"],
  [receipt.schema_checksum, "schema_checksum"],
  [receipt.from_identity.runtime_capability_digest, "from_identity.runtime_capability_digest"],
  [receipt.to_identity.runtime_capability_digest, "to_identity.runtime_capability_digest"],
  [receipt.from_identity.blob_marker_checksum, "from_identity.blob_marker_checksum"],
  [receipt.to_identity.blob_marker_checksum, "to_identity.blob_marker_checksum"],
  [receipt.from_identity.bootstrap_checksum, "from_identity.bootstrap_checksum"],
  [receipt.to_identity.bootstrap_checksum, "to_identity.bootstrap_checksum"],
]) digest(value, path);

if (
  receipt.schema !== "openthrottle.epoch-release-acceptance/v1" ||
  receipt.transition_id !== expected.transition_id ||
  !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 ||
  typeof receipt.accepted_at !== "string" || receipt.accepted_at.length < 20 || receipt.accepted_at.length > 100 ||
  receipt.maintenance_version !== expected.maintenance_version ||
  receipt.schema_version !== expected.schema_version ||
  receipt.schema_checksum !== expected.schema_checksum ||
  receipt.from_identity.release_id !== expected.from_release ||
  receipt.from_identity.runtime_capability_digest !== expected.from_runtime ||
  receipt.to_identity.release_id !== expected.to_release ||
  receipt.to_identity.runtime_capability_digest !== expected.to_runtime ||
  receipt.from_identity.blob_store_id !== receipt.to_identity.blob_store_id ||
  receipt.from_identity.blob_marker_checksum !== receipt.to_identity.blob_marker_checksum ||
  receipt.from_identity.bootstrap_checksum !== receipt.to_identity.bootstrap_checksum
) fail("receipt does not match the candidate and live fence");

process.stdout.write(`${JSON.stringify(receipt)}\n`);
