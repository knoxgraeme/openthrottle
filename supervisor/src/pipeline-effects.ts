import { randomBytes } from "node:crypto";
import type { TicketStore } from "./db.js";
import { canonicalJson } from "./pipeline-manifest.js";
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
  callbackGraceSeconds: number;
  now?: () => Date;
}

function unusedCallbackTokenHash(): string {
  // Pipeline stages settle through the root-owned result spool, not the
  // legacy callback endpoint. Retain an unguessable, unmaterialized hash so a
  // run row can never acquire a callback credential derived from public IDs.
  return randomBytes(32).toString("hex");
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
        tokenHash: unusedCallbackTokenHash(),
        expiresAt: new Date(now().getTime() +
          (deps.taskTimeoutSeconds + deps.callbackGraceSeconds) * 1_000).toISOString(),
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
      const ticketState = control.ticketState === "closed" ? "closed" : "stopped";
      const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
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
        if (ticket.run_id) {
          const settlement = {
            runId: ticket.run_id,
            status: "stopped",
            ticketState,
            failureTail: ticketState === "closed" ? "Pull request closed." : "Pipeline stopped.",
            prUrl: ticket.pr_url ?? undefined,
          } as const;
          if (!deps.tickets.finishRun(settlement)) {
            deps.tickets.settleQuarantinedRun(settlement);
          }
        } else {
          deps.tickets.setState(
            ticket.linear_issue_id,
            ticketState,
            ticketState === "closed" ? "Pull request closed." : "Pipeline stopped."
          );
        }
        deps.tickets.markSessionState(instance.linear_session_id, "stopped");
        deps.tickets.cancelPendingSessionWork(instance.linear_session_id);
        deps.tickets.cancelPendingInbox(instance.linear_issue_id);
      }
    } else if (effect.kind === "quarantine") {
      if (!resource) throw new Error(`pipeline instance ${instance.id} has no runtime resource`);
      await deps.runtime.quarantine(resource, "pipeline quarantine");
      deps.store.setRuntimeResourceStatus(instance.id, "quarantined");
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
      const retryAt = effect.attempts >= MAX_EFFECT_ATTEMPTS
        ? null
        : new Date(now().getTime() + RETRY_BASE_MS * 2 ** Math.min(effect.attempts - 1, 6)).toISOString();
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
        for (const effect of effects) await processClaimed(effect);
      } finally {
        draining = false;
      }
    },
  };
}
