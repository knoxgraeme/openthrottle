import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
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
import {
  ACTIVE_ATTEMPT_STATUSES,
  ACTIVE_EFFECT_STATUSES,
  ACTIVE_RUN_STATUSES,
} from "./kernel-active-statuses.js";
import { placeholders } from "./kernel-store-codecs.js";

export const FRESH_EPOCH_BOOTSTRAP_SCHEMA = "openthrottle.fresh-epoch-bootstrap/v1" as const;
export const FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA =
  "openthrottle.epoch-release-acceptance-request/v1" as const;
export const FRESH_EPOCH_RELEASE_ACCEPTANCE_SCHEMA =
  "openthrottle.epoch-release-acceptance/v1" as const;
const RESERVED_SETTING_PREFIX = "epoch.";
const RELEASE_ACCEPTANCE_SETTING_PREFIX = "epoch.release_acceptance.";
const MAX_BOOTSTRAP_SETTINGS = 128;
const MAX_BOOTSTRAP_REGISTRATIONS = 256;
const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/;
const BLOB_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DATABASE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

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

export interface FreshEpochReleaseAcceptanceRequest {
  schema: typeof FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA;
  transition_id: string;
  expected_maintenance_version: number;
  expected_current_identity: FreshEpochIdentity;
  candidate_identity: FreshEpochIdentity;
  candidate_schema_version: number;
  candidate_schema_checksum: string;
}

export interface FreshEpochReleaseAcceptance {
  schema: typeof FRESH_EPOCH_RELEASE_ACCEPTANCE_SCHEMA;
  transition_id: string;
  request_hash: string;
  sequence: number;
  accepted_at: string;
  maintenance_version: number;
  schema_version: number;
  schema_checksum: string;
  from_identity: FreshEpochIdentity;
  to_identity: FreshEpochIdentity;
}

export type FreshEpochReleaseAcceptanceStep = "pins_advanced" | "evidence_inserted";

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

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    refuse(`${path} must be a nonnegative safe integer`);
  }
  return value as number;
}

function normalizeIdentity(value: FreshEpochIdentity, path: string): FreshEpochIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(`${path} must be an object`);
  }
  exactKeys(value as unknown as Record<string, unknown>, [
    "release_id", "runtime_capability_digest", "blob_store_id",
    "blob_marker_checksum", "bootstrap_checksum",
  ], path);
  const blobStoreId = boundedString(value.blob_store_id, `${path}.blob_store_id`, 200);
  if (!BLOB_STORE_ID.test(blobStoreId)) refuse(`${path}.blob_store_id is invalid`);
  return {
    release_id: boundedString(value.release_id, `${path}.release_id`, 200),
    runtime_capability_digest: lowercaseSha256(
      value.runtime_capability_digest,
      `${path}.runtime_capability_digest`,
    ),
    blob_store_id: blobStoreId,
    blob_marker_checksum: lowercaseSha256(
      value.blob_marker_checksum,
      `${path}.blob_marker_checksum`,
    ),
    bootstrap_checksum: lowercaseSha256(
      value.bootstrap_checksum,
      `${path}.bootstrap_checksum`,
    ),
  };
}

function identitiesMatch(left: FreshEpochIdentity, right: FreshEpochIdentity): boolean {
  return left.release_id === right.release_id &&
    left.runtime_capability_digest === right.runtime_capability_digest &&
    left.blob_store_id === right.blob_store_id &&
    left.blob_marker_checksum === right.blob_marker_checksum &&
    left.bootstrap_checksum === right.bootstrap_checksum;
}

function normalizedReleaseAcceptanceRequest(
  value: FreshEpochReleaseAcceptanceRequest,
): FreshEpochReleaseAcceptanceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("release acceptance request must be an object");
  }
  exactKeys(value as unknown as Record<string, unknown>, [
    "schema", "transition_id", "expected_maintenance_version",
    "expected_current_identity", "candidate_identity",
    "candidate_schema_version", "candidate_schema_checksum",
  ], "release acceptance request");
  if (value.schema !== FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA) {
    refuse("release acceptance request schema is unsupported");
  }
  const transitionId = boundedString(value.transition_id, "transition_id", 160);
  if (!ID.test(transitionId) || `${RELEASE_ACCEPTANCE_SETTING_PREFIX}${transitionId}`.length > 200) {
    refuse("transition_id is invalid or too long");
  }
  const expectedCurrentIdentity = normalizeIdentity(
    value.expected_current_identity,
    "expected_current_identity",
  );
  const candidateIdentity = normalizeIdentity(value.candidate_identity, "candidate_identity");
  if (
    expectedCurrentIdentity.blob_store_id !== candidateIdentity.blob_store_id ||
    expectedCurrentIdentity.blob_marker_checksum !== candidateIdentity.blob_marker_checksum ||
    expectedCurrentIdentity.bootstrap_checksum !== candidateIdentity.bootstrap_checksum
  ) {
    refuse("release acceptance may change only release and runtime-capability identity");
  }
  if (
    expectedCurrentIdentity.release_id === candidateIdentity.release_id &&
    expectedCurrentIdentity.runtime_capability_digest === candidateIdentity.runtime_capability_digest
  ) {
    refuse("release acceptance candidate identity is unchanged");
  }
  const candidateSchemaVersion = nonnegativeInteger(
    value.candidate_schema_version,
    "candidate_schema_version",
  );
  const candidateSchemaChecksum = lowercaseSha256(
    value.candidate_schema_checksum,
    "candidate_schema_checksum",
  );
  if (
    candidateSchemaVersion !== FRESH_EPOCH_VERSION ||
    candidateSchemaChecksum !== FRESH_EPOCH_SCHEMA_CHECKSUM
  ) {
    refuse("candidate schema identity changed; a fresh epoch is required");
  }
  return {
    schema: FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA,
    transition_id: transitionId,
    expected_maintenance_version: nonnegativeInteger(
      value.expected_maintenance_version,
      "expected_maintenance_version",
    ),
    expected_current_identity: expectedCurrentIdentity,
    candidate_identity: candidateIdentity,
    candidate_schema_version: candidateSchemaVersion,
    candidate_schema_checksum: candidateSchemaChecksum,
  };
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

function readIdentitySetting(db: Database.Database, key: string): { value: string; version: number } {
  const row = db.prepare("SELECT value_json, value_type, mutable, version FROM settings WHERE key = ?")
    .get(key) as { value_json: string; value_type: string; mutable: number; version: number } | undefined;
  if (!row || row.value_type !== "string" || row.mutable !== 0) refuse(`missing immutable ${key} setting`);
  const value: unknown = JSON.parse(row.value_json);
  if (typeof value !== "string") refuse(`${key} setting is not a string`);
  return { value, version: nonnegativeInteger(row.version, `${key}.version`) };
}

function verifyFreshEpochStructure(db: Database.Database): void {
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
}

interface FreshEpochIdentityState {
  identity: FreshEpochIdentity;
  sequence: number;
}

function readFreshEpochIdentityState(db: Database.Database): FreshEpochIdentityState {
  const release = readIdentitySetting(db, "epoch.release_id");
  const runtime = readIdentitySetting(db, "epoch.runtime_capability_digest");
  if (release.version !== runtime.version) {
    refuse("release identity pin versions are inconsistent");
  }
  return {
    identity: {
      release_id: release.value,
      runtime_capability_digest: lowercaseSha256(
        runtime.value,
        "epoch.runtime_capability_digest",
      ),
      blob_store_id: readIdentitySetting(db, "epoch.blob_store_id").value,
      blob_marker_checksum: lowercaseSha256(
        readIdentitySetting(db, "epoch.blob_marker_checksum").value,
        "epoch.blob_marker_checksum",
      ),
      bootstrap_checksum: lowercaseSha256(
        readIdentitySetting(db, "epoch.bootstrap_checksum").value,
        "epoch.bootstrap_checksum",
      ),
    },
    sequence: release.version,
  };
}

function acceptedReleaseRequest(acceptance: FreshEpochReleaseAcceptance): FreshEpochReleaseAcceptanceRequest {
  return {
    schema: FRESH_EPOCH_RELEASE_ACCEPTANCE_REQUEST_SCHEMA,
    transition_id: acceptance.transition_id,
    expected_maintenance_version: acceptance.maintenance_version,
    expected_current_identity: acceptance.from_identity,
    candidate_identity: acceptance.to_identity,
    candidate_schema_version: acceptance.schema_version,
    candidate_schema_checksum: acceptance.schema_checksum,
  };
}

function parseReleaseAcceptance(value: unknown, path: string): FreshEpochReleaseAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`${path} must be an object`);
  const input = value as FreshEpochReleaseAcceptance;
  exactKeys(input as unknown as Record<string, unknown>, [
    "schema", "transition_id", "request_hash", "sequence", "accepted_at",
    "maintenance_version", "schema_version", "schema_checksum", "from_identity", "to_identity",
  ], path);
  if (input.schema !== FRESH_EPOCH_RELEASE_ACCEPTANCE_SCHEMA) refuse(`${path}.schema is unsupported`);
  const acceptance: FreshEpochReleaseAcceptance = {
    schema: FRESH_EPOCH_RELEASE_ACCEPTANCE_SCHEMA,
    transition_id: boundedString(input.transition_id, `${path}.transition_id`, 160),
    request_hash: lowercaseSha256(input.request_hash, `${path}.request_hash`),
    sequence: nonnegativeInteger(input.sequence, `${path}.sequence`),
    accepted_at: boundedString(input.accepted_at, `${path}.accepted_at`, 100),
    maintenance_version: nonnegativeInteger(input.maintenance_version, `${path}.maintenance_version`),
    schema_version: nonnegativeInteger(input.schema_version, `${path}.schema_version`),
    schema_checksum: lowercaseSha256(input.schema_checksum, `${path}.schema_checksum`),
    from_identity: normalizeIdentity(input.from_identity, `${path}.from_identity`),
    to_identity: normalizeIdentity(input.to_identity, `${path}.to_identity`),
  };
  const normalizedRequest = normalizedReleaseAcceptanceRequest(acceptedReleaseRequest(acceptance));
  if (acceptance.request_hash !== digestCanonicalJson(normalizedRequest)) {
    refuse(`${path}.request_hash does not authenticate the acceptance evidence`);
  }
  return acceptance;
}

function releaseAcceptances(db: Database.Database): FreshEpochReleaseAcceptance[] {
  const rows = db.prepare(`
    SELECT key, value_json, value_type, mutable, version
    FROM settings WHERE key GLOB ? ORDER BY key
  `).all(`${RELEASE_ACCEPTANCE_SETTING_PREFIX}*`) as Array<{
    key: string;
    value_json: string;
    value_type: string;
    mutable: number;
    version: number;
  }>;
  return rows.map((row, index) => {
    if (row.value_type !== "json" || row.mutable !== 0 || row.version !== 0) {
      refuse(`release acceptance evidence ${row.key} is not immutable JSON`);
    }
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      refuse(`release acceptance evidence ${row.key} is invalid JSON`);
    }
    const acceptance = parseReleaseAcceptance(value, `release acceptance evidence[${index}]`);
    if (row.key !== `${RELEASE_ACCEPTANCE_SETTING_PREFIX}${acceptance.transition_id}`) {
      refuse(`release acceptance evidence ${row.key} has inconsistent identity`);
    }
    return acceptance;
  });
}

function verifyReleaseAcceptanceChain(
  db: Database.Database,
  state: FreshEpochIdentityState,
): FreshEpochReleaseAcceptance[] {
  const acceptances = releaseAcceptances(db).sort((left, right) => left.sequence - right.sequence);
  if (acceptances.length !== state.sequence) {
    refuse("release acceptance chain does not match the current pin version");
  }
  for (const [index, acceptance] of acceptances.entries()) {
    if (acceptance.sequence !== index + 1) refuse("release acceptance sequence is not contiguous");
    if (
      index > 0 &&
      !identitiesMatch(acceptances[index - 1]!.to_identity, acceptance.from_identity)
    ) {
      refuse("release acceptance identity chain is divergent");
    }
  }
  const latest = acceptances.at(-1);
  if (latest && !identitiesMatch(latest.to_identity, state.identity)) {
    refuse("latest release acceptance evidence does not match the current pins");
  }
  return acceptances;
}

export function verifyFreshEpochDatabase(
  db: Database.Database,
  expected: FreshEpochIdentity,
): FreshEpochVerification {
  const expectedIdentity = normalizeIdentity(expected, "expected identity");
  verifyFreshEpochStructure(db);
  const state = readFreshEpochIdentityState(db);
  verifyReleaseAcceptanceChain(db, state);
  const actual = state.identity;
  if (!identitiesMatch(actual, expectedIdentity)) {
    refuse("release, runtime capability, bootstrap, or blob-root identity mismatch");
  }
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

export function verifyFreshEpochBootstrapOnly(db: Database.Database, input: FreshEpochBootstrap): void {
  const bootstrap = validateFreshEpochBootstrap(input);
  const expectedSupportRows = bootstrap.settings.length + 6;
  const settingCount = db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
  const registrationCount = db.prepare("SELECT COUNT(*) AS count FROM repository_registrations").get() as { count: number };
  if (settingCount.count !== expectedSupportRows || registrationCount.count !== bootstrap.repository_registrations.length) {
    refuse("fresh epoch bootstrap row counts do not match the manifest");
  }
  const maintenance = db.prepare(`
    SELECT value_json, value_type, mutable, version
    FROM settings WHERE key = ?
  `).get(KERNEL_INGRESS_MAINTENANCE_SETTING) as {
    value_json: string;
    value_type: string;
    mutable: number;
    version: number;
  } | undefined;
  if (!maintenance || canonicalJson(maintenance) !== canonicalJson({
    value_json: "true", value_type: "boolean", mutable: 1, version: 0,
  })) {
    refuse("fresh epoch maintenance ingress fence is not closed at version zero");
  }
  const actualSettings = db.prepare(`
    SELECT key, value_json, value_type, mutable, version
    FROM settings WHERE key NOT GLOB 'epoch.*' ORDER BY key
  `).all();
  const expectedSettings = bootstrap.settings.map((setting) => ({
    key: setting.key,
    value_json: canonicalJson(setting.value),
    value_type: setting.value_type,
    mutable: setting.mutable ? 1 : 0,
    version: 0,
  })).sort((left, right) => compareCodeUnits(left.key, right.key));
  if (canonicalJson(actualSettings) !== canonicalJson(expectedSettings)) {
    refuse("fresh epoch bootstrap settings do not match the manifest");
  }
  const actualRegistrations = db.prepare(`
    SELECT
      id, control_provider, route_key, linear_team_id, linear_team_key,
      github_repo, github_installation_id, base_branch, webhook_id,
      runtime_snapshot, version
    FROM repository_registrations ORDER BY id
  `).all();
  const expectedRegistrations = bootstrap.repository_registrations.map((registration) => ({
    ...registration,
    version: 0,
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
  if (canonicalJson(actualRegistrations) !== canonicalJson(expectedRegistrations)) {
    refuse("fresh epoch bootstrap registrations do not match the manifest");
  }
  for (const table of [
    "leases", "work_items", "inbox_events", "definitions", "pipeline_runs", "attempts",
    "records", "effects", "checkpoints",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (row.count !== 0) refuse(`fresh epoch bootstrap unexpectedly populated ${table}`);
  }
}

function assertNoRows(
  db: Database.Database,
  sql: string,
  parameters: readonly unknown[],
  detail: string,
): void {
  const row = db.prepare(sql).get(...parameters) as { count: number };
  if (row.count !== 0) refuse(`epoch is not quiesced: ${detail} (${row.count})`);
}

function assertReleaseAcceptanceQuiescence(
  db: Database.Database,
  expectedMaintenanceVersion: number,
): void {
  const maintenance = db.prepare(`
    SELECT value_json, value_type, mutable, version
    FROM settings WHERE key = ?
  `).get(KERNEL_INGRESS_MAINTENANCE_SETTING) as {
    value_json: string;
    value_type: string;
    mutable: number;
    version: number;
  } | undefined;
  if (
    !maintenance || maintenance.value_json !== "true" || maintenance.value_type !== "boolean" ||
    maintenance.mutable !== 1
  ) {
    refuse("release acceptance requires maintenance ingress to be closed");
  }
  if (maintenance.version !== expectedMaintenanceVersion) {
    refuse("release acceptance maintenance version is stale");
  }
  assertNoRows(db, "SELECT COUNT(*) AS count FROM leases", [], "global leases remain");
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM work_items WHERE state IN ('admitted', 'active')`,
    [],
    "active work items remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM pipeline_runs WHERE status IN (${placeholders(ACTIVE_RUN_STATUSES.length)})`,
    ACTIVE_RUN_STATUSES,
    "active pipeline runs remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM attempts WHERE status IN (${placeholders(ACTIVE_ATTEMPT_STATUSES.length)})`,
    ACTIVE_ATTEMPT_STATUSES,
    "nonterminal Attempts remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM attempts WHERE lease_id IS NOT NULL`,
    [],
    "Attempt leases remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM effects WHERE status IN (${placeholders(ACTIVE_EFFECT_STATUSES.length)})`,
    ACTIVE_EFFECT_STATUSES,
    "nonterminal Effects remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM effects WHERE lease_id IS NOT NULL`,
    [],
    "Effect leases remain",
  );
  assertNoRows(
    db,
    `SELECT COUNT(*) AS count FROM inbox_events
     WHERE status IN ('pending', 'processing') OR lease_id IS NOT NULL`,
    [],
    "pending or processing inbox events remain",
  );
}

/**
 * Advances only the release/runtime-capability pins of one offline epoch.
 * The caller must derive candidate_identity from authenticated candidate
 * artifacts; this boundary reauthenticates every durable database fence under
 * one exclusive transaction before changing either pin.
 */
export function acceptFreshEpochRelease(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  request: FreshEpochReleaseAcceptanceRequest;
  now?: () => string;
  fault_injector?: (step: FreshEpochReleaseAcceptanceStep) => void;
}): FreshEpochReleaseAcceptance {
  const request = normalizedReleaseAcceptanceRequest(input.request);
  const requestHash = digestCanonicalJson(request);
  const target = resolve(input.database_path);
  const stats = lstatSync(target);
  if (!stats.isFile() || stats.isSymbolicLink()) refuse("target database is not a regular file");
  input.blob_store.assertSameVolume(target);
  const db = new Database(target, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    return db.transaction(() => {
      verifyFreshEpochStructure(db);
      const state = readFreshEpochIdentityState(db);
      const acceptances = verifyReleaseAcceptanceChain(db, state);
      const replay = acceptances.find((acceptance) => acceptance.transition_id === request.transition_id);
      if (replay) {
        if (replay.request_hash !== requestHash) {
          refuse("release acceptance transition_id conflicts with its durable evidence");
        }
        return replay;
      }
      if (!identitiesMatch(state.identity, request.expected_current_identity)) {
        refuse("release acceptance expected-current identity is stale or divergent");
      }
      if (
        input.blob_store.store_id !== state.identity.blob_store_id ||
        input.blob_store.marker_checksum !== state.identity.blob_marker_checksum
      ) {
        refuse("release acceptance BlobStore identity is stale or divergent");
      }
      assertReleaseAcceptanceQuiescence(db, request.expected_maintenance_version);

      const acceptedAt = boundedString(
        (input.now ?? (() => new Date().toISOString()))(),
        "accepted_at",
        100,
      );
      const acceptance: FreshEpochReleaseAcceptance = {
        schema: FRESH_EPOCH_RELEASE_ACCEPTANCE_SCHEMA,
        transition_id: request.transition_id,
        request_hash: requestHash,
        sequence: state.sequence + 1,
        accepted_at: acceptedAt,
        maintenance_version: request.expected_maintenance_version,
        schema_version: request.candidate_schema_version,
        schema_checksum: request.candidate_schema_checksum,
        from_identity: request.expected_current_identity,
        to_identity: request.candidate_identity,
      };
      if (Buffer.byteLength(canonicalJson(acceptance), "utf8") > 16 * 1024) {
        refuse("release acceptance evidence exceeds 16384 bytes");
      }

      const trigger = db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'settings_immutable_update'
      `).get() as { sql: string | null } | undefined;
      if (!trigger?.sql) refuse("immutable settings update trigger is missing");
      db.exec("DROP TRIGGER settings_immutable_update");
      const update = db.prepare(`
        UPDATE settings
        SET value_json = ?, version = version + 1, updated_at = ?
        WHERE key = ? AND value_json = ? AND version = ? AND mutable = 0
      `);
      for (const [key, previous, candidate] of [
        ["epoch.release_id", state.identity.release_id, request.candidate_identity.release_id],
        [
          "epoch.runtime_capability_digest",
          state.identity.runtime_capability_digest,
          request.candidate_identity.runtime_capability_digest,
        ],
      ] as const) {
        const result = update.run(
          canonicalJson(candidate),
          acceptedAt,
          key,
          canonicalJson(previous),
          state.sequence,
        );
        if (result.changes !== 1) refuse(`release acceptance lost the ${key} compare-and-set`);
      }
      input.fault_injector?.("pins_advanced");
      db.prepare(`
        INSERT INTO settings (key, value_json, value_type, mutable, version, updated_at)
        VALUES (?, ?, 'json', 0, 0, ?)
      `).run(
        `${RELEASE_ACCEPTANCE_SETTING_PREFIX}${request.transition_id}`,
        canonicalJson(acceptance),
        acceptedAt,
      );
      input.fault_injector?.("evidence_inserted");
      db.exec(trigger.sql);

      verifyFreshEpochStructure(db);
      const acceptedState = readFreshEpochIdentityState(db);
      verifyReleaseAcceptanceChain(db, acceptedState);
      if (!identitiesMatch(acceptedState.identity, request.candidate_identity)) {
        refuse("release acceptance did not install the candidate identity");
      }
      return acceptance;
    }).exclusive();
  } finally {
    db.close();
  }
}

function pathEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function assertNoDatabaseSidecars(target: string): void {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    if (pathEntryExists(`${target}${suffix}`)) {
      refuse(`target database sidecar exists: ${target}${suffix}`);
    }
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
  for (const suffix of ["", ...DATABASE_SIDECAR_SUFFIXES]) {
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
  if (pathEntryExists(canonicalTarget)) refuse("target database path is not absent");
  assertNoDatabaseSidecars(canonicalTarget);
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
    verifyFreshEpochBootstrapOnly(stagingDb, bootstrap);
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
      verifyFreshEpochBootstrapOnly(proof, bootstrap);
    } finally {
      proof.close();
    }
    if (pathEntryExists(canonicalTarget)) refuse("target database appeared during initialization");
    assertNoDatabaseSidecars(canonicalTarget);
    renameSync(stagingPath, canonicalTarget);
    fsyncPath(parent);
  } catch (error) {
    stagingDb?.close();
    unlinkStagingFiles(stagingPath);
    throw error;
  }
  return openVerifiedFreshEpochDatabase({
    database_path: canonicalTarget,
    blob_store: input.blob_store,
    expected_identity: identity,
  }, "DELETE");
}

function openVerifiedFreshEpochDatabase(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  expected_identity: FreshEpochIdentity;
}, journalMode: "DELETE" | "WAL"): Database.Database {
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
    db.pragma(`journal_mode = ${journalMode}`);
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    verifyFreshEpochDatabase(db, expectedIdentity);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openFreshEpochDatabase(input: {
  database_path: string;
  blob_store: VolumeBlobStore;
  expected_identity: FreshEpochIdentity;
}): Database.Database {
  return openVerifiedFreshEpochDatabase(input, "WAL");
}

/**
 * Opens an existing epoch for receipt recovery without switching journal mode
 * or otherwise mutating its bytes. Normal supervisor boot must use
 * openFreshEpochDatabase() instead.
 */
export function inspectFreshEpochDatabase(input: {
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
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("query_only = ON");
    verifyFreshEpochDatabase(db, expectedIdentity);
    if (databaseFileDigest(target) !== before) {
      refuse("read-only epoch verification changed the database bytes");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
