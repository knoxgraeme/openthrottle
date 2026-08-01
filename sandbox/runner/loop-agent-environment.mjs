import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  chmodReadOnlyPreservingExecuteTree,
  chownTree,
  identityForUser,
  isRoot,
  pathInside as containedPath,
  prepareAgentOwnedDirectory,
  resetAgentOwnedDirectory,
} from "./filesystem-isolation.mjs";
import { materializeClaudeProfileBaseline, materializeCodexProfileBaseline } from "./action-home-baseline.mjs";
import { materializeNativeSessionState, nativeSessionStoragePath } from "./native-session-package.mjs";
import { materializeRepositorySkillPackage } from "./repository-skills.mjs";
import { appendCodexMcpConfig, selectAllowedMcpServers, writeClaudeMcpConfigFile } from "./loop-mcp-config.mjs";
import { actionDirectory, configuredActionRoot, gitSafeDirectoryEnv, prepareLoopGitObjectEnvironment, prepareRootReadOnlyDirectory } from "./execute-loop.mjs";

const ROOT_UID = 0;
const ROOT_GID = 0;

function pathInside(root, child) {
  return containedPath(root, child, "loop action path escapes the executor root");
}

function prepareExecutorOwnedProfileRoot(path) {
  if (!isRoot()) return;
  mkdirSync(path, { recursive: true, mode: 0o555 });
  chownSync(path, ROOT_UID, ROOT_GID);
  chmodSync(path, 0o555);
}

function lockExecutorOwnedSkillTree(path) {
  if (!existsSync(path)) return;
  if (isRoot()) chownTree(path, ROOT_UID, ROOT_GID);
  chmodReadOnlyPreservingExecuteTree(path);
}

// Same filename convention as assertProfileRootFence in execute-loop.mjs
// (duplicated rather than exported/imported back: a plain literal, not logic).
const PROFILE_ROOT_FENCE_FILE = ".ot-profile-fence";

// Inode identity cannot detect replace-after-delete on filesystems that
// recycle inode numbers (ext4). A root-owned nonce file works everywhere:
// the agent UID cannot create a uid-0 regular file with the sealed content.
function writeProfileRootFence(profileRoot) {
  const nonce = randomUUID();
  const fencePath = containedPath(profileRoot, PROFILE_ROOT_FENCE_FILE, "profile fence escapes its root");
  writeFileSync(fencePath, nonce, { mode: 0o600 });
  if (isRoot()) chownSync(fencePath, ROOT_UID, ROOT_GID);
  return nonce;
}

function writeCodexAuthFile(codexHome, authJson) {
  const path = pathInside(codexHome, "auth.json");
  // Agent-owned and writable: Codex may rotate its own auth.json mid-action.
  // The rotated state is wiped along with the rest of the action directory by
  // lockCurrentActionDirectory once the action completes.
  writeFileSync(path, authJson, { mode: 0o600 });
  if (isRoot()) {
    const identity = identityForUser("agent");
    if (identity) chownSync(path, identity.uid, identity.gid);
  }
}

function prepareActionHomeEnvironment(request, credentialEnv = {}) {
  const currentActionDirectory = actionDirectory(request);
  const home = pathInside(currentActionDirectory, "home");
  resetAgentOwnedDirectory(home);
  const env = [`HOME=${home}`];
  let nativeSessionProfileRoot = home;
  let mcpConfigPath = null;
  const selectedMcpServers = selectAllowedMcpServers(request.allowedMcpServers);
  if (request.agent === "claude") {
    const profileRoot = pathInside(home, ".claude");
    materializeClaudeProfileBaseline({ destinationHome: profileRoot });
    lockExecutorOwnedSkillTree(pathInside(profileRoot, "skills"));
    materializeNativeSessionState({ request, profileRoot });
    prepareAgentOwnedDirectory(nativeSessionStoragePath(request.agent, profileRoot));
    if (Object.keys(selectedMcpServers).length > 0) {
      const mcpDir = pathInside(currentActionDirectory, "mcp");
      mcpConfigPath = writeClaudeMcpConfigFile(selectedMcpServers, mcpDir);
      if (mcpConfigPath) prepareRootReadOnlyDirectory(mcpDir);
    }
    prepareExecutorOwnedProfileRoot(profileRoot);
    nativeSessionProfileRoot = profileRoot;
  }
  if (request.agent === "codex") {
    const codexHome = pathInside(currentActionDirectory, "codex");
    resetAgentOwnedDirectory(codexHome);
    materializeCodexProfileBaseline({ destinationHome: codexHome });
    materializeNativeSessionState({ request, profileRoot: codexHome });
    prepareAgentOwnedDirectory(nativeSessionStoragePath(request.agent, codexHome));
    // MCP config wiring runs before the auth-file write: appendCodexMcpConfig
    // fails closed for a remote-only server, and that check must not leave
    // the real CODEX_AUTH_JSON secret already materialized on disk.
    if (Object.keys(selectedMcpServers).length > 0) {
      appendCodexMcpConfig(selectedMcpServers, pathInside(codexHome, "config.toml"));
    }
    if (credentialEnv.CODEX_AUTH_JSON) writeCodexAuthFile(codexHome, credentialEnv.CODEX_AUTH_JSON);
    prepareExecutorOwnedProfileRoot(codexHome);
    env.push(`CODEX_HOME=${codexHome}`);
    nativeSessionProfileRoot = codexHome;
  }
  return {
    env,
    nativeSessionProfileRoot,
    profileRootFenceNonce: writeProfileRootFence(nativeSessionProfileRoot),
    mcpConfigPath,
  };
}

function prepareLoopTransportEnvironment(request) {
  const currentActionDirectory = actionDirectory(request);
  const outbox = pathInside(currentActionDirectory, "outbox");
  const inbox = pathInside(currentActionDirectory, "inbox");
  const processedInbox = pathInside(currentActionDirectory, "inbox-processed");
  const nativeSessionRoot = pathInside(currentActionDirectory, "native-session");
  for (const directory of [outbox, inbox, processedInbox, nativeSessionRoot]) {
    resetAgentOwnedDirectory(directory);
  }
  return [
    `OT_OUTBOX_DIR=${outbox}`,
    `OT_INBOX_DIR=${inbox}`,
    `OT_INBOX_PROCESSED_DIR=${processedInbox}`,
    `OT_NATIVE_SESSION_DIR=${nativeSessionRoot}`,
  ];
}

function loopSkillDiscoveryRoot(request, actionRoot = configuredActionRoot()) {
  const currentActionDirectory = actionDirectory(request, actionRoot);
  if (request.agent === "codex") return pathInside(pathInside(currentActionDirectory, "codex"), "skills");
  return pathInside(pathInside(pathInside(currentActionDirectory, "home"), ".claude"), "skills");
}

const SAFE_PASSTHROUGH_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "TZ"];

// The image's own baked PATH/locale, not an operator's personal environment.
// Captured explicitly (rather than left to full inheritance) so the loop
// action environment is exactly this fixed baseline plus its declared
// credentials, never whatever else happens to be set in the sandbox process.
function safeBaseEnv(env = process.env) {
  const result = {};
  for (const name of SAFE_PASSTHROUGH_ENV_NAMES) if (typeof env[name] === "string") result[name] = env[name];
  return result;
}

// Never argv strings: an execve() argument vector is visible to any other
// process via /proc/<pid>/cmdline, unlike an explicit child-process env map
// (bounded-process-helper.mjs spawns with exactly this object, replacing
// inheritance rather than appending to it). CODEX_AUTH_JSON is excluded here
// too -- it is materialized to a file (writeCodexAuthFile) instead.
function credentialPassthroughEnv(credentialEnv) {
  const result = {};
  for (const [name, value] of Object.entries(credentialEnv)) {
    if (name !== "CODEX_AUTH_JSON") result[name] = value;
  }
  return result;
}

// Not required elsewhere in the module surface, but exported for the direct
// unit test that exercises Codex auth-file materialization without needing
// the root-owned trusted baseline (materializeCodexProfileBaseline) that the
// full prepareActionHomeEnvironment pipeline depends on.
export { writeCodexAuthFile };

export function prepareLoopAgentEnvironment(request, repoDir, credentialEnv = {}) {
  const gitObjectEnv = prepareLoopGitObjectEnvironment(request, repoDir);
  const transportEnv = prepareLoopTransportEnvironment(request);
  const homeEnv = prepareActionHomeEnvironment(request, credentialEnv);
  const repositoryViewGitEnv = request.worktree ? [] : gitSafeDirectoryEnv(repoDir);
  const env = [
    "USER=agent", "GIT_OPTIONAL_LOCKS=0",
    ...repositoryViewGitEnv, ...gitObjectEnv.env, ...transportEnv, ...homeEnv.env,
  ];
  // The process env handed to gosu itself: safeBaseEnv() replaces whatever
  // the sandbox process actually inherited (including any stage-wide
  // credential env set for the whole attempt), so this action's engine
  // process sees exactly this fixed baseline plus its own credentials --
  // never a leftover from another role/action, and never via argv.
  const secretEnv = { ...safeBaseEnv(), ...credentialPassthroughEnv(credentialEnv) };
  if (request.repositorySkill) {
    materializeRepositorySkillPackage({
      packageInfo: request.repositorySkill,
      repoDir,
      agent: request.agent,
      discoveryRoot: loopSkillDiscoveryRoot(request),
    });
  }
  return {
    env,
    secretEnv,
    gitObjectEnv: gitObjectEnv.values,
    nativeSessionProfileRoot: homeEnv.nativeSessionProfileRoot,
    profileRootFenceNonce: homeEnv.profileRootFenceNonce,
    mcpConfigPath: homeEnv.mcpConfigPath,
  };
}
