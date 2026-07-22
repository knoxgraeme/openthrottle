import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSandboxResources, SANDBOX_RESOURCE_DEFAULTS } from "./snapshot-resources.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Every other surface that documents or configures the sandbox disk default
// in prose/YAML/env form, alongside the regex that pulls the number it states.
// SANDBOX_RESOURCE_DEFAULTS.disk above is the one executable source of truth
// (it is what actually sizes the snapshot); everything below must restate the
// same quota-safe value or CI catches the drift.
const DISK_DOCUMENTATION_SURFACES = [
  { file: "supervisor/.env.example", pattern: /DAYTONA_SANDBOX_DISK=(\d+)/ },
  { file: "docs/SPEC.md", pattern: /DAYTONA_SANDBOX_DISK=(\d+)/ },
  { file: "README.md", pattern: /--cpu \d+ --memory \d+ --disk (\d+)/ },
  {
    file: ".github/workflows/deploy.yml",
    pattern: /\d+ vCPU \/ \d+ GiB \/ (\d+) GiB\)/,
  },
];

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
    // Daytona enforces a *total* disk quota per org (30 GiB standard tier), and
    // OpenThrottle retains a stopped sandbox per non-closed ticket, so the disk
    // default must stay small enough that several concurrent workspaces fit
    // under that quota — otherwise `daytona.create` fails with "Total disk limit
    // exceeded". Keep it low enough for ~6 sandboxes under 30 GiB.
    expect(SANDBOX_RESOURCE_DEFAULTS.disk).toBeLessThanOrEqual(5);
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

describe("sandbox disk default parity across surfaces", () => {
  it.each(DISK_DOCUMENTATION_SURFACES)(
    "matches SANDBOX_RESOURCE_DEFAULTS.disk in $file",
    (surface) => {
      // A contract test, not a unit test: it fails the moment any doc, workflow,
      // or example env file drifts from the executable default above, which is
      // exactly the failure mode (5 GiB shipped, 10 GiB documented everywhere
      // else) that let an operator size past the 30 GiB org disk quota.
      expect(readDocumentedDiskValue(surface)).toBe(SANDBOX_RESOURCE_DEFAULTS.disk);
    }
  );
});
