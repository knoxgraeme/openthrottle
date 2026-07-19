import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  detectPackageManager,
  detectProject,
  detectRepository,
  parseGithubRemote,
  registerTargetRepository,
  writeProjectConfig,
} from "./init.js";

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

  it("supports non-Node repositories with blank detected commands", () => {
    expect(detectProject(temporaryProject())).toEqual({
      pm: null,
      test: "",
      build: "",
      lint: "",
      dev: "",
    });
  });

  it("detects GitHub remotes and the target base branch", () => {
    expect(parseGithubRemote("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRemote("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithubRemote("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(() => parseGithubRemote("https://gitlab.com/owner/repo.git")).toThrow(/GitHub/);

    const directory = temporaryProject();
    execFileSync("git", ["init", "-b", "develop"], { cwd: directory });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], {
      cwd: directory,
    });
    expect(detectRepository(directory)).toEqual({ repo: "acme/widget", baseBranch: "develop" });
  });

  it("registers a repository through the authenticated supervisor request helper", async () => {
    const request = async (path: string, init?: RequestInit) => {
      expect(path).toBe("/repositories/register");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "acme/widget",
        baseBranch: "develop",
        linearTeamKey: "ENG",
        linearTeamId: "team-1",
      });
      return Response.json({
        registration: { github_repo: "acme/widget", base_branch: "develop" },
        readiness: {
          webhook: "created",
          snapshot: { name: "openthrottle", state: "active" },
        },
      });
    };
    await expect(
      registerTargetRepository(
        {
          repo: "acme/widget",
          baseBranch: "develop",
          linearTeamKey: "ENG",
          linearTeamId: "team-1",
        },
        request
      )
    ).resolves.toMatchObject({ registration: { github_repo: "acme/widget" } });
  });
});
