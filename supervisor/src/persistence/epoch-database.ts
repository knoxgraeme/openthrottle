import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  digestNormalized,
  jsonValueAt,
  type JsonValue,
} from "@openthrottle/contracts";
import { VolumeBlobStore } from "./blob-store.js";
import {
  applyFreshEpochSchema,
  FRESH_EPOCH_APPLICATION_ID,
  FRESH_EPOCH_MIGRATION_NAME,
  FRESH_EPOCH_SCHEMA_CHECKSUM,
  FRESH_EPOCH_TABLES,
  FRESH_EPOCH_VERSION,
  KERNEL_INGRESS_MAINTENANCE_SETTING,
} from "./epoch-schema.js";

export const FRESH_EPOCH_BOOTSTRAP_SCHEMA = "openthrottle.fresh-epoch-bootstrap/v1" as const;
const RESERVED_SETTING_PREFIX = "epoch.";
const MAX_BOOTSTRAP_SETTINGS = 128;
const MAX_BOOTSTRAP_REGISTRATIONS = 256;
const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;

export type SettingValueType = "string" | "number" | "boolean" | "json";

export interface FreshEpochBootstrapSetting {
  key: string;
  value: JsonValue;
  value_type: SettingValueType;
  mutable: boolean;
}

export interface FreshEpochBootstrapRegistration {
  id: string;
  control_provider: "linear" | "github";
  route_key: string;
  linear_team_id: string | null;
  linear_team_key: string | null;
  github_repo: string;
  github_installation_id: number | null;
  base_branch: string;
  webhook_id: number | null;
  runtime_snapshot: string;
}

export interface FreshEpochBootstrapContent {
  schema: typeof FRESH_EPOCH_BOOTSTRAP_SCHEMA;
  settings: readonly FreshEpochBootstrapSetting[];
  repository_registrations: readonly FreshEpochBootstrapRegistration[];
}

export interface FreshEpochBootstrap extends FreshEpochBootstrapContent {
  checksum: string;
}

export interface FreshEpochIdentity {
  release_id: string;
  runtime_capability_digest: string;
  blob_store_id: string;
  blob_marker_checksum: string;
  bootstrap_checksum: string;
}

export interface FreshEpochVerification extends FreshEpochIdentity {
  schema_version: number;
  schema_checksum: string;
  integrity: "ok";
}

export class FreshEpochRefusalError extends Error {
  readonly code = "FRESH_EPOCH_REFUSED";

  constructor(detail: string) {
    super(`fresh epoch refused: ${detail}`);
    this.name = "FreshEpochRefusalError";
  }
}

function refuse(detail: string): never {
  throw new FreshEpochRefusalError(detail);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    refuse(`${path} has unknown or missing fields`);
  }
}

function boundedString(value: unknown, path: string, max = 300): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    refuse(`${path} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function lowercaseSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !LOWERCASE_SHA256.test(value)) {
    refuse(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizedSetting(
  value: FreshEpochBootstrapSetting,
  index: number,
): FreshEpochBootstrapSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(`settings[${index}] must be an object`);
  }
  exactKeys(value as unknown as Record<string, unknown>, ["key", "value", "value_type", "mutable"], `settings[${index}]`);
  const key = boundedString(value.key, `settings[${index}].key`, 200);
  if (!ID.test(key) || key.startsWith(RESERVED_SETTING_PREFIX)) {
    refuse(`settings[${index}].key is invalid or reserved`);
  }
  if (!["string", "number", "boolean", "json"].includes(value.value_type)) {
    refuse(`settings[${index}].value_type is invalid`);
  }
  if (typeof value.mutable !== "boolean") refuse(`settings[${index}].mutable must be boolean`);
  const json = jsonValueAt(value.value, `settings[${index}].value`);
  if (
    (value.value_type === "string" && typeof json !== "string") ||
    (value.value_type === "number" && typeof json !== "number") ||
    (value.value_type === "boolean" && typeof json !== "boolean")
  ) {
    refuse(`settings[${index}].value does not match value_type`);
  }
  return { key, value: json, value_type: value.value_type, mutable: value.mutable };
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : boundedString(value, path);
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) refuse(`${path} must be a positive integer or null`);
  return value as number;
}

function normalizedRegistration(
  value: FreshEpochBootstrapRegistration,
  index: number,
): FreshEpochBootstrapRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(`repository_registrations[${index}] must be an object`);
  }
  exactKeys(value as unknown as Record<string, unknown>, [
    "id", "control_provider", "route_key", "linear_team_id", "linear_team_key",
    "github_repo", "github_installation_id", "base_branch", "webhook_id", "runtime_snapshot",
  ], `repository_registrations[${index}]`);
  if (value.control_provider !== "linear" && value.control_provider !== "github") {
    refuse(`repository_registrations[${index}].control_provider is invalid`);
  }
  const registration: FreshEpochBootstrapRegistration = {
    id: boundedString(value.id, `repository_registrations[${index}].id`, 200),
    control_provider: value.control_provider,
    route_key: boundedString(value.route_key, `repository_registrations[${index}].route_key`),
    linear_team_id: nullableString(value.linear_team_id, `repository_registrations[${index}].linear_team_id`),
    linear_team_key: nullableString(value.linear_team_key, `repository_registrations[${index}].linear_team_key`),
    github_repo: boundedString(value.github_repo, `repository_registrations[${index}].github_repo`),
    github_installation_id: nullablePositiveInteger(
      value.github_installation_id,
      `repository_registrations[${index}].github_installation_id`,
    ),
    base_branch: boundedString(value.base_branch, `repository_registrations[${index}].base_branch`),
    webhook_id: nullablePositiveInteger(value.webhook_id, `repository_registrations[${index}].webhook_id`),
    runtime_snapshot: boundedString(value.runtime_snapshot, `repository_registrations[${index}].runtime_snapshot`),
  };
  const linear = registration.control_provider === "linear";
  if (
    (linear && (
      registration.linear_team_id === null || registration.linear_team_key === null ||
      registration.route_key !== registration.linear_team_id
    )) ||
    (!linear && (
      registration.linear_team_id !== null || registration.linear_team_key !== null ||
      registration.route_key !== registration.github_repo
    ))
  ) {
    refuse(`repository_registrations[${index}] has inconsistent routing fields`);
  }
  return registration;
}

function normalizeBootstrapContent(content: FreshEpochBootstrapContent): FreshEpochBootstrapContent {
  if (!content || typeof content !== "object" || Array.isArray(content)) refuse("bootstrap must be an object");
  exactKeys(content as unknown as Record<string, unknown>, [
    "schema", "settings", "repository_registrations",
  ], "bootstrap");
  if (content.schema !== FRESH_EPOCH_BOOTSTRAP_SCHEMA) refuse("bootstrap schema is unsupported");
  if (!Array.isArray(content.settings) || content.settings.length > MAX_BOOTSTRAP_SETTINGS) {
    refuse(`bootstrap settings must contain at most ${MAX_BOOTSTRAP_SETTINGS} entries`);
  }
  if (
    !Array.isArray(content.repository_registrations) ||
    content.repository_registrations.length > MAX_BOOTSTRAP_REGISTRATIONS
  ) {
    refuse(`bootstrap repository_registrations must contain at most ${MAX_BOOTSTRAP_REGISTRATIONS} entries`);
  }
  const settings = content.settings.map(normalizedSetting)
    .sort((left, right) => compareCodeUnits(left.key, right.key));
  const registrations = content.repository_registrations.map(normalizedRegistration)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const [name, values] of [
    ["setting key", settings.map((setting) => setting.key)],
    ["registration id", registrations.map((registration) => registration.id)],
    ["registration route", registrations.map((registration) => `${registration.control_provider}:${registration.route_key}`)],
    ["repository", registrations.map((registration) => registration.github_repo)],
  ] as const) {
    if (new Set(values).size !== values.length) refuse(`bootstrap contains a duplicate ${name}`);
  }
  const normalized: FreshEpochBootstrapContent = {
    schema: FRESH_EPOCH_BOOTSTRAP_SCHEMA,
    settings,
    repository_registrations: registrations,
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_BOOTSTRAP_BYTES) {
    refuse(`bootstrap exceeds ${MAX_BOOTSTRAP_BYTES} bytes`);
  }
  return normalized;
}

export function createFreshEpochBootstrap(
  content: FreshEpochBootstrapContent,
): FreshEpochBootstrap {
  const normalized = normalizeBootstrapContent(content);
  return { ...normalized, checksum: digestCanonicalJson(normalized) };
}

export function validateFreshEpochBootstrap(input: FreshEpochBootstrap): FreshEpochBootstrap {
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("bootstrap must be an object");
  exactKeys(input as unknown as Record<string, unknown>, [
    "schema", "settings", "repository_registrations", "checksum",
  ], "bootstrap");
  const normalized = normalizeBootstrapContent({
    schema: input.schema,
    settings: input.settings,
    repository_registrations: input.repository_registrations,
  });
  const checksum = digestCanonicalJson(normalized);
  if (input.checksum !== checksum) refuse("bootstrap checksum mismatch");
  return { ...normalized, checksum };
}

interface SchemaObjectRow {
  type: string;
  name: string;
  table_name: string;
  sql: string | null;
}

function schemaObjects(db: Database.Database): SchemaObjectRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as SchemaObjectRow[];
}

let expectedSchemaObjects: readonly SchemaObjectRow[] | undefined;

function baselineSchemaObjects(): readonly SchemaObjectRow[] {
  if (expectedSchemaObjects) return expectedSchemaObjects;
  const reference = new Database(":memory:");
  try {
    reference.pragma("foreign_keys = ON");
    applyFreshEpochSchema(reference, "2000-01-01T00:00:00.000Z");
    expectedSchemaObjects = schemaObjects(reference);
    return expectedSchemaObjects;
  } finally {
    reference.close();
  }
}

function readIdentitySetting(db: Database.Database, key: string): string {
  const row = db.prepare("SELECT value_json, value_type, mutable FROM settings WHERE key = ?")
    .get(key) as { value_json: string; value_type: string; mutable: number } | undefined;
  if (!row || row.value_type !== "string" || row.mutable !== 0) refuse(`missing immutable ${key} setting`);
  const value: unknown = JSON.parse(row.value_json);
  if (typeof value !== "string") refuse(`${key} setting is not a string`);
  return value;
}

export function verifyFreshEpochDatabase(
  db: Database.Database,
  expected: FreshEpochIdentity,
): FreshEpochVerification {
  const expectedRuntimeCapabilityDigest = lowercaseSha256(
    expected.runtime_capability_digest,
    "expected runtime_capability_digest",
  );
  if (db.pragma("foreign_keys", { simple: true }) !== 1) refuse("foreign keys are disabled");
  if (db.pragma("application_id", { simple: true }) !== FRESH_EPOCH_APPLICATION_ID) {
    refuse("database application identity is unknown");
  }
  if (db.pragma("user_version", { simple: true }) !== FRESH_EPOCH_VERSION) {
    refuse("database schema version is unknown");
  }
  const actualObjects = schemaObjects(db);
  if (canonicalJson(actualObjects) !== canonicalJson(baselineSchemaObjects())) {
    refuse("database schema objects are partial, drifted, or undeclared");
  }
  const tables = actualObjects.filter((object) => object.type === "table").map((object) => object.name).sort();
  if (canonicalJson(tables) !== canonicalJson([...FRESH_EPOCH_TABLES].sort())) {
    refuse("database does not contain the exact twelve-table epoch");
  }
  const migrations = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;
  if (canonicalJson(migrations) !== canonicalJson([{
    version: FRESH_EPOCH_VERSION,
    name: FRESH_EPOCH_MIGRATION_NAME,
    checksum: FRESH_EPOCH_SCHEMA_CHECKSUM,
  }])) {
    refuse("schema migration checksum ledger is unknown or drifted");
  }
  const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) refuse("database foreign-key integrity check failed");
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") refuse(`database integrity check failed: ${String(integrity)}`);

  const actual: FreshEpochIdentity = {
    release_id: readIdentitySetting(db, "epoch.release_id"),
    runtime_capability_digest: lowercaseSha256(
      readIdentitySetting(db, "epoch.runtime_capability_digest"),
      "epoch.runtime_capability_digest",
    ),
    blob_store_id: readIdentitySetting(db, "epoch.blob_store_id"),
    blob_marker_checksum: readIdentitySetting(db, "epoch.blob_marker_checksum"),
    bootstrap_checksum: readIdentitySetting(db, "epoch.bootstrap_checksum"),
  };
  if (canonicalJson(actual) !== canonicalJson({
    ...expected,
    runtime_capability_digest: expectedRuntimeCapabilityDigest,
  })) refuse("release, runtime capability, bootstrap, or blob-root identity mismatch");
  return {
    ...actual,
    schema_version: FRESH_EPOCH_VERSION,
    schema_checksum: FRESH_EPOCH_SCHEMA_CHECKSUM,
    integrity: "ok",
  };
}

function insertSetting(
  db: Database.Database,
  setting: FreshEpochBootstrapSetting,
  timestamp: string,
): void {
  db.prepare(`
    INSERT INTO settings (key, value_json, value_type, mutable, version, updated_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(
    setting.key,
    canonicalJson(setting.value),
    setting.value_type,
    setting.mutable ? 1 : 0,
    timestamp,
  );
}

function insertBootstrap(
  db: Database.Database,
  bootstrap: FreshEpochBootstrap,
  identity: FreshEpochIdentity,
  timestamp: string,
): void {
  for (const [key, value] of Object.entries({
    "epoch.release_id": identity.release_id,
    "epoch.runtime_capability_digest": identity.runtime_capability_digest,
    "epoch.blob_store_id": identity.blob_store_id,
    "epoch.blob_marker_checksum": identity.blob_marker_checksum,
    "epoch.bootstrap_checksum": identity.bootstrap_checksum,
  }).sort(([left], [right]) => compareCodeUnits(left, right))) {
    insertSetting(db, { key, value, value_type: "string", mutable: false }, timestamp);
  }
  insertSetting(db, {
    key: KERNEL_INGRESS_MAINTENANCE_SETTING,
    value: true,
    value_type: "boolean",
    mutable: true,
  }, timestamp);
  for (const setting of bootstrap.settings) insertSetting(db, setting, timestamp);
  const statement = db.prepare(`
    INSERT INTO repository_registrations (
      id, control_provider, route_key, linear_team_id, linear_team_key,
      github_repo, github_installation_id, base_branch, webhook_id,
      runtime_snapshot, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  for (const registration of bootstrap.repository_registrations) {
    statement.run(
      registration.id,
      registration.control_provider,
      registration.route_key,
      registration.linear_team_id,
      registration.linear_team_key,
      registration.github_repo,
      registration.github_installation_id,
      registration.base_branch,
      registration.webhook_id,
      registration.runtime_snapshot,
      timestamp,
      timestamp,
    );
  }
}

function assertBootstrapOnly(db: Database.Database, bootstrap: FreshEpochBootstrap): void {
  const expectedSupportRows = bootstrap.settings.length + 6;
  const settingCount = db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
  const registrationCount = db.prepare("SELECT COUNT(*) AS count FROM repository_registrations").get() as { count: number };
  if (settingCount.count !== expectedSupportRows || registrationCount.count !== bootstrap.repository_registrations.length) {
    refuse("fresh epoch bootstrap row counts do not match the manifest");
  }
  for (const table of [
    "leases", "work_items", "inbox_events", "definitions", "pipeline_runs", "attempts",
    "records", "effects", "checkpoints",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (row.count !== 0) refuse(`fresh epoch bootstrap unexpectedly populated ${table}`);
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function unlinkStagingFiles(stagingPath: string): void {
  if (!basename(stagingPath).includes(".epoch-init-")) {
    throw new Error("refusing to remove an unrecognized epoch staging path");
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      unlinkSync(`${stagingPath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function databaseFileDigest(path: string): string {
  return digestNormalized(readFileSync(path));
}

export function initializeFreshEpochDatabase(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  release_id: string;
  runtime_capability_digest: string;
  bootstrap: FreshEpochBootstrap;
  now?: () => string;
}): Database.Database {
  const target = resolve(input.database_path);
  const parent = realpathSync(dirname(target));
  const canonicalTarget = join(parent, basename(target));
  if (existsSync(canonicalTarget)) refuse("target database path is not absent");
  input.blob_store.assertSameVolume(canonicalTarget);
  const releaseId = boundedString(input.release_id, "release_id", 200);
  const bootstrap = validateFreshEpochBootstrap(input.bootstrap);
  const identity: FreshEpochIdentity = {
    release_id: releaseId,
    runtime_capability_digest: lowercaseSha256(
      input.runtime_capability_digest,
      "runtime_capability_digest",
    ),
    blob_store_id: input.blob_store.store_id,
    blob_marker_checksum: input.blob_store.marker_checksum,
    bootstrap_checksum: bootstrap.checksum,
  };
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const stagingPath = join(parent, `.${basename(target)}.epoch-init-${randomUUID()}`);
  let stagingDb: Database.Database | undefined;
  try {
    stagingDb = new Database(stagingPath);
    stagingDb.pragma("foreign_keys = ON");
    stagingDb.pragma("journal_mode = DELETE");
    stagingDb.pragma("synchronous = FULL");
    stagingDb.transaction(() => {
      applyFreshEpochSchema(stagingDb!, timestamp);
      insertBootstrap(stagingDb!, bootstrap, identity, timestamp);
    }).immediate();
    verifyFreshEpochDatabase(stagingDb, identity);
    assertBootstrapOnly(stagingDb, bootstrap);
    stagingDb.close();
    stagingDb = undefined;
    chmodSync(stagingPath, 0o600);
    fsyncPath(stagingPath);

    // Reopen read-only so a corrupt close or journal cannot become the target.
    const proof = new Database(stagingPath, { readonly: true, fileMustExist: true });
    try {
      proof.pragma("foreign_keys = ON");
      proof.pragma("query_only = ON");
      verifyFreshEpochDatabase(proof, identity);
      assertBootstrapOnly(proof, bootstrap);
    } finally {
      proof.close();
    }
    if (existsSync(canonicalTarget)) refuse("target database appeared during initialization");
    renameSync(stagingPath, canonicalTarget);
    fsyncPath(parent);
  } catch (error) {
    stagingDb?.close();
    unlinkStagingFiles(stagingPath);
    throw error;
  }
  return openFreshEpochDatabase({
    database_path: canonicalTarget,
    blob_store: input.blob_store,
    expected_identity: identity,
  });
}

export function openFreshEpochDatabase(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  expected_identity: FreshEpochIdentity;
}): Database.Database {
  const target = resolve(input.database_path);
  const expectedIdentity: FreshEpochIdentity = {
    ...input.expected_identity,
    runtime_capability_digest: lowercaseSha256(
      input.expected_identity.runtime_capability_digest,
      "expected runtime_capability_digest",
    ),
  };
  const stats = lstatSync(target);
  if (!stats.isFile() || stats.isSymbolicLink()) refuse("target database is not a regular file");
  input.blob_store.assertSameVolume(target);
  const before = databaseFileDigest(target);
  const proof = new Database(target, { readonly: true, fileMustExist: true });
  try {
    proof.pragma("foreign_keys = ON");
    proof.pragma("query_only = ON");
    verifyFreshEpochDatabase(proof, expectedIdentity);
  } finally {
    proof.close();
  }
  if (databaseFileDigest(target) !== before) {
    refuse("read-only epoch verification changed the database bytes");
  }

  const db = new Database(target, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    verifyFreshEpochDatabase(db, expectedIdentity);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openOrInitializeFreshEpochDatabase(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  release_id: string;
  runtime_capability_digest: string;
  bootstrap: FreshEpochBootstrap;
  now?: () => string;
}): Database.Database {
  const bootstrap = validateFreshEpochBootstrap(input.bootstrap);
  const expected_identity: FreshEpochIdentity = {
    release_id: boundedString(input.release_id, "release_id", 200),
    runtime_capability_digest: lowercaseSha256(
      input.runtime_capability_digest,
      "runtime_capability_digest",
    ),
    blob_store_id: input.blob_store.store_id,
    blob_marker_checksum: input.blob_store.marker_checksum,
    bootstrap_checksum: bootstrap.checksum,
  };
  return existsSync(input.database_path)
    ? openFreshEpochDatabase({
      database_path: input.database_path,
      blob_store: input.blob_store,
      expected_identity,
    })
    : initializeFreshEpochDatabase({ ...input, bootstrap });
}
