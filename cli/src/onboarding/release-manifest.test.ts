import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ReleaseManifest } from "./contracts.js";
import { loadReleaseManifest } from "./release-manifest.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-release-manifest-test-"));
  directories.push(directory);
  return directory;
}

const manifest: ReleaseManifest = {
  schema: "openthrottle.release-manifest/v1",
  cliVersion: "2.0.0",
  releaseId: "v2.0.0",
  supervisorImage: `ghcr.io/acme/supervisor@sha256:${"a".repeat(64)}`,
  sandboxImage: `ghcr.io/acme/sandbox@sha256:${"b".repeat(64)}`,
  runtime: { release: "runtime-v2", descriptorDigest: `sha256:${"c".repeat(64)}` },
  recommendedResources: { cpu: 2, memoryMb: 4096, diskGb: 10 },
};

interface FakeInstall {
  moduleUrl: string;
  bundledPath: string;
}

function fakeInstall(input: { manifest?: unknown; version?: string } = {}): FakeInstall {
  const root = temporaryDirectory();
  mkdirSync(join(root, "dist", "onboarding"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openthrottle", version: input.version ?? "2.0.0" }));
  const bundledPath = join(root, "dist", "release-manifest.json");
  if (input.manifest !== undefined) {
    writeFileSync(bundledPath, `${JSON.stringify(input.manifest, null, 2)}\n`);
  }
  return { moduleUrl: pathToFileURL(join(root, "dist", "onboarding", "release-manifest.js")).href, bundledPath };
}

describe("release manifest loader", () => {
  it("loads and validates the manifest bundled next to the compiled module", () => {
    const install = fakeInstall({ manifest });

    const result = loadReleaseManifest({ env: {}, moduleUrl: install.moduleUrl });

    expect(result).toEqual({ status: "pinned", manifest, source: install.bundledPath });
  });

  it("prefers the OT_RELEASE_MANIFEST override over the bundled manifest", () => {
    const install = fakeInstall({ manifest });
    const overridePath = join(temporaryDirectory(), "override-manifest.json");
    writeFileSync(overridePath, JSON.stringify({ ...manifest, releaseId: "v2.0.0-override" }));

    const result = loadReleaseManifest({ env: { OT_RELEASE_MANIFEST: overridePath }, moduleUrl: install.moduleUrl });

    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") throw new Error("expected a pinned result");
    expect(result.manifest.releaseId).toBe("v2.0.0-override");
    expect(result.source).toBe(overridePath);
  });

  it("returns a typed unpinned result when no manifest is baked and no override is set", () => {
    const install = fakeInstall();

    const result = loadReleaseManifest({ env: {}, moduleUrl: install.moduleUrl });

    expect(result).toEqual({
      status: "unpinned",
      reason: "no release manifest is bundled with this install and OT_RELEASE_MANIFEST is not set",
    });
    expect(() =>
      loadReleaseManifest({ env: { OT_RELEASE_MANIFEST: install.bundledPath }, moduleUrl: install.moduleUrl })
    ).toThrow("missing file");
  });

  it("rejects images that are not digest-pinned", () => {
    const install = fakeInstall({ manifest: { ...manifest, supervisorImage: "ghcr.io/acme/supervisor:latest" } });

    expect(() => loadReleaseManifest({ env: {}, moduleUrl: install.moduleUrl })).toThrow("digest-pinned");
  });

  it("rejects a manifest built for a different CLI version", () => {
    const install = fakeInstall({ manifest, version: "2.0.1" });

    expect(() => loadReleaseManifest({ env: {}, moduleUrl: install.moduleUrl })).toThrow(
      "does not match installed CLI version 2.0.1"
    );
  });

  it("accepts a valid snapshot name and rejects malformed ones", () => {
    const named = fakeInstall({
      manifest: { ...manifest, runtime: { ...manifest.runtime, snapshotName: "openthrottle-v13" } },
    });
    const result = loadReleaseManifest({ env: {}, moduleUrl: named.moduleUrl });
    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") throw new Error("expected a pinned result");
    expect(result.manifest.runtime.snapshotName).toBe("openthrottle-v13");

    for (const snapshotName of ["", ".starts-with-dot", "has space", "x".repeat(129)]) {
      const install = fakeInstall({
        manifest: { ...manifest, runtime: { ...manifest.runtime, snapshotName } },
      });
      expect(() => loadReleaseManifest({ env: {}, moduleUrl: install.moduleUrl })).toThrow("snapshot name");
    }
  });

  it("throws precise errors for malformed manifests", () => {
    const notJson = fakeInstall();
    writeFileSync(notJson.bundledPath, "{not json");
    expect(() => loadReleaseManifest({ env: {}, moduleUrl: notJson.moduleUrl })).toThrow("not valid JSON");

    const unknownField = fakeInstall({ manifest: { ...manifest, extra: true } });
    expect(() => loadReleaseManifest({ env: {}, moduleUrl: unknownField.moduleUrl })).toThrow("unknown field extra");

    const badDigest = fakeInstall({
      manifest: { ...manifest, runtime: { ...manifest.runtime, descriptorDigest: "c".repeat(64) } },
    });
    expect(() => loadReleaseManifest({ env: {}, moduleUrl: badDigest.moduleUrl })).toThrow("descriptorDigest");

    const badResources = fakeInstall({
      manifest: { ...manifest, recommendedResources: { cpu: 0, memoryMb: 4096, diskGb: 10 } },
    });
    expect(() => loadReleaseManifest({ env: {}, moduleUrl: badResources.moduleUrl })).toThrow("positive number");
  });
});
