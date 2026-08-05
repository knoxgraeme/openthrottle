#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest, sanitizeArtifactText, validateStandardReceipt } from "./artifacts.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { runWithAgentProcessFence } from "./agent-process-fence.mjs";
import { grantWorktreeToAgent, lockWorktree, worktreePath } from "./worktrees.mjs";
import {
  chmodOwnerPrivateTree,
  chmodReadOnlyPreservingExecuteTree,
  chmodTree,
  chownTree,
  identityForUser,
  isRoot,
  lockPersistentAgentPrivateRoots,
  lockedPersistentProfilesFrom,
  pathInside as containedPath,
  prepareAgentOwnedDirectory,
  restorePersistentAgentPrivateRoots,
} from "./filesystem-isolation.mjs";
import { writeJsonAtomic } from "./atomic-write.mjs";
import { validateRepositorySkillPackage } from "./repository-skills.mjs";
import { readLoopActionCredentialEnv } from "./loop-credentials.mjs";
import {
  classifyLaunchFailure,
  engineCredentialPresent,
  launchDiagnosticTail,
} from "./launch-failure.mjs";
import { prepareLoopAgentEnvironment } from "./loop-agent-environment.mjs";
import { pathInside, PROFILE_ROOT_FENCE_FILE } from "./loop-paths.mjs";
import {
  extractNativeSessionId,
  sealNativeSessionPackage,
} from "./native-session-package.mjs";

export const LOOP_ACTION_PROTOCOL = "loop-action@2";
export {
  lockPersistentAgentPrivateRoots,
  lockedPersistentProfilesFrom,
  restorePersistentAgentPrivateRoots,
} from "./filesystem-isolation.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const STAGE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const AGENTS = new Set(["claude", "codex", "opencode"]);
const ROLES = new Set(["worker", "lead", "reviewer", "publisher"]);
const LOOPS = new Set(["implement", "simplify", "command", "repair", "lead", "review", "publish"]);
// Mirrors contracts/src/graph.ts LOGICAL_CREDENTIALS: the closed logical scope
// set a repository graph worker may declare. Enforced again here, independent
// of the schema-level check upstream, so a stale or malformed sealed request
// cannot hand a loop action an unrecognized scope name.
const LOGICAL_CREDENTIAL_SCOPES = new Set(["model.invoke", "provider.read", "repo.read", "repo.write", "mcp"]);
const SKILLS = new Set([
  "implement-plan",
  "investigate",
  "implement-unit",
  "simplify-unit",
  "repair-unit",
  "accept-unit",
  "final-review",
  "final-repair",
  "publish",
  "ce-work",
  "ce-simplify-code",
  "ce-code-review",
  "ce-commit-push-pr",
]);
const CONTEXTS = new Set(["fresh", "resume_required", "prefer_resume"]);
const STANDARD_RECEIPT_SCHEMA = "openthrottle.receipt/v1";
const DEFAULT_ACTION_ROOT = "/var/lib/openthrottle/loop-actions";
const DEFAULT_WORKTREE_ROOT = "/var/lib/openthrottle/worktrees";
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const ROOT_UID = 0;
const ROOT_GID = 0;
const ABSOLUTE_PATH = /^\/[^\u0000]{0,500}$/;
const UNSAFE_ACTION_ROOTS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/home/agent",
  "/home/agent/repo",
  "/lib",
  "/lib64",
  "/opt",
  "/opt/openthrottle",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
  "/var/lib",
  "/var/lib/openthrottle",
]);
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nullableString(value, label, pattern = ID) {
  return value === null ? null : string(value, label, pattern);
}

function stagePathId(value, label) {
  return string(value, label, STAGE_PATH_ID);
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} is invalid`);
  return value;
}

function boundedArray(value, label, max = 32) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== "string" || entry.length > 160)) {
    throw new Error(`${label} must be a bounded unique string array`);
  }
  return [...value].sort();
}

export function configuredActionRoot(env = process.env) {
  const root = env.OT_LOOP_ACTION_ROOT ?? DEFAULT_ACTION_ROOT;
  if (typeof root !== "string" || !ABSOLUTE_PATH.test(root)) throw new Error("loop action root is invalid");
  const resolved = resolve(root);
  if (UNSAFE_ACTION_ROOTS.has(resolved)) throw new Error("loop action root targets an unsafe system directory");
  if (existsSync(resolved)) {
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("loop action root must be a real directory");
  }
  return resolved;
}

function configuredIntegrationRepoDir(env = process.env) {
  const repoDir = env.OT_INTEGRATION_REPO_DIR ?? INTEGRATION_REPO_DIR;
  if (typeof repoDir !== "string" || !ABSOLUTE_PATH.test(repoDir)) throw new Error("integration repository path is invalid");
  const resolved = resolve(repoDir);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) throw new Error("integration repository path must be a real directory");
  return resolved;
}

export function actionDirectory(request, rootDir = configuredActionRoot()) {
  return pathInside(pathInside(rootDir, request.attemptId), request.actionId);
}

function actionFilePath({ attemptId, actionId, rootDir = DEFAULT_ACTION_ROOT }, name) {
  return pathInside(actionDirectory({
    attemptId: string(attemptId, "attemptId"),
    actionId: string(actionId, "actionId"),
  }, rootDir), name);
}

export function loopRequestPath({ attemptId, actionId, rootDir = DEFAULT_ACTION_ROOT }) {
  return actionFilePath({ attemptId: stagePathId(attemptId, "attemptId"), actionId: stagePathId(actionId, "actionId"), rootDir }, "request.json");
}

export function loopResultPath({ attemptId, actionId, rootDir = DEFAULT_ACTION_ROOT }) {
  return actionFilePath({ attemptId: stagePathId(attemptId, "attemptId"), actionId: stagePathId(actionId, "actionId"), rootDir }, "result.json");
}

export function loopCredentialsPath({ attemptId, actionId, rootDir = DEFAULT_ACTION_ROOT }) {
  return actionFilePath({ attemptId: stagePathId(attemptId, "attemptId"), actionId: stagePathId(actionId, "actionId"), rootDir }, "credentials.json");
}

function ensureTraverseOnly(path) {
  mkdirSync(path, { recursive: true, mode: 0o711 });
  if (isRoot()) chownSync(path, ROOT_UID, ROOT_GID);
  chmodSync(path, 0o711);
}

function ensureCurrentActionTraversal(request, rootDir = configuredActionRoot()) {
  const attemptDirectory = pathInside(rootDir, request.attemptId);
  const currentActionDirectory = actionDirectory(request, rootDir);
  ensureTraverseOnly(rootDir);
  ensureTraverseOnly(attemptDirectory);
  ensureTraverseOnly(currentActionDirectory);
  return currentActionDirectory;
}

function lockNonCurrentActionDirectories(request, rootDir = configuredActionRoot()) {
  if (!existsSync(rootDir)) return;
  const currentActionDirectory = actionDirectory(request, rootDir);
  for (const attempt of readdirSync(rootDir)) {
    const attemptDirectory = resolve(rootDir, attempt);
    if (!lstatSync(attemptDirectory).isDirectory()) continue;
    for (const action of readdirSync(attemptDirectory)) {
      const actionDirectoryPath = resolve(attemptDirectory, action);
      if (actionDirectoryPath !== currentActionDirectory && lstatSync(actionDirectoryPath).isDirectory()) {
        chownTree(actionDirectoryPath, ROOT_UID, ROOT_GID);
        chmodTree(actionDirectoryPath, { fileMode: 0o600, directoryMode: 0o700 });
      }
    }
  }
}

function maybeRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function gitdirFromFilesystem(repoDir) {
  const dotGit = join(repoDir, ".git");
  if (!existsSync(dotGit)) return [];
  const metadata = lstatSync(dotGit);
  if (metadata.isDirectory()) return [dotGit, maybeRealPath(dotGit)];
  if (!metadata.isFile()) return [dotGit];
  const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return [dotGit];
  const gitdir = resolve(repoDir, match[1]);
  return [dotGit, gitdir, maybeRealPath(gitdir)];
}

export function gitSafeDirectoryConfigArgs(repoDir, extraSafeDirectories = []) {
  const resolvedRepo = maybeRealPath(repoDir);
  return [...new Set([repoDir, resolvedRepo, ...gitdirFromFilesystem(resolvedRepo), ...extraSafeDirectories.flatMap((path) => [path, maybeRealPath(path)])])]
    .filter((path) => typeof path === "string" && path.length > 0)
    .flatMap((path) => ["-c", `safe.directory=${path}`]);
}

export function gitSafeDirectoryEnv(repoDir) {
  const directories = [...new Set([repoDir, maybeRealPath(repoDir)])].filter((path) => typeof path === "string" && path.length > 0);
  return [
    `GIT_CONFIG_COUNT=${directories.length}`,
    ...directories.flatMap((directory, index) => [
      `GIT_CONFIG_KEY_${index}=safe.directory`,
      `GIT_CONFIG_VALUE_${index}=${directory}`,
    ]),
  ];
}

function runRootGit(repoDir, args, env = {}, { safeDirectories = [] } = {}) {
  const result = runCapturedProcess("git", [...gitSafeDirectoryConfigArgs(repoDir, safeDirectories), ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
    timeout: 120_000,
    captureBytes: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${sanitizeArtifactText(result.stderr || result.error?.message || "").slice(-800)}`);
  }
  return result.stdout.trim();
}

export function createLoopRequestHash(requestWithoutFence) {
  const requestHash = digest(canonicalJson(requestWithoutFence));
  return {
    requestHash,
    idempotencyKey: `loop:${requestWithoutFence.attemptId}:${requestWithoutFence.actionId}:${requestHash}`,
  };
}

export function validateLoopRequest(value) {
  const input = record(value, "loop request");
  const allowed = new Set([
    "protocol", "actionId", "attemptId", "graphId", "parentRunId", "unitId", "role", "loop",
    "agent", "skill", "worktree", "candidateSubject", "nativeSessionId", "contextPolicy", "timeoutMs",
    "transitionContext", "allowedMcpServers", "credentialScopes", "receiptSchema",
    "repositorySkill", "requestHash", "idempotencyKey",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`loop request has unknown field ${unknown}`);
  if (input.protocol !== LOOP_ACTION_PROTOCOL) throw new Error("loop request protocol is unsupported");
  const worktree = input.worktree === null ? null : record(input.worktree, "worktree");
  if (worktree !== null) {
    const worktreeUnknown = Object.keys(worktree).find((key) => key !== "id" && key !== "path");
    if (worktreeUnknown) throw new Error(`worktree has unknown field ${worktreeUnknown}`);
  }
  const candidateSubject = input.candidateSubject === undefined
    ? null
    : nullableString(input.candidateSubject, "candidateSubject", GIT_OBJECT_ID);
  const request = {
    protocol: LOOP_ACTION_PROTOCOL,
    actionId: stagePathId(input.actionId, "actionId"),
    attemptId: stagePathId(input.attemptId, "attemptId"),
    graphId: string(input.graphId, "graphId"),
    parentRunId: stagePathId(input.parentRunId, "parentRunId"),
    unitId: nullableString(input.unitId, "unitId"),
    role: string(input.role, "role"),
    loop: string(input.loop, "loop"),
    agent: string(input.agent, "agent"),
    skill: string(input.skill, "skill", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    worktree: worktree === null ? null : {
      id: string(worktree.id, "worktree.id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    },
    nativeSessionId: nullableString(input.nativeSessionId, "nativeSessionId", NATIVE_SESSION_ID),
    contextPolicy: string(input.contextPolicy, "contextPolicy"),
    timeoutMs: input.timeoutMs,
    transitionContext: boundedText(input.transitionContext, "transitionContext", 64_000),
    allowedMcpServers: boundedArray(input.allowedMcpServers, "allowedMcpServers"),
    credentialScopes: boundedArray(input.credentialScopes, "credentialScopes"),
    receiptSchema: string(input.receiptSchema, "receiptSchema", /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/),
  };
  if (request.receiptSchema !== STANDARD_RECEIPT_SCHEMA) throw new Error("loop receipt schema is unsupported");
  if (!ROLES.has(request.role)) throw new Error("role is invalid");
  if (!LOOPS.has(request.loop)) throw new Error("loop is invalid");
  if (!AGENTS.has(request.agent)) throw new Error("agent is invalid");
  const unknownScope = request.credentialScopes.find((scope) => !LOGICAL_CREDENTIAL_SCOPES.has(scope));
  if (unknownScope) throw new Error(`credential scope ${unknownScope} is not a recognized logical credential`);
  if (request.role === "lead" && request.credentialScopes.includes("repo.write")) {
    throw new Error("lead loop cannot request repo.write");
  }
  if (request.agent === "opencode") {
    // OpenCode loop actions need database-backed session sealing and adapter
    // body delivery that RU5 does not provide; fail closed until that unit.
    throw new Error("opencode loop actions are not supported yet");
  }
  const repositorySkill = input.repositorySkill === undefined
    ? undefined
    : validateRepositorySkillPackage(input.repositorySkill);
  if (repositorySkill) {
    if (request.skill !== repositorySkill.invocation) throw new Error("loop repository skill invocation mismatch");
  } else if (!SKILLS.has(request.skill)) {
    throw new Error("skill is not installed for loop dispatch");
  }
  if (!CONTEXTS.has(request.contextPolicy)) throw new Error("contextPolicy is invalid");
  if (request.contextPolicy === "resume_required" && !request.nativeSessionId) {
    throw new Error("resume-required loop request is missing its native session");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 86_400_000) {
    throw new Error("timeoutMs is invalid");
  }
  if (request.role === "worker" && !request.worktree) throw new Error("worker loop requires a worktree");
  if (request.role !== "worker" && request.worktree) throw new Error("non-worker loop cannot receive a writable worktree");
  if (request.role === "lead" && !candidateSubject) throw new Error("lead loop requires a candidate subject");
  if (request.role !== "lead" && candidateSubject) throw new Error("candidate subject is only valid for lead loops");
  if (worktree !== null && worktree.path !== undefined) throw new Error("loop request cannot carry an absolute worktree path");
  const requestWithSkill = {
    ...request,
    ...(candidateSubject === null ? {} : { candidateSubject }),
    ...(repositorySkill === undefined ? {} : { repositorySkill }),
  };
  const expected = createLoopRequestHash(requestWithSkill);
  if (input.requestHash !== expected.requestHash || input.idempotencyKey !== expected.idempotencyKey) {
    throw new Error("loop request hash or idempotency key is stale");
  }
  return { ...requestWithSkill, ...expected };
}

export function loopWorktreeDirectory(request) {
  if (!request.worktree) return null;
  return worktreePath({ rootDir: process.env.OT_WORKTREE_ROOT ?? DEFAULT_WORKTREE_ROOT, handle: request.worktree.id });
}

export function resolveLoopInvocation(request) {
  if (request.contextPolicy === "fresh") return { mode: "fresh", nativeSessionId: null };
  if (request.contextPolicy === "resume_required") return { mode: "resume", nativeSessionId: request.nativeSessionId };
  return request.nativeSessionId
    ? { mode: "resume", nativeSessionId: request.nativeSessionId }
    : { mode: "fresh", nativeSessionId: null };
}

export function loopPrompt(request) {
  const prefix = request.agent === "claude" ? "/" : "$";
  const entry = `${prefix}${request.skill}`;
  return `${entry}\n\n` +
    `This is one fenced OpenThrottle loop action (${request.actionId}) for ${request.role}/${request.loop}. ` +
    `Edit only the provided worktree when one is present. Do not commit, push, or alter executor state. ` +
    `Return one receipt matching ${request.receiptSchema}.\n\n${request.transitionContext}`;
}

export function prepareRootReadOnlyDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o555 });
  if (isRoot()) chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o444, directoryMode: 0o555 });
}

function retryableInfrastructureError(message) {
  const error = new Error(message);
  error.retryableInfrastructureFailure = true;
  return error;
}

function assertProfileRootFence(profileRoot, nonce) {
  const replaced = new Error("native session profile root was replaced during the action");
  let rootMetadata;
  let fenceMetadata;
  const fencePath = containedPath(profileRoot, PROFILE_ROOT_FENCE_FILE, "profile fence escapes its root");
  try {
    rootMetadata = lstatSync(profileRoot);
    fenceMetadata = lstatSync(fencePath);
  } catch {
    throw replaced;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw replaced;
  if (!fenceMetadata.isFile() || fenceMetadata.isSymbolicLink()) throw replaced;
  if (isRoot() && fenceMetadata.uid !== ROOT_UID) throw replaced;
  if (readFileSync(fencePath, "utf8") !== nonce) throw replaced;
}

function packReachableBaseObjects(repoDir, destinationPackBase, subject = "HEAD") {
  const result = runCapturedProcess("git", [...gitSafeDirectoryConfigArgs(repoDir), "pack-objects", "--revs", destinationPackBase], {
    cwd: repoDir,
    input: `${subject}\n`,
    timeout: 120_000,
    captureBytes: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git pack-objects failed: ${sanitizeArtifactText(result.stderr || result.error?.message || "").slice(-800)}`);
  }
}

export function prepareLoopGitObjectEnvironment(request, repoDir) {
  if (!request.worktree) return { env: [], values: null };
  const objectRoot = pathInside(actionDirectory(request), "git-objects");
  const baseObjectDir = pathInside(objectRoot, "base");
  const basePackDir = pathInside(baseObjectDir, "pack");
  const writeObjectDir = pathInside(objectRoot, "write");
  const gitAdminDir = pathInside(actionDirectory(request), "git-admin");
  const gitIndexPath = pathInside(gitAdminDir, "index");
  rmSync(objectRoot, { recursive: true, force: true });
  rmSync(gitAdminDir, { recursive: true, force: true });
  mkdirSync(basePackDir, { recursive: true, mode: 0o755 });
  packReachableBaseObjects(repoDir, join(basePackDir, "base"));
  chmodTree(baseObjectDir, { fileMode: 0o444, directoryMode: 0o555 });
  prepareAgentOwnedDirectory(writeObjectDir);
  mkdirSync(gitAdminDir, { recursive: true, mode: 0o755 });
  const head = runRootGit(repoDir, ["rev-parse", "HEAD"]);
  writeFileSync(pathInside(gitAdminDir, "HEAD"), `${head}\n`, { mode: 0o444 });
  writeFileSync(pathInside(gitAdminDir, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = false",
    "",
  ].join("\n"), { mode: 0o444 });
  mkdirSync(pathInside(gitAdminDir, "objects"), { recursive: true, mode: 0o755 });
  mkdirSync(pathInside(pathInside(gitAdminDir, "refs"), "heads"), { recursive: true, mode: 0o755 });
  mkdirSync(pathInside(pathInside(gitAdminDir, "refs"), "tags"), { recursive: true, mode: 0o755 });
  runRootGit(repoDir, ["read-tree", head], {
    GIT_DIR: gitAdminDir,
    GIT_WORK_TREE: repoDir,
    GIT_INDEX_FILE: gitIndexPath,
    GIT_OBJECT_DIRECTORY: writeObjectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: baseObjectDir,
  });
  prepareRootReadOnlyDirectory(gitAdminDir);
  const objectValues = {
    GIT_OBJECT_DIRECTORY: writeObjectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: baseObjectDir,
  };
  const agentValues = {
    GIT_DIR: gitAdminDir,
    GIT_WORK_TREE: repoDir,
    GIT_INDEX_FILE: gitIndexPath,
    ...objectValues,
  };
  return {
    values: agentValues,
    env: [
      `GIT_DIR=${agentValues.GIT_DIR}`,
      `GIT_WORK_TREE=${agentValues.GIT_WORK_TREE}`,
      `GIT_INDEX_FILE=${agentValues.GIT_INDEX_FILE}`,
      `GIT_OBJECT_DIRECTORY=${agentValues.GIT_OBJECT_DIRECTORY}`,
      `GIT_ALTERNATE_OBJECT_DIRECTORIES=${agentValues.GIT_ALTERNATE_OBJECT_DIRECTORIES}`,
    ],
  };
}

function createReadOnlyRepositoryView(request, sourceRepoDir = "/home/agent/repo") {
  const actionRoot = configuredActionRoot();
  const currentActionDirectory = ensureCurrentActionTraversal(request, actionRoot);
  const destination = pathInside(currentActionDirectory, "repo-view");
  rmSync(destination, { recursive: true, force: true });
  lockNonCurrentActionDirectories(request, actionRoot);
  const sourceSubject = request.role === "lead" ? request.candidateSubject : "HEAD";
  const subject = runRootGit(sourceRepoDir, ["rev-parse", sourceSubject]);
  const objectType = runRootGit(sourceRepoDir, ["cat-file", "-t", subject]);
  if (objectType !== "commit" && objectType !== "tree") {
    throw new Error("read-only repository subject must be a commit or tree");
  }
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  runRootGit(destination, ["init", "--quiet"]);
  const packDir = pathInside(pathInside(destination, ".git"), "objects/pack");
  mkdirSync(packDir, { recursive: true, mode: 0o755 });
  packReachableBaseObjects(sourceRepoDir, join(packDir, "authorized"), subject);
  if (objectType === "commit") {
    runRootGit(destination, ["switch", "--quiet", "--detach", subject]);
  } else {
    runRootGit(destination, ["read-tree", subject]);
    runRootGit(destination, ["checkout-index", "--all", "--force"]);
  }
  runRootGit(destination, ["config", "remote.origin.url", "DISABLED_BY_OPENTHROTTLE_READONLY_VIEW"]);
  runRootGit(destination, ["config", "remote.origin.pushurl", "DISABLED_BY_OPENTHROTTLE_READONLY_VIEW"]);
  chmodReadOnlyPreservingExecuteTree(destination);
  return destination;
}

function prepareLoopRepository(request, integrationRepoDir = INTEGRATION_REPO_DIR) {
  ensureCurrentActionTraversal(request);
  if (request.worktree) {
    lockNonCurrentActionDirectories(request);
    return grantWorktreeToAgent({
      rootDir: process.env.OT_WORKTREE_ROOT ?? DEFAULT_WORKTREE_ROOT,
      handle: request.worktree.id,
    }).path;
  }
  return createReadOnlyRepositoryView(request, integrationRepoDir);
}

function lockPrivateTree(path) {
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

function lockGitMetadata(gitDir) {
  if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return;
  chownSync(gitDir, ROOT_UID, ROOT_GID);
  chmodSync(gitDir, 0o711);
  for (const entry of readdirSync(gitDir)) {
    const child = resolve(gitDir, entry);
    const metadata = lstatSync(child);
    if (entry === "worktrees" && metadata.isDirectory()) {
      chownSync(child, ROOT_UID, ROOT_GID);
      chmodSync(child, 0o711);
      for (const handle of readdirSync(child)) {
        const handleDir = resolve(child, handle);
        if (!lstatSync(handleDir).isDirectory()) continue;
        lockPrivateTree(handleDir);
      }
    } else {
      lockPrivateTree(child);
    }
  }
}

function lockIntegrationCheckout(path = INTEGRATION_REPO_DIR) {
  if (!isRoot() || !existsSync(path)) return false;
  chownSync(path, ROOT_UID, ROOT_GID);
  chmodSync(path, 0o711);
  for (const entry of readdirSync(path)) {
    const child = resolve(path, entry);
    if (entry === ".git") {
      lockGitMetadata(child);
      continue;
    }
    chownTree(child, ROOT_UID, ROOT_GID);
    chmodOwnerPrivateTree(child);
  }
  return true;
}

export function restoreIntegrationCheckout(path = INTEGRATION_REPO_DIR) {
  if (!isRoot() || !existsSync(path)) return false;
  const identity = identityForUser("agent");
  if (!identity) return false;
  chownTree(path, identity.uid, identity.gid);
  chmodOwnerPrivateTree(path);
  return true;
}

function lockCurrentWorkerWorktree(request) {
  if (!request.worktree) return;
  lockWorktree({
    rootDir: process.env.OT_WORKTREE_ROOT ?? DEFAULT_WORKTREE_ROOT,
    handle: request.worktree.id,
  });
}

function lockCurrentActionDirectory(request) {
  const currentActionDirectory = actionDirectory(request);
  if (!existsSync(currentActionDirectory)) return;
  chownTree(currentActionDirectory, ROOT_UID, ROOT_GID);
  chmodTree(currentActionDirectory, { fileMode: 0o600, directoryMode: 0o700 });
}

function makeCurrentActionDirectoryTraverseOnly(request) {
  ensureCurrentActionTraversal(request);
}

export function loopAgentCommand({ request, invocation, repoDir = loopWorktreeDirectory(request) ?? "/home/agent/repo", mcpConfigPath = null }) {
  const prompt = loopPrompt(request);
  if (request.agent === "codex") {
    return {
      repoDir,
      command: "codex",
      args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", repoDir, ...(invocation.mode === "resume" ? ["resume", invocation.nativeSessionId, prompt] : ["-"])],
      input: invocation.mode !== "resume" ? prompt : undefined,
    };
  }
  return {
    repoDir,
    command: "claude",
    args: [
      "-p", ...(invocation.mode === "resume" ? ["--resume", invocation.nativeSessionId] : []), prompt,
      "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
      // Unconditional: --strict-mcp-config closes MCP entirely to just the
      // declared set (or to nothing, when no MCP servers were declared),
      // rather than leaving a repo-committed .mcp.json or other ambient
      // discovery reachable when this action declared zero MCP servers.
      ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []), "--strict-mcp-config",
      "--plugin-dir", "/opt/openthrottle/compound-engineering-marketplace",
      "--setting-sources", "user",
    ],
    input: undefined,
  };
}

export function runLoopAgentInPreparedRepository({
  request,
  invocation,
  runProcess = runCapturedProcess,
  processFence = runWithAgentProcessFence,
  integrationRepoDir = INTEGRATION_REPO_DIR,
  lockIntegration = lockIntegrationCheckout,
  lockPersistentProfiles = lockPersistentAgentPrivateRoots,
  restorePersistentProfiles = restorePersistentAgentPrivateRoots,
  credentialEnv = {},
}) {
  let lockedPersistentProfiles = [];
  const cleanupErrors = [];
  let bodyError = null;
  try {
    lockIntegration(integrationRepoDir);
    try {
      lockedPersistentProfiles = lockPersistentProfiles();
    } catch (error) {
      lockedPersistentProfiles = lockedPersistentProfilesFrom(error, lockedPersistentProfiles);
      throw error;
    }
    const repoDir = prepareLoopRepository(request, integrationRepoDir);
    const preparedEnvironment = prepareLoopAgentEnvironment(request, repoDir, credentialEnv);
    const built = loopAgentCommand({ request, invocation, repoDir, mcpConfigPath: preparedEnvironment.mcpConfigPath });
    makeCurrentActionDirectoryTraverseOnly(request);
    const result = processFence(() => runProcess("gosu", [
      "agent", "env", ...preparedEnvironment.env, built.command, ...built.args,
    ], {
      cwd: built.repoDir,
      input: built.input,
      timeout: request.timeoutMs,
      // Credentials never ride as argv strings (visible to any co-resident
      // process via /proc/<pid>/cmdline); they travel only in this explicit
      // child-process env, which replaces whatever the sandbox process
      // itself inherited rather than merging with it.
      env: preparedEnvironment.secretEnv,
    }));
    const reportedNativeSessionId = extractNativeSessionId(result.stdout, request.agent);
    if (request.nativeSessionId && reportedNativeSessionId && reportedNativeSessionId !== request.nativeSessionId) {
      throw new Error("reported native session id does not match the sealed loop request");
    }
    const nativeSessionId = request.nativeSessionId ?? reportedNativeSessionId;
    assertProfileRootFence(preparedEnvironment.nativeSessionProfileRoot, preparedEnvironment.profileRootFenceNonce);
    const sealedNativeSessionPackage = sealNativeSessionPackage({
      agent: request.agent,
      nativeSessionId,
      profileRoot: preparedEnvironment.nativeSessionProfileRoot,
    });
    if (nativeSessionId && !sealedNativeSessionPackage) {
      throw new Error("native session id was reported without a sealed executor package");
    }
    return {
      ...result,
      nativeSessionId,
      gitObjectEnv: preparedEnvironment.gitObjectEnv,
      integrationRepoDir,
    };
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    try {
      lockIntegration(integrationRepoDir);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    // While agent process termination is unconfirmed, restoring profile access
    // would hand executor-locked state back to processes that may still run.
    if (!bodyError?.processTerminationUnconfirmed) {
      try {
        restorePersistentProfiles(lockedPersistentProfiles);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length > 0) {
      const prefix = bodyError
        ? `loop action failed (${bodyError instanceof Error ? bodyError.message : String(bodyError)}) and cleanup failed`
        : "loop action cleanup failed";
      const compounded = retryableInfrastructureError(`${prefix}: ${cleanupErrors.join("; ")}`);
      // The compounded error must not launder an unconfirmed-termination body
      // error into one that lets executeLoopAction restore agent access.
      if (bodyError?.processTerminationUnconfirmed) compounded.processTerminationUnconfirmed = true;
      throw compounded;
    }
  }
}

function defaultRunLoopAgent({ request, invocation, integrationRepoDir = configuredIntegrationRepoDir(), credentialEnv = {} }) {
  return runLoopAgentInPreparedRepository({
    request,
    invocation,
    integrationRepoDir,
    credentialEnv,
  });
}

function receiptCandidatesFromJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidates = [];
  for (const key of ["receipt", "output", "content", "message"]) {
    if (value[key] !== undefined) candidates.push(value[key]);
  }
  if (value.type === "result" && value.result !== undefined) candidates.push(value.result);
  return candidates;
}

export function parseLoopReceipt(raw, env = process.env) {
  const sanitized = sanitizeArtifactText(raw, env).trim();
  if (!sanitized) throw new Error("loop action did not emit a receipt");
  const candidates = [sanitized, ...sanitized.split("\n").map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
      try {
        return validateStandardReceipt(parsed, env);
      } catch {
        for (const nested of receiptCandidatesFromJson(parsed)) {
          try {
            const normalized = typeof nested === "string" ? JSON.parse(nested) : nested;
            return validateStandardReceipt(normalized, env);
          } catch {
            // Try the next nested field.
          }
        }
      }
    } catch {
      // Continue searching bounded agent output for the structured receipt.
    }
  }
  throw new Error("loop action emitted invalid standard receipt");
}

function assertLoopReceiptFence(receipt, request, subject) {
  if (receipt.fence.attempt_id !== request.attemptId || receipt.fence.request_hash !== request.requestHash) {
    throw new Error("loop receipt request fence mismatch");
  }
  if (request.unitId !== null && receipt.fence.unit_id !== request.unitId) {
    throw new Error("loop receipt unit fence mismatch");
  }
  if (subject !== null && receipt.subject.post !== subject) {
    throw new Error("loop receipt subject fence mismatch");
  }
  const expectedProducerSkill = request.repositorySkill?.reference ?? `builtin://${request.skill}@1`;
  if (receipt.producer.skill !== expectedProducerSkill) {
    throw new Error("loop receipt producer skill mismatch");
  }
}

export function executeLoopAction({
  request: rawRequest,
  runLoopAgent = defaultRunLoopAgent,
  lockWorkerWorktree = lockCurrentWorkerWorktree,
  lockActionDirectory = lockCurrentActionDirectory,
  restoreIntegration = restoreIntegrationCheckout,
  integrationRepoDir = configuredIntegrationRepoDir(),
  credentialEnv = {},
  now = () => new Date().toISOString(),
}) {
  const request = validateLoopRequest(rawRequest);
  const cleanupErrors = [];
  // Merge the action's own materialized credentials into the redaction
  // source: they never land in this process's own env (they are scoped to
  // the spawned agent process only), so sanitizeArtifactText's default
  // process.env lookup alone would miss them if a failure message ever
  // echoed one -- including in the cleanup-failure path below.
  const sanitizeEnv = { ...process.env, ...credentialEnv };
  let result;
  let execution;
  try {
    const invocation = resolveLoopInvocation(request);
    try {
      execution = runLoopAgent({ request, invocation, integrationRepoDir, credentialEnv });
    } catch (error) {
      execution = {
        status: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: String(error),
        nativeSessionId: request.nativeSessionId,
        integrationRepoDir,
        // The executor itself failed before (or around) the engine, so its
        // message is the evidence; there is no engine output to classify.
        executorFailure: true,
        retryableInfrastructureFailure: Boolean(error?.retryableInfrastructureFailure),
        processTerminationUnconfirmed: Boolean(error?.processTerminationUnconfirmed),
      };
    }
    const worktreeDir = loopWorktreeDirectory(request);
    let subject = null;
    let subjectError = null;
    if (worktreeDir) {
      try {
        subject = computeWorkspaceTreeOid(worktreeDir, execution.gitObjectEnv ?? undefined);
      } catch (error) {
        subjectError = `workspace subject attestation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let parsedReceipt = null;
    let receiptError = null;
    if (!subjectError && !execution.timedOut && !execution.signal && execution.status === 0) {
      try {
        parsedReceipt = parseLoopReceipt(execution.stdout, sanitizeEnv);
        assertLoopReceiptFence(parsedReceipt, request, subject);
      } catch (error) {
        receiptError = error instanceof Error ? error.message : String(error);
      }
    }
    const retryableInfrastructureFailure = Boolean(execution.retryableInfrastructureFailure);
    const failed = Boolean(subjectError) || execution.timedOut || execution.signal || execution.status !== 0 || Boolean(receiptError);
    // The agent process itself died: classify why (missing credential, rejected
    // credential, provider usage limit, or a genuine crash) and carry a
    // bounded, sanitized tail of both streams into the receipt. Without this
    // every launch failure reaches the ledger as one indistinguishable line.
    const engineFailed = !retryableInfrastructureFailure && !execution.executorFailure &&
      (execution.timedOut || Boolean(execution.signal) || execution.status !== 0);
    const launchFailure = engineFailed
      ? classifyLaunchFailure({
        agent: request.agent,
        stdout: execution.stdout,
        stderr: execution.stderr,
        credentialPresent: engineCredentialPresent(
          request.agent,
          request.credentialScopes.includes("model.invoke") ? credentialEnv : undefined,
        ),
      })
      : null;
    const diagnosticTail = engineFailed
      ? launchDiagnosticTail({ stdout: execution.stdout, stderr: execution.stderr, env: sanitizeEnv })
      : "";
    const failureNarrative = launchFailure
      ? [
        `loop action failed (reason=${launchFailure.reason})`,
        launchFailure.remediation,
        subjectError,
        receiptError,
        diagnosticTail,
      ].filter(Boolean).join(" ")
      : subjectError || receiptError || execution.stdout || execution.stderr ||
        (failed ? "loop action failed" : "loop action completed");
    result = {
      version: 1,
      kind: "loop_action_result",
      event_id: randomUUID(),
      action_id: request.actionId,
      attempt_id: request.attemptId,
      request_hash: request.requestHash,
      outcome: retryableInfrastructureFailure || launchFailure?.retryable
        ? "retryable_infrastructure_failure"
        : failed ? "failure" : "success",
      native_session_id: execution.nativeSessionId ?? request.nativeSessionId ?? null,
      subject: subject ?? parsedReceipt?.subject?.post ?? null,
      receipt: parsedReceipt
        ? canonicalJson(parsedReceipt)
        : sanitizeArtifactText(retryableInfrastructureFailure
          ? execution.stderr || "loop action infrastructure failure"
          : failureNarrative, sanitizeEnv).slice(0, 128_000),
      created_at: now(),
    };
  } finally {
    const cleanups = [
      () => lockWorkerWorktree(request),
      () => lockActionDirectory(request),
      // Restoring agent access to the integration checkout is unsafe while
      // agent process termination is unconfirmed; keep it executor-locked.
      ...(execution?.processTerminationUnconfirmed
        ? []
        : [() => restoreIntegration(execution?.integrationRepoDir ?? integrationRepoDir)]),
    ];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (cleanupErrors.length > 0) {
    return {
      ...result,
      outcome: "retryable_infrastructure_failure",
      receipt: sanitizeArtifactText(`loop action cleanup failed: ${cleanupErrors.join("; ")}`, sanitizeEnv).slice(0, 128_000),
    };
  }
  return result;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const requestPath = resolve(arg("--request", process.env.OT_LOOP_REQUEST_FILE));
  const rawRequest = JSON.parse(readFileSync(requestPath, "utf8"));
  const request = validateLoopRequest(rawRequest);
  if (process.argv.includes("--validate-request")) {
    writeFileSync(1, `${canonicalJson(request)}\n`);
    return;
  }
  const credentialsPath = resolve(arg("--credentials", process.env.OT_LOOP_CREDENTIALS_FILE ?? loopCredentialsPath({
    attemptId: request.attemptId,
    actionId: request.actionId,
    rootDir: configuredActionRoot(),
  })));
  const credentialEnv = readLoopActionCredentialEnv(credentialsPath);
  const outputPath = resolve(arg("--output", process.env.OT_LOOP_RESULT_FILE ?? loopResultPath({
    attemptId: request.attemptId,
    actionId: request.actionId,
    rootDir: configuredActionRoot(),
  })));
  writeJsonAtomic(outputPath, executeLoopAction({ request, credentialEnv }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`execute-loop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
