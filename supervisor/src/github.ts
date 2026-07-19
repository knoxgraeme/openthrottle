import { createHmac, timingSafeEqual } from "node:crypto";

const HTTP_TIMEOUT_MS = 15_000;
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export function isGithubPullRequestUrl(value: unknown): value is string {
  return typeof value === "string" && GITHUB_PULL_REQUEST_URL_PATTERN.test(value);
}

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader || !/^sha256=[a-f\d]{64}$/i.test(signatureHeader)) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`,
    "utf8"
  );
  const actual = Buffer.from(signatureHeader, "utf8");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export interface GithubPullRequest {
  number: number;
  html_url: string;
  merged: boolean;
  head: { ref: string; sha?: string };
  base: { ref: string };
  labels?: Array<{ name: string }>;
}

interface GithubEventBase {
  repository: { full_name: string };
}

export interface GithubPullRequestEvent extends GithubEventBase {
  kind: "pull_request";
  action: string;
  pull_request: GithubPullRequest;
  label?: { name: string };
}

export interface GithubReviewEvent extends GithubEventBase {
  kind: "pull_request_review";
  action: string;
  pull_request: GithubPullRequest;
  review: {
    id: number;
    state: string;
    body?: string;
    html_url: string;
    user?: { login: string };
  };
}

export interface GithubWorkflowRunEvent extends GithubEventBase {
  kind: "workflow_run";
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    html_url: string;
  };
}

export interface GithubCheckSuiteEvent extends GithubEventBase {
  kind: "check_suite";
  action: string;
  check_suite: {
    id: number;
    status: string;
    conclusion: string | null;
    head_branch: string | null;
    url: string;
  };
}

export interface GithubIssueCommentEvent extends GithubEventBase {
  kind: "issue_comment";
  action: string;
  issue: {
    number: number;
    pull_request?: { url?: string };
  };
  comment: {
    id: number;
    body?: string;
    html_url: string;
    user?: { login: string };
  };
}

export type GithubWebhookEvent =
  | GithubPullRequestEvent
  | GithubReviewEvent
  | GithubIssueCommentEvent
  | GithubWorkflowRunEvent
  | GithubCheckSuiteEvent;

function parseObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub webhook body must be an object");
  }
  return value as Record<string, unknown>;
}

function recordField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const child = value[field];
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return child as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result === "") {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return result;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`GitHub webhook is missing ${field}`);
  }
  return result;
}

function validatePullRequest(payload: Record<string, unknown>): void {
  const pullRequest = recordField(payload, "pull_request");
  numberField(pullRequest, "number");
  stringField(pullRequest, "html_url");
  if (typeof pullRequest.merged !== "boolean") {
    throw new Error("GitHub webhook is missing pull_request.merged");
  }
  stringField(recordField(pullRequest, "head"), "ref");
  stringField(recordField(pullRequest, "base"), "ref");
}

export function parseGithubWebhook(eventName: string | undefined, raw: string): GithubWebhookEvent {
  const payload = parseObject(raw);
  if (!eventName) throw new Error("Missing X-GitHub-Event header");
  if (
    !["pull_request", "pull_request_review", "issue_comment", "workflow_run", "check_suite"].includes(
      eventName
    )
  ) {
    throw new Error(`Unsupported GitHub event: ${eventName}`);
  }
  if (typeof payload.action !== "string") throw new Error("GitHub webhook is missing action");
  stringField(recordField(payload, "repository"), "full_name");
  if (eventName === "pull_request" || eventName === "pull_request_review") {
    validatePullRequest(payload);
  }
  if (eventName === "pull_request_review") {
    const review = recordField(payload, "review");
    numberField(review, "id");
    stringField(review, "state");
    stringField(review, "html_url");
  } else if (eventName === "issue_comment") {
    numberField(recordField(payload, "issue"), "number");
    const comment = recordField(payload, "comment");
    numberField(comment, "id");
    stringField(comment, "html_url");
  } else if (eventName === "workflow_run") {
    const run = recordField(payload, "workflow_run");
    numberField(run, "id");
    stringField(run, "name");
    stringField(run, "status");
    stringField(run, "head_branch");
    stringField(run, "html_url");
  } else if (eventName === "check_suite") {
    const suite = recordField(payload, "check_suite");
    numberField(suite, "id");
    stringField(suite, "status");
    stringField(suite, "url");
    if (suite.head_branch !== null && typeof suite.head_branch !== "string") {
      throw new Error("GitHub webhook has invalid check_suite.head_branch");
    }
  }
  return { ...payload, kind: eventName } as unknown as GithubWebhookEvent;
}

export function parseGithubPullRequestEvent(raw: string): GithubPullRequestEvent {
  return parseGithubWebhook("pull_request", raw) as GithubPullRequestEvent;
}

export function isOpenthrottleBranch(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ref.startsWith("ot/");
}

export function parsePullRequestUrl(url: string): {
  host: string;
  repo: string;
  number: number;
} {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error(`Invalid GitHub pull request URL: ${url}`);
  return {
    host: parsed.host,
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  };
}

export interface GithubClient {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

async function githubRequest<T>(
  client: GithubClient,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(`${client.apiBaseUrl ?? "https://api.github.com"}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface RepositoryReadiness {
  repo: string;
  baseBranch: string;
  webhookId: number;
  webhookAction: "created" | "updated";
}

const OPENTHROTTLE_WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "workflow_run",
  "check_suite",
];

export async function getAuthenticatedLogin(client: GithubClient): Promise<string> {
  const user = await githubRequest<{ login: string }>(client, "/user");
  return user.login;
}

export async function prepareRepository(
  client: GithubClient,
  input: {
    repo: string;
    requestedBaseBranch?: string;
    webhookUrl: string;
    webhookSecret: string;
  }
): Promise<RepositoryReadiness> {
  const repository = await githubRequest<{
    full_name: string;
    default_branch: string;
  }>(client, `/repos/${input.repo}`);
  const baseBranch = input.requestedBaseBranch || repository.default_branch;
  await githubRequest(client, `/repos/${repository.full_name}/branches/${encodeURIComponent(baseBranch)}`);

  const hooks = await githubRequest<Array<{
    id: number;
    active: boolean;
    events: string[];
    config?: { url?: string };
  }>>(client, `/repos/${repository.full_name}/hooks?per_page=100`);
  const existing = hooks.find((hook) => hook.config?.url === input.webhookUrl);
  const hookConfiguration = {
    active: true,
    events: OPENTHROTTLE_WEBHOOK_EVENTS,
    config: {
      url: input.webhookUrl,
      content_type: "json",
      secret: input.webhookSecret,
      insecure_ssl: "0",
    },
  };
  const hook = existing
    ? await githubRequest<{ id: number }>(
        client,
        `/repos/${repository.full_name}/hooks/${existing.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(hookConfiguration),
        }
      )
    : await githubRequest<{ id: number }>(client, `/repos/${repository.full_name}/hooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "web", ...hookConfiguration }),
      });

  return {
    repo: repository.full_name,
    baseBranch,
    webhookId: hook.id,
    webhookAction: existing ? "updated" : "created",
  };
}

export async function branchExists(
  client: GithubClient,
  repo: string,
  branch: string
): Promise<boolean> {
  const fetchImpl = client.fetch ?? fetch;
  const response = await fetchImpl(
    `${client.apiBaseUrl ?? "https://api.github.com"}/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);
  }
  return true;
}

export async function countChangesRequestedReviews(
  client: GithubClient,
  repo: string,
  pullNumber: number
): Promise<number> {
  const reviews = await githubRequest<Array<{ state: string }>>(
    client,
    `/repos/${repo}/pulls/${pullNumber}/reviews?per_page=100`
  );
  return reviews.filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED").length;
}

export function commentOnPullRequest(
  client: GithubClient,
  repo: string,
  pullNumber: number,
  body: string
): Promise<{ html_url: string }> {
  return githubRequest(client, `/repos/${repo}/issues/${pullNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export interface MergeReadiness {
  mergeable: boolean;
  draft: boolean;
  checksPresent: boolean;
  checksGreen: boolean;
  headSha: string;
}

export async function getMergeReadiness(
  client: GithubClient,
  repo: string,
  pullNumber: number
): Promise<MergeReadiness> {
  const pull = await githubRequest<{
    mergeable: boolean | null;
    draft: boolean;
    head: { sha: string };
  }>(client, `/repos/${repo}/pulls/${pullNumber}`);
  const checks = await githubRequest<{
    check_runs: Array<{ status: string; conclusion: string | null }>;
  }>(client, `/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`);
  const passingConclusions = new Set(["success", "neutral", "skipped"]);
  return {
    mergeable: pull.mergeable === true,
    draft: pull.draft,
    checksPresent: checks.check_runs.length > 0,
    checksGreen:
      checks.check_runs.length > 0 &&
      checks.check_runs.every(
        (check) => check.status === "completed" && passingConclusions.has(check.conclusion ?? "")
      ),
    headSha: pull.head.sha,
  };
}

export function mergePullRequest(
  client: GithubClient,
  repo: string,
  pullNumber: number,
  expectedHeadSha: string
): Promise<{ merged: boolean; message: string }> {
  return githubRequest(client, `/repos/${repo}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
  });
}
