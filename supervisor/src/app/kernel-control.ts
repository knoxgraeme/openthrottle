import {
  compareCodeUnits,
  type JsonValue,
} from "@openthrottle/contracts";
import type {
  KernelInboxDeliveryPort,
  KernelInboxEvent,
  KernelInboxEventInput,
  KernelInboxIngressPort,
  KernelMaintenanceFence,
  KernelMaintenancePort,
} from "../persistence/kernel-inbox-store.js";
import type {
  KernelActiveWorkItem,
  KernelActiveWorkSnapshot,
  KernelActiveWorkProjectionPort,
} from "../persistence/kernel-projection-store.js";
import {
  KERNEL_STEERING_ENVELOPE_SCHEMA,
  authorizeKernelSteeringDelivery,
  createKernelSteeringEnvelope,
  kernelSteeringEnvelopePayload,
  type AuthorizedKernelSteering,
  type KernelRuntimeSessionBindingPort,
  type KernelSteeringEnvelope,
} from "../pipeline/kernel/steering.js";

export interface KernelIngressAccepted {
  accepted: true;
  acknowledge: true;
  retryable: false;
  event: KernelInboxEvent;
  duplicate: boolean;
}

export interface KernelIngressMaintenanceResponse {
  accepted: false;
  acknowledge: false;
  retryable: true;
  status_code: 503;
  retry_after_seconds: number;
  reason: "maintenance";
}

export type KernelIngressResponse =
  | KernelIngressAccepted
  | KernelIngressMaintenanceResponse;

export interface KernelRuntimeInventoryResource {
  id: string;
  provider: string;
  state: string;
  pipeline_run_id: string | null;
  detail?: string;
}

export interface KernelRuntimeInventoryPort {
  listActiveRuntimeResources(limit: number): Promise<readonly KernelRuntimeInventoryResource[]>;
}

export interface KernelActiveWorkReport extends KernelActiveWorkSnapshot {
  observed_at: string;
  clear: boolean;
}

const DEFAULT_RETRY_AFTER_SECONDS = 30;
const DEFAULT_ACTIVE_WORK_LIMIT = 500;
const MAX_ACTIVE_WORK_LIMIT = 2_000;

function ingressResponse(
  result: ReturnType<KernelInboxIngressPort["ingest"]>,
): KernelIngressResponse {
  if (result.disposition === "maintenance_closed") {
    return {
      accepted: false,
      acknowledge: false,
      retryable: true,
      status_code: 503,
      retry_after_seconds: DEFAULT_RETRY_AFTER_SECONDS,
      reason: "maintenance",
    };
  }
  return {
    accepted: true,
    acknowledge: true,
    retryable: false,
    event: result.event,
    duplicate: result.disposition !== "inserted",
  };
}

function steeringEnvelope(value: JsonValue): KernelSteeringEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("steering inbox payload is not an envelope");
  }
  const envelope = value as unknown as KernelSteeringEnvelope;
  if (envelope.schema !== KERNEL_STEERING_ENVELOPE_SCHEMA) {
    throw new Error("steering inbox payload schema is unsupported");
  }
  return envelope;
}

export class KernelControlService {
  readonly #inbox: KernelInboxIngressPort & KernelInboxDeliveryPort;
  readonly #maintenance: KernelMaintenancePort;
  readonly #sessions: KernelRuntimeSessionBindingPort;
  readonly #activeWork: KernelActiveWorkProjectionPort;
  readonly #runtimeInventory: KernelRuntimeInventoryPort;
  readonly #now: () => string;

  constructor(input: {
    inbox: KernelInboxIngressPort & KernelInboxDeliveryPort;
    maintenance: KernelMaintenancePort;
    runtime_sessions: KernelRuntimeSessionBindingPort;
    active_work: KernelActiveWorkProjectionPort;
    runtime_inventory: KernelRuntimeInventoryPort;
    now?: () => string;
  }) {
    this.#inbox = input.inbox;
    this.#maintenance = input.maintenance;
    this.#sessions = input.runtime_sessions;
    this.#activeWork = input.active_work;
    this.#runtimeInventory = input.runtime_inventory;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  ingestMutation(input: KernelInboxEventInput): KernelIngressResponse {
    return ingressResponse(this.#inbox.ingest(input));
  }

  closeMutatingIngress(expectedVersion?: number): KernelMaintenanceFence {
    return this.#maintenance.setMaintenanceFence({
      closed: true,
      expected_version: expectedVersion,
    });
  }

  openMutatingIngress(expectedVersion?: number): KernelMaintenanceFence {
    return this.#maintenance.setMaintenanceFence({
      closed: false,
      expected_version: expectedVersion,
    });
  }

  maintenanceState(): KernelMaintenanceFence {
    return this.#maintenance.getMaintenanceFence();
  }

  async enqueueSteering(input: {
    message_id: string;
    source: KernelSteeringEnvelope["source"];
    body: string;
    source_provider: string;
    delivery_id: string;
    delivery_attempt: number;
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelIngressResponse> {
    if (this.#maintenance.getMaintenanceFence().closed) {
      return ingressResponse({
        disposition: "maintenance_closed",
        retryable: true,
        acknowledge: false,
      });
    }
    const binding = await this.#sessions.loadCurrentRuntimeSession({
      pipeline_run_id: input.pipeline_run_id,
      attempt_id: input.attempt_id,
    });
    if (!binding) {
      throw new Error("cannot enqueue steering before a durable runtime session is bound");
    }
    const envelope = createKernelSteeringEnvelope({
      message_id: input.message_id,
      source: input.source,
      body: input.body,
      binding,
    });
    return this.ingestMutation({
      id: `steering-${input.message_id}`,
      source_provider: input.source_provider,
      delivery_id: input.delivery_id,
      kind: "steering/message@1",
      pipeline_run_id: binding.pipeline_run_id,
      attempt_id: binding.attempt_id,
      generation: binding.generation,
      event_group_key: `steering:${input.message_id}`,
      delivery_attempt: input.delivery_attempt,
      subject: binding.input_subject,
      payload_schema: KERNEL_STEERING_ENVELOPE_SCHEMA,
      payload: kernelSteeringEnvelopePayload(envelope),
    });
  }

  async authorizeLeasedSteering(event: KernelInboxEvent): Promise<AuthorizedKernelSteering> {
    if (
      event.kind !== "steering/message@1" ||
      event.payload_schema !== KERNEL_STEERING_ENVELOPE_SCHEMA ||
      event.status !== "processing" || !event.lease_id ||
      !event.pipeline_run_id || !event.attempt_id
    ) throw new Error("steering event does not hold an exact processing lease");
    const envelope = steeringEnvelope(event.payload);
    if (
      envelope.binding.pipeline_run_id !== event.pipeline_run_id ||
      envelope.binding.attempt_id !== event.attempt_id ||
      envelope.binding.generation !== event.generation ||
      envelope.binding.input_subject !== event.subject
    ) throw new Error("steering inbox columns do not match its sealed envelope");
    const current = await this.#sessions.loadCurrentRuntimeSession({
      pipeline_run_id: event.pipeline_run_id,
      attempt_id: event.attempt_id,
    });
    return authorizeKernelSteeringDelivery({ envelope, current_binding: current });
  }

  async activeWorkReport(input: { limit?: number } = {}): Promise<KernelActiveWorkReport> {
    const requestedLimit = input.limit ?? DEFAULT_ACTIVE_WORK_LIMIT;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_ACTIVE_WORK_LIMIT) {
      throw new Error("active-work limit must be between 1 and 2000");
    }
    const durable = this.#activeWork.collectActiveWork(requestedLimit);
    const remaining = Math.max(0, requestedLimit - durable.items.length);
    let runtime: readonly KernelRuntimeInventoryResource[] = [];
    let inventoryTruncated = false;
    if (remaining > 0) {
      try {
        const inventoryLimit = Math.min(remaining + 1, MAX_ACTIVE_WORK_LIMIT);
        const observed = await this.#runtimeInventory.listActiveRuntimeResources(inventoryLimit);
        runtime = observed.slice(0, remaining);
        inventoryTruncated = observed.length >= inventoryLimit;
      } catch (error) {
        runtime = [{
          id: "inventory-unavailable",
          provider: "unknown",
          state: "unknown",
          pipeline_run_id: null,
          detail: `runtime inventory failed: ${String(error)}`.slice(0, 1_500),
        }];
      }
    } else {
      inventoryTruncated = true;
    }
    const observedAt = this.#now();
    const externalItems: KernelActiveWorkItem[] = runtime.map((resource) => ({
      key: `runtime_resource:${resource.provider}:${resource.id}`,
      kind: "runtime_resource",
      id: resource.id,
      pipeline_run_id: resource.pipeline_run_id,
      status: resource.state,
      detail: resource.detail ?? `provider=${resource.provider}`,
      observed_at: observedAt,
    }));
    const items = [...durable.items, ...externalItems]
      .sort((left, right) => compareCodeUnits(left.key, right.key));
    const truncated = durable.truncated || inventoryTruncated;
    const clear = items.length === 0 && !truncated;
    return {
      observed_at: observedAt,
      items,
      truncated,
      clear,
    };
  }
}
