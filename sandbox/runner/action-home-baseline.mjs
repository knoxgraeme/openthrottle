import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chownTree, chmodTree, identityForUser } from "./filesystem-isolation.mjs";

const CODEX_BASELINE_FILES = [
  "config.toml",
  "AGENTS.md",
  "installation_id",
  "models_cache.json",
];

function copyBaselineFile(sourceRoot, destinationRoot, relativePath) {
  const source = resolve(sourceRoot, relativePath);
  if (!existsSync(source)) return false;
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  const destination = resolve(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  return true;
}

function sealForAgent(path) {
  const identity = identityForUser("agent");
  if (identity) chownTree(path, identity.uid, identity.gid);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

function copyTrustedDirectory(source, destination) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) return false;
  if (metadata.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    return true;
  }
  if (!metadata.isDirectory()) return false;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) {
    copyTrustedDirectory(join(source, entry), join(destination, entry));
  }
  return true;
}

export function materializeCodexProfileBaseline({
  sourceHome = "/home/agent/.codex",
  destinationHome,
}) {
  mkdirSync(destinationHome, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const file of CODEX_BASELINE_FILES) {
    if (copyBaselineFile(sourceHome, destinationHome, file)) copied.push(file);
  }
  sealForAgent(destinationHome);
  return copied;
}

export function materializeClaudeProfileBaseline({
  sourceHome = "/home/agent/.claude",
  destinationHome,
}) {
  mkdirSync(destinationHome, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const directory of ["skills"]) {
    const source = join(sourceHome, directory);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) continue;
    // Claude's baked OpenThrottle skills are non-secret runtime discovery
    // state. Credential files stay outside this RU5 baseline.
    const destination = join(destinationHome, directory);
    if (copyTrustedDirectory(source, destination)) copied.push(directory);
  }
  sealForAgent(destinationHome);
  return copied;
}
