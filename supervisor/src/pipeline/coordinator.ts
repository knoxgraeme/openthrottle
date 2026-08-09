import {
  canonicalJson,
  digestNormalized,
  isPipelineReentry,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineOutcome,
  type PipelineStage,
  type StageOutcome,
} from "./manifest.js";
import type {
  CoordinatorEffectWrite,
  CoordinatorArtifactWrite,
  CoordinatorGateReceiptWrite,
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineInstanceStage,
  PipelineInstanceStatus,
  PipelineStageAttempt,
  PipelineStore,
} from "./store.js";
import { buildStageRequest, plannedStageRunId } from "./stage-request.js";
import {
  accumulatedPublicationFindings,
  accumulatedPublicationRepairSource,
  buildStagePublication,
} from "./publication.js";
import type { LaunchFaultReason } from "./fault-attribution.js";

const PUBLISH_CAPABILITY = ["ce", "publish@1"].join("/");

export interface PipelineEventArtifact {
  id?: string;
  kind: string;
  schemaVersion: number;
  assurance: AssuranceClass;
  subject?: string | null;
  payload: string;
  hash: string;
}

export interface PipelineCoordinatorEvent {
  id: string;
  kind:
    | "stage_result"
    | "provider_snapshot"
    | "human_answer"
    | "effect_failed"
    | "stop"
    | "supersede";
  instanceId: string;
  generation: number;
  runId?: string;
  stageId?: string;
  attemptId: string;
  requestHash: string;
  outcome: StageOutcome;
  resultHash: string;
  subject?: string | null;
  providerRevision?: string;
  nativeSessionId?: string | null;
  // Additive/optional: only set when the sandbox classified a launch failure
  // for this stage_result (see runtime/events.ts). Read by settlement.ts to
  // derive the run's fault_attribution; it has no receipt or fencing meaning.
  faultReason?: LaunchFaultReason;
  controlTicketState?: "stopped" | "closed";
  exhaustedEffectId?: string;
  exhaustedEffectError?: string;
  artifacts?: PipelineEventArtifact[];
}

export interface PipelineReductionInput {
  manifest: PipelineManifest;
  instance: PipelineInstance;
  attempt: PipelineStageAttempt;
  stages: readonly PipelineInstanceStage[];
  event: PipelineCoordinatorEvent;
}

function terminalStatus(_outcome: PipelineOutcome): PipelineInstanceStatus {
  return "completion_pending_publication";
}

function publishLinearEffect(idempotencyKey: string): CoordinatorEffectWrite {
  return {
    kind: "publish_linear",
    idempotencyKey,
    payload: canonicalJson({ publication: "deferred_to_coordinator" }),
  };
}

function transitionFindings(value: unknown): Array<{ severity: string; code: string | null; summary: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, 20)
    .map((item) => ({
      severity: typeof item.severity === "string" ? item.severity.slice(0, 20) : "",
      code: typeof item.code === "string" ? item.code.slice(0, 100) : null,
      summary: typeof item.summary === "string" ? item.summary.slice(0, 500) : "",
    }));
}

function transitionContext(event: PipelineCoordinatorEvent, fromStage: string): string {
  const stageResult = event.artifacts?.find((artifact) => artifact.kind === "stage_result");
  const review = event.artifacts?.find((artifact) => artifact.kind === "review");
  let summary = "";
  let evidence: string[] = [];
  // The resumed native session usually remembers the findings, but that memory
  // is best-effort (compaction, lost sessions, external feedback). The sealed
  // request is the deterministic channel, so the structured findings ride it.
  let findings: ReturnType<typeof transitionFindings> = [];
  if (stageResult) {
    try {
      const payload = JSON.parse(stageResult.payload) as {
        summary?: unknown;
        evidence?: unknown;
        findings?: unknown;
      };
      if (typeof payload.summary === "string") summary = payload.summary.slice(0, 2_000);
      if (Array.isArray(payload.evidence)) {
        evidence = payload.evidence
          .filter((item): item is string => typeof item === "string")
          .slice(0, 20)
          .map((item) => item.slice(0, 1_000));
      }
      findings = transitionFindings(payload.findings);
    } catch {
      // The gate already validates typed artifact JSON. A control-event test
      // may omit it; retain only the deterministic transition metadata then.
    }
  }
  if (findings.length === 0 && review) {
    try {
      findings = transitionFindings((JSON.parse(review.payload) as { findings?: unknown }).findings);
    } catch {
      // Same rationale as above.
    }
  }
  return canonicalJson({
    from_stage: fromStage,
    event_kind: event.kind,
    outcome: event.outcome,
    summary,
    evidence,
    findings,
  });
}

function activeStage(input: PipelineReductionInput): PipelineStage {
  const stage = input.manifest.stages.find((candidate) => candidate.id === input.instance.active_stage_id);
  if (!stage) throw new Error(`active stage ${input.instance.active_stage_id ?? "<none>"} is absent from the pinned manifest`);
  if (stage.id !== input.attempt.stage_id) throw new Error("active attempt does not match the pinned stage");
  return stage;
}

function successPathIncludesPublication(manifest: PipelineManifest): boolean {
  const visited = new Set<string>();
  let current: string | undefined = manifest.entry_stage;
  while (current && !visited.has(current)) {
    const stage = manifest.stages.find((candidate) => candidate.id === current);
    if (!stage) return false;
    if (stage.executor.kind === "agent" && stage.executor.capability === PUBLISH_CAPABILITY) return true;
    if (stage.executor.kind === "provider_wait") return true;
    visited.add(current);
    current = stage.transitions.success?.to;
  }
  return false;
}

function eventHasExactPublishedSubject(input: PipelineReductionInput, stage: PipelineStage): boolean {
  if (stage.executor.kind === "provider_wait") {
    return input.instance.published_commit !== null && input.event.subject === input.instance.published_commit;
  }
  if (stage.evaluator.kind === "publish_subject") {
    return input.event.providerRevision !== undefined && input.event.subject === input.event.providerRevision;
  }
  return input.instance.published_commit !== null &&
    input.instance.immutable_subject !== null &&
    input.event.subject === input.instance.immutable_subject;
}

function shouldClearPublishedCommit(input: PipelineReductionInput): boolean {
  return input.instance.published_commit !== null &&
    input.event.providerRevision === undefined &&
    input.event.subject != null &&
    input.instance.immutable_subject != null &&
    input.event.subject !== input.instance.immutable_subject;
}

function verifyInput(input: PipelineReductionInput): PipelineStage {
  const { manifest, instance, attempt, event } = input;
  const normalized = canonicalJson(manifest);
  if (digestNormalized(normalized) !== instance.manifest_digest) throw new Error("pinned manifest digest mismatch");
  if (manifest.id !== instance.pipeline_id || manifest.version !== instance.pipeline_version) {
    throw new Error("pinned manifest identity mismatch");
  }
  if (event.instanceId !== instance.id || attempt.pipeline_instance_id !== instance.id) {
    throw new Error("pipeline event instance binding mismatch");
  }
  if (event.generation !== instance.generation) throw new Error("pipeline event generation is stale");
  if (event.attemptId !== attempt.id || event.requestHash !== attempt.request_hash) {
    throw new Error("pipeline event attempt fence mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(event.resultHash)) throw new Error("pipeline event result hash is invalid");
  if (event.kind !== "stage_result" && event.subject != null &&
      instance.immutable_subject != null && event.subject !== instance.immutable_subject) {
    throw new Error("pipeline event subject is stale");
  }
  if (instance.status === "publication_blocked" &&
      event.kind !== "stop" && event.kind !== "supersede") {
    throw new Error("pipeline publication is blocked and must be recovered before progression");
  }
  const stage = activeStage(input);
  if (event.kind === "provider_snapshot" && instance.status !== "waiting_provider") {
    throw new Error("provider feedback can re-enter only a provider-waiting instance");
  }
  if (event.kind === "human_answer" && instance.status !== "waiting_human") {
    throw new Error("a human answer can advance only a human-waiting instance");
  }
  if (event.kind === "effect_failed" && event.outcome !== "retryable_infrastructure_failure") {
    throw new Error("effect_failed must use outcome retryable_infrastructure_failure");
  }
  const controlOutcome = event.kind === "stop"
    ? "canceled"
    : event.kind === "supersede"
      ? "superseded"
      : undefined;
  if (controlOutcome && event.outcome !== controlOutcome) {
    throw new Error(`${event.kind} must use outcome ${controlOutcome}`);
  }
  if (event.kind === "provider_snapshot" && stage.executor.kind !== "provider_wait") {
    throw new Error("provider feedback requires a provider-wait stage");
  }
  if (event.kind === "human_answer" && stage.evaluator.kind !== "human") {
    throw new Error("a human answer requires a human-evaluated stage");
  }
  if (event.kind === "stage_result" &&
      (stage.executor.kind === "provider_wait" || stage.evaluator.kind === "human")) {
    throw new Error("waiting stages require their typed provider or human event");
  }
  const artifacts = event.artifacts ?? [];
  if (event.kind === "effect_failed" && artifacts.length > 0) {
    throw new Error("effect_failed cannot claim stage artifact assurance");
  }
  if (new Set(artifacts.map((artifact) => artifact.kind)).size !== artifacts.length) {
    throw new Error("pipeline event contains duplicate artifact kinds");
  }
  const expectedSubject = event.subject ?? instance.immutable_subject;
  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 1 || artifact.schemaVersion > 1_000) {
      throw new Error(`artifact ${artifact.kind} schema version is invalid`);
    }
    if (Buffer.byteLength(artifact.payload, "utf8") > 256 * 1024) {
      throw new Error(`artifact ${artifact.kind} exceeds the coordinator size limit`);
    }
    if (digestNormalized(artifact.payload) !== artifact.hash) throw new Error(`artifact ${artifact.kind} hash mismatch`);
    if (!stage.produces.some((kind) => kind === artifact.kind)) {
      throw new Error(`stage ${stage.id} did not declare artifact ${artifact.kind}`);
    }
    if (artifact.assurance !== stage.evaluator.assurance) {
      throw new Error(`artifact ${artifact.kind} has unsupported assurance ${artifact.assurance}`);
    }
    if ((artifact.subject ?? null) !== (expectedSubject ?? null)) {
      throw new Error(`artifact ${artifact.kind} subject does not match the current event subject`);
    }
  }
  if (event.kind !== "stop" && event.kind !== "supersede" && event.kind !== "effect_failed") {
    for (const required of ["stage_result", ...stage.evaluator.required_artifacts]) {
      if (!artifacts.some((artifact) => artifact.kind === required)) {
        throw new Error(`stage ${stage.id} result is missing required ${required} artifact`);
      }
    }
  }
  const stageResult = artifacts.find((artifact) => artifact.kind === "stage_result");
  if (event.kind !== "stop" && event.kind !== "supersede" && event.kind !== "effect_failed" &&
      stageResult?.hash !== event.resultHash) {
    throw new Error("pipeline event result hash does not match stage_result artifact");
  }
  if (event.providerRevision !== undefined) {
    if (event.kind !== "stage_result" || stage.evaluator.kind !== "publish_subject" ||
        !/^[a-f0-9]{40}$/.test(event.providerRevision)) {
      throw new Error("pipeline event has an invalid provider revision");
    }
    const publish = artifacts.find((artifact) => artifact.kind === "publish_subject");
    let publishedCommit: unknown;
    try {
      publishedCommit = publish
        ? (JSON.parse(publish.payload) as { details?: { published_commit?: unknown } }).details?.published_commit
        : undefined;
    } catch {
      publishedCommit = undefined;
    }
    if (publishedCommit !== event.providerRevision) {
      throw new Error("pipeline provider revision does not match publish evidence");
    }
  }
  return stage;
}

function nextAttemptFor(input: PipelineReductionInput, stage: PipelineStage, reentryOrdinal: number) {
  const attemptOrdinal = input.instance.attempt_count + 1;
  const id = `attempt-${digestNormalized(canonicalJson([
    input.instance.id, stage.id, attemptOrdinal, reentryOrdinal,
  ])).slice(0, 32)}`;
  const plannedRunId = plannedStageRunId(id);
  // Contextless results cannot mint a native session. Their attempt retains
  // the prior lineage for a later resumable stage without exposing it.
  const carriedNativeSessionId = input.attempt.native_context_policy === "none"
    ? input.attempt.native_session_id
    : input.event.nativeSessionId ?? input.attempt.native_session_id;
  const nativeSessionId = stage.context === "fresh"
    ? null
    : carriedNativeSessionId;
  const requestNativeSessionId = stage.context === "resume_required" || stage.context === "prefer_resume"
    ? nativeSessionId
    : null;
  if (!input.attempt.request_payload) throw new Error(`pipeline attempt ${input.attempt.id} has no sealed request`);
  const priorRequest = JSON.parse(input.attempt.request_payload) as { taskContext?: unknown };
  const taskContext = typeof priorRequest.taskContext === "string" ? priorRequest.taskContext : "";
  const request = buildStageRequest({
    instanceId: input.instance.id,
    manifestDigest: input.instance.manifest_digest,
    runtimeRelease: input.instance.runtime_release,
    capabilityDigest: input.instance.capability_digest,
    repositoryConfigDigest: input.instance.repository_config_digest,
    stage,
    attemptId: id,
    runId: plannedRunId,
    issueId: input.instance.linear_issue_id,
    sessionId: input.instance.linear_session_id,
    generation: input.instance.generation,
    taskType: input.instance.task_type,
    taskContext,
    transitionContext: transitionContext(input.event, input.attempt.stage_id),
    repository: input.instance.repository,
    baseCommit: input.instance.base_commit,
    baseBranch: input.instance.base_branch,
    branch: input.instance.branch,
    agent: input.instance.agent,
    contextRevision: input.attempt.context_revision + 1,
    expectedSubject: input.event.subject ?? null,
    nativeSessionId: requestNativeSessionId,
  });
  return {
    id,
    stageId: stage.id,
    attemptOrdinal,
    reentryOrdinal,
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    contextRevision: input.attempt.context_revision + 1,
    contextPolicy: stage.context,
    plannedRunId,
    expectedSubject: input.event.subject ?? null,
    nativeSessionId,
    requestPayload: canonicalJson(request),
  };
}

function artifactsFor(event: PipelineCoordinatorEvent): CoordinatorArtifactWrite[] {
  return (event.artifacts ?? []).map((artifact) => ({ ...artifact }));
}

function stopRunId(attempt: PipelineStageAttempt): string | null {
  // beginRun commits the immutable planned id before bindStageRun records the
  // attempt binding. A stop authored in that crash window must still carry the
  // actor id instead of sealing an authoritative null.
  return attempt.run_id ?? attempt.planned_run_id ?? null;
}

function terminalCleanupEffect(input: {
  instanceId: string;
  outcome: PipelineOutcome;
}): CoordinatorEffectWrite {
  return {
    id: `effect-z-cleanup-${digestNormalized(canonicalJson([
      input.instanceId,
      input.outcome,
      null,
    ])).slice(0, 32)}`,
    kind: "cleanup",
    idempotencyKey: `cleanup:${input.instanceId}:${input.outcome}`,
    payload: canonicalJson({
      pipelineInstanceId: input.instanceId,
      outcome: input.outcome,
      ...(input.outcome === "needs_human" ? { preserve: true } : {}),
    }),
  };
}

function failedTerminalStopEffect(input: {
  instanceId: string;
  idempotencyKey: string;
  runId: string | null;
}): CoordinatorEffectWrite {
  return {
    kind: "stop",
    idempotencyKey: input.idempotencyKey,
    payload: canonicalJson({
      pipelineInstanceId: input.instanceId,
      outcome: "failed",
      runId: input.runId,
      ticketState: "error",
    }),
  };
}

type IdleRuntimeReason = "provider wait" | "human wait";

function idleRuntimeEffect(input: {
  instanceId: string;
  stageId: string;
  attemptId: string;
  reason: IdleRuntimeReason;
}): CoordinatorEffectWrite {
  return {
    kind: "idle",
    idempotencyKey: `idle:${input.instanceId}:${input.stageId}:${input.attemptId}`,
    payload: canonicalJson({
      pipelineInstanceId: input.instanceId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      reason: input.reason,
    }),
  };
}

function terminalWrite(input: PipelineReductionInput & {
  eventPayloadHash: string;
  terminal: PipelineOutcome;
  publishIdempotencyKey: string;
  waitReason?: string | null;
  immutableSubject?: string | null;
  publishedCommit?: string | null;
  clearPublishedCommit?: boolean;
  cleanup?: boolean;
  effects?: CoordinatorEffectWrite[];
}): CoordinatorTransitionWrite {
  return {
    instanceId: input.instance.id,
    eventId: input.event.id,
    eventPayloadHash: input.eventPayloadHash,
    expectedVersion: input.instance.state_version,
    expectedStatus: input.instance.status,
    attemptId: input.attempt.id,
    outcome: input.event.outcome,
    resultHash: input.event.resultHash,
    nextStatus: terminalStatus(input.terminal),
    resumeStatus: input.terminal,
    terminalOutcome: input.terminal,
    nextStageId: null,
    waitReason: input.waitReason ?? (input.terminal === "needs_human" ? "pipeline requires a human decision" : null),
    immutableSubject: input.immutableSubject,
    publishedCommit: input.publishedCommit,
    clearPublishedCommit: input.clearPublishedCommit,
    artifacts: artifactsFor(input.event),
    effects: [
      publishLinearEffect(input.publishIdempotencyKey),
      ...(input.effects ?? []),
      ...(input.cleanup === false ? [] : [terminalCleanupEffect({
        instanceId: input.instance.id,
        outcome: input.terminal,
      })]),
    ],
  };
}

function attachPublicationEffects(input: {
  write: CoordinatorTransitionWrite;
  publication: string;
  instanceId: string;
  attemptId: string;
  receiptHash: string;
}): void {
  const linear = input.write.effects.find((effect) => effect.kind === "publish_linear");
  if (linear) {
    linear.payload = input.publication;
  } else {
    input.write.effects.push({
      kind: "publish_linear",
      idempotencyKey: `linear-gate:${input.instanceId}:${input.attemptId}:${input.receiptHash}`,
      payload: input.publication,
    });
  }
  input.write.effects.push({
    kind: "publish_github",
    idempotencyKey: `github-summary-update:${input.instanceId}:${input.attemptId}:${input.receiptHash}`,
    payload: input.publication,
  });
}

export function reducePipelineEvent(input: PipelineReductionInput): CoordinatorTransitionWrite {
  const stage = verifyInput(input);
  const eventPayloadHash = digestNormalized(canonicalJson(input.event));
  const transition = stage.transitions[input.event.outcome];
  if (!transition) throw new Error(`stage ${stage.id} has no transition for ${input.event.outcome}`);

  if (input.event.kind === "stop" || input.event.kind === "supersede") {
    const terminal = input.event.kind === "stop" ? "canceled" : "superseded";
    return terminalWrite({
      ...input,
      eventPayloadHash,
      terminal,
      publishIdempotencyKey: `linear-terminal:${input.instance.id}:${terminal}`,
      cleanup: false,
      effects: [{
        kind: "stop",
        idempotencyKey: `stop:${input.instance.id}:${input.instance.state_version + 1}`,
        payload: canonicalJson({
          pipelineInstanceId: input.instance.id,
          reason: input.event.kind,
          generation: input.instance.generation,
          runId: stopRunId(input.attempt),
          ticketState: input.event.controlTicketState ?? "stopped",
        }),
      }],
    });
  }

  if (transition.to) {
    const target = input.manifest.stages.find((candidate) => candidate.id === transition.to);
    if (!target) throw new Error(`transition target ${transition.to} is absent from the pinned manifest`);
    if (target.executor.kind === "provider_wait" && !input.event.subject) {
      throw new Error(`stage ${stage.id} cannot enter provider wait without an exact subject`);
    }
    const isReentry = isPipelineReentry(input.manifest, stage.id, target.id);
    const targetState = input.stages.find((candidate) => candidate.stage_id === target.id);
    if (!targetState) throw new Error(`stage state ${target.id} is absent for pipeline instance ${input.instance.id}`);
    if (isReentry && input.manifest.max_repair_rounds !== undefined &&
      input.instance.reentry_count >= input.manifest.max_repair_rounds) {
      return terminalWrite({
        ...input,
        eventPayloadHash,
        terminal: "failed",
        publishIdempotencyKey: `linear-repair-rounds-exhausted:${input.instance.id}:${input.manifest.max_repair_rounds}`,
        waitReason: `pipeline repair round limit ${input.manifest.max_repair_rounds} exhausted`,
        effects: [failedTerminalStopEffect({
          instanceId: input.instance.id,
          idempotencyKey: `stop:${input.instance.id}:repair-rounds-exhausted`,
          runId: stopRunId(input.attempt),
        })],
      });
    }
    if (isReentry && transition.max_reentries !== undefined && targetState.reentry_count >= transition.max_reentries) {
      const exhausted = transition.on_exhausted!;
      return terminalWrite({
        ...input,
        eventPayloadHash,
        terminal: exhausted,
        publishIdempotencyKey: `linear-exhausted:${input.instance.id}:${stage.id}:${targetState.reentry_count}`,
        waitReason: `re-entry exhausted at ${stage.id}`,
        effects: exhausted === "failed" ? [failedTerminalStopEffect({
          instanceId: input.instance.id,
          idempotencyKey: `stop:${input.instance.id}:reentry-exhausted`,
          runId: stopRunId(input.attempt),
        })] : [],
      });
    }
    // `max_attempts` is a whole-run safety net against starting another bounded
    // repair/retry pass. Once a pass is already moving forward, per-transition
    // re-entry caps and manifest repair-round caps are the loop bounds and the
    // coordinator must not strand a successfully repaired tree before
    // publish/provider.
    if (isReentry && input.instance.attempt_count >= input.manifest.max_attempts) {
      return terminalWrite({
        ...input,
        eventPayloadHash,
        terminal: "failed",
        publishIdempotencyKey: `linear-attempts-exhausted:${input.instance.id}:${input.manifest.max_attempts}`,
        waitReason: `pipeline attempt limit ${input.manifest.max_attempts} exhausted`,
        effects: [failedTerminalStopEffect({
          instanceId: input.instance.id,
          idempotencyKey: `stop:${input.instance.id}:attempts-exhausted`,
          runId: stopRunId(input.attempt),
        })],
      });
    }
    const reentryOrdinal = isReentry ? targetState.reentry_count + 1 : targetState.reentry_count;
    const nextAttempt = nextAttemptFor(input, target, reentryOrdinal);
    const resumeStatus: PipelineInstanceStatus = target.executor.kind === "provider_wait"
      ? "waiting_provider"
      : target.evaluator.kind === "human"
        ? "waiting_human"
        : "dispatchable";
    const nextStatus: PipelineInstanceStatus = resumeStatus === "waiting_human"
      ? "completion_pending_publication"
      : resumeStatus;
    const nextEffect = resumeStatus === "dispatchable"
      ? {
          kind: "dispatch_stage" as const,
          idempotencyKey: nextAttempt.idempotencyKey,
          payload: nextAttempt.requestPayload,
        }
      : {
          kind: "publish_linear" as const,
          idempotencyKey: `linear-wait:${input.instance.id}:${target.id}:${nextAttempt.id}`,
          payload: canonicalJson({
            pipelineInstanceId: input.instance.id,
            stageId: target.id,
            wait: resumeStatus,
          }),
        };
    const waitEffects = resumeStatus === "waiting_provider" || resumeStatus === "waiting_human"
      ? [idleRuntimeEffect({
          instanceId: input.instance.id,
          stageId: target.id,
          attemptId: nextAttempt.id,
          reason: resumeStatus === "waiting_provider" ? "provider wait" : "human wait",
        })]
      : [];
    return {
      instanceId: input.instance.id,
      eventId: input.event.id,
      eventPayloadHash,
      expectedVersion: input.instance.state_version,
      expectedStatus: input.instance.status,
      attemptId: input.attempt.id,
      outcome: input.event.outcome,
      resultHash: input.event.resultHash,
      nextStatus,
      resumeStatus: resumeStatus === nextStatus ? null : resumeStatus,
      nextStageId: target.id,
      nextStageStatus: nextStatus === "dispatchable" ? "dispatchable" : "waiting",
      waitReason: resumeStatus === "waiting_human"
        ? `human decision required at ${target.id}`
        : resumeStatus === "waiting_provider"
          ? `provider evidence required at ${target.id}`
          : null,
      immutableSubject: input.event.subject ?? null,
      publishedCommit: input.event.providerRevision ?? null,
      clearPublishedCommit: shouldClearPublishedCommit(input),
      reentryIncrement: isReentry ? 1 : 0,
      artifacts: artifactsFor(input.event),
      nextAttempt,
      effects: [nextEffect, ...waitEffects],
    };
  }

  const terminal = transition.terminal!;
  if (
    terminal === "shipped" &&
    successPathIncludesPublication(input.manifest) &&
    !eventHasExactPublishedSubject(input, stage)
  ) {
    throw new Error("publishing pipeline cannot settle shipped without exact published provider evidence");
  }
  return terminalWrite({
    ...input,
    eventPayloadHash,
    terminal,
    publishIdempotencyKey: `linear-terminal:${input.instance.id}:${terminal}`,
    immutableSubject: input.event.subject ?? null,
    publishedCommit: input.event.providerRevision ?? null,
    clearPublishedCommit: shouldClearPublishedCommit(input),
    effects: terminal === "failed" ? [failedTerminalStopEffect({
      instanceId: input.instance.id,
      idempotencyKey: `stop:${input.instance.id}:${terminal}`,
      runId: stopRunId(input.attempt),
    })] : [],
  });
}

export function coordinatePipelineEvent(
  store: PipelineStore,
  event: PipelineCoordinatorEvent,
  faultAfterWrite?: (writeCount: number) => void,
  gateReceipt?: CoordinatorGateReceiptWrite
): PipelineInstance {
  const queued = store.enqueueInboxEvent({
    id: event.id,
    instanceId: event.instanceId,
    generation: event.generation,
    kind: event.kind,
    payload: canonicalJson(event),
    subject: event.subject,
  });
  if (queued === "stale") throw new Error(`pipeline event ${event.id} is stale`);
  const instance = store.getInstance(event.instanceId);
  if (!instance) throw new Error(`unknown pipeline instance ${event.instanceId}`);
  if (queued === "consumed") return instance;
  const attempt = store.getAttempt(event.attemptId);
  if (!attempt) throw new Error(`unknown pipeline attempt ${event.attemptId}`);
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const stages = store.listStages(instance.id);
  const write = reducePipelineEvent({ manifest, instance, attempt, stages, event });
  write.exhaustedEffectId = event.exhaustedEffectId;
  write.exhaustedEffectError = event.exhaustedEffectError;
  write.gateReceipt = gateReceipt;
  // Findings and dispositions accumulate across the run. The single mutable
  // GitHub summary receipt always holds the latest full publication envelope
  // for this instance, so it is the deterministic prior-state source; the
  // per-attempt Linear ledger receipts are the fallback when it is absent.
  const receipts = store.listPublications(instance.id);
  const summaryPayloads = receipts
    .filter((receipt) => receipt.kind === "github_summary")
    .map((receipt) => receipt.payload);
  const priorPayloads = summaryPayloads.length > 0 ? summaryPayloads : receipts.map((receipt) => receipt.payload);
  const priorFindings = accumulatedPublicationFindings(priorPayloads);
  const priorRepairSourceStageId = accumulatedPublicationRepairSource(priorPayloads);
  // Once the structured stage hands off to a later stage (e.g. publish), the
  // attempt that is transitioning is no longer the one that owns the
  // execution graph, so this must resolve by instance rather than by the
  // current attempt's id or the terminal receipt would never carry it.
  const structuredExecution = store.getStructuredExecutionPublicationForInstance(instance.id);
  const publication = canonicalJson(buildStagePublication({
    instance,
    attempt,
    event,
    write,
    gateReceipt,
    resumeStatus: write.resumeStatus ?? null,
    priorFindings,
    priorRepairSourceStageId,
    structuredExecution,
  }));
  attachPublicationEffects({
    write,
    publication,
    instanceId: instance.id,
    attemptId: attempt.id,
    receiptHash: gateReceipt?.hash ?? event.resultHash,
  });
  return store.applyTransition(write, faultAfterWrite);
}
