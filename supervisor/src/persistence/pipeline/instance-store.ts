import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import { admissionMaintenanceError } from "../maintenance-store.js";
import {
  buildStageRequest,
  createStageRequestHash,
  plannedStageRunId,
  type StageRequestEnvelope,
} from "../../pipeline/stage-request.js";
import type {
  PipelineEffectIntent,
  PipelineInstance,
  PipelineInstanceSeed,
  PipelineInstanceStage,
  PipelinePublicationReceipt,
  PipelineRuntimeResource,
  PipelineStageAttempt,
  PipelineStore,
  RepositoryConfigSnapshot,
} from "../../pipeline/store.js";
import {
  assertDigest,
  buildTerminalPublicationPayload,
  createPipelinePublicationWriter,
  deterministicId,
  persistSelectionPublications,
  SAFE_BRANCH,
  validatePinnedInstance,
} from "./helpers.js";
import { createJournalStore } from "./journal-store.js";
import { createRunOutcomeStore } from "./run-outcome-store.js";
import { getStructuredExecutionPublicationForAttempt } from "./unit-store.js";

interface ValidatedInstanceSeed {
  authorized: string[];
  baseBranch: string;
  instanceId: string;
  session: { ticket_id: string; generation: number; provider_conversation_id: string | null };
  snapshot: RepositoryConfigSnapshot;
}

export function createInstanceStore(db: Database.Database, now: () => string): Pick<
  PipelineStore,
  | "supersedeOtherInstances"
  | "createInstance"
  | "getInstance"
  | "getInstanceForSession"
  | "getAttempt"
  | "getAttemptForRun"
  | "getRepositoryConfigSnapshot"
  | "getStageRequest"
  | "bindStageRun"
  | "markStageDispatched"
  | "bindRuntimeResource"
  | "getRuntimeResource"
  | "setRuntimeResourceStatus"
  | "listReclaimableRuntimeResources"
  | "getInstanceByRuntimeResourceId"
  | "getActiveAttempt"
  | "listAttempts"
  | "listProviderReadyInstances"
  | "listStages"
  | "listEffects"
  | "listPublications"
  | "getPublication"
> {
  const getInstanceStmt = db.prepare("SELECT * FROM pipeline_instances WHERE id = ?");
  const getAdmissionMaintenanceStmt = db.prepare(
    "SELECT paused, epoch, reason FROM supervisor_maintenance WHERE key = 'admission'"
  );
  const getInstanceByRuntimeResourceIdStmt = db.prepare(
    "SELECT * FROM pipeline_instances WHERE runtime_provider_resource_id = ?"
  );
  const getAttemptStmt = db.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?");
  const persistPublication = createPipelinePublicationWriter(db);
  const journal = createJournalStore(db, now);
  const runOutcomes = createRunOutcomeStore(db);
  const runtimeResourceForInstance = (
    instance: PipelineInstance | undefined
  ): PipelineRuntimeResource | undefined => {
    if (!instance?.runtime_provider_resource_id) return undefined;
    return {
      pipeline_instance_id: instance.id,
      provider: instance.runtime_provider!,
      provider_resource_id: instance.runtime_provider_resource_id,
      status: instance.runtime_resource_status!,
      created_at: instance.runtime_resource_created_at!,
      updated_at: instance.runtime_resource_updated_at!,
    };
  };

  const listSupersedeCandidates = (issueId: string, currentSessionId: string): PipelineInstance[] =>
    db.prepare(`
      SELECT * FROM pipeline_instances
      WHERE ticket_id = ? AND session_id <> ?
        AND terminal_outcome IS NULL
        AND status NOT IN ('shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed')
    `).all(issueId, currentSessionId) as PipelineInstance[];

  const getSupersedableAttempt = (instanceId: string): PipelineStageAttempt | undefined =>
    db.prepare(`
        SELECT * FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ?
          AND status IN ('pending', 'leased', 'dispatched', 'acknowledged', 'running')
        ORDER BY attempt_ordinal DESC, reentry_ordinal DESC LIMIT 1
      `).get(instanceId) as PipelineStageAttempt | undefined;

  const markInstanceSuperseded = (instance: PipelineInstance, nextVersion: number, timestamp: string): void => {
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
  };

  const publishSupersededInstance = (
    instance: PipelineInstance,
    activeAttempt: PipelineStageAttempt | undefined,
    nextVersion: number,
    timestamp: string
  ): void => {
    const structuredExecution = activeAttempt
      ? getStructuredExecutionPublicationForAttempt(db, activeAttempt.id)
      : undefined;
    const terminalPublication = buildTerminalPublicationPayload({
      instance,
      attempt: activeAttempt,
      outcome: "superseded",
      reason: "A newer delegated Linear session superseded this pipeline generation.",
      structuredExecution,
    });
    persistPublication({
      instance,
      attemptId: activeAttempt?.id ?? null,
      kind: "control_ledger",
      idempotencyKey: `control-terminal:${instance.id}:superseded:${nextVersion}`,
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
  };

  const enqueueSupersedeStop = (
    instance: PipelineInstance,
    activeAttempt: PipelineStageAttempt | undefined,
    nextVersion: number,
    currentSessionId: string,
    timestamp: string
  ): void => {
    const payload = canonicalJson({
      pipelineInstanceId: instance.id,
      reason: "newer_delegated_generation",
      replacementSessionId: currentSessionId,
      runId: activeAttempt?.run_id ?? activeAttempt?.planned_run_id ?? null,
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
  };

  const supersedeInstance = (instance: PipelineInstance, currentSessionId: string, timestamp: string): void => {
    const nextVersion = instance.state_version + 1;
    const activeAttempt = getSupersedableAttempt(instance.id);
    markInstanceSuperseded(instance, nextVersion, timestamp);
    // markInstanceSuperseded writes terminal_outcome = 'superseded' directly
    // -- it never routes through applyTransition, so without this the
    // settlement rollup writer never runs for a superseded generation and
    // the 'superseded' outcome/closed_reason values are unreachable in
    // run_outcomes.
    runOutcomes.recordSettlement(
      instance,
      activeAttempt,
      { terminalOutcome: "superseded", outcome: "superseded" },
      timestamp
    );
    publishSupersededInstance(instance, activeAttempt, nextVersion, timestamp);
    enqueueSupersedeStop(instance, activeAttempt, nextVersion, currentSessionId, timestamp);
  };

  const supersedeOtherInstances = db.transaction((issueId: string, currentSessionId: string) => {
    const timestamp = now();
    for (const instance of listSupersedeCandidates(issueId, currentSessionId)) {
      supersedeInstance(instance, currentSessionId, timestamp);
    }
  });

  const validateSeed = (seed: PipelineInstanceSeed): ValidatedInstanceSeed | { existing: PipelineInstance } => {
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
    const session = db.prepare(`
      SELECT ticket_id, generation, provider_conversation_id, execution_mode, pipeline_instance_id
      FROM agent_sessions WHERE id = ?
    `).get(seed.sessionId) as
      | {
        ticket_id: string;
        generation: number;
        provider_conversation_id: string | null;
        execution_mode: string | null;
        pipeline_instance_id: string | null;
      }
      | undefined;
    if (!session || session.ticket_id !== seed.issueId || session.generation !== seed.generation) {
      throw new Error(`session ${seed.sessionId} generation binding mismatch`);
    }
    if (session.execution_mode) {
      if (session.execution_mode === "pipeline" && session.pipeline_instance_id === instanceId) {
        const existing = getInstanceStmt.get(instanceId) as PipelineInstance;
        validatePinnedInstance(db, existing);
        if (
          existing.ticket_id !== seed.issueId || existing.session_id !== seed.sessionId ||
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
        return { existing };
      }
      throw new Error(`session ${seed.sessionId} execution mode is already pinned`);
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
    return { authorized, baseBranch, instanceId, session, snapshot };
  };

  const insertInstanceGraph = (
    seed: PipelineInstanceSeed,
    validated: ValidatedInstanceSeed,
    timestamp: string
  ): void => {
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, ticket_id, session_id, generation, pipeline_id,
        pipeline_version, manifest_digest, normalized_manifest, repository,
        base_commit, base_branch, branch, agent, task_type, repository_config_snapshot_id, repository_config_digest,
        runtime_release, capability_digest, executor_protocol,
        authorized_capabilities, status, active_stage_id, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatchable', ?, 1, ?, ?)
    `).run(
      validated.instanceId, seed.issueId, seed.sessionId, seed.generation,
      seed.manifest.manifest.id, seed.manifest.manifest.version,
      seed.manifest.digest, seed.manifest.normalized, seed.repository,
      seed.baseCommit, validated.baseBranch, seed.branch, seed.agent, seed.taskType,
      validated.snapshot.id, validated.snapshot.digest,
      seed.runtime.descriptor.release,
      seed.runtime.digest, seed.runtime.descriptor.protocol, canonicalJson(validated.authorized),
      seed.manifest.manifest.entry_stage, timestamp, timestamp
    );
    seed.manifest.manifest.stages.forEach((stage, index) => {
      db.prepare(`
        INSERT INTO pipeline_instance_stages (
          pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.instanceId,
        stage.id,
        index + 1,
        stage.id === seed.manifest.manifest.entry_stage ? "dispatchable" : "pending",
        stage.id === seed.manifest.manifest.entry_stage ? 1 : 0,
        timestamp,
        timestamp
      );
    });
    db.prepare(`
      UPDATE agent_sessions
      SET execution_mode = 'pipeline', pipeline_instance_id = ?, updated_at = ?
      WHERE id = ? AND execution_mode IS NULL
    `).run(validated.instanceId, timestamp, seed.sessionId);
  };

  const sealEntryAttempt = (
    seed: PipelineInstanceSeed,
    validated: ValidatedInstanceSeed,
    timestamp: string
  ): { attemptId: string; stageRequest: StageRequestEnvelope } => {
    const entry = seed.manifest.manifest.stages.find((stage) => stage.id === seed.manifest.manifest.entry_stage)!;
    const attemptId = deterministicId("attempt", [validated.instanceId, entry.id, 1, 0]);
    const plannedRunId = plannedStageRunId(attemptId);
    const stageRequest = buildStageRequest({
      instanceId: validated.instanceId,
      manifestDigest: seed.manifest.digest,
      runtimeRelease: seed.runtime.descriptor.release,
      capabilityDigest: seed.runtime.digest,
      repositoryConfigDigest: validated.snapshot.digest,
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
      baseBranch: validated.baseBranch,
      branch: seed.branch,
      agent: seed.agent,
      contextRevision: 0,
      expectedSubject: null,
      nativeSessionId: validated.session.provider_conversation_id,
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
      attemptId, validated.instanceId, entry.id, stageRequest.requestHash, stageRequest.idempotencyKey,
      entry.context, plannedRunId, validated.session.provider_conversation_id, requestPayload, timestamp, timestamp
    );
    return { attemptId, stageRequest };
  };

  const enqueueProvision = (
    seed: PipelineInstanceSeed,
    validated: ValidatedInstanceSeed,
    attemptId: string,
    stageRequest: StageRequestEnvelope,
    timestamp: string
  ): void => {
    const provisionPayload = canonicalJson({
      pipelineInstanceId: validated.instanceId,
      attemptId,
      requestHash: stageRequest.requestHash,
      repository: seed.repository,
      baseCommit: seed.baseCommit,
      repositoryConfigDigest: validated.snapshot.digest,
      runtimeRelease: seed.runtime.descriptor.release,
    });
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, 1, 'provision', ?, ?, ?, 'pending', ?, ?)
    `).run(
      deterministicId("effect", [validated.instanceId, 1, "provision"]),
      validated.instanceId,
      `provision:${validated.instanceId}`,
      provisionPayload,
      digestNormalized(provisionPayload),
      timestamp,
      timestamp
    );
  };

  const createInstance = db.transaction((seed: PipelineInstanceSeed): PipelineInstance => {
    const validated = validateSeed(seed);
    if ("existing" in validated) return validated.existing;
    if (seed.admissionEpoch !== undefined) {
      const maintenance = getAdmissionMaintenanceStmt.get() as
        | { paused: 0 | 1; epoch: number; reason: string | null }
        | undefined;
      const paused = maintenance?.paused === 1;
      const epoch = maintenance?.epoch ?? 0;
      if (paused || epoch !== seed.admissionEpoch) {
        const reason = paused
          ? `admission maintenance is paused${maintenance?.reason ? `: ${maintenance.reason}` : ""}`
          : `admission maintenance epoch changed from ${seed.admissionEpoch} to ${epoch}`;
        throw admissionMaintenanceError(reason);
      }
    }
    const timestamp = now();
    insertInstanceGraph(seed, validated, timestamp);
    const sealed = sealEntryAttempt(seed, validated, timestamp);
    enqueueProvision(seed, validated, sealed.attemptId, sealed.stageRequest, timestamp);
    const result = getInstanceStmt.get(validated.instanceId) as PipelineInstance;
    validatePinnedInstance(db, result);
    persistSelectionPublications({ db, instance: result, timestamp });
    journal.recordJournalEntry({
      id: deterministicId("journal", [result.id, "delegated"]),
      issueId: result.ticket_id,
      instanceId: result.id,
      actor: "supervisor",
      kind: "delegated",
      trigger: "Linear delegation admitted",
      action: `Pinned ${result.pipeline_id}@${result.pipeline_version} and queued the entry stage.`,
      outcome: result.status,
      refs: {
        stage: result.active_stage_id,
        attempt_count: result.attempt_count,
        base_commit: result.base_commit,
        base_branch: result.base_branch,
        manifest_digest: result.manifest_digest,
      },
    });
    return result;
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
  });

  return {
    supersedeOtherInstances,
    createInstance,
    getInstance(id) {
      const instance = getInstanceStmt.get(id) as PipelineInstance | undefined;
      if (instance) validatePinnedInstance(db, instance);
      return instance;
    },
    getInstanceForSession(sessionId) {
      const instance = db.prepare(`
        SELECT pi.* FROM agent_sessions s
        JOIN pipeline_instances pi ON pi.id = s.pipeline_instance_id
        WHERE s.id = ? AND s.execution_mode = 'pipeline'
      `).get(sessionId) as PipelineInstance | undefined;
      if (instance) validatePinnedInstance(db, instance);
      return instance;
    },
    getAttempt(id) {
      return getAttemptStmt.get(id) as PipelineStageAttempt | undefined;
    },
    getAttemptForRun(runId) {
      return db.prepare(`
        SELECT * FROM pipeline_stage_attempts
        WHERE run_id = ? OR planned_run_id = ?
        ORDER BY CASE WHEN run_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(runId, runId, runId) as PipelineStageAttempt | undefined;
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
        if (attempt.stage_id.startsWith("repair_")) {
          const instance = getInstanceStmt.get(attempt.pipeline_instance_id) as PipelineInstance;
          journal.recordJournalEntry({
            id: deterministicId("journal", [attempt.id, "dispatched_fix"]),
            issueId: instance.ticket_id,
            instanceId: instance.id,
            runId: attempt.run_id,
            actor: "supervisor",
            kind: "dispatched_fix",
            trigger: "Repair stage dispatched",
            action: `Dispatched ${attempt.stage_id} after prior feedback or gate failure.`,
            outcome: "running",
            refs: {
              stage: attempt.stage_id,
              attempt_id: attempt.id,
              run_id: attempt.run_id,
              attempt_count: instance.attempt_count,
              reentry_count: instance.reentry_count,
            },
          });
        }
      })();
    },
    bindRuntimeResource(instanceId, provider, providerResourceId) {
      const instance = getInstanceStmt.get(instanceId) as PipelineInstance | undefined;
      if (!instance) throw new Error(`unknown pipeline instance ${instanceId}`);
      if (instance.runtime_provider_resource_id) {
        if (instance.runtime_provider !== provider || instance.runtime_provider_resource_id !== providerResourceId) {
          throw new Error(`pipeline instance ${instanceId} is already bound to a different runtime resource`);
        }
        return runtimeResourceForInstance(instance)!;
      }
      const timestamp = now();
      db.prepare(`
        UPDATE pipeline_instances
        SET runtime_provider = ?, runtime_provider_resource_id = ?,
            runtime_resource_status = 'active',
            runtime_resource_created_at = ?, runtime_resource_updated_at = ?,
            updated_at = ?
        WHERE id = ? AND runtime_provider_resource_id IS NULL
      `).run(provider, providerResourceId, timestamp, timestamp, timestamp, instanceId);
      return runtimeResourceForInstance(getInstanceStmt.get(instanceId) as PipelineInstance | undefined)!;
    },
    getRuntimeResource(instanceId) {
      return runtimeResourceForInstance(getInstanceStmt.get(instanceId) as PipelineInstance | undefined);
    },
    setRuntimeResourceStatus(instanceId, status) {
      const timestamp = now();
      const update = db.prepare(`
        UPDATE pipeline_instances
        SET runtime_resource_status = ?, runtime_resource_updated_at = ?, updated_at = ?
        WHERE id = ? AND runtime_provider_resource_id IS NOT NULL
      `).run(status, timestamp, timestamp, instanceId);
      if (update.changes === 1) return;
      throw new Error(`pipeline instance ${instanceId} has no runtime resource`);
    },
    listReclaimableRuntimeResources(cutoffIso, limit = 50) {
      return db.prepare(`
        SELECT * FROM pipeline_instances
        WHERE runtime_resource_status = 'stopped'
          AND terminal_outcome IS NOT NULL
          AND runtime_resource_updated_at <= ?
        ORDER BY runtime_resource_updated_at LIMIT ?
      `).all(cutoffIso, limit) as PipelineInstance[];
    },
    getInstanceByRuntimeResourceId(providerResourceId) {
      return getInstanceByRuntimeResourceIdStmt.get(providerResourceId) as PipelineInstance | undefined;
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
    listAttempts(instanceId) {
      return db.prepare(`
        SELECT * FROM pipeline_stage_attempts
        WHERE pipeline_instance_id = ?
        ORDER BY attempt_ordinal, reentry_ordinal, created_at, id
      `).all(instanceId) as PipelineStageAttempt[];
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
  };
}
