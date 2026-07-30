import { chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";

const identities = new Map();
const ROOT_UID = 0;
const ROOT_GID = 0;
const PERSISTENT_AGENT_PRIVATE_ROOTS = [
  "/home/agent/.claude",
  "/home/agent/.codex",
  "/home/agent/.local/share/opencode",
  "/home/agent/.ot",
];

export function pathInside(root, child, errorMessage) {
  const rootPath = resolve(root);
  const childPath = resolve(rootPath, child);
  if (childPath !== rootPath && !childPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(errorMessage);
  }
  return childPath;
}

export function chmodTree(path, { fileMode, directoryMode = fileMode }) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  chmodSync(path, metadata.isDirectory() ? directoryMode : fileMode);
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(path)) chmodTree(resolve(path, entry), { fileMode, directoryMode });
}

export function chmodOwnerPrivateTree(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  const fileMode = (metadata.mode & 0o111) === 0 ? 0o600 : 0o700;
  chmodSync(path, metadata.isDirectory() ? 0o700 : fileMode);
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(path)) chmodOwnerPrivateTree(resolve(path, entry));
}

export function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export function identityForUser(name) {
  if (!isRoot()) return null;
  if (!identities.has(name)) {
    const uid = spawnSync("id", ["-u", name], { encoding: "utf8" });
    const gid = spawnSync("id", ["-g", name], { encoding: "utf8" });
    if (uid.status !== 0 || gid.status !== 0 || !/^\d+\n?$/.test(uid.stdout) || !/^\d+\n?$/.test(gid.stdout)) {
      throw new Error(`could not resolve the installed ${name} identity`);
    }
    identities.set(name, { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) });
  }
  return identities.get(name);
}

export function chownTree(path, uid, gid) {
  if (!isRoot()) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    lchownSync(path, uid, gid);
    return;
  }
  chownSync(path, uid, gid);
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(path)) chownTree(resolve(path, entry), uid, gid);
}

export function prepareAgentOwnedDirectory(path) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const identity = identityForUser("agent");
  if (identity) chownTree(path, identity.uid, identity.gid);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

export function lockPersistentAgentPrivateRoots(paths = PERSISTENT_AGENT_PRIVATE_ROOTS) {
  if (!isRoot()) return [];
  const locked = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const snapshot = [...snapshotProfileBoundaryPaths(path), ...snapshotPrivateTree(path)];
    try {
      lockProfileBoundaryPaths(path);
      lockPrivateTree(path);
      locked.push(snapshot);
    } catch (error) {
      throw withLockedPersistentProfiles(error, [...locked, snapshot]);
    }
  }
  return locked;
}

export function withLockedPersistentProfiles(error, lockedPersistentProfiles) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.lockedPersistentProfiles = [...lockedPersistentProfiles];
  wrapped.retryableInfrastructureFailure = true;
  return wrapped;
}

export function lockedPersistentProfilesFrom(error, fallback = []) {
  return Array.isArray(error?.lockedPersistentProfiles) ? error.lockedPersistentProfiles : fallback;
}

function lockPrivateTree(path) {
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o400, directoryMode: 0o500 });
}

function snapshotPrivateTree(path, snapshots = []) {
  const metadata = lstatSync(path);
  snapshots.push(snapshotOnePath(path, metadata));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return snapshots;
  for (const entry of readdirSync(path)) snapshotPrivateTree(resolve(path, entry), snapshots);
  return snapshots;
}

function snapshotOnePath(path, metadata = lstatSync(path)) {
  return {
    path,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o7777,
    dev: metadata.dev,
    ino: metadata.ino,
    symbolicLink: metadata.isSymbolicLink(),
    directory: metadata.isDirectory(),
  };
}

function snapshotProfileBoundaryPaths(path) {
  const parent = profileBoundaryPath(path);
  if (!parent) return [];
  try {
    return [snapshotOnePath(parent)];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function lockProfileBoundaryPaths(path) {
  const parent = profileBoundaryPath(path);
  if (!parent) return;
  try {
    chownSync(parent, ROOT_UID, ROOT_GID);
    chmodSync(parent, 0o711);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function profileBoundaryPath(path) {
  const parent = dirname(path);
  if (parent === path) return null;
  return parent;
}

function sameSnapshotEntry(entry, metadata) {
  return metadata.dev === entry.dev &&
    metadata.ino === entry.ino &&
    metadata.isSymbolicLink() === entry.symbolicLink &&
    metadata.isDirectory() === entry.directory;
}

function restoreProfileSnapshot(snapshot) {
  const entries = [...snapshot].sort((left, right) => right.path.length - left.path.length);
  for (const entry of entries) {
    let metadata;
    try {
      metadata = lstatSync(entry.path);
    } catch {
      continue;
    }
    if (!sameSnapshotEntry(entry, metadata)) continue;
    if (metadata.isSymbolicLink()) {
      lchownSync(entry.path, entry.uid, entry.gid);
      continue;
    }
    chownSync(entry.path, entry.uid, entry.gid);
    chmodSync(entry.path, entry.mode);
  }
}

function restoreLegacyProfilePath(path) {
  if (!isRoot()) return [];
  if (!existsSync(path)) return [];
  const identity = identityForUser("agent");
  if (!identity) return [];
  chownTree(path, identity.uid, identity.gid);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
  return [path];
}

export function restorePersistentAgentPrivateRoots(paths = PERSISTENT_AGENT_PRIVATE_ROOTS) {
  if (!isRoot()) return [];
  if (paths.length === 0) return [];
  const restored = [];
  const errors = [];
  for (const entry of paths) {
    try {
      if (Array.isArray(entry)) {
        restoreProfileSnapshot(entry);
        if (entry[0]?.path) restored.push(entry[0].path);
      } else {
        restored.push(...restoreLegacyProfilePath(entry));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`persistent profile restoration failed: ${errors.join("; ")}`);
  return restored;
}
