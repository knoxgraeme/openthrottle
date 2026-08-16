import type { SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  operatorSkillSource,
  parseOperatorSkillArgs,
  resolveOperatorSkillSourceRef,
  runOperatorSkillAction,
} from "./operator-skill.js";

const directories: string[] = [];
const sourceRef = "0123456789abcdef0123456789abcdef01234567";
const originalGithubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-operator-skill-test-"));
  directories.push(directory);
  return directory;
}

function spawnResult(json: unknown, status = 0): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(JSON.stringify(json)),
    stderr: Buffer.from(""),
    status,
    signal: null,
  } as SpawnSyncReturns<Buffer>;
}

function installedSkill(home: string, agentRoot: ".codex" | ".claude" | ".opencode" | ".config/opencode", manifest: unknown): string {
  const target = join(home, agentRoot, "skills", "openthrottle");
  mkdirSync(target, { recursive: true });
  cpSync(resolve(process.cwd(), "../skills/operator/openthrottle"), target, { recursive: true });
  writeFileSync(join(target, ".skillfish.json"), JSON.stringify(manifest, null, 2));
  return target;
}

function stagedSkill(stageHome: string, agentRoot: ".codex" | ".claude" | ".opencode"): string {
  const target = join(stageHome, agentRoot, "skills", "openthrottle");
  mkdirSync(target, { recursive: true });
  cpSync(resolve(process.cwd(), "../skills/operator/openthrottle"), target, { recursive: true });
  writeFileSync(join(target, ".skillfish.json"), JSON.stringify({
    owner: "knoxgraeme",
    repo: "openthrottle",
    path: "skills/operator/openthrottle",
    source: "manifest",
  }, null, 2));
  return target;
}

describe("operator skill package", () => {
  it("keeps Codex invocation explicit in agent metadata", () => {
    const metadata = readFileSync(resolve(process.cwd(), "../skills/operator/openthrottle/agents/openai.yaml"), "utf8");

    expect(metadata).toContain("allow_implicit_invocation: false");
  });

  it("provides focused one-level references for operator workflows", () => {
    const skill = readFileSync(resolve(process.cwd(), "../skills/operator/openthrottle/SKILL.md"), "utf8");
    for (const name of ["ship", "trigger", "tune", "monitor"]) {
      expect(readFileSync(resolve(process.cwd(), `../skills/operator/openthrottle/references/${name}.md`), "utf8")).toContain(`# ${name[0]!.toUpperCase()}${name.slice(1)}`);
    }
    const ship = readFileSync(resolve(process.cwd(), "../skills/operator/openthrottle/references/ship.md"), "utf8");
    expect(ship).toContain("openthrottle plan prepare <file.md> --graph structured --json");
    expect(ship).toContain("openthrottle plan validate <file.md> --graph structured --json");
    expect(ship).toContain("openthrottle ship <file.md> --graph structured");
    expect(ship).toContain("explicit authorization for that write");
    expect(ship).toMatch(/not a read-only preview or\s+dry run/);
    expect(ship).toContain("validated digest from the validation JSON output");
    expect(ship).toContain("never fall back to `simple`");
    expect(ship).toContain("Ticket reuse, trigger-state JSON, and recovery commands are capability-gated");
    expect(skill).toContain("Keep ambiguity resolution and discovery read-only");
    expect(skill).toContain("obtain the user's explicit authorization");
    expect(skill).toContain("validate the written plan, and report the");
    expect(skill).toContain("never fall back to `simple`");
  });
});

describe("operator skill command parsing and source", () => {
  it("defaults to read-only status and accepts explicit lifecycle actions", () => {
    expect(parseOperatorSkillArgs([])).toEqual({ action: "status", json: false });
    expect(parseOperatorSkillArgs(["install", "--json"])).toEqual({ action: "install", json: true });
    expect(parseOperatorSkillArgs(["refresh"])).toEqual({ action: "refresh", json: false });
    expect(parseOperatorSkillArgs(["remove"])).toEqual({ action: "remove", json: false });
  });

  it("rejects mutable source refs", () => {
    expect(() => resolveOperatorSkillSourceRef({ sourceRef: "main" })).toThrow(/not immutable/);
    expect(operatorSkillSource(sourceRef)).toBe(
      "knoxgraeme/openthrottle@0123456789abcdef0123456789abcdef01234567/skills/operator/openthrottle"
    );
  });

  it("fails closed when packaged metadata records an unavailable source ref", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "operator-skill-source.json"), JSON.stringify({
      source: null,
      source_ref: null,
      source_unavailable_reason: "operator skill source ref would not match the working tree",
    }));

    expect(() => resolveOperatorSkillSourceRef({ moduleUrl: pathToFileURL(join(directory, "operator-skill.js")).href }))
      .toThrow(/would not match the working tree/);
  });
});

describe("operator skill Skillfish wrapper", () => {
  it("installs missing detected supported agents through a pinned manifest without forwarding credentials", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const unrelatedSkill = join(home, ".codex", "skills", "other-skill", "SKILL.md");
    mkdirSync(join(home, ".codex", "skills", "other-skill"), { recursive: true });
    writeFileSync(unrelatedSkill, "---\nname: other-skill\n---\n");
    const calls: Array<{ args: string[]; home: string; env: NodeJS.ProcessEnv }> = [];
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, home: options.env.HOME ?? "", env: options.env });
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Codex", "Claude Code", "OpenCode"],
        });
      }
      const manifest = JSON.parse(readFileSync(join(options.env.HOME ?? "", "skillfish.json"), "utf8")) as { skills: string[] };
      expect(manifest.skills).toEqual([operatorSkillSource(sourceRef)]);
      const stagedCodexPath = stagedSkill(options.env.HOME ?? "", ".codex");
      const stagedClaudePath = stagedSkill(options.env.HOME ?? "", ".claude");
      const stagedOpenCodePath = stagedSkill(options.env.HOME ?? "", ".opencode");
      return spawnResult({
        success: true,
        installed: [
          { skill: "openthrottle", agent: "Codex", path: stagedCodexPath, location: "global" },
          { skill: "openthrottle", agent: "Claude Code", path: stagedClaudePath, location: "global" },
          { skill: "openthrottle", agent: "OpenCode", path: stagedOpenCodePath, location: "global" },
        ],
        skipped: [],
      });
    };
    process.env.GITHUB_TOKEN = "test-token-not-forwarded";

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(true);
    expect(result.installed.map((entry) => entry.agent).sort()).toEqual(["Claude Code", "Codex", "OpenCode"]);
    expect(result.installed.map((entry) => entry.path).sort()).toEqual([
      join(home, ".claude", "skills", "openthrottle"),
      join(home, ".codex", "skills", "openthrottle"),
      join(home, ".config", "opencode", "skills", "openthrottle"),
    ].sort());
    expect(result.installed.map((entry) => entry.path)).not.toContain(join(home, ".opencode", "skills", "openthrottle"));
    expect(readFileSync(unrelatedSkill, "utf8")).toContain("other-skill");
    expect(result.unsupported).toEqual([]);
    expect(calls.map((call) => call.args)).toEqual([
      ["list", "--global", "--json"],
      ["install", "--global", "--yes", "--json"],
    ]);
    expect(calls[1]!.env.DO_NOT_TRACK).toBe("1");
    expect(calls[1]!.env.CI).toBe("1");
    expect(calls[1]!.env.GITHUB_TOKEN).toBeUndefined();
    expect(calls[1]!.env.OT_STATUS_TOKEN).toBeUndefined();
  });

  it("refresh replaces stale owned installs without removing unrelated skills", () => {
    const home = temporaryDirectory();
    const path = installedSkill(home, ".codex", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    writeFileSync(join(path, "SKILL.md"), "---\nname: openthrottle\n---\nlocally modified\n");
    const unrelatedSkill = join(home, ".codex", "skills", "other-skill", "SKILL.md");
    mkdirSync(join(home, ".codex", "skills", "other-skill"), { recursive: true });
    writeFileSync(unrelatedSkill, "---\nname: other-skill\n---\n");
    const calls: string[][] = [];
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push(args);
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [{
            skill: "openthrottle",
            agent: "Codex",
            path: join(options.env.HOME ?? "", ".codex", "skills", "openthrottle"),
            location: "global",
          }],
          agents_detected: ["Codex"],
        });
      }
      const stagedCodexPath = stagedSkill(options.env.HOME ?? "", ".codex");
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path: stagedCodexPath, location: "global" }],
        skipped: [],
      });
    };

    const result = runOperatorSkillAction("refresh", { home, runner, sourceRef });

    expect(result.success).toBe(true);
    expect(result.installed).toEqual([{ agent: "Codex", status: "installed", path }]);
    expect(readFileSync(join(path, "SKILL.md"), "utf8")).not.toContain("locally modified");
    expect(readFileSync(unrelatedSkill, "utf8")).toContain("other-skill");
    expect(calls).toEqual([
      ["list", "--global", "--json"],
      ["install", "--global", "--yes", "--json"],
    ]);
  });

  it("attributes Skillfish install failures to every agent attempted by that command", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const runner = (args: string[]) => {
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Claude Code", "OpenCode"],
        });
      }
      return spawnResult({ success: false, errors: ["remote install failed"] }, 1);
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(false);
    expect(result.conflicted).toEqual([
      { agent: "Claude Code", status: "conflicted", reason: "remote install failed" },
      { agent: "OpenCode", status: "conflicted", reason: "remote install failed" },
    ]);
  });

  it("refuses incomplete staged Skillfish installs before copying real targets", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Codex", "Claude Code"],
        });
      }
      const stagedCodexPath = stagedSkill(options.env.HOME ?? "", ".codex");
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path: stagedCodexPath, location: "global" }],
        skipped: [],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(false);
    expect(result.conflicted.map((entry) => entry.agent).sort()).toEqual(["Claude Code", "Codex"]);
    expect(result.conflicted[0]!.reason).toContain("did not stage OpenThrottle for Claude Code");
    expect(existsSync(join(home, ".codex", "skills", "openthrottle"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "openthrottle"))).toBe(false);
  });

  it("refuses staged Skillfish installs from unexpected paths", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Codex"],
        });
      }
      const unexpectedPath = stagedSkill(options.env.HOME ?? "", ".claude");
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path: unexpectedPath, location: "global" }],
        skipped: [],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(false);
    expect(result.conflicted).toEqual([
      {
        agent: "Codex",
        status: "conflicted",
        path: join(home, ".codex", "skills", "openthrottle"),
        reason: expect.stringContaining("unexpected path"),
      },
    ]);
    expect(existsSync(join(home, ".codex", "skills", "openthrottle"))).toBe(false);
  });

  it("refuses staged Skillfish installs whose bytes differ from the packaged source", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Codex"],
        });
      }
      const stagedCodexPath = stagedSkill(options.env.HOME ?? "", ".codex");
      writeFileSync(join(stagedCodexPath, "SKILL.md"), "---\nname: openthrottle\n---\nchanged bytes\n");
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path: stagedCodexPath, location: "global" }],
        skipped: [],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(false);
    expect(result.conflicted).toEqual([
      {
        agent: "Codex",
        status: "conflicted",
        path: join(home, ".codex", "skills", "openthrottle"),
        reason: expect.stringContaining("differ from the packaged OpenThrottle skill"),
      },
    ]);
    expect(existsSync(join(home, ".codex", "skills", "openthrottle"))).toBe(false);
  });

  it("leaves every real agent target unchanged when destination preparation fails", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills"), "blocks the destination directory");
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [],
          agents_detected: ["Codex", "Claude Code"],
        });
      }
      const stagedCodexPath = stagedSkill(options.env.HOME ?? "", ".codex");
      const stagedClaudePath = stagedSkill(options.env.HOME ?? "", ".claude");
      return spawnResult({
        success: true,
        installed: [
          { skill: "openthrottle", agent: "Codex", path: stagedCodexPath, location: "global" },
          { skill: "openthrottle", agent: "Claude Code", path: stagedClaudePath, location: "global" },
        ],
        skipped: [],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(false);
    expect(result.installed).toEqual([]);
    expect(result.conflicted.map((entry) => entry.agent).sort()).toEqual(["Claude Code", "Codex"]);
    expect(existsSync(join(home, ".codex", "skills", "openthrottle"))).toBe(false);
    expect(readFileSync(join(home, ".claude", "skills"), "utf8")).toBe("blocks the destination directory");
  });

  it("keeps install from overwriting stale owned installs without refresh", () => {
    const home = temporaryDirectory();
    const path = installedSkill(home, ".codex", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    writeFileSync(join(path, "SKILL.md"), "---\nname: openthrottle\n---\nlocally modified\n");
    let calls = 0;
    const runner = () => {
      calls += 1;
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path, location: "global" }],
        agents_detected: ["Codex"],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.conflicted).toEqual([
      {
        agent: "Codex",
        status: "conflicted",
        path,
        reason: "installed OpenThrottle skill differs from the packaged source",
      },
    ]);
    expect(result.recovery).toEqual(["openthrottle operator-skill refresh"]);
    expect(readFileSync(join(path, "SKILL.md"), "utf8")).toContain("locally modified");
  });

  it("reports detected agents without installs in read-only status", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const runner = () => spawnResult({
      success: true,
      installed: [],
      agents_detected: ["Codex"],
    });

    const result = runOperatorSkillAction("status", { home, runner, sourceRef });

    expect(result.success).toBe(true);
    expect(result.skipped).toEqual([{ agent: "Codex", status: "skipped", reason: "not installed" }]);
  });

  it("fails install when Skillfish detects no supported agent", () => {
    const home = temporaryDirectory();
    let calls = 0;
    const runner = () => {
      calls += 1;
      return spawnResult({
        success: true,
        installed: [],
        agents_detected: [],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect(result.unsupported).toEqual([
      { agent: "Claude Code", status: "unsupported", reason: "agent not detected by Skillfish" },
      { agent: "Codex", status: "unsupported", reason: "agent not detected by Skillfish" },
      { agent: "OpenCode", status: "unsupported", reason: "agent not detected by Skillfish" },
    ]);
  });

  it("normalizes Skillfish list paths before its temporary HOME is removed", () => {
    const home = temporaryDirectory();
    const path = installedSkill(home, ".codex", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    const runner = (_args: string[], options: { env: NodeJS.ProcessEnv }) => spawnResult({
      success: true,
      installed: [{
        skill: "openthrottle",
        agent: "Codex",
        path: join(options.env.HOME ?? "", ".codex", "skills", "openthrottle"),
        location: "global",
      }],
      agents_detected: ["Codex"],
    });

    const result = runOperatorSkillAction("status", { home, runner, sourceRef });

    expect(result.success).toBe(true);
    expect(result.installed).toEqual([{ agent: "Codex", status: "installed", path }]);
  });

  it("skips exact matching installs idempotently", () => {
    const home = temporaryDirectory();
    const path = installedSkill(home, ".codex", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    const runner = (args: string[]) => {
      expect(args[0]).toBe("list");
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path, location: "global" }],
        agents_detected: ["Codex"],
      });
    };

    const result = runOperatorSkillAction("install", { home, runner, sourceRef });

    expect(result.success).toBe(true);
    expect(result.skipped).toEqual([{ agent: "Codex", status: "skipped", path, reason: "already installed from matching source" }]);
  });

  it("refuses to overwrite a conflicting local openthrottle skill", () => {
    const home = temporaryDirectory();
    const path = installedSkill(home, ".codex", {
      owner: "someone",
      repo: "else",
      path: "skills/operator/openthrottle",
      source: "manual",
    });
    let calls = 0;
    const runner = () => {
      calls += 1;
      return spawnResult({
        success: true,
        installed: [{ skill: "openthrottle", agent: "Codex", path, location: "global" }],
        agents_detected: ["Codex"],
      });
    };

    const result = runOperatorSkillAction("refresh", { home, runner, sourceRef });

    expect(calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.conflicted).toEqual([
      {
        agent: "Codex",
        status: "conflicted",
        path,
        reason: "existing openthrottle skill is not Skillfish-managed from OpenThrottle",
      },
    ]);
    expect(result.recovery).toEqual(["openthrottle operator-skill remove && openthrottle operator-skill install"]);
  });

  it("removes only exact Skillfish-managed OpenThrottle installs", () => {
    const home = temporaryDirectory();
    const codexPath = installedSkill(home, ".codex", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    const claudePath = installedSkill(home, ".claude", {
      owner: "someone",
      repo: "else",
      path: "skills/operator/openthrottle",
      source: "manual",
    });
    const calls: string[][] = [];
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push(args);
      if (args[0] === "list") {
        return spawnResult({
          success: true,
          installed: [
            {
              skill: "openthrottle",
              agent: "Codex",
              path: join(options.env.HOME ?? "", ".codex", "skills", "openthrottle"),
              location: "global",
            },
            {
              skill: "openthrottle",
              agent: "Claude Code",
              path: join(options.env.HOME ?? "", ".claude", "skills", "openthrottle"),
              location: "global",
            },
          ],
          agents_detected: ["Codex", "Claude Code"],
        });
      }
      rmSync(codexPath, { recursive: true, force: true });
      return spawnResult({ success: true, removed: [{ skill: "openthrottle", agent: "Codex", path: codexPath }] });
    };

    const result = runOperatorSkillAction("remove", { home, runner, sourceRef });

    expect(calls).toEqual([
      ["list", "--global", "--json"],
      ["remove", "openthrottle", "--global", "--yes", "--json"],
    ]);
    expect(result.removed).toEqual([{ agent: "Codex", status: "removed", path: codexPath }]);
    expect(result.conflicted).toEqual([
      {
        agent: "Claude Code",
        status: "conflicted",
        path: claudePath,
        reason: "existing openthrottle skill is not Skillfish-managed from OpenThrottle",
      },
    ]);
  });

  it("removes exact OpenCode config installs without relying on Skillfish's legacy path", () => {
    const home = temporaryDirectory();
    const openCodePath = installedSkill(home, ".config/opencode", {
      owner: "knoxgraeme",
      repo: "openthrottle",
      path: "skills/operator/openthrottle",
      source: "manifest",
    });
    const calls: string[][] = [];
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push(args);
      return spawnResult({
        success: true,
        installed: [],
        agents_detected: ["OpenCode"],
      });
    };

    const result = runOperatorSkillAction("remove", { home, runner, sourceRef });

    expect(calls).toEqual([["list", "--global", "--json"]]);
    expect(result.success).toBe(true);
    expect(result.removed).toEqual([{ agent: "OpenCode", status: "removed", path: openCodePath }]);
    expect(existsSync(openCodePath)).toBe(false);
  });
});
