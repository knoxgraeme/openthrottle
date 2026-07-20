import { describe, expect, it } from "vitest";
import { resolveSandboxResources, SANDBOX_RESOURCE_DEFAULTS } from "./snapshot-resources.mjs";

describe("resolveSandboxResources", () => {
  it("defaults to a build-capable size when no env is set", () => {
    expect(resolveSandboxResources({})).toEqual(SANDBOX_RESOURCE_DEFAULTS);
    // The whole point of the default is to clear the small tier that OOMs
    // monorepo builds, so guard the floor explicitly.
    expect(SANDBOX_RESOURCE_DEFAULTS.memory).toBeGreaterThanOrEqual(8);
    expect(SANDBOX_RESOURCE_DEFAULTS.cpu).toBeGreaterThanOrEqual(2);
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
