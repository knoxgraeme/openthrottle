import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { chmodTree, chownTree, isRoot, pathInside, prepareAgentOwnedDirectory } from "./filesystem-isolation.mjs";
import { string } from "./validate.mjs";

const DEFAULT_NATIVE_SESSION_SOURCE_ROOT = "/var/lib/openthrottle/native-sessions";
const NATIVE_SESSION_PACKAGE_MANIFEST = "openthrottle-native-session.json";
const NATIVE_SESSION_PACKAGE_SCHEMA = "openthrottle.native-session-package/v1";
// Real Claude Code durable transcripts embed full tool outputs, and a
// multi-stage resumed session appends every stage into one JSONL, so packages
// legitimately grow far past a few MiB. These bounds exist to keep packages
// bounded against the 5 GiB sandbox disk, not to police typical size; the
// byte cap applies both per file and to the whole package.
export const MAX_NATIVE_SESSION_FILES = 1024;
export const MAX_NATIVE_SESSION_BYTES = 256 * 1024 * 1024;
// Retention and uncompressed transfer intentionally share one aggregate cap.
// A package accepted by validateNativeSessionPackage therefore cannot be
// rejected merely because a second, smaller archive limit exists.
export const MAX_NATIVE_SESSION_TRANSFER_BYTES = MAX_NATIVE_SESSION_BYTES;
const NATIVE_SESSION_COPY_MARGIN_BYTES = 16 * 1024 * 1024;
const ROOT_UID = 0;
const ROOT_GID = 0;
const ABSOLUTE_PATH = /^\/[^\u0000]{0,500}$/;
const PACKAGE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const OPENCODE_SESSION_EVENT_TYPES = new Set(["message", "step_start", "step_finish"]);

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

function prepareNativeSessionPackageParent({ sourceRoot, agent }) {
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceMetadata = lstatSync(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("native session source root must be a real directory");
  }
  const agentRoot = pathInside(sourceRoot, string(agent, "agent", PACKAGE_PATH_ID));
  if (existsSync(agentRoot)) {
    const metadata = lstatSync(agentRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("native session package parent must be a real directory");
    }
  } else {
    mkdirSync(agentRoot, { recursive: false, mode: 0o700 });
  }
}

function copyTrustedTree(source, destination, { skipManifest = false, copyFile = copyFileSync } = {}) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) throw new Error("native session package cannot contain symlinks");
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source)) {
      if (skipManifest && entry === NATIVE_SESSION_PACKAGE_MANIFEST) continue;
      copyTrustedTree(resolve(source, entry), resolve(destination, entry), { skipManifest, copyFile });
    }
    return;
  }
  if (!metadata.isFile()) throw new Error("native session package can contain only regular files");
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  copyFile(source, destination);
}

function relativeContainedPath(root, path, errorMessage) {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
    throw new Error(errorMessage);
  }
  return relativePath.split(sep).join("/");
}

function relativePackagePath(root, path) {
  const relativePath = relativeContainedPath(root, path, "native session package path escapes its root");
  if (relativePath === NATIVE_SESSION_PACKAGE_MANIFEST) throw new Error("native session package path escapes its root");
  return relativePath;
}

function jsonEventCarriesSessionId(line, nativeSessionId, agent) {
  try {
    const record = JSON.parse(line);
    return nativeSessionIdFromDurableRecord(record, agent) === nativeSessionId;
  } catch {
    return false;
  }
}

function nativeSessionIdFromEvent(event, agent) {
  if (agent === "claude" && event.type === "system") {
    return event.session_id ?? event.sessionId ?? null;
  }
  if (agent === "codex" && event.type === "thread.started") {
    return event.thread_id ?? event.threadId ?? event.id ?? null;
  }
  if (agent === "opencode" && OPENCODE_SESSION_EVENT_TYPES.has(event.type)) {
    return event.sessionID ?? event.sessionId ?? null;
  }
  return null;
}

function nativeSessionIdFromDurableRecord(record, agent) {
  if (agent === "claude") {
    // Claude durable transcripts (~/.claude/projects/<slug>/<id>.jsonl) carry
    // no type:"system" records; every line carries a top-level camelCase
    // sessionId regardless of record type. type:"system" is stdout-only.
    return record.sessionId ?? record.session_id ?? null;
  }
  if (agent === "codex" && record.type === "session_meta") {
    return record.payload?.id ?? null;
  }
  if (agent === "opencode" && OPENCODE_SESSION_EVENT_TYPES.has(record.type)) {
    return record.sessionID ?? record.sessionId ?? null;
  }
  return null;
}

function exactContentsCarrySessionId(bytes, nativeSessionId, agent) {
  return bytes.toString("utf8")
    .split(/\r?\n/)
    .some((line) => line.trim() && jsonEventCarriesSessionId(line, nativeSessionId, agent));
}

function collectNativeSessionFiles(root, path = root, files = [], totals = { bytes: 0 }, sessionEvidence = null) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("native session package cannot contain symlinks");
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (path === root && entry === NATIVE_SESSION_PACKAGE_MANIFEST) continue;
      collectNativeSessionFiles(root, resolve(path, entry), files, totals, sessionEvidence);
    }
    return files;
  }
  if (!metadata.isFile()) throw new Error("native session package can contain only regular files");
  if (files.length >= MAX_NATIVE_SESSION_FILES) throw new Error("native session package has too many files");
  if (metadata.size > MAX_NATIVE_SESSION_BYTES) throw new Error("native session package file is too large");
  const bytes = readFileSync(path);
  totals.bytes += bytes.length;
  if (totals.bytes > MAX_NATIVE_SESSION_BYTES) throw new Error("native session package is too large");
  const relativePath = relativePackagePath(root, path);
  if (sessionEvidence &&
    !sessionEvidence.contains &&
    exactContentsCarrySessionId(bytes, sessionEvidence.nativeSessionId, sessionEvidence.agent)) {
    sessionEvidence.contains = true;
  }
  files.push({
    path: relativePath,
    size: bytes.length,
    digest: digest(bytes),
  });
  return files;
}

function collectNativeSessionPackage(root, nativeSessionId, agent) {
  const sessionEvidence = { agent, nativeSessionId, contains: false };
  const totals = { bytes: 0 };
  const files = collectNativeSessionFiles(root, root, [], totals, sessionEvidence);
  return { files, bytes: totals.bytes, containsSessionId: files.length > 0 && sessionEvidence.contains };
}

function preflightNativeSessionSource(sessionsSource) {
  const totals = { bytes: 0 };
  collectNativeSessionFiles(sessionsSource, sessionsSource, [], totals);
  return totals.bytes;
}

function retryableStorageError(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "ENOSPC";
  error.retryableInfrastructureFailure = true;
  return error;
}

function filesystemAvailableBytes(path) {
  const stats = statfsSync(path, { bigint: true });
  const available = stats.bavail * stats.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}

function assertCopySpace({ destinationRoot, sourceBytes, replacementBytes = 0, availableBytes = undefined }) {
  const available = availableBytes ?? filesystemAvailableBytes(destinationRoot);
  const required = sourceBytes + replacementBytes + NATIVE_SESSION_COPY_MARGIN_BYTES;
  if (!Number.isSafeInteger(available) || available < required) {
    throw retryableStorageError(
      `native session transfer has insufficient space: required=${required} available=${available}`,
    );
  }
}

function scratchPathInfo(entry, nativeSessionId) {
  const escaped = nativeSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = entry.match(new RegExp(`^\\.${escaped}\\.(staging|rollback)-(\\d+)-`));
  return match ? { kind: match[1], pid: Number(match[2]) } : null;
}

function processIsActive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Reconcile only scratch entries owned by this exact agent/session lineage.
// Directory entries are inspected with lstat and symlinks are unlinked, never
// traversed. A stale rollback is restored when it is the last valid package.
export function sweepNativeSessionScratch({
  agent,
  nativeSessionId,
  sourceRoot = configuredNativeSessionSourceRoot(),
}) {
  const destination = nativeSessionPackageDirectory({ sourceRoot, agent, nativeSessionId });
  const parent = dirname(destination);
  if (!existsSync(parent)) return { removed: 0, restored: false };
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("native session package parent must be a real directory");
  }
  const stale = [];
  for (const entry of readdirSync(parent)) {
    const info = scratchPathInfo(entry, nativeSessionId);
    if (!info || processIsActive(info.pid)) continue;
    stale.push({ path: pathInside(parent, entry, "native session scratch path escapes its root"), ...info });
  }
  let restored = false;
  if (!existsSync(destination)) {
    const rollback = stale.find((entry) => entry.kind === "rollback" &&
      !lstatSync(entry.path).isSymbolicLink() && lstatSync(entry.path).isDirectory());
    if (rollback) {
      renameSync(rollback.path, destination);
      stale.splice(stale.indexOf(rollback), 1);
      restored = true;
    }
  }
  for (const entry of stale) {
    const metadata = lstatSync(entry.path);
    rmSync(entry.path, metadata.isSymbolicLink() ? { force: true } : { recursive: true, force: true });
  }
  return { removed: stale.length, restored };
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
  const { files: actualFiles, containsSessionId } = collectNativeSessionPackage(source, request.nativeSessionId, request.agent);
  if (canonicalJson(actualFiles) !== canonicalJson(manifest.files)) {
    throw new Error("native session package file digest mismatch");
  }
  if (!containsSessionId) {
    throw new Error("native session package does not contain the reported native session id");
  }
}

export function sealNativeSessionPackage({
  agent,
  nativeSessionId,
  profileRoot,
  sourceRoot = configuredNativeSessionSourceRoot(),
  availableBytes = undefined,
  copyFile = copyFileSync,
  supersededNativeSessionId = null,
}) {
  if (!nativeSessionId || !profileRoot) return null;
  const sessionsSource = nativeSessionStoragePath(agent, profileRoot);
  if (!existsSync(sessionsSource) || !lstatSync(sessionsSource).isDirectory()) return null;
  const relativeSessionRoot = relativeContainedPath(profileRoot, sessionsSource, "native session storage path escapes its profile root");
  const sourceBytes = preflightNativeSessionSource(sessionsSource);
  const destination = nativeSessionPackageDirectory({ sourceRoot, agent, nativeSessionId });
  prepareNativeSessionPackageParent({ sourceRoot, agent });
  sweepNativeSessionScratch({ agent, nativeSessionId, sourceRoot });
  const replacementBytes = existsSync(destination)
    ? collectNativeSessionFiles(destination).reduce((total, file) => total + file.size, 0)
    : 0;
  assertCopySpace({
    destinationRoot: dirname(destination),
    sourceBytes,
    replacementBytes,
    availableBytes,
  });
  const staging = resolve(dirname(destination), `.${nativeSessionId}.staging-${process.pid}-${randomUUID()}`);
  const rollback = resolve(dirname(destination), `.${nativeSessionId}.rollback-${process.pid}-${randomUUID()}`);
  let movedDestination = false;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    copyTrustedTree(sessionsSource, resolve(staging, relativeSessionRoot), { copyFile });
    const { files, containsSessionId } = collectNativeSessionPackage(staging, nativeSessionId, agent);
    if (!containsSessionId) {
      throw new Error("native session package does not contain the reported native session id");
    }
    const unsigned = {
      schema: NATIVE_SESSION_PACKAGE_SCHEMA,
      agent,
      nativeSessionId,
      files,
    };
    writeFileSync(resolve(staging, NATIVE_SESSION_PACKAGE_MANIFEST), canonicalJson({
      ...unsigned,
      packageDigest: digest(canonicalJson(unsigned)),
    }), { mode: 0o600 });
    if (isRoot()) chownTree(staging, ROOT_UID, ROOT_GID);
    chmodTree(staging, { fileMode: 0o400, directoryMode: 0o500 });
    validateNativeSessionPackage({
      source: staging,
      request: { agent, nativeSessionId },
    });
    if (existsSync(destination)) {
      chmodTree(destination, { fileMode: 0o600, directoryMode: 0o700 });
      renameSync(destination, rollback);
      movedDestination = true;
    }
    renameSync(staging, destination);
    movedDestination = false;
    rmSync(rollback, { recursive: true, force: true });
    if (supersededNativeSessionId && supersededNativeSessionId !== nativeSessionId) {
      const superseded = nativeSessionPackageDirectory({
        sourceRoot,
        agent,
        nativeSessionId: supersededNativeSessionId,
      });
      if (existsSync(superseded)) {
        const metadata = lstatSync(superseded);
        if (!metadata.isSymbolicLink()) chmodTree(superseded, { fileMode: 0o600, directoryMode: 0o700 });
        rmSync(superseded, metadata.isSymbolicLink() ? { force: true } : { recursive: true, force: true });
      }
    }
    return destination;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (movedDestination && existsSync(rollback) && !existsSync(destination)) {
      try {
        renameSync(rollback, destination);
        movedDestination = false;
      } catch {
        // Preserve the rollback as the last valid package. Startup
        // reconciliation restores it before the next transfer attempt.
      }
    }
    if (error?.code === "ENOSPC") throw retryableStorageError("native session transfer exhausted available space", error);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!movedDestination || existsSync(destination)) rmSync(rollback, { recursive: true, force: true });
  }
}

export function nativeSessionStoragePath(agent, profileRoot) {
  return resolve(profileRoot, nativeSessionStorageRelativePath(agent));
}

function nativeSessionStorageRelativePath(agent) {
  const safeAgent = string(agent, "agent", PACKAGE_PATH_ID);
  if (safeAgent === "claude") return "projects";
  if (safeAgent === "codex") return "sessions";
  if (safeAgent === "opencode") return ".local/share/opencode";
  throw new Error("agent is invalid");
}

// Claude Code files every durable transcript under a per-working-directory
// project slug -- ~/.claude/projects/<slug>/<sessionId>.jsonl -- and resolves
// `--resume <id>` ONLY inside the slug directory for the cwd it was launched
// in. Verified against the pinned CLI (2.1.201, sandbox/Dockerfile): with the
// transcript present under cwd A's slug, a resume launched from cwd B exits 1
// after zero turns with `No conversation found with session ID: <id>` on
// stderr and a `subtype:"error_during_execution"` result record on stdout.
//
// Structured child actions get a fresh worktree per repair cycle (the
// supervisor's worktreeIdempotencyKey includes `action.cycle`), so a cycle-2
// repair runs in a different cwd than the cycle-1 implement whose session it
// resumes. Restoring the package byte-for-byte therefore lands the transcript
// under the sealing cwd's slug, where the resuming engine never looks -- the
// OPE-101 gen-7 crash. Same-cycle resume (implement -> simplify) shares one
// worktree, which is exactly why it worked and hid this.
const CLAUDE_PROJECT_SLUG_RESERVED = /[^A-Za-z0-9-]/g;
// Records carrying a cwd appear within the first few hundred bytes of either
// end of a transcript; this only has to bound each read on a multi-MiB one.
const CLAUDE_TRANSCRIPT_CWD_SCAN_BYTES = 64 * 1024;

export function claudeProjectSlug(workingDirectory) {
  if (typeof workingDirectory !== "string" || !ABSOLUTE_PATH.test(workingDirectory)) {
    throw new Error("Claude project working directory is invalid");
  }
  return resolve(workingDirectory).replace(CLAUDE_PROJECT_SLUG_RESERVED, "-");
}

function transcriptWorkingDirectoriesInWindow(handle, position, length, { dropFirstLine, dropLastLine }) {
  const buffer = Buffer.alloc(length);
  const read = readSync(handle, buffer, 0, length, position);
  const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
  // A window that begins or ends mid-record holds a fragment of one, and a
  // truncated record must not parse as evidence.
  if (dropLastLine) lines.pop();
  if (dropFirstLine) lines.shift();
  const workingDirectories = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.cwd === "string" && ABSOLUTE_PATH.test(record.cwd)) workingDirectories.push(resolve(record.cwd));
    } catch {
      // Non-JSON or partial records carry no working-directory evidence.
    }
  }
  return workingDirectories;
}

// Every Claude transcript record carries the cwd the session runs in, so the
// sealed directory name and the cwds that produced it all travel inside the
// package. That is what lets alignClaudeProjectDirectory below check its own
// slug spelling against the CLI that actually wrote the directory instead of
// assuming they agree.
//
// A session that has already been moved once carries more than one cwd: the
// one it started in at the head of the transcript, and the one the action that
// resumed it appended from at the tail. Reading only the head reports a
// location the session left cycles ago -- the OPE-101 gen-9 crash, where the
// third cycle checked cycle 1's cwd against the directory cycle 2's alignment
// had already moved the session into, and fell through to the fail-closed
// branch on a package that was in exactly the right place. The last record is
// only reachable from the end of a transcript that has outgrown the scan
// bound, so both ends are read.
function recordedTranscriptWorkingDirectories(transcript) {
  const handle = openSync(transcript, "r");
  try {
    const { size } = fstatSync(handle);
    if (size <= CLAUDE_TRANSCRIPT_CWD_SCAN_BYTES) {
      const workingDirectories = transcriptWorkingDirectoriesInWindow(handle, 0, size, {
        dropFirstLine: false,
        dropLastLine: false,
      });
      return { latest: workingDirectories.at(-1) ?? null, workingDirectories };
    }
    const head = transcriptWorkingDirectoriesInWindow(handle, 0, CLAUDE_TRANSCRIPT_CWD_SCAN_BYTES, {
      dropFirstLine: false,
      dropLastLine: true,
    });
    const tail = transcriptWorkingDirectoriesInWindow(
      handle,
      size - CLAUDE_TRANSCRIPT_CWD_SCAN_BYTES,
      CLAUDE_TRANSCRIPT_CWD_SCAN_BYTES,
      { dropFirstLine: true, dropLastLine: false },
    );
    return {
      // A tail window landing entirely inside one oversized record carries no
      // usable cwd, which the caller reads as "no evidence" rather than as a
      // location.
      latest: tail.at(-1) ?? null,
      workingDirectories: [...head, ...tail],
    };
  } finally {
    closeSync(handle);
  }
}

function claudeTranscriptCandidates(projectsRoot, nativeSessionId) {
  const transcriptName = `${nativeSessionId}.jsonl`;
  const candidates = [];
  if (!existsSync(projectsRoot) || !lstatSync(projectsRoot).isDirectory()) return candidates;
  for (const entry of readdirSync(projectsRoot).sort()) {
    const projectDirectory = resolve(projectsRoot, entry);
    const directoryMetadata = lstatSync(projectDirectory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) continue;
    const transcript = resolve(projectDirectory, transcriptName);
    if (!existsSync(transcript)) continue;
    const metadata = lstatSync(transcript);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    candidates.push({ projectDirectory, transcript, size: metadata.size });
  }
  return candidates;
}

// Only the directory the engine will actually read is kept. Anything else is
// a superseded copy of the same session from an earlier cycle's slug, and
// leaving it would grow the next sealed package by a whole transcript per
// repair cycle against the package byte cap.
function pruneSupersededProjectDirectories(projectsRoot, keep) {
  for (const entry of readdirSync(projectsRoot)) {
    const projectDirectory = resolve(projectsRoot, entry);
    if (projectDirectory === keep) continue;
    const metadata = lstatSync(projectDirectory);
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) rmSync(projectDirectory, { recursive: true, force: true });
  }
}

// Moves the sealed session's project directory to the slug for the cwd this
// action's engine will run in. The whole directory moves rather than just the
// <id>.jsonl file: Claude also keeps a sibling <sessionId>/ directory of
// sidechain transcripts beside it, and those belong to the same session.
function alignClaudeProjectDirectory({ projectsRoot, nativeSessionId, workingDirectory }) {
  const candidates = claudeTranscriptCandidates(projectsRoot, nativeSessionId);
  if (candidates.length === 0) {
    throw new Error("authorized native session package has no Claude transcript for the sealed session id");
  }
  const target = pathInside(
    projectsRoot,
    claudeProjectSlug(workingDirectory),
    "restored Claude project directory escapes its profile root",
  );
  // A resumed transcript is append-only, so when a package carries the same
  // session under more than one slug (one sealed before this alignment
  // existed, then restored beside it) the longest file is the newest state.
  // Selecting before comparing against the target matters: a copy already
  // sitting under this cwd's slug can still be the stale one.
  const chosen = candidates.reduce((best, candidate) => (candidate.size > best.size ? candidate : best), candidates[0]);
  if (chosen.projectDirectory === target) {
    pruneSupersededProjectDirectories(projectsRoot, target);
    return target;
  }
  const recorded = recordedTranscriptWorkingDirectories(chosen.transcript);
  if (recorded.latest !== null && recorded.latest === resolve(workingDirectory)) {
    // The session's most recent action already ran in the cwd this one will,
    // and the CLI named the directory it is sitting in for exactly that cwd.
    // It is already the directory the engine will read, so leave it alone
    // rather than trusting our slug spelling over the CLI's own -- this is the
    // case a future slug-convention change would otherwise turn into a
    // regression on same-cwd resume.
    return chosen.projectDirectory;
  }
  if (recorded.workingDirectories.length > 0 &&
    !recorded.workingDirectories.some((cwd) => claudeProjectSlug(cwd) === basename(chosen.projectDirectory))) {
    // No cwd in the session's own history spells this directory's name, so
    // either the pinned CLI's slug convention moved out from under us or the
    // package is not the one it claims to be. Relocating on a spelling we can
    // prove wrong would silently reproduce the OPE-101 crash, so fail closed
    // here where the cause is still nameable.
    //
    // A directory an earlier cycle's alignment moved the session into is
    // corroborated rather than alien: the action that resumed there appended
    // records carrying that cwd, so the name is still one this convention
    // produces from the session's own history.
    throw new Error("sealed Claude transcript directory does not follow the pinned CLI project slug convention");
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(chosen.projectDirectory, target);
  pruneSupersededProjectDirectories(projectsRoot, target);
  return target;
}

function prepareNativeSessionDestination({ agent, profileRoot }) {
  const relativeSessionRoot = nativeSessionStorageRelativePath(agent);
  const parts = relativeSessionRoot.split("/");
  let current = resolve(profileRoot);
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("native session destination path must contain only real directories");
      }
      continue;
    }
    mkdirSync(current, { recursive: false, mode: 0o700 });
  }
  const destination = resolve(profileRoot, relativeSessionRoot);
  rmSync(destination, { recursive: true, force: true });
  return destination;
}

export function materializeNativeSessionState({
  request,
  profileRoot,
  workingDirectory = null,
  availableBytes = undefined,
  copyFile = copyFileSync,
}) {
  if (!request.nativeSessionId || request.contextPolicy === "fresh") return null;
  // Claude's restore is only correct relative to the cwd its engine will be
  // launched in (see alignClaudeProjectDirectory). A caller that cannot name
  // that cwd cannot restore a resumable Claude session, so refuse rather than
  // materialize a package the resume will not find.
  if (request.agent === "claude" && !workingDirectory) {
    throw new Error("restoring a Claude native session requires the launch working directory");
  }
  const sourceRoot = configuredNativeSessionSourceRoot();
  const source = nativeSessionPackageDirectory({
    sourceRoot,
    agent: request.agent,
    nativeSessionId: request.nativeSessionId,
  });
  sweepNativeSessionScratch({
    agent: request.agent,
    nativeSessionId: request.nativeSessionId,
    sourceRoot,
  });
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error("authorized native session state is unavailable");
  }
  try {
    validateNativeSessionPackage({ source, request });
    const { bytes: sourceBytes } = collectNativeSessionPackage(source, request.nativeSessionId, request.agent);
    assertCopySpace({ destinationRoot: profileRoot, sourceBytes, availableBytes });
    const sessionDestination = prepareNativeSessionDestination({ agent: request.agent, profileRoot });
    copyTrustedTree(source, profileRoot, { skipManifest: true, copyFile });
    if (request.agent === "claude") {
      alignClaudeProjectDirectory({
        projectsRoot: sessionDestination,
        nativeSessionId: request.nativeSessionId,
        workingDirectory,
      });
    }
    prepareAgentOwnedDirectory(sessionDestination);
    return source;
  } catch (error) {
    const sessionDestination = nativeSessionStoragePath(request.agent, profileRoot);
    rmSync(sessionDestination, { recursive: true, force: true });
    if (error?.retryableInfrastructureFailure || error?.code === "ENOSPC") {
      if (request.contextPolicy === "prefer_resume") {
        return { transferred: false, reason: "native_session_transfer_unavailable" };
      }
      if (error?.retryableInfrastructureFailure) throw error;
      throw retryableStorageError("native session transfer exhausted available space", error);
    }
    throw error;
  }
}

export function extractNativeSessionId(output, agent) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const candidate = nativeSessionIdFromEvent(event, agent);
      if (typeof candidate === "string" && PACKAGE_PATH_ID.test(candidate)) return candidate;
    } catch {
      // Agent stderr/non-JSON diagnostics are not session evidence.
    }
  }
  return null;
}
