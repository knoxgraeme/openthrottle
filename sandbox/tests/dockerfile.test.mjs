import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("sandbox Dockerfile", () => {
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
});
