import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import {
  validateFilesystemConfigContract,
  type Engine,
  type FilesystemConfigContract,
} from "@openthrottle/contracts";
import { stringify } from "yaml";
import { SUPERVISOR_SECRET_CHECKLIST } from "./setup.js";
import { assertProfileName } from "./onboarding/profile-store.js";
import {
  defaultSupervisorAccessRoot,
  LocalSupervisorAccessStore,
  type SupervisorAccessReader,
} from "./onboarding/supervisor-access-store.js";
import {
  runOperatorSkillAction,
  runPlanningSkillAction,
  type OperatorSkillOptions,
  type OperatorSkillResult,
} from "./operator-skill.js";
import { getErrorMessage, readEnv, supervisorRequest } from "./util.js";

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

export interface DetectedProject {
  pm: "npm" | "pnpm" | "yarn" | null;
  test: string;
  build: string;
  lint: string;
}

export interface ProjectConfig {
  pipeline?: string;
  engine: Engine;
  model?: string;
  reasoning_effort?: FilesystemConfigContract["reasoning_effort"];
  commands?: Record<string, string>;
  post_bootstrap?: string[];
  limits?: FilesystemConfigContract["limits"];
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

export interface LocalSkillInstallResult {
  name: "openthrottle" | "ot-plan";
  result: OperatorSkillResult;
}

export type SupervisorPreflightResult =
  | { status: "ready" }
  | { status: "not-configured" | "unreachable" | "authentication-failed"; message: string };

type SupervisorPreflightFailure = Extract<SupervisorPreflightResult, { message: string }>;

export interface InitCommandOptions {
  request?: typeof supervisorRequest;
  env?: Record<string, string | undefined>;
  detectRepository?: typeof detectRepository;
  detectProject?: typeof detectProject;
  promptConfig?: typeof promptConfig;
  registerTargetRepository?: typeof registerTargetRepository;
  reportPreflightFailure?: (message: string) => void;
  supervisorAccessStore?: SupervisorAccessReader;
  installLocalSkills?: () => LocalSkillInstallResult[];
}

export interface WriteProjectConfigOptions {
  allowConfigOverwrite?: boolean;
  createStarterDirectories?: boolean;
}

type InitPromptApi = Pick<typeof p, "group" | "select" | "text">;

const DEFAULT_PIPELINE = "core/implement";
const DEFINITION_DIRECTORIES = ["agents", "pipelines", "skills", "evals"] as const;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export function detectPackageManager(
  pkg: PackageJson,
  directory = process.cwd(),
): "npm" | "pnpm" | "yarn" {
  if (pkg.packageManager?.startsWith("pnpm")) return "pnpm";
  if (pkg.packageManager?.startsWith("yarn")) return "yarn";
  if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(directory, "yarn.lock"))) return "yarn";
  return "npm";
}

export function detectProject(directory = process.cwd()): DetectedProject {
  const packagePath = join(directory, "package.json");
  if (!existsSync(packagePath)) return { pm: null, test: "", build: "", lint: "" };
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(pkg, directory);
  const run = (script: string): string => scripts[script] ? `${pm} run ${script}` : "";
  return { pm, test: run("test"), build: run("build"), lint: run("lint") };
}

export function parseGithubRemote(remote: string): string {
  const value = remote.trim().replace(/\.git$/, "");
  const match =
    value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i) ??
    value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) ??
    value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match?.[1] || !match[2]) throw new Error("origin must point to a GitHub repository");
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
    baseBranch = git(directory, ["symbolic-ref", "refs/remotes/origin/HEAD"])
      .replace(/^refs\/remotes\/origin\//, "") || undefined;
  } catch {
    try {
      git(directory, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      try {
        baseBranch = git(directory, ["branch", "--show-current"]) || undefined;
      } catch {
        // GitHub supplies the canonical default branch when the local checkout cannot.
      }
    }
  }
  return { repo: parseGithubRemote(remote), baseBranch };
}

export function registrationSummary(
  registration: RepositoryRegistrationInput,
  supervisorUrl?: string,
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

export function initOutro(registration: RepositoryRegistrationInput): string {
  const delegation = registration.controlProvider === "linear"
    ? "delegate an issue from the configured Linear team"
    : "open or label a GitHub issue with `openthrottle`";
  return `Commit .openthrottle/config.yml, then ${delegation}.`;
}

export function installLocalSkills(options: OperatorSkillOptions = {}): LocalSkillInstallResult[] {
  const installs: LocalSkillInstallResult[] = [
    { name: "openthrottle", result: runOperatorSkillAction("install", options) },
    { name: "ot-plan", result: runPlanningSkillAction("install", options) },
  ];
  for (const install of installs) {
    if (!install.result.success && install.result.recovery.length === 0) {
      install.result.recovery.push(
        install.name === "openthrottle"
          ? "openthrottle operator-skill install"
          : "openthrottle planning-skill install",
      );
    }
  }
  return installs;
}

export function localSkillInstallSummary(installs: LocalSkillInstallResult[]): string[] {
  const lines: string[] = [];
  for (const { name, result } of installs) {
    for (const entry of result.installed) lines.push(`${name}: installed for ${entry.agent} at ${entry.path}`);
    for (const entry of result.skipped) lines.push(`${name}: ${entry.reason ?? entry.status} for ${entry.agent}`);
    for (const entry of result.unsupported) lines.push(`${name}: unavailable for ${entry.agent} (${entry.reason ?? "unsupported"})`);
    for (const entry of result.conflicted) lines.push(`${name}: attention required for ${entry.agent} (${entry.reason ?? "conflict"})`);
    for (const recovery of result.recovery) lines.push(`${name}: recovery: ${recovery}`);
  }
  return lines;
}

export async function promptConfig(
  detected: DetectedProject,
  target: RepositoryTarget,
  prompts: InitPromptApi = p,
): Promise<InitSelection> {
  const result = await prompts.group(
    {
      controlProvider: () => prompts.select<ControlProvider>({
        message: "Control provider",
        options: [
          { value: "linear", label: "Linear" },
          { value: "github", label: "GitHub Issues" },
        ],
        initialValue: "linear",
      }),
      linearTeamKey: ({ results }) => results.controlProvider === "linear" ? prompts.text({
        message: "Linear team key routed to this repository",
        initialValue: readEnv("LINEAR_TEAM_KEY") ?? "",
        validate: (value) => /^[A-Za-z0-9_-]+$/.test(value) ? undefined : "Enter a team key",
      }) : undefined,
      linearTeamId: ({ results }) => results.controlProvider === "linear" ? prompts.text({
        message: "Linear team ID (optional, but recommended)",
        initialValue: readEnv("LINEAR_TEAM_ID") ?? "",
      }) : undefined,
      baseBranch: () => prompts.text({
        message: "Base branch (blank uses GitHub default)",
        initialValue: target.baseBranch ?? "",
      }),
      pipeline: () => prompts.text({
        message: "Pipeline",
        initialValue: DEFAULT_PIPELINE,
        validate: (value) => /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/.test(value)
          ? undefined
          : "Enter a pipeline ID",
      }),
      engine: () => prompts.select<Engine>({
        message: "Default engine",
        options: [
          { value: "codex", label: "Codex CLI" },
          { value: "claude", label: "Claude Code" },
          { value: "opencode", label: "OpenCode (Kimi Code)" },
        ],
        initialValue: "codex",
      }),
      model: ({ results }) => {
        const engine = results.engine as Engine | undefined;
        return prompts.text({
          message: "Model (blank uses the engine default; required for OpenCode)",
          initialValue: engine === "opencode" ? "kimi-code/kimi-for-coding" : "",
          validate: (value) => {
            const trimmed = value.trim();
            if (engine === "opencode" && !trimmed) return "OpenCode requires a model";
            return trimmed && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)
              ? "Model may contain letters, digits, and . _ / - only"
              : undefined;
          },
        });
      },
      test: () => prompts.text({
        message: "Test command",
        initialValue: detected.test,
        validate: (value) => value.trim() ? undefined : "Enter the test command",
      }),
      build: () => prompts.text({
        message: "Build command",
        initialValue: detected.build,
        validate: (value) => value.trim() ? undefined : "Enter the build command",
      }),
      lint: () => prompts.text({
        message: "Lint command",
        initialValue: detected.lint,
        validate: (value) => value.trim() ? undefined : "Enter the lint command",
      }),
      post_bootstrap: () => prompts.text({
        message: "Post-bootstrap command (blank to skip)",
        initialValue: detected.pm ? `${detected.pm} install` : "",
      }),
      max_turns: ({ results }) => results.engine === "claude"
        ? prompts.text({ message: "Max turns per agent run", initialValue: "200" })
        : undefined,
      task_timeout: () => prompts.text({ message: "Task timeout (seconds)", initialValue: "7200" }),
    },
    {
      onCancel: () => {
        p.cancel("Cancelled.");
        process.exit(0);
      },
    },
  );

  if (result.controlProvider !== "linear" && result.controlProvider !== "github") {
    throw new Error("Control provider selection is required");
  }
  const registration: RepositoryRegistrationInput = result.controlProvider === "linear"
    ? {
        repo: target.repo,
        baseBranch: result.baseBranch || undefined,
        controlProvider: "linear",
        linearTeamKey: String(result.linearTeamKey).toUpperCase(),
        ...(result.linearTeamId ? { linearTeamId: String(result.linearTeamId) } : {}),
      }
    : {
        repo: target.repo,
        baseBranch: result.baseBranch || undefined,
        controlProvider: "github",
      };
  const model = typeof result.model === "string" ? result.model.trim() : "";
  const engine = result.engine as Engine;
  return {
    project: {
      pipeline: String(result.pipeline || DEFAULT_PIPELINE),
      engine,
      ...(model ? { model } : {}),
      commands: {
        test: String(result.test),
        lint: String(result.lint),
        build: String(result.build),
      },
      post_bootstrap: result.post_bootstrap ? [String(result.post_bootstrap)] : [],
      limits: {
        ...(engine === "claude" ? { max_turns: Number(result.max_turns) || 200 } : {}),
        task_timeout: Number(result.task_timeout) || 7_200,
      },
    },
    registration,
  };
}

export function projectConfigDocument(config: ProjectConfig): FilesystemConfigContract {
  return validateFilesystemConfigContract({
    schema: "openthrottle.config/v2",
    pipeline: config.pipeline ?? DEFAULT_PIPELINE,
    engine: config.engine,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoning_effort === undefined ? {} : { reasoning_effort: config.reasoning_effort }),
    ...(config.commands === undefined ? {} : { commands: config.commands }),
    ...(config.post_bootstrap === undefined ? {} : { post_bootstrap: config.post_bootstrap }),
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  }, { source: ".openthrottle/config.yml" }).value;
}

export function renderProjectConfig(config: ProjectConfig): string {
  return [
    "# .openthrottle/config.yml — repository definitions for OpenThrottle",
    "# Generated by `openthrottle init`; commit this file before validation or shipping.",
    "",
    stringify(projectConfigDocument(config)).trimEnd(),
    "",
  ].join("\n");
}

function assertDefinitionRoot(directory: string): string {
  const repositoryRoot = resolve(directory);
  const rootStat = lstatSync(repositoryRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("repository root must be a real directory");
  }
  const definitionRoot = join(repositoryRoot, ".openthrottle");
  const definitionStat = lstatSync(definitionRoot, { throwIfNoEntry: false });
  if (definitionStat?.isSymbolicLink() || (definitionStat && !definitionStat.isDirectory())) {
    throw new Error(".openthrottle must be a real directory");
  }
  return definitionRoot;
}

export function writeProjectConfig(
  config: ProjectConfig,
  directory = process.cwd(),
  options: WriteProjectConfigOptions = {},
): void {
  const definitionRoot = assertDefinitionRoot(directory);
  const configPath = join(definitionRoot, "config.yml");
  const existing = lstatSync(configPath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(".openthrottle/config.yml must be a regular file");
  }
  if (existing && !options.allowConfigOverwrite) {
    throw new Error(".openthrottle/config.yml already exists");
  }
  mkdirSync(definitionRoot, { recursive: true });
  if (options.createStarterDirectories !== false) {
    for (const name of DEFINITION_DIRECTORIES) mkdirSync(join(definitionRoot, name), { recursive: true });
  }
  writeFileSync(configPath, renderProjectConfig(config));
}

export type RepositoryWebhookAction = "created" | "updated" | "unchanged";

export interface RepositoryRegistrationResult {
  registration: { github_repo: string; base_branch: string };
  readiness: {
    github: "ready";
    webhook: RepositoryWebhookAction;
    snapshot: { name: string; state: string };
  };
}

function isRepositoryRegistrationResult(value: unknown): value is RepositoryRegistrationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!input.registration || typeof input.registration !== "object" || Array.isArray(input.registration)) return false;
  if (!input.readiness || typeof input.readiness !== "object" || Array.isArray(input.readiness)) return false;
  const registration = input.registration as Record<string, unknown>;
  const readiness = input.readiness as Record<string, unknown>;
  if (!readiness.snapshot || typeof readiness.snapshot !== "object" || Array.isArray(readiness.snapshot)) return false;
  const snapshot = readiness.snapshot as Record<string, unknown>;
  return typeof registration.github_repo === "string" &&
    typeof registration.base_branch === "string" &&
    readiness.github === "ready" &&
    (readiness.webhook === "created" || readiness.webhook === "updated" || readiness.webhook === "unchanged") &&
    typeof snapshot.name === "string" && typeof snapshot.state === "string";
}

export async function registerTargetRepository(
  input: RepositoryRegistrationInput,
  request: typeof supervisorRequest = supervisorRequest,
): Promise<RepositoryRegistrationResult> {
  const response = await request("/repositories/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const error = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).error
      : undefined;
    throw new Error(typeof error === "string" ? error : `Supervisor returned HTTP ${response.status}`);
  }
  if (!isRepositoryRegistrationResult(body)) {
    throw new Error("Supervisor returned an invalid repository registration response");
  }
  return body;
}

function supervisorCredentialName(checklistName: "SUPERVISOR_URL" | "OT_STATUS_TOKEN"): string {
  const entry = SUPERVISOR_SECRET_CHECKLIST.find(({ name }) => name === checklistName);
  if (!entry) throw new Error(`Supervisor setup checklist is missing ${checklistName}`);
  return checklistName === "SUPERVISOR_URL" ? `OT_${entry.name}` : entry.name;
}

function isHealthResponse(value: unknown): value is { ok: true } {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true;
}

function isCapabilitiesResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.release !== "string" || !input.release.trim()) return false;
  if (typeof input.capabilityDigest !== "string" || !SHA256_DIGEST.test(input.capabilityDigest)) return false;
  if (!Array.isArray(input.capabilities) ||
    input.capabilities.some((capability) => typeof capability !== "string" || !capability.trim())) return false;
  if (!input.limits || typeof input.limits !== "object" || Array.isArray(input.limits)) return false;
  const timeout = (input.limits as Record<string, unknown>).taskTimeoutSeconds;
  return typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 1;
}

const SUPERVISOR_PREFLIGHT_CHECKS = [
  { path: "/healthz", label: "health", validate: isHealthResponse },
  { path: "/capabilities", label: "capabilities", validate: isCapabilitiesResponse },
] as const;

function unreachableSupervisor(message: string): SupervisorPreflightFailure {
  return {
    status: "unreachable",
    message: `${message} Run \`openthrottle setup --check\` to diagnose deployment readiness.`,
  };
}

async function resolveSupervisorEnv(
  env: Record<string, string | undefined>,
  accessStore: SupervisorAccessReader,
  profileName: string,
): Promise<Record<string, string | undefined>> {
  const supervisorUrl = env.OT_SUPERVISOR_URL?.trim();
  const statusToken = env.OT_STATUS_TOKEN?.trim();
  if (supervisorUrl || statusToken) return env;
  const access = await accessStore.load(profileName);
  return access ? {
    ...env,
    OT_SUPERVISOR_URL: access.supervisorUrl,
    OT_STATUS_TOKEN: access.statusToken,
  } : env;
}

export function parseInitArgs(args: string[]): { dryRun: boolean; profile: string } {
  let profile = "default";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--profile requires a profile name");
      assertProfileName(value);
      profile = value;
      index += 1;
    } else {
      throw new Error(`Unknown init option: ${arg}`);
    }
  }
  return { dryRun, profile };
}

export async function preflightSupervisor(
  request: typeof supervisorRequest = supervisorRequest,
  env: Record<string, string | undefined> = process.env,
): Promise<SupervisorPreflightResult> {
  const supervisorUrlName = supervisorCredentialName("SUPERVISOR_URL");
  const statusTokenName = supervisorCredentialName("OT_STATUS_TOKEN");
  const supervisorUrl = env[supervisorUrlName]?.trim();
  const statusToken = env[statusTokenName]?.trim();
  if (!supervisorUrl || !statusToken) {
    return {
      status: "not-configured",
      message: "Supervisor access is not configured. Operators should run `openthrottle setup`; " +
        `to join an existing deployment, export ${supervisorUrlName} and ${statusTokenName}.`,
    };
  }
  try {
    for (const { path, label, validate } of SUPERVISOR_PREFLIGHT_CHECKS) {
      const response = await request(path);
      if (response.status === 401) {
        return {
          status: "authentication-failed",
          message: `Supervisor authentication failed: ${statusTokenName} does not match the deployed supervisor.`,
        };
      }
      if (!response.ok) return unreachableSupervisor(`Supervisor ${label} check failed with HTTP ${response.status}.`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return unreachableSupervisor(`Supervisor returned an invalid ${label} response.`);
      }
      if (!validate(body)) return unreachableSupervisor(`Supervisor returned an invalid ${label} response.`);
    }
    return { status: "ready" };
  } catch (error) {
    return unreachableSupervisor(`Supervisor is unreachable (${getErrorMessage(error)}).`);
  }
}

export default async function init(args: string[] = [], options: InitCommandOptions = {}): Promise<void> {
  const { dryRun, profile } = parseInitArgs(args);
  p.intro("openthrottle init");
  const env = options.env ?? process.env;
  const accessStore = options.supervisorAccessStore ??
    new LocalSupervisorAccessStore(defaultSupervisorAccessRoot(env));
  let resolvedEnv: Record<string, string | undefined>;
  try {
    resolvedEnv = await resolveSupervisorEnv(env, accessStore, profile);
  } catch (error) {
    const setupCommand = profile === "default" ? "openthrottle setup" : `openthrottle setup --profile ${profile}`;
    (options.reportPreflightFailure ?? ((message) => p.log.error(message)))(
      `Stored supervisor access for profile ${profile} is invalid (${getErrorMessage(error)}). ` +
      `Fix or remove that access document, then run \`${setupCommand}\`.`,
    );
    process.exitCode = 1;
    return;
  }
  const request = options.request ?? ((path, requestInit) => supervisorRequest(path, requestInit, resolvedEnv));
  const preflight = await preflightSupervisor(request, resolvedEnv);
  if (preflight.status !== "ready") {
    (options.reportPreflightFailure ?? ((message) => p.log.error(message)))(preflight.message);
    process.exitCode = 1;
    return;
  }

  let detected: DetectedProject;
  let target: RepositoryTarget;
  try {
    target = (options.detectRepository ?? detectRepository)();
    detected = (options.detectProject ?? detectProject)();
  } catch (error) {
    p.log.error(getErrorMessage(error));
    process.exit(1);
  }
  p.log.info(`Target repository: ${target.repo} (${target.baseBranch ?? "GitHub default branch"})`);
  p.log.info(detected.pm
    ? `Detected package manager: ${detected.pm}`
    : "No Node package detected; enter project commands manually.");

  const selection = await (options.promptConfig ?? promptConfig)(detected, target);
  const configPath = join(process.cwd(), ".openthrottle", "config.yml");
  let allowConfigOverwrite = false;
  if (existsSync(configPath)) {
    if (dryRun) {
      p.log.info(".openthrottle/config.yml exists; a real run prompts before replacing it.");
    } else {
      const overwrite = await p.confirm({
        message: ".openthrottle/config.yml already exists. Replace it?",
        initialValue: false,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel("Cancelled. Existing definitions were kept; no repository was registered.");
        return;
      }
      allowConfigOverwrite = true;
    }
  }

  if (dryRun) {
    projectConfigDocument(selection.project);
    p.outro("Dry run only: would write .openthrottle/config.yml; no files or registrations changed.");
    return;
  }

  p.log.warn(
    "The target repository was auto-detected from this directory's git origin. " +
    "If it is wrong, cancel and re-run `openthrottle init` from the correct repository checkout.",
  );
  const proceed = await p.confirm({
    message: `Initialize ${registrationSummary(selection.registration, resolvedEnv.OT_SUPERVISOR_URL)} and install local OpenThrottle skills?`,
    initialValue: false,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled. No repository was registered and no files were changed.");
    return;
  }

  writeProjectConfig(selection.project, process.cwd(), { allowConfigOverwrite });
  p.log.success("Wrote .openthrottle/config.yml");

  p.log.info("Installing local OpenThrottle skills for detected agents");
  const localSkills = (options.installLocalSkills ?? installLocalSkills)();
  for (const line of localSkillInstallSummary(localSkills)) p.log.info(line);
  if (localSkills.some(({ result }) => !result.success)) {
    p.log.error("Local OpenThrottle skill installation needs attention.");
    p.log.warn("The local definition config is ready, but the repository was not registered. Apply the recovery command above, then rerun init.");
    process.exit(1);
  }

  const spinner = p.spinner();
  spinner.start("Registering repository and checking readiness");
  let result: RepositoryRegistrationResult;
  try {
    result = await (options.registerTargetRepository ?? registerTargetRepository)(selection.registration, request);
  } catch (error) {
    spinner.stop("Repository registration failed");
    p.log.error(getErrorMessage(error));
    p.log.warn("The local definition config is ready; rerun init after fixing supervisor access.");
    process.exit(1);
  }
  if (result.readiness.snapshot.state.toLowerCase() !== "active") {
    spinner.stop("Repository registered, but platform readiness failed");
    p.log.error(
      `Platform snapshot not ready — run \`openthrottle setup\` (Daytona snapshot ${result.readiness.snapshot.name} is ${result.readiness.snapshot.state}).`,
    );
    process.exitCode = 1;
    return;
  }
  spinner.stop(`Registered ${result.registration.github_repo} on ${result.registration.base_branch}`);
  p.log.success(
    `GitHub webhook ${result.readiness.webhook}; Daytona snapshot ${result.readiness.snapshot.name} is ${result.readiness.snapshot.state}.`,
  );
  p.outro(initOutro(selection.registration));
}
