import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  detectPackageManager,
  detectProject,
  initOutro,
  localSkillInstallSummary,
  parseGithubRemote,
  parseInitArgs,
  preflightSupervisor,
  projectConfigDocument,
  promptConfig,
  registerTargetRepository,
  registrationSummary,
  renderProjectConfig,
  writeProjectConfig,
  type LocalSkillInstallResult,
  type ProjectConfig,
} from "./init.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-init-test-"));
  directories.push(directory);
  return directory;
}

function completeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    engine: "codex",
    commands: {
      test: "npm test",
      lint: "npm run lint",
      build: "npm run build",
    },
    post_bootstrap: ["npm install"],
    limits: { max_turns: 200, task_timeout: 7_200 },
    ...overrides,
  };
}

function capabilityBody(): Record<string, unknown> {
  return {
    release: "openthrottle-snapshot/v1",
    capabilityDigest: "a".repeat(64),
    capabilities: ["definition-bundle/v1"],
    limits: { taskTimeoutSeconds: 7_200 },
  };
}

describe("project detection", () => {
  it("detects package managers and their configured scripts", () => {
    const directory = temporaryProject();
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { test: "vitest", lint: "eslint ." },
    }));

    expect(detectPackageManager({ packageManager: "yarn@4" }, directory)).toBe("yarn");
    expect(detectProject(directory)).toEqual({
      pm: "pnpm",
      test: "pnpm run test",
      build: "",
      lint: "pnpm run lint",
    });
  });

  it("parses supported GitHub remote forms and rejects other hosts", () => {
    expect(parseGithubRemote("https://github.com/acme/repo.git")).toBe("acme/repo");
    expect(parseGithubRemote("git@github.com:acme/repo.git")).toBe("acme/repo");
    expect(parseGithubRemote("ssh://git@github.com/acme/repo")).toBe("acme/repo");
    expect(() => parseGithubRemote("https://example.com/acme/repo")).toThrow(/GitHub/);
  });
});

describe("filesystem config scaffolding", () => {
  it("writes only the v2 definition config with the core implementation pipeline by default", () => {
    const directory = temporaryProject();
    writeProjectConfig(completeProjectConfig(), directory);

    const configPath = join(directory, ".openthrottle", "config.yml");
    const config = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      schema: "openthrottle.config/v2",
      pipeline: "core/implement",
      engine: "codex",
      commands: {
        build: "npm run build",
        lint: "npm run lint",
        test: "npm test",
      },
      post_bootstrap: ["npm install"],
      limits: { max_turns: 200, task_timeout: 7_200 },
    });
    expect(existsSync(join(directory, ".openthrottle.yml"))).toBe(false);
    expect(existsSync(join(directory, ".openthrottle", "skills.lock.json"))).toBe(false);
    for (const name of ["agents", "pipelines", "skills", "evals"]) {
      expect(existsSync(join(directory, ".openthrottle", name))).toBe(true);
    }
  });

  it("preserves engine, model, commands, bootstrap, and limits", () => {
    const document = projectConfigDocument(completeProjectConfig({
      pipeline: "repo/custom",
      engine: "claude",
      model: "claude-test",
      reasoning_effort: "high",
      post_bootstrap: ["pnpm install", "pnpm db:prepare"],
      limits: { max_turns: 40, task_timeout: 900 },
    }));

    expect(document).toMatchObject({
      schema: "openthrottle.config/v2",
      pipeline: "repo/custom",
      engine: "claude",
      model: "claude-test",
      reasoning_effort: "high",
      post_bootstrap: ["pnpm install", "pnpm db:prepare"],
      limits: { max_turns: 40, task_timeout: 900 },
    });
    expect(renderProjectConfig(completeProjectConfig())).not.toMatch(/\bagent:/);
    expect(renderProjectConfig(completeProjectConfig())).not.toMatch(/default_graph|graphs:|skills\.lock/);
  });

  it("fails closed on overwrite and filesystem indirection", () => {
    const directory = temporaryProject();
    writeProjectConfig(completeProjectConfig(), directory);
    expect(() => writeProjectConfig(completeProjectConfig(), directory)).toThrow(/already exists/);
    expect(() => writeProjectConfig(
      completeProjectConfig({ engine: "claude" }),
      directory,
      { allowConfigOverwrite: true },
    )).not.toThrow();

    const symlinkDirectory = temporaryProject();
    symlinkSync(directory, join(symlinkDirectory, ".openthrottle"));
    expect(() => writeProjectConfig(completeProjectConfig(), symlinkDirectory)).toThrow(/real directory/);
  });

  it("uses the strict shared config contract before writing", () => {
    expect(() => projectConfigDocument(completeProjectConfig({
      engine: "opencode",
      reasoning_effort: "high",
    }))).toThrow(/not supported/);
  });
});

describe("interactive selection", () => {
  it("returns pipeline and engine vocabulary without an agent or graph field", async () => {
    type PromptApi = NonNullable<Parameters<typeof promptConfig>[2]>;
    const prompts = {
      group: vi.fn(async () => ({
        controlProvider: "linear",
        linearTeamKey: "eng",
        linearTeamId: "team-1",
        baseBranch: "main",
        pipeline: "core/structured",
        engine: "codex",
        model: "gpt-test",
        test: "npm test",
        lint: "npm run lint",
        build: "npm run build",
        post_bootstrap: "npm install",
        max_turns: "100",
        task_timeout: "3600",
      })),
      select: vi.fn(),
      text: vi.fn(),
    } as unknown as PromptApi;

    const selection = await promptConfig(
      { pm: "npm", test: "npm test", lint: "npm run lint", build: "npm run build" },
      { repo: "acme/repo", baseBranch: "main" },
      prompts,
    );
    expect(selection.project).toMatchObject({
      pipeline: "core/structured",
      engine: "codex",
      model: "gpt-test",
    });
    expect(selection.project).not.toHaveProperty("agent");
    expect(selection.registration).toEqual({
      repo: "acme/repo",
      baseBranch: "main",
      controlProvider: "linear",
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
    });
  });
});

describe("supervisor registration and preflight", () => {
  it("registers the exact repository/control route", async () => {
    const request = vi.fn(async () => Response.json({
      registration: { github_repo: "acme/repo", base_branch: "main" },
      readiness: {
        github: "ready",
        webhook: "created",
        snapshot: { name: "openthrottle", state: "active" },
      },
    }));
    const input = {
      repo: "acme/repo",
      baseBranch: "main",
      controlProvider: "linear" as const,
      linearTeamKey: "ENG",
    };

    await expect(registerTargetRepository(input, request)).resolves.toMatchObject({
      registration: { github_repo: "acme/repo" },
    });
    expect(request).toHaveBeenCalledWith("/repositories/register", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
    }));
  });

  it("rejects error and malformed registration responses", async () => {
    await expect(registerTargetRepository(
      { repo: "acme/repo", controlProvider: "github" },
      vi.fn(async () => Response.json({ error: "no" }, { status: 400 })),
    )).rejects.toThrow("no");
    await expect(registerTargetRepository(
      { repo: "acme/repo", controlProvider: "github" },
      vi.fn(async () => Response.json({ registration: {} })),
    )).rejects.toThrow(/invalid/);
  });

  it("checks health and capabilities and distinguishes auth/config failures", async () => {
    const request = vi.fn(async (path: string) => path === "/healthz"
      ? Response.json({ ok: true })
      : Response.json(capabilityBody()));
    await expect(preflightSupervisor(request, {
      OT_SUPERVISOR_URL: "https://supervisor.test",
      OT_STATUS_TOKEN: "token",
    })).resolves.toEqual({ status: "ready" });
    expect(request).toHaveBeenCalledTimes(2);

    await expect(preflightSupervisor(request, {})).resolves.toMatchObject({ status: "not-configured" });
    await expect(preflightSupervisor(
      vi.fn(async () => new Response(null, { status: 401 })),
      { OT_SUPERVISOR_URL: "https://supervisor.test", OT_STATUS_TOKEN: "bad" },
    )).resolves.toMatchObject({ status: "authentication-failed" });
  });
});

describe("command text and arguments", () => {
  it("parses only current init options", () => {
    expect(parseInitArgs(["--profile", "prod", "--dry-run"]))
      .toEqual({ profile: "prod", dryRun: true });
    expect(() => parseInitArgs(["--profile"])).toThrow(/requires/);
    expect(() => parseInitArgs(["--editable-skills"])).toThrow(/Unknown init option/);
  });

  it("names only the filesystem config in summaries", () => {
    const registration = {
      repo: "acme/repo",
      controlProvider: "linear" as const,
      linearTeamKey: "ENG",
    };
    expect(registrationSummary(registration)).toContain("Linear team ENG → acme/repo");
    expect(initOutro(registration)).toContain("Commit .openthrottle/config.yml");
    expect(initOutro(registration)).not.toContain(".openthrottle.yml");
  });

  it("summarizes local skill installation independently from runtime definitions", () => {
    const installs = [{
      name: "openthrottle",
      result: {
        success: false,
        installed: [{ agent: "Codex", status: "installed", path: "/tmp/skill" }],
        skipped: [],
        unsupported: [],
        conflicted: [],
        recovery: ["openthrottle operator-skill install"],
      },
    }] as unknown as LocalSkillInstallResult[];
    expect(localSkillInstallSummary(installs)).toEqual([
      "openthrottle: installed for Codex at /tmp/skill",
      "openthrottle: recovery: openthrottle operator-skill install",
    ]);
  });
});
