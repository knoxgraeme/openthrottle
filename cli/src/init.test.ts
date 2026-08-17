import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import init, {
  detectPackageManager,
  detectProject,
  detectRepository,
  editableSkillsRefreshSummary,
  getSupervisorTaskTimeoutSeconds,
  installLocalSkills,
  initOutro,
  parseInitArgs,
  localSkillInstallSummary,
  parseGithubRemote,
  planEditableSkillsDryRun,
  planEditableSkillsRefresh,
  preflightSupervisor,
  promptConfig,
  registerTargetRepository,
  registrationSummary,
  writeProjectConfig,
  type InitCommandOptions,
  type ProjectConfig,
} from "./init.js";
import { LocalFileSecretStore } from "./onboarding/secret-store.js";
import {
  LocalSupervisorAccessStore,
  type SupervisorAccessStore,
} from "./onboarding/supervisor-access-store.js";
import { LOCAL_SECRET_KEYS } from "./setup.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.doUnmock("@clack/prompts");
  process.exitCode = undefined;
});

function temporaryProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "openthrottle-cli-test-"));
  directories.push(directory);
  return directory;
}

function skillfishResult(json: unknown): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(JSON.stringify(json)),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  } as SpawnSyncReturns<Buffer>;
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

const configuredSupervisorEnv = {
  OT_SUPERVISOR_URL: "https://supervisor.test",
  OT_STATUS_TOKEN: "operator-token",
} as const;

function memorySupervisorAccessStore(
  values: Record<string, { supervisorUrl: string; statusToken: string }> = {}
): SupervisorAccessStore {
  return {
    load: async (profileName) => values[profileName],
    save: async (profileName, access) => { values[profileName] = access; },
    pathFor: (profileName) => `/home/test/.openthrottle/supervisor-access/${profileName}.json`,
  };
}

const validCapabilities = {
  release: "test-release",
  capabilityDigest: "a".repeat(64),
  capabilities: ["agent/semantic@1"],
  limits: { taskTimeoutSeconds: 7200 },
};

function initPreflightHarness(
  env: Record<string, string | undefined>,
  request: NonNullable<InitCommandOptions["request"]>
) {
  const messages: string[] = [];
  let downstreamCalls = 0;
  const markDownstreamCall = () => {
    downstreamCalls += 1;
  };
  const options: InitCommandOptions = {
    env,
    request,
    supervisorAccessStore: memorySupervisorAccessStore(),
    detectRepository: () => {
      markDownstreamCall();
      return { repo: "acme/widget" };
    },
    detectProject: () => {
      markDownstreamCall();
      return { pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" };
    },
    promptConfig: async () => {
      markDownstreamCall();
      throw new Error("questionnaire must not run");
    },
    registerTargetRepository: async () => {
      markDownstreamCall();
      throw new Error("registration must not run");
    },
    reportPreflightFailure: (message) => messages.push(message),
  };
  return { options, messages, downstreamCalls: () => downstreamCalls };
}

function recordSupervisorRequests(): Array<{ url: string; authorization: string | null }> {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, requestInit?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(requestInit?.headers).get("Authorization"),
    });
    return Response.json(String(input).endsWith("/capabilities") ? validCapabilities : { ok: true });
  });
  return requests;
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

async function runInitWithSnapshotState(state: string) {
  const directory = temporaryProject();
  const originalDirectory = process.cwd();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  };
  const spinner = { start: vi.fn(), stop: vi.fn() };
  const outro = vi.fn();
  vi.resetModules();
  vi.doMock("@clack/prompts", () => ({
    cancel: vi.fn(),
    confirm: vi.fn(async () => true),
    group: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn(() => false),
    log,
    outro,
    select: vi.fn(),
    spinner: vi.fn(() => spinner),
    text: vi.fn(),
  }));

  try {
    process.chdir(directory);
    const { default: initWithMockPrompts } = await import("./init.js");
    await initWithMockPrompts([], {
      env: configuredSupervisorEnv,
      request: async (path) => Response.json(path === "/capabilities" ? validCapabilities : { ok: true }),
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => ({
        project: completeProjectConfig(),
        registration: {
          repo: "acme/widget",
          baseBranch: "main",
          controlProvider: "github",
        },
      }),
      installLocalSkills: () => [],
      registerTargetRepository: async () => ({
        registration: { github_repo: "acme/widget", base_branch: "main" },
        readiness: {
          github: "ready",
          webhook: "created",
          snapshot: { name: "openthrottle", state },
        },
      }),
    });
  } finally {
    process.chdir(originalDirectory);
  }
  return { log, outro, spinner };
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

  it("installs the operator and planning skills idempotently for repo init", () => {
    const home = temporaryProject();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const sourceRef = "0123456789abcdef0123456789abcdef01234567";
    const manifests: string[] = [];
    const runner = (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === "list") {
        const installed = [
          ["openthrottle", "skills/operator/openthrottle"],
          ["ot-plan", "skills/planning/ot-plan"],
        ].flatMap(([name, path]) => {
          const target = join(home, ".codex", "skills", name!);
          return existsSync(target)
            ? [{ skill: name, agent: "Codex", path: target, location: "global", path_source: path }]
            : [];
        });
        return skillfishResult({ success: true, installed, agents_detected: ["Codex"] });
      }
      const manifest = JSON.parse(
        readFileSync(join(options.env.HOME ?? "", "skillfish.json"), "utf8")
      ) as { skills: string[] };
      const source = manifest.skills[0]!;
      manifests.push(source);
      const planning = source.endsWith("/skills/planning/ot-plan");
      const name = planning ? "ot-plan" : "openthrottle";
      const sourceDirectory = resolve(
        process.cwd(),
        planning ? "../skills/planning/ot-plan" : "../skills/operator/openthrottle"
      );
      const target = join(options.env.HOME ?? "", ".codex", "skills", name);
      mkdirSync(target, { recursive: true });
      cpSync(sourceDirectory, target, { recursive: true });
      writeFileSync(join(target, ".skillfish.json"), JSON.stringify({
        owner: "knoxgraeme",
        repo: "openthrottle",
        path: planning ? "skills/planning/ot-plan" : "skills/operator/openthrottle",
        source: "manifest",
      }));
      return skillfishResult({
        success: true,
        installed: [{ skill: name, agent: "Codex", path: target, location: "global" }],
      });
    };

    const installs = installLocalSkills({ home, runner, sourceRef });

    expect(installs.map(({ name, result }) => ({ name, success: result.success }))).toEqual([
      { name: "openthrottle", success: true },
      { name: "ot-plan", success: true },
    ]);
    expect(manifests).toEqual([
      `knoxgraeme/openthrottle@${sourceRef}/skills/operator/openthrottle`,
      `knoxgraeme/openthrottle@${sourceRef}/skills/planning/ot-plan`,
    ]);
    expect(readFileSync(join(home, ".codex", "skills", "openthrottle", "SKILL.md"), "utf8"))
      .toContain("name: openthrottle");
    expect(readFileSync(join(home, ".codex", "skills", "ot-plan", "SKILL.md"), "utf8"))
      .toContain("name: ot-plan");
    expect(localSkillInstallSummary(installs)).toEqual(expect.arrayContaining([
      expect.stringContaining("openthrottle: installed for Codex"),
      expect.stringContaining("ot-plan: installed for Codex"),
    ]));

    const repeated = installLocalSkills({ home, runner, sourceRef });
    expect(repeated.every(({ result }) => result.success)).toBe(true);
    expect(repeated.every(({ result }) => result.skipped.some(({ agent }) => agent === "Codex"))).toBe(true);
    expect(manifests).toHaveLength(2);
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
          github: "ready",
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
          github: "ready",
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

  it("rejects a malformed successful registration response", async () => {
    await expect(registerTargetRepository({
      repo: "acme/widget",
      controlProvider: "github",
    }, async () => Response.json({
      registration: { github_repo: "acme/widget", base_branch: "main" },
      readiness: {},
    }))).rejects.toThrow("invalid repository registration response");
  });

  it("rejects registration responses without ready GitHub and known webhook evidence", async () => {
    for (const readiness of [
      { github: "error", webhook: "created" },
      { github: "ready", webhook: "installed" },
    ]) {
      await expect(registerTargetRepository({
        repo: "acme/widget",
        controlProvider: "github",
      }, async () => Response.json({
        registration: { github_repo: "acme/widget", base_branch: "main" },
        readiness: {
          ...readiness,
          snapshot: { name: "openthrottle", state: "active" },
        },
      }))).rejects.toThrow("invalid repository registration response");
    }
  });

  it("fails init with setup guidance when registration reports a not-ready snapshot", async () => {
    const { log, outro, spinner } = await runInitWithSnapshotState("error");

    expect(process.exitCode).toBe(1);
    expect(spinner.stop).toHaveBeenCalledWith("Repository registered, but platform readiness failed");
    expect(log.error).toHaveBeenCalledWith(
      "Platform snapshot not ready — run `openthrottle setup` (Daytona snapshot openthrottle is error)."
    );
    expect(log.success).not.toHaveBeenCalledWith(expect.stringContaining("Daytona snapshot"));
    expect(outro).not.toHaveBeenCalled();
  });

  it("still completes init when registration reports an active snapshot", async () => {
    const { log, outro, spinner } = await runInitWithSnapshotState("active");

    expect(process.exitCode).toBeUndefined();
    expect(spinner.stop).toHaveBeenCalledWith("Registered acme/widget on main");
    expect(log.success).toHaveBeenCalledWith(
      "GitHub webhook created; Daytona snapshot openthrottle is active."
    );
    expect(outro).toHaveBeenCalledOnce();
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

  it("previews the config-overwrite migration in the dry run exactly like the real run", () => {
    const config = completeProjectConfig();

    const migratingDirectory = temporaryProject();
    writeProjectConfig(config, migratingDirectory);
    const { plan, assumesConfigOverwrite } = planEditableSkillsDryRun(config, migratingDirectory);
    expect(assumesConfigOverwrite).toBe(true);
    expect(plan).toEqual(planEditableSkillsRefresh(config, migratingDirectory, { allowConfigOverwrite: true }));
    expect(plan).toMatchObject({
      writable: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: ".openthrottle.yml", status: "upstream-only" }),
      ]),
    });
    expect(planEditableSkillsRefresh(config, migratingDirectory)).toMatchObject({ writable: false });

    const freshDirectory = temporaryProject();
    const fresh = planEditableSkillsDryRun(config, freshDirectory);
    expect(fresh.assumesConfigOverwrite).toBe(false);
    expect(fresh.plan).toEqual(planEditableSkillsRefresh(config, freshDirectory));
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

  it("diagnoses missing supervisor configuration before detection, prompts, or registration", async () => {
    let requestCalls = 0;
    const harness = initPreflightHarness({}, async () => {
      requestCalls += 1;
      return Response.json({});
    });
    await init([], harness.options);

    expect(process.exitCode).toBe(1);
    expect(requestCalls).toBe(0);
    expect(harness.downstreamCalls()).toBe(0);
    expect(harness.messages).toEqual([
      expect.stringMatching(/run `openthrottle setup`.*export OT_SUPERVISOR_URL and OT_STATUS_TOKEN/),
    ]);
  });

  it("uses default-profile supervisor access when init has no exported credentials", async () => {
    const requests = recordSupervisorRequests();

    await expect(init([], {
      env: {},
      supervisorAccessStore: memorySupervisorAccessStore({
        default: {
          supervisorUrl: "https://profile-supervisor.test",
          statusToken: "profile-token",
        },
      }),
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => {
        throw new Error("questionnaire reached");
      },
    })).rejects.toThrow("questionnaire reached");

    expect(requests).toEqual([
      { url: "https://profile-supervisor.test/healthz", authorization: "Bearer profile-token" },
      { url: "https://profile-supervisor.test/capabilities", authorization: "Bearer profile-token" },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("ignores a complete legacy secret document when loading separate supervisor access", async () => {
    const secretRoot = temporaryProject();
    const accessRoot = temporaryProject();
    const legacyStore = new LocalFileSecretStore({ root: secretRoot, allowedKeys: LOCAL_SECRET_KEYS, env: {} });
    for (const [key, value] of [
      ["status_token", "legacy-token"],
      ["deploy_token", "deploy-token"],
      ["install_secret", "install-secret"],
      ["linear_webhook_secret", "linear-secret"],
      ["github_webhook_secret", "github-secret"],
    ] as const) {
      await legacyStore.set("default", key, value);
    }
    const legacyBefore = readFileSync(legacyStore.pathFor("default"), "utf8");
    const accessStore = new LocalSupervisorAccessStore(accessRoot);
    await accessStore.save("default", {
      supervisorUrl: "https://profile-supervisor.test",
      statusToken: "access-token",
    });
    const requests = recordSupervisorRequests();

    await expect(init([], {
      env: {},
      supervisorAccessStore: accessStore,
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => { throw new Error("questionnaire reached"); },
    })).rejects.toThrow("questionnaire reached");

    expect(requests[0]?.authorization).toBe("Bearer access-token");
    expect(readFileSync(legacyStore.pathFor("default"), "utf8")).toBe(legacyBefore);
    expect(legacyBefore).not.toContain("supervisor_url");
  });

  it("prefers explicit supervisor env vars over stored profile access", async () => {
    let secretLoads = 0;
    const requests = recordSupervisorRequests();

    await expect(init([], {
      env: configuredSupervisorEnv,
      supervisorAccessStore: {
        load: async () => {
          secretLoads += 1;
          return { supervisorUrl: "https://stored.test", statusToken: "profile-token" };
        },
      },
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => {
        throw new Error("questionnaire reached");
      },
    })).rejects.toThrow("questionnaire reached");

    expect(secretLoads).toBe(0);
    expect(requests).toEqual([
      { url: "https://supervisor.test/healthz", authorization: "Bearer operator-token" },
      { url: "https://supervisor.test/capabilities", authorization: "Bearer operator-token" },
    ]);
  });

  it("selects a named profile and its matching supervisor-access entry", async () => {
    const requests = recordSupervisorRequests();

    await expect(init(["--profile", "prod"], {
      env: {},
      supervisorAccessStore: memorySupervisorAccessStore({
        prod: {
          supervisorUrl: "https://prod-supervisor.test",
          statusToken: "prod-token",
        },
      }),
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => {
        throw new Error("questionnaire reached");
      },
    })).rejects.toThrow("questionnaire reached");

    expect(requests).toEqual([
      { url: "https://prod-supervisor.test/healthz", authorization: "Bearer prod-token" },
      { url: "https://prod-supervisor.test/capabilities", authorization: "Bearer prod-token" },
    ]);
  });

  it("does not mix partial environment credentials with profile fallback credentials", async () => {
    for (const env of [
      { OT_SUPERVISOR_URL: "https://attacker.test" },
      { OT_STATUS_TOKEN: "explicit-token" },
    ]) {
      let secretLoads = 0;
      const harness = initPreflightHarness(env, async () => {
        throw new Error("partial credentials must not make a request");
      });
      harness.options.supervisorAccessStore = {
        load: async () => {
          secretLoads += 1;
          return { supervisorUrl: "https://stored.test", statusToken: "profile-token" };
        },
      };

      await init([], harness.options);

      expect(process.exitCode).toBe(1);
      expect(secretLoads).toBe(0);
      expect(harness.downstreamCalls()).toBe(0);
      process.exitCode = undefined;
    }
  });

  it("reports an invalid stored access document without a stack trace or downstream work", async () => {
    const harness = initPreflightHarness({}, async () => {
      throw new Error("invalid access must not make a request");
    });
    harness.options.supervisorAccessStore = {
      load: async () => { throw new Error("refusing to read supervisor access document"); },
    };

    await init(["--profile", "prod"], harness.options);

    expect(process.exitCode).toBe(1);
    expect(harness.downstreamCalls()).toBe(0);
    expect(harness.messages).toEqual([
      expect.stringMatching(
        /Stored supervisor access for profile prod is invalid.*refusing to read supervisor access document.*setup --profile prod/
      ),
    ]);
  });

  it("parses init profile selection without weakening existing option validation", () => {
    expect(parseInitArgs(["--profile", "prod", "--editable-skills", "--dry-run"])).toEqual({
      profile: "prod",
      editableSkills: true,
      dryRun: true,
    });
    expect(() => parseInitArgs(["--profile"])).toThrow("--profile requires");
    expect(() => parseInitArgs(["--unknown"])).toThrow("Unknown init option");
  });

  it("diagnoses an unreachable supervisor before detection, prompts, or registration", async () => {
    const harness = initPreflightHarness(configuredSupervisorEnv, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await init([], harness.options);

    expect(process.exitCode).toBe(1);
    expect(harness.downstreamCalls()).toBe(0);
    expect(harness.messages).toEqual([
      expect.stringMatching(/Supervisor is unreachable.*openthrottle setup --check/),
    ]);
  });

  it("diagnoses a status-token mismatch separately from supervisor reachability", async () => {
    const paths: string[] = [];
    const harness = initPreflightHarness({
      ...configuredSupervisorEnv,
      OT_STATUS_TOKEN: "wrong-token",
    }, async (path) => {
      paths.push(path);
      return path === "/healthz" ? Response.json({ ok: true }) : Response.json({}, { status: 401 });
    });
    await init([], harness.options);

    expect(process.exitCode).toBe(1);
    expect(paths).toEqual(["/healthz", "/capabilities"]);
    expect(harness.downstreamCalls()).toBe(0);
    expect(harness.messages).toEqual([
      expect.stringMatching(/authentication failed.*OT_STATUS_TOKEN does not match/),
    ]);
    expect(harness.messages[0]).not.toContain("unreachable");
  });

  it("runs both supervisor checks before proceeding to the questionnaire", async () => {
    const paths: string[] = [];
    let promptCalls = 0;
    let registrationCalls = 0;
    await expect(init([], {
      env: configuredSupervisorEnv,
      request: async (path) => {
        paths.push(path);
        return Response.json(path === "/capabilities" ? validCapabilities : { ok: true });
      },
      detectRepository: () => ({ repo: "acme/widget", baseBranch: "main" }),
      detectProject: () => ({ pm: "npm", test: "npm test", build: "npm run build", lint: "npm run lint" }),
      promptConfig: async () => {
        promptCalls += 1;
        throw new Error("questionnaire reached");
      },
      registerTargetRepository: async () => {
        registrationCalls += 1;
        throw new Error("registration must not run before the questionnaire completes");
      },
    })).rejects.toThrow("questionnaire reached");

    expect(paths).toEqual(["/healthz", "/capabilities"]);
    expect(promptCalls).toBe(1);
    expect(registrationCalls).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails closed when successful preflight responses have malformed bodies", async () => {
    for (const responses of [
      { health: { ok: false }, capabilities: validCapabilities },
      { health: { ok: true }, capabilities: { limits: { taskTimeoutSeconds: 7200 } } },
    ]) {
      const harness = initPreflightHarness(configuredSupervisorEnv, async (path) => Response.json(
        path === "/healthz" ? responses.health : responses.capabilities
      ));

      await init([], harness.options);

      expect(process.exitCode).toBe(1);
      expect(harness.downstreamCalls()).toBe(0);
      expect(harness.messages).toEqual([
        expect.stringMatching(/invalid.*response.*openthrottle setup --check/i),
      ]);
      process.exitCode = undefined;
    }
  });

  it("fails closed when a successful preflight response is not JSON", async () => {
    const harness = initPreflightHarness(configuredSupervisorEnv, async () => (
      new Response("not-json", { status: 200 })
    ));

    await init([], harness.options);

    expect(process.exitCode).toBe(1);
    expect(harness.downstreamCalls()).toBe(0);
    expect(harness.messages).toEqual([
      expect.stringMatching(/invalid health response.*openthrottle setup --check/i),
    ]);
  });

  it("classifies preflight HTTP failures without consuming response bodies", async () => {
    await expect(preflightSupervisor(
      async () => new Response(null, { status: 503 }),
      configuredSupervisorEnv
    )).resolves.toMatchObject({
      status: "unreachable",
      message: expect.stringContaining("openthrottle setup --check"),
    });
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
