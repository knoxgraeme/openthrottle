import {
  canonicalJson,
  validateBlobPointer,
  validateGithubProviderEvidencePolicy,
  type BlobPointer,
  type EffectIntent,
  type FilesystemConfigContract,
  type JsonValue,
} from "@openthrottle/contracts";
import type { VolumeBlobStore } from "../../persistence/blob-store.js";
import type {
  KernelEffectAdapterBinding,
  KernelEffectProviderObservation,
} from "../../app/kernel-effect-ports.js";
import { githubApiResponse } from "../../shared/github-request.js";
import { pushRepositoryCheckpoint } from "./checkpoint-push.js";
import { publishRepositoryTaskBranch, type GithubClient } from "./client.js";
import { buildGithubPullRequestBody } from "./pull-request-body.js";

const SUBJECT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_REF = /^refs\/heads\/ot\/[A-Za-z0-9._/-]{1,180}$/;

interface PushPayload {
  schema: "openthrottle.github-push-checkpoint/v1";
  ref_mode: "create" | "update";
  repository: string;
  ref: string;
  expected_old_subject: string;
  expected_new_subject: string;
  checkpoint_base_subject: string;
  checkpoint_blob: BlobPointer;
  checkpoint_tree: string;
}

interface PullRequestPayload {
  schema: "openthrottle.github-pull-request/v1";
  repository: string;
  branch: string;
  base_branch: string;
  expected_head_subject: string;
  title: string;
  body: string;
  ownership_marker: string;
}

interface ProviderWaitPayload {
  schema: "openthrottle.github-provider-wait/v1";
  repository: string;
  subject: string;
  policy: GithubProviderEvidencePolicy;
}

type GithubProviderEvidencePolicy = NonNullable<
  FilesystemConfigContract["provider_evidence"]
>["github"];
type GithubObservationRequirement = GithubProviderEvidencePolicy["required_observations"][number];

type PageCollection =
  | { kind: "ok"; entries: unknown[] }
  | { kind: "not_found" }
  | { kind: "unknown"; detail: string };

type PullRequestCollection =
  | { kind: "ok"; entries: unknown[] }
  | { kind: "unknown"; detail: string };

type RequiredObservationResolution =
  | { state: "missing" }
  | { state: "unknown"; detail: string }
  | {
    state: "success" | "pending" | "failure";
    observation: JsonValue;
  };

interface ConsumedCheckRunObservation {
  observed_at: string;
  observation: JsonValue;
}

interface FailedCheckRunState {
  name: string;
  app_slug: string;
  first_failed_at: string;
  failed_observations: ConsumedCheckRunObservation[];
  success_observation?: ConsumedCheckRunObservation;
}

interface ProviderWaitContinuation {
  schema: "openthrottle.github-provider-wait-continuation/v1";
  subject: string;
  check_runs: FailedCheckRunState[];
}

type CheckRunRejectionCause = "failure_budget_exhausted" | "window_expired";

const PROVIDER_PAGE_SIZE = 100;
const PROVIDER_MAX_PAGES = 10;
const PULL_REQUEST_PAGE_SIZE = 100;
const PULL_REQUEST_MAX_PAGES = 10;
const CHECK_RUN_REOBSERVATION_WINDOW_MS = 30 * 60_000;
const CHECK_RUN_REOBSERVATION_WINDOW_MINUTES = 30;
const CHECK_RUN_FAILURE_LIMIT = 3;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function pushPayload(intent: Readonly<EffectIntent>): PushPayload {
  const value = object(intent.payload, `effect ${intent.id} payload`);
  exactKeys(value, [
    "schema", "ref_mode", "repository", "ref", "expected_old_subject", "expected_new_subject",
    "checkpoint_base_subject", "checkpoint_blob", "checkpoint_tree",
  ], "GitHub checkpoint push payload");
  const blob = validateBlobPointer(value.checkpoint_blob, {
    source: "github_push.checkpoint_blob",
  }).value;
  if (
    value.schema !== "openthrottle.github-push-checkpoint/v1" ||
    (value.ref_mode !== "create" && value.ref_mode !== "update") ||
    typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
    typeof value.ref !== "string" || !TASK_REF.test(value.ref) ||
    typeof value.expected_old_subject !== "string" || !SUBJECT.test(value.expected_old_subject) ||
    typeof value.expected_new_subject !== "string" || !SUBJECT.test(value.expected_new_subject) ||
    typeof value.checkpoint_base_subject !== "string" || !SUBJECT.test(value.checkpoint_base_subject) ||
    value.expected_old_subject !== value.checkpoint_base_subject ||
    value.expected_new_subject !== intent.subject ||
    typeof value.checkpoint_tree !== "string" || !SUBJECT.test(value.checkpoint_tree) ||
    blob.encoding !== "binary" || blob.media_type !== "application/x-git-bundle" ||
    blob.payload_schema !== "openthrottle.git-checkpoint-bundle/v1"
  ) throw new Error(`effect ${intent.id} has invalid GitHub checkpoint push authority`);
  return { ...(value as unknown as PushPayload), checkpoint_blob: blob };
}

function pullRequestPayload(intent: Readonly<EffectIntent>): PullRequestPayload {
  const value = object(intent.payload, `effect ${intent.id} payload`);
  exactKeys(value, [
    "schema", "repository", "branch", "base_branch", "expected_head_subject",
    "title", "body", "ownership_marker",
  ], "GitHub pull request payload");
  if (
    value.schema !== "openthrottle.github-pull-request/v1" ||
    typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
    typeof value.branch !== "string" || !TASK_REF.test(`refs/heads/${value.branch}`) ||
    typeof value.base_branch !== "string" || value.base_branch.length < 1 || value.base_branch.length > 300 ||
    typeof value.expected_head_subject !== "string" || !SUBJECT.test(value.expected_head_subject) ||
    value.expected_head_subject !== intent.subject ||
    typeof value.title !== "string" || value.title.length < 1 || value.title.length > 256 ||
    typeof value.body !== "string" || value.body.length > 32_000 ||
    typeof value.ownership_marker !== "string" || !/^[a-z0-9:_-]{16,200}$/.test(value.ownership_marker)
  ) throw new Error(`effect ${intent.id} has invalid GitHub pull request authority`);
  return value as unknown as PullRequestPayload;
}

function waitPayload(intent: Readonly<EffectIntent>): ProviderWaitPayload {
  const value = object(intent.payload, `effect ${intent.id} payload`);
  exactKeys(value, ["schema", "repository", "subject", "policy"], "GitHub provider wait payload");
  if (
    value.schema !== "openthrottle.github-provider-wait/v1" ||
    typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
    typeof value.subject !== "string" || !SUBJECT.test(value.subject) || value.subject !== intent.subject
  ) throw new Error(`effect ${intent.id} has invalid GitHub provider wait authority`);
  const parsed = validateGithubProviderEvidencePolicy(value.policy, {
    source: `effect ${intent.id} payload.policy`,
  }).value;
  return {
    schema: "openthrottle.github-provider-wait/v1",
    repository: value.repository,
    subject: value.subject,
    policy: parsed,
  };
}

async function githubJson<T>(client: GithubClient, path: string): Promise<{ status: number; value: T | null }> {
  const response = await githubApiResponse(client, path, {
    headers: { "User-Agent": "openthrottle" },
  });
  const raw = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub reconciliation failed (${response.status}): ${raw.slice(-1_000)}`);
  }
  return { status: response.status, value: raw ? JSON.parse(raw) as T : null };
}

async function collectPullRequests(
  client: GithubClient,
  payload: PullRequestPayload,
): Promise<PullRequestCollection> {
  const owner = payload.repository.split("/")[0]!;
  const entries: unknown[] = [];
  for (let page = 1; page <= PULL_REQUEST_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${payload.branch}`,
      base: payload.base_branch,
      per_page: String(PULL_REQUEST_PAGE_SIZE),
      page: String(page),
    });
    const response = await githubJson<unknown>(
      client,
      `/repos/${payload.repository}/pulls?${query.toString()}`,
    );
    if (response.status === 404) return { kind: "ok", entries: [] };
    if (!Array.isArray(response.value) || response.value.length > PULL_REQUEST_PAGE_SIZE) {
      return { kind: "unknown", detail: `GitHub pull request page ${page} is malformed` };
    }
    entries.push(...response.value);
    if (response.value.length < PULL_REQUEST_PAGE_SIZE) return { kind: "ok", entries };
  }
  return {
    kind: "unknown",
    detail: `GitHub pull request pagination bound of ${PULL_REQUEST_MAX_PAGES} pages was exhausted`,
  };
}

function exactOwnedPullRequests(
  entries: readonly unknown[],
  payload: PullRequestPayload,
): Record<string, unknown>[] {
  const canonicalBody = buildGithubPullRequestBody(payload.body, payload.ownership_marker);
  return entries.filter((candidate): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const pull = candidate as Record<string, unknown>;
    const head = pull.head;
    const base = pull.base;
    if (
      !head || typeof head !== "object" || Array.isArray(head) ||
      !base || typeof base !== "object" || Array.isArray(base)
    ) return false;
    const headValue = head as Record<string, unknown>;
    const baseValue = base as Record<string, unknown>;
    const headRepository = headValue.repo;
    return (
      headValue.sha === payload.expected_head_subject &&
      headValue.ref === payload.branch &&
      headRepository !== null && typeof headRepository === "object" && !Array.isArray(headRepository) &&
      typeof (headRepository as Record<string, unknown>).full_name === "string" &&
      ((headRepository as Record<string, unknown>).full_name as string).toLowerCase() ===
        payload.repository.toLowerCase() &&
      baseValue.ref === payload.base_branch &&
      pull.title === payload.title &&
      pull.body === canonicalBody
    );
  });
}

function exactPullRequestCoordinates(
  entries: readonly unknown[],
  payload: PullRequestPayload,
): Record<string, unknown>[] {
  return entries.filter((candidate): candidate is Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const pull = candidate as Record<string, unknown>;
    const head = pull.head;
    const base = pull.base;
    if (
      !head || typeof head !== "object" || Array.isArray(head) ||
      !base || typeof base !== "object" || Array.isArray(base)
    ) return false;
    const headValue = head as Record<string, unknown>;
    const headRepository = headValue.repo;
    return headValue.sha === payload.expected_head_subject && headValue.ref === payload.branch &&
      headRepository !== null && typeof headRepository === "object" && !Array.isArray(headRepository) &&
      typeof (headRepository as Record<string, unknown>).full_name === "string" &&
      ((headRepository as Record<string, unknown>).full_name as string).toLowerCase() ===
        payload.repository.toLowerCase() &&
      (base as Record<string, unknown>).ref === payload.base_branch;
  });
}

async function githubPage(
  client: GithubClient,
  path: string,
  field: "check_runs" | "statuses",
  page: number,
): Promise<PageCollection> {
  const query = new URLSearchParams({
    per_page: String(PROVIDER_PAGE_SIZE),
    page: String(page),
  });
  if (field === "check_runs") query.set("filter", "latest");
  const response = await githubJson<unknown>(client, `${path}?${query.toString()}`);
  if (response.status === 404) return { kind: "not_found" };
  let value: Record<string, unknown>;
  try {
    value = object(response.value, `GitHub ${field} page ${page}`);
  } catch (error) {
    return { kind: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
  const entries = value[field];
  if (!Array.isArray(entries) || entries.length > PROVIDER_PAGE_SIZE) {
    return { kind: "unknown", detail: `GitHub ${field} page ${page} is malformed` };
  }
  return { kind: "ok", entries };
}

async function githubPages(
  client: GithubClient,
  path: string,
  field: "check_runs" | "statuses",
): Promise<PageCollection> {
  const entries: unknown[] = [];
  let firstPageDigest: string | null = null;
  let complete = false;
  for (let page = 1; page <= PROVIDER_MAX_PAGES; page += 1) {
    const result = await githubPage(client, path, field, page);
    if (result.kind !== "ok") return result;
    if (page === 1) firstPageDigest = canonicalJson(result.entries as JsonValue);
    entries.push(...result.entries);
    if (result.entries.length < PROVIDER_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    return {
      kind: "unknown",
      detail: `GitHub ${field} pagination bound of ${PROVIDER_MAX_PAGES} pages was exhausted`,
    };
  }
  const verification = await githubPage(client, path, field, 1);
  if (verification.kind !== "ok") return verification;
  if (canonicalJson(verification.entries as JsonValue) !== firstPageDigest) {
    return {
      kind: "unknown",
      detail: `GitHub ${field} pagination window changed while evidence was collected`,
    };
  }
  return { kind: "ok", entries };
}

async function collectGithubPages(
  client: GithubClient,
  path: string,
  field: "check_runs" | "statuses",
): Promise<PageCollection> {
  try {
    return await githubPages(client, path, field);
  } catch (error) {
    return {
      kind: "unknown",
      detail: `GitHub ${field} observation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function checkRunIdentity(
  entry: Record<string, unknown>,
  requirement: Extract<GithubObservationRequirement, { kind: "check_run" }>,
): boolean {
  if (entry.name !== requirement.name) return false;
  const app = entry.app;
  return Boolean(app && typeof app === "object" && !Array.isArray(app) &&
    (app as Record<string, unknown>).slug === requirement.app_slug);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function checkRunKey(value: { name: string; app_slug: string }): string {
  return `${value.name}\0${value.app_slug}`;
}

function parseConsumedCheckRun(
  value: unknown,
  state: { name: string; app_slug: string },
  label: string,
): ConsumedCheckRunObservation {
  const input = object(value, label);
  exactKeys(input, ["observed_at", "observation"], label);
  const observation = object(input.observation, `${label}.observation`);
  exactKeys(observation, ["kind", "id", "name", "app_slug", "status", "conclusion"], `${label}.observation`);
  if (
    observation.kind !== "check_run" || positiveId(observation.id) === null ||
    observation.name !== state.name || observation.app_slug !== state.app_slug ||
    observation.status !== "completed" || typeof observation.conclusion !== "string"
  ) throw new Error(`${label} is not an exact completed check-run observation`);
  return {
    observed_at: canonicalTimestamp(input.observed_at, `${label}.observed_at`),
    observation: observation as JsonValue,
  };
}

function providerWaitContinuation(
  value: JsonValue | null | undefined,
  payload: ProviderWaitPayload,
): ProviderWaitContinuation {
  if (value === null || value === undefined) {
    return {
      schema: "openthrottle.github-provider-wait-continuation/v1",
      subject: payload.subject,
      check_runs: [],
    };
  }
  const input = object(value, "GitHub provider wait continuation");
  exactKeys(input, ["schema", "subject", "check_runs"], "GitHub provider wait continuation");
  if (
    input.schema !== "openthrottle.github-provider-wait-continuation/v1" ||
    input.subject !== payload.subject || !Array.isArray(input.check_runs) ||
    input.check_runs.length > payload.policy.required_observations.length
  ) throw new Error("GitHub provider wait continuation does not match the sealed wait");
  const required = new Set(payload.policy.required_observations.flatMap((requirement) =>
    requirement.kind === "check_run" ? [checkRunKey(requirement)] : []));
  const checkRuns = input.check_runs.map((candidate, index): FailedCheckRunState => {
    const label = `GitHub provider wait continuation.check_runs[${index}]`;
    const state = object(candidate, label);
    exactKeys(
      state,
      [
        "name", "app_slug", "first_failed_at", "failed_observations",
        ...(state.success_observation === undefined ? [] : ["success_observation"]),
      ],
      label,
    );
    if (
      typeof state.name !== "string" || typeof state.app_slug !== "string" ||
      !required.has(checkRunKey({ name: state.name, app_slug: state.app_slug })) ||
      !Array.isArray(state.failed_observations) || state.failed_observations.length < 1 ||
      state.failed_observations.length >= CHECK_RUN_FAILURE_LIMIT
    ) throw new Error(`${label} is not bounded exact required-check evidence`);
    const identity = { name: state.name, app_slug: state.app_slug };
    const failures = state.failed_observations.map((observation, observationIndex) =>
      parseConsumedCheckRun(observation, identity, `${label}.failed_observations[${observationIndex}]`));
    if (failures.some(({ observation }) =>
      (observation as Record<string, JsonValue>).conclusion === "success")) {
      throw new Error(`${label} contains a successful failed observation`);
    }
    const firstFailedAt = canonicalTimestamp(state.first_failed_at, `${label}.first_failed_at`);
    if (firstFailedAt !== failures[0]!.observed_at) {
      throw new Error(`${label}.first_failed_at does not match its first observation`);
    }
    const ids = failures.map(({ observation }) => (observation as Record<string, JsonValue>).id);
    if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate failed observations`);
    const success = state.success_observation === undefined
      ? undefined
      : parseConsumedCheckRun(state.success_observation, identity, `${label}.success_observation`);
    if (
      success && (success.observation as Record<string, JsonValue>).conclusion !== "success"
    ) throw new Error(`${label}.success_observation is not successful`);
    return {
      name: identity.name,
      app_slug: identity.app_slug,
      first_failed_at: firstFailedAt,
      failed_observations: failures,
      ...(success ? { success_observation: success } : {}),
    };
  });
  if (new Set(checkRuns.map(checkRunKey)).size !== checkRuns.length) {
    throw new Error("GitHub provider wait continuation contains duplicate required checks");
  }
  return {
    schema: "openthrottle.github-provider-wait-continuation/v1",
    subject: payload.subject,
    check_runs: checkRuns,
  };
}

function commitStatusIdentity(
  entry: Record<string, unknown>,
  requirement: Extract<GithubObservationRequirement, { kind: "commit_status" }>,
): boolean {
  if (entry.context !== requirement.context) return false;
  const creator = entry.creator;
  return Boolean(creator && typeof creator === "object" && !Array.isArray(creator) &&
    (creator as Record<string, unknown>).login === requirement.creator_login);
}

function checkRunResolution(
  requirement: Extract<GithubObservationRequirement, { kind: "check_run" }>,
  id: number,
  entry: Record<string, unknown>,
): RequiredObservationResolution {
  const status = entry.status;
  const conclusion = entry.conclusion;
  if (typeof status !== "string") {
    return { state: "unknown", detail: `required check run ${requirement.name} has malformed status` };
  }
  if (status === "completed") {
    if (typeof conclusion !== "string") {
      return { state: "unknown", detail: `completed required check run ${requirement.name} has malformed conclusion` };
    }
    return {
      state: conclusion === "success" ? "success" : "failure",
      observation: {
        kind: "check_run", id, name: requirement.name, app_slug: requirement.app_slug,
        status, conclusion,
      },
    };
  }
  if (!["queued", "in_progress", "pending", "requested", "waiting"].includes(status)) {
    return { state: "unknown", detail: `required check run ${requirement.name} has unknown status ${status}` };
  }
  if (conclusion !== null && typeof conclusion !== "string") {
    return { state: "unknown", detail: `pending required check run ${requirement.name} has malformed conclusion` };
  }
  return {
    state: "pending",
    observation: {
      kind: "check_run", id, name: requirement.name, app_slug: requirement.app_slug,
      status, conclusion,
    },
  };
}

function commitStatusResolution(
  requirement: Extract<GithubObservationRequirement, { kind: "commit_status" }>,
  id: number,
  entry: Record<string, unknown>,
): RequiredObservationResolution {
  const state = entry.state;
  if (typeof state !== "string") {
    return { state: "unknown", detail: `required commit status ${requirement.context} has malformed state` };
  }
  if (!["success", "pending", "failure", "error"].includes(state)) {
    return { state: "unknown", detail: `required commit status ${requirement.context} has unknown state ${state}` };
  }
  return {
    state: state === "success" ? "success" : state === "pending" ? "pending" : "failure",
    observation: {
      kind: "commit_status", id, context: requirement.context,
      creator_login: requirement.creator_login, state,
    },
  };
}

function resolveRequiredObservation(
  requirement: GithubObservationRequirement,
  entries: readonly unknown[],
  subject: string,
): RequiredObservationResolution {
  const exact: Record<string, unknown>[] = [];
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const matches = requirement.kind === "check_run"
      ? checkRunIdentity(entry, requirement)
      : commitStatusIdentity(entry, requirement);
    if (!matches) continue;
    if (requirement.kind === "check_run") {
      if (typeof entry.head_sha !== "string" || !SUBJECT.test(entry.head_sha)) {
        return { state: "unknown", detail: `required check run ${requirement.name} has malformed head SHA` };
      }
      if (entry.head_sha !== subject) continue;
    }
    exact.push(entry);
  }
  if (exact.length === 0) return { state: "missing" };

  if (exact.length !== 1) {
    return {
      state: "unknown",
      detail: `required ${requirement.kind} observation has multiple exact matches`,
    };
  }
  const entry = exact[0]!;
  const id = positiveId(entry.id);
  if (id === null) {
    return { state: "unknown", detail: `required ${requirement.kind} observation has malformed id` };
  }
  return requirement.kind === "check_run"
    ? checkRunResolution(requirement, id, entry)
    : commitStatusResolution(requirement, id, entry);
}

function providerObservationPayload(
  payload: ProviderWaitPayload,
  reason: string,
  observations: readonly JsonValue[],
  rejection?: {
    check_name: string;
    failed_observation_count: number;
    window_minutes: number;
    cause: CheckRunRejectionCause;
  },
): JsonValue {
  return {
    schema: "openthrottle.github-provider-observation/v1",
    subject: payload.subject,
    reason,
    matched_observations: [...observations],
    ...(rejection ? { rejection } : {}),
  };
}

function resolutionObservations(resolutions: readonly RequiredObservationResolution[]): JsonValue[] {
  return resolutions.flatMap((resolution) =>
    "observation" in resolution ? [resolution.observation] : []);
}

function consumedObservations(continuation: ProviderWaitContinuation): JsonValue[] {
  return continuation.check_runs.flatMap((state) => [
    ...state.failed_observations.map(({ observation }) => observation),
    ...(state.success_observation ? [state.success_observation.observation] : []),
  ]);
}

function distinctObservations(observations: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const input = observation as Record<string, JsonValue>;
    const key = `${String(input.kind)}\0${String(input.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failedCheckRunSummary(
  continuation: ProviderWaitContinuation,
  checkName: string,
): { firstFailedAt: number; failedObservationCount: number } {
  let firstFailedAt = Number.POSITIVE_INFINITY;
  let failedObservationCount = 0;
  for (const state of continuation.check_runs) {
    if (state.name !== checkName) continue;
    firstFailedAt = Math.min(firstFailedAt, Date.parse(state.first_failed_at));
    failedObservationCount += state.failed_observations.length;
  }
  return { firstFailedAt, failedObservationCount };
}

function rejectedCheckRunObservation(
  input: {
    payload: ProviderWaitPayload;
    checkName: string;
    failedObservationCount: number;
    cause: CheckRunRejectionCause;
    observations: readonly JsonValue[];
  },
): Extract<KernelEffectProviderObservation, { kind: "found" }> {
  return {
    kind: "found",
    status: "rejected",
    payload: providerObservationPayload(
      input.payload,
      `required check run ${JSON.stringify(input.checkName)} rejected after ` +
        `${input.failedObservationCount} failed observation${input.failedObservationCount === 1 ? "" : "s"} in the ` +
        `${CHECK_RUN_REOBSERVATION_WINDOW_MINUTES}-minute re-observation window ` +
        `(${input.cause === "failure_budget_exhausted" ? "failure budget exhausted" : "window expired"})`,
      input.observations,
      {
        check_name: input.checkName,
        failed_observation_count: input.failedObservationCount,
        window_minutes: CHECK_RUN_REOBSERVATION_WINDOW_MINUTES,
        cause: input.cause,
      },
    ),
  };
}

export class GithubKernelAdapter {
  readonly #client: GithubClient;
  readonly #blobs: VolumeBlobStore;

  constructor(input: { token: string; blob_store: VolumeBlobStore; fetch?: typeof fetch }) {
    this.#client = { token: input.token, ...(input.fetch ? { fetch: input.fetch } : {}) };
    this.#blobs = input.blob_store;
  }

  effectBindings(): readonly KernelEffectAdapterBinding[] {
    return [
      {
        effect_kind: "github/push-checkpoint@1", provider: "github", operation: "mutation",
        idempotency_strategy: "deterministic_target",
        adapter: {
          reconcile: ({ intent }) => this.#reconcilePush(intent),
          dispatch: ({ intent }) => this.#dispatchPush(intent),
        },
      },
      {
        effect_kind: "github/upsert-pull-request@1", provider: "github", operation: "mutation",
        idempotency_strategy: "deterministic_target",
        adapter: {
          reconcile: ({ intent }) => this.#reconcilePullRequest(intent),
          dispatch: ({ intent }) => this.#dispatchPullRequest(intent),
        },
      },
      {
        effect_kind: "github/provider-wait@1", provider: "github", operation: "observation",
        idempotency_strategy: "deterministic_target",
        adapter: {
          reconcile: ({ intent, observed_at, continuation }) =>
            this.#reconcileProvider(intent, observed_at, continuation),
          dispatch: async () => { throw new Error("provider wait is observation-only"); },
        },
      },
    ];
  }

  async #ref(repository: string, ref: string): Promise<string | null> {
    const result = await githubJson<{ object?: { sha?: unknown } }>(
      this.#client,
      `/repos/${repository}/git/ref/${encodeURIComponent(ref.replace(/^refs\//, ""))}`,
    );
    const sha = result.value?.object?.sha;
    if (result.status === 404) return null;
    if (typeof sha !== "string" || !SUBJECT.test(sha)) throw new Error("GitHub returned an invalid ref SHA");
    return sha;
  }

  async #reconcilePush(intent: Readonly<EffectIntent>): Promise<KernelEffectProviderObservation> {
    const payload = pushPayload(intent);
    const current = await this.#ref(payload.repository, payload.ref);
    if (current === payload.expected_new_subject) {
      return {
        kind: "found",
        status: "confirmed",
        payload: {
          schema: "openthrottle.github-push-delivery/v1",
          repository: payload.repository,
          ref: payload.ref,
          sha: current,
          ref_mode: payload.ref_mode,
        },
      };
    }
    if (payload.ref_mode === "create" && current === null) {
      const parent = await githubJson<unknown>(
        this.#client,
        `/repos/${payload.repository}/git/commits/${payload.expected_old_subject}`,
      );
      if (parent.status === 404) {
        return {
          kind: "found",
          status: "rejected",
          payload: {
            schema: "openthrottle.github-push-delivery/v1",
            repository: payload.repository,
            ref: payload.ref,
            sha: payload.expected_new_subject,
            ref_mode: payload.ref_mode,
            expected_old_subject: payload.expected_old_subject,
            actual: null,
            reason: "publication_parent_missing",
          },
        };
      }
      if (
        !parent.value || typeof parent.value !== "object" || Array.isArray(parent.value) ||
        (parent.value as Record<string, unknown>).sha !== payload.expected_old_subject
      ) {
        return { kind: "unknown", detail: "GitHub returned invalid publication parent evidence" };
      }
      return { kind: "not_found" };
    }
    if (payload.ref_mode === "update" && current === payload.expected_old_subject) {
      return { kind: "not_found" };
    }
    return {
      kind: "found", status: "rejected",
      payload: {
        schema: "openthrottle.github-push-delivery/v1",
        repository: payload.repository,
        ref: payload.ref,
        sha: payload.expected_new_subject,
        ref_mode: payload.ref_mode,
        expected_old_subject: payload.expected_old_subject,
        actual: current,
        reason: current === null ? "ref_missing" : "ref_conflict",
      },
    };
  }

  async #dispatchPush(intent: Readonly<EffectIntent>): Promise<void> {
    const payload = pushPayload(intent);
    const bytes = this.#blobs.read(payload.checkpoint_blob);
    await pushRepositoryCheckpoint(this.#client, {
      repository: payload.repository,
      ref: payload.ref,
      mode: payload.ref_mode,
      expectedOldSha: payload.expected_old_subject,
      expectedNewSha: payload.expected_new_subject,
      checkpointBaseSha: payload.checkpoint_base_subject,
      allowAlreadyAdvanced: true,
      checkpointObject: {
        payload: bytes,
        payloadBytes: payload.checkpoint_blob.bytes,
        payloadSha256: payload.checkpoint_blob.digest,
        expectedTreeSha: payload.checkpoint_tree,
      },
    });
  }

  async #reconcilePullRequest(intent: Readonly<EffectIntent>): Promise<KernelEffectProviderObservation> {
    const payload = pullRequestPayload(intent);
    const history = await collectPullRequests(this.#client, payload);
    if (history.kind === "unknown") return history;
    const matches = exactOwnedPullRequests(history.entries, payload);
    if (matches.length > 1) {
      return { kind: "unknown", detail: "multiple owned pull requests match one publication" };
    }
    const match = matches[0];
    if (match) {
      if (typeof match.html_url !== "string" || match.html_url.length === 0) {
        return { kind: "unknown", detail: "owned pull request has an invalid URL" };
      }
      if (match.state === "open" && match.merged_at === null) {
        return { kind: "found", status: "confirmed", payload: { url: match.html_url } };
      }
      if (match.state === "closed" && typeof match.merged_at === "string" && match.merged_at.length > 0) {
        return { kind: "found", status: "confirmed", payload: { url: match.html_url } };
      }
      if (match.state === "closed" && match.merged_at === null) {
        return {
          kind: "found",
          status: "rejected",
          payload: {
            repository: payload.repository,
            branch: payload.branch,
            base_branch: payload.base_branch,
            expected_head_subject: payload.expected_head_subject,
            url: match.html_url,
            reason: "pull_request_closed_unmerged",
          },
        };
      }
      return { kind: "unknown", detail: "owned pull request has invalid state evidence" };
    }
    if (exactPullRequestCoordinates(history.entries, payload).length > 0) {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          base_branch: payload.base_branch,
          expected_head_subject: payload.expected_head_subject,
          reason: "pull_request_immutable_payload_conflict",
        },
      };
    }

    const currentHead = await this.#ref(payload.repository, `refs/heads/${payload.branch}`);
    if (currentHead === null) {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          base_branch: payload.base_branch,
          expected_head_subject: payload.expected_head_subject,
          reason: "task_ref_missing",
        },
      };
    }
    if (currentHead !== payload.expected_head_subject) {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          expected_head_subject: payload.expected_head_subject,
          actual_head_subject: currentHead,
          reason: "ref_conflict",
        },
      };
    }
    const baseHead = await this.#ref(payload.repository, `refs/heads/${payload.base_branch}`);
    if (baseHead === null) {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          base_branch: payload.base_branch,
          expected_head_subject: payload.expected_head_subject,
          reason: "base_ref_missing",
        },
      };
    }
    const comparison = await githubJson<{
      merge_base_commit?: { sha?: unknown };
      status?: unknown;
      ahead_by?: unknown;
    }>(
      this.#client,
      `/repos/${payload.repository}/compare/${baseHead}...${payload.expected_head_subject}`,
    );
    if (comparison.status === 404) {
      const [baseCommit, headCommit] = await Promise.all([
        githubJson<{ sha?: unknown }>(
          this.#client,
          `/repos/${payload.repository}/git/commits/${baseHead}`,
        ),
        githubJson<{ sha?: unknown }>(
          this.#client,
          `/repos/${payload.repository}/git/commits/${payload.expected_head_subject}`,
        ),
      ]);
      if (
        baseCommit.status !== 200 || baseCommit.value?.sha !== baseHead ||
        headCommit.status !== 200 || headCommit.value?.sha !== payload.expected_head_subject
      ) {
        return {
          kind: "unknown",
          detail: "GitHub comparison 404 lacked exact base and head commit evidence",
        };
      }
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          base_branch: payload.base_branch,
          expected_head_subject: payload.expected_head_subject,
          reason: "no_common_ancestor",
        },
      };
    }
    const mergeBase = comparison.value?.merge_base_commit?.sha;
    if (typeof mergeBase !== "string" || !SUBJECT.test(mergeBase)) {
      return { kind: "unknown", detail: "GitHub comparison returned invalid merge-base evidence" };
    }
    const comparisonStatus = comparison.value?.status;
    const aheadBy = comparison.value?.ahead_by;
    if (
      !["ahead", "behind", "diverged", "identical"].includes(String(comparisonStatus)) ||
      !Number.isSafeInteger(aheadBy) || (aheadBy as number) < 0
    ) return { kind: "unknown", detail: "GitHub comparison returned invalid containment evidence" };
    if (aheadBy === 0 && (comparisonStatus === "behind" || comparisonStatus === "identical")) {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          repository: payload.repository,
          branch: payload.branch,
          base_branch: payload.base_branch,
          expected_head_subject: payload.expected_head_subject,
          reason: "expected_head_already_in_base",
        },
      };
    }
    if (aheadBy === 0 || (comparisonStatus !== "ahead" && comparisonStatus !== "diverged")) {
      return { kind: "unknown", detail: "GitHub comparison returned inconsistent containment evidence" };
    }
    return { kind: "not_found" };
  }

  async #dispatchPullRequest(intent: Readonly<EffectIntent>): Promise<void> {
    const payload = pullRequestPayload(intent);
    await publishRepositoryTaskBranch(this.#client, {
      repository: payload.repository,
      branch: payload.branch,
      baseBranch: payload.base_branch,
      expectedHeadSha: payload.expected_head_subject,
      title: payload.title,
      body: payload.body,
      ownershipMarker: payload.ownership_marker,
    });
  }

  async #reconcileProvider(
    intent: Readonly<EffectIntent>,
    observedAtInput?: string,
    continuationInput?: JsonValue | null,
  ): Promise<KernelEffectProviderObservation> {
    const payload = waitPayload(intent);
    const observedAt = canonicalTimestamp(
      observedAtInput ?? new Date().toISOString(),
      "GitHub provider observation time",
    );
    const observedAtMs = Date.parse(observedAt);
    const continuation = providerWaitContinuation(continuationInput, payload);
    const expired = continuation.check_runs.find((state) => {
      if (state.success_observation !== undefined) return false;
      const { firstFailedAt } = failedCheckRunSummary(continuation, state.name);
      return observedAtMs >= firstFailedAt + CHECK_RUN_REOBSERVATION_WINDOW_MS;
    });
    if (expired) {
      const { failedObservationCount } = failedCheckRunSummary(continuation, expired.name);
      return rejectedCheckRunObservation({
        payload,
        checkName: expired.name,
        failedObservationCount,
        cause: "window_expired",
        observations: consumedObservations(continuation),
      });
    }
    const needsChecks = payload.policy.required_observations.some(({ kind }) => kind === "check_run");
    const needsStatuses = payload.policy.required_observations.some(({ kind }) => kind === "commit_status");
    const [checks, statuses] = await Promise.all([
      needsChecks
        ? collectGithubPages(
          this.#client,
          `/repos/${payload.repository}/commits/${payload.subject}/check-runs`,
          "check_runs",
        )
        : Promise.resolve({ kind: "ok", entries: [] } satisfies PageCollection),
      needsStatuses
        ? collectGithubPages(
          this.#client,
          `/repos/${payload.repository}/commits/${payload.subject}/status`,
          "statuses",
        )
        : Promise.resolve({ kind: "ok", entries: [] } satisfies PageCollection),
    ]);

    const resolutions = payload.policy.required_observations.map((requirement) => {
      const collection = requirement.kind === "check_run" ? checks : statuses;
      if (collection.kind === "not_found") return { state: "missing" } as const;
      if (collection.kind === "unknown") {
        return { state: "unknown", detail: collection.detail } as const;
      }
      return resolveRequiredObservation(requirement, collection.entries, payload.subject);
    });
    const commitFailure = resolutions.find((resolution, index) =>
      payload.policy.required_observations[index]?.kind === "commit_status" &&
      resolution.state === "failure");
    if (commitFailure) {
      return {
        kind: "found",
        status: "rejected",
        payload: providerObservationPayload(
          payload,
          "required_observation_failed",
          distinctObservations([
            ...consumedObservations(continuation),
            ...resolutionObservations(resolutions),
          ]),
        ),
      };
    }
    for (let index = 0; index < payload.policy.required_observations.length; index += 1) {
      const requirement = payload.policy.required_observations[index]!;
      if (requirement.kind !== "check_run") continue;
      const resolution = resolutions[index]!;
      let state = continuation.check_runs.find((candidate) =>
        checkRunKey(candidate) === checkRunKey(requirement));
      if (resolution.state === "failure") {
        if (!state) {
          state = {
            name: requirement.name,
            app_slug: requirement.app_slug,
            first_failed_at: observedAt,
            failed_observations: [],
          };
          continuation.check_runs.push(state);
        }
        const observationId = (resolution.observation as Record<string, JsonValue>).id;
        if (!state.failed_observations.some(({ observation }) =>
          (observation as Record<string, JsonValue>).id === observationId)) {
          state.failed_observations.push({ observed_at: observedAt, observation: resolution.observation });
        }
      }
      if (!state) continue;

      if (state.success_observation) continue;

      const { firstFailedAt, failedObservationCount } =
        failedCheckRunSummary(continuation, requirement.name);
      const windowExpired = observedAtMs >= firstFailedAt + CHECK_RUN_REOBSERVATION_WINDOW_MS;
      const budgetExhausted = failedObservationCount >= CHECK_RUN_FAILURE_LIMIT;
      if (budgetExhausted || windowExpired) {
        const cause = budgetExhausted ? "failure_budget_exhausted" : "window_expired";
        return rejectedCheckRunObservation({
          payload,
          checkName: requirement.name,
          failedObservationCount,
          cause,
          observations: distinctObservations([
            ...consumedObservations(continuation),
            ...resolutionObservations(resolutions),
          ]),
        });
      }
      if (resolution.state === "success") {
        state.success_observation = { observed_at: observedAt, observation: resolution.observation };
      }
    }

    const awaitingSuccessfulRerun = continuation.check_runs.find((state) =>
      state.success_observation === undefined);
    if (awaitingSuccessfulRerun) {
      return {
        kind: "retry",
        detail: `required check run ${JSON.stringify(awaitingSuccessfulRerun.name)} has ` +
          `${awaitingSuccessfulRerun.failed_observations.length} failed observation` +
          `${awaitingSuccessfulRerun.failed_observations.length === 1 ? "" : "s"}; waiting up to ` +
          `${CHECK_RUN_REOBSERVATION_WINDOW_MINUTES} minutes for a same-head successful re-run`,
        continuation: continuation as unknown as JsonValue,
      };
    }
    const indeterminate = resolutions.find(({ state }) => state === "unknown");
    if (indeterminate?.state === "unknown") {
      return { kind: "unknown", detail: indeterminate.detail };
    }
    const incomplete = resolutions.some((resolution, index) => {
      if (
        resolution.state !== "missing" && resolution.state !== "pending" &&
        resolution.state !== "failure"
      ) return false;
      const requirement = payload.policy.required_observations[index]!;
      return requirement.kind !== "check_run" || !continuation.check_runs.some((state) =>
        checkRunKey(state) === checkRunKey(requirement) && state.success_observation !== undefined);
    });
    if (incomplete) {
      return continuation.check_runs.length === 0
        ? { kind: "not_found" }
        : {
          kind: "retry",
          detail: "required provider observations remain pending after a successful check re-run",
          continuation: continuation as unknown as JsonValue,
        };
    }
    return {
      kind: "found",
      status: "confirmed",
      payload: providerObservationPayload(
        payload,
        "all_required_observations_succeeded",
        distinctObservations([
          ...consumedObservations(continuation),
          ...resolutionObservations(resolutions),
        ]),
      ),
    };
  }
}
