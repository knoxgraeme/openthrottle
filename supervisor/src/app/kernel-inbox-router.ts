import type { JsonValue } from "@openthrottle/contracts";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import {
  KERNEL_STEERING_ENVELOPE_SCHEMA,
  type AuthorizedKernelSteering,
  type KernelSteeringEnvelope,
} from "../pipeline/kernel/steering.js";
import type {
  KernelProviderPromptDisposition,
} from "./kernel-provider-prompt.js";

interface KernelRunControlInboxPort {
  requestRunControl(input: {
    pipeline_run_id: string;
    action: "stop" | "supersede";
    reason: string;
  }): Promise<{ disposition: "consumed" | "stale" }>;
}

interface KernelInboxCapability {
  handle(event: KernelInboxEvent): Promise<"consumed" | "stale" | "dead">;
}

interface KernelSteeringAuthorizationPort {
  authorizeLeasedSteering(event: KernelInboxEvent): Promise<AuthorizedKernelSteering>;
}

interface KernelProviderPromptPort {
  handle(event: KernelInboxEvent): Promise<KernelProviderPromptDisposition | null>;
}

export interface KernelSteeringDeliveryPort {
  deliverSteering(input: {
    event_id: string;
    delivery_id: string;
    envelope: KernelSteeringEnvelope;
    authorized: AuthorizedKernelSteering;
  }): Promise<void>;
}

function object(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function exactKeys(value: Record<string, JsonValue>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const intended = [...expected].sort();
  return actual.length === intended.length &&
    actual.every((key, index) => key === intended[index]);
}

function controlRequest(event: KernelInboxEvent): {
  pipeline_run_id: string;
  action: "stop" | "supersede";
  reason: string;
} | null {
  if (
    event.source_provider !== "operator" ||
    (event.kind !== "control/stop@1" && event.kind !== "control/supersede@1") ||
    event.payload_schema !== "openthrottle.operator-control/v1" ||
    event.pipeline_run_id === null
  ) return null;
  const payload = object(event.payload);
  if (!payload || !exactKeys(payload, [
    "schema", "pipeline_run_id", "action", "cursor_version", "reason",
  ])) return null;
  const action = event.kind === "control/stop@1" ? "stop" : "supersede";
  if (
    payload.schema !== "openthrottle.operator-control/v1" ||
    payload.pipeline_run_id !== event.pipeline_run_id || payload.action !== action ||
    !Number.isSafeInteger(payload.cursor_version) || (payload.cursor_version as number) < 0 ||
    typeof payload.reason !== "string" || payload.reason.trim().length < 1 ||
    payload.reason.length > 1_500
  ) return null;
  return {
    pipeline_run_id: event.pipeline_run_id,
    action,
    reason: payload.reason.trim(),
  };
}

function steeringEnvelope(event: KernelInboxEvent): KernelSteeringEnvelope | null {
  if (event.kind !== "steering/message@1") return null;
  const payload = object(event.payload);
  if (!payload || payload.schema !== KERNEL_STEERING_ENVELOPE_SCHEMA) return null;
  return payload as unknown as KernelSteeringEnvelope;
}

function staleSteering(error: unknown): boolean {
  return error instanceof Error &&
    /stale|mismatch|no durable runtime session binding|not in its bound live phase/.test(error.message);
}

/** Routes each durable inbox kind to exactly one application capability. */
export class KernelInboxRouter {
  readonly #admission: KernelInboxCapability;
  readonly #control: KernelRunControlInboxPort;
  readonly #steeringAuthority: KernelSteeringAuthorizationPort;
  readonly #steeringDelivery: KernelSteeringDeliveryPort;
  readonly #providerPrompts: KernelProviderPromptPort;

  constructor(input: {
    admission: KernelInboxCapability;
    run_control: KernelRunControlInboxPort;
    steering_authority: KernelSteeringAuthorizationPort;
    steering_delivery: KernelSteeringDeliveryPort;
    provider_prompts: KernelProviderPromptPort;
  }) {
    this.#admission = input.admission;
    this.#control = input.run_control;
    this.#steeringAuthority = input.steering_authority;
    this.#steeringDelivery = input.steering_delivery;
    this.#providerPrompts = input.provider_prompts;
  }

  async handle(event: KernelInboxEvent): Promise<"consumed" | "stale" | "dead"> {
    if (event.kind.startsWith("control/")) {
      const request = controlRequest(event);
      if (!request) return "dead";
      return (await this.#control.requestRunControl(request)).disposition;
    }
    if (event.kind === "steering/message@1") {
      const envelope = steeringEnvelope(event);
      if (!envelope) return "dead";
      let authorized: AuthorizedKernelSteering;
      try {
        authorized = await this.#steeringAuthority.authorizeLeasedSteering(event);
      } catch (error) {
        if (staleSteering(error)) return "stale";
        throw error;
      }
      await this.#steeringDelivery.deliverSteering({
        event_id: event.id,
        delivery_id: event.delivery_id,
        envelope,
        authorized,
      });
      return "consumed";
    }
    const prompt = await this.#providerPrompts.handle(event);
    if (prompt !== null) return prompt;
    return this.#admission.handle(event);
  }
}
