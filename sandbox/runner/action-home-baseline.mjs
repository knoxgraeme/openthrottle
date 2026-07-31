import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareAgentOwnedDirectory } from "./filesystem-isolation.mjs";

const CODEX_BASELINE_FILES = [
  "config.toml",
  "AGENTS.md",
  "installation_id",
  "models_cache.json",
];
const TRUSTED_CODEX_BASELINE = "/opt/openthrottle/action-home-baseline/codex";
const TRUSTED_CLAUDE_BASELINE = "/opt/openthrottle/action-home-baseline/claude";

function copyBaselineFile(sourceRoot, destinationRoot, relativePath) {
  const source = resolve(sourceRoot, relativePath);
  if (!existsSync(source)) return false;
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  if (!trustedBaselineEntry(metadata)) return false;
  const destination = resolve(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  return true;
}

function trustedBaselineEntry(metadata) {
  return metadata.uid === 0 && (metadata.isDirectory() || metadata.nlink === 1) && (metadata.mode & 0o022) === 0;
}

function copyTrustedDirectory(source, destination) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) return false;
  if (metadata.isFile()) {
    if (!trustedBaselineEntry(metadata)) return false;
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    return true;
  }
  if (!metadata.isDirectory()) return false;
  if (!trustedBaselineEntry(metadata)) return false;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) {
    if (!copyTrustedDirectory(join(source, entry), join(destination, entry))) {
      rmSync(destination, { recursive: true, force: true });
      return false;
    }
  }
  return true;
}

export function materializeCodexProfileBaseline({
  sourceHome = TRUSTED_CODEX_BASELINE,
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
  sourceHome = TRUSTED_CLAUDE_BASELINE,
  destinationHome,
}) {
  prepareAgentOwnedDirectory(destinationHome);
  const copied = [];
  for (const directory of ["skills"]) {
    const source = join(sourceHome, directory);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) continue;
    // Claude's baked OpenThrottle skills are non-secret runtime discovery
    // state. Credential files stay outside this RU5 baseline.
    const destination = join(destinationHome, directory);
    if (copyTrustedDirectory(source, destination)) copied.push(directory);
  }
  prepareAgentOwnedDirectory(destinationHome);
  return copied;
}
