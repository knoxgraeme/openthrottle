import { describe, expect, it } from "vitest";
import { inspectGitEnvironment, inspectPolicyArgs } from "./repository-authority.mjs";

describe("inspect repository authority", () => {
  it("allows Git to trust exactly the sealed action repository", () => {
    expect(inspectGitEnvironment("/var/lib/openthrottle/actions/a/repository")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/var/lib/openthrottle/actions/a/repository",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(() => inspectGitEnvironment("relative/repository")).toThrow("absolute repository path");
    expect(() => inspectGitEnvironment("/")).toThrow("cannot be safely scoped");
  });

  it("keeps native CLI inspection non-mutating", () => {
    const artifact = "/var/lib/openthrottle/actions/a/inspect-context/change.json";
    expect(inspectPolicyArgs("claude", "/var/lib/openthrottle/actions/a/repository", {
      readablePaths: [artifact],
    })).toEqual(expect.arrayContaining([
      "Read,Grep,Glob",
      "--add-dir",
      "/var/lib/openthrottle/actions/a/inspect-context",
      "Read(//var/lib/openthrottle/actions/a/repository/**),Read(//var/lib/openthrottle/actions/a/inspect-context/change.json)",
    ]));
    expect(inspectPolicyArgs("codex", "/var/lib/openthrottle/actions/a/repository"))
      .toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ignore-user-config"]));
    expect(() => inspectPolicyArgs("claude", "/sealed/repository", {
      readablePaths: ["/"],
    })).toThrow("cannot be safely scoped");
  });
});
