import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { chmodTree, chownTree, isRoot, pathInside, prepareAgentOwnedDirectory } from "./filesystem-isolation.mjs";

const DEFAULT_NATIVE_SESSION_SOURCE_ROOT = "/var/lib/openthrottle/native-sessions";
const NATIVE_SESSION_PACKAGE_MANIFEST = "openthrottle-native-session.json";
const NATIVE_SESSION_PACKAGE_SCHEMA = "openthrottle.native-session-package/v1";
const MAX_NATIVE_SESSION_FILES = 128;
const MAX_NATIVE_SESSION_BYTES = 4 * 1024 * 1024;
const ROOT_UID = 0;
const ROOT_GID = 0;
const ABSOLUTE_PATH = /^\/[^\u0000]{0,500}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PACKAGE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function string(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function configuredNativeSessionSourceRoot(env = process.env) {
  const root = env.OT_NATIVE_SESSION_SOURCE_ROOT ?? DEFAULT_NATIVE_SESSION_SOURCE_ROOT;
  if (typeof root !== "string" || !ABSOLUTE_PATH.test(root)) throw new Error("native session source root is invalid");
  return resolve(root);
}

function nativeSessionPackageDirectory({ sourceRoot = configuredNativeSessionSourceRoot(), agent, nativeSessionId }) {
  const agentRoot = pathInside(sourceRoot, string(agent, "agent", PACKAGE_PATH_ID));
  const packageId = string(nativeSessionId, "nativeSessionId", PACKAGE_PATH_ID);
  return pathInside(agentRoot, packageId, "native session package path escapes its root");
}

function copyTrustedTree(source, destination, { skipManifest = false } = {}) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) throw new Error("native session package cannot contain symlinks");
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source)) {
      if (skipManifest && entry === NATIVE_SESSION_PACKAGE_MANIFEST) continue;
      copyTrustedTree(resolve(source, entry), resolve(destination, entry), { skipManifest });
    }
    return;
  }
  if (!metadata.isFile()) throw new Error("native session package can contain only regular files");
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function relativePackagePath(root, path) {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`) || relativePath === NATIVE_SESSION_PACKAGE_MANIFEST) {
    throw new Error("native session package path escapes its root");
  }
  return relativePath.split(sep).join("/");
}

function collectNativeSessionFiles(root, path = root, files = [], totals = { bytes: 0 }) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("native session package cannot contain symlinks");
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (path === root && entry === NATIVE_SESSION_PACKAGE_MANIFEST) continue;
      collectNativeSessionFiles(root, resolve(path, entry), files, totals);
    }
    return files;
  }
  if (!metadata.isFile()) throw new Error("native session package can contain only regular files");
  if (files.length >= MAX_NATIVE_SESSION_FILES) throw new Error("native session package has too many files");
  if (metadata.size > MAX_NATIVE_SESSION_BYTES) throw new Error("native session package file is too large");
  const bytes = readFileSync(path);
  totals.bytes += bytes.length;
  if (totals.bytes > MAX_NATIVE_SESSION_BYTES) throw new Error("native session package is too large");
  files.push({
    path: relativePackagePath(root, path),
    size: bytes.length,
    digest: digest(bytes),
  });
  return files;
}

function preflightNativeSessionSource(sessionsSource) {
  collectNativeSessionFiles(sessionsSource);
}

function assertPrivateNativeSessionPackage(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("native session package must be a real directory");
  if ((metadata.mode & 0o022) !== 0) throw new Error("native session package must not be group or world writable");
  if (isRoot() && (metadata.uid !== ROOT_UID || metadata.gid !== ROOT_GID)) {
    throw new Error("native session package must be executor-owned");
  }
  for (const entry of readdirSync(path)) {
    const child = resolve(path, entry);
    const childMetadata = lstatSync(child);
    if ((childMetadata.mode & 0o022) !== 0) throw new Error("native session package entries must not be group or world writable");
    if (isRoot() && (childMetadata.uid !== ROOT_UID || childMetadata.gid !== ROOT_GID)) {
      throw new Error("native session package entries must be executor-owned");
    }
    if (childMetadata.isDirectory()) assertPrivateNativeSessionPackage(child);
  }
}

function validateNativeSessionPackage({ source, request }) {
  assertPrivateNativeSessionPackage(source);
  const manifestPath = resolve(source, NATIVE_SESSION_PACKAGE_MANIFEST);
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new Error("authorized native session package manifest is unavailable");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== NATIVE_SESSION_PACKAGE_SCHEMA) throw new Error("native session package schema is unsupported");
  if (manifest.agent !== request.agent || manifest.nativeSessionId !== request.nativeSessionId) {
    throw new Error("native session package identity mismatch");
  }
  const unsigned = {
    schema: manifest.schema,
    agent: manifest.agent,
    nativeSessionId: manifest.nativeSessionId,
    files: manifest.files,
  };
  if (manifest.packageDigest !== digest(canonicalJson(unsigned))) throw new Error("native session package digest mismatch");
  const actualFiles = collectNativeSessionFiles(source);
  if (canonicalJson(actualFiles) !== canonicalJson(manifest.files)) {
    throw new Error("native session package file digest mismatch");
  }
}

export function sealNativeSessionPackage({
  agent,
  nativeSessionId,
  profileRoot,
  sourceRoot = configuredNativeSessionSourceRoot(),
}) {
  if (!nativeSessionId || !profileRoot) return null;
  const sessionsSource = resolve(profileRoot, "sessions");
  if (!existsSync(sessionsSource) || !lstatSync(sessionsSource).isDirectory()) return null;
  preflightNativeSessionSource(sessionsSource);
  const destination = nativeSessionPackageDirectory({ sourceRoot, agent, nativeSessionId });
  try {
    if (existsSync(destination)) chmodTree(destination, { fileMode: 0o600, directoryMode: 0o700 });
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    copyTrustedTree(sessionsSource, resolve(destination, "sessions"));
    const files = collectNativeSessionFiles(destination);
    const unsigned = {
      schema: NATIVE_SESSION_PACKAGE_SCHEMA,
      agent,
      nativeSessionId,
      files,
    };
    writeFileSync(resolve(destination, NATIVE_SESSION_PACKAGE_MANIFEST), canonicalJson({
      ...unsigned,
      packageDigest: digest(canonicalJson(unsigned)),
    }), { mode: 0o600 });
    if (isRoot()) chownTree(destination, ROOT_UID, ROOT_GID);
    chmodTree(destination, { fileMode: 0o400, directoryMode: 0o500 });
    return destination;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function materializeNativeSessionState({ request, profileRoot }) {
  if (!request.nativeSessionId || request.contextPolicy === "fresh") return null;
  const sourceRoot = configuredNativeSessionSourceRoot();
  const source = nativeSessionPackageDirectory({
    sourceRoot,
    agent: request.agent,
    nativeSessionId: request.nativeSessionId,
  });
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error("authorized native session state is unavailable");
  }
  validateNativeSessionPackage({ source, request });
  copyTrustedTree(source, profileRoot, { skipManifest: true });
  prepareAgentOwnedDirectory(profileRoot);
  return source;
}

export function extractNativeSessionId(output, agent) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const candidate = agent === "claude"
        ? event.session_id
        : agent === "codex" && event.type === "thread.started"
          ? event.thread_id ?? event.threadId ?? event.id
          : agent === "opencode"
            ? event.sessionID
            : undefined;
      if (typeof candidate === "string" && PACKAGE_PATH_ID.test(candidate)) return candidate;
    } catch {
      // Agent stderr/non-JSON diagnostics are not session evidence.
    }
  }
  return null;
}
