#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RUNTIME_DESCRIPTOR, canonicalJson } from "../../sandbox/runner/capabilities.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const V12_RUNTIME_RELEASE = "openthrottle-snapshot/v12";
const V12_PROOF_FILE = "v12-deploy-proof.json";
const V12_PROOF_PATH = `supervisor/pipelines/${V12_PROOF_FILE}`;
const SNAPSHOT_IDENTITY = "openthrottle-v2-ce-${short_head}";

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const supervisorDescriptor = JSON.parse(read("supervisor/pipelines/runtime-capabilities-v1.json"));
assert(
  canonicalJson(supervisorDescriptor) === canonicalJson(RUNTIME_DESCRIPTOR),
  "supervisor runtime descriptor must match sandbox installed capabilities"
);
assert(
  supervisorDescriptor.release === V12_RUNTIME_RELEASE,
  `v12 deploy proof must stay bound to ${V12_RUNTIME_RELEASE}`
);

const deployWorkflow = read(".github/workflows/deploy.yml");
const cutoverControl = read("supervisor/scripts/cutover-control.mjs");
assert(
  deployWorkflow.includes("/app/scripts/cutover-control.mjs pause") &&
    deployWorkflow.includes("/app/scripts/cutover-control.mjs evidence") &&
    deployWorkflow.includes("/app/scripts/cutover-control.mjs resume") &&
    deployWorkflow.includes(".drain.clear == true") &&
    deployWorkflow.includes(".runtime.release == $release") &&
    deployWorkflow.includes(".runtime.capabilityDigest == $digest") &&
    deployWorkflow.includes(".snapshot == $snapshot") &&
    deployWorkflow.includes("EXPECTED_SNAPSHOT") &&
    deployWorkflow.includes("github.event_name == 'push' && needs.snapshot.result == 'success'"),
  "deploy workflow must expose a fail-closed supervisor-only v12 cutover path"
);
assert(
  deployWorkflow.includes("database_migrations: ${{ steps.filter.outputs.database_migrations }}") &&
    deployWorkflow.includes("'supervisor/src/persistence/migrations/definitions.ts'") &&
    deployWorkflow.includes("EXPECTED_MIGRATION_ROLLBACK_CONTRACT: schema-migrations-name-additive-rollback-compatible/v1") &&
    deployWorkflow.includes("needs.changes.outputs.database_migrations == 'true'") &&
    deployWorkflow.includes("requires_migration_contract=\"${{ needs.changes.outputs.database_migrations == 'true' }}\"") &&
    !deployWorkflow.includes("github.event_name == 'push' && needs.changes.outputs.database_migrations == 'true'") &&
    deployWorkflow.includes(".database.migrationRollbackCompatibility.contract == $migration_contract"),
  "migration-bearing supervisor deploys, including workflow_dispatch refs, must prove rollback compatibility before opening SQLite"
);
assert(
  cutoverControl.includes("OT_DEPLOY_TOKEN") &&
    cutoverControl.includes("/maintenance/admission/pause") &&
    cutoverControl.includes("/deployment/cutover-evidence") &&
    cutoverControl.includes("/maintenance/admission/resume"),
  "Fly-local cutover control must retain the deploy-token endpoint fence"
);
assert(
  deployWorkflow.includes('name="openthrottle-v2-ce-$(git rev-parse --short=7 HEAD)"'),
  "Daytona snapshot identity must remain commit-pinned"
);
assert(
  deployWorkflow.includes("'supervisor/pipelines/runtime-capabilities-v1.json'"),
  "runtime descriptor changes must rebuild the Daytona snapshot"
);
assert(
  deployWorkflow.includes("predicate-quantifier: every") &&
    deployWorkflow.includes("'!sandbox/tests/**'") &&
    deployWorkflow.includes("'!sandbox/**/*.test.mjs'") &&
    deployWorkflow.includes("skills: ${{ steps.filter.outputs.skills }}") &&
    deployWorkflow.includes("runtime_descriptor: ${{ steps.filter.outputs.runtime_descriptor }}") &&
    deployWorkflow.includes("needs.changes.outputs.skills == 'true'") &&
    deployWorkflow.includes("needs.changes.outputs.runtime_descriptor == 'true'"),
  "test-only sandbox changes must not build or stage a Daytona snapshot"
);

const ciWorkflow = read(".github/workflows/ci.yml");
assert(
  ciWorkflow.includes("npm run verify:v12-deploy-proof --prefix supervisor") &&
    ciWorkflow.includes("runner/capabilities.test.mjs"),
  "CI must prove v12 runtime and snapshot parity"
);

const catalog = read("supervisor/pipelines/catalog.yaml");
const graphDigests = Object.fromEntries(
  readdirSync(join(root, "supervisor/graphs"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, digest(read(`supervisor/graphs/${name}`))])
);
const pipelineDigests = Object.fromEntries(
  readdirSync(join(root, "supervisor/pipelines"))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".json"))
    .filter((name) => name !== V12_PROOF_FILE)
    .sort()
    .map((name) => [name, digest(read(`supervisor/pipelines/${name}`))])
);

const proof = {
  schema: "openthrottle.v12-deploy-proof/v1",
  runtime: {
    release: supervisorDescriptor.release,
    digest: digest(canonicalJson(supervisorDescriptor)),
    capabilities: supervisorDescriptor.capabilities.length,
  },
  catalog_digest: digest(catalog),
  graph_digests: graphDigests,
  pipeline_digests: pipelineDigests,
  snapshot_identity: SNAPSHOT_IDENTITY,
};

const expected = JSON.parse(read(V12_PROOF_PATH));
assert(
  canonicalJson(proof) === canonicalJson(expected),
  "v12 manifests, graphs, capabilities, or snapshot identity changed without updating the deployment proof"
);

process.stdout.write(canonicalJson(proof) + "\n");
