import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));
const workflowPath = join(repoRoot, ".github/workflows/deploy.yml");
const mirrorWorkflowPath = join(
  repoRoot,
  ".github/workflows/mirror-accepted-supervisor.yml",
);
const supervisorDockerfilePath = join(repoRoot, "supervisor/Dockerfile");

function source() {
  return readFileSync(workflowPath, "utf8");
}

function workflow() {
  return YAML.parse(source());
}

function mirrorSource() {
  return readFileSync(mirrorWorkflowPath, "utf8");
}

function mirrorWorkflow() {
  return YAML.parse(mirrorSource());
}

function namedWorkflowStep(parsed, job, name) {
  const step = parsed.jobs[job].steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step ${job}/${name}`);
  return step;
}

function namedStep(job, name) {
  return namedWorkflowStep(workflow(), job, name);
}

function namedMirrorStep(job, name) {
  return namedWorkflowStep(mirrorWorkflow(), job, name);
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

function mirrorInputValidationResult(sourceDigest, targetTag) {
  const validation = namedMirrorStep("mirror", "Validate exact image mirror inputs").run;
  const result = spawnSync("bash", ["-c", validation], {
    encoding: "utf8",
    env: {
      ...process.env,
      SOURCE_DIGEST: sourceDigest,
      TARGET_TAG_SUFFIX: targetTag,
      SOURCE_IMAGE: `ghcr.io/knoxgraeme/openthrottle-supervisor@${sourceDigest}`,
      EXPECTED_DIGEST: sourceDigest,
      TARGET_TAG: `registry.fly.io/openthrottle-staging-knoxgraeme:${targetTag}`,
    },
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

describe("clean-epoch deploy workflow", () => {
  it("deploys only after the one-shot fresh epoch initialization", () => {
    const gate = workflow().jobs.deploy.if;
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

  it("is a serialized direct release workflow, not an online schema transition", () => {
    const parsed = workflow();
    expect(parsed.concurrency).toEqual({ group: "deploy-main", "cancel-in-progress": false });
    expect(namedStep("deploy", "Deploy the supervisor directly").run).toContain("flyctl deploy --ha=false");
    expect(source()).not.toContain("offline-replace");

    for (const retired of [
      "prepare_v12_cutover",
      "resume_after_v12_cutover",
      "cutover-control.mjs",
      "verify-migration-rollback-markers.mjs",
      "deployment_cutovers",
    ]) expect(source()).not.toContain(retired);
  });

  it("packages both one-shot epoch operations in the supervisor image", () => {
    const dockerfile = readFileSync(supervisorDockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "COPY supervisor/scripts/initialize-epoch.mjs ./scripts/initialize-epoch.mjs",
    );
    expect(dockerfile).toContain(
      "COPY supervisor/scripts/accept-release.mjs ./scripts/accept-release.mjs",
    );
  });

  it("does not claim an online process can prove that every old writer is stopped", () => {
    const deploySteps = workflow().jobs.deploy.steps;
    expect(deploySteps.some((step) => /initialize-epoch/.test(step.run ?? ""))).toBe(false);
    expect(deploySteps.some((step) => /ssh console/.test(step.run ?? ""))).toBe(false);
    expect(source()).toContain("open-only");
  });

  it("rebuilds both runtime artifacts when sealed filesystem definitions change", () => {
    const parsed = workflow();
    const filterStep = parsed.jobs.changes.steps.find((step) => step.id === "filter");
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

    expect(parsed.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_sandbox");
    expect(parsed.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_definitions");
    expect(parsed.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_contracts");
    expect(parsed.jobs.changes.outputs.snapshot).toContain("outputs.snapshot_skills");
    expect(parsed.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_source");
    expect(parsed.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_contracts");
    expect(parsed.jobs.changes.outputs.supervisor).toContain("outputs.supervisor_definitions");
  });

  it("stages a newly built snapshot before the direct supervisor deploy", () => {
    const steps = workflow().jobs.deploy.steps;
    const snapshotIndex = steps.findIndex((step) => step.name === "Stage the exact snapshot reference");
    const deployIndex = steps.findIndex((step) => step.name === "Deploy the supervisor directly");
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(snapshotIndex);
    expect(steps[snapshotIndex].if).toBe("needs.snapshot.result == 'success'");
    expect(steps[snapshotIndex].run).toContain('DAYTONA_SNAPSHOT="$SNAPSHOT_NAME"');
  });

  it("allows a snapshot-only dispatch while excluding every Fly mutation", () => {
    const parsed = workflow();
    expect(parsed.on.workflow_dispatch.inputs.snapshot_only).toEqual({
      description: "Build the Daytona snapshot without deploying",
      type: "boolean",
      default: false,
    });
    expect(parsed.jobs.snapshot.if).toContain("inputs.snapshot_only");

    const deployGate = parsed.jobs.deploy.if;
    expect(deployGate).toContain("github.event_name != 'workflow_dispatch'");
    expect(deployGate).toContain("inputs.snapshot_only != true");
    expect(deployGate.indexOf("inputs.snapshot_only != true"))
      .toBeLessThan(deployGate.indexOf("vars.FRESH_EPOCH_INITIALIZED"));

    const nonDeployJobs = Object.fromEntries(
      Object.entries(parsed.jobs).filter(([job]) => job !== "deploy"),
    );
    expect(JSON.stringify(nonDeployJobs)).not.toMatch(
      /\bflyctl\b|flyctl-actions|registry\.fly\.io|FLY_API_TOKEN|--stage/,
    );
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

describe("accepted supervisor image mirror workflow", () => {
  it("requires one exact digest and one bounded accepted target tag", () => {
    const inputs = mirrorWorkflow().on.workflow_dispatch.inputs;
    expect(inputs.source_digest).toMatchObject({ required: true, type: "string" });
    expect(inputs.target_tag).toMatchObject({ required: true, type: "string" });
    expect(Object.keys(inputs)).toEqual(["source_digest", "target_tag"]);
  });

  it("validates inputs before registry authentication or image access", () => {
    const steps = mirrorWorkflow().jobs.mirror.steps;
    const validationIndex = steps.findIndex(
      (step) => step.name === "Validate exact image mirror inputs",
    );
    const loginIndexes = steps.flatMap((step, index) =>
      step.uses?.startsWith("docker/login-action@") ? [index] : []);
    const copyIndex = steps.findIndex(
      (step) => step.name === "Copy and prove exact manifest identity",
    );

    expect(validationIndex).toBe(0);
    expect(loginIndexes).toHaveLength(2);
    expect(loginIndexes.every((index) => index > validationIndex)).toBe(true);
    expect(copyIndex).toBeGreaterThan(validationIndex);

    const validation = steps[validationIndex].run;
    expect(validation).toContain("^sha256:[a-f0-9]{64}$");
    expect(validation).toContain("^accepted-[a-f0-9]{12,64}$");
  });

  it("accepts only lowercase sha256 digests and accepted hexadecimal tags", () => {
    const validDigest = `sha256:${"a".repeat(64)}`;
    expect(mirrorInputValidationResult(validDigest, "accepted-055fd1868ed8")).toBe(true);

    for (const digest of [
      `sha256:${"a".repeat(63)}`,
      `sha256:${"A".repeat(64)}`,
      `${validDigest};echo unsafe`,
      `${validDigest}\nunsafe`,
      "latest",
    ]) expect(mirrorInputValidationResult(digest, "accepted-055fd1868ed8")).toBe(false);

    for (const tag of [
      "accepted-short",
      "accepted-055FD1868ED8",
      "accepted-055fd1868ed8/other",
      "accepted-055fd1868ed8;echo-unsafe",
      "$(echo unsafe)",
      "latest",
    ]) expect(mirrorInputValidationResult(validDigest, tag)).toBe(false);
  });

  it("uses the validated digest as both source identity and expected identity", () => {
    const parsed = mirrorWorkflow();
    const raw = mirrorSource();
    expect(parsed.permissions).toEqual({ contents: "read", packages: "read" });
    expect(parsed.jobs.mirror.env).toMatchObject({
      SOURCE_DIGEST: "${{ inputs.source_digest }}",
      TARGET_TAG_SUFFIX: "${{ inputs.target_tag }}",
      SOURCE_IMAGE:
        "ghcr.io/knoxgraeme/openthrottle-supervisor@${{ inputs.source_digest }}",
      EXPECTED_DIGEST: "${{ inputs.source_digest }}",
      TARGET_TAG:
        "registry.fly.io/openthrottle-staging-knoxgraeme:${{ inputs.target_tag }}",
    });
    expect(raw).toContain('SOURCE_DIGEST: "${{ inputs.source_digest }}"');
    expect(raw).toContain('TARGET_TAG_SUFFIX: "${{ inputs.target_tag }}"');

    const copy = namedMirrorStep("mirror", "Copy and prove exact manifest identity").run;
    expect(copy).toContain('source_digest="$(crane digest "$SOURCE_IMAGE")"');
    expect(copy).toContain('test "$source_digest" = "$EXPECTED_DIGEST"');
    expect(copy).toContain('crane copy "$SOURCE_IMAGE" "$TARGET_TAG"');
    expect(copy).toContain('target_digest="$(crane digest "$TARGET_TAG")"');
    expect(copy).toContain('test "$target_digest" = "$EXPECTED_DIGEST"');
  });

  it("contains no stale accepted digest or target tag", () => {
    const raw = mirrorSource();
    expect(raw).not.toContain(
      "2f6d8beebb597d33872d5f020b99e712836a5a4175f8afa79af904bdaa6cd3a1",
    );
    expect(raw).not.toContain("accepted-44e010c97e53");
    expect(raw).not.toMatch(/sha256:[a-f0-9]{64}/);
    expect(raw).not.toMatch(/accepted-[a-f0-9]{12,64}/);
  });
});
