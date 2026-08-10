import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { reconcileSandboxAutostop } from "./lifecycle.js";
import {
  assertLogicalCredentialScopes,
  loadRuntimeCapabilityDescriptor,
  validateRuntimeCapabilityDescriptor,
} from "./contracts.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeDescriptorRepoPath = "supervisor/pipelines/runtime-capabilities-v1.json";

function git(args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function runtimeReleaseVersion(release: string): { prefix: string; version: number } | null {
  const match = /^(.*\/v)(\d+)$/.exec(release);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  return { prefix: match[1], version };
}

function isFreshRuntimeRelease(currentRelease: string, baseRelease: string): boolean {
  const current = runtimeReleaseVersion(currentRelease);
  const base = runtimeReleaseVersion(baseRelease);
  return current !== null &&
    base !== null &&
    current.prefix === base.prefix &&
    current.version > base.version;
}

function assertChangedRuntimeDescriptorReleaseIsFresh(
  currentRuntime: ReturnType<typeof validateRuntimeCapabilityDescriptor>,
  baseRuntime: ReturnType<typeof validateRuntimeCapabilityDescriptor>
): void {
  if (currentRuntime.normalized === baseRuntime.normalized) return;
  if (isFreshRuntimeRelease(currentRuntime.descriptor.release, baseRuntime.descriptor.release)) return;
  throw new Error(
    `${runtimeDescriptorRepoPath} changed from runtime release ${baseRuntime.descriptor.release} ` +
    `to ${currentRuntime.descriptor.release}; bump the descriptor release above ` +
    `${baseRuntime.descriptor.release} when changing capabilities, executors, evaluators, artifacts, ` +
    "context policies, credential scopes, adapters, or protocol"
  );
}

describe("sandbox runtime port", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  it("builds independent, deterministic capability evidence", () => {
    const first = buildInstalledRuntimeDescriptor("snapshot/v1");
    const second = buildInstalledRuntimeDescriptor("snapshot/v1", {
      capabilities: [...first.descriptor.capabilities].reverse(),
    });
    expect(first.digest).toBe(second.digest);
    expect(buildInstalledRuntimeDescriptor("snapshot/v1", {
      capabilities: ["command/run@1"],
    }).digest).not.toBe(first.digest);
    expect(first.descriptor.generatedBy).toBe("sandbox-runtime-build");
  });

  it("loads the shipped descriptor and rejects a mismatched configured release", () => {
    const path = fileURLToPath(new URL("../../pipelines/runtime-capabilities-v1.json", import.meta.url));
    const runtime = loadRuntimeCapabilityDescriptor(path, "openthrottle-snapshot/v10");
    expect(runtime.descriptor.capabilities).toContain("ce/implement@1");
    expect(runtime.descriptor.capabilities).toContain("loop-action@2");
    expect(() => loadRuntimeCapabilityDescriptor(path, "different-release/v1"))
      .toThrow(/does not match configured/);
  });

  it("rejects descriptor changes that reuse or rewind runtime release names", () => {
    const baseRuntime = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v4");
    const changedArtifacts = baseRuntime.descriptor.artifacts
      .filter((artifact) => artifact !== "execution_graph_result");

    for (const release of [
      "openthrottle-snapshot/v4",
      "openthrottle-snapshot/v3",
      "openthrottle-snapshot/latest",
      "different-snapshot/v5",
    ]) {
      const changedRuntime = buildInstalledRuntimeDescriptor(release, { artifacts: changedArtifacts });
      expect(() => assertChangedRuntimeDescriptorReleaseIsFresh(changedRuntime, baseRuntime))
        .toThrow(/bump the descriptor release above openthrottle-snapshot\/v4/);
    }

    const bumpedRuntime = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v5", {
      artifacts: changedArtifacts,
    });
    expect(() => assertChangedRuntimeDescriptorReleaseIsFresh(bumpedRuntime, baseRuntime))
      .not.toThrow();
    expect(() => assertChangedRuntimeDescriptorReleaseIsFresh(baseRuntime, baseRuntime))
      .not.toThrow();
  });

  it("requires a release bump when shipped descriptor content changes from the base branch", () => {
    const baseBranch = process.env.GITHUB_BASE_REF || process.env.BASE_BRANCH || "main";
    const baseRef = `origin/${baseBranch}`;
    const mergeBase = git(["merge-base", "HEAD", baseRef]);
    if (!mergeBase) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`unable to compare ${runtimeDescriptorRepoPath} with ${baseRef}; ensure CI fetches base history`);
      }
      console.warn(`Skipping runtime descriptor release guard because ${baseRef} is unavailable.`);
      return;
    }

    const baseRaw = git(["show", `${mergeBase}:${runtimeDescriptorRepoPath}`]);
    if (!baseRaw) {
      throw new Error(`unable to read base runtime descriptor at ${runtimeDescriptorRepoPath}`);
    }
    const currentRaw = readFileSync(join(repoRoot, runtimeDescriptorRepoPath), "utf8");
    const baseRuntime = validateRuntimeCapabilityDescriptor(JSON.parse(baseRaw) as unknown);
    const currentRuntime = validateRuntimeCapabilityDescriptor(JSON.parse(currentRaw) as unknown);

    assertChangedRuntimeDescriptorReleaseIsFresh(currentRuntime, baseRuntime);
  });

  it("reconciles lifecycle through opaque provider resource IDs", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    store.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-1",
      sandbox_id: "opaque-resource",
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
    });
    const runtime = { setActive: vi.fn(), setIdle: vi.fn() };
    await reconcileSandboxAutostop({
      runtime,
      store,
      issueId: "issue-1",
      providerResourceId: "opaque-resource",
    });
    expect(runtime.setIdle).toHaveBeenCalledWith("opaque-resource");
    expect(runtime.setActive).not.toHaveBeenCalled();
  });

  it("keeps provider SDK types outside the runtime port", () => {
    const source = readFileSync(fileURLToPath(new URL("./contracts.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("@daytona/sdk");
    expect(source).not.toMatch(/Daytona/);
  });

  it("accepts only the closed logical credential scope set for loop actions", () => {
    expect(() => assertLogicalCredentialScopes(["model.invoke", "repo.read", "mcp"])).not.toThrow();
    expect(() => assertLogicalCredentialScopes([])).not.toThrow();
    expect(() => assertLogicalCredentialScopes(["daytona.admin"]))
      .toThrow(/credential scope daytona\.admin is not a recognized logical credential/);
  });
});
