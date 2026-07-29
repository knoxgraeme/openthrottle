import type { Ticket, SupervisorStore } from "../persistence/store.js";
import { canonicalJson, type PipelineManifest, type PipelineStage } from "../pipeline/manifest.js";
import { digestNormalized } from "../pipeline/manifest.js";
import { coordinatePipelineEvent } from "../pipeline/coordinator.js";
import type {
  ExecutionWorkAttempt,
  PipelineEffectIntent,
  PipelineInstance,
  PipelineRuntimeResource,
  PipelineStore,
} from "../pipeline/store.js";
import type { StageRequestEnvelope } from "../pipeline/stage-request.js";
import type { LoopActionRequest, RuntimeResource, SandboxAutostopRuntime, SandboxRuntime } from "../runtime/contracts.js";
import { buildAggregateStageEvent } from "../pipeline/unit-coordinator.js";
import { completeStageAttemptActor } from "../pipeline/settlement.js";
import { sanitizeText } from "../shared/sanitize.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import { createUnitEffectProcessor, type UnitEffectRuntime } from "./unit-effects.js";

const EFFECT_LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const MAX_EFFECT_ATTEMPTS = 8;
const CAPACITY_RETRY_MS = 5 * 60_000;
const UNIT_EFFECT_LEASE_MS = 60_000;
const INTEGRATION_REPO_PATH = "/home/agent/repo";
const EXECUTION_PLAN_FENCE = "openthrottle.execution-plan/v1";
const EXECUTION_PLAN_BLOCK = /```[^\n`]*\n([\s\S]*?)```/g;

// Deterministic provider failures must not burn the whole retry budget on hot
// exponential backoff. Auth failures never self-heal, so they exhaust on the
// first attempt carrying the real sanitized message. Capacity failures clear
// only when unrelated resources are released, so they retry on a fixed patient
// interval while still counting against MAX_EFFECT_ATTEMPTS.
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bunauthorized\b/,
  /\bforbidden\b/,
  /\b40[13]\b/,
  /write access to repository not granted/,
  /resource not accessible/,
  /bad credentials/,
  /\b(?:invalid|expired|revoked)\b[^\n]{0,40}\btoken\b/,
  /\btoken\b[^\n]{0,40}\b(?:invalid|expired|revoked)\b/,
];

const CAPACITY_ERROR_PATTERNS: RegExp[] = [
  /total (?:memory|disk|cpu) limit exceeded/,
  /quota exceeded/,
  /insufficient (?:memory|disk|capacity)/,
];

type EffectErrorClass = "auth" | "capacity" | "transient";
type RuntimeEffectHandlerResult = "acknowledge" | "skip_acknowledgement";

interface ExecutionPlanUnitBlock {
  id: string;
  title?: string;
  depends_on?: string[];
  instructions?: string[];
  acceptance?: string[];
}

interface ExecutionPlanBlock {
  schema: typeof EXECUTION_PLAN_FENCE;
  graph_id?: string;
  units: ExecutionPlanUnitBlock[];
  instructions?: Record<string, string>;
  acceptance?: Record<string, string>;
}

function parseExecutionPlan(taskContext: string): ExecutionPlanBlock {
  const blocks: string[] = [];
  for (const match of taskContext.matchAll(EXECUTION_PLAN_BLOCK)) {
    const json = match[1]?.trim();
    if (!json?.includes("\"schema\"") || !json.includes(EXECUTION_PLAN_FENCE)) continue;
    blocks.push(json);
  }
  if (blocks.length !== 1) {
    throw new Error(`loop-action stage expected exactly one ${EXECUTION_PLAN_FENCE} block, found ${blocks.length}`);
  }
  const parsed = JSON.parse(blocks[0]) as Partial<ExecutionPlanBlock>;
  if (parsed.schema !== EXECUTION_PLAN_FENCE ||
      !Array.isArray(parsed.units) ||
      parsed.units.length < 1 ||
      parsed.units.length > 64) {
    throw new Error("execution plan is invalid");
  }
  const seen = new Set<string>();
  const units = parsed.units.map((unit) => {
    if (!unit || typeof unit !== "object" || typeof unit.id !== "string" || unit.id.length > 120) {
      throw new Error("execution plan unit is invalid");
    }
    if (seen.has(unit.id)) throw new Error(`execution plan has duplicate unit ${unit.id}`);
    seen.add(unit.id);
    const dependsOn = Array.isArray(unit.depends_on)
      ? unit.depends_on.filter((dependency): dependency is string => typeof dependency === "string")
      : [];
    return {
      id: unit.id,
      ...(typeof unit.title === "string" ? { title: unit.title } : {}),
      depends_on: dependsOn,
      instructions: Array.isArray(unit.instructions)
        ? unit.instructions.filter((entry): entry is string => typeof entry === "string")
        : [],
      acceptance: Array.isArray(unit.acceptance)
        ? unit.acceptance.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  });
  for (const unit of units) {
    for (const dependency of unit.depends_on) {
      if (!seen.has(dependency)) throw new Error(`execution plan unit ${unit.id} depends on unknown unit ${dependency}`);
    }
  }
  return {
    schema: EXECUTION_PLAN_FENCE,
    ...(typeof parsed.graph_id === "string" ? { graph_id: parsed.graph_id } : {}),
    units,
    instructions: parsed.instructions && typeof parsed.instructions === "object" ? parsed.instructions : {},
    acceptance: parsed.acceptance && typeof parsed.acceptance === "object" ? parsed.acceptance : {},
  };
}

function stageForAttempt(instance: PipelineInstance, stageId: string): PipelineStage {
  const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`stage ${stageId} is absent from the pinned manifest`);
  return stage;
}

function createLoopRequestHash(
  request: Omit<LoopActionRequest, "requestHash" | "idempotencyKey">
): Pick<LoopActionRequest, "requestHash" | "idempotencyKey"> {
  const requestHash = digestNormalized(canonicalJson(request));
  return {
    requestHash,
    idempotencyKey: `loop:${request.attemptId}:${request.actionId}:${requestHash}`,
  };
}

function unitTransitionContext(input: {
  request: StageRequestEnvelope;
  plan: ExecutionPlanBlock;
  unit: ExecutionPlanUnitBlock;
}): string {
  const instructions = (input.unit.instructions ?? [])
    .map((id) => `- ${id}: ${input.plan.instructions?.[id] ?? ""}`)
    .join("\n");
  const acceptance = (input.unit.acceptance ?? [])
    .map((id) => `- ${id}: ${input.plan.acceptance?.[id] ?? ""}`)
    .join("\n");
  return [
    input.request.taskContext,
    "",
    `Structured execution unit: ${input.unit.id} - ${input.unit.title ?? ""}`.trim(),
    `Dependencies: ${(input.unit.depends_on ?? []).join(", ") || "none"}`,
    "",
    "Instructions:",
    instructions || "- none",
    "",
    "Acceptance:",
    acceptance || "- none",
    "",
    input.request.transitionContext,
  ].join("\n").slice(0, 64_000);
}

function loopRequestForAction(input: {
  request: StageRequestEnvelope;
  plan: ExecutionPlanBlock;
  action: ExecutionWorkAttempt;
  unit: ExecutionPlanUnitBlock;
}): LoopActionRequest {
  const contextPolicy = input.request.contextPolicy === "none"
    ? "fresh"
    : input.request.contextPolicy === "resume_required" && !input.action.native_session_id
      ? "fresh"
      : input.request.contextPolicy;
  const withoutFence: Omit<LoopActionRequest, "requestHash" | "idempotencyKey"> = {
    protocol: "loop-action@1",
    actionId: input.action.id,
    attemptId: input.action.id,
    runId: input.request.runId,
    pipelineInstanceId: input.request.pipelineInstanceId,
    graphId: input.plan.graph_id ?? input.request.manifestDigest,
    graphDigest: input.request.manifestDigest,
    unitId: input.action.unit_id,
    role: "worker",
    loop: "implement",
    agent: input.request.agent,
    skill: "implement-unit",
    worktree: { id: input.action.id, path: INTEGRATION_REPO_PATH },
    nativeSessionId: input.action.native_session_id,
    contextPolicy,
    timeoutMs: 24 * 60 * 60 * 1_000,
    transitionContext: unitTransitionContext({ request: input.request, plan: input.plan, unit: input.unit }),
    allowedMcpServers: [],
    credentialScopes: input.request.credentialScopes,
    receiptSchema: "openthrottle.receipt/v1",
  };
  return { ...withoutFence, ...createLoopRequestHash(withoutFence) };
}

function classifyEffectError(message: string): EffectErrorClass {
  const text = message.toLowerCase();
  // Capacity wins over auth: a provider may wrap a quota rejection in an HTTP
  // 403, and the broad 401/403 auth patterns would otherwise fast-fail an
  // error that clears once resources free up.
  if (CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "capacity";
  if (AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "auth";
  return "transient";
}

export interface PipelineEffectProcessor {
  drain(): Promise<void>;
}

interface PipelineEffectProcessorDeps {
  store: PipelineStore;
  tickets: SupervisorStore;
  runtime: SandboxRuntime & SandboxAutostopRuntime;
  taskTimeoutSeconds: number;
  now?: () => Date;
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

export function createPipelineEffectProcessor(deps: PipelineEffectProcessorDeps): PipelineEffectProcessor {
  const now = deps.now ?? (() => new Date());
  let draining = false;

  const runMatchesInstance = (runId: string, instance: PipelineInstance): boolean => {
    const run = deps.tickets.getRun(runId);
    const attempt = deps.store.getAttemptForRun(runId);
    return attempt?.pipeline_instance_id === instance.id &&
      (!run || (
        run.linear_issue_id === instance.linear_issue_id &&
        run.linear_session_id === instance.linear_session_id
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

  const unitRuntimeFor = (
    resource: RuntimeResource,
    request: StageRequestEnvelope,
    plan: ExecutionPlanBlock
  ): UnitEffectRuntime => ({
    async dispatchUnitAction(action) {
      const unit = plan.units.find((candidate) => candidate.id === action.unit_id);
      if (!unit) throw new Error(`execution plan unit ${action.unit_id} is absent from the sealed plan`);
      const loopRequest = loopRequestForAction({ request, plan, action, unit });
      await deps.runtime.dispatchLoopAction(resource, loopRequest);
      return {
        requestHash: loopRequest.requestHash,
        nativeSessionId: loopRequest.nativeSessionId,
      };
    },
    async collectUnitAction(action) {
      const result = await deps.runtime.collectLoopActionResult(resource, action.id);
      if (!result) return null;
      if (result.actionId !== action.id ||
          result.attemptId !== action.id ||
          result.requestHash !== action.request_hash) {
        throw new Error(`loop action ${action.id} result fence mismatch`);
      }
      const resultHash = digestNormalized(canonicalJson(result));
      if (result.outcome !== "success") {
        return {
          resultHash,
          outputSubject: result.subject,
          nativeSessionId: result.nativeSessionId,
          outcome: result.outcome,
          reason: `loop action ${action.id} returned ${result.outcome}`,
        };
      }
      if (!result.subject) {
        return {
          resultHash,
          outputSubject: null,
          nativeSessionId: result.nativeSessionId,
          outcome: "failure",
          reason: `loop action ${action.id} completed without a subject`,
        };
      }
      return {
        resultHash,
        outputSubject: result.subject,
        nativeSessionId: result.nativeSessionId,
        outcome: "success",
      };
    },
  });

  const createLoopGraph = (
    instance: PipelineInstance,
    request: StageRequestEnvelope,
    plan: ExecutionPlanBlock
  ): void => {
    deps.store.createGraph({
      pipelineInstanceId: instance.id,
      parentAttemptId: request.attemptId,
      parentStageId: request.stageId,
      parentRunId: request.runId,
      graphDigest: request.manifestDigest,
      planDigest: digestNormalized(canonicalJson(plan)),
      units: plan.units.map((unit) => ({
        id: unit.id,
        dependencies: unit.depends_on ?? [],
      })),
    });
  };

  const maybeEmitLoopAggregate = (
    instance: PipelineInstance,
    request: StageRequestEnvelope
  ): boolean => {
    const attempt = deps.store.getAttempt(request.attemptId);
    if (!attempt || attempt.status !== "running" || !attempt.run_id) return false;
    const units = deps.store.listUnits(attempt.id);
    if (units.length === 0 ||
        units.some((unit) => unit.status !== "integrated" &&
          unit.status !== "completed" &&
          unit.status !== "exited" &&
          unit.status !== "failed")) return false;
    const manifest = JSON.parse(instance.normalized_manifest) as PipelineManifest;
    const outcome = units.some((unit) => unit.status === "failed")
      ? "failure"
      : units.some((unit) => unit.status === "exited")
        ? "needs_human"
        : "success";
    const subject = [...units]
      .sort((left, right) => left.ordinal - right.ordinal || left.unitId.localeCompare(right.unitId))
      .map((unit) => unit.integrationSubject)
      .filter((value): value is string => typeof value === "string")
      .at(-1) ?? attempt.expected_subject ?? instance.immutable_subject;
    if (!subject) throw new Error(`loop-action attempt ${attempt.id} has no integrated subject`);
    const event = buildAggregateStageEvent({
      id: `unit-aggregate-${digestNormalized(canonicalJson([instance.id, attempt.id, subject])).slice(0, 32)}`,
      manifest,
      instance,
      parentAttempt: attempt,
      outcome,
      subject,
      units,
      completedAt: now().toISOString(),
    });
    const graphResult = event.artifacts?.find((artifact) => artifact.kind === "execution_graph_result");
    if (!graphResult) throw new Error(`loop-action attempt ${attempt.id} aggregate has no execution graph result`);
    const emitted = deps.store.emitAggregateOnce({
      parentAttemptId: attempt.id,
      artifactHash: graphResult.hash,
      integrationSubject: subject,
    });
    completeStageAttemptActor(deps.store, deps.tickets, event, { observedSubject: subject });
    return emitted === "emitted";
  };

  const drainLoopAttempt = async (
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
        tokenHash: request.requestHash,
        expiresAt: new Date(now().getTime() + deps.taskTimeoutSeconds * 1_000).toISOString(),
      });
      if (!started) throw new Error(`pipeline stage ${request.attemptId} could not acquire the ticket actor`);
    }
    deps.store.bindStageRun(request.attemptId, request.runId);
    const plan = parseExecutionPlan(request.taskContext);
    createLoopGraph(instance, request, plan);
    deps.store.markStageDispatched(request.attemptId);
    await createUnitEffectProcessor({
      store: deps.store,
      runtime: unitRuntimeFor(resource, request, plan),
      leaseOwner: `pipeline-loop:${request.attemptId}`,
      now,
      leaseMs: UNIT_EFFECT_LEASE_MS,
    }).drain(request.attemptId);
    maybeEmitLoopAggregate(instance, request);
    return { providerDispatchId: `loop-action:${request.attemptId}` };
  };

  const acknowledgeEffect = (effect: PipelineEffectIntent, eventId: string, payload: unknown): void => {
    deps.store.recordEffectAcknowledgement({
      effectId: effect.id,
      eventId,
      payload: canonicalJson(payload),
    });
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
    const resource = await resourceFor(instance);
    await bootstrap(instance, resource);
    const request = effect.kind === "dispatch_stage"
      ? parseRequest(effect, deps.store)
      : parseProvisionRequest(effect, deps.store);
    const requestedAttempt = deps.store.getAttempt(request.attemptId);
    if (effect.kind === "provision" && requestedAttempt &&
        ["completed", "canceled", "superseded", "failed"].includes(requestedAttempt.status)) {
      acknowledgeEffect(effect, eventId, {
        providerResourceId: resource.providerResourceId,
        providerDispatchId: `already-transitioned:${request.attemptId}`,
      });
      return;
    }
    const stage = stageForAttempt(instance, request.stageId);
    const dispatched = stage.executor.kind === "loop_action"
      ? await drainLoopAttempt(instance, resource, request)
      : await dispatch(instance, resource, request);
    acknowledgeEffect(effect, eventId, { providerResourceId: resource.providerResourceId, ...dispatched });
  };

  const drainActiveLoopAttempts = async (): Promise<void> => {
    for (const attempt of deps.store.listActiveLoopActionAttempts()) {
      const instance = deps.store.getInstance(attempt.pipeline_instance_id);
      if (!instance) continue;
      const binding = runtimeBindingFor(instance);
      if (!binding.resource || binding.status !== "active") continue;
      const request = deps.store.getStageRequest(attempt.id);
      const plan = parseExecutionPlan(request.taskContext);
      createLoopGraph(instance, request, plan);
      await createUnitEffectProcessor({
        store: deps.store,
        runtime: unitRuntimeFor(binding.resource, request, plan),
        leaseOwner: `pipeline-loop:${attempt.id}`,
        now,
        leaseMs: UNIT_EFFECT_LEASE_MS,
      }).drain(attempt.id);
      maybeEmitLoopAggregate(instance, request);
    }
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
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    const owner = `pipeline-stop:${effect.id}`;
    const currentSession = ticket?.linear_session_id === instance.linear_session_id;
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
    const projectionTicket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (projectionTicket?.linear_session_id === instance.linear_session_id) {
      // The sealed run may already have completed before this terminal stop
      // drains. Project the terminal ticket state independently from actor
      // settlement so completed actors cannot leave a failed pipeline active.
      // Refresh after the provider call so a concurrent replacement session
      // cannot receive its predecessor's terminal projection.
      deps.tickets.setState(
        projectionTicket.linear_issue_id,
        ticketState,
        settlementReason
      );
      deps.tickets.markSessionState(instance.linear_session_id, "stopped");
      deps.tickets.cancelPendingInbox(instance.linear_issue_id);
    }
    if (binding.resource && binding.status !== "cleaned") {
      await deps.runtime.cleanup(binding.resource);
      deps.store.setRuntimeResourceStatus(instance.id, "cleaned");
    }
    const cleanupTicket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (cleanupTicket?.linear_session_id === instance.linear_session_id &&
        (!binding.resource || cleanupTicket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.linear_issue_id, null);
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
      const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
      if (!quarantined && refreshed?.run_id === runId) {
        throw new Error(`pipeline actor ${runId} could not be quarantined by ${owner}`);
      }
    } else {
      const refreshed = deps.tickets.getByIssueId(instance.linear_issue_id);
      if (refreshed?.linear_session_id === instance.linear_session_id) {
        // A stage actor can complete before its terminal runtime stop. If
        // provider termination then exhausts there is no live run to
        // quarantine, but the current ticket must still expose the
        // infrastructure failure.
        deps.tickets.setState(instance.linear_issue_id, "error", reason);
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
    const ticket = deps.tickets.getByIssueId(instance.linear_issue_id);
    if (!preserve && ticket?.linear_session_id === instance.linear_session_id &&
        (!binding.resource || ticket.sandbox_id === binding.resource.providerResourceId)) {
      deps.tickets.setSandboxId(instance.linear_issue_id, null);
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

  const enqueueCapacityWaitActivity = (effect: PipelineEffectIntent, message: string): void => {
    try {
      const id = `capacity-wait:${effect.id}`;
      const instance = deps.store.getInstance(effect.pipeline_instance_id);
      if (!instance) return;
      const holding = sanitizeText(message).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      deps.tickets.enqueueLinearOutbox({
        id,
        linearSessionId: instance.linear_session_id,
        issueId: instance.linear_issue_id,
        kind: "activity",
        payload: JSON.stringify({
          type: "activity",
          activity: {
            sessionId: instance.linear_session_id,
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
      const message = sanitizeText(String(error)).slice(-2_000);
      const errorClass = classifyEffectError(message);
      // Stop settlement keeps its full retry budget: exhausting it early would
      // reroute live actors into quarantine on the first provider auth blip.
      const exhausted = (errorClass === "auth" && effect.kind !== "stop") ||
        effect.attempts >= MAX_EFFECT_ATTEMPTS;
      const retryAt = exhausted
        ? null
        : errorClass === "capacity"
          ? new Date(now().getTime() + CAPACITY_RETRY_MS).toISOString()
          : new Date(now().getTime() + RETRY_BASE_MS * 2 ** Math.min(effect.attempts - 1, 6)).toISOString();
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
        const ticket = instance ? deps.tickets.getByIssueId(instance.linear_issue_id) : undefined;
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
        if (runId && !deps.tickets.claimRunForReaping(runId, owner, "pipeline stop exhausted")) {
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
        await drainActiveLoopAttempts();
      } finally {
        draining = false;
      }
    },
  };
}
