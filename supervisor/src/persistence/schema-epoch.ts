import type Database from "better-sqlite3";
import { assertDatabaseEpoch } from "./migrations/runner.js";
import { SCHEMA_EPOCH } from "./schema.js";

const OPERATOR_SETTING_KEYS = Object.freeze([
  "codex_auth_json",
  "linear_access_token",
  "linear_refresh_token",
  "linear_token_expires_at",
] as const);

const OPERATOR_SETTING_KEY_SET = new Set<string>(OPERATOR_SETTING_KEYS);

export interface SchemaEpochBackupManifest {
  application_sha: string;
  sqlite_sha256: string;
  wal_sha256: string;
  sealed_at: string;
}

export interface RehydrationArtifact {
  schema: "openthrottle.schema-epoch-rehydration/v1";
  source_schema_epoch: 0;
  target_schema_epoch: 1;
  backup: SchemaEpochBackupManifest;
  settings: Array<{ key: string; value: string }>;
  repository_registrations: Array<{
    github_repo: string;
    control_provider: "linear" | "github";
    linear_team_key: string | null;
    linear_team_id: string | null;
    base_branch: string;
    webhook_id: number;
    snapshot: string;
    created_at: string;
    updated_at: string;
  }>;
}

function requiredString(value: unknown, field: string, max = 10000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function sha256(value: unknown, field: string): string {
  const digest = requiredString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a lowercase sha256`);
  return digest;
}

function backupManifest(value: unknown): SchemaEpochBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup manifest is required");
  }
  const raw = value as Record<string, unknown>;
  const sealedAt = requiredString(raw.sealed_at, "backup.sealed_at", 40);
  if (Number.isNaN(Date.parse(sealedAt))) {
    throw new Error("backup.sealed_at must be an ISO timestamp");
  }
  return {
    application_sha: requiredString(raw.application_sha, "backup.application_sha", 200),
    sqlite_sha256: sha256(raw.sqlite_sha256, "backup.sqlite_sha256"),
    wal_sha256: sha256(raw.wal_sha256, "backup.wal_sha256"),
    sealed_at: sealedAt,
  };
}

export function assertInboundSchemaEpoch(eventEpoch: number): void {
  if (eventEpoch !== SCHEMA_EPOCH) {
    throw new Error(
      `stale inbound event schema epoch ${eventEpoch}; current schema epoch is ${SCHEMA_EPOCH}`
    );
  }
}

export function exportRehydratableConfiguration(
  db: Database.Database,
  backup: SchemaEpochBackupManifest
): RehydrationArtifact {
  assertDatabaseEpoch(db, 0);
  const sealedBackup = backupManifest(backup);
  const settings = db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (${OPERATOR_SETTING_KEYS.map(() => "?").join(", ")})
      AND value IS NOT NULL
    ORDER BY key
  `).all(...OPERATOR_SETTING_KEYS) as Array<{ key: string; value: string }>;
  const repositoryRegistrations = db.prepare(`
    SELECT github_repo, control_provider, linear_team_key, linear_team_id,
           base_branch, webhook_id, snapshot, created_at, updated_at
    FROM repository_registrations
    ORDER BY github_repo
  `).all() as RehydrationArtifact["repository_registrations"];
  return {
    schema: "openthrottle.schema-epoch-rehydration/v1",
    source_schema_epoch: 0,
    target_schema_epoch: SCHEMA_EPOCH,
    backup: sealedBackup,
    settings,
    repository_registrations: repositoryRegistrations,
  };
}

function parseArtifact(value: unknown): RehydrationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rehydration artifact must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== "openthrottle.schema-epoch-rehydration/v1") {
    throw new Error("unsupported rehydration artifact schema");
  }
  if (raw.source_schema_epoch !== 0 || raw.target_schema_epoch !== SCHEMA_EPOCH) {
    throw new Error("rehydration artifact schema epoch mismatch");
  }
  if (!Array.isArray(raw.settings) || !Array.isArray(raw.repository_registrations)) {
    throw new Error("rehydration artifact configuration arrays are required");
  }
  const settings = raw.settings.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`settings[${index}] must be an object`);
    }
    const setting = entry as Record<string, unknown>;
    const key = requiredString(setting.key, `settings[${index}].key`, 100);
    if (!OPERATOR_SETTING_KEY_SET.has(key)) {
      throw new Error(`setting ${key} is not in the operator rehydration inventory`);
    }
    return {
      key,
      value: requiredString(setting.value, `settings[${index}].value`),
    };
  });
  if (new Set(settings.map((entry) => entry.key)).size !== settings.length) {
    throw new Error("rehydration artifact contains duplicate settings");
  }
  const repositoryRegistrations = raw.repository_registrations.map(
    (entry, index): RehydrationArtifact["repository_registrations"][number] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`repository_registrations[${index}] must be an object`);
      }
      const registration = entry as Record<string, unknown>;
      const controlProvider = registration.control_provider;
      if (controlProvider !== "linear" && controlProvider !== "github") {
        throw new Error(`repository_registrations[${index}].control_provider is invalid`);
      }
      const nullable = (field: string): string | null => {
        const fieldValue = registration[field];
        return fieldValue === null
          ? null
          : requiredString(
              fieldValue,
              `repository_registrations[${index}].${field}`,
              500
            );
      };
      const webhookId = registration.webhook_id;
      if (
        typeof webhookId !== "number" ||
        !Number.isSafeInteger(webhookId) ||
        webhookId < 0
      ) {
        throw new Error(`repository_registrations[${index}].webhook_id is invalid`);
      }
      const linearTeamKey = nullable("linear_team_key");
      const linearTeamId = nullable("linear_team_id");
      if (controlProvider === "linear" && linearTeamKey === null) {
        throw new Error("Linear repository registration requires a team key");
      }
      if (controlProvider === "github" && (linearTeamKey !== null || linearTeamId !== null)) {
        throw new Error("GitHub repository registration cannot carry Linear team fields");
      }
      return {
        github_repo: requiredString(
          registration.github_repo,
          `repository_registrations[${index}].github_repo`,
          500
        ),
        control_provider: controlProvider,
        linear_team_key: linearTeamKey,
        linear_team_id: linearTeamId,
        base_branch: requiredString(
          registration.base_branch,
          `repository_registrations[${index}].base_branch`,
          500
        ),
        webhook_id: webhookId,
        snapshot: requiredString(
          registration.snapshot,
          `repository_registrations[${index}].snapshot`,
          131072
        ),
        created_at: requiredString(
          registration.created_at,
          `repository_registrations[${index}].created_at`,
          40
        ),
        updated_at: requiredString(
          registration.updated_at,
          `repository_registrations[${index}].updated_at`,
          40
        ),
      };
    }
  );
  const repos = repositoryRegistrations.map((entry) => entry.github_repo.toLowerCase());
  if (new Set(repos).size !== repos.length) {
    throw new Error("rehydration artifact contains duplicate repository registrations");
  }
  return {
    schema: "openthrottle.schema-epoch-rehydration/v1",
    source_schema_epoch: 0,
    target_schema_epoch: SCHEMA_EPOCH,
    backup: backupManifest(raw.backup),
    settings,
    repository_registrations: repositoryRegistrations,
  };
}

export function importRehydratableConfiguration(
  db: Database.Database,
  value: unknown,
  importedAt = new Date().toISOString()
): void {
  assertDatabaseEpoch(db, SCHEMA_EPOCH);
  const artifact = parseArtifact(value);
  db.transaction(() => {
    const historicalRows = (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tickets) +
        (SELECT COUNT(*) FROM runs) +
        (SELECT COUNT(*) FROM pipeline_instances) AS count
    `).get() as { count: number }).count;
    const configurationRows = (db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM settings) +
        (SELECT COUNT(*) FROM repository_registrations) AS count
    `).get() as { count: number }).count;
    if (historicalRows !== 0 || configurationRows !== 0) {
      throw new Error("rehydration requires a fresh epoch-1 database with no historical or configuration rows");
    }
    const insertSetting = db.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)"
    );
    for (const entry of artifact.settings) {
      insertSetting.run(entry.key, entry.value, importedAt);
    }
    const insertRegistration = db.prepare(`
      INSERT INTO repository_registrations(
        github_repo, control_provider, linear_team_key, linear_team_id,
        base_branch, webhook_id, snapshot, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of artifact.repository_registrations) {
      insertRegistration.run(
        entry.github_repo,
        entry.control_provider,
        entry.linear_team_key,
        entry.linear_team_id,
        entry.base_branch,
        entry.webhook_id,
        entry.snapshot,
        entry.created_at,
        entry.updated_at
      );
    }
    db.prepare(`
      UPDATE schema_authority
      SET first_write_at = COALESCE(first_write_at, ?)
      WHERE singleton = 1
    `).run(importedAt);
  }).exclusive();
}

export function assertRollbackPair(input: {
  backup: SchemaEpochBackupManifest;
  backupSchemaEpoch: number;
  buildApplicationSha: string;
  buildSchemaEpoch: number;
  newEpochHasWrites: boolean;
}): void {
  const backup = backupManifest(input.backup);
  if (backup.application_sha !== input.buildApplicationSha) {
    throw new Error("rollback build SHA does not match the sealed database backup");
  }
  if (input.backupSchemaEpoch !== input.buildSchemaEpoch) {
    throw new Error("rollback build and database schema epochs must match");
  }
  if (input.newEpochHasWrites && input.buildSchemaEpoch !== SCHEMA_EPOCH) {
    throw new Error(
      "old-build rollback is forbidden after the first schema epoch 1 write; drain and perform another fresh reset"
    );
  }
}
