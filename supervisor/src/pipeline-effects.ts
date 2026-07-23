import type { TicketStore } from "./db.js";
import { canonicalJson } from "./pipeline-manifest.js";
import { digestNormalized } from "./pipeline-manifest.js";
import { coordinatePipelineEvent } from "./pipeline-coordinator.js";
import type { PipelineEffectIntent, PipelineInstance, PipelineStore } from "./pipeline-store.js";
import type { RuntimeResource, SandboxRuntime, StageRequestEnvelope } from "./sandbox-runtime.js";
import { sanitizeText } from "./sanitize.js";

const EFFECT_LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const MAX_EFFECT_ATTEMPTS = 8;

export interface PipelineEffectProcessor {
  drain(): Promise<void>;
}

interface PipelineEffectProcessorDeps {
  store: PipelineStore;
  tickets: TicketStore;
  runtime: SandboxRuntime;
  taskTimeoutSeconds: number;
  now?: () => Date;
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

export function createPipelineEffectProcessor(deps: PipelineEffectProcessorDeps): PipelineEffectProcessor {
  const now = deps.now ?? (() => new Date());
  let draining = false;

  const assertActiveAttempt = (instance: PipelineInstance, request: StageRequestEnvelope): void => {
    const current = deps.store.getInstance(instance.id);
    const attempt = deps.store.getActiveAttempt(instance.id);
    if (!current || !["pending", "dispatchable", "running"].includes(current.status) ||
        !attempt || attempt.id !== request.attemptId) {
      throw new Error(`pipeline stage request ${request.attemptId} is no longer active`);
    }
  };

  const resourceFor = async (instance: PipelineInstance): Promise<RuntimeResource> => {
    const existing = deps.store.getRuntimeResource(instance.id);
    if (existing) {
      if (existing.status !== "active") {
        throw new Error(`pipeline runtime ${existing.provider_resource_id} is ${existing.status} and cannot dispatch`);
      }
      return { providerResourceId: existing.provider_resource_id };
    }
    const resource = await deps.runtime.provision({
      idempotencyKey: `provision:${instance.id}`,
      repository: instance.repository,
      baseCommit: instance.base_commit,
      runtimeRelease: instance.runtime_release,
    });
    deps.store.bindRuntimeResource(instance.id, "daytona", resource.providerResourceId);
    deps.tickets.setSandboxId(instance.linear_issue_id, resource.providerResourceId);
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
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (!ticket || ticket.linear_session_id !== instance.linear_session_id) {
      throw new Error(`pipeline instance ${instance.id} has no current ticket binding`);
    }
    await deps.runtime.materializeCredentials(resource, request.credentialScopes);
    assertActiveAttempt(instance, request);
    if (ticket.run_id && ticket.run_id !== request.runId) {
      throw new Error(`ticket ${ticket.linear_issue_identifier} already has active actor ${ticket.run_id}`);
    }
    if (!ticket.run_id) {
      const started = deps.tickets.beginRun({
        issueId: instance.linear_issue_id,
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

  const handle = async (effect: PipelineEffectIntent): Promise<void> => {
    const instance = deps.store.getInstance(effect.pipeline_instance_id);
    if (!instance) throw new Error(`pipeline effect ${effect.id} has no instance`);
    const eventId = `effect-ack-${effect.id}`;
    if (effect.kind === "provision" || effect.kind === "dispatch_stage") {
      const resource = await resourceFor(instance);
      await bootstrap(instance, resource);
      const request = effect.kind === "dispatch_stage"
        ? parseRequest(effect, deps.store)
        : parseProvisionRequest(effect, deps.store);
      const requestedAttempt = deps.store.getAttempt(request.attemptId);
      if (effect.kind === "provision" && requestedAttempt &&
          ["completed", "canceled", "superseded", "failed"].includes(requestedAttempt.status)) {
        deps.store.recordEffectAcknowledgement({
          effectId: effect.id,
          eventId,
          payload: canonicalJson({
            providerResourceId: resource.providerResourceId,
            providerDispatchId: `already-transitioned:${request.attemptId}`,
          }),
        });
        return;
      }
      const dispatched = await dispatch(instance, resource, request);
      deps.store.recordEffectAcknowledgement({
        effectId: effect.id,
        eventId,
        payload: canonicalJson({ providerResourceId: resource.providerResourceId, ...dispatched }),
      });
      return;
    }
    const binding = deps.store.getRuntimeResource(instance.id);
    const resource = binding ? { providerResourceId: binding.provider_resource_id } : undefined;
    if (effect.kind === "stop") {
      const control = JSON.parse(effect.payload) as { ticketState?: unknown };
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
      const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
      const owner = `pipeline-stop:${effect.id}`;
      const activeRunId = ticket?.linear_session_id === instance.linear_session_id ? ticket.run_id : null;
      if (activeRunId) {
        const claimed = deps.tickets.claimRunForReaping(activeRunId, owner, "pipeline stop");
        if (!claimed) {
          const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
          if (refreshed?.run_id === activeRunId) {
            throw new Error(`pipeline actor ${activeRunId} is owned by another settlement worker`);
          }
        }
      }
      if (!resource && ticket?.linear_session_id === instance.linear_session_id && ticket.run_id) {
        throw new Error(`pipeline instance ${instance.id} has an active actor without a runtime resource`);
      }
      if (resource && binding?.status !== "stopped" && binding?.status !== "cleaned") {
        const termination = await deps.runtime.stop(resource, "pipeline stop");
        if (!termination.confirmed) {
          throw new Error(`pipeline runtime ${resource.providerResourceId} did not confirm termination`);
        }
        deps.store.setRuntimeResourceStatus(instance.id, "stopped");
      }
      if (ticket?.linear_session_id === instance.linear_session_id) {
        if (activeRunId) {
          const settled = deps.tickets.finishReapingRun({
            runId: activeRunId,
            owner,
            status: "stopped",
            ticketState,
            failureTail: settlementReason,
            prUrl: ticket.pr_url ?? undefined,
          });
          const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
          if (!settled && refreshed?.run_id === activeRunId) {
            throw new Error(`pipeline actor ${activeRunId} lost its stop settlement claim`);
          }
        } else {
          deps.tickets.setState(
            ticket.linear_issue_id,
            ticketState,
            settlementReason
          );
        }
        deps.tickets.markSessionState(instance.linear_session_id, "stopped");
        deps.tickets.cancelPendingInbox(instance.linear_issue_id);
      }
      if (resource && binding?.status !== "cleaned") {
        await deps.runtime.cleanup(resource);
        deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
      }
      if (ticket?.linear_session_id === instance.linear_session_id &&
          (!resource || ticket.sandbox_id === resource.providerResourceId)) {
        deps.tickets.setSandboxId(instance.linear_issue_id, null);
      }
    } else if (effect.kind === "quarantine") {
      const control = JSON.parse(effect.payload) as { runId?: unknown; owner?: unknown; reason?: unknown };
      const runId = typeof control.runId === "string" ? control.runId : null;
      const owner = typeof control.owner === "string" ? control.owner : `pipeline-quarantine:${effect.id}`;
      const reason = typeof control.reason === "string" ? control.reason : "pipeline stop attempts exhausted";
      if (resource && binding?.status !== "cleaned" && binding?.status !== "stopped") {
        await deps.runtime.quarantine(resource, reason);
        deps.store.setRuntimeResourceStatus(instance.id, "quarantined");
      }
      if (runId) {
        const quarantined = deps.tickets.quarantineRun(runId, owner, reason);
        const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
        if (!quarantined && refreshed?.run_id === runId) {
          throw new Error(`pipeline actor ${runId} could not be quarantined by ${owner}`);
        }
      }
    } else if (effect.kind === "cleanup") {
      if (resource && binding?.status !== "cleaned") {
        await deps.runtime.cleanup(resource);
        deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
      }
      const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
      if (ticket?.linear_session_id === instance.linear_session_id &&
          (!resource || ticket.sandbox_id === resource.providerResourceId)) {
        deps.tickets.setSandboxId(instance.linear_issue_id, null);
      }
    } else {
      throw new Error(`pipeline effect kind ${effect.kind} has no runtime handler`);
    }
    deps.store.recordEffectAcknowledgement({
      effectId: effect.id,
      eventId,
      payload: canonicalJson({ providerResourceId: resource?.providerResourceId ?? null, confirmed: true }),
    });
  };

  const processClaimed = async (effect: PipelineEffectIntent): Promise<void> => {
    try {
      await handle(effect);
    } catch (error) {
      const message = sanitizeText(String(error)).slice(-2_000);
      const exhausted = effect.attempts >= MAX_EFFECT_ATTEMPTS;
      const retryAt = exhausted
        ? null
        : new Date(now().getTime() + RETRY_BASE_MS * 2 ** Math.min(effect.attempts - 1, 6)).toISOString();
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
        const ticket = instance ? deps.tickets.getByIssueId(instance.linear_issue_id) : undefined;
        const runId = ticket && instance && ticket.linear_session_id === instance.linear_session_id
          ? ticket.run_id
          : null;
        deps.store.markStopEffectExhausted({
          effectId: effect.id,
          error: message,
          runId,
          owner: `pipeline-stop:${effect.id}`,
        });
        return;
      }
      deps.store.markEffectFailed(effect.id, message, retryAt);
    }
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
        await Promise.all(effects.map(processClaimed));
      } finally {
        draining = false;
      }
    },
  };
}
