import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));
const workflowPath = join(repoRoot, ".github/workflows/deploy.yml");
const supervisorDockerfilePath = join(repoRoot, "supervisor/Dockerfile");
const receiptValidatorPath = join(repoRoot, "supervisor/scripts/validate-accept-release-receipt.mjs");
const workflowSource = readFileSync(workflowPath, "utf8");
const parsedWorkflow = YAML.parse(workflowSource);
const RUNTIME_A = "a".repeat(64);
const RUNTIME_B = "b".repeat(64);
const SCHEMA_CHECKSUM = "c".repeat(64);
const validAcceptanceReceipt = {
  schema: "openthrottle.epoch-release-acceptance/v1",
  transition_id: "deploy-candidate-1",
  request_hash: "d".repeat(64),
  sequence: 1,
  accepted_at: "2026-08-25T00:00:00.000Z",
  maintenance_version: 7,
  schema_version: 1,
  schema_checksum: SCHEMA_CHECKSUM,
  from_identity: {
    release_id: "release-a",
    runtime_capability_digest: RUNTIME_A,
    blob_store_id: "store-a",
    blob_marker_checksum: "e".repeat(64),
    bootstrap_checksum: "f".repeat(64),
  },
  to_identity: {
    release_id: "release-b",
    runtime_capability_digest: RUNTIME_B,
    blob_store_id: "store-a",
    blob_marker_checksum: "e".repeat(64),
    bootstrap_checksum: "f".repeat(64),
  },
};

function validateAcceptanceReceipt(candidates, overrides = {}) {
  return spawnSync(process.execPath, [receiptValidatorPath], {
    encoding: "utf8",
    input: JSON.stringify(candidates),
    env: {
      ...process.env,
      OT_ACCEPT_RECEIPT_TRANSITION_ID: "deploy-candidate-1",
      OT_ACCEPT_RECEIPT_FROM_RELEASE_ID: "release-a",
      OT_ACCEPT_RECEIPT_FROM_RUNTIME_CAPABILITY_DIGEST: RUNTIME_A,
      OT_ACCEPT_RECEIPT_TO_RELEASE_ID: "release-b",
      OT_ACCEPT_RECEIPT_TO_RUNTIME_CAPABILITY_DIGEST: RUNTIME_B,
      OT_ACCEPT_RECEIPT_MAINTENANCE_VERSION: "7",
      OT_ACCEPT_RECEIPT_SCHEMA_VERSION: "1",
      OT_ACCEPT_RECEIPT_SCHEMA_CHECKSUM: SCHEMA_CHECKSUM,
      ...overrides,
    },
  });
}

function namedStep(job, name) {
  const step = parsedWorkflow.jobs[job].steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step ${job}/${name}`);
  return step;
}

function healthCheckJqProgram() {
  const health = namedStep("deploy", "Verify the deployed health check").run;
  const match = health.match(/if jq -e '([\s\S]*?)' <<<"\$checks"/);
  if (!match) throw new Error("missing embedded Fly health-check jq program");
  return match[1];
}

function healthCheckResult(input) {
  const result = spawnSync("jq", ["-e", healthCheckJqProgram()], {
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function acceptsHealthChecks(value) {
  return healthCheckResult(JSON.stringify(value));
}

function unchangedEpochJqProgram() {
  const verify = namedStep("deploy", "Verify the unchanged release on the offline epoch").run;
  const match = verify.match(
    /--arg schema_checksum "\$CANDIDATE_SCHEMA_CHECKSUM" '([\s\S]*?)' "\$candidates"/,
  );
  if (!match) throw new Error("missing embedded unchanged-epoch jq program");
  return match[1];
}

function validatesUnchangedEpochProof(proof, overrides = {}) {
  const expected = {
    release: "release-b",
    runtime: RUNTIME_B,
    schemaVersion: 1,
    schemaChecksum: SCHEMA_CHECKSUM,
    ...overrides,
  };
  const result = spawnSync("jq", [
    "-e",
    "--arg", "release", expected.release,
    "--arg", "runtime", expected.runtime,
    "--argjson", "schema_version", String(expected.schemaVersion),
    "--arg", "schema_checksum", expected.schemaChecksum,
    unchangedEpochJqProgram(),
  ], {
    encoding: "utf8",
    input: JSON.stringify([proof]),
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function acceptanceSchemaRefusal(logs) {
  const acceptance = namedStep("deploy", "Accept the candidate release on the offline epoch").run;
  const match = acceptance.match(/schema_refusal="\$\(jq -sr '([\s\S]*?)' "\$logs"\)"/);
  if (!match) throw new Error("missing accept-release schema-refusal extraction");
  const result = spawnSync("jq", ["-sr", match[1]], {
    encoding: "utf8",
    input: logs.map((entry) => JSON.stringify(entry)).join("\n"),
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("clean-epoch deploy workflow", () => {
  it("deploys only after the one-shot fresh epoch initialization", () => {
    const gate = parsedWorkflow.jobs.deploy.if;
    expect(gate).toContain("vars.FRESH_EPOCH_INITIALIZED == 'true'");
    expect(gate).not.toContain("FRESH_EPOCH_READY");
    expect(gate.indexOf("vars.FRESH_EPOCH_INITIALIZED == 'true'")).toBeLessThan(gate.indexOf("always()"));
  });

  it("fails closed instead of creating post-gate app or volume state", () => {
    const assertion = namedStep("deploy", "Assert the initialized Fly app and data volume exist").run;
    expect(assertion).toContain("flyctl status");
    expect(assertion).toContain("flyctl volumes list");
    expect(assertion).toContain("length == 1");
    expect(assertion).toContain("exit 1");
    expect(assertion).not.toContain("apps create");
    expect(assertion).not.toContain("volumes create");
  });

  it("is a serialized release workflow with no online schema transition", () => {
    expect(parsedWorkflow.concurrency).toEqual({ group: "deploy-main", "cancel-in-progress": false });
    expect(namedStep("deploy", "Deploy the exact accepted candidate image").run)
      .toContain("flyctl deploy --ha=false");
    expect(namedStep("deploy", "Deploy the exact accepted candidate image").run)
      .toContain('--image "$CANDIDATE_IMAGE"');
    expect(workflowSource).not.toContain("offline-replace");

    for (const retired of [
      "prepare_v12_cutover",
      "resume_after_v12_cutover",
      "cutover-control.mjs",
      "verify-migration-rollback-markers.mjs",
      "deployment_cutovers",
    ]) expect(workflowSource).not.toContain(retired);
  });

  it("packages both offline epoch commands in the supervisor image", () => {
    const dockerfile = readFileSync(supervisorDockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "COPY supervisor/scripts/initialize-epoch.mjs ./scripts/initialize-epoch.mjs",
    );
    expect(dockerfile).toContain(
      "COPY supervisor/scripts/accept-release.mjs ./scripts/accept-release.mjs",
    );
  });

  it("does not claim an online process can prove that every old writer is stopped", () => {
    const deploySteps = parsedWorkflow.jobs.deploy.steps;
    expect(deploySteps.some((step) => /initialize-epoch/.test(step.run ?? ""))).toBe(false);
    expect(deploySteps.some((step) => /ssh console/.test(step.run ?? ""))).toBe(false);
    expect(workflowSource).toContain("open-only");
  });

  it("rebuilds both runtime artifacts when sealed filesystem definitions change", () => {
    const filterStep = parsedWorkflow.jobs.changes.steps.find((step) => step.id === "filter");
    const filters = YAML.parse(filterStep?.with?.filters);

    expect(filterStep.with["predicate-quantifier"]).toBe("every");
    expect(filters.snapshot_sandbox).toEqual([
      "sandbox/**",
      "!sandbox/tests/**",
      "!sandbox/**/*.test.mjs",
    ]);
    for (const [name, pattern] of Object.entries({
      snapshot_definitions: ".openthrottle/**",
      snapshot_contracts: "contracts/**",
      snapshot_skills: "skills/codex/**",
      supervisor_source: "supervisor/**",
      supervisor_contracts: "contracts/**",
      supervisor_definitions: ".openthrottle/**",
    })) expect(filters[name]).toEqual([pattern]);

    expect(parsedWorkflow.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_sandbox");
    expect(parsedWorkflow.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_definitions");
    expect(parsedWorkflow.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_contracts");
    expect(parsedWorkflow.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_skills");
    expect(parsedWorkflow.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_source");
    expect(parsedWorkflow.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_contracts");
    expect(parsedWorkflow.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_definitions");
  });

  it("stages a newly built snapshot before the exact candidate deploy", () => {
    const steps = parsedWorkflow.jobs.deploy.steps;
    const snapshotIndex = steps.findIndex((step) => step.name === "Stage the exact snapshot reference");
    const deployIndex = steps.findIndex((step) => step.name === "Deploy the exact accepted candidate image");
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(snapshotIndex);
    expect(steps[snapshotIndex].if).toBe("needs.snapshot.result == 'success'");
    expect(steps[snapshotIndex].run).toContain('DAYTONA_SNAPSHOT="$SNAPSHOT_NAME"');
  });

  it("orders maintenance closure and full drain before writer shutdown and acceptance", () => {
    const names = parsedWorkflow.jobs.deploy.steps.map(({ name }) => name);
    const close = names.indexOf("Close maintenance with compare-and-set");
    const drain = names.indexOf("Wait for complete active-work clearance");
    const stop = names.indexOf("Stop the sole writer and detach its volume");
    const accept = names.indexOf("Accept the candidate release on the offline epoch");
    const verify = names.indexOf("Verify the unchanged release on the offline epoch");
    const deploy = names.indexOf("Deploy the exact accepted candidate image");
    const health = names.indexOf("Verify the deployed health check");
    const reopen = names.indexOf("Restore the prior open maintenance intent");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(drain).toBeGreaterThan(close);
    expect(stop).toBeGreaterThan(drain);
    expect(accept).toBeGreaterThan(stop);
    expect(verify).toBeGreaterThan(accept);
    expect(deploy).toBeGreaterThan(accept);
    expect(deploy).toBeGreaterThan(verify);
    expect(health).toBeGreaterThan(deploy);
    expect(reopen).toBeGreaterThan(health);

    const drainRun = namedStep("deploy", "Wait for complete active-work clearance").run;
    expect(drainRun).toContain("/maintenance/active-work?limit=2000");
    expect(drainRun).toContain(".clear == true");
    expect(drainRun).toContain(".truncated == false");
    expect(drainRun).toContain("(.items | length) == 0");
    expect(namedStep("deploy", "Observe the live release and maintenance fence").run)
      .toContain("Configure OT_STATUS_TOKEN and OT_DEPLOY_TOKEN as GitHub Actions secrets");
  });

  it("authenticates the durable schema before a runtime-unchanged redeploy", () => {
    for (const name of [
      "Close maintenance with compare-and-set",
      "Wait for complete active-work clearance",
      "Stop the sole writer and detach its volume",
    ]) {
      expect(namedStep("deploy", name).if).toBe("steps.live.outputs.first_deploy == 'false'");
    }

    const verify = namedStep("deploy", "Verify the unchanged release on the offline epoch");
    expect(verify.if).toContain("steps.live.outputs.first_deploy == 'false'");
    expect(verify.if).toContain("steps.live.outputs.needs_acceptance == 'false'");
    expect(verify.run).toContain("--verify-current");
    expect(verify.run).toContain(".schema_version == $schema_version");
    expect(verify.run).toContain(".schema_checksum == $schema_checksum");
    expect(verify.run).toContain("a fresh epoch is required before deployment");

    const deploy = namedStep("deploy", "Deploy the exact accepted candidate image").run;
    expect(deploy).toContain("OFFLINE_EPOCH_VERIFIED");
    expect(deploy).toContain("live epoch was not verified against this candidate schema");

    const proof = {
      schema: "openthrottle.accept-release-current/v1",
      identity: {
        release_id: "release-b",
        runtime_capability_digest: RUNTIME_B,
        blob_marker_checksum: "d".repeat(64),
        bootstrap_checksum: "e".repeat(64),
      },
      schema_version: 1,
      schema_checksum: SCHEMA_CHECKSUM,
      integrity: "ok",
    };
    expect(validatesUnchangedEpochProof(proof)).toBe(true);
    expect(validatesUnchangedEpochProof(proof, { schemaVersion: 2 })).toBe(false);
    expect(validatesUnchangedEpochProof(proof, { schemaChecksum: "f".repeat(64) })).toBe(false);
  });

  it("uses one digest-pinned candidate for acceptance and deployment", () => {
    const build = namedStep("deploy", "Build and push the exact candidate image").run;
    const inspect = namedStep("deploy", "Authenticate the candidate release identity").run;
    const accept = namedStep("deploy", "Accept the candidate release on the offline epoch").run;
    const deploy = namedStep("deploy", "Deploy the exact accepted candidate image").run;
    expect(build).toContain("registry.fly.io/$FLY_APP@$candidate_digest");
    expect(inspect).toContain("--candidate-identity");
    expect(accept).toContain('flyctl machine run "$CANDIDATE_IMAGE"');
    expect(accept).toContain("--restart no");
    expect(deploy).toContain('--image "$CANDIDATE_IMAGE"');
    expect(deploy).toContain("no matching accept-release receipt was validated");
  });

  it("surfaces actionable schema drift when the runtime digest changed", () => {
    const acceptance = namedStep("deploy", "Accept the candidate release on the offline epoch");
    expect(acceptance.if).toBe("steps.live.outputs.needs_acceptance == 'true'");
    expect(acceptance.run).toContain("a fresh epoch is required before deployment");
    expect(acceptance.run.indexOf("schema_refusal="))
      .toBeLessThan(acceptance.run.indexOf("validate-accept-release-receipt.mjs"));

    const refusal = "epoch release acceptance: candidate schema identity changed; a fresh epoch is required";
    expect(acceptanceSchemaRefusal([
      { message: JSON.stringify(validAcceptanceReceipt) },
      { message: refusal },
    ])).toBe(refusal);
    expect(acceptanceSchemaRefusal([
      { message: JSON.stringify(validAcceptanceReceipt) },
      { message: "epoch release acceptance: active coordination state remains" },
    ])).toBe("");
  });

  it("never treats an absent writer as permission to deploy an unverified epoch", () => {
    const observe = namedStep("deploy", "Observe the live release and maintenance fence").run;
    const verify = namedStep("deploy", "Verify a detached epoch already matches the candidate");
    const deploy = namedStep("deploy", "Deploy the exact accepted candidate image").run;
    expect(observe).toContain('echo "first_deploy=true"');
    expect(verify.if).toBe("steps.live.outputs.first_deploy == 'true'");
    expect(verify.run).toContain("--verify-current");
    expect(verify.run).toContain('flyctl machine run "$CANDIDATE_IMAGE"');
    expect(verify.run).toContain("expected one detached data volume");
    expect(verify.run.indexOf("expected exactly one current-identity proof"))
      .toBeLessThan(verify.run.indexOf("flyctl machine destroy"));
    expect(deploy).toContain("detached epoch was not verified against this candidate");
  });

  it("validates exactly one matching durable receipt before health can begin", () => {
    const valid = validateAcceptanceReceipt([validAcceptanceReceipt]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual(validAcceptanceReceipt);

    for (const candidates of [
      [],
      [validAcceptanceReceipt, validAcceptanceReceipt],
      [{ ...validAcceptanceReceipt, unexpected: true }],
      [{ ...validAcceptanceReceipt, transition_id: "stale-transition" }],
      [{
        ...validAcceptanceReceipt,
        to_identity: { ...validAcceptanceReceipt.to_identity, runtime_capability_digest: "9".repeat(64) },
      }],
    ]) {
      const rejected = validateAcceptanceReceipt(candidates);
      expect(rejected.status).not.toBe(0);
    }
    const acceptance = namedStep("deploy", "Accept the candidate release on the offline epoch").run;
    expect(acceptance).toContain("validate-accept-release-receipt.mjs");
    expect(acceptance.indexOf("validate-accept-release-receipt.mjs"))
      .toBeLessThan(acceptance.indexOf("flyctl machine destroy"));
  });

  it("reopens only a previously open fence after successful health verification", () => {
    const reopen = namedStep("deploy", "Restore the prior open maintenance intent");
    expect(reopen.if).toContain("steps.live.outputs.first_deploy == 'false'");
    expect(reopen.if).toContain("steps.live.outputs.initially_closed == 'false'");
    expect(reopen.run).toContain("select(.closed == true)");
    expect(reopen.run).toContain('if [ "$current_version" != "$CLOSED_VERSION" ]');
    expect(reopen.run).toContain("/maintenance/open");
  });

  it("keeps every deploy shell block syntactically valid", () => {
    const blocks = parsedWorkflow.jobs.deploy.steps
      .map(({ run }) => run)
      .filter((run) => typeof run === "string");
    const parsed = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: blocks.join("\n"),
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("polls Fly health JSON until every deployed check passes", () => {
    const health = namedStep("deploy", "Verify the deployed health check").run;
    expect(health).toContain("flyctl checks list");
    expect(health).toContain("--json");
    expect(health).toContain("normalized_checks");
    expect(health).toContain("($checks | length) > 0");
    expect(health).toContain("all($checks[];");
    expect(health).toContain('== "passing"');
    expect(health).toContain("exit 1");
  });

  it("accepts both flat and Machine-keyed passing Fly health-check responses", () => {
    expect(acceptsHealthChecks([
      { name: "healthz", status: "passing" },
      { Name: "service", Status: "PASSING" },
    ])).toBe(true);
    expect(acceptsHealthChecks({
      "machine-1": [
        { name: "healthz", status: "passing" },
        { Name: "service", Status: "PASSING" },
      ],
    })).toBe(true);
  });

  it.each([
    ["an empty flat response", []],
    ["an empty keyed response", {}],
    ["a keyed response with a malformed value", { "machine-1": { status: "passing" } }],
    ["a response containing a malformed check", [{ status: 200 }]],
    ["a response containing a pending check", [{ status: "passing" }, { status: "pending" }]],
  ])("rejects %s", (_description, value) => {
    expect(acceptsHealthChecks(value)).toBe(false);
  });

  it("rejects malformed Fly health-check JSON", () => {
    expect(healthCheckResult('{"machine-1":')).toBe(false);
  });

  it("converges and verifies one Machine owns the SQLite volume", () => {
    expect(namedStep("deploy", "Converge to one SQLite writer Machine").run)
      .toBe('flyctl scale count 1 --app "$FLY_APP" --yes');
    const topology = namedStep("deploy", "Verify the single-writer Machine topology").run;
    expect(topology).toContain("flyctl machines list");
    expect(topology).toContain("length == 1");
    expect(topology).toContain("attached_machine_id");
    expect(topology).toContain("openthrottle_data");
    expect(topology).toContain("$machine_id");
  });
});
