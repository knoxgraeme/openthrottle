import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, digest } from "./kernel-json.mjs";
import {
  compileActionProfile,
  materializeActionProfile,
} from "./action-profile.mjs";

const directories = [];

function makeTreeWritable(directory) {
  if (!existsSync(directory)) return;
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory()) {
    chmodSync(directory, metadata.mode | 0o600);
    return;
  }
  chmodSync(directory, metadata.mode | 0o700);
  for (const entry of readdirSync(directory)) makeTreeWritable(join(directory, entry));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      makeTreeWritable(directory);
    } catch {
      // A failed assertion may run after the test already removed the tree.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function skillEntry(id, name, body, files = []) {
  const normalized_payload = {
    frontmatter: { name, description: `${name} procedure` },
    instructions: body,
    files: files.map(({ path, content }) => ({ path, content, content_hash: digest(content) })),
  };
  return {
    definition_kind: "skill",
    definition_id: id,
    content_hash: digest(canonicalJson(normalized_payload)),
    normalized_payload,
  };
}

describe("sealed action profiles", () => {
  it("layers one role, task, and catalog without disclosing unactivated bodies or references", () => {
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-action-profile-"));
    directories.push(profileRoot);
    const primary = skillEntry(
      "core/review-change",
      "review-change",
      "PRIMARY BODY: read references/checklist.md only when needed.",
      [
        { path: "references/checklist.md", content: "LAZY PRIMARY REFERENCE\n" },
        { path: "scripts/check.sh", content: "#!/bin/sh\nexit 0\n" },
      ],
    );
    const secondary = skillEntry("core/security", "security", "SECONDARY BODY");
    const profile = compileActionProfile({
      engine: "codex",
      agentId: "core/reviewer",
      repositoryAuthority: "inspect",
      skillIds: ["core/review-change", "core/security"],
      entrySkill: "core/review-change",
      taskPrompt: "Inspect exact subject abc123.",
      platformFence: "PLATFORM FENCE",
      definitionEntries: [
        {
          definition_kind: "agent",
          definition_id: "core/reviewer",
          content_hash: digest(canonicalJson("ROLE INSTRUCTIONS")),
          normalized_payload: "ROLE INSTRUCTIONS",
        },
        primary,
        secondary,
      ],
    });
    const materialized = materializeActionProfile({ profile, profileRoot });

    expect(materialized.prompt).toContain("$review-change");
    expect(materialized.prompt).toContain("PLATFORM FENCE");
    expect(materialized.prompt).toContain("ROLE INSTRUCTIONS");
    expect(materialized.prompt).toContain("Inspect exact subject abc123.");
    expect(materialized.prompt).not.toContain("PRIMARY BODY");
    expect(materialized.prompt).not.toContain("SECONDARY BODY");
    expect(materialized.prompt).not.toContain("LAZY PRIMARY REFERENCE");
    expect(readFileSync(join(profileRoot, "skills", "review-change", "SKILL.md"), "utf8")).toContain("PRIMARY BODY");
    expect(readFileSync(join(profileRoot, "skills", "review-change", "references", "checklist.md"), "utf8"))
      .toBe("LAZY PRIMARY REFERENCE\n");
    expect(statSync(join(profileRoot, "skills", "review-change", "references", "checklist.md")).mode & 0o777)
      .toBe(0o444);
    expect(statSync(join(profileRoot, "skills", "review-change", "scripts", "check.sh")).mode & 0o777)
      .toBe(0o555);
    expect(existsSync(join(profileRoot, "skills", "security", "SKILL.md"))).toBe(true);
    expect(readFileSync(materialized.manifestPath, "utf8")).not.toContain("PRIMARY BODY");
  });

  it("rejects an entry skill outside the allowlist and keeps engine separate from agent identity", () => {
    expect(() => compileActionProfile({
      engine: "claude",
      agentId: "core/reviewer",
      repositoryAuthority: "inspect",
      skillIds: ["core/review-change"],
      entrySkill: "core/security",
      taskPrompt: "Review.",
      platformFence: "Fence.",
      definitionEntries: [],
    })).toThrow("entrySkill must be present in the skill allowlist");
  });
});
