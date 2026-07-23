import {
  canonicalJson,
  digestNormalized,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineOutcome,
  type PipelineStage,
  type StageOutcome,
} from "./pipeline-manifest.js";
import type {
  CoordinatorArtifactWrite,
  CoordinatorGateReceiptWrite,
  CoordinatorTransitionWrite,
  PipelineInstance,
  PipelineInstanceStage,
  PipelineInstanceStatus,
  PipelineStageAttempt,
  PipelineStore,
} from "./pipeline-store.js";
import { buildStageRequest } from "./pipeline-store.js";
import { buildStagePublication } from "./pipeline-publication.js";

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

function transitionContext(event: PipelineCoordinatorEvent, fromStage: string): string {
  const stageResult = event.artifacts?.find((artifact) => artifact.kind === "stage_result");
  let summary = "";
  let evidence: string[] = [];
  if (stageResult) {
    try {
      const payload = JSON.parse(stageResult.payload) as { summary?: unknown; evidence?: unknown };
      if (typeof payload.summary === "string") summary = payload.summary.slice(0, 2_000);
      if (Array.isArray(payload.evidence)) {
        evidence = payload.evidence
          .filter((item): item is string => typeof item === "string")
          .slice(0, 20)
          .map((item) => item.slice(0, 1_000));
      }
    } catch {
      // The gate already validates typed artifact JSON. A control-event test
      // may omit it; retain only the deterministic transition metadata then.
    }
  }
  return canonicalJson({
    from_stage: fromStage,
    event_kind: event.kind,
    outcome: event.outcome,
    summary,
    evidence,
  });
}

function activeStage(input: PipelineReductionInput): PipelineStage {
  const stage = input.manifest.stages.find((candidate) => candidate.id === input.instance.active_stage_id);
  if (!stage) throw new Error(`active stage ${input.instance.active_stage_id ?? "<none>"} is absent from the pinned manifest`);
  if (stage.id !== input.attempt.stage_id) throw new Error("active attempt does not match the pinned stage");
  return stage;
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
  const plannedRunId = `run-${digestNormalized(canonicalJson([id, "stage-execution"])).slice(0, 32)}`;
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
    nativeSessionId: input.event.nativeSessionId ?? null,
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
    nativeSessionId: input.event.nativeSessionId ?? null,
    requestPayload: canonicalJson(request),
  };
}

function artifactsFor(event: PipelineCoordinatorEvent): CoordinatorArtifactWrite[] {
  return (event.artifacts ?? []).map((artifact) => ({ ...artifact }));
}

export function reducePipelineEvent(input: PipelineReductionInput): CoordinatorTransitionWrite {
  const stage = verifyInput(input);
  const eventPayloadHash = digestNormalized(canonicalJson(input.event));
  const transition = stage.transitions[input.event.outcome];
  if (!transition) throw new Error(`stage ${stage.id} has no transition for ${input.event.outcome}`);

  if (input.event.kind === "stop" || input.event.kind === "supersede") {
    const terminal = input.event.kind === "stop" ? "canceled" : "superseded";
    const payload = canonicalJson({
      pipelineInstanceId: input.instance.id,
      reason: input.event.kind,
      generation: input.instance.generation,
      runId: input.attempt.run_id ?? null,
      ticketState: input.event.controlTicketState ?? "stopped",
    });
    return {
      instanceId: input.instance.id,
      eventId: input.event.id,
      eventPayloadHash,
      expectedVersion: input.instance.state_version,
      expectedStatus: input.instance.status,
      attemptId: input.attempt.id,
      outcome: input.event.outcome,
      resultHash: input.event.resultHash,
      nextStatus: terminalStatus(terminal),
      terminalOutcome: terminal,
      nextStageId: null,
      artifacts: artifactsFor(input.event),
      effects: [
        {
          kind: "stop",
          idempotencyKey: `stop:${input.instance.id}:${input.instance.state_version + 1}`,
          payload,
        },
        {
          kind: "publish_linear",
          idempotencyKey: `linear-terminal:${input.instance.id}:${terminal}`,
          payload: canonicalJson({ pipelineInstanceId: input.instance.id, outcome: terminal }),
        },
      ],
    };
  }

  if (transition.to) {
    const target = input.manifest.stages.find((candidate) => candidate.id === transition.to);
    if (!target) throw new Error(`transition target ${transition.to} is absent from the pinned manifest`);
    if (target.executor.kind === "provider_wait" && !input.event.subject) {
      throw new Error(`stage ${stage.id} cannot enter provider wait without an exact subject`);
    }
    const isReentry = target.id === stage.id ||
      input.manifest.stages.findIndex((candidate) => candidate.id === target.id) <=
        input.manifest.stages.findIndex((candidate) => candidate.id === stage.id);
    const targetState = input.stages.find((candidate) => candidate.stage_id === target.id);
    if (!targetState) throw new Error(`stage state ${target.id} is absent for pipeline instance ${input.instance.id}`);
    if (isReentry && transition.max_reentries !== undefined && targetState.reentry_count >= transition.max_reentries) {
      const exhausted = transition.on_exhausted!;
      return {
        instanceId: input.instance.id,
        eventId: input.event.id,
        eventPayloadHash,
        expectedVersion: input.instance.state_version,
        expectedStatus: input.instance.status,
        attemptId: input.attempt.id,
        outcome: input.event.outcome,
        resultHash: input.event.resultHash,
        nextStatus: terminalStatus(exhausted),
        terminalOutcome: exhausted,
        nextStageId: null,
        waitReason: `re-entry exhausted at ${stage.id}`,
        artifacts: artifactsFor(input.event),
        effects: [
          {
            kind: "publish_linear",
            idempotencyKey: `linear-exhausted:${input.instance.id}:${stage.id}:${targetState.reentry_count}`,
            payload: canonicalJson({ pipelineInstanceId: input.instance.id, stageId: stage.id, outcome: exhausted }),
          },
          ...(exhausted === "failed" ? [{
            kind: "stop" as const,
            idempotencyKey: `stop:${input.instance.id}:reentry-exhausted`,
            payload: canonicalJson({
              pipelineInstanceId: input.instance.id,
              outcome: exhausted,
              runId: input.attempt.run_id ?? null,
              ticketState: "error",
            }),
          }] : []),
        ],
      };
    }
    if (input.instance.attempt_count >= input.manifest.max_attempts) {
      return {
        instanceId: input.instance.id,
        eventId: input.event.id,
        eventPayloadHash,
        expectedVersion: input.instance.state_version,
        expectedStatus: input.instance.status,
        attemptId: input.attempt.id,
        outcome: input.event.outcome,
        resultHash: input.event.resultHash,
        nextStatus: terminalStatus("failed"),
        terminalOutcome: "failed",
        nextStageId: null,
        waitReason: `pipeline attempt limit ${input.manifest.max_attempts} exhausted`,
        artifacts: artifactsFor(input.event),
        effects: [
          {
            kind: "publish_linear",
            idempotencyKey: `linear-attempts-exhausted:${input.instance.id}:${input.manifest.max_attempts}`,
            payload: canonicalJson({
              pipelineInstanceId: input.instance.id,
              stageId: stage.id,
              outcome: "failed",
              reason: "attempts_exhausted",
            }),
          },
          {
            kind: "stop",
            idempotencyKey: `stop:${input.instance.id}:attempts-exhausted`,
            payload: canonicalJson({
              pipelineInstanceId: input.instance.id,
              outcome: "failed",
              runId: input.attempt.run_id ?? null,
              ticketState: "error",
            }),
          },
        ],
      };
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
          idempotencyKey: `linear-wait:${input.instance.id}:${target.id}:${nextAttempt.reentryOrdinal}`,
          payload: canonicalJson({
            pipelineInstanceId: input.instance.id,
            stageId: target.id,
            wait: resumeStatus,
          }),
        };
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
      nextStageId: target.id,
      nextStageStatus: nextStatus === "dispatchable" ? "dispatchable" : "waiting",
      waitReason: resumeStatus === "waiting_human"
        ? `human decision required at ${target.id}`
        : resumeStatus === "waiting_provider"
          ? `provider evidence required at ${target.id}`
          : null,
      immutableSubject: input.event.subject ?? null,
      publishedCommit: input.event.providerRevision ?? null,
      reentryIncrement: isReentry ? 1 : 0,
      artifacts: artifactsFor(input.event),
      nextAttempt,
      effects: [nextEffect],
    };
  }

  const terminal = transition.terminal!;
  const terminalEffects: CoordinatorTransitionWrite["effects"] = [{
    kind: "publish_linear",
    idempotencyKey: `linear-terminal:${input.instance.id}:${terminal}`,
    payload: canonicalJson({
      pipelineInstanceId: input.instance.id,
      pipeline: `${input.instance.pipeline_id}@${input.instance.pipeline_version}`,
      outcome: terminal,
      subject: input.event.subject ?? input.instance.immutable_subject,
    }),
  }];
  if (terminal === "shipped" || terminal === "no_change") {
    terminalEffects.push({
      kind: "cleanup",
      idempotencyKey: `cleanup:${input.instance.id}:${terminal}`,
      payload: canonicalJson({ pipelineInstanceId: input.instance.id, outcome: terminal }),
    });
  } else if (terminal === "failed") {
    terminalEffects.push({
      kind: "stop",
      idempotencyKey: `stop:${input.instance.id}:${terminal}`,
      payload: canonicalJson({
        pipelineInstanceId: input.instance.id,
        outcome: terminal,
        runId: input.attempt.run_id ?? null,
        ticketState: "error",
      }),
    });
  }
  return {
    instanceId: input.instance.id,
    eventId: input.event.id,
    eventPayloadHash,
    expectedVersion: input.instance.state_version,
    expectedStatus: input.instance.status,
    attemptId: input.attempt.id,
    outcome: input.event.outcome,
    resultHash: input.event.resultHash,
    nextStatus: terminalStatus(terminal),
    terminalOutcome: terminal,
    nextStageId: null,
    waitReason: terminal === "needs_human" ? "pipeline requires a human decision" : null,
    immutableSubject: input.event.subject ?? null,
    publishedCommit: input.event.providerRevision ?? null,
    artifacts: artifactsFor(input.event),
    effects: terminalEffects,
  };
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
  const target = write.nextStageId
    ? manifest.stages.find((stage) => stage.id === write.nextStageId)
    : undefined;
  const resumeStatus: PipelineInstanceStatus | null = write.terminalOutcome
    ? write.terminalOutcome
    : target?.evaluator.kind === "human" && write.nextStatus === "completion_pending_publication"
      ? "waiting_human"
      : null;
  const publication = canonicalJson(buildStagePublication({
    instance,
    attempt,
    event,
    write,
    gateReceipt,
    resumeStatus,
  }));
  const linear = write.effects.find((effect) => effect.kind === "publish_linear");
  if (linear) linear.payload = publication;
  else write.effects.push({
    kind: "publish_linear",
    idempotencyKey: `linear-gate:${instance.id}:${attempt.id}:${gateReceipt?.hash ?? event.resultHash}`,
    payload: publication,
  });
  write.effects.push({
    kind: "publish_github",
    idempotencyKey: `github-summary-update:${instance.id}:${attempt.id}:${gateReceipt?.hash ?? event.resultHash}`,
    payload: publication,
  });
  return store.applyTransition(write, faultAfterWrite);
}
