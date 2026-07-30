import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeClaudeProfileBaseline,
  materializeCodexProfileBaseline,
} from "./action-home-baseline.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("action home baseline materialization", () => {
  it("copies only non-secret Codex profile files into isolated homes", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-codex-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-codex-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "config.toml"), "model = \"test\"\n");
    writeFileSync(join(source, "AGENTS.md"), "repo instructions\n");
    writeFileSync(join(source, "auth.json"), "{\"token\":\"secret\"}\n");

    expect(materializeCodexProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual(["config.toml", "AGENTS.md"]);

    expect(readFileSync(join(destination, "config.toml"), "utf8")).toContain("model");
    expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toContain("repo instructions");
    expect(existsSync(join(destination, "auth.json"))).toBe(false);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
  });

  it("copies Claude skill discovery state without credential files", () => {
    const source = mkdtempSync(join(tmpdir(), "ot-claude-source-"));
    const destination = mkdtempSync(join(tmpdir(), "ot-claude-destination-"));
    directories.push(source, destination);
    writeFileSync(join(source, "credentials.json"), "{\"token\":\"secret\"}\n");
    writeFileSync(join(source, "settings.json"), "{}\n");
    const skillDir = join(source, "skills", "implement-unit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    symlinkSync(join(source, "credentials.json"), join(skillDir, "credential-link"));

    expect(materializeClaudeProfileBaseline({ sourceHome: source, destinationHome: destination }))
      .toEqual(["skills"]);

    expect(readFileSync(join(destination, "skills", "implement-unit", "SKILL.md"), "utf8")).toContain("skill");
    expect(existsSync(join(destination, "skills", "implement-unit", "credential-link"))).toBe(false);
    expect(existsSync(join(destination, "credentials.json"))).toBe(false);
    expect(existsSync(join(destination, "settings.json"))).toBe(false);
  });
});
