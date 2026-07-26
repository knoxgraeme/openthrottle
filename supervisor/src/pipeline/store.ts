import type {
  AssuranceClass,
  PipelineOutcome,
  StageOutcome,
  ValidatedPipelineCatalog,
  ValidatedPipelineManifest,
  ValidatedRepositoryConfig,
} from "./manifest.js";
import type {
  ValidatedRuntimeCapabilityDescriptor,
} from "../runtime/contracts.js";
import type { StageRequestEnvelope } from "./stage-request.js";

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
  effect_state: "none" | "pending" | "failed" | "blocked";
  effect_kind: string | null;
  effect_status: PipelineEffectIntent["status"] | null;
  effect_attempts: number | null;
  effect_error: string | null;
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
  exhaustedEffectId?: string;
  exhaustedEffectError?: string;
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
  supersedeOtherInstances(issueId: string, currentSessionId: string): void;
  createInstance(seed: PipelineInstanceSeed): PipelineInstance;
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
  markGithubPublicationSkipped(id: string, expectedPayloadHash: string): boolean;
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
  markStopEffectExhausted(input: {
    effectId: string;
    error: string;
    runId: string | null;
    owner: string;
  }): void;
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
