import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectSandboxDisk, reclaimSandboxScratch } from "./sandbox-disk.mjs";

function roots(root) {
  return {
    actions: join(root, "var/lib/openthrottle/actions"),
    actionInput: join(root, "var/lib/openthrottle/action-input"),
    actionResults: join(root, "var/lib/openthrottle/action-results"),
    actionFences: join(root, "var/lib/openthrottle/action-fences"),
    integrationInput: join(root, "var/lib/openthrottle/integration-input"),
    integrationResults: join(root, "var/lib/openthrottle/integration-results"),
    temporary: join(root, "tmp"),
    legacyNpmCache: join(root, "home/agent/.npm"),
  };
}

function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function file(path, contents = "fixture\n") {
  directory(join(path, ".."));
  writeFileSync(path, contents);
  return path;
}

function actionLaunch() {
  return { kind: "action", attempt: "attempt-current", lease: "lease-current", phase: "work", generation: 7 };
}

describe("sandbox scratch reclamation", () => {
  it("removes every settled storage class while preserving the exact current action launch", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-sandbox-disk-action-"));
    const fixtureRoots = roots(root);
    for (const path of Object.values(fixtureRoots)) directory(path);

    const settledAction = join(fixtureRoots.actions, "attempt-settled");
    file(join(settledAction, "repository/node_modules/package/index.js"));
    file(join(settledAction, "repository/dist/output.js"));
    file(join(settledAction, "command-home/.cache/tool/cache"));
    file(join(settledAction, "command-home/.npm/_cacache/data"));
    file(join(settledAction, "command-tmp/work"));
    file(join(fixtureRoots.actionInput, "attempt-settled/work-lease-old/request.json"));
    file(join(fixtureRoots.actionResults, "attempt-settled/work-lease-old/result.json"));
    file(join(fixtureRoots.actionFences, "attempt-settled/lease-generation.json"));
    file(join(fixtureRoots.integrationInput, "effect-old/lease-old/request.json"));
    file(join(fixtureRoots.integrationResults, "effect-old/lease-old/result.json"));

    const currentAction = file(join(fixtureRoots.actions, "attempt-current/repository/current.txt"));
    const currentInput = file(join(fixtureRoots.actionInput, "attempt-current/work-lease-current/request.json"));
    const oldInput = file(join(fixtureRoots.actionInput, "attempt-current/work-lease-old/request.json"));
    const currentResult = file(join(fixtureRoots.actionResults, "attempt-current/work-lease-current/result.json"));
    const oldResult = file(join(fixtureRoots.actionResults, "attempt-current/correction-lease-old/result.json"));
    const dispatchLock = file(join(fixtureRoots.actionResults, "attempt-current/dispatch.lock"));
    const currentFence = file(join(fixtureRoots.actionFences, "attempt-current/lease-generation.json"));
    const currentFenceLock = file(join(fixtureRoots.actionFences, "attempt-current/lease-generation.lock"));
    const currentFenceStage = file(join(
      fixtureRoots.actionFences,
      "attempt-current/lease-generation-lease-current-7.part",
    ));
    const oldFenceStage = file(join(
      fixtureRoots.actionFences,
      "attempt-current/lease-generation-lease-old-6.part",
    ));

    const tempTargets = [
      "ot-kernel-checkpoint-a",
      "ot-kernel-action-index-a",
      "ot-provider-result-a",
      "ot-stage-output-a",
      "ot-kernel-integration-a",
    ].map((name) => file(join(fixtureRoots.temporary, name, "scratch")));
    const unknownTemporary = file(join(fixtureRoots.temporary, "unrelated-temporary", "keep"));
    const npmCache = file(join(fixtureRoots.legacyNpmCache, "_cacache/content"));
    const repositorySource = file(join(root, "var/lib/openthrottle/repository-source/repo/.git/HEAD"));
    const unrelated = file(join(root, "unrelated/keep.txt"), "unchanged\n");

    const report = reclaimSandboxScratch({
      current: actionLaunch(),
      roots: fixtureRoots,
      requireRoot: false,
    });

    expect(existsSync(settledAction)).toBe(false);
    expect(existsSync(join(fixtureRoots.actionInput, "attempt-settled"))).toBe(false);
    expect(existsSync(join(fixtureRoots.actionResults, "attempt-settled"))).toBe(false);
    expect(existsSync(join(fixtureRoots.actionFences, "attempt-settled"))).toBe(false);
    expect(existsSync(join(fixtureRoots.integrationInput, "effect-old"))).toBe(false);
    expect(existsSync(join(fixtureRoots.integrationResults, "effect-old"))).toBe(false);
    expect(tempTargets.every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(npmCache)).toBe(false);
    expect(existsSync(fixtureRoots.legacyNpmCache)).toBe(true);

    for (const path of [
      currentAction,
      currentInput,
      currentResult,
      dispatchLock,
      currentFence,
      currentFenceLock,
      currentFenceStage,
      unknownTemporary,
      repositorySource,
      unrelated,
    ]) expect(existsSync(path), path).toBe(true);
    for (const path of [oldInput, oldResult, oldFenceStage]) expect(existsSync(path), path).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("unchanged\n");
    expect(report).toMatchObject({
      schema: "openthrottle.sandbox-scratch-reclamation/v1",
      failures: [],
      timed_out: false,
    });
    expect(report.removed_classes).toEqual([
      "action_fences",
      "action_input",
      "action_materializations",
      "action_results",
      "integration_input",
      "integration_results",
      "legacy_npm_cache",
      "runner_temporary",
    ]);
  });

  it("preserves only the current integration transport and removes settled action state", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-sandbox-disk-integration-"));
    const fixtureRoots = roots(root);
    for (const path of Object.values(fixtureRoots)) directory(path);
    const currentInput = file(join(fixtureRoots.integrationInput, "effect-current/lease-current/request.json"));
    const currentResult = file(join(fixtureRoots.integrationResults, "effect-current/lease-current/result.json"));
    const oldInput = file(join(fixtureRoots.integrationInput, "effect-current/lease-old/request.json"));
    const oldResult = file(join(fixtureRoots.integrationResults, "effect-old/lease-old/result.json"));
    const settledAction = file(join(fixtureRoots.actions, "attempt-settled/repository/output"));

    reclaimSandboxScratch({
      current: { kind: "integration", effect: "effect-current", lease: "lease-current" },
      roots: fixtureRoots,
      requireRoot: false,
    });

    expect(existsSync(currentInput)).toBe(true);
    expect(existsSync(currentResult)).toBe(true);
    expect(existsSync(oldInput)).toBe(false);
    expect(existsSync(oldResult)).toBe(false);
    expect(existsSync(settledAction)).toBe(false);
  });

  it("fails closed for hostile identifiers and refuses symlinked targets", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-sandbox-disk-hostile-"));
    const fixtureRoots = roots(root);
    for (const path of Object.values(fixtureRoots)) directory(path);
    const outside = file(join(root, "outside/keep.txt"), "safe\n");
    const symlink = join(fixtureRoots.actions, "attempt-settled");
    symlinkSync(join(root, "outside"), symlink);

    expect(() => reclaimSandboxScratch({
      current: { ...actionLaunch(), attempt: "../escape" },
      roots: fixtureRoots,
      requireRoot: false,
    })).toThrow(/attempt ID is unsafe/);

    const report = reclaimSandboxScratch({ current: actionLaunch(), roots: fixtureRoots, requireRoot: false });
    expect(existsSync(symlink)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("safe\n");
    expect(report.failures).toContain("refused unsafe action_materializations entry attempt-settled");
  });

  it("tolerates missing roots and bounds partial deletion failures and timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-sandbox-disk-bounded-"));
    const fixtureRoots = roots(root);
    directory(fixtureRoots.actions);
    directory(join(fixtureRoots.actions, "attempt-a"));
    directory(join(fixtureRoots.actions, "attempt-b"));
    let clock = 0;
    const report = reclaimSandboxScratch({
      current: actionLaunch(),
      roots: fixtureRoots,
      requireRoot: false,
      timeoutMs: 5,
      now: () => clock += 4,
      remove: (path) => ({ ok: false, timedOut: false, detail: `permission denied ${path}` }),
    });

    expect(report.failures.length).toBeLessThanOrEqual(32);
    expect(report.failures.join("\n")).toContain("permission denied");
    expect(report.timed_out).toBe(true);
  });
});

describe("sandbox disk inspection", () => {
  it("deduplicates healthy paths sharing one filesystem", () => {
    const report = inspectSandboxDisk({
      requiredKiB: 2_097_152,
      runDf: () => [
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/root 10485760 1024 3145728 1% /",
        "/dev/root 10485760 1024 3145728 1% /",
        "/dev/root 10485760 1024 3145728 1% /",
        "",
      ].join("\n"),
    });

    expect(report).toEqual({
      schema: "openthrottle.sandbox-disk-inspection/v1",
      required_kib: 2_097_152,
      low: false,
      filesystems: [{
        filesystem: "/dev/root",
        mount: "/",
        available_kib: 3_145_728,
        paths: ["/var/lib/openthrottle", "/home/agent", "/tmp"],
        low: false,
      }],
    });
  });

  it("reports an exact deficient filesystem and rejects malformed or oversized output", () => {
    const report = inspectSandboxDisk({
      requiredKiB: 2_097_152,
      runDf: () => [
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/runtime 10485760 1024 3145728 1% /var/lib/openthrottle",
        "/dev/home 10485760 1024 2097151 80% /home/agent",
        "/dev/runtime 10485760 1024 3145728 1% /var/lib/openthrottle",
      ].join("\n"),
    });

    expect(report.low).toBe(true);
    expect(report.filesystems[1]).toEqual({
      filesystem: "/dev/home",
      mount: "/home/agent",
      available_kib: 2_097_151,
      paths: ["/home/agent"],
      low: true,
    });
    expect(() => inspectSandboxDisk({ requiredKiB: 0, runDf: () => "" })).toThrow(/required KiB/);
    expect(() => inspectSandboxDisk({
      requiredKiB: 1,
      runDf: () => "invalid\n",
    })).toThrow(/header or row count/);
    expect(() => inspectSandboxDisk({
      requiredKiB: 1,
      runDf: () => "x".repeat(16 * 1024 + 1),
    })).toThrow(/oversized/);
  });
});
