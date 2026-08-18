import type {
  AssuranceClass,
  EvaluatorKind,
  PipelineOutcome,
  StageOutcome,
  ValidatedPipelineCatalog,
  ValidatedPipelineManifest,
  ValidatedRepositoryConfig,
} from "./manifest.js";
import type { FaultAttribution } from "./fault-attribution.js";
import type {
  ValidatedRuntimeCapabilityDescriptor,
} from "../runtime/contracts.js";
import type { StageRequestEnvelope, StageRequestInputArtifact } from "./stage-request.js";
import type { ExecutionPublicationSnapshot } from "./execution-publication.js";
import type { TaskType } from "./types.js";

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
  ticket_id: string;
  session_id: string;
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
  task_type: TaskType;
  published_commit: string | null;
  published_subject: string | null;
  repository_config_snapshot_id: string;
  repository_config_digest: string;
  runtime_release: string;
  capability_digest: string;
  executor_protocol: string;
  authorized_capabilities: string;
  runtime_provider: string | null;
  runtime_provider_resource_id: string | null;
  runtime_resource_status: PipelineRuntimeResource["status"] | null;
  runtime_resource_created_at: string | null;
  runtime_resource_updated_at: string | null;
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

export interface PipelineTaskBranch {
  pipeline_instance_id: string;
  ticket_id: string;
  generation: number;
  repository: string;
  branch: string;
  plan_digest: string;
  lineage: string;
  base_sha: string;
  accepted_integration_sha: string | null;
  acknowledged_remote_sha: string | null;
  status: "pending" | "reserved" | "checkpointed" | "published" | "failed";
  last_error: string | null;
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
  kind: "create_task_branch" | "advance_task_branch" | "provision" | "dispatch_stage" | "idle" | "stop" | "quarantine" | "cleanup" | "publish_control" | "publish_github";
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
  kind: "control_ledger" | "github_summary" | "pull_request";
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

export type OrchestrationJournalActor =
  | "supervisor"
  | "stage_agent"
  | "orchestrator"
  | "human";

export type OrchestrationJournalKind =
  | "delegated"
  | "published"
  | "merged"
  | "relayed_finding"
  | "dispatched_fix"
  | "detected_stall"
  | "capacity_refused"
  | "terminal_observed"
  | "run_note";

export interface OrchestrationJournalEntry {
  id: string;
  recorded_at: string;
  team: string;
  repository: string;
  issue: string;
  instance_id: string | null;
  run_id: string | null;
  actor: OrchestrationJournalActor;
  kind: OrchestrationJournalKind;
  trigger: string;
  action: string;
  outcome: string | null;
  refs: string;
  note: string | null;
  structured: string | null;
}

export interface OrchestrationJournalWrite {
  id?: string;
  issueId: string;
  instanceId?: string | null;
  runId?: string | null;
  actor: OrchestrationJournalActor;
  kind: OrchestrationJournalKind;
  trigger: string;
  action: string;
  outcome?: string | null;
  refs?: Record<string, unknown>;
  note?: string | null;
  structured?: Record<string, unknown> | null;
}

export interface OrchestrationJournalQuery {
  issueId?: string;
  issue?: string;
  repository?: string;
  from?: string;
  to?: string;
  limit?: number;
  order?: "oldest" | "newest";
}

// Supervisor-derived settlement facts only -- never agent-authored content.
// Written exactly once per pipeline instance, at its terminal transition. See
// persistence/pipeline/run-outcome-store.ts.
export interface RunOutcome {
  pipeline_instance_id: string;
  ticket_id: string;
  generation: number;
  execution_graph_id: string | null;
  plan_digest: string | null;
  base_commit: string;
  engine: "claude" | "codex" | "opencode";
  outcome: PipelineOutcome;
  closed_reason: StageOutcome;
  fault_attribution: FaultAttribution | null;
  generations_consumed: number;
  /** JSON object: { [unit_id]: repair_rounds } */
  repair_rounds_by_unit: string;
  /** JSON object: { [stage_id]: duration_ms } */
  phase_durations_ms: string;
  /** NULL means unmeasured -- no production path supplies cost yet. */
  token_cost_usd: number | null;
  /** JSON array of { skill, skill_package_digest } */
  skill_digests: string;
  created_at: string;
}

export interface ChildActionLivenessPort {
  renewChildActionLiveness(input: {
    parentRunId: string;
    actionId: string;
    heartbeatAtIso: string;
    leaseUntilIso: string;
  }): boolean;
}

export interface PipelineStatusProjection {
  execution_mode: "pipeline";
  instance_id: string;
  pipeline_id: string;
  pipeline_version: number;
  generation: number;
  task_type: TaskType;
  status: PipelineInstanceStatus;
  terminal_outcome: PipelineInstance["terminal_outcome"];
  stage_id: string | null;
  attempt_ordinal: number | null;
  reentry_ordinal: number | null;
  retry_count: number;
  reentry_count: number;
  wait_reason: string | null;
  whose_move: "waiting on you" | "waiting on GitHub" | "working" | "finished";
  last_error: string | null;
  last_state_change_at: string;
  subject: string | null;
  published_commit: string | null;
  published_pr_url: string | null;
  gate_result: string | null;
  assurance: string | null;
  policy_digest: string | null;
  context_policy: string | null;
  publication_state: "none" | "pending" | "acknowledged" | "failed" | "blocked";
  publication_id: string | null;
  publication_external_id: string | null;
  publication_error: string | null;
  task_branch_state: "none" | PipelineTaskBranch["status"];
  task_branch_base_sha: string | null;
  task_branch_accepted_integration_sha: string | null;
  task_branch_remote_sha: string | null;
  task_branch_lineage: string | null;
  task_branch_error: string | null;
  recovery_action: string | null;
  effect_state: "none" | "pending" | "failed" | "blocked";
  effect_kind: string | null;
  effect_status: PipelineEffectIntent["status"] | null;
  effect_attempts: number | null;
  effect_error: string | null;
  sandbox_event_id: string | null;
  sandbox_event_attempts: number | null;
  sandbox_ingestion_error: string | null;
  structured_active_unit_id: string | null;
  structured_active_action: string | null;
  structured_active_action_status: string | null;
  structured_heartbeat_at: string | null;
  structured_checkpoint_status: "pending" | "acknowledged" | "failed" | null;
  sandbox_disk_minimum_gib: 10;
  sandbox_capacity_warning: string | null;
  structured_units: Array<{
    unit_id: string;
    status: string;
    terminal_level: string | null;
    alarm: boolean;
    integration_subject: string | null;
  }>;
}

export interface PipelineInstanceSeed {
  id?: string;
  issueId: string;
  sessionId: string;
  generation: number;
  admissionEpoch?: number;
  repository: string;
  baseCommit: string;
  baseBranch?: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  taskType: TaskType;
  manifest: ValidatedPipelineManifest;
  repositoryConfig: RepositoryConfigSnapshot;
  runtime: ValidatedRuntimeCapabilityDescriptor;
  authorizedCapabilities: string[];
  planDigest?: string;
  taskContext?: string;
  inputArtifacts?: StageRequestInputArtifact[];
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
  evaluatorKind: EvaluatorKind;
  policyDigest: string;
  subject?: string | null;
  result: "passed" | "failed" | "indeterminate" | "not_configured";
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
  resumeStatus?: PipelineInstanceStatus | null;
  nextStageId?: string | null;
  nextStageStatus?: "dispatchable" | "waiting";
  terminalOutcome?: PipelineOutcome | null;
  waitReason?: string | null;
  immutableSubject?: string | null;
  publishedCommit?: string | null;
  publishedSubject?: string | null;
  taskBranchPublishedSha?: string;
  clearPublishedCommit?: boolean;
  /** Increments the target stage's local bounded re-entry counter. */
  reentryIncrement?: number;
  /** Increments the pipeline-wide semantic repair-round counter. */
  repairRoundIncrement?: number;
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

export interface PipelineStore extends ChildActionLivenessPort {
  acceptCatalog(catalog: ValidatedPipelineCatalog): void;
  acceptManifest(manifest: ValidatedPipelineManifest): void;
  getAcceptedManifestDigest(pipelineId: string, version: number): string | undefined;
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
  getStructuredExecutionPublicationForInstance(pipelineInstanceId: string): ExecutionPublicationSnapshot | undefined;
  bindStageRun(attemptId: string, runId: string): void;
  markStageDispatched(attemptId: string): void;
  bindRuntimeResource(instanceId: string, provider: string, providerResourceId: string): PipelineRuntimeResource;
  getRuntimeResource(instanceId: string): PipelineRuntimeResource | undefined;
  setRuntimeResourceStatus(instanceId: string, status: PipelineRuntimeResource["status"]): void;
  /**
   * The pipeline instance (any generation, any status) still bound to this
   * exact provider resource, if any. `runtime_provider_resource_id` is
   * unique per non-null value, so at most one instance can own a given
   * resource at a time. Used to keep resource-lifecycle ownership out of
   * `sweep.ts`'s orphan path once a resource is pipeline-bound: `tickets.
   * sandbox_id` is a projection that a newer generation's delegation
   * overwrites, so it cannot answer "does *any* pipeline instance still own
   * this resource" on its own.
   */
  getInstanceByRuntimeResourceId(providerResourceId: string): PipelineInstance | undefined;
  /**
   * Terminal instances whose bound runtime resource is `stopped` and has sat
   * past `cutoffIso` (the configured diagnostic-retention window) — the
   * candidate pool for `operations/runtime-resource-reclaim.ts`. Callers
   * still re-check status, the cutoff, active attempt, and unsettled effects per candidate
   * before deleting: this listing can be stale by the time it is consumed.
   */
  listReclaimableRuntimeResources(cutoffIso: string, limit?: number): PipelineInstance[];
  getActiveAttempt(instanceId: string): PipelineStageAttempt | undefined;
  listAttempts(instanceId: string): PipelineStageAttempt[];
  listProviderReadyInstances(limit?: number): PipelineInstance[];
  listStages(instanceId: string): PipelineInstanceStage[];
  getTaskBranch(instanceId: string): PipelineTaskBranch | undefined;
  queueTaskBranchAdvance(input: {
    instanceId: string;
    generation: number;
    lineage: string;
    expectedOldSha: string;
    expectedNewSha: string;
  }): PipelineEffectIntent;
  getEffect(id: string): PipelineEffectIntent | undefined;
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
  requeueGithubPublicationAfterStaleWrite(
    id: string,
    stalePayloadHash: string,
    externalId: string,
    externalUrl: string
  ): boolean;
  markGithubPublicationSkipped(id: string, expectedPayloadHash: string): boolean;
  /** True when the GitHub comment ID was written by the supervisor's own summary upsert. */
  isSupervisorGithubComment(externalId: string): boolean;
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
  markInboxEventDead(id: string): void;
  enqueueInboxEvent(input: {
    id: string;
    instanceId: string;
    generation: number;
    kind: string;
    payload: string;
    subject?: string | null;
  }): "pending" | "stale" | "consumed";
  applyTransition(write: CoordinatorTransitionWrite, faultAfterWrite?: (writeCount: number) => void): PipelineInstance;
  recordJournalEntry(input: OrchestrationJournalWrite): void;
  listJournalEntries(query: OrchestrationJournalQuery): OrchestrationJournalEntry[];
  // No getRunOutcome here on purpose: every gate/transition/scheduler/
  // effect-drain module is constructed with a PipelineStore, so a read
  // method on this interface would be reachable by decision code with no
  // import of persistence/pipeline/analysis-store.ts required, defeating the
  // read-contract architecture.test.ts enforces (see analysis-store.ts).
  // The single-row lookup still exists on RunOutcomeStore itself
  // (run-outcome-store.ts) for the write-path idempotency check and for
  // tests asserting settlement wrote a row; production reads go through
  // AnalysisStore.listRunOutcomes.
  pruneRunOutcomes(beforeIso: string): number;
}
