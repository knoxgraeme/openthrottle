import {
  digestCanonicalJson,
  type JsonValue,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
} from "@openthrottle/contracts";
import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { SqliteKernelStore } from "../persistence/kernel-store.js";
import type { VolumeBlobStore } from "../persistence/blob-store.js";
import type { KernelRepositoryRegistrationPort } from "../persistence/kernel-registration-store.js";
import type { ExactDefinitionSourceReader } from "../pipeline/definition-compilation.js";
import {
  parseStructuredExecutionPlan,
  restoreExecutionPlanFenceMarkers,
} from "../pipeline/kernel/structured-plan.js";
import type { KernelRuntimeCompatibilityPort } from "../runtime/kernel-contracts.js";
import { admitKernelPipeline } from "./kernel-admission.js";
import {
  kernelLinearSessionStartRequest,
  type KernelLinearSessionStartPort,
} from "./kernel-linear-session.js";
import { linearAgentActivityBody } from "./kernel-provider-prompt.js";

const SUBJECT = /^[a-f0-9]{40,64}$/;
const DEFAULT_GITHUB_SUBJECT_TIMEOUT_MS = 15_000;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nested(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return object(value?.[key]);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = object(entry);
    return typeof item?.name === "string" ? [item.name] : [];
  });
}

export function linearAdmissionPrompt(input: {
  event_kind: "linear/agent-session-event/created@1" | "linear/agent-session-event/prompted@1";
  title: string;
  description: string;
  payload: JsonValue;
}): string {
  const payload = object(input.payload);
  const directive = input.event_kind === "linear/agent-session-event/prompted@1"
    ? linearAgentActivityBody(input.payload)
    : typeof payload?.promptContext === "string" ? payload.promptContext : "";
  return restoreExecutionPlanFenceMarkers(
    [input.title, input.description, directive].filter(Boolean).join("\n\n"),
  );
}

export function selectKernelInboxPipeline(labels: readonly string[], prompt: string): string {
  if (labels.some((label) => label.toLowerCase() === "investigate")) return "core/investigate";
  try {
    parseStructuredExecutionPlan(prompt, "core/structured");
    return "core/structured";
  } catch {
    return "core/admission";
  }
}

export class KernelAdmissionInboxHandler {
  readonly #registrations: KernelRepositoryRegistrationPort;
  readonly #githubToken: string;
  readonly #sourceReader: ExactDefinitionSourceReader;
  readonly #platform: TrustedPlatformDefinitionSource;
  readonly #compilerEnvironment: TrustedCompilerEnvironment;
  readonly #runtime: KernelRuntimeCompatibilityPort;
  readonly #blobs: VolumeBlobStore;
  readonly #store: SqliteKernelStore;
  readonly #linearSessionStart: KernelLinearSessionStartPort | undefined;
  readonly #fetch: typeof fetch;
  readonly #githubSubjectTimeoutMs: number;

  constructor(input: {
    registrations: KernelRepositoryRegistrationPort;
    github_token: string;
    source_reader: ExactDefinitionSourceReader;
    platform: TrustedPlatformDefinitionSource;
    compiler_environment: TrustedCompilerEnvironment;
    runtime: KernelRuntimeCompatibilityPort;
    blob_store: VolumeBlobStore;
    store: SqliteKernelStore;
    linear_session_start?: KernelLinearSessionStartPort;
    fetch?: typeof fetch;
    github_subject_timeout_ms?: number;
  }) {
    this.#registrations = input.registrations;
    this.#githubToken = input.github_token;
    this.#sourceReader = input.source_reader;
    this.#platform = input.platform;
    this.#compilerEnvironment = input.compiler_environment;
    this.#runtime = input.runtime;
    this.#blobs = input.blob_store;
    this.#store = input.store;
    this.#linearSessionStart = input.linear_session_start;
    this.#fetch = input.fetch ?? fetch;
    this.#githubSubjectTimeoutMs = input.github_subject_timeout_ms ??
      DEFAULT_GITHUB_SUBJECT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#githubSubjectTimeoutMs) ||
      this.#githubSubjectTimeoutMs < 100 || this.#githubSubjectTimeoutMs > 60_000
    ) throw new Error("GitHub subject timeout must be between 100 and 60000ms");
  }

  async handle(event: KernelInboxEvent): Promise<"consumed" | "stale" | "dead"> {
    if (event.source_provider !== "linear" && event.source_provider !== "github") return "stale";
    const admission = this.#admission(event);
    if (!admission) return "stale";
    const linearSessionStart = kernelLinearSessionStartRequest(event);
    if (linearSessionStart) {
      if (!this.#linearSessionStart) {
        throw new Error("Linear session-start acknowledgement is unavailable");
      }
      await this.#linearSessionStart.ensureStarted(linearSessionStart);
    }
    const existing = this.#registrations.resolveRun(admission.source_reference);
    if (existing) return "consumed";
    const sourceCommit = event.subject && SUBJECT.test(event.subject)
      ? event.subject
      : await this.#resolveBranch(admission.repository, admission.base_branch);
    const identity = digestCanonicalJson({
      schema: "openthrottle.kernel-admission-identity/v1",
      provider: event.source_provider,
      source_id: admission.source_id,
      repository: admission.repository,
      source_commit: sourceCommit,
      request_hash: event.payload_hash,
    });
    if (
      event.status !== "processing" || event.lease_id === null ||
      event.lease_owner_id === null
    ) throw new Error("repository admission requires the leased originating inbox event");
    await admitKernelPipeline({
      repository: admission.repository,
      source_commit: sourceCommit,
      expected_pipeline: admission.expected_pipeline,
      source_reader: this.#sourceReader,
      platform: this.#platform,
      compiler_environment: this.#compilerEnvironment,
      runtime_compatibility: this.#runtime,
      blob_store: this.#blobs,
      store: this.#store,
      work_item: {
        id: `work-${identity.slice(0, 48)}`,
        repository_registration_id: admission.registration_id,
        source_provider: event.source_provider,
        source_id: admission.source_id,
        source_reference: admission.source_reference,
        title: admission.title,
        task_prompt: admission.prompt,
      },
      identity: {
        pipeline_run_id: `run-${identity.slice(0, 48)}`,
        initial_attempt_id: `attempt-${digestCanonicalJson({ identity, stage: "entry" }).slice(0, 48)}`,
      },
      work_retry_limit: 3,
      result_correction_limit: 2,
      originating_inbox: {
        event_id: event.id,
        source_provider: event.source_provider,
        delivery_id: event.delivery_id,
        kind: event.kind,
        payload_hash: event.payload_hash,
        lease_id: event.lease_id,
        lease_owner_id: event.lease_owner_id,
        version: event.version,
      },
    });
    return "consumed";
  }

  #admission(event: KernelInboxEvent): {
    registration_id: string;
    repository: string;
    base_branch: string;
    source_id: string;
    source_reference: string;
    title: string;
    prompt: string;
    expected_pipeline: string;
  } | null {
    const payload = object(event.payload as JsonValue);
    if (!payload) return null;
    if (event.source_provider === "linear") {
      if (!/^linear\/agent-session-event\/(?:created|prompted)@1$/.test(event.kind)) return null;
      const eventKind = event.kind === "linear/agent-session-event/created@1"
        ? event.kind
        : "linear/agent-session-event/prompted@1";
      const session = nested(payload, "agentSession");
      const issue = nested(session, "issue");
      const team = nested(issue, "team");
      const teamId = typeof team?.id === "string" ? team.id : undefined;
      const teamKey = typeof team?.key === "string" ? team.key : undefined;
      const registration = this.#registrations.findLinearRoute({
        ...(teamId ? { team_id: teamId } : {}), ...(teamKey ? { team_key: teamKey } : {}),
      });
      if (!registration || !issue) return null;
      const identifier = typeof issue.identifier === "string" ? issue.identifier : event.delivery_id;
      const title = typeof issue.title === "string" ? issue.title : identifier;
      const description = typeof issue.description === "string" ? issue.description : "";
      const prompt = linearAdmissionPrompt({
        event_kind: eventKind,
        title,
        description,
        payload: event.payload,
      });
      const labels = strings(issue.labels);
      return {
        registration_id: registration.id,
        repository: registration.github_repo,
        base_branch: registration.base_branch,
        source_id: typeof issue.id === "string" ? issue.id : identifier,
        source_reference: identifier,
        title,
        prompt,
        expected_pipeline: selectKernelInboxPipeline(labels, prompt),
      };
    }
    if (!/^github\/issues\/(?:opened|labeled|edited)@1$/.test(event.kind)) return null;
    const repository = nested(payload, "repository");
    const issue = nested(payload, "issue");
    if (!repository || !issue || issue.pull_request !== undefined) return null;
    const repo = typeof repository.full_name === "string" ? repository.full_name.toLowerCase() : "";
    const registration = this.#registrations.findGithubRoute(repo);
    const labels = strings(issue.labels);
    if (!registration || !labels.some((label) => label.toLowerCase() === "openthrottle")) return null;
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const title = typeof issue.title === "string" ? issue.title : `Issue #${number}`;
    const prompt = [title, typeof issue.body === "string" ? issue.body : ""].filter(Boolean).join("\n\n");
    return {
      registration_id: registration.id,
      repository: registration.github_repo,
      base_branch: registration.base_branch,
      source_id: String(issue.id ?? number),
      source_reference: `${repo}#${number}`,
      title,
      prompt,
      expected_pipeline: selectKernelInboxPipeline(labels, prompt),
    };
  }

  async #resolveBranch(repository: string, branch: string): Promise<string> {
    const response = await this.#fetch(
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`,
      { headers: {
        Authorization: `Bearer ${this.#githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openthrottle",
      }, signal: AbortSignal.timeout(this.#githubSubjectTimeoutMs) },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error(`GitHub subject resolution failed (${response.status}): ${raw.slice(-1_000)}`);
    const value = JSON.parse(raw) as { sha?: unknown };
    if (typeof value.sha !== "string" || !SUBJECT.test(value.sha)) {
      throw new Error("GitHub subject resolution returned an invalid full commit");
    }
    return value.sha.toLowerCase();
  }
}
