import { Buffer } from "node:buffer";
import type { JsonValue } from "@openthrottle/contracts";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelProjectionPort } from "../persistence/kernel-projection-store.js";
import type { KernelRunReferencePort } from "../persistence/kernel-registration-store.js";
import type { KernelIngressResponse } from "./kernel-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_STEERING_BODY_BYTES = 32 * 1024;

export interface KernelProviderPromptControlPort {
  requestRunControl(input: {
    pipeline_run_id: string;
    action: "stop" | "supersede";
    reason: string;
  }): Promise<{ disposition: "consumed" | "stale" }>;
  enqueueSteering(input: {
    message_id: string;
    source: "human";
    body: string;
    source_provider: string;
    delivery_id: string;
    delivery_attempt: number;
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelIngressResponse>;
}

export interface KernelProviderPromptGithubAuthorizationPort {
  authorizeComment(input: {
    repository: string;
    username: string;
  }): Promise<boolean>;
}

export type KernelProviderPromptDisposition = "consumed" | "stale" | "dead";

interface ProviderPrompt {
  reference: string;
  message_id: string;
  body: string;
  stop: boolean;
  retry_stop_before_admission: boolean;
  github_authorization: { repository: string; username: string } | null;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function nested(value: Record<string, JsonValue> | null, key: string): Record<string, JsonValue> | null {
  return object(value?.[key]);
}

function strings(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = object(entry);
    return typeof item?.name === "string" ? [item.name] : [];
  });
}

function signal(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value.trim().toLowerCase() || null;
  const container = object(value);
  for (const key of ["type", "name", "signal", "value"] as const) {
    const candidate = container?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }
  return null;
}

export function linearAgentActivityBody(payload: JsonValue): string {
  const activity = nested(object(payload), "agentActivity");
  const content = nested(activity, "content");
  return typeof content?.body === "string"
    ? content.body
    : typeof activity?.body === "string" ? activity.body : "";
}

function linearPrompt(event: KernelInboxEvent): ProviderPrompt | null {
  if (event.kind !== "linear/agent-session-event/prompted@1") return null;
  const payload = object(event.payload);
  const session = nested(payload, "agentSession");
  const issue = nested(session, "issue");
  const activity = nested(payload, "agentActivity");
  const identifier = issue?.identifier;
  const messageId = activity?.id;
  if (typeof identifier !== "string" || typeof messageId !== "string") {
    throw new Error("Linear prompted event is missing its issue or activity identity");
  }
  const rawBody = linearAgentActivityBody(event.payload);
  const stop = signal(activity?.signal) === "stop";
  return {
    reference: identifier,
    message_id: messageId,
    body: rawBody,
    stop,
    retry_stop_before_admission: true,
    github_authorization: null,
  };
}

function githubPrompt(event: KernelInboxEvent): ProviderPrompt | null {
  if (event.kind !== "github/issue-comment/created@1") return null;
  const payload = object(event.payload);
  const repository = nested(payload, "repository");
  const issue = nested(payload, "issue");
  const comment = nested(payload, "comment");
  const repo = repository?.full_name;
  const number = issue?.number;
  const messageId = comment?.id;
  const rawBody = comment?.body;
  const user = nested(comment, "user");
  const username = user?.login;
  if (
    typeof repo !== "string" || !Number.isSafeInteger(number) || (number as number) < 1 ||
    (typeof messageId !== "string" && !Number.isSafeInteger(messageId)) ||
    typeof rawBody !== "string"
  ) throw new Error("GitHub issue comment is missing its repository, issue, or comment identity");
  const body = rawBody.trim();
  const admissionEligible = issue?.pull_request === undefined &&
    strings(issue?.labels).some((label) => label.toLowerCase() === "openthrottle");
  return {
    reference: `${repo.toLowerCase()}#${number as number}`,
    message_id: String(messageId),
    body: rawBody,
    stop: /^(?:\/)?stop$/i.test(body),
    retry_stop_before_admission: admissionEligible,
    github_authorization: typeof username === "string"
      ? { repository: repo, username }
      : null,
  };
}

function providerPrompt(event: KernelInboxEvent): ProviderPrompt | null {
  if (event.source_provider === "linear") return linearPrompt(event);
  if (event.source_provider === "github") return githubPrompt(event);
  return null;
}

/** Converts follow-up provider messages into exact run control or steering work. */
export class KernelProviderPromptHandler {
  readonly #runs: KernelRunReferencePort;
  readonly #projections: KernelProjectionPort;
  readonly #control: KernelProviderPromptControlPort;
  readonly #githubAuthorization: KernelProviderPromptGithubAuthorizationPort;

  constructor(input: {
    runs: KernelRunReferencePort;
    projections: KernelProjectionPort;
    control: KernelProviderPromptControlPort;
    github_authorization: KernelProviderPromptGithubAuthorizationPort;
  }) {
    this.#runs = input.runs;
    this.#projections = input.projections;
    this.#control = input.control;
    this.#githubAuthorization = input.github_authorization;
  }

  /** Null means admission should inspect this event as a possible first prompt. */
  async handle(event: KernelInboxEvent): Promise<KernelProviderPromptDisposition | null> {
    let prompt: ProviderPrompt | null;
    try {
      prompt = providerPrompt(event);
    } catch {
      return "dead";
    }
    if (!prompt) return null;
    if (!ID.test(prompt.message_id)) return "dead";

    const run = this.#runs.resolveRun(prompt.reference);
    if (!run) {
      if (prompt.stop) {
        if (!prompt.retry_stop_before_admission) return "stale";
        if (event.source_provider === "github") {
          if (!prompt.github_authorization) return "stale";
          if (!await this.#githubAuthorization.authorizeComment(prompt.github_authorization)) {
            return "stale";
          }
        }
        throw new Error(`cannot apply provider stop before ${prompt.reference} is admitted`);
      }
      return null;
    }
    if (event.source_provider === "github") {
      if (!prompt.github_authorization) return "stale";
      if (!await this.#githubAuthorization.authorizeComment(prompt.github_authorization)) {
        return "stale";
      }
    }
    const status = this.#projections.getStatus(run.pipeline_run_id, 200);
    if (!status) return "stale";
    if (status.status !== "pending" && status.status !== "running") return "stale";

    if (prompt.stop) {
      return (await this.#control.requestRunControl({
        pipeline_run_id: run.pipeline_run_id,
        action: "stop",
        reason: `Stopped from the ${event.source_provider} control thread.`,
      })).disposition;
    }

    const body = prompt.body.replace(/\r\n?/g, "\n").trim();
    if (!body || body.includes("\0") || Buffer.byteLength(body, "utf8") > MAX_STEERING_BODY_BYTES) {
      return "dead";
    }
    const receptive = status.attempts.filter((attempt) =>
      attempt.native_session_bound &&
      (
        (attempt.status === "running" && attempt.lease_purpose === "work") ||
        (attempt.status === "result_pending" && attempt.lease_purpose === "result_correction")
      )
    );
    if (receptive.length > 1) {
      throw new Error(`pipeline run ${run.pipeline_run_id} has multiple steering-capable attempts`);
    }
    if (receptive.length === 0) {
      // Keep the provider event durable until the active run binds a session.
      throw new Error(`pipeline run ${run.pipeline_run_id} has no bound steering-capable attempt yet`);
    }
    const accepted = await this.#control.enqueueSteering({
      message_id: prompt.message_id,
      source: "human",
      body,
      source_provider: event.source_provider,
      delivery_id: `steering:${prompt.message_id}`,
      delivery_attempt: event.delivery_attempt,
      pipeline_run_id: run.pipeline_run_id,
      attempt_id: receptive[0]!.id,
    });
    if (!accepted.accepted) {
      throw new Error("steering ingress is temporarily closed for maintenance");
    }
    return "consumed";
  }
}
