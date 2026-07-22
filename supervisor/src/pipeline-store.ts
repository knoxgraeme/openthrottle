import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestNormalized,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineOutcome,
  type PipelineStage,
  type StageOutcome,
  type ValidatedPipelineCatalog,
  type ValidatedPipelineManifest,
  type ValidatedRepositoryConfig,
} from "./pipeline-manifest.js";
import {
  STAGE_EXECUTOR_PROTOCOL,
  createStageRequestHash,
  type StageRequestEnvelope,
  type ValidatedRuntimeCapabilityDescriptor,
} from "./sandbox-runtime.js";
import {
  buildLifecyclePublication,
  buildSelectionPublication,
  deterministicPublicationId,
  parsePipelinePublication,
  pipelinePublicationOutboxPayload,
  publicationPayloadHash,
} from "./pipeline-publication.js";

const SAFE_BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

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
  base_branch: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  task_type: "implement" | "investigate";
  published_commit: string | null;
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
  planned_run_id: string | null;
  expected_subject: string | null;
  native_session_id: string | null;
  request_payload: string | null;
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

export interface PipelinePublicationReceipt {
  id: string;
  pipeline_instance_id: string;
  attempt_id: string | null;
  kind: "linear_ledger" | "github_summary" | "pull_request";
  idempotency_key: string;
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "acknowledged" | "failed" | "dead";
  external_id: string | null;
  external_url: string | null;
  target_url: string | null;
  attachment_url: string | null;
  attempts: number;
  next_attempt_at: string;
  resume_status: PipelineInstanceStatus | null;
  blocked_from_status: PipelineInstanceStatus | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  last_error: string | null;
}

export interface PipelineRuntimeResource {
  pipeline_instance_id: string;
  provider: string;
  provider_resource_id: string;
  status: "active" | "stopped" | "quarantined" | "cleaned";
  created_at: string;
  updated_at: string;
}

export interface PipelineInboxEventRecord {
  id: string;
  pipeline_instance_id: string;
  generation: number;
  kind: string;
  payload: string;
  payload_hash: string;
  status: "pending" | "consumed" | "stale" | "dead";
}

export interface PipelineStatusProjection {
  execution_mode: "pipeline";
  instance_id: string;
  pipeline_id: string;
  pipeline_version: number;
  task_type: "implement" | "investigate";
  status: PipelineInstanceStatus;
  stage_id: string | null;
  attempt_ordinal: number | null;
  retry_count: number;
  reentry_count: number;
  wait_reason: string | null;
  subject: string | null;
  published_commit: string | null;
  gate_result: string | null;
  assurance: string | null;
  policy_digest: string | null;
  context_policy: string | null;
  publication_state: "none" | "pending" | "acknowledged" | "failed" | "blocked";
  publication_id: string | null;
  publication_external_id: string | null;
  publication_error: string | null;
  recovery_action: string | null;
}

export interface PipelineInstanceSeed {
  id?: string;
  issueId: string;
  sessionId: string;
  generation: number;
  repository: string;
  baseCommit: string;
  baseBranch?: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  taskType: "implement" | "investigate";
  manifest: ValidatedPipelineManifest;
  repositoryConfig: RepositoryConfigSnapshot;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  authorizedCapabilities: string[];
  taskContext?: string;
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

export interface CoordinatorGateReceiptWrite {
  id?: string;
  evaluatorKind: "result" | "semantic" | "command" | "provider" | "human" | "publish_subject";
  policyDigest: string;
  subject?: string | null;
  result: "passed" | "failed" | "indeterminate" | "skipped" | "not_configured";
  artifactHashes: string[];
  payload: string;
  hash: string;
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
  publishedCommit?: string | null;
  reentryIncrement?: number;
  artifacts?: CoordinatorArtifactWrite[];
  gateReceipt?: CoordinatorGateReceiptWrite;
  nextAttempt?: {
    id?: string;
    stageId: string;
    attemptOrdinal: number;
    reentryOrdinal: number;
    requestHash: string;
    idempotencyKey: string;
    contextRevision: number;
    contextPolicy: string;
    plannedRunId: string;
    expectedSubject: string | null;
    nativeSessionId: string | null;
    requestPayload: string;
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
  getAttemptForRun(runId: string): PipelineStageAttempt | undefined;
  getRepositoryConfigSnapshot(id: string): RepositoryConfigSnapshot | undefined;
  getStageRequest(attemptId: string): StageRequestEnvelope;
  bindStageRun(attemptId: string, runId: string): void;
  markStageDispatched(attemptId: string): void;
  bindRuntimeResource(instanceId: string, provider: string, providerResourceId: string): PipelineRuntimeResource;
  getRuntimeResource(instanceId: string): PipelineRuntimeResource | undefined;
  setRuntimeResourceStatus(instanceId: string, status: PipelineRuntimeResource["status"]): void;
  getActiveAttempt(instanceId: string): PipelineStageAttempt | undefined;
  listProviderReadyInstances(limit?: number): PipelineInstance[];
  listStages(instanceId: string): PipelineInstanceStage[];
  listEffects(instanceId: string): PipelineEffectIntent[];
  listPublications(instanceId: string): PipelinePublicationReceipt[];
  getPublication(id: string): PipelinePublicationReceipt | undefined;
  claimGithubPublications(nowIso: string, leaseUntilIso: string, limit?: number): PipelinePublicationReceipt[];
  bindGithubPublicationTarget(
    id: string,
    expectedPayloadHash: string,
    targetUrl: string
  ): PipelinePublicationReceipt | undefined;
  markGithubPublicationProcessed(
    id: string,
    expectedPayloadHash: string,
    externalId: string,
    externalUrl: string
  ): boolean;
  markGithubPublicationFailed(
    id: string,
    expectedPayloadHash: string,
    error: string,
    retryAt: string | null
  ): boolean;
  retryPublication(id: string): PipelinePublicationReceipt;
  getStatusForIssue(issueId: string): PipelineStatusProjection | undefined;
  claimEffects(nowIso: string, leaseUntilIso: string, limit?: number): PipelineEffectIntent[];
  recordEffectAcknowledgement(input: {
    effectId: string;
    eventId: string;
    payload: string;
  }): void;
  markEffectFailed(effectId: string, error: string, retryAt: string | null): void;
  getInboxEvent(id: string): PipelineInboxEventRecord | undefined;
  listPendingInboxEvents(kind: string, limit?: number): PipelineInboxEventRecord[];
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

function plannedStageRunId(attemptId: string): string {
  return deterministicId("run", [attemptId, "stage-execution"]);
}

export function buildStageRequest(input: {
  instanceId: string;
  manifestDigest: string;
  runtimeRelease: string;
  capabilityDigest: string;
  repositoryConfigDigest: string;
  stage: PipelineStage;
  attemptId: string;
  runId: string;
  issueId: string;
  sessionId: string;
  generation: number;
  taskType: "implement" | "investigate";
  taskContext: string;
  transitionContext: string;
  repository: string;
  baseCommit: string;
  baseBranch: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  contextRevision: number;
  expectedSubject: string | null;
  nativeSessionId: string | null;
}): StageRequestEnvelope {
  const commandNames = new Set(["test", "lint", "build", "format"] as const);
  const withoutFence: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
    protocol: STAGE_EXECUTOR_PROTOCOL,
    pipelineInstanceId: input.instanceId,
    manifestDigest: input.manifestDigest,
    runtimeRelease: input.runtimeRelease,
    capabilityDigest: input.capabilityDigest,
    repositoryConfigDigest: input.repositoryConfigDigest,
    stageId: input.stage.id,
    attemptId: input.attemptId,
    runId: input.runId,
    issueId: input.issueId,
    sessionId: input.sessionId,
    generation: input.generation,
    taskType: input.taskType,
    taskContext: input.taskContext,
    transitionContext: input.transitionContext,
    repository: input.repository,
    baseCommit: input.baseCommit,
    baseBranch: input.baseBranch,
    branch: input.branch,
    agent: input.agent,
    contextRevision: input.contextRevision,
    expectedSubject: input.expectedSubject,
    contextPolicy: input.stage.context,
    nativeSessionId: input.nativeSessionId,
    capability: input.stage.executor.capability,
    requiredArtifacts: [...new Set(["stage_result" as const, ...input.stage.evaluator.required_artifacts])].sort(),
    credentialScopes: [...input.stage.credentials].sort(),
    liveSteering: input.stage.live_steering,
    ...(input.stage.executor.kind === "command" && commandNames.has(input.stage.id as never)
      ? { commandName: input.stage.id as "test" | "lint" | "build" | "format" }
      : {}),
  };
  return { ...withoutFence, ...createStageRequestHash(withoutFence) };
}

function validatePinnedInstance(db: Database.Database, instance: PipelineInstance): PipelineManifest {
  if (!SAFE_BRANCH.test(instance.base_branch)) {
    throw new Error(`pipeline instance ${instance.id} has an invalid pinned base branch`);
  }
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

  const persistPublication = (input: {
    instance: PipelineInstance;
    attemptId: string | null;
    kind: "linear_ledger" | "github_summary";
    idempotencyKey: string;
    payload: string;
    timestamp: string;
  }): PipelinePublicationReceipt => {
    const envelope = parsePipelinePublication(input.payload);
    if (envelope.pipeline.instance_id !== input.instance.id ||
        envelope.pipeline.linear_issue_id !== input.instance.linear_issue_id ||
        envelope.pipeline.generation !== input.instance.generation ||
        envelope.pipeline.manifest_digest !== input.instance.manifest_digest) {
      throw new Error("pipeline publication instance fence mismatch");
    }
    const payloadHash = publicationPayloadHash(envelope);
    if (input.kind === "linear_ledger") {
      const id = deterministicPublicationId(input.idempotencyKey);
      const existing = db.prepare(`
        SELECT * FROM pipeline_publication_receipts WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as PipelinePublicationReceipt | undefined;
      if (existing) {
        if (existing.id !== id || existing.pipeline_instance_id !== input.instance.id ||
            existing.attempt_id !== input.attemptId || existing.kind !== input.kind ||
            existing.payload_hash !== payloadHash || existing.payload !== input.payload) {
          throw new Error(`pipeline publication ${input.idempotencyKey} already exists with different intent`);
        }
        return existing;
      }
      db.prepare(`
        INSERT INTO pipeline_publication_receipts (
          id, pipeline_instance_id, attempt_id, kind, idempotency_key,
          payload, payload_hash, status, attempts, next_attempt_at,
          resume_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'linear_ledger', ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      `).run(
        id,
        input.instance.id,
        input.attemptId,
        input.idempotencyKey,
        input.payload,
        payloadHash,
        input.timestamp,
        envelope.resume_status,
        input.timestamp,
        input.timestamp
      );
      const outboxPayload = pipelinePublicationOutboxPayload(envelope);
      const sequence = (db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM linear_outbox WHERE linear_session_id IS ?
      `).get(input.instance.linear_session_id) as { sequence: number }).sequence;
      db.prepare(`
        INSERT INTO linear_outbox (
          id, linear_session_id, linear_issue_id, run_id, sequence, kind,
          payload, payload_hash, status, attempts, next_attempt_at, created_at
        ) VALUES (?, ?, ?, NULL, ?, 'pipeline_receipt', ?, ?, 'pending', 0, ?, ?)
      `).run(
        id,
        input.instance.linear_session_id,
        input.instance.linear_issue_id,
        sequence,
        outboxPayload,
        digestNormalized(outboxPayload),
        input.timestamp,
        input.timestamp
      );
    } else {
      const stableKey = `github-summary:${input.instance.linear_issue_id}`;
      const stableId = deterministicPublicationId(stableKey);
      db.prepare(`
        INSERT INTO pipeline_publication_receipts (
          id, pipeline_instance_id, attempt_id, kind, idempotency_key,
          payload, payload_hash, status, attempts, next_attempt_at,
          resume_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'github_summary', ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          target_url = CASE
            WHEN pipeline_publication_receipts.pipeline_instance_id = excluded.pipeline_instance_id
              THEN pipeline_publication_receipts.target_url
            ELSE NULL
          END,
          pipeline_instance_id = excluded.pipeline_instance_id,
          attempt_id = excluded.attempt_id,
          payload = excluded.payload,
          payload_hash = excluded.payload_hash,
          status = 'pending',
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(
        stableId,
        input.instance.id,
        input.attemptId,
        stableKey,
        input.payload,
        payloadHash,
        input.timestamp,
        input.timestamp,
        input.timestamp
      );
      return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
        .get(stableId) as PipelinePublicationReceipt;
    }
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as PipelinePublicationReceipt;
  };

  db.transaction(() => {
    const timestamp = now();
    const instances = db.prepare(`
      SELECT * FROM pipeline_instances pi
      WHERE pi.status NOT IN ('shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_publication_receipts ppr
          WHERE ppr.pipeline_instance_id = pi.id AND ppr.kind = 'linear_ledger'
        )
    `).all() as PipelineInstance[];
    for (const instance of instances) {
      const selection = canonicalJson(buildSelectionPublication(instance));
      persistPublication({
        instance,
        attemptId: null,
        kind: "linear_ledger",
        idempotencyKey: `linear-selection:${instance.id}`,
        payload: selection,
        timestamp,
      });
      persistPublication({
        instance,
        attemptId: null,
        kind: "github_summary",
        idempotencyKey: `github-summary:${instance.id}`,
        payload: selection,
        timestamp,
      });
    }
  })();

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
      const activeAttempt = db.prepare(`
        SELECT * FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ?
          AND status IN ('pending', 'leased', 'dispatched', 'acknowledged', 'running')
        ORDER BY attempt_ordinal DESC, reentry_ordinal DESC LIMIT 1
      `).get(instance.id) as PipelineStageAttempt | undefined;
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
      const terminalPublication = canonicalJson(buildLifecyclePublication({
        instance,
        attempt: activeAttempt,
        outcome: "superseded",
        reason: "A newer delegated Linear session superseded this pipeline generation.",
      }));
      persistPublication({
        instance,
        attemptId: activeAttempt?.id ?? null,
        kind: "linear_ledger",
        idempotencyKey: `linear-terminal:${instance.id}:superseded:${nextVersion}`,
        payload: terminalPublication,
        timestamp,
      });
      persistPublication({
        instance,
        attemptId: activeAttempt?.id ?? null,
        kind: "github_summary",
        idempotencyKey: `github-summary-update:${instance.id}:superseded:${nextVersion}`,
        payload: terminalPublication,
        timestamp,
      });
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
    const baseBranch = seed.baseBranch ?? "main";
    if (!SAFE_BRANCH.test(baseBranch)) throw new Error(`pipeline base branch ${baseBranch} is invalid`);
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
          existing.base_commit !== seed.baseCommit || existing.base_branch !== baseBranch ||
          existing.branch !== seed.branch || existing.agent !== seed.agent ||
          existing.task_type !== seed.taskType ||
          existing.manifest_digest !== seed.manifest.digest ||
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
    const session = db.prepare("SELECT linear_issue_id, generation, provider_conversation_id FROM agent_sessions WHERE id = ?").get(seed.sessionId) as
      | { linear_issue_id: string; generation: number; provider_conversation_id: string | null }
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
        base_commit, base_branch, branch, agent, task_type, repository_config_snapshot_id, repository_config_digest,
        runtime_release, capability_digest, executor_protocol,
        authorized_capabilities, status, active_stage_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatchable', ?, 1, ?, ?)
    `).run(
      instanceId, seed.issueId, seed.sessionId, seed.generation,
      seed.manifest.manifest.id, seed.manifest.manifest.version,
      seed.manifest.digest, seed.manifest.normalized, seed.repository,
      seed.baseCommit, baseBranch, seed.branch, seed.agent, seed.taskType, snapshot.id, snapshot.digest,
      seed.runtime.descriptor.release,
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
    const plannedRunId = plannedStageRunId(attemptId);
    const stageRequest = buildStageRequest({
      instanceId,
      manifestDigest: seed.manifest.digest,
      runtimeRelease: seed.runtime.descriptor.release,
      capabilityDigest: seed.runtime.digest,
      repositoryConfigDigest: snapshot.digest,
      stage: entry,
      attemptId,
      runId: plannedRunId,
      issueId: seed.issueId,
      sessionId: seed.sessionId,
      generation: seed.generation,
      taskType: seed.taskType,
      taskContext: seed.taskContext ?? "",
      transitionContext: "",
      repository: seed.repository,
      baseCommit: seed.baseCommit,
      baseBranch,
      branch: seed.branch,
      agent: seed.agent,
      contextRevision: 0,
      expectedSubject: null,
      nativeSessionId: session.provider_conversation_id,
    });
    const requestPayload = canonicalJson(stageRequest);
    db.prepare(`
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, expected_subject, native_session_id, request_payload,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 0, ?, ?, 0, ?, ?, NULL, ?, ?, 'pending', ?, ?)
    `).run(
      attemptId, instanceId, entry.id, stageRequest.requestHash, stageRequest.idempotencyKey,
      entry.context, plannedRunId, session.provider_conversation_id, requestPayload, timestamp, timestamp
    );
    const provisionPayload = canonicalJson({
      pipelineInstanceId: instanceId,
      attemptId,
      requestHash: stageRequest.requestHash,
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
    const selection = canonicalJson(buildSelectionPublication(result));
    persistPublication({
      instance: result,
      attemptId: null,
      kind: "linear_ledger",
      idempotencyKey: `linear-selection:${result.id}`,
      payload: selection,
      timestamp,
    });
    persistPublication({
      instance: result,
      attemptId: null,
      kind: "github_summary",
      idempotencyKey: `github-summary:${result.id}`,
      payload: selection,
      timestamp,
    });
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
      (input.kind === "stage_result" || input.subject == null ||
        instance.immutable_subject == null || input.subject === instance.immutable_subject)
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
    if (write.gateReceipt) {
      const receipt = write.gateReceipt;
      if (digestNormalized(receipt.payload) !== receipt.hash) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} hash mismatch`);
      }
      const artifactHashes = canonicalJson([...receipt.artifactHashes].sort());
      if (artifactHashes !== canonicalJson(receipt.artifactHashes)) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} artifact hashes are not canonical`);
      }
      const acceptedHashes = new Set((write.artifacts ?? []).map((artifact) => artifact.hash));
      if (receipt.artifactHashes.some((hash) => !acceptedHashes.has(hash))) {
        throw new Error(`gate receipt ${receipt.id ?? attempt.id} references unaccepted evidence`);
      }
      db.prepare(`
        INSERT INTO pipeline_gate_receipts (
          id, pipeline_instance_id, attempt_id, evaluator_kind, policy_digest,
          subject, result, artifact_hashes, receipt_hash, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id ?? deterministicId("gate", [instance.id, attempt.id, receipt.hash]),
        instance.id, attempt.id, receipt.evaluatorKind, receipt.policyDigest,
        receipt.subject ?? null, receipt.result, artifactHashes, receipt.hash,
        receipt.payload, timestamp
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
          planned_run_id, expected_subject, native_session_id, request_payload,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        write.nextAttempt.id ?? deterministicId("attempt", [
          instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal, write.nextAttempt.reentryOrdinal,
        ]),
        instance.id, write.nextAttempt.stageId, write.nextAttempt.attemptOrdinal,
        write.nextAttempt.reentryOrdinal, write.nextAttempt.requestHash,
        write.nextAttempt.idempotencyKey, write.nextAttempt.contextRevision,
        write.nextAttempt.contextPolicy, write.nextAttempt.plannedRunId,
        write.nextAttempt.expectedSubject, write.nextAttempt.nativeSessionId,
        write.nextAttempt.requestPayload, timestamp, timestamp
      );
      wrote();
    }
    const nextVersion = instance.state_version + 1;
    const update = db.prepare(`
      UPDATE pipeline_instances SET
        status = ?, active_stage_id = ?, wait_reason = ?, state_version = ?,
        attempt_count = attempt_count + ?, reentry_count = reentry_count + ?,
        immutable_subject = CASE WHEN ? IS NULL THEN immutable_subject ELSE ? END,
        published_commit = CASE WHEN ? IS NULL THEN published_commit ELSE ? END,
        terminal_outcome = ?,
        updated_at = ?
      WHERE id = ? AND state_version = ? AND status = ?
    `).run(
      write.nextStatus, write.nextStageId ?? null, write.waitReason ?? null, nextVersion,
      write.nextAttempt ? 1 : 0, write.reentryIncrement ?? 0,
      write.immutableSubject ?? null, write.immutableSubject ?? null,
      write.publishedCommit ?? null, write.publishedCommit ?? null,
      write.terminalOutcome ?? null,
      timestamp, instance.id, write.expectedVersion, write.expectedStatus
    );
    if (update.changes !== 1) throw new Error(`pipeline instance ${instance.id} transition compare-and-set failed`);
    wrote();
    if (write.terminalOutcome === "canceled" || write.terminalOutcome === "superseded") {
      db.prepare(`
        UPDATE pipeline_effect_intents
        SET status = 'dead', last_error = 'canceled by a terminal pipeline control event'
        WHERE pipeline_instance_id = ?
          AND kind IN ('provision', 'bootstrap', 'dispatch_stage')
          AND status IN ('pending', 'processing', 'failed')
      `).run(instance.id);
      wrote();
    }
    for (const effect of write.effects) {
      const payloadHash = digestNormalized(effect.payload);
      const publicationKind = effect.kind === "publish_linear"
        ? "linear_ledger" as const
        : effect.kind === "publish_github"
          ? "github_summary" as const
          : undefined;
      if (publicationKind) {
        persistPublication({
          instance,
          attemptId: attempt.id,
          kind: publicationKind,
          idempotencyKey: effect.idempotencyKey,
          payload: effect.payload,
          timestamp,
        });
        wrote();
      }
      db.prepare(`
        INSERT INTO pipeline_effect_intents (
          id, pipeline_instance_id, transition_version, kind, idempotency_key,
          payload, payload_hash, status, next_attempt_at, created_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        effect.id ?? deterministicId("effect", [instance.id, nextVersion, effect.kind, effect.idempotencyKey]),
        instance.id, nextVersion, effect.kind, effect.idempotencyKey,
        effect.payload, payloadHash, publicationKind ? "acknowledged" : "pending",
        timestamp, timestamp, publicationKind ? timestamp : null
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

  const bindStageRun = db.transaction((attemptId: string, runId: string): void => {
    const attempt = getAttemptStmt.get(attemptId) as PipelineStageAttempt | undefined;
    if (!attempt) throw new Error(`unknown pipeline attempt ${attemptId}`);
    if (!attempt.planned_run_id || attempt.planned_run_id !== runId) {
      throw new Error(`pipeline attempt ${attemptId} run does not match its immutable request`);
    }
    if (attempt.run_id) {
      if (attempt.run_id !== runId) throw new Error(`pipeline attempt ${attemptId} is already bound to another run`);
      return;
    }
    const timestamp = now();
    const update = db.prepare(`
      UPDATE pipeline_stage_attempts SET run_id = ?, updated_at = ?
      WHERE id = ? AND run_id IS NULL AND status = 'pending'
    `).run(runId, timestamp, attemptId);
    if (update.changes !== 1) throw new Error(`pipeline attempt ${attemptId} is not bindable`);
    db.prepare(`
      INSERT INTO run_stage_bindings(run_id, attempt_id, bound_at)
      VALUES (?, ?, ?)
    `).run(runId, attemptId, timestamp);
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

  const claimGithubPublications = db.transaction((
    nowIso: string,
    leaseUntilIso: string,
    limit = 50
  ): PipelinePublicationReceipt[] => {
    const candidates = db.prepare(`
      SELECT id FROM pipeline_publication_receipts
      WHERE kind = 'github_summary'
        AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'processing' AND next_attempt_at <= ?))
      ORDER BY next_attempt_at, created_at, id LIMIT ?
    `).all(nowIso, nowIso, limit) as Array<{ id: string }>;
    const claimed: PipelinePublicationReceipt[] = [];
    for (const candidate of candidates) {
      const update = db.prepare(`
        UPDATE pipeline_publication_receipts
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND kind = 'github_summary'
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(leaseUntilIso, nowIso, candidate.id, nowIso, nowIso);
      if (update.changes === 1) {
        claimed.push(db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
          .get(candidate.id) as PipelinePublicationReceipt);
      }
    }
    return claimed;
  });

  const bindGithubPublicationTarget = db.transaction((
    id: string,
    expectedPayloadHash: string,
    targetUrl: string
  ): PipelinePublicationReceipt | undefined => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication || publication.kind !== "github_summary" ||
        publication.status !== "processing" || publication.payload_hash !== expectedPayloadHash) {
      return undefined;
    }
    if (publication.target_url) {
      return publication.target_url === targetUrl ? publication : undefined;
    }
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET target_url = ?, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash = ? AND target_url IS NULL
        AND EXISTS (
          SELECT 1
          FROM pipeline_instances pi
          JOIN tickets t ON t.linear_issue_id = pi.linear_issue_id
          WHERE pi.id = pipeline_publication_receipts.pipeline_instance_id
            AND t.linear_session_id = pi.linear_session_id
            AND t.pr_url = ?
        )
    `).run(targetUrl, now(), id, expectedPayloadHash, targetUrl);
    if (update.changes !== 1) return undefined;
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt;
  });

  const markGithubPublicationProcessed = db.transaction((
    id: string,
    expectedPayloadHash: string,
    externalId: string,
    externalUrl: string
  ): boolean => {
    const timestamp = now();
    const update = db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'acknowledged', external_id = ?, external_url = ?,
          acknowledged_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND kind = 'github_summary' AND status = 'processing'
        AND payload_hash = ?
    `).run(externalId, externalUrl, timestamp, timestamp, id, expectedPayloadHash);
    return update.changes === 1;
  });

  const markGithubPublicationFailed = db.transaction((
    id: string,
    expectedPayloadHash: string,
    error: string,
    retryAt: string | null
  ): boolean => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication || publication.kind !== "github_summary" ||
        publication.status !== "processing" || publication.payload_hash !== expectedPayloadHash) return false;
    const timestamp = now();
    const status = retryAt ? "failed" : "dead";
    const instance = getInstanceStmt.get(publication.pipeline_instance_id) as PipelineInstance;
    db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?,
          blocked_from_status = CASE WHEN ? = 'dead' THEN COALESCE(blocked_from_status, ?) ELSE blocked_from_status END
      WHERE id = ?
    `).run(status, retryAt ?? timestamp, error, timestamp, status, instance.status, id);
    if (status === "dead" && ![
      "shipped", "no_change", "needs_human", "canceled", "superseded", "failed", "publication_blocked",
    ].includes(instance.status)) {
      db.prepare(`
        UPDATE pipeline_instances
        SET status = 'publication_blocked', state_version = state_version + 1,
            wait_reason = 'permanent publication failure', updated_at = ?
        WHERE id = ? AND state_version = ?
      `).run(timestamp, instance.id, instance.state_version);
    }
    return true;
  });

  const retryPublication = db.transaction((id: string): PipelinePublicationReceipt => {
    const publication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt | undefined;
    if (!publication) throw new Error(`unknown pipeline publication ${id}`);
    if (publication.status !== "dead" && publication.status !== "failed") {
      throw new Error(`pipeline publication ${id} is not recoverable`);
    }
    const timestamp = now();
    db.prepare(`
      UPDATE pipeline_publication_receipts
      SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, id);
    if (publication.kind === "linear_ledger") {
      const update = db.prepare(`
        UPDATE linear_outbox
        SET status = 'pending', next_attempt_at = ?, last_error = NULL, processed_at = NULL
        WHERE id = ? AND status IN ('dead', 'failed')
      `).run(timestamp, id);
      if (update.changes !== 1) throw new Error(`pipeline publication ${id} has no recoverable outbox row`);
    }
    const remainingDead = db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ? AND status = 'dead'
    `).get(publication.pipeline_instance_id) as { count: number };
    if (remainingDead.count === 0) {
      db.prepare(`
        UPDATE pipeline_instances
        SET status = ?, wait_reason = NULL, state_version = state_version + 1, updated_at = ?
        WHERE id = ? AND status = 'publication_blocked'
      `).run(publication.blocked_from_status ?? "completion_pending_publication", timestamp, publication.pipeline_instance_id);
    }
    return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
      .get(id) as PipelinePublicationReceipt;
  });

  function getStatusForIssue(issueId: string): PipelineStatusProjection | undefined {
    const instance = db.prepare(`
      SELECT pi.* FROM session_executions se
      JOIN pipeline_instances pi ON pi.id = se.pipeline_instance_id
      JOIN tickets t ON t.linear_session_id = se.linear_session_id
      WHERE t.linear_issue_id = ? AND se.execution_mode = 'pipeline'
    `).get(issueId) as PipelineInstance | undefined;
    if (!instance) return undefined;
    const attempt = db.prepare(`
      SELECT * FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ?
      ORDER BY attempt_ordinal DESC, reentry_ordinal DESC LIMIT 1
    `).get(instance.id) as PipelineStageAttempt | undefined;
    const retries = db.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND status = 'failed'
    `).get(instance.id) as { count: number };
    const gate = db.prepare(`
      SELECT pgr.*, pa.assurance FROM pipeline_gate_receipts pgr
      LEFT JOIN pipeline_artifacts pa
        ON pa.pipeline_instance_id = pgr.pipeline_instance_id
       AND pa.attempt_id = pgr.attempt_id
      WHERE pgr.pipeline_instance_id = ?
      ORDER BY pgr.created_at DESC, pgr.id DESC LIMIT 1
    `).get(instance.id) as {
      result: string;
      policy_digest: string;
      assurance: string | null;
    } | undefined;
    const publications = db.prepare(`
      SELECT * FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all(instance.id) as PipelinePublicationReceipt[];
    const latest = publications[0];
    const blockedPublication = publications.find((item) => item.status === "dead");
    const failedPublication = publications.find((item) => item.status === "failed");
    const pendingPublication = publications.find((item) =>
      item.status === "pending" || item.status === "processing"
    );
    const publicationState: PipelineStatusProjection["publication_state"] =
      publications.some((item) => item.status === "dead") || instance.status === "publication_blocked"
        ? "blocked"
        : publications.some((item) => item.status === "failed")
          ? "failed"
          : publications.some((item) => item.status === "pending" || item.status === "processing")
            ? "pending"
            : publications.some((item) => item.status === "acknowledged")
              ? "acknowledged"
              : "none";
    return {
      execution_mode: "pipeline",
      instance_id: instance.id,
      pipeline_id: instance.pipeline_id,
      pipeline_version: instance.pipeline_version,
      task_type: instance.task_type,
      status: instance.status,
      stage_id: instance.active_stage_id ?? attempt?.stage_id ?? null,
      attempt_ordinal: attempt?.attempt_ordinal ?? null,
      retry_count: retries.count,
      reentry_count: instance.reentry_count,
      wait_reason: instance.wait_reason,
      subject: instance.immutable_subject,
      published_commit: instance.published_commit,
      gate_result: gate?.result ?? null,
      assurance: gate?.assurance ?? null,
      policy_digest: gate?.policy_digest ?? null,
      context_policy: attempt?.native_context_policy ?? null,
      publication_state: publicationState,
      publication_id: (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.id ?? null,
      publication_external_id:
        (blockedPublication ?? failedPublication ?? pendingPublication ?? latest)?.external_id ?? null,
      publication_error:
        (blockedPublication ?? failedPublication ?? publications.find((item) => item.last_error))?.last_error ?? null,
      recovery_action: publicationState === "blocked" && blockedPublication
        ? `POST /tickets/:identifier/publications/${blockedPublication.id}/retry`
        : null,
    };
  }

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
    getAttemptForRun(runId) {
      return db.prepare(`
        SELECT psa.* FROM run_stage_bindings rsb
        JOIN pipeline_stage_attempts psa ON psa.id = rsb.attempt_id
        WHERE rsb.run_id = ?
      `).get(runId) as PipelineStageAttempt | undefined;
    },
    getRepositoryConfigSnapshot(id) {
      return db.prepare("SELECT * FROM repository_config_snapshots WHERE id = ?")
        .get(id) as RepositoryConfigSnapshot | undefined;
    },
    getStageRequest(attemptId) {
      const attempt = getAttemptStmt.get(attemptId) as PipelineStageAttempt | undefined;
      if (!attempt?.request_payload) throw new Error(`pipeline attempt ${attemptId} has no complete stage request`);
      const request = JSON.parse(attempt.request_payload) as StageRequestEnvelope;
      if (canonicalJson(request) !== attempt.request_payload || request.attemptId !== attempt.id ||
          request.requestHash !== attempt.request_hash || request.idempotencyKey !== attempt.idempotency_key ||
          request.runId !== attempt.planned_run_id) {
        throw new Error(`pipeline attempt ${attemptId} stage request binding mismatch`);
      }
      const { requestHash, idempotencyKey, ...withoutFence } = request;
      const expected = createStageRequestHash(withoutFence);
      if (requestHash !== expected.requestHash || idempotencyKey !== expected.idempotencyKey) {
        throw new Error(`pipeline attempt ${attemptId} stage request hash mismatch`);
      }
      return request;
    },
    bindStageRun,
    markStageDispatched(attemptId) {
      db.transaction(() => {
        const attempt = getAttemptStmt.get(attemptId) as PipelineStageAttempt | undefined;
        if (!attempt) throw new Error(`unknown pipeline attempt ${attemptId}`);
        if (attempt.status === "running") return;
        const timestamp = now();
        const update = db.prepare(`
          UPDATE pipeline_stage_attempts
          SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND run_id IS NOT NULL
            AND status IN ('pending', 'leased', 'dispatched', 'acknowledged')
        `).run(timestamp, timestamp, attemptId);
        if (update.changes !== 1) throw new Error(`pipeline attempt ${attemptId} is not dispatchable`);
        db.prepare(`
          UPDATE pipeline_instances SET status = 'running', wait_reason = NULL, updated_at = ?
          WHERE id = ? AND active_stage_id = ? AND status IN ('pending', 'dispatchable', 'running')
        `).run(timestamp, attempt.pipeline_instance_id, attempt.stage_id);
        db.prepare(`
          UPDATE pipeline_instance_stages SET status = 'running', updated_at = ?
          WHERE pipeline_instance_id = ? AND stage_id = ? AND status IN ('pending', 'dispatchable', 'running')
        `).run(timestamp, attempt.pipeline_instance_id, attempt.stage_id);
      })();
    },
    bindRuntimeResource(instanceId, provider, providerResourceId) {
      const instance = getInstanceStmt.get(instanceId) as PipelineInstance | undefined;
      if (!instance) throw new Error(`unknown pipeline instance ${instanceId}`);
      const existing = db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource | undefined;
      if (existing) {
        if (existing.provider !== provider || existing.provider_resource_id !== providerResourceId) {
          throw new Error(`pipeline instance ${instanceId} is already bound to a different runtime resource`);
        }
        return existing;
      }
      const timestamp = now();
      db.prepare(`
        INSERT INTO pipeline_runtime_resources (
          pipeline_instance_id, provider, provider_resource_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?)
      `).run(instanceId, provider, providerResourceId, timestamp, timestamp);
      return db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource;
    },
    getRuntimeResource(instanceId) {
      return db.prepare("SELECT * FROM pipeline_runtime_resources WHERE pipeline_instance_id = ?")
        .get(instanceId) as PipelineRuntimeResource | undefined;
    },
    setRuntimeResourceStatus(instanceId, status) {
      const update = db.prepare(`
        UPDATE pipeline_runtime_resources SET status = ?, updated_at = ? WHERE pipeline_instance_id = ?
      `).run(status, now(), instanceId);
      if (update.changes !== 1) throw new Error(`pipeline instance ${instanceId} has no runtime resource`);
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
    listProviderReadyInstances(limit = 50) {
      const instances = db.prepare(`
        SELECT DISTINCT pi.* FROM pipeline_instances pi
        JOIN pipeline_stage_attempts psa
          ON psa.pipeline_instance_id = pi.id AND psa.stage_id = pi.active_stage_id
        WHERE pi.status IN ('completion_pending_publication', 'publication_blocked', 'waiting_provider')
          AND psa.status IN ('pending', 'leased', 'dispatched', 'acknowledged', 'running')
        ORDER BY pi.updated_at, pi.id LIMIT ?
      `).all(limit) as PipelineInstance[];
      for (const instance of instances) validatePinnedInstance(db, instance);
      return instances;
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
    listPublications(instanceId) {
      return db.prepare(`
        SELECT * FROM pipeline_publication_receipts
        WHERE pipeline_instance_id = ? ORDER BY created_at, id
      `).all(instanceId) as PipelinePublicationReceipt[];
    },
    getPublication(id) {
      return db.prepare("SELECT * FROM pipeline_publication_receipts WHERE id = ?")
        .get(id) as PipelinePublicationReceipt | undefined;
    },
    claimGithubPublications,
    bindGithubPublicationTarget,
    markGithubPublicationProcessed,
    markGithubPublicationFailed,
    retryPublication,
    getStatusForIssue,
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
    getInboxEvent(id) {
      return db.prepare("SELECT * FROM pipeline_inbox_events WHERE id = ?")
        .get(id) as PipelineInboxEventRecord | undefined;
    },
    listPendingInboxEvents(kind, limit = 50) {
      return db.prepare(`
        SELECT * FROM pipeline_inbox_events
        WHERE kind = ? AND status = 'pending'
        ORDER BY created_at, id LIMIT ?
      `).all(kind, limit) as PipelineInboxEventRecord[];
    },
    enqueueInboxEvent,
    applyTransition,
  };
}
