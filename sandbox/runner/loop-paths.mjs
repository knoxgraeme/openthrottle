import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  chmodTree,
  chownTree,
  isRoot,
  pathInside as containedPath,
  prepareAgentOwnedDirectory,
} from "./filesystem-isolation.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { sanitizeArtifactText } from "./artifacts.mjs";

// Loop-action path and git-environment helpers shared by execute-loop.mjs and
// loop-agent-environment.mjs. Both need the identical contracts these
// helpers give, so they live in their own leaf module rather than one of the
// two importing it from the other (which used to be a circular import).

export function pathInside(root, child) {
  return containedPath(root, child, "loop action path escapes the executor root");
}

// Filename convention for the root-owned nonce file that fences a per-action
// native-session profile root: execute-loop.mjs verifies it on resume,
// loop-agent-environment.mjs writes it on materialization.
export const PROFILE_ROOT_FENCE_FILE = ".ot-profile-fence";

export const DEFAULT_ACTION_ROOT = "/var/lib/openthrottle/loop-actions";
export const ABSOLUTE_PATH = /^\/[^\u0000]{0,500}$/;
const ROOT_UID = 0;
const ROOT_GID = 0;
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

export function actionDirectory(request, rootDir = configuredActionRoot()) {
  return pathInside(pathInside(rootDir, request.attemptId), request.actionId);
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

export function runRootGit(repoDir, args, env = {}, { safeDirectories = [] } = {}) {
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

export function prepareRootReadOnlyDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o555 });
  if (isRoot()) chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o444, directoryMode: 0o555 });
}

export function packReachableBaseObjects(repoDir, destinationPackBase, subject = "HEAD", env = {}) {
  const result = runCapturedProcess("git", [...gitSafeDirectoryConfigArgs(repoDir), "pack-objects", "--revs", destinationPackBase], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
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
