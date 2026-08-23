import { describe, expect, it } from "vitest";
import {
  inspectPolicyArgs,
  repositoryGitEnvironment,
} from "./repository-authority.mjs";

describe("repository authority", () => {
  it("allows Git to trust exactly one sealed action repository", () => {
    const environment = repositoryGitEnvironment("/var/lib/openthrottle/actions/a/repository");
    expect(environment).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/var/lib/openthrottle/actions/a/repository",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(() => repositoryGitEnvironment("relative/repository"))
      .toThrow("absolute repository path");
    expect(() => repositoryGitEnvironment("/"))
      .toThrow("cannot be safely scoped");
    expect(() => repositoryGitEnvironment("/var/lib/openthrottle/actions/*/repository"))
      .toThrow("cannot be safely scoped");
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
    expect(inspectPolicyArgs("codex", "/var/lib/openthrottle/actions/a/repository")).toEqual([
      "--sandbox", "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-c", 'web_search="disabled"',
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "in_app_browser",
      "--disable", "multi_agent",
      "--disable", "plugins",
      "--disable", "remote_plugin",
      "--disable", "image_generation",
    ]);
    expect(inspectPolicyArgs("codex", "/var/lib/openthrottle/actions/a/repository"))
      .not.toContain("use_legacy_landlock=true");
    expect(() => inspectPolicyArgs("claude", "/sealed/repository", {
      readablePaths: ["/"],
    })).toThrow("cannot be safely scoped");
  });
});
