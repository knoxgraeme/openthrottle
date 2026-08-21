import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, digestCanonicalJson } from "@openthrottle/contracts";
import {
  initializeFreshEpochDatabase,
  validateFreshEpochBootstrap,
  verifyFreshEpochDatabase,
  type FreshEpochBootstrap,
  type FreshEpochVerification,
} from "./epoch-database.js";
import { VolumeBlobStore } from "./blob-store.js";

export const OFFLINE_REPLACEMENT_SCHEMA = "openthrottle.offline-replacement/v1" as const;
export const OFFLINE_REPLACEMENT_REPORT_SCHEMA =
  "openthrottle.offline-replacement-report/v1" as const;

const TERMINAL_WORK_STATES = new Set([
  "completed", "no_change", "needs_human", "failed", "canceled", "superseded",
]);

export interface OfflineActiveWorkDisposition {
  id: string;
  kind: "attempt" | "correction" | "effect" | "lease" | "runtime_resource";
  status: string;
  disposition: "terminal" | "abandoned";
  resource_cleanup: "verified" | "not_applicable";
}

export interface OfflineReplacementInput {
  schema: typeof OFFLINE_REPLACEMENT_SCHEMA;
  maintenance: {
    ingress_closed: true;
    supervisors_stopped: true;
    workers_stopped: true;
    storage_lock_absent: true;
    evidence: readonly string[];
  };
  active_work: readonly OfflineActiveWorkDisposition[];
  old: {
    release_id: string;
    database_path: string;
    blob_root: string;
    archive_root: string;
  };
  fresh: {
    release_id: string;
    database_path: string;
    blob_root: string;
    blob_store_id: string;
    bootstrap: FreshEpochBootstrap;
  };
  report_path: string;
}

export interface OfflineSmokeResult {
  id: string;
  status: "passed";
  evidence: string;
}

export interface OfflinePreconditionObservation {
  old_release_id: string;
  database_path: string;
  blob_root: string;
  ingress_closed: true;
  active_work_clear: true;
  supervisors_stopped: true;
  workers_stopped: true;
  evidence: string;
}

export interface OfflineObservedPreconditions extends OfflinePreconditionObservation {
  exclusive_database_lock: "acquired";
}

export interface OfflineReplacementHooks {
  observePreconditions(input: OfflineReplacementInput): Promise<OfflinePreconditionObservation>;
  startCandidate(input: OfflineReplacementInput): Promise<string>;
  runSmoke(kind: "ordinary" | "structured"): Promise<OfflineSmokeResult>;
  reopenIngress(): Promise<string>;
  stopCandidate(reason: string): Promise<string>;
  restoreOld(reason: string): Promise<string>;
}

interface ArchiveFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface OldArchiveEvidence {
  root: string;
  database_sha256: string;
  blob_tree_digest: string;
  manifest_digest: string;
  integrity: "ok";
  foreign_key_failures: number;
  schema_digest: string;
  table_rows: Readonly<Record<string, number>>;
}

export interface OfflineReplacementReport {
  schema: typeof OFFLINE_REPLACEMENT_REPORT_SCHEMA;
  status: "ready_to_reopen" | "completed" | "rolled_back" | "rollback_failed";
  started_at: string;
  ready_at: string | null;
  finished_at: string;
  old_release_id: string;
  fresh_release_id: string;
  archive: OldArchiveEvidence | null;
  bootstrap_checksum: string;
  fresh_epoch: FreshEpochVerification | null;
  active_work: readonly OfflineActiveWorkDisposition[];
  maintenance_evidence: readonly string[];
  observed_preconditions: OfflineObservedPreconditions;
  candidate_start_evidence: string | null;
  smoke: { ordinary: OfflineSmokeResult; structured: OfflineSmokeResult } | null;
  reopen_evidence: string | null;
  ready_report_digest: string | null;
  rollback_evidence: readonly string[];
  rollback_failure: string | null;
  failure: string | null;
  report_digest: string;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bounded(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "");
  return (message || "unknown failure").slice(0, 4_000);
}

function objectWithExactKeys(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
  return record;
}

function absolutePath(value: unknown, name: string): string {
  const path = bounded(value, name, 4_096);
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new Error(`${name} must be an absolute normalized non-root path`);
  }
  return path;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function preflightReportPath(path: string): void {
  if (pathEntryExists(path)) throw new Error("offline replacement report path already exists");
  const requestedParent = dirname(path);
  let parentStats;
  try {
    parentStats = lstatSync(requestedParent);
  } catch (error) {
    throw new Error(`offline replacement report parent is unavailable: ${errorMessage(error)}`);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("offline replacement report parent must be a real directory");
  }
  const parent = realpathSync(requestedParent);
  const target = join(parent, basename(path));
  if (pathEntryExists(target)) throw new Error("offline replacement report path already exists");
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    unlinkSync(target);
    created = false;
    fsyncPath(parent);
  } catch (error) {
    throw new Error(`offline replacement report path preflight failed: ${errorMessage(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        // Preserve the original refusal. A leftover empty probe also blocks reuse.
      }
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertDistinctPaths(paths: Readonly<Record<string, string>>): void {
  const entries = Object.entries(paths);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, leftPath] = entries[left]!;
      const [rightName, rightPath] = entries[right]!;
      if (isInside(leftPath, rightPath) || isInside(rightPath, leftPath)) {
        throw new Error(`${leftName} and ${rightName} must be distinct, non-nested paths`);
      }
    }
  }
}

function normalizedInput(input: OfflineReplacementInput): OfflineReplacementInput {
  if (input.schema !== OFFLINE_REPLACEMENT_SCHEMA) throw new Error("offline replacement schema is unsupported");
  if (
    input.maintenance.ingress_closed !== true ||
    input.maintenance.supervisors_stopped !== true ||
    input.maintenance.workers_stopped !== true ||
    input.maintenance.storage_lock_absent !== true
  ) throw new Error("offline replacement requires closed ingress and every old writer stopped");
  if (!Array.isArray(input.maintenance.evidence) || input.maintenance.evidence.length < 1 || input.maintenance.evidence.length > 32) {
    throw new Error("maintenance evidence must contain between one and 32 entries");
  }
  const maintenanceEvidence = input.maintenance.evidence.map((value, index) =>
    bounded(value, `maintenance.evidence[${index}]`, 1_000));
  if (!Array.isArray(input.active_work) || input.active_work.length > 1_000) {
    throw new Error("active_work must contain at most 1000 dispositions");
  }
  const ids = new Set<string>();
  const activeWork = input.active_work.map((item, index) => {
    const id = bounded(item.id, `active_work[${index}].id`, 300);
    if (ids.has(id)) throw new Error(`active_work contains duplicate ${id}`);
    ids.add(id);
    if (!["attempt", "correction", "effect", "lease", "runtime_resource"].includes(item.kind)) {
      throw new Error(`active_work[${index}].kind is unsupported`);
    }
    if (item.disposition === "terminal" && !TERMINAL_WORK_STATES.has(item.status)) {
      throw new Error(`active_work ${id} is not terminal`);
    }
    if (item.disposition !== "terminal" && item.disposition !== "abandoned") {
      throw new Error(`active_work ${id} lacks an explicit disposition`);
    }
    if (item.resource_cleanup !== "verified" && item.resource_cleanup !== "not_applicable") {
      throw new Error(`active_work ${id} lacks resource-cleanup evidence`);
    }
    if (item.kind === "runtime_resource" && item.resource_cleanup !== "verified") {
      throw new Error(`runtime resource ${id} is not verified clean`);
    }
    return { ...item, id, status: bounded(item.status, `active_work[${index}].status`, 100) };
  });
  const paths = {
    old_database: absolutePath(input.old.database_path, "old.database_path"),
    old_blobs: absolutePath(input.old.blob_root, "old.blob_root"),
    archive: absolutePath(input.old.archive_root, "old.archive_root"),
    fresh_database: absolutePath(input.fresh.database_path, "fresh.database_path"),
    fresh_blobs: absolutePath(input.fresh.blob_root, "fresh.blob_root"),
    report: absolutePath(input.report_path, "report_path"),
  };
  assertDistinctPaths(paths);
  return {
    schema: OFFLINE_REPLACEMENT_SCHEMA,
    maintenance: {
      ingress_closed: true,
      supervisors_stopped: true,
      workers_stopped: true,
      storage_lock_absent: true,
      evidence: maintenanceEvidence,
    },
    active_work: activeWork,
    old: {
      release_id: bounded(input.old.release_id, "old.release_id", 200),
      database_path: paths.old_database,
      blob_root: paths.old_blobs,
      archive_root: paths.archive,
    },
    fresh: {
      release_id: bounded(input.fresh.release_id, "fresh.release_id", 200),
      database_path: paths.fresh_database,
      blob_root: paths.fresh_blobs,
      blob_store_id: bounded(input.fresh.blob_store_id, "fresh.blob_store_id", 200),
      bootstrap: validateFreshEpochBootstrap(input.fresh.bootstrap),
    },
    report_path: paths.report,
  };
}

function normalizedPreconditionObservation(
  value: unknown,
  input: OfflineReplacementInput,
): OfflinePreconditionObservation {
  const observation = objectWithExactKeys(value, [
    "old_release_id",
    "database_path",
    "blob_root",
    "ingress_closed",
    "active_work_clear",
    "supervisors_stopped",
    "workers_stopped",
    "evidence",
  ], "observed preconditions");
  const oldReleaseId = bounded(observation.old_release_id, "observed old_release_id", 200);
  const databasePath = absolutePath(observation.database_path, "observed database_path");
  const blobRoot = absolutePath(observation.blob_root, "observed blob_root");
  if (
    oldReleaseId !== input.old.release_id ||
    databasePath !== input.old.database_path ||
    blobRoot !== input.old.blob_root
  ) {
    throw new Error("observed precondition does not match the exact old tuple");
  }
  if (
    observation.ingress_closed !== true ||
    observation.active_work_clear !== true ||
    observation.supervisors_stopped !== true ||
    observation.workers_stopped !== true
  ) {
    throw new Error("observed preconditions do not prove closed ingress, clear active work, and stopped writers");
  }
  return {
    old_release_id: oldReleaseId,
    database_path: databasePath,
    blob_root: blobRoot,
    ingress_closed: true,
    active_work_clear: true,
    supervisors_stopped: true,
    workers_stopped: true,
    evidence: bounded(observation.evidence, "observed precondition evidence", 4_000),
  };
}

function probeExclusiveOldDatabaseLock(path: string): "acquired" {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { fileMustExist: true, timeout: 0 });
    db.pragma("busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
    return "acquired";
  } catch (error) {
    if (db?.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The lock refusal below remains the authoritative failure.
      }
    }
    throw new Error(`exclusive old-database lock probe failed: ${errorMessage(error)}`);
  } finally {
    db?.close();
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyRegularTree(source: string, target: string, prefix = ""): ArchiveFile[] {
  const sourceStats = lstatSync(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error(`archive source is not a real directory: ${source}`);
  }
  mkdirSync(target, { mode: 0o700 });
  const files: ArchiveFile[] = [];
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`archive source contains symlink ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...copyRegularTree(sourcePath, targetPath, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`archive source contains non-file ${relativePath}`);
    copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
    chmodSync(targetPath, 0o600);
    fsyncPath(targetPath);
    const bytes = readFileSync(targetPath);
    if (bytes.byteLength !== statSync(sourcePath).size || sha256(bytes) !== sha256(readFileSync(sourcePath))) {
      throw new Error(`archive copy verification failed for ${relativePath}`);
    }
    files.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  fsyncPath(target);
  return files;
}

function databaseEvidence(path: string): Omit<OldArchiveEvidence, "root" | "database_sha256" | "blob_tree_digest" | "manifest_digest"> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`old database integrity_check failed: ${String(integrity)}`);
    const foreignKeyFailures = (db.pragma("foreign_key_check") as unknown[]).length;
    if (foreignKeyFailures !== 0) throw new Error("old database foreign_key_check failed");
    const schema = db.prepare(`
      SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as Array<{ name: string }>;
    const tableRows: Record<string, number> = {};
    for (const { name } of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("old database has an unsafe table name");
      const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number };
      tableRows[name] = row.count;
    }
    return {
      integrity: "ok",
      foreign_key_failures: foreignKeyFailures,
      schema_digest: digestCanonicalJson(schema),
      table_rows: tableRows,
    };
  } finally {
    db.close();
  }
}

async function archiveOld(input: OfflineReplacementInput): Promise<OldArchiveEvidence> {
  if (existsSync(input.old.archive_root)) throw new Error("archive root must not already exist");
  if (existsSync(input.fresh.database_path) || existsSync(input.fresh.blob_root)) {
    throw new Error("fresh database and blob paths must be absent");
  }
  const oldDatabaseStats = lstatSync(input.old.database_path);
  if (!oldDatabaseStats.isFile() || oldDatabaseStats.isSymbolicLink()) {
    throw new Error("old database must be a regular file");
  }
  const parent = realpathSync(dirname(input.old.archive_root));
  const staging = join(parent, `.${basename(input.old.archive_root)}.offline-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    const databasePath = join(staging, "database.sqlite");
    const old = new Database(input.old.database_path, { readonly: true, fileMustExist: true });
    try {
      await old.backup(databasePath);
    } finally {
      old.close();
    }
    chmodSync(databasePath, 0o600);
    fsyncPath(databasePath);
    const database = databaseEvidence(databasePath);
    const blobFiles = copyRegularTree(input.old.blob_root, join(staging, "blobs"));
    const content = {
      schema: "openthrottle.offline-archive/v1",
      old_release_id: input.old.release_id,
      database: {
        path: "database.sqlite",
        bytes: statSync(databasePath).size,
        sha256: sha256(readFileSync(databasePath)),
        ...database,
      },
      blobs: blobFiles,
      blob_tree_digest: digestCanonicalJson(blobFiles),
    };
    const manifest = { ...content, manifest_digest: digestCanonicalJson(content) };
    const manifestPath = join(staging, "archive-manifest.json");
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
    fsyncPath(manifestPath);
    fsyncPath(staging);
    renameSync(staging, input.old.archive_root);
    fsyncPath(parent);
    return {
      root: input.old.archive_root,
      database_sha256: content.database.sha256,
      blob_tree_digest: content.blob_tree_digest,
      manifest_digest: manifest.manifest_digest,
      ...database,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function initializeFresh(input: OfflineReplacementInput): FreshEpochVerification {
  if (existsSync(input.fresh.database_path) || existsSync(input.fresh.blob_root)) {
    throw new Error("fresh database and blob paths must be absent");
  }
  const blobs = VolumeBlobStore.initialize(input.fresh.blob_root, input.fresh.blob_store_id);
  const db = initializeFreshEpochDatabase({
    database_path: input.fresh.database_path,
    blob_store: blobs,
    release_id: input.fresh.release_id,
    bootstrap: input.fresh.bootstrap,
  });
  try {
    return verifyFreshEpochDatabase(db, {
      release_id: input.fresh.release_id,
      blob_store_id: blobs.store_id,
      blob_marker_checksum: blobs.marker_checksum,
      bootstrap_checksum: input.fresh.bootstrap.checksum,
    });
  } finally {
    db.close();
  }
}

function normalizedSmokeResult(kind: "ordinary" | "structured", value: unknown): OfflineSmokeResult {
  const result = objectWithExactKeys(value, ["id", "status", "evidence"], `${kind} smoke result`);
  if (result.status !== "passed") throw new Error(`${kind} smoke did not pass`);
  return {
    id: bounded(result.id, `${kind} smoke id`, 300),
    status: "passed",
    evidence: bounded(result.evidence, `${kind} smoke evidence`, 4_000),
  };
}

function reportWithDigest(content: Omit<OfflineReplacementReport, "report_digest">): OfflineReplacementReport {
  return { ...content, report_digest: digestCanonicalJson(content) };
}

function verifyPriorReport(path: string, expectedDigest: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("offline replacement prior report is not a regular file");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const claimedDigest = parsed.report_digest;
  delete parsed.report_digest;
  if (claimedDigest !== expectedDigest || digestCanonicalJson(parsed) !== expectedDigest) {
    throw new Error("offline replacement prior report digest mismatch");
  }
}

function writeReport(
  path: string,
  report: OfflineReplacementReport,
  expectedPreviousDigest?: string,
): void {
  if (expectedPreviousDigest === undefined) {
    if (pathEntryExists(path)) throw new Error("offline replacement report path already exists");
  } else {
    verifyPriorReport(path, expectedPreviousDigest);
  }
  const parent = realpathSync(dirname(path));
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${canonicalJson(report)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncPath(parent);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function runOfflineReplacement(inputValue: OfflineReplacementInput, hooks: OfflineReplacementHooks, options: {
  now?: () => string;
} = {}): Promise<OfflineReplacementReport> {
  const input = normalizedInput(inputValue);
  preflightReportPath(input.report_path);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const observedPreconditions: OfflineObservedPreconditions = {
    ...normalizedPreconditionObservation(await hooks.observePreconditions(input), input),
    exclusive_database_lock: probeExclusiveOldDatabaseLock(input.old.database_path),
  };
  let archive: OldArchiveEvidence | null = null;
  let freshEpoch: FreshEpochVerification | null = null;
  let candidateEvidence: string | null = null;
  let smoke: OfflineReplacementReport["smoke"] = null;
  let readyAt: string | null = null;
  const makeReport = (values: {
    status: OfflineReplacementReport["status"];
    finishedAt?: string;
    reopenEvidence?: string | null;
    readyReportDigest?: string | null;
    rollbackEvidence?: readonly string[];
    rollbackFailure?: string | null;
    failure?: string | null;
  }): OfflineReplacementReport => reportWithDigest({
    schema: OFFLINE_REPLACEMENT_REPORT_SCHEMA,
    status: values.status,
    started_at: startedAt,
    ready_at: readyAt,
    finished_at: values.finishedAt ?? now(),
    old_release_id: input.old.release_id,
    fresh_release_id: input.fresh.release_id,
    archive,
    bootstrap_checksum: input.fresh.bootstrap.checksum,
    fresh_epoch: freshEpoch,
    active_work: input.active_work,
    maintenance_evidence: input.maintenance.evidence,
    observed_preconditions: observedPreconditions,
    candidate_start_evidence: candidateEvidence,
    smoke,
    reopen_evidence: values.reopenEvidence ?? null,
    ready_report_digest: values.readyReportDigest ?? null,
    rollback_evidence: values.rollbackEvidence ?? [],
    rollback_failure: values.rollbackFailure ?? null,
    failure: values.failure ?? null,
  });

  let readyReport: OfflineReplacementReport;
  try {
    archive = await archiveOld(input);
    freshEpoch = initializeFresh(input);
    candidateEvidence = bounded(await hooks.startCandidate(input), "candidate start evidence", 4_000);
    const ordinary = normalizedSmokeResult("ordinary", await hooks.runSmoke("ordinary"));
    const structured = normalizedSmokeResult("structured", await hooks.runSmoke("structured"));
    if (ordinary.id === structured.id) throw new Error("ordinary and structured smoke IDs must be distinct");
    smoke = { ordinary, structured };
    readyAt = now();
    readyReport = makeReport({ status: "ready_to_reopen", finishedAt: readyAt });
    writeReport(input.report_path, readyReport);
  } catch (error) {
    const reason = errorMessage(error);
    const rollbackEvidence: string[] = [];
    let rollbackFailure: string | null = null;
    try {
      rollbackEvidence.push(
        `candidate_stopped:${bounded(await hooks.stopCandidate(reason), "candidate stop evidence", 4_000)}`,
      );
    } catch (rollbackError) {
      rollbackFailure = errorMessage(rollbackError);
      rollbackEvidence.push(`candidate_stop_failed:${rollbackFailure}`);
    }
    if (rollbackFailure === null) {
      try {
        rollbackEvidence.push(
          `old_tuple_restored:${bounded(await hooks.restoreOld(reason), "old tuple restore evidence", 4_000)}`,
        );
      } catch (rollbackError) {
        rollbackFailure = errorMessage(rollbackError);
        rollbackEvidence.push(`old_tuple_restore_failed:${rollbackFailure}`);
      }
    }
    const status = rollbackFailure === null ? "rolled_back" : "rollback_failed";
    const report = makeReport({
      status,
      rollbackEvidence,
      rollbackFailure,
      failure: reason,
    });
    writeReport(input.report_path, report);
    if (rollbackFailure !== null) {
      throw new Error(`offline replacement rollback failed: ${reason}; ${rollbackFailure}`);
    }
    throw new Error(`offline replacement rolled back: ${reason}`);
  }

  try {
    const reopenEvidence = bounded(await hooks.reopenIngress(), "reopen evidence", 4_000);
    const completedReport = makeReport({
      status: "completed",
      reopenEvidence,
      readyReportDigest: readyReport.report_digest,
    });
    writeReport(input.report_path, completedReport, readyReport.report_digest);
    return completedReport;
  } catch (error) {
    throw new Error(
      `offline replacement requires operator resolution after ready_to_reopen: ${errorMessage(error)}`,
    );
  }
}
