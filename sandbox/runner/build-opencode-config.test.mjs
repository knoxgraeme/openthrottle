import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpenCodeConfig,
  resolveOpenCodeModelProfile,
  writeOpenCodeConfig,
} from "./build-opencode-config.mjs";
import { OPENCODE_PROGRESSIVE_SKILLS_CAPABILITY } from "./action-profile.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCode config builder", () => {
  it("builds the Kimi Code subscription profile without materializing secrets", () => {
    const config = buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
    });

    expect(config.plugin).toBeUndefined();
    expect(config.provider["kimi-code"]).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://api.kimi.com/coding/v1",
        apiKey: "{env:KIMI_CODE_API_KEY}",
      },
      models: {
        "kimi-for-coding": {
          limit: { context: 262_144, output: 65_536 },
        },
      },
    });
    expect(config.mcp).toEqual({});
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  it("builds a reusable admission inspection profile with no mutation, shell, network, or MCP tools", () => {
    const config = buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      inspection: true,
    });
    expect(config.permission).toEqual({
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      task: "deny",
      external_directory: "deny",
      skill: { "*": "deny" },
    });
    expect(config.mcp).toEqual({});
  });

  it("allows only the named executor change artifact outside the inspect repository", () => {
    const artifact = "/var/lib/openthrottle/actions/a/inspect-change.json";
    const config = buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      inspection: true,
      readableExternalPaths: [artifact],
    });
    expect(config.permission).toMatchObject({
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      task: "deny",
      external_directory: { "*": "deny", [artifact]: "allow" },
    });
    expect(() => buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      inspection: true,
      readableExternalPaths: ["/**"],
    })).toThrow("cannot widen inspection authority");
  });

  it("fails closed for malformed and unsupported models", () => {
    expect(() => resolveOpenCodeModelProfile("kimi-for-coding")).toThrow("provider/model");
    expect(() => resolveOpenCodeModelProfile("kimi-code/kimi-k3")).toThrow(
      "Unsupported OpenCode model"
    );
  });

  it("exposes only an allowlisted sealed skill root through native progressive disclosure", () => {
    const config = buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      inspection: true,
      skillRoot: "/var/lib/openthrottle/actions/a/profile/skills",
      allowedSkills: ["review-change"],
      progressiveSkillsCapability: OPENCODE_PROGRESSIVE_SKILLS_CAPABILITY,
    });
    expect(config.skills).toEqual(["/var/lib/openthrottle/actions/a/profile/skills"]);
    expect(config.permission.skill).toEqual({ "*": "deny", "review-change": "allow" });
  });

  it("fails closed instead of inlining when native progressive skills are unavailable", () => {
    expect(() => buildOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      skillRoot: "/sealed/skills",
      allowedSkills: ["review-change"],
    })).toThrow("native progressive-skill capability is unavailable");
  });

  it("writes deterministic config to the supplied directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "ot-opencode-config-"));
    directories.push(directory);
    const configPath = writeOpenCodeConfig({
      model: "kimi-code/kimi-for-coding",
      configDir: directory,
    });
    expect(configPath).toBe(join(directory, "opencode.json"));
    expect(readFileSync(configPath, "utf8")).toBe(
      `${JSON.stringify(buildOpenCodeConfig({ model: "kimi-code/kimi-for-coding" }), null, 2)}\n`
    );
  });
});
