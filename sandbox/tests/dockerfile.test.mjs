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

  it("ships one kernel executor and one unprivileged agent principal", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");

    expect(dockerfile).toContain("useradd --create-home --home-dir /home/agent");
    expect(dockerfile).not.toContain("ot-review-");
    expect(dockerfile).toContain("COPY sandbox/runner /opt/openthrottle/runner");
    expect(dockerfile).toContain("COPY sandbox/bin/ot-result.mjs /opt/openthrottle/bin/ot-result.mjs");
    expect(dockerfile).not.toContain("ot-stage-result");
    expect(dockerfile).not.toContain("ot-subject-post");
    expect(dockerfile).not.toContain("runtime-capabilities.json");
  });

  it("bakes only the platform fence and installs skills per sealed attempt", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "sandbox/Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      "COPY skills/codex/AGENTS-fragment.md /opt/openthrottle/skills/codex/AGENTS-fragment.md",
    );
    expect(dockerfile).not.toContain("COPY skills /opt/openthrottle/skills");
    expect(dockerfile).not.toContain("/etc/codex/skills");
    expect(dockerfile).not.toContain("skills/tasks/.");
    expect(dockerfile).toContain("only its DefinitionBundle allowlist");
  });
});
