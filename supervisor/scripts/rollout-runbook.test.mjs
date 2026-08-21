import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runbook = readFileSync(
  resolve(repoRoot, "docs/runbooks/execution-kernel-rollout.md"),
  "utf8",
);
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

describe("fresh-epoch rollout runbook", () => {
  it("runs the accepted digest-pinned image without rebuilding a checkout", () => {
    const manifestGuardIndex = runbook.indexOf('if [ ! -f "$RELEASE_MANIFEST" ]');
    const volumeGuardIndex = runbook.indexOf(
      '[[ ! "$VOLUME_ID" =~ ^vol_[a-z0-9]+$ ]]',
    );
    const volumeInventoryIndex = runbook.indexOf(
      'flyctl volumes list --app "$FLY_APP" --json',
    );
    const runIndex = runbook.indexOf('flyctl machine run "$SUPERVISOR_IMAGE"');

    expect(runbook).toContain('.supervisorImage');
    expect(runbook).toContain(
      'test("^[^@\\\\s]+@sha256:[a-f0-9]{64}$")',
    );
    expect(runbook).not.toContain("export RELEASE_MANIFEST=<");
    expect(runbook).not.toContain("export VOLUME_ID=<");
    expect(manifestGuardIndex).toBeGreaterThanOrEqual(0);
    expect(volumeGuardIndex).toBeGreaterThan(manifestGuardIndex);
    expect(volumeInventoryIndex).toBeGreaterThan(volumeGuardIndex);
    expect(runIndex).toBeGreaterThan(volumeInventoryIndex);
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      'select(volume_name == "openthrottle_data")',
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      '($named | length) == 1',
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      "volume_id == $id",
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      "volume_region == $region",
    );
    expect(runbook.slice(volumeInventoryIndex, runIndex)).toContain(
      'attached_machine == ""',
    );
    expect(runbook).not.toContain("flyctl machine run .");
    expect(runbook).not.toContain("--dockerfile supervisor/Dockerfile");
  });

  it("keeps the initialization blocks valid shell with guarded sentinels", () => {
    const section = runbook.slice(
      runbook.indexOf("## 3. Initialize from the accepted image"),
      runbook.indexOf("## 4. Deploy one writer"),
    );
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      ([, source]) => source,
    );
    const parsed = spawnSync("bash", ["-n"], {
      input: blocks.join("\n"),
      encoding: "utf8",
    });

    expect(blocks).toHaveLength(3);
    expect(section).toContain(
      "export RELEASE_MANIFEST=/absolute/path/to/accepted-release-manifest.json",
    );
    expect(section).toContain("export VOLUME_ID=vol_REPLACE_ME");
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("validates one receipt before destroying the stopped Machine", () => {
    const runIndex = runbook.indexOf('flyctl machine run "$SUPERVISOR_IMAGE"');
    const waitIndex = runbook.indexOf("flyctl machine wait");
    const exactReceiptIndex = runbook.indexOf('error("expected exactly one initializer receipt")');
    const retainedReceiptIndex = runbook.indexOf(">epoch-initialization-receipt.json");
    const destroyIndex = runbook.indexOf("flyctl machine destroy");

    expect(runbook).toContain("--restart no");
    expect(runbook).toContain("--detach");
    expect(runbook).not.toMatch(/flyctl machine run[\s\S]{0,300}\s--rm(?:\s|\\)/);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(runIndex);
    expect(exactReceiptIndex).toBeGreaterThan(waitIndex);
    expect(retainedReceiptIndex).toBeGreaterThan(exactReceiptIndex);
    expect(destroyIndex).toBeGreaterThan(retainedReceiptIndex);
  });
});

describe("packaged initializer CI proof", () => {
  it("runs the final supervisor image against an empty Docker volume", () => {
    const buildIndex = ci.indexOf("docker build -f supervisor/Dockerfile -t openthrottle-supervisor:test .");
    const exerciseIndex = ci.indexOf("Exercise packaged fresh-epoch initializer");
    const runIndex = ci.indexOf("node /app/scripts/initialize-epoch.mjs", exerciseIndex);
    const retryIndex = ci.indexOf("node /app/scripts/initialize-epoch.mjs", runIndex + 1);

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(exerciseIndex).toBeGreaterThan(buildIndex);
    expect(runIndex).toBeGreaterThan(exerciseIndex);
    expect(retryIndex).toBeGreaterThan(runIndex);
    expect(ci.slice(exerciseIndex, runIndex)).toContain("type=volume");
    expect(ci.slice(exerciseIndex, runIndex)).toContain("openthrottle-supervisor:test");
    expect(ci.slice(exerciseIndex, runIndex)).toContain('test -z "$(ls -A /data)"');
    expect(ci.slice(exerciseIndex, runIndex)).not.toContain("docker build");
    expect(ci.slice(retryIndex)).toContain(
      'if [ "$retry_receipt" != "$receipt" ]',
    );
    expect(ci).toContain("packaged initializer returned an invalid receipt");
    expect(ci).toContain("/data/openthrottle-kernel-v1-blobs/.openthrottle-blob-store.json");
  });
});
