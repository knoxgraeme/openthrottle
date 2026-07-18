import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectPackageManager, detectProject, writeProjectConfig } from "./init.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-cli-test-"));
  directories.push(directory);
  return directory;
}

describe("init project detection", () => {
  it("prefers packageManager metadata, then lockfiles", () => {
    const directory = temporaryProject();
    writeFileSync(join(directory, "yarn.lock"), "");
    expect(detectPackageManager({ packageManager: "pnpm@9" }, directory)).toBe("pnpm");
    expect(detectPackageManager({}, directory)).toBe("yarn");
  });

  it("detects scripts and omits base_branch from generated config", () => {
    const directory = temporaryProject();
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "tsc", dev: "vite" } })
    );
    expect(detectProject(directory)).toMatchObject({
      pm: "npm",
      test: "npm run test",
      build: "npm run build",
      lint: "",
      dev: "npm run dev -- --port 3000 --hostname 0.0.0.0",
    });
    writeProjectConfig(
      {
        agent: "claude",
        test: "npm test",
        build: "",
        lint: "",
        dev: "",
        post_bootstrap: ["npm install"],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      directory
    );
    const contents = readFileSync(join(directory, ".openthrottle.yml"), "utf8");
    expect(parse(contents)).toMatchObject({ agent: "claude", test: "npm test" });
    expect(contents).not.toContain("base_branch");
    expect(contents).not.toContain("build:");
  });
});
