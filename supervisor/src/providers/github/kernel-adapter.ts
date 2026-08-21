import {
  validateBlobPointer,
  type BlobPointer,
  type EffectIntent,
  type JsonValue,
} from "@openthrottle/contracts";
import type { VolumeBlobStore } from "../../persistence/blob-store.js";
import type {
  KernelEffectAdapterBinding,
  KernelEffectProviderObservation,
} from "../../app/kernel-effect-ports.js";
import { pushRepositoryCheckpoint } from "./checkpoint-push.js";
import { publishRepositoryTaskBranch, type GithubClient } from "./client.js";

const SUBJECT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_REF = /^refs\/heads\/ot\/[A-Za-z0-9._/-]{1,180}$/;

interface PushPayload {
  schema: "openthrottle.github-push-checkpoint/v1";
  repository: string;
  ref: string;
  expected_old_subject: string;
  expected_new_subject: string;
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
}

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
    "schema", "repository", "ref", "expected_old_subject", "expected_new_subject",
    "checkpoint_blob", "checkpoint_tree",
  ], "GitHub checkpoint push payload");
  const blob = validateBlobPointer(value.checkpoint_blob, {
    source: "github_push.checkpoint_blob",
  }).value;
  if (
    value.schema !== "openthrottle.github-push-checkpoint/v1" ||
    typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
    typeof value.ref !== "string" || !TASK_REF.test(value.ref) ||
    typeof value.expected_old_subject !== "string" || !SUBJECT.test(value.expected_old_subject) ||
    typeof value.expected_new_subject !== "string" || !SUBJECT.test(value.expected_new_subject) ||
    value.expected_new_subject !== intent.subject ||
    value.expected_old_subject === value.expected_new_subject ||
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
  exactKeys(value, ["schema", "repository", "subject"], "GitHub provider wait payload");
  if (
    value.schema !== "openthrottle.github-provider-wait/v1" ||
    typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
    typeof value.subject !== "string" || !SUBJECT.test(value.subject) || value.subject !== intent.subject
  ) throw new Error(`effect ${intent.id} has invalid GitHub provider wait authority`);
  return value as unknown as ProviderWaitPayload;
}

async function githubJson<T>(client: GithubClient, path: string): Promise<{ status: number; value: T | null }> {
  const response = await (client.fetch ?? fetch)(`${client.apiBaseUrl ?? "https://api.github.com"}${path}`, {
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openthrottle",
    },
  });
  const raw = await response.text();
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub reconciliation failed (${response.status}): ${raw.slice(-1_000)}`);
  }
  return { status: response.status, value: raw ? JSON.parse(raw) as T : null };
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
          reconcile: ({ intent }) => this.#reconcileProvider(intent),
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
      return { kind: "found", status: "confirmed", payload: { ref: payload.ref, sha: current } };
    }
    if (current === null || current === payload.expected_old_subject) return { kind: "not_found" };
    return {
      kind: "found", status: "rejected",
      payload: { ref: payload.ref, expected: payload.expected_new_subject, actual: current, reason: "ref_conflict" },
    };
  }

  async #dispatchPush(intent: Readonly<EffectIntent>): Promise<void> {
    const payload = pushPayload(intent);
    const bytes = this.#blobs.read(payload.checkpoint_blob);
    await pushRepositoryCheckpoint(this.#client, {
      repository: payload.repository,
      ref: payload.ref,
      expectedOldSha: payload.expected_old_subject,
      expectedNewSha: payload.expected_new_subject,
      allowAlreadyAdvanced: true,
      allowCreate: true,
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
    const owner = payload.repository.split("/")[0]!;
    const query = new URLSearchParams({
      state: "open", head: `${owner}:${payload.branch}`, base: payload.base_branch, per_page: "10",
    });
    const response = await githubJson<Array<{
      html_url?: unknown; body?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown };
    }>>(this.#client, `/repos/${payload.repository}/pulls?${query.toString()}`);
    const matches = (response.value ?? []).filter((candidate) =>
      candidate.head?.sha === payload.expected_head_subject && candidate.base?.ref === payload.base_branch &&
      typeof candidate.body === "string" && candidate.body.includes(payload.ownership_marker));
    if (matches.length > 1) return { kind: "unknown", detail: "multiple owned pull requests match one publication" };
    const match = matches[0];
    if (!match) return { kind: "not_found" };
    return { kind: "found", status: "confirmed", payload: { url: match.html_url as JsonValue } };
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

  async #reconcileProvider(intent: Readonly<EffectIntent>): Promise<KernelEffectProviderObservation> {
    const payload = waitPayload(intent);
    const [checks, status] = await Promise.all([
      githubJson<{ check_runs?: Array<{ status?: string; conclusion?: string | null; html_url?: string }> }>(
        this.#client, `/repos/${payload.repository}/commits/${payload.subject}/check-runs?per_page=100`,
      ),
      githubJson<{ state?: string; statuses?: Array<{ state?: string; target_url?: string }> }>(
        this.#client, `/repos/${payload.repository}/commits/${payload.subject}/status`,
      ),
    ]);
    if (checks.status === 404 || status.status === 404) return { kind: "not_found" };
    const runs = checks.value?.check_runs ?? [];
    const statuses = status.value?.statuses ?? [];
    if (runs.some((run) => run.status !== "completed")) return { kind: "not_found" };
    const failedRun = runs.find((run) => !["success", "neutral", "skipped"].includes(run.conclusion ?? ""));
    const failedStatus = statuses.find((entry) => ["error", "failure"].includes(entry.state ?? ""));
    if (failedRun || failedStatus) {
      return { kind: "found", status: "rejected", payload: { reason: "provider_checks_failed" } };
    }
    if (status.value?.state === "pending") return { kind: "not_found" };
    return {
      kind: "found", status: "confirmed",
      payload: { subject: payload.subject, check_run_count: runs.length, status_count: statuses.length },
    };
  }
}
