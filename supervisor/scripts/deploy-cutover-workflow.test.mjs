import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));

function deployWorkflow() {
  return YAML.parse(readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8"));
}

function stepRun(jobName, stepName) {
  const step = deployWorkflow().jobs[jobName].steps.find((candidate) => candidate.name === stepName);
  if (!step?.run) throw new Error(`missing workflow step ${jobName}/${stepName}`);
  return step.run;
}

function runBash(script, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ot-deploy-workflow-"));
  try {
    const bin = join(directory, "bin");
    const log = join(directory, "commands.log");
    spawnSync("mkdir", ["-p", bin], { check: true });
    writeFileSync(join(bin, "flyctl"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "flyctl $*" >> "${log}"
if [[ "\${1:-}" == "machines" && "\${2:-}" == "list" ]]; then
  printf '%s\\n' "\${FLYCTL_MACHINES_RESPONSE:-[]}"
  exit "\${FLYCTL_MACHINES_STATUS:-0}"
fi
if [[ "\${1:-}" == "releases" ]]; then
  printf '%s\\n' "\${FLYCTL_RELEASES_RESPONSE:-[]}"
  exit "\${FLYCTL_RELEASES_STATUS:-0}"
fi
if [[ "\${1:-}" == "deploy" ]]; then
  exit "\${FLYCTL_DEPLOY_STATUS:-0}"
fi
if [[ "$*" == *"ssh console"* ]]; then
  printf '%s\\n' "\${FLYCTL_SSH_RESPONSE:-no machines}"
  exit "\${FLYCTL_SSH_STATUS:-1}"
fi
exit 0
`);
    chmodSync(join(bin, "flyctl"), 0o755);
    const result = spawnSync("bash", ["-c", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FLY_APP: "openthrottle-supervisor",
        OT_FIRST_INSTALL_BOOTSTRAP: "0",
        ...env,
      },
      encoding: "utf8",
    });
    const commands = readFileSync(log, "utf8");
    return { ...result, commands };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rollbackHarness() {
  const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
  const helperStart = script.indexOf("active_image_ref() {");
  const helperEnd = script.indexOf("trap 'abort_cutover $?' ERR");
  if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing rollback helper block");
  const helperBlock = script.slice(helperStart, helperEnd);
  return `
set -euo pipefail
FLY_APP=openthrottle-supervisor
cutover_id=cutover-1
old_snapshot=old-snapshot
old_release=old-release
old_digest=sha256:old
old_runtime_image=registry.fly.io/openthrottle-supervisor@sha256:old
${helperBlock}
cutover_command() {
  case "$1" in
    evidence) printf '%s\\n' '{"admission":{"paused":1},"runtime":{"release":"old-release","capabilityDigest":"sha256:old"},"snapshot":"old-snapshot"}' ;;
    resume) printf '%s\\n' '{"admission":{"paused":0}}' ;;
    advance) printf '%s\\n' "$2" ;;
  esac
}
abort_cutover 1
`;
}

describe("deploy workflow cutover recovery", () => {
  it("fails closed when machine enumeration fails even if releases has a plausible image", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_STATUS: "1",
      FLYCTL_RELEASES_RESPONSE:
        '[{"Version":188,"Status":"complete","Stable":false,"ImageRef":"registry.fly.io/openthrottle-staging-knoxgraeme:deployment-01KZZ90"}]',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("registry.fly.io/openthrottle-staging-knoxgraeme:deployment-01KZZ90");
    expect(result.commands).not.toContain("flyctl releases");
    expect(result.stderr).toContain("could not determine immutable active Fly machine image");
  });

  it("fails closed when machine enumeration returns malformed JSON", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_RESPONSE: "{not json",
      FLYCTL_RELEASES_RESPONSE:
        '[{"Version":188,"Status":"complete","Stable":false,"ImageRef":"registry.fly.io/app:newer"}]',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("registry.fly.io/app:newer");
    expect(result.commands).not.toContain("flyctl releases");
    expect(result.stderr).toContain("could not determine immutable active Fly machine image");
  });

  it("uses the started machine image as the sealed runtime authority", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/app:running"}}]',
      FLYCTL_RELEASES_RESPONSE:
        '[{"Version":188,"Status":"complete","Stable":false,"ImageRef":"registry.fly.io/app:release"}]',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("registry.fly.io/app:running");
  });

  it("fails closed when no active Fly image can be resolved", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_RESPONSE: "[]",
      FLYCTL_RELEASES_RESPONSE: "[]",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not determine immutable active Fly machine image");
  });

  it("fails closed when any started Fly machine lacks an image authority", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/app:running"}},{"id":"two","state":"started","config":{}}]',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("registry.fly.io/app:running");
    expect(result.stderr).toContain("could not determine immutable active Fly machine image");
  });

  it("fails closed when started Fly machines report different active images", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("active_image_ref() {");
    const helperEnd = script.indexOf("seal_cutover_evidence() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing active image helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const result = runBash(`${helperBlock}\nactive_image_ref`, {
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/app:old"}},{"id":"two","state":"started","config":{"image":"registry.fly.io/app:new"}}]',
      FLYCTL_RELEASES_RESPONSE:
        '[{"Version":188,"Status":"complete","Stable":false,"ImageRef":"registry.fly.io/app:new"}]',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("started Fly machines disagree on active image");
  });

  it("records recovery commands that redeploy the pinned old image before evidence and never rebuild the candidate checkout", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const recoveryCommands = [
      ...script.matchAll(/recovery_required recovery_required[\s\S]*?"(flyctl secrets set --stage --app \$FLY_APP DAYTONA_SNAPSHOT=\$old_snapshot[^"]+)"/g),
    ].map((match) => match[1]);

    expect(recoveryCommands.length).toBeGreaterThanOrEqual(2);
    for (const command of recoveryCommands) {
      expect(command).toContain("--image $old_runtime_image");
      expect(command).toContain("cutover-control.mjs evidence");
      expect(command).not.toContain("--dockerfile supervisor/Dockerfile");
      expect(command).not.toContain("cutover-control.mjs resume");
    }
  });

  it("persists old release, capability digest, image authority, snapshot, pause epoch, and candidate before staging the candidate secret", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");

    expect(script.indexOf("active_image_ref()")).toBeLessThan(script.indexOf("begin_payload="));
    expect(script).toContain("oldRuntimeRelease:$oldRuntimeRelease");
    expect(script).toContain("sealed_old_runtime");
    expect(script).toContain("seal_cutover_evidence()");
    expect(script).toContain("sealed_evidence=\"$(seal_cutover_evidence \"$evidence\")\"");
    expect(script).toContain("advance_cutover paused active \"$pause_evidence\" \"\" \"$pause_epoch\"");
    expect(script).not.toContain("--arg evidence \"$pause_evidence\"");
    expect(script).toContain(".cutover.evidence // \"\" | fromjson?");
    expect(script).toContain("open cutover lacks sealed old runtime capability digest");
    expect(script).toContain("open cutover lacks sealed old Fly image authority");
    expect(script).toContain("oldSnapshot:$oldSnapshot");
    expect(script).toContain("candidateSnapshot:$candidateSnapshot");
    expect(script.indexOf("begin_evidence=")).toBeLessThan(
      script.indexOf("DAYTONA_SNAPSHOT=\"$EXPECTED_SNAPSHOT\"")
    );
    expect(script.indexOf("pauseEpoch:$pauseEpoch")).toBeLessThan(
      script.indexOf("DAYTONA_SNAPSHOT=\"$EXPECTED_SNAPSHOT\"")
    );
  });

  it("seals the paused advance payload before a runner-loss recovery window", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("seal_cutover_evidence() {");
    const helperEnd = script.indexOf("abort_cutover() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing cutover helper block");
    const helperBlock = script.slice(helperStart, helperEnd);
    const harness = `
set -euo pipefail
FLY_APP=openthrottle-supervisor
cutover_id=cutover-1
old_digest=sha256:old
old_runtime_image=registry.fly.io/openthrottle-supervisor@sha256:old
${helperBlock}
cutover_command() { printf '%s\\n' "$2"; }
pause_evidence='{"admission":{"paused":1,"epoch":42},"snapshot":"old-snapshot"}'
advance_cutover paused active "$pause_evidence" "" "42"
`;
    const result = spawnSync("bash", ["-c", harness], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.phase).toBe("paused");
    expect(payload.pauseEpoch).toBe(42);
    const evidence = JSON.parse(payload.evidence);
    expect(evidence.sealed_old_runtime).toEqual({
      old_runtime_capability_digest: "sha256:old",
      old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
    });
  });

  it("compacts oversized cutover evidence so the old runtime seal survives the parent 4000-character bound", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const helperStart = script.indexOf("seal_cutover_evidence() {");
    const helperEnd = script.indexOf("cutover_command() {");
    if (helperStart < 0 || helperEnd < helperStart) throw new Error("missing cutover seal helper");
    const helperBlock = script.slice(helperStart, helperEnd);
    const blockers = Array.from({ length: 50 }, (_, index) => ({
      id: `blocker-${index}`,
      reason: "active run ".repeat(100),
    }));
    const harness = `
set -euo pipefail
old_digest=sha256:old
old_runtime_image=registry.fly.io/openthrottle-supervisor@sha256:old
${helperBlock}
seal_cutover_evidence '${JSON.stringify({ admission: { paused: 0, epoch: 1 }, runtime: { release: "old-release", capabilityDigest: "sha256:old" }, snapshot: "old-snapshot", drain: { clear: false, blockers } })}' begin
`;
    const result = spawnSync("bash", ["-c", harness], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThan(4_000);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.schema).toBe("openthrottle.cutover-evidence/v1");
    expect(evidence.summary.drain.blocker_count).toBe(50);
    expect(evidence.sealed_old_runtime).toEqual({
      old_runtime_capability_digest: "sha256:old",
      old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
    });
  });

  it("keeps admission paused when rollback evidence matches release, digest, and snapshot but machines still run the candidate image", () => {
    const result = runBash(rollbackHarness(), {
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/openthrottle-supervisor@sha256:candidate"}}]',
    });

    expect(result.status).toBe(1);
    expect(result.commands).toContain("--image registry.fly.io/openthrottle-supervisor@sha256:old");
    const payload = JSON.parse(result.stdout);
    expect(payload.phase).toBe("recovery_required");
    const evidence = JSON.parse(payload.evidence);
    expect(evidence.summary.rollback.observedImage).toBe("registry.fly.io/openthrottle-supervisor@sha256:candidate");
    expect(result.stdout).not.toContain('{"admission":{"paused":0}}');
  });

  it("keeps admission paused when rollback machine enumeration fails after deploying the old image", () => {
    const result = runBash(rollbackHarness(), { FLYCTL_MACHINES_STATUS: "1" });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.phase).toBe("recovery_required");
    const evidence = JSON.parse(payload.evidence);
    expect(evidence.summary.rollback.machineStatus).toBe(1);
    expect(result.stdout).not.toContain('{"admission":{"paused":0}}');
  });

  it("keeps admission paused when the old-image rollback deploy fails", () => {
    const result = runBash(rollbackHarness(), {
      FLYCTL_DEPLOY_STATUS: "1",
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/openthrottle-supervisor@sha256:old"}}]',
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.phase).toBe("recovery_required");
    const evidence = JSON.parse(payload.evidence);
    expect(evidence.summary.rollback.deployStatus).toBe(1);
    expect(result.stdout).not.toContain('{"admission":{"paused":0}}');
  });

  it("attests old image, release, digest, and snapshot before resuming after a successful rollback", () => {
    const result = runBash(rollbackHarness(), {
      FLYCTL_MACHINES_RESPONSE:
        '[{"id":"one","state":"started","config":{"image":"registry.fly.io/openthrottle-supervisor@sha256:old"}}]',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"phase": "restored"');
    expect(result.stdout).not.toContain('"phase": "recovery_required"');
    expect(result.stdout.indexOf('"phase": "restored"')).toBeLessThan(result.stdout.indexOf('"paused": 0'));
  });

  it("executes the recorded recovery shape as staged old snapshot plus pinned image deploy plus evidence, without resume", () => {
    const command = "flyctl secrets set --stage --app $FLY_APP DAYTONA_SNAPSHOT=$old_snapshot && flyctl deploy --remote-only --app $FLY_APP --config supervisor/fly.toml --image $old_runtime_image && flyctl ssh console --app $FLY_APP --command 'node /app/scripts/cutover-control.mjs evidence'";
    const result = runBash(command, {
      old_snapshot: "openthrottle-v2-ce-old",
      old_runtime_image: "registry.fly.io/openthrottle-supervisor@sha256:old",
      FLYCTL_SSH_STATUS: "0",
      FLYCTL_SSH_RESPONSE: '{"admission":{"paused":1},"runtime":{"release":"openthrottle-snapshot/v12","capabilityDigest":"sha256:old"},"snapshot":"openthrottle-v2-ce-old"}',
    });

    expect(result.status).toBe(0);
    expect(result.commands).toContain("flyctl secrets set --stage --app openthrottle-supervisor DAYTONA_SNAPSHOT=openthrottle-v2-ce-old");
    expect(result.commands).toContain("flyctl deploy --remote-only --app openthrottle-supervisor --config supervisor/fly.toml --image registry.fly.io/openthrottle-supervisor@sha256:old");
    expect(result.commands).toContain("cutover-control.mjs evidence");
    expect(result.commands).not.toContain("cutover-control.mjs resume");
    expect(result.commands).not.toContain("--dockerfile supervisor/Dockerfile");
  });

  it("refuses supervisor-only deploy on unavailable evidence unless this run created first-install evidence", () => {
    const script = stepRun("deploy", "Deploy the supervisor");
    const existingApp = runBash(script, { OT_FIRST_INSTALL_BOOTSTRAP: "0", FLYCTL_SSH_STATUS: "1" });

    expect(existingApp.status).not.toBe(0);
    expect(existingApp.stderr).toContain("refusing supervisor-only deploy because cutover evidence is unavailable");
    expect(existingApp.commands).not.toContain("flyctl deploy --remote-only");

    const firstInstall = runBash(script, { OT_FIRST_INSTALL_BOOTSTRAP: "1", FLYCTL_SSH_STATUS: "1" });
    expect(firstInstall.status).toBe(0);
    expect(firstInstall.stdout).toContain("first-install app or volume creation");
    expect(firstInstall.commands).toContain("flyctl deploy --remote-only");
  });

  it("covers the drain-timeout path as executable shell, not only a static substring", () => {
    const script = stepRun("deploy", "Execute the v12 snapshot cutover transaction");
    const timeoutBlock = script.match(/if \(\( SECONDS >= deadline \)\); then[\s\S]*?fi/)?.[0];
    if (!timeoutBlock) throw new Error("missing drain timeout block");
    const harness = `
set -euo pipefail
SECONDS=601
deadline=600
abort_cutover() { printf 'abort:%s\\n' "$1"; exit "$1"; }
${timeoutBlock}
`;
    const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cutover evidence did not clear within 600 seconds");
    expect(result.stdout).toContain("abort:1");
  });
});
