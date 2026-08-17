import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowSource = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const workflow = parse(workflowSource) as {
  on: { push: { branches: string[]; tags: string[] } };
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps: Array<{ name?: string; run?: string; if?: string }>;
  }>;
};

function step(job: string, name: string) {
  const result = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`missing release workflow step ${job}/${name}`);
  return result;
}

function runReleasePlan(options: {
  eventName: "push" | "workflow_dispatch";
  refType: "branch" | "tag";
  releaseId: string;
  versionExists: boolean;
}): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), "ot-release-workflow-"));
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "github-output");
    mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(npm, "#!/usr/bin/env bash\nexit \"${NPM_VERSION_STATUS}\"\n");
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["-c", step("plan", "Plan the release").run ?? ""], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        RELEASE_ID_INPUT: options.releaseId,
        EVENT_NAME: options.eventName,
        REF_TYPE: options.refType,
        NPM_VERSION_STATUS: options.versionExists ? "0" : "1",
      },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return Object.fromEntries(
      readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=", 2))
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("npm release workflow", () => {
  it("publishes new main versions through npm trusted publishing", () => {
    expect(workflow.on.push.branches).toContain("main");
    expect(workflow.on.push.tags).toContain("v*");
    expect(workflow.jobs.release?.permissions).toMatchObject({
      contents: "read",
      packages: "write",
    });
    expect(workflow.jobs.release?.permissions).not.toHaveProperty("id-token");
    expect(workflow.jobs.publish?.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs.publish?.needs).toEqual(["plan", "release"]);
    expect(workflow.jobs.publish?.if).toBe("needs.plan.outputs.publish_npm == 'true'");

    const plan = step("plan", "Plan the release").run ?? "";
    expect(plan).toContain('npm view "openthrottle@${release_id}" version');
    expect(plan).toContain('dist_tag="next"');
    expect(plan).toContain('run_release="false"');

    expect(step("publish", "Install npm with trusted publishing support").run)
      .toBe("npm install --global npm@11.5.1");
    const publish = step("publish", "Publish the CLI to npm");
    expect(publish.run).toContain("openthrottle-*.tgz");
    expect(publish.run).toContain("--provenance");
    expect(publish.run).toContain('--tag "$NPM_DIST_TAG"');
    expect(workflowSource).not.toContain("NPM_TOKEN");
    expect(workflowSource).not.toContain("NODE_AUTH_TOKEN");

    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "cli/package.json"), "utf8"));
    expect(packageJson.repository.url).toBe("https://github.com/knoxgraeme/openthrottle");
  });

  it("skips duplicate main versions without weakening tag and manual artifacts", () => {
    expect(runReleasePlan({
      eventName: "push",
      refType: "branch",
      releaseId: "2.0.0-alpha.3",
      versionExists: false,
    })).toMatchObject({ run_release: "true", publish_npm: "true", dist_tag: "next" });
    expect(runReleasePlan({
      eventName: "push",
      refType: "branch",
      releaseId: "2.0.0-alpha.3",
      versionExists: true,
    })).toMatchObject({ run_release: "false", publish_npm: "false", dist_tag: "next" });
    expect(runReleasePlan({
      eventName: "push",
      refType: "tag",
      releaseId: "2.0.0",
      versionExists: true,
    })).toMatchObject({ run_release: "true", publish_npm: "false", dist_tag: "latest" });
    expect(runReleasePlan({
      eventName: "workflow_dispatch",
      refType: "branch",
      releaseId: "manual-proof",
      versionExists: false,
    })).toMatchObject({ run_release: "true", publish_npm: "false" });
  });
});
