import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSandboxResources, SANDBOX_RESOURCE_DEFAULTS } from "./snapshot-resources.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The executable default is authoritative. Only the operator env template
// restates it; prose and workflow comments intentionally do not duplicate it.
const DISK_ENV_SURFACE = {
  file: "supervisor/.env.example",
  pattern: /DAYTONA_SANDBOX_DISK=(\d+)/,
};

function readDocumentedDiskValue({ file, pattern }) {
  const contents = readFileSync(path.join(repoRoot, file), "utf8");
  const match = contents.match(pattern);
  if (!match) {
    throw new Error(`Expected ${file} to document a sandbox disk value matching ${pattern}`);
  }
  return Number(match[1]);
}

describe("resolveSandboxResources", () => {
  it("defaults to a build-capable size when no env is set", () => {
    expect(resolveSandboxResources({})).toEqual(SANDBOX_RESOURCE_DEFAULTS);
    // The whole point of the default is to clear the small tier that OOMs
    // monorepo builds, so guard the floor explicitly.
    expect(SANDBOX_RESOURCE_DEFAULTS.memory).toBeGreaterThanOrEqual(8);
    expect(SANDBOX_RESOURCE_DEFAULTS.cpu).toBeGreaterThanOrEqual(2);
    expect(SANDBOX_RESOURCE_DEFAULTS.disk).toBeGreaterThanOrEqual(10);
  });

  it("reads operator overrides for every dimension", () => {
    expect(
      resolveSandboxResources({
        DAYTONA_SANDBOX_CPU: "8",
        DAYTONA_SANDBOX_MEMORY: "16",
        DAYTONA_SANDBOX_DISK: "80",
      })
    ).toEqual({ cpu: 8, memory: 16, disk: 80 });
  });

  it("treats a blank override as unset and keeps the default", () => {
    expect(resolveSandboxResources({ DAYTONA_SANDBOX_MEMORY: "   " }).memory).toBe(
      SANDBOX_RESOURCE_DEFAULTS.memory
    );
  });

  it("rejects non-positive-integer overrides instead of silently mis-sizing", () => {
    expect(() => resolveSandboxResources({ DAYTONA_SANDBOX_MEMORY: "8gb" })).toThrow(
      /positive integer/
    );
    expect(() => resolveSandboxResources({ DAYTONA_SANDBOX_CPU: "0" })).toThrow(/positive integer/);
    expect(() => resolveSandboxResources({ DAYTONA_SANDBOX_DISK: "-4" })).toThrow(/positive integer/);
    expect(() => resolveSandboxResources({ DAYTONA_SANDBOX_MEMORY: "2.5" })).toThrow(
      /positive integer/
    );
  });
});

describe("sandbox disk operator default", () => {
  it("matches the executable default in supervisor/.env.example", () => {
    expect(readDocumentedDiskValue(DISK_ENV_SURFACE)).toBe(SANDBOX_RESOURCE_DEFAULTS.disk);
  });
});
