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
import {
  EFFECT_CONTINUATION_STATE_SCHEMA,
  validateEffectContinuationState,
  type EffectContinuationState,
} from "../../pipeline/kernel/effect-intent.js";
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
    completed_check_runs?: CheckRunObservation[];
  };

interface CheckRunObservation {
  kind: "check_run";
  id: number;
  name: string;
  app_slug: string;
  status: string;
  conclusion: string;
}

interface CheckRunContinuation {
  name: string;
  app_slug: string;
  first_failed_at: string | null;
  failed_observation_count: number;
  failed_observation_ids: number[];
  successful_observation_id: number | null;
}

interface ProviderWaitContinuation {
  schema: "openthrottle.github-provider-wait-continuation/v1";
  subject: string;
  checks: CheckRunContinuation[];
  observations: CheckRunObservation[];
}

const PROVIDER_PAGE_SIZE = 100;
const PROVIDER_MAX_PAGES = 10;
const PULL_REQUEST_PAGE_SIZE = 100;
const PULL_REQUEST_MAX_PAGES = 10;
const CHECK_RERUN_WINDOW_MINUTES = 30;
const CHECK_RERUN_WINDOW_MS = CHECK_RERUN_WINDOW_MINUTES * 60 * 1_000;
const CHECK_FAILURE_LIMIT = 3;
const NO_ACTIVE_CHECK_DEADLINE = "9999-12-31T23:59:59.999Z";

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

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function checkKey(name: string, appSlug: string): string {
  return `${name}\0${appSlug}`;
}

function checkRunObservation(value: unknown, label: string): CheckRunObservation {
  const input = object(value, label);
  exactKeys(input, ["kind", "id", "name", "app_slug", "status", "conclusion"], label);
  const id = positiveId(input.id);
  if (
    input.kind !== "check_run" || id === null ||
    typeof input.name !== "string" || typeof input.app_slug !== "string" ||
    input.status !== "completed" || typeof input.conclusion !== "string"
  ) throw new Error(`${label} is malformed`);
  return {
    kind: "check_run",
    id,
    name: input.name,
    app_slug: input.app_slug,
    status: input.status,
    conclusion: input.conclusion,
  };
}

function providerWaitContinuation(
  state: Readonly<EffectContinuationState> | null | undefined,
  payload: ProviderWaitPayload,
): ProviderWaitContinuation {
  if (state == null) {
    return {
      schema: "openthrottle.github-provider-wait-continuation/v1",
      subject: payload.subject,
      checks: [],
      observations: [],
    };
  }
  const validated = validateEffectContinuationState(state, "github_provider_wait.continuation_state");
  const input = object(validated.payload, "github provider-wait continuation payload");
  exactKeys(input, ["schema", "subject", "checks", "observations"], "github provider-wait continuation payload");
  if (
    input.schema !== "openthrottle.github-provider-wait-continuation/v1" ||
    input.subject !== payload.subject || !Array.isArray(input.checks) ||
    input.checks.length > payload.policy.required_observations.length ||
    !Array.isArray(input.observations) || input.observations.length > 128
  ) throw new Error("github provider-wait continuation payload is malformed");

  const requiredChecks = new Set(payload.policy.required_observations.flatMap((requirement) =>
    requirement.kind === "check_run" ? [checkKey(requirement.name, requirement.app_slug)] : []));
  const observations = input.observations.map((observation, index) =>
    checkRunObservation(observation, `github provider-wait continuation observation ${index}`));
  const observationsById = new Map<number, CheckRunObservation>();
  for (const observation of observations) {
    if (!requiredChecks.has(checkKey(observation.name, observation.app_slug))) {
      throw new Error("github provider-wait continuation contains an unconfigured check observation");
    }
    if (observationsById.has(observation.id)) {
      throw new Error("github provider-wait continuation contains a duplicate observation id");
    }
    observationsById.set(observation.id, observation);
  }

  const seenChecks = new Set<string>();
  const checks = input.checks.map((candidate, index): CheckRunContinuation => {
    const label = `github provider-wait continuation check ${index}`;
    const check = object(candidate, label);
    exactKeys(check, [
      "name", "app_slug", "first_failed_at", "failed_observation_count",
      "failed_observation_ids", "successful_observation_id",
    ], label);
    if (
      typeof check.name !== "string" || typeof check.app_slug !== "string" ||
      !requiredChecks.has(checkKey(check.name, check.app_slug)) ||
      !Number.isSafeInteger(check.failed_observation_count) ||
      (check.failed_observation_count as number) < 0 ||
      (check.failed_observation_count as number) > CHECK_FAILURE_LIMIT ||
      !Array.isArray(check.failed_observation_ids) ||
      check.failed_observation_ids.length !== check.failed_observation_count ||
      (check.successful_observation_id !== null && positiveId(check.successful_observation_id) === null)
    ) throw new Error(`${label} is malformed`);
    const key = checkKey(check.name, check.app_slug);
    if (seenChecks.has(key)) throw new Error("github provider-wait continuation contains a duplicate check");
    seenChecks.add(key);
    const failedIds = check.failed_observation_ids.map((id) => {
      const parsed = positiveId(id);
      const observation = parsed === null ? undefined : observationsById.get(parsed);
      if (
        parsed === null || !observation || observation.name !== check.name ||
        observation.app_slug !== check.app_slug || observation.conclusion === "success"
      ) throw new Error(`${label} contains an invalid failed observation id`);
      return parsed;
    });
    const successfulId = check.successful_observation_id === null
      ? null
      : positiveId(check.successful_observation_id);
    if (successfulId !== null) {
      const observation = observationsById.get(successfulId);
      if (
        !observation || observation.name !== check.name ||
        observation.app_slug !== check.app_slug || observation.conclusion !== "success"
      ) throw new Error(`${label} contains an invalid successful observation id`);
    }
    const firstFailedAt = check.first_failed_at === null
      ? null
      : canonicalTimestamp(check.first_failed_at, `${label}.first_failed_at`);
    if ((failedIds.length === 0) !== (firstFailedAt === null)) {
      throw new Error(`${label} has inconsistent first-failure state`);
    }
    return {
      name: check.name,
      app_slug: check.app_slug,
      first_failed_at: firstFailedAt,
      failed_observation_count: failedIds.length,
      failed_observation_ids: failedIds,
      successful_observation_id: successfulId,
    };
  });
  return {
    schema: "openthrottle.github-provider-wait-continuation/v1",
    subject: payload.subject,
    checks,
    observations,
  };
}

function firstFailureForName(continuation: ProviderWaitContinuation, name: string): string | null {
  const failures = continuation.checks.flatMap((check) =>
    check.name === name && check.first_failed_at !== null ? [check.first_failed_at] : []);
  return failures.sort()[0] ?? null;
}

function failedCountForName(continuation: ProviderWaitContinuation, name: string): number {
  return continuation.checks.reduce((count, check) =>
    count + (check.name === name ? check.failed_observation_count : 0), 0);
}

function activeFailureNames(continuation: ProviderWaitContinuation): string[] {
  const names = continuation.checks
    .filter((check) =>
      check.failed_observation_count > 0 && check.successful_observation_id === null)
    .map(({ name }) => name);
  return [...new Set(names)].sort();
}

function deadlineForFirstFailure(firstFailedAt: string): string {
  return new Date(Date.parse(firstFailedAt) + CHECK_RERUN_WINDOW_MS).toISOString();
}

function effectContinuation(continuation: ProviderWaitContinuation): EffectContinuationState {
  const activeDeadlines = activeFailureNames(continuation).map((name) => {
    const firstFailedAt = firstFailureForName(continuation, name);
    if (firstFailedAt === null) throw new Error("active provider-wait failure has no first-failure time");
    return deadlineForFirstFailure(firstFailedAt);
  });
  return {
    schema: EFFECT_CONTINUATION_STATE_SCHEMA,
    retry_deadline: activeDeadlines.sort()[0] ?? NO_ACTIVE_CHECK_DEADLINE,
    payload: continuation as unknown as JsonValue,
  };
}

function rejectionReason(name: string, failedCount: number, expired: boolean): string {
  return expired
    ? `required check_run ${name} failed ${failedCount} observation${failedCount === 1 ? "" : "s"} and did not succeed within the ${CHECK_RERUN_WINDOW_MINUTES}-minute re-observation window`
    : `required check_run ${name} failed ${failedCount} observations within the ${CHECK_RERUN_WINDOW_MINUTES}-minute re-observation window`;
}

function rejectedCheckRunObservation(
  payload: ProviderWaitPayload,
  continuation: ProviderWaitContinuation,
  name: string,
  expired: boolean,
): KernelEffectProviderObservation {
  return {
    kind: "found",
    status: "rejected",
    payload: providerObservationPayload(
      payload,
      rejectionReason(name, failedCountForName(continuation, name), expired),
      terminalObservations(continuation, []),
    ),
  };
}

function hasSuccessfulObservation(check: CheckRunContinuation | undefined): boolean {
  return check?.successful_observation_id != null;
}

function checkRunIdentity(
  entry: Record<string, unknown>,
  requirement: Extract<GithubObservationRequirement, { kind: "check_run" }>,
  subject: string,
): boolean {
  if (entry.name !== requirement.name || entry.head_sha !== subject) return false;
  const app = entry.app;
  return Boolean(app && typeof app === "object" && !Array.isArray(app) &&
    (app as Record<string, unknown>).slug === requirement.app_slug);
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
      ? checkRunIdentity(entry, requirement, subject)
      : commitStatusIdentity(entry, requirement);
    if (matches) exact.push(entry);
  }
  if (exact.length === 0) return { state: "missing" };

  if (requirement.kind === "check_run") {
    const seenIds = new Set<number>();
    const resolutions: Array<{
      id: number;
      resolution: Exclude<RequiredObservationResolution, { state: "missing" | "unknown" }>;
    }> = [];
    for (const entry of exact) {
      const id = positiveId(entry.id);
      if (id === null) {
        return { state: "unknown", detail: "required check_run observation has malformed id" };
      }
      if (seenIds.has(id)) {
        return { state: "unknown", detail: "required check_run observation has duplicate provider id" };
      }
      seenIds.add(id);
      const resolution = checkRunResolution(requirement, id, entry);
      if (resolution.state === "unknown") return resolution;
      if (resolution.state === "missing") throw new Error("matched check_run unexpectedly resolved missing");
      resolutions.push({ id, resolution });
    }
    resolutions.sort((left, right) => left.id - right.id);
    const effective = resolutions.at(-1)!.resolution;
    return {
      ...effective,
      completed_check_runs: resolutions.flatMap(({ resolution }) =>
        resolution.state === "success" || resolution.state === "failure"
          ? [resolution.observation as unknown as CheckRunObservation]
          : []),
    };
  }

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
  return commitStatusResolution(requirement, id, entry);
}

function providerObservationPayload(
  payload: ProviderWaitPayload,
  reason: string,
  matchedObservations: readonly JsonValue[],
): JsonValue {
  return {
    schema: "openthrottle.github-provider-observation/v1",
    subject: payload.subject,
    reason,
    matched_observations: [...matchedObservations],
  };
}

function completedObservations(resolutions: readonly RequiredObservationResolution[]): JsonValue[] {
  return resolutions.flatMap((resolution) => {
    if ("completed_check_runs" in resolution && resolution.completed_check_runs !== undefined) {
      return resolution.completed_check_runs as unknown as JsonValue[];
    }
    return (resolution.state === "success" || resolution.state === "failure") && "observation" in resolution
      ? [resolution.observation]
      : [];
  });
}

function completedCheckRuns(resolution: RequiredObservationResolution): CheckRunObservation[] {
  return "completed_check_runs" in resolution
    ? resolution.completed_check_runs ?? []
    : [];
}

function terminalObservations(
  continuation: ProviderWaitContinuation,
  resolutions: readonly RequiredObservationResolution[],
): JsonValue[] {
  const observations: JsonValue[] = continuation.observations.map((observation) =>
    observation as unknown as JsonValue);
  const seenCheckRuns = new Set(continuation.observations.map(({ id }) => id));
  for (const observation of completedObservations(resolutions)) {
    const value = observation as Record<string, JsonValue>;
    if (value.kind === "check_run" && typeof value.id === "number") {
      if (seenCheckRuns.has(value.id)) continue;
      seenCheckRuns.add(value.id);
    }
    observations.push(observation);
  }
  return observations;
}

function rememberCheckRunObservation(
  continuation: ProviderWaitContinuation,
  observationIds: Set<number>,
  observation: CheckRunObservation,
): void {
  if (observationIds.has(observation.id)) return;
  continuation.observations.push(observation);
  observationIds.add(observation.id);
}

export class GithubKernelAdapter {
  readonly #client: GithubClient;
  readonly #blobs: VolumeBlobStore;
  readonly #now: () => string;

  constructor(input: {
    token: string;
    blob_store: VolumeBlobStore;
    fetch?: typeof fetch;
    now?: () => string;
  }) {
    this.#client = { token: input.token, ...(input.fetch ? { fetch: input.fetch } : {}) };
    this.#blobs = input.blob_store;
    this.#now = input.now ?? (() => new Date().toISOString());
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
          reconcile: ({ intent, continuation_state }) =>
            this.#reconcileProvider(intent, continuation_state),
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
    continuationState: Readonly<EffectContinuationState> | null | undefined,
  ): Promise<KernelEffectProviderObservation> {
    const payload = waitPayload(intent);
    const now = canonicalTimestamp(this.#now(), "GitHub provider-wait clock");
    const continuation = providerWaitContinuation(continuationState, payload);
    for (const name of activeFailureNames(continuation)) {
      const firstFailedAt = firstFailureForName(continuation, name)!;
      if (Date.parse(now) >= Date.parse(deadlineForFirstFailure(firstFailedAt))) {
        return rejectedCheckRunObservation(payload, continuation, name, true);
      }
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
    const hasFailedCommitStatus = payload.policy.required_observations.some((requirement, index) =>
      requirement.kind === "commit_status" && resolutions[index]?.state === "failure");
    if (hasFailedCommitStatus) {
      return {
        kind: "found",
        status: "rejected",
        payload: providerObservationPayload(
          payload,
          "required_observation_failed",
          terminalObservations(continuation, resolutions),
        ),
      };
    }

    const checksByKey = new Map(continuation.checks.map((check) => [
      checkKey(check.name, check.app_slug),
      check,
    ]));
    const observationIds = new Set(continuation.observations.map(({ id }) => id));
    for (const [index, requirement] of payload.policy.required_observations.entries()) {
      if (requirement.kind !== "check_run") continue;
      const resolution = resolutions[index]!;
      const key = checkKey(requirement.name, requirement.app_slug);
      let check = checksByKey.get(key);
      for (const observation of completedCheckRuns(resolution)) {
        if (observation.conclusion !== "success") {
          if (hasSuccessfulObservation(check)) continue;
          if (check?.failed_observation_ids.includes(observation.id)) continue;
          const firstFailedAt = firstFailureForName(continuation, requirement.name) ?? now;
          if (!check) {
            check = {
              name: requirement.name,
              app_slug: requirement.app_slug,
              first_failed_at: firstFailedAt,
              failed_observation_count: 0,
              failed_observation_ids: [],
              successful_observation_id: null,
            };
            continuation.checks.push(check);
            checksByKey.set(key, check);
          }
          check.first_failed_at ??= firstFailedAt;
          check.failed_observation_ids.push(observation.id);
          check.failed_observation_count = check.failed_observation_ids.length;
          rememberCheckRunObservation(continuation, observationIds, observation);
          const failedCount = failedCountForName(continuation, requirement.name);
          if (Date.parse(now) >= Date.parse(deadlineForFirstFailure(firstFailedAt))) {
            return rejectedCheckRunObservation(payload, continuation, requirement.name, true);
          }
          if (failedCount >= CHECK_FAILURE_LIMIT) {
            return rejectedCheckRunObservation(payload, continuation, requirement.name, false);
          }
          continue;
        }

        if (
          !check ||
          check.failed_observation_ids.some((failedId) => failedId >= observation.id)
        ) continue;
        rememberCheckRunObservation(continuation, observationIds, observation);
        check.successful_observation_id ??= observation.id;
      }
    }

    if (continuation.checks.length > 0) {
      for (const [index, requirement] of payload.policy.required_observations.entries()) {
        const resolution = resolutions[index]!;
        if (requirement.kind !== "check_run" || resolution.state !== "success") continue;
        const successfulObservations = completedCheckRuns(resolution).filter(
          ({ conclusion }) => conclusion === "success",
        );
        const observation = successfulObservations.at(-1);
        if (!observation) continue;
        const key = checkKey(requirement.name, requirement.app_slug);
        if (checksByKey.has(key)) continue;
        const check: CheckRunContinuation = {
          name: requirement.name,
          app_slug: requirement.app_slug,
          first_failed_at: null,
          failed_observation_count: 0,
          failed_observation_ids: [],
          successful_observation_id: observation.id,
        };
        continuation.checks.push(check);
        checksByKey.set(key, check);
        for (const successfulObservation of successfulObservations) {
          rememberCheckRunObservation(continuation, observationIds, successfulObservation);
        }
      }
    }

    const indeterminate = resolutions.find(({ state }) => state === "unknown");
    if (indeterminate?.state === "unknown") {
      return {
        kind: "unknown",
        detail: indeterminate.detail,
        ...(continuation.checks.length === 0 ? {} : {
          continuation_state: effectContinuation(continuation),
        }),
      };
    }

    const allSucceeded = payload.policy.required_observations.every((requirement, index) => {
      const resolution = resolutions[index]!;
      if (requirement.kind === "commit_status") return resolution.state === "success";
      const check = checksByKey.get(checkKey(requirement.name, requirement.app_slug));
      return hasSuccessfulObservation(check) || resolution.state === "success";
    });
    if (allSucceeded) {
      return {
        kind: "found",
        status: "confirmed",
        payload: providerObservationPayload(
          payload,
          "all_required_observations_succeeded",
          terminalObservations(continuation, resolutions),
        ),
      };
    }
    if (continuation.checks.length === 0) return { kind: "not_found" };
    const activeNames = activeFailureNames(continuation);
    return {
      kind: "unknown",
      detail: activeNames.length === 0
        ? "required observations remain unresolved after an eligible check_run re-run succeeded"
        : `required check_run ${activeNames[0]} failed; awaiting an eligible re-run within the ${CHECK_RERUN_WINDOW_MINUTES}-minute window`,
      continuation_state: effectContinuation(continuation),
    };
  }
}
