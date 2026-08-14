import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import {
  canonicalJson,
  digestCanonicalJson,
  parseGraphContract,
  validateRepositoryConfigContract,
  type GraphContract,
} from "@openthrottle/contracts";
import { parse, stringify } from "yaml";
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

export type ControlProvider = "linear" | "github";

export type RepositoryRegistrationInput = RepositoryTarget & (
  | {
      controlProvider: "linear";
      linearTeamKey: string;
      linearTeamId?: string;
    }
  | {
      controlProvider: "github";
      linearTeamKey?: never;
      linearTeamId?: never;
    }
);

interface InitSelection {
  project: ProjectConfig;
  registration: RepositoryRegistrationInput;
}

type InitPromptApi = Pick<typeof p, "group" | "select" | "text">;

export type EditableRefreshStatus = "unchanged" | "local-only" | "upstream-only" | "conflict";

export interface EditableRefreshEntry {
  path: string;
  status: EditableRefreshStatus;
  provenance_digest: string | null;
  local_digest: string | null;
  upstream_digest: string | null;
}

export interface EditableSkillsRefreshPlan {
  entries: EditableRefreshEntry[];
  writable: boolean;
}

export interface EditableSkillsResources {
  graphPath?: string;
  skillDirectory?: string;
  release?: string;
}

export interface WriteProjectConfigOptions {
  editableSkills?: boolean;
  allowConfigOverwrite?: boolean;
  supervisorTaskTimeoutSeconds?: number;
  resources?: EditableSkillsResources;
}

interface EditableSkillsLock {
  schema: "openthrottle.skills.lock/v1";
  integrity_digest: string;
  openthrottle_release: string;
  upstream_graph: {
    ref: "core/simple@1";
    digest: string;
    scaffold_digest: string;
  };
  upstream_package_digest: string;
  upstream_files: Array<{ path: string; digest: string }>;
  scaffold_package_digest: string;
  files: Array<{ path: string; digest: string }>;
}

interface EditableScaffold {
  files: Map<string, string>;
  lock: EditableSkillsLock;
}

interface EditableSkillSourceFile {
  path: string;
  contents: string;
  digest: string;
}

const COMMAND_ALIAS_NAMES = ["test", "build", "lint"] as const;
const EDITABLE_GRAPH_ID = "simple_editable";
const EDITABLE_GRAPH_PATH = ".openthrottle/graphs/simple.json";
const EDITABLE_SKILL_ID = "implement-plan";
const EDITABLE_SKILL_PATH = `.openthrottle/skills/${EDITABLE_SKILL_ID}`;
const EDITABLE_LOCK_PATH = ".openthrottle/skills.lock.json";
const REQUIRED_EDITABLE_SKILL_FILES = ["SKILL.md", "agents/openai.yaml"] as const;
const REPOSITORY_SKILL_MAX_FILES = 64;
const REPOSITORY_SKILL_MAX_BYTES = 256 * 1024;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_REPOSITORY_TASK_TIMEOUT_SECONDS = 7_200;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

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
  const control = registration.controlProvider === "linear"
    ? `Linear team ${registration.linearTeamKey}`
    : "GitHub Issues";
  return `${control} → ${registration.repo} (${branch})${target}`;
}

export function initOutro(
  registration: RepositoryRegistrationInput,
  editableSkills: boolean
): string {
  const files = editableSkills ? ".openthrottle.yml and .openthrottle/" : ".openthrottle.yml";
  const delegation = registration.controlProvider === "linear"
    ? "delegate an issue from the configured Linear team"
    : "open or label a GitHub issue with `openthrottle`";
  return `Commit ${files}, then ${delegation}.`;
}

export async function promptConfig(
  detected: Detected,
  target: RepositoryTarget,
  prompts: InitPromptApi = p
): Promise<InitSelection> {
  const result = await prompts.group(
    {
      controlProvider: () =>
        prompts.select<ControlProvider>({
          message: "Control provider",
          options: [
            { value: "linear", label: "Linear" },
            { value: "github", label: "GitHub Issues" },
          ],
          initialValue: "linear",
        }),
      linearTeamKey: ({ results }) =>
        results.controlProvider === "linear" ? prompts.text({
          message: "Linear team key routed to this repository",
          initialValue: readEnv("LINEAR_TEAM_KEY") ?? "",
          validate: (value) => (/^[A-Za-z0-9_-]+$/.test(value) ? undefined : "Enter a team key"),
        }) : undefined,
      linearTeamId: ({ results }) =>
        results.controlProvider === "linear" ? prompts.text({
          message: "Linear team ID (optional, but recommended)",
          initialValue: readEnv("LINEAR_TEAM_ID") ?? "",
        }) : undefined,
      baseBranch: () =>
        prompts.text({
          message: "Base branch (blank uses GitHub default)",
          initialValue: target.baseBranch ?? "",
        }),
      agent: () =>
        prompts.select<ProjectConfig["agent"]>({
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
        return prompts.text({
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
      test: () => prompts.text({ message: "Test command (blank to skip)", initialValue: detected.test }),
      build: () => prompts.text({ message: "Build command (blank to skip)", initialValue: detected.build }),
      lint: () => prompts.text({ message: "Lint command (blank to skip)", initialValue: detected.lint }),
      post_bootstrap: () =>
        prompts.text({
          message: "Post-bootstrap command (blank to skip)",
          initialValue: detected.pm ? `${detected.pm} install` : "",
        }),
      max_turns: () => prompts.text({ message: "Max turns per agent run", initialValue: "200" }),
      task_timeout: () => prompts.text({ message: "Task timeout (seconds)", initialValue: "7200" }),
    },
    {
      onCancel: () => {
        p.cancel("Cancelled.");
        process.exit(0);
      },
    }
  );
  if (result.controlProvider !== "linear" && result.controlProvider !== "github") {
    throw new Error("Control provider selection is required");
  }
  let registration: RepositoryRegistrationInput;
  if (result.controlProvider === "linear") {
    if (typeof result.linearTeamKey !== "string") {
      throw new Error("Linear team key is required");
    }
    registration = {
      repo: target.repo,
      baseBranch: result.baseBranch || undefined,
      controlProvider: "linear",
      linearTeamKey: result.linearTeamKey.toUpperCase(),
      linearTeamId: typeof result.linearTeamId === "string" && result.linearTeamId
        ? result.linearTeamId
        : undefined,
    };
  } else {
    registration = {
      repo: target.repo,
      baseBranch: result.baseBranch || undefined,
      controlProvider: "github",
    };
  }
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
    registration,
  };
}

function projectConfigDocument(config: ProjectConfig, editableSkills = false): Record<string, unknown> {
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
    default_graph: editableSkills ? EDITABLE_GRAPH_ID : "simple",
    graphs: [
      { id: "simple", kind: "builtin", ref: "core/simple@1" },
      { id: "structured", kind: "builtin", ref: "core/structured@3" },
      ...(editableSkills
        ? [{ id: EDITABLE_GRAPH_ID, kind: "repository", ref: EDITABLE_GRAPH_PATH }]
        : []),
    ],
    pipelines: { implement: "implement", investigate: "investigate", tune: "tune" },
    ...config,
    commands,
    ...aliases,
    ...(editableSkills ? {
      skills: [{ id: EDITABLE_SKILL_ID, path: EDITABLE_SKILL_PATH }],
    } : {}),
    intents: {
      implement: editableSkills
        ? { default_graph: EDITABLE_GRAPH_ID, allowed_graphs: [EDITABLE_GRAPH_ID, "simple", "structured"] }
        : { default_graph: "simple", allowed_graphs: ["simple", "structured"] },
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
  return document;
}

function renderProjectConfig(config: ProjectConfig, editableSkills = false): string {
  const document = projectConfigDocument(config, editableSkills);
  const header = [
    "# .openthrottle.yml — project config for OpenThrottle",
    "# Generated by `openthrottle init`; commit this file.",
    "",
  ].join("\n");
  return header + stringify(document);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeRepositoryPath(directory: string, path: string): void {
  const root = resolve(directory);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`editable-skills path escapes the repository: ${path}`);
  }
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("editable-skills repository root must be a real directory");
  }
  let current = root;
  const parts = path.split("/").filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`editable-skills path must not contain symlinks: ${path}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`editable-skills parent path is not a directory: ${path}`);
    }
  }
}

function readRepositoryFile(directory: string, path: string): string | null {
  assertSafeRepositoryPath(directory, path);
  const absolute = join(directory, path);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`editable-skills path is not a regular file: ${path}`);
  return readFileSync(absolute, "utf8");
}

function localEditableSkillFiles(directory: string): Array<{ path: string; digest: string }> {
  assertSafeRepositoryPath(directory, EDITABLE_SKILL_PATH);
  const root = join(directory, EDITABLE_SKILL_PATH);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (!rootStat.isDirectory()) {
    throw new Error(`editable-skills package path is not a directory: ${EDITABLE_SKILL_PATH}`);
  }
  const files: Array<{ path: string; digest: string }> = [];
  let totalBytes = 0;
  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const path = `${EDITABLE_SKILL_PATH}/${entryRelative}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`editable-skills package must not contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        visit(join(absolute, entry.name), entryRelative);
      } else if (entry.isFile()) {
        if (files.length >= REPOSITORY_SKILL_MAX_FILES) {
          throw new Error(`editable-skills package exceeds the ${REPOSITORY_SKILL_MAX_FILES} file limit`);
        }
        const contents = readFileSync(join(absolute, entry.name), "utf8");
        totalBytes += Buffer.byteLength(contents, "utf8");
        if (totalBytes > REPOSITORY_SKILL_MAX_BYTES) {
          throw new Error("editable-skills package exceeds the 256 KiB snapshot limit");
        }
        files.push({ path, digest: digest(contents) });
      } else {
        throw new Error(`editable-skills package contains a non-regular entry: ${path}`);
      }
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function defaultEditableResources(resources: EditableSkillsResources = {}): Required<EditableSkillsResources> {
  const bundledGraph = join(MODULE_DIRECTORY, "scaffolds/simple-v1.json");
  const bundledSkill = join(MODULE_DIRECTORY, "skills/tasks/implement-plan");
  const packageJson = JSON.parse(readFileSync(join(MODULE_DIRECTORY, "../package.json"), "utf8")) as {
    version: string;
  };
  return {
    graphPath: resources.graphPath ?? (existsSync(bundledGraph)
      ? bundledGraph
      : resolve(MODULE_DIRECTORY, "../../supervisor/graphs/simple-v1.json")),
    skillDirectory: resources.skillDirectory ?? (existsSync(bundledSkill)
      ? bundledSkill
      : resolve(MODULE_DIRECTORY, "../../skills/tasks/implement-plan")),
    release: resources.release ?? packageJson.version,
  };
}

function editableGraph(raw: string, repositoryTaskTimeoutSeconds: number): GraphContract {
  const graph = JSON.parse(raw) as GraphContract;
  graph.id = "repository/simple_editable";
  for (const worker of graph.workers) {
    if (worker.id === "implementer-fresh" || worker.id === "implementer-resume") {
      worker.skills = [`repo://${EDITABLE_SKILL_ID}`];
    }
  }
  for (const loop of graph.loops) {
    loop.timeout_seconds = repositoryTaskTimeoutSeconds;
    if (loop.id === "implementation-loop" || loop.id === "repair-implementation-loop") {
      loop.skill = `repo://${EDITABLE_SKILL_ID}`;
    }
  }
  return graph;
}

function isSafePackagePath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function readEditableSkillSourcePackage(skillDirectory: string): EditableSkillSourceFile[] {
  const root = resolve(skillDirectory);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("editable implement-plan source must be a real directory");
  }

  const files: EditableSkillSourceFile[] = [];
  let totalBytes = 0;
  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryAbsolute = join(absolute, entry.name);
      if (!isSafePackagePath(entryRelative)) {
        throw new Error(`editable implement-plan source has an unsafe path: ${entryRelative}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`editable implement-plan source must not contain symlinks: ${entryRelative}`);
      }
      if (entry.isDirectory()) {
        visit(entryAbsolute, entryRelative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`editable implement-plan source contains a non-regular entry: ${entryRelative}`);
      }
      if (files.length >= REPOSITORY_SKILL_MAX_FILES) {
        throw new Error(`editable implement-plan source exceeds the ${REPOSITORY_SKILL_MAX_FILES} file limit`);
      }
      const contents = readFileSync(entryAbsolute, "utf8");
      totalBytes += Buffer.byteLength(contents, "utf8");
      if (totalBytes > REPOSITORY_SKILL_MAX_BYTES) {
        throw new Error("editable implement-plan source exceeds the 256 KiB snapshot limit");
      }
      files.push({ path: entryRelative, contents, digest: digest(contents) });
    }
  };
  visit(root, "");
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const required of REQUIRED_EDITABLE_SKILL_FILES) {
    if (!files.some((entry) => entry.path === required)) {
      throw new Error(`editable implement-plan source is missing ${required}`);
    }
  }
  return files;
}

function editableSkillsLockPayload(lock: EditableSkillsLock): Omit<EditableSkillsLock, "integrity_digest"> {
  const { integrity_digest: _integrityDigest, ...payload } = lock;
  return payload;
}

function hasUniquePaths(entries: Array<{ path: string }>): boolean {
  return new Set(entries.map((entry) => entry.path)).size === entries.length;
}

function parseEditableSkillsLock(raw: string): EditableSkillsLock | null {
  try {
    const value = JSON.parse(raw) as Partial<EditableSkillsLock>;
    if (value.schema !== "openthrottle.skills.lock/v1" ||
        typeof value.openthrottle_release !== "string" ||
        value.openthrottle_release.length === 0 ||
        value.openthrottle_release.length > 200 ||
        typeof value.integrity_digest !== "string" ||
        !SHA256_DIGEST.test(value.integrity_digest)) return null;
    if (!value.upstream_graph || value.upstream_graph.ref !== "core/simple@1") return null;
    if (typeof value.upstream_graph.digest !== "string" ||
        !SHA256_DIGEST.test(value.upstream_graph.digest) ||
        typeof value.upstream_graph.scaffold_digest !== "string" ||
        !SHA256_DIGEST.test(value.upstream_graph.scaffold_digest)) return null;
    if (typeof value.upstream_package_digest !== "string" ||
        !SHA256_DIGEST.test(value.upstream_package_digest) ||
        typeof value.scaffold_package_digest !== "string" ||
        !SHA256_DIGEST.test(value.scaffold_package_digest)) return null;
    if (!Array.isArray(value.upstream_files) || !Array.isArray(value.files)) return null;
    if (value.upstream_files.length > REPOSITORY_SKILL_MAX_FILES ||
        value.files.length > REPOSITORY_SKILL_MAX_FILES + 2) return null;
    if (![...value.upstream_files, ...value.files].every((entry) => (
      entry && typeof entry.path === "string" && isSafePackagePath(entry.path) &&
      typeof entry.digest === "string" && SHA256_DIGEST.test(entry.digest)
    ))) return null;
    if (!hasUniquePaths(value.upstream_files) || !hasUniquePaths(value.files)) return null;

    const lock = value as EditableSkillsLock;
    if (digestCanonicalJson(editableSkillsLockPayload(lock)) !== lock.integrity_digest) return null;
    if (digestCanonicalJson(lock.upstream_files) !== lock.upstream_package_digest) return null;
    const scaffoldPackage = lock.files
      .filter((entry) => entry.path.startsWith(`${EDITABLE_SKILL_PATH}/`))
      .map((entry) => ({
        path: entry.path.slice(`${EDITABLE_SKILL_PATH}/`.length),
        digest: entry.digest,
      }));
    if (digestCanonicalJson(scaffoldPackage) !== lock.scaffold_package_digest) return null;
    if (canonicalJson(scaffoldPackage) !== canonicalJson(lock.upstream_files)) return null;
    if (!REQUIRED_EDITABLE_SKILL_FILES.every((required) => (
      lock.upstream_files.some((entry) => entry.path === required)
    ))) return null;
    const graphFile = lock.files.find((entry) => entry.path === EDITABLE_GRAPH_PATH);
    const configFile = lock.files.find((entry) => entry.path === ".openthrottle.yml");
    if (!graphFile || !configFile || graphFile.digest !== lock.upstream_graph.scaffold_digest) return null;
    if (lock.files.some((entry) => (
      entry.path !== ".openthrottle.yml" &&
      entry.path !== EDITABLE_GRAPH_PATH &&
      !entry.path.startsWith(`${EDITABLE_SKILL_PATH}/`)
    ))) return null;
    return lock;
  } catch {
    return null;
  }
}

function buildEditableSkillsScaffold(
  config: ProjectConfig,
  resources: EditableSkillsResources = {},
  supervisorTaskTimeoutSeconds = DEFAULT_REPOSITORY_TASK_TIMEOUT_SECONDS
): EditableScaffold {
  for (const name of COMMAND_ALIAS_NAMES) {
    if (!(config.commands?.[name] || config[name])) {
      throw new Error(`--editable-skills requires a ${name} command because the simple graph executes it`);
    }
  }

  const resolved = defaultEditableResources(resources);
  const upstreamGraphRaw = readFileSync(resolved.graphPath, "utf8");
  const graph = editableGraph(
    upstreamGraphRaw,
    Math.min(config.limits.task_timeout, supervisorTaskTimeoutSeconds)
  );
  const graphRaw = `${JSON.stringify(graph, null, 2)}\n`;
  const configRaw = renderProjectConfig(config, true);
  const configContract = validateRepositoryConfigContract(parse(configRaw), { source: ".openthrottle.yml" });
  parseGraphContract(graphRaw, { source: EDITABLE_GRAPH_PATH, config: configContract.value });

  const files = new Map<string, string>([
    [".openthrottle.yml", configRaw],
    [EDITABLE_GRAPH_PATH, graphRaw],
  ]);
  const sourcePackage = readEditableSkillSourcePackage(resolved.skillDirectory);
  const upstreamFiles = sourcePackage.map(({ path, contents, digest: sourceDigest }) => {
    files.set(`${EDITABLE_SKILL_PATH}/${path}`, contents);
    return { path, digest: sourceDigest };
  });
  const skillName = files.get(`${EDITABLE_SKILL_PATH}/SKILL.md`)?.match(/^name:\s*implement-plan\s*$/m);
  if (!skillName) throw new Error("editable implement-plan SKILL.md frontmatter name must be implement-plan");

  const scaffoldFiles = [...files].map(([path, contents]) => ({ path, digest: digest(contents) }));
  const scaffoldPackageFiles = scaffoldFiles.filter((entry) => entry.path.startsWith(`${EDITABLE_SKILL_PATH}/`));
  const lockPayload: Omit<EditableSkillsLock, "integrity_digest"> = {
    schema: "openthrottle.skills.lock/v1",
    openthrottle_release: resolved.release,
    upstream_graph: {
      ref: "core/simple@1",
      digest: digest(upstreamGraphRaw),
      scaffold_digest: digest(graphRaw),
    },
    upstream_package_digest: digestCanonicalJson(upstreamFiles),
    upstream_files: upstreamFiles,
    scaffold_package_digest: digestCanonicalJson(scaffoldPackageFiles.map((entry) => ({
      path: entry.path.slice(`${EDITABLE_SKILL_PATH}/`.length),
      digest: entry.digest,
    }))),
    files: scaffoldFiles,
  };
  const lock: EditableSkillsLock = {
    ...lockPayload,
    integrity_digest: digestCanonicalJson(lockPayload),
  };
  files.set(EDITABLE_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  return { files, lock };
}

function classifyEditableFile(
  localDigest: string | null,
  provenanceDigest: string | null,
  upstreamDigest: string
): EditableRefreshStatus {
  if (localDigest === upstreamDigest) return "unchanged";
  if (provenanceDigest === null) return localDigest === null ? "upstream-only" : "conflict";
  if (localDigest === provenanceDigest) return "upstream-only";
  if (upstreamDigest === provenanceDigest) return "local-only";
  return "conflict";
}

function normalizeEditableLockDigestFields(
  local: EditableSkillsLock,
  generated: EditableSkillsLock
): EditableSkillsLock {
  const normalized = structuredClone(local);
  normalized.openthrottle_release = generated.openthrottle_release;
  normalized.upstream_graph.digest = generated.upstream_graph.digest;
  normalized.upstream_graph.scaffold_digest = generated.upstream_graph.scaffold_digest;
  normalized.upstream_package_digest = generated.upstream_package_digest;
  normalized.scaffold_package_digest = generated.scaffold_package_digest;
  normalized.upstream_files = structuredClone(generated.upstream_files);
  normalized.files = structuredClone(generated.files);
  normalized.integrity_digest = generated.integrity_digest;
  return normalized;
}

export function planEditableSkillsRefresh(
  config: ProjectConfig,
  directory = process.cwd(),
  options: Pick<
    WriteProjectConfigOptions,
    "allowConfigOverwrite" | "resources" | "supervisorTaskTimeoutSeconds"
  > = {}
): EditableSkillsRefreshPlan {
  const scaffold = buildEditableSkillsScaffold(
    config,
    options.resources,
    options.supervisorTaskTimeoutSeconds
  );
  const localLockRaw = readRepositoryFile(directory, EDITABLE_LOCK_PATH);
  const localLock = localLockRaw === null ? null : parseEditableSkillsLock(localLockRaw);
  const provenance = new Map(localLock?.files.map((entry) => [entry.path, entry.digest]) ?? []);
  const entries: EditableRefreshEntry[] = [];

  for (const [path, contents] of scaffold.files) {
    if (path === EDITABLE_LOCK_PATH) continue;
    const localRaw = readRepositoryFile(directory, path);
    const localDigest = localRaw === null ? null : digest(localRaw);
    const upstreamDigest = digest(contents);
    const provenanceDigest = provenance.get(path) ?? null;
    let status = classifyEditableFile(localDigest, provenanceDigest, upstreamDigest);
    if (path === ".openthrottle.yml" && options.allowConfigOverwrite && status !== "unchanged") {
      status = "upstream-only";
    }
    entries.push({
      path,
      status,
      provenance_digest: provenanceDigest,
      local_digest: localDigest,
      upstream_digest: upstreamDigest,
    });
  }

  const generatedPaths = new Set(scaffold.files.keys());
  for (const localFile of localEditableSkillFiles(directory)) {
    if (generatedPaths.has(localFile.path)) continue;
    const provenanceDigest = provenance.get(localFile.path) ?? null;
    entries.push({
      path: localFile.path,
      status: provenanceDigest === null
        ? "local-only"
        : localFile.digest === provenanceDigest ? "upstream-only" : "conflict",
      provenance_digest: provenanceDigest,
      local_digest: localFile.digest,
      upstream_digest: null,
    });
  }

  const generatedLockRaw = scaffold.files.get(EDITABLE_LOCK_PATH)!;
  const invalidLockWithCandidateDrift = localLockRaw !== null && localLock === null && entries.some((entry) => (
    entry.upstream_digest !== null && entry.local_digest !== entry.upstream_digest
  ));
  const upstreamChanged = Boolean(
    localLock && (
      localLock.openthrottle_release !== scaffold.lock.openthrottle_release ||
      localLock.upstream_graph.digest !== scaffold.lock.upstream_graph.digest ||
      localLock.upstream_package_digest !== scaffold.lock.upstream_package_digest
    )
  ) || invalidLockWithCandidateDrift || entries.some((entry) => (
    entry.status === "upstream-only" ||
    (entry.upstream_digest !== null && entry.provenance_digest !== null && entry.upstream_digest !== entry.provenance_digest)
  ));
  let lockStatus: EditableRefreshStatus;
  if (localLockRaw === generatedLockRaw) {
    lockStatus = "unchanged";
  } else if (localLockRaw === null) {
    lockStatus = entries.some((entry) => (
      entry.local_digest !== null &&
      !(entry.path === ".openthrottle.yml" && options.allowConfigOverwrite)
    )) ? "conflict" : "upstream-only";
  } else if (
    localLock && upstreamChanged &&
    canonicalJson(normalizeEditableLockDigestFields(localLock, scaffold.lock)) === canonicalJson(scaffold.lock)
  ) {
    lockStatus = "upstream-only";
  } else {
    lockStatus = upstreamChanged ? "conflict" : "local-only";
  }
  entries.push({
    path: EDITABLE_LOCK_PATH,
    status: lockStatus,
    provenance_digest: null,
    local_digest: localLockRaw === null ? null : digest(localLockRaw),
    upstream_digest: digest(generatedLockRaw),
  });

  return {
    entries,
    writable: entries.every((entry) => entry.status === "unchanged" || entry.status === "upstream-only"),
  };
}

export function planEditableSkillsDryRun(
  config: ProjectConfig,
  directory = process.cwd(),
  options: Pick<WriteProjectConfigOptions, "resources" | "supervisorTaskTimeoutSeconds"> = {}
): { plan: EditableSkillsRefreshPlan; assumesConfigOverwrite: boolean } {
  // A real run prompts before overwriting an existing .openthrottle.yml and
  // then plans with allowConfigOverwrite, so the preview must assume the same.
  const assumesConfigOverwrite = existsSync(join(directory, ".openthrottle.yml"));
  const plan = planEditableSkillsRefresh(config, directory, {
    ...options,
    allowConfigOverwrite: assumesConfigOverwrite,
  });
  return { plan, assumesConfigOverwrite };
}

function writeEditableSkillsScaffold(
  config: ProjectConfig,
  directory: string,
  options: WriteProjectConfigOptions
): void {
  const scaffold = buildEditableSkillsScaffold(
    config,
    options.resources,
    options.supervisorTaskTimeoutSeconds
  );
  const plan = planEditableSkillsRefresh(config, directory, options);
  if (!plan.writable) {
    const collisions = plan.entries
      .filter((entry) => entry.status === "local-only" || entry.status === "conflict")
      .map((entry) => `${entry.path} (${entry.status})`)
      .join(", ");
    throw new Error(`editable-skills refresh refused repository edits: ${collisions}`);
  }

  const writes = plan.entries.filter((entry) => entry.status === "upstream-only");
  const backups = new Map<string, string | null>();
  const staged = new Map<string, string>();
  try {
    for (const entry of writes) {
      const target = join(directory, entry.path);
      backups.set(target, readRepositoryFile(directory, entry.path));
      const contents = scaffold.files.get(entry.path);
      if (contents === undefined) continue;
      mkdirSync(dirname(target), { recursive: true });
      assertSafeRepositoryPath(directory, entry.path);
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeFileSync(temporary, contents, { flag: "wx" });
      staged.set(target, temporary);
    }
    for (const [target, temporary] of staged) renameSync(temporary, target);
    for (const entry of writes) {
      if (!scaffold.files.has(entry.path)) rmSync(join(directory, entry.path), { force: true });
    }
  } catch (error) {
    for (const [target, original] of backups) {
      if (original === null) rmSync(target, { force: true });
      else writeFileSync(target, original);
    }
    for (const temporary of staged.values()) rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeProjectConfig(
  config: ProjectConfig,
  directory = process.cwd(),
  options: WriteProjectConfigOptions = {}
): void {
  if (options.editableSkills) {
    writeEditableSkillsScaffold(config, directory, options);
    return;
  }
  writeFileSync(join(directory, ".openthrottle.yml"), renderProjectConfig(config));
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

export async function getSupervisorTaskTimeoutSeconds(
  request: typeof supervisorRequest = supervisorRequest
): Promise<number> {
  const response = await request("/capabilities");
  const body = (await response.json()) as {
    error?: string;
    limits?: { taskTimeoutSeconds?: unknown };
  };
  if (!response.ok) throw new Error(body.error ?? `Supervisor returned HTTP ${response.status}`);
  const timeout = body.limits?.taskTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("Supervisor returned an invalid task timeout capability");
  }
  return timeout;
}

export function editableSkillsRefreshSummary(plan: EditableSkillsRefreshPlan): string[] {
  return plan.entries.map((entry) => `${entry.status.padEnd(13)} ${entry.path}`);
}

export default async function init(args: string[] = []): Promise<void> {
  const unknown = args.filter((arg) => arg !== "--editable-skills" && arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown init option: ${unknown.join(", ")}`);
  const editableSkills = args.includes("--editable-skills");
  const dryRun = args.includes("--dry-run");
  if (dryRun && !editableSkills) {
    throw new Error("--dry-run is available only with --editable-skills");
  }
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

  let supervisorTaskTimeoutSeconds: number | undefined;
  if (editableSkills) {
    supervisorTaskTimeoutSeconds = await getSupervisorTaskTimeoutSeconds();
  }
  if (dryRun) {
    const { plan, assumesConfigOverwrite } = planEditableSkillsDryRun(selection.project, process.cwd(), {
      supervisorTaskTimeoutSeconds,
    });
    if (assumesConfigOverwrite) {
      p.log.info(
        ".openthrottle.yml already exists; a real run prompts before overwriting it, so this preview assumes overwrite."
      );
    }
    for (const line of editableSkillsRefreshSummary(plan)) p.log.info(line);
    p.outro(plan.writable
      ? "Dry run only: the editable-skill refresh can be applied safely; no files or registrations changed."
      : "Dry run only: local edits or conflicts block refresh; no files or registrations changed.");
    return;
  }

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
      if (editableSkills) {
        const plan = planEditableSkillsRefresh(selection.project, process.cwd(), {
          allowConfigOverwrite: true,
          supervisorTaskTimeoutSeconds,
        });
        for (const line of editableSkillsRefreshSummary(plan)) p.log.info(line);
        if (!plan.writable) throw new Error("Editable-skill refresh has local edits or conflicts; no files changed");
        const apply = await p.confirm({
          message: "Apply the listed editable-skill scaffold and provenance updates?",
          initialValue: false,
        });
        if (p.isCancel(apply) || !apply) {
          p.cancel("Cancelled. No repository was registered and no files were changed.");
          return;
        }
      }
      writeProjectConfig(selection.project, process.cwd(), {
        editableSkills,
        allowConfigOverwrite: true,
        supervisorTaskTimeoutSeconds,
      });
      p.log.success(editableSkills
        ? "Wrote .openthrottle.yml and editable simple-pipeline skills"
        : "Wrote .openthrottle.yml");
    }
  } else {
    if (editableSkills) {
      const plan = planEditableSkillsRefresh(selection.project, process.cwd(), {
        supervisorTaskTimeoutSeconds,
      });
      for (const line of editableSkillsRefreshSummary(plan)) p.log.info(line);
      if (!plan.writable) throw new Error("Editable-skill refresh has local edits or conflicts; no files changed");
      const apply = await p.confirm({
        message: "Apply the listed editable-skill scaffold and provenance updates?",
        initialValue: false,
      });
      if (p.isCancel(apply) || !apply) {
        p.cancel("Cancelled. No repository was registered and no files were changed.");
        return;
      }
    }
    writeProjectConfig(selection.project, process.cwd(), {
      editableSkills,
      supervisorTaskTimeoutSeconds,
    });
    p.log.success(editableSkills
      ? "Wrote .openthrottle.yml and editable simple-pipeline skills"
      : "Wrote .openthrottle.yml");
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
  p.outro(initOutro(selection.registration, editableSkills));
}
