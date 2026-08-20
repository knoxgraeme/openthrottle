import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareAgentOwnedDirectory } from "./filesystem-isolation.mjs";

const CODEX_BASELINE_FILES = [
  "config.toml",
  "AGENTS.md",
  "installation_id",
  "models_cache.json",
];
const DEFAULT_ACTION_HOME_BASELINE_ROOT = "/opt/openthrottle/action-home-baseline";
const ABSOLUTE_PATH = /^\/[^\u0000]{0,500}$/;

function configuredActionHomeBaselineRoot(env = process.env) {
  const root = env.OT_ACTION_HOME_BASELINE_ROOT ?? DEFAULT_ACTION_HOME_BASELINE_ROOT;
  if (typeof root !== "string" || !ABSOLUTE_PATH.test(root)) throw new Error("action home baseline root is invalid");
  return resolve(root);
}

// A stale agent-created symlink at the destination would redirect the copy to
// an external target; remove it instead of following it.
function removeSymbolicDestination(destination) {
  let metadata;
  try {
    metadata = lstatSync(destination);
  } catch {
    return;
  }
  if (metadata.isSymbolicLink()) rmSync(destination, { force: true });
}

function copyBaselineFile(sourceRoot, destinationRoot, relativePath) {
  const source = resolve(sourceRoot, relativePath);
  if (!existsSync(source)) return false;
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  if (!trustedBaselineEntry(metadata)) return false;
  const destination = resolve(destinationRoot, relativePath);
  removeSymbolicDestination(dirname(destination));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  removeSymbolicDestination(destination);
  copyFileSync(source, destination);
  return true;
}

function trustedBaselineEntry(metadata) {
  return metadata.uid === 0 && (metadata.isDirectory() || metadata.nlink === 1) && (metadata.mode & 0o022) === 0;
}

export function materializeCodexProfileBaseline({
  sourceHome = join(configuredActionHomeBaselineRoot(), "codex"),
  destinationHome,
}) {
  prepareAgentOwnedDirectory(destinationHome);
  const copied = [];
  for (const file of CODEX_BASELINE_FILES) {
    if (copyBaselineFile(sourceHome, destinationHome, file)) copied.push(file);
  }
  prepareAgentOwnedDirectory(destinationHome);
  return copied;
}

export function materializeClaudeProfileBaseline({
  sourceHome: _sourceHome = join(configuredActionHomeBaselineRoot(), "claude"),
  destinationHome,
}) {
  prepareAgentOwnedDirectory(destinationHome);
  // Skills are action inputs, not profile baseline. The action-profile
  // materializer installs only the bundle-allowlisted packages after the
  // engine home has been reset, so no sibling or unrelated skill is ambient.
  return [];
}
