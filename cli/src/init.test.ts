import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGraphContract, validateRepositoryConfigContract } from "@openthrottle/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  detectPackageManager,
  detectProject,
  detectRepository,
  editableSkillsRefreshSummary,
  getSupervisorTaskTimeoutSeconds,
  initOutro,
  parseGithubRemote,
  planEditableSkillsRefresh,
  promptConfig,
  registerTargetRepository,
  registrationSummary,
  writeProjectConfig,
  type ProjectConfig,
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

function completeProjectConfig(): ProjectConfig {
  return {
    agent: "codex",
    commands: {
      test: "npm test",
      lint: "npm run lint",
      build: "npm run build",
    },
    test: "npm test",
    lint: "npm run lint",
    build: "npm run build",
    post_bootstrap: ["npm install"],
    limits: { max_turns: 200, task_timeout: 7200 },
    mcp_servers: {},
  };
}

function initPromptHarness(controlProvider: "linear" | "github") {
  type PromptApi = NonNullable<Parameters<typeof promptConfig>[2]>;
  const calls: Array<{
    message: string;
    initialValue?: unknown;
    values?: unknown[];
  }> = [];
  const textValues: Record<string, string> = {
    "Linear team key routed to this repository": "eng",
    "Linear team ID (optional, but recommended)": "team-1",
  };
  const prompts = {
    async group(
      promptGroup: Record<string, (input: { results: Record<string, unknown> }) => unknown>
    ) {
      const results: Record<string, unknown> = {};
      for (const [key, prompt] of Object.entries(promptGroup)) {
        results[key] = await prompt({ results });
      }
      return results;
    },
    async select(options: {
      message: string;
      initialValue?: unknown;
      options: Array<{ value: unknown }>;
    }) {
      calls.push({
        message: options.message,
        initialValue: options.initialValue,
        values: options.options.map(({ value }) => value),
      });
      if (options.message === "Control provider") {
        return controlProvider === "linear" ? options.initialValue : "github";
      }
      if (options.message === "Default agent") return "codex";
      throw new Error(`Unexpected select prompt: ${options.message}`);
    },
    async text(options: { message: string; initialValue?: string }) {
      calls.push({ message: options.message, initialValue: options.initialValue });
      return textValues[options.message] ?? options.initialValue ?? "";
    },
  } as unknown as PromptApi;
  return { calls, prompts };
}

function mutableEditableResources(): { root: string; graphPath: string; skillDirectory: string } {
  const root = temporaryProject();
  const graphPath = join(root, "simple-v1.json");
  const skillDirectory = join(root, "implement-plan");
  mkdirSync(skillDirectory, { recursive: true });
  cpSync(resolve(process.cwd(), "../supervisor/graphs/simple-v1.json"), graphPath);
  cpSync(resolve(process.cwd(), "../skills/tasks/implement-plan"), skillDirectory, { recursive: true });
  return { root, graphPath, skillDirectory };
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
    });
    writeProjectConfig(
      {
        agent: "claude",
        test: "npm test",
        build: "",
        lint: "",
        post_bootstrap: ["npm install"],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      directory
    );
    const contents = readFileSync(join(directory, ".openthrottle.yml"), "utf8");
    expect(parse(contents)).toMatchObject({
      schema: "openthrottle.config/v1",
      default_graph: "simple",
      graphs: [
        { id: "simple", kind: "builtin", ref: "core/simple@1" },
        { id: "structured", kind: "builtin", ref: "core/structured@3" },
      ],
      agent: "claude",
      commands: { test: "npm test" },
      test: "npm test",
      intents: {
        implement: { default_graph: "simple", allowed_graphs: ["simple", "structured"] },
        investigate: { default_graph: "simple", allowed_graphs: ["simple"] },
      },
    });
    expect(contents).not.toContain("base_branch");
    expect(contents).not.toContain("build:");
  });

  it("writes sandbox command aliases from explicit canonical commands", () => {
    const directory = temporaryProject();
    writeProjectConfig(
      {
        agent: "codex",
        commands: { test: "npm test" },
        test: "",
        build: "",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      directory
    );

    expect(parse(readFileSync(join(directory, ".openthrottle.yml"), "utf8"))).toMatchObject({
      commands: { test: "npm test" },
      test: "npm test",
    });
  });

  it("synthesizes canonical commands from generated config aliases", () => {
    const directory = temporaryProject();
    writeProjectConfig(
      {
        agent: "codex",
        commands: { test: "npm test" },
        test: "",
        build: "npm run build",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      directory
    );

    expect(parse(readFileSync(join(directory, ".openthrottle.yml"), "utf8"))).toMatchObject({
      commands: { test: "npm test", build: "npm run build" },
      test: "npm test",
      build: "npm run build",
    });
  });

  it("rejects generated config command alias mismatches", () => {
    const directory = temporaryProject();
    expect(() => writeProjectConfig(
      {
        agent: "codex",
        commands: { test: "npm test" },
        test: "npm run different",
        build: "",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      directory
    )).toThrow(/test must match commands\.test/);
  });

  it("writes the model for any agent when set and omits it when blank", () => {
    const codexDir = temporaryProject();
    writeProjectConfig(
      {
        agent: "codex",
        model: "gpt-5-codex",
        test: "",
        build: "",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      codexDir
    );
    expect(parse(readFileSync(join(codexDir, ".openthrottle.yml"), "utf8"))).toMatchObject({
      agent: "codex",
      model: "gpt-5-codex",
    });

    const opencodeDir = temporaryProject();
    writeProjectConfig(
      {
        agent: "opencode",
        model: "kimi-code/kimi-for-coding",
        test: "",
        build: "",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      opencodeDir
    );
    expect(parse(readFileSync(join(opencodeDir, ".openthrottle.yml"), "utf8"))).toMatchObject({
      agent: "opencode",
      model: "kimi-code/kimi-for-coding",
    });

    const claudeDir = temporaryProject();
    writeProjectConfig(
      {
        agent: "claude",
        test: "",
        build: "",
        lint: "",
        post_bootstrap: [],
        limits: { max_turns: 20, task_timeout: 60 },
        mcp_servers: {},
      },
      claudeDir
    );
    expect(readFileSync(join(claudeDir, ".openthrottle.yml"), "utf8")).not.toContain("model:");
  });

  it("supports non-Node repositories with blank detected commands", () => {
    expect(detectProject(temporaryProject())).toEqual({
      pm: null,
      test: "",
      build: "",
      lint: "",
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

  it("summarizes the auto-detected registration for the confirmation prompt", () => {
    expect(
      registrationSummary({
        repo: "acme/widget",
        baseBranch: "develop",
        controlProvider: "linear",
        linearTeamKey: "ENG",
      })
    ).toBe("Linear team ENG → acme/widget (base branch develop)");
    expect(registrationSummary({
      repo: "acme/widget",
      controlProvider: "linear",
      linearTeamKey: "ENG",
    })).toBe(
      "Linear team ENG → acme/widget (GitHub default branch)"
    );
    expect(
      registrationSummary({
        repo: "acme/widget",
        controlProvider: "linear",
        linearTeamKey: "ENG",
      }, "https://ot.test")
    ).toBe("Linear team ENG → acme/widget (GitHub default branch) on https://ot.test");
    expect(registrationSummary({
      repo: "acme/widget",
      baseBranch: "develop",
      controlProvider: "github",
    })).toBe("GitHub Issues → acme/widget (base branch develop)");

    expect(initOutro({
      repo: "acme/widget",
      controlProvider: "linear",
      linearTeamKey: "ENG",
    }, false)).toBe(
      "Commit .openthrottle.yml, then delegate an issue from the configured Linear team."
    );
    expect(initOutro({
      repo: "acme/widget",
      controlProvider: "github",
    }, true)).toBe(
      "Commit .openthrottle.yml and .openthrottle/, then open or label a GitHub issue with `openthrottle`."
    );
  });

  it("defaults to Linear control and only prompts Linear registrations for a team", async () => {
    const linear = initPromptHarness("linear");
    await expect(promptConfig(
      { pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" },
      { repo: "acme/widget", baseBranch: "develop" },
      linear.prompts
    )).resolves.toMatchObject({
      registration: {
        repo: "acme/widget",
        baseBranch: "develop",
        controlProvider: "linear",
        linearTeamKey: "ENG",
        linearTeamId: "team-1",
      },
    });
    expect(linear.calls.find(({ message }) => message === "Control provider")).toEqual({
      message: "Control provider",
      initialValue: "linear",
      values: ["linear", "github"],
    });
    expect(linear.calls.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "Linear team key routed to this repository",
      "Linear team ID (optional, but recommended)",
    ]));

    const github = initPromptHarness("github");
    await expect(promptConfig(
      { pm: null, test: "", build: "", lint: "" },
      { repo: "acme/widget" },
      github.prompts
    )).resolves.toMatchObject({
      registration: {
        repo: "acme/widget",
        controlProvider: "github",
      },
    });
    expect(github.calls.map(({ message }) => message)).not.toEqual(expect.arrayContaining([
      "Linear team key routed to this repository",
      "Linear team ID (optional, but recommended)",
    ]));
  });

  it("registers a repository through the authenticated supervisor request helper", async () => {
    const request = async (path: string, init?: RequestInit) => {
      expect(path).toBe("/repositories/register");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "acme/widget",
        baseBranch: "develop",
        controlProvider: "linear",
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
          controlProvider: "linear",
          linearTeamKey: "ENG",
          linearTeamId: "team-1",
        },
        request
      )
    ).resolves.toMatchObject({ registration: { github_repo: "acme/widget" } });
  });

  it("registers GitHub control without Linear team fields", async () => {
    const request = async (_path: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        repo: "acme/widget",
        controlProvider: "github",
      });
      return Response.json({
        registration: { github_repo: "acme/widget", base_branch: "main" },
        readiness: {
          webhook: "created",
          snapshot: { name: "openthrottle", state: "active" },
        },
      });
    };
    await expect(registerTargetRepository({
      repo: "acme/widget",
      controlProvider: "github",
    }, request)).resolves.toMatchObject({ registration: { github_repo: "acme/widget" } });
  });

  it("scaffolds the exact editable simple-pipeline package under .openthrottle", () => {
    const directory = temporaryProject();
    writeProjectConfig(completeProjectConfig(), directory, { editableSkills: true });

    const configRaw = readFileSync(join(directory, ".openthrottle.yml"), "utf8");
    const config = validateRepositoryConfigContract(parse(configRaw), { source: ".openthrottle.yml" });
    expect(config.value).toMatchObject({
      default_graph: "simple_editable",
      graphs: expect.arrayContaining([
        { id: "simple_editable", kind: "repository", ref: ".openthrottle/graphs/simple.json" },
      ]),
      skills: [{ id: "implement-plan", path: ".openthrottle/skills/implement-plan" }],
      intents: {
        implement: {
          default_graph: "simple_editable",
          allowed_graphs: ["simple_editable", "simple", "structured"],
        },
      },
    });

    const graphRaw = readFileSync(join(directory, ".openthrottle/graphs/simple.json"), "utf8");
    const graph = parseGraphContract(graphRaw, {
      source: ".openthrottle/graphs/simple.json",
      config: config.value,
    }).value;
    expect(graph.loops.find((loop) => loop.id === "implementation-loop")?.skill).toBe("repo://implement-plan");
    expect(graph.loops.find((loop) => loop.id === "repair-implementation-loop")?.skill).toBe("repo://implement-plan");
    expect(graph.loops.find((loop) => loop.id === "review-loop")?.skill).toBe("builtin://ce/review@1");

    const generatedSkill = readFileSync(
      join(directory, ".openthrottle/skills/implement-plan/SKILL.md"),
      "utf8"
    );
    expect(generatedSkill).toBe(readFileSync(resolve(process.cwd(), "../skills/tasks/implement-plan/SKILL.md"), "utf8"));
    expect(readFileSync(
      join(directory, ".openthrottle/skills/implement-plan/agents/openai.yaml"),
      "utf8"
    )).toBe(readFileSync(resolve(process.cwd(), "../skills/tasks/implement-plan/agents/openai.yaml"), "utf8"));
    expect(() => readFileSync(join(directory, ".agents/skills/implement-plan/SKILL.md"), "utf8")).toThrow();

    const lock = JSON.parse(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8"));
    expect(lock).toMatchObject({
      schema: "openthrottle.skills.lock/v1",
      upstream_graph: { ref: "core/simple@1" },
      upstream_files: [{ path: "SKILL.md" }, { path: "agents/openai.yaml" }],
    });
    expect(lock).toHaveProperty("upstream_package_digest");
    expect(lock).toHaveProperty("scaffold_package_digest");
    expect(lock.integrity_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(planEditableSkillsRefresh(completeProjectConfig(), directory)).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "unchanged" }),
      ]),
    });
  });

  it("copies and pins the complete bounded source package closure", () => {
    const directory = temporaryProject();
    const resources = mutableEditableResources();
    mkdirSync(join(resources.skillDirectory, "references"), { recursive: true });
    writeFileSync(join(resources.skillDirectory, "references/helper.md"), "# Helper\n");

    writeProjectConfig(completeProjectConfig(), directory, {
      editableSkills: true,
      resources: { ...resources, release: "closure-test" },
    });

    expect(readFileSync(
      join(directory, ".openthrottle/skills/implement-plan/references/helper.md"),
      "utf8"
    )).toBe("# Helper\n");
    const lock = JSON.parse(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8"));
    expect(lock.upstream_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "references/helper.md" }),
    ]));
  });

  it("rejects source package symlinks and production admission bound overflows", () => {
    const config = completeProjectConfig();

    const symlinkDirectory = temporaryProject();
    const symlinkResources = mutableEditableResources();
    symlinkSync(
      join(symlinkResources.skillDirectory, "SKILL.md"),
      join(symlinkResources.skillDirectory, "linked.md")
    );
    expect(() => writeProjectConfig(config, symlinkDirectory, {
      editableSkills: true,
      resources: { ...symlinkResources, release: "symlink-test" },
    })).toThrow(/source must not contain symlinks/);

    const countDirectory = temporaryProject();
    const countResources = mutableEditableResources();
    mkdirSync(join(countResources.skillDirectory, "references"));
    for (let index = 0; index < 63; index += 1) {
      writeFileSync(join(countResources.skillDirectory, `references/${index}.md`), "x");
    }
    expect(() => writeProjectConfig(config, countDirectory, {
      editableSkills: true,
      resources: { ...countResources, release: "count-test" },
    })).toThrow(/64 file limit/);

    const bytesDirectory = temporaryProject();
    const bytesResources = mutableEditableResources();
    writeFileSync(
      join(bytesResources.skillDirectory, "SKILL.md"),
      `---\nname: implement-plan\n---\n${"x".repeat(256 * 1024)}`
    );
    expect(() => writeProjectConfig(config, bytesDirectory, {
      editableSkills: true,
      resources: { ...bytesResources, release: "bytes-test" },
    })).toThrow(/256 KiB snapshot limit/);
  });

  it("uses the authenticated supervisor task-timeout capability in generated loops", () => {
    const directory = temporaryProject();
    writeProjectConfig(completeProjectConfig(), directory, {
      editableSkills: true,
      supervisorTaskTimeoutSeconds: 3600,
    });
    const graph = JSON.parse(readFileSync(join(directory, ".openthrottle/graphs/simple.json"), "utf8"));
    expect(graph.loops.every((loop: { timeout_seconds: number }) => loop.timeout_seconds === 3600)).toBe(true);

    const longDirectory = temporaryProject();
    const longConfig = completeProjectConfig();
    longConfig.limits.task_timeout = 10_000;
    writeProjectConfig(longConfig, longDirectory, {
      editableSkills: true,
      supervisorTaskTimeoutSeconds: 12_000,
    });
    const longGraph = JSON.parse(readFileSync(
      join(longDirectory, ".openthrottle/graphs/simple.json"),
      "utf8"
    ));
    expect(longGraph.loops.every((loop: { timeout_seconds: number }) => (
      loop.timeout_seconds === 10_000
    ))).toBe(true);
  });

  it("refuses local-only generated-file edits before writing any candidate", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    writeProjectConfig(config, directory, { editableSkills: true });
    const graphBefore = readFileSync(join(directory, ".openthrottle/graphs/simple.json"), "utf8");
    const lockBefore = readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8");
    const skillPath = join(directory, ".openthrottle/skills/implement-plan/SKILL.md");
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nUser-owned edit.\n`);

    expect(planEditableSkillsRefresh(config, directory)).toMatchObject({
      writable: false,
      entries: expect.arrayContaining([expect.objectContaining({
        path: ".openthrottle/skills/implement-plan/SKILL.md",
        status: "local-only",
      })]),
    });
    expect(() => writeProjectConfig(config, directory, { editableSkills: true })).toThrow(/local-only/);
    expect(readFileSync(join(directory, ".openthrottle/graphs/simple.json"), "utf8")).toBe(graphBefore);
    expect(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8")).toBe(lockBefore);
    expect(readFileSync(skillPath, "utf8")).toContain("User-owned edit");
  });

  it("refuses undeclared files in the repository package closure", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    writeProjectConfig(config, directory, { editableSkills: true });
    const extraPath = join(directory, ".openthrottle/skills/implement-plan/undeclared.md");
    writeFileSync(extraPath, "not in the generated package closure\n");

    expect(planEditableSkillsRefresh(config, directory)).toMatchObject({
      writable: false,
      entries: expect.arrayContaining([expect.objectContaining({
        path: ".openthrottle/skills/implement-plan/undeclared.md",
        status: "local-only",
        upstream_digest: null,
      })]),
    });
    expect(() => writeProjectConfig(config, directory, { editableSkills: true }))
      .toThrow(/undeclared\.md \(local-only\)/);
    expect(readFileSync(extraPath, "utf8")).toContain("not in the generated package closure");
  });

  it("fails closed when a scaffold path is a symlink", () => {
    const directory = temporaryProject();
    const outside = temporaryProject();
    symlinkSync(outside, join(directory, ".openthrottle"));

    expect(() => writeProjectConfig(completeProjectConfig(), directory, { editableSkills: true }))
      .toThrow(/must not contain symlinks/);
    expect(() => readFileSync(join(outside, "skills.lock.json"), "utf8")).toThrow();
  });

  it("recognizes a genuine old-to-new upstream graph and package as upstream-only", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    const resourceOptions = {
      graphPath: resources.graphPath,
      skillDirectory: resources.skillDirectory,
      release: "test-release",
    };
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const oldLock = JSON.parse(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8"));

    const upstreamSkillPath = join(resources.skillDirectory, "SKILL.md");
    writeFileSync(upstreamSkillPath, `${readFileSync(upstreamSkillPath, "utf8")}\nUpstream release improvement.\n`);
    const upstreamGraph = JSON.parse(readFileSync(resources.graphPath, "utf8"));
    upstreamGraph.loops.find((loop: { id: string }) => loop.id === "implementation-loop").max_rounds += 1;
    writeFileSync(resources.graphPath, `${JSON.stringify(upstreamGraph, null, 2)}\n`);

    const plan = planEditableSkillsRefresh(config, directory, { resources: resourceOptions });
    expect(plan).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle/graphs/simple.json", status: "upstream-only" }),
        expect.objectContaining({
          path: ".openthrottle/skills/implement-plan/SKILL.md",
          status: "upstream-only",
        }),
        expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "upstream-only" }),
      ]),
    });

    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const newLock = JSON.parse(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8"));
    expect(newLock.upstream_package_digest).not.toBe(oldLock.upstream_package_digest);
    expect(newLock.scaffold_package_digest).not.toBe(oldLock.scaffold_package_digest);
    expect(newLock.upstream_graph.digest).not.toBe(oldLock.upstream_graph.digest);
    expect(newLock.upstream_graph.scaffold_digest).not.toBe(oldLock.upstream_graph.scaffold_digest);
    expect(newLock.upstream_files.find((entry: { path: string }) => entry.path === "SKILL.md").digest)
      .not.toBe(oldLock.upstream_files.find((entry: { path: string }) => entry.path === "SKILL.md").digest);
    expect(newLock.files.find((entry: { path: string }) => entry.path.endsWith("/SKILL.md")).digest)
      .not.toBe(oldLock.files.find((entry: { path: string }) => entry.path.endsWith("/SKILL.md")).digest);
  });

  it("removes an unchanged provenance-owned file when the upstream package removes it", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    mkdirSync(join(resources.skillDirectory, "references"));
    writeFileSync(join(resources.skillDirectory, "references/retired.md"), "retire me\n");
    const resourceOptions = { ...resources, release: "removal-test" };
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    rmSync(join(resources.skillDirectory, "references/retired.md"));

    expect(planEditableSkillsRefresh(config, directory, { resources: resourceOptions })).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([expect.objectContaining({
        path: ".openthrottle/skills/implement-plan/references/retired.md",
        status: "upstream-only",
        upstream_digest: null,
      })]),
    });
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    expect(() => readFileSync(
      join(directory, ".openthrottle/skills/implement-plan/references/retired.md"),
      "utf8"
    )).toThrow();
  });

  it("refreshes release-only provenance when packaged assets are byte-identical", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    const baseResources = {
      graphPath: resources.graphPath,
      skillDirectory: resources.skillDirectory,
    };
    writeProjectConfig(config, directory, {
      editableSkills: true,
      resources: { ...baseResources, release: "2.0.0-alpha.2" },
    });

    const plan = planEditableSkillsRefresh(config, directory, {
      resources: { ...baseResources, release: "2.0.0-alpha.3" },
    });
    expect(plan).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "upstream-only" }),
      ]),
    });
    writeProjectConfig(config, directory, {
      editableSkills: true,
      resources: { ...baseResources, release: "2.0.0-alpha.3" },
    });
    expect(JSON.parse(readFileSync(join(directory, ".openthrottle/skills.lock.json"), "utf8")))
      .toMatchObject({ openthrottle_release: "2.0.0-alpha.3" });
  });

  it("refreshes source-graph provenance when formatting leaves scaffold bytes unchanged", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    const resourceOptions = { ...resources, release: "format-only-test" };
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const lockPath = join(directory, ".openthrottle/skills.lock.json");
    const oldLock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(resources.graphPath, `${readFileSync(resources.graphPath, "utf8")}\n`);

    expect(planEditableSkillsRefresh(config, directory, { resources: resourceOptions })).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle/graphs/simple.json", status: "unchanged" }),
        expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "upstream-only" }),
      ]),
    });
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const newLock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(newLock.upstream_graph.digest).not.toBe(oldLock.upstream_graph.digest);
    expect(newLock.upstream_graph.scaffold_digest).toBe(oldLock.upstream_graph.scaffold_digest);
  });

  it("fails closed on stale lock digests and unbound local release edits", () => {
    for (const mutate of [
      (lock: Record<string, any>) => { lock.upstream_package_digest = "not-a-digest"; },
      (lock: Record<string, any>) => { lock.files[0].digest = "0".repeat(64); },
      (lock: Record<string, any>) => { lock.upstream_graph.scaffold_digest = "1".repeat(64); },
      (lock: Record<string, any>) => { lock.openthrottle_release = "local-release-edit"; },
    ]) {
      const directory = temporaryProject();
      const config = completeProjectConfig();
      const resources = mutableEditableResources();
      const resourceOptions = { ...resources, release: "integrity-test" };
      writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
      const lockPath = join(directory, ".openthrottle/skills.lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      mutate(lock);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

      expect(planEditableSkillsRefresh(config, directory, { resources: resourceOptions })).toMatchObject({
        writable: false,
        entries: expect.arrayContaining([
          expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "local-only" }),
        ]),
      });
    }
  });

  it("rejects semantic provenance edits even while an upstream package changes", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    const resourceOptions = {
      graphPath: resources.graphPath,
      skillDirectory: resources.skillDirectory,
      release: "test-release",
    };
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const lockPath = join(directory, ".openthrottle/skills.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.upstream_graph.ref = "core/structured@2";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const upstreamSkillPath = join(resources.skillDirectory, "SKILL.md");
    writeFileSync(upstreamSkillPath, `${readFileSync(upstreamSkillPath, "utf8")}\nNew upstream bytes.\n`);

    expect(planEditableSkillsRefresh(config, directory, { resources: resourceOptions })).toMatchObject({
      writable: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle/skills.lock.json", status: "conflict" }),
      ]),
    });
    expect(() => writeProjectConfig(config, directory, {
      editableSkills: true,
      resources: resourceOptions,
    })).toThrow(/skills\.lock\.json \(conflict\)/);
  });

  it("classifies simultaneous local and upstream package edits as a conflict", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    const resources = mutableEditableResources();
    const resourceOptions = {
      graphPath: resources.graphPath,
      skillDirectory: resources.skillDirectory,
      release: "test-release",
    };
    writeProjectConfig(config, directory, { editableSkills: true, resources: resourceOptions });
    const localSkillPath = join(directory, ".openthrottle/skills/implement-plan/SKILL.md");
    writeFileSync(localSkillPath, `${readFileSync(localSkillPath, "utf8")}\nLocal edit.\n`);
    const upstreamSkillPath = join(resources.skillDirectory, "SKILL.md");
    writeFileSync(upstreamSkillPath, `${readFileSync(upstreamSkillPath, "utf8")}\nUpstream edit.\n`);

    expect(planEditableSkillsRefresh(config, directory, { resources: resourceOptions })).toMatchObject({
      writable: false,
      entries: expect.arrayContaining([expect.objectContaining({
        path: ".openthrottle/skills/implement-plan/SKILL.md",
        status: "conflict",
      })]),
    });
  });

  it("requires every command executed by the editable simple graph", () => {
    const directory = temporaryProject();
    const config = completeProjectConfig();
    config.commands = { test: "npm test", build: "npm run build" };
    config.lint = "";
    expect(() => writeProjectConfig(config, directory, { editableSkills: true }))
      .toThrow(/requires a lint command/);
    expect(() => readFileSync(join(directory, ".openthrottle.yml"), "utf8")).toThrow();
  });

  it("reads the supervisor timeout capability and formats a read-only refresh plan", async () => {
    await expect(getSupervisorTaskTimeoutSeconds(async (path) => {
      expect(path).toBe("/capabilities");
      return Response.json({ limits: { taskTimeoutSeconds: 3600 } });
    })).resolves.toBe(3600);
    await expect(getSupervisorTaskTimeoutSeconds(async () => (
      Response.json({ limits: { taskTimeoutSeconds: 100_000 } })
    ))).resolves.toBe(100_000);
    await expect(getSupervisorTaskTimeoutSeconds(async () => (
      Response.json({ limits: { taskTimeoutSeconds: "3600" } })
    ))).rejects.toThrow(/invalid task timeout capability/);

    expect(editableSkillsRefreshSummary({
      writable: false,
      entries: [{
        path: ".openthrottle/skills.lock.json",
        status: "conflict",
        provenance_digest: null,
        local_digest: "a".repeat(64),
        upstream_digest: "b".repeat(64),
      }],
    })).toEqual(["conflict      .openthrottle/skills.lock.json"]);
  });
});
