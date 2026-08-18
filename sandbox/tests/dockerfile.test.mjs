import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("sandbox Dockerfile", () => {
  it("pins the base image and verifies downloaded binaries", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");
    const supervisorDockerfile = readFileSync(resolve(repoRoot, "supervisor/Dockerfile"), "utf8");

    for (const source of [dockerfile, supervisorDockerfile]) {
      const baseImages = source.match(/^FROM\s+\S+/gm) ?? [];
      expect(baseImages.length).toBeGreaterThan(0);
      for (const baseImage of baseImages) {
        expect(baseImage).toMatch(/^FROM\s+[^@\s]+@sha256:[a-f0-9]{64}$/);
      }
    }

    const instructions = dockerfile.split(/\n(?=[A-Z][A-Z]+\s)/);
    const downloads = instructions.flatMap((instruction) =>
      [...instruction.matchAll(/curl -fsSL -o (\/usr\/local\/bin\/[^\s"]+)/g)].map(
        (match) => ({ instruction, destination: match[1] })
      )
    );
    expect(downloads.length).toBeGreaterThan(0);
    for (const { instruction, destination } of downloads) {
      expect(instruction).toContain(`${destination}" | sha256sum -c -`);
    }
    expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
  });

  it("installs Bats for local shell runtime gates", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");

    expect(dockerfile).toMatch(
      /apt-get install -y --no-install-recommends[\s\S]*?\bbats\b[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/,
    );
  });

  it("pins the Codex CLI release that supports the production model", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");

    expect(dockerfile).toContain("ARG CODEX_VERSION=0.144.0");
  });

  it("pre-creates every isolated review-action principal", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");
    const principals = [
      "ot-review-final",
      "ot-review-selector",
      "ot-review-correctness",
      "ot-review-tests",
      "ot-review-reliability",
      "ot-review-agent-native",
      "ot-review-security",
      "ot-review-data",
      "ot-review-performance",
      "ot-review-standards",
      "ot-review-validator",
    ];

    for (const principal of principals) expect(dockerfile).toContain(principal);
  });

  it("delivers automatic-admission packages through the canonical cross-engine skill tree", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY skills /opt/openthrottle/skills");
    expect(dockerfile).toContain("cp -r /opt/openthrottle/skills/tasks/. \"$baseline/claude/skills/\"");
    expect(dockerfile).toContain("cp -r /opt/openthrottle/skills/tasks/. /etc/codex/skills/");
    for (const name of ["admission-plan", "review-admission-plan"]) {
      expect(readFileSync(resolve(repoRoot, "skills/tasks", name, "SKILL.md"), "utf8"))
        .toContain(`name: ${name}`);
    }
  });
});
