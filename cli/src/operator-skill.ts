import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getErrorMessage } from "./util.js";

const OWNER = "knoxgraeme";
const REPO = "openthrottle-v2";
const SKILL_PATH = "skills/operator/openthrottle";
const SKILL_NAME = "openthrottle";
const SUPPORTED_AGENTS = ["Claude Code", "Codex", "OpenCode"] as const;
const AGENT_ROOTS: Record<SupportedAgent, string> = {
  "Claude Code": ".claude",
  Codex: ".codex",
  OpenCode: ".opencode",
};
const AGENT_SKILL_DIRS: Record<SupportedAgent, string> = {
  "Claude Code": ".claude/skills",
  Codex: ".codex/skills",
  OpenCode: ".config/opencode/skills",
};
const OPENCODE_CONFIG_ROOT = ".config/opencode";

type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];
type OperatorSkillAction = "install" | "status" | "refresh" | "remove";
type OperatorSkillStatus = "installed" | "skipped" | "conflicted" | "unsupported" | "removed";

export interface SkillfishInstalledSkill {
  skill?: unknown;
  agent?: unknown;
  path?: unknown;
  location?: unknown;
}

export interface SkillfishJson {
  success?: unknown;
  exit_code?: unknown;
  errors?: unknown;
  installed?: unknown;
  skipped?: unknown;
  removed?: unknown;
  agents_detected?: unknown;
}

export interface OperatorSkillAgentResult {
  agent: SupportedAgent;
  status: OperatorSkillStatus;
  path?: string;
  reason?: string;
}

export interface OperatorSkillResult {
  schema: "openthrottle.operator-skill/v1";
  action: OperatorSkillAction;
  success: boolean;
  source: string;
  source_ref: string;
  source_digest: string;
  installed: OperatorSkillAgentResult[];
  skipped: OperatorSkillAgentResult[];
  conflicted: OperatorSkillAgentResult[];
  removed: OperatorSkillAgentResult[];
  unsupported: OperatorSkillAgentResult[];
  recovery: string[];
}

type SkillfishRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => SpawnSyncReturns<Buffer>;

interface OperatorSkillOptions {
  runner?: SkillfishRunner;
  cwd?: string;
  home?: string;
  sourceRef?: string;
}

interface OwnedInstall {
  agent: SupportedAgent;
  path: string;
  exact: boolean;
  digestMatches: boolean;
  reason?: string;
}

interface SkillManifest {
  owner?: unknown;
  repo?: unknown;
  path?: unknown;
  source?: unknown;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function sanitizeError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/(ghp_|github_pat_|sk-|lin_api_)[A-Za-z0-9_./=-]+/g, "$1<redacted>");
}

function isSupportedAgent(agent: string): agent is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(agent);
}

function immutableRef(ref: string): boolean {
  return /^[a-f0-9]{40}$/i.test(ref) || /^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/.test(ref);
}

function gitHead(directory: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /^[a-f0-9]{40}$/i.test(sha) ? sha : undefined;
}

export function resolveOperatorSkillSourceRef(options: { sourceRef?: string; moduleUrl?: string } = {}): string {
  const explicit = options.sourceRef?.trim() || process.env.OT_OPERATOR_SKILL_SOURCE_REF?.trim();
  if (explicit) {
    if (!immutableRef(explicit)) throw new Error(`operator skill source ref is not immutable: ${explicit}`);
    return explicit;
  }

  const currentModuleDirectory = options.moduleUrl
    ? dirname(fileURLToPath(options.moduleUrl))
    : moduleDirectory;
  const metadataPath = join(currentModuleDirectory, "operator-skill-source.json");
  if (existsSync(metadataPath)) {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as { source_ref?: unknown; source_unavailable_reason?: unknown };
    if (typeof parsed.source_ref === "string" && immutableRef(parsed.source_ref)) return parsed.source_ref;
    if (typeof parsed.source_unavailable_reason === "string") {
      throw new Error(parsed.source_unavailable_reason);
    }
  }

  const sourceCheckout = resolve(currentModuleDirectory, "..", "..");
  const sha = gitHead(sourceCheckout);
  if (sha) return sha;

  throw new Error("operator skill source ref is unavailable; rebuild with git metadata or set OT_OPERATOR_SKILL_SOURCE_REF");
}

export function operatorSkillSource(sourceRef: string): string {
  return `${OWNER}/${REPO}@${sourceRef}/${SKILL_PATH}`;
}

export function resolveOperatorSkillBundlePath(moduleUrl = import.meta.url): string {
  const currentModuleDirectory = dirname(fileURLToPath(moduleUrl));
  const packaged = join(currentModuleDirectory, "skills", "operator", SKILL_NAME, "SKILL.md");
  if (existsSync(packaged)) return dirname(packaged);
  return resolve(currentModuleDirectory, "..", "..", "skills", "operator", SKILL_NAME);
}

function digestDirectory(root: string): string {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`operator skill bundle is not a real directory: ${root}`);
  }
  const hash = createHash("sha256");
  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryAbsolute = join(absolute, entry.name);
      if (entryRelative === ".skillfish.json") continue;
      if (entry.isSymbolicLink()) throw new Error(`operator skill bundle must not contain symlinks: ${entryRelative}`);
      if (entry.isDirectory()) {
        visit(entryAbsolute, entryRelative);
      } else if (entry.isFile()) {
        hash.update(entryRelative);
        hash.update("\0");
        hash.update(readFileSync(entryAbsolute));
        hash.update("\0");
      } else {
        throw new Error(`operator skill bundle contains a non-regular entry: ${entryRelative}`);
      }
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

export function operatorSkillBundleDigest(): string {
  return digestDirectory(resolveOperatorSkillBundlePath());
}

function resolveSkillfishBin(): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("skillfish/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: { skillfish?: string } };
  const bin = pkg.bin?.skillfish;
  if (!bin) throw new Error("skillfish package does not declare a skillfish binary");
  return resolve(dirname(packagePath), bin);
}

function defaultRunner(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnSyncReturns<Buffer> {
  return spawnSync(process.execPath, [resolveSkillfishBin(), ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function safeSkillfishEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    CI: "1",
    DO_NOT_TRACK: "1",
  };
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "TMPDIR", "TZ"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function linkAgentRoot(tempHome: string, realHome: string, relative: string): boolean {
  const realPath = join(realHome, relative);
  if (!existsSync(realPath)) return false;
  const tempPath = join(tempHome, relative);
  mkdirSync(dirname(tempPath), { recursive: true });
  symlinkSync(realPath, tempPath, "dir");
  return true;
}

function linkIfPresent(tempHome: string, realHome: string, relative: string): boolean {
  const realPath = join(realHome, relative);
  if (!existsSync(realPath)) return false;
  const tempPath = join(tempHome, relative);
  mkdirSync(dirname(tempPath), { recursive: true });
  symlinkSync(realPath, tempPath, "dir");
  return true;
}

function prepareSkillfishHome(realHome: string, agents?: SupportedAgent[]): string {
  const tempHome = mkdtempSync(join(tmpdir(), "openthrottle-skillfish-"));
  const allowed = new Set<SupportedAgent>(agents ?? SUPPORTED_AGENTS);
  for (const agent of allowed) {
    linkAgentRoot(tempHome, realHome, AGENT_ROOTS[agent]);
  }
  if (allowed.has("OpenCode")) {
    linkIfPresent(tempHome, realHome, OPENCODE_CONFIG_ROOT);
  }
  return tempHome;
}

function prepareSkillfishStagingHome(agents: SupportedAgent[]): string {
  const tempHome = mkdtempSync(join(tmpdir(), "openthrottle-skillfish-stage-"));
  for (const agent of agents) {
    mkdirSync(join(tempHome, AGENT_ROOTS[agent]), { recursive: true });
    if (agent === "OpenCode") mkdirSync(join(tempHome, OPENCODE_CONFIG_ROOT), { recursive: true });
  }
  return tempHome;
}

function operatorSkillTargetPath(home: string, agent: SupportedAgent): string {
  return resolve(home, AGENT_SKILL_DIRS[agent], SKILL_NAME);
}

function stagedOperatorSkillPath(home: string, agent: SupportedAgent): string {
  return resolve(home, AGENT_ROOTS[agent], "skills", SKILL_NAME);
}

interface StagedSkillOperation {
  agent: SupportedAgent;
  sourcePath: string;
  targetPath: string;
  tempTarget: string;
  backupTarget: string;
  replace: boolean;
  backupCreated: boolean;
  targetInstalled: boolean;
}

function installStagedSkillsAtomically(
  staged: Map<SupportedAgent, string>,
  home: string,
  needsReplace: Set<SupportedAgent>
): OperatorSkillAgentResult[] {
  const nonce = `${process.pid}.${Date.now()}`;
  const operations: StagedSkillOperation[] = [...staged].map(([agent, sourcePath], index) => {
    const targetPath = operatorSkillTargetPath(home, agent);
    const targetParent = dirname(targetPath);
    return {
      agent,
      sourcePath,
      targetPath,
      tempTarget: join(targetParent, `.openthrottle.tmp.${nonce}.${index}`),
      backupTarget: join(targetParent, `.openthrottle.backup.${nonce}.${index}`),
      replace: needsReplace.has(agent),
      backupCreated: false,
      targetInstalled: false,
    };
  });

  try {
    // Prepare every destination before changing any installed skill. This makes
    // ordinary path/copy failures fail closed without a partial multi-agent install.
    for (const operation of operations) {
      if (!existsSync(join(operation.sourcePath, "SKILL.md"))) {
        throw new Error(`staged OpenThrottle skill is missing SKILL.md: ${operation.sourcePath}`);
      }
      mkdirSync(dirname(operation.targetPath), { recursive: true });
      const target = lstatSync(operation.targetPath, { throwIfNoEntry: false });
      if (operation.replace ? !target : Boolean(target)) {
        throw new Error(
          operation.replace
            ? `OpenThrottle skill target disappeared before refresh: ${operation.targetPath}`
            : `OpenThrottle skill target already exists: ${operation.targetPath}`
        );
      }
      rmSync(operation.tempTarget, { recursive: true, force: true });
      rmSync(operation.backupTarget, { recursive: true, force: true });
      cpSync(operation.sourcePath, operation.tempTarget, { recursive: true });
    }

    for (const operation of operations) {
      if (operation.replace) {
        renameSync(operation.targetPath, operation.backupTarget);
        operation.backupCreated = true;
      }
      renameSync(operation.tempTarget, operation.targetPath);
      operation.targetInstalled = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.targetInstalled) rmSync(operation.targetPath, { recursive: true, force: true });
        if (operation.backupCreated) renameSync(operation.backupTarget, operation.targetPath);
        rmSync(operation.tempTarget, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${operation.agent}: ${getErrorMessage(rollbackError)}`);
      }
    }
    const rollbackSuffix = rollbackErrors.length > 0
      ? `; rollback failed (${rollbackErrors.join("; ")})`
      : "";
    throw new Error(`${getErrorMessage(error)}${rollbackSuffix}`);
  }

  for (const operation of operations) {
    rmSync(operation.backupTarget, { recursive: true, force: true });
  }
  return operations.map(({ agent, targetPath }) => ({ agent, status: "installed", path: targetPath }));
}

function removeOwnedSkillDirectory(targetPath: string): void {
  const stat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    rmSync(targetPath);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`OpenThrottle skill target is not a directory: ${targetPath}`);
  rmSync(targetPath, { recursive: true, force: true });
  if (existsSync(targetPath)) throw new Error(`OpenThrottle skill target still exists after removal: ${targetPath}`);
}

function parseSkillfishJson(result: SpawnSyncReturns<Buffer>): SkillfishJson {
  const stdout = result.stdout?.toString("utf8").trim() ?? "";
  try {
    return stdout ? JSON.parse(stdout) as SkillfishJson : {};
  } catch {
    return {
      success: false,
      exit_code: result.status ?? 1,
      errors: [sanitizeError(stdout || result.stderr?.toString("utf8") || "skillfish returned non-JSON output")],
    };
  }
}

function validatedStagedInstallEntries(
  json: SkillfishJson,
  expectedAgents: SupportedAgent[],
  tempHome: string,
  expectedDigest: string
): Map<SupportedAgent, string> {
  const expected = new Set(expectedAgents);
  const staged = new Map<SupportedAgent, string>();
  for (const entry of installedEntries(json)) {
    if (entry.skill !== SKILL_NAME) continue;
    if (typeof entry.agent !== "string" || !isSupportedAgent(entry.agent) || !expected.has(entry.agent)) {
      throw new Error(`Skillfish returned an unexpected OpenThrottle install agent: ${String(entry.agent)}`);
    }
    if (staged.has(entry.agent)) {
      throw new Error(`Skillfish returned duplicate OpenThrottle install entries for ${entry.agent}`);
    }
    if (typeof entry.path !== "string") {
      throw new Error(`Skillfish returned an invalid OpenThrottle install path for ${entry.agent}`);
    }
    const stagedPath = resolve(entry.path);
    const expectedPath = stagedOperatorSkillPath(tempHome, entry.agent);
    if (stagedPath !== expectedPath) {
      throw new Error(`Skillfish staged ${entry.agent} at an unexpected path: ${entry.path}`);
    }
    if (digestDirectory(stagedPath) !== expectedDigest) {
      throw new Error(`Skillfish staged ${entry.agent} with bytes that differ from the packaged OpenThrottle skill`);
    }
    staged.set(entry.agent, stagedPath);
  }
  for (const agent of expected) {
    if (!staged.has(agent)) throw new Error(`Skillfish did not stage OpenThrottle for ${agent}`);
  }
  return staged;
}

function runSkillfishJson(
  args: string[],
  options: OperatorSkillOptions,
  agents?: SupportedAgent[]
): { json: SkillfishJson; raw: SpawnSyncReturns<Buffer> } {
  const tempHome = prepareSkillfishHome(options.home ?? homedir(), agents);
  try {
    const result = (options.runner ?? defaultRunner)([...args, "--json"], {
      cwd: options.cwd ?? process.cwd(),
      env: safeSkillfishEnv(tempHome),
    });
    return { json: parseSkillfishJson(result), raw: result };
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function installedEntries(json: SkillfishJson): SkillfishInstalledSkill[] {
  return Array.isArray(json.installed) ? json.installed as SkillfishInstalledSkill[] : [];
}

function detectedSupportedAgents(json: SkillfishJson): SupportedAgent[] {
  const detected = Array.isArray(json.agents_detected) ? json.agents_detected : [];
  return detected.filter((agent): agent is SupportedAgent => typeof agent === "string" && isSupportedAgent(agent));
}

function readManifest(skillPath: string): SkillManifest | undefined {
  const manifestPath = join(skillPath, ".skillfish.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as SkillManifest;
  } catch {
    return undefined;
  }
}

function inspectOwnedInstall(entry: SkillfishInstalledSkill, expectedDigest: string): OwnedInstall | undefined {
  if (entry.skill !== SKILL_NAME || typeof entry.agent !== "string" || !isSupportedAgent(entry.agent) || typeof entry.path !== "string") {
    return undefined;
  }
  const manifest = readManifest(entry.path);
  const exact =
    manifest?.owner === OWNER &&
    manifest.repo === REPO &&
    manifest.path === SKILL_PATH &&
    (manifest.source === "manifest" || manifest.source === "manual");
  if (!exact) {
    return { agent: entry.agent, path: entry.path, exact: false, digestMatches: false, reason: "existing openthrottle skill is not Skillfish-managed from OpenThrottle" };
  }
  let digestMatches = false;
  try {
    digestMatches = digestDirectory(entry.path) === expectedDigest;
  } catch (error) {
    return { agent: entry.agent, path: entry.path, exact: true, digestMatches: false, reason: getErrorMessage(error) };
  }
  return {
    agent: entry.agent,
    path: entry.path,
    exact,
    digestMatches,
    reason: digestMatches ? undefined : "installed OpenThrottle skill differs from the packaged source",
  };
}

function baseResult(action: OperatorSkillAction, sourceRef: string, sourceDigest: string): OperatorSkillResult {
  return {
    schema: "openthrottle.operator-skill/v1",
    action,
    success: true,
    source: operatorSkillSource(sourceRef),
    source_ref: sourceRef,
    source_digest: sourceDigest,
    installed: [],
    skipped: [],
    conflicted: [],
    removed: [],
    unsupported: [],
    recovery: [],
  };
}

function addRecovery(result: OperatorSkillResult, command: string): void {
  if (!result.recovery.includes(command)) result.recovery.push(command);
}

function writeHumanResult(result: OperatorSkillResult): void {
  const rows = [
    ...result.installed,
    ...result.skipped,
    ...result.conflicted,
    ...result.removed,
    ...result.unsupported,
  ];
  console.log(`OpenThrottle operator skill ${result.action}: ${result.success ? "ok" : "attention required"}`);
  console.log(`Source: ${result.source}`);
  for (const row of rows) {
    console.log(`- ${row.agent}: ${row.status}${row.reason ? ` (${row.reason})` : ""}${row.path ? ` ${row.path}` : ""}`);
  }
  for (const recovery of result.recovery) console.log(`Recovery: ${recovery}`);
}

function parseErrors(json: SkillfishJson, raw: SpawnSyncReturns<Buffer>): string[] {
  const errors = Array.isArray(json.errors) ? json.errors.filter((error): error is string => typeof error === "string") : [];
  if (errors.length > 0) return errors.map(sanitizeError);
  const stderr = raw.stderr?.toString("utf8").trim();
  return stderr ? [sanitizeError(stderr)] : [];
}

function classifyCurrentInstalls(
  listJson: SkillfishJson,
  result: OperatorSkillResult,
  expectedDigest: string,
  home: string
): { detected: SupportedAgent[]; installs: Map<SupportedAgent, OwnedInstall> } {
  const detected = detectedSupportedAgents(listJson);
  const installs = new Map<SupportedAgent, OwnedInstall>();
  for (const entry of installedEntries(listJson)) {
    const inspected = inspectOwnedInstall(entry, expectedDigest);
    if (inspected) installs.set(inspected.agent, inspected);
  }
  for (const agent of detected) {
    const targetPath = operatorSkillTargetPath(home, agent);
    if (existsSync(targetPath) && !installs.has(agent)) {
      const inspected = inspectOwnedInstall({ skill: SKILL_NAME, agent, path: targetPath }, expectedDigest);
      if (inspected) installs.set(agent, inspected);
    }
  }
  for (const agent of SUPPORTED_AGENTS) {
    if (!detected.includes(agent)) {
      result.unsupported.push({ agent, status: "unsupported", reason: "agent not detected by Skillfish" });
    }
  }
  return { detected, installs };
}

function ensureSuccessfulSkillfish(json: SkillfishJson, raw: SpawnSyncReturns<Buffer>, result: OperatorSkillResult): boolean {
  if (raw.error || raw.status !== 0 || json.success === false) {
    result.success = false;
    result.conflicted.push({
      agent: "Codex",
      status: "conflicted",
      reason: parseErrors(json, raw).join("; ") || raw.error?.message || "skillfish command failed",
    });
    return false;
  }
  return true;
}

export function runOperatorSkillAction(
  action: OperatorSkillAction,
  options: OperatorSkillOptions = {}
): OperatorSkillResult {
  const sourceRef = resolveOperatorSkillSourceRef(options);
  const sourceDigest = operatorSkillBundleDigest();
  const result = baseResult(action, sourceRef, sourceDigest);
  const realHome = options.home ?? homedir();
  const listed = runSkillfishJson(["list", "--global"], options);
  if (!ensureSuccessfulSkillfish(listed.json, listed.raw, result)) return result;
  const { detected, installs } = classifyCurrentInstalls(listed.json, result, sourceDigest, realHome);

  if (action === "status") {
    for (const agent of detected) {
      const install = installs.get(agent);
      if (!install) {
        result.skipped.push({ agent, status: "skipped", reason: "not installed" });
      } else if (install.exact && install.digestMatches) {
        result.installed.push({ agent, status: "installed", path: install.path });
      } else {
        result.success = false;
        result.conflicted.push({ agent, status: "conflicted", path: install.path, reason: install.reason });
        addRecovery(result, "openthrottle operator-skill remove && openthrottle operator-skill install");
      }
    }
    return result;
  }

  if (action === "remove") {
    const removable = [...installs.values()].filter((install) => install.exact);
    const conflicting = [...installs.values()].filter((install) => !install.exact);
    for (const install of conflicting) {
      result.success = false;
      result.conflicted.push({ agent: install.agent, status: "conflicted", path: install.path, reason: install.reason });
    }
    for (const install of removable) {
      if (install.agent === "OpenCode" && resolve(install.path) === operatorSkillTargetPath(realHome, "OpenCode")) {
        try {
          removeOwnedSkillDirectory(install.path);
          result.removed.push({ agent: install.agent, status: "removed", path: install.path });
        } catch (error) {
          result.success = false;
          result.conflicted.push({ agent: install.agent, status: "conflicted", path: install.path, reason: getErrorMessage(error) });
        }
        continue;
      }
      const removed = runSkillfishJson(["remove", SKILL_NAME, "--global", "--yes"], options, [install.agent]);
      if (ensureSuccessfulSkillfish(removed.json, removed.raw, result) && !existsSync(install.path)) {
        result.removed.push({ agent: install.agent, status: "removed", path: install.path });
      } else if (existsSync(install.path)) {
        result.success = false;
        result.conflicted.push({ agent: install.agent, status: "conflicted", path: install.path, reason: "OpenThrottle skill target still exists after removal" });
      }
    }
    return result;
  }

  const needsInstall: SupportedAgent[] = [];
  const needsReplace = new Set<SupportedAgent>();
  for (const agent of detected) {
    const install = installs.get(agent);
    if (!install) {
      needsInstall.push(agent);
    } else if (install.exact && install.digestMatches) {
      result.skipped.push({ agent, status: "skipped", path: install.path, reason: "already installed from matching source" });
    } else if (action === "refresh" && install.exact) {
      needsInstall.push(agent);
      needsReplace.add(agent);
    } else {
      result.success = false;
      result.conflicted.push({ agent, status: "conflicted", path: install.path, reason: install.reason });
      addRecovery(result, install.exact ? "openthrottle operator-skill refresh" : "openthrottle operator-skill remove && openthrottle operator-skill install");
    }
  }
  if (result.conflicted.length > 0 || needsInstall.length === 0) return result;

  const tempHome = prepareSkillfishStagingHome(needsInstall);
  try {
    writeFileSync(join(tempHome, "skillfish.json"), JSON.stringify({ version: 1, skills: [result.source] }, null, 2));
    const install = (options.runner ?? defaultRunner)(["install", "--global", "--yes", "--json"], {
      cwd: options.cwd ?? process.cwd(),
      env: safeSkillfishEnv(tempHome),
    });
    const json = parseSkillfishJson(install);
    if (!ensureSuccessfulSkillfish(json, install, result)) return result;
    let staged: Map<SupportedAgent, string>;
    try {
      staged = validatedStagedInstallEntries(json, needsInstall, tempHome, sourceDigest);
    } catch (error) {
      result.success = false;
      const reason = getErrorMessage(error);
      for (const agent of needsInstall) {
        result.conflicted.push({ agent, status: "conflicted", path: operatorSkillTargetPath(realHome, agent), reason });
      }
      return result;
    }
    try {
      result.installed.push(...installStagedSkillsAtomically(staged, realHome, needsReplace));
    } catch (error) {
      result.success = false;
      const reason = getErrorMessage(error);
      for (const agent of needsInstall) {
        result.conflicted.push({
          agent,
          status: "conflicted",
          path: operatorSkillTargetPath(realHome, agent),
          reason,
        });
      }
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
  return result;
}

export function parseOperatorSkillArgs(args: string[]): { action: OperatorSkillAction; json: boolean } {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const action = positional[0] ?? "status";
  if (!["install", "status", "refresh", "remove"].includes(action)) {
    throw new Error(`Unknown operator-skill action: ${action}`);
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  return { action: action as OperatorSkillAction, json };
}

export default async function operatorSkill(args: string[] = []): Promise<void> {
  try {
    const parsed = parseOperatorSkillArgs(args);
    const result = runOperatorSkillAction(parsed.action);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    else writeHumanResult(result);
    if (!result.success) process.exit(1);
  } catch (error) {
    const message = sanitizeError(getErrorMessage(error));
    if (args.includes("--json")) {
      console.log(JSON.stringify({ schema: "openthrottle.operator-skill/v1", success: false, errors: [message] }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}
