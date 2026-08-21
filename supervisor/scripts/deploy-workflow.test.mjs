import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));
const workflowPath = join(repoRoot, ".github/workflows/deploy.yml");
const supervisorDockerfilePath = join(repoRoot, "supervisor/Dockerfile");

function source() {
  return readFileSync(workflowPath, "utf8");
}

function workflow() {
  return YAML.parse(source());
}

function namedStep(job, name) {
  const step = workflow().jobs[job].steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step ${job}/${name}`);
  return step;
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

  it("packages the one-shot fresh epoch initializer in the supervisor image", () => {
    expect(readFileSync(supervisorDockerfilePath, "utf8")).toContain(
      "COPY supervisor/scripts/initialize-epoch.mjs ./scripts/initialize-epoch.mjs",
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

  it("polls Fly health JSON until every deployed check passes", () => {
    const health = namedStep("deploy", "Verify the deployed health check").run;
    expect(health).toContain("flyctl checks list");
    expect(health).toContain("--json");
    expect(health).toContain("length > 0");
    expect(health).toContain("all(.[];");
    expect(health).toContain('== "passing"');
    expect(health).toContain("exit 1");
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
