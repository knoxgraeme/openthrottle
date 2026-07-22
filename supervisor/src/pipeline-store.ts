import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestNormalized,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineOutcome,
  type StageOutcome,
  type ValidatedPipelineCatalog,
  type ValidatedPipelineManifest,
  type ValidatedRepositoryConfig,
} from "./pipeline-manifest.js";
import type { ValidatedRuntimeCapabilityDescriptor } from "./sandbox-runtime.js";

export type PipelineInstanceStatus =
  | "pending"
  | "dispatchable"
  | "running"
  | "waiting_provider"
  | "waiting_human"
  | "completion_pending_publication"
  | PipelineOutcome
  | "publication_blocked";

export interface RepositoryConfigSnapshot {
  id: string;
  repository: string;
  base_commit: string;
  blob_sha: string;
  digest: string;
  normalized_config: string;
  created_at: string;
}

export interface PipelineInstance {
  id: string;
  linear_issue_id: string;
  linear_session_id: string;
  generation: number;
  pipeline_id: string;
  pipeline_version: number;
  manifest_digest: string;
  normalized_manifest: string;
  repository: string;
  base_commit: string;
  repository_config_snapshot_id: string;
  repository_config_digest: string;
  runtime_release: string;
  capability_digest: string;
  executor_protocol: string;
  authorized_capabilities: string;
  status: PipelineInstanceStatus;
  active_stage_id: string | null;
  wait_reason: string | null;
  state_version: number;
  attempt_count: number;
  reentry_count: number;
  immutable_subject: string | null;
  terminal_outcome: PipelineOutcome | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineStageAttempt {
  id: string;
  pipeline_instance_id: string;
  stage_id: string;
  attempt_ordinal: number;
  reentry_ordinal: number;
  run_id: string | null;
  request_hash: string;
  idempotency_key: string;
  context_revision: number;
  native_context_policy: string;
  status: "pending" | "leased" | "dispatched" | "acknowledged" | "running" | "completed" | "canceled" | "superseded" | "failed";
  outcome: StageOutcome | null;
  result_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineInstanceStage {
  pipeline_instance_id: string;
  stage_id: string;
  ordinal: number;
  status: string;
  attempt_count: number;
  reentry_count: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineEffectIntent {
  id: string;
  pipeline_instance_id: string;
  transition_version: number;
  kind: "provision" | "bootstrap" | "dispatch_stage" | "stop" | "quarantine" | "cleanup" | "publish_linear" | "publish_github" | "publish_pr";
  idempotency_key: string;
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "acknowledged" | "failed" | "dead";
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  acknowledged_at: string | null;
  last_error: string | null;
}

export interface PipelineInstanceSeed {
  id?: string;
  issueId: string;
  sessionId: string;
  generation: number;
  repository: string;
  baseCommit: string;
  manifest: ValidatedPipelineManifest;
  repositoryConfig: RepositoryConfigSnapshot;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  authorizedCapabilities: string[];
}

export interface CoordinatorArtifactWrite {
  id?: string;
  kind: string;
  schemaVersion: number;
  assurance: AssuranceClass;
  subject?: string | null;
  payload: string;
  hash: string;
}

export interface CoordinatorEffectWrite {
  id?: string;
  kind: PipelineEffectIntent["kind"];
  idempotencyKey: string;
  payload: string;
}

export interface CoordinatorTransitionWrite {
  instanceId: string;
  eventId: string;
  eventPayloadHash: string;
  expectedVersion: number;
  expectedStatus: PipelineInstanceStatus;
  attemptId: string;
  outcome: StageOutcome;
  resultHash: string;
  nextStatus: PipelineInstanceStatus;
  nextStageId?: string | null;
  nextStageStatus?: "dispatchable" | "waiting";
  terminalOutcome?: PipelineOutcome | null;
  waitReason?: string | null;
  immutableSubject?: string | null;
  reentryIncrement?: number;
  artifacts?: CoordinatorArtifactWrite[];
  nextAttempt?: {
    id?: string;
    stageId: string;
    attemptOrdinal: number;
    reentryOrdinal: number;
    requestHash: string;
    idempotencyKey: string;
    contextRevision: number;
    contextPolicy: string;
  };
  effects: CoordinatorEffectWrite[];
}

export interface PipelineStore {
  acceptCatalog(catalog: ValidatedPipelineCatalog): void;
  acceptRuntimeDescriptor(runtime: ValidatedRuntimeCapabilityDescriptor): void;
  saveRepositoryConfigSnapshot(input: {
    id?: string;
    repository: string;
    baseCommit: string;
    blobSha: string;
    config: ValidatedRepositoryConfig;
  }): RepositoryConfigSnapshot;
  pinLegacySession(sessionId: string, issueId: string, generation: number): void;
  supersedeOtherInstances(issueId: string, currentSessionId: string): void;
  createInstance(seed: PipelineInstanceSeed): PipelineInstance;
  getSessionExecutionMode(sessionId: string): "legacy" | "pipeline" | undefined;
  getInstance(id: string): PipelineInstance | undefined;
  getInstanceForSession(sessionId: string): PipelineInstance | undefined;
  getAttempt(id: string): PipelineStageAttempt | undefined;
  getActiveAttempt(instanceId: string): PipelineStageAttempt | undefined;
  listStages(instanceId: string): PipelineInstanceStage[];
  listEffects(instanceId: string): PipelineEffectIntent[];
  claimEffects(nowIso: string, leaseUntilIso: string, limit?: number): PipelineEffectIntent[];
  recordEffectAcknowledgement(input: {
    effectId: string;
    eventId: string;
    payload: string;
  }): void;
  markEffectFailed(effectId: string, error: string, retryAt: string | null): void;
  enqueueInboxEvent(input: {
    id: string;
    instanceId: string;
    generation: number;
    kind: string;
    payload: string;
    subject?: string | null;
  }): "pending" | "stale" | "consumed";
  applyTransition(write: CoordinatorTransitionWrite, faultAfterWrite?: (writeCount: number) => void): PipelineInstance;
}

function assertDigest(label: string, normalized: string, digest: string): void {
  if (digestNormalized(normalized) !== digest) throw new Error(`${label} digest mismatch`);
}

function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}-${digestNormalized(canonicalJson(input)).slice(0, 32)}`;
}

function validatePinnedInstance(db: Database.Database, instance: PipelineInstance): PipelineManifest {
  assertDigest(`pipeline instance ${instance.id} manifest`, instance.normalized_manifest, instance.manifest_digest);
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  if (manifest.id !== instance.pipeline_id || manifest.version !== instance.pipeline_version) {
    throw new Error(`pipeline instance ${instance.id} manifest identity mismatch`);
  }
  const catalog = db.prepare(`
    SELECT normalized_manifest FROM pipeline_catalog_entries
    WHERE pipeline_id = ? AND version = ? AND digest = ?
  `).get(instance.pipeline_id, instance.pipeline_version, instance.manifest_digest) as
    | { normalized_manifest: string }
    | undefined;
  if (!catalog || catalog.normalized_manifest !== instance.normalized_manifest) {
    throw new Error(`pipeline instance ${instance.id} catalog binding mismatch`);
  }
  const config = db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?")
    .get(instance.repository_config_snapshot_id) as RepositoryConfigSnapshot | undefined;
  if (
    !config || config.repository !== instance.repository || config.base_commit !== instance.base_commit ||
    config.digest !== instance.repository_config_digest
  ) throw new Error(`pipeline instance ${instance.id} repository config binding mismatch`);
  assertDigest(`pipeline instance ${instance.id} repository config`, config.normalized_config, config.digest);
  const runtime = db.prepare(`
    SELECT protocol, normalized_descriptor FROM runtime_capability_descriptors
    WHERE runtime_release = ? AND digest = ?
  `).get(instance.runtime_release, instance.capability_digest) as
    | { protocol: string; normalized_descriptor: string }
    | undefined;
  if (!runtime || runtime.protocol !== instance.executor_protocol) {
    throw new Error(`pipeline instance ${instance.id} runtime binding mismatch`);
  }
  assertDigest(`pipeline instance ${instance.id} runtime`, runtime.normalized_descriptor, instance.capability_digest);
  const descriptor = JSON.parse(runtime.normalized_descriptor) as { capabilities?: unknown };
  const descriptorCapabilities = descriptor.capabilities;
  const authorized = JSON.parse(instance.authorized_capabilities) as unknown;
  if (!Array.isArray(authorized) || authorized.some((entry) => typeof entry !== "string")) {
    throw new Error(`pipeline instance ${instance.id} authorized capabilities are not canonical`);
  }
  const authorizedCapabilities = authorized as string[];
  if (canonicalJson([...authorizedCapabilities].sort()) !== instance.authorized_capabilities) {
    throw new Error(`pipeline instance ${instance.id} authorized capabilities are not canonical`);
  }
  if (!Array.isArray(descriptorCapabilities) ||
      authorizedCapabilities.some((entry) => !descriptorCapabilities.includes(entry))) {
    throw new Error(`pipeline instance ${instance.id} authorized capability binding mismatch`);
  }
  const requiredCapabilities = [...manifest.requires.capabilities].sort();
  if (canonicalJson(requiredCapabilities) !== instance.authorized_capabilities) {
    throw new Error(`pipeline instance ${instance.id} manifest capability authorization mismatch`);
  }
  return manifest;
}

export function createPipelineStore(db: Database.Database): PipelineStore {
  const now = () => new Date().toISOString();
  const getInstanceStmt = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?");
  const getAttemptStmt = db.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?");

  const acceptCatalog = db.transaction((catalog: ValidatedPipelineCatalog) => {
    assertDigest("pipeline catalog", catalog.normalized, catalog.digest);
    const expectedCatalog = canonicalJson({
      aliases: catalog.aliases,
      manifests: [...catalog.manifests.values()].map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        digest: entry.digest,
      })).sort((left, right) =>
        `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)
      ),
    });
    if (catalog.normalized !== expectedCatalog) {
      throw new Error("pipeline catalog normalized content mismatch");
    }
    for (const validated of catalog.manifests.values()) {
      assertDigest(`${validated.manifest.id}@${validated.manifest.version}`, validated.normalized, validated.digest);
      if (canonicalJson(validated.manifest) !== validated.normalized) {
        throw new Error(`pipeline ${validated.manifest.id}@${validated.manifest.version} normalized content mismatch`);
      }
      const existing = db.prepare(
        "SELECT digest, normalized_manifest FROM pipeline_catalog_entries WHERE pipeline_id = ? AND version = ?"
      ).get(validated.manifest.id, validated.manifest.version) as
        | { digest: string; normalized_manifest: string }
        | undefined;
      if (existing && (existing.digest !== validated.digest || existing.normalized_manifest !== validated.normalized)) {
        throw new Error(`pipeline ${validated.manifest.id}@${validated.manifest.version} was already accepted with a different digest`);
      }
      db.prepare(`
        INSERT OR IGNORE INTO pipeline_catalog_entries (
          pipeline_id, version, digest, normalized_manifest, accepted_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(validated.manifest.id, validated.manifest.version, validated.digest, validated.normalized, now());
    }
    for (const [alias, reference] of Object.entries(catalog.aliases)) {
      const validated = catalog.manifests.get(`${reference.id}@${reference.version}`);
      if (!validated) throw new Error(`catalog alias ${alias} references an absent manifest`);
      db.prepare(`
        INSERT INTO pipeline_catalog_aliases(alias, pipeline_id, version, digest, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
          version = excluded.version,
          digest = excluded.digest,
          updated_at = excluded.updated_at
      `).run(alias, reference.id, reference.version, validated.digest, now());
    }
  });

  const acceptRuntimeDescriptor = db.transaction((runtime: ValidatedRuntimeCapabilityDescriptor) => {
    assertDigest(`runtime ${runtime.descriptor.release}`, runtime.normalized, runtime.digest);
    if (canonicalJson(runtime.descriptor) !== runtime.normalized) {
      throw new Error(`runtime release ${runtime.descriptor.release} normalized content mismatch`);
    }
    const existing = db.prepare(
      "SELECT digest, normalized_descriptor FROM runtime_capability_descriptors WHERE runtime_release = ?"
    ).get(runtime.descriptor.release) as { digest: string; normalized_descriptor: string } | undefined;
    if (existing && (existing.digest !== runtime.digest || existing.normalized_descriptor !== runtime.normalized)) {
      throw new Error(`runtime release ${runtime.descriptor.release} was already accepted with a different digest`);
    }
    db.prepare(`
      INSERT OR IGNORE INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(runtime.descriptor.release, runtime.digest, runtime.descriptor.protocol, runtime.normalized, now());
  });

  const saveRepositoryConfigSnapshot = db.transaction((input: {
    id?: string;
    repository: string;
    baseCommit: string;
    blobSha: string;
    config: ValidatedRepositoryConfig;
  }): RepositoryConfigSnapshot => {
    assertDigest("repository config", input.config.normalized, input.config.digest);
    if (canonicalJson(input.config.config) !== input.config.normalized) {
      throw new Error("repository config normalized content mismatch");
    }
    const id = input.id ?? deterministicId("repo-config", [
      input.repository, input.baseCommit, input.blobSha, input.config.digest,
    ]);
    const existing = db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?").get(id) as RepositoryConfigSnapshot | undefined;
    if (existing) {
      if (
        existing.repository !== input.repository || existing.base_commit !== input.baseCommit ||
        existing.blob_sha !== input.blobSha || existing.digest !== input.config.digest ||
        existing.normalized_config !== input.config.normalized
      ) throw new Error(`repository config snapshot ${id} already exists with different content`);
      return existing;
    }
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.repository, input.baseCommit, input.blobSha, input.config.digest, input.config.normalized, now());
    return db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?").get(id) as RepositoryConfigSnapshot;
  });

  const pinLegacySession = db.transaction((sessionId: string, issueId: string, generation: number) => {
    const existing = db.prepare("SELECT * FROM session_executions WHERE linear_session_id = ?").get(sessionId) as
      | { linear_issue_id: string; generation: number; execution_mode: string; pipeline_instance_id: string | null }
      | undefined;
    if (existing) {
      if (existing.linear_issue_id !== issueId || existing.generation !== generation || existing.execution_mode !== "legacy" || existing.pipeline_instance_id !== null) {
        throw new Error(`session ${sessionId} execution mode is already pinned differently`);
      }
      return;
    }
    db.prepare(`
      INSERT INTO session_executions (
        linear_session_id, linear_issue_id, generation, execution_mode, pipeline_instance_id, pinned_at
      ) VALUES (?, ?, ?, 'legacy', NULL, ?)
    `).run(sessionId, issueId, generation, now());
  });

  const supersedeOtherInstances = db.transaction((issueId: string, currentSessionId: string) => {
    const instances = db.prepare(`
      SELECT * FROM pipeline_instances
      WHERE linear_issue_id = ? AND linear_session_id <> ?
        AND status NOT IN ('shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed')
    `).all(issueId, currentSessionId) as PipelineInstance[];
    const timestamp = now();
    for (const instance of instances) {
      const nextVersion = instance.state_version + 1;
      db.prepare(`
        UPDATE pipeline_stage_attempts
        SET status = 'superseded', outcome = 'superseded', completed_at = ?, updated_at = ?
        WHERE pipeline_instance_id = ?
          AND status IN ('pending', 'leased', 'dispatched', 'acknowledged', 'running')
      `).run(timestamp, timestamp, instance.id);
      db.prepare(`
        UPDATE pipeline_instance_stages SET status = 'superseded', updated_at = ?
        WHERE pipeline_instance_id = ?
          AND status IN ('pending', 'dispatchable', 'running', 'waiting')
      `).run(timestamp, instance.id);
      db.prepare(`
        UPDATE pipeline_inbox_events SET status = 'dead'
        WHERE pipeline_instance_id = ? AND status = 'pending'
      `).run(instance.id);
      db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'dead', last_error = 'superseded by a newer delegated generation'
        WHERE pipeline_instance_id = ? AND status IN ('pending', 'processing', 'failed')
      `).run(instance.id);
      db.prepare(`
        UPDATE pipeline_instances
        SET status = 'superseded', active_stage_id = NULL,
            wait_reason = 'superseded by a newer delegated generation',
            terminal_outcome = 'superseded', state_version = ?, updated_at = ?
        WHERE id = ? AND state_version = ?
      `).run(nextVersion, timestamp, instance.id, instance.state_version);
      const payload = canonicalJson({
        pipelineInstanceId: instance.id,
        reason: "newer_delegated_generation",
        replacementSessionId: currentSessionId,
      });
      db.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at
        ) VALUES (?, ?, ?, 'stop', ?, ?, ?, 'pending', ?, ?)
      `).run(
        deterministicId("effect", [instance.id, nextVersion, "supersede-stop"]),
        instance.id,
        nextVersion,
        `stop:${instance.id}:superseded:${nextVersion}`,
        payload,
        digestNormalized(payload),
        timestamp,
        timestamp
      );
    }
  });

  const createInstance = db.transaction((seed: PipelineInstanceSeed): PipelineInstance => {
    assertDigest("manifest", seed.manifest.normalized, seed.manifest.digest);
    if (canonicalJson(seed.manifest.manifest) !== seed.manifest.normalized) {
      throw new Error("manifest normalized content mismatch");
    }
    assertDigest("repository config", seed.repositoryConfig.normalized_config, seed.repositoryConfig.digest);
    assertDigest("runtime descriptor", seed.runtime.normalized, seed.runtime.digest);
    if (canonicalJson(seed.runtime.descriptor) !== seed.runtime.normalized) {
      throw new Error("runtime descriptor normalized content mismatch");
    }
    const instanceId = seed.id ?? deterministicId("pipeline", [
      seed.issueId, seed.sessionId, seed.generation, seed.manifest.manifest.id,
      seed.manifest.manifest.version, seed.manifest.digest,
    ]);
    const existingExecution = db.prepare(
      "SELECT execution_mode, pipeline_instance_id, generation FROM session_executions WHERE linear_session_id = ?"
    ).get(seed.sessionId) as { execution_mode: string; pipeline_instance_id: string | null; generation: number } | undefined;
    if (existingExecution) {
      if (existingExecution.execution_mode === "pipeline" && existingExecution.pipeline_instance_id === instanceId) {
        const existing = getInstanceStmt.get(instanceId) as PipelineInstance;
        validatePinnedInstance(db, existing);
        if (
          existing.linear_issue_id !== seed.issueId || existing.linear_session_id !== seed.sessionId ||
          existing.generation !== seed.generation || existing.repository !== seed.repository ||
          existing.base_commit !== seed.baseCommit || existing.manifest_digest !== seed.manifest.digest ||
          existing.repository_config_snapshot_id !== seed.repositoryConfig.id ||
          existing.repository_config_digest !== seed.repositoryConfig.digest ||
          existing.runtime_release !== seed.runtime.descriptor.release ||
          existing.capability_digest !== seed.runtime.digest ||
          existing.authorized_capabilities !== canonicalJson([...new Set(seed.authorizedCapabilities)].sort())
        ) throw new Error(`pipeline instance ${instanceId} is already pinned differently`);
        return existing;
      }
      throw new Error(`session ${seed.sessionId} execution mode is already pinned`);
    }
    const session = db.prepare("SELECT linear_issue_id, generation FROM agent_sessions WHERE id = ?").get(seed.sessionId) as
      | { linear_issue_id: string; generation: number }
      | undefined;
    if (!session || session.linear_issue_id !== seed.issueId || session.generation !== seed.generation) {
      throw new Error(`session ${seed.sessionId} generation binding mismatch`);
    }
    const catalogEntry = db.prepare(`
      SELECT 1 FROM pipeline_catalog_entries
      WHERE pipeline_id = ? AND version = ? AND digest = ? AND normalized_manifest = ?
    `).get(seed.manifest.manifest.id, seed.manifest.manifest.version, seed.manifest.digest, seed.manifest.normalized);
    if (!catalogEntry) throw new Error("pipeline manifest has not been accepted into the catalog");
    const snapshot = db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?").get(seed.repositoryConfig.id) as RepositoryConfigSnapshot | undefined;
    if (!snapshot || snapshot.digest !== seed.repositoryConfig.digest || snapshot.base_commit !== seed.baseCommit || snapshot.repository !== seed.repository) {
      throw new Error("repository config snapshot binding mismatch");
    }
    const runtime = db.prepare(`
      SELECT 1 FROM runtime_capability_descriptors
      WHERE runtime_release = ? AND digest = ? AND normalized_descriptor = ?
    `).get(seed.runtime.descriptor.release, seed.runtime.digest, seed.runtime.normalized);
    if (!runtime) throw new Error("runtime capability descriptor has not been accepted");
    const authorized = [...new Set(seed.authorizedCapabilities)].sort();
    const required = [...seed.manifest.manifest.requires.capabilities].sort();
    if (canonicalJson(authorized) !== canonicalJson(required)) {
      throw new Error("authorized capabilities must exactly match manifest requirements");
    }
    for (const capability of authorized) {
      if (!seed.runtime.descriptor.capabilities.includes(capability)) {
        throw new Error(`authorized capability ${capability} is absent from the runtime descriptor`);
      }
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id,
        pipeline_version, manifest_digest, normalized_manifest, repository,
        base_commit, repository_config_snapshot_id, repository_config_digest,
        runtime_release, capability_digest, executor_protocol,
        authorized_capabilities, status, active_stage_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatchable', ?, 1, ?, ?)
    `).run(
      instanceId, seed.issueId, seed.sessionId, seed.generation,
      seed.manifest.manifest.id, seed.manifest.manifest.version,
      seed.manifest.digest, seed.manifest.normalized, seed.repository,
      seed.baseCommit, snapshot.id, snapshot.digest, seed.runtime.descriptor.release,
      seed.runtime.digest, seed.runtime.descriptor.protocol, canonicalJson(authorized),
      seed.manifest.manifest.entry_stage, timestamp, timestamp
    );
    seed.manifest.manifest.stages.forEach((stage, index) => {
      db.prepare(`
        INSERT INTO pipeline_instance_stages (
          pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        instanceId,
        stage.id,
        index + 1,
        stage.id === seed.manifest.manifest.entry_stage ? "dispatchable" : "pending",
        stage.id === seed.manifest.manifest.entry_stage ? 1 : 0,
        timestamp,
        timestamp
      );
    });
    db.prepare(`
      INSERT INTO session_executions (
        linear_session_id, linear_issue_id, generation, execution_mode,
        pipeline_instance_id, pinned_at
      ) VALUES (?, ?, ?, 'pipeline', ?, ?)
    `).run(seed.sessionId, seed.issueId, seed.generation, instanceId, timestamp);
    const entry = seed.manifest.manifest.stages.find((stage) => stage.id === seed.manifest.manifest.entry_stage)!;
    const attemptId = deterministicId("attempt", [instanceId, entry.id, 1, 0]);
    const requestHash = digestNormalized(canonicalJson({
      instanceId,
      manifestDigest: seed.manifest.digest,
      runtimeRelease: seed.runtime.descriptor.release,
      capabilityDigest: seed.runtime.digest,
      stageId: entry.id,
      attemptId,
      issueId: seed.issueId,
      sessionId: seed.sessionId,
      generation: seed.generation,
      repository: seed.repository,
      baseCommit: seed.baseCommit,
      contextRevision: 0,
      contextPolicy: entry.context,
      capability: entry.executor.capability,
    }));
    const idempotencyKey = `stage:${instanceId}:${entry.id}:1:0:${requestHash}`;
    db.prepare(`
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 0, ?, ?, 0, ?, 'pending', ?, ?)
    `).run(attemptId, instanceId, entry.id, requestHash, idempotencyKey, entry.context, timestamp, timestamp);
    const provisionPayload = canonicalJson({
      pipelineInstanceId: instanceId,
      repository: seed.repository,
      baseCommit: seed.baseCommit,
      repositoryConfigDigest: snapshot.digest,
      runtimeRelease: seed.runtime.descriptor.release,
    });
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, 1, 'provision', ?, ?, ?, 'pending', ?, ?)
    `).run(
      deterministicId("effect", [instanceId, 1, "provision"]),
      instanceId,
      `provision:${instanceId}`,
      provisionPayload,
      digestNormalized(provisionPayload),
      timestamp,
      timestamp
    );
    const result = getInstanceStmt.get(instanceId) as PipelineInstance;
    validatePinnedInstance(db, result);
    return result;
  });

  const enqueueInboxEvent = db.transaction((input: {
    id: string;
    instanceId: string;
    generation: number;
    kind: string;
    payload: string;
    subject?: string | null;
  }): "pending" | "stale" | "consumed" => {
    const instance = getInstanceStmt.get(input.instanceId) as PipelineInstance | undefined;
    if (!instance) throw new Error(`unknown pipeline instance ${input.instanceId}`);
    const status = input.generation === instance.generation &&
      (input.subject == null || instance.immutable_subject == null || input.subject === instance.immutable_subject)
      ? "pending"
      : "stale";
    const payloadHash = digestNormalized(input.payload);
    const existing = db.prepare("SELECT * FROM pipeline_inbox_events WHERE id = ?").get(input.id) as
      | { pipeline_instance_id: string; generation: number; kind: string; payload_hash: string; status: string }
      | undefined;
    if (existing) {
      if (
        existing.pipeline_instance_id !== input.instanceId || existing.generation !== input.generation ||
        existing.kind !== input.kind || existing.payload_hash !== payloadHash
      ) throw new Error(`pipeline inbox event ${input.id} already exists with different content`);
      return existing.status === "stale" ? "stale" : existing.status === "consumed" ? "consumed" : "pending";
    }
    db.prepare(`
      INSERT INTO pipeline_inbox_events (
        id, pipeline_instance_id, generation, kind, payload, payload_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.instanceId, input.generation, input.kind, input.payload, payloadHash, status, now());
    return status;
  });

  const applyTransition = db.transaction((
    write: CoordinatorTransitionWrite,
    faultAfterWrite?: (writeCount: number) => void
  ): PipelineInstance => {
    let writes = 0;
    const wrote = () => faultAfterWrite?.(++writes);
    const instance = getInstanceStmt.get(write.instanceId) as PipelineInstance | undefined;
    if (!instance) throw new Error(`unknown pipeline instance ${write.instanceId}`);
    validatePinnedInstance(db, instance);
    if (instance.state_version !== write.expectedVersion || instance.status !== write.expectedStatus) {
      throw new Error(`pipeline instance ${write.instanceId} transition compare-and-set failed`);
    }
    const attempt = getAttemptStmt.get(write.attemptId) as PipelineStageAttempt | undefined;
    if (!attempt || attempt.pipeline_instance_id !== instance.id || attempt.stage_id !== instance.active_stage_id) {
      throw new Error(`attempt ${write.attemptId} is not active for pipeline instance ${instance.id}`);
    }
    if (["completed", "canceled", "superseded", "failed"].includes(attempt.status)) {
      throw new Error(`attempt ${write.attemptId} is already terminal`);
    }
    const event = db.prepare(`
      SELECT pipeline_instance_id, generation, payload_hash, status
      FROM pipeline_inbox_events WHERE id = ?
    `).get(write.eventId) as
      | { pipeline_instance_id: string; generation: number; payload_hash: string; status: string }
      | undefined;
    if (
      !event || event.pipeline_instance_id !== instance.id || event.generation !== instance.generation ||
      event.payload_hash !== write.eventPayloadHash || event.status !== "pending"
    ) throw new Error(`pipeline inbox event ${write.eventId} fence mismatch`);
    const timestamp = now();
    const attemptStatus = write.outcome === "canceled"
      ? "canceled"
      : write.outcome === "superseded"
        ? "superseded"
        : ["failure", "retryable_infrastructure_failure"].includes(write.outcome)
          ? "failed"
          : "completed";
    db.prepare(`
      UPDATE pipeline_stage_attempts
      SET status = ?, outcome = ?, result_hash = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(attemptStatus, write.outcome, write.resultHash, timestamp, timestamp, attempt.id);
    wrote();
    for (const artifact of write.artifacts ?? []) {
      if (digestNormalized(artifact.payload) !== artifact.hash) throw new Error(`artifact ${artifact.id ?? artifact.kind} hash mismatch`);
      db.prepare(`
        INSERT INTO pipeline_artifacts (
          id, pipeline_instance_id, attempt_id, kind, schema_version,
          assurance, subject, payload, artifact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id ?? deterministicId("artifact", [instance.id, attempt.id, artifact.kind, artifact.hash]),
        instance.id, attempt.id, artifact.kind, artifact.schemaVersion, artifact.assurance,
        artifact.subject ?? null, artifact.payload, artifact.hash, timestamp
      );
      wrote();
    }
    db.prepare(`
      UPDATE pipeline_instance_stages
      SET status = ?,
          attempt_count = attempt_count + ?,
          reentry_count = reentry_count + ?,
          updated_at = ?
      WHERE pipeline_instance_id = ? AND stage_id = ?
    `).run(
      write.nextStageId === attempt.stage_id ? write.nextStageStatus ?? "dispatchable" :
        write.outcome === "success" || write.outcome === "no_change" ? "passed" : "failed",
      write.nextStageId === attempt.stage_id && write.nextAttempt ? 1 : 0,
      write.nextStageId === attempt.stage_id ? write.reentryIncrement ?? 0 : 0,
      timestamp, instance.id, attempt.stage_id
    );
    wrote();
    if (write.nextStageId && write.nextStageId !== attempt.stage_id) {
      const next = db.prepare(`
        UPDATE pipeline_instance_stages SET
          status = ?, attempt_count = attempt_count + ?,
          reentry_count = reentry_count + ?, updated_at = ?
        WHERE pipeline_instance_id = ? AND stage_id = ? AND status IN ('pending', 'waiting', 'failed', 'passed')
      `).run(
        write.nextStageStatus ?? "dispatchable",
        write.nextAttempt ? 1 : 0,
        write.reentryIncrement ?? 0,
        timestamp,
        instance.id,
        write.nextStageId
      );
      if (next.changes !== 1) throw new Error(`next stage ${write.nextStageId} is not dispatchable`);
      wrote();
    }
    if (write.nextAttempt) {
      db.prepare(`
        INSERT INTO pipeline_stage_attempts (
          id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
          request_hash, idempotency_key, context_revision, native_context_policy,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        write.nextAttempt.id ?? deterministicId("attempt", [
          instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal, write.nextAttempt.reentryOrdinal,
        ]),
        instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal,
        write.nextAttempt.reentryOrdinal, write.nextAttempt.requestHash,
        write.nextAttempt.idempotencyKey, write.nextAttempt.contextRevision,
        write.nextAttempt.contextPolicy, timestamp, timestamp
      );
      wrote();
    }
    const nextVersion = instance.state_version + 1;
    const update = db.prepare(`
      UPDATE pipeline_instances SET
        status = ?, active_stage_id = ?, wait_reason = ?, state_version = ?,
        attempt_count = attempt_count + ?, reentry_count = reentry_count + ?,
        immutable_subject = COALESCE(?, immutable_subject), terminal_outcome = ?,
        updated_at = ?
      WHERE id = ? AND state_version = ? AND status = ?
    `).run(
      write.nextStatus, write.nextStageId ?? null, write.waitReason ?? null, nextVersion,
      write.nextAttempt ? 1 : 0, write.reentryIncrement ?? 0,
      write.immutableSubject ?? null, write.terminalOutcome ?? null,
      timestamp, instance.id, write.expectedVersion, write.expectedStatus
    );
    if (update.changes !== 1) throw new Error(`pipeline instance ${instance.id} transition compare-and-set failed`);
    wrote();
    for (const effect of write.effects) {
      const payloadHash = digestNormalized(effect.payload);
      db.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        effect.id ?? deterministicId("effect", [instance.id, nextVersion, effect.kind, effect.idempotencyKey]),
        instance.id, nextVersion, effect.kind, effect.idempotencyKey,
        effect.payload, payloadHash, timestamp, timestamp
      );
      wrote();
    }
    const consumed = db.prepare(`
      UPDATE pipeline_inbox_events SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND pipeline_instance_id = ? AND status = 'pending'
    `).run(timestamp, write.eventId, instance.id);
    if (consumed.changes !== 1) throw new Error(`pipeline inbox event ${write.eventId} is not pending`);
    wrote();
    return getInstanceStmt.get(instance.id) as PipelineInstance;
  });

  const claimEffects = db.transaction((
    nowIso: string,
    leaseUntilIso: string,
    limit = 50
  ): PipelineEffectIntent[] => {
    const candidates = db.prepare(`
      SELECT id FROM pipeline_effect_intents
      WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
        OR (status = 'processing' AND next_attempt_at <= ?))
      ORDER BY next_attempt_at, created_at, id LIMIT ?
    `).all(nowIso, nowIso, limit) as Array<{ id: string }>;
    const claimed: PipelineEffectIntent[] = [];
    for (const candidate of candidates) {
      const updated = db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE id = ? AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(leaseUntilIso, candidate.id, nowIso, nowIso);
      if (updated.changes === 1) {
        claimed.push(db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?").get(candidate.id) as PipelineEffectIntent);
      }
    }
    return claimed;
  });

  const recordEffectAcknowledgement = db.transaction((input: {
    effectId: string;
    eventId: string;
    payload: string;
  }): void => {
    const effect = db.prepare("SELECT * FROM pipeline_effect_intents WHERE id = ?").get(input.effectId) as PipelineEffectIntent | undefined;
    if (!effect) throw new Error(`unknown pipeline effect ${input.effectId}`);
    const instance = getInstanceStmt.get(effect.pipeline_instance_id) as PipelineInstance;
    const eventPayload = canonicalJson({
      effectId: effect.id,
      idempotencyKey: effect.idempotency_key,
      kind: effect.kind,
      result: JSON.parse(input.payload) as unknown,
    });
    const payloadHash = digestNormalized(eventPayload);
    const existing = db.prepare("SELECT payload_hash, status FROM pipeline_inbox_events WHERE id = ?")
      .get(input.eventId) as { payload_hash: string; status: string } | undefined;
    if (effect.status === "acknowledged") {
      if (!existing || existing.payload_hash !== payloadHash) {
        throw new Error(`acknowledged effect ${effect.id} is missing its exact inbox event`);
      }
      return;
    }
    if (effect.status !== "processing") throw new Error(`pipeline effect ${effect.id} is not processing`);
    const timestamp = now();
    db.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = ?, last_error = NULL
      WHERE id = ? AND status = 'processing'
    `).run(timestamp, effect.id);
    db.prepare(`
      INSERT INTO pipeline_inbox_events (
        id, pipeline_instance_id, generation, kind, payload, payload_hash, status, created_at
      ) VALUES (?, ?, ?, 'effect_acknowledged', ?, ?, 'pending', ?)
    `).run(input.eventId, instance.id, instance.generation, eventPayload, payloadHash, timestamp);
  });

  return {
    acceptCatalog,
    acceptRuntimeDescriptor,
    saveRepositoryConfigSnapshot,
    pinLegacySession,
    supersedeOtherInstances,
    createInstance,
    getSessionExecutionMode(sessionId) {
      return db.prepare(
        "SELECT execution_mode FROM session_executions WHERE linear_session_id = ?"
      ).pluck().get(sessionId) as "legacy" | "pipeline" | undefined;
    },
    getInstance(id) {
      const instance = getInstanceStmt.get(id) as PipelineInstance | undefined;
      if (instance) validatePinnedInstance(db, instance);
      return instance;
    },
    getInstanceForSession(sessionId) {
      const instance = db.prepare(`
        SELECT pi.* FROM session_executions se
        JOIN pipeline_instances pi ON pi.id = se.pipeline_instance_id
        WHERE se.linear_session_id = ? AND se.execution_mode = 'pipeline'
      `).get(sessionId) as PipelineInstance | undefined;
      if (instance) validatePinnedInstance(db, instance);
      return instance;
    },
    getAttempt(id) {
      return getAttemptStmt.get(id) as PipelineStageAttempt | undefined;
    },
    getActiveAttempt(instanceId) {
      return db.prepare(`
        SELECT psa.* FROM pipeline_stage_attempts psa
        JOIN pipeline_instances pi
          ON pi.id = psa.pipeline_instance_id AND pi.active_stage_id = psa.stage_id
        WHERE psa.pipeline_instance_id = ?
          AND psa.status IN ('pending', 'leased', 'dispatched', 'acknowledged', 'running')
        ORDER BY psa.reentry_ordinal DESC, psa.attempt_ordinal DESC LIMIT 1
      `).get(instanceId) as PipelineStageAttempt | undefined;
    },
    listStages(instanceId) {
      return db.prepare(`
        SELECT * FROM pipeline_instance_stages
        WHERE pipeline_instance_id = ? ORDER BY ordinal
      `).all(instanceId) as PipelineInstanceStage[];
    },
    listEffects(instanceId) {
      return db.prepare(`
        SELECT * FROM pipeline_effect_intents
        WHERE pipeline_instance_id = ? ORDER BY transition_version, created_at, id
      `).all(instanceId) as PipelineEffectIntent[];
    },
    claimEffects,
    recordEffectAcknowledgement,
    markEffectFailed(effectId, error, retryAt) {
      const update = db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = ?, next_attempt_at = COALESCE(?, next_attempt_at), last_error = ?
        WHERE id = ? AND status = 'processing'
      `).run(retryAt ? "failed" : "dead", retryAt, error, effectId);
      if (update.changes !== 1) throw new Error(`pipeline effect ${effectId} is not processing`);
    },
    enqueueInboxEvent,
    applyTransition,
  };
}
