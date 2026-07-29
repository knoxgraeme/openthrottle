import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { stringify } from "yaml";
import { getErrorMessage, readEnv, supervisorRequest } from "./util.js";

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

interface Detected {
  pm: "npm" | "pnpm" | "yarn" | null;
  test: string;
  build: string;
  lint: string;
}

export interface ProjectConfig {
  agent: "claude" | "codex" | "opencode";
  model?: string;
  commands?: Record<string, string>;
  test: string;
  build: string;
  lint: string;
  post_bootstrap: string[];
  limits: { max_turns: number; task_timeout: number };
  mcp_servers: Record<string, unknown>;
}

export interface RepositoryTarget {
  repo: string;
  baseBranch?: string;
}

export interface RepositoryRegistrationInput extends RepositoryTarget {
  linearTeamKey: string;
  linearTeamId?: string;
}

interface InitSelection {
  project: ProjectConfig;
  registration: RepositoryRegistrationInput;
}

const COMMAND_ALIAS_NAMES = ["test", "build", "lint"] as const;

export function detectPackageManager(
  pkg: PackageJson,
  directory = process.cwd()
): "npm" | "pnpm" | "yarn" {
  if (pkg.packageManager?.startsWith("pnpm")) return "pnpm";
  if (pkg.packageManager?.startsWith("yarn")) return "yarn";
  if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(directory, "yarn.lock"))) return "yarn";
  return "npm";
}

export function detectProject(directory = process.cwd()): Detected {
  const packagePath = join(directory, "package.json");
  if (!existsSync(packagePath)) {
    return { pm: null, test: "", build: "", lint: "" };
  }
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(pkg, directory);
  const run = (script: string) => (scripts[script] ? `${pm} run ${script}` : "");
  return {
    pm,
    test: run("test"),
    build: run("build"),
    lint: run("lint"),
  };
}

export function parseGithubRemote(remote: string): string {
  const value = remote.trim().replace(/\.git$/, "");
  const match =
    value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i) ??
    value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) ??
    value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match?.[1] || !match[2]) {
    throw new Error("origin must point to a GitHub repository");
  }
  return `${match[1]}/${match[2]}`;
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function detectRepository(directory = process.cwd()): RepositoryTarget {
  let remote: string;
  try {
    remote = git(directory, ["remote", "get-url", "origin"]);
  } catch {
    throw new Error("No git origin found. Add the target GitHub repository as origin first.");
  }
  let baseBranch: string | undefined;
  try {
    const symbolic = git(directory, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    baseBranch = symbolic.replace(/^refs\/remotes\/origin\//, "") || undefined;
  } catch {
    try {
      git(directory, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      // For an unborn repository, HEAD still names the explicitly initialized base branch.
      try {
        baseBranch = git(directory, ["branch", "--show-current"]) || undefined;
      } catch {
        // The supervisor will use GitHub's canonical default branch.
      }
    }
  }
  return { repo: parseGithubRemote(remote), baseBranch };
}

export function registrationSummary(
  registration: RepositoryRegistrationInput,
  supervisorUrl?: string
): string {
  const branch = registration.baseBranch
    ? `base branch ${registration.baseBranch}`
    : "GitHub default branch";
  const target = supervisorUrl ? ` on ${supervisorUrl}` : "";
  return `Linear team ${registration.linearTeamKey} → ${registration.repo} (${branch})${target}`;
}

async function promptConfig(detected: Detected, target: RepositoryTarget): Promise<InitSelection> {
  const result = await p.group(
    {
      linearTeamKey: () =>
        p.text({
          message: "Linear team key routed to this repository",
          initialValue: readEnv("LINEAR_TEAM_KEY") ?? "",
          validate: (value) => (/^[A-Za-z0-9_-]+$/.test(value) ? undefined : "Enter a team key"),
        }),
      linearTeamId: () =>
        p.text({
          message: "Linear team ID (optional, but recommended)",
          initialValue: readEnv("LINEAR_TEAM_ID") ?? "",
        }),
      baseBranch: () =>
        p.text({
          message: "Base branch (blank uses GitHub default)",
          initialValue: target.baseBranch ?? "",
        }),
      agent: () =>
        p.select({
          message: "Default agent",
          options: [
            { value: "codex", label: "Codex CLI" },
            { value: "claude", label: "Claude Code" },
            { value: "opencode", label: "OpenCode (Kimi Code)" },
          ],
          initialValue: "codex",
        }),
      model: ({ results }) => {
        const agent = results.agent as ProjectConfig["agent"] | undefined;
        return p.text({
          message: "Model (blank uses the agent default; required for OpenCode)",
          initialValue: agent === "opencode" ? "kimi-code/kimi-for-coding" : "",
          validate: (value) => {
            const trimmed = value.trim();
            if (agent === "opencode" && !trimmed) return "OpenCode requires a model";
            if (trimmed && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) {
              return "Model may contain letters, digits, and . _ / - only";
            }
            return undefined;
          },
        });
      },
      test: () => p.text({ message: "Test command (blank to skip)", initialValue: detected.test }),
      build: () => p.text({ message: "Build command (blank to skip)", initialValue: detected.build }),
      lint: () => p.text({ message: "Lint command (blank to skip)", initialValue: detected.lint }),
      post_bootstrap: () =>
        p.text({
          message: "Post-bootstrap command (blank to skip)",
          initialValue: detected.pm ? `${detected.pm} install` : "",
        }),
      max_turns: () => p.text({ message: "Max turns per agent run", initialValue: "200" }),
      task_timeout: () => p.text({ message: "Task timeout (seconds)", initialValue: "7200" }),
    },
    {
      onCancel: () => {
        p.cancel("Cancelled.");
        process.exit(0);
      },
    }
  );
  return {
    project: {
      agent: result.agent as "claude" | "codex" | "opencode",
      model: typeof result.model === "string" && result.model.trim() ? result.model.trim() : undefined,
      commands: {
        ...(result.test ? { test: result.test } : {}),
        ...(result.lint ? { lint: result.lint } : {}),
        ...(result.build ? { build: result.build } : {}),
      },
      test: result.test,
      build: result.build,
      lint: result.lint,
      post_bootstrap: result.post_bootstrap ? [result.post_bootstrap] : [],
      limits: {
        max_turns: Number(result.max_turns) || 200,
        task_timeout: Number(result.task_timeout) || 7200,
      },
      mcp_servers: {},
    },
    registration: {
      repo: target.repo,
      baseBranch: result.baseBranch || undefined,
      linearTeamKey: result.linearTeamKey.toUpperCase(),
      linearTeamId: result.linearTeamId || undefined,
    },
  };
}

export function writeProjectConfig(config: ProjectConfig, directory = process.cwd()): void {
  const commands = { ...(config.commands ?? {
    ...(config.test ? { test: config.test } : {}),
    ...(config.lint ? { lint: config.lint } : {}),
    ...(config.build ? { build: config.build } : {}),
  }) };
  const aliases: Partial<Record<(typeof COMMAND_ALIAS_NAMES)[number], string>> = {};
  for (const name of COMMAND_ALIAS_NAMES) {
    const alias = config[name];
    const command = commands[name];
    if (alias && command && alias !== command) {
      throw new Error(`${name} must match commands.${name}`);
    }
    const normalized = command || alias;
    if (normalized) {
      commands[name] = normalized;
      aliases[name] = normalized;
    }
  }
  const document: Record<string, unknown> = {
    schema: "openthrottle.config/v1",
    default_graph: "simple",
    graphs: [
      { id: "simple", kind: "builtin", ref: "core/simple@1" },
      { id: "structured", kind: "builtin", ref: "core/structured@1" },
    ],
    ...config,
    commands,
    ...aliases,
    intents: {
      implement: { default_graph: "simple", allowed_graphs: ["simple", "structured"] },
      investigate: { default_graph: "simple", allowed_graphs: ["simple"] },
    },
  };
  for (const key of ["test", "build", "lint", "model"] as const) {
    if (key === "model") {
      if (!config.model) delete document.model;
    } else if (!aliases[key]) {
      delete document[key];
    }
  }
  if (Object.keys(commands).length === 0) delete document.commands;
  const header = [
    "# .openthrottle.yml — project config for OpenThrottle",
    "# Generated by `openthrottle init`; commit this file.",
    "",
  ].join("\n");
  writeFileSync(join(directory, ".openthrottle.yml"), header + stringify(document));
}

export async function registerTargetRepository(
  input: RepositoryRegistrationInput,
  request: typeof supervisorRequest = supervisorRequest
): Promise<{
  registration: { github_repo: string; base_branch: string };
  readiness: { webhook: string; snapshot: { name: string; state: string } };
}> {
  const response = await request("/repositories/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as {
    error?: string;
    registration: { github_repo: string; base_branch: string };
    readiness: { webhook: string; snapshot: { name: string; state: string } };
  };
  if (!response.ok) throw new Error(body.error ?? `Supervisor returned HTTP ${response.status}`);
  return body;
}

export default async function init(): Promise<void> {
  p.intro("openthrottle init");
  let detected: Detected;
  let target: RepositoryTarget;
  try {
    target = detectRepository();
    detected = detectProject();
  } catch (error) {
    p.log.error(getErrorMessage(error));
    process.exit(1);
  }
  p.log.info(`Target repository: ${target.repo} (${target.baseBranch ?? "GitHub default branch"})`);
  p.log.info(detected.pm ? `Detected package manager: ${detected.pm}` : "No Node package detected; enter project commands manually.");
  const selection = await promptConfig(detected, target);

  p.log.warn(
    "The target repository was auto-detected from this directory's git origin. " +
      "If it is wrong, cancel and re-run `openthrottle init` from the correct repository checkout."
  );
  const proceed = await p.confirm({
    message: `Register ${registrationSummary(selection.registration, readEnv("OT_SUPERVISOR_URL"))}?`,
    initialValue: false,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled. No repository was registered and no files were changed.");
    return;
  }

  const configPath = join(process.cwd(), ".openthrottle.yml");
  if (existsSync(configPath)) {
    const overwrite = await p.confirm({
      message: ".openthrottle.yml already exists. Overwrite?",
      initialValue: false,
    });
    if (p.isCancel(overwrite)) {
      p.cancel("Cancelled.");
      return;
    }
    if (!overwrite) p.log.warn("Kept existing .openthrottle.yml");
    else {
      writeProjectConfig(selection.project);
      p.log.success("Wrote .openthrottle.yml");
    }
  } else {
    writeProjectConfig(selection.project);
    p.log.success("Wrote .openthrottle.yml");
  }

  const spinner = p.spinner();
  spinner.start("Registering repository and checking readiness");
  try {
    const result = await registerTargetRepository(selection.registration);
    spinner.stop(`Registered ${result.registration.github_repo} on ${result.registration.base_branch}`);
    p.log.success(
      `GitHub webhook ${result.readiness.webhook}; Daytona snapshot ${result.readiness.snapshot.name} is ${result.readiness.snapshot.state}.`
    );
  } catch (error) {
    spinner.stop("Repository registration failed");
    p.log.error(getErrorMessage(error));
    p.log.warn("The local .openthrottle.yml is ready; rerun init after fixing supervisor access.");
    process.exit(1);
  }
  p.outro("Commit .openthrottle.yml, then delegate an issue from the configured Linear team.");
}
