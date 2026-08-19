import type { Ticket, SupervisorStore } from "../persistence/store.js";
import type { RepositoryPublicationPort, RepositoryRefWritePort } from "../app/ports.js";
import type { CitationGateStore } from "../persistence/pipeline/citation-gate-store.js";
import type { ExecutionUnitStore } from "../persistence/pipeline/unit-store.js";
import { AUTOMATIC_ADMISSION_STAGE_IDS, stageById } from "../pipeline/manifest.js";
import { evaluateAdmissionDecisionGate, evaluateAdmissionReviewGate, type AdmissionGateContext } from "../pipeline/admission-gate.js";
import { extractJsonBlocks } from "../pipeline/markdown.js";
import { FOR_EACH_UNIT_CAPABILITY } from "../pipeline/capability-contracts.js";
import {
  canonicalJson,
  digestNormalized,
  TUNE_DECISION_SCHEMA,
  TUNE_EDIT_AUTHORIZATION_SCHEMA,
  TUNE_RELEASE_DESCRIPTOR_SCHEMA,
  digestCanonicalJson,
  validateStandardReceipt,
  validateTuneDecisionContract,
  validateTuneEditAuthorizationContract,
  validateTuneProposalContract,
  validateTuneReleaseDescriptorContract,
  type StandardReceipt,
  type RepositoryConfigContract,
  type TuneProposal,
  type ValidatedContract,
} from "@openthrottle/contracts";
import { evaluateCitationGate, type ResolvedCitation } from "../pipeline/citation-gate.js";
import { evaluateImprovementProposalGate } from "../pipeline/improvement-proposal-gate.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "../pipeline/coordinator.js";
import { completeStageAttemptActor } from "../pipeline/settlement.js";
import { assertTuneRatchetMaterialBinding, executionPlanForTuneProposal } from "../pipeline/tune-material.js";
import { deriveStageFaultAttribution } from "../pipeline/fault-attribution.js";
import type {
  PipelineEffectIntent,
  PipelineInstance,
  PipelineRuntimeResource,
  PipelineStore,
} from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type { RuntimeResource, SandboxAutostopRuntime, SandboxRuntime } from "../runtime/contracts.js";
import {
  runtimeObservationErrorMatches,
  serializeRuntimeObservationError,
  type SerializedRuntimeObservationError,
} from "../runtime/observation-error.js";
import { exponentialBackoffDelayMs } from "../shared/backoff.js";
import { sanitizeText } from "../shared/sanitize.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import { createStructuredChildRuntime } from "./structured-child-runtime.js";
import {
  createRuntimeResourceReconciler,
  HOT_PATH_RECLAIM_LIMIT,
  HOT_PATH_RECLAIM_WAIT_TIMEOUT_MS,
  type RuntimeResourceReconciler,
} from "./runtime-resource-reclaim.js";

const EFFECT_LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
// Leasing increments attempts before processing, so attempts >= 1 here; the
// prior inline formula capped the exponent at 6, i.e. RETRY_BASE_MS * 2 ** 6.
const MAX_RETRY_DELAY_MS = RETRY_BASE_MS * 2 ** 6;
const MAX_EFFECT_ATTEMPTS = 8;
const CAPACITY_RETRY_MS = 5 * 60_000;
const MAX_STAGE_TIMEOUT_SECONDS = 86_400;

// Deterministic provider failures must not burn the whole retry budget on hot
// exponential backoff. Auth failures never self-heal, so they exhaust on the
// first attempt carrying the real sanitized message. Capacity failures clear
// only when unrelated resources are released, so they retry on a fixed patient
// interval while still counting against MAX_EFFECT_ATTEMPTS.
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\b40[13]\b/i,
  /write access to repository not granted/i,
  /resource not accessible/i,
  /bad credentials/i,
  /\b(?:invalid|expired|revoked)\b[^\n]{0,40}\btoken\b/i,
  /\btoken\b[^\n]{0,40}\b(?:invalid|expired|revoked)\b/i,
];

const CAPACITY_ERROR_PATTERNS: RegExp[] = [
  /total (?:memory|disk|cpu) limit exceeded/i,
  /quota exceeded/i,
  /insufficient (?:memory|disk|capacity)/i,
];

type EffectErrorClass = "auth" | "capacity" | "permanent" | "transient";
type RuntimeEffectHandlerResult = "acknowledge" | "skip_acknowledgement";

function classifyEffectError(error: unknown, observed: SerializedRuntimeObservationError): EffectErrorClass {
  // Capacity wins over auth: a provider may wrap a quota rejection in an HTTP
  // 403, and the broad 401/403 auth patterns would otherwise fast-fail an
  // error that clears once resources free up.
  if (runtimeObservationErrorMatches(error, CAPACITY_ERROR_PATTERNS)) return "capacity";
  if (typeof error === "object" && error !== null &&
      "retryable" in error && (error as { retryable?: unknown }).retryable === false) {
    return "permanent";
  }
  if (
    observed.statusCode === 401 || observed.statusCode === 403 ||
    runtimeObservationErrorMatches(error, AUTH_ERROR_PATTERNS)
  ) return "auth";
  return "transient";
}

export interface PipelineEffectProcessor {
  drain(): Promise<void>;
}

interface PipelineEffectProcessorDeps {
  store: PipelineStore & ExecutionUnitStore;
  tickets: SupervisorStore;
  runtime: SandboxRuntime & SandboxAutostopRuntime;
  repositoryWriter: RepositoryRefWritePort;
  repositoryPublisher?: RepositoryPublicationPort;
  taskTimeoutSeconds: number;
  /** Maximum concurrently active review-persona subactions. Defaults to 1 in test harnesses. */
  reviewFanoutConcurrency?: number;
  // OPE-75: bounded diagnostic-retention window a terminal instance's stopped
  // runtime resource must clear before the reclaim path may delete it. Used
  // to run one reconciliation pass here too when a provision/dispatch effect
  // hits a provider capacity error, alongside the periodic sweep and the
  // capacity-constrained admission preflight (the same eligibility rule
  // everywhere -- see operations/runtime-resource-reclaim.ts).
  runtimeResourceRetentionMinutes: number;
  citationGateStore?: CitationGateStore;
  /** Shared production single-flight reconciler; tests may omit it. */
  reconcileRuntimeResources?: RuntimeResourceReconciler;
  now?: () => Date;
  // Per-tick bound on the composite child-drain walk; production uses the
  // structured-child-runtime default. Harnesses that pause a run at an exact
  // mid-flight state set 1 (see structured-walking-skeleton.mjs).
  maxChildDrainsPerTick?: number;
}

interface StopEffectControl {
  runId: string | null | undefined;
  ticketState: unknown;
}

interface EffectRuntimeBinding {
  resource: RuntimeResource | undefined;
  status: PipelineRuntimeResource["status"] | undefined;
}

interface IdleEffectControl {
  stageId: string;
  attemptId: string;
  reason: "provider wait" | "human wait";
}

interface TaskBranchEffectControl {
  pipelineInstanceId: string;
  ticketId: string;
  generation: number;
  repository: string;
  ref: string;
  planDigest: string;
  lineage: string;
  expectedOldSha: string | null;
  expectedNewSha: string;
}

function isTaskBranchEffect(effect: Pick<PipelineEffectIntent, "kind">): boolean {
  return effect.kind === "create_task_branch" || effect.kind === "advance_task_branch";
}

function parseTaskBranchEffectControl(
  effect: PipelineEffectIntent,
  instance: PipelineInstance,
  store: PipelineStore
): TaskBranchEffectControl {
  const control = JSON.parse(effect.payload) as Partial<TaskBranchEffectControl> & { schema?: unknown };
  const branch = store.getTaskBranch(instance.id);
  if (
    control.schema !== "openthrottle.task-branch-effect/v1" ||
    !branch ||
    control.pipelineInstanceId !== instance.id ||
    control.ticketId !== instance.ticket_id ||
    control.generation !== instance.generation ||
    control.repository !== instance.repository ||
    control.ref !== `refs/heads/${instance.branch}` ||
    control.planDigest !== branch.plan_digest ||
    control.lineage !== branch.lineage ||
    (control.expectedOldSha !== null && typeof control.expectedOldSha !== "string") ||
    typeof control.expectedNewSha !== "string"
  ) throw new Error(`pipeline task branch effect ${effect.id} has a stale lineage fence`);
  if (effect.kind === "create_task_branch" &&
      (control.expectedOldSha !== null || control.expectedNewSha !== instance.base_commit)) {
    throw new Error(`pipeline task branch effect ${effect.id} does not reserve the exact sealed base`);
  }
  if (effect.kind === "advance_task_branch" &&
      (branch.acknowledged_remote_sha !== control.expectedOldSha ||
       branch.accepted_integration_sha !== control.expectedNewSha)) {
    throw new Error(`pipeline task branch effect ${effect.id} does not match the accepted integration`);
  }
  return control as TaskBranchEffectControl;
}

function parseStopEffectControl(effect: PipelineEffectIntent): StopEffectControl {
  const parsed = JSON.parse(effect.payload) as Record<string, unknown>;
  const hasRunId = Object.prototype.hasOwnProperty.call(parsed, "runId");
  if (hasRunId && parsed.runId !== null && typeof parsed.runId !== "string") {
    throw new Error(`pipeline stop effect ${effect.id} has an invalid run binding`);
  }
  return {
    // Undefined denotes an intent written by an earlier release. Those intents
    // recover a candidate from the durable ticket projection and validate it
    // against the original instance. Newly authored intents always seal either
    // the original run id or an explicit null.
    runId: hasRunId ? (parsed.runId as string | null) : undefined,
    ticketState: parsed.ticketState,
  };
}

function parseIdleEffectControl(effect: PipelineEffectIntent): IdleEffectControl {
  const parsed = JSON.parse(effect.payload) as Record<string, unknown>;
  if (typeof parsed.stageId !== "string" || typeof parsed.attemptId !== "string") {
    throw new Error(`pipeline idle effect ${effect.id} has no wait fence`);
  }
  if (parsed.reason !== "provider wait" && parsed.reason !== "human wait") {
    throw new Error(`pipeline idle effect ${effect.id} has an invalid wait reason`);
  }
  return {
    stageId: parsed.stageId,
    attemptId: parsed.attemptId,
    reason: parsed.reason,
  };
}

function parseRequest(effect: PipelineEffectIntent, store: PipelineStore): StageRequestEnvelope {
  const request = JSON.parse(effect.payload) as StageRequestEnvelope;
  const active = store.getActiveAttempt(effect.pipeline_instance_id);
  if (!active || active.id !== request.attemptId) {
    throw new Error(`pipeline effect ${effect.id} does not target the active attempt`);
  }
  const sealed = store.getStageRequest(active.id);
  if (canonicalJson(request) !== canonicalJson(sealed)) {
    throw new Error(`pipeline effect ${effect.id} stage request does not match its sealed attempt`);
  }
  return sealed;
}

function parseProvisionRequest(effect: PipelineEffectIntent, store: PipelineStore): StageRequestEnvelope {
  const control = JSON.parse(effect.payload) as { attemptId?: unknown; requestHash?: unknown };
  if (typeof control.attemptId !== "string" || typeof control.requestHash !== "string") {
    throw new Error(`pipeline provision effect ${effect.id} has no sealed attempt fence`);
  }
  const attempt = store.getAttempt(control.attemptId);
  if (!attempt || attempt.pipeline_instance_id !== effect.pipeline_instance_id ||
      attempt.request_hash !== control.requestHash) {
    throw new Error(`pipeline provision effect ${effect.id} attempt fence mismatch`);
  }
  const request = store.getStageRequest(attempt.id);
  if (request.pipelineInstanceId !== effect.pipeline_instance_id ||
      request.requestHash !== control.requestHash) {
    throw new Error(`pipeline provision effect ${effect.id} sealed request mismatch`);
  }
  return request;
}

function compositeStageTimeoutSeconds(instance: PipelineInstance, stageId: string, fallbackSeconds: number): number {
  const stage = stageById(instance.normalized_manifest, stageId);
  if (!stage) throw new Error(`pipeline composite request references missing stage ${stageId}`);
  const phaseTimeouts = (stage.unitPhaseBindings ?? [])
    .flatMap((binding) => binding.kind === "agent" || binding.kind === "gate" ? [binding.loop.timeout_seconds] : []);
  const timeoutSeconds = Math.max(fallbackSeconds, ...phaseTimeouts);
  if (timeoutSeconds > MAX_STAGE_TIMEOUT_SECONDS) {
    throw new Error(`pipeline composite stage ${stageId} timeout ${timeoutSeconds}s exceeds maximum ${MAX_STAGE_TIMEOUT_SECONDS}s`);
  }
  return timeoutSeconds;
}

export function createPipelineEffectProcessor(deps: PipelineEffectProcessorDeps): PipelineEffectProcessor {
  const now = deps.now ?? (() => new Date());
  const reconcileRuntimeResources = deps.reconcileRuntimeResources ??
    createRuntimeResourceReconciler({
      store: deps.store,
      tickets: deps.tickets,
      runtime: deps.runtime,
    });
  let draining = false;

  const runMatchesInstance = (runId: string, instance: PipelineInstance): boolean => {
    const run = deps.tickets.getRun(runId);
    const attempt = deps.store.getAttemptForRun(runId);
    return attempt?.pipeline_instance_id === instance.id &&
      (!run || (
        run.ticket_id === instance.ticket_id &&
        run.session_id === instance.session_id
      ));
  };

  const resolveStopRunId = (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    ticket: Ticket | undefined,
    control: StopEffectControl,
    rejectInvalidBinding: boolean
  ): string | null => {
    const candidate = control.runId === undefined ? ticket?.run_id ?? null : control.runId;
    if (!candidate) return null;
    if (!runMatchesInstance(candidate, instance)) {
      if (rejectInvalidBinding && control.runId !== undefined) {
        throw new Error(`pipeline stop effect ${effect.id} run binding mismatch`);
      }
      const fallback = ticket?.run_id ?? null;
      return fallback && runMatchesInstance(fallback, instance) ? fallback : null;
    }
    return candidate;
  };

  const assertActiveAttempt = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
    const current = deps.store.getInstance(instance.id);
    const attempt = deps.store.getActiveAttempt(instance.id);
    if (!current || !["pending", "dispatchable", "running"].includes(current.status) ||
        !attempt || attempt.id !== request.attemptId) {
      throw new Error(`pipeline stage request ${request.attemptId} is no longer active`);
    }
  };

  const bindCompositeParentRun = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    if (!ticket || ticket.session_id !== instance.session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    if (ticket.run_id && ticket.run_id !== request.runId) {
      throw new Error(`ticket ${ticket.ticket_reference} already has active actor ${ticket.run_id}`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.ticket_id,
        runId: request.runId,
        taskType: instance.task_type,
        tokenHash: request.requestHash,
        expiresAt: new Date(
          now().getTime() + compositeStageTimeoutSeconds(instance, request.stageId, deps.taskTimeoutSeconds) * 1_000
        ).toISOString(),
      });
      if (!started) throw new Error(`pipeline composite stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    deps.store.markStageDispatched(request.attemptId);
  };

  const structuredChildren = createStructuredChildRuntime({
    store: deps.store,
    runtime: deps.runtime,
    taskTimeoutSeconds: deps.taskTimeoutSeconds,
    reviewFanoutConcurrency: deps.reviewFanoutConcurrency,
    now,
    maxChildDrainsPerTick: deps.maxChildDrainsPerTick,
    completeParentStage(event: PipelineCoordinatorEvent): PipelineInstance {
      if (!event.runId) throw new Error(`pipeline composite event ${event.id} has no run binding`);
      return deps.tickets.finishRunAndThen(
        {
          runId: event.runId,
          status: "completed",
          exitCode: 0,
          ticketState: "active",
          faultAttribution: deriveStageFaultAttribution(event.outcome, event.faultReason),
        },
        () => coordinatePipelineEvent(deps.store, event)
      );
    },
  });

  const resourceFor = async (instance: PipelineInstance): Promise<RuntimeResource> => {
    const existing = deps.store.getRuntimeResource(instance.id);
    if (existing) {
      if (existing.status !== "active") {
        throw new Error(`pipeline runtime ${existing.provider_resource_id} is ${existing.status} and cannot dispatch`);
      }
      await deps.runtime.setActive(existing.provider_resource_id);
      return { providerResourceId: existing.provider_resource_id };
    }
    const resource = await deps.runtime.provision({
      idempotencyKey: `provision:${instance.id}`,
      repository: instance.repository,
      baseCommit: instance.base_commit,
      runtimeRelease: instance.runtime_release,
    });
    deps.store.bindRuntimeResource(instance.id, "daytona", resource.providerResourceId);
    deps.tickets.setSandboxId(instance.ticket_id, resource.providerResourceId);
    return resource;
  };

  const bootstrap = async (instance: PipelineInstance, resource: RuntimeResource): Promise<void> => {
    const config = deps.store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
    if (!config || config.digest !== instance.repository_config_digest) {
      throw new Error(`pipeline instance ${instance.id} lost its sealed repository config`);
    }
    await deps.runtime.bootstrap(resource, {
      sealedRepositoryConfig: config.normalized_config,
      configDigest: config.digest,
      normalizedManifest: instance.normalized_manifest,
      manifestDigest: instance.manifest_digest,
    });
  };

  const dispatch = async (
    instance: PipelineInstance,
    resource: RuntimeResource,
    request: StageRequestEnvelope
  ): Promise<{ providerDispatchId: string }> => {
    if (request.pipelineInstanceId !== instance.id || request.generation !== instance.generation) {
      throw new Error(`pipeline stage request ${request.attemptId} has a stale instance fence`);
    }
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    if (!ticket || ticket.session_id !== instance.session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    await deps.runtime.materializeCredentials(resource, request.credentialScopes);
    assertActiveAttempt(instance, request);
    if (ticket.run_id && ticket.run_id !== request.runId) {
      throw new Error(`ticket ${ticket.ticket_reference} already has active actor ${ticket.run_id}`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.ticket_id,
        runId: request.runId,
        taskType: instance.task_type,
        // `runs.token_hash` predates the sealed stage protocol. Store the
        // immutable request hash until the column is contracted in a schema-
        // only migration; no bearer callback credential exists.
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    const recovered = await deps.runtime.collectStageResult(resource, request.attemptId);
    if (recovered) return { providerDispatchId: `recovered:${request.attemptId}` };
    assertActiveAttempt(instance, request);
    const dispatched = await deps.runtime.dispatchStage(resource, request);
    deps.store.markStageDispatched(request.attemptId);
    return dispatched;
  };

  const acknowledgeEffect = (effect: PipelineEffectIntent, eventId: string, payload: unknown): void => {
    deps.store.recordEffectAcknowledgement({
      effectId: effect.id,
      eventId,
      payload: canonicalJson(payload),
    });
  };

  const typedReceiptFromInput = <T extends StandardReceipt["type"]>(
    request: StageRequestEnvelope,
    type: T,
    errors: {
      missing: string;
      wrongType: string;
    } = {
      missing: `supervisor tune stage ${request.stageId} is missing its sealed predecessor receipt`,
      wrongType: `supervisor tune stage ${request.stageId} requires ${type}`,
    },
  ): Extract<StandardReceipt, { type: T }> => {
    const artifact = request.inputArtifacts?.find((entry) => entry.kind === "standard_receipt");
    if (!artifact || digestNormalized(artifact.payload) !== artifact.hash) {
      throw new Error(errors.missing);
    }
    const wrapper = JSON.parse(artifact.payload) as { details?: { receipt?: unknown } };
    const receipt = validateStandardReceipt(wrapper.details?.receipt, {
      source: `stage.${request.stageId}.input_receipt`,
    }).value;
    if (receipt.type !== type) throw new Error(errors.wrongType);
    return receipt as Extract<StandardReceipt, { type: T }>;
  };

  const tuneProposalFromInput = (request: StageRequestEnvelope): ValidatedContract<TuneProposal> => {
    const receiptArtifact = request.inputArtifacts?.find((entry) => entry.kind === "standard_receipt");
    let candidate: unknown;
    if (receiptArtifact) {
      const receipt = typedReceiptFromInput(request, "tune_proposal");
      candidate = receipt.payload.proposal;
    } else {
      const stageArtifact = request.inputArtifacts?.find((entry) => entry.kind === "stage_result");
      const wrapper = stageArtifact
        ? JSON.parse(stageArtifact.payload) as { details?: { proposal?: unknown } }
        : undefined;
      candidate = wrapper?.details?.proposal;
    }
    return validateTuneProposalContract(candidate, {
      source: `stage.${request.stageId}.proposal`,
    });
  };

  const comparableCorpusRows = (proposal: TuneProposal): ResolvedCitation[] => {
    const rows = proposal.analysis.corpus_rows.map((row) => ({
      pipeline_instance_id: row.pipeline_instance_id,
      generation: row.generation,
      execution_graph_id: row.execution_graph_id,
      outcome: row.outcome,
      closed_reason: row.closed_reason,
      fault_attribution: row.fault_attribution,
      created_at: row.created_at,
    }));
    return proposal.citation_contract.citations.map((citation) => ({
      id: citation.id,
      actual_result: rows
        .filter((row) =>
          (citation.query.skill_digest === undefined ||
            citation.query.skill_digest === proposal.analysis.intent.task.query.skill) &&
          (citation.query.outcome === undefined || row.outcome === citation.query.outcome) &&
          (citation.query.reason === undefined || row.closed_reason === citation.query.reason) &&
          (citation.query.attribution === undefined || row.fault_attribution === citation.query.attribution) &&
          (citation.query.graph === undefined || row.execution_graph_id === citation.query.graph) &&
          (citation.query.from === undefined || row.created_at >= citation.query.from) &&
          (citation.query.to === undefined || row.created_at <= citation.query.to)
        )
        .slice(0, citation.query.limit ?? 50),
    }));
  };

  const supervisorArtifact = (input: {
    request: StageRequestEnvelope;
    instance: PipelineInstance;
    outcome: "success" | "failure" | "no_change" | "needs_human" | "semantic_repair_required";
    summary: string;
    details: Record<string, unknown>;
    kind?: "stage_result" | "publish_subject";
    assurance?: "executor_verified" | "semantic_attested";
  }) => {
    const kind = input.kind ?? "stage_result";
    const assurance = input.assurance ?? "executor_verified";
    const payload = canonicalJson({
      schema: `openthrottle.artifact/${kind}@1`,
      kind,
      producer: {
        capability: input.request.capability,
        runtime_release: input.request.runtimeRelease,
        capability_digest: input.request.capabilityDigest,
        version: 1,
      },
      pipeline: { instance_id: input.instance.id, manifest_digest: input.instance.manifest_digest },
      stage: {
        id: input.request.stageId,
        attempt_id: input.request.attemptId,
        request_hash: input.request.requestHash,
        context_revision: input.request.contextRevision,
        context_policy: input.request.contextPolicy,
      },
      run: {
        id: input.request.runId,
        ticket_id: input.instance.ticket_id,
        session_id: input.instance.session_id,
        generation: input.instance.generation,
        native_session_id: input.request.nativeSessionId,
      },
      repository: {
        name: input.instance.repository,
        base_commit: input.instance.base_commit,
        subject: input.request.expectedSubject ?? input.instance.base_commit,
        pre_subject: input.request.expectedSubject ?? input.instance.base_commit,
        post_subject: input.request.expectedSubject ?? input.instance.base_commit,
      },
      assurance,
      result: input.outcome,
      summary: input.summary,
      evidence: [], findings: [], actions: [], uncertainty: [],
      started_at: now().toISOString(), completed_at: now().toISOString(),
      details: input.details,
    });
    return {
      kind,
      schemaVersion: 1,
      assurance,
      subject: input.request.expectedSubject ?? input.instance.base_commit,
      payload,
      hash: digestNormalized(payload),
    };
  };

  const executeSupervisorPublishStage = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    request: StageRequestEnvelope
  ): Promise<void> => {
    if (!deps.repositoryPublisher) throw new Error("supervisor publication is not configured");
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    if (!ticket || ticket.session_id !== instance.session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    const branch = deps.store.getTaskBranch(instance.id);
    if (!branch || branch.status !== "checkpointed" || branch.acknowledged_remote_sha === null ||
        branch.accepted_integration_sha !== branch.acknowledged_remote_sha) {
      throw new Error(`pipeline publish stage ${request.attemptId} has no acknowledged task branch checkpoint`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.ticket_id,
        runId: request.runId,
        taskType: instance.task_type,
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline publish stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    deps.store.markStageDispatched(request.attemptId);
    // Provider-repair rounds publish the same task branch through new stage
    // attempts. Bind PR ownership to the durable branch lineage so those
    // attempts reuse the existing PR instead of mistaking it for an external
    // publication.
    const ownershipMarker = `openthrottle:publish:${branch.lineage}`;
    const title = `fix: complete ${ticket.ticket_reference}`.slice(0, 72);
    const publication = await deps.repositoryPublisher.publishTaskBranch({
      repository: instance.repository,
      branch: instance.branch,
      baseBranch: ticket.base_branch,
      expectedHeadSha: branch.acknowledged_remote_sha,
      title,
      body: [
        `Publishes the exact subject accepted by OpenThrottle for ${ticket.ticket_reference}.`,
        "",
        "## OpenThrottle gates",
        "",
        "- [x] The sealed pipeline gates completed before publication.",
      ].join("\n"),
      ownershipMarker,
    });
    if (publication.sha !== branch.acknowledged_remote_sha) {
      throw new Error(`pipeline publish stage ${request.attemptId} returned an unexpected commit`);
    }
    deps.tickets.setPrUrl(instance.ticket_id, publication.url);
    const shared = {
      request,
      instance,
      outcome: "success" as const,
      assurance: "semantic_attested" as const,
      summary: "Supervisor published the exact acknowledged task branch checkpoint.",
      details: { published_commit: publication.sha, pull_request_url: publication.url },
    };
    const stageResult = supervisorArtifact(shared);
    const publishSubject = supervisorArtifact({ ...shared, kind: "publish_subject" });
    const event: PipelineCoordinatorEvent = {
      id: `supervisor-publish-${request.attemptId}-${stageResult.hash.slice(0, 16)}`,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      runId: request.runId,
      stageId: request.stageId,
      attemptId: request.attemptId,
      requestHash: request.requestHash,
      outcome: "success",
      resultHash: stageResult.hash,
      subject: stageResult.subject,
      providerRevision: publication.sha,
      nativeSessionId: request.nativeSessionId,
      artifacts: [stageResult, publishSubject],
    };
    completeStageAttemptActor(deps.store, deps.tickets, event, {
      observedSubject: stageResult.subject,
    });
    acknowledgeEffect(effect, `${event.id}:effect-ack`, {
      resultHash: stageResult.hash,
      publishedCommit: publication.sha,
      pullRequestUrl: publication.url,
    });
  };

  const executeSupervisorTuneStage = (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    request: StageRequestEnvelope
  ): void => {
    if (!deps.citationGateStore) throw new Error("supervisor tune gates are not configured");
    assertActiveAttempt(instance, request);
    deps.store.bindStageRun(request.attemptId, request.runId);
    deps.store.markStageDispatched(request.attemptId);
    const proposalContract = tuneProposalFromInput(request);
    const { value: proposal, digest: proposalDigest } = proposalContract;
    let outcome: "success" | "failure" | "no_change" | "needs_human" = "failure";
    let summary = "Tune gate rejected the proposal.";
    let details: Record<string, unknown>;
    if (request.capability === "supervisor/citation-gate@1") {
      const citationProposalDigest = digestCanonicalJson(proposal.citation_contract);
      const decision = evaluateCitationGate({
        proposal: proposal.citation_contract,
        proposalHash: citationProposalDigest,
        resolvedCitations: comparableCorpusRows(proposal),
      });
      const receipt = deps.citationGateStore.recordCitationGateDecision(decision);
      outcome = decision.outcome === "success" ? "success" : "failure";
      summary = `Supervisor citation gate ${decision.result}.`;
      details = { proposal, citation_gate: decision, citation_receipt: receipt };
    } else if (request.capability === "supervisor/differential-ratchet@1") {
      const citationInput = request.inputArtifacts?.find((entry) => entry.kind === "stage_result");
      const citationDetails = citationInput
        ? (JSON.parse(citationInput.payload) as { details?: Record<string, unknown> }).details
        : undefined;
      if (!citationDetails) throw new Error("differential ratchet is missing the supervisor citation result");
      const repositoryConfig = deps.store.getRepositoryConfigSnapshot(instance.repository_config_snapshot_id);
      if (!repositoryConfig || repositoryConfig.digest !== instance.repository_config_digest ||
          repositoryConfig.base_commit !== instance.base_commit) {
        throw new Error("differential ratchet lost its supervisor-pinned repository config");
      }
      assertTuneRatchetMaterialBinding(proposal, {
        repositoryConfig: JSON.parse(repositoryConfig.normalized_config) as RepositoryConfigContract,
      });
      const evaluation = evaluateImprovementProposalGate({
        citationGate: citationDetails.citation_gate,
        ratchetInput: proposal.ratchet_input,
      }, { citationReceipts: deps.citationGateStore });
      const ratchetDecision = evaluation.decision;
      const citationDecision = citationDetails.citation_gate as { hash?: unknown };
      if (!evaluation.accepted || !ratchetDecision || typeof citationDecision.hash !== "string") {
        details = {
          proposal,
          citation_gate: citationDetails.citation_gate,
          citation_receipt: citationDetails.citation_receipt,
          ratchet_input: proposal.ratchet_input,
          improvement_gate: evaluation.journal,
        };
      } else {
        const ratchetDecisionDigest = digestCanonicalJson(ratchetDecision);
        const decisionContract = validateTuneDecisionContract({
          schema: TUNE_DECISION_SCHEMA,
          id: `decision-${proposal.id}`,
          proposal_digest: proposalDigest,
          citation_decision_digest: citationDecision.hash,
          ratchet_decision_digest: ratchetDecisionDigest,
          outcome: "accept",
          rationale: "Supervisor citation and differential-ratchet gates passed.",
        }, { proposal, citationDecisionDigest: citationDecision.hash, ratchetDecision });
        const { value: decision, digest: decisionDigest } = decisionContract;
        const timestamp = now();
        const authorizationContract = validateTuneEditAuthorizationContract({
          schema: TUNE_EDIT_AUTHORIZATION_SCHEMA,
          id: `edit-${proposal.id}`,
          proposal_digest: proposalDigest,
          decision_digest: decisionDigest,
          authorized_paths: proposal.changes.map((change) => change.path),
          authorized_at: timestamp.toISOString(),
          expires_at: new Date(
            timestamp.getTime() + compositeStageTimeoutSeconds(instance, "structured_edit", deps.taskTimeoutSeconds) * 1_000
          ).toISOString(),
          actor_id: "openthrottle-supervisor",
        }, { proposal, decision });
        const { value: authorization, digest: authorizationDigest } = authorizationContract;
        const releaseDescriptorContract = validateTuneReleaseDescriptorContract({
          schema: TUNE_RELEASE_DESCRIPTOR_SCHEMA,
          id: `release-${proposal.id}`,
          runtime_release: instance.runtime_release,
          capability_digest: instance.capability_digest,
          contract_digests: [
            proposalDigest,
            citationDecision.hash,
            ratchetDecisionDigest,
            decisionDigest,
            authorizationDigest,
          ],
          issued_at: timestamp.toISOString(),
        });
        deps.tickets.recordTuneState({
          id: `tune-state-${proposal.id}`,
          intentId: proposal.analysis.intent.id,
          intentDigest: proposal.analysis.intent_digest,
          proposalId: proposal.id,
          proposalDigest,
          citationDecisionDigest: citationDecision.hash,
          ratchetDecisionDigest,
          editAuthorizationDigest: authorizationDigest,
          releaseDescriptorDigest: releaseDescriptorContract.digest,
          outcome: "accepted",
          payload: {
            proposal,
            decision,
            authorization,
            release_descriptor: releaseDescriptorContract.value,
            improvement_gate: evaluation.journal,
          },
        });
        outcome = "success";
        summary = "Supervisor citation and differential-ratchet gates accepted the tune proposal.";
        details = {
          proposal, decision, edit_authorization: authorization,
          citation_gate: citationDetails.citation_gate,
          citation_receipt: citationDetails.citation_receipt,
          ratchet_input: proposal.ratchet_input,
          improvement_gate: evaluation.journal,
          execution_plan: executionPlanForTuneProposal(proposal),
        };
      }
    } else {
      throw new Error(`unknown supervisor tune capability ${request.capability}`);
    }
    const artifact = supervisorArtifact({ request, instance, outcome, summary, details });
    const event: PipelineCoordinatorEvent = {
      id: `supervisor-stage-${request.attemptId}-${artifact.hash.slice(0, 16)}`,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      runId: request.runId,
      stageId: request.stageId,
      attemptId: request.attemptId,
      requestHash: request.requestHash,
      outcome,
      resultHash: artifact.hash,
      subject: artifact.subject,
      nativeSessionId: null,
      artifacts: [artifact],
    };
    completeStageAttemptActor(deps.store, deps.tickets, event, {
      observedSubject: artifact.subject,
    });
    acknowledgeEffect(effect, `${event.id}:effect-ack`, { resultHash: artifact.hash, outcome });
  };

  const automaticAdmissionContext = (
    instance: PipelineInstance,
    request: StageRequestEnvelope,
  ): AdmissionGateContext => {
    const blocks = extractJsonBlocks(request.taskContext, "openthrottle.admission-input/v1");
    if (blocks.length !== 1) throw new Error("automatic admission gate requires one sealed admission input");
    const sealed = JSON.parse(blocks[0]!) as {
      admission_basis?: {
        candidates?: Array<{ graph_id?: unknown }>;
        lock?: { graph_id?: unknown } | null;
        skills?: {
          planner?: { reference?: unknown; package_digest?: unknown };
          reviewer?: { reference?: unknown; package_digest?: unknown };
        };
      };
      admission_basis_digest?: unknown;
      effective_manifest_digest?: unknown;
    };
    if (sealed.effective_manifest_digest !== instance.manifest_digest) {
      throw new Error("automatic admission sealed effective manifest digest mismatch");
    }
    const manifest = JSON.parse(instance.normalized_manifest) as import("../pipeline/manifest.js").PipelineManifest;
    const plannerStage = manifest.stages.find((stage) => stage.id === AUTOMATIC_ADMISSION_STAGE_IDS.planner);
    const reviewerStage = manifest.stages.find((stage) => stage.id === AUTOMATIC_ADMISSION_STAGE_IDS.reviewer);
    const bindingFor = (stage: typeof plannerStage, name: "planner" | "reviewer") => {
      const configured = sealed.admission_basis?.skills?.[name];
      const skill = stage?.repositorySkill?.reference ?? stage?.loop?.skill;
      const packageDigest = stage?.repositorySkill?.packageDigest ?? null;
      if (typeof skill !== "string" || configured?.reference !== skill || configured.package_digest !== packageDigest) {
        throw new Error(`automatic admission ${name} manifest provenance mismatch`);
      }
      return { skill, packageDigest };
    };
    const candidates = (sealed.admission_basis?.candidates ?? []).map((candidate) => candidate.graph_id)
      .filter((route): route is "simple" | "structured" => route === "simple" || route === "structured");
    if (candidates.length !== 2) throw new Error("automatic admission candidate policy is incomplete");
    const lockValue = sealed.admission_basis?.lock?.graph_id;
    const lock = lockValue === "simple" || lockValue === "structured" ? lockValue : null;
    const authorizedCapabilities = JSON.parse(instance.authorized_capabilities) as string[];
    const receiptWrapper = inputArtifactPayload(request, "standard_receipt") as {
      stage?: { request_hash?: unknown };
    };
    if (typeof receiptWrapper.stage?.request_hash !== "string") {
      throw new Error("automatic admission receipt wrapper is missing its producer request fence");
    }
    let planRequestHash = receiptWrapper.stage.request_hash;
    if (request.stageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewGate) {
      const decisionWrapper = inputArtifactPayload(request, "stage_result") as {
        details?: { planner_request_hash?: unknown };
      };
      if (typeof decisionWrapper.details?.planner_request_hash !== "string") {
        throw new Error("automatic admission review gate lost the planner request fence");
      }
      planRequestHash = decisionWrapper.details.planner_request_hash;
    }
    return {
      admissionBasisDigest: String(sealed.admission_basis_digest),
      effectiveManifestDigest: instance.manifest_digest,
      requestHash: receiptWrapper.stage.request_hash,
      planRequestHash,
      subject: request.expectedSubject ?? instance.base_commit,
      candidates,
      lock,
      runtime: {
        release: instance.runtime_release,
        capabilityDigest: instance.capability_digest,
        capabilities: authorizedCapabilities,
        credentialScopes: plannerStage?.credentials ?? [],
      },
      planner: bindingFor(plannerStage, "planner"),
      reviewer: bindingFor(reviewerStage, "reviewer"),
    };
  };

  const inputArtifactPayload = (request: StageRequestEnvelope, kind: string): unknown => {
    const artifact = request.inputArtifacts?.find((entry) => entry.kind === kind);
    if (!artifact || digestNormalized(artifact.payload) !== artifact.hash) {
      throw new Error(`automatic admission gate is missing sealed ${kind}`);
    }
    return JSON.parse(artifact.payload) as unknown;
  };

  const executeSupervisorAdmissionGate = (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    request: StageRequestEnvelope,
  ): void => {
    assertActiveAttempt(instance, request);
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    if (!ticket || ticket.session_id !== instance.session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.ticket_id,
        runId: request.runId,
        taskType: instance.task_type,
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline supervisor stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    deps.store.markStageDispatched(request.attemptId);
    const context = automaticAdmissionContext(instance, request);
    let outcome: "success" | "no_change" | "semantic_repair_required" | "needs_human" | "failure";
    let summary: string;
    let details: Record<string, unknown>;
    let executionPlanArtifact: NonNullable<PipelineCoordinatorEvent["artifacts"]>[number] | undefined;
    try {
      if (request.stageId === AUTOMATIC_ADMISSION_STAGE_IDS.decisionGate) {
        const receipt = typedReceiptFromInput(request, "admission_decision", {
          missing: "automatic admission gate is missing sealed standard_receipt",
          wrongType: "automatic admission gate requires admission_decision",
        });
        const rawPlan = request.inputArtifacts?.some((entry) => entry.kind === "execution_plan")
          ? inputArtifactPayload(request, "execution_plan")
          : undefined;
        const result = evaluateAdmissionDecisionGate({ context, receipt, executionPlan: rawPlan });
        outcome = result.outcome;
        summary = `Automatic admission selected ${result.route}.`;
        details = {
          decision: result.decision,
          generated_plan_digest: result.generatedPlanDigest,
          planner_request_hash: context.requestHash,
        };
        if (result.executionPlan) {
          const payload = canonicalJson(result.executionPlan);
          executionPlanArtifact = {
            kind: "execution_plan",
            schemaVersion: 1,
            assurance: "semantic_attested",
            subject: context.subject,
            payload,
            hash: digestNormalized(payload),
          };
        }
      } else if (request.stageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewGate) {
        const decisionWrapper = inputArtifactPayload(request, "stage_result") as {
          details?: { decision?: unknown };
        };
        const result = evaluateAdmissionReviewGate({
          context,
          decision: decisionWrapper.details?.decision,
          executionPlan: inputArtifactPayload(request, "execution_plan"),
          receipt: typedReceiptFromInput(request, "admission_review", {
            missing: "automatic admission gate is missing sealed standard_receipt",
            wrongType: "automatic admission gate requires admission_review",
          }),
        });
        outcome = result.outcome;
        summary = outcome === "success"
          ? "Automatic admission review approved the exact structured plan."
          : outcome === "needs_human"
            ? "Automatic admission review requires human authority."
            : "Automatic admission review rejected the candidate plan.";
        details = { decision: result.decision, correction_owner: result.correctionOwner };
        if (outcome === "success") {
          const payload = canonicalJson(result.executionPlan);
          executionPlanArtifact = {
            kind: "execution_plan",
            schemaVersion: 1,
            assurance: "executor_verified",
            subject: context.subject,
            payload,
            hash: digestNormalized(payload),
          };
        }
      } else {
        throw new Error(`unknown automatic admission gate stage ${request.stageId}`);
      }
    } catch (error) {
      outcome = "semantic_repair_required";
      summary = `Automatic admission evidence was rejected: ${sanitizeText(String(error)).slice(0, 800)}`;
      details = { correction_owner: request.stageId === AUTOMATIC_ADMISSION_STAGE_IDS.decisionGate ? "planner" : "reviewer" };
      if (request.stageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewGate) {
        const carried = request.inputArtifacts?.find((entry) => entry.kind === "execution_plan");
        if (carried) executionPlanArtifact = { ...carried };
      }
    }
    const stageResult = supervisorArtifact({ request, instance, outcome, summary, details });
    const event: PipelineCoordinatorEvent = {
      id: `supervisor-admission-${request.attemptId}-${stageResult.hash.slice(0, 16)}`,
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      runId: request.runId,
      stageId: request.stageId,
      attemptId: request.attemptId,
      requestHash: request.requestHash,
      outcome,
      resultHash: stageResult.hash,
      subject: stageResult.subject,
      nativeSessionId: null,
      artifacts: [stageResult, ...(executionPlanArtifact ? [executionPlanArtifact] : [])],
    };
    completeStageAttemptActor(deps.store, deps.tickets, event, { observedSubject: stageResult.subject });
    acknowledgeEffect(effect, `${event.id}:effect-ack`, { resultHash: stageResult.hash, outcome });
  };

  const runtimeBindingFor = (instance: PipelineInstance): EffectRuntimeBinding => {
    const binding = deps.store.getRuntimeResource(instance.id);
    return {
      resource: binding ? { providerResourceId: binding.provider_resource_id } : undefined,
      status: binding?.status,
    };
  };

  const isCurrentIdleWait = (instanceId: string, control: IdleEffectControl): boolean => {
    const current = deps.store.getInstance(instanceId);
    const activeAttempt = deps.store.getActiveAttempt(instanceId);
    if (!current || current.active_stage_id !== control.stageId || activeAttempt?.id !== control.attemptId) {
      return false;
    }
    if (control.reason === "provider wait") return current.status === "waiting_provider";
    return current.status === "waiting_human" || current.status === "completion_pending_publication";
  };

  const idleAcknowledgementResult = (effectId: string): RuntimeEffectHandlerResult =>
    deps.store.getEffect(effectId)?.status === "dead" ? "skip_acknowledgement" : "acknowledge";

  const handleStageDispatchEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    eventId: string
  ): Promise<void> => {
    const request = effect.kind === "dispatch_stage"
      ? parseRequest(effect, deps.store)
      : parseProvisionRequest(effect, deps.store);
    if (request.capability === "supervisor/citation-gate@1" ||
        request.capability === "supervisor/differential-ratchet@1") {
      const ticket = deps.tickets.getByIssueId(instance.ticket_id);
      if (!ticket || ticket.session_id !== instance.session_id) {
        throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
      }
      if (!ticket.run_id) {
        const started = deps.tickets.beginRun({
          issueId: instance.ticket_id,
          runId: request.runId,
          taskType: instance.task_type,
          tokenHash: request.requestHash,
          expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
        });
        if (!started) throw new Error(`pipeline supervisor stage ${request.attemptId} could not acquire the ticket actor`);
      }
      executeSupervisorTuneStage(effect, instance, request);
      return;
    }
    if (request.capability === "supervisor/admission-gate@1") {
      executeSupervisorAdmissionGate(effect, instance, request);
      return;
    }
    if (request.capability === "ce/publish@1") {
      if (effect.kind === "provision") {
        acknowledgeEffect(effect, eventId, { providerDispatchId: `supervisor:${request.attemptId}` });
        return;
      }
      await executeSupervisorPublishStage(effect, instance, request);
      return;
    }
    const resource = await resourceFor(instance);
    await bootstrap(instance, resource);
    if (request.capability === FOR_EACH_UNIT_CAPABILITY) {
      if (request.pipelineInstanceId !== instance.id || request.generation !== instance.generation) {
        throw new Error(`pipeline composite request ${request.attemptId} has a stale instance fence`);
      }
      await deps.runtime.materializeCredentials(resource, request.credentialScopes);
      bindCompositeParentRun(instance, request);
      const preparedWorkspace = await deps.runtime.prepareCompositeWorkspace(resource, request);
      structuredChildren.seedCompositeGraph(instance, request, preparedWorkspace.subject);
      await structuredChildren.drainCompositeChildren(resource, instance, request.attemptId);
      acknowledgeEffect(effect, eventId, {
        providerResourceId: resource.providerResourceId,
        compositeGraphId: deps.store.getGraphForAttempt(request.attemptId)?.id ?? null,
      });
      return;
    }
    const requestedAttempt = deps.store.getAttempt(request.attemptId);
    if (effect.kind === "provision" && requestedAttempt &&
        ["completed", "canceled", "superseded", "failed"].includes(requestedAttempt.status)) {
      acknowledgeEffect(effect, eventId, {
        providerResourceId: resource.providerResourceId,
        providerDispatchId: `already-transitioned:${request.attemptId}`,
      });
      return;
    }
    const dispatched = await dispatch(instance, resource, request);
    acknowledgeEffect(effect, eventId, { providerResourceId: resource.providerResourceId, ...dispatched });
  };

  const handleStopEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    const control = parseStopEffectControl(effect);
    const ticketState = control.ticketState === "closed"
      ? "closed"
      : control.ticketState === "error"
        ? "error"
        : "stopped";
    const settlementReason = ticketState === "closed"
      ? "Pull request closed."
      : ticketState === "error"
        ? "Pipeline infrastructure failed."
        : "Pipeline stopped.";
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    const owner = `pipeline-stop:${effect.id}`;
    const currentSession = ticket?.session_id === instance.session_id;
    const activeRunId = resolveStopRunId(effect, instance, ticket, control, true);
    const boundRun = activeRunId ? deps.tickets.getRun(activeRunId) : undefined;
    if (!binding.resource && (boundRun?.status === "running" || boundRun?.status === "reaping")) {
      throw new Error(`pipeline instance ${instance.id} has an active actor without a runtime resource`);
    }
    if (activeRunId && (boundRun?.status === "running" || boundRun?.status === "reaping")) {
      const settlement = await terminateAndSettleActor({
        runtime: {
          async stopResource(sandboxId, reason) {
            const termination = await deps.runtime.stop({ providerResourceId: sandboxId }, reason);
            if (!termination.confirmed) {
              throw new Error(`pipeline runtime ${sandboxId} did not confirm termination`);
            }
          },
        },
        store: deps.tickets,
        runId: activeRunId,
        sandboxId: binding.resource && binding.status !== "stopped" && binding.status !== "cleaned"
          ? binding.resource.providerResourceId
          : null,
        owner,
        reason: "pipeline stop",
        // An operator/system-initiated stop is not a fault in any domain --
        // NULL, not the first-class 'unknown' value, which means "a fault
        // occurred but its domain could not be determined."
        faultAttribution: null,
        status: "stopped",
        ticketState: currentSession ? ticketState : undefined,
        failureTail: settlementReason,
        ticketFailureTail: settlementReason,
        prUrl: currentSession ? ticket?.pr_url ?? undefined : undefined,
        quarantineOnStopFailure: false,
        onTerminated: () => {
          deps.store.setRuntimeResourceStatus(instance.id, "stopped");
        },
      });
      const refreshedRun = deps.tickets.getRun(activeRunId);
      if (settlement.kind === "lost" && (refreshedRun?.status === "running" || refreshedRun?.status === "reaping")) {
        throw new Error(`pipeline actor ${activeRunId} lost its stop settlement claim`);
      }
    } else if (binding.resource && binding.status !== "stopped" && binding.status !== "cleaned") {
      const termination = await deps.runtime.stop(binding.resource, "pipeline stop");
      if (!termination.confirmed) {
        throw new Error(`pipeline runtime ${binding.resource.providerResourceId} did not confirm termination`);
      }
      deps.store.setRuntimeResourceStatus(instance.id, "stopped");
    }
    const projectionTicket = deps.tickets.getByIssueId(instance.ticket_id);
    if (projectionTicket?.session_id === instance.session_id) {
      // The sealed run may already have completed before this terminal stop
      // drains. Project the terminal ticket state independently from actor
      // settlement so completed actors cannot leave a failed pipeline active.
      // Refresh after the provider call so a concurrent replacement session
      // cannot receive its predecessor's terminal projection.
      deps.tickets.setState(
        projectionTicket.ticket_id,
        ticketState,
        settlementReason
      );
      deps.tickets.markSessionState(instance.session_id, "stopped");
      deps.tickets.cancelPendingInbox(instance.ticket_id);
    }
    if (binding.resource && binding.status !== "cleaned") {
      await deps.runtime.cleanup(binding.resource);
      deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
    }
    const cleanupTicket = deps.tickets.getByIssueId(instance.ticket_id);
    if (cleanupTicket?.session_id === instance.session_id &&
        (!binding.resource || cleanupTicket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.ticket_id, null);
    }
  };

  const handleQuarantineEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    const control = JSON.parse(effect.payload) as { runId?: unknown; owner?: unknown; reason?: unknown };
    const runId = typeof control.runId === "string" ? control.runId : null;
    const owner = typeof control.owner === "string" ? control.owner : `pipeline-quarantine:${effect.id}`;
    const reason = typeof control.reason === "string" ? control.reason : "pipeline stop attempts exhausted";
    if (runId && !runMatchesInstance(runId, instance)) {
      throw new Error(`pipeline quarantine effect ${effect.id} run binding mismatch`);
    }
    if (binding.resource && binding.status !== "cleaned" && binding.status !== "stopped") {
      await deps.runtime.quarantine(binding.resource, reason);
      deps.store.setRuntimeResourceStatus(instance.id, "quarantined");
    }
    if (runId) {
      const quarantined = deps.tickets.quarantineRun(runId, owner, reason);
      const refreshed = deps.tickets.getByIssueId(instance.ticket_id);
      if (!quarantined && refreshed?.run_id === runId) {
        throw new Error(`pipeline actor ${runId} could not be quarantined by ${owner}`);
      }
    } else {
      const refreshed = deps.tickets.getByIssueId(instance.ticket_id);
      if (refreshed?.session_id === instance.session_id) {
        // A stage actor can complete before its terminal runtime stop. If
        // provider termination then exhausts there is no live run to
        // quarantine, but the current ticket must still expose the
        // infrastructure failure.
        deps.tickets.setState(instance.ticket_id, "error", reason);
      }
    }
  };

  const handleCleanupEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<void> => {
    // preserve stops the sandbox instead of deleting it: memory is released
    // while the workspace (and any unpushed work) survives for the human a
    // needs_human terminal is waiting on. The ticket keeps its sandbox link
    // so the workspace stays findable and the orphan sweep retains it.
    const preserve = (JSON.parse(effect.payload) as { preserve?: boolean }).preserve === true;
    if (binding.resource && binding.status !== "cleaned") {
      if (preserve) {
        await deps.runtime.stop(binding.resource, "pipeline needs a human decision; the workspace is preserved");
        deps.store.setRuntimeResourceStatus(instance.id, "stopped");
      } else {
        await deps.runtime.cleanup(binding.resource);
        deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
      }
    }
    const ticket = deps.tickets.getByIssueId(instance.ticket_id);
    if (!preserve && ticket?.session_id === instance.session_id &&
        (!binding.resource || ticket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.ticket_id, null);
    }
  };

  const handleIdleEffect = async (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ): Promise<RuntimeEffectHandlerResult> => {
    const control = parseIdleEffectControl(effect);
    if (!binding.resource || binding.status !== "active" || !isCurrentIdleWait(instance.id, control)) return "acknowledge";
    try {
      await deps.runtime.setIdle(binding.resource.providerResourceId);
    } catch (error) {
      console.error("[pipeline-effects] failed to idle sandbox:",
        sanitizeText(String(error)).slice(-500));
      return idleAcknowledgementResult(effect.id);
    }
    if (!isCurrentIdleWait(instance.id, control) &&
        deps.store.getRuntimeResource(instance.id)?.status === "active") {
      try {
        await deps.runtime.setActive(binding.resource.providerResourceId);
      } catch (error) {
        console.error("[pipeline-effects] failed to restore active sandbox:",
          sanitizeText(String(error)).slice(-500));
      }
    }
    return idleAcknowledgementResult(effect.id);
  };

  const runtimeHandlers: Partial<Record<PipelineEffectIntent["kind"], (
    effect: PipelineEffectIntent,
    instance: PipelineInstance,
    binding: EffectRuntimeBinding
  ) => Promise<RuntimeEffectHandlerResult>>> = {
    idle: handleIdleEffect,
    stop: async (...args) => {
      await handleStopEffect(...args);
      return "acknowledge";
    },
    quarantine: async (...args) => {
      await handleQuarantineEffect(...args);
      return "acknowledge";
    },
    cleanup: async (...args) => {
      await handleCleanupEffect(...args);
      return "acknowledge";
    },
  };

  const handle = async (effect: PipelineEffectIntent): Promise<void> => {
    const instance = deps.store.getInstance(effect.pipeline_instance_id);
    if (!instance) throw new Error(`pipeline effect ${effect.id} has no instance`);
    const eventId = `effect-ack-${effect.id}`;
    if (isTaskBranchEffect(effect)) {
      const control = parseTaskBranchEffectControl(effect, instance, deps.store);
      const result = effect.kind === "create_task_branch"
        ? await deps.repositoryWriter.createRef({
            repository: control.repository,
            ref: control.ref,
            expectedNewSha: control.expectedNewSha,
            allowExisting: effect.attempts > 1,
          })
        : await (async () => {
            const checkpointObject = deps.store.getCheckpointObject(effect.id);
            if (checkpointObject && (checkpointObject.expectedOldSha !== control.expectedOldSha ||
                checkpointObject.expectedNewSha !== control.expectedNewSha)) {
              throw new Error(`pipeline task branch effect ${effect.id} has a mismatched durable checkpoint object`);
            }
            return deps.repositoryWriter.compareAndAdvanceRef({
              repository: control.repository,
              ref: control.ref,
              expectedOldSha: control.expectedOldSha!,
              expectedNewSha: control.expectedNewSha,
              allowAlreadyAdvanced: effect.attempts > 1,
              ...(checkpointObject ? { checkpointObject: {
                payload: checkpointObject.payload,
                payloadBytes: checkpointObject.payloadBytes,
                payloadSha256: checkpointObject.payloadSha256,
                ...(checkpointObject.expectedTreeSha
                  ? { expectedTreeSha: checkpointObject.expectedTreeSha }
                  : {}),
              } } : {}),
            });
          })();
      if (result.sha !== control.expectedNewSha) {
        throw new Error(`pipeline task branch effect ${effect.id} returned an unexpected SHA`);
      }
      acknowledgeEffect(effect, eventId, result);
      return;
    }
    if (effect.kind === "provision" || effect.kind === "dispatch_stage") {
      await handleStageDispatchEffect(effect, instance, eventId);
      return;
    }
    const handler = runtimeHandlers[effect.kind];
    if (!handler) throw new Error(`pipeline effect kind ${effect.kind} has no runtime handler`);
    const binding = runtimeBindingFor(instance);
    const result = await handler(effect, instance, binding);
    if (result === "skip_acknowledgement") return;
    acknowledgeEffect(effect, eventId, {
      providerResourceId: binding.resource?.providerResourceId ?? null,
      confirmed: true,
    });
  };

  const drainActiveCompositeGraphs = async (): Promise<void> => {
    const tickets = deps.tickets.listRunning();
    for (const ticket of tickets) {
      // One ticket's failing drain must not abort the rest of this cycle;
      // its own graph retries on the next tick.
      try {
        const instance = deps.store.getInstanceForSession(ticket.session_id);
        if (!instance || ticket.run_id === null) continue;
        const attempt = deps.store.getActiveAttempt(instance.id);
        if (!attempt || attempt.run_id !== ticket.run_id || attempt.status === "completed") continue;
        const stage = stageById(instance.normalized_manifest, instance.active_stage_id);
        if (!stage || stage.executor.capability !== FOR_EACH_UNIT_CAPABILITY) continue;
        const binding = runtimeBindingFor(instance);
        if (!binding.resource || binding.status !== "active") continue;
        if (!structuredChildren.compositeGraphNeedsDrain(attempt.id)) continue;
        await deps.runtime.setActive(binding.resource.providerResourceId);
        await structuredChildren.drainCompositeChildren(binding.resource, instance, attempt.id);
      } catch (error) {
        console.error(`[pipeline-effects] composite child drain failed for ticket ${ticket.ticket_id}:`,
          sanitizeText(String(error)).slice(-500));
      }
    }
  };

  const enqueueCapacityWaitActivity = (effect: PipelineEffectIntent, message: string): void => {
    try {
      const id = `capacity-wait:${effect.id}`;
      const instance = deps.store.getInstance(effect.pipeline_instance_id);
      if (!instance) return;
      const holding = sanitizeText(message).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      deps.tickets.enqueueLinearOutbox({
        id,
        sessionId: instance.session_id,
        issueId: instance.ticket_id,
        kind: "activity",
        payload: JSON.stringify({
          type: "activity",
          activity: {
            sessionId: instance.session_id,
            type: "response",
            body: `This run is waiting on sandbox capacity. Daytona is holding it because ${holding || "capacity is not available"}. OpenThrottle will retry automatically.`,
          },
        }),
      });
    } catch (activityError) {
      console.error("[pipeline-effects] failed to enqueue capacity wait activity:",
        sanitizeText(String(activityError)).slice(-500));
    }
  };

  const processClaimed = async (effect: PipelineEffectIntent): Promise<void> => {
    try {
      await handle(effect);
    } catch (error) {
      const observed = serializeRuntimeObservationError(
        `pipeline effect ${effect.kind}`,
        error
      );
      const message = observed.text.slice(-2_000);
      const errorClass = classifyEffectError(error, observed);
      // Stop settlement keeps its full retry budget: exhausting it early would
      // reroute live actors into quarantine on the first provider auth blip.
      const exhausted = ((errorClass === "auth" || errorClass === "permanent") && effect.kind !== "stop") ||
        effect.attempts >= MAX_EFFECT_ATTEMPTS;
      if (!exhausted && errorClass === "capacity") {
        try {
          await reconcileRuntimeResources({
            cutoffIso: new Date(now().getTime() - deps.runtimeResourceRetentionMinutes * 60_000).toISOString(),
            limit: HOT_PATH_RECLAIM_LIMIT,
            trigger: "capacity-constrained effect drain",
            waitTimeoutMs: HOT_PATH_RECLAIM_WAIT_TIMEOUT_MS,
          });
        } catch (reclaimError) {
          console.error("[pipeline-effects] runtime resource reconciliation failed:",
            sanitizeText(String(reclaimError)).slice(-500));
        }
      }
      const retryAt = exhausted
        ? null
        : errorClass === "capacity"
          ? new Date(now().getTime() + CAPACITY_RETRY_MS).toISOString()
          : new Date(now().getTime() + exponentialBackoffDelayMs(effect.attempts, {
              baseDelayMs: RETRY_BASE_MS,
              maxDelayMs: MAX_RETRY_DELAY_MS,
            })).toISOString();
      if (!exhausted && errorClass === "capacity") enqueueCapacityWaitActivity(effect, message);
      if (exhausted && (effect.kind === "provision" || effect.kind === "dispatch_stage")) {
        const instance = deps.store.getInstance(effect.pipeline_instance_id);
        const attempt = instance ? deps.store.getActiveAttempt(instance.id) : undefined;
        if (instance && attempt) {
          const payload = canonicalJson({
            schema: "openthrottle.pipeline-effect-failure/v1",
            effect_id: effect.id,
            effect_kind: effect.kind,
            error: message,
          });
          coordinatePipelineEvent(deps.store, {
            id: `pipeline-effect-exhausted:${effect.id}`,
            kind: "effect_failed",
            instanceId: instance.id,
            generation: instance.generation,
            ...(attempt.run_id ? { runId: attempt.run_id } : {}),
            stageId: attempt.stage_id,
            attemptId: attempt.id,
            requestHash: attempt.request_hash,
            outcome: "retryable_infrastructure_failure",
            resultHash: digestNormalized(payload),
            subject: attempt.expected_subject ?? instance.immutable_subject,
            nativeSessionId: attempt.native_session_id,
            exhaustedEffectId: effect.id,
            exhaustedEffectError: message,
          });
          return;
        }
      }
      if (exhausted && effect.kind === "stop") {
        const instance = deps.store.getInstance(effect.pipeline_instance_id);
        const ticket = instance ? deps.tickets.getByIssueId(instance.ticket_id) : undefined;
        let control: StopEffectControl;
        try {
          control = parseStopEffectControl(effect);
        } catch {
          // Deterministically malformed durable intents must still leave the
          // processing state on their final attempt. Recover only the current
          // ticket candidate, which is independently fenced below.
          control = { runId: undefined, ticketState: undefined };
        }
        let runId = instance
          ? resolveStopRunId(effect, instance, ticket, control, false)
          : null;
        const owner = `pipeline-stop:${effect.id}`;
        // Same rationale as handleStopEffect above: a stop is not a fault in
        // any domain, exhausted retries or not -- NULL, not 'unknown'.
        if (runId && !deps.tickets.claimRunForReaping(runId, owner, "pipeline stop exhausted", null)) {
          runId = null;
        }
        deps.store.markStopEffectExhausted({
          effectId: effect.id,
          error: message,
          runId,
          owner,
        });
        return;
      }
      deps.store.markEffectFailed(effect.id, message, retryAt);
    }
  };

  const processClaimedBatch = async (effects: PipelineEffectIntent[]): Promise<void> => {
    if (effects.some((effect) =>
      effect.kind === "create_task_branch" || effect.kind === "advance_task_branch"
    )) {
      for (const effect of effects) await processClaimed(effect);
      return;
    }
    await Promise.all(effects.map(processClaimed));
  };

  return {
    async drain() {
      if (draining) return;
      draining = true;
      try {
        const current = now();
        const effects = deps.store.claimEffects(
          current.toISOString(),
          new Date(current.getTime() + EFFECT_LEASE_MS).toISOString()
        );
        // A checkpoint intent may materialize a 64 MiB SQLite BLOB and start
        // a Git process. Keep those effects strictly serial under the 512 MiB
        // supervisor envelope; ordinary effects retain the existing bounded
        // fan-out. Branch batches are already ordered ahead of downstream
        // dispatch by the store, so serial execution preserves semantics.
        await processClaimedBatch(effects);
        // Branch effects are a pre-dispatch fence, not a scheduler tick of
        // latency. Once their durable acknowledgement commits, immediately
        // lease the now-unblocked provision/dispatch batch in this same drain.
        // A failed/dead branch remains an ordering blocker and yields no batch.
        if (effects.length > 0 && effects.every(isTaskBranchEffect)) {
          const nextEffects = deps.store.claimEffects(
            current.toISOString(),
            new Date(current.getTime() + EFFECT_LEASE_MS).toISOString()
          );
          await processClaimedBatch(nextEffects);
        }
        await drainActiveCompositeGraphs();
      } finally {
        draining = false;
      }
    },
  };
}
