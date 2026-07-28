import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("repository npm project layout", () => {
  it("keeps the repo split into the four explicit npm projects with no root package", () => {
    const packageProjects = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(path.join(repoRoot, name, "package.json")))
      .sort();

    expect(existsSync(path.join(repoRoot, "package.json"))).toBe(false);
    expect(packageProjects).toEqual(["cli", "contracts", "sandbox", "supervisor"]);
  });
});
