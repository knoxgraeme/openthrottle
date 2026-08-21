import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { definitionEntryIdentity } from "@openthrottle/contracts";
import { loadKernelReleaseDefinitions } from "./kernel-release.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("loadKernelReleaseDefinitions", () => {
  it("derives restart trust from independently sealed raw release inputs", () => {
    const release = loadKernelReleaseDefinitions({
      release_root: repositoryRoot,
      generated_root: `${repositoryRoot}/contracts/generated`,
    });

    expect(release.compiler_environment.descriptor.compiler_version)
      .toBe("definition-compiler/v1");
    expect(release.trusted_platform_definitions.get(
      definitionEntryIdentity("pipeline", "core/implement"),
    )).toMatch(/^[a-f0-9]{64}$/);
    expect(release.trusted_platform_definitions.get(
      definitionEntryIdentity("agent", "core/reviewer"),
    )).toMatch(/^[a-f0-9]{64}$/);
  });
});
