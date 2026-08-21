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

  it("keeps Docker harness work requests aligned with the private v2 wire", () => {
    const sandboxHarnesses = [
      "sandbox/tests/smoke.sh",
      "sandbox/tests/structured-walking-skeleton.mjs",
    ];
    for (const path of sandboxHarnesses) {
      const harness = readFileSync(resolve(repoRoot, path), "utf8");
      const workRequests = [...harness.matchAll(
        /schema: "openthrottle\.kernel-action-request\/v2",[\s\S]*?executor_policy:/g,
      )];

      expect(workRequests.length, path).toBeGreaterThan(0);
      for (const request of workRequests) {
        expect(request[0], path).toContain("execution_limits:");
      }
    }

    for (const path of [
      ...sandboxHarnesses,
      "supervisor/scripts/kernel-sandbox-e2e.mjs",
    ]) {
      const harness = readFileSync(resolve(repoRoot, path), "utf8");
      expect(harness, path).toContain("OT_LEASE_GENERATION_FENCE_FILE=");
      expect(harness, path).toContain("OT_LEASE_GENERATION_LOCK_FILE=");
      expect(harness, path).toContain("openthrottle.kernel-lease-generation-fence/v1");
    }
  });
});
