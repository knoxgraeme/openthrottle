import { Buffer } from "node:buffer";
import type { JsonValue } from "@openthrottle/contracts";
import type {
  KernelInboxEvent,
  KernelInboxObservationPort,
} from "../persistence/kernel-inbox-store.js";
import type { KernelProjectionPort } from "../persistence/kernel-projection-store.js";
import type { KernelRunReferencePort } from "../persistence/kernel-registration-store.js";
import type { KernelIngressResponse } from "./kernel-control.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_STEERING_BODY_BYTES = 32 * 1024;
const GITHUB_PRE_ADMISSION_STOP_GRACE_MS = 10 * 60_000;
const GITHUB_ORIGIN_OBSERVATION_LIMIT = 8;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const GITHUB_ADMISSION_KINDS = [
  "github/issues/opened@1",
  "github/issues/labeled@1",
  "github/issues/edited@1",
] as const;

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
  github_issue: boolean;
  github_stop_at: number | null;
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

function isoInstant(value: JsonValue | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (
    year! < 1 || month! < 1 || month! > 12 || day! < 1 ||
    day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
    hour! > 23 || minute! > 59 || second! > 59 || zoneHour > 23 || zoneMinute > 59
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    github_issue: false,
    github_stop_at: null,
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
  const stop = /^(?:\/)?stop$/i.test(body);
  return {
    reference: `${repo.toLowerCase()}#${number as number}`,
    message_id: String(messageId),
    body: rawBody,
    stop,
    github_issue: issue?.pull_request === undefined,
    github_stop_at: stop ? isoInstant(comment?.created_at) : null,
    github_authorization: typeof username === "string"
      ? { repository: repo, username }
      : null,
  };
}

function githubAdmissionOrigin(event: KernelInboxEvent): {
  reference: string;
  occurred_at: number;
} | null {
  if (
    event.source_provider !== "github" ||
    !GITHUB_ADMISSION_KINDS.includes(event.kind as typeof GITHUB_ADMISSION_KINDS[number])
  ) return null;
  const payload = object(event.payload);
  const repository = nested(payload, "repository");
  const issue = nested(payload, "issue");
  const repo = repository?.full_name;
  const number = issue?.number;
  const occurredAt = isoInstant(
    event.kind === "github/issues/opened@1" ? issue?.created_at : issue?.updated_at,
  );
  if (
    typeof repo !== "string" || !Number.isSafeInteger(number) || (number as number) < 1 ||
    issue?.pull_request !== undefined ||
    !strings(issue?.labels).some((label) => label.toLowerCase() === "openthrottle") ||
    occurredAt === null
  ) return null;
  return { reference: `${repo.toLowerCase()}#${number as number}`, occurred_at: occurredAt };
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
  readonly #inbox: KernelInboxObservationPort;
  readonly #now: () => Date;

  constructor(input: {
    runs: KernelRunReferencePort;
    projections: KernelProjectionPort;
    control: KernelProviderPromptControlPort;
    github_authorization: KernelProviderPromptGithubAuthorizationPort;
    inbox: KernelInboxObservationPort;
    now?: () => Date;
  }) {
    this.#runs = input.runs;
    this.#projections = input.projections;
    this.#control = input.control;
    this.#githubAuthorization = input.github_authorization;
    this.#inbox = input.inbox;
    this.#now = input.now ?? (() => new Date());
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
        if (event.source_provider === "github") {
          if (!prompt.github_issue || !prompt.github_authorization) return "stale";
          if (prompt.github_stop_at === null) return "dead";
          const deadline = Date.parse(event.created_at) + GITHUB_PRE_ADMISSION_STOP_GRACE_MS;
          if (!Number.isFinite(deadline)) return "dead";
          if (this.#now().getTime() >= deadline) return "stale";
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
      if (prompt.stop) {
        if (!prompt.github_issue) return "stale";
        if (prompt.github_stop_at === null) return "dead";
        const deadline = Date.parse(event.created_at) + GITHUB_PRE_ADMISSION_STOP_GRACE_MS;
        if (!Number.isFinite(deadline)) return "dead";
        const admittedAt = Date.parse(run.admitted_at);
        if (!Number.isFinite(admittedAt) || admittedAt > deadline) return "stale";
        const origins = this.#inbox.listConsumedAt({
          source_provider: "github",
          kinds: GITHUB_ADMISSION_KINDS,
          consumed_at: run.admitted_at,
          limit: GITHUB_ORIGIN_OBSERVATION_LIMIT,
        });
        if (origins.truncated || origins.corrupt) return "stale";
        const matching = origins.events.flatMap((candidate) => {
          const origin = githubAdmissionOrigin(candidate);
          return origin?.reference === prompt.reference ? [origin] : [];
        });
        if (matching.length !== 1 || matching[0]!.occurred_at >= prompt.github_stop_at) {
          return "stale";
        }
      }
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
