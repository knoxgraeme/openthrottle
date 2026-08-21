import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeClaudeProfileBaseline,
  materializeCodexProfileBaseline,
} from "./action-home-baseline.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      if (existsSync(directory)) chmodSync(directory, 0o700);
      if (existsSync(directory)) execFileSync("chmod", ["-R", "u+w", directory]);
    } catch {
      // Tests deliberately create read-only trusted baselines.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("action home baseline materialization", () => {
  it("resolves default baselines from OT_ACTION_HOME_BASELINE_ROOT", () => {
    const baselineRoot = mkdtempSync(join(tmpdir(), "ot-baseline-root-"));
    const codexDestination = mkdtempSync(join(tmpdir(), "ot-codex-destination-"));
    const claudeDestination = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    directories.push(baselineRoot, codexDestination, claudeDestination);
    mkdirSync(join(baselineRoot, "codex"), { recursive: true });
    writeFileSync(join(baselineRoot, "codex", "config.toml"), "model = \"overridden\"\n");
    process.env.OT_ACTION_HOME_BASELINE_ROOT = baselineRoot;
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        // Root-created override entries pass the trusted baseline check, so the
        // override content — not the root-baked /opt baseline — must copy.
        expect(materializeCodexProfileBaseline({ destinationHome: codexDestination }))
          .toEqual(["config.toml"]);
        expect(readFileSync(join(codexDestination, "config.toml"), "utf8")).toContain("overridden");
      } else {
        // Unprivileged override entries fail the trusted baseline check and
        // nothing copies — but the default path must resolve inside the
        // override instead of throwing EACCES on the root-baked /opt baseline.
        expect(materializeCodexProfileBaseline({ destinationHome: codexDestination })).toEqual([]);
        expect(existsSync(join(codexDestination, "config.toml"))).toBe(false);
      }
      expect(materializeClaudeProfileBaseline({ destinationHome: claudeDestination })).toEqual([]);
    } finally {
      delete process.env.OT_ACTION_HOME_BASELINE_ROOT;
    }
  });

  it("rejects a relative action home baseline root", () => {
    const destination = mkdtempSync(join(tmpdir(), "ot-codex-destination-"));
    directories.push(destination);
    process.env.OT_ACTION_HOME_BASELINE_ROOT = "relative/baseline";
    try {
      expect(() => materializeCodexProfileBaseline({ destinationHome: destination }))
        .toThrow("action home baseline root is invalid");
      expect(() => materializeClaudeProfileBaseline({ destinationHome: destination }))
        .toThrow("action home baseline root is invalid");
    } finally {
      delete process.env.OT_ACTION_HOME_BASELINE_ROOT;
    }
  });

  it("copies only non-secret Codex profile files into isolated homes", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-codex-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-codex-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "config.toml"), "model = \"test\"\n");
    writeFileSync(join(source, "AGENTS.md"), "repo instructions\n");
    writeFileSync(join(source, "auth.json"), "{\"token\":\"secret\"}\n");
    chmodSync(join(source, "config.toml"), 0o444);
    chmodSync(join(source, "AGENTS.md"), 0o444);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(join(source, "config.toml"), 0, 0);
      chownSync(join(source, "AGENTS.md"), 0, 0);
    }

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      expect(materializeCodexProfileBaseline({ sourceHome: source, destinationHome: destination }))
        .toEqual(["config.toml", "AGENTS.md"]);

      expect(readFileSync(join(destination, "config.toml"), "utf8")).toContain("model");
      expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toContain("repo instructions");
    } else {
      expect(materializeCodexProfileBaseline({ sourceHome: source, destinationHome: destination }))
        .toEqual([]);
      expect(existsSync(join(destination, "config.toml"))).toBe(false);
      expect(existsSync(join(destination, "AGENTS.md"))).toBe(false);
    }
    expect(existsSync(join(destination, "auth.json"))).toBe(false);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
  });

  it("does not copy mutable Codex profile files into isolated homes", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-codex-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-codex-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "config.toml"), "model = \"ambient-model\"\n");
    writeFileSync(join(source, "AGENTS.md"), "mutable instructions\n");
    chmodSync(join(source, "config.toml"), 0o600);
    chmodSync(join(source, "AGENTS.md"), 0o600);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(join(source, "config.toml"), 1, 1);
      chownSync(join(source, "AGENTS.md"), 1, 1);
    }

    expect(materializeCodexProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual([]);

    expect(existsSync(join(destination, "config.toml"))).toBe(false);
    expect(existsSync(join(destination, "AGENTS.md"))).toBe(false);
  });

  it("never copies skills or credential files from the Claude baseline", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-claude-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "credentials.json"), "{\"token\":\"secret\"}\n");
    writeFileSync(join(source, "settings.json"), "{}\n");
    const skillDir = join(source, "skills", "implement-unit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    chmodSync(join(source, "skills"), 0o555);
    chmodSync(skillDir, 0o555);
    chmodSync(join(skillDir, "SKILL.md"), 0o444);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(join(source, "skills"), 0, 0);
      chownSync(skillDir, 0, 0);
      chownSync(join(skillDir, "SKILL.md"), 0, 0);
    }

    expect(materializeClaudeProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual([]);
    expect(existsSync(join(destination, "skills"))).toBe(false);
    expect(existsSync(join(destination, "credentials.json"))).toBe(false);
    expect(existsSync(join(destination, "settings.json"))).toBe(false);
  });

  it("does not inspect or report partial Claude skill discovery copies", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const source = mkdtempSync(join(tmpdir(), "ot-claude-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "credentials.json"), "{\"token\":\"secret\"}\n");
    const skillDir = join(source, "skills", "implement-unit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    symlinkSync(join(source, "credentials.json"), join(skillDir, "credential-link"));
    chmodSync(join(source, "skills"), 0o555);
    chmodSync(skillDir, 0o555);
    chmodSync(join(skillDir, "SKILL.md"), 0o444);
    chownSync(join(source, "skills"), 0, 0);
    chownSync(skillDir, 0, 0);
    chownSync(join(skillDir, "SKILL.md"), 0, 0);

    expect(materializeClaudeProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual([]);

    expect(existsSync(join(destination, "skills"))).toBe(false);
  });

  it("does not copy mutable Claude skill discovery trees", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-claude-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    directories.push(source, destination);
    const skillDir = join(source, "skills", "implement-unit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# mutable skill\n");

    expect(materializeClaudeProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual([]);

    expect(existsSync(join(destination, "skills"))).toBe(false);
  });

  it("replaces a stale Claude profile symlink without materializing skills", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const source = mkdtempSync(join(tmpdir(), "ot-claude-source-"));
    const destinationParent = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    const persistentProfile = mkdtempSync(join(tmpdir(), "ot-claude-persistent-"));
    directories.push(source, destinationParent, persistentProfile);
    const skillDir = join(source, "skills", "implement-unit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    chmodSync(join(source, "skills"), 0o555);
    chmodSync(skillDir, 0o555);
    chmodSync(join(skillDir, "SKILL.md"), 0o444);
    chownSync(join(source, "skills"), 0, 0);
    chownSync(skillDir, 0, 0);
    chownSync(join(skillDir, "SKILL.md"), 0, 0);
    writeFileSync(join(persistentProfile, "sentinel.txt"), "do not mutate\n");
    const destination = join(destinationParent, ".claude");
    symlinkSync(persistentProfile, destination);

    expect(materializeClaudeProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual([]);

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(existsSync(join(destination, "skills"))).toBe(false);
    expect(readFileSync(join(persistentProfile, "sentinel.txt"), "utf8")).toBe("do not mutate\n");
  });
});
