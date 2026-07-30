import { chmodSync, chownSync, lchownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

const identities = new Map();

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
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const identity = identityForUser("agent");
  if (identity) chownTree(path, identity.uid, identity.gid);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}
