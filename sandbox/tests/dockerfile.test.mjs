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
});
